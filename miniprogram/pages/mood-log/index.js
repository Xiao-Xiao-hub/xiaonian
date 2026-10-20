/*
 * 心情记录页：查看与管理当前账号的心情记录；撤回或删除需走服务端接口。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const auth = require("../../utils/auth");
const { errorText } = require("../../utils/format");
const gate = require("../../utils/gate");
const { openChat, chatDeleted } = require("../../utils/chat-entry");

const owner = () => (auth.getUser() || {}).id || "";
const firstSentence = (value) => String(value || "").split(/[。！？!?\n]/)[0].trim();
const dateText = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `${date.getMonth() + 1}/${date.getDate()}`;
};
function thread(item) {
  return { ...item, title: firstSentence(item.title) || "这段心情对话", dateText: dateText(item.date), cardsText: item.cards ? `存成了 ${item.cards} 张卡` : "" };
}
const EMPTY = { cards: 0, linkedThreads: 0, brainstorms: 0 };
// The related records (V4.2: shown as 相关记录, and named again in the
// 删除全部 confirmation); hasAny decides the empty state.
function summary(threads, counts) {
  const parts = [];
  if (counts.cards) parts.push(`${counts.cards} 张心情卡`);
  if (counts.linkedThreads) parts.push(`${counts.linkedThreads} 段聊天`);
  if (counts.brainstorms) parts.push(`${counts.brainstorms} 场头脑风暴`);
  return { extraText: parts.join("、"), hasAny: Boolean(threads.length || parts.length) };
}

Page({
  data: {
    loading: false, busy: false, error: "", threads: [], linkedThreads: [], brainstorms: [],
    counts: EMPTY, tab: "", extraOpen: false, extraText: "", hasAny: false, swipeId: "", consentedAt: "",
  },
  onShow() {
    if (!gate.check()) return;
    this.alive = true;
    // A guest has nothing stored here and sends nothing.
    if (gate.state() !== "ok") return this.setData({ loading: false, hasAny: false, consentedAt: "" });
    this.load();
  },
  onHide() { this.alive = false; this.version = (this.version || 0) + 1; },
  onUnload() { this.onHide(); },
  onPullDownRefresh() { if (gate.state() !== "ok") return wx.stopPullDownRefresh(); this.load().finally(() => wx.stopPullDownRefresh()); },
  load() {
    const version = this.version = (this.version || 0) + 1;
    let account = "";
    const active = () => this.alive !== false && version === this.version && (!account || account === owner());
    this.setData({ loading: true, error: "", swipeId: "" });
    return auth.login().then(() => {
      account = owner();
      return api.get("/v1/mood");
    })
      .then((data) => {
        if (!active()) return;
        this.owner = account;
        const threads = (data.threads || []).map(thread), counts = data.counts || EMPTY;
        this.setData({
          consentedAt: data.consentedAt || "",
          threads,
          linkedThreads: (data.linkedThreads || []).map(thread),
          brainstorms: (data.brainstorms || []).map((item) => ({ ...item, title: firstSentence(item.title) || "这场头脑风暴", dateText: dateText(item.date) })),
          counts,
          ...summary(threads, counts),
        });
      })
      .catch((error) => { if (active() && !api.needsConsent(error)) this.setData({ error: errorText(error) }); })
      .finally(() => { if (active()) this.setData({ loading: false }); });
  },
  toggleExtra() { this.setData({ extraOpen: !this.data.extraOpen, tab: "" }); },
  // Opens one of the two lists right under its row; tapping it again closes it.
  selectTab(event) { const tab = event.currentTarget.dataset.tab; this.setData({ tab: tab === this.data.tab ? "" : tab, swipeId: "" }); },
  openThread(event) { openChat({ threadId: event.currentTarget.dataset.id }); },
  openCards() { getApp().globalData.cardFilter = { scene: "mood" }; wx.switchTab({ url: "/pages/deck/index" }); },
  openBrainstorm(event) { wx.navigateTo({ url: `/pages/brainstorm/conclude/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
  touchStart(event) { this.touchX = event.touches[0].clientX; },
  touchEnd(event) {
    const start = this.touchX;
    const end = event.changedTouches[0].clientX;
    this.touchX = null;
    const id = event.currentTarget.dataset.id;
    if (typeof start === "number" && start - end > 42) this.setData({ swipeId: id });
    else if (typeof start === "number" && end - start > 24) this.setData({ swipeId: "" });
  },
  deleteThread(event) {
    if (this.data.busy) return;
    const id = event.currentTarget.dataset.id;
    const current = this.data.threads.find((item) => item.id === id);
    if (!current) return;
    const account = owner();
    wx.showModal({
      title: "删除这段心情对话？",
      content: "删了就找不回来了。",
      confirmText: "删除",
      confirmColor: "#e5484d",
      success: ({ confirm }) => {
        if (!confirm || account !== owner()) return;
        this.setData({ busy: true, error: "" });
        api.del(`/v1/chat/threads/${encodeURIComponent(id)}`).then(() => {
          chatDeleted(id);
          if (account !== owner()) return;
          const threads = this.data.threads.filter((item) => item.id !== id);
          this.setData({ threads, swipeId: "", ...summary(threads, this.data.counts) });
          wx.showToast({ title: "删掉了", icon: "none" });
        }).catch((error) => { if (!api.needsConsent(error)) this.setData({ error: errorText(error) }); }).finally(() => this.setData({ busy: false }));
      },
    });
  },
  deleteAll() {
    if (this.data.busy) return;
    const account = owner();
    const extra = this.data.extraText;
    wx.showModal({
      title: "删除全部心情内容？",
      content: extra ? `心情对话和${extra}会一起删掉，删了就找不回来了。` : "删了就找不回来了。",
      confirmText: "删除",
      confirmColor: "#e5484d",
      success: ({ confirm }) => {
        if (!confirm || account !== owner()) return;
        this.setData({ busy: true, error: "" });
        api.del("/v1/mood").then(() => {
          if (account !== owner()) return;
          this.setData({ threads: [], linkedThreads: [], brainstorms: [], counts: EMPTY, swipeId: "", tab: "", extraOpen: false, ...summary([], EMPTY) });
          wx.showToast({ title: "删掉了", icon: "none" });
        }).catch((error) => { if (!api.needsConsent(error)) this.setData({ error: errorText(error) }); }).finally(() => this.setData({ busy: false }));
      },
    });
  },
  revokeConsent() {
    if (this.data.busy) return;
    const account = owner();
    wx.showModal({
      title: "撤回心情同意？",
      content: "心情内容会全部删掉，以后想聊心情要再点一次同意。",
      confirmText: "撤回并删除",
      confirmColor: "#e5484d",
      success: ({ confirm }) => {
        if (!confirm || account !== owner()) return;
        this.setData({ busy: true, error: "" });
        api.del("/v1/me/mood-consent").then(() => {
          if (account !== owner()) return;
          this.setData({ consentedAt: "", threads: [], linkedThreads: [], brainstorms: [], counts: EMPTY, swipeId: "", tab: "", extraOpen: false, ...summary([], EMPTY) });
          wx.showToast({ title: "撤回了", icon: "none" });
        }).catch((error) => { if (!api.needsConsent(error)) this.setData({ error: errorText(error) }); }).finally(() => this.setData({ busy: false }));
      },
    });
  },
});
