import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMERCIAL_CATALOG_SETTING,
  CommercialCatalog,
  PUBLISHED_COMMERCIAL_GOODS,
} from "../server/src/modules/commercial/catalog.js";
import { CommercialOrders } from "../server/src/modules/commercial/orders.js";
import { PaymentReconciliation } from "../server/src/modules/commercial/reconciliation.js";
import type { QueryPaymentInput, QueryPaymentResult } from "../server/src/modules/commercial/wechat-api.js";
import { SqliteStore } from "../server/src/shared/store.js";

function setup() {
  let now = Date.parse("2026-12-25T00:00:00.000Z");
  const store = new SqliteStore(":memory:");
  const catalog = new CommercialCatalog(store);
  const orders = new CommercialOrders(store, catalog, () => new Date(now));
  const user = store.upsertUser("wx-reconciliation", "查单用户", "wechat");
  store.saveSetting(COMMERCIAL_CATALOG_SETTING, {
    version: "catalog-v1",
    approved: true,
    goods: PUBLISHED_COMMERCIAL_GOODS.map(good => ({
      id: good.id,
      enabled: true,
      android: { credits: good.kind === "plan" ? 70 : 10, ...(good.kind === "plan" ? { weeklyCredits: 7 } : {}) },
      ios: { credits: good.kind === "plan" ? 80 : 20, ...(good.kind === "plan" ? { weeklyCredits: 8 } : {}) },
    })),
  });
  const order = orders.create(user.id, "points_10", "reconcile-one", { ageBand: "adult" });
  const target: QueryPaymentInput = {
    openid: user.openid,
    orderId: order.id,
    env: 0,
    productId: order.goodId,
    amountCents: order.amountCents,
  };
  const receipt = {
    orderId: order.id,
    wxOrderId: "wx-reconcile-1",
    openid: user.openid,
    productId: order.goodId,
    amountCents: order.amountCents,
    platform: "android" as const,
    env: 0 as const,
    paidAtMs: now,
  };
  return {
    store, orders, user, target, receipt,
    clock: () => new Date(now),
    advance: (ms: number) => { now += ms; },
  };
}

test("lost notification is compensated once; concurrent and repeated queries do not double grant", async (t) => {
  const f = setup(); t.after(() => f.store.close());
  let calls = 0;
  let resolve!: (result: QueryPaymentResult) => void;
  const response = new Promise<QueryPaymentResult>(done => { resolve = done; });
  const adapter = { queryVerifiedPayment: async (_input: QueryPaymentInput) => { calls++; return response; } };
  const reconciliation = new PaymentReconciliation(f.orders, adapter, { clock: f.clock, minIntervalMs: 300_000 });
  const first = reconciliation.reconcile(f.target);
  const duplicate = reconciliation.reconcile(f.target);
  assert.equal(first, duplicate);
  resolve({ state: "paid", status: 2, receipt: f.receipt });
  assert.equal((await first).state, "delivered");
  assert.equal(calls, 1);
  assert.equal((await reconciliation.reconcile(f.target)).state, "throttled");
  f.advance(300_000);
  assert.equal((await reconciliation.reconcile(f.target)).state, "delivered");
  assert.equal(calls, 2);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_order_grants").get()!.n, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_entries WHERE kind='grant'").get()!.n, 1);
});

test("pending query followed by notification and later paid query is safe out of order", async (t) => {
  const f = setup(); t.after(() => f.store.close());
  let answer: QueryPaymentResult = { state: "pending", status: 1, orderType: 0 };
  let notifications = 0;
  const reconciliation = new PaymentReconciliation(f.orders, {
    queryVerifiedPayment: async () => answer,
  }, { clock: f.clock, minIntervalMs: 10, onDelivered: () => { notifications++; } });
  assert.deepEqual(await reconciliation.reconcile(f.target), { state: "pending", status: 1, orderType: 0 });
  assert.equal(f.orders.receiveVerifiedPayment(f.receipt).status, "delivered");
  answer = { state: "paid", status: 4, receipt: f.receipt };
  f.advance(10);
  assert.equal((await reconciliation.reconcile(f.target)).state, "delivered");
  assert.equal(notifications, 0, "status 4 is already delivered and must not notify again");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_order_grants").get()!.n, 1);
});

test("only query_order statuses 2 and 3 request a delivery notification", async (t) => {
  const f = setup(); t.after(() => f.store.close());
  let status: 2 | 3 | 4 = 2;
  const notified: number[] = [];
  const reconciliation = new PaymentReconciliation(f.orders, {
    queryVerifiedPayment: async () => ({ state: "paid", status, receipt: f.receipt }),
  }, {
    clock: f.clock,
    minIntervalMs: 0,
    onDelivered: (_target, result) => { notified.push(result.status); },
  });
  for (status of [2, 3, 4]) await reconciliation.reconcile(f.target);
  assert.deepEqual(notified, [2, 3]);
});

test("an erased account's late payment stays pending locally and never notifies goods delivery", async (t) => {
  const f = setup(); t.after(() => f.store.close());
  f.store.db.prepare("UPDATE commercial_orders SET account_erased_at=? WHERE id=?")
    .run(f.clock().getTime(), f.target.orderId);
  let notifications = 0;
  const reconciliation = new PaymentReconciliation(f.orders, {
    queryVerifiedPayment: async () => ({ state: "paid", status: 2, receipt: f.receipt }),
  }, {
    clock: f.clock,
    minIntervalMs: 0,
    onDelivered: () => { notifications++; },
  });
  assert.deepEqual(await reconciliation.reconcile(f.target), { state: "pending", status: 2, orderType: 0 });
  assert.equal(notifications, 0);
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(f.target.orderId)!.status, "paid");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_order_grants WHERE order_id=?").get(f.target.orderId)!.n, 0);
});

test("same order with conflicting concurrent parameters is rejected", async (t) => {
  const f = setup(); t.after(() => f.store.close());
  let finish!: (result: QueryPaymentResult) => void;
  const waiting = new Promise<QueryPaymentResult>(resolve => { finish = resolve; });
  const reconciliation = new PaymentReconciliation(f.orders, {
    queryVerifiedPayment: async () => waiting,
  }, { clock: f.clock, minIntervalMs: 0 });
  const first = reconciliation.reconcile(f.target);
  await assert.rejects(reconciliation.reconcile({ ...f.target, amountCents: f.target.amountCents + 1 }), /参数冲突/);
  finish({ state: "pending", status: 1, orderType: 0 });
  await first;
  await assert.rejects(reconciliation.pollPending([f.target, f.target]), /重复/);
});

test("query_order status 6 closes only the still-unpaid local order", async (t) => {
  const f = setup(); t.after(() => f.store.close());
  const reconciliation = new PaymentReconciliation(f.orders, {
    queryVerifiedPayment: async () => ({ state: "pending", status: 6, orderType: 0 }),
  }, { clock: f.clock, minIntervalMs: 0 });
  const result = await reconciliation.reconcile(f.target);
  assert.equal(result.state, "closed");
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(f.target.orderId)!.status, "closed");
  assert.equal(f.store.audits({ action: "commercial.order.closed" }).length, 1);

  // A late close result must never overwrite a payment that won the race.
  const paid = setup(); t.after(() => paid.store.close());
  paid.orders.receiveVerifiedPayment(paid.receipt);
  const staleClose = new PaymentReconciliation(paid.orders, {
    queryVerifiedPayment: async () => ({ state: "pending", status: 6, orderType: 0 }),
  }, { clock: paid.clock, minIntervalMs: 0 });
  assert.equal((await staleClose.reconcile(paid.target)).state, "pending");
  assert.equal(paid.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(paid.target.orderId)!.status, "delivered");
});
