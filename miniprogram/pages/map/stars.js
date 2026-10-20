// 星图布局：服务端提供布局数据。The server
// sends each star's place (pos, in the far view's px on a 375-wide phone), each
// chapter's canvas and its lines already routed; this file only lays them out
// and colours them by the student's state.
//
// One plane holds both zoom levels in near-view px (far px × S). The far layer
// is drawn at far size and scaled up by S inside the plane, so at a plane scale
// of 1/S stars and names show at their natural size; the near layer puts a
// knowledge card on every star at natural size, seen at a plane scale of 1.
// Zooming scales both around the same point, so a card lands on its star.
const { markBlocks } = require("../../utils/blocks");
const { lookOf } = require("../../utils/point-look");

const S = 2.3;
const FAR = 1 / S;
const NEAR = 1;
// Below this plane scale the far layer (stars) shows, at or above it the cards.
// The stage gesture (components/stage/gesture.wxs) switches its class here too.
const SPLIT = 0.66;
// The smallest plane scale: a tall chapter (680 far px) still fits a short
// phone in the far view (fitView below). The far view itself stays at FAR or less.
const MIN = 0.2;
const CARD = { width: 168, height: 132, nextHeight: 150, gap: 8 };
const STAR_R = { main: 7, side: 4.5 };

function tier(scale) {
  return Number(scale) < SPLIT ? "far" : "near";
}
function clamp(value) {
  return Math.max(MIN, Math.min(1, Number(value) || FAR));
}
// ★ 重点 / ◆ 难点 before a main point's name; ◆ wins, side points get none.
function nameMark(point) {
  if (point.line === "side") return "";
  return point.hard ? "◆" : point.key ? "★" : "";
}
function idOf(value) {
  return typeof value === "string" ? value : value && value.id;
}
// The star's look is its state (utils/point-look.js, one meaning on every
// page): ok 做对了, due 该复习, pend 再试试 / 标了会 / 应该会, stuck 卡住了,
// practice 练过, seen 看过, none 没碰过, side 支线没碰过 (dashed ring).
// 下一步 is a mark on top of the state (`next` on the star and the card).
function starState(point) {
  if (!point) return "none";
  const look = lookOf(point);
  if (look.key === "none" && point.line === "side") return "side";
  return look.cls;
}
function starText(point) {
  return lookOf(point).text;
}
// A narrow card's footer : a smaller 练一题; every state is three
// characters at most.
const NARROW = 150;
// Lines are blue only. 主线: glow into 下一步, lit once the student has
// touched the point it leads to, dim before that. 拔高 (up) and 选学 (opt)
// stay pale whatever the state.
function lineClass(line, stateById, nextId) {
  if (line.type === "up" || line.type === "opt") return line.type;
  if (nextId && line.to === nextId) return "glow";
  const to = stateById[line.to];
  return to && to !== "none" && to !== "side" ? "lit" : "dim";
}
// A polyline as rotated bars (no SVG in WXML).
function segments(points, scale, cls, key) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i],
      b = points[i + 1],
      dx = (b.x - a.x) * scale,
      dy = (b.y - a.y) * scale;
    out.push({
      id: `${key}-${i}`,
      cls,
      x: Math.round(a.x * scale * 10) / 10,
      y: Math.round(a.y * scale * 10) / 10,
      len: Math.round(Math.sqrt(dx * dx + dy * dy) * 10) / 10,
      angle: Math.round(((Math.atan2(dy, dx) * 180) / Math.PI) * 100) / 100,
    });
  }
  return out;
}
// Cards keep clear of their neighbours: narrower beside a star on the same
// row, shorter (name and formula only) above a star close below.
function cardBox(point, all, next) {
  const x = point.pos.x,
    y = point.pos.y;
  let width = CARD.width;
  all.forEach((other) => {
    if (other === point) return;
    const dx = Math.abs(other.pos.x - x) * S,
      dy = Math.abs(other.pos.y - y) * S;
    // A star in the same column is handled by the height below.
    if (dx >= 60 && dy < CARD.height && dx < CARD.width + CARD.gap)
      width = Math.min(width, dx - CARD.gap);
  });
  width = Math.max(120, width);
  let height = next ? CARD.nextHeight : CARD.height;
  all.forEach((other) => {
    if (other === point) return;
    const dx = Math.abs(other.pos.x - x) * S,
      dy = (other.pos.y - y) * S;
    if (dy > 0 && dx < width) height = Math.min(height, dy - CARD.gap);
  });
  height = Math.max(72, height);
  return {
    left: Math.round(x * S - width / 2),
    top: Math.round(y * S - 20),
    width: Math.round(width),
    height: Math.round(height),
    compact: height < 118,
    // Too narrow for 练一题, the state and 我的卡 in one row (see NARROW).
    narrow: width < NARROW,
    // Too short for the formula row: name and footer only.
    tight: height < 100,
  };
}
// What a card shows: the first formula and the first key, as rendered blocks
// when the server sent them, otherwise as text without the mark syntax.
function cardContent(point, width) {
  const formula = (point.formulaBlocks && point.formulaBlocks[0]) || null;
  const key = (point.keyBlocks && point.keyBlocks[0]) || null;
  // A long formula squeezed into a narrow map card becomes unreadable.
  // Keep the full formula on the existing detail page, with an explicit entry.
  const math = (formula || []).flatMap((block) => block.t === "math" ? [block] : (block.c || []).filter((part) => part.t === "math"));
  const formulaLong = math.some((part) => Number(part.w) * 12 > width - 38);
  return {
    formula,
    formulaLong,
    formulaText: formula ? "" : ((point.formulas || [])[0] || ""),
    key: key || markBlocks(String((point.keys || [])[0] || "").replace(/\$/g, "")),
  };
}
// Points linked to `id` before and after it, inside the chapter: a point
// opened in the sheet keeps only these lit.
function chain(chapter, id) {
  const keep = new Set([id]);
  (chapter.points || []).forEach((p) => {
    if (p.id === id) (p.prereqs || []).forEach((v) => keep.add(idOf(v)));
    if ((p.prereqs || []).some((v) => idOf(v) === id)) keep.add(p.id);
  });
  return keep;
}

// "1.10" > "1.9": a section as [chapter, section] numbers.
function sectionOrder(value) {
  const parts = String(value || "").split(".");
  return (Number(parts[0]) || 0) * 1000 + (Number(parts[1]) || 0);
}
// The 课上 flag (40-map.html.tflag) goes beside the last point the teacher has
// reached in this chapter: the latest taught section, lowest on the map, main
// line first. None for 还没开讲 / 全讲完了 / not set, or when the chapter is
// wholly before or after the taught section.
function taughtFlag(points, taughtTo) {
  if (!taughtTo || taughtTo === "all" || taughtTo === "none") return null;
  const to = sectionOrder(taughtTo);
  const taught = points.filter((p) => p.section && sectionOrder(p.section) <= to);
  const reached = taught.some((p) => sectionOrder(p.section) === to);
  if (!taught.length || (!reached && taught.length === points.length)) return null;
  const best = taught.reduce((a, b) => {
    const da = sectionOrder(a.section),
      db = sectionOrder(b.section);
    if (da !== db) return db > da ? b : a;
    if (a.pos.y !== b.pos.y) return b.pos.y > a.pos.y ? b : a;
    if ((a.line === "side") !== (b.line === "side")) return a.line === "side" ? b : a;
    return b.pos.x < a.pos.x ? b : a;
  });
  // Right of the star, its middle level with the star (flag 18px tall).
  return { id: best.id, left: best.pos.x + 14, top: best.pos.y - 9 };
}

// options: { nextId, focusId, guest, taughtTo }
function starLayout(chapter, options = {}) {
  const nextId = options.guest ? "" : options.nextId || "";
  const points = (chapter.points || []).filter((p) => p && p.pos);
  const canvas = chapter.canvas || { width: 375, height: 480 };
  const stateById = {},
    textById = {};
  points.forEach((p) => {
    stateById[p.id] = options.guest ? (p.line === "side" ? "side" : "none") : starState(p);
    textById[p.id] = options.guest ? "没碰过" : starText(p);
  });
  const keep = options.focusId ? chain(chapter, options.focusId) : null;
  const stars = points.map((p) => {
    const state = stateById[p.id];
    return {
      id: p.id,
      x: p.pos.x,
      y: p.pos.y,
      left: p.pos.label === "left",
      cls: state,
      next: Boolean(nextId) && p.id === nextId,
      mark: nameMark(p),
      markCls: p.hard ? "h" : "k",
      name: p.short || p.name,
      fade: Boolean(keep && !keep.has(p.id)),
      later: p.taught === false,
      aria: `${p.name}，${textById[p.id]}${nextId && p.id === nextId ? "，下一步" : ""}`,
    };
  });
  const lines = (chapter.lines || []).map((line, index) => ({
    ...line,
    cls: lineClass(line, stateById, nextId),
    fade: Boolean(keep && !(keep.has(line.from) && keep.has(line.to))),
    key: `${line.from}>${line.to}-${index}`,
  }));
  const farLines = [],
    nearLines = [];
  lines.forEach((line) => {
    const cls = `${line.cls}${line.fade ? " fade" : ""}`;
    farLines.push(...segments(line.points || [], 1, cls, `f${line.key}`));
    nearLines.push(...segments(line.points || [], S, cls, `n${line.key}`));
  });
  const cards = points.map((p) => {
    const state = stateById[p.id],
      next = Boolean(nextId) && p.id === nextId;
    const box = cardBox(p, points, next);
    return {
      id: p.id,
      ...box,
      cls: state,
      mark: nameMark(p),
      markCls: p.hard ? "h" : "k",
      name: p.short || p.name,
      next,
      stateText: textById[p.id],
      cardCount: Number((p.cards && p.cards.count) || 0),
      ready: Boolean(p.ready),
      fade: Boolean(keep && !keep.has(p.id)),
      ...cardContent(p, box.width),
    };
  });
  return {
    width: Math.round(canvas.width * S),
    height: Math.round(canvas.height * S),
    farWidth: canvas.width,
    farHeight: canvas.height,
    stars,
    flag: options.guest ? null : taughtFlag(points, options.taughtTo),
    farLines,
    nearLines,
    cards,
  };
}

// Pan and zoom that put a star at the middle of the view (or of its top third
// while the detail sheet is open), clamped so the map stays on screen.
function focusOn(pos, viewport, scale, panel) {
  const s = clamp(scale);
  const width = (viewport && viewport.width) || 375,
    height = (viewport && viewport.height) || 560;
  const visible = panel ? Math.max(120, height * 0.34) : height;
  return {
    s,
    tx: Math.round(width / 2 - pos.x * S * s),
    ty: Math.round(visible / 2 - pos.y * S * s),
  };
}
// The opening view: 下一步 in the middle when there is one, else the top of
// the chapter, centred across when it fits.
function openingView(layout, nextPos, viewport, scale) {
  const s = clamp(scale);
  if (nextPos) return focusOn(nextPos, viewport, s, false);
  const width = (viewport && viewport.width) || 375;
  const planeWidth = layout.width * s;
  return {
    s,
    tx: Math.round(planeWidth <= width ? (width - planeWidth) / 2 : 0),
    ty: 0,
  };
}
// The far view of a whole chapter: as large as FAR at most, small enough for
// the canvas to fit the width and the visible height (above the 下一步 card),
// centred in both.
function fitView(layout, viewport, visible) {
  const width = (viewport && viewport.width) || 375,
    height = visible || (viewport && viewport.height) || 560;
  const s = Math.max(
    MIN,
    Math.min(FAR, width / (layout.width || 1), height / (layout.height || 1)),
  );
  return {
    s,
    tx: Math.round((width - layout.width * s) / 2),
    ty: Math.round(Math.max(0, (height - layout.height * s) / 2)),
  };
}
// Zoom to the other level around the middle of the view.
function zoomTo(motion, target, viewport) {
  const s = clamp(target),
    old = clamp(motion.s);
  const cx = ((viewport && viewport.width) || 375) / 2,
    cy = ((viewport && viewport.height) || 560) / 2;
  return {
    s,
    tx: Math.round(cx - ((cx - motion.tx) * s) / old),
    ty: Math.round(cy - ((cy - motion.ty) * s) / old),
  };
}
// The "下一步" capsule when the next star is off screen.
function edgeNext(pos, motion, viewport, margin = 24) {
  if (!pos) return null;
  const width = (viewport && viewport.width) || 375,
    height = (viewport && viewport.height) || 560;
  const x = pos.x * S * motion.s + motion.tx,
    y = pos.y * S * motion.s + motion.ty;
  if (x >= margin && x <= width - margin && y >= margin && y <= height - margin)
    return null;
  const dx = x - width / 2,
    dy = y - height / 2;
  const across = Math.abs(dx) * height >= Math.abs(dy) * width;
  const arrow = across ? (dx > 0 ? "→" : "←") : dy > 0 ? "↓" : "↑";
  const pill = { width: 96, height: 34, gap: 12 };
  return {
    left: Math.round(
      across
        ? dx > 0
          ? width - pill.gap - pill.width
          : pill.gap
        : width / 2 - pill.width / 2,
    ),
    top: Math.round(across || dy > 0 ? height - pill.gap - pill.height : pill.gap),
    text: arrow === "←" || arrow === "↑" ? `${arrow} 下一步` : `下一步 ${arrow}`,
  };
}

module.exports = {
  S,
  FAR,
  NEAR,
  SPLIT,
  MIN,
  STAR_R,
  tier,
  clamp,
  nameMark,
  starState,
  lineClass,
  segments,
  cardBox,
  chain,
  sectionOrder,
  taughtFlag,
  starLayout,
  fitView,
  focusOn,
  openingView,
  zoomTo,
  edgeNext,
};
