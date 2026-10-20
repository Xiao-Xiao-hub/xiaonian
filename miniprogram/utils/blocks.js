/*
 * 富文本内容块：把服务端内容块与标记转换为小程序可显示的数据。
 * 公式与段落的来源和顺序需要保持；这里不修改服务器保存的原始内容。
 */
// Colour marks: the model writes [[k:…]],
// [[w:…]], [[f:…]], [[x:…]] (and [[k!:…]] for the stronger grade). The server
// turns them into `mk`/`hi` on inline nodes; text that still holds the syntax
// (a streaming tail, an old copy) shows the words without it. The rules follow
// server/src/modules/render/markdown.ts (markUp): a mark stays on one line, its
// words may hold single brackets ("[[k:闭区间 [a,b] 上]]"), in a run like "]]]"
// the last two close it, and an unknown letter, a spaced opener ("[[k :") or an
// empty mark shows its words without colour.
const OPENER = "\\\\?\\[\\[[ \\t]*[A-Za-z][ \\t]*!?[ \\t]*:";
const MARK_OPEN = new RegExp(OPENER, "g");
// One finished attempt: opener parts, then words up to the closing "]]".
const MARK_DONE = new RegExp(
  `\\\\?\\[\\[([ \\t]*)([A-Za-z])([ \\t]*)(!?)([ \\t]*):((?:(?!${OPENER})[^\\n])*?)\\]\\](?!\\])`,
  "g",
);
const MARK_KINDS = { k: "key", w: "way", f: "fx", x: "warn" };
// Finished marks lose their syntax; a nested attempt goes from the inside out.
function finish(text) {
  let s = String(text || ""),
    prev;
  do {
    prev = s;
    s = s.replace(MARK_DONE, "$6");
  } while (s !== prev);
  return s;
}
// Text with the mark syntax taken out: "[[k:极限]]" -> "极限", and an opener
// that never closed goes too. Any other "]]" stays as written.
function unmark(text) {
  return finish(text).replace(MARK_OPEN, "");
}
// The paragraph still being written: finished marks show their words (only
// their own "]]" goes), a mark still open shows what is written so far, and a
// half-typed "[[k" or a lone "]" closing an open mark is held back until the
// next piece arrives.
function stripTail(text) {
  let out = finish(text);
  const open = new RegExp(`${OPENER}[^\\n]*$`).test(out);
  out = out.replace(MARK_OPEN, "");
  out = out.replace(/\\?\[(?:\[(?:[ \t]*[A-Za-z][ \t]*!?[ \t]*)?)?$/, "");
  if (open) out = out.replace(/\]$/, "");
  return out;
}
// A short plain field that may hold marks (a card slot, a map point's key
// line) as one paragraph block for the rich component. Formulas stay as text;
// long content goes through the server renderer instead. The text is final,
// so nothing at its end is held back.
function markBlocks(text) {
  const c = [];
  const put = (v, mk, hi) => {
    if (!v) return;
    const last = c[c.length - 1];
    if (!mk && last && !last.mk) last.v += v;
    else c.push({ t: "text", v, ...(mk ? { mk } : {}), ...(hi ? { hi: 1 } : {}) });
  };
  const s = String(text || "");
  let last = 0;
  for (const m of s.matchAll(MARK_DONE)) {
    put(unmark(s.slice(last, m.index)));
    const kind = MARK_KINDS[m[2]];
    const valid = kind && !m[1] && !m[3] && !m[5] && m[6].trim();
    put(valid ? m[6] : unmark(m[6]), valid ? kind : "", valid && m[4]);
    last = m.index + m[0].length;
  }
  put(unmark(s.slice(last)));
  return c.length ? [{ t: "p", c }] : [];
}
// Plain text of rendered content blocks (docs/api.md), with formulas written back
// as $…$, for quoting a step, copying and searching. Marks are dropped.
function inline(c) {
  return (c || [])
    .map((x) =>
      x.t === "text"
        ? unmark(x.v)
        : x.t === "math"
          ? x.d
            ? `$$${x.tex}$$`
            : `$${x.tex}$`
          : x.t === "tex"
            ? `$${x.v}$`
            : "",
    )
    .join("");
}
function plain(block) {
  if (!block) return "";
  switch (block.t) {
    case "p":
    case "h":
    case "quote":
      return inline(block.c);
    case "math":
      return `$$${block.tex}$$`;
    case "tex":
      return `$$${block.v}$$`;
    case "list":
      return block.items.map((item) => `${item.n} ${inline(item.c)}`).join("\n");
    case "code":
      return block.v;
    case "table":
      return [block.head, ...block.rows]
        .map((row) => row.map(inline).join(" | "))
        .join("\n");
    default:
      return "";
  }
}
const plainAll = (blocks) =>
  (blocks || []).map(plain).filter(Boolean).join("\n\n");
// Punctuation that must not start a line: a formula image and the "，" after it
// stay together (a line opening on "，" looks broken).
const TRAIL = /^[，。；：？！、）》”’,.;:?!)]+/;
function glueInline(c) {
  const out = [];
  (c || []).forEach((x) => {
    const prev = out[out.length - 1];
    const m = x && x.t === "text" && prev && prev.t === "math" && !prev.d ? TRAIL.exec(x.v) : null;
    if (!m) return out.push(x);
    // The formula keeps its own mark (prev.mk); the punctuation keeps the text's.
    out[out.length - 1] = {
      t: "glue",
      m: prev,
      v: m[0],
      ...(x.mk ? { mk: x.mk } : {}),
      ...(x.hi ? { hi: x.hi } : {}),
    };
    if (x.v.length > m[0].length) out.push({ ...x, v: x.v.slice(m[0].length) });
  });
  return out;
}
// The blocks as the rich component draws them; plain still reads the originals.
function glueBlocks(blocks) {
  return (blocks || []).map((b) => {
    if (!b) return b;
    if (b.c) return { ...b, c: glueInline(b.c) };
    if (b.t === "list") return { ...b, items: b.items.map((li) => ({ ...li, c: glueInline(li.c) })) };
    if (b.t === "table")
      return { ...b, head: b.head.map(glueInline), rows: b.rows.map((row) => row.map(glueInline)) };
    return b;
  });
}
module.exports = { plain, plainAll, glueBlocks, unmark, stripTail, markBlocks };
