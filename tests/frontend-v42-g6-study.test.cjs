"use strict";
// V4.2 G6 (report B 旧题目、旧练习、回头看看): the old problem, practice and
// review pages typeset formulas, show hints and the full solution as two plain
// choices, pick a submitted answer back up and keep what is being written.
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
// setData keys may be paths such as "levels[1].blocks", as in WeChat.
function setPath(data, key, value) {
  const parts = key.match(/[^.[\]]+/g);
  let target = data;
  for (let i = 0; i < parts.length - 1; i++) {
    if (target[parts[i]] === undefined) target[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    target = target[parts[i]];
  }
  target[parts[parts.length - 1]] = value;
}
const FORMULA = (tex) => [{ type: "formula", tex }];
// Renders "$…$" text into one formula block; counts the calls.
function renderer(rendered = []) {
  return (url, body) => {
    if (url !== "/v1/render") return undefined;
    rendered.push(body.text);
    return Promise.resolve({ blocks: FORMULA(body.text) });
  };
}
function studyPage(file, api, { store = new Map(), wx = {} } = {}) {
  let def;
  global.Page = (value) => {
    def = value;
  };
  global.getCurrentPages = () => [];
  global.getApp = () => ({ globalData: {} });
  global.wx = {
    getStorageSync: (k) => store.get(k),
    setStorageSync: (k, v) => store.set(k, v),
    removeStorageSync: (k) => store.delete(k),
    showToast() {},
    showModal() {},
    showActionSheet() {},
    setNavigationBarTitle() {},
    stopPullDownRefresh() {},
    navigateTo() {},
    redirectTo() {},
    pageScrollTo() {},
    ...wx,
  };
  const base = {
    needsConsent: () => false,
    jobMessage: (job) => (job && job.error && job.error.message) || "没成功",
    pending: (job) => Boolean(job) && ["queued", "running"].includes(job.status),
    waitJob: (job) => Promise.resolve({ ...job, status: "succeeded" }),
  };
  put("utils/api.js", { ...base, ...api });
  put("utils/gate.js", { check: () => true, state: () => "ok" });
  put("utils/study-clock.js", { track: (d) => d });
  put("utils/learn.js", { backTo() {}, ROUTES: {} });
  fresh("utils/tex.js");
  fresh("utils/review.js");
  require(fresh(file));
  def.data = structuredClone(def.data);
  def.setData = (patch) => {
    for (const [k, v] of Object.entries(patch)) setPath(def.data, k, v);
  };
  def.alive = true;
  return def;
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

test("tex: only text holding TeX is sent to be typeset; a bare answer is wrapped; a failure stays plain", async () => {
  const sent = [];
  put("utils/api.js", {
    post: (url, body) => {
      sent.push(body);
      return body.text.includes("bad") ? Promise.reject(new Error("x")) : Promise.resolve({ blocks: FORMULA(body.text) });
    },
  });
  const tex = require(fresh("utils/tex.js"));
  assert.equal(await tex.blocksOf("原价 60 元，打八折"), null);
  assert.equal(await tex.blocksOf("48 元", { inline: true }), null);
  assert.deepEqual(await tex.blocksOf("求 $\\lim_{x\\to0}\\frac{\\sin x}{x}$"), FORMULA("求 $\\lim_{x\\to0}\\frac{\\sin x}{x}$"));
  // A bare TeX answer is a formula: "\frac{1}{6}" -> "$\frac{1}{6}$".
  assert.deepEqual(await tex.blocksOf("\\frac{1}{6}", { inline: true }), FORMULA("$\\frac{1}{6}$"));
  assert.deepEqual(await tex.blocksOf("e^{2}", { inline: true }), FORMULA("$e^{2}$"));
  // Outside an answer, bare TeX in a sentence is not guessed at.
  assert.equal(await tex.blocksOf("用 \\frac 写分数"), null);
  assert.equal(await tex.blocksOf("$bad$"), null);
  // The same text is typeset once.
  const before = sent.length;
  await tex.blocksOf("\\frac{1}{6}", { inline: true });
  assert.equal(sent.length, before);
  assert.deepEqual(sent.map((b) => b.tone), sent.map(() => "light"));
});

test("problem page: the problem, each hint and the answer are typeset when they hold formulas", async () => {
  const rendered = [];
  const hints = {
    id: "h1",
    stale: false,
    data: {
      complete: true,
      levels: ["想一想 $\\lim_{x\\to0}\\frac{\\sin x}{x}=1$", "第 2 条提示：没有公式", "完整解析：答案是 $1$"],
      levelCount: 3,
      answer: { value: "1", source: "ai" },
    },
  };
  const page = studyPage("pages/problem/index.js", {
    get: () => Promise.resolve({ material: { id: "m1", current: { text: "求 $\\lim_{x\\to0}\\frac{\\sin x}{x}$" } }, hints, attempts: [], jobs: {}, review: null }),
    post: renderer(rendered),
  });
  page.data.id = "m1";
  await page.load();
  await flush();
  assert.deepEqual(page.data.textBlocks, FORMULA("求 $\\lim_{x\\to0}\\frac{\\sin x}{x}$"));
  assert.ok(page.data.levels[0].blocks, "a hint with a formula");
  assert.equal(page.data.levels[1].blocks, null, "plain text stays text");
  assert.equal(page.data.levels[1].text, "没有公式");
  assert.ok(page.data.levels[2].blocks);
  assert.equal(page.data.answer.blocks, null, "\"1\" is a plain answer");
  const wxml = read("pages/problem/index.wxml");
  assert.match(wxml, /<rich blocks="\{\{textBlocks\}\}" \/>/);
  assert.match(wxml, /<rich blocks="\{\{item\.blocks\}\}" \/>/);
  assert.match(wxml, /<rich blocks="\{\{answer\.blocks\}\}" \/>/);
  assert.match(read("pages/problem/index.json"), /"rich": "\/components\/rich\/index"/);
});

test("practice page: a quiz stem and its options, the answers and the solution are typeset", async () => {
  const page = studyPage("pages/practice/index.js", { post: renderer() });
  page.setData({
    mode: "quiz",
    target: {
      id: "q1",
      data: { questions: [{ type: "choice", stem: "$\\int_0^1 x\\,dx$ 等于？", options: ["\\frac{1}{2}", "1", "$2$", "0"] }] },
    },
    total: 1,
  });
  page.showQuestion(0);
  await flush();
  assert.ok(page.data.question.stemBlocks);
  assert.deepEqual(page.data.question.options.map((o) => Boolean(o.blocks)), [true, false, true, false]);
  page.setData({ mode: "variant", material: { version: 1 } });
  page.showResult({
    id: "a1",
    answer: "\\frac{1}{2}",
    version: 1,
    result: { verdict: "correct", reference: { value: "1/2", source: "rule" }, comment: "对了，$\\frac{1}{2}$。", explanation: "完整解析：$\\int_0^1 x\\,dx=\\frac{1}{2}$", revealSolution: true, citations: [] },
  });
  await flush();
  const r = page.data.result;
  assert.ok(r.mineBlocks);
  assert.equal(r.referenceBlocks, undefined, "1/2 is plain");
  assert.ok(r.commentBlocks);
  assert.ok(r.explanationBlocks);
  const wxml = read("pages/practice/index.wxml");
  for (const key of ["question.stemBlocks", "item.blocks", "textBlocks", "peek.blocks", "result.mineBlocks", "result.referenceBlocks", "result.commentBlocks", "result.explanationBlocks"])
    assert.ok(wxml.includes(`<rich blocks="{{${key}}}" />`), key);
});

test("review page: the problem, the answer and the steps are typeset", async () => {
  const page = studyPage("pages/review/index.js", {
    get: () =>
      Promise.resolve({
        due: [{ id: "r1", materialId: "m1", kind: "problem", title: "极限", question: "求 $\\lim_{x\\to\\infty}(1+\\frac1x)^x$", prompt: "先做一遍", points: [], answer: { value: "e", source: "ai" }, steps: ["关键一步：$\\ln$ 一下", "完整解析：得 $e$"], text: "" }],
        upcoming: [],
        counts: { due: 1, total: 1 },
      }),
    post: renderer(),
  });
  await page.load();
  await flush();
  const card = page.data.card;
  assert.ok(card.questionBlocks);
  assert.ok(card.stepBlocks[0] && card.stepBlocks[1]);
  assert.equal(card.answerBlocks, undefined, "e is plain");
  const wxml = read("pages/review/index.wxml");
  for (const key of ["card.questionBlocks", "card.answerBlocks", "card.stepBlocks[index]", "card.textBlocks", "item.blocks"])
    assert.ok(wxml.includes(`<rich blocks="{{${key}}}" />`), key);
});

const HINTS = (data) => ({ id: "h1", stale: false, data: { complete: true, levels: [], levelCount: 3, answer: null, ...data } });
function problemPage(hints, posted = []) {
  const sheets = [];
  const page = studyPage(
    "pages/problem/index.js",
    {
      get: () => Promise.resolve({ material: { id: "m1", current: { text: "原价 60 元，打八折是多少元？" } }, hints, attempts: [{ id: "a1" }], jobs: {}, review: null }),
      post: (url, body) => {
        posted.push([url, body]);
        if (url === "/v1/artifacts/h1/reveal")
          return Promise.resolve(HINTS({ ...hints.data, levels: ["一", "二", "三"].slice(0, body.level), answer: body.level >= 3 ? { value: "48 元", source: "rule" } : null }));
        return Promise.resolve({});
      },
    },
    { wx: { showActionSheet: (o) => sheets.push(o.itemList), showModal: () => assert.fail("no confirmation before the solution") } },
  );
  page.data.id = "m1";
  return { page, sheets };
}

test("problem page: 给提示 and 看完整解法 side by side; the solution opens at once, no confirmation", async () => {
  const posted = [];
  const { page } = problemPage(HINTS({ variant: "numbers" }), posted);
  await page.load();
  assert.equal(page.data.nextLabel, "给我一点提示");
  page.showSolution();
  await flush();
  assert.deepEqual(posted, [["/v1/artifacts/h1/reveal", { level: 3 }]]);
  assert.equal(page.data.levels.length, 3);
  assert.equal(page.data.answer.value, "48 元");
  const wxml = read("pages/problem/index.wxml");
  assert.match(wxml, /bindtap="nextHint">\{\{nextLabel\}\}<\/button>\s*<button[^>]*bindtap="showSolution">看完整解法<\/button>/);
  assert.match(wxml, /wx:if="\{\{levels\.length < 3/);
  assert.doesNotMatch(read("pages/problem/index.js"), /直接看整道题怎么做/);
});

test("problem page: 再练一道 is offered as the problem allows; an older server keeps the old offer", async () => {
  const cases = [
    [undefined, "换几个数字，再练一道"],
    ["numbers", "换几个数字，再练一道"],
    ["similar", "再练一道同类题"],
    [null, ""],
  ];
  for (const [variant, text] of cases) {
    const { page, sheets } = problemPage(HINTS(variant === undefined ? {} : { variant }));
    await page.load();
    assert.equal(page.data.variantText, text, String(variant));
    page.openMore();
    assert.equal(sheets.pop().includes(text || "换几个数字，再练一道"), Boolean(text), String(variant));
  }
  // Not complete: nothing to practise.
  const { page } = problemPage(HINTS({ complete: false, variant: null }));
  await page.load();
  assert.equal(page.data.variantText, "");
  assert.match(read("pages/problem/index.wxml"), /wx:if="\{\{attempts && variantText\}\}"[^>]*>\s*<text class="link" bindtap="practiceVariant">\{\{variantText\}\}<\/text>/);
});

test("waiting promises no half minute; after half a minute it says it is slow", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const file of ["pages/problem/index.wxml", "pages/practice/index.wxml"]) {
    const wxml = read(file);
    assert.doesNotMatch(wxml, /半分钟/, file);
    assert.doesNotMatch(wxml, /先别离开/, file);
    assert.match(wxml, /可以先离开，回来接着/, file);
  }
  let finish;
  const page = studyPage("pages/problem/index.js", {
    get: () => Promise.resolve({ material: { id: "m1", current: { text: "题" } }, hints: null, attempts: [], jobs: {}, review: null }),
  });
  page.follow(new Promise((r) => (finish = r)));
  assert.equal(page.data.waiting, true);
  assert.equal(page.data.slow, false);
  t.mock.timers.tick(30000);
  assert.equal(page.data.slow, true);
  finish(null);
  await flush();
  assert.equal(page.data.slow, false);
});

const MATERIAL = { id: "m1", version: 1, current: { text: "原价 60 元，打八折是多少元？" } };
const judged = (id, verdict, extra = {}) => ({
  id,
  artifactId: null,
  jobId: "j-" + id,
  item: 0,
  version: 1,
  answer: "50",
  status: "done",
  error: null,
  result: { verdict, reference: null, cause: null, comment: "再看看八折。", explanation: "", citations: [], revealSolution: false },
  ...extra,
});
function practicePage(mode, { state, post, get, store = new Map(), waitJob } = {}) {
  const api = {
    get: (url) => (get && get(url)) || Promise.resolve(state),
    post: post || (() => Promise.reject(new Error("no post"))),
  };
  if (waitJob) api.waitJob = waitJob;
  const page = studyPage("pages/practice/index.js", api, { store });
  page.onLoad({ id: "m1", mode });
  return page;
}

test("practice: an answer sent again after an error carries the same key; a changed answer gets a new one", async () => {
  const bodies = [];
  let fail = true;
  const state = { material: MATERIAL, attempts: [], jobs: {}, review: null, mapPoint: null };
  const page = practicePage("problem", {
    state,
    post: (url, body) => {
      if (url === "/v1/render") return Promise.resolve({ blocks: [] });
      bodies.push(body);
      if (fail) return Promise.reject(Object.assign(new Error("没连上"), { code: "NETWORK" }));
      return Promise.resolve({ attempt: judged("a1", "incorrect"), job: { id: "j-a1", status: "succeeded" } });
    },
  });
  await flush();
  page.onText({ detail: { value: "50" } });
  page.submit();
  await flush();
  assert.equal(page.data.judgeError, "没连上");
  assert.equal(page.data.text, "50", "the answer stays");
  fail = false;
  page.submit();
  await flush();
  assert.equal(bodies.length, 2);
  assert.match(bodies[0].clientKey, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(bodies[1].clientKey, bodies[0].clientKey, "a retry is the same attempt");
  assert.equal(page.data.result.title, "还差一点");
  // Not right: how to do it is open at once.
  assert.equal(page.data.detailOpen, true);
  page.again();
  page.onText({ detail: { value: "48" } });
  page.submit();
  await flush();
  assert.notEqual(bodies[2].clientKey, bodies[0].clientKey);
  assert.match(read("pages/practice/index.wxml"), /\{\{judgeError \? '再交一次' : '看看对不对'\}\}/);
});

test("practice: a failed judgement is done with; the next send is a new attempt", async () => {
  const bodies = [];
  const page = practicePage("problem", {
    state: { material: MATERIAL, attempts: [], jobs: {}, review: null },
    post: (url, body) => {
      bodies.push(body);
      return Promise.resolve({ attempt: { ...judged("a1", "incorrect"), result: null, status: "queued" }, job: { id: "j1", status: "queued" } });
    },
    waitJob: (job) => Promise.resolve({ ...job, status: "failed", error: { message: "没看成" } }),
  });
  await flush();
  page.onText({ detail: { value: "50" } });
  page.submit();
  await flush();
  assert.equal(page.data.judgeError, "没看成");
  page.submit();
  await flush();
  assert.notEqual(bodies[1].clientKey, bodies[0].clientKey);
});

test("practice: what is being written survives going to the hints and back", async () => {
  const store = new Map();
  const state = { material: MATERIAL, attempts: [], jobs: {}, review: null };
  const first = practicePage("problem", { state, store });
  await flush();
  first.onText({ detail: { value: "60×0.8=" } });
  first.onUnload();
  const back = practicePage("problem", { state, store });
  await flush();
  assert.equal(back.data.text, "60×0.8=");
  // Each problem and question keeps its own.
  const variant = practicePage("variant", {
    state: { ...state, variant: { id: "v1", stale: false, data: { question: "原价 80 元，打九折？" } }, jobs: {} },
    store,
  });
  await flush();
  assert.equal(variant.data.text, "");
});

test("practice: coming back picks up the answer sent, judged or still being judged", async () => {
  const store = new Map([["practice-last:m1:problem", { attemptId: "a1" }]]);
  const page = practicePage("problem", {
    state: { material: MATERIAL, attempts: [judged("a1", "incorrect")], jobs: {}, review: null },
    store,
  });
  await flush();
  assert.equal(page.data.result.title, "还差一点");
  assert.equal(page.data.result.attemptId, "a1");
  // 再试一次 starts afresh, and a later visit does not bring the old result back.
  page.again();
  assert.equal(store.has("practice-last:m1:problem"), false);
  // An answer on an older version of the problem is not shown as this one's.
  const old = practicePage("problem", {
    state: { material: { ...MATERIAL, version: 2 }, attempts: [judged("a1", "incorrect")], jobs: {}, review: null },
    store: new Map([["practice-last:m1:problem", { attemptId: "a1" }]]),
  });
  await flush();
  assert.equal(old.data.result, null);
  // Still being judged: it is waited for, not sent again.
  let waited;
  const pending = practicePage("problem", {
    state: { material: MATERIAL, attempts: [{ ...judged("a2", "incorrect"), result: null, status: "running", answer: "52" }], jobs: {}, review: null },
    get: (url) => (url === "/v1/attempts/a2" ? Promise.resolve(judged("a2", "correct", { answer: "52" })) : undefined),
    waitJob: (job) => {
      waited = job;
      return Promise.resolve({ ...job, status: "succeeded" });
    },
  });
  await flush();
  assert.deepEqual(waited, { id: "j-a2", status: "running" });
  assert.equal(pending.data.result.title, "做对了！");
});

test("practice: an answered variant stays with its result; another one only when asked", async () => {
  const posted = [];
  const variant = { id: "v1", stale: false, data: { question: "原价 80 元，打九折？" } };
  const page = practicePage("variant", {
    state: { material: MATERIAL, variant, attempts: [judged("a3", "correct", { artifactId: "v1", answer: "72" })], jobs: {}, review: null },
    post: (url, body) => {
      posted.push(url);
      return Promise.resolve({ job: null });
    },
  });
  await flush();
  assert.equal(page.data.target.id, "v1");
  assert.equal(page.data.result.title, "做对了！");
  assert.deepEqual(posted.filter((u) => u.endsWith("/variant")), [], "not replaced on its own");
  // Still being judged: not replaced either.
  let waited = false;
  const judging = practicePage("variant", {
    state: { material: MATERIAL, variant, attempts: [{ ...judged("a4", "correct", { artifactId: "v1" }), result: null, status: "queued" }], jobs: {}, review: null },
    post: (url) => {
      posted.push(url);
      return Promise.resolve({ job: null });
    },
    waitJob: () => {
      waited = true;
      return new Promise(() => {});
    },
  });
  await flush();
  assert.equal(waited, true);
  assert.equal(judging.data.judging, true);
  assert.deepEqual(posted.filter((u) => u.endsWith("/variant")), []);
  // A stale one is replaced.
  const stale = practicePage("variant", {
    state: { material: MATERIAL, variant: { ...variant, stale: true }, attempts: [], jobs: {}, review: null },
    post: (url) => {
      posted.push(url);
      return new Promise(() => {});
    },
  });
  await flush();
  assert.deepEqual(posted.filter((u) => u.endsWith("/variant")), ["/v1/materials/m1/variant"]);
  assert.ok(stale.data.waiting);
  assert.match(read("pages/practice/index.wxml"), /'再来一道同类题'/);
});

test("资料复习: a problem with nothing to check against offers its hints, not 看答案 or 记住了; the count is this visit's", async () => {
  const posted = [];
  const card = (id, extra) => ({ id, materialId: "m-" + id, kind: "problem", title: id, question: "题", prompt: "先做一遍", points: [], answer: null, steps: [], text: "", ...extra });
  const page = studyPage("pages/review/index.js", {
    get: () => Promise.resolve({ due: [card("bare"), card("solved", { answer: { value: "48 元", source: "rule" } })], upcoming: [], counts: { due: 2, total: 2 } }),
    post: (url, body) => {
      posted.push([url, body]);
      return Promise.resolve({ dueOn: "2026-10-20" });
    },
  });
  await page.load();
  assert.equal(page.data.card.checkable, false);
  page.skip();
  assert.equal(page.data.card.id, "solved");
  assert.equal(page.data.card.checkable, true);
  assert.deepEqual(posted.filter(([u]) => u.startsWith("/v1/reviews")), [], "skipping grades nothing");
  const wxml = read("pages/review/index.wxml");
  assert.match(wxml, /<block wx:if="\{\{!card\.checkable\}\}">[\s\S]*?bindtap="openCard">去看提示<\/button>[\s\S]*?<\/block>\s*<button wx:elif="\{\{!flipped\}\}"[^>]*>想好了，看答案<\/button>/);
  assert.match(wxml, /这次看了 \{\{done\}\} 个。/);
  assert.doesNotMatch(wxml, /今天看了/);
  assert.match(read("pages/review/index.json"), /"navigationBarTitleText": "资料复习"/);
  assert.match(read("pages/learn/index.wxml"), /bindtap="openReview"><text class="li-l">资料复习<\/text>/);
  // A note is always checkable: its points or its whole text.
  const note = studyPage("pages/review/index.js", {
    get: () => Promise.resolve({ due: [{ ...card("n"), kind: "note", question: "", text: "全文" }], upcoming: [], counts: { due: 1, total: 1 } }),
    post: () => Promise.resolve({}),
  });
  await note.load();
  assert.equal(note.data.card.checkable, true);
});
