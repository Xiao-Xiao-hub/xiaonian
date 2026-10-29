import assert from "node:assert/strict";
import test from "node:test";
import {
  CREDITS_PER_YUAN,
  MICROYUAN_PER_CREDIT,
  MICROYUAN_PER_YUAN,
  TOKENS_PER_MILLION,
  applyCostRatio,
  costMicroyuan,
  costNumerator,
  creditsForCost,
  creditsForExactCost,
  parseYuanMicroyuan,
  usageCostMicroyuan,
} from "../server/src/shared/commercial-cost.js";

test("decimal yuan prices parse exactly to microyuan", () => {
  assert.equal(MICROYUAN_PER_YUAN, 1_000_000n);
  assert.equal(CREDITS_PER_YUAN, 1_000n);
  assert.equal(MICROYUAN_PER_CREDIT, 1_000n);
  assert.equal(parseYuanMicroyuan("0.000001"), 1n);
  assert.equal(parseYuanMicroyuan("12.34"), 12_340_000n);
  assert.equal(parseYuanMicroyuan(12), 12_000_000n);
  for (const invalid of ["", "1e-6", "1.0000001", "-1", "01", NaN, Infinity, 1.5, -1])
    assert.throws(() => parseYuanMicroyuan(invalid));
});

test("token and OCR cost retain sub-microyuan precision until the batch is settled", () => {
  const rates = {
    inputMicroyuanPerMillionTokens: 800_000n,
    cachedInputMicroyuanPerMillionTokens: 200_000n,
    outputMicroyuanPerMillionTokens: 2_800_000n,
    ocrMicroyuanPerRequest: 1_500_000n,
  };
  const numerator = costNumerator(
    { inputTokens: 1_000_000, cachedInputTokens: 250_000, outputTokens: 500_000, ocrRequests: 2 },
    rates,
  );
  assert.equal(numerator, 5_050_000n * TOKENS_PER_MILLION);
  assert.equal(costMicroyuan(numerator), 5_050_000n);

  const tiny = costNumerator({ inputTokens: 1 }, rates);
  assert.equal(tiny, 800_000n);
  assert.equal(costMicroyuan(tiny), 1n);
  assert.equal(costMicroyuan(tiny + tiny + tiny + tiny + tiny), 4n);
  assert.equal(usageCostMicroyuan({ inputTokens: 5 }, rates), 4n);
});

test("integer calibration keeps an exact ratio until microyuan rounding", () => {
  const adjusted = applyCostRatio(800_000n, { numerator: 10500n, denominator: 10000n });
  assert.deepEqual(adjusted, {
    numerator: 8_400_000_000n,
    denominator: 10_000_000_000n,
  });
  assert.equal(costMicroyuan(adjusted.numerator, adjusted.denominator), 1n);
  assert.throws(() => applyCostRatio(1n, { numerator: 1n, denominator: 0n }));
});

test("credit conversion carries sub-credit microyuan rather than rounding each call up", () => {
  const first = creditsForCost(999n);
  assert.deepEqual(first, { credits: 0n, remainderMicroyuan: 999n });
  assert.deepEqual(creditsForCost(1n, first.remainderMicroyuan), {
    credits: 1n,
    remainderMicroyuan: 0n,
  });
  assert.deepEqual(creditsForCost(2_499n, 0n, 2_500n), {
    credits: 0n,
    remainderMicroyuan: 2_499n,
  });
  assert.deepEqual(creditsForCost(1n, 2_499n, 2_500n), {
    credits: 1n,
    remainderMicroyuan: 0n,
  });
});

test("exact credit conversion carries sub-microyuan fractions across calls", () => {
  let remainder = 0n;
  let charged = 0n;
  for (let i = 0; i < 5; i++) {
    const converted = creditsForExactCost(8n, 10n, remainder, 1n);
    charged += converted.credits;
    remainder = converted.remainderNumerator;
  }
  assert.equal(charged, 4n);
  assert.equal(remainder, 0n);
  assert.throws(() => creditsForExactCost(1n, 0n));
  assert.throws(() => creditsForExactCost(1n, 10n, 10_000n));
});

test("commercial cost rejects invalid counts, unsafe integers, and impossible cached usage", () => {
  const rates = { inputMicroyuanPerMillionTokens: 1n };
  assert.throws(() => costNumerator({ inputTokens: -1 }, rates));
  assert.throws(() => costNumerator({ inputTokens: Number.MAX_SAFE_INTEGER + 1 }, rates));
  assert.throws(() => costNumerator({ inputTokens: 1, cachedInputTokens: 2 }, rates));
  assert.throws(() => costNumerator({ inputTokens: 1 }, { inputMicroyuanPerMillionTokens: -1n }));
  assert.throws(() => costMicroyuan(-1n));
  assert.throws(() => creditsForCost(1n, -1n));
  assert.throws(() => creditsForCost(1n, 0n, 0n));
});
