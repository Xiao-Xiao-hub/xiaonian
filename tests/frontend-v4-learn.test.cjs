"use strict";
// V4 learn home, 试一题 and the secondary study pages (V4.md 约定 4): no
// consent panel of their own, gate.check() first, guests send nothing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function put(file, exports) {
  const full = path.join(root, file);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}
function load(file, state, map) {
  let definition;
  const calls = { get: 0, login: 0, ask: 0, navigation: [], sheets: [] };
  global.Page = (value) => {
    definition = value;
  };
  global.getApp = () => ({ globalData: {} });
  global.wx = {
    getStorageSync: () => undefined,
    setStorageSync() {},
    navigateTo: (value) => calls.navigation.push(value.url),
    switchTab: (value) => calls.navigation.push(value.url),
    reLaunch: (value) => calls.navigation.push(value.url),
    navigateBack: () => calls.navigation.push("back"),
    showActionSheet: (value) => calls.sheets.push(value.itemList),
    showToast() {},
    showModal() {},
    stopPullDownRefresh() {},
    setNavigationBarTitle() {},
  };
  put("utils/api.js", {
    get: () => {
      calls.get += 1;
      return Promise.resolve(map || { chapters: [], summary: {} });
    },
    post: () => Promise.resolve({}),
    needsConsent: () => false,
  });
  put("utils/auth.js", {
    login: () => {
      calls.login += 1;
      return Promise.resolve({ id: "u1" });
    },
    getUser: () => (state === "ok" ? { id: "u1" } : null),
    hasConsent: () => state === "ok",
  });
  put("utils/gate.js", {
    state: () => state,
    check: () => {
      if (state === "none") calls.navigation.push("/pages/welcome/index");
      return state !== "none";
    },
    ask: () => {
      calls.ask += 1;
    },
  });
  put("utils/learn.js", {
    ROUTES: { learn: "pages/learn/index", point: "pages/point/index", map: "pages/map/index", ranks: "pages/ranks/index", chapter: "pages/chapter/index", bank: "pages/bank/index", knowledge: "pages/knowledge/index" },
    backTo: (route, id) => calls.navigation.push(`${route}:${id}`),
    stampOf: () => "",
    weekLine: () => "",
    pointCount: () => 0,
    retryText: () => "失败",
    xpLine: () => "",
  });
  const full = path.join(root, file);
  delete require.cache[full];
  require(full);
  definition.data = structuredClone(definition.data);
  definition.setData = (patch) => Object.assign(definition.data, patch);
  return { page: definition, calls };
}

test("learn home has no consent panel of its own: page head, guest bar, gate.check", () => {
  const wxml = read("pages/learn/index.wxml");
  const js = read("pages/learn/index.js");
  assert.doesNotMatch(wxml, /agreePrivacyAuthorization|同意并开始|隐私说明/);
  assert.doesNotMatch(js, /recordConsent|agree\(|themed/);
  assert.match(wxml, /^<page-head title="学习" tint="yellow">/);
  assert.match(wxml, /<view class="page ph-body"[^>]*>\s*<guest-bar \/>/);
  assert.match(js, /onShow\(\) \{\n    this\.alive = true;\n    if \(!gate\.check\(\)\)/);
  // learn.png: no AI line here (it sits on 练一题 and the map's stuck reply).
  assert.doesNotMatch(wxml, /AI 生成可能有误|ai-line/);
  // 知识地图 is a plain link, not a search box (the map has no search).
  assert.match(wxml, /class="map-entry"[^>]*bindtap="openMap"[^>]*><text>知识地图<\/text>/);
  assert.doesNotMatch(wxml, /ico-search|找知识点/);
  // 错题本 is one of the solving tiles, with the count of open mistakes.
  assert.match(wxml, /<text class="t">错题本<\/text><text wx:if="\{\{card\.mistakes\}\}" class="s"><text class="red">\{\{card\.mistakes\}\}<\/text> 道没弄懂<\/text>/);
  assert.match(wxml, /<view class="sh"><text class="sh-t">今天<\/text><text wx:if="\{\{card\.todaySide\}\}" class="sh-s">/);
});

test("learn home counts open mistakes and today's look-backs and new points", async () => {
  const map = {
    title: "高数",
    chapters: [],
    summary: {
      todayList: [
        { id: "a", kind: "review", chapter: "1", tier: "基础" },
        { id: "b", kind: "retest", chapter: "1", tier: "基础", retest: { cause: "wrong" } },
        { id: "c", kind: "review", chapter: "1", tier: "基础", done: true },
        { id: "d", kind: "new", chapter: "1", tier: "基础" },
      ],
    },
    mistakesOpen: 12,
  };
  const { page } = load("pages/learn/index.js", "ok", map);
  await page.load();
  assert.equal(page.data.card.mistakes, 12);
  assert.equal(page.data.card.todaySide, "3 个复习 · 1 个新的");
  const { page: empty } = load("pages/learn/index.js", "ok", { title: "高数", chapters: [], summary: {} });
  await empty.load();
  assert.equal(empty.data.card.mistakes, 0);
});

test("a guest sees the learn home without loading anything; every tool asks first", async () => {
  const { page, calls } = load("pages/learn/index.js", "guest");
  page.onShow();
  await Promise.resolve();
  assert.equal(page.data.guest, true);
  assert.equal(page.data.card, null);
  assert.equal(calls.login, 0);
  assert.equal(calls.get, 0);
  for (const name of ["askPhoto", "askGrade", "openMistakes", "openLibrary", "openReview", "startNote", "startProblem", "openRanks"])
    page[name]();
  assert.equal(calls.ask, 8);
  // The map and the 题库  are open to guests.
  page.startNext();
  page.openPractice();
  assert.equal(calls.ask, 8);
  assert.deepEqual(calls.navigation, ["pages/map/index:undefined", "pages/bank/index:undefined"]);
});

test("without consent or guest mode the learn home goes to the welcome page", () => {
  const { page, calls } = load("pages/learn/index.js", "none");
  page.onShow();
  assert.deepEqual(calls.navigation, ["/pages/welcome/index"]);
  assert.equal(calls.login, 0);
});

test("练一题 shows the kp card; a guest is asked and nothing is loaded", () => {
  const wxml = read("pages/point/index.wxml");
  assert.match(wxml, /<view class="kp" hover-class="pressed" bindtap="toggleKp"/);
  assert.match(wxml, /class="kp-fx"><rich blocks="\{\{point\.kpFormula\}\}"/);
  assert.match(wxml, /class="qcard">\s*<view class="q-tags">/);
  // try.png keeps the AI line at the top of 练一题.
  assert.match(wxml, /AI 生成可能有误，注意核实/);
  assert.match(read("pages/point/index.json"), /"navigationBarTitleText": "练一题"/);
  assert.match(wxml, /wx:for="\{\{point\.keys\}\}"/);
  assert.doesNotMatch(wxml, /\{\{skin\}\}/);
  const { page, calls } = load("pages/point/index.js", "guest");
  page.onLoad({ id: "a" });
  page.onShow();
  assert.equal(calls.login, 0);
  assert.equal(calls.get, 0);
  assert.equal(calls.ask, 1);
});

test("练一题: the bottom bar keeps 卡住了 / 看提示 / 提交, the kp card keeps 先弄懂 and ⋯", () => {
  const wxml = read("pages/point/index.wxml");
  const bar = wxml.slice(wxml.indexOf('class="tbot"'));
  assert.match(bar, /bindtap="openStuck">卡住了</);
  assert.match(bar, /bindtap="showHint">看提示</);
  assert.match(bar, /bindtap="submit">\{\{busy \? '正在判…' : '提交'\}\}</);
  const more = wxml.slice(wxml.indexOf('class="kp-more"'), wxml.indexOf('class="qcard"'));
  assert.match(more, /先弄懂/);
  assert.match(more, /catchtap="openPrereq"/);
  assert.match(more, /bindtap="openMore"/);
  const { page, calls } = load("pages/point/index.js", "ok");
  assert.equal(page.data.kpOpen, false);
  page.toggleKp();
  assert.equal(page.data.kpOpen, true);
  page.toggleKp();
  assert.equal(page.data.kpOpen, false);
  page.setData({ point: { name: "x", problem: { hasHint: true, hasExplanation: true }, retestMode: false } });
  page.openStuck();
  assert.deepEqual(calls.sheets[0], ["给点提示", "看完整解析", "记下卡住的一步"]);
  for (const name of ["submit", "showHint", "openStuck", "openMore", "openNext", "goLearn", "openPrereq"])
    assert.equal(typeof page[name], "function", name);
});

test("secondary study pages check the gate first and drop the skin", () => {
  for (const name of ["chapter", "ranks", "practice", "problem", "material", "library", "review", "grade", "proofread", "capture", "point"]) {
    const js = read(`pages/${name}/index.js`);
    const wxml = read(`pages/${name}/index.wxml`);
    assert.match(js, /require\("\.\.\/\.\.\/utils\/gate"\)/, name);
    assert.match(js, /onShow\(\) \{\n(?:    this\.alive = true;\n)?    if \(!gate\.check\(\)\) return;/, name);
    assert.doesNotMatch(js, /themed/, name);
    assert.doesNotMatch(wxml, /\{\{skin\}\}|隐私说明|讲给 AI 听/, name);
    // Every catch that shows an error lets api.needsConsent handle consent first.
    for (const handler of js.match(/\.catch\(\(error\) => [^\n]*/g) || [])
      if (/setData/.test(handler)) assert.match(handler, /needsConsent/, `${name}: ${handler}`);
  }
});
