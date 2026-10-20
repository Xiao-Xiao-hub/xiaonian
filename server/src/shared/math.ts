import { all, create, type MathNode } from "mathjs";
import { z } from "zod";

export class MathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MathError";
  }
}

// Hardened instance per https://mathjs.org/docs/expressions/security.html.
// Keep the original parser, then disable everything that can redefine or re-enter the engine.
const math = create(all!);
const parse = math.parse;
const disabled = [
  "import",
  "createUnit",
  "reviver",
  "evaluate",
  "parse",
  "simplify",
  "derivative",
  "resolve",
  "compile",
  "parser",
  "simplifyCore",
  "rationalize",
] as const;
math.import(
  Object.fromEntries(
    disabled.map((name) => [
      name,
      () => {
        throw new MathError(`函数 ${name} 已被禁用`);
      },
    ]),
  ),
  { override: true },
);

const MAX_EXPR_LENGTH = 200;
const CONSTANTS = new Set(["pi", "e"]);
const FUNCTIONS = new Set([
  "abs",
  "round",
  "floor",
  "ceil",
  "sqrt",
  "min",
  "max",
  "pow",
  "mod",
]);
const OPERATORS = new Set([
  "add",
  "subtract",
  "multiply",
  "divide",
  "unaryMinus",
  "unaryPlus",
  "pow",
  "mod",
  "equal",
  "unequal",
  "smaller",
  "smallerEq",
  "larger",
  "largerEq",
  "and",
  "or",
  "not",
]);
const COMPARISONS = new Set([
  "equal",
  "unequal",
  "smaller",
  "smallerEq",
  "larger",
  "largerEq",
]);
const LOGIC = new Set(["and", "or", "not"]);

// Default-deny AST walk: anything not explicitly allowed is rejected.
function checkNode(node: MathNode, names: ReadonlySet<string>): void {
  const n = node as MathNode & Record<string, unknown>;
  switch (node.type) {
    case "ConstantNode":
      if (typeof n.value !== "number")
        throw new MathError("表达式只能包含数字常量");
      return;
    case "SymbolNode": {
      const name = n.name as string;
      if (!names.has(name) && !CONSTANTS.has(name))
        throw new MathError(`未知变量：${name}`);
      return;
    }
    case "ParenthesisNode":
      return checkNode(n.content as MathNode, names);
    case "OperatorNode":
      if (!OPERATORS.has(n.fn as string))
        throw new MathError(`不允许的运算符：${String(n.op)}`);
      for (const arg of n.args as MathNode[]) checkNode(arg, names);
      return;
    case "RelationalNode":
      for (const c of n.conditionals as string[]) {
        if (!COMPARISONS.has(c)) throw new MathError("不允许的比较运算");
      }
      for (const p of n.params as MathNode[]) checkNode(p, names);
      return;
    case "FunctionNode": {
      const fn = n.fn as MathNode & { name?: string };
      if (fn.type !== "SymbolNode" || !fn.name || !FUNCTIONS.has(fn.name)) {
        throw new MathError(`不允许的函数：${fn.name ?? "?"}`);
      }
      for (const arg of n.args as MathNode[]) checkNode(arg, names);
      return;
    }
    default:
      throw new MathError(`表达式包含不允许的结构（${node.type}）`);
  }
}

type Compiled = (scope: Record<string, number>) => unknown;

// Top-level node must yield a boolean (comparison or logic), checked before evaluation.
function isCondition(node: MathNode): boolean {
  const n = node as MathNode & Record<string, unknown>;
  if (node.type === "ParenthesisNode")
    return isCondition(n.content as MathNode);
  if (node.type === "RelationalNode") return true;
  const fn = n.fn as string;
  return node.type === "OperatorNode" && (COMPARISONS.has(fn) || LOGIC.has(fn));
}

function compileChecked(
  expr: string,
  names: Iterable<string>,
  condition = false,
): Compiled {
  if (typeof expr !== "string" || !expr.trim())
    throw new MathError("表达式不能为空");
  if (expr.length > MAX_EXPR_LENGTH)
    throw new MathError(`表达式过长（最多 ${MAX_EXPR_LENGTH} 个字符）`);
  let node: MathNode;
  try {
    node = parse(expr);
  } catch (err) {
    throw new MathError(`表达式无法解析：${expr}`);
  }
  checkNode(node, new Set(names));
  if (condition && !isCondition(node))
    throw new MathError(`条件必须是比较或逻辑表达式：${expr}`);
  const code = node.compile();
  return (scope) => {
    try {
      return code.evaluate(new Map(Object.entries(scope)));
    } catch (err) {
      throw err instanceof MathError
        ? err
        : new MathError(`表达式计算失败：${expr}`);
    }
  };
}

function toNumber(value: unknown, expr: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MathError(`表达式结果不是有限实数：${expr}`);
  }
  return value;
}

function toBoolean(value: unknown, expr: string): boolean {
  if (typeof value !== "boolean")
    throw new MathError(`条件表达式结果不是真假值：${expr}`);
  return value;
}

export function evaluateNumber(
  expr: string,
  scope: Record<string, number>,
): number {
  return toNumber(compileChecked(expr, Object.keys(scope))(scope), expr);
}

export function evaluateCondition(
  expr: string,
  scope: Record<string, number>,
): boolean {
  return toBoolean(compileChecked(expr, Object.keys(scope), true)(scope), expr);
}

export function sameNumber(a: number, b: number): boolean {
  // Whole numbers compare exactly, so 1234567 and 1234568 stay different;
  // computed results carry float noise and are never exact integers.
  if (Number.isSafeInteger(a) && Number.isSafeInteger(b)) return a === b;
  return (
    Math.abs(a - b) <= Math.max(1e-9, 1e-6 * Math.max(Math.abs(a), Math.abs(b)))
  );
}

// Half-away-from-zero rounding that survives binary noise (1.005 → 1.01, -2.5 → -3).
function roundTo(n: number, decimals: number): number {
  const f = 10 ** decimals;
  const r =
    (Math.sign(n) * Math.round(Math.abs(n) * f * (1 + Number.EPSILON))) / f;
  return r === 0 ? 0 : r;
}

export function formatNumber(n: number, maxDecimals = 2): string {
  const s = roundTo(n, maxDecimals).toFixed(maxDecimals);
  const trimmed = s.includes(".") ? s.replace(/\.?0+$/, "") : s;
  return trimmed === "-0" ? "0" : trimmed;
}

/*
 * parseNumber rules for a student's single numeric answer:
 * - NFKC-normalize (full-width digits/punctuation → ASCII); "−" also counts as minus.
 * - Thousands separators "1,200" / "1，200" are removed (comma followed by exactly 3 digits).
 * - Every number token is extracted: integer/decimal, optional "a/b" fraction, optional "%" (÷100).
 *   "-" is a sign only when not directly after a digit. Surrounding text ("约", "元", "x=", "答：") is ignored.
 * - Zero tokens, or tokens with two different values ("12或48", "第1题：48"), → null.
 *   Chinese numerals ("四十八") are not recognized. Division by zero → null.
 * - Superscripts and subscripts on a letter belong to a unit or a name ("3 m/s²",
 *   "9.8 m·s⁻²", "F₁=24") and are dropped; anywhere else they are powers ("5²") → null.
 */
const NUMBER_TOKEN =
  /(?<![\d.])(-?)\s*(\d+(?:\.\d+)?|\.\d+)(?:\s*\/\s*(\d+(?:\.\d+)?))?\s*(%?)/g;
const SCRIPT = "⁻⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉";
const LETTER_SCRIPT = new RegExp(`(\\p{L})[${SCRIPT}]+`, "gu");
const ANY_SCRIPT = new RegExp(`[${SCRIPT}]`, "u");

export function parseNumber(text: string): number | null {
  if (typeof text !== "string") return null;
  const plain = text.replace(LETTER_SCRIPT, "$1");
  if (ANY_SCRIPT.test(plain)) return null;
  const s = plain
    .normalize("NFKC")
    .replace(/−/g, "-")
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  const values: number[] = [];
  for (const m of s.matchAll(NUMBER_TOKEN)) {
    let v = Number(m[2]);
    if (m[3] !== undefined) v /= Number(m[3]);
    if (m[4]) v /= 100;
    if (m[1]) v = -v;
    if (!Number.isFinite(v)) return null;
    values.push(v);
  }
  const first = values[0];
  if (first === undefined || values.some((v) => !sameNumber(v, first)))
    return null;
  return first === 0 ? 0 : first;
}

// A deliberately small fast path: no prose, direction or unit conversion.
// Unknown/compound units go to Jev instead of growing a local unit-conversion table.
// "%" is a unit here, so "25%" and "25" compare as 25 against 25.
const SIMPLE_NUMERIC_ANSWER =
  /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*\/\s*\d+(?:\.\d+)?)?)\s*(%|元|[毫厘分千]?米|毫?升|[毫千]?克|秒|分钟|小时|天|个|件|本|张|人|km|cm|mm|m|mL|L|kg|mg|g|s|min|h)?$/;

export function compareNumericAnswers(
  reference: string,
  answer: string,
): boolean | null {
  const single = (text: string) => {
    // NFKC would turn 5² into 52.
    if (/[⁰¹²³⁴⁵⁶⁷⁸⁹]/u.test(text)) return null;
    const normalized = text.normalize("NFKC").replace(/−/g, "-").trim();
    // Only remove commas from a correctly grouped, complete leading number.
    const grouped = normalized.replace(
      /^([+-]?\d{1,3}(?:,\d{3})+)(?=\D|$)/,
      (value) => value.replaceAll(",", ""),
    );
    const match = SIMPLE_NUMERIC_ANSWER.exec(grouped);
    if (!match) return null;
    const value = parseNumber(match[1]!);
    return value === null ? null : { value, unit: match[2] || "" };
  };
  const expected = single(reference);
  const given = single(answer);
  if (!expected || !given) return null;
  // Bare student answers inherit the reference's unit, as the UI permits.
  if (given.unit && given.unit !== expected.unit) return null;
  const same = sameNumber(expected.value, given.value);
  // A bare number against a percentage may be the fraction (0.5 for 50%): let Jev decide.
  if (!same && !given.unit && expected.unit === "%") return null;
  return same;
}

export type VariantTemplate = {
  text: string;
  vars: Record<string, { min: number; max: number; step: number }>;
  answer: string;
  constraints?: string[];
  unit?: string;
};

const VAR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;
const MAX_VARS = 6;
const MAX_GRID = 10000;
const finite = z.number().finite();
const templateSchema = z.object({
  text: z.string().min(1).max(2000),
  vars: z.record(z.object({ min: finite, max: finite, step: finite })),
  answer: z.string().min(1),
  constraints: z.array(z.string().min(1)).max(20).optional(),
  unit: z.string().max(20).optional(),
});

function decimalsOf(x: number): number {
  for (let d = 0; d < 10; d++) {
    const scaled = x * 10 ** d;
    if (
      Math.abs(scaled - Math.round(scaled)) <
      1e-9 * Math.max(1, Math.abs(scaled))
    )
      return d;
  }
  return 10;
}

function gridSize(v: { min: number; max: number; step: number }): number {
  return Math.floor((v.max - v.min) / v.step + 1e-9) + 1;
}

const placeholderNames = (text: string) =>
  [...text.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1] ?? "");

export function checkTemplate(input: unknown): VariantTemplate {
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new MathError(
      `题目模板格式错误：${issue ? `${issue.path.join(".") || "(根)"} ${issue.message}` : ""}`,
    );
  }
  const t = parsed.data;
  const names = Object.keys(t.vars);
  if (names.length === 0) throw new MathError("题目模板至少需要一个变量");
  if (names.length > MAX_VARS) throw new MathError(`变量最多 ${MAX_VARS} 个`);
  for (const name of names) {
    if (!VAR_NAME.test(name)) throw new MathError(`变量名不合法：${name}`);
    if (CONSTANTS.has(name) || FUNCTIONS.has(name))
      throw new MathError(`变量名与保留字冲突：${name}`);
    const v = t.vars[name]!;
    if (!(v.step > 0)) throw new MathError(`变量 ${name} 的步长必须大于 0`);
    if (v.min > v.max) throw new MathError(`变量 ${name} 的最小值大于最大值`);
    const size = gridSize(v);
    if (size < 2 || size > MAX_GRID)
      throw new MathError(
        `变量 ${name} 的取值个数须在 2 到 ${MAX_GRID} 之间（当前 ${size}）`,
      );
  }
  const used = new Set(placeholderNames(t.text));
  for (const p of used) {
    if (!Object.hasOwn(t.vars, p))
      throw new MathError(`题目中的占位符 {${p}} 未声明`);
  }
  for (const name of names) {
    if (!used.has(name)) throw new MathError(`变量 ${name} 未在题目中出现`);
  }
  compileChecked(t.answer, names);
  for (const c of t.constraints ?? []) compileChecked(c, names, true);
  return t;
}

export function sampleVariant(
  t: VariantTemplate,
  opts: {
    rng?: () => number;
    avoid?: Record<string, number>;
    tries?: number;
    maxDecimals?: number;
  } = {},
): {
  text: string;
  values: Record<string, number>;
  answer: number;
  answerText: string;
} {
  const { rng = Math.random, avoid, tries = 200, maxDecimals = 2 } = opts;
  const names = Object.keys(t.vars);
  const grids = names.map((name) => {
    const v = t.vars[name]!;
    return {
      name,
      v,
      size: gridSize(v),
      decimals: Math.max(decimalsOf(v.step), decimalsOf(v.min)),
    };
  });
  const answer = compileChecked(t.answer, names);
  const constraints = (t.constraints ?? []).map((c) => ({
    c,
    fn: compileChecked(c, names, true),
  }));

  for (let i = 0; i < tries; i++) {
    const values: Record<string, number> = {};
    for (const g of grids) {
      const k = Math.min(g.size - 1, Math.floor(rng() * g.size));
      values[g.name] = roundTo(g.v.min + k * g.v.step, g.decimals);
    }
    if (
      avoid &&
      names.every(
        (n) => avoid[n] !== undefined && sameNumber(avoid[n], values[n]!),
      )
    )
      continue;
    const holds = ({ c, fn }: (typeof constraints)[number]) => {
      try {
        return toBoolean(fn(values), c);
      } catch {
        return false; // e.g. sqrt of a negative for these values
      }
    };
    if (!constraints.every(holds)) continue;
    let result: number;
    try {
      result = toNumber(answer(values), t.answer);
    } catch {
      continue;
    }
    if (
      Math.abs(result - roundTo(result, maxDecimals)) >
      1e-9 * Math.max(1, Math.abs(result))
    )
      continue;
    const text = t.text.replace(/\{([^{}]*)\}/g, (_, name: string) => {
      const g = grids.find((x) => x.name === name);
      return g ? formatNumber(values[name]!, g.decimals) : `{${name}}`;
    });
    return {
      text,
      values,
      answer: result,
      answerText: formatNumber(result, maxDecimals),
    };
  }
  throw new MathError("找不到满足条件的新数值");
}
