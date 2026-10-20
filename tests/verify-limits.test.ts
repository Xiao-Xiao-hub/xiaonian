// Answers bracketed deeper than any problem needs are refused before mathjs
// builds their TeX, which doubles in time per level (22 levels took 8 s).
import test from "node:test";
import assert from "node:assert/strict";
import {
  sameAntiderivative,
  sameFunction,
  texOf,
} from "../server/src/shared/verify.js";
import { mathEquivalent } from "../server/src/modules/study/service.js";

const nested = (n: number) => "sin(".repeat(n) + "x" + ")".repeat(n);
function quick<T>(run: () => T): T {
  const start = performance.now();
  const result = run();
  assert.ok(performance.now() - start < 1000, "took over a second");
  return result;
}

test("answers nested deeper than any problem are refused quickly", () => {
  assert.ok(texOf(nested(12)));
  assert.equal(sameFunction(nested(12), nested(12)), true);
  assert.equal(texOf(nested(13)), null);
  assert.equal(
    quick(() => sameFunction("x^2", nested(22))),
    null,
  );
  assert.equal(
    quick(() => sameAntiderivative("x^3/3 + C", `${nested(22)} + C`)),
    null,
  );
  assert.equal(
    quick(() => mathEquivalent("x^2", nested(22))),
    null,
  );
});
