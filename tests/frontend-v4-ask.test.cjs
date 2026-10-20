"use strict";
// 解题页面回归：核对页面入口、对话与题目交互，保持工具分工和用户内容来源。
const { beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const file = (name) => path.join(root, name);
const read = (name) => fs.readFileSync(file(name), "utf8");

let h;
function stub(modulePath, exports) {
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
}
function assign(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    const parts = key.match(/[^.[\]]+/g);
    let at = target;
    for (const part of parts.slice(0, -1)) at = at[part];
    at[parts[parts.length - 1]] = value;
  }
}
function askPage() {
  let definition;
  global.Page = (value) => {
    definition = value;
  };
  delete require.cache[file("pages/ask/index.js")];
  require(file("pages/ask/index.js"));
  definition.data = structuredClone(definition.data);
  definition.setData = function (patch, done) {
    assign(this.data, patch);
    if (done) done();
  };
  return definition;
}
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  Object.keys(require.cache)
    .filter((key) => key.startsWith(root + path.sep))
    .forEach((key) => delete require.cache[key]);
  h = { state: "ok", calls: [], asks: 0, sheets: [], clips: [], copied: [], routes: {}, app: { globalData: {} } };
  const call = (method) => (url, body) => {
    h.calls.push({ method, url, body });
    const route = h.routes[`${method} ${url.split("?")[0]}`];
    return route ? Promise.resolve(route(body)) : Promise.reject(new Error("没找到"));
  };
  stub(file("utils/api.js"), {
    get: call("GET"),
    post: call("POST"),
    patch: call("PATCH"),
    put: call("PUT"),
    del: call("DELETE"),
    needsConsent: () => false,
  });
  stub(file("utils/auth.js"), {
    hasConsent: () => h.state === "ok",
    getUser: () => ({ id: "one" }),
    consentGeneration: () => 1,
    login: () => Promise.resolve(),
  });
  stub(file("utils/gate.js"), {
    state: () => h.state,
    check: () => h.state !== "none",
    ask: () => h.asks++,
  });
  stub(file("utils/copy.js"), { copyAi: (text) => (h.copied.push(text), Promise.resolve()) });
  stub(file("utils/learning-space.js"), {
    rememberThread() {},
    lastThread: () => "",
    forgetThread() {},
  });
  global.getApp = () => h.app;
  global.wx = {
    navigateTo() {},
    redirectTo: (o) => h.calls.push({ method: "redirectTo", url: o.url }),
    switchTab() {},
    reLaunch() {},
    showToast() {},
    showActionSheet: (options) => h.sheets.push(options),
    showModal() {},
    pageScrollTo() {},
    chooseMedia: () => h.calls.push({ method: "chooseMedia" }),
    setClipboardData: (o) => h.clips.push(o.data),
    getStorageSync: () => null,
    setStorageSync() {},
  };
});

test("a guest sees the empty page and sends nothing; every way to ask asks to agree first", async () => {
  h.state = "guest";
  const page = askPage();
  page.onLoad();
  page.onShow();
  await settle();
  assert.equal(page.data.guest, true);
  assert.deepEqual(h.calls, []);
  page.onDraft({ detail: { value: "洛必达什么时候不能用" } });
  page.submit();
  page.useExample({ currentTarget: { dataset: { index: 0 } } });
  page.choosePhoto({ currentTarget: { dataset: { purpose: "draft" } } });
  page.photoMenu();
  page.startTeach();
  page.practiceMenu();
  page.openHistory();
  page.moreChat();
  page.openThread({ currentTarget: { dataset: { id: "t1" } } });
  page.showQuota();
  page.suggestCards();
  await settle();
  assert.equal(h.asks, 9, "showQuota and suggestCards just stay quiet");
  assert.deepEqual(h.calls, [], "a guest never reaches the server");
  assert.equal(page.data.history, false);
  page.onHide();
});

test("an account loads its recent chats; the empty page lists the newest three", async () => {
  const threads = [1, 2, 3, 4].map((n) => ({ id: `t${n}`, title: `第 ${n} 段`, updatedAt: new Date().toISOString() }));
  h.routes["GET /v1/chat/threads"] = () => ({ threads, usage: { answers: { used: 0, limit: 60 } } });
  const page = askPage();
  page.onLoad();
  page.onShow();
  await settle();
  assert.equal(page.data.guest, false);
  assert.deepEqual(page.data.recent.map((t) => t.id), ["t1", "t2", "t3"]);
  assert.equal(page.data.threads.length, 4);
  page.onHide();
});

test("讲一遍 starts a teach chat under its new name, and 练一题 picks a chapter first", async () => {
  h.routes["POST /v1/chat/threads"] = () => ({ thread: { id: "t9", mode: "teach", currentCards: [] } });
  h.routes["GET /v1/chat/threads"] = () => ({ threads: [] });
  h.routes["GET /v1/chat/threads/t9"] = () => ({ thread: { id: "t9", mode: "teach", currentCards: [] }, messages: [] });
  h.routes["GET /v1/learn/map"] = () => ({
    chapters: [
      { id: "limit", short: "极限" },
      { id: "series", short: "级数" },
      { id: "derivative", short: "导数", hidden: true },
      { id: "definite", short: "定积分" },
    ],
  });
  h.routes["POST /v1/chat/practice"] = () => ({ thread: { id: "t9", currentCards: [] } });
  const page = askPage();
  page.onLoad();
  page.onShow();
  // 讲一遍 has its own page now.
  page.startTeach();
  await settle();
  assert.deepEqual(h.calls.find((c) => c.method === "redirectTo"), { method: "redirectTo", url: "/pages/teach/index" });
  page.setData({ thread: null, messages: [] });
  page.moreChat();
  assert.deepEqual(h.sheets.at(-1).itemList, ["讲一遍", "带上一张卡"]);
  await page.practiceMenu();
  assert.deepEqual(h.sheets.at(-1).itemList, ["极限", "定积分"]);
  h.sheets.at(-1).success({ tapIndex: 1 });
  await settle();
  // with a clientId kept for a retry.
  const made = h.calls.find((c) => c.url === "/v1/chat/practice").body;
  assert.deepEqual({ chapter: made.chapter, tone: made.tone }, { chapter: "definite", tone: "light" });
  assert.match(made.clientId, /^[A-Za-z0-9_-]{8,64}$/);
  page.onHide();
});

test("copying a reply carries the AI mark; the student's own words copy as they are", () => {
  const page = askPage();
  page.onLoad();
  const blocks = (v) => [{ t: "p", c: [{ t: "text", v }] }];
  page.setData({
    thread: { id: "t1", mode: "guide", currentCards: [] },
    messages: [
      { id: "m1", role: "user", status: "done", kind: "text", blocks: blocks("我的问题") },
      { id: "m2", role: "assistant", status: "done", kind: "text", blocks: blocks("先看分母") },
    ],
  });
  page.pickBlock({ detail: { text: "先看分母" }, currentTarget: { dataset: { id: "m2" } } });
  h.sheets.at(-1).success({ tapIndex: 1 });
  h.sheets.at(-1).success({ tapIndex: 2 });
  assert.deepEqual(h.copied, ["先看分母", "先看分母"]);
  page.holdMessage({ currentTarget: { dataset: { id: "m1" } } });
  const own = h.sheets.at(-1);
  own.success({ tapIndex: own.itemList.indexOf("复制") });
  assert.deepEqual(h.clips, ["我的问题"]);
  page.holdMessage({ currentTarget: { dataset: { id: "m2" } } });
  const reply = h.sheets.at(-1);
  reply.success({ tapIndex: reply.itemList.indexOf("复制") });
  assert.deepEqual(h.copied.at(-1), "先看分母");
  assert.equal(h.clips.length, 1);
});

test("解题 is a page of its own (D112): native title, 历史 · 新对话 inside, no tool tiles", () => {
  const wxml = read("pages/ask/index.wxml");
  const js = read("pages/ask/index.js");
  const json = JSON.parse(read("pages/ask/index.json"));
  assert.equal(json.navigationBarTitleText, "解题");
  assert.equal(json.navigationStyle, undefined);
  assert.ok(!json.usingComponents["page-head"] && json.usingComponents["guest-bar"]);
  assert.doesNotMatch(wxml, /<page-head/);
  assert.match(wxml, /^<view class="page" style="padding-bottom:calc\(340rpx \+ {{kb}}px\)" capture-bind:touchstart="studyTouch">\s*<guest-bar \/>/);
  // Typing a problem keeps the clock going, as a touch does.
  assert.match(js, /onDraft\(event\) \{\s+this\.setData\(\{ draft: event\.detail\.value \}\);\s+this\.studyTouch\(\);/);
  assert.match(js, /onEditText\(event\) \{\s+this\.setData\(\{ "scan\.editText": event\.detail\.value \}\);\s+this\.studyTouch\(\);/);
  assert.match(wxml, /class="ph-acts"[\s\S]*?历史[\s\S]*?新对话/);
  assert.match(wxml, /AI 生成可能有误，注意核实/);
  // The tools are on 学习 now; the empty page keeps the input, the camera and recent solving chats.
  for (const title of ["批改草稿", "整页作业", "练一题"]) assert.doesNotMatch(wxml, new RegExp(`<text class="t">${title}</text>`), title);
  assert.doesNotMatch(wxml, /class="grid2"|class="ftile"|icons\./);
  // 拍一道题 : 拍照 / 相册 / 打字 on the start, then a confirm step.
  assert.match(wxml, /<tool-start[^>]*title="拍一道题"[^>]*bindpick="pickStart"/);
  assert.match(wxml, /试试问/);
  assert.match(wxml, /最近[\s\S]*openHistory[\s\S]*全部/);
  assert.doesNotMatch(js, /asset\(/);
  assert.doesNotMatch(wxml, /class="mask"|\{\{skin|skin \?/);
  assert.doesNotMatch(wxml + js, /讲给 AI 听|隐私说明|themed|hasConsent\(\)/);
  assert.doesNotMatch(wxml + js, /GLM|DeepSeek|GPT|Qwen|Claude|Gemini|混元|大模型/);
  // The composer is for a chat; the empty page has its own input.
  assert.match(wxml, /wx:if="\{\{thread \|\| messages\.length\}\}" class="composer[ "]/);
});
