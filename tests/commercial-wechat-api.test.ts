import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { WechatVirtualPaymentApi, WechatVirtualPaymentApiError } from "../server/src/modules/commercial/wechat-api.js";
import { createServerPaySignature } from "../server/src/modules/commercial/virtual-payment.js";

const input = {
  openid: "o-user",
  orderId: "order-123456",
  env: 0 as const,
  productId: "points_10",
  amountCents: 1000,
};

test("query_order signs and sends the exact JSON bytes, then normalizes an iOS receipt", async () => {
  const appKey = "server-only-app-key";
  let requestUrl = "";
  let requestBody = "";
  const api = new WechatVirtualPaymentApi({
    getAccessToken: () => "access-token",
    getAppKey: () => appKey,
    apiRoot: "https://wechat.test",
    fetcher: (async (url, init) => {
      requestUrl = String(url);
      requestBody = String(init?.body);
      return new Response(JSON.stringify({
        errcode: 0,
        errmsg: "ok",
        order: {
          order_id: input.orderId,
          status: 2,
          order_type: 7,
          env_type: 1,
          order_fee: 1000,
          paid_fee: 1000,
          paid_time: 1_798_195_200,
          wx_order_id: "wx-ios-1",
        },
      }), { status: 200 });
    }) as typeof fetch,
  });
  const result = await api.queryVerifiedPayment(input);
  assert.equal(requestBody, JSON.stringify({ openid: input.openid, env: 0, order_id: input.orderId }));
  const url = new URL(requestUrl);
  assert.equal(url.pathname, "/xpay/query_order");
  assert.equal(url.searchParams.get("access_token"), "access-token");
  assert.equal(url.searchParams.get("pay_sig"), createHmac("sha256", appKey)
    .update(`/xpay/query_order&${requestBody}`).digest("hex"));
  assert.equal(`${requestUrl}${requestBody}`.includes(appKey), false);
  assert.deepEqual(result, {
    state: "paid",
    status: 2,
    receipt: {
      orderId: input.orderId,
      wxOrderId: "wx-ios-1",
      openid: input.openid,
      productId: input.productId,
      amountCents: 1000,
      platform: "ios",
      env: 0,
      paidAtMs: 1_798_195_200_000,
    },
  });
});

test("query_order returns non-paid states without inventing receipt fields", async () => {
  const api = new WechatVirtualPaymentApi({
    getAccessToken: () => "token",
    getAppKey: () => "key",
    fetcher: (async () => new Response(JSON.stringify({
      errcode: 0, errmsg: "ok", order: { order_id: input.orderId, status: 1, order_type: 0 },
    }))) as typeof fetch,
  });
  assert.deepEqual(await api.queryVerifiedPayment(input), { state: "pending", status: 1, orderType: 0 });
});

test("query_order accepts all official paid states 2, 3 and 4", async () => {
  for (const status of [2, 3, 4] as const) {
    const api = new WechatVirtualPaymentApi({
      getAccessToken: () => "token",
      getAppKey: () => "key",
      fetcher: (async () => new Response(JSON.stringify({
        errcode: 0,
        errmsg: "ok",
        order: {
          order_id: input.orderId,
          status,
          order_type: 0,
          env_type: 1,
          order_fee: input.amountCents,
          paid_fee: input.amountCents,
          paid_time: 1_798_195_200,
          wx_order_id: `wx-paid-${status}`,
        },
      }))) as typeof fetch,
    });
    const result = await api.queryVerifiedPayment(input);
    assert.equal(result.state, "paid");
    if (result.state === "paid") assert.equal(result.status, status);
  }
});

test("paid responses reject missing platform, amount, environment or mismatched identifiers", async () => {
  const base = {
    order_id: input.orderId, status: 2, order_type: 0, env_type: 1,
    order_fee: 1000, paid_fee: 1000, paid_time: 1_798_195_200, wx_order_id: "wx-1",
  };
  const rejected = async (change: Record<string, unknown>) => {
    const api = new WechatVirtualPaymentApi({
      getAccessToken: () => "token",
      getAppKey: () => "key",
      fetcher: (async () => new Response(JSON.stringify({ errcode: 0, errmsg: "ok", order: { ...base, ...change } }))) as typeof fetch,
    });
    await assert.rejects(api.queryVerifiedPayment(input));
  };
  await rejected({ order_type: undefined });
  await rejected({ paid_fee: undefined });
  await rejected({ paid_fee: 999 });
  await rejected({ env_type: 2 });
  await rejected({ order_id: "another-order" });
  await rejected({ wx_order_id: undefined });
});

test("refund_order signs the exact official asynchronous full-refund payload", async () => {
  const appKey = "refund-app-key";
  let requestUrl = "", requestBody = "";
  const api = new WechatVirtualPaymentApi({
    getAccessToken: () => "refund-token",
    getAppKey: () => appKey,
    apiRoot: "https://wechat.test",
    fetcher: (async (url, init) => {
      requestUrl = String(url); requestBody = String(init?.body);
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }));
    }) as typeof fetch,
  });
  const result = await api.refundOrder({
    openid: "o-user", orderId: "order-123456", wxOrderId: "wx-order-1",
    refundOrderId: "refund-123456", amountCents: 1000, reasonCode: 3, env: 0,
  });
  assert.equal(requestBody, JSON.stringify({
    openid: "o-user", order_id: "order-123456", refund_order_id: "refund-123456",
    left_fee: 1000, refund_fee: 1000, biz_meta: "refund-123456",
    refund_reason: "3", req_from: "1", env: 0,
  }));
  const url = new URL(requestUrl);
  assert.equal(url.pathname, "/xpay/refund_order");
  assert.equal(url.searchParams.get("access_token"), "refund-token");
  assert.equal(url.searchParams.get("pay_sig"), createHmac("sha256", appKey)
    .update(`/xpay/refund_order&${requestBody}`).digest("hex"));
  assert.equal(`${requestUrl}${requestBody}`.includes(appKey), false);
  assert.deepEqual(result, { state: "accepted" });
});

test("refund_order distinguishes an explicit platform rejection from an unknown transport failure", async () => {
  const api = new WechatVirtualPaymentApi({
    getAccessToken: () => "token", getAppKey: () => "key",
    fetcher: (async () => new Response(JSON.stringify({ errcode: -1, errmsg: "rejected" }))) as typeof fetch,
  });
  assert.deepEqual(await api.refundOrder({
    openid: "o-user", orderId: "order-123456", wxOrderId: "wx-order-1",
    refundOrderId: "refund-123456", amountCents: 1000, reasonCode: 5, env: 0,
  }), { state: "failed", code: -1 });
});

test("notify_provide_goods signs exactly the body it sends", async () => {
  let requestUrl = "", requestBody = "";
  const api = new WechatVirtualPaymentApi({
    getAccessToken: () => "delivery-token",
    getAppKey: () => "app-key",
    apiRoot: "https://wechat.test",
    fetcher: (async (url, init) => {
      requestUrl = String(url);
      requestBody = String(init?.body);
      return new Response(JSON.stringify({ errcode: 0, errmsg: "OK" }));
    }) as typeof fetch,
  });
  await api.notifyProvidedGoods({ orderId: input.orderId, wxOrderId: "wx-order-1", env: 0 });
  assert.equal(requestBody, JSON.stringify({ order_id: input.orderId, env: 0 }));
  const url = new URL(requestUrl);
  assert.equal(url.pathname, "/xpay/notify_provide_goods");
  assert.equal(url.searchParams.get("access_token"), "delivery-token");
  assert.equal(url.searchParams.get("pay_sig"),
    createServerPaySignature("app-key", "/xpay/notify_provide_goods", requestBody));
});

test("notify_provide_goods surfaces a WeChat error code", async () => {
  const api = new WechatVirtualPaymentApi({
    getAccessToken: () => "token", getAppKey: () => "key", apiRoot: "https://wechat.test",
    fetcher: (async () => new Response(JSON.stringify({ errcode: 268490002, errmsg: "pay_sig empty" }))) as typeof fetch,
  });
  await assert.rejects(
    api.notifyProvidedGoods({ orderId: input.orderId, wxOrderId: "wx-order-1", env: 0 }),
    (error: unknown) => error instanceof WechatVirtualPaymentApiError && error.code === 268490002,
  );
});

test("queryRefund confirms only documented full-refund and explicit failure states", async () => {
  const target = {
    openid: "o-user", orderId: "order-123456", wxOrderId: "wx-order-1",
    refundOrderId: "refund-123456", amountCents: 1000, reasonCode: 5 as const, env: 0 as const,
  };
  const query = async (status: number, leftFee: number) => {
    const api = new WechatVirtualPaymentApi({
      getAccessToken: () => "token", getAppKey: () => "key",
      fetcher: (async () => new Response(JSON.stringify({
        errcode: 0, errmsg: "ok", order: {
          order_id: target.orderId, wx_order_id: target.wxOrderId,
          status, order_type: 0, env_type: 1, order_fee: 1000, paid_fee: 1000, left_fee: leftFee,
        },
      }))) as typeof fetch,
    });
    return api.queryRefund(target);
  };
  assert.deepEqual(await query(5, 0), { state: "pending", status: 5 });
  assert.deepEqual(await query(2, 1000), { state: "pending", status: 2 });
  assert.deepEqual(await query(3, 1000), { state: "pending", status: 3 });
  assert.deepEqual(await query(4, 1000), { state: "pending", status: 4 });
  assert.deepEqual(await query(8, 0), { state: "refunded" });
  assert.deepEqual(await query(7, 1000), { state: "failed", code: "STATUS_7" });
  await assert.rejects(query(8, 1), /尚未全额完成/);
  await assert.rejects(query(6, 0), /尚不能确认/);
});
