import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../../shared/domain.js";
import type { SqliteStore } from "../../shared/store.js";
import { now as businessNow, type Clock } from "../../shared/time.js";
import { markAnomalyRecorded, recordPaymentAnomaly } from "./anomalies.js";
import { planChain } from "./plan-chain.js";

const REFUND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const UNKNOWN_MANUAL_REVIEW_MS = 24 * 60 * 60 * 1000;
const TEXT_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

type Holding = Readonly<{ bucketId: string; credits: number }>;
type RefundRow = {
  id: string;
  order_id: string;
  actor: string;
  reason: string;
  reason_code: number;
  amount_cents: number;
  holdings: string;
  status: "pending" | "refunded" | "failed";
  submission_status: "unknown" | "accepted" | "failed";
  failure_code: string | null;
  attempt: number;
  requested_at: number;
  updated_at: number;
  completed_at: number | null;
  status7_first_seen_at: number | null;
};
type OrderRow = {
  id: string;
  user_id: string;
  good_id: string;
  amount_cents: number;
  env: number;
  status: string;
  wx_order_id: string | null;
  platform: string | null;
  paid_at: number | null;
  buyer_openid: string;
  account_erased_at: number | null;
  superseded_by?: string | null;
  snapshot?: string;
};
type QuerySource = "refund_sync" | "callback" | "manual";

export type RefundManualReviewReason = "unknown_submission" | "status7_after_retry";
export type RefundManualReview = Readonly<{
  manualReviewReason: RefundManualReviewReason | null;
  manualReviewAt: number | null;
}>;

export type CommercialRefund = Readonly<{
  id: string;
  orderId: string;
  amountCents: number;
  actor: string;
  reason: string;
  reasonCode: number;
  status: "pending" | "refunded" | "failed";
  submissionStatus: "unknown" | "accepted" | "failed";
  failureCode: string | null;
  attempt: number;
  requestedAtMs: number;
  updatedAtMs: number;
  completedAtMs: number | null;
  manualReviewReason: RefundManualReviewReason | null;
  manualReviewAt: number | null;
}>;

export type RefundPlatformInput = Readonly<{
  openid: string;
  orderId: string;
  wxOrderId: string;
  refundOrderId: string;
  amountCents: number;
  reasonCode: 0 | 1 | 2 | 3 | 4 | 5;
  env: 0;
  /** Plan upgrades only: the list price WeChat may report as order_fee. */
  listPriceCents?: number;
}>;
export type RefundSubmitResult =
  | { state: "accepted" }
  | { state: "failed"; code: string | number };
export type RefundQueryResult =
  | { state: "pending"; status?: 2 | 3 | 4 | 5 }
  | { state: "refunded" }
  | { state: "failed"; code: string | number };
export type RefundAdapter = { refundOrder(input: RefundPlatformInput): Promise<RefundSubmitResult> };
export type RefundQueryAdapter = { queryRefund(input: RefundPlatformInput): Promise<RefundQueryResult> };

export const refundManualReview = (row: {
  status: string;
  submission_status: string;
  attempt: number;
  updated_at: number;
  status7_first_seen_at: number | null;
}): RefundManualReview => {
  if (row.status !== "pending") return { manualReviewReason: null, manualReviewAt: null };
  if (row.attempt >= 2 && row.status7_first_seen_at !== null) return {
    manualReviewReason: "status7_after_retry",
    manualReviewAt: row.status7_first_seen_at + UNKNOWN_MANUAL_REVIEW_MS,
  };
  if (row.submission_status === "unknown") return {
    manualReviewReason: "unknown_submission",
    manualReviewAt: row.updated_at + UNKNOWN_MANUAL_REVIEW_MS,
  };
  return { manualReviewReason: null, manualReviewAt: null };
};

const publicRefund = (row: RefundRow): CommercialRefund => Object.freeze({
  id: row.id,
  orderId: row.order_id,
  amountCents: row.amount_cents,
  actor: row.actor,
  reason: row.reason,
  reasonCode: row.reason_code,
  status: row.status,
  submissionStatus: row.submission_status,
  failureCode: row.failure_code,
  attempt: row.attempt,
  requestedAtMs: row.requested_at,
  updatedAtMs: row.updated_at,
  completedAtMs: row.completed_at,
  ...refundManualReview(row),
});
const nonEmpty = (value: string, name: string, max: number) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new AppError(400, "REFUND_INVALID", `${name}无效`);
  return value;
};
const refundCode = (value: string | number) => {
  const text = String(value);
  return TEXT_CODE.test(text) ? text : "PLATFORM_REJECTED";
};
/** An upgrade order's snapshot list price, which is above what was paid. */
export const upgradeListPrice = (row: { amount_cents: number; snapshot?: string }) => {
  try {
    const snapshot = JSON.parse(row.snapshot ?? "{}") as { upgrade?: unknown; good?: { priceCents?: unknown } };
    const price = snapshot?.good?.priceCents;
    return snapshot?.upgrade && Number.isSafeInteger(price) && (price as number) > row.amount_cents
      ? price as number : undefined;
  } catch {
    return undefined;
  }
};
const parseHoldings = (row: RefundRow) => JSON.parse(row.holdings) as Holding[];

/** Manual-admin refund state machine. It owns no route, timer, or credentials. */
export class CommercialRefunds {
  private readonly syncing = new Map<string, Promise<CommercialRefund>>();
  private readonly submitting = new Set<string>();
  private readonly resolvingUnknown = new Set<string>();

  constructor(
    private readonly store: SqliteStore,
    private readonly refundAdapter: RefundAdapter,
    private readonly queryAdapter: RefundQueryAdapter,
    private readonly clock: Clock = businessNow,
  ) {}

  detail(id: string) {
    const row = this.row(id);
    if (!row) throw new AppError(404, "REFUND_NOT_FOUND", "退款记录不存在");
    return publicRefund(row);
  }

  async request(input: {
    orderId: string;
    actor: string;
    reason: string;
    reasonCode: 0 | 1 | 2 | 3 | 4 | 5;
  }): Promise<CommercialRefund> {
    nonEmpty(input.orderId, "订单号", 128);
    const actor = nonEmpty(input.actor, "操作人", 128);
    const reason = nonEmpty(input.reason, "退款原因", 500);
    if (!Number.isInteger(input.reasonCode) || input.reasonCode < 0 || input.reasonCode > 5)
      throw new AppError(400, "REFUND_INVALID", "退款原因类型无效");

    let platformInput: RefundPlatformInput | undefined;
    let submit = false;
    let refund = this.store.transaction(() => {
      const existing = this.store.db.prepare(
        "SELECT * FROM commercial_refunds WHERE order_id=?",
      ).get(input.orderId) as RefundRow | undefined;
      // A pending/unknown submission is queried, never blindly submitted
      // again. Only an explicit terminal platform failure may be retried, and
      // it must reuse the same refund id to preserve platform idempotency.
      if (existing && existing.status !== "failed") return publicRefund(existing);
      if (existing && this.submitting.has(existing.id))
        throw new AppError(409, "REFUND_IN_FLIGHT", "退款提交仍在处理中，请稍后重试");

      const order = this.order(input.orderId);
      if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "订单不存在");
      const now = this.clock().getTime();
      const { erasedUndelivered, buckets } = this.refundable(order, now);

      if (!order.buyer_openid)
        throw new AppError(409, "REFUND_ORDER_STATE", "订单用户信息不完整");
      const id = existing?.id ?? randomBytes(12).toString("hex");
      const holdings = buckets.map(bucket => ({ bucketId: bucket.id, credits: bucket.grant_credits }));
      const attempt = existing ? existing.attempt + 1 : 1;
      if (existing) {
        if (existing.amount_cents !== order.amount_cents ||
            JSON.stringify(parseHoldings(existing)) !== JSON.stringify(holdings))
          throw new AppError(409, "REFUND_ORDER_STATE", "退款记录与订单权益不一致");
        this.store.db.prepare(
          `UPDATE commercial_refunds SET actor=?,reason=?,reason_code=?,status='pending',
           submission_status='unknown',failure_code=NULL,attempt=?,updated_at=?,completed_at=NULL,
           status7_first_seen_at=NULL
           WHERE id=? AND status='failed'`,
        ).run(actor, reason, input.reasonCode, attempt, now, id);
      } else {
        this.store.db.prepare(
          `INSERT INTO commercial_refunds(
            id,order_id,actor,reason,reason_code,amount_cents,holdings,status,submission_status,
            failure_code,attempt,requested_at,updated_at,completed_at
          ) VALUES(?,?,?,?,?,?,?,'pending','unknown',NULL,1,?,?,NULL)`,
        ).run(id, order.id, actor, reason, input.reasonCode, order.amount_cents, JSON.stringify(holdings), now, now);
      }
      const insert = this.store.db.prepare(
        "INSERT INTO commercial_entries(bucket_id,call_id,event_key,kind,delta,created_at) VALUES(?,NULL,?,'reserve',?,?)",
      );
      for (const holding of holdings)
        insert.run(holding.bucketId, `refund-hold:${id}:${attempt}:${holding.bucketId}`, -holding.credits, this.clock().toISOString());
      const frozen = this.store.db.prepare(
        "UPDATE commercial_orders SET status='refunding' WHERE id=? AND status=?",
      ).run(order.id, erasedUndelivered ? "paid" : "delivered");
      if (frozen.changes !== 1) throw new AppError(409, "REFUND_ORDER_STATE", "订单当前不能退款");
      this.store.audit(actor, existing ? "commercial.refund.retried" : "commercial.refund.requested", order.id, {
        refundId: id,
        attempt,
        reason,
        reasonCode: input.reasonCode,
        amountCents: order.amount_cents,
      });
      platformInput = {
        openid: order.buyer_openid,
        orderId: order.id,
        wxOrderId: order.wx_order_id!,
        refundOrderId: id,
        amountCents: order.amount_cents,
        reasonCode: input.reasonCode,
        env: 0,
        ...(upgradeListPrice(order) === undefined ? {} : { listPriceCents: upgradeListPrice(order) }),
      };
      submit = true;
      return this.detail(id);
    });
    if (!submit) return refund;

    let result: RefundSubmitResult;
    this.submitting.add(refund.id);
    try {
      result = await this.refundAdapter.refundOrder(platformInput!);
    } catch {
      this.store.transaction(() => {
        const row = this.row(refund.id);
        if (row?.status === "pending") {
          this.store.audit(actor, "commercial.refund.submit_unknown", row.order_id, { refundId: row.id });
          refund = publicRefund(row);
        }
      });
      return refund;
    } finally {
      this.submitting.delete(refund.id);
    }
    if (result.state === "failed")
      return this.applyPlatformResult(refund.id, result, refund.attempt, actor);
    if (result.state !== "accepted") return refund;
    return this.store.transaction(() => {
      const row = this.row(refund.id)!;
      if (row.attempt !== refund.attempt)
        throw new AppError(409, "REFUND_ATTEMPT_CHANGED", "退款尝试已变化，请重新核对");
      if (row.status === "pending" && row.submission_status !== "accepted") {
        const now = this.clock().getTime();
        this.store.db.prepare(
          "UPDATE commercial_refunds SET submission_status='accepted',updated_at=? WHERE id=? AND status='pending'",
        ).run(now, row.id);
        this.store.audit(actor, "commercial.refund.accepted", row.order_id, { refundId: row.id });
      }
      return publicRefund(this.row(refund.id)!);
    });
  }

  applyPlatformResult(
    id: string,
    result: RefundQueryResult | Extract<RefundSubmitResult, { state: "failed" }>,
    expectedAttempt: number,
    actor = "system:refund",
  ): CommercialRefund {
    nonEmpty(actor, "操作人", 128);
    if (result.state !== "pending" && result.state !== "refunded" && result.state !== "failed")
      throw new TypeError("退款平台状态无效");
    if (result.state === "failed" &&
        typeof result.code !== "string" && typeof result.code !== "number")
      throw new TypeError("退款平台失败码无效");
    if (!Number.isSafeInteger(expectedAttempt) || expectedAttempt < 1)
      throw new TypeError("退款尝试次数无效");
    return this.store.transaction(() => {
      const row = this.row(id);
      if (!row) throw new AppError(404, "REFUND_NOT_FOUND", "退款记录不存在");
      if (row.attempt !== expectedAttempt)
        throw new AppError(409, "REFUND_ATTEMPT_CHANGED", "退款尝试已变化，请重新核对");
      if (row.status !== "pending" || result.state === "pending") return publicRefund(row);
      const now = this.clock().getTime();
      const attempt = row.attempt;
      const insert = this.store.db.prepare(
        "INSERT INTO commercial_entries(bucket_id,call_id,event_key,kind,delta,created_at) VALUES(?,NULL,?,?,?,?)",
      );
      if (result.state === "failed") {
        const code = refundCode(result.code);
        // query_order status 7 can still describe the preceding failed try
        // when the same refund id has just been resubmitted. Releasing the
        // hold on try 2+ would let a later successful refund double-benefit
        // the user, so freeze and escalate instead.
        if (code === "STATUS_7" && attempt >= 2) {
          this.store.db.prepare(
            `UPDATE commercial_refunds SET status7_first_seen_at=COALESCE(status7_first_seen_at,?)
             WHERE id=? AND status='pending' AND attempt=?`,
          ).run(now, row.id, attempt);
          recordPaymentAnomaly(
            this.store,
            this.clock,
            `commercial-refund-retry-status7:${row.id}:${attempt}`,
            row.order_id,
            { source: "refund_sync", phase: "refund_query", code: "REFUND_RETRY_STATUS_7_STALE", refundId: row.id, attempt },
          );
          return publicRefund(this.row(row.id)!);
        }
        for (const holding of parseHoldings(row))
          insert.run(holding.bucketId, `refund-release:${row.id}:${attempt}:${holding.bucketId}`, "release", holding.credits, this.clock().toISOString());
        this.store.db.prepare(
          `UPDATE commercial_refunds SET status='failed',submission_status='failed',failure_code=?,
           updated_at=?,completed_at=?,status7_first_seen_at=NULL WHERE id=?`,
        ).run(code, now, now, row.id);
        const restored = this.store.db.prepare(
          "UPDATE commercial_orders SET status=? WHERE id=? AND status='refunding'",
        ).run(this.restoredOrderStatus(row), row.order_id);
        if (restored.changes !== 1) throw new AppError(409, "REFUND_ORDER_STATE", "退款订单状态冲突");
        this.store.audit(actor, "commercial.refund.failed", row.order_id, { refundId: row.id, code });
      } else {
        for (const holding of parseHoldings(row)) {
          insert.run(holding.bucketId, `refund-confirm-release:${row.id}:${attempt}:${holding.bucketId}`, "release", holding.credits, this.clock().toISOString());
          insert.run(holding.bucketId, `refund-confirm:${row.id}:${attempt}:${holding.bucketId}`, "refund", -holding.credits, this.clock().toISOString());
        }
        this.store.db.prepare(
          `UPDATE commercial_refunds SET status='refunded',submission_status='accepted',failure_code=NULL,
           updated_at=?,completed_at=?,status7_first_seen_at=NULL WHERE id=?`,
        ).run(now, now, row.id);
        const completed = this.store.db.prepare(
          "UPDATE commercial_orders SET status='refunded' WHERE id=? AND status='refunding'",
        ).run(row.order_id);
        if (completed.changes !== 1) throw new AppError(409, "REFUND_ORDER_STATE", "退款订单状态冲突");
        this.store.audit(actor, "commercial.refund.completed", row.order_id, { refundId: row.id });
      }
      return publicRefund(this.row(row.id)!);
    });
  }

  sync(id: string, source: QuerySource = "refund_sync"): Promise<CommercialRefund> {
    if (this.submitting.has(id) || this.resolvingUnknown.has(id))
      return Promise.reject(new AppError(409, "REFUND_IN_FLIGHT", "退款正在处理，请稍后重试"));
    const active = this.syncing.get(id);
    if (active) return active;
    const promise = (async () => {
      const row = this.row(id);
      if (!row) throw new AppError(404, "REFUND_NOT_FOUND", "退款记录不存在");
      if (row.status !== "pending") return publicRefund(row);
      const expectedAttempt = row.attempt;
      const result = await this.queryPlatform(row, source);
      return this.applyPlatformResult(id, result, expectedAttempt);
    })().finally(() => {
      if (this.syncing.get(id) === promise) this.syncing.delete(id);
    });
    this.syncing.set(id, promise);
    return promise;
  }

  async syncPending(limit = 100): Promise<CommercialRefund[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("退款同步数量无效");
    const rows = this.store.db.prepare(
      "SELECT id FROM commercial_refunds WHERE status='pending' ORDER BY requested_at,id LIMIT ?",
    ).all(limit) as Array<{ id: string }>;
    return Promise.all(rows.map(row => this.sync(row.id)));
  }

  /** Manual escape hatch for a transport-unknown submission or a retry that
   * has remained at status 7 for 24 hours. A fresh platform query is always
   * followed by a transactional state recheck before money state changes. */
  async resolveUnknownAsFailed(id: string, input: {
    actor: string;
    reason: string;
    expectedAttempt: number;
  }): Promise<CommercialRefund> {
    const actor = nonEmpty(input.actor, "操作人", 128);
    const reason = nonEmpty(input.reason, "核实说明", 500);
    if (!Number.isSafeInteger(input.expectedAttempt) || input.expectedAttempt < 1)
      throw new AppError(400, "REFUND_INVALID", "退款尝试次数无效");
    if (this.submitting.has(id) || this.syncing.has(id) || this.resolvingUnknown.has(id))
      throw new AppError(409, "REFUND_IN_FLIGHT", "退款正在核实，请稍后重试");
    const snapshot = this.row(id);
    if (!snapshot) throw new AppError(404, "REFUND_NOT_FOUND", "退款记录不存在");
    if (snapshot.attempt !== input.expectedAttempt)
      throw new AppError(409, "REFUND_ATTEMPT_CHANGED", "退款尝试已变化，请刷新后重试");
    const review = refundManualReview(snapshot);
    if (!review.manualReviewReason || review.manualReviewAt === null)
      throw new AppError(409, "REFUND_MANUAL_STATE", "当前退款没有可用的人工处理出口");
    const now = this.clock().getTime();
    if (!Number.isSafeInteger(now) || now < review.manualReviewAt)
      throw new AppError(409, "REFUND_MANUAL_TOO_EARLY", "退款状态持续满24小时后才能人工处理");

    this.resolvingUnknown.add(id);
    try {
      const result = await this.queryPlatform(snapshot, "manual");
      const confirmsNotRefunded = review.manualReviewReason === "unknown_submission"
        ? result.state === "pending" && (result.status === 2 || result.status === 3 || result.status === 4)
        : result.state === "failed" && refundCode(result.code) === "STATUS_7";
      if (result.state !== "refunded" && !confirmsNotRefunded)
        throw new AppError(409, "REFUND_PLATFORM_NOT_CLEAR", "微信查单未明确确认尚未退款");
      return this.store.transaction(() => {
        const row = this.row(id);
        if (!row) throw new AppError(404, "REFUND_NOT_FOUND", "退款记录不存在");
        if (row.attempt !== snapshot.attempt || row.status !== snapshot.status ||
            row.submission_status !== snapshot.submission_status || row.updated_at !== snapshot.updated_at ||
            row.status7_first_seen_at !== snapshot.status7_first_seen_at)
          throw new AppError(409, "REFUND_ATTEMPT_CHANGED", "退款状态已变化，请重新核对");
        if (result.state === "refunded")
          return this.applyPlatformResult(row.id, result, row.attempt, actor);
        const completedAt = this.clock().getTime();
        const insert = this.store.db.prepare(
          "INSERT INTO commercial_entries(bucket_id,call_id,event_key,kind,delta,created_at) VALUES(?,NULL,?,'release',?,?)",
        );
        for (const holding of parseHoldings(row))
          insert.run(
            holding.bucketId,
            `refund-release:${row.id}:${row.attempt}:${holding.bucketId}`,
            holding.credits,
            this.clock().toISOString(),
          );
        this.store.db.prepare(
          `UPDATE commercial_refunds SET status='failed',submission_status='failed',
           failure_code='MANUALLY_CONFIRMED_NOT_REFUNDED',updated_at=?,completed_at=?,
           status7_first_seen_at=NULL WHERE id=?`,
        ).run(completedAt, completedAt, row.id);
        const restored = this.store.db.prepare(
          "UPDATE commercial_orders SET status=? WHERE id=? AND status='refunding'",
        ).run(this.restoredOrderStatus(row), row.order_id);
        if (restored.changes !== 1)
          throw new AppError(409, "REFUND_ORDER_STATE", "退款订单状态冲突");
        this.store.audit(actor, "commercial.refund.manual_failed", row.order_id, {
          refundId: row.id,
          attempt: row.attempt,
          reason,
          manualReviewReason: review.manualReviewReason,
          platformStatus: result.state === "pending" ? result.status : 7,
        });
        return publicRefund(this.row(row.id)!);
      });
    } finally {
      this.resolvingUnknown.delete(id);
    }
  }

  /** Why the admin refund cannot start for this order now, or null. */
  blockReason(orderId: string): string | null {
    const order = this.order(orderId);
    if (!order) return "订单不存在";
    try {
      this.refundable(order, this.clock().getTime());
      return null;
    } catch (error) {
      if (error instanceof AppError) return error.message;
      throw error;
    }
  }

  private order(id: string) {
    return this.store.db.prepare(
      `SELECT id,user_id,good_id,amount_cents,env,status,wx_order_id,platform,paid_at,
              buyer_openid,account_erased_at,superseded_by,snapshot
       FROM commercial_orders WHERE id=?`,
    ).get(id) as OrderRow | undefined;
  }

  /** The order-side refund checks shared by request() and the admin list. */
  private refundable(order: OrderRow, now: number) {
    const erasedUndelivered = order.account_erased_at !== null && order.status === "paid";
    if (order.status !== "delivered" && !erasedUndelivered)
      throw new AppError(409, "REFUND_ORDER_STATE", "订单当前不能退款");
    if (order.platform === "ios")
      throw new AppError(409, "REFUND_IOS_UNSUPPORTED", "iOS订单不能由开发者主动退款");
    if (order.platform !== "android" || order.env !== 0 || !order.wx_order_id || order.paid_at === null)
      throw new AppError(409, "REFUND_ORDER_STATE", "订单支付信息不完整");
    if (!Number.isSafeInteger(now) || order.paid_at > now || now >= order.paid_at + REFUND_WINDOW_MS)
      throw new AppError(409, "REFUND_WINDOW_EXPIRED", "订单已超过七日退款期限");
    const buckets = this.store.db.prepare(
      `SELECT b.id,b.grant_credits,COALESCE(SUM(e.delta),0) balance
       FROM commercial_order_grants g
       JOIN commercial_buckets b ON b.id=g.bucket_id
       LEFT JOIN commercial_entries e ON e.bucket_id=b.id
       WHERE g.order_id=? AND b.user_id=?
       GROUP BY b.id,b.grant_credits ORDER BY b.id`,
    ).all(order.id, order.user_id) as Array<{ id: string; grant_credits: number; balance: number }>;
    // An upgrade paid after every segment it quoted had changed converted
    // nothing and holds no grant: refund it in full, nothing to take back.
    let emptyUpgrade = false;
    if (order.good_id.startsWith("plan_") && !erasedUndelivered) {
      let upgrade = false;
      try { upgrade = Boolean((JSON.parse(order.snapshot ?? "{}") as { upgrade?: unknown }).upgrade); }
      catch { upgrade = true; }
      emptyUpgrade = upgrade && !buckets.length && !order.superseded_by;
      // Converted buckets span several orders; refunding one cannot be
      // expressed as one order's untouched grant.
      if ((upgrade && !emptyUpgrade) || order.superseded_by)
        throw new AppError(409, "REFUND_PLAN_UPGRADE_MANUAL", "升级相关订单请人工处理");
      if (!emptyUpgrade) {
        const chain = planChain(this.store, order.user_id, now);
        // One plan refund at a time: a refunding plan is off the chain, so the
        // "last" check below cannot see it.
        if (chain.refunding)
          throw new AppError(409, "REFUND_PLAN_PENDING", "已有套餐退款处理中，处理完再退");
        // Refunding a plan in the middle would leave a gap in the queue.
        if (chain.segments.at(-1)?.orderId !== order.id)
          throw new AppError(409, "REFUND_PLAN_NOT_LAST", "只能退最后购买的套餐");
      }
    }
    if (!buckets.length && !erasedUndelivered && !emptyUpgrade)
      throw new AppError(409, "REFUND_ORDER_STATE", "订单权益记录不完整");
    if (buckets.some(bucket => !Number.isSafeInteger(bucket.balance) || bucket.balance !== bucket.grant_credits))
      throw new AppError(409, "REFUND_ALREADY_USED", "订单权益已使用，不能自动退款");
    return { erasedUndelivered, buckets };
  }

  private platformInput(row: RefundRow): RefundPlatformInput {
    const order = this.store.db.prepare(
      "SELECT id,user_id,amount_cents,env,wx_order_id,platform,buyer_openid,snapshot FROM commercial_orders WHERE id=?",
    ).get(row.order_id) as OrderRow | undefined;
    if (!order || order.platform !== "android" || order.env !== 0 || !order.wx_order_id ||
        !order.buyer_openid || order.amount_cents !== row.amount_cents)
      throw new AppError(409, "REFUND_ORDER_STATE", "退款订单信息不完整");
    return {
      openid: order.buyer_openid,
      orderId: order.id,
      wxOrderId: order.wx_order_id,
      refundOrderId: row.id,
      amountCents: row.amount_cents,
      reasonCode: row.reason_code as RefundPlatformInput["reasonCode"],
      env: 0,
      ...(upgradeListPrice(order) === undefined ? {} : { listPriceCents: upgradeListPrice(order) }),
    };
  }

  private row(id: string) {
    return this.store.db.prepare("SELECT * FROM commercial_refunds WHERE id=?").get(id) as RefundRow | undefined;
  }

  private restoredOrderStatus(row: RefundRow) {
    if (parseHoldings(row).length) return "delivered";
    // No holdings: an erased account's undelivered order, or an upgrade that
    // was delivered without converting anything.
    const order = this.store.db.prepare(
      "SELECT delivered_at FROM commercial_orders WHERE id=?",
    ).get(row.order_id) as { delivered_at: number | null } | undefined;
    return order?.delivered_at != null ? "delivered" : "paid";
  }

  private async queryPlatform(row: RefundRow, source: QuerySource) {
    try {
      return await this.queryAdapter.queryRefund(this.platformInput(row));
    } catch (error) {
      const code = this.queryFailureCode(error);
      const digest = createHash("sha256")
        .update(`${row.id}\0${row.attempt}\0${code}`)
        .digest("hex");
      recordPaymentAnomaly(
        this.store,
        this.clock,
        `commercial-refund-query:${digest}`,
        row.order_id,
        { source, phase: "refund_query", code, refundId: row.id, attempt: row.attempt },
      );
      markAnomalyRecorded(error);
      throw error;
    }
  }

  private queryFailureCode(error: unknown) {
    if (error instanceof AppError) return error.code;
    if (error instanceof TypeError) return "WECHAT_RESPONSE_INVALID";
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    return typeof code === "string" || typeof code === "number"
      ? `WECHAT_API_${refundCode(code)}`
      : "WECHAT_QUERY_FAILED";
  }
}
