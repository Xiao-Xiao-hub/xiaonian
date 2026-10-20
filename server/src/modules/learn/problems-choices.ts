import { createHash } from "node:crypto";
import type {
  ChoiceProblem,
  MultiProblem,
  Problem,
  ScalarProblem,
} from "./problems.js";
import {
  CHOICE_DATA,
  EXPLANATIONS,
  FOURTH_OPTIONS,
  MERGED_CHOICES,
} from "./problems-choices-data.js";

// 0.6.0 : the map bank keeps two kinds of problem. A problem whose
// answer is a plain number (integer, decimal or fraction; every blank of a
// multi problem) stays a fill-in; every other one is served as single choice,
// since typing maths on a phone is hard. The authored problem stays as
// `source`: its answer is what the options were checked against, and the
// judge tests still read it.
//
// One option: [tex, value]. `tex` is what the learner sees (TeX without `$`);
// `value` is the same in the answer syntax of problems.ts, for the program
// checks only (tests/v41-learn-bank.test.ts): the right option must judge
// correct against the source, each wrong one must be provably different, and
// each `tex` must read back as its `value`.
export type ChoiceOption = [tex: string, value: string];
export type ChoiceSource = {
  // TeX of the right answer; a multi problem has one per blank.
  right: string | string[];
  // The three wrong options; a multi problem's option is one per blank.
  wrong: [Wrong, Wrong, Wrong];
  // Replaces the statement where it asked to type ("两空分别写…").
  text?: string;
  // Multi problems: the TeX written before each blank's value ("u(t)=").
  parts?: string[];
};
type Wrong = ChoiceOption | ChoiceOption[];
export type ServedChoice = ChoiceProblem & {
  source: ScalarProblem | MultiProblem;
};

// A plain number as the numeric keypad writes it: 3, -0.5, -3/4.
export const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?(?:\/\d+)?$/;
export const isFillIn = (problem: Problem) =>
  problem.kind === "number"
    ? PLAIN_NUMBER.test(problem.answer.replace(/\s+/g, ""))
    : problem.kind === "multi" &&
      problem.parts.every(
        (part) =>
          part.kind === "number" &&
          PLAIN_NUMBER.test(part.answer.replace(/\s+/g, "")),
      );

const IDS = ["A", "B", "C", "D"] as const;
// Where the right option goes: fixed by the problem's key, spread over A–D.
export const rightSlot = (key: string) =>
  createHash("sha256").update(`choice:${key}`).digest()[0]! % 4;

// The option text: inline TeX; a multi option lists its blanks.
export function optionText(
  value: string | string[],
  parts: string[] | undefined,
) {
  if (!Array.isArray(value)) return `$${value}$`;
  return value.map((tex, i) => `$${parts?.[i] ?? ""}${tex}$`).join("，");
}

export function toChoice(
  key: string,
  problem: ScalarProblem | MultiProblem,
  data: ChoiceSource,
): ServedChoice {
  const wrong = data.wrong.map((option) =>
    Array.isArray(option[0])
      ? (option as ChoiceOption[]).map(([tex]) => tex)
      : (option as ChoiceOption)[0],
  );
  const slot = rightSlot(key);
  const texts = [...wrong];
  texts.splice(slot, 0, data.right);
  const { hint, explanation, teacherReviewed } = problem;
  return {
    kind: "choice",
    text: data.text ?? problem.text,
    ...(teacherReviewed ? { teacherReviewed } : {}),
    ...(hint ? { hint } : {}),
    ...(explanation ? { explanation } : {}),
    questions: [
      {
        prompt: "",
        options: texts.map((value, i) => ({
          id: IDS[i]!,
          text: optionText(value, data.parts),
        })),
        answer: IDS[slot]!,
      },
    ],
    source: problem,
  };
}

// An authored choice question with three options gets its fourth at a fixed
// slot; the letters are given again in order.
function withFourth(
  key: string,
  question: ChoiceProblem["questions"][number],
  extra: string,
) {
  const texts = question.options.map((option) => option.text);
  const right = question.options.findIndex((o) => o.id === question.answer);
  const slot = rightSlot(`${key}:${question.prompt}`);
  texts.splice(slot, 0, extra);
  const at = right >= slot ? right + 1 : right;
  return {
    ...question,
    options: texts.map((text, i) => ({ id: IDS[i]!, text })),
    answer: IDS[at]!,
  };
}

// One problem as served : a problem that is not a fill-in and has its
// options becomes single choice; every choice question has four options.
// `key` is "pointId#index" in the authored bank; a missing entry is left as
// it is (the content test fails on it).
function serveOne(key: string, authored: Problem): Problem {
  const explanation = EXPLANATIONS[key];
  const problem: Problem = explanation
    ? { ...authored, explanation }
    : authored;
  if (problem.kind === "choice") {
    const merged = MERGED_CHOICES[key];
    const fourth = FOURTH_OPTIONS[key];
    if (merged)
      return {
        ...problem,
        source: problem,
        text: merged.text,
        questions: [
          {
            prompt: "",
            options: merged.options.map((text, i) => ({ id: IDS[i]!, text })),
            answer: IDS[merged.right]!,
          },
        ],
      };
    if (fourth)
      return {
        ...problem,
        source: problem,
        questions: problem.questions.map((question, i) =>
          fourth[i] ? withFourth(key, question, fourth[i]) : question,
        ),
      };
    return problem;
  }
  if (isFillIn(problem)) return problem;
  const data = CHOICE_DATA[key];
  return data ? toChoice(key, problem, data) : problem;
}

// The bank as served, a live view of the authored bank: the overlays above
// belong to each authored problem as loaded (by identity), so a problem put
// in later (a test fixture, a copy) is served as written.
export function serveBank(
  authored: Record<string, Problem[]>,
): Record<string, Problem[]> {
  const keys = new Map<Problem, string>();
  for (const [pointId, list] of Object.entries(authored))
    list.forEach((problem, index) => keys.set(problem, `${pointId}#${index}`));
  const served = new WeakMap<Problem, Problem>();
  const serve = (problem: Problem) => {
    const key = keys.get(problem);
    if (key === undefined) return problem;
    let out = served.get(problem);
    if (!out) served.set(problem, (out = serveOne(key, problem)));
    return out;
  };
  return new Proxy(authored, {
    get: (target, pointId) =>
      typeof pointId === "string" && Object.hasOwn(target, pointId)
        ? target[pointId]!.map(serve)
        : undefined,
    set: () => false,
    deleteProperty: () => false,
  });
}

// What a problem was authored as: the source of a served choice, else itself.
export const sourceOf = (problem: Problem): Problem =>
  (problem.kind === "choice" && problem.source) || problem;

// The point page APIs (GET /v1/learn/points/:id, …/answer, …/report) keep
// an authored choice problem as authored, so a 0.5.0 page's option ids stay
// valid: its fourth option and the merged form are served by the bank APIs.
export const pageForm = (problem: Problem): Problem =>
  problem.kind === "choice" && problem.source?.kind === "choice"
    ? problem.source
    : problem;

// A 0.5.0 page opened before 0.6.0 still shows the authored form: typed input
// for a problem now served as choice (a string, or one value per blank) is
// judged against the authored problem. The served form takes one option id.
export function answeredAs(problem: Problem, input: unknown): Problem {
  if (problem.kind !== "choice" || !problem.source) return problem;
  if (problem.source.kind === "choice") return problem;
  const typed =
    typeof input === "string" ||
    (Array.isArray(input) && input.length !== problem.questions.length);
  return typed ? problem.source : problem;
}
