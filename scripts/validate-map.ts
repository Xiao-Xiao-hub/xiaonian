import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";
import { validateMap } from "../server/src/modules/learn/map-layout.js";
import { MAP_GRAPHS } from "../server/src/modules/learn/graph.js";
import { keyProblems, MAP_CARDS } from "../server/src/modules/learn/map-cards.js";
import { chapterLines } from "../server/src/modules/learn/map-lines.js";
import { MAP_POS } from "../server/src/modules/learn/map-pos.js";
import { POINT_NOTES } from "../server/src/modules/learn/map-notes.js";
import { POINT_PRACTICE } from "../server/src/modules/learn/point-practice.js";
import { BANNED_PHRASES } from "../server/src/modules/safety/banned-phrases.js";

validateMap(CALC_MAP);
for (const chapter of CALC_MAP.chapters) {
  const graph = MAP_GRAPHS.find((item) => item.chapterId === chapter.id);
  if (!graph) throw new Error(`missing graph ${chapter.id}`);
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (ids.size !== chapter.points.length || chapter.points.some((point) => !ids.has(point.id)))
    throw new Error(`graph points differ ${chapter.id}`);
  const expected = new Set(chapter.points.flatMap((point) => point.prereqs
    .filter((id) => chapter.points.some((candidate) => candidate.id === id))
    .map((id) => `${id}>${point.id}`)));
  const actual = new Set(graph.edges.map((edge) => `${edge.from}>${edge.to}`));
  if (expected.size !== actual.size || [...expected].some((edge) => !actual.has(edge)))
    throw new Error(`graph edges differ ${chapter.id}`);
}
// v4 star map (D110): every point has a star, a card with 1–3 formulas and
// exactly 3 keys, and key marks are well formed.
const allIds = new Set(CALC_MAP.chapters.flatMap((c) => c.points.map((p) => p.id)));
for (const id of Object.keys(MAP_CARDS))
  if (!allIds.has(id)) throw new Error(`map card for unknown point ${id}`);
for (const chapter of CALC_MAP.chapters) {
  const pos = MAP_POS[chapter.id];
  if (!pos) throw new Error(`missing map positions ${chapter.id}`);
  const ids = new Set(chapter.points.map((p) => p.id));
  for (const id of Object.keys(pos.points))
    if (!ids.has(id)) throw new Error(`position for unknown point ${chapter.id} ${id}`);
  const taken = new Map<string, string>();
  for (const point of chapter.points) {
    const at = pos.points[point.id];
    if (!at) throw new Error(`missing position ${point.id}`);
    if (!(at.x >= 0 && at.x <= pos.width && at.y >= 0 && at.y <= pos.height))
      throw new Error(`position outside canvas ${point.id}`);
    const place = `${at.x},${at.y}`;
    if (taken.has(place))
      throw new Error(`same position ${taken.get(place)} ${point.id}`);
    taken.set(place, point.id);
    const card = MAP_CARDS[point.id];
    if (!card) throw new Error(`missing map card ${point.id}`);
    if (!Array.isArray(card.formulas) || card.formulas.length < 1 || card.formulas.length > 3 ||
      card.formulas.some((tex) => typeof tex !== "string" || !tex.trim() || tex.includes("$")))
      throw new Error(`bad formulas ${point.id}`);
    if (!Array.isArray(card.keys) || card.keys.length !== 3)
      throw new Error(`need 3 keys ${point.id}`);
    card.keys.forEach((key, i) => {
      const problems = keyProblems(key);
      if ((key.match(/(?<!\\)\$/g) ?? []).length % 2) problems.push("unclosed $");
      if (problems.length)
        throw new Error(`bad key ${point.id} keys[${i}]: ${problems.join(", ")}`);
    });
  }
  chapterLines(chapter);
}
if (process.argv.includes("--table")) {
  console.log(
    "# v2 地图标签审校表\n\n> 本表为 AI 静态审校，未经过教师或本校考纲核验。\n\n| id | name | line | side | key | hard | level | exam | short |\n|---|---|---|---|---|---|---|---|---|",
  );
  for (const chapter of CALC_MAP.chapters)
    for (const point of chapter.points)
      console.log(
        `| ${point.id} | ${point.name} | ${point.line} | ${point.side ?? ""} | ${point.key} | ${point.hard} | ${point.level} | ${point.exam} | ${point.short} |`,
      );
}
// 0.6.0 知识点详情 (D113): every point has an intro of 2–4 sentences and one
// sentence per card formula; no banned phrase, model name or review claim.
const sentences = (text: string) =>
  text.split(/[。！？]/).filter((part) => part.trim()).length;
const NOT_SAID = [
  ...BANNED_PHRASES,
  "教师审定",
  "老师审定",
  "已审定",
  "境内",
  "境外",
  "出境",
];
const MODEL_NAME =
  /jev|glm|智谱|混元|hunyuan|deepseek|qwen|通义|文心|kimi|gpt|claude|openai|anthropic|gemini|flash|codex|大模型/i;
for (const id of Object.keys(POINT_NOTES))
  if (!allIds.has(id)) throw new Error(`notes for unknown point ${id}`);
for (const id of Object.keys(POINT_PRACTICE))
  if (!allIds.has(id)) throw new Error(`AI practice for unknown point ${id}`);
for (const id of allIds) {
  const note = POINT_NOTES[id];
  if (!note) throw new Error(`missing notes ${id}`);
  const formulas = MAP_CARDS[id]!.formulas.length;
  if (note.formulaNotes.length !== formulas)
    throw new Error(`notes ${id}: ${note.formulaNotes.length} formula notes for ${formulas} formulas`);
  const n = sentences(note.intro);
  if (n < 2 || n > 4) throw new Error(`notes ${id}: intro has ${n} sentences`);
  if (note.intro.length > 180) throw new Error(`notes ${id}: intro too long`);
  note.formulaNotes.forEach((text, i) => {
    if (!text.trim() || text.length > 90 || sentences(text) !== 1)
      throw new Error(`notes ${id}: formulaNotes[${i}] must be one short sentence`);
  });
  for (const text of [note.intro, ...note.formulaNotes]) {
    if ((text.match(/(?<!\\)\$/g) ?? []).length % 2)
      throw new Error(`notes ${id}: unclosed $`);
    const said = NOT_SAID.find((phrase) => text.includes(phrase));
    if (said) throw new Error(`notes ${id}: says ${said}`);
    if (MODEL_NAME.test(text)) throw new Error(`notes ${id}: names a model`);
  }
}
console.log("v2 map layout valid; v4 stars and cards valid; 0.6.0 notes valid");
