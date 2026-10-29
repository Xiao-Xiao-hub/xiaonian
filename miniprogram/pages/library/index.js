const { withShare } = require("../../utils/share");
/*
 * 学习库：按类型与关键字读取已收录资料，进入学习、校对或删除流程。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const gate = require("../../utils/gate");
const { errorText, when, KIND } = require("../../utils/format");
const FILTERS = [
  { key: "", label: "全部" },
  { key: "note", label: "资料" },
  { key: "problem", label: "题目" },
];
function card(item) {
  const draft = item.status !== "confirmed";
  return {
    ...item,
    meta: `${KIND[item.kind]} · ${when(item.updatedAt)}`,
    icon: item.kind === "problem" ? "pen-ink" : "book-ink",
    tag: draft ? "还没确认" : "",
    tagTone: draft ? "amber" : "",
  };
}
// 30 at a time, the next 30 on reaching the bottom.
const PAGE = 30;
Page(withShare({
  data: {
    filters: FILTERS,
    kind: "",
    q: "",
    searched: "",
    items: [],
    tools: false,
    loading: true,
    more: false,
    loadingMore: false,
    error: "",
  },
  onShow() {
    if (!gate.check()) return;
    this.load();
  },
  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },
  onReachBottom() {
    this.loadMore();
  },
  query(offset) {
    const { kind } = this.data;
    const q = this.data.q.trim();
    return [`limit=${PAGE}`, offset && `offset=${offset}`, kind && `kind=${kind}`, q && `q=${encodeURIComponent(q)}`]
      .filter(Boolean)
      .join("&");
  },
  // Only the newest query may fill the list: switching a filter or searching
  // again while an older answer is on its way drops that answer.
  load() {
    const seq = (this.seq = (this.seq || 0) + 1);
    const { kind } = this.data;
    const q = this.data.q.trim();
    this.setData({ loading: true, loadingMore: false, error: "" });
    return api
      .get(`/v1/materials?${this.query(0)}`)
      // Search and filters only once there is something to sift through.
      .then((items) => {
        if (seq !== this.seq) return;
        this.setData({
          items: items.map(card),
          searched: q,
          more: items.length >= PAGE,
          tools: items.length >= 8 || Boolean(kind || q),
        });
      })
      .catch((error) => {
        if (seq === this.seq && !api.needsConsent(error)) this.setData({ error: errorText(error) });
      })
      .finally(() => {
        if (seq === this.seq) this.setData({ loading: false });
      });
  },
  loadMore() {
    const { more, loading, loadingMore, items } = this.data;
    if (!more || loading || loadingMore) return Promise.resolve();
    const seq = this.seq;
    this.setData({ loadingMore: true, error: "" });
    return api
      .get(`/v1/materials?${this.query(items.length)}`)
      .then((page) => {
        if (seq !== this.seq) return;
        // A server without paging sends the first page again: nothing new, so stop.
        const seen = new Set(this.data.items.map((item) => item.id));
        const fresh = page.filter((item) => !seen.has(item.id));
        this.setData({
          items: this.data.items.concat(fresh.map(card)),
          more: page.length >= PAGE && fresh.length > 0,
        });
      })
      .catch((error) => {
        if (seq === this.seq && !api.needsConsent(error)) this.setData({ error: errorText(error) });
      })
      .finally(() => {
        if (seq === this.seq) this.setData({ loadingMore: false });
      });
  },
  onQuery(event) {
    this.setData({ q: event.detail.value });
    if (!event.detail.value.trim() && this.data.searched) this.load();
  },
  search() {
    this.load();
  },
  clearQuery() {
    this.setData({ q: "" });
    this.load();
  },
  setKind(event) {
    this.setData({ kind: event.currentTarget.dataset.kind });
    this.load();
  },
  showAll() {
    this.setData({ kind: "" });
    this.load();
  },
  openItem(event) {
    const item = this.data.items[event.currentTarget.dataset.index];
    if (item) api.openMaterial(item);
  },
  // Long press: delete, after saying exactly what goes with it.
  manageItem(event) {
    const item = this.data.items[event.currentTarget.dataset.index];
    if (!item) return;
    wx.showActionSheet({
      itemList: ["删掉"],
      itemColor: "#c0392b",
      success: () =>
        wx.showModal({
          title: `删掉“${item.title || "未命名"}”？`,
          content: `${item.hasImage ? "原图、" : ""}原文和它的讲解、提示、题目、做题记录会一起删掉，删了就找不回来了。`,
          confirmText: "删掉",
          confirmColor: "#c0392b",
          success: ({ confirm }) => {
            if (!confirm) return;
            api
              .del(`/v1/materials/${item.id}`)
              .then(() => {
                wx.showToast({ title: "删掉了", icon: "none" });
                return this.load();
              })
              .catch((error) => !api.needsConsent(error) && this.setData({ error: errorText(error) }));
          },
        }),
    });
  },
  // ⋯: adding something, and the two lists the learning page also opens.
  openMore() {
    const actions = [
      ["学一份资料", "startNote"],
      ["放一道题进来", "startProblem"],
      ["回头看看", "openReview"],
      ["错题本", "openMistakes"],
    ];
    wx.showActionSheet({
      itemList: actions.map((a) => a[0]),
      success: ({ tapIndex }) => actions[tapIndex] && this[actions[tapIndex][1]](),
    });
  },
  openMistakes() {
    wx.navigateTo({ url: "/pages/mistakes/index" });
  },
  openReview() {
    wx.navigateTo({ url: "/pages/review/index" });
  },
  startNote() {
    wx.navigateTo({ url: "/pages/capture/index?kind=note" });
  },
  startProblem() {
    wx.navigateTo({ url: "/pages/capture/index?kind=problem" });
  },
}));
