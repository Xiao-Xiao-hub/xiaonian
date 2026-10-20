import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseCheck,
  runCheck,
  sameAntiderivative,
  sameConstant,
  sameFunction,
  toMathjs,
  type Check,
  type CheckResult,
} from "../server/src/shared/verify.js";

const limitTimes: number[] = [];

function lim(
  expr: string,
  at: string,
  answer: string,
  side?: "+" | "-",
): CheckResult {
  const t = performance.now();
  const r = runCheck({
    kind: "limit",
    expr,
    at,
    answer,
    ...(side ? { side } : {}),
  });
  limitTimes.push(performance.now() - t);
  return r;
}

const status = (r: CheckResult) => r.status;
const notPass = (r: CheckResult, label: string) =>
  assert.notEqual(r.status, "pass", `${label}: ${JSON.stringify(r)}`);

describe("limits", () => {
  it("catches the motivating bugs", () => {
    const f = "(e^(3x)-1-3x)/x^2";
    const ok = lim(f, "0", "9/2");
    assert.equal(ok.status, "pass");
    assert.equal(ok.computed, "4.5");
    assert.match(ok.tex, /\\lim_\{x\\to 0\}/);
    const bad = lim(f, "0", "1.5");
    assert.equal(bad.status, "fail");
    assert.match(bad.detail, /4\.5/);

    const g = "(e^x-1-5x)/x^2";
    assert.equal(status(lim(g, "0", "12.5")), "fail");
    assert.equal(status(lim(g, "0", "∞")), "pass");
    assert.equal(status(lim(g, "0", "+∞")), "fail");
    assert.equal(status(lim(g, "0", "不存在")), "pass");
    assert.equal(lim(g, "0", "∞").computed, "左 +∞，右 −∞");
  });

  it("high-order cancellation converges", () => {
    assert.equal(status(lim("(cos(x)-1+x^2/2)/x^4", "0", "1/24")), "pass");
    assert.equal(status(lim("(sin(x)-x+x^3/6)/x^5", "0", "1/120")), "pass");
    assert.equal(status(lim("(cos(x)-1+x^2/2)/x^4", "0", "0")), "fail");
  });

  it("infinity and overflow", () => {
    assert.equal(status(lim("exp(x)/x^5", "+inf", "+∞")), "pass");
    assert.equal(status(lim("exp(x)/x^5", "+inf", "0")), "fail");
    assert.equal(status(lim("1/x^2", "0", "+∞")), "pass");
    assert.equal(status(lim("1/x", "0", "+∞", "+")), "pass");
    assert.equal(status(lim("1/x", "0", "-∞", "-")), "pass");
    assert.equal(status(lim("exp(x)/x^5", "+inf", "inf")), "pass");
    assert.equal(status(lim("exp(x)/x^5", "-inf", "0")), "pass");
    // Unsigned ∞ means |x|→∞: the two directions differ, so neither ∞ nor a number is right.
    assert.equal(status(lim("exp(x)/x^5", "inf", "+∞")), "fail");
    assert.equal(status(lim("exp(x)/x^5", "inf", "inf")), "fail");
    assert.equal(status(lim("exp(x)/x^5", "inf", "不存在")), "pass");
    assert.equal(status(lim("atan(x)", "inf", "pi/2")), "fail");
    assert.equal(status(lim("atan(x)", "+inf", "pi/2")), "pass");
  });

  it("removable, one-sided and jump limits", () => {
    assert.equal(status(lim("(x^2-4)/(x-2)", "2", "4")), "pass");
    assert.equal(status(lim("abs(x)/x", "0", "1", "+")), "pass");
    assert.equal(status(lim("abs(x)/x", "0", "-1", "-")), "pass");
    notPass(lim("abs(x)/x", "0", "1"), "abs(x)/x two-sided");
    assert.equal(status(lim("abs(x)/x", "0", "不存在")), "pass");
    assert.equal(status(lim("sin(x)/(x-pi)", "pi", "-1")), "pass");
  });

  it("textbook limits", () => {
    assert.equal(status(lim("(1+1/x)^x", "inf", "e")), "pass");
    assert.equal(status(lim("(1+1/x)^x", "inf", "2.7")), "fail");
    assert.equal(status(lim("x^x", "0", "1", "+")), "pass");
    assert.equal(status(lim("(1+2x)^(1/x)", "0", "e^2")), "pass");
    assert.equal(status(lim("(2^x-3^x)/x", "0", "ln(2/3)")), "pass");
    assert.equal(status(lim("(arcsin(x)-x)/x^3", "0", "1/6")), "pass");
    assert.equal(status(lim("x ln x", "0", "0", "+")), "pass");
    assert.equal(status(lim("(log(1+x)-x)/x^2", "0", "-1/2")), "pass");
    assert.equal(status(lim("(log(1+x)-x)/x^2", "0", "1/2")), "fail");
    assert.equal(status(lim("(ln(1+2x)-2x)/x^2", "0", "-2")), "pass");
    assert.equal(status(lim("ln(1+x)/x", "0", "1")), "pass");
    assert.equal(status(lim("(x-ln(1+x))/x^2", "0", "1/2")), "pass");
    assert.equal(status(lim("sqrt(x^2+x)-x", "+inf", "1/2")), "pass");
    assert.equal(
      status(lim("\\frac{e^{3x}-1-3x}{x^{2}}", "0", "\\frac{9}{2}")),
      "pass",
    );
  });

  it("adversarial: oscillation and slow divergence never pass", () => {
    for (const a of ["-∞", "+∞", "∞", "0", "1"])
      notPass(lim("x*sin(x)", "+inf", a), `x sin x → ${a}`);
    for (const a of ["0", "1", "-1", "1/2", "∞", "+∞"]) {
      notPass(lim("sin(x)", "inf", a), `sin x at ∞ → ${a}`);
      notPass(lim("sin(x)", "+inf", a), `sin x at +∞ → ${a}`);
      notPass(lim("sin(1/x)", "0", a), `sin(1/x) → ${a}`);
      notPass(lim("sin(pi/x)", "0", a), `sin(pi/x) → ${a}`);
      notPass(lim("x^2*sin(x)^2", "+inf", a), `x² sin² x → ${a}`);
    }
    for (const a of ["0", "-∞", "-100"])
      notPass(lim("log(x)", "0", a, "+"), `ln x → ${a}`);
    notPass(lim("1/x", "0", "+∞"), "1/x two-sided +∞");
    notPass(lim("(e^x-1-x)/x^2", "0", "0.5000001"), "near miss");
    notPass(lim("(e^x-1-x)/x^2", "0", "1"), "wrong constant");
    notPass(lim("x*sin(1/x)", "0", "1"), "x sin(1/x)");
    assert.equal(status(lim("x*sin(1/x)", "0", "0")), "pass");
    // Samples can miss the zeros of sin² x, so e^x·sin² x looks like +∞.
    for (const a of ["inf", "+inf", "∞"])
      notPass(lim("exp(x)*sin(x)^2", "+inf", a), `e^x sin² x → ${a}`);
    notPass(lim("x*(1+sin(x))", "+inf", "+inf"), "x(1+sin x)");
    assert.equal(status(lim("sin(x)/x", "+inf", "0")), "pass");
  });

  it("each limit check finishes quickly", () => {
    assert.ok(limitTimes.length > 30);
    const max = Math.max(...limitTimes);
    assert.ok(max < 1500, `slowest limit took ${max.toFixed(0)} ms`);
  });
});

describe("derivatives and antiderivatives", () => {
  it("derivative", () => {
    const d = (answer: string, order?: 1 | 2) =>
      runCheck({
        kind: "derivative",
        expr: "x^2 sin x",
        answer,
        ...(order ? { order } : {}),
      }).status;
    assert.equal(d("2x sin x + x^2 cos x"), "pass");
    assert.equal(d("2x cos x"), "fail");
    assert.equal(d("2 sin x + 4x cos x - x^2 sin x", 2), "pass");
    assert.equal(d("2 sin x + 4x cos x", 2), "fail");
    assert.equal(
      runCheck({ kind: "derivative", expr: "ln|x|", answer: "1/x" }).status,
      "pass",
    );
    assert.equal(
      runCheck({
        kind: "derivative",
        expr: "e^x sin x",
        answer: "e^x(sin x + cos x)",
      }).status,
      "pass",
    );
    assert.equal(
      runCheck({ kind: "derivative", expr: "arctan x", answer: "1/(1+x^2)" })
        .status,
      "pass",
    );
    assert.equal(
      runCheck({
        kind: "derivative",
        expr: "\\sqrt{1-x^2}",
        answer: "-x/\\sqrt{1-x^2}",
      }).status,
      "pass",
    );
    // f' defined on all of R but the answer only for x>0 → mismatch
    assert.equal(
      runCheck({ kind: "derivative", expr: "x^2", answer: "2*sqrt(x)^2/x*x" })
        .status,
      "fail",
    );
  });

  it("antiderivative", () => {
    const a = (expr: string, answer: string) =>
      runCheck({ kind: "antiderivative", expr, answer });
    assert.equal(a("x e^x", "(x-1)e^x + C").status, "pass");
    assert.equal(a("x e^x", "x e^x + C").status, "fail");
    assert.equal(a("1/x", "ln|x| + C").status, "pass");
    const ln = a("1/x", "ln(x) + C");
    assert.equal(ln.status, "fail");
    assert.match(ln.detail, /定义/);
    assert.equal(a("1/(1+x^2)", "arctan x + C").status, "pass");
    assert.equal(a("cos x", "sin x").status, "pass");
    assert.equal(a("tan x", "-ln|cos x| + C").status, "pass");
    assert.match(a("x e^x", "(x-1)e^x + C").tex, /\\int/);
  });
});

describe("definite integrals", () => {
  const def = (expr: string, from: string, to: string, answer: string) =>
    runCheck({ kind: "definite", expr, from, to, answer }).status;
  it("checks values", () => {
    assert.equal(def("x sin x", "0", "pi/2", "1"), "pass");
    assert.equal(def("x sin x", "0", "\\frac{\\pi}{2}", "2"), "fail");
    assert.equal(def("1/sqrt(x)", "0", "1", "2"), "pass");
    assert.equal(def("e^(-x)", "0", "+inf", "1"), "pass");
    assert.equal(def("e^(-x)", "0", "∞", "2"), "fail");
    assert.equal(def("1/(1+x^2)", "-inf", "inf", "pi"), "pass");
    assert.equal(def("x^2", "1", "0", "-1/3"), "pass");
  });
  it("divergent or singular integrals are not passed", () => {
    for (const a of ["0", "1", "2"]) {
      assert.notEqual(def("1/x", "-1", "1", a), "pass");
      assert.notEqual(def("1/x", "0", "1", a), "pass");
      assert.notEqual(def("1/(1+x)", "0", "inf", a), "pass");
      assert.notEqual(def("sin(x)", "0", "inf", a), "pass");
    }
  });
});

describe("values, roots, extrema, monotonicity", () => {
  it("value", () => {
    assert.equal(
      runCheck({ kind: "value", expr: "sin(pi/6)", answer: "1/2" }).status,
      "pass",
    );
    assert.equal(
      runCheck({ kind: "value", expr: "\\sqrt{2}^2", answer: "2" }).status,
      "pass",
    );
    assert.equal(
      runCheck({ kind: "value", expr: "e^2", answer: "7.39" }).status,
      "fail",
    );
  });

  it("roots", () => {
    const r = (
      roots: string[],
      interval?: [string, string],
      expr = "x^3-3x+1",
    ) =>
      runCheck({
        kind: "roots",
        expr,
        roots,
        ...(interval ? { interval } : {}),
      });
    const all = r(["-1.8794", "0.3473", "1.5321"], ["-2", "2"]);
    assert.equal(all.status, "pass", all.detail);
    const two = r(["-1.8794", "1.5321"], ["-2", "2"]);
    assert.equal(two.status, "fail");
    assert.match(two.detail, /0\.347/);
    assert.equal(r(["0.5"]).status, "fail");
    assert.equal(r(["1.5321"]).status, "pass");
    assert.equal(r(["1", "-1"], ["-2", "2"], "x^2 = 1").status, "pass");
    assert.equal(r(["3"], ["-2", "2"], "x-3").status, "fail");
    // tangent root without a sign change must still be found
    assert.notEqual(r(["1"], ["-2", "2"], "x^2(x-1)").status, "pass");
    assert.equal(r(["0", "1"], ["-2", "2"], "x^2(x-1)").status, "pass");
  });

  it("extremum", () => {
    const e = (
      at: string,
      type: "max" | "min",
      value?: string,
      expr = "x^3-3x+1",
    ) =>
      runCheck({
        kind: "extremum",
        expr,
        at,
        type,
        ...(value ? { value } : {}),
      }).status;
    assert.equal(e("-1", "max", "3"), "pass");
    assert.equal(e("1", "min", "-1"), "pass");
    assert.equal(e("1", "max"), "fail");
    assert.equal(e("-1", "max", "2"), "fail");
    assert.equal(e("0", "max"), "fail");
    assert.equal(e("0", "min", "0", "x^3"), "fail");
    assert.equal(e("0", "min", "0", "|x|"), "pass");
    assert.equal(e("0.7071", "min", undefined, "x^4-x^2"), "pass");
  });

  it("monotonic", () => {
    const m = (
      from: string,
      to: string,
      direction: "inc" | "dec",
      expr = "x^3-3x+1",
    ) => runCheck({ kind: "monotonic", expr, from, to, direction }).status;
    assert.equal(m("-1", "1", "dec"), "pass");
    assert.equal(m("-1", "1", "inc"), "fail");
    assert.equal(m("1", "inf", "inc"), "pass");
    assert.equal(m("-inf", "inf", "inc", "x^3"), "pass");
    assert.equal(m("-2", "2", "inc"), "fail");
    // derivative sign alone is not enough across poles and jumps
    assert.notEqual(m("-1", "1", "dec", "1/x"), "pass");
    assert.notEqual(m("-0.93", "1.1", "inc", "x-abs(x)/x"), "pass");
  });
});

describe("hostile input", () => {
  it("parseCheck validates shape and limits", () => {
    assert.deepEqual(
      parseCheck({ kind: "limit", expr: "sin(x)/x", at: "0", answer: "1" }),
      {
        kind: "limit",
        expr: "sin(x)/x",
        at: "0",
        answer: "1",
      },
    );
    assert.equal(parseCheck({ kind: "eval", expr: "1" }), null);
    assert.equal(
      parseCheck({
        kind: "limit",
        expr: "x".repeat(10000),
        at: "0",
        answer: "1",
      }),
      null,
    );
    assert.equal(
      parseCheck({
        kind: "limit",
        expr: "x",
        at: "0",
        answer: "1".repeat(121),
      }),
      null,
    );
    assert.equal(
      parseCheck({ kind: "derivative", expr: "x", answer: "1", var: "y" }),
      null,
    );
    assert.equal(parseCheck(null), null);
    assert.equal(parseCheck("limit"), null);
  });

  it("runCheck never throws and never passes garbage", () => {
    const exprs = [
      'import("fs")',
      "f(x)=x",
      "[1,2]",
      '"a"',
      "x".repeat(10000),
      "y+1",
      "x+",
      'evaluate("1")',
      "{a:1}",
      "x!",
      "1 ? 2 : 3",
      "x == 1",
      "a.b",
      "",
    ];
    for (const expr of exprs) {
      const checks: Check[] = [
        { kind: "limit", expr, at: "0", answer: "1" },
        { kind: "derivative", expr, answer: "1" },
        { kind: "antiderivative", expr, answer: "x" },
        { kind: "definite", expr, from: "0", to: "1", answer: "1" },
        { kind: "value", expr, answer: "1" },
        { kind: "roots", expr, roots: ["1"] },
        { kind: "extremum", expr, at: "0", type: "max" },
        { kind: "monotonic", expr, from: "0", to: "1", direction: "inc" },
        { kind: "limit", expr: "x", at: expr, answer: "0" },
        { kind: "derivative", expr: "x", answer: expr },
      ];
      for (const c of checks) {
        const r = runCheck(c);
        assert.equal(
          r.status,
          "unknown",
          `${c.kind} ${expr.slice(0, 20)}: ${r.detail}`,
        );
      }
    }
    assert.equal(
      runCheck({ kind: "value", expr: 'import("fs")', answer: "1" }).detail,
      "式子无法解析",
    );
    assert.equal(
      runCheck({ kind: "derivative", expr: "x", var: "y", answer: "1" }).status,
      "unknown",
    );
  });
});

describe("toMathjs", () => {
  const val = (s: string) =>
    runCheck({ kind: "value", expr: s, answer: "0" }).computed;
  it("normalizes notation", () => {
    assert.equal(val("\\frac{9}{2}"), "4.5");
    assert.equal(val("\\dfrac{1}{4}"), "0.25");
    assert.equal(val("\\sqrt[3]{8}"), "2");
    assert.equal(val("√2 · √2"), "2");
    assert.equal(val("2²"), "4");
    assert.equal(val("2⁻¹"), "0.5");
    assert.equal(val("ln e"), "1");
    assert.equal(val("\\ln(\\mathrm{e}^{2})"), "2");
    assert.equal(val("（3－1）×2÷4"), "1");
    assert.equal(val("π/π"), "1");
    assert.equal(val("|-3|"), "3");
    assert.equal(val("\\left|-3\\right|"), "3");
    assert.equal(val("2**3"), "8");
    assert.equal(val("\\sin^2 1 + \\cos^2 1"), "1");
    assert.equal(val("arcsin(1)*2/pi"), "1");
    assert.match(toMathjs("e^{3x}"), /^e\^\(3x\)$/);
    assert.equal(toMathjs("|x|"), "(abs(x))");
    assert.equal(toMathjs("√2"), "sqrt(2)");
    assert.equal(toMathjs("x²"), "x^(2)");
    assert.equal(toMathjs("ln x"), "log(x)");
    assert.equal(toMathjs("sin 2x"), "sin(2x)");
    assert.equal(toMathjs("∞"), "inf");
  });
});

describe("answer comparison helpers", () => {
  it("sameConstant", () => {
    assert.equal(sameConstant("4.5", "\\frac{9}{2}"), true);
    assert.equal(sameConstant("e^2", "exp(2)"), true);
    assert.equal(sameConstant("1/3", "0.333"), false);
    assert.equal(sameConstant("x", "1"), null);
    assert.equal(sameConstant("import(1)", "1"), null);
  });
  it("sameFunction", () => {
    assert.equal(sameFunction("(x-1)e^x", "x*exp(x)-exp(x)"), true);
    assert.equal(sameFunction("sin^2 x", "1-cos^2 x"), true);
    assert.equal(sameFunction("x^2", "2x"), false);
    assert.equal(sameFunction("ln x^2", "2 ln x"), false);
    assert.equal(sameFunction("t^2", "t*t", "t"), true);
    assert.equal(sameFunction("x(x+1)", "x^2+x"), true);
    assert.equal(sameFunction("2x(x-1)", "2x^2-2x"), true);
    assert.equal(sameFunction("sqrt(-1-x^2)", "sqrt(-2-x^2)"), null);
    assert.equal(sameFunction("y", "y"), null);
  });
  it("sameAntiderivative", () => {
    assert.equal(sameAntiderivative("ln|x|+C", "ln|x|"), true);
    assert.equal(sameAntiderivative("ln x + C", "ln|x|+C"), false);
    assert.equal(sameAntiderivative("sin^2 x + C", "-cos^2 x / 1 + C"), true);
    assert.equal(sameAntiderivative("arctan x", "-arctan(1/x)"), true);
    assert.equal(sameAntiderivative("x^2", "x^2 + x"), false);
  });
});
