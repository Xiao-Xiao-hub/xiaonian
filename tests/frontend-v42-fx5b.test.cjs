"use strict";
// 页面回归：离页后保留已识别照片，重开会话显示原话，快速切换只接受最后一次结果。
// 后台存卡不抢走当前页面；出题与同类题用相同 clientId 重试，旧批改记录可继续读取。
// 同时覆盖学习计时、讲一遍历史和常用展示细节。测试替身沿用服务端结构：
// 生成内容使用 blocks，用户原话使用 plain，不用 content 冒充用户原话字段。
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
async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const para = (v) => [{ t: "p", c: [{ t: "text", v }] }];
const lost = () => Object.assign(new Error("网络不太好"), { code: "NETWORK" });
function later() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
// As ChatService.view() sends them.
const user = (id, plain, extra = {}) => ({ id, role: "user", status: "done", blocks: plain ? para(plain) : [], plain, ...extra });
const reply = (id, blocks) => ({ id, role: "assistant", status: "done", blocks });

beforeEach(() => {
  Object.keys(require.cache)
    .filter((key) => key.startsWith(root + path.sep))
    .forEach((key) => delete require.cache[key]);
  h = { state: "ok", calls: [], asks: 0, nav: [], routes: {}, app: { globalData: {} }, store: {}, ids: 0, user: "one", touches: 0 };
  const call = (method) => (url, body) => {
    h.calls.push({ method, url, body });
    const route = h.routes[`${method} ${url}`] || h.routes[`${method} ${url.split("?")[0]}`];
    if (!route) return Promise.reject(Object.assign(new Error("没找到"), { code: "NOT_FOUND", statusCode: 404 }));
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
  });
  stub("utils/auth.js", {
    hasConsent: () => h.state === "ok",
    signedIn: () => Boolean(h.user),
    getUser: () => (h.user ? { id: h.user } : null),
    consentGeneration: () => 1,
    login: () => Promise.resolve({ id: h.user }),
  });
  stub("utils/gate.js", { state: () => h.state, check: () => h.state !== "none", ask: () => h.asks++ });
  stub("utils/copy.js", { copyAi: () => Promise.resolve() });
  stub("utils/assets.js", { asset: (name) => `https://x/${name}` });
  stub("utils/learning-space.js", { rememberThread() {}, lastThread: () => "", forgetThread() {}, remember() {}, pointDraft: () => null, keepPointDraft() {} });
  stub("utils/study-clock.js", {
    track: (d) => ({ ...d, studyTouch: () => h.touches++ }),
    setEnabled() {},
  });
  stub("utils/stream.js", {
    clientId: () => `cid${++h.ids}xxxxxx`,
    send: () => ({ promise: new Promise(() => {}), abort() {} }),
  });
  stub("utils/bank.js", { load: () => Promise.resolve(null), view: () => ({ chapters: [], tabs: [] }), find: () => null });
  global.getApp = () => h.app;
  global.getCurrentPages = () => [];
  global.wx = {
    getWindowInfo: () => ({ screenHeight: 800, windowHeight: 740 }),
    navigateTo: ({ url }) => h.nav.push(url),
    redirectTo: ({ url }) => h.nav.push(`redirect:${url}`),
    navigateBack: ({ delta } = {}) => h.nav.push(`back:${delta}`),
    switchTab: ({ url }) => h.nav.push(`tab:${url}`),
    previewImage() {},
    showToast() {},
    showActionSheet() {},
    showModal: (o) => o.success && o.success({ confirm: true }),
    pageScrollTo() {},
    nextTick: (fn) => fn(),
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

// ---- F02 解题: a photo read after leaving ----------------------------------
const SCAN = { type: "problem", imageId: "img1", problems: [{ text: "求 $x^2$ 的导数", blocks: para("求 x² 的导数"), unclear: "" }], solution: null, notes: "", suggest: null };

test("F02 解题: left while the photo is read, it is kept for this account and offered as 上次拍的题, not read again", async () => {
  const scan = later();
  h.routes["UPLOAD /v1/chat/scan"] = () => scan.promise;
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  page.onUnload();
  scan.resolve(SCAN);
  await settle();
  const kept = h.store["tool_draft:ask:one"];
  assert.equal(kept.scan.imageId, "img1");
  assert.equal(kept.confirm.text, "求 $x^2$ 的导数");
  // Another account on this phone does not get it.
  h.user = "two";
  const other = load("pages/ask/index.js");
  other.onLoad();
  other.onShow();
  await settle();
  assert.equal(other.data.confirm, null);
  // Back on 解题: offered, with 不要了.
  h.user = "one";
  const back = load("pages/ask/index.js");
  back.onLoad();
  back.onShow();
  await settle();
  assert.equal(back.data.confirm.imageId, "img1");
  assert.equal(back.data.confirm.again, true);
  const wxml = read("pages/ask/index.wxml");
  assert.match(wxml, /\{\{confirm\.again \? '上次拍的题' : confirm\.title\}\}/);
  assert.match(wxml, /confirm\.again \? '不要了' : '重新拍'/);
  // A temporary photo gone after a restart: the problem stays.
  assert.match(wxml, /class="cf-photo"[^>]*binderror="confirmPhotoBroken"/);
  back.confirmPhotoBroken();
  assert.equal(back.data.confirm.photo, "");
  assert.equal(h.calls.filter((c) => c.method === "UPLOAD").length, 1, "the photo is not read (or counted) again");
  // 不要了: gone from the phone too.
  back.closeConfirm();
  assert.equal(h.store["tool_draft:ask:one"], undefined);
});

test("F02 解题: a photo read with the page open is kept at once (a closed app still finds it); 拍下我写的 after leaving fills the kept steps", async () => {
  h.routes["UPLOAD /v1/chat/scan"] = () => SCAN;
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  await settle();
  assert.equal(page.data.confirm.imageId, "img1");
  assert.equal(h.store["tool_draft:ask:one"].confirm.imageId, "img1", "kept before the page is left");
  // 做到一半卡住 → 拍下我写的, then the page is left while it is read.
  const steps = later();
  h.routes["UPLOAD /v1/chat/scan"] = () => steps.promise;
  page.setData({ stuck: { lines: [], text: "" } });
  const realPick = require(file("utils/tools.js")).pick;
  require(file("utils/tools.js")).pick = () => Promise.resolve({ tempFilePath: "/tmp/s.jpg", size: 10 });
  page.pickStuck({ currentTarget: { dataset: { source: "album" } } });
  await settle();
  page.onUnload();
  steps.resolve({ type: "solution", imageId: "img2", problems: [], solution: { steps: ["y'=2x"], unclear: "" }, notes: "" });
  await settle();
  require(file("utils/tools.js")).pick = realPick;
  const kept = h.store["tool_draft:ask:one"];
  assert.deepEqual(kept.stuck.lines, ["y'=2x"]);
  assert.equal(kept.confirm.imageId, "img1");
});

// ---- F02 整页批改 ------------------------------------------------------------
const HELD = {
  id: "hw1",
  title: "作业 · 2 题",
  homework: {
    imageId: "img4",
    items: [
      { no: "1", status: "unclear", hold: "quota", holdUntil: "2026-10-19T00:00:00+08:00", unclear: "今天的额度用完了，这道先放着，明天再批", problem: [], steps: [] },
      { no: "2", status: "unclear", hold: "quota", holdUntil: "2026-10-19T00:00:00+08:00", unclear: "今天的额度用完了，这道先放着，明天再批", problem: [], steps: [] },
    ],
    counts: { correct: 0, wrong: 0, unsure: 0, unclear: 2, grading: 0, failed: 0 },
  },
};

test("F02 整页批改: the page read is kept until the server has it; left on a lost network, it goes again on return (same photo, no new read)", async () => {
  h.routes["UPLOAD /v1/chat/scan"] = () => ({ type: "homework", imageId: "img4", homework: 2, problems: [], suggest: null });
  h.routes["POST /v1/chat/homework"] = () => {
    throw lost();
  };
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  const page = load("pages/grade/index.js");
  page.onLoad({});
  await page.read({ tempFilePath: "/tmp/p.jpg", size: 10 });
  await settle();
  assert.equal(page.data.retryPage, true);
  assert.equal(h.store["tool_draft:grade:one"].scan.imageId, "img4", "kept while the page is not made");
  page.onUnload();
  // The allowance ran out meanwhile: the server keeps the page, every problem waiting.
  h.routes["POST /v1/chat/homework"] = (body) => (body.imageId === "img4" ? HELD : null);
  const back = load("pages/grade/index.js");
  back.onLoad({});
  back.onShow();
  await settle();
  assert.equal(back.data.stage, "page");
  assert.equal(back.data.id, "hw1");
  assert.equal(back.data.items.length, 2);
  assert.equal(h.calls.filter((c) => c.method === "UPLOAD").length, 1, "not read again");
  assert.equal(h.store["tool_draft:grade:one"], undefined, "the server has it now");
});

// ---- F06: what was said ----------------------------------------------------
test("F06 聊一聊: the replay shows the last three messages with something to show, as plain lines", async () => {
  const long = "我".repeat(70);
  h.routes["GET /v1/chat/threads?kind=chat&limit=12"] = () => ({ threads: [{ id: "c1", title: "导数", unfinished: true, lastAt: "2026-10-18T01:00:00.000Z" }] });
  h.routes["GET /v1/chat/threads/c1?tone=light"] = () => ({
    thread: { id: "c1", title: "导数", scene: "study", mode: "guide" },
    messages: [
      user("u0", "先问一个"),
      reply("a0", [{ t: "h", l: 2, c: [{ t: "text", v: "求导", b: 1 }] }, { t: "p", c: [{ t: "text", v: "结果是 " }, { t: "math", tex: "2x", id: "f1" }] }]),
      user("u1", "", { attachments: [{ id: "x1", kind: "image", name: "a.png" }] }),
      user("u2", "", { attachments: [{ id: "x2", kind: "file", name: "讲义.pdf" }] }),
      user("u3", ""),
      reply("a3", []),
      user("u4", long),
    ],
  });
  const page = load("pages/talk/index.js");
  page.onLoad({});
  page.onShow();
  await settle();
  const lines = page.data.replay.lines;
  assert.deepEqual(lines.map((l) => l.id), ["u1", "u2", "u4"], "empty ones are skipped");
  assert.deepEqual(lines.map((l) => l.text.slice(0, 12)), ["（图片）", "（文件）讲义.pdf", "我".repeat(12)]);
  assert.equal(Array.from(lines[2].text).length, 61, "cut at 60, with …");
  // A reply reads from its blocks, without $ or marks.
  h.routes["GET /v1/chat/threads/c1?tone=light"] = () => ({
    thread: { id: "c1", title: "导数", scene: "study", mode: "guide" },
    messages: [user("u0", "$x^2$ 的导数？"), reply("a0", [{ t: "h", l: 2, c: [{ t: "text", v: "求导", b: 1 }] }, { t: "p", c: [{ t: "text", v: "结果是 " }, { t: "math", tex: "2x", id: "f1" }] }])],
  });
  const again = load("pages/talk/index.js");
  again.onLoad({});
  again.onShow();
  await settle();
  assert.deepEqual(again.data.replay.lines.map((l) => [l.mine, l.text]), [
    [true, "x^2 的导数？"],
    [false, "求导 结果是 2x"],
  ]);
});

test("F06 对话: reopened, 存成卡 offers 从你的话里选 from the learner's own words", async () => {
  h.routes["GET /v1/chat/threads/t1?tone=light"] = () => ({
    thread: { id: "t1", title: "复习", scene: "study", mode: "guide", currentCards: [] },
    messages: [user("u1", "我觉得链式法则就是一层一层往里求导。"), reply("a1", para("对，外层导数乘内层导数。"))],
  });
  h.routes["POST /v1/chat/threads/t1/suggest-cards"] = () => ({ cards: [] });
  const page = load("pages/chat/index.js");
  page.onLoad({});
  await page.open("t1");
  await settle();
  assert.equal(page.data.messages[0].plain, "我觉得链式法则就是一层一层往里求导。");
  page.collect({ detail: { id: "a1" } });
  assert.deepEqual(h.app.globalData.collect.quotes, ["我觉得链式法则就是一层一层往里求导"]);
  assert.equal(h.nav.at(-1), "/pages/collect/index");
  // An older server's `content` still counts.
  const old = load("pages/chat/index.js");
  old.onLoad({});
  h.routes["GET /v1/chat/threads/t1?tone=light"] = () => ({
    thread: { id: "t1", title: "复习", scene: "study", mode: "guide", currentCards: [] },
    messages: [{ id: "u1", role: "user", status: "done", content: "我觉得链式法则就是一层一层往里求导。" }, reply("a1", para("对。"))],
  });
  await old.open("t1");
  assert.equal(old.data.messages[0].plain, "我觉得链式法则就是一层一层往里求导。");
});

test("F06 解题: 懂了 in the learner's words settles the problem (settled() reads plain), so 存成卡 is offered", async () => {
  const said = [user("u1", "怎么做"), reply("a1", para("先求导")), user("u2", "为什么"), reply("a2", para("看这一步")), user("u3", "那这里呢"), reply("a3", para("代入")), user("u4", "明白了，谢谢"), reply("a4", para("好"))];
  h.routes["GET /v1/chat/threads/s1"] = () => ({ thread: { id: "s1", mode: "auto", scene: "study" }, messages: said });
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  const page = load("pages/ask/index.js");
  page.onLoad();
  await page.open("s1");
  await settle();
  assert.equal(page.data.messages[6].plain, "明白了，谢谢");
  page.offerWrap();
  assert.equal(page.data.wrapDue, true);
});

test("F06 讲一遍: a user message from an older server keeps its formulas in the quote candidates", async () => {
  h.routes["GET /v1/chat/threads/k1"] = () => ({
    thread: { id: "k1", title: "导数", pointId: "p1" },
    messages: [{ id: "u1", role: "user", status: "done", blocks: [{ t: "p", c: [{ t: "text", v: "导数是 " }, { t: "math", tex: "f'(x)", id: "f" }] }] }, user("u2", "就是斜率")],
  });
  const page = load("pages/teach/index.js");
  page.onLoad({ id: "k1" });
  await page.load();
  assert.equal(page.data.messages[0].plain, "导数是 $f'(x)$");
  assert.equal(page.data.messages[1].plain, "就是斜率");
});

// ---- F07: switching topics fast --------------------------------------------
test("F07 聊一聊: tap A then B; A answering last does not replace B", async () => {
  const a = later(),
    b = later();
  h.routes["GET /v1/chat/threads?kind=chat&limit=12"] = () => ({ threads: [] });
  h.routes["GET /v1/chat/threads/A?tone=light"] = () => a.promise;
  h.routes["GET /v1/chat/threads/B?tone=light"] = () => b.promise;
  h.routes["POST /v1/chat/threads/B/suggest-cards"] = () => ({ cards: [] });
  const page = load("pages/talk/index.js");
  page.onLoad({});
  page.onShow();
  await settle();
  page.openRecent({ currentTarget: { dataset: { id: "A" } } });
  page.openRecent({ currentTarget: { dataset: { id: "B" } } });
  b.resolve({ thread: { id: "B", title: "B", scene: "life", mode: "guide" }, messages: [user("b1", "说B")] });
  await settle();
  assert.equal(page.data.thread.id, "B");
  a.resolve({ thread: { id: "A", title: "A", scene: "life", mode: "guide" }, messages: [user("a1", "说A")] });
  await settle();
  assert.equal(page.data.thread.id, "B", "the slow answer is dropped");
  assert.equal(page.data.messages[0].id, "b1");
  assert.equal(page.data.loading, false);
  // 开新话题 while one is opening: nothing lands afterwards.
  const c = later();
  h.routes["GET /v1/chat/threads/C?tone=light"] = () => c.promise;
  page.openRecent({ currentTarget: { dataset: { id: "C" } } });
  page.newTopic();
  c.resolve({ thread: { id: "C", title: "C", scene: "life", mode: "guide" }, messages: [] });
  await settle();
  assert.equal(page.data.thread, null);
  // Another account meanwhile: the old account's chat does not land.
  const d = later();
  h.routes["GET /v1/chat/threads/D?tone=light"] = () => d.promise;
  page.openRecent({ currentTarget: { dataset: { id: "D" } } });
  h.user = "two";
  page.onShow();
  d.resolve({ thread: { id: "D", title: "D", scene: "life", mode: "guide" }, messages: [] });
  await settle();
  assert.equal(page.data.thread, null);
});

// ---- F08: a wrap done in the background ------------------------------------
test("F08 对话: a wrap finished while the page is hidden only marks 理好的卡还没存; visible, it opens with the job's own quotes", async () => {
  const job = later();
  h.routes["POST /v1/chat/threads/t1/wrap"] = () => job.promise;
  const page = load("pages/chat/index.js");
  page.onLoad({});
  page.alive = true;
  page.setData({ thread: { id: "t1", scene: "study", currentCards: [] }, messages: [user("u1", "我觉得链式法则就是一层一层往里求导。")] });
  page.openWrap();
  page.onHide();
  job.resolve({ cards: [] });
  await settle();
  assert.equal(h.nav.length, 0, "no jump while elsewhere");
  assert.equal(page.data.thread.wrapReady, true);
  assert.match(read("pages/chat/index.wxml"), /thread\.wrapReady[^>]*bindtap="openWrap">理好的卡还没存/);
  // Visible: it opens, quoting the chat it was made for, not what is on screen now.
  const next = later();
  h.routes["POST /v1/chat/threads/t1/wrap"] = () => next.promise;
  page.hidden = false;
  h.app.globalData.collect = null;
  page.openWrap();
  page.setData({ messages: [user("u9", "这是后来另一段里说的很长的一句话。")] });
  next.resolve({ cards: [] });
  await settle();
  assert.equal(h.nav.at(-1), "/pages/collect/index");
  assert.deepEqual(h.app.globalData.collect.quotes, ["我觉得链式法则就是一层一层往里求导"]);
  // Another topic on screen when it finishes: no jump, and no mark on the new one.
  const third = later();
  h.routes["POST /v1/chat/threads/t1/wrap"] = () => third.promise;
  page.setData({ busy: "" });
  page.openWrap();
  page.setData({ thread: { id: "t2", scene: "study", currentCards: [] } });
  const navs = h.nav.length;
  third.resolve({ cards: [] });
  await settle();
  assert.equal(h.nav.length, navs);
  assert.equal(page.data.thread.wrapReady, undefined);
});

test("F08 解题: the same for a problem's 存成卡; the ready row is on the page", async () => {
  const job = later();
  h.routes["POST /v1/chat/threads/s1/wrap"] = () => job.promise;
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.setData({ thread: { id: "s1", mode: "auto", scene: "study" }, messages: [user("u1", "原来分部积分要先选好u和dv。")] });
  page.openWrap();
  page.onHide();
  job.resolve({ cards: [] });
  await settle();
  assert.equal(h.nav.length, 0);
  assert.equal(page.data.thread.wrapReady, true);
  assert.match(read("pages/ask/index.wxml"), /thread\.wrapReady && !busy && !sending[^>]*bindtap="openWrap"[^>]*>理好的卡还没存/);
  page.onShow = undefined;
  page.hidden = false;
  h.routes["POST /v1/chat/threads/s1/wrap"] = () => ({ cards: [] });
  await page.openWrap();
  assert.equal(h.nav.at(-1), "/pages/collect/index");
  assert.deepEqual(h.app.globalData.collect.quotes, ["原来分部积分要先选好u和dv"]);
});

// ---- F16: one clientId per 出题 / 同类题 -----------------------------------
test("F16 解题: 同类题 and 出题 retried after a timeout send the same clientId; a new request gets a new one", async () => {
  let fail = true;
  h.routes["POST /v1/chat/threads/s1/similar"] = () => {
    if (fail) throw lost();
    return { id: "sim1", role: "assistant", kind: "similar", status: "done", blocks: para("同类题") };
  };
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.setData({ thread: { id: "s1", mode: "auto", scene: "study" }, messages: [] });
  page.similar();
  await settle();
  page.similar();
  await settle();
  const asked = () => h.calls.filter((c) => c.url === "/v1/chat/threads/s1/similar").map((c) => c.body.clientId);
  const sent = asked();
  assert.equal(sent[0], sent[1], "the retry is the same request");
  fail = false;
  page.similar();
  await settle();
  assert.equal(asked().at(-1), sent[0]);
  assert.deepEqual(page.data.messages.map((m) => m.id), ["sim1"]);
  // Answered again with the same problem (made by the timed-out call): shown once.
  page.setData({ busy: "" });
  page.similar();
  await settle();
  assert.notEqual(asked().at(-1), sent[0], "after an answer, a new request");
  assert.deepEqual(page.data.messages.map((m) => m.id), ["sim1"]);
  // 出题: the same.
  let n = 0;
  h.routes["POST /v1/chat/practice"] = () => {
    if (++n === 1) throw lost();
    return { thread: { id: "p1" } };
  };
  h.routes["GET /v1/chat/threads/p1"] = () => ({ thread: { id: "p1", mode: "auto", scene: "study" }, messages: [] });
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  page.practice("definite");
  await settle();
  page.practice("definite");
  await settle();
  const made = h.calls.filter((c) => c.url === "/v1/chat/practice").map((c) => c.body.clientId);
  assert.equal(made.length, 2);
  assert.equal(made[0], made[1]);
  // Another chapter is another request.
  page.practice("limit");
  await settle();
  assert.notEqual(h.calls.filter((c) => c.url === "/v1/chat/practice").at(-1).body.clientId, made[0]);
});

// ---- F17: old 批改 records -------------------------------------------------
test("F17 批改: an old record's ✓ after the first error shows as carried over", async () => {
  h.routes["GET /v1/chat/threads/d1"] = () => ({
    thread: { id: "d1", problem: para("求极限") },
    messages: [
      {
        id: "m1",
        role: "assistant",
        kind: "draft",
        status: "done",
        blocks: [],
        draft: {
          verdict: "wrong",
          first: { step: 2, why: "漏乘 3", fix: "" },
          summary: "",
          problemText: "求极限",
          steps: [
            { no: 1, text: "a", status: "ok" },
            { no: 2, text: "b", status: "wrong" },
            { no: 3, text: "c", status: "ok", note: "沿用了前面的错误结果" },
          ],
        },
      },
    ],
  });
  const page = load("pages/grade/index.js");
  page.onLoad({ id: "d1" });
  await page.load();
  assert.deepEqual(page.data.result.steps.map((s) => s.status), ["ok", "wrong", "carried"]);
});

// ---- F19: study time -------------------------------------------------------
test("F19: 批改, 讲一遍 and 资料 count as study; a chat turned to mood stops the clock until it turns back", () => {
  for (const name of ["grade", "teach", "material"]) {
    assert.match(read(`pages/${name}/index.js`), /Page\(studyClock\.track\(\{/, name);
    assert.match(read(`pages/${name}/index.wxml`).split("\n")[0], /capture-bind:touchstart="studyTouch"/, name);
  }
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.setData({ thread: { id: "s1", scene: "study" } });
  assert.equal(page.studyOff(), false);
  page.sceneTurn({ id: "s1", scene: "mood" });
  assert.equal(h.touches, 1, "the study time so far is settled first");
  page.setData({ thread: { id: "s1", scene: "mood" } });
  assert.equal(page.studyOff(), true);
  page.sceneTurn({ id: "s1", scene: "mood" });
  assert.equal(h.touches, 1);
  page.sceneTurn({ id: "s1", scene: "study" });
  assert.equal(h.touches, 2, "and again on the way back");
  // Through the server's answer to 换成心情.
  h.routes["PATCH /v1/chat/threads/s1"] = () => ({ thread: { id: "s1", scene: "study" } });
  return page.patchThread({ scene: "study" }).then(() => {
    assert.equal(h.touches, 3);
    assert.equal(page.studyOff(), false);
  });
});

// ---- F20, 12: the 讲一遍 history -------------------------------------------
test("F20 / 12 讲一遍: the latest 3 under a heading, 全部记录 opens the rest; a failed load keeps them and says so", async () => {
  const rows = (from, n) => Array.from({ length: n }, (_, i) => ({ id: `k${from + i}`, title: "题", tool: "teach", open: false, updatedAt: "2026-10-18T00:00:00Z" }));
  h.routes["GET /v1/chat/threads"] = (body, url) => (/before=/.test(url) ? { threads: rows(20, 2), next: null } : { threads: rows(0, 20), next: "x|1" });
  const page = load("pages/teach/index.js");
  page.onLoad({});
  page.alive = true;
  page.startView();
  await settle();
  assert.equal(page.data.history.length, 20);
  assert.equal(page.data.historyAll, false);
  const wxml = read("pages/teach/index.wxml");
  assert.match(wxml, /<text class="sh-t">讲过的<\/text>/);
  assert.match(wxml, /wx:for="\{\{history\}\}" wx:key="id" wx:if="\{\{historyAll \|\| index < 3\}\}"/);
  assert.match(wxml, /wx:if="\{\{!historyAll && \(history\.length > 3 \|\| historyMore\)\}\}" class="more-line"[^>]*bindtap="showAllHistory"[^>]*>全部记录</);
  assert.ok(wxml.indexOf("全部记录") < wxml.indexOf("或者挑一个知识点"));
  page.showAllHistory();
  assert.equal(page.data.historyAll, true);
  const more = page.moreHistory();
  assert.equal(page.data.historyBusy, true);
  await more;
  assert.equal(page.data.historyBusy, false);
  assert.equal(page.data.history.length, 22);
  // The first load fails: what is shown stays, with 再试一次.
  h.routes["GET /v1/chat/threads"] = () => {
    throw lost();
  };
  await page.history();
  assert.equal(page.data.history.length, 22);
  assert.equal(page.data.historyFailed, true);
  assert.match(wxml, /wx:if="\{\{historyFailed\}\}" class="alert">记录没打开<text class="link" bindtap="retryHistory">再试一次/);
  h.routes["GET /v1/chat/threads"] = () => ({ threads: rows(0, 2), next: null });
  await page.retryHistory();
  assert.equal(page.data.historyFailed, false);
});

// ---- 11, 13, 14, V1 ----------------------------------------------------------
test("11 更早的记录 is a full row in the link colour; 13 suggested cards show their kind; 14 search stops at 40; V1 the input bar clears the gesture bar", () => {
  for (const name of ["grade", "teach", "ask"]) {
    const wxml = read(`pages/${name}/index.wxml`);
    assert.doesNotMatch(wxml, /class="foot center link"/, name);
    assert.match(wxml, /class="more-line"[^>]*>\{\{(historyBusy|moreBusy) \? '打开中…' : '更早的记录'\}\}/, name);
    const css = read(`pages/${name}/index.wxss`);
    assert.match(css, /\.more-line \{[^}]*min-height: 88rpx;[^}]*color: var\(--link\);/, name);
  }
  assert.match(read("components/chat-panel/index.wxml"), /src="\/assets\/icons\/card-\{\{item\.kind \|\| item\.type\}\}\.svg"/);
  assert.match(read("pages/chat-history/index.wxml"), /<input class="search"[^>]*maxlength="40"/);
  assert.match(read("pages/ask/index.wxml"), /class="composer \{\{kb \? 'kb-up' : ''\}\}" style="bottom:\{\{kb\}\}px"/);
  const css = read("pages/ask/index.wxss");
  assert.match(css, /\.composer \{ padding-bottom: calc\(18rpx \+ env\(safe-area-inset-bottom\)\); \}/);
  assert.match(css, /\.composer\.kb-up \{ padding-bottom: 18rpx; \}/);
});

test("11 解题 history: 更早的记录 says 打开中… while it loads", async () => {
  const next = later();
  h.routes["GET /v1/chat/threads"] = () => next.promise;
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.setData({ threads: [{ id: "s0", updatedAt: "2026-10-18T00:00:00Z" }] });
  const loading = page.moreThreads();
  assert.equal(page.data.moreBusy, true);
  next.resolve({ threads: [], next: null });
  await loading;
  assert.equal(page.data.moreBusy, false);
});

// ---- V5: the problem typeset -----------------------------------------------
test("V5 批改: a problem with formulas shows typeset; tapped, its text with the preview under it and 好了; a plain one is a box", async () => {
  const renders = [];
  h.routes["POST /v1/render"] = (body) => {
    renders.push(body.text);
    return { blocks: para(`排好:${body.text}`) };
  };
  const scanned = [{ text: "求 $x^2$ 的导数", blocks: para("求 x² 的导数") }];
  h.routes["UPLOAD /v1/chat/scan"] = () => ({ type: "solution", imageId: "img5", homework: 0, problems: scanned, solution: { steps: ["2x"], unclear: "", blocks: para("2x") }, suggest: null });
  const page = load("pages/grade/index.js");
  page.onLoad({});
  await page.read({ tempFilePath: "/tmp/d.jpg", size: 10 });
  await settle();
  assert.equal(page.data.problemTex, true);
  assert.deepEqual(page.data.problemView, para("求 x² 的导数"), "the scan's own typeset first");
  assert.equal(page.data.problemEditing, false);
  page.editProblem();
  assert.equal(page.data.problemEditing, true);
  page.onProblem({ detail: { value: "求 $x^3$ 的导数" } });
  await wait(450);
  await settle();
  assert.deepEqual(page.data.problemView, para("排好:求 $x^3$ 的导数"));
  await page.problemDone();
  assert.equal(page.data.problemEditing, false);
  // Plain text stays a box.
  page.onProblem({ detail: { value: "求函数的单调区间" } });
  assert.equal(page.data.problemTex, false);
  const wxml = read("pages/grade/index.wxml");
  assert.match(wxml, /wx:if="\{\{problemTex && !problemEditing\}\}" class="gr-problem"[^>]*bindtap="editProblem"/);
  assert.match(wxml, /wx:if="\{\{problemEditing && problemTex\}\}" class="pv-foot"[\s\S]*?bindtap="problemDone"[^>]*>好了</);
  // The same rule as step-edit, from one place.
  assert.match(read("components/step-edit/index.js"), /require\("\.\.\/\.\.\/utils\/tex"\)/);
  assert.doesNotMatch(read("components/step-edit/index.js"), /const WORDS/);
});

test("V5 解题: after 没认对？改一下, the typeset preview shows under the box; 好了 goes back to it typeset", async () => {
  h.routes["POST /v1/render"] = (body) => ({ blocks: para(`排好:${body.text}`) });
  h.routes["UPLOAD /v1/chat/scan"] = () => SCAN;
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  await settle();
  page.editConfirm();
  assert.equal(page.data.confirm.editing, true);
  page.onConfirmText({ detail: { value: "求 $x^3$ 的导数" } });
  await wait(450);
  await settle();
  assert.deepEqual(page.data.confirm.pv, para("排好:求 $x^3$ 的导数"));
  await page.confirmDone();
  assert.equal(page.data.confirm.editing, false);
  assert.deepEqual(page.data.confirm.blocks, para("排好:求 $x^3$ 的导数"));
  // Plain words show as written.
  page.editConfirm();
  page.onConfirmText({ detail: { value: "求函数的单调区间" } });
  await page.confirmDone();
  assert.deepEqual(page.data.confirm.blocks, para("求函数的单调区间"));
  const wxml = read("pages/ask/index.wxml");
  assert.match(wxml, /wx:if="\{\{confirm\.editing && !confirm\.typed\}\}" class="pv-foot"[\s\S]*?class="pv-rich"><rich blocks="\{\{confirm\.pv\}\}"[\s\S]*?bindtap="confirmDone"[^>]*>好了</);
});

// ── 请求重试与照片恢复 ──
test("解题: a photo read in a conversation is kept at once and goes when used; a page that never showed a check leaves one kept for it", async () => {
  h.routes["UPLOAD /v1/chat/scan"] = () => SCAN;
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.setData({ thread: { id: "s1", mode: "auto", scene: "study" }, messages: [] });
  page.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  await settle();
  assert.equal(page.data.scan.problems.length, 1);
  assert.equal(h.store["tool_draft:ask:one"].scan.imageId, "img1", "kept before the page is left");
  page.onHide();
  page.onUnload();
  assert.equal(h.store["tool_draft:ask:one"].scan.imageId, "img1", "leaving keeps it");
  // An empty 解题 page offers it as 上次拍的题.
  const back = load("pages/ask/index.js");
  back.onLoad();
  back.onShow();
  await settle();
  assert.equal(back.data.confirm.imageId, "img1");
  assert.equal(back.data.confirm.again, true);
  // Used (or closed) in the conversation instead: the kept copy goes.
  const used = load("pages/ask/index.js");
  used.onLoad();
  used.setData({ thread: { id: "s1", mode: "auto", scene: "study" }, messages: [] });
  used.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  await settle();
  used.closeScan();
  assert.equal(h.store["tool_draft:ask:one"], undefined);
  // Left while the photo is read, 解题 opened again at once: that page never
  // showed it, so leaving it does not clear what the read kept.
  const slow = later();
  h.routes["UPLOAD /v1/chat/scan"] = () => slow.promise;
  const first = load("pages/ask/index.js");
  first.onLoad();
  first.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  first.onUnload();
  const second = load("pages/ask/index.js");
  second.onLoad();
  second.onShow();
  await settle();
  slow.resolve(SCAN);
  await settle();
  assert.equal(h.store["tool_draft:ask:one"].scan.imageId, "img1");
  second.onHide();
  second.onUnload();
  assert.equal(h.store["tool_draft:ask:one"].scan.imageId, "img1", "still there for 上次拍的题");
});

test("解题: a retry after leaving and coming back is the same request", async () => {
  let fail = true;
  h.routes["POST /v1/chat/threads/s1/similar"] = () => {
    if (fail) throw lost();
    return { id: "sim1", role: "assistant", kind: "similar", status: "done", blocks: para("同类题") };
  };
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.setData({ thread: { id: "s1", mode: "auto", scene: "study" }, messages: [] });
  page.similar();
  await settle();
  page.onUnload();
  const back = load("pages/ask/index.js");
  back.onLoad();
  back.setData({ thread: { id: "s1", mode: "auto", scene: "study" }, messages: [] });
  fail = false;
  back.similar();
  await settle();
  const sent = h.calls.filter((c) => c.url === "/v1/chat/threads/s1/similar").map((c) => c.body.clientId);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
  assert.equal(h.store["tool_draft:asking:one"].similar.done, true, "answered: the next one is a new request");
  back.similar();
  await settle();
  assert.notEqual(h.calls.filter((c) => c.url === "/v1/chat/threads/s1/similar").at(-1).body.clientId, sent[0]);
});

// ---- what must always hold -------------------------------
// A photo read and paid for stays kept until the server has what was made of
// it, or the learner closes it; an id stays with the page that sent it,
// and only its own answer ends it.
const refused = () => Object.assign(new Error("今天的额度用完了，明天再来"), { code: "QUOTA_EXCEEDED", statusCode: 429 });
function streams() {
  const sent = [];
  require(file("utils/stream.js")).send = (url, body, onEvent) => {
    const call = { url, body, onEvent, ...later() };
    sent.push(call);
    return { promise: call.promise, abort() {} };
  };
  return sent;
}
const started = (call, id) =>
  call.onEvent({ e: "start", thread: { id, mode: "auto", scene: "study", title: "求导" }, question: user(`q_${id}`, call.body.problem.text, { kind: "problem" }), replyId: `r_${id}` }, call.body.clientId);

test("解题: 问这题 refused by the allowance shows the problems again, the reason inside the sheet, and the photo stays kept; it goes once the server has the question", async () => {
  h.routes["UPLOAD /v1/chat/scan"] = () => SCAN;
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  const sent = streams();
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.setData({ thread: { id: "s1", mode: "auto", scene: "study" }, messages: [] });
  page.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  await settle();
  page.askProblem({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(sent[0].body.imageId, "img1");
  assert.equal(h.store["tool_draft:ask:one"].scan.imageId, "img1", "kept while the server has not taken it");
  page.onHide();
  assert.equal(h.store["tool_draft:ask:one"].scan.imageId, "img1");
  sent[0].reject(refused());
  await settle();
  assert.deepEqual(page.data.messages, []);
  assert.equal(page.data.scan.imageId, "img1", "the problems show again");
  assert.equal(page.data.error, "今天的额度用完了，明天再来");
  assert.equal(h.store["tool_draft:ask:one"].scan.imageId, "img1");
  const wxml = read("pages/ask/index.wxml");
  assert.match(wxml, /wx:if="\{\{error && !scan\}\}" class="alert"/);
  assert.match(wxml, /class="pop" catchtap="noop">[\s\S]*?wx:if="\{\{error\}\}" class="alert">\{\{error\}\}/);
  // Asked again with the allowance back: the server has it (start), the kept copy goes.
  page.askProblem({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(sent[1].body.imageId, "img1");
  assert.equal(h.store["tool_draft:ask:one"].scan.imageId, "img1");
  started(sent[1], "t1");
  assert.equal(h.store["tool_draft:ask:one"], undefined);
  assert.equal(h.calls.filter((c) => c.method === "UPLOAD").length, 1, "read once");
});

test("解题: the same for the 拍一道题 check: left while asking, the photo stays until the start; refused, the check comes back still kept", async () => {
  h.routes["UPLOAD /v1/chat/scan"] = () => SCAN;
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  const sent = streams();
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  await settle();
  assert.equal(page.data.confirm.imageId, "img1");
  page.choose({ currentTarget: { dataset: { way: "solution" } } });
  page.onHide();
  assert.equal(h.store["tool_draft:ask:one"].confirm.imageId, "img1", "not dropped before the server has it");
  sent[0].reject(refused());
  await settle();
  assert.equal(page.data.confirm.imageId, "img1");
  page.onHide();
  assert.equal(h.store["tool_draft:ask:one"].confirm.imageId, "img1");
  page.choose({ currentTarget: { dataset: { way: "solution" } } });
  started(sent[1], "t2");
  page.onHide();
  assert.equal(h.store["tool_draft:ask:one"], undefined, "the server has it");
});

test("解题: 逐题批改这一页 not made (the allowance) shows the page again, still kept; made, it goes", async () => {
  h.routes["UPLOAD /v1/chat/scan"] = () => ({ ...SCAN, type: "homework", homework: 3, problems: [SCAN.problems[0], SCAN.problems[0], SCAN.problems[0]] });
  h.routes["POST /v1/chat/homework"] = () => {
    throw refused();
  };
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.setData({ thread: { id: "s1", mode: "auto", scene: "study" }, messages: [] });
  page.scanPhoto({ tempFilePath: "/tmp/p.jpg", size: 10 }, "problem");
  await settle();
  assert.equal(page.data.scan.homework, 3);
  page.gradeHomework();
  await settle();
  assert.equal(page.data.scan.imageId, "img1");
  assert.equal(page.data.error, "今天的额度用完了，明天再来");
  assert.equal(h.store["tool_draft:ask:one"].scan.imageId, "img1");
  h.routes["POST /v1/chat/homework"] = () => ({ id: "hw9" });
  page.gradeHomework();
  await settle();
  assert.equal(h.nav.at(-1), "/pages/grade/index?id=hw9");
  assert.equal(h.store["tool_draft:ask:one"], undefined);
});

test("解题: a page left before answering late does not end the id a newer page is retrying; another account's id stays", async () => {
  const calls = [];
  h.routes["POST /v1/chat/practice"] = () => {
    const call = later();
    calls.push(call);
    return call.promise;
  };
  h.routes["GET /v1/chat/threads/p1"] = () => ({ thread: { id: "p1", mode: "auto", scene: "study" }, messages: [] });
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  const made = () => h.calls.filter((c) => c.url === "/v1/chat/practice").map((c) => c.body.clientId);
  const old = load("pages/ask/index.js");
  old.onLoad();
  old.practice("definite");
  await settle();
  old.onUnload();
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.practice("definite");
  await settle();
  // The old page's answer comes now; the new page's call then times out.
  calls[0].resolve({ thread: { id: "p1" } });
  await settle();
  calls[1].reject(lost());
  await settle();
  page.practice("definite");
  await settle();
  assert.deepEqual(made(), [made()[0], made()[0], made()[0]], "one request, however the answers come");
  // Answered: the next 出题 is a new request.
  calls[2].resolve({ thread: { id: "p1" } });
  await settle();
  assert.equal(h.store["tool_draft:asking:one"].practice.done, true);
  const next = load("pages/ask/index.js");
  next.onLoad();
  next.practice("definite");
  await settle();
  assert.notEqual(made().at(-1), made()[0]);
  // Another account signed in meanwhile: the first account's late answer leaves its id.
  h.user = "two";
  const two = load("pages/ask/index.js");
  two.onLoad();
  two.practice("limit");
  await settle();
  const theirs = made().at(-1);
  calls[3].resolve({ thread: { id: "p1" } });
  await settle();
  assert.equal(h.store["tool_draft:asking:two"].practice.clientId, theirs);
  assert.equal(h.store["tool_draft:asking:two"].practice.done, undefined);
});

test("解题: an id made while the session had run out is kept once signed in again, and the retry sends it", async () => {
  let n = 0;
  h.routes["POST /v1/chat/threads/s1/similar"] = () => {
    h.user = "one";
    if (++n === 1) throw lost();
    return { id: "sim1", role: "assistant", kind: "similar", status: "done", blocks: para("同类题") };
  };
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.setData({ thread: { id: "s1", mode: "auto", scene: "study" }, messages: [] });
  h.user = null;
  require(file("utils/auth.js")).login = () => {
    h.user = "one";
    return Promise.resolve({ id: "one" });
  };
  page.similar();
  await settle();
  const sent = h.calls.filter((c) => c.url === "/v1/chat/threads/s1/similar").map((c) => c.body.clientId);
  assert.equal(h.store["tool_draft:asking:one"].similar.clientId, sent[0], "kept once signed in");
  page.similar();
  await settle();
  const again = h.calls.filter((c) => c.url === "/v1/chat/threads/s1/similar").map((c) => c.body.clientId);
  assert.equal(again[1], again[0]);
});

// ---- 整页批改  ------------------------------------
const soon = (ms) => ({
  ...HELD,
  homework: { ...HELD.homework, items: HELD.homework.items.map((item) => ({ ...item, holdUntil: new Date(Date.now() + ms).toISOString() })) },
});

test("整页批改: 再批一份 stops the old page's refresh; an answer for the old page does not bring it back", async () => {
  const page = load("pages/grade/index.js");
  page.onLoad({});
  page.show(soon(50));
  assert.equal(page.data.items[0].waiting, true);
  page.again();
  await wait(1300);
  assert.equal(h.calls.filter((c) => c.url.startsWith("/v1/chat/threads/?")).length, 0, "no refresh without a page");
  assert.equal(page.data.stage, "start");
  assert.equal(page.data.error, "");
  // A refresh already on its way when 再批一份 is tapped.
  const answer = later();
  h.routes["GET /v1/chat/threads/hw1"] = () => answer.promise;
  page.show(soon(60000));
  page.load();
  page.again();
  answer.resolve({ thread: soon(60000), messages: [] });
  await settle();
  assert.equal(page.data.stage, "start");
  assert.equal(page.data.id, "");
  page.onUnload();
});

test("整页批改: when the allowance comes back offline, the held problem shows 可以批了 anyway", async () => {
  h.routes["GET /v1/chat/threads/hw1"] = () => {
    throw lost();
  };
  const page = load("pages/grade/index.js");
  page.onLoad({});
  page.show(soon(50));
  assert.equal(page.data.items[0].waiting, true);
  await wait(1300);
  assert.equal(h.calls.filter((c) => c.url.startsWith("/v1/chat/threads/hw1")).length, 1, "the refresh was tried");
  assert.equal(page.data.items[0].waiting, false);
  assert.equal(page.data.items[0].heldText, "可以批了");
  assert.equal(page.data.loadFailed, true);
  page.onUnload();
});

// ---- the account a session that ran out signs back into --
// As utils/session.js keeps it: the session has run out, its account stays.
const ranOut = (id) => ({ token: "old", user: { id }, expiresAt: "2026-01-01T00:00:00.000Z" });
const signsInAs = (id) => {
  require(file("utils/auth.js")).login = () => {
    h.user = id;
    return Promise.resolve({ id });
  };
};

test("解题: the session ran out; the photo read as the upload signs in again is kept for that account, page open or left", async () => {
  h.routes["UPLOAD /v1/chat/scan"] = () => {
    h.user = "one";
    return SCAN;
  };
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.setData({ thread: { id: "s1", mode: "auto", scene: "study" }, messages: [] });
  h.user = null;
  h.store.zhiye_session = ranOut("one");
  page.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  await settle();
  assert.equal(page.data.scan.imageId, "img1");
  assert.equal(h.store["tool_draft:ask:one"].scan.imageId, "img1", "kept at once");
  // Left while it is read.
  delete h.store["tool_draft:ask:one"];
  const reading = later();
  h.routes["UPLOAD /v1/chat/scan"] = () => reading.promise;
  h.user = null;
  const left = load("pages/ask/index.js");
  left.onLoad();
  left.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  left.onUnload();
  h.user = "one";
  reading.resolve(SCAN);
  await settle();
  assert.equal(h.store["tool_draft:ask:one"].confirm.imageId, "img1", "上次拍的题 when 解题 opens again");
  // Nobody signed in at all: kept for the account the upload signed in as.
  delete h.store["tool_draft:ask:one"];
  delete h.store.zhiye_session;
  h.user = null;
  h.routes["UPLOAD /v1/chat/scan"] = () => SCAN;
  const fresh = load("pages/ask/index.js");
  fresh.onLoad();
  fresh.onShow();
  fresh.setData({ thread: { id: "s1", mode: "auto", scene: "study" }, messages: [] });
  signsInAs("one");
  fresh.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  await settle();
  assert.equal(h.store["tool_draft:ask:one"].scan.imageId, "img1");
  assert.equal(fresh.data.thread.id, "s1", "a page shown with nobody signed in is the first account's");
  // Signed back in as another account (the one that ran out is gone): read
  // as that one, so it is its photo : the page moves to it and
  // offers the photo as a check; the conversation of the one before goes.
  delete h.store["tool_draft:ask:one"];
  h.user = null;
  h.store.zhiye_session = ranOut("one");
  h.routes["UPLOAD /v1/chat/scan"] = () => SCAN;
  const other = load("pages/ask/index.js");
  other.onLoad();
  other.onShow();
  other.setData({ thread: { id: "s1", mode: "auto", scene: "study" }, messages: [user("u1", "求导")] });
  signsInAs("two");
  other.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  await settle();
  assert.equal(other.data.thread, null);
  assert.deepEqual(other.data.messages, []);
  assert.equal(other.data.confirm.imageId, "img1");
  assert.equal(h.store["tool_draft:ask:two"].confirm.imageId, "img1");
  assert.equal(h.store["tool_draft:ask:one"], undefined);
  // Read as an account signed in no more by the time it comes back: not shown, not kept.
  delete h.store["tool_draft:ask:two"];
  const late = later();
  h.routes["UPLOAD /v1/chat/scan"] = () => late.promise;
  const gone = load("pages/ask/index.js");
  gone.onLoad();
  gone.onShow();
  gone.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  await settle();
  h.user = "three";
  late.resolve(SCAN);
  await settle();
  assert.equal(gone.data.confirm, null);
  assert.equal(gone.data.scanning, false);
  assert.equal(h.store["tool_draft:ask:two"], undefined);
  assert.equal(h.store["tool_draft:ask:three"], undefined);
});

test("解题: a session that ran out is not another account: the page keeps what it has open", async () => {
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  h.store.zhiye_session = ranOut("one");
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onShow();
  page.setData({ thread: { id: "s1", mode: "auto", scene: "study" }, messages: [user("u1", "求导")] });
  h.user = null;
  page.onShow();
  assert.equal(page.data.thread.id, "s1");
  h.user = "two";
  page.onShow();
  assert.equal(page.data.thread, null, "another account starts clean");
});

test("解题: an old page timing out late does not put its id back over a newer request's; one answered on another page stays answered", async () => {
  const calls = [];
  h.routes["POST /v1/chat/practice"] = () => {
    const call = later();
    calls.push(call);
    return call.promise;
  };
  h.routes["GET /v1/chat/threads/p1"] = () => ({ thread: { id: "p1", mode: "auto", scene: "study" }, messages: [] });
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  const made = () => h.calls.filter((c) => c.url === "/v1/chat/practice").map((c) => c.body.clientId);
  const open = () => {
    const page = load("pages/ask/index.js");
    page.onLoad();
    return page;
  };
  // A sends cid1 and is left; B sends the same, answered; C asks another chapter.
  const a = open();
  a.practice("definite");
  await settle();
  a.onUnload();
  const b = open();
  b.practice("definite");
  await settle();
  calls[1].resolve({ thread: { id: "p1" } });
  await settle();
  const c = open();
  c.practice("limit");
  await settle();
  // A times out only now.
  calls[0].reject(lost());
  await settle();
  assert.equal(h.store["tool_draft:asking:one"].practice.clientId, made()[2]);
  c.onUnload();
  const d = open();
  d.practice("limit");
  await settle();
  assert.deepEqual(made(), [made()[0], made()[0], made()[2], made()[2]]);
  assert.notEqual(made()[2], made()[0]);
  // E asks, F (another page) gets the same answered; E times out and asks
  // again: what the server made for it, and the id stays answered.
  const e = open();
  e.practice("definite");
  await settle();
  const f = open();
  f.practice("definite");
  await settle();
  assert.equal(made()[5], made()[4]);
  calls[5].resolve({ thread: { id: "p1" } });
  await settle();
  calls[4].reject(lost());
  await settle();
  e.practice("definite");
  await settle();
  assert.equal(made()[6], made()[4]);
  assert.equal(h.store["tool_draft:asking:one"].practice.done, true, "still answered");
  const g = open();
  g.practice("definite");
  await settle();
  assert.notEqual(made()[7], made()[4], "a new page asks anew");
});

test("解题: the session ran out: the id is made once signed in again and kept before it is sent", async () => {
  const pending = later();
  let keptWhenSent;
  h.routes["POST /v1/chat/practice"] = (body) => {
    const kept = h.store["tool_draft:asking:one"];
    keptWhenSent = kept && kept.practice && kept.practice.clientId;
    return keptWhenSent === body.clientId && h.calls.filter((c) => c.url === "/v1/chat/practice").length === 1 ? pending.promise : new Promise(() => {});
  };
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  h.user = null;
  h.store.zhiye_session = ranOut("one");
  signsInAs("one");
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.practice("definite");
  await settle();
  const sent = () => h.calls.filter((c) => c.url === "/v1/chat/practice").map((c) => c.body.clientId);
  assert.equal(keptWhenSent, sent()[0], "kept before it went");
  // Left (or the app closed) before any answer; opened again, the retry is the same request.
  page.onUnload();
  const again = load("pages/ask/index.js");
  again.onLoad();
  again.practice("definite");
  await settle();
  assert.deepEqual(sent(), [sent()[0], sent()[0]]);
  // Nobody signed in at all: the same, for the account it signs in as.
  delete h.store["tool_draft:asking:one"];
  delete h.store.zhiye_session;
  h.user = null;
  h.routes["POST /v1/chat/threads/s1/similar"] = () => new Promise(() => {});
  const sim = load("pages/ask/index.js");
  sim.onLoad();
  sim.setData({ thread: { id: "s1", mode: "auto", scene: "study" }, messages: [] });
  sim.similar();
  await settle();
  const similar = h.calls.filter((c) => c.url === "/v1/chat/threads/s1/similar").map((c) => c.body.clientId);
  assert.equal(h.store["tool_draft:asking:one"].similar.clientId, similar[0]);
});

test("整页批改: away while the allowance came back, then back offline: the held problem shows 可以批了", async () => {
  h.routes["GET /v1/chat/threads/hw1"] = () => {
    throw lost();
  };
  const page = load("pages/grade/index.js");
  page.onLoad({});
  page.show(soon(50));
  assert.equal(page.data.items[0].waiting, true);
  page.onHide();
  await wait(200);
  assert.equal(page.data.items[0].waiting, true, "nothing runs while away");
  page.onShow();
  await settle();
  assert.equal(h.calls.filter((c) => c.url.startsWith("/v1/chat/threads/hw1")).length, 1, "the refresh was tried");
  assert.equal(page.data.items[0].waiting, false);
  assert.equal(page.data.items[0].heldText, "可以批了");
  assert.equal(page.data.loadFailed, true);
  page.onUnload();
});

// ---- what a page shows is its account's only -------------
test("解题: the empty page, the session of one ran out and signing in gives two: the photo is two's, kept for two only, page open or left", async () => {
  h.routes["UPLOAD /v1/chat/scan"] = () => SCAN;
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  h.user = null;
  h.store.zhiye_session = ranOut("one");
  h.store["tool_draft:ask:one"] = { confirm: { key: "k-old1", imageId: "old1", problems: [{ text: "一的题" }] }, stuck: null, scan: null };
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onShow();
  assert.equal(page.data.confirm.imageId, "old1", "one's photo, offered while its session ran out");
  signsInAs("two");
  page.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  await settle();
  assert.equal(page.data.confirm.imageId, "img1");
  assert.equal(h.store["tool_draft:ask:two"].confirm.imageId, "img1");
  assert.equal(h.store["tool_draft:ask:one"].confirm.imageId, "old1", "one's own stays one's");
  page.onHide();
  assert.equal(h.store["tool_draft:ask:two"].confirm.imageId, "img1");
  // Left while it is read: kept for two, the account it was read as.
  delete h.store["tool_draft:ask:two"];
  h.user = null;
  const reading = later();
  h.routes["UPLOAD /v1/chat/scan"] = () => reading.promise;
  const left = load("pages/ask/index.js");
  left.onLoad();
  left.onShow();
  left.setData({ confirm: null });
  signsInAs("two");
  left.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  await settle();
  left.onUnload();
  reading.resolve(SCAN);
  await settle();
  assert.equal(h.store["tool_draft:ask:two"].confirm.imageId, "img1");
  assert.equal(h.store["tool_draft:ask:one"].confirm.imageId, "old1");
});

test("解题: 拍下我写的 for one's problem, signing in gives two: not read (nor paid) for two, one's problem not kept for two, nothing put into two's problem", async () => {
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  const STEPS = { type: "solution", imageId: "img2", problems: [], solution: { steps: ["y'=2x"], unclear: "" }, notes: "" };
  const realPick = require(file("utils/tools.js")).pick;
  require(file("utils/tools.js")).pick = () => Promise.resolve({ tempFilePath: "/tmp/s.jpg", size: 10 });
  const ONES = { confirm: { key: "k-old1", imageId: "old1", problems: [{ text: "一的题" }] }, stuck: { lines: [], text: "" }, scan: null };
  // Page open.
  h.user = null;
  h.store.zhiye_session = ranOut("one");
  h.store["tool_draft:ask:one"] = ONES;
  h.routes["UPLOAD /v1/chat/scan"] = () => STEPS;
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onShow();
  assert.equal(page.data.confirm.imageId, "old1");
  page.setData({ stuck: { lines: [], text: "" } });
  signsInAs("two");
  page.pickStuck({ currentTarget: { dataset: { source: "album" } } });
  await settle();
  assert.equal(page.data.confirm, null, "one's problem is not shown to two");
  assert.equal(page.data.scanning, false);
  assert.equal(h.calls.filter((c) => c.method === "UPLOAD").length, 0, "not read for two");
  page.onHide();
  assert.equal(h.store["tool_draft:ask:two"], undefined, "nothing of one's kept for two");
  assert.deepEqual(h.store["tool_draft:ask:one"].stuck.lines, []);
  // Left while it is read; two has a problem of its own kept: the steps stay out of it.
  h.user = null;
  const TWOS = { confirm: { key: "k-two1", imageId: "two1", problems: [{ text: "二的题" }] }, stuck: { lines: [], text: "" }, scan: null };
  h.store["tool_draft:ask:two"] = TWOS;
  const steps = later();
  h.routes["UPLOAD /v1/chat/scan"] = () => steps.promise;
  const left = load("pages/ask/index.js");
  left.onLoad();
  left.onShow();
  assert.equal(left.data.confirm.imageId, "old1");
  left.setData({ stuck: { lines: [], text: "" } });
  signsInAs("two");
  left.pickStuck({ currentTarget: { dataset: { source: "album" } } });
  await settle();
  left.onUnload();
  steps.resolve(STEPS);
  await settle();
  require(file("utils/tools.js")).pick = realPick;
  assert.equal(h.calls.filter((c) => c.method === "UPLOAD").length, 0);
  assert.deepEqual(h.store["tool_draft:ask:two"], TWOS);
  assert.deepEqual(h.store["tool_draft:ask:one"].stuck.lines, []);
});

test("解题: another account signed in elsewhere: leaving keeps or drops nothing of this page for it", async () => {
  h.routes["UPLOAD /v1/chat/scan"] = () => SCAN;
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onShow();
  page.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  await settle();
  assert.equal(h.store["tool_draft:ask:one"].confirm.imageId, "img1");
  const TWOS = { confirm: { key: "k-two1", imageId: "two1", problems: [{ text: "二的题" }] }, stuck: null, scan: null };
  h.store["tool_draft:ask:two"] = TWOS;
  h.user = "two";
  page.onHide();
  assert.deepEqual(h.store["tool_draft:ask:two"], TWOS);
  page.setData({ confirm: null });
  page.onUnload();
  assert.deepEqual(h.store["tool_draft:ask:two"], TWOS, "not dropped either");
  assert.equal(h.store["tool_draft:ask:one"].confirm.imageId, "img1");
  // Shown again as two: the page starts clean; what it showed for one does
  // not make it drop what two keeps later.
  delete h.store["tool_draft:ask:two"];
  h.user = "one";
  const shown = load("pages/ask/index.js");
  shown.onLoad();
  shown.onShow();
  assert.equal(shown.data.confirm.imageId, "img1");
  h.user = "two";
  shown.onShow();
  assert.equal(shown.data.confirm, null);
  h.store["tool_draft:ask:two"] = TWOS;
  shown.onHide();
  assert.deepEqual(h.store["tool_draft:ask:two"], TWOS);
});

test("解题: one's session refused meanwhile, nobody signed in: 拍下我写的 signs one in again and reads the steps into one's problem", async () => {
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  const STEPS = { type: "solution", imageId: "img2", problems: [], solution: { steps: ["y'=2x"], unclear: "" }, notes: "" };
  const realPick = require(file("utils/tools.js")).pick;
  require(file("utils/tools.js")).pick = () => Promise.resolve({ tempFilePath: "/tmp/s.jpg", size: 10 });
  h.routes["UPLOAD /v1/chat/scan"] = () => STEPS;
  h.store["tool_draft:ask:one"] = { confirm: { key: "k-old1", imageId: "old1", problems: [{ text: "一的题" }] }, stuck: { lines: [], text: "" }, scan: null };
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onShow();
  assert.equal(page.data.confirm.imageId, "old1");
  page.setData({ stuck: { lines: [], text: "" } });
  // A request elsewhere was refused: the session is gone.
  h.user = null;
  delete h.store.zhiye_session;
  signsInAs("one");
  page.pickStuck({ currentTarget: { dataset: { source: "album" } } });
  await settle();
  require(file("utils/tools.js")).pick = realPick;
  assert.equal(h.calls.filter((c) => c.method === "UPLOAD").length, 1, "read for one");
  assert.equal(page.data.confirm.imageId, "old1");
  assert.deepEqual(page.data.stuck.lines, ["y'=2x"]);
  assert.deepEqual(h.store["tool_draft:ask:one"].stuck.lines, ["y'=2x"]);
});

test("解题: a page shown with nobody signed in becomes the first account's as it is: away while it answers, the answer still comes in", async () => {
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  const sent = streams();
  h.user = null;
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onShow();
  page.send({ problem: { text: "求导" }, mode: "auto" });
  // The send signed in as one; the learner switches away while it answers.
  h.user = "one";
  page.onHide();
  started(sent[0], "s1");
  assert.equal(page.data.thread.id, "s1");
});

// ---- a late read goes to its own problem only -----------
// A read for a page left meanwhile: when 解题 is open again, it goes to that
// page (D112: one at most), and steps only into the problem they are for.
const stepsFor = (lines) => ({ type: "solution", imageId: "img2", problems: [], solution: { steps: lines, unclear: "" }, notes: "" });
function reopen() {
  const page = load("pages/ask/index.js");
  page.route = "pages/ask/index";
  page.onLoad();
  global.getCurrentPages = () => [page];
  page.onShow();
  return page;
}
function leftReadingSteps(scan = SCAN) {
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  h.routes["UPLOAD /v1/chat/scan"] = () => scan;
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onShow();
  page.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  return settle().then(() => {
    page.choose({ currentTarget: { dataset: { way: "stuck" } } });
    const reading = later();
    h.routes["UPLOAD /v1/chat/scan"] = () => reading.promise;
    require(file("utils/tools.js")).pick = () => Promise.resolve({ tempFilePath: "/tmp/s.jpg", size: 10 });
    page.pickStuck({ currentTarget: { dataset: { source: "album" } } });
    return settle().then(() => {
      page.onUnload();
      return reading;
    });
  });
}

test("解题: left while 拍下我写的 is read and opened again on the same problem: the steps fill the open page and stay after leaving again", async () => {
  const realPick = require(file("utils/tools.js")).pick;
  const reading = await leftReadingSteps();
  const again = reopen();
  assert.equal(again.data.confirm.imageId, "img1");
  assert.deepEqual(again.data.stuck.lines, []);
  reading.resolve(stepsFor(["y'=2x"]));
  await settle();
  require(file("utils/tools.js")).pick = realPick;
  assert.deepEqual(again.data.stuck.lines, ["y'=2x"], "shown on the page open now");
  assert.deepEqual(h.store["tool_draft:ask:one"].stuck.lines, ["y'=2x"]);
  again.onUnload();
  global.getCurrentPages = () => [];
  assert.deepEqual(h.store["tool_draft:ask:one"].stuck.lines, ["y'=2x"], "not written over by the page's old copy");
  const third = reopen();
  assert.deepEqual(third.data.stuck.lines, ["y'=2x"]);
});

test("解题: left while 拍下我写的 is read, opened again and another problem taken up: the late steps go into no other problem", async () => {
  const realPick = require(file("utils/tools.js")).pick;
  for (const late of ["while it is open", "after it is left"]) {
    delete h.store["tool_draft:ask:one"];
    const reading = await leftReadingSteps();
    const again = reopen();
    assert.equal(again.data.confirm.imageId, "img1");
    again.closeConfirm();
    again.onDraft({ detail: { value: "计算 2 + 3" } });
    again.submit();
    again.choose({ currentTarget: { dataset: { way: "stuck" } } });
    again.setData({ "stuck.lines": ["2 + 3 = 5"] });
    if (late === "after it is left") {
      again.onUnload();
      global.getCurrentPages = () => [];
    }
    reading.resolve(stepsFor(["y'=2x"]));
    await settle();
    if (late === "while it is open") {
      assert.deepEqual(again.data.stuck.lines, ["2 + 3 = 5"], late);
      again.onUnload();
      global.getCurrentPages = () => [];
    }
    const kept = h.store["tool_draft:ask:one"];
    assert.equal(kept.confirm.text, "计算 2 + 3", late);
    assert.deepEqual(kept.stuck.lines, ["2 + 3 = 5"], late);
    assert.deepEqual(reopen().data.stuck.lines, ["2 + 3 = 5"], late);
  }
  require(file("utils/tools.js")).pick = realPick;
});

test("解题: a photo read for a page left meanwhile shows on 解题 open again (empty, or only the check it brought back); one in a conversation keeps it, and leaving does not drop it", async () => {
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  const leftReading = () => {
    const reading = later();
    h.routes["UPLOAD /v1/chat/scan"] = () => reading.promise;
    const page = load("pages/ask/index.js");
    page.onLoad();
    page.onShow();
    page.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
    return settle().then(() => {
      page.onUnload();
      return reading;
    });
  };
  // Opened again on the empty page.
  let reading = await leftReading();
  const empty = reopen();
  assert.equal(empty.data.confirm, null);
  reading.resolve(SCAN);
  await settle();
  assert.equal(empty.data.confirm.imageId, "img1");
  assert.equal(h.store["tool_draft:ask:one"].confirm.imageId, "img1");
  empty.onUnload();
  // Opened again on an older kept check (a photo, or a typed one still open
  // to edit): the photo just taken takes its place.
  const OLD = { confirm: { key: "k-old0", imageId: "old0", problems: [{ text: "旧题" }], text: "旧题" }, stuck: null, scan: null };
  const TYPED = { confirm: { key: "k-typed", imageId: "", problems: [{ text: "手打的题" }], text: "手打的题", typed: true, editing: true }, stuck: { lines: [], text: "" }, scan: null };
  for (const before of [OLD, TYPED]) {
    h.store["tool_draft:ask:one"] = before;
    global.getCurrentPages = () => [];
    reading = await leftReading();
    const older = reopen();
    assert.equal(older.data.confirm.key, before.confirm.key);
    reading.resolve(SCAN);
    await settle();
    assert.equal(older.data.confirm.imageId, "img1", before.confirm.key);
    older.onUnload();
    assert.equal(h.store["tool_draft:ask:one"].confirm.imageId, "img1", "not written over by the older check");
  }
  // Opened again on the older check, then asked about it: the late photo is
  // kept as 上次拍的题, and leaving the conversation does not drop it.
  h.store["tool_draft:ask:one"] = OLD;
  global.getCurrentPages = () => [];
  reading = await leftReading();
  const sent = streams();
  const asked = reopen();
  asked.choose({ currentTarget: { dataset: { way: "solution" } } });
  started(sent[0], "s1");
  assert.equal(h.store["tool_draft:ask:one"], undefined, "the photo asked about goes once the server has it");
  reading.resolve(SCAN);
  await settle();
  assert.equal(asked.data.thread.id, "s1");
  assert.equal(h.store["tool_draft:ask:one"].confirm.imageId, "img1");
  asked.onUnload();
  assert.equal(h.store["tool_draft:ask:one"].confirm.imageId, "img1", "not dropped by the page that asked the older one");
});

// ---- a late read goes to its own problem, and only over older
// Steps go to the problem of the photo they were read for, each problem of a
// photo keeping its own 卡住; a late photo or late steps take the place of
// older ones only; a check kept by an older build gets an id when it comes back.
const SCAN2 = {
  type: "problem",
  imageId: "img3",
  problems: [
    { text: "解方程 $x+1=2$", blocks: para("解方程 x+1=2"), unclear: "" },
    { text: "解方程 $2x=4$", blocks: para("解方程 2x=4"), unclear: "" },
  ],
  solution: null,
  notes: "",
  suggest: null,
};
const takeUp = (page, index) => page.pickConfirm({ currentTarget: { dataset: { index } } });
const stuckOn = (page) => page.choose({ currentTarget: { dataset: { way: "stuck" } } });

test("解题: two problems in the photo, 拍下我写的 for 第 1 题 read while left, 第 2 题 taken up and filled: the late steps go into 第 1 题 only, and show again there", async () => {
  const realPick = require(file("utils/tools.js")).pick;
  for (const late of ["while it is open", "after it is left"]) {
    delete h.store["tool_draft:ask:one"];
    global.getCurrentPages = () => [];
    const reading = await leftReadingSteps(SCAN2);
    const again = reopen();
    assert.equal(again.data.confirm.imageId, "img3");
    assert.equal(again.data.confirm.index, 0);
    takeUp(again, 1);
    assert.equal(again.data.stuck, null, "第 2 题 has no 卡住 of its own yet");
    stuckOn(again);
    again.onStuckLines({ detail: { lines: ["x = 2"] } });
    if (late === "after it is left") {
      again.onUnload();
      global.getCurrentPages = () => [];
    }
    reading.resolve(stepsFor(["x + 1 = 2", "x = 1"]));
    await settle();
    if (late === "while it is open") {
      assert.deepEqual(again.data.stuck.lines, ["x = 2"], late);
      again.onUnload();
      global.getCurrentPages = () => [];
    }
    const kept = h.store["tool_draft:ask:one"];
    assert.equal(kept.confirm.index, 1, late);
    assert.deepEqual(kept.stuck.lines, ["x = 2"], late);
    assert.deepEqual(kept.confirm.problems[0].stuck.lines, ["x + 1 = 2", "x = 1"], late);
    const third = reopen();
    assert.deepEqual(third.data.stuck.lines, ["x = 2"], late);
    takeUp(third, 0);
    assert.equal(third.data.confirm.text, "解方程 $x+1=2$");
    assert.deepEqual(third.data.stuck.lines, ["x + 1 = 2", "x = 1"], late);
    takeUp(third, 1);
    assert.deepEqual(third.data.stuck.lines, ["x = 2"], late);
    third.onUnload();
  }
  require(file("utils/tools.js")).pick = realPick;
});

test("解题: on the page open, 第 2 题 taken up while 第 1 题's steps are read: they go into 第 1 题, and 从这里给我提示 for 第 2 题 sends its own only", async () => {
  const realPick = require(file("utils/tools.js")).pick;
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  h.routes["UPLOAD /v1/chat/scan"] = () => SCAN2;
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onShow();
  page.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  await settle();
  stuckOn(page);
  page.onStuckLines({ detail: { lines: ["x + 1 = 2"] } });
  const reading = later();
  h.routes["UPLOAD /v1/chat/scan"] = () => reading.promise;
  require(file("utils/tools.js")).pick = () => Promise.resolve({ tempFilePath: "/tmp/s.jpg", size: 10 });
  page.pickStuck({ currentTarget: { dataset: { source: "album" } } });
  await settle();
  takeUp(page, 1);
  assert.equal(page.data.stuck, null);
  stuckOn(page);
  page.onStuckLines({ detail: { lines: ["x = 2"] } });
  reading.resolve(stepsFor(["x + 1 = 2", "x = 1"]));
  await settle();
  require(file("utils/tools.js")).pick = realPick;
  assert.deepEqual(page.data.stuck.lines, ["x = 2"]);
  assert.deepEqual(page.data.confirm.problems[0].stuck.lines, ["x + 1 = 2", "x = 1"]);
  assert.deepEqual(h.store["tool_draft:ask:one"].confirm.problems[0].stuck.lines, ["x + 1 = 2", "x = 1"]);
  const sent = streams();
  page.sendStuck();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.problem.text, "解方程 $2x=4$");
  assert.match(sent[0].body.text, /x = 2/);
  assert.doesNotMatch(sent[0].body.text, /x = 1/);
});

test("解题: a check kept by f5a5d73 (no id) comes back with one, kept at once: 拍下我写的 fills it, also read while left, and 不要了 drops it", async () => {
  const realPick = require(file("utils/tools.js")).pick;
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  // As f5a5d73's confirmView made it and its page kept it: no key, no at.
  const keptBefore = () => ({
    confirm: {
      imageId: "img1",
      photo: "/tmp/q.jpg",
      title: "认出了这道题",
      problems: [{ text: "求 $x^2$ 的导数", blocks: para("求 x² 的导数"), unclear: "", index: 0 }],
      index: 0,
      text: "求 $x^2$ 的导数",
      blocks: para("求 x² 的导数"),
      unclear: "",
      editing: false,
      typed: false,
      suggest: null,
      notes: "",
    },
    stuck: { lines: [], text: "" },
    scan: { ...SCAN, photo: "/tmp/q.jpg" },
  });
  require(file("utils/tools.js")).pick = () => Promise.resolve({ tempFilePath: "/tmp/s.jpg", size: 10 });
  // Read with the page open.
  h.store["tool_draft:ask:one"] = keptBefore();
  const page = reopen();
  const key = page.data.confirm.key;
  assert.ok(key, "given an id");
  assert.equal(h.store["tool_draft:ask:one"].confirm.key, key, "kept with it at once");
  h.routes["UPLOAD /v1/chat/scan"] = () => stepsFor(["y'=2x"]);
  page.pickStuck({ currentTarget: { dataset: { source: "album" } } });
  await settle();
  assert.deepEqual(page.data.stuck.lines, ["y'=2x"]);
  assert.deepEqual(h.store["tool_draft:ask:one"].stuck.lines, ["y'=2x"]);
  page.closeConfirm();
  assert.equal(h.store["tool_draft:ask:one"], undefined, "不要了 drops it");
  page.onUnload();
  global.getCurrentPages = () => [];
  assert.equal(h.store["tool_draft:ask:one"], undefined);
  // Read while the page is left.
  h.store["tool_draft:ask:one"] = keptBefore();
  const left = reopen();
  const reading = later();
  h.routes["UPLOAD /v1/chat/scan"] = () => reading.promise;
  left.pickStuck({ currentTarget: { dataset: { source: "album" } } });
  await settle();
  left.onUnload();
  global.getCurrentPages = () => [];
  reading.resolve(stepsFor(["y'=2x"]));
  await settle();
  require(file("utils/tools.js")).pick = realPick;
  assert.deepEqual(h.store["tool_draft:ask:one"].stuck.lines, ["y'=2x"]);
  const back = reopen();
  assert.deepEqual(back.data.stuck.lines, ["y'=2x"]);
  back.closeConfirm();
  assert.equal(h.store["tool_draft:ask:one"], undefined, "不要了 drops it");
});

test("解题: an old photo read while left comes back after a newer one was taken and kept: the newer one stays, on the page open again and kept", async () => {
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  const NEWER = { ...SCAN, imageId: "img9", problems: [{ text: "新拍的题", blocks: para("新拍的题"), unclear: "" }] };
  for (const late of ["while it is open", "after it is left"]) {
    delete h.store["tool_draft:ask:one"];
    global.getCurrentPages = () => [];
    // The old photo, left while it is read.
    const reading = later();
    h.routes["UPLOAD /v1/chat/scan"] = () => reading.promise;
    const first = load("pages/ask/index.js");
    first.onLoad();
    first.onShow();
    first.scanPhoto({ tempFilePath: "/tmp/old.jpg", size: 10 }, "problem");
    await settle();
    first.onUnload();
    assert.equal(h.store["tool_draft:ask:one"], undefined, late);
    // Opened again: a new photo, read and kept, then left.
    await wait(5);
    h.routes["UPLOAD /v1/chat/scan"] = () => NEWER;
    const second = reopen();
    second.scanPhoto({ tempFilePath: "/tmp/new.jpg", size: 10 }, "problem");
    await settle();
    assert.equal(second.data.confirm.imageId, "img9", late);
    assert.equal(h.store["tool_draft:ask:one"].confirm.imageId, "img9", late);
    second.onUnload();
    global.getCurrentPages = () => [];
    assert.equal(h.store["tool_draft:ask:one"].confirm.imageId, "img9", late);
    // Opened again on it (or not); the old photo comes back now.
    const third = late === "while it is open" ? reopen() : null;
    if (third) assert.equal(third.data.confirm.imageId, "img9");
    reading.resolve(SCAN);
    await settle();
    if (third) {
      assert.equal(third.data.confirm.imageId, "img9", late);
      third.onUnload();
      global.getCurrentPages = () => [];
    }
    assert.equal(h.store["tool_draft:ask:one"].confirm.imageId, "img9", late);
    const fourth = reopen();
    assert.equal(fourth.data.confirm.imageId, "img9", late);
    fourth.onUnload();
  }
});

test("解题: 拍下我写的 again on the page open again and read first: the earlier read coming back late does not write over it", async () => {
  const realPick = require(file("utils/tools.js")).pick;
  for (const late of ["while it is open", "after it is left"]) {
    delete h.store["tool_draft:ask:one"];
    global.getCurrentPages = () => [];
    const reading = await leftReadingSteps();
    await wait(5);
    const again = reopen();
    h.routes["UPLOAD /v1/chat/scan"] = () => stepsFor(["后拍的一步"]);
    again.pickStuck({ currentTarget: { dataset: { source: "album" } } });
    await settle();
    assert.deepEqual(again.data.stuck.lines, ["后拍的一步"], late);
    if (late === "after it is left") {
      again.onUnload();
      global.getCurrentPages = () => [];
    }
    reading.resolve(stepsFor(["先拍的一步"]));
    await settle();
    if (late === "while it is open") {
      assert.deepEqual(again.data.stuck.lines, ["后拍的一步"], late);
      again.onUnload();
      global.getCurrentPages = () => [];
    }
    assert.deepEqual(h.store["tool_draft:ask:one"].stuck.lines, ["后拍的一步"], late);
  }
  require(file("utils/tools.js")).pick = realPick;
});

// ---- each problem's 卡住 lives as long as the problem ----
// A step deleted from one problem's 卡住 is not put back into another's; a
// photo whose other problem has a 卡住 open stays kept when one is asked, and
// that problem's steps go with it when it is asked.
function stepEdit(props) {
  let definition;
  global.Component = (value) => {
    definition = value;
  };
  delete require.cache[file("components/step-edit/index.js")];
  require(file("components/step-edit/index.js"));
  const c = {
    ...definition.methods,
    data: { ...structuredClone(definition.data), max: 40, placeholder: "", ...props },
    events: [],
    setData(patch) {
      assign(this.data, patch);
    },
    triggerEvent(event, detail) {
      this.events.push([event, detail]);
    },
  };
  definition.lifetimes.attached.call(c);
  // The page sets what it binds; an observer runs on every set, same value or not.
  c.set = (patch) => {
    assign(c.data, patch);
    for (const key of Object.keys(patch)) if (definition.observers[key]) definition.observers[key].call(c, patch[key]);
  };
  return c;
}
const startedOn = (call, id, thread) =>
  call.onEvent(
    { e: "start", thread: { id, mode: "auto", scene: "study", title: "解方程", ...thread }, question: user(`q_${id}`, call.body.problem.text, { kind: "problem" }), replyId: `r_${id}` },
    call.body.clientId,
  );
const album = { currentTarget: { dataset: { source: "album" } } };
function twoProblems() {
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  h.routes["UPLOAD /v1/chat/scan"] = () => SCAN2;
  const page = load("pages/ask/index.js");
  page.route = "pages/ask/index";
  page.onLoad();
  page.onShow();
  page.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  return settle().then(() => page);
}

test("解题: a step deleted from one problem's 卡住 is not put back into another's; the same problem set again keeps 撤销", async () => {
  const c = stepEdit({ lines: ["a", "b"], owner: "k1#1" });
  c.remove({ currentTarget: { dataset: { index: 1 } } });
  assert.deepEqual(c.data.undo, { index: 1, text: "b", no: 2 });
  c.set({ owner: "k1#1", lines: ["a"] });
  assert.deepEqual(c.data.undo, { index: 1, text: "b", no: 2 }, "the same problem: 撤销 stays");
  c.set({ owner: "k1#0", lines: ["x + 1 = 2"] });
  assert.equal(c.data.undo, null);
  const before = c.events.length;
  c.restore();
  assert.equal(c.events.length, before, "nothing put back");
  await settle();
  clearTimeout(c.undoTimer);
  clearTimeout(c.typeTimer);
  assert.match(read("pages/ask/index.wxml"), /<step-edit owner="\{\{confirm\.key \+ '#' \+ confirm\.index\}\}"/);
});

test("解题: two problems, 第 1 题's steps read, 第 2 题 asked: the photo stays kept on 第 1 题 with its steps, asked from the conversation or from 上次拍的题; once both are asked it goes", async () => {
  const realPick = require(file("utils/tools.js")).pick;
  for (const from of ["the conversation", "上次拍的题"]) {
    delete h.store["tool_draft:ask:one"];
    global.getCurrentPages = () => [];
    const page = await twoProblems();
    stuckOn(page);
    require(file("utils/tools.js")).pick = () => Promise.resolve({ tempFilePath: "/tmp/s.jpg", size: 10 });
    h.routes["UPLOAD /v1/chat/scan"] = () => stepsFor(["x + 1 = 2", "x = 1"]);
    page.pickStuck(album);
    await settle();
    assert.deepEqual(page.data.stuck.lines, ["x + 1 = 2", "x = 1"], from);
    takeUp(page, 1);
    stuckOn(page);
    page.onStuckLines({ detail: { lines: ["2x = 4"] } });
    const sent = streams();
    page.sendStuck();
    assert.equal(sent[0].body.problem.text, "解方程 $2x=4$", from);
    assert.deepEqual(sent[0].body.problem.pending, ["解方程 $x+1=2$"], from);
    assert.equal(sent[0].body.index, undefined, "which problem is not sent");
    startedOn(sent[0], "s1", { imageId: "img3", pending: ["解方程 $x+1=2$"] });
    const kept = h.store["tool_draft:ask:one"];
    assert.equal(kept.confirm.index, 0, from);
    assert.equal(kept.confirm.text, "解方程 $x+1=2$", from);
    assert.deepEqual(kept.stuck.lines, ["x + 1 = 2", "x = 1"], from);
    assert.equal(kept.confirm.problems[1].asked, true, from);
    assert.equal(kept.confirm.problems[1].stuck, null, from);
    sent[0].resolve({ finished: true });
    await settle();
    page.onHide();
    assert.ok(h.store["tool_draft:ask:one"], "leaving the conversation does not drop it");
    page.onShow();
    let asking = page;
    if (from === "the conversation") {
      page.pickPending({ currentTarget: { dataset: { index: 0 } } });
    } else {
      page.onUnload();
      global.getCurrentPages = () => [];
      asking = reopen();
      assert.equal(asking.data.confirm.again, true);
      assert.equal(asking.data.confirm.index, 0);
      assert.deepEqual(asking.data.stuck.lines, ["x + 1 = 2", "x = 1"]);
      asking.sendStuck();
    }
    assert.equal(sent.length, 2, from);
    assert.equal(sent[1].body.problem.text, "解方程 $x+1=2$", from);
    assert.equal(sent[1].body.problem.pending, undefined, "the problem asked is not offered again");
    assert.equal(sent[1].body.imageId, "img3", from);
    assert.equal(sent[1].body.stuck, true, from);
    assert.match(sent[1].body.text, /x \+ 1 = 2/, from);
    assert.match(sent[1].body.text, /x = 1/, from);
    startedOn(sent[1], "s2", { imageId: "img3", pending: [] });
    assert.equal(h.store["tool_draft:ask:one"], undefined, `${from}: both asked, it goes`);
    asking.onUnload();
  }
  require(file("utils/tools.js")).pick = realPick;
});

test("解题: 第 1 题's steps still read when 第 2 题 is asked (page open, or left and opened again): they come into the photo kept on 第 1 题", async () => {
  const realPick = require(file("utils/tools.js")).pick;
  for (const left of [false, true]) {
    delete h.store["tool_draft:ask:one"];
    global.getCurrentPages = () => [];
    let reading;
    let page;
    if (left) {
      reading = await leftReadingSteps(SCAN2);
      page = reopen();
    } else {
      page = await twoProblems();
      stuckOn(page);
      reading = later();
      h.routes["UPLOAD /v1/chat/scan"] = () => reading.promise;
      require(file("utils/tools.js")).pick = () => Promise.resolve({ tempFilePath: "/tmp/s.jpg", size: 10 });
      page.pickStuck(album);
      await settle();
    }
    takeUp(page, 1);
    stuckOn(page);
    page.onStuckLines({ detail: { lines: ["2x = 4"] } });
    const sent = streams();
    page.sendStuck();
    startedOn(sent[0], "s1", { imageId: "img3", pending: ["解方程 $x+1=2$"] });
    assert.equal(h.store["tool_draft:ask:one"].confirm.index, 0, `left ${left}: its 卡住 is open, so it stays`);
    reading.resolve(stepsFor(["x + 1 = 2", "x = 1"]));
    await settle();
    assert.equal(page.data.thread.id, "s1");
    assert.deepEqual(h.store["tool_draft:ask:one"].stuck.lines, ["x + 1 = 2", "x = 1"], `left ${left}`);
    sent[0].resolve({ finished: true });
    await settle();
    page.onUnload();
    global.getCurrentPages = () => [];
    const back = reopen();
    assert.equal(back.data.confirm.index, 0, `left ${left}`);
    assert.deepEqual(back.data.stuck.lines, ["x + 1 = 2", "x = 1"], `left ${left}`);
    back.onUnload();
  }
  require(file("utils/tools.js")).pick = realPick;
});

test("解题: one problem asked with nothing open on the others: the photo goes as before; a 卡住 too long to send with it stays kept", async () => {
  const realPick = require(file("utils/tools.js")).pick;
  // Nothing open on 第 1 题: asking 第 2 题 drops the photo (the conversation offers 第 1 题).
  let page = await twoProblems();
  takeUp(page, 1);
  let sent = streams();
  page.choose({ currentTarget: { dataset: { way: "solution" } } });
  startedOn(sent[0], "s1", { imageId: "img3", pending: ["解方程 $x+1=2$"] });
  assert.equal(h.store["tool_draft:ask:one"], undefined);
  sent[0].resolve({ finished: true });
  await settle();
  page.pickPending({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(sent[1].body.problem.text, "解方程 $x+1=2$");
  assert.equal(sent[1].body.stuck, undefined, "nothing kept for it: the problem alone");
  page.onUnload();
  // 第 1 题's 卡住 too long for one message: it goes alone and the 卡住 stays.
  delete h.store["tool_draft:ask:one"];
  page = await twoProblems();
  stuckOn(page);
  page.onStuckLines({ detail: { lines: Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 步 ${"x".repeat(400)}`) } });
  takeUp(page, 1);
  sent = streams();
  page.choose({ currentTarget: { dataset: { way: "hint" } } });
  startedOn(sent[0], "s1", { imageId: "img3", pending: ["解方程 $x+1=2$"] });
  sent[0].resolve({ finished: true });
  await settle();
  page.pickPending({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(sent[1].body.stuck, undefined);
  startedOn(sent[1], "s2", { imageId: "img3", pending: [] });
  assert.equal(h.store["tool_draft:ask:one"].stuck.lines.length, 6, "kept for 上次拍的题");
  page.onUnload();
  require(file("utils/tools.js")).pick = realPick;
});

// ---- refused, taken up again, the same text twice -------
// A check refused shows again with the steps read for it meanwhile; a problem
// asked and taken up again keeps the photo with what is written for it now;
// a pending problem whose text two problems share goes alone.
const failed = () => Object.assign(new Error("出了点问题"), { code: "INTERNAL", statusCode: 500 });

test("解题: 第 1 题's steps read while 第 2 题 is asked and refused (没思路, or 从这里给我提示): the check shows again with them, and keeps them when left", async () => {
  const realPick = require(file("utils/tools.js")).pick;
  for (const how of ["hint", "stuck"]) {
    delete h.store["tool_draft:ask:one"];
    global.getCurrentPages = () => [];
    const page = await twoProblems();
    stuckOn(page);
    const reading = later();
    h.routes["UPLOAD /v1/chat/scan"] = () => reading.promise;
    require(file("utils/tools.js")).pick = () => Promise.resolve({ tempFilePath: "/tmp/s.jpg", size: 10 });
    page.pickStuck(album);
    await settle();
    takeUp(page, 1);
    const sent = streams();
    if (how === "hint") page.choose({ currentTarget: { dataset: { way: "hint" } } });
    else {
      stuckOn(page);
      page.onStuckLines({ detail: { lines: ["2x = 4"] } });
      page.sendStuck();
    }
    reading.resolve(stepsFor(["x + 1 = 2", "x = 1"]));
    await settle();
    assert.deepEqual(h.store["tool_draft:ask:one"].confirm.problems[0].stuck.lines, ["x + 1 = 2", "x = 1"], how);
    sent[0].reject(how === "hint" ? refused() : failed());
    await settle();
    assert.deepEqual(page.data.messages, [], how);
    assert.equal(page.data.confirm.index, 1, how);
    assert.deepEqual(page.data.confirm.problems[0].stuck.lines, ["x + 1 = 2", "x = 1"], `${how}: shown again with them`);
    if (how === "stuck") assert.deepEqual(page.data.stuck.lines, ["2x = 4"], "its own 卡住 as it was sent");
    else assert.equal(page.data.stuck, null, how);
    page.onHide();
    assert.deepEqual(h.store["tool_draft:ask:one"].confirm.problems[0].stuck.lines, ["x + 1 = 2", "x = 1"], `${how}: still kept when left`);
    page.onShow();
    takeUp(page, 0);
    assert.deepEqual(page.data.stuck.lines, ["x + 1 = 2", "x = 1"], how);
    page.onUnload();
    global.getCurrentPages = () => [];
    const back = reopen();
    takeUp(back, 0);
    assert.deepEqual(back.data.stuck.lines, ["x + 1 = 2", "x = 1"], `${how}: opened again`);
    back.onUnload();
  }
  require(file("utils/tools.js")).pick = realPick;
});

test("解题: 第 2 题 asked, then from 上次拍的题 its 卡住 opened again and steps read, 第 1 题 asked: the photo stays on 第 2 题 with them, offered again and sent with them", async () => {
  const realPick = require(file("utils/tools.js")).pick;
  delete h.store["tool_draft:ask:one"];
  global.getCurrentPages = () => [];
  let page = await twoProblems();
  stuckOn(page);
  page.onStuckLines({ detail: { lines: ["x = 1"] } });
  takeUp(page, 1);
  let sent = streams();
  page.choose({ currentTarget: { dataset: { way: "hint" } } });
  startedOn(sent[0], "s1", { imageId: "img3", pending: ["解方程 $x+1=2$"] });
  assert.equal(h.store["tool_draft:ask:one"].confirm.problems[1].asked, true);
  sent[0].resolve({ finished: true });
  await settle();
  page.onUnload();
  global.getCurrentPages = () => [];
  page = reopen();
  assert.equal(page.data.confirm.index, 0);
  // The one asked, taken up again: a new 卡住, its steps read.
  takeUp(page, 1);
  stuckOn(page);
  require(file("utils/tools.js")).pick = () => Promise.resolve({ tempFilePath: "/tmp/s.jpg", size: 10 });
  h.routes["UPLOAD /v1/chat/scan"] = () => stepsFor(["2x = 4", "x = 2"]);
  page.pickStuck(album);
  await settle();
  assert.deepEqual(page.data.stuck.lines, ["2x = 4", "x = 2"]);
  takeUp(page, 0);
  sent = streams();
  page.sendStuck();
  assert.deepEqual(sent[0].body.problem.pending, ["解方程 $2x=4$"], "offered again: what is written for it now is not asked yet");
  startedOn(sent[0], "s2", { imageId: "img3", pending: ["解方程 $2x=4$"] });
  const kept = h.store["tool_draft:ask:one"];
  assert.ok(kept, "its new steps keep the photo");
  assert.equal(kept.confirm.index, 1);
  assert.deepEqual(kept.stuck.lines, ["2x = 4", "x = 2"]);
  assert.equal(kept.confirm.problems[0].asked, true);
  sent[0].resolve({ finished: true });
  await settle();
  page.pickPending({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(sent[1].body.problem.text, "解方程 $2x=4$");
  assert.equal(sent[1].body.stuck, true);
  assert.match(sent[1].body.text, /x = 2/);
  startedOn(sent[1], "s3", { imageId: "img3", pending: [] });
  assert.equal(h.store["tool_draft:ask:one"], undefined, "both asked, it goes");
  page.onUnload();
  require(file("utils/tools.js")).pick = realPick;
});

test("解题: two problems of a photo with the same text, each with its own 卡住: the one tapped in 其余几道 goes alone, and both 卡住 stay kept", async () => {
  delete h.store["tool_draft:ask:one"];
  global.getCurrentPages = () => [];
  const twice = SCAN2.problems[1];
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  h.routes["UPLOAD /v1/chat/scan"] = () => ({ ...SCAN2, imageId: "img4", problems: [SCAN2.problems[0], twice, { ...twice }] });
  const page = load("pages/ask/index.js");
  page.route = "pages/ask/index";
  page.onLoad();
  page.onShow();
  page.scanPhoto({ tempFilePath: "/tmp/q.jpg", size: 10 }, "problem");
  await settle();
  takeUp(page, 1);
  stuckOn(page);
  page.onStuckLines({ detail: { lines: ["2x = 4"] } });
  takeUp(page, 2);
  stuckOn(page);
  page.onStuckLines({ detail: { lines: ["x = 2"] } });
  takeUp(page, 0);
  const sent = streams();
  page.choose({ currentTarget: { dataset: { way: "hint" } } });
  assert.deepEqual(sent[0].body.problem.pending, [twice.text, twice.text]);
  startedOn(sent[0], "s1", { imageId: "img4", pending: [twice.text, twice.text] });
  sent[0].resolve({ finished: true });
  await settle();
  page.pickPending({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(sent[1].body.problem.text, twice.text);
  assert.deepEqual(sent[1].body.problem.pending, [twice.text]);
  assert.equal(sent[1].body.stuck, undefined, "which of the two is not known: the problem alone");
  assert.equal(sent[1].body.text, undefined);
  startedOn(sent[1], "s2", { imageId: "img4", pending: [twice.text] });
  const kept = h.store["tool_draft:ask:one"];
  assert.equal(kept.confirm.index, 1);
  assert.deepEqual(kept.stuck.lines, ["2x = 4"]);
  assert.deepEqual(kept.confirm.problems[2].stuck.lines, ["x = 2"]);
  assert.equal(kept.confirm.problems[1].asked, undefined);
  assert.equal(kept.confirm.problems[2].asked, undefined);
  page.onUnload();
});
