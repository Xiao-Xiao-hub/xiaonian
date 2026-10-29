const { withShare } = require("../../utils/share");
/*
 * 学习地图：加载知识点图与本人进度，处理缩放、定位、点击和横屏入口；绘制辅助在本目录。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const auth = require("../../utils/auth");
const gate = require("../../utils/gate");
const { request } = require("../../utils/request");
const { errorText } = require("../../utils/format");
const { backTo, ROUTES } = require("../../utils/learn");
const { lookOf } = require("../../utils/point-look");
const stars = require("./stars");
const studyClock = require("../../utils/study-clock");

// 知识点地图：
// a night sky with the chapter's stars (far) or knowledge cards (near). A tap
// on a star or card opens the point's detail page (pages/knowledge),
// which took over the old detail sheet; 练一题 on a card opens practice. The old route boxes and the 关系 view are not
// shown any more; their code stays in layout.js and the landscape page.
//
// Signed in: GET /v1/learn/map?cards=1&tone=dark (state + card blocks).
// Guest: GET /v1/learn/map/public?tone=dark, no progress, every point 没碰过,
// and anything that needs an account asks first (gate.ask).
// Same keys as before: utils/learning-space.js clear removes them on withdrawal.
const STORAGE = "v2_map_view";
const CACHE = "v2_map_cache";

function guest() {
  return gate.state() === "guest";
}
function owned(page) {
  const owner = (auth.getUser() || {}).id;
  return () =>
    page.alive && auth.hasConsent() && owner === (auth.getUser() || {}).id;
}
function chapterTab(chapter, isGuest) {
  const mains = (chapter.points || []).filter((p) => p.line !== "side");
  const main = chapter.main || {};
  const total = Number(main.total || mains.length || 0);
  const correct = isGuest
    ? 0
    : Number(
        main.correct ||
          mains.filter((p) => ["correct", "due"].includes(p.state)).length ||
          0,
      );
  return {
    id: chapter.id,
    name: chapter.short,
    correct,
    total,
    progress: total ? Math.round((correct * 100) / total) : 0,
  };
}
function bookRow(chapter, isGuest) {
  const points = (chapter.points || []).filter((p) => p.line !== "side");
  return {
    ...chapterTab(chapter, isGuest),
    book: chapter.book,
    short: chapter.short,
    dots: points.map((p) => ({
      id: p.id,
      cls: isGuest ? "none" : stars.starState(p, ""),
    })),
    hidden: !isGuest && chapter.hidden,
  };
}
function bookProgress(chapters, isGuest) {
  const tabs = chapters
    .filter((c) => isGuest || !c.hidden)
    .map((c) => chapterTab(c, isGuest));
  const total = tabs.reduce((n, t) => n + t.total, 0);
  const correct = tabs.reduce((n, t) => n + t.correct, 0);
  return total ? Math.round((correct * 100) / total) : 0;
}
// The line when a chapter has no 下一步 : not started, all done, all
// taught done, or simply nothing to suggest; never 做对了 without the facts.
function noNextText(chapter, taughtTo) {
  const points = (chapter && chapter.points) || [];
  const done = (p) => p.state === "correct" || p.state === "due";
  const taught = points.filter((p) => p.taught !== false);
  if (taughtTo === "none" || (points.length && !taught.length))
    return "老师还没讲到这章，点任意一颗星先看看";
  if (points.length && points.every(done)) return "这一章都做对了，点任意一颗星回头看看";
  if (taught.length && taught.every(done)) return "讲到的都做对了，后面的还没开讲";
  return "暂时没有推荐，点任意一颗星看看";
}
function findPoint(map, id) {
  for (const chapter of (map && map.chapters) || []) {
    const point = (chapter.points || []).find((item) => item.id === id);
    if (point) return { chapter, point };
  }
  return null;
}
function sectionChoices(chapter) {
  return [
    ...new Set(
      ((chapter && chapter.points) || []).map((p) => p.section).filter(Boolean),
    ),
  ];
}
Page(withShare(studyClock.track({
  data: {
    loading: true,
    error: "",
    fail: "",
    busy: false,
    guest: false,
    navTop: 24,
    navHeight: 44,
    chapters: [],
    bookRows: [],
    chapter: null,
    chapterId: "",
    tab: null,
    bookMode: false,
    layout: null,
    motion: `0,0,${stars.FAR},0`,
    scale: stars.FAR,
    zoom: "far",
    edgeNext: null,
    dragging: false,
    bookProgress: 0,
    taughtLink: "",
    noNext: "",
    taughtOpen: false,
    taughtChapter: "",
    taughtSections: [],
    legendOpen: false,
    next: null,
  },
  onLoad(query) {
    this.alive = true;
    this.query = query || {};
    const info =
      typeof wx.getWindowInfo === "function"
        ? wx.getWindowInfo()
        : { windowWidth: 375, windowHeight: 667, statusBarHeight: 24 };
    const capsule =
      typeof wx.getMenuButtonBoundingClientRect === "function"
        ? wx.getMenuButtonBoundingClientRect()
        : { top: info.statusBarHeight || 24, height: 32 };
    this.screen = {
      width: info.windowWidth || 375,
      height: info.windowHeight || 667,
      ratio: info.pixelRatio || 2,
    };
    this.viewport = {
      width: info.windowWidth || 375,
      height: Math.max(
        320,
        (info.windowHeight || 667) - capsule.top - capsule.height - 74,
      ),
    };
    this.setData({ navTop: capsule.top, navHeight: capsule.height });
  },
  onShow() {
    this.alive = true;
    if (!gate.check()) return;
    const isGuest = guest();
    // Agreeing (or going back to guest mode) elsewhere starts over.
    if (this.shown && isGuest !== this.data.guest) {
      this.map = null;
      this.owner = undefined;
      this.initialized = false;
    }
    this.setData({ guest: isGuest });
    this.load({ keep: Boolean(this.shown && this.map) });
    this.shown = true;
  },
  onHide() {
    this.alive = false;
    this.epoch = (this.epoch || 0) + 1;
    this.loadRequest = null;
  },
  onUnload() {
    this.alive = false;
    this.unloaded = true;
    this.epoch = (this.epoch || 0) + 1;
    this.loadRequest = null;
  },
  // the meteors are CSS behind the map (index.wxml.sky-back); the
  // full-screen canvas (meteors.js, no longer used) is gone.
  load(options = {}) {
    if (this.loadRequest) return this.loadRequest;
    if (guest()) return this.loadPublic(options);
    const epoch = this.epoch || 0;
    let active = () => this.alive && (this.epoch || 0) === epoch;
    this.setData({ loading: true, error: "" });
    const request = auth
      .login()
      .then(() => {
        if (!active()) return null;
        const sameOwner = owned(this);
        active = () => sameOwner() && (this.epoch || 0) === epoch;
        const owner = (auth.getUser() || {}).id;
        if (this.owner !== owner) {
          this.owner = owner;
          this.map = null;
          this.initialized = false;
          this.restore = wx.getStorageSync(`${STORAGE}:${owner}`) || {};
        }
        return api.get(
          `/v1/learn/map?view=task&level=${this.data.zoom}&cards=1&tone=dark`,
        );
      })
      .then((map) => {
        if (!map || !active()) return;
        try {
          wx.setStorageSync(`${CACHE}:${this.owner}`, map);
        } catch (_) {}
        this.renderMap(map, options);
      })
      .catch((error) => {
        if (!active()) return;
        if (api.needsConsent(error)) return;
        const cached =
          this.owner && wx.getStorageSync(`${CACHE}:${this.owner}`);
        if (cached && Array.isArray(cached.chapters) && cached.chapters.length) {
          this.renderMap(cached, options);
          this.setData({ error: "网络不太好，先给你看上次的地图" });
        } else this.setData({ error: errorText(error) });
      })
      .finally(() => {
        if (this.loadRequest === request) this.loadRequest = null;
        if (active()) this.setData({ loading: false });
      });
    this.loadRequest = request;
    return request;
  },
  // 游客：只有结构和知识卡，不登录、不记事件。
  loadPublic(options = {}) {
    if (this.map && this.map.public) {
      this.renderMap(this.map, { ...options, keep: true });
      return Promise.resolve();
    }
    const epoch = this.epoch || 0;
    const active = () => this.alive && (this.epoch || 0) === epoch && guest();
    this.setData({ loading: true, error: "" });
    const pending = request({ url: "/v1/learn/map/public?tone=dark" })
      .then((body) => {
        const map = body && body.data;
        if (!map || !active()) return;
        this.renderMap({ ...map, public: true }, options);
      })
      .catch((error) => {
        if (active()) this.setData({ error: errorText(error) });
      })
      .finally(() => {
        if (this.loadRequest === pending) this.loadRequest = null;
        if (active()) this.setData({ loading: false });
      });
    this.loadRequest = pending;
    return pending;
  },
  renderMap(map, options = {}) {
    this.map = map;
    const isGuest = Boolean(map.public);
    const requested =
      this.query && this.query.id && findPoint(map, this.query.id);
    const rememberedId =
      this.data.chapterId || (this.restore && this.restore.chapterId);
    const chapter =
      (requested && requested.chapter) ||
      map.chapters.find((c) => c.id === rememberedId) ||
      map.chapters[0];
    const initial = !this.initialized;
    this.initialized = true;
    this.setData({
      guest: isGuest,
      chapters: map.chapters.map((c) => chapterTab(c, isGuest)),
      bookRows: map.chapters.map((c) => bookRow(c, isGuest)),
      bookProgress: bookProgress(map.chapters, isGuest),
      taughtLink: isGuest ? "" : this.taughtLabel(map.taughtTo),
    });
    this.showChapter(
      !requested && rememberedId === "all" ? "all" : chapter.id,
      {
        keep: options.keep || !initial,
        scale: initial
          ? stars.clamp((this.restore && this.restore.s) || stars.FAR)
          : this.data.scale,
      },
    );
    // ?id= centres the map on that point (its detail is a page of its own now).
    if (requested) {
      this.query.id = "";
      this.focusPoint(requested.point.id);
    }
  },
  taughtLabel(value) {
    return value == null
      ? "老师讲到哪了？选一下，推荐更准 ›"
      : value === "all"
        ? "老师全讲完了 ›"
        : value === "none"
          ? "老师还没开讲 ›"
          : `老师讲到 ${value} ›`;
  },
  nextOf(chapter) {
    if (this.data.guest || !chapter.next || !chapter.next.id) return null;
    const point = (chapter.points || []).find((p) => p.id === chapter.next.id);
    return {
      ...chapter.next,
      key: Boolean((point && point.key) || chapter.next.key),
      hard: Boolean(point && point.hard),
      ready: Boolean(point && point.ready),
      // Never opened: it starts with the explanation, as on 学习.
      learn: Boolean(point && lookOf(point).key === "none"),
      pos: point && point.pos,
    };
  },
  layoutFor(chapter, focusId) {
    const next = this.nextOf(chapter);
    return stars.starLayout(chapter, {
      guest: this.data.guest,
      nextId: next && next.id,
      focusId: focusId || "",
      taughtTo: this.map && this.map.taughtTo,
    });
  },
  showChapter(id, options = {}) {
    if (!this.map) return;
    if (id === "all") {
      this.setData({ chapterId: "all", bookMode: true, chapter: null });
      this.persist();
      return;
    }
    const chapter = this.map.chapters.find((c) => c.id === id);
    if (!chapter) return;
    const same = options.keep && this.data.chapterId === id;
    const scale = stars.clamp(options.scale || this.data.scale);
    const next = this.nextOf(chapter);
    const layout = this.layoutFor(chapter, "");
    // The far view opens on the whole chapter; the cards on 下一步.
    const fit = !same && stars.tier(scale) === "far";
    const motion = same
      ? this.motionObject()
      : fit
        ? stars.fitView(layout, this.viewport, this.farHeight())
        : stars.openingView(layout, next && next.pos, this.viewport, scale);
    if (!same) this.fitted = fit;
    this.setData({
      chapter,
      chapterId: id,
      tab: chapterTab(chapter, this.data.guest),
      bookMode: false,
      layout,
      motion: this.motionString(motion),
      scale: motion.s,
      zoom: stars.tier(motion.s),
      next,
      noNext: next || this.data.guest ? "" : noNextText(chapter, this.map.taughtTo),
      edgeNext: this.edgeOf(next, motion),
    });
    this.persist();
  },
  // The part of the stage above the floating 下一步 card (far view only).
  farHeight() {
    const height = (this.viewport && this.viewport.height) || 560;
    return Math.max(160, height - (this.covered == null ? 150 : this.covered));
  },
  // The 下一步 capsule, kept inside the visible part of the stage.
  edgeOf(next, motion) {
    if (!next) return null;
    const view =
      stars.tier(motion.s) === "far"
        ? { width: this.viewport.width, height: this.farHeight() }
        : this.viewport;
    return stars.edgeNext(next.pos, motion, view);
  },
  // How much of the stage the 下一步 card covers, from the window bottom.
  measureNext() {
    if (typeof wx.createSelectorQuery !== "function") return;
    wx.createSelectorQuery()
      .in(this)
      .select(".nextp")
      .boundingClientRect((rect) => {
        if (!rect || !this.alive || !this.screen) return;
        const covered = Math.max(0, Math.round(this.screen.height - rect.top));
        if (covered === this.covered) return;
        this.covered = covered;
        if (this.fitted && this.data.zoom === "far") this.refit();
      })
      .exec();
  },
  refit() {
    if (!this.data.layout || !this.data.chapter || this.data.bookMode) return;
    const motion = stars.fitView(this.data.layout, this.viewport, this.farHeight());
    this.setData({
      motion: this.motionString(motion),
      scale: motion.s,
      zoom: stars.tier(motion.s),
      edgeNext: this.edgeOf(this.data.next, motion),
    });
    this.fitted = true;
  },
  selectChapter(event) {
    this.showChapter(event.currentTarget.dataset.id);
  },
  // A star or a card: the point's detail page.
  nodeTap(event) {
    this.openDetail(event.detail.id);
  },
  // 练一题 on a card (every card since V4.1). Questions not out yet: the
  // detail page says so (题还在出，稍等).
  practiceTap(event) {
    const found = findPoint(this.map, event.detail.id);
    if (!found) return;
    if (this.data.guest) return gate.ask();
    if (!found.point.ready) return this.openDetail(found.point.id);
    backTo(ROUTES.point, found.point.id);
  },
  openDetail(id) {
    const found = findPoint(this.map, id);
    if (!found) return;
    this.track("node_open", { pointId: id, chapterId: found.chapter.id, view: "task" });
    backTo(ROUTES.knowledge, id);
  },
  centerOn(point) {
    if (!point || !point.pos) return;
    const motion = stars.focusOn(point.pos, this.viewport, this.data.scale, false);
    this.fitted = false;
    this.setData({
      motion: this.motionString(motion),
      edgeNext: this.edgeOf(this.data.next, motion),
    });
  },
  focusPoint(id) {
    const found = findPoint(this.map, id);
    if (!found) return;
    if (this.data.chapterId !== found.chapter.id) this.showChapter(found.chapter.id);
    this.centerOn(found.point);
  },
  nextTap() {
    const next = this.data.next;
    if (!next || !next.id) return;
    this.track("next_tap", { pointId: next.id, chapterId: this.data.chapter.id });
    if (next.ready && !next.learn) backTo(ROUTES.point, next.id);
    else backTo(ROUTES.knowledge, next.id);
  },
  backToNext() {
    if (this.data.next && this.data.next.id) this.focusPoint(this.data.next.id);
  },
  // − shows the whole chapter as stars; + goes to the cards around the middle.
  zoomOut() {
    if (!this.data.layout) return;
    this.stageSettle({
      detail: stars.fitView(this.data.layout, this.viewport, this.farHeight()),
    });
    this.fitted = true;
  },
  zoomIn() {
    this.zoomBy(stars.NEAR);
  },
  zoomBy(target) {
    const motion = stars.zoomTo(this.motionObject(), target, this.viewport);
    this.stageSettle({ detail: motion });
  },
  stageSettle(event) {
    const detail = event.detail,
      s = stars.clamp(detail.s);
    const zoom = stars.tier(s),
      changed = zoom !== this.data.zoom;
    const motion = { tx: detail.tx, ty: detail.ty, s };
    this.fitted = false;
    this.setData({
      scale: s,
      zoom,
      motion: this.motionString(motion),
      edgeNext: this.edgeOf(this.data.next, motion),
    });
    if (changed && zoom === "far") this.measureNext();
    this.persist();
    if (changed)
      this.track("map_zoom", {
        level: zoom,
        chapterId: this.data.chapter && this.data.chapter.id,
        view: "task",
      });
  },
  stageReady(event) {
    const rect = event.detail || {};
    if (!Number(rect.width) || !Number(rect.height)) return;
    this.measureNext();
    const previous = this.viewport;
    if (
      previous &&
      previous.width === Number(rect.width) &&
      previous.height === Number(rect.height)
    )
      return;
    this.viewport = { width: Number(rect.width), height: Number(rect.height) };
    if (!this.data.chapter || this.data.bookMode || !previous) return;
    // A fitted chapter is fitted again; anything else keeps its middle.
    if (this.fitted && this.data.zoom === "far") return this.refit();
    const motion = this.motionObject();
    const moved = { ...motion, ty: motion.ty + (this.viewport.height - previous.height) / 2 };
    this.setData({
      motion: this.motionString(moved),
      edgeNext: this.edgeOf(this.data.next, moved),
    });
  },
  stageDragging(event) {
    this.setData({ dragging: Boolean(event.detail.dragging) });
  },
  parseMotion(value) {
    const p = String(value).split(",");
    return { tx: Number(p[0]) || 0, ty: Number(p[1]) || 0, s: stars.clamp(p[2]) };
  },
  motionObject() {
    return this.parseMotion(this.data.motion);
  },
  motionString(value) {
    this.motionSeq = (this.motionSeq || 0) + 1;
    return `${value.tx || 0},${value.ty || 0},${stars.clamp(value.s)},${this.motionSeq}`;
  },
  persist() {
    if (!this.owner || this.data.guest) return;
    try {
      wx.setStorageSync(`${STORAGE}:${this.owner}`, {
        chapterId: this.data.chapterId,
        ...this.motionObject(),
      });
    } catch (_) {}
  },
  // Events are personal: none for a guest.
  track(name, data) {
    if (this.data.guest || guest()) return;
    const active = owned(this);
    api
      .post("/v1/learn/map/events", { name, ...data })
      .then(() => active())
      .catch(() => {});
  },
  openTaught() {
    if (this.data.guest) return gate.ask();
    const chapter = this.data.chapter || (this.map && this.map.chapters[0]);
    this.setData({
      taughtOpen: true,
      taughtChapter: (chapter && chapter.id) || "",
      taughtSections: sectionChoices(chapter),
    });
  },
  chooseTaughtChapter(event) {
    const id = event.currentTarget.dataset.id,
      chapter = this.map.chapters.find((c) => c.id === id);
    this.setData({ taughtChapter: id, taughtSections: sectionChoices(chapter) });
  },
  saveTaught(event) {
    const value = event.currentTarget.dataset.value;
    if (!value || this.data.busy) return;
    const active = owned(this);
    this.setData({ busy: true, fail: "" });
    return api
      .put("/v1/me/settings", { taughtTo: value })
      .then((result) => {
        if (!active()) return;
        const taughtTo =
          result && result.taughtTo !== undefined ? result.taughtTo : value;
        this.map.taughtTo = taughtTo;
        this.setData({ taughtLink: this.taughtLabel(taughtTo), taughtOpen: false });
        wx.showToast({ title: "记下了，推荐会跟着变", icon: "none" });
        return this.load({ keep: true });
      })
      .catch((error) => {
        if (active() && !api.needsConsent(error)) this.setData({ fail: errorText(error) });
      })
      .finally(() => {
        if (active()) this.setData({ busy: false });
      });
  },
  closeTaught() {
    this.setData({ taughtOpen: false });
  },
  toggleLegend() {
    this.setData({ legendOpen: !this.data.legendOpen });
  },
  sheet(actions) {
    const alive = () => this.alive;
    wx.showActionSheet({
      itemList: actions.map((item) => item.label),
      success: ({ tapIndex }) => {
        if (alive() && actions[tapIndex]) actions[tapIndex].run();
      },
    });
  },
  // ⋯ holds the rarely used tools; an action sheet takes at most 6.
  openMenu() {
    const chapter = this.data.bookMode ? null : this.data.chapter;
    if (this.data.guest)
      return this.sheet([
        { label: "这些颜色啥意思", run: () => this.toggleLegend() },
        { label: "老师讲到哪了", run: () => gate.ask() },
        { label: "我的进度", run: () => gate.ask() },
      ]);
    this.sheet([
      { label: "这些颜色啥意思", run: () => this.toggleLegend() },
      { label: "老师讲到哪了", run: () => this.openTaught() },
      {
        label: "我的进度",
        run: () => backTo(ROUTES.ranks, chapter ? chapter.id : undefined),
      },
      ...(chapter
        ? [
            { label: "整章标记", run: () => this.openChapterMarks(chapter) },
            {
              label: "横过来看",
              run: () =>
                wx.navigateTo({
                  url: `/pages/map/landscape/index?id=${encodeURIComponent(chapter.id)}`,
                }),
            },
          ]
        : []),
    ]);
  },
  openChapterMarks(chapter) {
    this.sheet([
      { label: "这章剩下的我都会", run: () => this.markChapter("selfRest", chapter.id) },
      ...(chapter.self
        ? [
            {
              label: `这章标过的“我会了”都撤掉（${chapter.self} 个）`,
              run: () => this.confirmUnself(chapter),
            },
          ]
        : []),
      {
        label: chapter.hidden ? "这章放回来" : "这章先放着",
        run: () => this.markChapter(chapter.hidden ? "unhide" : "hide", chapter.id),
      },
    ]);
  },
  confirmUnself(chapter) {
    const active = owned(this);
    wx.showModal({
      title: "撤掉这章的“我会了”？",
      content: `这章 ${chapter.self} 个你说会了的点会变回原样，做对过的不受影响。`,
      confirmText: "撤掉",
      success: ({ confirm }) => {
        if (confirm && active()) this.markChapter("unselfRest", chapter.id);
      },
    });
  },
  markChapter(action, chapterId) {
    if (this.data.busy) return;
    if (this.data.guest) return gate.ask();
    const active = owned(this);
    this.setData({ busy: true, fail: "" });
    return api
      .post("/v1/learn/marks", { action, chapterId })
      .then((result) => {
        if (!active()) return;
        const changed = Number((result && result.changed) || 0);
        wx.showToast({
          title:
            action === "selfRest"
              ? changed
                ? `好，这 ${changed} 个都算你会了`
                : "这章没剩下要标的了"
              : action === "unselfRest"
                ? "好，改回来了"
                : action === "hide"
                  ? "好，这章先放着"
                  : "这章放回来了",
          icon: "none",
        });
        return this.load({ keep: true });
      })
      .catch((error) => {
        if (!active() || api.needsConsent(error)) return;
        const rule = error && error.statusCode >= 400 && error.statusCode < 500;
        if (rule) wx.showToast({ title: errorText(error), icon: "none" });
        else this.setData({ fail: errorText(error) });
      })
      .finally(() => {
        if (active()) this.setData({ busy: false });
      });
  },
  restoreChapter() {
    if (this.data.chapter) this.markChapter("unhide", this.data.chapter.id);
  },
  hold() {},
  goLearn() {
    backTo(ROUTES.learn);
  },
})));

module.exports = { noNextText };
