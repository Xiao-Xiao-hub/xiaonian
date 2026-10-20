import assert from "node:assert/strict";
import test from "node:test";
import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";
import { validateMap } from "../server/src/modules/learn/map-layout.js";
test("v2 map labels and layout cover the 89 existing points", () =>
  validateMap(CALC_MAP));
test("v2 map layout rejects an invalid fixture", () => {
  const bad = structuredClone(CALC_MAP);
  bad.chapters[0]!.points[0]!.exam = "a=b";
  assert.throws(() => validateMap(bad));
});
test("limit nodes follow the approved six-node layout", () => {
  assert.deepEqual(
    CALC_MAP.chapters[0]!.nodes.map((node) => node.members),
    [
      ["limit-function", "limit-one-sided", "limit-infinitesimal"],
      ["limit-rules"],
      [
        "limit-squeeze",
        "limit-monotone",
        "limit-important-sin",
        "limit-important-e",
      ],
      ["limit-order", "limit-equivalent", "limit-1-to-inf"],
      ["limit-continuity", "limit-discontinuity"],
      ["limit-zero-theorem"],
    ],
  );
});
test("layout rejects duplicate or missing branches and inverted prerequisites", () => {
  const duplicate = structuredClone(CALC_MAP);
  duplicate.chapters[0]!.sides.push(duplicate.chapters[0]!.sides[0]!);
  assert.throws(() => validateMap(duplicate));
  const missing = structuredClone(CALC_MAP);
  missing.chapters[0]!.sides.pop();
  assert.throws(() => validateMap(missing));
  const inverted = structuredClone(CALC_MAP);
  inverted.chapters[0]!.nodes.reverse();
  assert.throws(() => validateMap(inverted));
});
