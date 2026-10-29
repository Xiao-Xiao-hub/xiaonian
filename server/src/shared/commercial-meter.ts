import { randomUUID } from "node:crypto";
import { currentCallActivity, currentCallContext } from "./call-context.js";
import { AppError } from "./domain.js";
import { costMicroyuan } from "./commercial-cost.js";
import { CommercialPricing, type CommercialPriceKind, type CommercialPricingUsage } from "./commercial-pricing.js";
import type { SqliteStore } from "./store.js";
import type { CommercialBilling } from "./commercial-billing.js";
import { now as businessNow, type Clock } from "./time.js";
import { CostSafety, type CostSafetyOptions } from "./cost-safety.js";

export type CommercialCallInfo = {
  kind: CommercialPriceKind; provider: string; model: string; source: string;
  upperUsage?: CommercialPricingUsage;
  // Merchant risk only; never used by billing.reserve or learner settlement.
  riskUsage?: CommercialPricingUsage;
};
export type CommercialCallUsage = CommercialPricingUsage & { estimated?: boolean };
type ExactCost = { numerator: bigint; denominator: bigint };
type ProviderPool = "generation" | "judgment";
type WaitingCall = {
  pool: ProviderPool; userId: string | null;
  timer: ReturnType<typeof setTimeout>; resolve: (release: () => void) => void;
  cleanup: () => void;
};

export const PROVIDER_CONCURRENCY = Object.freeze({ perPool: 32, perUser: 8, queued: 128, queuedPerUser: 16, waitMs: 3000 });
// Merchant-risk estimates, not configured prices or charges to a learner.
// Unpriced OCR used to retain one yuan per successful image indefinitely.
export const UNPRICED_REQUEST_RISK = Object.freeze({ ocr: 10_000, jev: 1_000 });

const safeCost = (exact: ExactCost) => {
  const value = costMicroyuan(exact.numerator, exact.denominator);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("结算成本超出安全整数范围");
  return Number(value);
};

const normalizeUsage = (raw: unknown): CommercialCallUsage | null => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const aliases = {
    inputTokens: "promptTokens",
    cachedInputTokens: "cachedTokens",
    outputTokens: "completionTokens",
    requests: "calls",
  } as const;
  const normalized: CommercialCallUsage = {};
  let measured = false;
  for (const [name, alias] of Object.entries(aliases) as [keyof CommercialPricingUsage, string][]) {
    const value = item[name] === undefined ? item[alias] : item[name];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("调用用量无效");
      normalized[name] = value as number;
      measured = true;
    }
  }
  if (item.estimated === true) normalized.estimated = true;
  else if (item.estimated !== undefined && item.estimated !== false) throw new TypeError("调用用量无效");
  return measured ? normalized : null;
};

/** User-attributed logical calls, separate from the anonymous per-attempt
 * operational ledger. No prompts, responses, openids, secrets or file names.
 * Observation does not change legacy quota policy. Paid enforcement is wired
 * separately, after entitlement policy is approved and migration rehearsed.
 */
export class CommercialMeter {
  private failures = 0;
  private readonly active: Record<ProviderPool, number> = { generation: 0, judgment: 0 };
  private readonly users = new Map<string, number>();
  private readonly waiting: WaitingCall[] = [];
  private readonly safety: CostSafety;
  readonly pricing: CommercialPricing;
  get accountingWriteFailures() { return this.failures; }
  get enforcing() { return this.billing?.enforcing ?? false; }
  auditCostLimit(reason: string) {
    this.options.logger?.warn({ event: "cost_circuit_open", reason }, "External cost admission denied");
  }

  constructor(private readonly store: SqliteStore, private readonly clock: Clock = businessNow, private readonly billing?: CommercialBilling,
    private readonly options: CostSafetyOptions = {}) {
    this.pricing = new CommercialPricing(store);
    this.safety = new CostSafety(store, clock, options);
    store.db.prepare("UPDATE commercial_usage SET status='unknown' WHERE status='pending'").run();
  }

  async run<T>(
    info: CommercialCallInfo,
    call: () => Promise<T>,
    usage: (result: T) => CommercialCallUsage,
    signal?: AbortSignal,
  ): Promise<T> {
    // Jev's judgment calls have their own 32 slots; its LLM fallback only
    // starts after run() releases that slot. User limits cover both pools.
    const pool = info.kind === "jev" ? "judgment" : "generation";
    const userId = currentCallContext().userId ?? null;
    const release = await this.admit(pool, userId, signal);
    try {
      // Admission resolves asynchronously even for an immediately free slot.
      // Cancellation in that gap must not create a charge or send a request.
      signal?.throwIfAborted();
      return await this.runAdmitted(info, call, usage);
    }
    finally { release(); }
  }

  private available(pool: ProviderPool, userId: string | null) {
    return this.active[pool] < PROVIDER_CONCURRENCY.perPool &&
      (!userId || (this.users.get(userId) ?? 0) < PROVIDER_CONCURRENCY.perUser);
  }

  private take(pool: ProviderPool, userId: string | null) {
    this.active[pool]++;
    if (userId) this.users.set(userId, (this.users.get(userId) ?? 0) + 1);
    return () => {
      this.active[pool]--;
      if (userId) {
        const count = this.users.get(userId)! - 1;
        if (count) this.users.set(userId, count); else this.users.delete(userId);
      }
      // Skip a saturated user's entry so unrelated users can keep working.
      for (let i = 0; i < this.waiting.length;) {
        const entry = this.waiting[i]!;
        if (!this.available(entry.pool, entry.userId)) { i++; continue; }
        this.waiting.splice(i, 1);
        entry.cleanup();
        entry.resolve(this.take(entry.pool, entry.userId));
      }
    };
  }

  private busy() {
    this.options.logger?.warn({ event: "rate_limited", reason: "provider_concurrency" }, "External call concurrency limit reached");
    return new AppError(429, "AI_BUSY", "当前请求较多，请稍后再试");
  }

  private admit(pool: ProviderPool, userId: string | null, signal?: AbortSignal): (() => void) | Promise<() => void> {
    signal?.throwIfAborted();
    if (this.available(pool, userId)) return this.take(pool, userId);
    if (this.waiting.length >= PROVIDER_CONCURRENCY.queued || (userId &&
        this.waiting.filter(entry => entry.userId === userId).length >= PROVIDER_CONCURRENCY.queuedPerUser))
      throw this.busy();
    return new Promise((resolve, reject) => {
      const remove = (error: unknown) => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        entry.cleanup();
        reject(error);
      };
      const onAbort = () => remove(signal!.reason);
      const entry: WaitingCall = { pool, userId, resolve,
        timer: setTimeout(() => remove(this.busy()), PROVIDER_CONCURRENCY.waitMs),
        cleanup: () => {
          clearTimeout(entry.timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      entry.timer.unref();
      this.waiting.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async runAdmitted<T>(info: CommercialCallInfo, call: () => Promise<T>, usage: (result: T) => CommercialCallUsage): Promise<T> {
    const context = currentCallContext();
    const userId = context.userId ?? null;
    if (userId && !this.store.getUser(userId))
      throw new AppError(401, "SESSION_EXPIRED", "登录状态已失效");
    const snapshot = this.pricing.snapshot(info.provider, info.model, info.kind);
    // Unconfigured per-request prices retain a type-specific merchant estimate.
    // Never represent that estimate as a configured price or learner charge.
    const upperUsage = info.upperUsage ?? (info.kind === "llm"
      ? { inputTokens: 65_536, outputTokens: 32_768 } : { requests: 1 });
    const requestRisk = info.kind === "llm" ? 1_000_000 : UNPRICED_REQUEST_RISK[info.kind];
    const riskUsage = info.riskUsage ?? (info.kind === "llm" ? {
      inputTokens: Math.min(upperUsage.inputTokens ?? 4096, 4096),
      outputTokens: Math.min(upperUsage.outputTokens ?? 1024, 1024),
    } : upperUsage);
    const riskCost = (observed: CommercialCallUsage | null, failed: boolean) => {
      if (info.kind !== "llm") {
        const requests = observed?.requests ?? riskUsage.requests ?? 1;
        return snapshot.priced ? this.pricing.cost(snapshot, { requests }) : requestRisk * requests;
      }
      const attempts = Math.max(1, observed?.requests ?? 1);
      return this.pricing.cost(snapshot, {
        inputTokens: Math.max(observed?.inputTokens ?? 0, (riskUsage.inputTokens ?? 0) * attempts),
        // Missing/partial streams may hide thinking. Keep one ordinary output
        // estimate per attempted call, or the observed output when larger.
        outputTokens: Math.max(observed?.outputTokens ?? 0,
          failed || !observed ? (riskUsage.outputTokens ?? 0) * attempts : 0),
      });
    };
    const reservedRisk = riskCost(null, true);
    const id = randomUUID();
    const activityId = currentCallActivity() ?? id;
    // Fail before sending if the call cannot be recorded.
    const reservation = this.store.transaction(() => {
      const reservation = this.safety.reserve(userId, reservedRisk, this.billing?.enabled ?? false, activityId);
      this.billing?.reserve(id, snapshot, info.upperUsage ?? (info.kind === "llm" ? undefined : { requests: 1 }));
      this.store.db.prepare(
      "INSERT INTO commercial_usage(id,user_id,source,kind,price,status,created_at) VALUES(?,?,?,?,?,'pending',?)",
    ).run(id, userId, `${context.source}:${info.source}`.slice(0, 160), info.kind,
      JSON.stringify({ ...snapshot, safetyCostMicroyuan: reservedRisk, safetyActionId: activityId }), this.clock().toISOString());
      return reservation;
    });
    const retainEstimate = () => {
      this.failures++;
      try { this.finish(id, "unknown", null, null, null, reservedRisk, true); }
      catch { /* Count this logical accounting failure once; its estimate survives. */ }
    };
    let result: T;
    try {
      result = await call();
    } catch (error) {
      try {
        const normalized = normalizeUsage((error as { usage?: unknown } | null)?.usage);
        const complete = normalized !== null && (info.kind === "llm"
          ? normalized.inputTokens !== undefined && normalized.outputTokens !== undefined
          : normalized.requests !== undefined);
        const exact = snapshot.priced && complete ? this.pricing.exactCost(snapshot, normalized) : null;
        const status = normalized === null && (error as { billing?: unknown } | null)?.billing === "unknown"
          ? "unknown"
          : "failed";
        const cost = exact === null ? null : safeCost(exact);
        const safetyCost = (error as { billing?: unknown } | null)?.billing === "none"
          ? 0 : complete && !normalized?.estimated && cost !== null ? cost : riskCost(normalized, true);
        this.store.transaction(() => {
          this.finish(id, status, normalized, cost, exact, safetyCost,
            (error as { billing?: unknown } | null)?.billing !== "none" && (!complete || normalized?.estimated === true));
          this.safety.finish(reservation, safetyCost);
        });
      } catch {
        retainEstimate();
      }
      this.billing?.failedCall(id, (error as { billing?: unknown } | null)?.billing === "none");
      throw error;
    }
    // This runs after schema validation, including corrective retries. A write
    // failure must never turn a completed paid call into a provider retry.
    try {
      const normalized = normalizeUsage(usage(result));
      const complete = normalized !== null && (info.kind === "llm"
        ? normalized.inputTokens !== undefined && normalized.outputTokens !== undefined
        : normalized.requests !== undefined);
      const exact = snapshot.priced && complete ? this.pricing.exactCost(snapshot, normalized) : null;
      const cost = exact === null ? null : safeCost(exact);
      const safetyCost = cost !== null && !normalized?.estimated ? cost : riskCost(normalized, false);
      this.store.transaction(() => {
        this.finish(id, "succeeded", normalized, cost, exact, safetyCost, !complete || normalized?.estimated === true || !snapshot.priced);
        this.safety.finish(reservation, safetyCost);
      });
    } catch {
      retainEstimate();
    }
    this.billing?.completedCall(id);
    return result;
  }

  action<T>(run: () => Promise<T>): Promise<T> {
    return this.billing ? this.billing.action(run) : run();
  }

  private finish(
    id: string,
    status: string,
    usage: CommercialCallUsage | null,
    cost: number | null,
    exact: ExactCost | null,
    safetyCost: number,
    safetyUncertain = false,
  ) {
    this.store.db.prepare(
        "UPDATE commercial_usage SET status=?,usage=?,cost_microyuan=?,exact_numerator=?,exact_denominator=?,finished_at=?,price=json_set(price,'$.safetyCostMicroyuan',?,'$.safetyUncertain',?) WHERE id=? AND status='pending'",
      ).run(status, usage === null ? null : JSON.stringify(usage), cost, exact?.numerator.toString() ?? null,
        exact?.denominator.toString() ?? null, this.clock().toISOString(), safetyCost, safetyUncertain ? 1 : 0, id);
  }
}
