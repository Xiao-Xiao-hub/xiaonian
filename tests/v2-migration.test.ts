import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, SqliteStore } from "../server/src/shared/store.js";

const tempDb = () =>
  join(mkdtempSync(join(tmpdir(), "zhiye-v2-")), "app.sqlite");

test("migration 16 creates the v2 schema and copies legacy notes into cards", () => {
  assert.ok(MIGRATIONS.length >= 16);
  const path = tempDb();
  const legacy = new DatabaseSync(path);
  const appliedAt = "2026-10-12T00:00:00.000Z";
  legacy.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
  );
  for (const [index, migration] of MIGRATIONS.slice(0, 15).entries()) {
    legacy.exec(migration!);
    legacy
      .prepare("INSERT INTO schema_migrations VALUES(?,?)")
      .run(index + 1, appliedAt);
  }
  legacy
    .prepare("INSERT INTO users(id,openid,data) VALUES(?,?,?)")
    .run("usr_legacy", "legacy-openid", "{}");
  const insertNote = legacy.prepare(
    "INSERT INTO notes(id,user_id,text,title,status,point_id,created_at,updated_at,title_edited) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  insertNote.run(
    "note_ai",
    "usr_legacy",
    "原来的学习随心记",
    "AI 整理的标题",
    "organized",
    "limit",
    "2026-10-01T18:00:00.000Z",
    "2026-10-02T00:00:00.000Z",
    0,
  );
  insertNote.run(
    "note_user",
    "usr_legacy",
    "原来的生活随心记",
    "我的标题",
    "raw",
    null,
    "2026-10-01T01:00:00.000Z",
    "2026-10-01T01:30:00.000Z",
    1,
  );
  legacy
    .prepare(
      "INSERT INTO note_supplements(id,note_id,client_id,text,created_at) VALUES(?,?,?,?,?)",
    )
    .run(
      "supp_1",
      "note_ai",
      "client_1",
      "后来补充的内容",
      "2026-10-02T01:00:00.000Z",
    );
  legacy.close();

  const store = new SqliteStore(path);
  try {
    const tables = (
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[]
    ).map(({ name }) => name);
    for (const table of [
      "cards",
      "card_versions",
      "card_links",
      "card_uses",
      "tags",
      "card_tags",
      "resume_items",
      "brainstorms",
      "imports",
      "retests",
    ])
      assert.ok(tables.includes(table), table);

    const indexes = (
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as { name: string }[]
    ).map(({ name }) => name);
    for (const index of [
      "cards_wall",
      "cards_point",
      "card_versions_card",
      "card_tags_tag",
      "resume_items_due",
      "retests_open",
      "retests_due",
    ])
      assert.ok(indexes.includes(index), index);

    assert.deepEqual(
      store.db
        .prepare(
          "SELECT id,user_id,type,scene,title,title_by,quote,quote_on,origin,src_id,point_id,organized_at FROM cards ORDER BY id",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          id: "card_note_ai",
          user_id: "usr_legacy",
          type: "idea",
          scene: "study",
          title: "AI 整理的标题",
          title_by: "ai",
          quote: "原来的学习随心记",
          quote_on: "2026-10-02",
          origin: "note",
          src_id: "note_ai",
          point_id: "limit",
          organized_at: null,
        },
        {
          id: "card_note_user",
          user_id: "usr_legacy",
          type: "idea",
          scene: "life",
          title: "我的标题",
          title_by: "user",
          quote: "原来的生活随心记",
          quote_on: "2026-10-01",
          origin: "note",
          src_id: "note_user",
          point_id: null,
          organized_at: null,
        },
      ],
    );
    assert.deepEqual(
      store.db
        .prepare("SELECT card_id,kind,by,data FROM card_versions ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      [
        {
          card_id: "card_note_ai",
          kind: "create",
          by: "system",
          data: '{"from":"note"}',
        },
        {
          card_id: "card_note_user",
          kind: "create",
          by: "system",
          data: '{"from":"note"}',
        },
        {
          card_id: "card_note_ai",
          kind: "supplement",
          by: "user",
          data: '{"text":"后来补充的内容"}',
        },
      ],
    );
    assert.deepEqual(
      store.db
        .prepare("PRAGMA table_info(threads)")
        .all()
        .map((r: { name: string }) => r.name)
        .slice(-3),
      ["scene", "mode", "mood_cards"],
    );
    assert.ok(
      store.db
        .prepare("PRAGMA table_info(map_points)")
        .all()
        .some((r: { name: string }) => r.name === "stuck_at"),
    );
    assert.ok(
      store.db
        .prepare("PRAGMA table_info(usage_ledger)")
        .all()
        .some((r: { name: string }) => r.name === "scene"),
    );
    assert.ok(
      store.db
        .prepare("PRAGMA table_info(usage_ledger)")
        .all()
        .some((r: { name: string }) => r.name === "cached_tokens"),
    );
  } finally {
    store.close();
  }
  const reopened = new SqliteStore(path);
  try {
    assert.equal(
      (
        reopened.db.prepare("SELECT count(*) AS n FROM cards").get() as {
          n: number;
        }
      ).n,
      2,
    );
    assert.equal(
      (
        reopened.db
          .prepare("SELECT count(*) AS n FROM card_versions")
          .get() as { n: number }
      ).n,
      3,
    );
    assert.equal(
      (
        reopened.db.prepare("SELECT count(*) AS n FROM notes").get() as {
          n: number;
        }
      ).n,
      2,
    );
  } finally {
    reopened.close();
  }
});

test("v3 columns are added idempotently without bumping the schema version", () => {
  const path = tempDb();
  new SqliteStore(path).close();
  const store = new SqliteStore(path);
  try {
    const columns = (table: string) =>
      store.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((r: { name: string }) => r.name);
    assert.ok(columns("cards").includes("favorite"));
    assert.ok(columns("cards").includes("remind_on"));
    assert.ok(columns("brainstorms").includes("report"));
    assert.equal(
      (
        store.db
          .prepare("SELECT MAX(version) AS v FROM schema_migrations")
          .get() as { v: number }
      ).v,
      MIGRATIONS.length,
    );
  } finally {
    store.close();
  }
});
