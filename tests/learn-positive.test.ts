import assert from "node:assert/strict";
import test from "node:test";
import { judge } from "../server/src/modules/learn/judge.js";
import type { ScalarProblem } from "../server/src/modules/learn/problems.js";

const first: ScalarProblem = {
  kind: "expr",
  text: "在 $x>0$ 上求初值问题的解。",
  answer: "x^2+2*x",
  domain: "positive",
};
const second: ScalarProblem = { ...first, answer: "2*x-1/x" };
test("positive domain: Euler canonical, exp-log and absolute-value forms agree on x > 0", () => {
  for (const [problem, inputs] of [
    [
      first,
      [first.answer, "e^(2*ln(x))+2*e^(ln(x))", "x^2+2*abs(x)", "x*(x+2)"],
    ],
    [second, [second.answer, "2*e^(ln(x))-e^(-ln(x))", "2*abs(x)-1/abs(x)"]],
  ] as const)
    for (const input of inputs)
      assert.equal(judge(problem, input).verdict, "correct", input);
});
test("positive domain: wrong coefficients, initial values, constants and positive-domain holes cannot pass", () => {
  for (const problem of [first, second])
    for (const input of [
      `(${problem.answer})+1`,
      `(${problem.answer})-1`,
      "x^2",
      "2*x",
      "C*x^2+2*x",
      "ln(-x)",
      `(${problem.answer})+0*ln(x-1)`,
      `(${problem.answer})+sqrt(x-1)^2-x+1`,
    ])
      assert.notEqual(judge(problem, input).verdict, "correct", input);
  assert.equal(judge(first, "x^2-2*abs(x)").verdict, "incorrect");
  assert.equal(judge(second, "2*x+1/abs(x)").verdict, "incorrect");
});
test("positive domain: absent annotation keeps whole-domain comparison, and t remains supported", () => {
  const plain: ScalarProblem = { kind: "expr", text: "求表达式", answer: "x" };
  assert.equal(judge(plain, "abs(x)").verdict, "incorrect");
  assert.equal(
    judge({ ...plain, domain: "positive" }, "abs(x)").verdict,
    "correct",
  );
  assert.equal(
    judge({ ...first, var: "t", answer: "t^2+2*t" }, "e^(2*ln(t))+2*e^(ln(t))")
      .verdict,
    "correct",
  );
});
test("positive domain: transformed complexity remains bounded", () => {
  const many = Array.from({ length: 22 }, () => "x").join("+");
  const problem: ScalarProblem = { ...first, answer: "22*x" };
  const started = performance.now();
  assert.equal(judge(problem, many).verdict, "unsure");
  assert.ok(performance.now() - started < 1000);
});
