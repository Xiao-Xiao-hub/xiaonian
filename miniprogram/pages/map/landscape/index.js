/*
 * 横屏地图：以横向视野展示地图，复用同一知识点和进度数据；保持原页面导航与点击规则。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../../utils/api");
const auth = require("../../../utils/auth");
const gate = require("../../../utils/gate");
const { backTo, ROUTES } = require("../../../utils/learn");
const { taskLayout, anchorMotion, relationLayout } = require("../layout");

// Zoomed in this far (plane scale; the page opens at.72 and stops at 1), the
// groups open up and each point is a card with its first formula and two keys
// (V4.1 G4, pages/map/layout.js detailLayout).
const DETAIL = 0.9;
// One plain line for any failure; the tap on it tries again.
const FAILED = "地图没加载出来，点一下再试";

function activeFor(page) {
  const owner = (auth.getUser() || {}).id;
  return () =>
    page.alive && auth.hasConsent() && owner === (auth.getUser() || {}).id;
}

Page({
  data: {
    loading: true,
    error: "",
    chapters: [],
    chapter: null,
    chapterId: "",
    view: "task",
    // v4 folds 关系 into the route view; the switch stays in the markup, hidden.
    showRelation: false,
    layout: { nodes: [], sides: [], edges: [], width: 900, height: 500 },
    motion: "18,0,.72,0",
    expandedId: "",
    detail: false,
  },
  onLoad(query) {
    this.alive = true;
    this.chapterId = (query && query.id) || "";
    if (!gate.check()) return;
    // Guests have no personal map; the portrait map shows the public one.
    if (gate.state() === "guest") return wx.navigateBack();
    this.load();
  },
  onShow() {
    this.alive = true;
    if (!gate.check() || gate.state() === "guest") return;
    // Back from a point's detail page or a problem: states may have changed.
    // A refresh keeps the chapter, the open group and the view.
    if (this.shown) this.load(Boolean(this.map));
    this.shown = true;
  },
  onHide() {
    this.alive = false;
  },
  onUnload() {
    this.alive = false;
  },
  load(refresh) {
    refresh = refresh === true;
    let active = () => this.alive;
    if (!refresh) this.setData({ loading: true, error: "" });
    return auth
      .login()
      .then(() => {
        if (!active()) return null;
        active = activeFor(this);
        return api.get("/v1/learn/map?cards=1&tone=dark");
      })
      .then((map) => {
        if (!map) return;
        if (!active()) return;
        this.map = map;
        const chapter =
          map.chapters.find((item) => item.id === this.chapterId) ||
          map.chapters[0];
        if (refresh && chapter.id === this.chapterId && this.data.view === "task")
          return this.setData({
            chapter,
            layout: taskLayout(chapter, this.data.expandedId, this.data.detail),
          });
        this.showChapter(chapter.id);
      })
      .catch((error) => {
        // A failed refresh keeps the map on screen.
        if (!refresh && active() && !api.needsConsent(error))
          this.setData({ error: FAILED });
      })
      .finally(() => {
        if (active()) this.setData({ loading: false });
      });
  },
  showChapter(id) {
    const chapter = this.map.chapters.find((item) => item.id === id);
    if (!chapter) return;
    this.chapterId = id;
    this.setData({
      chapters: this.map.chapters.map((item) => ({
        id: item.id,
        short: item.short,
      })),
      chapter,
      chapterId: id,
      view: "task",
      layout: taskLayout(chapter, "", this.data.detail),
      expandedId: "",
      error: "",
    });
  },
  selectChapter(event) {
    this.showChapter(event.currentTarget.dataset.id);
  },
  switchView(event) {
    const view = event.currentTarget.dataset.view;
    if (view === this.data.view) return;
    if (view === "task")
      return this.setData({
        view,
        layout: taskLayout(this.data.chapter, this.data.expandedId, this.data.detail),
      });
    const chapterId = this.data.chapterId;
    const active = activeFor(this);
    this.setData({ error: "" });
    return api
      .get(`/v1/learn/map/graph?chapter=${encodeURIComponent(chapterId)}`)
      .then((graph) => {
        if (
          !active() ||
          this.data.chapterId !== chapterId ||
          graph.chapterId !== chapterId
        )
          return;
        this.graph = graph;
        this.setData({
          view,
          layout: relationLayout(this.data.chapter, graph, ""),
        });
      })
      .catch((error) => {
        if (active() && !api.needsConsent(error))
          this.setData({ error: FAILED });
      });
  },
  groupTap(event) {
    const node = [
      ...(this.data.layout.nodes || []),
      ...(this.data.layout.sides || []),
    ].find((item) => item.id === event.detail.id);
    if (!node) return;
    if (!event.detail.group) return this.openNode(node.members[0].id);
    // Zoomed in every group is open; its head does nothing.
    if (this.data.detail && this.data.view === "task") return;
    const expandedId = this.data.expandedId === node.id ? "" : node.id;
    this.setData({
      expandedId,
      layout: taskLayout(this.data.chapter, expandedId),
    });
  },
  nodeTap(event) {
    this.openNode(event.detail.id);
  },
  // A tap on a point opens its detail page.
  openNode(id) {
    const point = this.data.chapter.points.find((item) => item.id === id);
    if (point) backTo(ROUTES.knowledge, id);
  },
  stageReady(event) {
    this.viewport = event.detail;
  },
  stageSettle(event) {
    const d = event.detail;
    const detail = Number(d.s) >= DETAIL;
    this.motionSeq = (this.motionSeq || 0) + 1;
    if (detail === this.data.detail || this.data.view !== "task" || !this.data.chapter)
      return this.setData({ motion: `${d.tx},${d.ty},${d.s},${this.motionSeq}`, detail });
    // Across the line the boxes change size: keep what is in the middle of
    // the screen where it was.
    const layout = taskLayout(this.data.chapter, this.data.expandedId, detail);
    const at = anchorMotion(this.data.layout, layout, d, this.viewport);
    this.setData({ layout, detail, motion: `${at.tx},${at.ty},${at.s},${this.motionSeq}` });
  },
  retry() {
    // Only the relation graph can fail once the map is in.
    if (!this.map) return this.load();
    return this.switchView({ currentTarget: { dataset: { view: "relation" } } });
  },
  back() {
    wx.navigateBack();
  },
});
