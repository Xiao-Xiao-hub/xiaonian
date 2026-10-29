const api = require("../../utils/api");
const auth = require("../../utils/auth");
const session = require("../../utils/session");
const randomKey = () =>
  `pay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
const owner = () => (auth.getUser() || {}).id || "";
// Plan upgrades are Android-only; the server decides from this value.
const devicePlatform = () => {
  try {
    return String(wx.getSystemInfoSync().platform || "").toLowerCase();
  } catch (_) {
    return "";
  }
};
const current = (state) =>
  state.generation === auth.consentGeneration() && state.owner === owner();
const unavailable = () =>
  typeof wx.requestVirtualPayment !== "function" ||
  (typeof wx.canIUse === "function" && !wx.canIUse("requestVirtualPayment"));
function ensureSession() {
  return new Promise((resolve, reject) =>
    wx.checkSession({ success: resolve, fail: reject }),
  ).catch(() => {
    session.clearSession();
    return auth.login();
  });
}
function nativePay(payment) {
  if (unavailable() || typeof wx.requestVirtualPayment !== "function")
    return Promise.reject(
      new Error("当前微信版本暂不支持购买，请升级微信后重试"),
    );
  return new Promise((resolve, reject) =>
    wx.requestVirtualPayment({
      mode: payment.mode,
      signData: payment.signData,
      paySig: payment.paySig,
      signature: payment.signature,
      success: resolve,
      fail: reject,
    }),
  );
}
async function purchase(productId, purchase, key = randomKey()) {
  if (unavailable())
    throw new Error("当前微信版本暂不支持购买，请升级微信后重试");
  const state = { owner: owner(), generation: auth.consentGeneration() };
  const platform = devicePlatform();
  const body = {
    productId,
    idempotencyKey: key,
    purchase,
    ...(platform ? { platform } : {}),
  };
  await ensureSession();
  if (!current(state)) throw new Error("账号已切换，请重新选择商品");
  let result;
  try {
    result = await api.post("/v1/commercial/orders", body);
  } catch (error) {
    if (error && error.code === "WECHAT_SESSION_REFRESH") {
      session.clearSession();
      await auth.login();
      if (!current(state)) throw new Error("账号已切换，请重新选择商品");
      result = await api.post("/v1/commercial/orders", body);
    } else throw error;
  }
  if (!current(state)) throw new Error("账号已切换，请到订单中查看");
  await nativePay(result.payment);
  if (!current(state)) throw new Error("账号已切换，请到订单中查看");
  return { order: result.order, idempotencyKey: key };
}
module.exports = { purchase, randomKey, ensureSession, nativePay };
