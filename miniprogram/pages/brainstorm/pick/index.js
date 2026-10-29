const { withShare } = require("../../../utils/share");
/*
 * 头脑风暴选卡页：从本人卡片中选择输入，查看组合建议并发起整理任务。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../../utils/api");
const gate = require("../../../utils/gate");
const auth = require("../../../utils/auth");
const {
  view,
  showMood,
  sceneParam,
  TYPES: KINDS,
} = require("../../../utils/cards");

const owner = () => (auth.getUser() || {}).id || "";
// V4.2 : the seven kinds, sent as kind= (as on the card picker).
const TYPES = Object.keys(KINDS).map((id) => [id, KINDS[id].name]);
const SCENES = [
  ["study", "学习"],
  ["life", "生活"],
  ["mood", "心情"],
];
const choices = (items) =>
  items.map(([id, name]) => ({ id, name, selected: false }));
const clientId = () =>
  `brainstorm-${Date.now()}-${Math.random().toString(16).slice(2)}`;

Page(withShare({
    data: {
      loading: false,
      selectingAll: false,
      starting: false,
      error: "",
      tagError: "",
      cards: [],
      selected: [],
      tags: [],
      tagChoices: [],
      query: "",
      searchOpen: false,
      filterOpen: false,
      filterCount: 0,
      fixed: false,
      notice: "",
      batchTitle: "",
      types: choices(TYPES),
      scenes: choices(SCENES),
      total: 0,
      cursor: "",
      limited: false,
    },
    onLoad(query = {}) {
      this.selectedCards = new Map();
      this.clientId = query.clientId || clientId();
      // onLoad gets the query as written, so percent-encoded lists are decoded.
      const decode = (value) => {
        try {
          return decodeURIComponent(String(value || ""));
        } catch (error) {
          return String(value || "");
        }
      };
      this.allowedIds = new Set(decode(query.ids).split(",").filter(Boolean));
      // Cards picked in advance (卡片 tab's 头脑风暴 entry): they come
      // picked and first, and the rest of the cards can still be added.
      this.preIds = decode(query.pre)
        .split(",")
        .filter(Boolean)
        .slice(0, 50);
      this.source = query.source || "";
      this.batch = query.batch || "";
      this.sourceId = query.sourceId || "";
      // Cards handed over from an import or a suggestion arrive picked, without filters.
      this.setData({ fixed: Boolean(this.allowedIds.size || this.batch) });
    },
    onShow() {
      if (!gate.check()) return;
      // A guest has nothing here: offer the welcome page, send nothing.
      if (gate.state() !== "ok") return gate.ask({ leave: true });
      this.alive = true;
      this.epoch = (this.epoch || 0) + 1;
      const current = owner();
      if (this.account && current && current !== this.account)
        this.resetOwner();
      if (current) this.account = current;
      // Mood cards follow the 心情卡 setting, as on the deck.
      const mood = showMood(this.account || current);
      if (mood !== this.data.scenes.some((item) => item.id === "mood")) {
        const scenes = mood
          ? SCENES.map(([id, name]) => ({
              id,
              name,
              selected: this.data.scenes.some(
                (item) => item.id === id && item.selected,
              ),
            }))
          : this.data.scenes.filter((item) => item.id !== "mood");
        this.setData({ scenes, filterCount: this.filterCount({ scenes }) });
      }
      if (this.batch && !this.batchLoaded) this.loadBatch();
      else if (this.preIds.length && !this.preLoaded) this.loadPre();
      else this.load(true);
      this.loadTags();
    },
    onHide() {
      this.stop();
    },
    onUnload() {
      this.stop();
    },
    stop() {
      this.alive = false;
      this.epoch = (this.epoch || 0) + 1;
      this.request = (this.request || 0) + 1;
      this.bulkSeq = (this.bulkSeq || 0) + 1;
    },
    active(epoch, account) {
      const current = owner();
      return (
        this.alive &&
        epoch === this.epoch &&
        (!account || current === account) &&
        (!this.account || !current || current === this.account)
      );
    },
    resetOwner() {
      this.selectedCards = new Map();
      // The handed-over cards belonged to the other account.
      this.preIds = [];
      this.preCards = null;
      this.preLoaded = true;
      this.setData({
        cards: [],
        selected: [],
        cursor: "",
        total: 0,
        error: "换了账号，退出这页再进来",
        notice: "",
      });
    },
    loadBatch() {
      const epoch = this.epoch,
        account = this.account || owner();
      this.setData({ loading: true, error: "" });
      const suffix = `kind=${encodeURIComponent(this.batch)}&sourceId=${encodeURIComponent(this.sourceId)}`;
      return api
        .get(`/v1/brainstorms/suggest?${suffix}`)
        .then((result) => {
          if (!this.active(epoch, account)) return;
          const items = result.items || [],
            item =
              items.find(
                (entry) =>
                  entry.kind === this.batch &&
                  (!entry.sourceId ||
                    String(entry.sourceId) === String(this.sourceId)),
              ) || items[0];
          if (!item) {
            this.batch = "";
            this.setData({
              fixed: false,
              notice: "这几张卡找不到了，自己挑几张吧",
            });
            return this.load(true);
          }
          this.allowedIds = new Set((item.cardIds || []).map(String));
          this.batchLoaded = true;
          this.setData({ batchTitle: item.title || "" });
          return this.load(true);
        })
        .catch((error) => {
          if (this.active(epoch, account) && !api.needsConsent(error))
            this.setData({
              loading: false,
              error: error.message || "没打开，再试一次",
            });
        });
    },
    // The cards handed over with `pre`; ones that are gone are skipped.
    loadPre() {
      const epoch = this.epoch,
        account = this.account || owner();
      this.setData({ loading: true, error: "" });
      return Promise.all(
        this.preIds.map((id) =>
          api.get(`/v1/cards/${encodeURIComponent(id)}`).then(
            (card) => (card && card.id && !card.crisis ? view(card) : null),
            () => null,
          ),
        ),
      ).then((found) => {
        if (!this.active(epoch, account)) return;
        this.preLoaded = true;
        // Picked while these loaded: the 50-card limit still holds.
        const cards = found
          .filter(Boolean)
          .filter((card) => !this.selectedCards.has(card.id))
          .slice(0, Math.max(0, 50 - this.selectedCards.size));
        cards.forEach((card) => this.selectedCards.set(card.id, card));
        this.preCards = cards;
        this.setData({
          notice: cards.length ? `推荐的 ${cards.length} 张已选好，还可以再挑` : "",
        });
        return this.load(true);
      });
    },
    selectedValues(field) {
      return this.data[field]
        .filter((item) => item.selected)
        .map((item) => item.id);
    },
    snapshot() {
      return {
        q: this.data.query.trim(),
        type: this.selectedValues("types"),
        tag: this.selectedValues("tagChoices"),
        scene: this.selectedValues("scenes"),
      };
    },
    queryUrl(cursor = "", snapshot = this.snapshot()) {
      const pairs = [
        ["q", snapshot.q],
        ["kind", snapshot.type.join(",")],
        ["tag", snapshot.tag.join(",")],
        // Handed-over cards come as they are; otherwise hidden mood cards stay out.
        [
          "scene",
          this.allowedIds.size || this.batch
            ? snapshot.scene.join(",")
            : sceneParam(this.account || owner(), snapshot.scene.join(",")),
        ],
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
          const selected = new Set(this.selectedValues("tagChoices"));
          const tagChoices = (tags || []).map((tag) => ({
            ...tag,
            selected: selected.has(tag.id),
          }));
          this.setData({
            tags: tags || [],
            tagChoices,
            tagError: "",
          });
        })
        .catch((error) => {
          if (this.active(epoch, account) && !api.needsConsent(error))
            this.setData({ tagError: "标签没打开，等下再试" });
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
      const read = (next, found = new Map()) =>
        api.get(this.queryUrl(next, snapshot)).then((result) => {
          (result.data || [])
            .map(view)
            .filter((card) => this.allowedIds.has(String(card.id)))
            .forEach((card) => found.set(card.id, card));
          return result.cursor && found.size < this.allowedIds.size
            ? read(result.cursor, found)
            : {
                ...result,
                data: Array.from(found.values()),
                total: found.size,
                cursor: "",
              };
        });
      const requestPromise = this.allowedIds.size
        ? read(cursor)
        : api.get(this.queryUrl(cursor, snapshot));
      return requestPromise
        .then((result) => {
          if (!this.active(epoch, account) || request !== this.request) return;
          if (!this.account && owner()) this.account = owner();
          const incoming = (result.data || [])
            .map(view)
            .filter(
              (card) =>
                !this.allowedIds.size || this.allowedIds.has(String(card.id)),
            );
          // The handed-over cards stay first while no filter or search is on.
          // Only on the first list: later ones show what the server has, so
          // a card deleted meanwhile does not come back.
          const pre =
            reset && this.preCards && !this.filterCount() && !snapshot.q
              ? this.preCards
              : [];
          this.preCards = null;
          const base = reset ? pre : this.data.cards,
            byId = new Map(base.map((card) => [card.id, card]));
          incoming.forEach((card) => {
            byId.set(card.id, card);
            if (this.selectedCards.has(card.id))
              this.selectedCards.set(card.id, card);
          });
          if (this.data.fixed && !this.preselected) {
            this.preselected = true;
            Array.from(byId.values())
              .slice(0, 50)
              .forEach((card) => this.selectedCards.set(card.id, card));
          }
          const cards = Array.from(byId.values()).map((card) => ({
            ...card,
            selected: this.selectedCards.has(card.id),
          }));
          const total = this.allowedIds.size ? cards.length : result.total || 0;
          this.setData({
            cards,
            selected: Array.from(this.selectedCards.keys()),
            total,
            cursor: this.allowedIds.size ? "" : result.cursor || "",
            limited: this.allowedIds.size > 0,
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
    toggleSearch() {
      this.setData({ searchOpen: !this.data.searchOpen, filterOpen: false });
    },
    toggleFilter() {
      this.setData({ filterOpen: !this.data.filterOpen, searchOpen: false });
    },
    filterCount(patch = {}) {
      const data = { ...this.data, ...patch };
      return ["types", "tagChoices", "scenes"].reduce(
        (sum, field) => sum + data[field].filter((item) => item.selected).length,
        0,
      );
    },
    clearFilters() {
      const off = (items) => items.map((item) => ({ ...item, selected: false }));
      this.setData({
        types: off(this.data.types),
        tagChoices: off(this.data.tagChoices),
        scenes: off(this.data.scenes),
        filterCount: 0,
      });
      return this.load(true);
    },
    filter(event) {
      const { key, value } = event.currentTarget.dataset;
      const field =
        key === "type" ? "types" : key === "scene" ? "scenes" : "tagChoices";
      const next = this.data[field].map((item) =>
        item.id === value ? { ...item, selected: !item.selected } : item,
      );
      this.setData({
        [field]: next,
        filterCount: this.filterCount({ [field]: next }),
      });
      return this.load(true);
    },
    syncSelected() {
      const selected = Array.from(this.selectedCards.keys()),
        picked = new Set(selected);
      this.setData({
        selected,
        cards: this.data.cards.map((card) => ({
          ...card,
          selected: picked.has(card.id),
        })),
      });
    },
    toggle(event) {
      const card = event.detail.card;
      if (this.selectedCards.has(card.id)) this.selectedCards.delete(card.id);
      else if (this.selectedCards.size >= 50)
        return wx.showToast({ title: "一次最多 50 张", icon: "none" });
      else this.selectedCards.set(card.id, card);
      this.syncSelected();
    },
    clearSelected() {
      this.selectedCards.clear();
      this.syncSelected();
    },
    more() {
      if (this.data.cursor && !this.data.loading) return this.load(false);
    },
    selectAll() {
      if (this.data.selectingAll) return Promise.resolve();
      if (this.data.total > 50) {
        wx.showToast({ title: "一次最多 50 张，再筛一筛吧", icon: "none" });
        return Promise.resolve();
      }
      const epoch = this.epoch,
        account = this.account || owner(),
        seq = (this.bulkSeq || 0) + 1,
        snapshot = this.snapshot(),
        found = new Map();
      this.bulkSeq = seq;
      this.setData({ selectingAll: true, error: "" });
      if (this.allowedIds.size)
        this.data.cards.forEach((card) => found.set(card.id, card));
      const fetch = (cursor = "") =>
        api.get(this.queryUrl(cursor, snapshot)).then((result) => {
          if (!this.active(epoch, account) || seq !== this.bulkSeq) return null;
          (result.data || [])
            .map(view)
            .filter(
              (card) =>
                !this.allowedIds.size || this.allowedIds.has(String(card.id)),
            )
            .forEach((card) => found.set(card.id, card));
          return !this.allowedIds.size && result.cursor
            ? fetch(result.cursor)
            : result;
        });
      const request = this.allowedIds.size ? Promise.resolve({}) : fetch();
      return request
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
    start() {
      const ids = Array.from(this.selectedCards.keys());
      if (ids.length < 3)
        return wx.showToast({
          title: `再挑 ${3 - ids.length} 张`,
          icon: "none",
        });
      if (ids.length > 50 || this.data.starting) return;
      const epoch = this.epoch,
        account = this.account || owner();
      this.setData({ starting: true, error: "" });
      return api
        .post("/v1/brainstorms", { clientId: this.clientId, cardIds: ids })
        .then((result) => {
          if (!this.active(epoch, account)) return;
          const item = result.brainstorm || result;
          wx.redirectTo({
            url: `/pages/brainstorm/process/index?id=${encodeURIComponent(item.id)}`,
          });
        })
        .catch((error) => {
          if (!this.active(epoch, account)) return;
          if (error.code === "MOOD_CONSENT_REQUIRED")
            return wx.navigateTo({
              url: `/pages/mood-consent/index?next=${encodeURIComponent("/pages/brainstorm/pick/index")}`,
            });
          if (!api.needsConsent(error))
            this.setData({
              error: error.message || "没开始成，选好的卡还在，再试一次",
            });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ starting: false });
        });
    },
  }));
