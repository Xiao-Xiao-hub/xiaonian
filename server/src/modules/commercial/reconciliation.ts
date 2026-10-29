import type { CommercialOrder, CommercialOrders } from "./orders.js";
import type { QueryPaymentInput, QueryPaymentResult } from "./wechat-api.js";

const FIVE_MINUTES = 5 * 60 * 1000;
type QueryAdapter = { queryVerifiedPayment(input: QueryPaymentInput): Promise<QueryPaymentResult> };
export type ReconciliationTarget = QueryPaymentInput;
export type ReconciliationResult =
  | { state: "throttled"; retryAtMs: number }
  | { state: "pending"; status: number; orderType: number }
  | { state: "closed"; order: CommercialOrder }
  | { state: "delivered"; order: CommercialOrder };

type ReconciliationOptions = {
  clock?: () => Date;
  minIntervalMs?: number;
  onDelivered?: (target: ReconciliationTarget, result: Extract<QueryPaymentResult, { state: "paid" }>) => void | Promise<void>;
  onFailure?: (target: ReconciliationTarget, error: unknown, phase: "query_order" | "deliver" | "notify_provide_goods") => void;
};

const fingerprint = (target: ReconciliationTarget) => JSON.stringify([
  target.orderId, target.openid, target.env, target.productId, target.amountCents,
]);

/**
 * Explicitly invoked query-order compensation. This class owns no timer and
 * importing it never starts polling or contacts production. Concurrent calls
 * for the same order share one request; later calls respect the configured
 * interval even when the previous request failed.
 */
export class PaymentReconciliation {
  private readonly inflight = new Map<string, { fingerprint: string; promise: Promise<ReconciliationResult> }>();
  private readonly nextQueryAt = new Map<string, number>();

  constructor(
    private readonly orders: Pick<CommercialOrders, "receiveVerifiedPayment" | "closeVerifiedUnpaid">,
    private readonly adapter: QueryAdapter,
    private readonly options: ReconciliationOptions = {},
  ) {
    const interval = options.minIntervalMs ?? FIVE_MINUTES;
    if (!Number.isSafeInteger(interval) || interval < 0) throw new TypeError("查单间隔无效");
  }

  reconcile(target: ReconciliationTarget): Promise<ReconciliationResult> {
    const key = target.orderId;
    if (typeof key !== "string" || !key.length) return Promise.reject(new TypeError("业务订单号无效"));
    const expected = fingerprint(target);
    const active = this.inflight.get(key);
    if (active) {
      if (active.fingerprint !== expected) return Promise.reject(new TypeError("同一订单的查单参数冲突"));
      return active.promise;
    }
    const now = (this.options.clock ?? (() => new Date()))().getTime();
    if (!Number.isSafeInteger(now)) return Promise.reject(new TypeError("查单时钟无效"));
    for (const [id, until] of this.nextQueryAt)
      if (until <= now && !this.inflight.has(id)) this.nextQueryAt.delete(id);
    const retryAtMs = this.nextQueryAt.get(key) ?? 0;
    if (now < retryAtMs) return Promise.resolve({ state: "throttled", retryAtMs });
    this.nextQueryAt.set(key, now + (this.options.minIntervalMs ?? FIVE_MINUTES));
    const promise = this.query(target).finally(() => {
      if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, { fingerprint: expected, promise });
    return promise;
  }

  async pollPending(targets: readonly ReconciliationTarget[]): Promise<ReconciliationResult[]> {
    const ids = new Set<string>();
    for (const target of targets) {
      if (ids.has(target.orderId)) throw new TypeError("待查订单重复");
      ids.add(target.orderId);
    }
    return Promise.all(targets.map(target => this.reconcile(target)));
  }

  private async query(target: ReconciliationTarget): Promise<ReconciliationResult> {
    let result: QueryPaymentResult;
    let order: CommercialOrder;
    try {
      result = await this.adapter.queryVerifiedPayment(target);
    } catch (error) {
      this.options.onFailure?.(target, error, "query_order");
      throw error;
    }
    try {
      if (result.state === "pending") {
        if (result.status === 6 && (result.orderType === 0 || result.orderType === 7)) {
          order = this.orders.closeVerifiedUnpaid(target.orderId);
          if (order.status === "closed") return { state: "closed", order };
        }
        return result;
      }
      order = this.orders.receiveVerifiedPayment(result.receipt);
    } catch (error) {
      this.options.onFailure?.(target, error, "deliver");
      throw error;
    }
    if (order.status === "paid") return {
      state: "pending",
      status: result.status,
      orderType: result.receipt.platform === "ios" ? 7 : 0,
    };
    if (order.status === "delivered" && (result.status === 2 || result.status === 3)) {
      try {
        await this.options.onDelivered?.(target, result);
      } catch (error) {
        // Local delivery is already committed and must not be rolled back or
        // reported as failed. The anomaly remains visible for a manual retry.
        this.options.onFailure?.(target, error, "notify_provide_goods");
      }
    }
    return { state: "delivered", order };
  }
}
