"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const root = path.resolve(__dirname, "../miniprogram");
const pagePath = path.join(root, "pages/card-pick/index.js");
const apiPath = path.join(root, "utils/api.js");

const gatePath = path.join(root, "utils/gate.js");
function page(api, app) {
  let def;
  global.Page = (value) => {
    def = value;
  };
  global.getApp = () => app;
  global.getCurrentPages = () => [];
  global.wx = {
    getStorageSync() {
      return null;
    },
    setNavigationBarColor() {},
    setNavigationBarTitle(options) {
      global.pickTitle = options.title;
    },
    setBackgroundColor() {},
    showToast() {},
    navigateBack() {},
  };
  delete require.cache[pagePath];
  require.cache[gatePath] = { id: gatePath, filename: gatePath, loaded: true, exports: { state: () => "ok", check: () => true, ask() {} } };
  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: api,
  };
  require(pagePath);
  def.data = structuredClone(def.data);
  def.setData = (patch) => Object.assign(def.data, patch);
  return def;
}

test("picker restores caller selection, keeps snapshots across filters and returns them", async () => {
  const app = {
    globalData: { cardPick: { mode: "chat", selected: ["existing"] } },
  };
  const p = page(
    {
      get: (url) =>
        Promise.resolve(
          url.includes("/tags")
            ? []
            : {
                data: [
                  { id: "existing", type: "question", title: "已有" },
                  { id: "a", type: "idea", title: "A" },
                ],
                total: 2,
                cursor: "",
              },
        ),
      needsConsent: () => false,
    },
    app,
  );
  p.onLoad();
  p.onShow();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(p.data.cards[0].selected, true);
  p.toggle({ detail: { card: p.data.cards[1] } });
  p.filter({ currentTarget: { dataset: { key: "type", value: "idea" } } });
  await Promise.resolve();
  await Promise.resolve();
  p.done();
  assert.deepEqual(
    app.globalData.pickedCards.map((card) => card.id),
    ["existing", "a"],
  );
});

test("brainstorm cannot finish with fewer than three cards", async () => {
  let backed = false;
  const p = page(
    {
      get: (url) =>
        Promise.resolve(
          url.includes("/tags") ? [] : { data: [], total: 0, cursor: "" },
        ),
      needsConsent: () => false,
    },
    {
      globalData: {
        cardPick: { mode: "brainstorm", selected: ["one", "two"] },
      },
    },
  );
  wx.navigateBack = () => {
    backed = true;
  };
  p.onLoad();
  p.onShow();
  await Promise.resolve();
  p.done();
  assert.equal(backed, false);
});

test("picker rejects over-50 all select and late responses after hide", async () => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const p = page(
    {
      get: (url) => (url.includes("/tags") ? Promise.resolve([]) : pending),
      needsConsent: () => false,
    },
    { globalData: { cardPick: { mode: "brainstorm" } } },
  );
  p.onLoad();
  p.onShow();
  p.setData({ total: 51 });
  p.selectAll();
  p.onHide();
  resolve({
    data: [{ id: "late", type: "idea", title: "late" }],
    total: 1,
    cursor: "",
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(p.data.cards, []);
});

test("picker enforces mode limits", async () => {
  const p = page(
    {
      get: (url) =>
        Promise.resolve(
          url.includes("/tags") ? [] : { data: [], total: 0, cursor: "" },
        ),
      needsConsent: () => false,
    },
    { globalData: { cardPick: { mode: "link" } } },
  );
  p.onLoad();
  p.onShow();
  p.toggle({ detail: { card: { id: "one", type: "idea" } } });
  p.toggle({ detail: { card: { id: "two", type: "idea" } } });
  assert.deepEqual(p.data.selected, ["one"]);
});

test("card helper does not render a stamp without mine", () => {
  const cards = require(path.join(root, "utils/cards.js"));
  assert.equal(cards.view({ type: "idea", closedAt: "now" }).closed, false);
  assert.equal(
    cards.view({ type: "idea", scene: "mood", mine: "x", closedAt: "now" })
      .stage,
    "clear",
  );
  assert.deepEqual(cards.view({ type: "idea" }).stageDots, [
    true,
    false,
    false,
    false,
  ]);
  assert.deepEqual(cards.view({ type: "idea", organizedAt: "now" }).stageDots, [
    true,
    true,
    false,
    false,
  ]);
  assert.deepEqual(cards.view({ type: "idea", mine: "这是我的话" }).stageDots, [
    true,
    true,
    true,
    false,
  ]);
});

test("brainstorm all-select keeps the filter snapshot while paging", async () => {
  let firstResolve;
  const first = new Promise((resolve) => {
    firstResolve = resolve;
  });
  const urls = [];
  const api = {
    get(url) {
      urls.push(url);
      if (urls.length === 1) return first;
      return Promise.resolve({
        data: [{ id: "b", type: "idea", title: "B" }],
        total: 2,
        cursor: "",
      });
    },
    needsConsent: () => false,
  };
  const p = page(api, { globalData: { cardPick: { mode: "brainstorm" } } });
  p.onLoad();
  p.alive = true;
  p.epoch = 1;
  p.data.total = 2;
  p.data.types = p.data.types.map((item) => ({
    ...item,
    selected: item.id === "idea",
  }));
  const selecting = p.selectAll();
  p.data.types = p.data.types.map((item) => ({
    ...item,
    selected: item.id === "question",
  }));
  firstResolve({
    data: [{ id: "a", type: "idea", title: "A" }],
    total: 2,
    cursor: "next",
  });
  await selecting;
  // kinds, sent as kind=.
  assert.match(urls[0], /kind=idea/);
  assert.match(urls[1], /kind=idea/);
  assert.deepEqual(p.data.selected.sort(), ["a", "b"]);
});

test("picker says how many to pick and names the confirm button per mode", async () => {
  const api = {
    get: (url) =>
      Promise.resolve(
        url.includes("/tags") ? [] : { data: [], total: 0, cursor: "" },
      ),
    needsConsent: () => false,
  };
  const expected = {
    chat: ["挑几张带去聊", /3 张/, "带这 1 张去聊"],
    link: ["连上哪张卡", /挑一张/, "连上这张"],
    brainstorm: ["挑卡来头脑风暴", /3 到 50 张/, "用这 1 张头脑风暴"],
  };
  for (const [mode, [title, hint, button]] of Object.entries(expected)) {
    const p = page(api, { globalData: { cardPick: { mode } } });
    p.onLoad();
    p.onShow();
    assert.equal(global.pickTitle, title);
    assert.match(p.data.hint, hint);
    p.toggle({ detail: { card: { id: "one", type: "idea" } } });
    assert.equal(p.data.doneText, button);
  }
  const p = page(api, { globalData: { cardPick: { mode: "chat" } } });
  p.onLoad();
  assert.equal(p.data.doneText, "不带卡了");
});

test("picker ignores taps without a card and keeps filters behind one button", async () => {
  const urls = [];
  const p = page(
    {
      get: (url) => {
        urls.push(url);
        return Promise.resolve(
          url.includes("/tags")
            ? [{ id: "t1", name: "极限", color: 0 }]
            : { data: [], total: 0, cursor: "" },
        );
      },
      needsConsent: () => false,
    },
    { globalData: { cardPick: { mode: "chat" } } },
  );
  p.onLoad();
  p.onShow();
  await Promise.resolve();
  p.toggle({ detail: {} });
  p.toggle({});
  assert.deepEqual(p.data.selected, []);
  assert.equal(p.data.filterOpen, false);
  p.toggleFilter();
  assert.equal(p.data.filterOpen, true);
  p.filter({ currentTarget: { dataset: { key: "scene", value: "life" } } });
  assert.equal(p.data.filterCount, 1);
  assert.match(urls[urls.length - 1], /scene=life/);
  p.clearFilters();
  assert.equal(p.data.filterCount, 0);
  assert.doesNotMatch(urls[urls.length - 1], /scene=/);
});

// the stage in the kind's words instead of a percentage bar.
test("compact tiles show type, title, star and the stage word", () => {
  const cards = require(path.join(root, "utils/cards.js"));
  const wxml = fs.readFileSync(path.join(root, "components/card-tile/index.wxml"), "utf8");
  assert.match(wxml, /class="stg /);
  assert.doesNotMatch(wxml, /cardView.pct/);
  assert.match(wxml, /wx:if="\{\{cardView.favorite\}\}" class="fav">★/);
  assert.equal(cards.view({ type: "idea" }).favorite, false);
  assert.equal(cards.view({ type: "idea", favorite: true }).favorite, true);
});
