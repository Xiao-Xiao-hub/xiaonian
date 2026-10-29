/*
 * Commercial operations API. Every route uses the existing administrator
 * authentication; browser mutations therefore inherit the admin session's
 * same-origin check. Values are local append-only records, not provider
 * settlement statements.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import { AppError } from "../../shared/domain.js";
import type { SqliteStore } from "../../shared/store.js";
import {
  COMMERCIAL_CATALOG_SETTING,
  validateCommercialCatalog,
} from "./catalog.js";
import type { CommercialRefunds } from "./refunds.js";
import { refundManualReview } from "./refunds.js";
import type { ReconciliationResult } from "./reconciliation.js";
import { isTencentOcrPriceMissing, OCR_PRICE_MISSING } from "./readiness.js";
import { CostSafety } from "../../shared/cost-safety.js";

type Row = Record<string, unknown>;
const ACTOR = "admin:shared";
const statuses = [
  "created",
  "paid",
  "delivered",
  "refunding",
  "refunded",
  "closed",
] as const;
const refundStatuses = ["pending", "refunded", "failed"] as const;
const limitQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();

const integer = (value: unknown, name: string) => {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  if (!Number.isSafeInteger(parsed))
    throw new AppError(
      500,
      "COMMERCIAL_SUMMARY_OVERFLOW",
      `${name}超出安全整数范围`,
    );
  return parsed;
};
const optionalInteger = (value: unknown, name: string) =>
  value === null || value === undefined ? null : integer(value, name);
const text = (value: unknown) =>
  value === null || value === undefined ? null : String(value);
const json = (value: unknown) =>
  typeof value === "string" ? (JSON.parse(value) as unknown) : null;
const publishedGoodNames: Record<string, string> = {
  plan_entry_30d: "晓念Plus",
  plan_standard_30d: "晓念Pro",
  plan_advanced_30d: "晓念Max",
  points_10: "晓念积分包10元",
  points_30: "晓念积分包30元",
  points_50: "晓念积分包50元",
};
const goodName = (row: Row) => {
  try {
    const snapshot = json(row.snapshot) as { good?: { name?: unknown } } | null;
    if (typeof snapshot?.good?.name === "string" && snapshot.good.name.trim())
      return snapshot.good.name;
  } catch {
    // Older or malformed snapshots remain operable through the published-ID fallback.
  }
  return publishedGoodNames[String(row.good_id)] ?? String(row.good_id);
};

export type CommercialAdminConfiguration = Readonly<{
  paymentConfigured?: boolean;
  callbackConfigured?: boolean;
  accessTokenConfigured?: boolean;
  tencentOcrConfigured?: boolean;
}>;

export function registerCommercialAdminRoutes(
  app: FastifyInstance,
  deps: {
    auth: Pick<AuthService, "admin">;
    store: SqliteStore;
    refunds?: Pick<CommercialRefunds, "request"> & Partial<Pick<CommercialRefunds, "resolveUnknownAsFailed" | "blockReason">>;
    syncOrder?: (orderId: string) => Promise<ReconciliationResult>;
    configuration?: CommercialAdminConfiguration;
  },
) {
  const { auth, store, refunds } = deps;
  const db = store.db;
  const one = (sql: string, ...args: (string | number)[]) =>
    db.prepare(sql).get(...args) as Row;
  const all = (sql: string, ...args: (string | number)[]) =>
    db.prepare(sql).all(...args) as Row[];

  const configuration = () => {
    let catalogApproved = false;
    try {
      const saved = store.setting<unknown>(COMMERCIAL_CATALOG_SETTING);
      catalogApproved =
        saved !== undefined && validateCommercialCatalog(saved).approved;
    } catch {
      // Invalid configuration fails closed and is reported as missing below.
    }
    const state = {
      billingEnabled: store.setting("commercial.enabled") === true,
      catalogApproved,
      paymentConfigured: deps.configuration?.paymentConfigured === true,
      callbackConfigured: deps.configuration?.callbackConfigured === true,
      accessTokenConfigured: deps.configuration?.accessTokenConfigured === true,
    };
    const missing = [
      ...(!state.billingEnabled ? ["billingSwitch"] : []),
      ...(!state.catalogApproved ? ["catalog"] : []),
      ...(!state.paymentConfigured ? ["payment"] : []),
      ...(!state.callbackConfigured ? ["callback"] : []),
      ...(!state.accessTokenConfigured ? ["accessToken"] : []),
      ...(isTencentOcrPriceMissing(store, deps.configuration?.tencentOcrConfigured === true) ? [OCR_PRICE_MISSING] : []),
    ];
    return { ...state, enabled: missing.length === 0, missing };
  };

  const planAction = (row: Row) => {
    try {
      const action = (JSON.parse(String(row.snapshot ?? "{}")) as { planAction?: unknown }).planAction;
      return action === "buy" || action === "renew" || action === "upgrade" ? action : null;
    } catch {
      return null;
    }
  };
  const order = (row: Row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    accountErased: row.account_erased_at !== null && row.account_erased_at !== undefined,
    goodId: String(row.good_id),
    goodName: goodName(row),
    amountCents: integer(row.amount_cents, "订单金额"),
    catalogVersion: String(row.catalog_version),
    env: integer(row.env, "订单环境"),
    status: String(row.status),
    wxOrderId: text(row.wx_order_id),
    platform: text(row.platform),
    paidAtMs: optionalInteger(row.paid_at, "支付时间"),
    createdAtMs: integer(row.created_at, "下单时间"),
    refundId: text(row.refund_id),
    refundStatus: text(row.refund_status),
    planAction: planAction(row),
    supersededBy: text(row.superseded_by),
    // Only for orders the list offers a refund button on.
    refundBlockReason: ["paid", "delivered"].includes(String(row.status)) && !row.refund_id
      ? refunds?.blockReason?.(String(row.id)) ?? null : null,
  });
  const refund = (row: Row) => ({
    id: String(row.id),
    orderId: String(row.order_id),
    actor: String(row.actor),
    reason: String(row.reason),
    reasonCode: integer(row.reason_code, "退款原因类型"),
    amountCents: integer(row.amount_cents, "退款金额"),
    status: String(row.status),
    submissionStatus: String(row.submission_status),
    failureCode: text(row.failure_code),
    requestedAtMs: integer(row.requested_at, "退款申请时间"),
    updatedAtMs: integer(row.updated_at, "退款更新时间"),
    completedAtMs: optionalInteger(row.completed_at, "退款完成时间"),
    attempt: integer(row.attempt, "退款尝试次数"),
    ...refundManualReview({
      status: String(row.status), submission_status: String(row.submission_status),
      attempt: integer(row.attempt, "退款尝试次数"), updated_at: integer(row.updated_at, "退款更新时间"),
      status7_first_seen_at: optionalInteger(row.status7_first_seen_at, "退款状态7首次确认时间"),
    }),
  });

  app.get("/v1/admin/commercial/overview", async (req) => {
    auth.admin(req);
    const ordersByStatus = Object.fromEntries(
      all(
        "SELECT status,COUNT(*) n FROM commercial_orders GROUP BY status ORDER BY status",
      ).map((row) => [String(row.status), integer(row.n, "订单数")]),
    );
    const ordersByPlatform = Object.fromEntries(
      all(
        "SELECT COALESCE(platform,'unconfirmed') platform,COUNT(*) n FROM commercial_orders GROUP BY platform ORDER BY platform",
      ).map((row) => [String(row.platform), integer(row.n, "平台订单数")]),
    );
    const refundByStatus = Object.fromEntries(
      all(
        "SELECT status,COUNT(*) n FROM commercial_refunds GROUP BY status ORDER BY status",
      ).map((row) => [String(row.status), integer(row.n, "退款数")]),
    );
    const entryByKind = Object.fromEntries(
      all(
        "SELECT kind,COUNT(*) n,COALESCE(SUM(delta),0) delta FROM commercial_entries GROUP BY kind ORDER BY kind",
      ).map((row) => [
        String(row.kind),
        {
          entries: integer(row.n, "流水数"),
          deltaCredits: integer(row.delta, "积分流水"),
        },
      ]),
    );
    const receipts = one(
      `SELECT COALESCE(SUM(amount_cents),0) cents
       FROM commercial_orders
       WHERE status IN ('paid','delivered','refunding','refunded')`,
    );
    const returned = one(
      "SELECT COALESCE(SUM(amount_cents),0) cents FROM commercial_refunds WHERE status='refunded'",
    );
    const grossCents = integer(receipts.cents, "本库已收金额");
    const refundedCents = integer(returned.cents, "本库已退金额");
    const usage = one(
      `SELECT COUNT(*) records,
              COALESCE(SUM(cost_microyuan),0) cost,
              SUM(status='pending') pending,
              SUM(status<>'pending' AND cost_microyuan IS NULL) unknown
       FROM commercial_usage`,
    );
    const balances = one(
      `SELECT COUNT(DISTINCT b.id) buckets,
              COUNT(e.id) entries,
              COALESCE(SUM(CASE WHEN u.erased_at IS NULL AND b.starts_at<=? AND (b.ends_at IS NULL OR b.ends_at>?) THEN e.delta ELSE 0 END),0) active
       FROM commercial_buckets b
       JOIN users u ON u.id=b.user_id
       LEFT JOIN commercial_entries e ON e.bucket_id=b.id`,
      Date.parse(store.now()),
      Date.parse(store.now()),
    );
    const paymentAlerts = one(
      `SELECT COUNT(*) n,MAX(a.created_at) latest,
         COALESCE(SUM(NOT EXISTS(SELECT 1 FROM audit r
           WHERE r.action='commercial.payment.anomaly.resolved' AND r.resource_id=a.id)),0) unresolved
       FROM audit a WHERE a.action='commercial.payment.anomaly'`,
    );
    return {
      data: {
        basis: {
          kind: "local_records",
          productionSettlementVerified: false,
          note: "仅汇总本库记录，不代表微信结算到账或真实生产收入",
        },
        configuration: configuration(),
        costSafety: new CostSafety(store, () => new Date(store.now()), {}).status(),
        orders: {
          total: Object.values(ordersByStatus).reduce(
            (sum, value) => integer(sum + integer(value, "订单数"), "订单总数"),
            0,
          ),
          byStatus: ordersByStatus,
          byPlatform: ordersByPlatform,
          recordedPaidCents: grossCents,
          confirmedRefundCents: refundedCents,
          recordedNetCents: integer(grossCents - refundedCents, "本库净收金额"),
        },
        ledger: {
          buckets: integer(balances.buckets, "额度桶数"),
          entries: integer(balances.entries, "流水数"),
          activeConstraintCredits: integer(balances.active, "约束桶流水合计"),
          heldCalls: integer(
            one("SELECT COUNT(*) n FROM commercial_calls WHERE status='held'")
              .n,
            "预留调用数",
          ),
          byKind: entryByKind,
        },
        usage: {
          records: integer(usage.records, "计量记录数"),
          recordedCostMicroyuan: integer(usage.cost, "本库成本"),
          pendingRecords: integer(usage.pending, "待完成计量数"),
          unknownFinishedCostRecords: integer(usage.unknown, "未知成本计量数"),
        },
        refunds: {
          byStatus: refundByStatus,
          pendingCompensation: integer(
            refundByStatus.pending ?? 0,
            "待补偿退款数",
          ),
        },
        alerts: {
          paymentAnomalies: integer(paymentAlerts.n, "支付异常数"),
          unresolvedPaymentAnomalies: integer(paymentAlerts.unresolved, "未处理支付异常数"),
          latestPaymentAnomalyAt: text(paymentAlerts.latest),
        },
      },
    };
  });

  // PLAN_UPGRADE_PARTIAL lists the source orders of the segments it did and
  // did not convert, for the operator's manual refund.
  const segmentOrders = (items: unknown[]) => items
    .map(item => (item && typeof item === "object" ? (item as { orderId?: unknown }).orderId : undefined))
    .filter((id): id is string => typeof id === "string");
  app.get("/v1/admin/commercial/anomalies", async (req) => {
    auth.admin(req);
    const { limit } = limitQuery.parse(req.query ?? {});
    return { data: all(
      `SELECT a.*,r.created_at resolved_at,r.details resolution
       FROM audit a LEFT JOIN audit r
       ON r.action='commercial.payment.anomaly.resolved' AND r.resource_id=a.id
       WHERE a.action='commercial.payment.anomaly'
       ORDER BY (r.id IS NULL) DESC,a.created_at DESC,a.id LIMIT ?`, limit,
    ).map(row => {
      const details = json(row.details) as Record<string, unknown>;
      const resolution = json(row.resolution) as { reason?: string } | null;
      return { id: String(row.id), orderId: String(row.resource_id),
        code: text(details.code), source: text(details.source), phase: text(details.phase), createdAt: String(row.created_at),
        resolvedAt: text(row.resolved_at), resolutionReason: resolution?.reason ?? null,
        ...(Array.isArray(details.converted) && Array.isArray(details.unconverted)
          ? { upgradeSegments: { converted: segmentOrders(details.converted), unconverted: segmentOrders(details.unconverted) } }
          : {}) };
    }) };
  });

  app.post("/v1/admin/commercial/anomalies/:id/resolve", async (req) => {
    auth.admin(req);
    const { id } = z.object({ id: z.string().min(1).max(512) }).strict().parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).strict().parse(req.body);
    return store.transaction(() => {
      const anomaly = db.prepare("SELECT id FROM audit WHERE id=? AND action='commercial.payment.anomaly'").get(id);
      if (!anomaly) throw new AppError(404, "PAYMENT_ANOMALY_NOT_FOUND", "支付异常记录不存在");
      const existing = db.prepare("SELECT id FROM audit WHERE action='commercial.payment.anomaly.resolved' AND resource_id=?").get(id);
      if (!existing) store.audit(ACTOR, "commercial.payment.anomaly.resolved", id, { reason });
      return { data: { id, resolved: true } };
    });
  });

  app.get("/v1/admin/commercial/orders", async (req) => {
    auth.admin(req);
    const query = z
      .object({
        status: z.enum(statuses).optional(),
        platform: z.enum(["android", "ios", "unconfirmed"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict()
      .parse(req.query ?? {});
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (query.status) {
      where.push("o.status=?");
      args.push(query.status);
    }
    if (query.platform === "unconfirmed") where.push("o.platform IS NULL");
    else if (query.platform) {
      where.push("o.platform=?");
      args.push(query.platform);
    }
    args.push(query.limit);
    return {
      data: all(
        `SELECT o.*,r.id refund_id,r.status refund_status
         FROM commercial_orders o
         LEFT JOIN commercial_refunds r ON r.order_id=o.id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY o.created_at DESC,o.id DESC LIMIT ?`,
        ...args,
      ).map(order),
    };
  });

  app.get("/v1/admin/commercial/ledger", async (req) => {
    auth.admin(req);
    const { limit } = limitQuery.parse(req.query ?? {});
    return {
      data: all(
        `SELECT e.id,e.bucket_id,e.call_id,e.event_key,e.kind,e.delta,e.created_at,
                b.user_id,b.kind bucket_kind
         FROM commercial_entries e
         JOIN commercial_buckets b ON b.id=e.bucket_id
         ORDER BY e.id DESC LIMIT ?`,
        limit,
      ).map((row) => ({
        id: integer(row.id, "流水编号"),
        userId: String(row.user_id),
        bucketId: String(row.bucket_id),
        bucketKind: String(row.bucket_kind),
        callId: text(row.call_id),
        eventKey: String(row.event_key),
        kind: String(row.kind),
        deltaCredits: integer(row.delta, "积分流水"),
        createdAt: String(row.created_at),
      })),
    };
  });

  app.get("/v1/admin/commercial/costs", async (req) => {
    auth.admin(req);
    const { limit } = limitQuery.parse(req.query ?? {});
    return {
      data: all(
        `SELECT id,user_id,source,kind,price,status,usage,cost_microyuan,
                exact_numerator,exact_denominator,created_at,finished_at
         FROM commercial_usage ORDER BY created_at DESC,id DESC LIMIT ?`,
        limit,
      ).map((row) => ({
        id: String(row.id),
        userId: text(row.user_id),
        source: String(row.source),
        kind: String(row.kind),
        status: String(row.status),
        priceSnapshot: json(row.price),
        usage: json(row.usage),
        costMicroyuan: optionalInteger(row.cost_microyuan, "调用成本"),
        exactNumerator: text(row.exact_numerator),
        exactDenominator: text(row.exact_denominator),
        createdAt: String(row.created_at),
        finishedAt: text(row.finished_at),
      })),
    };
  });

  app.get("/v1/admin/commercial/refunds", async (req) => {
    auth.admin(req);
    const query = z
      .object({
        status: z.enum(refundStatuses).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict()
      .parse(req.query ?? {});
    return {
      data: all(
        `SELECT * FROM commercial_refunds
         ${query.status ? "WHERE status=?" : ""}
         ORDER BY requested_at DESC,id DESC LIMIT ?`,
        ...(query.status ? [query.status] : []),
        query.limit,
      ).map(refund),
    };
  });

  app.get("/v1/admin/commercial/pending", async (req) => {
    auth.admin(req);
    const { limit } = limitQuery.parse(req.query ?? {});
    return {
      data: {
        orders: all(
          `SELECT o.*,r.id refund_id,r.status refund_status
           FROM commercial_orders o
           LEFT JOIN commercial_refunds r ON r.order_id=o.id
           WHERE o.status IN ('created','paid')
           ORDER BY o.created_at,o.id LIMIT ?`,
          limit,
        ).map(order),
        refunds: all(
          "SELECT * FROM commercial_refunds WHERE status='pending' ORDER BY requested_at,id LIMIT ?",
          limit,
        ).map(refund),
      },
    };
  });

  app.post("/v1/admin/commercial/orders/:id/refund", async (req) => {
    auth.admin(req);
    const state = configuration();
    if (!refunds || !state.paymentConfigured || !state.accessTokenConfigured)
      throw new AppError(
        503,
        "COMMERCIAL_REFUND_NOT_CONFIGURED",
        "退款通道尚未配置",
      );
    const { id } = z
      .object({ id: z.string().min(1).max(128) })
      .strict()
      .parse(req.params);
    const body = z
      .object({
        reason: z.string().trim().min(1).max(500),
        reasonCode: z.number().int().min(0).max(5),
      })
      .strict()
      .parse(req.body);
    return {
      data: await refunds.request({
        orderId: id,
        actor: ACTOR,
        reason: body.reason,
        reasonCode: body.reasonCode as 0 | 1 | 2 | 3 | 4 | 5,
      }),
    };
  });

  app.post("/v1/admin/commercial/orders/:id/sync", async (req) => {
    auth.admin(req);
    const { id } = z
      .object({ id: z.string().min(1).max(128) })
      .strict()
      .parse(req.params);
    const { reason } = z
      .object({ reason: z.string().trim().min(1).max(500) })
      .strict()
      .parse(req.body);
    const existing = db
      .prepare("SELECT status FROM commercial_orders WHERE id=?")
      .get(id) as { status: string } | undefined;
    if (!existing)
      throw new AppError(404, "ORDER_NOT_FOUND", "订单不存在");

    const details = { reason, requestId: req.id };
    store.audit(ACTOR, "commercial.order.sync.attempt", id, {
      ...details,
      orderStatus: existing.status,
    });
    try {
      const state = configuration();
      if (
        !deps.syncOrder ||
        !state.paymentConfigured ||
        !state.accessTokenConfigured
      )
        throw new AppError(
          503,
          "COMMERCIAL_SYNC_NOT_CONFIGURED",
          "支付查单通道尚未配置",
        );
      const result = await deps.syncOrder(id);
      store.audit(ACTOR, "commercial.order.sync.result", id, {
        ...details,
        state: result.state,
        ...(result.state === "delivered"
          ? { orderStatus: result.order.status }
          : {}),
      });
      return { data: result };
    } catch (error) {
      store.audit(ACTOR, "commercial.order.sync.error", id, {
        ...details,
        code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
      });
      throw error;
    }
  });

  app.post("/v1/admin/commercial/refunds/:id/resolve-unknown", async (req) => {
    auth.admin(req);
    const state = configuration();
    if (!refunds?.resolveUnknownAsFailed || !state.paymentConfigured || !state.accessTokenConfigured)
      throw new AppError(503, "COMMERCIAL_REFUND_NOT_CONFIGURED", "退款通道尚未配置");
    const { id } = z.object({ id: z.string().min(1).max(128) }).strict().parse(req.params);
    const body = z.object({ reason: z.string().trim().min(1).max(500),
      expectedAttempt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict().parse(req.body);
    return { data: await refunds.resolveUnknownAsFailed(id, { actor: ACTOR, ...body }) };
  });
}
