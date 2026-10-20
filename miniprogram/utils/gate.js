/*
 * 页面访问门槛：区分游客、已授权和需重新授权状态，并打开统一同意入口。
 * 只控制前端交互；服务端仍须独立鉴权，不能把按钮隐藏当成权限控制。
 */
// Who may use what. Read-only on purpose:
// writing consent or guest mode lives in utils/auth.js, so this file never
// requires auth.js and both can be loaded from anywhere.
//
//   state  "ok"    agreed to the current documents and picked an age band
//            "guest" chose 游客模式 (or 不同意): no login, nothing saved, no AI
//            "none"  neither, e.g. first launch or after a version change
//   check  call first in onShow of tab pages and pages that need login;
//            "none" goes to the welcome page and returns false
//   ask    a guest tapped something that needs an account; ask({ leave: true })
//            from a page with nothing a guest can see also leaves it on 先看看
const config = require("./config");

const CONSENT_KEY = "zhiye_privacy_consent";
const GUEST_KEY = "zhiye_guest";
const WELCOME = "/pages/welcome/index";
const NOTES = "/pages/notes/index";

// { v, age, at } for the current version, otherwise null. The old string value
// (one version string) counts as not agreed to the new documents.
function consent() {
  const value = wx.getStorageSync(CONSENT_KEY);
  if (!value || typeof value !== "object") return null;
  if (value.v !== config.PRIVACY_VERSION) return null;
  if (value.age !== "adult" && value.age !== "child") return null;
  return value;
}
function state() {
  if (consent()) return "ok";
  return wx.getStorageSync(GUEST_KEY) === "1" ? "guest" : "none";
}
// "adult" | "child" | "" (not agreed)
function age() {
  const value = consent();
  return value ? value.age : "";
}
function check() {
  if (state() !== "none") return true;
  wx.reLaunch({ url: WELCOME });
  return false;
}
function ask(options) {
  const leave = Boolean(options && options.leave);
  wx.showModal({
    title: "同意后才能用",
    content: "游客模式不保存、不用 AI。同意用户协议和隐私政策后就能用。",
    confirmText: "去同意",
    cancelText: "先看看",
    success: ({ confirm }) => {
      if (confirm) wx.reLaunch({ url: WELCOME });
      else if (leave && getCurrentPages().length > 1) wx.navigateBack();
      else if (leave) wx.switchTab({ url: NOTES });
    },
  });
}
module.exports = { CONSENT_KEY, GUEST_KEY, consent, state, age, check, ask };
