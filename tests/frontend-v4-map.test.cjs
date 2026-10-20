"use strict";
// 地图页面回归：核对星图展示、知识点定位、交互与状态恢复。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const pageFile = path.join(root, "pages/map/index.js");
const stars = require(path.join(root, "pages/map/stars.js"));

function point(id, extra = {}) {
  return {
    id,
    name: `${id} 全名`,
    short: id,
    section: "1.1",
    line: "main",
    key: false,
    hard: false,
    prereqs: [],
    state: "none",
    ready: true,
    taught: true,
    formulas: [`${id}=1`],
    keys: [`${id} 的要点`],
    ...extra,
  };
}
// a → b → d (main), a → c (main), c ⇢ e (opt), b — s (up, side point).
function chapter(states = {}) {
  const pts = [
    point("a", { pos: { x: 120, y: 40, label: "below" } }),
    point("b", { prereqs: ["a"], key: true, pos: { x: 60, y: 120, label: "below" } }),
    point("c", { prereqs: ["a"], hard: true, pos: { x: 200, y: 120, label: "below" } }),
    point("d", { prereqs: ["b"], pos: { x: 60, y: 200, label: "below" } }),
    point("e", { prereqs: ["c"], pos: { x: 200, y: 200, label: "below" } }),
    point("s", { prereqs: ["b"], line: "side", side: "up", pos: { x: 330, y: 120, label: "left" } }),
  ].map((p) => ({ ...p, ...(states[p.id] || {}) }));
  return {
    id: "limit",
    book: "第 1 章",
    short: "极限",
    main: { correct: 0, total: 5 },
    canvas: { width: 375, height: 260 },
    next: { id: "b", name: "b" },
    points: pts,
    lines: [
      { from: "a", to: "b", type: "main", points: [{ x: 120, y: 47 }, { x: 60, y: 113 }] },
      { from: "a", to: "c", type: "main", points: [{ x: 120, y: 47 }, { x: 200, y: 113 }] },
      { from: "b", to: "d", type: "main", points: [{ x: 60, y: 127 }, { x: 60, y: 193 }] },
      { from: "c", to: "e", type: "opt", points: [{ x: 200, y: 127 }, { x: 200, y: 193 }] },
      { from: "b", to: "s", type: "up", points: [{ x: 67, y: 120 }, { x: 330, y: 120 }] },
    ],
  };
}

test("two zoom levels: under 0.66 is the star chart, from 0.66 the cards", () => {
  assert.equal(stars.tier(stars.FAR), "far");
  assert.equal(stars.tier(0.65), "far");
  assert.equal(stars.tier(0.66), "near");
  assert.equal(stars.tier(1), "near");
  assert.equal(stars.clamp(5), 1);
  // A tall chapter may shrink below FAR to fit the screen (stars.fitView).
  assert.equal(stars.clamp(0.1), stars.MIN);
  assert.ok(stars.MIN < stars.FAR);
  // The pinch stage switches its class at the same point.
  const wxs = fs.readFileSync(path.join(root, "pages/map/components/stage/gesture.wxs"), "utf8");
  assert.match(wxs, /s < 0\.66 \? "far" : "near"/);
  // − and + jump between the two levels around the middle of the view.
  const near = stars.zoomTo({ tx: 0, ty: 0, s: stars.FAR }, 1, { width: 390, height: 560 });
  assert.equal(stars.tier(near.s), "near");
  assert.equal(stars.tier(stars.zoomTo(near, stars.FAR, { width: 390, height: 560 }).s), "far");
});

test("lines are blue only: the main line glows into 下一步, lights when reached, else dims; 拔高 and 选学 stay pale", () => {
  const byState = { a: "ok", b: "next", c: "pend", d: "none", e: "none", s: "side" };
  const cls = (from, to, type) => stars.lineClass({ from, to, type }, byState, "b");
  assert.equal(cls("a", "b", "main"), "glow");
  assert.equal(cls("a", "c", "main"), "lit");
  assert.equal(cls("b", "d", "main"), "dim");
  assert.equal(cls("c", "e", "opt"), "opt");
  assert.equal(cls("b", "s", "up"), "up");
  // The same through the layout, for both levels.
  const layout = stars.starLayout(chapter({ a: { state: "correct" }, c: { state: "self" } }), { nextId: "b" });
  const far = layout.farLines.map((x) => x.cls);
  assert.deepEqual(far, ["glow", "lit", "dim", "opt", "up"]);
  assert.deepEqual(layout.nearLines.map((x) => x.cls), far);
  // Near lines are the far ones scaled by 2.3.
  assert.ok(Math.abs(layout.nearLines[2].len - layout.farLines[2].len * stars.S) < 0.2);
  const wxss = fs.readFileSync(path.join(root, "pages/map/components/sky/index.wxss"), "utf8");
  const colours = (wxss.match(/\.ln[^{]*\{[^}]*\}/g) || []).join("\n").match(/#[0-9a-f]{6}/gi);
  assert.ok(colours.every((c) => ["#4fb2ff", "#9ad6ff", "#cfe0ff"].includes(c.toLowerCase())), colours.join());
});

test("stars and cards come from the server's pos; states drive the look", () => {
  const layout = stars.starLayout(
    chapter({ a: { state: "correct" }, c: { stuck: true }, d: { state: "self" } }),
    { nextId: "b" },
  );
  const byId = Object.fromEntries(layout.stars.map((x) => [x.id, x]));
  assert.equal(byId.a.cls, "ok");
  // 下一步 is a mark on top of the state, not a state of its own.
  assert.equal(byId.b.cls, "none");
  assert.equal(byId.b.next, true);
  assert.equal(byId.c.cls, "stuck");
  assert.equal(byId.d.cls, "pend");
  assert.equal(byId.e.cls, "none");
  assert.equal(byId.s.cls, "side");
  assert.equal(byId.b.mark, "★");
  assert.equal(byId.c.mark, "◆");
  assert.equal(byId.s.mark, "", "side points carry no mark");
  assert.equal(byId.s.left, true);
  assert.deepEqual([byId.a.x, byId.a.y], [120, 40]);
  assert.equal(layout.width, Math.round(375 * stars.S));
  assert.equal(layout.farWidth, 375);
  // Cards: centred on pos × 2.3, 下一步 taller, first formula and key.
  const card = layout.cards.find((x) => x.id === "b");
  assert.equal(card.next, true);
  assert.ok(card.height > layout.cards.find((x) => x.id === "e").height || card.height === 150);
  assert.equal(card.formulaText, "b=1");
  assert.ok(Array.isArray(card.key));
  // No two cards overlap.
  for (const p of layout.cards)
    for (const q of layout.cards) {
      if (p === q) continue;
      const apart =
        p.left + p.width <= q.left ||
        q.left + q.width <= p.left ||
        p.top + p.height <= q.top ||
        q.top + q.height <= p.top;
      assert.ok(apart, `${p.id} and ${q.id} overlap`);
    }
  // Server blocks win over text.
  const blocks = [{ t: "p", c: [{ t: "text", v: "x" }] }];
  const withBlocks = chapter();
  withBlocks.points[0].formulaBlocks = [blocks];
  withBlocks.points[0].keyBlocks = [blocks];
  const a = stars.starLayout(withBlocks, {}).cards[0];
  assert.deepEqual(a.formula, blocks);
  assert.equal(a.formulaText, "");
  assert.deepEqual(a.key, blocks);
});

test("a point opened in the sheet keeps only its 先学 and 后续 lit", () => {
  const layout = stars.starLayout(chapter(), { nextId: "b", focusId: "b" });
  const fade = Object.fromEntries(layout.stars.map((x) => [x.id, x.fade]));
  assert.deepEqual(fade, { a: false, b: false, c: true, d: false, e: true, s: false });
  assert.ok(layout.farLines.filter((x) => / fade$/.test(x.cls)).length >= 2);
});

function put(file, exports) {
  const full = path.join(root, file);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}
function loadPage(state) {
  let definition;
  const calls = { get: [], post: [], login: 0, request: [], modals: [], navigation: [] };
  global.Page = (value) => {
    definition = value;
  };
  global.getApp = () => ({ globalData: {} });
  global.wx = {
    getStorageSync: () => undefined,
    setStorageSync() {},
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, statusBarHeight: 24 }),
    getMenuButtonBoundingClientRect: () => ({ top: 28, height: 32 }),
    showModal: (value) => calls.modals.push(value),
    showActionSheet: (value) => calls.modals.push({ sheet: value.itemList }),
    showToast() {},
    navigateTo: (value) => calls.navigation.push(value.url),
    switchTab: (value) => calls.navigation.push(value.url),
    reLaunch: (value) => calls.navigation.push(value.url),
  };
  put("utils/api.js", {
    get: (url) => {
      calls.get.push(url);
      return Promise.resolve({ chapters: [chapter()] });
    },
    post: (url) => {
      calls.post.push(url);
      return Promise.resolve({});
    },
    put: () => Promise.resolve({}),
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
    check: () => state !== "none",
    ask: () => calls.modals.push({ title: "同意后才能用" }),
  });
  put("utils/request.js", {
    request: (options) => {
      calls.request.push(options.url);
      return Promise.resolve({ data: { title: "高数上", chapters: [chapter()] } });
    },
  });
  put("utils/learn.js", {
    ROUTES: { learn: "pages/learn/index", point: "pages/point/index", ranks: "pages/ranks/index", knowledge: "pages/knowledge/index" },
    backTo: (route, id) => calls.navigation.push(`${route}:${id}`),
    navPlan: (pages, route) => ({ kind: "navigateTo", url: `/${route}` }),
  });
  delete require.cache[path.join(root, "utils/chat-entry.js")];
  delete require.cache[pageFile];
  require(pageFile);
  definition.data = structuredClone(definition.data);
  definition.setData = (patch) => Object.assign(definition.data, patch);
  definition.onLoad({});
  return { page: definition, calls };
}

test("a guest map reads only the public endpoint, shows every point 没碰过 and asks before anything personal", async () => {
  const { page, calls } = loadPage("guest");
  page.onShow();
  await page.loadRequest;
  assert.deepEqual(calls.request, ["/v1/learn/map/public?tone=dark"]);
  assert.equal(calls.login, 0, "no login");
  assert.deepEqual(calls.get, [], "no signed-in request");
  assert.equal(page.data.guest, true);
  assert.equal(page.data.next, null, "no 下一步 for a guest");
  assert.ok(page.data.layout.stars.every((x) => x.cls === "none" || x.cls === "side"));
  assert.ok(page.data.layout.farLines.every((x) => ["dim", "up", "opt"].includes(x.cls)));
  assert.equal(page.data.chapters[0].correct, 0);
  // A tap opens the detail page; a guest may read it.
  page.nodeTap({ detail: { id: "b" } });
  assert.deepEqual(calls.navigation, ["pages/knowledge/index:b"]);
  assert.ok(calls.request.every((url) => url.startsWith("/v1/learn/map/public")));
  // Everything that needs an account asks first and sends nothing.
  const asked = calls.modals.length;
  page.practiceTap({ detail: { id: "b" } });
  page.openTaught();
  assert.equal(calls.modals.length - asked, 2);
  assert.ok(calls.modals.slice(asked).every((m) => m.title === "同意后才能用"));
  assert.deepEqual(calls.post, [], "no events, marks or chats");
  assert.equal(calls.login, 0);
  // The ⋯ menu has no landscape for a guest.
  page.openMenu();
  assert.ok(!calls.modals.at(-1).sheet.includes("横过来看"));
  // Zooming works and is not tracked.
  page.zoomIn();
  assert.equal(page.data.zoom, "near");
  assert.deepEqual(calls.post, []);
});

test("signed in, the map asks for its own cards in the dark tone and tracks events", async () => {
  const { page, calls } = loadPage("ok");
  page.onShow();
  await page.loadRequest;
  assert.equal(calls.login, 1);
  assert.equal(calls.get.length, 1);
  assert.match(calls.get[0], /^\/v1\/learn\/map\?view=task&level=far&cards=1&tone=dark$/);
  assert.equal(page.data.guest, false);
  assert.equal(page.data.next.id, "b");
  page.zoomIn();
  assert.ok(calls.post.includes("/v1/learn/map/events"));
});

test("onShow checks the gate first; no canvas meteors to start or stop (V4.1)", () => {
  const { page, calls } = loadPage("none");
  page.onShow();
  assert.deepEqual(calls.request, []);
  assert.equal(calls.login, 0);
  // the meteors are CSS behind the map; the page no longer drives a canvas.
  assert.equal(page.startSky, undefined);
  page.onHide();
  assert.equal(page.alive, false);
  const js = fs.readFileSync(path.join(root, "pages/map/index.js"), "utf8");
  assert.doesNotMatch(js, /require\("\.\/meteors"\)/);
});

test("map templates: night root, CSS meteors behind the map, two layers, no sheet and no model names", () => {
  const wxml = fs.readFileSync(path.join(root, "pages/map/index.wxml"), "utf8");
  const sky = fs.readFileSync(path.join(root, "pages/map/components/sky/index.wxml"), "utf8");
  assert.match(wxml, /^<view class="map-page night/);
  // no full-screen canvas over the map; a few CSS meteors behind it.
  assert.doesNotMatch(wxml, /<canvas/);
  assert.ok(wxml.indexOf('class="sky-back"') < wxml.indexOf('class="stage-wrap"'));
  assert.match(wxml, /<guest-bar \/>/);
  assert.match(wxml, />知识地图</);
  // the detail sheet is the page pages/knowledge now.
  assert.doesNotMatch(wxml, /msheet|stuck-sheet|openPanel|panel\./);
  assert.match(wxml, /练一题/);
  // The 下一步 card is gone in the cards view, and so is 老师讲到 under it.
  assert.match(wxml, /<view wx:if="\{\{zoom==='far'\}\}" class="nextp">/);
  assert.doesNotMatch(wxml, /taught-link|openTaught/);
  assert.match(sky, /class="tflag" style="left:\{\{layout\.flag\.left\}\}px;top:\{\{layout\.flag\.top\}\}px">课上</);
  assert.match(sky, /class="far-layer"/);
  assert.match(sky, /class="near-layer"/);
  assert.match(sky, /<rich blocks="\{\{item\.formula\}\}"/);
  assert.match(sky, /<rich blocks="\{\{item\.key\}\}"/);
  const landscape = fs.readFileSync(path.join(root, "pages/map/landscape/index.wxml"), "utf8");
  assert.match(landscape, /wx:if="\{\{showRelation\}\}" class="switch"/);
  for (const source of [wxml, sky, landscape])
    assert.doesNotMatch(source, /DeepSeek|Qwen|GPT|Claude|混元|大模型|讲给 AI 听/);
  assert.equal(wxml.split("AI 生成可能有误，注意核实").length - 1, 0, "no AI reply on the map any more");
});

test("the far view fits the whole chapter above the 下一步 card, centred", () => {
  const tall = { width: Math.round(400 * stars.S), height: Math.round(680 * stars.S) };
  const viewport = { width: 375, height: 600 };
  const m = stars.fitView(tall, viewport, 450);
  assert.ok(m.s < stars.FAR && m.s >= stars.MIN);
  assert.ok(tall.width * m.s <= 375 + 0.5 && tall.height * m.s <= 450 + 0.5, "the whole canvas is on screen");
  assert.ok(Math.abs(m.tx * 2 + tall.width * m.s - 375) <= 1, "centred across");
  assert.ok(Math.abs(m.ty * 2 + tall.height * m.s - 450) <= 1, "centred in the visible height");
  assert.equal(stars.tier(m.s), "far");
  // A small chapter is not blown up past the star chart's own size.
  const small = { width: Math.round(375 * stars.S), height: Math.round(300 * stars.S) };
  assert.equal(stars.fitView(small, viewport, 450).s, stars.FAR);
});

test("课上 flag: beside the last taught point of the chapter, none when unset or outside it", () => {
  const pts = chapter().points.map((p, i) => ({ ...p, section: ["1.1", "1.2", "1.2", "1.3", "1.4", "1.2"][i] }));
  // b and c are both 1.2; c is not lower, b wins as the left one; s is a side point.
  assert.deepEqual(stars.taughtFlag(pts, "1.2"), { id: "b", left: 60 + 14, top: 120 - 9 });
  assert.deepEqual(stars.taughtFlag(pts, "1.3"), { id: "d", left: 74, top: 191 });
  for (const value of [null, undefined, "all", "none", "2.1", "0.9"])
    assert.equal(stars.taughtFlag(pts, value), null, String(value));
  const layout = stars.starLayout({ ...chapter(), points: pts }, { taughtTo: "1.3", nextId: "b" });
  assert.deepEqual(layout.flag, { id: "d", left: 74, top: 191 });
  assert.equal(stars.starLayout({ ...chapter(), points: pts }, { taughtTo: "1.3", guest: true }).flag, null);
});

test("cards: every card has its footer (status or 练一题, and 我的卡 N); short ones drop the formula row", () => {
  const sky = fs.readFileSync(path.join(root, "pages/map/components/sky/index.wxml"), "utf8");
  assert.match(sky, /<view class="kc-foot">/);
  assert.match(sky, /<view wx:if="\{\{!item\.tight\}\}" class="kc-fx">/);
  assert.match(sky, /class="mycards">我的卡 \{\{item\.cardCount\}\}/);
  const box = stars.cardBox({ pos: { x: 100, y: 100 } }, [{ pos: { x: 100, y: 100 } }, { pos: { x: 100, y: 138 } }], false);
  assert.equal(box.tight, true);
  const css = fs.readFileSync(path.join(root, "pages/map/index.wxss"), "utf8");
  assert.match(css, /\.kc-chip \.rich \{ font-size:16px;/);
});
