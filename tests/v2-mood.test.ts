import assert from "node:assert/strict";
import test from "node:test";
import { MoodService } from "../server/src/modules/safety/mood.js";
import { JobRunner } from "../server/src/modules/jobs/runner.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { fakeServices, makeApp } from "./fixtures.js";

const at = "2026-10-12T08:00:00.000Z";

function setup() {
  const store = new SqliteStore(":memory:");
  const owner = store.upsertUser("dev:mood-owner", "甲", "dev").id;
  const other = store.upsertUser("dev:mood-other", "乙", "dev").id;
  const stopped = { threads: [] as string[], jobs: [] as string[] };
  const mood = new MoodService(store, {
    stopThreads: (threadIds) => stopped.threads.push(...threadIds),
    stopJobs: (_userId, jobIds) => stopped.jobs.push(...jobIds),
  }, () => new Date(at));
  return { store, owner, other, mood, stopped };
}

function user(store: SqliteStore, id: string) {
  return store.getUser(id)!;
}

function seed(store: SqliteStore, owner: string, other: string) {
  const db = store.db;
  const stamp = "2026-10-12T00:00:00.000Z";
  const thread = (id: string, userId: string, scene: string, moodCards = 0) => db.prepare("INSERT INTO threads(id,user_id,title,scene,mode,mood_cards,created_at,updated_at) VALUES(?,?,? ,?,'guide',?,?,?)").run(id, userId, id, scene, moodCards, stamp, stamp);
  thread("thread-mood", owner, "mood");
  thread("thread-cards", owner, "life", 1);
  thread("thread-keep", owner, "life");
  thread("thread-other", other, "mood");
  for (const [id, threadId, userId] of [["message-mood", "thread-mood", owner], ["message-cards", "thread-cards", owner], ["message-keep", "thread-keep", owner], ["message-other", "thread-other", other]] as const)
    db.prepare("INSERT INTO messages(id,thread_id,user_id,role,kind,status,created_at) VALUES(?,?,?,'user','text','done',?)").run(id, threadId, userId, stamp);
  const card = (id: string, userId: string, scene: string, origin: string, srcId: string | null) => db.prepare("INSERT INTO cards(id,user_id,type,scene,title,title_by,origin,src_id,created_at,updated_at) VALUES(?,?, 'idea',? ,?,'user',?,?,?,?)").run(id, userId, scene, id, origin, srcId, stamp, stamp);
  card("card-mood", owner, "mood", "jot", null);
  card("card-import-mood", owner, "mood", "import", "import-mood");
  card("card-import-keep", owner, "life", "import", "import-mood");
  card("card-note-mood", owner, "mood", "note", "note-mood");
  card("card-keep", owner, "life", "jot", null);
  card("card-other", other, "mood", "jot", null);
  db.prepare("INSERT INTO notes(id,user_id,text,title,status,created_at,updated_at) VALUES('note-mood',?,'旧心情','旧心情','raw',?,?)").run(owner, stamp, stamp);
  db.prepare("INSERT INTO card_versions(card_id,user_id,kind,by,created_at) VALUES('card-mood',?,'create','user',?)").run(owner, stamp);
  db.prepare("INSERT INTO card_uses(card_id,user_id,kind,ref_id,created_at) VALUES('card-mood',?,'chat','thread-mood',?)").run(owner, stamp);
  db.prepare("INSERT INTO tags(id,user_id,name,color,by,created_at) VALUES('tag-ai-unused',?,'AI空',0,'ai',?),('tag-ai-used',?,'AI留',0,'ai',?),('tag-user-unused',?,'用户留',0,'user',?)").run(owner, stamp, owner, stamp, owner, stamp);
  db.prepare("INSERT INTO card_tags(card_id,tag_id,user_id) VALUES('card-mood','tag-ai-unused',?),('card-keep','tag-ai-used',?)").run(owner, owner);
  db.prepare("INSERT INTO brainstorms(id,user_id,scene,size,cards,status,created_at,updated_at) VALUES('brainstorm-mood',?,'mood','small','[]','ready',?,?),('brainstorm-keep',?,'life','small','[]','ready',?,?)").run(owner, stamp, stamp, owner, stamp, stamp);
  db.prepare("INSERT INTO imports(id,user_id,source,segments,candidates,status,created_at,updated_at) VALUES('import-mood',?,'paste','[1]','[2]','saved',?,?),('import-keep',?,'paste','[3]','[4]','saved',?,?)").run(owner, stamp, stamp, owner, stamp, stamp);
  for (const [id, src, srcId] of [["resume-card", "card", "card-mood"], ["resume-brainstorm", "brainstorm", "brainstorm-mood"], ["resume-import", "import", "import-mood"], ["resume-keep", "card", "card-keep"]] as const)
    db.prepare("INSERT INTO resume_items(id,user_id,src,src_id,item_key,kind,due_on,created_at,updated_at) VALUES(?,?,?,?, 'x','x','2026-10-12',?,?)").run(id, owner, src, srcId, stamp, stamp);
  for (const [id, userId, status, params] of [["job-card", owner, "queued", { cardId: "card-mood" }], ["job-brainstorm", owner, "running", { brainstormId: "brainstorm-mood" }], ["job-import", owner, "succeeded", { importId: "import-mood" }], ["job-note", owner, "queued", { noteId: "note-mood" }], ["job-keep", owner, "queued", { cardId: "card-keep" }], ["job-other", other, "queued", { cardId: "card-other" }]] as const)
    db.prepare("INSERT INTO jobs(id,user_id,kind,params,params_hash,status,result,created_at) VALUES(?,?, 'v2',?,?,?, '{\"secret\":true}',?)").run(id, userId, JSON.stringify(params), id, status, stamp);
}

test("mood consent and removal isolate users and cover all seven designed classes", () => {
  const { store, owner, other, mood, stopped } = setup();
  try {
    seed(store, owner, other);
    assert.deepEqual(mood.consent(owner), { consentedAt: at });
    assert.equal(user(store, owner).moodConsentAt, at);
    const removed = mood.remove(owner);
    assert.deepEqual(removed, { threads: 2, cards: 3, brainstorms: 1, imports: 1, notes: 1, jobs: 4 });
    assert.equal(user(store, owner).moodConsentAt, at, "single deletion keeps consent");
    assert.deepEqual(stopped.threads.sort(), ["thread-cards", "thread-mood"]);
    assert.deepEqual(stopped.jobs.sort(), ["job-brainstorm", "job-card", "job-import", "job-note"]);
    for (const id of ["thread-mood", "thread-cards", "message-mood", "message-cards", "card-mood", "card-import-mood", "card-note-mood", "brainstorm-mood", "note-mood", "resume-card", "resume-brainstorm", "resume-import"])
      assert.equal(store.db.prepare("SELECT 1 FROM threads WHERE id=? UNION ALL SELECT 1 FROM messages WHERE id=? UNION ALL SELECT 1 FROM cards WHERE id=? UNION ALL SELECT 1 FROM brainstorms WHERE id=? UNION ALL SELECT 1 FROM notes WHERE id=? UNION ALL SELECT 1 FROM resume_items WHERE id=?").all(id, id, id, id, id, id).length, 0, id);
    const imported = store.db.prepare("SELECT segments,candidates FROM imports WHERE id='import-mood'").get() as { segments: string; candidates: string | null };
    assert.equal(imported.segments, "[]");
    assert.equal(imported.candidates, null);
    assert.equal((store.db.prepare("SELECT segments FROM imports WHERE id='import-keep'").get() as { segments: string }).segments, "[3]");
    for (const id of ["job-card", "job-brainstorm", "job-import", "job-note"]) {
      const job = store.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Record<string, unknown>;
      assert.deepEqual(JSON.parse(String(job.params)), { deleted: true });
      assert.equal(job.params_hash, `deleted:${id}`);
      assert.equal(job.result, null);
      assert.equal(job.version, null);
      assert.equal(job.status, id === "job-import" ? "succeeded" : "failed");
      assert.equal(id === "job-import" ? job.error_code : job.error_code, id === "job-import" ? null : "MOOD_DELETED");
    }
    for (const id of ["thread-keep", "message-keep", "card-import-keep", "card-keep", "brainstorm-keep", "resume-keep", "job-keep", "tag-ai-used", "tag-user-unused", "thread-other", "message-other", "card-other", "job-other"])
      assert.ok(store.db.prepare("SELECT 1 FROM threads WHERE id=? UNION ALL SELECT 1 FROM messages WHERE id=? UNION ALL SELECT 1 FROM cards WHERE id=? UNION ALL SELECT 1 FROM brainstorms WHERE id=? UNION ALL SELECT 1 FROM resume_items WHERE id=? UNION ALL SELECT 1 FROM jobs WHERE id=? UNION ALL SELECT 1 FROM tags WHERE id=?").all(id, id, id, id, id, id, id).length, id);
    assert.equal(store.db.prepare("SELECT 1 FROM tags WHERE id='tag-ai-unused'").get(), undefined);
  } finally { store.close(); }
});

test("withdrawal is idempotent, clears consent, and a late result cannot recreate deleted content", () => {
  const { store, owner, other, mood } = setup();
  try {
    seed(store, owner, other);
    mood.consent(owner);
    mood.withdrawConsent(owner);
    assert.equal(user(store, owner).moodConsentAt, undefined);
    assert.deepEqual(mood.withdrawConsent(owner), { threads: 0, cards: 0, brainstorms: 0, imports: 0, notes: 0, jobs: 0 });
    // A late worker only has an erased receipt target; no deleted domain row
    // exists for it to update or recreate.
    assert.equal(store.db.prepare("SELECT 1 FROM cards WHERE id='card-mood'").get(), undefined);
    assert.equal(store.db.prepare("SELECT 1 FROM threads WHERE id='thread-mood'").get(), undefined);
    assert.ok(store.db.prepare("SELECT 1 FROM cards WHERE id='card-other'").get());
    assert.ok(store.db.prepare("SELECT 1 FROM cards WHERE id='card-import-keep'").get());
    assert.ok(store.db.prepare("SELECT 1 FROM users WHERE id=?").get(other));
  } finally { store.close(); }
});

test("mood list contains only owned records and erased mood cards still clear imported text", () => {
  const { store, owner, other, mood } = setup();
  try {
    seed(store, owner, other);
    store.db.prepare("UPDATE messages SET content='今天想先理清这件事。然后再做决定' WHERE id='message-mood'").run();
    const before = mood.list(owner);
    assert.equal(before.consentedAt, null);
    assert.deepEqual(before.threads.map((r) => r.title), ['今天想先理清这件事']);
    assert.deepEqual(before.linkedThreads.map((r) => r.id), ['thread-cards']);
    assert.deepEqual(before.counts, { cards: 3, linkedThreads: 1, brainstorms: 1 });
    store.db.prepare("UPDATE imports SET candidates=? WHERE id='import-mood'").run(JSON.stringify([{ savedScene: 'mood' }]));
    store.db.prepare("DELETE FROM cards WHERE id='card-import-mood'").run();
    assert.equal(mood.remove(owner).imports, 1);
    assert.equal(store.db.prepare("SELECT candidates FROM imports WHERE id='import-mood'").get()!.candidates, null);
    assert.equal(mood.list(other).threads.length, 1);
    assert.deepEqual(mood.list(owner).counts, { cards: 0, linkedThreads: 0, brainstorms: 0 });
  } finally { store.close(); }
});

test("the consent routes require the current user and deletion cancels a late job before it can commit", async () => {
  const store = new SqliteStore(":memory:");
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  let began!: () => void;
  const running = new Promise<void>((resolve) => {
    began = resolve;
  });
  const runner = new JobRunner(store, {
    mood_work: {
      run: async () => {
        began();
        await started;
        return { output: { late: true } };
      },
      commit: () => {
        throw new Error("a deleted mood job must not commit");
      },
    },
  }, { concurrency: 1, timeoutMs: 5000, limits: {} });
  const mood = new MoodService(store, {
    stopJobs: (_userId, ids) => runner.cancel(ids),
  });
  const app = makeApp(fakeServices(), {}, undefined, store);
  try {
    const login = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "mood-route-owner" } });
    const { token, user } = login.json().data as { token: string; user: { id: string } };
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await app.inject({ method: "PUT", url: "/v1/me/mood-consent", headers: auth })).statusCode, 200);
    assert.ok(store.getUser(user.id)!.moodConsentAt);
    assert.equal((await app.inject({ url: "/v1/mood", headers: auth })).statusCode, 200);
    assert.equal((await app.inject({ url: "/v1/mood" })).statusCode, 401);
    const stamp = "2026-10-12T00:00:00.000Z";
    store.db.prepare("INSERT INTO cards(id,user_id,type,scene,title,title_by,origin,created_at,updated_at) VALUES('route-api-card',?,'idea','mood','x','user','jot',?,?)").run(user.id, stamp, stamp);
    assert.equal((await app.inject({ method: "DELETE", url: "/v1/mood", headers: auth })).statusCode, 200);
    assert.equal(store.db.prepare("SELECT 1 FROM cards WHERE id='route-api-card'").get(), undefined);
    store.db.prepare("INSERT INTO cards(id,user_id,type,scene,title,title_by,origin,created_at,updated_at) VALUES('route-card',?,'idea','mood','x','user','jot',?,?)").run(user.id, stamp, stamp);
    const job = runner.enqueue({ userId: user.id, kind: "mood_work", params: { cardId: "route-card" } }).job;
    await running;
    mood.remove(user.id);
    release();
    await runner.idle();
    assert.equal(store.db.prepare("SELECT 1 FROM cards WHERE id='route-card'").get(), undefined);
    const receipt = store.db.prepare("SELECT status,result,error_code FROM jobs WHERE id=?").get(job.id) as { status: string; result: string | null; error_code: string | null };
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.result, null);
    assert.equal(receipt.error_code, "MOOD_DELETED");
    assert.equal((await app.inject({ method: "DELETE", url: "/v1/me/mood-consent", headers: auth })).statusCode, 200);
    assert.equal(store.getUser(user.id)!.moodConsentAt, undefined);
  } finally {
    release?.();
    await runner.stop();
    await app.close();
  }
});
