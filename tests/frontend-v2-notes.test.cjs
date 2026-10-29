const test = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");
function page(overrides = {}) {
  let def,
    account = "one",
    timer;
  const urls = [],
    app = { globalData: {} },
    nav = [],
    sheets = [],
    stops = [];
  const api = {
    get: async (url) => {
      urls.push(url);
      return url === "/v1/tags"
        ? []
        : url === "/v1/cards/stats"
          ? { total: 7 }
          : { data: [], cursor: "", total: 0 };
    },
    post: async () => ({
      card: { id: "c", quote: "我想把这件事想清楚", scene: "life" },
    }),
    needsConsent: () => false,
    ...overrides,
  };
  // chat-entry runs inside the same sandbox so it sees this getApp and wx.
  const shared = (file) =>
    vm.runInContext(
      `(function (module) {${fs.readFileSync(path.join(root, file), "utf8")}\nreturn module.exports;})`,
      sandbox,
    )({ exports: {} });
  const sandbox = {
    require: (n) =>
      n.endsWith("/share") ? { withShare: (page) => page } : n.endsWith("/chat-entry")
        ? shared("utils/chat-entry.js")
        : n.endsWith("/stream")
          ? require(path.join(root, "utils/stream.js"))
        : n.endsWith("/learn")
          ? require(path.join(root, "utils/learn.js"))
        : n.endsWith("/api")
          ? api
          : n.endsWith("/auth")
            ? {
                getUser: () => ({ id: account }),
                hasConsent: () => true,
                login: async () => {},
                recordConsent() {},
              }
            : n.endsWith("/gate")
              ? { check: () => true, state: () => "ok" }
            : n.endsWith("/theme")
              ? { themed: (x) => x }
              : n.endsWith("/format")
                ? { errorText: (e) => e.message }
                : n.endsWith("/examples")
                  ? { cards: [] }
                  : n.endsWith("/assets")
                    ? { asset: (name) => `https://assets.test/${name}` }
                    : require(path.join(root, "utils/cards.js")),
    Page: (x) => (def = x),
    getApp: () => app,
    wx: {
      navigateTo: (x) => nav.push(x.url),
      switchTab: (x) => {
        nav.push(x.url);
        if (x.success) x.success();
      },
      showModal: (x) => (overrides.modal ? overrides.modal(x) : undefined),
      showToast: (x) => (overrides.toast ? overrides.toast(x) : undefined),
      showActionSheet: (x) => sheets.push(x),
      stopPullDownRefresh: () => stops.push(true),
      // 随心记 opens the tour for anyone who has not seen it.
      getStorageSync: (key) => (key === "zhiye_onboarded" ? "1" : ""),
      setStorageSync() {},
    },
    setTimeout: (fn, ms) => {
      timer = { fn, ms };
      return 1;
    },
    clearTimeout() {},
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, "pages/notes/index.js"), "utf8"),
    sandbox,
  );
  const p = {
    ...def,
    data: structuredClone(def.data),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  };
  p.onLoad();
  p.alive = true;
  p.epoch = 1;
  p.account = "one";
  return {
    p,
    api,
    urls,
    app,
    nav,
    sheets,
    stops,
    timer: () => timer,
    change: () => {
      account = "two";
    },
  };
}
test("save preserves the original for the five-second chat receipt; failures preserve the draft", async () => {
  const h = page();
  h.p.data.text = "我想把这件事想清楚";
  await h.p.save();
  assert.equal(h.p.data.text, "");
  assert.equal(h.timer().ms, 5000);
  h.p.chat({ currentTarget: { dataset: { saved: true } } });
  assert.equal(h.app.globalData.chat.text, "我想把这件事想清楚");
  assert.equal(h.app.globalData.chat.entry, "jot");
  assert.deepEqual(Array.from(h.app.globalData.chat.cardIds), ["c"]);
  assert.equal(h.nav.at(-1), "/pages/chat/index");
  assert.equal(h.app.globalData.ask, undefined);
  h.timer().fn();
  assert.equal(h.p.data.saved, false);
  h.api.post = async () => {
    throw Error("失败");
  };
  h.p.data.text = "不要丢掉草稿";
  await h.p.save();
  assert.equal(h.p.data.text, "不要丢掉草稿");
});
test("crisis create navigates without a success receipt or clearing the input", async () => {
  const h = page({ post: async () => ({ crisis: true }) });
  h.p.data.text = "固定危机测试文本";
  await h.p.save();
  assert.equal(h.p.data.saved, false);
  assert.equal(h.p.data.text, "固定危机测试文本");
  assert.deepEqual(h.nav, ["/pages/crisis/index"]);
});
test("changing the owner while saving cannot clear another account draft", async () => {
  let resolve;
  const h = page({ post: () => new Promise((r) => (resolve = r)) });
  h.p.data.text = "原账号草稿";
  const pending = h.p.save();
  h.change();
  h.p.data.text = "新账号草稿";
  resolve({ card: { id: "old", scene: "life" } });
  await pending;
  assert.equal(h.p.data.text, "新账号草稿");
  assert.equal(h.p.data.saved, false);
});

test("the box keeps one solid button; camera, album and file open the import directly; no ⋯ menu", () => {
  const wxml = fs.readFileSync(
    path.join(root, "pages/notes/index.wxml"),
    "utf8",
  );
  const compose = wxml.slice(
    wxml.indexOf('class="compose"'),
    wxml.indexOf('class="receipt"'),
  );
  assert.equal(compose.match(/class="btn sm"/g).length, 1);
  assert.match(compose, /class="btn-text"[^>]*>先记下</);
  assert.match(compose, /class="btn sm"[^>]*>聊一聊</);
  for (const pick of ["photo", "screenshot", "file"])
    assert.match(compose, new RegExp(`data-pick="${pick}" bindtap="openImport"`));
  assert.match(wxml, /记下了/);
  const h = page();
  for (const pick of ["photo", "screenshot", "file"]) {
    h.p.openImport({ currentTarget: { dataset: { pick } } });
    assert.equal(h.nav.pop(), `/pages/import/source/index?pick=${pick}`);
  }
  // v4 : no ⋯ menu here; 拍一道题 lives on 学习, 多选 etc. on 卡片.
  assert.equal(h.p.moreMenu, undefined);
  assert.doesNotMatch(wxml, /moreMenu|拍一道题/);
});

test("随心记 keeps three blocks: the box, 试试这样写 and the newest three cards with 全部 › to 卡片", async () => {
  const wxml = fs.readFileSync(path.join(root, "pages/notes/index.wxml"), "utf8");
  assert.doesNotMatch(wxml, /class="search"|pickTab|selbar|selecting|再看一些|wall-head|filter/);
  // the 小狸 card (resume-card) is on top, above the box.
  assert.ok(wxml.indexOf("<resume-card") < wxml.indexOf('class="compose"'));
  assert.ok(wxml.indexOf('class="compose"') < wxml.indexOf("试试这样写"));
  assert.ok(wxml.indexOf("试试这样写") < wxml.indexOf("最近"));
  assert.match(wxml, /<resume-card[^>]* quiet /);
  const js = fs.readFileSync(path.join(root, "pages/notes/index.js"), "utf8");
  assert.doesNotMatch(js, /TabBar|startSelect|merge/);
  const cards = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, type: "idea", title: `卡${i}` }));
  const h = page({
    get: async (url) => {
      h.urls.push(url);
      return { data: cards, cursor: "x", total: 12 };
    },
  });
  await h.p.onShow();
  // V4.2 : the unfinished 聊一聊 chat is looked up too (one line under 小狸).
  assert.deepEqual(h.urls, ["/v1/cards", "/v1/chat/threads?kind=chat&limit=5"]);
  assert.deepEqual(Array.from(h.p.data.recent, (c) => c.id), ["c0", "c1", "c2"]);
  assert.equal(h.p.data.allTotal, 12);
  h.p.openDeck();
  assert.equal(h.nav.pop(), "/pages/deck/index");
  // A filter meant for the card list goes on to 卡片.
  h.app.globalData.cardFilter = { scene: "mood" };
  await h.p.onShow();
  assert.equal(h.nav.pop(), "/pages/deck/index");
});

test("试试这样写 puts the line into the box and sends nothing", () => {
  const h = page();
  h.p.starter({ currentTarget: { dataset: { text: "极限这块听不懂" } } });
  assert.equal(h.p.data.text, "极限这块听不懂");
  assert.equal(h.p.data.composeFocus, true);
  assert.equal(h.nav.length, 0);
  assert.equal(h.app.globalData.chat, undefined);
});
