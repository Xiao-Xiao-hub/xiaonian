// V4.1 G6 : the 卡片 tab is a two-column card wall again, cards due for
// 回顾 carry a badge, and a 头脑风暴 entry with xiaoli and 3 suggested cards
// sits on top; the pick page takes those cards already picked.
const test = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const tick = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const today = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

function deck({ state = "ok", routes = {} } = {}) {
  let def;
  const urls = [],
    nav = [],
    asks = [];
  const api = {
    get: async (url) => {
      urls.push(url);
      for (const [prefix, value] of Object.entries(routes))
        if (url.startsWith(prefix))
          return typeof value === "function" ? value(url) : value;
      return url === "/v1/tags"
        ? []
        : url === "/v1/cards/stats"
          ? { total: 0 }
          : url.startsWith("/v1/resume")
            ? []
            : { data: [], cursor: "", total: 0 };
    },
    needsConsent: () => false,
  };
  const sandbox = {
    require: (n) =>
      n.endsWith("/share") ? { withShare: (page) => page } : n.endsWith("/api")
        ? api
        : n.endsWith("/auth")
          ? {
              getUser: () => ({ id: "one" }),
              hasConsent: () => state === "ok",
              login: async () => {},
            }
          : n.endsWith("/gate")
            ? { check: () => true, state: () => state, ask: () => asks.push(true) }
            : n.endsWith("/format")
              ? { errorText: (e) => e.message }
              : n.endsWith("/assets")
                ? { asset: (name) => `https://assets.test/${name}` }
                : n.endsWith("/examples")
                  ? require(path.join(root, "utils/examples.js"))
                  : n.endsWith("/tap")
                    ? require(path.join(root, "utils/tap.js"))
                    : require(path.join(root, "utils/cards.js")),
    Page: (x) => (def = x),
    getApp: () => ({ globalData: {} }),
    wx: {
      navigateTo: (x) => nav.push(x.url),
      showActionSheet() {},
      showTabBar() {},
      hideTabBar() {},
      stopPullDownRefresh() {},
    },
    setTimeout: () => 1,
    clearTimeout() {},
    Date,
  };
  vm.runInNewContext(read("pages/deck/index.js"), sandbox);
  const p = {
    ...def,
    data: structuredClone(def.data),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  };
  p.onLoad();
  return { p, urls, nav, asks };
}

const card = (id, extra = {}) => ({
  id,
  type: "idea",
  title: `卡 ${id}`,
  ...extra,
});

test("the wall splits cards into two columns, done cards sink to the bottom of both", () => {
  const { p } = deck();
  p.setCards([
    card("a"),
    card("d1", { stage: "closed" }),
    card("b"),
    card("c"),
    card("d2", { stage: "closed" }),
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(p.data.cols.map((col) => col.map((c) => c.id)))),
    [
      ["a", "c", "d2"],
      ["b", "d1"],
    ],
  );
  const wxml = read("pages/deck/index.wxml");
  assert.match(wxml, /class="wall"><view wx:for="\{\{cols\}\}"/);
  assert.match(wxml, /due="\{\{item\.due\}\}"/);
  // The examples are a wall too.
  assert.match(wxml, /wx:for="\{\{exampleCols\}\}"/);
});

test("a card is due when 回顾 asks about it today, not by remindOn alone; done cards never are; an empty 回顾 clears it", async () => {
  const { p } = deck({
    routes: {
      "/v1/resume": [
        { src: "card", srcId: "r", state: "waiting", dueOn: today() },
        { src: "card", srcId: "later", state: "waiting", dueOn: "2999-01-01" },
        { src: "import", srcId: "x", state: "waiting", dueOn: today() },
      ],
    },
  });
  p.alive = true;
  p.epoch = 1;
  p.account = "one";
  p.setCards([
    card("old", { remindOn: "2020-01-01" }),
    card("future", { remindOn: "2999-01-01" }),
    card("r"),
    card("later"),
    card("x"),
    card("closed", { stage: "closed", remindOn: "2020-01-01" }),
  ]);
  await p.loadDue(1, "one");
  const due = Object.fromEntries(p.data.cards.map((c) => [c.id, c.due]));
  assert.deepEqual(due, {
    old: false,
    future: false,
    r: true,
    later: false,
    x: false,
    closed: false,
  });
  assert.equal(p.data.dueCount, 2);
  // The last one answered: back on the page, the badge goes.
  const empty = deck({ routes: { "/v1/resume": [] } });
  empty.p.alive = true;
  empty.p.epoch = 1;
  empty.p.account = "one";
  empty.p.dueSet = new Set(["r"]);
  empty.p.setCards([card("r")]);
  assert.equal(empty.p.data.cols[0][0].due, true);
  await empty.p.loadDue(1, "one");
  assert.equal(empty.p.data.cards[0].due, false);
  assert.equal(empty.p.data.cols[0][0].due, false);
});

test("the tile shows the 待回顾 badge, a 3-line summary, the type label, star, fold and progress", () => {
  const wxml = read("components/card-tile/index.wxml"),
    wxss = read("components/card-tile/index.wxss"),
    js = read("components/card-tile/index.js");
  assert.match(js, /due: \{ type: Boolean/);
  // 待回顾 only on cards that are reviewed.
  assert.match(wxml, /wx:if="\{\{due && !cardView\.done && \(!cardView\.follow \|\| cardView\.follow === 'review'\)\}\}" class="due">待回顾</);
  assert.match(wxml, /class="pc t-\{\{cardView\.typeClass\}\}/);
  assert.match(wxml, /class="fav">★/);
  // the stage in words, no percentage bar.
  assert.match(wxml, /class="stg/);
  assert.doesNotMatch(wxml, /pct/);
  assert.match(wxss, /-webkit-line-clamp: 3 !important/);
  // The one-line row stays for 随心记's 最近.
  assert.match(wxml, /wx:if="\{\{row\}\}" class="crow/);
});

test("头脑风暴 entry: a suggested group gives its first 3 cards and the button opens pick with them", async () => {
  const { p, nav, urls } = deck({
    routes: {
      "/v1/cards/stats": { total: 5 },
      "/v1/brainstorms/suggest": {
        items: [{ kind: "chapter", title: "第一章 函数与极限", cardIds: ["s1", "s2", "s3", "s4"] }],
      },
      "/v1/cards?pick=true": {
        data: [card("s1", { type: "spark" }), card("s2"), card("n1")],
        total: 5,
      },
      "/v1/cards/s3": card("s3", { type: "question" }),
    },
  });
  await p.onShow();
  await tick();
  const bs = p.data.bs;
  assert.equal(bs.ready, true);
  assert.equal(bs.need, 0);
  assert.equal(bs.why, "第一章 函数与极限");
  assert.deepEqual(Array.from(bs.cards, (c) => c.id), ["s1", "s2", "s3"]);
  assert.deepEqual(Array.from(bs.cards, (c) => c.typeClass), ["spark", "idea", "question"]);
  assert.ok(urls.includes("/v1/cards/s3"));
  assert.equal(p.data.bsImg, "https://assets.test/xiaoli-brainstorm.webp");
  p.startBrainstorm();
  assert.equal(nav.at(-1), "/pages/brainstorm/pick/index?source=deck&pre=s1,s2,s3");
  // A double tap opens one page; so does a card.
  p.startBrainstorm();
  p.onBsCard({ currentTarget: { dataset: { id: "s1" } } });
  assert.equal(nav.length, 1);
  p.lastTapAt = 0;
  p.onBsCard({ currentTarget: { dataset: { id: "s1" } } });
  p.onBsCard({ currentTarget: { dataset: { id: "s1" } } });
  assert.equal(nav.length, 2);
});

test("头脑风暴 entry: without a suggested group, the 3 latest cards, unfinished first", async () => {
  const { p } = deck({
    routes: {
      "/v1/cards/stats": { total: 4 },
      "/v1/brainstorms/suggest": { items: [] },
      "/v1/cards?pick=true": {
        data: [card("d", { stage: "closed" }), card("a"), card("b"), card("c")],
        total: 4,
      },
    },
  });
  await p.onShow();
  await tick();
  assert.deepEqual(Array.from(p.data.bs.cards, (c) => c.id), ["a", "b", "c"]);
  assert.equal(p.data.bs.why, "");
  assert.equal(p.data.bs.need, 0);
});

test("头脑风暴 entry: with fewer than 3 cards it says how many more and the button does nothing", async () => {
  const { p, nav } = deck({
    routes: {
      "/v1/cards/stats": { total: 1 },
      "/v1/brainstorms/suggest": { items: [] },
      "/v1/cards?pick=true": { data: [card("a")], total: 1 },
    },
  });
  await p.onShow();
  await tick();
  assert.equal(p.data.bs.need, 2);
  assert.deepEqual(Array.from(p.data.bs.cards, (c) => c.id), ["a"]);
  p.startBrainstorm();
  assert.equal(nav.length, 0);
  const wxml = read("pages/deck/index.wxml");
  assert.match(wxml, /还差 \{\{bs\.need\}\} 张卡/);
  assert.match(wxml, /disabled="\{\{\(bs\.need \|\| !bs\.ready \|\| bs\.cards\.length < 3\) && !guest && consent\}\}"/);
});

test("头脑风暴 entry: it loads on its own, so a filter tapped during the first load does not leave it waiting", async () => {
  let release;
  const { p } = deck({
    routes: {
      "/v1/cards/stats": () => new Promise((r) => (release = () => r({ total: 3 }))),
      "/v1/brainstorms/suggest": { items: [] },
      "/v1/cards?pick=true": { data: [card("a"), card("b"), card("c")], total: 3 },
    },
  });
  const shown = p.onShow();
  await tick();
  // A type tab while stats is still on its way: the first request goes stale.
  await p.pickTab({ currentTarget: { dataset: { value: "idea" } } });
  release();
  await shown;
  await tick();
  assert.equal(p.data.bs.ready, true);
  assert.deepEqual(Array.from(p.data.bs.cards, (c) => c.id), ["a", "b", "c"]);
});

test("头脑风暴 entry: when the cards do not load it says so and the button stays off", async () => {
  const { p, nav } = deck({
    routes: {
      "/v1/cards/stats": { total: 3 },
      "/v1/cards?pick=true": () => Promise.reject(new Error("网络")),
    },
  });
  await p.onShow();
  await tick();
  assert.equal(p.data.bs.failed, true);
  assert.equal(p.data.bs.cards.length, 0);
  p.startBrainstorm();
  assert.equal(nav.length, 0);
  assert.match(read("pages/deck/index.wxml"), /bs\.failed\}\}" class="bs-need">没打开，下拉刷新/);
  // No empty card row: the line says it.
  assert.match(read("pages/deck/index.wxml"), /<view wx:if="\{\{!bs\.failed\}\}" class="bs-cards">/);
});

test("头脑风暴 entry: a guest sees the examples and the button asks them to sign in", async () => {
  const { p, nav, asks, urls } = deck({ state: "guest" });
  await p.onShow();
  await tick();
  assert.equal(p.data.bs.example, true);
  assert.equal(p.data.bs.cards.length, 3);
  assert.equal(p.data.bs.need, 0);
  assert.ok(!urls.some((u) => u.startsWith("/v1/brainstorms")));
  p.startBrainstorm();
  p.onBsCard({ currentTarget: { dataset: { id: "example-idea" } } });
  assert.equal(asks.length, 2);
  assert.equal(nav.length, 0);
});

test("the page order is 头脑风暴, 回顾, type row, wall; 多选 hides the two entries; the old entries stay", () => {
  const wxml = read("pages/deck/index.wxml");
  const at = (s) => wxml.indexOf(s);
  assert.ok(at('class="bs-hero"') > 0);
  assert.ok(at('class="bs-hero"') < at('class="review"'));
  assert.ok(at('class="review"') < at('class="type-bar"'));
  assert.ok(at('class="type-bar"') < at('class="wall"'));
  // Both entries sit in the wx:else of 多选's head.
  assert.ok(at("<block wx:else>") < at('class="bs-hero"'));
  assert.ok(wxml.indexOf("</block>", at('class="type-bar"')) < at('class="wall"'));
  assert.match(wxml, /bindtap="brainstorm">\{\{selected\.length>=3/);
  // 以前的头脑风暴 sits before 管理标签.
  assert.match(read("pages/deck/index.js"), /itemList: \["多选", "头脑风暴", "以前的头脑风暴", "管理标签"\]/);
  const wxss = read("pages/deck/index.wxss");
  assert.match(wxss, /\.bs-go \{[^}]*width: auto !important/);
  assert.doesNotMatch(wxss, /^\.bar\b/m);
  const banned = ["心理咨询", "心理治疗", "心理医生", "疗愈", "治疗", "诊断", "陪伴", "陪着你"];
  for (const word of banned) assert.ok(!wxml.includes(word), word);
});

// The pick page with `pre`: those cards come picked and first; others can be added.
function put(file, exports) {
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
function pick(get) {
  let def;
  global.Page = (value) => (def = value);
  global.getApp = () => ({ globalData: {} });
  global.wx = { showToast() {}, navigateTo() {}, redirectTo() {} };
  put(path.join(root, "utils/api.js"), { get, needsConsent: () => false });
  put(path.join(root, "utils/auth.js"), { getUser: () => ({ id: "u1" }), hasConsent: () => true });
  put(path.join(root, "utils/gate.js"), { state: () => "ok", check: () => true, ask() {} });
  const file = path.join(root, "pages/brainstorm/pick/index.js");
  delete require.cache[file];
  require(file);
  def.data = structuredClone(def.data);
  def.setData = (patch) => Object.assign(def.data, patch);
  return def;
}

test("pick takes `pre` cards picked and first, keeps the full list, and skips cards that are gone", async () => {
  const urls = [];
  const page = pick(async (url) => {
    urls.push(url);
    if (url === "/v1/tags") return [];
    if (url === "/v1/cards/p1") return card("p1", { type: "spark" });
    if (url === "/v1/cards/p2") return card("p2");
    if (url === "/v1/cards/gone") throw Object.assign(new Error("没有"), { status: 404 });
    if (url.startsWith("/v1/cards?pick=true"))
      return { data: [card("x1"), card("p2"), card("x2")], total: 9, cursor: "next" };
    throw new Error(url);
  });
  // As written in the url: a percent-encoded list is decoded too.
  page.onLoad({ source: "deck", pre: "p1%2Cp2,gone" });
  page.onShow();
  await tick();
  assert.equal(page.data.fixed, false);
  assert.deepEqual(page.data.cards.map((c) => c.id), ["p1", "p2", "x1", "x2"]);
  assert.deepEqual(page.data.selected, ["p1", "p2"]);
  assert.deepEqual(
    page.data.cards.filter((c) => c.selected).map((c) => c.id),
    ["p1", "p2"],
  );
  assert.equal(page.data.cursor, "next");
  assert.match(page.data.notice, /推荐的 2 张已选好/);
  // Picking another one adds to the handed-over ones.
  page.toggle({ detail: { card: page.data.cards[2] } });
  assert.deepEqual(page.data.selected, ["p1", "p2", "x1"]);
  // Coming back does not fetch the handed-over cards again.
  const before = urls.filter((u) => u.startsWith("/v1/cards/")).length;
  page.onHide();
  page.onShow();
  await tick();
  assert.equal(urls.filter((u) => u.startsWith("/v1/cards/")).length, before);
  assert.deepEqual(page.data.selected, ["p1", "p2", "x1"]);
});

test("pick drops the handed-over cards on an account switch, keeps the 50 limit, and does not bring back a deleted one", async () => {
  let list = [card("x1"), card("p1")];
  const page = pick(async (url) => {
    if (url === "/v1/tags") return [];
    if (url === "/v1/cards/p1") return card("p1");
    if (url.startsWith("/v1/cards?pick=true")) return { data: list, total: list.length, cursor: "" };
    throw new Error(url);
  });
  page.onLoad({ pre: "p1" });
  page.onShow();
  await tick();
  assert.deepEqual(page.data.cards.map((c) => c.id), ["p1", "x1"]);
  // p1 deleted elsewhere: coming back shows only what the server has.
  list = [card("x1")];
  page.onHide();
  page.onShow();
  await tick();
  assert.deepEqual(page.data.cards.map((c) => c.id), ["x1"]);
  // Another account: nothing of the first one comes back.
  page.resetOwner();
  assert.deepEqual(page.preIds, []);
  assert.equal(page.preCards, null);
  assert.equal(page.data.notice, "");
  // 50 already picked while the handed-over cards loaded: none is added.
  const full = pick(async (url) =>
    url === "/v1/tags"
      ? []
      : url.startsWith("/v1/cards/")
        ? card(url.split("/").pop())
        : { data: [], total: 0, cursor: "" },
  );
  full.onLoad({ pre: "a,b" });
  full.alive = true;
  full.epoch = 1;
  for (let i = 0; i < 50; i++) full.selectedCards.set(`s${i}`, card(`s${i}`));
  await full.loadPre();
  assert.equal(full.selectedCards.size, 50);
});

test("多选 → 头脑风暴 hands its cards over as a plain list, and pick decodes an encoded one (was 0 cards on device)", async () => {
  const { p, nav } = deck();
  p.alive = true;
  p.epoch = 1;
  p.account = "one";
  p.startSelect();
  for (const id of ["a", "b", "c"]) p.toggleSelect({ id });
  p.brainstorm();
  assert.equal(nav.at(-1), "/pages/brainstorm/pick/index?source=notes&ids=a,b,c");
  const page = pick(async (url) =>
    url === "/v1/tags"
      ? []
      : { data: [card("a"), card("b"), card("c"), card("z")], total: 4, cursor: "" },
  );
  page.onLoad({ source: "notes", ids: "a%2Cb%2Cc" });
  page.onShow();
  await tick();
  assert.equal(page.data.fixed, true);
  assert.deepEqual(page.data.cards.map((c) => c.id), ["a", "b", "c"]);
  assert.deepEqual(page.data.selected, ["a", "b", "c"]);
});
