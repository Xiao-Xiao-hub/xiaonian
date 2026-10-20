/*
 * 对话历史：分页展示会话并进入原会话；不同工具的历史仍按服务端工具范围区分。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
// 全部对话 : every 聊一聊 chat, newest first, 20 at a time
// (GET /v1/chat/threads?kind=chat&limit=20&before=…), with the words of a title
// to look for. A tap goes on with the chat on the 聊一聊 tab; a long press
// deletes it.
const api = require("../../utils/api");
const gate = require("../../utils/gate");
const { errorText, when } = require("../../utils/format");
const { openChat, chatDeleted } = require("../../utils/chat-entry");
const chat = require("../../utils/chat-v2");

const PAGE = 20;
function row(t) {
  const tags = [];
  if (t.unfinished) tags.push("没聊完");
  if (t.wrapReady) tags.push("待存卡");
  if (t.scene && t.scene !== "study") tags.push(chat.SCENES[t.scene] || "");
  return {
    id: t.id,
    title: t.title || "对话",
    last: t.last || "",
    when: when(t.lastAt || t.updatedAt),
    tags: tags.filter(Boolean),
  };
}

Page({
  data: { threads: [], query: "", next: null, loaded: false, loading: false, error: "" },
  onShow() {
    if (!gate.check()) return;
    if (gate.state() === "guest") return wx.navigateBack();
    this.load(true);
  },
  onReachBottom() {
    if (this.data.next) this.load(false);
  },
  onPullDownRefresh() {
    const stop = () => wx.stopPullDownRefresh();
    this.load(true).then(stop, stop);
  },
  load(first) {
    if (this.data.loading && !first) return Promise.resolve();
    const version = (this.version || 0) + 1;
    this.version = version;
    const q = this.data.query.trim();
    const before = first ? null : this.data.next;
    const url = `/v1/chat/threads?kind=chat&limit=${PAGE}${before ? `&before=${encodeURIComponent(before)}` : ""}${
      q ? `&q=${encodeURIComponent(q)}` : ""
    }`;
    this.setData({ loading: true, error: "" });
    return api
      .get(url)
      .then(({ threads, next }) => {
        if (version !== this.version) return;
        const list = (threads || []).map(row);
        this.setData({ threads: first ? list : this.data.threads.concat(list), next: next || null, loaded: true });
      })
      .catch((error) => {
        if (version === this.version && !api.needsConsent(error)) this.setData({ loaded: true, error: errorText(error) });
      })
      .finally(() => {
        if (version === this.version) this.setData({ loading: false });
      });
  },
  search(e) {
    this.setData({ query: e.detail.value });
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.load(true), 400);
  },
  retry() {
    this.load(!this.data.threads.length);
  },
  // Goes on with the chat on the tab (back to it when it is under this page).
  open(e) {
    openChat({ threadId: e.currentTarget.dataset.id }, { tab: true });
  },
  remove(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: "删掉这段对话？",
      content: "对话和里面的图片、文件会删掉。",
      confirmText: "删掉",
      confirmColor: "#e0474c",
      success: ({ confirm }) => {
        if (!confirm) return;
        api
          .del(`/v1/chat/threads/${encodeURIComponent(id)}`)
          .then(() => {
            chatDeleted(id);
            this.setData({ threads: this.data.threads.filter((t) => t.id !== id) });
          })
          .catch((error) => {
            if (!api.needsConsent(error)) this.setData({ error: errorText(error) });
          });
      },
    });
  },
});
