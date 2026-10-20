"use strict";
// the leftovers that needed logic. 以前的头脑风暴 (a list from the
// cards home ⋯ menu, each one opened where it stands), the AI 加练 wait
// scrolled into view, 解题 and 批改 waits with real step names and the time
// (no fake percentage, no promise to leave), note groups and follow-ups only
// where the content has them, and 批改 steps shown typeset, edited on tap.
const { beforeEach, test, mock } = require("node:test");
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
    for (const part of parts.slice(0, -1)) at = at[part] = at[part] || {};
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
// A component as the framework runs it: setData fires the observers.
function component(name, props) {
  let definition;
  global.Component = (value) => {
    definition = value;
  };
  delete require.cache[file(name)];
  require(file(name));
  const c = {
    ...definition.methods,
    data: { ...structuredClone(definition.data), ...props },
    events: [],
    setData(patch) {
      assign(this.data, patch);
    },
    triggerEvent(event, detail) {
      this.events.push([event, detail]);
    },
    // The page answers a change by sending the new lines back.
    setLines(lines) {
      this.data.lines = lines;
      return definition.observers.lines.call(this, lines);
    },
  };
  definition.lifetimes.attached.call(c);
  return { c, definition };
}
async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
const tap = (dataset) => ({ currentTarget: { dataset } });

beforeEach(() => {
  Object.keys(require.cache)
    .filter((key) => key.startsWith(root + path.sep))
    .forEach((key) => delete require.cache[key]);
  h = { state: "ok", calls: [], asks: 0, nav: [], routes: {}, app: { globalData: {} }, pages: [], store: {}, ids: 0, user: "one", scrolls: [] };
  const call = (method) => (url, body) => {
    h.calls.push({ method, url, body });
    const route = h.routes[`${method} ${url}`] || h.routes[`${method} ${url.split("?")[0]}`];
    if (!route) return Promise.reject(new Error("没找到"));
    try {
      return Promise.resolve(route(body, url));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  stub("utils/api.js", {
    get: call("GET"),
    post: call("POST"),
    put: call("PUT"),
    patch: call("PATCH"),
    del: call("DELETE"),
    uploadTo: (url, filePath) => call("UPLOAD")(url, { filePath }),
    download: () => Promise.resolve("/tmp/photo.jpg"),
    needsConsent: () => false,
    pending: (job) => Boolean(job && ["queued", "running"].includes(job.status)),
    jobMessage: () => "",
  });
  stub("utils/auth.js", {
    hasConsent: () => h.state === "ok",
    signedIn: () => Boolean(h.user),
    getUser: () => (h.user ? { id: h.user } : null),
    consentGeneration: () => 1,
    login: () => Promise.resolve({ id: h.user }),
  });
  stub("utils/gate.js", {
    state: () => h.state,
    check: () => h.state !== "none",
    ask: () => h.asks++,
  });
  stub("utils/copy.js", { copyAi: () => Promise.resolve() });
  stub("utils/assets.js", { asset: (name) => `https://x/${name}` });
  stub("utils/learning-space.js", { rememberThread() {}, lastThread: () => "", forgetThread() {}, remember() {}, pointDraft: () => null, keepPointDraft() {} });
  stub("utils/study-clock.js", { track: (d) => d, setEnabled() {} });
  stub("utils/stream.js", {
    clientId: () => `cid${++h.ids}xxxxxx`,
    send: () => ({ promise: new Promise(() => {}), abort() {} }),
  });
  stub("utils/bank.js", { load: () => Promise.resolve(null), view: () => ({ chapters: [], tabs: [] }), find: () => null });
  global.getApp = () => h.app;
  global.getCurrentPages = () => h.pages;
  global.wx = {
    navigateTo: ({ url }) => h.nav.push(url),
    redirectTo: ({ url }) => h.nav.push(`redirect:${url}`),
    navigateBack: ({ delta } = {}) => h.nav.push(`back:${delta}`),
    switchTab: ({ url }) => h.nav.push(`tab:${url}`),
    chooseMedia: (o) => o.fail({ errMsg: "chooseMedia:fail cancel" }),
    previewImage() {},
    showToast() {},
    showActionSheet() {},
    showModal: (o) => o.success && o.success({ confirm: true }),
    pageScrollTo: (o) => h.scrolls.push(o),
    setNavigationBarTitle() {},
    getStorageSync: (key) => (key in h.store ? structuredClone(h.store[key]) : ""),
    setStorageSync: (key, value) => {
      h.store[key] = structuredClone(value);
    },
    removeStorageSync: (key) => {
      delete h.store[key];
    },
    stopPullDownRefresh() {},
  };
});

// ---- 1 以前的头脑风暴 -------------------------------------------------------------
const card = (id, title) => ({ id, title, type: "idea", scene: "study" });
const brainstorms = () => [
  { id: "b1", status: "saved", cards: [card("c1", "替换的前提"), card("c2", "加减不能换"), card("c3", "先看结构")], picks: { conclusion: { text: "先看运算结构再替换" } }, outCardIds: ["o1", "o2"], job: { status: "succeeded" }, createdAt: "2026-10-12T02:00:00.000Z", updatedAt: "2026-10-12T03:00:00.000Z" },
  { id: "b2", status: "ready", cards: [card("c4", "早起"), card("c5", "跑步"), card("c6", "早饭")], picks: {}, outCardIds: [], job: { status: "succeeded" }, createdAt: "2026-10-11T02:00:00.000Z", updatedAt: "2026-10-11T02:00:00.000Z" },
  { id: "b3", status: "running", cards: [card("c7", "一"), card("c8", "二"), card("c9", "三")], picks: {}, outCardIds: [], job: { status: "running", progress: { stage: "think" } }, createdAt: "2026-10-10T02:00:00.000Z", updatedAt: "2026-10-10T02:00:00.000Z" },
  { id: "b4", status: "picked", cards: [card("c1", "甲"), card("c2", "乙"), card("c3", "丙")], picks: {}, outCardIds: [], job: { status: "failed" }, createdAt: "2026-10-09T02:00:00.000Z", updatedAt: "2026-10-09T02:00:00.000Z" },
  // Picked, never started: nothing to open.
  { id: "b5", status: "picked", cards: [card("c1", "甲"), card("c2", "乙"), card("c3", "丙")], picks: {}, outCardIds: [], job: null, createdAt: "2026-10-08T02:00:00.000Z", updatedAt: "2026-10-08T02:00:00.000Z" },
];

test("1 以前的头脑风暴: each row has the day, the conclusion or the cards, where it stands, and opens the page for that state", async () => {
  h.routes["GET /v1/brainstorms"] = () => ({ items: brainstorms() });
  const page = load("pages/brainstorm/history/index.js");
  page.onShow();
  await settle();
  assert.equal(h.calls[0].url, "/v1/brainstorms", "the whole list, not only the open ones");
  const rows = page.data.rows;
  assert.deepEqual(rows.map((r) => r.id), ["b1", "b2", "b3", "b4"]);
  assert.deepEqual(rows.map((r) => r.text), ["先看运算结构再替换", "早起、跑步、早饭", "一、二、三", "甲、乙、丙"]);
  assert.deepEqual(rows.map((r) => r.state), ["存了 2 张", "想好了，接着看", "在想", "没跑完，点开重试"]);
  assert.deepEqual(rows.map((r) => r.retry), [false, false, false, true]);
  assert.match(rows[0].when, /^(今天|昨天|\d+月\d+日)/);
  // Saved → the result; still thinking → its progress; failed → 重试 on the process page.
  assert.deepEqual(rows.map((r) => r.url), [
    "/pages/brainstorm/result/index?id=b1",
    "/pages/brainstorm/process/index?id=b2",
    "/pages/brainstorm/process/index?id=b3",
    "/pages/brainstorm/process/index?id=b4",
  ]);
  page.open(tap({ url: rows[2].url }));
  assert.equal(h.nav.at(-1), "/pages/brainstorm/process/index?id=b3");
  const wxml = read("pages/brainstorm/history/index.wxml");
  assert.match(wxml, /class="item" hover-class="pressed" data-url="\{\{item\.url\}\}" bindtap="open" aria-role="button"/);
  assert.match(wxml, /<text wx:elif="\{\{loaded && !error\}\}" class="empty">还没有做过头脑风暴<\/text>/);
  assert.doesNotMatch(wxml, /ai-line/);
});

test("1 以前的头脑风暴: a guest is offered the welcome page; another account gets its own list, never the last one's", async () => {
  h.state = "guest";
  const guest = load("pages/brainstorm/history/index.js");
  guest.onShow();
  assert.equal(h.asks, 1);
  assert.equal(h.calls.length, 0);

  h.state = "ok";
  let reply;
  h.routes["GET /v1/brainstorms"] = () => new Promise((resolve) => (reply = resolve));
  const page = load("pages/brainstorm/history/index.js");
  page.onShow();
  const first = reply;
  // Account switch while the first list is on its way.
  page.onHide();
  h.user = "two";
  page.onShow();
  assert.deepEqual(page.data.rows, []);
  first({ items: brainstorms() });
  await settle();
  assert.deepEqual(page.data.rows, [], "the first account's answer is dropped");
  reply({ items: [] });
  await settle();
  assert.equal(page.data.loaded, true);
  assert.deepEqual(page.data.rows, []);
});

test("1 以前的头脑风暴: entry in the cards home ⋯ menu, page in the brainstorm subpackage", () => {
  const app = JSON.parse(read("app.json"));
  const pack = app.subPackages.find((p) => p.root === "pages/brainstorm");
  assert.ok(pack.pages.includes("history/index"));
  assert.ok(!app.pages.includes("pages/brainstorm/history/index"));
  const deck = read("pages/deck/index.js");
  assert.match(deck, /itemList: \["多选", "头脑风暴", "以前的头脑风暴", "管理标签"\]/);
  assert.match(deck, /tapIndex === 2\) wx\.navigateTo\(\{ url: "\/pages\/brainstorm\/history\/index" \}\)/);
  assert.equal(JSON.parse(read("pages/brainstorm/history/index.json")).navigationBarTitleText, "以前的头脑风暴");
});

// ---- 2 AI 加练 wait in view ------------------------------------------------------
test("2 AI 加练: after the tap the waiting card is scrolled into view", async () => {
  stub("utils/theme.js", { themed: (v) => v });
  h.routes["POST /v1/chat/practice"] = () => new Promise(() => {});
  const page = load("pages/point/index.js");
  page.alive = true;
  page.id = "limit-equivalent";
  page.setData({ point: { id: "limit-equivalent", name: "等价无穷小替换" } });
  page.aiStart();
  assert.equal(page.data.aiBusy, true);
  assert.deepEqual(h.scrolls.at(-1), { selector: ".ai-wait", offsetTop: -16, duration: 200 });
  assert.match(read("pages/point/index.wxml"), /<view wx:if="\{\{aiBusy\}\}" class="ai-wait">/);
});

// ---- 3 long waits ----------------------------------------------------------------
test("3 解题: photo, 出题, 同类题 and 理一理 waits show real steps and the time, no percentage, no promise to leave", async () => {
  const wxml = read("pages/ask/index.wxml");
  assert.match(read("pages/ask/index.json"), /"task-progress": "\/components\/task-progress\/index"/);
  const waits = wxml.match(/<task-progress [^>]*\/>/g);
  assert.equal(waits.length, 4);
  for (const wait of waits) {
    assert.match(wait, /vague="\{\{true\}\}"/);
    assert.match(wait, /slowAfter="\{\{3600\}\}"/, "the built-in 可以先去做别的 line stays off");
    assert.doesNotMatch(wait, /leaveText/);
  }
  assert.match(wxml, /wx:if="\{\{busy === 'similar'\}\}" class="ai ask-wait">\s*<task-progress steps="\{\{waitSteps\.make\}\}" startedAt="\{\{busyAt\}\}"/);
  assert.match(wxml, /wx:if="\{\{busy === 'wrap'\}\}" class="ai ask-wait">\s*<task-progress steps="\{\{waitSteps\.wrap\}\}"/);
  assert.match(wxml, /wx:if="\{\{busy === 'practice'\}\}" class="scan-working">\s*<task-progress steps="\{\{waitSteps\.make\}\}"/);
  assert.match(wxml, /wx:if="\{\{scanning\}\}" class="scan-working">\s*<task-progress steps="\{\{waitSteps\.scan\}\}" startedAt="\{\{scanAt\}\}"/);
  for (const old of ["在出一道同类题", "在出一道题给你", "在看照片", "在帮你理一理"]) assert.ok(!wxml.includes(old), old);

  h.routes["POST /v1/chat/threads/t1/similar"] = () => new Promise(() => {});
  h.routes["UPLOAD /v1/chat/scan"] = () => new Promise(() => {});
  const page = load("pages/ask/index.js");
  page.onLoad();
  assert.deepEqual(page.data.waitSteps.make.map((s) => s.label), ["出一道题", "核对答案"]);
  assert.deepEqual(page.data.waitSteps.scan.map((s) => s.label), ["传照片", "认照片里的字"]);
  page.setData({ thread: { id: "t1" } });
  const before = Date.now();
  page.similar();
  assert.equal(page.data.busy, "similar");
  assert.ok(page.data.busyAt >= before);
  page.scanPhoto({ tempFilePath: "/tmp/p.jpg", size: 10 }, "problem");
  assert.equal(page.data.scanning, true);
  assert.ok(page.data.scanAt >= before);
});

test("3 批改: the scan and the one-problem check show no fake percentage; 逐步核对 is said once", () => {
  const wxml = read("pages/grade/index.wxml");
  assert.match(wxml, /<task-progress steps="\{\{scanSteps\}\}"[^>]*vague="\{\{true\}\}"/);
  assert.match(wxml, /<task-progress steps="\{\{draftSteps\}\}"[^>]*vague="\{\{true\}\}"/);
  // A page's grading counts real problems: its percentage stays.
  assert.doesNotMatch(wxml.match(/<task-progress steps="\{\{pageSteps\}\}"[^>]*>/)[0], /vague/);
  // Leaving the check keeps it (the same clientId is sent again on return).
  assert.match(wxml, /<task-progress steps="\{\{draftSteps\}\}"[^>]*leaveText=/);
  assert.equal((wxml + read("pages/grade/index.js")).split("逐步核对").length - 1, 1);
});

// ---- 4 note groups ---------------------------------------------------------------
function notePage(result) {
  const note = { id: "n1", title: "一条", text: "原话", createdAt: "2026-10-01T00:00:00.000Z", supplements: [], revision: 1, resultVersion: 1, result, resultStale: false, aiJob: null };
  h.routes["GET /v1/notes/n1"] = () => structuredClone(note);
  h.routes["GET /v1/me/usage"] = () => ({});
  h.routes["GET /v1/learn/map"] = () => ({ chapters: [] });
  const page = load("pages/note/index.js");
  page.onLoad({ id: "n1" });
  return page;
}
const result = (groups) => ({
  items: groups.map((group, i) => ({ id: `i${i}`, group, text: `第 ${i} 条` })),
  question: { prompt: "先定哪个？", options: [{ id: "a", text: "甲" }, { id: "b", text: "乙" }] },
  nextStep: { text: "查一下定义", pointId: null },
});

test("4 随心记: plain material (all clear) gets no follow-up question or next step; a record with something open does", async () => {
  const plain = notePage(result(["clear", "clear"]));
  await plain.onShow();
  await settle();
  assert.equal(plain.data.followUp, false);
  assert.deepEqual(plain.data.groups.filter((g) => g.items.length).map((g) => g.id), ["clear"]);
  const open = notePage(result(["clear", "decide"]));
  await open.onShow();
  await settle();
  assert.equal(open.data.followUp, true);
  const check = notePage(result(["verify"]));
  await check.onShow();
  await settle();
  assert.equal(check.data.followUp, true);
  const wxml = read("pages/note/index.wxml");
  assert.match(wxml, /<view wx:if="\{\{followUp\}\}" class="question-note">/);
  assert.match(wxml, /<view wx:if="\{\{note\.result && followUp\}\}" class="next-step">/);
  // Before it is organized nothing promises three fixed groups.
  assert.doesNotMatch(wxml, /理完会分成/);
});

// ---- 5 steps typeset -------------------------------------------------------------
const formula = (tex) => [{ t: "p", c: [{ t: "math", id: tex, tex, w: 2, h: 1, va: 0 }] }];

test("5 step-edit: steps show typeset, plain ones as written; tapping one edits it with a typeset preview", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  h.routes["POST /v1/render"] = ({ text }) => ({ blocks: formula(text) });
  const { c } = component("components/step-edit/index.js", { lines: ["$x^2$", "设 u=3x", "\\frac{1}{2}x", ""], max: 40, placeholder: "写下这一步" });
  t.mock.timers.tick(0);
  await settle();
  // $…$ and a step that is all TeX are typeset; words without $ are not sent.
  assert.deepEqual(h.calls.map((call) => call.body.text), ["$x^2$", "$\\frac{1}{2}x$"]);
  assert.deepEqual(c.data.views, [formula("$x^2$"), null, formula("$\\frac{1}{2}x$"), null]);
  assert.equal(c.data.editing, -1);

  c.edit(tap({ index: 0 }));
  assert.equal(c.data.editing, 0);
  assert.deepEqual(c.data.preview, formula("$x^2$"));
  c.input({ currentTarget: { dataset: { index: 0 } }, detail: { value: "$x^3$" } });
  assert.deepEqual(c.events.at(-1), ["change", { lines: ["$x^3$", "设 u=3x", "\\frac{1}{2}x", ""] }]);
  c.setLines(["$x^3$", "设 u=3x", "\\frac{1}{2}x", ""]);
  // Typing waits a moment; the last preview stays meanwhile.
  assert.deepEqual(c.data.preview, formula("$x^2$"));
  assert.equal(h.calls.length, 2);
  t.mock.timers.tick(400);
  await settle();
  assert.equal(h.calls.at(-1).body.text, "$x^3$");
  assert.deepEqual(c.data.preview, formula("$x^3$"));
  assert.deepEqual(c.data.views[0], formula("$x^3$"));
  c.done();
  assert.equal(c.data.editing, -1);
  // A new step opens as a box.
  c.add();
  assert.equal(c.data.editing, 4);

  const wxml = read("components/step-edit/index.wxml");
  assert.match(read("components/step-edit/index.json"), /"rich": "\/components\/rich\/index"/);
  assert.match(wxml, /<view wx:if="\{\{item && editing !== index\}\}" class="se-show" hover-class="pressed" data-index="\{\{index\}\}" bindtap="edit" aria-role="button" aria-label="改第 \{\{index \+ 1\}\} 步">\s*<rich wx:if="\{\{views\[index\]\}\}" blocks="\{\{views\[index\]\}\}" \/>/);
  assert.match(wxml, /<view wx:if="\{\{preview\}\}" class="se-pv"><rich blocks="\{\{preview\}\}" \/><\/view>/);
  assert.match(wxml, /focus="\{\{editing === index\}\}"/);
  assert.match(read("components/step-edit/index.wxss"), /\.se-show \{[^}]*min-height: var\(--hit\)/);
  // The photo stays one tap away on 批改.
  assert.match(read("pages/grade/index.wxml"), /<image wx:if="\{\{photo\}\}" class="tl-photo" src="\{\{photo\}\}" mode="aspectFill" bindtap="viewPhoto"/);
});

test("5 step-edit: a failed render shows the step as written; deleting the step being edited closes it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  h.routes["POST /v1/render"] = () => {
    throw new Error("网络不太好");
  };
  const { c } = component("components/step-edit/index.js", { lines: ["$a$", "$b$"], max: 40, placeholder: "" });
  t.mock.timers.tick(0);
  await settle();
  assert.deepEqual(c.data.views, [null, null]);
  c.edit(tap({ index: 1 }));
  c.remove(tap({ index: 1 }));
  assert.equal(c.data.editing, -1);
  c.edit(tap({ index: 1 }));
  c.remove(tap({ index: 0 }));
  assert.equal(c.data.editing, 0, "the edited step moved up one");
  clearTimeout(c.undoTimer);
});

test("FX4 copy: no banned words or model names in what was added", () => {
  const banned = /陪伴|陪着你|GLM|DeepSeek|GPT|Qwen|Claude|Gemini|混元|大模型|境内|境外|数据出境/i;
  for (const name of [
    "pages/brainstorm/history/index.wxml",
    "pages/brainstorm/history/index.js",
    "components/step-edit/index.wxml",
    "components/step-edit/index.js",
    "pages/ask/index.wxml",
    "pages/note/index.wxml",
  ])
    assert.doesNotMatch(read(name), banned, name);
});

// V4.2 FX5b (V5) replaced the toggle: the problem itself shows typeset
// (frontend-v42-fx5b.test.cjs has the behaviour).
test("5 grade: the problem is typeset in place, no toggle; the steps are not shown twice", () => {
  const wxml = read("pages/grade/index.wxml");
  // The steps are typeset in step-edit; showing them again would repeat them.
  assert.doesNotMatch(wxml, /preview\.steps/);
  assert.doesNotMatch(wxml, /看公式排好的样子|看题目排好的样子|togglePreview/);
  const shown = wxml.indexOf('bindtap="editProblem"');
  const box = wxml.indexOf('bindinput="onProblem"');
  assert.ok(shown > 0 && box > shown && box < wxml.indexOf("<step-edit"), "the problem sits above the steps");
});
