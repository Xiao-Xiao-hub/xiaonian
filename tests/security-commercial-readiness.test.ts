import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "../server/node_modules/fastify/fastify.js";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { registerCommercialAdminRoutes } from "../server/src/modules/commercial/admin-routes.js";
import { approvedCommercialCatalog } from "../server/src/modules/commercial/policy.js";
import { OCR_PRICE_MISSING } from "../server/src/modules/commercial/readiness.js";
import { CommercialMeter } from "../server/src/shared/commercial-meter.js";
import { COST_SAFETY_TOTALS } from "../server/src/shared/cost-safety.js";
import { chinaDayStart } from "../server/src/shared/time.js";

const HEALTH_NOTE = "只检查本地依赖；不代表微信登录或外部服务可用";
const ADMIN_KEY = "synthetic-round5-admin-key-0123456789";

for (const scenario of ["missing-price", "no-credentials", "partial-credentials", "billing-off", "priced-zero"] as const) {
  test(`OCR startup readiness: ${scenario} logs only an actionable configuration error and still starts`, async t => {
    const store = new SqliteStore(":memory:");
    store.saveSetting("commercial.enabled", scenario !== "billing-off");
    const prices = scenario === "priced-zero" ? { ocr: { microyuanPerRequest: 0 } } : { jev: { microyuanPerRequest: 0 } };
    store.saveSetting("commercial.prices", prices);
    const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_PATH: ":memory:",
      ...(scenario !== "no-credentials" ? { TENCENT_SECRET_ID: "synthetic-secret-id" } : {}),
      ...(!["no-credentials", "partial-credentials"].includes(scenario) ? { TENCENT_SECRET_KEY: "synthetic-secret-key" } : {}),
    });
    const app = buildApp({ env, store });
    t.after(() => app.close());
    const errors: unknown[][] = [];
    t.mock.method(app.log, "error", (...args: unknown[]) => { errors.push(args); });
    await app.ready();
    assert.equal((await app.inject("/health/live")).statusCode, 200);
    const readiness = (await app.inject("/health/ready")).json();
    assert.equal(readiness.status, "ready", "pricing warnings do not remove a healthy process from service");
    assert.equal(readiness.note, HEALTH_NOTE);
    assert.equal(errors.length, scenario === "missing-price" ? 1 : 0);
    if (errors.length) {
      assert.deepEqual(errors[0]![0], { event: "commercial_ocr_price_missing", setting: "commercial.prices.ocr" });
      assert.match(String(errors[0]![1]), /腾讯 OCR.*收费已开启.*缺少有效 OCR 单价/);
      assert.doesNotMatch(JSON.stringify(errors), /synthetic-secret/);
    }
    assert.deepEqual(store.setting("commercial.prices"), prices);
    if (scenario === "billing-off") {
      store.saveSetting("commercial.enabled", true);
      assert.equal((await app.inject("/health/ready")).json().note, HEALTH_NOTE);
      store.saveSetting("commercial.prices", { ocr: { microyuanPerRequest: 10_000 } });
      assert.doesNotMatch((await app.inject("/health/ready")).json().note, /配置告警/);
    }
  });
}

test("admin readiness rechecks OCR pricing after runtime billing and price changes, preserving the response shape", async t => {
  const store = new SqliteStore(":memory:");
  store.saveSetting("commercial.catalog", approvedCommercialCatalog());
  const app = Fastify();
  t.after(async () => { await app.close(); store.close(); });
  registerCommercialAdminRoutes(app, { store, auth: { admin: () => "synthetic-admin" } as never,
    configuration: { paymentConfigured: true, callbackConfigured: true, accessTokenConfigured: true, tencentOcrConfigured: true } });
  const read = async () => (await app.inject("/v1/admin/commercial/overview")).json().data.configuration;
  assert.deepEqual((await read()).missing, ["billingSwitch"]);
  store.saveSetting("commercial.enabled", true);
  const missing = await read();
  assert.deepEqual(missing.missing, [OCR_PRICE_MISSING]);
  assert.equal(missing.enabled, false);
  assert.deepEqual(Object.keys(missing).sort(), ["billingEnabled", "catalogApproved", "paymentConfigured",
    "callbackConfigured", "accessTokenConfigured", "enabled", "missing"].sort());
  store.saveSetting("commercial.prices", { ocr: { microyuanPerRequest: 10_000 } });
  assert.equal((await read()).enabled, true);
  store.saveSetting("commercial.prices", { ocr: { microyuanPerRequest: -1 } });
  assert.deepEqual((await read()).missing, [OCR_PRICE_MISSING]);
  store.saveSetting("commercial.enabled", false);
  assert.deepEqual((await read()).missing, ["billingSwitch"]);
});

test("admin overview exposes today's risk and limit before opening, following settlement, runtime limits and Beijing midnight", async t => {
  let at = Date.parse("2026-10-26T15:59:00Z");
  const clock = () => new Date(at);
  const store = new SqliteStore(":memory:", clock);
  store.saveSetting("ai.prices", [{ host: "synthetic.test", model: "test", input: 36, output: 180, cached: 36 }]);
  const app = buildApp({ env: loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_PATH: ":memory:", ADMIN_API_KEY: ADMIN_KEY }), store });
  store.useClock(clock);
  t.after(() => app.close());
  const meter = new CommercialMeter(store, clock);
  const read = async () => (await app.inject({ url: "/v1/admin/commercial/overview", headers: { "x-admin-key": ADMIN_KEY } })).json().data.costSafety;
  assert.deepEqual(await read(), { day: chinaDayStart(at), riskMicroyuan: 0, dailyCapMicroyuan: 20_000_000 });
  let release!: () => void;
  const pending = meter.run({ kind: "llm", provider: "synthetic.test", model: "test", source: "test",
    upperUsage: { inputTokens: 50_000, outputTokens: 60_000 }, riskUsage: { inputTokens: 1320, outputTokens: 1024 } },
    () => new Promise<void>(resolve => { release = resolve; }), () => ({ inputTokens: 2200, outputTokens: 800 }));
  await new Promise(resolve => setImmediate(resolve));
  try {
    const active = await read();
    assert.deepEqual(active, { day: chinaDayStart(at), riskMicroyuan: 231_840, dailyCapMicroyuan: 20_000_000 });
    const publicReady = (await app.inject("/health/ready")).json();
    assert.equal(publicReady.status, "ready");
    assert.deepEqual(Object.keys(publicReady).sort(), ["dependencies", "note", "status"]);
    assert.equal(publicReady.note, HEALTH_NOTE);
  } finally { release(); await pending; }
  assert.equal((await read()).riskMicroyuan, 223_200);
  store.saveSetting("commercial.costSafety", { dailyCapMicroyuan: 30_000_000 });
  assert.equal((await read()).dailyCapMicroyuan, 30_000_000);
  at += 60_000;
  assert.deepEqual(await read(), { day: chinaDayStart(at), riskMicroyuan: 0, dailyCapMicroyuan: 30_000_000 });
});

test("risk readiness retains stored estimates after meter restart without exposing user or provider details", async t => {
  const store = new SqliteStore(":memory:");
  const app = buildApp({ env: loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_PATH: ":memory:", ADMIN_API_KEY: ADMIN_KEY }), store });
  t.after(() => app.close());
  store.saveSetting(COST_SAFETY_TOTALS, { [chinaDayStart(Date.parse(store.now()))]: 19_900_000 });
  new CommercialMeter(store);
  const ready = (await app.inject("/health/ready")).json();
  assert.equal(ready.note, HEALTH_NOTE);
  const overview = (await app.inject({ url: "/v1/admin/commercial/overview", headers: { "x-admin-key": ADMIN_KEY } })).json().data;
  assert.deepEqual(overview.costSafety, { day: chinaDayStart(Date.parse(store.now())), riskMicroyuan: 19_900_000, dailyCapMicroyuan: 20_000_000 });
  assert.equal(ready.status, "ready", "spend admission must not remove local health readiness");
  assert.doesNotMatch(JSON.stringify(ready), /user_id|provider|apiKey|commercial_usage/);
});

test("public readiness reveals no amounts or OCR configuration even when the cost circuit is open", async t => {
  const store = new SqliteStore(":memory:");
  store.saveSetting("commercial.enabled", true);
  store.saveSetting("commercial.costSafety", { dailyCapMicroyuan: 12_345_678 });
  store.saveSetting(COST_SAFETY_TOTALS, { [chinaDayStart(Date.parse(store.now()))]: 23_456_789 });
  const app = buildApp({ store, env: loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_PATH: ":memory:",
    TENCENT_SECRET_ID: "synthetic-id", TENCENT_SECRET_KEY: "synthetic-secret" }) });
  t.after(() => app.close());
  const response = await app.inject("/health/ready");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ready", dependencies: { store: "ok" }, note: HEALTH_NOTE });
  assert.doesNotMatch(response.body, /\d|ocr|腾讯|金额|风险|上限|commercial|配置/i);
});

test("only real administrator authentication exposes risk, limit and the OCR missing-price warning", async t => {
  const store = new SqliteStore(":memory:");
  store.saveSetting("commercial.enabled", true);
  store.saveSetting("commercial.catalog", approvedCommercialCatalog());
  const app = buildApp({ store, env: loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_PATH: ":memory:",
    ADMIN_API_KEY: ADMIN_KEY, DEV_LOGIN_ENABLED: "true", TENCENT_SECRET_ID: "synthetic-id", TENCENT_SECRET_KEY: "synthetic-secret" }) });
  t.after(() => app.close());
  store.saveSetting(COST_SAFETY_TOTALS, { [chinaDayStart(Date.parse(store.now()))]: 987_654 });
  const login = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "round5-ordinary-user" } });
  assert.equal(login.statusCode, 200, login.body);
  for (const headers of [{}, { authorization: `Bearer ${login.json().data.token}` }, { "x-admin-key": "wrong-key" }]) {
    const denied = await app.inject({ url: "/v1/admin/commercial/overview", headers });
    assert.equal(denied.statusCode, 401, denied.body);
    assert.doesNotMatch(denied.body, /987654|20000000|costSafety|ocrPriceMissing/);
  }
  const response = await app.inject({ url: "/v1/admin/commercial/overview", headers: { "x-admin-key": ADMIN_KEY } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().data.costSafety, { day: chinaDayStart(Date.parse(store.now())), riskMicroyuan: 987_654, dailyCapMicroyuan: 20_000_000 });
  assert.ok(response.json().data.configuration.missing.includes(OCR_PRICE_MISSING));
});
