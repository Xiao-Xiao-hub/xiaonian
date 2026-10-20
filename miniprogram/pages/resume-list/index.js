/*
 * 回顾列表：查看待回应或暂停的回顾项，提交回应、跳过、提醒与恢复等动作。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const gate = require("../../utils/gate");
const auth = require("../../utils/auth");
const { errorText } = require("../../utils/format");
const owner = () => (auth.getUser() || {}).id || "";
const today = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
// what comes back and when, in words: 回顾 / 待办 / 接着聊 … · 今天.
const LABELS = {
  recall: "回顾",
  todo: "待办",
  chat: "接着聊",
  // a reminder on a card that asks nothing.
  look: "回头看看",
  manual: "提醒",
  mood: "心情",
  retest: "再练一次",
  brainstorm: "头脑风暴",
  import: "导入",
};
const when = (item, day) => {
  const at =
    item.state === "dormant"
      ? "先不问了"
      : !item.dueOn || item.dueOn <= day
        ? "今天"
        : item.dueOn.slice(5).replace("-", "/");
  const label = LABELS[item.kind];
  return label ? `${label} · ${at}` : at;
};
Page({
    data: {
      items: [],
      state: "waiting",
      busy: false,
      error: "",
      loading: false,
    },
    onLoad(query) {
      const state = query.state === "never" ? "never" : "waiting";
      this.setData({ state });
      wx.setNavigationBarTitle({
        title: state === "never" ? "不再提醒的" : "回顾和提醒",
      });
    },
    onShow() {
      if (!gate.check()) return;
      // A guest has nothing here: offer the welcome page, send nothing.
      if (gate.state() !== "ok") return gate.ask({ leave: true });
      this.alive = true;
      this.load();
    },
    onPullDownRefresh() {
      const stop = () => wx.stopPullDownRefresh();
      return this.load().then(stop, stop);
    },
    onHide() {
      this.alive = false;
      this.seq = (this.seq || 0) + 1;
    },
    onUnload() {
      this.onHide();
    },
    active(account, seq) {
      return this.alive && owner() === account && this.seq === seq;
    },
    async load() {
      const seq = (this.seq = (this.seq || 0) + 1);
      let account = "";
      this.setData({ items: [], loading: true, error: "", busy: false });
      try {
        await auth.login();
        account = owner();
        if (!this.alive || seq !== this.seq) return;
        const items = await api.get(`/v1/resume?state=${this.data.state}`),
          day = today();
        if (this.active(account, seq))
          this.setData({
            items: items.map((item) => ({
              ...item,
              title: item.title || item.card?.title || "这件事",
              meta: this.data.state === "never" ? "" : when(item, day),
            })),
          });
      } catch (error) {
        if (this.alive && seq === this.seq)
          this.setData({ error: errorText(error) });
      } finally {
        if (this.active(account, seq)) this.setData({ loading: false });
      }
    },
    async open(event) {
      const account = owner(),
        item = this.data.items.find(
          (i) => i.id === event.currentTarget.dataset.id,
        );
      if (!item || this.data.busy) return;
      if (item.state === "dormant") await this.restore(event, false);
      if (!this.alive || account !== owner() || this.data.error) return;
      const url =
        item.url ||
        (item.card
          ? `/pages/card/index?id=${encodeURIComponent(item.card.id)}`
          : `/pages/point/index?id=${encodeURIComponent(item.srcId)}&mode=${item.kind === "review" ? "review" : "retest"}`);
      wx.navigateTo({ url });
    },
    async restore(event, reload = true) {
      const id = event.currentTarget.dataset.id,
        account = owner(),
        seq = this.seq;
      if (this.data.busy) return;
      this.setData({ busy: true, error: "" });
      try {
        await api.post(`/v1/resume/${id}/act`, { action: "restore" });
        if (this.active(account, seq) && reload) this.load();
      } catch (error) {
        if (this.active(account, seq))
          this.setData({ error: errorText(error) });
      } finally {
        if (this.active(account, seq)) this.setData({ busy: false });
      }
    },
    rowMenu(event) {
      const id = event.currentTarget.dataset.id,
        account = owner();
      wx.showActionSheet({
        itemList: ["不再提起"],
        success: () => {
          if (this.alive && account === owner())
            this.never({ currentTarget: { dataset: { id } } });
        },
      });
    },
    async never(event) {
      const account = owner(),
        seq = this.seq;
      if (this.data.busy) return;
      this.setData({ busy: true, error: "" });
      try {
        await api.post(`/v1/resume/${event.currentTarget.dataset.id}/act`, {
          action: "never",
        });
        if (this.active(account, seq)) this.load();
      } catch (error) {
        if (this.active(account, seq))
          this.setData({ error: errorText(error) });
      } finally {
        if (this.active(account, seq)) this.setData({ busy: false });
      }
    },
  });
