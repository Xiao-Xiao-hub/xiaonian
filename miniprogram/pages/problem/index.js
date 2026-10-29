const { withShare } = require("../../utils/share");
/*
 * 题目学习页：按需展开分层提示、参考答案与同类练习；作答流程由 practice 页面承担。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const gate = require("../../utils/gate");
const { errorText, highlightNumbers, stripLead, sourceOf } = require("../../utils/format");
const reviewMethods = require("../../utils/review");
const studyClock = require("../../utils/study-clock");
const { typeset } = require("../../utils/tex");
// 给提示 opens the next hint; 看完整解法 opens the whole solution at once.
const NEXT = ["给我一点提示", "再给一点提示"];
const OVER = ["提示 · 想一想用到什么", "提示 · 关键一步", "整道题怎么做"];
// What 再练一道 offers (hints.data.variant): a server before V4.2 sends no
// field, which keeps the old offer.
const VARIANT = { numbers: "换几个数字，再练一道", similar: "再练一道同类题" };
const SLOW_AFTER = 30000;
function variantText(hints) {
  if (!hints || !hints.data.complete) return "";
  const kind = hints.data.variant;
  return kind === undefined ? VARIANT.numbers : VARIANT[kind] || "";
}
Page(withShare(studyClock.track({
  ...reviewMethods,
  data: {
    id: "",
    loading: true,
    material: null,
    parts: [],
    textBlocks: null,
    hints: null,
    levels: [],
    nextLabel: NEXT[0],
    variantText: "",
    answer: null,
    attempts: 0,
    waiting: false,
    slow: false,
    hintError: "",
    review: null,
    reviewText: "",
    error: "",
    loadFailed: false,
    canRetry: true,
  },
  onLoad(query) {
    this.alive = true;
    this.setData({ id: query.id });
  },
  onUnload() {
    this.alive = false;
    clearTimeout(this.slowTimer);
  },
  // Reload on every visit: an attempt may have opened the full solution.
  onShow() {
    if (!gate.check()) return;
    this.load().then((state) => {
      if (state && !this.checked) {
        this.checked = true;
        if (api.pending(state.jobs.hints)) this.follow(Promise.resolve(state.jobs.hints));
      }
    });
  },
  load() {
    return api
      .get(`/v1/materials/${this.data.id}/study`)
      .then((state) => {
        this.show(state.hints);
        const text = state.material.current ? state.material.current.text : "";
        this.setData({
          material: state.material,
          parts: highlightNumbers(text),
          textBlocks: this.textAt === text ? this.data.textBlocks : null,
          attempts: state.attempts.filter((a) => !a.artifactId).length,
          loadFailed: false,
        });
        this.textAt = text;
        typeset(this, [["textBlocks", text]], () => this.textAt === text);
        this.setReview(state.review);
        return state;
      })
      .catch((error) => {
        if (api.needsConsent(error)) return;
        this.setData({
          error: errorText(error),
          loadFailed: !this.data.material,
          canRetry: error.code !== "NOT_FOUND",
        });
      })
      .finally(() => this.setData({ loading: false }));
  },
  reload() {
    this.setData({ loading: true, error: "", loadFailed: false });
    this.onShow();
  },
  openLibrary() {
    require("../../utils/learn").backTo("pages/library/index");
  },
  openMore() {
    const { hints, review } = this.data;
    const actions = [["改题目", "edit"]];
    if (variantText(hints)) actions.push([variantText(hints), "practiceVariant"]);
    actions.push(review ? ["不用再提醒了", "removeReview"] : ["过几天回头看看", "addReview"]);
    if (hints) actions.push(["提示讲错了，反馈一下", "report"]);
    wx.showActionSheet({
      itemList: actions.map((a) => a[0]),
      success: ({ tapIndex }) => actions[tapIndex] && this[actions[tapIndex][1]](),
    });
  },
  show(hints) {
    const levels = hints ? hints.data.levels || [] : [];
    const answer = hints && hints.data.answer;
    const shown = levels.map((text, i) => ({ text: stripLead(text), over: OVER[i], blocks: null }));
    this.setData({
      hints,
      levels: shown,
      nextLabel: NEXT[levels.length] || "",
      variantText: variantText(hints),
      answer: answer
        ? { ...answer, sourceText: sourceOf(answer).text, tone: sourceOf(answer).tone, blocks: null }
        : null,
    });
    // Formulas are typeset once the render comes back; until then, plain text.
    const same = () => this.data.hints === hints;
    typeset(this, shown.map((l, i) => [`levels[${i}].blocks`, l.text]), same);
    if (answer) typeset(this, [["answer.blocks", answer.value, { inline: true }]], same);
  },
  follow(started) {
    this.setData({ waiting: true, slow: false, hintError: "" });
    clearTimeout(this.slowTimer);
    this.slowTimer = setTimeout(() => this.alive && this.setData({ slow: true }), SLOW_AFTER);
    return started
      .then((job) => job && api.waitJob(job, () => this.alive))
      .then((job) => {
        if (job && job.status !== "succeeded") {
          this.setData({ hintError: api.jobMessage(job) });
          return null;
        }
        return this.load();
      })
      .catch((error) => {
        if (error.code === "CANCELLED" || api.needsConsent(error)) return null;
        this.setData({ hintError: errorText(error) });
        return null;
      })
      .finally(() => {
        clearTimeout(this.slowTimer);
        if (this.alive) this.setData({ waiting: false, slow: false });
      });
  },
  // Hints are generated once (all levels), then opened one level at a time;
  // the whole solution opens straight away when asked for.
  nextHint() {
    this.reveal(this.data.levels.length + 1);
  },
  showSolution() {
    this.reveal(3);
  },
  reveal(level) {
    if (this.data.waiting) return;
    const open = () => {
      const hints = this.data.hints;
      if (!hints || hints.stale || !hints.data.complete) return;
      return api
        .post(`/v1/artifacts/${hints.id}/reveal`, { level })
        .then((view) => this.show(view))
        .catch((error) => !api.needsConsent(error) && this.setData({ hintError: errorText(error) }));
    };
    const go = () => {
      const hints = this.data.hints;
      if (hints && !hints.stale) return open();
      this.follow(
        api
          .post(`/v1/materials/${this.data.id}/hints`, { refresh: Boolean(hints) })
          .then((r) => r.job),
      ).then((state) => state && open());
    };
    return go();
  },
  regenerate() {
    this.follow(
      api.post(`/v1/materials/${this.data.id}/hints`, { refresh: true }).then((r) => r.job),
    );
  },
  tryAnswer() {
    wx.navigateTo({ url: `/pages/practice/index?id=${this.data.id}&mode=problem` });
  },
  practiceVariant() {
    wx.navigateTo({ url: `/pages/practice/index?id=${this.data.id}&mode=variant` });
  },
  edit() {
    wx.navigateTo({ url: `/pages/proofread/index?id=${this.data.id}` });
  },
  report() {
    const hints = this.data.hints;
    if (!hints) return;
    wx.showActionSheet({
      itemList: ["讲错了", "没讲清楚", "别的问题"],
      success: ({ tapIndex }) =>
        api
          .post(`/v1/artifacts/${hints.id}/report`, {
            reason: ["wrong", "unclear", "other"][tapIndex],
          })
          .then(() => wx.showToast({ title: "收到了，谢谢", icon: "none" }))
          .catch((error) => !api.needsConsent(error) && this.setData({ error: errorText(error) })),
    });
  },
})));
