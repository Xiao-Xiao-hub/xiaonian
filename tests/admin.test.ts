import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { MIGRATIONS, SqliteStore } from "../server/src/shared/store.js";
import { chinaDate, chinaDayStart } from "../server/src/shared/time.js";
import { fakeServices, NOTE, PROBLEM } from "./fixtures.js";

const KEY = "synthetic-admin-key-for-isolated-tests-01";
const SECRET_QUESTION = "为什么我总是记不住三角函数公式";

function setup(env: Record<string, string> = {}) {
  const store = new SqliteStore(":memory:");
  const app = buildApp({
    store,
    fetcher: fakeServices().fetcher,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "test-llm",
      JEV_API_KEY: "test-jev",
      ADMIN_API_KEY: KEY,
      ...env,
    }),
  });
  const get = async (url: string) => {
    const res = await app.inject({ url, headers: { "x-admin-key": KEY } });
    assert.equal(res.statusCode, 200, res.body);
    return { data: res.json().data, body: res.body };
  };
  return { app, store, get };
}
async function learner(app: ReturnType<typeof setup>["app"], key: string) {
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: { key },
  });
  const { token, user } = login.json().data;
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({
      method: method as "GET",
      url,
      payload: payload as string,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.ok(res.statusCode < 300, res.body);
    return res.json().data;
  };
  const material = async (kind: string, text: string, confirm: boolean) => {
    const { id } = await call("POST", "/v1/materials", { kind, text });
    if (confirm)
      await call("PUT", `/v1/materials/${id}`, {
        expectedVersion: 1,
        confirm: true,
      });
    return id as string;
  };
  return { call, material, userId: user.id as string };
}
// Rows are written directly so status, timing and age are exact.
function seedJobs(store: SqliteStore, userId: string) {
  const insert = store.db.prepare(
    "INSERT INTO jobs(id,user_id,kind,params,params_hash,status,error_code,error_message,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const params = JSON.stringify({ question: SECRET_QUESTION });
  let n = 0;
  const job = (
    kind: string,
    status: string,
    ageMs: number,
    tookMs: number | null,
    error: [string, string] | null = null,
  ) =>
    insert.run(
      `job_${++n}`,
      userId,
      kind,
      params,
      `h${n}`,
      status,
      error?.[0] ?? null,
      error?.[1] ?? null,
      at(ageMs),
      tookMs === null ? null : at(ageMs - tookMs),
    );
  job("explain", "succeeded", 60_000, 10_000);
  job("explain", "succeeded", 50_000, 20_000);
  job("explain", "failed", 40_000, 1_000, [
    "AI_BAD_OUTPUT",
    "AI 返回的内容格式不对，请重试",
  ]);
  job("ask", "unknown", 30_000, 5_000, [
    "AI_TIMEOUT",
    "AI 生成超时。重试可能再次产生调用费用",
  ]);
  job("ask", "queued", 1_000, null);
  // Older than the 7-day window: left out of the counts, still listed as a recent failure.
  job("explain", "failed", 8 * 86400_000, 1_000, [
    "AI_BUSY",
    "AI 服务繁忙，请稍后重试",
  ]);
}

test("admin job summary counts the last 7 days per kind without exposing params or users", async () => {
  const { app, store, get } = setup();
  try {
    const denied = await app.inject({ url: "/v1/admin/jobs" });
    assert.equal(denied.statusCode, 401);
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: {},
    });
    const userId = login.json().data.user.id as string;
    seedJobs(store, userId);
    const { data, body } = await get("/v1/admin/jobs");
    assert.equal(data.from, chinaDate(Date.now() - 6 * 86400_000));
    const kind = (name: string) =>
      data.kinds.find((k: { kind: string }) => k.kind === name);
    assert.deepEqual(kind("explain"), {
      kind: "explain",
      queued: 0,
      running: 0,
      succeeded: 2,
      failed: 1,
      unknown: 0,
      avgSec: 15,
      p95Sec: 20,
    });
    assert.deepEqual(kind("ask"), {
      kind: "ask",
      queued: 1,
      running: 0,
      succeeded: 0,
      failed: 0,
      unknown: 1,
      avgSec: null,
      p95Sec: null,
    });
    // Every job kind the server runs is listed, even with no jobs yet.
    for (const name of ["ocr", "quiz", "hints", "variant", "feedback"])
      assert.equal(kind(name)?.succeeded, 0, name);
    assert.deepEqual(
      data.recent.map((j: { id: string }) => j.id),
      ["job_4", "job_3", "job_6"],
    );
    assert.deepEqual(data.recent[0], {
      id: "job_4",
      kind: "ask",
      status: "unknown",
      code: "AI_TIMEOUT",
      message: "AI 生成超时。重试可能再次产生调用费用",
      createdAt: data.recent[0].createdAt,
      finishedAt: data.recent[0].finishedAt,
      retryable: false,
    });
    // Only recent provider failures can be retried : not an unknown
    // result, not one older than 7 days.
    assert.deepEqual(
      data.recent.map((j: { retryable: boolean }) => j.retryable),
      [false, true, false],
    );
    assert.ok(!body.includes(SECRET_QUESTION));
    assert.ok(!body.includes(userId));
    assert.deepEqual(data.summary, {
      total: 5,
      finished: 4,
      succeeded: 2,
      failed: 1,
      unknown: 1,
      successRate: 0.5,
      failureRate: 0.25,
      p95Sec: 20,
    });
    assert.equal(data.queue.queued, 1);
    assert.equal(data.queue.running, 0);
    assert.equal(data.queue.oldestRunningSec, null);
    assert.ok(data.queue.oldestQueuedSec >= 1);
  } finally {
    await app.close();
  }
});

test("admin quality summary counts materials, drafts and reports by reason without their text", async () => {
  const { app, store, get } = setup();
  try {
    const denied = await app.inject({ url: "/v1/admin/quality" });
    assert.equal(denied.statusCode, 401);
    const a = await learner(app, "a");
    const b = await learner(app, "b");
    const note = await a.material("note", NOTE, true);
    const draft = await b.material("note", "草稿里的私人笔记内容", false);
    await a.material("problem", PROBLEM, true);
    store.db
      .prepare("UPDATE materials SET image_path='u/draft.jpg' WHERE id=?")
      .run(draft);
    const { job } = await a.call("POST", `/v1/materials/${note}/explain`, {});
    for (let i = 0; i < 200; i++) {
      const state = await a.call("GET", `/v1/jobs/${job.id}`);
      if (state.status === "succeeded") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const { explain } = await a.call("GET", `/v1/materials/${note}/study`);
    const privateNote = "讲解第二段和我的笔记对不上";
    await a.call("POST", `/v1/artifacts/${explain.id}/report`, {
      reason: "wrong",
    });
    await a.call("POST", `/v1/artifacts/${explain.id}/report`, {
      reason: "citation",
      note: privateNote,
    });
    const { data, body } = await get("/v1/admin/quality");
    assert.deepEqual(data.materials, [
      { kind: "note", draft: 1, confirmed: 1, images: 1 },
      { kind: "problem", draft: 0, confirmed: 1, images: 0 },
    ]);
    const explainRow = data.generated.find(
      (g: { kind: string }) => g.kind === "explain",
    );
    assert.deepEqual(explainRow, {
      kind: "explain",
      count: 1,
      reported: 1,
      reports: { wrong: 1, unclear: 0, citation: 1, other: 0 },
    });
    assert.deepEqual(
      data.generated.map((g: { kind: string }) => g.kind),
      ["explain", "answer", "quiz", "hints", "variant"],
    );
    for (const secret of [
      privateNote,
      "草稿里的私人笔记",
      "太阳加热水面",
      "一件衣服原价",
      a.userId,
      b.userId,
      explain.id,
    ])
      assert.ok(!body.includes(secret), secret);
  } finally {
    await app.close();
  }
});

test("admin quality counts map reports per point without answers or reporters (D018)", async () => {
  const { app, get } = setup();
  try {
    const a = await learner(app, "a");
    const b = await learner(app, "b");
    const secret = "-0.0833";
    const report = (who: typeof a, pointId: string, body: object) =>
      who.call("POST", `/v1/learn/points/${pointId}/report`, body);
    await report(a, "limit-rules", { reason: "judge", answer: secret });
    await report(a, "limit-rules", { reason: "judge" });
    await report(b, "limit-rules", { reason: "unclear" });
    await report(b, "indefinite-parts", { reason: "problem" });
    await report(b, "indefinite-parts", { reason: "other", answer: "x" });
    await report(a, "application-taylor-limit", { reason: "judge" });
    const { data, body } = await get("/v1/admin/quality");
    assert.deepEqual(data.mapReports, [
      {
        pointId: "limit-rules",
        name: data.mapReports[0].name,
        chapter: "极限",
        total: 3,
        users: 2,
        reasons: { judge: 2, problem: 0, unclear: 1, other: 0 },
      },
      {
        pointId: "indefinite-parts",
        name: data.mapReports[1].name,
        chapter: "不定积分",
        total: 2,
        users: 1,
        reasons: { judge: 0, problem: 1, unclear: 0, other: 1 },
      },
      {
        pointId: "application-taylor-limit",
        name: "泰勒公式求极限",
        chapter: "中值与应用",
        total: 1,
        users: 1,
        reasons: { judge: 1, problem: 0, unclear: 0, other: 0 },
      },
    ]);
    assert.ok(data.mapReports[0].name.length > 0);
    for (const hidden of [secret, a.userId, b.userId, "mrp_", "understood"])
      assert.ok(!body.includes(hidden), hidden);
    // Points without a report are not listed.
    assert.equal(data.mapReports.length, 3);
  } finally {
    await app.close();
  }
});

test("admin usage counts today's quota like the runner, sums model tokens and sizes storage", async () => {
  const uploads = join(mkdtempSync(join(tmpdir(), "zhiye-")), "uploads");
  const { app, store, get } = setup({
    DAILY_AI_LIMIT: "5",
    DAILY_OCR_LIMIT: "3",
    UPLOAD_DIR: uploads,
  });
  try {
    const denied = await app.inject({ url: "/v1/admin/usage" });
    assert.equal(denied.statusCode, 401);
    const [a, b, c] = await Promise.all(
      ["a", "b", "c"].map((key) => learner(app, key)),
    );
    const insert = store.db.prepare(
      "INSERT INTO jobs(id,user_id,kind,params,params_hash,status,usage,created_at) VALUES(?,?,?,'{}',?,?,?,?)",
    );
    let n = 0;
    const today = new Date().toISOString();
    const yesterday = new Date(
      Date.parse(chinaDayStart()) - 3600_000,
    ).toISOString();
    const job = (
      userId: string,
      kind: string,
      usage: unknown = null,
      at = today,
      status = "succeeded",
    ) =>
      insert.run(
        `job_${++n}`,
        userId,
        kind,
        `h${n}`,
        status,
        usage === null ? null : JSON.stringify(usage),
        at,
      );
    const llm = (
      calls: number,
      promptTokens: number,
      completionTokens: number,
    ) => ({
      provider: "test",
      model: "test",
      calls,
      promptTokens,
      completionTokens,
      ms: 1,
    });
    // a: 4 of 5 AI jobs (near the limit); b: 5 of 5, one failed but billed.
    for (let i = 0; i < 3; i++) job(a.userId, "explain", llm(1, 100, 40));
    job(a.userId, "feedback", [llm(1, 50, 10), llm(2, 70, 20)]);
    for (let i = 0; i < 4; i++) job(b.userId, "ask");
    job(b.userId, "ask", llm(1, 30, 0), today, "unknown");
    // c: yesterday's AI job is not counted; today's OCR carries no tokens.
    job(c.userId, "quiz", llm(9, 999, 999), yesterday);
    job(c.userId, "ocr", { provider: "tencent-ocr", calls: 1 });

    const before = (await get("/v1/admin/usage")).data;
    assert.deepEqual(before.storage.uploads, { files: 0, bytes: 0 });
    mkdirSync(join(uploads, "u1"), { recursive: true });
    writeFileSync(join(uploads, "u1", "one.jpg"), Buffer.alloc(300));
    writeFileSync(join(uploads, "two.png"), Buffer.alloc(200));

    const { data, body } = await get("/v1/admin/usage");
    assert.equal(data.date, chinaDate());
    assert.deepEqual(data.buckets, [
      { bucket: "ai", limit: 5, jobs: 9, users: 2, nearLimit: 1, atLimit: 1 },
      { bucket: "ocr", limit: 3, jobs: 1, users: 1, nearLimit: 0, atLimit: 0 },
      {
        bucket: "notes",
        limit: 30,
        jobs: 0,
        users: 0,
        nearLimit: 0,
        atLimit: 0,
      },
      {
        bucket: "brainstorm",
        limit: 10,
        jobs: 0,
        users: 0,
        nearLimit: 0,
        atLimit: 0,
      },
      {
        bucket: "import",
        limit: 10,
        jobs: 0,
        users: 0,
        nearLimit: 0,
        atLimit: 0,
      },
      {
        bucket: "chat",
        limit: 60,
        jobs: 0,
        users: 0,
        nearLimit: 0,
        atLimit: 0,
      },
      {
        bucket: "photos",
        limit: 20,
        jobs: 0,
        users: 0,
        nearLimit: 0,
        atLimit: 0,
      },
    ]);
    // The learner sees the same count the admin view is built from, except
    // that  it reads "used up" only once the budget is.
    assert.equal((await b.call("GET", "/v1/me/usage")).ai.used, 4);
    assert.equal((await a.call("GET", "/v1/me/usage")).ai.used, 4);
    assert.deepEqual(data.llm, {
      calls: 7,
      promptTokens: 450,
      completionTokens: 150,
    });
    assert.ok(data.storage.databaseBytes > 0);
    assert.equal(data.storage.schemaVersion, MIGRATIONS.length);
    assert.deepEqual(data.storage.uploads, { files: 2, bytes: 500 });
    for (const id of [a.userId, b.userId, c.userId])
      assert.ok(!body.includes(id));
  } finally {
    await app.close();
  }
});
