const { withShare } = require("../../utils/share");
/*
 * 错题本：查看待重做与已掌握的题，进入重做、同类练习或讲解，并支持移出错题本。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const auth = require("../../utils/auth");
const owner = () => (auth.getUser() || {}).id || "";
const stream = require("../../utils/stream");
const { errorText, dueText, sourceOf } = require("../../utils/format");
const gate = require("../../utils/gate");
const studyClock = require("../../utils/study-clock");
const { backTo, ROUTES } = require("../../utils/learn");
const { openAsk } = require("../../utils/chat-entry");
const TONE = "light";
// the list comes a page at a time (the server used to stop at 200).
const PAGE = 50;
// An unsent redo answer, per entry and account (V4.2 FX2: another account on
// this phone never sees it), survives leaving the page.
const DRAFT = "mistake-redo:";
const draftKey = (id) => `${DRAFT}${id}:${owner()}`;
const draftOf = (id) => {
  try {
    return String(wx.getStorageSync(draftKey(id)) || "");
  } catch (error) {
    return "";
  }
};
const keepDraft = (id, text) => {
  try {
    if (text) wx.setStorageSync(draftKey(id), text);
    else wx.removeStorageSync(draftKey(id));
  } catch (error) {}
};
// Chapters that can be practised (server: PRACTICE).
const PRACTICABLE = [
  "limit",
  "derivative",
  "application",
  "indefinite",
  "definite",
];
const VERDICT = {
  correct: {
    tone: "green",
    mark: "tick-green",
    title: "做对了！这题你会了",
  },
  incorrect: {
    tone: "red",
    mark: "cross-red",
    title: "差一点，先留着，下次再来",
  },
  unsure: { tone: "amber", mark: "query-pencil", title: "这题拿不准对错" },
};
// 弄懂了 by hand (我会了) is not 重做对了; older entries say neither.
const MASTERED = { self: "标了会", redo: "重做对了" };
function card(item) {
  return {
    ...item,
    when:
      item.status === "mastered"
        ? MASTERED[item.masteredBy] || "会了"
        : item.due
          ? "今天该做"
          : `${dueText(item.dueOn)}重做`,
    whenTone: item.status === "mastered" ? "green" : item.due ? "red" : "",
    sourceText: item.source === "grade" ? "批改发现" : "我的答案",
    // A worked solution found wrong is redone as a worked solution, in its
    // conversation, not as one line of result.
    redoText: item.source === "grade" && item.threadId ? "重写过程" : "再做一次",
  };
}
// The judged redo, from the judge message of the conversation.
function verdictOf(message) {
  const r = message.attempt && message.attempt.result;
  if (!r)
    return {
      tone: "amber",
      mark: "query-pencil",
      title: api.jobMessage(message.job) || "这次没看出对错，再交一次试试",
    };
  const head = VERDICT[r.verdict] || VERDICT.unsure;
  return {
    ...head,
    correct: r.verdict === "correct",
    reference: r.reference ? r.reference.text || r.reference.value : "",
    sourceText: sourceOf(r.reference).text,
    cause: r.cause ? r.cause.label : "",
  };
}
Page(
  withShare(studyClock.track({
    data: {
      status: "open",
      chapter: "",
      pointId: "",
      practicable: false,
      counts: null,
      items: [],
      shown: [],
      more: false,
      moreBusy: false,
      redo: null,
      loading: true,
      error: "",
    },
    onLoad(query = {}) {
      this.alive = true;
      this.setData({ pointId: query.pointId || "" });
    },
    onUnload() {
      this.alive = false;
    },
    onShow() {
      if (!gate.check()) return;
      this.alive = true;
      // A guest has no mistakes to load.
      if (gate.state() !== "ok") return this.setData({ loading: false, items: [], shown: [] });
      this.load();
    },
    onHide() {
      this.alive = false;
      this.loadId = (this.loadId || 0) + 1;
    },
    onPullDownRefresh() {
      if (gate.state() !== "ok") return wx.stopPullDownRefresh();
      this.load().then(() => wx.stopPullDownRefresh());
    },
    // The list from the server, filtered by the chapter there; `offset`
    // reads the next page onto the end.
    url(offset) {
      const { status, pointId, chapter } = this.data;
      return `/v1/mistakes?status=${status}&tone=${TONE}${pointId ? "&pointId=" + encodeURIComponent(pointId) : ""}${status === "open" && chapter ? "&chapter=" + encodeURIComponent(chapter) : ""}&limit=${PAGE}&offset=${offset}`;
    },
    load() {
      const account = owner(),
        seq = (this.loadId = (this.loadId || 0) + 1);
      const active = () =>
        this.alive && account === owner() && seq === this.loadId;
      this.setData({ loading: true, error: "" });
      return api
        .get(this.url(0))
        .then(({ items, counts, more }) => {
          if (!active()) return;
          // The chapter emptied meanwhile: show them all.
          if (
            this.data.chapter &&
            !counts.chapters.some((c) => c.chapter === this.data.chapter)
          ) {
            this.setData({ chapter: "", practicable: false });
            return this.load();
          }
          this.setData({ items: items.map(card), counts, more: Boolean(more) });
          this.filter();
        })
        .catch((error) => {
          if (active() && !api.needsConsent(error))
            this.setData({ error: errorText(error) });
        })
        .finally(() => {
          if (active()) this.setData({ loading: false });
        });
    },
    onReachBottom() {
      this.loadMore();
    },
    loadMore() {
      if (!this.data.more || this.data.moreBusy || this.data.loading) return;
      const seq = this.loadId,
        account = owner();
      const active = () =>
        this.alive && account === owner() && seq === this.loadId;
      this.setData({ moreBusy: true });
      return api
        .get(this.url(this.data.items.length))
        .then(({ items, more }) => {
          if (!active()) return;
          const have = new Set(this.data.items.map((i) => i.id));
          this.setData({
            items: this.data.items.concat(items.filter((i) => !have.has(i.id)).map(card)),
            more: Boolean(more),
          });
          this.filter();
        })
        .catch((error) => {
          if (active() && !api.needsConsent(error))
            this.setData({ error: errorText(error) });
        })
        .finally(() => {
          if (active()) this.setData({ moreBusy: false });
        });
    },
    clearPoint() {
      this.setData({ pointId: "", chapter: "", items: [], shown: [] });
      return this.load();
    },
    filter() {
      const { items, chapter, status } = this.data;
      const shown =
        status === "open" && chapter
          ? items.filter((i) => (i.chapter || "other") === chapter)
          : items;
      this.setData({ shown });
    },
    setStatus(event) {
      this.setData({
        status: event.currentTarget.dataset.status,
        chapter: "",
        items: [],
        shown: [],
      });
      this.load();
    },
    setChapter(event) {
      const chapter = event.currentTarget.dataset.chapter;
      const next = chapter === this.data.chapter ? "" : chapter;
      this.setData({ chapter: next, practicable: PRACTICABLE.includes(next) });
      this.filter();
      return this.load();
    },
    find(event) {
      return this.data.items.find(
        (i) => i.id === event.currentTarget.dataset.id,
      );
    },
    // ---- redo --------------------------------------------------------------
    // A problem asked in 问 AI is answered here and judged in its conversation;
    // one collected on the problem page goes back there.
    redo(event) {
      const item = this.find(event);
      if (!item) return;
      if (!item.threadId)
        return api.openMaterial({
          id: item.materialId,
          kind: "problem",
          status: "confirmed",
        });
      if (item.source === "grade") return this.ask({ threadId: item.threadId });
      this.setData({
        redo: {
          item,
          answer: draftOf(item.id),
          sending: false,
          verdict: null,
          blocks: [],
          error: "",
          judgeId: "",
          clientId: "",
        },
      });
    },
    // Another answer is another submission: it gets its own clientId.
    onAnswer(event) {
      this.setData({ "redo.answer": event.detail.value, "redo.clientId": "" });
      if (this.data.redo) keepDraft(this.data.redo.item.id, event.detail.value);
    },
    submitRedo() {
      const redo = this.data.redo;
      const answer = redo && redo.answer.trim();
      if (!answer || redo.sending) return;
      // the clientId of the first submit stays until it is judged,
      // so a retry after a timeout is the same answer, judged once.
      const clientId = redo.clientId || stream.clientId();
      this.setData({ "redo.sending": true, "redo.error": "", "redo.clientId": clientId, error: "" });
      // Sent once: a failure after the server took it reads that judgement
      // again instead of answering twice.
      const sent = redo.judgeId
        ? Promise.resolve({ id: redo.judgeId, job: null })
        : api
            .post(`/v1/chat/threads/${redo.item.threadId}/answer`, {
              answer,
              clientId,
              tone: TONE,
            })
            .then(({ judge }) => {
              if (this.data.redo && this.data.redo.item.id === redo.item.id)
                this.setData({ "redo.judgeId": judge.id });
              return judge;
            });
      sent
        .then((judge) =>
          judge.job
            ? api
                .waitJob(judge.job, () => this.alive)
                .catch(() => null)
                .then(() => judge)
            : judge,
        )
        .then((judge) => api.get(`/v1/chat/messages/${judge.id}?tone=${TONE}`))
        .then((message) => {
          keepDraft(redo.item.id, "");
          const verdict = verdictOf(message);
          return Promise.all([
            this.load(),
            api
              .get(`/v1/chat/threads/${redo.item.threadId}?tone=${TONE}`)
              .catch(() => null),
          ]).then(([, fresh]) => {
            // Right before it is due (the same day it went wrong) does not master it.
            if (
              verdict.correct &&
              this.data.items.some((i) => i.id === redo.item.id)
            )
              verdict.title = "做对了！明天再对一次就算会了";
            if (
              this.alive &&
              this.data.redo &&
              this.data.redo.item.id === redo.item.id
            )
              this.setData({
                "redo.item": {
                  ...(this.data.items.find((i) => i.id === redo.item.id) ||
                    redo.item),
                  mapPoint:
                    fresh && fresh.thread.mistake
                      ? fresh.thread.mistake.mapPoint || null
                      : null,
                },
                "redo.verdict": verdict,
                "redo.blocks": message.blocks || [],
                "redo.judgeId": "",
                "redo.clientId": "",
              });
          });
        })
        .catch((error) => {
          // The answer stays in the box; the error shows where it was sent.
          if (api.needsConsent(error)) return;
          if (this.data.redo && this.data.redo.item.id === redo.item.id)
            this.setData({ "redo.error": errorText(error) });
          else this.setData({ error: errorText(error) });
        })
        .finally(() => {
          if (this.data.redo) this.setData({ "redo.sending": false });
        });
    },
    again() {
      this.setData({
        "redo.answer": "",
        "redo.verdict": null,
        "redo.blocks": [],
        "redo.error": "",
        "redo.judgeId": "",
        "redo.clientId": "",
      });
    },
    closeRedo() {
      if (this.data.redo && this.data.redo.sending) return;
      this.setData({ redo: null });
    },
    openMap(event) {
      const item =
        event && event.currentTarget.dataset.id
          ? this.find(event)
          : this.data.redo && this.data.redo.item;
      if (!item) return;
      if (item.mapPoint) return backTo(ROUTES.point, item.mapPoint.id);
      if (
        this.data.redo &&
        this.data.redo.verdict &&
        this.data.redo.verdict.correct
      )
        return backTo(ROUTES.map);
    },
    // ---- the conversation --------------------------------------------------
    ask(intent) {
      this.setData({ redo: null });
      openAsk(intent);
    },
    explain(event) {
      const item = this.find(event) || (this.data.redo && this.data.redo.item);
      if (item && item.threadId) this.ask({ threadId: item.threadId });
    },
    similar(event) {
      const item = this.find(event) || (this.data.redo && this.data.redo.item);
      if (item && item.threadId)
        this.ask({ threadId: item.threadId, similar: true });
    },
    // ---- filing ------------------------------------------------------------
    mark(event) {
      const item = this.find(event);
      if (!item) return;
      const status = item.status === "open" ? "mastered" : "open";
      api
        .post(`/v1/mistakes/${item.id}`, { status })
        .then(() => {
          wx.showToast({
            title: status === "mastered" ? "记下了，这题你会了" : "好，放回去再练练",
            icon: "none",
          });
          return this.load();
        })
        .catch((error) => {
          if (!api.needsConsent(error)) this.setData({ error: errorText(error) });
        });
    },
    manage(event) {
      const item = this.find(event);
      if (!item) return;
      wx.showActionSheet({
        itemList: ["拿出错题本"],
        itemColor: "#c0392b",
        success: () => this.remove(event),
      });
    },
    remove(event) {
      const item = this.find(event);
      if (!item) return;
      api
        .del(`/v1/mistakes/${item.id}`)
        .then(() => {
          wx.showToast({ title: "拿出来了，题目和对话还在", icon: "none" });
          return this.load();
        })
        .catch((error) => {
          if (!api.needsConsent(error)) this.setData({ error: errorText(error) });
        });
    },
    // Everything on a card besides 重做 sits behind its ⋯.
    cardMore(event) {
      const item = this.find(event);
      if (!item) return;
      const actions = [];
      if (item.threadId) actions.push(["再来一道差不多的", "similar"], ["看讲解", "explain"]);
      actions.push([item.status === "open" ? "我会了" : "再练练", "mark"]);
      if (item.mapPoint) actions.push([`去看看「${item.mapPoint.name}」`, "openMap"]);
      actions.push(["拿出错题本", "remove"]);
      wx.showActionSheet({
        itemList: actions.map((a) => a[0]),
        success: ({ tapIndex }) => actions[tapIndex] && this[actions[tapIndex][1]](event),
      });
    },
    practice() {
      this.ask({ practice: this.data.chapter });
    },
    askPhoto() {
      this.ask({ photo: "problem" });
    },
    noop() {},
  })),
);
