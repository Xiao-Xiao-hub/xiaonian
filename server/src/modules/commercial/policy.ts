import type { CommercialCatalogConfig } from "./catalog.js";

// D127, explicitly approved by the owner on 2026-10-24. This is a reviewed
// configuration template, not an automatic production setting/migration.
export const APPROVED_COMMERCIAL_VERSION = "2026-10-24.1";
export const APPROVED_COMMERCIAL_POLICY = Object.freeze({
  version: APPROVED_COMMERCIAL_VERSION,
  freeDayCredits: 30,
  freeWeekCredits: 150,
  freeMonthCostMicroyuan: 100_000_000,
  microyuanPerCredit: 1_000,
  deductionOrder: Object.freeze(["free", "plan", "wallet"] as const),
  walletConsentRequired: true,
  androidUnusedRefundDays: 7,
  minimumPurchaseAge: 14,
  guardianRequiredUnderAge: 18,
  planDays: 30,
  planWindowDays: 7,
  autoRenew: false,
});

/** Return a fresh JSON value for an explicit admin/deployment configuration
 * operation. Importing the module never changes settings or enables payment. */
export function approvedCommercialCatalog(): CommercialCatalogConfig {
  const plan = (id: "plan_entry_30d" | "plan_standard_30d" | "plan_advanced_30d", android: number, ios: number) => ({
    id, enabled: true,
    android: { weeklyCredits: android, credits: android * 4 },
    ios: { weeklyCredits: ios, credits: ios * 4 },
  });
  const points = (id: "points_10" | "points_30" | "points_50", yuan: number) => ({
    id, enabled: true,
    android: { credits: yuan * 490 },
    ios: { credits: yuan * 380 },
  });
  return {
    version: APPROVED_COMMERCIAL_VERSION, approved: true,
    goods: [
      plan("plan_entry_30d", 1350, 1075),
      plan("plan_standard_30d", 4425, 3600),
      plan("plan_advanced_30d", 10350, 8700),
      points("points_10", 10), points("points_30", 30), points("points_50", 50),
    ],
  };
}
