import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { CommercialLedger } from "../server/src/shared/commercial-ledger.js";
import { CommercialCatalog, COMMERCIAL_CATALOG_SETTING, PUBLISHED_COMMERCIAL_GOODS } from "../server/src/modules/commercial/catalog.js";
import { CommercialOrders } from "../server/src/modules/commercial/orders.js";
import { CommercialRefunds } from "../server/src/modules/commercial/refunds.js";
import { ACCOUNT_OPEN_ORDERS_MESSAGE, pruneRetainedTransactions, transactionRetentionEndsAt } from "../server/src/modules/commercial/retention.js";

const KEY = "synthetic-retention-admin-key-123456";
const HOUR = 3600_000;
async function fixture() {
  let now = Date.parse("2026-10-24T08:00:00.000Z");
  const clock = () => new Date(now);
  const store = new SqliteStore(":memory:", clock);
  let openid = "wx-retention-first";
  const app = buildApp({ store, now: clock,
    env: loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_PATH: ":memory:",
      WECHAT_APP_ID: "wx-synthetic", WECHAT_APP_SECRET: "synthetic-secret", ADMIN_API_KEY: KEY }),
    fetcher: (async () => Response.json({ openid, session_key: Buffer.alloc(16, 3).toString("base64") })) as typeof fetch,
  });
  store.saveSetting(COMMERCIAL_CATALOG_SETTING, { version: "retention-test", approved: true,
    goods: PUBLISHED_COMMERCIAL_GOODS.map(good => ({ id: good.id, enabled: true,
      android: { credits: 100, ...(good.kind === "plan" ? { weeklyCredits: 25 } : {}) },
      ios: { credits: 80, ...(good.kind === "plan" ? { weeklyCredits: 20 } : {}) },
    })),
  });
  const orders = new CommercialOrders(store, new CommercialCatalog(store), clock);
  const login = async (id = openid) => {
    openid = id;
    const response = await app.inject({ method: "POST", url: "/v1/auth/wechat-login", payload: { code: "synthetic" } });
    assert.equal(response.statusCode, 200);
    const { token, user } = response.json().data;
    const headers = { authorization: `Bearer ${token}` };
    return { user: store.getUser(user.id)!, headers, erase: () => app.inject({ method: "DELETE", url: "/v1/me", headers, payload: { confirm: true } }) };
  };
  const purchase = (user: { id: string; openid: string }, key = "same-purchase-key", deliver = true) => {
    const order = orders.create(user.id, "points_10", key, { ageBand: "adult" });
    const receipt = { orderId: order.id, wxOrderId: `wx-${order.id}`, openid: user.openid, productId: order.goodId,
      amountCents: order.amountCents, platform: "android" as const, env: 0 as const, paidAtMs: now };
    if (deliver) orders.receiveVerifiedPayment(receipt);
    return { order, receipt, bucket: `wallet:${order.id}` };
  };
  return { app, store, orders, clock, login, purchase,
    setNow: (value: number) => { now = value; }, advance: (ms: number) => { now += ms; },
    adminGet: (url: string) => app.inject({ url, headers: { "x-admin-key": KEY } }),
  };
}

test("account erasure blocks paid/refunding/recent-created atomically with the fixed 409; exactly two hours is eligible", async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const a = await f.login();
  const { order } = f.purchase(a.user, "open", false);
  for (const status of ["paid", "refunding", "created"]) {
    f.store.db.prepare("UPDATE commercial_orders SET status=? WHERE id=?").run(status, order.id);
    const denied = await a.erase();
    assert.equal(denied.statusCode, 409);
    assert.equal(denied.json().code, "ACCOUNT_OPEN_ORDERS");
    assert.equal(denied.json().message, ACCOUNT_OPEN_ORDERS_MESSAGE);
    assert.equal(typeof denied.json().requestId, "string");
    assert.ok(f.store.getUser(a.user.id));
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM users WHERE erased_at IS NOT NULL").get()!.n, 0);
  }
  f.advance(2 * HOUR - 1);
  assert.equal((await a.erase()).statusCode, 409);
  f.advance(1);
  assert.equal((await a.erase()).statusCode, 200);
  assert.equal(f.store.getUser(a.user.id), undefined);
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(order.id)!.status, "closed");
});

test("erasure retains paid ledger including settlements, releases holds, removes private data, and isolates re-registration", async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const a = await f.login();
  const paid = f.purchase(a.user);
  const ledger = new CommercialLedger(f.store, f.clock);
  for (const [id, settle] of [["consumed", true], ["inflight", false]] as const) {
    ledger.reserve({ id, userId: a.user.id, source: "test", credits: 10, leaseMs: HOUR,
      sources: [{ name: "wallet", buckets: [paid.bucket] }], price: {} });
    if (settle) ledger.settle(a.user.id, id, 5, 1);
  }
  ledger.ensureBucket({ id: "free-owned", userId: a.user.id, kind: "free_day", credits: 30,
    startsAt: f.clock().getTime(), endsAt: f.clock().getTime() + 24 * HOUR });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE type='table' AND name='orders'").get()!.n, 0,
    "historical migrations already removed the original demo orders table");
  assert.equal((await a.erase()).statusCode, 200);
  const retained = f.store.db.prepare("SELECT * FROM commercial_orders WHERE id=?").get(paid.order.id)!;
  assert.notEqual(retained.user_id, a.user.id);
  assert.equal(retained.buyer_openid, a.user.openid);
  assert.equal(retained.account_erased_at, f.clock().getTime());
  assert.equal(f.store.getUser(String(retained.user_id)), undefined, "tombstones cannot authenticate");
  assert.equal(f.store.db.prepare("SELECT data FROM users WHERE id=?").get(retained.user_id)!.data, "{}");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_calls WHERE user_id=?").get(a.user.id)!.n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_buckets WHERE id='free-owned'").get()!.n, 0);
  const entries = f.store.db.prepare("SELECT kind,delta,call_id FROM commercial_entries WHERE bucket_id=?").all(paid.bucket);
  assert.ok(entries.some(row => row.kind === "settle"));
  assert.ok(entries.some(row => row.kind === "release"));
  assert.ok(entries.every(row => row.call_id === null));
  assert.equal(entries.reduce((sum, row) => sum + Number(row.delta), 0), 95);
  assert.equal(JSON.parse(String(f.store.db.prepare("SELECT details FROM audit WHERE action='account.erase'").get()!.details)).retainedOrders, 1);
  assert.equal((await f.app.inject({ url: "/v1/me/export", headers: a.headers })).statusCode, 401);
  const again = await f.login(a.user.openid);
  assert.notEqual(again.user.id, a.user.id);
  assert.deepEqual(f.orders.list(again.user.id), []);
  const exported = await f.app.inject({ url: "/v1/me/export", headers: again.headers });
  assert.equal(exported.statusCode, 200);
  assert.deepEqual(exported.json().commercial.orders, []);
  assert.equal(exported.body.includes(paid.order.id), false);
  const b = await f.login("wx-retention-second");
  const second = f.purchase(b.user);
  assert.equal((await b.erase()).statusCode, 200, "same idempotency keys remain isolated after two erasures");
  const secondRow = f.store.db.prepare("SELECT user_id FROM commercial_orders WHERE id=?").get(second.order.id)!;
  assert.notEqual(secondRow.user_id, retained.user_id);
  const admin = await f.adminGet("/v1/admin/commercial/orders");
  assert.equal(admin.statusCode, 200);
  assert.ok(admin.json().data.every((row: { accountErased: boolean }) => row.accountErased));
  assert.equal(admin.body.includes(a.user.openid), false);
  const activeUsers = (await f.adminGet("/v1/admin/users")).json().data;
  assert.equal(activeUsers.total, 1);
  assert.equal(activeUsers.items[0].id, again.user.id);
  const overview = (await f.adminGet("/v1/admin/commercial/overview")).json().data;
  assert.equal(overview.ledger.activeConstraintCredits, 0, "retained balances are not spendable allowance");
  assert.deepEqual(f.store.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("failed erasure rolls back tombstones, ledger release and session deletion together", async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const a = await f.login(); const paid = f.purchase(a.user);
  const ledger = new CommercialLedger(f.store, f.clock);
  ledger.reserve({ id: "rollback-held", userId: a.user.id, source: "test", credits: 10, leaseMs: HOUR,
    sources: [{ name: "wallet", buckets: [paid.bucket] }], price: {} });
  f.store.db.exec("CREATE TRIGGER reject_erasure BEFORE DELETE ON users WHEN OLD.erased_at IS NULL BEGIN SELECT RAISE(ABORT,'synthetic erasure failure'); END");
  assert.equal((await a.erase()).statusCode, 500);
  assert.ok(f.store.getUser(a.user.id));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM users WHERE erased_at IS NOT NULL").get()!.n, 0);
  assert.equal(f.store.db.prepare("SELECT user_id FROM commercial_orders WHERE id=?").get(paid.order.id)!.user_id, a.user.id);
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_calls WHERE id='rollback-held'").get()!.status, "held");
  assert.equal(f.store.db.prepare("SELECT SUM(delta) n FROM commercial_entries WHERE bucket_id=?").get(paid.bucket)!.n, 90);
  assert.equal((await f.app.inject({ url: "/v1/me/export", headers: a.headers })).statusCode, 200);
  f.store.db.exec("DROP TRIGGER reject_erasure");
  assert.equal((await a.erase()).statusCode, 200);
});

test("a delayed payment for an erased expired draft records an anomaly without entitlements and remains refundable by stored buyer", async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const a = await f.login(); const paid = f.purchase(a.user, "late", false);
  f.advance(2 * HOUR);
  assert.equal((await a.erase()).statusCode, 200);
  for (let n = 0; n < 2; n++) assert.equal(f.orders.receiveVerifiedPayment(paid.receipt).status, "paid");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_order_grants WHERE order_id=?").get(paid.order.id)!.n, 0);
  const anomalies = (await f.adminGet("/v1/admin/commercial/anomalies")).json().data;
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].code, "ORDER_ACCOUNT_ERASED");
  assert.equal(anomalies[0].phase, "deliver");
  let buyer: string | undefined;
  const refunds = new CommercialRefunds(f.store,
    { refundOrder: async input => { buyer = input.openid; return { state: "accepted" }; } },
    { queryRefund: async () => ({ state: "refunded" }) }, f.clock);
  const refund = await refunds.request({ orderId: paid.order.id, actor: "admin:owner", reason: "注销后到账核实退款", reasonCode: 3 });
  assert.equal(buyer, a.user.openid);
  assert.equal((await refunds.sync(refund.id)).status, "refunded");
  assert.deepEqual(f.store.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("an erased delivered order refunds without looking up the deleted user's openid", async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const a = await f.login(); const paid = f.purchase(a.user);
  assert.equal((await a.erase()).statusCode, 200);
  let buyer: string | undefined;
  const refunds = new CommercialRefunds(f.store,
    { refundOrder: async input => { buyer = input.openid; return { state: "accepted" }; } },
    { queryRefund: async input => { assert.equal(input.openid, a.user.openid); return { state: "refunded" }; } }, f.clock);
  const refund = await refunds.request({ orderId: paid.order.id, actor: "admin:owner", reason: "七日未使用", reasonCode: 3 });
  assert.equal(buyer, a.user.openid);
  f.advance(HOUR);
  const completed = await refunds.sync(refund.id);
  assert.equal(completed.status, "refunded");
  const until = transactionRetentionEndsAt(completed.completedAtMs!);
  f.setNow(until - 1);
  assert.equal(pruneRetainedTransactions(f.store), 0);
  f.setNow(until);
  assert.equal(pruneRetainedTransactions(f.store), 1);
  assert.equal(pruneRetainedTransactions(f.store), 0);
  for (const table of ["commercial_orders", "commercial_refunds", "commercial_order_grants", "commercial_buckets", "commercial_entries"])
    assert.equal(f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM users WHERE erased_at IS NOT NULL").get()!.n, 0);
  assert.deepEqual(f.store.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("three-year cleanup uses latest completion and never removes active or unfinished transactions; leap day is clamped in Beijing", async t => {
  const f = await fixture(); t.after(() => f.app.close());
  assert.equal(transactionRetentionEndsAt(Date.parse("2024-02-28T16:30:00Z")), Date.parse("2027-02-27T16:30:00Z"));
  const a = await f.login(); const paid = f.purchase(a.user);
  f.advance(HOUR); const late = f.purchase(a.user, "unfinished", false);
  f.advance(2 * HOUR); assert.equal((await a.erase()).statusCode, 200);
  f.orders.receiveVerifiedPayment(late.receipt);
  const b = await f.login("active-owner"); const active = f.purchase(b.user);
  f.setNow(transactionRetentionEndsAt(paid.receipt.paidAtMs));
  assert.equal(pruneRetainedTransactions(f.store), 1);
  assert.ok(f.store.db.prepare("SELECT id FROM commercial_orders WHERE id=?").get(late.order.id));
  assert.ok(f.store.db.prepare("SELECT id FROM commercial_orders WHERE id=?").get(active.order.id));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM users WHERE erased_at IS NOT NULL").get()!.n, 1);
  assert.deepEqual(f.store.db.prepare("PRAGMA foreign_key_check").all(), []);
});
