import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import {
  callbackSignature,
  createServerPaySignature,
  createUserPaymentSignature,
  createDirectGoodsPayment,
  decryptSecureCallback,
  verifyPlaintextCallback,
} from "../server/src/modules/commercial/virtual-payment.js";

const token = "test-token";
const appId = "wx-test-app";
const aesKey = Buffer.from("01234567890123456789012345678901");
const encodingAesKey = aesKey.toString("base64").slice(0, -1);

test("matches WeChat's published server and user signature golden vectors", () => {
  // Exact values copied from WeChat's virtual-payment Python example, retained
  // by TencentCloudBase's official template:
  // https://github.com/TencentCloudBase/awesome-cloudbase-examples/blob/dead77c85ebae5f43bc07c872318a8cb4a1635a9/integration/cloudbase-virtualpay/functions/xpay-common/tests/sign-official.test.js
  // Review provenance: docs/verification/2026-10-24-claude-review-commercial/README.md#问题清单
  const body = '{"openid": "xxx", "user_ip": "127.0.0.1", "env": 0}';
  assert.equal(
    createServerPaySignature("12345", "/xpay/query_user_balance", body),
    "c37809f27c6d7fd1837ad2500a04512b66b34fd793a39a385fade56dca89a4b5",
  );
  assert.equal(
    createUserPaymentSignature("9hAb/NEYUlkaMBEsmFgzig==", body),
    "089d9e8dc5d308977360c4b79ec600a93d736802802a807d634192328032f6c7",
  );
});
const timestamp = "1700000000";
const nonce = "nonce";

// This creates test ciphertext locally. It is deliberately not presented as a
// Tencent-published interoperability vector; official callback vectors remain
// to be added when one is available for the virtual-payment callback format.
function encryptedBody(raw: string, receiver = appId, padding = true) {
  const message = Buffer.concat([randomBytes(16), Buffer.alloc(4), Buffer.from(raw), Buffer.from(receiver)]);
  message.writeUInt32BE(Buffer.byteLength(raw), 16);
  const pad = 32 - (message.length % 32);
  const padded = padding ? Buffer.concat([message, Buffer.alloc(pad, pad)]) : message;
  const cipher = createCipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
  return { encrypted, body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>` };
}

test("direct goods payment serializes server-owned CNY production fields and signs exact JSON bytes", () => {
  const payment = createDirectGoodsPayment({
    offerId: "offer", productId: "item", goodsPrice: 199, outTradeNo: "OrderA12", attach: "opaque",
    appKey: "app-key", sessionKey: "session-key",
  });
  assert.deepEqual(JSON.parse(payment.signData), {
    offerId: "offer", buyQuantity: 1, env: 0, currencyType: "CNY", productId: "item",
    goodsPrice: 199, outTradeNo: "OrderA12", attach: "opaque",
  });
  assert.equal(payment.mode, "short_series_goods");
  assert.equal(payment.paySig, createHmac("sha256", "app-key").update(`requestVirtualPayment&${payment.signData}`).digest("hex"));
  assert.equal(payment.signature, createHmac("sha256", "session-key").update(payment.signData).digest("hex"));
  assert.throws(() => createDirectGoodsPayment({
    offerId: "offer", productId: "item", goodsPrice: 1.2, outTradeNo: "OrderA12", attach: "x", appKey: "a", sessionKey: "s",
  }));
  for (const outTradeNo of ["short", "_startsbad", "too.long.order.number.more.than.thirty.two", "bad space!"])
    assert.throws(() => createDirectGoodsPayment({
      offerId: "offer", productId: "item", goodsPrice: 1, outTradeNo, attach: "x", appKey: "a", sessionKey: "s",
    }));
});

test("plaintext URL callback uses token/timestamp/nonce SHA-1 verification", () => {
  const signature = callbackSignature(token, timestamp, nonce);
  assert.equal(verifyPlaintextCallback({ token, signature, timestamp, nonce }), true);
  assert.equal(verifyPlaintextCallback({ token, signature: signature.toUpperCase(), timestamp, nonce }), true);
  assert.equal(verifyPlaintextCallback({ token, signature, timestamp: "1700000001", nonce }), false);
  assert.equal(verifyPlaintextCallback({ token, signature: "x".repeat(40), timestamp, nonce }), false);
});

test("matches WeChat's published mini-program plaintext callback signatures", () => {
  // First-party fixed vectors, section "开发者服务器接收消息推送":
  // https://developers.weixin.qq.com/miniprogram/dev/framework/server-ability/message-push.html
  assert.equal(callbackSignature("AAAAA", "1714036504", "1514711492"),
    "f464b24fc39322e44b38aa78f5edd27bd1441696");
  assert.equal(callbackSignature("AAAAA", "1714037059", "486452656"),
    "899cf89e464efb63f54ddac96b0a0a235f53aa78");
});

test("secure callback verifies its signature then decrypts strict AES-CBC payload and receiver appId", () => {
  const raw = "<xml><Event><![CDATA[xpay_goods_deliver_notify]]></Event></xml>";
  const { encrypted, body } = encryptedBody(raw);
  const signature = callbackSignature(token, timestamp, nonce, encrypted);
  assert.deepEqual(decryptSecureCallback({ token, encodingAesKey, appId, signature, timestamp, nonce, body }), { raw, format: "xml" });
  const json = '{"event":"unmapped"}';
  const jsonCipher = encryptedBody(json);
  assert.deepEqual(decryptSecureCallback({
    token, encodingAesKey, appId, timestamp, nonce, body: jsonCipher.body,
    signature: callbackSignature(token, timestamp, nonce, jsonCipher.encrypted),
  }), { raw: json, format: "json" });
});

test("decrypts the legacy mirrored WXBizMsgCrypt callback example", () => {
  // Reproduced at the non-Tencent mirror below. A Tencent copyright header is
  // not provenance for the mirror, so this remains only a legacy regression
  // vector and is not counted as first-party interoperability evidence.
  // https://github.com/sbzhu/weworkapi_php/blob/master/callback/Sample.php
  const body = "<xml><ToUserName><![CDATA[wx5823bf96d3bd56c7]]></ToUserName><Encrypt><![CDATA[RypEvHKD8QQKFhvQ6QleEB4J58tiPdvo+rtK1I9qca6aM/wvqnLSV5zEPeusUiX5L5X/0lWfrf0QADHHhGd3QczcdCUpj911L3vg3W/sYYvuJTs3TUUkSUXxaccAS0qhxchrRYt66wiSpGLYL42aM6A8dTT+6k4aSknmPj48kzJs8qLjvd4Xgpue06DOdnLxAUHzM6+kDZ+HMZfJYuR+LtwGc2hgf5gsijff0ekUNXZiqATP7PF5mZxZ3Izoun1s4zG4LUMnvw2r+KqCKIw+3IQH03v+BCA9nMELNqbSf6tiWSrXJB3LAVGUcallcrw8V2t9EL4EhzJWrQUax5wLVMNS0+rUPA3k22Ncx4XXZS9o0MBH27Bo6BpNelZpS+/uh9KsNlY6bHCmJU9p8g7m3fVKn28H3KDYA5Pl/T8Z1ptDAVe0lXdQ2YoyyH2uyPIGHBZZIs2pDBS8R07+qN+E7Q==]]></Encrypt><AgentID><![CDATA[218]]></AgentID></xml>";
  assert.deepEqual(decryptSecureCallback({
    token: "QDG6eK", encodingAesKey: "jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C", appId: "wx5823bf96d3bd56c7", // gitleaks:allow public WXBizMsgCrypt sample vector
    signature: "477715d11cdb4164915debcba66cb864d751f3e6", timestamp: "1409659813", nonce: "1372623149", body,
  }), {
    raw: "<xml><ToUserName><![CDATA[wx5823bf96d3bd56c7]]></ToUserName>\n<FromUserName><![CDATA[mycreate]]></FromUserName>\n<CreateTime>1409659813</CreateTime>\n<MsgType><![CDATA[text]]></MsgType>\n<Content><![CDATA[hello]]></Content>\n<MsgId>4561255354251345929</MsgId>\n<AgentID>218</AgentID>\n</xml>",
    format: "xml",
  });
});

test("decrypts WeChat's published mini-program secure callback ciphertext", () => {
  // Exact cryptographic fields from the same first-party message-push page.
  // The outer JSON envelope is also passed exactly as published.
  const encrypted = "+qdx1OKCy+5JPCBFWw70tm0fJGb2Jmeia4FCB7kao+/Q5c/ohsOzQHi8khUOb05JCpj0JB4RvQMkUyus8TPxLKJGQqcvZqzDpVzazhZv6JsXUnnR8XGT740XgXZUXQ7vJVnAG+tE8NUd4yFyjPy7GgiaviNrlCTj+l5kdfMuFUPpRSrfMZuMcp3Fn2Pede2IuQrKEYwKSqFIZoNqJ4M8EajAsjLY2km32IIjdf8YL/P50F7mStwntrA2cPDrM1kb6mOcfBgRtWygb3VIYnSeOBrebufAlr7F9mFUPAJGj04=";
  const body = `{
    "ToUserName": "gh_97417a04a28d",
    "Encrypt": "${encrypted}"
}`;
  assert.equal(callbackSignature("AAAAA", "1714112445", "415670741", encrypted),
    "046e02f8204d34f8ba5fa3b1db94908f3df2e9b3");
  assert.deepEqual(decryptSecureCallback({
    token: "AAAAA",
    encodingAesKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    appId: "wxba5fad812f8e6fb9",
    signature: "046e02f8204d34f8ba5fa3b1db94908f3df2e9b3",
    timestamp: "1714112445",
    nonce: "415670741",
    body,
  }), {
    raw: '{"ToUserName":"gh_97417a04a28d","FromUserName":"o9AgO5Kd5ggOC-bXrbNODIiE3bGY","CreateTime":1714112445,"MsgType":"event","Event":"debug_demo","debug_str":"hello world"}',
    format: "json",
  });
});

test("secure callback rejects an altered signature, receiver, malformed padding, and XML entity declarations", () => {
  const { encrypted, body } = encryptedBody("<xml><ok>1</ok></xml>");
  const input = { token, encodingAesKey, appId, timestamp, nonce, body, signature: callbackSignature(token, timestamp, nonce, encrypted) };
  assert.throws(() => decryptSecureCallback({ ...input, signature: "0".repeat(40) }));
  const foreign = encryptedBody("<xml/>", "wx-other-app");
  assert.throws(() => decryptSecureCallback({ ...input, body: foreign.body, signature: callbackSignature(token, timestamp, nonce, foreign.encrypted) }));
  const corrupt = Buffer.from(encrypted, "base64");
  corrupt[corrupt.length - 1]! ^= 1;
  const corruptText = corrupt.toString("base64");
  assert.throws(() => decryptSecureCallback({ ...input, body: `<xml><Encrypt>${corruptText}</Encrypt></xml>`, signature: callbackSignature(token, timestamp, nonce, corruptText) }));
  assert.throws(() => decryptSecureCallback({ ...input, body: "<!DOCTYPE x [<!ENTITY x 'boom'>]><xml><Encrypt>x</Encrypt></xml>" }));
  assert.throws(() => decryptSecureCallback({ ...input, body: "<xml><Encrypt>not closed</xml>" }));
});
