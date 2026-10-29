import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import test from "node:test";
import {
  COMMERCIAL_CATALOG_SETTING,
  CommercialCatalog,
  PUBLISHED_COMMERCIAL_GOODS,
} from "../server/src/modules/commercial/catalog.js";
import { CommercialOrders } from "../server/src/modules/commercial/orders.js";
import {
  parseGoodsDeliveryEvent,
  receivePlaintextGoodsDelivery,
  receiveSecureGoodsDelivery,
  successAck,
} from "../server/src/modules/commercial/payment-events.js";
import { callbackSignature } from "../server/src/modules/commercial/virtual-payment.js";
import { SqliteStore } from "../server/src/shared/store.js";

const token = "callback-token";
const timestamp = "1798195200";
const nonce = "nonce-1";
const appId = "wx-route-app";
const aesKey = Buffer.from("01234567890123456789012345678901");
const encodingAesKey = aesKey.toString("base64").slice(0, -1);
const event = {
  ToUserName: "gh_test",
  FromUserName: "official",
  CreateTime: 1_798_195_200,
  MsgType: "event",
  Event: "xpay_goods_deliver_notify",
  OpenId: "o-user",
  OutTradeNo: "order-123456",
  Env: 0,
  WeChatPayInfo: { MchOrderNo: "wx-order-1", TransactionId: "transaction-1", PaidTime: 1_798_195_200 },
  GoodsInfo: { ProductId: "points_10", Quantity: 1, OrigPrice: 1000, ActualPrice: 1000, Attach: "opaque" },
};

test("verified JSON delivery is queried and ACKed only after fulfillment", async () => {
  let received: unknown;
  const body = JSON.stringify(event);
  const verified = {
    orderId: "order-123456", wxOrderId: "wx-query-1", openid: "o-user",
    productId: "points_10", amountCents: 1000, env: 0 as const,
    paidAtMs: 1_798_195_200_000, platform: "android" as const,
  };
  const result = await receivePlaintextGoodsDelivery({
    orders: { receiveVerifiedPayment: (payment) => {
      received = payment;
      return { id: payment.orderId, status: "delivered" } as never;
    } },
    verifyPayment: async parsed => {
      assert.equal(parsed.orderId, "order-123456");
      return verified;
    },
    token,
    signature: callbackSignature(token, timestamp, nonce),
    timestamp,
    nonce,
    receivedAtMs: Number(timestamp) * 1000,
    body,
    format: "json",
  });
  assert.deepEqual(received, verified);
  assert.equal(result.acknowledgement, '{"ErrCode":0,"ErrMsg":"success"}');
});

test("bad signature or incomplete event data never query or fulfill", async () => {
  let deliveries = 0;
  let queries = 0;
  const orders = { receiveVerifiedPayment: () => { deliveries++; return {} as never; } };
  const verifyPayment = async () => { queries++; return {} as never; };
  const body = JSON.stringify(event);
  await assert.rejects(receivePlaintextGoodsDelivery({
    orders, verifyPayment, token, signature: "0".repeat(40), timestamp, nonce,
    receivedAtMs: Number(timestamp) * 1000, body, format: "json",
  }), /签名/);
  const noAmount = JSON.stringify({ ...event, GoodsInfo: { ...event.GoodsInfo, ActualPrice: undefined } });
  await assert.rejects(receivePlaintextGoodsDelivery({
    orders, verifyPayment, token, signature: callbackSignature(token, timestamp, nonce), timestamp, nonce,
    receivedAtMs: Number(timestamp) * 1000, body: noAmount, format: "json",
  }), /金额/);
  assert.equal(queries, 0);
  assert.equal(deliveries, 0);
});

test("documented XML fields parse without changing their names and use XML ACK", () => {
  const xml = `<xml>
    <MsgType><![CDATA[event]]></MsgType><Event><![CDATA[xpay_goods_deliver_notify]]></Event>
    <OpenId><![CDATA[o-user]]></OpenId><OutTradeNo><![CDATA[order-123456]]></OutTradeNo><Env>0</Env>
    <WeChatPayInfo><MchOrderNo><![CDATA[wx-order-1]]></MchOrderNo><PaidTime>1798195200</PaidTime></WeChatPayInfo>
    <GoodsInfo><ProductId><![CDATA[points_10]]></ProductId><Quantity>1</Quantity><ActualPrice>1000</ActualPrice></GoodsInfo>
  </xml>`;
  const parsed = parseGoodsDeliveryEvent(xml, "xml");
  assert.equal(parsed.orderId, "order-123456");
  assert.equal(successAck("xml"), "<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>");
});

test("secure JSON delivery returns an encrypted ACK and a repeated notification does not grant twice", async () => {
  const store = new SqliteStore(":memory:");
  const catalog = new CommercialCatalog(store);
  const orders = new CommercialOrders(store, catalog, () => new Date(1_798_195_200_000));
  const user = store.upsertUser("secure-payment-owner", "购买者", "wechat");
  store.db.prepare("UPDATE users SET data=? WHERE id=?").run(
    JSON.stringify({ ...user, ageBand: "adult" }), user.id,
  );
  store.saveSetting(COMMERCIAL_CATALOG_SETTING, {
    version: "secure-payment-test",
    approved: true,
    goods: PUBLISHED_COMMERCIAL_GOODS.map(good => ({
      id: good.id,
      enabled: true,
      android: { credits: 11, ...(good.kind === "plan" ? { weeklyCredits: 1 } : {}) },
      ios: { credits: 9, ...(good.kind === "plan" ? { weeklyCredits: 1 } : {}) },
    })),
  });
  const created = orders.create(user.id, "points_10", "secure-notify", { ageBand: "adult" });
  const secureEvent = {
    ...event,
    OpenId: user.openid,
    OutTradeNo: created.id,
    GoodsInfo: { ...event.GoodsInfo, ProductId: created.goodId, ActualPrice: created.amountCents },
  };
  const raw = JSON.stringify(secureEvent);
  const frame = Buffer.concat([Buffer.alloc(16, 1), Buffer.alloc(4), Buffer.from(raw), Buffer.from(appId)]);
  frame.writeUInt32BE(Buffer.byteLength(raw), 16);
  const padding = 32 - (frame.length % 32);
  const cipher = createCipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([frame, Buffer.alloc(padding, padding)])), cipher.final()]).toString("base64");
  const input = {
    orders,
    verifyPayment: async parsed => ({
      orderId: parsed.orderId, wxOrderId: "wx-query", openid: user.openid,
      productId: created.goodId, amountCents: created.amountCents, platform: "android" as const, env: 0 as const,
      paidAtMs: parsed.paidAtMs,
    }),
    token, encodingAesKey, appId, timestamp, nonce, receivedAtMs: Number(timestamp) * 1000,
    signature: callbackSignature(token, timestamp, nonce, encrypted),
    body: JSON.stringify({ ToUserName: "gh-test", Encrypt: encrypted }),
    format: "json" as const,
  };
  try {
    const first = await receiveSecureGoodsDelivery(input);
    const replay = await receiveSecureGoodsDelivery(input);
    for (const result of [first, replay])
      assert.equal(result.acknowledgement, "success", "plain success needs no encryption in secure mode");
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM commercial_entries").get()!.count, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM commercial_order_grants").get()!.count, 1);
  } finally {
    store.close();
  }
});

test("verified non-delivery callbacks are recorded and ACKed even if their handler fails", async () => {
  const body = JSON.stringify({
    MsgType: "event",
    Event: "xpay_refund_notify",
    MchOrderId: "order-123456",
    MchRefundId: "refund-123456",
    WxOrderId: "wx-order-1",
    RefundFee: 1000,
    RetCode: 0,
  });
  let observed: unknown;
  const result = await receivePlaintextGoodsDelivery({
    orders: { receiveVerifiedPayment: () => { throw new Error("must not deliver"); } },
    verifyPayment: async () => { throw new Error("must not query as payment"); },
    token,
    signature: callbackSignature(token, timestamp, nonce),
    timestamp,
    nonce,
    receivedAtMs: Number(timestamp) * 1000,
    body,
    format: "json",
    observe: async value => { observed = value; throw new Error("synthetic recorder outage"); },
  });
  assert.equal(result.acknowledgement, '{"ErrCode":0,"ErrMsg":"success"}');
  assert.deepEqual(observed, {
    eventKey: createHash("sha256").update(`json\0${body}`, "utf8").digest("hex"),
    eventType: "xpay_refund_notify",
    outcome: "ignored",
    orderId: "order-123456",
    refundId: "refund-123456",
    wxOrderId: "wx-order-1",
    amountCents: 1000,
    resultCode: 0,
  });
});

test("plaintext callback rejects a bad signature but still verifies a signed late push", async () => {
  const body = JSON.stringify(event);
  let verified = 0;
  const common = {
    orders: { receiveVerifiedPayment: () => ({} as never) },
    verifyPayment: async () => { verified++; return {} as never; },
    token, timestamp, nonce, body, format: "json" as const,
  };
  await assert.rejects(receivePlaintextGoodsDelivery({
    ...common, signature: "0".repeat(40),
  }), /签名/);
  assert.equal(verified, 0);
  const late = await receivePlaintextGoodsDelivery({
    ...common, signature: callbackSignature(token, timestamp, nonce),
  });
  assert.equal(late.acknowledgement, '{"ErrCode":0,"ErrMsg":"success"}');
  assert.equal(verified, 1, "a late push is still checked by query_order instead of being refused");
});
