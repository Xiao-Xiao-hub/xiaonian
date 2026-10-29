import assert from "node:assert/strict";
import test from "node:test";
import { CommercialPricing } from "../server/src/shared/commercial-pricing.js";
import { SqliteStore } from "../server/src/shared/store.js";

const pricing = (prices: unknown, commercial?: unknown) => {
  const store = new SqliteStore(":memory:");
  store.saveSetting("ai.prices", prices);
  if (commercial !== undefined) store.saveSetting("commercial.prices", commercial);
  return new CommercialPricing(store);
};

test("snapshot keeps the old LLM price after an admin change", () => {
  const store = new SqliteStore(":memory:");
  store.saveSetting("ai.prices", [{ host: "api.test", model: "chat", input: 1, cached: 0.5, output: 2, note: "v1" }]);
  const service = new CommercialPricing(store);
  const before = service.snapshot("api.test", "chat");
  store.saveSetting("ai.prices", [{ host: "api.test", model: "chat", input: 9, cached: 9, output: 9, note: "v2" }]);
  const after = service.snapshot("api.test", "chat");
  assert.equal(service.cost(before, { inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 1_000_000 }), 2_900_000);
  assert.equal(service.cost(after, { inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 1_000_000 }), 18_000_000);
  assert.notEqual(before.version, after.version);
  assert.equal(JSON.stringify(before).includes("bigint"), false);
  assert.throws(() => Object.assign(before.calibration, { numerator: 2 }));
});

test("LLM cache and unknown models use existing conservative price selection", () => {
  const service = pricing([
    { host: "api.test", model: "cheap", input: 1, cached: 0.25, output: 3, note: "a" },
    { host: "api.test", model: "dear", input: 2, cached: 0.5, output: 4, note: "b" },
  ]);
  const cached = service.snapshot("api.test", "cheap");
  assert.equal(service.cost(cached, { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 1_000_000 }), 3_700_000);
  const unknown = service.snapshot("api.test", "missing");
  assert.equal(unknown.unknown, true);
  assert.deepEqual(
    [unknown.inputMicroyuanPerMillionTokens, unknown.cachedInputMicroyuanPerMillionTokens, unknown.outputMicroyuanPerMillionTokens],
    [2_000_000, 500_000, 4_000_000],
  );
});

test("OCR and Jev require independent per-request configuration, including explicit zero", () => {
  const unpriced = pricing([]);
  assert.equal(unpriced.snapshot("", "", "ocr").priced, false);
  assert.throws(() => unpriced.cost(unpriced.snapshot("", "", "ocr"), { requests: 1 }));
  const service = pricing([], { ocr: { yuanPerRequest: "0.12" }, jev: { microyuanPerRequest: 0 } });
  assert.equal(service.cost(service.snapshot("", "", "ocr"), { requests: 3 }), 360_000);
  assert.equal(service.snapshot("", "", "jev").priced, true);
  assert.equal(service.cost(service.snapshot("", "", "jev"), { requests: 8 }), 0);
});

test("invalid settings and usage are rejected, while calibration stays exact", () => {
  assert.throws(() => pricing([], { calibration: { denominator: 0 } }).snapshot("", "", "ocr"));
  const nonFiniteStore = {
    setting: <T>(key: string): T | undefined =>
      (key === "commercial.prices" ? { microyuanPerCredit: NaN } : undefined) as T,
  } as SqliteStore;
  assert.throws(() => new CommercialPricing(nonFiniteStore).snapshot("", "", "ocr"));
  assert.throws(() => pricing([], { ocr: { yuanPerRequest: "1.0000001" } }).snapshot("", "", "ocr"));
  assert.throws(() => pricing([], { ocr: { microyuanPerRequest: Number.MAX_SAFE_INTEGER + 1 } }).snapshot("", "", "ocr"));
  const service = pricing([], { calibration: { numerator: 3, denominator: 2 }, ocr: { microyuanPerRequest: 1 } });
  const snapshot = service.snapshot("", "", "ocr");
  assert.equal(service.cost(snapshot, { requests: 1 }), 2);
  assert.throws(() => service.cost(snapshot, { requests: -1 }));
});

test("exact cost exposes the unrounded price snapshot fraction", () => {
  const service = pricing([{ host: "api.test", model: "tiny", input: 0.8, cached: 0, output: 0, note: "" }]);
  const snapshot = service.snapshot("api.test", "tiny");
  assert.deepEqual(service.exactCost(snapshot, { inputTokens: 1 }), {
    numerator: 800_000n,
    denominator: 1_000_000n,
  });
  assert.equal(service.cost(snapshot, { inputTokens: 1 }), 1);
  assert.equal(service.cost(snapshot, { inputTokens: 5 }), 4);
});
