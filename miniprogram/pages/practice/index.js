/*
 * 作答页：提交自测、题目或同类题答案，等待判定并展示反馈；重试沿用原提交标识。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const gate = require("../../utils/gate");
const { citeText, errorText, highlightNumbers, stripLead, sourceOf } = require("../../utils/format");
const reviewMethods = require("../../utils/review");
const { backTo, ROUTES } = require("../../utils/learn");
const studyClock = require("../../utils/study-clock");
const { typeset } = require("../../utils/tex");
const TITLES = { quiz: "考考自己", problem: "做题", variant: "再来一道" };
const LETTERS = ["A", "B", "C", "D"];
// Marks are drawn like a teacher's pen: a green tick, a red cross, a pencil question mark.
const HEADS = {
  correct: { tone: "good", mark: "tick-green", title: "做对了！", sub: "记住这个思路，过几天再来试试。" },
  incorrect: { tone: "bad", mark: "cross-red", title: "还差一点", sub: "看看下面，差在哪一步。" },
  unsure: { tone: "", mark: "query-pencil", title: "这题拿不准对错", sub: "对照答案一起看看？" },
};
// Before the full solution opens (probe first) there is no reference answer to check against.
const UNSURE_HIDDEN = "先看看下面的说明，再试一次，或者看看提示。";
const SLOW_AFTER = 30000;
// What is being written is kept per material, mode, problem and question, so
// going to the hints and back keeps it; the last answer sent is kept per
// material and mode, so coming back picks its judgement up again.
const DRAFT = "practice-draft:";
const LAST = "practice-last:";
function stored(key) {
  try {
    return wx.getStorageSync(key) || null;
  } catch (e) {
    return null;
  }
}
function keep(key, value) {
  try {
    if (value) wx.setStorageSync(key, value);
    else wx.removeStorageSync(key);
  } catch (e) {
    // Storage is a convenience here; the page works without it.
  }
}
// Sent with an answer; the same key again returns the same attempt.
function newKey() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
Page(studyClock.track({
  ...reviewMethods,
  data: {
    id: "",
    mode: "problem",
    loading: true,
    material: null,
    mapPoint: null,
    target: null,
    index: 0,
    total: 0,
    finished: false,
    question: null,
    ticks: [],
    parts: [],
    textBlocks: null,
    picked: -1,
    text: "",
    peek: null,
    waiting: false,
    judging: false,
    slow: false,
    genError: "",
    judgeError: "",
    result: null,
    detailOpen: false,
    sheet: null,
    review: null,
    reviewText: "",
    error: "",
    loadFailed: false,
    canRetry: true,
  },
  onLoad(query) {
    this.alive = true;
    const mode = TITLES[query.mode] ? query.mode : "problem";
    this.setData({ id: query.id, mode });
    wx.setNavigationBarTitle({ title: TITLES[mode] });
    this.load().then((state) => state && this.start(state));
  },
  onUnload() {
    this.alive = false;
    clearTimeout(this.slowTimer);
  },
  // After half a minute the wait says it is slow, without promising a time.
  startSlow() {
    clearTimeout(this.slowTimer);
    this.setData({ slow: false });
    this.slowTimer = setTimeout(() => this.alive && this.setData({ slow: true }), SLOW_AFTER);
  },
  stopSlow() {
    clearTimeout(this.slowTimer);
    if (this.alive) this.setData({ slow: false });
  },
  draftKey() {
    const { id, mode, target, index } = this.data;
    return `${DRAFT}${id}:${mode}:${mode === "problem" || !target ? "" : target.id}:${mode === "quiz" ? index : 0}`;
  },
  lastKey() {
    return `${LAST}${this.data.id}:${this.data.mode}`;
  },
  restoreDraft() {
    this.setData({ text: stored(this.draftKey()) || "" });
  },
  onShow() {
    if (!gate.check()) return;
    if (this.data.result) this.syncMapPoint();
  },
  load() {
    return api
      .get(`/v1/materials/${this.data.id}/study`)
      .then((state) => {
        this.attempts = state.attempts || [];
        this.setData({ material: state.material, mapPoint: state.mapPoint || null, loadFailed: false });
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
    this.load().then((state) => state && this.start(state));
  },
  openLibrary() {
    backTo("pages/library/index");
  },
  toggleDetail() {
    this.setData({ detailOpen: !this.data.detailOpen });
  },
  start(state) {
    const mode = this.data.mode;
    if (mode === "problem") {
      const current = state.material.current;
      this.showText(current ? current.text : "");
      // The answer last sent, or one still being judged, is picked up again.
      const kept = stored(this.lastKey());
      const last =
        (kept && state.attempts.find((a) => a.id === kept.attemptId && !a.artifactId)) ||
        state.attempts.find((a) => !a.artifactId && a.jobId && api.pending({ status: a.status }));
      if (last && this.resume(last)) return;
      return this.restoreDraft();
    }
    const current = state[mode];
    const job = state.jobs[mode];
    if (api.pending(job)) return this.generate(Promise.resolve(job));
    if (mode === "quiz") {
      if (current) return this.showQuiz(current);
      if (job && job.status !== "succeeded")
        return this.setData({ genError: api.jobMessage(job) });
      return this.newQuiz();
    }
    // An outdated variant is replaced; an answered one stays with its result
    // (or its judging) until the student asks for another.
    if (!current || current.stale) return this.newVariant();
    this.showVariant(current);
    const kept = stored(this.lastKey());
    const mine = state.attempts.filter((a) => a.artifactId === current.id);
    const last = (kept && mine.find((a) => a.id === kept.attemptId)) || mine[0];
    if (last) this.resume(last);
  },
  // Shows a sent answer as it stands: judged, still being judged, or failed.
  // Returns false when there is nothing to show for it.
  resume(attempt) {
    const material = this.data.material;
    if (attempt.result) {
      if (this.data.mode === "problem" && material && attempt.version !== material.version) return false;
      this.setData({ text: attempt.answer });
      this.showResult(attempt);
      return true;
    }
    if (attempt.jobId && api.pending({ status: attempt.status })) {
      this.setData({ text: attempt.answer });
      this.judge(attempt.id, { id: attempt.jobId, status: attempt.status });
      return true;
    }
    if (attempt.error) {
      this.setData({ text: attempt.answer, judgeError: attempt.error.message });
      return true;
    }
    return false;
  },
  // Waits for a quiz or variant to be generated, then shows it.
  generate(started) {
    this.setData({ waiting: true, genError: "", result: null, peek: null });
    this.startSlow();
    return started
      .then((job) => job && api.waitJob(job, () => this.alive))
      .then((job) => {
        if (job && job.status !== "succeeded")
          return this.setData({ genError: api.jobMessage(job) });
        return this.load().then((state) => {
          if (!state) return;
          if (this.data.mode === "quiz") this.showQuiz(state.quiz);
          else this.showVariant(state.variant);
        });
      })
      .catch((error) => {
        if (error.code === "CANCELLED" || api.needsConsent(error)) return;
        this.setData({ genError: errorText(error) });
      })
      .finally(() => {
        this.stopSlow();
        if (this.alive) this.setData({ waiting: false });
      });
  },
  newQuiz() {
    const refresh = Boolean(this.data.target);
    this.generate(
      api.post(`/v1/materials/${this.data.id}/quiz`, { refresh }).then((r) => r.job),
    );
  },
  newVariant() {
    keep(this.lastKey(), null);
    this.generate(api.post(`/v1/materials/${this.data.id}/variant`).then((r) => r.job));
  },
  retry() {
    if (this.data.mode === "quiz") this.newQuiz();
    else this.newVariant();
  },
  showQuiz(quiz) {
    if (!quiz) return;
    const answered = new Set(quiz.state.answered || []);
    const index = quiz.data.questions.findIndex((q, i) => !answered.has(i));
    this.setData({ target: quiz, total: quiz.data.questions.length, finished: index < 0 });
    if (index < 0) return;
    this.showQuestion(index);
    // A short answer to this question still being judged is picked up again.
    const pending = (this.attempts || []).find(
      (a) => a.artifactId === quiz.id && a.item === index && a.jobId && api.pending({ status: a.status }),
    );
    if (pending) this.resume(pending);
  },
  // The problem text, typeset when it holds formulas.
  showText(text) {
    this.textAt = text;
    this.setData({ parts: highlightNumbers(text), textBlocks: null });
    typeset(this, [["textBlocks", text]], () => this.textAt === text);
  },
  showQuestion(index) {
    const q = this.data.target.data.questions[index];
    const target = this.data.target;
    this.setData({
      index,
      ticks: this.data.target.data.questions.map((_, i) =>
        i < index ? "done" : i === index ? "now" : "",
      ),
      question: {
        type: q.type,
        stem: q.stem,
        stemBlocks: null,
        options: (q.options || []).map((text, i) => ({ letter: LETTERS[i], text, cls: "", blocks: null })),
      },
      picked: -1,
      text: "",
      result: null,
      judgeError: "",
    });
    this.sendKey = null;
    this.restoreDraft();
    const still = () => this.data.target === target && this.data.index === index;
    typeset(
      this,
      [["question.stemBlocks", q.stem], ...(q.options || []).map((text, i) => [`question.options[${i}].blocks`, text, { inline: true }])],
      still,
    );
  },
  showVariant(variant) {
    if (!variant) return;
    this.showText(variant.data.question);
    this.setData({
      target: variant,
      text: "",
      result: null,
      peek: null,
      judgeError: "",
    });
    this.sendKey = null;
    this.restoreDraft();
  },
  pick(event) {
    if (this.data.result || this.data.judging) return;
    const picked = Number(event.currentTarget.dataset.index);
    if (picked !== this.data.picked) this.sendKey = null;
    this.setData({
      picked,
      "question.options": this.data.question.options.map((o, i) => ({
        ...o,
        cls: i === picked ? "on" : "",
      })),
    });
  },
  onText(event) {
    const text = event.detail.value;
    if (text !== this.data.text) this.sendKey = null;
    this.setData({ text });
    keep(this.draftKey(), text.trim() ? text : null);
  },
  submit() {
    if (this.data.judging || this.data.result) return;
    const { mode, target, index, question, picked } = this.data;
    const body = { answer: this.data.text.trim() };
    if (mode !== "problem") body.artifactId = target.id;
    if (mode === "quiz") {
      body.item = index;
      if (question.type === "choice") {
        if (picked < 0) return wx.showToast({ title: "先选一个", icon: "none" });
        body.choice = picked;
        body.answer = "";
      }
    }
    if (body.choice === undefined && !body.answer)
      return wx.showToast({ title: "先写下答案", icon: "none" });
    // Sending the same answer again (after an error) reuses its key, so the
    // server returns the first attempt instead of judging it twice.
    if (!this.sendKey) this.sendKey = newKey();
    body.clientKey = this.sendKey;
    this.setData({ judging: true, judgeError: "" });
    api
      .post(`/v1/materials/${this.data.id}/attempts`, body)
      .then(({ attempt, job }) => {
        keep(this.lastKey(), { attemptId: attempt.id });
        if (attempt.result) {
          this.setData({ judging: false });
          return this.showResult(attempt);
        }
        if (!job) {
          this.setData({ judging: false });
          return this.showResult(attempt);
        }
        return this.judge(attempt.id, job);
      })
      .catch((error) => {
        this.setData({ judging: false });
        if (!api.needsConsent(error)) this.setData({ judgeError: errorText(error) });
      });
  },
  // Feedback runs as a background job; its result is stored on the attempt.
  judge(attemptId, job) {
    this.setData({ judging: true, judgeError: "" });
    this.startSlow();
    return api
      .waitJob(job, () => this.alive)
      .then((done) => {
        if (done && done.status !== "succeeded")
          throw Object.assign(new Error(api.jobMessage(done)), { code: "JOB_FAILED" });
        return api.get(`/v1/attempts/${attemptId}`);
      })
      .then((attempt) => this.showResult(attempt))
      .catch((error) => {
        if (error.code === "CANCELLED" || api.needsConsent(error)) return;
        // A failed judgement is done with; sending again is a new attempt.
        if (error.code === "JOB_FAILED") this.sendKey = null;
        this.setData({ judgeError: errorText(error) });
      })
      .finally(() => {
        this.stopSlow();
        if (this.alive) this.setData({ judging: false });
      });
  },
  showResult(attempt) {
    const r = attempt.result;
    if (!r) return;
    const ref = r.reference;
    const choice = this.data.mode === "quiz" && this.data.question.type === "choice";
    const head = HEADS[r.verdict] || HEADS.unsure;
    const patch = {
      result: {
        ...head,
        attemptId: attempt.id,
        correct: r.verdict === "correct",
        ...(head === HEADS.unsure && !ref ? { sub: UNSURE_HIDDEN } : {}),
        mine: attempt.answer,
        compare: Boolean(ref) && !choice,
        reference: ref ? ref.text || ref.value : "",
        sourceText: sourceOf(ref).text,
        sourceTone: sourceOf(ref).tone,
        check: (ref && ref.check) || "",
        note: (ref && ref.note) || "",
        cause: r.cause ? r.cause.label : "",
        comment: r.comment,
        explanation: r.revealSolution ? stripLead(r.explanation) : "",
        cite: citeText(r.citations),
        citations: r.citations || [],
        version: attempt.version,
        revealed: r.revealSolution,
      },
      // Not right: the working is open at once, not one more tap away.
      detailOpen: r.verdict !== "correct",
    };
    const shown = patch.result;
    // The working (answer source, check, solution, citation) stays folded under one row.
    shown.hasDetail = Boolean(shown.sourceText || shown.check || shown.note || shown.explanation || shown.cite);
    if (choice) {
      const right = this.data.question.options.findIndex((o) => ref && o.text === ref.value);
      patch["question.options"] = this.data.question.options.map((o, i) => ({
        ...o,
        cls: i === right ? "right" : i === this.data.picked ? "wrong" : "",
      }));
    }
    if (this.data.mode !== "problem" || !this.data.material || attempt.version !== this.data.material.version) patch.mapPoint = null;
    this.setData(patch);
    // Judged: the draft is done with; the next answer gets a key of its own.
    keep(this.draftKey(), null);
    this.sendKey = null;
    const still = () => this.data.result === shown || (this.data.result && this.data.result.attemptId === shown.attemptId);
    typeset(
      this,
      [
        ["result.mineBlocks", shown.mine, { inline: true }],
        ["result.referenceBlocks", shown.reference, { inline: true }],
        ["result.commentBlocks", shown.comment],
        ["result.explanationBlocks", shown.explanation],
      ],
      still,
    );
    this.syncMapPoint();
  },
  // Read this material's cached association; a correct tool answer never writes map progress.
  syncMapPoint() {
    const { id, result, mode } = this.data;
    if (!result || mode !== "problem") return;
    return api.get(`/v1/materials/${id}/study`).then((state) => {
      const current = this.data.result;
      if (!this.alive || this.data.id !== id || !current || current.attemptId !== result.attemptId) return;
      this.setData({ mapPoint: state.material.version === result.version ? state.mapPoint || null : null });
    }).catch(() => {});
  },
  openMap() {
    const { result, mapPoint, mode } = this.data;
    if (!result || mode === "quiz" || (!result.correct && !mapPoint)) return;
    return mapPoint ? backTo(ROUTES.point, mapPoint.id) : backTo(ROUTES.map);
  },
  next() {
    keep(this.lastKey(), null);
    if (this.data.index + 1 < this.data.total) this.showQuestion(this.data.index + 1);
    else this.setData({ finished: true, result: null });
  },
  again() {
    keep(this.lastKey(), null);
    this.setData({ result: null, judgeError: "" });
  },
  peekAnswer() {
    const target = this.data.target;
    api
      .post(`/v1/artifacts/${target.id}/reveal`, { level: 1 })
      .then((view) => {
        this.setData({
          peek: {
            value: view.data.answer,
            sourceText: sourceOf(view.data).text,
            tone: sourceOf(view.data).tone,
            check: view.data.check || "",
            blocks: null,
          },
        });
        typeset(this, [["peek.blocks", view.data.answer, { inline: true }]], () => this.data.target === target);
      })
      .catch((error) => !api.needsConsent(error) && this.setData({ judgeError: errorText(error) }));
  },
  openSource() {
    const { material, result } = this.data;
    api
      .sourceSheet(material, result.version, result.citations)
      .then((sheet) => this.setData({ sheet }))
      .catch((error) => !api.needsConsent(error) && this.setData({ judgeError: errorText(error) }));
  },
  closeSheet() {
    this.setData({ sheet: null });
  },
  noop() {},
  // Return to the page this one was opened from when it is the right one.
  backTo(page) {
    const pages = getCurrentPages();
    const prev = pages[pages.length - 2];
    if (prev && prev.route === `pages/${page}/index`) return wx.navigateBack();
    wx.redirectTo({ url: `/pages/${page}/index?id=${this.data.id}` });
  },
  toProblem() {
    this.backTo("problem");
  },
  back() {
    this.backTo(this.data.mode === "quiz" ? "material" : "problem");
  },
  toMaterial() {
    this.backTo("material");
  },
  toVariant() {
    wx.redirectTo({ url: `/pages/practice/index?id=${this.data.id}&mode=variant` });
  },
}));
