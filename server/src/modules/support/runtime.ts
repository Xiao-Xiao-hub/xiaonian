import { z } from "zod";
import { supportOutputTokens, type ModelRouter } from "../../providers/model-router.js";
import type { SqliteStore } from "../../shared/store.js";
import type { CommercialMeter } from "../../shared/commercial-meter.js";
import type { UsageMeter } from "../../shared/usage-ledger.js";
import { costMicroyuan } from "../../shared/commercial-cost.js";
import type { Clock } from "../../shared/time.js";
import { SupportGate } from "./gate.js";
import { createSupportJudge, type SupportJudgeOptions } from "./judge.js";
import { createSupportGenerator } from "./generator.js";
import { supportAccountReader } from "./account-context.js";
import { SupportCostGuard, SupportService } from "./service.js";

export const SUPPORT_POLICY_KEY = "support.policy";
export const supportPolicyInputSchema = z.object({
  perMinute: z.number().int().min(1).max(60),
  perDay: z.number().int().min(1).max(1000),
  dailyCapMicroyuan: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  rejectBelow: z.number().min(0).max(1),
  injectionAt: z.number().min(0).max(1),
  generateAt: z.number().min(0).max(1),
}).strict().refine(value => value.perMinute <= value.perDay && value.rejectBelow < value.generateAt, {
  message: "每分钟上限须不高于每日上限，拒绝阈值须低于生成阈值",
});
export const supportPolicySchema = z.object({
  perMinute: z.number().int().min(1).max(60).default(6),
  perDay: z.number().int().min(1).max(1000).default(30),
  dailyCapMicroyuan: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  rejectBelow: z.number().min(0).max(1).default(0.3),
  injectionAt: z.number().min(0).max(1).default(0.3),
  generateAt: z.number().min(0).max(1).default(0.7),
}).strict().refine(value => value.perMinute <= value.perDay && value.rejectBelow < value.generateAt, {
  message: "每分钟上限须不高于每日上限，拒绝阈值须低于生成阈值",
});

export function supportPolicy(store: SqliteStore) {
  const parsed = supportPolicySchema.safeParse(store.setting(SUPPORT_POLICY_KEY) ?? {});
  // Invalid or absent configuration cannot turn on spending.
  return parsed.success ? parsed.data : supportPolicySchema.parse({});
}

export type SupportPricingStatus = Readonly<{
  judge: "not_configured" | "unpriced" | "priced";
  generate: "not_configured" | "unpriced" | "priced";
}>;

/** Read-only readiness for the operations view. It deliberately distinguishes
 * an absent route from a configured route whose price table lacks an entry. */
export function getSupportPricingStatus(input: {
  models: ModelRouter;
  commercialMeter: CommercialMeter;
  judge: Pick<SupportJudgeOptions, "apiKey" | "baseUrl">;
}): SupportPricingStatus {
  const priced = (provider: string, model: string, kind: "jev" | "llm") => {
    const snapshot = input.commercialMeter.pricing.snapshot(provider, model, kind);
    return snapshot.priced && !snapshot.unknown ? "priced" as const : "unpriced" as const;
  };
  let judge: SupportPricingStatus["judge"] = "not_configured";
  let generate: SupportPricingStatus["generate"] = "not_configured";
  try {
    if (input.judge.apiKey)
      judge = priced(new URL(input.judge.baseUrl ?? "https://api.typesafe.ai").host, "jev-1.13.0", "jev");
    const endpoint = input.models.candidates("support")[0];
    if (endpoint) generate = priced(new URL(endpoint.baseUrl).host, endpoint.model, "llm");
  } catch {
    // A malformed route cannot be admitted and is not described as priced.
    if (input.judge.apiKey) judge = "unpriced";
    generate = "unpriced";
  }
  return { judge, generate };
}

export function createSupportRuntime(input: {
  store: SqliteStore; models: ModelRouter; commercialMeter: CommercialMeter;
  usageMeter: UsageMeter; judge: Pick<SupportJudgeOptions, "apiKey" | "baseUrl" | "timeoutMs">;
  fetcher?: typeof fetch; clock: Clock;
}) {
  const { store, models, commercialMeter, clock } = input;
  const judge = input.judge.apiKey ? createSupportJudge({
    ...input.judge, usageMeter: input.usageMeter, commercialMeter,
  }, input.fetcher) : undefined;
  const costs = () => {
    const current = supportPolicy(store);
    const upper = (provider: string, model: string, kind: "jev" | "llm") => {
      const snapshot = commercialMeter.pricing.snapshot(provider, model, kind);
      if (!snapshot.priced || snapshot.unknown) return 0;
      const exact = commercialMeter.pricing.exactCost(snapshot,
        kind === "jev" ? { requests: 1 } : { inputTokens: 32_768, outputTokens: supportOutputTokens(model), requests: 1 });
      const result = costMicroyuan(exact.numerator, exact.denominator);
      if (result > BigInt(Number.MAX_SAFE_INTEGER)) return 0;
      // A verified zero-priced route still needs a finite admission reservation.
      return Math.max(1, Number(result));
    };
    try {
      const endpoint = models.candidates("support")[0];
      return {
        dailyCapMicroyuan: current.dailyCapMicroyuan,
        judgeUpperMicroyuan: judge ? upper(new URL(input.judge.baseUrl ?? "https://api.typesafe.ai").host, "jev-1.13.0", "jev") : 0,
        generateUpperMicroyuan: endpoint ? upper(new URL(endpoint.baseUrl).host, endpoint.model, "llm") : 0,
      };
    } catch {
      return { dailyCapMicroyuan: 0, judgeUpperMicroyuan: 0, generateUpperMicroyuan: 0 };
    }
  };
  return new SupportService(store, {
    gate: { check: (text, options) => {
      const current = supportPolicy(store);
      return new SupportGate(judge, { rejectBelow: current.rejectBelow, injectionAt: current.injectionAt, generateAt: current.generateAt }).check(text, options);
    } },
    generator: createSupportGenerator(models.client("support")),
    accountReader: { read: supportAccountReader(store, clock) },
    costGuard: new SupportCostGuard(store, costs, () => clock().getTime(), () => commercialMeter.auditCostLimit("support_day_cost")),
    limits: () => {
      const current = supportPolicy(store);
      return { perMinute: current.perMinute, perDay: current.perDay };
    },
    now: () => clock().getTime(),
  });
}
