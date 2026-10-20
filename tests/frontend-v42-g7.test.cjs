"use strict";
// one 批改 (pages/grade) for a problem's steps or a page, each tool's
// own history and 继续, waits that can be left and come back to the same
// grading, inputs kept on this phone, 讲一遍 taking the unsent text along.
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
  h = { state: "ok", calls: [], asks: 0, nav: [], sent: [], routes: {}, app: { globalData: {} }, pages: [], store: {}, ids: 0, user: "one" };
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
    getUser: () => ({ id: h.user }),
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
  stub("utils/learning-space.js", { rememberThread() {}, lastThread: () => "", forgetThread() {} });
  stub("utils/stream.js", {
    clientId: () => `cid${++h.ids}xxxxxx`,
    send: (url, body, onEvent) => {
      h.sent.push({ url, body, onEvent });
      return { promise: new Promise(() => {}), abort() {} };
    },
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

// A graded draft as the server sends it (POST /v1/chat/drafts, a thread's draft message).
function draftOut(verdict, statuses, extra = {}) {
  const wrongAt = statuses.indexOf("wrong");
  return {
    thread: { id: "d1", problem: para("求 (x^2)'"), imageId: "img1", mistake: extra.mistake || null },
    message: {
      id: "m1",
      kind: "draft",
      draft: {
        verdict,
        summary: "",
        by: "json",
        problemText: "求 (x^2)'",
        steps: statuses.map((status, i) => ({ no: i + 1, status, text: `第${i + 1}行`, blocks: para(`第${i + 1}行`), note: status === "carried" ? "方法对，沿用了前面的错误结果" : "" })),
        first: wrongAt >= 0 ? { step: wrongAt + 1, why: para("错了"), fix: para("改") } : null,
      },
    },
  };
}
function typed(page) {
  page.typeIn();
  page.onProblem({ detail: { value: "求 (x^2)'" } });
  page.onLines({ detail: { lines: ["(x^2)'=2x"] } });
}

// ---- the one 批改 ------------------------------------------------------------
test("批改: one tile, one camera item, one page; the old pages redirect with their id", () => {
  const app = JSON.parse(read("app.json"));
  assert.ok(app.pages.includes("pages/grade/index"));
  // Appended after the last page before it (other rounds append after it).
  assert.equal(app.pages.indexOf("pages/grade/index"), app.pages.indexOf("pages/legal/index") + 1, "appended, nothing reordered");
  const learn = read("pages/learn/index.wxml");
  assert.match(learn, /bindtap="askGrade"[^>]*><text class="t">批改<\/text>/);
  assert.doesNotMatch(learn, /askDraft|askHomework|批改草稿|整页作业|做错的都在这/);
  // The tools show at once, not after the map and stats load.
  assert.doesNotMatch(learn, /<block wx:if="\{\{guest\|\|card\}\}">\s*<view class="tiles">/);
  for (const [page, id] of [["pages/draft/index.js", "d 1"], ["pages/homework/index.js", "hw1"]]) {
    const old = load(page);
    old.onLoad({ id });
    assert.equal(h.nav.at(-1), `redirect:/pages/grade/index?id=${encodeURIComponent(id)}`);
    old.onLoad({});
    assert.equal(h.nav.at(-1), "redirect:/pages/grade/index");
  }
  // The limit is said before shooting.
  const wxml = read("pages/grade/index.wxml");
  assert.match(wxml, /lede="[^"]*一页最多批 \{\{pageMax\}\} 道"/);
  assert.equal(load("pages/grade/index.js").data.pageMax, 6);
  // The server's two kinds of 批改 point at this page; nothing points back here.
  const tools = require(file("utils/tools.js"));
  assert.deepEqual(tools.suggestOf({ suggest: "homework" }, "problem"), { to: "grade", text: "这张像是你写的解答", go: "去批改" });
  assert.deepEqual(tools.suggestOf({ suggest: "draft" }, "problem").to, "grade");
  assert.equal(tools.suggestOf({ suggest: "draft" }, "grade"), null);
});

test("批改: a page photo is graded as a page; one problem's steps are checked first", async () => {
  h.routes["UPLOAD /v1/chat/scan"] = () => ({ type: "homework", imageId: "img4", homework: 2, problems: [], suggest: null });
  h.routes["POST /v1/chat/homework"] = () => ({ id: "hw1", title: "作业 · 2 题", homework: { imageId: "img4", items: [], counts: { correct: 0, wrong: 0, unsure: 0, unclear: 0, grading: 0, failed: 0 } } });
  const page = load("pages/grade/index.js");
  page.onLoad({});
  await page.read({ tempFilePath: "/tmp/p.jpg", size: 10 });
  await settle();
  assert.equal(h.calls[0].url, "/v1/chat/scan?tone=light&purpose=grade");
  assert.equal(page.data.stage, "page");
  assert.equal(page.data.id, "hw1");
  h.routes["UPLOAD /v1/chat/scan"] = () => ({ type: "solution", imageId: "img5", homework: 0, problems: [{ text: "求导", blocks: para("求导") }], solution: { steps: ["y'=2x"], unclear: "", blocks: para("1. y'=2x") }, suggest: null });
  const one = load("pages/grade/index.js");
  one.onLoad({});
  await one.read({ tempFilePath: "/tmp/d.jpg", size: 10 });
  assert.equal(one.data.stage, "edit");
  assert.deepEqual(one.data.lines, ["y'=2x"]);
  // a problem without formulas stays a plain box (no toggle).
  assert.equal(one.data.problemTex, false);
  one.onLines({ detail: { lines: ["y'=2"] } });
  assert.deepEqual(one.data.lines, ["y'=2"]);
  // A failed read says why, and 再认一次 reads the same photo again.
  h.routes["UPLOAD /v1/chat/scan"] = () => {
    throw Object.assign(new Error("这张没认出来，不算次数；可以重拍或直接打字"), { code: "SCAN_FAILED" });
  };
  await one.read({ tempFilePath: "/tmp/d.jpg", size: 10 });
  assert.equal(one.data.scanError, "这张没认出来，不算次数；可以重拍或直接打字");
  await one.rescan();
  assert.equal(h.calls.filter((c) => c.method === "UPLOAD").length, 4);
});

test("批改: a retry sends the same clientId; an edit makes a new submission", async () => {
  let n = 0;
  h.routes["POST /v1/chat/drafts"] = () => {
    n += 1;
    if (n === 1) throw Object.assign(new Error("请求超时"), { code: "TIMEOUT" });
    return draftOut("correct", ["ok"]);
  };
  const page = load("pages/grade/index.js");
  page.onLoad({});
  typed(page);
  await page.grade();
  assert.equal(page.data.gradeError, "请求超时");
  assert.equal(page.data.stage, "edit", "what was typed stays");
  await page.grade();
  const posts = h.calls.filter((c) => c.url === "/v1/chat/drafts");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.clientId, posts[1].body.clientId, "the server returns the first grading, not a second one");
  assert.equal(page.data.stage, "draft");
  // Correcting the reading and grading again is a new submission.
  page.fix();
  assert.equal(page.data.stage, "edit");
  assert.equal(page.data.problem, "求 (x^2)'");
  assert.deepEqual(page.data.lines, ["第1行"]);
  page.onLines({ detail: { lines: ["(x^2)'=2x"] } });
  await page.grade();
  const third = h.calls.filter((c) => c.url === "/v1/chat/drafts")[2];
  assert.notEqual(third.body.clientId, posts[0].body.clientId);
  assert.match(read("pages/grade/index.js"), /timeout: 150000/);
});

test("批改: leaving while grading comes back to the same grading; typed input survives leaving", async () => {
  let release;
  h.routes["POST /v1/chat/drafts"] = () => new Promise((resolve) => (release = resolve));
  const page = load("pages/grade/index.js");
  page.onLoad({});
  typed(page);
  page.grade();
  const kept = h.store["tool_draft:grade:one"];
  assert.equal(kept.grading, true);
  assert.equal(kept.problem, "求 (x^2)'");
  const clientId = kept.clientId;
  // 先去做别的: the page goes; the grading goes on on the server.
  page.leave();
  page.onUnload();
  release(draftOut("wrong", ["ok", "wrong"]));
  await settle();
  // Back on 批改: the same clientId asked again shows the stored grading.
  h.routes["POST /v1/chat/drafts"] = (body) => (body.clientId === clientId ? draftOut("wrong", ["ok", "wrong"], { mistake: { status: "open" } }) : null);
  const back = load("pages/grade/index.js");
  back.onLoad({});
  back.onShow();
  await settle();
  assert.equal(back.data.stage, "draft");
  assert.equal(back.data.result.verdict, "wrong");
  assert.equal(h.store["tool_draft:grade:one"], undefined, "dropped once graded");
  // Typed but not graded: kept, and offered as 继续 on the start.
  const typedOnly = load("pages/grade/index.js");
  typedOnly.onLoad({});
  typed(typedOnly);
  typedOnly.onUnload();
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  const again = load("pages/grade/index.js");
  again.onLoad({});
  again.onShow();
  assert.equal(again.data.stage, "start");
  assert.equal(again.data.resume.text, "求 (x^2)'");
  again.resumeEdit();
  assert.equal(again.data.stage, "edit");
  assert.deepEqual(again.data.lines, ["(x^2)'=2x"]);
  // Another account on this phone sees none of it.
  h.user = "two";
  const other = load("pages/grade/index.js");
  other.onLoad({});
  other.onShow();
  assert.equal(other.data.resume, null);
});

test("批改: carried steps are never a green check; only a wrong or unsure result offers the 错题本", async () => {
  const page = load("pages/grade/index.js");
  page.onLoad({});
  h.routes["POST /v1/chat/drafts"] = () => draftOut("wrong", ["ok", "wrong", "carried", "carried"], { mistake: { status: "open" } });
  typed(page);
  await page.grade();
  const r = page.data.result;
  assert.deepEqual(r.steps.map((s) => [s.mark, s.tone]), [["✓", "green"], ["✗", "red"], ["–", "grey"], ["–", "grey"]]);
  assert.equal(r.steps[2].note, "方法对，沿用了前面的错误结果");
  assert.equal(r.inBook, true, "filed by the server");
  assert.deepEqual(r.problem, para("求 (x^2)'"), "the problem is on the result");
  assert.equal(r.imageId, "img1");
  for (const [verdict, statuses] of [["correct", ["ok", "ok"]], ["unsure", ["ok", "unclear"]]]) {
    h.routes["POST /v1/chat/drafts"] = () => draftOut(verdict, statuses);
    page.again();
    typed(page);
    await page.grade();
    assert.equal(page.data.result.verdict, verdict);
  }
  const wxml = read("pages/grade/index.wxml");
  // 放进错题本 only in the wrong and unsure blocks of a draft result.
  const draft = wxml.slice(wxml.indexOf("stage === 'draft'"), wxml.indexOf("stage === 'page'"));
  const correct = draft.slice(draft.indexOf("<view class=\"tl-again\">"));
  assert.doesNotMatch(correct, /addMistake/);
  assert.match(draft, /result\.verdict === 'wrong'[\s\S]*addMistake[\s\S]*result\.verdict === 'unsure'[\s\S]*addMistake/);
  // On a page, a correct problem has no 放进错题本 either.
  assert.match(wxml, /item\.verdict !== 'correct'\}\}" class="act[^"]*"[^>]*bindtap="addItemMistake"/);
  assert.match(wxml, /去错题本 ›/);
  assert.doesNotMatch(wxml, /明天再来一遍/);
  // The page's own look: no kicker, no coloured left border.
  assert.doesNotMatch(wxml, /class="kicker"/);
  assert.doesNotMatch(read("pages/grade/index.wxss"), /border-left:\s*[2-9]/);
});

test("V4.2 G4: a problem held by the week's allowance waits until Monday", async () => {
  const item = (index, status, extra = {}) => ({ index, no: String(index + 1), status, verdict: null, cause: null, hold: null, threadId: null, inBook: false, unclear: "", text: `题${index}`, steps: ["a"], problem: para(`题${index}`), work: para("a"), ...extra });
  const zero = { correct: 0, wrong: 0, unsure: 0, unclear: 0, grading: 0, failed: 0 };
  const monday = new Date(Date.now() + 3 * 86400000).toISOString();
  h.routes["GET /v1/chat/threads/hw2"] = () => ({
    thread: { id: "hw2", title: "作业", homework: { imageId: "img5", items: [item(0, "done", { verdict: "correct", threadId: "c0" }), item(1, "unclear", { hold: "quota", holdUntil: monday, unclear: "这周的额度用完了，这道先放着，额度恢复后再批" })], counts: { ...zero, correct: 1, unclear: 1 } } },
    messages: [],
  });
  const page = load("pages/grade/index.js");
  page.onLoad({ id: "hw2" });
  page.onShow();
  await settle();
  assert.equal(page.data.items[1].badge.text, "下周一再批");
  assert.equal(page.data.summary, "1 道下周一再批");
  // Not offered again before Monday; one held without a date still is.
  assert.equal(page.data.items[1].waiting, true);
  // once its time has passed it says so and is offered.
  const passed = new Date(Date.now() - 60000).toISOString();
  h.routes["GET /v1/chat/threads/hw2"] = () => ({
    thread: { id: "hw2", title: "作业", homework: { imageId: "img5", items: [item(0, "unclear", { hold: "quota", holdUntil: passed, unclear: "今天的额度用完了，这道先放着，明天再批" })], counts: { ...zero, unclear: 1 } } },
    messages: [],
  });
  await page.load();
  await settle();
  assert.equal(page.data.items[0].waiting, false);
  assert.equal(page.data.items[0].badge.text, "可以批了");
  assert.equal(page.data.items[0].unclear, "额度恢复了，可以接着批这道");
  assert.equal(page.data.summary, "1 道可以批了");
  assert.match(read("pages/grade/index.wxml"), /item\.canConfirm && !item\.waiting\}\}" class="act main"[^>]*>\{\{item\.held \? '现在批这道'/);
});

test("批改 page: the score counts only problems with a verdict; held ones wait for tomorrow; a graded one can be corrected", async () => {
  const item = (index, status, extra = {}) => ({ index, no: String(index + 1), status, verdict: null, cause: null, hold: null, threadId: null, inBook: false, unclear: "", text: `题${index}`, steps: ["a"], problem: para(`题${index}`), work: para("a"), ...extra });
  const thread = (items, counts) => ({ id: "hw1", title: "作业", homework: { imageId: "img4", items, counts } });
  const zero = { correct: 0, wrong: 0, unsure: 0, unclear: 0, grading: 0, failed: 0 };
  h.routes["GET /v1/chat/threads/hw1"] = () => ({
    thread: thread(
      [item(0, "done", { verdict: "correct", threadId: "c0" }), item(1, "done", { verdict: "wrong", threadId: "c1", inBook: true }), item(2, "done", { verdict: "unsure", threadId: "c2" }), item(3, "unclear", { hold: "quota", unclear: "今天的次数不够了，这道先放着，明天再批" })],
      { ...zero, correct: 1, wrong: 1, unsure: 1, unclear: 1 },
    ),
    messages: [],
  });
  const page = load("pages/grade/index.js");
  page.onLoad({ id: "hw1" });
  page.onShow();
  await settle();
  assert.equal(page.data.stage, "page");
  assert.equal(page.data.score, "已核对 2 题，1 题正确");
  assert.equal(page.data.summary, "1 道有错，1 道拿不准，1 道明天再批");
  assert.equal(page.data.items[3].badge.text, "明天再批");
  assert.equal(page.data.items[3].waiting, false);
  assert.equal(page.data.job, null);
  // A graded problem read wrong: corrected and graded again (again: true).
  h.routes["POST /v1/chat/threads/hw1/homework/0"] = () => thread([item(0, "grading")], { ...zero, grading: 1 });
  page.edit(tap({ index: 0 }));
  page.onEditText({ detail: { value: "题0（改）" } });
  assert.equal(h.store["tool_draft:grade:hw1:one"].text, "题0（改）", "the correction survives leaving");
  page.submitEdit();
  await settle();
  assert.deepEqual(h.calls.at(-1).body, { text: "题0（改）", steps: ["a"], again: true, tone: "light" });
  assert.equal(h.store["tool_draft:grade:hw1:one"], undefined);
  // While grading: progress from the counts, and the page looks again.
  assert.deepEqual(page.data.job, { id: "hw1", status: "running", progress: { stage: "grade", steps: 1, step: 1 } });
  assert.equal(page.data.score, "");
  clearTimeout(page.timer);
  // Every problem with a verdict: the plain score.
  page.show(thread([item(0, "done", { verdict: "correct" }), item(1, "done", { verdict: "wrong" })], { ...zero, correct: 1, wrong: 1 }));
  assert.equal(page.data.score, "对了 1 / 2 题");
  // Six problems is the most a photo holds: the page says the rest go in another photo.
  page.show(thread([0, 1, 2, 3, 4, 5].map((i) => item(i, "done", { verdict: "correct" })), { ...zero, correct: 6 }));
  assert.equal(page.data.full, true);
  page.onUnload();
});

test("批改 history: its own list, unfinished first; a row opens on this page; long press deletes", async () => {
  h.routes["GET /v1/chat/threads"] = () => ({
    threads: [
      { id: "d1", title: "求导", homework: false, open: false, updatedAt: "2026-10-18T02:00:00Z" },
      { id: "hw1", title: "作业 · 3 题", homework: true, open: true, updatedAt: "2026-10-17T02:00:00Z" },
    ],
  });
  h.routes["DELETE /v1/chat/threads/d1"] = () => ({});
  const page = load("pages/grade/index.js");
  page.onLoad({});
  page.onShow();
  await settle();
  assert.equal(h.calls[0].url, "/v1/chat/threads?kind=solve&tool=grade&limit=20&tone=light");
  assert.deepEqual(page.data.history.map((r) => [r.id, r.open, r.kind]), [["hw1", true, "一页"], ["d1", false, "一道"]]);
  page.openPast(tap({ id: "hw1" }));
  assert.equal(h.nav.at(-1), "/pages/grade/index?id=hw1");
  page.removePast(tap({ id: "d1", kind: "一道" }));
  await settle();
  assert.ok(h.calls.some((c) => c.method === "DELETE" && c.url === "/v1/chat/threads/d1"));
  // An opened past one: 再批一份 starts fresh in its place.
  h.routes["GET /v1/chat/threads/d1"] = () => ({ thread: { id: "d1" }, messages: [draftOut("correct", ["ok"]).message] });
  const past = load("pages/grade/index.js");
  past.onLoad({ id: "d1" });
  past.onShow();
  await settle();
  assert.equal(past.data.stage, "draft");
  past.again();
  assert.equal(h.nav.at(-1), "redirect:/pages/grade/index");
});

// ---- 解题 ---------------------------------------------------------------------
test("解题: its own history with 看更早的; 批改 and 讲一遍 rows open their pages", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, title: `题${i}`, updatedAt: new Date(Date.UTC(2026, 9, 18, 0, 0, 100 - i)).toISOString() }));
  h.routes["GET /v1/chat/threads?kind=solve&tool=ask&limit=100"] = () => ({ threads: rows });
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [{ id: "old", title: "旧题", updatedAt: "2026-01-01T00:00:00Z" }] });
  stub("utils/learning-space.js", { rememberThread() {}, lastThread: () => "s5", forgetThread() { throw new Error("the pointer stays"); } });
  const page = load("pages/ask/index.js");
  page.onLoad();
  h.app.globalData.ask = { start: true };
  page.onShow();
  await settle();
  // 学习 → 拍一道题 keeps the last one, offered first as 继续上次.
  assert.equal(page.data.recent[0].id, "s5");
  assert.equal(page.data.recent[0].resume, true);
  assert.equal(page.data.more, true);
  await page.moreThreads();
  assert.match(h.calls.at(-1).url, /tool=ask&limit=100&before=2026-10-18T00%3A00%3A01/);
  assert.deepEqual(page.data.threads.map((t) => t.id).slice(-1), ["old"]);
  assert.equal(page.data.more, false);
  page.openThread(tap({ id: "hw1", homework: true }));
  assert.equal(h.nav.at(-1), "/pages/grade/index?id=hw1");
  page.openThread(tap({ id: "t1", tool: "teach" }));
  assert.equal(h.nav.at(-1), "/pages/teach/index?id=t1");
  page.setData({ thread: { id: "c1", homeworkOf: "hw1" } });
  page.openHomework();
  assert.equal(h.nav.at(-1), "/pages/grade/index?id=hw1");
  // a full row in the link colour.
  assert.match(read("pages/ask/index.wxml"), /class="more-line"[^>]*bindtap="moreThreads"[^>]*>\{\{moreBusy \? '打开中…' : '更早的记录'\}\}/);
});

test("解题: a problem being checked survives leaving; long notes are cut where it says so", async () => {
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  h.app.globalData.toolScan = { to: "problem", scan: { type: "problems", imageId: "img1", problems: [{ text: "求导", blocks: para("求导") }], suggest: null, photo: "/tmp/a.jpg" } };
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.onShow();
  page.editConfirm && page.editConfirm();
  page.onConfirmText({ detail: { value: "求 x^2 的导数" } });
  page.choose(tap({ way: "stuck" }));
  page.onStuckText({ detail: { value: "卡在第二步" } });
  page.onHide();
  page.onUnload();
  const back = load("pages/ask/index.js");
  back.onLoad();
  h.app.globalData.ask = { start: true };
  back.onShow();
  assert.equal(back.data.confirm.text, "求 x^2 的导数");
  assert.equal(back.data.stuck.text, "卡在第二步");
  assert.equal(back.lastScan.imageId, "img1", "the same photo, no new upload");
  // Once it is sent (or gone), nothing comes back.
  back.setData({ confirm: null, stuck: null });
  back.onHide();
  assert.equal(h.store["tool_draft:ask:one"], undefined);
  // Notes longer than one message: the start of them, and the page says so.
  const notes = "笔".repeat(2500);
  back.setData({ scan: { kind: "notes", notes } });
  back.useNotes();
  assert.ok(back.data.draft.length <= 2000);
  assert.match(back.data.draft, /这段讲的是什么？$/);
  assert.match(back.data.notice, /只带上了前 \d+ 字/);
  back.setData({ scan: { kind: "notes", notes: "短笔记" } });
  back.useNotes();
  assert.equal(back.data.draft, "短笔记\n\n这段讲的是什么？");
  assert.equal(back.data.notice, "");
});

test("解题: 存成卡 is offered when the problem is settled, not after a count of messages", async () => {
  // As the server sends them : blocks, and the learner's words as `plain`.
  const user = (plain) => ({ id: plain, role: "user", status: "done", blocks: [{ t: "p", c: [{ t: "text", v: plain }] }], plain });
  const reply = (id) => ({ id, role: "assistant", status: "done", blocks: [{ t: "p", c: [{ t: "text", v: "再看看这一步" }] }] });
  let said = [user("怎么做"), reply("a1"), user("为什么"), reply("a2"), user("那这里呢"), reply("a3"), user("还是不懂"), reply("a4")];
  h.routes["GET /v1/chat/threads/s1"] = () => ({ thread: { id: "s1", mode: "auto", scene: "study" }, messages: said });
  const page = load("pages/ask/index.js");
  page.onLoad();
  await page.open("s1");
  await settle();
  page.offerWrap();
  assert.equal(page.data.wrapDue, false, "still asking about the hard part");
  said = said.concat([user("懂了，谢谢"), reply("a5")]);
  page.offered = {};
  await page.open("s1");
  await settle();
  page.offerWrap();
  assert.equal(page.data.wrapDue, true);
});

test("解题: 讲完了 in a 讲一遍 opens the key-point check on 讲一遍, with the unsent text", () => {
  const page = load("pages/ask/index.js");
  page.onLoad();
  page.setData({ thread: { id: "t9", mode: "teach", title: "链式法则" }, draft: "最后补一句" });
  page.act(tap({ key: "teachDone" }));
  assert.equal(h.nav.at(-1), "/pages/teach/index?id=t9&finish=1");
  assert.equal(h.sent.length, 0, "no 讲完了 message");
  assert.equal(h.store["tool_draft:teach:one"].draft, "最后补一句");
  assert.equal(page.data.draft, "");
});

// ---- 讲一遍 -------------------------------------------------------------------
test("讲一遍: 讲完了 takes the unsent text and says what was not compared; a failed reply keeps its error", async () => {
  const review = (said) => ({
    id: "r1",
    kind: "teach_review",
    review: { points: [{ text: "外层乘内层", status: "covered", quote: "", blocks: para("外层乘内层") }, { text: "逐层", status: "partial", quote: "", blocks: para("逐层") }], wrong: [], best: "", said },
  });
  h.routes["GET /v1/chat/threads/t1"] = () => ({
    thread: { id: "t1", title: "链式法则", pointId: "p1" },
    messages: [
      { id: "u1", role: "user", kind: "text", status: "done", content: "外面导完", blocks: para("外面导完") },
      { id: "a1", role: "assistant", kind: "text", status: "failed", blocks: [], error: { code: "X", message: "这次没答完，可以再问一次" } },
    ],
  });
  h.routes["POST /v1/chat/threads/t1/teach-review"] = () => ({ fallback: false, message: review({ seen: 3, total: 5 }) });
  h.store["tool_draft:teach:one"] = { threadId: "t1", pointId: "p1", name: "链式法则", draft: "最后补一句" };
  const page = load("pages/teach/index.js");
  page.onLoad({ id: "t1", finish: "1" });
  assert.equal(page.data.draft, "最后补一句", "the text left on 解题 came along");
  page.onShow();
  await settle();
  assert.equal(page.data.messages[1].error, "这次没答完，可以再问一次");
  const post = h.calls.find((c) => c.method === "POST");
  assert.deepEqual(post.body, { text: "最后补一句", clientId: "cid1xxxxxx", tone: "light" });
  assert.equal(page.data.stage, "result");
  assert.equal(page.data.draft, "");
  assert.equal(page.data.messages.at(-1).plain, "最后补一句");
  assert.equal(page.data.review.got, 1);
  assert.equal(page.data.review.said, "讲得比较长，只对照了后面 3 段，前 2 段没算进来");
  const wxml = read("pages/teach/index.wxml");
  assert.match(wxml, /完整讲清 \{\{review\.got\}\} \/ \{\{review\.total\}\} 条要点/);
  assert.match(wxml, /fallback\.keys\.length \?/);
  assert.match(read("pages/teach/index.wxss"), /safe-area-inset-bottom/);
});

test("讲一遍: what is being explained and the unsent text survive leaving; past ones are listed", async () => {
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [{ id: "t1", title: "泰勒公式", tool: "teach", open: true, updatedAt: "2026-10-18T00:00:00Z" }, { id: "t2", title: "卡片", tool: null, open: false, updatedAt: "2026-10-17T00:00:00Z" }] });
  const page = load("pages/teach/index.js");
  page.onLoad({});
  page.onShow();
  page.onTopic({ detail: { value: "泰勒公式" } });
  page.startTopic();
  page.onDraft({ detail: { value: "余项是误差" } });
  page.onUnload();
  const back = load("pages/teach/index.js");
  back.onLoad({});
  back.onShow();
  await settle();
  assert.equal(h.calls.find((c) => c.method === "GET").url, "/v1/chat/threads?kind=solve&tool=teach&limit=20&tone=light");
  assert.deepEqual(back.data.resume, { name: "泰勒公式", draft: true, review: false });
  assert.deepEqual(back.data.history.map((r) => r.id), ["t1", "t2"]);
  back.resumeTalk();
  assert.equal(back.data.stage, "talk");
  assert.equal(back.data.draft, "余项是误差");
  back.openPast(tap({ id: "t1", tool: "teach" }));
  assert.equal(h.nav.at(-1), "/pages/teach/index?id=t1");
  back.openPast(tap({ id: "t2", tool: null }));
  assert.equal(h.nav.at(-1), "/pages/ask/index");
  assert.deepEqual(h.app.globalData.ask, { threadId: "t2" });
});

// ---- step-edit ----------------------------------------------------------------
test("step-edit: a deleted step can be put back; the delete target is larger", () => {
  let definition;
  global.Component = (value) => {
    definition = value;
  };
  delete require.cache[file("components/step-edit/index.js")];
  require(file("components/step-edit/index.js"));
  const emitted = [];
  const c = {
    ...definition.methods,
    data: { lines: ["a", "b", "c"], max: 40, ...structuredClone(definition.data) },
    setData(patch) {
      Object.assign(this.data, patch);
    },
    triggerEvent(name, detail) {
      emitted.push(detail.lines);
      this.data.lines = detail.lines;
    },
  };
  c.remove(tap({ index: 1 }));
  assert.deepEqual(emitted.at(-1), ["a", "c"]);
  assert.deepEqual(c.data.undo, { index: 1, text: "b", no: 2 });
  c.restore();
  assert.deepEqual(emitted.at(-1), ["a", "b", "c"]);
  assert.equal(c.data.undo, null);
  clearTimeout(c.undoTimer);
  assert.match(read("components/step-edit/index.wxml"), /bindtap="restore"[^>]*>撤销/);
  assert.match(read("components/step-edit/index.wxss"), /\.se-x \{[^}]*width: 72rpx; height: 72rpx/);
});

test("the merged pages keep one AI line, no banned words, no model names", () => {
  const banned = /陪伴|陪着你|GLM|DeepSeek|GPT|Qwen|Claude|Gemini|混元|大模型|境内|境外|数据出境/i;
  for (const name of ["pages/grade/index", "pages/teach/index", "pages/ask/index"]) {
    const wxml = read(`${name}.wxml`);
    assert.equal(wxml.split("AI 生成可能有误，注意核实").length - 1, 1, name);
    assert.doesNotMatch((wxml + read(`${name}.js`)).replace(/ic-[\w-]+\.webp/g, ""), banned, name);
  }
});

test("V4.2 G4: 批改 and 讲一遍 show the budget line from 80%, nothing below or from an old server", async () => {
  const resetAt = new Date(Date.now() + 3600000).toISOString();
  let usage = { answers: { used: 0, limit: 60 }, budget: { day: { pct: 85, resetAt }, week: { pct: 20, resetAt } } };
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [], usage });
  for (const name of ["pages/grade/index.js", "pages/teach/index.js"]) {
    usage.budget.day.pct = 85;
    const page = load(name);
    page.onLoad({});
    page.onShow();
    await settle();
    assert.equal(page.data.usageText, "今天已用 85%，明天 0 点恢复", name);
    page.onUnload();
    usage.budget.day.pct = 40;
    const calm = load(name);
    calm.onLoad({});
    calm.onShow();
    await settle();
    assert.equal(calm.data.usageText, "", name);
    calm.onUnload();
    assert.match(read(name.replace(/js$/, "wxml")), /wx:if="\{\{usageText\}\}" class="usage">\{\{usageText\}\}/);
  }
  usage = { answers: { used: 59, limit: 60 } };
  const old = load("pages/grade/index.js");
  old.onLoad({});
  old.onShow();
  await settle();
  assert.equal(old.data.usageText, "");
});
