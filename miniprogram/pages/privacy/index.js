/*
 * 隐私政策与账号操作：展示文件，处理同意、撤回、导出和注销的用户入口。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const config = require("../../utils/config");
const api = require("../../utils/api");
const auth = require("../../utils/auth");
const gate = require("../../utils/gate");
const session = require("../../utils/session");
const learningSpace = require("../../utils/learning-space");
const { request } = require("../../utils/request");
const { errorText } = require("../../utils/format");
const EXPIRED = "登录过期了，重新打开晓念登录后再来撤回";
const CHANGED = "换了账号，退出这页再进来";
// This phone's own flags, cleared after 注销 the same way 我的 does (utils/session).
const { LOCAL_FLAGS } = session;
// “我的 › 隐私政策”: the three documents, export, age band and 撤回授权并退出登录.
// Export, revoking and 注销账号 only need the old session, so they keep working
// in guest mode and before a new version is agreed (隐私政策 10.4); no
// gate.check here. 注销 is listed only then: otherwise it is on 我的.
const DOCS = [
  { key: "user-agreement", name: "用户协议" },
  { key: "privacy-policy", name: "隐私政策" },
  { key: "children-privacy", name: "儿童隐私政策" },
];
const today = () => {
  const d = new Date();
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};
Page({
  data: {
    version: config.PRIVACY_VERSION,
    docs: DOCS,
    canRevoke: false,
    signedIn: false,
    // "adult" | "child" once the current version is agreed, else "".
    age: "",
    guardian: false,
    busy: false,
    exporting: false,
    error: "",
  },
  onShow() {
    this.refresh();
  },
  refresh() {
    this.setData({
      canRevoke: auth.hasConsent() || auth.signedIn(),
      signedIn: auth.signedIn(),
      age: gate.age(),
    });
  },
  noop() {},
  openDoc(e) {
    wx.navigateTo({ url: `/pages/legal/index?doc=${e.currentTarget.dataset.doc}` });
  },
  openPlatform() {
    if (typeof wx.openPrivacyContract !== "function")
      return this.setData({ error: "微信版本有点旧，升级后就能打开" });
    wx.openPrivacyContract({
      fail: () => this.setData({ error: "暂时打不开，过一会儿再试" }),
    });
  },
  // 导出我的数据: a JSON file sent to a chat (for example 文件传输助手).
  exportData() {
    if (this.data.busy) return;
    if (typeof wx.shareFileMessage !== "function")
      return this.setData({ error: "微信版本有点旧，升级后就能导出了" });
    const owner = (auth.getUser() || {}).id;
    const generation = auth.consentGeneration();
    this.setData({ busy: true, exporting: true, error: "" });
    api
      .download("/v1/me/export", "导出文件", { account: true })
      .then((filePath) => {
        if (generation !== auth.consentGeneration() || owner !== (auth.getUser() || {}).id)
          throw new Error(CHANGED);
        return new Promise((resolve, reject) =>
          wx.shareFileMessage({
            filePath,
            fileName: `晓念数据导出-${today()}.json`,
            success: resolve,
            fail: (error) =>
              /cancel/.test((error && error.errMsg) || "")
                ? resolve()
                : reject(new Error("文件没发出去，再试一次")),
          }),
        );
      })
      .catch((error) => this.setData({ error: errorText(error) }))
      .finally(() => this.setData({ busy: false, exporting: false }));
  },
  // 未满 14 周岁 → 已满: one confirmation. The switches the guardian left off stay off.
  toAdult() {
    if (this.data.busy) return;
    wx.showModal({
      title: "改成已满 14 周岁？",
      content: "请确认你已满 14 周岁。改了以后适用《隐私政策》，关着的推荐开关不会自动打开。",
      confirmText: "确认",
      success: ({ confirm }) => {
        if (confirm) this.setAge("adult");
      },
    });
  },
  // 已满 → 未满 14 周岁: the guardian agrees first, as on the welcome page.
  toChild() {
    if (!this.data.busy) this.setData({ guardian: true, error: "" });
  },
  closeGuardian() {
    if (!this.data.busy) this.setData({ guardian: false });
  },
  guardianAgree() {
    this.setAge("child");
  },
  setAge(age) {
    if (this.data.busy) return;
    const data = { version: config.PRIVACY_VERSION, ageBand: age };
    if (age === "child") data.guardian = true;
    this.setData({ busy: true, error: "" });
    api
      .put("/v1/me/consent", data)
      .then(() => {
        auth.recordConsent(age);
        this.setData({ guardian: false });
        wx.showToast({ title: "改好了", icon: "none" });
      })
      .catch((error) => this.setData({ error: errorText(error) }))
      .finally(() => {
        this.setData({ busy: false });
        this.refresh();
      });
  },
  // A child's account: withdrawing the guardian's consent deletes the account
  // (儿童隐私政策 9.1). Everyone else is logged out on this phone. With a
  // session the server's age band decides, never this phone's; if it cannot be
  // read, nothing happens and the page says why.
  revoke() {
    if (this.data.busy) return;
    const original = session.getSession();
    if (!original) return this.revokeAdult(null);
    this.setData({ busy: true, error: "" });
    request({ url: "/v1/me/consent", auth: true })
      .then((body) => {
        this.setData({ busy: false });
        const current = session.getSession();
        if (!current || current.token !== original.token)
          return this.setData({ error: CHANGED });
        const band = body && body.data && body.data.ageBand;
        if (band === "child") this.revokeChild(original);
        else this.revokeAdult(original);
      })
      .catch((error) =>
        this.setData({
          busy: false,
          error: error && error.statusCode === 401 ? EXPIRED : errorText(error),
        }),
      )
      .finally(() => this.refresh());
  },
  revokeAdult(original) {
    wx.showModal({
      title: "撤回授权",
      content:
        "会退出登录，清掉这台手机上的授权。服务器上的资料不会删；想删的话，在“我的资料”里一份份删，或者在“我的”里注销账号。",
      success: async ({ confirm }) => {
        if (!confirm) return;
        const owner = (auth.getUser() || {}).id;
        auth.clearConsent();
        learningSpace.clear(owner);
        if (typeof getApp === "function") delete getApp().globalData.noteContext;
        // the withdrawal and the logout are told apart, so it is clear
        // whether the account has the withdrawal on record.
        let unrecorded = false;
        try {
          // The withdrawal is recorded on the account first; logging out
          // goes ahead even if that fails. A session renewed meanwhile on
          // purpose is not logged out.
          const same = () => {
            const current = session.getSession();
            return Boolean(original && current && current.token === original.token);
          };
          if (same())
            await request({ url: "/v1/me/consent", method: "DELETE", data: {}, auth: true }).catch(() => {
              unrecorded = true;
            });
          if (!original || same()) await auth.logout();
          if (unrecorded)
            this.setData({ error: "已经退出了，但撤回没记到服务器上（没连上）。下次登录时会重新问你是否同意。" });
          else wx.showToast({ title: "撤回了，已退出", icon: "none" });
        } catch (error) {
          this.setData({
            error: auth.signedIn()
              ? "退出时没连上服务器，之前的登录过一阵会自己失效。"
              : unrecorded
                ? "这台手机已经退出了。服务器没连上，撤回没记上；那边的登录过一阵会自己失效，下次登录时会重新问你是否同意。"
                : "这台手机已经退出了。服务器没连上，那边的登录过一阵会自己失效。",
          });
        }
        this.refresh();
      },
    });
  },
  revokeChild(original) {
    if (this.data.busy) return;
    wx.showModal({
      title: "撤回同意就会注销账号",
      content:
        "未满 14 周岁的账号撤回同意后，会注销账号，删除全部资料、原图、学习记录和心情内容，找不回来。想留着的话，先导出一份；导出的是 JSON 文件，不含原图。",
      confirmText: "注销",
      confirmColor: "#c0392b",
      success: ({ confirm }) => {
        if (confirm) this.removeAccount(original, EXPIRED);
      },
    });
  },
  // 注销账号 before the current documents are agreed (我的 is out of reach then).
  deleteAccount() {
    if (this.data.busy || this.deletePrompt) return;
    const original = session.getSession();
    if (!original) return this.setData({ error: CHANGED });
    this.deletePrompt = true;
    wx.showModal({
      title: "注销账号？",
      content:
        "你放进来的资料和原图、随心记里的内容、生成的讲解提示和题目、做题和回头看看的记录、学习时长都会删掉，找不回来。想留着的话，先导出一份；导出的是 JSON 文件，不含原图。",
      confirmText: "注销",
      confirmColor: "#c0392b",
      success: ({ confirm }) => {
        this.deletePrompt = false;
        if (confirm) this.removeAccount(original, CHANGED);
      },
      fail: () => {
        this.deletePrompt = false;
      },
    });
  },
  removeAccount(original, expired) {
    const current = session.getSession();
    if (!current) return this.setData({ error: expired });
    if (current.token !== original.token)
      return this.setData({ error: CHANGED });
    const owner = original.user.id;
    this.setData({ busy: true, error: "" });
    api
      .del("/v1/me", { confirm: true }, { account: true })
      .then(() => {
        learningSpace.clear(owner);
        if ((auth.getUser() || {}).id !== owner) return;
        if (typeof getApp === "function") delete getApp().globalData.noteContext;
        session.clearSession();
        auth.clearConsent();
        LOCAL_FLAGS.forEach((key) => {
          try {
            wx.removeStorageSync(key);
          } catch (_) {}
        });
        wx.showToast({ title: "账号注销了", icon: "none" });
        wx.switchTab({ url: "/pages/notes/index" });
      })
      .catch((error) => this.setData({ error: errorText(error) }))
      .finally(() => {
        this.setData({ busy: false });
        this.refresh();
      });
  },
});
