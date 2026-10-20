/*
 * 首次设置页：收集使用流程需要的选择，按当前设置跳转到主要功能。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const gate = require("../../utils/gate");
const { asset } = require("../../utils/assets");
// Shown once per phone: after agreeing (pages/welcome), or on 随心记 for anyone
// agreed who has not seen it yet; again from 帮助 › 再看一遍新手引导 (from=help),
// which goes back to the help page at the end.
const ONBOARDED = "zhiye_onboarded";
const NOTES = "/pages/notes/index";
// the sample cards are drawn by card-tile, so they look like
// today's wall: kind, title, one line and the stage word in the kind's own
// words (no percentage bars).
const sample = (card) => ({ scene: "study", slots: [], ...card });
const FIRST = sample({
  id: "onboard-first",
  type: "question",
  kind: "question",
  title: "sin 3x 比 x 的极限",
  summary: "x→0 时 sin 3x 和 3x 是等价无穷小，替换后极限是 3。",
  summaryMarked: "x→0 时 sin 3x 和 3x 是[[k:等价无穷小]]，替换后极限是 3。",
});
const WALL = [
  [
    sample({ id: "onboard-question", type: "question", kind: "question", title: "1−cos x 比 x² 的极限", summary: "先化成正弦，再凑重要极限", mine: "先化成正弦再凑", stage: "clear", favorite: true }),
    sample({ id: "onboard-spark", type: "spark", kind: "spark", scene: "life", title: "错题拍照就成卡" }),
    sample({ id: "onboard-todo", type: "idea", kind: "todo", scene: "life", title: "周末去图书馆", stage: "closed" }),
  ],
  [
    sample({ id: "onboard-knowledge", type: "method", kind: "knowledge", title: "等价无穷小", summary: "x→0 时 sin x ~ x，tan x ~ x" }),
    sample({ id: "onboard-idea", type: "idea", kind: "idea", scene: "life", title: "要不要报数学竞赛" }),
  ],
];
// 新手引导 (02-onboard.html): three pages, 跳过 at any time.
Page({
  data: { current: 0, smile: asset("xiaoli-smile.webp"), first: FIRST, wall: WALL },
  // Shown for this run at once (so 随心记 does not open it again and again);
  // seen for good only at 开始使用 or 跳过, so a tour cut short by
  // closing the app comes back next time.
  onLoad(query) {
    this.fromHelp = Boolean(query && query.from === "help");
    if (!gate.check()) return;
    try {
      getApp().globalData.onboardShown = true;
    } catch (_) {}
  },
  change(e) {
    this.setData({ current: e.detail.current });
  },
  next() {
    if (this.data.current < 2) return this.setData({ current: this.data.current + 1 });
    this.finish();
  },
  finish() {
    try {
      wx.setStorageSync(ONBOARDED, "1");
    } catch (_) {}
    if (this.fromHelp && getCurrentPages().length > 1) return wx.navigateBack();
    wx.reLaunch({ url: NOTES });
  },
  hideSmile() {
    this.setData({ smile: "" });
  },
});
