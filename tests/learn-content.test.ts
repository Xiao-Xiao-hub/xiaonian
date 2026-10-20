import test from "node:test";
import assert from "node:assert/strict";
import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";
import {
  PROBLEMS,
  type AnswerSpec,
  type Problem,
} from "../server/src/modules/learn/problems.js";
import { KEY_VARIANTS } from "../server/src/modules/learn/problems-key-variants.js";
import { MAX_INPUT } from "../server/src/modules/learn/judge.js";
import {
  canonicalInput,
  MAX_PARTS,
  MAX_QUESTIONS,
  MAX_OPTIONS,
  MAX_OPTION_ID,
  MAX_TOTAL_INPUT,
  publicProblem,
  validateInput,
} from "../server/src/modules/learn/answers.js";
import { need } from "../server/src/modules/learn/summary.js";

const nonempty = (value: unknown, label: string) =>
  assert.ok(typeof value === "string" && value.trim().length > 0, label);
const scalar = (part: AnswerSpec, label: string) => {
  assert.ok(["number", "expr", "antiderivative"].includes(part.kind), label);
  nonempty(part.answer, `${label}: answer`);
  assert.ok(
    part.answer.length <= MAX_INPUT,
    `${label}: canonical input length`,
  );
  assert.ok(
    part.var === undefined || part.var === "x" || part.var === "t",
    label,
  );
  assert.ok(
    part.domain === undefined ||
      (part.domain === "positive" && part.kind === "expr"),
    label,
  );
};

test("learn content: every unique map point keeps two base variants and declared extras", () => {
  const ids = CALC_MAP.chapters.flatMap((chapter) =>
    chapter.points.map((point) => point.id),
  );
  assert.equal(ids.length, 89);
  assert.equal(
    new Set(ids).size,
    ids.length,
    "point IDs cannot overlap between chapters",
  );
  assert.deepEqual(
    Object.keys(PROBLEMS).sort(),
    [...ids].sort(),
    "no missing or orphan problem IDs",
  );
  let variants = 0;
  for (const id of ids) {
    const pair = PROBLEMS[id]!;
    assert.equal(pair.length, 2 + (KEY_VARIANTS[id]?.length ?? 0), `${id}: variants`);
    assert.notDeepEqual(
      canonicalInput(pair[0]!),
      canonicalInput(pair[1]!),
      `${id}: review answer differs`,
    );
    // A choice pair may share its introduction while changing its subquestions.
    assert.notDeepEqual(
      publicProblem(pair[0]!, 0),
      publicProblem(pair[1]!, 0),
      `${id}: review question differs`,
    );
    variants += pair.length;
  }
  assert.equal(
    variants,
    178 + Object.values(KEY_VARIANTS).reduce((sum, extra) => sum + extra.length, 0),
  );
});

test("learn content: authored answers fit the supported bounded input contracts", () => {
  for (const [id, pair] of Object.entries(PROBLEMS)) {
    for (const [index, problem] of pair.entries()) {
      const label = `${id}/${index}`;
      nonempty(problem.text, `${label}: text`);
      assert.ok(problem.text.length <= 8000, `${label}: render route limit`);
      for (const field of ["hint", "explanation"] as const)
        if (problem[field] !== undefined) {
          nonempty(problem[field], `${label}: ${field}`);
          assert.ok(
            problem[field]!.length <= 8000,
            `${label}: ${field} render limit`,
          );
        }
      if (problem.kind === "multi") {
        assert.ok(
          problem.parts.length >= 2 && problem.parts.length <= MAX_PARTS,
          label,
        );
        const labels = problem.parts.map((part) => part.label);
        assert.equal(
          new Set(labels).size,
          labels.length,
          `${label}: unique part labels`,
        );
        for (const [i, part] of problem.parts.entries()) {
          nonempty(part.label, `${label}/${i}: label`);
          scalar(part, `${label}/${i}`);
        }
        assert.ok(
          problem.parts.reduce((n, part) => n + part.answer.length, 0) <=
            MAX_TOTAL_INPUT,
          label,
        );
      } else if (problem.kind === "choice") {
        assert.ok(
          problem.questions.length >= 2 &&
            problem.questions.length <= MAX_QUESTIONS,
          label,
        );
        for (const [i, question] of problem.questions.entries()) {
          nonempty(question.prompt, `${label}/${i}: prompt`);
          assert.ok(
            question.options.length >= 2 &&
              question.options.length <= MAX_OPTIONS,
            label,
          );
          const ids = question.options.map((option) => option.id);
          assert.equal(
            new Set(ids).size,
            ids.length,
            `${label}/${i}: unique option IDs`,
          );
          assert.equal(
            question.options.filter((option) => option.id === question.answer)
              .length,
            1,
            `${label}/${i}: exactly one keyed option`,
          );
          for (const option of question.options) {
            assert.match(
              option.id,
              /^[A-Z]$/,
              `${label}/${i}: opaque option ID`,
            );
            assert.ok(option.id.length <= MAX_OPTION_ID, label);
            nonempty(option.text, `${label}/${i}/${option.id}: option text`);
          }
        }
      } else {
        scalar(problem, label);
      }
      assert.doesNotThrow(
        () => validateInput(problem as Problem, canonicalInput(problem)),
        `${label}: canonical input accepted`,
      );
    }
  }
});

test("learn content: available problems cannot block any chapter rank threshold", () => {
  for (const chapter of CALC_MAP.chapters) {
    for (const tier of ["基础", "重点", "难点"] as const) {
      const points = chapter.points.filter((point) => point.tier === tier);
      const ready = points.filter(
        (point) => (PROBLEMS[point.id]?.length ?? 0) >= 2,
      ).length;
      assert.ok(
        ready >= need(points.length),
        `${chapter.id}/${tier}: ${ready} ready, ${need(points.length)} needed`,
      );
    }
    // Extension points do not unlock ranks, but still need both problem variants.
    for (const point of chapter.points.filter((point) => point.tier === "拓展"))
      assert.equal(
        (PROBLEMS[point.id]?.length ?? 0) >= 2,
        true,
        `${point.id}: extension content available`,
      );
  }
});
