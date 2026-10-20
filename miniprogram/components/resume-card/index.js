const api = require("../../utils/api");
const auth = require("../../utils/auth");
const visit = require("../../utils/visit");
const clock = require("../../utils/clock");
const { errorText } = require("../../utils/format");
const { openChat, chatAboutCard } = require("../../utils/chat-entry");
const { asset } = require("../../utils/assets");
const { TYPES } = require("../../utils/cards");
const { once } = require("../../utils/tap");
const owner = () => (auth.getUser() || {}).id || "";
const today = () =>
  new Date(clock.now() + 8 * 3600000).toISOString().slice(0, 10);
// The server treats these answers as "not now" (a skip).
const NOT_NOW = ["还在想", "先放着", "还在进行", "还没"];
// the server asks by the card's follow-up mode (回顾 / 做了吗 /
// 接着聊) and says what each option does; nothing is rewritten here.
// look is a reminder on a card that asks nothing (a look back).
const KICKERS = { recall: "回顾", todo: "问问进展", chat: "接着想", look: "回头看看" };
const DAY = 86400000;
const daysAgo = (at) => {
  const time = at ? new Date(at).getTime() : NaN;
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, Math.floor((clock.now() - time) / DAY));
};
const TITLES = {
  skip: "好，先放着",
  never: "好，不再提这件事",
  remind: "到时提醒你",
};
// the receipt says what the option actually did (the server's acts).
const ACT_TITLES = { later: "好，过几天再问", never: "好，不再提醒" };
const view = (item) => {
  if (!item) return null;
  const title = item.title || (item.card && item.card.title) || "这件事",
    card = item.card || null,
    type = card && (TYPES[card.kind] || TYPES[card.type]),
    days = daysAgo(card && card.createdAt),
    kicker = KICKERS[item.kind] || "回顾",
    acts = Array.isArray(item.acts) ? item.acts : null,
    options = item.options || [];
  // With acts (V4.2 servers) every option shows and 稍后 only when none of
  // them already means "later"; older servers keep 稍后 as the one link.
  const choices = acts
    ? options.slice(0, 3)
    : options.filter((o) => o !== "先放着").slice(0, 3);
  return {
    ...item,
    title,
    typeName: type ? type.name : "",
    typeClass: type ? type.cls : "",
    kicker: days ? `${kicker} · ${days} 天前的卡片` : kicker,
    // The words from back then, shown only when they differ from the title.
    said: item.quote && item.quote !== title ? item.quote : "",
    choices,
    choiceActs: acts ? choices.map((_, i) => acts[i] || "answer") : [],
    later: !acts || !acts.slice(0, choices.length).includes("later"),
  };
};
// With nothing to ask back: a first nudge for a new user, or the last chat
// (older servers send neither, and the slot keeps today's fold).
const promptOf = (result, item) => {
  if (item || !result) return null;
  if (result.first === true) return { kind: "first" };
  const last = result.lastChat;
  if (last && last.threadId) {
    const title = last.title || "上次的话题",
      stem = title.replace(/…$/, "");
    return {
      kind: "chat",
      threadId: last.threadId,
      title,
      // A one-message chat has the same words as the title: say them once.
      quote: last.quote && !last.quote.startsWith(stem) ? last.quote : "",
    };
  }
  return null;
};
// A receipt asks one thing: when > conclusion > keep the words > was it useful.
const followUp = (reply, text) =>
  reply.askWhen && text === "定了"
    ? "when"
    : reply.offerClose
      ? "close"
      : reply.offerMine
        ? "mine"
        : reply.feedback
          ? "feedback"
          : "";

Component({
  options: { styleIsolation: "apply-shared" },
  properties: {
    // 随心记 : only something to ask back shows; no nudge to write or
    // to go back to the last chat (聊一聊 keeps its history), and no
    // 还没想完的 › or lookback line (回顾 on the 卡片 tab lists them).
    quiet: { type: Boolean, value: false },
    // 随心记 : with nothing due, the card to tidy next ({ id, title,
    // typeName, typeClass }) as 整理一下 / 稍后; 稍后 is the page's to keep.
    tidy: { type: Object, value: null },
  },
  data: {
    face: "",
    faceFail: false,
    result: null,
    item: null,
    prompt: null,
    receipt: null,
    collapsed: false,
    busy: false,
    text: "",
    writing: false,
    error: "",
    undoVisible: false,
    remind: false,
    remindDate: "",
    remindTime: "21:00",
    aiUnavailable: false,
    // /v1/resume/open has answered (or failed) for this visit.
    known: false,
  },
  lifetimes: {
    attached() {
      this.alive = true;
      this.setData({ face: asset("xiaoli-face.webp") });
      this.load();
    },
    detached() {
      this.alive = false;
      this.generation = (this.generation || 0) + 1;
      clearTimeout(this.undoTimer);
    },
  },
  pageLifetimes: {
    show() {
      this.alive = true;
      this.setData({ busy: false });
      this.load();
    },
    hide() {
      this.alive = false;
      this.generation = (this.generation || 0) + 1;
    },
  },
  methods: {
    async load(force = false) {
      const account = owner(),
        id = visit.current();
      if (!account || !auth.hasConsent()) {
        this.loaded = "";
        this.setData({
          result: null,
          item: null,
          prompt: null,
          receipt: null,
          known: true,
        });
        this.triggerEvent("state", { shown: false });
        return;
      }
      const key = `${account}:${id}`;
      // 到点再问: a visit opened before the time asks again; the
      // server keeps the visit's answer once it has one.
      const waiting = this.cached && this.cached.kind === "time";
      if (this.loaded === key && !force && !waiting) {
        if (this.cached && !this.data.result) this.applyResult(this.cached);
        return;
      }
      this.loaded = key;
      this.cached = null;
      this.account = account;
      const generation = (this.generation = (this.generation || 0) + 1);
      this.setData({
        result: null,
        item: null,
        prompt: null,
        receipt: null,
        known: false,
        error: "",
        collapsed: false,
        text: "",
        writing: false,
      });
      try {
        const result = await api.post("/v1/resume/open", { visitId: id });
        if (this.loaded !== key || account !== owner()) return;
        this.cached = result;
        if (this.alive) this.applyResult(result);
      } catch (_) {
        /* Opening failure is deliberately silent until the next visit. */
        if (this.loaded === key && account === owner() && this.alive) {
          this.setData({ known: true });
          this.triggerEvent("state", { shown: false });
        } else if (this.loaded === key && !this.alive) {
          // Failed while hidden : the next show asks again instead of
          // leaving the top card unknown for the rest of this visit.
          this.loaded = "";
        }
      }
    },
    applyResult(result) {
      const item = view(result.item);
      this.setData({
        result,
        item,
        prompt: this.data.quiet ? null : promptOf(result, item),
        collapsed: item && item.state === "done",
        known: true,
      });
      this.triggerEvent("state", { shown: Boolean(item) });
    },
    // The tidy card: 整理一下 opens the card, 稍后 is the page's.
    tidyOpen() {
      const tidy = this.data.tidy;
      if (tidy && tidy.id && once(this))
        wx.navigateTo({
          url: `/pages/card/index?id=${encodeURIComponent(tidy.id)}`,
        });
    },
    tidyLater() {
      this.triggerEvent("tidylater");
    },
    openCard() {
      const item = this.data.item;
      if (this.active() && item && item.card)
        wx.navigateTo({
          url: `/pages/card/index?id=${encodeURIComponent(item.card.id)}`,
        });
    },
    active(account = this.account, generation = this.generation) {
      return (
        this.alive && account === owner() && generation === this.generation
      );
    },
    async perform(work) {
      if (this.data.busy || !this.active()) return;
      const account = this.account,
        generation = this.generation;
      this.setData({ busy: true, error: "" });
      try {
        const result = await work();
        if (!this.active(account, generation)) return;
        if (result && result.crisis) {
          this.setData({ item: null, receipt: null, result: null, text: "" });
          wx.navigateTo({ url: "/pages/crisis/index" });
          return;
        }
        return result;
      } catch (error) {
        if (this.active(account, generation))
          this.setData({ error: errorText(error) });
      } finally {
        if (this.active(account, generation)) this.setData({ busy: false });
      }
    },
    choose(event) {
      const text = event.currentTarget.dataset.text,
        item = this.data.item,
        index = item ? item.choices.indexOf(text) : -1,
        picked = index >= 0 ? item.choiceActs[index] : "";
      // what the option does, as the server said.
      if (picked === "write") {
        this.setData({ writing: true });
        return;
      }
      if (picked === "practice") return this.openLearning();
      if (picked === "open" && item.url) return this.openTask();
      if (picked === "forgot" && item.card)
        return this.act("answer", text).then(() => this.openCard());
      if (picked === "chat" && item.card)
        return this.act("answer", text).then(() => {
          // V4.2 : back to the card's own chat when there is one.
          if (this.active()) chatAboutCard(item.card);
        });
      if (picked) return this.act("answer", text);
      if (text === "写一句" || text === "补充一句") {
        this.setData({ writing: true });
        return;
      }
      if (text === "做一题") {
        this.openLearning();
        return;
      }
      if (text === "看看" && this.data.item && this.data.item.url)
        return this.openTask();
      return this.act("answer", text);
    },
    async openTask() {
      const item = this.data.item;
      if (!item || !item.url) return;
      const reply = await this.perform(() =>
        api.post(`/v1/resume/${item.id}/act`, {
          action: "answer",
          text: "看看",
        }),
      );
      if (!reply) return;
      this.setData({ item: view(reply.item), collapsed: true });
      wx.navigateTo({ url: item.url });
    },
    input(event) {
      this.setData({ text: event.detail.value });
    },
    submit() {
      return this.act("answer", this.data.text);
    },
    skip() {
      return this.act("skip");
    },
    never() {
      return this.act("never");
    },
    closeMenu() {
      wx.showActionSheet({
        itemList: ["不再提起", "到时提醒我", "收起"],
        success: ({ tapIndex }) => {
          if (!this.active()) return;
          if (tapIndex === 0) this.never();
          else if (tapIndex === 1) this.remindOpen();
          else this.fold();
        },
      });
    },
    async act(action, text, remindAt) {
      const item = this.data.item;
      if (!item) return;
      const reply = await this.perform(() =>
        api.post(`/v1/resume/${item.id}/act`, {
          action,
          ...(text ? { text } : {}),
          ...(remindAt ? { remindAt } : {}),
        }),
      );
      if (!reply) return;
      clearTimeout(this.undoTimer);
      // What the option did (V4.2 servers say it in acts); older servers by
      // the words. 稍后-like and 不用提醒 are not answers to follow up on.
      const index = action === "answer" && item.choices ? item.choices.indexOf(text) : -1,
        picked = index >= 0 ? item.choiceActs[index] || "" : "",
        done =
          action !== "answer"
            ? action
            : picked === "later"
              ? "later"
              : picked === "never"
                ? "never"
                : !picked && NOT_NOW.includes(text)
                  ? "skip"
                  : "answer";
      const ask = done === "answer" ? followUp(reply, text) : "";
      this.setData({
        receipt: {
          ...reply,
          answer: text || "",
          // Only an answer offers 让 AI 再理一遍.
          action: done === "later" ? "skip" : done,
          title:
            done === "answer" &&
            (picked === "close" || (!picked && ["已完成", "做了"].includes(text))) &&
            !reply.offerClose
              ? "完成了"
              : done === "answer"
                ? "记下了"
                : (picked && ACT_TITLES[done]) || TITLES[done] || TITLES.skip,
          ask,
          // Only a rating question that was shown can be dismissed by folding.
          feedback: ask === "feedback",
        },
        item: view(reply.item),
        text: "",
        writing: false,
        remind: false,
        collapsed: false,
        undoVisible: Boolean(reply.undoToken),
        aiUnavailable: false,
      });
      this.undoTimer = setTimeout(() => {
        if (this.active()) this.setData({ undoVisible: false });
      }, 5000);
      this.triggerEvent("changed");
    },
    async undo() {
      const receipt = this.data.receipt;
      if (!receipt || !receipt.undoToken || !this.data.undoVisible) return;
      const item = await this.perform(() =>
        api.post("/v1/resume/undo", { token: receipt.undoToken }),
      );
      if (item) {
        clearTimeout(this.undoTimer);
        this.setData({ item: view(item), receipt: null, undoVisible: false });
        this.triggerEvent("changed");
      }
    },
    fold() {
      if (this.data.receipt && this.data.receipt.feedback)
        this.feedback({ currentTarget: { dataset: { value: "dismiss" } } });
      this.setData({ collapsed: true, remind: false });
    },
    faceError() {
      this.setData({ faceFail: true });
    },
    expand() {
      this.setData({ collapsed: false });
    },
    unfinished() {
      wx.navigateTo({ url: "/pages/resume-list/index" });
    },
    compose() {
      this.triggerEvent("compose");
    },
    continueChat() {
      const prompt = this.data.prompt;
      if (prompt && prompt.threadId) openChat({ threadId: prompt.threadId });
    },
    wrapChat() {
      const prompt = this.data.prompt;
      if (prompt && prompt.threadId)
        openChat({ threadId: prompt.threadId, wrap: true });
    },
    openReflection() {
      const result = this.data.result;
      if (this.active() && result && result.url)
        wx.navigateTo({ url: result.url });
    },
    async feedback(event) {
      const item = this.data.item,
        receipt = this.data.receipt;
      if (!item || !receipt || !receipt.feedback || !this.active()) return;
      this.setData({ "receipt.feedback": false, "receipt.ask": "" });
      try {
        await api.post(`/v1/resume/${item.id}/feedback`, {
          value: event.currentTarget.dataset.value,
        });
      } catch (_) {
        /* An optional rating must not block the receipt. */
      }
    },
    async when(event) {
      const item = this.data.item,
        when = event.currentTarget.dataset.when;
      if (!item || !item.card) return;
      const result = await this.perform(() =>
        api.post(`/v1/resume/${item.id}/when`, {
          when,
          version: item.card.version,
        }),
      );
      if (result) {
        this.setData({
          "item.card": result.card,
          "receipt.askWhen": false,
          "receipt.ask": "",
          "receipt.title": when === "week" ? "好，这周做" : "好，下周做",
          undoVisible: false,
        });
        this.triggerEvent("changed");
      }
    },
    async saveMine() {
      const item = this.data.item,
        receipt = this.data.receipt;
      if (!item || !item.card || !receipt) return;
      const closing = Boolean(receipt.offerClose),
        text = closing ? this.data.text.trim() : receipt.answer;
      if (text.length < 2) {
        this.setData({ error: "写一句再存" });
        return;
      }
      const result = await this.perform(async () => {
        const mine = await api.post(`/v1/cards/${item.card.id}/mine`, {
          version: item.card.version,
          text,
        });
        if (!this.active()) return null;
        if (mine.crisis || !closing) return mine;
        return api.post(`/v1/cards/${item.card.id}/close`, {
          version: mine.card.version,
          text,
        });
      });
      if (result) {
        this.setData({
          "item.card": result.card,
          "receipt.offerClose": false,
          "receipt.offerMine": false,
          "receipt.ask": "",
          "receipt.title": closing ? "收好了" : "存下了",
          text: "",
          undoVisible: false,
        });
        this.triggerEvent("changed");
      }
    },
    remindOpen() {
      this.setData({ remind: true, remindDate: today(), remindTime: "21:00" });
    },
    remindDate(event) {
      this.setData({ remindDate: event.detail.value });
    },
    remindTime(event) {
      this.setData({ remindTime: event.detail.value });
    },
    remindSave() {
      const time = new Date(
        `${this.data.remindDate}T${this.data.remindTime}:00+08:00`,
      );
      if (!Number.isFinite(time.getTime()) || time.getTime() <= Date.now()) {
        this.setData({ error: "挑一个还没到的时间" });
        return;
      }
      return this.act("remind", null, time.toISOString());
    },
    async tidy() {
      const item = this.data.item;
      if (!item || this.data.aiUnavailable) return;
      const result = await this.perform(async () => {
        try {
          return await api.post(`/v1/resume/${item.id}/ai`, {});
        } catch (error) {
          if (this.active() && /QUOTA|LIMIT/.test(error.code || ""))
            this.setData({ aiUnavailable: true });
          throw error;
        }
      });
      if (result) {
        wx.showToast({ title: "正在理一理", icon: "none" });
        wx.navigateTo({
          url: `/pages/card/index?id=${encodeURIComponent(item.card.id)}`,
        });
      }
    },
    openLearning() {
      const item = this.data.item;
      if (item && item.url) {
        wx.navigateTo({ url: item.url });
        return;
      }
      const id = item && ((item.card && item.card.pointId) || item.srcId);
      if (id)
        wx.navigateTo({
          url: `/pages/point/index?id=${encodeURIComponent(id)}&mode=${item.kind === "review" ? "review" : "retest"}`,
        });
    },
  },
});
