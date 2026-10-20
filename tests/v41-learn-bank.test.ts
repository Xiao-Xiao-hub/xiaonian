import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";
import { choiceProblems } from "../server/src/modules/learn/choice-check.js";
import { judge } from "../server/src/modules/learn/judge.js";
import { MAP_CARDS } from "../server/src/modules/learn/map-cards.js";
import { POINT_NOTES } from "../server/src/modules/learn/map-notes.js";
import { POINT_PRACTICE } from "../server/src/modules/learn/point-practice.js";
import {
  BANK,
  PROBLEMS,
  type MultiProblem,
  type ScalarProblem,
} from "../server/src/modules/learn/problems.js";
import {
  answeredAs,
  isFillIn,
  PLAIN_NUMBER,
  rightSlot,
  sourceOf,
} from "../server/src/modules/learn/problems-choices.js";
import {
  CHOICE_DATA,
  EXPLANATIONS,
  FOURTH_OPTIONS,
  MERGED_CHOICES,
} from "../server/src/modules/learn/problems-choices-data.js";
import { FormulaRenderer } from "../server/src/modules/render/formula.js";
import { MarkdownRenderer } from "../server/src/modules/render/markdown.js";
import { INK } from "../server/src/modules/render/routes.js";

// 0.6.0 题库 : two kinds of problem, program-checked options, notes.
const served = Object.entries(PROBLEMS).flatMap(([pointId, list]) =>
  BANK[pointId]!.map((problem, index) => ({
    key: `${pointId}#${index}`,
    pointId,
    index,
    problem,
    authored: list[index]!,
  })),
);

const converted = (kind: string) =>
  served.find(
    (s) => s.problem.kind === "choice" && s.authored.kind === kind,
  )!;

test("bank: every problem is a plain-number fill-in or single choice with 4 distinct options", () => {
  assert.equal(served.length, 244);
  let choice = 0;
  for (const { key, problem } of served) {
    if (problem.kind === "choice") {
      choice++;
      for (const question of problem.questions) {
        assert.deepEqual(
          question.options.map((o) => o.id),
          ["A", "B", "C", "D"],
          key,
        );
        const texts = question.options.map((o) => o.text.replace(/\s+/g, ""));
        assert.equal(new Set(texts).size, 4, `${key} distinct`);
        assert.equal(
          question.options.filter((o) => o.id === question.answer).length,
          1,
          `${key} one right option`,
        );
      }
      // Converted ones and the merged convergence pairs are one question.
      if (
        (problem.source && problem.source.kind !== "choice") ||
        MERGED_CHOICES[key]
      )
        assert.equal(problem.questions.length, 1, key);
      continue;
    }
    assert.ok(isFillIn(problem), `${key} is ${problem.kind}, not a fill-in`);
    const answers =
      problem.kind === "multi"
        ? problem.parts.map((part) => part.answer)
        : [problem.answer];
    for (const answer of answers)
      assert.match(answer.replace(/\s+/g, ""), PLAIN_NUMBER, key);
  }
  assert.equal(choice, 244 - 87);
});

test("bank: overlays only touch the problems they were written for", () => {
  for (const key of [
    ...Object.keys(CHOICE_DATA),
    ...Object.keys(FOURTH_OPTIONS),
    ...Object.keys(MERGED_CHOICES),
    ...Object.keys(EXPLANATIONS),
  ]) {
    const [pointId, index] = key.split("#");
    assert.ok(PROBLEMS[pointId!]?.[Number(index)], `${key} exists`);
  }
  for (const key of Object.keys(CHOICE_DATA)) {
    const [pointId, index] = key.split("#");
    const authored = PROBLEMS[pointId!]![Number(index)]!;
    assert.notEqual(authored.kind, "choice", key);
    assert.ok(!isFillIn(authored), `${key} is a fill-in, needs no options`);
  }
  // PROBLEMS stays as authored; a problem put in later is served as written.
  const { pointId: id, index } = converted("expr");
  const original = PROBLEMS[id]!;
  assert.equal(BANK[id]![index]!.kind, "choice");
  try {
    PROBLEMS[id] = original.map((problem) => ({ ...problem }));
    assert.deepEqual(BANK[id], PROBLEMS[id]);
  } finally {
    PROBLEMS[id] = original;
  }
  // The source is the authored problem, with an added solution if it had none.
  const { explanation: _, ...source } = sourceOf(BANK[id]![index]!);
  const { explanation: __, ...authored } = original[index]!;
  assert.deepEqual(source, authored);
});

test("bank: the right option's place is fixed by the problem and spread over A–D", () => {
  const slots = [0, 0, 0, 0];
  for (const { key, problem } of served) {
    if (problem.kind !== "choice" || !problem.source || problem.source.kind === "choice")
      continue;
    const at = problem.questions[0]!.options.findIndex(
      (o) => o.id === problem.questions[0]!.answer,
    );
    assert.equal(at, rightSlot(key), key);
    slots[at]!++;
  }
  // 125 converted problems: each letter at least 20 times.
  assert.equal(
    slots.reduce((a, b) => a + b),
    125,
  );
  assert.ok(Math.min(...slots) >= 20, `slots ${slots}`);
  // Served twice, the same.
  assert.deepEqual(BANK["derivative-chain"], BANK["derivative-chain"]);
});

test("bank: every converted problem's options pass the program checks", () => {
  for (const [key, data] of Object.entries(CHOICE_DATA)) {
    const [pointId, index] = key.split("#");
    const source = PROBLEMS[pointId!]![Number(index)] as
      | ScalarProblem
      | MultiProblem;
    assert.deepEqual(choiceProblems(source, data), [], key);
  }
});

test("bank: the checks catch a wrong right answer, a duplicate and a missing +C", () => {
  const source: ScalarProblem = {
    kind: "antiderivative",
    text: "求 $\\int 2x\\,dx$。",
    answer: "x^2",
  };
  const problems = choiceProblems(source, {
    right: "x^2+2x+C",
    wrong: [
      ["x^2+C", "x^2"],
      ["x^2+C", "x^2"],
      ["2x^2", "2*x^2"],
    ],
  });
  assert.ok(problems.some((p) => p.startsWith("right[0]")));
  assert.ok(problems.some((p) => /same text/.test(p)));
  assert.ok(problems.some((p) => /\+C/.test(p)));
  assert.ok(problems.some((p) => /not provably different/.test(p)));
});

test("judge: plain numbers are equal as rationals", () => {
  const spec = (answer: string): ScalarProblem => ({
    kind: "number",
    text: "",
    answer,
  });
  for (const [answer, input] of [
    ["1/2", "0.5"],
    ["0.5", "1/2"],
    ["-3/4", "-0.75"],
    ["-0.75", "-3/4"],
    ["3", "6/2"],
  ])
    assert.equal(judge(spec(answer), input).verdict, "correct", `${answer} ${input}`);
  for (const [answer, input] of [
    ["1/2", "0.49"],
    ["-3/4", "3/4"],
  ])
    assert.equal(judge(spec(answer), input).verdict, "incorrect", `${answer} ${input}`);
});

test("bank: a 0.5.0 page's typed answer is judged against the authored problem", () => {
  const { problem } = converted("expr");
  assert.equal(answeredAs(problem, ["A"]), problem);
  assert.equal(answeredAs(problem, "x"), sourceOf(problem));
  const multi = converted("multi");
  const parts = (multi.authored as MultiProblem).parts.map(() => "1");
  assert.equal(answeredAs(multi.problem, parts), sourceOf(multi.problem));
  // A fill-in is served as written.
  const fill = served.find((s) => s.problem.kind === "number")!;
  assert.equal(answeredAs(fill.problem, "1"), fill.problem);
});

test("notes: every point has an intro and one note per formula; AI practice points exist", () => {
  const ids = CALC_MAP.chapters.flatMap((c) => c.points.map((p) => p.id));
  assert.equal(ids.length, 89);
  assert.deepEqual(Object.keys(POINT_NOTES).sort(), [...ids].sort());
  for (const id of ids)
    assert.equal(
      POINT_NOTES[id]!.formulaNotes.length,
      MAP_CARDS[id]!.formulas.length,
      id,
    );
  for (const id of Object.keys(POINT_PRACTICE)) assert.ok(ids.includes(id), id);
});

test("render: options, notes and example solutions all render as formulas", async () => {
  const md = new MarkdownRenderer(
    new FormulaRenderer(mkdtempSync(join(tmpdir(), "v41-bank-"))),
  );
  const fallback = (value: unknown): boolean =>
    Array.isArray(value)
      ? value.some(fallback)
      : !!value &&
        typeof value === "object" &&
        ((value as { t?: string }).t === "tex" ||
          Object.values(value).some(fallback));
  const texts = new Set<string>();
  for (const { problem } of served) {
    if (problem.kind === "choice")
      for (const question of problem.questions)
        for (const option of question.options) texts.add(option.text);
    if (problem.explanation) texts.add(problem.explanation);
  }
  for (const note of Object.values(POINT_NOTES)) {
    texts.add(note.intro);
    for (const text of note.formulaNotes) texts.add(text);
  }
  const failed: string[] = [];
  for (const text of texts)
    if (fallback(await md.render(text, INK.light))) failed.push(text);
  assert.deepEqual(failed, []);
});
