import { z } from "zod";
import { CommercialPricing } from "../../shared/commercial-pricing.js";
import type { SqliteStore } from "../../shared/store.js";
import { APPROVED_COMMERCIAL_POLICY } from "./policy.js";
import { COST_SAFETY_SETTING, costSafetySettings } from "../../shared/cost-safety.js";

export const COMMERCIAL_ALLOWANCES_SETTING = "commercial.allowances";
export const COMMERCIAL_PRICES_SETTING = "commercial.prices";

const safeInteger = z
  .number()
  .int()
  .min(0)
  .refine(Number.isSafeInteger, "必须是安全整数");
const positiveSafeInteger = z
  .number()
  .int()
  .min(1)
  .refine(Number.isSafeInteger, "必须是正安全整数");

const allowancesSchema = z
  .object({
    freeDayCredits: safeInteger,
    freeWeekCredits: safeInteger,
    freeMonthCostMicroyuan: safeInteger,
  })
  .strict();
const perRequestSchema = z
  .object({ microyuanPerRequest: safeInteger })
  .strict();
const pricesSchema = z
  .object({
    calibration: z
      .object({ numerator: safeInteger, denominator: positiveSafeInteger })
      .strict(),
    microyuanPerCredit: positiveSafeInteger,
    jev: perRequestSchema.optional(),
    ocr: perRequestSchema.optional(),
  })
  .strict();

export const commercialSettingsPatchSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
    allowances: allowancesSchema.optional(),
    prices: pricesSchema.optional(),
    costSafety: z.object({ dailyCapMicroyuan: safeInteger }).strict().optional(),
  })
  .strict()
  .refine((value) => value.allowances !== undefined || value.prices !== undefined || value.costSafety !== undefined, {
    message: "至少提供一项商业设置",
  });

export type CommercialAllowances = z.infer<typeof allowancesSchema>;
export type CommercialPrices = z.infer<typeof pricesSchema>;
export type CommercialSettingsPatch = z.infer<typeof commercialSettingsPatchSchema>;

const defaults = (): CommercialAllowances => ({
  freeDayCredits: APPROVED_COMMERCIAL_POLICY.freeDayCredits,
  freeWeekCredits: APPROVED_COMMERCIAL_POLICY.freeWeekCredits,
  freeMonthCostMicroyuan: APPROVED_COMMERCIAL_POLICY.freeMonthCostMicroyuan,
});

/** Reads the approved defaults until an operator has deliberately stored a
 * strict replacement. This function never writes or enables commercial use. */
export function commercialAllowances(store: SqliteStore): CommercialAllowances {
  const saved = store.setting<unknown>(COMMERCIAL_ALLOWANCES_SETTING);
  return saved === undefined ? defaults() : allowancesSchema.parse(saved);
}

export class CommercialSettings {
  private readonly pricing: CommercialPricing;

  constructor(private readonly store: SqliteStore) {
    this.pricing = new CommercialPricing(store);
  }

  get() {
    const savedPrices = this.store.setting<unknown>(COMMERCIAL_PRICES_SETTING);
    const snapshot = this.pricing.snapshot("settings", "settings", "jev");
    const ocr = this.pricing.snapshot("settings", "settings", "ocr");
    return Object.freeze({
      allowances: commercialAllowances(this.store),
      costSafety: costSafetySettings(this.store),
      prices: Object.freeze({
        calibration: snapshot.calibration,
        microyuanPerCredit: snapshot.microyuanPerCredit,
        jev: snapshot.priced ? Object.freeze({ microyuanPerRequest: snapshot.microyuanPerRequest }) : null,
        ocr: ocr.priced ? Object.freeze({ microyuanPerRequest: ocr.microyuanPerRequest }) : null,
      }),
      pricesConfigured: savedPrices !== undefined,
      version: snapshot.version,
    });
  }

  update(actor: string, input: unknown, requestId?: string) {
    const patch = commercialSettingsPatchSchema.parse(input);
    const before = this.get();
    const effectiveAt = this.store.now();
    this.store.transaction(() => {
      if (patch.allowances !== undefined)
        this.store.saveSetting(COMMERCIAL_ALLOWANCES_SETTING, patch.allowances);
      if (patch.prices !== undefined)
        this.store.saveSetting(COMMERCIAL_PRICES_SETTING, patch.prices);
      if (patch.costSafety !== undefined)
        this.store.saveSetting(COST_SAFETY_SETTING, patch.costSafety);
      const after = this.get();
      this.store.audit(actor, "commercial.settings.updated", "commercial-settings", {
        reason: patch.reason,
        effectiveAt,
        before,
        after,
        ...(requestId ? { requestId } : {}),
      });
    });
    return this.get();
  }
}
