const { withShare } = require("../../utils/share");
/*
 * 随心记首页：保存用户输入，展示回顾入口与最近卡片；完整卡片列表由 deck 页面负责。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
// 随心记: only the box to write in, 试试这样写 and the
// last few cards. The card list, search, filters and 多选 are on the 卡片 tab.
// one 小狸 card on top, the first that applies: something due to look
// back at (resume-card), else the latest unfinished card to tidy (稍后 hides
// it for the day), else the hello card while there are no cards. Nothing is
// drawn there before the card count (and the look-back) has come back.
const api = require("../../utils/api"),
  auth = require("../../utils/auth"),
  gate = require("../../utils/gate");
const { view, sceneParam } = require("../../utils/cards");
const { cards: examples } = require("../../utils/examples");
const { errorText } = require("../../utils/format");
const { asset } = require("../../utils/assets");
const clock = require("../../utils/clock");
const { openChat } = require("../../utils/chat-entry");
const { clientId } = require("../../utils/stream");
const owner = () => (auth.getUser() || {}).id || "";
const DECK = "/pages/deck/index";
// 聊一聊's own mark of the chats already offered to go on with (V4.2 FX1:
// the line here follows it, so 开新话题 on the tab ends it here too).
const SEEN = "zhiye_talk_replay_seen:";
// How many cards 最近 shows.
const RECENT = 3;
// 试试这样写: only while the account has no cards yet and the box is empty
// ; a tap puts the line into the box.
const TRIES = [
  { type: "question", name: "问题", text: "极限这块听不懂" },
  { type: "spark", name: "灵感", text: "错题拍照就能变成卡" },
  { type: "idea", name: "想法", text: "这周想把哪件事理一理" },
];
const HELLO_KEY = "zhiye_notes_hello_closed";
// The day (Beijing) 稍后 was tapped on the tidy card.
const TIDY_LATER_KEY = "zhiye_notes_tidy_later";
const ONBOARDED = "zhiye_onboarded";
// What is left in the box once `sent` was saved : words typed
// after it stay; if the sent words themselves were changed, all of it stays.
function leftAfter(now, sent) {
  if (String(now).trim() === String(sent).trim()) return "";
  return now.startsWith(sent) ? now.slice(sent.length).replace(/^\s+/, "") : now;
}
// The words not yet saved, per account, so leaving or a restart keeps
// them. The save in flight keeps its clientId with it until it succeeds.
const DRAFT_KEY = "zhiye_notes_draft:";
const draftOf = (account) => {
  try {
    const value = account && wx.getStorageSync(DRAFT_KEY + account);
    return value && typeof value === "object" ? value : null;
  } catch (_) {
    return null;
  }
};
const keepDraft = (account, text, id) => {
  if (!account) return;
  try {
    if (text) wx.setStorageSync(DRAFT_KEY + account, { text, clientId: id || "" });
    else wx.removeStorageSync(DRAFT_KEY + account);
  } catch (_) {}
};
// Set by pages/onboard for this run, so a failed storage write cannot send
// 随心记 back to the tour again and again.
function toured() {
  try {
    return Boolean(getApp().globalData.onboardShown);
  } catch (_) {
    return false;
  }
}
const today = () =>
  new Date(clock.now() + 8 * 3600000).toISOString().slice(0, 10);
const read = (key) => {
  try {
    return wx.getStorageSync(key);
  } catch (_) {
    return "";
  }
};
const tidyLaterToday = () => {
  const day = read(TIDY_LATER_KEY);
  return Boolean(day) && day === today();
};
// The card to tidy next : only one still at 已记下 that nothing has
// organized yet (no summary, no slots), not a mood card; newest first.
// Cards already organized or said clearly are not asked again.
function tidyPick(cards) {
  const card = (cards || []).find(
    (c) =>
      c &&
      !c.done &&
      !c.mood &&
      !c.crisis &&
      c.stage === "written" &&
      !c.summary &&
      !(c.slots || []).some((slot) => slot && String(slot.text || "").trim()),
  );
  return card
    ? {
        id: card.id,
        title: card.titleView.text,
        typeName: card.typeName,
        typeClass: card.typeClass,
        stageName: card.stageName,
        stage: card.stage,
      }
    : null;
}
Page(withShare({
  data: {
    // "none" (not agreed, not a guest) shows only the background until the
    // welcome page opens; a guest sees the page with examples and sends
    // nothing that needs an account.
    ready: false,
    guest: false,
    helloClosed: false,
    helloFail: false,
    helloImg: "",
    tries: TRIES,
    consent: false,
    text: "",
    saving: false,
    saved: false,
    savedCard: null,
    firstHint: false,
    error: "",
    recent: [],
    allTotal: 0,
    // The card count has come back (or failed); until then no hello card.
    cardsLoaded: false,
    // resume-card has answered, and whether it shows something due.
    resumeKnown: false,
    resumeShown: false,
    tidy: null,
    // V4.2 : the latest 聊一聊 chat left unfinished, one line to go on.
    chatBack: null,
    loading: false,
    composeFocus: false,
    context: null,
  },
  onLoad() {
    let helloClosed = false;
    try {
      helloClosed = wx.getStorageSync(HELLO_KEY) === "1";
    } catch (e) {}
    this.setData({
      ready: gate.state() !== "none",
      helloClosed,
      helloImg: asset("xiaoli-hi.webp"),
    });
  },
  onShow() {
    // Nothing agreed and not a guest: back to the welcome page.
    if (!gate.check()) return;
    const guest = gate.state() === "guest";
    // Agreed but never saw the tour on this phone (e.g. agreed again to new
    // documents): show it once. The tour marks itself seen when it opens.
    if (!guest && read(ONBOARDED) !== "1" && !toured()) {
      wx.reLaunch({ url: "/pages/onboard/index" });
      return;
    }
    this.setData({ ready: true, guest });
    this.alive = true;
    this.epoch = (this.epoch || 0) + 1;
    const account = owner();
    const switched = this.account && this.account !== account;
    if (switched)
      this.setData({
        recent: [],
        text: "",
        saved: false,
        savedCard: null,
        firstHint: false,
        allTotal: 0,
        cardsLoaded: false,
        resumeKnown: false,
        resumeShown: false,
        tidy: null,
        context: null,
      });
    // A save that finished while away: the box keeps only what came after.
    if (!switched && this.savedAway === account) {
      this.setData({ text: this.savedRest || "", saved: true });
      this.savedAway = "";
      this.savedRest = "";
    }
    // Words handed to 聊一聊 : once the chat page took them, they
    // are not offered here again; if it never did, they stay.
    const handed = this.handedOver;
    this.handedOver = null;
    if (handed && !switched && getApp().globalData.chat !== handed.intent) {
      const rest = leftAfter(this.data.text, handed.raw);
      if (rest !== this.data.text) {
        this.setData({ text: rest });
        if (!guest) keepDraft(account, rest, "");
        this.draftId = "";
        this.draftText = undefined;
      }
    }
    // This account's unsaved words come back into an empty box.
    const draft = !guest && draftOf(account);
    if (draft && draft.text && !this.data.text) {
      this.setData({ text: draft.text });
      this.draftId = draft.clientId || "";
      this.draftText = draft.clientId ? draft.text.trim() : undefined;
    }
    this.setData({
      consent: auth.hasConsent(),
      loading: false,
      saving: false,
      error: "",
    });
    const app = getApp().globalData;
    // Pages that open the card list with a filter still come here; the
    // filter is the 卡片 tab's to use.
    if (app.cardFilter && this.data.consent) {
      wx.switchTab({
        url: DECK,
        fail() {
          app.cardFilter = null;
        },
      });
    }
    if (!this.data.consent) {
      // A guest sees the example cards; nothing is requested.
      this.setData({
        recent: guest ? examples.slice(0, RECENT).map(view) : [],
        allTotal: 0,
        cardsLoaded: true,
        tidy: null,
      });
      return;
    }
    if (app.noteContext) {
      this.setData({ context: app.noteContext });
      app.noteContext = null;
    }
    return this.load();
  },
  onHide() {
    this.alive = false;
    this.epoch = (this.epoch || 0) + 1;
  },
  onUnload() {
    this.onHide();
    clearTimeout(this.savedTimer);
  },
  active(epoch, account) {
    return (
      this.alive &&
      this.epoch === epoch &&
      account === owner() &&
      auth.hasConsent()
    );
  },
  onPullDownRefresh() {
    const stop = () => wx.stopPullDownRefresh();
    if (!this.data.consent) return stop();
    const resume = this.selectComponent && this.selectComponent("#resume");
    if (resume) resume.load(true);
    return this.load().then(stop, stop);
  },
  // 最近: the newest cards and how many there are (the first visit has none).
  async load() {
    const epoch = this.epoch,
      request = (this.request = (this.request || 0) + 1);
    let account = owner();
    this.setData({ loading: true, error: "" });
    try {
      await auth.login();
      if (!this.alive || epoch !== this.epoch || request !== this.request)
        return;
      account = owner();
      this.account = account;
      // The list's own order: the cards changed last come first.
      const scene = sceneParam(account);
      const result = await api.get(`/v1/cards${scene ? `?scene=${scene}` : ""}`);
      if (!this.active(epoch, account) || request !== this.request) return;
      const cards = (result.data || []).map(view);
      const later = tidyLaterToday(),
        tidy = later ? null : tidyPick(cards);
      this.setData({
        recent: cards.slice(0, RECENT),
        allTotal: result.total || 0,
        cardsLoaded: true,
        tidy,
      });
      // Only the first page came back: look among the open cards for one
      // still 已记下 (or any open one) before settling.
      if (!later && !tidy && (result.total || 0) > cards.length)
        this.moreTidy(epoch, account, request);
      const resume = this.selectComponent && this.selectComponent("#resume");
      if (resume) resume.load();
      this.loadChat(epoch, account, request);
    } catch (error) {
      if (
        this.alive &&
        epoch === this.epoch &&
        request === this.request &&
        (!account || account === owner())
      ) {
        if (api.needsConsent(error)) this.setData({ consent: false });
        else this.setData({ error: errorText(error) });
      }
    } finally {
      if (this.alive && epoch === this.epoch && request === this.request)
        this.setData({ loading: false });
    }
  },
  // The same rule as 聊一聊's replay (server `unfinished`); a mood chat is not
  // shown on the home page.
  async loadChat(epoch, account, request) {
    try {
      const { threads } = await api.get("/v1/chat/threads?kind=chat&limit=5");
      if (!this.active(epoch, account) || request !== this.request) return;
      let seen = {};
      try {
        seen = wx.getStorageSync(SEEN + account) || {};
      } catch (_) {}
      const open = (threads || []).find(
        (t) => t.unfinished && t.scene !== "mood" && seen[t.id] !== (t.lastAt || ""),
      );
      this.setData({
        chatBack: open ? { id: open.id, title: open.title || "对话", lastAt: open.lastAt || "" } : null,
      });
    } catch (_) {
      /* The line is left out. */
    }
  },
  goOnChat() {
    const open = this.data.chatBack;
    if (!open) return;
    // Gone on with: offered again only after something new is said, as on the tab.
    try {
      const key = SEEN + owner();
      wx.setStorageSync(key, { ...(wx.getStorageSync(key) || {}), [open.id]: open.lastAt });
    } catch (_) {}
    this.setData({ chatBack: null });
    openChat({ threadId: open.id }, { tab: true });
  },
  async moreTidy(epoch, account, request) {
    try {
      const scene = sceneParam(account);
      const open = await api.get(`/v1/cards?closed=0${scene ? `&scene=${scene}` : ""}`);
      if (!this.active(epoch, account) || request !== this.request || tidyLaterToday()) return;
      const tidy = tidyPick(((open && open.data) || []).map(view));
      if (tidy && !this.data.tidy) this.setData({ tidy });
    } catch (_) {
      /* The first page's pick stays. */
    }
  },
  onText(e) {
    const text = e.detail.value;
    this.setData({ text, error: "" });
    // Changed words are a new save; the old clientId goes with the old words.
    if (this.draftText !== undefined && this.draftText !== text.trim()) this.draftId = "";
    if (!this.data.guest) keepDraft(owner(), text, this.draftId);
  },
  async save() {
    // A guest cannot save: say why and offer the welcome page.
    if (this.data.guest || gate.state() !== "ok") return gate.ask();
    if (this.data.saving) return;
    const text = this.data.text.trim(),
      epoch = this.epoch,
      account = owner();
    if (!text) {
      this.setData({ error: "写一句再记下" });
      return;
    }
    if (!this.active(epoch, account)) return;
    // One clientId per words: a retry after a lost answer finds the first
    // card instead of making a second one (servers before V4.2 ignore it).
    const id = this.draftText === text && this.draftId ? this.draftId : clientId();
    // The box as sent: what is typed after it while saving is kept.
    const sent = this.data.text;
    this.draftId = id;
    this.draftText = text;
    keepDraft(account, sent, id);
    this.setData({ saving: true, error: "", saved: false });
    try {
      const result = await api.post("/v1/cards", {
        text,
        clientId: id,
        origin: this.data.context ? "map" : "jot",
        ...(this.data.context
          ? { pointId: this.data.context.pointId || this.data.context.id }
          : {}),
      });
      // Saved: the sent words leave the draft, even when the page was left
      // meanwhile; words typed since stay as a new draft.
      const rest = leftAfter(this.data.text, sent);
      if (account === owner() && !result.crisis) {
        keepDraft(account, rest, "");
        this.draftId = "";
        this.draftText = undefined;
      }
      if (!this.active(epoch, account)) {
        if (account === owner() && !result.crisis) {
          this.savedAway = account;
          this.savedRest = rest;
        }
        return;
      }
      if (result.crisis) {
        wx.navigateTo({ url: "/pages/crisis/index" });
        return;
      }
      const follow = result.card.follow;
      this.setData({
        text: rest,
        saved: true,
        savedCard: result.card,
        // Only when this card will be asked about later : a 随手记 or
        // a mood card is not.
        firstHint:
          this.data.allTotal === 0 &&
          result.card.scene !== "mood" &&
          follow !== "none",
        context: null,
      });
      clearTimeout(this.savedTimer);
      this.savedTimer = setTimeout(() => {
        if (this.active(epoch, account)) this.setData({ saved: false });
      }, 5000);
      await this.load();
    } catch (error) {
      if (api.needsConsent(error)) return;
      if (this.active(epoch, account))
        this.setData({ error: errorText(error) });
    } finally {
      if (this.active(epoch, account)) this.setData({ saving: false });
    }
  },
  chat(e) {
    if (this.data.guest) return gate.ask();
    const saved = e && e.currentTarget.dataset.saved,
      card = saved && this.data.savedCard,
      text = card ? card.quote : this.data.text.trim();
    if (!text) {
      this.setData({ error: "写一句再聊" });
      return;
    }
    const intent = {
      text,
      entry: "jot",
      ...(card ? { cards: [card], cardIds: [card.id] } : {}),
      ...(this.data.context
        ? { pointId: this.data.context.pointId || this.data.context.id }
        : {}),
    };
    // The box's words leave once the chat page has them (onShow).
    this.handedOver = card ? null : { intent, raw: this.data.text };
    openChat(intent);
  },
  // 拍照 and 传图/文档 open the 随心记 import with the picker already open.
  openImport(e) {
    if (this.data.guest) return gate.ask();
    const pick = e && e.currentTarget && e.currentTarget.dataset.pick;
    wx.navigateTo({
      url: `/pages/import/source/index${pick ? `?pick=${pick}` : ""}`,
    });
  },
  // 试试这样写: the line goes into the box, nothing is sent; words already
  // there stay and the line goes after them.
  starter(e) {
    const line = e.currentTarget.dataset.text,
      now = this.data.text;
    const text = now.trim() ? `${now.replace(/\s+$/, "")}\n${line}` : line;
    if (!this.data.guest) keepDraft(owner(), text, "");
    this.draftId = "";
    this.setData({
      text,
      composeFocus: true,
      error: "",
    });
  },
  closeHello() {
    try {
      wx.setStorageSync(HELLO_KEY, "1");
    } catch (e) {}
    this.setData({ helloClosed: true });
  },
  helloError() {
    this.setData({ helloFail: true });
  },
  focusCompose() {
    this.setData({ composeFocus: true });
    wx.pageScrollTo && wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },
  composeBlur() {
    if (this.data.composeFocus) this.setData({ composeFocus: false });
  },
  resumeChanged() {
    return this.load();
  },
  // resume-card says whether it shows something due (it then takes the top).
  resumeState(e) {
    const shown = Boolean(e.detail && e.detail.shown);
    if (this.data.resumeKnown && this.data.resumeShown === shown) return;
    this.setData({ resumeKnown: true, resumeShown: shown });
  },
  // 稍后 on the tidy card: not again today.
  tidyLater() {
    try {
      wx.setStorageSync(TIDY_LATER_KEY, today());
    } catch (_) {}
    this.setData({ tidy: null });
  },
  onTileTap(e) {
    const card = e.detail.card;
    wx.navigateTo({
      url: `/pages/card/index?${card.id.startsWith("example-") ? "example" : "id"}=${encodeURIComponent(card.id)}`,
    });
  },
  // 全部: the whole list is on the 卡片 tab.
  openDeck() {
    wx.switchTab({ url: DECK });
  },
  clearContext() {
    this.setData({ context: null });
  },
}));
