"use strict";
// V4.2 W0: long waits survive leaving and coming back. Shared polling
// (utils/job.js), <task-progress>, import re-entry and retry, brainstorm
// retry for failed and unknown jobs, and the 随心记 "进行中" strip.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function put(file, exports) {
  require.cache[path.join(root, file)] = {
    id: path.join(root, file),
    filename: path.join(root, file),
    loaded: true,
    exports,
  };
}
function fresh(file) {
  delete require.cache[path.join(root, file)];
  return require(path.join(root, file));
}
function mockApi(api) {
  put("utils/api.js", {
    pending: (job) => Boolean(job && ["queued", "running"].includes(job.status)),
    jobMessage: (job) => (job && job.error && job.error.message) || "这次没跑完，可以再试一次",
    needsConsent: () => false,
    get: () => Promise.resolve(null),
    post: () => Promise.reject(new Error("unexpected post")),
    del: () => Promise.resolve({}),
    patch: () => Promise.resolve({}),
    uploadTo: () => Promise.reject(new Error("unexpected upload")),
    ...api,
  });
}
function mockBase(nav) {
  global.getApp = () => ({ globalData: {} });
  global.getCurrentPages = () => [];
  global.wx = {
    getStorageSync: () => "",
    showToast() {},
    showModal: (value) => nav.push(["modal", value.title]),
    navigateTo: (value) => nav.push(["navigate", value.url]),
    redirectTo: (value) => nav.push(["redirect", value.url]),
    switchTab: (value) => nav.push(["tab", value.url]),
    navigateBack: () => nav.push(["back"]),
    chooseMedia() {},
    chooseMessageFile() {},
  };
  put("utils/auth.js", { getUser: () => ({ id: "u1" }), hasConsent: () => true });
  put("utils/gate.js", { state: () => "ok", check: () => true, ask() {} });
  put("utils/theme.js", { themed: (value) => value });
}
function loadPage(file, api) {
  const nav = [];
  let definition;
  mockBase(nav);
  mockApi(api);
  global.Page = (value) => {
    definition = value;
  };
  for (const name of ["utils/job.js", "pages/import/view.js", "pages/brainstorm/view.js"])
    delete require.cache[path.join(root, name)];
  fresh(file);
  definition.data = structuredClone(definition.data);
  definition.setData = (patch) => Object.assign(definition.data, patch);
  return { page: definition, nav };
}
function loadComponent(file, api, properties = {}) {
  const nav = [];
  let definition;
  mockBase(nav);
  mockApi(api);
  global.Component = (value) => {
    definition = value;
  };
  delete require.cache[path.join(root, "utils/job.js")];
  const exported = fresh(file);
  const events = [];
  const instance = {
    data: structuredClone(definition.data),
    properties: { ...Object.fromEntries(Object.entries(definition.properties || {}).map(([k, v]) => [k, v.value])), ...properties },
    setData(patch) {
      Object.assign(this.data, patch);
    },
    triggerEvent: (name, detail) => events.push([name, detail]),
    ...definition.methods,
  };
  return { instance, definition, events, nav, exported };
}

// ---- utils/job.js -------------------------------------------------------

test("polling keeps going through a short offline spell and resumes after onShow", async () => {
  const answers = [
    () => Promise.reject(Object.assign(new Error("网络不太好"), { code: "NETWORK" })),
    () => Promise.reject(Object.assign(new Error("忙"), { statusCode: 502 })),
    () => Promise.resolve({ id: "j1", status: "running", progress: { stage: "read", page: 2, pages: 3 } }),
    () => Promise.resolve({ id: "j1", status: "succeeded" }),
  ];
  const calls = [];
  mockApi({
    get: (url) => {
      calls.push(url);
      return answers[Math.min(calls.length - 1, answers.length - 1)]();
    },
    post: () => assert.fail("watching never cancels or posts"),
    del: () => assert.fail("watching never cancels"),
  });
  const { watch } = fresh("utils/job.js");
  const updates = [],
    errors = [];
  let done = null;
  const w = watch(
    { id: "j1", status: "queued" },
    {
      interval: 5,
      maxDelay: 20,
      onUpdate: (job) => updates.push(job.status),
      onDone: (job) => (done = job),
      onError: (error, { retrying }) => errors.push([error.code || error.statusCode, retrying]),
    },
  );
  for (let i = 0; i < 100 && calls.length < 3; i++) await sleep(5);
  assert.deepEqual(errors, [["NETWORK", true], [502, true]]);
  assert.deepEqual(updates, ["running"]);
  // onHide: nothing is asked while paused.
  w.pause();
  const asked = calls.length;
  await sleep(40);
  assert.equal(calls.length, asked);
  assert.equal(done, null);
  // onShow: asks right away and finishes.
  w.resume();
  for (let i = 0; i < 100 && !done; i++) await sleep(5);
  assert.equal(done.status, "succeeded");
  assert.equal(w.active(), false);
  assert.deepEqual(calls.every((url) => url === "/v1/jobs/j1"), true);
});

test("stop (onUnload) drops late answers; a 404 stops with an error", async () => {
  let release;
  mockApi({ get: () => new Promise((resolve) => (release = resolve)) });
  const { watch } = fresh("utils/job.js");
  const seen = [];
  const w = watch({ id: "j2", status: "running" }, { interval: 1, onUpdate: () => seen.push("update"), onDone: () => seen.push("done") });
  await sleep(10);
  w.stop();
  release({ id: "j2", status: "succeeded" });
  await flush();
  assert.deepEqual(seen, []);

  mockApi({ get: () => Promise.reject(Object.assign(new Error("没找到"), { statusCode: 404, code: "NOT_FOUND" })) });
  const errors = [];
  const gone = fresh("utils/job.js").watch({ id: "j3", status: "running" }, { interval: 1, onError: (e, o) => errors.push(o.retrying) });
  await sleep(20);
  assert.deepEqual(errors, [false]);
  assert.equal(gone.active(), false);
});

test("the progress bar follows real stages, never goes back and never shows 100 before success", () => {
  mockApi({});
  const { progressView, elapsedText } = fresh("utils/job.js");
  const steps = [
    { key: "split", label: "拆成卡" },
    { key: "check", label: "检查一遍" },
  ];
  const first = progressView(steps, { id: "j", status: "running", progress: { stage: "split", step: 1, steps: 2, chars: 300, expect: 600 } });
  assert.deepEqual(first.rows.map((row) => row.state), ["now", "todo"]);
  assert.equal(first.rows[0].note, "第 1/2 批");
  assert.ok(first.percent > 0 && first.percent < 50);
  const later = progressView(steps, { id: "j", status: "running", progress: { stage: "check" } }, { floor: first.percent });
  assert.deepEqual(later.rows.map((row) => row.state), ["done", "now"]);
  assert.ok(later.percent >= 50);
  // Stream restarting at 0 chars: the bar holds.
  const back = progressView(steps, { id: "j", status: "running", progress: { stage: "split", step: 1, steps: 2, chars: 0, expect: 600 } }, { floor: 40 });
  assert.equal(back.percent, 40);
  // Time alone never reaches 100.
  const long = progressView(steps, { id: "j", status: "running" }, { elapsedMs: 3600_000 });
  assert.ok(long.percent <= 95);
  const done = progressView(steps, { id: "j", status: "succeeded" });
  assert.equal(done.percent, 100);
  assert.deepEqual(done.rows.map((row) => row.state), ["done", "done"]);
  // Unknown is a plain failure that keeps where it stopped.
  const failed = progressView(steps, { id: "j", status: "unknown", error: { code: "AI_TIMEOUT", message: "这次想得有点久，没跑完，可以再试一次" } }, { floor: 62, lastIndex: 1 });
  assert.equal(failed.failed, true);
  assert.equal(failed.percent, 62);
  assert.deepEqual(failed.rows.map((row) => row.state), ["done", "stop"]);
  assert.match(failed.message, /再试一次/);
  assert.doesNotMatch(failed.message, /费用|多用/);
  assert.equal(elapsedText(35_000), "已用 35 秒");
  assert.equal(elapsedText(95_000), "已用 1 分 35 秒");
});

test("<task-progress> shows steps, elapsed time, the slow line, and 重试 on failure", () => {
  const steps = [{ key: "read", label: "认图片里的字" }];
  const created = new Date(Date.now() - 40_000).toISOString();
  const { instance, events } = loadComponent("components/task-progress/index.js", {}, {
    steps,
    job: { id: "j", status: "running", createdAt: created, progress: { stage: "read", page: 2, pages: 3 } },
  });
  instance.update();
  instance.halt();
  assert.equal(instance.data.rows[0].state, "now");
  assert.equal(instance.data.rows[0].note, "第 2/3 页");
  assert.match(instance.data.elapsed, /^已用 (39|40|41) 秒$/);
  assert.equal(instance.data.slow, true);
  assert.ok(instance.data.percent > 0 && instance.data.percent < 100);
  instance.properties.job = { id: "j", status: "failed", createdAt: created, error: { message: "这次没跑完，可以再试一次" } };
  instance.update();
  assert.equal(instance.data.failed, true);
  assert.equal(instance.data.elapsed, "");
  assert.equal(instance.data.message, "这次没跑完，可以再试一次");
  instance.retry();
  assert.deepEqual(events, [["retry", { jobId: "j" }]]);
  instance.properties.busy = true;
  instance.retry();
  assert.equal(events.length, 1);
  const wxml = fs.readFileSync(path.join(root, "components/task-progress/index.wxml"), "utf8");
  const wxss = fs.readFileSync(path.join(root, "components/task-progress/index.wxss"), "utf8");
  assert.match(wxml, /class="prg /);
  assert.doesNotMatch(wxml + wxss, /class="bar|\.bar\b|spinner|border-left: *[2-9]/);
  assert.match(wxss, /min-height: 88rpx/);
});

// ---- import pages -------------------------------------------------------

const readingItem = (job, extra = {}) => ({
  id: "imp-1",
  source: "photo",
  status: "reading",
  chars: 30,
  segments: [],
  pages: [{ n: 1, ok: true }, { n: 2, ok: false }, { n: 3, ok: false }],
  needsOcr: { pages: 2, available: 8 },
  retryPages: 0,
  failedJob: null,
  job,
  ...extra,
});

test("re-entering an import restores the running read with its progress, and a failed read retries only the missing pages", async () => {
  const running = { id: "job-r", kind: "import_read", status: "running", progress: { stage: "read", page: 2, pages: 3 } };
  const posts = [];
  let item = readingItem(running);
  const { page, nav } = loadPage("pages/import/source/index.js", {
    get: (url) => Promise.resolve(url.startsWith("/v1/jobs/") ? running : item),
    post: (url, body) => {
      posts.push([url, body]);
      return Promise.resolve({ import: readingItem({ id: "job-r2", kind: "import_read", status: "queued" }) });
    },
  });
  page.onLoad({ id: "imp-1" });
  page.onShow();
  await flush();
  await flush();
  assert.equal(page.data.task.phase, "read");
  assert.equal(page.data.task.job.progress.page, 2);
  assert.equal(page.data.waiting, true);
  assert.ok(page.watcher && page.watcher.active());
  // While a read runs, the old "有几页是图片" dialog does not pop up.
  assert.deepEqual(nav.filter((entry) => entry[0] === "modal"), []);
  page.onHide();
  page.onUnload();

  // The read did not finish: the import kept page 1 and offers 重试 / 先用读到的.
  const failed = { id: "job-r", kind: "import_read", status: "unknown", error: { code: "AI_TIMEOUT", message: "这次想得有点久，没跑完，可以再试一次" } };
  item = readingItem(null, { failedJob: failed, retryPages: 2 });
  const again = loadPage("pages/import/source/index.js", {
    get: () => Promise.resolve(item),
    post: (url, body) => {
      posts.push([url, body]);
      return Promise.resolve({ import: readingItem({ id: "job-r2", kind: "import_read", status: "queued" }) });
    },
  });
  again.page.onLoad({ id: "imp-1" });
  again.page.onShow();
  await flush();
  await flush();
  assert.equal(again.page.data.task.job.status, "unknown");
  assert.equal(again.page.data.task.canSkip, true);
  assert.equal(again.page.data.waiting, false);
  assert.deepEqual(again.nav.filter((entry) => entry[0] === "modal"), []);
  await again.page.retryTask();
  assert.deepEqual(posts.at(-1), ["/v1/imports/imp-1/read", { pages: 2 }]);
  assert.equal(again.page.data.task.job.status, "queued");
  await again.page.skipFailed();
  assert.deepEqual(posts.at(-1), ["/v1/imports/imp-1/read", { pages: 0 }]);
  again.page.onUnload();
});

test("a failed split comes back as the read text with 重试 that splits again", async () => {
  const posts = [];
  const item = {
    id: "imp-2",
    source: "paste",
    status: "read",
    chars: 20,
    segments: [{ n: 1, text: "极限的定义" }],
    pages: [],
    job: null,
    failedJob: { id: "job-s", kind: "import_cards", status: "unknown", error: { code: "AI_BAD_OUTPUT", message: "这次没跑完，可以再试一次" } },
  };
  const { page } = loadPage("pages/import/source/index.js", {
    get: () => Promise.resolve(item),
    post: (url, body) => {
      posts.push([url, body]);
      return Promise.resolve({ import: { ...item, status: "splitting", failedJob: null, job: { id: "job-s2", kind: "import_cards", status: "queued" } } });
    },
  });
  page.onLoad({ id: "imp-2" });
  page.onShow();
  await flush();
  await flush();
  assert.equal(page.data.task.phase, "split");
  assert.equal(page.data.task.job.status, "unknown");
  await page.retryTask();
  assert.equal(posts[0][0], "/v1/imports/imp-2/cards");
  assert.match(posts[0][1].clientId, /^split-/);
  assert.equal(page.data.task.job.id, "job-s2");
  assert.equal(page.data.waiting, true);
  page.onUnload();

  // The split page sends a reverted import back to the source page.
  const split = loadPage("pages/import/split/index.js", { get: () => Promise.resolve(item) });
  split.page.onLoad({ id: "imp-2" });
  split.page.onShow();
  await flush();
  await flush();
  assert.deepEqual(split.nav, [["redirect", "/pages/import/source/index?id=imp-2"]]);
  split.page.onUnload();
});

test("the import entry offers 上次的导入还没完成 · 继续 / 放弃", async () => {
  const gets = [],
    posts = [];
  const open = { items: [{ id: "imp-9", status: "splitting", source: "photo", title: "错题照片", job: { id: "j", status: "running" } }] };
  const { page } = loadPage("pages/import/source/index.js", {
    get: (url) => {
      gets.push(url);
      // the import page asks for every unfinished import (all=1).
      return Promise.resolve(url === "/v1/imports?open=1&all=1" ? open : { id: "imp-9", status: "splitting", segments: [], job: null });
    },
    post: (url) => {
      posts.push(url);
      return Promise.resolve({ import: { id: "imp-9", status: "abandoned" } });
    },
  });
  page.onLoad({});
  page.onShow();
  await flush();
  await flush();
  assert.deepEqual(page.data.resume, { id: "imp-9", status: "splitting", title: "错题照片" });
  await page.resumeDrop();
  assert.deepEqual(posts, ["/v1/imports/imp-9/abandon"]);
  assert.equal(page.data.resume, null);

  page.setData({ resume: { id: "imp-9", status: "splitting", title: "错题照片" } });
  await page.resumeOpen();
  assert.equal(page.importId, "imp-9");
  assert.equal(gets.at(-1), "/v1/imports/imp-9");
  page.onUnload();
  const wxml = fs.readFileSync(path.join(root, "pages/import/source/index.wxml"), "utf8");
  assert.match(wxml, /上次的导入还没完成/);
  assert.match(wxml, /bindtap="resumeOpen">继续</);
  assert.match(wxml, /bindtap="resumeDrop">放弃</);
  assert.match(wxml, /<task-progress[^>]*bind:retry="retryTask"/);
});

// ---- brainstorm ---------------------------------------------------------

const brainCards = [1, 2, 3].map((n) => ({ id: `c${n}`, type: "idea", scene: "study", title: `卡 ${n}`, text: "x", tags: [] }));
const brainstorm = (job, status = "picked") => ({
  id: "bs-1",
  scene: "study",
  size: "small",
  status,
  cards: brainCards,
  facts: { commonPrereqs: [], mistakeCauses: [], sawAnswer: 0 },
  result: null,
  picks: {},
  job,
});

test("a brainstorm that ended unknown shows 重试, which starts the same cards again", async () => {
  const posts = [];
  const unknown = { id: "job-1", kind: "brainstorm", status: "unknown", error: { code: "AI_TIMEOUT", message: "这次想得有点久，没跑完，可以再试一次" } };
  const { page, nav } = loadPage("pages/brainstorm/process/index.js", {
    get: () => Promise.resolve(brainstorm(unknown)),
    post: (url, body) => {
      posts.push([url, body]);
      return Promise.resolve({ brainstorm: brainstorm({ id: "job-2", kind: "brainstorm", status: "queued" }, "running") });
    },
  });
  page.onLoad({ id: "bs-1" });
  page.onShow();
  await flush();
  await flush();
  assert.equal(page.data.failed, true);
  assert.equal(page.data.task.job.status, "unknown");
  assert.equal(page.data.error, "");
  assert.deepEqual(page.data.steps.map((step) => step.key), ["cards", "think", "tidy"]);
  await page.retryRun();
  assert.equal(posts[0][0], "/v1/brainstorms");
  assert.deepEqual(posts[0][1].cardIds, ["c1", "c2", "c3"]);
  assert.equal(page.data.failed, false);
  assert.equal(page.data.task.job.id, "job-2");
  assert.ok(page.watcher && page.watcher.active());
  assert.deepEqual(nav, []);
  page.onUnload();

  // Cards changed since: the server answers with another brainstorm; go there.
  const moved = loadPage("pages/brainstorm/process/index.js", {
    get: () => Promise.resolve(brainstorm({ ...unknown, status: "failed" })),
    post: () => Promise.resolve({ brainstorm: { ...brainstorm({ id: "job-3", status: "queued" }, "running"), id: "bs-2" } }),
  });
  moved.page.onLoad({ id: "bs-1" });
  moved.page.onShow();
  await flush();
  await flush();
  assert.equal(moved.page.data.failed, true);
  await moved.page.retryRun();
  assert.deepEqual(moved.nav, [["redirect", "/pages/brainstorm/process/index?id=bs-2"]]);
  moved.page.onUnload();
});

test("leaving a running brainstorm stops asking; coming back picks the job up again", async () => {
  const gets = [];
  const { page } = loadPage("pages/brainstorm/process/index.js", {
    get: (url) => {
      gets.push(url);
      return Promise.resolve(brainstorm({ id: "job-1", status: "running", progress: { stage: "think", chars: 200, expect: 800 } }, "running"));
    },
  });
  page.onLoad({ id: "bs-1" });
  page.onShow();
  await flush();
  await flush();
  assert.equal(page.data.task.job.progress.stage, "think");
  const first = page.watcher;
  assert.ok(first.active());
  page.onHide();
  assert.equal(first.active(), false);
  page.onShow();
  await flush();
  await flush();
  assert.ok(page.watcher && page.watcher.active());
  assert.equal(gets.filter((url) => url === "/v1/brainstorms/bs-1").length, 2);
  page.onUnload();
  const view = fresh("pages/brainstorm/view.js");
  assert.equal(view.jobLine({ status: "succeeded" }), "理好了");
  const importView = fresh("pages/import/view.js");
  assert.equal(importView.jobLine({ status: "succeeded" }, "split"), "拆好了");
});

// ---- 随心记 strip -------------------------------------------------------

test("the 进行中 strip lists unfinished imports and brainstorms and opens the right page", async () => {
  const imports = {
    items: [
      { id: "i1", status: "reading", title: "三张错题", pages: { done: 2, total: 5 }, job: { kind: "import_read", status: "running" }, updatedAt: "2026-10-18T03:00:00.000Z" },
      { id: "i2", status: "splitting", title: "高数笔记", job: { kind: "import_cards", status: "running" }, updatedAt: "2026-10-18T02:00:00.000Z" },
      { id: "i3", status: "picking", title: "群聊截图", job: null, updatedAt: "2026-10-18T01:00:00.000Z" },
      { id: "i4", status: "read", title: "周记", job: { kind: "import_cards", status: "unknown" }, updatedAt: "2026-10-17T01:00:00.000Z" },
    ],
  };
  const brainstorms = {
    items: [{ id: "b1", status: "picked", title: "", count: 4, job: { status: "failed" }, updatedAt: "2026-10-18T04:00:00.000Z" }],
  };
  const { instance, nav } = loadComponent("components/task-strip/index.js", {
    get: (url) => Promise.resolve(url.startsWith("/v1/imports") ? imports : brainstorms),
  });
  await instance.refresh();
  assert.deepEqual(
    instance.data.rows.map((row) => [row.title, row.state]),
    [
      ["4 张卡的头脑风暴", "没跑完，点开重试"],
      ["三张错题", "第 3/5 页"],
      ["高数笔记", "拆卡中"],
      ["群聊截图", "可以挑卡了"],
      ["周记", "没跑完，点开重试"],
    ],
  );
  instance.open({ currentTarget: { dataset: { url: instance.data.rows[3].url } } });
  instance.open({ currentTarget: { dataset: { url: instance.data.rows[0].url } } });
  instance.open({ currentTarget: { dataset: { url: instance.data.rows[1].url } } });
  assert.deepEqual(nav, [
    ["navigate", "/pages/import/split/index?id=i3"],
    ["navigate", "/pages/brainstorm/process/index?id=b1"],
    ["navigate", "/pages/import/source/index?id=i1"],
  ]);

  // Nothing unfinished: no rows, so the strip is hidden.
  const empty = loadComponent("components/task-strip/index.js", { get: () => Promise.resolve({ items: [] }) });
  await empty.instance.refresh();
  assert.deepEqual(empty.instance.data.rows, []);
  const wxml = fs.readFileSync(path.join(root, "components/task-strip/index.wxml"), "utf8");
  assert.match(wxml, /wx:if="\{\{rows.length\}\}"/);
  const notes = fs.readFileSync(path.join(root, "pages/notes/index.wxml"), "utf8");
  assert.match(notes, /<task-strip /);
  assert.match(fs.readFileSync(path.join(root, "pages/notes/index.json"), "utf8"), /components\/task-strip\/index/);
});
