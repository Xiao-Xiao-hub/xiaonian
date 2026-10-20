import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";
import {
  UsageLedger,
  type UsageMeter,
} from "../server/src/shared/usage-ledger.js";
import { ChatModel } from "../server/src/providers/llm.js";
import { Jev } from "../server/src/providers/jev.js";
import { TencentOcr } from "../server/src/providers/tencent-ocr.js";
import { chinaDate, chinaDayStart } from "../server/src/shared/time.js";

const { z } = createRequire(new URL("../server/package.json", import.meta.url))(
  "zod",
) as typeof import("zod");

const rows = (store: SqliteStore) =>
  store.db.prepare("SELECT * FROM usage_ledger ORDER BY id").all();
const llm = (
  usageMeter: UsageMeter,
  fetcher: typeof fetch,
  apiKey = "synthetic-key",
) =>
  new ChatModel(
    {
      baseUrl: "https://synthetic.invalid/v1",
      apiKey,
      model: "synthetic-model",
      extraBody: {},
      timeoutMs: 5000,
      usageMeter,
    },
    fetcher,
  );
const reply = (content: string, prompt: number | null = 3, completion = 2) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      ...(prompt === null
        ? {}
        : { usage: { prompt_tokens: prompt, completion_tokens: completion } }),
    }),
  );
const input = [
  { role: "user" as const, content: "private synthetic learner words" },
];

test("ledger stores canonical scene and reported cache tokens without inventing missing counts", () => {
  const store = new SqliteStore(":memory:");
  try {
    const ledger = new UsageLedger(store);
    for (const value of [0, 4, undefined, -1, 1.5]) ledger.start({
      source: "llm.json", provider: "synthetic", model: "synthetic", scene: "card_tidy",
    })({ status: "succeeded", cachedTokens: value });
    const saved = rows(store);
    assert.deepEqual(saved.map((row) => row.cached_tokens), [0, 4, null, null, null]);
    assert.ok(saved.every((row) => row.scene === "card_tidy"));
  } finally { store.close(); }
});

test("anonymous ledger preserves usage after learner deletion and recovers interrupted attempts", () => {
  const store = new SqliteStore(":memory:");
  try {
    const meter = new UsageLedger(store);
    const user = store.upsertUser("private-openid", "private-name", "dev");
    const finish = meter.start({
      source: "llm.json",
      provider: "synthetic.invalid",
      model: "test",
    });
    finish({ status: "succeeded", promptTokens: 0, completionTokens: 0 });
    finish({ status: "failed", promptTokens: 100 }); // never double commit
    meter.start({
      source: "jev",
      provider: "synthetic.invalid",
      model: "test",
    });
    store.db.prepare("DELETE FROM users WHERE id=?").run(user.id);
    new UsageLedger(store);
    const saved = rows(store);
    assert.equal(saved.length, 2);
    assert.equal(saved[0]!.status, "succeeded");
    assert.equal(saved[0]!.prompt_tokens, 0);
    assert.equal(saved[1]!.status, "unknown");
    assert.equal(saved[1]!.prompt_tokens, null);
    assert.equal(saved[1]!.finished_at, null);
    assert.deepEqual(Object.keys(saved[0]!), [
      "id",
      "source",
      "provider",
      "model",
      "status",
      "prompt_tokens",
      "completion_tokens",
      "duration_ms",
      "created_at",
      "finished_at",
      "endpoint",
      "scene",
      "cached_tokens",
    ]);
    assert.ok(!JSON.stringify(saved).includes("private"));
    assert.equal(
      store.db.prepare("PRAGMA foreign_key_list(usage_ledger)").all().length,
      0,
    );
  } finally {
    store.close();
  }
});

test("LLM corrective retries record each provider attempt exactly once without prompt or credentials", async () => {
  const store = new SqliteStore(":memory:");
  try {
    let calls = 0;
    const model = llm(new UsageLedger(store), (async () =>
      reply(++calls === 1 ? "bad-json" : '{"ok":true}')) as typeof fetch);
    await model.json(input, z.object({ ok: z.boolean() }));
    const saved = rows(store);
    assert.equal(saved.length, 2);
    assert.deepEqual(
      saved.map((row) => [
        row.source,
        row.status,
        row.prompt_tokens,
        row.completion_tokens,
      ]),
      [
        ["llm.json", "succeeded", 3, 2],
        ["llm.json", "succeeded", 3, 2],
      ],
    );
    assert.ok(!JSON.stringify(saved).includes(input[0]!.content));
    assert.ok(!JSON.stringify(saved).includes("synthetic-key"));
  } finally {
    store.close();
  }
});

test("unconfigured and already cancelled calls do not enter the ledger, absent tokens remain null", async () => {
  const store = new SqliteStore(":memory:");
  try {
    let calls = 0;
    const meter = new UsageLedger(store);
    const fetcher = (async () => {
      calls++;
      return reply('{"ok":true}', null);
    }) as typeof fetch;
    await assert.rejects(
      llm(meter, fetcher, "").json(input, z.object({ ok: z.boolean() })),
    );
    await assert.rejects(
      llm(meter, fetcher).json(
        input,
        z.object({ ok: z.boolean() }),
        AbortSignal.abort(),
      ),
    );
    assert.equal(calls, 0);
    assert.equal(rows(store).length, 0);
    await llm(meter, fetcher).json(input, z.object({ ok: z.boolean() }));
    assert.equal(rows(store)[0]!.prompt_tokens, null);
    assert.equal(rows(store)[0]!.completion_tokens, null);
  } finally {
    store.close();
  }
});

test("stream usage reports explicit zeros and marks interrupted responses unknown", async () => {
  const store = new SqliteStore(":memory:");
  try {
    const meter = new UsageLedger(store);
    const good = llm(
      meter,
      (async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\ndata: [DONE]\n\n',
        )) as typeof fetch,
    );
    await good.stream(input, { onText() {} });
    const broken = llm(
      meter,
      (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("synthetic interrupted connection"));
            },
          }),
        )) as typeof fetch,
    );
    await assert.rejects(broken.stream(input, { onText() {} }));
    const saved = rows(store);
    assert.equal(saved[0]!.status, "succeeded");
    assert.equal(saved[0]!.prompt_tokens, 0);
    assert.equal(saved[1]!.status, "unknown");
    assert.equal(saved[1]!.prompt_tokens, null);
  } finally {
    store.close();
  }
});

test("Jev retries and Tencent OCR attempts are accounted without inventing token counts", async () => {
  const store = new SqliteStore(":memory:");
  try {
    const usageMeter = new UsageLedger(store);
    let calls = 0;
    const jev = new Jev(
      { apiKey: "synthetic-key", timeoutMs: 1000, usageMeter },
      (async () =>
        ++calls === 1
          ? new Response("busy", { status: 429 })
          : new Response('{"answers":{"q":{"noul":0.5}}}')) as typeof fetch,
      async () => {},
    );
    await jev.noul({ private: "answer" }, "private question");
    const ocr = new TencentOcr(
      {
        secretId: "test-id",
        secretKey: "test-key",
        timeoutMs: 1000,
        usageMeter,
      },
      (async () =>
        new Response(
          '{"Response":{"RequestId":"private-request","TextDetections":[]}}',
        )) as typeof fetch,
    );
    await ocr.recognize(Buffer.from("private-image"));
    assert.deepEqual(
      rows(store).map((row) => [row.source, row.status, row.prompt_tokens]),
      [
        ["jev", "failed", null],
        ["jev", "succeeded", null],
        ["ocr.tencent", "succeeded", null],
      ],
    );
    assert.ok(!JSON.stringify(rows(store)).includes("private"));
  } finally {
    store.close();
  }
});

test("recording failures prevent outbound calls instead of silently losing accounting", async () => {
  let sent = 0;
  const usageMeter: UsageMeter = {
    start() {
      throw new Error("synthetic storage unavailable");
    },
  };
  const fetcher = (async () => {
    sent++;
    return reply('{"ok":true}');
  }) as typeof fetch;
  await assert.rejects(
    llm(usageMeter, fetcher).json(input, z.object({ ok: z.boolean() })),
  );
  await assert.rejects(llm(usageMeter, fetcher).stream(input, { onText() {} }));
  await assert.rejects(
    new Jev({ apiKey: "test", timeoutMs: 1000, usageMeter }, fetcher).noul(
      {},
      "test",
    ),
  );
  await assert.rejects(
    new TencentOcr(
      { secretId: "id", secretKey: "key", timeoutMs: 1000, usageMeter },
      fetcher,
    ).recognize(Buffer.from("test")),
  );
  assert.equal(sent, 0);
});

test("completion persistence failure preserves the pending receipt and does not replace a successful provider result", async () => {
  const store = new SqliteStore(":memory:");
  try {
    const meter = new UsageLedger(store);
    store.db.exec(
      "CREATE TRIGGER synthetic_ledger_failure BEFORE UPDATE ON usage_ledger BEGIN SELECT RAISE(FAIL,'synthetic'); END",
    );
    const model = llm(meter, (async () =>
      reply('{"ok":true}')) as typeof fetch);
    assert.equal(
      (await model.json(input, z.object({ ok: z.boolean() }))).data.ok,
      true,
    );
    assert.equal(rows(store).length, 1);
    assert.equal(rows(store)[0]!.status, "pending");
    assert.equal(rows(store)[0]!.prompt_tokens, null);
    assert.equal(meter.accountingWriteFailures, 1);
    store.db.exec("DROP TRIGGER synthetic_ledger_failure");
    new UsageLedger(store);
    assert.equal(rows(store)[0]!.status, "unknown");
  } finally {
    store.close();
  }
});

test("admin ledger uses China days, distinguishes history from current totals, and cannot imply a bill", async () => {
  const store = new SqliteStore(":memory:");
  const key = "a".repeat(40);
  const app = buildApp({
    store,
    env: loadEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_PATH: ":memory:",
      ADMIN_API_KEY: key,
      UPLOAD_DIR: "nonexistent-synthetic-uploads",
    }),
  });
  try {
    const insert = store.db.prepare(
      "INSERT INTO usage_ledger(source,provider,model,status,prompt_tokens,completion_tokens,created_at) VALUES('llm.json','synthetic.invalid','test',?,?,?,?)",
    );
    const start = Date.parse(chinaDayStart());
    insert.run("succeeded", 10, 20, new Date(start).toISOString());
    insert.run("unknown", null, null, new Date(start - 1).toISOString());
    insert.run(
      "succeeded",
      100,
      200,
      new Date(start - 7 * 86400000).toISOString(),
    );
    assert.equal(
      (await app.inject({ url: "/v1/admin/usage" })).statusCode,
      401,
    );
    const res = await app.inject({
      url: "/v1/admin/usage",
      headers: { "x-admin-key": key },
    });
    assert.equal(res.statusCode, 200, res.body);
    const { data } = res.json();
    assert.equal(data.ledger.period, "today");
    assert.equal(data.ledger.timezone, "Asia/Shanghai");
    assert.equal(data.ledger.totals.calls, 1);
    assert.equal(data.ledger.totals.promptTokens, 10);
    assert.equal(data.ledger.totals.unreported, 0);
    assert.equal(data.ledger.cumulative.calls, 3);
    assert.equal(data.ledger.cumulative.unreported, 1);
    assert.equal(data.ledger.trend.length, 7);
    assert.equal(data.ledger.trend.at(-1).date, chinaDate());
    assert.equal(data.ledger.trend.at(-2).unknown, 1);
    assert.equal(
      data.ledger.trend.reduce(
        (sum: number, day: { calls: number }) => sum + day.calls,
        0,
      ),
      2,
    );
    assert.equal(data.ledger.providers.length, 1);
    assert.equal(data.cost.amount, null);
    assert.equal(data.cost.status, "unavailable");
    assert.equal(data.coverage.scope, "anonymous-ledger");
    assert.ok(data.ledger.startedAt);
  } finally {
    await app.close();
  }
});
