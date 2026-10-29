import {
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { DOMParser } from "@xmldom/xmldom";

const ORDER_NUMBER = /^(?!_)[A-Za-z0-9_\-*@]{8,32}$/;
const SHA1_HEX = /^[a-f0-9]{40}$/i;
const decoder = new TextDecoder("utf-8", { fatal: true });

export class CallbackSignatureError extends TypeError {
  constructor() { super("支付通知签名无效"); }
}

export type DirectGoodsPayment = {
  offerId: string;
  productId: string;
  goodsPrice: number;
  /** Discounted actual price in cents (a plan upgrade); must be below goodsPrice. */
  activitySellingPrice?: number;
  outTradeNo: string;
  attach: string;
  appKey: string;
  sessionKey: string;
};

export type VirtualPaymentPayload = {
  mode: "short_series_goods";
  signData: string;
  paySig: string;
  signature: string;
};

const nonEmpty = (value: string, name: string) => {
  if (typeof value !== "string" || !value.length) throw new TypeError(`${name}不能为空`);
  return value;
};

const hmac = (key: string, text: string) =>
  createHmac("sha256", key).update(text, "utf8").digest("hex");

/** Official server-side xpay signature. `body` must be the exact bytes sent. */
export function createServerPaySignature(appKey: string, uri: string, body: string) {
  nonEmpty(appKey, "appKey");
  if (!/^\/xpay\/[a-z_]+$/.test(uri)) throw new TypeError("支付接口路径无效");
  if (typeof body !== "string" || !body.length) throw new TypeError("支付请求内容无效");
  return hmac(appKey, `${uri}&${body}`);
}

/** Official user-state signature over the exact request body/signData bytes. */
export function createUserPaymentSignature(sessionKey: string, body: string) {
  nonEmpty(sessionKey, "sessionKey");
  if (typeof body !== "string" || !body.length) throw new TypeError("支付签名内容无效");
  return hmac(sessionKey, body);
}

/** Creates the exact JSON bytes passed to wx.requestVirtualPayment. Do not parse
 * and serialize signData again on the client: both HMACs cover these bytes. */
export function createDirectGoodsPayment(input: DirectGoodsPayment): VirtualPaymentPayload {
  nonEmpty(input.offerId, "offerId");
  nonEmpty(input.productId, "productId");
  nonEmpty(input.attach, "attach");
  nonEmpty(input.appKey, "appKey");
  nonEmpty(input.sessionKey, "sessionKey");
  if (!ORDER_NUMBER.test(input.outTradeNo)) throw new RangeError("订单号必须为8至32位允许字符且不能以下划线开头");
  if (!Number.isSafeInteger(input.goodsPrice) || input.goodsPrice <= 0) throw new RangeError("道具价格必须是正整数分");
  if (input.activitySellingPrice !== undefined &&
      (!Number.isSafeInteger(input.activitySellingPrice) || input.activitySellingPrice <= 0 ||
       input.activitySellingPrice >= input.goodsPrice))
    throw new RangeError("道具优惠价必须是低于道具价格的正整数分");
  const signData = JSON.stringify({
    offerId: input.offerId,
    buyQuantity: 1,
    env: 0,
    currencyType: "CNY",
    productId: input.productId,
    goodsPrice: input.goodsPrice,
    ...(input.activitySellingPrice !== undefined ? { activitySellingPrice: input.activitySellingPrice } : {}),
    outTradeNo: input.outTradeNo,
    attach: input.attach,
  });
  return {
    mode: "short_series_goods",
    signData,
    paySig: hmac(input.appKey, `requestVirtualPayment&${signData}`),
    signature: createUserPaymentSignature(input.sessionKey, signData),
  };
}

/** The signature used for callback URL verification (every mode) and plaintext pushes. */
export function callbackSignature(token: string, ...parts: string[]) {
  nonEmpty(token, "token");
  if (!parts.length || parts.some((part) => typeof part !== "string" || !part.length))
    throw new CallbackSignatureError();
  return createHash("sha1").update([token, ...parts].sort().join(""), "utf8").digest("hex");
}

const equalHex = (actual: string, expected: string) =>
  SHA1_HEX.test(actual) && timingSafeEqual(Buffer.from(actual.toLowerCase()), Buffer.from(expected));

export function verifyPlaintextCallback(input: { token: string; signature: string; timestamp: string; nonce: string }) {
  return equalHex(input.signature, callbackSignature(input.token, input.timestamp, input.nonce));
}

const aesKey = (encodingAesKey: string) => {
  if (typeof encodingAesKey !== "string" || !/^[A-Za-z0-9+/]{43}$/.test(encodingAesKey))
    throw new TypeError("EncodingAESKey无效");
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32) throw new TypeError("EncodingAESKey无效");
  return key;
};

const encryptedEnvelope = (body: string) => {
  if (typeof body !== "string" || !body.length || Buffer.byteLength(body, "utf8") > 1024 * 1024)
    throw new TypeError("加密消息无效");
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    let value: unknown;
    try { value = JSON.parse(body); }
    catch { throw new TypeError("加密消息JSON无效"); }
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new TypeError("加密消息JSON无效");
    const encrypted = (value as Record<string, unknown>).Encrypt;
    if (typeof encrypted !== "string" || !encrypted.length)
      throw new TypeError("加密消息缺少Encrypt");
    return encrypted;
  }
  // xmldom does not fetch external resources, and reject declarations before
  // parsing so this callback path has no entity-expansion surface.
  if (typeof body !== "string" || /<!\s*(doctype|entity)\b/i.test(body)) throw new TypeError("加密消息XML无效");
  let parserError = false;
  const document = new DOMParser({
    errorHandler: {
      warning: () => { parserError = true; },
      error: () => { parserError = true; },
      fatalError: () => { parserError = true; },
    },
  }).parseFromString(body, "text/xml");
  if (parserError || document.getElementsByTagName("parsererror").length)
    throw new TypeError("加密消息XML无效");
  const values = document.getElementsByTagName("Encrypt");
  if (values.length !== 1) throw new TypeError("加密消息缺少Encrypt");
  const encrypted = values[0]!.textContent?.trim() ?? "";
  if (!encrypted) throw new TypeError("加密消息缺少Encrypt");
  return encrypted;
};

const unpad = (buffer: Buffer) => {
  if (!buffer.length || buffer.length % 16) throw new TypeError("加密消息填充无效");
  const padding = buffer.at(-1)!;
  // Official WXBizMsgCrypt uses PKCS#7 with a 32-byte block size.
  if (padding < 1 || padding > 32 || padding > buffer.length) throw new TypeError("加密消息填充无效");
  for (const byte of buffer.subarray(buffer.length - padding)) if (byte !== padding) throw new TypeError("加密消息填充无效");
  return buffer.subarray(0, buffer.length - padding);
};

/**
 * Verifies a secure callback and returns only its decrypted raw payload. Order
 * delivery fields intentionally remain unmapped until the next module owns
 * their platform-specific schema.
 */
const decryptSecureValue = (input: {
  token: string; encodingAesKey: string; appId: string; signature: string;
  timestamp: string; nonce: string; body: string;
}) => {
  nonEmpty(input.appId, "appId");
  const encrypted = encryptedEnvelope(input.body);
  if (!equalHex(input.signature, callbackSignature(input.token, input.timestamp, input.nonce, encrypted)))
    throw new CallbackSignatureError();
  const key = aesKey(input.encodingAesKey);
  let ciphertext: Buffer;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encrypted))
    throw new TypeError("加密消息无效");
  try { ciphertext = Buffer.from(encrypted, "base64"); }
  catch { throw new TypeError("加密消息无效"); }
  if (!ciphertext.length || ciphertext.length % 16) throw new TypeError("加密消息无效");
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  let plain: Buffer;
  try { plain = unpad(Buffer.concat([decipher.update(ciphertext), decipher.final()])); }
  catch { throw new TypeError("加密消息解密失败"); }
  if (plain.length < 20) throw new TypeError("加密消息长度无效");
  const length = plain.readUInt32BE(16);
  if (length > plain.length - 20) throw new TypeError("加密消息长度无效");
  const raw = decoder.decode(plain.subarray(20, 20 + length));
  const appId = decoder.decode(plain.subarray(20 + length));
  if (appId !== input.appId) throw new TypeError("加密消息AppID不匹配");
  return raw;
};

export function decryptSecureCallback(input: {
  token: string; encodingAesKey: string; appId: string; signature: string;
  timestamp: string; nonce: string; body: string;
}): { raw: string; format: "xml" | "json" } {
  const raw = decryptSecureValue(input);
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("<")) return { raw, format: "xml" };
  try { JSON.parse(raw); } catch { throw new TypeError("加密消息内容不是XML或JSON"); }
  return { raw, format: "json" };
}
