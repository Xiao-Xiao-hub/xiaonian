/**
 * Immutable, JSON-safe price snapshots for commercial settlement.
 *
 * A caller records the returned snapshot before invoking a provider, then
 * settles with that exact object.  This keeps a later admin price update from
 * changing an already-started call's cost.
 */
import { createHash } from "node:crypto";
import {
  applyCostRatio,
  costMicroyuan,
  costNumerator,
  parseYuanMicroyuan,
} from "./commercial-cost.js";
import { priceOf, priceTable } from "./budget.js";
import type { SqliteStore } from "./store.js";

export type CommercialPriceKind = "llm" | "jev" | "ocr";

export type CommercialPriceSnapshot = Readonly<{
  version: string;
  provider: string;
  model: string;
  kind: CommercialPriceKind;
  priced: boolean;
  unknown: boolean;
  inputMicroyuanPerMillionTokens: number;
  cachedInputMicroyuanPerMillionTokens: number;
  outputMicroyuanPerMillionTokens: number;
  microyuanPerRequest: number;
  calibration: Readonly<{ numerator: number; denominator: number }>;
  microyuanPerCredit: number;
}>;

export type CommercialPricingUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  requests?: number;
};

type PerRequestPrice = { yuanPerRequest?: unknown; microyuanPerRequest?: unknown };
type CommercialPrices = {
  calibration?: { numerator?: unknown; denominator?: unknown };
  microyuanPerCredit?: unknown;
  ocr?: PerRequestPrice;
  jev?: PerRequestPrice;
};

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const safeNumber = (value: bigint, name: string) => {
  if (value < 0n || value > MAX_SAFE) throw new RangeError(`${name}超出安全整数范围`);
  return Number(value);
};

const integer = (value: unknown, name: string, zero = true) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (zero ? 0 : 1))
    throw new TypeError(`${name}必须是${zero ? "非负" : "正"}安全整数`);
  return value;
};

const decimalMicroyuan = (value: unknown, name: string) => {
  // Legacy ai.prices stores decimal numbers.  String() gives the admin's
  // displayed decimal form to the exact parser without a float calculation.
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new TypeError(`${name}必须是非负有限数`);
  return safeNumber(parseYuanMicroyuan(String(value), name), name);
};

const canonical = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("价格配置不能包含非有限数");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("价格配置必须是 JSON 数据");
};

const frozen = (snapshot: Omit<CommercialPriceSnapshot, "calibration"> & { calibration: { numerator: number; denominator: number } }) =>
  Object.freeze({ ...snapshot, calibration: Object.freeze({ ...snapshot.calibration }) });

export class CommercialPricing {
  constructor(private readonly store: SqliteStore) {}

  snapshot(
    provider: string,
    model: string,
    kind: CommercialPriceKind = "llm",
  ): CommercialPriceSnapshot {
    if (typeof provider !== "string" || typeof model !== "string")
      throw new TypeError("服务商和模型必须是字符串");
    if (kind !== "llm" && kind !== "jev" && kind !== "ocr")
      throw new TypeError("计价类型无效");

    const commercial = this.store.setting<unknown>("commercial.prices");
    if (commercial !== undefined && (commercial === null || Array.isArray(commercial) || typeof commercial !== "object"))
      throw new TypeError("commercial.prices必须是对象");
    const config = (commercial ?? {}) as CommercialPrices;
    if (config.calibration !== undefined &&
      (config.calibration === null || typeof config.calibration !== "object" || Array.isArray(config.calibration)))
      throw new TypeError("校准配置必须是对象");
    const calibration = {
      numerator: integer(config.calibration?.numerator ?? 1, "校准分子"),
      denominator: integer(config.calibration?.denominator ?? 1, "校准分母", false),
    };
    const microyuanPerCredit = integer(
      config.microyuanPerCredit ?? 1_000,
      "每积分微元",
      false,
    );
    const ai = priceTable(this.store);
    const version = createHash("sha256")
      .update(canonical({ aiPrices: ai ?? null, commercialPrices: commercial ?? null }))
      .digest("hex");
    const base = {
      version,
      provider,
      model,
      kind,
      calibration,
      microyuanPerCredit,
    };

    if (kind === "llm") {
      const picked = priceOf(ai, provider, model);
      return frozen({
        ...base,
        priced: true,
        unknown: !picked.known,
        inputMicroyuanPerMillionTokens: decimalMicroyuan(picked.rate.input, "输入 token 单价"),
        cachedInputMicroyuanPerMillionTokens: decimalMicroyuan(picked.rate.cached, "缓存输入 token 单价"),
        outputMicroyuanPerMillionTokens: decimalMicroyuan(picked.rate.output, "输出 token 单价"),
        microyuanPerRequest: 0,
      });
    }

    const perRequest = config[kind];
    if (perRequest !== undefined && (perRequest === null || Array.isArray(perRequest) || typeof perRequest !== "object"))
      throw new TypeError(`${kind}价格必须是对象`);
    const hasMicroyuan = perRequest && Object.hasOwn(perRequest, "microyuanPerRequest");
    const hasYuan = perRequest && Object.hasOwn(perRequest, "yuanPerRequest");
    if (hasMicroyuan && hasYuan) throw new TypeError(`${kind}价格只能指定一种单位`);
    const microyuanPerRequest = hasMicroyuan
      ? integer(perRequest!.microyuanPerRequest, `${kind}每次微元价格`)
      : hasYuan
        ? safeNumber(parseYuanMicroyuan(perRequest!.yuanPerRequest, `${kind}每次元价格`), `${kind}每次微元价格`)
        : 0;
    return frozen({
      ...base,
      priced: Boolean(hasMicroyuan || hasYuan),
      unknown: false,
      inputMicroyuanPerMillionTokens: 0,
      cachedInputMicroyuanPerMillionTokens: 0,
      outputMicroyuanPerMillionTokens: 0,
      microyuanPerRequest,
    });
  }

  exactCost(
    snapshot: CommercialPriceSnapshot,
    usage: CommercialPricingUsage,
  ): { numerator: bigint; denominator: bigint } {
    if (!snapshot.priced) throw new RangeError("当前调用没有已配置价格，不能结算");
    const requests = usage.requests ?? 0;
    const numerator = costNumerator(
      {
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        ocrRequests: snapshot.kind === "llm" ? 0 : requests,
      },
      {
        inputMicroyuanPerMillionTokens: snapshot.inputMicroyuanPerMillionTokens,
        cachedInputMicroyuanPerMillionTokens: snapshot.cachedInputMicroyuanPerMillionTokens,
        outputMicroyuanPerMillionTokens: snapshot.outputMicroyuanPerMillionTokens,
        ocrMicroyuanPerRequest: snapshot.microyuanPerRequest,
      },
    );
    return applyCostRatio(numerator, snapshot.calibration);
  }

  cost(snapshot: CommercialPriceSnapshot, usage: CommercialPricingUsage): number {
    const exact = this.exactCost(snapshot, usage);
    return safeNumber(costMicroyuan(exact.numerator, exact.denominator), "结算成本");
  }
}
