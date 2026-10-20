/*
 * 题库入口：按章节与知识点浏览练习，导航到具体作答页；题目事实来源仍是服务端题库。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
// 题库 : 学习 → 练一题 opens here. Every knowledge point by
// chapter, with its problem count and the learner's progress; a tap practises
// that point (pages/point), in any order. A guest sees the list and is asked
// before practising.
const api = require("../../utils/api");
const auth = require("../../utils/auth");
const gate = require("../../utils/gate");
const bank = require("../../utils/bank");
const { retryText, backTo, ROUTES } = require("../../utils/learn");

Page({
  data: {
    loading: true,
    error: "",
    guest: false,
    chapters: [],
    tabs: [],
    chapterId: "",
  },
  onLoad(query) {
    // ?chapter= opens on one chapter.
    this.setData({ chapterId: (query && query.chapter) || "" });
  },
  onShow() {
    this.alive = true;
    if (!gate.check()) return;
    // Back from a problem: the progress may have changed.
    this.load();
  },
  onHide() {
    this.alive = false;
  },
  onUnload() {
    this.alive = false;
  },
  load() {
    const guest = gate.state() === "guest";
    const seq = (this.seq = (this.seq || 0) + 1);
    // The progress belongs to whoever was signed in when it was asked for
    // (bound after login); a guest's list has none.
    let owner;
    const active = () =>
      this.alive &&
      seq === this.seq &&
      (owner === undefined || (auth.hasConsent() && owner === (auth.getUser() || {}).id));
    this.setData({ loading: true, error: "", guest });
    return (
      guest
        ? bank.load()
        : auth.login().then(() => {
            if (!active()) return null;
            owner = (auth.getUser() || {}).id;
            return bank.load();
          })
    )
      .then((data) => {
        if (!active() || !data) return;
        const shown = bank.view(data);
        this.setData({ chapters: shown.chapters, tabs: shown.tabs, guest: shown.guest });
      })
      .catch((error) => {
        if (active() && !api.needsConsent(error)) this.setData({ error: retryText(error) });
      })
      .finally(() => {
        if (active()) this.setData({ loading: false });
      });
  },
  selectChapter(event) {
    const id = event.currentTarget.dataset.id || "";
    if (id !== this.data.chapterId) this.setData({ chapterId: id });
    if (typeof wx.pageScrollTo === "function") wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  pick(event) {
    const { id, ready } = event.detail || {};
    if (!id) return;
    if (this.data.guest || gate.state() === "guest") return gate.ask();
    if (!ready) return wx.showToast({ title: "题还在出，稍等", icon: "none" });
    backTo(ROUTES.point, id);
  },
  // One problem of a point, straight from its chip.
  pickItem(event) {
    const { id, index } = event.detail || {};
    if (!id || !Number.isInteger(index)) return;
    if (this.data.guest || gate.state() === "guest") return gate.ask();
    wx.navigateTo({ url: `/${ROUTES.point}?id=${encodeURIComponent(id)}&index=${index}` });
  },
});
