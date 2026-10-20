// v4 star map lines, computed once from the prerequisites and the
// hand-placed stars in map-pos.ts. The client only colours them by state.
//
// 连线路由规则：
// - an edge is drawn only inside a chapter and only when the target cannot be
//   reached along other edges (transitive reduction); the detail lists all;
// - same row (a ◆ hard point beside the main line): a short horizontal line
//   between the two stars;
// - main point to a side point that has no side parent: out of the parent
//   star to the right, along its row to the side track, then down — when that
//   path passes no other star or name;
// - otherwise: from under the parent's name (or star, when the name is on the
//   left) straight to the top of the child's star.
// Line types: "main" between main points; a line touching a side point takes
// that point's kind: 拔高 and 考研 are "up" (solid), 选学 is "opt" (dashed).
import { CALC_MAP, type MapChapter, type MapPoint } from "./calc-map.js";
import { MAP_POS, type StarPos } from "./map-pos.js";

export type LineType = "main" | "up" | "opt";
export type MapLineView = {
  from: string;
  to: string;
  type: LineType;
  points: { x: number; y: number }[];
};
export type ChapterCanvas = { width: number; height: number };
export type Box = { x0: number; y0: number; x1: number; y1: number };

// Star radius by line, as drawn in the far view; lines stop 2 px short.
export const STAR_R = { main: 7, side: 4.5 } as const;
// Names: 12 px bold, one em per CJK glyph; ★ or ◆ in front of main points.
export const NAME_PX = 12;
const LABEL_DROP = 30; // from a star centre to under its name

const radius = (point: MapPoint) => STAR_R[point.line];
const lineType = (point: MapPoint): LineType =>
  point.side === "extra" ? "opt" : "up";

// The mark shown before a name: ◆ for a hard main point, else ★ for a key one.
export const nameMark = (point: MapPoint) =>
  point.line === "main" && point.hard
    ? "◆"
    : point.line === "main" && point.key
      ? "★"
      : "";

export function labelBox(point: MapPoint, at: StarPos): Box {
  const w = Array.from(nameMark(point) + point.short).length * NAME_PX;
  const r = radius(point);
  return at.label === "below"
    ? { x0: at.x - w / 2, x1: at.x + w / 2, y0: at.y + 13, y1: at.y + 27 }
    : { x0: at.x - r - 6 - w, x1: at.x - r - 6, y0: at.y - 7, y1: at.y + 7 };
}

// In-chapter prerequisite edges that no longer path already implies.
export function reducedEdges(chapter: MapChapter): [MapPoint, MapPoint][] {
  const byId = new Map(chapter.points.map((p) => [p.id, p]));
  const pre = (id: string) =>
    byId.get(id)!.prereqs.filter((prereq) => byId.has(prereq));
  const implied = (from: string, to: string) => {
    const stack = pre(to).filter((id) => id !== from);
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (id === from) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...pre(id));
    }
    return false;
  };
  return chapter.points.flatMap((point) =>
    pre(point.id)
      .filter((from) => !implied(from, point.id))
      .map((from) => [byId.get(from)!, point] as [MapPoint, MapPoint]),
  );
}

type Pt = [number, number];
// Whether the segment a–b keeps clear of a star (centre c, radius r) or a box.
export function nearStar(a: Pt, b: Pt, c: Pt, r: number) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(
      1,
      ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / (dx * dx + dy * dy || 1),
    ),
  );
  return Math.hypot(c[0] - a[0] - t * dx, c[1] - a[1] - t * dy) < r;
}
export function throughBox(a: Pt, b: Pt, box: Box) {
  // Liang–Barsky clip of the segment against the box.
  let t0 = 0,
    t1 = 1;
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const sides: Pt[] = [
    [-dx, a[0] - box.x0],
    [dx, box.x1 - a[0]],
    [-dy, a[1] - box.y0],
    [dy, box.y1 - a[1]],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return t1 - t0 > 1e-6;
}

const round = (n: number) => Math.round(n * 10) / 10;

export function chapterLines(chapter: MapChapter): MapLineView[] {
  const pos = MAP_POS[chapter.id];
  if (!pos) throw new Error(`missing map positions ${chapter.id}`);
  const at = (point: MapPoint) => {
    const found = pos.points[point.id];
    if (!found) throw new Error(`missing position ${point.id}`);
    return found;
  };
  // A polyline is clear when it passes no star or name but its own two stars.
  const clear = (path: Pt[], from: MapPoint, to: MapPoint) =>
    chapter.points.every((point) => {
      if (point.id === from.id || point.id === to.id) return true;
      const p = at(point),
        box = labelBox(point, p);
      return path
        .slice(1)
        .every(
          (q, i) =>
            !nearStar(path[i]!, q, [p.x, p.y], radius(point) + 3) &&
            !throughBox(path[i]!, q, box),
        );
    });
  const edges = reducedEdges(chapter);
  return edges.map(([from, to]) => {
    const a = at(from),
      b = at(to);
    const ra = radius(from) + 2,
      rb = radius(to) + 2;
    const sideFed = edges.some(
      ([other, target]) => target.id === to.id && other.line === "side",
    );
    let path: Pt[] | undefined = pos.routes?.[`${from.id}>${to.id}`];
    if (!path && a.y === b.y) {
      const dir = Math.sign(b.x - a.x);
      path = [
        [a.x + dir * ra, a.y],
        [b.x - dir * rb, b.y],
      ];
    }
    const top: Pt = [b.x, b.y - rb];
    if (!path && from.line === "main" && to.line === "side" && !sideFed && b.x > a.x) {
      const elbow: Pt[] = [[a.x + ra, a.y], [b.x, a.y], top];
      if (clear(elbow, from, to)) path = elbow;
    }
    path ??= [[a.x, a.y + (a.label === "below" ? LABEL_DROP : ra)], top];
    return {
      from: from.id,
      to: to.id,
      type:
        to.line === "side"
          ? lineType(to)
          : from.line === "side"
            ? lineType(from)
            : "main",
      points: path.map(([x, y]) => ({ x: round(x), y: round(y) })),
    };
  });
}

type ChapterV4 = {
  canvas: ChapterCanvas;
  lines: MapLineView[];
  pos: Record<string, StarPos>;
};
let v4: Map<string, ChapterV4> | null = null;
// Everything the v4 map adds per chapter, computed on first use.
export function mapV4(chapterId: string): ChapterV4 {
  v4 ??= new Map(
    CALC_MAP.chapters.map((chapter) => {
      const pos = MAP_POS[chapter.id];
      if (!pos) throw new Error(`missing map positions ${chapter.id}`);
      return [
        chapter.id,
        {
          canvas: { width: pos.width, height: pos.height },
          lines: chapterLines(chapter),
          pos: pos.points,
        },
      ];
    }),
  );
  const found = v4.get(chapterId);
  if (!found) throw new Error(`missing map chapter ${chapterId}`);
  return found;
}
