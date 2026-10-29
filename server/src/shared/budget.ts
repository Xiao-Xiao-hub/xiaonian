/*
 * 费用额度：按用户、业务日期和调用凭证核算可用金额，供任务与对话服务统一检查。
 * 本模块的用户额度不等同于服务商真实账单；重复凭证、失败释放和估算用量按现有规则处理。
 */
import { AppError } from "./domain.js";
import type { SqliteStore } from "./store.js";
import type { CommercialBilling } from "./commercial-billing.js";
import {
  chinaDayStart,
  chinaWeekStart,
  DAY_MS,
  now as businessNow,
  type Clock,
} from "./time.js";
import { NOT_VOID } from "../modules/jobs/runner.js";

// V4.2 : learners spend a budget in yuan, priced from the tokens each
// model call used, per business day and per week (Monday), like a
// subscription. Failures are never charged: a spend row is written only
// where an action succeeded (a finished job, a charged reply or photo, a
// delivered 卡点 help, a saved 存成卡 draft), and it belongs to the account,
// so deleting content gives nothing back.

// 价格单位为元／百万 token；host 是接口地址的主机名，留空则匹配任意主机上的同名模型。
// 价格在管理台编辑，存入 settings 的 ai.prices；同一网关可能提供多个模型。
export type Price = {
  host: string;
  model: string;
  input: number;
  output: number;
  cached: number;
  note: string;
};
type Rate = Pick<Price, "input" | "output" | "cached">;
export const DEFAULT_PRICES: Price[] = [
  {
    host: "open.bigmodel.cn",
    model: "glm-5.3",
    input: 8,
    output: 28,
    cached: 2,
    note: "设计附录快照 2026-10-09",
  },
  {
    host: "open.bigmodel.cn",
    model: "glm-5.3-flash",
    input: 0.8,
    output: 2.8,
    cached: 0.23,
    note: "设计附录快照 2026-10-09",
  },
  // $5 / $25 per million at 7.2; cache reads at a tenth of input.
  {
    host: "",
    model: "claude-opus-5-5",
    input: 36,
    output: 180,
    cached: 3.6,
    note: "按官方标价估",
  },
];
const amount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100000;
export const validPrice = (row: unknown): row is Price => {
  const r = row as Partial<Price> | null;
  return Boolean(
    r &&
      typeof r.host === "string" &&
      typeof r.model === "string" &&
      r.model.trim() &&
      amount(r.input) &&
      amount(r.output) &&
      amount(r.cached) &&
      typeof r.note === "string",
  );
};
export const priceTable = (store: SqliteStore): Price[] => {
  const saved = store.setting<unknown>("ai.prices");
  return Array.isArray(saved) ? saved.filter(validPrice) : DEFAULT_PRICES;
};
const norm = (text: unknown) => String(text ?? "").trim().toLowerCase();
// The dearest rate of each kind in the table: what an unpriced model costs.
const highest = (table: Price[]): Rate =>
  table.length
    ? {
        input: Math.max(...table.map((r) => r.input)),
        output: Math.max(...table.map((r) => r.output)),
        cached: Math.max(...table.map((r) => r.cached)),
      }
    : DEFAULT_PRICES[2]!;
export function priceOf(
  table: Price[],
  provider: unknown,
  model: unknown,
): { rate: Rate; known: boolean } {
  const host = norm(provider);
  const name = norm(model);
  const row =
    table.find((r) => norm(r.host) === host && norm(r.model) === name) ??
    table.find((r) => !r.host.trim() && norm(r.model) === name);
  return row ? { rate: row, known: true } : { rate: highest(table), known: false };
}
type UsageItem = {
  provider?: unknown;
  model?: unknown;
  promptTokens?: unknown;
  completionTokens?: unknown;
  cachedTokens?: unknown;
  // yuan at the prices of the moment it was charged (spend rows).
  cost?: unknown;
};
// A job, message or photo keeps one usage object or a list of them.
export const usageItems = (value: unknown): UsageItem[] => {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter(
      (item): item is UsageItem => Boolean(item && typeof item === "object"),
    );
  } catch {
    return [];
  }
};
const tokens = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
const settled = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
// Yuan for recorded usage. Missing token counts cost nothing (the provider
// did not report them); calls without a model (OCR, Jev) are not priced.
// an item that kept its cost when charged costs that, so a later
// price change applies only to later calls; others are priced from `table`.
export function usageCost(value: unknown, table: Price[]) {
  let total = 0;
  for (const item of usageItems(value)) {
    if (settled(item.cost)) {
      total += item.cost;
      continue;
    }
    if (typeof item.model !== "string" || !item.model) continue;
    const { rate } = priceOf(table, item.provider, item.model);
    const prompt = tokens(item.promptTokens);
    const cached = Math.min(tokens(item.cachedTokens), prompt);
    total +=
      ((prompt - cached) * rate.input +
        cached * rate.cached +
        tokens(item.completionTokens) * rate.output) /
      1_000_000;
  }
  return total;
}
// Enabled endpoints whose model has no row in the table (charged at the
// highest rate until one is added).
export function unpriced(
  store: SqliteStore,
  table: Price[] = priceTable(store),
) {
  return (
    store.db
      .prepare(
        "SELECT alias,base_url,model FROM ai_endpoints WHERE enabled=1 ORDER BY position,created_at",
      )
      .all() as { alias: string; base_url: string; model: string }[]
  )
    .map((row) => {
      let host = "";
      try {
        host = new URL(row.base_url).host;
      } catch {}
      return { alias: row.alias, host, model: row.model };
    })
    .filter((row) => !priceOf(table, row.host, row.model).known);
}

export type Allowance = { day: number; week: number };
export type BudgetWindow = {
  pct: number;
  resetAt: string;
  spent: number;
  budget: number;
};
const MAX_BUDGET = 100000;
const validBudget = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= MAX_BUDGET;
const pickBudget = (saved: unknown) =>
  Object.fromEntries(
    (["day", "week"] as const).flatMap((key) => {
      const value = (saved as Record<string, unknown> | undefined)?.[key];
      return validBudget(value) ? [[key, value]] : [];
    }),
  ) as Partial<Allowance>;
export const BUDGET_LIMIT = MAX_BUDGET;
// The epsilon keeps sums of decimal prices (1.4 + 1.4 of 5) on the percent.
const percent = (spent: number, budget: number) =>
  spent >= budget
    ? 100
    : Math.min(99, Math.floor((spent / budget) * 100 + 1e-9));

// Budgets: the account's own (users.quota.budget), else the admin's global
// setting (settings quota.budget), else the environment. Read on every check.
// The hidden cap counts every unvoided receipt of the day and only guards
// against runaway loops; learners never see it as a number.
export class Budget {
  constructor(
    private readonly store: SqliteStore,
    readonly defaults: Allowance & { cap: number },
    private readonly clock: Clock = businessNow,
    private readonly commercial?: CommercialBilling,
  ) {}
  get commercialEnabled() { return this.commercial?.enabled ?? false; }
  finishCall(success: boolean) { this.commercial?.finishCurrent(success); }
  global(): Allowance {
    return {
      day: this.defaults.day,
      week: this.defaults.week,
      ...pickBudget(this.store.setting("quota.budget")),
    };
  }
  overrides(userId: string): Partial<Allowance> {
    return pickBudget(
      (this.store.control(userId).quota as Record<string, unknown>).budget,
    );
  }
  for(userId: string): Allowance {
    return { ...this.global(), ...this.overrides(userId) };
  }
  // One succeeded action's usage, once per (source, id). Not for an erased
  // account: a late reply must not recreate it. each priced item
  // keeps its cost at today's prices (estimated usage and unpriced models
  // alike), so the admin changing a price never rewrites what was used.
  charge(userId: string, source: string, sourceId: string, usage: unknown) {
    if (this.commercial?.enabled) {
      this.commercial.settleCurrent(userId);
      return;
    }
    if (usage === undefined || usage === null) return;
    const table = priceTable(this.store);
    const priced = (item: UsageItem) =>
      typeof item.model === "string" && item.model && !settled(item.cost)
        ? { ...item, cost: usageCost(item, table) }
        : item;
    const parsed = typeof usage === "string" ? usageItems(usage) : usage;
    usage = Array.isArray(parsed)
      ? usageItems(parsed).map(priced)
      : typeof parsed === "object" && parsed
        ? priced(parsed as UsageItem)
        : parsed;
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO quota_spend(source,source_id,user_id,usage,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=?)",
      )
      .run(
        source,
        sourceId,
        userId,
        JSON.stringify(usage),
        this.clock().toISOString(),
        userId,
      );
  }
  // Yuan spent from `since` (inclusive) to `until` (exclusive): the costs
  // kept when charged, today's prices only for rows from before V4.2 FX5a.
  spent(userId: string, since: string, until?: string) {
    const table = priceTable(this.store);
    const rows = this.store.db
      .prepare(
        `SELECT usage FROM quota_spend WHERE user_id=? AND created_at>=?${until ? " AND created_at<?" : ""}`,
      )
      .all(userId, since, ...(until ? [until] : [])) as { usage: string }[];
    return rows.reduce((sum, row) => sum + usageCost(row.usage, table), 0);
  }
  status(userId: string) {
    const ms = this.clock().getTime();
    const dayStart = chinaDayStart(ms);
    const weekStart = chinaWeekStart(ms);
    const allowance = this.for(userId);
    const table = priceTable(this.store);
    const rows = this.store.db
      .prepare(
        "SELECT usage,created_at FROM quota_spend WHERE user_id=? AND created_at>=?",
      )
      .all(userId, weekStart) as { usage: string; created_at: string }[];
    let day = 0;
    let week = 0;
    for (const row of rows) {
      const cost = usageCost(row.usage, table);
      week += cost;
      if (row.created_at >= dayStart) day += cost;
    }
    const window = (spent: number, budget: number, resetAt: string) => ({
      pct: percent(spent, budget),
      resetAt,
      spent,
      budget,
    });
    return {
      day: window(
        day,
        allowance.day,
        new Date(Date.parse(dayStart) + DAY_MS).toISOString(),
      ),
      week: window(
        week,
        allowance.week,
        new Date(Date.parse(weekStart) + 7 * DAY_MS).toISOString(),
      ),
    };
  }
  // What the learner sees: two percentages and when each comes back.
  view(userId: string) {
    if (this.commercial?.enabled) {
      const free = this.commercial.accounts.view(userId, this.commercial.pricing.snapshot("", "").microyuanPerCredit).free;
      return { day: { pct: free.day.percent, resetAt: free.day.resetAt }, week: { pct: free.week.percent, resetAt: free.week.resetAt } };
    }
    const { day, week } = this.status(userId);
    return {
      day: { pct: day.pct, resetAt: day.resetAt },
      week: { pct: week.pct, resetAt: week.resetAt },
    };
  }
  // The window that stops the next action, if any. The week wins when both
  // are used up, since it comes back later.
  blocked(userId: string) {
    if (this.commercial?.enabled) {
      const rate = this.commercial.pricing.snapshot("", "").microyuanPerCredit;
      const available = this.commercial.accounts.available(userId, rate);
      if (available.free + available.plan + available.wallet > 0) return null;
      const view = this.commercial.accounts.view(userId, rate);
      return { window: "week" as const, resetAt: view.free.week.resetAt, message: "可用额度已用完，请查看额度" };
    }
    const { day, week } = this.status(userId);
    if (week.pct >= 100)
      return {
        window: "week" as const,
        resetAt: week.resetAt,
        // The last day of the week resets both at midnight.
        message:
          week.resetAt === day.resetAt
            ? "这周的额度用完了，明天 0 点恢复"
            : "这周的额度用完了，下周一 0 点恢复",
      };
    if (day.pct >= 100)
      return {
        window: "day" as const,
        resetAt: day.resetAt,
        message: "今天的额度用完了，明天 0 点恢复",
      };
    return null;
  }
  // Before any AI action. The action that crosses the line still finishes;
  // only the next one is stopped. `units` is how many receipts it writes.
  check(userId: string, units = 1) {
    const blocked = this.blocked(userId);
    if (blocked) throw new AppError(429, "DAILY_LIMIT", blocked.message);
    if (this.receiptsToday(userId) + units > this.defaults.cap)
      throw new AppError(
        429,
        "DAILY_LIMIT",
        "今天用得太多了，歇一歇，明天 0 点恢复",
      );
  }
  // Can an action that writes `units` receipts start now? (no error)
  allows(userId: string, units = 1) {
    try {
      this.check(userId, units);
      return true;
    } catch {
      return false;
    }
  }
  receiptsToday(userId: string) {
    return Number(
      (
        this.store.db
          .prepare(
            `SELECT COUNT(*) AS n FROM quota_receipts r WHERE user_id=? AND created_at>=? AND ${NOT_VOID}`,
          )
          .get(userId, chinaDayStart(this.clock().getTime())) as { n: number }
      ).n,
    );
  }
  // The pre-V4.2 {used, limit} of one count bucket, for 0.4.0–0.6.0 pages:
  // the limit stays; used is the larger of today's real count and the share
  // of the limit the budget's larger percentage stands for, so what is left
  // reaches 0 exactly when new actions are stopped (`stopped`: the budget or
  // the hidden cap), and not before.
  legacy(
    limit: number,
    view: { day: { pct: number }; week: { pct: number } },
    counted = 0,
    stopped = false,
  ) {
    const pct = Math.max(view.day.pct, view.week.pct);
    if (stopped || pct >= 100) return { used: limit, limit };
    const share = limit - Math.ceil((limit * (100 - pct)) / 100);
    return { used: Math.max(0, Math.min(limit - 1, Math.max(counted, share))), limit };
  }
}
