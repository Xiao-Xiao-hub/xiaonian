import type { ChoiceSource } from "./problems-choices.js";

// 0.6.0  data for the bank's single-choice problems. Drafted by AI and
// program-checked (tests/v41-learn-bank.test.ts); not reviewed by a teacher.

// Authored choice problems whose questions had three options: the fourth, a
// wrong one, per question. It goes in at the question's fixed slot.
export const FOURTH_OPTIONS: Record<string, string[]> = {
  "application-sketch#0": ["$(-\\infty,0)$", "$(0,-3)$"],
  "application-sketch#1": ["$(-\\infty,2)$", "$(2,0)$"],
  "application-sketch#2": ["$(-\\infty,0)$", "$(0,-12)$"],
  "application-sketch#3": ["$(-\\infty,-1)$", "$(-1,0)$"],
  "application-mvt-proof#0": [
    "$F(x)=e^{2x}f(x)$",
    "由拉格朗日中值定理得 $f\\prime(\\xi)=f(2)-f(1)=-3$，即为所证。",
  ],
  "application-mvt-proof#1": [
    "$F(x)=e^{3x}f(x)$",
    "由拉格朗日中值定理得 $f\\prime(\\xi)=\\frac{f(3)-f(1)}{2}=-13$，即为所证。",
  ],
  "application-mvt-proof#2": [
    "$F(x)=e^{4x}f(x)$",
    "由拉格朗日中值定理得 $f'(\\xi)=f(2)-f(1)=-15$，即为所证。",
  ],
  "application-mvt-proof#3": [
    "$F(x)=e^{2x}f(x)$",
    "由拉格朗日中值定理得 $f'(\\xi)=\\frac{f(4)-f(1)}{3}=-5$，即为所证。",
  ],
  "application-inequality#0": [
    "$F(x)=x-\\ln x$",
    "$F\\prime(x)=1-\\frac{1}{1+x}>0$，故 $F(x)<F(0)=0$。",
  ],
  "application-inequality#1": [
    "$F(x)=e^x-x$",
    "$F\\prime(x)=e^x-1>0$，故 $F(x)<F(0)=0$。",
  ],
  "application-inequality#2": [
    "$F(x)=x-\\tan x$",
    "$F'(x)=\\frac{1}{1+x^2}-1<0$，所以 $F(x)>F(0)=0$。",
  ],
  "application-inequality#3": [
    "$F(x)=x-e^{-x}$",
    "$F'(x)=1+e^{-x}>0$，所以 $F(x)>F(0)=0$。",
  ],
  "definite-mvt-proof#0": [
    "存在 $\\xi\\in(0,2)$，使 $f(\\xi)=\\int_0^2 f(x)\\,dx$。",
    "在 $[0,1]$ 上对 $f$ 用拉格朗日中值定理，得 $f\\prime(\\xi)=f(1)-f(0)$。",
  ],
  "definite-mvt-proof#1": [
    "$h(x)=f(x)-x^2$",
    "由拉格朗日中值定理，$f\\prime(\\xi)=\\frac{f(2)-f(0)}{2}=2$。",
  ],
};

// Authored choice problems of two yes/no questions, asked as one question
// with the four combinations instead.
export const MERGED_CHOICES: Record<
  string,
  { text: string; options: string[]; right: number }
> = {
  "definite-improper-test#0": {
    text: "判断下列两个反常积分的敛散性，可使用比较判别法：①$\\int_1^{+\\infty}\\frac{dx}{x^2+1}$；②$\\int_0^1\\frac{dx}{\\sqrt{x}(1+x)}$。",
    options: ["①收敛，②收敛", "①收敛，②发散", "①发散，②收敛", "①发散，②发散"],
    right: 0,
  },
  "definite-improper-test#1": {
    text: "判断下列两个反常积分的敛散性，可使用极限比较判别法：①$\\int_1^{+\\infty}\\frac{x}{x^2+1}\\,dx$；②$\\int_0^1\\frac{dx}{x(1+x)}$。",
    options: ["①收敛，②收敛", "①收敛，②发散", "①发散，②收敛", "①发散，②发散"],
    right: 3,
  },
};

// Options of the problems authored as fill-ins and served as single choice,
// keyed "pointId#index".
export const CHOICE_DATA: Record<string, ChoiceSource> = {
  "limit-important-e#0": {"right": "e^{2}", "wrong": [["e^{1}", "e^1"], ["e^{-2}", "e^(-2)"], ["e^{4}", "e^4"]]},
  "limit-important-e#1": {"right": "e^{4}", "wrong": [["e^{2}", "e^2"], ["e^{-4}", "e^(-4)"], ["e^{8}", "e^8"]]},
  "limit-1-to-inf#0": {"right": "e^{-\\frac{1}{2}}", "wrong": [["e^{\\frac{1}{2}}", "e^(1/2)"], ["e^{-1}", "e^(-1)"], ["e^{-\\frac{1}{4}}", "e^(-1/4)"]]},
  "limit-1-to-inf#1": {"right": "e^{-2}", "wrong": [["e^{-1}", "e^(-1)"], ["e^{-4}", "e^(-4)"], ["e^{2}", "e^2"]]},
  "limit-1-to-inf#2": {"right": "e^{-\\frac{3}{2}}", "wrong": [["e^{-\\frac{1}{2}}", "e^(-1/2)"], ["e^{-3}", "e^(-3)"], ["e^{\\frac{3}{2}}", "e^(3/2)"]]},
  "limit-1-to-inf#3": {"right": "e^{-9}", "wrong": [["e^{-3}", "e^(-3)"], ["e^{-\\frac{9}{2}}", "e^(-9/2)"], ["e^{9}", "e^9"]]},
  "derivative-rules#0": {"right": "2x\\arctan x+1", "wrong": [["2x\\arctan x-1", "2*x*arctan(x)-1"], ["x\\arctan x+1", "x*arctan(x)+1"], ["2x\\arctan x+\\frac{1}{1+x^2}", "2*x*arctan(x)+1/(1+x^2)"]]},
  "derivative-rules#1": {"right": "(3x^2+1)\\arctan x+x", "wrong": [["(3x^2+1)\\arctan x-x", "(3*x^2+1)*arctan(x)-x"], ["3x^2\\arctan x+x", "3*x^2*arctan(x)+x"], ["(3x^2+1)\\arctan x+\\frac{1}{1+x^2}", "(3*x^2+1)*arctan(x)+1/(1+x^2)"]]},
  "derivative-chain#0": {"right": "\\frac{1}{\\sqrt{1+x^2}}", "wrong": [["\\frac{1}{x+\\sqrt{1+x^2}}", "1/(x+sqrt(1+x^2))"], ["\\frac{1}{1+x^2}", "1/(1+x^2)"], ["\\frac{x}{\\sqrt{1+x^2}}", "x/sqrt(1+x^2)"]]},
  "derivative-chain#1": {"right": "\\frac{1}{\\sqrt{4+x^2}}", "wrong": [["\\frac{1}{x+\\sqrt{4+x^2}}", "1/(x+sqrt(4+x^2))"], ["\\frac{1}{4+x^2}", "1/(4+x^2)"], ["\\frac{x}{\\sqrt{4+x^2}}", "x/sqrt(4+x^2)"]]},
  "derivative-second#0": {"right": "\\frac{2(1-x^2)}{(1+x^2)^2}", "wrong": [["\\frac{2(1+3x^2)}{(1+x^2)^2}", "2*(1+3*x^2)/(1+x^2)^2"], ["\\frac{2(1-x^2)}{1+x^2}", "2*(1-x^2)/(1+x^2)"], ["\\frac{1-x^2}{(1+x^2)^2}", "(1-x^2)/(1+x^2)^2"]]},
  "derivative-second#1": {"right": "\\frac{2(4-x^2)}{(4+x^2)^2}", "wrong": [["\\frac{2(4+3x^2)}{(4+x^2)^2}", "2*(4+3*x^2)/(4+x^2)^2"], ["\\frac{2(4-x^2)}{4+x^2}", "2*(4-x^2)/(4+x^2)"], ["\\frac{4-x^2}{(4+x^2)^2}", "(4-x^2)/(4+x^2)^2"]]},
  "derivative-higher#0": {"right": "e^{-x}(x^2-20x+90)", "wrong": [["e^{-x}(x^2+20x+90)", "e^(-x)*(x^2+20*x+90)"], ["e^{-x}(x^2-20x+45)", "e^(-x)*(x^2-20*x+45)"], ["e^{-x}(x^2-20x+100)", "e^(-x)*(x^2-20*x+100)"]]},
  "derivative-higher#1": {"right": "e^{-x}(x^2-16x+56)", "wrong": [["e^{-x}(x^2+16x+56)", "e^(-x)*(x^2+16*x+56)"], ["e^{-x}(x^2-16x+28)", "e^(-x)*(x^2-16*x+28)"], ["e^{-x}(x^2-16x+64)", "e^(-x)*(x^2-16*x+64)"]]},
  "derivative-higher#2": {"right": "e^{-x}(x^2-12x+30)", "wrong": [["e^{-x}(x^2+12x+30)", "e^(-x)*(x^2+12*x+30)"], ["e^{-x}(x^2-12x+15)", "e^(-x)*(x^2-12*x+15)"], ["e^{-x}(x^2-12x+36)", "e^(-x)*(x^2-12*x+36)"]]},
  "derivative-higher#3": {"right": "e^{-x}(x^2-8x+12)", "wrong": [["e^{-x}(x^2+8x+12)", "e^(-x)*(x^2+8*x+12)"], ["e^{-x}(x^2-8x+6)", "e^(-x)*(x^2-8*x+6)"], ["e^{-x}(x^2-8x+16)", "e^(-x)*(x^2-8*x+16)"]]},
  "derivative-log#0": {"right": "x^{\\sin x}\\left(\\cos x\\ln x+\\frac{\\sin x}{x}\\right)", "wrong": [["x^{\\sin x}\\left(\\cos x\\ln x-\\frac{\\sin x}{x}\\right)", "x^(sin(x))*(cos(x)*ln(x)-sin(x)/x)"], ["x^{\\sin x}\\left(\\sin x\\ln x+\\frac{\\sin x}{x}\\right)", "x^(sin(x))*(sin(x)*ln(x)+sin(x)/x)"], ["x^{\\sin x}\\left(\\cos x\\ln x+\\sin x\\right)", "x^(sin(x))*(cos(x)*ln(x)+sin(x))"]]},
  "derivative-log#1": {"right": "x^{\\sin 2x}\\left(2\\cos 2x\\ln x+\\frac{\\sin 2x}{x}\\right)", "wrong": [["x^{\\sin 2x}\\left(\\cos 2x\\ln x+\\frac{\\sin 2x}{x}\\right)", "x^(sin(2*x))*(cos(2*x)*ln(x)+sin(2*x)/x)"], ["x^{\\sin 2x}\\left(2\\cos 2x\\ln x-\\frac{\\sin 2x}{x}\\right)", "x^(sin(2*x))*(2*cos(2*x)*ln(x)-sin(2*x)/x)"], ["x^{\\sin 2x}\\left(2\\cos 2x\\ln x+\\frac{2\\sin 2x}{x}\\right)", "x^(sin(2*x))*(2*cos(2*x)*ln(x)+2*sin(2*x)/x)"]]},
  "derivative-log#2": {"right": "x^{\\cos x}\\left(-\\sin x\\ln x+\\frac{\\cos x}{x}\\right)", "wrong": [["x^{\\cos x}\\left(\\sin x\\ln x+\\frac{\\cos x}{x}\\right)", "x^(cos(x))*(sin(x)*ln(x)+cos(x)/x)"], ["x^{\\cos x}\\left(-\\sin x\\ln x+\\cos x\\right)", "x^(cos(x))*(-sin(x)*ln(x)+cos(x))"], ["x^{\\cos x}\\left(-\\sin x+\\frac{\\cos x}{x}\\right)", "x^(cos(x))*(-sin(x)+cos(x)/x)"]]},
  "derivative-log#3": {"right": "(1+x)^{\\sin x}\\left(\\cos x\\ln(1+x)+\\frac{\\sin x}{1+x}\\right)", "wrong": [["(1+x)^{\\sin x}\\left(-\\cos x\\ln(1+x)+\\frac{\\sin x}{1+x}\\right)", "(1+x)^(sin(x))*(-cos(x)*ln(1+x)+sin(x)/(1+x))"], ["(1+x)^{\\sin x}\\left(\\cos x\\ln(1+x)+\\sin x\\right)", "(1+x)^(sin(x))*(cos(x)*ln(1+x)+sin(x))"], ["(1+x)^{\\sin x}\\left(\\cos x+\\frac{\\sin x}{1+x}\\right)", "(1+x)^(sin(x))*(cos(x)+sin(x)/(1+x))"]]},
  "indefinite-basic#0": {"right": "\\frac{x^3}{3}-x+\\arctan x+C", "wrong": [["\\frac{x^3}{3}+x+\\arctan x+C", "x^3/3+x+arctan(x) + C"], ["\\frac{x^3}{3}-x-\\arctan x+C", "x^3/3-x-arctan(x) + C"], ["\\frac{x^3}{3}-x+\\frac{1}{2}\\arctan x+C", "x^3/3-x+arctan(x)/2 + C"]]},
  "indefinite-basic#1": {"right": "x^3-3x+4\\arctan x+C", "wrong": [["x^3+3x+4\\arctan x+C", "x^3+3*x+4*arctan(x) + C"], ["x^3-3x-4\\arctan x+C", "x^3-3*x-4*arctan(x) + C"], ["x^3-3x+\\arctan x+C", "x^3-3*x+arctan(x) + C"]]},
  "indefinite-substitution-1#0": {"right": "\\frac{\\sin^3 x}{3}-\\frac{\\sin^5 x}{5}+C", "wrong": [["\\frac{\\sin^3 x}{3}+\\frac{\\sin^5 x}{5}+C", "sin(x)^3/3+sin(x)^5/5 + C"], ["\\frac{\\sin^3 x}{3}-\\frac{\\sin^5 x}{3}+C", "sin(x)^3/3-sin(x)^5/3 + C"], ["\\frac{\\sin^3 x}{2}-\\frac{\\sin^5 x}{4}+C", "sin(x)^3/2-sin(x)^5/4 + C"]]},
  "indefinite-substitution-1#1": {"right": "\\frac{\\sin^5 x}{5}-\\frac{\\sin^7 x}{7}+C", "wrong": [["\\frac{\\sin^5 x}{5}+\\frac{\\sin^7 x}{7}+C", "sin(x)^5/5+sin(x)^7/7 + C"], ["\\frac{\\sin^5 x}{5}-\\frac{\\sin^7 x}{5}+C", "sin(x)^5/5-sin(x)^7/5 + C"], ["\\frac{\\sin^5 x}{4}-\\frac{\\sin^7 x}{6}+C", "sin(x)^5/4-sin(x)^7/6 + C"]]},
  "indefinite-root-sub#0": {"right": "2\\sqrt{x}-2\\ln(1+\\sqrt{x})+C", "wrong": [["\\sqrt{x}-\\ln(1+\\sqrt{x})+C", "sqrt(x)-ln(1+sqrt(x)) + C"], ["2\\sqrt{x}+2\\ln(1+\\sqrt{x})+C", "2*sqrt(x)+2*ln(1+sqrt(x)) + C"], ["2\\sqrt{x}-\\ln(1+\\sqrt{x})+C", "2*sqrt(x)-ln(1+sqrt(x)) + C"]]},
  "indefinite-root-sub#1": {"right": "2\\sqrt{x}-4\\ln(2+\\sqrt{x})+C", "wrong": [["\\sqrt{x}-2\\ln(2+\\sqrt{x})+C", "sqrt(x)-2*ln(2+sqrt(x)) + C"], ["2\\sqrt{x}+4\\ln(2+\\sqrt{x})+C", "2*sqrt(x)+4*ln(2+sqrt(x)) + C"], ["2\\sqrt{x}-2\\ln(2+\\sqrt{x})+C", "2*sqrt(x)-2*ln(2+sqrt(x)) + C"]]},
  "indefinite-trig-sub#0": {"right": "-\\frac{\\sqrt{1+x^2}}{x}+C", "wrong": [["\\frac{\\sqrt{1+x^2}}{x}+C", "sqrt(1+x^2)/x + C"], ["-\\frac{1}{x\\sqrt{1+x^2}}+C", "-1/(x*sqrt(1+x^2)) + C"], ["-\\frac{\\sqrt{1+x^2}}{x^2}+C", "-sqrt(1+x^2)/x^2 + C"]]},
  "indefinite-trig-sub#1": {"right": "-\\frac{\\sqrt{1+4x^2}}{x}+C", "wrong": [["\\frac{\\sqrt{1+4x^2}}{x}+C", "sqrt(1+4*x^2)/x + C"], ["-\\frac{\\sqrt{1+4x^2}}{2x}+C", "-sqrt(1+4*x^2)/(2*x) + C"], ["-\\frac{2\\sqrt{1+4x^2}}{x}+C", "-2*sqrt(1+4*x^2)/x + C"]]},
  "indefinite-trig-sub#2": {"right": "-\\frac{\\sqrt{1+9x^2}}{x}+C", "wrong": [["\\frac{\\sqrt{1+9x^2}}{x}+C", "sqrt(1+9*x^2)/x + C"], ["-\\frac{\\sqrt{1+9x^2}}{3x}+C", "-sqrt(1+9*x^2)/(3*x) + C"], ["-\\frac{3\\sqrt{1+9x^2}}{x}+C", "-3*sqrt(1+9*x^2)/x + C"]]},
  "indefinite-trig-sub#3": {"right": "-\\frac{\\sqrt{1+16x^2}}{x}+C", "wrong": [["\\frac{\\sqrt{1+16x^2}}{x}+C", "sqrt(1+16*x^2)/x + C"], ["-\\frac{\\sqrt{1+16x^2}}{4x}+C", "-sqrt(1+16*x^2)/(4*x) + C"], ["-\\frac{4\\sqrt{1+16x^2}}{x}+C", "-4*sqrt(1+16*x^2)/x + C"]]},
  "indefinite-parts#0": {"right": "\\frac{x^2+1}{2}\\arctan x-\\frac{x}{2}+C", "wrong": [["\\frac{x^2-1}{2}\\arctan x+\\frac{x}{2}+C", "(x^2-1)/2*arctan(x)+x/2 + C"], ["\\frac{x^2-1}{2}\\arctan x-\\frac{x}{2}+C", "(x^2-1)/2*arctan(x)-x/2 + C"], ["\\frac{x^2+1}{2}\\arctan x-x+C", "(x^2+1)/2*arctan(x)-x + C"]]},
  "indefinite-parts#1": {"right": "(4x^2+1)\\arctan(2x)-2x+C", "wrong": [["(4x^2-1)\\arctan(2x)+2x+C", "(4*x^2-1)*arctan(2*x)+2*x + C"], ["(4x^2-1)\\arctan(2x)-2x+C", "(4*x^2-1)*arctan(2*x)-2*x + C"], ["(4x^2+2)\\arctan(2x)-2x+C", "(4*x^2+2)*arctan(2*x)-2*x + C"]]},
  "indefinite-parts#2": {"right": "(x^2+1)\\arctan x-x+C", "wrong": [["(x^2-1)\\arctan x+x+C", "(x^2-1)*arctan(x)+x + C"], ["(x^2-1)\\arctan x-x+C", "(x^2-1)*arctan(x)-x + C"], ["(x^2+1)\\arctan x-2x+C", "(x^2+1)*arctan(x)-2*x + C"]]},
  "indefinite-parts#3": {"right": "(9x^2+1)\\arctan(3x)-3x+C", "wrong": [["(9x^2-1)\\arctan(3x)+3x+C", "(9*x^2-1)*arctan(3*x)+3*x + C"], ["(9x^2-1)\\arctan(3x)-3x+C", "(9*x^2-1)*arctan(3*x)-3*x + C"], ["(9x^2+3)\\arctan(3x)-3x+C", "(9*x^2+3)*arctan(3*x)-3*x + C"]]},
  "indefinite-rational#0": {"right": "\\frac{1}{2}\\ln|x-1|+\\frac{1}{2}\\ln|x+1|+\\frac{1}{x+1}+C", "wrong": [["\\frac{1}{2}\\ln|x-1|+\\frac{1}{2}\\ln|x+1|-\\frac{1}{x+1}+C", "(1/2)*ln|x-1|+(1/2)*ln|x+1|-1/(x+1) + C"], ["\\frac{1}{2}\\ln|x-1|-\\frac{1}{2}\\ln|x+1|+\\frac{1}{x+1}+C", "(1/2)*ln|x-1|-(1/2)*ln|x+1|+1/(x+1) + C"], ["\\frac{1}{2}\\ln|x-1|+\\frac{1}{2}\\ln|x+1|+\\frac{1}{2(x+1)}+C", "(1/2)*ln|x-1|+(1/2)*ln|x+1|+1/(2*(x+1)) + C"]]},
  "indefinite-rational#1": {"right": "\\ln|x-1|+\\ln|x+1|+\\frac{1}{x+1}+C", "wrong": [["\\ln|x-1|+\\ln|x+1|-\\frac{1}{x+1}+C", "ln|x-1|+ln|x+1|-1/(x+1) + C"], ["\\ln|x-1|-\\ln|x+1|+\\frac{1}{x+1}+C", "ln|x-1|-ln|x+1|+1/(x+1) + C"], ["\\ln|x-1|+\\ln|x+1|+\\frac{2}{x+1}+C", "ln|x-1|+ln|x+1|+2/(x+1) + C"]]},
  "indefinite-rational#2": {"right": "2\\ln|x-1|+\\ln|x+1|+\\frac{1}{x+1}+C", "wrong": [["2\\ln|x-1|+\\ln|x+1|-\\frac{1}{x+1}+C", "2*ln|x-1|+ln|x+1|-1/(x+1) + C"], ["\\ln|x-1|+2\\ln|x+1|+\\frac{1}{x+1}+C", "ln|x-1|+2*ln|x+1|+1/(x+1) + C"], ["2\\ln|x-1|+\\ln|x+1|+\\frac{1}{2(x+1)^2}+C", "2*ln|x-1|+ln|x+1|+1/(2*(x+1)^2) + C"]]},
  "indefinite-rational#3": {"right": "\\ln|x-1|+2\\ln|x+1|-\\frac{1}{x+1}+C", "wrong": [["\\ln|x-1|+2\\ln|x+1|+\\frac{1}{x+1}+C", "ln|x-1|+2*ln|x+1|+1/(x+1) + C"], ["2\\ln|x-1|+\\ln|x+1|-\\frac{1}{x+1}+C", "2*ln|x-1|+ln|x+1|-1/(x+1) + C"], ["\\ln|x-1|+2\\ln|x+1|-\\frac{1}{2(x+1)^2}+C", "ln|x-1|+2*ln|x+1|-1/(2*(x+1)^2) + C"]]},
  "indefinite-trig-rational#0": {"right": "\\ln|1+\\tan\\frac{x}{2}|+C", "wrong": [["2\\ln|1+\\tan\\frac{x}{2}|+C", "2*ln|1+tan(x/2)| + C"], ["\\frac{1}{2}\\ln|1+\\tan\\frac{x}{2}|+C", "1/2*ln|1+tan(x/2)| + C"], ["\\ln|1+\\tan x|+C", "ln|1+tan(x)| + C"]]},
  "indefinite-trig-rational#1": {"right": "\\ln|2+\\tan\\frac{x}{2}|+C", "wrong": [["2\\ln|2+\\tan\\frac{x}{2}|+C", "2*ln|2+tan(x/2)| + C"], ["\\frac{1}{2}\\ln|2+\\tan\\frac{x}{2}|+C", "1/2*ln|2+tan(x/2)| + C"], ["\\ln|2+\\tan x|+C", "ln|2+tan(x)| + C"]]},
  "definite-concept#0": {"right": "\\frac{\\pi}{2}", "wrong": [["\\frac{\\pi}{4}", "pi/4"], ["\\pi", "pi"], ["2\\pi", "2*pi"]]},
  "definite-concept#1": {"right": "2\\pi", "wrong": [["\\pi", "pi"], ["4\\pi", "4*pi"], ["8\\pi", "8*pi"]]},
  "definite-riemann-sum#0": {"right": "\\ln 2", "wrong": [["\\frac{1}{2}", "1/2"], ["1", "1"], ["\\frac{\\ln 2}{2}", "ln(2)/2"]]},
  "definite-riemann-sum#1": {"right": "\\ln 3", "wrong": [["\\frac{2}{3}", "2/3"], ["\\ln 2", "ln(2)"], ["2\\ln 3", "2*ln(3)"]]},
  "definite-ftc-derivative#0": {"right": "\\frac{3x^2}{\\sqrt{1+x^{12}}}-\\frac{2x}{\\sqrt{1+x^8}}", "wrong": [["\\frac{3x^2}{\\sqrt{1+x^{12}}}+\\frac{2x}{\\sqrt{1+x^8}}", "3*x^2/sqrt(1+x^12)+2*x/sqrt(1+x^8)"], ["\\frac{1}{\\sqrt{1+x^{12}}}-\\frac{1}{\\sqrt{1+x^8}}", "1/sqrt(1+x^12)-1/sqrt(1+x^8)"], ["\\frac{3x^2}{\\sqrt{1+x^7}}-\\frac{2x}{\\sqrt{1+x^6}}", "3*x^2/sqrt(1+x^7)-2*x/sqrt(1+x^6)"]]},
  "definite-ftc-derivative#1": {"right": "\\frac{2x}{\\sqrt{1+x^8}}-\\frac{2}{\\sqrt{1+16x^4}}", "wrong": [["\\frac{2x}{\\sqrt{1+x^8}}+\\frac{2}{\\sqrt{1+16x^4}}", "2*x/sqrt(1+x^8)+2/sqrt(1+16*x^4)"], ["\\frac{2x}{\\sqrt{1+x^8}}-\\frac{1}{\\sqrt{1+16x^4}}", "2*x/sqrt(1+x^8)-1/sqrt(1+16*x^4)"], ["\\frac{2x}{\\sqrt{1+x^8}}-\\frac{2}{\\sqrt{1+2x^4}}", "2*x/sqrt(1+x^8)-2/sqrt(1+2*x^4)"]]},
  "definite-substitution#0": {"right": "2-\\frac{\\pi}{2}", "wrong": [["1-\\frac{\\pi}{4}", "1-pi/4"], ["2-\\frac{\\pi}{4}", "2-pi/4"], ["2-\\frac{\\pi}{3}", "2-pi/3"]]},
  "definite-substitution#1": {"right": "2\\sqrt{3}-\\frac{2\\pi}{3}", "wrong": [["\\sqrt{3}-\\frac{\\pi}{3}", "sqrt(3)-pi/3"], ["2\\sqrt{3}-\\frac{\\pi}{3}", "2*sqrt(3)-pi/3"], ["2\\sqrt{3}-\\frac{\\pi}{2}", "2*sqrt(3)-pi/2"]]},
  "definite-substitution#2": {"right": "4-\\pi", "wrong": [["2-\\frac{\\pi}{2}", "2-pi/2"], ["4-\\frac{\\pi}{2}", "4-pi/2"], ["4-\\frac{2\\pi}{3}", "4-2*pi/3"]]},
  "definite-substitution#3": {"right": "6-\\frac{3\\pi}{2}", "wrong": [["2-\\frac{\\pi}{2}", "2-pi/2"], ["6-\\frac{3\\pi}{4}", "6-3*pi/4"], ["3-\\frac{3\\pi}{4}", "3-3*pi/4"]]},
  "definite-symmetry#0": {"right": "2\\pi", "wrong": [["\\pi", "pi"], ["4\\pi", "4*pi"], ["8\\pi", "8*pi"]]},
  "definite-symmetry#1": {"right": "8\\pi", "wrong": [["4\\pi", "4*pi"], ["16\\pi", "16*pi"], ["32\\pi", "32*pi"]]},
  "definite-parts#0": {"right": "e-2", "wrong": [["e-1", "e-1"], ["e+2", "e+2"], ["e", "e"]]},
  "definite-parts#1": {"right": "2e^2-2", "wrong": [["2e^2", "2*e^2"], ["2e^2+2", "2*e^2+2"], ["3e^2-1", "3*e^2-1"]]},
  "definite-parts#2": {"right": "5e^{3}-2", "wrong": [["5e^{3}+2", "5*e^3+2"], ["7e^{3}-1", "7*e^3-1"], ["13e^{3}+2", "13*e^3+2"]]},
  "definite-parts#3": {"right": "10e^{4}-2", "wrong": [["10e^{4}+2", "10*e^4+2"], ["13e^{4}-1", "13*e^4-1"], ["22e^{4}+2", "22*e^4+2"]]},
  "definite-reflection#0": {"right": "\\frac{\\pi^{2}}{4}", "wrong": [["\\frac{\\pi^{2}}{2}", "pi^2/2"], ["\\frac{\\pi^{2}}{8}", "pi^2/8"], ["-\\frac{\\pi^{2}}{4}", "-pi^2/4"]]},
  "definite-reflection#1": {"right": "-\\frac{3\\pi^{2}}{4}", "wrong": [["\\frac{3\\pi^{2}}{4}", "3*pi^2/4"], ["-\\frac{\\pi^{2}}{4}", "-pi^2/4"], ["-\\frac{3\\pi^{2}}{2}", "-3*pi^2/2"]]},
  "definite-improper-inf#0": {"right": "\\pi", "wrong": [["\\frac{\\pi}{2}", "pi/2"], ["2\\pi", "2*pi"], ["\\frac{\\pi}{\\sqrt{2}}", "pi/sqrt(2)"]]},
  "definite-improper-inf#1": {"right": "2\\pi", "wrong": [["\\pi", "pi"], ["4\\pi", "4*pi"], ["\\frac{2\\pi}{\\sqrt{5}}", "2*pi/sqrt(5)"]]},
  "definite-improper-inf#2": {"right": "\\frac{\\pi}{2}", "wrong": [["\\pi", "pi"], ["\\frac{\\pi}{4}", "pi/4"], ["\\frac{\\pi}{\\sqrt{13}}", "pi/sqrt(13)"]]},
  "definite-improper-inf#3": {"right": "3\\pi", "wrong": [["\\pi", "pi"], ["\\frac{3\\pi}{2}", "3*pi/2"], ["\\frac{3\\pi}{\\sqrt{17}}", "3*pi/sqrt(17)"]]},
  "definite-area-polar#0": {"right": "\\frac{3\\pi}{2}", "wrong": [["3\\pi", "3*pi"], ["\\pi", "pi"], ["\\frac{3\\pi}{4}", "3*pi/4"]]},
  "definite-area-polar#1": {"right": "6\\pi", "wrong": [["12\\pi", "12*pi"], ["4\\pi", "4*pi"], ["3\\pi", "3*pi"]]},
  "definite-area-polar#2": {"right": "\\frac{27\\pi}{2}", "wrong": [["27\\pi", "27*pi"], ["9\\pi", "9*pi"], ["\\frac{27\\pi}{4}", "27*pi/4"]]},
  "definite-area-polar#3": {"right": "24\\pi", "wrong": [["48\\pi", "48*pi"], ["16\\pi", "16*pi"], ["12\\pi", "12*pi"]]},
  "definite-physics#0": {"right": "313600\\pi", "wrong": [["627200\\pi", "627200*pi"], ["156800\\pi", "156800*pi"], ["78400\\pi", "78400*pi"]], "text": "圆柱形水池深 $4\\ \\mathrm{m}$、底面半径 $2\\ \\mathrm{m}$，盛满水。把水全部抽到池口需做多少功？（水的密度取 $1000\\ \\mathrm{kg/m^3}$，$g$ 取 $9.8\\ \\mathrm{m/s^2}$）功以焦耳（J）为单位。"},
  "definite-physics#1": {"right": "490000\\pi", "wrong": [["980000\\pi", "980000*pi"], ["245000\\pi", "245000*pi"], ["122500\\pi", "122500*pi"]], "text": "圆柱形水池深 $5\\ \\mathrm{m}$、底面半径 $2\\ \\mathrm{m}$，盛满水。把水全部抽到池口需做多少功？（水的密度取 $1000\\ \\mathrm{kg/m^3}$，$g$ 取 $9.8\\ \\mathrm{m/s^2}$）功以焦耳（J）为单位。"},
  "ode-concept#0": {"right": "\\cos 2x+\\sin 2x", "wrong": [["\\cos 2x+2\\sin 2x", "cos(2*x)+2*sin(2*x)"], ["\\cos 2x-\\sin 2x", "cos(2*x)-sin(2*x)"], ["2\\cos 2x+\\frac{1}{2}\\sin 2x", "2*cos(2*x)+sin(2*x)/2"]]},
  "ode-concept#1": {"right": "2\\cos 3x+\\sin 3x", "wrong": [["2\\cos 3x+3\\sin 3x", "2*cos(3*x)+3*sin(3*x)"], ["2\\cos 3x-\\sin 3x", "2*cos(3*x)-sin(3*x)"], ["3\\cos 3x+\\frac{2}{3}\\sin 3x", "3*cos(3*x)+2*sin(3*x)/3"]]},
  "ode-separable#0": {"right": "e^{x}", "wrong": [["e^{x^{2}}", "e^(x^2)"], ["e^{\\frac{1}{x}}", "e^(1/x)"], ["e^{x+1}", "e^(x+1)"]]},
  "ode-separable#1": {"right": "e^{x^{2}}", "wrong": [["e^{x}", "e^x"], ["e^{2x^{2}}", "e^(2*x^2)"], ["e^{\\frac{1}{x^{2}}}", "e^(1/x^2)"]]},
  "ode-homogeneous#0": {"right": "x\\sqrt{2\\ln x+4}", "wrong": [["x\\sqrt{\\ln x+4}", "x*sqrt(ln(x)+4)"], ["x\\sqrt{2\\ln x+2}", "x*sqrt(2*ln(x)+2)"], ["-x\\sqrt{2\\ln x+4}", "-x*sqrt(2*ln(x)+4)"]]},
  "ode-homogeneous#1": {"right": "x\\sqrt{4\\ln x+4}", "wrong": [["x\\sqrt{2\\ln x+4}", "x*sqrt(2*ln(x)+4)"], ["x\\sqrt{4\\ln x+2}", "x*sqrt(4*ln(x)+2)"], ["-x\\sqrt{4\\ln x+4}", "-x*sqrt(4*ln(x)+4)"]]},
  "ode-homogeneous#2": {"right": "x\\sqrt{6\\ln x+1}", "wrong": [["x\\sqrt{3\\ln x+1}", "x*sqrt(3*ln(x)+1)"], ["x\\sqrt{2\\ln x+1}", "x*sqrt(2*ln(x)+1)"], ["-x\\sqrt{6\\ln x+1}", "-x*sqrt(6*ln(x)+1)"]]},
  "ode-homogeneous#3": {"right": "x\\sqrt{2\\ln x+9}", "wrong": [["x\\sqrt{\\ln x+9}", "x*sqrt(ln(x)+9)"], ["x\\sqrt{2\\ln x+3}", "x*sqrt(2*ln(x)+3)"], ["-x\\sqrt{2\\ln x+9}", "-x*sqrt(2*ln(x)+9)"]]},
  "ode-linear#0": {"right": "\\frac{\\pi-1-\\cos x}{x}", "wrong": [["\\frac{\\pi+1+\\cos x}{x}", "(pi+1+cos(x))/x"], ["\\frac{\\pi+1-\\cos x}{x}", "(pi+1-cos(x))/x"], ["\\frac{\\pi-\\cos x}{x}", "(pi-cos(x))/x"]]},
  "ode-linear#1": {"right": "\\frac{2\\pi+1-\\cos x}{x}", "wrong": [["\\frac{2\\pi-1+\\cos x}{x}", "(2*pi-1+cos(x))/x"], ["\\frac{2\\pi-1-\\cos x}{x}", "(2*pi-1-cos(x))/x"], ["\\frac{2\\pi-\\cos x}{x}", "(2*pi-cos(x))/x"]]},
  "ode-linear#2": {"right": "\\frac{\\pi-\\cos x}{x}", "wrong": [["\\frac{\\pi+\\cos x}{x}", "(pi+cos(x))/x"], ["\\frac{2-\\cos x}{x}", "(2-cos(x))/x"], ["\\frac{\\frac{\\pi}{2}-\\cos x}{x}", "(pi/2-cos(x))/x"]]},
  "ode-linear#3": {"right": "\\frac{2\\pi-1-\\cos x}{x}", "wrong": [["\\frac{2\\pi+1+\\cos x}{x}", "(2*pi+1+cos(x))/x"], ["\\frac{2\\pi+1-\\cos x}{x}", "(2*pi+1-cos(x))/x"], ["\\frac{2\\pi-\\cos x}{x}", "(2*pi-cos(x))/x"]]},
  "ode-bernoulli#0": {"right": "\\frac{2x}{x^2+1}", "wrong": [["\\frac{2x}{3-x^2}", "2*x/(3-x^2)"], ["\\frac{2x}{x^2+2}", "2*x/(x^2+2)"], ["\\frac{x^2+1}{2x}", "(x^2+1)/(2*x)"]]},
  "ode-bernoulli#1": {"right": "\\frac{3x^2}{x^3+2}", "wrong": [["\\frac{3x^2}{4-x^3}", "3*x^2/(4-x^3)"], ["\\frac{3x^2}{x^3+3}", "3*x^2/(x^3+3)"], ["\\frac{x^3+2}{3x^2}", "(x^3+2)/(3*x^2)"]]},
  "ode-modeling#0": {"right": "x(2-\\ln x)", "wrong": [["x(2+\\ln x)", "x*(2+ln(x))"], ["x(1-\\ln x)", "x*(1-ln(x))"], ["x(2-2\\ln x)", "x*(2-2*ln(x))"]]},
  "ode-modeling#1": {"right": "x(3-2\\ln x)", "wrong": [["x(3+2\\ln x)", "x*(3+2*ln(x))"], ["x(3-\\ln x)", "x*(3-ln(x))"], ["x(2-2\\ln x)", "x*(2-2*ln(x))"]]},
  "ode-modeling#2": {"right": "x(4-3\\ln x)", "wrong": [["x(4+3\\ln x)", "x*(4+3*ln(x))"], ["x(4-\\ln x)", "x*(4-ln(x))"], ["x(3-3\\ln x)", "x*(3-3*ln(x))"]]},
  "ode-modeling#3": {"right": "x(1-4\\ln x)", "wrong": [["x(1+4\\ln x)", "x*(1+4*ln(x))"], ["x(1-\\ln x)", "x*(1-ln(x))"], ["x(4-4\\ln x)", "x*(4-4*ln(x))"]]},
  "ode-integral-equation#0": {"right": "(x+1)e^{x}", "wrong": [["(1-x)e^{x}", "(1-x)*e^x"], ["xe^{x}", "x*e^x"], ["(x+2)e^{x}", "(x+2)*e^x"]]},
  "ode-integral-equation#1": {"right": "(x+2)e^{x}", "wrong": [["xe^{x}", "x*e^x"], ["(x+1)e^{x}", "(x+1)*e^x"], ["-xe^{x}", "-x*e^x"]]},
  "ode-integral-equation#2": {"right": "xe^{x}", "wrong": [["(x+1)e^{x}", "(x+1)*e^x"], ["(x+2)e^{x}", "(x+2)*e^x"], ["(2-x)e^{x}", "(2-x)*e^x"]]},
  "ode-integral-equation#3": {"right": "(x-1)e^{x}", "wrong": [["(x+1)e^{x}", "(x+1)*e^x"], ["(x+3)e^{x}", "(x+3)*e^x"], ["(3-x)e^{x}", "(3-x)*e^x"]]},
  "ode-reduce-order#0": {"right": "\\sqrt{2x-x^2}", "wrong": [["\\sqrt{x^2-2x+2}", "sqrt(x^2-2*x+2)"], ["-\\sqrt{2x-x^2}", "-sqrt(2*x-x^2)"], ["\\sqrt{4x-2x^2-1}", "sqrt(4*x-2*x^2-1)"]]},
  "ode-reduce-order#1": {"right": "\\sqrt{3+2x-x^2}", "wrong": [["\\sqrt{5-2x+x^2}", "sqrt(5-2*x+x^2)"], ["-\\sqrt{3+2x-x^2}", "-sqrt(3+2*x-x^2)"], ["\\sqrt{4x-2x^2+2}", "sqrt(4*x-2*x^2+2)"]]},
  "ode-reduce-order#2": {"right": "\\sqrt{1-2(x-1)^2}", "wrong": [["\\sqrt{1+2(x-1)^2}", "sqrt(1+2*(x-1)^2)"], ["\\sqrt{1-(x-1)^2}", "sqrt(1-(x-1)^2)"], ["-\\sqrt{1-2(x-1)^2}", "-sqrt(1-2*(x-1)^2)"]]},
  "ode-reduce-order#3": {"right": "\\sqrt{9-(x-1)^2}", "wrong": [["\\sqrt{9+(x-1)^2}", "sqrt(9+(x-1)^2)"], ["\\sqrt{9-3(x-1)^2}", "sqrt(9-3*(x-1)^2)"], ["-\\sqrt{9-(x-1)^2}", "-sqrt(9-(x-1)^2)"]]},
  "ode-structure#0": {"right": "2e^{x}+x-1", "wrong": [["3e^{x}+x-2", "3*e^x+x-2"], ["2e^{x}+x+1", "2*e^x+x+1"], ["2e^{x}-x-1", "2*e^x-x-1"]]},
  "ode-structure#1": {"right": "3e^{x}+2x-1", "wrong": [["5e^{x}+2x-3", "5*e^x+2*x-3"], ["3e^{x}+2x+1", "3*e^x+2*x+1"], ["3e^{x}-2x-1", "3*e^x-2*x-1"]]},
  "ode-const-homog#0": {"right": "e^{2x}\\sin(3x)", "wrong": [["3e^{2x}\\sin(3x)", "3*e^(2*x)*sin(3*x)"], ["e^{-2x}\\sin(3x)", "e^(-2*x)*sin(3*x)"], ["\\frac{3}{2}e^{3x}\\sin(2x)", "3/2*e^(3*x)*sin(2*x)"]]},
  "ode-const-homog#1": {"right": "2e^{3x}\\sin(2x)", "wrong": [["4e^{3x}\\sin(2x)", "4*e^(3*x)*sin(2*x)"], ["2e^{-3x}\\sin(2x)", "2*e^(-3*x)*sin(2*x)"], ["\\frac{4}{3}e^{2x}\\sin(3x)", "4/3*e^(2*x)*sin(3*x)"]]},
  "limit-function#0": {"right": ["\\frac{x}{4-3x}", "\\frac{2x}{1+x}"], "wrong": [[["\\frac{x}{4-x}", "x/(4-x)"], ["\\frac{2x}{1+x}", "2*x/(1+x)"]], [["\\frac{x}{4-3x}", "x/(4-3*x)"], ["\\frac{2x}{1-x}", "2*x/(1-x)"]], [["\\frac{x}{4-3x}", "x/(4-3*x)"], ["\\frac{x}{1+x}", "x/(1+x)"]]], "parts": ["f(f(x))=", "f^{-1}(x)="], "text": "设 $f(x)=\\dfrac{x}{2-x}$。在相应定义域内，求复合函数 $f(f(x))$ 与反函数 $f^{-1}(x)$。"},
  "limit-function#1": {"right": ["\\frac{4x}{9-5x}", "\\frac{3x}{x+2}"], "wrong": [[["\\frac{4x}{9-2x}", "4*x/(9-2*x)"], ["\\frac{3x}{x+2}", "3*x/(x+2)"]], [["\\frac{4x}{9-5x}", "4*x/(9-5*x)"], ["\\frac{3x}{2-x}", "3*x/(2-x)"]], [["\\frac{2x}{9-5x}", "2*x/(9-5*x)"], ["\\frac{3x}{x+2}", "3*x/(x+2)"]]], "parts": ["f(f(x))=", "f^{-1}(x)="], "text": "设 $f(x)=\\dfrac{2x}{3-x}$。在相应定义域内，求复合函数 $f(f(x))$ 与反函数 $f^{-1}(x)$。"},
  "derivative-tangent#0": {"right": ["2x", "\\frac{5-x}{2}"], "wrong": [[["2x", "2*x"], ["\\frac{x+3}{2}", "(x+3)/2"]], [["2x", "2*x"], ["4-2x", "4-2*x"]], [["2x+2", "2*x+2"], ["\\frac{5-x}{2}", "(5-x)/2"]]], "parts": ["T(x)=", "N(x)="], "text": "曲线 $y=x^3-x+2$ 在横坐标为 $1$ 的点处，切线与法线分别写成 $y=T(x)$、$y=N(x)$。选出两个右端表达式。"},
  "derivative-tangent#1": {"right": ["4x-1", "\\frac{13-x}{4}"], "wrong": [[["4x-1", "4*x-1"], ["\\frac{x+11}{4}", "(x+11)/4"]], [["4x-1", "4*x-1"], ["7-4x", "7-4*x"]], [["4x+3", "4*x+3"], ["\\frac{13-x}{4}", "(13-x)/4"]]], "parts": ["T(x)=", "N(x)="], "text": "曲线 $y=x^2+2x$ 在横坐标为 $1$ 的点处，切线与法线分别写成 $y=T(x)$、$y=N(x)$。选出两个右端表达式。"},
  "application-mvt#0": {"right": ["3", "\\sqrt{3}"], "wrong": [[["2", "2"], ["\\sqrt{3}", "sqrt(3)"]], [["3", "3"], ["\\sqrt{\\frac{3}{2}}", "sqrt(3/2)"]], [["3", "3"], ["\\frac{3}{2}", "3/2"]]], "parts": ["\\xi=", "\\eta="]},
  "application-curvature#1": {"right": ["\\frac{2}{5\\sqrt{5}}", "\\frac{5\\sqrt{5}}{2}"], "wrong": [[["\\frac{2}{5}", "2/5"], ["\\frac{5}{2}", "5/2"]], [["\\frac{1}{\\sqrt{2}}", "1/sqrt(2)"], ["\\sqrt{2}", "sqrt(2)"]], [["\\frac{1}{5\\sqrt{5}}", "1/(5*sqrt(5))"], ["5\\sqrt{5}", "5*sqrt(5)"]]], "parts": ["K=", "R="], "text": "求曲线 $y=x^2$ 在点 $(1,1)$ 处的曲率 $K$ 和曲率半径 $R$。"},
  "application-cauchy#0": {"right": ["\\frac{3}{\\ln 2}", "\\sqrt{\\frac{3}{2\\ln 2}}"], "wrong": [[["\\frac{4}{\\ln 2}", "4/ln(2)"], ["\\sqrt{\\frac{2}{\\ln 2}}", "sqrt(2/ln(2))"]], [["\\frac{3}{\\ln 2}", "3/ln(2)"], ["\\sqrt{\\frac{3}{4\\ln 2}}", "sqrt(3/(4*ln(2)))"]], [["\\frac{2}{\\ln 2}", "2/ln(2)"], ["\\frac{1}{\\sqrt{\\ln 2}}", "1/sqrt(ln(2))"]]], "parts": ["r=", "\\xi="], "text": "对 $f(x)=x^2$ 与 $g(x)=\\ln x$，在 $[1,2]$ 上应用柯西中值定理。求端点增量比 $r=\\frac{f(2)-f(1)}{g(2)-g(1)}$，以及满足 $\\frac{f\\prime(\\xi)}{g\\prime(\\xi)}=r$ 的 $\\xi\\in(1,2)$。"},
  "application-cauchy#1": {"right": ["\\frac{8}{\\ln 3}", "\\frac{2}{\\sqrt{\\ln 3}}"], "wrong": [[["\\frac{9}{\\ln 3}", "9/ln(3)"], ["\\frac{3}{\\sqrt{2\\ln 3}}", "3/sqrt(2*ln(3))"]], [["\\frac{8}{\\ln 3}", "8/ln(3)"], ["\\sqrt{\\frac{2}{\\ln 3}}", "sqrt(2/ln(3))"]], [["\\frac{4}{\\ln 3}", "4/ln(3)"], ["\\sqrt{\\frac{2}{\\ln 3}}", "sqrt(2/ln(3))"]]], "parts": ["r=", "\\xi="], "text": "对 $f(x)=x^2$ 与 $g(x)=\\ln x$，在 $[1,3]$ 上应用柯西中值定理。求端点增量比 $r=\\frac{f(3)-f(1)}{g(3)-g(1)}$，以及满足 $\\frac{f\\prime(\\xi)}{g\\prime(\\xi)}=r$ 的 $\\xi\\in(1,3)$。"},
  "application-curvature-center#1": {"right": ["-2", "\\frac{7}{4}", "\\frac{5\\sqrt{5}}{4}"], "wrong": [[["3", "3"], ["\\frac{7}{4}", "7/4"], ["\\frac{5\\sqrt{5}}{4}", "5*sqrt(5)/4"]], [["-2", "-2"], ["-\\frac{3}{4}", "-3/4"], ["\\frac{5\\sqrt{5}}{4}", "5*sqrt(5)/4"]], [["-2", "-2"], ["\\frac{7}{4}", "7/4"], ["\\frac{5\\sqrt{5}}{2}", "5*sqrt(5)/2"]]], "parts": ["a=", "b=", "R="], "text": "求曲线 $y=2x^2$ 在 $(1/2,1/2)$ 处的曲率圆：圆心记为 $(a,b)$，半径记为 $R$。选出 $a,b,R$。"},
  "definite-volume#0": {"right": ["\\frac{8\\pi}{3}", "\\frac{16\\pi}{3}"], "wrong": [[["\\frac{8\\pi}{3}", "8*pi/3"], ["\\frac{8\\pi}{3}", "8*pi/3"]], [["4\\pi", "4*pi"], ["\\frac{16\\pi}{3}", "16*pi/3"]], [["\\frac{16\\pi}{3}", "16*pi/3"], ["\\frac{8\\pi}{3}", "8*pi/3"]]], "parts": ["V_x=", "V_y="]},
  "definite-volume#1": {"right": ["\\frac{\\pi}{5}", "\\frac{\\pi}{2}"], "wrong": [[["\\frac{\\pi}{3}", "pi/3"], ["\\frac{\\pi}{2}", "pi/2"]], [["\\frac{\\pi}{5}", "pi/5"], ["\\frac{\\pi}{4}", "pi/4"]], [["\\frac{\\pi}{5}", "pi/5"], ["\\frac{2\\pi}{3}", "2*pi/3"]]], "parts": ["V_x=", "V_y="]},
  "definite-volume#2": {"right": ["9\\pi", "18\\pi"], "wrong": [[["\\frac{9\\pi}{2}", "9*pi/2"], ["18\\pi", "18*pi"]], [["9\\pi", "9*pi"], ["9\\pi", "9*pi"]], [["27\\pi", "27*pi"], ["18\\pi", "18*pi"]]], "parts": ["V_x=", "V_y="]},
  "definite-volume#3": {"right": ["\\frac{32\\pi}{5}", "8\\pi"], "wrong": [[["\\frac{8\\pi}{3}", "8*pi/3"], ["8\\pi", "8*pi"]], [["\\frac{32\\pi}{5}", "32*pi/5"], ["4\\pi", "4*pi"]], [["\\frac{32\\pi}{5}", "32*pi/5"], ["\\frac{16\\pi}{3}", "16*pi/3"]]], "parts": ["V_x=", "V_y="]},
  "ode-nonhomog-exp#0": {"right": "e^{2x}-(x+1)e^{x}", "wrong": [["e^{2x}+(x-1)e^{x}", "e^(2*x)+(x-1)*e^x"], ["e^{2x}-xe^{x}", "e^(2*x)-x*e^x"], ["e^{2x}-(2x+1)e^{x}", "e^(2*x)-(2*x+1)*e^x"]], "text": "求初值问题 $y\\prime\\prime-3y\\prime+2y=e^x$，$y(0)=0,y\\prime(0)=0$ 的解，选出 $y$ 关于 $x$ 的显式表达式。"},
  "ode-nonhomog-exp#1": {"right": "\\frac{x^{2}e^{2x}}{2}", "wrong": [["x^{2}e^{2x}", "x^2*e^(2*x)"], ["\\frac{xe^{2x}}{2}", "x*e^(2*x)/2"], ["\\frac{x^{2}e^{2x}}{4}", "x^2*e^(2*x)/4"]], "text": "求初值问题 $y\\prime\\prime-4y\\prime+4y=e^{2x}$，$y(0)=0,y\\prime(0)=0$ 的解，选出 $y$ 关于 $x$ 的显式表达式。"},
  "ode-nonhomog-exp#2": {"right": "\\frac{e^{2x}}{3}-\\frac{e^{x}}{2}+\\frac{e^{-x}}{6}", "wrong": [["\\frac{e^{2x}}{3}-\\frac{e^{x}}{6}-\\frac{e^{-x}}{6}", "e^(2*x)/3-e^x/6-e^(-x)/6"], ["\\frac{e^{2x}}{3}-\\frac{e^{x}}{2}-\\frac{e^{-x}}{6}", "e^(2*x)/3-e^x/2-e^(-x)/6"], ["\\frac{e^{2x}}{2}-\\frac{3e^{x}}{4}+\\frac{e^{-x}}{4}", "e^(2*x)/2-3*e^x/4+e^(-x)/4"]]},
  "ode-nonhomog-exp#3": {"right": "\\frac{x^{2}e^{x}}{2}", "wrong": [["x^{2}e^{x}", "x^2*e^x"], ["\\frac{xe^{x}}{2}", "x*e^x/2"], ["-\\frac{x^{2}e^{x}}{2}", "-x^2*e^x/2"]]},
  "ode-nonhomog-trig#0": {"right": "\\frac{\\sin x-x\\cos x}{2}", "wrong": [["\\frac{\\sin x+x\\cos x}{2}", "(sin(x)+x*cos(x))/2"], ["\\sin x-x\\cos x", "sin(x)-x*cos(x)"], ["\\frac{\\sin x-2x\\cos x}{2}", "(sin(x)-2*x*cos(x))/2"]]},
  "ode-nonhomog-trig#1": {"right": "\\frac{x\\sin 2x}{4}", "wrong": [["\\frac{x\\sin 2x}{2}", "x*sin(2*x)/2"], ["-\\frac{x\\sin 2x}{4}", "-x*sin(2*x)/4"], ["\\frac{x\\sin 2x}{8}", "x*sin(2*x)/8"]]},
  "ode-nonhomog-trig#2": {"right": "\\frac{x\\sin x}{2}", "wrong": [["x\\sin x", "x*sin(x)"], ["-\\frac{x\\sin x}{2}", "-x*sin(x)/2"], ["\\frac{x\\cos x}{2}", "x*cos(x)/2"]]},
  "ode-nonhomog-trig#3": {"right": "\\frac{\\sin 3x-3x\\cos 3x}{18}", "wrong": [["\\frac{\\sin 3x-3x\\cos 3x}{6}", "(sin(3*x)-3*x*cos(3*x))/6"], ["\\frac{\\sin 3x+3x\\cos 3x}{18}", "(sin(3*x)+3*x*cos(3*x))/18"], ["\\frac{\\sin 3x-x\\cos 3x}{18}", "(sin(3*x)-x*cos(3*x))/18"]]},
  "ode-variation#0": {"right": "\\cos x\\ln(\\cos x)+x\\sin x", "wrong": [["-\\cos x\\ln(\\cos x)+x\\sin x", "-cos(x)*ln(cos(x))+x*sin(x)"], ["\\cos x\\ln(\\cos x)-x\\sin x", "cos(x)*ln(cos(x))-x*sin(x)"], ["2\\cos x\\ln(\\cos x)+x\\sin x", "2*cos(x)*ln(cos(x))+x*sin(x)"]]},
  "ode-variation#1": {"right": "\\left(\\frac{\\pi}{2}-x\\right)\\cos x+\\sin x\\ln(\\sin x)", "wrong": [["\\left(x-\\frac{\\pi}{2}\\right)\\cos x+\\sin x\\ln(\\sin x)", "(x-pi/2)*cos(x)+sin(x)*ln(sin(x))"], ["\\left(\\frac{\\pi}{2}-x\\right)\\cos x-\\sin x\\ln(\\sin x)", "(pi/2-x)*cos(x)-sin(x)*ln(sin(x))"], ["-x\\cos x+\\sin x\\ln(\\sin x)", "-x*cos(x)+sin(x)*ln(sin(x))"]]},
  "ode-euler#0": {"right": "x^{2}+2x", "wrong": [["2x^{2}+x", "2*x^2+x"], ["-x^{2}+4x", "-x^2+4*x"], ["x^{2}+3x", "x^2+3*x"]]},
  "ode-euler#1": {"right": "2x-\\frac{1}{x}", "wrong": [["x-\\frac{2}{x}", "x-2/x"], ["2x+\\frac{1}{x}", "2*x+1/x"], ["3x-\\frac{2}{x}", "3*x-2/x"]]},
  "ode-system#0": {"right": ["\\frac{e^{2t}+1}{2}", "\\frac{e^{2t}-1}{2}"], "wrong": [[["\\frac{e^{t}+1}{2}", "(e^t+1)/2"], ["\\frac{e^{t}-1}{2}", "(e^t-1)/2"]], [["\\frac{e^{2t}+1}{2}", "(e^(2*t)+1)/2"], ["\\frac{1-e^{2t}}{2}", "(1-e^(2*t))/2"]], [["e^{2t}+1", "e^(2*t)+1"], ["e^{2t}-1", "e^(2*t)-1"]]], "parts": ["u(t)=", "v(t)="], "text": "求常系数系统 $u\\prime(t)=u(t)+v(t)$、$v\\prime(t)=u(t)+v(t)$，满足 $u(0)=1,v(0)=0$ 的解。"},
  "ode-system#1": {"right": ["e^{t}-e^{3t}", "e^{t}+e^{3t}"], "wrong": [[["e^{3t}-e^{t}", "e^(3*t)-e^t"], ["e^{t}+e^{3t}", "e^t+e^(3*t)"]], [["e^{-t}-e^{-3t}", "e^(-t)-e^(-3*t)"], ["e^{-t}+e^{-3t}", "e^(-t)+e^(-3*t)"]], [["\\frac{e^{t}-e^{3t}}{2}", "(e^t-e^(3*t))/2"], ["\\frac{e^{t}+e^{3t}}{2}", "(e^t+e^(3*t))/2"]]], "parts": ["u(t)=", "v(t)="], "text": "求常系数系统 $u\\prime(t)=2u(t)-v(t)$、$v\\prime(t)=-u(t)+2v(t)$，满足 $u(0)=0,v(0)=2$ 的解。"},
};

// Worked solutions for the example problem (the last one) of the points whose
// authored problems had none, so every detail page shows one. Drafted
// by AI and checked by another model and by the program (the last formula is
// the answer); not reviewed by a teacher.
export const EXPLANATIONS: Record<string, string> = {
  "limit-rules#0":
    "分子有理化，得 $\\sqrt{x^2+x}-x=\\frac{x}{\\sqrt{x^2+x}+x}=\\frac{1}{\\sqrt{1+1/x}+1}$。当 $x\\to+\\infty$ 时，分母趋于 $2$。所以答案是 $\\frac12$。",
  "limit-rules#1":
    "分子有理化得 $\\sqrt{x^2+4x}-x=\\frac{4x}{\\sqrt{x^2+4x}+x}=\\frac{4}{\\sqrt{1+4/x}+1}$。当 $x\\to+\\infty$ 时，分母趋于 $2$。所以答案是 $2$。",
  "limit-squeeze#0":
    "记原和为 $S_n$，每项都满足 $\\frac{n}{n^2+n}\\le\\frac{n}{n^2+k}\\le\\frac{n}{n^2+1}$，其中 $1\\le k\\le n$。累加得 $\\frac{n^2}{n^2+n}\\le S_n\\le\\frac{n^2}{n^2+1}$，两端均趋于 $1$，由夹逼准则可得极限。所以答案是 $1$。",
  "limit-squeeze#1":
    "记原和为 $S_n$，每一项都介于 $\\frac{n}{2n^2+n}$ 与 $\\frac{n}{2n^2+1}$ 之间。于是 $\\frac{n^2}{2n^2+n}\\le S_n\\le\\frac{n^2}{2n^2+1}$，两端都趋于 $\\frac12$，由夹逼准则得原极限。所以答案是 $\\frac12$。",
  "limit-important-sin#0":
    "由恒等式 $1-\\cos2x=2\\sin^2x$，原式化为 $\\frac{2\\sin x}{x}$。利用重要极限 $\\lim_{x\\to0}\\frac{\\sin x}{x}=1$ 即可。所以答案是 $2$。",
  "limit-important-sin#1":
    "利用 $1-\\cos6x=2\\sin^23x$，原式化为 $\\frac{2\\sin3x}{x}=6\\frac{\\sin3x}{3x}$。由重要极限 $\\lim_{u\\to0}\\frac{\\sin u}{u}=1$ 可得结果。所以答案是 $6$。",
  "limit-important-e#0":
    "将底数写成 $1+\\frac{2}{x-1}$，并令 $t=\\frac{2}{x-1}$。则 $t\\to0$，且 $x=2/t+1$，原式为 $[(1+t)^{1/t}]^2(1+t)$，由重要极限 $(1+t)^{1/t}\\to e$ 得到结果。所以答案是 $e^2$。",
  "limit-important-e#1":
    "设原幂式为 $Y$，取对数得 $\\ln Y=x\\ln(1+\\frac{4}{x-2})$。由 $\\ln(1+u)\\sim u$，可得 $\\ln Y\\to\\lim_{x\\to\\infty}\\frac{4x}{x-2}=4$，再取指数。所以答案是 $e^4$。",
  "limit-equivalent#0":
    "先因式分解 $\\tan x-\\sin x=\\frac{\\sin x(1-\\cos x)}{\\cos x}$。当 $x\\to0$ 时，$\\sin x\\sim x$、$1-\\cos x\\sim x^2/2$ 且 $\\cos x\\to1$，故分子与 $x^3/2$ 等价。所以答案是 $\\frac12$。",
  "limit-equivalent#1":
    "先因式分解 $\\tan2x-\\sin2x=\\frac{\\sin2x(1-\\cos2x)}{\\cos2x}$。当 $x\\to0$ 时，$\\sin2x\\sim2x$、$1-\\cos2x\\sim2x^2$ 且 $\\cos2x\\to1$，故分子与 $4x^3$ 等价。所以答案是 $4$。",
  "limit-equivalent#2":
    "先因式分解 $\\tan3x-\\sin3x=\\frac{\\sin3x(1-\\cos3x)}{\\cos3x}$。当 $x\\to0$ 时，$\\sin3x\\sim3x$、$1-\\cos3x\\sim9x^2/2$ 且 $\\cos3x\\to1$，故分子与 $27x^3/2$ 等价。所以答案是 $\\frac{27}{2}$。",
  "limit-equivalent#3":
    "先化为 $\\tan4x-\\sin4x=\\frac{\\sin4x(1-\\cos4x)}{\\cos4x}$。当 $x\\to0$ 时，$\\sin4x\\sim4x$、$1-\\cos4x\\sim8x^2$ 且 $\\cos4x\\to1$，故分子差等价于 $32x^3$。所以答案是 $32$。",
  "limit-1-to-inf#0":
    "设 $u=(\\cos x)^{1/x^2}$，取对数得 $\\ln u=\\frac{\\ln(\\cos x)}{x^2}$。由 $\\ln(1+t)\\sim t$ 及 $\\cos x-1\\sim-x^2/2$，得 $\\ln u\\to-1/2$，再利用指数函数的连续性。所以答案是 $e^{-1/2}$。",
  "limit-1-to-inf#1":
    "设 $u=(\\cos2x)^{1/x^2}$，取对数得 $\\ln u=\\frac{\\ln(\\cos2x)}{x^2}$。由 $\\ln(1+t)\\sim t$ 及 $\\cos2x-1\\sim-2x^2$，得 $\\ln u\\to-2$，再利用指数函数的连续性。所以答案是 $e^{-2}$。",
  "limit-1-to-inf#2":
    "设 $u=(\\cos x)^{3/x^2}$，取对数得 $\\ln u=\\frac{3\\ln(\\cos x)}{x^2}$。由 $\\ln(1+t)\\sim t$ 及 $\\cos x-1\\sim-x^2/2$，得 $\\ln u\\to-3/2$，再利用指数函数的连续性。所以答案是 $e^{-3/2}$。",
  "limit-1-to-inf#3":
    "设原幂式为 $Y$，取对数得 $\\ln Y=\\frac{2\\ln(\\cos3x)}{x^2}$。由 $\\ln(\\cos3x)\\sim\\cos3x-1\\sim-\\frac92x^2$，可得 $\\ln Y\\to-9$，再取指数。所以答案是 $e^{-9}$。",
  "limit-continuity#0":
    "当 $x>0$ 时，有理化得 $f(x)=\\frac{1}{\\sqrt{1+x}+1}$，故右极限为 $1/2$。左极限与函数值均为 $a$，连续要求左右极限都等于函数值，即 $a=1/2$。所以答案是 $\\frac12$。",
  "limit-continuity#1":
    "右侧有理化得 $f(x)=\\frac1{\\sqrt{4+x}+2}$，故右极限为 $\\frac14$。左极限与函数值均为 $a$，连续要求它们与右极限相等。所以答案是 $\\frac14$。",
  "derivative-definition#0":
    "在分子中加减 $f(x_0)$，原式变为 $2\\frac{f(x_0+2h)-f(x_0)}{2h}+\\frac{f(x_0-h)-f(x_0)}{-h}$。由导数定义，两个差商均趋于 $f'(x_0)=2$，故原极限为 $2\\cdot2+2=6$。所以答案是 $6$。",
  "derivative-definition#1":
    "将原商拆成 $\\frac{f(x_0+h)-f(x_0)}h+2\\frac{f(x_0-2h)-f(x_0)}{-2h}$。由导数定义，两部分分别趋于 $3$ 和 $2\\cdot3$，相加得 $9$。所以答案是 $9$。",
  "derivative-rules#0":
    "利用乘积求导公式，得 $y'=2x\\arctan x+(x^2+1)\\frac{1}{1+x^2}$。第二项约去公因子后等于 $1$。所以答案是 $2x\\arctan x+1$。",
  "derivative-rules#1":
    "利用乘积求导法则，得 $y'=(3x^2+1)\\arctan x+\\frac{x^3+x}{1+x^2}$。第二项约去 $1+x^2$ 后为 $x$。所以答案是 $(3x^2+1)\\arctan x+x$。",
  "derivative-chain#0":
    "利用复合函数求导法则，得 $y'=\\frac{1+x/\\sqrt{1+x^2}}{x+\\sqrt{1+x^2}}$。将分子通分后，约去公因子 $x+\\sqrt{1+x^2}$。所以答案是 $\\frac{1}{\\sqrt{1+x^2}}$。",
  "derivative-chain#1":
    "利用对数函数求导及链式法则，得 $y'=\\frac{1+x/\\sqrt{4+x^2}}{x+\\sqrt{4+x^2}}$。分子写成 $\\frac{\\sqrt{4+x^2}+x}{\\sqrt{4+x^2}}$，约分即可。所以答案是 $\\frac1{\\sqrt{4+x^2}}$。",
  "derivative-second#0":
    "先求一阶导数 $y'=\\frac{2x}{1+x^2}$。再用商的求导公式，得 $y''=\\frac{2(1+x^2)-4x^2}{(1+x^2)^2}$，整理分子即可。所以答案是 $\\frac{2(1-x^2)}{(1+x^2)^2}$。",
  "derivative-second#1":
    "先求一阶导数 $y'=\\frac{2x}{4+x^2}$。再用商的求导法则，得 $y''=\\frac{2(4+x^2)-4x^2}{(4+x^2)^2}$。所以答案是 $\\frac{2(4-x^2)}{(4+x^2)^2}$。",
  "derivative-higher#0":
    "用莱布尼茨公式，因 $x^2$ 的三阶及以上导数为零，只需保留三项。结合 $(e^{-x})^{(k)}=(-1)^ke^{-x}$，得 $y^{(10)}=e^{-x}[x^2-10(2x)+\\binom{10}{2}2]$。所以答案是 $e^{-x}(x^2-20x+90)$。",
  "derivative-higher#1":
    "用莱布尼茨公式，因 $x^2$ 的三阶及以上导数为零，只需保留三项。结合 $(e^{-x})^{(k)}=(-1)^ke^{-x}$，得 $y^{(8)}=e^{-x}[x^2-8(2x)+\\binom82\\,2]$。所以答案是 $e^{-x}(x^2-16x+56)$。",
  "derivative-higher#2":
    "用莱布尼茨公式，因 $x^2$ 的三阶及以上导数为零，只需保留三项。结合 $(e^{-x})^{(k)}=(-1)^ke^{-x}$，得 $y^{(6)}=e^{-x}[x^2-6(2x)+\\binom62\\,2]$。所以答案是 $e^{-x}(x^2-12x+30)$。",
  "derivative-higher#3":
    "利用莱布尼茨公式，因 $x^2$ 的三阶及更高阶导数为零，只有前三项非零。又 $(e^{-x})^{(k)}=(-1)^ke^{-x}$，故 $y^{(4)}=x^2e^{-x}+4(2x)(-e^{-x})+6\\cdot2e^{-x}$。所以答案是 $e^{-x}(x^2-8x+12)$。",
  "derivative-log#0":
    "因 $x>0$，可取对数得 $\\ln y=\\sin x\\ln x$。两边求导得 $\\frac{y'}y=\\cos x\\ln x+\\frac{\\sin x}{x}$，再乘以 $y=x^{\\sin x}$。所以答案是 $x^{\\sin x}\\left(\\cos x\\ln x+\\frac{\\sin x}{x}\\right)$。",
  "derivative-log#1":
    "因 $x>0$，可取对数得 $\\ln y=\\sin2x\\ln x$。两边求导得 $\\frac{y'}y=2\\cos2x\\ln x+\\frac{\\sin2x}{x}$，再乘以 $y=x^{\\sin2x}$。所以答案是 $x^{\\sin2x}\\left(2\\cos2x\\ln x+\\frac{\\sin2x}{x}\\right)$。",
  "derivative-log#2":
    "因 $x>0$，可取对数得 $\\ln y=\\cos x\\ln x$。两边求导得 $\\frac{y'}y=-\\sin x\\ln x+\\frac{\\cos x}{x}$，再乘以 $y=x^{\\cos x}$。所以答案是 $x^{\\cos x}\\left(-\\sin x\\ln x+\\frac{\\cos x}{x}\\right)$。",
  "derivative-log#3":
    "取对数得 $\\ln y=\\sin x\\ln(1+x)$。两边求导得 $\\frac{y'}y=\\cos x\\ln(1+x)+\\frac{\\sin x}{1+x}$，再乘以原函数。所以答案是 $(1+x)^{\\sin x}\\left(\\cos x\\ln(1+x)+\\frac{\\sin x}{1+x}\\right)$。",
  "derivative-related-rates#0":
    "设底端离墙距离为 $x$、顶端高度为 $y$，由梯长不变得 $x^2+y^2=25$。对时间求导得 $x\\frac{dx}{dt}+y\\frac{dy}{dt}=0$，当 $x=3$ 时 $y=4$，故 $\\frac{dy}{dt}=-3/4$。下滑速度大小取其绝对值，单位为 $\\mathrm{m/s}$。所以答案是 $\\frac34$。",
  "derivative-related-rates#1":
    "设底端离墙距离为 $x$、顶端高度为 $y$，则 $x^2+y^2=100$。对时间求导得 $x\\frac{dx}{dt}+y\\frac{dy}{dt}=0$；当 $x=8$ 时 $y=6$，故 $\\frac{dy}{dt}=-\\frac{8\\cdot3}{6}=-4$，下滑速度大小为 $4$。所以答案是 $4$。",
  "application-lhopital#0":
    "分子、分母均趋于零，用洛必达法则将极限化为 $\\lim_{x\\to0}\\frac{\\tan^2x}{1-\\cos x}$。利用 $\\tan x\\sim x$ 与 $1-\\cos x\\sim x^2/2$，比值趋于 $2$。所以答案是 $2$。",
  "application-lhopital#1":
    "分子、分母均趋于零，用洛必达法则将极限化为 $\\lim_{x\\to0}\\frac{2\\tan^22x}{1-\\cos x}$。利用 $\\tan2x\\sim2x$ 与 $1-\\cos x\\sim x^2/2$，比值趋于 $2\\cdot4/(1/2)=16$。所以答案是 $16$。",
  "application-lhopital#2":
    "分子、分母均趋于零，用洛必达法则将极限化为 $\\lim_{x\\to0}\\frac{3\\tan^23x}{1-\\cos x}$。利用 $\\tan3x\\sim3x$ 与 $1-\\cos x\\sim x^2/2$，比值趋于 $3\\cdot9/(1/2)=54$。所以答案是 $54$。",
  "application-lhopital#3":
    "原式为 $\\frac00$ 型，使用洛必达法则后，极限化为 $\\lim_{x\\to0}\\frac{\\sec^2x-1}{2-2\\cos2x}$。由 $\\sec^2x-1=\\tan^2x$ 和 $2-2\\cos2x=4\\sin^2x$，该商等于 $\\frac1{4\\cos^2x}$，趋于 $\\frac14$。所以答案是 $\\frac14$。",
  "application-lhopital-other#0":
    "先通分为 $\\frac{e^x-1-x}{x(e^x-1)}$，分子、分母均趋于零。连续使用两次洛必达法则，得到极限 $\\lim_{x\\to0}\\frac{e^x}{(2+x)e^x}=1/2$。所以答案是 $\\frac12$。",
  "application-lhopital-other#1":
    "先通分为 $\\frac{e^{2x}-1-2x}{x(e^{2x}-1)}$，分子、分母均趋于零。连续使用两次洛必达法则，得到极限 $\\lim_{x\\to0}\\frac{4e^{2x}}{(4+4x)e^{2x}}=1$。所以答案是 $1$。",
  "application-lhopital-other#2":
    "先通分为 $\\frac{e^{3x}-1-3x}{x(e^{3x}-1)}$，分子、分母均趋于零。连续使用两次洛必达法则，得到极限 $\\lim_{x\\to0}\\frac{9e^{3x}}{(6+9x)e^{3x}}=3/2$。所以答案是 $\\frac32$。",
  "application-lhopital-other#3":
    "通分得原式为 $\\frac{e^{4x}-1-4x}{x(e^{4x}-1)}$。用 $e^{4x}=1+4x+8x^2+o(x^2)$，分子为 $8x^2+o(x^2)$，分母为 $4x^2+o(x^2)$，相除即可。所以答案是 $2$。",
  "application-taylor-limit#0":
    "在零点作泰勒展开：$\\cos x=1-x^2/2+x^4/24+o(x^4)$，$e^{-x^2/2}=1-x^2/2+x^4/8+o(x^4)$。相减得分子为 $-x^4/12+o(x^4)$，再除以 $x^4$ 取极限。所以答案是 $-\\frac1{12}$。",
  "application-taylor-limit#1":
    "在零点作泰勒展开：$\\cos(\\sqrt2x)=1-x^2+x^4/6+o(x^4)$，$e^{-x^2}=1-x^2+x^4/2+o(x^4)$。相减得分子为 $-x^4/3+o(x^4)$，再除以 $x^4$ 取极限。所以答案是 $-\\frac13$。",
  "application-taylor-limit#2":
    "在零点作泰勒展开：$\\cos2x=1-2x^2+2x^4/3+o(x^4)$，$e^{-2x^2}=1-2x^2+2x^4+o(x^4)$。相减得分子为 $-4x^4/3+o(x^4)$，再除以 $x^4$ 取极限。所以答案是 $-\\frac43$。",
  "application-taylor-limit#3":
    "展开得 $\\cos3x=1-\\frac92x^2+\\frac{27}{8}x^4+o(x^4)$，而 $e^{-9x^2/2}=1-\\frac92x^2+\\frac{81}{8}x^4+o(x^4)$。相减后为 $-\\frac{27}{4}x^4+o(x^4)$，再除以 $x^4$ 取极限。所以答案是 $-\\frac{27}{4}$。",
  "application-taylor-remainder#0":
    "由拉格朗日余项，截到 $1/n!$ 后误差为 $R_n=e^\\xi/(n+1)!$，其中 $0<\\xi<1$。当 $n=6$ 时，$R_6<3/7!<10^{-3}$；当 $n=5$ 时，$R_5>1/6!>10^{-3}$。各项均为正，截取更少项时误差更大，故最小取 $6$。所以答案是 $6$。",
  "application-taylor-remainder#1":
    "由拉格朗日余项，误差为 $R_n=\\frac{e^\\xi}{(n+1)!}$，其中 $0<\\xi<1$。取 $n=7$ 时，$R_7<\\frac3{8!}<10^{-4}$；取 $n=6$ 时，$R_6>\\frac1{7!}>10^{-4}$。由于各项均为正，更小的 $n$ 误差更大，因此最小取值为 $7$。所以答案是 $7$。",
  "indefinite-basic#0":
    "先作多项式除法，得 $\\frac{x^4}{1+x^2}=x^2-1+\\frac{1}{1+x^2}$。逐项积分，分别得到 $x^3/3$、$-x$ 与 $\\arctan x$，最后加积分常数。所以答案是 $\\frac{x^3}{3}-x+\\arctan x+C$。",
  "indefinite-basic#1":
    "先作多项式除法，得 $\\frac{3x^4+1}{1+x^2}=3x^2-3+\\frac4{1+x^2}$。逐项积分，并用 $\\int\\frac{dx}{1+x^2}=\\arctan x+C$。所以答案是 $x^3-3x+4\\arctan x+C$。",
  "indefinite-substitution-1#0":
    "将 $\\cos^3x$ 写成 $(1-\\sin^2x)\\cos x$，令 $u=\\sin x$，则 $du=\\cos x\\,dx$。原积分化为 $\\int(u^2-u^4)\\,du=u^3/3-u^5/5+C$，再代回 $u$。所以答案是 $\\frac{\\sin^3x}{3}-\\frac{\\sin^5x}{5}+C$。",
  "indefinite-substitution-1#1":
    "写成 $\\sin^4x(1-\\sin^2x)\\cos x\\,dx$，令 $u=\\sin x$，则 $du=\\cos x\\,dx$。原积分变为 $\\int(u^4-u^6)\\,du=\\frac{u^5}5-\\frac{u^7}7+C$，再代回。所以答案是 $\\frac{\\sin^5x}{5}-\\frac{\\sin^7x}{7}+C$。",
  "indefinite-root-sub#0":
    "令 $t=\\sqrt x$，则 $x=t^2$、$dx=2t\\,dt$。原积分化为 $\\int\\frac{2t}{1+t}\\,dt=2t-2\\ln(1+t)+C$，其中 $1+t>0$，再代回 $t$。所以答案是 $2\\sqrt x-2\\ln(1+\\sqrt x)+C$。",
  "indefinite-root-sub#1":
    "令 $t=\\sqrt{x}$，则 $x=t^2$、$dx=2t\\,dt$。原积分变为 $\\int\\frac{2t}{2+t}\\,dt=\\int(2-\\frac4{2+t})\\,dt=2t-4\\ln(2+t)+C$，再代回。所以答案是 $2\\sqrt{x}-4\\ln(2+\\sqrt{x})+C$。",
  "indefinite-trig-sub#0":
    "令 $x=\\tan t$，取 $-\\pi/2<t<\\pi/2$，则 $\\sqrt{1+x^2}=\\sec t$。原积分化为 $\\int\\frac{\\cos t}{\\sin^2t}\\,dt=-1/\\sin t+C$，由 $\\sin t=x/\\sqrt{1+x^2}$ 代回。所以答案是 $-\\frac{\\sqrt{1+x^2}}{x}+C$。",
  "indefinite-trig-sub#1":
    "令 $2x=\\tan t$，取 $-\\pi/2<t<\\pi/2$，则 $\\sqrt{1+4x^2}=\\sec t$。原积分化为 $2\\int\\frac{\\cos t}{\\sin^2t}\\,dt=-2/\\sin t+C$，由 $\\sin t=2x/\\sqrt{1+4x^2}$ 代回。所以答案是 $-\\frac{\\sqrt{1+4x^2}}{x}+C$。",
  "indefinite-trig-sub#2":
    "令 $3x=\\tan t$，取 $-\\pi/2<t<\\pi/2$，则 $\\sqrt{1+9x^2}=\\sec t$。原积分化为 $3\\int\\frac{\\cos t}{\\sin^2t}\\,dt=-3/\\sin t+C$，由 $\\sin t=3x/\\sqrt{1+9x^2}$ 代回。所以答案是 $-\\frac{\\sqrt{1+9x^2}}{x}+C$。",
  "indefinite-trig-sub#3":
    "令 $4x=\\tan t$，取 $-\\frac\\pi2<t<\\frac\\pi2$，则 $dx=\\frac14\\sec^2t\\,dt$、$\\sqrt{1+16x^2}=\\sec t$。原积分变为 $4\\int\\frac{\\cos t}{\\sin^2t}\\,dt=-\\frac4{\\sin t}+C$。由 $\\sin t=\\frac{4x}{\\sqrt{1+16x^2}}$ 代回即可。所以答案是 $-\\frac{\\sqrt{1+16x^2}}x+C$。",
  "indefinite-parts#0":
    "分部积分取 $u=\\arctan x$、$dv=x\\,dx$，得原积分为 $\\frac{x^2}{2}\\arctan x-\\frac12\\int\\frac{x^2}{1+x^2}\\,dx$。利用 $\\frac{x^2}{1+x^2}=1-\\frac1{1+x^2}$ 积分并合并。所以答案是 $\\frac{x^2+1}{2}\\arctan x-\\frac{x}{2}+C$。",
  "indefinite-parts#1":
    "分部积分取 $u=\\arctan 2x$、$dv=8x\\,dx$，得原积分为 $4x^2\\arctan 2x-\\int\\frac{8x^2}{1+4x^2}\\,dx$。利用 $\\frac{8x^2}{1+4x^2}=2-\\frac2{1+4x^2}$ 积分并合并。所以答案是 $(4x^2+1)\\arctan(2x)-2x+C$。",
  "indefinite-parts#2":
    "分部积分取 $u=\\arctan x$、$dv=2x\\,dx$，得原积分为 $x^2\\arctan x-\\int\\frac{x^2}{1+x^2}\\,dx$。利用 $\\frac{x^2}{1+x^2}=1-\\frac1{1+x^2}$ 积分并合并。所以答案是 $(x^2+1)\\arctan x-x+C$。",
  "indefinite-parts#3":
    "分部积分取 $u=\\arctan3x$、$dv=18x\\,dx$，得原积分为 $9x^2\\arctan3x-\\int\\frac{27x^2}{1+9x^2}\\,dx$。因 $\\frac{27x^2}{1+9x^2}=3-\\frac3{1+9x^2}$，余下积分为 $3x-\\arctan3x$，合并即可。所以答案是 $(9x^2+1)\\arctan(3x)-3x+C$。",
  "indefinite-rational#0":
    "作部分分式分解，得 $\\frac{x^2+1}{(x+1)^2(x-1)}=\\frac1{2(x-1)}+\\frac1{2(x+1)}-\\frac1{(x+1)^2}$。逐项积分，最后一项的原函数为 $\\frac1{x+1}$。所以答案是 $\\frac12\\ln|x-1|+\\frac12\\ln|x+1|+\\frac1{x+1}+C$。",
  "indefinite-rational#1":
    "作部分分式分解，得 $\\frac{2x^2+x+1}{(x+1)^2(x-1)}=\\frac1{x-1}+\\frac1{x+1}-\\frac1{(x+1)^2}$。逐项积分，最后一项的原函数为 $\\frac1{x+1}$。所以答案是 $\\ln|x-1|+\\ln|x+1|+\\frac1{x+1}+C$。",
  "indefinite-rational#2":
    "作部分分式分解，得 $\\frac{3x^2+3x+2}{(x+1)^2(x-1)}=\\frac2{x-1}+\\frac1{x+1}-\\frac1{(x+1)^2}$。逐项积分，最后一项的原函数为 $\\frac1{x+1}$。所以答案是 $2\\ln|x-1|+\\ln|x+1|+\\frac1{x+1}+C$。",
  "indefinite-rational#3":
    "部分分式分解得 $\\frac{3x^2+3x-2}{(x+1)^2(x-1)}=\\frac1{x-1}+\\frac2{x+1}+\\frac1{(x+1)^2}$。逐项积分，最后一项的原函数为 $-\\frac1{x+1}$。所以答案是 $\\ln|x-1|+2\\ln|x+1|-\\frac1{x+1}+C$。",
  "indefinite-trig-rational#0":
    "令 $t=\\tan\\frac{x}{2}$，则 $\\sin x=\\frac{2t}{1+t^2}$、$\\cos x=\\frac{1-t^2}{1+t^2}$、$dx=\\frac{2\\,dt}{1+t^2}$。代入后原积分化为 $\\int\\frac{dt}{1+t}=\\ln|1+t|+C$。所以答案是 $\\ln|1+\\tan(x/2)|+C$。",
  "indefinite-trig-rational#1":
    "令 $t=\\tan\\frac x2$，则 $\\sin x=\\frac{2t}{1+t^2}$、$\\cos x=\\frac{1-t^2}{1+t^2}$、$dx=\\frac{2\\,dt}{1+t^2}$。代入后原积分为 $\\int\\frac{dt}{t+2}=\\ln|t+2|+C$，再代回。所以答案是 $\\ln|2+\\tan(x/2)|+C$。",
  "definite-concept#0":
    "配方得 $2x-x^2=1-(x-1)^2$，故曲线是圆心为 $(1,0)$、半径为 $1$ 的上半圆。所求积分等于该半圆的面积 $\\frac12\\pi\\cdot1^2$。所以答案是 $\\frac{\\pi}{2}$。",
  "definite-concept#1":
    "配方得 $4x-x^2=4-(x-2)^2$，故曲线是圆心为 $(2,0)$、半径为 $2$ 的上半圆。积分等于该半圆面积，即 $\\frac12\\pi\\cdot2^2$。所以答案是 $2\\pi$。",
  "definite-riemann-sum#0":
    "原和式可写为 $\\frac1n\\sum_{k=1}^n\\frac1{1+k/n}$，这是连续函数 $\\frac1{1+x}$ 在 $[0,1]$ 上取右端点的积分和。故极限为 $\\int_0^1\\frac{dx}{1+x}=[\\ln(1+x)]_0^1$。所以答案是 $\\ln 2$。",
  "definite-riemann-sum#1":
    "原和写成 $\\frac1n\\sum_{k=1}^{2n}\\frac1{1+k/n}$，它是函数 $\\frac1t$ 在 $[1,3]$ 上以右端点取值的积分和。故极限为 $\\int_1^3\\frac{dt}t=[\\ln t]_1^3=\\ln3$。所以答案是 $\\ln3$。",
  "definite-ftc-derivative#0":
    "由变限积分求导公式与链式法则，导数等于被积函数在上限处的值乘上限导数，再减去在下限处的值乘下限导数。这里上、下限的导数分别为 $3x^2$、$2x$，且 $(x^3)^4=x^{12}$、$(x^2)^4=x^8$。所以答案是 $\\frac{3x^2}{\\sqrt{1+x^{12}}}-\\frac{2x}{\\sqrt{1+x^8}}$。",
  "definite-ftc-derivative#1":
    "利用变限积分求导公式 $\\frac{d}{dx}\\int_{a(x)}^{b(x)}f(t)\\,dt=f(b(x))b'(x)-f(a(x))a'(x)$。代入上限 $x^2$ 和下限 $2x$，两项分别为 $\\frac{2x}{\\sqrt{1+x^8}}$ 与 $\\frac2{\\sqrt{1+16x^4}}$，相减即可。所以答案是 $\\frac{2x}{\\sqrt{1+x^8}}-\\frac2{\\sqrt{1+16x^4}}$。",
  "definite-ftc-limit#0":
    "原式为 $0/0$ 型，由洛必达法则和变限积分求导公式，极限化为 $\\lim_{x\\to0}\\frac{\\ln(1+x^2)}{1-\\cos x}$。利用 $\\ln(1+x^2)\\sim x^2$、$1-\\cos x\\sim x^2/2$，得比值趋于 $2$。所以答案是 $2$。",
  "definite-ftc-limit#1":
    "原式为 $0/0$ 型，由洛必达法则和变限积分求导公式，极限化为 $\\lim_{x\\to0}\\frac{\\ln(1+2x^2)}{1-\\cos x}$。利用 $\\ln(1+2x^2)\\sim2x^2$、$1-\\cos x\\sim x^2/2$，得比值趋于 $4$。所以答案是 $4$。",
  "definite-ftc-limit#2":
    "原式为 $0/0$ 型，由洛必达法则和变限积分求导公式，极限化为 $\\lim_{x\\to0}\\frac{\\ln(1+3x^2)}{1-\\cos x}$。利用 $\\ln(1+3x^2)\\sim3x^2$、$1-\\cos x\\sim x^2/2$，得比值趋于 $6$。所以答案是 $6$。",
  "definite-ftc-limit#3":
    "原式为 $\\frac00$ 型，利用洛必达法则及变限积分求导，化为 $\\lim_{x\\to0}\\frac{\\ln(1+4x^2)}{1-\\cos x}$。由 $\\ln(1+4x^2)\\sim4x^2$、$1-\\cos x\\sim\\frac12x^2$，两者之比趋于 $8$。所以答案是 $8$。",
  "definite-newton-leibniz#0":
    "因 $x^2-x=x(x-1)$，它在 $[-1,0]$、$[1,2]$ 上非负，在 $[0,1]$ 上非正。故原积分为 $\\int_{-1}^0(x^2-x)\\,dx+\\int_0^1(x-x^2)\\,dx+\\int_1^2(x^2-x)\\,dx=\\frac56+\\frac16+\\frac56$。所以答案是 $\\frac{11}{6}$。",
  "definite-newton-leibniz#1":
    "因 $x^2-x=x(x-1)$，它在 $[-1,0]$、$[1,3]$ 上非负，在 $[0,1]$ 上非正。故原积分为 $\\int_{-1}^0(x^2-x)\\,dx-\\int_0^1(x^2-x)\\,dx+\\int_1^3(x^2-x)\\,dx=\\frac56+\\frac16+\\frac{14}3$。所以答案是 $\\frac{17}3$。",
  "definite-substitution#0":
    "令 $t=\\sqrt{e^x-1}$，则 $dx=\\frac{2t}{1+t^2}\\,dt$，积分限变为 $0$、$1$。原积分化为 $2\\int_0^1(1-\\frac1{1+t^2})\\,dt=2[t-\\arctan t]_0^1$。所以答案是 $2-\\frac{\\pi}{2}$。",
  "definite-substitution#1":
    "令 $t=\\sqrt{e^x-1}$，则 $dx=\\frac{2t}{1+t^2}\\,dt$，积分限变为 $0$、$\\sqrt3$。原积分化为 $2\\int_0^{\\sqrt3}(1-\\frac1{1+t^2})\\,dt=2[t-\\arctan t]_0^{\\sqrt3}$。所以答案是 $2\\sqrt3-\\frac{2\\pi}{3}$。",
  "definite-substitution#2":
    "令 $t=\\sqrt{e^x-1}$，则 $dx=\\frac{2t}{1+t^2}\\,dt$，积分限变为 $0$、$1$。原积分化为 $4\\int_0^1(1-\\frac1{1+t^2})\\,dt=4[t-\\arctan t]_0^1$。所以答案是 $4-\\pi$。",
  "definite-substitution#3":
    "令 $u=\\sqrt{e^x-1}$，则 $e^x=1+u^2$、$dx=\\frac{2u}{1+u^2}\\,du$，积分上下限变为 $0$、$1$。原积分为 $6\\int_0^1\\frac{u^2}{1+u^2}\\,du=6[u-\\arctan u]_0^1$。所以答案是 $6-\\frac{3\\pi}{2}$。",
  "definite-symmetry#0":
    "函数 $x^3\\cos x$ 为奇函数，在对称区间 $[-2,2]$ 上积分为 $0$。曲线 $y=\\sqrt{4-x^2}$ 是半径为 $2$ 的上半圆，其下方的面积为 $\\frac12\\pi\\cdot2^2$。所以答案是 $2\\pi$。",
  "definite-symmetry#1":
    "函数 $x^3\\cos x$ 为奇函数，在对称区间 $[-4,4]$ 上积分为零。剩余积分是半径为 $4$ 的上半圆面积，等于 $\\frac12\\pi\\cdot4^2$。所以答案是 $8\\pi$。",
  "definite-parts#0":
    "两次分部积分得 $\\int(\\ln x)^2\\,dx=x(\\ln x)^2-2\\int\\ln x\\,dx=x[(\\ln x)^2-2\\ln x+2]+C$。将上、下限 $e$、$1$ 代入上述原函数，分别得到 $e$、$2$。所以答案是 $e-2$。",
  "definite-parts#1":
    "两次分部积分得 $\\int(\\ln x)^2\\,dx=x(\\ln x)^2-2\\int\\ln x\\,dx=x[(\\ln x)^2-2\\ln x+2]+C$。将上、下限 $e^2$、$1$ 代入该原函数并相减，得 $e^2(4-4+2)-2$。所以答案是 $2e^2-2$。",
  "definite-parts#2":
    "两次分部积分得 $\\int(\\ln x)^2\\,dx=x(\\ln x)^2-2\\int\\ln x\\,dx=x[(\\ln x)^2-2\\ln x+2]+C$。将上、下限 $e^3$、$1$ 代入该原函数并相减，得 $e^3(9-6+2)-2$。所以答案是 $5e^3-2$。",
  "definite-parts#3":
    "两次分部积分得 $\\int(\\ln x)^2\\,dx=x(\\ln x)^2-2x\\ln x+2x+C$。代入上下限 $e^4$、$1$，得 $e^4(16-8+2)-2$。所以答案是 $10e^4-2$。",
  "definite-reflection#0":
    "记原积分为 $I$，作代换 $x=\\pi-t$，得 $I=\\int_0^\\pi\\frac{(\\pi-t)\\sin t}{1+\\cos^2t}\\,dt$。两式相加得 $2I=\\pi\\int_0^\\pi\\frac{\\sin x}{1+\\cos^2x}\\,dx$，再令 $u=\\cos x$，得 $2I=\\pi\\int_{-1}^1\\frac{du}{1+u^2}=\\frac{\\pi^2}{2}$。所以答案是 $\\frac{\\pi^2}{4}$。",
  "definite-reflection#1":
    "记原积分为 $I$，作代换 $x=3\\pi-t$，由 $\\sin(3\\pi-t)=\\sin t$、$\\cos^2(3\\pi-t)=\\cos^2t$，得 $I=\\int_\\pi^{2\\pi}\\frac{(3\\pi-t)\\sin t}{1+\\cos^2t}\\,dt$。与原式相加得 $2I=3\\pi\\int_\\pi^{2\\pi}\\frac{\\sin x}{1+\\cos^2x}\\,dx$。内层积分为 $[-\\arctan(\\cos x)]_\\pi^{2\\pi}=-\\frac\\pi2$，因此 $I=-\\frac{3\\pi^2}4$。所以答案是 $-\\frac{3\\pi^2}4$。",
  "definite-improper-inf#0":
    "配方得 $x^2+2x+2=(x+1)^2+1$，被积函数的原函数为 $\\arctan(x+1)$。在 $x=-1$ 处分开积分并分别取极限，两部分均收敛且各为 $\\pi/2$。所以答案是 $\\pi$。",
  "definite-improper-inf#1":
    "配方得 $x^2+4x+5=(x+2)^2+1$，被积函数的原函数为 $2\\arctan(x+2)$。在 $x=-2$ 处分开积分并分别取极限，两部分均收敛且各为 $\\pi$。所以答案是 $2\\pi$。",
  "definite-improper-inf#2":
    "配方得 $x^2-6x+13=(x-3)^2+4$，被积函数的原函数为 $\\frac12\\arctan\\frac{x-3}{2}$。在 $x=3$ 处分开积分并分别取极限，两部分均收敛且各为 $\\pi/4$。所以答案是 $\\frac{\\pi}{2}$。",
  "definite-improper-inf#3":
    "配方得 $x^2+8x+17=(x+4)^2+1$，原函数为 $3\\arctan(x+4)$。在 $x=-4$ 处分开两个反常积分，两部分分别为 $\\frac{3\\pi}2$，且均收敛，相加即可。所以答案是 $3\\pi$。",
  "definite-improper-unbounded#0":
    "被积函数在 $x=1$ 处无界，须拆成 $\\int_0^1(1-x)^{-1/2}\\,dx+\\int_1^2(x-1)^{-1/2}\\,dx$。两部分分别用原函数 $-2\\sqrt{1-x}$、$2\\sqrt{x-1}$ 在瑕点处取单侧极限，均收敛且各为 $2$。所以答案是 $4$。",
  "definite-improper-unbounded#1":
    "被积函数在 $x=1$ 处无界，须拆成 $\\int_0^1(1-x)^{-1/2}\\,dx+\\int_1^5(x-1)^{-1/2}\\,dx$。两部分分别用原函数 $-2\\sqrt{1-x}$、$2\\sqrt{x-1}$ 在瑕点处取单侧极限，所得积分分别为 $2$、$4$。所以答案是 $6$。",
  "definite-improper-unbounded#2":
    "被积函数在 $x=4$ 处无界，须拆成 $\\int_0^4(4-x)^{-1/2}\\,dx+\\int_4^8(x-4)^{-1/2}\\,dx$。两部分分别用原函数 $-2\\sqrt{4-x}$、$2\\sqrt{x-4}$ 在瑕点处取单侧极限，均收敛且各为 $4$。所以答案是 $8$。",
  "definite-improper-unbounded#3":
    "在瑕点 $x=4$ 处分开，原积分为 $\\int_0^4(4-x)^{-1/2}\\,dx+\\int_4^{13}(x-4)^{-1/2}\\,dx$。两部分分别通过单侧极限求得 $[-2\\sqrt{4-x}]_0^4=4$ 与 $[2\\sqrt{x-4}]_4^{13}=6$，均收敛。所以答案是 $10$。",
  "definite-area#0":
    "由 $x^2=x+2$ 得交点横坐标为 $-1$、$2$，且区间内直线在抛物线上方。故面积为 $\\int_{-1}^2(x+2-x^2)\\,dx=[\\frac{x^2}{2}+2x-\\frac{x^3}{3}]_{-1}^2=\\frac{10}{3}+\\frac76$。所以答案是 $\\frac92$。",
  "definite-area#1":
    "解 $x^2=2x+8$ 得交点横坐标为 $-2$、$4$，两点之间直线在抛物线上方。面积为 $\\int_{-2}^4(2x+8-x^2)\\,dx=[x^2+8x-\\frac{x^3}3]_{-2}^4=36$。所以答案是 $36$。",
  "definite-area-polar#0":
    "心形线在 $0\\le\\theta\\le2\\pi$ 上恰好描绘一周，由极坐标面积公式，面积为 $\\frac12\\int_0^{2\\pi}(1+\\cos\\theta)^2\\,d\\theta$。利用 $\\cos^2\\theta=\\frac{1+\\cos2\\theta}{2}$，积分中常数项贡献 $3\\pi$，余弦项积分为 $0$。所以答案是 $\\frac{3\\pi}{2}$。",
  "definite-area-polar#1":
    "心形线在 $0\\le\\theta\\le2\\pi$ 上恰好描绘一周，由极坐标面积公式，面积为 $2\\int_0^{2\\pi}(1+\\cos\\theta)^2\\,d\\theta$。利用 $\\cos^2\\theta=\\frac{1+\\cos2\\theta}{2}$，得 $\\int_0^{2\\pi}(1+\\cos\\theta)^2\\,d\\theta=3\\pi$。所以答案是 $6\\pi$。",
  "definite-area-polar#2":
    "心形线在 $0\\le\\theta\\le2\\pi$ 上恰好描绘一周，由极坐标面积公式，面积为 $\\frac92\\int_0^{2\\pi}(1+\\cos\\theta)^2\\,d\\theta$。利用 $\\cos^2\\theta=\\frac{1+\\cos2\\theta}{2}$，得 $\\int_0^{2\\pi}(1+\\cos\\theta)^2\\,d\\theta=3\\pi$。所以答案是 $\\frac{27\\pi}{2}$。",
  "definite-area-polar#3":
    "利用极坐标面积公式，得 $S=\\frac12\\int_0^{2\\pi}16(1+\\cos\\theta)^2\\,d\\theta$。展开后，$\\int_0^{2\\pi}1\\,d\\theta=2\\pi$、$\\int_0^{2\\pi}\\cos\\theta\\,d\\theta=0$、$\\int_0^{2\\pi}\\cos^2\\theta\\,d\\theta=\\pi$，故 $S=8(2\\pi+\\pi)$。所以答案是 $24\\pi$。",
  "definite-arc-length#0":
    "求导得 $y'=\\sqrt{x}$，由弧长公式，弧长为 $\\int_0^3\\sqrt{1+(y')^2}\\,dx=\\int_0^3\\sqrt{1+x}\\,dx$。积分得 $[\\frac23(1+x)^{3/2}]_0^3=\\frac23(8-1)$。所以答案是 $\\frac{14}{3}$。",
  "definite-arc-length#1":
    "求导得 $y'=\\sqrt{x}$，由弧长公式 $L=\\int_0^{15}\\sqrt{1+(y')^2}\\,dx=\\int_0^{15}\\sqrt{1+x}\\,dx$。积分得 $L=[\\frac23(1+x)^{3/2}]_0^{15}=\\frac23(64-1)$。所以答案是 $42$。",
  "definite-physics#0":
    "以距池口的深度为 $h$，厚度为 $dh$ 的水层体积为 $4\\pi\\,dh$，须提升 $h$。由功等于重力乘提升距离，得 $dW=1000\\cdot9.8\\cdot4\\pi h\\,dh$，故总功为 $39200\\pi\\int_0^4h\\,dh=39200\\pi\\cdot8$。所以答案是 $313600\\pi$。",
  "definite-physics#1":
    "以池口为深度零点，深度 $h$ 处厚为 $dh$ 的水层体积为 $4\\pi\\,dh$，需提升的距离为 $h$。故微元功为 $dW=1000\\cdot9.8\\cdot4\\pi h\\,dh$，总功为 $W=39200\\pi\\int_0^5h\\,dh=490000\\pi$。所以答案是 $490000\\pi$。",
  "ode-concept#0":
    "把 $x=0$ 代入通解，由 $y(0)=1$ 得 $C_1=1$。求导得 $y'=-2C_1\\sin2x+2C_2\\cos2x$，再由 $y'(0)=2$ 得 $C_2=1$。所以答案是 $\\cos(2x)+\\sin(2x)$。",
  "ode-concept#1":
    "由 $y(0)=2$ 得 $C_1=2$。求导得 $y'=-3C_1\\sin3x+3C_2\\cos3x$，代入 $y'(0)=3$ 得 $C_2=1$。所以答案是 $2\\cos(3x)+\\sin(3x)$。",
  "ode-separable#0":
    "令 $u=\\ln y$，原方程化为 $xu'=u$，且 $u(1)=1$。在初值附近分离变量得 $\\frac{du}{u}=\\frac{dx}{x}$，积分得 $u=kx$，由初值确定 $k=1$，故 $\\ln y=x$。所以答案是 $e^x$。",
  "ode-separable#1":
    "令 $u=\\ln y$，则 $y'=yu'$，原方程化为 $xu'=2u$。在包含初始点的 $x>0$ 区间上，分离变量积分得 $\\ln|u|=2\\ln x+C$，即 $u=Ax^2$。由 $u(1)=\\ln e=1$ 得 $A=1$，故 $y=e^{x^2}$。所以答案是 $e^{x^2}$。",
  "ode-homogeneous#0":
    "令 $u=y/x$，则 $y'=u+xu'$，原方程化为 $xu'=1/u$。分离变量并积分得 $u^2=2\\ln x+k$，由 $y(1)=2$ 得 $k=4$，取经过初值的正根。解的区间为 $x>e^{-2}$。所以答案是 $x\\sqrt{2\\ln x+4}$。",
  "ode-homogeneous#1":
    "令 $u=y/x$，则 $y'=u+xu'$，原方程化为 $xu'=2/u$。分离变量并积分得 $u^2=4\\ln x+k$，由 $y(1)=2$ 得 $k=4$，取经过初值的正根。解的区间为 $x>e^{-1}$。所以答案是 $2x\\sqrt{\\ln x+1}$。",
  "ode-homogeneous#2":
    "令 $u=y/x$，则 $y'=u+xu'$，原方程化为 $u\\,du=3\\,dx/x$。积分得 $u^2=6\\ln x+C$，由 $u(1)=1$ 得 $C=1$，并取正根。所以答案是 $x\\sqrt{6\\ln x+1}$。",
  "ode-homogeneous#3":
    "令 $u=y/x$，则 $y'=u+xu'$，原方程化为 $xu'=1/u$。分离变量积分得 $u^2=2\\ln x+C$，由 $y(1)=3$ 得 $u(1)=3$、$C=9$。初值要求取正根，故 $y=x\\sqrt{2\\ln x+9}$，解所在区间为 $x>e^{-9/2}$。所以答案是 $x\\sqrt{2\\ln x+9}$。",
  "ode-linear#0":
    "方程两边乘以 $x$，得 $(xy)'=\\sin x$，积分得 $xy=-\\cos x+C$。代入 $y(\\pi)=1$，得 $C=\\pi-1$。所以答案是 $\\frac{\\pi-1-\\cos x}{x}$。",
  "ode-linear#1":
    "方程两边乘以 $x$，得 $(xy)'=\\sin x$，积分得 $xy=-\\cos x+C$。代入 $y(2\\pi)=1$，得 $C=2\\pi+1$。所以答案是 $\\frac{2\\pi+1-\\cos x}{x}$。",
  "ode-linear#2":
    "方程两边乘以 $x$，得 $(xy)'=\\sin x$，积分得 $xy=-\\cos x+C$。代入 $y(\\pi/2)=2$，得 $C=\\pi$。所以答案是 $\\frac{\\pi-\\cos x}{x}$。",
  "ode-linear#3":
    "在包含初始点的 $x>0$ 区间上，两边乘以积分因子 $x$，得 $(xy)'=\\sin x$。积分得 $xy=-\\cos x+C$，代入 $y(\\pi)=2$ 得 $C=2\\pi-1$。所以答案是 $\\frac{2\\pi-1-\\cos x}{x}$。",
  "ode-bernoulli#0":
    "令 $z=1/y$，原方程化为 $z'+z/x=1$。乘以 $x$ 后积分得 $xz=x^2/2+C$，由 $z(1)=1$ 得 $C=1/2$。再由 $y=1/z$ 还原。所以答案是 $\\frac{2x}{x^2+1}$。",
  "ode-bernoulli#1":
    "令 $z=1/y$，将原方程除以 $y^2$，得 $z'+\\frac2xz=1$。乘以积分因子 $x^2$，得 $(x^2z)'=x^2$，积分得 $x^2z=\\frac{x^3}3+C$。由 $z(1)=1$ 得 $C=\\frac23$，再取倒数。所以答案是 $\\frac{3x^2}{x^3+2}$。",
  "ode-modeling#0":
    "切线在纵轴上的截距为 $y-xy'$，故 $y-xy'=x$。于是 $(y/x)'=(xy'-y)/x^2=-1/x$，积分得 $y/x=-\\ln x+C$。由 $y(1)=2$ 得 $C=2$。所以答案是 $x(2-\\ln x)$。",
  "ode-modeling#1":
    "切线在纵轴上的截距为 $y-xy'$，故 $y-xy'=2x$。于是 $(y/x)'=(xy'-y)/x^2=-2/x$，积分得 $y/x=-2\\ln x+C$。由 $y(1)=3$ 得 $C=3$。所以答案是 $x(3-2\\ln x)$。",
  "ode-modeling#2":
    "切线在纵轴上的截距为 $y-xy'$，故 $y-xy'=3x$。于是 $(y/x)'=(xy'-y)/x^2=-3/x$，积分得 $y/x=-3\\ln x+C$。由 $y(1)=4$ 得 $C=4$。所以答案是 $x(4-3\\ln x)$。",
  "ode-modeling#3":
    "切线在纵轴上的截距为 $y-xy'$，故 $y-xy'=4x$。整理得 $(y/x)'=\\frac{xy'-y}{x^2}=-\\frac4x$，积分得 $y/x=-4\\ln x+C$。由 $y(1)=1$ 得 $C=1$。所以答案是 $x(1-4\\ln x)$。",
  "ode-integral-equation#0":
    "由变上限积分求导公式得 $f'=e^x+f$，且原式给出 $f(0)=1$。乘以积分因子 $e^{-x}$，得 $(e^{-x}f)'=1$，故 $f=(x+C)e^x$。代入初值得 $C=1$。所以答案是 $(x+1)e^x$。",
  "ode-integral-equation#1":
    "由变上限积分求导公式得 $f'=e^x+f$，且原式给出 $f(-1)=e^{-1}$。乘以积分因子 $e^{-x}$，得 $(e^{-x}f)'=1$，故 $f=(x+C)e^x$。代入初值得 $C=2$。所以答案是 $(x+2)e^x$。",
  "ode-integral-equation#2":
    "由变上限积分求导公式得 $f'=e^x+f$，且原式给出 $f(1)=e$。乘以积分因子 $e^{-x}$，得 $(e^{-x}f)'=1$，故 $f=(x+C)e^x$。代入初值得 $C=0$。所以答案是 $xe^x$。",
  "ode-integral-equation#3":
    "由连续性及变限积分求导，两边求导得 $f'(x)-f(x)=e^x$，且原式在 $x=2$ 处给出 $f(2)=e^2$。乘以积分因子 $e^{-x}$，得 $(e^{-x}f(x))'=1$，故 $f(x)=(x+C)e^x$。代入初值得 $C=-1$。所以答案是 $(x-1)e^x$。",
  "ode-reduce-order#0":
    "将 $y''=-1/y^3$ 两边乘以 $2y'$ 后积分，并代入初值，得 $(y')^2=1/y^2-1$。于是 $(yy')'=(y')^2+yy''=-1$，结合初值得 $yy'=1-x$。再积分得 $y^2=2x-x^2$，由 $y(1)=1$ 取正根。所以答案是 $\\sqrt{2x-x^2}$。",
  "ode-reduce-order#1":
    "将 $y''=-4/y^3$ 两边乘以 $2y'$ 后积分，并代入初值，得 $(y')^2=4/y^2-1$。于是 $(yy')'=(y')^2+yy''=-1$，结合初值得 $yy'=1-x$。再积分得 $y^2=3+2x-x^2$，由 $y(1)=2$ 取正根。所以答案是 $\\sqrt{3+2x-x^2}$。",
  "ode-reduce-order#2":
    "将 $y''=-2/y^3$ 两边乘以 $2y'$ 后积分，并代入初值，得 $(y')^2=2/y^2-2$。于是 $(yy')'=(y')^2+yy''=-2$，结合初值得 $yy'=2-2x$。再积分得 $y^2=1-2(x-1)^2$，由 $y(1)=1$ 取正根。所以答案是 $\\sqrt{1-2(x-1)^2}$。",
  "ode-reduce-order#3":
    "将 $y''=-9/y^3$ 两边乘以 $2y'$ 后积分，得 $(y')^2=9/y^2+C$，由初值得 $C=-1$。于是 $(yy')'=(y')^2+yy''=-1$，再由 $y'(1)=0$ 得 $yy'=-(x-1)$。积分并用 $y(1)=3$ 得 $y^2=9-(x-1)^2$，取正根，解所在区间为 $-2<x<4$。所以答案是 $\\sqrt{9-(x-1)^2}$。",
  "ode-structure#0":
    "非齐次方程两解之差是对应齐次方程的解，故 $y_2-y_1=e^x$、$y_3-y_2=1$ 是两个线性无关的齐次解。通解为 $y=x+C_1e^x+C_2$，由初值得 $C_1+C_2=1$、$1+C_1=3$，即 $C_1=2,C_2=-1$。所以答案是 $2e^x+x-1$。",
  "ode-structure#1":
    "由非齐次线性方程解的结构，$y_2-y_1=e^x$ 与 $y_3-y_2=1$ 是对应齐次方程的解，且线性无关。故原方程通解为 $y=2x+C_1e^x+C_2$，由 $y'(0)=5$ 得 $C_1=3$，再由 $y(0)=2$ 得 $C_2=-1$。所以答案是 $3e^x+2x-1$。",
  "ode-const-homog#0":
    "特征方程 $r^2-4r+13=0$ 的根为 $2\\pm3i$，故通解为 $y=e^{2x}(C_1\\cos3x+C_2\\sin3x)$。由 $y(0)=0$ 得 $C_1=0$，再由 $y'(0)=3$ 得 $3C_2=3$。所以答案是 $e^{2x}\\sin3x$。",
  "ode-const-homog#1":
    "特征方程 $r^2-6r+13=0$ 的根为 $3\\pm2i$，故通解为 $y=e^{3x}(C_1\\cos2x+C_2\\sin2x)$。由 $y(0)=0$ 得 $C_1=0$，再由 $y'(0)=2C_2=4$ 得 $C_2=2$。所以答案是 $2e^{3x}\\sin(2x)$。",
  "derivative-piecewise#2":
    "可导必连续，在 $x=1$ 处连续要求 $a+b=3$。左右导数相等要求 $a=2\\cdot1+2=4$，再由连续条件得 $b=-1$。所以答案是 $a=4$，$b=-1$。",
  "derivative-piecewise#3":
    "可导必连续，在 $x=2$ 处连续要求 $2a+b=6$。左右导数相等要求 $a=4\\cdot2-1=7$，再由连续条件得 $b=-8$。所以答案是 $a=7$，$b=-8$。",
  "derivative-implicit#2":
    "对方程求导得 $2x+2yy'=0$，代入 $(1,2)$ 得 $y'(1)=-1/2$。再求导得 $2+2(y')^2+2yy''=0$，故 $y''(1)=-(1+1/4)/2=-5/8$。所以答案是 $y'(1)=-\\frac12$，$y''(1)=-\\frac58$。",
  "derivative-implicit#3":
    "对方程求导得 $2x+y+(x+2y)y'=0$，代入 $(2,1)$ 得 $y'(2)=-5/4$。再求导得 $2+2y'+2(y')^2+(x+2y)y''=0$，代入得 $y''(2)=-21/32$。所以答案是 $y'(2)=-\\frac54$，$y''(2)=-\\frac{21}{32}$。",
  "derivative-parametric#2":
    "参数方程求导得 $y'=\\frac{dy/dt}{dx/dt}=\\frac{3t^2}{2t}=\\frac32t$。二阶导数为 $y''=\\frac{dy'/dt}{dx/dt}=\\frac{3}{4t}$，在 $t=1$ 时 $x=1$。所以答案是 $y'(1)=\\frac32$，$y''(1)=\\frac34$。",
  "derivative-parametric#3":
    "参数方程求导得 $y'=\\frac{3t^2-1}{2t+1}$。再按 $y''=\\frac{dy'/dt}{dx/dt}$ 得 $y''=\\frac{6t(2t+1)-2(3t^2-1)}{(2t+1)^3}$，在 $t=1$ 时 $x=2$。所以答案是 $y'(2)=\\frac23$，$y''(2)=\\frac{14}{27}$。",
  "application-taylor-expand#2":
    "利用麦克劳林展开 $e^x=1+x+x^2/2+x^3/6+o(x^3)$、$\\cos x=1-x^2/2+o(x^3)$。相乘并合并同次幂得 $e^x\\cos x=1+x-x^3/3+o(x^3)$，比较系数即可。所以答案是 $a=1$，$b=0$，$c=-\\frac13$。",
  "application-taylor-expand#3":
    "利用展开 $\\sin2x=2x-\\frac43x^3+o(x^3)$、$(1-x)^{-1}=1+x+x^2+o(x^2)$。相乘得 $\\frac{\\sin2x}{1-x}=2x+2x^2+\\frac23x^3+o(x^3)$，比较系数即可。所以答案是 $a=2$，$b=2$，$c=\\frac23$。",
  "application-optimization#2":
    "平行墙的边长为 $32-2x$，面积为 $S(x)=x(32-2x)$，其中 $0<x<16$。由 $S'(x)=32-4x=0$ 得 $x=8$，且 $S''(x)=-4<0$，此时取得最大面积 $128$ 平方米。所以答案是 $x=8$，$S_{\\max}=128$。",
  "application-optimization#3":
    "平行墙的边长为 $60-2x$，面积为 $S(x)=x(60-2x)$，其中 $0<x<30$。由 $S'(x)=60-4x=0$ 得 $x=15$，且 $S''(x)=-4<0$，此时取得最大面积 $450$ 平方米。所以答案是 $x=15$，$S_{\\max}=450$。",
  "application-sketch#2":
    "由 $f'(x)=3(x^2-4)$ 可知，在 $(-2,2)$ 内导数为负，两侧导数为正，故最大严格递减开区间为 $(-2,2)$。又 $f''(x)=6x$ 在 $x=0$ 两侧变号，且 $f(0)=0$，故图形的拐点为 $(0,0)$。",
  "application-sketch#3":
    "由 $f'(x)=3[(x+1)^2-1]=3x(x+2)$ 可知，在 $(-2,0)$ 内导数为负，两侧导数为正，故最大严格递减开区间为 $(-2,0)$。又 $f''(x)=6(x+1)$ 在 $x=-1$ 两侧变号，且 $f(-1)=2$，故图形的拐点为 $(-1,2)$。",
  "application-mvt-proof#2":
    "取辅助函数 $F(x)=x^4f(x)$，则 $F(1)=16=F(2)$，且它在 $[1,2]$ 上连续、在 $(1,2)$ 内可导。由罗尔定理，存在 $\\xi\\in(1,2)$ 使 $F'(\\xi)=\\xi^3[4f(\\xi)+\\xi f'(\\xi)]=0$。因 $\\xi^3\\ne0$，可得 $\\xi f'(\\xi)+4f(\\xi)=0$。",
  "application-mvt-proof#3":
    "取辅助函数 $F(x)=x^2f(x)$，则 $F(1)=16=F(4)$，且它在 $[1,4]$ 上连续、在 $(1,4)$ 内可导。由罗尔定理，存在 $\\xi\\in(1,4)$ 使 $F'(\\xi)=\\xi[2f(\\xi)+\\xi f'(\\xi)]=0$。因 $\\xi\\ne0$，可得 $\\xi f'(\\xi)+2f(\\xi)=0$。",
  "application-inequality#2":
    "取 $F(x)=x-\\arctan x$，则所证不等式等价于 $F(x)>0$，且 $F(0)=0$。当 $x>0$ 时，$F'(x)=1-\\frac{1}{1+x^2}=\\frac{x^2}{1+x^2}>0$，故 $F$ 严格递增。于是 $F(x)>F(0)=0$，即 $\\arctan x<x$。",
  "application-inequality#3":
    "取 $F(x)=x-1+e^{-x}$，则所证不等式等价于 $F(x)>0$，且 $F(0)=0$。当 $x>0$ 时，$F'(x)=1-e^{-x}>0$，故 $F$ 严格递增。于是 $F(x)>F(0)=0$，即 $1-e^{-x}<x$。",
  "definite-volume#2":
    "绕横轴旋转，用圆盘截面积积分得 $V_x=\\pi\\int_0^3x^2\\,dx=9\\pi$。绕纵轴旋转，在高度 $y$ 处的截面为内半径 $y$、外半径 $3$ 的圆环，故 $V_y=\\pi\\int_0^3(9-y^2)\\,dy=18\\pi$。所以答案是 $V_x=9\\pi$，$V_y=18\\pi$。",
  "definite-volume#3":
    "绕横轴旋转，用圆盘截面积积分得 $V_x=\\pi\\int_0^2x^4\\,dx=32\\pi/5$。绕纵轴旋转，在高度 $y$ 处的截面为内半径 $\\sqrt y$、外半径 $2$ 的圆环，故 $V_y=\\pi\\int_0^4(4-y)\\,dy=8\\pi$。所以答案是 $V_x=\\frac{32\\pi}{5}$，$V_y=8\\pi$。",
  "ode-nonhomog-exp#2":
    "对应齐次方程的通解为 $C_1e^x+C_2e^{-x}$，设非齐次特解为 $ae^{2x}$，代入得 $3a=1$。故 $y=C_1e^x+C_2e^{-x}+e^{2x}/3$，初值给出 $C_1+C_2=-1/3$、$C_1-C_2=-2/3$，解得 $C_1=-1/2,C_2=1/6$。所以答案是 $\\frac{e^{2x}}3-\\frac{e^x}2+\\frac{e^{-x}}6$。",
  "ode-nonhomog-exp#3":
    "令 $y=e^xu$，代入方程得 $e^xu''=e^x$，即 $u''=1$。由初值得 $u(0)=u'(0)=0$，两次积分得 $u=x^2/2$。所以答案是 $\\frac{x^2e^x}{2}$。",
  "ode-nonhomog-trig#2":
    "齐次通解为 $C_1\\cos x+C_2\\sin x$，设非齐次特解为 $ax\\sin x$，代入得 $2a\\cos x=\\cos x$，故 $a=1/2$。特解及其导数在零点均为零，结合初值得 $C_1=C_2=0$。所以答案是 $\\frac{x\\sin x}{2}$。",
  "ode-nonhomog-trig#3":
    "齐次通解为 $C_1\\cos3x+C_2\\sin3x$，设非齐次特解为 $ax\\cos3x$，代入得 $-6a\\sin3x=\\sin3x$，故 $a=-1/6$。由初值得 $C_1=0$、$3C_2-1/6=0$，故 $C_2=1/18$。所以答案是 $\\frac{\\sin3x-3x\\cos3x}{18}$。",
};
