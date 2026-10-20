/*
 * 知识点详情：展示概念、公式与相关卡片，并提供标记、卡点求助和练习入口。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
// 知识点详情 : what a point is, why it matters, how it works,
// its formulas, three keys, a worked example and its neighbours; 练一题 at the
// bottom. Everything the map's old detail sheet offered lives here too (问一问,
// 讲一遍, 卡住了 / 现在懂了, 我会了 / 其实还没会, 记一张卡, 我的卡, 相关错题,
// and the state details); the actions are utils/point-actions.js.
//
// Signed in: GET /v1/learn/points/:id/detail; opening the example's solution
// records it as seen (POST …/example-shown), once per page.
// Guest: GET …/detail/public, no progress; anything personal asks first.
const api = require("../../utils/api");
const auth = require("../../utils/auth");
const gate = require("../../utils/gate");
const actions = require("../../utils/point-actions");
const { request } = require("../../utils/request");
const { monthDay: shortDate } = require("../../utils/format");
const { retryText, backTo, ROUTES } = require("../../utils/learn");
const { LOOKS, lookOf: sharedLook } = require("../../utils/point-look");
const { sideLabel } = require("../map/layout");
const studyClock = require("../../utils/study-clock");
const learningSpace = require("../../utils/learning-space");
const { once } = require("../../utils/tap");

const TONE = actions.TONE;
const TIER_CLS = { 基础: "base", 重点: "key", 难点: "hard", 拓展: "ext" };
const DONE = ["correct", "due", "self", "inferred"];
const RETEST_CAUSES = {
  explanation: "上次看了解析",
  hint: "上次看了提示",
  ask: "上次问过 AI",
  stuck: "上次卡住了",
  wrong: "上次差一点",
};
const CARD_TYPES = { question: "问题", method: "思路", idea: "想法", spark: "灵感" };
// The three keys' colour marks, in order.
const KEY_CLS = ["k1", "k2", "k3"];
// Reading this long counts as 看过, as opening 练一题 does.
const SEEN_AFTER = 8000;

// The star's look, as on the map (utils/point-look.js, V4.2).
function lookOf(d) {
  if (d.guest) return { cls: "none", text: LOOKS.none.text };
  const look = sharedLook(d);
  return { cls: look.cls, text: look.text };
}
function stateLine(reason) {
  const r = reason || {};
  return r.kind === "correct"
    ? `${shortDate(r.at)} 做对`
    : r.kind === "stuck"
      ? `${shortDate(r.at)} 卡住了`
      : r.kind === "self"
        ? "你说过会了"
        : r.kind === "inferred" && r.by
          ? `你做对了「${r.by.name}」，这个应该也会`
          : r.kind === "practice"
            ? `${shortDate(r.on)} 有提示帮忙，下次自己来`
            : r.kind === "seen"
              ? "看过了，还没自己做"
              : "";
}
function link(item, guest, chapterId) {
  return {
    id: item.id,
    name: item.name,
    done: !guest && DONE.includes(item.state),
    cross: item.chapterId !== chapterId,
  };
}
function exampleView(example) {
  if (!example || !example.problem) return null;
  const right = (example.solution && example.solution.correct) || {};
  const problem = example.problem;
  return {
    blocks: problem.blocks || [],
    choice: problem.format === "choice",
    questions: (problem.questions || []).map((q, i) => ({
      key: `q${i}`,
      blocks: q.blocks || [],
      options: (q.options || []).map((o) => ({
        id: o.id,
        blocks: o.blocks,
        right: (right.options || [])[i] === o.id,
      })),
    })),
    blanks: (problem.blanks || []).filter((b) => b.label),
    answer: right.blocks || [],
    explanation: (example.solution && example.solution.explanation) || null,
    // The example is one of the point's practice problems (V4.2: say so).
    bankNo: problem.total > 1 && Number.isInteger(problem.index) ? problem.index + 1 : 0,
  };
}
function view(d) {
  const guest = Boolean(d.guest);
  const look = lookOf(d);
  const prereqs = (d.prereqs || []).map((p) => link(p, guest, d.chapter.id));
  const cards = d.cards || { count: 0, items: [] };
  return {
    id: d.id,
    name: d.name,
    short: d.short,
    section: d.section,
    tier: d.tier,
    tierCls: TIER_CLS[d.tier] || "base",
    mark: d.line === "side" ? "" : d.hard ? "◆" : d.key ? "★" : "",
    markCls: d.hard ? "h" : "k",
    chapter: `${d.chapter.book} ${d.chapter.short}`,
    chapterId: d.chapter.id,
    look: look.cls,
    lookText: look.text,
    stateLine: guest ? "" : stateLine(d.stateReason),
    why: d.why || "",
    intro: d.intro || [],
    formulas: (d.formulas || []).map((f, i) => ({ key: `f${i}`, blocks: f.blocks, tex: f.tex, note: f.noteBlocks })),
    keys: (d.keys || []).map((k, i) => ({ key: `k${i}`, blocks: k.blocks, cls: KEY_CLS[i] || "k3" })),
    example: exampleView(d.example),
    prereqs,
    followers: (d.followers || []).map((p) => link(p, guest, d.chapter.id)),
    // The old sheet's details.
    exam: d.exam || "",
    lineText: d.line === "side" ? sideLabel(d.side) : "核心点",
    difficulty: d.level
      ? "●".repeat(Number(d.level)) + "○".repeat(Math.max(0, 3 - Number(d.level)))
      : "",
    missing: guest ? 0 : prereqs.filter((p) => !p.done).length,
    taught: d.taught !== false,
    retestText: d.retest
      ? `${shortDate(d.retest.dueOn) || "该再试了"} · ${RETEST_CAUSES[d.retest.cause] || "再做一题确认"}`
      : "",
    retestDue: Boolean(d.retest && d.retest.mode),
    mistakeCount: Number(d.mistakeCount || 0),
    cardCount: Number(cards.count || 0),
    cardItems: (cards.items || []).slice(0, 3).map((c) => ({ ...c, typeName: CARD_TYPES[c.type] || "" })),
    self: d.state === "self",
    // 我会了 changes nothing on a point already done (V4.2: not offered).
    canSelf: d.state !== "correct" && d.state !== "due",
    stuck: Boolean(d.stuck || d.stuckAt),
    ready: d.ready !== false && Boolean(d.bank && d.bank.problems),
    bankText: d.bank && d.bank.problems
      ? guest || !d.bank.done
        ? `${d.bank.problems} 道题`
        : `${d.bank.problems} 道题 · 做对 ${d.bank.correct}`
      : "",
  };
}

Page(studyClock.track({
  data: {
    loading: true,
    error: "",
    canRetry: true,
    fail: "",
    busy: false,
    guest: false,
    point: null,
    solutionOpen: false,
    ...actions.STUCK_CLOSED,
    stuckBusy: false,
    stuckOptions: actions.STUCK_OPTIONS,
  },
  onLoad(query) {
    this.alive = true;
    this.id = (query && query.id) || "";
  },
  onShow() {
    this.alive = true;
    if (!gate.check()) return;
    // Back from practice, a chat or a card: the state may have changed.
    this.load();
  },
  onHide() {
    this.alive = false;
    clearTimeout(this.seenTimer);
    actions.stopStuck(this);
  },
  onUnload() {
    this.alive = false;
    this.unloaded = true;
    clearTimeout(this.seenTimer);
    actions.stopStuck(this);
  },
  load() {
    const guest = gate.state() === "guest";
    const seq = (this.seq = (this.seq || 0) + 1);
    // Bound after login; until then (and when login fails) only the page and
    // the request order count, so a failure still shows and stops loading.
    let owner;
    const active = () =>
      this.alive &&
      seq === this.seq &&
      (guest || owner === undefined || owner === (auth.getUser() || {}).id);
    this.setData({ loading: true, error: "", guest });
    const url = `/v1/learn/points/${encodeURIComponent(this.id)}/detail`;
    const read = guest
      ? request({ url: `${url}/public?tone=${TONE}` }).then((body) => body && body.data)
      : auth.login().then(() => {
          if (!active()) return null;
          owner = (auth.getUser() || {}).id;
          return api.get(`${url}?tone=${TONE}`);
        });
    return read
      .then((d) => {
        if (!d || !active()) return;
        this.detail = d;
        wx.setNavigationBarTitle({ title: d.short || d.name || "知识点" });
        const point = view(d);
        this.setData({ point, guest: Boolean(d.guest) });
        if (d.guest) return;
        // 继续上次 comes back here; reading a while counts as 看过.
        learningSpace.remember(owner, point.id);
        this.markSeen(d);
        // A 卡点 help asked before leaving (or still on its way).
        if (point.stuck && !this.data.stuckReply)
          actions.loadStuck(this, point, (id) => this.nameOf(id));
      })
      .catch((error) => {
        if (active() && !api.needsConsent(error))
          this.setData({ error: retryText(error), canRetry: error.statusCode !== 404 });
      })
      .finally(() => {
        if (active()) this.setData({ loading: false });
      });
  },
  // After a mark (point-actions): read the point again.
  refresh() {
    return this.load();
  },
  markSeen(d) {
    if (this.seenSent || (d.state && d.state !== "none")) return;
    clearTimeout(this.seenTimer);
    this.seenTimer = setTimeout(() => {
      if (!this.alive || this.seenSent) return;
      this.seenSent = true;
      api
        .post("/v1/learn/marks", { action: "seen", pointId: this.id })
        .catch(() => {
          this.seenSent = false;
        });
    }, SEEN_AFTER);
  },
  nameOf(id) {
    const d = this.detail || {};
    const found = [...(d.prereqs || []), ...(d.followers || [])].find((p) => p.id === id);
    return found ? found.name : "";
  },
  toggleSolution() {
    const open = !this.data.solutionOpen;
    this.setData({ solutionOpen: open });
    if (open && !this.data.guest && !this.exampleShown) {
      this.exampleShown = true;
      api
        .post(`/v1/learn/points/${encodeURIComponent(this.id)}/example-shown`, {})
        .catch(() => {
          this.exampleShown = false;
        });
    }
  },
  practise() {
    const p = this.data.point;
    if (!p) return;
    if (this.data.guest) return gate.ask();
    if (!p.ready) return wx.showToast({ title: "题还在出，稍等", icon: "none" });
    if (!once(this)) return;
    // Back on a practice page in the stack: a finished problem moves on.
    getApp().globalData.practiseFresh = p.id;
    backTo(ROUTES.point, p.id);
  },
  openLinked(event) {
    const id = event.currentTarget.dataset.id;
    if (id && id !== this.id && once(this)) backTo(ROUTES.knowledge, id);
  },
  // The old sheet's actions.
  askAI() {
    return actions.startChat(this, this.data.point, "guide");
  },
  teachAI() {
    return actions.startChat(this, this.data.point, "teach");
  },
  toggleSelf() {
    return actions.toggleSelf(this, this.data.point);
  },
  collectCard() {
    actions.collectCard(this.data.point);
  },
  openCards() {
    actions.openCards(this.data.point);
  },
  openCard(event) {
    actions.openCard(event.currentTarget.dataset.id);
  },
  openMistakes() {
    actions.openMistakes(this.data.point);
  },
  openStuck() {
    return actions.openStuck(this, this.data.point);
  },
  closeStuck() {
    actions.closeStuck(this);
  },
  stuckInput(event) {
    this.setData({ stuckText: event.detail.value });
  },
  chooseStuck(event) {
    const text = event.currentTarget.dataset.text;
    this.setData({ stuckChoice: text, stuckText: text });
  },
  sendStuck() {
    return actions.sendStuck(this, this.data.point, (id) => this.nameOf(id));
  },
  understood() {
    return actions.understood(this, this.data.point);
  },
  // An answer tapped, or 接着聊: one conversation from the whole 卡点.
  stuckOption(event) {
    return actions.continueStuck(this, this.data.point, event.currentTarget.dataset.text);
  },
  continueStuck() {
    return actions.continueStuck(this, this.data.point);
  },
  stuckSuggest() {
    const id = this.data.stuckReply && this.data.stuckReply.suggest;
    if (!id) return;
    actions.closeStuck(this);
    backTo(ROUTES.knowledge, id);
  },
  collectStuck() {
    actions.collectCard(this.data.point, this.data.stuckText);
  },
  hold() {},
}));

module.exports = { view, lookOf, stateLine };
