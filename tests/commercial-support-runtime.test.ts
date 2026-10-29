import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { ModelRouter, supportOutputTokens } from "../server/src/providers/model-router.js";
import { CommercialMeter } from "../server/src/shared/commercial-meter.js";
import { UsageLedger } from "../server/src/shared/usage-ledger.js";
import { runWithCallContext } from "../server/src/shared/call-context.js";
import { createSupportRuntime, getSupportPricingStatus } from "../server/src/modules/support/runtime.js";
import { createSupportGenerator } from "../server/src/modules/support/generator.js";
import { supportAccountReader } from "../server/src/modules/support/account-context.js";

const add = (store: SqliteStore, model = "synthetic-model", format = "thinking_type") =>
  store.db.prepare(`INSERT INTO ai_endpoints(id,alias,base_url,api_key,model,vision,thinking_format,extra_body,timeout_ms,position,enabled,created_at,updated_at)
    VALUES('support-test','synthetic','https://support.invalid/v1','synthetic',?,0,?,'{"enable_thinking":true,"reasoning_effort":"high"}',1000,0,1,'t','t')`).run(model, format);

test("support readiness distinguishes absent routes, missing prices and explicit zero prices without calling providers", t => {
  const store = new SqliteStore(":memory:"); t.after(() => store.close());
  const models = new ModelRouter(store, { fetcher: async () => { throw new Error("must not call"); } });
  const commercialMeter = new CommercialMeter(store);
  const status = (apiKey?: string) => getSupportPricingStatus({ models, commercialMeter,
    judge: { apiKey, baseUrl: "https://judge.invalid" } });
  assert.deepEqual(status(), { judge: "not_configured", generate: "not_configured" });
  add(store);
  store.saveSetting("ai.routes", { support: ["support-test"] });
  assert.deepEqual(status("synthetic"), { judge: "unpriced", generate: "unpriced" });
  store.saveSetting("commercial.prices", { jev: { microyuanPerRequest: 0 } });
  store.saveSetting("ai.prices", [{ host: "support.invalid", model: "synthetic-model", input: 0, cached: 0, output: 0, note: "test" }]);
  assert.deepEqual(status("synthetic"), { judge: "priced", generate: "priced" });
});

test("absent free buckets use zero configured allowance without creating any ledger records", t => {
  const store = new SqliteStore(":memory:"); t.after(() => store.close());
  const user = store.upsertUser("zero-allowance", "合成用户", "wechat");
  store.saveSetting("commercial.allowances", { freeDayCredits: 0, freeWeekCredits: 0, freeMonthCostMicroyuan: 0 });
  assert.match(supportAccountReader(store)(user.id).quotaSummary, /今天的免费额度还剩0%，本周还剩0%/);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM commercial_entries").get()!.n, 0);
});

test("support needs its own route, forces thinking off and bounds output even with billing disabled", async t => {
  const store = new SqliteStore(":memory:"); t.after(() => store.close());
  add(store);
  let body: Record<string, any> | undefined;
  const router = new ModelRouter(store, { fetcher: (async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"请打开订单详情核对。","confident":true}' } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  }) as typeof fetch });
  assert.equal(router.client("support").configured, false);
  store.saveSetting("ai.routes", { support: ["support-test"] });
  store.saveSetting("ai.thinking", { support: "max" });
  assert.equal(router.thinking().support, "off");
  const result = await createSupportGenerator(router.client("support")).generate({ text: "晓念页面问题", context: [], account: null, maxChars: 400 });
  assert.equal(result.confident, true);
  assert.equal(body!.max_tokens, 640);
  assert.deepEqual(body!.thinking, { type: "disabled" });
  assert.equal(body!.enable_thinking, undefined);
  assert.equal(body!.reasoning_effort, undefined);
  store.db.prepare("UPDATE ai_endpoints SET thinking_format='reasoning_effort'").run();
  assert.equal(router.client("support").configured, false, "a non-GLM route without a thinking switch stays closed");
  store.db.prepare("UPDATE ai_endpoints SET thinking_format='none'").run();
  assert.equal(router.client("support").configured, false);
});

test("support may use a GLM-5.3 vision route with low reasoning and a fixed thinking allowance", async t => {
  const store = new SqliteStore(":memory:"); t.after(() => store.close());
  add(store, "glm-5.3-flash", "thinking_type");
  store.db.prepare("UPDATE ai_endpoints SET vision=1").run();
  let body: Record<string, any> | undefined;
  const router = new ModelRouter(store, { fetcher: (async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"请打开订单详情核对。","confident":true}' } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  }) as typeof fetch });
  store.saveSetting("ai.routes", { support: ["support-test"] });
  store.saveSetting("ai.thinking", { support: "max" });
  assert.equal(router.client("support").configured, true);
  assert.equal(supportOutputTokens("glm-5.3-flash"), 1664);
  assert.equal(supportOutputTokens("synthetic-model"), 640);
  await createSupportGenerator(router.client("support")).generate({ text: "晓念页面问题", context: [], account: null, maxChars: 400 });
  assert.equal(body!.model, "glm-5.3-flash");
  assert.equal(body!.max_tokens, 1664);
  assert.deepEqual(body!.thinking, { type: "enabled" });
  assert.equal(body!.reasoning_effort, "low");
  assert.equal(body!.enable_thinking, undefined);
  assert.ok(body!.messages.every((message: { content: unknown }) => typeof message.content === "string"), "text only");
  for (const format of ["reasoning_effort", "none"]) {
    store.db.prepare("UPDATE ai_endpoints SET thinking_format=?").run(format);
    assert.equal(router.client("support").configured, true, `GLM-5.3 thinking is pinned regardless of ${format}`);
  }
});

test("the support cost hold covers the GLM thinking allowance and the daily cap still blocks generation", async t => {
  for (const [model, reserved] of [["synthetic-model", 640_000], ["glm-5.3-flash", 1_664_000]] as const) {
    const store = new SqliteStore(":memory:"); t.after(() => store.close());
    add(store, model);
    store.saveSetting("ai.routes", { support: ["support-test"] });
    store.saveSetting("ai.prices", [{ host: "support.invalid", model, input: 0, cached: 0, output: 1000, note: "test" }]);
    store.saveSetting("support.policy", { perMinute: 6, perDay: 30, dailyCapMicroyuan: 2_000_000, rejectBelow: 0.3, injectionAt: 0.3, generateAt: 0.7 });
    const owner = store.upsertUser(`support-cost-${model}`, "本人", "wechat");
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"请刷新订单状态后再看。","confident":true}' } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
    };
    const usageMeter = new UsageLedger(store), commercialMeter = new CommercialMeter(store);
    const models = new ModelRouter(store, { fetcher, usageMeter });
    const service = createSupportRuntime({ store, models, usageMeter, commercialMeter, fetcher,
      judge: {}, clock: () => new Date("2026-10-24T00:00:00Z") });
    const session = service.createSession(owner.id);
    assert.equal((await service.send(owner.id, session.id, { text: "订单支付成功没到账", idempotencyKey: "cost-first" })).layer, "answer");
    const generated = await service.send(owner.id, session.id, { text: "还是不行", idempotencyKey: "cost-second" });
    assert.equal(generated.layer, "generate", model);
    assert.equal(calls, 1);
    assert.deepEqual(store.db.prepare("SELECT kind,reserved_microyuan AS n,status FROM support_cost_holds WHERE kind='generate'").all()
      .map(row => ({ ...row })), [{ kind: "generate", n: reserved, status: "retained" }]);
    // The second generation would pass 2 yuan only for the GLM route.
    const next = await service.send(owner.id, session.id, { text: "问题还是没解决", idempotencyKey: "cost-third" });
    if (reserved * 2 > 2_000_000) {
      assert.equal(next.layer, "fallback", "the daily cap refuses the call before any provider request");
      assert.equal(calls, 1);
    } else {
      assert.equal(next.layer, "generate");
      assert.equal(calls, 2);
    }
  }
});

test("support context is owner-scoped and read-only, and unconfigured remote budget makes no paid requests", async t => {
  const store = new SqliteStore(":memory:"); t.after(() => store.close());
  const owner = store.upsertUser("support-runtime-owner", "本人", "wechat");
  const other = store.upsertUser("support-runtime-other", "其他人", "wechat");
  store.db.prepare("INSERT INTO commercial_buckets VALUES('wallet-other',?,'wallet',0,NULL,100,'t')").run(other.id);
  store.db.prepare("INSERT INTO commercial_entries(bucket_id,event_key,kind,delta,created_at) VALUES('wallet-other','synthetic-grant','grant',100,'t')").run();
  const changes = () => Number((store.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
  const before = changes();
  const read = supportAccountReader(store);
  const own = read(owner.id);
  assert.equal(own.walletBalance, null);
  assert.equal(read(other.id).walletBalance, 100);
  assert.equal(changes(), before);
  let remote = 0;
  const fetcher: typeof fetch = async () => { remote++; throw new Error("must not contact a provider"); };
  const usageMeter = new UsageLedger(store), commercialMeter = new CommercialMeter(store);
  const models = new ModelRouter(store, { fetcher, usageMeter, commercialMeter });
  const service = createSupportRuntime({ store, models, usageMeter, commercialMeter, fetcher,
    judge: { apiKey: "synthetic-key", baseUrl: "https://judge.invalid", timeoutMs: 1000 }, clock: () => new Date("2026-10-24T00:00:00Z") });
  const session = service.createSession(owner.id);
  const reply = await runWithCallContext({ source: "test", userId: owner.id }, () =>
    service.send(owner.id, session.id, { text: "我的余额还有多少", idempotencyKey: "my-balance-one" }));
  assert.equal(reply.layer, "account");
  assert.match(reply.answer, /今天的免费额度还剩100%，本周还剩100%/);
  const unrelated = await service.send(owner.id, session.id, { text: "帮我写代码", idempotencyKey: "unrelated-one" });
  assert.equal(unrelated.layer, "reject");
  assert.equal(remote, 0);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM commercial_calls").get() as { n: number }).n, 0);
});

test("support plan summary shows each plan's Beijing expiry without stray punctuation", t => {
  const store = new SqliteStore(":memory:"); t.after(() => store.close());
  const owner = store.upsertUser("support-plan-owner", "本人", "wechat");
  [Date.parse("2026-11-23T10:00:00+08:00"), Date.parse("2026-12-31T23:30:00+08:00")].forEach((endsAt, index) => {
    store.db.prepare("INSERT INTO commercial_buckets VALUES(?,?,'plan_total',0,?,100,'t')").run(`plan-${index}`, owner.id, endsAt);
    store.db.prepare("INSERT INTO commercial_entries(bucket_id,event_key,kind,delta,created_at) VALUES(?,?,'grant',?,'t')").run(`plan-${index}`, `plan-grant-${index}`, 60 - index * 30);
  });
  const own = supportAccountReader(store, () => new Date("2026-10-24T00:00:00Z"))(owner.id);
  assert.equal(own.planSummary, "套餐还剩60%，2026年11月23日到期；套餐还剩30%，2026年12月31日到期");
});
