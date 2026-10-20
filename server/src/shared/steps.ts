import {
  definiteValue,
  derivativeIs,
  derivativeText,
  lhopital,
  limitValue,
  limitValueText,
  sameAsLimit,
  sameFunction,
  sameLimit,
  texOf,
  type LimitValue,
} from "./verify.js";
// A worked limit, checked step by step by the program : every "= \lim …"
// the student writes, and every number after "=", must equal the problem's
// limit. Only the chain itself is read: a line that starts with "=", or one that
// starts with the problem's own limit. Anything the program cannot read is
// skipped, never judged.
// A worked derivative is checked the same way : after "y' =" every
// expression must be the problem's derivative, after "(g)' =" the derivative of g.
export type StepItem = {
  step: number;
  tex: string;
  // A limit's value; for a derivative, where it differs ("" when equal).
  value: string;
  same: boolean;
  // A derivative: what it should equal, "y'" or "(g)'".
  of?: string;
  // A limit after another: how it follows from it, for the model.
  basis?: string;
  // L'Hôpital on a limit that is not 0/0 or ∞/∞.
  illegal?: boolean;
};
export type StepCheck = {
  // 旧版记录可能缺少 kind；缺省时仍按极限题处理。
  kind?: "limit" | "derivative";
  reference: string;
  tex: string;
  items: StepItem[];
  // The first step whose value differs from the problem's, or that uses
  // L'Hôpital where it does not apply: that step is wrong.
  wrong: number | null;
  // Why, in one sentence starting with the step.
  reason?: string | null;
};
type Point = { v: string; at: string; side?: "+" | "-" };
type Link = {
  tex: string;
  value: LimitValue | null;
  point: Point | null;
  body?: string;
};

// Not a link of the chain: words, ~ and ≈, integrals and sums, primes, inequalities.
const SKIP =
  /[㐀-鿿]|\\(?:sim|approx|int|sum|prod|Rightarrow|iff|neq|ne|le|ge|leq|geq|lt|gt)(?![a-zA-Z])|[<>≤≥≠∼≈'′∫]/;

// The math of a line: its $…$ spans, or the whole line when it has none.
function spans(line: string): string[] {
  const text = line
    .replace(/＝/g, "=")
    .replace(/\\(?:displaystyle|limits)(?![a-zA-Z])/g, "");
  const found = [...text.matchAll(/\$\$?([^$]+)\$\$?/g)].map((m) => m[1]!);
  return found.length ? found : [text];
}
// "a = b = c" split at its top-level "=" signs.
function links(span: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < span.length; i++) {
    const ch = span[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === "=" && depth === 0) {
      out.push(span.slice(start, i));
      start = i + 1;
    }
  }
  out.push(span.slice(start));
  return out.map((s) => s.trim());
}
// "x\to 0^{+}" → x, 0, "+".
function point(sub: string): Point | null {
  const m = /^\s*([a-z])\s*(?:\\to|\\rightarrow|→|->)\s*(.+?)\s*$/.exec(sub);
  if (!m) return null;
  let at = m[2]!;
  let side: "+" | "-" | undefined;
  const s =
    /\^\s*\{?\s*([+-])\s*\}?$/.exec(at) ?? /(?<=[\d}])\s*([+-])$/.exec(at);
  if (s) {
    side = s[1] as "+" | "-";
    at = at.slice(0, s.index).trim();
  }
  return { v: m[1]!, at, ...(side ? { side } : {}) };
}
// "\lim_{x\to 0}f(x)"; a "\lim" without its subscript takes the last one written.
function limit(part: string, last: Point | null): Link | null {
  const m = /^\\?lim(?![a-zA-Z])\s*/.exec(part);
  if (!m) return null;
  let rest = part.slice(m[0].length);
  let at = last;
  if (rest.startsWith("_")) {
    if (rest[1] !== "{") return null;
    let depth = 0;
    let end = -1;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "{") depth++;
      else if (rest[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) return null;
    at = point(rest.slice(2, end));
    rest = rest.slice(end + 1);
  }
  // A note after the expression: "\quad (\frac{0}{0} 型，洛必达)".
  const body = rest
    .replace(/\\q?quad[\s\S]*$/, "")
    .replace(/\s*[(（][^()（）]*[㐀-鿿][^()（）]*[)）]\s*$/, "")
    .trim();
  if (!at || !body || SKIP.test(body) || /\\?lim(?![a-zA-Z])/.test(body))
    return { tex: part, value: null, point: at };
  return {
    tex: part,
    value: limitValue(body, at.at, at.side, at.v),
    point: at,
    body,
  };
}
// The limits a text asks for, in order.
function limits(text: string): Link[] {
  const out: Link[] = [];
  let last: Point | null = null;
  for (const span of spans(text))
    for (const part of links(span)) {
      const l = limit(part, last);
      if (!l) continue;
      out.push(l);
      last = l.point ?? last;
    }
  return out;
}

// How a limit follows from the one before it: a rewrite of the same function
// says nothing; L'Hôpital is checked for 0/0 or ∞/∞; anything else is left to
// the model, with a note that the program could not tell.
function basis(prev: Link, next: Link): Pick<StepItem, "basis" | "illegal"> {
  const p = prev.point,
    q = next.point;
  if (!prev.body || !next.body || !p || !q) return {};
  if (p.v !== q.v || p.at !== q.at || p.side !== q.side) return {};
  if (sameFunction(prev.body, next.body, p.v) === true) return {};
  const h = lhopital(prev.body, next.body, p.at, p.side, p.v);
  if (!h) return { basis: "程序认不出它和上一步之间的变形依据" };
  const slip = h.numerator ? "" : "，而且分子求导有误";
  if (h.legal)
    return { basis: `对上一步用了洛必达法则，上一步是未定式${slip}` };
  return {
    basis: `对上一步用了洛必达法则，但上一步的分子趋于 ${h.num}、分母趋于 ${h.den}，不是未定式${slip}`,
    illegal: true,
  };
}

export function checkSteps(
  problem: string,
  steps: string[],
): StepCheck | null {
  const f = derivativeOf(problem);
  return f ? derivativeSteps(f, steps) : limitSteps(problem, steps);
}

function limitSteps(problem: string, steps: string[]): StepCheck | null {
  // The problem's own limit (typed on a phone, too), or else the first limit
  // the student wrote.
  let own = limits(problem);
  if (!own.length) {
    const typed = plainLink(problem);
    if (typed) own = [typed];
  }
  let ref: Link | null =
    own.length === 1 && own[0]!.value ? own[0]! : null;
  let last: Point | null = own[0]?.point ?? null;
  if (!ref)
    ref = steps.flatMap((s) => limits(s)).find((l) => l.value) ?? null;
  if (!ref?.value) return null;
  const target = ref.value;
  const items: StepItem[] = [];
  // The limit the next one follows from: at first the problem's own ("原式 = …").
  let prev: Link | null = ref === own[0] ? ref : null;
  steps.forEach((line, i) => {
    for (const span of spans(line)) {
      const parts = links(span);
      const head = limit(parts[0]!, last);
      if (head?.point) last = head.point;
      // A span that neither continues the chain nor restates the problem is a
      // side remark ("因为 lim sin x/x = 1"): left alone.
      const restates =
        head?.value && sameLimit(target, head.value) === true;
      if (parts[0] !== "" && !restates) continue;
      parts.forEach((part, k) => {
        if (k === 0 && !restates) return;
        if (!part || SKIP.test(part)) return;
        const l = k === 0 ? head : limit(part, last);
        if (l) {
          if (l.point) last = l.point;
          const from = k > 0 && prev ? basis(prev, l) : {};
          prev = l.value ? l : null;
          if (!l.value) return;
          const same = sameLimit(target, l.value);
          if (same !== null)
            items.push({
              step: i + 1,
              tex: part,
              value: limitValueText(l.value),
              same,
              ...from,
            });
          return;
        }
        prev = null;
        const same = sameAsLimit(target, part);
        if (same !== null)
          items.push({ step: i + 1, tex: part, value: part, same });
      });
    }
  });
  if (!items.length) return null;
  const reference = limitValueText(target);
  const bad = items.find((t) => !t.same || t.illegal);
  return {
    kind: "limit",
    reference,
    tex: ref.tex,
    items,
    wrong: bad?.step ?? null,
    reason: !bad
      ? null
      : bad.same
        ? `第 ${bad.step} 步有误：${bad.basis}`
        : `第 ${bad.step} 步有误：这一步的值（${bad.value}）和题目的值（${reference}）不相等${bad.basis?.includes("洛必达") ? `；它${bad.basis}` : ""}`,
  };
}

// ---------- worked derivatives  ----------

const PRIME = String.raw`(?:'|′|\^\s*\{?\s*\\prime\s*\}?)`;
const D = String.raw`(?:\\mathrm\s*\{\s*d\s*\}|d)`;
// y', f'(x), dy/dx: the problem's own derivative.
const HEAD = new RegExp(
  String.raw`^(?:y\s*${PRIME}|f\s*${PRIME}\s*(?:\(\s*x\s*\))?|\\frac\s*\{\s*${D}\s*y\s*\}\s*\{\s*${D}\s*x\s*\}|dy\s*/\s*dx)$`,
);
// (g)', [g]': the derivative of a part of it.
const PART = new RegExp(
  String.raw`^(?:\\left\s*)?[(\[]([\s\S]+)[)\]]\s*${PRIME}$`,
);
// A first derivative of an explicit y = f(x); not y'', implicit or parametric.
const ASKS = new RegExp(
  String.raw`y\s*${PRIME}|f\s*${PRIME}|\\frac\s*\{\s*${D}\s*y|dy\s*/\s*dx|导数|求导`,
);
const NOT_FIRST =
  /''|″|\\prime\s*\\prime|二阶|高阶|[nN]\s*阶|隐函数|参数|确定|偏导|微分方程|\\begin/;
const FUNC =
  /(?<=^|[\s设令若知，,：:（(])(?:y|f\s*\(\s*x\s*\))\s*=\s*([^，。,;；？?！!：:\n㐀-鿿]+)/g;

// The function whose derivative a problem asks for, as written.
function derivativeOf(problem: string): string | null {
  const text = problem.replace(/＝/g, "=");
  if (!ASKS.test(text) || NOT_FIRST.test(text)) return null;
  const found = [...text.replace(/\$/g, " ").matchAll(FUNC)].map((m) =>
    m[1]!.replace(/\\[,;!]\s*$/, "").trim(),
  );
  if (found.length !== 1) return null;
  return sameFunction(found[0]!, found[0]!) === true ? found[0]! : null;
}

function derivativeSteps(f: string, steps: string[]): StepCheck | null {
  const items: StepItem[] = [];
  // What the chain being read should be the derivative of.
  let of: { expr: string; label: string } | null = null;
  steps.forEach((line, i) => {
    for (const span of spans(line)) {
      const parts = links(span);
      const head = parts[0]!;
      const part = PART.exec(head)?.[1]?.replace(/\\right\s*$/, "").trim();
      if (HEAD.test(head)) of = { expr: f, label: "y'" };
      else if (part && sameFunction(part, part) === true)
        of = { expr: part, label: `\\left(${part}\\right)'` };
      // A line that neither starts a chain nor continues one: a side remark.
      else if (head !== "") of = null;
      const now = of;
      if (!now) continue;
      for (const tex of parts.slice(1)) {
        if (!tex || SKIP.test(tex)) continue;
        const r = derivativeIs(now.expr, tex);
        if (!r) continue;
        items.push({
          step: i + 1,
          tex,
          value: r.same ? "" : `在 x=${r.x} 处应为 ${r.want}，这一步为 ${r.got}`,
          same: r.same,
          of: now.label,
        });
      }
    }
  });
  if (!items.length) return null;
  const bad = items.find((t) => !t.same);
  return {
    kind: "derivative",
    reference: "y'",
    // Typed on a phone ("ln(1+x²)·e^(2x)"): as the program read it.
    tex: `y'=\\frac{d}{dx}\\left(${/[\\{]/.test(f) ? f : (texOf(f) ?? f)}\\right)`,
    items,
    wrong: bad?.step ?? null,
    reason: bad
      ? `第 ${bad.step} 步有误：这一步的式子不等于 ${bad.of!.replace(/\\(?:left|right)/g, "")}，${bad.value}`
      : null,
  };
}

// ---------- the problem's own answer, before the model answers  ----------

// What the program worked out by itself: the object, as written, and its value.
export type Known = { tex: string; value: string };

// A limit typed on a phone: "lim(x→0) (e^x − 1 − 5x)/x²", "lim x→0+ x ln x".
const PLAIN =
  /lim\s*[_(（{]?\s*([a-z])\s*(?:→|->|\\to)\s*([+-]?(?:\d+(?:\.\d+)?|∞|\\infty|inf|pi|π)[+-]?)\s*[)）}]?\s*([^，。,;；？?！!：:\n㐀-鿿]+)/;
function plainLink(text: string): Link | null {
  const m = PLAIN.exec(text.replace(/\$/g, ""));
  if (!m) return null;
  const at = point(`${m[1]}\\to ${m[2]!.replace(/∞/g, "\\infty")}`);
  const body = m[3]!.trim();
  if (!at || !body) return null;
  const value = limitValue(body, at.at, at.side, at.v);
  if (!value) return null;
  // As TeX, for the checks the student can open.
  const sub = `${at.v}\\to ${at.at}${at.side ? `^{${at.side}}` : ""}`;
  return {
    tex: `\\lim_{${sub}}${texOf(body, at.v) ?? body}`,
    value,
    point: at,
    body,
  };
}
function plainLimit(text: string): Known | null {
  const l = plainLink(text);
  return l?.value ? { tex: l.tex, value: limitValueText(l.value) } : null;
}
// A braced group or a single token after "_" or "^".
function arg(s: string, i: number): [string, number] | null {
  while (s[i] === " ") i++;
  if (s[i] === "{") {
    let depth = 0;
    for (let k = i; k < s.length; k++) {
      if (s[k] === "{") depth++;
      else if (s[k] === "}" && --depth === 0) return [s.slice(i + 1, k), k + 1];
    }
    return null;
  }
  const cmd = /^\\[a-zA-Z]+/.exec(s.slice(i));
  if (cmd) return [cmd[0], i + cmd[0].length];
  return i < s.length ? [s[i]!, i + 1] : null;
}
// "\int_{0}^{\frac{\pi}{2}} x\sin x\,dx" → its numeric value.
function definite(span: string): Known | null {
  const at = span.indexOf("\\int");
  if (at < 0 || span.indexOf("\\int", at + 1) >= 0) return null;
  let i = at + 4;
  let from: string | null = null;
  let to: string | null = null;
  for (let k = 0; k < 2; k++) {
    while (span[i] === " ") i++;
    const mark = span[i];
    if (mark !== "_" && mark !== "^") break;
    const got = arg(span, i + 1);
    if (!got) return null;
    if (mark === "_") from = got[0];
    else to = got[0];
    i = got[1];
  }
  if (from === null || to === null) return null;
  const end =
    /(?:\\[,;!]\s*)?(?:\\mathrm\s*\{\s*d\s*\}|\\mathrm\s+d|d)\s*([a-z])\s*$/.exec(
      span.slice(i).replace(/[.。，,]\s*$/, ""),
    );
  if (!end) return null;
  const body = span.slice(i, i + end.index).trim();
  const value = body ? definiteValue(body, from, to, end[1]) : null;
  return value
    ? { tex: span.slice(at).trim(), value: `${value}（数值积分）` }
    : null;
}
// The answer the program can give to a problem by itself: a single limit, a
// single definite integral with numeric bounds, or the first derivative of an
// explicit function. Anything else is left alone.
export function presolve(problem: string): Known | null {
  const own = limits(problem);
  if (own.length > 1) return null;
  if (own[0]?.value)
    return { tex: own[0].tex, value: limitValueText(own[0].value) };
  if (/\\lim(?![a-zA-Z])/.test(problem)) return null;
  const found = spans(problem)
    .map((s) => (s.includes("\\int") ? definite(s) : null))
    .filter((k) => k !== null);
  if (found.length === 1) return found[0]!;
  if (found.length > 1 || /\\int|∫/.test(problem)) return null;
  const f = derivativeOf(problem);
  const d = f ? derivativeText(f) : null;
  if (d)
    return { tex: "y'", value: d.includes("log") ? `${d}（log 是自然对数）` : d };
  return plainLimit(problem);
}
