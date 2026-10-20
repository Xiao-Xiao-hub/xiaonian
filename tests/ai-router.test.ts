import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { ProviderError } from "../server/src/providers/llm.js";
import {
  ModelRouter,
  PING as OK,
  thinkingBody,
} from "../server/src/providers/model-router.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { UsageLedger } from "../server/src/shared/usage-ledger.js";

// Failover against a real local OpenAI-compatible HTTP server : each
// endpoint is a path prefix on it, so the test sees which one was hit.
type Reply = (res: ServerResponse) => void;
async function fakeProvider(replies: Record<string, Reply>) {
  const hits: Record<string, Record<string, unknown>[]> = {};
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const name = String(req.url).split("/")[1]!;
      (hits[name] ??= []).push(JSON.parse(raw));
      replies[name]!(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: (name: string) => `http://127.0.0.1:${port}/${name}`,
    hits: (name: string) => hits[name]?.length ?? 0,
    bodies: (name: string) => hits[name] ?? [],
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
// A port nothing listens on: the connection is refused.
async function closedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/gone`;
}
const json: Reply = (res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ message: { content: '{"ok": true}' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }),
  );
};
const sse = (piece: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`;
const stream: Reply = (res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`${sse("你好")}${sse("，同学")}data: [DONE]\n\n`);
};
const status =
  (code: number, body = '{"error":{"message":"nope"}}'): Reply =>
  (res) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(body);
  };
// Two pieces arrive, then the connection drops: the call may be billed.
const broken: Reply = (res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(sse("前半"));
  res.write(sse("句"));
  setTimeout(() => res.socket?.destroy(), 30);
};
const ask = [{ role: "user" as const, content: "ping" }];

function setup() {
  const store = new SqliteStore(":memory:");
  let clock = Date.parse("2026-10-08T08:00:00Z");
  const router = new ModelRouter(store, {
    usageMeter: new UsageLedger(store),
    now: () => clock,
  });
  let position = 0;
  const add = (
    alias: string,
    baseUrl: string,
    more: { vision?: boolean; format?: string; extra?: object; model?: string } = {},
  ) =>
    store.db
      .prepare(
        "INSERT INTO ai_endpoints(id,alias,base_url,api_key,model,vision,thinking_format,extra_body,timeout_ms,position,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,'t','t')",
      )
      .run(
        `aep_${alias}`,
        alias,
        baseUrl,
        `key-${alias}`,
        more.model ?? `model-${alias}`,
        more.vision ? 1 : 0,
        more.format ?? "none",
        JSON.stringify(more.extra ?? {}),
        10000,
        position++,
      );
  return {
    store,
    router,
    add,
    advance: (ms: number) => (clock += ms),
  };
}

test("AI router: no credit, rate limits, bad keys, 5xx and refused connections move to the next endpoint", async () => {
  const cases: [string, Reply | null][] = [
    ["429", status(429)],
    ["402", status(402)],
    ["balance in body", status(400, '{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}')],
    ["insufficient_quota", status(429, '{"error":{"type":"insufficient_quota"}}')],
    ["401", status(401)],
    ["503", status(503)],
    ["refused", null],
  ];
  for (const [label, reply] of cases) {
    const fake = await fakeProvider({ a: reply ?? json, b: json });
    const { router, add, store } = setup();
    add("A", reply ? fake.base("a") : await closedPort());
    add("B", fake.base("b"));
    const { data, usage } = await router.client("ask").json(ask, OK);
    assert.deepEqual(data, { ok: true }, label);
    assert.equal(usage.model, "model-B", label);
    assert.equal(fake.hits("b"), 1, label);
    if (reply) assert.equal(fake.hits("a"), 1, label);
    // The ledger names the endpoint of every attempt.
    const rows = store.db
      .prepare("SELECT endpoint,status FROM usage_ledger ORDER BY id")
      .all()
      .map((r) => `${r.endpoint}:${r.status}`);
    assert.equal(rows.at(-1), "B:succeeded", label);
    assert.ok(rows.slice(0, -1).every((r) => r === "A:failed"), label);
    await fake.close();
  }
});

test("AI router: streaming switches before the first piece, never after", async () => {
  const fake = await fakeProvider({ a: status(429), b: stream, c: broken });
  const before = setup();
  before.add("A", fake.base("a"));
  before.add("B", fake.base("b"));
  const pieces: string[] = [];
  const done = await before.router
    .client("ask")
    .stream(ask, { onText: (p) => pieces.push(p) });
  assert.equal(done.text, "你好，同学");
  assert.deepEqual(pieces, ["你好", "，同学"]);

  const after = setup();
  after.add("C", fake.base("c"));
  after.add("B", fake.base("b"));
  const shown: string[] = [];
  await assert.rejects(
    after.router.client("ask").stream(ask, { onText: (p) => shown.push(p) }),
    (error: ProviderError) =>
      error.code === "AI_UNAVAILABLE" && error.billing === "unknown",
  );
  assert.deepEqual(shown, ["前半", "句"]);
  assert.equal(fake.hits("b"), 1, "B served only the first conversation");
  await fake.close();
});

test("AI router: unusable output, quota everywhere and no endpoints", async () => {
  const fake = await fakeProvider({
    bad: (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "不是 JSON" } }] }));
    },
    b: json,
    poor: status(402),
  });
  // A model that answered, badly, may have billed: no second endpoint.
  const bad = setup();
  bad.add("BAD", fake.base("bad"));
  bad.add("B", fake.base("b"));
  await assert.rejects(bad.router.client("ask").json(ask, OK), {
    code: "AI_BAD_OUTPUT",
  });
  assert.equal(fake.hits("bad"), 2, "one corrective retry on the same endpoint");
  assert.equal(fake.hits("b"), 0);
  // Out of credit everywhere reads as the long-standing "unavailable".
  const poor = setup();
  poor.add("P", fake.base("poor"));
  await assert.rejects(poor.router.client("ask").json(ask, OK), {
    code: "AI_UNAVAILABLE",
    billing: "none",
  });
  const none = setup();
  assert.equal(none.router.client("ask").configured, false);
  await assert.rejects(none.router.client("ask").json(ask, OK), {
    code: "AI_NOT_CONFIGURED",
  });
  await fake.close();
});

test("AI router: a failed endpoint cools down, is still a last resort, and returns after the cooldown", async () => {
  let aDown = true;
  const fake = await fakeProvider({
    a: (res) => (aDown ? status(503)(res) : json(res)),
    b: json,
  });
  const { router, add, advance } = setup();
  add("A", fake.base("a"));
  add("B", fake.base("b"));
  const client = router.client("ask");
  await client.json(ask, OK);
  assert.deepEqual([fake.hits("a"), fake.hits("b")], [1, 1]);
  await client.json(ask, OK);
  assert.deepEqual([fake.hits("a"), fake.hits("b")], [1, 2], "A skipped while cooling");
  assert.ok(router.healthOf("aep_A").coolingUntil);
  assert.equal(router.healthOf("aep_A").lastError?.code, "AI_UNAVAILABLE");
  advance(61_000);
  aDown = false;
  const back = await client.json(ask, OK);
  assert.equal(back.usage.model, "model-A");
  assert.equal(router.healthOf("aep_A").coolingUntil, null);
  await fake.close();

  // Every endpoint cooling: still tried in order instead of refusing.
  const down = await fakeProvider({ x: status(503), y: status(503) });
  const all = setup();
  all.add("X", down.base("x"));
  all.add("Y", down.base("y"));
  await assert.rejects(all.router.client("ask").json(ask, OK));
  await assert.rejects(all.router.client("ask").json(ask, OK), {
    code: "AI_UNAVAILABLE",
  });
  assert.deepEqual([down.hits("x"), down.hits("y")], [2, 2]);
  await down.close();
});

test("AI router: photos and image messages go only to image-capable endpoints", async () => {
  const fake = await fakeProvider({ text: json, eye: json });
  const { router, add } = setup();
  add("TEXT", fake.base("text"));
  assert.equal(router.client("photo").configured, false);
  add("EYE", fake.base("eye"), { vision: true });
  assert.equal(router.client("photo").configured, true);
  await router.client("photo").json(ask, OK);
  const image = [
    {
      role: "user" as const,
      content: [
        { type: "image_url" as const, image_url: { url: "data:image/png;base64,AA" } },
        { type: "text" as const, text: "读一下" },
      ],
    },
  ];
  await router.client("ask").json(image, OK);
  await router.client("ask").json(ask, OK);
  assert.deepEqual([fake.hits("text"), fake.hits("eye")], [1, 2]);
  await fake.close();
});

test("AI router: thinking levels per scenario in each provider's format", async () => {
  assert.deepEqual(thinkingBody("none", "high"), {});
  assert.deepEqual(thinkingBody("reasoning_effort", "off"), {});
  assert.deepEqual(thinkingBody("reasoning_effort", "low"), { reasoning_effort: "low" });
  assert.deepEqual(thinkingBody("reasoning_effort", "max"), { reasoning_effort: "max" });
  assert.deepEqual(thinkingBody("thinking_type", "off"), { thinking: { type: "disabled" } });
  assert.deepEqual(thinkingBody("thinking_type", "medium"), { thinking: { type: "enabled" } });
  assert.deepEqual(thinkingBody("enable_thinking", "off"), { enable_thinking: false });
  assert.deepEqual(thinkingBody("enable_thinking", "high"), {
    enable_thinking: true,
    thinking_budget: 16384,
  });
  const fake = await fakeProvider({ glm: json, qwen: json, oa: json });
  const { router, add, store } = setup();
  add("GLM", fake.base("glm"), {
    format: "thinking_type",
    extra: { temperature: 0.1, reasoning_effort: "no_think" },
    model: "glm-5.3-flash",
  });
  await router.client("ask").json(ask, OK);
  await router.client("ask").json(ask, OK, undefined, { scenario: "recheck" });
  assert.deepEqual(
    fake.bodies("glm").map((b) => [b.thinking, b.reasoning_effort, b.temperature]),
    [
      [{ type: "enabled" }, "low", 0.1],
      [{ type: "enabled" }, "high", 0.1],
    ],
  );
  store.db.prepare("DELETE FROM ai_endpoints").run();
  add("QWEN", fake.base("qwen"), { format: "enable_thinking" });
  add("OA", fake.base("oa"), { format: "reasoning_effort", extra: { reasoning_effort: "no_think" } });
  store.db
    .prepare("INSERT INTO settings VALUES('ai.thinking',?,'t')")
    .run(JSON.stringify({ notes: "low", ask: "bogus" }));
  assert.equal(router.thinking()["chat.study"], "low", "unknown values fall back");
  assert.equal(router.thinking().card_tidy, "low", "legacy notes setting is read");
  await router.client("notes").json(ask, OK);
  assert.deepEqual(
    [fake.bodies("qwen")[0]!.enable_thinking, fake.bodies("qwen")[0]!.thinking_budget],
    [true, 1024],
  );
  await router.test(router.endpoints()[1]!, "off");
  await router.test(router.endpoints()[1]!, "medium");
  assert.deepEqual(
    fake.bodies("oa").map((b) => b.reasoning_effort),
    ["no_think", "medium"],
  );
  await fake.close();
});

test("AI router: a configured route limits candidates, and an empty route uses the global order", async () => {
  const fake = await fakeProvider({ a: json, b: json });
  const { router, add, store } = setup();
  add("A", fake.base("a"));
  add("B", fake.base("b"));
  store.db
    .prepare("INSERT INTO settings VALUES('ai.routes',?,'t')")
    .run(JSON.stringify({ "chat.study": ["aep_B"] }));
  await router.client("ask").json(ask, OK);
  assert.deepEqual([fake.hits("a"), fake.hits("b")], [0, 1]);
  store.db
    .prepare("UPDATE settings SET value=? WHERE key='ai.routes'")
    .run(JSON.stringify({ "chat.study": [] }));
  await router.client("ask").json(ask, OK);
  assert.deepEqual([fake.hits("a"), fake.hits("b")], [1, 1]);
  await fake.close();
});

test("AI router: normalized scenes reach usage and map_stuck does not retry JSON", async () => {
  const fake = await fakeProvider({
    bad: (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "not JSON" } }] }));
    },
  });
  const { router, add } = setup();
  add("BAD", fake.base("bad"));
  await assert.rejects(router.client("ask").json(ask, OK), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "AI_BAD_OUTPUT");
    assert.equal(
      (error as { usage?: { scene?: string } }).usage?.scene,
      "chat.study",
    );
    return true;
  });
  assert.equal(fake.hits("bad"), 2, "normal JSON retries once");
  await assert.rejects(
    router.client("ask").json(ask, OK, undefined, { scenario: "map_stuck" }),
    { code: "AI_BAD_OUTPUT" },
  );
  assert.equal(fake.hits("bad"), 3, "map_stuck does not retry JSON");
  await fake.close();
});

const KEY = "synthetic-admin-key-for-isolated-tests-01";
function app(store: SqliteStore, env: Record<string, string> = {}) {
  return buildApp({
    store,
    env: loadEnv({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "ai-router-")),
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "ai-router-f-")),
      LOG_LEVEL: "silent",
      ADMIN_API_KEY: KEY,
      ...env,
    }),
  });
}

test("AI endpoints are seeded once from the environment", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ai-seed-")), "app.sqlite");
  const env = {
    LLM_BASE_URL: "https://open.bigmodel.cn/api/paas/v4",
    LLM_API_KEY: "seed-secret-0001",
    LLM_MODEL: "glm-5.3",
    LLM_EXTRA_BODY: '{"thinking":{"type":"disabled"}}',
    OCR_VISION_MODEL: "glm-5v",
  };
  // Each start opens the same database file, as a restart would.
  const start = () => app(new SqliteStore(path), env);
  const endpoints = async (server: ReturnType<typeof app>) => {
    const res = await server.inject({ url: "/v1/admin/ai", headers: { "x-admin-key": KEY } });
    return res.json().data.endpoints as { alias: string; model: string; vision: boolean; thinkingFormat: string; position: number; extraBody: object; id: string }[];
  };
  let server = start();
  const seeded = await endpoints(server);
  assert.deepEqual(
    seeded.map((e) => [e.alias, e.model, e.vision, e.thinkingFormat, e.position]),
    [
      ["默认", "glm-5.3", false, "thinking_type", 0],
      ["识图", "glm-5v", true, "thinking_type", 1],
    ],
  );
  assert.deepEqual(seeded[0]!.extraBody, { thinking: { type: "disabled" } });
  await server.close();
  server = start();
  assert.equal((await endpoints(server)).length, 2, "not seeded twice");
  for (const e of seeded)
    await server.inject({ method: "DELETE", url: `/v1/admin/ai/endpoints/${e.id}`, headers: { "x-admin-key": KEY } });
  await server.close();
  server = start();
  assert.equal((await endpoints(server)).length, 0, "deleted stays deleted");
  assert.equal((await server.inject({ url: "/v1/config" })).json().data.ai, false);
  await server.close();
});

test("admin manages AI endpoints without ever reading a key back", async (t) => {
  const fake = await fakeProvider({ live: json, dead: status(402) });
  const store = new SqliteStore(":memory:");
  const server = app(store);
  t.after(async () => {
    await server.close();
    await fake.close();
  });
  const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object, code = 200) => {
    const res = await server.inject({ method, url, payload, headers: { "x-admin-key": KEY } });
    assert.equal(res.statusCode, code, res.body);
    return res.json();
  };
  const secret = "synthetic-provider-key-ending-6789";
  let view = (await call("POST", "/v1/admin/ai/endpoints", {
    alias: "主力",
    baseUrl: fake.base("live"),
    apiKey: secret,
    model: "glm-5.3",
    thinkingFormat: "thinking_type",
  })).data;
  view = (await call("POST", "/v1/admin/ai/endpoints", {
    alias: "备用",
    baseUrl: fake.base("dead"),
    apiKey: "sk-spare-99998888",
    model: "qwen",
    vision: true,
  })).data;
  assert.deepEqual(view.endpoints.map((e: { alias: string }) => e.alias), ["主力", "备用"]);
  assert.equal(view.endpoints[0].keyHint, "…6789");
  assert.equal(view.thinking.recheck, "high");
  await call("POST", "/v1/admin/ai/endpoints", { alias: "主力", baseUrl: fake.base("x"), apiKey: "k", model: "m" }, 409);
  await call("POST", "/v1/admin/ai/endpoints", { alias: "坏", baseUrl: fake.base("x"), apiKey: "k", model: "m", extraBody: { model: "other" } }, 400);
  const [main, spare] = view.endpoints as { id: string }[];
  // An empty key keeps the stored one.
  await call("PUT", `/v1/admin/ai/endpoints/${main!.id}`, { apiKey: "", model: "glm-5.3-air" });
  const stored = store.db.prepare("SELECT api_key,model FROM ai_endpoints WHERE id=?").get(main!.id);
  assert.deepEqual({ ...stored }, { api_key: secret, model: "glm-5.3-air" });
  // Test calls hit only that endpoint and stay out of the usage figures.
  const good = (await call("POST", `/v1/admin/ai/endpoints/${main!.id}/test`, {})).data;
  assert.equal(good.result.ok, true);
  const bad = (await call("POST", `/v1/admin/ai/endpoints/${spare!.id}/test`, {})).data;
  assert.deepEqual([bad.result.ok, bad.result.code], [false, "AI_QUOTA"]);
  assert.ok(bad.endpoints[1].health.coolingUntil);
  assert.equal(bad.endpoints[0].last24h.calls, 0);
  assert.deepEqual(
    store.db.prepare("SELECT source,endpoint FROM usage_ledger ORDER BY id").all().map((r) => `${r.source}:${r.endpoint}`),
    ["llm.test:主力", "llm.test:备用"],
  );
  view = (await call("PUT", "/v1/admin/ai/order", { ids: [spare!.id, main!.id] })).data;
  assert.equal(view.endpoints[0].alias, "备用");
  await call("PUT", "/v1/admin/ai/order", { ids: [spare!.id] }, 409);
  view = (await call("PUT", "/v1/admin/ai/routes", { vision: [spare!.id] })).data;
  assert.deepEqual(view.routes, { vision: [spare!.id] });
  view = (await call("PUT", "/v1/admin/ai/routes", { "chat.study": [main!.id] })).data;
  assert.deepEqual(view.routes, { vision: [spare!.id], "chat.study": [main!.id] });
  assert.deepEqual(
    (await call("GET", "/v1/admin/ai/routes")).data.routes,
    { vision: [spare!.id], "chat.study": [main!.id] },
  );
  await call("PUT", "/v1/admin/ai/routes", { "chat.study": ["missing"] }, 400);
  await call("PUT", "/v1/admin/ai/routes", { ask: [main!.id] }, 400);
  view = (await call("PUT", "/v1/admin/ai/thinking", { "chat.study": "low" })).data;
  assert.equal(view.thinking["chat.study"], "low");
  assert.equal(view.thinking.recheck, "high");
  await call("PUT", "/v1/admin/ai/thinking", { "chat.study": "bogus" }, 400);
  await call("DELETE", `/v1/admin/ai/endpoints/${spare!.id}`);
  const all = JSON.stringify(await call("GET", "/v1/admin/ai"));
  assert.ok(!all.includes(secret) && !all.includes("sk-spare"), "keys never leave");
  const audits = store.db.prepare("SELECT action,details FROM audit WHERE action LIKE 'ai.%'").all();
  assert.deepEqual(
    audits.map((a) => a.action),
    [
      "ai.endpoint.created",
      "ai.endpoint.created",
      "ai.endpoint.updated",
      "ai.endpoint.tested",
      "ai.endpoint.tested",
      "ai.order.updated",
      "ai.routes.updated",
      "ai.routes.updated",
      "ai.thinking.updated",
      "ai.endpoint.deleted",
    ],
  );
  assert.ok(!JSON.stringify(audits).includes("sk-"), "audits hold no key");
  const learner = await server.inject({ url: "/v1/admin/ai" });
  assert.equal(learner.statusCode, 401);
});
