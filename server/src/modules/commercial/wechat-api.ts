import type { VerifiedPayment } from "./orders.js";
import type { RefundAdapter, RefundQueryAdapter } from "./refunds.js";
import { createServerPaySignature } from "./virtual-payment.js";

const QUERY_ORDER_PATH = "/xpay/query_order";
const REFUND_ORDER_PATH = "/xpay/refund_order";
const NOTIFY_PROVIDE_GOODS_PATH = "/xpay/notify_provide_goods";
const ORDER_NUMBER = /^(?!_)[A-Za-z0-9_\-*@]{8,32}$/;
const MAX_BODY_BYTES = 1024 * 1024;
const HTTP_TIMEOUT_MS = 15_000;
const STATUSES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const ORDER_TYPES = new Set([0, 1, 7, 8]);

const object = (value: unknown, name: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${name}无效`);
  return value as Record<string, unknown>;
};
const string = (value: unknown, name: string, max = 256) => {
  if (typeof value !== "string" || !value.length || value.length > max)
    throw new TypeError(`${name}无效`);
  return value;
};
const integer = (value: unknown, name: string) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${name}无效`);
  return value as number;
};
const signedInteger = (value: unknown, name: string) => {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name}无效`);
  return value as number;
};

export class WechatVirtualPaymentApiError extends Error {
  constructor(public readonly code: number, message: string) {
    super(`微信虚拟支付接口失败(${code}): ${message}`);
    this.name = "WechatVirtualPaymentApiError";
  }
}

/** WeChat reported fees that do not match the local order. Not retryable: the
 * callback acknowledges it once recorded instead of making WeChat re-push. */
export class PaymentAmountMismatchError extends TypeError {
  readonly code = "PAYMENT_AMOUNT_MISMATCH";
  constructor(message: string) {
    super(message);
    this.name = "PaymentAmountMismatchError";
  }
}
/** One rule for query_order, refund query and the delivery push: what was
 * paid equals the order amount; the order fee is that amount or, for a plan
 * upgrade charged through activitySellingPrice, the good's list price. */
export const feesMatch = (
  input: Readonly<{ amountCents: number; listPriceCents?: number }>,
  paidFee: number,
  orderFee?: number,
) => paidFee === input.amountCents &&
  (orderFee === undefined || orderFee === input.amountCents ||
    (input.listPriceCents !== undefined && orderFee === input.listPriceCents));

export type QueryPaymentInput = {
  openid: string;
  orderId: string;
  env: 0;
  productId: string;
  amountCents: number;
  /** Plan upgrades only: the good's list price, which WeChat may report as
   * order_fee while paid_fee is the discounted amountCents. */
  listPriceCents?: number;
};

export type QueryPaymentResult =
  | { state: "pending"; status: number; orderType: number }
  | { state: "paid"; status: 2 | 3 | 4; receipt: VerifiedPayment };

export type RefundOrderInput = {
  openid: string;
  orderId: string;
  wxOrderId: string;
  refundOrderId: string;
  amountCents: number;
  reasonCode: 0 | 1 | 2 | 3 | 4 | 5;
  env: 0;
  /** Plan upgrades only, as in QueryPaymentInput. */
  listPriceCents?: number;
};
export type RefundOrderResult =
  | { state: "accepted" }
  | { state: "failed"; code: number };
export type RefundStatusResult =
  | { state: "pending"; status: 2 | 3 | 4 | 5 }
  | { state: "refunded" }
  | { state: "failed"; code: "STATUS_7" };

export type NotifyProvidedGoodsInput = Readonly<{
  orderId: string;
  wxOrderId: string;
  env: 0;
}>;

type ApiOptions = {
  getAccessToken: () => string | Promise<string>;
  getAppKey: () => string | Promise<string>;
  fetcher?: typeof fetch;
  apiRoot?: string;
};

/**
 * Minimal server-side client for the official xpay query-order endpoint.
 * Secrets are obtained only at request time and are never retained or placed
 * in error details. Importing this module performs no network request.
 */
export class WechatVirtualPaymentApi implements RefundAdapter, RefundQueryAdapter {
  private readonly fetcher: typeof fetch;
  private readonly apiRoot: string;

  constructor(private readonly options: ApiOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.apiRoot = options.apiRoot ?? "https://api.weixin.qq.com";
  }

  async queryVerifiedPayment(input: QueryPaymentInput): Promise<QueryPaymentResult> {
    string(input.openid, "openid", 128);
    if (!ORDER_NUMBER.test(input.orderId)) throw new TypeError("业务订单号无效");
    if (input.env !== 0) throw new TypeError("支付环境无效");
    string(input.productId, "商品ID", 128);
    if (integer(input.amountCents, "订单金额") === 0) throw new TypeError("订单金额无效");

    const accessToken = string(await this.options.getAccessToken(), "access_token", 4096);
    const appKey = string(await this.options.getAppKey(), "AppKey", 4096);
    // The exact bytes below are both signed and sent. Re-serializing would
    // invalidate pay_sig.
    const body = JSON.stringify({ openid: input.openid, env: input.env, order_id: input.orderId });
    const paySig = createServerPaySignature(appKey, QUERY_ORDER_PATH, body);
    const url = new URL(QUERY_ORDER_PATH, this.apiRoot);
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("pay_sig", paySig);
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) throw new WechatVirtualPaymentApiError(response.status, "HTTP响应异常");
    const text = await response.text();
    if (!text.length || Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES)
      throw new TypeError("微信查单响应无效");
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch { throw new TypeError("微信查单响应不是JSON"); }
    return this.parseQueryResponse(raw, input);
  }

  /** Starts the official asynchronous full-refund task. errcode=0 is only an
   * acceptance signal; callers must confirm status with query_order later. */
  async refundOrder(input: RefundOrderInput): Promise<RefundOrderResult> {
    string(input.openid, "openid", 128);
    if (!ORDER_NUMBER.test(input.orderId) || !ORDER_NUMBER.test(input.refundOrderId))
      throw new TypeError("退款订单号无效");
    string(input.wxOrderId, "微信订单号", 128);
    if (input.env !== 0) throw new TypeError("退款环境无效");
    if (integer(input.amountCents, "退款金额") === 0) throw new TypeError("退款金额无效");
    if (!Number.isInteger(input.reasonCode) || input.reasonCode < 0 || input.reasonCode > 5)
      throw new TypeError("退款原因类型无效");
    const accessToken = string(await this.options.getAccessToken(), "access_token", 4096);
    const appKey = string(await this.options.getAppKey(), "AppKey", 4096);
    const body = JSON.stringify({
      openid: input.openid,
      order_id: input.orderId,
      refund_order_id: input.refundOrderId,
      left_fee: input.amountCents,
      refund_fee: input.amountCents,
      biz_meta: input.refundOrderId,
      refund_reason: String(input.reasonCode),
      req_from: "1",
      env: input.env,
    });
    const paySig = createServerPaySignature(appKey, REFUND_ORDER_PATH, body);
    const url = new URL(REFUND_ORDER_PATH, this.apiRoot);
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("pay_sig", paySig);
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) throw new WechatVirtualPaymentApiError(response.status, "HTTP响应异常");
    const text = await response.text();
    if (!text.length || Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES)
      throw new TypeError("微信退款响应无效");
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch { throw new TypeError("微信退款响应不是JSON"); }
    const result = object(raw, "微信退款响应");
    const errcode = signedInteger(result.errcode, "微信错误码");
    return errcode === 0 ? { state: "accepted" } : { state: "failed", code: errcode };
  }

  /** Tells WeChat that a cash order fulfilled by query-order compensation is
   * delivered. A successful payment callback ACK already does this, so this
   * endpoint is used only by the compensation path. Like the other xpay
   * server APIs it needs pay_sig; without it WeChat answers 268490002
   * (verified in production 2026-10-24 with exactly this body). */
  async notifyProvidedGoods(input: NotifyProvidedGoodsInput): Promise<void> {
    if (!ORDER_NUMBER.test(input.orderId)) throw new TypeError("业务订单号无效");
    string(input.wxOrderId, "微信订单号", 128);
    if (input.env !== 0) throw new TypeError("支付环境无效");
    const accessToken = string(await this.options.getAccessToken(), "access_token", 4096);
    const appKey = string(await this.options.getAppKey(), "AppKey", 4096);
    // order_id and wx_order_id are alternatives; send only our own number.
    const body = JSON.stringify({ order_id: input.orderId, env: input.env });
    const paySig = createServerPaySignature(appKey, NOTIFY_PROVIDE_GOODS_PATH, body);
    const url = new URL(NOTIFY_PROVIDE_GOODS_PATH, this.apiRoot);
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("pay_sig", paySig);
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) throw new WechatVirtualPaymentApiError(response.status, "HTTP响应异常");
    const text = await response.text();
    if (!text.length) return;
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES)
      throw new TypeError("微信发货确认响应无效");
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch { throw new TypeError("微信发货确认响应不是JSON"); }
    const result = object(raw, "微信发货确认响应");
    const errcode = signedInteger(result.errcode, "微信错误码");
    if (errcode === 0) return;
    const errmsg = typeof result.errmsg === "string" ? result.errmsg.slice(0, 256) : "未知错误";
    throw new WechatVirtualPaymentApiError(errcode, errmsg);
  }

  /** Confirms only official full-refund states for the original Android order.
   * Ambiguous/closed states throw so the local hold remains pending for review. */
  async queryRefund(input: RefundOrderInput): Promise<RefundStatusResult> {
    string(input.openid, "openid", 128);
    if (!ORDER_NUMBER.test(input.orderId)) throw new TypeError("业务订单号无效");
    string(input.wxOrderId, "微信订单号", 128);
    if (input.env !== 0) throw new TypeError("退款环境无效");
    if (integer(input.amountCents, "退款金额") === 0) throw new TypeError("退款金额无效");
    const accessToken = string(await this.options.getAccessToken(), "access_token", 4096);
    const appKey = string(await this.options.getAppKey(), "AppKey", 4096);
    const body = JSON.stringify({ openid: input.openid, env: input.env, order_id: input.orderId });
    const paySig = createServerPaySignature(appKey, QUERY_ORDER_PATH, body);
    const url = new URL(QUERY_ORDER_PATH, this.apiRoot);
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("pay_sig", paySig);
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) throw new WechatVirtualPaymentApiError(response.status, "HTTP响应异常");
    const text = await response.text();
    if (!text.length || Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES)
      throw new TypeError("微信退款查单响应无效");
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch { throw new TypeError("微信退款查单响应不是JSON"); }
    const result = object(raw, "微信退款查单响应");
    const errcode = signedInteger(result.errcode, "微信错误码");
    const errmsg = typeof result.errmsg === "string" ? result.errmsg.slice(0, 256) : "未知错误";
    if (errcode !== 0) throw new WechatVirtualPaymentApiError(errcode, errmsg);
    const order = object(result.order, "微信订单");
    if (string(order.order_id, "微信订单业务号", 128) !== input.orderId ||
        string(order.wx_order_id, "微信平台订单号", 128) !== input.wxOrderId)
      throw new TypeError("微信退款查单订单号不匹配");
    if (integer(order.order_type, "微信订单类型") !== 0 || integer(order.env_type, "微信订单环境") !== 1)
      throw new TypeError("微信退款查单平台或环境不匹配");
    if (!feesMatch(input, integer(order.paid_fee, "微信实付金额"), integer(order.order_fee, "微信订单金额")))
      throw new PaymentAmountMismatchError("微信退款查单金额不匹配");
    const leftFee = integer(order.left_fee, "微信订单剩余可退金额");
    if (leftFee > input.amountCents) throw new TypeError("微信退款查单余额无效");
    const status = integer(order.status, "微信订单状态");
    if (status === 8) {
      if (leftFee !== 0) throw new TypeError("微信退款尚未全额完成");
      return { state: "refunded" };
    }
    if (status === 7) {
      if (leftFee !== input.amountCents) throw new TypeError("微信退款失败余额不匹配");
      return { state: "failed", code: "STATUS_7" };
    }
    if (status === 5) return { state: "pending", status };
    if ((status === 2 || status === 3 || status === 4) && leftFee === input.amountCents)
      return { state: "pending", status };
    throw new TypeError("微信退款状态尚不能确认");
  }

  private parseQueryResponse(raw: unknown, input: QueryPaymentInput): QueryPaymentResult {
    const response = object(raw, "微信查单响应");
    const errcode = signedInteger(response.errcode, "微信错误码");
    const errmsg = typeof response.errmsg === "string" ? response.errmsg.slice(0, 256) : "未知错误";
    if (errcode !== 0) throw new WechatVirtualPaymentApiError(errcode, errmsg);
    const order = object(response.order, "微信订单");
    if (string(order.order_id, "微信订单业务号", 128) !== input.orderId)
      throw new TypeError("微信查单订单号不匹配");
    const status = integer(order.status, "微信订单状态");
    if (!STATUSES.has(status)) throw new TypeError("微信订单状态未知");
    const orderType = integer(order.order_type, "微信订单类型");
    if (!ORDER_TYPES.has(orderType)) throw new TypeError("微信订单类型未知");
    // Official query_order defines 2 as paid/awaiting delivery, 3 as delivery
    // in progress, and 4 as delivered. All three prove payment; treating 3 as
    // pending would strand the exact callback currently being fulfilled.
    if (status !== 2 && status !== 3 && status !== 4)
      return { state: "pending", status, orderType };
    if (orderType !== 0 && orderType !== 7)
      throw new TypeError("退款单不能作为支付凭证");
    // The local order contract is production-only (env=0). The query API
    // reports that environment as env_type=1; sandbox receipts must never be
    // normalized into a production VerifiedPayment.
    if (integer(order.env_type, "微信订单环境") !== 1)
      throw new TypeError("微信查单环境不匹配");
    const orderFee = integer(order.order_fee, "微信订单金额");
    const paidFee = integer(order.paid_fee, "微信实付金额");
    if (!feesMatch(input, paidFee, orderFee))
      throw new PaymentAmountMismatchError("微信查单金额不匹配");
    const paidSeconds = integer(order.paid_time, "微信支付时间");
    const paidAtMs = paidSeconds * 1000;
    if (!Number.isSafeInteger(paidAtMs)) throw new TypeError("微信支付时间无效");
    const wxOrderId = string(order.wx_order_id, "微信平台订单号", 128);
    return {
      state: "paid",
      status,
      receipt: {
        orderId: input.orderId,
        wxOrderId,
        openid: input.openid,
        productId: input.productId,
        amountCents: input.amountCents,
        platform: orderType === 7 ? "ios" : "android",
        env: 0,
        paidAtMs,
      },
    };
  }
}
