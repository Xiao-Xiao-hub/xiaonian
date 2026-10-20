/*
 * 收卡页：确认需要保存的文字、类型与来源，再调用卡片接口写入。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const gate = require("../../utils/gate");
const auth = require("../../utils/auth");
const { TYPES, REMIND_EVERY } = require("../../utils/cards");

const typeStyle = (id) => {
  const type = TYPES[id] || TYPES.idea;
  return `--type-main:${type.main};--type-ink:${type.ink};--type-wash:${type.wash}`;
};
const TYPE_LIST = Object.keys(TYPES).map((id) => ({
  id,
  name: TYPES[id].name,
  style: typeStyle(id),
}));
const typeName = (id) => (TYPES[id] ? TYPES[id].name : "AI 帮你挑");
// 按内容 lets the card's kind decide (a 随手记 asks nothing); 不提醒
// turns the follow-ups off; 每天 / 每周 repeat. Sent with the save itself, so
// the card and its reminder are stored together or not at all.
const REMINDS = [
  { id: "", name: "按内容" },
  { id: "none", name: "不提醒" },
  { id: "day", name: REMIND_EVERY.day },
  { id: "week", name: REMIND_EVERY.week },
];
const remindBody = (id) =>
  id === "none"
    ? { follow: "none" }
    : id === "day" || id === "week"
      ? { remindEvery: id }
      : {};

Page({
    data: {
      consent: false,
      mode: "message",
      threadId: "",
      messageId: "",
      cardId: "",
      scene: "life",
      origin: "",
      types: TYPE_LIST,
      type: "",
      typeName: typeName(""),
      typeOpen: false,
      title: "",
      titleOpen: false,
      mine: "",
      mineOpen: false,
      quote: "",
      quotes: [],
      pointId: "",
      pointName: "",
      pointOff: false,
      mistakeId: "",
      wrap: null,
      cards: [],
      selectedCount: 0,
      nextIf: "",
      nextThen: "",
      nextOpen: false,
      // v4 : the AI's title and one-line summary show as they are; the
      // handwriting boxes wait behind 改一改.
      editOpen: false,
      reminds: REMINDS,
      remindEvery: "",
      saving: false,
      error: "",
    },
    onLoad() {
      this.alive = true;
      this.owner = (auth.getUser() || {}).id;
      this.setData({ consent: auth.hasConsent() });
      const intent = getApp().globalData.collect || {};
      getApp().globalData.collect = null;
      this.intent = intent;
      if (intent.mode === "wrap") {
        const draft = intent.draft || {};
        const cards = (draft.cards || []).map((card, index) => ({
          ...card,
          // V4.2 : a drafted card names its kind (待办, 知识点…) when it has one.
          typeName: typeName(card.kind || card.type),
          typeStyle: typeStyle(card.kind || card.type),
          selected: card.selected !== undefined ? card.selected : index === 0,
        }));
        this.setData({
          mode: "wrap",
          threadId: intent.threadId || "",
          wrap: draft,
          cards,
          selectedCount: cards.filter((card) => card.selected).length,
          quotes: intent.quotes || [],
          mine: intent.mine || "",
          nextIf: (draft.next && draft.next.if) || "",
          nextThen: (draft.next && draft.next.then) || "",
        });
      } else if (intent.mode === "mine") {
        this.setData({
          mode: "mine",
          cardId: intent.cardId || "",
          mine: intent.quote || "",
          quotes: intent.quotes || [],
        });
      } else {
        this.setData({
          ...intent,
          mode: "message",
          type: TYPES[intent.type] ? intent.type : "",
          typeName: typeName(intent.type),
          quotes: intent.quotes || [],
          pointName: intent.pointName || "",
          origin: intent.origin || "",
        });
        if (intent.pointId && !intent.pointName) this.loadPointName();
      }
    },
    onShow() {
      if (!gate.check()) return;
      this.alive = true;
      // Consent is given on another tab; pick it up when coming back.
      if (this.data.consent !== auth.hasConsent())
        this.setData({ consent: auth.hasConsent(), error: "" });
    },
    onHide() {
      this.alive = false;
    },
    // Leaving by the system back keeps the wrap draft too.
    onUnload() {
      if (!this.left) this.keepWrap();
      this.alive = false;
    },
    active() {
      return (
        this.alive &&
        this.owner === (auth.getUser() || {}).id &&
        auth.hasConsent()
      );
    },
    loadPointName() {
      const id = this.data.pointId;
      Promise.resolve()
        .then(() => api.get("/v1/learn/map"))
        .then((map) => {
          const point = ((map && map.chapters) || [])
            .flatMap((chapter) => chapter.points || [])
            .find((item) => item.id === id);
          if (point && this.alive && this.data.pointId === id)
            this.setData({ pointName: point.name });
        })
        .catch(() => {});
    },
    input(e) {
      this.setData({ [e.currentTarget.dataset.key]: e.detail.value });
    },
    toggle(e) {
      const key = e.currentTarget.dataset.key;
      this.setData({ [key]: !this.data[key] });
    },
    chooseType(e) {
      const type = e.currentTarget.dataset.type;
      this.setData({ type, typeName: typeName(type), typeOpen: false });
    },
    pickRemind(e) {
      this.setData({ remindEvery: e.currentTarget.dataset.value || "" });
    },
    chooseQuote(e) {
      this.setData({ mine: e.currentTarget.dataset.quote });
    },
    // A line picked from the chat goes as a quote (checked against what was
    // said); anything typed or changed is the learner's own new words.
    mineBody() {
      const mine = this.data.mine.trim();
      return (this.data.quotes || []).includes(mine)
        ? { quote: mine }
        : { text: mine };
    },
    toggleCard(e) {
      const index = Number(e.currentTarget.dataset.index),
        cards = this.data.cards.slice();
      cards[index] = { ...cards[index], selected: !cards[index].selected };
      this.setData({
        cards,
        selectedCount: cards.filter((card) => card.selected).length,
      });
    },
    cardInput(e) {
      const { index, key } = e.currentTarget.dataset,
        cards = this.data.cards.slice();
      cards[index] = { ...cards[index], [key]: e.detail.value };
      this.setData({ cards });
    },
    goConsent() {
      gate.ask();
    },
    save() {
      if (this.data.saving) return;
      if (!this.data.consent || !auth.hasConsent()) {
        this.setData({
          consent: false,
          error: "同意隐私政策后就能存",
        });
        return;
      }
      if (!this.active()) return;
      this.setData({ saving: true, error: "" });
      let request;
      if (this.data.mode === "wrap") {
        const picks = this.data.cards
          .filter((card) => card.selected)
          .map((card) => card.key);
        if (!picks.length) {
          this.setData({ saving: false, error: "挑一张再存吧" });
          return;
        }
        request = api.post(
          `/v1/chat/threads/${encodeURIComponent(this.data.threadId)}/wrap`,
          {
            action: "save",
            draftId: this.data.wrap.id,
            picks,
            mine: this.data.mine || undefined,
            edits: this.data.cards
              .filter((card) => card.selected)
              .map((card) => ({ key: card.key, title: card.title || "" })),
            next:
              this.data.nextIf || this.data.nextThen
                ? { if: this.data.nextIf, then: this.data.nextThen }
                : null,
            ...remindBody(this.data.remindEvery),
          },
        );
      } else if (this.data.mode === "mine") {
        request = api
          .get(`/v1/cards/${encodeURIComponent(this.data.cardId)}`)
          .then((card) =>
            this.active()
              ? api.post(
                  `/v1/cards/${encodeURIComponent(this.data.cardId)}/mine`,
                  { version: card.version, ...this.mineBody() },
                )
              : undefined,
          );
      } else {
        const fromMap = this.intent.origin === "map";
        // Without a picked kind the server chooses from the quote; for an AI
        // reply it takes the student's own question as the quote first.
        // the seven kinds go as kind (待办 / 知识点 / 随手记 have no type).
        const kind = this.data.type || undefined;
        request = api.post("/v1/cards", {
          origin: fromMap ? "map" : "chat",
          scene: fromMap ? "study" : undefined,
          srcId: fromMap ? undefined : this.data.threadId,
          messageId: fromMap ? undefined : this.data.messageId,
          kind,
          title: this.data.title || undefined,
          mine: this.data.mine || undefined,
          pointId:
            (!this.data.pointOff || fromMap ? this.data.pointId : "") ||
            undefined,
          mistakeId: this.data.mistakeId || undefined,
          quote: this.data.quote || undefined,
          ...remindBody(this.data.remindEvery),
        });
      }
      return request
        .then((result) => {
          if (!this.active() || !result) return;
          if (result.crisis) {
            wx.navigateTo({ url: "/pages/crisis/index" });
            return;
          }
          this.left = true;
          // From a chat, say where the card went.
          if (this.intent.threadId)
            wx.showToast({ title: "存好了，在卡片里", icon: "none" });
          else wx.showToast({ title: "存好了", icon: "success" });
          wx.navigateBack();
        })
        .catch((error) => {
          if (this.active() && !api.needsConsent(error))
            this.setData({ error: error.message || "没存上，再点一次" });
        })
        .finally(() => {
          if (this.active()) this.setData({ saving: false });
        });
    },
    // 关闭 only leaves; the wrap draft goes back so it can be opened again.
    close() {
      this.keepWrap();
      this.left = true;
      wx.navigateBack();
    },
    keepWrap() {
      if (this.data.mode === "wrap" && this.data.wrap)
        getApp().globalData.collect = {
          mode: "wrap",
          threadId: this.data.threadId,
          count: this.intent.count,
          draft: {
            ...this.data.wrap,
            cards: this.data.cards.map((card) => {
              const { typeName: _name, typeStyle: _style, ...rest } = card;
              return rest;
            }),
            next:
              this.data.nextIf || this.data.nextThen
                ? { if: this.data.nextIf, then: this.data.nextThen }
                : null,
          },
          quotes: this.data.quotes,
          mine: this.data.mine,
        };
    },
    // 都不要: the only way to drop the wrap draft.
    dismiss() {
      const done = () => {
        if (this.active()) wx.navigateBack();
      };
      this.left = true;
      if (this.data.mode !== "wrap") return done();
      api
        .post(
          `/v1/chat/threads/${encodeURIComponent(this.data.threadId)}/wrap`,
          { action: "dismiss" },
        )
        .then(done)
        .catch(done);
    },
    noop() {},
  });
