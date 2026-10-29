/**
 * 商业计价的整数原语。
 *
 * 配置中的金额先由十进制元字符串转为微元（1 元 = 1,000,000 微元）。
 * Token 单价仍按“每百万 token 的微元”保存；因此 token 成本先保留为
 * `微元 / 1,000,000` 的整数分子，结算批次合并后才向上取整到微元。
 */
export const MICROYUAN_PER_YUAN = 1_000_000n;
export const TOKENS_PER_MILLION = 1_000_000n;
export const CREDITS_PER_YUAN = 1_000n;
export const MICROYUAN_PER_CREDIT = MICROYUAN_PER_YUAN / CREDITS_PER_YUAN;

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const DECIMAL_YUAN = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/;

const invalid = (name: string): never => {
  throw new TypeError(`${name}必须是非负安全整数`);
};

/** Accept JSON-safe counts and exact BigInt values, while bounding untrusted input. */
export function nonNegativeSafeInteger(value: unknown, name: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return invalid(name);
    return BigInt(value);
  }
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_SAFE_INTEGER) return invalid(name);
    return value;
  }
  return invalid(name);
}

/**
 * Parses a yuan price without a floating-point conversion. Decimal prices must
 * be strings so callers cannot silently import an imprecise JavaScript number.
 */
export function parseYuanMicroyuan(value: unknown, name = "价格"): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return invalid(name);
    return BigInt(value) * MICROYUAN_PER_YUAN;
  }
  if (typeof value !== "string") return invalid(name);
  const match = DECIMAL_YUAN.exec(value.trim());
  if (!match) throw new TypeError(`${name}必须是最多六位小数的非负十进制元金额`);
  const fraction = (match[2] ?? "").padEnd(6, "0");
  const whole = BigInt(match[1]!);
  if (whole > MAX_SAFE_INTEGER) return invalid(name);
  return whole * MICROYUAN_PER_YUAN + BigInt(fraction);
}

export type CommercialUsage = {
  inputTokens?: number | bigint;
  cachedInputTokens?: number | bigint;
  outputTokens?: number | bigint;
  ocrRequests?: number | bigint;
};

/** Every token rate is an integer number of microyuan per one million tokens. */
export type CommercialRates = {
  inputMicroyuanPerMillionTokens?: number | bigint;
  cachedInputMicroyuanPerMillionTokens?: number | bigint;
  outputMicroyuanPerMillionTokens?: number | bigint;
  ocrMicroyuanPerRequest?: number | bigint;
};

/** Exact non-negative calibration factor, for example `{ numerator: 10500n, denominator: 10000n }`. */
export type CostRatio = { numerator: number | bigint; denominator: number | bigint };

const optionalInteger = (value: unknown, name: string) =>
  value === undefined ? 0n : nonNegativeSafeInteger(value, name);

/**
 * Returns a cost numerator whose denominator is TOKENS_PER_MILLION.
 * Keep and add these numerators across a settlement batch before calling
 * `costMicroyuan`; this is the only rounding boundary for token usage.
 */
export function costNumerator(
  usage: CommercialUsage,
  rates: CommercialRates,
): bigint {
  const input = optionalInteger(usage.inputTokens, "输入 token");
  const cached = optionalInteger(usage.cachedInputTokens, "缓存输入 token");
  const output = optionalInteger(usage.outputTokens, "输出 token");
  const ocr = optionalInteger(usage.ocrRequests, "OCR 次数");
  if (cached > input) throw new RangeError("缓存输入 token不能大于输入 token");

  const inputRate = optionalInteger(
    rates.inputMicroyuanPerMillionTokens,
    "输入 token 单价",
  );
  const cachedRate = optionalInteger(
    rates.cachedInputMicroyuanPerMillionTokens,
    "缓存输入 token 单价",
  );
  const outputRate = optionalInteger(
    rates.outputMicroyuanPerMillionTokens,
    "输出 token 单价",
  );
  const ocrRate = optionalInteger(rates.ocrMicroyuanPerRequest, "OCR 单价");
  return (
    (input - cached) * inputRate +
    cached * cachedRate +
    output * outputRate +
    ocr * ocrRate * TOKENS_PER_MILLION
  );
}

/**
 * Applies an exact, bounded integer calibration factor without converting a
 * cost to floating point. The returned denominator is for `costMicroyuan`.
 */
export function applyCostRatio(
  numerator: bigint,
  ratio: CostRatio,
): { numerator: bigint; denominator: bigint } {
  if (typeof numerator !== "bigint" || numerator < 0n)
    throw new TypeError("成本分子必须是非负 BigInt");
  const factorNumerator = nonNegativeSafeInteger(ratio.numerator, "校准分子");
  const factorDenominator = nonNegativeSafeInteger(ratio.denominator, "校准分母");
  if (factorDenominator === 0n) throw new RangeError("校准分母必须大于零");
  return {
    numerator: numerator * factorNumerator,
    denominator: TOKENS_PER_MILLION * factorDenominator,
  };
}

/**
 * Rounds one completed calculation up to microyuan. This is the only money
 * rounding boundary; callers may pass a combined numerator to settle batches.
 */
export function costMicroyuan(
  numerator: bigint,
  denominator = TOKENS_PER_MILLION,
): bigint {
  if (typeof numerator !== "bigint" || numerator < 0n)
    throw new TypeError("成本分子必须是非负 BigInt");
  if (typeof denominator !== "bigint" || denominator <= 0n)
    throw new TypeError("成本分母必须是正 BigInt");
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

/** Convenience for a single, already-aggregated usage record. */
export function usageCostMicroyuan(
  usage: CommercialUsage,
  rates: CommercialRates,
): bigint {
  return costMicroyuan(costNumerator(usage, rates));
}

/**
 * Converts cost to integer credits (1,000 credits per yuan) without charging
 * a whole credit for a sub-credit cost. Persist and pass back the remainder.
 */
export function creditsForCost(
  cost: bigint,
  remainderMicroyuan = 0n,
  microyuanPerCredit = MICROYUAN_PER_CREDIT,
): { credits: bigint; remainderMicroyuan: bigint } {
  if (typeof cost !== "bigint" || cost < 0n)
    throw new TypeError("成本必须是非负 BigInt 微元");
  if (typeof remainderMicroyuan !== "bigint" || remainderMicroyuan < 0n)
    throw new TypeError("余数必须是非负 BigInt 微元");
  if (typeof microyuanPerCredit !== "bigint" || microyuanPerCredit <= 0n)
    throw new TypeError("每积分微元必须是正 BigInt");
  const total = cost + remainderMicroyuan;
  return {
    credits: total / microyuanPerCredit,
    remainderMicroyuan: total % microyuanPerCredit,
  };
}

/**
 * Converts an exact rational microyuan cost to credits. The remainder uses the
 * same denominator as `numerator`, so repeated settlements never round at the
 * per-call microyuan boundary.
 */
export function creditsForExactCost(
  numerator: bigint,
  denominator: bigint,
  remainderNumerator = 0n,
  microyuanPerCredit = MICROYUAN_PER_CREDIT,
): { credits: bigint; remainderNumerator: bigint } {
  if (typeof numerator !== "bigint" || numerator < 0n)
    throw new TypeError("成本分子必须是非负 BigInt");
  if (typeof denominator !== "bigint" || denominator <= 0n)
    throw new TypeError("成本分母必须是正 BigInt");
  if (typeof remainderNumerator !== "bigint" || remainderNumerator < 0n)
    throw new TypeError("精确余数必须是非负 BigInt");
  if (typeof microyuanPerCredit !== "bigint" || microyuanPerCredit <= 0n)
    throw new TypeError("每积分微元必须是正 BigInt");
  const divisor = denominator * microyuanPerCredit;
  if (remainderNumerator >= divisor) throw new RangeError("精确余数超出积分换算范围");
  const total = numerator + remainderNumerator;
  return {
    credits: total / divisor,
    remainderNumerator: total % divisor,
  };
}
