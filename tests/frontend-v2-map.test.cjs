"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const pageFile = path.join(root, "pages/map/index.js");
const layout = require(path.join(root, "pages/map/layout.js"));
const stars = require(path.join(root, "pages/map/stars.js"));

function point(id, extra = {}) {
  return {
    id,
    name: id,
    short: id.slice(-7),
    section: "1.1",
    tier: "基础",
    line: "main",
    side: null,
    key: false,
    hard: false,
    level: 1,
    exam: "考点",
    prereqs: [],
    state: "none",
    ready: true,
    cards: { count: 0, items: [] },
    followers: { items: [], more: 0 },
    mistakeCount: 0,
    taught: true,
    ...extra,
  };
}
function fixture() {
  const a = point("a", { state: "correct" });
  const b = point("b", {
    prereqs: ["a"],
    key: true,
    state: "self",
    cards: {
      count: 1,
      items: [{ id: "card-1", title: "卡", type: "problem", date: "10/12" }],
    },
  });
  const c = point("c", {
    prereqs: ["b"],
    line: "side",
    side: "up",
    hard: true,
    state: "due",
    retest: { mode: true, dueOn: "2026-10-12", cause: "hint" },
  });
  return {
    title: "高数上",
    taughtTo: "1.1",
    summary: {},
    chapters: [
      {
        id: "limit",
        short: "极限",
        label: "函数与极限",
        book: "第 1 章",
        rank: "起步",
        hidden: false,
        self: 1,
        main: { correct: 1, self: 1, total: 2 },
        side: { correct: 1, total: 1 },
        next: { id: "b", name: "b", reason: "做对它，先修会亮成○", key: true },
        points: [
          { ...a, pos: { x: 120, y: 40, label: "below" } },
          { ...b, pos: { x: 120, y: 120, label: "below" } },
          { ...c, pos: { x: 300, y: 200, label: "below" } },
        ],
        // v4 star map (server pos / lines / canvas).
        canvas: { width: 375, height: 300 },
        lines: [
          { from: "a", to: "b", type: "main", points: [{ x: 120, y: 47 }, { x: 120, y: 113 }] },
          { from: "b", to: "c", type: "up", points: [{ x: 127, y: 120 }, { x: 300, y: 200 }] },
        ],
        nodes: [{ id: "n1", name: "入门组", members: ["a", "b"] }],
        sides: [{ parent: "b", members: ["c"] }],
      },
    ],
  };
}
function graph() {
  return {
    chapterId: "limit",
    width: 500,
    height: 500,
    external: [],
    nodes: [
      { id: "a", x: 20, y: 20, width: 80, height: 34 },
      { id: "b", x: 160, y: 160, width: 80, height: 34 },
      { id: "c", x: 300, y: 300, width: 80, height: 34 },
    ],
    edges: [
      {
        from: "a",
        to: "b",
        points: [
          { x: 100, y: 37 },
          { x: 130, y: 37 },
          { x: 130, y: 177 },
          { x: 160, y: 177 },
        ],
      },
      {
        from: "b",
        to: "c",
        points: [
          { x: 240, y: 177 },
          { x: 300, y: 317 },
        ],
      },
    ],
  };
}

test("task and relation layouts expand groups, keep due state, and classify dependency paths", () => {
  const chapter = fixture().chapters[0];
  const closed = layout.taskLayout(chapter, "");
  const open = layout.taskLayout(chapter, "n1");
  assert.equal(closed.nodes[0].group, true);
  assert.equal(open.nodes[0].memberViews.length, 2);
  assert.ok(open.nodes[0].width > closed.nodes[0].width);
  assert.equal(closed.sides[0].members[0].statusIcon, "✓");
  // a due point shows 该复习, not 做对了 (utils/point-look.js).
  assert.equal(closed.sides[0].statusCls, "due", "a due point shows that it is due");
  const related = layout.relationLayout(chapter, graph(), "b");
  assert.equal(
    related.nodes.find((item) => item.id === "a").relation,
    "before",
  );
  assert.equal(related.nodes.find((item) => item.id === "c").relation, "after");
  assert.ok(related.edges.some((edge) => edge.cls === "before"));
  assert.ok(related.edges.some((edge) => edge.cls === "after"));
  const edge = layout.edgeIndicator(
    closed,
    "b",
    { tx: -900, ty: 0, s: 0.72 },
    { width: 390, height: 560 },
  );
  assert.ok(edge.left >= 0 && edge.left <= 390);
  assert.equal(edge.arrow, "←");
  assert.equal(edge.text, "← 下一步");
  const right = layout.edgeIndicator(
    closed,
    "b",
    { tx: 900, ty: 0, s: 0.72 },
    { width: 390, height: 560 },
  );
  assert.equal(right.text, "下一步 →");
  assert.ok(right.left + 96 <= 390 && right.top + 34 <= 560);
  const below = layout.edgeIndicator(
    closed,
    "b",
    { tx: 0, ty: -2000, s: 0.72 },
    { width: 390, height: 560 },
  );
  assert.equal(below.arrow, "↑");
});

test("map nodes show only a name and one state colour (v3 §5.5)", () => {
  const chapter = fixture().chapters[0];
  const closed = layout.taskLayout(chapter, "");
  const group = closed.nodes[0];
  assert.equal(group.statusCls, "pending", "done plus 我会了 reads as 还差一点");
  assert.equal(group.next, true, "the group holding 下一步 carries the tag");
  for (const field of ["badge", "badges", "statusIcons", "key", "hard", "levelDots", "cards", "sectionText"])
    assert.equal(group[field], undefined, `${field} moved to the detail panel`);
  assert.equal(closed.sides[0].sideText, "加餐 · 拔高");
  const fresh = {
    ...chapter,
    next: null,
    points: chapter.points.map((p) => ({ ...p, state: "none", retest: null })),
  };
  const untouched = layout.taskLayout(fresh, "").nodes[0];
  assert.equal(untouched.statusCls, "none");
  assert.equal(untouched.next, false);
  const stuck = layout.taskLayout(
    {
      ...fresh,
      points: fresh.points.map((p) =>
        p.id === "a" ? { ...p, stuck: true, stuckAt: "2026-10-12" } : p,
      ),
    },
    "",
  ).nodes[0];
  assert.equal(stuck.statusCls, "stuck");
  assert.equal(layout.pointView(chapter.points[1], "").statusText, "标了会");
  assert.equal(layout.pointView(fresh.points[0], "").statusText, "没碰过");
  const component = fs.readFileSync(
    path.join(root, "pages/map/components/stage/index.wxml"),
    "utf8",
  );
  assert.doesNotMatch(component, /statusIcons|item\.key\+item\.hard|levelDots|near-extra|kind-mark/);
  assert.match(component, /class="branch-label"/);
  const styles = fs.readFileSync(
    path.join(root, "pages/map/components/stage/index.wxss"),
    "utf8",
  );
  assert.doesNotMatch(styles, /\.branch-label \{[^}]*position:absolute/, "the 加餐 label sits under the name");
});

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
  for (let i = 0; i < parts.length - 1; i++)
    current = current[parts[i]] = current[parts[i]] || {};
  current[parts.at(-1)] = value;
}
function loadPage(api) {
  let definition,
    user = { id: "u1" };
  const storage = {},
    app = { globalData: {} },
    navigation = [],
    toasts = [],
    sheets = [],
    modals = [];
  global.Page = (value) => {
    definition = value;
  };
  global.getApp = () => app;
  global.getCurrentPages = () => [];
  global.wx = {
    getStorageSync: (key) => storage[key],
    setStorageSync: (key, value) => {
      storage[key] = value;
    },
    getWindowInfo: () => ({
      windowWidth: 390,
      windowHeight: 844,
      statusBarHeight: 24,
    }),
    getMenuButtonBoundingClientRect: () => ({ top: 28, height: 32 }),
    showTabBar() {
      throw new Error("the map is not a tab page");
    },
    showToast: (value) => toasts.push(value.title),
    showActionSheet: (value) => sheets.push(value),
    showModal: (value) => modals.push(value),
    navigateTo: (value) => navigation.push(value),
    switchTab: (value) => navigation.push(value),
    redirectTo: (value) => navigation.push(value),
    navigateBack() {},
  };
  put(path.join(root, "utils/api.js"), api);
  put(path.join(root, "utils/auth.js"), {
    login: () => Promise.resolve(user),
    getUser: () => user,
    hasConsent: () => true,
  });
  put(path.join(root, "utils/theme.js"), { themed: (value) => value });
  put(path.join(root, "utils/gate.js"), {
    state: () => "ok",
    check: () => true,
    ask: () => modals.push({ title: "同意后才能用" }),
  });
  put(path.join(root, "utils/request.js"), {
    request: () => Promise.reject(new Error("no network in tests")),
  });
  put(path.join(root, "utils/format.js"), {
    errorText: (error) => error.message || "失败",
    monthDay: (value) => {
      const match = String(value || "").match(/^\d{4}-(\d{2})-(\d{2})/);
      return match ? `${Number(match[1])}/${Number(match[2])}` : "";
    },
  });
  put(path.join(root, "utils/learn.js"), {
    ROUTES: {
      learn: "pages/learn/index",
      point: "pages/point/index",
      ranks: "pages/ranks/index",
      knowledge: "pages/knowledge/index",
    },
    backTo: (route, id) => navigation.push({ route, id }),
    navPlan: (pages, route) => ({ kind: "navigateTo", url: `/${route}` }),
  });
  delete require.cache[path.join(root, "utils/chat-entry.js")];
  delete require.cache[pageFile];
  require(pageFile);
  definition.data = structuredClone(definition.data);
  definition.setData = (patch) =>
    Object.entries(patch).forEach(([key, value]) =>
      key.includes(".")
        ? setPath(definition.data, key, value)
        : (definition.data[key] = value),
    );
  definition.alive = true;
  definition.query = {};
  definition.viewport = { width: 390, height: 560 };
  return {
    page: definition,
    app,
    navigation,
    storage,
    toasts,
    sheets,
    modals,
    setUser: (value) => {
      user = value;
    },
  };
}

test("map page asks for the dark card map and centres on the requested point", async () => {
  const calls = [];
  const api = {
    get(url) {
      calls.push(["GET", url]);
      return Promise.resolve(fixture());
    },
    post: () => Promise.resolve({}),
    put: () => Promise.resolve({ taughtTo: "all" }),
    needsConsent: () => false,
  };
  const { page, navigation } = loadPage(api);
  page.query = { id: "b" };
  await page.load();
  assert.equal(page.data.chapterId, "limit");
  // the detail is a page of its own; ?id= only centres the map.
  assert.equal(page.data.panel, undefined);
  assert.deepEqual(navigation, []);
  assert.ok(calls.every(([, url]) => !url.includes("/graph")), "no relation graph any more");
  assert.match(calls[0][1], /^\/v1\/learn\/map\?view=task&level=far&cards=1&tone=dark$/);
});

test("map stage uses its measured viewport once without drifting on repeated ready events", async () => {
  const api = {
    get: () => Promise.resolve(fixture()),
    post: () => Promise.resolve({}),
    put: () => Promise.resolve({}),
    needsConsent: () => false,
  };
  const { page } = loadPage(api);
  await page.load();
  const measured = { width: 390, height: 502.71 };
  page.stageReady({ detail: measured });
  const after = page.motionObject();
  assert.equal(page.viewport.width, measured.width);
  assert.equal(page.viewport.height, measured.height);
  // The opening star chart is the whole chapter, fitted again to the measured
  // stage above the 下一步 card.
  const fit = stars.fitView(page.data.layout, measured, page.farHeight());
  assert.deepEqual(after, { tx: fit.tx, ty: fit.ty, s: stars.clamp(fit.s) });
  assert.deepEqual(
    page.data.edgeNext,
    stars.edgeNext(page.data.next.pos, after, { width: 390, height: page.farHeight() }),
    "the next-point indicator uses the same measured viewport",
  );
  // A map the student has moved keeps its middle instead.
  page.stageSettle({ detail: { tx: after.tx + 40, ty: after.ty, s: after.s } });
  const moved = page.motionObject();
  page.stageReady({ detail: { width: 390, height: 540.71 } });
  assert.ok(Math.abs(page.motionObject().ty - (moved.ty + 19)) < 0.001);
  page.stageReady({ detail: measured });
  const motion = page.data.motion;
  const edge = structuredClone(page.data.edgeNext);
  page.stageReady({ detail: measured });
  assert.equal(page.data.motion, motion, "the same ready event does not shift again");
  assert.deepEqual(page.data.edgeNext, edge);
});

test("map page falls back to the same owner's cached map when refresh fails", async () => {
  let offline = false;
  const api = {
    get() {
      return offline
        ? Promise.reject(new Error("offline"))
        : Promise.resolve(fixture());
    },
    post: () => Promise.resolve({}),
    put: () => Promise.resolve({}),
    needsConsent: () => false,
  };
  const { page } = loadPage(api);
  await page.load();
  offline = true;
  page.setData({ chapter: null, chapterId: "" });
  await page.load({ keep: true });
  assert.equal(page.data.chapter.id, "limit");
  assert.equal(page.data.error, "网络不太好，先给你看上次的地图");
});

test("teaching range uses its final payload (stuck guidance moved to the detail page, V4.1 G4)", async () => {
  const calls = [];
  let taughtTo = null;
  const api = {
    get: () => Promise.resolve({ ...fixture(), taughtTo }),
    put(url, body) {
      calls.push([url, body]);
      taughtTo = body.taughtTo;
      return Promise.resolve({ taughtTo: body.taughtTo });
    },
    post(url, body) {
      if (url.endsWith("/map/events")) return Promise.resolve({});
      calls.push([url, body]);
      if (url.endsWith("/stuck"))
        return Promise.resolve({
          crisis: false,
          quote: body.text,
          ask: "卡在哪一步？",
          options: ["第一步", "化简"],
          suggest: "a",
        });
      return Promise.resolve({ stuckAt: "2026-10-12T00:00:00.000Z" });
    },
    needsConsent: () => false,
  };
  const { page } = loadPage(api);
  await page.load();
  assert.equal(page.data.taughtOpen, false, "老师讲到哪了 never pops up on its own");
  assert.match(page.data.taughtLink, /推荐更准/);
  page.openTaught();
  assert.equal(page.data.taughtOpen, true);
  page.closeTaught();
  assert.equal(page.data.taughtOpen, false);
  assert.equal(calls.length, 0, "先不选 and × write nothing");
  await page.saveTaught({ currentTarget: { dataset: { value: "all" } } });
  assert.deepEqual(calls.find(([url]) => url === "/v1/me/settings")[1], {
    taughtTo: "all",
  });
  assert.equal(page.data.taughtLink, "老师全讲完了 ›");
  assert.equal(page.openStuck, undefined, "卡住了 is on pages/knowledge now");
});

test("map page opens on the whole chapter as a star chart and zooms to cards", async () => {
  const api = {
    get: () => Promise.resolve({ ...fixture(), taughtTo: null }),
    post: () => Promise.resolve({}),
    put: () => Promise.resolve({}),
    needsConsent: () => false,
  };
  const { page, navigation } = loadPage(api);
  await page.load();
  assert.equal(page.data.panel, undefined);
  assert.equal(page.data.taughtOpen, false);
  assert.equal(page.data.zoom, "far");
  const m = page.motionObject();
  const layout = page.data.layout;
  assert.ok(layout.width * m.s <= 390 + 1 && layout.height * m.s <= page.farHeight() + 1, "the whole chapter is on screen");
  assert.ok(Math.abs(m.tx * 2 + layout.width * m.s - 390) <= 1, "centred");
  assert.equal(page.data.edgeNext, null, "下一步 is on screen");
  page.stageSettle({ detail: { tx: 2000, ty: m.ty, s: m.s } });
  assert.equal(page.data.edgeNext.text, "下一步 →");
  const before = navigation.length;
  page.backToNext();
  assert.equal(navigation.length, before, "the capsule only pans back");
  assert.equal(page.data.edgeNext, null);
  page.zoomIn();
  assert.equal(page.data.zoom, "near");
  assert.equal(page.motionObject().s, 1);
  page.zoomOut();
  assert.equal(page.data.zoom, "far");
  assert.deepEqual(page.motionObject(), m, "− fits the whole chapter again");
  assert.equal(page.data.bookProgress, 50, "全书 shows real progress");
  assert.equal(page.data.chapters[0].correct, 1);
  page.nextTap();
  assert.deepEqual(navigation.at(-1), { route: "pages/point/index", id: "b" });
  const source = fs.readFileSync(pageFile, "utf8");
  assert.doesNotMatch(source, /showTabBar|setNavigationBarColor/);
});

test("the portrait map has no 关系 view; a tap opens the point's detail page (V4.1 G4)", async () => {
  const posts = [];
  const api = {
    get: () => Promise.resolve(fixture()),
    post(url, body) {
      posts.push([url, body]);
      return Promise.resolve({});
    },
    put: () => Promise.resolve({}),
    needsConsent: () => false,
  };
  const { page, navigation } = loadPage(api);
  await page.load();
  assert.equal(page.toggleRelation, undefined);
  page.nodeTap({ detail: { id: "a" } });
  assert.deepEqual(navigation.at(-1), { route: "pages/knowledge/index", id: "a" });
  assert.deepEqual(posts.at(-1), [
    "/v1/learn/map/events",
    { name: "node_open", pointId: "a", chapterId: "limit", view: "task" },
  ]);
  assert.equal(page.data.panel, undefined);
  assert.ok(page.data.layout.stars.every((x) => !x.fade), "nothing is dimmed on the map");
  // 下一步 without a problem yet: its detail page.
  page.data.next = { ...page.data.next, id: "c", ready: false };
  page.nextTap();
  assert.deepEqual(navigation.at(-1), { route: "pages/knowledge/index", id: "c" });
});

test("⋯ menu stays within an action sheet and batch marks say what happened", async () => {
  const posts = [];
  let fail = null;
  const api = {
    get: () => Promise.resolve(fixture()),
    post(url, body) {
      posts.push(body);
      if (fail) return Promise.reject(fail);
      return Promise.resolve({ changed: 3 });
    },
    put: () => Promise.resolve({}),
    needsConsent: () => false,
  };
  const { page, sheets, toasts, modals } = loadPage(api);
  await page.load();
  page.openMenu();
  const menu = sheets.at(-1);
  assert.ok(menu.itemList.length <= 6);
  assert.deepEqual(menu.itemList, [
    "这些颜色啥意思",
    "老师讲到哪了",
    "我的进度",
    "整章标记",
    "横过来看",
  ]);
  menu.success({ tapIndex: 3 });
  const marks = sheets.at(-1);
  assert.ok(marks.itemList.length <= 6);
  assert.equal(marks.itemList.length, 3, "the undo shows while the chapter has 我会了");
  for (const [action, toast] of [
    ["selfRest", "好，这 3 个都算你会了"],
    ["unselfRest", "好，改回来了"],
    ["hide", "好，这章先放着"],
    ["unhide", "这章放回来了"],
  ]) {
    await page.markChapter(action, "limit");
    assert.equal(toasts.at(-1), toast);
  }
  marks.success({ tapIndex: 1 });
  assert.match(modals.at(-1).title, /撤掉/);
  fail = Object.assign(new Error("最后一章先留着吧"), {
    statusCode: 409,
    code: "LAST_CHAPTER",
  });
  await page.markChapter("hide", "limit");
  assert.equal(toasts.at(-1), "最后一章先留着吧");
  assert.ok(posts.every((body) => body.chapterId === "limit"));
});

test("the map keeps none of the old sheet's actions; they live in utils/point-actions.js (V4.1 G4)", () => {
  const source = fs.readFileSync(pageFile, "utf8");
  for (const gone of ["openPanel", "askAI", "teachAI", "openStuck", "sendStuck", "collectCard", "openCards", "openMistakes", "panelView"])
    assert.ok(!source.includes(`${gone}(`), gone);
  const actions = fs.readFileSync(path.join(root, "utils/point-actions.js"), "utf8");
  for (const kept of ["startChat", "collectCard", "openCards", "openMistakes", "openStuck", "sendStuck", "toggleSelf"])
    assert.match(actions, new RegExp(`function ${kept}\\(`), kept);
});

function loadLandscape(api) {
  let definition;
  global.Page = (value) => {
    definition = value;
  };
  global.wx = { navigateBack() {}, redirectTo() {} };
  put(path.join(root, "utils/api.js"), api);
  put(path.join(root, "utils/auth.js"), {
    login: () => Promise.resolve({ id: "u1" }),
    getUser: () => ({ id: "u1" }),
    hasConsent: () => true,
  });
  const file = path.join(root, "pages/map/landscape/index.js");
  delete require.cache[file];
  require(file);
  definition.data = structuredClone(definition.data);
  definition.setData = (patch) => Object.assign(definition.data, patch);
  definition.alive = true;
  return definition;
}

test("landscape map shows a plain line when loading fails and retries on tap", async () => {
  let fail = true;
  const api = {
    get: (url) =>
      fail
        ? Promise.reject(new Error("SQLITE_BUSY: database is locked"))
        : Promise.resolve(url.includes("/graph") ? graph() : fixture()),
    needsConsent: () => false,
  };
  const page = loadLandscape(api);
  page.chapterId = "limit";
  await page.load();
  assert.equal(page.data.error, "地图没加载出来，点一下再试");
  fail = false;
  await page.retry();
  assert.equal(page.data.error, "");
  assert.equal(page.data.chapter.id, "limit");
  fail = true;
  await page.switchView({ currentTarget: { dataset: { view: "relation" } } });
  assert.equal(page.data.error, "地图没加载出来，点一下再试");
  const source = fs.readFileSync(
    path.join(root, "pages/map/landscape/index.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /error\.message/);
});

test("map templates keep custom navigation, WXS stage, and a read-only landscape route", () => {
  const wxml = fs.readFileSync(path.join(root, "pages/map/index.wxml"), "utf8");
  const component = fs.readFileSync(
    path.join(root, "pages/map/components/stage/index.wxml"),
    "utf8",
  );
  const pageJson = JSON.parse(
    fs.readFileSync(path.join(root, "pages/map/index.json"), "utf8"),
  );
  const landscape = JSON.parse(
    fs.readFileSync(path.join(root, "pages/map/landscape/index.json"), "utf8"),
  );
  // v4: 关系 is folded into the star map; the chat button is 讲一遍.
  assert.doesNotMatch(wxml, /toggleRelation|关系|讲给 AI 听/);
  assert.doesNotMatch(wxml, /讲一遍|msheet|stuck-sheet/, "the sheet moved to pages/knowledge (V4.1 G4)");
  assert.match(wxml, /<map-sky /);
  assert.match(wxml, /class="map-page night/);
  assert.match(fs.readFileSync(path.join(root, "pages/map/components/sky/index.wxml"), "utf8"), /stage\/gesture\.wxs/);
  assert.match(wxml, /卡住了/, "the legend still names the colours");
  assert.match(component, /gesture\.wxs/);
  assert.match(component, /catchtouchmove/);
  assert.equal(pageJson.navigationStyle, "custom");
  assert.equal(pageJson.disableScroll, true);
  assert.equal(landscape.pageOrientation, "landscape");
});
