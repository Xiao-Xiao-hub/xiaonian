import assert from "node:assert/strict";
import test from "node:test";
import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";
import {
  canonicalInput,
  judgeAnswer,
} from "../server/src/modules/learn/answers.js";
import {
  PROBLEMS,
  type AnswerSpec,
  type Problem,
} from "../server/src/modules/learn/problems.js";
import { KEY_VARIANTS } from "../server/src/modules/learn/problems-key-variants.js";

// Mechanical regression over every real problem in the bank, not
// only the original 50: each standard answer judges itself correct, a nearby
// wrong answer does not, and a point's variants never accept each other.
const all = Object.entries(PROBLEMS).flatMap(([id, pair]) =>
  pair.map((problem, index) => ({ label: `${id}[${index}]`, problem })),
);
const squash = (s: string) => s.replace(/\s+/g, "");
const bare = (answer: string) => answer.replace(/\s*\+\s*C\s*$/, "");
// A value off by a non-constant or constant amount; antiderivatives keep +C.
const off = (spec: AnswerSpec) =>
  spec.kind === "antiderivative"
    ? `2*(${bare(spec.answer)}) + ${spec.var ?? "x"} + C`
    : `(${spec.answer})+1`;
function wrongInput(problem: Problem): string | string[] {
  if (problem.kind === "choice")
    return problem.questions.map((q, i) =>
      i === 0 ? q.options.find((o) => o.id !== q.answer)!.id : q.answer,
    );
  if (problem.kind === "multi")
    return problem.parts.map((part, i) => (i === 0 ? off(part) : part.answer));
  return off(problem);
}
const shape = (p: Problem) =>
  p.kind === "multi"
    ? p.parts.map((part) => `${part.kind}:${part.var ?? "x"}`).join(",")
    : p.kind === "choice"
      ? `choice:${p.questions.length}`
      : `${p.kind}:${p.var ?? "x"}`;

test("learn bank: every map point keeps its base pair and nothing else is keyed", () => {
  const points = CALC_MAP.chapters.flatMap((c) => c.points.map((p) => p.id));
  assert.deepEqual(Object.keys(PROBLEMS).sort(), [...points].sort());
  assert.equal(
    all.length,
    178 + Object.values(KEY_VARIANTS).reduce((sum, variants) => sum + variants.length, 0),
  );
  for (const [id, problems] of Object.entries(PROBLEMS))
    assert.equal(problems.length, 2 + (KEY_VARIANTS[id]?.length ?? 0), id);
});

test("learn bank: every ★ point has two deterministic extras", () => {
  const keyIds = CALC_MAP.chapters.flatMap((chapter) =>
    chapter.points.filter((point) => point.key).map((point) => point.id),
  ).sort();
  assert.deepEqual(Object.keys(KEY_VARIANTS).sort(), keyIds);
  for (const id of keyIds) assert.equal(KEY_VARIANTS[id]?.length, 2, id);
});

test("learn bank: each standard answer is judged correct", () => {
  for (const { label, problem } of all) {
    const r = judgeAnswer(problem, canonicalInput(problem));
    assert.equal(
      r.verdict,
      "correct",
      `${label}: ${r.reason} ${JSON.stringify(r.items?.map((x) => x.reason))}`,
    );
  }
});

test("learn bank: a nearby wrong answer is judged incorrect, not unsure", () => {
  for (const { label, problem } of all)
    assert.equal(
      judgeAnswer(problem, wrongInput(problem)).verdict,
      "incorrect",
      label,
    );
});

test("learn bank: an antiderivative without + C is never judged correct", () => {
  const specs = all.flatMap(({ label, problem }) =>
    problem.kind === "multi"
      ? problem.parts.map((part, i) => ({ label: `${label}.${i}`, part, problem }))
      : problem.kind === "antiderivative"
        ? [{ label, part: problem as AnswerSpec, problem }]
        : [],
  );
  for (const { label, part, problem } of specs) {
    if (part.kind !== "antiderivative") continue;
    const input =
      problem.kind === "multi"
        ? problem.parts.map((p) => (p === part ? bare(p.answer) : p.answer))
        : bare(part.answer);
    assert.notEqual(judgeAnswer(problem, input).verdict, "correct", label);
  }
});

test("learn bank: a point's variants share a shape and reject each other's answers", () => {
  for (const [id, problems] of Object.entries(PROBLEMS)) {
    for (const problem of problems) assert.equal(shape(problem), shape(problems[0]!), id);
    for (let a = 0; a < problems.length; a++) for (let b = 0; b < problems.length; b++) {
      if (a === b) continue;
      const verdict = judgeAnswer(problems[a]!, canonicalInput(problems[b]!)).verdict;
      assert.equal(verdict, "incorrect", `${id}[${a}] accepted [${b}]: ${verdict}`);
    }
  }
});

test("learn bank: text never shows the answer, choices are well formed", () => {
  for (const { label, problem } of all) {
    const answers =
      problem.kind === "multi"
        ? problem.parts.map((p) => bare(p.answer))
        : problem.kind === "choice"
          ? []
          : [bare(problem.answer)];
    for (const answer of answers)
      if (squash(answer).length >= 3)
        assert.ok(!squash(problem.text).includes(squash(answer)), label);
    if (problem.kind === "choice")
      for (const q of problem.questions) {
        const ids = q.options.map((o) => o.id);
        assert.equal(new Set(ids).size, ids.length, label);
        assert.ok(ids.includes(q.answer), label);
      }
  }
});
