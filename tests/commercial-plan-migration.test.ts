import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, PLAN_CHAIN_SHIFT_SQL } from "../server/src/shared/store.js";

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

function v24() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of MIGRATIONS.slice(0, 24)) db.exec(migration!);
  return db;
}

function plan(db: DatabaseSync, user: string, id: string, good: string, paidAt: number, status = "delivered") {
  db.prepare(
    `INSERT INTO commercial_orders(id,user_id,idempotency_key,good_id,amount_cents,snapshot,catalog_version,env,status,wx_order_id,platform,paid_at,created_at,buyer_openid,delivered_at)
     VALUES(?,?,?,?,1000,'{}','v',0,?,?,'android',?,?,?,?)`,
  ).run(id, user, id, good, status, `wx-${id}`, paidAt, paidAt, `openid-${user}`, paidAt);
  const end = paidAt + 30 * DAY;
  const bucket = db.prepare("INSERT INTO commercial_buckets(id,user_id,kind,starts_at,ends_at,grant_credits,created_at) VALUES(?,?,?,?,?,?,'2026-10-24T00:00:00Z')");
  const entry = db.prepare("INSERT INTO commercial_entries(bucket_id,event_key,kind,delta,created_at) VALUES(?,?,'grant',?,'2026-10-24T00:00:00Z')");
  const grant = db.prepare("INSERT INTO commercial_order_grants(order_id,bucket_id) VALUES(?,?)");
  bucket.run(`plan-total:${id}`, user, "plan_total", paidAt, end, 400);
  entry.run(`plan-total:${id}`, `grant:${id}:total`, 400);
  grant.run(id, `plan-total:${id}`);
  for (let n = 0; n < 5; n++) {
    const weekId = `plan-week:${id}:${n + 1}`;
    bucket.run(weekId, user, "plan_week", paidAt + n * WEEK, Math.min(paidAt + (n + 1) * WEEK, end), 100);
    entry.run(weekId, `grant:${id}:week:${n}`, 100);
    grant.run(id, weekId);
  }
}

const spans = (db: DatabaseSync, id: string) =>
  db.prepare(
    `SELECT b.kind,b.starts_at,b.ends_at FROM commercial_order_grants g JOIN commercial_buckets b ON b.id=g.bucket_id
     WHERE g.order_id=? ORDER BY b.kind,b.starts_at`,
  ).all(id) as Array<{ kind: string; starts_at: number; ends_at: number }>;
const total = (db: DatabaseSync, id: string) => spans(db, id).find(row => row.kind === "plan_total")!;

test("v25 queues the production buyer's parallel Max, Max, Plus by payment time and keeps entries", () => {
  const db = v24();
  try {
    db.exec(`
      INSERT INTO users(id,openid,data) VALUES('buyer','openid-buyer','{}');
      INSERT INTO users(id,openid,data) VALUES('calm','openid-calm','{}');
    `);
    const first = Date.parse("2026-10-24T18:30:00Z");
    plan(db, "buyer", "max-1", "plan_advanced_30d", first);
    plan(db, "buyer", "max-2", "plan_advanced_30d", Date.parse("2026-10-24T18:31:00Z"));
    plan(db, "buyer", "plus-3", "plan_entry_30d", Date.parse("2026-10-24T18:32:00Z"));
    // A refunded plan never joins the chain; already sequential plans stay.
    plan(db, "buyer", "refunded", "plan_standard_30d", Date.parse("2026-10-24T18:29:00Z"), "refunded");
    plan(db, "calm", "calm-1", "plan_entry_30d", first - 40 * DAY);
    plan(db, "calm", "calm-2", "plan_entry_30d", first);
    const entriesBefore = db.prepare("SELECT COUNT(*) n,SUM(delta) d FROM commercial_entries").get();
    const weekShape = spans(db, "plus-3").filter(row => row.kind === "plan_week").map(row => row.ends_at - row.starts_at);

    db.exec(MIGRATIONS[24]!);

    const beijing = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
    assert.deepEqual(
      ["max-1", "max-2", "plus-3"].map(id => [beijing(total(db, id).starts_at), beijing(total(db, id).ends_at)]),
      [["2026-10-25", "2026-11-24"], ["2026-11-24", "2026-12-24"], ["2026-12-24", "2027-01-23"]],
    );
    // UTC dates as reported: Max 10-24→11-23, Max 11-23→12-23, Plus 12-23→01-22.
    assert.equal(total(db, "max-1").starts_at, first);
    assert.equal(total(db, "max-2").starts_at, first + 30 * DAY);
    assert.equal(total(db, "plus-3").starts_at, first + 60 * DAY);
    assert.equal(new Date(total(db, "plus-3").ends_at).toISOString(), "2027-01-22T18:30:00.000Z");
    // Week windows move with their order.
    const weeks = spans(db, "plus-3").filter(row => row.kind === "plan_week");
    assert.equal(weeks[0]!.starts_at, first + 60 * DAY);
    assert.deepEqual(weeks.map(row => row.ends_at - row.starts_at), weekShape);
    assert.equal(total(db, "refunded").starts_at, Date.parse("2026-10-24T18:29:00Z"));
    assert.equal(total(db, "calm-1").starts_at, first - 40 * DAY);
    assert.equal(total(db, "calm-2").starts_at, first);
    assert.deepEqual(db.prepare("SELECT COUNT(*) n,SUM(delta) d FROM commercial_entries").get(), entriesBefore);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM commercial_orders WHERE superseded_by IS NOT NULL").get()!.n, 0);

    // Rerunning the shift leaves an already queued chain unchanged.
    const snapshot = JSON.stringify(db.prepare("SELECT * FROM commercial_buckets ORDER BY id").all());
    db.exec(PLAN_CHAIN_SHIFT_SQL);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM commercial_buckets ORDER BY id").all()), snapshot);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("v25 runs on an empty database", () => {
  const db = v24();
  try {
    db.exec(MIGRATIONS[24]!);
    db.exec(PLAN_CHAIN_SHIFT_SQL);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM commercial_buckets").get()!.n, 0);
    const columns = (db.prepare("PRAGMA table_info(commercial_orders)").all() as { name: string }[]).map(row => row.name);
    assert.ok(columns.includes("superseded_by"));
  } finally { db.close(); }
});

test("v25 queues only delivered plans: refunding and refunded stay put, an expired overlap still pushes the next plan", () => {
  const db = v24();
  try {
    db.exec("INSERT INTO users(id,openid,data) VALUES('mixed','openid-mixed','{}')");
    const t0 = Date.parse("2026-10-25T00:00:00Z");
    plan(db, "mixed", "oA", "plan_entry_30d", t0 - 40 * DAY); // expired at t0-10d
    plan(db, "mixed", "oB", "plan_entry_30d", t0 - 20 * DAY, "refunded");
    plan(db, "mixed", "oC", "plan_entry_30d", t0 - 15 * DAY);
    plan(db, "mixed", "oD", "plan_entry_30d", t0 - 2 * DAY, "refunding");
    plan(db, "mixed", "oE", "plan_entry_30d", t0 - DAY);
    db.exec(MIGRATIONS[24]!);
    const days = (id: string) => [(total(db, id).starts_at - t0) / DAY, (total(db, id).ends_at - t0) / DAY];
    const after = ["oA", "oB", "oC", "oD", "oE"].map(days);
    assert.deepEqual(after, [[-40, -10], [-20, 10], [-10, 20], [-2, 28], [20, 50]]);
    db.exec(PLAN_CHAIN_SHIFT_SQL);
    assert.deepEqual(["oA", "oB", "oC", "oD", "oE"].map(days), after);
  } finally {
    db.close();
  }
});
