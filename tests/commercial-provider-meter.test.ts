import assert from "node:assert/strict";
import test from "node:test";
import { Jev, JevError } from "../server/src/providers/jev.js";
import { ModelRouter, PING } from "../server/src/providers/model-router.js";
import { TencentOcr } from "../server/src/providers/tencent-ocr.js";
import type {
  CommercialCallInfo,
  CommercialCallUsage,
  CommercialMeter,
} from "../server/src/shared/commercial-meter.js";
import { SqliteStore } from "../server/src/shared/store.js";

type MeterEntry = {
  info: CommercialCallInfo;
  usage?: CommercialCallUsage;
  failed?: true;
};

function meter(entries: MeterEntry[]): Pick<CommercialMeter, "run"> {
  return {
    async run<T>(info, call, usage) {
      try {
        const result = await call();
        entries.push({ info, usage: usage(result) });
        return result;
      } catch (error) {
        entries.push({ info, failed: true });
        throw error;
      }
    },
  };
}

function router(entries: MeterEntry[], fetcher: typeof fetch) {
  const store = new SqliteStore(":memory:");
  store.db
    .prepare(
      "INSERT INTO ai_endpoints(id,alias,base_url,api_key,model,vision,thinking_format,extra_body,timeout_ms,position,enabled,created_at,updated_at) VALUES('aep_meter','meter','https://provider.test/v1','key','meter-model',0,'none','{}',5000,0,1,'t','t')",
    )
    .run();
  return { store, router: new ModelRouter(store, { commercialMeter: meter(entries), fetcher }) };
}

test("router records final structured LLM usage, including corrective calls", async () => {
  const entries: MeterEntry[] = [];
  let calls = 0;
  const { store, router: client } = router(
    entries,
    (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: ++calls === 1 ? "bad-json" : '{"ok":true}' } }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
      )) as typeof fetch,
  );
  try {
    assert.deepEqual(
      (await client.client("card_tidy").json([{ role: "user", content: "x" }], PING)).data,
      { ok: true },
    );
    assert.equal(calls, 2);
    assert.ok(entries[0]!.info.upperUsage!.inputTokens! >= 14);
    assert.ok(entries[0]!.info.upperUsage!.outputTokens! >= 6);
    assert.deepEqual(entries.map(({ info, ...entry }) => {
      const { upperUsage: _upper, riskUsage: _risk, ...identity } = info;
      return { ...entry, info: identity };
    }), [
      {
        info: { kind: "llm", provider: "provider.test", model: "meter-model", source: "card_tidy" },
        usage: {
          inputTokens: 14,
          cachedInputTokens: undefined,
          outputTokens: 6,
          requests: 2,
          estimated: undefined,
        },
      },
    ]);
  } finally {
    store.close();
  }
});

test("Jev only marks a real, parsed response as one successful request", async () => {
  const entries: MeterEntry[] = [];
  const bad = new Jev(
    { apiKey: "key", timeoutMs: 1000, commercialMeter: meter(entries) },
    (async () => new Response("not-json")) as typeof fetch,
  );
  await assert.rejects(bad.noul({}, "?"), (error: unknown) => {
    assert.ok(error instanceof JevError);
    assert.equal(error.code, "JEV_BAD_OUTPUT");
    return true;
  });
  assert.deepEqual(entries, [
    { info: { kind: "jev", provider: "api.typesafe.ai", model: "jev-1.13.0", source: "jev" }, failed: true },
  ]);

  const fallbackEntries: MeterEntry[] = [];
  const fallback = new Jev(
    {
      apiKey: "key",
      timeoutMs: 1000,
      commercialMeter: meter(fallbackEntries),
      fallback: async () => ({ answers: { q: { noul: 0.5 } } }),
    },
    (async () => new Response("busy", { status: 503 })) as typeof fetch,
    async () => {},
  );
  assert.equal(await fallback.noul({}, "?"), 0.5);
  assert.deepEqual(fallbackEntries, [
    { info: { kind: "jev", provider: "api.typesafe.ai", model: "jev-1.13.0", source: "jev" }, failed: true },
  ]);
});

test("Tencent OCR records one request only after a valid response", async () => {
  const entries: MeterEntry[] = [];
  const invalid = new TencentOcr(
    {
      secretId: "id",
      secretKey: "key",
      timeoutMs: 1000,
      commercialMeter: meter(entries),
    },
    (async () => new Response("not-json")) as typeof fetch,
  );
  await assert.rejects(invalid.recognize(Buffer.from("image")));
  assert.equal(entries[0]!.failed, true);

  const valid = new TencentOcr(
    {
      secretId: "id",
      secretKey: "key",
      timeoutMs: 1000,
      commercialMeter: meter(entries),
    },
    (async () =>
      new Response('{"Response":{"RequestId":"req","TextDetections":[]}}')) as typeof fetch,
  );
  await valid.recognize(Buffer.from("image"));
  assert.deepEqual(entries[1], {
    info: {
      kind: "ocr",
      provider: "ocr.tencentcloudapi.com",
      model: "GeneralBasicOCR",
      source: "ocr.tencent",
    },
    usage: { requests: 1 },
  });
});
