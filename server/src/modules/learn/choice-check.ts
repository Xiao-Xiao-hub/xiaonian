import { compareValues, judge } from "./judge.js";
import type { AnswerSpec, MultiProblem, ScalarProblem } from "./problems.js";
import type { ChoiceOption, ChoiceSource } from "./problems-choices.js";

// Program checks of one problem's options; an empty list means it
// passed. Used by tests/v41-learn-bank.test.ts and while drafting.
//   right     the right option's TeX judges correct against the source answer
//   reads     each wrong option's TeX reads back as its value
//   differs   each wrong option is provably different from the answer
//   distinct  no two options are the same, as TeX or as value
//   +C        an antiderivative's options all end in "+C"
export function choiceProblems(
  source: ScalarProblem | MultiProblem,
  data: ChoiceSource,
): string[] {
  const out: string[] = [];
  const specs: (AnswerSpec & { text: string })[] =
    source.kind === "multi"
      ? source.parts.map((part) => ({ ...part, text: source.text }))
      : [source];
  const n = specs.length;
  const right = Array.isArray(data.right) ? data.right : [data.right];
  if (right.length !== n) return [`right has ${right.length} values, need ${n}`];
  if (source.kind === "multi" && data.parts && data.parts.length !== n)
    out.push(`parts has ${data.parts.length} prefixes, need ${n}`);
  const wrong: ChoiceOption[][] = data.wrong.map((option) =>
    Array.isArray(option[0])
      ? (option as ChoiceOption[])
      : [option as ChoiceOption],
  );
  if (wrong.length !== 3) out.push(`need 3 wrong options, got ${wrong.length}`);
  right.forEach((tex, i) => {
    const verdict = judge(specs[i]!, tex).verdict;
    if (verdict !== "correct") out.push(`right[${i}] ${tex} judged ${verdict}`);
  });
  wrong.forEach((option, w) => {
    if (option.length !== n) {
      out.push(`wrong[${w}] has ${option.length} values, need ${n}`);
      return;
    }
    let differs = false;
    option.forEach(([tex, value], i) => {
      const spec = specs[i]!;
      const reads = judge({ ...spec, answer: value }, tex).verdict;
      if (reads !== "correct")
        out.push(`wrong[${w}][${i}] ${tex} does not read as ${value} (${reads})`);
      const same = compareValues(spec, value);
      if (same === false) differs = true;
      if (same === null && n === 1)
        out.push(`wrong[${w}] ${value}: cannot tell from the answer`);
    });
    if (!differs) out.push(`wrong[${w}] is not provably different`);
  });
  // Distinct: as text, and as values (some blank provably differs).
  const all: { tex: string; values: string[] }[] = [
    { tex: right.join("|"), values: specs.map((s) => s.answer) },
    ...wrong.map((option) => ({
      tex: option.map(([tex]) => tex).join("|"),
      values: option.map(([, value]) => value),
    })),
  ];
  const norm = (tex: string) => tex.replace(/\s+/g, "");
  for (let a = 0; a < all.length; a++)
    for (let b = a + 1; b < all.length; b++) {
      if (norm(all[a]!.tex) === norm(all[b]!.tex))
        out.push(`options ${a} and ${b} have the same text`);
      if (a === 0 || all[b]!.values.length !== n || all[a]!.values.length !== n)
        continue;
      const apart = all[a]!.values.some(
        (value, i) =>
          compareValues({ ...specs[i]!, answer: value }, all[b]!.values[i]!) ===
          false,
      );
      if (!apart) out.push(`wrong options ${a} and ${b} are not provably apart`);
    }
  if (specs.some((s) => s.kind === "antiderivative"))
    for (const tex of [...right, ...wrong.flat().map(([tex]) => tex)])
      if (!/\+\s*C\s*$/.test(tex)) out.push(`${tex}: an antiderivative needs +C`);
  return out;
}
