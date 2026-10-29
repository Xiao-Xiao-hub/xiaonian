import { AppError } from "./domain.js";
import type { CreditSource, CommercialLedger } from "./commercial-ledger.js";
import { parseYuanMicroyuan } from "./commercial-cost.js";
import type { SqliteStore } from "./store.js";
import {
  DAY_MS,
  chinaDate,
  chinaDayStart,
  chinaWeekStart,
  now as businessNow,
  type Clock,
} from "./time.js";
import { APPROVED_COMMERCIAL_POLICY } from "../modules/commercial/policy.js";
import {
  COMMERCIAL_CATALOG_SETTING,
  validateCommercialCatalog,
} from "../modules/commercial/catalog.js";
import { commercialAllowances } from "../modules/commercial/settings.js";

export type FreeCostCap = Readonly<{
  month: string;
  limitMicroyuan: number;
  microyuanPerCredit: number;
}>;
export type AccountSources = Readonly<{
  sources: CreditSource[];
  freeCostCap: FreeCostCap;
}>;

type Bucket = {
  id: string;
  kind: "free_day" | "free_week" | "plan_week" | "plan_total" | "wallet";
  starts_at: number;
  ends_at: number | null;
  grant_credits: number;
};
type AccountData = { commercial?: { walletConsentAt?: string } };
type PlanView = Readonly<{
  orderId: string;
  /** 0 means unused and 100 means the current seven-day allowance is exhausted. */
  weekPercent: number;
  /** 0 means unused and 100 means the order's total allowance is exhausted. */
  totalPercent: number;
  expiresAt: string;
  nextResetAt: string | null;
}>;
export type CommercialAccountView = Readonly<{
  enabled: boolean;
  free: Readonly<{
    day: Readonly<{ percent: number; resetAt: string }>;
    week: Readonly<{ percent: number; resetAt: string }>;
  }>;
  plans: PlanView[];
  wallet: Readonly<{ balance: number; consentRequired: boolean }>;
}>;

const WEEK_MS = 7 * DAY_MS;

const safeInteger = (value: unknown, name: string, positive = false) => {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (positive && value === 0)
  )
    throw new RangeError(`${name}必须是${positive ? "正" : "非负"}安全整数`);
  return value as number;
};
const percent = (available: number, granted: number) =>
  granted === 0
    ? 100
    : Math.min(100, Math.floor(((granted - available) * 100) / granted));
const iso = (ms: number) => new Date(ms).toISOString();
const monthOf = (ms: number) => chinaDate(ms).slice(0, 7);

/** Builds accounting sources only. It never imports old quota_spend rows. */
export class CommercialAccounts {
  constructor(
    private readonly store: SqliteStore,
    private readonly ledger: CommercialLedger,
    private readonly clock: Clock = businessNow,
  ) {}

  enabled() {
    if (this.store.setting("commercial.enabled") !== true) return false;
    const config = this.store.setting<unknown>(COMMERCIAL_CATALOG_SETTING);
    try {
      return validateCommercialCatalog(config).approved;
    } catch {
      return false;
    }
  }

  sources(userId: string, microyuanPerCredit: number): AccountSources {
    const rate = safeInteger(microyuanPerCredit, "每积分微元", true);
    this.userData(userId);
    const at = this.clock().getTime();
    const dayStart = Date.parse(chinaDayStart(at));
    const weekStart = Date.parse(chinaWeekStart(at));
    const allowances = commercialAllowances(this.store);
    const dayCredits = this.freeCredits(
      userId,
      "day",
      allowances.freeDayCredits,
      rate,
    );
    const weekCredits = this.freeCredits(
      userId,
      "week",
      allowances.freeWeekCredits,
      rate,
    );
    const day = `free:day:${userId}:${chinaDate(at)}`;
    const week = `free:week:${userId}:${chinaDate(weekStart)}`;
    // Keep the first grant in a window: subsequent settings changes cannot
    // alter an issued free bucket.
    this.ensureFreeBucket({
      id: day,
      userId,
      kind: "free_day",
      credits: dayCredits,
      startsAt: dayStart,
      endsAt: dayStart + DAY_MS,
    });
    this.ensureFreeBucket({
      id: week,
      userId,
      kind: "free_week",
      credits: weekCredits,
      startsAt: weekStart,
      endsAt: weekStart + WEEK_MS,
    });
    const sources: CreditSource[] = [{ name: "free", buckets: [day, week] }];
    for (const item of this.planSources(userId, at)) sources.push(item);
    if (this.walletConsented(userId))
      for (const item of this.walletSources(userId, at)) sources.push(item);
    return Object.freeze({
      sources,
      freeCostCap: Object.freeze({
        month: monthOf(at),
        limitMicroyuan: allowances.freeMonthCostMicroyuan,
        microyuanPerCredit: rate,
      }),
    });
  }

  /** Raw balances are for the budget adapter; HTTP uses view(), never this. */
  available(
    userId: string,
    microyuanPerCredit: number = APPROVED_COMMERCIAL_POLICY.microyuanPerCredit,
  ) {
    const account = this.sources(userId, microyuanPerCredit);
    const bySource = (prefix: string) =>
      account.sources
        .filter(
          (source) =>
            source.name === prefix || source.name.startsWith(`${prefix}:`),
        )
        .reduce(
          (sum, source) =>
            sum +
            Math.min(
              ...source.buckets.map((bucket) => this.ledger.balance(bucket)),
            ),
          0,
        );
    const capBalance = this.ledger.freeCostRemaining(account.freeCostCap.month);
    const capCredits = Math.floor(
      (capBalance ?? account.freeCostCap.limitMicroyuan) /
        account.freeCostCap.microyuanPerCredit,
    );
    return Object.freeze({
      free: Math.min(bySource("free"), capCredits),
      plan: bySource("plan"),
      wallet: bySource("wallet"),
    });
  }

  consentWallet(userId: string) {
    const data = this.userData(userId);
    const commercial = data.commercial ?? {};
    if (commercial.walletConsentAt) return;
    const next: AccountData = {
      ...data,
      commercial: {
        ...commercial,
        walletConsentAt: this.clock().toISOString(),
      },
    };
    this.store.db
      .prepare("UPDATE users SET data=? WHERE id=?")
      .run(JSON.stringify(next), userId);
  }

  view(userId: string, microyuanPerCredit: number): CommercialAccountView {
    const source = this.sources(userId, microyuanPerCredit);
    const at = this.clock().getTime();
    const day = this.bucket(source.sources[0]!.buckets[0]!);
    const week = this.bucket(source.sources[0]!.buckets[1]!);
    const capRemaining = this.ledger.freeCostRemaining(source.freeCostCap.month) ?? source.freeCostCap.limitMicroyuan;
    const freeRemaining = Math.min(this.ledger.balance(day.id), this.ledger.balance(week.id), Math.floor(capRemaining / microyuanPerCredit));
    const plans = this.planViews(userId, at);
    const wallet = this.walletSources(userId, at).reduce(
      (sum, item) => sum + this.ledger.balance(item.buckets[0]!),
      0,
    );
    return Object.freeze({
      enabled: this.enabled(),
      free: Object.freeze({
        day: Object.freeze({
          percent: percent(freeRemaining, day.grant_credits),
          resetAt: iso(day.ends_at!),
        }),
        week: Object.freeze({
          percent: percent(Math.min(this.ledger.balance(week.id), Math.floor(capRemaining / microyuanPerCredit)), week.grant_credits),
          resetAt: iso(week.ends_at!),
        }),
      }),
      plans,
      wallet: Object.freeze({
        balance: wallet,
        consentRequired: !this.walletConsented(userId),
      }),
    });
  }

  private freeCredits(
    userId: string,
    key: "day" | "week",
    fallback: number,
    rate: number,
  ) {
    const budget = (this.store.control(userId).quota as Record<string, unknown>)
      .budget;
    const legacy =
      budget && typeof budget === "object"
        ? (budget as Record<string, unknown>)[key]
        : undefined;
    if (
      typeof legacy !== "number" ||
      !Number.isFinite(legacy) ||
      legacy < 0 ||
      legacy > 100_000
    )
      return fallback;
    try {
      const credits =
        parseYuanMicroyuan(String(legacy), `个人${key}额度`) / BigInt(rate);
      if (credits > BigInt(Number.MAX_SAFE_INTEGER)) return fallback;
      return Number(credits);
    } catch {
      return fallback;
    }
  }

  private ensureFreeBucket(input: {
    id: string;
    userId: string;
    kind: "free_day" | "free_week";
    credits: number;
    startsAt: number;
    endsAt: number;
  }) {
    // The stable ID is the issuance record. Do not recompute a grant after an
    // operator changes a legacy personal quota during the same period.
    if (
      this.store.db
        .prepare("SELECT 1 FROM commercial_buckets WHERE id=?")
        .get(input.id)
    )
      return;
    this.ledger.ensureBucket(input);
  }

  private planSources(userId: string, at: number): CreditSource[] {
    const rows = this.store.db
      .prepare(
        "SELECT g.order_id,b.id,b.kind,b.starts_at,b.ends_at,b.grant_credits FROM commercial_order_grants g JOIN commercial_buckets b ON b.id=g.bucket_id WHERE b.user_id=? ORDER BY g.order_id,b.id",
      )
      .all(userId) as Array<Bucket & { order_id: string }>;
    const byOrder = new Map<string, Bucket[]>();
    for (const row of rows) {
      if (row.kind !== "plan_total" && row.kind !== "plan_week") continue;
      if (row.starts_at > at || (row.ends_at !== null && at >= row.ends_at))
        continue;
      const list = byOrder.get(row.order_id) ?? [];
      list.push(row);
      byOrder.set(row.order_id, list);
    }
    return [...byOrder]
      .flatMap(([orderId, buckets]) => {
        const total = buckets.find((bucket) => bucket.kind === "plan_total");
        const week = buckets.find((bucket) => bucket.kind === "plan_week");
        return total && week
          ? [
              {
                name: `plan:${orderId}`,
                buckets: [total.id, week.id],
                endsAt: total.ends_at!,
              },
            ]
          : [];
      })
      .sort((left, right) => left.endsAt - right.endsAt)
      .map(({ name, buckets }) => ({ name, buckets }));
  }

  private walletSources(userId: string, at: number): CreditSource[] {
    const rows = this.store.db
      .prepare(
        "SELECT g.order_id,b.id FROM commercial_order_grants g JOIN commercial_buckets b ON b.id=g.bucket_id WHERE b.user_id=? AND b.kind='wallet' AND b.starts_at<=? AND (b.ends_at IS NULL OR b.ends_at>?) ORDER BY b.starts_at,b.id",
      )
      .all(userId, at, at) as Array<{ order_id: string; id: string }>;
    return rows.map((row) => ({
      name: `wallet:${row.order_id}`,
      buckets: [row.id],
    }));
  }

  private planViews(userId: string, at: number): PlanView[] {
    const rows = this.store.db
      .prepare(
        "SELECT g.order_id,b.id,b.kind,b.starts_at,b.ends_at,b.grant_credits FROM commercial_order_grants g JOIN commercial_buckets b ON b.id=g.bucket_id WHERE b.user_id=? ORDER BY g.order_id,b.id",
      )
      .all(userId) as Array<Bucket & { order_id: string }>;
    const byOrder = new Map<string, Bucket[]>();
    for (const row of rows) {
      if (row.kind !== "plan_total" && row.kind !== "plan_week") continue;
      const list = byOrder.get(row.order_id) ?? [];
      list.push(row);
      byOrder.set(row.order_id, list);
    }
    return [...byOrder].flatMap(([orderId, buckets]) => {
      // An upgrade order owns one total per plan it replaced; show the running one.
      const total = buckets.find(
        (bucket) =>
          bucket.kind === "plan_total" &&
          bucket.ends_at !== null &&
          bucket.starts_at <= at &&
          at < bucket.ends_at,
      );
      if (!total || total.ends_at === null) return [];
      const week = buckets.find(
        (bucket) =>
          bucket.kind === "plan_week" &&
          bucket.starts_at <= at &&
          bucket.ends_at !== null &&
          at < bucket.ends_at,
      );
      if (!week) return [];
      const remaining = this.ledger.balance(total.id);
      const weekRemaining = this.ledger.balance(week.id);
      return [
        {
          orderId,
          weekPercent: percent(
            Math.min(remaining, weekRemaining),
            week.grant_credits,
          ),
          totalPercent: percent(remaining, total.grant_credits),
          expiresAt: iso(total.ends_at),
          nextResetAt: week?.ends_at ? iso(week.ends_at) : null,
        },
      ];
    });
  }

  private buckets(userId: string): Bucket[] {
    return this.store.db
      .prepare(
        "SELECT id,kind,starts_at,ends_at,grant_credits FROM commercial_buckets WHERE user_id=?",
      )
      .all(userId) as Bucket[];
  }
  private bucket(id: string) {
    const bucket = this.store.db
      .prepare(
        "SELECT id,kind,starts_at,ends_at,grant_credits FROM commercial_buckets WHERE id=?",
      )
      .get(id) as Bucket | undefined;
    if (!bucket)
      throw new AppError(404, "CREDIT_BUCKET_MISSING", "额度记录不存在");
    return bucket;
  }
  private userData(userId: string): AccountData {
    const row = this.store.db
      .prepare("SELECT data FROM users WHERE id=?")
      .get(userId) as { data: string } | undefined;
    if (!row) throw new AppError(404, "USER_NOT_FOUND", "用户不存在");
    const data = JSON.parse(row.data) as AccountData;
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new TypeError("用户数据无效");
    return data;
  }
  private walletConsented(userId: string) {
    return Boolean(this.userData(userId).commercial?.walletConsentAt);
  }
}
