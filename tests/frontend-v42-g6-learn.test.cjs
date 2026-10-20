"use strict";
// 学习页面回归：各页对知识点状态的解释保持一致，视图转换共用 utils/point-look.js。
// 覆盖数字键盘、卡点求助、错题及既有学习流程。
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

test("point look: the present wins over the record; seen and practice are not 没碰过", () => {
  const { lookOf } = require(fresh("utils/point-look.js"));
  const key = (p) => lookOf(p).key;
  assert.equal(key({ state: "none" }), "none");
  assert.equal(key({ state: "seen" }), "seen");
  assert.equal(lookOf({ state: "seen" }).text, "看过");
  assert.equal(key({ state: "practice" }), "practice");
  assert.equal(lookOf({ state: "practice" }).text, "练过");
  assert.equal(key({ state: "self" }), "self");
  assert.equal(key({ state: "none", inferredBy: { id: "a" } }), "inferred");
  assert.equal(key({ state: "correct" }), "correct");
  // 卡住了 after 做对了 (help asked on a point once done) shows 卡住了.
  assert.equal(key({ state: "correct", stuck: true, stuckAt: "2026-10-18" }), "stuck");
  assert.equal(key({ state: "due", stuckAt: "2026-10-18" }), "stuck");
  // A due review is not 做对了.
  assert.equal(key({ state: "due" }), "due");
  assert.equal(lookOf({ state: "due" }).text, "该复习");
  // A wrong answer on a point once done opens a retest: 再试试, not gold.
  assert.equal(key({ state: "correct", retest: { mode: false } }), "retest");
  assert.equal(key({ state: "seen", retest: { mode: true } }), "retest");
  assert.equal(key({ state: "seen", retest: { mode: false } }), "seen");
  // The chapter grid has a class for each.
  const wxss = read("app.wxss");
  for (const cell of ["seen", "practice", "self", "inferred", "correct", "retest", "due", "stuck"])
    assert.match(wxss, new RegExp(`\\.map-cell\\.${cell}\\b`), cell);
});

test("star map: seen and practice have their own look, 下一步 is a mark on top of the state", () => {
  global.wx = {};
  const stars = require(fresh("pages/map/stars.js"));
  const point = (id, extra) => ({ id, name: id, short: id, line: "main", prereqs: [], state: "none", pos: { x: 40 + id.length * 90, y: 60 }, ...extra });
  const layout = stars.starLayout(
    {
      canvas: { width: 375, height: 400 },
      points: [
        point("a", { state: "seen" }),
        point("bb", { state: "practice" }),
        point("ccc", { state: "correct", stuck: true, stuckAt: "x" }),
      ],
      lines: [],
    },
    { nextId: "ccc" },
  );
  const byId = Object.fromEntries(layout.stars.map((s) => [s.id, s]));
  assert.equal(byId.a.cls, "seen");
  assert.equal(byId.bb.cls, "practice");
  assert.equal(byId.ccc.cls, "stuck", "下一步 does not hide 卡住了");
  assert.equal(byId.ccc.next, true);
  const cards = Object.fromEntries(layout.cards.map((c) => [c.id, c]));
  assert.equal(cards.a.stateText, "看过");
  assert.equal(cards.bb.stateText, "练过");
  assert.equal(cards.ccc.stateText, "卡住了");
  assert.equal(cards.ccc.next, true);
  const sky = read("pages/map/components/sky/index.wxml");
  assert.match(sky, /item\.next\?'is-next':''/);
  assert.doesNotMatch(sky, /wx:if="\{\{!item\.next\}\}" class="st/, "the state shows on the 下一步 card too");
  // Untouched cards keep their text clear: no whole-card dimming.
  const css = read("pages/map/components/sky/index.wxss");
  assert.doesNotMatch(css, /\.kc\.none, \.kc\.side \{ opacity/);
  assert.doesNotMatch(css, /\.sn\.later \{ opacity/);
});

test("map: the line without a 下一步 says why; 核心点, not 期末要考", () => {
  global.Page = () => {};
  global.getApp = () => ({ globalData: {} });
  global.wx = { getSystemInfoSync: () => ({}), getStorageSync: () => null };
  put("utils/study-clock.js", { track: (def) => def });
  const { noNextText } = require(fresh("pages/map/index.js"));
  const ch = (points) => ({ points });
  assert.match(noNextText(ch([{ state: "correct", taught: true }]), "1.1"), /都做对了/);
  assert.match(noNextText(ch([{ state: "none", taught: false }]), "1.1"), /还没讲到/);
  assert.match(noNextText(ch([{ state: "none", taught: true }]), "none"), /还没讲到/);
  assert.match(
    noNextText(ch([{ state: "due", taught: true }, { state: "none", taught: false }]), "1.1"),
    /讲到的都做对了/,
  );
  assert.equal(noNextText(ch([{ state: "seen", taught: true }]), "all"), "暂时没有推荐，点任意一颗星看看");
  assert.doesNotMatch(read("pages/map/index.wxml"), /期末要考/);
  assert.match(read("pages/map/index.wxml"), /lg seen/);
  assert.match(read("pages/map/index.wxml"), /核心点做对/);
});

// ---- 错题本 -----------------------------------------------------------------
function mistakesPage(api, store = new Map(), asked = []) {
  let def;
  global.Page = (value) => {
    def = value;
  };
  global.wx = {
    getStorageSync: (k) => store.get(k),
    setStorageSync: (k, v) => store.set(k, v),
    removeStorageSync: (k) => store.delete(k),
    showToast() {},
    showActionSheet() {},
    stopPullDownRefresh() {},
  };
  put("utils/api.js", { needsConsent: () => false, jobMessage: () => "", waitJob: () => Promise.resolve(), ...api });
  put("utils/auth.js", { getUser: () => ({ id: "u1" }) });
  put("utils/stream.js", { clientId: () => "c1" });
  put("utils/format.js", { errorText: (e) => e.message, dueText: () => "明天", sourceOf: () => ({ text: "" }) });
  put("utils/gate.js", { check: () => true, state: () => "ok" });
  put("utils/study-clock.js", { track: (d) => d });
  put("utils/learn.js", { backTo() {}, ROUTES: {} });
  put("utils/chat-entry.js", { openAsk: (o) => asked.push(o) });
  require(fresh("pages/mistakes/index.js"));
  def.data = structuredClone(def.data);
  def.setData = (patch) => {
    for (const [k, v] of Object.entries(patch)) {
      const parts = k.split(".");
      let t = def.data;
      for (const p of parts.slice(0, -1)) t = t[p];
      t[parts.at(-1)] = v;
    }
  };
  def.alive = true;
  return def;
}
const COUNTS = { open: 3, due: 0, mastered: 2, chapters: [{ chapter: "limit", label: "函数与极限", n: 2 }, { chapter: "other", label: "其他", n: 1 }] };
const entry = (id, extra = {}) => ({ id, materialId: id, status: "open", wrong: 1, due: false, dueOn: "2026-10-19", source: "judge", threadId: "t-" + id, ...extra });

test("错题本: pages from the server, the chapter filter is asked of the server", async () => {
  const urls = [];
  const page = mistakesPage({
    get: (url) => {
      urls.push(url);
      const offset = Number(/offset=(\d+)/.exec(url)[1]);
      return Promise.resolve(
        offset === 0
          ? { items: [entry("a"), entry("b")], counts: COUNTS, more: true }
          : { items: [entry("b"), entry("c")], counts: COUNTS, more: false },
      );
    },
  });
  await page.load();
  assert.match(urls[0], /status=open&tone=light&limit=50&offset=0$/);
  assert.equal(page.data.more, true);
  await page.loadMore();
  assert.match(urls[1], /offset=2$/);
  assert.deepEqual(page.data.items.map((i) => i.id), ["a", "b", "c"], "no repeats across pages");
  assert.equal(page.data.more, false);
  await page.setChapter({ currentTarget: { dataset: { chapter: "limit" } } });
  assert.match(urls.at(-1), /&chapter=limit&limit=50&offset=0$/);
  // An old server ignores the paging and sends no `more`.
  const old = mistakesPage({ get: () => Promise.resolve({ items: [entry("a")], counts: COUNTS }) });
  await old.load();
  assert.equal(old.data.more, false);
  const wxml = read("pages/mistakes/index.wxml");
  assert.match(wxml, /bindtap="loadMore"/);
  assert.match(read("pages/mistakes/index.js"), /onReachBottom\(\)/);
});

test("错题本: 标了会 is not 重做对了; filed by hand says so; the copy claims no redo", () => {
  const page = mistakesPage({ get: () => Promise.resolve({ items: [], counts: COUNTS }) });
  const asked = [];
  const again = mistakesPage({ get: () => Promise.resolve({ items: [], counts: COUNTS }) }, new Map(), asked);
  again.setData({ items: [{ ...entry("g", { source: "grade" }), redoText: "重写过程" }] });
  again.redo({ currentTarget: { dataset: { id: "g" } } });
  assert.deepEqual(asked, [{ threadId: "t-g" }], "a worked solution is redone in its conversation");
  assert.equal(again.data.redo, null);
  void page;
  const wxml = read("pages/mistakes/index.wxml");
  assert.doesNotMatch(wxml, /错题都重做对了|重做对的题会放在这儿/);
  assert.match(wxml, /自己收进来的/);
  assert.match(wxml, /catchtap="explain"[^>]*>看讲解</);
  const js = read("pages/mistakes/index.js");
  assert.match(js, /self: "标了会", redo: "重做对了"/);
});

test("错题本: a failed redo keeps the answer and says so in place; a taken one is read again, not sent twice", async () => {
  const posts = [];
  let fail = true;
  const store = new Map([["mistake-redo:a:u1", "1/2"]]);
  const page = mistakesPage(
    {
      get: (url) => {
        if (url.startsWith("/v1/chat/messages/")) {
          if (fail) return Promise.reject(new Error("网络不太好"));
          return Promise.resolve({ attempt: { result: { verdict: "correct", reference: null, cause: null } }, blocks: [] });
        }
        if (url.startsWith("/v1/chat/threads/")) return Promise.resolve({ thread: {} });
        return Promise.resolve({ items: [entry("a", { masteredBy: null })], counts: COUNTS, more: false });
      },
      post: (url, body) => {
        posts.push([url, body]);
        return Promise.resolve({ judge: { id: "j1", job: { id: "job1" } } });
      },
    },
    store,
  );
  await page.load();
  page.redo({ currentTarget: { dataset: { id: "a" } } });
  assert.equal(page.data.redo.answer, "1/2", "the unsent answer came back");
  page.onAnswer({ detail: { value: "1/3" } });
  assert.equal(store.get("mistake-redo:a:u1"), "1/3");
  page.submitRedo();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(page.data.redo, "the box stays open");
  assert.equal(page.data.redo.answer, "1/3");
  assert.equal(page.data.redo.error, "网络不太好");
  assert.equal(page.data.redo.judgeId, "j1");
  fail = false;
  page.submitRedo();
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(posts.length, 1, "the same answer is not judged twice");
  assert.equal(page.data.redo.verdict.correct, true);
  assert.equal(store.has("mistake-redo:a:u1"), false, "the draft goes once judged");
});

// ---- 卡点 help on the detail page --------------------------------------------
function knowledgeWorld({ get, post }) {
  const log = { posts: [], gets: [], nav: [] };
  const storage = new Map();
  global.getApp = () => ({ globalData: {} });
  global.getCurrentPages = () => [];
  global.wx = {
    setNavigationBarTitle() {},
    showToast() {},
    navigateTo: (o) => log.nav.push(o.url),
    switchTab() {},
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
  };
  put("utils/api.js", {
    get: (url) => (log.gets.push(url), get(url)),
    post: (url, body, opts) => (log.posts.push([url, body, opts]), post(url, body)),
    needsConsent: () => false,
  });
  put("utils/auth.js", { getUser: () => ({ id: "u1" }), hasConsent: () => true, login: () => Promise.resolve({ id: "u1" }) });
  put("utils/gate.js", { state: () => "ok", check: () => true, ask() {} });
  put("utils/request.js", { request: () => Promise.resolve({ data: null }) });
  put("utils/format.js", { errorText: (e) => e.message, monthDay: () => "10/9" });
  put("utils/chat-entry.js", { openAsk: (o) => log.nav.push(`ask:${o.threadId}`) });
  put("utils/study-clock.js", { track: (def) => def });
  put("utils/learn.js", { retryText: (e) => e.message, backTo: (r, id) => log.nav.push(`${r}:${id}`), ROUTES: {} });
  fresh("utils/point-actions.js");
  let def;
  global.Page = (value) => {
    def = value;
  };
  require(fresh("pages/knowledge/index.js"));
  def.data = structuredClone(def.data);
  def.setData = (patch) => Object.assign(def.data, patch);
  return { page: def, log, storage };
}
const kpDetail = (extra = {}) => ({
  id: "limit-1-to-inf",
  name: "1^∞ 型极限",
  short: "1^∞ 型",
  section: "1.7",
  tier: "重点",
  line: "main",
  chapter: { id: "limit", short: "极限", book: "第 1 章" },
  state: "none",
  prereqs: [{ id: "limit-equivalent", name: "等价无穷小", state: "none" }],
  followers: [],
  ready: true,
  bank: { problems: 3 },
  example: { problem: { blocks: [], format: "blanks", blanks: [], index: 2, total: 3 }, solution: { correct: { blocks: [] } } },
  ...extra,
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

test("卡点: a reply that comes after the page gave up is read again; closing keeps it, it is not 懂了", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let help = { help: { text: "不知道怎么化", at: "2026-10-12T01:00:00.000Z", status: "running", reply: null } };
  const lost = Object.assign(new Error("网络不太好"), { code: "NETWORK" });
  const { page, log } = knowledgeWorld({
    get: (url) => Promise.resolve(url.endsWith("/stuck") ? help : kpDetail()),
    post: (url) => (url.endsWith("/stuck") ? Promise.reject(lost) : Promise.resolve({})),
  });
  page.onLoad({ id: "limit-1-to-inf" });
  page.alive = true;
  await page.load();
  page.openStuck();
  page.chooseStuck({ currentTarget: { dataset: { text: "条件没分清" } } });
  assert.deepEqual(page.data.stuckOptions, ["概念没懂", "条件没分清", "这一步不明白"]);
  const sent = page.sendStuck();
  assert.equal(page.data.stuckBusy, true);
  assert.equal(log.posts[0][2].timeout, 130000, "waits as long as the server may think");
  t.mock.timers.tick(3000);
  assert.equal(page.data.stuckWait, 3, "the seconds show while waiting");
  await sent;
  await flush();
  // The POST was lost: the page reads the kept help, still running.
  assert.ok(log.gets.some((u) => u.endsWith("/limit-1-to-inf/stuck")));
  assert.equal(page.data.stuckBusy, true);
  help = { help: { ...help.help, status: "ready", reply: { crisis: false, quote: null, hint: "先写成 e 的指数", ask: "指数部分会求吗？", options: ["会", "不会"], suggest: "limit-equivalent" } } };
  t.mock.timers.tick(4000);
  await flush();
  assert.equal(page.data.stuckBusy, false);
  assert.equal(page.data.stuckReply.hint, "先写成 e 的指数");
  assert.equal(page.data.stuckSuggestName, "等价无穷小");
  // Closing hides the sheet only; no 懂了 is sent and the reply stays.
  const posts = log.posts.length;
  page.closeStuck();
  assert.equal(page.data.stuckOpen, false);
  assert.ok(page.data.stuckReply);
  assert.equal(log.posts.length, posts);
  page.openStuck();
  assert.equal(page.data.stuckOpen, true);
  assert.equal(page.data.stuckReply.ask, "指数部分会求吗？");
  page.onUnload();
});

test("卡点: coming back to a stuck point shows the kept help; 接着聊 carries the whole 卡点 into one conversation", async () => {
  const reply = { crisis: false, quote: null, hint: "先写成 e 的指数", ask: "指数部分会求吗？", options: ["会", "不会"], suggest: null };
  const { page, log } = knowledgeWorld({
    get: (url) =>
      Promise.resolve(
        url.endsWith("/stuck")
          ? { help: { text: "不知道怎么化", at: "x", status: "ready", reply } }
          : kpDetail({ state: "stuck", stuck: true, stuckAt: "x" }),
      ),
    post: (url) => Promise.resolve(url === "/v1/chat/threads" ? { thread: { id: "th1" } } : {}),
  });
  page.onLoad({ id: "limit-1-to-inf" });
  page.alive = true;
  await page.load();
  await flush();
  assert.deepEqual(page.data.stuckReply, reply, "read back without opening anything");
  assert.equal(page.data.stuckOpen, false);
  await page.stuckOption({ currentTarget: { dataset: { text: "不会" } } });
  const [url, body] = log.posts.find(([u]) => u === "/v1/chat/threads");
  assert.equal(url, "/v1/chat/threads");
  assert.equal(body.mode, "guide");
  assert.equal(
    body.text,
    "我在「1^∞ 型极限」卡住了：不知道怎么化\n小狸的提示：先写成 e 的指数\n小狸问：指数部分会求吗？\n我的回答：不会",
  );
  assert.equal(log.nav.at(-1), "ask:th1");
  // 接着聊 again: the same conversation, not a new one.
  await page.continueStuck();
  assert.equal(log.posts.filter(([u]) => u === "/v1/chat/threads").length, 1);
  assert.equal(log.nav.at(-1), "ask:th1");
  const wxml = read("pages/knowledge/index.wxml");
  assert.match(wxml, /bindtap="understood">现在懂了</);
  assert.match(wxml, />接着解决卡点</);
  assert.doesNotMatch(wxml, /你说「/, "no forced restating");
  assert.match(wxml, /小狸在想… \{\{stuckWait\}\} 秒/);
});

test("knowledge: 我会了 is not offered on a point already done; reading a while counts as 看过; the example says it is a practice problem", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { page, log } = knowledgeWorld({
    get: () => Promise.resolve(kpDetail()),
    post: () => Promise.resolve({}),
  });
  page.onLoad({ id: "limit-1-to-inf" });
  page.alive = true;
  await page.load();
  assert.equal(page.data.point.canSelf, true);
  assert.equal(page.data.point.example.bankNo, 3);
  assert.equal(log.posts.length, 0);
  t.mock.timers.tick(8000);
  assert.deepEqual(log.posts[0].slice(0, 2), ["/v1/learn/marks", { action: "seen", pointId: "limit-1-to-inf" }]);
  const done = knowledgeWorld({ get: () => Promise.resolve(kpDetail({ state: "correct" })), post: () => Promise.resolve({}) });
  done.page.onLoad({ id: "limit-1-to-inf" });
  done.page.alive = true;
  await done.page.load();
  assert.equal(done.page.data.point.canSelf, false);
  t.mock.timers.tick(8000);
  assert.equal(done.log.posts.length, 0, "a point already done is not marked 看过");
  assert.match(read("pages/knowledge/index.wxml"), /point\.canSelf\|\|point\.self/);
  page.onUnload();
});

// ---- 练一题: half-filled answers, one problem from the 题库 ------------------
function pointWorld({ get, post, store }) {
  let def;
  const nav = [];
  global.Page = (value) => {
    def = value;
  };
  global.getApp = () => ({ globalData: {} });
  global.getCurrentPages = () => [];
  global.wx = {
    setNavigationBarTitle() {},
    showToast() {},
    showModal() {},
    navigateTo: (o) => nav.push(o.url),
    navigateBack() {},
    redirectTo() {},
    showActionSheet() {},
    pageScrollTo() {},
    getStorageSync: (k) => store.get(k),
    setStorageSync: (k, v) => store.set(k, structuredClone(v)),
    removeStorageSync: (k) => store.delete(k),
  };
  put("utils/api.js", { needsConsent: () => false, get, post });
  put("utils/auth.js", { getUser: () => ({ id: "u1" }), hasConsent: () => true, login: () => Promise.resolve({ id: "u1" }), signedIn: () => true });
  put("utils/gate.js", { check: () => true, state: () => "ok", ask() {} });
  put("utils/study-clock.js", { track: (d) => d });
  put("utils/format.js", { errorText: (e) => e.message || "失败", monthDay: () => "" });
  put("utils/stream.js", { clientId: () => "c1" });
  put("utils/chat-entry.js", { openAsk() {}, openChat() {} });
  fresh("utils/learning-space.js");
  put("utils/learn.js", {
    TIER_CLS: { 重点: "key" },
    STATE_TEXT: {},
    RANK_LINES: {},
    stampOf: () => "start",
    retryText: (e) => e.message,
    moment: () => ({ levelUp: null, rankUp: null, book: null }),
    tierCells: () => [],
    tierCount: () => "",
    sheetCount: () => "",
    verdictText: (r) => (r.verdict === "correct" ? "做对了" : "不对"),
    backTo: (route, id) => nav.push([route, id]),
    ROUTES: { knowledge: "pages/knowledge/index", bank: "pages/bank/index", learn: "pages/learn/index", point: "pages/point/index" },
  });
  require(fresh("pages/point/index.js"));
  def.data = structuredClone(def.data);
  def.setData = (patch) => {
    for (const [k, v] of Object.entries(patch)) {
      const parts = k.split(".");
      let t = def.data;
      for (const p of parts.slice(0, -1)) t = t[p] = t[p] || {};
      t[parts.at(-1)] = v;
    }
  };
  return { page: def, nav };
}
const BLANKS = (index) => ({
  mode: "practice",
  problem: { index, total: 3, blocks: [{ type: "text", text: `第 ${index} 题` }], hasHint: false, format: "blanks", blanks: [{ label: "a", note: "" }, { label: "b", note: "" }] },
  tries: 0,
  correct: false,
  aiPractice: false,
});
const POINT = { id: "limit-equivalent", name: "等价无穷小替换", section: "1.7", tier: "重点", xp: 20, chapter: { id: "limit", short: "极限", book: "第 1 章" }, prereqs: [], state: "none", self: false, correct: false, review: false, practice: false, red: false, retest: null };

test("练一题: a half-filled answer comes back on its problem after leaving; judged, it is gone", async () => {
  const store = new Map();
  const gets = [];
  const world = () =>
    pointWorld({
      store,
      get: (url) => {
        gets.push(url);
        if (url.includes("/practice")) {
          const m = /index=(\d+)/.exec(url);
          return Promise.resolve(BLANKS(m ? Number(m[1]) : 0));
        }
        return Promise.resolve(POINT);
      },
      post: (url) =>
        Promise.resolve(
          url.endsWith("/submit")
            ? { verdict: "incorrect", counted: "none", practice: true, xp: 0, before: {}, after: {}, index: 2, solution: { correct: { blocks: [] }, explanation: [] } }
            : { state: "seen" },
        ),
    });
  let { page } = world();
  page.onLoad({ id: "limit-equivalent" });
  await flush();
  // The server picked problem 0; 下一题 twice is the same as being sent to 2.
  await page.load({ index: 2 });
  page.onPad({ detail: { values: ["3/4", ""], active: 1 } });
  assert.deepEqual(store.get("zhiye_point_draft:u1")["limit-equivalent"].answers, ["3/4", ""]);
  page.onUnload();
  ({ page } = world());
  gets.length = 0;
  page.onLoad({ id: "limit-equivalent" });
  await flush();
  assert.ok(gets.some((u) => u.includes("/practice") && u.includes("index=2")), "asks for the same problem");
  assert.equal(page.data.point.problem.index, 2);
  assert.deepEqual(page.data.answers, ["3/4", ""]);
  page.onPad({ detail: { values: ["3/4", "1"], active: 1 } });
  await page.submit();
  assert.equal(store.has("zhiye_point_draft:u1"), false, "judged: nothing kept");
  // Signing out clears what is kept for the account.
  const space = require(path.join(root, "utils/learning-space.js"));
  space.keepPointDraft("u1", "x", { index: 0, answers: ["1"] });
  space.clear("u1");
  assert.equal(store.has("zhiye_point_draft:u1"), false);
});

test("题库: each problem of a point is a chip; a chip opens that problem", async () => {
  const bank = require(fresh("utils/bank.js"));
  const shown = bank.view({
    guest: false,
    chapters: [{ id: "limit", short: "极限", book: "第 1 章", problems: 3, correct: 1, points: [{ id: "p", name: "点", section: "1.1", tier: "基础", problems: 3, done: 2, correct: 1, items: ["correct", "tried", "none"] }] }],
  });
  const row = shown.chapters[0].points[0];
  assert.deepEqual(row.items.map((i) => [i.no, i.cls]), [[1, "ok"], [2, "tried"], [3, ""]]);
  assert.equal(row.items[1].label, "第 2 题，做过");
  // An older server sends no items: no chips.
  assert.deepEqual(bank.view({ chapters: [{ id: "c", points: [{ id: "q", problems: 2 }] }] }).chapters[0].points[0].items, []);
  const list = read("components/point-list/index.wxml");
  assert.match(list, /wx:if="\{\{showItems&&item\.ready&&item\.items\.length\}\}"/);
  assert.match(list, /catchtap="item"/);
  assert.match(read("pages/bank/index.wxml"), /show-items="\{\{true\}\}"[^>]*binditem="pickItem"/);
  // The page opens the problem by number.
  const store = new Map();
  const asked = [];
  const { page } = pointWorld({
    store,
    get: (url) => {
      asked.push(url);
      return Promise.resolve(url.includes("/practice") ? BLANKS(1) : POINT);
    },
    post: () => Promise.resolve({ state: "seen" }),
  });
  page.onLoad({ id: "limit-equivalent", index: "1" });
  await flush();
  assert.ok(asked.some((u) => u.includes("/practice") && u.includes("index=1")));
});

test("学习: a point never opened starts with its explanation; 知识地图 is a link; the tools do not wait for the map", () => {
  const wxml = read("pages/learn/index.wxml");
  assert.match(wxml, /class="map-entry"[^>]*bindtap="openMap"/);
  assert.doesNotMatch(wxml, /找知识点|ico-search/);
  assert.match(wxml, /card\.hero\.learn\?'先看讲解':'开始'/);
  // The tiles are not behind the map's loading.
  assert.match(wxml, /<block>\s*<view class="tiles">/);
  const js = read("pages/learn/index.js");
  assert.match(js, /backTo\(hero\.learn \? ROUTES\.knowledge : ROUTES\.point, hero\.id\)/);
  assert.match(js, /backTo\(learn \? ROUTES\.knowledge : ROUTES\.point, id\)/);
  assert.match(wxml, /data-learn="\{\{card\.todayNew\.learn\}\}"/);
});

test("我的进度: the record first, in days and time; the rules say what 0.6.0 does", () => {
  global.Page = () => {};
  put("utils/api.js", {});
  put("utils/gate.js", {});
  put("utils/auth.js", {});
  fresh("utils/learn.js");
  const { recordOf, timeText } = require(fresh("pages/ranks/index.js"));
  assert.deepEqual(recordOf({ enabled: true, totalDays: 12, currentStreak: 4, days: [{}, {}], totalMinutes: 200, today: 25 }), { days: 12, streak: 4, today: "25 分钟" });
  // An older server: the recent days stand in.
  assert.equal(recordOf({ enabled: true, days: [{}, {}], totalMinutes: 60, today: 0 }).days, 2);
  assert.equal(timeText(120), "2 小时");
  assert.equal(recordOf({ enabled: false }), null);
  const wxml = read("pages/ranks/index.wxml");
  assert.ok(wxml.indexOf('class="card record"') < wxml.indexOf("段位和等级怎么算"));
  assert.doesNotMatch(wxml, /做错了可以马上再试|练一题里做对：去地图/);
  assert.match(wxml, /交错一题，马上显示答案和解析/);
  assert.match(wxml, /AI 加练做对：不算地图进度/);
  assert.match(read("pages/point/index.wxml"), /AI 出的题只练手，不算进地图和题库/);
});
