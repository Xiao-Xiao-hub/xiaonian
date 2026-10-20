"use strict";
// 学习工具回归：“讲完了”和 AI 加练在结果明确前复用同一个 clientId，避免重复提交。
// 离开批改页保留已选照片；工具历史使用服务端不透明 next 游标加载更多。
// 另外覆盖单位、日期、账号缓存键和等待提示等边界。
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
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
const tap = (dataset) => ({ currentTarget: { dataset } });
const para = (v) => [{ t: "p", c: [{ t: "text", v }] }];
const lost = () => Object.assign(new Error("网络不太好"), { code: "NETWORK" });
// A promise the test settles later.
function later() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  Object.keys(require.cache)
    .filter((key) => key.startsWith(root + path.sep))
    .forEach((key) => delete require.cache[key]);
  h = { state: "ok", calls: [], asks: 0, nav: [], routes: {}, app: { globalData: {} }, pages: [], store: {}, ids: 0, user: "one" };
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
    pageScrollTo() {},
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

// ---- 中-4 批改: a photo read after leaving ------------------------------------
test("中-4 批改: a photo read after the page was left is kept for this account and shown on return, not read again", async () => {
  const scan = later();
  h.routes["UPLOAD /v1/chat/scan"] = () => scan.promise;
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  const page = load("pages/grade/index.js");
  page.onLoad({});
  const reading = page.read({ tempFilePath: "/tmp/d.jpg", size: 10 });
  page.onUnload();
  scan.resolve({ type: "solution", imageId: "img5", homework: 0, problems: [{ text: "求 (x^2)'", blocks: para("求 (x^2)'") }], solution: { steps: ["(x^2)'=2x"], unclear: "", blocks: para("1. (x^2)'=2x") }, suggest: null });
  await reading;
  await settle();
  assert.equal(h.store["tool_draft:grade:one"].scan.imageId, "img5", "kept for this account");
  // Another account on this phone does not get it.
  h.user = "two";
  const other = load("pages/grade/index.js");
  other.onLoad({});
  other.onShow();
  await settle();
  assert.equal(other.data.stage, "start");
  h.user = "one";
  const back = load("pages/grade/index.js");
  back.onLoad({});
  back.onShow();
  await settle();
  assert.equal(back.data.stage, "edit");
  assert.equal(back.data.problem, "求 (x^2)'");
  assert.deepEqual(back.data.lines, ["(x^2)'=2x"]);
  assert.equal(back.data.imageId, "img5");
  assert.equal(h.calls.filter((c) => c.method === "UPLOAD").length, 1, "the photo is not read (or counted) again");
  assert.equal(h.store["tool_draft:grade:one"].scan, undefined, "used once; what is typed is kept as before");
});

// ---- 中-1 / 中-2 讲一遍: one review per 讲完了 --------------------------------
function teachThread(withReview) {
  const said = { id: "u1", role: "user", kind: "text", status: "done", content: "外层乘内层", blocks: para("外层乘内层") };
  const review = {
    id: "r1",
    kind: "teach_review",
    role: "assistant",
    status: "done",
    blocks: [],
    review: { points: [{ text: "外层乘内层", status: "covered", quote: "", blocks: para("外层乘内层") }], wrong: [], best: "", said: null },
  };
  return { thread: { id: "t1", title: "链式法则", pointId: "p1" }, messages: withReview ? [said, review] : [] };
}
test("中-1/中-2 讲一遍: a retry and coming back send the same clientId; once reviewed nothing is left to resume", async () => {
  let reviewed = false;
  h.routes["GET /v1/chat/threads/t1"] = () => teachThread(reviewed);
  const answers = [() => Promise.reject(lost()), () => new Promise(() => {})];
  h.routes["POST /v1/chat/threads/t1/teach-review"] = () => answers.shift()();
  const page = load("pages/teach/index.js");
  page.onLoad({ id: "t1" });
  page.onShow();
  await settle();
  page.onDraft({ detail: { value: "外层乘内层" } });
  await page.finish();
  await settle();
  // The wait failed on the line: said once, the same text kept for 再对一次.
  assert.equal(page.data.reviewError, "网络不太好");
  assert.equal(page.data.reviewing, false);
  assert.equal(page.data.draft, "外层乘内层");
  const first = h.calls.filter((c) => c.method === "POST")[0].body;
  assert.ok(first.clientId, "讲完了 carries a clientId");
  assert.equal(h.store["tool_draft:teach:one"].review.clientId, first.clientId);
  page.finish();
  await settle();
  assert.equal(page.data.reviewing, true);
  assert.equal(h.calls.filter((c) => c.method === "POST")[1].body.clientId, first.clientId, "再对一次 is the same request");
  // Left while it is still being compared; the start says so.
  page.onUnload();
  const start = load("pages/teach/index.js");
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [{ id: "t1", title: "链式法则", tool: "teach", open: true, updatedAt: "2026-10-18T00:00:00Z" }] });
  start.onLoad({});
  start.onShow();
  await settle();
  assert.equal(start.data.resume.review, true);
  // Back on the thread: the same request again, answered with its review.
  reviewed = true;
  h.routes["POST /v1/chat/threads/t1/teach-review"] = () => ({ fallback: false, message: teachThread(true).messages[1] });
  const back = load("pages/teach/index.js");
  back.onLoad({ id: "t1" });
  back.onShow();
  await settle();
  const posts = h.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 3);
  assert.equal(posts[2].body.clientId, first.clientId, "coming back never asks for a second review");
  assert.equal(back.data.stage, "result");
  assert.equal(back.data.review.got, 1);
  assert.equal(back.data.messages.filter((m) => m.plain === "外层乘内层" || m.content === "外层乘内层").length, 1, "the text shows once");
  assert.equal(h.store["tool_draft:teach:one"], undefined, "reviewed: no 继续刚才的讲解 (低-2)");
  // A new text is a new request.
  back.goOn();
  back.onDraft({ detail: { value: "再补一句" } });
  back.finish();
  await settle();
  assert.notEqual(h.calls.filter((c) => c.method === "POST")[3].body.clientId, first.clientId);
});

test("中-2 讲一遍: the wait is the shared task-progress without a percentage; the button no longer says 在对照要点", () => {
  const wxml = read("pages/teach/index.wxml");
  assert.doesNotMatch(wxml, /在对照要点/);
  assert.match(wxml, /<task-progress steps="\{\{reviewSteps\}\}"[^>]*vague="\{\{true\}\}"/);
  assert.match(read("pages/teach/index.json"), /task-progress/);
  assert.match(read("components/task-progress/index.wxml"), /wx:if="\{\{!vague\}\}" class="st">\{\{percent\}\}%/);
});

test("低-2 讲一遍: a reviewed thread with nothing unsent is not offered as 接着讲", async () => {
  h.store["tool_draft:teach:one"] = { threadId: "t1", pointId: "p1", name: "链式法则", draft: "", review: null };
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [{ id: "t1", title: "链式法则", tool: "teach", open: false, updatedAt: "2026-10-18T00:00:00Z" }] });
  const page = load("pages/teach/index.js");
  page.onLoad({});
  page.onShow();
  await settle();
  assert.equal(page.data.resume, null);
  assert.equal(h.store["tool_draft:teach:one"], undefined);
});

// ---- 中-5 知识点 AI 加练 -------------------------------------------------------
function pointPage() {
  stub("utils/theme.js", { themed: (v) => v });
  const page = load("pages/point/index.js");
  page.alive = true;
  page.id = "limit-equivalent";
  page.setData({ point: { id: "limit-equivalent", name: "等价无穷小替换" } });
  return page;
}
const similar = {
  id: "m1",
  threadId: "t1",
  similar: {
    question: [{ type: "text", text: "AI 题" }],
    options: ["A", "B", "C", "D"].map((id) => ({ id, blocks: [{ type: "text", text: id }] })),
    revealed: false,
  },
};
test("中-5 AI 加练: a second tap and coming back ask with the same clientId; the problem is shown once it is in", async () => {
  const replies = [() => Promise.reject(lost())];
  const slow = later();
  replies.push(() => slow.promise);
  h.routes["POST /v1/chat/practice"] = () => replies.shift()();
  const page = pointPage();
  await page.aiStart();
  assert.equal(page.data.aiError, "网络不太好");
  const first = h.calls[0].body;
  assert.ok(first.clientId);
  assert.equal(h.store["tool_draft:practice:limit-equivalent:one"].clientId, first.clientId);
  // A second tap after the timeout: the same request, not a second problem to pay for.
  const second = page.aiStart();
  assert.equal(page.data.aiBusy, true);
  assert.equal(h.calls[1].body.clientId, first.clientId);
  assert.match(read("pages/point/index.wxml"), /<task-progress steps="\{\{aiSteps\}\}"[^>]*vague="\{\{true\}\}"/);
  // Left before it came: kept, and fetched again on return.
  page.unloaded = true;
  slow.resolve({ thread: { id: "t1" }, message: similar });
  await second;
  assert.ok(h.store["tool_draft:practice:limit-equivalent:one"], "not shown yet, still kept");
  h.routes["POST /v1/chat/practice"] = () => ({ thread: { id: "t1" }, message: similar });
  const back = pointPage();
  await back.aiStart();
  assert.equal(h.calls[2].body.clientId, first.clientId);
  assert.equal(back.data.ai.choice, true);
  assert.equal(h.store["tool_draft:practice:limit-equivalent:one"], undefined, "shown: the next one is a new request");
  await back.aiStart();
  assert.notEqual(h.calls[3].body.clientId, first.clientId);
});

// ---- 中-7 更多 on 批改 and 讲一遍 history; 解题 passes `next` back -------------
test("中-7 批改 and 讲一遍 history: 更多 passes the server's next back unchanged", async () => {
  for (const [name, tool] of [["pages/grade/index.js", "grade"], ["pages/teach/index.js", "teach"]]) {
    h.calls = [];
    const rows = (from, n) => Array.from({ length: n }, (_, i) => ({ id: `${tool}${from + i}`, title: "题", tool, open: false, updatedAt: "2026-10-18T00:00:00Z" }));
    h.routes["GET /v1/chat/threads"] = (body, url) => (/before=/.test(url) ? { threads: rows(20, 3), next: null } : { threads: rows(0, 20), next: "2026-10-18T00:00:00Z|x 1" });
    const page = load(name);
    page.onLoad({});
    page.onShow();
    await settle();
    assert.equal(h.calls[0].url, `/v1/chat/threads?kind=solve&tool=${tool}&limit=20&tone=light`);
    assert.equal(page.data.history.length, 20);
    assert.equal(page.data.historyMore, true);
    await page.moreHistory();
    assert.equal(h.calls.at(-1).url, `/v1/chat/threads?kind=solve&tool=${tool}&limit=20&before=${encodeURIComponent("2026-10-18T00:00:00Z|x 1")}&tone=light`);
    assert.equal(page.data.history.length, 23);
    assert.equal(page.data.historyMore, false);
    // a full row, 更早的记录 (讲一遍 shows it once 全部记录 is open).
    assert.match(read(name.replace(".js", ".wxml")), /wx:if="\{\{(?:historyAll && )?historyMore\}\}" class="more-line"[^>]*bindtap="moreHistory"[^>]*>\{\{historyBusy \? '打开中…' : '更早的记录'\}\}/);
  }
});

test("解题 history: the server's next goes back unchanged as before; an older server gets the last row's time", async () => {
  const rows = (from, n) => Array.from({ length: n }, (_, i) => ({ id: `s${from + i}`, title: "题", updatedAt: "2026-10-18T00:00:00Z" }));
  h.routes["GET /v1/chat/threads"] = (body, url) => (/before=/.test(url) ? { threads: rows(100, 2), next: null } : { threads: rows(0, 100), next: "2026-10-18T00:00:00Z|s99" });
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onShow();
  await settle();
  assert.equal(page.data.more, true);
  await page.moreThreads();
  assert.equal(h.calls.at(-1).url, `/v1/chat/threads?kind=solve&tool=ask&limit=100&before=${encodeURIComponent("2026-10-18T00:00:00Z|s99")}`);
  assert.equal(page.data.threads.length, 102, "rows with the same time are not skipped");
  assert.equal(page.data.more, false);
});

// ---- small ones -----------------------------------------------------------------
test("低-1 批改 page progress counts 题; other waits still count 批", () => {
  const { progressView } = require(file("utils/job.js"));
  const steps = [{ key: "read", label: "认出题目" }, { key: "grade", label: "一道道批改" }];
  const job = { status: "running", progress: { stage: "grade", step: 2, steps: 3 } };
  assert.equal(progressView(steps, job, { unit: "题" }).rows[1].note, "第 2/3 题");
  assert.equal(progressView(steps, job).rows[1].note, "第 2/3 批");
  assert.match(read("pages/grade/index.wxml"), /<task-progress steps="\{\{pageSteps\}\}"[^>]*unit="题"/);
});

test("低-9 批改 history: a failed load says so in one line with 再试一次", async () => {
  h.routes["GET /v1/chat/threads"] = () => {
    throw new Error("网络不太好");
  };
  const page = load("pages/grade/index.js");
  page.onLoad({});
  page.onShow();
  await settle();
  assert.equal(page.data.historyFailed, true);
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [{ id: "d1", title: "求导", open: false, updatedAt: "2026-10-18T00:00:00Z" }] });
  await page.retryHistory();
  assert.equal(page.data.historyFailed, false);
  assert.equal(page.data.history.length, 1);
  assert.match(read("pages/grade/index.wxml"), /wx:if="\{\{historyFailed\}\}" class="alert">记录没打开<text class="link" bindtap="retryHistory">再试一次/);
});

test("低-3 解题: 拍我的过程批改 and a photo of worked steps go to 批改, the photo handed over", () => {
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.setData({ thread: { id: "c1", problem: para("求导") } });
  page.act({ currentTarget: { dataset: { key: "draft" } } });
  assert.equal(h.nav.at(-1), "/pages/grade/index");
  const scan = { imageId: "img7", photo: "/tmp/s.jpg", problems: [{ text: "求导", index: 0 }], solution: { steps: ["y'=2x"], blocks: [] } };
  page.setData({ scan });
  page.gradeSteps();
  assert.equal(h.nav.at(-1), "/pages/grade/index");
  assert.equal(h.app.globalData.toolScan.to, "grade");
  assert.equal(h.app.globalData.toolScan.scan.imageId, "img7");
  assert.ok(!h.calls.some((c) => c.method === "POST"), "nothing graded on 解题");
  // 批改 takes it as read: no upload.
  const grade = load("pages/grade/index.js");
  grade.onLoad({});
  grade.onShow();
  assert.equal(grade.data.stage, "edit");
  assert.deepEqual(grade.data.lines, ["y'=2x"]);
  assert.equal(h.calls.filter((c) => c.method === "UPLOAD").length, 0);
});

test("低-6/低-15 段位: the record shows the streak in days; another account never sees the last one's", async () => {
  const gets = {};
  h.routes["GET /v1/learn/map"] = () => (gets.map = later()).promise;
  h.routes["GET /v1/me/study-time"] = () => (gets.study = later()).promise;
  const page = load("pages/ranks/index.js");
  page.onLoad && page.onLoad({});
  page.onShow();
  const firstStudy = gets.study;
  gets.map.resolve({ summary: { level: 3, correct: 2, total: 10 } });
  gets.study.resolve({ enabled: true, totalDays: 12, currentStreak: 4, today: 25, totalMinutes: 200 });
  await settle();
  // Asked again (another visit); its answer comes after the account switch.
  page.onShow();
  const late = gets.study;
  assert.notEqual(late, firstStudy);
  assert.deepEqual(page.data.record, { days: 12, streak: 4, today: "25 分钟" });
  assert.equal(page.data.me.level, 3);
  assert.match(read("pages/ranks/index.wxml"), /\{\{record\.streak\}\} 天<\/text><text class="record-k">当前连续/);
  assert.doesNotMatch(read("pages/ranks/index.wxml"), /累计时长/);
  // Switched account: cleared at once; the first account's late answers are dropped.
  h.user = "two";
  page.onShow();
  assert.equal(page.data.me, null);
  assert.equal(page.data.record, null);
  late.resolve({ enabled: true, totalDays: 99, currentStreak: 9, today: 5 });
  await settle();
  assert.equal(page.data.record, null);
});

test("低-13 地图 下一步: an untouched point opens its explanation first; a seen one goes to practice", () => {
  stub("utils/request.js", { request: () => Promise.resolve({ data: null }) });
  const page = load("pages/map/index.js");
  page.track = () => {};
  const chapter = (state) => ({ id: "limit", next: { id: "p1", name: "极限" }, points: [{ id: "p1", ready: true, state }] });
  page.setData({ chapter: { id: "limit" }, next: page.nextOf(chapter("none")) });
  assert.equal(page.data.next.learn, true);
  page.nextTap();
  assert.equal(h.nav.at(-1), "/pages/knowledge/index?id=p1");
  page.setData({ next: page.nextOf(chapter("seen")) });
  page.nextTap();
  assert.equal(h.nav.at(-1), "/pages/point/index?id=p1");
  assert.match(read("pages/map/index.wxml"), /next\.ready && !next\.learn\?'练一题':'看看'/);
});

test("低-11 卡住了: the server's stand-in reply is not shown as help; it asks for one more tap", async () => {
  stub("utils/format.js", { errorText: (e) => e.message });
  stub("utils/chat-entry.js", { openAsk() {} });
  const actions = require(file("utils/point-actions.js"));
  h.routes["POST /v1/learn/points/p1/stuck"] = () => ({ crisis: false, quote: null, ask: "要不先看看第一步怎么起？", options: [], suggest: null, fallback: true });
  const page = { alive: true, data: { ...actions.STUCK_CLOSED, stuckOpen: true, stuckText: "不会化简", stuckBusy: false }, setData(p) { Object.assign(this.data, p); }, refresh() {} };
  await actions.sendStuck(page, { id: "p1", name: "极限" });
  assert.equal(page.data.stuckReply, null);
  assert.equal(page.data.stuckFallback, true);
  assert.equal(page.data.stuckText, "不会化简", "what was written stays");
  assert.equal(page.data.stuckBusy, false);
  assert.match(read("pages/knowledge/index.wxml"), /wx:elif="\{\{stuckFallback\}\}" class="alert">这次没想好，再点一次/);
});

test("低-10 资料: the wait line follows each poll's status", async () => {
  stub("utils/review.js", {});
  const api = require(file("utils/api.js"));
  const seen = [];
  let page;
  Object.assign(api, {
    pending: (job) => Boolean(job && ["queued", "running"].includes(job.status)),
    jobMessage: () => "没成功，再试一次",
    // Two polls: still queued, then started; the line says each.
    waitJob: (job, alive, limit, onUpdate) => {
      onUpdate({ ...job, status: "queued" });
      seen.push(page.data.waitLine.ask);
      onUpdate({ ...job, status: "running" });
      seen.push(page.data.waitLine.ask);
      return Promise.resolve({ ...job, status: "succeeded" });
    },
  });
  page = load("pages/material/index.js");
  page.alive = true;
  page.load = () => Promise.resolve();
  await page.follow("ask", Promise.resolve({ id: "j1", status: "queued", createdAt: new Date().toISOString() }));
  clearInterval(page.timers.ask);
  assert.match(seen[0], /^排着队/);
  assert.match(seen[1], /^已经开始/);
});

test("低-12/低-16 错题重做: the judge clientId stays until judged; drafts are kept per account", async () => {
  const posts = [];
  let fail = true;
  stub("utils/format.js", { errorText: (e) => e.message, dueText: () => "明天", sourceOf: () => ({ text: "" }) });
  stub("utils/learn.js", { backTo() {}, ROUTES: {} });
  stub("utils/chat-entry.js", { openAsk() {} });
  const api = require(file("utils/api.js"));
  Object.assign(api, {
    jobMessage: () => "",
    waitJob: () => Promise.resolve(),
    get: (url) => {
      if (url.startsWith("/v1/chat/messages/")) return Promise.resolve({ attempt: { result: { verdict: "correct", reference: null, cause: null } }, blocks: [] });
      if (url.startsWith("/v1/chat/threads/")) return Promise.resolve({ thread: {} });
      return Promise.resolve({ items: [{ id: "a", materialId: "a", status: "open", wrong: 1, due: false, dueOn: "2026-10-19", source: "judge", threadId: "t-a" }], counts: { open: 1, due: 0, mastered: 0, chapters: [] }, more: false });
    },
    post: (url, body) => {
      posts.push(body);
      if (fail) return Promise.reject(lost());
      return Promise.resolve({ judge: { id: "j1", job: { id: "job1" } } });
    },
  });
  h.store["mistake-redo:a:two"] = "别人的";
  const page = load("pages/mistakes/index.js");
  page.alive = true;
  await page.load();
  page.redo(tap({ id: "a" }));
  assert.equal(page.data.redo.answer, "", "another account's draft is not shown");
  page.onAnswer({ detail: { value: "1/2" } });
  assert.equal(h.store["mistake-redo:a:one"], "1/2");
  page.submitRedo();
  await settle();
  fail = false;
  page.submitRedo();
  await settle();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].clientId, posts[0].clientId, "a retry after a lost line is the same submission");
});

test("低-7 我的: the budget row comes from /v1/me/usage even when the chat counts failed", async () => {
  const budget = { day: { pct: 35, resetAt: new Date(Date.now() + 3600000).toISOString() }, week: { pct: 12, resetAt: new Date(Date.now() + 3 * 86400000).toISOString() } };
  h.routes["GET /v1/chat/usage"] = () => {
    throw Object.assign(new Error("服务开小差了"), { statusCode: 500 });
  };
  h.routes["GET /v1/me/usage"] = () => ({ date: "2026-10-18", budget });
  h.routes["GET /v1/learn/map"] = () => ({ chapters: [], summary: { level: 1 } });
  h.routes["GET /v1/cards/stats"] = () => ({ total: 0, closed: 0, clear: 0, tagCount: 0, closedByType: {}, predicted: 0, actual: 0 });
  h.routes["GET /v1/me/suggest-cards"] = () => ({ enabled: false });
  h.routes["GET /v1/me/prefs"] = () => ({ personalized: true, studyTime: false });
  h.routes["GET /v1/me/study-time"] = () => ({ enabled: true, day: "2026-10-18", today: 0, days: [], totalMinutes: 0, currentStreak: 0, bestStreak: 0 });
  stub("utils/format.js", { errorText: (e) => e.message });
  stub("utils/learn.js", { backTo() {}, ROUTES: {} });
  stub("utils/session.js", {});
  stub("utils/learning-space.js", { stickers: () => [] });
  const page = load("pages/profile/index.js");
  page.alive = true;
  page.loadVersion = 0;
  await page.load();
  assert.equal(page.data.budget, "今天已用 35% · 本周已用 12%");
  assert.equal(page.data.usage.length, 2);
  assert.equal(page.data.error, "服务开小差了", "the failure is still said");
});

test("低-17 资料复习 page says 回头看看, not 复习, inside the page", () => {
  const wxml = read("pages/review/index.wxml");
  assert.match(wxml, /回头看看|回头看过/);
  assert.doesNotMatch(wxml.replace(/<!--[\s\S]*?-->/g, ""), /复习/);
});
