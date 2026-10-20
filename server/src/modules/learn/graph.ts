import graphJson from "./calc-map-graph.json" with { type: "json" };

export type GraphPoint = { x: number; y: number };
export type GraphNode = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type GraphEdge = {
  from: string;
  to: string;
  points: GraphPoint[];
  crossChapter: false;
  label: null;
};
export type GraphExternal = {
  from: string;
  to: string;
  chapterId: string;
  label: string;
};
export type ChapterGraph = {
  chapterId: string;
  width: number;
  height: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  external: GraphExternal[];
};

export const MAP_GRAPHS = graphJson as ChapterGraph[];

export function chapterGraph(chapterId: string) {
  return MAP_GRAPHS.find((graph) => graph.chapterId === chapterId) ?? null;
}
