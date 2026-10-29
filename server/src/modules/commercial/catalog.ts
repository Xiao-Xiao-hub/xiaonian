import { z } from "zod";
import { AppError } from "../../shared/domain.js";
import type { SqliteStore } from "../../shared/store.js";

export const COMMERCIAL_CATALOG_SETTING = "commercial.catalog";

const ids = [
  "plan_entry_30d",
  "plan_standard_30d",
  "plan_advanced_30d",
  "points_10",
  "points_30",
  "points_50",
] as const;
export type CommercialGoodId = (typeof ids)[number];
export type CommercialPlatformBenefits = {
  credits: number;
  weeklyCredits?: number;
};
export type CommercialCatalogConfig = {
  version: string;
  approved: boolean;
  goods: Array<{
    id: CommercialGoodId;
    enabled: boolean;
    android: CommercialPlatformBenefits;
    ios: CommercialPlatformBenefits;
  }>;
};

type PublishedGood = Readonly<{
  id: CommercialGoodId;
  name: string;
  priceCents: number;
  kind: "plan" | "points";
  durationDays?: 30;
  autoRenew: false;
}>;

export const PUBLISHED_COMMERCIAL_GOODS: readonly PublishedGood[] =
  Object.freeze([
    Object.freeze({
      id: "plan_entry_30d",
      name: "晓念Plus",
      priceCents: 1000,
      kind: "plan",
      durationDays: 30,
      autoRenew: false,
    }),
    Object.freeze({
      id: "plan_standard_30d",
      name: "晓念Pro",
      priceCents: 3000,
      kind: "plan",
      durationDays: 30,
      autoRenew: false,
    }),
    Object.freeze({
      id: "plan_advanced_30d",
      name: "晓念Max",
      priceCents: 6000,
      kind: "plan",
      durationDays: 30,
      autoRenew: false,
    }),
    Object.freeze({
      id: "points_10",
      name: "晓念积分包10元",
      priceCents: 1000,
      kind: "points",
      autoRenew: false,
    }),
    Object.freeze({
      id: "points_30",
      name: "晓念积分包30元",
      priceCents: 3000,
      kind: "points",
      autoRenew: false,
    }),
    Object.freeze({
      id: "points_50",
      name: "晓念积分包50元",
      priceCents: 5000,
      kind: "points",
      autoRenew: false,
    }),
  ]);

const positiveInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const benefitsSchema = z
  .object({
    credits: positiveInteger,
    weeklyCredits: positiveInteger.optional(),
  })
  .strict();
const configSchema = z
  .object({
    version: z.string().min(1).max(128),
    approved: z.boolean(),
    goods: z
      .array(
        z
          .object({
            id: z.enum(ids),
            enabled: z.boolean(),
            android: benefitsSchema,
            ios: benefitsSchema,
          })
          .strict(),
      )
      .max(ids.length),
  })
  .strict();

const plan = (id: CommercialGoodId) => id.startsWith("plan_");
const frozenBenefits = (benefits: CommercialPlatformBenefits) =>
  Object.freeze({ ...benefits });

/** Validates an admin draft before it is stored under commercial.catalog. */
export function validateCommercialCatalog(
  input: unknown,
): CommercialCatalogConfig {
  const config = configSchema.parse(input);
  const seen = new Set<string>();
  for (const good of config.goods) {
    if (seen.has(good.id)) throw new TypeError(`商品 ${good.id} 重复`);
    seen.add(good.id);
    for (const benefits of [good.android, good.ios]) {
      if (
        config.approved &&
        plan(good.id) &&
        benefits.weeklyCredits === undefined
      )
        throw new TypeError("已批准套餐必须设置每周额度");
      if (!plan(good.id) && benefits.weeklyCredits !== undefined)
        throw new TypeError("积分包不能设置每周额度");
      if (
        benefits.weeklyCredits !== undefined &&
        benefits.weeklyCredits > benefits.credits
      )
        throw new TypeError("套餐每周额度不能超过总额度");
    }
  }
  // Enabled flags preserve the full directory while allowing operations to
  // pause a good. An approved catalog must still define every entitlement.
  if (config.approved && seen.size !== ids.length)
    throw new TypeError("已批准商品目录必须包含全部六项商品");
  return {
    version: config.version,
    approved: config.approved,
    goods: config.goods.map((good) => ({
      ...good,
      android: { ...good.android },
      ios: { ...good.ios },
    })),
  };
}

export type CommercialCatalogListing = PublishedGood & {
  purchasable: boolean;
};
export type CommercialCatalogGood = PublishedGood & {
  android: Readonly<CommercialPlatformBenefits>;
  ios: Readonly<CommercialPlatformBenefits>;
};
export type CommercialCatalogSnapshot = Readonly<{
  version: string;
  json: string;
}>;

export class CommercialCatalog {
  constructor(private readonly store: SqliteStore) {}

  private config(): CommercialCatalogConfig | undefined {
    const saved = this.store.setting<unknown>(COMMERCIAL_CATALOG_SETTING);
    if (saved === undefined) return undefined;
    try {
      return validateCommercialCatalog(saved);
    } catch {
      // A malformed or stale setting must fail closed exactly like an
      // unapproved one; it must never unlock a payment path.
      return undefined;
    }
  }

  list(): CommercialCatalogListing[] {
    const config = this.config();
    const enabled = new Set(
      config?.approved
        ? config.goods.filter((good) => good.enabled).map((good) => good.id)
        : [],
    );
    return PUBLISHED_COMMERCIAL_GOODS.map((good) => ({
      ...good,
      purchasable: enabled.has(good.id),
    }));
  }

  require(id: string): CommercialCatalogGood {
    const published = PUBLISHED_COMMERCIAL_GOODS.find((good) => good.id === id);
    if (!published)
      throw new AppError(404, "COMMERCIAL_GOOD_NOT_FOUND", "商品不存在");
    const config = this.config();
    if (!config?.approved)
      throw new AppError(503, "COMMERCIAL_NOT_READY", "商业配置未就绪");
    const benefits = config.goods.find((good) => good.id === id);
    if (!benefits || !benefits.enabled)
      throw new AppError(404, "COMMERCIAL_GOOD_UNAVAILABLE", "商品暂不可购买");
    return Object.freeze({
      ...published,
      android: frozenBenefits(benefits.android),
      ios: frozenBenefits(benefits.ios),
    });
  }

  snapshot(id: string): CommercialCatalogSnapshot {
    const good = this.require(id);
    const version = this.config()!.version;
    return Object.freeze({
      version,
      json: JSON.stringify({ version, good }),
    });
  }
}
