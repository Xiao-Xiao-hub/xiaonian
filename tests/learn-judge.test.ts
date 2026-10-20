import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";
import { judge, type Reason } from "../server/src/modules/learn/judge.js";
import { PROBLEMS } from "../server/src/modules/learn/problems.js";
import { isScalarProblem } from "../server/src/modules/learn/answers.js";
import {
  sameFunction,
  sameFunctionWhereDefined,
} from "../server/src/shared/verify.js";
import { LIST, REWRITES, WRONG } from "./learn-judge-cases.js";

const P = (id: string) => {
  const p = PROBLEMS[id]?.[0];
  assert.ok(p, `no problem for ${id}`);
  assert.ok(isScalarProblem(p), `${id} must remain scalar`);
  return p;
};
const verdict = (id: string, input: string) => {
  const r = judge(P(id), input);
  return r.reason ? `${r.verdict}/${r.reason}` : r.verdict;
};
// This fixed content-check set covers the original 50 points / 100 scalar
// questions even after newly opened points add other scalar/structured problems.
const ids = Object.keys(REWRITES);
const ofKind = (k: string) => ids.filter((id) => P(id).kind === k);

describe("learn problems", () => {
  it("has an initial and review problem for each of the 50 single-answer points, keyed by map point id", () => {
    const points = new Set(
      CALC_MAP.chapters.flatMap((c) => c.points.map((p) => p.id)),
    );
    assert.equal(ids.length, 50);
    for (const id of ids) {
      assert.ok(points.has(id), id);
      assert.ok(PROBLEMS[id]!.length >= 2, id);
    }
    assert.deepEqual(
      ["number", "expr", "antiderivative"].map((k) => ofKind(k).length),
      [27, 16, 7],
    );
    for (const id of ofKind("antiderivative"))
      assert.match(P(id).answer, /\+ C$/, id);
  });
  it("compares on the answer's domain only for the two x > 0 solutions", () => {
    assert.deepEqual(
      ids.filter((id) => P(id).onAnswerDomain),
      ["ode-homogeneous", "ode-modeling"],
    );
  });
});

describe("judge: content checks", () => {
  it("judges every canonical answer correct against itself", () => {
    for (const id of ids)
      assert.equal(verdict(id, P(id).answer), "correct", id);
  });
  it("judges the content checks' rewrites correct", () => {
    for (const [id, inputs] of Object.entries(REWRITES))
      for (const input of inputs)
        assert.equal(verdict(id, input), "correct", `${id}: ${input}`);
  });
  it("never judges the content checks' wrong answers correct", () => {
    for (const [id, inputs] of Object.entries(WRONG))
      for (const input of inputs)
        assert.notEqual(
          judge(P(id), input).verdict,
          "correct",
          `${id}: ${input}`,
        );
  });
  it("gives every correct-but-misjudged input of the report its expected verdict", () => {
    assert.equal(LIST.length, 158);
    for (const [id, input, expected] of LIST)
      assert.equal(
        judge(P(id), input).verdict,
        expected === "true" ? "correct" : "unsure",
        `${id}: ${input}`,
      );
  });
});

describe("judge: reasons", () => {
  const cases: [Reason | "incorrect" | "correct", string, string][] = [
    ["unparsed", "limit-rules", "我不会"],
    ["unparsed", "derivative-rules", "???"],
    ["unparsed", "derivative-chain", "1/√(1+||x||^2)"],
    ["missing-c", "indefinite-basic", "x^3/3-x+arctan x"],
    ["decimal", "application-taylor-limit", "-0.083"],
    ["decimal", "ode-separable", "2.71828^x"],
    ["division", "indefinite-trig-sub", "-1/x√(1+x^2)+C"],
    ["ambiguous", "limit-1-to-inf", "e^-1/2"],
    ["ambiguous", "derivative-chain", "1/√1+x²"],
    ["ambiguous", "definite-area", "4\\frac{1}{2}"],
    ["ambiguous", "indefinite-substitution-1", "sin x^3/3 - sin x^5/5 + C"],
    ["ambiguous", "indefinite-trig-rational", "ln|1+tan x/2|+C"],
    ["ambiguous", "indefinite-root-sub", "2\\sqrt{x}-\\ln(1+\\sqrt{x})^2+C"],
    ["ambiguous", "ode-const-homog", "e^2x sin3x"],
    ["ambiguous", "ode-const-homog", "e^2x*sin(3x)"],
    ["abs", "indefinite-trig-rational", "ln(1+tan(x/2))+C"],
    ["abs", "indefinite-trig-rational", "\\ln(1+\\tan\\frac{x}{2})+C"],
    ["abs", "indefinite-rational", "(1/2)ln(x-1)+(1/2)ln(x+1)+1/(x+1)+C"],
    ["abs", "indefinite-rational", "1/2ln(x^2-1)+1/(x+1)+C"],
    ["tex", "derivative-rules", "2x\\arctan x"],
    ["tex", "definite-concept", "3/2\\cdot\\pi"],
    ["variable", "ode-integral-equation", "(t+1)e^t"],
    ["variable", "indefinite-trig-sub", "-\\cot t+C"],
    ["variable", "definite-concept", "\\theta"],
    ["integral", "definite-symmetry", "2\\pi+\\int_{-2}^{2}x^3\\cos x\\,dx"],
    ["integral", "indefinite-basic", "∫x^4/(1+x^2)dx"],
    ["implicit", "ode-reduce-order", "y^2+(x-1)^2=1"],
    ["implicit", "ode-linear", "xy=\\pi-1-\\cos x"],
    ["log", "definite-riemann-sum", "log 2"],
    ["log", "definite-riemann-sum", "\\log 2"],
  ];
  for (const [reason, id, input] of cases)
    it(`${reason}: ${id} ${input}`, () =>
      assert.equal(verdict(id, input), `unsure/${reason}`));
  it("incorrect with a reason: extra-c, constant, divergent", () => {
    for (const [id, input] of [
      ["derivative-rules", "2x\\arctan x+1+C"],
      ["derivative-chain", "\\frac{1}{\\sqrt{1+x^2}}+C"],
      ["ode-separable", "e^x+C"],
    ])
      assert.equal(verdict(id!, input!), "incorrect/extra-c", input);
    for (const [id, input] of [
      ["ode-concept", "C_1\\cos 2x+C_2\\sin 2x"],
      ["ode-separable", "e^{Cx}"],
      ["ode-separable", "ke^x"],
      ["ode-linear", "\\frac{C-\\cos x}{x}"],
      ["ode-integral-equation", "(x+C)e^x"],
      ["ode-const-homog", "e^{2x}(C_1\\cos 3x+C_2\\sin 3x)"],
    ])
      assert.equal(verdict(id!, input!), "incorrect/constant", input);
    for (const [id, input] of [
      ["definite-improper-inf", "发散"],
      ["definite-improper-inf", "\\infty"],
      ["definite-improper-unbounded", "不存在"],
      ["definite-ftc-limit", "+∞"],
    ])
      assert.equal(verdict(id!, input!), "incorrect/divergent", input);
  });
  it("x^2(x+1) is a product, only e^2x is ambiguous", () => {
    assert.equal(verdict("derivative-rules", "3x^2(x+1)"), "incorrect");
  });
  it("lg 2 is a different number, not a bare log", () => {
    assert.equal(verdict("definite-riemann-sum", "lg 2"), "incorrect");
  });
  it("reports how it read the input", () => {
    assert.equal(
      judge(P("definite-riemann-sum"), "ln2").read,
      "\\ln\\left(2\\right)",
    );
    assert.match(
      judge(P("indefinite-parts"), "(x^2+1)/2 arctan x - x/2 + C").read!,
      /^\\frac\{.*\}\{2~\\tan\^\{-1\}/,
    );
    assert.match(
      judge(P("indefinite-basic"), "x^3/3-x+arctan x+C").read!,
      /\+C$/,
    );
    assert.equal(judge(P("limit-rules"), "我不会").read, null);
  });
});

describe("judge: the constant of integration", () => {
  it("is missing-c on every antiderivative problem when absent or a number", () => {
    for (const id of ofKind("antiderivative")) {
      const bare = P(id).answer.replace(/\s*\+\s*C$/, "");
      assert.equal(verdict(id, bare), "unsure/missing-c", id);
      assert.equal(verdict(id, `${bare} + 5`), "unsure/missing-c", id);
      assert.equal(verdict(id, `${bare}-\\frac{1}{2}`), "unsure/missing-c", id);
    }
  });
  it("accepts every way of writing it", () => {
    for (const input of [
      "C+\\frac{x^3}{3}-x+\\arctan x",
      "\\frac{x^3}{3}-x+\\arctan x-C",
      "\\frac{x^3}{3}-x+\\arctan x+\\mathrm{C}",
      "\\frac{x^3}{3}-x+\\text{C}+\\arctan x",
      "\\frac{x^3}{3}-x+\\arctan x+C₁",
      "x^3/3-x+arctan(x)+C+1",
      "x^3/3-x+arctan x+c",
      "x^3/3-x+arctan x+K",
      "x^3/3-x+arctan x+k",
      "x^3/3-x+arctan x+C'",
      "x^3/3-x+arctan x+常数",
      "x^3/3-x+arctan x+C（C为常数）",
      "x^3/3-x+arctan x+C，C为任意常数",
    ])
      assert.equal(verdict("indefinite-basic", input), "correct", input);
    for (const input of [
      "\\ln|1+\\tan\\frac{x}{2}|+\\ln C",
      "\\ln|1+\\tan\\frac{x}{2}|+\\ln|C|",
      "\\ln|C(1+\\tan\\frac{x}{2})|",
      "ln|1+tan(x/2)|+lnC",
      "ln|C+Ctan(x/2)|",
    ])
      assert.equal(
        verdict("indefinite-trig-rational", input),
        "correct",
        input,
      );
  });
  it("does not accept a constant that changes the derivative", () => {
    for (const input of [
      "C x^3/3-x+arctan x",
      "x^3/3-x+C arctan x",
      "x^3/3-x+arctan x + C x",
      "x^{3+C}/3-x+arctan x+C",
      // vanishes at C = 1 and C = 2
      "x^3/3-x+arctan x+(C-1)(C-2)x",
    ])
      assert.notEqual(
        judge(P("indefinite-basic"), input).verdict,
        "correct",
        input,
      );
  });
  it("does not let the missing-c hint hide a wrong answer", () => {
    assert.equal(verdict("indefinite-basic", "x^3/3+x+arctan x"), "incorrect");
  });
  it("reads a constant glued to the variable as the constant, not a variable", () => {
    assert.equal(
      verdict("indefinite-basic", "x^3/3-x+arctan x+Cx"),
      "incorrect",
    );
  });
});

describe("judge: decimals", () => {
  const cases: [string, string, string][] = [
    ["limit-continuity", "a=0.5", "correct"],
    ["derivative-related-rates", "0.75", "correct"],
    ["definite-area", "4.50", "correct"],
    ["limit-squeeze", "1.0", "correct"],
    ["application-taylor-limit", "-0.0833333", "unsure/decimal"],
    ["application-taylor-limit", "-0.0833", "unsure/decimal"],
    ["application-taylor-limit", "-0.083", "unsure/decimal"],
    ["application-taylor-limit", "-0.0833333333333", "unsure/decimal"],
    ["application-taylor-limit", "-0.1", "incorrect"],
    ["application-taylor-limit", "-0.08", "incorrect"],
    ["application-taylor-limit", "-0.08333331389", "incorrect"],
    ["definite-improper-inf", "3.14", "unsure/decimal"],
    ["definite-improper-inf", "3.15", "incorrect"],
    ["definite-concept", "1.5707963267949", "unsure/decimal"],
    ["limit-important-e", "7.389056099", "unsure/decimal"],
    ["limit-1-to-inf", "0.6065306092", "incorrect"],
    ["definite-newton-leibniz", "1.833333", "unsure/decimal"],
    ["definite-arc-length", "4.67", "unsure/decimal"],
    ["limit-rules", "0.4999999", "incorrect"],
    ["derivative-definition", "6.000001", "incorrect"],
    ["definite-physics", "985203.46", "unsure/decimal"],
    ["definite-physics", "9.85\\times10^5", "unsure/decimal"],
    // decimals inside an expression are exact fractions when short
    ["limit-1-to-inf", "e^(-0.5)", "correct"],
    ["definite-area-polar", "1.5π", "correct"],
    ["definite-physics", "3.136×10^5π", "correct"],
    ["ode-structure", "2e^x+x-1.0", "correct"],
    ["ode-bernoulli", "2x/(x^2+1.5)", "unsure/decimal"],
    ["ode-separable", "2.718281828^x", "unsure/decimal"],
    ["ode-linear", "(3.1415926536-1-\\cos x)/x", "unsure/decimal"],
    ["indefinite-basic", "0.333x^3-x+arctan x+C", "unsure/decimal"],
  ];
  for (const [id, input, want] of cases)
    it(`${id} ${input} → ${want}`, () =>
      assert.equal(verdict(id, input), want));
});

describe("judge: named regressions", () => {
  it("keeps the cases the S2 plan names", () => {
    assert.equal(
      verdict("application-taylor-limit", "-0.0833333"),
      "unsure/decimal",
    );
    assert.equal(
      verdict("application-taylor-limit", "-0.0833"),
      "unsure/decimal",
    );
    assert.notEqual(
      judge(P("indefinite-parts"), "(x^2+1)/2 arctan x - x/2 + C").verdict,
      "incorrect",
    );
    assert.equal(verdict("definite-physics", "313600π J"), "correct");
    assert.equal(verdict("definite-riemann-sum", "ln2"), "correct");
    assert.equal(verdict("indefinite-root-sub", "2√x-2ln(1+√x)+C"), "correct");
  });
  it("never lights the a/bx shape, whatever the comparator says (D2)", () => {
    for (const [id, input] of [
      // formerly correct rewrites of the content checks
      ["indefinite-parts", "1/2(x^2+1)arctan x-x/2+C"],
      ["indefinite-basic", "1/3x^3-x+arctan x+C"],
      ["indefinite-basic", "1/3 x^3-x+arctanx+C"],
      ["indefinite-parts", "(x^2+1)/2*arctan(x) - 1/2x + C"],
      ["indefinite-parts", "(x^2+1)/2*arctan(x) - 1/2 x + C"],
      ["definite-concept", "1/2π"],
      ["definite-area-polar", "3/2π"],
      ["definite-area-polar", "3/2 pi"],
      ["definite-reflection", "1/4π^2"],
      ["ode-homogeneous", "1/2x√(8lnx+16)"],
    ])
      assert.equal(verdict(id!, input!), "unsure/division", input);
    // a function name after the number, or an explicit product, is not the shape
    for (const [id, input] of [
      ["indefinite-rational", "1/2ln|x^2-1|+1/(x+1)+C"],
      ["indefinite-rational", "1/2 ln|x-1|+1/2 ln|x+1|+1/(x+1)+C"],
      ["indefinite-parts", "(x^2+1)/2*arctan x - x/2 + C"],
      ["indefinite-parts", "(1/2)(x^2+1)arctan x-x/2+C"],
      ["indefinite-parts", "1/2*(x^2+1)*arctan(x)-x/2+C"],
      ["definite-concept", "π/2"],
    ])
      assert.equal(verdict(id!, input!), "correct", input);
  });
  it("never lights a mixed number, whatever the comparator says", () => {
    for (const [id, input] of [
      ["limit-rules", "1½"],
      ["limit-rules", "1\\frac{1}{2}"],
      ["limit-important-sin", "4½"],
      ["application-lhopital", "4\\frac12"],
      ["derivative-related-rates", "1¾"],
      ["application-taylor-limit", "-1\\frac{1}{12}"],
      ["limit-squeeze", "3⅓"],
      ["definite-area", "4½"],
    ])
      assert.equal(verdict(id!, input!), "unsure/ambiguous", input);
    assert.equal(verdict("limit-1-to-inf", "e^(-½)"), "correct");
    assert.equal(verdict("limit-1-to-inf", "1/e^½"), "correct");
  });
  it("strips the labels and the copied integral before a result", () => {
    for (const [id, input] of [
      ["definite-area", "S=9/2"],
      ["definite-arc-length", "L=14/3"],
      ["definite-concept", "原式=π/2"],
      ["limit-rules", "lim=1/2"],
      ["limit-rules", "答：1/2"],
      ["limit-rules", "极限为1/2"],
      ["indefinite-basic", "F(x)=x^3/3-x+arctanx+C"],
      ["indefinite-basic", "原式=x^3/3-x+arctanx+C"],
      ["indefinite-basic", "∫x^4/(1+x^2)dx=x^3/3-x+arctanx+C"],
      ["derivative-rules", "f'(x)=2xarctanx+1"],
    ])
      assert.equal(verdict(id!, input!), "correct", input);
    assert.equal(verdict("definite-area", "S=7/2"), "incorrect");
  });
  it("reads a number glued to an inverse trig function", () => {
    for (const [id, input] of [
      ["indefinite-parts", "x^2arctan(x)/2+arctan(x)/2-x/2+C"],
      ["derivative-rules", "1+2arctan(x)x"],
      ["derivative-rules", "2xtan^-1x+1"],
    ])
      assert.equal(verdict(id!, input!), "correct", input);
  });
  it("does not read \\left as a domain", () => {
    assert.notEqual(
      verdict(
        "indefinite-basic",
        "\\frac{x^3}{3}-x+\\arctan x+C(\\left|x\\right|)",
      ),
      "correct",
    );
    for (const [id, input] of [
      [
        "indefinite-trig-rational",
        "C+\\ln(\\left|1+\\tan\\frac{x}{2}\\right|)",
      ],
      ["ode-modeling", "2x-x\\ln(\\left|x\\right|)"],
      [
        "indefinite-rational",
        "C+\\frac{1}{x+1}+\\frac12\\ln(\\left|x^2-1\\right|)",
      ],
    ])
      assert.equal(verdict(id!, input!), "correct", input);
  });
  it("judges equivalent forms on the solution's domain, wrong ones stay incorrect", () => {
    for (const input of [
      "x\\sqrt{2\\ln|x|+4}",
      "|x|\\sqrt{2\\ln|x|+4}",
      "x\\sqrt{\\ln x^2+4}",
      "x\\sqrt{\\ln(e^4x^2)}",
    ])
      assert.equal(verdict("ode-homogeneous", input), "correct", input);
    assert.equal(verdict("ode-modeling", "2x-x\\ln|x|"), "correct");
    for (const input of ["-x*sqrt(2*ln(abs(x))+4)", "x*sqrt(2*ln(abs(x))+2)"])
      assert.equal(verdict("ode-homogeneous", input), "incorrect", input);
    assert.equal(verdict("ode-modeling", "x*(2+ln(abs(x)))"), "incorrect");
  });
  it("strips labels, units, punctuation and ranges only where they belong", () => {
    assert.equal(verdict("application-taylor-remainder", "至少6"), "correct");
    assert.equal(verdict("application-taylor-remainder", "n\\geq6"), "correct");
    assert.equal(verdict("derivative-rules", "2x\\tan^{-1}x+1"), "correct");
    assert.equal(verdict("limit-continuity", "a=三分之一"), "incorrect");
    assert.equal(verdict("limit-rules", "≥1/2"), "unsure/unparsed");
    assert.equal(verdict("definite-physics", "313600π m/s"), "unsure/unparsed");
    assert.equal(
      verdict("derivative-related-rates", "0.75 J"),
      "unsure/unparsed",
    );
    assert.equal(verdict("ode-separable", "$y=e^x$。"), "correct");
  });
});

describe("sameFunctionWhereDefined", () => {
  it("skips only the points where the reference is undefined", () => {
    assert.equal(sameFunction("ln(x)", "ln|x|"), false);
    assert.equal(sameFunctionWhereDefined("ln(x)", "ln|x|"), true);
    assert.equal(sameFunctionWhereDefined("ln(x)", "ln|x|+1"), false);
    // the reference is defined at x = 1.31, the answer is not
    assert.equal(sameFunctionWhereDefined("ln(x)", "ln(x-1.5)"), false);
    // fewer than 4 points where the reference is defined: cannot tell
    assert.equal(sameFunctionWhereDefined("sqrt(x-2.5)", "sqrt(x-2.5)"), null);
    assert.equal(sameFunctionWhereDefined("x", "y"), null);
  });
});

describe("judge: prewritten review variants", () => {
  for (const id of ids) {
    const problems = PROBLEMS[id]!;
    if (problems.length < 2) continue;
    it(`${id}: the review answer works and the original answer does not`, () => {
      const [first, review] = problems;
      assert.ok(
        first && review && isScalarProblem(first) && isScalarProblem(review),
      );
      assert.equal(judge(review!, review!.answer).verdict, "correct");
      assert.notEqual(judge(review!, first!.answer).verdict, "correct");
      assert.equal(review!.kind, first!.kind);
      assert.equal(review!.var, first!.var);
      assert.equal(review!.onAnswerDomain, first!.onAnswerDomain);
      assert.notEqual(review!.text, first!.text);
    });
  }
});

describe("judge: speed", () => {
  const timed = (id: string, input: string) => {
    const start = performance.now();
    const r = judge(P(id), input);
    return { r, ms: performance.now() - start };
  };
  it("judges the slowest inputs it accepts in under a second or so", () => {
    // the C in front costs two comparisons, each arctan about 0.1 s; these sit
    // at the complexity budget and took 0.5 to 0.85 s on the dev machine
    for (const input of [
      "C*0+(x^2+1)/2*arctan(x) - x/2+arctan(x)-arctan(x)",
      "C*0+(x^2+1)/2*arctan(x) - x/2+arccos(x/9)+arcsin(x/9)-pi/2",
      "C+(x^2+1)/2*arctan(x)-x/2+sin(x)-sin(x)+sin(x)-sin(x)+sin(x)-sin(x)+sin(x)-sin(x)+sin(x)-sin(x)",
    ]) {
      const { r, ms } = timed("indefinite-parts", input);
      assert.equal(r.verdict, "correct", input);
      // the bound leaves room for parallel test files
      assert.ok(ms < 1500, `${ms} ms: ${input}`);
    }
    assert.equal(judge(P("limit-rules"), "1".repeat(201)).reason, "unparsed");
  });
  it("does not judge deeply nested or very long inputs (they would take minutes)", () => {
    let nested = "x";
    for (let i = 0; i < 30; i++) nested = `sin(${nested})`;
    const many = "+arctan(x)-arctan(x)";
    for (const [id, input] of [
      ["indefinite-parts", `${nested}+C`],
      ["derivative-rules", nested],
      ["limit-rules", `${"sqrt(".repeat(25)}2${")".repeat(25)}`],
      ["indefinite-parts", `C*0+(x^2+1)/2*arctan(x) - x/2${many.repeat(7)}`],
      [
        "indefinite-root-sub",
        `C+2*sqrt(x) - 2*ln(1+sqrt(x))${"+e^(e^(e^x))-e^(e^(e^x))".repeat(4)}`,
      ],
      ["derivative-rules", `${"sin ".repeat(20)}x`],
    ] as const) {
      const { r, ms } = timed(id, input);
      assert.deepEqual(r, {
        verdict: "unsure",
        reason: "unparsed",
        read: null,
      });
      assert.ok(ms < 100, `${ms} ms: ${input}`);
    }
  });
});
