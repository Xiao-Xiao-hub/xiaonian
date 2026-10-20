/*
 * 公式展示辅助：识别和组织单行公式内容，供页面与富文本组件生成展示块。
 * 负责表达形式转换，不负责证明公式正确或给出数学判定。
 */
const api = require("./api");
// The old problem, practice and review pages get text the model wrote with
// LaTeX in it (行内 $…$). Text that holds TeX is typeset by the server
// (POST /v1/render) and drawn with <rich>; anything else, or a failed render,
// stays plain text, so a page never waits on this.
const TONE = "light";
// A short answer such as "\frac{1}{6}" or "e^{2}" carries no $…$ of its own.
const BARE = /\\[A-Za-z]+|\^|_\{/;
const cache = new Map();
function texOf(text, inline) {
  const s = String(text || "").trim();
  if (!s) return "";
  if (s.includes("$")) return s;
  return inline && BARE.test(s) ? `$${s}$` : "";
}
// Blocks for the text, or null when it is plain or the render failed.
function blocksOf(text, opts) {
  const tex = texOf(text, Boolean(opts && opts.inline));
  if (!tex) return Promise.resolve(null);
  if (cache.has(tex)) return Promise.resolve(cache.get(tex));
  return api
    .post("/v1/render", { text: tex, tone: TONE })
    .then(({ blocks }) => {
      const out = blocks && blocks.length ? blocks : null;
      if (out) cache.set(tex, out);
      return out;
    })
    .catch(() => null);
}
// Typesets fields of the page's data in place: each [key, text, opts] that
// holds TeX is set to its blocks once they arrive; still: the page has not
// moved on to something else meanwhile.
function typeset(page, fields, still) {
  return Promise.all(
    fields.map(([key, text, opts]) =>
      blocksOf(text, opts).then((blocks) => {
        if (blocks && (!still || still())) page.setData({ [key]: blocks });
      }),
    ),
  );
}
// One line as written (a step, a problem; V4.2 FX5b, shared by step-edit,
// 批改 and 解题): all formula ("\frac{1}{2}x") is typeset whole; with words
// in it, only where it has $…$.
const WORDS = /[㐀-鿿＀-￯]/;
const wholeTex = (text) => !WORDS.test(String(text || ""));
// Whether the line has anything to typeset (known at once, no request).
const lineTex = (text) => Boolean(texOf(text, wholeTex(text)));
const lineBlocks = (text) => blocksOf(text, { inline: wholeTex(text) });
module.exports = { blocksOf, typeset, texOf, lineTex, lineBlocks };
