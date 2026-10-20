import { all, create, type BigNumber, type MathNode } from "mathjs";
import { compareNumericAnswers } from "../../shared/math.js";
import {
  sameAntiderivative,
  sameConstant,
  sameFunction,
  sameFunctionWhereDefined,
  texOf,
  toMathjs,
} from "../../shared/verify.js";
import type { ScalarProblem as Problem } from "./problems.js";

// Judging a learner's answer on the learning map: programs only,
// never Jev or a model. Worst failure: a wrong answer judged correct; second
// worst: a right answer judged incorrect. When in doubt the verdict is "unsure".
//
// The shared parser (toMathjs) is used as is by the photo, homework and
// practice tools, so the map's extra preprocessing lives here: clean turns
// the common ways of writing an answer into what toMathjs reads, then one
// comparator per kind decides, then the carve-outs below turn a "false" that
// may come from an ambiguous way of writing into "unsure".
//
// Reasons (null when the verdict needs no explanation):
//   unparsed   the program cannot read the answer (also: too deeply nested
//              or too many functions to judge quickly, and "||")
//   missing-c  antiderivative right but without the constant
//   decimal    a decimal where an exact value is expected
//   division   implicit multiplication right after "/": a/b followed by the
//              variable, "(", π or e (1/2x, 1/2π) whatever the comparator
//              says (D2); other shapes (1/x sin x) only when the reading is false
//   ambiguous  e^-1/2, √1+x, e^2x, sin x^3, tan x/2, \ln(...)^2; a mixed
//              number (1½, 1\frac{5}{6}) whatever the comparator says
//   abs        an antiderivative right once ln(...) gets |...|: ln|...| expected
//   tex        LaTeX the parser reads only in part
//   variable   another variable letter (t, u, θ): substitute back
//   integral   the answer still contains an integral sign
//   implicit   an equation instead of y =...
//   log        bare log (ln or lg?)
//   extra-c    a derivative or solution answered with a trailing + C (incorrect)
//   constant   a particular solution with a free constant C, C_1, k (incorrect)
//   divergent  发散 / ∞ / 不存在 for a finite value (incorrect)

export type Verdict = "correct" | "incorrect" | "unsure";
export type Reason =
  | "unparsed"
  | "missing-c"
  | "decimal"
  | "division"
  | "ambiguous"
  | "abs"
  | "tex"
  | "variable"
  | "integral"
  | "implicit"
  | "log"
  | "extra-c"
  | "constant"
  | "divergent";
export type Judgement = {
  verdict: Verdict;
  reason: Reason | null;
  read: string | null; // TeX of how the program read the input
};

export const MAX_INPUT = 200;

const Big = create(all!, {
  number: "BigNumber",
  precision: 64,
  predictable: true,
});
const N = create(all!, { predictable: true });

// ---------- preprocessing ----------

const FRACTIONS: Record<string, string> = {
  "½": "1/2",
  "⅓": "1/3",
  "⅔": "2/3",
  "¼": "1/4",
  "¾": "3/4",
  "⅕": "1/5",
  "⅖": "2/5",
  "⅗": "3/5",
  "⅘": "4/5",
  "⅙": "1/6",
  "⅚": "5/6",
  "⅛": "1/8",
  "⅜": "3/8",
  "⅝": "5/8",
  "⅞": "7/8",
};
const CN_DIGITS = "零一二三四五六七八九";
// 一 … 九十九
function cnNumber(s: string): number | null {
  const m = /^([一二三四五六七八九]?)(十?)([一二三四五六七八九]?)$/.exec(s);
  if (!m || !s) return null;
  if (!m[2]) return m[1] && !m[3] ? CN_DIGITS.indexOf(m[1]) : null;
  return (
    (m[1] ? CN_DIGITS.indexOf(m[1]) : 1) * 10 + CN_DIGITS.indexOf(m[3] || "零")
  );
}

// Balanced group starting at s[i] ("(" or "{") → index after its closing bracket.
function closing(s: string, i: number): number {
  const open = s[i]!,
    close = open === "(" ? ")" : "}";
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return j + 1;
  }
  return -1;
}

// arccot a → (pi/2 - arctan(a)); the argument is a bracket group or one token.
function arccot(s: string): string {
  const re =
    /(?:\\operatorname\s*\{\s*arccot\s*\}|\\mathrm\s*\{\s*arccot\s*\}|\\?arccot)\s*/;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const start = m.index,
      at = start + m[0].length;
    let arg: string | null = null,
      end = at;
    if (s[at] === "(" || s[at] === "{") {
      end = closing(s, at);
      if (end > 0) arg = s.slice(at + 1, end - 1);
    } else {
      const tok = /^(?:\d+(?:\.\d+)?[a-zA-Z]?|\\pi|pi|π|[a-zA-Z])/.exec(
        s.slice(at),
      );
      if (tok) {
        arg = tok[0];
        end = at + tok[0].length;
      }
    }
    if (arg === null) return s; // left unparsed
    s = `${s.slice(0, start)}(pi/2-arctan(${arg}))${s.slice(end)}`;
  }
  return s;
}

// \ln\sqrt{...} → \ln(\sqrt{...}): toMathjs would read "log sqrt(...)" as a product.
function lnSqrt(s: string): string {
  const re =
    /(\\ln|\\log|\\lg|(?<![a-zA-Z\\])ln)\s*\\sqrt\s*(\[[^\]]*\])?\s*(?=\{)/g;
  let out = "",
    last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const brace = m.index + m[0].length;
    const end = closing(s, brace);
    if (end < 0) break;
    out += `${s.slice(last, m.index)}${m[1]}(\\sqrt${m[2] ?? ""}${s.slice(brace, end)})`;
    last = end;
    re.lastIndex = end;
  }
  return out + s.slice(last);
}

const TRAILING = /[\s。．.，,；;、？?]+$/; // not "!": 3! is a factorial
const DOMAIN_TAIL =
  /(?:\s|\\[ ,;:!]|\\q?quad)*[,，;；]?(?:\s|\\[ ,;:!]|\\q?quad)*(?:\\left)?[(（][^()（）]*?(?:<|>|≤|≥|\\le(?:q|qslant)?(?![a-zA-Z])|\\ge(?:q|qslant)?(?![a-zA-Z])|\\lt(?![a-zA-Z])|\\gt(?![a-zA-Z]))[^()（）]*?(?:\\right)?[)）]\s*$/;
const COMMA_DOMAIN =
  /\s*[,，;；](?:\s|\\[ ,;:!]|\\q?quad)*[a-z]\s*(?:<|>|≤|≥|\\le(?:q|qslant)?(?![a-zA-Z])|\\ge(?:q|qslant)?(?![a-zA-Z])|\\lt(?![a-zA-Z])|\\gt(?![a-zA-Z]))[^,，;；]*$/;
const PREFIX =
  /^\s*(?:(?:[yY]\s*(?:'+|′+|\^\s*\{?\s*\(\s*\d+\s*\)\s*\}?|\^\s*\{\s*\\prime+\s*\})?|[yY]\s*\(\s*x\s*\)|f\s*(?:'+|′+)?\s*\(\s*[xt]\s*\)|F\s*\(\s*[xt]\s*\)|原式|d\s*y\s*\/\s*d\s*x|\\[dt]?frac\s*\{\s*d\s*y\s*\}\s*\{\s*d\s*x\s*\}|[anW])\s*)?[=:]\s*/;

// Units the problem itself names: m/s on the ladder problem, J on the work problem.
function stripUnits(s: string, p: Problem): string {
  const told = `${p.text} ${p.note ?? ""}`;
  const units: string[] = [];
  if (/m\/s(?!\^)/.test(told))
    units.push(
      String.raw`\\mathrm\s*\{\s*m\s*/\s*s\s*\}`,
      String.raw`\\text\s*\{\s*m\s*/\s*s\s*\}`,
      String.raw`m\s*/\s*s`,
      String.raw`米\s*/\s*秒`,
      "米每秒",
      String.raw`m\s*[·*]\s*s\s*(?:⁻¹|\^\s*\{?\s*-\s*1\s*\}?)`,
    );
  if (/焦耳|\(J\)|（J）/.test(told))
    units.push(
      String.raw`\\mathrm\s*\{\s*J\s*\}`,
      String.raw`\\text\s*\{\s*J\s*\}`,
      "J",
      "焦耳?",
    );
  if (!units.length) return s;
  const re = new RegExp(
    String.raw`(?:\s|\\[ ,;:!]|\\q?quad|~)*(?:${units.join("|")})\s*$`,
  );
  return s.replace(re, "");
}

type Cleaned = { text: string; snap: string; mixed: boolean };
// "+C（C为常数）", "+C，C为任意常数"
const CONSTANT_NOTE =
  /\s*[,;]?\s*\(?\s*(?:其中\s*)?[CcKk](?:\s*_\s*\d+)?\s*(?:为|是)\s*(?:任意)?实?常数\s*\)?$/;
// 1½, 1\frac{5}{6}; not x^2\frac{1}{2}
const MIXED =
  /(?<![\d.}^_])\d+\s*(?:[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]|\\[dt]?frac\s*(?:\{\s*\d+\s*\}|\d)\s*(?:\{\s*\d+\s*\}|\d))/;

function clean(raw: string, p: Problem): Cleaned {
  let s = raw
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ")
    .replace(/[−–—]/g, "-")
    .replace(
      /[₀₁₂₃₄₅₆₇₈₉]+/g,
      (m) => `_${[...m].map((c) => c.charCodeAt(0) - 0x2080).join("")}`,
    )
    .trim();
  // W: outer $...$ / \(...\) / \[...\] and trailing punctuation, repeated
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(TRAILING, "");
    if (/^\$[\s\S]*\$$/.test(s) && s.length > 1)
      s = s.replace(/^\$+|\$+$/g, "");
    else if (/^\\\([\s\S]*\\\)$/.test(s)) s = s.slice(2, -2);
    else if (/^\\\[[\s\S]*\\\]$/.test(s)) s = s.slice(2, -2);
    s = s.trim();
  }
  // X: trailing approximation, domain or note on the constant
  s = s.replace(/\s*(?:\\approx|≈|\\simeq|约等于|约为)[\s\S]*$/, "");
  s = s
    .replace(CONSTANT_NOTE, "")
    .replace(/\+\s*(?:任意)?常数$/, "+C")
    .replace(DOMAIN_TAIL, "")
    .replace(COMMA_DOMAIN, "")
    .replace(TRAILING, "");
  // P: labels, a leading "=", the problem's integral copied before the result
  s = s
    .replace(/^答\s*:?\s*/, "")
    .replace(/^\s*(?:∫|\\i+nt)[\s\S]*?d\s*[xt]\s*=\s*/, "")
    .replace(PREFIX, "");
  if (p.kind === "number") {
    // 极限为 1/2, 面积是 9/2; S=9/2, lim=1/2: a label left of the last "="
    s = s.replace(/^[一-鿿]{1,6}(?:为|是)\s*/, "");
    const eq = s.lastIndexOf("=");
    if (eq >= 0 && !/\d/.test(s.slice(0, eq))) s = s.slice(eq + 1).trim();
    // U: units the problem names
    s = stripUnits(s, p);
    // G: "n 至少取多少" answered as n≥6, 至少6, 6项
    if (p.text.includes("至少"))
      s = s
        .replace(/^(?:n\s*)?(?:≥|>=|⩾|\\geq?(?![a-zA-Z])|\\geqslant)\s*/, "")
        .replace(/^至少(?:取|为|是|要)?\s*/, "")
        .replace(/\s*项$/, "");
    // S: thousands separators
    s = s.replace(
      /(?<![\d.])(\d{1,3})((?:(?:,|\\,|\\ |\s)\d{3})+)(?![\d.])/g,
      (_, a: string, b: string) => a + b.replace(/\D/g, ""),
    );
  }
  // A mixed number reads as a product (1½ → 1·½): never judged by value
  const mixed = MIXED.test(s);
  // F: ½ and 二分之一
  s = s
    .replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, (c) => `(${FRACTIONS[c]})`)
    .replace(
      /([一二三四五六七八九十]+)分之([一二三四五六七八九十]+)/g,
      (m, d: string, n: string) => {
        const a = cnNumber(n),
          b = cnNumber(d);
        return a && b ? `(${a}/${b})` : m;
      },
    );
  // K: square brackets are grouping (mathjs reads [ ] as a matrix); keep \sqrt[n]
  s = s
    .replace(/\\sqrt\s*\[([^\]]*)\]/g, "\\sqrt\u0001$1\u0002")
    .replace(/\\left\s*\[/g, "\\left(")
    .replace(/\\right\s*\]/g, "\\right)")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\u0001/g, "[")
    .replace(/\u0002/g, "]");
  // T: tan^{-1} → arctan (also glued to the variable: 2xtan^-1x), arccot → pi/2 - arctan
  s = s.replace(
    new RegExp(
      String.raw`(?<![a-zA-Z\\])(${p.var ?? "x"})(?=(?:sin|cos|tan)\s*(?:\^|⁻))`,
      "g",
    ),
    "$1 ",
  );
  s = s.replace(
    /(?<![a-zA-Z])(\\?)(sin|cos|tan)\s*(?:\^\s*(?:\{\s*-\s*1\s*\}|\(\s*-\s*1\s*\)|-\s*1(?!\d))|⁻¹)/g,
    (_, bs: string, f: string) => `${bs}arc${f} `,
  );
  s = arccot(s).trim();
  const snap = s;
  // A: \tan\frac{1}{2}x → \tan(\frac{1}{2}x)
  s = s.replace(
    /(\\(?:sin|cos|tan|cot|sec|csc))\s*(\\[dt]?frac\s*(?:\{[^{}]*\}|\d)\s*(?:\{[^{}]*\}|\d))\s*([a-z])(?![a-zA-Z])/g,
    "$1($2$3)",
  );
  // L, N, R: spaces only, so mathjs's reading of implicit products is unchanged
  s = s
    .replace(/(\d)(?=arcsin|arccos|arctan|ln|lg|log|sqrt)/g, "$1 ")
    .replace(
      /(?<![a-zA-Z\\])(arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|cot|sec|csc|ln|lg)(?=\d)/g,
      "$1 ",
    )
    .replace(/([a-zA-Z])√/g, "$1 √");
  // Q: \ln\sqrt{...}
  s = lnSqrt(s);
  // + Cx: a constant glued to the variable is still the constant (and wrong)
  if (p.kind === "antiderivative")
    s = s.replace(
      new RegExp(
        String.raw`(?<![a-zA-Z\\])([CcKk])(?=${p.var ?? "x"}(?![a-zA-Z]))`,
        "g",
      ),
      "$1 ",
    );
  return { text: s, snap, mixed };
}

// ---------- detectors ----------

const FN =
  "arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|cot|sec|csc|ln|lg|log|exp";
const INTEGRAL = /\\i+nt|∫/;
const DIVERGENT =
  /发散|不存在|无穷|∞|\\infty|(?<![a-zA-Z])inf(?:ty)?(?![a-zA-Z])/;
const BARE_LOG = /(?<![a-zA-Z])log(?!\s*_|\s*10|\s*2\s*\(|[a-zA-Z])/;
const OTHER_VARIABLE = /θ|φ|\\theta|\\varphi|\\phi|\\alpha|\\beta|α|β/;
// Constant of integration: C, C_1, C', \mathrm{C}, \text{C}, a lone c, K or k;
// also glued to ln before it (lnC) or to a function after it (Ctan x).
const C_TOKEN = new RegExp(
  String.raw`\\(?:mathrm|text|operatorname|mathit)\s*\{\s*[CK]\s*\}|(?:(?<![a-zA-Z\\])|(?<=(?<![a-zA-Z])\\?ln\s*))[CcKk](?:\s*_\s*\{?\s*\d+\s*\}?)?['′]?(?!(?!(?:${FN}|sqrt))[a-zA-Z])`,
  "g",
);
const FREE_CONSTANT =
  /\\(?:mathrm|text|operatorname|mathit)\s*\{\s*[Ck]\s*\}|(?<![a-zA-Z\\])[CcKk](?:\s*_\s*\{?\s*\d+\s*\}?|\d)?(?![a-zA-Z])/;
const TRAILING_C =
  /\+\s*(?:\\(?:mathrm|text)\s*\{\s*[CK]\s*\}|[CcKk])(?:\s*_\s*\{?\s*\d+\s*\}?)?['′]?\s*$/;

// Implicit multiplication right after "/": 1/2x, (x^2+1)/2 arctan x, 1/x sin x;
// \cdot, \times and \right are not implicit.
const DIVISION =
  /\/\s*(?:\d+(?:\.\d+)?|[a-zA-Z](?![a-zA-Z])|\([^()]*\)|\{[^{}]*\})(?:\s*\^\s*(?:\d+|[a-zA-Z]|\{[^{}]*\}|\([^()]*\)))?\s*(?=[a-zA-Z(√]|\\(?!cdot|times|div|right|[ ,;:!]))/;
// The a/bx shape (D2): a bare number after "/" followed by the variable, "(",
// π or e has two readings (1/2x: x/2 or 1/(2x)), so it never lights a point.
// A function name after the number (1/2 ln x) is not this shape.
const divisionShape = (s: string, v: string) =>
  new RegExp(
    String.raw`\/\s*\d+(?:\.\d+)?\s*(?!(?:${FN}|sqrt))(?:${v}|\(|\\left\s*\(|π|\\pi(?![a-zA-Z])|pi(?![a-zA-Z])|e(?![a-zA-Z]))`,
  ).test(s);

// The shared parser's TeX takes time exponential in the nesting of function
// calls (B1: 20 nested sin( take seconds), and each function or power adds
// to every comparison (an arctan about 0.1 s). Real answers nest brackets at
// most 3 deep and cost at most 9 below, so anything far beyond is not judged.
const MAX_DEPTH = 8;
const MAX_COST = 16;
const INVERSE_TRIG = /arcsin|arccos|arctan/g;
const OTHER_FUNCTION = new RegExp(`${FN}|sqrt|√`, "g");
const POWER = /\^|[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g;
function tooComplex(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === "(" || c === "{" || c === "[") {
      if (++depth > MAX_DEPTH) return true;
    } else if (c === ")" || c === "}" || c === "]") depth--;
  }
  const inverse = s.match(INVERSE_TRIG)?.length ?? 0;
  const rest = s.replace(INVERSE_TRIG, "");
  const cost =
    4 * inverse +
    (rest.match(OTHER_FUNCTION)?.length ?? 0) +
    (rest.match(POWER)?.length ?? 0);
  return cost > MAX_COST;
}

function ambiguous(s: string, v: string): boolean {
  if (/\^\s*(?:-|1\s*\/)/.test(s)) return true; // e^-1/2, e^1/2 (x^3/3 is not)
  if (/√\s*\d+(?:\.\d+)?\s*[+-]/.test(s)) return true; // 1/√1+x²
  // e^2x, e^2(x+1): e^{2x} or e^2·x? (x^2(x+1) and x^2 arctan x are not)
  if (
    new RegExp(
      String.raw`(?<![a-zA-Z])e\s*\^\s*\d+(?:\.\d+)?\s*(?:${v}|\()`,
    ).test(s)
  )
    return true;
  // sin x^3, tan x/2 (sin x/x is not)
  if (
    new RegExp(
      `(?<![a-zA-Z])\\\\?(?:${FN})\\s*(?:\\d+[a-z]?|[a-z])\\s*(?:\\^|/\\s*\\d)`,
    ).test(s)
  )
    return true;
  // \ln(...)^2, \ln|...|^{1/2}: ln of a power or a power of ln?
  const fn = /(?<![a-zA-Z])\\?(?:ln|lg|log)\s*(?:\\left\s*)?(?=[(|])/g;
  for (let m = fn.exec(s); m; m = fn.exec(s)) {
    const at = m.index + m[0].length;
    let end = -1;
    if (s[at] === "(") end = closing(s, at);
    else {
      const close = s.indexOf("|", at + 1);
      end = close < 0 ? -1 : close + 1;
    }
    if (end > 0 && /^\s*(?:\\right\s*[)|]\s*)?\^/.test(s.slice(end)))
      return true;
  }
  return false;
}

// Symbols other than the variable, e and pi, read the way the comparators read them.
function foreignSymbols(text: string, v: string): Set<string> | null {
  try {
    const out = new Set<string>();
    const walk = (node: MathNode): void => {
      const n = node as MathNode & Record<string, unknown>;
      if (node.type === "SymbolNode") {
        const name = n.name as string;
        if (![v, "e", "pi", "inf", "Infinity"].includes(name)) out.add(name);
      } else if (node.type === "FunctionNode")
        (n.args as MathNode[]).forEach(walk);
      else node.forEach((c) => walk(c));
    };
    walk(N.parse(toMathjs(text)));
    return out;
  } catch {
    return null;
  }
}

// ---------- decimals ----------

const DECIMAL = /(?<![\d.])(\d*)\.(\d+)(?![\d.])/g;
const PLAIN_DECIMAL = /^([+-]?)(\d*)\.(\d+)$/;

// Exact fraction for each decimal literal; null when one has more than 3 places.
function exactDecimals(s: string): string | null {
  let ok = true;
  const out = s.replace(DECIMAL, (_, i: string, f: string) => {
    if (f.length > 3) ok = false;
    return `(${BigInt(i + f)}/${10n ** BigInt(f.length)})`;
  });
  return ok ? out : null;
}

// The canonical value as an exact fraction, or as a 64-digit number when irrational.
type Value = { p: bigint; q: bigint } | { real: BigNumber };
function canonicalValue(answer: string): Value | null {
  const m = /^\s*(-?\d+)\s*(?:\/\s*(\d+))?\s*$/.exec(answer);
  if (m) return { p: BigInt(m[1]!), q: BigInt(m[2] ?? "1") };
  try {
    const v: unknown = Big.evaluate(toMathjs(answer));
    return Big.isBigNumber(v) && v.isFinite() ? { real: v } : null;
  } catch {
    return null;
  }
}

// Number problem answered with a plain decimal: exact → correct; equal to the
// canonical value rounded to the same places, with at least 2 significant
// digits → unsure; otherwise incorrect.
function plainDecimal(
  answer: string,
  sign: string,
  int: string,
  frac: string,
): Judgement | null {
  const k = frac.length;
  const n = BigInt(sign === "-" ? `-${int}${frac}` : `${int}${frac}`);
  const scale = 10n ** BigInt(k);
  const canon = canonicalValue(answer);
  if (!canon) return null;
  const read = texOf(`${sign}${int || "0"}.${frac}`);
  let rounded: bigint;
  if ("p" in canon) {
    const { p, q } = canon;
    if (n * q === p * scale) return { verdict: "correct", reason: null, read };
    const abs = (p < 0n ? -p : p) * scale;
    const r = (2n * abs + q) / (2n * q); // half away from zero
    rounded = p < 0n ? -r : r;
  } else {
    const v = canon.real.toDecimalPlaces(k, 4 /* ROUND_HALF_UP */);
    rounded = BigInt(
      v.times(Big.bignumber(scale.toString()) as BigNumber).toFixed(0),
    );
  }
  const significant = `${int}${frac}`.replace(/^0+/, "").length;
  if (rounded === n && significant >= 2)
    return { verdict: "unsure", reason: "decimal", read };
  return { verdict: "incorrect", reason: null, read };
}

// ---------- judge ----------

// For explicitly positive-domain expression problems, compare f(exp(u)) and
// g(exp(u)): exp maps real u to positive values, including values below 1.
// Substitute AST symbols only, with no identity rewrites and no changes to the
// shared parser. Its default-deny compiler still validates the transformed AST.
function samePositiveFunction(
  a: string,
  b: string,
  variable: string,
): boolean | null {
  const transform = (source: string): string | null => {
    try {
      const positive = N.parse("exp(u)");
      const node = N.parse(toMathjs(source)).transform((part) =>
        part.type === "SymbolNode" &&
        (part as MathNode & { name: string }).name === variable
          ? positive.cloneDeep()
          : part,
      );
      let nodes = 0;
      node.traverse(() => {
        nodes++;
      });
      if (nodes > 128) return null;
      const result = node.toString({ parenthesis: "auto", implicit: "show" });
      return result.length <= 300 && !tooComplex(result) ? result : null;
    } catch {
      return null;
    }
  };
  const reference = transform(a),
    answer = transform(b);
  return reference === null || answer === null
    ? null
    : sameFunction(reference, answer, "u");
}

const unsure = (reason: Reason, read: string | null): Judgement => ({
  verdict: "unsure",
  reason,
  read,
});

export function judge(problem: Problem, input: string): Judgement {
  const v = problem.var ?? "x";
  if (typeof input !== "string" || input.length > MAX_INPUT)
    return unsure("unparsed", null);
  const { text, snap, mixed } = clean(input, problem);
  // "||" is read as two empty bars; deep nesting would take seconds (B1)
  if (!text || text.includes("||") || tooComplex(text))
    return unsure("unparsed", null);
  const kind = problem.kind;
  const hasC =
    kind === "antiderivative" && new RegExp(C_TOKEN.source).test(text);
  const withC = (k: string) => text.replace(C_TOKEN, `(${k})`);
  // How the program read the input; an antiderivative's trailing + C is shown as is.
  const readOf = (s: string): string | null => {
    if (kind !== "antiderivative") return texOf(s, v);
    if (!new RegExp(C_TOKEN.source).test(s)) return texOf(s, v);
    const bare = s.replace(TRAILING_C, "");
    if (bare === s || new RegExp(C_TOKEN.source).test(bare)) return null;
    const tex = texOf(bare, v);
    return tex === null ? null : `${tex}+C`;
  };
  const read = readOf(text);
  if (INTEGRAL.test(text)) return unsure("integral", read);
  if (kind === "number" && DIVERGENT.test(text))
    return { verdict: "incorrect", reason: "divergent", read };
  if (/=/.test(text)) return unsure("implicit", read);
  const foreign =
    kind === "number" ? null : foreignSymbols(hasC ? withC("1") : text, v);
  // e^{Cx}: the constant is glued to the variable, so only the parser sees it
  const constantsOnly =
    !!foreign?.size && [...foreign].every((n) => /^[CcKk](?:_?\d+)?$/.test(n));
  if (kind === "expr" && (FREE_CONSTANT.test(text) || constantsOnly)) {
    const rest = text.replace(TRAILING_C, "");
    const reason =
      rest !== text && !FREE_CONSTANT.test(rest) ? "extra-c" : "constant";
    return { verdict: "incorrect", reason, read };
  }
  if (OTHER_VARIABLE.test(text)) return unsure("variable", read);
  if (foreign?.size === 1 && /^[a-zA-Z]$/.test([...foreign][0]!))
    return unsure("variable", read);
  if (BARE_LOG.test(text)) return unsure("log", read);
  // Two readings, whatever the comparator says (D2, mixed numbers)
  if (mixed) return unsure("ambiguous", read);
  if (divisionShape(snap, v)) return unsure("division", read);

  const compare = (s: string): boolean | null => {
    if (kind === "number")
      return (
        sameConstant(problem.answer, s) ??
        compareNumericAnswers(problem.answer, s)
      );
    if (kind === "expr")
      return problem.domain === "positive"
        ? samePositiveFunction(problem.answer, s, v)
        : problem.onAnswerDomain
          ? sameFunctionWhereDefined(problem.answer, s, v)
          : sameFunction(problem.answer, s, v);
    // antiderivative: the constant must not change the derivative (C·x^3 is not + C)
    if (!hasC) return sameAntiderivative(problem.answer, s, v);
    const one = sameAntiderivative(
      problem.answer,
      s.replace(C_TOKEN, "(1)"),
      v,
    );
    // a single trailing "+ C" is a top-level term: nothing more to check
    const tokens = s.match(C_TOKEN)?.length ?? 0;
    if (one !== true || (tokens === 1 && TRAILING_C.test(s))) return one;
    // not an integer: (C-1)(C-2)x vanishes at 1 and 2
    return sameAntiderivative(
      problem.answer,
      s.replace(C_TOKEN, "(37/100)"),
      v,
    );
  };
  // ln(...) without |...|: right once the bars are added? One constant value
  // is enough, the verdict is unsure either way.
  const rightWithBars = (): boolean => {
    if (kind !== "antiderivative") return false;
    const plain = text
      .replace(/\\left\s*\(/g, "(")
      .replace(/\\right\s*\)/g, ")");
    const fn = /(?<![a-zA-Z])\\?ln\s*(?=\()/g;
    let out = "",
      last = 0,
      changed = false;
    for (let m = fn.exec(plain); m; m = fn.exec(plain)) {
      const at = m.index + m[0].length;
      const end = closing(plain, at);
      if (end < 0) return false;
      const arg = plain.slice(at + 1, end - 1);
      if (arg.includes("|")) continue;
      out += `${plain.slice(last, at)}(abs(${arg}))`;
      last = end;
      fn.lastIndex = end;
      changed = true;
    }
    if (!changed) return false;
    const barred = (out + plain.slice(last)).replace(C_TOKEN, "(1)");
    return sameAntiderivative(problem.answer, barred, v) === true;
  };
  const right = (): Judgement =>
    kind === "antiderivative" && !hasC
      ? unsure("missing-c", read)
      : { verdict: "correct", reason: null, read };

  // Decimals: the canonical answers are exact, so a decimal is an exact value only
  // when it is one (0.75 for 3/4); otherwise the learner is told to write it exactly.
  if (new RegExp(DECIMAL.source).test(text)) {
    const plain = PLAIN_DECIMAL.exec(text.replace(/\s+/g, ""));
    if (kind === "number" && plain) {
      const j = plainDecimal(problem.answer, plain[1]!, plain[2]!, plain[3]!);
      if (j) return j;
    }
    const exact = exactDecimals(text);
    if (exact === null) return unsure("decimal", read);
    const r = compare(exact);
    if (r === true) return right();
    if (r === false) return unsure("decimal", read);
    return unsure(ambiguous(snap, v) ? "ambiguous" : "unparsed", read);
  }

  const r = compare(text);
  if (r === true) return right();
  if (r === false) {
    if (rightWithBars()) return unsure("abs", read);
    if (DIVISION.test(snap)) return unsure("division", read);
    if (ambiguous(snap, v)) return unsure("ambiguous", read);
    if (snap.includes("\\")) return unsure("tex", read);
    return { verdict: "incorrect", reason: null, read };
  }
  return unsure(ambiguous(snap, v) ? "ambiguous" : "unparsed", read);
}

// Two values in answer syntax, compared the way judge compares (no learner
// preprocessing): true the same, false provably different, null cannot tell.
// For content checks: a choice problem's options  against its source.
export function compareValues(problem: Problem, value: string): boolean | null {
  const v = problem.var ?? "x";
  if (problem.kind === "number")
    return (
      sameConstant(problem.answer, value) ??
      compareNumericAnswers(problem.answer, value)
    );
  if (problem.kind === "expr")
    return problem.domain === "positive"
      ? samePositiveFunction(problem.answer, value, v)
      : problem.onAnswerDomain
        ? sameFunctionWhereDefined(problem.answer, value, v)
        : sameFunction(problem.answer, value, v);
  return sameAntiderivative(problem.answer, value, v);
}
