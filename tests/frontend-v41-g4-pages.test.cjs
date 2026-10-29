"use strict";
// V4.1 G4 : 题库 (pages/bank), 知识点详情 (pages/knowledge, which took
// over the map's detail sheet through utils/point-actions.js), the map's
// narrow cards and the landscape map's zoomed-in detail.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

function put(rel, exports) {
  const modulePath = path.join(root, rel);
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
}
function fresh(rel) {
  const modulePath = path.join(root, rel);
  delete require.cache[modulePath];
  return modulePath;
}

// Shared stubs: who is signed in, what the api returns, where pages go.
function world({ state = "ok", get = () => Promise.resolve({}), post = () => Promise.resolve({}), request, login } = {}) {
  const log = { asks: 0, nav: [], posts: [], gets: [], toasts: [], requests: [] };
  const app = { globalData: {} };
  global.getApp = () => app;
  global.getCurrentPages = () => [];
  global.wx = {
    setNavigationBarTitle() {},
    showToast: (o) => log.toasts.push(o.title),
    navigateTo: (o) => log.nav.push(o.url),
    switchTab: (o) => log.nav.push(o.url),
    pageScrollTo() {},
    getStorageSync: () => null,
  };
  let user = { id: "user-a" };
  put("utils/api.js", {
    get: (url) => (log.gets.push(url), get(url)),
    post: (url, body) => (log.posts.push([url, body]), post(url, body)),
    needsConsent: () => false,
  });
  put("utils/auth.js", {
    getUser: () => user,
    hasConsent: () => state === "ok",
    login: () => (login ? login() : Promise.resolve(user)),
  });
  put("utils/gate.js", {
    state: () => state,
    check: () => true,
    ask: () => {
      log.asks++;
    },
  });
  put("utils/request.js", {
    request: (o) => (log.requests.push(o.url), request ? request(o.url) : Promise.resolve({ data: null })),
  });
  put("utils/format.js", { errorText: (e) => e.message, monthDay: (v) => (v ? "10/9" : "") });
  put("utils/chat-entry.js", {
    openAsk: (o) => log.nav.push(`ask:${o.threadId}`),
    openChat: (o) => log.nav.push(`chat:${o.threadId}`),
  });
  put("utils/study-clock.js", { track: (def) => def });
  put("utils/learn.js", {
    retryText: (e) => e.message,
    backTo: (route, id) => log.nav.push(`${route}:${id || ""}`),
    ROUTES: {
      point: "pages/point/index",
      knowledge: "pages/knowledge/index",
      bank: "pages/bank/index",
    },
  });
  fresh("utils/point-actions.js");
  fresh("utils/bank.js");
  return {
    log,
    app,
    signIn(value) {
      user = value;
    },
  };
}
function page(rel) {
  let def;
  global.Page = (value) => {
    def = value;
  };
  require(fresh(rel));
  def.data = structuredClone(def.data);
  def.setData = function (patch) {
    Object.assign(this.data, patch);
  };
  def.alive = true;
  return def;
}

const BANK = {
  guest: false,
  chapters: [
    {
      id: "limit",
      short: "极限",
      book: "第 1 章",
      label: "第 1 章 极限",
      problems: 5,
      correct: 1,
      points: [
        { id: "a", name: "甲", section: "1.1", tier: "重点", key: true, problems: 3, done: 2, correct: 1, aiPractice: true },
        { id: "b", name: "乙", section: "1.2", tier: "基础", problems: 2, done: 1, correct: 0 },
        { id: "c", name: "丙", section: "1.3", tier: "拓展", line: "side", hard: true, problems: 0 },
      ],
    },
  ],
};

test("bank view: chapters, progress per point; a guest sees counts only", () => {
  world();
  const bank = require(path.join(root, "utils/bank.js"));
  const v = bank.view(BANK);
  assert.deepEqual(v.tabs, [{ id: "limit", short: "极限" }]);
  assert.equal(v.chapters[0].count, "做对 1/5 题");
  const [a, b, c] = v.chapters[0].points;
  assert.deepEqual([a.mark, a.tierCls, a.count, a.progress, a.progressCls, a.ready], ["★", "key", "3 题", "做对 1/3", "ok", true]);
  assert.deepEqual([b.progress, b.progressCls], ["做过 1/2", "tried"]);
  assert.deepEqual([c.mark, c.count, c.ready, c.progress], ["", "题还在出", false, ""]);
  assert.equal(bank.find(v, "b").name, "乙");
  assert.equal(bank.find(v, "zz"), null);
  const g = bank.view({ ...BANK, guest: true });
  assert.equal(g.guest, true);
  assert.equal(g.chapters[0].count, "3 个点 · 5 题");
  assert.equal(g.chapters[0].points[0].progress, "");
});

test("bank page: signed in reads /v1/learn/bank; a tap practises; a guest reads the public copy and is asked", async () => {
  let { log } = world({ get: () => Promise.resolve(BANK) });
  let p = page("pages/bank/index.js");
  p.onLoad({ chapter: "limit" });
  assert.equal(p.data.chapterId, "limit");
  await p.load();
  assert.deepEqual(log.gets, ["/v1/learn/bank"]);
  assert.equal(p.data.chapters[0].points.length, 3);
  p.pick({ detail: { id: "c", ready: false } });
  assert.deepEqual(log.toasts, ["题还在出，稍等"]);
  p.pick({ detail: { id: "a", ready: true } });
  assert.deepEqual(log.nav, ["pages/point/index:a"]);

  ({ log } = world({ state: "guest", request: () => Promise.resolve({ data: { ...BANK, guest: true } }) }));
  p = page("pages/bank/index.js");
  await p.load();
  assert.deepEqual(log.requests, ["/v1/learn/bank/public"]);
  assert.equal(log.gets.length, 0);
  assert.equal(p.data.guest, true);
  p.pick({ detail: { id: "a", ready: true } });
  assert.equal(log.asks, 1);
  assert.deepEqual(log.nav, []);
});

function detail(extra = {}) {
  return {
    id: "derivative-chain",
    name: "链式法则",
    short: "链式法则",
    section: "2.3",
    tier: "重点",
    key: true,
    line: "main",
    level: 2,
    chapter: { id: "derivative", short: "导数", book: "第 2 章" },
    state: "self",
    stateReason: { kind: "self" },
    why: "为什么",
    intro: [{ type: "text", text: "讲解" }],
    formulas: [{ blocks: [{ type: "text", text: "f" }], tex: "f", noteBlocks: null }],
    keys: [1, 2, 3].map((n) => ({ blocks: [{ type: "text", text: `k${n}` }] })),
    example: {
      problem: {
        blocks: [],
        format: "choice",
        questions: [{ blocks: [], options: ["A", "B"].map((id) => ({ id, blocks: [] })) }],
      },
      solution: { correct: { options: ["B"], blocks: [] }, explanation: [] },
    },
    prereqs: [{ id: "derivative-def", name: "导数定义", chapterId: "derivative", state: "none" }],
    followers: [{ id: "implicit", name: "隐函数", chapterId: "other", state: "correct" }],
    exam: "必考",
    ready: true,
    bank: { problems: 4, done: 1, correct: 1 },
    retest: { dueOn: "2026-10-09", cause: "hint", mode: false },
    cards: { count: 1, items: [{ id: "c1", type: "method", title: "卡" }] },
    mistakeCount: 2,
    taught: true,
    stuck: false,
    ...extra,
  };
}

test("knowledge view: the old sheet's details, the star's look and the example", () => {
  world();
  global.Page = () => {};
  const { view, lookOf, stateLine } = require(fresh("pages/knowledge/index.js"));
  const v = view(detail());
  assert.deepEqual([v.mark, v.tierCls, v.chapter, v.look, v.lookText], ["★", "key", "第 2 章 导数", "pend", "标了会"]);
  assert.equal(v.stateLine, "你说过会了");
  assert.equal(v.lineText, "核心点");
  assert.equal(v.difficulty, "●●○");
  assert.equal(v.missing, 1);
  assert.deepEqual([v.prereqs[0].done, v.followers[0].done, v.followers[0].cross], [false, true, true]);
  assert.equal(v.retestText, "10/9 · 上次看了提示");
  assert.deepEqual([v.mistakeCount, v.cardCount, v.cardItems[0].typeName], [2, 1, "思路"]);
  assert.deepEqual([v.ready, v.bankText, v.self], [true, "4 道题 · 做对 1", true]);
  assert.deepEqual(v.keys.map((k) => k.cls), ["k1", "k2", "k3"]);
  assert.equal(v.example.choice, true);
  assert.deepEqual(v.example.questions[0].options.map((o) => o.right), [false, true]);
  // A guest: no progress or personal details.
  const g = view(detail({ guest: true, state: "correct" }));
  assert.deepEqual([g.look, g.stateLine, g.missing, g.prereqs[0].done, g.bankText], ["none", "", 0, false, "4 道题"]);
  // due and stuck are the present and win over 做对了.
  assert.equal(lookOf({ state: "due" }).cls, "due");
  assert.equal(lookOf({ state: "correct", stuck: true }).cls, "stuck");
  assert.equal(lookOf({ state: "none", stuckAt: "x" }).cls, "stuck");
  assert.equal(stateLine({ kind: "inferred", by: { name: "甲" } }), "你做对了「甲」，这个应该也会");
  assert.equal(view(detail({ ready: false })).ready, false);
  assert.equal(view(detail({ bank: { problems: 0 } })).ready, false);
});

test("knowledge page: 练一题, neighbours, 问一问 / 讲一遍, marks, cards and mistakes", async () => {
  const { log, app } = world({
    get: () => Promise.resolve(detail()),
    post: (url) => Promise.resolve(url === "/v1/chat/threads" ? { thread: { id: "t9" } } : {}),
  });
  const p = page("pages/knowledge/index.js");
  p.onLoad({ id: "derivative-chain" });
  await p.load();
  assert.deepEqual(log.gets, ["/v1/learn/points/derivative-chain/detail?tone=light"]);
  p.practise();
  assert.equal(app.globalData.practiseFresh, "derivative-chain", "a practice page in the stack moves on");
  // A quick second tap opens nothing more.
  p.openLinked({ currentTarget: { dataset: { id: "derivative-def" } } });
  assert.deepEqual(log.nav, ["pages/point/index:derivative-chain"]);
  p.lastTapAt = 0;
  p.openLinked({ currentTarget: { dataset: { id: "derivative-def" } } });
  p.lastTapAt = 0;
  p.openLinked({ currentTarget: { dataset: { id: "derivative-chain" } } });
  assert.deepEqual(log.nav, ["pages/point/index:derivative-chain", "pages/knowledge/index:derivative-def"]);

  await p.askAI();
  await p.teachAI();
  const threads = log.posts.filter(([u]) => u === "/v1/chat/threads").map(([, b]) => b);
  // 讲一遍 opens its own page on the point; the chat is made there.
  assert.deepEqual(threads, [{ mode: "guide", pointId: "derivative-chain", tone: "light", origin: "solve" }]);
  assert.deepEqual(log.nav.slice(-2), ["ask:t9", `/pages/teach/index?pointId=derivative-chain&name=${encodeURIComponent("链式法则")}`]);

  await p.toggleSelf();
  assert.deepEqual(log.posts.at(-1), ["/v1/learn/marks", { action: "unself", pointId: "derivative-chain" }]);
  assert.equal(log.gets.length, 2, "read again after the mark");

  p.collectCard();
  assert.equal(app.globalData.collect.pointId, "derivative-chain");
  p.openCards();
  assert.deepEqual(app.globalData.cardFilter, { pointId: "derivative-chain", pointName: "链式法则" });
  p.openMistakes();
  p.openCard({ currentTarget: { dataset: { id: "c1" } } });
  assert.deepEqual(log.nav.slice(-4), [
    "/pages/collect/index",
    "/pages/deck/index",
    "/pages/mistakes/index?pointId=derivative-chain",
    "/pages/card/index?id=c1",
  ]);
});

test("knowledge page: 卡住了 sheet sends the step and names the suggested point; 现在懂了 clears", async () => {
  let stuck = false;
  const { log } = world({
    get: () => Promise.resolve(detail({ stuck })),
    post: (url) =>
      Promise.resolve(
        url.endsWith("/stuck") ? { question: "哪一步？", options: ["a", "b"], suggest: "derivative-def" } : {},
      ),
  });
  const p = page("pages/knowledge/index.js");
  p.onLoad({ id: "derivative-chain" });
  await p.load();
  p.openStuck();
  assert.equal(p.data.stuckOpen, true);
  assert.equal(log.posts.length, 0, "nothing marked until sent");
  p.chooseStuck({ currentTarget: { dataset: { text: "不知道第一步" } } });
  await p.sendStuck();
  assert.deepEqual(log.posts[0], ["/v1/learn/points/derivative-chain/stuck", { text: "不知道第一步" }]);
  assert.equal(p.data.stuckSuggestName, "导数定义");
  p.stuckSuggest();
  assert.equal(p.data.stuckOpen, false);
  assert.equal(log.nav.at(-1), "pages/knowledge/index:derivative-def");

  stuck = true;
  await p.load();
  assert.equal(p.data.point.stuck, true);
  // on a stuck point the button reopens the help (closing it is not
  // 懂了); 现在懂了 is a button of its own.
  const before = log.posts.length;
  await p.openStuck();
  assert.equal(p.data.stuckOpen, true);
  assert.equal(log.posts.length, before, "opening marks nothing");
  await p.understood();
  assert.deepEqual(log.posts.at(-1), ["/v1/learn/marks", { action: "unstuck", pointId: "derivative-chain" }]);
});

test("knowledge page as a guest: the public copy; everything personal asks first", async () => {
  const { log } = world({
    state: "guest",
    request: () => Promise.resolve({ data: detail({ guest: true }) }),
  });
  const p = page("pages/knowledge/index.js");
  p.onLoad({ id: "derivative-chain" });
  await p.load();
  assert.deepEqual(log.requests, ["/v1/learn/points/derivative-chain/detail/public?tone=light"]);
  assert.equal(p.data.guest, true);
  p.practise();
  await p.askAI();
  await p.teachAI();
  await p.toggleSelf();
  p.collectCard();
  p.openStuck();
  assert.equal(log.asks, 6);
  assert.equal(log.posts.length, 0);
  assert.deepEqual(log.nav, []);
  p.openLinked({ currentTarget: { dataset: { id: "implicit" } } });
  assert.deepEqual(log.nav, ["pages/knowledge/index:implicit"], "reading on needs no consent");
});

test("knowledge template: AI line on top, sections in order, 练一题 at the bottom", () => {
  const wxml = read("pages/knowledge/index.wxml");
  const first = wxml.indexOf("<view", wxml.indexOf("kn-page") + 1);
  assert.match(wxml.slice(first, first + 80), /class="ai-line"/);
  const order = ["为什么要学", "讲解", "公式", "要点", "讲解中的例题", "先学"].map((w) => wxml.indexOf(`>${w}<`));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), String(order));
  assert.match(wxml, /bindtap="practise"/);
  assert.match(wxml, /bindtap="askAI"/);
  assert.match(wxml, /bindtap="teachAI"/);
  const json = JSON.parse(read("pages/knowledge/index.json"));
  assert.equal(json.navigationBarTitleText, "知识点");
});

test("new pages are routed and registered; new text has no banned words or model names", () => {
  const app = JSON.parse(read("app.json"));
  for (const p of ["pages/bank/index", "pages/knowledge/index"]) assert.ok(app.pages.includes(p), p);
  const learn = read("utils/learn.js");
  assert.match(learn, /bank: "pages\/bank\/index"/);
  assert.match(learn, /knowledge: "pages\/knowledge\/index"/);
  const BANNED = ["心理咨询", "心理治疗", "心理医生", "疗愈", "治疗", "诊断", "陪伴", "陪着你", "恋人", "伴侣", "我一直记着你", "我在等你"];
  const MODEL = /jev|glm|智谱|混元|火山|豆包|typesafe|bigmodel|deepseek|qwen|通义|文心|kimi|gpt|claude|openai|anthropic|\bflash\b/i;
  for (const rel of [
    "pages/bank/index.wxml",
    "pages/commercial/center/index.wxml",
    "pages/commercial/orders/index.wxml",
    "pages/commercial/order/index.wxml",
    "pages/support/chat/index.wxml",
    "pages/support/tickets/index.wxml",
    "pages/support/ticket/index.wxml",
    "pages/knowledge/index.wxml",
    "pages/point/index.wxml",
    "components/numpad/index.wxml",
    "components/point-list/index.wxml",
    "pages/map/components/sky/index.wxml",
    "pages/map/components/stage/index.wxml",
    "pages/commercial/center/index.js",
    "pages/support/chat/index.js",
    "pages/support/ticket/index.js",
    "pages/support/tickets/index.js",
    "pages/support/support-api.js",
    "pages/help/index.js",
    "pages/help/index.wxml",
  ]) {
    const text = read(rel);
    for (const w of BANNED) assert.ok(!text.includes(w), `${rel}: ${w}`);
    assert.doesNotMatch(text, MODEL, rel);
  }
});

test("map cards: a narrow card says 没碰过 and drops 我的卡", () => {
  global.wx = global.wx || {};
  const stars = require(fresh("pages/map/stars.js"));
  const at = (x) => ({ pos: { x, y: 10 } });
  const a = at(0);
  assert.equal(stars.cardBox(a, [a, at(140 / stars.S)], false).narrow, true);
  assert.equal(stars.cardBox(a, [a, at(200 / stars.S)], false).narrow, false);
  const sky = read("pages/map/components/sky/index.wxml");
  assert.match(sky, /narrow/);
});

test("landscape: zoomed past 0.9 the stage shows formula and key; a tap opens the detail page", () => {
  const { log } = world();
  put("pages/map/layout.js", {
    taskLayout: () => ({}),
    anchorMotion: (before, after, d) => d,
    relationLayout: () => ({}),
  });
  const p = page("pages/map/landscape/index.js");
  p.data.chapter = { points: [{ id: "a" }] };
  p.stageSettle({ detail: { tx: 0, ty: 0, s: 0.5 } });
  assert.equal(p.data.detail, false);
  p.stageSettle({ detail: { tx: 0, ty: 0, s: 1.2 } });
  assert.equal(p.data.detail, true);
  p.openNode("a");
  p.openNode("zz");
  assert.deepEqual(log.nav, ["pages/knowledge/index:a"]);
  const stage = read("pages/map/components/stage/index.wxml");
  assert.match(stage, /lx-fx/);
  assert.match(stage, /lx-key/);
  delete require.cache[path.join(root, "pages/map/layout.js")];
});

test("bank page: a list asked for by one account is not shown to the next", async () => {
  let release;
  const { signIn } = world({
    get: () => new Promise((resolve) => (release = () => resolve(BANK))),
  });
  const p = page("pages/bank/index.js");
  const loading = p.load();
  await new Promise((r) => setImmediate(r));
  signIn({ id: "user-b" });
  release();
  await loading;
  assert.deepEqual(p.data.chapters, [], "user-a's progress stays off user-b's screen");
});

test("knowledge page: a failed sign-in shows the error and stops loading", async () => {
  world({ login: () => Promise.reject(Object.assign(new Error("登录失败"), { statusCode: 500 })) });
  const p = page("pages/knowledge/index.js");
  p.onLoad({ id: "derivative-chain" });
  await p.load();
  assert.equal(p.data.error, "登录失败");
  assert.equal(p.data.loading, false);
});

test("landscape: back on the page, the map is read again in place", async () => {
  let state = "none";
  const map = () => ({
    chapters: [
      {
        id: "limit",
        short: "极限",
        points: [{ id: "a", state }],
      },
    ],
  });
  const { log } = world({ get: () => Promise.resolve(map()) });
  const layouts = [];
  put("pages/map/layout.js", {
    taskLayout: (chapter, expandedId) => (layouts.push([chapter.points[0].state, expandedId]), { nodes: [] }),
    relationLayout: () => ({}),
  });
  const p = page("pages/map/landscape/index.js");
  const flush = () => new Promise((r) => setTimeout(r, 0));
  p.onLoad({ id: "limit" });
  await flush();
  assert.equal(log.gets.length, 1);
  p.onShow(); // the first show follows onLoad's read
  assert.equal(log.gets.length, 1);
  p.setData({ expandedId: "g1", motion: "1,2,1,9" });
  state = "correct";
  p.onShow();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setImmediate(r));
  assert.equal(log.gets.length, 2);
  assert.equal(p.data.chapter.points[0].state, "correct");
  assert.deepEqual(layouts.at(-1), ["correct", "g1"], "the open group stays open");
  assert.equal(p.data.motion, "1,2,1,9", "the view stays");
  assert.equal(p.data.loading, false);
  delete require.cache[path.join(root, "pages/map/layout.js")];
});
