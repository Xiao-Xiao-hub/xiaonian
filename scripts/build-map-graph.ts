import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";
import type { ChapterGraph } from "../server/src/modules/learn/graph.js";

// This script lives beside seed_learn.ts while its locked build dependency is
// owned by server/package.json.
const require = createRequire(new URL("../server/package.json", import.meta.url));
const { graphlib, layout } = require("@dagrejs/dagre") as {
  graphlib: { Graph: new () => any };
  layout: (graph: any) => void;
};

const NODE_WIDTH = 120;
const NODE_HEIGHT = 52;
const round = (value: number) => Math.round(value * 100) / 100;
const pointIndex = new Map(CALC_MAP.chapters.flatMap((chapter) =>
  chapter.points.map((point) => [point.id, { point, chapter }] as const)));

const graphs: ChapterGraph[] = CALC_MAP.chapters.map((chapter) => {
  const graph = new graphlib.Graph();
  graph.setGraph({
    rankdir: "TB",
    nodesep: 28,
    edgesep: 12,
    ranksep: 44,
    marginx: 18,
    marginy: 18,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const point of chapter.points)
    graph.setNode(point.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const point of chapter.points)
    for (const prereq of point.prereqs)
      if (pointIndex.get(prereq)?.chapter.id === chapter.id)
        graph.setEdge(prereq, point.id);
  layout(graph);
  const label = graph.graph();
  return {
    chapterId: chapter.id,
    width: round(Number(label.width ?? 0)),
    height: round(Number(label.height ?? 0)),
    nodes: graph.nodes().map((id) => {
      const node = graph.node(id);
      return {
        id,
        x: round(node.x - node.width / 2),
        y: round(node.y - node.height / 2),
        width: round(node.width),
        height: round(node.height),
      };
    }),
    edges: graph.edges().map((edge) => ({
      from: edge.v,
      to: edge.w,
      points: graph.edge(edge).points.map((point: { x: number; y: number }) => ({
        x: round(point.x), y: round(point.y),
      })),
      crossChapter: false as const,
      label: null,
    })),
    external: chapter.points.flatMap((point) => point.prereqs.flatMap((prereq) => {
      const source = pointIndex.get(prereq);
      return source && source.chapter.id !== chapter.id ? [{
        from: prereq,
        to: point.id,
        chapterId: source.chapter.id,
        label: `${source.chapter.short} · ${source.point.short}`,
      }] : [];
    })),
  };
});

const output = fileURLToPath(new URL(
  "../server/src/modules/learn/calc-map-graph.json",
  import.meta.url,
));
writeFileSync(output, `${JSON.stringify(graphs, null, 2)}\n`, "utf8");
console.log(`built ${graphs.length} chapter graphs`);
