/*
 * 登录与隐私授权：协调微信登录、开发身份、服务端会话及当前隐私版本。
 * 供 gate、api 和页面调用；异步登录结束时必须核对原账号和授权状态，不能覆盖新的会话。
 */
const config = require("./config");
const { request, envVersion } = require("./request");
const session = require("./session");
const gate = require("./gate");
let pending;
let syncing;
let generation = 0;
function getUser() {
  const s = session.getSession();
  return s ? s.user : null;
}
// Agreed to the current documents and picked an age band (gate.state "ok").
// Pages not yet moved to gate.js keep calling this.
function hasConsent() {
  return gate.state() === "ok";
}
// age: "adult" (已满14岁) or "child" (监护人同意). Agreeing leaves guest mode.
// synced: false until PUT /v1/me/consent has saved it on the account; while
// so, login saves it first, so no other request goes out before the server
// knows the age band (a child's protections follow the server).
function recordConsent(age = "adult", synced = true) {
  wx.setStorageSync(gate.CONSENT_KEY, {
    v: config.PRIVACY_VERSION,
    age,
    at: new Date().toISOString(),
    synced,
  });
  wx.removeStorageSync(gate.GUEST_KEY);
}
function clearConsent() {
  generation++;
  pending = undefined;
  syncing = undefined;
  wx.removeStorageSync(gate.CONSENT_KEY);
}
// Only an explicit false: records written before the flag count as saved.
function unsynced() {
  const value = gate.consent();
  return Boolean(value && value.synced === false);
}
// 不同意 and 游客模式: no login, nothing saved, no AI. An old session stays on
// this phone so the privacy page can still export, revoke or delete (隐私政策 10.4).
function enterGuest() {
  clearConsent();
  wx.setStorageSync(gate.GUEST_KEY, "1");
}
function consentGeneration() {
  return generation;
}
const consentRequired = () =>
  Object.assign(new Error("先同意用户协议和隐私政策，就能接着用"), {
    code: "CONSENT_REQUIRED",
  });
const guestMode = () =>
  Object.assign(new Error("游客模式不保存、不用 AI，同意后就能用"), {
    code: "GUEST_MODE",
  });
const notReady = () =>
  gate.state() === "guest" ? guestMode() : consentRequired();
// 隐私政策改版后，旧会话仍可导出、注销和撤回授权，不必先同意新版。
function signedIn() {
  return Boolean(session.getSession());
}
function platformConsent() {
  if (typeof wx.getPrivacySetting !== "function")
    return Promise.reject(new Error("请升级微信以完成隐私授权"));
  // 真实入口由欢迎页原生 agreePrivacyAuthorization 按钮触发；不调用可能等待 resolver 的 requirePrivacyAuthorize。
  // 微信要求重新授权时清除本地同意记录，下次进来回到欢迎页。
  return new Promise((resolve, reject) =>
    wx.getPrivacySetting({
      success: (value) => {
        if (!value.needAuthorization) return resolve();
        clearConsent();
        reject(consentRequired());
      },
      fail: () =>
        reject(new Error("无法确认微信隐私授权，请检查隐私指引配置后重试")),
    }),
  );
}
function wechatCode() {
  return new Promise((resolve, reject) =>
    wx.login({
      success: (value) =>
        value.code
          ? resolve(value.code)
          : reject(new Error("微信未返回登录凭证")),
      fail: () => reject(new Error("微信登录失败，请重试")),
    }),
  );
}
// 开发版且服务端开启开发登录时用固定的开发身份；其余情况一律走微信登录。
function exchange(stillCurrent) {
  const develop = envVersion() === "develop";
  return (
    develop ? request({ url: "/v1/config" }) : Promise.resolve(null)
  ).then((settings) => {
    stillCurrent();
    return settings && settings.data && settings.data.devLogin
      ? request({
          url: "/v1/auth/dev-login",
          method: "POST",
          data: { key: config.DEV_LOGIN_KEY },
        })
      : wechatCode().then((code) => {
          stillCurrent();
          return request({
            url: "/v1/auth/wechat-login",
            method: "POST",
            data: { code },
          });
        });
  });
}
// Only once the documents are agreed and an age band is picked (gate "ok").
// Otherwise it rejects with CONSENT_REQUIRED, or GUEST_MODE for a guest, and
// never reaches wx.login. An agreement not yet saved on the account is saved
// first, however the welcome page was left last time.
function login() {
  if (!hasConsent()) return Promise.reject(notReady());
  if (unsynced()) return syncConsent().then((done) => done.user);
  return signIn();
}
function signIn() {
  const current = session.getSession();
  if (current) return Promise.resolve(current.user);
  const startedGeneration = generation;
  if (pending && pending.generation === startedGeneration)
    return pending.promise;
  const stillCurrent = () => {
    if (generation !== startedGeneration || !hasConsent()) throw notReady();
  };
  const promise = platformConsent()
    .then(() => {
      stillCurrent();
      return exchange(stillCurrent);
    })
    .then(({ data }) => {
      stillCurrent();
      if (!data || !data.token || !data.user || !data.expiresAt)
        throw new Error("登录响应格式异常");
      session.setSession(data);
      return data.user;
    })
    .finally(() => {
      if (pending && pending.promise === promise) pending = undefined;
    });
  pending = { generation: startedGeneration, promise };
  return promise;
}
// Saves the agreement on the account (PUT /v1/me/consent) with the age band
// picked on this phone; a child's comes with the guardian's consent. An expired
// login (401) signs in again once. Marked synced only when the record on this
// phone is still the one sent.
function pushConsent(value, started, retried) {
  const data = { version: value.v, ageBand: value.age };
  if (value.age === "child") data.guardian = true;
  return request({ url: "/v1/me/consent", method: "PUT", data, auth: true })
    .catch((error) => {
      if (retried || !error || error.statusCode !== 401) throw error;
      if (generation !== started) throw notReady();
      return signIn().then(() => pushConsent(value, started, true));
    })
    .then((body) => {
      if (retried) return body;
      const latest = gate.consent();
      if (
        generation === started &&
        latest &&
        latest.v === value.v &&
        latest.age === value.age &&
        latest.at === value.at
      )
        wx.setStorageSync(gate.CONSENT_KEY, { ...latest, synced: true });
      return body;
    });
}
function syncConsent() {
  const started = generation;
  if (syncing && syncing.generation === started) return syncing.promise;
  const value = gate.consent();
  const promise = signIn()
    .then((user) => {
      if (generation !== started) throw notReady();
      return pushConsent(value, started).then((body) => ({
        user,
        data: body && body.data,
      }));
    })
    .finally(() => {
      if (syncing && syncing.promise === promise) syncing = undefined;
    });
  syncing = { generation: started, promise };
  return promise;
}
function saveConsent() {
  const value = gate.consent();
  if (!value) return Promise.reject(notReady());
  if (value.synced === false) return syncConsent().then((done) => done.data);
  const started = generation;
  return signIn()
    .then(() => pushConsent(value, started))
    .then((body) => body && body.data);
}
// On launch: an agreement left unsaved last time is saved now. Failing quietly
// is fine, the next request tries again through login.
function syncPending() {
  if (hasConsent() && unsynced()) login().catch(() => {});
}
async function logout() {
  const current = session.getSession();
  try {
    if (current)
      await request({ url: "/v1/auth/logout", method: "POST", auth: true });
  } finally {
    const latest = session.getSession();
    if (!latest || (current && latest.token === current.token))
      session.clearSession();
  }
}
module.exports = {
  getUser,
  signedIn,
  login,
  logout,
  hasConsent,
  recordConsent,
  clearConsent,
  enterGuest,
  saveConsent,
  syncPending,
  consentGeneration,
};
