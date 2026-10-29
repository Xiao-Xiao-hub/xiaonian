import { CommercialPricing } from "../../shared/commercial-pricing.js";
import type { SqliteStore } from "../../shared/store.js";

// Use the existing operations missing[] list so deployed admin clients can
// display this actionable message without a response-shape change.
export const OCR_PRICE_MISSING = "腾讯 OCR 单价（commercial.prices.ocr）";

export function isTencentOcrPriceMissing(store: SqliteStore, configured: boolean) {
  if (!configured || store.setting("commercial.enabled") !== true) return false;
  try {
    return !new CommercialPricing(store).snapshot("ocr.tencentcloudapi.com", "GeneralBasicOCR", "ocr").priced;
  } catch {
    return true;
  }
}
