import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { AppError } from "../server/src/shared/domain.js";
import { CommercialBilling } from "../server/src/shared/commercial-billing.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { COMMERCIAL_CATALOG_SETTING } from "../server/src/modules/commercial/catalog.js";
import { approvedCommercialCatalog } from "../server/src/modules/commercial/policy.js";
import { CommercialRefunds } from "../server/src/modules/commercial/refunds.js";
import { registerCommercialRoutes } from "../server/src/modules/commercial/routes.js";
import { callbackSignature, createDirectGoodsPayment } from "../server/src/modules/commercial/virtual-payment.js";
import { WechatVirtualPaymentApi } from "../server/src/modules/commercial/wechat-api.js";

const DAY = 24 * 60 * 60 * 1000;
const token = "callback-token";
const Fastify = createRequire(new URL("../server/package.json", import.meta.url))("fastify") as () => any;

function fixture() {
  let now = Date.parse("2026-10-24T08:00:00.000Z");
  const clock = () => new Date(now);
  const store = new SqliteStore(":memory:", clock);
  const owner = store.upsertUser("wx-plan-route", "购买者", "wechat");
  store.saveSetting(COMMERCIAL_CATALOG_SETTING, approvedCommercialCatalog());
  store.saveSetting("commercial.enabled", true);
  const billing = new CommercialBilling(store);
  const app = Fastify();
  // "list": WeChat reports the list price as order_fee for a discounted order.
  let query: "paid" | "list" | "fail" | "paid-fee-list" = "paid";
  let queryCalls = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/xpay/notify_provide_goods") return new Response("");
    queryCalls++;
    if (query === "fail") return new Response("unavailable", { status: 503 });
    const sent = JSON.parse(String(init?.body)) as { order_id: string };
    const row = store.db.prepare("SELECT amount_cents,snapshot,created_at FROM commercial_orders WHERE id=?").get(sent.order_id) as {
      amount_cents: number; snapshot: string; created_at: number;
    };
    const list = (JSON.parse(row.snapshot) as { good: { priceCents: number } }).good.priceCents;
    return new Response(JSON.stringify({ errcode: 0, errmsg: "ok", order: {
      order_id: sent.order_id, status: 2, order_type: 0, env_type: 1,
      order_fee: query === "paid" ? row.amount_cents : list,
      paid_fee: query === "paid-fee-list" ? list : row.amount_cents,
      paid_time: Math.floor(row.created_at / 1000), wx_order_id: `wx-${sent.order_id}`,
    } }));
  }) as typeof fetch;
  const registration = registerCommercialRoutes(app, {
    auth: {
      require: () => store.getUser(owner.id)!,
      wechatPaymentSession: () => ({ user: store.getUser(owner.id)!, sessionKey: "session-key" }),
    } as never,
    store, billing, clock,
    config: {
      offerId: "offer-1", appKey: "app-key", callbackToken: token, callbackFormat: "json", callbackMode: "plaintext",
      getAccessToken: () => "access-token", fetcher, apiRoot: "https://api.test",
    },
  });
  app.setErrorHandler((error: unknown, _req: unknown, reply: any) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    return reply.code(500).send({ code: "INTERNAL_ERROR" });
  });
  const runtime = registration.runtime!;
  let seq = 0;
  const order = (productId: string, platform?: string) => app.inject({
    method: "POST", url: "/v1/commercial/orders",
    payload: { productId, idempotencyKey: `route-${++seq}`, purchase: { ageBand: "adult" }, ...(platform ? { platform } : {}) },
  });
  const paid = (created: { id: string; goodId: string; amountCents: number }) =>
    runtime.orders.receiveVerifiedPayment({
      orderId: created.id, wxOrderId: `wx-${created.id}`, openid: owner.openid, productId: created.goodId,
      amountCents: created.amountCents, platform: "android", env: 0, paidAtMs: now,
    });
  return {
    app, store, owner, runtime, order, paid,
    setQuery: (value: typeof query) => { query = value; },
    queryCalls: () => queryCalls,
    advance: (ms: number) => { now += ms; },
    anomalies: () => store.audits({ action: "commercial.payment.anomaly" }),
    close: async () => { await app.close(); store.close(); },
  };
}

test("an upgrade is signed at the list price with the difference as activitySellingPrice", () => {
  const payment = createDirectGoodsPayment({
    offerId: "offer", productId: "plan_standard_30d", goodsPrice: 3000, activitySellingPrice: 2667,
    outTradeNo: "order-12345678", attach: "order-12345678", appKey: "k", sessionKey: "s",
  });
  const data = JSON.parse(payment.signData);
  assert.deepEqual([data.goodsPrice, data.activitySellingPrice], [3000, 2667]);
  assert.ok(payment.signData.indexOf("activitySellingPrice") > payment.signData.indexOf("goodsPrice"));
  for (const bad of [3000, 3001, 0, 1.5])
    assert.throws(() => createDirectGoodsPayment({
      offerId: "offer", productId: "p", goodsPrice: 3000, activitySellingPrice: bad,
      outTradeNo: "order-12345678", attach: "a", appKey: "k", sessionKey: "s",
    }), RangeError);
});

test("query_order accepts the list price as order_fee only for an upgrade and always requires paid_fee to match", async () => {
  let order: Record<string, unknown> = {};
  const api = new WechatVirtualPaymentApi({
    getAccessToken: () => "t", getAppKey: () => "k", apiRoot: "https://wechat.test",
    fetcher: (async () => new Response(JSON.stringify({ errcode: 0, errmsg: "ok", order }))) as typeof fetch,
  });
  const base = { order_id: "order-12345678", status: 2, order_type: 0, env_type: 1, paid_time: 1_798_195_200, wx_order_id: "wx-1" };
  const input = { openid: "o", orderId: "order-12345678", env: 0 as const, productId: "plan_standard_30d", amountCents: 2667 };
  order = { ...base, order_fee: 3000, paid_fee: 2667 };
  assert.equal((await api.queryVerifiedPayment({ ...input, listPriceCents: 3000 })).state, "paid");
  await assert.rejects(api.queryVerifiedPayment(input), /金额不匹配/);
  order = { ...base, order_fee: 2667, paid_fee: 2667 };
  assert.equal((await api.queryVerifiedPayment({ ...input, listPriceCents: 3000 })).state, "paid");
  order = { ...base, order_fee: 3000, paid_fee: 3000 };
  await assert.rejects(api.queryVerifiedPayment({ ...input, listPriceCents: 3000 }), /金额不匹配/);
});

test("account returns renderable plan quotes and orders follow them, including Android-only upgrades", async t => {
  const f = fixture(); t.after(f.close);
  const quotes = async (platform: string) =>
    (await f.app.inject({ url: `/v1/commercial/account?platform=${platform}` })).json().data;
  const empty = await quotes("android");
  assert.equal(empty.planChain, null);
  assert.deepEqual(empty.planQuotes.map((item: { action: string; priceCents: number }) => [item.action, item.priceCents]),
    [["buy", 1000], ["buy", 3000], ["buy", 6000]]);

  const plus = (await f.order("plan_entry_30d", "android")).json().data.order;
  f.paid(plus);
  f.advance(20 * DAY);
  const renewed = (await f.order("plan_entry_30d", "ios")).json().data.order;
  f.paid(renewed);
  const view = await quotes("android");
  assert.deepEqual(view.planChain, {
    goodId: "plan_entry_30d", name: "晓念Plus",
    expiresAt: new Date(Date.parse("2026-10-24T08:00:00.000Z") + 60 * DAY).toISOString(), queued: 1,
  });
  const [entry, standard] = view.planQuotes;
  assert.deepEqual([entry.action, entry.priceCents, entry.startsAt], ["renew", 1000, new Date(Date.parse("2026-10-24T08:00:00.000Z") + 60 * DAY).toISOString()]);
  assert.deepEqual([standard.action, standard.priceCents, standard.listPriceCents, standard.reason], ["upgrade", 2667, 3000, null]);
  assert.equal(standard.expiresAt, view.planChain.expiresAt);
  const ios = (await quotes("ios")).planQuotes[1];
  assert.deepEqual([ios.action, ios.reason], ["blocked", "PLAN_UPGRADE_ANDROID_ONLY"]);

  const refused = await f.order("plan_standard_30d", "iOS");
  assert.equal(refused.statusCode, 409);
  assert.deepEqual(refused.json(), { code: "PLAN_UPGRADE_ANDROID_ONLY", message: "苹果手机暂不支持升级，可在当前套餐到期后购买" });
  assert.deepEqual((await f.order("plan_standard_30d")).json(), { code: "PLAN_UPGRADE_APP_OUTDATED", message: "请更新小程序后再升级" });

  const created = (await f.order("plan_standard_30d", "android")).json().data;
  assert.equal(created.order.amountCents, 2667);
  const signed = JSON.parse(created.payment.signData);
  assert.deepEqual([signed.goodsPrice, signed.activitySellingPrice], [3000, 2667]);
  // Renewals and new purchases carry no discount field.
  const points = JSON.parse((await f.order("points_10")).json().data.payment.signData);
  assert.equal(Object.hasOwn(points, "activitySellingPrice"), false);

  // query_order: a paid_fee at the list price is refused; order_fee at the list price is accepted.
  f.setQuery("paid-fee-list");
  await assert.rejects(f.runtime.syncOrder(created.order.id));
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(created.order.id)!.status, "created");
  f.setQuery("list");
  const synced = await f.runtime.syncOrder(created.order.id);
  assert.equal(synced.state, "delivered");
  const after = await quotes("android");
  assert.deepEqual([after.planChain.goodId, after.planChain.expiresAt], ["plan_standard_30d", view.planChain.expiresAt]);
  assert.deepEqual(after.planQuotes.map((item: { action: string }) => item.action), ["blocked", "renew", "upgrade"]);
  assert.equal(after.planQuotes[0].reason, "PLAN_DOWNGRADE_BLOCKED");
  assert.equal((await f.order("plan_entry_30d", "android")).json().code, "PLAN_DOWNGRADE_BLOCKED");
});

test("plan refunds only take the last unused plan in the chain; upgrade-related orders need manual handling", async t => {
  const f = fixture(); t.after(f.close);
  const refunds = new CommercialRefunds(f.store,
    { refundOrder: async () => ({ state: "accepted" }) }, { queryRefund: async () => ({ state: "pending" }) },
    () => new Date(Date.parse("2026-10-24T08:00:00.000Z") + 2 * DAY));
  const first = (await f.order("plan_entry_30d", "android")).json().data.order;
  f.paid(first);
  f.advance(DAY);
  const second = (await f.order("plan_entry_30d", "android")).json().data.order;
  f.paid(second);
  const request = (orderId: string) => refunds.request({ orderId, actor: "admin:test", reason: "七日内未使用", reasonCode: 3 });
  await assert.rejects(request(first.id), (error: unknown) =>
    error instanceof AppError && error.code === "REFUND_PLAN_NOT_LAST" && error.message === "只能退最后购买的套餐");
  assert.equal((await request(second.id)).status, "pending");

  const g = fixture(); t.after(g.close);
  const base = (await g.order("plan_entry_30d", "android")).json().data.order;
  g.paid(base);
  g.advance(DAY);
  const upgrade = (await g.order("plan_advanced_30d", "android")).json().data.order;
  g.paid(upgrade);
  const later = new CommercialRefunds(g.store,
    { refundOrder: async () => ({ state: "accepted" }) }, { queryRefund: async () => ({ state: "pending" }) },
    () => new Date(Date.parse("2026-10-24T08:00:00.000Z") + 2 * DAY));
  for (const id of [base.id, upgrade.id])
    await assert.rejects(later.request({ orderId: id, actor: "admin:test", reason: "测试", reasonCode: 3 }), (error: unknown) =>
      error instanceof AppError && error.code === "REFUND_PLAN_UPGRADE_MANUAL" && error.message === "升级相关订单请人工处理");
});

test("each payment failure records exactly one anomaly with its source and phase", async t => {
  const f = fixture(); t.after(f.close);
  const created = (await f.order("points_10")).json().data.order;
  f.setQuery("fail");
  // Background compensation: query failure.
  await assert.rejects(f.runtime.reconciliation.reconcile(f.runtime.target(created.id)));
  let rows = f.anomalies();
  assert.deepEqual(rows.map(row => [row.details.source, row.details.phase, row.details.code]),
    [["background", "query_order", "WECHAT_API_503"]]);

  // Callback-triggered query failure: one callback row, not a second delivery_error row.
  const timestamp = "1798195200", nonce = "n1";
  const url = `/v1/commercial/wechat/callback?timestamp=${timestamp}&nonce=${nonce}&signature=${callbackSignature(token, timestamp, nonce)}`;
  const body = {
    MsgType: "event", Event: "xpay_goods_deliver_notify", OpenId: f.owner.openid, OutTradeNo: created.id, Env: 0,
    WeChatPayInfo: { MchOrderNo: `wx-${created.id}`, PaidTime: 1_798_195_200 },
    GoodsInfo: { ProductId: "points_10", Quantity: 1, ActualPrice: 1000 },
  };
  assert.equal((await f.app.inject({ method: "POST", url, payload: body })).statusCode >= 500, true);
  rows = f.anomalies().filter(row => row.details.source === "callback");
  assert.deepEqual(rows.map(row => [row.details.phase, row.details.code]), [["query_order", "WECHAT_API_503"]]);

  // A local delivery failure after a good query is a deliver-phase row.
  f.setQuery("paid");
  f.store.db.exec("CREATE TRIGGER fail_grant BEFORE INSERT ON commercial_order_grants BEGIN SELECT RAISE(FAIL,'synthetic'); END");
  await assert.rejects(f.runtime.syncOrder(created.id));
  rows = f.anomalies().filter(row => row.details.source === "manual");
  assert.deepEqual(rows.map(row => row.details.phase), ["deliver"]);
  f.store.db.exec("DROP TRIGGER fail_grant");

  // Refund query failures: manual resolution is "manual", callback sync is
  // recorded once by the refund query itself.
  f.setQuery("paid");
  await f.runtime.syncOrder(created.id);
  const refunds = new CommercialRefunds(f.store, f.runtime.api, f.runtime.api, () => new Date(Date.parse("2026-10-24T08:00:00.000Z") + DAY));
  const refund = await refunds.request({ orderId: created.id, actor: "admin:test", reason: "测试", reasonCode: 3 });
  f.store.db.prepare("UPDATE commercial_refunds SET submission_status='unknown',updated_at=0 WHERE id=?").run(refund.id);
  f.setQuery("fail");
  await assert.rejects(refunds.resolveUnknownAsFailed(refund.id, { actor: "admin:test", reason: "核实", expectedAttempt: 1 }));
  const manual = f.anomalies().filter(row => row.details.refundId === refund.id);
  assert.deepEqual(manual.map(row => [row.details.source, row.details.phase]), [["manual", "refund_query"]]);

  f.store.db.prepare("DELETE FROM audit WHERE action='commercial.payment.anomaly'").run();
  const refundBody = {
    MsgType: "event", Event: "xpay_refund_notify", MchOrderId: created.id, MchRefundId: refund.id,
    WxOrderId: `wx-${created.id}`, RefundFee: 1000, RetCode: 0,
  };
  assert.equal((await f.app.inject({ method: "POST", url, payload: refundBody })).statusCode, 200);
  assert.deepEqual(f.anomalies().map(row => [row.details.source, row.details.phase, row.details.code]),
    [["callback", "refund_query", "WECHAT_API_503"]]);
});

test("an upgrade that converted nothing can be refunded in full; refund failure restores it as delivered", async t => {
  const f = fixture(); t.after(f.close);
  const plus = (await f.order("plan_entry_30d", "android")).json().data.order;
  f.paid(plus);
  f.advance(DAY);
  const first = (await f.order("plan_standard_30d", "android")).json().data.order;
  const second = (await f.order("plan_advanced_30d", "android")).json().data.order;
  f.paid(first);
  f.paid(second); // its only segment was already taken by the first upgrade
  const grants = (id: string) => Number(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_order_grants WHERE order_id=?").get(id)!.n);
  assert.equal(grants(second.id), 0);
  const partial = f.anomalies().find(row => row.resourceId === second.id)!;
  assert.deepEqual([partial.details.code, partial.details.converted, partial.details.unconverted],
    ["PLAN_UPGRADE_PARTIAL", [], [{ orderId: plus.id, totalBucketId: `plan-total:${plus.id}` }]]);

  let submit: { state: "accepted" } | { state: "failed"; code: number } = { state: "failed", code: 268490001 };
  const sent: unknown[] = [];
  const refunds = new CommercialRefunds(f.store,
    { refundOrder: async (input) => { sent.push(input); return submit; } },
    { queryRefund: async () => ({ state: "pending" }) },
    () => new Date(Date.parse("2026-10-24T08:00:00.000Z") + 2 * DAY));
  assert.equal(refunds.blockReason(first.id), "升级相关订单请人工处理");
  assert.equal(refunds.blockReason(plus.id), "升级相关订单请人工处理");
  assert.equal(refunds.blockReason(second.id), null);
  const request = () => refunds.request({ orderId: second.id, actor: "admin:test", reason: "升级未生效", reasonCode: 3 });
  const status = () => f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(second.id)!.status;
  assert.equal((await request()).status, "failed");
  // Restored as delivered, so a WeChat re-push stays an acknowledged replay.
  assert.equal(status(), "delivered");
  submit = { state: "accepted" };
  const refund = await request();
  assert.equal(refund.amountCents, second.amountCents);
  assert.deepEqual((sent.at(-1) as { amountCents: number; listPriceCents: number }),
    { ...(sent.at(-1) as object), amountCents: second.amountCents, listPriceCents: 6000 });
  assert.equal(status(), "refunding");
  assert.equal(refunds.applyPlatformResult(refund.id, { state: "refunded" }, refund.attempt).status, "refunded");
  assert.equal(status(), "refunded");
});

test("refund query accepts the list price as order_fee only for an upgrade", async () => {
  let order: Record<string, unknown> = {};
  const api = new WechatVirtualPaymentApi({
    getAccessToken: () => "t", getAppKey: () => "k", apiRoot: "https://wechat.test",
    fetcher: (async () => new Response(JSON.stringify({ errcode: 0, errmsg: "ok", order }))) as typeof fetch,
  });
  const input = {
    openid: "o", orderId: "order-12345678", wxOrderId: "wx-1", refundOrderId: "refund-12345678",
    amountCents: 2667, reasonCode: 3 as const, env: 0 as const,
  };
  order = { order_id: input.orderId, wx_order_id: "wx-1", order_type: 0, env_type: 1, order_fee: 3000, paid_fee: 2667, left_fee: 0, status: 8 };
  assert.equal((await api.queryRefund({ ...input, listPriceCents: 3000 })).state, "refunded");
  await assert.rejects(api.queryRefund(input), /金额不匹配/);
});

const deliveryPush = (order: { id: string; goodId: string; createdAtMs: number }, openid: string, actualPrice: number) => ({
  MsgType: "event", Event: "xpay_goods_deliver_notify", OpenId: openid, OutTradeNo: order.id, Env: 0,
  WeChatPayInfo: { MchOrderNo: `wx-${order.id}`, PaidTime: Math.floor(order.createdAtMs / 1000) },
  GoodsInfo: { ProductId: order.goodId, Quantity: 1, ActualPrice: actualPrice },
});
const callbackUrl = () => {
  const timestamp = "1798195200", nonce = "n-upgrade";
  return `/v1/commercial/wechat/callback?timestamp=${timestamp}&nonce=${nonce}&signature=${callbackSignature(token, timestamp, nonce)}`;
};
const upgradeOrder = async (f: ReturnType<typeof fixture>) => {
  f.paid((await f.order("plan_entry_30d", "android")).json().data.order);
  f.advance(DAY);
  return (await f.order("plan_standard_30d", "android")).json().data.order as {
    id: string; goodId: string; amountCents: number; createdAtMs: number;
  };
};

test("a delivery push at the discounted price delivers an upgrade, and its replay is acknowledged without a query", async t => {
  const f = fixture(); t.after(f.close);
  const upgrade = await upgradeOrder(f);
  assert.ok(upgrade.amountCents < 3000);
  f.setQuery("list");
  const push = deliveryPush(upgrade, f.owner.openid, upgrade.amountCents);
  const first = await f.app.inject({ method: "POST", url: callbackUrl(), payload: push });
  assert.equal(first.statusCode, 200);
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(upgrade.id)!.status, "delivered");
  const calls = f.queryCalls();
  const replay = await f.app.inject({ method: "POST", url: callbackUrl(), payload: push });
  assert.equal(replay.statusCode, 200);
  assert.equal(f.queryCalls(), calls);
  assert.deepEqual(f.anomalies(), []);
});

test("a delivery push or query whose paid amount is not the order's is recorded once and acknowledged", async t => {
  const f = fixture(); t.after(f.close);
  const upgrade = await upgradeOrder(f);
  f.setQuery("list");
  assert.equal((await f.app.inject({ method: "POST", url: callbackUrl(), payload: deliveryPush(upgrade, f.owner.openid, upgrade.amountCents) })).statusCode, 200);
  // A replay claiming the list price was paid: same rule as query_order's paid_fee.
  const listPush = deliveryPush(upgrade, f.owner.openid, 3000);
  for (let i = 0; i < 2; i++) {
    const reply = await f.app.inject({ method: "POST", url: callbackUrl(), payload: listPush });
    assert.equal(reply.statusCode, 200);
    assert.equal(reply.body, '{"ErrCode":0,"ErrMsg":"success"}');
  }
  assert.deepEqual(f.anomalies().map(row => [row.details.source, row.details.phase, row.details.code]),
    [["callback", "deliver", "PAYMENT_AMOUNT_MISMATCH"]]);
  assert.equal(Number(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_order_grants WHERE order_id=?").get(upgrade.id)!.n), 6);

  const g = fixture(); t.after(g.close);
  const pending = await upgradeOrder(g);
  g.setQuery("paid-fee-list");
  for (let i = 0; i < 2; i++)
    assert.equal((await g.app.inject({ method: "POST", url: callbackUrl(), payload: deliveryPush(pending, g.owner.openid, pending.amountCents) })).statusCode, 200);
  assert.equal(g.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(pending.id)!.status, "created");
  assert.deepEqual(g.anomalies().map(row => [row.details.source, row.details.phase, row.details.code]),
    [["callback", "query_order", "PAYMENT_AMOUNT_MISMATCH"]]);
});
