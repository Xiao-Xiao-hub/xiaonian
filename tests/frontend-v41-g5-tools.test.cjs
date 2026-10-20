"use strict";
// V4.1 G5 : the four study tools on 学习 — 拍一道题 (pages/ask), 批改草稿
// (pages/draft), 整页作业 (pages/homework) and 讲一遍 (pages/teach).
// 批改草稿 and 整页作业 are one 批改 (pages/grade); their tests here
// run on that page (the old pages only redirect).
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
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
const tap = (dataset) => ({ currentTarget: { dataset } });
const para = (v) => [{ t: "p", c: [{ t: "text", v }] }];

beforeEach(() => {
  Object.keys(require.cache)
    .filter((key) => key.startsWith(root + path.sep))
    .forEach((key) => delete require.cache[key]);
  h = { state: "ok", calls: [], asks: 0, nav: [], sent: [], routes: {}, app: { globalData: {} }, pages: [], media: null };
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
    patch: call("PATCH"),
    uploadTo: (url, filePath) => call("UPLOAD")(url, { filePath }),
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
  stub("utils/assets.js", { asset: (name) => `https://x/${name}` });
  stub("utils/learning-space.js", { rememberThread() {}, lastThread: () => "", forgetThread() {} });
  stub("utils/stream.js", {
    clientId: () => `c${h.sent.length + 1}`,
    send: (url, body, onEvent) => {
      h.sent.push({ url, body, onEvent });
      return { promise: new Promise(() => {}), abort() {} };
    },
  });
  global.getApp = () => h.app;
  global.getCurrentPages = () => h.pages;
  global.wx = {
    navigateTo: ({ url }) => h.nav.push(url),
    redirectTo: ({ url }) => h.nav.push(`redirect:${url}`),
    navigateBack: ({ delta } = {}) => h.nav.push(`back:${delta}`),
    switchTab: ({ url }) => h.nav.push(`tab:${url}`),
    chooseMedia: (o) => (h.media ? o.success({ tempFiles: [h.media] }) : o.fail({ errMsg: "chooseMedia:fail cancel" })),
    previewImage() {},
    showToast() {},
    showActionSheet() {},
    showModal: (o) => o.success && o.success({ confirm: true }),
    pageScrollTo() {},
    getStorageSync: () => null,
    setStorageSync() {},
    removeStorageSync() {},
    stopPullDownRefresh() {},
  };
});

// ---- 拍一道题 ----------------------------------------------------------------
test("拍一道题: a photo is read for the tool, shown to check and edit, then 没思路 starts the chat", async () => {
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  h.routes["UPLOAD /v1/chat/scan"] = () => ({
    type: "problems",
    imageId: "img1",
    problems: [
      { text: "求 lim sin3x/x", blocks: para("求 lim sin3x/x") },
      { text: "求 x^2 的导数", blocks: para("求 x^2 的导数"), unclear: "指数" },
    ],
    homework: 0,
    suggest: null,
  });
  h.media = { tempFilePath: "/tmp/p.jpg", size: 1000 };
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onShow();
  page.pickStart({ detail: { source: "camera" } });
  await settle();
  assert.equal(h.calls.find((c) => c.method === "UPLOAD").url, "/v1/chat/scan?tone=light&purpose=problem");
  const confirm = page.data.confirm;
  assert.equal(confirm.title, "认出 2 道题，选一道");
  assert.equal(confirm.photo, "/tmp/p.jpg");
  assert.equal(confirm.text, "求 lim sin3x/x");
  page.pickConfirm(tap({ index: 1 }));
  assert.equal(page.data.confirm.unclear, "指数");
  page.editConfirm();
  page.onConfirmText({ detail: { value: "求 x^3 的导数" } });
  page.choose(tap({ way: "hint" }));
  assert.equal(page.data.confirm, null);
  const body = h.sent[0].body;
  assert.deepEqual(body.problem, { text: "求 x^3 的导数", pending: ["求 lim sin3x/x"] });
  assert.equal(body.imageId, "img1");
  assert.equal(body.mode, "auto");
  assert.equal(body.origin, "solve");
  page.onHide && page.onHide();
});

test("拍一道题: 直接看解法 asks for the full solution; typed text is checked first and sent as typed", () => {
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onDraft({ detail: { value: "求 x^2 的导数" } });
  page.submit();
  assert.equal(h.sent.length, 0, "typing goes to the check first");
  assert.equal(page.data.confirm.typed, true);
  assert.equal(page.data.confirm.editing, true);
  page.choose(tap({ way: "solution" }));
  assert.deepEqual(
    { text: h.sent[0].body.text, mode: h.sent[0].body.mode, origin: h.sent[0].body.origin },
    { text: "求 x^2 的导数", mode: "solution", origin: "solve" },
  );
  // 返回 keeps what was typed.
  const again = load("pages/ask/index.js");
  again.onLoad();
  again.onDraft({ detail: { value: "洛必达" } });
  again.submit();
  again.closeConfirm();
  assert.equal(again.data.confirm, null);
  assert.equal(again.data.draft, "洛必达");
});

test("拍一道题: 做到一半卡住 takes the written steps (typed or photographed) and where it stopped", async () => {
  h.routes["UPLOAD /v1/chat/scan"] = () => ({ type: "solution", solution: { steps: ["设 u=3x", "原式=lim sin u/x"] }, problems: [] });
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onDraft({ detail: { value: "求 lim sin3x/x" } });
  page.submit();
  page.choose(tap({ way: "stuck" }));
  assert.deepEqual(page.data.stuck, { lines: [], text: "" });
  page.sendStuck();
  assert.equal(h.sent.length, 0);
  assert.match(page.data.error, /卡在哪/);
  h.media = { tempFilePath: "/tmp/s.jpg", size: 10 };
  page.pickStuck(tap({ source: "album" }));
  await settle();
  assert.equal(h.calls.find((c) => c.method === "UPLOAD").url, "/v1/chat/scan?tone=light&purpose=draft");
  assert.deepEqual(page.data.stuck.lines, ["设 u=3x", "原式=lim sin u/x"]);
  page.onStuckText({ detail: { value: "x 换不掉" } });
  page.sendStuck();
  const body = h.sent[0].body;
  assert.equal(body.stuck, true);
  assert.deepEqual(body.problem, { text: "求 lim sin3x/x" });
  assert.match(body.text, /我做到一半卡住了。\n已经写了：\n1\. 设 u=3x\n2\. 原式=lim sin u\/x\n卡在：x 换不掉/);
});

test("拍一道题: a photo that looks like a page of homework is handed over, scan and all", () => {
  const scan = { type: "homework", imageId: "img2", problems: [], homework: 4, suggest: "homework", photo: "/tmp/h.jpg" };
  h.app.globalData.toolScan = { to: "problem", scan };
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onShow();
  assert.deepEqual(page.data.confirm.suggest, { to: "grade", text: "这张像是你写的解答", go: "去批改" });
  page.switchTool();
  assert.deepEqual(h.app.globalData.toolScan, { to: "grade", scan });
  assert.equal(h.nav.at(-1), "redirect:/pages/grade/index");
  // A photo handed here never points back here.
  const tools = require(file("utils/tools.js"));
  assert.equal(tools.suggestOf({ suggest: "problem" }, "problem"), null);
  assert.equal(tools.take("problem"), null);
  assert.equal(tools.take("grade"), scan);
  assert.equal(h.app.globalData.toolScan, null);
});

// ---- 批改草稿 ----------------------------------------------------------------
const graded = {
  thread: { id: "d1", mistake: null },
  message: {
    id: "m2",
    kind: "draft",
    draft: {
      verdict: "wrong",
      summary: "第 2 步换元后分母没跟着换",
      by: "json",
      steps: [
        { no: 1, status: "ok", text: "设 u=3x", blocks: para("设 u=3x"), note: "" },
        { no: 2, status: "wrong", text: "原式=lim sin u/x", blocks: para("原式=lim sin u/x"), note: "" },
        { no: 3, status: "unclear", text: "=1", blocks: para("=1"), note: "" },
      ],
      first: { step: 2, why: para("x 也要换成 u/3"), fix: para("原式=3 lim sin u/u") },
    },
  },
};
test("批改草稿: the photo becomes editable lines, each step gets ✓ ✗ ?, the first error says why and how", async () => {
  h.routes["UPLOAD /v1/chat/scan"] = () => ({
    type: "solution",
    imageId: "img3",
    problems: [{ text: "求 lim sin3x/x" }],
    solution: { steps: ["设 u=3x", "原式=lim sin u/x", "=1"], unclear: "" },
    suggest: null,
  });
  h.routes["POST /v1/chat/drafts"] = () => graded;
  h.routes["POST /v1/chat/messages/m2/mistake"] = () => ({ mistake: { id: "k1", status: "open" } });
  h.media = { tempFilePath: "/tmp/d.jpg", size: 10 };
  const page = load("pages/grade/index.js");
  page.onLoad({});
  page.onShow();
  assert.equal(page.data.stage, "start");
  page.pick({ detail: { source: "camera" } });
  await settle();
  assert.equal(h.calls.find((c) => c.method === "UPLOAD").url, "/v1/chat/scan?tone=light&purpose=grade");
  assert.equal(page.data.stage, "edit");
  assert.equal(page.data.problem, "求 lim sin3x/x");
  page.onLines({ detail: { lines: ["设 u=3x", "原式=lim sin u/x", "", "=1"] } });
  await page.grade();
  assert.deepEqual(h.calls.find((c) => c.url === "/v1/chat/drafts").body, {
    problem: "求 lim sin3x/x",
    steps: ["设 u=3x", "原式=lim sin u/x", "=1"],
    imageId: "img3",
    clientId: "c1",
    tone: "light",
  });
  const result = page.data.result;
  assert.equal(page.data.stage, "draft");
  assert.equal(result.head, "第 2 步开始有错");
  assert.deepEqual(result.steps.map((s) => [s.mark, s.first]), [["✓", false], ["✗", true], ["?", false]]);
  page.solution();
  assert.deepEqual(h.app.globalData.ask, { threadId: "d1", solution: true });
  await page.addMistake();
  await settle();
  assert.equal(page.data.result.inBook, true);
  const posts = h.calls.filter((c) => c.url.endsWith("/mistake")).length;
  page.addMistake();
  assert.equal(h.calls.filter((c) => c.url.endsWith("/mistake")).length, posts, "only once");
});

test("批改草稿: typing works without a photo; empty input and a failed grade say why; crisis goes to help", async () => {
  const page = load("pages/grade/index.js");
  page.onLoad({});
  page.onShow();
  page.typeIn();
  assert.deepEqual(page.data.lines, [""]);
  page.grade();
  assert.equal(page.data.error, "先写上题目");
  page.onProblem({ detail: { value: "求导" } });
  page.grade();
  assert.equal(page.data.error, "至少写一步过程");
  page.onLines({ detail: { lines: ["y'=2x"] } });
  h.routes["POST /v1/chat/drafts"] = () => {
    throw Object.assign(new Error("这次没批改好，不算次数；过一会儿再试"), { code: "DRAFT_FAILED" });
  };
  await page.grade();
  assert.equal(page.data.gradeError, "这次没批改好，不算次数；过一会儿再试");
  assert.equal(page.data.stage, "edit");
  h.routes["POST /v1/chat/drafts"] = () => ({ crisis: true });
  await page.grade();
  assert.equal(h.nav.at(-1), "/pages/crisis/index");
});

test("批改草稿: ?id= reopens a graded draft; a photo of a single problem is offered to 拍一道题", async () => {
  h.routes["GET /v1/chat/threads/d1"] = () => ({ thread: { id: "d1", mistake: { status: "open" } }, messages: [{ id: "q", kind: "steps" }, graded.message] });
  const page = load("pages/grade/index.js");
  page.onLoad({ id: "d1" });
  page.onShow();
  await settle();
  assert.equal(page.data.result.inBook, true);
  assert.equal(page.data.result.steps.length, 3);
  const scan = { type: "problems", problems: [{ text: "求导" }], solution: null, suggest: "problem" };
  h.app.globalData.toolScan = { to: "draft", scan };
  const other = load("pages/grade/index.js");
  other.onLoad({});
  other.onShow();
  assert.equal(other.data.suggest.to, "problem");
  other.switchTool();
  assert.equal(h.nav.at(-1), "redirect:/pages/ask/index");
});

// ---- 整页作业 ----------------------------------------------------------------
test("整页作业: starts with 拍照 / 相册, a page is graded at once, the top counts the right ones", async () => {
  h.routes["UPLOAD /v1/chat/scan"] = () => ({ type: "homework", imageId: "img4", homework: 3, problems: [], suggest: null });
  const thread = {
    id: "hw1",
    homework: {
      imageId: "img4",
      items: [
        { index: 0, problem: "1", steps: ["a"], status: "correct", threadId: "c1", inBook: false },
        { index: 1, problem: "2", steps: ["b"], status: "wrong", threadId: "c2", inBook: true },
        { index: 2, problem: "3", steps: ["c"], status: "correct", threadId: "c3", inBook: false },
      ],
      counts: { correct: 2, wrong: 1, grading: 0, unclear: 0 },
    },
  };
  h.routes["POST /v1/chat/homework"] = () => thread;
  h.routes["POST /v1/chat/threads/hw1/homework/0/mistake"] = () => ({ mistake: { status: "open" }, thread });
  h.media = { tempFilePath: "/tmp/h.jpg", size: 10 };
  const page = load("pages/grade/index.js");
  page.onLoad({});
  page.onShow();
  assert.equal(page.data.stage, "start");
  page.pick({ detail: { source: "album" } });
  await settle();
  const sent = h.calls.filter((c) => c.method !== "GET");
  assert.equal(sent[0].url, "/v1/chat/scan?tone=light&purpose=grade");
  assert.deepEqual(sent[1].body, { imageId: "img4", tone: "light" });
  assert.equal(page.data.stage, "page");
  assert.equal(page.data.id, "hw1");
  assert.equal(page.data.score, "对了 2 / 3 题");
  assert.equal(page.data.summary, "1 道有错", "the score says the rest; no second count");
  const wxml = read("pages/grade/index.wxml");
  assert.match(wxml, /class="hw-score"><text class="hw-score-n">\{\{score\}\}/);
  assert.match(wxml, /bindtap="addItemMistake"/);
  assert.match(wxml, /已在错题本/);
  page.addItemMistake(tap({ index: 0 }));
  await settle();
  assert.ok(h.calls.some((c) => c.url === "/v1/chat/threads/hw1/homework/0/mistake"));
});

test("批改: a photo of one problem's steps is checked first; a bare problem is offered to 拍一道题", () => {
  const page = load("pages/grade/index.js");
  page.onLoad({});
  // The server's old names (draft, homework) are this page now: no chip back to it.
  page.useScan({ type: "solution", problems: [{ text: "求导" }], homework: 0, solution: { steps: ["x"] }, suggest: "draft", photo: "/tmp/x.jpg" });
  assert.equal(page.data.stage, "edit");
  assert.deepEqual(page.data.lines, ["x"]);
  assert.equal(page.data.suggest, null);
  page.useScan({ type: "problems", problems: [{ text: "求导" }], homework: 0, suggest: "problem" });
  assert.equal(page.data.problem, "求导");
  assert.equal(page.data.suggest.to, "problem");
  page.switchTool();
  assert.equal(h.nav.at(-1), "redirect:/pages/ask/index");
});

// ---- 讲一遍 ------------------------------------------------------------------
test("讲一遍: on a point, the chat is made on the first sentence; 讲完了 sorts covered / missed / wrong", async () => {
  h.routes["POST /v1/chat/threads"] = (body) => ({ thread: { id: "t1", mode: "teach", pointId: body.pointId, title: "链式法则", currentCards: [] } });
  const review = {
    id: "r9",
    kind: "teach_review",
    review: {
      points: [
        { text: "外层求导乘内层求导", status: "covered", quote: "外面导完乘里面", blocks: para("外层求导乘内层求导") },
        { text: "中间变量", status: "partial", quote: "", blocks: para("中间变量") },
        { text: "多层复合逐层乘", status: "missed", quote: "", blocks: para("多层复合逐层乘") },
      ],
      wrong: [{ quote: "里面不用导", why: para("内层也要求导"), fix: para("乘内层导数") }],
      best: "外面导完乘里面的导数就行",
      pointId: "derivative-chain",
      topic: "",
    },
  };
  h.routes["POST /v1/chat/threads/t1/teach-review"] = () => ({ fallback: false, message: review });
  const page = load("pages/teach/index.js");
  page.onLoad({ pointId: "derivative-chain", name: encodeURIComponent("链式法则") });
  page.onShow();
  assert.equal(page.data.stage, "talk");
  assert.equal(page.data.name, "链式法则");
  page.finish();
  assert.equal(h.calls.length, 0, "nothing said, nothing to compare");
  page.onDraft({ detail: { value: "外面导完乘里面的导数就行" } });
  page.submit();
  await settle();
  assert.deepEqual(h.calls[0].body, { mode: "teach", text: "链式法则", pointId: "derivative-chain", origin: "solve", tone: "light" });
  assert.deepEqual(h.sent[0].body, { threadId: "t1", text: "外面导完乘里面的导数就行", mode: "auto", clientId: "c1", tone: "light" });
  // The reply streams in.
  const on = h.sent[0].onEvent;
  on({ e: "start", question: { id: "q1" }, replyId: "a1" });
  on({ e: "tail", id: "a1", text: "那里面是" });
  on({ e: "done", message: { id: "a1", role: "assistant", kind: "text", status: "done", blocks: para("那里面是几层？") } });
  assert.deepEqual(page.data.messages.map((m) => m.id), ["q1", "a1"]);
  page.setData({ sending: false });
  await page.finish();
  assert.equal(page.data.stage, "result");
  const shown = page.data.review;
  assert.equal(shown.got, 1);
  assert.equal(shown.total, 3);
  assert.deepEqual(shown.covered.map((p) => p.label), ["讲清了", "不完整"]);
  assert.deepEqual(shown.missed.map((p) => p.text), ["多层复合逐层乘"]);
  assert.equal(shown.wrong.length, 1);
  // 存成卡: the clearest sentence goes to the collect page as 我的话.
  page.save();
  assert.equal(h.nav.at(-1), "/pages/collect/index");
  assert.equal(h.app.globalData.collect.mine, "外面导完乘里面的导数就行");
  page.goOn();
  assert.equal(page.data.stage, "talk");
});

test("讲一遍: a topic of one's own; when the comparison fails the key points show and nothing is counted", async () => {
  stub("utils/bank.js", { load: () => Promise.resolve(null), view: () => ({ chapters: [], tabs: [] }), find: () => null });
  h.routes["POST /v1/chat/threads"] = () => ({ thread: { id: "t2", mode: "teach", currentCards: [] } });
  h.routes["POST /v1/chat/threads/t2/teach-review"] = () => ({ fallback: true, keys: ["一", "二"], message: null });
  const page = load("pages/teach/index.js");
  page.onLoad({});
  page.onShow();
  assert.equal(page.data.stage, "pick");
  page.startTopic();
  assert.equal(page.data.error, "先写下想讲的主题");
  page.onTopic({ detail: { value: "泰勒公式的余项" } });
  page.startTopic();
  assert.equal(page.data.stage, "talk");
  page.onDraft({ detail: { value: "余项就是误差" } });
  page.submit();
  await settle();
  assert.deepEqual(h.calls.find((c) => c.method === "POST").body, { mode: "teach", text: "泰勒公式的余项", topic: "泰勒公式的余项", origin: "solve", tone: "light" });
  page.setData({ sending: false });
  await page.finish();
  assert.equal(page.data.review, null);
  assert.deepEqual(page.data.fallback, { keys: ["一", "二"] });
});

test("a guest sees each tool's start but nothing is sent", async () => {
  h.state = "guest";
  const draft = load("pages/grade/index.js");
  draft.onLoad({});
  draft.onShow();
  draft.pick({ detail: { source: "camera" } });
  draft.typeIn();
  const teach = load("pages/teach/index.js");
  stub("utils/bank.js", { load: () => Promise.resolve(null), view: () => ({}), find: () => null });
  teach.onLoad({});
  teach.onShow();
  teach.onTopic({ detail: { value: "极限" } });
  teach.startTopic();
  const hw = load("pages/grade/index.js");
  hw.onLoad({});
  hw.onShow();
  hw.pick({ detail: { source: "camera" } });
  const ask = load("pages/ask/index.js");
  ask.onLoad();
  ask.onShow();
  ask.pickStart({ detail: { source: "camera" } });
  await settle();
  assert.equal(h.asks, 5);
  assert.deepEqual(h.calls.filter((c) => c.method !== "GET"), []);
});

// ---- entries -----------------------------------------------------------------
test("entries: 学习's tiles, openAsk and a point's 讲一遍 reach the tool pages", () => {
  const app = JSON.parse(read("app.json"));
  for (const p of ["pages/ask/index", "pages/draft/index", "pages/homework/index", "pages/grade/index", "pages/teach/index"]) assert.ok(app.pages.includes(p), p);
  const { ROUTE } = require(file("utils/tools.js"));
  assert.equal(ROUTE.grade, "pages/grade/index");
  assert.equal(ROUTE.draft, "pages/grade/index", "old names reach the one 批改");
  assert.equal(ROUTE.homework, "pages/grade/index");
  assert.equal(ROUTE.teach, "pages/teach/index");
  const { openAsk } = require(file("utils/chat-entry.js"));
  openAsk({ photo: "draft" });
  assert.equal(h.nav.at(-1), "/pages/grade/index");
  openAsk({ photo: "homework" });
  assert.equal(h.nav.at(-1), "/pages/grade/index");
  openAsk({ teach: true });
  assert.equal(h.nav.at(-1), "/pages/teach/index");
  openAsk({ teach: true, cards: ["k1"] });
  assert.equal(h.nav.at(-1), "/pages/ask/index");
  assert.deepEqual(h.app.globalData.ask, { teach: true, cards: ["k1"] });
  openAsk({ threadId: "d1", solution: true });
  assert.deepEqual(h.app.globalData.ask, { threadId: "d1", solution: true });
});

test("the tool pages keep the AI line, one style, no banned words or model names", () => {
  const banned = /心理咨询|心理治疗|心理医生|疗愈|治疗|诊断|陪伴|陪着你|恋人|伴侣|我一直记着你|我在等你|GLM|DeepSeek|GPT|Qwen|Claude|Gemini|混元|大模型|flash/i;
  for (const page of ["pages/grade/index", "pages/teach/index", "pages/ask/index"]) {
    const wxml = read(`${page}.wxml`);
    assert.match(wxml, /AI 生成可能有误，注意核实/, page);
    // Icon file names (ic-camera-with-flash.webp) are not shown.
    assert.doesNotMatch((wxml + read(`${page}.js`)).replace(/ic-[\w-]+\.webp/g, ""), banned, page);
  }
  for (const name of ["components/tool-start/index", "components/step-edit/index", "utils/tools"]) {
    const text = ["wxml", "js"].map((ext) => (fs.existsSync(file(`${name}.${ext}`)) ? read(`${name}.${ext}`) : "")).join("\n");
    assert.doesNotMatch(text, banned, name);
  }
  // New buttons say how wide they are; no new class is called "bar".
  assert.match(read("components/tool-start/index.wxss"), /\.ts-btn \{[^}]*width: auto !important/);
  for (const css of ["pages/grade/index.wxss", "pages/teach/index.wxss", "components/tool-start/index.wxss", "components/step-edit/index.wxss"])
    assert.doesNotMatch(read(css), /(^|[\s,}])\.bar\b/, css);
  const learn = read("pages/learn/index.wxml");
  for (const [title, line] of [
    ["拍一道题", "拍照或打字，一步步带你做"],
    ["批改", "一道或一页，找出哪步错"],
    ["讲一遍", "讲给小狸听，看漏了哪条要点"],
  ])
    assert.match(learn, new RegExp(`<text class="t">${title}</text><text class="s">${line}</text>`), title);
  const draft = read("pages/grade/index.wxml");
  assert.match(draft, /看正确做法/);
  assert.match(draft, /放进错题本/);
  assert.match(draft, /class="st \{\{item\.first \? 'first' : ''\}\}"/);
  const teach = read("pages/teach/index.wxml");
  assert.match(teach, /placeholder="讲给小狸听"/);
  assert.match(teach, /讲完了/);
  assert.match(teach, /已提到[\s\S]*漏了[\s\S]*说得不对/);
  assert.match(teach, /<point-list/);
});

// ---- recovery (review fixes) --------------------------------------------------
test("拍一道题: a refused send brings the check back; opening a chat clears it; stuck text is never cut", async () => {
  let fail;
  stub("utils/stream.js", {
    clientId: () => `c${h.sent.length + 1}`,
    send: (url, body, onEvent) => {
      h.sent.push({ url, body, onEvent });
      return { promise: new Promise((_, reject) => (fail = reject)), abort() {} };
    },
  });
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  h.app.globalData.toolScan = { to: "problem", scan: { type: "problems", imageId: "img1", problems: [{ text: "求导" }], suggest: null } };
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onShow();
  page.choose(tap({ way: "stuck" }));
  page.onStuckLines({ detail: { lines: ["一".repeat(1990), "二"] } });
  page.onStuckText({ detail: { value: "卡在最后" } });
  page.sendStuck();
  assert.equal(h.sent.length, 0);
  assert.match(page.data.error, /太长/);
  assert.equal(page.data.stuck.text, "卡在最后", "kept for editing");
  page.onStuckLines({ detail: { lines: ["一", "二"] } });
  page.sendStuck();
  assert.match(h.sent[0].body.text, /卡在：卡在最后$/);
  fail(Object.assign(new Error("今天的次数用完了"), { code: "QUOTA_EXCEEDED" }));
  await settle();
  assert.equal(page.data.confirm.text, "求导", "the check is back, no new photo");
  assert.equal(page.data.stuck.text, "卡在最后");
  assert.equal(page.data.confirm.imageId, "img1");
  // Opening a chat from 历史 replaces the check.
  h.routes["GET /v1/chat/threads/t5"] = () => ({ thread: { id: "t5", currentCards: [], pending: [] }, messages: [{ id: "m1", role: "user", kind: "text", status: "done", blocks: para("hi") }] });
  await page.open("t5");
  assert.equal(page.data.confirm, null);
  assert.equal(page.data.stuck, null);
  // 历史 sends a draft or a 讲一遍 to its page.
  page.openThread(tap({ id: "d1", tool: "draft" }));
  assert.equal(h.nav.at(-1), "/pages/grade/index?id=d1");
  page.openThread(tap({ id: "t2", tool: "teach" }));
  assert.equal(h.nav.at(-1), "/pages/teach/index?id=t2");
  assert.match(read("pages/ask/index.wxml"), /data-tool="\{\{item\.tool\}\}"/);
});

test("讲一遍: a stream that breaks after the server took the sentence shows what the server kept", async () => {
  let fail;
  stub("utils/stream.js", {
    clientId: () => "c1",
    send: (url, body, onEvent) => {
      h.sent.push({ url, body, onEvent });
      return { promise: new Promise((_, reject) => (fail = reject)), abort() {} };
    },
  });
  h.routes["POST /v1/chat/threads"] = () => ({ thread: { id: "t1", mode: "teach", currentCards: [] } });
  h.routes["GET /v1/chat/threads/t1"] = () => ({
    thread: { id: "t1", title: "链式法则", pointId: "derivative-chain" },
    messages: [
      { id: "q1", role: "user", kind: "text", status: "done", content: "外面导完乘里面", blocks: para("外面导完乘里面") },
      { id: "a1", role: "assistant", kind: "text", status: "done", blocks: para("那三层呢？") },
    ],
  });
  const page = load("pages/teach/index.js");
  page.onLoad({ pointId: "derivative-chain", name: "链式法则" });
  page.onShow();
  page.onDraft({ detail: { value: "外面导完乘里面" } });
  page.submit();
  await settle();
  h.sent[0].onEvent({ e: "start", question: { id: "q1" }, replyId: "a1" });
  fail(Object.assign(new Error("连接断了"), { code: "SERVER" }));
  await settle();
  assert.deepEqual(page.data.messages.map((m) => m.id), ["q1", "a1"]);
  assert.equal(page.data.draft, "", "not offered to send twice");
  page.onUnload();
});

test("整页作业: when grading the page cannot start, 再试一次 uses the same photo", async () => {
  let n = 0;
  h.routes["POST /v1/chat/homework"] = () => {
    n += 1;
    if (n === 1) throw Object.assign(new Error("今天剩下的次数不够整页，挑一道单独问"), { code: "QUOTA_EXCEEDED" });
    return { id: "hw2", homework: { items: [], counts: { correct: 0, grading: 0, unclear: 0 } } };
  };
  const page = load("pages/grade/index.js");
  page.onLoad({});
  await page.useScan({ type: "homework", imageId: "img9", homework: 3, problems: [{ text: "求导" }], suggest: null });
  await settle();
  assert.equal(page.data.retryPage, true);
  assert.equal(page.data.suggest.to, "problem");
  assert.match(read("pages/grade/index.wxml"), /bindtap="retryStart">再试一次/);
  page.retryStart();
  await settle();
  assert.equal(page.data.id, "hw2");
  assert.equal(h.calls.filter((c) => c.method === "UPLOAD").length, 0);
  assert.deepEqual(h.calls.map((c) => c.body && c.body.imageId), ["img9", "img9"]);
});

// ---- review fixes  ----------------------------------------------
test("拍一道题: 批改 in the photo menu opens its own page", () => {
  const sheets = [];
  wx.showActionSheet = (o) => sheets.push(o);
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.photoMenu();
  assert.deepEqual(sheets[0].itemList, ["拍一道题", "拍下我写的，批改"]);
  sheets[0].success({ tapIndex: 1 });
  assert.deepEqual(h.nav, ["/pages/grade/index"]);
  assert.equal(h.calls.length, 0);
});

test("拍一道题: a photo of the steps read after 做到一半卡住 was closed fills nothing", async () => {
  h.routes["UPLOAD /v1/chat/scan"] = () => ({ type: "solution", solution: { steps: ["设 u=3x"] }, problems: [] });
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onDraft({ detail: { value: "求 lim sin3x/x" } });
  page.submit();
  page.choose(tap({ way: "stuck" }));
  h.media = { tempFilePath: "/tmp/s.jpg", size: 10 };
  page.pickStuck(tap({ source: "album" }));
  page.cancelStuck();
  await settle();
  assert.equal(page.data.stuck, null);
  assert.equal(page.data.scanning, false);
});

test("批改草稿 → 看正确做法: asked once; a thread that has the solution just opens", async () => {
  const thread = { id: "d1", currentCards: [], pending: [] };
  let messages = [
    { id: "q1", role: "user", kind: "steps", status: "done", blocks: [] },
    { id: "a1", role: "assistant", kind: "draft", mode: "grade", status: "done", blocks: [] },
  ];
  h.routes["GET /v1/chat/threads/d1"] = () => ({ thread, messages });
  h.app.globalData.ask = { threadId: "d1", solution: true };
  let page = load("pages/ask/index.js");
  page.onLoad();
  page.onShow();
  await settle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].body.mode, "solution");
  messages = messages.concat([
    { id: "q2", role: "user", kind: "text", mode: "solution", status: "done", blocks: [] },
    { id: "a2", role: "assistant", kind: "reply", mode: "solution", status: "done", blocks: para("解法") },
  ]);
  h.app.globalData.ask = { threadId: "d1", solution: true };
  page = load("pages/ask/index.js");
  page.onLoad();
  page.onShow();
  await settle();
  assert.equal(page.data.thread.id, "d1");
  assert.equal(h.sent.length, 1, "no second request, no second charge");
});

test("批改草稿: 看正确做法 opens once on a double tap; 重新拍 waits for the grading", () => {
  const page = load("pages/grade/index.js");
  page.onLoad({});
  page.setData({ threadId: "d1", stage: "draft" });
  page.solution();
  page.solution();
  assert.deepEqual(h.nav, ["/pages/ask/index"]);
  page.setData({ stage: "edit", photo: "/tmp/x.jpg", grading: true });
  page.again();
  assert.equal(page.data.stage, "edit");
  assert.match(read("pages/grade/index.wxml"), /class="link small \{\{grading \? 'off' : ''\}\}" bindtap="again"/);
});

test("批改草稿 ?id=: a guest is not left on 打开中; a failed load offers 再试一次", async () => {
  h.state = "guest";
  let page = load("pages/grade/index.js");
  page.onLoad({ id: "d1" });
  page.onShow();
  assert.equal(page.data.loading, false);
  assert.equal(page.data.stage, "start");
  assert.equal(h.calls.length, 0);
  h.state = "ok";
  page = load("pages/grade/index.js");
  page.onLoad({ id: "d/1" });
  page.onShow();
  await settle();
  assert.equal(h.calls[0].url, "/v1/chat/threads/d%2F1?tone=light");
  assert.equal(page.data.loadFailed, true);
  assert.equal(page.data.loading, false);
  assert.match(read("pages/grade/index.wxml"), /loadFailed[^}]*\}\}" class="alert">\{\{error\}\}<text class="link" bindtap="load">再试一次/);
  h.routes["GET /v1/chat/threads/d/1"] = () => ({
    thread: { id: "d/1" },
    messages: [{ id: "m", kind: "draft", draft: { verdict: "correct", first: null, steps: [], summary: "" } }],
  });
  h.routes["GET /v1/chat/threads/d%2F1"] = h.routes["GET /v1/chat/threads/d/1"];
  page.load();
  await settle();
  assert.equal(page.data.loadFailed, false);
  assert.equal(page.data.stage, "draft");
  assert.equal(page.data.result.head, "每一步都对");
});

test("讲一遍: a bad name in the link still opens; a look while sending waits; a failed load can be tried again", async () => {
  let page = load("pages/teach/index.js");
  page.onLoad({ pointId: "p1", name: "%E4%B" });
  assert.equal(page.data.name, "%E4%B");
  page = load("pages/teach/index.js");
  page.onLoad({ id: "t1" });
  page.onShow();
  await settle();
  assert.equal(page.data.loadFailed, true);
  assert.equal(page.loaded, false, "the next show reads it again");
  const server = [{ id: "u1", role: "user", kind: "text", content: "一", status: "done", blocks: para("一") }];
  h.routes["GET /v1/chat/threads/t1"] = () => ({ thread: { id: "t1", title: "极限" }, messages: server });
  page.load();
  await settle();
  assert.equal(page.data.loadFailed, false);
  assert.equal(page.data.error, "");
  assert.deepEqual(page.data.messages.map((m) => m.id), ["u1"]);
  // A sentence on its way: the look waits, nothing is wiped.
  page.setData({ messages: page.data.messages.concat([{ id: "local_c1", role: "user", blocks: [] }, { id: "wait_c1", role: "assistant", blocks: [] }]), sending: true });
  const gets = h.calls.length;
  page.load();
  await settle();
  assert.equal(h.calls.length, gets, "no read while sending");
  assert.deepEqual(page.data.messages.map((m) => m.id), ["u1", "local_c1", "wait_c1"]);
  clearTimeout(page.timer);
  // A read that comes back while sending changes nothing either.
  page.setData({ sending: false });
  const reading = page.load();
  page.setData({ sending: true });
  await reading;
  assert.deepEqual(page.data.messages.map((m) => m.id), ["u1", "local_c1", "wait_c1"]);
  clearTimeout(page.timer);
  page.onUnload();
});
