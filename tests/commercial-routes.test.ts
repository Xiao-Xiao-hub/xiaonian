import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { AppError } from "../server/src/shared/domain.js";
import { CommercialBilling } from "../server/src/shared/commercial-billing.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { COMMERCIAL_CATALOG_SETTING, PUBLISHED_COMMERCIAL_GOODS } from "../server/src/modules/commercial/catalog.js";
import { callbackSignature } from "../server/src/modules/commercial/virtual-payment.js";
import { registerCommercialRoutes } from "../server/src/modules/commercial/routes.js";
import { CommercialRefunds } from "../server/src/modules/commercial/refunds.js";

const token = "callback-token";
const Fastify = createRequire(new URL("../server/package.json", import.meta.url))("fastify") as () => any;

function fixture(configured = true, callback: { mode: "plaintext" | "secure"; token: string } = { mode: "plaintext", token }) {
  const store = new SqliteStore(":memory:");
  const owner = store.upsertUser("wx-route-owner", "购买者", "wechat");
  const other = store.upsertUser("wx-route-other", "其他人", "wechat");
  store.saveSetting(COMMERCIAL_CATALOG_SETTING, {
    version: "routes-v1",
    approved: true,
    goods: PUBLISHED_COMMERCIAL_GOODS.map(good => ({
      id: good.id,
      enabled: true,
      android: { credits: good.kind === "plan" ? 5400 : good.priceCents * 5, ...(good.kind === "plan" ? { weeklyCredits: 1350 } : {}) },
      ios: { credits: good.kind === "plan" ? 4300 : good.priceCents * 4, ...(good.kind === "plan" ? { weeklyCredits: 1075 } : {}) },
    })),
  });
  const billing = new CommercialBilling(store);
  store.saveSetting("commercial.enabled", true);
  const app = Fastify();
  let queryState: "pending" | "paid" | "refunded" = "pending";
  let queryCalls = 0;
  let notifyCalls = 0;
  let notifyFailure = false;
  const auth = {
    require(req: { headers: Record<string, unknown> }) {
      const user = req.headers.authorization === "Bearer other" ? other : owner;
      return store.getUser(user.id)!;
    },
    wechatPaymentSession(req: { headers: Record<string, unknown> }) {
      const user = this.require(req);
      if (req.headers["x-payment-session"] === "missing")
        throw new AppError(401, "WECHAT_SESSION_REFRESH", "请刷新微信登录后重试");
      return { user, sessionKey: "session-key" };
    },
  };
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(String(_url)).pathname;
    if (pathname === "/xpay/refund_order")
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }));
    if (pathname === "/xpay/notify_provide_goods") {
      notifyCalls++;
      return notifyFailure ? new Response("unavailable", { status: 503 }) : new Response("");
    }
    queryCalls++;
    const sent = JSON.parse(String(init?.body)) as { order_id: string; openid: string };
    const row = store.db.prepare("SELECT good_id,amount_cents,created_at FROM commercial_orders WHERE id=?").get(sent.order_id) as {
      good_id: string; amount_cents: number; created_at: number;
    };
    const order = queryState === "pending"
      ? { order_id: sent.order_id, status: 1, order_type: 0 }
      : queryState === "refunded"
      ? {
          order_id: sent.order_id, status: 8, order_type: 0, env_type: 1,
          order_fee: row.amount_cents, paid_fee: row.amount_cents, left_fee: 0,
          wx_order_id: `wx-${sent.order_id}`,
        }
      : {
          order_id: sent.order_id, status: 2, order_type: 7, env_type: 1,
          order_fee: row.amount_cents, paid_fee: row.amount_cents,
          paid_time: Math.floor(row.created_at / 1000), wx_order_id: `wx-${sent.order_id}`,
        };
    return new Response(JSON.stringify({ errcode: 0, errmsg: "ok", order }));
  }) as typeof fetch;
  const registration = registerCommercialRoutes(app, {
    auth: auth as never,
    store,
    billing,
    ...(configured ? { config: {
      offerId: "offer-1",
      appKey: "app-key",
      callbackToken: callback.token,
      callbackFormat: "json" as const,
      ...(callback.mode === "secure"
        ? { callbackMode: "secure" as const, appId: "wxba5fad812f8e6fb9", encodingAesKey: "A".repeat(43) }
        : { callbackMode: "plaintext" as const }),
      getAccessToken: () => "access-token",
      fetcher,
      apiRoot: "https://api.test",
    } } : {}),
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ code: error.code });
    const status = "issues" in error ? 400 : 500;
    return reply.code(status).send({ code: status === 400 ? "VALIDATION_ERROR" : "INTERNAL_ERROR" });
  });
  return {
    app, store, owner, other, registration,
    authHeaders: { authorization: "Bearer owner" },
    otherHeaders: { authorization: "Bearer other" },
    setQueryState: (state: "pending" | "paid" | "refunded") => { queryState = state; },
    queryCalls: () => queryCalls,
    notifyCalls: () => notifyCalls,
    setNotifyFailure: (value: boolean) => { notifyFailure = value; },
  };
}

test("catalog fails closed without payment secrets and never exposes fixed plan credits", async t => {
  const f = fixture(false); t.after(async () => { await f.app.close(); f.store.close(); });
  const response = await f.app.inject({ url: "/v1/commercial/catalog" });
  assert.equal(response.statusCode, 200);
  const goods = response.json().data;
  assert.equal(goods.every((good: { purchasable: boolean }) => !good.purchasable), true);
  const plan = goods.find((good: { kind: string }) => good.kind === "plan");
  assert.equal(plan.platforms.android.weeklyMultiplier, 9);
  assert.equal(Object.hasOwn(plan.platforms.android, "credits"), false);
  const points = goods.find((good: { kind: string }) => good.kind === "points");
  assert.equal(points.platforms.android.credits, 5000);
  const purchase = await f.app.inject({ method: "POST", url: "/v1/commercial/orders", payload: {} });
  assert.equal(purchase.statusCode, 503);
});

test("order creation rejects price injection, requires a payment session, and signs server price", async t => {
  const f = fixture(); t.after(async () => { await f.app.close(); f.store.close(); });
  const attempted = await f.app.inject({
    method: "POST", url: "/v1/commercial/orders", headers: f.authHeaders,
    payload: { productId: "points_10", idempotencyKey: "tamper", purchase: { ageBand: "adult" }, amountCents: 1 },
  });
  assert.equal(attempted.statusCode, 400);
  const missing = await f.app.inject({
    method: "POST", url: "/v1/commercial/orders",
    headers: { ...f.authHeaders, "x-payment-session": "missing" },
    payload: { productId: "points_10", idempotencyKey: "no-session", purchase: { ageBand: "adult" } },
  });
  assert.equal(missing.statusCode, 401);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_orders").get()!.n, 0);
  const created = await f.app.inject({
    method: "POST", url: "/v1/commercial/orders", headers: f.authHeaders,
    payload: { productId: "points_10", idempotencyKey: "valid-one", purchase: { ageBand: "adult" } },
  });
  assert.equal(created.statusCode, 200);
  const data = created.json().data;
  assert.equal(data.order.amountCents, 1000);
  assert.deepEqual(JSON.parse(data.payment.signData), {
    offerId: "offer-1", buyQuantity: 1, env: 0, currencyType: "CNY",
    productId: "points_10", goodsPrice: 1000, outTradeNo: data.order.id, attach: data.order.id,
  });
});

test("order reads and sync remain owner scoped", async t => {
  const f = fixture(); t.after(async () => { await f.app.close(); f.store.close(); });
  const created = (await f.app.inject({
    method: "POST", url: "/v1/commercial/orders", headers: f.authHeaders,
    payload: { productId: "points_10", idempotencyKey: "owner-one", purchase: { ageBand: "adult" } },
  })).json().data.order;
  assert.equal((await f.app.inject({ url: `/v1/commercial/orders/${created.id}`, headers: f.otherHeaders })).statusCode, 404);
  assert.equal((await f.app.inject({ method: "POST", url: `/v1/commercial/orders/${created.id}/sync`, headers: f.otherHeaders })).statusCode, 404);
  assert.equal(f.queryCalls(), 0);
});

test("user sync repairs a lost notification only after query_order confirms payment", async t => {
  const f = fixture(); t.after(async () => { await f.app.close(); f.store.close(); });
  const created = (await f.app.inject({
    method: "POST", url: "/v1/commercial/orders", headers: f.authHeaders,
    payload: { productId: "points_10", idempotencyKey: "lost-notify", purchase: { ageBand: "adult" } },
  })).json().data.order;
  f.setQueryState("paid");
  const synced = await f.app.inject({ method: "POST", url: `/v1/commercial/orders/${created.id}/sync`, headers: f.authHeaders });
  assert.equal(synced.statusCode, 200);
  assert.equal(synced.json().data.state, "delivered");
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(created.id)!.status, "delivered");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_order_grants").get()!.n, 1);
  assert.equal(f.notifyCalls(), 1, "query-order compensation explicitly tells WeChat delivery completed");
});

test("a notify_provide_goods outage keeps local delivery and records an operator-visible anomaly", async t => {
  const f = fixture(); t.after(async () => { await f.app.close(); f.store.close(); });
  const created = (await f.app.inject({
    method: "POST", url: "/v1/commercial/orders", headers: f.authHeaders,
    payload: { productId: "points_10", idempotencyKey: "notify-outage", purchase: { ageBand: "adult" } },
  })).json().data.order;
  f.setQueryState("paid");
  f.setNotifyFailure(true);
  const synced = await f.registration.runtime!.syncOrder(created.id);
  assert.equal(synced.state, "delivered");
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(created.id)!.status, "delivered");
  const anomalies = f.store.audits({ action: "commercial.payment.anomaly" });
  assert.equal(anomalies.some(item => item.details.phase === "notify_provide_goods"), true);
  const first = anomalies.find(item => item.details.phase === "notify_provide_goods")!;
  const fixedTime = "2026-10-24T08:00:00.000Z";
  let currentId = first.id;
  for (const resolutionId of ["resolution-c", "resolution-d", "resolution-a"]) {
    f.store.db.prepare("UPDATE audit SET created_at=?").run(fixedTime);
    f.store.db.prepare(
      "INSERT INTO audit(id,actor,action,resource_id,details,created_at) VALUES(?,'admin:test','commercial.payment.anomaly.resolved',?,?,?)",
    ).run(resolutionId, currentId, JSON.stringify({ reason: "人工核对后重试" }), fixedTime);
    await f.registration.runtime!.syncOrder(created.id);
    const suffix = createHash("sha256").update(resolutionId).digest("hex").slice(0, 16);
    currentId = `${first.id}:${suffix}`;
    assert.ok(f.store.db.prepare("SELECT id FROM audit WHERE id=?").get(currentId));
  }
  const reopened = f.store.audits({ action: "commercial.payment.anomaly" })
    .filter(item => item.details.phase === "notify_provide_goods");
  assert.equal(reopened.length, 4, "three resolved same-clock failures each reopen a distinct alert");
});

test("a local compensation write failure is audited and rolls delivery back", async t => {
  const f = fixture(); t.after(async () => { await f.app.close(); f.store.close(); });
  const created = (await f.app.inject({
    method: "POST", url: "/v1/commercial/orders", headers: f.authHeaders,
    payload: { productId: "points_10", idempotencyKey: "local-write-failure", purchase: { ageBand: "adult" } },
  })).json().data.order;
  f.store.db.exec("CREATE TRIGGER fail_compensation_grant BEFORE INSERT ON commercial_order_grants BEGIN SELECT RAISE(FAIL,'synthetic grant failure'); END");
  f.setQueryState("paid");
  const synced = await f.app.inject({ method: "POST", url: `/v1/commercial/orders/${created.id}/sync`, headers: f.authHeaders });
  assert.equal(synced.statusCode, 500);
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(created.id)!.status, "created");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_order_grants WHERE order_id=?").get(created.id)!.n, 0);
  const anomalies = f.store.audits({ action: "commercial.payment.anomaly" });
  assert.equal(anomalies.some(item => item.resourceId === created.id && item.details.source === "background"), true);
});

test("background compensation rotates past abandoned orders", async t => {
  const f = fixture(); t.after(async () => { await f.app.close(); f.store.close(); });
  const ids: string[] = [];
  for (const idempotencyKey of ["first-abandoned", "second-payable"])
    ids.push((await f.app.inject({ method: "POST", url: "/v1/commercial/orders", headers: f.authHeaders,
      payload: { productId: "points_10", idempotencyKey, purchase: { ageBand: "adult" } } })).json().data.order.id);
  await f.registration.pollPending(1);
  f.setQueryState("paid");
  await f.registration.pollPending(1);
  assert.equal(f.queryCalls(), 2);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_orders WHERE status='delivered'").get()!.n, 1);
});

test("secure mode URL verification checks the plain signature and echoes echostr (official example)", async t => {
  const f = fixture(true, { mode: "secure", token: "AAAAA" }); t.after(async () => { await f.app.close(); f.store.close(); });
  const url = "/v1/commercial/wechat/callback?signature=f464b24fc39322e44b38aa78f5edd27bd1441696&echostr=4375120948345356249&timestamp=1714036504&nonce=1514711492";
  const ok = await f.app.inject({ url });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body, "4375120948345356249");
  const bad = await f.app.inject({ url: url.replace("signature=f464b2", "signature=0464b2") });
  assert.equal(bad.statusCode, 403);
  assert.equal(bad.json().code, "CALLBACK_SIGNATURE_INVALID");
});

test("callback query bypasses user throttle, rejects bad signatures, and duplicate delivery grants once", async t => {
  const f = fixture(); t.after(async () => { await f.app.close(); f.store.close(); });
  const created = (await f.app.inject({
    method: "POST", url: "/v1/commercial/orders", headers: f.authHeaders,
    payload: { productId: "points_10", idempotencyKey: "callback-one", purchase: { ageBand: "adult" } },
  })).json().data.order;
  const sync = await f.app.inject({ method: "POST", url: `/v1/commercial/orders/${created.id}/sync`, headers: f.authHeaders });
  assert.equal(sync.json().data.state, "pending");
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = "callback-nonce";
  const challenge = await f.app.inject({
    url: `/v1/commercial/wechat/callback?timestamp=${timestamp}&nonce=${nonce}&echostr=ready&signature=${callbackSignature(token, timestamp, nonce)}`,
  });
  assert.equal(challenge.body, "ready");
  const body = JSON.stringify({
    MsgType: "event", Event: "xpay_goods_deliver_notify", OpenId: "untrusted",
    OutTradeNo: created.id, Env: 0,
    WeChatPayInfo: { MchOrderNo: "untrusted-wx", PaidTime: 1 },
    GoodsInfo: { ProductId: "points_50", Quantity: 1, ActualPrice: 1 },
  });
  const bad = await f.app.inject({
    method: "POST", url: `/v1/commercial/wechat/callback?timestamp=${timestamp}&nonce=${nonce}&signature=${"0".repeat(40)}`,
    payload: JSON.parse(body),
  });
  assert.equal(bad.statusCode >= 400, true);
  assert.equal(f.queryCalls(), 1);
  f.setQueryState("paid");
  const signature = callbackSignature(token, timestamp, nonce);
  const callbackUrl = `/v1/commercial/wechat/callback?timestamp=${timestamp}&nonce=${nonce}&signature=${signature}`;
  const first = await f.app.inject({ method: "POST", url: callbackUrl, payload: JSON.parse(body) });
  const mismatch = await f.app.inject({ method: "POST", url: callbackUrl, payload: JSON.parse(body) });
  assert.equal(mismatch.statusCode, 409);
  const realBody = { ...JSON.parse(body), OpenId: f.owner.openid,
    WeChatPayInfo: { MchOrderNo: `wx-${created.id}`, PaidTime: Math.floor(created.createdAtMs / 1000) },
    GoodsInfo: { ProductId: "points_10", Quantity: 1, ActualPrice: 1000 } };
  const replay = await f.app.inject({ method: "POST", url: callbackUrl, payload: realBody });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body, '{"ErrCode":0,"ErrMsg":"success"}');
  assert.equal(replay.statusCode, 200);
  assert.equal(f.queryCalls(), 2, "callback bypasses user throttle once; verified identical replays need no external query");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_order_grants").get()!.n, 1);
  assert.equal(f.store.db.prepare("SELECT platform FROM commercial_orders WHERE id=?").get(created.id)!.platform, "ios");
  f.store.db.prepare("UPDATE users SET openid=?,erased_at=? WHERE id=?")
    .run(`erased:${f.owner.id}`, Date.now(), f.owner.id);
  f.store.db.prepare("UPDATE commercial_orders SET account_erased_at=? WHERE id=?")
    .run(Date.now(), created.id);
  for (const status of ["refunding", "refunded"]) {
    f.store.db.prepare("UPDATE commercial_orders SET status=? WHERE id=?").run(status, created.id);
    const oldNotice = await f.app.inject({ method: "POST", url: callbackUrl, payload: realBody });
    assert.equal(oldNotice.statusCode, 200);
    assert.equal(oldNotice.json().ErrCode, 0);
    assert.equal(f.queryCalls(), 2, "historical callback validation uses the order's retained buyer openid");
    assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(created.id)!.status, status);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commercial_order_grants").get()!.n, 1);
  }
  const sandbox = await f.app.inject({
    method: "POST", url: callbackUrl, payload: { ...realBody, Env: 1 },
  });
  assert.equal(sandbox.statusCode >= 400, true);
  const anomalies = f.store.audits({ action: "commercial.payment.anomaly" });
  assert.equal(anomalies.some(item => item.details.code === "PAYMENT_MISMATCH"), true);
  assert.equal(anomalies.some(item => item.details.code === "CALLBACK_INVALID"), true);
});

test("refund notifications ACK, dedupe, and confirm a known Android refund through query_order", async t => {
  const f = fixture(); t.after(async () => { await f.app.close(); f.store.close(); });
  const created = (await f.app.inject({
    method: "POST", url: "/v1/commercial/orders", headers: f.authHeaders,
    payload: { productId: "points_10", idempotencyKey: "refund-callback", purchase: { ageBand: "adult" } },
  })).json().data.order;
  f.setQueryState("paid");
  await f.app.inject({ method: "POST", url: `/v1/commercial/orders/${created.id}/sync`, headers: f.authHeaders });
  // The fixture's paid receipt defaults to iOS; use the already verified local
  // facts to represent the Android path eligible for developer refund.
  f.store.db.prepare("UPDATE commercial_orders SET platform='android' WHERE id=?").run(created.id);
  const refunds = new CommercialRefunds(f.store, f.registration.runtime!.api, f.registration.runtime!.api);
  const refund = await refunds.request({ orderId: created.id, actor: "admin:test", reason: "回调确认", reasonCode: 5 });
  assert.equal(refund.status, "pending");
  f.setQueryState("refunded");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "refund-callback-nonce";
  const body = {
    MsgType: "event", Event: "xpay_refund_notify",
    MchOrderId: created.id, MchRefundId: refund.id,
    WxOrderId: `wx-${created.id}`, RefundFee: created.amountCents, RetCode: 0,
  };
  const url = `/v1/commercial/wechat/callback?timestamp=${timestamp}&nonce=${nonce}&signature=${callbackSignature(token, timestamp, nonce)}`;
  const before = f.queryCalls();
  const first = await f.app.inject({ method: "POST", url, payload: body });
  const replay = await f.app.inject({ method: "POST", url, payload: body });
  assert.equal(first.statusCode, 200);
  assert.equal(replay.statusCode, 200);
  assert.equal(first.body, '{"ErrCode":0,"ErrMsg":"success"}');
  assert.equal(f.queryCalls(), before + 1, "same signed refund notice is processed once");
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_refunds WHERE id=?").get(refund.id)!.status, "refunded");
  assert.equal(f.store.db.prepare("SELECT status FROM commercial_orders WHERE id=?").get(created.id)!.status, "refunded");
  assert.equal(f.store.audits({ action: "commercial.payment.callback.received" }).length, 1);
  assert.equal(f.store.audits({ action: "commercial.refund.callback_synced" }).length, 1);
});

test("a successful refund callback after local failure raises an anomaly instead of silently trusting either side", async t => {
  const f = fixture(); t.after(async () => { await f.app.close(); f.store.close(); });
  const created = (await f.app.inject({
    method: "POST", url: "/v1/commercial/orders", headers: f.authHeaders,
    payload: { productId: "points_10", idempotencyKey: "refund-late-success", purchase: { ageBand: "adult" } },
  })).json().data.order;
  f.setQueryState("paid");
  await f.app.inject({ method: "POST", url: `/v1/commercial/orders/${created.id}/sync`, headers: f.authHeaders });
  f.store.db.prepare("UPDATE commercial_orders SET platform='android' WHERE id=?").run(created.id);
  const refunds = new CommercialRefunds(f.store, f.registration.runtime!.api, f.registration.runtime!.api);
  const pending = await refunds.request({ orderId: created.id, actor: "admin:test", reason: "本地先失败", reasonCode: 5 });
  const failed = refunds.applyPlatformResult(pending.id, { state: "failed", code: "STATUS_7" }, pending.attempt);
  assert.equal(failed.status, "failed");

  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "refund-late-success-nonce";
  const body = {
    MsgType: "event", Event: "xpay_refund_notify",
    MchOrderId: created.id, MchRefundId: pending.id,
    WxOrderId: `wx-${created.id}`, RefundFee: created.amountCents, RetCode: 0,
  };
  const url = `/v1/commercial/wechat/callback?timestamp=${timestamp}&nonce=${nonce}&signature=${callbackSignature(token, timestamp, nonce)}`;
  assert.equal((await f.app.inject({ method: "POST", url, payload: body })).statusCode, 200);
  assert.equal(refunds.detail(pending.id).status, "failed", "the callback alone cannot rewrite monetary state");
  const anomalies = f.store.audits({ action: "commercial.payment.anomaly" });
  assert.equal(anomalies.some(item => item.details.code === "REFUND_CALLBACK_AFTER_LOCAL_FAILURE"), true);
});
