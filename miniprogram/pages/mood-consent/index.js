/*
 * 心情内容单独同意页：说明处理范围并提交用户选择，完成后返回对应的心情流程。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const auth = require("../../utils/auth");
const { errorText } = require("../../utils/format");
const gate = require("../../utils/gate");

function safeNext(value) {
  try {
    const next = decodeURIComponent(value || "");
    return /^\/pages\/(?:chat|ask)\/index\?threadId=[^&]+$/.test(next) ? next : "";
  } catch (_) {
    return "";
  }
}

Page({
  // A child's account needs the guardian's own consent too (儿童隐私政策 第十章).
  data: { saving: false, error: "", child: false, guardian: false },
  onLoad(query) { this.next = safeNext(query && query.next); },
  onShow() { this.setData({ child: gate.age() === "child" || Boolean(this.serverChild) }); },
  openPrivacy() { wx.navigateTo({ url: "/pages/legal/index?doc=privacy-policy" }); },
  openChildren() { wx.navigateTo({ url: "/pages/legal/index?doc=children-privacy" }); },
  toggleGuardian() { this.setData({ guardian: !this.data.guardian, error: "" }); },
  // Not now: nothing waits to switch to mood when the chat shows again.
  cancel() {
    const data = getApp().globalData;
    for (const key of ["chat", "ask"]) if (data[key] && data[key].pendingMood) delete data[key].pendingMood;
    data.moodConsentReturn = null;
    if (getCurrentPages().length > 1) return wx.navigateBack();
    wx.switchTab({ url: "/pages/notes/index" });
  },
  agree() {
    if (this.data.saving) return;
    if (this.data.child && !this.data.guardian)
      return this.setData({ error: "未满 14 周岁要监护人同意，请家长勾选后再点同意" });
    const generation = auth.consentGeneration();
    let owner = "";
    this.setData({ saving: true, error: "" });
    auth.login().then(() => {
      owner = (auth.getUser() || {}).id;
      return api.put("/v1/me/mood-consent", this.data.child ? { guardian: true } : {});
    })
      .then((result) => {
        if (generation !== auth.consentGeneration() || owner !== (auth.getUser() || {}).id) return;
        const app = getApp();
        app.globalData.moodConsentReturn = { moodConsented: true, next: this.next, consentedAt: result && result.consentedAt };
        const pages = getCurrentPages();
        const previous = pages[pages.length - 2];
        if (previous && typeof previous.setData === "function") previous.setData({ moodConsented: true });
        if (previous) return wx.navigateBack();
        // Nothing under it: the chat opens on the chat page (it switches to mood
        // on this yes), else 聊一聊. A mood chat never goes to 解题.
        if (this.next) return wx.navigateTo({ url: this.next.replace('/pages/ask/', '/pages/chat/') });
        wx.switchTab({ url: '/pages/talk/index' });
      })
      .catch((error) => {
        // The account is a child's on the server even if this phone did not
        // know: show the guardian's checkbox.
        if (error && error.code === "GUARDIAN_REQUIRED") {
          this.serverChild = true;
          return this.setData({ child: true, guardian: false, error: errorText(error) });
        }
        if (!api.needsConsent(error)) this.setData({ error: errorText(error) });
      })
      .finally(() => this.setData({ saving: false }));
  },
});
