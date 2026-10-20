import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { fakeServices, makeApp } from "./fixtures.js";
import { UsageLedger } from "../server/src/shared/usage-ledger.js";

function fixture(t: TestContext) {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  t.after(() => app.close());
  const login = async (key: string) => {
    const response = await app.inject({
      method: "POST", url: "/v1/auth/dev-login", payload: { key },
    });
    const { token, user } = response.json().data;
    return {
      userId: user.id as string,
      call: (method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
        app.inject({ method, url, payload, headers: { authorization: "Bearer " + token } }),
    };
  };
  return { store, login };
}

test("map export includes every schema column while keeping existing names and red boolean", async (t) => {
  const { store, login } = fixture(t);
  const owner = await login("map-owner");
  const other = await login("map-other");
  // A synthetic future column proves that another migration cannot silently
  // add map data without it appearing in the export.
  store.db.exec("ALTER TABLE map_points ADD COLUMN future_value TEXT");
  const insert = store.db.prepare(
    "INSERT INTO map_points(user_id,point_id,red,updated_at,tool_epoch,red_due,future_value) VALUES(?,?,1,?,7,1,?)",
  );
  insert.run(owner.userId, "limit-rules", "2026-10-12T00:00:00Z", "owner-marker");
  insert.run(other.userId, "other-point", "2026-10-12T00:00:00Z", "other-marker");
  // 0.6.0 题库 : attempts leave as an object, an empty one as null.
  const attempts = { "0": { tries: 2, correctAt: null, last: "incorrect", shownOn: "2026-10-12" } };
  store.db
    .prepare("UPDATE map_points SET attempts=? WHERE user_id=?")
    .run(JSON.stringify(attempts), owner.userId);
  insert.run(owner.userId, "limit-def", "2026-10-12T00:00:00Z", "owner-plain");
  const response = await owner.call("GET", "/v1/me/export");
  assert.equal(response.statusCode, 200);
  const data = response.json();
  assert.equal(data.format, "zhiye-export/1");
  assert.equal(data.learn.points.length, 2);
  assert.equal(data.learn.points[0].pointId, "limit-def");
  assert.equal(data.learn.points[0].attempts, null);
  const point = data.learn.points[1];
  assert.equal(point.pointId, "limit-rules");
  assert.deepEqual(point.attempts, attempts);
  assert.equal(point.red, true);
  assert.equal(point.toolEpoch, 7);
  assert.equal(point.redDue, 1);
  assert.equal(point.futureValue, "owner-marker");
  const columns = store.db.prepare("PRAGMA table_info(map_points)").all()
    .map((row) => String(row.name)).filter((name) => name !== "user_id");
  assert.equal(Object.keys(point).length, columns.length);
  for (const column of columns) {
    const camel = column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    assert.ok(Object.hasOwn(point, camel), column);
  }
  assert.doesNotMatch(response.body, /other-marker|user_id|userId/);
});

test("export includes declared profile and preferences but excludes internal user fields", async (t) => {
  const { store, login } = fixture(t);
  const owner = await login("preferences");
  const preferences = {
    resume: { enabled: false },
    moodConsentAt: "2026-10-12T00:00:00Z",
    taughtTo: "limit-rules",
    suggestCards: false,
  };
  store.db.prepare("UPDATE users SET data=json_patch(data,?) WHERE id=?")
    .run(JSON.stringify({ ...preferences, unrelatedInternal: "must-not-export" }), owner.userId);
  const response = await owner.call("GET", "/v1/me/export");
  assert.equal(response.statusCode, 200);
  const user = response.json().user;
  for (const [key, value] of Object.entries(preferences)) assert.deepEqual(user[key], value);
  assert.equal(user.avatar, null);
  assert.deepEqual(Object.keys(user).sort(), [
    "ageBand", "avatar", "consents", "createdAt", "id", "moodConsentAt", "nickname", "personalized",
    "resume", "studyTime", "suggestCards", "taughtTo",
  ]);
  assert.doesNotMatch(response.body, /openid|authMode|must-not-export/);
});

test("artifact feedback exports and erases only the owner's reports", async (t) => {
  const { store, login } = fixture(t);
  const owner = await login("report-owner");
  const other = await login("report-other");
  for (const who of [owner, other]) {
    const response = await who.call("POST", "/v1/materials", { kind: "note", text: "合成资料" });
    assert.ok(response.statusCode < 300, response.body);
    const materialId = response.json().data.id;
    store.db.prepare(
      "INSERT INTO artifacts(id,user_id,material_id,version,kind,data,created_at) VALUES(?,?,?,1,'explain','{}',?)",
    ).run("artifact-" + who.userId, who.userId, materialId, "2026-10-12T00:00:00Z");
    store.db.prepare(
      "INSERT INTO reports(id,user_id,artifact_id,reason,note,created_at) VALUES(?,?,?,'wrong',?,?)",
    ).run("report-" + who.userId, who.userId, "artifact-" + who.userId, "feedback-" + who.userId, "2026-10-12T00:00:00Z");
  }
  const response = await owner.call("GET", "/v1/me/export");
  assert.deepEqual(response.json().artifactReports, [{
    id: "report-" + owner.userId, artifactId: "artifact-" + owner.userId,
    reason: "wrong", note: "feedback-" + owner.userId, createdAt: "2026-10-12T00:00:00Z",
  }]);
  assert.equal(response.json().learn.reports.length, 0);
  assert.ok(!response.body.includes(other.userId));
  assert.equal((await owner.call("DELETE", "/v1/me", { confirm: true })).statusCode, 200);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE user_id=?").get(owner.userId)!.n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE user_id=?").get(other.userId)!.n, 1);
});

test("each table with user_id has an export location or a documented exclusion", async (t) => {
  const { store, login } = fixture(t);
  const owner = await login("coverage");
  const data = (await owner.call("GET", "/v1/me/export")).json();
  const exported: Record<string, unknown> = {
    materials: data.materials,
    artifacts: data.materials.flatMap((m: any) => m.generated),
    attempts: data.materials.flatMap((m: any) => m.attempts),
    reviews: data.materials.flatMap((m: any) => m.review ? [m.review] : []),
    reports: data.artifactReports,
    threads: data.conversations,
    messages: data.conversations.flatMap((thread: any) => thread.messages),
    chat_images: data.photos,
    chat_attachments: data.chatAttachments,
    mistakes: data.mistakes,
    map_points: data.learn.points,
    map_chapters: data.learn.hiddenChapters,
    map_reports: data.learn.reports,
    notes: data.notes,
    quota_receipts: data.quotaUsage,
    cards: data.cards,
    card_versions: data.cardVersions,
    card_links: data.cardLinks,
    card_uses: data.cardUses,
    tags: data.tags,
    card_tags: data.cardTags,
    card_reminders: data.cardReminders,
    resume_items: data.resumeItems,
    brainstorms: data.brainstorms,
    imports: data.imports,
    retests: data.retests,
    study_days: data.studyDays,
  };
  const excluded = {
    sessions: "Authentication sessions are credentials, not learner content.",
    jobs: "Runtime tasks are excluded; saved content and quota summaries export separately.",
    events: "Operational event records are excluded from the learner content export.",
    quota_voids: "V4.2: void markers only remove failed jobs from quotaUsage counts.",
    quota_spend: "V4.2 G4: per-action model usage behind the budget percentages; accounting, not learner content.",
  };
  const ownedTables = store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()
    .map((row) => String(row.name))
    .filter((name) => store.db.prepare("SELECT name FROM pragma_table_info(?)").all(name)
      .some((column) => column.name === "user_id"));
  assert.deepEqual(ownedTables.sort(), [...Object.keys(exported), ...Object.keys(excluded)].sort());
  for (const [table, value] of Object.entries(exported)) {
    assert.ok(Array.isArray(value), table + " must actually appear in the export");
  }
});

test("all ten v2 tables export owned content and cascade on erase while anonymous usage remains", async (t) => {
  const { store, login } = fixture(t);
  const owner = await login("v2-owner"), other = await login("v2-other");
  const now = "2026-10-12T00:00:00.000Z";
  for (const { userId } of [owner, other]) {
    for (const suffix of ["a", "b"]) store.db.prepare(
      "INSERT INTO cards(id,user_id,type,scene,title,title_by,quote,origin,slots,created_at,updated_at) VALUES(?,?,'idea','life',?,'user',?,'jot',?,?,?)",
    ).run(userId + suffix, userId, "标题-" + userId, "原话-" + userId,
      JSON.stringify([{ key: "k", text: "自己的话", by: "user" }]), now, now);
    store.db.prepare("INSERT INTO card_versions(card_id,user_id,kind,by,data,created_at) VALUES(?,?,'create','user',?,?)")
      .run(userId + "a", userId, JSON.stringify({ marker: userId }), now);
    store.db.prepare("INSERT INTO brainstorms(id,user_id,scene,size,cards,result,status,created_at,updated_at) VALUES(?,?,'life','small',?,'{}','ready',?,?)")
      .run(userId + "bs", userId, JSON.stringify([{ id: userId + "a", text: "快照" }]), now, now);
    store.db.prepare("INSERT INTO card_links(a,b,user_id,by,brainstorm_id,created_at) VALUES(?,?,?,'brainstorm',?,?)")
      .run(userId + "a", userId + "b", userId, userId + "bs", now);
    store.db.prepare("INSERT INTO card_uses(card_id,user_id,kind,ref_id,created_at) VALUES(?,?,'brainstorm',?,?)")
      .run(userId + "a", userId, userId + "bs", now);
    store.db.prepare("INSERT INTO tags(id,user_id,name,color,by,created_at) VALUES(?,?,'标签',0,'user',?)")
      .run(userId + "tag", userId, now);
    store.db.prepare("INSERT INTO card_tags(card_id,tag_id,user_id) VALUES(?,?,?)")
      .run(userId + "a", userId + "tag", userId);
    store.db.prepare("INSERT INTO resume_items(id,user_id,src,src_id,item_key,kind,due_on,created_at,updated_at) VALUES(?,?,'card',?,'type','idea','2026-10-14',?,?)")
      .run(userId + "resume", userId, userId + "a", now, now);
    store.db.prepare("INSERT INTO imports(id,user_id,source,segments,status,created_at,updated_at) VALUES(?,?,'paste',?,'read',?,?)")
      .run(userId + "import", userId, JSON.stringify([{ n: 1, text: "导入原文-" + userId }]), now, now);
    store.db.prepare("INSERT INTO retests(user_id,point_id,cause,problem_index,round,due_on,created_at) VALUES(?,'limit-rules','hint',0,1,'2026-10-14',?)")
      .run(userId, now);
    store.db.prepare("INSERT INTO threads(id,user_id,title,scene,mode,mood_cards,created_at,updated_at) VALUES(?,?,'合成对话','mood','guide',1,?,?)")
      .run(userId + "thread", userId, now, now);
  }
  const ledger = new UsageLedger(store);
  ledger.start({ source: "llm.json", provider: "synthetic", model: "synthetic", scene: "card_tidy" })({
    status: "succeeded", promptTokens: 10, completionTokens: 5, cachedTokens: 3,
  });
  const data = (await owner.call("GET", "/v1/me/export")).json();
  const mapping = {
    cards: "cards", card_versions: "cardVersions", card_links: "cardLinks", card_uses: "cardUses",
    tags: "tags", card_tags: "cardTags", resume_items: "resumeItems", brainstorms: "brainstorms",
    imports: "imports", retests: "retests",
  };
  for (const [table, key] of Object.entries(mapping)) {
    const count = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).get(owner.userId)!.n;
    assert.equal(data[key].length, count, table);
    assert.ok(data[key].every((row: object) => !Object.hasOwn(row, "userId")), table);
  }
  assert.equal(data.cards[0].slots[0].by, "user");
  assert.equal(data.cardVersions[0].data.marker, owner.userId);
  assert.equal(data.brainstorms[0].cards[0].id, owner.userId + "a");
  assert.equal(data.imports[0].segments[0].text, "导入原文-" + owner.userId);
  assert.deepEqual([data.conversations[0].scene, data.conversations[0].mode, data.conversations[0].moodCards], ["mood", "guide", true]);
  assert.ok(!JSON.stringify(data).includes(other.userId));
  assert.equal((await owner.call("DELETE", "/v1/me", { confirm: true })).statusCode, 200);
  for (const table of Object.keys(mapping)) {
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).get(owner.userId)!.n, 0, table);
    assert.ok(Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).get(other.userId)!.n) > 0, table);
  }
  assert.deepEqual({ ...store.db.prepare("SELECT scene,cached_tokens FROM usage_ledger").get() }, { scene: "card_tidy", cached_tokens: 3 });
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
});
