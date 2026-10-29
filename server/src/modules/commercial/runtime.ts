import { createHash } from "node:crypto";
import { AppError } from "../../shared/domain.js";
import type { CommercialBilling } from "../../shared/commercial-billing.js";
import type { SqliteStore } from "../../shared/store.js";
import { now as businessNow, type Clock } from "../../shared/time.js";
import { CommercialCatalog } from "./catalog.js";
import { anomalyRecorded, markAnomalyAcknowledged, markAnomalyRecorded, recordPaymentAnomaly } from "./anomalies.js";
import type { GoodsDeliveryEvent, PaymentCallbackNotice, PaymentEventFormat } from "./payment-events.js";
import { CommercialOrders, type VerifiedPayment } from "./orders.js";
import { PaymentReconciliation, type ReconciliationTarget } from "./reconciliation.js";
import { CommercialRefunds, upgradeListPrice } from "./refunds.js";
import { feesMatch, PaymentAmountMismatchError, WechatVirtualPaymentApi, WechatVirtualPaymentApiError } from "./wechat-api.js";

export type CommercialPaymentConfig = Readonly<{
  offerId: string;
  appKey: string;
  callbackToken: string;
  callbackFormat: PaymentEventFormat;
  callbackMode: "plaintext" | "secure";
  appId?: string;
  encodingAesKey?: string;
  getAccessToken: () => string | Promise<string>;
  fetcher?: typeof fetch;
  apiRoot?: string;
}>;

type TargetRow = {
  id: string;
  user_id: string;
  good_id: string;
  amount_cents: number;
  buyer_openid: string;
  snapshot: string;
};
/** Owns the commercial payment adapters. Construction has no network or timer side effects. */
export function createCommercialRuntime(input: {
  store: SqliteStore;
  billing: Pick<CommercialBilling, "accounts" | "pricing">;
  config: CommercialPaymentConfig;
  clock?: Clock;
  reconciliationIntervalMs?: number;
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
}) {
  const clock = input.clock ?? businessNow;
  const catalog = new CommercialCatalog(input.store);
  const orders = new CommercialOrders(input.store, catalog, clock);
  const getAppKey = () => input.config.appKey;
  const api = new WechatVirtualPaymentApi({
    getAccessToken: input.config.getAccessToken,
    getAppKey,
    fetcher: input.config.fetcher,
    apiRoot: input.config.apiRoot,
  });
  const auditOnce = (
    id: string,
    action: string,
    resourceId: string,
    details: Record<string, unknown>,
  ) => input.store.db.prepare(
    "INSERT OR IGNORE INTO audit(id,actor,action,resource_id,details,created_at) VALUES(?,'system:payment',?,?,?,?)",
  ).run(id, action, resourceId, JSON.stringify(details), clock().toISOString()).changes === 1;
  const auditAnomaly = (baseId: string, resourceId: string, details: Record<string, unknown>) =>
    recordPaymentAnomaly(input.store, clock, baseId, resourceId, details);
  const safeFailureCode = (error: unknown) => {
    if (error instanceof WechatVirtualPaymentApiError) return `WECHAT_API_${error.code}`;
    if (error instanceof AppError || error instanceof PaymentAmountMismatchError) return error.code;
    return error instanceof TypeError ? "WECHAT_RESPONSE_INVALID" : "WECHAT_QUERY_FAILED";
  };
  const recordQueryFailure = (
    source: string,
    target: ReconciliationTarget,
    error: unknown,
    phase: "query_order" | "deliver",
  ) => {
    const code = safeFailureCode(error);
    if (error instanceof PaymentAmountMismatchError)
      input.logger?.warn({ event: "payment_amount_mismatch", source, phase, code }, "Payment amount mismatch rejected");
    // The digest keeps its pre-phase shape so open anomalies stay deduplicated.
    const digest = createHash("sha256").update(`${source}\0${target.orderId}\0${code}`).digest("hex");
    auditAnomaly(`commercial-query:${digest}`, target.orderId, {
      source,
      phase,
      code,
    });
    markAnomalyRecorded(error);
  };
  const reconciliationOptions = (source: string, minIntervalMs: number | undefined) => ({
    clock,
    minIntervalMs,
    onDelivered: async (_target: ReconciliationTarget, result: { receipt: VerifiedPayment }) => {
      await api.notifyProvidedGoods({
        orderId: result.receipt.orderId,
        wxOrderId: result.receipt.wxOrderId,
        env: result.receipt.env,
      });
    },
    onFailure: (target: ReconciliationTarget, error: unknown, phase: "query_order" | "deliver" | "notify_provide_goods") => {
      if (phase === "notify_provide_goods") {
        const code = safeFailureCode(error);
        const digest = createHash("sha256")
          .update(`${source}\0${target.orderId}\0${phase}\0${code}`)
          .digest("hex");
        auditAnomaly(`commercial-delivery-notify:${digest}`, target.orderId, {
          source,
          phase,
          code,
        });
        return;
      }
      recordQueryFailure(source, target, error, phase);
    },
  });
  const reconciliation = new PaymentReconciliation(orders, api, reconciliationOptions(
    "background",
    input.reconciliationIntervalMs,
  ));
  // Manual administrator checks must not inherit the learner-facing five
  // minute throttle. This instance still coalesces concurrent checks for the
  // same order and delivery remains atomic/idempotent in CommercialOrders.
  const manualReconciliation = new PaymentReconciliation(orders, api, reconciliationOptions("manual", 0));
  const callbackRefunds = new CommercialRefunds(input.store, api, api, clock);
  const callbackInflight = new Map<string, Promise<VerifiedPayment>>();

  const target = (orderId: string, ownerId?: string): ReconciliationTarget => {
    const row = input.store.db.prepare(
      `SELECT id,user_id,good_id,amount_cents,buyer_openid,snapshot FROM commercial_orders
       WHERE id=?${ownerId === undefined ? "" : " AND user_id=?"}`,
    ).get(...(ownerId === undefined ? [orderId] : [orderId, ownerId])) as TargetRow | undefined;
    if (!row) throw new AppError(404, "ORDER_NOT_FOUND", "订单不存在");
    if (!row.buyer_openid)
      throw new AppError(409, "PAYMENT_USER_MISMATCH", "支付用户与订单不一致");
    const listPriceCents = upgradeListPrice(row);
    return {
      openid: row.buyer_openid,
      orderId: row.id,
      env: 0,
      productId: row.good_id,
      amountCents: row.amount_cents,
      ...(listPriceCents === undefined ? {} : { listPriceCents }),
    };
  };

  /** A push whose paid amount is not the order's: nothing is delivered, one
   * anomaly is recorded and WeChat gets its success reply (a re-push cannot fix it). */
  const callbackAmountMismatch = (queryTarget: ReconciliationTarget, error: unknown, phase: "query_order" | "deliver") => {
    recordQueryFailure("callback", queryTarget, error, phase);
    markAnomalyAcknowledged(error);
    return error;
  };

  const verifyCallbackPayment = (event: GoodsDeliveryEvent) => {
    // Matching old notifications acknowledge an already verified receipt;
    // they never reactivate a refunded purchase or reissue its entitlements.
    const saved = input.store.db.prepare(
      `SELECT user_id,good_id,amount_cents,env,status,wx_order_id,platform,paid_at,buyer_openid,snapshot
       FROM commercial_orders WHERE id=?`,
    ).get(event.orderId) as { user_id: string; good_id: string; amount_cents: number; env: number; status: string; wx_order_id: string | null; platform: "android" | "ios" | null; paid_at: number | null; buyer_openid: string; snapshot: string } | undefined;
    if (saved && ["delivered", "refunding", "refunded"].includes(saved.status) && saved.wx_order_id && saved.platform && saved.paid_at !== null) {
      if (event.wxOrderId !== saved.wx_order_id || event.openid !== saved.buyer_openid ||
          event.productId !== saved.good_id ||
          event.env !== saved.env || event.paidAtMs !== saved.paid_at)
        return Promise.reject(new AppError(409, "PAYMENT_MISMATCH", "支付通知与历史订单不一致"));
      // ActualPrice is what was paid, which for an upgrade is the discounted price.
      if (!feesMatch({ amountCents: saved.amount_cents }, event.amountCents))
        return Promise.reject(callbackAmountMismatch(target(event.orderId),
          new PaymentAmountMismatchError("支付通知金额与订单不一致"), "deliver"));
      return Promise.resolve({ ...event, platform: saved.platform });
    }
    const active = callbackInflight.get(event.orderId);
    if (active) return active;
    const promise = (async () => {
      // A first push only triggers query_order; its own fields are not
      // trusted, so the query's fees decide (same rule as the replay above).
      const queryTarget = target(event.orderId);
      let result;
      try { result = await api.queryVerifiedPayment(queryTarget); }
      catch (error) {
        if (error instanceof PaymentAmountMismatchError) throw callbackAmountMismatch(queryTarget, error, "query_order");
        recordQueryFailure("callback", queryTarget, error, "query_order");
        throw error;
      }
      if (result.state !== "paid")
        throw new AppError(409, "PAYMENT_PENDING", "订单尚未确认支付");
      return result.receipt;
    })().finally(() => {
      if (callbackInflight.get(event.orderId) === promise) callbackInflight.delete(event.orderId);
    });
    callbackInflight.set(event.orderId, promise);
    return promise;
  };

  const recordCallbackAnomaly = (notice: PaymentCallbackNotice, code: string) =>
    auditAnomaly(
      `commercial-callback-anomaly:${notice.eventKey}:${code}`,
      notice.orderId ?? notice.refundId ?? "wechat-callback",
      {
        source: "callback",
        phase: notice.outcome === "delivery_error" ? "deliver" : "refund_callback",
        eventType: notice.eventType,
        code,
        eventKey: notice.eventKey,
      },
    );

  const handleCallbackEvent = async (notice: PaymentCallbackNotice) => {
    if (notice.outcome === "delivery_error") {
      recordCallbackAnomaly(notice, notice.failureCode ?? "DELIVERY_CALLBACK_FAILED");
      return;
    }
    const first = auditOnce(
      `commercial-callback:${notice.eventKey}`,
      "commercial.payment.callback.received",
      notice.orderId ?? notice.refundId ?? "wechat-callback",
      { eventType: notice.eventType, eventKey: notice.eventKey },
    );
    if (!first) return;
    if (notice.eventType !== "xpay_refund_notify") {
      auditOnce(
        `commercial-callback-ignored:${notice.eventKey}`,
        "commercial.payment.callback.ignored",
        notice.orderId ?? "wechat-callback",
        { eventType: notice.eventType, eventKey: notice.eventKey },
      );
      return;
    }
    if (!notice.orderId || !notice.refundId) {
      recordCallbackAnomaly(notice, "REFUND_CALLBACK_INVALID");
      return;
    }
    const refund = input.store.db.prepare(
      "SELECT id,amount_cents,status,attempt FROM commercial_refunds WHERE order_id=?",
    ).get(notice.orderId) as { id: string; amount_cents: number; status: string; attempt: number } | undefined;
    // This includes iOS/platform-originated refunds. Their handling remains
    // unknown, so record them without inventing an automatic clawback policy.
    if (!refund) {
      recordCallbackAnomaly(notice, "REFUND_CALLBACK_UNMATCHED");
      return;
    }
    if (refund.id !== notice.refundId) {
      recordCallbackAnomaly(notice, "REFUND_CALLBACK_ID_MISMATCH");
      return;
    }
    if (refund.status === "failed" && notice.resultCode === 0) {
      recordCallbackAnomaly(notice, "REFUND_CALLBACK_AFTER_LOCAL_FAILURE");
      return;
    }
    const order = input.store.db.prepare(
      "SELECT wx_order_id,amount_cents FROM commercial_orders WHERE id=?",
    ).get(notice.orderId) as { wx_order_id: string | null; amount_cents: number } | undefined;
    if (!order || (notice.wxOrderId !== undefined && order.wx_order_id !== notice.wxOrderId) ||
        (notice.amountCents !== undefined && order.amount_cents !== notice.amountCents))
      recordCallbackAnomaly(notice, "REFUND_CALLBACK_DETAILS_MISMATCH");
    try {
      const synced = await callbackRefunds.sync(refund.id, "callback");
      auditOnce(
        `commercial-refund-callback-synced:${notice.eventKey}`,
        "commercial.refund.callback_synced",
        notice.orderId,
        { refundId: refund.id, status: synced.status, resultCode: notice.resultCode ?? null },
      );
    } catch (error) {
      // A failed refund query already recorded its own anomaly (source callback).
      if (!anomalyRecorded(error)) recordCallbackAnomaly(notice, safeFailureCode(error));
    }
  };

  let pendingAfter: { created_at: number; id: string } | undefined;
  const pollPending = (limit = 100) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("待查订单数量无效");
    const read = () => input.store.db.prepare(
      `SELECT id,created_at FROM commercial_orders WHERE status='created'
       ${pendingAfter ? "AND (created_at>? OR (created_at=? AND id>?))" : ""}
       ORDER BY created_at,id LIMIT ?`,
    ).all(...(pendingAfter ? [pendingAfter.created_at, pendingAfter.created_at, pendingAfter.id, limit] : [limit])) as Array<{ id: string; created_at: number }>;
    let rows = read();
    if (!rows.length && pendingAfter) { pendingAfter = undefined; rows = read(); }
    // Rotate across all pending purchases, including when the oldest orders
    // were abandoned. An old unpaid page must not starve newer paid orders.
    if (rows.length) pendingAfter = rows.at(-1)!;
    return reconciliation.pollPending(rows.map(row => target(row.id)));
  };

  return Object.freeze({
    catalog,
    orders,
    api,
    reconciliation,
    syncOrder: (orderId: string) =>
      manualReconciliation.reconcile(target(orderId)),
    target,
    verifyCallbackPayment,
    handleCallbackEvent,
    pollPending,
  });
}

export type CommercialRuntime = ReturnType<typeof createCommercialRuntime>;
