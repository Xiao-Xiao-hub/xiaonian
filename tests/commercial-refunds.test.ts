import assert from "node:assert/strict";
import test from "node:test";
import { COMMERCIAL_CATALOG_SETTING, CommercialCatalog, PUBLISHED_COMMERCIAL_GOODS } from "../server/src/modules/commercial/catalog.js";
import { CommercialOrders } from "../server/src/modules/commercial/orders.js";
import { CommercialRefunds, type RefundQueryResult, type RefundSubmitResult } from "../server/src/modules/commercial/refunds.js";
import { AppError } from "../server/src/shared/domain.js";
import { CommercialLedger } from "../server/src/shared/commercial-ledger.js";
import { SqliteStore } from "../server/src/shared/store.js";

const DAY = 24 * 60 * 60 * 1000;

function fixture(kind: "points" | "plan" = "points", platform: "android" | "ios" = "android") {
  let now = Date.parse("2026-10-24T08:00:00.000Z");
  const clock = () => new Date(now);
  const store = new SqliteStore(":memory:", clock);
  store.saveSetting(COMMERCIAL_CATALOG_SETTING, {
    version: "refund-v1", approved: true,
    goods: PUBLISHED_COMMERCIAL_GOODS.map(good => ({
      id: good.id, enabled: true,
      android: { credits: good.kind === "plan" ? 400 : 100, ...(good.kind === "plan" ? { weeklyCredits: 100 } : {}) },
      ios: { credits: good.kind === "plan" ? 320 : 80, ...(good.kind === "plan" ? { weeklyCredits: 80 } : {}) },
    })),
  });
  const catalog = new CommercialCatalog(store);
  const orders = new CommercialOrders(store, catalog, clock);
  const user = store.upsertUser(`wx-refund-${kind}-${platform}`, "退款用户", "wechat");
  const goodId = kind === "plan" ? "plan_entry_30d" : "points_10";
  const order = orders.create(user.id, goodId, `refund-${kind}-${platform}`, { ageBand: "adult" });
  const receipt = {
    orderId: order.id, wxOrderId: `wx-${order.id}`, openid: user.openid,
    productId: order.goodId, amountCents: order.amountCents, platform, env: 0 as const, paidAtMs: now,
  };
  orders.receiveVerifiedPayment(receipt);
  let submit: RefundSubmitResult = { state: "accepted" };
  let query: RefundQueryResult = { state: "pending" };
  let submitCalls = 0, queryCalls = 0;
  const refundAdapter = { refundOrder: async () => { submitCalls++; return submit; } };
  const queryAdapter = { queryRefund: async () => { queryCalls++; return query; } };
  const refunds = new CommercialRefunds(store, refundAdapter, queryAdapter, clock);
  return {
    store, clock, orders, order, receipt, user, refunds,
    setNow: (value: number) => { now = value; },
    advance: (value: number) => { now += value; },
    setSubmit: (value: RefundSubmitResult) => { submit = value; },
    setQuery: (value: RefundQueryResult) => { query = value; },
    submitCalls: () => submitCalls,
    queryCalls: () => queryCalls,
  };
}

const appError = (code: string) => (error: unknown) => {
  assert.ok(error instanceof AppError);
  assert.equal(error.code, code);
  return true;
};

test("accepted full plan refund freezes every historical entitlement and confirms idempotently", async t => {
  const f = fixture("plan"); t.after(() => f.store.close());
  const changed = f.store.setting<Record<string, unknown>>(COMMERCIAL_CATALOG_SETTING)!;
  f.store.saveSetting(COMMERCIAL_CATALOG_SETTING, { ...changed, approved: false });
  const requested = await f.refunds.request({
    orderId: f.order.id, actor: "admin:owner", reason: "用户在七日内申请且未使用", reasonCode: 3,
  });
  assert.equal(requested.status, "pending");
  assert.equal(requested.submissionStatus, "accepted");
  assert.equal(requested.amountCents, 1000, "historical order price is retained");
  assert.equal(f.submitCalls(), 1);
  const buckets = f.store.db.prepare(
    "SELECT b.id,COALESCE(SUM(e.delta),0) balance FROM commercial_order_grants g JOIN commercial_buckets b ON b.id=g.bucket_id JOIN commercial_entries e ON e.bucket_id=b.id WHERE g.order_id=? GROUP BY b.id ORDER BY b.id",
  ).all(f.order.id) as Array<{ id: string; balance: number }>;
  assert.equal(buckets.length, 6);
  assert.equal(buckets.every(bucket => bucket.balance === 0), true);
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(f.order.id)!.status, "refunding");
  assert.equal(f.orders.receiveVerifiedPayment(f.receipt).status, "refunding");
  f.setQuery({ state: "refunded" });
  const [completed] = await f.refunds.syncPending();
  assert.equal(completed!.status, "refunded");
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(f.order.id)!.status, "refunded");
  const entries = f.store.db.prepare("SELECT COUNT(*) n FROM commercial_entries WHERE event_key LIKE ?").get(`%${requested.id}%`)!.n;
  assert.equal(entries, 18, "six holds are converted by release plus final refund entries");
  assert.equal((await f.refunds.sync(requested.id)).status, "refunded");
  assert.equal(f.queryCalls(), 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_entries WHERE event_key LIKE ?").get(`%${requested.id}%`)!.n, entries);
  assert.equal(f.orders.receiveVerifiedPayment(f.receipt).status, "refunded");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_entries WHERE event_key LIKE ?").get(`%${requested.id}%`)!.n, entries);
  assert.throws(() => f.orders.receiveVerifiedPayment({ ...f.receipt, amountCents: f.receipt.amountCents + 1 }), appError("PAYMENT_MISMATCH"));
  const audit = f.store.audits({ action: "commercial.refund." });
  assert.equal(audit.some(item => JSON.stringify(item.details).includes(f.user.openid)), false);
  assert.equal(audit.some(item => JSON.stringify(item.details).includes(String(f.receipt.wxOrderId))), false);
  assert.equal(audit.some(item => item.action === "commercial.refund.requested" && item.actor === "admin:owner"), true);
});

test("explicit platform rejection releases the hold once and restores delivered state", async t => {
  const f = fixture(); t.after(() => f.store.close());
  f.setSubmit({ state: "failed", code: -1 });
  const refund = await f.refunds.request({ orderId: f.order.id, actor: "admin:a", reason: "人工退款", reasonCode: 5 });
  assert.equal(refund.status, "failed");
  assert.equal(refund.failureCode, "-1");
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(f.order.id)!.status, "delivered");
  const bucket = f.store.db.prepare("SELECT bucket_id id FROM commercial_order_grants WHERE order_id=?").get(f.order.id)!.id as string;
  assert.equal(new CommercialLedger(f.store, f.clock).balance(bucket), 100);
  assert.equal(f.refunds.applyPlatformResult(refund.id, { state: "failed", code: -1 }, refund.attempt).status, "failed");
  assert.equal(new CommercialLedger(f.store, f.clock).balance(bucket), 100);
});

test("an explicitly failed refund can retry with the same refund id without duplicate holds", async t => {
  const f = fixture(); t.after(() => f.store.close());
  f.setSubmit({ state: "failed", code: -1 });
  const failed = await f.refunds.request({ orderId: f.order.id, actor: "admin:first", reason: "第一次失败", reasonCode: 5 });
  assert.equal(failed.status, "failed");
  const originalId = failed.id;

  f.setSubmit({ state: "accepted" });
  const retried = await f.refunds.request({ orderId: f.order.id, actor: "admin:retry", reason: "确认失败后重试", reasonCode: 5 });
  assert.equal(retried.id, originalId, "platform idempotency key must be reused");
  assert.equal(failed.attempt, 1);
  assert.equal(retried.attempt, 2, "the durable row, not audit retention, owns the attempt number");
  assert.equal(retried.status, "pending");
  assert.equal(retried.submissionStatus, "accepted");
  assert.equal(retried.manualReviewReason, null, "a retry starts a fresh status-7 observation window");
  assert.equal(f.store.db.prepare("SELECT status7_first_seen_at FROM commercial_refunds WHERE id=?").get(retried.id)!.status7_first_seen_at, null);
  assert.equal(f.submitCalls(), 2);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_refunds").get()!.n, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_entries WHERE event_key LIKE 'refund-hold:%'").get()!.n, 2);

  const duplicate = await f.refunds.request({ orderId: f.order.id, actor: "admin:retry", reason: "不能重复提交", reasonCode: 5 });
  assert.equal(duplicate.id, originalId);
  assert.equal(f.submitCalls(), 2, "pending/accepted retries query status instead of submitting again");
});

test("a retry seeing stale status 7 stays frozen and escalates instead of releasing rights", async t => {
  const f = fixture(); t.after(() => f.store.close());
  f.setSubmit({ state: "failed", code: -1 });
  const first = await f.refunds.request({ orderId: f.order.id, actor: "admin:first", reason: "第一次失败", reasonCode: 5 });
  f.setSubmit({ state: "accepted" });
  const retry = await f.refunds.request({ orderId: f.order.id, actor: "admin:retry", reason: "同号重试", reasonCode: 5 });
  assert.equal(first.attempt, 1);
  assert.equal(retry.attempt, 2);
  f.setQuery({ state: "failed", code: "STATUS_7" });
  const synced = await f.refunds.sync(retry.id);
  assert.equal(synced.status, "pending");
  assert.equal(synced.submissionStatus, "accepted");
  assert.equal(synced.manualReviewReason, "status7_after_retry");
  assert.equal(synced.manualReviewAt, Date.parse("2026-10-25T08:00:00.000Z"));
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(f.order.id)!.status, "refunding");
  const bucket = f.store.db.prepare("SELECT bucket_id id FROM commercial_order_grants WHERE order_id=?").get(f.order.id)!.id as string;
  assert.equal(new CommercialLedger(f.store, f.clock).balance(bucket), 0);
  const alerts = f.store.audits({ action: "commercial.payment.anomaly" });
  assert.equal(alerts.length, 1);
  assert.equal((alerts[0]!.details as { code?: string }).code, "REFUND_RETRY_STATUS_7_STALE");
  await f.refunds.sync(retry.id);
  assert.equal(f.store.audits({ action: "commercial.payment.anomaly" }).length, 1, "an unresolved alert is deduplicated");
  await assert.rejects(f.refunds.resolveUnknownAsFailed(retry.id, {
    actor: "admin:review", reason: "状态7仍未退款", expectedAttempt: retry.attempt,
  }), appError("REFUND_MANUAL_TOO_EARLY"));
  f.advance(DAY);
  const failed = await f.refunds.resolveUnknownAsFailed(retry.id, {
    actor: "admin:review", reason: "状态7持续24小时且查单仍为7", expectedAttempt: retry.attempt,
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.manualReviewReason, null);
  assert.equal(new CommercialLedger(f.store, f.clock).balance(bucket), 100);
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(f.order.id)!.status, "delivered");
});

test("manual unknown resolution rechecks WeChat after 24 hours and fails only paid not-refunded states", async t => {
  const f = fixture(); t.after(() => f.store.close());
  const refunds = new CommercialRefunds(
    f.store,
    { refundOrder: async () => { throw new Error("transport timeout"); } },
    { queryRefund: async () => ({ state: "pending", status: 3 }) },
    f.clock,
  );
  const pending = await refunds.request({ orderId: f.order.id, actor: "admin:start", reason: "提交超时", reasonCode: 5 });
  assert.equal(pending.submissionStatus, "unknown");
  assert.equal(pending.manualReviewReason, "unknown_submission");
  assert.equal(pending.manualReviewAt, Date.parse("2026-10-25T08:00:00.000Z"));
  await assert.rejects(refunds.resolveUnknownAsFailed(pending.id, {
    actor: "admin:review", reason: "查单仍是发货中且全额可退", expectedAttempt: pending.attempt,
  }), appError("REFUND_MANUAL_TOO_EARLY"));
  f.advance(DAY);
  const failed = await refunds.resolveUnknownAsFailed(pending.id, {
    actor: "admin:review", reason: "查单仍是发货中且全额可退", expectedAttempt: pending.attempt,
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureCode, "MANUALLY_CONFIRMED_NOT_REFUNDED");
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(f.order.id)!.status, "delivered");
  const bucket = f.store.db.prepare("SELECT bucket_id id FROM commercial_order_grants WHERE order_id=?").get(f.order.id)!.id as string;
  assert.equal(new CommercialLedger(f.store, f.clock).balance(bucket), 100);
  const audit = f.store.audits({ action: "commercial.refund.manual_failed" });
  assert.equal(audit.length, 1);
  assert.equal((audit[0]!.details as { platformStatus?: number }).platformStatus, 3);
});

test("manual review treats platform status 8 as a normal completed refund", async t => {
  const unknown = fixture();
  const status7 = fixture();
  t.after(() => { unknown.store.close(); status7.store.close(); });

  const unknownRefunds = new CommercialRefunds(
    unknown.store,
    { refundOrder: async () => { throw new Error("transport timeout"); } },
    { queryRefund: async () => ({ state: "refunded" }) },
    unknown.clock,
  );
  const unknownPending = await unknownRefunds.request({
    orderId: unknown.order.id, actor: "admin:start", reason: "提交结果未知", reasonCode: 5,
  });
  unknown.advance(DAY);
  assert.equal((await unknownRefunds.resolveUnknownAsFailed(unknownPending.id, {
    actor: "admin:review", reason: "查单确认已退款", expectedAttempt: unknownPending.attempt,
  })).status, "refunded");

  status7.setSubmit({ state: "failed", code: -1 });
  await status7.refunds.request({ orderId: status7.order.id, actor: "admin:first", reason: "首次失败", reasonCode: 5 });
  status7.setSubmit({ state: "accepted" });
  const retry = await status7.refunds.request({ orderId: status7.order.id, actor: "admin:retry", reason: "再次提交", reasonCode: 5 });
  status7.setQuery({ state: "failed", code: "STATUS_7" });
  await status7.refunds.sync(retry.id);
  status7.advance(DAY);
  status7.setQuery({ state: "refunded" });
  assert.equal((await status7.refunds.resolveUnknownAsFailed(retry.id, {
    actor: "admin:review", reason: "查单确认已退款", expectedAttempt: retry.attempt,
  })).status, "refunded");
});

test("manual unknown resolution rejects processing status and stale state without releasing the hold", async t => {
  const f = fixture(); t.after(() => f.store.close());
  let answer: RefundQueryResult = { state: "pending", status: 5 };
  const refunds = new CommercialRefunds(
    f.store,
    { refundOrder: async () => { throw new Error("transport timeout"); } },
    { queryRefund: async () => answer },
    f.clock,
  );
  const pending = await refunds.request({ orderId: f.order.id, actor: "admin:start", reason: "提交超时", reasonCode: 5 });
  f.advance(DAY);
  await assert.rejects(refunds.resolveUnknownAsFailed(pending.id, {
    actor: "admin:review", reason: "平台仍在退款中", expectedAttempt: pending.attempt,
  }), appError("REFUND_PLATFORM_NOT_CLEAR"));
  answer = { state: "pending", status: 2 };
  await assert.rejects(refunds.resolveUnknownAsFailed(pending.id, {
    actor: "admin:review", reason: "页面数据过期", expectedAttempt: pending.attempt + 1,
  }), appError("REFUND_ATTEMPT_CHANGED"));
  assert.equal(refunds.detail(pending.id).status, "pending");
  const bucket = f.store.db.prepare("SELECT bucket_id id FROM commercial_order_grants WHERE order_id=?").get(f.order.id)!.id as string;
  assert.equal(new CommercialLedger(f.store, f.clock).balance(bucket), 0);
});

test("unknown submission keeps rights frozen until sync confirms the platform outcome", async t => {
  const f = fixture(); t.after(() => f.store.close());
  const refunds = new CommercialRefunds(
    f.store,
    { refundOrder: async () => { throw new Error("synthetic timeout with secret=do-not-log"); } },
    { queryRefund: async () => ({ state: "failed", code: "TIMEOUT_NOT_FOUND" }) },
    f.clock,
  );
  const pending = await refunds.request({ orderId: f.order.id, actor: "admin:b", reason: "网络未知", reasonCode: 5 });
  assert.equal(pending.status, "pending");
  assert.equal(pending.submissionStatus, "unknown");
  const bucket = f.store.db.prepare("SELECT bucket_id id FROM commercial_order_grants WHERE order_id=?").get(f.order.id)!.id as string;
  assert.equal(new CommercialLedger(f.store, f.clock).balance(bucket), 0);
  const [failed] = await refunds.syncPending();
  assert.equal(failed!.status, "failed");
  assert.equal(new CommercialLedger(f.store, f.clock).balance(bucket), 100);
  assert.equal(JSON.stringify(f.store.audits({ action: "commercial.refund." })).includes("do-not-log"), false);
});

test("refund query failures create one deduplicated operator-visible payment anomaly", async t => {
  const f = fixture(); t.after(() => f.store.close());
  const refunds = new CommercialRefunds(
    f.store,
    { refundOrder: async () => { throw new Error("submission timeout"); } },
    { queryRefund: async () => { throw Object.assign(new Error("temporary outage"), { code: 503 }); } },
    f.clock,
  );
  const pending = await refunds.request({ orderId: f.order.id, actor: "admin", reason: "测试查单异常", reasonCode: 5 });
  await assert.rejects(refunds.sync(pending.id), /temporary outage/);
  await assert.rejects(refunds.sync(pending.id), /temporary outage/);
  f.advance(DAY);
  await assert.rejects(refunds.resolveUnknownAsFailed(pending.id, {
    actor: "admin:review", reason: "人工核实时查单失败", expectedAttempt: pending.attempt,
  }), /temporary outage/);
  const anomalies = f.store.audits({ action: "commercial.payment.anomaly" });
  assert.equal(anomalies.length, 1);
  assert.deepEqual(anomalies[0]!.details, {
    source: "refund_sync", phase: "refund_query", code: "WECHAT_API_503",
    refundId: pending.id, attempt: 1,
  });
});

test("an erased account's paid undelivered order can refund with its retained buyer openid", async t => {
  const f = fixture(); t.after(() => f.store.close());
  const bucket = f.store.db.prepare(
    "SELECT bucket_id id FROM commercial_order_grants WHERE order_id=?",
  ).get(f.order.id)!.id as string;
  f.store.db.prepare("DELETE FROM commercial_buckets WHERE id=?").run(bucket);
  f.store.db.prepare(
    "UPDATE commercial_orders SET status='paid',account_erased_at=?,delivered_at=NULL WHERE id=?",
  ).run(f.clock().getTime(), f.order.id);
  f.store.db.prepare("UPDATE users SET openid=?,erased_at=? WHERE id=?")
    .run(`erased:${f.user.id}`, f.clock().getTime(), f.user.id);
  let submittedOpenid = "";
  let query: RefundQueryResult = { state: "pending" };
  const refunds = new CommercialRefunds(
    f.store,
    { refundOrder: async input => { submittedOpenid = input.openid; return { state: "accepted" }; } },
    { queryRefund: async () => query },
    f.clock,
  );
  const pending = await refunds.request({
    orderId: f.order.id, actor: "admin", reason: "注销后迟到付款，未发权益", reasonCode: 5,
  });
  assert.equal(submittedOpenid, f.receipt.openid);
  assert.deepEqual(JSON.parse(f.store.db.prepare("SELECT holdings FROM commercial_refunds WHERE id=?").get(pending.id)!.holdings), []);
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(f.order.id)!.status, "refunding");
  query = { state: "refunded" };
  assert.equal((await refunds.sync(pending.id)).status, "refunded");
});

test("iOS and the exact seven-day boundary are never submitted", async t => {
  const ios = fixture("points", "ios");
  const expired = fixture();
  t.after(() => { ios.store.close(); expired.store.close(); });
  await assert.rejects(ios.refunds.request({ orderId: ios.order.id, actor: "admin", reason: "iOS", reasonCode: 5 }), appError("REFUND_IOS_UNSUPPORTED"));
  expired.advance(7 * DAY);
  await assert.rejects(expired.refunds.request({ orderId: expired.order.id, actor: "admin", reason: "到期", reasonCode: 5 }), appError("REFUND_WINDOW_EXPIRED"));
  assert.equal(ios.submitCalls() + expired.submitCalls(), 0);
});

test("used rights and an unsettled call hold both reject automatic refund", async t => {
  const used = fixture();
  const held = fixture();
  t.after(() => { used.store.close(); held.store.close(); });
  const usedBucket = used.store.db.prepare("SELECT bucket_id id FROM commercial_order_grants WHERE order_id=?").get(used.order.id)!.id as string;
  used.store.db.prepare(
    "INSERT INTO commercial_entries(bucket_id,call_id,event_key,kind,delta,created_at) VALUES(?,NULL,'used-credit','refund',-1,?)",
  ).run(usedBucket, used.clock().toISOString());
  await assert.rejects(used.refunds.request({ orderId: used.order.id, actor: "admin", reason: "已用", reasonCode: 5 }), appError("REFUND_ALREADY_USED"));

  const heldBucket = held.store.db.prepare("SELECT bucket_id id FROM commercial_order_grants WHERE order_id=?").get(held.order.id)!.id as string;
  new CommercialLedger(held.store, held.clock).reserve({
    id: "active-call", userId: held.user.id, source: "test", credits: 1,
    sources: [{ name: "wallet", buckets: [heldBucket] }], price: { version: "historical" }, leaseMs: 60_000,
  });
  await assert.rejects(held.refunds.request({ orderId: held.order.id, actor: "admin", reason: "调用中", reasonCode: 5 }), appError("REFUND_ALREADY_USED"));
  assert.equal(used.submitCalls() + held.submitCalls(), 0);
});

test("concurrent duplicate manual requests create one hold and one platform request", async t => {
  const f = fixture(); t.after(() => f.store.close());
  let release!: (value: RefundSubmitResult) => void;
  let calls = 0;
  const wait = new Promise<RefundSubmitResult>(resolve => { release = resolve; });
  const refunds = new CommercialRefunds(f.store, { refundOrder: async () => { calls++; return wait; } }, { queryRefund: async () => ({ state: "pending" }) }, f.clock);
  const input = { orderId: f.order.id, actor: "admin", reason: "并发", reasonCode: 5 as const };
  const first = refunds.request(input);
  const duplicate = refunds.request(input);
  assert.equal((await duplicate).status, "pending");
  release({ state: "accepted" });
  assert.equal((await first).submissionStatus, "accepted");
  assert.equal(calls, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_refunds").get()!.n, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_entries WHERE event_key LIKE 'refund-hold:%'").get()!.n, 1);
});

test("a hold write failure rolls back refund state, order state, and audit before network", async t => {
  const f = fixture(); t.after(() => f.store.close());
  f.store.db.exec("CREATE TRIGGER fail_refund_hold BEFORE INSERT ON commercial_entries WHEN NEW.event_key LIKE 'refund-hold:%' BEGIN SELECT RAISE(FAIL,'synthetic hold failure'); END");
  await assert.rejects(f.refunds.request({ orderId: f.order.id, actor: "admin", reason: "回滚", reasonCode: 5 }), /synthetic hold failure/);
  assert.equal(f.submitCalls(), 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_refunds").get()!.n, 0);
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(f.order.id)!.status, "delivered");
  assert.equal(f.store.audits({ action: "commercial.refund." }).length, 0);
});

test("actor, reason and reason code are mandatory before any state change", async t => {
  const f = fixture(); t.after(() => f.store.close());
  await assert.rejects(f.refunds.request({ orderId: f.order.id, actor: "", reason: "x", reasonCode: 5 }), appError("REFUND_INVALID"));
  await assert.rejects(f.refunds.request({ orderId: f.order.id, actor: "admin", reason: "", reasonCode: 5 }), appError("REFUND_INVALID"));
  await assert.rejects(f.refunds.request({ orderId: f.order.id, actor: "admin", reason: "x", reasonCode: 9 as never }), appError("REFUND_INVALID"));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_refunds").get()!.n, 0);
});
