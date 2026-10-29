import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "../server/node_modules/fastify/fastify.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { CommercialBilling } from "../server/src/shared/commercial-billing.js";
import { createCommercialRuntime } from "../server/src/modules/commercial/runtime.js";
import { registerCommercialRoutes } from "../server/src/modules/commercial/routes.js";
import { approvedCommercialCatalog } from "../server/src/modules/commercial/policy.js";
import { AppError } from "../server/src/shared/domain.js";
import { CallbackSignatureError, callbackSignature } from "../server/src/modules/commercial/virtual-payment.js";

test("invalid callback signature parts use the denied error class while missing server tokens remain configuration errors", () => {
  for (const parts of [[], ["", "nonce"], ["time", undefined], ["time", 42]])
    assert.throws(() => callbackSignature("synthetic-token", ...(parts as string[])), CallbackSignatureError);
  assert.throws(() => callbackSignature("", "time", "nonce"), error =>
    error instanceof TypeError && !(error instanceof CallbackSignatureError));
});

test("amount mismatch records a fixed event even when callback handling will acknowledge the notification", async t => {
  const clock = () => new Date("2026-10-26T08:00:00Z");
  const store = new SqliteStore(":memory:", clock); t.after(() => store.close());
  store.saveSetting("commercial.catalog", approvedCommercialCatalog());
  const user = store.upsertUser("synthetic-private-openid", "Synthetic", "wechat");
  const events: Record<string, unknown>[] = [];
  const runtime = createCommercialRuntime({ store, billing: new CommercialBilling(store, clock), clock,
    logger: { warn: fields => { events.push(fields); } },
    config: { offerId: "synthetic", appKey: "private-key", callbackToken: "private-token", callbackMode: "plaintext", callbackFormat: "json",
      getAccessToken: () => "private-access-token", apiRoot: "https://synthetic.test",
      fetcher: (async (_url, init) => {
        const { order_id } = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ errcode: 0, order: { order_id, status: 2, order_type: 0, env_type: 1,
          order_fee: 1, paid_fee: 1, paid_time: Math.floor(clock().getTime() / 1000), wx_order_id: "private-wx-order" } }));
      }) as typeof fetch,
    } });
  const order = runtime.orders.create(user.id, "points_10", "synthetic-idempotency", { ageBand: "adult" });
  await assert.rejects(runtime.verifyCallbackPayment({ orderId: order.id, wxOrderId: "private-wx-order", openid: user.openid,
    productId: order.goodId, amountCents: order.amountCents, env: 0, paidAtMs: clock().getTime() }), { code: "PAYMENT_AMOUNT_MISMATCH" });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.event, "payment_amount_mismatch");
  assert.equal(events[0]!.phase, "query_order");
  assert.doesNotMatch(JSON.stringify(events), /private-|synthetic-private-openid/);
  assert.equal(runtime.orders.detail(user.id, order.id).status, "created");
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM commercial_order_grants").get()!.n, 0);
});

test("invalid callback signatures produce the fixed denied code before any platform request", async t => {
  const store = new SqliteStore(":memory:"); t.after(() => store.close());
  const app = Fastify(); t.after(() => app.close());
  let called = false;
  registerCommercialRoutes(app, { store, billing: new CommercialBilling(store),
    auth: { require: () => { throw new Error("not used"); }, wechatPaymentSession: () => { throw new Error("not used"); } },
    config: { offerId: "synthetic", appKey: "synthetic", callbackToken: "synthetic", callbackFormat: "json", callbackMode: "plaintext",
      getAccessToken: () => "synthetic", fetcher: async () => { called = true; throw new Error("must not call"); } } });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ code: error.code });
    return reply.code(500).send({ code: "INTERNAL_ERROR" });
  });
  const response = await app.inject({ method: "POST", url: "/v1/commercial/wechat/callback?timestamp=1&nonce=synthetic&signature=bad", payload: { Event: "xpay_goods_deliver_notify" } });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().code, "CALLBACK_SIGNATURE_INVALID");
  assert.equal(called, false);
});

for (const scenario of ["secure-signature", "missing-token", "invalid-aes-key"] as const) {
  test(`callback errors distinguish ${scenario} from payment configuration failures`, async t => {
    const store = new SqliteStore(":memory:"); t.after(() => store.close());
    const app = Fastify(); t.after(() => app.close());
    let called = false;
    registerCommercialRoutes(app, { store, billing: new CommercialBilling(store),
      auth: { require: () => { throw new Error("not used"); }, wechatPaymentSession: () => { throw new Error("not used"); } },
      config: { offerId: "synthetic", appKey: "synthetic", callbackToken: scenario === "missing-token" ? "" : "synthetic",
        callbackFormat: "json", callbackMode: "secure", appId: "synthetic-app",
        encodingAesKey: scenario === "invalid-aes-key" ? "invalid" : Buffer.alloc(32).toString("base64").slice(0, -1),
        getAccessToken: () => "synthetic", fetcher: async () => { called = true; throw new Error("must not call"); } } });
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof AppError) return reply.code(error.statusCode).send({ code: error.code });
      return reply.code(500).send({ code: "INTERNAL_ERROR" });
    });
    const response = await app.inject({ method: "POST",
      url: "/v1/commercial/wechat/callback?timestamp=1&nonce=synthetic&msg_signature=bad",
      payload: { Encrypt: Buffer.alloc(32).toString("base64") } });
    assert.equal(response.statusCode, scenario === "secure-signature" ? 403 : 503);
    assert.equal(response.json().code, scenario === "secure-signature" ? "CALLBACK_SIGNATURE_INVALID" : "COMMERCIAL_PAYMENT_NOT_CONFIGURED");
    assert.equal(called, false);
  });
}
