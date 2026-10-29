import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, SqliteStore } from "../server/src/shared/store.js";

const tempDb = () =>
  join(
    mkdtempSync(join(tmpdir(), "zhiye-commercial-migration-")),
    "app.sqlite",
  );

const tableNames = (db: DatabaseSync) =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);

test("v23 preserves refund attempt history and old replies while enforcing per-ticket reply keys", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    for (const migration of MIGRATIONS.slice(0, 22)) db.exec(migration!);
    db.exec(`
      INSERT INTO users(id,openid,data) VALUES('legacy-user','legacy-openid','{}');
      INSERT INTO commercial_orders(id,user_id,idempotency_key,good_id,amount_cents,snapshot,catalog_version,env,status,created_at)
        VALUES('order','legacy-user','legacy-order','points_10',1000,'{}','legacy',0,'delivered',1);
      INSERT INTO commercial_refunds(id,order_id,actor,reason,reason_code,amount_cents,holdings,status,submission_status,requested_at,updated_at)
        VALUES('refund','order','admin','legacy',0,1000,'[]','failed','failed',1,2);
      INSERT INTO audit VALUES('request','admin','commercial.refund.requested','order','{}','2026-10-24T00:00:00Z');
      INSERT INTO audit VALUES('retry','admin','commercial.refund.retried','order','{}','2026-10-24T01:00:00Z');
      INSERT INTO support_turns VALUES('turn','legacy-user','问题','答案','answer',1,'2026-10-24');
      INSERT INTO support_tickets VALUES('ticket','legacy-user','turn','create-key','open','问题','2026-10-27','2026-10-24','2026-10-24');
      INSERT INTO ticket_replies VALUES('old-reply','ticket','admin','reason','原回复','2026-10-24');
    `);
    for (const migration of MIGRATIONS.slice(22)) db.exec(migration!);
    assert.equal(db.prepare("SELECT attempt FROM commercial_refunds").get()!.attempt, 2);
    assert.equal(db.prepare("SELECT idempotency_key FROM ticket_replies WHERE id='old-reply'").get()!.idempotency_key, null);
    db.exec("DELETE FROM audit");
    assert.equal(db.prepare("SELECT attempt FROM commercial_refunds").get()!.attempt, 2);
    const reply = db.prepare("INSERT INTO ticket_replies(id,ticket_id,actor,reason,content,created_at,idempotency_key) VALUES(?,'ticket','admin','reason','reply','2026-10-24',?)");
    reply.run("new-reply", "retry-key");
    assert.throws(() => reply.run("duplicate-reply", "retry-key"), /UNIQUE/);
    reply.run("other-old-reply", null);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("commercial migrations preserve a populated v16 database without enabling commerce", () => {
  assert.ok(MIGRATIONS.length >= 18);
  const path = tempDb();
  const legacy = new DatabaseSync(path);
  let legacyClosed = false;
  try {
    legacy.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const [index, migration] of MIGRATIONS.slice(0, 16).entries()) {
      legacy.exec(migration!);
      legacy
        .prepare("INSERT INTO schema_migrations VALUES(?,?)")
        .run(index + 1, "2026-10-23T00:00:00.000Z");
    }
    // These v4 tables were added idempotently without a migration-version bump.
    legacy.exec(`
      CREATE TABLE study_days(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,day TEXT NOT NULL,seconds INTEGER NOT NULL CHECK(seconds BETWEEN 0 AND 86400),updated_at TEXT NOT NULL,PRIMARY KEY(user_id,day));
      CREATE TABLE card_reminders(card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,every TEXT NOT NULL CHECK(every IN ('day','week')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE chat_attachments(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('image','file')),image_id TEXT REFERENCES chat_images(id) ON DELETE CASCADE,name TEXT NOT NULL,size INTEGER NOT NULL CHECK(size>=0),type TEXT NOT NULL,text TEXT,chars INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,text_from INTEGER);
      CREATE TABLE quota_voids(source TEXT NOT NULL,source_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,job_id TEXT,created_at TEXT NOT NULL,PRIMARY KEY(source,source_id));
      CREATE TABLE quota_spend(source TEXT NOT NULL,source_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,usage TEXT NOT NULL CHECK(json_valid(usage)),created_at TEXT NOT NULL,PRIMARY KEY(source,source_id));
    `);
    legacy
      .prepare("INSERT INTO users(id,openid,data,quota) VALUES(?,?,?,?)")
      .run(
        "usr_v16",
        "openid-v16",
        '{"id":"usr_v16","openid":"openid-v16","authMode":"wechat"}',
        '{"chat":9,"ocr":3}',
      );
    legacy
      .prepare(
        "INSERT INTO notes(id,user_id,text,title,status,point_id,created_at,updated_at,title_edited) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "note_v16",
        "usr_v16",
        "保留的旧随心记",
        "旧标题",
        "raw",
        null,
        "2026-10-20T00:00:00.000Z",
        "2026-10-20T00:00:00.000Z",
        1,
      );
    const beforeTables = tableNames(legacy);
    legacy.close();
    legacyClosed = true;

    const store = new SqliteStore(path);
    try {
      assert.equal(
        (
          store.db
            .prepare("SELECT MAX(version) AS v FROM schema_migrations")
            .get() as { v: number }
        ).v,
        MIGRATIONS.length,
      );
      assert.deepEqual(
        tableNames(store.db).filter((table) => !beforeTables.includes(table)),
        [
          "commercial_buckets",
          "commercial_calls",
          "commercial_entries",
          "commercial_free_entries",
          "commercial_order_grants",
          "commercial_orders",
          "commercial_refunds",
          "commercial_usage",
          "support_chat_requests",
          "support_cost_holds",
          "support_mail_outbox",
          "support_notifications",
          "support_session_turns",
          "support_sessions",
          "support_tickets",
          "support_turns",
          "ticket_replies",
          "wechat_payment_sessions",
        ],
      );
      assert.deepEqual(
        {
          ...(store.db
            .prepare(
              "SELECT id,openid,data,quota FROM users WHERE id='usr_v16'",
            )
            .get() as object),
        },
        {
          id: "usr_v16",
          openid: "openid-v16",
          data: '{"id":"usr_v16","openid":"openid-v16","authMode":"wechat"}',
          quota: '{"chat":9,"ocr":3}',
        },
      );
      assert.deepEqual(
        {
          ...(store.db
            .prepare(
              "SELECT id,user_id,text,title,status FROM notes WHERE id='note_v16'",
            )
            .get() as object),
        },
        {
          id: "note_v16",
          user_id: "usr_v16",
          text: "保留的旧随心记",
          title: "旧标题",
          status: "raw",
        },
      );
      assert.equal(store.setting("commercial.catalog"), undefined);
      assert.equal(
        (
          store.db
            .prepare("SELECT COUNT(*) AS n FROM commercial_buckets")
            .get() as { n: number }
        ).n,
        0,
      );
      assert.equal(
        (
          store.db
            .prepare("SELECT COUNT(*) AS n FROM commercial_free_entries")
            .get() as { n: number }
        ).n,
        0,
      );
    } finally {
      store.close();
    }
  } finally {
    if (!legacyClosed) legacy.close();
  }
});
