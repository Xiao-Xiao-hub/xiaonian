import type { SqliteStore } from "../../shared/store.js";
import { priceOf, priceTable, usageCost } from "../../shared/budget.js";

type Usage = {
  provider?: unknown;
  model?: unknown;
  calls?: unknown;
  promptTokens?: unknown;
  completionTokens?: unknown;
  cachedTokens?: unknown;
  scene?: unknown;
};

// V4.2 : priced from the admin's price table (settings `ai.prices`, the
// same one the learner budget uses); a model without a row is charged at the
// table's highest rate and counted in unknownCalls. PRICE_AS_OF dates the
// seeded rows only.
export const PRICE_AS_OF = "2026-10-09";

export type MonthlyCost = {
  period: string;
  currency: "CNY";
  priceAsOf: typeof PRICE_AS_OF;
  amount: number;
  knownCalls: number;
  unknownCalls: number;
  stuckCalls: number;
  // Always null since V4.2 G4 (stuck help is priced from its own usage).
  stuckAverage: null;
};

const safeInt = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
const callsOf = (usage: Usage) => safeInt(usage.calls) || 1;
const parse = (value: unknown): Usage[] => {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Usage =>
          Boolean(item && typeof item === "object"),
        )
      : parsed && typeof parsed === "object"
        ? [parsed as Usage]
        : [];
  } catch {
    return [];
  }
};
export const month = (now: number) => {
  const china = new Date(now + 8 * 3600_000);
  const start =
    Date.UTC(china.getUTCFullYear(), china.getUTCMonth(), 1) - 8 * 3600_000;
  return {
    key: `${china.getUTCFullYear()}-${String(china.getUTCMonth() + 1).padStart(2, "0")}`,
    since: new Date(start).toISOString(),
    until: new Date(
      Date.UTC(china.getUTCFullYear(), china.getUTCMonth() + 1, 1) -
        8 * 3600_000,
    ).toISOString(),
  };
};
export function monthlyCost(
  store: SqliteStore,
  userId: string,
  now = Date.parse(store.now()),
): MonthlyCost {
  const { key: period, since, until } = month(now);
  const rows = ["jobs", "messages", "chat_images"].flatMap(
    (table) =>
      store.db
        .prepare(
          `SELECT usage FROM ${table} WHERE user_id=? AND created_at>=? AND created_at<? AND usage IS NOT NULL`,
        )
        .all(userId, since, until) as { usage: unknown }[],
  );
  const table = priceTable(store);
  let amount = 0;
  let knownCalls = 0;
  let unknownCalls = 0;
  const add = (usage: Usage) => {
    if (typeof usage.model !== "string" || !usage.model) return;
    amount += usageCost(usage, table);
    if (priceOf(table, usage.provider, usage.model).known)
      knownCalls += callsOf(usage);
    else unknownCalls += callsOf(usage);
  };
  for (const usage of rows.flatMap((row) => parse(row.usage))) {
    // 卡点 help keeps its usage on the account's spend row (below), never
    // on these tables; skip any copy so it cannot count twice.
    if (usage.scene === "map_stuck") continue;
    add(usage);
  }
  // Delivered 卡点 help : its usage is stored with the spend.
  const stuck = store.db
    .prepare(
      "SELECT usage FROM quota_spend WHERE user_id=? AND source='chat' AND source_id LIKE 'map\\_%' ESCAPE '\\' AND created_at>=? AND created_at<?",
    )
    .all(userId, since, until) as { usage: unknown }[];
  for (const row of stuck) for (const usage of parse(row.usage)) add(usage);
  const stuckCalls = stuck.length;
  const stuckAverage = null;
  return {
    period,
    currency: "CNY",
    priceAsOf: PRICE_AS_OF,
    amount,
    knownCalls,
    unknownCalls,
    stuckCalls,
    stuckAverage,
  };
}
