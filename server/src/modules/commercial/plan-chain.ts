import { AppError } from "../../shared/domain.js";
import type { SqliteStore } from "../../shared/store.js";
import { PUBLISHED_COMMERCIAL_GOODS } from "./catalog.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Upgrades are not offered when the chain ends within this window. */
const UPGRADE_MIN_REMAINING_MS = DAY_MS;
/** Devices whose virtual payment is Android's (devtools pays as Android). */
const UPGRADE_PLATFORMS = new Set(["android", "devtools"]);
export const PLAN_MS = 30 * DAY_MS;
export const MIN_UPGRADE_CENTS = 100;
const TIERS: Readonly<Record<string, number>> = Object.freeze({
  plan_entry_30d: 1,
  plan_standard_30d: 2,
  plan_advanced_30d: 3,
});
export const planTier = (goodId: string) => TIERS[goodId] ?? 0;

export const PLAN_RULE_MESSAGES = Object.freeze({
  PLAN_DOWNGRADE_BLOCKED: "当前套餐到期后才能换成更低的套餐",
  PLAN_UPGRADE_ANDROID_ONLY: "苹果手机暂不支持升级，可在当前套餐到期后购买",
  PLAN_UPGRADE_DEVICE_UNSUPPORTED: "当前设备暂不支持升级，请在安卓手机上购买",
  PLAN_UPGRADE_APP_OUTDATED: "请更新小程序后再升级",
  PLAN_UPGRADE_EXPIRING: "当前套餐即将到期，可到期后购买",
  PLAN_REFUND_PENDING: "套餐退款处理中，处理完再购买",
  PLAN_UPGRADE_TOO_LONG: "已续费多期，暂不能升级，可在到期后购买",
});
export type PlanBlockedReason = keyof typeof PLAN_RULE_MESSAGES;

type Platform = "android" | "ios";
type SnapshotGood = {
  id?: string;
  priceCents?: number;
  android?: { credits?: number; weeklyCredits?: number };
  ios?: { credits?: number; weeklyCredits?: number };
};
export type ChainSegment = Readonly<{
  orderId: string;
  goodId: string;
  tier: number;
  /** List price of the owning order's tier (an upgrade order counts as its target). */
  tierPriceCents: number;
  platform: Platform | null;
  status: string;
  /** Weekly credits the owning order granted per window, for "used this week". */
  weeklyCredits: number;
  totalBucketId: string;
  startsAt: number;
  endsAt: number;
}>;
export type PlanChain = Readonly<{
  segments: readonly ChainSegment[];
  tier: number;
  goodId: string | null;
  endsAt: number | null;
  refunding: boolean;
}>;
export type UpgradeSegment = Readonly<{
  orderId: string;
  totalBucketId: string;
  tierPriceCents: number;
  remainingMs: number;
}>;
export type UpgradeDetails = Readonly<{
  listPriceCents: number;
  priceCents: number;
  quotedAt: number;
  segments: readonly UpgradeSegment[];
}>;
export type PlanQuote = Readonly<{
  goodId: string;
  action: "buy" | "renew" | "upgrade" | "blocked";
  priceCents: number;
  listPriceCents: number;
  startsAt: number;
  expiresAt: number;
  reason: PlanBlockedReason | null;
  upgrade?: UpgradeDetails;
}>;

const snapshotGood = (snapshot: string): SnapshotGood => {
  try {
    const value = JSON.parse(snapshot) as { good?: SnapshotGood };
    return value?.good && typeof value.good === "object" ? value.good : {};
  } catch {
    return {};
  }
};
const publishedPrice = (goodId: string) =>
  PUBLISHED_COMMERCIAL_GOODS.find((good) => good.id === goodId)?.priceCents ?? 0;

/** The user's delivered plan orders that still have time left, as segments in
 * time order. A segment is one plan_total bucket; an upgrade order owns one per
 * plan it replaced. Refunding orders are not segments (nothing may queue on,
 * upgrade or extend them) but set `refunding`; superseded, refunded and unpaid
 * orders are not part of it. */
export function planChain(
  store: SqliteStore,
  userId: string,
  at: number,
  excludeOrderId = "",
): PlanChain {
  const rows = store.db.prepare(
    `SELECT o.id order_id,o.good_id,o.status,o.platform,o.snapshot,b.id,b.starts_at,b.ends_at
     FROM commercial_orders o
     JOIN commercial_order_grants g ON g.order_id=o.id
     JOIN commercial_buckets b ON b.id=g.bucket_id
     WHERE o.user_id=? AND o.id<>? AND o.good_id LIKE 'plan\\_%' ESCAPE '\\'
       AND o.superseded_by IS NULL AND o.status IN ('delivered','refunding')
       AND b.kind='plan_total' AND b.ends_at>?
     ORDER BY b.starts_at,b.id`,
  ).all(userId, excludeOrderId, at) as Array<{
    order_id: string; good_id: string; status: string; platform: Platform | null;
    snapshot: string; id: string; starts_at: number; ends_at: number;
  }>;
  const segments = rows.filter((row) => row.status === "delivered").map((row) => {
    const good = snapshotGood(row.snapshot);
    const benefits = row.platform ? good[row.platform] : undefined;
    return Object.freeze({
      orderId: row.order_id,
      goodId: row.good_id,
      tier: planTier(row.good_id),
      tierPriceCents: Number.isSafeInteger(good.priceCents) ? good.priceCents! : publishedPrice(row.good_id),
      platform: row.platform,
      status: row.status,
      weeklyCredits: Number.isSafeInteger(benefits?.weeklyCredits) ? benefits!.weeklyCredits! : 0,
      totalBucketId: row.id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    });
  });
  const top = segments.reduce<ChainSegment | null>(
    (best, item) => (!best || item.tier > best.tier ? item : best),
    null,
  );
  return Object.freeze({
    segments,
    tier: top?.tier ?? 0,
    goodId: top?.goodId ?? null,
    endsAt: segments.length ? Math.max(...segments.map((item) => item.endsAt)) : null,
    refunding: rows.some((row) => row.status === "refunding"),
  });
}

const ceilDiv = (numerator: bigint, denominator: bigint) =>
  (numerator + denominator - 1n) / denominator;

/** What buying this plan now would do. The server recomputes it at order
 * creation; delivery re-reads the chain again. */
export function quotePlan(
  store: SqliteStore,
  userId: string,
  good: Readonly<{ id: string; priceCents: number }>,
  at: number,
  platform?: string,
): PlanQuote {
  const chain = planChain(store, userId, at);
  const tier = planTier(good.id);
  const base = { goodId: good.id, listPriceCents: good.priceCents, priceCents: good.priceCents };
  const blocked = (reason: PlanBlockedReason, startsAt: number, expiresAt: number): PlanQuote =>
    Object.freeze({ ...base, action: "blocked", startsAt, expiresAt, reason });
  if (chain.refunding)
    return blocked("PLAN_REFUND_PENDING", chain.endsAt ?? at, (chain.endsAt ?? at) + PLAN_MS);
  if (chain.endsAt === null)
    return Object.freeze({ ...base, action: "buy", startsAt: at, expiresAt: at + PLAN_MS, reason: null });
  if (tier < chain.tier) return blocked("PLAN_DOWNGRADE_BLOCKED", chain.endsAt, chain.endsAt + PLAN_MS);
  if (tier === chain.tier)
    return Object.freeze({
      ...base, action: "renew", startsAt: chain.endsAt, expiresAt: chain.endsAt + PLAN_MS, reason: null,
    });
  const segments = chain.segments.map((item) => Object.freeze({
    orderId: item.orderId,
    totalBucketId: item.totalBucketId,
    tierPriceCents: item.tierPriceCents,
    remainingMs: item.endsAt - Math.max(item.startsAt, at),
  }));
  const owed = segments.reduce(
    (sum, item) => sum + BigInt(Math.max(0, good.priceCents - item.tierPriceCents)) * BigInt(item.remainingMs),
    0n,
  );
  const priceCents = Math.max(MIN_UPGRADE_CENTS, Number(ceilDiv(owed, BigInt(PLAN_MS))));
  const quote = { ...base, priceCents, startsAt: at, expiresAt: chain.endsAt };
  const refuse = (reason: PlanBlockedReason) => Object.freeze({ ...quote, action: "blocked" as const, reason });
  if (chain.endsAt - at < UPGRADE_MIN_REMAINING_MS) return refuse("PLAN_UPGRADE_EXPIRING");
  // Upgrades charge a discounted price under the target's list price
  // (activitySellingPrice). Only Android has a developer refund path for it.
  // A mini program older than the upgrade rules sends no platform.
  if (platform === undefined) return refuse("PLAN_UPGRADE_APP_OUTDATED");
  if (platform === "ios") return refuse("PLAN_UPGRADE_ANDROID_ONLY");
  if (!UPGRADE_PLATFORMS.has(platform)) return refuse("PLAN_UPGRADE_DEVICE_UNSUPPORTED");
  if (priceCents > good.priceCents) return refuse("PLAN_UPGRADE_TOO_LONG");
  return Object.freeze({
    ...quote,
    action: "upgrade",
    reason: null,
    upgrade: Object.freeze({ listPriceCents: good.priceCents, priceCents, quotedAt: at, segments }),
  });
}

export function planRuleError(reason: PlanBlockedReason) {
  return new AppError(409, reason, PLAN_RULE_MESSAGES[reason]);
}
