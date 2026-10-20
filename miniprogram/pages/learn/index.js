/*
 * 学习首页：汇总学习入口、进度及工具导航；地图和具体练习由各自页面承担。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const auth = require("../../utils/auth");
const gate = require("../../utils/gate");
const learningSpace = require("../../utils/learning-space");
const { openAsk } = require("../../utils/chat-entry");
const { asset } = require("../../utils/assets");
const { monthDay: dateText } = require("../../utils/format");
const studyClock = require("../../utils/study-clock");
const {
  stampOf,
  weekLine,
  pointCount,
  retryText,
  xpLine,
  backTo,
  ROUTES,
} = require("../../utils/learn");
const { lookOf } = require("../../utils/point-look");

// 学习 : the map first, then every way to solve as tiles (each opens
// the 解题 page), 今天, then 段位贴纸, 我的资料 and 学习记录, moved here from 我的.
// What brought a point back, said the way a friend would.
const RETEST_CAUSE = {
  explanation: "前几天看过解析",
  hint: "前几天看过提示",
  ask: "前几天问过 AI",
  stuck: "前几天卡住过",
  wrong: "上次没做出来",
};

function pointIndex(map) {
  const result = new Map();
  (map.chapters || []).forEach((chapter) =>
    (chapter.points || []).forEach((point) => result.set(point.id, point)),
  );
  return result;
}
function todayView(item, points) {
  const point = points.get(item.id) || {},
    reason = point.stateReason || {};
  const date = dateText(reason.at || reason.on);
  const meta =
    item.kind === "retest"
      ? `${RETEST_CAUSE[item.retest && item.retest.cause] || "上次"}，换道题再试试`
      : item.kind === "review"
        ? `${date ? `${date} 做对的` : "前些天做对的"}，再看一眼`
        : `${item.chapter} · ${item.tier}`;
  const stuck = item.retest && item.retest.cause === "stuck";
  return {
    ...item,
    cell: lookOf(item).cell,
    // Never opened: it starts with the explanation, not a problem.
    learn: lookOf(point).key === "none",
    // The little star matches the map (pages/map/stars.js).
    star:
      item.kind === "retest"
        ? stuck
          ? "stuck"
          : "pend"
        : item.kind === "review"
          ? "due"
          : "next",
    act: item.kind === "retest" ? "再试" : item.kind === "review" ? "复习" : "学",
    meta,
  };
}
function currentChapter(map) {
  const chapters = (map.chapters || []).filter((chapter) => !chapter.hidden);
  const nextChapter =
    map.summary && map.summary.next && map.summary.next.chapterId;
  return (
    chapters.find((chapter) => chapter.id === nextChapter) ||
    chapters.find((chapter) => chapter.started) ||
    chapters[0] ||
    null
  );
}
function view(map, owner, stats) {
  const summary = map.summary || {},
    points = pointIndex(map);
  const continuation = learningSpace.continuation(map, owner),
    resume =
      !map.resumeActive && continuation && continuation.label === "继续上次"
        ? continuation
        : null;
  const chapter = currentChapter(map);
  const main = (chapter && chapter.main) || { correct: 0, total: 0 },
    next = chapter && chapter.next;
  // The hero is the chapter's next point; the last opened point joins it when
  // they are the same, and stays a small link when they are not.
  const untouched = (id) => lookOf(points.get(id) || {}).key === "none";
  const hero =
    next && next.id
      ? {
          id: next.id,
          name: next.name,
          learn: !(resume && resume.id === next.id) && untouched(next.id),
          label: resume && resume.id === next.id ? "继续上次" : "接着学",
          resume:
            resume && resume.id !== next.id
              ? { id: resume.id, name: resume.name }
              : null,
        }
      : resume
        ? { id: resume.id, name: resume.name, label: "继续上次", resume: null }
        : { id: "", name: "看看地图，挑一个点", label: "接着学", resume: null };
  const today = (summary.todayList || []).map((item) =>
    todayView(item, points),
  );
  const fresh = today.filter((item) => item.kind === "new").length,
    reviews = today.length - fresh;
  // Unfinished look-backs only; the hero and the resume link are not repeated.
  const todayDue = today
    .filter(
      (item) =>
        (item.kind === "review" || item.kind === "retest") &&
        !item.done &&
        item.id !== hero.id &&
        (!hero.resume || item.id !== hero.resume.id),
    )
    .filter(
      (item, index, rows) => rows.findIndex((row) => row.id === item.id) === index,
    );
  // One new point after the look-backs, unless it is the hero already.
  const todayNew =
    today.find(
      (item) => item.kind === "new" && !item.done && item.id !== hero.id,
    ) || null;
  return {
    continuation,
    resume,
    hero,
    subtitle: `${map.title} · 同济第八版 · ${pointCount(map.chapters || [])} 个点`,
    heroSub: chapter
      ? `${`${chapter.book || ""} ${chapter.short || chapter.label || ""}`.trim()}${next && next.key ? " · 重点" : ""}`
      : "",
    map: chapter
      ? {
          chapterId: chapter.id,
          progress: Number(main.total)
            ? Math.round((Number(main.correct || 0) * 100) / Number(main.total))
            : 0,
          chapter:
            `${chapter.book || ""} ${chapter.short || chapter.label || ""}`.trim(),
          correct: Number(main.correct || 0),
          total: Number(main.total || 0),
          nextId: next && next.id,
        }
      : null,
    level: Number(summary.level || 1),
    correct: Number(summary.correct || 0),
    xp: Number(summary.xp || 0),
    // 以为会 / 真会, once there are a few retests to compare (GET /v1/cards/stats).
    retest:
      stats && stats.retestCount >= 3
        ? { predicted: stats.predicted, actual: stats.actual }
        : null,
    // Chapters set aside (先放着) get no sticker.
    stickers: learningSpace.stickers(map).filter((s) => !s.hidden),
    correctText: `${Number(summary.correct || 0)}/${Number(summary.total || 0)}`,
    xpText: xpLine(summary),
    chips: (map.chapters || [])
      .filter((item) => !item.hidden)
      .map((item) => ({
        id: item.id,
        short: item.short,
        started: item.started,
        rank: item.rank,
        stamp: stampOf(item.rank),
        ext: item.extDone,
      })),
    next: (summary.next && summary.next.text) || "看看学习地图",
    nextId: summary.next && summary.next.chapterId,
    book:
      summary.book && summary.book.reached
        ? {
            rank: summary.book.rank,
            stamp: stampOf(summary.book.rank),
            text: `已到基础段 ${summary.book.reached}/${summary.book.of}`,
          }
        : null,
    week: weekLine(summary),
    // "3 个复习 · 1 个新的" right after 今天: today's look-backs (复习 and
    // 再试) and new points.
    todaySide: summary.todayDone
      ? "今天的做完了"
      : [reviews ? `${reviews} 个复习` : "", fresh ? `${fresh} 个新的` : ""]
          .filter(Boolean)
          .join(" · "),
    today,
    todayDone: Boolean(summary.todayDone),
    todayDue,
    todayNew,
    // 错题本 tile: "12 道没弄懂" (open mistakes, GET /v1/learn/map mistakesOpen).
    mistakes: Number(map.mistakesOpen || 0),
  };
}

Page(studyClock.track({
  data: {
    guest: false,
    loading: true,
    error: "",
    card: null,
    todayOpen: false,
    moreOpen: false,
    // 3D icons served by /v1/assets (utils/assets.js), outside the main package.
    icons: {
      camera: asset("ic-camera-with-flash.webp"),
      ledger: asset("ic-ledger.webp"),
      bullseye: asset("ic-bullseye.webp"),
      memo: asset("ic-memo.webp"),
      page: asset("ic-page-facing-up.webp"),
      teach: asset("ic-speech-balloon.webp"),
    },
    broken: {},
  },
  // The consent panel that used to sit here is gone: agreeing (with the age
  // question) happens on the welcome page only.
  onShow() {
    this.alive = true;
    if (!gate.check()) {
      // Consent withdrawn while away: drop the card and any pending response.
      this.loadVersion = (this.loadVersion || 0) + 1;
      this.setData({ card: null, loading: false });
      return;
    }
    // A guest sees the page without anything personal and sends nothing.
    if (gate.state() === "guest") {
      this.loadVersion = (this.loadVersion || 0) + 1;
      this.owner = undefined;
      this.setData({ guest: true, card: null, loading: false, error: "" });
      return;
    }
    const owner = (auth.getUser() || {}).id;
    if (owner !== this.owner || this.data.guest) this.setData({ card: null });
    this.owner = owner;
    this.setData({ guest: false });
    this.load();
  },
  onHide() {
    this.alive = false;
    this.loadVersion = (this.loadVersion || 0) + 1;
  },
  onUnload() {
    this.onHide();
  },
  onPullDownRefresh() {
    if (this.data.guest) return wx.stopPullDownRefresh();
    return this.load().then(() => wx.stopPullDownRefresh());
  },
  active(version, owner) {
    return (
      this.alive !== false &&
      version === this.loadVersion &&
      auth.hasConsent() &&
      owner === (auth.getUser() || {}).id
    );
  },
  load() {
    const version = (this.loadVersion = (this.loadVersion || 0) + 1);
    if (gate.state() !== "ok") {
      this.setData({ card: null, loading: false });
      return Promise.resolve();
    }
    let owner;
    const active = () => this.alive !== false && version === this.loadVersion;
    this.setData({ loading: true, error: "" });
    return auth
      .login()
      .then(() => {
        if (!active() || !auth.hasConsent()) return null;
        owner = (auth.getUser() || {}).id;
        // The card stats only add 以为会 / 真会; the page opens without them.
        return Promise.all([api.get("/v1/learn/map"), api.get("/v1/cards/stats").catch(() => null)]);
      })
      .then((result) => {
        const [map, stats] = result || [];
        if (!map || !active() || !auth.hasConsent()) return;
        const currentOwner = (auth.getUser() || {}).id;
        if (owner !== currentOwner) {
          this.setData({ card: null });
          return this.load();
        }
        this.owner = currentOwner;
        this.setData({ card: view(map, currentOwner, stats) });
      })
      .catch((error) => {
        if (!active()) return;
        const currentOwner = (auth.getUser() || {}).id;
        if (
          error &&
          error.code === "SESSION_CHANGED" &&
          auth.hasConsent() &&
          owner &&
          currentOwner &&
          owner !== currentOwner
        ) {
          this.setData({ card: null });
          return this.load();
        }
        if (api.needsConsent(error)) this.setData({ card: null });
        else this.setData({ error: retryText(error) });
      })
      .finally(() => {
        if (active()) this.setData({ loading: false });
      });
  },
  // each tool opens its own start (拍照 / 相册, or what to explain).
  askPhoto() {
    if (this.data.guest) return gate.ask();
    openAsk({ start: true });
  },
  // one 批改 for a problem's steps or a whole page.
  askGrade() {
    if (this.data.guest) return gate.ask();
    backTo(require("../../utils/tools").ROUTE.grade);
  },
  askTeach() {
    if (this.data.guest) return gate.ask();
    backTo(ROUTES.teach);
  },
  // 练一题 opens the 题库; a guest can look at the list too.
  openPractice() {
    backTo(ROUTES.bank);
  },
  toggleToday() {
    this.setData({ todayOpen: !this.data.todayOpen });
  },
  toggleMore() {
    this.setData({ moreOpen: !this.data.moreOpen });
  },
  openMistakes() {
    if (this.data.guest) return gate.ask();
    wx.navigateTo({ url: "/pages/mistakes/index" });
  },
  openLibrary() {
    if (this.data.guest) return gate.ask();
    backTo("pages/library/index");
  },
  openReview() {
    if (this.data.guest) return gate.ask();
    wx.navigateTo({ url: "/pages/review/index" });
  },
  startNote() {
    if (this.data.guest) return gate.ask();
    wx.navigateTo({ url: "/pages/capture/index?kind=note" });
  },
  startProblem() {
    if (this.data.guest) return gate.ask();
    wx.navigateTo({ url: "/pages/capture/index?kind=problem" });
  },
  // A point never opened starts with its explanation (知识点详情).
  openPoint(event) {
    if (this.data.guest) return gate.ask();
    const { id, learn } = event.currentTarget.dataset;
    backTo(learn ? ROUTES.knowledge : ROUTES.point, id);
  },
  // The map centers on the next point itself; an id would also open its panel.
  openMap() {
    backTo(ROUTES.map);
  },
  startNext() {
    if (this.data.guest) return this.openMap();
    const hero = this.data.card && this.data.card.hero;
    if (!hero) return;
    if (hero.id) backTo(hero.learn ? ROUTES.knowledge : ROUTES.point, hero.id);
    else this.openMap();
  },
  continueLearning() {
    if (this.data.guest) return gate.ask();
    const next = this.data.card && this.data.card.continuation;
    if (!next || this.data.loading) return;
    backTo(next.id ? ROUTES.point : ROUTES.map, next.id || undefined);
  },
  // A picture that does not load is hidden, not left broken.
  iconBroken(event) {
    this.setData({ [`broken.${event.currentTarget.dataset.name}`]: true });
  },
  openRanks() {
    if (this.data.guest) return gate.ask();
    backTo(ROUTES.ranks);
  },
  openChapter(event) {
    if (this.data.guest) return gate.ask();
    backTo(ROUTES.chapter, event.currentTarget.dataset.id);
  },
  openNext() {
    if (this.data.guest) return gate.ask();
    const id = this.data.card && this.data.card.nextId;
    if (id) backTo(ROUTES.chapter, id);
  },
}));
