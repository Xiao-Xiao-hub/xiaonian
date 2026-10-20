/*
 * 卡片选择页：供对话或其他功能选择本人卡片，完成后把选择结果交回调用流程。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const gate = require("../../utils/gate");
const auth = require("../../utils/auth");
const { view, sceneParam, TYPES } = require("../../utils/cards");

const owner = () => (auth.getUser() || {}).id || "";
const cap = (mode) => (mode === "brainstorm" ? 50 : mode === "link" ? 1 : 3);
// the seven kinds, sent as kind=.
const TYPE_CHOICES = Object.keys(TYPES).map((id) => [id, TYPES[id].name]);
const SCENE_CHOICES = [
  ["study", "学习"],
  ["life", "生活"],
  ["mood", "心情"],
];
const choices = (items, selected) =>
  items.map(([id, name]) => ({ id, name, selected: selected.includes(id) }));
const TITLES = {
  chat: "挑几张带去聊",
  link: "连上哪张卡",
  brainstorm: "挑卡来头脑风暴",
};
const HINTS = {
  chat: "最多挑 3 张，带去一起聊",
  link: "挑一张，和这张卡连上",
  brainstorm: "挑 3 到 50 张，一起头脑风暴",
};
const doneText = (mode, count) =>
  mode === "link"
    ? "连上这张"
    : mode === "brainstorm"
      ? `用这 ${count} 张头脑风暴`
      : count
        ? `带这 ${count} 张去聊`
        : "不带卡了";

Page({
    data: {
      loading: false,
      selectingAll: false,
      error: "",
      tagError: "",
      cards: [],
      tags: [],
      selected: [],
      query: "",
      types: choices(TYPE_CHOICES, []),
      scenes: choices(SCENE_CHOICES, []),
      tagChoices: [],
      total: 0,
      cursor: "",
      mode: "chat",
      limit: 3,
      hint: HINTS.chat,
      doneText: doneText("chat", 0),
      filterOpen: false,
      filterCount: 0,
    },
    onLoad() {
      const pick = getApp().globalData.cardPick || {},
        limit = cap(pick.mode || "chat");
      this.pick = pick;
      this.selectedCards = new Map();
      (pick.cards || [])
        .slice(0, limit)
        .forEach((card) => this.selectedCards.set(card.id, view(card)));
      (pick.selected || []).slice(0, limit).forEach((id) => {
        if (!this.selectedCards.has(id) && this.selectedCards.size < limit)
          this.selectedCards.set(id, view({ id }));
      });
      const mode = TITLES[pick.mode] ? pick.mode : "chat";
      wx.setNavigationBarTitle({ title: TITLES[mode] });
      this.setData({ mode, limit, hint: HINTS[mode] });
      this.syncSelected();
    },
    onShow() {
      if (!gate.check()) return;
      // A guest has nothing here: offer the welcome page, send nothing.
      if (gate.state() !== "ok") return gate.ask({ leave: true });
      this.alive = true;
      this.epoch = (this.epoch || 0) + 1;
      const current = owner();
      if (this.account && current !== this.account) this.clearOwner();
      if (current) this.account = current;
      // 全选 cut short by leaving: its button works again.
      if (this.data.selectingAll) this.setData({ selectingAll: false });
      this.load(true);
      this.loadTags();
    },
    onHide() {
      this.alive = false;
      this.epoch = (this.epoch || 0) + 1;
      this.request = (this.request || 0) + 1;
      this.bulkSeq = (this.bulkSeq || 0) + 1;
    },
    onUnload() {
      this.onHide();
    },
    active(epoch, account) {
      if (!this.alive || epoch !== this.epoch) return false;
      const current = owner();
      if (account && current !== account) return false;
      if (this.account && current && current !== this.account) return false;
      return true;
    },
    bindOwner(account) {
      if (!this.active(this.epoch, account)) return false;
      const current = owner();
      if (!this.account && current) this.account = current;
      return true;
    },
    clearOwner() {
      this.selectedCards = new Map();
      this.setData({
        cards: [],
        selected: [],
        cursor: "",
        total: 0,
        doneText: doneText(this.data.mode, 0),
        error: "换了账号，重新挑一下吧",
      });
    },
    selection() {
      return Array.from(this.selectedCards.values());
    },
    syncSelected() {
      const selected = this.selection().map((card) => card.id),
        picked = new Set(selected);
      this.setData({
        selected,
        doneText: doneText(this.data.mode, selected.length),
        cards: this.data.cards.map((card) => ({
          ...card,
          selected: picked.has(card.id),
        })),
      });
    },
    selectedValues(key) {
      if (key === "type")
        return this.data.types
          .filter((item) => item.selected)
          .map((item) => item.id);
      if (key === "scene")
        return this.data.scenes
          .filter((item) => item.selected)
          .map((item) => item.id);
      return this.data.tagChoices
        .filter((item) => item.selected)
        .map((item) => item.id);
    },
    snapshot() {
      return {
        q: this.data.query.trim(),
        type: this.selectedValues("type"),
        tag: this.selectedValues("tag"),
        scene: this.selectedValues("scene"),
      };
    },
    queryUrl(cursor, snapshot = this.snapshot()) {
      const pairs = [
        ["q", snapshot.q],
        ["kind", snapshot.type.join(",")],
        ["tag", snapshot.tag.join(",")],
        ["scene", sceneParam(owner(), snapshot.scene.join(","))],
        ["cursor", cursor],
      ];
      const suffix = pairs
        .filter(([, value]) => value)
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
        .join("&");
      return `/v1/cards?pick=true${suffix ? `&${suffix}` : ""}`;
    },
    loadTags() {
      const epoch = this.epoch,
        account = this.account || owner();
      return api
        .get("/v1/tags")
        .then((tags) => {
          if (!this.active(epoch, account)) return;
          if (!this.account && owner()) this.account = owner();
          const selected = new Set(this.selectedValues("tag"));
          this.setData({
            tags: tags || [],
            tagError: "",
            tagChoices: (tags || []).map((tag) => ({
              ...tag,
              selected: selected.has(tag.id),
            })),
          });
        })
        .catch((error) => {
          if (this.active(epoch, account) && !api.needsConsent(error))
            this.setData({ tagError: "标签没加载出来，等会儿再试" });
        });
    },
    load(reset) {
      if (!reset && this.data.loading) return Promise.resolve();
      const epoch = this.epoch,
        account = this.account || owner(),
        request = (this.request || 0) + 1;
      this.request = request;
      this.bulkSeq = (this.bulkSeq || 0) + 1;
      const cursor = reset ? "" : this.data.cursor,
        snapshot = this.snapshot();
      this.setData({ loading: true, error: "" });
      return api
        .get(this.queryUrl(cursor, snapshot))
        .then((result) => {
          if (!this.active(epoch, account) || request !== this.request) return;
          if (!this.account && owner()) this.account = owner();
          // 连上: the card itself is not offered.
          const self = this.data.mode === "link" ? this.pick.sourceId : "",
            incoming = (result.data || [])
              .map(view)
              .filter((card) => !self || card.id !== self),
            base = reset ? [] : this.data.cards;
          incoming.forEach((card) => {
            if (this.selectedCards.has(card.id))
              this.selectedCards.set(card.id, card);
          });
          const byId = new Map(base.map((card) => [card.id, card]));
          incoming.forEach((card) => byId.set(card.id, card));
          const cards = Array.from(byId.values()).map((card) => ({
            ...card,
            selected: this.selectedCards.has(card.id),
          }));
          this.setData({
            cards,
            total: result.total || 0,
            cursor: result.cursor || "",
          });
        })
        .catch((error) => {
          if (
            this.active(epoch, account) &&
            request === this.request &&
            !api.needsConsent(error)
          )
            this.setData({ error: error.message || "没打开，再试一次" });
        })
        .finally(() => {
          if (this.active(epoch, account) && request === this.request)
            this.setData({ loading: false });
        });
    },
    search(event) {
      this.setData({ query: event.detail.value });
    },
    submitSearch() {
      return this.load(true);
    },
    toggleFilter() {
      this.setData({ filterOpen: !this.data.filterOpen });
    },
    countFilters() {
      return ["type", "tag", "scene"].reduce(
        (sum, key) => sum + this.selectedValues(key).length,
        0,
      );
    },
    filter(event) {
      const { key, value } = event.currentTarget.dataset;
      const field =
        key === "type" ? "types" : key === "scene" ? "scenes" : "tagChoices";
      this.setData({
        [field]: this.data[field].map((item) =>
          item.id === value ? { ...item, selected: !item.selected } : item,
        ),
      });
      this.setData({ filterCount: this.countFilters() });
      return this.load(true);
    },
    clearFilters() {
      const off = (items) =>
        items.map((item) => ({ ...item, selected: false }));
      this.setData({
        types: off(this.data.types),
        scenes: off(this.data.scenes),
        tagChoices: off(this.data.tagChoices),
        filterCount: 0,
      });
      return this.load(true);
    },
    toggle(event) {
      if (!event.detail || !event.detail.card) return;
      const card = event.detail.card;
      if (this.selectedCards.has(card.id)) this.selectedCards.delete(card.id);
      else {
        if (this.selectedCards.size >= this.data.limit)
          return wx.showToast({
            title:
              this.data.mode === "link"
                ? "只能挑一张，先点掉已选的"
                : `这次最多带 ${this.data.limit} 张`,
            icon: "none",
          });
        this.selectedCards.set(card.id, card);
      }
      this.syncSelected();
    },
    more() {
      if (this.data.cursor && !this.data.loading) return this.load(false);
    },
    clearSelected() {
      this.selectedCards.clear();
      this.syncSelected();
    },
    selectAll() {
      if (this.data.mode !== "brainstorm" || this.data.selectingAll)
        return Promise.resolve();
      if (this.data.total > 50) {
        wx.showToast({ title: "一次最多 50 张，再筛一筛吧", icon: "none" });
        return Promise.resolve();
      }
      const epoch = this.epoch,
        account = this.account || owner(),
        seq = (this.bulkSeq || 0) + 1,
        snapshot = this.snapshot();
      this.bulkSeq = seq;
      this.setData({ selectingAll: true, error: "" });
      const found = new Map();
      const fetch = (cursor = "") =>
        api.get(this.queryUrl(cursor, snapshot)).then((result) => {
          if (!this.active(epoch, account) || seq !== this.bulkSeq) return null;
          (result.data || [])
            .map(view)
            .forEach((card) => found.set(card.id, card));
          return result.cursor ? fetch(result.cursor) : result;
        });
      return fetch()
        .then((result) => {
          if (!result || !this.active(epoch, account) || seq !== this.bulkSeq)
            return;
          const union = new Map(this.selectedCards);
          found.forEach((card, id) => union.set(id, card));
          if (union.size > 50)
            return wx.showToast({
              title: "加上选好的会超过 50 张",
              icon: "none",
            });
          this.selectedCards = union;
          this.syncSelected();
        })
        .catch((error) => {
          if (
            this.active(epoch, account) &&
            seq === this.bulkSeq &&
            !api.needsConsent(error)
          )
            this.setData({ error: error.message || "没打开，再试一次" });
        })
        .finally(() => {
          if (this.active(epoch, account) && seq === this.bulkSeq)
            this.setData({ selectingAll: false });
        });
    },
    done() {
      if (!this.alive || (this.account && owner() !== this.account)) return;
      if (this.data.mode === "brainstorm" && this.selectedCards.size < 3)
        return wx.showToast({
          title: "再挑几张，至少 3 张",
          icon: "none",
        });
      if (this.data.mode === "link" && !this.selectedCards.size) return;
      const views = this.selection(),
        pages = getCurrentPages(),
        previous = pages.length > 1 ? pages[pages.length - 2] : null;
      if (previous && previous.setData)
        previous.setData({ pickedCards: views });
      const app = getApp();
      app.globalData.pickedCards = views;
      app.globalData.cardPick = {
        ...this.pick,
        selected: views.map((item) => item.id),
        cards: views,
      };
      wx.navigateBack();
    },
  });
