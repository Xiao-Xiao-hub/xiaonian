import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, SqliteStore } from "../server/src/shared/store.js";

const rowCounts = (db: DatabaseSync) => Object.fromEntries(
  ["users", "settings", "commercial_orders", "commercial_buckets", "commercial_order_grants", "commercial_refunds"].map(table => [
    table,
    Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n),
  ]),
);

test("v24 backfills retained-order fields without changing old records or replaying", () => {
  const path = join(mkdtempSync(join(tmpdir(), "zhiye-retention-v24-")), "app.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const [index, migration] of MIGRATIONS.slice(0, 23).entries()) {
      db.exec(migration!);
      db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(index + 1, "2026-10-24T00:00:00.000Z");
    }
    db.exec(`
      INSERT INTO users(id,openid,data) VALUES('user','openid-retained','{}');
      INSERT INTO settings(key,value,updated_at) VALUES('commercial.catalog','{"version":"legacy"}', '2026-10-20T00:00:00.000Z');
      INSERT INTO commercial_orders(id,user_id,idempotency_key,good_id,amount_cents,snapshot,catalog_version,env,status,paid_at,created_at)
        VALUES('delivered','user','key-delivered','points_10',1000,'{}','legacy',0,'delivered',1700000000000,1600000000000),
              ('closed','user','key-closed','points_10',1000,'{}','legacy',0,'closed',NULL,1600000000001);
      INSERT INTO commercial_buckets(id,user_id,kind,starts_at,ends_at,grant_credits,created_at)
        VALUES('bucket','user','wallet',1600000000000,NULL,100,'2026-10-24T01:02:03.456Z');
      INSERT INTO commercial_order_grants(order_id,bucket_id) VALUES('delivered','bucket');
      INSERT INTO audit(id,actor,action,resource_id,details,created_at)
        VALUES('closed-audit','system','commercial.order.closed','closed','{}','2026-10-24T02:03:04.567Z');
    `);
    const before = rowCounts(db);
    const setting = db.prepare("SELECT value,updated_at FROM settings WHERE key='commercial.catalog'").get();
    db.exec(MIGRATIONS[23]!);
    db.prepare("INSERT INTO schema_migrations VALUES(24,?)").run("2026-10-24T03:00:00.000Z");
    assert.deepEqual(rowCounts(db), before);
    assert.deepEqual(db.prepare("SELECT value,updated_at FROM settings WHERE key='commercial.catalog'").get(), setting);
    assert.deepEqual(
      (db.prepare("SELECT id,buyer_openid,delivered_at,closed_at FROM commercial_orders ORDER BY id").all() as object[]).map(row => ({ ...row })),
      [
        { id: "closed", buyer_openid: "openid-retained", delivered_at: null, closed_at: Date.parse("2026-10-24T02:03:04.567Z") },
        { id: "delivered", buyer_openid: "openid-retained", delivered_at: Date.parse("2026-10-24T01:02:03.456Z"), closed_at: null },
      ],
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
  const reopened = new SqliteStore(path);
  try {
    assert.equal((reopened.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, 25);
    assert.equal((reopened.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=24").get() as { n: number }).n, 1);
    assert.deepEqual(reopened.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    reopened.close();
  }
});
