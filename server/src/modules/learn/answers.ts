import { AppError } from "../../shared/domain.js";
import { judge, MAX_INPUT, type Judgement } from "./judge.js";
import type { AnswerInput, Problem, ScalarProblem } from "./problems.js";

export const MAX_PARTS = 8;
export const MAX_TOTAL_INPUT = 800;
export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 6;
export const MAX_OPTION_ID = 16;
export const isScalarProblem = (problem: Problem): problem is ScalarProblem =>
  problem.kind !== "multi" && problem.kind !== "choice";

// A number typed with two signs in a row ("--3", "+-3", "3--2") is no
// answer to a number problem, though the parser would read it.
const DOUBLE_SIGN = /[+\-−]\s*[+\-−]/;
// Also used by report: reject an invalid shape before judging or writing.
export function validateInput(
  problem: Problem,
  input: unknown,
): asserts input is AnswerInput {
  const invalid = () => {
    throw new AppError(400, "VALIDATION_ERROR", "请按题目要求填写完整答案");
  };
  if (isScalarProblem(problem)) {
    if (
      typeof input !== "string" ||
      input.length < 1 ||
      input.length > MAX_INPUT ||
      (problem.kind === "number" && DOUBLE_SIGN.test(input))
    )
      invalid();
    return;
  }
  if (!Array.isArray(input)) return invalid();
  if (problem.kind === "multi") {
    if (
      problem.parts.length < 2 ||
      problem.parts.length > MAX_PARTS ||
      input.length !== problem.parts.length ||
      input.some(
        (part, i) =>
          typeof part !== "string" ||
          !part.trim() ||
          part.length > MAX_INPUT ||
          (problem.parts[i]!.kind === "number" && DOUBLE_SIGN.test(part)),
      ) ||
      input.reduce((total, part) => total + part.length, 0) > MAX_TOTAL_INPUT
    )
      invalid();
  } else if (
    // 0.6.0 : a problem served as single choice has one question.
    problem.questions.length < 1 ||
    problem.questions.length > MAX_QUESTIONS ||
    input.length !== problem.questions.length ||
    input.some(
      (id, i) =>
        typeof id !== "string" ||
        !id.length ||
        id.length > MAX_OPTION_ID ||
        !problem.questions[i]!.options.some((option) => option.id === id),
    )
  )
    invalid();
}

export type ItemJudgement = Judgement & {
  label: string;
  format: "math" | "markdown";
};
export type Assessment = Judgement & { items?: ItemJudgement[] };
export function judgeAnswer(problem: Problem, input: AnswerInput): Assessment {
  validateInput(problem, input);
  if (isScalarProblem(problem)) return judge(problem, input as string);
  const answers = input as string[];
  const items: ItemJudgement[] =
    problem.kind === "multi"
      ? problem.parts.map((part, i) => ({
          ...judge({ ...part, text: problem.text }, answers[i]!),
          label: part.label,
          format: "math",
        }))
      : problem.questions.map((question, i) => {
          const selected = question.options.find(
            (option) => option.id === answers[i],
          )!;
          return {
            label: `第${i + 1}问`,
            format: "markdown",
            verdict: selected.id === question.answer ? "correct" : "incorrect",
            reason: null,
            read: `${selected.id}. ${selected.text}`,
          };
        });
  // A definite wrong part makes the whole answer wrong even if another is unsure.
  const deciding =
    items.find((item) => item.verdict === "incorrect") ??
    items.find((item) => item.verdict === "unsure");
  return {
    verdict: deciding?.verdict ?? "correct",
    reason: deciding?.reason ?? null,
    read: null,
    items,
  };
}

// Private canonical input for content checks; never called on a public problem.
export const canonicalInput = (problem: Problem): AnswerInput =>
  problem.kind === "multi"
    ? problem.parts.map((part) => part.answer)
    : problem.kind === "choice"
      ? problem.questions.map((question) => question.answer)
      : problem.answer;

// Deliberate allow-list: no nested answer or full hint/explanation leaves here.
export function publicProblem(problem: Problem, index: number) {
  const common = {
    index,
    text: problem.text,
    ...(problem.hint ? { hasHint: true as const } : {}),
    ...(problem.explanation ? { hasExplanation: true as const } : {}),
  };
  if (problem.kind === "multi")
    return {
      ...common,
      kind: problem.kind,
      parts: problem.parts.map((part) => ({
        label: part.label,
        kind: part.kind,
        var: part.var ?? "x",
        note: part.note ?? null,
      })),
    };
  if (problem.kind === "choice")
    return {
      ...common,
      kind: problem.kind,
      questions: problem.questions.map((question) => ({
        prompt: question.prompt,
        options: question.options.map((option) => ({
          id: option.id,
          text: option.text,
        })),
      })),
    };
  return {
    ...common,
    kind: problem.kind,
    var: problem.var ?? "x",
    note: problem.note ?? null,
  };
}
