"use strict";
// V4.1 G4 follow-up (user feedback #8): zoomed in on the landscape map every
// group lays its points out as cards with name, first formula and two keys.
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

const point = (id, extra = {}) => ({
  id,
  name: `点${id}`,
  state: "none",
  formulaBlocks: [[{ t: "p", c: [{ t: "math", id: `f${id}`, w: 8, h: 1 }] }]],
  keyBlocks: [[{ t: "p", c: [{ t: "text", v: "一" }] }], [{ t: "p", c: [{ t: "text", v: "二" }] }], [{ t: "p", c: [{ t: "text", v: "三" }] }]],
  ...extra,
});
const CHAPTER = {
  id: "limit",
  points: [
    point("a"),
    point("b", { prereqs: ["a"] }),
    point("c", { prereqs: ["b"] }),
    point("d"),
    point("e", { line: "side", side: "up" }),
    point("f", { line: "side", side: "exam" }),
    point("g", { line: "side", side: "exam" }),
  ],
  nodes: [
    { id: "g1", name: "组一", members: ["a", "b", "c"] },
    { id: "n2", members: ["d"] },
  ],
  sides: [
    { parent: "a", members: ["e"] },
    { parent: "d", members: ["f", "g"] },
  ],
};
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("zoomed in: every group is open in one row of 320x168 cards; nothing overlaps", () => {
  const { taskLayout } = require(fresh("pages/map/layout.js"));
  const compact = taskLayout(CHAPTER, "");
  assert.equal(compact.nodes[0].expanded, false, "below the line nothing changes");
  assert.equal(compact.nodes[0].width, 178);

  const z = taskLayout(CHAPTER, "", true);
  const [group, single] = z.nodes;
  assert.equal(group.expanded, true);
  assert.equal(group.fixed, true);
  assert.deepEqual(group.memberViews.map((m) => [m.id, m.y, m.width, m.height]), [
    ["a", 42, 320, 168],
    ["b", 42, 320, 168],
    ["c", 42, 320, 168],
  ]);
  assert.ok(group.memberViews[2].x + 320 <= group.width, "the box holds its cards");
  assert.equal(group.innerEdges.length, 2);
  assert.equal(single.expanded, false);
  assert.equal(single.width, 320);
  assert.equal(single.height, 168);
  assert.equal(single.y + single.height / 2, group.y + group.height / 2, "one main line through the middle");

  const boxes = [...z.nodes, ...z.sides];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i], boxes[j]), `${boxes[i].id} / ${boxes[j].id}`);
  assert.equal(z.sides[1].expanded, true);
  assert.ok(z.sides.every((s) => s.y >= group.y + group.height + 40), "加餐 under the main line");
  assert.ok(boxes.every((b) => b.x + b.width <= z.width && b.y + b.height <= z.height));
});

test("zoomed in: a tap anywhere on a card opens that point, below the old 76px too", () => {
  global.wx = global.wx || {};
  const { taskLayout } = require(fresh("pages/map/layout.js"));
  const hit = require(fresh("pages/map/hit.js"));
  const z = taskLayout(CHAPTER, "", true);
  const group = z.nodes[0],
    b = group.memberViews[1];
  const at = (x, y) => ({ x, y, tx: 0, ty: 0, s: 1 });
  assert.deepEqual(hit.stage(z, "task", at(group.x + 2 + b.x + 100, group.y + 2 + b.y + 150)), { kind: "node", id: "b" });
  assert.deepEqual(hit.stage(z, "task", at(group.x + 30, group.y + 10)), { kind: "group", id: "g1", group: true });
  const single = z.nodes[1];
  assert.deepEqual(hit.stage(z, "task", at(single.x + 10, single.y + 160)), { kind: "group", id: "n2", group: false });
});

test("anchorMotion keeps the box in the middle of the screen in the middle", () => {
  const { taskLayout, anchorMotion } = require(fresh("pages/map/layout.js"));
  const before = taskLayout(CHAPTER, ""),
    after = taskLayout(CHAPTER, "", true);
  const view = { width: 800, height: 300 };
  const d = before.nodes[1]; // the single point d
  const s = 0.9;
  // d's centre in the middle of the screen.
  const motion = { tx: 400 - (d.x + d.width / 2) * s, ty: 150 - (d.y + d.height / 2) * s, s };
  const at = anchorMotion(before, after, motion, view);
  const d2 = after.nodes[1];
  assert.equal(at.s, s);
  assert.ok(Math.abs(at.tx + (d2.x + d2.width / 2) * s - 400) <= 1);
  assert.ok(Math.abs(at.ty + (d2.y + d2.height / 2) * s - 150) <= 1);
  assert.deepEqual(anchorMotion({ nodes: [] }, after, motion, view), { ...motion }, "nothing to hold on to");
});

function landscape() {
  const log = { nav: [] };
  global.getApp = () => ({ globalData: {} });
  global.wx = { navigateBack() {} };
  put("utils/api.js", { get: () => Promise.resolve({}), needsConsent: () => false });
  put("utils/auth.js", { getUser: () => ({ id: "u" }), hasConsent: () => true, login: () => Promise.resolve({}) });
  put("utils/gate.js", { state: () => "ok", check: () => true });
  put("utils/learn.js", {
    backTo: (route, id) => log.nav.push(`${route}:${id}`),
    ROUTES: { knowledge: "pages/knowledge/index" },
  });
  fresh("pages/map/layout.js");
  let def;
  global.Page = (value) => (def = value);
  require(fresh("pages/map/landscape/index.js"));
  def.data = structuredClone(def.data);
  def.setData = function (patch) {
    Object.assign(this.data, patch);
  };
  def.alive = true;
  return { p: def, log };
}

test("zoomed in: a card is as wide as its formula needs at 20px, up to 720", () => {
  const { taskLayout } = require(fresh("pages/map/layout.js"));
  const wide = (w) => [[{ t: "p", c: [{ t: "text", v: "设" }, { t: "math", id: "w", w, h: 1 }] }]];
  const chapter = {
    ...CHAPTER,
    points: CHAPTER.points.map((p) =>
      p.id === "b" ? { ...p, formulaBlocks: wide(20) } : p.id === "d" ? { ...p, formulaBlocks: wide(60) } : p,
    ),
  };
  const z = taskLayout(chapter, "", true);
  const [a, b, c] = z.nodes[0].memberViews;
  assert.equal(a.width, 320);
  assert.equal(b.width, 20 * 20 + 34);
  assert.equal(c.x, b.x + b.width + 22, "the next card starts after the wide one");
  assert.equal(z.nodes[0].width, 14 + c.x + c.width);
  assert.equal(z.nodes[1].width, 720, "a very long formula still shrinks to fit");
});

test("anchorMotion: on an open group's card, that same card stays in the middle", () => {
  const { taskLayout, anchorMotion } = require(fresh("pages/map/layout.js"));
  const before = taskLayout(CHAPTER, "g1"),
    after = taskLayout(CHAPTER, "g1", true);
  const g = before.nodes[0],
    c = g.memberViews.find((m) => m.id === "c");
  const s = 0.9,
    view = { width: 800, height: 300 };
  // A spot a quarter into c's card in the middle of the screen.
  const px = g.x + 2 + c.x + c.width / 4,
    py = g.y + 2 + c.y + 76 / 4;
  const at = anchorMotion(before, after, { tx: 400 - px * s, ty: 150 - py * s, s }, view);
  const g2 = after.nodes[0],
    c2 = g2.memberViews.find((m) => m.id === "c");
  assert.ok(Math.abs(at.tx + (g2.x + 2 + c2.x + c2.width / 4) * s - 400) <= 1);
  assert.ok(Math.abs(at.ty + (g2.y + 2 + c2.y + c2.height / 4) * s - 150) <= 1);
});

test("anchorMotion: where a 加餐 box covers a group, the box on top wins, as for a tap", () => {
  const { anchorMotion } = require(fresh("pages/map/layout.js"));
  const group = { id: "g", x: 0, y: 0, width: 300, height: 200, expanded: true, group: true, memberViews: [{ id: "a", x: 10, y: 40, width: 132 }] };
  const side = (x, y, width, height) => ({ id: "s", x, y, width, height, group: false, members: [{ id: "e" }], sideText: "加餐 · 拔高" });
  const before = { nodes: [group], sides: [side(0, 50, 200, 76)] };
  const after = { nodes: [{ ...group, memberViews: [{ id: "a", x: 14, y: 42, width: 320, height: 168 }] }], sides: [side(500, 400, 320, 168)] };
  // The middle of an 800x300 screen at s 1 is the plane spot (50, 80): on a and on s.
  const at = anchorMotion(before, after, { tx: 350, ty: 70, s: 1 }, { width: 800, height: 300 });
  assert.deepEqual(at, { tx: 400 - (500 + 0.25 * 320), ty: 150 - Math.round(400 + (30 / 76) * 168), s: 1 });
});

test("landscape: crossing .9 swaps in the open layout and keeps the view on the same box", () => {
  const { taskLayout } = require(fresh("pages/map/layout.js"));
  const { p, log } = landscape();
  p.stageReady({ detail: { width: 800, height: 300 } });
  p.data.chapter = CHAPTER;
  p.data.layout = taskLayout(CHAPTER, "");
  const d = p.data.layout.nodes[1];
  p.stageSettle({ detail: { tx: 400 - (d.x + 73) * 0.95, ty: 150 - (d.y + 46) * 0.95, s: 0.95 } });
  assert.equal(p.data.detail, true);
  assert.equal(p.data.layout.nodes[0].fixed, true);
  const [tx, ty, s] = p.data.motion.split(",").map(Number);
  const d2 = p.data.layout.nodes[1];
  assert.equal(s, 0.95);
  assert.ok(Math.abs(tx + (d2.x + 160) * s - 400) <= 1, p.data.motion);
  assert.ok(Math.abs(ty + (d2.y + 84) * s - 150) <= 1, p.data.motion);

  // The head of an open group does nothing; a card opens the detail page.
  p.groupTap({ detail: { id: "g1", group: true } });
  assert.equal(p.data.expandedId, "");
  p.groupTap({ detail: { id: "n2", group: false } });
  p.nodeTap({ detail: { id: "b" } });
  assert.deepEqual(log.nav, ["pages/knowledge/index:d", "pages/knowledge/index:b"]);

  // Back under the line: the compact boxes again.
  p.stageSettle({ detail: { tx: 0, ty: 0, s: 0.8 } });
  assert.equal(p.data.detail, false);
  assert.equal(p.data.layout.nodes[0].expanded, false);
  p.stageSettle({ detail: { tx: 5, ty: 6, s: 0.7 } });
  assert.equal(p.data.motion.split(",").slice(0, 3).join(","), "5,6,0.7", "no swap, just the motion");
});

test("zoomed-in templates: no 收起 on an open-for-good group, two keys, plain text", () => {
  const wxml = read("pages/map/components/stage/index.wxml");
  assert.equal((wxml.match(/<text wx:if="\{\{!item.fixed\}\}">收起<\/text>/g) || []).length, 2);
  assert.match(wxml, /<template name="lx">/);
  assert.match(wxml, /p\.keyBlocks\[1\]/);
  assert.match(wxml, /height:'\+p\.height\+'px'/);
  assert.match(read("pages/map/landscape/index.wxml"), /bindready="stageReady"/);
  const css = read("pages/map/landscape/index.wxss");
  assert.match(css, /\.lx-key \.rich \.mk \{[^}]*background:none !important[^}]*text-decoration:none !important/);
  assert.match(css, /\.lx-fx \.rich \{ font-size:20px/);
});
