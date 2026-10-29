import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { z } from "../server/node_modules/zod/index.js";
import { CommercialMeter, PROVIDER_CONCURRENCY } from "../server/src/shared/commercial-meter.js";
import { CommercialBilling } from "../server/src/shared/commercial-billing.js";
import { COST_SAFETY_TOTALS, FREE_FAILURE_ESTIMATE_MICROYUAN, type CostSafetyOptions } from "../server/src/shared/cost-safety.js";
import { CommercialSettings } from "../server/src/modules/commercial/settings.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { bindCallContext, runWithCallContext } from "../server/src/shared/call-context.js";
import { ModelRouter } from "../server/src/providers/model-router.js";
import { ChatModel } from "../server/src/providers/llm.js";
import { Jev } from "../server/src/providers/jev.js";
import { TencentOcr } from "../server/src/providers/tencent-ocr.js";
import { boundedResponseText, MAX_PROVIDER_RESPONSE_BYTES } from "../server/src/providers/response-limits.js";
import { approvedCommercialCatalog } from "../server/src/modules/commercial/policy.js";
import { Budget } from "../server/src/shared/budget.js";
import { SupportCostGuard } from "../server/src/modules/support/service.js";

const info = { kind: "llm" as const, provider: "safe.test", model: "test", source: "chat.study",
  upperUsage: { inputTokens: 10, outputTokens: 90 } };
const usage = () => ({ inputTokens: 10, outputTokens: 90 });
function setup(options: CostSafetyOptions = {}) {
  let time = Date.parse("2026-10-26T08:00:00Z");
  const clock = () => new Date(time);
  const store = new SqliteStore(":memory:", clock);
  const user = store.upsertUser("cost-safety", "Synthetic", "wechat");
  store.saveSetting("ai.prices", [{ host: "safe.test", model: "test", input: 1, output: 1, cached: 0, note: "synthetic" }]);
  const events: Record<string, unknown>[] = [];
  const billing = new CommercialBilling(store, clock);
  const meter = new CommercialMeter(store, clock, billing, { ...options, logger: { warn: fields => { events.push(fields); } } });
  const settings = new CommercialSettings(store);
  const cap = (dailyCapMicroyuan: number) => settings.update("admin:test", { reason: "synthetic safety test", costSafety: { dailyCapMicroyuan } });
  const run = (call: () => Promise<unknown> = async () => true, request = info, read = usage) =>
    runWithCallContext({ userId: user.id, source: "http" }, () => meter.run(request, call, read));
  const total = () => Object.values(store.setting<Record<string, number>>(COST_SAFETY_TOTALS) ?? {}).reduce((sum, value) => sum + value, 0);
  return { store, user, meter, billing, clock, settings, cap, run, events, total, advance: (ms: number) => { time += ms; } };
}

test("concurrent calls reserve global cost before sending; completed usage releases only the unused amount", async t => {
  const f = setup(); t.after(() => f.store.close()); f.cap(100);
  let release!: () => void;
  const pending = f.run(() => new Promise<void>(resolve => { release = resolve; }), info, () => ({ inputTokens: 10, outputTokens: 10 }));
  await assert.rejects(f.run(), { code: "COST_CIRCUIT_OPEN" });
  assert.equal(f.total(), 100);
  release(); await pending;
  assert.equal(f.total(), 20);
  await f.run(async () => true, { ...info, upperUsage: { inputTokens: 10, outputTokens: 70 } }, () => ({ inputTokens: 10, outputTokens: 70 }));
  assert.equal(f.total(), 100);
  assert.deepEqual(f.events[0], { event: "cost_circuit_open", reason: "site_day_cost",
    day: "2026-10-25T16:00:00.000Z", riskMicroyuan: 100, dailyCapMicroyuan: 100, admissionEstimateMicroyuan: 0 });
});

test("failed, cancelled and unknown-usage requests retain their estimated cost; deletion and restart cannot erase it", async t => {
  for (const error of [Object.assign(new Error("partial"), { billing: "unknown", usage: { promptTokens: 0, completionTokens: 0, estimated: true } }), new DOMException("cancelled", "AbortError")]) {
    const f = setup(); f.cap(100);
    try {
      await assert.rejects(f.run(async () => { throw error; }));
      assert.equal(f.total(), 100);
      f.store.db.prepare("DELETE FROM users WHERE id=?").run(f.user.id);
      assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_usage").get()!.n, 0);
      const meter = new CommercialMeter(f.store, f.clock);
      await assert.rejects(meter.run(info, async () => true, usage), { code: "COST_CIRCUIT_OPEN" });
      assert.equal(f.total(), 100);
    } finally { f.store.close(); }
  }
});

test("DAILY_SAFETY_CAP counts failures and commercial failure budgets survive day rollover", async t => {
  const f = setup({ dailySafetyCap: 2 }); t.after(() => f.store.close());
  for (let i = 0; i < 2; i++) await assert.rejects(f.run(async () => { throw Object.assign(new Error("not sent"), { billing: "none" }); }));
  await assert.rejects(f.run(), { code: "DAILY_LIMIT" });
  assert.equal(f.total(), 0);
  const b = setup({ legacyBudget: { day: 0.0001, week: 0.0001 } }); t.after(() => b.store.close());
  b.store.saveSetting("commercial.enabled", true);
  b.store.saveSetting("commercial.catalog", approvedCommercialCatalog());
  await assert.rejects(b.run(async () => { throw Object.assign(new Error("unknown"), { billing: "unknown" }); }));
  await assert.rejects(b.run(), { code: "DAILY_LIMIT" });
  b.advance(24 * 60 * 60_000);
  await assert.rejects(b.run(), { code: "DAILY_LIMIT" }, "the weekly failure ceiling also survives day rollover");
});

test("legacy failures retain global risk and old paid buckets cannot bypass the cap with commercial billing disabled", async t => {
  const f = setup({ legacyBudget: { day: 0.0001, week: 0.0001 } }); t.after(() => f.store.close()); f.cap(200);
  const at = f.clock().getTime();
  f.store.db.prepare("INSERT INTO commercial_orders(id,user_id,idempotency_key,good_id,amount_cents,snapshot,catalog_version,env,status,created_at) VALUES('legacy-paid',?,'legacy-paid-key','points_10',1000,'{}','v1',0,'delivered',?)").run(f.user.id, at);
  f.billing.ledger.ensureBucket({ id: "legacy-paid-wallet", userId: f.user.id, kind: "wallet", credits: 100, startsAt: at, endsAt: null });
  f.store.db.prepare("INSERT INTO commercial_order_grants(order_id,bucket_id) VALUES('legacy-paid','legacy-paid-wallet')").run();
  assert.equal(f.billing.enabled, false);
  for (let i = 0; i < 2; i++)
    await assert.rejects(f.run(async () => { throw Object.assign(new Error("unknown"), { billing: "unknown" }); }));
  assert.equal(f.total(), 200, "failed learner actions never refund merchant risk");
  await assert.rejects(f.run(), { code: "COST_CIRCUIT_OPEN" });
});

test("the daily safety cap counts business actions, including failures, without double-counting their internal calls", async t => {
  const f = setup({ dailySafetyCap: 1 }); t.after(() => f.store.close());
  await runWithCallContext({ userId: f.user.id, source: "job" }, async () => {
    await f.meter.run(info, async () => true, usage);
    await f.meter.run(info, async () => true, usage);
    await bindCallContext(() => f.meter.run(info, async () => true, usage))();
  });
  assert.equal(f.total(), 300, "all calls still reserve and settle merchant cost");
  await assert.rejects(f.run(), { code: "DAILY_LIMIT" });
});

test("a cancelled commercial stream refunds credits and monthly free allowance while global risk remains", async t => {
  const f = setup(); t.after(() => f.store.close());
  f.store.saveSetting("commercial.enabled", true);
  f.store.saveSetting("commercial.catalog", approvedCommercialCatalog());
  const before = f.billing.accounts.available(f.user.id).free;
  await assert.rejects(runWithCallContext({ userId: f.user.id, source: "http" }, () => f.billing.action(() => f.meter.run(info, async () => {
    throw Object.assign(new Error("interrupted"), { billing: "unknown", usage: { promptTokens: 0, completionTokens: 0, estimated: true } });
  }, usage))));
  assert.equal(f.billing.accounts.available(f.user.id).free, before);
  assert.equal(f.billing.ledger.freeCostRemaining("2026-10"), 100_000_000);
  assert.equal(f.total(), 100);
});

test("paid users remain subject to attempt caps while the global circuit pauses free users", async t => {
  const f = setup({ dailySafetyCap: 1 }); t.after(() => f.store.close()); f.cap(0);
  f.store.saveSetting("commercial.enabled", true);
  f.store.saveSetting("commercial.catalog", approvedCommercialCatalog());
  await assert.rejects(f.run(), { code: "COST_CIRCUIT_OPEN" });
  const at = f.clock().getTime();
  f.store.db.prepare("INSERT INTO commercial_orders(id,user_id,idempotency_key,good_id,amount_cents,snapshot,catalog_version,env,status,created_at) VALUES('paid-synthetic',?,'key','points_10',1000,'{}','v1',0,'delivered',?)").run(f.user.id, at);
  f.billing.ledger.ensureBucket({ id: "paid-wallet", userId: f.user.id, kind: "wallet", credits: 100, startsAt: at, endsAt: null });
  f.store.db.prepare("INSERT INTO commercial_order_grants(order_id,bucket_id) VALUES('paid-synthetic','paid-wallet')").run();
  await f.run();
  await assert.rejects(f.run(), { code: "DAILY_LIMIT" });
});

test("purchased credits remain usable after three uncertain failures even with a zero free budget", async t => {
  const f = setup({ legacyBudget: { day: 3, week: 12 } }); t.after(() => f.store.close()); f.cap(0);
  f.store.saveSetting("commercial.enabled", true);
  f.store.saveSetting("commercial.catalog", approvedCommercialCatalog());
  f.store.db.prepare("UPDATE users SET quota=? WHERE id=?").run('{"budget":{"day":0,"week":0}}', f.user.id);
  const at = f.clock().getTime();
  f.store.db.prepare("INSERT INTO commercial_orders(id,user_id,idempotency_key,good_id,amount_cents,snapshot,catalog_version,env,status,created_at) VALUES('zero-free-paid',?,'zero-free-key','points_10',1000,'{}','v1',0,'delivered',?)").run(f.user.id, at);
  f.billing.ledger.ensureBucket({ id: "zero-free-wallet", userId: f.user.id, kind: "wallet", credits: 100, startsAt: at, endsAt: null });
  f.store.db.prepare("INSERT INTO commercial_order_grants(order_id,bucket_id) VALUES('zero-free-paid','zero-free-wallet')").run();
  f.billing.accounts.consentWallet(f.user.id);
  assert.equal(f.billing.accounts.available(f.user.id).free, 0);
  const paid = (call: () => Promise<unknown> = async () => true) => runWithCallContext({ userId: f.user.id, source: "http" }, () =>
    f.billing.action(() => f.meter.run(info, call, usage)));
  await paid(); await paid();
  for (let i = 0; i < 3; i++)
    await assert.rejects(paid(async () => { throw Object.assign(new Error("uncertain"), { billing: "unknown" }); }));
  await paid();
  assert.equal(f.total(), 600);
  const legacy = setup({ legacyBudget: { day: 0, week: 0 } }); t.after(() => legacy.store.close());
  const budget = new Budget(legacy.store, { day: 0, week: 0, cap: 500 }, legacy.clock);
  assert.throws(() => budget.check(legacy.user.id), { code: "DAILY_LIMIT" }, "zero legacy allowances still block business admission");
});

test("cost totals retain only two days and the next Beijing business day reopens admission", async t => {
  const f = setup(); t.after(() => f.store.close()); f.cap(100);
  for (let day = 0; day < 4; day++) {
    await f.run();
    await assert.rejects(f.run(), { code: "COST_CIRCUIT_OPEN" });
    assert.ok(Object.keys(f.store.setting(COST_SAFETY_TOTALS)!).length <= 2);
    f.advance(24 * 60 * 60_000);
  }
  assert.equal(f.settings.get().costSafety.dailyCapMicroyuan, 100);
  assert.throws(() => f.settings.update("admin:test", { reason: "invalid", costSafety: { dailyCapMicroyuan: -1 } }));
});

test("32 LLM calls and 32 Jev calls run independently; the next LLM briefly queues and succeeds", async t => {
  const f = setup(); t.after(() => f.store.close());
  f.store.saveSetting("commercial.prices", { jev: { microyuanPerRequest: 0 } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const users = Array.from({ length: 16 }, (_, i) => f.store.upsertUser(`parallel-${i}`, "Synthetic", "wechat"));
  let started = 0;
  const pending = Array.from({ length: 64 }, (_, i) => runWithCallContext({ userId: users[i % 16]!.id, source: "http" }, () =>
    i < 32 ? f.meter.run(info, async () => { started++; await gate; }, usage) :
      f.meter.run({ kind: "jev", provider: "jev.test", model: "test", source: "jev" }, async () => { started++; await gate; }, () => ({ requests: 1 }))));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 64);
  let extraStarted = false;
  const extra = f.run(async () => { extraStarted = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(extraStarted, false);
  release(); await Promise.all([...pending, extra]);
  assert.equal(extraStarted, true);
  assert.deepEqual(f.events, []);
  await assert.rejects(f.run(async () => { throw new Error("synthetic failure"); }));
  await f.run();
});

test("ordinary models retain pre-hardening output defaults; malformed upstream output remains potentially billed", async t => {
  const f = setup(); t.after(() => f.store.close());
  f.store.db.prepare("INSERT INTO ai_endpoints(id,alias,base_url,api_key,model,vision,thinking_format,extra_body,timeout_ms,position,enabled,created_at,updated_at) VALUES('safe','safe','https://safe.test/v1','synthetic','test',0,'none','{}',1000,0,1,'t','t')").run();
  let body: Record<string, unknown> = {};
  const router = new ModelRouter(f.store, { commercialMeter: f.meter, fetcher: (async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  }) as typeof fetch });
  await router.client("chat.study").json([{ role: "user", content: "synthetic" }], z.object({ ok: z.boolean() }));
  assert.equal(body.max_tokens, undefined);
  const broken = new ChatModel({ baseUrl: "https://safe.test/v1", apiKey: "synthetic", model: "test", extraBody: {}, timeoutMs: 1000 }, async () => new Response("{}"));
  await assert.rejects(broken.json([], z.object({ ok: z.boolean() })), { billing: "unknown" });
  const jev = new Jev({ apiKey: "synthetic", timeoutMs: 1000 }, async () => new Response("{}"));
  await assert.rejects(jev.noul({}, "synthetic"), { billing: "unknown" });
});

test("30 successful unpriced OCR images do not trip the free-user site circuit", async t => {
  const f = setup(); t.after(() => f.store.close());
  f.store.saveSetting("commercial.enabled", true);
  f.store.saveSetting("commercial.catalog", approvedCommercialCatalog());
  f.store.saveSetting("commercial.prices", { jev: { microyuanPerRequest: 0 } });
  const info = { kind: "ocr" as const, provider: "ocr.test", model: "test", source: "ocr" };
  for (let i = 0; i < 30; i++) await f.meter.run(info, async () => true, () => ({ requests: 1 }));
  assert.equal(f.total(), 300_000);
  await f.run();
  assert.deepEqual(f.events, []);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_usage WHERE kind='ocr' AND cost_microyuan IS NULL").get()!.n, 30,
    "a merchant risk estimate is not fabricated actual billing");
});

test("provider responses are bounded while reading, including a stream with no newline", async () => {
  let cancelled = false;
  const make = () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(128 * 1024)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(boundedResponseText(make()), /byte limit/);
  assert.equal(cancelled, true);
  const model = new ChatModel({ baseUrl: "https://safe.test/v1", apiKey: "synthetic", model: "test", extraBody: {}, timeoutMs: 1000 }, async () => make());
  await assert.rejects(model.stream([], { onText() {} }), { code: "AI_RESPONSE_TOO_LARGE", billing: "unknown" });
  assert.equal(MAX_PROVIDER_RESPONSE_BYTES, 2 * 1024 * 1024);
});

test("model JSON collections are rejected before Zod visits every invalid element", async () => {
  let validated = 0;
  const model = new ChatModel({ baseUrl: "https://safe.test/v1", apiKey: "synthetic", model: "test", extraBody: {}, timeoutMs: 1000 }, async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: Array(1001).fill(null) }) } }] })));
  await assert.rejects(model.json([], z.object({ items: z.array(z.preprocess(value => { validated++; return value; }, z.string())) })), { code: "AI_BAD_OUTPUT", billing: "unknown" });
  assert.equal(validated, 0);
});

test("Jev rejects excess queued work without retaining more payloads", async () => {
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const jev = new Jev({ timeoutMs: 1000, answer: async () => ({ answers: { q: { noul: 0.5 } } }) });
  const active = jev.background(async () => { await blocker; return true; });
  const queued = Array.from({ length: 32 }, () => jev.background(async () => true));
  await assert.rejects(jev.background(async () => true), { code: "JEV_BUSY" });
  release(); await active; await Promise.all(queued);
});

test("pending commercial calls are not charged to the user's failure budget", async t => {
  const f = setup({ legacyBudget: { day: 0.0001, week: 0.0001 } }); t.after(() => f.store.close());
  f.store.saveSetting("commercial.enabled", true);
  f.store.saveSetting("commercial.catalog", approvedCommercialCatalog());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sent = 0;
  const calls = Array.from({ length: 3 }, () => f.run(async () => { sent++; await gate; }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent, 3);
  assert.equal(f.total(), 300);
  release(); await Promise.all(calls);
  assert.deepEqual(f.events, []);
});

test("measured provider failure refunds the free pool and cannot create a fabricated user charge", async t => {
  const f = setup(); t.after(() => f.store.close());
  f.store.saveSetting("commercial.enabled", true);
  f.store.saveSetting("commercial.catalog", approvedCommercialCatalog());
  const before = f.billing.accounts.available(f.user.id).free;
  for (let i = 0; i < 10; i++) await assert.rejects(runWithCallContext({ userId: f.user.id, source: "http" }, () =>
    f.billing.action(() => f.meter.run(info, async () => {
      throw Object.assign(new Error("malformed provider output"), { billing: "unknown", usage: usage() });
    }, usage))));
  assert.equal(f.billing.accounts.available(f.user.id).free, before);
  assert.equal(f.billing.ledger.freeCostRemaining("2026-10"), 100_000_000);
  assert.equal(f.total(), 1000);
  assert.equal(f.store.db.prepare("SELECT SUM(cost_microyuan) cost FROM commercial_usage").get()!.cost, 1000);
});

test("recovery and expired calls refund the free pool while preserving merchant reservations", async t => {
  for (const expiration of [false, true]) {
    const f = setup(); t.after(() => f.store.close());
    f.store.saveSetting("commercial.enabled", true);
    f.store.saveSetting("commercial.catalog", approvedCommercialCatalog());
    let release!: () => void;
    const pending = runWithCallContext({ userId: f.user.id, source: "http" }, () => f.billing.action(() =>
      f.meter.run(info, () => new Promise<void>(resolve => { release = resolve; }), usage)));
    await new Promise(resolve => setImmediate(resolve));
    if (expiration) {
      f.advance(60 * 60_000 + 1);
      assert.equal(f.billing.ledger.releaseExpired(), 1);
    } else assert.equal(f.billing.recover(), 1);
    assert.equal(f.billing.ledger.freeCostRemaining("2026-10"), 100_000_000);
    assert.equal(f.total(), 100);
    // No real provider process survives restart, but expired calls may finish
    // late: final cleanup must not charge the refunded free pool again.
    release();
    await pending;
    assert.equal(f.billing.ledger.freeCostRemaining("2026-10"), 100_000_000);
  }
});

test("unpriced OCR releases extra estimate on success and retains bounded failed exposure", async t => {
  const f = setup(); t.after(() => f.store.close()); f.cap(40_000);
  const image = { kind: "ocr" as const, provider: "ocr.test", model: "test", source: "ocr", upperUsage: { requests: 3 } };
  await f.meter.run(image, async () => { assert.equal(f.total(), 30_000); }, () => ({ requests: 1 }));
  assert.equal(f.total(), 10_000);
  await assert.rejects(f.meter.run(image, async () => { throw new Error("unknown cost"); }, () => ({ requests: 1 })));
  assert.equal(f.total(), 40_000);
  await assert.rejects(f.run(), { code: "COST_CIRCUIT_OPEN" });
});

test("LLM models without a configured price still reserve nonzero conservative cost", async t => {
  const f = setup(); t.after(() => f.store.close());
  f.store.saveSetting("ai.prices", []);
  const price = f.meter.pricing.snapshot(info.provider, info.model, "llm");
  assert.equal(price.unknown, true);
  const estimate = f.meter.pricing.cost(price, info.upperUsage);
  assert.ok(estimate > 0);
  f.cap(estimate);
  await f.run();
  assert.equal(f.total(), estimate);
  await assert.rejects(f.run(), { code: "COST_CIRCUIT_OPEN" });
});

test("a saturated user's eight calls queue briefly without blocking another user", async t => {
  const f = setup(); t.after(() => f.store.close());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  const calls = Array.from({ length: 8 }, () => f.run(async () => { started++; await gate; }));
  const waiting = f.run(async () => { started++; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 8);
  const other = f.store.upsertUser("other-concurrent-user", "Synthetic", "wechat");
  await runWithCallContext({ userId: other.id, source: "http" }, () => f.meter.run(info, async () => true, usage));
  release(); await Promise.all([...calls, waiting]);
  assert.equal(started, 9);
});

test("provider wait queues remain bounded globally and per user and recover after draining", async t => {
  for (const withUser of [false, true]) {
    const f = setup(); t.after(() => f.store.close());
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const run = (call: () => Promise<unknown>) => withUser ? f.run(call) : f.meter.run(info, call, usage);
    const active = Array.from({ length: withUser ? 8 : 32 }, () => run(() => gate));
    const waiting = Array.from({ length: withUser ? 16 : 128 }, () => run(async () => true));
    await assert.rejects(run(async () => true), { code: "AI_BUSY" });
    release(); await Promise.all([...active, ...waiting]);
    await run(async () => true);
  }
});

test("provider queue timeout returns retryable busy without reserving cost or leaking a slot", async t => {
  const f = setup(); t.after(() => f.store.close());
  // Real provider sockets keep the process alive; this synthetic gate does not.
  const keepAlive = setTimeout(() => {}, PROVIDER_CONCURRENCY.waitMs + 1000);
  t.after(() => clearTimeout(keepAlive));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls = Array.from({ length: 8 }, () => f.run(() => gate));
  const before = Date.now();
  await assert.rejects(f.run(), { code: "AI_BUSY" });
  assert.ok(Date.now() - before >= PROVIDER_CONCURRENCY.waitMs - 50);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_usage").get()!.n, 8);
  release(); await Promise.all(calls);
  await f.run();
});

test("Jev fallback starts after its original meter slot is released", async t => {
  const f = setup(); t.after(() => f.store.close());
  f.store.saveSetting("commercial.prices", { jev: { microyuanPerRequest: 0 } });
  const jev = new Jev({ apiKey: "synthetic", timeoutMs: 1000, commercialMeter: f.meter,
    fallback: async () => f.meter.run(info, async () => ({ answers: { q: { noul: 0.9 } } }), usage),
  }, async () => new Response("unavailable", { status: 503 }));
  const results = await Promise.all(Array.from({ length: 8 }, () => runWithCallContext({ userId: f.user.id, source: "http" }, () => jev.noul({}, "synthetic"))));
  assert.ok(results.every(value => value === 0.9));
  assert.deepEqual(f.events, []);
});

test("long ordinary JSON keeps provider defaults and records cost above its reservation", async t => {
  const f = setup(); t.after(() => f.store.close());
  f.store.db.prepare("INSERT INTO ai_endpoints(id,alias,base_url,api_key,model,vision,thinking_format,extra_body,timeout_ms,position,enabled,created_at,updated_at) VALUES('long','long','https://safe.test/v1','synthetic','test',0,'none','{}',1000,0,1,'t','t')").run();
  const text = "详细解答".repeat(8000);
  const bodies: Record<string, unknown>[] = [];
  const router = new ModelRouter(f.store, { commercialMeter: f.meter, fetcher: (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ text }) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 40_000 } });
  }) as typeof fetch });
  const result = await router.client("chat.study").json([], z.object({ text: z.string() }), undefined, { jsonRetries: 0, truncateAsError: true });
  assert.equal(result.data.text, text);
  assert.equal(bodies[0]!.max_tokens, undefined);
  assert.equal(f.total(), 40_010);
  await router.client("chat.study").json([], z.object({ text: z.string() }), undefined, { maxTokens: 12_000, jsonRetries: 0 });
  assert.ok(Number(bodies[1]!.max_tokens) >= 12_000, "explicit caller limits are preserved");
});

test("streamed model and Jev complexity failures are provider errors with unknown billing", async () => {
  const text = JSON.stringify({ items: Array(1001).fill(null) });
  const chunk = JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 100 } });
  const model = new ChatModel({ baseUrl: "https://safe.test/v1", apiKey: "synthetic", model: "test", extraBody: {}, timeoutMs: 1000 },
    async () => new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }));
  await assert.rejects(model.streamJson([], z.object({ items: z.array(z.unknown()) }), { expect: 1000, jsonRetries: 0 }), { code: "AI_BAD_OUTPUT", billing: "unknown" });
  const jev = new Jev({ apiKey: "synthetic", timeoutMs: 1000 }, async () => Response.json({ answers: { q: { noul: 0.5 } }, items: Array(1001).fill(null) }));
  await assert.rejects(jev.noul({}, "synthetic"), { code: "JEV_BAD_OUTPUT", billing: "unknown" });
});

test("a disabled support budget logs at most once per minute", t => {
  const f = setup(); t.after(() => f.store.close());
  let warnings = 0;
  const guard = new SupportCostGuard(f.store, { dailyCapMicroyuan: 0, judgeUpperMicroyuan: 1, generateUpperMicroyuan: 1 },
    () => f.clock().getTime(), () => { warnings++; });
  for (let i = 0; i < 30; i++) assert.equal(guard.reserve(`disabled-${i}`, "judge"), null);
  assert.equal(warnings, 1);
  f.advance(60_000);
  assert.equal(guard.reserve("next-minute", "generate"), null);
  assert.equal(warnings, 2);
});

test("five supplier timeouts do not consume a free learner's daily budget at their one-yuan upper bound", async t => {
  const f = setup({ legacyBudget: { day: 3, week: 12 } }); t.after(() => f.store.close());
  f.store.saveSetting("commercial.enabled", true);
  f.store.saveSetting("commercial.catalog", approvedCommercialCatalog());
  // Keep the synthetic upper reservation within the learner's available credits.
  f.store.saveSetting("commercial.prices", { microyuanPerCredit: 1_000_000 });
  const high = { ...info, upperUsage: { inputTokens: 10, outputTokens: 999_990 } };
  const before = f.billing.accounts.available(f.user.id).free;
  for (let i = 0; i < 5; i++) await assert.rejects(f.run(async () => {
    throw Object.assign(new Error("supplier timeout"), { billing: "unknown" });
  }, high), /supplier timeout/);
  assert.equal(f.total(), 5170, "merchant risk uses input plus ordinary output, not the upper reservation");
  assert.equal(f.billing.accounts.available(f.user.id).free, before, "failed calls refund learner credits");
  // Existing unknown receipts use the estimate as well, including after restart.
  const restarted = new CommercialMeter(f.store, f.clock, f.billing, { legacyBudget: { day: 3, week: 12 } });
  await runWithCallContext({ userId: f.user.id, source: "http" }, () => restarted.run(info, async () => true, usage));
  assert.equal(f.total(), 5270);
  assert.deepEqual(f.events, []);
});

test("free failure estimates still enforce daily and weekly anti-abuse budgets with estimated merchant risk", async t => {
  const f = setup({ legacyBudget: { day: 0.003102, week: 0.003102 } }); t.after(() => f.store.close());
  f.store.saveSetting("commercial.enabled", true);
  f.store.saveSetting("commercial.catalog", approvedCommercialCatalog());
  f.store.saveSetting("commercial.prices", { microyuanPerCredit: 1_000_000 });
  const high = { ...info, upperUsage: { inputTokens: 10, outputTokens: 999_990 } };
  for (let i = 0; i < 3; i++) await assert.rejects(f.run(async () => {
    throw Object.assign(new Error("uncertain"), { billing: "unknown" });
  }, high), /uncertain/);
  assert.equal(FREE_FAILURE_ESTIMATE_MICROYUAN, 10_000);
  assert.equal(f.total(), 3102);
  await assert.rejects(f.run(), { code: "DAILY_LIMIT" });
  const other = f.store.upsertUser("failure-other", "Synthetic", "wechat");
  await runWithCallContext({ userId: other.id, source: "http" }, () => f.meter.run(info, async () => true, usage));
  f.advance(24 * 60 * 60_000);
  await assert.rejects(f.run(), { code: "DAILY_LIMIT" });
  f.advance(7 * 24 * 60 * 60_000);
  await f.run();
});

test("cancelled queued JSON, stream, streamJson, Jev and OCR calls never send, reserve cost or keep abort listeners", async t => {
  const f = setup(); t.after(() => f.store.close());
  f.store.db.prepare("INSERT INTO ai_endpoints(id,alias,base_url,api_key,model,vision,thinking_format,extra_body,timeout_ms,position,enabled,created_at,updated_at) VALUES('cancel','cancel','https://safe.test/v1','synthetic','test',0,'none','{}',1000,0,1,'t','t')").run();
  let sent = 0;
  const fetcher = (async () => { sent++; throw new Error("cancelled call reached provider"); }) as typeof fetch;
  const model = new ModelRouter(f.store, { commercialMeter: f.meter, fetcher }).client("chat.study");
  const jev = new Jev({ apiKey: "synthetic", timeoutMs: 1000, commercialMeter: f.meter }, fetcher);
  const ocr = new TencentOcr({ secretId: "synthetic", secretKey: "synthetic", timeoutMs: 1000, commercialMeter: f.meter }, fetcher);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const active = Array.from({ length: 8 }, () => f.run(() => gate));
  await new Promise(resolve => setImmediate(resolve));
  const calls = [
    (signal: AbortSignal) => model.json([], z.object({ ok: z.boolean() }), signal),
    (signal: AbortSignal) => model.stream([], { onText() {} }, { signal }),
    (signal: AbortSignal) => model.streamJson([], z.object({ ok: z.boolean() }), { expect: 10, signal }),
    (signal: AbortSignal) => jev.noul({}, "synthetic", signal),
    (signal: AbortSignal) => ocr.recognize(Buffer.from("synthetic"), signal),
  ];
  try {
    for (const call of calls) {
      const controller = new AbortController();
      const reason = new DOMException("cancelled while waiting", "AbortError");
      const pending = runWithCallContext({ userId: f.user.id, source: "http" }, () => call(controller.signal));
      let settled = false;
      const checked = assert.rejects(pending, error => error === reason).then(() => { settled = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(getEventListeners(controller.signal, "abort").length, 1);
      controller.abort(reason);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, true, "cancellation must not wait for an occupied slot or the three-second queue timeout");
      await checked;
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    }
    assert.equal(sent, 0);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_usage").get()!.n, 8);
    assert.equal(f.total(), 800);
  } finally { release(); await Promise.all(active); }
  await f.run();
  assert.deepEqual(f.events, []);
});

test("cancellation before admission or immediately after a slot is granted releases every slot without a receipt", async t => {
  const f = setup(); t.after(() => f.store.close());
  let sent = 0;
  for (const before of [true, false]) {
    for (let i = 0; i < 16; i++) {
      const controller = new AbortController();
      if (before) controller.abort();
      const pending = runWithCallContext({ userId: f.user.id, source: "http" }, () =>
        f.meter.run(info, async () => { sent++; }, usage, controller.signal));
      if (!before) controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    }
  }
  assert.equal(sent, 0);
  assert.equal(f.total(), 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_usage").get()!.n, 0);
  await f.run();
  assert.deepEqual(f.events, []);
});

test("billing none costs zero even when an error carries counters, while real zero usage remains zero", async t => {
  const f = setup(); t.after(() => f.store.close());
  for (const error of [
    Object.assign(new Error("not billed"), { billing: "none", usage: { inputTokens: 10, outputTokens: 90 } }),
    Object.assign(new Error("reported zero"), { billing: "unknown", usage: { inputTokens: 0, outputTokens: 0 } }),
  ]) await assert.rejects(f.run(async () => { throw error; }));
  assert.equal(f.total(), 0);
});

test("actual settlement opens the circuit immediately with bounded structured warnings", async t => {
  const f = setup(); t.after(() => f.store.close()); f.cap(1000);
  await f.run(async () => true, info, () => ({ inputTokens: 10, outputTokens: 1990 }));
  assert.equal(f.total(), 2000, "actual cost above the estimate is never discarded");
  for (let i = 0; i < 5; i++) await assert.rejects(f.run(), { code: "COST_CIRCUIT_OPEN" });
  assert.deepEqual(f.events, [{ event: "cost_circuit_open", reason: "site_day_cost",
    day: "2026-10-25T16:00:00.000Z", riskMicroyuan: 2000, dailyCapMicroyuan: 1000, admissionEstimateMicroyuan: 0 }]);
  f.advance(60_000);
  await assert.rejects(f.run(), { code: "COST_CIRCUIT_OPEN" });
  assert.equal(f.events.length, 2);
});

test("receipt and risk corrections are atomic if a settlement write fails", async t => {
  const f = setup(); t.after(() => f.store.close());
  const save = f.store.saveSetting.bind(f.store);
  let fail = false;
  t.mock.method(f.store, "saveSetting", (key: string, value: unknown) => {
    if (key === COST_SAFETY_TOTALS && fail) { fail = false; throw new Error("synthetic SQLite write failure"); }
    return save(key, value);
  });
  let sent = 0;
  await f.run(async () => { sent++; fail = true; }, info, () => ({ inputTokens: 10, outputTokens: 10 }));
  assert.equal(sent, 1, "accounting failure cannot retry a completed provider call");
  assert.equal(f.total(), 100, "the original reasonable estimate is retained");
  const row = f.store.db.prepare("SELECT status,cost_microyuan,price FROM commercial_usage").get()!;
  assert.equal(row.status, "unknown");
  assert.equal(row.cost_microyuan, null, "the partial actual settlement was rolled back");
  assert.equal(JSON.parse(String(row.price)).safetyCostMicroyuan, 100);
  assert.equal(f.meter.accountingWriteFailures, 1);
});
