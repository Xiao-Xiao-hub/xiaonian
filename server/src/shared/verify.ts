import { all, create, type BigNumber, type MathNode } from "mathjs";
import { z } from "zod";

// Numeric verification of calculus claims. Invariant: a wrong answer never gets "pass";
// whenever the numerics are not conclusive the result is "unknown".

export type Check =
  | {
      kind: "limit";
      expr: string;
      var?: string;
      at: string;
      side?: "+" | "-";
      answer: string;
    }
  | {
      kind: "derivative";
      expr: string;
      var?: string;
      order?: 1 | 2;
      answer: string;
    }
  | { kind: "antiderivative"; expr: string; var?: string; answer: string }
  | {
      kind: "definite";
      expr: string;
      var?: string;
      from: string;
      to: string;
      answer: string;
    }
  | { kind: "value"; expr: string; answer: string }
  | {
      kind: "roots";
      expr: string;
      var?: string;
      roots: string[];
      interval?: [string, string];
    }
  | {
      kind: "extremum";
      expr: string;
      var?: string;
      at: string;
      type: "max" | "min";
      value?: string;
    }
  | {
      kind: "monotonic";
      expr: string;
      var?: string;
      from: string;
      to: string;
      direction: "inc" | "dec";
    };

export type CheckResult = {
  status: "pass" | "fail" | "unknown";
  computed: string | null;
  detail: string;
  tex: string;
};

// Two precisions: a point is trusted only when both agree (filters catastrophic cancellation).
const B1 = create(all!, {
  number: "BigNumber",
  precision: 60,
  predictable: true,
});
const B2 = create(all!, {
  number: "BigNumber",
  precision: 120,
  predictable: true,
});
const N = create(all!, { predictable: true });
type Big = BigNumber;
type Inst = typeof B1;

const MAX_EXPR = 300;
// mathjs's toTex about doubles its time per level of bracket nesting (22 nested
// sin( take 8 s, 30 take minutes), and every compile builds the TeX, so one typed
// answer could stall the server. After toMathjs the test expressions nest at most 5 deep.
const MAX_NESTING = 12;
const nesting = (s: string) => {
  let depth = 0,
    max = 0;
  for (const c of s)
    if (c === "(" || c === "[") max = Math.max(max, ++depth);
    else if (c === ")" || c === "]") depth--;
  return max;
};
const VARS = new Set(["x", "t", "n", "u"]);
const FUNCS = new Set([
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh",
  "exp",
  "log",
  "log10",
  "log2",
  "sqrt",
  "cbrt",
  "abs",
  "pow",
]);
const OPS = new Set([
  "add",
  "subtract",
  "multiply",
  "divide",
  "unaryMinus",
  "unaryPlus",
  "pow",
]);

class ParseError extends Error {}

// Default-deny AST walk.
function checkNode(node: MathNode, v: string | null): void {
  const n = node as MathNode & Record<string, unknown>;
  switch (node.type) {
    case "ConstantNode":
      if (typeof n.value !== "number" && !B1.isBigNumber(n.value))
        throw new ParseError("constant");
      return;
    case "SymbolNode":
      if (n.name !== v && n.name !== "pi" && n.name !== "e")
        throw new ParseError("symbol");
      return;
    case "ParenthesisNode":
      return checkNode(n.content as MathNode, v);
    case "OperatorNode":
      if (!OPS.has(n.fn as string)) throw new ParseError("operator");
      for (const a of n.args as MathNode[]) checkNode(a, v);
      return;
    case "FunctionNode": {
      const fn = n.fn as MathNode & { name?: string };
      if (fn.type !== "SymbolNode" || !fn.name || !FUNCS.has(fn.name))
        throw new ParseError("function");
      for (const a of n.args as MathNode[]) checkNode(a, v);
      return;
    }
    default:
      throw new ParseError(node.type);
  }
}

type BigFn = (x?: Big) => Big | null; // null = NaN / error; ±Infinity is returned as is
type Expr = { b1: BigFn; b2: BigFn; num: (x: number) => number; tex: string };

function compile(text: string, v: string | null = "x"): Expr {
  if (typeof text !== "string" || text.length > MAX_EXPR)
    throw new ParseError("length");
  const src = toMathjs(text);
  if (!src.trim()) throw new ParseError("empty");
  if (nesting(src) > MAX_NESTING) throw new ParseError("nesting");
  const build = (inst: Inst) => {
    let node: MathNode;
    try {
      node = inst.parse(src);
    } catch {
      throw new ParseError("syntax");
    }
    checkNode(node, v);
    return { node, code: node.compile() };
  };
  const big = (inst: Inst): BigFn => {
    const { code } = build(inst);
    return (x) => {
      try {
        const r: unknown = code.evaluate(v && x ? { [v]: x } : {});
        return inst.isBigNumber(r) && !r.isNaN() ? r : null;
      } catch {
        return null;
      }
    };
  };
  const { node, code } = build(N);
  return {
    b1: big(B1),
    b2: big(B2),
    num: (x) => {
      try {
        const r: unknown = code.evaluate(v ? { [v]: x } : {});
        return typeof r === "number" ? r : NaN;
      } catch {
        return NaN;
      }
    },
    tex: node.toTex(),
  };
}

const fin = (b: Big | null): Big | null => (b && b.isFinite() ? b : null);
const toNum = (b: Big): number => {
  if (!b.isFinite()) return b.isNeg() ? -Infinity : Infinity;
  const n = b.toNumber();
  return Number.isFinite(n) ? n : b.isNeg() ? -Infinity : Infinity;
};
const bigClose = (a: Big, b: Big, tol: number) =>
  a
    .minus(b)
    .abs()
    .lte(B1.max(a.abs(), b.abs()).times(tol) as Big) ||
  a.minus(b).abs().lt(1e-40);

// ---------- text normalization ----------

const LATEX: Record<string, string> = {
  sin: "sin",
  cos: "cos",
  tan: "tan",
  cot: "cot",
  sec: "sec",
  csc: "csc",
  arcsin: "asin",
  arccos: "acos",
  arctan: "atan",
  sinh: "sinh",
  cosh: "cosh",
  tanh: "tanh",
  ln: "log",
  log: "log",
  lg: "log10",
  exp: "exp",
  cdot: "*",
  times: "*",
  div: "/",
  pi: "pi",
  infty: "inf",
  e: "e",
};
const SUP: Record<string, string> = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
  "⁻": "-",
  "⁺": "+",
  "⁽": "(",
  "⁾": ")",
  ⁿ: "n",
  ˣ: "x",
};
const FN_NAMES =
  "asin|acos|atan|arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|cot|sec|csc|log10|log2|log|ln|lg|exp";

// Names a run of letters may contain; anything else is a product of one-letter
// symbols ("xe^x" is x·e^x, "xsinx" is x·sin x). Longest names are tried first.
const NAMES = [...FN_NAMES.split("|"), "sqrt", "cbrt", "abs", "pow", "pi", "inf", "none"].sort(
  (a, b) => b.length - a.length,
);
function splitRun(run: string): string {
  const out: string[] = [];
  for (let i = 0; i < run.length; ) {
    const name = NAMES.find((n) => run.startsWith(n, i));
    out.push(name ?? run[i]!);
    i += name ? name.length : 1;
  }
  return out.join(" ");
}

function group(s: string, i: number): [string, number] {
  while (s[i] === " ") i++;
  if (s[i] === "{") {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}" && --depth === 0) return [s.slice(i + 1, j), j + 1];
    }
    return [s.slice(i + 1), s.length];
  }
  const cmd = /^\\[a-zA-Z]+/.exec(s.slice(i));
  if (cmd) return [cmd[0], i + cmd[0].length];
  return [s[i] ?? "", i + 1];
}

function latex(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\\") {
      const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
      const cmd = m ? m[1]! : "";
      i += m ? m[0].length : 1;
      if (cmd === "frac" || cmd === "dfrac" || cmd === "tfrac") {
        const [a, i1] = group(s, i);
        const [b, i2] = group(s, i1);
        out += `((${latex(a)})/(${latex(b)}))`;
        i = i2;
      } else if (cmd === "sqrt") {
        let root = "";
        if (s[i] === "[") {
          const end = s.indexOf("]", i);
          root = s.slice(i + 1, end < 0 ? s.length : end);
          i = end < 0 ? s.length : end + 1;
        }
        const [a, i1] = group(s, i);
        out += root
          ? `((${latex(a)})^(1/(${latex(root)})))`
          : `sqrt(${latex(a)})`;
        i = i1;
      } else if (cmd === "left" || cmd === "right") {
        if (s[i] === ".") i++;
      } else if (
        ["mathrm", "operatorname", "text", "mathit", "rm"].includes(cmd)
      ) {
        const [a, i1] = group(s, i);
        out += ` ${LATEX[a.trim()] ?? latex(a)} `;
        i = i1;
      } else if (cmd in LATEX) out += ` ${LATEX[cmd]} `;
      else if (cmd === "{" || cmd === "}") out += cmd === "{" ? "(" : ")";
      else if ([",", ";", "!", " ", ":", "quad", "qquad"].includes(cmd))
        out += " ";
      else out += `\\${cmd}`;
    } else if (ch === "{") {
      const [a, i1] = group(s, i);
      out += `(${latex(a)})`;
      i = i1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// Balanced "(...)" starting at s[i] === "(" → index after the closing paren.
function closeParen(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "(") depth++;
    else if (s[j] === ")" && --depth === 0) return j + 1;
  }
  return -1;
}

export function toMathjs(text: string): string {
  if (typeof text !== "string") return "";
  let s = text
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[−–—]/g, "-")
    .replace(/[×·⋅∙]/g, "*")
    .replace(/÷/g, "/")
    .replace(/π/g, "pi")
    .replace(/∞/g, "inf")
    .replace(/\*\*/g, "^")
    .replace(
      /[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺⁽⁾ⁿˣ]+/g,
      (m) => `^(${[...m].map((c) => SUP[c]).join("")})`,
    );
  s = latex(s);
  s = s.replace(/[a-zA-Z]+/g, splitRun);
  s = s
    .replace(/√\s*\(/g, "sqrt(")
    .replace(/√\s*(\d+(?:\.\d+)?|pi|[a-zA-Z])/g, "sqrt($1)")
    .replace(/\|([^|]*)\|/g, "(abs($1))")
    .replace(/\bln\b/g, "log")
    .replace(/\blg\b/g, "log10")
    .replace(/\barc(sin|cos|tan)\b/g, "a$1")
    // "x(x+1)", "e^x(sin x)": a lone letter before "(" is a factor, not a call
    .replace(/(?<![a-zA-Z_.])([a-zA-Z]|pi)\s*\(/g, "$1*(");
  // sin^2(x) / sin^2 x → (sin(x))^2
  const powFn = new RegExp(
    `(?<![a-zA-Z])(${FN_NAMES})\\s*\\^\\s*(\\d+|\\(\\d+\\))\\s*`,
    "g",
  );
  for (let m = powFn.exec(s); m; m = powFn.exec(s)) {
    const start = m.index;
    let end = start + m[0].length;
    let arg: string | null = null;
    if (s[end] === "(") {
      const close = closeParen(s, end);
      if (close > 0) {
        arg = s.slice(end, close);
        end = close;
      }
    } else {
      const tok = /^(\d+(?:\.\d+)?[a-zA-Z]?|pi|[a-zA-Z])/.exec(s.slice(end));
      if (tok) {
        arg = `(${tok[0]})`;
        end += tok[0].length;
      }
    }
    if (arg === null) continue;
    const rep = `(${m[1]}${arg})^${m[2]}`;
    s = s.slice(0, start) + rep + s.slice(end);
    powFn.lastIndex = start + rep.length;
  }
  // "ln x", "sin 2x", "sin x^2", "2sin x" → function application
  s = s.replace(
    new RegExp(
      `(?<![a-zA-Z])(${FN_NAMES})\\s+(\\d+(?:\\.\\d+)?[a-zA-Z]?|pi|[a-zA-Z])(\\^(?:\\d+|[a-zA-Z]|\\([^()]*\\)))?(?![\\w(])`,
      "g",
    ),
    (_, f: string, a: string, p = "") => `${f}(${a}${p})`,
  );
  return s.replace(/\s+/g, " ").trim();
}

const stripC = (s: string) => s.replace(/\s*\+\s*[Cc](?:_?\d)?\s*$/, "");

// ---------- formatting ----------

function fmt(v: number): string {
  if (v === Infinity) return "+∞";
  if (v === -Infinity) return "−∞";
  if (Number.isNaN(v)) return "无定义";
  if (Math.abs(v) < 1e-12) return "0";
  return String(Number(v.toPrecision(6)));
}

// ---------- answers ----------

type Ans =
  | { t: "num"; v: number }
  | { t: "inf"; sign: 0 | 1 | -1 }
  | { t: "none" }
  | null;

function special(s: string): Ans {
  const k = toMathjs(s)
    .replace(/\s+/g, "")
    .replace(/^\((.*)\)$/, "$1")
    .toLowerCase();
  if (k === "inf" || k === "infinity") return { t: "inf", sign: 0 };
  if (k === "+inf" || k === "+infinity") return { t: "inf", sign: 1 };
  if (k === "-inf" || k === "-infinity") return { t: "inf", sign: -1 };
  if (
    ["不存在", "dne", "none", "doesnotexist", "无极限", "极限不存在"].includes(
      k,
    )
  )
    return { t: "none" };
  return null;
}

function constant(s: string): Big | null {
  const e = compile(s, null);
  const a = fin(e.b1()),
    b = fin(e.b2());
  return a && b && bigClose(a, b, 1e-20) ? a : null;
}

function answer(s: string): Ans {
  const sp = special(s);
  if (sp) return sp;
  try {
    const c = constant(s);
    return c ? { t: "num", v: toNum(c) } : null;
  } catch {
    return null;
  }
}

// true = equal, false = clearly different, null = grey zone
function compare(
  computed: number,
  ans: number,
  passTol: number,
): boolean | null {
  const d = Math.abs(computed - ans);
  const m = Math.max(Math.abs(computed), Math.abs(ans));
  if (d <= passTol * m || d <= 1e-12) return true;
  if (d > 1e-4 * m && d > 1e-9) return false;
  return null;
}

// Half a unit in the last place of a plain decimal literal ("1.8794" → 5e-5), else 0.
function halfUnit(s: string): number {
  const m = /^\s*[+-−]?\d*\.(\d+)\s*$/.exec(s);
  return m ? 0.5 * 10 ** -m[1]!.length : 0;
}

// ---------- limits ----------

type Lim = { kind: "value"; v: number } | { kind: "inf"; sign: 1 | -1 };
// v: value as a JS number (±Infinity past double range); mag: log10|value| (Infinity on BigNumber overflow).
type Pt = { e: number; v: number; mag: number; zero: boolean };
const magOf = (b: Big) => {
  if (!b.isFinite()) return Infinity;
  const n = Math.abs(b.toNumber());
  return Number.isFinite(n) && n > 0 ? Math.log10(n) : toNum(b.abs().log(10));
};

// Offset ≈ 10^-e (or x ≈ 10^e at infinity) with a short mantissa, so x0 + h is exact in both
// precisions; exact powers of ten would make decimal arithmetic accidentally exact.
function makePoint(inst: Inst, base: Big | null, s: number, e: number): Big {
  const k = Number.isInteger(e) ? e : base ? Math.ceil(e) : Math.floor(e);
  const m = Number.isInteger(e)
    ? "1.0471975511965976"
    : (10 ** Math.abs(k - e)).toPrecision(8);
  const step = inst.bignumber(`${m}e${base ? -k : k}`) as Big;
  return base === null ? step.times(s) : base.plus(step.times(s));
}

function sample(
  f: Expr,
  base: [Big, Big] | null,
  s: number,
  e: number,
): Pt | null {
  const a = f.b1(makePoint(B1, base && base[0], s, e));
  const b = f.b2(makePoint(B2, base && base[1], s, e));
  if (!a || !b) return null;
  if (!a.isFinite() || !b.isFinite()) {
    return !a.isFinite() && !b.isFinite() && a.isNeg() === b.isNeg()
      ? { e, v: toNum(b), mag: Infinity, zero: false }
      : null;
  }
  if (a.isZero() && b.isZero()) return { e, v: 0, mag: -Infinity, zero: true };
  if (!bigClose(a, b, 1e-12)) return null;
  return { e, v: toNum(b), mag: magOf(b), zero: false };
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
const spreadE = (e0: number, e1: number, k: number) =>
  Array.from(
    { length: k },
    (_, j) => e0 + ((j + 0.5) / k) * (e1 - e0) + 0.0731,
  );

function divergence(
  f: Expr,
  base: [Big, Big] | null,
  s: number,
  rel: Pt[],
): Lim | null {
  let start = rel.length;
  let finite = 0;
  while (start > 0 && (rel.length - start < 6 || finite < 5)) {
    start--;
    if (Number.isFinite(rel[start]!.mag)) finite++;
  }
  if (finite < 5) return null;
  const seq = rel.slice(start);
  const sign = Math.sign(seq[0]!.v);
  const increasing = (ps: Pt[]) =>
    ps.every((p, i) => {
      if (Math.sign(p.v) !== sign) return false;
      if (i === 0) return true;
      const prev = ps[i - 1]!.mag,
        cur = p.mag;
      return cur > prev || (cur === Infinity && prev === Infinity);
    });
  if (sign === 0 || !increasing(seq)) return null;
  const mags = seq.filter((p) => Number.isFinite(p.mag)).map((p) => p.mag);
  const top = Math.max(...mags);
  if (top < 6 || top < mags[0]! + 2) return null;
  const jit = spreadE(seq[0]!.e, seq.at(-1)!.e, 8)
    .map((e) => sample(f, base, s, e))
    .filter((p): p is Pt => p !== null && !p.zero);
  if (jit.length < 6) return null;
  if (!increasing([...seq, ...jit].sort((p, q) => p.e - q.e))) return null;
  return { kind: "inf", sign: sign as 1 | -1 };
}

function sideLimit(f: Expr, base: [Big, Big] | null, s: number): Lim | null {
  const es = base ? range(3, 30) : range(2, 30);
  const pts = es
    .map((e) => sample(f, base, s, e))
    .filter((p): p is Pt => p !== null);
  if (pts.length >= 8 && pts.every((p) => p.zero))
    return { kind: "value", v: 0 };
  const rel = pts.filter((p) => !p.zero);
  if (rel.length < 5) return null;
  const div = divergence(f, base, s, rel);
  if (div) return div;

  const tail = rel.slice(-5);
  if (tail.some((p) => !Number.isFinite(p.v))) return null;
  const ref = tail[4]!.v;
  const spread = Math.max(...tail.map((p) => Math.abs(p.v - ref)));
  const globalMax = Math.max(
    ...rel.filter((p) => Number.isFinite(p.v)).map((p) => Math.abs(p.v)),
  );
  const small = (v: number) =>
    Math.abs(v) <= 1e-8 && Math.abs(v) <= 1e-10 * globalMax;
  let L: number;
  if (spread <= 1e-9 * Math.abs(ref)) L = ref;
  else if (tail.every((p) => small(p.v))) L = 0;
  else return null;
  // Jitter at non-power-of-ten offsets guards against sampling resonances (sin(pi/x) etc.).
  const jit = spreadE(tail[0]!.e, tail[4]!.e, 6)
    .map((e) => sample(f, base, s, e))
    .filter((p): p is Pt => p !== null && (L === 0 || !p.zero));
  if (jit.length < 4) return null;
  const ok = (v: number) =>
    L === 0 ? v === 0 || small(v) : Math.abs(v - L) <= 1e-8 * Math.abs(L);
  return jit.every((p) => ok(p.v)) ? { kind: "value", v: L } : null;
}

type Combined = { lim: Lim } | { differ: [Lim, Lim] } | null;

function combine(a: Lim, b: Lim): Combined {
  if (a.kind === "inf" && b.kind === "inf")
    return a.sign === b.sign ? { lim: a } : { differ: [a, b] };
  if (a.kind === "value" && b.kind === "value") {
    const c = compare(a.v, b.v, 1e-9);
    if (c === null) return null;
    return c ? { lim: a } : { differ: [a, b] };
  }
  return { differ: [a, b] };
}

function judgeLimit(
  c: { lim: Lim } | { differ: [Lim, Lim] },
  ans: Exclude<Ans, null>,
): boolean | null {
  if ("differ" in c) {
    const [a, b] = c.differ;
    if (ans.t === "none") return true;
    if (ans.t === "inf" && ans.sign === 0)
      return a.kind === "inf" && b.kind === "inf";
    return false;
  }
  const L = c.lim;
  if (ans.t === "none") return L.kind === "inf";
  if (ans.t === "inf")
    return L.kind === "inf" && (ans.sign === 0 || ans.sign === L.sign);
  return L.kind === "value" ? compare(L.v, ans.v, 1e-8) : false;
}

const limText = (l: Lim) =>
  l.kind === "inf" ? (l.sign > 0 ? "+∞" : "−∞") : fmt(l.v);

function checkLimit(
  c: Extract<Check, { kind: "limit" }>,
  v: string,
  f: Expr,
): CheckResult {
  const at = special(c.at);
  if (at && at.t !== "inf") return unknown("极限点无法解析", f.tex);
  const atTex = !at
    ? compile(c.at, null).tex
    : at.sign === 0
      ? "\\infty"
      : at.sign > 0
        ? "+\\infty"
        : "-\\infty";
  const side = !at && c.side ? `^{${c.side}}` : "";
  const tex = `\\lim_{${v}\\to ${atTex}${side}}${f.tex}`;
  const ans = answer(c.answer);
  if (!ans) return unknown("答案无法解析", tex);

  let base: [Big, Big] | null = null;
  if (!at) {
    const e = compile(c.at, null);
    const a = fin(e.b1()),
      b = fin(e.b2());
    if (!a || !b) return unknown("极限点无法解析", tex);
    base = [a, b];
  }
  // [left/−∞ side, right/+∞ side]
  const signs: number[] = at
    ? at.sign === 0
      ? [-1, 1]
      : [at.sign]
    : c.side
      ? [c.side === "+" ? 1 : -1]
      : [-1, 1];
  const sides = signs.map((s) => sideLimit(f, base, s));
  const label = at ? ["x→−∞", "x→+∞"] : ["左", "右"];
  const where = `${v}→${at ? (at.sign === 0 ? "∞" : at.sign > 0 ? "+∞" : "−∞") : c.at}${side ? c.side : ""}`;
  if (sides.some((r) => r === null)) {
    const partial =
      sides.length === 2
        ? sides.map((r, i) => `${label[i]} ${r ? limText(r) : "?"}`).join("，")
        : null;
    return {
      status: "unknown",
      computed: partial,
      detail: `在 ${where} 附近数值计算未能确定极限（可能振荡或收敛太慢）`,
      tex,
    };
  }
  const [l0, l1] = sides as Lim[];
  const comb: Combined = l1 ? combine(l0!, l1) : { lim: l0! };
  if (!comb) return unknown("左右两侧数值接近但不能确定是否相等", tex);
  const computed =
    "lim" in comb
      ? limText(comb.lim)
      : `${label[0]} ${limText(l0!)}，${label[1]} ${limText(l1!)}`;
  let verdict = judgeLimit(comb, ans);
  // Sampling can step over the zeros of sin/cos factors (e^x·sin²x looks like +∞),
  // so a claimed infinite limit at infinity with a periodic factor is not confirmed.
  if (
    verdict &&
    at &&
    ans.t === "inf" &&
    /(?<![a-z])(sin|cos|tan|cot|sec|csc)(?!h)/i.test(c.expr)
  )
    verdict = null;
  const head = `在 ${where} 附近高精度计算，函数${"lim" in comb ? `值趋于 ${computed}` : `的单侧极限为${computed}`}`;
  if (verdict === null)
    return {
      status: "unknown",
      computed,
      detail: `${head}，与答案 ${c.answer} 的关系无法确定`,
      tex,
    };
  return {
    status: verdict ? "pass" : "fail",
    computed,
    detail: verdict
      ? `${head}，与答案一致`
      : `${head}，与答案 ${c.answer} 不一致`,
    tex,
  };
}

// ---------- worked limits  ----------

// The value of a limit, for checking the steps of a worked solution: one value,
// or two sides that differ. null = the numerics are not conclusive.
export type LimitValue = { lim: Lim } | { differ: [Lim, Lim] };

export function limitValue(
  expr: string,
  at: string,
  side?: "+" | "-",
  v = "x",
): LimitValue | null {
  try {
    if (!VARS.has(v)) return null;
    const f = compile(expr, v);
    const inf = special(at);
    if (inf && inf.t !== "inf") return null;
    let base: [Big, Big] | null = null;
    if (!inf) {
      const e = compile(at, null);
      const a = fin(e.b1()),
        b = fin(e.b2());
      if (!a || !b) return null;
      base = [a, b];
    }
    const signs = inf
      ? inf.sign === 0
        ? [-1, 1]
        : [inf.sign]
      : side
        ? [side === "+" ? 1 : -1]
        : [-1, 1];
    const sides = signs.map((s) => sideLimit(f, base, s));
    if (sides.some((r) => r === null)) return null;
    const [l0, l1] = sides as Lim[];
    return l1 ? combine(l0!, l1) : { lim: l0! };
  } catch {
    return null;
  }
}

// true = the same limit, false = clearly different, null = cannot tell.
export function sameLimit(a: LimitValue, b: LimitValue): boolean | null {
  if ("differ" in a && "differ" in b)
    return sameLimit({ lim: a.differ[0] }, { lim: b.differ[0] }) &&
      sameLimit({ lim: a.differ[1] }, { lim: b.differ[1] })
      ? true
      : null;
  if ("differ" in a || "differ" in b) {
    const one = ("differ" in a ? b : a) as { lim: Lim };
    return one.lim.kind === "value" ? false : null;
  }
  if (a.lim.kind === "value" && b.lim.kind === "value")
    return compare(a.lim.v, b.lim.v, 1e-8);
  if (a.lim.kind === "inf" && b.lim.kind === "inf")
    return a.lim.sign === b.lim.sign;
  return false;
}

// A number (or ±∞, 不存在) written as the value of a limit; null = not a number.
export function sameAsLimit(l: LimitValue, text: string): boolean | null {
  const ans = answer(text);
  return ans ? judgeLimit(l, ans) : null;
}

export const limitValueText = (l: LimitValue) =>
  "lim" in l
    ? limText(l.lim)
    : `不存在（两侧分别趋于 ${limText(l.differ[0])} 和 ${limText(l.differ[1])}）`;

// A definite integral worked out numerically; null = bounds or integrand
// unreadable, or the integral does not converge.
export function definiteValue(
  expr: string,
  from: string,
  to: string,
  v = "x",
): string | null {
  try {
    if (!VARS.has(v)) return null;
    const a = bound(from),
      b = bound(to);
    if (a === null || b === null) return null;
    const I = integrate(compile(expr, v).num, a, b);
    return I === null ? null : fmt(I);
  } catch {
    return null;
  }
}

// ---------- worked derivatives, L'Hôpital  ----------

// Is g the derivative of f, at the sample points? The first point that differs
// is kept for the explanation. null = unreadable, or not conclusive.
export function derivativeIs(
  f: string,
  g: string,
  v = "x",
): { same: true } | { same: false; x: string; want: string; got: string } | null {
  try {
    if (!VARS.has(v)) return null;
    const F = compile(f, v),
      G = compile(g, v);
    const { cmps, domainMiss } = compareAt(
      (x) => deriv(F.b1, x, 1),
      (x) => fin(G.b1(x)),
      () => true,
    );
    const bad = cmps.find((p) => p.ok === false);
    if (bad) return { same: false, x: bad.x, want: bad.want, got: bad.got };
    const good = cmps.filter((p) => p.ok === true).length;
    return !domainMiss && good >= 4 && good === cmps.length
      ? { same: true }
      : null;
  } catch {
    return null;
  }
}

// The derivative worked out symbolically, kept only when it agrees with the
// numeric one at the sample points.
export function derivativeText(expr: string, v = "x"): string | null {
  try {
    if (!VARS.has(v)) return null;
    const node = N.parse(toMathjs(expr));
    checkNode(node, v);
    const text = N.derivative(node, v).toString();
    return derivativeIs(expr, text, v)?.same === true ? text : null;
  } catch {
    return null;
  }
}

// An expression as TeX, for showing what the program checked against.
export function texOf(expr: string, v = "x"): string | null {
  try {
    return VARS.has(v) ? compile(expr, v).tex : null;
  } catch {
    return null;
  }
}

// "N/D" at the top level: its numerator and denominator.
function ratio(text: string): [string, string] | null {
  try {
    let node = N.parse(toMathjs(text));
    while (node.type === "ParenthesisNode")
      node = (node as MathNode & { content: MathNode }).content;
    const op = node as MathNode & { fn?: string; args?: MathNode[] };
    if (node.type !== "OperatorNode" || op.fn !== "divide" || !op.args)
      return null;
    return [op.args[0]!.toString(), op.args[1]!.toString()];
  } catch {
    return null;
  }
}

// next = N'/D' of prev = N/D: one step of L'Hôpital, told by the denominator
// (a numerator differentiated wrongly is still an attempt). legal = prev is 0/0
// or ∞/∞ at the point. null = not L'Hôpital, or the numerics cannot tell.
export function lhopital(
  prev: string,
  next: string,
  at: string,
  side?: "+" | "-",
  v = "x",
): { legal: boolean; numerator: boolean; num: string; den: string } | null {
  const a = ratio(prev),
    b = ratio(next);
  if (!a || !b || derivativeIs(a[1], b[1], v)?.same !== true) return null;
  const numerator = derivativeIs(a[0], b[0], v);
  if (!numerator) return null;
  const n = limitValue(a[0], at, side, v),
    d = limitValue(a[1], at, side, v);
  if (!n || !d) return null;
  const zero = (l: LimitValue) =>
    "lim" in l && l.lim.kind === "value" && l.lim.v === 0;
  const inf = (l: LimitValue) =>
    "lim" in l ? l.lim.kind === "inf" : l.differ.every((s) => s.kind === "inf");
  return {
    legal: (zero(n) && zero(d)) || (inf(n) && inf(d)),
    numerator: numerator.same,
    num: limitValueText(n),
    den: limitValueText(d),
  };
}

// ---------- derivatives & sampling ----------

const SAMPLES = [
  "-2.71",
  "-2.23",
  "-1.83",
  "-1.37",
  "-0.83",
  "-0.57",
  "-0.29",
  "0.13",
  "0.37",
  "0.61",
  "0.79",
  "0.93",
  "1.31",
  "1.77",
  "2.43",
  "2.89",
];

function deriv(f: BigFn, x: Big, order: 1 | 2): Big | null {
  const est = (hs: string) => {
    const h = B1.bignumber(hs) as Big;
    const p = fin(f(x.plus(h))),
      m = fin(f(x.minus(h)));
    if (!p || !m) return null;
    if (order === 1) return p.minus(m).div(h.times(2));
    const c = fin(f(x));
    return c ? p.minus(c.times(2)).plus(m).div(h.times(h)) : null;
  };
  const a = est(order === 1 ? "1e-15" : "1e-12");
  const b = est(order === 1 ? "1e-19" : "1e-15");
  if (!a || !b) return null;
  // Absolute floor covers derivatives that are exactly 0 (truncation error is ~h²).
  const floor =
    (order === 1 ? 1e-25 : 1e-20) *
    Math.max(1, Math.abs(toNum(fin(f(x)) ?? a)));
  return bigClose(a, b, 1e-10) || toNum(a.minus(b).abs()) <= floor ? b : null;
}

type Cmp = { x: string; ok: boolean | null; got: string; want: string };

// Compare g with the reference r (both callbacks return null when undefined) at the sample points.
function compareAt(
  ref: (x: Big) => Big | null,
  given: (x: Big) => Big | null,
  defined: (x: Big) => boolean,
): { cmps: Cmp[]; domainMiss: string | null } {
  const cmps: Cmp[] = [];
  let domainMiss: string | null = null;
  for (const xs of SAMPLES) {
    const x = B1.bignumber(xs) as Big;
    const r = ref(x);
    if (!r) continue;
    const g = given(x);
    if (!g) {
      if (defined(x)) domainMiss ??= xs;
      continue;
    }
    const d = toNum(r.minus(g).abs()),
      m = Math.max(1, Math.abs(toNum(r)));
    cmps.push({
      x: xs,
      ok: d <= 1e-8 * m ? true : d > 1e-5 * m ? false : null,
      got: fmt(toNum(g)),
      want: fmt(toNum(r)),
    });
  }
  return { cmps, domainMiss };
}

function checkDerivative(
  c: Extract<Check, { kind: "derivative" }>,
  v: string,
  f: Expr,
): CheckResult {
  const order = c.order ?? 1;
  const tex =
    order === 1
      ? `\\frac{d}{d${v}}\\left(${f.tex}\\right)`
      : `\\frac{d^{2}}{d${v}^{2}}\\left(${f.tex}\\right)`;
  const g = compile(c.answer, v);
  const { cmps, domainMiss } = compareAt(
    (x) => deriv(f.b1, x, order),
    (x) => fin(g.b1(x)),
    () => true,
  );
  const bad = cmps.find((p) => p.ok === false);
  const mark = order === 1 ? "f'" : "f''";
  if (bad) {
    const computed = `${mark}(${bad.x})≈${bad.want}`;
    return {
      status: "fail",
      computed,
      detail: `在 ${v}=${bad.x} 处数值求导得 ${bad.want}，答案给出 ${bad.got}`,
      tex,
    };
  }
  if (domainMiss)
    return {
      status: "fail",
      computed: null,
      detail: `在 ${v}=${domainMiss} 处导数存在，但答案在该点无定义`,
      tex,
    };
  const good = cmps.filter((p) => p.ok === true).length;
  if (good >= 4 && good === cmps.length)
    return {
      status: "pass",
      computed: `${good} 个点吻合`,
      detail: `在 ${good} 个采样点用高精度差分求导，与答案一致`,
      tex,
    };
  return unknown(`可比较的采样点不足（${good} 个），无法确定`, tex);
}

function checkAntiderivative(
  c: Extract<Check, { kind: "antiderivative" }>,
  v: string,
  f: Expr,
): CheckResult {
  const tex = `\\int ${f.tex}\\,d${v}`;
  const F = compile(stripC(c.answer), v);
  // Reference is f; "given" is F'. A point where f is defined but F is not is a domain error.
  const { cmps } = compareAt(
    (x) => fin(f.b1(x)),
    (x) => deriv(F.b1, x, 1),
    () => true,
  );
  for (const xs of SAMPLES) {
    const x = B1.bignumber(xs) as Big;
    if (fin(f.b1(x)) && !fin(F.b1(x)))
      return {
        status: "fail",
        computed: null,
        detail: `被积函数在 ${v}=${xs} 处有定义，但答案在该点无定义（定义域不完整，例如应写 ln|${v}| 而不是 ln ${v}）`,
        tex,
      };
  }
  const bad = cmps.find((p) => p.ok === false);
  if (bad)
    return {
      status: "fail",
      computed: `F'(${bad.x})≈${bad.got}`,
      detail: `对答案求导，在 ${v}=${bad.x} 处得 ${bad.got}，而被积函数值为 ${bad.want}`,
      tex,
    };
  const good = cmps.filter((p) => p.ok === true).length;
  if (good >= 4 && good === cmps.length)
    return {
      status: "pass",
      computed: `${good} 个点吻合`,
      detail: `答案求导后在 ${good} 个采样点与被积函数一致`,
      tex,
    };
  return unknown(`可比较的采样点不足（${good} 个），无法确定`, tex);
}

// ---------- definite integrals ----------

// Tanh-sinh on (-1,1). g receives the node side (±1) and its distance to that endpoint,
// so endpoint singularities are evaluated without cancellation.
function tanhSinh(g: (side: number, dist: number) => number): number | null {
  let sum = 0,
    abs = 0,
    prev = NaN,
    prevAbs = NaN;
  for (let level = 0; level <= 7; level++) {
    const h = 2 ** -level;
    for (let t = -4; t <= 4 + 1e-12; t += h) {
      const k = Math.round(t / h);
      if (level > 0 && k % 2 === 0) continue;
      const u = (Math.PI / 2) * Math.sinh(t);
      const ch = Math.cosh(u);
      const w = ((Math.PI / 2) * Math.cosh(t)) / (ch * ch);
      if (!(w > 0)) continue;
      const y = g(t < 0 ? -1 : 1, Math.exp(-Math.abs(u)) / ch);
      if (!Number.isFinite(y)) return null;
      sum += w * y;
      abs += w * Math.abs(y);
    }
    const I = sum * h,
      A = abs * h;
    if (
      level >= 3 &&
      Math.abs(I - prev) <= 1e-10 * A &&
      Math.abs(A - prevAbs) <= 1e-10 * A
    )
      return I;
    prev = I;
    prevAbs = A;
  }
  return null;
}

function bound(s: string): number | null {
  const sp = special(s);
  if (sp) return sp.t === "inf" ? (sp.sign < 0 ? -Infinity : Infinity) : null;
  const c = constant(s);
  return c ? toNum(c) : null;
}

function integrate(
  f: (x: number) => number,
  a: number,
  b: number,
): number | null {
  if (a === b) return 0;
  if (a > b) {
    const r = integrate(f, b, a);
    return r === null ? null : -r;
  }
  if (a === -Infinity && b === Infinity) {
    const l = integrate(f, -Infinity, 0),
      r = integrate(f, 0, Infinity);
    return l === null || r === null ? null : l + r;
  }
  if (b === Infinity || a === -Infinity) {
    const o = b === Infinity ? a : b,
      dir = b === Infinity ? 1 : -1;
    // x = o ± τ/(1-τ), τ ∈ (0,1)
    return tanhSinh((side, d) => {
      const tau = side < 0 ? d / 2 : 1 - d / 2,
        rest = side < 0 ? 1 - d / 2 : d / 2;
      const y = f(o + (dir * tau) / rest);
      return y === 0 ? 0 : (y * 0.5) / (rest * rest);
    });
  }
  const half = (b - a) / 2;
  return tanhSinh((side, d) => {
    const x = side < 0 ? a + half * d : b - half * d;
    return x <= a || x >= b ? 0 : half * f(x);
  });
}

function checkDefinite(
  c: Extract<Check, { kind: "definite" }>,
  v: string,
  f: Expr,
): CheckResult {
  const bt = (s: string) => {
    const sp = special(s);
    return sp?.t === "inf"
      ? sp.sign < 0
        ? "-\\infty"
        : "+\\infty"
      : compile(s, null).tex;
  };
  const tex = `\\int_{${bt(c.from)}}^{${bt(c.to)}}${f.tex}\\,d${v}`;
  const a = bound(c.from),
    b = bound(c.to),
    ans = answer(c.answer);
  if (a === null || b === null) return unknown("积分上下限无法解析", tex);
  if (ans?.t !== "num") return unknown("答案不是一个确定的数，未做判定", tex);
  const I = integrate(f.num, a, b);
  if (I === null)
    return unknown("数值积分不收敛（可能是发散积分或振荡太强）", tex);
  const verdict = compare(I, ans.v, 1e-7);
  const computed = fmt(I);
  if (verdict === null)
    return {
      status: "unknown",
      computed,
      detail: `数值积分得 ${computed}，与答案 ${c.answer} 接近但不能确定相等`,
      tex,
    };
  return {
    status: verdict ? "pass" : "fail",
    computed,
    detail: verdict
      ? `数值积分得 ${computed}，与答案一致`
      : `数值积分得 ${computed}，与答案 ${c.answer} 不一致`,
    tex,
  };
}

// ---------- value ----------

function checkValue(
  c: Extract<Check, { kind: "value" }>,
  f: Expr,
): CheckResult {
  const a = fin(f.b1()),
    b = fin(f.b2()),
    ans = answer(c.answer);
  if (!a || !b || !bigClose(a, b, 1e-20))
    return unknown("式子的值无法可靠计算", f.tex);
  if (ans?.t !== "num") return unknown("答案不是一个确定的数，未做判定", f.tex);
  const computed = fmt(toNum(b));
  const verdict = compare(toNum(b), ans.v, 1e-9);
  if (verdict === null)
    return {
      status: "unknown",
      computed,
      detail: `计算得 ${computed}，与答案接近但不能确定相等`,
      tex: f.tex,
    };
  return {
    status: verdict ? "pass" : "fail",
    computed,
    detail: verdict
      ? `高精度计算得 ${computed}，与答案一致`
      : `高精度计算得 ${computed}，与答案 ${c.answer} 不一致`,
    tex: f.tex,
  };
}

// ---------- roots ----------

function bisect(f: (x: number) => number, lo: number, hi: number): number {
  let flo = f(lo);
  for (let i = 0; i < 80 && hi - lo > 1e-15 * Math.max(1, Math.abs(lo)); i++) {
    const mid = (lo + hi) / 2,
      fm = f(mid);
    if (!Number.isFinite(fm)) return mid;
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
    } else hi = mid;
  }
  return (lo + hi) / 2;
}

function minAbs(f: (x: number) => number, lo: number, hi: number): number {
  for (let i = 0; i < 100; i++) {
    const m1 = lo + (hi - lo) / 3,
      m2 = hi - (hi - lo) / 3;
    if (Math.abs(f(m1)) < Math.abs(f(m2))) hi = m2;
    else lo = m1;
  }
  return (lo + hi) / 2;
}

// Is r a root? true / false / null (undecided). Decimal literals may be off by their rounding.
function isRoot(f: Expr, r: Big, u: number): boolean | null {
  const at = (d: number) => fin(f.b1(r.plus(d)));
  const fr = at(0);
  if (!fr) return u > 0 ? null : false;
  const scales = [0.1, -0.1, 0.01, -0.01]
    .map(at)
    .filter((y): y is Big => y !== null)
    .map((y) => Math.abs(toNum(y)));
  const scale = Math.max(...scales, Math.abs(toNum(fr)));
  if (!(scale > 0)) return null;
  const r0 = Math.abs(toNum(fr)) / scale;
  if (r0 <= 1e-12) return true;
  if (u > 0) {
    const lo = at(-u * 1.0001),
      hi = at(u * 1.0001);
    if (lo && hi && (lo.isNeg() !== hi.isNeg() || lo.isZero() || hi.isZero()))
      return true;
  }
  return r0 > 1e-6 ? false : null;
}

function checkRoots(
  c: Extract<Check, { kind: "roots" }>,
  v: string,
): CheckResult {
  const parts = c.expr.split("=");
  if (parts.length > 2) return unknown("式子无法解析", "");
  const lhs = compile(parts[0]!, v);
  const f =
    parts.length === 2
      ? compile(`(${toMathjs(parts[0]!)})-(${toMathjs(parts[1]!)})`, v)
      : lhs;
  const tex =
    parts.length === 2
      ? `${lhs.tex}=${compile(parts[1]!, v).tex}`
      : `${f.tex}=0`;
  const claimed: { text: string; x: number; u: number }[] = [];
  for (const r of c.roots) {
    const b = constant(r);
    if (!b) return unknown(`根 ${r} 无法解析`, tex);
    const u = halfUnit(r);
    const ok = isRoot(f, b, u);
    if (ok === false) {
      const y = fin(f.b1(b));
      return {
        status: "fail",
        computed: `f(${r})≈${y ? fmt(toNum(y)) : "无定义"}`,
        detail: `把 ${v}=${r} 代入，式子不为 0`,
        tex,
      };
    }
    if (ok === null) return unknown(`无法确定 ${v}=${r} 是否为根`, tex);
    claimed.push({ text: r, x: toNum(b), u });
  }
  const list = claimed.map((r) => fmt(r.x)).join(", ");
  if (!c.interval)
    return {
      status: "pass",
      computed: `${v}≈${list}`,
      detail: "每个给出的根代入后式子都为 0",
      tex,
    };

  const a = bound(c.interval[0]),
    b = bound(c.interval[1]);
  if (
    a === null ||
    b === null ||
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    a >= b
  )
    return unknown("区间无法解析", tex);
  const outside = claimed.find((r) => r.x < a - r.u || r.x > b + r.u);
  if (outside)
    return {
      status: "fail",
      computed: null,
      detail: `根 ${outside.text} 不在区间 [${c.interval[0]}, ${c.interval[1]}] 内`,
      tex,
    };
  const n = 4000,
    g = f.num;
  const xs = Array.from({ length: n + 1 }, (_, i) =>
    i === n ? b : a + ((b - a) * i) / n,
  );
  const ys = xs.map(g);
  const found: number[] = [];
  let unsure = false;
  for (let i = 0; i <= n; i++) {
    const y = ys[i]!;
    if (!Number.isFinite(y)) continue;
    if (y === 0) {
      found.push(xs[i]!);
      continue;
    }
    const yn = ys[i + 1];
    if (
      yn !== undefined &&
      Number.isFinite(yn) &&
      yn !== 0 &&
      Math.sign(yn) !== Math.sign(y)
    ) {
      const r = bisect(g, xs[i]!, xs[i + 1]!);
      if (Math.abs(g(r)) <= 1e-8 * Math.max(Math.abs(y), Math.abs(yn)))
        found.push(r);
      continue;
    }
    // Touching roots: local minimum of |f| without a sign change.
    const yp = ys[i - 1];
    if (
      yp !== undefined &&
      yn !== undefined &&
      Number.isFinite(yp) &&
      Number.isFinite(yn)
    ) {
      if (Math.abs(y) < Math.abs(yp) && Math.abs(y) <= Math.abs(yn)) {
        const m = minAbs(g, xs[i - 1]!, xs[i + 1]!);
        const scale = Math.max(
          ...ys
            .slice(Math.max(0, i - 50), i + 51)
            .filter(Number.isFinite)
            .map(Math.abs),
        );
        const ratio = Math.abs(g(m)) / scale;
        if (ratio <= 1e-12) found.push(m);
        else if (ratio <= 1e-7) unsure = true;
      }
    }
  }
  const matched = (x: number) =>
    claimed.some(
      (r) => Math.abs(r.x - x) <= r.u + 1e-6 * Math.max(1, Math.abs(x)),
    );
  const missing = found.find((x) => !matched(x));
  if (missing !== undefined)
    return {
      status: "fail",
      computed: `${v}≈${[...new Set(found.map(fmt))].join(", ")}`,
      detail: `区间内还有根 ${v}≈${fmt(missing)} 没有列出`,
      tex,
    };
  if (unsure) return unknown("区间内可能还有重根，无法确定是否列全", tex);
  return {
    status: "pass",
    computed: `${v}≈${list}`,
    detail: `给出的根都成立，且在区间内扫描未发现其他根`,
    tex,
  };
}

// ---------- extremum & monotonicity ----------

function checkExtremum(
  c: Extract<Check, { kind: "extremum" }>,
  v: string,
  f: Expr,
): CheckResult {
  const tex = f.tex;
  const a = constant(c.at);
  if (!a) return unknown("极值点无法解析", tex);
  const u = halfUnit(c.at);
  const fa = fin(f.b1(a));
  if (!fa)
    return {
      status: "fail",
      computed: null,
      detail: `函数在 ${v}=${c.at} 处无定义`,
      tex,
    };
  const val = (d: number) => fin(f.b1(a.plus(d)));
  // Stationary (or a kink where the one-sided slopes change sign)?
  const d1 = deriv(f.b1, a, 1);
  const near = [0.1, -0.1]
    .map((d) => val(d))
    .filter((y): y is Big => y !== null);
  const S = Math.max(
    1e-300,
    ...near.map((y) => Math.abs(toNum(y.minus(fa))) / 0.1),
  );
  let stationary = d1 !== null && Math.abs(toNum(d1)) <= 1e-9 * S;
  if (!stationary && u > 0) {
    const lo = deriv(f.b1, a.minus(u), 1),
      hi = deriv(f.b1, a.plus(u), 1);
    stationary =
      !!lo && !!hi && (lo.isNeg() !== hi.isNeg() || lo.isZero() || hi.isZero());
  }
  if (!stationary) {
    const h = 1e-20;
    const r = val(h),
      l = val(-h);
    const kink =
      r &&
      l &&
      r.minus(fa).isNeg() === l.minus(fa).isNeg() &&
      !r.minus(fa).isZero();
    if (!kink) {
      const slope = d1 ? fmt(toNum(d1)) : "?";
      return {
        status: "fail",
        computed: `f'(${c.at})≈${slope}`,
        detail: `在 ${v}=${c.at} 处导数不为 0，也不是尖点，不是极值点`,
        tex,
      };
    }
  }
  const ds = u > 0 ? [20 * u, 100 * u] : [1e-3, 1e-4, 1e-5];
  const signs = ds.flatMap((d) =>
    [d, -d].map((x) => {
      const y = val(x);
      return y ? Math.sign(toNum(y.minus(fa))) : NaN;
    }),
  );
  const want = c.type === "max" ? -1 : 1;
  const typeName = c.type === "max" ? "极大值" : "极小值";
  if (signs.every((s) => s === -want))
    return {
      status: "fail",
      computed: `f(${c.at})≈${fmt(toNum(fa))}`,
      detail: `${v}=${c.at} 附近函数值都比它${want > 0 ? "小" : "大"}，是${want > 0 ? "极大值" : "极小值"}点，不是${typeName}点`,
      tex,
    };
  if (ds.every((_, i) => signs[2 * i]! * signs[2 * i + 1]! === -1))
    return {
      status: "fail",
      computed: `f(${c.at})≈${fmt(toNum(fa))}`,
      detail: `${v}=${c.at} 两侧函数值一边大一边小，不是极值点`,
      tex,
    };
  if (!signs.every((s) => s === want))
    return unknown(`无法确定 ${v}=${c.at} 是否为${typeName}点`, tex);
  const computed = `f(${c.at})≈${fmt(toNum(fa))}`;
  if (c.value !== undefined) {
    const ans = answer(c.value);
    if (ans?.t !== "num") return unknown("极值无法解析", tex);
    let verdict = compare(toNum(fa), ans.v, 1e-9);
    const hv = halfUnit(c.value);
    if (
      verdict !== true &&
      hv > 0 &&
      Math.abs(toNum(fa) - ans.v) <= hv * 1.0001
    )
      verdict = null;
    if (verdict === false)
      return {
        status: "fail",
        computed,
        detail: `${v}=${c.at} 是${typeName}点，但函数值为 ${fmt(toNum(fa))}，不是 ${c.value}`,
        tex,
      };
    if (verdict === null)
      return {
        status: "unknown",
        computed,
        detail: `${v}=${c.at} 是${typeName}点，极值与答案接近但不能确定相等`,
        tex,
      };
  }
  return {
    status: "pass",
    computed,
    detail: `${v}=${c.at} 处导数为 0（或为尖点），附近函数值都比它${want < 0 ? "小" : "大"}，确为${typeName}点`,
    tex,
  };
}

function checkMonotonic(
  c: Extract<Check, { kind: "monotonic" }>,
  v: string,
  f: Expr,
): CheckResult {
  const tex = f.tex;
  const a = bound(c.from),
    b = bound(c.to);
  if (a === null || b === null || !(a < b)) return unknown("区间无法解析", tex);
  const M = 240;
  const xs: number[] = [];
  for (let i = 1; i < M; i++) {
    const t = i / M;
    if (Number.isFinite(a) && Number.isFinite(b)) xs.push(a + (b - a) * t);
    else if (Number.isFinite(a)) xs.push(a + Math.expm1(t * Math.log(101)));
    else if (Number.isFinite(b))
      xs.push(b - Math.expm1((1 - t) * Math.log(101)));
    else xs.push(Math.sinh((2 * t - 1) * Math.asinh(100)));
  }
  const g = f.num;
  const ys = xs.map(g);
  if (ys.some((y) => !Number.isFinite(y)))
    return unknown("区间内部分点函数无定义，无法判断", tex);
  const ds = xs.map((x) => {
    const h = 1e-6 * Math.max(1, Math.abs(x));
    return (g(x + h) - g(x - h)) / (2 * h);
  });
  if (ds.some((d) => !Number.isFinite(d)))
    return unknown("区间内部分点导数无定义或溢出，无法判断", tex);
  // Local derivative scale, so wide ranges don't swamp small slopes.
  const scale = xs.map(
    (x) => Math.max(1, Math.abs(g(x))) / Math.max(1, Math.abs(x)),
  );
  const dir = c.direction === "inc" ? 1 : -1;
  const lo = Math.min(...ds),
    hi = Math.max(...ds);
  const computed = `f'∈[${fmt(lo)}, ${fmt(hi)}]`;
  const wrong = xs.findIndex((_, i) => ds[i]! * dir < -1e-5 * scale[i]!);
  const word = dir > 0 ? "单调增加" : "单调减少";
  if (wrong >= 0)
    return {
      status: "fail",
      computed,
      detail: `在 ${v}≈${fmt(xs[wrong]!)} 处导数为 ${fmt(ds[wrong]!)}，函数不是${word}`,
      tex,
    };
  // Function values must also move the right way between samples (catches jumps).
  const back = ys.findIndex((y, i) => i > 0 && (y - ys[i - 1]!) * dir < 0);
  if (back > 0)
    return {
      status: "fail",
      computed,
      detail: `函数值从 ${v}≈${fmt(xs[back - 1]!)} 到 ${fmt(xs[back]!)} 不是${word}`,
      tex,
    };
  const zero = ds.map((d, i) => d * dir <= 1e-8 * scale[i]!);
  if (zero.some((z, i) => z && (zero[i + 1] || zero[i - 1])))
    return unknown(`导数在区间内有一段接近 0，无法确定是否严格${word}`, tex);
  return {
    status: "pass",
    computed,
    detail: `在区间内 ${xs.length} 个点数值求导，导数符号都符合${word}`,
    tex,
  };
}

// ---------- entry points ----------

const str = (max: number) => z.string().min(1).max(max);
const varName = z.enum(["x", "t", "n", "u"]).optional();
const checkSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("limit"),
    expr: str(300),
    var: varName,
    at: str(120),
    side: z.enum(["+", "-"]).optional(),
    answer: str(120),
  }),
  z.object({
    kind: z.literal("derivative"),
    expr: str(300),
    var: varName,
    order: z.union([z.literal(1), z.literal(2)]).optional(),
    answer: str(120),
  }),
  z.object({
    kind: z.literal("antiderivative"),
    expr: str(300),
    var: varName,
    answer: str(120),
  }),
  z.object({
    kind: z.literal("definite"),
    expr: str(300),
    var: varName,
    from: str(120),
    to: str(120),
    answer: str(120),
  }),
  z.object({ kind: z.literal("value"), expr: str(300), answer: str(120) }),
  z.object({
    kind: z.literal("roots"),
    expr: str(300),
    var: varName,
    roots: z.array(str(120)).min(1).max(20),
    interval: z.tuple([str(120), str(120)]).optional(),
  }),
  z.object({
    kind: z.literal("extremum"),
    expr: str(300),
    var: varName,
    at: str(120),
    type: z.enum(["max", "min"]),
    value: str(120).optional(),
  }),
  z.object({
    kind: z.literal("monotonic"),
    expr: str(300),
    var: varName,
    from: str(120),
    to: str(120),
    direction: z.enum(["inc", "dec"]),
  }),
]);

export function parseCheck(input: unknown): Check | null {
  const r = checkSchema.safeParse(input);
  return r.success ? r.data : null;
}

function unknown(
  detail: string,
  tex: string,
  computed: string | null = null,
): CheckResult {
  return { status: "unknown", computed, detail, tex };
}

export function runCheck(check: Check): CheckResult {
  try {
    const v = "var" in check && check.var ? check.var : "x";
    if (!VARS.has(v)) return unknown("式子无法解析", "");
    if (check.kind === "roots") return checkRoots(check, v);
    const f = compile(
      check.kind === "antiderivative" ? stripC(check.expr) : check.expr,
      check.kind === "value" ? null : v,
    );
    switch (check.kind) {
      case "limit":
        return checkLimit(check, v, f);
      case "derivative":
        return checkDerivative(check, v, f);
      case "antiderivative":
        return checkAntiderivative(check, v, f);
      case "definite":
        return checkDefinite(check, v, f);
      case "value":
        return checkValue(check, f);
      case "extremum":
        return checkExtremum(check, v, f);
      case "monotonic":
        return checkMonotonic(check, v, f);
      default:
        return unknown("不支持的检查类型", "");
    }
  } catch (err) {
    return unknown(
      err instanceof ParseError ? "式子无法解析" : "计算出错，未能判定",
      "",
    );
  }
}

// ---------- student-answer comparison ----------

export function sameConstant(a: string, b: string): boolean | null {
  try {
    const x = constant(a),
      y = constant(b);
    if (!x || !y) return null;
    return bigClose(x, y, 1e-12);
  } catch {
    return null;
  }
}

// Point-wise comparison; a point where exactly one side is defined means different domains.
function samePoints(
  fa: BigFn,
  fb: BigFn,
  pick: (fn: BigFn, x: Big) => Big | null,
): boolean | null {
  let n = 0;
  for (const xs of SAMPLES) {
    const x = B1.bignumber(xs) as Big;
    const da = fin(fa(x)),
      db = fin(fb(x));
    if (!!da !== !!db) return false;
    if (!da) continue;
    const ya = pick(fa, x),
      yb = pick(fb, x);
    if (!ya || !yb) continue;
    if (!bigClose(ya, yb, 1e-8)) return false;
    n++;
  }
  return n >= 4 ? true : null;
}

export function sameFunction(a: string, b: string, v = "x"): boolean | null {
  try {
    if (!VARS.has(v)) return null;
    return samePoints(compile(a, v).b1, compile(b, v).b1, (fn, x) =>
      fin(fn(x)),
    );
  } catch {
    return null;
  }
}

// sameFunction on the reference's domain only: points where the reference is
// undefined are skipped, so ln|x| matches ln x when the answer lives on x > 0.
// A point where the reference is defined and the answer is not is still false.
// For solutions of initial-value problems; elsewhere domains must match.
export function sameFunctionWhereDefined(
  reference: string,
  answer: string,
  v = "x",
): boolean | null {
  try {
    if (!VARS.has(v)) return null;
    const fa = compile(reference, v).b1,
      fb = compile(answer, v).b1;
    let n = 0;
    for (const xs of SAMPLES) {
      const x = B1.bignumber(xs) as Big;
      const ya = fin(fa(x));
      if (!ya) continue;
      const yb = fin(fb(x));
      if (!yb || !bigClose(ya, yb, 1e-8)) return false;
      n++;
    }
    return n >= 4 ? true : null;
  } catch {
    return null;
  }
}

export function sameAntiderivative(
  a: string,
  b: string,
  v = "x",
): boolean | null {
  try {
    if (!VARS.has(v)) return null;
    return samePoints(
      compile(stripC(a), v).b1,
      compile(stripC(b), v).b1,
      (fn, x) => deriv(fn, x, 1),
    );
  } catch {
    return null;
  }
}
