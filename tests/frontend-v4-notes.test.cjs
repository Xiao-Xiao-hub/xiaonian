// 随心记页面回归：核对输入、进度提示、最近卡片与已完成内容的排列。
const test = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");
const cards = require(path.join(root, "utils/cards.js"));

test("stage maps to a progress bar and a stage word", () => {
  const cases = [
    [{ type: "idea" }, "已记下", 25],
    [{ type: "idea", organizedAt: "2026-10-01" }, "已整理", 50],
    [{ type: "idea", mine: "我自己的话" }, "已说清", 75],
    // V4.2 G3 (intentional): a closed card says what done means for its kind.
    [{ type: "idea", mine: "我自己的话", closedAt: "2026-10-02" }, "落地了", 100],
    [{ type: "idea", stage: "organized" }, "已整理", 50],
  ];
  for (const [card, name, pct] of cases) {
    const v = cards.view(card);
    assert.equal(v.stageName, name);
    assert.equal(v.pct, pct);
    assert.equal(v.done, pct === 100);
  }
  // A closed time without 我的话 is not done.
  assert.equal(cards.view({ type: "idea", closedAt: "2026-10-02" }).done, false);
  const wxml = fs.readFileSync(path.join(root, "components/card-tile/index.wxml"), "utf8");
  assert.match(wxml, /class="pc t-\{\{cardView.typeClass\}\} \{\{cardView.done \? 'done' : ''\}\}/);
  assert.match(wxml, /\{\{cardView.stageName\}\}/);
});

test("the tile line keeps colour marks as spans and shows no mark syntax", () => {
  const v = cards.view({
    type: "method",
    slots: [{ key: "steps", text: "先约分再求导" }],
    slotsMarked: [{ key: "steps", text: "先[[k:约分]]再求导" }],
  });
  assert.deepEqual(
    v.sumParts.map((x) => x.v).join(""),
    "先约分再求导",
  );
  assert.ok(v.sumParts.some((x) => x.cls.startsWith("mk key")));
  // Older servers: plain slots only.
  const old = cards.view({ type: "method", slots: [{ key: "steps", text: "先约分" }] });
  assert.equal(old.sumParts[0].v, "先约分");
});

test("已完成 cards go last and keep their order", () => {
  const list = ["a", "b", "c", "d"].map((id, i) =>
    cards.view({ id, type: "idea", mine: "x", closedAt: i % 2 ? "" : "2026-10-02" }),
  );
  assert.deepEqual(
    cards.doneLast(list).map((c) => c.id),
    ["b", "d", "a", "c"],
  );
});

function notes(state, storage = {}) {
  let def;
  const urls = [],
    asks = [],
    nav = [];
  const api = {
    get: async (url) => {
      urls.push(url);
      return { data: [], cursor: "", total: 0 };
    },
    post: async (url) => {
      urls.push(url);
      return {};
    },
    needsConsent: () => false,
  };
  const sandbox = {
    require: (n) =>
      n.endsWith("/share") ? { withShare: (page) => page } : n.endsWith("/api")
        ? api
        : n.endsWith("/auth")
          ? {
              getUser: () => null,
              hasConsent: () => state === "ok",
              login: async () => {
                throw Object.assign(Error("游客"), { code: "GUEST_MODE" });
              },
            }
          : n.endsWith("/gate")
            ? {
                state: () => state,
                check: () => state !== "none",
                ask: () => asks.push(true),
              }
            : n.endsWith("/format")
              ? { errorText: (e) => e.message }
              : n.endsWith("/assets")
                ? { asset: (name) => `https://assets.test/${name}` }
                : n.endsWith("/chat-entry")
                  ? { openChat: () => nav.push("chat"), openAsk: () => nav.push("ask") }
                  : n.endsWith("/examples")
                    ? require(path.join(root, "utils/examples.js"))
                    : require(path.join(root, "utils/cards.js")),
    Page: (x) => (def = x),
    getApp: () => ({ globalData: {} }),
    wx: {
      navigateTo: (x) => nav.push(x.url),
      showActionSheet: () => nav.push("sheet"),
      getStorageSync: (k) => storage[k] || "",
      setStorageSync: (k, v) => (storage[k] = v),
      stopPullDownRefresh() {},
    },
    setTimeout: () => 1,
    clearTimeout() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "pages/notes/index.js"), "utf8"), sandbox);
  const p = {
    ...def,
    data: structuredClone(def.data),
    setData(patch) {
      Object.assign(this.data, patch);
    },
    selectComponent: () => null,
  };
  return { p, urls, asks, nav };
}

test("a guest on 随心记 sends no requests; 先记下, 聊一聊 and import ask to agree; 最近 shows example cards", async () => {
  const h = notes("guest");
  h.p.onLoad();
  await h.p.onShow();
  assert.equal(h.p.data.ready, true);
  assert.equal(h.p.data.guest, true);
  assert.equal(h.p.data.recent.length, 3);
  assert.ok(h.p.data.recent.every((c) => c.id.startsWith("example-")));
  h.p.data.text = "想记一句";
  await h.p.save();
  h.p.chat();
  h.p.openImport({ currentTarget: { dataset: { pick: "photo" } } });
  await h.p.onPullDownRefresh();
  assert.equal(h.asks.length, 3);
  assert.deepEqual(h.urls, []);
  assert.deepEqual(h.nav, []);
  // 试试这样写 still fills the box; V4.2 G3 (intentional): words already
  // there are kept and the line goes after them.
  h.p.starter({ currentTarget: { dataset: { text: "极限这块听不懂" } } });
  assert.equal(h.p.data.text, "想记一句\n极限这块听不懂");
  h.p.data.text = "";
  h.p.starter({ currentTarget: { dataset: { text: "极限这块听不懂" } } });
  assert.equal(h.p.data.text, "极限这块听不懂");
});

test("not agreed and not a guest: nothing renders before the welcome page", () => {
  const h = notes("none");
  h.p.onLoad();
  assert.equal(h.p.data.ready, false);
  h.p.onShow();
  assert.equal(h.p.data.ready, false);
  assert.deepEqual(h.urls, []);
  const wxml = fs.readFileSync(path.join(root, "pages/notes/index.wxml"), "utf8");
  assert.match(wxml, /<view wx:if="\{\{ready\}\}" class="page ph-body">/);
});

test("closing the hello card is remembered", () => {
  const storage = {};
  const h = notes("ok", storage);
  h.p.onLoad();
  assert.equal(h.p.data.helloClosed, false);
  assert.equal(h.p.data.helloImg, "https://assets.test/xiaoli-hi.webp");
  h.p.closeHello();
  assert.equal(h.p.data.helloClosed, true);
  const again = notes("ok", storage);
  again.p.onLoad();
  assert.equal(again.p.data.helloClosed, true);
});
