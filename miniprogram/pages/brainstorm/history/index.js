const { withShare } = require("../../../utils/share");
/*
 * 头脑风暴历史：列出本人任务及状态，重新打开时回到该任务对应的步骤。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
// 以前的头脑风暴 — every brainstorm of this account, newest first
// (GET /v1/brainstorms, the whole list in one answer). Each row: the day,
// the conclusion (else the cards' titles) and where it stands; a tap opens
// the page for that state: saved → result, anything else → process (which
// shows the progress of a running one and offers 重试 for one that failed).
// Opened from the cards home "⋯" menu.
const api = require("../../../utils/api");
const gate = require("../../../utils/gate");
const auth = require("../../../utils/auth");
const { when } = require("../../../utils/format");
const { pending } = require("../../../utils/job");
const owner = () => (auth.getUser() || {}).id || "";
const RETRY = "没跑完，点开重试";
const text = (value) => String(value == null ? "" : value).trim();

function rowOf(item) {
  const picks = item.picks || {},
    cards = item.cards || [];
  const conclusion = text(picks.conclusion && picks.conclusion.text);
  const titles = cards
    .map((card) => text(card && card.title))
    .filter(Boolean)
    .slice(0, 4)
    .join("、");
  let state, page;
  if (item.status === "saved") {
    const saved = (item.outCardIds || []).length;
    state = saved ? `存了 ${saved} 张` : "存好了";
    page = "result";
  } else if (["ready", "paused"].includes(item.status)) {
    state = "想好了，接着看";
    page = "process";
  } else if (pending(item.job)) {
    state = "在想";
    page = "process";
  } else {
    state = RETRY;
    page = "process";
  }
  return {
    id: String(item.id),
    text: conclusion || titles || `${cards.length} 张卡`,
    when: when(item.createdAt || item.updatedAt),
    state,
    retry: state === RETRY,
    url: `/pages/brainstorm/${page}/index?id=${encodeURIComponent(item.id)}`,
  };
}
// A brainstorm whose cards were picked but never started has nothing to show.
const shown = (item) => item && item.id && !(item.status === "picked" && !item.job);
const rowsOf = (items) => (items || []).filter(shown).map(rowOf);

Page(withShare({
  data: { loading: true, loaded: false, error: "", rows: [] },
  onShow() {
    if (!gate.check()) return;
    // A guest has nothing here: offer the welcome page, send nothing.
    if (gate.state() !== "ok") return gate.ask({ leave: true });
    this.alive = true;
    this.epoch = (this.epoch || 0) + 1;
    const current = owner();
    // Another account: its own list, not the last one's.
    if (this.account && current && current !== this.account)
      this.setData({ rows: [], loaded: false });
    if (current) this.account = current;
    this.load();
  },
  onHide() {
    this.alive = false;
    this.epoch = (this.epoch || 0) + 1;
  },
  onUnload() {
    this.onHide();
  },
  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh();
    this.load().then(done, done);
  },
  active(epoch, account) {
    return this.alive && epoch === this.epoch && owner() === account;
  },
  load() {
    const epoch = this.epoch,
      account = this.account || owner();
    this.setData({ loading: true, error: "" });
    return api
      .get("/v1/brainstorms")
      .then((result) => {
        if (!this.active(epoch, account)) return;
        this.setData({ rows: rowsOf(result && result.items), loading: false, loaded: true });
      })
      .catch((error) => {
        if (!this.active(epoch, account) || api.needsConsent(error)) return;
        this.setData({ loading: false, error: (error && error.message) || "没打开，再试一次" });
      });
  },
  open(event) {
    const url = event.currentTarget.dataset.url;
    if (url) wx.navigateTo({ url });
  },
}));

module.exports = { rowOf, rowsOf };
