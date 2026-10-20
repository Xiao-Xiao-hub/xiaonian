"use strict";
// V4.1 G1 · 地图点击: the viewport catches every touch for pan and pinch, so a
// tap is decided in the WXS gesture (one finger, at most about 10px, at most
// about 350ms) and pages/map/hit.js finds what is under it. The native taps
// stay as a fallback; one tap acts once. Every near card has 练一题, the
// meteors are CSS behind the map, and a press shows at once.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../miniprogram");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const hit = require(path.join(root, "pages/map/hit.js"));
const stars = require(path.join(root, "pages/map/stars.js"));

// The WXS file run as plain ES5, with a fake owner.
function gesture() {
  const module = { exports: {} };
  vm.runInNewContext(read("pages/map/components/stage/gesture.wxs"), { module, Math, parseFloat, isNaN });
  const calls = [];
  const state = {};
  const plane = { setStyle() {}, addClass() {}, removeClass() {} };
  const owner = {
    getState: () => state,
    callMethod: (name, detail) => calls.push([name, JSON.parse(JSON.stringify(detail))]),
    selectComponent: () => plane,
  };
  const dataset = { left: "0", top: "100" };
  const ev = (type, touches, changed, timeStamp, target = {}) => ({
    type,
    touches,
    changedTouches: changed,
    timeStamp,
    currentTarget: { dataset },
    target: { dataset: target },
  });
  const t = (x, y) => ({ pageX: x, pageY: y });
  return { wxs: module.exports, owner, calls, ev, t, state };
}
const named = (calls, name) => calls.filter((c) => c[0] === name).map((c) => c[1]);

test("WXS: one finger, a few px, a short press is a tap with the spot and the target's dataset", () => {
  const g = gesture();
  g.wxs.motionChanged("10,20,1,0", "", g.owner);
  g.wxs.start(g.ev("touchstart", [g.t(110, 220)], [g.t(110, 220)], 1000, { id: "b", act: "practice" }), g.owner);
  g.wxs.move(g.ev("touchmove", [g.t(114, 223)], [g.t(114, 223)], 1100), g.owner);
  g.wxs.end(g.ev("touchend", [], [g.t(114, 223)], 1300), g.owner);
  // Pressed at once, with the same spot.
  assert.deepEqual(named(g.calls, "gesturePress")[0], { x: 110, y: 120, tx: 10, ty: 20, s: 1 });
  const taps = named(g.calls, "gestureTap");
  assert.equal(taps.length, 1);
  // The spot is where the finger went down, on the plane as it was then.
  assert.deepEqual(taps[0], { x: 110, y: 120, tx: 10, ty: 20, s: 1, id: "b", act: "practice" });
  // No fling after a tap; the settle says it did not move.
  assert.equal(named(g.calls, "gestureSettle").at(-1).moved, false);
});

test("WXS: a drag, a long press, a pinch or a cancel is not a tap and the press goes away", () => {
  for (const kind of ["drag", "long", "pinch", "cancel"]) {
    const g = gesture();
    g.wxs.motionChanged("0,0,1,0", "", g.owner);
    g.wxs.start(g.ev("touchstart", [g.t(100, 200)], [g.t(100, 200)], 0), g.owner);
    if (kind === "drag") g.wxs.move(g.ev("touchmove", [g.t(100, 230)], [g.t(100, 230)], 50), g.owner);
    if (kind === "pinch") {
      g.wxs.start(g.ev("touchstart", [g.t(100, 200), g.t(160, 260)], [g.t(160, 260)], 40), g.owner);
      g.wxs.end(g.ev("touchend", [g.t(100, 200)], [g.t(160, 260)], 120), g.owner);
    }
    const lift = kind === "drag" ? g.t(100, 230) : g.t(100, 200);
    const time = kind === "long" ? 600 : 200;
    g.wxs.end(g.ev(kind === "cancel" ? "touchcancel" : "touchend", [], [lift], time), g.owner);
    assert.equal(named(g.calls, "gestureTap").length, 0, kind);
    // Pressed, then cleared exactly once.
    const presses = named(g.calls, "gesturePress");
    assert.equal(presses.length, 2, kind);
    assert.deepEqual(presses[1], {}, kind);
  }
  // A drag still settles as moved (the native tap after it is ignored).
  const g = gesture();
  g.wxs.motionChanged("0,0,1,0", "", g.owner);
  g.wxs.start(g.ev("touchstart", [g.t(100, 200)], [g.t(100, 200)], 0), g.owner);
  g.wxs.move(g.ev("touchmove", [g.t(140, 200)], [g.t(140, 200)], 50), g.owner);
  g.wxs.end(g.ev("touchend", [], [g.t(140, 200)], 100), g.owner);
  assert.equal(named(g.calls, "gestureSettle")[0].moved, true);
});

// The chapter from the v4 map test: a → b → d, a → c → e, b — s (side, label left).
function chapter() {
  const point = (id, pos, extra = {}) => ({ id, name: `${id} 全名`, short: id, section: "1.1", line: "main", prereqs: [], state: "none", ready: true, taught: true, formulas: [], keys: [], pos, ...extra });
  return {
    id: "limit",
    canvas: { width: 375, height: 260 },
    points: [
      point("a", { x: 120, y: 40, label: "below" }),
      point("b", { x: 60, y: 120, label: "below" }, { prereqs: ["a"] }),
      point("c", { x: 200, y: 120, label: "below" }, { prereqs: ["a"], ready: false }),
      point("d", { x: 60, y: 200, label: "below" }, { prereqs: ["b"] }),
      point("e", { x: 200, y: 200, label: "below" }, { prereqs: ["c"] }),
      point("s", { x: 330, y: 120, label: "left" }, { line: "side", prereqs: ["b"] }),
    ],
    lines: [],
  };
}
// A spot in the viewport for a plane point (px, py) at pan (tx, ty) and zoom s.
const at = (px, py, s, extra = {}) => ({ x: px * s + 7, y: py * s - 3, tx: 7, ty: -3, s, ...extra });

test("near: a tap on a card opens it, on its 练一题 practises; off the cards nothing", () => {
  const layout = stars.starLayout(chapter(), { nextId: "b" });
  const s = 1;
  for (const card of layout.cards) {
    // The title row and the middle of the card.
    assert.deepEqual(hit.sky(layout, at(card.left + card.width - 20, card.top + 14, s)), { id: card.id, act: "node" });
    assert.deepEqual(hit.sky(layout, at(card.left + card.width / 2, card.top + card.height / 2 - 10, s)), { id: card.id, act: "node" });
    // 练一题: bottom left of the card.
    assert.deepEqual(hit.sky(layout, at(card.left + 40, card.top + card.height - 24, s)), { id: card.id, act: "practice" });
  }
  assert.equal(hit.sky(layout, at(-50, -50, s)), null);
  // At a smaller near zoom the same plane point still finds the card.
  const b = layout.cards.find((c) => c.id === "b");
  assert.deepEqual(hit.sky(layout, at(b.left + 40, b.top + b.height - 24, 0.7)), { id: "b", act: "practice" });
  // The finger went down on 练一题 itself: that wins; a dataset id alone is
  // used when the geometry finds nothing.
  assert.deepEqual(hit.sky(layout, at(b.left + 60, b.top + 10, s, { id: "b", act: "practice" })), { id: "b", act: "practice" });
  assert.deepEqual(hit.sky(layout, at(-50, -50, s, { id: "e" })), { id: "e", act: "node" });
});

test("far: a tap on a star's dot or name opens it; the nearest dot wins", () => {
  const layout = stars.starLayout(chapter(), { nextId: "b" });
  const s = stars.FAR; // far layer drawn at 1 screen px per far px
  const far = (fx, fy) => at(fx * stars.S, fy * stars.S, s);
  assert.deepEqual(hit.sky(layout, far(120, 40)), { id: "a", act: "node" });
  assert.deepEqual(hit.sky(layout, far(132, 52)), { id: "a", act: "node" }, "within the dot's reach");
  assert.deepEqual(hit.sky(layout, far(122, 60)), { id: "a", act: "node" }, "the name under the dot");
  // s's label sits left of its dot.
  assert.deepEqual(hit.sky(layout, far(330 - 18, 121)), { id: "s", act: "node" });
  assert.equal(hit.sky(layout, far(10, 250)), null);
  // Between b (60,120) and d (60,200), nearer d.
  assert.deepEqual(hit.sky(layout, far(60, 196)), { id: "d", act: "node" });
});

test("landscape: a node opens, a group toggles, an expanded group's member opens; relation nodes too", () => {
  const layout = {
    nodes: [
      { id: "n1", baseX: 24, shiftX: 0, y: 190, width: 146, height: 92, group: false },
      { id: "g1", baseX: 198, shiftX: 0, y: 168, width: 340, height: 206, group: true, expanded: true, memberViews: [{ id: "p1", x: 14, y: 42, width: 132 }, { id: "p2", x: 170, y: 42, width: 132 }] },
    ],
    sides: [{ id: "side1", x: 600, y: 40, width: 160, height: 76, group: false }],
  };
  const spot = (x, y) => ({ x, y, tx: 0, ty: 0, s: 1 });
  assert.deepEqual(hit.stage(layout, "task", spot(60, 220)), { kind: "group", id: "n1", group: false });
  assert.deepEqual(hit.stage(layout, "task", spot(198 + 2 + 170 + 20, 168 + 2 + 42 + 30)), { kind: "node", id: "p2" });
  assert.deepEqual(hit.stage(layout, "task", spot(198 + 300, 168 + 10)), { kind: "group", id: "g1", group: true }, "the head folds it");
  assert.deepEqual(hit.stage(layout, "task", spot(650, 60)), { kind: "group", id: "side1", group: false });
  assert.equal(hit.stage(layout, "task", spot(5, 5)), null);
  const relation = { nodes: [{ id: "r1", x: 40, y: 40, width: 90, height: 36 }] };
  assert.deepEqual(hit.stage(relation, "relation", { x: 100, y: 70, tx: 20, ty: 10, s: 1 }), { kind: "node", id: "r1" });
});

function component(file) {
  let definition;
  global.Component = (value) => {
    definition = value;
  };
  delete require.cache[path.join(root, file)];
  require(path.join(root, file));
  const events = [];
  const self = {
    data: structuredClone(definition.data),
    setData(patch) {
      Object.assign(this.data, patch);
    },
    triggerEvent: (name, detail) => events.push([name, detail]),
    ...definition.methods,
  };
  return { self, events };
}

test("sky: the WXS tap fires once; the native tap of the same touch is dropped; press marks the card", () => {
  const { self, events } = component("pages/map/components/sky/index.js");
  self.data.layout = stars.starLayout(chapter(), { nextId: "b" });
  const b = self.data.layout.cards.find((c) => c.id === "b");
  self.gesturePress(at(b.left + 40, b.top + b.height - 24, 1));
  assert.deepEqual([self.data.pressed, self.data.pressAct], ["b", "practice"]);
  self.gestureTap(at(b.left + 40, b.top + b.height - 24, 1));
  assert.equal(self.data.pressed, "");
  self.practiceTap({ currentTarget: { dataset: { id: "b" } } });
  self.starTap({ currentTarget: { dataset: { id: "b" } } });
  assert.deepEqual(events, [["practice", { id: "b" }]]);
  // Later, the native tap alone still works (the fallback).
  self.lastTapAt -= hit.WINDOW + 1;
  self.starTap({ currentTarget: { dataset: { id: "d" } } });
  assert.deepEqual(events.at(-1), ["node", { id: "d" }]);
  // Right after a drag the native tap is still ignored.
  self.lastTapAt -= hit.WINDOW + 1;
  self.gestureSettle({ tx: 0, ty: 0, s: 1, moved: true });
  self.starTap({ currentTarget: { dataset: { id: "a" } } });
  assert.notDeepEqual(events.at(-1), ["node", { id: "a" }]);
});

test("stage (landscape): the same tap decision; group detail keeps its flag", () => {
  const { self, events } = component("pages/map/components/stage/index.js");
  self.data.view = "task";
  self.data.layout = { nodes: [{ id: "g1", baseX: 24, shiftX: 0, y: 190, width: 178, height: 92, group: true }], sides: [] };
  self.gestureTap({ x: 60, y: 220, tx: 0, ty: 0, s: 1 });
  self.groupTap({ currentTarget: { dataset: { id: "g1", group: true } } });
  assert.deepEqual(events.filter((e) => e[0] !== "dragging"), [["group", { id: "g1", group: true }]]);
});

test("templates: every near card has 练一题, presses show at once, both stages use the WXS tap", () => {
  const sky = read("pages/map/components/sky/index.wxml");
  const foot = sky.slice(sky.indexOf('<view class="kc-foot">'));
  const go = foot.slice(0, foot.indexOf("</text>"));
  // Not only 下一步's card: no wx:if on the button.
  assert.match(go, /<text class="kc-go /);
  assert.doesNotMatch(go, /wx:if/);
  assert.match(go, /data-act="practice"/);
  assert.match(go, /catchtap="practiceTap"/);
  assert.match(go, /hover-class="go-press" hover-start-time="0"/);
  assert.match(go, /hover-stop-propagation/);
  assert.match(sky, /class="kc [^"]*pressing[^"]*"[^>]*hover-class="kc-press" hover-start-time="0"/);
  assert.match(sky, /class="sn [^"]*pressing[^"]*"[^>]*hover-class="sn-press" hover-start-time="0"/);
  const css = read("pages/map/components/sky/index.wxss");
  assert.match(css, /\.kc\.kc-press, \.kc\.pressing \{/);
  assert.match(css, /\.kc-go\.go-press, \.kc-go\.pressing \{/);
  const stage = read("pages/map/components/stage/index.wxml");
  assert.equal((stage.match(/hover-class="node-press" hover-start-time="0"/g) || []).length, 5);
  // The landscape page draws map-stage, which runs the same gesture.wxs.
  assert.match(read("pages/map/landscape/index.wxml"), /<map-stage /);
  assert.match(stage, /<wxs module="gesture" src="\.\/gesture\.wxs" \/>/);
  assert.match(sky, /<wxs module="gesture" src="\.\.\/stage\/gesture\.wxs" \/>/);
  // Meteors: CSS behind the map, nothing over it takes touches.
  const page = read("pages/map/index.wxml");
  assert.doesNotMatch(page, /<canvas/);
  assert.match(read("pages/map/index.wxss"), /\.sky-back \{ position:absolute; z-index:0;[^}]*pointer-events:none;/);
});

// The page: 练一题 on a card whose questions are not out yet opens the sheet.
function put(file, exports) {
  const full = path.join(root, file);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}
function loadMap() {
  let definition;
  const navigation = [];
  global.Page = (value) => {
    definition = value;
  };
  global.getApp = () => ({ globalData: {} });
  global.wx = {
    getStorageSync: () => undefined,
    setStorageSync() {},
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, statusBarHeight: 24 }),
    getMenuButtonBoundingClientRect: () => ({ top: 28, height: 32 }),
    showModal() {},
    showToast() {},
    navigateTo: (value) => navigation.push(value.url),
  };
  put("utils/api.js", { get: () => Promise.resolve({ chapters: [chapter()] }), post: () => Promise.resolve({}), put: () => Promise.resolve({}), needsConsent: () => false });
  put("utils/auth.js", { login: () => Promise.resolve({ id: "u1" }), getUser: () => ({ id: "u1" }), hasConsent: () => true });
  put("utils/gate.js", { state: () => "ok", check: () => true, ask() {} });
  put("utils/request.js", { request: () => Promise.resolve({ data: { chapters: [chapter()] } }) });
  put("utils/learn.js", {
    ROUTES: { learn: "pages/learn/index", point: "pages/point/index", ranks: "pages/ranks/index", knowledge: "pages/knowledge/index" },
    backTo: (route, id) => navigation.push(`${route}:${id}`),
    navPlan: (pages, route) => ({ kind: "navigateTo", url: `/${route}` }),
  });
  delete require.cache[path.join(root, "utils/chat-entry.js")];
  delete require.cache[path.join(root, "pages/map/index.js")];
  require(path.join(root, "pages/map/index.js"));
  definition.data = structuredClone(definition.data);
  definition.setData = (patch) => Object.assign(definition.data, patch);
  definition.onLoad({});
  return { page: definition, navigation };
}

test("page: 练一题 practises when the questions are ready, else opens the detail page (V4.1 G4)", async () => {
  const { page, navigation } = loadMap();
  page.onShow();
  await page.loadRequest;
  page.practiceTap({ detail: { id: "b" } });
  assert.deepEqual(navigation, ["pages/point/index:b"]);
  page.practiceTap({ detail: { id: "c" } });
  assert.deepEqual(navigation, ["pages/point/index:b", "pages/knowledge/index:c"]);
  assert.equal(page.data.panel, undefined, "no sheet on the map any more");
});

test("review fixes: stray-and-return is not a tap; a rejected touch blocks the native fallback; the touched star wins", () => {
  // Out past 10px and back to the start within 350ms: still not a tap.
  const g = gesture();
  g.wxs.motionChanged("0,0,1,0", "", g.owner);
  g.wxs.start(g.ev("touchstart", [g.t(100, 200)], [g.t(100, 200)], 0), g.owner);
  g.wxs.move(g.ev("touchmove", [g.t(100, 225)], [g.t(100, 225)], 60), g.owner);
  g.wxs.move(g.ev("touchmove", [g.t(101, 201)], [g.t(101, 201)], 120), g.owner);
  g.wxs.end(g.ev("touchend", [], [g.t(101, 201)], 200), g.owner);
  assert.equal(named(g.calls, "gestureTap").length, 0);
  assert.equal(named(g.calls, "gestureSettle")[0].tap, false);
  // A long press reports tap:false, and the native tap after it is ignored.
  const { self, events } = component("pages/map/components/sky/index.js");
  self.gestureSettle({ tx: 0, ty: 0, s: 1, moved: false, tap: false });
  self.starTap({ currentTarget: { dataset: { id: "a" } } });
  assert.deepEqual(events.filter((e) => e[0] === "node"), []);
  // A real tap leaves the fallback open (deduped by hit.once instead).
  self.gestureSettle({ tx: 0, ty: 0, s: 1, moved: false, tap: true });
  self.starTap({ currentTarget: { dataset: { id: "a" } } });
  assert.deepEqual(events.filter((e) => e[0] === "node"), [["node", { id: "a" }]]);
  // Far, zoomed right out: the finger on d's name opens d even when another
  // dot is nearer by the widened reach.
  const layout = stars.starLayout(chapter(), { nextId: "b" });
  const s = stars.MIN;
  const spot = { x: 60 * stars.S * s, y: 160 * stars.S * s, tx: 0, ty: 0, s, id: "d" };
  assert.deepEqual(hit.sky(layout, spot), { id: "d", act: "node" });
  assert.deepEqual(hit.sky(layout, { ...spot, id: "" }).id, "b", "without a dataset the nearest dot");
});
