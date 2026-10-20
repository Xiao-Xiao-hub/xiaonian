import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkTemplate,
  compareNumericAnswers,
  evaluateCondition,
  evaluateNumber,
  formatNumber,
  MathError,
  parseNumber,
  sameNumber,
  sampleVariant,
  type VariantTemplate,
} from "../server/src/shared/math.js";

const throwsMath = (fn: () => unknown) => assert.throws(fn, MathError);

// Small deterministic PRNG (mulberry32) for reproducible sampling.
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("expression security", () => {
  it("still evaluates after the instance is hardened", () => {
    assert.equal(evaluateNumber("1+1", {}), 2);
    assert.equal(evaluateNumber("a*d/10", { a: 60, d: 8 }), 48);
  });

  it("blocks disabled mathjs functions inside expressions", () => {
    for (const expr of [
      "import({x: 1})",
      "createUnit('foo')",
      "reviver()",
      "evaluate('1+1')",
      "parse('1+1')",
      "simplify('x+x')",
      "derivative('x^2', 'x')",
      "resolve('x')",
      "compile('1')",
      "parser()",
    ]) {
      throwsMath(() => evaluateNumber(expr, { x: 1 }));
    }
  });

  it("rejects disallowed syntax", () => {
    const scope = { x: 1, y: 2 };
    for (const expr of [
      "f(x)=x",
      "a=1",
      "x=1",
      "[1,2]",
      '"str"',
      "x.y",
      "x[1]",
      "5 cm",
      "{a: 1}",
      "1:3",
      "x > 0 ? 1 : 2",
      "x; y",
      "3!",
      "x to cm",
      "unknown + 1",
      "sin(x)",
      "cos(1)",
      "true",
      "",
    ]) {
      throwsMath(() => evaluateNumber(expr, scope));
    }
  });

  it("rejects long expressions", () => {
    throwsMath(() => evaluateNumber("1+".repeat(100) + "1", {}));
    assert.equal(evaluateNumber("1+".repeat(99) + "1", {}), 100);
  });

  it("only returns finite real numbers", () => {
    throwsMath(() => evaluateNumber("sqrt(-1)", {}));
    throwsMath(() => evaluateNumber("1/0", {}));
    throwsMath(() => evaluateNumber("10^400", {}));
    throwsMath(() => evaluateNumber("x > 1", { x: 2 }));
    assert.equal(
      evaluateNumber("abs(-3) + max(1, 2) + mod(7, 3) + round(pi, 2)", {}),
      3 + 2 + 1 + 3.14,
    );
    assert.ok(sameNumber(evaluateNumber("e", {}), Math.E));
  });
});

describe("conditions", () => {
  it("evaluates comparisons and logic", () => {
    const s = { a: 3, b: 5 };
    assert.equal(evaluateCondition("a < b", s), true);
    assert.equal(evaluateCondition("a >= b", s), false);
    assert.equal(evaluateCondition("a != b and not (a == 4)", s), true);
    assert.equal(evaluateCondition("1 < a < b", s), true);
    assert.equal(evaluateCondition("a > b or b <= 5", s), true);
    throwsMath(() => evaluateCondition("a + b", s));
  });
});

describe("parseNumber", () => {
  const cases: [string, number | null][] = [
    ["48", 48],
    ["48元", 48],
    ["４８", 48],
    ["48.0", 48],
    ["-3.5", -3.5],
    ["－3.5", -3.5],
    ["1/2", 0.5],
    ["50%", 0.5],
    ["５０％", 0.5],
    ["约48元", 48],
    ["x=48", 48],
    ["答：48 元", 48],
    ["1,200", 1200],
    ["1，200", 1200],
    ["1,200.5元", 1200.5],
    ["48元，即48", 48],
    ["0", 0],
    ["答案——48", 48],
    ["x = −2", -2],
    ["3 m/s²，方向向右", 3],
    ["5 cm³", 5],
    ["9.8 m·s⁻²", 9.8],
    ["F₁=24 N", 24],
    ["5²", null],
    ["10³ 米", null],
    ["12或48", null],
    ["第1题：48", null],
    ["3-5", null],
    ["", null],
    ["不知道", null],
    ["四十八", null],
    ["3/0", null],
  ];
  for (const [text, expected] of cases) {
    it(JSON.stringify(text), () => assert.equal(parseNumber(text), expected));
  }
});

describe("sameNumber / formatNumber", () => {
  it("compares with tolerance", () => {
    assert.ok(sameNumber(0.1 + 0.2, 0.3));
    // Whole numbers compare exactly; only non-integers get the relative tolerance.
    assert.ok(!sameNumber(1e9, 1e9 + 1));
    assert.ok(!sameNumber(1234567, 1234568));
    assert.ok(sameNumber(1e9, 1e9 + 1e-7));
    assert.ok(sameNumber(0.1 * 3 * 1e20, 3e19));
    assert.ok(!sameNumber(1, 1.001));
    assert.ok(sameNumber(0, 1e-10));
    assert.ok(!sameNumber(0, 1e-8));
  });

  it("formats rounded numbers", () => {
    assert.equal(formatNumber(48), "48");
    assert.equal(formatNumber(48.5), "48.5");
    assert.equal(formatNumber(1 / 3), "0.33");
    assert.equal(formatNumber(1.005), "1.01");
    assert.equal(formatNumber(-2.5, 0), "-3");
    assert.equal(formatNumber(-0.001), "0");
    assert.equal(formatNumber(-0), "0");
    assert.equal(formatNumber(0.1 + 0.2), "0.3");
    assert.equal(formatNumber(2.345, 3), "2.345");
  });
});

describe("compareNumericAnswers", () => {
  it("compares pure values, percentages, matching units and omitted student units", () => {
    const cases: [string, string, boolean][] = [
      ["48 元", "48", true],
      ["48元", "４８元", true],
      ["1 升", "1.0 升", true],
      ["1 升", "2 升", false],
      ["1 mL", "1mL", true],
      ["-3.5 米", "−3.5米", true],
      ["+48", "48", true],
      ["25%", "25", true],
      ["５０％", "50 %", true],
      ["25%", "50%", false],
      ["1234567 元", "1234568", false],
      ["1,200.5 元", "1200.5", true],
      ["1，200，000", "1200000", true],
      ["0", "0", true],
    ];
    for (const [reference, answer, expected] of cases)
      assert.equal(
        compareNumericAnswers(reference, answer),
        expected,
        `${reference} / ${answer}`,
      );
  });

  it("defers converted units, directions, negation and ambiguous forms", () => {
    const cases: [string, string][] = [
      ["1 升", "1 毫升"],
      ["1 升", "1000 毫升"],
      ["48", "48 元"],
      ["1 米向东", "1 米向西"],
      ["1 米向东", "1 米"],
      ["1 米", "1 米向西"],
      ["1 升", "不是 1 升"],
      ["48元", "约48元"],
      ["48元", "x=48"],
      ["48元", "48元，即48"],
      ["48元", "48 或 12 元"],
      ["1 m/s", "1 m/s"],
      // "%" is a unit: a bare fraction or another unit goes to Jev.
      ["1/2", "50%"],
      ["５０％", "0.5"],
      ["0.5 米", "50%"],
      ["48", "48%"],
      // NFKC would read 5² as 52.
      ["52", "5²"],
      ["25", "5²"],
      ["1 单位未知", "1 单位未知"],
      ["1200", "1,20,0"],
      ["1", "1/0"],
      ["1", ""],
    ];
    for (const [reference, answer] of cases)
      assert.equal(
        compareNumericAnswers(reference, answer),
        null,
        `${reference} / ${answer}`,
      );
  });
});

const base = {
  text: "一件衣服原价{a}元，打{d}折后卖多少元？",
  vars: { a: { min: 40, max: 200, step: 10 }, d: { min: 5, max: 9, step: 1 } },
  answer: "a*d/10",
  constraints: ["a*d/10 > 30"],
  unit: "元",
};

describe("checkTemplate", () => {
  it("accepts a valid template", () => {
    assert.deepEqual(checkTemplate(base), base);
  });

  it("accepts upper-case names such as F1 for forces", () => {
    const t = checkTemplate({
      text: "质量 {m} kg，拉力 {F1} N，阻力 {F2} N，求加速度。",
      vars: {
        m: { min: 2, max: 10, step: 1 },
        F1: { min: 10, max: 50, step: 2 },
        F2: { min: 2, max: 20, step: 1 },
      },
      answer: "(F1-F2)/m",
      constraints: ["F2 < F1"],
    });
    assert.equal(evaluateNumber(t.answer, { m: 5, F1: 24, F2: 9 }), 3);
    const s = sampleVariant(t, { rng: seeded(7), avoid: { m: 5, F1: 24, F2: 9 } });
    assert.ok(s.values.F2! < s.values.F1!);
  });

  it("rejects bad templates", () => {
    const bad: unknown[] = [
      null,
      { ...base, text: "原价{a}元，打{d}折，再减{c}元" },
      { ...base, text: "原价{a}元" },
      { ...base, text: "原价{a}元，打{D}折，{d}" },
      { ...base, vars: { ...base.vars, d: { min: 5, max: 9, step: 0 } } },
      { ...base, vars: { ...base.vars, d: { min: 5, max: 9, step: -1 } } },
      { ...base, vars: { ...base.vars, d: { min: 9, max: 5, step: 1 } } },
      { ...base, vars: { ...base.vars, d: { min: 5, max: 5, step: 1 } } },
      { ...base, vars: { ...base.vars, d: { min: 0, max: 20000, step: 1 } } },
      { ...base, answer: "a*d/10 + z" },
      { ...base, answer: "a*sin(d)" },
      { ...base, answer: "a=d" },
      { ...base, constraints: ["import(a)"] },
      { ...base, constraints: ["a*d"] },
      { text: "{_a}", vars: { _a: { min: 1, max: 9, step: 1 } }, answer: "_a" },
      { text: "{pi}", vars: { pi: { min: 1, max: 9, step: 1 } }, answer: "pi" },
      {
        text: "{a}{b}{c}{d}{f}{g}{h}",
        vars: Object.fromEntries(
          ["a", "b", "c", "d", "f", "g", "h"].map((k) => [
            k,
            { min: 1, max: 9, step: 1 },
          ]),
        ),
        answer: "a",
      },
    ];
    for (const t of bad) throwsMath(() => checkTemplate(t));
  });
});

describe("sampleVariant", () => {
  const t = checkTemplate(base);
  const avoid = { a: 60, d: 8 };

  it("is reproducible with a seeded rng", () => {
    const a = sampleVariant(t, { rng: seeded(42), avoid });
    const b = sampleVariant(t, { rng: seeded(42), avoid });
    assert.deepEqual(a, b);
  });

  it("satisfies constraints, avoids the original and matches evaluateNumber", () => {
    const rng = seeded(7);
    for (let i = 0; i < 200; i++) {
      const v = sampleVariant(t, { rng, avoid });
      assert.ok(
        v.values.a! >= 40 && v.values.a! <= 200 && v.values.a! % 10 === 0,
      );
      assert.ok(
        v.values.d! >= 5 && v.values.d! <= 9 && Number.isInteger(v.values.d),
      );
      assert.ok(!(v.values.a === 60 && v.values.d === 8));
      for (const c of t.constraints ?? [])
        assert.equal(evaluateCondition(c, v.values), true);
      assert.equal(v.answer, evaluateNumber(t.answer, v.values));
      assert.equal(v.answerText, formatNumber(v.answer));
      assert.equal(
        v.text,
        `一件衣服原价${v.values.a}元，打${v.values.d}折后卖多少元？`,
      );
    }
  });

  it("never returns the avoided values", () => {
    const two: VariantTemplate = {
      text: "{n}",
      vars: { n: { min: 1, max: 2, step: 1 } },
      answer: "n",
    };
    for (let seed = 0; seed < 50; seed++) {
      assert.equal(
        sampleVariant(two, { rng: seeded(seed), avoid: { n: 1 } }).values.n,
        2,
      );
    }
  });

  it("keeps decimal grids free of float drift", () => {
    const dec: VariantTemplate = {
      text: "单价{p}元，买{n}个",
      vars: {
        p: { min: 0.1, max: 2, step: 0.1 },
        n: { min: 1, max: 5, step: 1 },
      },
      answer: "p*n",
    };
    const rng = seeded(3);
    for (let i = 0; i < 100; i++) {
      const v = sampleVariant(dec, { rng });
      assert.equal(v.values.p, Number(v.values.p!.toFixed(1)));
      assert.match(v.text, /^单价\d\.?\d?元，买\d个$/);
      assert.equal(v.answerText, formatNumber(v.answer));
    }
  });

  it("skips answers with too many decimals", () => {
    const div: VariantTemplate = {
      text: "{a}÷3",
      vars: { a: { min: 1, max: 30, step: 1 } },
      answer: "a/3",
    };
    const rng = seeded(11);
    for (let i = 0; i < 50; i++) {
      const v = sampleVariant(div, { rng, maxDecimals: 0 });
      assert.equal(v.values.a! % 3, 0);
      assert.equal(v.answerText, String(v.values.a! / 3));
    }
  });

  it("treats constraints that fail to evaluate as not satisfied", () => {
    const sq: VariantTemplate = {
      text: "{a}{b}",
      vars: { a: { min: 1, max: 9, step: 1 }, b: { min: 1, max: 9, step: 1 } },
      answer: "sqrt(a-b)",
      constraints: ["sqrt(a-b) >= 1"],
    };
    const rng = seeded(5);
    for (let i = 0; i < 50; i++) {
      const v = sampleVariant(sq, { rng });
      assert.ok(v.values.a! - v.values.b! >= 1);
    }
  });

  it("throws when no values satisfy the constraints", () => {
    const impossible = { ...base, constraints: ["a > 1000"] };
    assert.throws(() => sampleVariant(impossible, { rng: seeded(1) }), {
      name: "MathError",
      message: "找不到满足条件的新数值",
    });
    const onlyAvoid: VariantTemplate = {
      ...base,
      constraints: ["a == 60", "d == 8"],
    };
    throwsMath(() => sampleVariant(onlyAvoid, { rng: seeded(1), avoid }));
  });
});
