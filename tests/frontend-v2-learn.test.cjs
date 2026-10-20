"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const pageFile = path.join(root, "pages/learn/index.js");

function mapFixture() {
  const point = (id, extra = {}) => ({
    id,
    name: id,
    line: "main",
    key: false,
    hard: false,
    stateReason: { kind: "correct", at: "2026-10-04T00:00:00.000Z" },
    ...extra,
  });
  return {
    title: "高数上",
    summary: {
      level: 5,
      levelXp: 6,
      levelNeed: 36,
      correct: 5,
      total: 89,
      maxed: false,
      next: { text: "继续极限", chapterId: "limit" },
      book: { rank: "起步", reached: 0, of: 2 },
      week: { correct: 2, xp: 30 },
      todayDone: false,
      todayList: [
        {
          id: "a",
          name: "等价无穷小替换",
          kind: "retest",
          chapter: "极限",
          tier: "重点",
          state: "self",
          xp: 0,
          done: false,
          retest: { cause: "explanation" },
        },
        {
          id: "b",
          name: "夹逼准则",
          kind: "review",
          chapter: "极限",
          tier: "难点",
          state: "due",
          xp: 0,
          done: false,
        },
        {
          id: "c",
          name: "左右极限",
          kind: "review",
          chapter: "极限",
          tier: "基础",
          state: "due",
          xp: 0,
          done: false,
        },
        {
          id: "d",
          name: "第四项",
          kind: "review",
          chapter: "极限",
          tier: "基础",
          state: "due",
          xp: 0,
          done: false,
        },
        {
          id: "fresh",
          name: "新点",
          kind: "new",
          chapter: "极限",
          tier: "基础",
          state: "none",
          xp: 10,
          done: false,
        },
      ],
    },
    chapters: [
      {
        id: "limit",
        book: "第 1 章",
        short: "极限",
        hidden: false,
        started: true,
        rank: "起步",
        main: { correct: 5, self: 4, total: 14 },
        next: { id: "fresh", name: "新点" },
        points: [
          point("a", { key: true }),
          point("b", { hard: true }),
          point("c"),
          point("d"),
          point("fresh"),
          point("last"),
        ],
      },
      {
        id: "derivative",
        book: "第 2 章",
        short: "导数",
        hidden: false,
        started: false,
        rank: "起步",
        main: { correct: 0, self: 0, total: 1 },
        next: null,
        points: [point("e")],
      },
    ],
  };
}

function put(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}
function loadPage(options = {}) {
  let definition;
  let user = { id: "u1" };
  const app = { globalData: {} };
  const navigation = [];
  const toasts = [];
  let sheet;
  const api = options.api || {
    get: () => Promise.resolve(mapFixture()),
    post: () => Promise.resolve({ thread: { id: "thread-1" } }),
    needsConsent: () => false,
  };
  global.Page = (value) => {
    definition = value;
  };
  global.getApp = () => app;
  global.wx = {
    navigateTo: (value) => navigation.push(["navigate", value.url]),
    switchTab: (value) => navigation.push(["tab", value.url]),
    showToast: (value) => toasts.push(value.title),
    stopPullDownRefresh() {},
    showActionSheet(value) {
      sheet = value;
    },
  };
  put(path.join(root, "utils/api.js"), api);
  put(path.join(root, "utils/auth.js"), {
    login: () => Promise.resolve(user),
    getUser: () => user,
    hasConsent: () => true,
    recordConsent() {},
  });
  put(path.join(root, "utils/learning-space.js"), {
    continuation: () => ({
      id: "last",
      name: "单调有界准则",
      label: "继续上次",
      detail: "极限",
    }),
    stickers: (map) =>
      (map.chapters || []).map((c) => ({ id: c.id, name: c.short, rank: c.rank, earned: false, hidden: Boolean(c.hidden) })),
  });
  put(path.join(root, "utils/theme.js"), { themed: (value) => value });
  // v4: who may use what, and the 3D icons from the server.
  put(path.join(root, "utils/gate.js"), {
    state: () => options.gate || "ok",
    check: () => (options.gate || "ok") !== "none",
    ask: () => navigation.push(["ask"]),
  });
  put(path.join(root, "utils/assets.js"), { asset: (name) => `https://x/v1/assets/${name}` });
  put(path.join(root, "utils/learn.js"), {
    ROUTES: {
      point: "pages/point/index",
      knowledge: "pages/knowledge/index",
      map: "pages/map/index",
      chapter: "pages/chapter/index",
      ranks: "pages/ranks/index",
      bank: "pages/bank/index",
      draft: "pages/draft/index",
    },
    stampOf: () => "start",
    weekLine: () => "本周做对 2 个",
    pointCount: (chapters) =>
      chapters.reduce((count, chapter) => count + chapter.points.length, 0),
    retryText: (error) => error.message || "失败",
    xpLine: (summary) => `经验 ${summary.levelXp}/${summary.levelNeed}`,
    backTo: (route, id) => navigation.push(["backTo", route, id]),
    navPlan: (pages, route) => ({ kind: "navigateTo", url: `/${route}` }),
  });
  delete require.cache[path.join(root, "utils/chat-entry.js")];
  delete require.cache[pageFile];
  require(pageFile);
  definition.data = structuredClone(definition.data);
  definition.setData = (patch) => Object.assign(definition.data, patch);
  definition.alive = true;
  return {
    page: definition,
    api,
    app,
    navigation,
    toasts,
    getSheet: () => sheet,
    setUser: (value) => {
      user = value;
    },
  };
}

test("learning home leads with the next point, then at most three look-backs in plain words", async () => {
  const { page } = loadPage();
  await page.load();
  assert.deepEqual(page.data.card.map, {
    chapterId: "limit",
    chapter: "第 1 章 极限",
    correct: 5,
    total: 14,
    progress: 36,
    nextId: "fresh",
  });
  // a point never opened starts with its explanation (learn).
  assert.deepEqual(page.data.card.hero, {
    id: "fresh",
    name: "新点",
    learn: true,
    label: "接着学",
    resume: { id: "last", name: "单调有界准则" },
  });
  // Unfinished retests and reviews; the wxml shows three and folds the rest.
  assert.deepEqual(
    page.data.card.todayDue.map((item) => item.id),
    ["a", "b", "c", "d"],
  );
  assert.equal(page.data.card.todayDue[0].meta, "前几天看过解析，换道题再试试");
  assert.equal(page.data.card.todayDue[1].meta, "10/4 做对的，再看一眼");
  assert.ok(page.data.card.todayDue.every((item) => !/经验|复测|复习/.test(item.meta)));
  assert.equal(page.data.card.resume.name, "单调有界准则");
  assert.equal(page.data.todayOpen, false);
  page.toggleToday();
  assert.equal(page.data.todayOpen, true);
});

test("the last opened point joins the hero when it is the next point", async () => {
  const data = mapFixture();
  data.chapters[0].next = { id: "last", name: "单调有界准则" };
  const { page } = loadPage({
    api: {
      get: () => Promise.resolve(data),
      post: () => Promise.resolve({}),
      needsConsent: () => false,
    },
  });
  await page.load();
  assert.equal(page.data.card.hero.label, "继续上次");
  assert.equal(page.data.card.hero.resume, null);
});

test("an active resume card hides the local continue row", async () => {
  const data = mapFixture();
  data.resumeActive = true;
  const { page } = loadPage({
    api: {
      get: () => Promise.resolve(data),
      post: () => Promise.resolve({}),
      needsConsent: () => false,
    },
  });
  await page.load();
  assert.equal(page.data.card.resume, null);
  assert.equal(page.data.card.hero.resume, null);
  assert.equal(page.data.card.hero.label, "接着学");
});

test("start, map, continue and practice keep their destinations; practice with no chapter says why", async () => {
  const api = {
    get: () => Promise.resolve(mapFixture()),
    post: () => Promise.resolve({}),
    needsConsent: () => false,
  };
  const { page, navigation } = loadPage({ api });
  await page.load();
  page.startNext();
  // "fresh" was never opened, so it starts with the explanation.
  assert.deepEqual(navigation.at(-1), ["backTo", "pages/knowledge/index", "fresh"]);
  page.continueLearning();
  assert.deepEqual(navigation.at(-1), ["backTo", "pages/point/index", "last"]);
  page.openMap();
  assert.deepEqual(navigation.at(-1), ["backTo", "pages/map/index", undefined]);
  page.openRanks();
  assert.deepEqual(navigation.at(-1), ["backTo", "pages/ranks/index", undefined]);
  // 练一题 opens the 题库.
  page.openPractice();
  assert.deepEqual(navigation.at(-1), ["backTo", "pages/bank/index", undefined]);
  // 批改 has a page of its own (V4.1 G5; one 批改 since V4.2 G7).
  page.askGrade();
  assert.deepEqual(navigation.at(-1), ["backTo", "pages/grade/index", undefined]);
});

test("v4 learning template: page head, the solving tools, every old entry kept", () => {
  const wxml = fs.readFileSync(
    path.join(root, "pages/learn/index.wxml"),
    "utf8",
  );
  assert.match(wxml, /<page-head title="学习" tint="yellow">/);
  assert.match(wxml, /<guest-bar \/>/);
  // the tools are tiles (30-learn, 40-ask), not an icon row (纪要第 3 节).
  // 批改草稿 and 整页作业 are one 批改 tile.
  assert.equal((wxml.match(/class="ftile[ "]/g) || []).length, 5);
  assert.doesNotMatch(wxml, /icon-item/);
  // Every 3D icon hides itself when it does not load.
  assert.equal((wxml.match(/class="ic3d"/g) || []).length, 5);
  assert.equal((wxml.match(/binderror="iconBroken"/g) || []).length, 5);
  // 回头看看 is named 资料复习 (it holds only material reviews).
  for (const label of ["拍一道题", "错题本", "练一题", "我的资料", "批改", "学一份资料", "放一道题", "资料复习"])
    assert.match(wxml, new RegExp(label));
  // The hero's 开始 is the only primary button.
  assert.deepEqual(wxml.match(/class="btn[ "]/g), ['class="btn ', 'class="btn ']);
  assert.match(wxml, /bindtap="startNext"/);
  assert.match(wxml, /我的进度/);
  // learn.png has no AI line on the learn home.
  assert.doesNotMatch(wxml, /AI 生成可能有误/);
  assert.match(wxml, /继续上次/);
  // 段位贴纸 and 学习记录 (Lv, 经验) moved here from 我的.
  assert.doesNotMatch(wxml, /主线|点亮|通关/);
  assert.doesNotMatch(wxml, /讲给 AI 听|大模型|隐私说明/);
  const json = JSON.parse(fs.readFileSync(path.join(root, "pages/learn/index.json"), "utf8"));
  assert.equal(json.navigationStyle, "custom");
});
