import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommercialLedger } from "../server/src/shared/commercial-ledger.js";
import { SqliteStore } from "../server/src/shared/store.js";

const HOUR = 60 * 60 * 1000;

function fixture(at = Date.parse("2026-10-26T16:00:00.000Z")) {
  let ms = at;
  const store = new SqliteStore(":memory:");
  const ledger = new CommercialLedger(store, () => new Date(ms));
  const user = store.upsertUser(`ledger-${Math.random()}`, "账本测试", "dev");
  return {
    store,
    ledger,
    user,
    get now() { return ms; },
    set now(value: number) { ms = value; },
    bucket(id: string, credits: number, kind: "free_day" | "free_week" | "free_month" | "plan_week" | "plan_total" | "wallet" = "wallet", startsAt = 0, endsAt: number | null = null) {
      ledger.ensureBucket({ id, userId: user.id, kind, credits, startsAt, endsAt });
    },
    close() { store.close(); },
  };
}

const source = (name: string, ...buckets: string[]) => ({ name, buckets });
const reserve = (ledger: CommercialLedger, userId: string, id: string, credits: number, sources: ReturnType<typeof source>[]) =>
  ledger.reserve({ id, userId, source: "llm", credits, sources, price: { version: "price-v1", input: 1 }, leaseMs: HOUR });

test("fractional carry follows settlement order even when calls finish in reverse in the same millisecond", () => {
  const f = fixture();
  try {
    f.bucket("wallet", 5);
    for (const id of ["first", "second", "third"]) reserve(f.ledger, f.user.id, id, 1, [source("wallet", "wallet")]);
    assert.equal(f.ledger.settleExact(f.user.id, "second", 400n, 1n, 1000)?.charged, 0);
    assert.equal(f.ledger.settleExact(f.user.id, "first", 400n, 1n, 1000)?.charged, 0);
    assert.equal(f.ledger.settleExact(f.user.id, "third", 400n, 1n, 1000)?.charged, 1);
    assert.equal(f.ledger.balance("wallet"), 4);
  } finally { f.close(); }
});

test("daily and weekly caps take their minimum and are each debited only once", () => {
  const f = fixture();
  try {
    f.bucket("day", 4, "free_day");
    f.bucket("week", 2, "free_week");
    assert.throws(() => reserve(f.ledger, f.user.id, "over-minimum", 3, [source("free", "day", "week")]), { code: "CREDIT_LIMIT" });
    assert.deepEqual(reserve(f.ledger, f.user.id, "at-minimum", 2, [source("free", "day", "week")]), {
      id: "at-minimum", status: "held", credits: 2,
    });
    assert.equal(f.ledger.balance("day"), 2);
    assert.equal(f.ledger.balance("week"), 0);
  } finally { f.close(); }
});

test("reserving follows free, plan, wallet order; settling returns the unused allocations", () => {
  const f = fixture();
  try {
    f.bucket("free", 2, "free_day");
    f.bucket("plan", 3, "plan_total");
    f.bucket("wallet", 5);
    reserve(f.ledger, f.user.id, "ordered", 7, [source("free", "free"), source("plan", "plan"), source("wallet", "wallet")]);
    assert.deepEqual(f.ledger.settle(f.user.id, "ordered", 4_000, 1_000), { charged: 4, overrun: 0 });
    assert.deepEqual([f.ledger.balance("free"), f.ledger.balance("plan"), f.ledger.balance("wallet")], [0, 1, 5]);
  } finally { f.close(); }
});

test("settle releases the reservation difference, and settle/release are idempotent", () => {
  const f = fixture();
  try {
    f.bucket("wallet", 12);
    reserve(f.ledger, f.user.id, "settle-once", 10, [source("wallet", "wallet")]);
    assert.deepEqual(f.ledger.settle(f.user.id, "settle-once", 4_000, 1_000), { charged: 4, overrun: 0 });
    assert.deepEqual(f.ledger.settle(f.user.id, "settle-once", 4_000, 1_000), { charged: 4, overrun: 0 });
    f.ledger.release(f.user.id, "settle-once");
    assert.equal(f.ledger.balance("wallet"), 8);
    reserve(f.ledger, f.user.id, "release-once", 2, [source("wallet", "wallet")]);
    f.ledger.release(f.user.id, "release-once");
    f.ledger.release(f.user.id, "release-once");
    assert.equal(f.ledger.balance("wallet"), 8);
  } finally { f.close(); }
});

test("call IDs reject changed parameters or owners, and buckets cannot cross users", () => {
  const f = fixture();
  try {
    f.bucket("mine", 4);
    reserve(f.ledger, f.user.id, "same-id", 2, [source("wallet", "mine")]);
    assert.throws(() => reserve(f.ledger, f.user.id, "same-id", 3, [source("wallet", "mine")]), { code: "CREDIT_CONFLICT" });
    const other = f.store.upsertUser(`other-${Math.random()}`, "另一人", "dev");
    assert.throws(() => reserve(f.ledger, other.id, "same-id", 2, [source("wallet", "mine")]), { code: "CREDIT_CONFLICT" });
    assert.throws(() => reserve(f.ledger, other.id, "other-id", 1, [source("wallet", "mine")]), { code: "CREDIT_BUCKET_MISSING" });
  } finally { f.close(); }
});

test("forty competing reservations never reserve more than the SQLite balance", () => {
  const f = fixture();
  try {
    f.bucket("wallet", 17);
    const results = Array.from({ length: 40 }, (_, i) => {
      try { return reserve(f.ledger, f.user.id, `race-${i}`, 1, [source("wallet", "wallet")]); }
      catch (error) { return error; }
    });
    assert.equal(results.filter((result) => !(result instanceof Error)).length, 17);
    assert.equal(results.filter((result) => result instanceof Error).length, 23);
    assert.equal(f.ledger.balance("wallet"), 0);
    assert.equal(f.store.db.prepare("SELECT COALESCE(SUM(reserved_credits),0) total FROM commercial_calls WHERE status='held'").get()!.total, 17);
  } finally { f.close(); }
});

test("a second SQLite connection sees the same reservations and cannot overspend", () => {
  const path = join(mkdtempSync(join(tmpdir(), "commercial-ledger-")), "ledger.sqlite");
  const store1 = new SqliteStore(path);
  const store2 = new SqliteStore(path);
  try {
    const user = store1.upsertUser("two-connections", "双连接", "dev");
    let now = Date.parse("2026-10-26T16:00:00.000Z");
    const ledger1 = new CommercialLedger(store1, () => new Date(now));
    const ledger2 = new CommercialLedger(store2, () => new Date(now));
    ledger1.ensureBucket({ id: "shared", userId: user.id, kind: "wallet", credits: 5, startsAt: 0, endsAt: null });
    let held = 0;
    for (let i = 0; i < 12; i++) {
      try {
        reserve(i % 2 ? ledger1 : ledger2, user.id, `connection-${i}`, 1, [source("wallet", "shared")]);
        held++;
      } catch (error) {
        assert.equal((error as { code?: string }).code, "CREDIT_LIMIT");
      }
    }
    assert.equal(held, 5);
    assert.equal(ledger1.balance("shared"), 0);
    now += 1;
  } finally {
    store2.close();
    store1.close();
  }
});

test("fractional costs carry forward: 100 one-hundredth-credit calls charge one credit, not 100", () => {
  const f = fixture();
  try {
    f.bucket("wallet", 100);
    for (let i = 0; i < 100; i++) {
      const id = `fraction-${i}`;
      reserve(f.ledger, f.user.id, id, 1, [source("wallet", "wallet")]);
      assert.deepEqual(f.ledger.settle(f.user.id, id, 10, 1_000), { charged: i === 99 ? 1 : 0, overrun: 0 });
    }
    assert.equal(f.ledger.balance("wallet"), 99);
  } finally { f.close(); }
});

test("exact settlement carries sub-microyuan cost and verifies idempotent inputs", () => {
  const f = fixture();
  try {
    f.bucket("wallet", 10);
    for (let i = 0; i < 5; i++) {
      const id = `exact-${i}`;
      f.ledger.reserve({ id, userId: f.user.id, source: "llm", credits: 1,
        sources: [source("wallet", "wallet")], price: { version: "v1", microyuanPerCredit: 1 }, leaseMs: HOUR });
      const expected = i === 1 || i === 2 || i === 3 || i === 4 ? 1 : 0;
      assert.deepEqual(f.ledger.settleExact(f.user.id, id, 8n, 10n, 1), { charged: expected, overrun: 0 });
    }
    assert.equal(f.ledger.balance("wallet"), 6);
    const rows = f.store.db.prepare(
      "SELECT exact_numerator,exact_denominator,remainder_before,remainder_after,cost_microyuan FROM commercial_calls WHERE id LIKE 'exact-%' ORDER BY rowid",
    ).all().map(row => ({ ...row }));
    assert.deepEqual(rows, [
      { exact_numerator: "8", exact_denominator: "10", remainder_before: "0", remainder_after: "8", cost_microyuan: 1 },
      { exact_numerator: "8", exact_denominator: "10", remainder_before: "8", remainder_after: "6", cost_microyuan: 1 },
      { exact_numerator: "8", exact_denominator: "10", remainder_before: "6", remainder_after: "4", cost_microyuan: 1 },
      { exact_numerator: "8", exact_denominator: "10", remainder_before: "4", remainder_after: "2", cost_microyuan: 1 },
      { exact_numerator: "8", exact_denominator: "10", remainder_before: "2", remainder_after: "0", cost_microyuan: 1 },
    ]);
    assert.deepEqual(f.ledger.settleExact(f.user.id, "exact-4", 8n, 10n, 1), { charged: 1, overrun: 0 });
    assert.throws(() => f.ledger.settleExact(f.user.id, "exact-4", 9n, 10n, 1), { code: "CREDIT_CONFLICT" });
    assert.throws(() => f.ledger.settleExact(f.user.id, "exact-4", 8n, 10n, 2), { code: "CREDIT_CONFLICT" });
  } finally { f.close(); }
});

test("failed free calls refund user credit but retain known or unknown global cost", () => {
  const f = fixture();
  try {
    f.bucket("free", 20, "free_month");
    const cap = { month: "2026-10", limitMicroyuan: 10_000, microyuanPerCredit: 1_000 };
    const hold = (id: string) => f.ledger.reserve({ id, userId: f.user.id, source: "llm", credits: 3,
      sources: [source("free", "free")], price: { version: "v1" }, leaseMs: HOUR, freeCostCap: cap });
    hold("not-sent");
    f.ledger.release(f.user.id, "not-sent", 0);
    assert.equal(f.ledger.freeCostRemaining(cap.month), 10_000);
    hold("known-failure");
    f.ledger.release(f.user.id, "known-failure", 500);
    assert.equal(f.ledger.freeCostRemaining(cap.month), 9_500);
    hold("unknown-failure");
    f.ledger.release(f.user.id, "unknown-failure");
    assert.equal(f.ledger.freeCostRemaining(cap.month), 6_500);
    assert.equal(f.ledger.balance("free"), 20);
    f.store.db.prepare("DELETE FROM users WHERE id=?").run(f.user.id);
    assert.equal(f.ledger.freeCostRemaining(cap.month), 6_500);
    const orphan = f.store.db.prepare(
      "SELECT call_id FROM commercial_free_entries WHERE event_key='reserve:unknown-failure'",
    ).get() as { call_id: string | null };
    assert.equal(orphan.call_id, null);
  } finally { f.close(); }
});

test("overrun is borne by the merchant, never makes a bucket negative", () => {
  const f = fixture();
  try {
    f.bucket("wallet", 3);
    reserve(f.ledger, f.user.id, "overrun", 3, [source("wallet", "wallet")]);
    assert.deepEqual(f.ledger.settle(f.user.id, "overrun", 9_000, 1_000), { charged: 3, overrun: 6 });
    assert.equal(f.ledger.balance("wallet"), 0);
    assert.equal(f.store.db.prepare("SELECT MIN(delta) least FROM commercial_entries WHERE bucket_id='wallet'").get()!.least, -3);
  } finally { f.close(); }
});

test("each call keeps its price snapshot after a later price change", () => {
  const f = fixture();
  try {
    f.bucket("wallet", 2);
    f.ledger.reserve({ id: "old-price", userId: f.user.id, source: "llm", credits: 1, sources: [source("wallet", "wallet")], price: { version: "2026-10-24", rate: 100 }, leaseMs: HOUR });
    f.ledger.release(f.user.id, "old-price");
    f.ledger.reserve({ id: "new-price", userId: f.user.id, source: "llm", credits: 1, sources: [source("wallet", "wallet")], price: { version: "2026-10-25", rate: 200 }, leaseMs: HOUR });
    const prices = (f.store.db.prepare("SELECT id,price FROM commercial_calls ORDER BY id").all() as { id: string; price: string }[])
      .map(({ id, price }) => ({ id, price }));
    assert.deepEqual(prices, [
      { id: "new-price", price: '{"version":"2026-10-25","rate":200}' },
      { id: "old-price", price: '{"version":"2026-10-24","rate":100}' },
    ]);
  } finally { f.close(); }
});

test("bucket windows are active at their start and inactive exactly at their end", () => {
  const f = fixture();
  try {
    const start = f.now + 1_000;
    const end = start + 1_000;
    f.bucket("window", 1, "free_day", start, end);
    assert.throws(() => reserve(f.ledger, f.user.id, "before-window", 1, [source("free", "window")]), { code: "CREDIT_LIMIT" });
    f.now = start;
    reserve(f.ledger, f.user.id, "at-start", 1, [source("free", "window")]);
    f.ledger.release(f.user.id, "at-start");
    f.now = end;
    assert.throws(() => reserve(f.ledger, f.user.id, "at-end", 1, [source("free", "window")]), { code: "CREDIT_LIMIT" });
  } finally { f.close(); }
});

test("expiry releases exactly at its boundary and a late result cannot spend it", () => {
  const f = fixture();
  try {
    f.bucket("wallet", 2);
    f.ledger.reserve({ id: "expires", userId: f.user.id, source: "llm", credits: 2, sources: [source("wallet", "wallet")], price: { version: "old" }, leaseMs: 10 });
    f.now += 9;
    assert.equal(f.ledger.releaseExpired(), 0);
    f.now += 1;
    assert.equal(f.ledger.releaseExpired(), 1);
    assert.equal(f.ledger.balance("wallet"), 2);
    assert.equal(f.ledger.settle(f.user.id, "expires", 2_000, 1_000), null);
    assert.equal(f.ledger.releaseExpired(), 0);
  } finally { f.close(); }
});

test("late settlement after deleting the account neither charges nor recreates rows", () => {
  const f = fixture();
  try {
    f.bucket("wallet", 2);
    reserve(f.ledger, f.user.id, "deleted", 2, [source("wallet", "wallet")]);
    f.store.db.prepare("DELETE FROM users WHERE id=?").run(f.user.id);
    assert.equal(f.ledger.settle(f.user.id, "deleted", 2_000, 1_000), null);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) count FROM commercial_buckets").get()!.count, 0);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) count FROM commercial_calls").get()!.count, 0);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) count FROM commercial_entries").get()!.count, 0);
  } finally { f.close(); }
});
