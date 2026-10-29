const { withShare } = require("../../utils/share");
/*
 * 卡片列表：提供搜索、筛选、收藏、多选、合并和头脑风暴入口；列表数据来自 cards 接口。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
// 卡片 tab : the 头脑风暴 entry, 回顾, search, the type row with
// counts, the two-column card wall, the filter panel and 多选 (合并、删除、
// 头脑风暴), moved here from 随心记.
const api = require("../../utils/api"),
  auth = require("../../utils/auth"),
  gate = require("../../utils/gate");
const { asset } = require("../../utils/assets");
const { view, TYPES, doneLast, sceneParam } = require("../../utils/cards");
const { cards: examples } = require("../../utils/examples");
const { errorText } = require("../../utils/format");
const { once } = require("../../utils/tap");
const owner = () => (auth.getUser() || {}).id || "";
const today = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const mergeClientId = () =>
  `merge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const initialTypes = () =>
  Object.keys(TYPES).map((id) => ({
    id,
    name: TYPES[id].name,
    selected: false,
  }));
const initialScenes = () => [
  { id: "study", name: "学习", selected: false },
  { id: "life", name: "生活", selected: false },
  { id: "mood", name: "心情", selected: false },
];
// The kind row: 全部 / 收藏 / one kind / 已完成, each with its count.
const TABS = [
  { id: "all", name: "全部" },
  { id: "favorite", name: "收藏" },
  ...Object.keys(TYPES).map((id) => ({ id, name: TYPES[id].name })),
  { id: "closed", name: "已完成" },
];
const FIXED = ["all", "favorite", "closed"];
// Counts from /v1/cards/stats (byKind from V4.2 servers, byType from v4).
// only kinds that have cards get a chip, plus the one being looked at.
function tabsWith(stats, current = "all") {
  if (!stats)
    return TABS.filter((t) => FIXED.includes(t.id) || t.id === current).map(
      (t) => ({ ...t, n: "" }),
    );
  const byKind = stats.byKind || stats.byType || {};
  return TABS.map((t) => {
    const n =
      t.id === "all"
        ? stats.total
        : t.id === "favorite"
          ? stats.favorites
          : t.id === "closed"
            ? stats.closed
            : byKind[t.id];
    return { ...t, n: typeof n === "number" ? n : "" };
  }).filter((t) => FIXED.includes(t.id) || t.n > 0 || t.id === current);
}
// 回顾: what is due today (the same as “该问你了” in the 回顾 list).
function dueToday(items) {
  const day = today(),
    now = Date.now();
  return (items || []).filter(
    (item) =>
      item.state !== "dormant" &&
      (!item.dueOn || item.dueOn <= day) &&
      (!item.remindAt || Date.parse(item.remindAt) <= now),
  ).length;
}
// Card ids with a 回顾 due today (the same rule as dueToday).
function dueIds(items) {
  const day = today(),
    now = Date.now();
  return (items || [])
    .filter(
      (item) =>
        item.src === "card" &&
        item.state !== "dormant" &&
        (!item.dueOn || item.dueOn <= day) &&
        (!item.remindAt || Date.parse(item.remindAt) <= now),
    )
    .map((item) => String(item.srcId));
}
// Two columns, filled left, right, left… (v4 样张 10-notes.wall)
const columns = (list) => [
  list.filter((_, i) => i % 2 === 0),
  list.filter((_, i) => i % 2 === 1),
];
// 头脑风暴 needs at least this many cards.
const BRAINSTORM_MIN = 3;
// The entry's preview: the 3 cards it starts with.
const brainstormView = (cards, extra = {}) => ({
  ready: true,
  cards: cards.slice(0, BRAINSTORM_MIN),
  need: Math.max(0, BRAINSTORM_MIN - cards.length),
  why: "",
  example: false,
  failed: false,
  ...extra,
});
// Shows or hides the native tab bar; fails quietly where the API is missing.
// wx.hideTabBar hides it for the whole mini program, so every way out of 多选
// and off this page shows it again.
function tabBar(show) {
  const call = show ? wx.showTabBar : wx.hideTabBar;
  if (typeof call === "function") call({ animation: false, fail() {} });
}
const ORDERS = [
  { id: "updated", name: "最近动过" },
  { id: "created", name: "最早" },
  { id: "used", name: "用得最多" },
];
// Every list filter, reset together so "×" really shows all cards again.
const noFilters = () => ({
  types: initialTypes(),
  scenes: initialScenes(),
  closed: "",
  retest: "",
  favorite: "",
  order: "updated",
  query: "",
  pointFilter: "",
  pointFilterName: "",
});
Page(withShare({
  data: {
    ready: false,
    guest: false,
    consent: false,
    tabs: tabsWith(null),
    tab: "all",
    stats: null,
    cards: [],
    cols: [[], []],
    examples: examples.map(view),
    exampleCols: columns(examples.map(view)),
    // 头脑风暴 entry: xiaoli, the 3 cards it would start with, or how many
    // more cards it needs. Guests see the examples.
    bs: { ready: false, cards: [], need: 0, why: "", example: false },
    bsImg: "",
    rvImg: "",
    examplesOpen: false,
    tagChoices: [],
    cursor: "",
    total: 0,
    allTotal: 0,
    dueCount: 0,
    loading: false,
    error: "",
    query: "",
    closed: "",
    pointFilter: "",
    pointFilterName: "",
    retest: "",
    favorite: "",
    order: "updated",
    selecting: false,
    selected: [],
    merging: false,
    saving: false,
    types: initialTypes(),
    scenes: initialScenes(),
    orders: ORDERS,
    filterText: "",
    panelOpen: false,
  },
  onLoad() {
    this.selectedCards = new Map();
    this.dueSet = new Set();
    this.setData({
      ready: gate.state() !== "none",
      bsImg: asset("xiaoli-brainstorm.webp"),
      rvImg: asset("ic-spiral-calendar.webp"),
    });
  },
  async onShow() {
    if (!gate.check()) return;
    const guest = gate.state() === "guest";
    this.setData({ ready: true, guest });
    this.alive = true;
    this.epoch = (this.epoch || 0) + 1;
    const account = owner();
    if (this.account && this.account !== account) {
      this.selectedCards = new Map();
      this.pendingMerge = null;
      tabBar(true);
      this.setData({
        cards: [],
        selected: [],
        selecting: false,
        ...noFilters(),
        tagChoices: [],
        filterText: "",
        panelOpen: false,
        allTotal: 0,
        dueCount: 0,
        stats: null,
        tabs: tabsWith(null),
        cols: [[], []],
        bs: { ready: false, cards: [], need: 0, why: "", example: false },
      });
      this.dueSet = new Set();
    }
    // Still picking from before: the pick bar takes the tab bar's place again.
    if (this.data.selecting) tabBar(false);
    // A merge started before leaving is still running: say so.
    const merging = Boolean(
      this.pendingMerge && this.pendingMerge.account === account,
    );
    this.setData({
      consent: auth.hasConsent(),
      loading: false,
      saving: false,
      merging,
      error: "",
    });
    if (!this.data.consent) {
      if (this.data.selecting) this.cancelSelect();
      this.setData({
        cards: [],
        cols: [[], []],
        allTotal: 0,
        dueCount: 0,
        bs: brainstormView(examples.map(view), { example: true }),
        ...(guest ? { examplesOpen: true } : {}),
      });
      return;
    }
    const app = getApp().globalData;
    if (app.cardFilter) {
      // An incoming filter replaces the old one; it shows in "正在看" below.
      const { scene, type, closed, pointId, pointName, favorite, tag, tagName } =
        app.cardFilter;
      const tagChoices = this.data.tagChoices.map((t) => ({
        ...t,
        selected: Boolean(tag) && t.id === tag,
      }));
      // From the tags page before this page has loaded its tags.
      if (tag && !tagChoices.some((t) => t.id === tag))
        tagChoices.push({ id: tag, name: tagName || "这个标签", selected: true });
      this.setData({
        ...noFilters(),
        tagChoices,
        favorite: favorite ? "true" : "",
        types: initialTypes().map((t) => ({ ...t, selected: t.id === type })),
        scenes: initialScenes().map((s) => ({
          ...s,
          selected: s.id === scene,
        })),
        closed: closed ? "true" : "",
        pointFilter: pointId || "",
        pointFilterName: pointId ? pointName || "这个知识点" : "",
      });
      app.cardFilter = null;
    }
    const epoch = this.epoch;
    await this.load(true, true);
    if (!this.active(epoch, account)) return;
    await this.pruneSelection(epoch, account);
    if (this.pendingMerge && this.pendingMerge.account === account)
      this.finishMerge(epoch, account)
        .catch((error) => {
          if (this.active(epoch, account))
            this.setData({ error: errorText(error) });
        })
        .finally(() => {
          if (this.active(epoch, account)) this.setData({ merging: false });
        });
  },
  onHide() {
    this.alive = false;
    this.epoch = (this.epoch || 0) + 1;
    // 多选 stays; the tab bar comes back for the other pages.
    tabBar(true);
  },
  onUnload() {
    this.onHide();
    clearTimeout(this.searchTimer);
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
    return this.load(true, true).then(stop, stop);
  },
  // Picked cards that are gone (merged or deleted while away) are dropped;
  // with none left, 多选 ends. a card only on a later page is not gone,
  // so the server is asked about the ones not shown.
  async pruneSelection(epoch = this.epoch, account = owner()) {
    if (!this.data.selecting) return;
    const shown = new Set(this.data.cards.map((c) => c.id)),
      unseen = [...this.selectedCards.keys()].filter((id) => !shown.has(id));
    const gone = await Promise.all(
      unseen.map((id) =>
        api.get(`/v1/cards/${encodeURIComponent(id)}`).then(
          () => false,
          (error) => error.code === "NOT_FOUND" || error.status === 404,
        ),
      ),
    );
    if (!this.active(epoch, account) || !this.data.selecting) return;
    unseen.forEach((id, i) => gone[i] && this.selectedCards.delete(id));
    if (!this.selectedCards.size) return this.cancelSelect();
    this.setData({ selected: [...this.selectedCards.keys()] });
    this.setCards(this.data.cards);
  },
  clearFilters() {
    this.setData({
      ...noFilters(),
      tagChoices: this.data.tagChoices.map((t) => ({
        ...t,
        selected: false,
      })),
    });
    return this.load(true);
  },
  describe() {
    const names = (list) => list.filter((i) => i.selected).map((i) => i.name);
    const query = this.data.query.trim(),
      types = this.data.types.filter((t) => t.selected),
      flags = [this.data.closed, this.data.favorite].filter(Boolean).length;
    // One tab shows one of these at a time; anything the tabs cannot show
    // (two types, or a type with 收藏) is named in “正在看”.
    const single = types.length + flags === 1;
    const tab = !types.length && !flags
      ? "all"
      : !single
        ? ""
        : this.data.closed
          ? "closed"
          : this.data.favorite
            ? "favorite"
            : types[0].id;
    this.setData({
      tab,
      tabs: tabsWith(this.data.stats, tab),
      filterText: [
        ...(single ? [] : names(this.data.types)),
        ...names(this.data.tagChoices),
        ...names(this.data.scenes),
        !single && this.data.closed ? "已完成" : "",
        this.data.retest ? "待再试" : "",
        !single && this.data.favorite ? "收藏" : "",
        this.data.pointFilter ? this.data.pointFilterName : "",
        query ? `“${query}”` : "",
        this.data.order === "updated"
          ? ""
          : (ORDERS.find((o) => o.id === this.data.order) || {}).name,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  },
  values(key) {
    return this.data[
      key === "type" ? "types" : key === "scene" ? "scenes" : "tagChoices"
    ]
      .filter((i) => i.selected)
      .map((i) => i.id)
      .join(",");
  },
  url(cursor = "") {
    return `/v1/cards?${[
      ["q", this.data.query],
      ["point", this.data.pointFilter],
      // the row's chips are kinds (seven), not the four types.
      ["kind", this.values("type")],
      ["tag", this.values("tag")],
      ["scene", sceneParam(owner(), this.values("scene"))],
      ["closed", this.data.closed],
      ["retest", this.data.retest],
      ["favorite", this.data.favorite ? "1" : ""],
      ["order", this.data.order],
      ["cursor", cursor],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&")}`;
  },
  setCards(cards, append = false) {
    const selected = new Set(this.data.selected),
      due = this.dueSet || new Set(),
      // 已完成 cards go last.
      combined = doneLast(
        (append ? this.data.cards : []).concat(cards.map(view)),
      ).map((c) => ({
        ...c,
        selected: selected.has(c.id),
        // 到期待回顾: 回顾 asks about it today (snoozed or switched-off
        // reminders are not due, whatever the card's remindOn says).
        // only cards that are reviewed; 待办 and 接着聊 are not 待回顾.
        due:
          !c.done &&
          (!c.follow || c.follow === "review") &&
          due.has(String(c.id)),
      }));
    this.setData({ cards: combined, cols: columns(combined) });
  },
  async load(reset = false, metadata = false) {
    if (!reset && this.data.loading) return;
    const epoch = this.epoch,
      request = (this.request = (this.request || 0) + 1);
    let account = owner();
    this.describe();
    this.setData({ loading: true, error: "" });
    try {
      await auth.login();
      if (!this.alive || epoch !== this.epoch || request !== this.request)
        return;
      account = owner();
      this.account = account;
      // The 头脑风暴 entry has its own guard, so a filter tapped meanwhile
      // does not leave it waiting.
      if (metadata) this.loadBrainstorm(epoch, account);
      const result = await api.get(this.url(reset ? "" : this.data.cursor));
      if (!this.active(epoch, account) || request !== this.request) return;
      this.setCards(result.data || [], !reset);
      this.setData({ total: result.total, cursor: result.cursor || "" });
      if (metadata) {
        const [tags, stats] = await Promise.all([
          api.get("/v1/tags"),
          api.get(
            `/v1/cards/stats${sceneParam(account) ? `?scene=${sceneParam(account)}` : ""}`,
          ),
        ]);
        if (!this.active(epoch, account) || request !== this.request) return;
        const selected = new Set(this.values("tag").split(","));
        this.setData({
          tagChoices: tags.map((t) => ({
            ...t,
            selected: selected.has(t.id),
          })),
          allTotal: stats.total,
          stats,
          tabs: tabsWith(stats, this.data.tab),
        });
        this.describe();
        this.loadDue(epoch, account);
      }
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
  // 回顾's count; the list itself still works when this fails.
  async loadDue(epoch, account) {
    try {
      const items = await api.get("/v1/resume?state=waiting");
      if (!this.active(epoch, account)) return;
      this.dueSet = new Set(dueIds(items));
      this.setData({ dueCount: dueToday(items) });
      this.setCards(this.data.cards);
    } catch (error) {}
  },
  // 头脑风暴 entry: a suggested group (same chapter or same import, from
  // /v1/brainstorms/suggest) gives its first 3 cards; with none, the 3 most
  // recent cards, unfinished ones first. Fewer than 3 cards: how many more.
  async loadBrainstorm(epoch, account) {
    const seq = (this.bsSeq = (this.bsSeq || 0) + 1);
    const fresh = () => this.active(epoch, account) && seq === this.bsSeq;
    try {
      const [suggest, recent] = await Promise.all([
        api.get("/v1/brainstorms/suggest").catch(() => null),
        api.get(
          `/v1/cards?pick=true${sceneParam(account) ? `&scene=${sceneParam(account)}` : ""}`,
        ),
      ]);
      if (!fresh()) return;
      const list = ((recent && recent.data) || []).map(view),
        byId = new Map(list.map((c) => [String(c.id), c])),
        group = ((suggest && suggest.items) || []).find(
          (item) => (item.cardIds || []).length >= BRAINSTORM_MIN,
        );
      let picked = [],
        why = "";
      if (group) {
        const ids = group.cardIds.slice(0, BRAINSTORM_MIN).map(String);
        const found = await Promise.all(
          ids.map((id) =>
            byId.has(id)
              ? byId.get(id)
              : api
                  .get(`/v1/cards/${encodeURIComponent(id)}`)
                  .then(view, () => null),
          ),
        );
        if (!fresh()) return;
        picked = found.filter(Boolean);
        if (picked.length === BRAINSTORM_MIN) why = group.title || "";
      }
      if (picked.length < BRAINSTORM_MIN)
        picked = list.filter((c) => !c.done).concat(list.filter((c) => c.done));
      const total = Math.max(
        Number((recent && recent.total) || 0),
        list.length,
      );
      this.setData({
        bs: brainstormView(picked, {
          need: Math.max(0, BRAINSTORM_MIN - total),
          why,
        }),
      });
    } catch (error) {
      if (fresh())
        this.setData({
          bs: { ...brainstormView([]), need: 0, failed: true },
        });
    }
  },
  // 开始头脑风暴: the pick page opens with these 3 already picked.
  startBrainstorm() {
    if (this.data.guest || !this.data.consent) return gate.ask();
    const bs = this.data.bs;
    if (!bs.ready || bs.need || bs.cards.length < BRAINSTORM_MIN || !once(this)) return;
    wx.navigateTo({
      url: `/pages/brainstorm/pick/index?source=deck&pre=${bs.cards.map((c) => encodeURIComponent(c.id)).join(",")}`,
    });
  },
  onBsCard(e) {
    if (this.data.guest || !this.data.consent || this.data.bs.example)
      return this.startBrainstorm();
    const id = e.currentTarget.dataset.id;
    if (id && once(this)) wx.navigateTo({ url: `/pages/card/index?id=${encodeURIComponent(id)}` });
  },
  hideBsImg() {
    this.setData({ bsImg: "" });
  },
  hideRvImg() {
    this.setData({ rvImg: "" });
  },
  openReview() {
    if (this.data.guest || !this.data.consent) return gate.ask();
    wx.navigateTo({ url: "/pages/resume-list/index" });
  },
  // Typing searches after a short pause; the search key searches at once.
  search(e) {
    this.setData({ query: e.detail.value });
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      if (this.alive) this.load(true);
    }, 400);
  },
  submitSearch() {
    clearTimeout(this.searchTimer);
    return this.load(true);
  },
  togglePanel() {
    if (this.data.guest) return gate.ask();
    this.setData({ panelOpen: !this.data.panelOpen });
  },
  // A tab is one of 全部 / 收藏 / a type / 已完成; tag, scene and order stay.
  pickTab(e) {
    if (this.data.guest) return gate.ask();
    const value = e.currentTarget.dataset.value || "all";
    this.setData({
      types: this.data.types.map((t) => ({ ...t, selected: t.id === value })),
      favorite: value === "favorite" ? "true" : "",
      closed: value === "closed" ? "true" : "",
    });
    return this.load(true);
  },
  filter(e) {
    const { key, value } = e.currentTarget.dataset;
    const field =
      key === "type" ? "types" : key === "tag" ? "tagChoices" : "scenes";
    this.setData({
      [field]: this.data[field].map((i) => ({
        ...i,
        selected: i.id === value ? !i.selected : i.selected,
      })),
    });
    return this.load(true);
  },
  toggleFlag(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [key]: this.data[key] ? "" : "true" });
    return this.load(true);
  },
  sort(e) {
    this.setData({ order: e.currentTarget.dataset.value });
    return this.load(true);
  },
  moreMenu() {
    if (this.data.guest) return gate.ask();
    const account = owner(),
      epoch = this.epoch;
    wx.showActionSheet({
      itemList: ["多选", "头脑风暴", "以前的头脑风暴", "管理标签"],
      success: ({ tapIndex }) => {
        if (!this.active(epoch, account)) return;
        if (tapIndex === 0) this.startSelect();
        else if (tapIndex === 1) this.brainstorm();
        // past brainstorms, each opened where it stands.
        else if (tapIndex === 2) wx.navigateTo({ url: "/pages/brainstorm/history/index" });
        else wx.navigateTo({ url: "/pages/tags/index" });
      },
    });
  },
  toggleExamples() {
    this.setData({ examplesOpen: !this.data.examplesOpen });
  },
  onTileTap(e) {
    const card = e.detail.card;
    if (this.data.selecting) return this.toggleSelect(card);
    wx.navigateTo({
      url: `/pages/card/index?${card.id.startsWith("example-") ? "example" : "id"}=${encodeURIComponent(card.id)}`,
    });
  },
  more() {
    if (this.data.cursor) return this.load(false);
  },
  toggleSelect(card) {
    this.selectedCards ||= new Map();
    if (this.selectedCards.has(card.id)) this.selectedCards.delete(card.id);
    else this.selectedCards.set(card.id, card);
    this.setData({ selected: [...this.selectedCards.keys()] });
    this.setCards(this.data.cards);
  },
  startSelect(card) {
    // Picking several hides the tab bar; the pick bar takes its place.
    tabBar(false);
    this.setData({ selecting: true, panelOpen: false });
    if (card) this.toggleSelect(card);
  },
  // Long press: favorite the card, or start picking several.
  hold(e) {
    const card = e.detail.card;
    if (!card || card.id.startsWith("example-") || this.data.guest) return;
    if (this.data.selecting) return this.toggleSelect(card);
    const account = owner(),
      epoch = this.epoch;
    wx.showActionSheet({
      itemList: [card.favorite ? "取消收藏" : "收藏", "多选"],
      success: ({ tapIndex }) => {
        if (!this.active(epoch, account)) return;
        if (tapIndex === 0) this.toggleFavorite(card);
        else this.startSelect(card);
      },
    });
  },
  async toggleFavorite(card) {
    const account = owner(),
      epoch = this.epoch,
      favorite = !card.favorite;
    try {
      const result = await api.put(
        `/v1/cards/${encodeURIComponent(card.id)}/favorite`,
        { favorite },
      );
      if (!this.active(epoch, account)) return;
      wx.showToast({ title: favorite ? "收藏了" : "取消收藏了", icon: "none" });
      if (this.data.favorite && !favorite) return this.load(true, true);
      const next = (result && result.card) || { ...card, favorite };
      const cards = this.data.cards.map((c) =>
        c.id === card.id
          ? { ...view({ ...c, ...next }), selected: c.selected, due: c.due }
          : c,
      );
      // The 收藏 count follows at once.
      const stats = this.data.stats && {
        ...this.data.stats,
        favorites: Math.max(
          0,
          Number(this.data.stats.favorites || 0) + (favorite ? 1 : -1),
        ),
      };
      this.setData({
        cards,
        cols: columns(cards),
        ...(stats ? { stats, tabs: tabsWith(stats, this.data.tab) } : {}),
      });
    } catch (error) {
      if (this.active(epoch, account))
        this.setData({ error: errorText(error) });
    }
  },
  cancelSelect() {
    tabBar(true);
    this.selectedCards = new Map();
    this.setData({ selecting: false, selected: [] });
    this.setCards(this.data.cards);
  },
  async selectAll() {
    const epoch = this.epoch,
      account = owner(),
      base = this.url(),
      selected = new Map();
    if (this.data.loading) return;
    this.setData({ loading: true, error: "" });
    try {
      let cursor = "";
      do {
        const result = await api.get(
          base + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
        );
        if (!this.active(epoch, account) || base !== this.url()) return;
        for (const card of result.data) selected.set(card.id, view(card));
        cursor = result.cursor || "";
      } while (cursor);
      this.selectedCards = selected;
      this.setData({ selected: [...selected.keys()] });
      this.setCards(this.data.cards);
    } catch (error) {
      if (this.active(epoch, account))
        this.setData({ error: errorText(error) });
    } finally {
      if (this.active(epoch, account)) this.setData({ loading: false });
    }
  },
  // Cards are deleted one by one; the first failure stops the rest and the
  // list reloads so the deleted ones are gone either way.
  removeSelected() {
    const ids = this.data.selected.slice(),
      account = owner(),
      epoch = this.epoch;
    if (!ids.length || this.data.saving || this.data.merging) return;
    wx.showModal({
      content: `删掉这 ${ids.length} 张？`,
      confirmText: "删掉",
      confirmColor: "#e0474c",
      success: async ({ confirm }) => {
        if (!confirm || !this.active(epoch, account)) return;
        this.setData({ saving: true, error: "" });
        const done = [];
        try {
          for (const id of ids) {
            if (!this.active(epoch, account)) return;
            await api.del(`/v1/cards/${encodeURIComponent(id)}`);
            done.push(id);
          }
          if (this.active(epoch, account)) {
            this.cancelSelect();
            await this.load(true, true);
          }
        } catch (error) {
          if (!this.active(epoch, account)) return;
          for (const id of done) this.selectedCards.delete(id);
          this.setData({ selected: [...this.selectedCards.keys()] });
          await this.load(true, true);
          if (this.active(epoch, account))
            this.setData({ error: errorText(error) });
        } finally {
          if (this.active(epoch, account)) this.setData({ saving: false });
        }
      },
    });
  },
  // 2–10 cards become one new card; the originals are kept inside it
  // (hidden) and the merge can be undone from the new card.
  merge() {
    const ids = this.data.selected.slice(),
      account = owner(),
      epoch = this.epoch;
    if (this.data.merging || this.data.saving) return;
    if (ids.length < 2 || ids.length > 10) {
      wx.showToast({ title: "选 2 到 10 张再合并", icon: "none" });
      return;
    }
    wx.showModal({
      content: `合并成一张？原来的 ${ids.length} 张收在新卡里，可以拆开`,
      confirmText: "合并",
      success: ({ confirm }) => {
        if (confirm && this.active(epoch, account))
          this.runMerge(ids, epoch, account);
      },
    });
  },
  async runMerge(ids, epoch, account) {
    const key = ids.join(",");
    // A retry of the same selection reuses its clientId.
    if (this.mergeKey !== key) {
      this.mergeKey = key;
      this.mergeId = mergeClientId();
    }
    this.setData({ merging: true, error: "" });
    try {
      const { job } = await api.post("/v1/cards/merge", {
        cardIds: ids,
        clientId: this.mergeId,
      });
      // Left before it finished: onShow waits for it again.
      this.pendingMerge = { job, account };
      if (!this.active(epoch, account)) return;
      await this.finishMerge(epoch, account);
    } catch (error) {
      if (
        this.active(epoch, account) &&
        error.code !== "CANCELLED" &&
        !api.needsConsent(error)
      )
        this.setData({ error: errorText(error) });
    } finally {
      if (this.active(epoch, account)) this.setData({ merging: false });
    }
  },
  // Waits for the merge job, ends 多选 and opens the new card.
  async finishMerge(epoch, account) {
    const pending = this.pendingMerge;
    if (!pending) return;
    let done;
    try {
      done = await api.waitJob(pending.job, () => this.active(epoch, account));
    } catch (error) {
      if (error.code === "CANCELLED") return;
      this.pendingMerge = null;
      throw error;
    }
    if (this.pendingMerge !== pending) return;
    this.pendingMerge = null;
    if (!this.active(epoch, account)) return;
    const cardId =
      done && done.status === "succeeded" && done.result && done.result.cardId;
    if (!cardId) {
      // A new try gets a new clientId.
      this.mergeKey = "";
      this.setData({ error: api.jobMessage(done) });
      return;
    }
    this.mergeKey = "";
    this.cancelSelect();
    await this.load(true, true);
    wx.navigateTo({ url: `/pages/card/index?id=${encodeURIComponent(cardId)}` });
  },
  brainstorm() {
    if (this.data.guest) return gate.ask();
    const ids = this.data.selected.length >= 3 ? this.data.selected : [];
    // 多选 ends before leaving, so the tab bar is back on every page after.
    if (this.data.selecting) this.cancelSelect();
    wx.navigateTo({
      url: `/pages/brainstorm/pick/index?source=notes${ids.length ? `&ids=${ids.map(encodeURIComponent).join(",")}` : ""}`,
    });
  },
  // Fewer than 3 cards: 记一张 on 随心记 instead of a 头脑风暴 that cannot start.
  openNotes() {
    wx.switchTab({ url: "/pages/notes/index" });
  },
  demoBrainstorm() {
    wx.navigateTo({ url: "/pages/brainstorm/process/index?example=1" });
  },
}));
