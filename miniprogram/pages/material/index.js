/*
 * 资料学习页：展示讲解、原文依据、追问与自测入口；异步结果必须对应当前资料和版本。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const studyClock = require("../../utils/study-clock");
const auth = require("../../utils/auth");
const gate = require("../../utils/gate");
const { citeText, errorText } = require("../../utils/format");
const reviewMethods = require("../../utils/review");
const clock = require("../../utils/clock");
const REASONS = ["讲错了", "没讲清楚", "出处对不上", "别的问题"];
const REASON_KEYS = ["wrong", "unclear", "citation", "other"];
function withCites(items) {
  return items.map((item) => ({ ...item, cite: citeText(item.citations) }));
}
// the question asked last stays on this phone until its answer is in,
// so a failed ask can be sent again after leaving the page. Per account
// , so another account on this phone never sees it.
const ASK_KEY = (id) => `zhiye_material_ask:${id}:${(auth.getUser() || {}).id || ""}`;
function storedAsk(id) {
  try {
    return wx.getStorageSync(ASK_KEY(id)) || "";
  } catch (_) {
    return "";
  }
}
function storeAsk(id, question) {
  try {
    if (question) wx.setStorageSync(ASK_KEY(id), question);
    else wx.removeStorageSync(ASK_KEY(id));
  } catch (_) {}
}
// What the wait line says: the job's real state and how long it has taken.
function waitText(status, since) {
  const seconds = Math.max(0, Math.floor((clock.now() - since) / 1000));
  const took = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分钟`;
  return `${status === "queued" ? "排着队" : "已经开始"}，等了 ${took}`;
}
// V4.2 FX5b : time on this page counts as study (utils/study-clock).
Page(studyClock.track({
  ...reviewMethods,
  data: {
    id: "",
    loading: true,
    material: null,
    paragraphs: [],
    showText: false,
    explain: null,
    points: [],
    answers: [],
    question: "",
    waiting: { explain: false, ask: false },
    waitLine: { explain: "", ask: "" },
    errors: { explain: "", ask: "" },
    // A wait cut off after 150 seconds: the job may still finish.
    slow: { explain: false, ask: false },
    opened: {},
    allPoints: false,
    sheet: null,
    review: null,
    reviewText: "",
    error: "",
    loadFailed: false,
    canRetry: true,
  },
  onLoad(query) {
    this.alive = true;
    this.setData({ id: query.id });
    this.load().then((state) => state && this.resume(state));
  },
  onUnload() {
    this.alive = false;
    Object.values(this.timers || {}).forEach(clearInterval);
  },
  onShow() {
    if (!gate.check()) return;
    // Coming back from the proofread page may have changed the text.
    if (this.shown) this.load();
    this.shown = true;
  },
  load() {
    return api
      .get(`/v1/materials/${this.data.id}/study`)
      .then((state) => {
        const explain = state.explain;
        const current = state.material.current;
        this.setData({
          material: state.material,
          paragraphs: current ? current.paragraphs : [],
          explain,
          points: explain ? withCites(explain.data.points || []) : [],
          answers: state.answers
            .slice()
            .reverse()
            .map((a) => ({ ...a, cite: citeText(a.data.citations) })),
          loadFailed: false,
        });
        this.setReview(state.review);
        return state;
      })
      .catch((error) => {
        if (api.needsConsent(error)) return;
        // Without the material there is nothing else on the page, so offer a way on.
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
    this.load().then((state) => state && this.resume(state));
  },
  openLibrary() {
    require("../../utils/learn").backTo("pages/library/index");
  },
  openMore() {
    const { explain, review } = this.data;
    const actions = [];
    if (explain) actions.push(["换一种讲法", "regenerate"], ["讲错了，反馈一下", "reportExplain"]);
    actions.push(
      ["改原文", "edit"],
      review ? ["不用再提醒了", "removeReview"] : ["过几天回头看看", "addReview"],
      ["删掉这份资料", "remove"],
    );
    wx.showActionSheet({
      itemList: actions.map((a) => a[0]),
      success: ({ tapIndex }) => actions[tapIndex] && this[actions[tapIndex][1]](),
    });
  },
  showAllPoints() {
    this.setData({ allPoints: true });
  },
  // Resume a job still running from an earlier visit; start the explanation once if none exists.
  resume(state) {
    for (const kind of ["explain", "ask"]) {
      const job = state.jobs[kind];
      if (api.pending(job)) this.follow(kind, Promise.resolve(job));
    }
    // A question whose answer never came: back in the box, with why.
    const asked = state.jobs.ask;
    const question = storedAsk(this.data.id);
    if (question && !api.pending(asked)) {
      const answered = state.answers.some((a) => a.data && a.data.question === question);
      if (answered) storeAsk(this.data.id, "");
      else
        this.setData({
          question: this.data.question || question,
          "errors.ask": asked && asked.status !== "succeeded" ? api.jobMessage(asked) : "",
        });
    }
    const last = state.jobs.explain;
    if (!state.explain && !api.pending(last)) {
      if (last && last.status !== "succeeded")
        this.setData({ "errors.explain": api.jobMessage(last) });
      else this.generate();
    }
  },
  follow(kind, started) {
    this.setData({
      [`waiting.${kind}`]: true,
      [`errors.${kind}`]: "",
      [`slow.${kind}`]: false,
      [`waitLine.${kind}`]: "",
    });
    this.timers = this.timers || {};
    clearInterval(this.timers[kind]);
    return started
      .then((job) => {
        if (!job) return job;
        const since = Date.parse(job.createdAt) || clock.now();
        // The status of the latest poll : 排着队 until it starts.
        let status = job.status;
        const tick = () => this.alive && this.setData({ [`waitLine.${kind}`]: waitText(status, since) });
        tick();
        this.timers[kind] = setInterval(tick, 1000);
        return api.waitJob(job, () => this.alive, undefined, (next) => {
          status = next.status;
          tick();
        });
      })
      .then((job) => {
        if (job && job.status !== "succeeded")
          this.setData({ [`errors.${kind}`]: api.jobMessage(job) });
        return this.load().then(() => job);
      })
      .catch((error) => {
        if (error.code === "CANCELLED" || api.needsConsent(error)) return;
        this.setData({
          [`errors.${kind}`]: errorText(error),
          [`slow.${kind}`]: error.code === "WAIT_TIMEOUT",
        });
      })
      .finally(() => {
        clearInterval(this.timers[kind]);
        if (this.alive) this.setData({ [`waiting.${kind}`]: false });
      });
  },
  generate() {
    this.follow(
      "explain",
      api.post(`/v1/materials/${this.data.id}/explain`).then((r) => r.job),
    );
  },
  retryExplain() {
    if (this.data.explain) this.regenerate();
    else this.generate();
  },
  regenerate() {
    this.follow(
      "explain",
      api
        .post(`/v1/materials/${this.data.id}/explain`, { refresh: true })
        .then((r) => r.job),
    );
  },
  toggleText() {
    this.setData({ showText: !this.data.showText });
  },
  onQuestion(event) {
    this.setData({ question: event.detail.value });
    if (this.studyTouch) this.studyTouch();
  },
  // The question stays in the box until its answer is in; a failure leaves it
  // there to send again.
  ask() {
    const question = this.data.question.trim();
    if (!question || this.data.waiting.ask) return;
    const id = this.data.id;
    storeAsk(id, question);
    return this.follow(
      "ask",
      api.post(`/v1/materials/${id}/ask`, { question }).then((r) => r.job),
    ).then((job) => {
      if (!job || job.status !== "succeeded") return;
      storeAsk(id, "");
      if (this.data.question.trim() === question) this.setData({ question: "" });
    });
  },
  toggleExtension(event) {
    const key = `opened.${event.currentTarget.dataset.key}`;
    this.setData({ [key]: !this.data.opened[event.currentTarget.dataset.key] });
  },
  openSource(event) {
    const { cites, version } = event.currentTarget.dataset;
    api
      .sourceSheet(this.data.material, version, cites)
      .then((sheet) => this.setData({ sheet }))
      .catch((error) => !api.needsConsent(error) && this.setData({ error: errorText(error) }));
  },
  closeSheet() {
    this.setData({ sheet: null });
  },
  noop() {},
  reportExplain() {
    if (this.data.explain) this.report({ currentTarget: { dataset: { id: this.data.explain.id } } });
  },
  report(event) {
    const artifactId = event.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: REASONS,
      success: ({ tapIndex }) =>
        api
          .post(`/v1/artifacts/${artifactId}/report`, { reason: REASON_KEYS[tapIndex] })
          .then(() => wx.showToast({ title: "收到了，谢谢", icon: "none" }))
          .catch((error) => !api.needsConsent(error) && this.setData({ error: errorText(error) })),
    });
  },
  practice() {
    wx.navigateTo({ url: `/pages/practice/index?id=${this.data.id}&mode=quiz` });
  },
  edit() {
    wx.navigateTo({ url: `/pages/proofread/index?id=${this.data.id}` });
  },
  remove() {
    wx.showModal({
      title: "删掉这份资料？",
      content: "原文和它的讲解、题目、做题记录会一起删掉，删了就找不回来了。",
      confirmText: "删掉",
      confirmColor: "#c0392b",
      success: ({ confirm }) => {
        if (!confirm) return;
        api
          .del(`/v1/materials/${this.data.id}`)
          .then(() =>
            wx.navigateBack({
              fail: () => require("../../utils/learn").backTo("pages/library/index"),
            }),
          )
          .catch((error) => !api.needsConsent(error) && this.setData({ error: errorText(error) }));
      },
    });
  },
}));
