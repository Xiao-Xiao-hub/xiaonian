// card kinds, follow-ups, merge, mood cards together. Synthetic data.
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
// One fake wx for the page and the real utils it loads.
function fakeWx(extra = {}) {
  const storage = new Map();
  const calls = { nav: [], modal: [], toast: [], tab: [] };
  const wx = {
    getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ""),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    navigateTo: (x) => calls.nav.push(x.url),
    redirectTo: (x) => calls.nav.push(x.url),
    navigateBack: () => calls.nav.push("back"),
    switchTab: (x) => calls.tab.push(x.url),
    showModal: (x) => {
      calls.modal.push(x);
      if (extra.confirm !== undefined) x.success && x.success({ confirm: extra.confirm });
    },
    showToast: (x) => calls.toast.push(x.title),
    showActionSheet: () => {},
    setNavigationBarTitle: () => {},
    reLaunch: (x) => calls.nav.push(x.url),
    stopPullDownRefresh: () => {},
    hideTabBar: () => {},
    showTabBar: () => {},
    pageScrollTo: () => {},
    vibrateShort: () => {},
    ...extra.wx,
  };
  return { wx, storage, calls };
}
// Loads a page or component with api/auth/gate stubbed and real utils.
function load(file, { api, account = "u1", wx, kind = "Page" } = {}) {
  let def;
  global.wx = wx;
  const app = { globalData: {} };
  global.getApp = () => app;
  const stubs = {
    api: {
      get: async () => ({ data: [], total: 0 }),
      post: async () => ({}),
      patch: async () => ({}),
      put: async () => ({}),
      del: async () => ({}),
      needsConsent: () => false,
      ...api,
    },
    auth: {
      getUser: () => ({ id: account }),
      hasConsent: () => true,
      login: async () => {},
    },
    gate: { check: () => true, state: () => "ok", ask: () => {} },
    format: {
      ...require(path.join(root, "utils/format.js")),
      errorText: (e) => e.message,
    },
    assets: { asset: (n) => `https://assets.test/${n}` },
  };
  const sandbox = {
    require: (n) => {
      const name = path.basename(n).replace(/\.js$/, "");
      if (stubs[name]) return stubs[name];
      return require(path.join(root, "utils", `${name}.js`));
    },
    Page: (x) => (def = x),
    Component: (x) => (def = x),
    getApp: () => app,
    wx,
    setTimeout,
    clearTimeout,
    Date,
    console,
  };
  vm.runInNewContext(read(file), sandbox);
  const p =
    kind === "Page"
      ? { ...def, data: structuredClone(def.data) }
      : {
          ...def.methods,
          data: { ...structuredClone(def.data), ...propsOf(def.properties) },
          properties: {},
          triggerEvent() {},
        };
  p.setData = function (patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (k.includes(".") || k.includes("[")) continue;
      this.data[k] = v;
    }
  };
  return { p, app, def };
}
// Bodies built inside the vm compare by value.
const plain = (x) => JSON.parse(JSON.stringify(x));
const propsOf = (props = {}) =>
  Object.fromEntries(
    Object.entries(props).map(([k, v]) => [k, v && typeof v === "object" ? v.value : undefined]),
  );

test("mood cards: shown by default, hidden per account with the profile switch", async () => {
  const f = fakeWx();
  global.wx = f.wx;
  const cards = require(path.join(root, "utils/cards.js"));
  assert.equal(cards.showMood("u1"), true);
  assert.equal(cards.sceneParam("u1", ""), "");
  cards.setShowMood("u1", false);
  assert.equal(cards.showMood("u1"), false);
  assert.equal(cards.showMood("u2"), true);
  assert.equal(cards.sceneParam("u1", ""), "study,life");
  // A scene the learner picked wins (picking 心情 still shows them).
  assert.equal(cards.sceneParam("u1", "mood"), "mood");

  // The deck, 随心记's 最近 and 选卡 send study,life while hidden.
  const urls = [];
  const api = {
    get: async (url) => {
      urls.push(url);
      return url.startsWith("/v1/cards/stats") ? { total: 0 } : url === "/v1/tags" || url.startsWith("/v1/resume") ? [] : { data: [], total: 0 };
    },
  };
  const deck = load("pages/deck/index.js", { api, wx: f.wx }).p;
  deck.onLoad();
  deck.alive = true;
  deck.epoch = 1;
  await deck.load(true, true);
  await tick();
  assert.ok(urls.some((u) => /^\/v1\/cards\?.*scene=study%2Clife/.test(u)), urls.join("\n"));
  assert.ok(urls.includes("/v1/cards/stats?scene=study,life"));
  const notes = load("pages/notes/index.js", { api, wx: f.wx }).p;
  notes.alive = true;
  notes.epoch = 1;
  await notes.load();
  assert.ok(urls.includes("/v1/cards?scene=study,life"));
  const pick = load("pages/card-pick/index.js", { api, wx: f.wx }).p;
  assert.match(pick.queryUrl("", { q: "", type: [], tag: [], scene: [] }), /scene=study%2Clife/);

  // Turned back on: nothing is filtered, as before.
  const profile = load("pages/profile/index.js", { wx: f.wx }).p;
  profile.owner = "u1";
  profile.toggleMood({ detail: { value: true } });
  assert.equal(profile.data.showMood, true);
  assert.equal(cards.sceneParam("u1", ""), "");
  assert.match(read("pages/profile/index.wxml"), /卡片里显示心情卡[\s\S]*bindchange="toggleMood"/);
});

test("seven kinds: names, colours and the stage word each kind uses", () => {
  const f = fakeWx();
  global.wx = f.wx;
  const cards = require(path.join(root, "utils/cards.js"));
  const todo = cards.view({ id: "t", type: "idea", kind: "todo", quote: "周五前交线代作业" });
  assert.deepEqual([todo.kind, todo.typeName, todo.typeClass, todo.stageName], ["todo", "待办", "todo", "要做"]);
  const done = cards.view({ id: "t", type: "idea", kind: "todo", stage: "closed", closedAt: "2026-10-02" });
  assert.equal(done.stageName, "做完了");
  assert.equal(done.done, true);
  const note = cards.view({ id: "n", type: "idea", kind: "note", quote: "图书馆三楼有插座" });
  assert.deepEqual([note.typeName, note.stageName], ["随手记", ""]);
  const known = cards.view({ id: "k", type: "method", kind: "knowledge", stage: "closed", closedAt: "2026-10-02", mine: "记住了" });
  assert.deepEqual([known.typeName, known.stageName], ["知识点", "记住了"]);
  // A v4.1 card without kind still reads by its type.
  const old = cards.view({ id: "o", type: "question", quote: "为什么" });
  assert.deepEqual([old.kind, old.typeName], ["question", "问题"]);
  for (const kind of ["todo", "knowledge", "note"]) {
    assert.ok(fs.existsSync(path.join(root, `assets/icons/card-${kind}.svg`)), kind);
    assert.match(read("app.wxss"), new RegExp(`\\.t-${kind}\\b`));
  }
  // Tiles: no percentage bar; 待回顾 only for cards that are reviewed.
  const tile = read("components/card-tile/index.wxml");
  assert.doesNotMatch(tile, /pct/);
  assert.match(tile, /cardView\.follow === 'review'/);
});

test("resume card: 有点忘 opens the card, 接着聊 opens a chat with it", async () => {
  const f = fakeWx();
  const item = {
    id: "r1",
    state: "shown",
    src: "card",
    kind: "recall",
    question: "「等价无穷小」还记得吗？",
    options: ["记住了", "有点忘", "不用提醒"],
    acts: ["remember", "forgot", "never"],
    card: { id: "c1", type: "method", kind: "knowledge", title: "等价无穷小", version: 2 },
  };
  const posts = [];
  const { p, app } = load("components/resume-card/index.js", {
    kind: "Component",
    wx: f.wx,
    api: {
      post: async (url, body) => {
        posts.push([url, body]);
        return url.endsWith("/act") ? { item: { ...item, state: "done" } } : { kind: "item", item };
      },
    },
  });
  p.alive = true;
  p.account = "u1";
  p.generation = 1;
  p.applyResult({ kind: "item", item });
  assert.equal(p.data.item.kicker, "回顾");
  assert.equal(p.data.item.later, true);
  await p.choose({ currentTarget: { dataset: { text: "有点忘" } } });
  assert.deepEqual(plain(posts.at(-1)), ["/v1/resume/r1/act", { action: "answer", text: "有点忘" }]);
  assert.match(f.calls.nav.at(-1), /^\/pages\/card\/index\?id=c1/);
  const chat = { ...item, kind: "chat", options: ["接着聊", "先放着", "不用提醒"], acts: ["chat", "later", "never"] };
  p.applyResult({ kind: "item", item: chat });
  assert.equal(p.data.item.later, false);
  await p.choose({ currentTarget: { dataset: { text: "接着聊" } } });
  await tick();
  assert.equal(f.calls.nav.at(-1), "/pages/chat/index");
  assert.deepEqual(Array.from(app.globalData.chat.cards, (c) => c.id), ["c1"]);
  clearTimeout(p.undoTimer);
});

function cardDetail(extra = {}) {
  return {
    id: "c",
    version: 2,
    type: "idea",
    kind: "todo",
    scene: "life",
    title: "交线代作业",
    quote: "周五前交线代作业",
    stage: "written",
    follow: "done",
    resume: "on",
    tags: [],
    slots: [],
    open: [],
    supplements: [],
    mergedFrom: [],
    links: [],
    createdAt: "2026-10-01T02:00:00Z",
    updatedAt: "2026-10-01T02:00:00Z",
    ...extra,
  };
}
function cardPage(detail, extra = {}) {
  const f = fakeWx({ confirm: true, ...extra });
  const hits = [];
  let current = detail;
  const api = {
    get: async (url) => {
      hits.push(["get", url]);
      if (url.startsWith("/v1/cards/c")) return current;
      return url === "/v1/tags" ? [] : { data: [], total: 0 };
    },
    post: async (url, body) => {
      hits.push(["post", url, body]);
      if (url.endsWith("/close")) current = { ...current, version: current.version + 1, stage: "closed", closedAt: "2026-10-02T00:00:00Z" };
      return { card: current };
    },
    patch: async (url, body) => {
      hits.push(["patch", url, body]);
      current = { ...current, ...body, version: current.version + 1 };
      return { card: current };
    },
  };
  const { p } = load("pages/card/index.js", { api, wx: f.wx });
  return { p, hits, f };
}

test("card page: the 之后 row turns follow-ups off at once or picks a mode", async () => {
  const { p, hits } = cardPage(cardDetail());
  p.onLoad({ id: "c" });
  p.onShow();
  await tick();
  assert.equal(p.data.detail.follow, "done");
  await p.setFollow({ currentTarget: { dataset: { follow: "none" } } });
  assert.deepEqual(plain(hits.filter((h) => h[0] === "patch").at(-1)[2]), {
    version: 2,
    follow: "none",
    resume: "off",
    remindOn: null,
    remindEvery: null,
  });
  await tick();
  await p.setFollow({ currentTarget: { dataset: { follow: "review" } } });
  assert.deepEqual(plain(hits.filter((h) => h[0] === "patch").at(-1)[2]), { version: 3, follow: "review", resume: "on" });
  const wxml = read("pages/card/index.wxml");
  assert.match(wxml, /bindtap="setFollow"/);
  assert.doesNotMatch(wxml, /以后还问你吗/);
  assert.doesNotMatch(wxml, /进度 \{\{/);
});

test("card page: a 待办 is done from ⋯ without words; changing only the title sends only the title", async () => {
  const { p, hits } = cardPage(cardDetail());
  p.onLoad({ id: "c" });
  p.onShow();
  await tick();
  assert.ok(p.actionItems().some(([name, fn]) => name === "做完了" && fn === "doneTodo"));
  await p.doneTodo();
  assert.deepEqual(plain(hits.filter((h) => h[0] === "post").at(-1)), ["post", "/v1/cards/c/close", { version: 2 }]);
  await tick();
  p.openEditor();
  p.data.editor.title = "交作业";
  await p.saveEdit();
  assert.deepEqual(plain(hits.filter((h) => h[0] === "patch").at(-1)[2]), { version: 3, title: "交作业" });
});

test("card page: 下一个 moves to the next question and wraps around", async () => {
  const asks = [
    { kind: "open", key: "q1", text: "先复习哪一章？", cat: "decide" },
    { kind: "open", key: "q2", text: "要不要报竞赛？", cat: "decide" },
  ];
  const { p } = cardPage(
    cardDetail({ kind: "idea", follow: "chat", open: asks.map((a) => ({ key: a.key, text: a.text, cat: a.cat })) }),
  );
  p.onLoad({ id: "c" });
  p.onShow();
  await tick();
  const n = (p.data.detail.asks || []).length;
  assert.ok(n >= 2, `asks: ${n}`);
  assert.equal(p.data.askAt, 0);
  const next = { currentTarget: { dataset: { kind: "open", key: "q1", action: "thinking" } } };
  await p.answer(next);
  assert.equal(p.data.askAt, 1);
  await p.answer(next);
  await p.answer(next);
  assert.equal(p.data.askAt, (3 % n));
});

test("card page: a merged card lists its originals; they open read-only; 拆开 asks first", async () => {
  const { p, hits, f } = cardPage(
    cardDetail({ kind: "idea", follow: "chat", mergedFrom: [{ id: "a", type: "idea", kind: "idea", title: "第一张" }, { id: "b", type: "idea", kind: "idea", title: "第二张" }] }),
  );
  p.onLoad({ id: "c" });
  p.onShow();
  await tick();
  assert.equal(p.data.detail.mergedFrom.length, 2);
  p.openOriginal({ currentTarget: { dataset: { id: "a" } } });
  assert.equal(f.calls.nav.at(-1), "/pages/card/index?id=a&merged=1");
  p.unmerge();
  await tick();
  assert.equal(f.calls.modal.at(-1).title, "拆开这张卡？");
  assert.deepEqual(plain(hits.filter((h) => h[0] === "post").at(-1)), ["post", "/v1/cards/c/unmerge", { version: 2 }]);
  assert.equal(f.calls.nav.at(-1), "back");
  // An original: read with ?merged=1, nothing can be changed there.
  const orig = cardPage(cardDetail({ id: "a", mergedInto: "c" }));
  orig.p.onLoad({ id: "a", merged: "1" });
  orig.p.onShow();
  await tick();
  assert.ok(orig.hits.some((h) => h[1] === "/v1/cards/a?merged=1"));
  assert.equal(orig.p.data.example, true);
});

test("card-pick: linking does not offer the card itself", async () => {
  const f = fakeWx();
  const { p, app } = load("pages/card-pick/index.js", {
    wx: f.wx,
    api: {
      get: async (url) =>
        url === "/v1/tags"
          ? []
          : { data: [{ id: "self", type: "idea", title: "这张" }, { id: "other", type: "idea", title: "那张" }], total: 2 },
    },
  });
  app.globalData.cardPick = { mode: "link", returnTo: "card", sourceId: "self" };
  p.onLoad();
  p.onShow();
  await tick();
  assert.deepEqual(plain(p.data.cards.map((c) => c.id)), ["other"]);
});

test("随心记: the unsaved words stay per account; a retry keeps its clientId; examples only for a new user", async () => {
  const f = fakeWx();
  const posts = [];
  let fail = true;
  const api = {
    get: async () => ({ data: [], total: 0 }),
    post: async (url, body) => {
      posts.push(body);
      if (fail) throw new Error("网络不好");
      return { card: { id: "n1", quote: body.text, scene: "life", kind: "note", follow: "none" } };
    },
  };
  f.storage.set("zhiye_onboarded", "1");
  let { p } = load("pages/notes/index.js", { api, wx: f.wx });
  p.onLoad();
  p.onShow();
  await tick();
  p.onText({ detail: { value: "图书馆三楼有插座" } });
  assert.equal(f.storage.get("zhiye_notes_draft:u1").text, "图书馆三楼有插座");
  await p.save();
  assert.equal(p.data.text, "图书馆三楼有插座");
  const first = posts[0].clientId;
  assert.ok(first && first.length >= 8);
  // Back after a restart: the words and the clientId come back.
  ({ p } = load("pages/notes/index.js", { api, wx: f.wx }));
  p.onLoad();
  p.onShow();
  await tick();
  assert.equal(p.data.text, "图书馆三楼有插座");
  fail = false;
  await p.save();
  assert.equal(posts[1].clientId, first);
  assert.equal(p.data.text, "");
  assert.equal(f.storage.has("zhiye_notes_draft:u1"), false);
  // A 随手记 is not asked about later: no "过几天会问你".
  assert.equal(p.data.firstHint, false);
  p.onUnload();
  // Another account sees its own (empty) box.
  f.storage.set("zhiye_notes_draft:u1", { text: "甲的草稿", clientId: "" });
  ({ p } = load("pages/notes/index.js", { api, wx: f.wx, account: "u2" }));
  p.onLoad();
  p.onShow();
  await tick();
  assert.equal(p.data.text, "");
  // Examples: only while there are no cards and the box is empty.
  assert.match(read("pages/notes/index.wxml"), /wx:if="\{\{cardsLoaded && !allTotal && !text\}\}"/);
  assert.doesNotMatch(read("pages/notes/index.wxml"), /后天/);
});

test("存成卡: typed words go as my own text, a picked line as a quote; system back keeps the wrap draft", async () => {
  const f = fakeWx();
  const posts = [];
  const api = {
    get: async () => ({ id: "c1", version: 4 }),
    post: async (url, body) => {
      posts.push([url, body]);
      return { card: {} };
    },
  };
  let { p, app } = load("pages/collect/index.js", { api, wx: f.wx });
  app.globalData.collect = { mode: "mine", cardId: "c1", quotes: ["先约分再代入"] };
  p.onLoad();
  p.setData({ mine: "先约分再代入" });
  await p.save();
  assert.deepEqual(plain(posts.at(-1)[1]), { version: 4, quote: "先约分再代入" });
  ({ p, app } = load("pages/collect/index.js", { api, wx: f.wx }));
  app.globalData.collect = { mode: "mine", cardId: "c1", quotes: ["先约分再代入"] };
  p.onLoad();
  p.setData({ mine: "约分以后就简单了" });
  await p.save();
  assert.deepEqual(plain(posts.at(-1)[1]), { version: 4, text: "约分以后就简单了" });
  assert.doesNotMatch(read("pages/collect/index.wxml"), /挑一句你说过的/);
  // Wrap: leaving by the system back keeps the edits for next time.
  ({ p, app } = load("pages/collect/index.js", { api, wx: f.wx }));
  app.globalData.collect = {
    mode: "wrap",
    threadId: "t1",
    draft: { id: "d1", cards: [{ key: "a", type: "idea", title: "原标题", selected: true }] },
  };
  p.onLoad();
  p.setData({ mine: "我自己的话" });
  p.onUnload();
  assert.equal(app.globalData.collect.mode, "wrap");
  assert.equal(app.globalData.collect.mine, "我自己的话");
});

test("tags: buttons come back after leaving mid-save; 还没有标签 only after a load", async () => {
  const f = fakeWx();
  let release;
  const { p } = load("pages/tags/index.js", {
    wx: f.wx,
    api: {
      get: (url) =>
        url === "/v1/tags" ? new Promise((r) => (release = r)) : Promise.resolve({ total: 0 }),
    },
  });
  p.onShow();
  assert.equal(p.data.loaded, false);
  assert.match(read("pages/tags/index.wxml"), /wx:if="\{\{loaded&&!tags\.length&&!error\}\}"/);
  release([]);
  await tick();
  assert.equal(p.data.loaded, true);
  p.setData({ busy: true, busyId: "t1" });
  p.onHide();
  p.onShow();
  assert.equal(p.data.busy, false);
  assert.equal(p.data.busyId, "");
});

test("回顾和提醒: the list names what comes back; settings drop the greeting switch; mood-log says 相关记录", () => {
  assert.match(read("pages/resume-list/index.json"), /回顾和提醒/);
  const settings = read("pages/resume-settings/index.wxml");
  assert.doesNotMatch(settings, /打个招呼|还没想完的/);
  assert.match(settings, /回顾和提醒/);
  const mood = read("pages/mood-log/index.wxml");
  assert.match(mood, /相关记录：/);
  assert.doesNotMatch(mood, /删除全部时一起删/);
});
