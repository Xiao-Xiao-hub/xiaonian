const { lookOf } = require("../../utils/point-look");
// The node's look : utils/point-look.js, the same meaning as the star
// map, with an icon for the landscape's nodes.
const ICON = { ok: "✓", due: "✓", stuck: "✕", pend: "○" };
const CLS = { pend: "pending" };
const SIDE = { up: "拔高", exam: "考研", extra: "选学" };
// 支线 is called 加餐 on screen (v3 §6), with its kind after it.
function sideLabel(side) {
  return `加餐 · ${SIDE[side] || SIDE.up}`;
}
// One colour per node (v3 §5.5): a group is done when every member is, stuck
// when any member is, and amber (还差一点) once anything in it has started.
function groupCls(members) {
  const cls = members.map((p) => p.statusCls);
  if (cls.length && cls.every((c) => c === "ok")) return "ok";
  if (cls.includes("stuck")) return "stuck";
  if (cls.includes("due")) return "due";
  return cls.some((c) => c !== "none") ? "pending" : "none";
}

function status(point) {
  const look = lookOf(point);
  return { icon: ICON[look.cls] || "", cls: CLS[look.cls] || look.cls, text: look.text };
}

function pointView(point, nextId) {
  if (!point) return null;
  const state = status(point);
  return {
    ...point,
    statusIcon: state.icon,
    statusCls: state.cls,
    statusText: state.text,
    sideText: point.line === "side" ? sideLabel(point.side) : "",
    next: Boolean(nextId) && point.id === nextId,
    cardCount: (point.cards && Number(point.cards.count || 0)) || 0,
    missingPrereqs: (point.prereqs || []).filter(
      (item) =>
        !["correct", "due", "self", "inferred"].includes(
          typeof item === "string" ? "none" : item.state,
        ),
    ).length,
    aria: `${point.name}，${point.line === "side" ? sideLabel(point.side) : "核心点"}，${state.text}`,
  };
}

function nodeSummary(node, pointById, nextId) {
  const members = node.members
    .map((id) => pointView(pointById.get(id), nextId))
    .filter(Boolean);
  return {
    ...node,
    members,
    name: node.name || (members[0] && members[0].name) || "知识点",
    group: members.length > 1,
    statusCls: groupCls(members),
    next: members.some((p) => p.next),
    taught: members.some((p) => p.taught !== false),
  };
}

// A group's members laid out by prerequisite depth, left to right: up to
// `card.rows` per column (2 in the compact boxes, 1 zoomed in). Zoomed in a
// card is as wide as its formula needs (card.widthOf), so the columns are too.
const COMPACT_CARD = { width: 132, height: 76, gap: 24, rows: 2 };
function branchMembers(members, card = COMPACT_CARD) {
  const ids = new Set(members.map((point) => point.id)),
    memo = new Map();
  const depthOf = (point, trail = new Set()) => {
    if (memo.has(point.id)) return memo.get(point.id);
    if (trail.has(point.id)) return 0;
    trail.add(point.id);
    const prereqs = (point.prereqs || [])
      .map((item) => (typeof item === "string" ? item : item.id))
      .filter((id) => ids.has(id));
    const depth = prereqs.length
      ? 1 +
        Math.max(
          ...prereqs.map((id) =>
            depthOf(
              members.find((item) => item.id === id),
              new Set(trail),
            ),
          ),
        )
      : 0;
    memo.set(point.id, depth);
    return depth;
  };
  const layers = new Map();
  members.forEach((point) => {
    const depth = depthOf(point);
    layers.set(depth, [...(layers.get(depth) || []), point]);
  });
  let column = 0,
    left = 14;
  const views = [],
    positions = new Map();
  const widthOf = (point) => (card.widthOf ? card.widthOf(point) : card.width);
  [...layers.keys()]
    .sort((a, b) => a - b)
    .forEach((depth) => {
      const layer = layers.get(depth);
      for (let start = 0; start < layer.length; start += card.rows, column++) {
        const slice = layer.slice(start, start + card.rows);
        const width = Math.max(...slice.map(widthOf));
        slice.forEach((point, row) => {
          const view = {
            ...point,
            x: left,
            y: 42 + row * card.height,
            width,
          };
          if (card !== COMPACT_CARD) view.height = card.height;
          views.push(view);
          positions.set(point.id, view);
        });
        left += width + card.gap;
      }
    });
  const edges = [],
    mid = card === COMPACT_CARD ? 34 : card.height / 2;
  views.forEach((point) =>
    (point.prereqs || []).forEach((value) => {
      const id = typeof value === "string" ? value : value.id,
        from = positions.get(id);
      if (!from) return;
      const ax = from.x + from.width,
        ay = from.y + mid,
        bx = point.x,
        by = point.y + mid,
        dx = bx - ax,
        dy = by - ay;
      edges.push({
        id: `${id}-${point.id}`,
        x: ax,
        y: ay,
        width: Math.sqrt(dx * dx + dy * dy),
        angle: (Math.atan2(dy, dx) * 180) / Math.PI,
      });
    }),
  );
  return {
    views,
    edges,
    columns: Math.max(1, column),
    // From the first card's left to the last card's right.
    span: Math.max(0, left - card.gap - 14),
    rows: Math.max(1, ...views.map((point) => (point.y > 42 ? 2 : 1))),
  };
}

// Zoomed in (landscape, s >=.9, V4.1 G4): no box to open. Every group lays
// its points out in one row, and each point is a card big enough for its
// name, first formula and two keys (components/stage.detail), the formula at
// 20px (pages/map/landscape.lx-fx) unless it is wider than WIDEST allows.
const FX_PX = 20;
const WIDEST = 720;
function cardWidth(point) {
  const first = ((point.formulaBlocks || [])[0] || [])[0];
  const math = first && (first.t === "math" ? first : (first.c || []).find((item) => item.t === "math"));
  const need = math ? Math.ceil(Number(math.w || 0) * FX_PX) + 2 * 12 + 4 + 6 : 0;
  return Math.min(WIDEST, Math.max(320, need));
}
const DETAIL_CARD = { width: 320, height: 168, gap: 22, rows: 1, widthOf: cardWidth };
const DETAIL_TOP = 40;
const DETAIL_GAP = 40;
function detailBox(members) {
  if (members.length < 2)
    return { width: cardWidth(members[0] || {}), height: DETAIL_CARD.height, branch: null };
  const branch = branchMembers(members, DETAIL_CARD);
  return {
    width: 28 + branch.span,
    height: 42 + DETAIL_CARD.height + 14,
    branch,
  };
}
function detailLayout(chapter) {
  const points = new Map((chapter.points || []).map((p) => [p.id, p]));
  const nextId = chapter.next && chapter.next.id;
  const boxes = (chapter.nodes || []).map((raw) => {
    const node = nodeSummary(raw, points, nextId);
    return { node, box: detailBox(node.members) };
  });
  const tallest = Math.max(DETAIL_CARD.height, ...boxes.map((b) => b.box.height));
  const line = DETAIL_TOP + tallest / 2;
  let x = 24;
  const nodes = boxes.map(({ node, box }) => {
    const out = {
      ...node,
      expanded: Boolean(box.branch),
      fixed: true,
      x,
      baseX: x,
      shiftX: 0,
      y: line - box.height / 2,
      width: box.width,
      height: box.height,
      memberViews: box.branch ? box.branch.views : [],
      innerEdges: box.branch ? box.branch.edges : [],
    };
    x += box.width + DETAIL_GAP;
    return out;
  });
  const edges = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i],
      b = nodes[i + 1];
    edges.push({ id: `main-${i}`, cls: "main", x: a.x + a.width, y: line, width: b.x - a.x - a.width, angle: 0 });
  }
  const nodeForPoint = new Map();
  nodes.forEach((node) => node.members.forEach((p) => nodeForPoint.set(p.id, node)));
  // The 加餐 boxes in one row under the main line, each as near under its
  // parent as the one before it allows.
  const top = DETAIL_TOP + tallest + 64;
  let right = 0;
  const sides = (chapter.sides || [])
    .map((raw, index) => {
      const parent = nodeForPoint.get(raw.parent);
      const members = raw.members.map((id) => pointView(points.get(id), nextId)).filter(Boolean);
      if (!parent || !members.length) return null;
      const id = `side-${raw.parent}-${index}`;
      const side = members[0].side || "up";
      const box = detailBox(members);
      const sx = Math.max(right + DETAIL_GAP, parent.x + parent.width / 2 - box.width / 2);
      right = sx + box.width;
      const ax = parent.x + parent.width / 2,
        ay = parent.y + parent.height,
        dx = sx + box.width / 2 - ax,
        dy = top - ay;
      edges.push({
        id: `branch-${id}`,
        cls: `branch ${side}`,
        x: ax,
        y: ay,
        width: Math.sqrt(dx * dx + dy * dy),
        angle: (Math.atan2(dy, dx) * 180) / Math.PI,
      });
      return {
        id,
        parent: raw.parent,
        members,
        group: members.length > 1,
        expanded: Boolean(box.branch),
        fixed: true,
        name: members.length > 1 ? members.map((p) => p.short || p.name).join(" · ") : members[0].name,
        x: sx,
        y: top,
        width: box.width,
        height: box.height,
        side,
        sideText: sideLabel(side),
        statusCls: groupCls(members),
        next: members.some((p) => p.next),
        taught: members.some((p) => p.taught !== false),
        memberViews: box.branch ? box.branch.views : [],
        innerEdges: box.branch ? box.branch.edges : [],
      };
    })
    .filter(Boolean);
  return {
    nodes,
    sides,
    edges,
    width: Math.max(760, x + 120, right + 120),
    height: Math.max(560, ...[...nodes, ...sides].map((n) => n.y + n.height + 80)),
  };
}

// Every point card of a layout in plane px: the cards of an open group (inside
// its 2px border, as pages/map/hit.js stage sees them) and the boxes of
// single points. Compact cards without a height are 76px, 66px under 加餐.
// Boxes in drawing order (加餐 over the main line), each with its cards.
function pointCards(layout) {
  const cards = [];
  const boxes = [...((layout && layout.nodes) || []), ...((layout && layout.sides) || [])];
  boxes.forEach((n) => {
    if (n.expanded)
      (n.memberViews || []).forEach((m) =>
        cards.push({
          id: m.id,
          box: n.id,
          x: n.x + 2 + m.x,
          y: n.y + 2 + m.y,
          width: m.width,
          height: Number(m.height) || (n.sideText ? 66 : 76),
        }),
      );
    else if (!n.group && n.members && n.members[0])
      cards.push({ id: n.members[0].id, box: n.id, x: n.x, y: n.y, width: n.width, height: n.height });
  });
  return { boxes, cards };
}
// Where to put the plane after the layout changed under the user: what is at
// the middle of the screen stays there, the same spot of the same point card
// if the middle is on one, else of the same box (or the nearest box).
function anchorMotion(before, after, motion, viewport) {
  const s = Number(motion.s) || 1,
    tx = Number(motion.tx) || 0,
    ty = Number(motion.ty) || 0;
  const cx = ((viewport && viewport.width) || 760) / 2,
    cy = ((viewport && viewport.height) || 320) / 2;
  const px = (cx - tx) / s,
    py = (cy - ty) / s;
  const was = pointCards(before),
    now = pointCards(after);
  const inside = (n) => px >= n.x && px <= n.x + n.width && py >= n.y && py <= n.y + n.height;
  // The box on top under the spot, as pages/map/hit.js stage picks it.
  const top = [...was.boxes].reverse().find(inside);
  const card = top && was.cards.find((n) => n.box === top.id && inside(n));
  let from = card,
    to = card && now.cards.find((n) => n.id === card.id);
  if (!to) {
    let best = Infinity;
    from = null;
    was.boxes.forEach((n) => {
      const dx = Math.max(n.x - px, 0, px - n.x - n.width),
        dy = Math.max(n.y - py, 0, py - n.y - n.height),
        d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        from = n;
      }
    });
    to = from && now.boxes.find((n) => n.id === from.id);
  }
  if (!to) return { tx, ty, s };
  const fx = Math.min(1, Math.max(0, (px - from.x) / from.width)),
    fy = Math.min(1, Math.max(0, (py - from.y) / from.height));
  return {
    tx: Math.round(cx - (to.x + fx * to.width) * s),
    ty: Math.round(cy - (to.y + fy * to.height) * s),
    s,
  };
}

function taskLayout(chapter, expandedId, detail) {
  if (detail) return detailLayout(chapter);
  const points = new Map((chapter.points || []).map((p) => [p.id, p]));
  const nextId = chapter.next && chapter.next.id;
  let x = 24,
    baseX = 24;
  const y = 190;
  const nodes = (chapter.nodes || []).map((raw) => {
    const node = nodeSummary(raw, points, nextId);
    const expanded = node.group && raw.id === expandedId;
    const branch = expanded ? branchMembers(node.members) : null;
    const width = expanded
      ? Math.max(238, 28 + branch.columns * 156)
      : node.group
        ? 178
        : 146;
    const height = expanded ? 54 + branch.rows * 76 : 92;
    const collapsedWidth = node.group ? 178 : 146;
    const out = {
      ...node,
      expanded,
      x,
      baseX,
      shiftX: x - baseX,
      y: expanded ? y - 22 : y,
      width,
      height,
      memberViews: expanded ? branch.views : [],
      innerEdges: expanded ? branch.edges : [],
    };
    x += width + 28;
    baseX += collapsedWidth + 28;
    return out;
  });
  const nodeForPoint = new Map();
  nodes.forEach((node) =>
    node.members.forEach((p) => nodeForPoint.set(p.id, node)),
  );
  const edges = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i],
      b = nodes[i + 1];
    edges.push({
      id: `main-${i}`,
      cls: "main",
      x: a.x + a.width,
      y: y + 44,
      width: b.x - a.x - a.width,
      angle: 0,
    });
  }
  const sides = (chapter.sides || [])
    .map((raw, index) => {
      const parent = nodeForPoint.get(raw.parent);
      const members = raw.members
        .map((id) => pointView(points.get(id), nextId))
        .filter(Boolean);
      if (!parent || !members.length) return null;
      const id = `side-${raw.parent}-${index}`;
      const expanded = members.length > 1 && id === expandedId;
      const side = members[0].side || "up";
      const branch = expanded ? branchMembers(members) : null;
      const width = expanded
        ? Math.max(160, 28 + branch.columns * 156)
        : members.length > 1
          ? 154
          : 132;
      const sx = Math.max(12, parent.x + parent.width / 2 - width / 2);
      const sy = y + 154 + (index % 2) * 124;
      edges.push({
        id: `branch-${id}`,
        cls: `branch ${side}`,
        x: parent.x + parent.width / 2,
        y: y + 90,
        width: sy - y - 90,
        angle: 90,
      });
      return {
        id,
        parent: raw.parent,
        members,
        group: members.length > 1,
        expanded,
        name:
          members.length > 1
            ? members.map((p) => p.short || p.name).join(" · ")
            : members[0].name,
        x: sx,
        y: sy,
        width,
        height: expanded ? 54 + branch.rows * 76 : 76,
        side,
        sideText: sideLabel(side),
        statusCls: groupCls(members),
        next: members.some((p) => p.next),
        taught: members.some((p) => p.taught !== false),
        memberViews: expanded ? branch.views : [],
        innerEdges: expanded ? branch.edges : [],
      };
    })
    .filter(Boolean);
  return {
    nodes,
    sides,
    edges,
    width: Math.max(760, x + 120),
    height: Math.max(560, ...sides.map((s) => s.y + s.height + 80)),
  };
}

function relationLayout(chapter, graph, selectedId) {
  const points = new Map(
    (chapter.points || []).map((p) => [
      p.id,
      pointView(p, chapter.next && chapter.next.id),
    ]),
  );
  const incoming = new Map(),
    outgoing = new Map();
  (graph.edges || []).forEach((edge) => {
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    incoming.get(edge.to).push(edge.from);
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
  });
  const walk = (seed, links) => {
    const seen = new Set(),
      todo = seed ? [seed] : [];
    while (todo.length) {
      const id = todo.pop();
      for (const next of links.get(id) || [])
        if (!seen.has(next)) {
          seen.add(next);
          todo.push(next);
        }
    }
    return seen;
  };
  const before = walk(selectedId, incoming),
    after = walk(selectedId, outgoing);
  const nodes = (graph.nodes || []).map((node) => {
    const point = points.get(node.id) || {};
    const relation =
      node.id === selectedId
        ? "selected"
        : before.has(node.id)
          ? "before"
          : after.has(node.id)
            ? "after"
            : selectedId
              ? "dim"
              : "normal";
    return {
      ...point,
      ...node,
      relation,
      name: point.short || point.name || node.id,
    };
  });
  const edges = [];
  (graph.edges || []).forEach((edge, edgeIndex) => {
    const pointsOfEdge = edge.points || [];
    const relation =
      selectedId &&
      (edge.to === selectedId || before.has(edge.to)) &&
      (edge.from === selectedId || before.has(edge.from))
        ? "before"
        : selectedId &&
            (edge.from === selectedId || after.has(edge.from)) &&
            (edge.to === selectedId || after.has(edge.to))
          ? "after"
          : selectedId
            ? "dim"
            : "normal";
    for (let i = 0; i < pointsOfEdge.length - 1; i++) {
      const a = pointsOfEdge[i],
        b = pointsOfEdge[i + 1],
        dx = b.x - a.x,
        dy = b.y - a.y;
      edges.push({
        id: `${edgeIndex}-${i}`,
        x: a.x,
        y: a.y,
        width: Math.sqrt(dx * dx + dy * dy),
        angle: (Math.atan2(dy, dx) * 180) / Math.PI,
        cls: relation,
      });
    }
  });
  return {
    nodes,
    edges,
    external: graph.external || [],
    width: graph.width || 600,
    height: graph.height || 800,
  };
}

function clampScale(value) {
  return Math.max(0.4, Math.min(1, Number(value) || 0.72));
}
function zoomLevel(scale) {
  return scale < 0.6 ? "far" : scale < 0.85 ? "mid" : "near";
}
function focusTransform(node, viewport, scale, panel) {
  const s = clampScale(scale);
  const width = (viewport && viewport.width) || 375;
  const height = (viewport && viewport.height) || 560;
  const visibleHeight = panel ? Math.max(100, height / 3) : height;
  return {
    s,
    tx: width / 2 - (node.x + node.width / 2) * s,
    ty: visibleHeight / 2 - (node.y + node.height / 2) * s,
  };
}

// The "下一步 →" capsule when the next point is off screen (v3 §5.5): it sits on
// the edge the point lies beyond, kept off the middle row of nodes, and says
// which way to look. Tapping it pans back to the point.
const PILL = { width: 96, height: 34, gap: 12 };
function edgeIndicator(layout, pointId, transform, viewport, margin = 24) {
  const node = [...(layout.nodes || []), ...(layout.sides || [])].find(
    (item) =>
      item.id === pointId ||
      (item.members || []).some((point) => point.id === pointId),
  );
  if (!node) return null;
  const width = (viewport && viewport.width) || 375,
    height = (viewport && viewport.height) || 560;
  const p = {
    x: (node.x + node.width / 2) * transform.s + transform.tx,
    y: (node.y + node.height / 2) * transform.s + transform.ty,
  };
  if (
    p.x >= margin &&
    p.x <= width - margin &&
    p.y >= margin &&
    p.y <= height - margin
  )
    return null;
  const dx = p.x - width / 2,
    dy = p.y - height / 2;
  const across = Math.abs(dx) * height >= Math.abs(dy) * width;
  const arrow = across ? (dx > 0 ? "→" : "←") : dy > 0 ? "↓" : "↑";
  const left = across
    ? dx > 0
      ? width - PILL.gap - PILL.width
      : PILL.gap
    : Math.round(width / 2 - PILL.width / 2);
  const top =
    across || dy > 0 ? height - PILL.gap - PILL.height : PILL.gap;
  return {
    left: Math.round(left),
    top: Math.round(top),
    arrow,
    text: arrow === "←" || arrow === "↑" ? `${arrow} 下一步` : `下一步 ${arrow}`,
  };
}

module.exports = {
  pointView,
  status,
  sideLabel,
  taskLayout,
  anchorMotion,
  relationLayout,
  clampScale,
  zoomLevel,
  focusTransform,
  edgeIndicator,
};
