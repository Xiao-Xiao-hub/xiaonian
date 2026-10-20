// the learner quota is a yuan budget per business day and per week,
// priced from each call's recorded tokens and the admin's price table.
// Failures cost nothing; the action that crosses the line still finishes.
import assert from "node:assert/strict";
import test from "node:test";
import { fakeServices, makeApp } from "./fixtures.js";
import { SqliteStore } from "../server/src/shared/store.js";
import {
  Budget,
  DEFAULT_PRICES,
  priceOf,
  unpriced,
  usageCost,
  type Price,
} from "../server/src/shared/budget.js";
import { JobError, JobRunner } from "../server/src/modules/jobs/runner.js";
import { LearnService } from "../server/src/modules/learn/service.js";
import { monthlyCost } from "../server/src/modules/admin/cost.js";
import { chinaWeekStart } from "../server/src/shared/time.js";

const KEY = "g".repeat(40);
const GLM = { provider: "open.bigmodel.cn", model: "glm-5.3" };
// ¥1.40: 50,000 output tokens at ¥28 per million.
const big = { ...GLM, calls: 1, promptTokens: 0, completionTokens: 50_000 };

function unit(at = "2026-10-14T02:00:00.000Z", budget = { day: 2, week: 5 }) {
  const clock = { at: new Date(at) };
  const store = new SqliteStore(":memory:", () => clock.at);
  const userId = store.upsertUser("dev:g4", "测试", "dev").id;
  const quota = new Budget(store, { ...budget, cap: 500 }, () => clock.at);
  return { clock, store, userId, quota };
}

test("cost comes from tokens and the price table; an unpriced model pays the highest rate", () => {
  const table = DEFAULT_PRICES;
  // 900 fresh input, 100 cached, 1000 output at glm-5.3 (8 / 2 / 28).
  assert.equal(
    usageCost({ ...GLM, promptTokens: 1000, cachedTokens: 100, completionTokens: 1000 }, table),
    (900 * 8 + 100 * 2 + 1000 * 28) / 1_000_000,
  );
  // A list is summed; calls without a model (OCR, Jev) and missing tokens cost nothing.
  assert.equal(
    usageCost(
      JSON.stringify([
        { ...GLM, promptTokens: 1_000_000, completionTokens: 0 },
        { provider: "ocr.tencentcloudapi.com", calls: 1 },
        { ...GLM },
      ]),
      table,
    ),
    8,
  );
  // 该模型的价格配置没有指定 host，因此可以匹配任意网关主机。
  const opus = priceOf(table, "api.example.test", "claude-opus-5-5");
  assert.equal(opus.known, true);
  assert.deepEqual([opus.rate.input, opus.rate.output, opus.rate.cached], [36, 180, 3.6]);
  // A host-specific row wins over the any-host row.
  const custom: Price[] = [
    ...table,
    { host: "api.example.test", model: "claude-opus-5-5", input: 1, output: 2, cached: 0.1, note: "" },
  ];
  assert.equal(priceOf(custom, "api.example.test", "claude-opus-5-5").rate.input, 1);
  // Unknown: the dearest of each kind in the table.
  const unknown = priceOf(table, "tokenhub.example.test", "mystery-model");
  assert.equal(unknown.known, false);
  assert.deepEqual([unknown.rate.input, unknown.rate.output, unknown.rate.cached], [36, 180, 3.6]);
  assert.equal(
    usageCost({ provider: "x", model: "mystery-model", promptTokens: 0, completionTokens: 1_000_000 }, table),
    180,
  );
});

test("day and week windows follow China midnight and Monday; the crossing action finishes", () => {
  // Wednesday 2026-10-14, 10:00 in Beijing.
  const f = unit();
  try {
    assert.equal(chinaWeekStart(f.clock.at.getTime()), "2026-10-11T16:00:00.000Z");
    assert.deepEqual(f.quota.view(f.userId), {
      day: { pct: 0, resetAt: "2026-10-14T16:00:00.000Z" },
      week: { pct: 0, resetAt: "2026-10-18T16:00:00.000Z" },
    });
    f.quota.check(f.userId);
    f.quota.charge(f.userId, "job", "a", big);
    // ¥1.40 of ¥2: still allowed, so the next action may start and cross.
    assert.equal(f.quota.view(f.userId).day.pct, 70);
    f.quota.check(f.userId);
    f.quota.charge(f.userId, "job", "b", big);
    // The same id is charged once.
    f.quota.charge(f.userId, "job", "b", big);
    const status = f.quota.status(f.userId);
    assert.ok(Math.abs(status.day.spent - 2.8) < 1e-9);
    assert.equal(status.day.pct, 100);
    assert.equal(status.week.pct, 56);
    assert.throws(
      () => f.quota.check(f.userId),
      (error: { statusCode: number; code: string; message: string }) =>
        error.statusCode === 429 &&
        error.code === "DAILY_LIMIT" &&
        error.message === "今天的额度用完了，明天 0 点恢复",
    );
    // Beijing midnight: the day is new, the week remembers.
    f.clock.at = new Date("2026-10-14T16:00:00.000Z");
    f.quota.check(f.userId);
    f.quota.charge(f.userId, "job", "c", big);
    f.quota.charge(f.userId, "job", "d", big);
    assert.equal(f.quota.view(f.userId).week.pct, 100);
    assert.equal(f.quota.blocked(f.userId)?.message, "这周的额度用完了，下周一 0 点恢复");
    assert.equal(f.quota.blocked(f.userId)?.resetAt, "2026-10-18T16:00:00.000Z");
    // Sunday: the week ends tonight, so it comes back tomorrow.
    f.clock.at = new Date("2026-10-18T04:00:00.000Z");
    assert.equal(f.quota.blocked(f.userId)?.message, "这周的额度用完了，明天 0 点恢复");
    // Monday 00:00 Beijing: both are fresh.
    f.clock.at = new Date("2026-10-18T16:00:00.000Z");
    assert.equal(f.quota.blocked(f.userId), null);
    assert.deepEqual(f.quota.view(f.userId), {
      day: { pct: 0, resetAt: "2026-10-19T16:00:00.000Z" },
      week: { pct: 0, resetAt: "2026-10-25T16:00:00.000Z" },
    });
  } finally {
    f.store.close();
  }
});

test("budgets: the account's own, else the admin's, else the environment; a hidden daily cap", () => {
  const f = unit();
  try {
    assert.deepEqual(f.quota.for(f.userId), { day: 2, week: 5 });
    f.store.saveSetting("quota.budget", { day: 1, week: 4 });
    assert.deepEqual(f.quota.for(f.userId), { day: 1, week: 4 });
    f.store.db
      .prepare("UPDATE users SET quota=? WHERE id=?")
      .run(JSON.stringify({ chat: 5, budget: { day: 10, week: "x" } }), f.userId);
    assert.deepEqual(f.quota.for(f.userId), { day: 10, week: 4 });
    // Old count fields for 0.4.0–0.6.0: the limit stays, what is left shrinks.
    assert.deepEqual(f.quota.legacy(60, { day: { pct: 0 }, week: { pct: 0 } }), { used: 0, limit: 60 });
    assert.deepEqual(f.quota.legacy(60, { day: { pct: 50 }, week: { pct: 80 } }), { used: 48, limit: 60 });
    assert.deepEqual(f.quota.legacy(10, { day: { pct: 99 }, week: { pct: 0 } }), { used: 9, limit: 10 });
    assert.deepEqual(f.quota.legacy(10, { day: { pct: 100 }, week: { pct: 0 } }), { used: 10, limit: 10 });
    // Today's real count shows while it is larger, never reaching the limit
    // before the budget does.
    assert.deepEqual(f.quota.legacy(60, { day: { pct: 1 }, week: { pct: 0 } }, 5), { used: 5, limit: 60 });
    assert.deepEqual(f.quota.legacy(10, { day: { pct: 0 }, week: { pct: 0 } }, 12), { used: 9, limit: 10 });
    // The cap counts unvoided receipts of the day.
    const capped = new Budget(f.store, { day: 2, week: 5, cap: 2 }, () => f.clock.at);
    const receipt = f.store.db.prepare(
      "INSERT INTO quota_receipts(source,source_id,user_id,kind,created_at) VALUES('chat',?,?,'answer',?)",
    );
    receipt.run("r1", f.userId, f.clock.at.toISOString());
    capped.check(f.userId);
    assert.equal(capped.allows(f.userId, 2), false);
    receipt.run("r2", f.userId, f.clock.at.toISOString());
    assert.throws(() => capped.check(f.userId), /歇一歇/);
    // A charge for an erased account writes nothing.
    f.quota.charge("usr_gone", "job", "z", big);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) n FROM quota_spend WHERE user_id='usr_gone'").get()!.n,
      0,
    );
  } finally {
    f.store.close();
  }
});

test("only a succeeded job is spent, even when its receipt is void; failures are free", async () => {
  const f = unit(undefined, { day: 2.5, week: 10 });
  let fail = false;
  const runner = new JobRunner(
    f.store,
    {
      explain: {
        quota: "ai",
        run: async () => {
          if (fail)
            throw Object.assign(new JobError("SYNTHETIC", "失败了"), { usage: big });
          return { output: {}, usage: big };
        },
      },
    },
    { concurrency: 1, timeoutMs: 5000, limits: { ai: 1 }, budget: f.quota, now: () => f.clock.at },
  );
  try {
    const done = (id: string) =>
      new Promise<void>((resolve) => {
        const poll = () =>
          ["succeeded", "failed", "unknown"].includes(runner.get(id)!.status)
            ? resolve()
            : setTimeout(poll, 5);
        poll();
      });
    // The count limit of 1 no longer applies with a budget.
    const first = runner.enqueue({ userId: f.userId, kind: "explain", params: { n: 1 } }).job;
    // A void receipt (a brainstorm's report, V4.2 G1b) still spends its usage.
    f.store.db
      .prepare(
        "INSERT INTO quota_voids(source,source_id,user_id,job_id,created_at) SELECT source,source_id,user_id,?,? FROM quota_receipts WHERE source='job' AND source_id=?",
      )
      .run(first.id, f.clock.at.toISOString(), first.id);
    await done(first.id);
    fail = true;
    const second = runner.enqueue({ userId: f.userId, kind: "explain", params: { n: 2 } }).job;
    await done(second.id);
    assert.equal(runner.get(second.id)!.status, "failed");
    fail = false;
    const third = runner.enqueue({ userId: f.userId, kind: "explain", params: { n: 3 } }).job;
    await done(third.id);
    const spent = f.store.db
      .prepare("SELECT source_id FROM quota_spend WHERE user_id=? ORDER BY source_id")
      .all(f.userId)
      .map((row) => row.source_id);
    assert.deepEqual(spent, [first.id, third.id].sort());
    // ¥2.80 of ¥2.50: the next job is stopped before it starts.
    assert.equal(runner.available(f.userId, "ai", 3), 0);
    assert.throws(
      () => runner.enqueue({ userId: f.userId, kind: "explain", params: { n: 4 } }),
      /今天的额度用完了，明天 0 点恢复/,
    );
  } finally {
    await runner.stop();
    f.store.close();
  }
});

test("卡点 help is spent when it reaches the student, from its own usage", async () => {
  const f = unit();
  try {
    const llm = {
      json: async (_m: unknown, schema: { parse: (v: unknown) => unknown }) => ({
        data: schema.parse({
          quote: "",
          hint: "先写成 e 的指数。",
          ask: "指数部分会求吗？",
          options: ["会", "不会"],
          suggest: null,
        }),
        usage: big,
      }),
    };
    const learn = new LearnService(f.store, () => f.clock.at, {
      llm,
      safety: { check: async () => false },
      budget: f.quota,
    } as unknown as ConstructorParameters<typeof LearnService>[2]);
    learn.mark(f.userId, "stuck", "limit-1-to-inf");
    await learn.stuckGuide(f.userId, "limit-1-to-inf", "不会化", () => false);
    assert.equal(f.quota.status(f.userId).day.spent, 0, "not seen yet: not spent");
    learn.stuckHelp(f.userId, "limit-1-to-inf");
    assert.ok(Math.abs(f.quota.status(f.userId).day.spent - 1.4) < 1e-9);
    const id = f.store.db
      .prepare("SELECT source_id FROM quota_receipts WHERE user_id=? AND kind='map_stuck'")
      .get(f.userId)!.source_id;
    assert.equal(
      f.store.db.prepare("SELECT source_id FROM quota_spend WHERE user_id=?").get(f.userId)!.source_id,
      id,
    );
    // The admin's monthly estimate takes it from the spend row.
    const month = monthlyCost(f.store, f.userId, f.clock.at.getTime());
    assert.equal(month.stuckCalls, 1);
    assert.ok(Math.abs(month.amount - 1.4) < 1e-9);
    // Delivered help: a second one is stopped while the day is used up.
    f.quota.charge(f.userId, "job", "x", big);
    learn.mark(f.userId, "stuck", "limit-order");
    await assert.rejects(
      learn.stuckGuide(f.userId, "limit-order", "不会", () => true),
      /今天的额度用完了/,
    );
  } finally {
    f.store.close();
  }
});

async function appFixture(env: Record<string, string> = {}) {
  const clock = { at: new Date("2026-10-14T02:00:00.000Z") };
  const store = new SqliteStore(":memory:");
  const services = fakeServices();
  // Chat replies stream; the shared fake answers JSON only.
  const json = services.fetcher;
  services.fetcher = (async (url: string | URL | Request, init?: RequestInit) =>
    JSON.parse(String(init?.body)).stream
      ? new Response(
          'data: {"choices":[{"delta":{"content":"先看看分子分母。"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        )
      : json(url, init)) as typeof fetch;
  const app = makeApp(services, { ADMIN_API_KEY: KEY, ...env }, () => clock.at, store);
  const login = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "g4" } });
  const userId = login.json().data.user.id as string;
  const headers = { authorization: `Bearer ${login.json().data.token}` };
  const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  const admin = (method: "GET" | "PUT", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { "x-admin-key": KEY }, ...(payload === undefined ? {} : { payload }) });
  return { app, store, clock, userId, call, admin, services };
}

test("/v1/me/usage keeps every old field and adds the budget percentages", async (t) => {
  const f = await appFixture({ DAILY_BUDGET_CNY: "2", WEEKLY_BUDGET_CNY: "5" });
  t.after(() => f.app.close());
  const before = (await f.call("GET", "/v1/me/usage")).json().data;
  assert.deepEqual(Object.keys(before).sort(), [
    "ai", "brainstorm", "budget", "chat", "date", "import", "notes", "ocr", "photos",
  ]);
  assert.deepEqual(before.chat, { used: 0, limit: 60 });
  assert.deepEqual(before.budget, {
    day: { pct: 0, resetAt: "2026-10-14T16:00:00.000Z" },
    week: { pct: 0, resetAt: "2026-10-18T16:00:00.000Z" },
  });
  const quota = new Budget(f.store, { day: 2, week: 5, cap: 500 }, () => f.clock.at);
  quota.charge(f.userId, "job", "a", big);
  const after = (await f.call("GET", "/v1/me/usage")).json().data;
  assert.equal(after.budget.day.pct, 70);
  assert.equal(after.budget.week.pct, 28);
  // 70% used: 30% of the 60 answers left.
  assert.deepEqual(after.chat, { used: 42, limit: 60 });
  const chat = (await f.call("GET", "/v1/chat/usage")).json().data;
  assert.deepEqual(chat.budget, after.budget);
  assert.deepEqual(chat.answers, { used: 42, limit: 60 });
  quota.charge(f.userId, "job", "b", big);
  const out = (await f.call("GET", "/v1/me/usage")).json().data;
  assert.deepEqual(out.ai, { used: 200, limit: 200 });
  assert.equal(out.budget.day.pct, 100);
});

test("a chat reply that crosses the budget finishes; the next send is stopped kindly", async (t) => {
  // The test model is unpriced: 3 + 2 tokens at the highest rate ≈ ¥0.0005.
  const f = await appFixture({ DAILY_BUDGET_CNY: "0.0001" });
  t.after(() => f.app.close());
  const first = await f.call("POST", "/v1/chat/send", { text: "极限怎么求？", clientId: "g4-ask-1" });
  assert.equal(first.statusCode, 200, first.body);
  assert.doesNotMatch(first.body, /"e":"error"/);
  const spent = f.store.db
    .prepare("SELECT source,usage FROM quota_spend WHERE user_id=?")
    .all(f.userId);
  assert.ok(spent.length >= 1);
  const second = await f.call("POST", "/v1/chat/send", { text: "再问一个", clientId: "g4-ask-2" });
  assert.equal(second.statusCode, 429, second.body);
  assert.equal(second.json().code, "DAILY_LIMIT");
  assert.equal(second.json().message, "今天的额度用完了，明天 0 点恢复");
  // Beijing midnight brings it back.
  f.clock.at = new Date("2026-10-14T16:00:01.000Z");
  const third = await f.call("POST", "/v1/chat/send", { text: "再问一个", clientId: "g4-ask-3" });
  assert.equal(third.statusCode, 200, third.body);
  assert.doesNotMatch(third.body, /"e":"error"/);
});

test("admin: price table edit, unpriced warning, budgets and per-account spend", async (t) => {
  const f = await appFixture();
  t.after(() => f.app.close());
  const settings = (await f.admin("GET", "/v1/admin/settings")).json().data;
  assert.deepEqual(settings.budget, {
    current: { day: 3, week: 12 },
    defaults: { day: 3, week: 12 },
    safetyCap: 500,
  });
  assert.deepEqual(settings.prices.rows, DEFAULT_PRICES);
  assert.equal(settings.prices.custom, false);
  // The test endpoint's model has no price: listed, and on the to-do list.
  assert.equal(settings.prices.unpriced.length, 1);
  const { host, model } = settings.prices.unpriced[0];
  assert.deepEqual(unpriced(f.store), settings.prices.unpriced);
  const todo = (await f.admin("GET", "/v1/admin/todo")).json().data;
  assert.deepEqual(todo.ai.unpriced, [model]);
  // Adding its row clears the warning and prices its calls.
  const rows = [...DEFAULT_PRICES, { host, model, input: 1, output: 2, cached: 0.5, note: "测试价" }];
  const saved = await f.admin("PUT", "/v1/admin/settings/prices", { rows });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json().data.prices.unpriced, []);
  assert.equal(saved.json().data.prices.custom, true);
  assert.equal(
    (await f.admin("PUT", "/v1/admin/settings/prices", { rows: [...rows, rows[0]] })).statusCode,
    400,
  );
  assert.equal(
    (await f.admin("PUT", "/v1/admin/settings/prices", { rows: [{ ...rows[0], input: -1 }] })).statusCode,
    400,
  );
  // Global budget.
  const budget = await f.admin("PUT", "/v1/admin/settings/budget", { day: 1.5 });
  assert.deepEqual(budget.json().data.budget.current, { day: 1.5, week: 12 });
  // Per-account budget keeps the count overrides, and back.
  const path = `/v1/admin/users/${f.userId}/quota`;
  await f.admin("PUT", path, { chat: 5 });
  const own = await f.admin("PUT", path, { budget: { day: 0.5 } });
  assert.equal(own.statusCode, 200, own.body);
  assert.deepEqual(own.json().data.quota, { chat: 5 });
  assert.deepEqual(own.json().data.budget.overrides, { day: 0.5 });
  assert.equal(own.json().data.budget.day.budget, 0.5);
  assert.equal(own.json().data.budget.week.budget, 12);
  await f.admin("PUT", path, { chat: null });
  assert.deepEqual(
    JSON.parse(String(f.store.db.prepare("SELECT quota FROM users WHERE id=?").get(f.userId)!.quota)),
    { budget: { day: 0.5 } },
  );
  await f.admin("PUT", path, { budget: { day: null } });
  assert.equal(f.store.db.prepare("SELECT quota FROM users WHERE id=?").get(f.userId)!.quota, null);
  // Spend in yuan: day, week and month.
  new Budget(f.store, { day: 3, week: 12, cap: 500 }, () => f.clock.at).charge(f.userId, "job", "a", big);
  const detail = (await f.admin("GET", `/v1/admin/users/${f.userId}`)).json().data;
  assert.ok(Math.abs(detail.budget.day.spent - 1.4) < 1e-9);
  assert.ok(Math.abs(detail.budget.month - 1.4) < 1e-9);
  const list = (await f.admin("GET", "/v1/admin/users")).json().data;
  const row = list.items.find((item: { id: string }) => item.id === f.userId);
  assert.ok(Math.abs(row.spend.week - 1.4) < 1e-9);
  assert.deepEqual(list.budget, { day: 1.5, week: 12 });
});
