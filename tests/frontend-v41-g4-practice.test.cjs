"use strict";
// V4.1 G4 : 练一题 on bank problems. GET …/practice gives the problem
// (choice or number blanks), POST …/submit judges it and returns the
// solution; 下一题 reads ?after=; once round the bank, 让 AI 再出一道 (only
// aiPractice points) or 回详情 / 换个知识点.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const file = path.join(root, "pages/point/index.js");

function put(modulePath, exports) {
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
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

function point(extra = {}) {
  return {
    id: "limit-equivalent",
    name: "等价无穷小替换",
    section: "1.7",
    tier: "重点",
    xp: 20,
    chapter: { id: "limit", short: "极限", book: "第 1 章" },
    prereqs: [],
    state: "none",
    self: false,
    correct: false,
    review: false,
    practice: false,
    red: false,
    retest: null,
    ...extra,
  };
}
const CHOICE = (index, total = 3) => ({
  mode: "practice",
  problem: {
    index,
    total,
    text: "题",
    blocks: [{ type: "text", text: `第 ${index} 题` }],
    hasHint: true,
    format: "choice",
    questions: [
      {
        prompt: "",
        blocks: [],
        options: ["A", "B", "C", "D"].map((id) => ({ id, text: id, blocks: [] })),
      },
    ],
  },
  tries: 0,
  correct: false,
  aiPractice: true,
});
const MULTI = (index, total = 2, aiPractice = false) => ({
  mode: "practice",
  problem: {
    index,
    total,
    blocks: [{ type: "text", text: "多空" }],
    hasHint: false,
    format: "blanks",
    blanks: [
      { label: "a", note: "" },
      { label: "b", note: "" },
    ],
  },
  tries: 0,
  correct: false,
  aiPractice,
});
const before = { xp: 0, level: 1, levelXp: 0, levelNeed: 20, maxed: false, book: { rank: "起步" }, chapters: [] };
const judged = (verdict, extra = {}) => ({
  verdict,
  counted: "none",
  practice: false,
  xp: 0,
  before,
  after: before,
  index: 0,
  solution:
    verdict === "unsure"
      ? null
      : {
          correct: { options: ["B"], blocks: [{ type: "text", text: "B" }] },
          explanation: [{ type: "text", text: "解法" }],
        },
  ...extra,
});

function load(api, wxExtra = {}) {
  let definition;
  let user = { id: "user-a" };
  const nav = [];
  const toasts = [];
  global.Page = (value) => {
    definition = value;
  };
  global.getApp = () => ({ globalData: {} });
  global.getCurrentPages = () => [];
  global.wx = {
    setNavigationBarTitle() {},
    setNavigationBarColor() {},
    setBackgroundColor() {},
    showToast(o) {
      toasts.push(o.title);
    },
    showModal() {},
    navigateTo() {},
    navigateBack() {},
    redirectTo() {},
    switchTab() {},
    showActionSheet() {},
    pageScrollTo() {},
    getStorageSync: () => null,
    ...wxExtra,
  };
  put(path.join(root, "utils/api.js"), { needsConsent: () => false, ...api });
  put(path.join(root, "utils/auth.js"), {
    getUser: () => user,
    hasConsent: () => true,
    login: () => Promise.resolve(user),
  });
  // the point page keeps half-filled answers (pointDraft, keepPointDraft).
  put(path.join(root, "utils/learning-space.js"), { remember() {}, pointDraft: () => null, keepPointDraft() {} });
  put(path.join(root, "utils/theme.js"), { themed: (value) => value });
  put(path.join(root, "utils/format.js"), { errorText: (e) => e.message || "失败" });
  put(path.join(root, "utils/stream.js"), { clientId: () => "client-1" });
  put(path.join(root, "utils/chat-entry.js"), {
    openAsk: (o) => nav.push(["ask", o.threadId]),
    openChat: (o) => nav.push(["chat", o.threadId]),
  });
  put(path.join(root, "utils/learn.js"), {
    TIER_CLS: { 重点: "key" },
    STATE_TEXT: { none: "还没做", self: "我会了", correct: "做对过", due: "该回头看看了" },
    RANK_LINES: {},
    stampOf: () => "start",
    retryText: (e) => e.message,
    moment: () => ({ levelUp: null, rankUp: null, book: null }),
    tierCells: () => [],
    tierCount: () => "",
    sheetCount: () => "",
    verdictText: (r) => (r.verdict === "correct" ? "做对了" : "不对"),
    backTo: (route, id) => nav.push([route, id]),
    ROUTES: { knowledge: "pages/knowledge/index", bank: "pages/bank/index", learn: "pages/learn/index" },
  });
  delete require.cache[file];
  require(file);
  definition.data = structuredClone(definition.data);
  definition.setData = (patch) => {
    for (const [key, value] of Object.entries(patch))
      key.includes(".") ? setPath(definition.data, key, value) : (definition.data[key] = value);
  };
  definition.alive = true;
  definition.id = "limit-equivalent";
  return {
    page: definition,
    nav,
    toasts,
    signIn(value) {
      user = value;
    },
  };
}

// GET routes: the point, and …/practice by its query.
function getter(practice, gets = []) {
  return (url) => {
    gets.push(url);
    if (url.includes("/practice")) {
      const r = practice(url);
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }
    return Promise.resolve(point());
  };
}

test("choice: options submit as an array, a wrong answer settles with the solution, 下一题 reads ?after=", async () => {
  const gets = [];
  const posts = [];
  const { page } = load({
    get: getter((url) => {
      const after = /after=(\d+)/.exec(url);
      return CHOICE(after ? Number(after[1]) + 1 : 0);
    }, gets),
    post(url, body) {
      posts.push([url, body]);
      if (url.endsWith("/submit")) return Promise.resolve(judged("incorrect"));
      return Promise.resolve({ state: "seen" });
    },
  });
  await page.load();
  const pr = page.data.point.problem;
  assert.equal(pr.format, "choice");
  assert.equal(pr.kindText, "选择题");
  assert.equal(pr.total, 3);
  assert.equal(page.data.aiPractice, true);
  assert.deepEqual(page.data.answers, [""]);
  assert.match(gets.find((u) => u.includes("/practice")), /\/practice\?tone=light$/);

  page.chooseOption({ currentTarget: { dataset: { question: 0, id: "Z" } } });
  assert.equal(page.data.canSubmit, false, "an unknown option is ignored");
  page.chooseOption({ currentTarget: { dataset: { question: 0, id: "A" } } });
  assert.equal(page.data.canSubmit, true);
  await page.submit();
  const sent = posts.find(([u]) => u.endsWith("/submit"));
  assert.match(sent[0], /\/points\/limit-equivalent\/submit$/);
  assert.deepEqual(sent[1], { answer: ["A"], index: 0, tone: "light" });
  assert.equal(page.data.done, true, "a wrong answer settles: the solution is shown");
  assert.equal(page.data.bankDone, false);
  assert.deepEqual(page.data.result.solution.options, ["B"]);
  assert.ok(page.data.result.solution.explanation);
  // Settled: no more choosing.
  page.chooseOption({ currentTarget: { dataset: { question: 0, id: "C" } } });
  assert.deepEqual(page.data.answers, ["A"]);

  await page.nextProblem();
  assert.match(gets.at(-1), /\/practice\?tone=light&after=0$/);
  assert.equal(page.data.point.problem.index, 1);
  assert.equal(page.data.done, false);
  assert.equal(page.data.result, null);
  assert.deepEqual(page.data.answers, [""]);
});

test("unsure keeps the problem open to answer again", async () => {
  const { page } = load({
    get: getter(() => CHOICE(0)),
    post: (url) =>
      Promise.resolve(url.endsWith("/submit") ? judged("unsure") : { state: "seen" }),
  });
  await page.load();
  page.chooseOption({ currentTarget: { dataset: { question: 0, id: "A" } } });
  await page.submit();
  assert.equal(page.data.done, false);
  assert.equal(page.data.result.solution, null);
});

test("blanks: the pad fills ASCII values, several blanks submit as an array; round the bank is done", async () => {
  const posts = [];
  const { page, nav } = load({
    get: getter((url) => {
      const after = /after=(\d+)/.exec(url);
      return MULTI(after ? (Number(after[1]) + 1) % 2 : 0);
    }),
    post(url, body) {
      posts.push([url, body]);
      return Promise.resolve(url.endsWith("/submit") ? judged("correct") : { state: "seen" });
    },
  });
  await page.load();
  assert.equal(page.data.point.problem.kindText, "多空题");
  assert.deepEqual(page.data.answers, ["", ""]);
  page.onPad({ detail: { values: ["-3/4", "0."], active: 1 } });
  assert.equal(page.data.numActive, 1);
  assert.equal(page.data.canSubmit, false, "0. is not ready");
  page.onPad({ detail: { values: ["-3/4"], active: 0 } });
  assert.deepEqual(page.data.answers, ["-3/4", "0."], "a wrong length is ignored");
  page.onPad({ detail: { values: ["-3/4", "0.5"], active: 1 } });
  assert.equal(page.data.canSubmit, true);
  await page.submit();
  assert.deepEqual(posts.find(([u]) => u.endsWith("/submit"))[1].answer, ["-3/4", "0.5"]);
  assert.equal(page.data.bankDone, false, "one of two");

  await page.nextProblem();
  assert.equal(page.data.point.problem.index, 1);
  page.onPad({ detail: { values: ["1", "2"], active: 1 } });
  await page.submit();
  assert.equal(page.data.bankDone, true, "back at the first one");
  assert.equal(page.data.aiPractice, false);
  page.openDetail();
  page.goBank();
  assert.deepEqual(nav, [
    ["pages/knowledge/index", "limit-equivalent"],
    ["pages/bank/index", undefined],
  ]);
});

test("one blank submits one string; 409 RETEST_CHANGED reads the problem again", async () => {
  const gets = [];
  let practice = () => ({ ...MULTI(2, 4), problem: { ...MULTI(2, 4).problem, blanks: [{ label: "", note: "" }] } });
  const { page, toasts } = load({
    get: getter((url) => practice(url), gets),
    post(url, body) {
      if (!url.endsWith("/submit")) return Promise.resolve({ state: "seen" });
      assert.equal(body.answer, "7");
      const error = new Error("changed");
      error.statusCode = 409;
      error.code = "RETEST_CHANGED";
      practice = () => ({ ...MULTI(1, 4), problem: { ...MULTI(1, 4).problem, blanks: [{ label: "", note: "" }] } });
      return Promise.reject(error);
    },
  });
  await page.load();
  assert.equal(page.data.point.problem.kindText, "填空题");
  page.onPad({ detail: { values: ["7"], active: 0 } });
  await page.submit();
  assert.deepEqual(toasts, ["题换了一道"]);
  assert.match(gets.at(-1), /\/practice\?tone=light$/, "the server's pick");
  assert.equal(page.data.point.problem.index, 1);
  assert.deepEqual(page.data.answers, [""]);
  assert.equal(page.data.busy, false);
  assert.equal(page.data.fail, "");
});

test("a point with no problems yet: no problem, no error", async () => {
  const { page } = load({
    get: getter(() => Object.assign(new Error("none"), { statusCode: 409, code: "NO_PROBLEM" })),
    post: () => Promise.resolve({ state: "seen" }),
  });
  await page.load();
  assert.equal(page.data.point.problem, null);
  assert.equal(page.data.error, "");
});

test("让 AI 再出一道: a choice problem from the AI, judged by its message", async () => {
  const posts = [];
  const message = (revealed) => ({
    id: "m1",
    threadId: "t1",
    similar: {
      question: [{ type: "text", text: "AI 题" }],
      options: ["A", "B", "C", "D"].map((id) => ({ id, blocks: [{ type: "text", text: id }] })),
      revealed,
      ...(revealed ? { correct: "C", steps: [{ type: "text", text: "步骤" }], answer: [] } : {}),
    },
  });
  const { page, nav } = load({
    get: (url) =>
      url.startsWith("/v1/chat/messages/m1")
        ? Promise.resolve(message(true))
        : getter(() => CHOICE(0, 1))(url),
    post(url, body, options) {
      posts.push([url, body, options]);
      if (url === "/v1/chat/practice")
        return Promise.resolve({ thread: { id: "t1" }, message: message(false) });
      if (url === "/v1/chat/messages/m1/answer")
        return Promise.resolve({ judge: { attempt: { result: { verdict: "incorrect" } } } });
      return Promise.resolve(url.endsWith("/submit") ? judged("correct") : { state: "seen" });
    },
  });
  await page.load();
  page.chooseOption({ currentTarget: { dataset: { question: 0, id: "B" } } });
  await page.submit();
  assert.equal(page.data.bankDone, true, "a bank of one");
  await page.aiStart();
  const start = posts.find(([u]) => u === "/v1/chat/practice");
  assert.deepEqual(start[1], { pointId: "limit-equivalent", clientId: start[1].clientId, tone: "light" });
  assert.ok(start[1].clientId, "V4.2 FX2: one request per problem wanted");
  assert.ok(start[2].timeout >= 60000, "the AI takes a while");
  assert.equal(page.data.ai.choice, true);
  assert.equal(page.data.ai.revealed, false);
  page.aiSubmit();
  assert.equal(posts.filter(([u]) => u.endsWith("/answer")).length, 0, "nothing picked");
  page.aiChoose({ currentTarget: { dataset: { index: 9 } } });
  assert.equal(page.data.aiPick, -1);
  page.aiChoose({ currentTarget: { dataset: { index: 1 } } });
  await page.aiSubmit();
  const answer = posts.find(([u]) => u.endsWith("/answer"));
  assert.deepEqual(answer[1], { choice: 1, clientId: "client-1", tone: "light" });
  assert.equal(page.data.aiResult.tone, "bad");
  assert.equal(page.data.ai.correct, "C");
  assert.equal(page.data.ai.revealed, true);
  page.aiChoose({ currentTarget: { dataset: { index: 2 } } });
  assert.equal(page.data.aiPick, 1, "answered: no change");
  page.aiOpenChat();
  assert.deepEqual(nav.at(-1), ["ask", "t1"]);
});

test("point template: 看讲解, solution, bank-done choices, AI block", () => {
  const wxml = fs.readFileSync(path.join(root, "pages/point/index.wxml"), "utf8");
  assert.match(wxml, /catchtap="openDetail"[^>]*>看讲解/);
  assert.match(wxml, /bindtap="nextProblem"[^>]*>下一题/);
  assert.match(wxml, /wx:if="{{aiPractice}}"[^>]*bindtap="aiStart"/s);
  assert.match(wxml, /bindtap="openDetail"[^>]*>回详情/);
  assert.match(wxml, /bindtap="goBank"[^>]*>换个知识点/);
  assert.match(wxml, /class="solution/);
  assert.doesNotMatch(wxml, /<input/, "no system keyboard for numbers");
});

test("AI steps that fail to load leave a line to read them again", async () => {
  let failGet = true;
  const message = (revealed) => ({
    id: "m1",
    similar: {
      question: [],
      options: ["A", "B"].map((id) => ({ id, blocks: [] })),
      revealed,
      ...(revealed ? { correct: "A", steps: [{ type: "text", text: "步骤" }] } : {}),
    },
  });
  const { page } = load({
    get: (url) =>
      url.startsWith("/v1/chat/messages/m1")
        ? failGet
          ? Promise.reject(new Error("net"))
          : Promise.resolve(message(true))
        : getter(() => CHOICE(0, 1))(url),
    post: (url) =>
      Promise.resolve(
        url === "/v1/chat/practice"
          ? { thread: { id: "t1" }, message: message(false) }
          : url.endsWith("/answer")
            ? { judge: { attempt: { result: { verdict: "correct" } } } }
            : { state: "seen" },
      ),
  });
  await page.load();
  await page.aiStart();
  page.aiChoose({ currentTarget: { dataset: { index: 0 } } });
  await page.aiSubmit();
  assert.equal(page.data.aiResult.tone, "good");
  assert.equal(page.data.aiRetry, true);
  assert.equal(page.data.aiError, "步骤没加载出来，点这里再试");
  assert.equal(page.data.aiSending, false);
  failGet = false;
  await page.aiReload();
  assert.equal(page.data.ai.revealed, true);
  assert.equal(page.data.ai.correct, "A");
  assert.equal(page.data.aiError, "");
  assert.equal(page.data.aiRetry, false);
  await page.aiReload();
  assert.equal(page.data.aiSending, false, "nothing to read again");
});

test("another account: the AI flags reset and an old AI reply changes nothing", async () => {
  let release;
  const { page, signIn } = load({
    get: getter(() => CHOICE(0, 1)),
    post: (url) =>
      url === "/v1/chat/practice"
        ? new Promise((resolve) => {
            release = () => resolve({ thread: { id: "t1" }, message: { id: "m1", similar: { options: [] } } });
          })
        : Promise.resolve({ state: "seen" }),
  });
  await page.load();
  const pending = page.aiStart();
  assert.equal(page.data.aiBusy, true);
  signIn({ id: "user-b" });
  await page.load();
  assert.equal(page.data.aiBusy, false, "the new account can ask");
  release();
  await pending;
  assert.equal(page.data.ai, null);
  assert.equal(page.data.aiBusy, false);
});

test("a blank answered -0 is sent as 0", async () => {
  const posts = [];
  const one = () => ({ ...MULTI(0, 2), problem: { ...MULTI(0, 2).problem, blanks: [{ label: "", note: "" }] } });
  const { page } = load({
    get: getter(one),
    post(url, body) {
      posts.push([url, body]);
      return Promise.resolve(url.endsWith("/submit") ? judged("correct") : { state: "seen" });
    },
  });
  await page.load();
  page.onPad({ detail: { values: ["-0"], active: 0 } });
  assert.equal(page.data.canSubmit, true);
  await page.submit();
  assert.equal(posts.find(([u]) => u.endsWith("/submit"))[1].answer, "0");
});

test("练一题 from the detail page: a finished problem moves on; back from elsewhere keeps it", async () => {
  const gets = [];
  const app = { globalData: {} };
  put(path.join(root, "utils/gate.js"), { check: () => true, state: () => "ok", ask() {} });
  const { page } = load({
    get: getter((url) => {
      const after = /after=(\d+)/.exec(url);
      const index = /index=(\d+)/.exec(url);
      return CHOICE(after ? (Number(after[1]) + 1) % 3 : index ? Number(index[1]) : 0);
    }, gets),
    post: (url) => Promise.resolve(url.endsWith("/submit") ? judged("incorrect") : { state: "seen" }),
  });
  global.getApp = () => app;
  page.onShow();
  await page.load();
  page.chooseOption({ currentTarget: { dataset: { question: 0, id: "A" } } });
  await page.submit();
  assert.equal(page.data.done, true);
  // Back from a card: the same problem, the result kept.
  page.onShow();
  await settle(page);
  assert.match(gets.at(-1), /index=0$/);
  assert.equal(page.data.done, true);
  // knowledge practise() marks this point; the finished problem moves on.
  app.globalData.practiseFresh = "limit-equivalent";
  page.onShow();
  await settle(page);
  assert.match(gets.at(-1), /after=0$/);
  assert.equal(page.data.point.problem.index, 1);
  assert.equal(page.data.done, false);
  assert.equal(page.data.result, null);
  assert.equal(app.globalData.practiseFresh, "", "read once");
  delete require.cache[path.join(root, "utils/gate.js")];
});

async function settle(page) {
  for (let i = 0; i < 5 && page.loadRequest; i++) await page.loadRequest;
  await new Promise((resolve) => setImmediate(resolve));
}

// V4.2 G6 (report B 练一题, 高): the result of a long choice problem sat below
// every option while the bar already said 下一题; it is now scrolled to, and
// each question says in words whether it was right.
test("choice: after 提交 the page scrolls to the result; each question has words, not only colour", async () => {
  const scrolls = [];
  const { page } = load(
    {
      get: getter(() => CHOICE(0)),
      post: (url) =>
        Promise.resolve(url.endsWith("/submit") ? judged("incorrect") : { state: "seen" }),
    },
    { pageScrollTo: (o) => scrolls.push(o) },
  );
  await page.load();
  scrolls.length = 0;
  page.chooseOption({ currentTarget: { dataset: { question: 0, id: "A" } } });
  await page.submit();
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0].selector, ".result");
  const wxml = fs.readFileSync(path.join(root, "pages/point/index.wxml"), "utf8");
  assert.match(wxml, /class="choice-verdict/);
  assert.match(wxml, /这一问选对了/);
  assert.match(wxml, /这一问应选 /);
});
