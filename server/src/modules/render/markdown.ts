import type { Token, Tokens } from "marked";
import type { FormulaImage, FormulaRenderer } from "./formula.js";
import { runIsolated } from "../../shared/isolated-worker.js";
// Rendered content sent to the mini program. Formulas are PNGs served by id
// (`/api/formula/:id.png`) with sizes in em; `d` marks a display formula.
// Colour marks the model writes as [[k:…]] (重点), [[w:…]] (方法), [[f:…]] (公式)
// and [[x:…]] (易错); [[k!:…]] is the stronger grade (`hi`). Every node inside a
// mark carries it, formulas included.
export type Mk = "key" | "way" | "fx" | "warn";
type Marked = { mk?: Mk; hi?: 1 };
export type Inline =
  | ({ t: "text"; v: string; b?: 1; i?: 1; code?: 1; del?: 1 } & Marked)
  | ({ t: "math"; d?: 1; tex: string } & FormulaImage & Marked)
  | ({ t: "tex"; v: string; d?: 1 } & Marked);
export type ListItem = { c: Inline[]; lv: number; n: string };
export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; l: number; c: Inline[] }
  | ({ t: "math"; tex: string } & FormulaImage)
  | { t: "tex"; v: string }
  | { t: "list"; items: ListItem[] }
  | { t: "quote"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "hr" }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] };
// Internal metadata only: response shapes remain unchanged. Cached composites
// can also contain rendered blocks several levels below their root.
const degraded = new WeakSet<object>();
const markDegraded = (blocks: Block[]): Block[] => { degraded.add(blocks); return blocks; };
export function hasDegradedRender(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (degraded.has(value) || ("t" in value && value.t === "tex")) return true;
  return Object.values(value).some(hasDegradedRender);
}
const OPEN = "",
  CLOSE = "";
const HOLDER = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");
type Math = { tex: string; display: boolean };
// Marks become private-use characters before markdown parsing (marked would read
// "[[" as a link): one opening character per kind and grade, one closing.
const MK_KINDS: Mk[] = ["key", "way", "fx", "warn"];
const MK_LETTERS: Record<string, Mk> = { k: "key", w: "way", f: "fx", x: "warn" };
const MK_BASE = 0xe010,
  MK_END = "\ue018";
const MK_CHAR = /[\ue010-\ue018]/g;
// An opener may carry a backslash ("\[[k:", markdown's escaped bracket) and
// stray spaces ("[[k :"); a spaced one is not a valid mark. Closers come as a
// run of "]".
const MK_TOKEN = /\\?\[\[([ \t]*)([A-Za-z])([ \t]*)(!?)([ \t]*):|\]{2,}|\n/g;
// Fenced code blocks and inline code spans keep marks as written.
function codeRanges(text: string) {
  const ranges: [number, number][] = [];
  let fence = false,
    offset = 0;
  for (const line of text.split("\n")) {
    const end = offset + line.length;
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      ranges.push([offset, end]);
    } else if (fence) ranges.push([offset, end]);
    else
      for (const m of line.matchAll(/(?<!`)(`+)(?!`).*?[^`]\1(?!`)/g))
        ranges.push([offset + m.index, offset + m.index + m[0].length]);
    offset = end + 1;
  }
  return ranges;
}
// A mark that is closed on its line, has a known letter, holds some text and
// has no mark inside becomes a pair of those characters. Its words may hold
// single brackets ("[[k:闭区间 [a,b] 上]]"); in a run like "]]]" the last two
// close it. Any other attempt (unclosed, unknown letter, nested, empty,
// spaced) loses its "[[k:" and its own "]]" on that line and stays as plain
// text. Any other "]]", and everything inside code, is left as written.
export function markUp(text: string) {
  const edits: { from: number; to: number; put: string }[] = [];
  type Group = {
    tokens: { from: number; to: number }[];
    letter: string;
    hi: boolean;
    depth: number;
    nested: boolean;
    loose: boolean;
    body: number;
  };
  let group: Group | null = null;
  const drop = (g: Group) => {
    for (const t of g.tokens) edits.push({ ...t, put: "" });
    group = null;
  };
  // One "]]" at from..to for the open group.
  const close = (g: Group, from: number, to: number) => {
    g.tokens.push({ from, to });
    if (--g.depth > 0) return;
    const kind = MK_LETTERS[g.letter];
    if (!kind || g.nested || g.loose || !text.slice(g.body, from).trim())
      return drop(g);
    const code = MK_BASE + MK_KINDS.indexOf(kind) * 2 + (g.hi ? 1 : 0);
    edits.push(
      { ...g.tokens[0]!, put: String.fromCharCode(code) },
      { ...g.tokens[1]!, put: MK_END },
    );
    group = null;
  };
  const code = codeRanges(text);
  let ci = 0;
  const inCode = (at: number) => {
    while (ci < code.length && code[ci]![1] <= at) ci++;
    return ci < code.length && code[ci]![0] <= at;
  };
  for (const m of text.matchAll(MK_TOKEN)) {
    const from = m.index,
      to = from + m[0].length;
    if (m[0] !== "\n" && inCode(from)) continue;
    const g: Group | null = group;
    if (m[0] === "\n") {
      if (g) drop(g);
    } else if (m[0][0] === "]") {
      if (!g) continue;
      if (g.depth === 1) close(g, to - 2, to);
      else
        for (let at = from; at + 2 <= to && group; at += 2)
          close(group, at, at + 2);
    } else if (g) {
      g.depth++;
      g.nested = true;
      g.tokens.push({ from, to });
    } else {
      group = {
        tokens: [{ from, to }],
        letter: m[2]!,
        hi: m[4] === "!",
        depth: 1,
        nested: false,
        loose: !!(m[1] || m[3] || m[5]),
        body: to,
      };
    }
  }
  if (group) drop(group);
  if (!edits.length) return text;
  edits.sort((a, b) => a.from - b.from);
  let out = "",
    last = 0;
  for (const e of edits) {
    out += text.slice(last, e.from) + e.put;
    last = e.to;
  }
  return out + text.slice(last);
}
// The mark characters written back as syntax: "[[k:", "[[k!:" and "]]".
export const markDown = (text: string) =>
  text.replace(MK_CHAR, (c) => {
    const code = c.charCodeAt(0) - MK_BASE;
    return code === 8 ? "]]" : `[[${"kwfx"[code >> 1]}${code & 1 ? "!" : ""}:`;
  });
// Text cut to n visible characters, valid marks kept as syntax and broken
// ones taken out; a mark the cut runs through loses its syntax.
export function clipMarked(text: string, n: number) {
  let out = "",
    seen = 0,
    open = -1;
  for (const ch of Array.from(markUp(text))) {
    if (/[-]/.test(ch)) {
      open = ch === MK_END ? -1 : out.length;
      out += ch;
      continue;
    }
    if (seen === n) break;
    out += ch;
    seen++;
  }
  if (open >= 0) out = out.slice(0, open) + out.slice(open + 1);
  return markDown(out);
}
// Text with the mark syntax taken out, for places that show plain text.
export const unmark = (text: string) => markUp(text).replace(MK_CHAR, "");
// Splits text runs at the mark characters and stamps mk/hi on everything
// between an opening and its closing, formulas included.
function stamp(items: Inline[]): Inline[] {
  let cur: Marked = {};
  const out: Inline[] = [];
  for (const item of items) {
    if (item.t !== "text" || !/[\ue010-\ue018]/.test(item.v)) {
      out.push(cur.mk ? ({ ...item, ...cur } as Inline) : item);
      continue;
    }
    for (const part of item.v.split(/([\ue010-\ue018])/)) {
      if (!part) continue;
      const code = part.length === 1 ? part.charCodeAt(0) - MK_BASE : -1;
      if (code >= 0 && code <= 8) {
        cur =
          code === 8
            ? {}
            : { mk: MK_KINDS[code >> 1]!, ...(code & 1 ? { hi: 1 as const } : {}) };
        continue;
      }
      out.push({ ...item, v: part, ...cur });
    }
  }
  return out;
}
// Chinese outside \text{} means a `$…$` pair caught prose, e.g. "$5 和 $6".
const prose = (tex: string) =>
  /[　-ヿ一-鿿＀-￯]/.test(
    tex.replace(
      /\\(?:text|mbox|mathrm|textbf|textrm|operatorname)\s*\{[^{}]*\}/g,
      "",
    ),
  );
// Pulls formulas out before markdown parsing, which would otherwise eat `\`, `_` and `*`.
// Inline `$…$` follows the pandoc rule: no space inside the delimiters and no digit
// right after the closing `$`, so prices like "$5 and $6" stay text.
export function extractMath(source: string) {
  const found: Math[] = [];
  const hold = (tex: string, display: boolean) => {
    found.push({ tex: tex.trim(), display });
    return `${OPEN}${found.length - 1}${CLOSE}`;
  };
  const text = source
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => hold(tex, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) => hold(tex, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex: string) => hold(tex, false))
    .replace(
      /(^|[^\\$])\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/g,
      (all: string, before: string, tex: string) =>
        prose(tex) ? all : before + hold(tex, false),
    );
  return { text, found };
}
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};
const decode = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
type Style = { b?: 1; i?: 1; del?: 1 };
// In running text, limits, integrals, sums and fractions are drawn at full size:
// text style shrinks them below what a phone screen can read.
const roomy = (tex: string) =>
  /\\(?:lim|int|iint|oint|sum|prod|frac|binom)(?![a-zA-Z])/.test(tex);
// New formula pixels one render may draw: 20 formulas at the size cap, about a
// second of drawing. Past it formulas fall back to their TeX text (not cached),
// so one text packed with large formulas cannot hold the drawing queue for long.
const CALL_PX = 40_000_000;
export class MarkdownRenderer {
  constructor(private readonly formulas: FormulaRenderer) {}
  async render(source: string, color: string): Promise<Block[]> {
    // Model output and stored content also reach this renderer without passing
    // through /v1/render's request schema.
    // Never drop a suffix: very large stored answers remain readable in full.
    // The lexer still runs out of process with its time/heap/tree bounds.
    if (source.length > 200_000)
      return markDegraded([
        { t: "p", c: [{ t: "text", v: "内容较长，以下以原文显示，内容未删减。" }] },
        { t: "p", c: [{ t: "text", v: source }] },
      ]);
    const extracted = extractMath(source);
    const found = extracted.found,
      text = markUp(extracted.text);
    const budget = { px: CALL_PX };
    const images: (FormulaImage | null)[] = [];
    const deadline = Date.now() + 60_000;
    let limited = false;
    for (const [index, m] of found.entries()) {
      const allowed = index < 200 && Date.now() < deadline;
      if (!allowed) limited = true;
      images.push(allowed ? await this.formulas.render(
          m.display || !roomy(m.tex) ? m.tex : `\\displaystyle ${m.tex}`,
          m.display,
          color,
          budget,
        ) : null);
    }
    const math = (index: number, display: boolean): Inline => {
      const image = images[index],
        tex = found[index]?.tex ?? "";
      if (!image)
        return display ? { t: "tex", v: tex, d: 1 } : { t: "tex", v: tex };
      return display
        ? { t: "math", d: 1, tex, ...image }
        : { t: "math", tex, ...image };
    };
    const split = (value: string, style: Style, out: Inline[]) => {
      let last = 0;
      for (const m of value.matchAll(HOLDER)) {
        if (m.index > last)
          out.push({
            t: "text",
            v: decode(value.slice(last, m.index)),
            ...style,
          });
        const index = Number(m[1]);
        out.push(math(index, found[index]?.display ?? false));
        last = m.index + m[0].length;
      }
      if (last < value.length)
        out.push({ t: "text", v: decode(value.slice(last)), ...style });
    };
    const inline = (
      tokens: Token[] | undefined,
      style: Style = {},
    ): Inline[] => {
      const out: Inline[] = [];
      for (const token of tokens ?? []) {
        switch (token.type) {
          case "strong":
            out.push(
              ...inline((token as Tokens.Strong).tokens, { ...style, b: 1 }),
            );
            break;
          case "em":
            out.push(
              ...inline((token as Tokens.Em).tokens, { ...style, i: 1 }),
            );
            break;
          case "del":
            out.push(
              ...inline((token as Tokens.Del).tokens, { ...style, del: 1 }),
            );
            break;
          case "codespan":
            out.push({
              t: "text",
              v: decode((token as Tokens.Codespan).text),
              code: 1,
            });
            break;
          case "br":
            out.push({ t: "text", v: "\n", ...style });
            break;
          case "link":
            out.push(...inline((token as Tokens.Link).tokens, style));
            break;
          case "html":
          case "image":
            break;
          case "text":
            if ("tokens" in token && token.tokens?.length)
              out.push(...inline(token.tokens, style));
            else split((token as Tokens.Text).text, style, out);
            break;
          case "escape":
            out.push({ t: "text", v: (token as Tokens.Escape).text, ...style });
            break;
          default:
            if ("text" in token && typeof token.text === "string")
              split(token.text, style, out);
        }
      }
      return merge(out);
    };
    // One finished run of inline content: marks stamped, equal runs joined.
    const line = (c: Inline[]) => merge(stamp(c));
    const listItems = (list: Tokens.List, level: number, items: ListItem[]) => {
      const start = typeof list.start === "number" ? list.start : 1;
      list.items.forEach((item, i) => {
        const content: Inline[] = [];
        const nested: Tokens.List[] = [];
        for (const child of item.tokens) {
          if (child.type === "list") nested.push(child as Tokens.List);
          else if (child.type === "text" || child.type === "paragraph") {
            if (content.length) content.push({ t: "text", v: "\n" });
            content.push(
              ...inline(
                (child as Tokens.Text).tokens ?? [
                  {
                    type: "text",
                    raw: child.raw,
                    text: (child as Tokens.Text).text,
                  },
                ],
              ),
            );
          } else if (child.type === "code")
            content.push({
              t: "text",
              v: (child as Tokens.Code).text,
              code: 1,
            });
        }
        items.push({
          c: line(content),
          lv: level,
          n: list.ordered ? `${start + i}.` : level ? "◦" : "•",
        });
        for (const sub of nested) listItems(sub, level + 1, items);
      });
    };
    const blocks: Block[] = [];
    const walk = (tokens: Token[]) => {
      for (const token of tokens) {
        switch (token.type) {
          case "paragraph": {
            const c = line(inline((token as Tokens.Paragraph).tokens));
            const only = c.length === 1 ? c[0] : undefined;
            if (only && only.t === "math" && only.d) {
              const { t: _t, d: _d, mk: _mk, hi: _hi, ...image } = only;
              blocks.push({ t: "math", ...image });
            } else if (only && only.t === "tex" && only.d)
              blocks.push({ t: "tex", v: only.v });
            else if (c.length) blocks.push({ t: "p", c });
            break;
          }
          case "heading": {
            const h = token as Tokens.Heading;
            blocks.push({
              t: "h",
              l: Math.min(3, h.depth),
              c: line(inline(h.tokens)),
            });
            break;
          }
          case "list": {
            const items: ListItem[] = [];
            listItems(token as Tokens.List, 0, items);
            blocks.push({ t: "list", items });
            break;
          }
          case "blockquote": {
            const c: Inline[] = [];
            for (const child of (token as Tokens.Blockquote).tokens) {
              if (c.length) c.push({ t: "text", v: "\n" });
              c.push(...inline("tokens" in child ? child.tokens : undefined));
            }
            blocks.push({ t: "quote", c: line(c) });
            break;
          }
          case "code":
            blocks.push({
              t: "code",
              v: restore((token as Tokens.Code).text, found),
            });
            break;
          case "hr":
            blocks.push({ t: "hr" });
            break;
          case "table": {
            const table = token as Tokens.Table;
            blocks.push({
              t: "table",
              head: table.header.map((cell) => line(inline(cell.tokens))),
              rows: table.rows.map((row) =>
                row.map((cell) => line(inline(cell.tokens))),
              ),
            });
            break;
          }
          case "text": {
            const c = line(inline("tokens" in token ? token.tokens : undefined));
            if (c.length) blocks.push({ t: "p", c });
            break;
          }
          default:
            break;
        }
      }
    };
    try {
      walk(await runIsolated<Token[]>("formula", "markdown", text));
    } catch {
      // Preserve readable content when the parser budget is exceeded.
      return markDegraded([
        { t: "p", c: [{ t: "text", v: "内容排版暂未完成，以下显示完整原文。" }] },
        { t: "p", c: [{ t: "text", v: source }] },
      ]);
    }
    if (limited)
      blocks.push({ t: "p", c: [{ t: "text", v: "部分公式较多或排版耗时较长，已保留公式原文。" }] });
    return limited || images.some((image) => !image) ? markDegraded(blocks) : blocks;
  }
}
// Code blocks show formulas and marks as the source the model wrote.
const restore = (text: string, found: Math[]) =>
  text
    .replace(HOLDER, (_, i: string) => {
      const m = found[Number(i)];
      return m ? (m.display ? `$$${m.tex}$$` : `$${m.tex}$`) : "";
    })
    .replace(MK_CHAR, markDown);
// Joins neighbouring text runs with the same style to keep the payload small.
function merge(items: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (
      item.t === "text" &&
      last?.t === "text" &&
      last.b === item.b &&
      last.i === item.i &&
      last.code === item.code &&
      last.del === item.del &&
      last.mk === item.mk &&
      last.hi === item.hi
    )
      last.v += item.v;
    else out.push(item.t === "text" ? { ...item } : item);
  }
  return out;
}
// Where the stream can be cut: after the last blank line that is not inside a
// display formula or a code fence. Text before it will not change any more.
export function stableLength(text: string) {
  let cut = 0,
    fence = false,
    display = false;
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence) {
      const marks = (line.match(/\$\$|\\\[|\\\]/g) ?? []).length;
      if (marks % 2) display = !display;
    }
    offset += line.length + 1;
    if (!fence && !display && line.trim() === "" && i > 0) cut = offset;
  }
  return cut;
}
// One line of plain text for titles and previews, where no image can show:
// "求极限 $\lim_{x\to 0}\frac{e^{3x}-1-3x}{x^{2}}$" → "求极限 lim(x→0) (e³ˣ-1-3x)/x²".
// Only for display; it is never parsed back.
const SYMBOLS: Record<string, string> = {
  to: "→", rightarrow: "→", Rightarrow: "⇒", infty: "∞", int: "∫", iint: "∬",
  oint: "∮", sum: "Σ", prod: "Π", pi: "π", cdot: "·", times: "×", div: "÷",
  le: "≤", leq: "≤", leqslant: "≤", ge: "≥", geq: "≥", geqslant: "≥", lt: "<", gt: ">", ne: "≠", neq: "≠", pm: "±", approx: "≈",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  theta: "θ", lambda: "λ", mu: "μ", sigma: "σ", omega: "ω", phi: "φ",
  varphi: "φ", Delta: "Δ", partial: "∂", nabla: "∇", in: "∈", cup: "∪",
  cap: "∩", forall: "∀", exists: "∃", circ: "∘", prime: "′", ldots: "…",
  cdots: "⋯", quad: " ", qquad: " ",
};
const NAMES = new Set(
  "sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh ln lg log exp max min sup inf det dim lim".split(
    " ",
  ),
);
const SUP: Record<string, string> = {
  0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸",
  9: "⁹", "+": "⁺", "-": "⁻", n: "ⁿ", x: "ˣ", i: "ⁱ", k: "ᵏ", "(": "⁽", ")": "⁾",
};
const SUB: Record<string, string> = {
  0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈",
  9: "₉", n: "ₙ", i: "ᵢ", k: "ₖ",
};
const script = (body: string, map: Record<string, string>, mark: string) => {
  const chars = [...body.replace(/\s+/g, "")];
  return chars.length && chars.every((c) => map[c])
    ? chars.map((c) => map[c]).join("")
    : `${mark}(${body})`;
};
// A fraction part keeps its brackets unless it is one term.
const group = (part: string) =>
  /^[\p{L}\p{N}.′⁰¹²³⁴⁵⁶⁷⁸⁹ˣⁿ₀-₉]+$/u.test(part) ? part : `(${part})`;
export function texText(tex: string) {
  let s = tex
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)(?![a-zA-Z])/g, "")
    .replace(/\\(?:mathrm|text|textbf|mathbf|mathit|operatorname|mbox)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:,|;|:|!| )/g, " ")
    .replace(/\\([a-zA-Z]+)/g, (all, name: string) => SYMBOLS[name] ?? all);
  // Innermost groups first, so nested fractions and powers come out right.
  for (let i = 0; i < 8; i++) {
    const before = s;
    s = s
      .replace(/\\lim_\{([^{}]*)\}/g, (_, at: string) => `lim(${at.replace(/\s+/g, "")}) `)
      .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a: string, b: string) => `${group(a.trim())}/${group(b.trim())}`)
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, a: string) => `√${group(a.trim())}`)
      .replace(/\^\{([^{}]*)\}/g, (_, a: string) => script(a, SUP, "^"))
      .replace(/_\{([^{}]*)\}/g, (_, a: string) => script(a, SUB, "_"));
    if (s === before) break;
  }
  return s
    .replace(/\\[dt]?frac\s*(\S)\s*(\S)/g, "$1/$2")
    .replace(/\^([0-9a-z+-])/g, (_, c: string) => SUP[c] ?? `^${c}`)
    .replace(/_([0-9a-z])/g, (_, c: string) => SUB[c] ?? `_${c}`)
    // "\\sin x" keeps a space, "\\ln(1+x)" does not; unknown commands go.
    .replace(/\\([a-zA-Z]+)(?=(.?))/gu, (_, name: string, next: string) =>
      NAMES.has(name) ? (/[\p{L}\p{N}]/u.test(next) ? `${name} ` : name) : "",
    )
    .replace(/[{}]/g, "")
    .replace(/\s*([→=+<>≤≥≠])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
// Text with its formulas written out as texText, markdown marks dropped.
export function readable(source: string) {
  const { text, found } = extractMath(source);
  // Blockquote markers go only at the start of a line, or right after a list
  // marker ("- > 注意"); "x>0" keeps its ">".
  return unmark(text)
    .replace(/^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)(?:>[ \t]*)+/gm, "$1")
    .replace(/^[ \t]*(?:>[ \t]*)+/gm, "")
    // V4.2 : only Markdown marks go (headings, bold, a list star,
    // emphasis, code ticks); "C#", "a*b" and a lone "#3" keep theirs.
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^([ \t]*)\*[ \t]+/gm, "$1")
    .replace(/\*\*|`+/g, "")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(HOLDER, (_, i: string) => texText(found[Number(i)]?.tex ?? ""))
    .replace(/\s+/g, " ")
    .trim();
}
// An answer such as "-\frac{1}{6}" is usually bare TeX; a sentence keeps its own
// $ marks. Either way it comes out as plain text ("-1/6").
export const answerText = (value: string) =>
  readable(/\$|[\u4e00-\u9fff]/.test(value) ? value : `$${value}$`);
