import { currentBillingScope, currentCallContext } from "./call-context.js";
import { CommercialAccounts } from "./commercial-accounts.js";
import { CommercialLedger } from "./commercial-ledger.js";
import { CommercialPricing, type CommercialPriceSnapshot, type CommercialPricingUsage } from "./commercial-pricing.js";
import { AppError } from "./domain.js";
import type { SqliteStore } from "./store.js";
import { now as businessNow, type Clock } from "./time.js";

type Receipt = {
  id: string; status: string; cost_microyuan: number | null;
  exact_numerator: string | null; exact_denominator: string | null; price: string;
};

/** Coordinates holds with business commits. No provider is retried here. */
export class CommercialBilling {
  readonly ledger: CommercialLedger;
  readonly accounts: CommercialAccounts;
  readonly pricing: CommercialPricing;
  constructor(private readonly store: SqliteStore, clock: Clock = businessNow) {
    this.ledger = new CommercialLedger(store, clock);
    this.accounts = new CommercialAccounts(store, this.ledger, clock);
    this.pricing = new CommercialPricing(store);
  }
  get enabled() { return this.accounts.enabled(); }
  get enforcing() { return this.enabled && Boolean(currentCallContext().userId); }

  reserve(id: string, price: CommercialPriceSnapshot, upper: CommercialPricingUsage | undefined) {
    const context = currentCallContext();
    if (!context.userId || !this.enabled) return;
    const scope = currentBillingScope();
    if (!scope || scope.closed) throw new AppError(409, "CALL_FINISHED", "本次操作已结束，请重试");
    if (!price.priced || !upper)
      throw new AppError(503, "COMMERCIAL_PRICE_MISSING", "该功能暂未开放，请稍后再试");
    const exact = this.pricing.exactCost(price, upper);
    const denominator = exact.denominator * BigInt(price.microyuanPerCredit);
    const credits = (exact.numerator + denominator - 1n) / denominator;
    if (credits > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("预留积分过大");
    const account = this.accounts.sources(context.userId, price.microyuanPerCredit);
    this.ledger.reserve({ id, userId: context.userId, source: context.source,
      credits: Number(credits), price, ...account, leaseMs: 60 * 60_000 });
    scope.ids.add(id);
  }

  /** Called inside the transaction that commits the delivered result. Keep IDs
   * until scope close: an outer rollback must still be able to release them. */
  settleCurrent(userId: string) {
    if (currentCallContext().userId !== userId) return;
    const scope = currentBillingScope();
    if (!scope) return;
    this.store.transaction(() => {
      for (const id of scope.ids) {
        const row = this.receipt(userId, id);
        if (!row || row.status !== "succeeded" || row.exact_numerator === null || row.exact_denominator === null) continue;
        const price = JSON.parse(row.price) as CommercialPriceSnapshot;
        this.ledger.settleExact(userId, id, BigInt(row.exact_numerator), BigInt(row.exact_denominator), price.microyuanPerCredit);
      }
    });
  }

  failedCall(id: string, knownNoRequest = false) {
    const userId = currentCallContext().userId;
    if (!userId) return;
    // An interrupted/expired action was already refunded. A late provider
    // completion must not charge that free allowance retroactively.
    if (this.store.db.prepare("SELECT 1 FROM commercial_calls WHERE id=? AND user_id=? AND status='released'")
      .get(id, userId)) return;
    const receipt = this.receipt(userId, id);
    // Only successful calls consume free allowance. Unknown/failed upstream
    // cost is retained independently by CostSafety, not the free-credit pool.
    this.ledger.release(userId, id, this.incurredCost(receipt, knownNoRequest));
  }

  completedCall(id: string) {
    if (currentBillingScope()?.closed) this.failedCall(id);
  }

  /** Success also covers small judged operations without a legacy usage receipt.
   * Unknown usage remains merchant cost, never a fabricated user charge. */
  finishCurrent(success: boolean) {
    const userId = currentCallContext().userId;
    const scope = currentBillingScope();
    if (!scope || scope.closed) return;
    try {
      if (!userId) return;
      if (success) this.settleCurrent(userId);
    } finally {
      try {
        if (userId) for (const id of scope.ids) this.failedCall(id);
      } finally { scope.closed = true; }
    }
  }

  async action<T>(run: () => Promise<T>): Promise<T> {
    let succeeded = false;
    try { const result = await run(); succeeded = true; return result; }
    finally { this.finishCurrent(succeeded); }
  }

  /** This service owns a single SQLite process. At startup all prior holds are
   * abandoned, including calls whose business completion was interrupted. */
  recover() {
    const rows = this.store.db.prepare("SELECT id,user_id FROM commercial_calls WHERE status='held'").all() as { id: string; user_id: string }[];
    this.store.transaction(() => {
      for (const row of rows) this.ledger.release(row.user_id, row.id, this.incurredCost(this.receipt(row.user_id, row.id)));
    });
    return rows.length;
  }
  private receipt(userId: string, id: string) {
    return this.store.db.prepare("SELECT id,status,cost_microyuan,exact_numerator,exact_denominator,price FROM commercial_usage WHERE id=? AND user_id=?")
      .get(id, userId) as Receipt | undefined;
  }
  private incurredCost(receipt: Receipt | undefined, knownNoRequest = false) {
    if (knownNoRequest || receipt?.status !== "succeeded") return 0;
    return receipt.cost_microyuan ?? 0;
  }
}
