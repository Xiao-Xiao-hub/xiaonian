import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSteps, presolve } from "../server/src/shared/steps.js";

const PROBLEM = String.raw`求极限 $\lim_{x\to 0}\frac{e^{3x}-1-3x}{x^{2}}$`;
// A photographed draft as the vision model wrote it down: the derivative of
// e^{3x} lost its 3 in step 2, and the last line still says 9/2.
const DRAFT = [
  String.raw`1. 解：原式 $=\lim_{x\to 0}\dfrac{e^{3x}-1-3x}{x^2}$ （$\frac{0}{0}$ 型，洛必达）`,
  String.raw`$=\lim_{x\to 0}\dfrac{e^{3x}-3}{2x}$`,
  String.raw`$=\lim_{x\to 0}\dfrac{9e^{3x}}{2}$`,
  String.raw`$=\dfrac{9}{2}=4.5$`,
];

test("the first step whose value leaves the problem's is the wrong one", () => {
  const check = checkSteps(PROBLEM, DRAFT)!;
  assert.equal(check.wrong, 2);
  assert.equal(check.reference, "4.5");
  const two = check.items.find((t) => t.step === 2)!;
  assert.equal(two.same, false);
  assert.match(two.value, /不存在/);
  // A right answer at the end does not make up for it.
  assert.ok(check.items.filter((t) => t.step === 4).every((t) => t.same));
});

test("a right chain has no wrong step; a lim without its subscript takes the last one", () => {
  const check = checkSteps(PROBLEM, [
    String.raw`原式 $=\lim_{x\to 0}\frac{3e^{3x}-3}{2x}$`,
    String.raw`$=\lim\frac{9e^{3x}}{2}=\frac{9}{2}$`,
  ])!;
  assert.equal(check.wrong, null);
  assert.equal(check.items.length, 3);
});

test("side remarks are not read as steps", () => {
  const check = checkSteps(PROBLEM, [
    String.raw`令 $t=3x$`,
    String.raw`$f(0)=1$`,
    String.raw`当 $x\to0$ 时 $e^{3x}-1\sim 3x$`,
    String.raw`因为 $\lim_{x\to0}\frac{\sin x}{x}=1$`,
    String.raw`$=\lim_{x\to0}\frac{1+3x+\frac{9x^2}{2}+o(x^2)-1-3x}{x^2}$`,
    String.raw`$=\frac{9}{2}$`,
  ])!;
  assert.equal(check.wrong, null);
  assert.deepEqual(
    check.items.map((t) => t.step),
    [6],
  );
});

test("a chain that restates the problem is read from its start; one-sided limits too", () => {
  const check = checkSteps(PROBLEM, [
    String.raw`$\lim_{x\to 0}\frac{e^{3x}-1-3x}{x^{2}}=\lim_{x\to 0^{+}}\frac{3e^{3x}-3}{2x}=3$`,
  ])!;
  assert.deepEqual(
    check.items.map((t) => t.same),
    [true, true, false],
  );
  assert.equal(check.wrong, 1);
});

test("limits at infinity, and nothing to say about a problem that is not a limit", () => {
  const check = checkSteps(
    String.raw`$\lim_{x\to\infty}\left(1+\frac{2}{x}\right)^{x}$`,
    [String.raw`$=\lim_{x\to\infty}e^{x\ln(1+\frac{2}{x})}=e^{2}$`, String.raw`$=e$`],
  )!;
  assert.equal(check.wrong, 2);
  assert.equal(
    checkSteps(String.raw`求 $\int x e^{x}\,dx$`, ["分部积分", "符号"]),
    null,
  );
});

test("the program works out a single limit or definite integral before the model answers", () => {
  // Typed on a phone, and as the photo reader writes it.
  assert.equal(
    presolve("求极限 lim(x→0) (e^x − 1 − 5x)/x²")?.value,
    "不存在（两侧分别趋于 +∞ 和 −∞）",
  );
  assert.equal(presolve("lim x→0+ x ln x")?.value, "0");
  assert.equal(presolve(PROBLEM)?.value, "4.5");
  assert.equal(
    presolve(String.raw`计算定积分 $\int_{0}^{\frac{\pi}{2}} x\sin x\,dx$`)?.value,
    "1（数值积分）",
  );
  assert.equal(
    presolve(String.raw`计算 $\int_{-1}^{1}\frac{x^2}{1+e^x}dx$`)?.value,
    "0.333333（数值积分）",
  );
  // Nothing to say: two limits, a parameter, an indefinite integral, a concept.
  for (const text of [
    String.raw`(1) $\lim_{x\to0}\frac{\sin x}{x}$ (2) $\lim_{x\to\infty}\frac{1}{x}$`,
    String.raw`已知 $\lim_{x\to 0}\frac{\sin ax}{x}=3$，求 $a$`,
    String.raw`求 $\int x e^{x}\,dx$`,
    "什么是一致连续",
  ])
    assert.equal(presolve(text), null, text);
});

test("L'Hôpital is told by its denominator; on a limit that is not 0/0 it is a wrong step", () => {
  // The photographed draft above: step 2 differentiates the numerator wrongly,
  // and step 3 then applies L'Hôpital to −2/0.
  const draft = checkSteps(PROBLEM, DRAFT)!;
  const two = draft.items.find((t) => t.step === 2)!;
  assert.match(two.basis!, /上一步是未定式，而且分子求导有误/);
  const three = draft.items.find((t) => t.step === 3)!;
  assert.equal(three.illegal, true);
  assert.match(three.basis!, /分子趋于 -2、分母趋于 0，不是未定式/);
  assert.match(draft.reason!, /^第 2 步有误：/);
  // Scenario 2: the second L'Hôpital is the first wrong step.
  const twice = checkSteps(String.raw`$\lim_{x\to0}\frac{e^x-1-5x}{x^2}$`, [
    String.raw`$\lim_{x\to0}\frac{e^x-1-5x}{x^2}=\lim_{x\to0}\frac{e^x-5}{2x}$`,
    String.raw`$=\lim_{x\to0}\frac{e^x}{2}=\frac{1}{2}$`,
  ])!;
  assert.equal(twice.wrong, 2);
  assert.match(twice.reason!, /分子趋于 -4、分母趋于 0，不是未定式/);
  // Legal L'Hôpital says so; a Taylor step is left to the model.
  const right = checkSteps(PROBLEM, [
    String.raw`原式 $=\lim_{x\to 0}\frac{3e^{3x}-3}{2x}=\lim_{x\to 0}\frac{9e^{3x}}{2}=\frac{9}{2}$`,
  ])!;
  assert.equal(right.wrong, null);
  assert.ok(right.items.filter((t) => t.basis).every((t) => /上一步是未定式$/.test(t.basis!)));
  const taylor = checkSteps(PROBLEM, [
    String.raw`原式 $=\lim_{x\to 0}\frac{\frac{9}{2}x^2}{x^2}=\frac{9}{2}$`,
  ])!;
  assert.equal(taylor.wrong, null);
  assert.match(taylor.items[0]!.basis!, /认不出/);
});

test("a worked derivative: every expression after y' = is checked against the program's derivative", () => {
  const problem = String.raw`设 $y=\ln(1+x^2)e^{2x}$，求 $y'$`;
  // 回归样例 1： (e^{2x})' written as e^{2x}.
  const wrong = checkSteps(problem, [
    String.raw`$y'=\left[\ln(1+x^2)\right]'e^{2x}+\ln(1+x^2)\left(e^{2x}\right)'$`,
    String.raw`$=\frac{2x}{1+x^2}e^{2x}+\ln(1+x^2)e^{2x}$`,
    String.raw`$=e^{2x}\left(\frac{2x}{1+x^2}+\ln(1+x^2)\right)$`,
  ])!;
  assert.equal(wrong.kind, "derivative");
  assert.equal(wrong.wrong, 2);
  assert.match(wrong.reason!, /^第 2 步有误：这一步的式子不等于 y'，在 x=\S+ 处应为/);
  // A part's derivative written on its own line is checked against that part.
  const part = checkSteps(String.raw`设 y=ln(1+x²)·e^(2x)，求 y'`, [
    String.raw`$\left[\ln(1+x^2)\right]'=\frac{2x}{1+x^2}$`,
    String.raw`$(e^{2x})'=e^{2x}$`,
  ])!;
  assert.deepEqual(part.items.map((t) => [t.step, t.same]), [[1, true], [2, false]]);
  assert.match(part.reason!, /不等于 \(e\^\{2x\}\)'/);
  const right = checkSteps(String.raw`求函数 $y=x^2\sin x$ 的导数`, [
    String.raw`$\frac{dy}{dx}=2x\sin x+x^2\cos x$`,
  ])!;
  assert.equal(right.wrong, null);
  assert.equal(right.items.length, 1);
  // Implicit and second derivatives are not read.
  assert.equal(checkSteps(String.raw`设 $y=y(x)$ 由方程 $x^2+y^2=1$ 确定，求 $y'$`, [String.raw`$y'=-\frac{x}{y}$`]), null);
  assert.equal(checkSteps(String.raw`设 $y=x^3$，求 $y''$`, [String.raw`$y'=3x^2$`]), null);
});

test("the program works out an explicit first derivative too, as an expression", () => {
  const d = presolve(String.raw`设 y=ln(1+x²)·e^(2x)，求 y'`)!;
  assert.equal(d.tex, "y'");
  assert.match(d.value, /log\(x \^ 2 \+ 1\)[\s\S]*（log 是自然对数）$/);
  assert.equal(presolve(String.raw`设 $y=x^2\sin x$，求 $y'$`)!.value, "2 * x * sin(x) + x ^ 2 * cos(x)");
  assert.equal(presolve(String.raw`设 $y=x^3$，求 $y''$`), null);
  assert.equal(presolve(String.raw`设 $y=y(x)$ 由方程 $x^2+y^2=1$ 确定，求 $y'$`), null);
});

test("a problem typed on a phone is the reference; a note after \\quad is not part of the step", () => {
  // As the vision model wrote it down, without $…$: step 1 ends in a note.
  const check = checkSteps("求极限 lim(x→0) (e^(3x)−1−3x)/x²", [
    String.raw`1. 解：原式 = \lim_{x\to 0}\frac{e^{3x}-1-3x}{x^2}\quad (\frac{0}{0} 型，洛必达)`,
    String.raw`= \lim_{x\to 0}\frac{e^{3x}-3}{2x}`,
    String.raw`= \lim_{x\to 0}\frac{9e^{3x}}{2}`,
    String.raw`= \frac{9}{2} = 4.5`,
  ])!;
  assert.equal(check.reference, "4.5");
  assert.match(check.tex, /^\\lim_\{x\\to 0\}/);
  assert.equal(check.wrong, 2);
  assert.equal(check.items.find((t) => t.step === 3)!.illegal, true);
});
