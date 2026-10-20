import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, SqliteStore } from "../server/src/shared/store.js";
import { NoteService, type Note } from "../server/src/modules/notes/service.js";
import { fakeServices, makeApp } from "./fixtures.js";
import { loadEnv } from "../server/src/config/env.js";

function setup(t: TestContext) {
  const clock = { at: new Date("2026-10-03T01:00:00.000Z") };
  const store = new SqliteStore(":memory:");
  const services = fakeServices();
  const app = makeApp(services, {}, () => clock.at, store);
  t.after(() => app.close());
  const login = async (key: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key },
    });
    assert.equal(response.statusCode, 200);
    const { token, user } = response.json().data;
    const call = (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET",
        url,
        payload: payload as string,
        headers: { authorization: `Bearer ${token}` },
      });
    return { call, userId: user.id as string };
  };
  return { app, store, services, clock, login };
}

test("notes: every operation requires a session before validating input", async (t) => {
  const { app } = setup(t);
  for (const [method, url, payload] of [
    ["POST", "/v1/notes", { unexpected: true }],
    ["GET", "/v1/notes?limit=-1"],
    ["GET", "/v1/notes/missing"],
    ["PUT", "/v1/notes/missing", { text: "不能改原文" }],
    ["DELETE", "/v1/notes/missing", { unexpected: true }],
  ] as const) {
    const response = await app.inject({ method, url, payload });
    assert.equal(response.statusCode, 401, `${method} ${url}`);
  }
});

test("notes: production accepts legacy writes until the explicit client release switch", async (t) => {
  const clock = { at: new Date("2026-10-03T01:00:00.000Z") };
  const database = join(
    mkdtempSync(join(tmpdir(), "zhiye-notes-release-")),
    "app.sqlite",
  );
  const store = new SqliteStore(database);
  const services = fakeServices();
  const writable = makeApp(services, {}, () => clock.at, store);
  const login = await writable.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: { key: "legacy-release" },
  });
  const token = login.json().data.token as string;
  const headers = { authorization: `Bearer ${token}` };
  const created = await writable.inject({
    method: "POST",
    url: "/v1/notes",
    headers,
    payload: { text: "发布前保留的旧随心记" },
  });
  const id = created.json().data.id as string;
  // The production phase must use a synthetic WeChat identity, not dev auth.
  store.db.prepare("UPDATE users SET data=json_set(data,'$.authMode','wechat') WHERE openid=?")
    .run("dev:legacy-release");
  await writable.close();

  const production = {
    NODE_ENV: "production",
    DEV_LOGIN_ENABLED: "false",
    DATABASE_PATH: database,
    ADMIN_API_KEY: "synthetic-admin-key-for-isolated-tests-01",
    ADMIN_ORIGIN: "https://admin.example.test",
    WECHAT_APP_ID: "wx-test",
    WECHAT_APP_SECRET: "server-secret",
  };
  assert.equal(loadEnv(production).LEGACY_NOTES_READ_ONLY, false);
  assert.throws(() => loadEnv({ ...production, LEGACY_NOTES_READ_ONLY: "maybe" }));
  const compatible = makeApp(services, production, () => clock.at, new SqliteStore(database));
  const stillWritable = await compatible.inject({
    method: "POST", url: "/v1/notes", headers, payload: { text: "后端先上线时仍能保存" },
  });
  assert.equal(stillWritable.statusCode, 200);
  const open = await compatible.inject({ method: "GET", url: `/v1/notes/${id}`, headers });
  assert.equal(open.json().data.readOnly, undefined);
  await compatible.close();

  const released = makeApp(services, { ...production, LEGACY_NOTES_READ_ONLY: "true" }, () => clock.at, new SqliteStore(database));
  t.after(() => released.close());
  const get = await released.inject({ method: "GET", url: `/v1/notes/${id}`, headers });
  assert.equal(get.statusCode, 200);
  // the page learns it may only read and delete.
  assert.equal(get.json().data.readOnly, true);
  for (const [method, url, payload] of [
    ["POST", "/v1/notes", { text: "不能再新建" }],
    ["PUT", `/v1/notes/${id}`, { title: "不能再改名" }],
    ["POST", `/v1/notes/${id}/organize`, { revision: 0 }],
    ["POST", `/v1/notes/${id}/supplements`, { revision: 0, clientId: "supplement-client-1", text: "不能补充" }],
    ["PUT", `/v1/notes/${id}/point`, { pointId: null, confirm: true }],
    ["PUT", `/v1/notes/${id}/items/item`, { revision: 0, group: "known", text: "不能改事项" }],
    ["DELETE", `/v1/notes/${id}/items/item`, { revision: 0 }],
  ] as const) {
    const response = await released.inject({ method, url, headers, payload });
    assert.equal(response.statusCode, 410, `${method} ${url}`);
    assert.equal(response.json().code, "NOTES_READ_ONLY");
  }
  const removed = await released.inject({
    method: "DELETE",
    url: `/v1/notes/${id}`,
    headers,
  });
  assert.equal(removed.statusCode, 200);
});

test("notes: original whitespace, line endings and markup survive create, read, rename and export", async (t) => {
  const { login, clock } = setup(t);
  const { call } = await login("owner");
  const text =
    " \r\n\t\r\n  # 导数与极限 📝  \r\n\r\n**原话**：$f'(x)$ 与 \\frac{1}{x}\n<script>原样记下</script>\r末行  \t";
  const created = await call("POST", "/v1/notes", { text });
  assert.equal(created.statusCode, 200);
  const note = created.json().data;
  assert.deepEqual(note, {
    id: note.id,
    text,
    title: "# 导数与极限 📝",
    status: "raw",
    result: null,
    pointId: null,
    revision: 1,
    sourceVersion: 1,
    resultVersion: 0,
    supplements: [],
    resultStale: false,
    aiJob: null,
    createdAt: clock.at.toISOString(),
    updatedAt: clock.at.toISOString(),
  });
  assert.match(note.id, /^note_[a-f0-9]{32}$/);
  assert.deepEqual(
    (await call("GET", `/v1/notes/${note.id}`)).json().data,
    note,
  );
  assert.deepEqual((await call("GET", "/v1/notes")).json().data, [note]);
  assert.deepEqual((await call("GET", "/v1/me/export")).json().notes, [note]);

  clock.at = new Date("2026-10-03T02:30:00.000Z");
  const renamed = await call("PUT", `/v1/notes/${note.id}`, {
    title: "  我的推导\t ",
  });
  assert.equal(renamed.statusCode, 200);
  const expected = {
    ...note,
    title: "我的推导",
    updatedAt: clock.at.toISOString(),
  };
  assert.deepEqual(renamed.json().data, expected);
  assert.deepEqual(
    (await call("GET", `/v1/notes/${note.id}`)).json().data,
    expected,
  );
  assert.deepEqual((await call("GET", "/v1/me/export")).json().notes, [
    expected,
  ]);
});

test("notes: titles use the first nonblank line and never split a Unicode code point", async (t) => {
  const { login } = setup(t);
  const { call } = await login("owner");
  for (const text of [
    "\n  \n" + "数".repeat(40) + "\n第二行",
    "\r\t\r  " + "📝".repeat(40) + "  \r第二行",
  ]) {
    const note = (await call("POST", "/v1/notes", { text })).json().data;
    assert.equal(note.text, text);
    assert.equal(Array.from(note.title).length, 32);
    assert.equal(
      note.title,
      text.includes("📝") ? "📝".repeat(32) : "数".repeat(32),
    );
  }
});

test("notes: strict bodies enforce text and title boundaries without changing saved words", async (t) => {
  const { login } = setup(t);
  const { call } = await login("owner");
  for (const payload of [
    undefined,
    {},
    { text: null },
    { text: 4 },
    { text: "" },
    { text: " \t\r\n　" },
    { text: "字".repeat(2001) },
    { text: "原话", title: "自定义" },
    { text: "原话", status: "done" },
    { text: "原话", result: {} },
    { text: "原话", pointId: "limit-sequence" },
  ]) {
    assert.equal((await call("POST", "/v1/notes", payload)).statusCode, 400);
  }
  assert.deepEqual((await call("GET", "/v1/notes")).json().data, []);
  const text = "字".repeat(2000);
  const created = await call("POST", "/v1/notes", { text });
  assert.equal(created.statusCode, 200);
  const note = created.json().data;
  for (const title of ["单", "长".repeat(80)]) {
    const response = await call("PUT", `/v1/notes/${note.id}`, {
      title: ` ${title}\n`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.title, title);
  }
  for (const payload of [
    undefined,
    {},
    { title: null },
    { title: 4 },
    { title: " \n\t " },
    { title: "长".repeat(81) },
    { title: "改名", text: "篡改" },
    { title: "改名", status: "ready" },
    { title: "改名", result: {} },
    { title: "改名", pointId: "limit-sequence" },
  ]) {
    assert.equal(
      (await call("PUT", `/v1/notes/${note.id}`, payload)).statusCode,
      400,
    );
  }
  assert.equal(
    (await call("DELETE", `/v1/notes/${note.id}`, { text: "原话" })).statusCode,
    400,
  );
  const saved = (await call("GET", `/v1/notes/${note.id}`)).json().data;
  assert.equal(saved.text, text);
  assert.equal(saved.title, "长".repeat(80));
  assert.equal(saved.status, "raw");
  assert.equal(saved.result, null);
  assert.equal(saved.pointId, null);
});

test("notes: list rejects invalid or extra pagination fields", async (t) => {
  const { login } = setup(t);
  const { call } = await login("owner");
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=1.5",
    "limit=abc",
    "limit=Infinity",
    "limit=1&limit=2",
    "offset=-1",
    "offset=1.5",
    "offset=abc",
    "offset=9007199254740992",
    "offset=1&offset=2",
    "userId=someone",
    "status=raw",
    "limit=20&extra=true",
  ]) {
    const response = await call("GET", `/v1/notes?${query}`);
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().code, "VALIDATION_ERROR", query);
  }
});

test("notes: other owners and missing ids have the same inaccessible result", async (t) => {
  const { login } = setup(t);
  const { call } = await login("owner");
  const { call: other } = await login("other");
  const note = (
    await call("POST", "/v1/notes", { text: "只有本人可以看" })
  ).json().data;
  for (const [method, payload] of [
    ["GET"],
    ["PUT", { title: "别人的改名" }],
    ["DELETE"],
  ] as const) {
    const foreign = await other(method, `/v1/notes/${note.id}`, payload);
    const missing = await other(method, "/v1/notes/note_missing", payload);
    assert.equal(foreign.statusCode, 404);
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(
      { code: foreign.json().code, message: foreign.json().message },
      { code: missing.json().code, message: missing.json().message },
    );
    assert.doesNotMatch(foreign.body, /只有本人可以看/);
  }
  assert.deepEqual((await other("GET", "/v1/notes")).json().data, []);
  assert.deepEqual((await other("GET", "/v1/me/export")).json().notes, []);
  assert.deepEqual(
    (await call("GET", `/v1/notes/${note.id}`)).json().data,
    note,
  );
});

test("notes: pagination is stable for tied timestamps and renaming never moves an entry", async (t) => {
  const { login, store, clock } = setup(t);
  const { call, userId } = await login("owner");
  const notes = new NoteService(store, () => clock.at);
  const saved: Note[] = [];
  for (let i = 0; i < 107; i++) saved.push(notes.create(userId, `第 ${i} 条`));
  clock.at = new Date("2026-10-03T02:00:00.000Z");
  saved.push(notes.create(userId, "最新一条"));
  const expected = saved
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id > b.id
          ? -1
          : 1
        : a.createdAt > b.createdAt
          ? -1
          : 1,
    )
    .map((n) => n.id);
  const ids = (response: Awaited<ReturnType<typeof call>>) =>
    response.json().data.map((n: Note) => n.id);
  assert.deepEqual(ids(await call("GET", "/v1/notes")), expected.slice(0, 20));
  const first = ids(await call("GET", "/v1/notes?limit=100&offset=0"));
  const last = ids(await call("GET", "/v1/notes?limit=100&offset=100"));
  assert.deepEqual([...first, ...last], expected);
  assert.equal(new Set([...first, ...last]).size, saved.length);
  assert.deepEqual(
    ids(await call("GET", "/v1/notes?limit=5&offset=19")),
    expected.slice(19, 24),
  );
  assert.deepEqual(ids(await call("GET", "/v1/notes?offset=108")), []);

  clock.at = new Date("2026-10-03T03:00:00.000Z");
  assert.equal(
    (await call("PUT", `/v1/notes/${expected.at(-1)}`, { title: "改名不置顶" }))
      .statusCode,
    200,
  );
  assert.deepEqual(ids(await call("GET", "/v1/notes")), expected.slice(0, 20));
  const exported: Note[] = (await call("GET", "/v1/me/export")).json().notes;
  assert.equal(exported.length, 108);
  assert.deepEqual(
    exported.map((n) => n.id),
    expected,
  );
  assert.ok(
    exported.every(
      (n) => n.status === "raw" && n.result === null && n.pointId === null,
    ),
  );
});

test("notes: deletion removes the note from detail, list and account export", async (t) => {
  const { login } = setup(t);
  const { call } = await login("owner");
  const note = (await call("POST", "/v1/notes", { text: "即将删除" })).json()
    .data;
  const deleted = await call("DELETE", `/v1/notes/${note.id}`);
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.json(), { data: { deleted: true } });
  for (const [method, payload] of [
    ["GET"],
    ["PUT", { title: "恢复不了" }],
    ["DELETE"],
  ] as const) {
    assert.equal(
      (await call(method, `/v1/notes/${note.id}`, payload)).statusCode,
      404,
    );
  }
  assert.deepEqual((await call("GET", "/v1/notes")).json().data, []);
  assert.deepEqual((await call("GET", "/v1/me/export")).json().notes, []);
});

test("notes: erasing an account cascades only to its own notes", async (t) => {
  const { login, store } = setup(t);
  const { call, userId } = await login("owner");
  const { call: other } = await login("other");
  const notes = new NoteService(store);
  for (let i = 0; i < 103; i++) notes.create(userId, `注销的第 ${i} 条`);
  const kept = (
    await other("POST", "/v1/notes", { text: "保留另一位的随心记" })
  ).json().data;
  assert.equal(
    (await call("DELETE", "/v1/me", { confirm: true })).statusCode,
    200,
  );
  assert.equal(
    store.db
      .prepare("SELECT COUNT(*) AS n FROM notes WHERE user_id=?")
      .get(userId)?.n,
    0,
  );
  assert.equal((await call("GET", "/v1/notes")).statusCode, 401);
  assert.deepEqual((await other("GET", "/v1/notes")).json().data, [kept]);
  const { call: again } = await login("owner");
  assert.deepEqual((await again("GET", "/v1/notes")).json().data, []);
});

test("notes: storing and managing raw notes has no AI, quota, job or map-progress effects", async (t) => {
  const { login, store, services } = setup(t);
  const { call } = await login("owner");
  const beforeMap = (await call("GET", "/v1/learn/map")).json().data;
  const beforeUsage = (await call("GET", "/v1/me/usage")).json().data;
  const note = (
    await call("POST", "/v1/notes", { text: "请替我证明这个公式" })
  ).json().data;
  await call("GET", "/v1/notes");
  await call("GET", `/v1/notes/${note.id}`);
  await call("PUT", `/v1/notes/${note.id}`, { title: "以后再整理" });
  await call("DELETE", `/v1/notes/${note.id}`, {});
  assert.deepEqual((await call("GET", "/v1/learn/map")).json().data, beforeMap);
  assert.deepEqual(
    (await call("GET", "/v1/me/usage")).json().data,
    beforeUsage,
  );
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n, 0);
  assert.deepEqual(services.llm, []);
  assert.deepEqual(services.jev, []);
});

test("notes: migration seven preserves version-six data and is safe to reopen", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "zhiye-notes-upgrade-")),
    "app.sqlite",
  );
  const old = new DatabaseSync(path);
  const iso = "2026-10-02T12:00:00.000Z";
  try {
    old.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (let i = 0; i < 6; i++) {
      old.exec(MIGRATIONS[i]!);
      old.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(i + 1, iso);
    }
    old
      .prepare("INSERT INTO users(id,openid,data) VALUES(?,?,?)")
      .run(
        "usr_old",
        "dev:old",
        JSON.stringify({ id: "usr_old", nickname: "旧用户" }),
      );
    old
      .prepare(
        "INSERT INTO map_points(user_id,point_id,correct_at,updated_at) VALUES(?,?,?,?)",
      )
      .run("usr_old", "limit-sequence", iso, iso);
  } finally {
    old.close();
  }
  const store = new SqliteStore(path);
  let note: Note;
  try {
    assert.equal(
      store.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()
        ?.v,
      MIGRATIONS.length,
    );
    assert.equal(store.getUser("usr_old")?.nickname, "旧用户");
    assert.equal(
      store.db
        .prepare("SELECT correct_at FROM map_points WHERE user_id=?")
        .get("usr_old")?.correct_at,
      iso,
    );
    note = new NoteService(store).create(
      "usr_old",
      "升级后的原话\r\n  保留格式 ",
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM notes").get()?.n,
      1,
    );
  } finally {
    store.close();
  }
  const reopened = new SqliteStore(path);
  try {
    assert.deepEqual(
      new NoteService(reopened).detail("usr_old", note!.id),
      note!,
    );
    assert.equal(
      reopened.db
        .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=7")
        .get()?.n,
      1,
    );
    assert.deepEqual(reopened.db.prepare("PRAGMA foreign_key_check").all(), []);
    reopened.db.prepare("DELETE FROM users WHERE id=?").run("usr_old");
    assert.equal(
      reopened.db.prepare("SELECT COUNT(*) AS n FROM notes").get()?.n,
      0,
    );
  } finally {
    reopened.close();
  }
});
