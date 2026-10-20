/*
 * 欢迎页：引导初次使用者了解产品并进入既有的同意与设置流程。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const auth = require("../../utils/auth");
const gate = require("../../utils/gate");
const profile = require("../../utils/profile");
const { errorText } = require("../../utils/format");
const { asset } = require("../../utils/assets");
// The guided tour is shown once per phone (zhiye_onboarded, cleared when the
// account is deleted); a new document version asks again but does not show it
// again once seen.
const ONBOARDED = "zhiye_onboarded";
const NOTES = "/pages/notes/index";
// 小狸 on the first screen is a png in the package (some phones drew the
// packaged webp blank); if even that fails, the server's webp.
const HI = { src: "/assets/xiaoli/hi.png", webp: false };
// 欢迎 → 同意并继续 → 青少年守护 → 已满14岁 / 监护人同意 → 新手引导 → 随心记.
// Nothing is recorded and wx.login is not called until an age band is picked.
Page({
  data: { youth: false, busy: false, age: "", error: "", hi: HI },
  onShow() {
    if (gate.state() === "ok" && !this.data.busy) wx.reLaunch({ url: NOTES });
  },
  noop() {},
  // One fallback only: a failing server picture is hidden, not retried.
  hiError() {
    if (this.data.hi.webp) return this.setData({ hi: { src: "", webp: false } });
    this.setData({ hi: { src: asset("xiaoli-hi.webp"), webp: true } });
  },
  openDoc(e) {
    wx.navigateTo({ url: `/pages/legal/index?doc=${e.currentTarget.dataset.doc}` });
  },
  // The native agreePrivacyAuthorization button has already shown WeChat's own
  // privacy agreement; this only opens 青少年守护.
  agree() {
    if (!this.data.youth) this.setData({ youth: true, error: "" });
  },
  // Closing goes back to the welcome page and records nothing.
  closeYouth() {
    if (this.data.busy) return;
    this.setData({ youth: false, error: "" });
  },
  // 已满14岁 (adult) or 监护人同意 (child). Tapping again after a failure retries.
  pick(e) {
    if (this.data.busy) return;
    const age = e.currentTarget.dataset.age;
    this.setData({ busy: true, age, error: "" });
    // Not saved on the account yet: if the app is closed now, the next start
    // saves it before anything else (utils/auth.js).
    auth.recordConsent(age, false);
    auth
      .saveConsent()
      .then(() => {
        // anyone who has not seen the tour on this phone sees it, also
        // after agreeing again to new documents (随心记 checks the same flag).
        const tour = wx.getStorageSync(ONBOARDED) !== "1";
        const user = auth.getUser();
        if (user && !profile.displayName(user) && !user.avatar && !profile.prompted(user.id)) {
          getApp().globalData.profileSetup = {
            owner: user.id,
            next: tour ? "/pages/onboard/index" : NOTES,
          };
          wx.switchTab({ url: "/pages/profile/index" });
          return;
        }
        wx.reLaunch({ url: tour ? "/pages/onboard/index" : NOTES });
      })
      .catch((error) => {
        // Not saved on the account, so not agreed on this phone either.
        auth.clearConsent();
        this.setData({ busy: false, error: errorText(error) });
      });
  },
  // 游客模式 and 不同意: only the examples, no login, nothing saved, no AI.
  guest() {
    if (this.data.busy) return;
    auth.enterGuest();
    wx.reLaunch({ url: NOTES });
  },
  refuse() {
    this.guest();
  },
});
