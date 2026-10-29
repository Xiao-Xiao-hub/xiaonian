import assert from "node:assert/strict";
import test from "node:test";
import { z } from "../server/node_modules/zod/index.js";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { checkInputComplexity, rejectionEvent } from "../server/src/shared/request-safety.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { JobRunner } from "../server/src/modules/jobs/runner.js";
import { writeSse } from "../server/src/modules/chat/routes.js";
import Fastify from "../server/node_modules/fastify/fastify.js";
import { registerChatRoutes } from "../server/src/modules/chat/routes.js";

test("oversized collections are rejected before Zod visits any item, within the existing body limit", async () => {
  const app = buildApp({ env: loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_PATH: ":memory:" }) });
  let visits = 0;
  app.post("/security-validation-probe", async (req) => {
    z.object({ rows: z.array(z.preprocess((value) => { visits++; return value; }, z.string())).max(3) }).parse(req.body);
    return {};
  });
  try {
    const payload = JSON.stringify({ rows: Array(85000).fill(0) });
    assert.ok(Buffer.byteLength(payload) < 262144);
    const response = await app.inject({ method: "POST", url: "/security-validation-probe", headers: { "content-type": "application/json" }, payload });
    assert.equal(response.statusCode, 413, response.body);
    assert.equal(response.json().code, "INPUT_COMPLEXITY_LIMIT");
    assert.equal(visits, 0);
    const tooManyKeys = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [String(i), "value"]));
    const objectResponse = await app.inject({ method: "POST", url: "/security-validation-probe", payload: tooManyKeys });
    assert.equal(objectResponse.statusCode, 413);
    assert.equal(visits, 0);
    assert.equal((await app.inject({ url: "/health/live" })).statusCode, 200);
  } finally { await app.close(); }
});

test("JSON complexity bounds nesting and aggregate nodes but admits the largest legitimate segment edit", () => {
  assert.doesNotThrow(() => checkInputComplexity({ segments: Array.from({ length: 500 }, (_, i) => ({ text: "content", from: i + 1 })) }));
  assert.throws(() => checkInputComplexity(Array.from({ length: 5 }, () => Array(900).fill(0))), { code: "INPUT_COMPLEXITY_LIMIT" });
  let nested: unknown = 1;
  for (let depth = 0; depth < 22; depth++) nested = { child: nested };
  assert.throws(() => checkInputComplexity(nested), { code: "INPUT_COMPLEXITY_LIMIT" });
});

test("multipart admission rejects a user's third upload and releases slots when response sockets close", async () => {
  const app = buildApp({ env: loadEnv({ NODE_ENV: "test", DEV_LOGIN_ENABLED: "true", LOG_LEVEL: "silent", DATABASE_PATH: ":memory:" }) });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const responses: { emit(event: string): boolean }[] = [];
  app.post("/security-upload-probe", async (_req, reply) => {
    responses.push(reply.raw);
    await held;
    return { ok: true };
  });
  const login = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "upload-probe", nickname: "Upload probe" } });
  const token = login.json().data.token;
  const upload = () => app.inject({ method: "POST", url: "/security-upload-probe",
    headers: { authorization: `Bearer ${token}`, "content-type": "multipart/form-data; boundary=probe" }, payload: "--probe--\r\n" });
  try {
    const requests = Array.from({ length: 2 }, () => upload().then((response) => response.statusCode,
      (error: { code?: string }) => { assert.equal(error.code, "LIGHT_ECONNRESET"); return 0; }));
    while (responses.length < 2) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await upload()).statusCode, 429);
    // A complete request can lose its response connection without req.aborted.
    responses[0]!.emit("close");
    const replacement = upload().then((response) => response.statusCode);
    while (responses.length < 3) await new Promise((resolve) => setImmediate(resolve));
    release();
    assert.equal(await replacement, 200);
    await Promise.all(requests);
  } finally { release(); await app.close(); }
});

test("queue bounds apply atomically to distinct jobs, while duplicate work can still be read", async () => {
  const store = new SqliteStore(":memory:");
  const owner = store.upsertUser("dev:queue-one", "one", "dev").id;
  const other = store.upsertUser("dev:queue-two", "two", "dev").id;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const runner = new JobRunner(store, { held: { run: async () => { await wait; return { output: null }; } } }, {
    concurrency: 1, timeoutMs: 5000, limits: {}, queueLimit: 3, userQueueLimit: 2,
  });
  try {
    const first = runner.enqueue({ userId: owner, kind: "held", params: { n: 1 } }).job;
    runner.enqueue({ userId: owner, kind: "held", params: { n: 2 } });
    assert.throws(() => runner.enqueue({ userId: owner, kind: "held", params: { n: 3 } }), { code: "JOB_QUEUE_FULL" });
    assert.equal(runner.enqueue({ userId: owner, kind: "held", params: { n: 1 } }).job.id, first.id);
    runner.enqueue({ userId: other, kind: "held", params: { n: 4 } });
    assert.throws(() => runner.enqueue({ userId: other, kind: "held", params: { n: 5 } }), { code: "JOB_QUEUE_FULL" });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()!.n, 3);
    release();
    await runner.idle();
    assert.doesNotThrow(() => runner.enqueue({ userId: owner, kind: "held", params: { n: 6 } }));
    await runner.idle();
  } finally { release(); await runner.stop(); store.close(); }
});

test("SSE stops buffering when a slow reader reaches the byte cap", () => {
  let writes = 0, destroyed = 0;
  const raw = { writableLength: 262140, write: () => { writes++; return true; }, destroy: () => { destroyed++; return raw; } };
  assert.equal(writeSse(raw as never, "12345"), false);
  assert.equal(writes, 0);
  assert.equal(destroyed, 1);
  raw.writableLength = 0;
  assert.equal(writeSse(raw as never, "data: ok\n\n"), true);
  assert.equal(writes, 1);
});

test("SSE admission bounds simultaneous work per user and releases slots on completion", async () => {
  const app = Fastify();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started = 0;
  registerChatRoutes(app, {
    auth: { require: () => ({ id: "synthetic-user" }) } as never,
    chat: { send: async () => { started++; await held; }, finishSendBilling() {} } as never,
  });
  const send = (i: number) => app.inject({ method: "POST", url: "/v1/chat/send", payload: { text: "hello", clientId: `request_${i}` } });
  try {
    const first = send(1).then((response) => response.statusCode);
    const second = send(2).then((response) => response.statusCode);
    while (started < 2) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await send(3)).statusCode, 429);
    release();
    await Promise.all([first, second]);
    assert.equal((await send(4)).statusCode, 200);
  } finally { release(); await app.close(); }
});

test("validation diagnostics omit values, unknown field names and internal paths", async (t) => {
  const app = buildApp({ env: loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_PATH: ":memory:" }) });
  const records: unknown[] = [];
  t.mock.method(app.log, "warn", (...args: unknown[]) => { records.push(args); });
  app.addHook("onRequest", async (req) => { req.log = app.log; });
  try {
    const response = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: {
      key: "synthetic private text", "synthetic-secret-field": "private-secret",
    } });
    assert.equal(response.statusCode, 400);
    const output = JSON.stringify(records) + response.body;
    assert.match(output, /validation_rejected/);
    assert.doesNotMatch(output, /synthetic-private|synthetic-secret|private-secret|\/srv\/|stack/);
  } finally { await app.close(); }
});

test("rejection events are fixed names and do not use submitted values", () => {
  assert.equal(rejectionEvent(403, "CALLBACK_SIGNATURE_INVALID", "/v1/commercial/wechat/callback"), "payment_signature_failed");
  assert.equal(rejectionEvent(401, "UNAUTHORIZED", "/v1/auth/wechat-login"), "login_failed");
  assert.equal(rejectionEvent(404, "NOT_FOUND", "/v1/cards/:id"), undefined);
  assert.equal(rejectionEvent(403, "FORBIDDEN", "/v1/cards/:id"), "authorization_denied");
  assert.equal(rejectionEvent(429, "DAILY_LIMIT", "/v1/chat/send"), "rate_limited");
  assert.equal(rejectionEvent(413, "INPUT_COMPLEXITY_LIMIT", "/v1/cards"), "parse_rejected");
  assert.equal(rejectionEvent(408, "PARSE_TIMEOUT", "/v1/imports/file"), "parse_timeout");
  assert.equal(rejectionEvent(400, "VALIDATION_ERROR", "/v1/cards"), undefined);
});
