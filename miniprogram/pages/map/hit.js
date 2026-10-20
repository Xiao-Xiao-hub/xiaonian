// What a tap on the map lands on. The WXS gesture (components/stage/
// gesture.wxs) decides that a touch was a tap (one finger, moved at most
// about 10px, down at most about 350ms) and sends the spot:
//
//   { x, y }      where, in px from the viewport's top left
//   { tx, ty, s } the plane's pan and zoom at that moment
//   { id, act }   the dataset of the element the finger went down on, if any
//
// The geometry below is the same the templates draw, so a tap on a card's
// title, formula or key (children without a dataset) still finds the card.
const { S, SPLIT } = require("./stars");

// 练一题 on a near card (components/sky.kc-foot /.kc-go): 11px from the
// left, 10px from the bottom, 28px tall, about 70px wide; 6px of slack.
const GO = { left: 11, bottom: 10, width: 70, height: 28, slack: 6 };
// A star: the 14px dot (.sn.dot) is at (x, y) in the far layer; anything
// within this many screen px of it counts. The name is 12px text under the
// dot, or left of it for.lf.
const DOT_REACH = 22;
const NAME = { font: 12, gap: 6, half: 7, line: 16 };

function plane(spot) {
  const s = Number(spot && spot.s) || 0;
  if (!s) return null;
  return { x: (Number(spot.x) - Number(spot.tx || 0)) / s, y: (Number(spot.y) - Number(spot.ty || 0)) / s, s };
}
function inside(px, py, left, top, width, height) {
  return px >= left && px <= left + width && py >= top && py <= top + height;
}
function nameWidth(star) {
  return String(star.name || "").length * NAME.font + (star.mark ? NAME.font + 2 : 0);
}

// Near: the card under the spot, and whether it is on 练一题.
function cardAt(layout, p) {
  const cards = (layout && layout.cards) || [];
  // Later cards are drawn on top.
  for (let i = cards.length - 1; i >= 0; i -= 1) {
    const c = cards[i];
    if (!inside(p.x, p.y, c.left, c.top, c.width, c.height)) continue;
    const go = inside(
      p.x,
      p.y,
      c.left + GO.left - GO.slack,
      c.top + c.height - GO.bottom - GO.height - GO.slack,
      GO.width + GO.slack * 2,
      GO.height + GO.slack * 2,
    );
    return { id: c.id, act: go ? "practice" : "node" };
  }
  return null;
}
// Far: the nearest star whose dot or name is under the spot.
function starAt(layout, p) {
  const unit = p.s * S; // screen px per far-layer px
  const fx = p.x / S,
    fy = p.y / S,
    reach = DOT_REACH / unit;
  let best = null,
    bestDistance = Infinity;
  ((layout && layout.stars) || []).forEach((star) => {
    const dx = fx - star.x,
      dy = fy - star.y;
    let distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > reach) {
      const width = nameWidth(star);
      const onName = star.left
        ? dx <= -NAME.half && dx >= -(NAME.half + NAME.gap + width) && Math.abs(dy) <= NAME.line / 2 + 2
        : Math.abs(dx) <= width / 2 + 4 && dy >= 0 && dy <= NAME.half + NAME.gap + NAME.line + 4;
      if (!onName) return;
      distance = reach + Math.abs(dy); // after any dot
    }
    if (distance < bestDistance) {
      best = star;
      bestDistance = distance;
    }
  });
  return best ? { id: best.id, act: "node" } : null;
}
// The star map (components/sky): { id, act: "node" | "practice" } or null.
function sky(layout, spot) {
  const p = plane(spot);
  const found = p ? (p.s >= SPLIT ? cardAt(layout, p) : starAt(layout, p)) : null;
  const id = spot && spot.id ? String(spot.id) : "";
  // The element the finger went down on wins (练一题 itself, a star's dot or
  // name, a card); the geometry adds 练一题's slack on that card, and covers
  // touches on children without a dataset or just beside a small star.
  if (id && spot.act === "practice") return { id, act: "practice" };
  if (id) return found && found.id === id ? found : { id, act: "node" };
  return found;
}

// The landscape route / relation map (components/stage):
// { kind: "node", id } or { kind: "group", id, group } or null.
const INNER = { main: 76, branch: 66, border: 2 };
function stage(layout, view, spot) {
  const p = plane(spot);
  if (!p || !layout) return null;
  if (view !== "task") {
    const nodes = layout.nodes || [];
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const n = nodes[i];
      if (inside(p.x, p.y, n.x, n.y, n.width, n.height)) return { kind: "node", id: n.id };
    }
    return spot.id ? { kind: "node", id: String(spot.id) } : null;
  }
  // Branches are drawn after the main line, so they are checked first.
  const boxes = []
    .concat(((layout.nodes || []).map((n) => ({ item: n, x: Number(n.baseX || 0) + Number(n.shiftX || 0), branch: false }))))
    .concat((layout.sides || []).map((n) => ({ item: n, x: Number(n.x || 0), branch: true })))
    .reverse();
  for (const box of boxes) {
    const n = box.item;
    if (!inside(p.x, p.y, box.x, n.y, n.width, n.height)) continue;
    if (n.expanded) {
      const height = box.branch ? INNER.branch : INNER.main;
      const member = (n.memberViews || []).find((m) =>
        // Zoomed in, the layout gives each card its height (layout.js detailLayout).
        inside(p.x, p.y, box.x + INNER.border + m.x, n.y + INNER.border + m.y, m.width, Number(m.height) || height),
      );
      if (member) return { kind: "node", id: member.id };
    }
    return { kind: "group", id: n.id, group: n.group };
  }
  return null;
}

// One tap, one action: the WXS tap and the native tap (kept as a fallback)
// both come here; the second within WINDOW ms is dropped (utils/tap.js).
const { once, WINDOW } = require("../../utils/tap");

module.exports = { sky, stage, once, GO, WINDOW };
