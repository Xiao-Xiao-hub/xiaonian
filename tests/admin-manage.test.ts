import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { PROBLEMS } from "../server/src/modules/learn/problems.js";
import type { JobHandler } from "../server/src/modules/jobs/runner.js";
import { fakeServices, NOTE } from "./fixtures.js";

// The admin workbench : feedback with the reported answer, accounts
// (ban, per-account quota), in-place retry, problem bank, settings, audit.
const KEY = "synthetic-admin-key-for-isolated-tests-01";
const NOTE_SECRET = "随心记里只写给自己看的秘密句子";
const CHAT_SECRET = "问AI对话里不该被管理员看到的原话";

function setup(
  env: Record<string, string> = {},
  fetcher: typeof fetch = fakeServices().fetcher,
  handlers: Record<string, JobHandler> = {},
) {
  const store = new SqliteStore(":memory:");
  const app = buildApp({
    store,
    fetcher,
    handlers,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "test-llm",
      JEV_API_KEY: "test-jev",
      ADMIN_API_KEY: KEY,
      DAILY_NOTES_LIMIT: "10",
      ...env,
    }),
  });
  const bodies: string[] = [];
  const admin = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({
      method: method as "GET",
      url,
      payload: payload as string,
      headers: { "x-admin-key": KEY },
    });
    bodies.push(res.body);
    return res;
  };
  const get = async (url: string) => {
    const res = await admin("GET", url);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().data;
  };
  return { app, store, admin, get, bodies };
}
async function learner(app: ReturnType<typeof setup>["app"], key: string) {
  const login = async () =>
    (
      await app.inject({
        method: "POST",
        url: "/v1/auth/dev-login",
        payload: { key },
      })
    ).json().data;
  const { token, user } = await login();
  const raw = (method: string, url: string, payload?: unknown, bearer = token) =>
    app.inject({
      method: method as "GET",
      url,
      payload: payload as string,
      headers: { authorization: `Bearer ${bearer}` },
    });
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await raw(method, url, payload);
    assert.ok(res.statusCode < 300, res.body);
    return res.json().data;
  };
  return { raw, call, login, token: token as string, userId: user.id as string };
}
// Polls the row, not the API, so route rate limits never interfere.
async function settled(store: SqliteStore, id: string) {
  for (let i = 0; i < 400; i++) {
    const row = store.db.prepare("SELECT status FROM jobs WHERE id=?").get(id) as
      | { status: string }
      | undefined;
    if (row && !["queued", "running"].includes(row.status)) return row.status;
    await new Promise((r) => setTimeout(r, 5));
  }
  return "timeout";
}
// Private content the admin must never see: a note and a chat message.
function seedPrivate(store: SqliteStore, userId: string) {
  const now = new Date().toISOString();
  store.db
    .prepare(
      "INSERT INTO threads(id,user_id,title,material_id,data,created_at,updated_at) VALUES('thr_s',?,?,NULL,'{}',?,?)",
    )
    .run(userId, CHAT_SECRET, now, now);
  store.db
    .prepare(
      "INSERT INTO messages(id,thread_id,user_id,role,kind,content,data,status,created_at) VALUES('msg_s','thr_s',?,'user','text',?,'{}','done',?)",
    )
    .run(userId, CHAT_SECRET, now);
}

test("feedback shows the reported answer and the problem it was judged against, never notes or chats", async () => {
  const { app, store, admin, get, bodies } = setup();
  try {
    const a = await learner(app, "a");
    await a.call("POST", "/v1/notes", { text: NOTE_SECRET });
    seedPrivate(store, a.userId);
    await a.call("POST", "/v1/learn/points/limit-rules/report", {
      reason: "judge",
      answer: "0.5",
      index: 0,
    });
    const { id: material } = await a.call("POST", "/v1/materials", {
      kind: "note",
      text: NOTE,
    });
    await a.call("PUT", `/v1/materials/${material}`, {
      expectedVersion: 1,
      confirm: true,
    });
    const { job } = await a.call("POST", `/v1/materials/${material}/explain`, {});
    assert.equal(await settled(store, job.id), "succeeded");
    const { explain } = await a.call("GET", `/v1/materials/${material}/study`);
    await a.call("POST", `/v1/artifacts/${explain.id}/report`, {
      reason: "wrong",
      note: "第二段公式抄错了",
    });

    const todo = await get("/v1/admin/todo");
    assert.deepEqual(todo.feedback, { map: 1, artifact: 1 });
    const { items } = await get("/v1/admin/feedback");
    assert.equal(items.length, 2);
    const map = items.find((i: { type: string }) => i.type === "map");
    assert.equal(map.pointId, "limit-rules");
    assert.equal(map.answer, "0.5");
    assert.equal(map.verdict, "correct");
    assert.equal(map.problem.text, PROBLEMS["limit-rules"]![0]!.text);
    assert.equal(map.problem.answer, "1/2");
    const artifact = items.find((i: { type: string }) => i.type === "artifact");
    assert.equal(artifact.artifactKind, "explain");
    assert.equal(artifact.note, "第二段公式抄错了");
    assert.equal(artifact.handledAt, null);

    const handled = await admin("PUT", `/v1/admin/feedback/map/${map.id}`, {
      handled: true,
      note: "判定正确，0.5 等于 1/2",
    });
    assert.equal(handled.statusCode, 200, handled.body);
    assert.equal((await get("/v1/admin/feedback")).items.length, 1);
    const done = (await get("/v1/admin/feedback?status=handled")).items;
    assert.equal(done[0].handledNote, "判定正确，0.5 等于 1/2");
    assert.deepEqual((await get("/v1/admin/todo")).feedback, { map: 0, artifact: 1 });
    assert.equal((await get("/v1/admin/feedback?status=all")).items.length, 2);
    assert.equal(
      (await get("/v1/admin/feedback?status=handled&type=artifact")).items.length,
      0,
    );
    await admin("PUT", `/v1/admin/feedback/map/${map.id}`, { handled: false });
    assert.equal((await get("/v1/admin/feedback")).items.length, 2);
    assert.equal(
      (await admin("PUT", "/v1/admin/feedback/map/mrp_missing", { handled: true }))
        .statusCode,
      404,
    );
    // The audit keeps the admin's own note, not the learner's answer or note.
    const audit = await get("/v1/admin/audit?action=feedback.");
    assert.deepEqual(
      audit.map((e: { action: string }) => e.action),
      ["feedback.reopened", "feedback.handled"],
    );
    assert.ok(!JSON.stringify(audit).includes("第二段公式抄错了"));

    await get(`/v1/admin/users/${a.userId}`);
    await get(`/v1/admin/users?q=${a.userId.slice(0, 8)}`);
    await get("/v1/admin/bank");
    for (const body of bodies) {
      assert.ok(!body.includes(NOTE_SECRET), "note text leaked");
      assert.ok(!body.includes(CHAT_SECRET), "chat text leaked");
      assert.ok(!body.includes("dev:a"), "openid leaked");
    }
  } finally {
    await app.close();
  }
});

test("a banned account keeps export, erase and logout; every other route answers ACCOUNT_BANNED", async () => {
  const { app, admin, get } = setup();
  try {
    const a = await learner(app, "a");
    await a.call("GET", "/v1/learn/map");
    const ban = await admin("PUT", `/v1/admin/users/${a.userId}/ban`, {
      banned: true,
      reason: "批量刷接口",
    });
    assert.equal(ban.statusCode, 200, ban.body);
    assert.ok(ban.json().data.bannedAt);
    const blocked = await a.raw("GET", "/v1/learn/map");
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json().code, "ACCOUNT_BANNED");
    assert.equal((await a.raw("GET", "/v1/me/usage")).statusCode, 200);
    assert.equal((await a.raw("GET", "/v1/me/export")).statusCode, 200);
    // Signing in again works, so a lapsed session can still reach the export.
    const again = await a.login();
    assert.equal(
      (await a.raw("GET", "/v1/notes", undefined, again.token)).statusCode,
      403,
    );
    assert.equal((await get("/v1/admin/todo")).users.banned, 1);
    assert.equal((await get("/v1/admin/users?filter=banned")).total, 1);
    await admin("PUT", `/v1/admin/users/${a.userId}/ban`, { banned: false });
    assert.equal((await a.raw("GET", "/v1/learn/map")).statusCode, 200);
    const history = (await get(`/v1/admin/users/${a.userId}`)).history;
    assert.deepEqual(
      history.map((h: { action: string }) => h.action),
      ["user.unbanned", "user.banned"],
    );
    assert.equal(history[1].details.reason, "批量刷接口");
    await admin("PUT", `/v1/admin/users/${a.userId}/ban`, { banned: true });
    assert.equal((await a.raw("POST", "/v1/auth/logout")).statusCode, 200);
    const b = await learner(app, "b");
    await admin("PUT", `/v1/admin/users/${b.userId}/ban`, { banned: true });
    assert.equal(
      (await b.raw("DELETE", "/v1/me", { confirm: true })).statusCode,
      200,
    );
    assert.equal(
      (await admin("PUT", "/v1/admin/users/usr_missing/ban", { banned: true }))
        .statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});

test("global limits and per-account overrides apply at once to every charging path", async () => {
  const { app, admin, get } = setup();
  try {
    const a = await learner(app, "a");
    const b = await learner(app, "b");
    assert.equal((await a.call("GET", "/v1/me/usage")).notes.limit, 10);
    const saved = await admin("PUT", "/v1/admin/settings/limits", { notes: 1, chat: 3 });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().data.limits.defaults.notes, 10);
    assert.equal((await a.call("GET", "/v1/me/usage")).notes.limit, 1);
    assert.equal((await a.call("GET", "/v1/chat/usage")).answers.limit, 3);
    const quota = await admin("PUT", `/v1/admin/users/${b.userId}/quota`, {
      notes: 2,
      photos: 0,
    });
    assert.equal(quota.statusCode, 200, quota.body);
    assert.deepEqual(quota.json().data.quota, { notes: 2, photos: 0 });
    assert.equal((await b.call("GET", "/v1/me/usage")).notes.limit, 2);
    assert.equal((await b.call("GET", "/v1/chat/usage")).photos.limit, 0);
    assert.equal((await b.call("GET", "/v1/chat/usage")).answers.limit, 3);

    // the counts no longer stop anyone (a passes its limit of one);
    // the yuan budget does, here b's own budget of ¥0 once set.
    const organize = async (who: typeof a, text: string) => {
      const note = await who.call("POST", "/v1/notes", { text });
      return who.raw("POST", `/v1/notes/${note.id}/organize`, {
        revision: note.revision,
        resultVersion: note.resultVersion,
      });
    };
    assert.equal((await organize(a, "极限的定义 第一条")).statusCode, 200);
    assert.equal((await organize(a, "极限的定义 第二条")).statusCode, 200);
    assert.equal((await organize(b, "导数 第一条")).statusCode, 200);
    assert.equal((await organize(b, "导数 第二条")).statusCode, 200);
    await admin("PUT", `/v1/admin/users/${b.userId}/quota`, { budget: { day: 0 } });
    const limited = await organize(b, "导数 第三条");
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal(limited.json().message, "今天的额度用完了，明天 0 点恢复");
    const detail = await get(`/v1/admin/users/${b.userId}`);
    assert.deepEqual(detail.usage.notes, { used: 2, limit: 2 });
    assert.deepEqual(detail.quota, { notes: 2, photos: 0 });
    await admin("PUT", `/v1/admin/users/${b.userId}/quota`, { budget: { day: null } });

    await admin("PUT", `/v1/admin/users/${b.userId}/quota`, { notes: null });
    assert.equal((await b.call("GET", "/v1/me/usage")).notes.limit, 1);
    assert.equal((await get("/v1/admin/users?filter=custom")).total, 1);
    assert.equal(
      (await admin("PUT", "/v1/admin/settings/limits", { notes: -1 })).statusCode,
      400,
    );
    assert.equal(
      (await admin("PUT", `/v1/admin/users/${b.userId}/quota`, { gold: 1 }))
        .statusCode,
      400,
    );
    const actions = (await get("/v1/admin/audit")).map(
      (e: { action: string }) => e.action,
    );
    assert.ok(actions.includes("settings.limits.updated"));
    assert.ok(actions.includes("user.quota.updated"));
  } finally {
    await app.close();
  }
});

test("v2 limits and usage expose seven buckets with independent global and user overrides", async () => {
  const { app, store, admin, get } = setup({}, fakeServices().fetcher, {
    brainstorm: { quota: "brainstorm", run: async () => ({ output: {} }) },
    import_cards: { quota: "import", run: async () => ({ output: {} }) },
  });
  try {
    const a = await learner(app, "v2-a");
    const b = await learner(app, "v2-b");
    const buckets = ["ai", "ocr", "notes", "chat", "photos", "brainstorm", "import"];
    const settings = await get("/v1/admin/settings");
    assert.deepEqual(Object.keys(settings.limits.defaults), buckets);
    assert.equal(settings.limits.defaults.brainstorm, 10);
    assert.equal(settings.limits.defaults.import, 10);
    assert.equal((await admin("PUT", "/v1/admin/settings/limits", {
      brainstorm: 3, import: 4,
    })).statusCode, 200);
    assert.equal((await admin("PUT", `/v1/admin/users/${a.userId}/quota`, {
      brainstorm: 1, import: 0,
    })).statusCode, 200);
    const insert = store.db.prepare(
      "INSERT INTO quota_receipts(source,source_id,user_id,kind,created_at) VALUES(?,?,?,?,?)",
    );
    const now = new Date().toISOString();
    insert.run("job", "synthetic-brainstorm", a.userId, "brainstorm", now);
    insert.run("job", "synthetic-import", b.userId, "import_cards", now);
    insert.run("chat", "synthetic-stuck", a.userId, "stuck", now);
    const detail = await get(`/v1/admin/users/${a.userId}`);
    assert.deepEqual(Object.keys(detail.usage), buckets);
    assert.deepEqual(detail.usage.brainstorm, { used: 1, limit: 1 });
    assert.deepEqual(detail.usage.import, { used: 0, limit: 0 });
    assert.equal(detail.usage.chat.used, 1);
    const own = await a.call("GET", "/v1/me/usage");
    // old clients see the real count, but never "used up" before
    // the budget is (the admin sees the plain count).
    for (const bucket of buckets) assert.equal(own[bucket].limit, detail.usage[bucket].limit);
    assert.deepEqual(own.brainstorm, { used: 0, limit: 1 });
    assert.deepEqual(own.chat, detail.usage.chat);
    const other = await b.call("GET", "/v1/me/usage");
    assert.deepEqual(other.brainstorm, { used: 0, limit: 3 });
    assert.deepEqual(other.import, { used: 1, limit: 4 });
    const totals = (await get("/v1/admin/usage")).buckets;
    assert.equal(totals.length, 7);
    assert.equal(totals.find((row: { bucket: string }) => row.bucket === "brainstorm").jobs, 1);
    assert.equal(totals.find((row: { bucket: string }) => row.bucket === "import").jobs, 1);
    await admin("PUT", `/v1/admin/users/${a.userId}/quota`, { brainstorm: null });
    assert.equal((await a.call("GET", "/v1/me/usage")).brainstorm.limit, 3);
  } finally {
    await app.close();
  }
});

test("retry reruns a provider failure under the same id without charging quota again", async () => {
  // The model provider is down for the first run, back for the retry.
  let down = true;
  const base = fakeServices().fetcher;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) =>
    down && !String(url).includes("typesafe")
      ? new Response("upstream unavailable", { status: 503 })
      : base(url, init)) as typeof fetch;
  const { app, store, admin, get } = setup({}, fetcher);
  try {
    const a = await learner(app, "a");
    const note = await a.call("POST", "/v1/notes", { text: "极限的四则运算 记一下" });
    const organized = await a.raw("POST", `/v1/notes/${note.id}/organize`, {
      revision: note.revision,
      resultVersion: note.resultVersion,
    });
    const jobId = organized.json().data.job.id as string;
    assert.equal(await settled(store, jobId), "failed");
    const receipts = () =>
      Number(
        (store.db.prepare("SELECT COUNT(*) AS n FROM quota_receipts").get() as { n: number }).n,
      );
    const before = receipts();
    down = false;
    const listed = (await get("/v1/admin/jobs")).recent.find(
      (j: { id: string }) => j.id === jobId,
    );
    assert.equal(listed.retryable, true);
    assert.equal((await get("/v1/admin/todo")).jobs.retryable, 1);
    const retried = await admin("POST", `/v1/admin/jobs/${jobId}/retry`);
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(await settled(store, jobId), "succeeded");
    assert.equal(receipts(), before);
    assert.equal(
      (await admin("POST", `/v1/admin/jobs/${jobId}/retry`)).json().code,
      "NOT_RETRYABLE",
    );
    // A learner-side failure (the note was deleted) is never retried.
    store.db
      .prepare("UPDATE jobs SET status='failed',error_code='NOTE_DELETED' WHERE id=?")
      .run(jobId);
    assert.equal((await admin("POST", `/v1/admin/jobs/${jobId}/retry`)).statusCode, 409);
    assert.equal((await admin("POST", "/v1/admin/jobs/job_missing/retry")).statusCode, 404);
    const audit = await get("/v1/admin/audit?action=job.");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].details.code, "AI_UNAVAILABLE");
  } finally {
    await app.close();
  }
});

test("a newer identical job supersedes a failed one", async () => {
  const { app, store, admin } = setup();
  try {
    const a = await learner(app, "a");
    const insert = store.db.prepare(
      "INSERT INTO jobs(id,user_id,kind,params,params_hash,status,error_code,created_at) VALUES(?,?,'note_organize','{}','same',?,?,?)",
    );
    const now = new Date().toISOString();
    insert.run("job_old", a.userId, "failed", "AI_BUSY", now);
    insert.run("job_new", a.userId, "succeeded", null, now);
    const res = await admin("POST", "/v1/admin/jobs/job_old/retry");
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, "SUPERSEDED");
  } finally {
    await app.close();
  }
});

test("problem bank lists every point with all problems, most reported first", async () => {
  const { app, get } = setup();
  try {
    const a = await learner(app, "a");
    await a.call("POST", "/v1/learn/points/indefinite-parts/report", { reason: "problem" });
    await a.call("POST", "/v1/learn/points/indefinite-parts/report", { reason: "unclear" });
    await a.call("POST", "/v1/learn/points/limit-rules/report", { reason: "judge" });
    const bank = await get("/v1/admin/bank");
    assert.equal(bank.points.length, 89);
    assert.equal(bank.problems, 244);
    assert.deepEqual(
      bank.points.slice(0, 2).map((p: { pointId: string }) => p.pointId),
      ["indefinite-parts", "limit-rules"],
    );
    assert.deepEqual(bank.points[0].reports, { total: 2, open: 2 });
    assert.equal(bank.points[2].reports.total, 0);
    assert.equal(bank.points[1].problems[1].answer, "2");
  } finally {
    await app.close();
  }
});

test("users list searches, pages and never returns the WeChat openid", async () => {
  const { app, get, bodies } = setup();
  try {
    const a = await learner(app, "alpha");
    await learner(app, "beta");
    const list = await get("/v1/admin/users");
    assert.equal(list.total, 2);
    assert.deepEqual(Object.keys(list.items[0].today).sort(), [
      "ai",
      "brainstorm",
      "chat",
      "import",
      "notes",
      "ocr",
      "photos",
    ]);
    assert.equal((await get(`/v1/admin/users?q=${a.userId}`)).total, 1);
    assert.equal((await get("/v1/admin/users?q=%25")).total, 0);
    for (const body of bodies) assert.ok(!/dev:(alpha|beta)/.test(body));
  } finally {
    await app.close();
  }
});

test("audit filters by action prefix, actor and Beijing calendar day", async () => {
  const { app, store, get, admin } = setup();
  try {
    await learner(app, "a");
    store.db
      .prepare("INSERT INTO audit VALUES('old','admin:shared','user.banned','u','{}','2026-01-01T15:59:00Z')")
      .run();
    assert.equal((await get("/v1/admin/audit?action=session.")).length, 1);
    assert.equal((await get("/v1/admin/audit?actor=admin:shared")).length, 1);
    assert.equal((await get("/v1/admin/audit?from=2026-01-01&to=2026-01-01")).length, 1);
    assert.equal((await get("/v1/admin/audit?from=2026-01-02&to=2026-01-02")).length, 0);
    assert.equal((await admin("GET", "/v1/admin/audit?from=yesterday")).statusCode, 400);
  } finally {
    await app.close();
  }
});
