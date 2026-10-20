"use strict";
// D112 navigation: five tabs (随心记 · 卡片 · 学习 · 聊一聊 · 我的), 聊一聊 for
// chatting only, 解题 as a page of its own opened from 学习, the solving tools
// and three blocks on 学习, and single-choice practice problems.
const { beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const file = (name) => path.join(root, name);
const read = (name) => fs.readFileSync(file(name), "utf8");

let h;
function stub(name, exports) {
  const full = file(name);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}
function assign(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    const parts = key.match(/[^.[\]]+/g);
    let at = target;
    for (const part of parts.slice(0, -1)) at = at[part];
    at[parts[parts.length - 1]] = value;
  }
}
function load(name) {
  let definition;
  global.Page = (value) => {
    definition = value;
  };
  delete require.cache[file(name)];
  require(file(name));
  definition.data = structuredClone(definition.data);
  definition.setData = function (patch, done) {
    assign(this.data, patch);
    if (done) done();
  };
  return definition;
}
async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

beforeEach(() => {
  Object.keys(require.cache)
    .filter((key) => key.startsWith(root + path.sep))
    .forEach((key) => delete require.cache[key]);
  h = { state: "ok", calls: [], asks: 0, nav: [], sheets: [], routes: {}, app: { globalData: {} }, pages: [] };
  const call = (method) => (url, body) => {
    h.calls.push({ method, url, body });
    const route = h.routes[`${method} ${url}`] || h.routes[`${method} ${url.split("?")[0]}`];
    return route ? Promise.resolve(route(body)) : Promise.reject(new Error("没找到"));
  };
  stub("utils/api.js", {
    get: call("GET"),
    post: call("POST"),
    patch: call("PATCH"),
    put: call("PUT"),
    del: call("DELETE"),
    needsConsent: () => false,
  });
  stub("utils/auth.js", {
    hasConsent: () => h.state === "ok",
    getUser: () => ({ id: "one" }),
    consentGeneration: () => 1,
    login: () => Promise.resolve({ id: "one" }),
  });
  stub("utils/gate.js", {
    state: () => h.state,
    check: () => h.state !== "none",
    ask: () => h.asks++,
  });
  stub("utils/copy.js", { copyAi: () => Promise.resolve() });
  global.getApp = () => h.app;
  global.getCurrentPages = () => h.pages;
  global.wx = {
    navigateTo: ({ url }) => h.nav.push(url),
    redirectTo: ({ url }) => h.nav.push(`redirect:${url}`),
    navigateBack: ({ delta } = {}) => h.nav.push(`back:${delta}`),
    switchTab: ({ url }) => h.nav.push(`tab:${url}`),
    showToast() {},
    showActionSheet: (options) => h.sheets.push(options),
    showModal: (options) => options.success && options.success({ confirm: true }),
    pageScrollTo() {},
    getStorageSync: () => null,
    setStorageSync() {},
    removeStorageSync() {},
    stopPullDownRefresh() {},
  };
});

test("the tab bar is 随心记 · 卡片 · 学习 · 聊一聊 · 我的; 解题 stays a registered page", () => {
  const app = JSON.parse(read("app.json"));
  const tabs = app.tabBar.list;
  assert.deepEqual(tabs.map((t) => t.text), ["随心记", "卡片", "学习", "聊一聊", "我的"]);
  assert.deepEqual(tabs.map((t) => t.pagePath), [
    "pages/notes/index",
    "pages/deck/index",
    "pages/learn/index",
    "pages/talk/index",
    "pages/profile/index",
  ]);
  const { TABS, TAB_ROUTES } = require(file("utils/theme.js"));
  assert.deepEqual(TABS, ["pen", "deck", "map", "chat", "user"]);
  assert.deepEqual(TAB_ROUTES, tabs.map((t) => t.pagePath));
  assert.ok(app.pages.includes("pages/ask/index") && app.pages.includes("pages/talk/index"));
  // The 卡片 icon is drawn like the others: 81 px square PNGs, idle and blue.
  for (const name of ["deck.png", "deck-blue.png", "pen.png"]) {
    const png = fs.readFileSync(file(`assets/tab/${name}`));
    assert.equal(png.readUInt32BE(16), 81, name);
    assert.equal(png.readUInt32BE(20), 81, name);
  }
  // The old icons are still there.
  for (const name of ["folder.png", "home.png", "pen-ink.png"]) assert.ok(fs.existsSync(file(`assets/tab/${name}`)), name);
});

test("聊一聊 has one input and its chats only: no solving entries", () => {
  const wxml = read("pages/talk/index.wxml");
  const js = read("pages/talk/index.js");
  // V4.2 : the head holds the clock that opens all chats.
  assert.match(wxml, /<page-head title="聊一聊" tint="mint">[\s\S]*bindtap="openHistory"[\s\S]*<\/page-head>/);
  // 讲一遍 inside a chat (its ⋯) is part of chatting, not a solving tool.
  for (const word of ["拍题", "拍一道题", "批改草稿", "整页作业", "练一题", "错题本", "choosePhoto", "practice", "camera"])
    assert.ok(!wxml.includes(word), word);
  assert.doesNotMatch(js, /openAsk|chooseMedia|\/v1\/chat\/practice|kind=solve/);
  assert.match(js, /\/v1\/chat\/threads\?kind=chat/);
  assert.equal((wxml.match(/<textarea/g) || []).length, 1);
});

function streamStub() {
  h.sent = [];
  stub("utils/stream.js", {
    clientId: () => `cid-${h.sent.length}`,
    send: (url, body, onEvent) => {
      h.sent.push(body);
      onEvent({ e: "start", thread: { id: body.threadId, scene: "life", mode: "guide" }, question: { id: "q1", role: "user", status: "done", content: body.text }, replyId: "r1" });
      onEvent({ e: "done", message: { id: "r1", role: "assistant", status: "done", content: "嗯，慢慢说。", guide: { options: ["接着说"] } } });
      return { promise: Promise.resolve({ finished: true }), abort() {} };
    },
  });
}

test("聊一聊 is the chat itself: words are sent in place, a chip goes on with an old chat", async () => {
  streamStub();
  h.routes["GET /v1/chat/threads?kind=chat&limit=12"] = () => ({
    threads: [
      { id: "c1", title: "周末去哪儿玩比较好呢", updatedAt: "2026-10-18T01:00:00.000Z", unfinished: false },
      { id: "c2", title: "社团", updatedAt: "2026-10-17T01:00:00.000Z", unfinished: false },
    ],
  });
  h.routes["POST /v1/chat/threads"] = (body) => ({ thread: { id: "t-new", title: body.text, scene: "life", mode: "guide", currentCards: [] } });
  h.routes["GET /v1/chat/threads/c2"] = () => ({
    thread: { id: "c2", title: "社团", scene: "life", mode: "guide", currentCards: [] },
    messages: [{ id: "m1", role: "user", status: "done", content: "想换个社团" }],
  });
  const page = load("pages/talk/index.js");
  page.onLoad({});
  page.onShow();
  await settle();
  assert.deepEqual(page.data.recent.map((t) => [t.id, t.title]), [["c1", "周末去哪儿玩比较…"], ["c2", "社团"]]);
  assert.equal(page.data.replay, null);
  page.input({ detail: { value: "  今天有点累  " } });
  page.submit();
  await settle();
  // No other page: the chat is made and the words go in it, here.
  assert.deepEqual(h.nav, []);
  const made = h.calls.find((c) => c.method === "POST" && c.url === "/v1/chat/threads");
  assert.equal(made.body.entry, "jot");
  assert.equal(h.sent[0].text, "今天有点累");
  assert.equal(h.sent[0].threadId, "t-new");
  assert.equal(page.data.thread.id, "t-new");
  assert.equal(page.data.draft, "");
  // ⋯ › 开新话题, then a chip: that chat opens in place.
  page.newTopic();
  assert.equal(page.data.thread, null);
  page.openRecent({ currentTarget: { dataset: { id: "c2" } } });
  await settle();
  assert.equal(page.data.thread.id, "c2");
  assert.deepEqual(h.nav, []);
  // Nothing typed: nothing is sent.
  page.submit();
  assert.equal(h.sent.length, 1);
});

test("聊一聊 with no chats yet shows the start; a guest sends nothing and is asked first", async () => {
  h.routes["GET /v1/chat/threads?kind=chat&limit=12"] = () => ({ threads: [] });
  let page = load("pages/talk/index.js");
  page.onLoad({});
  page.onShow();
  await settle();
  assert.deepEqual(page.data.recent, []);
  assert.equal(page.data.replay, null);
  assert.match(read("pages/talk/index.wxml"), /想聊点什么？/);

  h.state = "guest";
  h.calls = [];
  page = load("pages/talk/index.js");
  page.onLoad({});
  page.onShow();
  await settle();
  assert.equal(page.data.guest, true);
  page.guestTap();
  page.openRecent({ currentTarget: { dataset: { id: "c1" } } });
  page.openHistory();
  assert.equal(h.asks, 3);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.nav, []);
});

test("openAsk opens 解题 with navigateTo, goes back to it when it is already open, never stacks it", () => {
  const { openAsk } = require(file("utils/chat-entry.js"));
  h.pages = [{ route: "pages/learn/index" }];
  openAsk({ photo: "problem" });
  assert.equal(h.nav.at(-1), "/pages/ask/index");
  assert.deepEqual(h.app.globalData.ask, { photo: "problem" });
  // Under the chat page: back to it.
  h.pages = [{ route: "pages/learn/index" }, { route: "pages/ask/index" }, { route: "pages/mistakes/index" }];
  openAsk({ threadId: "t1" });
  assert.equal(h.nav.at(-1), "back:1");
  // On top already: the page takes the intent at once.
  let shown = 0;
  h.pages = [{ route: "pages/learn/index" }, { route: "pages/ask/index", onShow: () => shown++ }];
  openAsk({ practice: "limit" });
  assert.equal(shown, 1);
  assert.equal(h.nav.at(-1), "back:1");
  // The chat page hands a problem over in its place.
  h.pages = [{ route: "pages/talk/index" }, { route: "pages/chat/index" }];
  openAsk({ threadId: "t2" }, { replace: true });
  assert.equal(h.nav.at(-1), "redirect:/pages/ask/index");
  // No switchTab to 解题 is left anywhere.
  for (const name of ["utils/chat-entry.js", "pages/home/index.js", "pages/crisis/index.js", "pages/mood-consent/index.js", "pages/learn/index.js"])
    assert.doesNotMatch(read(name), /switchTab\(\{ url: ["']\/pages\/ask\/index/, name);
});

test("解题 lists only solving threads and marks a new conversation as one", async () => {
  h.routes["GET /v1/chat/threads?kind=solve&tool=ask&limit=100"] = () => ({
    threads: [{ id: "s1", title: "求极限", updatedAt: new Date().toISOString(), problem: true }],
  });
  stub("utils/learning-space.js", { rememberThread() {}, lastThread: () => "s1", forgetThread() {} });
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onShow();
  await settle();
  assert.deepEqual(h.calls.map((c) => c.url), ["/v1/chat/threads?kind=solve&tool=ask&limit=100"], "nothing is reopened by itself");
  assert.deepEqual(page.data.recent.map((t) => t.id), ["s1"]);
  // the last one is offered as 继续上次 instead.
  assert.equal(page.data.recent[0].resume, true);
  // 讲一遍 left here has its own page now; nothing is posted.
  h.app.globalData.ask = { teach: true };
  page.onShow();
  await settle();
  assert.equal(h.calls.find((c) => c.method === "POST"), undefined);
  assert.equal(h.nav.at(-1), "redirect:/pages/teach/index");
  assert.equal(h.app.globalData.ask, null);
});

test("解题 sends a new question as a solving one and an old thread without it", () => {
  const stream = { sent: [] };
  stub("utils/stream.js", {
    clientId: () => "cid",
    send: (url, body) => {
      stream.sent.push(body);
      return { promise: new Promise(() => {}), abort() {} };
    },
  });
  stub("utils/learning-space.js", { rememberThread() {}, lastThread: () => "", forgetThread() {} });
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onDraft({ detail: { value: "求 x^2 的导数" } });
  page.submit();
  page.choose({ currentTarget: { dataset: { way: "hint" } } });
  assert.equal(stream.sent[0].origin, "solve");
  assert.equal(stream.sent[0].threadId, undefined);
  page.setData({ sending: false, thread: { id: "s9", currentCards: [], pending: [] } });
  page.onDraft({ detail: { value: "再讲一下" } });
  page.submit();
  assert.equal(stream.sent[1].threadId, "s9");
  assert.equal(stream.sent[1].origin, undefined);
});

test("学习 shows 今天 under the main card, then the five solving tools as tiles, 段位贴纸, 我的资料 and 学习记录", async () => {
  const wxml = read("pages/learn/index.wxml");
  for (const [label, handler] of [
    ["拍一道题", "askPhoto"],
    ["批改", "askGrade"],
    ["讲一遍", "askTeach"],
    ["练一题", "openPractice"],
    ["错题本", "openMistakes"],
  ])
    assert.match(wxml, new RegExp(`class="ftile[^"]*" bindtap="${handler}"[^>]*><text class="t">${label}</text>`), label);
  // typing lives in 拍一道题; each tile has one line.
  assert.doesNotMatch(wxml, /bindtap="askText"/);
  for (const line of ["拍照或打字，一步步带你做", "一道或一页，找出哪步错", "讲给小狸听，看漏了哪条要点"]) assert.match(wxml, new RegExp(`<text class="s">${line}</text>`), line);
  // Not an icon row: 纪要第 3 节 asks that 草稿批改 and 学习资料 are not tucked away.
  assert.doesNotMatch(wxml, /icon-item/);
  // V4.2 G9 (report B): 今天 right under the main card, the tools after it.
  const order = ["class=\"hero\"", ">今天<", "class=\"tiles\"", "class=\"grid2\"", ">段位贴纸<", ">我的资料<", ">学习记录<"].map((s) => wxml.indexOf(s));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), String(order));
  assert.doesNotMatch(wxml, /toggle(Learn|Stickers)|wx:if="\{\{(learnOpen|stickersOpen)\}\}"/, "shown open, not folded");

  const map = {
    title: "高数",
    chapters: [
      { id: "limit", short: "极限", started: true, rank: "基础段", points: [] },
      { id: "ode", short: "微分方程", started: true, rank: "重点段", hidden: true, points: [] },
    ],
    summary: { level: 3, correct: 12, xp: 340, todayList: [], week: { correct: 0, xp: 0 }, levelXp: 40, levelNeed: 100 },
  };
  h.routes["GET /v1/learn/map"] = () => map;
  h.routes["GET /v1/cards/stats"] = () => ({ retestCount: 4, predicted: 4, actual: 3 });
  const page = load("pages/learn/index.js");
  page.onShow();
  await settle();
  const card = page.data.card;
  assert.ok(card, JSON.stringify(page.data.error));
  assert.deepEqual(card.stickers.map((s) => s.id), ["limit"], "a chapter set aside gets no sticker");
  assert.deepEqual([card.level, card.correct, card.xp], [3, 12, 340]);
  assert.deepEqual(card.retest, { predicted: 4, actual: 3 });
  h.pages = [{ route: "pages/learn/index" }];
  page.askPhoto();
  assert.deepEqual(h.app.globalData.ask, { start: true });
  assert.equal(h.nav.at(-1), "/pages/ask/index");
  // the other three tools have pages of their own.
  for (const [handler, url] of [
    ["askGrade", "/pages/grade/index"],
    ["askTeach", "/pages/teach/index"],
  ]) {
    page[handler]();
    assert.equal(h.nav.at(-1), url, handler);
  }
  page.openChapter({ currentTarget: { dataset: { id: "limit" } } });
  assert.equal(h.nav.at(-1), "/pages/chapter/index?id=limit");
});

test("学习 opens without the card stats; a guest is asked first and nothing is requested", async () => {
  h.routes["GET /v1/learn/map"] = () => ({ title: "高数", chapters: [], summary: { todayList: [], week: { correct: 0, xp: 0 }, level: 1, levelXp: 0, levelNeed: 100 } });
  let page = load("pages/learn/index.js");
  page.onShow();
  await settle();
  assert.equal(page.data.card.retest, null);

  h.state = "guest";
  h.calls = [];
  h.nav = [];
  page = load("pages/learn/index.js");
  page.onShow();
  await settle();
  for (const handler of ["askPhoto", "askGrade", "askTeach", "openMistakes", "openLibrary", "startNote", "startProblem", "openReview", "openRanks"])
    page[handler]();
  assert.equal(h.asks, 9);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.nav, []);
  // 练一题 opens the 题库, which a guest may look at.
  page.openPractice();
  assert.equal(h.asks, 9);
  assert.deepEqual(h.nav, ["/pages/bank/index"]);
  assert.deepEqual(h.calls, []);
});

test("我的 no longer has 段位与贴纸, 我的资料 or 学习记录; the rest stays", () => {
  const wxml = read("pages/profile/index.wxml");
  for (const gone of ["段位", "贴纸", "我的资料", "学习记录", "以为会", "toggleLearn", "openLibrary", "openChapter"])
    assert.ok(!wxml.includes(gone), gone);
  for (const kept of ["心情记录", "openTags", "openResume", "exportData", "openHelp", "toggleUsage", "deleteAccount", "学习时间"])
    assert.ok(wxml.includes(kept), kept);
});

test("a practice problem with options: tap a row to answer; a wrong pick shows the steps and offers the next one", async () => {
  stub("utils/learning-space.js", { rememberThread() {}, lastThread: () => "", forgetThread() {} });
  const wxml = read("pages/ask/index.wxml");
  assert.match(wxml, /class="choice-option[^"]*"[\s\S]*?bindtap="pickOption"/);
  assert.match(wxml, /<rich wx:if="\{\{item\.steps\}\}" blocks="\{\{item\.steps\}\}" \/>/);
  const blocks = (v) => [{ t: "p", c: [{ t: "text", v }] }];
  const similar = {
    id: "q1",
    role: "assistant",
    kind: "similar",
    status: "done",
    practice: true,
    similar: { question: blocks("求极限"), options: ["A", "B", "C", "D"].map((id) => ({ id, blocks: blocks(id) })), correct: null, steps: null, revealed: false },
  };
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.setData({ thread: { id: "t1", practice: { chapter: "limit" }, currentCards: [], pending: [] }, messages: [similar] });
  const steps = [{ t: "list", items: [{ c: [{ t: "text", v: "展开" }], n: "1." }] }];
  h.routes["POST /v1/chat/messages/q1/answer"] = () => ({
    question: { id: "a1", role: "user", kind: "answer", status: "done", blocks: blocks("A") },
    judge: {
      id: "j1",
      role: "assistant",
      kind: "judge",
      status: "done",
      similarOf: "q1",
      choice: 0,
      steps,
      attempt: { answer: "$1$", result: { verdict: "incorrect", judge: "choice" } },
      blocks: blocks("这个选项不对，看看下面的步骤。"),
    },
  });
  h.routes["GET /v1/chat/messages/q1"] = () => ({ ...similar, similar: { ...similar.similar, correct: "B", revealed: true, steps } });
  page.pickOption({ currentTarget: { dataset: { id: "q1", index: 0 } } });
  await settle();
  const post = h.calls.find((c) => c.method === "POST");
  assert.equal(post.url, "/v1/chat/messages/q1/answer");
  assert.equal(post.body.choice, 0);
  assert.equal(post.body.answer, undefined);
  const judge = page.data.messages.find((m) => m.id === "j1");
  assert.deepEqual(judge.steps, steps);
  assert.equal(judge.verdict.answer, "A", "the pick shows as its letter");
  const q = page.data.messages.find((m) => m.id === "q1");
  assert.equal(q.picked, 0);
  assert.equal(q.similar.correct, "B");
  // No 再试一次 or 看答案 after a wrong pick: the steps are there, on to the next one.
  assert.deepEqual(page.data.actions.map((a) => a.key).filter((k) => ["answerSimilar", "revealSimilar", "nextPractice"].includes(k)), ["nextPractice"]);
  // An open problem with options offers no typed answer.
  assert.match(read("pages/ask/index.js"), /if \(open && !options\) out\.push\(\{ key: "answerSimilar"/);
  // A guest is asked first.
  h.state = "guest";
  page.setData({ guest: true });
  page.pickOption({ currentTarget: { dataset: { id: "q1", index: 1 } } });
  assert.equal(h.asks, 1);
});

test("a reopened chat shows which option was picked", async () => {
  stub("utils/learning-space.js", { rememberThread() {}, lastThread: () => "", forgetThread() {} });
  const blocks = (v) => [{ t: "p", c: [{ t: "text", v }] }];
  h.routes["GET /v1/chat/threads/t1"] = () => ({
    thread: { id: "t1", currentCards: [], pending: [] },
    messages: [
      { id: "q1", role: "assistant", kind: "similar", status: "done", similar: { question: blocks("题"), options: [], revealed: true } },
      { id: "j1", role: "assistant", kind: "judge", status: "done", similarOf: "q1", choice: 2, attempt: { answer: "$3$", result: { verdict: "incorrect" } } },
    ],
  });
  h.routes["GET /v1/chat/threads?kind=solve&tool=ask&limit=100"] = () => ({ threads: [] });
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.scope = "one#1";
  await page.open("t1");
  assert.equal(page.data.messages[0].picked, 2);
  assert.equal(page.data.messages[1].verdict.answer, "C");
});

test("card filters and new cards open the 卡片 tab, not 随心记 (D112)", () => {
  const src = (name) => fs.readFileSync(path.join(root, name), "utf8");
  const deck = /switchTab\(\{ url: "\/pages\/deck\/index" \}\)/;
  for (const name of [
    "utils/point-actions.js",
    "pages/profile/index.js",
    "pages/tags/index.js",
    "pages/mood-log/index.js",
    "pages/import/split/index.js",
    "pages/brainstorm/result/index.js",
    "pages/brainstorm/conclude/index.js",
  ])
    assert.match(src(name), deck, name);
  // Whoever sets a filter goes to the tab that reads it.
  for (const name of ["utils/point-actions.js", "pages/profile/index.js", "pages/tags/index.js", "pages/mood-log/index.js"])
    assert.doesNotMatch(src(name), /cardFilter = [^;]+;\s*wx\.switchTab\(\{ url: "\/pages\/notes\/index"/, name);
  assert.match(src("pages/import/split/index.wxml"), /去卡片看看/);
  assert.match(src("pages/brainstorm/result/index.wxml"), /回卡片/);
});
