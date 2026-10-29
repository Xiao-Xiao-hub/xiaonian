// 卡片 tab : the list, filters, 多选, merge and delete moved here from
// 随心记 (frontend-v2-notes), plus counts, 回顾 and the tab bar while picking.
const test = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const tick = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
function page(overrides = {}) {
  let def,
    account = "one",
    timer,
    state = overrides.state || "ok";
  const urls = [],
    app = { globalData: {} },
    nav = [],
    sheets = [],
    stops = [],
    bar = [],
    asks = [];
  const api = {
    get: async (url) => {
      urls.push(url);
      return url === "/v1/tags"
        ? []
        : url === "/v1/cards/stats"
          ? { total: 7 }
          : url.startsWith("/v1/resume")
            ? []
            : { data: [], cursor: "", total: 0 };
    },
    post: async () => ({ job: { id: "j", status: "queued" } }),
    needsConsent: () => false,
    ...overrides,
  };
  const sandbox = {
    require: (n) =>
      n.endsWith("/share") ? { withShare: (page) => page } : n.endsWith("/api")
        ? api
        : n.endsWith("/auth")
          ? {
              getUser: () => ({ id: account }),
              hasConsent: () => state === "ok",
              login: async () => {},
            }
          : n.endsWith("/gate")
            ? {
                check: () => true,
                state: () => state,
                ask: () => asks.push(true),
              }
            : n.endsWith("/format")
              ? { errorText: (e) => e.message }
              : n.endsWith("/assets")
                ? { asset: (name) => `https://assets.test/${name}` }
                : n.endsWith("/examples")
                ? require(path.join(root, "utils/examples.js"))
                : require(path.join(root, "utils/cards.js")),
    Page: (x) => (def = x),
    getApp: () => app,
    wx: {
      navigateTo: (x) => nav.push(x.url),
      showModal: (x) => (overrides.modal ? overrides.modal(x) : undefined),
      showToast: (x) => (overrides.toast ? overrides.toast(x) : undefined),
      showActionSheet: (x) => sheets.push(x),
      stopPullDownRefresh: () => stops.push(true),
      hideTabBar: () => bar.push("hide"),
      showTabBar: () => bar.push("show"),
    },
    setTimeout: (fn, ms) => {
      timer = { fn, ms };
      return 1;
    },
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
  p.alive = true;
  p.epoch = 1;
  p.account = "one";
  return {
    p,
    api,
    urls,
    // The list's own query, not the 头脑风暴 entry's pick=true read.
    cardsUrl: () =>
      urls
        .filter((u) => u.startsWith("/v1/cards?") && !u.includes("pick=true"))
        .at(-1),
    app,
    nav,
    sheets,
    stops,
    bar,
    asks,
    timer: () => timer,
    change: () => {
      account = "two";
    },
  };
}

test("multiple filters combine in the query and a late older result cannot replace a new filter", async () => {
  let oldResolve;
  const h = page();
  h.p.data.types[0].selected = true;
  h.p.data.types[1].selected = true;
  h.p.data.scenes[1].selected = true;
  // the chips are kinds, sent as kind=.
  assert.match(h.p.url(), /kind=spark%2Cidea/);
  assert.match(h.p.url(), /scene=life/);
  h.api.get = () =>
    new Promise((resolve) => {
      oldResolve = resolve;
    });
  const old = h.p.load(true);
  await tick(1);
  h.api.get = async () => ({
    data: [{ id: "new", type: "idea", title: "新筛选" }],
    cursor: "",
    total: 1,
  });
  await h.p.load(true);
  oldResolve({
    data: [{ id: "old", type: "idea", title: "旧筛选" }],
    cursor: "",
    total: 1,
  });
  await old;
  assert.equal(h.p.data.cards[0].id, "new");
});

test("select-all loads every filtered page without dropping selections or issuing a cursor-less loop", async () => {
  let n = 0;
  const h = page({
    get: async () => ({
      data: [{ id: `c${++n}`, type: "idea", title: "卡" }],
      cursor: n === 1 ? "next" : "",
      total: 2,
    }),
  });
  await h.p.selectAll();
  assert.deepEqual(Array.from(h.p.data.selected), ["c1", "c2"]);
  assert.equal(n, 2);
});

test("brainstorm from picked cards and the example entries reach registered pages", () => {
  const h = page();
  h.p.data.selected = ["a", "b", "c"];
  h.p.brainstorm();
  assert.match(h.nav.pop(), /brainstorm\/pick\/index.*ids=a,b,c/);
  h.p.data.selected = ["a"];
  h.p.brainstorm();
  assert.doesNotMatch(h.nav.pop(), /ids=/);
  h.p.toggleExamples();
  assert.equal(h.p.data.examplesOpen, true);
  h.p.demoBrainstorm();
  assert.equal(h.nav.pop(), "/pages/brainstorm/process/index?example=1");
  const wxml = read("pages/deck/index.wxml");
  assert.match(wxml, /看看示例/);
  assert.match(wxml, /看它们怎么一起头脑风暴/);
});

test("search searches after a pause; the tabs pick 全部, 收藏, one type or 已完成, each with a count", async () => {
  const wxml = read("pages/deck/index.wxml");
  assert.match(wxml, /class="search"/);
  assert.match(wxml, /bindtap="pickTab"/);
  assert.match(wxml, /class="cnt">\{\{item\.n\}\}/);
  const h = page({
    get: async (url) => {
      h.urls.push(url);
      return url === "/v1/tags"
        ? []
        : url === "/v1/cards/stats"
          ? { total: 9, favorites: 2, closed: 3, byType: { idea: 4, spark: 1 } }
          : url.startsWith("/v1/resume")
            ? []
            : { data: [], cursor: "", total: 0 };
    },
  });
  await h.p.load(true, true);
  // only kinds that have cards get a chip (byType from v4 servers).
  assert.deepEqual(
    Array.from(h.p.data.tabs, (t) => `${t.name}${t.n}`),
    ["全部9", "收藏2", "灵感1", "想法4", "已完成3"],
  );
  h.p.search({ detail: { value: "极限" } });
  assert.equal(h.timer().ms, 400);
  h.timer().fn();
  await tick(1);
  assert.match(h.cardsUrl(), /q=%E6%9E%81%E9%99%90/);
  await h.p.pickTab({ currentTarget: { dataset: { value: "question" } } });
  assert.match(h.cardsUrl(), /kind=question(&|$)/);
  assert.equal(h.p.data.tab, "question");
  // The kind being looked at keeps its chip even with no cards.
  assert.ok(h.p.data.tabs.some((t) => t.id === "question"));
  await h.p.pickTab({ currentTarget: { dataset: { value: "favorite" } } });
  assert.match(h.cardsUrl(), /favorite=1/);
  assert.doesNotMatch(h.cardsUrl(), /kind=/);
  await h.p.pickTab({ currentTarget: { dataset: { value: "closed" } } });
  assert.match(h.cardsUrl(), /closed=true/);
  assert.equal(h.p.data.tab, "closed");
  assert.equal(h.p.data.filterText, "“极限”");
  await h.p.pickTab({ currentTarget: { dataset: { value: "all" } } });
  assert.doesNotMatch(h.cardsUrl(), /kind=|closed|favorite/);
  assert.equal(h.p.data.tab, "all");
});

test("an older server without byType still counts 全部, 收藏 and 已完成", async () => {
  const h = page();
  await h.p.load(true, true);
  assert.equal(h.p.data.tabs[0].n, 7);
  assert.equal(h.p.data.tabs[2].n, "");
});

test("every active filter is named in one line and the cross clears all of them", async () => {
  const h = page({
    get: async (url) => {
      h.urls.push(url);
      return url === "/v1/tags"
        ? [{ id: "t1", name: "高数" }]
        : url === "/v1/cards/stats"
          ? { total: 7 }
          : url.startsWith("/v1/resume")
            ? []
            : { data: [], cursor: "", total: 0 };
    },
  });
  h.app.globalData.cardFilter = { scene: "mood" };
  h.p.data.order = "used";
  await h.p.onShow();
  assert.equal(h.p.data.filterText, "心情");
  assert.match(h.cardsUrl(), /scene=mood/);
  assert.doesNotMatch(h.cardsUrl(), /order=used/);
  await h.p.filter({ currentTarget: { dataset: { key: "type", value: "question" } } });
  await h.p.filter({ currentTarget: { dataset: { key: "tag", value: "t1" } } });
  await h.p.toggleFlag({ currentTarget: { dataset: { key: "retest" } } });
  await h.p.sort({ currentTarget: { dataset: { value: "created" } } });
  assert.equal(h.p.data.tab, "question");
  assert.equal(h.p.data.filterText, "高数 · 心情 · 待再试 · 最早");
  await h.p.toggleFlag({ currentTarget: { dataset: { key: "closed" } } });
  assert.equal(h.p.data.tab, "");
  assert.equal(h.p.data.filterText, "问题 · 高数 · 心情 · 已完成 · 待再试 · 最早");
  await h.p.clearFilters();
  assert.equal(h.p.data.filterText, "");
  assert.equal(h.urls.at(-1), "/v1/cards?order=updated");
  h.app.globalData.cardFilter = { pointId: "p1", pointName: "极限" };
  await h.p.onShow();
  assert.equal(h.p.data.filterText, "极限");
  assert.match(h.cardsUrl(), /point=p1/);
});

test("the more menu keeps select, brainstorm and tag management only; pull-down refresh always stops", async () => {
  const h = page();
  h.p.data.consent = true;
  h.p.moreMenu();
  // 以前的头脑风暴 added before 管理标签.
  assert.deepEqual(Array.from(h.sheets[0].itemList), ["多选", "头脑风暴", "以前的头脑风暴", "管理标签"]);
  h.sheets[0].success({ tapIndex: 0 });
  assert.equal(h.p.data.selecting, true);
  h.sheets[0].success({ tapIndex: 1 });
  assert.match(h.nav.pop(), /brainstorm\/pick\/index\?source=notes/);
  h.sheets[0].success({ tapIndex: 2 });
  assert.equal(h.nav.pop(), "/pages/brainstorm/history/index");
  h.sheets[0].success({ tapIndex: 3 });
  assert.equal(h.nav.pop(), "/pages/tags/index");
  await h.p.onPullDownRefresh();
  assert.equal(h.stops.length, 1);
});

test("long press favorites a card or starts multi-select; 收藏 and a tag from the tags page filter the list", async () => {
  const puts = [];
  const h = page({
    get: async (url) => {
      h.urls.push(url);
      return url === "/v1/tags"
        ? [{ id: "t9", name: "极限" }]
        : url === "/v1/cards/stats"
          ? { total: 7, favorites: 1 }
          : url.startsWith("/v1/resume")
            ? []
            : { data: [], cursor: "", total: 0 };
    },
    put: async (url, body) => {
      puts.push([url, body]);
      return { card: { id: "c1", type: "idea", title: "卡", favorite: body.favorite } };
    },
  });
  h.p.data.cards = [{ id: "c1", type: "idea", title: "卡", favorite: false }];
  h.p.hold({ detail: { card: { id: "c1", favorite: false } } });
  assert.deepEqual(Array.from(h.sheets[0].itemList), ["收藏", "多选"]);
  h.sheets[0].success({ tapIndex: 0 });
  await tick(1);
  assert.equal(JSON.stringify(puts[0]), '["/v1/cards/c1/favorite",{"favorite":true}]');
  assert.equal(h.p.data.cards[0].favorite, true);
  h.p.hold({ detail: { card: { id: "c1", favorite: true } } });
  assert.deepEqual(Array.from(h.sheets[1].itemList), ["取消收藏", "多选"]);
  h.sheets[1].success({ tapIndex: 1 });
  assert.equal(h.p.data.selecting, true);
  assert.deepEqual(Array.from(h.p.data.selected), ["c1"]);
  h.p.hold({ detail: { card: { id: "example-a" } } });
  assert.equal(h.sheets.length, 2);
  h.p.cancelSelect();
  h.app.globalData.cardFilter = { favorite: true };
  await h.p.onShow();
  assert.equal(h.p.data.tab, "favorite");
  assert.match(h.cardsUrl(), /favorite=1/);
  h.app.globalData.cardFilter = { tag: "t9", tagName: "极限" };
  await h.p.onShow();
  assert.equal(h.p.data.filterText, "极限");
  assert.match(h.cardsUrl(), /tag=t9/);
  assert.doesNotMatch(h.cardsUrl(), /favorite/);
});

test("batch delete asks 删掉这 N 张？, stops at the first failure and reloads", async () => {
  const deleted = [],
    modals = [];
  const h = page({
    modal: (x) => {
      modals.push(x);
      x.success({ confirm: true });
    },
    del: async (url) => {
      if (url.endsWith("/b")) throw new Error("没删掉");
      deleted.push(url);
    },
  });
  h.p.startSelect({ id: "a" });
  h.p.toggleSelect({ id: "b" });
  h.p.toggleSelect({ id: "c" });
  h.p.removeSelected();
  await tick();
  assert.equal(modals[0].content, "删掉这 3 张？");
  assert.equal(modals[0].confirmText, "删掉");
  assert.deepEqual(deleted, ["/v1/cards/a"]);
  assert.equal(h.p.data.error, "没删掉");
  assert.equal(JSON.stringify(h.p.data.selected), '["b","c"]');
});

test("merge needs 2 to 10 cards, confirms, waits for the job and opens the new card", async () => {
  const posts = [],
    modals = [],
    toasts = [];
  let jobResult;
  const h = page({
    modal: (x) => {
      modals.push(x);
      x.success({ confirm: true });
    },
    toast: (x) => toasts.push(x.title),
    post: async (url, body) => {
      posts.push([url, body]);
      return { job: { id: "j1", status: "queued" } };
    },
    waitJob: async (job, alive) => {
      assert.equal(alive(), true);
      return jobResult;
    },
    jobMessage: (job) => job.error.message,
  });
  const wxml = read("pages/deck/index.wxml");
  const bar = wxml.slice(wxml.indexOf('class="selbar"'));
  assert.ok(bar.indexOf('bindtap="merge"') < bar.indexOf("删除"));
  assert.ok(bar.indexOf("删除") < bar.indexOf("头脑风暴"));
  assert.match(bar, /合并中…/);
  h.p.startSelect({ id: "a" });
  h.p.merge();
  assert.deepEqual(toasts, ["选 2 到 10 张再合并"]);
  h.p.toggleSelect({ id: "b" });
  jobResult = { id: "j1", status: "failed", error: { message: "有卡在合并时改过了，再试一次" } };
  h.p.merge();
  await tick();
  // the originals are kept inside the new card.
  assert.equal(modals[0].content, "合并成一张？原来的 2 张收在新卡里，可以拆开");
  assert.equal(h.p.data.error, "有卡在合并时改过了，再试一次");
  assert.equal(h.p.data.selecting, true);
  jobResult = { id: "j1", status: "succeeded", result: { cardId: "new-1" } };
  h.p.merge();
  await tick(8);
  assert.equal(posts[0][0], "/v1/cards/merge");
  assert.equal(JSON.stringify(posts[0][1].cardIds), '["a","b"]');
  // a failed merge is tried again under a new clientId (older servers
  // returned the failed job for the old one).
  assert.notEqual(posts[1][1].clientId, posts[0][1].clientId);
  assert.equal(h.p.data.selecting, false);
  assert.equal(h.p.data.merging, false);
  assert.equal(h.nav.at(-1), "/pages/card/index?id=new-1");
  assert.equal(h.bar.at(-1), "show");
});

test("多选 hides the tab bar; cancel, onHide, onUnload, brainstorm and delete bring it back; onShow hides it again", async () => {
  const h = page({
    modal: (x) => x.success({ confirm: true }),
    del: async () => {},
  });
  h.p.startSelect({ id: "a" });
  assert.deepEqual(h.bar, ["hide"]);
  h.p.cancelSelect();
  assert.equal(h.bar.at(-1), "show");

  h.p.startSelect({ id: "a" });
  h.p.onHide();
  assert.equal(h.bar.at(-1), "show");
  assert.equal(h.p.data.selecting, true);
  // Back with the card still there: 多选 continues and the bar hides again.
  h.api.get = async (url) => {
    h.urls.push(url);
    return url === "/v1/tags"
      ? []
      : url === "/v1/cards/stats"
        ? { total: 1 }
        : url.startsWith("/v1/resume")
          ? []
          : { data: [{ id: "a", type: "idea", title: "卡" }], cursor: "", total: 1 };
  };
  await h.p.onShow();
  assert.equal(h.p.data.selecting, true);
  assert.ok(h.bar.lastIndexOf("hide") > h.bar.lastIndexOf("show"));
  h.p.onUnload();
  assert.equal(h.bar.at(-1), "show");

  h.p.alive = true;
  h.p.startSelect({ id: "a" });
  h.p.brainstorm();
  assert.equal(h.p.data.selecting, false);
  assert.equal(h.bar.at(-1), "show");

  h.p.startSelect({ id: "a" });
  h.p.removeSelected();
  await tick();
  assert.equal(h.p.data.selecting, false);
  assert.equal(h.bar.at(-1), "show");
});

test("a merge finished while away: gone picks are dropped, 多选 ends and the new card opens", async () => {
  let release;
  const h = page({
    modal: (x) => x.success({ confirm: true }),
    waitJob: (job, alive) =>
      new Promise((resolve, reject) => {
        release = (value) => (alive() ? resolve(value) : reject(Object.assign(Error("x"), { code: "CANCELLED" })));
      }),
  });
  h.p.startSelect({ id: "a" });
  h.p.toggleSelect({ id: "b" });
  h.p.merge();
  await tick();
  h.p.onHide();
  release({ status: "succeeded", result: { cardId: "m1" } });
  await tick();
  assert.ok(h.p.pendingMerge, "the job is kept for onShow");
  // The merged cards are gone from the list; the job is done now.
  h.api.waitJob = async () => ({ status: "succeeded", result: { cardId: "m1" } });
  await h.p.onShow();
  await tick(8);
  assert.equal(h.p.data.selecting, false);
  assert.deepEqual(Array.from(h.p.data.selected), []);
  assert.equal(h.p.pendingMerge, null);
  assert.equal(h.nav.at(-1), "/pages/card/index?id=m1");
  assert.equal(h.bar.at(-1), "show");
});

test("回顾 counts what is due today and opens the 回顾 list", async () => {
  const h = page({
    get: async (url) => {
      h.urls.push(url);
      return url === "/v1/tags"
        ? []
        : url === "/v1/cards/stats"
          ? { total: 3 }
          : url.startsWith("/v1/resume")
            ? [
                { id: "1", state: "waiting", dueOn: "2000-01-01" },
                { id: "2", state: "waiting", dueOn: "2999-01-01" },
                { id: "3", state: "dormant", dueOn: "2000-01-01" },
                { id: "4", state: "waiting" },
              ]
            : { data: [], cursor: "", total: 0 };
    },
  });
  await h.p.onShow();
  await tick();
  assert.ok(h.urls.includes("/v1/resume?state=waiting"));
  assert.equal(h.p.data.dueCount, 2);
  h.p.openReview();
  assert.equal(h.nav.at(-1), "/pages/resume-list/index");
  const wxml = read("pages/deck/index.wxml");
  assert.ok(wxml.indexOf('class="review"') < wxml.indexOf('class="type-bar"'));
  // Not "bar": app.wxss styles that as a 6rpx loading bar, which hid the tags.
  assert.doesNotMatch(wxml, /class="bar"/);
});

test("a guest sees example rows, sends no requests and every action asks to agree", async () => {
  const h = page({ state: "guest" });
  await h.p.onShow();
  assert.equal(h.urls.length, 0);
  assert.equal(h.p.data.guest, true);
  assert.equal(h.p.data.examplesOpen, true);
  assert.ok(h.p.data.examples.length > 0);
  h.p.openReview();
  h.p.moreMenu();
  h.p.togglePanel();
  h.p.pickTab({ currentTarget: { dataset: { value: "idea" } } });
  h.p.brainstorm();
  assert.equal(h.asks.length, 5);
  assert.equal(h.sheets.length, 0);
  assert.equal(h.nav.length, 0);
});

test("the search sits in the page head, the cards are a two-column wall (D113), done cards go last", () => {
  const wxml = read("pages/deck/index.wxml");
  assert.ok(wxml.indexOf('class="search"') < wxml.indexOf("</page-head>"));
  assert.match(wxml, /<page-head title="卡片"/);
  assert.match(wxml, /class="wall"><view wx:for="\{\{cols\}\}"[^>]*class="colw"><card-tile wx:for="\{\{col\}\}"/);
  assert.doesNotMatch(wxml, /card-tile[^>]* row[ >]/);
  const wxss = read("pages/deck/index.wxss");
  assert.match(wxss.match(/\.search \{[^}]*\}/)[0], /height: 64rpx/);
  const h = page();
  h.p.setCards([
    { id: "d", type: "idea", title: "完", stage: "closed" },
    { id: "o", type: "idea", title: "开" },
  ]);
  assert.deepEqual(Array.from(h.p.data.cards, (c) => c.id), ["o", "d"]);
  const json = JSON.parse(read("pages/deck/index.json"));
  assert.equal(json.navigationStyle, "custom");
  assert.equal(json.enablePullDownRefresh, true);
});
