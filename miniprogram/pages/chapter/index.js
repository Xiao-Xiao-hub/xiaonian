/*
 * 章节页：展示指定章节的学习内容与进度，衔接知识点、地图和练习入口。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const gate = require("../../utils/gate");
const { errorText } = require("../../utils/format");
const { chapterView, retryText, backTo, ROUTES } = require("../../utils/learn");
const studyClock = require("../../utils/study-clock");
// 章节页 (Chapter board): the chapter's rank, what the next rank needs, its four
// tiers point by point (only the next rank's tier open at first), 剩下的我都会
// and the ⋯ menu (这章先放着).
// 连做本章 is not built yet.
Page(studyClock.track({
  data: {
    loading: true,
    error: "",
    canRetry: true,
    fail: "",
    busy: false,
    chapter: null,
    open: {},
  },
  onLoad(query) {
    this.id = (query && query.id) || "";
  },
  // Coming back from a point shows its new state.
  onShow() {
    if (!gate.check()) return;
    // Guests cannot open a chapter in the app; one who got here anyway leaves.
    if (gate.state() === "guest") return gate.ask({ leave: true });
    this.load();
  },
  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },
  load() {
    this.setData({ loading: true, error: "", fail: "" });
    return api
      .get("/v1/learn/map")
      .then((map) => {
        const c = map.chapters.find((x) => x.id === this.id);
        if (!c) return this.setData({ error: "没找到这一章", canRetry: false, chapter: null });
        wx.setNavigationBarTitle({ title: c.short });
        // The first read opens the tier the next rank needs; at the top rank,
        // the tier of the chapter's next point, else none. Later reads keep
        // what the user opened.
        if (!this.folded) {
          this.folded = true;
          const next = c.next && c.points.find((p) => p.id === c.next.id);
          const tier = (c.up && c.up.tier) || (next && next.tier);
          this.setData({ open: tier ? { [tier]: true } : {} });
        }
        this.setData({ chapter: chapterView(c) });
      })
      .catch((error) => {
        if (api.needsConsent(error)) return;
        if (error && error.code === "CONSENT_REQUIRED") {
          backTo(ROUTES.learn);
          return;
        } this.setData({ error: retryText(error) });
      })
      .finally(() => this.setData({ loading: false }));
  },
  // Chapter actions (POST /v1/learn/marks); each reloads the map afterwards.
  mark(action, done, id = this.id) {
    if (this.data.busy) return Promise.resolve();
    this.setData({ busy: true, fail: "" });
    return api
      .post("/v1/learn/marks", { action, chapterId: id })
      .then((res) => {
        wx.showToast({ title: done(res), icon: "none" });
        return this.load();
      })
      .catch((error) => {
        if (api.needsConsent(error)) return;
        // A rule such as 409 LAST_CHAPTER ("至少留一章") is no failure: a toast
        // where the tap was, no red bar with a request id.
        const rule = error && error.statusCode >= 400 && error.statusCode < 500;
        if (rule) wx.showToast({ title: (error && error.message) || errorText(error), icon: "none" });
        else this.setData({ fail: errorText(error) });
      })
      .finally(() => this.setData({ busy: false }));
  },
  selfRest() {
    return this.mark("selfRest", () => "记下了");
  },
  unselfRest() {
    return this.mark("unselfRest", () => "改回来了");
  },
  confirmUnself() {
    wx.showModal({
      title: "撤销本章的“我会了”",
      content: "本章标了会的点都变回原来的样子，包括在知识点页单独标的；做对过的点不受影响。",
      confirmText: "撤销",
      success: (res) => {
        if (res.confirm) this.unselfRest();
      },
    });
  },
  hideChapter(id) {
    return this.mark("hide", () => "好，这章先放着", id || this.id);
  },
  unhideChapter(id) {
    return this.mark("unhide", () => "这章放回来了", id || this.id);
  },
  // 本章菜单: 这章先放着, or 放回来 when it is set aside.
  openMenu() {
    const c = this.data.chapter;
    if (!c) return;
    wx.showActionSheet({
      itemList: [c.hidden ? "放回来" : "这章先放着"],
      // The board's line under 这章先放着.
      ...(c.hidden ? {} : { alertText: "先放着的章不算进全书段位和做对数，随时能放回来" }),
      success: (res) => {
        if (res.tapIndex !== 0) return;
        if (c.hidden) this.unhideChapter(c.id);
        else this.hideChapter(c.id);
      },
    });
  },
  restore() {
    return this.unhideChapter(this.id);
  },
  toggleTier(event) {
    const tier = event.currentTarget.dataset.tier;
    this.setData({ open: { ...this.data.open, [tier]: !this.data.open[tier] } });
  },
  openPoint(event) {
    backTo(ROUTES.point, event.currentTarget.dataset.id);
  },
  goMap() {
    backTo(ROUTES.map);
  },
}));
