import { KEY_VARIANTS } from "./problems-key-variants.js";
import { serveBank } from "./problems-choices.js";

// Prewritten learning-map problems: 89 points with an initial and a review variant.
// Generated once from the content workflow's problems.json
// (sha256 18da947d0c1ac9e28cccc4a14ba875b295e212f4a8a5b234bb60e4e77c3edaa6);
// this file is now the source. Problems and answers stay on the server :
// only the judge reads `answer`. Initial work uses problems[0]; due reviews use
// problems[1], falling back to problems[0]. Missing points remain 题目准备中.
// S5 variants: AI-drafted, independently derived and program-checked (AI simulation).
// problems2.json sha256 caedc4093b5a2cf8b84ee169e9012057f243b69df7e6f58d2eb648d55a8b4813.
// Provenance : every problem here was drafted by AI, including the first
// 50 from the content workflow, and none has been reviewed by a teacher yet.
// provenance remains in the bank/admin; learners see the page-level AI notice.
export type ScalarKind = "number" | "expr" | "antiderivative";
export type ProblemKind = ScalarKind | "multi" | "choice";
export type AnswerSpec = {
  kind: ScalarKind;
  answer: string; // canonical answer in verify.ts syntax; antiderivatives end with "+ C"
  var?: "x" | "t"; // variable of expr / antiderivative answers, default "x"
  note?: string; // one-line input hint under the answer box
  // Initial-value problems whose solution lives on x > 0: compare only where the
  // canonical answer is defined, so ln|x| or ln x^2 forms count (judge.ts).
  onAnswerDomain?: true;
  // Only for expression problems whose statement explicitly specifies x > 0
  // (or t > 0). Unlike onAnswerDomain, the reference need not contain a log.
  domain?: "positive";
};
type ProblemBase = {
  text: string; // Markdown, maths in $...$ (TeX); never contains the answer
  teacherReviewed?: true; // set only after a named teacher has checked it
  hint?: string;
  explanation?: string;
};
export type ScalarProblem = ProblemBase & AnswerSpec;
export type MultiProblem = ProblemBase & {
  kind: "multi";
  parts: (AnswerSpec & { label: string })[];
};
export type ChoiceProblem = ProblemBase & {
  kind: "choice";
  questions: {
    prompt: string;
    options: { id: string; text: string }[];
    answer: string;
  }[];
  // The authored problem of one served otherwise : a fill-in served as
  // single choice, or a choice problem given a fourth option or merged.
  source?: Problem;
};
export type Problem = ScalarProblem | MultiProblem | ChoiceProblem;
export type AnswerInput = string | string[];
// 78 reviewed AI-drafted problems; independent mathematical and judge evidence in content-next.
// A sha256: 20a2236f4fcc3190c8d016081f3fd1961362ecc2821bb63ec8f4d8af1af8495d.
// B sha256: e017c0f00f0c208462e18e7c49982cc09260fe31c7c149b857ea262f60ccab8d.
export const PROBLEMS: Record<string, Problem[]> = {
  "limit-rules": [
    {
      kind: "number",
      text: "求 $\\lim_{x\\to+\\infty}\\left(\\sqrt{x^2+x}-x\\right)$。",
      answer: "1/2",
    },
    {
      kind: "number",
      text: "求 $\\lim_{x\\to+\\infty}\\left(\\sqrt{x^2+4x}-x\\right)$。",
      answer: "2",
    },
  ],
  "limit-squeeze": [
    {
      kind: "number",
      text: "求 $\\lim_{n\\to\\infty}\\left(\\frac{n}{n^2+1}+\\frac{n}{n^2+2}+\\cdots+\\frac{n}{n^2+n}\\right)$。",
      answer: "1",
    },
    {
      kind: "number",
      text: "求 $\\lim_{n\\to\\infty}\\left(\\frac{n}{2n^2+1}+\\frac{n}{2n^2+2}+\\cdots+\\frac{n}{2n^2+n}\\right)$。",
      answer: "1/2",
    },
  ],
  "limit-important-sin": [
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}\\frac{1-\\cos 2x}{x\\sin x}$。",
      answer: "2",
    },
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}\\frac{1-\\cos 6x}{x\\sin 3x}$。",
      answer: "6",
    },
  ],
  "limit-important-e": [
    {
      kind: "number",
      text: "求 $\\lim_{x\\to\\infty}\\left(\\frac{x+1}{x-1}\\right)^{x}$。",
      answer: "e^2",
      note: "写精确值",
    },
    {
      kind: "number",
      text: "求 $\\lim_{x\\to\\infty}\\left(\\frac{x+2}{x-2}\\right)^{x}$。",
      answer: "e^4",
      note: "写精确值",
    },
  ],
  "limit-equivalent": [
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}\\frac{\\tan x-\\sin x}{x^3}$。",
      answer: "1/2",
    },
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}\\frac{\\tan 2x-\\sin 2x}{x^3}$。",
      answer: "4",
    },
  ],
  "limit-1-to-inf": [
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}(\\cos x)^{1/x^2}$。",
      answer: "e^(-1/2)",
      note: "写精确值",
    },
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}(\\cos 2x)^{1/x^2}$。",
      answer: "e^(-2)",
      note: "写精确值",
    },
  ],
  "limit-continuity": [
    {
      kind: "number",
      text: "设 $x>0$ 时 $f(x)=\\frac{\\sqrt{1+x}-1}{x}$，$x\\le 0$ 时 $f(x)=a+x$。$a$ 取何值时 $f(x)$ 在 $x=0$ 处连续？",
      answer: "1/2",
      note: "只填 a 的值",
    },
    {
      kind: "number",
      text: "设 $x>0$ 时 $f(x)=\\frac{\\sqrt{4+x}-2}{x}$，$x\\le 0$ 时 $f(x)=a+x$。$a$ 取何值时 $f(x)$ 在 $x=0$ 处连续？",
      answer: "1/4",
      note: "只填 a 的值",
    },
  ],
  "derivative-definition": [
    {
      kind: "number",
      text: "设 $f'(x_0)=2$，求 $\\lim_{h\\to 0}\\frac{f(x_0+2h)-f(x_0-h)}{h}$。",
      answer: "6",
    },
    {
      kind: "number",
      text: "设 $f'(x_0)=3$，求 $\\lim_{h\\to 0}\\frac{f(x_0+h)-f(x_0-2h)}{h}$。",
      answer: "9",
    },
  ],
  "derivative-rules": [
    {
      kind: "expr",
      text: "求 $y=(x^2+1)\\arctan x$ 的导数 $y'$。",
      answer: "2*x*arctan(x) + 1",
    },
    {
      kind: "expr",
      text: "求 $y=(x^3+x)\\arctan x$ 的导数 $y'$。",
      answer: "(3*x^2 + 1)*arctan(x) + x",
    },
  ],
  "derivative-chain": [
    {
      kind: "expr",
      text: "求 $y=\\ln\\left(x+\\sqrt{1+x^2}\\right)$ 的导数 $y'$。",
      answer: "1/sqrt(1+x^2)",
    },
    {
      kind: "expr",
      text: "求 $y=\\ln\\left(x+\\sqrt{4+x^2}\\right)$ 的导数 $y'$。",
      answer: "1/sqrt(4+x^2)",
    },
  ],
  "derivative-second": [
    {
      kind: "expr",
      text: "设 $y=\\ln(1+x^2)$，求 $y''$。",
      answer: "2*(1-x^2)/(1+x^2)^2",
    },
    {
      kind: "expr",
      text: "设 $y=\\ln(4+x^2)$，求 $y''$。",
      answer: "2*(4-x^2)/(4+x^2)^2",
    },
  ],
  "derivative-higher": [
    {
      kind: "expr",
      text: "设 $y=x^2e^{-x}$，求 $y^{(10)}$。",
      answer: "e^(-x)*(x^2-20*x+90)",
    },
    {
      kind: "expr",
      text: "设 $y=x^2e^{-x}$，求 $y^{(8)}$。",
      answer: "e^(-x)*(x^2-16*x+56)",
    },
  ],
  "derivative-log": [
    {
      kind: "expr",
      text: "求 $y=x^{\\sin x}$（$x>0$）的导数 $y'$。",
      answer: "x^(sin(x))*(cos(x)*ln(x) + sin(x)/x)",
    },
    {
      kind: "expr",
      text: "求 $y=x^{\\sin 2x}$（$x>0$）的导数 $y'$。",
      answer: "x^(sin(2*x))*(2*cos(2*x)*ln(x) + sin(2*x)/x)",
    },
  ],
  "derivative-related-rates": [
    {
      kind: "number",
      text: "长 $5\\,\\mathrm{m}$ 的梯子靠在竖直的墙上，梯子底端以 $1\\,\\mathrm{m/s}$ 的速度沿地面离开墙脚。当底端离墙 $3\\,\\mathrm{m}$ 时，梯子顶端下滑的速度大小是多少（单位：$\\mathrm{m/s}$）？",
      answer: "3/4",
      note: "只填数值，单位 m/s 不用写",
    },
    {
      kind: "number",
      text: "长 $10\\,\\mathrm{m}$ 的梯子靠在竖直的墙上，梯子底端以 $3\\,\\mathrm{m/s}$ 的速度沿地面离开墙脚。当底端离墙 $8\\,\\mathrm{m}$ 时，梯子顶端下滑的速度大小是多少（单位：$\\mathrm{m/s}$）？",
      answer: "4",
      note: "只填数值，单位 m/s 不用写",
    },
  ],
  "application-lhopital": [
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}\\frac{\\tan x-x}{x-\\sin x}$。",
      answer: "2",
    },
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}\\frac{\\tan 2x-2x}{x-\\sin x}$。",
      answer: "16",
    },
  ],
  "application-lhopital-other": [
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}\\left(\\frac{1}{x}-\\frac{1}{e^x-1}\\right)$。",
      answer: "1/2",
    },
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}\\left(\\frac{1}{x}-\\frac{2}{e^{2x}-1}\\right)$。",
      answer: "1",
    },
  ],
  "application-taylor-limit": [
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}\\frac{\\cos x-e^{-x^2/2}}{x^4}$。",
      answer: "-1/12",
      note: "写精确值",
    },
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}\\frac{\\cos(\\sqrt{2}x)-e^{-x^2}}{x^4}$。",
      answer: "-1/3",
      note: "写精确值",
    },
  ],
  "application-taylor-remainder": [
    {
      kind: "number",
      text: "用 $e\\approx 1+1+\\frac{1}{2!}+\\cdots+\\frac{1}{n!}$ 计算 $e$，要使误差小于 $10^{-3}$，$n$ 至少取多少？",
      answer: "6",
      note: "只填数字",
    },
    {
      kind: "number",
      text: "用 $e\\approx 1+1+\\frac{1}{2!}+\\cdots+\\frac{1}{n!}$ 计算 $e$，要使误差小于 $10^{-4}$，$n$ 至少取多少？",
      answer: "7",
      note: "只填数字",
    },
  ],
  "indefinite-basic": [
    {
      kind: "antiderivative",
      text: "求 $\\int\\frac{x^4}{1+x^2}\\,dx$。",
      answer: "x^3/3 - x + arctan(x) + C",
    },
    {
      kind: "antiderivative",
      text: "求 $\\int\\frac{3x^4+1}{1+x^2}\\,dx$。",
      answer: "x^3 - 3*x + 4*arctan(x) + C",
    },
  ],
  "indefinite-substitution-1": [
    {
      kind: "antiderivative",
      text: "求 $\\int\\sin^2 x\\cos^3 x\\,dx$。",
      answer: "sin(x)^3/3 - sin(x)^5/5 + C",
    },
    {
      kind: "antiderivative",
      text: "求 $\\int\\sin^4 x\\cos^3 x\\,dx$。",
      answer: "sin(x)^5/5 - sin(x)^7/7 + C",
    },
  ],
  "indefinite-root-sub": [
    {
      kind: "antiderivative",
      text: "求 $\\int\\frac{dx}{1+\\sqrt{x}}$。",
      answer: "2*sqrt(x) - 2*ln(1+sqrt(x)) + C",
    },
    {
      kind: "antiderivative",
      text: "求 $\\int\\frac{dx}{2+\\sqrt{x}}$。",
      answer: "2*sqrt(x) - 4*ln(2+sqrt(x)) + C",
    },
  ],
  "indefinite-trig-sub": [
    {
      kind: "antiderivative",
      text: "求 $\\int\\frac{dx}{x^2\\sqrt{1+x^2}}$。",
      answer: "-sqrt(1+x^2)/x + C",
    },
    {
      kind: "antiderivative",
      text: "求 $\\int\\frac{dx}{x^2\\sqrt{1+4x^2}}$。",
      answer: "-sqrt(1+4*x^2)/x + C",
    },
  ],
  "indefinite-parts": [
    {
      kind: "antiderivative",
      text: "求 $\\int x\\arctan x\\,dx$。",
      answer: "(x^2+1)/2*arctan(x) - x/2 + C",
    },
    {
      kind: "antiderivative",
      text: "求 $\\int 8x\\arctan 2x\\,dx$。",
      answer: "(4*x^2+1)*arctan(2*x) - 2*x + C",
    },
  ],
  "indefinite-rational": [
    {
      kind: "antiderivative",
      text: "求 $\\int\\frac{x^2+1}{(x+1)^2(x-1)}\\,dx$。",
      answer: "(1/2)*ln|x-1| + (1/2)*ln|x+1| + 1/(x+1) + C",
    },
    {
      kind: "antiderivative",
      text: "求 $\\int\\frac{2x^2+x+1}{(x+1)^2(x-1)}\\,dx$。",
      answer: "ln|x-1| + ln|x+1| + 1/(x+1) + C",
    },
  ],
  "indefinite-trig-rational": [
    {
      kind: "antiderivative",
      text: "求 $\\int\\frac{dx}{1+\\sin x+\\cos x}$。",
      answer: "ln|1+tan(x/2)| + C",
      note: "函数的参数请加括号，如 sin(2x)",
    },
    {
      kind: "antiderivative",
      text: "求 $\\int\\frac{dx}{2+\\sin x+2\\cos x}$。",
      answer: "ln|2+tan(x/2)| + C",
      note: "函数的参数请加括号，如 sin(2x)",
    },
  ],
  "definite-concept": [
    {
      kind: "number",
      text: "利用定积分的几何意义，计算 $\\int_0^2\\sqrt{2x-x^2}\\,dx$。",
      answer: "pi/2",
      note: "写精确值",
    },
    {
      kind: "number",
      text: "利用定积分的几何意义，计算 $\\int_0^4\\sqrt{4x-x^2}\\,dx$。",
      answer: "2*pi",
      note: "写精确值",
    },
  ],
  "definite-riemann-sum": [
    {
      kind: "number",
      text: "求 $\\lim_{n\\to\\infty}\\left[\\frac{1}{n+1}+\\frac{1}{n+2}+\\cdots+\\frac{1}{2n}\\right]$。",
      answer: "ln(2)",
      note: "写精确值",
    },
    {
      kind: "number",
      text: "求 $\\lim_{n\\to\\infty}\\left[\\frac{1}{n+1}+\\frac{1}{n+2}+\\cdots+\\frac{1}{3n}\\right]$。",
      answer: "ln(3)",
      note: "写精确值",
    },
  ],
  "definite-ftc-derivative": [
    {
      kind: "expr",
      text: "求 $\\frac{d}{dx}\\int_{x^2}^{x^3}\\frac{dt}{\\sqrt{1+t^4}}$。",
      answer: "3*x^2/sqrt(1+x^12) - 2*x/sqrt(1+x^8)",
    },
    {
      kind: "expr",
      text: "求 $\\frac{d}{dx}\\int_{2x}^{x^2}\\frac{dt}{\\sqrt{1+t^4}}$。",
      answer: "2*x/sqrt(1+x^8) - 2/sqrt(1+16*x^4)",
    },
  ],
  "definite-ftc-limit": [
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}\\frac{\\displaystyle\\int_0^x\\ln(1+t^2)\\,dt}{x-\\sin x}$。",
      answer: "2",
    },
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}\\frac{\\displaystyle\\int_0^x\\ln(1+2t^2)\\,dt}{x-\\sin x}$。",
      answer: "4",
    },
  ],
  "definite-newton-leibniz": [
    {
      kind: "number",
      text: "计算 $\\int_{-1}^{2}\\left|x^2-x\\right|\\,dx$。",
      answer: "11/6",
      note: "写精确值",
    },
    {
      kind: "number",
      text: "计算 $\\int_{-1}^{3}\\left|x^2-x\\right|\\,dx$。",
      answer: "17/3",
      note: "写精确值",
    },
  ],
  "definite-substitution": [
    {
      kind: "number",
      text: "计算 $\\int_0^{\\ln 2}\\sqrt{e^x-1}\\,dx$。",
      answer: "2 - pi/2",
      note: "写精确值",
    },
    {
      kind: "number",
      text: "计算 $\\int_0^{\\ln 4}\\sqrt{e^x-1}\\,dx$。",
      answer: "2*sqrt(3) - 2*pi/3",
      note: "写精确值",
    },
  ],
  "definite-symmetry": [
    {
      kind: "number",
      text: "计算 $\\int_{-2}^{2}\\left(x^3\\cos x+\\sqrt{4-x^2}\\right)dx$。",
      answer: "2*pi",
      note: "写精确值",
    },
    {
      kind: "number",
      text: "计算 $\\int_{-4}^{4}\\left(x^3\\cos x+\\sqrt{16-x^2}\\right)dx$。",
      answer: "8*pi",
      note: "写精确值",
    },
  ],
  "definite-parts": [
    {
      kind: "number",
      text: "计算 $\\int_1^e(\\ln x)^2\\,dx$。",
      answer: "e - 2",
      note: "写精确值",
    },
    {
      kind: "number",
      text: "计算 $\\int_1^{e^2}(\\ln x)^2\\,dx$。",
      answer: "2*e^2 - 2",
      note: "写精确值",
    },
  ],
  "definite-reflection": [
    {
      kind: "number",
      text: "计算 $\\int_0^{\\pi}\\frac{x\\sin x}{1+\\cos^2 x}\\,dx$。",
      answer: "pi^2/4",
      note: "写精确值",
    },
    {
      kind: "number",
      text: "计算 $\\int_{\\pi}^{2\\pi}\\frac{x\\sin x}{1+\\cos^2 x}\\,dx$。",
      answer: "-3*pi^2/4",
      note: "写精确值",
    },
  ],
  "definite-improper-inf": [
    {
      kind: "number",
      text: "计算 $\\int_{-\\infty}^{+\\infty}\\frac{dx}{x^2+2x+2}$。",
      answer: "pi",
      note: "写精确值",
    },
    {
      kind: "number",
      text: "计算 $\\int_{-\\infty}^{+\\infty}\\frac{2\\,dx}{x^2+4x+5}$。",
      answer: "2*pi",
      note: "写精确值",
    },
  ],
  "definite-improper-unbounded": [
    {
      kind: "number",
      text: "计算 $\\int_0^2\\frac{dx}{\\sqrt{\\left|1-x\\right|}}$。",
      answer: "4",
    },
    {
      kind: "number",
      text: "计算 $\\int_0^5\\frac{dx}{\\sqrt{\\left|1-x\\right|}}$。",
      answer: "6",
    },
  ],
  "definite-area": [
    {
      kind: "number",
      text: "求曲线 $y=x^2$ 与直线 $y=x+2$ 所围图形的面积。",
      answer: "9/2",
    },
    {
      kind: "number",
      text: "求曲线 $y=x^2$ 与直线 $y=2x+8$ 所围图形的面积。",
      answer: "36",
    },
  ],
  "definite-area-polar": [
    {
      kind: "number",
      text: "求心形线 $r=1+\\cos\\theta$ 所围图形的面积。",
      answer: "3*pi/2",
      note: "写精确值",
    },
    {
      kind: "number",
      text: "求心形线 $r=2(1+\\cos\\theta)$ 所围图形的面积。",
      answer: "6*pi",
      note: "写精确值",
    },
  ],
  "definite-arc-length": [
    {
      kind: "number",
      text: "求曲线 $y=\\frac{2}{3}x^{3/2}$ 上 $0\\le x\\le 3$ 一段的弧长。",
      answer: "14/3",
      note: "写精确值",
    },
    {
      kind: "number",
      text: "求曲线 $y=\\frac{2}{3}x^{3/2}$ 上 $0\\le x\\le 15$ 一段的弧长。",
      answer: "42",
      note: "写精确值",
    },
  ],
  "definite-physics": [
    {
      kind: "number",
      text: "圆柱形水池深 $4\\ \\mathrm{m}$、底面半径 $2\\ \\mathrm{m}$，盛满水。把水全部抽到池口需做多少功？（水的密度取 $1000\\ \\mathrm{kg/m^3}$，$g$ 取 $9.8\\ \\mathrm{m/s^2}$）功以焦耳（J）为单位，作答时不写单位，结果写成含 $\\pi$ 的精确值。",
      answer: "313600*pi",
      note: "不写单位，写含 π 的精确值",
    },
    {
      kind: "number",
      text: "圆柱形水池深 $5\\ \\mathrm{m}$、底面半径 $2\\ \\mathrm{m}$，盛满水。把水全部抽到池口需做多少功？（水的密度取 $1000\\ \\mathrm{kg/m^3}$，$g$ 取 $9.8\\ \\mathrm{m/s^2}$）功以焦耳（J）为单位，作答时不写单位，结果写成含 $\\pi$ 的精确值。",
      answer: "490000*pi",
      note: "不写单位，写含 π 的精确值",
    },
  ],
  "ode-concept": [
    {
      kind: "expr",
      text: "已知 $y=C_1\\cos 2x+C_2\\sin 2x$ 是 $y''+4y=0$ 的通解，求满足 $y(0)=1$、$y'(0)=2$ 的特解。",
      answer: "cos(2*x) + sin(2*x)",
    },
    {
      kind: "expr",
      text: "已知 $y=C_1\\cos 3x+C_2\\sin 3x$ 是 $y''+9y=0$ 的通解，求满足 $y(0)=2$、$y'(0)=3$ 的特解。",
      answer: "2*cos(3*x) + sin(3*x)",
    },
  ],
  "ode-separable": [
    {
      kind: "expr",
      text: "求 $xy'-y\\ln y=0$ 满足 $y(1)=e$ 的特解。",
      answer: "e^x",
    },
    {
      kind: "expr",
      text: "求 $xy'-2y\\ln y=0$ 满足 $y(1)=e$ 的特解。",
      answer: "e^(x^2)",
    },
  ],
  "ode-homogeneous": [
    {
      kind: "expr",
      text: "求 $y'=\\frac{y}{x}+\\frac{x}{y}$ 满足 $y(1)=2$ 的特解。",
      answer: "x*sqrt(2*ln(x) + 4)",
      note: "写 y 的显式表达式（x>0，不用写绝对值和 x 的范围）",
      onAnswerDomain: true,
    },
    {
      kind: "expr",
      text: "求 $y'=\\frac{y}{x}+\\frac{2x}{y}$ 满足 $y(1)=2$ 的特解。",
      answer: "2*x*sqrt(ln(x) + 1)",
      note: "写 y 的显式表达式（x>0，不用写绝对值和 x 的范围）",
      onAnswerDomain: true,
    },
  ],
  "ode-linear": [
    {
      kind: "expr",
      text: "求 $y'+\\frac{y}{x}=\\frac{\\sin x}{x}$ 满足 $y(\\pi)=1$ 的特解。",
      answer: "(pi - 1 - cos(x))/x",
      note: "写 y 的显式表达式",
    },
    {
      kind: "expr",
      text: "求 $y'+\\frac{y}{x}=\\frac{\\sin x}{x}$ 满足 $y(2\\pi)=1$ 的特解。",
      answer: "(2*pi + 1 - cos(x))/x",
      note: "写 y 的显式表达式",
    },
  ],
  "ode-bernoulli": [
    {
      kind: "expr",
      text: "求 $y'-\\frac{y}{x}=-y^2$ 满足 $y(1)=1$ 的特解。",
      answer: "2*x/(x^2 + 1)",
      note: "写 y 的显式表达式",
    },
    {
      kind: "expr",
      text: "求 $y'-\\frac{2y}{x}=-y^2$ 满足 $y(1)=1$ 的特解。",
      answer: "3*x^2/(x^3 + 2)",
      note: "写 y 的显式表达式",
    },
  ],
  "ode-modeling": [
    {
      kind: "expr",
      text: "曲线 $y=y(x)$（$x>0$）过点 $(1,2)$，曲线上任一点处的切线在 $y$ 轴上的截距等于切点的横坐标，求这条曲线的方程。",
      answer: "x*(2 - ln(x))",
      note: "写 y 的显式表达式，不用写绝对值",
      onAnswerDomain: true,
    },
    {
      kind: "expr",
      text: "曲线 $y=y(x)$（$x>0$）过点 $(1,3)$，曲线上任一点处的切线在 $y$ 轴上的截距等于切点横坐标的两倍，求这条曲线的方程。",
      answer: "x*(3 - 2*ln(x))",
      note: "写 y 的显式表达式，不用写绝对值",
      onAnswerDomain: true,
    },
  ],
  "ode-integral-equation": [
    {
      kind: "expr",
      text: "设 $f(x)$ 连续，且 $f(x)=e^x+\\int_0^x f(t)\\,dt$，求 $f(x)$。",
      answer: "(x + 1)*e^x",
    },
    {
      kind: "expr",
      text: "设 $f(x)$ 连续，且 $f(x)=e^x+\\int_{-1}^x f(t)\\,dt$，求 $f(x)$。",
      answer: "(x + 2)*e^x",
    },
  ],
  "ode-reduce-order": [
    {
      kind: "expr",
      text: "求 $y^3y''+1=0$ 满足 $y(1)=1$、$y'(1)=0$ 的特解。",
      answer: "sqrt(2*x - x^2)",
      note: "写 y 的显式表达式",
    },
    {
      kind: "expr",
      text: "求 $y^3y''+4=0$ 满足 $y(1)=2$、$y'(1)=0$ 的特解。",
      answer: "sqrt(3 + 2*x - x^2)",
      note: "写 y 的显式表达式",
    },
  ],
  "ode-structure": [
    {
      kind: "expr",
      text: "已知 $y_1=x$、$y_2=x+e^x$、$y_3=1+x+e^x$ 是某二阶非齐次线性方程的三个解，求该方程满足 $y(0)=1$、$y'(0)=3$ 的特解。",
      answer: "2*e^x + x - 1",
    },
    {
      kind: "expr",
      text: "已知 $y_1=2x$、$y_2=2x+e^x$、$y_3=1+2x+e^x$ 是某二阶非齐次线性方程的三个解，求该方程满足 $y(0)=2$、$y'(0)=5$ 的特解。",
      answer: "3*e^x + 2*x - 1",
    },
  ],
  "ode-const-homog": [
    {
      kind: "expr",
      text: "求 $y''-4y'+13y=0$ 满足 $y(0)=0$、$y'(0)=3$ 的特解。",
      answer: "e^(2*x)*sin(3*x)",
    },
    {
      kind: "expr",
      text: "求 $y''-6y'+13y=0$ 满足 $y(0)=0$、$y'(0)=4$ 的特解。",
      answer: "2*e^(3*x)*sin(2*x)",
    },
  ],
  "limit-function": [
    {
      kind: "multi",
      text: "设 $f(x)=\\dfrac{x}{2-x}$。在相应定义域内，求复合函数 $f(f(x))$ 与反函数 $f^{-1}(x)$。只填写表达式，不填写定义域。",
      parts: [
        {
          label: "复合函数",
          kind: "expr",
          answer: "x/(4-3*x)",
        },
        {
          label: "反函数",
          kind: "expr",
          answer: "2*x/(1+x)",
        },
      ],
      hint: "复合函数要把整个内层表达式代入；反函数先解出原来的自变量。",
      explanation:
        "代入得 $f(f(x))=\\dfrac{x/(2-x)}{2-x/(2-x)}=\\dfrac{x}{4-3x}$，原复合函数要求 $x\\ne2,\\,4/3$。由 $y=x/(2-x)$ 得 $x=2y/(1+y)$，交换字母得 $f^{-1}(x)=2x/(1+x)$，其中 $x\\ne-1$。",
    },
    {
      kind: "multi",
      text: "设 $f(x)=\\dfrac{2x}{3-x}$。在相应定义域内，求复合函数 $f(f(x))$ 与反函数 $f^{-1}(x)$。只填写表达式，不填写定义域。",
      parts: [
        {
          label: "复合函数",
          kind: "expr",
          answer: "4*x/(9-5*x)",
        },
        {
          label: "反函数",
          kind: "expr",
          answer: "3*x/(x+2)",
        },
      ],
      hint: "先完整代入再通分；求反函数时把含原自变量的项放在同一侧。",
      explanation:
        "$f(f(x))=\\dfrac{4x/(3-x)}{3-2x/(3-x)}=\\dfrac{4x}{9-5x}$，要求 $x\\ne3,\\,9/5$。由 $y=2x/(3-x)$ 得 $3y=x(2+y)$，所以 $f^{-1}(x)=3x/(x+2)$，其中 $x\\ne-2$。",
    },
  ],
  "limit-one-sided": [
    {
      kind: "multi",
      text: "设 $f(x)=\\dfrac{e^{2/x}-1}{e^{2/x}+2}$，$x\\ne0$。分别求 $x\\to0^-$ 和 $x\\to0^+$ 时的极限。",
      parts: [
        {
          label: "左极限",
          kind: "number",
          answer: "-1/2",
        },
        {
          label: "右极限",
          kind: "number",
          answer: "1",
        },
      ],
      hint: "先分别判断指数中的量趋向哪一端，再处理分式。",
      explanation:
        "$x\\to0^-$ 时 $e^{2/x}\\to0$，左极限为 $-1/2$；$x\\to0^+$ 时指数趋于正无穷，分子分母同除 $e^{2/x}$ 得右极限为 $1$。左右极限不相等，所以两侧极限不存在。",
    },
    {
      kind: "multi",
      text: "设 $g(x)=\\dfrac{3e^{1/x}+2}{2e^{1/x}+5}$，$x\\ne0$。分别求 $x\\to0^-$ 和 $x\\to0^+$ 时的极限。",
      parts: [
        {
          label: "左极限",
          kind: "number",
          answer: "2/5",
        },
        {
          label: "右极限",
          kind: "number",
          answer: "3/2",
        },
      ],
      hint: "两侧的指数函数行为不同；趋于无穷时可把分式同除指数项。",
      explanation:
        "左侧 $e^{1/x}\\to0$，得到 $2/5$；右侧 $e^{1/x}\\to+\\infty$，同除该项后得到 $3/2$。左右极限不相等。",
    },
  ],
  "limit-infinitesimal": [
    {
      kind: "multi",
      text: "设 $f(x)=\\dfrac{x^2-4}{x^2-5x+6}$。填写有限实数：当 $x\\to a$ 时 $f(x)\\to0$；当 $x\\to b$ 时 $|f(x)|\\to+\\infty$。另求 $x\\to2$ 时 $f(x)$ 的极限。",
      parts: [
        {
          label: "无穷小时趋近的值",
          kind: "number",
          answer: "-2",
        },
        {
          label: "无穷大时趋近的值",
          kind: "number",
          answer: "3",
        },
        {
          label: "补充极限",
          kind: "number",
          answer: "-4",
        },
      ],
      hint: "先因式分解并约去公共因子，再区分趋于零、有限非零值与绝对值趋于无穷。",
      explanation:
        "除去原式不能取的点，$f(x)=(x+2)/(x-3)$。故 $a=-2$，$b=3$。在 $x\\to2$ 时极限为 $4/(-1)=-4$，原式在这一点分子分母同时为零，不代表它是无穷小或无穷大。",
    },
    {
      kind: "multi",
      text: "设 $g(x)=\\dfrac{x^2-9}{x^2-x-6}$。填写有限实数：当 $x\\to a$ 时 $g(x)\\to0$；当 $x\\to b$ 时 $|g(x)|\\to+\\infty$。另求 $x\\to3$ 时 $g(x)$ 的极限。",
      parts: [
        {
          label: "无穷小时趋近的值",
          kind: "number",
          answer: "-3",
        },
        {
          label: "无穷大时趋近的值",
          kind: "number",
          answer: "-2",
        },
        {
          label: "补充极限",
          kind: "number",
          answer: "6/5",
        },
      ],
      hint: "约分能消去一个表面上的零分母点，但原式的定义域仍要记住。",
      explanation:
        "在原式定义域内，$g(x)=(x+3)/(x+2)$。故趋于零发生在 $a=-3$，绝对值趋于无穷发生在 $b=-2$。$x\\to3$ 时极限为 $6/5$，是有限非零值。",
    },
  ],
  "limit-order": [
    {
      kind: "choice",
      text: "以下各题都在 $x\\to0$ 时比较无穷小 $\\alpha(x)$ 与 $\\beta(x)$。以 $\\beta$ 为比较基准。",
      questions: [
        {
          prompt: "$\\alpha=\\sin3x$，$\\beta=x$，两者是什么关系？",
          options: [
            {
              id: "A",
              text: "等价无穷小",
            },
            {
              id: "B",
              text: "同阶但不等价",
            },
            {
              id: "C",
              text: "α 是 β 的高阶无穷小",
            },
            {
              id: "D",
              text: "α 是 β 的低阶无穷小",
            },
          ],
          answer: "B",
        },
        {
          prompt: "$\\alpha=1-\\cos2x$，$\\beta=x$，两者是什么关系？",
          options: [
            {
              id: "A",
              text: "α 是 β 的低阶无穷小",
            },
            {
              id: "B",
              text: "等价无穷小",
            },
            {
              id: "C",
              text: "α 是 β 的高阶无穷小",
            },
            {
              id: "D",
              text: "同阶但不等价",
            },
          ],
          answer: "C",
        },
      ],
      hint: "看比值的极限；非零有限值与等于一并不是同一回事。",
      explanation:
        "第一问 $\\alpha/\\beta\\to3$，所以同阶但不等价。第二问 $1-\\cos2x=2\\sin^2x$，因此 $(1-\\cos2x)/x\\to0$，所以 $\\alpha$ 是 $\\beta$ 的高阶无穷小。",
    },
    {
      kind: "choice",
      text: "以下各题都在 $x\\to0$ 时比较无穷小 $\\alpha(x)$ 与 $\\beta(x)$。以 $\\beta$ 为比较基准。",
      questions: [
        {
          prompt: "$\\alpha=\\tan2x$，$\\beta=2x$，两者是什么关系？",
          options: [
            {
              id: "A",
              text: "等价无穷小",
            },
            {
              id: "B",
              text: "同阶但不等价",
            },
            {
              id: "C",
              text: "α 是 β 的高阶无穷小",
            },
            {
              id: "D",
              text: "α 是 β 的低阶无穷小",
            },
          ],
          answer: "A",
        },
        {
          prompt: "$\\alpha=\\sin x$，$\\beta=x^2$，两者是什么关系？",
          options: [
            {
              id: "A",
              text: "同阶但不等价",
            },
            {
              id: "B",
              text: "α 是 β 的高阶无穷小",
            },
            {
              id: "C",
              text: "等价无穷小",
            },
            {
              id: "D",
              text: "α 是 β 的低阶无穷小",
            },
          ],
          answer: "D",
        },
      ],
      hint: "第二问若直接看比值不方便，可以交换分子分母，再按定义判断。",
      explanation:
        "第一问 $\\tan2x/(2x)\\to1$，所以等价。第二问 $\\beta/\\alpha=x^2/\\sin x\\to0$，故 $\\beta$ 比 $\\alpha$ 高阶，也就是 $\\alpha$ 是 $\\beta$ 的低阶无穷小。",
    },
  ],
  "limit-discontinuity": [
    {
      kind: "choice",
      text: "设 $f(x)$ 在 $x<2$ 且 $x\\ne1$ 时等于 $(x^2-1)/(x-1)$，在 $x=1$ 时等于 $0$，在 $x\\ge2$ 时等于 $4$。判断下列两处的间断点类型。",
      questions: [
        {
          prompt: "$x=1$ 处属于哪一类？",
          options: [
            {
              id: "A",
              text: "可去间断点",
            },
            {
              id: "B",
              text: "跳跃间断点",
            },
            {
              id: "C",
              text: "无穷间断点",
            },
            {
              id: "D",
              text: "振荡间断点",
            },
          ],
          answer: "A",
        },
        {
          prompt: "$x=2$ 处属于哪一类？",
          options: [
            {
              id: "A",
              text: "可去间断点",
            },
            {
              id: "B",
              text: "跳跃间断点",
            },
            {
              id: "C",
              text: "振荡间断点",
            },
            {
              id: "D",
              text: "无穷间断点",
            },
          ],
          answer: "B",
        },
      ],
      hint: "逐点算左右极限，并把极限与该点的函数值分开。",
      explanation:
        "在 $x=1$ 附近，约分后为 $x+1$，两侧极限都为 $2$，而 $f(1)=0$，所以是可去间断点。$x=2$ 的左极限为 $3$、右极限为 $4$，两侧都有限但不相等，所以是跳跃间断点。",
    },
    {
      kind: "choice",
      text: "设 $g(x)=\\dfrac{x+2}{|x+2|}+\\dfrac1{x-1}$，定义域不含 $-2$ 与 $1$。判断这两处的间断点类型。",
      questions: [
        {
          prompt: "$x=-2$ 处属于哪一类？",
          options: [
            {
              id: "A",
              text: "可去间断点",
            },
            {
              id: "B",
              text: "振荡间断点",
            },
            {
              id: "C",
              text: "跳跃间断点",
            },
            {
              id: "D",
              text: "无穷间断点",
            },
          ],
          answer: "C",
        },
        {
          prompt: "$x=1$ 处属于哪一类？",
          options: [
            {
              id: "A",
              text: "跳跃间断点",
            },
            {
              id: "B",
              text: "可去间断点",
            },
            {
              id: "C",
              text: "振荡间断点",
            },
            {
              id: "D",
              text: "无穷间断点",
            },
          ],
          answer: "D",
        },
      ],
      hint: "绝对值分式要分左右看；另一个分式在哪个点会无界？",
      explanation:
        "在 $x=-2$ 处，左极限为 $-1-1/3=-4/3$，右极限为 $1-1/3=2/3$，所以是跳跃间断点。在 $x=1$ 附近第一项为 $1$，第二项左右分别趋于负无穷和正无穷，因此是无穷间断点。",
    },
  ],
  "limit-zero-theorem": [
    {
      kind: "choice",
      text: "要用零点定理说明方程 $x^3+x-5=0$ 在 $(1,2)$ 内有根。设 $F(x)=x^3+x-5$，完成两问。",
      questions: [
        {
          prompt: "端点函数值 $(F(1),F(2))$ 是哪一组？",
          options: [
            {
              id: "A",
              text: "$(3,5)$",
            },
            {
              id: "B",
              text: "$(-3,5)$",
            },
            {
              id: "C",
              text: "$(-3,-5)$",
            },
            {
              id: "D",
              text: "$(0,5)$",
            },
          ],
          answer: "B",
        },
        {
          prompt: "根据第一问的端点符号使用零点定理，还必须核查哪项条件？",
          options: [
            {
              id: "A",
              text: "F 在开区间可导就够了，不必管端点连续性",
            },
            {
              id: "B",
              text: "F 必须在整个闭区间严格单调",
            },
            {
              id: "C",
              text: "F 在闭区间 [1,2] 上连续",
            },
            {
              id: "D",
              text: "F 在整个闭区间内均为正值",
            },
          ],
          answer: "C",
        },
      ],
      hint: "先检查闭区间连续性和两个端点的符号，再写定理保证的存在性结论。",
      explanation:
        "多项式 $F$ 在 $[1,2]$ 连续。$F(1)=-3$，$F(2)=5$，所以 $F(1)F(2)<0$。零点定理保证存在 $c\\in(1,2)$ 使 $F(c)=0$。这里没有要求根的精确值，也不单凭该定理宣称根唯一。",
    },
    {
      kind: "choice",
      text: "要用零点定理说明方程 $x^3+2x-13=0$ 在 $(2,3)$ 内有根。设 $G(x)=x^3+2x-13$，完成两问。",
      questions: [
        {
          prompt: "端点函数值 $(G(2),G(3))$ 是哪一组？",
          options: [
            {
              id: "A",
              text: "$(1,20)$",
            },
            {
              id: "B",
              text: "$(-1,-20)$",
            },
            {
              id: "C",
              text: "$(0,20)$",
            },
            {
              id: "D",
              text: "$(-1,20)$",
            },
          ],
          answer: "D",
        },
        {
          prompt: "根据第一问的端点符号使用零点定理，还必须核查哪项条件？",
          options: [
            {
              id: "A",
              text: "G 在闭区间 [2,3] 上连续",
            },
            {
              id: "B",
              text: "G 必须在整个闭区间严格单调",
            },
            {
              id: "C",
              text: "G 在开区间可导就够了，不必管端点连续性",
            },
            {
              id: "D",
              text: "G 在整个闭区间内均为负值",
            },
          ],
          answer: "A",
        },
      ],
      hint: "把方程化成连续函数等于零，检查两个端点是否跨过零。",
      explanation:
        "$G$ 在 $[2,3]$ 连续，$G(2)=-1$、$G(3)=20$，端点乘积为负。因此存在 $c\\in(2,3)$ 使 $G(c)=0$。这是存在性结论。",
    },
  ],
  "limit-epsilon-n": [
    {
      kind: "choice",
      text: "设 $a_n=\\dfrac{5n+2}{2n+3}$，$n\\ge1$。用 $\\varepsilon$—$N$ 定义验证它趋于 $5/2$。其中 $\\lceil t\\rceil$ 表示向上取整，要求 $n>N$ 时误差小于任意给定的 $\\varepsilon>0$。",
      questions: [
        {
          prompt: "误差的精确表达式是哪一个？",
          options: [
            {
              id: "A",
              text: "$\\dfrac{11}{2n+3}$",
            },
            {
              id: "B",
              text: "$\\dfrac{11}{4n+6}$",
            },
            {
              id: "C",
              text: "$\\dfrac1{4n+6}$",
            },
            {
              id: "D",
              text: "$\\dfrac{11n}{4n+6}$",
            },
          ],
          answer: "B",
        },
        {
          prompt: "以下哪一个整数 N 的选择对每个 ε>0 都足够？",
          options: [
            {
              id: "A",
              text: "$N=1$",
            },
            {
              id: "B",
              text: "$N=\\max\\{1,\\lceil11\\varepsilon/4\\rceil\\}$",
            },
            {
              id: "C",
              text: "$N=\\max\\{1,\\lceil11/(40\\varepsilon)\\rceil\\}$",
            },
            {
              id: "D",
              text: "$N=\\max\\{1,\\lceil11/(4\\varepsilon)\\rceil\\}$",
            },
          ],
          answer: "D",
        },
      ],
      hint: "先通分计算误差，再找一个只依赖 ε 的足够大整数；不要求最小整数。",
      explanation:
        "$a_n-5/2=-11/(4n+6)$，故误差为 $11/(4n+6)<11/(4n)$。取 $N=\\max\\{1,\\lceil11/(4\\varepsilon)\\rceil\\}$，当 $n>N$ 时有 $n>11/(4\\varepsilon)$，从而误差小于 $\\varepsilon$。",
    },
    {
      kind: "choice",
      text: "设 $b_n=\\dfrac{7n-2}{3n+4}$，$n\\ge1$。用 $\\varepsilon$—$N$ 定义验证它趋于 $7/3$。其中 $\\lceil t\\rceil$ 表示向上取整，要求 $n>N$ 时误差小于任意给定的 $\\varepsilon>0$。",
      questions: [
        {
          prompt: "误差的精确表达式是哪一个？",
          options: [
            {
              id: "A",
              text: "$\\dfrac{34}{3n+4}$",
            },
            {
              id: "B",
              text: "$\\dfrac{2}{9n+12}$",
            },
            {
              id: "C",
              text: "$\\dfrac{34}{9n+12}$",
            },
            {
              id: "D",
              text: "$\\dfrac{34n}{9n+12}$",
            },
          ],
          answer: "C",
        },
        {
          prompt: "以下哪一个整数 N 的选择对每个 ε>0 都足够？",
          options: [
            {
              id: "A",
              text: "$N=\\max\\{1,\\lceil34/(9\\varepsilon)\\rceil\\}$",
            },
            {
              id: "B",
              text: "$N=1$",
            },
            {
              id: "C",
              text: "$N=\\max\\{1,\\lceil34\\varepsilon/9\\rceil\\}$",
            },
            {
              id: "D",
              text: "$N=\\max\\{1,\\lceil34/(90\\varepsilon)\\rceil\\}$",
            },
          ],
          answer: "A",
        },
      ],
      hint: "误差应先完整通分；把它放大成常数除以 n，再倒推充分条件。",
      explanation:
        "$b_n-7/3=-34/(9n+12)$，误差小于 $34/(9n)$。取 $N=\\max\\{1,\\lceil34/(9\\varepsilon)\\rceil\\}$，当 $n>N$ 时误差必小于 $\\varepsilon$。",
    },
  ],
  "limit-epsilon-delta": [
    {
      kind: "choice",
      text: "用 $\\varepsilon$—$\\delta$ 定义验证 $\\lim_{x\\to2}x^2=4$。先把 $|x^2-4|$ 分解，再暂时限制 $|x-2|<1$。",
      questions: [
        {
          prompt: "在这个限制下，以下哪条对 $|x+2|$ 的估计始终成立？",
          options: [
            {
              id: "A",
              text: "$|x+2|<3$",
            },
            {
              id: "B",
              text: "$|x+2|<4$",
            },
            {
              id: "C",
              text: "$|x+2|<5$",
            },
            {
              id: "D",
              text: "$|x+2|<1$",
            },
          ],
          answer: "C",
        },
        {
          prompt:
            "以下哪种选择保证任意 $\\varepsilon>0$ 下，$0<|x-2|<\\delta$ 都推出 $|x^2-4|<\\varepsilon$？",
          options: [
            {
              id: "A",
              text: "$\\delta=\\min\\{1,\\varepsilon/5\\}$",
            },
            {
              id: "B",
              text: "$\\delta=\\min\\{1,5\\varepsilon\\}$",
            },
            {
              id: "C",
              text: "$\\delta=\\min\\{1,\\varepsilon/4\\}$",
            },
            {
              id: "D",
              text: "$\\delta=\\min\\{1,\\sqrt\\varepsilon\\}$",
            },
          ],
          answer: "A",
        },
      ],
      hint: "平方差有两个因子：一个趋于零，另一个先用邻域条件给出统一上界。",
      explanation:
        "$|x-2|<1$ 给出 $1<x<3$，故 $|x+2|<5$。取 $\\delta=\\min\\{1,\\varepsilon/5\\}$，则 $|x^2-4|=|x-2||x+2|<5|x-2|<\\varepsilon$。",
    },
    {
      kind: "choice",
      text: "用 $\\varepsilon$—$\\delta$ 定义验证 $\\lim_{x\\to-3}x^2=9$。先把 $|x^2-9|$ 分解，再暂时限制 $|x+3|<1$。",
      questions: [
        {
          prompt: "在这个限制下，以下哪条对 $|x-3|$ 的估计始终成立？",
          options: [
            {
              id: "A",
              text: "$|x-3|<6$",
            },
            {
              id: "B",
              text: "$|x-3|<7$",
            },
            {
              id: "C",
              text: "$|x-3|<5$",
            },
            {
              id: "D",
              text: "$|x-3|<4$",
            },
          ],
          answer: "B",
        },
        {
          prompt:
            "以下哪种选择保证任意 $\\varepsilon>0$ 下，$0<|x+3|<\\delta$ 都推出 $|x^2-9|<\\varepsilon$？",
          options: [
            {
              id: "A",
              text: "$\\delta=\\min\\{1,7\\varepsilon\\}$",
            },
            {
              id: "B",
              text: "$\\delta=\\min\\{1,\\varepsilon/6\\}$",
            },
            {
              id: "C",
              text: "$\\delta=\\min\\{1,\\sqrt\\varepsilon\\}$",
            },
            {
              id: "D",
              text: "$\\delta=\\min\\{1,\\varepsilon/7\\}$",
            },
          ],
          answer: "D",
        },
      ],
      hint: "注意趋近点是负数；控制离该点的距离后，再估计另一个因子的绝对值。",
      explanation:
        "$|x+3|<1$ 给出 $-4<x<-2$，所以 $|x-3|<7$。取 $\\delta=\\min\\{1,\\varepsilon/7\\}$，当 $0<|x+3|<\\delta$ 时，$|x^2-9|=|x+3||x-3|<7|x+3|<\\varepsilon$。",
    },
  ],
  "limit-monotone": [
    {
      kind: "choice",
      text: "正项数列由 $a_1=1$、$a_{n+1}=\\sqrt{6+a_n}$ 定义。按“有界、单调、求极限”的思路完成三问。",
      questions: [
        {
          prompt: "哪一个范围能从首项出发用归纳法对所有 n≥1 保持？",
          options: [
            {
              id: "A",
              text: "$1\\le a_n<3$",
            },
            {
              id: "B",
              text: "$0<a_n<2$",
            },
            {
              id: "C",
              text: "$a_n>3$",
            },
            {
              id: "D",
              text: "$a_n<0$",
            },
          ],
          answer: "A",
        },
        {
          prompt: "在正确的范围内，哪条关系可以证明递增？",
          options: [
            {
              id: "A",
              text: "$a_{n+1}^2-a_n^2=(3-a_n)(a_n+2)<0$",
            },
            {
              id: "B",
              text: "$a_{n+1}^2-a_n^2=0$",
            },
            {
              id: "C",
              text: "$a_{n+1}^2-a_n^2=(3-a_n)(a_n+2)>0$",
            },
            {
              id: "D",
              text: "$a_{n+1}^2-a_n^2=(a_n-3)(a_n+2)>0$",
            },
          ],
          answer: "C",
        },
        {
          prompt:
            "由单调有界准则知极限存在，代入递推式并利用正项条件，极限是哪一个？",
          options: [
            {
              id: "A",
              text: "$-2$",
            },
            {
              id: "B",
              text: "$3$",
            },
            {
              id: "C",
              text: "$2$",
            },
            {
              id: "D",
              text: "$6$",
            },
          ],
          answer: "B",
        },
      ],
      hint: "先验证一个不变区间。比较相邻两项时，正数的平方差与原来的大小关系相同。",
      explanation:
        "若 $1\\le a_n<3$，则 $1<\\sqrt{6+a_n}<3$，所以该范围归纳成立。又 $a_{n+1}^2-a_n^2=6+a_n-a_n^2=(3-a_n)(a_n+2)>0$，正项性给出严格递增。递增且有上界，故收敛。极限 $L$ 满足 $L^2=6+L$，解为 $3,-2$；由 $L\\ge1$ 取 $L=3$。",
    },
    {
      kind: "choice",
      text: "正项数列由 $b_1=2$、$b_{n+1}=\\sqrt{12+b_n}$ 定义。按“有界、单调、求极限”的思路完成三问。",
      questions: [
        {
          prompt: "哪一个范围能从首项出发用归纳法对所有 n≥1 保持？",
          options: [
            {
              id: "A",
              text: "$b_n<0$",
            },
            {
              id: "B",
              text: "$0<b_n<3$",
            },
            {
              id: "C",
              text: "$b_n>4$",
            },
            {
              id: "D",
              text: "$2\\le b_n<4$",
            },
          ],
          answer: "D",
        },
        {
          prompt: "在正确的范围内，哪条关系可以证明递增？",
          options: [
            {
              id: "A",
              text: "$b_{n+1}^2-b_n^2=(4-b_n)(b_n+3)>0$",
            },
            {
              id: "B",
              text: "$b_{n+1}^2-b_n^2=(b_n-4)(b_n+3)>0$",
            },
            {
              id: "C",
              text: "$b_{n+1}^2-b_n^2=0$",
            },
            {
              id: "D",
              text: "$b_{n+1}^2-b_n^2=(4-b_n)(b_n+3)<0$",
            },
          ],
          answer: "A",
        },
        {
          prompt:
            "由单调有界准则知极限存在，代入递推式并利用正项条件，极限是哪一个？",
          options: [
            {
              id: "A",
              text: "$-3$",
            },
            {
              id: "B",
              text: "$3$",
            },
            {
              id: "C",
              text: "$4$",
            },
            {
              id: "D",
              text: "$12$",
            },
          ],
          answer: "C",
        },
      ],
      hint: "归纳法需要同时检查首项和递推保持；求出的极限候选还要满足数列的范围。",
      explanation:
        "若 $2\\le b_n<4$，则 $2<\\sqrt{12+b_n}<4$，所以范围保持。平方差为 $12+b_n-b_n^2=(4-b_n)(b_n+3)>0$，故正项数列严格递增。有上界所以收敛，$L^2=12+L$ 的根是 $4,-3$；范围排除负根，故 $L=4$。",
    },
  ],
  "limit-uniform": [
    {
      kind: "choice",
      text: "比较函数 $f(x)=x^2$ 在不同区间上的一致连续性。下面两问独立作答，序列指标 $n\\ge1$。",
      questions: [
        {
          prompt:
            "在 $[0,3]$ 上，下面哪种对所有 $\\varepsilon>0$ 的统一 δ 选择有效？",
          options: [
            {
              id: "A",
              text: "$\\delta=\\varepsilon$",
            },
            {
              id: "B",
              text: "$\\delta=\\varepsilon/3$",
            },
            {
              id: "C",
              text: "$\\delta=\\varepsilon/6$",
            },
            {
              id: "D",
              text: "$\\delta=\\sqrt\\varepsilon$",
            },
          ],
          answer: "C",
        },
        {
          prompt:
            "在 $[0,+\\infty)$ 上取 $x_n=n$、$y_n=n+1/n$。哪组“自变量距离极限、函数值距离极限、结论”正确？",
          options: [
            {
              id: "A",
              text: "$0,\\ 2$；不是一致连续",
            },
            {
              id: "B",
              text: "$0,\\ 0$；是一致连续",
            },
            {
              id: "C",
              text: "$1,\\ 2$；不是一致连续",
            },
            {
              id: "D",
              text: "$0,\\ +\\infty$；不是一致连续",
            },
          ],
          answer: "A",
        },
      ],
      hint: "一致连续要求 δ 不依赖区间中的具体点。否定它可以找越来越近、但函数值不越来越近的两列点。",
      explanation:
        "在 $[0,3]$ 上，$|x^2-y^2|=|x-y||x+y|\\le6|x-y|$，因此 $\\delta=\\varepsilon/6$ 有效。在无界区间，$|x_n-y_n|=1/n\\to0$，但 $|x_n^2-y_n^2|=2+1/n^2\\to2$，违反一致连续性必要条件。",
    },
    {
      kind: "choice",
      text: "比较函数 $g(x)=1/x$ 在不同区间上的一致连续性。下面两问独立作答，序列指标 $n\\ge1$。",
      questions: [
        {
          prompt:
            "在 $[2,+\\infty)$ 上，下面哪种对所有 $\\varepsilon>0$ 的统一 δ 选择有效？",
          options: [
            {
              id: "A",
              text: "$\\delta=8\\varepsilon$",
            },
            {
              id: "B",
              text: "$\\delta=4\\varepsilon$",
            },
            {
              id: "C",
              text: "$\\delta=\\sqrt\\varepsilon$",
            },
            {
              id: "D",
              text: "$\\delta=1$",
            },
          ],
          answer: "B",
        },
        {
          prompt:
            "在 $(0,1)$ 上取 $x_n=1/(n+2)$、$y_n=1/(n+3)$。哪组“自变量距离极限、函数值距离极限、结论”正确？",
          options: [
            {
              id: "A",
              text: "$0,\\ 0$；是一致连续",
            },
            {
              id: "B",
              text: "$1,\\ 1$；不是一致连续",
            },
            {
              id: "C",
              text: "$0,\\ +\\infty$；不是一致连续",
            },
            {
              id: "D",
              text: "$0,\\ 1$；不是一致连续",
            },
          ],
          answer: "D",
        },
      ],
      hint: "先估计倒数之差；无界区间不一定妨碍一致连续，靠近函数无界的位置也值得检查。",
      explanation:
        "若 $x,y\\ge2$，则 $|1/x-1/y|=|x-y|/(xy)\\le|x-y|/4$，故 $\\delta=4\\varepsilon$ 有效。第二问两列点均在 $(0,1)$ 内，距离为 $1/((n+2)(n+3))\\to0$，函数值距离恒为 $1$，所以在该区间不是一致连续。",
    },
  ],
  "derivative-tangent": [
    {
      kind: "multi",
      text: "曲线 $y=x^3-x+2$ 在横坐标为 $1$ 的点处，切线与法线分别写成 $y=T(x)$、$y=N(x)$。填写两个右端表达式。",
      parts: [
        {
          label: "切线右端",
          kind: "expr",
          answer: "2*x",
        },
        {
          label: "法线右端",
          kind: "expr",
          answer: "(5-x)/2",
        },
      ],
      hint: "先算切点和切线斜率；这里切线斜率非零，法线斜率是它的负倒数。",
      explanation:
        "切点为 $(1,2)$，$y'=3x^2-1$ 在该点为 $2$。切线 $y-2=2(x-1)$，即 $T(x)=2x$；法线 $y-2=-\\tfrac12(x-1)$，即 $N(x)=(5-x)/2$。",
    },
    {
      kind: "multi",
      text: "曲线 $y=x^2+2x$ 在横坐标为 $1$ 的点处，切线与法线分别写成 $y=T(x)$、$y=N(x)$。填写两个右端表达式。",
      parts: [
        {
          label: "切线右端",
          kind: "expr",
          answer: "4*x-1",
        },
        {
          label: "法线右端",
          kind: "expr",
          answer: "(13-x)/4",
        },
      ],
      hint: "点斜式中的切点坐标要由原曲线给出，不要把导数当成纵坐标。",
      explanation:
        "切点为 $(1,3)$，导数 $2x+2$ 在此为 $4$。因此切线为 $y-3=4(x-1)$，法线为 $y-3=-\\tfrac14(x-1)$，右端分别为 $4x-1$ 和 $(13-x)/4$。",
    },
  ],
  "derivative-differential": [
    {
      kind: "multi",
      text: "设 $y=x^2$，在 $x=2$ 处给自变量增量 $\\Delta x=1/10$，并取 $\\mathrm dx=\\Delta x$。分别求精确增量 $\\Delta y$ 与微分 $\\mathrm dy$。",
      parts: [
        {
          label: "精确增量",
          kind: "number",
          answer: "41/100",
        },
        {
          label: "微分",
          kind: "number",
          answer: "2/5",
        },
      ],
      hint: "增量使用新旧函数值之差；微分使用原点处的导数乘自变量增量。",
      explanation:
        "$\\Delta y=(2+1/10)^2-2^2=41/100$；$\\mathrm dy=f'(2)\\mathrm dx=4\\cdot(1/10)=2/5$。两者相差 $(\\Delta x)^2=1/100$。",
    },
    {
      kind: "multi",
      text: "设 $y=x^3$，在 $x=1$ 处给自变量增量 $\\Delta x=1/5$，并取 $\\mathrm dx=\\Delta x$。分别求精确增量 $\\Delta y$ 与微分 $\\mathrm dy$。",
      parts: [
        {
          label: "精确增量",
          kind: "number",
          answer: "91/125",
        },
        {
          label: "微分",
          kind: "number",
          answer: "3/5",
        },
      ],
      hint: "精确增量要保留展开中的所有项；微分只保留关于增量的一阶项。",
      explanation:
        "$\\Delta y=(6/5)^3-1=91/125$；$\\mathrm dy=3\\cdot1^2\\cdot(1/5)=3/5$。差值为 $16/125$，所以这次有限增量下两者不相等。",
    },
  ],
  "derivative-piecewise": [
    {
      kind: "multi",
      text: "设 $f(x)=ax+b$（$x<1$），$f(x)=x^2+x$（$x\\ge1$）。要使 $f$ 在 $x=1$ 处可导，求常数 $a,b$。第一空填 a，第二空填 b。",
      parts: [
        {
          label: "参数 a",
          kind: "number",
          answer: "3",
        },
        {
          label: "参数 b",
          kind: "number",
          answer: "-1",
        },
      ],
      hint: "先用连续性列出参数关系，再令分段点的左右导数相等。",
      explanation:
        "第一空对应 $a$，第二空对应 $b$。连续性要求 $a+b=2$，左导数为 $a$，右导数为 $2\\cdot1+1=3$，故 $a=3,b=-1$。代回后两个条件同时满足。",
    },
    {
      kind: "multi",
      text: "设 $f(x)=ax+b$（$x<2$），$f(x)=x^2-3x+1$（$x\\ge2$）。要使 $f$ 在 $x=2$ 处可导，求常数 $a,b$。第一空填 a，第二空填 b。",
      parts: [
        {
          label: "参数 a",
          kind: "number",
          answer: "1",
        },
        {
          label: "参数 b",
          kind: "number",
          answer: "-3",
        },
      ],
      hint: "分段点处有函数值相接和斜率相接两个要求，少一个就不能保证可导。",
      explanation:
        "第一空对应 $a$，第二空对应 $b$。连续性要求 $2a+b=2^2-3\\cdot2+1=-1$；左右导数相等要求 $a=2\\cdot2-3=1$，于是 $b=-3$。",
    },
  ],
  "derivative-implicit": [
    {
      kind: "multi",
      text: "方程 $x^2+xy+y^2=7$ 在点 $(1,2)$ 附近确定可导函数 $y=y(x)$。求该点的一阶导数与二阶导数。",
      parts: [
        {
          label: "一阶导数",
          kind: "number",
          answer: "-4/5",
        },
        {
          label: "二阶导数",
          kind: "number",
          answer: "-42/125",
        },
      ],
      hint: "每次对 x 求导都把 y 看成函数；求二阶导数时，已有的 y 的导数也要继续求导。",
      explanation:
        "一次求导得 $2x+y+(x+2y)y'=0$，代入得 $y'=-4/5$。再求导：$2+2y'+2(y')^2+(x+2y)y''=0$。代入 $x=1,y=2,y'=-4/5$，得 $y''=-42/125$。该点对 y 的偏导为 $x+2y=5\\ne0$，局部函数条件成立。",
    },
    {
      kind: "multi",
      text: "方程 $x^2+2xy+3y^2=6$ 在点 $(1,1)$ 附近确定可导函数 $y=y(x)$。求该点的一阶导数与二阶导数。",
      parts: [
        {
          label: "一阶导数",
          kind: "number",
          answer: "-1/2",
        },
        {
          label: "二阶导数",
          kind: "number",
          answer: "-3/16",
        },
      ],
      hint: "先求出这一点的一阶导数，再在二次求导式中代入；不要遗漏乘积的求导项。",
      explanation:
        "一次求导得 $2x+2y+(2x+6y)y'=0$，在 $(1,1)$ 处得 $y'=-1/2$。二次求导得 $2+4y'+6(y')^2+(2x+6y)y''=0$，所以 $y''=-3/16$。这里 $2x+6y=8\\ne0$。",
    },
  ],
  "derivative-parametric": [
    {
      kind: "multi",
      text: "曲线由 $x=t^2+1$、$y=t^3-t$（$t>0$）给出。求 $t=2$ 时关于 x 的一阶导数与二阶导数。",
      parts: [
        {
          label: "一阶导数",
          kind: "number",
          answer: "11/4",
        },
        {
          label: "二阶导数",
          kind: "number",
          answer: "13/32",
        },
      ],
      hint: "一阶导数是两个参数导数之比；再求导时需要再除一次 x 对参数的导数。",
      explanation:
        "$\\mathrm dy/\\mathrm dx=(3t^2-1)/(2t)$，代入 $t=2$ 得 $11/4$。再用 $\\mathrm d^2y/\\mathrm dx^2=\\dfrac{\\mathrm d}{\\mathrm dt}(\\mathrm dy/\\mathrm dx)/(\\mathrm dx/\\mathrm dt)$，化得 $(3t^2+1)/(4t^3)$，故第二空为 $13/32$。",
    },
    {
      kind: "multi",
      text: "曲线由 $x=t^2+2t$、$y=t^3+1$（$t>-1$）给出。求 $t=1$ 时关于 x 的一阶导数与二阶导数。",
      parts: [
        {
          label: "一阶导数",
          kind: "number",
          answer: "3/4",
        },
        {
          label: "二阶导数",
          kind: "number",
          answer: "9/32",
        },
      ],
      hint: "参数方程的二阶导数并不是 y 对参数的二阶导数除以 x 对参数的二阶导数。",
      explanation:
        "$\\mathrm dy/\\mathrm dx=3t^2/(2t+2)$，在 $t=1$ 为 $3/4$。对该式求参数导数再除 $2t+2$，得到 $\\mathrm d^2y/\\mathrm dx^2=3t(t+2)/(4(t+1)^3)$，在 $t=1$ 为 $9/32$。",
    },
  ],
  "application-mvt": [
    {
      kind: "multi",
      text: "分别求下列中值点：① $f(x)=x^2-6x$ 在 $[0,6]$ 上满足罗尔定理，求 $\\xi\\in(0,6)$；② $g(x)=x^3$ 在 $[0,3]$ 上满足拉格朗日中值定理，求 $\\eta\\in(0,3)$。",
      parts: [
        {
          label: "罗尔中值点 ξ",
          kind: "number",
          answer: "3",
        },
        {
          label: "拉格朗日中值点 η",
          kind: "number",
          answer: "sqrt(3)",
        },
      ],
      hint: "先检查定理条件，再把导数与相应的零值或割线斜率相等。",
      explanation:
        "两函数均在相应闭区间连续、开区间可导。$f(0)=f(6)=0$，由 $f\\prime(\\xi)=2\\xi-6=0$ 得 $\\xi=3$。对 $g$，$3\\eta^2=\\frac{27-0}{3-0}=9$；开区间内的解为 $\\eta=\\sqrt3$。",
    },
    {
      kind: "multi",
      text: "分别求下列中值点：① $f(x)=x^2-8x+3$ 在 $[1,7]$ 上的罗尔中值点 $\\xi$；② $g(x)=x^2$ 在 $[2,8]$ 上的拉格朗日中值点 $\\eta$。各点均取相应开区间内的值。",
      parts: [
        {
          label: "罗尔中值点 ξ",
          kind: "number",
          answer: "4",
        },
        {
          label: "拉格朗日中值点 η",
          kind: "number",
          answer: "5",
        },
      ],
      hint: "罗尔定理比较端点函数值；拉格朗日定理比较导数与割线斜率。",
      explanation:
        "$f(1)=f(7)=-4$，且 $f\\prime(\\xi)=2\\xi-8=0$，故 $\\xi=4$。对 $g$，$2\\eta=\\frac{64-4}{8-2}=10$，故 $\\eta=5$。两点均在要求的开区间内。",
    },
  ],
  "application-monotonic": [
    {
      kind: "multi",
      text: "$f(x)=x^3-12x$ 在实数轴上的唯一最大严格递减开区间记为 $(a,b)$，填写两个有限端点。",
      parts: [
        {
          label: "左端点 a",
          kind: "number",
          answer: "-2",
        },
        {
          label: "右端点 b",
          kind: "number",
          answer: "2",
        },
      ],
      hint: "求导并解导数为负的不等式。这里填写开区间端点，不含端点。",
      explanation:
        "$f\\prime(x)=3x^2-12=3(x-2)(x+2)$。导数在 $(-2,2)$ 内为负，区间外为正，因此 $a=-2,b=2$。",
    },
    {
      kind: "multi",
      text: "$f(x)=(x-2)^3-27(x-2)$ 在实数轴上的唯一最大严格递减开区间记为 $(a,b)$，填写两个有限端点。",
      parts: [
        {
          label: "左端点 a",
          kind: "number",
          answer: "-1",
        },
        {
          label: "右端点 b",
          kind: "number",
          answer: "5",
        },
      ],
      hint: "先把平移后的变量看作整体，再判断导数的符号。",
      explanation:
        "$f\\prime(x)=3(x-2)^2-27$，所以 $f\\prime(x)<0$ 等价于 $-3<x-2<3$。故所求开区间为 $(-1,5)$。",
    },
  ],
  "application-convexity": [
    {
      kind: "multi",
      text: "设 $f(x)=x^4-6x^2$。把满足 $f\\prime\\prime(x)<0$ 的唯一开区间写成 $(a,b)$，并求右侧拐点的纵坐标 $c$。",
      parts: [
        {
          label: "左端点 a",
          kind: "number",
          answer: "-1",
        },
        {
          label: "右端点 b",
          kind: "number",
          answer: "1",
        },
        {
          label: "右侧拐点纵坐标 c",
          kind: "number",
          answer: "-5",
        },
      ],
      hint: "二阶导数为零仅给候选点，还要检查两侧是否变号。",
      explanation:
        "$f\\prime\\prime(x)=12(x^2-1)$，在 $(-1,1)$ 内为负，在两侧为正；两个零点均发生变号。右侧拐点为 $(1,f(1))=(1,-5)$。",
    },
    {
      kind: "multi",
      text: "设 $f(x)=(x-2)^4-24(x-2)^2$。把满足 $f\\prime\\prime(x)<0$ 的唯一开区间写成 $(a,b)$，并求右侧拐点的纵坐标 $c$。",
      parts: [
        {
          label: "左端点 a",
          kind: "number",
          answer: "0",
        },
        {
          label: "右端点 b",
          kind: "number",
          answer: "4",
        },
        {
          label: "右侧拐点纵坐标 c",
          kind: "number",
          answer: "-80",
        },
      ],
      hint: "先研究二阶导数的符号，再把右侧候选点代回原函数。",
      explanation:
        "$f\\prime\\prime(x)=12((x-2)^2-4)$，在 $(0,4)$ 内为负，区间外为正。右侧拐点为 $(4,16-96)=(4,-80)$。",
    },
  ],
  "application-extremum": [
    {
      kind: "multi",
      text: "求 $f(x)=|x|-\\frac{x^2}{4}$ 在闭区间 $[-1,3]$ 上的最小值、最大值，以及取得最大值的 $x$。",
      parts: [
        {
          label: "最小值",
          kind: "number",
          answer: "0",
        },
        {
          label: "最大值",
          kind: "number",
          answer: "1",
        },
        {
          label: "取得最大值的 x",
          kind: "number",
          answer: "2",
        },
      ],
      hint: "同时比较驻点、不可导点和闭区间端点，不能只解导数为零。",
      explanation:
        "在 $[-1,0)$ 上 $f\\prime=-1-x/2<0$；在 $(0,3]$ 上 $f\\prime=1-x/2$，驻点为 $x=2$。比较 $f(-1)=f(3)=3/4$、$f(0)=0$、$f(2)=1$，得到最小值 $0$，最大值 $1$，后者仅在 $x=2$ 取得。",
    },
    {
      kind: "multi",
      text: "求 $f(x)=2|x|-\\frac{x^2}{3}$ 在闭区间 $[-1,5]$ 上的最小值、最大值，以及取得最大值的 $x$。",
      parts: [
        {
          label: "最小值",
          kind: "number",
          answer: "0",
        },
        {
          label: "最大值",
          kind: "number",
          answer: "3",
        },
        {
          label: "取得最大值的 x",
          kind: "number",
          answer: "3",
        },
      ],
      hint: "按绝对值分段，保留不可导点与端点作为最值候选点。",
      explanation:
        "左段导数为 $-2-2x/3<0$，右段导数为 $2-2x/3$，右段驻点是 $x=3$。比较 $f(-1)=f(5)=5/3$、$f(0)=0$、$f(3)=3$，即得所求结论。",
    },
  ],
  "application-asymptote": [
    {
      kind: "multi",
      text: "曲线 $y=\\frac{2x^2+3x+4}{x-1}$ 有一条铅直渐近线 $x=a$ 和一条斜渐近线 $y=mx+b$。填写 $a,m,b$。",
      parts: [
        {
          label: "a",
          kind: "number",
          answer: "1",
        },
        {
          label: "m",
          kind: "number",
          answer: "2",
        },
        {
          label: "b",
          kind: "number",
          answer: "5",
        },
      ],
      hint: "检查分母零点附近的极限，再做多项式除法。",
      explanation:
        "$y=2x+5+\\frac9{x-1}$。当 $x\\to1$ 时余项无界，故铅直渐近线为 $x=1$；当 $|x|\\to\\infty$ 时余项趋于零，故斜渐近线为 $y=2x+5$。",
    },
    {
      kind: "multi",
      text: "曲线 $y=\\frac{3x^2-2x+5}{x+2}$ 有一条铅直渐近线 $x=a$ 和一条斜渐近线 $y=mx+b$。填写 $a,m,b$。",
      parts: [
        {
          label: "a",
          kind: "number",
          answer: "-2",
        },
        {
          label: "m",
          kind: "number",
          answer: "3",
        },
        {
          label: "b",
          kind: "number",
          answer: "-8",
        },
      ],
      hint: "先确认分母零点没有被约去，再分离线性部分和趋零的余项。",
      explanation:
        "$y=3x-8+\\frac{21}{x+2}$，余项在 $x=-2$ 处无界而在无穷远处趋零。故 $a=-2,m=3,b=-8$。",
    },
  ],
  "application-curvature": [
    {
      kind: "multi",
      text: "求曲线 $y=x^2$ 在点 $(0,0)$ 处的曲率 $K$ 和曲率半径 $R$。",
      parts: [
        {
          label: "曲率 K",
          kind: "number",
          answer: "2",
        },
        {
          label: "曲率半径 R",
          kind: "number",
          answer: "1/2",
        },
      ],
      hint: "使用 $K=\\frac{|y\\prime\\prime|}{(1+(y\\prime)^2)^{3/2}}$，并注意半径与曲率的关系。",
      explanation:
        "此处 $y\\prime=0,y\\prime\\prime=2$，故 $K=2$，$R=1/K=1/2$。",
    },
    {
      kind: "multi",
      text: "求曲线 $y=x^2$ 在点 $(1,1)$ 处的曲率 $K$ 和曲率半径 $R$。写精确值。",
      parts: [
        {
          label: "曲率 K",
          kind: "number",
          answer: "2/(5*sqrt(5))",
        },
        {
          label: "曲率半径 R",
          kind: "number",
          answer: "5*sqrt(5)/2",
        },
      ],
      hint: "先在指定点求出一阶、二阶导数，再使用曲率公式。",
      explanation:
        "此处 $y\\prime=2,y\\prime\\prime=2$，所以 $K=\\frac2{5\\sqrt5}$，$R=\\frac{5\\sqrt5}{2}$。",
    },
  ],
  "application-taylor-expand": [
    {
      kind: "multi",
      text: "在 $x\\to0$ 时，$e^x\\sin x=ax+bx^2+cx^3+o(x^3)$。求系数 $a,b,c$。",
      parts: [
        {
          label: "a",
          kind: "number",
          answer: "1",
        },
        {
          label: "b",
          kind: "number",
          answer: "1",
        },
        {
          label: "c",
          kind: "number",
          answer: "1/3",
        },
      ],
      hint: "分别展开两个因子，相乘时保留到三次项。",
      explanation:
        "由 $e^x=1+x+x^2/2+o(x^2)$ 与 $\\sin x=x-x^3/6+o(x^3)$，相乘得 $e^x\\sin x=x+x^2+(1/2-1/6)x^3+o(x^3)$，故系数为 $1,1,1/3$。",
    },
    {
      kind: "multi",
      text: "在 $x\\to0$ 时，$\\ln(1+2x)=ax+bx^2+cx^3+o(x^3)$。求系数 $a,b,c$。",
      parts: [
        {
          label: "a",
          kind: "number",
          answer: "2",
        },
        {
          label: "b",
          kind: "number",
          answer: "-2",
        },
        {
          label: "c",
          kind: "number",
          answer: "8/3",
        },
      ],
      hint: "先写出对数的标准展开，再整体代入自变量。",
      explanation:
        "在 $\\ln(1+u)=u-u^2/2+u^3/3+o(u^3)$ 中代入 $u=2x$，得到 $2x-2x^2+8x^3/3+o(x^3)$。",
    },
  ],
  "application-optimization": [
    {
      kind: "multi",
      text: "用总长 $24$ 米的围栏围一个矩形，其中一边靠墙且不需要围栏。设垂直墙的边长为 $x$ 米。忽略围栏厚度，求面积最大时的 $x$ 与最大面积（平方米）。",
      parts: [
        {
          label: "边长 x（米）",
          kind: "number",
          answer: "6",
        },
        {
          label: "最大面积（平方米）",
          kind: "number",
          answer: "72",
        },
      ],
      hint: "先用围栏总长表示另一条边，再在正边长范围内求面积最值。",
      explanation:
        "另一条边长为 $24-2x$，$0<x<12$。面积 $A=x(24-2x)$，$A\\prime=24-4x$，故唯一最大值在 $x=6$ 取得，面积为 $6\\cdot12=72$。",
    },
    {
      kind: "multi",
      text: "用总长 $40$ 米的围栏围一个矩形，其中一边靠墙且不需要围栏。设垂直墙的边长为 $x$ 米。忽略围栏厚度，求面积最大时的 $x$ 与最大面积（平方米）。",
      parts: [
        {
          label: "边长 x（米）",
          kind: "number",
          answer: "10",
        },
        {
          label: "最大面积（平方米）",
          kind: "number",
          answer: "200",
        },
      ],
      hint: "矩形有两条边垂直于墙，建立长度约束后再求导。",
      explanation:
        "$A=x(40-2x)$，定义域为 $0<x<20$。由 $A\\prime=40-4x=0$ 得 $x=10$，且 $A\\prime\\prime=-4<0$，最大面积为 $10\\cdot20=200$。",
    },
  ],
  "application-sketch": [
    {
      kind: "choice",
      text: "考察函数 $f(x)=x^3-3x$ 的图形，分别选择正确结论。",
      questions: [
        {
          prompt: "哪个是函数的最大严格递减开区间？",
          options: [
            {
              id: "A",
              text: "$(-\\infty,-1)$",
            },
            {
              id: "B",
              text: "$(-1,1)$",
            },
            {
              id: "C",
              text: "$(1,+\\infty)$",
            },
          ],
          answer: "B",
        },
        {
          prompt: "哪个点是图形的拐点？",
          options: [
            {
              id: "A",
              text: "$(0,0)$",
            },
            {
              id: "B",
              text: "$(-1,2)$",
            },
            {
              id: "C",
              text: "$(1,-2)$",
            },
          ],
          answer: "A",
        },
      ],
      hint: "分别用一阶导数判断单调性、二阶导数的变号判断拐点。",
      explanation:
        "$f\\prime=3(x^2-1)$，故最大严格递减开区间为 $(-1,1)$。$f\\prime\\prime=6x$ 在 $x=0$ 两侧变号，因此拐点为 $(0,0)$；另外两点是极值点。",
    },
    {
      kind: "choice",
      text: "考察函数 $f(x)=(x-2)^3-12(x-2)+1$ 的图形，分别选择正确结论。",
      questions: [
        {
          prompt: "哪个是函数的最大严格递减开区间？",
          options: [
            {
              id: "A",
              text: "$(0,4)$",
            },
            {
              id: "B",
              text: "$(-\\infty,0)$",
            },
            {
              id: "C",
              text: "$(4,+\\infty)$",
            },
          ],
          answer: "A",
        },
        {
          prompt: "哪个点是图形的拐点？",
          options: [
            {
              id: "A",
              text: "$(0,17)$",
            },
            {
              id: "B",
              text: "$(4,-15)$",
            },
            {
              id: "C",
              text: "$(2,1)$",
            },
          ],
          answer: "C",
        },
      ],
      hint: "平移不改变求导规则；把候选点代回原函数确认纵坐标。",
      explanation:
        "$f\\prime=3(x-2)^2-12$ 在 $(0,4)$ 内为负。$f\\prime\\prime=6(x-2)$ 仅在 $x=2$ 处变号，且 $f(2)=1$，所以拐点是 $(2,1)$。",
    },
  ],
  "application-mvt-proof": [
    {
      kind: "choice",
      text: "$f$ 在 $[1,2]$ 上连续、在 $(1,2)$ 内可导，且 $f(1)=4,f(2)=1$。欲证明存在 $\\xi\\in(1,2)$ 使 $\\xi f\\prime(\\xi)+2f(\\xi)=0$，选择两步正确论证。",
      questions: [
        {
          prompt: "哪一个辅助函数适合直接使用罗尔定理？",
          options: [
            {
              id: "A",
              text: "$F(x)=xf(x)$",
            },
            {
              id: "B",
              text: "$F(x)=x^2f(x)$",
            },
            {
              id: "C",
              text: "$F(x)=f(x)/x^2$",
            },
          ],
          answer: "B",
        },
        {
          prompt: "对于上一问正确的辅助函数，哪一步论证正确？",
          options: [
            {
              id: "A",
              text: "由 $F(1)=F(2)$ 可知区间内处处有 $F\\prime(x)=0$。",
            },
            {
              id: "B",
              text: "只要 $F$ 在开区间可导，就一定有 $F\\prime(\\xi)=0$。",
            },
            {
              id: "C",
              text: "$F$ 满足罗尔定理条件，故某点有 $F\\prime(\\xi)=\\xi[2f(\\xi)+\\xi f\\prime(\\xi)]=0$；因 $\\xi>0$ 可除去该因子。",
            },
          ],
          answer: "C",
        },
      ],
      hint: "从目标中的导数组合反推乘积，再逐项核对罗尔定理的条件。",
      explanation:
        "取 $F=x^2f$，有 $F(1)=4=F(2)$。该函数在闭区间连续、开区间可导，罗尔定理给出 $F\\prime(\\xi)=0$。展开并除以非零的 $\\xi$ 即得目标。端点相等只保证至少一个这样的点，不保证处处为零。",
    },
    {
      kind: "choice",
      text: "$f$ 在 $[1,3]$ 上连续、在 $(1,3)$ 内可导，且 $f(1)=27,f(3)=1$。欲证明存在 $\\xi\\in(1,3)$ 使 $\\xi f\\prime(\\xi)+3f(\\xi)=0$，选择两步正确论证。",
      questions: [
        {
          prompt: "哪一个辅助函数适合直接使用罗尔定理？",
          options: [
            {
              id: "A",
              text: "$F(x)=x^3f(x)$",
            },
            {
              id: "B",
              text: "$F(x)=3xf(x)$",
            },
            {
              id: "C",
              text: "$F(x)=f(x)/x^3$",
            },
          ],
          answer: "A",
        },
        {
          prompt: "对于上一问正确的辅助函数，哪一步论证正确？",
          options: [
            {
              id: "A",
              text: "端点相等说明 $F$ 一定是常数函数。",
            },
            {
              id: "B",
              text: "由罗尔定理得 $F\\prime(\\xi)=\\xi^2[3f(\\xi)+\\xi f\\prime(\\xi)]=0$，再利用 $\\xi^2>0$。",
            },
            {
              id: "C",
              text: "把罗尔定理直接用于 $f$，因为已知 $f(1)=f(3)$。",
            },
          ],
          answer: "B",
        },
      ],
      hint: "辅助函数必须同时产生所需导数组合，并具有相等的端点值。",
      explanation:
        "取 $F=x^3f$，则 $F(1)=27=F(3)$。连续可导条件由乘积继承，罗尔定理给出 $F\\prime(\\xi)=0$。除以 $\\xi^2$ 后得到目标。原函数的两个端点值并不相等。",
    },
  ],
  "application-cauchy": [
    {
      kind: "multi",
      text: "对 $f(x)=x^2$ 与 $g(x)=\\ln x$，在 $[1,2]$ 上应用柯西中值定理。填写端点增量比 $r=\\frac{f(2)-f(1)}{g(2)-g(1)}$，以及满足 $\\frac{f\\prime(\\xi)}{g\\prime(\\xi)}=r$ 的 $\\xi\\in(1,2)$。",
      parts: [
        {
          label: "增量比 r",
          kind: "number",
          answer: "3/ln(2)",
        },
        {
          label: "中值点 ξ",
          kind: "number",
          answer: "sqrt(3/(2*ln(2)))",
        },
      ],
      hint: "先确认两个函数的连续可导条件，以及分母导数不为零。",
      explanation:
        "两函数在该区间满足定理条件，且 $g\\prime=1/x\\ne0$。端点增量比为 $3/\\ln2$，而导数比为 $2\\xi^2$，故 $\\xi=\\sqrt{3/(2\\ln2)}\\in(1,2)$。",
    },
    {
      kind: "multi",
      text: "对 $f(x)=x^2$ 与 $g(x)=\\ln x$，在 $[1,3]$ 上应用柯西中值定理。填写端点增量比 $r=\\frac{f(3)-f(1)}{g(3)-g(1)}$，以及满足 $\\frac{f\\prime(\\xi)}{g\\prime(\\xi)}=r$ 的 $\\xi\\in(1,3)$。",
      parts: [
        {
          label: "增量比 r",
          kind: "number",
          answer: "8/ln(3)",
        },
        {
          label: "中值点 ξ",
          kind: "number",
          answer: "2/sqrt(ln(3))",
        },
      ],
      hint: "导数之比与端点增量之比相等，最后只取指定开区间中的根。",
      explanation:
        "$g\\prime(x)=1/x>0$。由柯西中值定理，$2\\xi^2=8/\\ln3$，所以 $r=8/\\ln3$，$\\xi=2/\\sqrt{\\ln3}\\in(1,3)$。",
    },
  ],
  "application-inequality": [
    {
      kind: "choice",
      text: "证明对所有 $x>0$ 都有 $\\ln(1+x)<x$。请选择辅助函数和有效的单调性论证。",
      questions: [
        {
          prompt: "把所证不等式化为 F(x)>0，且 F(0)=0，可选哪个函数？",
          options: [
            {
              id: "A",
              text: "$F(x)=x-\\ln(1+x)$",
            },
            {
              id: "B",
              text: "$F(x)=\\ln(1+x)-x$",
            },
            {
              id: "C",
              text: "$F(x)=x+\\ln(1+x)+1$",
            },
          ],
          answer: "A",
        },
        {
          prompt: "对上一问正确的 F，哪段推理有效？",
          options: [
            {
              id: "A",
              text: "$F\\prime(x)=-x/(1+x)<0$，故 $F(x)>F(0)$。",
            },
            {
              id: "B",
              text: "$F\\prime(x)=x/(1+x)>0$，故 $F(x)>F(0)=0$。",
            },
            {
              id: "C",
              text: "仅由 $F(0)=0$ 就能推出 $x>0$ 时 $F(x)>0$。",
            },
          ],
          answer: "B",
        },
      ],
      hint: "把两边移到同一侧，寻找有已知起点值且单调性明确的函数。",
      explanation:
        "取 $F=x-\\ln(1+x)$。$F(0)=0$，且 $F\\prime=x/(1+x)>0$ 对 $x>0$ 成立。故 $F$ 从零处严格增加，得到所证严格不等式。",
    },
    {
      kind: "choice",
      text: "证明对所有 $x>0$ 都有 $e^x>1+x$。请选择辅助函数和有效的单调性论证。",
      questions: [
        {
          prompt: "把所证不等式化为 F(x)>0，且 F(0)=0，可选哪个函数？",
          options: [
            {
              id: "A",
              text: "$F(x)=1+x-e^x$",
            },
            {
              id: "B",
              text: "$F(x)=e^x+x$",
            },
            {
              id: "C",
              text: "$F(x)=e^x-1-x$",
            },
          ],
          answer: "C",
        },
        {
          prompt: "对上一问正确的 F，哪段推理有效？",
          options: [
            {
              id: "A",
              text: "$F\\prime(x)=e^x-1>0$，故 $F(x)>F(0)=0$。",
            },
            {
              id: "B",
              text: "$F\\prime(x)=1-e^x>0$，故 $F$ 严格增加。",
            },
            {
              id: "C",
              text: "由 $F(0)=0$ 可知 $F$ 在整个正半轴恒为零。",
            },
          ],
          answer: "A",
        },
      ],
      hint: "比较原函数与其线性部分，先核对零点处函数值再看导数。",
      explanation:
        "取 $F=e^x-1-x$，有 $F(0)=0$。当 $x>0$ 时 $F\\prime=e^x-1>0$，所以 $F(x)>0$。",
    },
  ],
  "application-root-count": [
    {
      kind: "number",
      text: "方程 $x^3-3x+1=0$ 有多少个不同的实根？",
      answer: "3",
      hint: "结合导数的符号、极值与无穷远处的趋势，在各单调区间计数。",
      explanation:
        "设 $f=x^3-3x+1$。导数在 $(-\\infty,-1)$、$(1,+\\infty)$ 为正，在 $(-1,1)$ 为负；$f(-1)=3>0,f(1)=-1<0$。结合两端极限，每个上述区间恰有一根，共 $3$ 个。",
    },
    {
      kind: "number",
      text: "方程 $x^3-3x+3=0$ 有多少个不同的实根？",
      answer: "1",
      hint: "不要只看驻点的数量；还需要考察驻点处函数值的正负。",
      explanation:
        "导数仍为 $3(x^2-1)$，但局部最大值为 $f(-1)=5$，局部最小值为 $f(1)=1$，均为正。只有 $(-\\infty,-1)$ 上从负无穷增加到正数时穿过零点，因此恰有 $1$ 个实根。",
    },
  ],
  "application-curvature-center": [
    {
      kind: "multi",
      text: "求曲线 $y=x^2$ 在 $(0,0)$ 处的曲率圆：圆心记为 $(a,b)$，半径记为 $R$。填写 $a,b,R$。",
      parts: [
        {
          label: "圆心横坐标 a",
          kind: "number",
          answer: "0",
        },
        {
          label: "圆心纵坐标 b",
          kind: "number",
          answer: "1/2",
        },
        {
          label: "半径 R",
          kind: "number",
          answer: "1/2",
        },
      ],
      hint: "使用曲率中心公式时保留二阶导数的符号，半径取正数。",
      explanation:
        "曲率中心为 $a=x-\\frac{y\\prime(1+(y\\prime)^2)}{y\\prime\\prime}$、$b=y+\\frac{1+(y\\prime)^2}{y\\prime\\prime}$。代入 $(0,0)$、$y\\prime=0,y\\prime\\prime=2$，得中心 $(0,1/2)$，半径 $1/2$。",
    },
    {
      kind: "multi",
      text: "求曲线 $y=2x^2$ 在 $(1/2,1/2)$ 处的曲率圆：圆心记为 $(a,b)$，半径记为 $R$。填写 $a,b,R$，写精确值。",
      parts: [
        {
          label: "圆心横坐标 a",
          kind: "number",
          answer: "-2",
        },
        {
          label: "圆心纵坐标 b",
          kind: "number",
          answer: "7/4",
        },
        {
          label: "半径 R",
          kind: "number",
          answer: "5*sqrt(5)/4",
        },
      ],
      hint: "先求指定点的两个导数，再求法线方向上的曲率中心。",
      explanation:
        "此处 $y\\prime=2,y\\prime\\prime=4$，故 $a=1/2-2\\cdot5/4=-2$，$b=1/2+5/4=7/4$。半径 $R=(1+4)^{3/2}/4=5\\sqrt5/4$。",
    },
  ],
  "application-newton": [
    {
      kind: "multi",
      text: "用牛顿迭代法求 $x^2-2=0$ 的正根，取 $x_0=1$。求前两次迭代值 $x_1,x_2$，保留精确分数。",
      parts: [
        {
          label: "x₁",
          kind: "number",
          answer: "3/2",
        },
        {
          label: "x₂",
          kind: "number",
          answer: "17/12",
        },
      ],
      hint: "使用 $x_{n+1}=x_n-f(x_n)/f\\prime(x_n)$，每一步都使用上一步结果。",
      explanation:
        "迭代式为 $x_{n+1}=(x_n+2/x_n)/2$。由 $x_0=1$ 得 $x_1=3/2$，再得 $x_2=(3/2+4/3)/2=17/12$。",
    },
    {
      kind: "multi",
      text: "用牛顿迭代法求 $x^2-3=0$ 的正根，取 $x_0=2$。求前两次迭代值 $x_1,x_2$，保留精确分数。",
      parts: [
        {
          label: "x₁",
          kind: "number",
          answer: "7/4",
        },
        {
          label: "x₂",
          kind: "number",
          answer: "97/56",
        },
      ],
      hint: "先按当前方程求导，再把迭代值逐次代入，不要沿用别的方程的迭代式。",
      explanation:
        "迭代式为 $x_{n+1}=(x_n+3/x_n)/2$。先得 $x_1=(2+3/2)/2=7/4$，再得 $x_2=(7/4+12/7)/2=97/56$。",
    },
  ],
  "definite-properties": [
    {
      kind: "multi",
      text: "对 $I=\\int_0^2\\frac{dx}{1+x^2}$，只使用被积函数在整个积分区间上的最小值 $m$、最大值 $M$ 及估值式 $m(b-a)\\le I\\le M(b-a)$。填写该估值式的下界 $L$ 和上界 $U$，不是积分的精确值。",
      parts: [
        {
          label: "估值下界 L",
          kind: "number",
          answer: "2/5",
        },
        {
          label: "估值上界 U",
          kind: "number",
          answer: "2",
        },
      ],
      hint: "先求被积函数在闭区间上的最大、最小值，再乘以区间长度。",
      explanation:
        "被积函数在 $[0,2]$ 上递减，故 $m=1/5,M=1$。区间长度为 $2$，因此这条估值式为 $2/5\\le I\\le2$。",
    },
    {
      kind: "multi",
      text: "对 $I=\\int_0^3\\sqrt{1+x}\\,dx$，只使用被积函数在整个积分区间上的最小值 $m$、最大值 $M$ 及估值式 $m(b-a)\\le I\\le M(b-a)$。填写该估值式的下界 $L$ 和上界 $U$，不是积分的精确值。",
      parts: [
        {
          label: "估值下界 L",
          kind: "number",
          answer: "3",
        },
        {
          label: "估值上界 U",
          kind: "number",
          answer: "6",
        },
      ],
      hint: "这题问指定估值法的两个边界，不需要先算出积分。",
      explanation:
        "$\\sqrt{1+x}$ 在 $[0,3]$ 上递增，故 $m=1,M=2$。乘以区间长度 $3$，得到 $3\\le I\\le6$。",
    },
  ],
  "definite-volume": [
    {
      kind: "multi",
      text: "由 $y=x$、$y=0$、$x=2$ 围成的平面区域，分别绕 $x$ 轴与 $y$ 轴旋转一周。求所得体积 $V_x,V_y$，保留 $\\pi$。",
      parts: [
        {
          label: "绕 x 轴的体积 Vₓ",
          kind: "number",
          answer: "8*pi/3",
        },
        {
          label: "绕 y 轴的体积 Vᵧ",
          kind: "number",
          answer: "16*pi/3",
        },
      ],
      hint: "绕横轴可用圆盘法；绕纵轴可用柱壳法，半径与高度要分别确定。",
      explanation:
        "区域为 $0\\le x\\le2,0\\le y\\le x$。绕横轴的体积为 $\\pi\\int_0^2x^2dx=8\\pi/3$；绕纵轴为 $2\\pi\\int_0^2x\\cdot x\\,dx=16\\pi/3$。",
    },
    {
      kind: "multi",
      text: "由 $y=x^2$、$y=0$、$x=1$ 围成的平面区域，分别绕 $x$ 轴与 $y$ 轴旋转一周。求所得体积 $V_x,V_y$，保留 $\\pi$。",
      parts: [
        {
          label: "绕 x 轴的体积 Vₓ",
          kind: "number",
          answer: "pi/5",
        },
        {
          label: "绕 y 轴的体积 Vᵧ",
          kind: "number",
          answer: "pi/2",
        },
      ],
      hint: "圆盘法中的面积要平方半径，柱壳法中的半径与高度相乘。",
      explanation:
        "区域为 $0\\le x\\le1,0\\le y\\le x^2$。$V_x=\\pi\\int_0^1x^4dx=\\pi/5$；$V_y=2\\pi\\int_0^1x^3dx=\\pi/2$。",
    },
  ],
  "definite-mvt-proof": [
    {
      kind: "choice",
      text: "$f$ 在 $[0,2]$ 上连续、在 $(0,2)$ 内可导，且 $\\int_0^1 f(x)\\,dx=\\int_1^2 f(x)\\,dx$。欲证明存在 $\\xi\\in(0,2)$ 使 $f\\prime(\\xi)=0$，选择正确的两步。",
      questions: [
        {
          prompt: "分别对两个积分应用积分中值定理，可以得到什么？",
          options: [
            {
              id: "A",
              text: "存在 $\\alpha\\in(0,1),\\beta\\in(1,2)$，使 $f(\\alpha)=f(\\beta)$。",
            },
            {
              id: "B",
              text: "一定有 $f(0)=f(2)$。",
            },
            {
              id: "C",
              text: "一定有 $f(1)=0$。",
            },
          ],
          answer: "A",
        },
        {
          prompt: "得到上一问正确结论后，怎样推出目标？",
          options: [
            {
              id: "A",
              text: "不检查端点，直接在 $[0,2]$ 对 $f$ 应用罗尔定理。",
            },
            {
              id: "B",
              text: "积分相等意味着 $f$ 恒为常数。",
            },
            {
              id: "C",
              text: "在 $[\\alpha,\\beta]$ 对 $f$ 用罗尔定理，得到某个 $\\xi\\in(\\alpha,\\beta)$ 使 $f\\prime(\\xi)=0$。",
            },
          ],
          answer: "C",
        },
      ],
      hint: "积分中值定理先提供两个相等的函数值，再由另一个中值定理连接它们。",
      explanation:
        "两个子区间长度均为 $1$，故积分中值定理给出 $f(\\alpha)=\\int_0^1f=\\int_1^2f=f(\\beta)$。由于 $0<\\alpha<1<\\beta<2$ 且 $f$ 满足连续可导条件，在 $[\\alpha,\\beta]$ 应用罗尔定理即可。",
    },
    {
      kind: "choice",
      text: "$f$ 在 $[0,2]$ 上连续、在 $(0,2)$ 内可导，且 $\\int_0^1 f(x)\\,dx=1$、$\\int_1^2 f(x)\\,dx=3$。欲证明存在 $\\xi\\in(0,2)$ 使 $f\\prime(\\xi)=2$，选择正确的两步。",
      questions: [
        {
          prompt: "哪一个辅助函数在两个子区间上的积分都为零？",
          options: [
            {
              id: "A",
              text: "$h(x)=f(x)-x$",
            },
            {
              id: "B",
              text: "$h(x)=f(x)-2x$",
            },
            {
              id: "C",
              text: "$h(x)=f(x)-2$",
            },
          ],
          answer: "B",
        },
        {
          prompt: "对上一问正确的 h，哪段论证有效？",
          options: [
            {
              id: "A",
              text: "积分中值定理给出 $h(\\alpha)=h(\\beta)=0$，其中 $\\alpha\\in(0,1),\\beta\\in(1,2)$；再用罗尔定理得 $h\\prime(\\xi)=0$，即 $f\\prime(\\xi)=2$。",
            },
            {
              id: "B",
              text: "两个积分为零意味着 $h$ 恒为零。",
            },
            {
              id: "C",
              text: "只由 $\\int_0^2h=0$ 就能断定 $h\\prime(1)=0$。",
            },
          ],
          answer: "A",
        },
      ],
      hint: "先减去一个线性函数，使两个积分条件化为相同形式。",
      explanation:
        "$\\int_0^12x\\,dx=1$、$\\int_1^22x\\,dx=3$，所以 $h=f-2x$ 的两个积分均为零。分别取积分中值点后，在它们之间应用罗尔定理，得 $h\\prime=f\\prime-2=0$。",
    },
  ],
  "definite-improper-test": [
    {
      kind: "choice",
      text: "分别判断下列反常积分的敛散性，可使用比较判别法。",
      questions: [
        {
          prompt: "$\\int_1^{+\\infty}\\frac{dx}{x^2+1}$",
          options: [
            {
              id: "A",
              text: "收敛",
            },
            {
              id: "B",
              text: "发散",
            },
          ],
          answer: "A",
        },
        {
          prompt: "$\\int_0^1\\frac{dx}{\\sqrt{x}(1+x)}$",
          options: [
            {
              id: "A",
              text: "发散",
            },
            {
              id: "B",
              text: "收敛",
            },
          ],
          answer: "B",
        },
      ],
      hint: "分别考察无穷远和零点附近，把被积函数与合适的幂函数比较。",
      explanation:
        "第一式满足 $0<1/(x^2+1)\\le1/x^2$，而 $\\int_1^\\infty x^{-2}dx$ 收敛。第二式满足 $0<1/(\\sqrt{x}(1+x))\\le x^{-1/2}$，而 $\\int_0^1x^{-1/2}dx$ 收敛。所以两式均收敛。",
    },
    {
      kind: "choice",
      text: "分别判断下列反常积分的敛散性，可使用极限比较判别法。",
      questions: [
        {
          prompt: "$\\int_1^{+\\infty}\\frac{x}{x^2+1}\\,dx$",
          options: [
            {
              id: "A",
              text: "收敛",
            },
            {
              id: "B",
              text: "发散",
            },
          ],
          answer: "B",
        },
        {
          prompt: "$\\int_0^1\\frac{dx}{x(1+x)}$",
          options: [
            {
              id: "A",
              text: "发散",
            },
            {
              id: "B",
              text: "收敛",
            },
          ],
          answer: "A",
        },
      ],
      hint: "比较函数应针对出问题的端点选择，再求两个被积函数的比值极限。",
      explanation:
        "第一式与 $1/x$ 在无穷远处的比值趋于 $1$，第二式与 $1/x$ 在 $0^+$ 附近的比值也趋于 $1$。相应的两个 $p=1$ 型反常积分均发散，故原积分均发散。",
    },
  ],
  "ode-nonhomog-exp": [
    {
      kind: "expr",
      text: "求初值问题 $y\\prime\\prime-3y\\prime+2y=e^x$，$y(0)=0,y\\prime(0)=0$ 的解，写 $y$ 关于 $x$ 的显式表达式。",
      answer: "e^(2*x)-(x+1)*e^x",
      hint: "先看齐次特征根与右端指数是否重合，再确定特解形式并代入初值。",
      explanation:
        "齐次根为 $1,2$。由于右端指数对应单特征根，可取特解 $-xe^x$。通式为 $C_1e^x+C_2e^{2x}-xe^x$，初值给出 $C_1+C_2=0$、$C_1+2C_2-1=0$，故 $y=e^{2x}-(x+1)e^x$。",
      note: "只写显式表达式，不保留任意常数",
    },
    {
      kind: "expr",
      text: "求初值问题 $y\\prime\\prime-4y\\prime+4y=e^{2x}$，$y(0)=0,y\\prime(0)=0$ 的解，写 $y$ 关于 $x$ 的显式表达式。",
      answer: "x^2*e^(2*x)/2",
      hint: "本题右端指数对应的特征根可能有重数，设特解时要考虑这一点。",
      explanation:
        "令 $y=e^{2x}u$，方程化为 $u\\prime\\prime=1$。初值给出 $u(0)=u\\prime(0)=0$，故 $u=x^2/2$，从而 $y=x^2e^{2x}/2$。",
      note: "只写显式表达式，不保留任意常数",
    },
  ],
  "ode-nonhomog-trig": [
    {
      kind: "expr",
      text: "求初值问题 $y\\prime\\prime+y=\\sin x$，$y(0)=0,y\\prime(0)=0$ 的解。",
      answer: "(sin(x)-x*cos(x))/2",
      hint: "先判断是否共振，求出一个特解后再用初值确定齐次部分。",
      explanation:
        "可取特解 $-x\\cos x/2$。通式为 $C_1\\cos x+C_2\\sin x-x\\cos x/2$。由初值得 $C_1=0,C_2=1/2$，故 $y=(\\sin x-x\\cos x)/2$。",
      note: "写 y 的显式表达式",
    },
    {
      kind: "expr",
      text: "求初值问题 $y\\prime\\prime+4y=\\cos 2x$，$y(0)=0,y\\prime(0)=0$ 的解。",
      answer: "x*sin(2*x)/4",
      hint: "右端三角函数的频率与齐次解频率相同，先处理共振。",
      explanation:
        "试取 $y_p=Ax\\sin2x$，代入得 $y_p\\prime\\prime+4y_p=4A\\cos2x$，所以 $A=1/4$。该特解已满足两个零初值，因此 $y=x\\sin2x/4$。",
      note: "写 y 的显式表达式",
    },
  ],
  "ode-variation": [
    {
      kind: "expr",
      text: "在区间 $(-\\pi/2,\\pi/2)$ 内，用常数变易法求 $y\\prime\\prime+y=1/\\cos x$ 满足 $y(0)=0,y\\prime(0)=0$ 的解。",
      answer: "cos(x)*ln(cos(x))+x*sin(x)",
      hint: "可由齐次方程的一对线性无关解建立常数变易方程，再代入初值。",
      explanation:
        "取齐次基底 $\\cos x,\\sin x$，朗斯基行列式为 $1$。常数变易公式给出 $y_p=-\\cos x\\int\\tan x\\,dx+\\sin x\\int1\\,dx=\\cos x\\ln(\\cos x)+x\\sin x$。在给定区间内 $\\cos x>0$；此式及其导数在 $0$ 处都为零，故已是所求解。",
      note: "写 y 的显式表达式；仅在题给区间讨论",
      onAnswerDomain: true,
    },
    {
      kind: "expr",
      text: "在区间 $(0,\\pi)$ 内，用常数变易法求 $y\\prime\\prime+y=1/\\sin x$ 满足 $y(\\pi/2)=0,y\\prime(\\pi/2)=0$ 的解。",
      answer: "(pi/2-x)*cos(x)+sin(x)*ln(sin(x))",
      hint: "齐次基底不变，但积分中的右端项和初值点都要按本题重算。",
      explanation:
        "常数变易给出一个特解 $-x\\cos x+\\sin x\\ln(\\sin x)$。它在 $\\pi/2$ 处的值为 $0$，导数为 $\\pi/2$；补上 $(\\pi/2)\\cos x$ 后两个初值都满足。所以 $y=(\\pi/2-x)\\cos x+\\sin x\\ln(\\sin x)$。区间内 $\\sin x>0$。",
      note: "写 y 的显式表达式；仅在题给区间讨论",
      onAnswerDomain: true,
    },
  ],
  "ode-euler": [
    {
      kind: "expr",
      text: "在 $x>0$ 上，求欧拉方程 $x^2y\\prime\\prime-2xy\\prime+2y=0$ 满足 $y(1)=3,y\\prime(1)=4$ 的解。",
      answer: "x^2+2*x",
      hint: "齐次欧拉方程可先尝试幂函数，再用初值确定系数。",
      explanation:
        "设 $y=x^m$，得到 $m(m-1)-2m+2=(m-1)(m-2)=0$，所以 $y=C_1x+C_2x^2$。初值得 $C_1+C_2=3$、$C_1+2C_2=4$，故 $y=2x+x^2$。",
      note: "写 y 的显式表达式，不保留任意常数",
      domain: "positive",
    },
    {
      kind: "expr",
      text: "在 $x>0$ 上，求欧拉方程 $x^2y\\prime\\prime+xy\\prime-y=0$ 满足 $y(1)=1,y\\prime(1)=3$ 的解。",
      answer: "2*x-1/x",
      hint: "将幂函数代入后，注意二阶导数产生的因子是 m(m−1)。",
      explanation:
        "设 $y=x^m$，得 $m(m-1)+m-1=m^2-1=0$。所以 $y=C_1x+C_2/x$；由初值得 $C_1+C_2=1$、$C_1-C_2=3$，即 $y=2x-1/x$。",
      note: "写 y 的显式表达式，不保留任意常数",
      domain: "positive",
    },
  ],
  "ode-system": [
    {
      kind: "multi",
      text: "求常系数系统 $u\\prime(t)=u(t)+v(t)$、$v\\prime(t)=u(t)+v(t)$，满足 $u(0)=1,v(0)=0$ 的解。两空分别写 $u(t),v(t)$ 的显式表达式。",
      parts: [
        {
          label: "u(t)",
          kind: "expr",
          answer: "(e^(2*t)+1)/2",
          var: "t",
        },
        {
          label: "v(t)",
          kind: "expr",
          answer: "(e^(2*t)-1)/2",
          var: "t",
        },
      ],
      hint: "考虑两个未知函数的和与差，把系统化成两个一阶方程。",
      explanation:
        "令 $s=u+v,d=u-v$，则 $s\\prime=2s,d\\prime=0$，初值是 $s(0)=d(0)=1$。故 $s=e^{2t},d=1$，从而 $u=(e^{2t}+1)/2,v=(e^{2t}-1)/2$。",
    },
    {
      kind: "multi",
      text: "求常系数系统 $u\\prime(t)=2u(t)-v(t)$、$v\\prime(t)=-u(t)+2v(t)$，满足 $u(0)=0,v(0)=2$ 的解。两空分别写 $u(t),v(t)$ 的显式表达式。",
      parts: [
        {
          label: "u(t)",
          kind: "expr",
          answer: "e^t-e^(3*t)",
          var: "t",
        },
        {
          label: "v(t)",
          kind: "expr",
          answer: "e^t+e^(3*t)",
          var: "t",
        },
      ],
      hint: "先求和与差各自满足的方程，再还原原来的两个函数。",
      explanation:
        "令 $s=u+v,d=u-v$，有 $s\\prime=s,d\\prime=3d$，且 $s(0)=2,d(0)=-2$。因此 $s=2e^t,d=-2e^{3t}$，还原得 $u=e^t-e^{3t},v=e^t+e^{3t}$。",
    },
  ],
};

for (const [pointId, variants] of Object.entries(KEY_VARIANTS)) {
  const problems = PROBLEMS[pointId];
  if (!problems) throw new Error(`unknown ★ point: ${pointId}`);
  problems.push(...variants);
}
// 0.6.0 : the bank as served — only plain-number fill-ins and single
// choice — a read-only live view of PROBLEMS, which stays as authored (the
// judge and content tests read it; test fixtures put into it are served).
export const BANK: Record<string, Problem[]> = serveBank(PROBLEMS);
