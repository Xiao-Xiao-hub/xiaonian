import assert from "node:assert/strict";
import test from "node:test";
import { z } from "../server/node_modules/zod/index.js";
import { ModelRouter } from "../server/src/providers/model-router.js";
import type { ChatMessage, Scenario } from "../server/src/providers/llm.js";
import { CommercialBilling } from "../server/src/shared/commercial-billing.js";
import { CommercialMeter } from "../server/src/shared/commercial-meter.js";
import { COST_SAFETY_TOTALS } from "../server/src/shared/cost-safety.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { runWithCallContext } from "../server/src/shared/call-context.js";
import { approvedCommercialCatalog } from "../server/src/modules/commercial/policy.js";

// All prompts and successes below are synthetic. The brief supplies only
// production prices, endpoint order, failure counts and aggregate token ranges;
// it does not supply the individual requests or successes from October 14.
const text = "学".repeat(2000);
const messages: ChatMessage[] = [{ role: "user", content: text }];
const imageMessages: ChatMessage[] = [{ role: "user", content: [
  { type: "text", text },
  { type: "image_url", image_url: { url: "data:image/png;base64,c3ludGhldGlj" } },
] }];
const schema = z.object({ ok: z.literal(true) });
const prices = [
  { model: "claude-opus-5-5", input: 36, output: 180 },
  { model: "gpt-6-astra", input: 36, output: 180 },
  { model: "glm-5.3", input: 8, output: 28 },
  { model: "glm-5.3-flash", input: 0.8, output: 2.8 },
];
const successful = (input = 2200, output = 800, content = '{"ok":true}') => Response.json({
  choices: [{ message: { content }, finish_reason: "stop" }],
  usage: { prompt_tokens: input, completion_tokens: output },
});

function setup(fetcher: typeof fetch, timeoutMs = 2000) {
  const clock = () => new Date("2026-10-14T08:00:00Z");
  const store = new SqliteStore(":memory:", clock);
  store.saveSetting("ai.prices", prices.map(price => ({ ...price, host: "site-cost.test", cached: 0, note: "brief prices; synthetic test host" })));
  store.saveSetting("ai.thinking", { "chat.study": "high", recheck: "max", judge: "low", brainstorm: "high", vision: "low" });
  store.saveSetting("ai.routes", { support: ["endpoint-2"] });
  store.saveSetting("commercial.enabled", true);
  store.saveSetting("commercial.catalog", approvedCommercialCatalog());
  // This fixture conversion lets the existing upper credit hold fit free
  // accounts; production model prices, the upper hold and the 20-yuan cap stay
  // unchanged. A provider failure releases that hold through the real billing.
  store.saveSetting("commercial.prices", { microyuanPerCredit: 1_000_000 });
  const insert = store.db.prepare("INSERT INTO ai_endpoints(id,alias,base_url,api_key,model,vision,thinking_format,extra_body,timeout_ms,position,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,'none','{}',?,?,?,'synthetic','synthetic')");
  for (const [index, price] of prices.entries()) insert.run(`endpoint-${index}`, price.model, "https://site-cost.test/v1", "synthetic", price.model,
    index === 2 ? 0 : 1, timeoutMs, index, 1);
  insert.run("disabled-hunyuan", "disabled-hunyuan", "https://site-cost.test/v1", "synthetic", "hunyuan", 0, timeoutMs, 4, 0);
  const billing = new CommercialBilling(store, clock);
  const events: Record<string, unknown>[] = [];
  const meter = new CommercialMeter(store, clock, billing, { dailySafetyCap: 500, legacyBudget: { day: 3, week: 12 },
    logger: { warn(fields) { events.push(fields); } } });
  const router = new ModelRouter(store, { commercialMeter: meter, fetcher });
  const user = (id: string) => store.upsertUser(id, "Synthetic", "wechat");
  const run = <T>(id: string, call: () => Promise<T>) => runWithCallContext({ userId: user(id).id, source: "http" }, () => billing.action(call));
  const json = (id: string, scene: Scenario = "judge", input = messages) => run(id, () => router.client(scene).json(input, schema));
  const total = () => Object.values(store.setting<Record<string, number>>(COST_SAFETY_TOTALS) ?? {}).reduce((sum, value) => sum + value, 0);
  return { store, meter, billing, events, router, user, run, json, total };
}

test("production price/order fixture uses Opus for ordinary scenarios and only explicitly routes support", t => {
  const f = setup(async () => successful()); t.after(() => f.store.close());
  assert.deepEqual(f.router.endpoints().map(endpoint => endpoint.model), [...prices.map(price => price.model), "hunyuan"]);
  assert.deepEqual(f.router.routes(), { support: ["endpoint-2"] });
  for (const scene of ["chat.study", "recheck", "judge", "brainstorm", "vision"] as const)
    assert.equal(f.router.candidates(scene)[0]!.model, "claude-opus-5-5");
  for (const price of prices) {
    const snapshot = f.meter.pricing.snapshot("site-cost.test", price.model, "llm");
    assert.equal(f.meter.pricing.cost(snapshot, { inputTokens: 1_000_000, outputTokens: 1_000_000 }), Math.round((price.input + price.output) * 1_000_000));
  }
});

test("20 different free learners can keep high-thinking chat.study in flight at production prices", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sent = 0;
  const models: string[] = [];
  const f = setup((async (_url, init) => {
    sent++; models.push(JSON.parse(String(init?.body)).model);
    await gate;
    return successful();
  }) as typeof fetch); t.after(() => f.store.close());
  // Keep the separate monthly free-pool hold from masking site admission:
  // twenty unchanged eight-credit holds require 160 synthetic yuan. This is
  // fixture-only; the site limit remains its production default of 20 yuan.
  f.store.saveSetting("commercial.allowances", { freeDayCredits: 30, freeWeekCredits: 150, freeMonthCostMicroyuan: 1_000_000_000 });
  const pending = Promise.allSettled(Array.from({ length: 20 }, (_, i) => f.json(`concurrent-${i}`, "chat.study")));
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent, 20);
    assert.ok(models.every(model => model === "claude-opus-5-5"));
    assert.equal(f.total(), 4_636_800);
    assert.deepEqual(f.events, []);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_calls WHERE status='held' AND reserved_credits=8").get()!.n, 20,
      "credit holds still use the old 7.385472-yuan upper bound");
  } finally { release(); }
  const results = await pending;
  assert.ok(results.every(result => result.status === "fulfilled"));
  assert.equal(f.total(), 4_464_000, "successful calls settle the actual 2200 input / 800 output tokens");
});

for (const [scene, before, after, upperCredits] of [
  ["chat.study", 7_385_472, 231_840, 8],
  ["recheck", 13_283_712, 231_840, 14],
  ["judge", 1_855_872, 231_840, 2],
  ["brainstorm", 7_385_472, 231_840, 8],
  ["vision", 4_215_168, 268_704, 5],
] as const) {
  test(`${scene}: site estimate separates from the unchanged ${before}-microyuan credit upper hold`, async t => {
    let pendingRisk = 0;
    let heldCredits = 0;
    const f = setup(async () => {
      pendingRisk = f.total();
      heldCredits = Number(f.store.db.prepare("SELECT reserved_credits FROM commercial_calls WHERE status='held'").get()!.reserved_credits);
      throw new Error("synthetic unknown transport outcome");
    }); t.after(() => f.store.close());
    const account = f.user("scenario-user");
    const freeBefore = f.billing.accounts.available(account.id).free;
    await assert.rejects(f.json("scenario-user", scene, scene === "vision" ? imageMessages : messages), { billing: "unknown" });
    assert.equal(pendingRisk, after);
    assert.equal(f.total(), after, "one actual attempt does not retain the possible JSON retry upper bound");
    assert.equal(heldCredits, upperCredits);
    assert.equal(f.billing.accounts.available(account.id).free, freeBefore, "failed calls refund free learner credits");
  });
}

test("synthetic October 14 replay: 13 actual two-second Opus timeouts plus 25 representative successes stay below 20 yuan", async t => {
  let timeouts = true;
  let nextUsage = [2200, 800];
  const f = setup((async (_url, init) => {
    if (!timeouts) return successful(nextUsage[0], nextUsage[1]);
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
  }) as typeof fetch); t.after(() => f.store.close());
  // AbortSignal.timeout's timer is unref'd; a fake fetch has no socket to keep
  // the event loop alive while these real two-second timeouts are exercised.
  const keepAlive = setTimeout(() => {}, 5000); t.after(() => clearTimeout(keepAlive));
  const failures = await Promise.allSettled(Array.from({ length: 13 }, (_, i) => f.json(`replay-${i % 8}`)));
  assert.ok(failures.every(result => result.status === "rejected" && result.reason.code === "AI_TIMEOUT"));
  assert.equal(f.total(), 3_013_920);
  timeouts = false;
  // These 24 successes use illustrative values inside the supplied aggregate
  // ranges. The final success uses the supplied maximum token counts together;
  // no claim is made that this pair, or this daily success count, occurred.
  for (let i = 0; i < 24; i++) {
    nextUsage = [[1100, 200], [2200, 800], [3500, 1600]][i % 3]!;
    await f.json(`replay-${i % 8}`);
  }
  nextUsage = [7962, 4841]; await f.json("replay-0");
  assert.equal(f.total(), 9_874_332);
  assert.deepEqual(f.events, []);
});

for (const accounts of [1, 20]) {
  test(`${accounts} free account(s): 86 unknown attempts cost 19.93824 yuan and attempt 87 is denied before sending`, async t => {
    let sent = 0;
    const f = setup(async () => { sent++; throw new Error("synthetic unknown transport outcome"); });
    t.after(() => f.store.close());
    for (let i = 0; i < 86; i++) await assert.rejects(f.json(`abuse-${i % accounts}`), { billing: "unknown" });
    assert.equal(f.total(), 19_938_240);
    assert.equal(sent, 86);
    await assert.rejects(f.json("abuse-0"), { code: "COST_CIRCUIT_OPEN" });
    assert.equal(sent, 86);
    assert.equal(f.total(), 19_938_240);
    assert.ok(f.events.some(event => event.event === "cost_circuit_open" && event.reason === "site_day_cost"));
  });
}

test("four vision schema failures charge the full reported two-attempt usage, not the 16.86-yuan upper sum", async t => {
  let sent = 0;
  const f = setup(async () => { sent++; return successful(2200, 800, '{"ok":false}'); });
  t.after(() => f.store.close());
  for (let i = 0; i < 4; i++) await assert.rejects(f.json("schema-user", "vision", imageMessages), { code: "AI_BAD_OUTPUT", billing: "unknown" });
  assert.equal(sent, 8);
  assert.equal(f.total(), 1_785_600);
  assert.equal(f.store.db.prepare("SELECT SUM(cost_microyuan) cost FROM commercial_usage").get()!.cost, 1_785_600);
  assert.deepEqual(f.events, []);
});

test("invalid content shape retains complete provider usage and an actual zero-token failure costs zero", async t => {
  for (const [input, output, cost] of [[2200, 800, 223_200], [0, 0, 0]]) {
    const f = setup(async () => Response.json({ choices: [{ message: {} }], usage: { prompt_tokens: input, completion_tokens: output } }));
    t.after(() => f.store.close());
    await assert.rejects(f.json("missing-content"), { code: "AI_BAD_OUTPUT", billing: "unknown" });
    assert.equal(f.total(), cost);
    assert.equal(f.store.db.prepare("SELECT cost_microyuan FROM commercial_usage").get()!.cost_microyuan, cost);
  }
});

test("partial streaming without usage counts the observed 1500 output tokens above the 1024 estimate", async t => {
  const partial = "答".repeat(3000);
  let delivered = "";
  const f = setup(async () => {
    let first = true;
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (first) {
        first = false;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: partial } }] })}\n\n`));
      } else controller.error(new Error("synthetic stream disconnected"));
    } }), { headers: { "content-type": "text/event-stream" } });
  }); t.after(() => f.store.close());
  await assert.rejects(f.run("partial-stream", () => f.router.client("chat.study").stream(messages, { onText(piece) { delivered += piece; } })), { billing: "unknown" });
  assert.equal(delivered, partial);
  assert.equal(f.total(), 317_520);
  const row = f.store.db.prepare("SELECT usage FROM commercial_usage").get()!;
  assert.equal(JSON.parse(String(row.usage)).estimated, true);
});

test("a corrective JSON retry that disconnects accounts for both attempted requests without using the theoretical limit", async t => {
  let sent = 0;
  const f = setup(async () => {
    if (++sent === 1) return successful(100, 10, '{"ok":false}');
    throw new Error("synthetic second-attempt disconnection");
  }); t.after(() => f.store.close());
  await assert.rejects(f.json("partial-json"), { billing: "unknown" });
  assert.equal(sent, 2);
  assert.equal(f.total(), 463_680);
});

test("twenty no-billing 503 failures across all four enabled endpoints consume zero site risk", async t => {
  let sent = 0;
  const f = setup(async () => { sent++; return new Response("synthetic unavailable", { status: 503 }); });
  t.after(() => f.store.close());
  for (let i = 0; i < 20; i++) await assert.rejects(f.json(`unavailable-${i % 8}`), { billing: "none" });
  assert.equal(sent, 80);
  assert.equal(f.total(), 0);
  assert.deepEqual(f.events, []);
});
