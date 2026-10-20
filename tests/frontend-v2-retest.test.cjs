"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const file = path.join(root, "pages/point/index.js");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function put(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function setPath(target, key, value) {
  const parts = key.split(".");
  let current = target;
  for (let i = 0; i < parts.length - 1; i++) {
    current[parts[i]] = current[parts[i]] || {};
    current = current[parts[i]];
  }
  current[parts.at(-1)] = value;
}

function fixture(extra = {}) {
  return {
    id: "limit-equivalent",
    name: "等价无穷小替换",
    section: "1.7",
    tier: "重点",
    xp: 20,
    chapter: { id: "limit", short: "极限", book: "第 1 章" },
    prereqs: [],
    state: "self",
    self: true,
    correct: false,
    review: false,
    practice: false,
    red: true,
    retest: {
      id: 9,
      cause: "explanation",
      problemIndex: 3,
      round: 1,
      dueOn: "2026-10-11",
      predicted: null,
      result: null,
      mode: true,
      repeated: false,
    },
    // The same object answers GET …/practice too (this api stub returns one
    // fixture for every GET); since 0.6.0 the page reads the bank problem
    // from there : format, total, blanks.
    problem: {
      index: 3,
      total: 4,
      format: "blanks",
      blanks: [{ label: "", note: "分数、根号、π、e 都能认出" }],
      blocks: [{ type: "text", text: "题目" }],
      hasHint: true,
    },
    ...extra,
  };
}

function brief() {
  return {
    xp: 0,
    level: 1,
    levelXp: 0,
    levelNeed: 20,
    maxed: false,
    book: { rank: "起步" },
    chapters: [{ id: "limit", rank: "起步", tiers: [] }],
  };
}

function load(api, wxExtra = {}) {
  let definition;
  let user = { id: "user-a" };
  const app = { globalData: {} };
  global.Page = (value) => {
    definition = value;
  };
  global.getApp = () => app;
  global.getCurrentPages = () => [];
  global.wx = {
    setNavigationBarTitle() {},
    setNavigationBarColor() {},
    setBackgroundColor() {},
    showToast() {},
    showModal() {},
    navigateTo() {},
    navigateBack() {},
    redirectTo() {},
    switchTab() {},
    showActionSheet() {},
    getStorageSync() {
      return null;
    },
    ...wxExtra,
  };
  put(path.join(root, "utils/api.js"), api);
  put(path.join(root, "utils/auth.js"), {
    getUser: () => user,
    hasConsent: () => true,
    login: () => Promise.resolve(user),
  });
  // the point page keeps half-filled answers (pointDraft, keepPointDraft).
  put(path.join(root, "utils/learning-space.js"), { remember() {}, pointDraft: () => null, keepPointDraft() {} });
  put(path.join(root, "utils/theme.js"), { themed: (value) => value });
  put(path.join(root, "utils/format.js"), {
    errorText: (error) => error.message || "失败",
  });
  put(path.join(root, "utils/learn.js"), {
    TIER_CLS: { 重点: "key" },
    STATE_TEXT: {
      none: "还没做",
      self: "我会了",
      correct: "做对过",
      due: "该回头看看了",
    },
    RANK_LINES: {},
    stampOf: () => "start",
    retryText: (error) => error.message,
    moment: () => ({ levelUp: null, rankUp: null, book: null }),
    tierCells: () => [],
    tierCount: () => "",
    sheetCount: () => "",
    answerHints: (problem) => ({
      placeholder: "写精确值，如 3/4",
      hint: problem.note,
    }),
    verdictText: (result) =>
      result.verdict === "correct" ? "做对了" : "不对，可以再试",
    backTo() {},
    ROUTES: {},
  });
  delete require.cache[file];
  require(file);
  definition.data = structuredClone(definition.data);
  definition.setData = (patch) => {
    for (const [key, value] of Object.entries(patch))
      key.includes(".")
        ? setPath(definition.data, key, value)
        : (definition.data[key] = value);
  };
  return {
    page: definition,
    app,
    changeUser(value) {
      user = value;
    },
  };
}

test("due retest gates the answer on a prediction and submits its real variant index", async () => {
  const calls = [];
  const before = brief();
  const api = {
    get: () => Promise.resolve(fixture()),
    post(url, body) {
      calls.push([url, body]);
      if (url.endsWith("/submit"))
        return Promise.resolve({
          verdict: "incorrect",
          counted: "none",
          practice: false,
          xp: 0,
          before,
          after: before,
          retest: {
            id: 9,
            result: "wrong",
            predicted: body.predicted,
            mode: false,
            next: { problemIndex: 4, round: 2 },
          },
        });
      return Promise.resolve({ state: "self" });
    },
    needsConsent: () => false,
  };
  const { page, app } = load(api);
  page.alive = true;
  page.id = "limit-equivalent";
  await page.load();
  assert.equal(page.data.point.retestMode, true);
  assert.equal(page.data.point.problem.index, 3);
  assert.match(page.data.point.retest.line, /10\/9 .*解析/);
  page.onPad({ detail: { values: ["1/2"], active: 0 } });
  page.submit();
  assert.equal(calls.filter(([url]) => url.endsWith("/submit")).length, 0);
  page.choosePrediction({ currentTarget: { dataset: { prediction: "yes" } } });
  await page.submit();
  const answer = calls.find(([url]) => url.endsWith("/submit"));
  assert.deepEqual(answer[1], {
    answer: "1/2",
    index: 3,
    tone: "light",
    predicted: "yes",
  });
  assert.equal(page.data.result.predictionLine, "你觉得能，结果没做出来");
  assert.equal(page.data.result.retestWrong, true);
  // A retest result never shows XP.
  assert.equal(page.data.result.retest, true);
  page.wrongNoteInput({ detail: { value: "我卡在展开后比较阶数这一步" } });
  page.collectWrong();
  assert.equal(app.globalData.collect.pointId, "limit-equivalent");
  assert.equal(app.globalData.collect.origin, "map");
  assert.equal(app.globalData.collect.quote, "我卡在展开后比较阶数这一步");
});

test("retest hint waits for confirmation, records help with prediction and ignores a stale callback", async () => {
  const calls = [];
  let modal;
  const api = {
    get: () => Promise.resolve(fixture()),
    post(url, body) {
      calls.push([url, body]);
      if (body.action === "hint")
        return Promise.resolve({
          index: 3,
          blocks: [{ type: "text", text: "提示" }],
          practice: true,
          retest: {
            id: 9,
            result: "hinted",
            predicted: body.predicted,
            mode: false,
            next: null,
          },
        });
      return Promise.resolve({ state: "self" });
    },
    needsConsent: () => false,
  };
  const { page } = load(api, {
    showModal(options) {
      modal = options;
    },
  });
  page.alive = true;
  page.id = "limit-equivalent";
  await page.load();
  page.choosePrediction({ currentTarget: { dataset: { prediction: "yes" } } });
  page.showHint();
  assert.ok(modal);
  assert.equal(calls.filter(([, body]) => body.action === "hint").length, 0);
  modal.success({ confirm: true });
  await flush();
  const hint = calls.find(([, body]) => body.action === "hint");
  assert.deepEqual(hint[1], {
    action: "hint",
    pointId: "limit-equivalent",
    index: 3,
    tone: "light",
    predicted: "yes",
  });
  assert.equal(page.data.point.practice, true);
  assert.equal(page.data.predictionLocked, true);
  assert.match(page.data.helpNotice, /这一轮先不算过/);

  modal.complete();
  page.setData({ hint: null });
  page.showHint();
  page.onHide();
  modal.success({ confirm: true });
  await flush();
  assert.equal(calls.filter(([, body]) => body.action === "hint").length, 1);
});

test("ordinary hint also records the help day and explains the practice rule", async () => {
  const calls = [];
  let modal;
  const api = {
    get: () => Promise.resolve(fixture({ retest: null })),
    post(url, body) {
      calls.push([url, body]);
      if (body.action === "hint")
        return Promise.resolve({
          index: 3,
          blocks: [{ type: "text", text: "提示" }],
          practice: true,
          retest: { problemIndex: 4, mode: false },
        });
      return Promise.resolve({ state: "self" });
    },
    needsConsent: () => false,
  };
  const { page } = load(api, {
    showModal(options) {
      modal = options;
    },
  });
  page.alive = true;
  page.id = "limit-equivalent";
  await page.load();
  page.showHint();
  modal.success({ confirm: true });
  await flush();
  const hint = calls.find(([, body]) => body.action === "hint");
  assert.deepEqual(hint[1], {
    action: "hint",
    pointId: "limit-equivalent",
    index: 3,
    tone: "light",
  });
  assert.equal(page.data.point.practice, true);
  assert.match(page.data.helpNotice, /做对先算练习/);
});

test("point page keeps one AI warning and removes the old per-question draft badge", () => {
  const wxml = fs.readFileSync(
    path.join(root, "pages/point/index.wxml"),
    "utf8",
  );
  assert.match(wxml, /AI 生成可能有误，注意核实/);
  assert.doesNotMatch(wxml, /AI 起草 · 未经教师审定/);
  assert.match(wxml, /point\.retestMode/);
  assert.match(wxml, /point.retestMode&&!result/);
});

test("⋯ and 卡住了？ list only what applies: no solution before answering a retest", async () => {
  const sheets = [];
  const api = {
    get: () => Promise.resolve(fixture()),
    post: () => Promise.resolve({ state: "self" }),
    needsConsent: () => false,
  };
  const { page } = load(api, {
    showActionSheet(options) {
      sheets.push(options);
    },
  });
  page.alive = true;
  page.id = "limit-equivalent";
  await page.load();
  page.openMore();
  assert.deepEqual(sheets.at(-1).itemList, [
    "撤销“我会了”",
    "先不做",
    "这题有问题",
  ]);
  page.openStuck();
  assert.deepEqual(sheets.at(-1).itemList, ["给点提示", "记下卡住的一步"]);

  const plain = load(
    {
      get: () => Promise.resolve(fixture({ retest: null })),
      post: () => Promise.resolve({ state: "self" }),
      needsConsent: () => false,
    },
    {
      showActionSheet(options) {
        sheets.push(options);
      },
    },
  ).page;
  plain.alive = true;
  plain.id = "limit-equivalent";
  await plain.load();
  plain.openMore();
  assert.deepEqual(sheets.at(-1).itemList, [
    "撤销“我会了”",
    "先不做",
    "这题有问题",
  ]);
  plain.openStuck();
  assert.deepEqual(sheets.at(-1).itemList, [
    "给点提示",
    "看完整解析",
    "记下卡住的一步",
  ]);

  // No problem yet: no 卡住了？ row, so ⋯ keeps 记下卡住的一步 reachable.
  const empty = load(
    {
      get: () => Promise.resolve(fixture({ retest: null, problem: null })),
      post: () => Promise.resolve({ state: "self" }),
      needsConsent: () => false,
    },
    {
      showActionSheet(options) {
        sheets.push(options);
      },
    },
  ).page;
  empty.alive = true;
  empty.id = "limit-equivalent";
  await empty.load();
  empty.openMore();
  assert.deepEqual(sheets.at(-1).itemList, [
    "撤销“我会了”",
    "先不做",
    "记下卡住的一步",
  ]);
});
