import assert from "node:assert/strict";
import test from "node:test";
import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";
import { keyProblems, MAP_CARDS } from "../server/src/modules/learn/map-cards.js";
import { chapterLines, reducedEdges } from "../server/src/modules/learn/map-lines.js";
import { MAP_POS } from "../server/src/modules/learn/map-pos.js";

test("v4 要点标记：只认 k/w/f/x 加可选 !，要闭合、不嵌套、每条最多一个", () => {
  assert.deepEqual(keyProblems("[[k:重点]]，其余照常"), []);
  assert.deepEqual(keyProblems("[[x!:易错]] 和 $x^2$"), []);
  assert.ok(keyProblems("[[y:未知字母]]").includes("bad mark"));
  assert.ok(keyProblems("[[k:没闭合").includes("bad mark"));
  assert.ok(keyProblems("[[k:外 [[w:内]] 层]]").includes("bad mark"));
  assert.ok(keyProblems("[[k:一]] 和 [[w:二]]").includes("more than one mark"));
  for (const [id, card] of Object.entries(MAP_CARDS))
    card.keys.forEach((key, i) => assert.deepEqual(keyProblems(key), [], `${id} keys[${i}]`));
  // Not every key is marked.
  const keys = Object.values(MAP_CARDS).flatMap((card) => card.keys);
  assert.ok(keys.some((key) => !key.includes("[[")));
});

test("v4 连线：章内传递约简，线型只有 main/up/opt，选学是 opt", () => {
  for (const chapter of CALC_MAP.chapters) {
    const lines = chapterLines(chapter);
    const edges = reducedEdges(chapter).map(([a, b]) => `${a.id}>${b.id}`);
    assert.deepEqual(lines.map((l) => `${l.from}>${l.to}`), edges);
    const byId = new Map(chapter.points.map((p) => [p.id, p]));
    for (const line of lines) {
      const from = byId.get(line.from)!, to = byId.get(line.to)!;
      const side = to.line === "side" ? to : from.line === "side" ? from : null;
      assert.equal(line.type, !side ? "main" : side.side === "extra" ? "opt" : "up");
    }
    assert.ok(MAP_POS[chapter.id]!.width >= 375);
  }
  // limit-function → limit-rules is implied through limit-one-sided etc., so not drawn.
  const limit = CALC_MAP.chapters.find((c) => c.id === "limit")!;
  const all = limit.points.flatMap((p) => p.prereqs.filter((id) => id.startsWith("limit-")));
  assert.ok(reducedEdges(limit).length < all.length);
});
