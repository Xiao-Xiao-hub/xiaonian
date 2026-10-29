import { createHash } from "node:crypto";
import { DOMParser } from "@xmldom/xmldom";
import { anomalyAcknowledged, anomalyRecorded } from "./anomalies.js";
import type { CommercialOrder, CommercialOrders, VerifiedPayment } from "./orders.js";
import {
  decryptSecureCallback,
  verifyPlaintextCallback,
  CallbackSignatureError,
} from "./virtual-payment.js";

export type PaymentEventFormat = "json" | "xml";
export type GoodsDeliveryEvent = Readonly<{
  orderId: string;
  wxOrderId: string;
  openid: string;
  productId: string;
  amountCents: number;
  env: 0;
  paidAtMs: number;
}>;
type Receiver = Pick<CommercialOrders, "receiveVerifiedPayment">;
type PaymentVerifier = (event: GoodsDeliveryEvent) => Promise<VerifiedPayment>;
export type PaymentCallbackNotice = Readonly<{
  eventKey: string;
  eventType: string;
  outcome: "ignored" | "delivery_error";
  orderId?: string;
  refundId?: string;
  wxOrderId?: string;
  amountCents?: number;
  resultCode?: number;
  failureCode?: string;
}>;
type CallbackObserver = (notice: PaymentCallbackNotice) => void | Promise<void>;

const object = (value: unknown, name: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${name}无效`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, name: string, max = 256) => {
  if (typeof value !== "string" || !value.length || value.length > max)
    throw new TypeError(`${name}无效`);
  return value;
};
const integer = (value: unknown, name: string) => {
  const number = typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(number) || (number as number) < 0)
    throw new TypeError(`${name}无效`);
  return number as number;
};
const optionalText = (value: unknown, max = 128) =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
const optionalInteger = (value: unknown) => {
  const number = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) ? number as number : undefined;
};
const eventKey = (raw: string, format: PaymentEventFormat) =>
  createHash("sha256").update(`${format}\0${raw}`, "utf8").digest("hex");
const failureCode = (error: unknown) => {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
    ? code : error instanceof TypeError ? "CALLBACK_INVALID" : "CALLBACK_FAILED";
};

const xmlObject = (body: string): Record<string, unknown> => {
  if (/<!\s*(doctype|entity)\b/i.test(body)) throw new TypeError("支付通知XML无效");
  let bad = false;
  const document = new DOMParser({
    errorHandler: { warning: () => { bad = true; }, error: () => { bad = true; }, fatalError: () => { bad = true; } },
  }).parseFromString(body, "text/xml");
  if (bad || document.getElementsByTagName("parsererror").length || document.documentElement.tagName !== "xml")
    throw new TypeError("支付通知XML无效");
  const convert = (element: Element): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (let node = element.firstChild; node; node = node.nextSibling) {
      if (node.nodeType !== 1) continue;
      const child = node as Element;
      if (Object.hasOwn(result, child.tagName)) throw new TypeError("支付通知XML字段重复");
      const nested = Array.from({ length: child.childNodes.length }, (_, i) => child.childNodes.item(i))
        .some(item => item?.nodeType === 1);
      result[child.tagName] = nested ? convert(child) : (child.textContent ?? "").trim();
    }
    return result;
  };
  return convert(document.documentElement);
};

const rawEvent = (body: string, format: PaymentEventFormat) => {
  if (typeof body !== "string" || !body.length || Buffer.byteLength(body, "utf8") > 1024 * 1024)
    throw new TypeError("支付通知内容无效");
  if (format === "xml") return xmlObject(body);
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch { throw new TypeError("支付通知JSON无效"); }
  return object(parsed, "支付通知");
};

/** Parse only the documented xpay_goods_deliver_notify delivery fields. */
export function parseGoodsDeliveryEvent(body: string, format: PaymentEventFormat): GoodsDeliveryEvent {
  const event = rawEvent(body, format);
  if (event.MsgType !== "event" || event.Event !== "xpay_goods_deliver_notify")
    throw new TypeError("支付通知事件类型无效");
  const env = integer(event.Env, "支付通知环境");
  if (env !== 0) throw new TypeError("支付通知不是正式环境");
  const payment = object(event.WeChatPayInfo, "微信支付信息");
  const goods = object(event.GoodsInfo, "支付商品信息");
  if (integer(goods.Quantity, "商品数量") !== 1) throw new TypeError("商品数量无效");
  const paidSeconds = integer(payment.PaidTime, "支付时间");
  const paidAtMs = paidSeconds * 1000;
  if (!Number.isSafeInteger(paidAtMs)) throw new TypeError("支付时间无效");
  return Object.freeze({
    orderId: text(event.OutTradeNo, "业务订单号", 128),
    wxOrderId: text(payment.MchOrderNo, "微信平台订单号", 128),
    openid: text(event.OpenId, "支付用户", 128),
    productId: text(goods.ProductId, "商品ID", 128),
    amountCents: integer(goods.ActualPrice, "实付金额"),
    env: 0,
    paidAtMs,
  });
}

export function successAck(format: PaymentEventFormat): string {
  return format === "json"
    ? JSON.stringify({ ErrCode: 0, ErrMsg: "success" })
    : "<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>";
}

const notice = (event: Record<string, unknown>, raw: string, format: PaymentEventFormat): PaymentCallbackNotice => ({
  eventKey: eventKey(raw, format),
  eventType: optionalText(event.Event) ?? "unmapped",
  outcome: "ignored",
  ...(optionalText(event.MchOrderId ?? event.OutTradeNo) ? { orderId: optionalText(event.MchOrderId ?? event.OutTradeNo)! } : {}),
  ...(optionalText(event.MchRefundId) ? { refundId: optionalText(event.MchRefundId)! } : {}),
  ...(optionalText(event.WxOrderId) ? { wxOrderId: optionalText(event.WxOrderId)! } : {}),
  ...(optionalInteger(event.RefundFee) !== undefined ? { amountCents: optionalInteger(event.RefundFee)! } : {}),
  ...(optionalInteger(event.RetCode) !== undefined ? { resultCode: optionalInteger(event.RetCode)! } : {}),
});

async function receiveVerifiedEvent(input: {
  orders: Receiver;
  verifyPayment: PaymentVerifier;
  observe?: CallbackObserver;
  raw: string;
  format: PaymentEventFormat;
  acknowledgement: string;
}): Promise<{ order?: CommercialOrder; acknowledgement: string }> {
  let event: Record<string, unknown>;
  try {
    event = rawEvent(input.raw, input.format);
  } catch {
    // The signature is already verified. Structurally unusable notifications
    // cannot become actionable by retrying, so record/ACK instead of 500.
    await input.observe?.({
      eventKey: eventKey(input.raw, input.format),
      eventType: "unmapped",
      outcome: "ignored",
      failureCode: "CALLBACK_BODY_INVALID",
    });
    return { acknowledgement: input.acknowledgement };
  }
  const meta = notice(event, input.raw, input.format);
  if (meta.eventType !== "xpay_goods_deliver_notify") {
    // Non-delivery events are notifications, not fulfillment authority. The
    // observer records them and may actively query a known refund; its failure
    // is deliberately contained so WeChat does not retry forever with 500s.
    try { await input.observe?.(meta); } catch { /* recorded by the runtime when possible */ }
    return { acknowledgement: input.acknowledgement };
  }
  try {
    const receipt = await input.verifyPayment(parseGoodsDeliveryEvent(input.raw, input.format));
    const order = input.orders.receiveVerifiedPayment(receipt);
    return { order, acknowledgement: input.acknowledgement };
  } catch (error) {
    // Recorded and not retryable (an amount mismatch): acknowledge, no re-push.
    if (anomalyAcknowledged(error)) return { acknowledgement: input.acknowledgement };
    // The query-order step records its own failure; one failure, one anomaly.
    if (anomalyRecorded(error)) throw error;
    try {
      await input.observe?.({ ...meta, outcome: "delivery_error", failureCode: failureCode(error) });
    } catch { /* preserve the original delivery failure for platform retry */ }
    throw error;
  }
}

export async function receivePlaintextGoodsDelivery(input: {
  orders: Receiver;
  verifyPayment: PaymentVerifier;
  token: string;
  signature: string;
  timestamp: string;
  nonce: string;
  body: string;
  format: PaymentEventFormat;
  observe?: CallbackObserver;
}): Promise<{ order?: CommercialOrder; acknowledgement: string }> {
  // No freshness window: a signed replay cannot deliver twice (fulfillment is
  // idempotent and re-verified by query_order), while rejecting a late push
  // would leave WeChat without a success ACK for a paid order.
  if (!verifyPlaintextCallback(input)) throw new CallbackSignatureError();
  return receiveVerifiedEvent({ ...input, raw: input.body, acknowledgement: successAck(input.format) });
}

export async function receiveSecureGoodsDelivery(input: {
  orders: Receiver;
  verifyPayment: PaymentVerifier;
  token: string;
  encodingAesKey: string;
  appId: string;
  signature: string;
  timestamp: string;
  nonce: string;
  body: string;
  format: PaymentEventFormat;
  observe?: CallbackObserver;
}): Promise<{ order?: CommercialOrder; acknowledgement: string }> {
  const decrypted = decryptSecureCallback(input);
  if (decrypted.format !== input.format) throw new TypeError("支付通知格式与配置不一致");
  // Message push accepts a plain "success" without encryption in secure mode;
  // any other reply body would have to be encrypted.
  return receiveVerifiedEvent({ ...input, raw: decrypted.raw, acknowledgement: "success" });
}
