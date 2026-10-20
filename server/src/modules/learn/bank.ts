import type { AnswerInput, Problem } from "./problems.js";

// 0.6.0 题库 : one bank problem as the 练题 page shows it, in one of
// the two formats. Markdown here; routes.ts renders it.
//   choice  one or more questions, each with options A–D; the answer is the
//           option ids, one per question (a string is fine for one question)
//   blanks  plain numbers typed on the numeric keypad: one blank, or one per
//           part of a multi problem (an array, in order)
export type BankFormat = "choice" | "blanks";
export type BankProblem = {
  index: number;
  total: number;
  format: BankFormat;
  text: string;
  questions?: {
    prompt: string;
    options: { id: string; text: string }[];
  }[];
  blanks?: { label: string; note: string | null }[];
  hasHint: boolean;
};

export function bankProblem(
  problem: Problem,
  index: number,
  total: number,
): BankProblem {
  const common = {
    index,
    total,
    text: problem.text,
    hasHint: !!problem.hint,
  };
  if (problem.kind === "choice")
    return {
      ...common,
      format: "choice",
      questions: problem.questions.map((question) => ({
        prompt: question.prompt,
        options: question.options.map(({ id, text }) => ({ id, text })),
      })),
    };
  return {
    ...common,
    format: "blanks",
    blanks:
      problem.kind === "multi"
        ? problem.parts.map((part) => ({
            label: part.label,
            note: part.note ?? null,
          }))
        : [{ label: "", note: problem.note ?? null }],
  };
}

// The bank's answer shape → the judge's: one choice question takes a bare id,
// one blank a bare string; a one-item array for one blank is unwrapped.
export function bankInput(problem: Problem, input: AnswerInput): AnswerInput {
  if (problem.kind === "choice")
    return typeof input === "string" ? [input] : input;
  if (problem.kind !== "multi" && Array.isArray(input) && input.length === 1)
    return input[0]!;
  return input;
}

// The right answer as Markdown, and the right option of each question.
// `tex` turns a canonical answer into display TeX (service.ts standardTex).
export function correctOf(
  problem: Problem,
  tex: (answer: string, v: string) => string | null,
) {
  if (problem.kind === "choice") {
    const picked = problem.questions.map(
      (question) =>
        question.options.find((option) => option.id === question.answer)!,
    );
    return {
      options: picked.map((option) => option.id),
      text: picked
        .map((option, i) => {
          const prompt = problem.questions[i]!.prompt;
          return `${prompt ? `${prompt} ` : ""}${option.id}. ${option.text}`;
        })
        .join("\n\n"),
    };
  }
  const shown = (answer: string, v: string) => {
    const t = tex(answer, v);
    return t === null ? answer : `$${t}$`;
  };
  return {
    options: null,
    text:
      problem.kind === "multi"
        ? problem.parts
            .map((part) => `${part.label}：${shown(part.answer, part.var ?? "x")}`)
            .join("；")
        : shown(problem.answer, problem.var ?? "x"),
  };
}
