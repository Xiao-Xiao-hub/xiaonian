import { AppError } from "./domain.js";
import type { SqliteStore } from "./store.js";
import { chinaDayStart, chinaWeekStart, DAY_MS, type Clock } from "./time.js";

export const COST_SAFETY_SETTING = "commercial.costSafety";
export const COST_SAFETY_TOTALS = "security.costTotals";
export const DEFAULT_COST_SAFETY = Object.freeze({ dailyCapMicroyuan: 20_000_000 });
// A failed provider call has no delivered learner result. Use a small, bounded
// estimate for its user's anti-abuse budget, separate from the merchant's
// input/output risk estimate. At the default 3 yuan/day this allows 300 such
// failures, rather than locking a learner out after a few provider timeouts.
export const FREE_FAILURE_ESTIMATE_MICROYUAN = 10_000;
export type CostSafetyOptions = {
  dailySafetyCap?: number;
  legacyBudget?: { day: number; week: number };
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
};

export function costSafetySettings(store: SqliteStore) {
  const saved = store.setting<{ dailyCapMicroyuan?: unknown }>(COST_SAFETY_SETTING);
  const value = saved?.dailyCapMicroyuan;
  return { dailyCapMicroyuan: Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number : DEFAULT_COST_SAFETY.dailyCapMicroyuan };
}

/** Merchant risk accounting is independent of user refunds/deletion. Only two
 * business days are retained; abandoned reservations survive process restarts.
 * Every caller performs admission and its receipt insert in one transaction. */
export class CostSafety {
  private lastSiteWarning = -Infinity;
  constructor(private readonly store: SqliteStore, private readonly clock: Clock,
    private readonly options: CostSafetyOptions) {}

  status() {
    const day = chinaDayStart(this.clock().getTime());
    return { day, riskMicroyuan: this.totals(day)[day] ?? 0, ...costSafetySettings(this.store) };
  }

  reserve(userId: string | null, estimate: number, commercial: boolean, activityId: string) {
    const day = chinaDayStart(this.clock().getTime());
    const totals = this.totals(day);
    const limit = costSafetySettings(this.store).dailyCapMicroyuan;
    if (userId) {
      // Learner budgets remain at business admission: continuations and failed
      // actions follow their existing receipt/refund policy. This independent
      // ledger always keeps merchant risk, including failed provider calls.
      const stats = this.store.db.prepare(`SELECT
        COUNT(DISTINCT CASE WHEN created_at>=? THEN COALESCE(json_extract(price,'$.safetyActionId'),id) END) AS calls,
        SUM(CASE WHEN created_at>=? AND json_extract(price,'$.safetyActionId')=? THEN 1 ELSE 0 END) AS same_action,
        COALESCE(SUM(CASE WHEN created_at>=? AND status IN('failed','unknown') THEN MIN(COALESCE(json_extract(price,'$.safetyCostMicroyuan'),cost_microyuan,0),?) ELSE 0 END),0) AS failure_day,
        COALESCE(SUM(CASE WHEN status IN('failed','unknown') THEN MIN(COALESCE(json_extract(price,'$.safetyCostMicroyuan'),cost_microyuan,0),?) ELSE 0 END),0) AS failure_week
        FROM commercial_usage WHERE user_id=? AND created_at>=?`)
        .get(day, day, activityId, day, FREE_FAILURE_ESTIMATE_MICROYUAN, FREE_FAILURE_ESTIMATE_MICROYUAN,
          userId, chinaWeekStart(this.clock().getTime())) as { calls: number; same_action: number; failure_day: number; failure_week: number };
      if (!stats.same_action && Number(stats.calls) >= (this.options.dailySafetyCap ?? 500))
        this.reject("user_attempt_cap", "DAILY_LIMIT");
      if (commercial && !this.paid(userId) && this.options.legacyBudget) {
        const global = this.store.setting<Partial<{ day: number; week: number }>>("quota.budget");
        const own = (this.store.control(userId).quota as { budget?: Partial<{ day: number; week: number }> }).budget;
        for (const period of ["day", "week"] as const) {
          const candidates = [own?.[period], global?.[period], this.options.legacyBudget[period]];
          const budget = candidates.find(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000)!;
          const spent = stats[`failure_${period}`];
          // Bounded failure estimates may limit free work, never purchased credits.
          // Pending reservations are covered only by the global risk ledger.
          if (spent > 0 && spent >= budget * 1_000_000)
            this.reject(`user_${period}_cost`, "DAILY_LIMIT");
        }
      }
    }
    if (((totals[day] ?? 0) >= limit || (totals[day] ?? 0) + estimate > limit) && !(commercial && this.paid(userId))) {
      this.siteWarning(day, totals[day] ?? 0, limit, estimate);
      throw new AppError(429, "COST_CIRCUIT_OPEN", "当前调用额度已达安全上限，请稍后再试");
    }
    totals[day] = (totals[day] ?? 0) + estimate;
    this.store.saveSetting(COST_SAFETY_TOTALS, totals);
    if (totals[day]! >= limit) this.siteWarning(day, totals[day]!, limit);
    return { day, estimate };
  }

  finish(reservation: { day: string; estimate: number }, cost: number) {
    this.store.transaction(() => {
      const day = chinaDayStart(this.clock().getTime());
      const totals = this.totals(day);
      // An operation older than the retained window cannot change today's cap.
      if (Object.hasOwn(totals, reservation.day)) {
        const before = totals[reservation.day]!;
        totals[reservation.day] = Math.max(0, before - reservation.estimate + cost);
        this.store.saveSetting(COST_SAFETY_TOTALS, totals);
        const limit = costSafetySettings(this.store).dailyCapMicroyuan;
        if (reservation.day === day && before < limit && totals[day]! >= limit)
          this.siteWarning(day, totals[day]!, limit);
      }
    });
  }

  private siteWarning(day: string, riskMicroyuan: number, dailyCapMicroyuan: number, admissionEstimateMicroyuan = 0) {
    const at = this.clock().getTime();
    if (at - this.lastSiteWarning < 60_000) return;
    this.lastSiteWarning = at;
    this.options.logger?.warn({ event: "cost_circuit_open", reason: "site_day_cost", day,
      riskMicroyuan, dailyCapMicroyuan, admissionEstimateMicroyuan }, "Site daily cost circuit opened");
  }

  private totals(day: string): Record<string, number> {
    const previous = new Date(Date.parse(day) - DAY_MS).toISOString();
    const saved = this.store.setting<Record<string, number>>(COST_SAFETY_TOTALS) ?? {};
    const totals = Object.fromEntries(Object.entries(saved).filter(([key, value]) =>
      (key === day || key === previous) && Number.isSafeInteger(value) && value >= 0));
    if (!Object.hasOwn(totals, day)) {
      const prior = this.store.db.prepare(`SELECT COALESCE(SUM(COALESCE(json_extract(price,'$.safetyCostMicroyuan'),cost_microyuan,0)),0) AS cost
        FROM commercial_usage WHERE created_at>=?`).get(day) as { cost: number };
      totals[day] = Number(prior.cost);
    }
    return totals;
  }

  private paid(userId: string | null) {
    if (!userId) return false;
    const at = this.clock().getTime();
    return Boolean(this.store.db.prepare(`SELECT 1 FROM commercial_buckets b
      JOIN commercial_order_grants g ON g.bucket_id=b.id
      JOIN commercial_orders o ON o.id=g.order_id
      WHERE b.user_id=? AND o.status='delivered' AND b.kind IN('plan_total','wallet')
        AND b.starts_at<=? AND (b.ends_at IS NULL OR b.ends_at>?)
        AND (SELECT COALESCE(SUM(delta),0) FROM commercial_entries WHERE bucket_id=b.id)>0 LIMIT 1`)
      .get(userId, at, at));
  }

  private reject(reason: string, code: string): never {
    this.options.logger?.warn({ event: "cost_circuit_open", reason }, "External cost admission denied");
    throw new AppError(429, code, "当前调用额度已达安全上限，请稍后再试");
  }
}
