/*
 * 讲一遍：记录用户的解释，接收追问并发起要点核对；话题、草稿与历史按当前账号处理。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
// 讲一遍 : pick a knowledge point (G4's list) or write a topic,
// then explain it to 小狸, who asks back like a classmate (the point's key
// points steer the questions, server side). 讲完了 compares what was said with
// the key points (POST /v1/chat/threads/:id/teach-review): covered, missed,
// said wrong; the clearest sentence can be kept as a card (我的话, pages/collect).
// ?pointId=&name= starts on a point, ?id= reopens a teach chat (&finish=1:
// straight to 讲完了, from 解题's teach mode).
// what is being explained and the unsent text are kept on this phone
// (继续刚才的讲解); the start lists past ones (tool=teach); 讲完了 takes the
// unsent text along.
// 讲完了 carries a clientId kept with the draft until it is
// reviewed, so a retry, a timeout or leaving and coming back gets the same
// review and is never counted twice; the wait is the shared task-progress.
// Once reviewed the kept draft goes; 更多 pages through the past ones.
const api = require("../../utils/api");
const studyClock = require("../../utils/study-clock");
const gate = require("../../utils/gate");
const bank = require("../../utils/bank");
const stream = require("../../utils/stream");
const keyboard = require("../../utils/keyboard");
const chatV2 = require("../../utils/chat-v2");
const { errorText } = require("../../utils/format");
const { asset } = require("../../utils/assets");
const tools = require("../../utils/tools");
const { openAsk } = require("../../utils/chat-entry");
const budgets = require("../../utils/budget");
const { transient } = require("../../utils/job");
const TONE = "light";
// What the wait shows; the server sends no stages, so no percentage either.
const REVIEW_STEPS = [
  { key: "read", label: "读你的讲解" },
  { key: "match", label: "对照要点" },
  { key: "note", label: "写点评" },
];
const HISTORY_PAGE = 20;
const STATUS = { covered: "讲清了", partial: "不完整", missed: "漏了" };
function mine(text) {
  return { id: `local_${Date.now()}`, role: "user", blocks: [{ t: "p", c: [{ t: "text", v: text }] }], plain: text, status: "done" };
}
function fromServer(m) {
  return {
    id: m.id,
    role: m.role,
    kind: m.kind,
    blocks: m.blocks || [],
    plain: m.role === "user" ? m.plain || m.content || plainOf(m.blocks) : "",
    tail: "",
    status: m.status,
    thinking: m.status === "streaming" && !(m.blocks || []).length,
    crisis: Boolean(m.crisis),
    // A reply that did not finish says so when the chat is opened again.
    error: m.status === "failed" ? (m.error && m.error.message) || "这次没答完，再说一句试试" : "",
  };
}
// The text of a user's own message, for picking a sentence to keep.
function plainOf(blocks) {
  return (blocks || [])
    .map((b) => (b.c || []).map((c) => (c.t === "math" ? `$${c.tex || ""}$` : c.v || "")).join(""))
    .join("\n");
}
function reviewView(review) {
  const covered = review.points.filter((p) => p.status !== "missed").map((p) => ({ ...p, label: STATUS[p.status] }));
  const missed = review.points.filter((p) => p.status === "missed");
  const said = review.said && review.said.total > review.said.seen ? `讲得比较长，只对照了后面 ${review.said.seen} 段，前 ${review.said.total - review.said.seen} 段没算进来` : "";
  return { covered, missed, wrong: review.wrong, best: review.best, total: review.points.length, got: review.points.filter((p) => p.status === "covered").length, said };
}
function when(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}月${d.getDate()}日`;
}
// V4.2 FX5b : time on this page counts as study (utils/study-clock).
Page(studyClock.track({
  data: {
    usageText: "",
    guest: false,
    stage: "pick",
    chapters: [],
    tabs: [],
    chapterId: "",
    topic: "",
    pointId: "",
    name: "",
    messages: [],
    draft: "",
    kb: 0,
    focus: false,
    sending: false,
    reviewing: false,
    reviewSteps: REVIEW_STEPS,
    reviewAt: 0,
    reviewError: "",
    review: null,
    fallback: null,
    error: "",
    // ?id= did not open: 再试一次.
    loadFailed: false,
    face: asset("xiaoli-face.webp"),
    faceBroken: false,
    // The start: the one being explained (kept on this phone) and past ones.
    resume: null,
    history: [],
    historyMore: false,
    // the latest 3 until 全部记录; a failed load says so.
    historyAll: false,
    historyBusy: false,
    historyFailed: false,
  },
  onLoad(query) {
    this.alive = true;
    const q = query || {};
    if (q.id) {
      this.threadId = q.id;
      this.finishOnLoad = q.finish === "1";
      const kept = tools.kept("teach");
      this.setData({ stage: "talk", ...(kept && kept.threadId === q.id && kept.draft ? { draft: kept.draft } : {}) });
    } else if (q.pointId) {
      let name = String(q.name || "");
      try {
        name = decodeURIComponent(name);
      } catch (error) {}
      this.setData({ stage: "talk", pointId: q.pointId, name: name || "这个知识点" });
    }
  },
  onUnload() {
    this.alive = false;
    clearTimeout(this.timer);
    if (this.request) this.request.abort();
  },
  onShow() {
    if (!gate.check()) return;
    const guest = gate.state() === "guest";
    if (guest !== this.data.guest) this.setData({ guest });
    if (this.threadId && !this.loaded) return this.load();
    if (this.data.stage === "pick") {
      if (!this.data.chapters.length) this.loadBank();
      this.startView();
    }
  },
  // ---- the start: 继续刚才的讲解 and past ones -----------------------------
  startView() {
    if (this.data.guest) return;
    const kept = tools.kept("teach");
    this.setData({ resume: kept && kept.name ? { name: kept.name, draft: Boolean(kept.draft), review: Boolean(kept.review) } : null });
    this.history();
  },
  // more: the page after the last one shown (`next`, passed back as it came).
  history(more) {
    const after = more === true ? this.next : "";
    if (more === true && !after) return Promise.resolve();
    return api
      .get(`/v1/chat/threads?kind=solve&tool=teach&limit=${HISTORY_PAGE}${after ? `&before=${encodeURIComponent(after)}` : ""}&tone=${TONE}`)
      .then(({ threads, usage, next }) => {
        if (!this.alive) return;
        // one line once the budget runs low (80%).
        this.setData({ usageText: usage && budgets.valid(usage.budget) ? budgets.low(usage.budget) : "" });
        const rows = (threads || []).map((t) => ({ id: t.id, title: t.title || "讲一遍", tool: t.tool, open: Boolean(t.open), when: when(t.updatedAt) }));
        this.next = next || "";
        const known = new Set(after ? this.data.history.map((r) => r.id) : []);
        const history = after
          ? this.data.history.concat(rows.filter((r) => !known.has(r.id)))
          : rows.filter((r) => r.open).concat(rows.filter((r) => !r.open)).slice(0, HISTORY_PAGE);
        this.setData({ history, historyMore: Boolean(next), historyFailed: false });
        // Already reviewed, nothing unsent, nothing waiting: no 接着讲 (低-2).
        const kept = tools.kept("teach");
        if (!after && kept && kept.threadId && !kept.draft && !kept.review && rows.some((r) => r.id === kept.threadId && !r.open)) {
          tools.drop("teach");
          this.setData({ resume: null });
        }
      })
      // V4.2 FX5b : keep what is shown and say it did not open.
      .catch((error) => {
        if (this.alive && !api.needsConsent(error)) this.setData({ historyFailed: true });
      });
  },
  moreHistory() {
    if (this.data.historyBusy) return Promise.resolve();
    this.setData({ historyBusy: true });
    return this.history(true).then(() => {
      if (this.alive) this.setData({ historyBusy: false });
    });
  },
  showAllHistory() {
    this.setData({ historyAll: true });
  },
  retryHistory() {
    return this.history();
  },
  resumeTalk() {
    const kept = tools.kept("teach");
    if (!kept || !kept.name) return;
    this.threadId = kept.threadId || "";
    this.loaded = false;
    this.setData({ stage: "talk", pointId: kept.pointId || "", name: kept.name, draft: kept.draft || "", messages: [], review: null, fallback: null });
    if (this.threadId) this.load();
  },
  openPast(event) {
    const { id, tool } = event.currentTarget.dataset;
    if (!id) return;
    // A 讲一遍 on cards (from 解题) goes on there.
    if (tool !== "teach") return openAsk({ threadId: id });
    wx.navigateTo({ url: `/pages/teach/index?id=${encodeURIComponent(id)}` });
  },
  // What is being explained, what is typed but not sent, and a 讲完了 not
  // answered yet (its clientId, text and when it was tapped).
  keep() {
    const { pointId, name, draft } = this.data;
    const p = this.pending;
    if (name) tools.keep("teach", { threadId: this.threadId || "", pointId, name, draft, review: p ? { clientId: p.clientId, text: p.text, at: p.at } : null });
  },
  loadBank() {
    return bank
      .load()
      .then((data) => {
        if (!this.alive || !data) return;
        const shown = bank.view(data);
        this.bankView = shown;
        this.setData({ chapters: shown.chapters, tabs: shown.tabs });
      })
      .catch((error) => {
        if (this.alive && !api.needsConsent(error)) this.setData({ error: errorText(error) });
      });
  },
  // ?id=, and again while a reply is still being written. A sentence being
  // sent from here is not overwritten: the look waits until it is through.
  load() {
    this.loaded = true;
    clearTimeout(this.timer);
    const later = () => {
      this.timer = setTimeout(() => this.alive && this.load(), 3000);
    };
    if (this.data.sending) return Promise.resolve(later());
    if (this.data.loadFailed) this.setData({ loadFailed: false, error: "" });
    return api
      .get(`/v1/chat/threads/${encodeURIComponent(this.threadId)}?tone=${TONE}`)
      .then(({ thread, messages }) => {
        if (!this.alive) return;
        if (this.data.sending) return later();
        this.thread = thread;
        const list = messages.filter((m) => m.kind !== "teach_review").map(fromServer);
        const ids = new Set(list.map((m) => m.id));
        const mine = this.data.messages.filter((m) => /^(local|wait)_/.test(m.id) && !ids.has(m.id));
        const last = messages[messages.length - 1];
        this.setData({ messages: list.concat(mine), pointId: thread.pointId || "", name: thread.title || "" });
        const kept = tools.kept("teach");
        const ours = kept && kept.threadId === this.threadId ? kept : null;
        if (ours && ours.review && ours.review.clientId) {
          // Left while it was reviewed: the same request again (the same
          // clientId), answered with the review it got, never a second one.
          if (!this.data.reviewing) {
            this.pending = { ...ours.review, resent: true };
            this.review();
          }
        } else if (last && last.kind === "teach_review" && last.review) {
          // Reviewed, nothing unsent: nothing to come back to (低-2).
          if (ours && !ours.draft) tools.drop("teach");
          this.showReview(last);
        } else if (this.finishOnLoad) this.finish();
        this.finishOnLoad = false;
        // A reply the server is still writing: look again shortly.
        clearTimeout(this.timer);
        if (list.some((m) => m.status === "streaming")) later();
      })
      .catch((error) => {
        if (!this.alive || api.needsConsent(error)) return;
        // Not opened: the next show or 再试一次 reads it again.
        this.loaded = false;
        this.setData({ error: errorText(error), loadFailed: true });
      });
  },
  // ---- what to explain -----------------------------------------------------
  selectChapter(event) {
    this.setData({ chapterId: event.currentTarget.dataset.id || "" });
  },
  pickPoint(event) {
    const { id } = event.detail || {};
    if (!id) return;
    if (this.data.guest) return gate.ask();
    const point = bank.find(this.bankView, id);
    this.threadId = "";
    this.setData({ stage: "talk", pointId: id, name: (point && point.name) || "这个知识点", topic: "", focus: true, messages: [], draft: "" });
    this.keep();
  },
  onTopic(event) {
    this.setData({ topic: event.detail.value });
  },
  startTopic() {
    if (this.data.guest) return gate.ask();
    const topic = this.data.topic.trim().slice(0, 60);
    if (!topic) return this.setData({ error: "先写下想讲的主题" });
    this.threadId = "";
    this.setData({ stage: "talk", pointId: "", name: topic, error: "", focus: true, messages: [], draft: "" });
    this.keep();
  },
  // ---- talking -------------------------------------------------------------
  onDraft(event) {
    this.setData({ draft: event.detail.value });
    this.keep();
    if (this.studyTouch) this.studyTouch();
  },
  onBlur() {
    keyboard.reset(this);
    if (this.data.focus) this.setData({ focus: false });
  },
  keyboardHeight(event) {
    keyboard.change(this, event, () => this.toLatest());
  },
  toLatest() {
    wx.pageScrollTo({ scrollTop: 1e6, duration: 200 });
  },
  // The chat is made on the first sentence, so leaving early leaves nothing.
  ensureThread() {
    if (this.threadId) return Promise.resolve(this.threadId);
    const { pointId, name } = this.data;
    return api
      .post("/v1/chat/threads", {
        mode: "teach",
        text: name,
        ...(pointId ? { pointId } : { topic: name }),
        origin: "solve",
        tone: TONE,
      })
      .then(({ thread }) => {
        this.thread = thread;
        this.threadId = thread.id;
        this.keep();
        return thread.id;
      });
  },
  submit() {
    const text = this.data.draft.trim();
    if (!text || this.data.sending) return;
    if (this.data.guest) return gate.ask();
    const id = stream.clientId();
    const reply = { id: `wait_${id}`, role: "assistant", blocks: [], tail: "", status: "streaming", thinking: true };
    const messages = this.data.messages.concat([{ ...mine(text), id: `local_${id}` }, reply]);
    this.setData({ messages, draft: "", sending: true, error: "" });
    this.keep();
    this.toLatest();
    return this.ensureThread()
      .then((threadId) => {
        this.request = stream.send(
          "/v1/chat/send",
          { threadId, text, mode: "auto", clientId: id, tone: TONE },
          (event) => this.onEvent(event, id),
        );
        return this.request.promise;
      })
      // The connection dropped while the server went on: show what it kept.
      .then((result) => result && result.finished === false && this.alive && this.load())
      .catch((error) => {
        if (!this.alive || error.code === "CANCELLED") return;
        // The sentence reached the server (start came back): what it kept is
        // shown, nothing is sent twice.
        if (this.threadId && this.index(`local_${id}`) < 0) {
          this.setData({ error: errorText(error) });
          return this.load();
        }
        const keep = this.data.messages.filter((m) => m.id !== `wait_${id}` && m.id !== `local_${id}`);
        this.setData({ messages: keep, draft: text, ...(api.needsConsent(error) ? {} : { error: errorText(error) }) });
        this.keep();
      })
      .finally(() => this.alive && this.setData({ sending: false }));
  },
  index(id) {
    return this.data.messages.findIndex((m) => m.id === id);
  },
  onEvent(event, cid) {
    if (!this.alive) return;
    const patch = {};
    if (event.e === "crisis") {
      this.setData({ messages: this.data.messages.filter((m) => m.id !== `wait_${cid}`) });
      return wx.navigateTo({ url: "/pages/crisis/index" });
    }
    if (event.e === "start") {
      const q = this.index(`local_${cid}`);
      if (q >= 0) patch[`messages[${q}].id`] = event.question.id;
      const r = this.index(`wait_${cid}`);
      if (r >= 0) patch[`messages[${r}].id`] = event.replyId;
    } else if (event.e === "blocks" || event.e === "tail" || event.e === "done" || event.e === "error") {
      const i = this.index(event.e === "done" ? event.message.id : event.id);
      if (i < 0) return;
      const m = this.data.messages[i];
      if (event.e === "blocks") {
        patch[`messages[${i}].blocks`] = m.blocks.concat(event.blocks);
        patch[`messages[${i}].thinking`] = false;
      } else if (event.e === "tail") {
        patch[`messages[${i}].tail`] = event.text;
        patch[`messages[${i}].thinking`] = false;
      } else if (event.e === "done") patch[`messages[${i}]`] = fromServer(event.message);
      else patch[`messages[${i}]`] = { ...m, status: "failed", thinking: false, tail: "", error: event.message };
    } else return;
    this.setData(patch);
    this.toLatest();
  },
  // ---- 讲完了 -------------------------------------------------------------
  // What is typed and not sent goes along : it is the last thing said.
  // the same text keeps its clientId until it is answered.
  finish() {
    if (this.data.reviewing || this.data.sending) return;
    const text = this.data.draft.trim();
    if (!this.threadId && !text) return;
    if (this.data.guest) return gate.ask();
    if (!this.pending || this.pending.text !== text) this.pending = { clientId: stream.clientId(), text, at: Date.now() };
    return this.review();
  },
  review() {
    const pending = this.pending;
    const { clientId, text } = pending;
    this.setData({ reviewing: true, reviewAt: pending.at || Date.now(), reviewError: "", error: "" });
    this.keep();
    return this.ensureThread()
      .then((threadId) => {
        // A new thread: kept with its id, so coming back finds this request.
        this.keep();
        return api
          .post(`/v1/chat/threads/${encodeURIComponent(threadId)}/teach-review`, { ...(text ? { text: text.slice(0, 2000) } : {}), clientId, tone: TONE }, { timeout: 150000 })
          .then((out) => ({ out, threadId }));
      })
      .then(({ out, threadId }) => {
        // Answered: nothing waits any more, even when the page is gone. A
        // review done leaves nothing to come back to (低-2).
        if (this.pending === pending) this.pending = null;
        const kept = tools.kept("teach");
        if (kept && kept.threadId === threadId && kept.review && kept.review.clientId === clientId) {
          // A fallback took the words in: they are no longer a draft.
          if (out.crisis) tools.keep("teach", { ...kept, review: null });
          else if (out.fallback) tools.keep("teach", { ...kept, review: null, draft: String(kept.draft || "").trim() === text ? "" : kept.draft });
          else tools.drop("teach");
        }
        if (!this.alive) return;
        if (out.crisis) return wx.navigateTo({ url: "/pages/crisis/index" });
        // The text is in the chat now: shown there, no longer a draft. Asked
        // again on coming back, the chat as the server has it is read again.
        if (text) {
          this.setData({ draft: "", ...(pending.resent ? {} : { messages: this.data.messages.concat([mine(text)]) }) });
          if (out.fallback) this.keep();
        }
        if (pending.resent) this.load();
        if (out.fallback) return this.setData({ stage: "result", review: null, fallback: { keys: out.keys || [] } });
        this.showReview(out.message);
      })
      .catch((error) => {
        // Refused (not a lost line or a timeout): the next 讲完了 is a new one.
        if (!transient(error) && this.pending === pending) {
          this.pending = null;
          const kept = tools.kept("teach");
          if (kept && kept.review && kept.review.clientId === clientId) tools.keep("teach", { ...kept, review: null });
        }
        if (this.alive && !api.needsConsent(error)) this.setData({ reviewError: errorText(error) });
      })
      .finally(() => this.alive && this.setData({ reviewing: false }));
  },
  leave() {
    wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: "/pages/learn/index" }) });
  },
  showReview(message) {
    this.reviewMessage = message;
    this.setData({ stage: "result", review: reviewView(message.review), fallback: null });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  goOn() {
    this.setData({ stage: "talk", focus: true, reviewError: "" });
  },
  // 存成卡: the clearest sentence as 我的话; pages/collect lets the learner pick another.
  save() {
    const message = this.reviewMessage;
    if (!message || !this.thread) return;
    const said = this.data.messages.filter((m) => m.role === "user");
    const quote = (this.data.review && this.data.review.best) || chatV2.quotes(said)[0] || "";
    getApp().globalData.collect = chatV2.teachCollectIntent(message, { ...this.thread, scene: this.thread.scene || "study" }, quote, said);
    wx.navigateTo({ url: "/pages/collect/index" });
  },
  faceBroken() {
    this.setData({ faceBroken: true });
  },
}));
