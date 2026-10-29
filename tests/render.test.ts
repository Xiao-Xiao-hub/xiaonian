import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FormulaRenderer,
  formulaId,
} from "../server/src/modules/render/formula.js";
import {
  MarkdownRenderer,
  answerText,
  extractMath,
  readable,
  stableLength,
} from "../server/src/modules/render/markdown.js";
import { fakeServices, makeApp } from "./fixtures.js";

const dir = () => mkdtempSync(join(tmpdir(), "zhiye-formula-"));

test("formulas are pulled out before markdown, prices stay text", () => {
  const { text, found } = extractMath(
    String.raw`价格 $5 和 $6，求 $x^2$，再看 \(\frac{a}{b}\) 和 $$\int_0^1 x\,dx$$ 以及 \[a_1*b_2\]`,
  );
  assert.deepEqual(
    found.map((m) => [m.tex, m.display]),
    [
      [String.raw`\int_0^1 x\,dx`, true],
      ["a_1*b_2", true],
      [String.raw`\frac{a}{b}`, false],
      ["x^2", false],
    ],
  );
  assert.match(text, /价格 \$5 和 \$6/);
  // Chinese prose between two dollar signs is not a formula.
  assert.equal(extractMath("花了 $3 买书，又花 $4。").found.length, 0);
});

test("markdown with maths becomes blocks with formula images", async () => {
  const md = new MarkdownRenderer(new FormulaRenderer(dir()));
  const blocks = await md.render(
    String.raw`**思路**：这是 $\frac{0}{0}$ 型。

1. 展开 $e^{3x}$
   - 注意 $o(x^2)$

$$\lim_{x\to 0}\frac{e^{3x}-1-3x}{x^{2}}=\frac{9}{2}$$

| 方法 | 结果 |
|---|---|
| 洛必达 | $\frac92$ |`,
    "#1f2937",
  );
  assert.deepEqual(
    blocks.map((b) => b.t),
    ["p", "list", "math", "table"],
  );
  const p = blocks[0]!;
  assert.ok(p.t === "p");
  assert.deepEqual(p.c[0], { t: "text", v: "思路", b: 1 });
  const inline = p.c.find((c) => c.t === "math");
  assert.ok(inline && inline.t === "math" && /^[0-9a-f]{40}$/.test(inline.id));
  assert.ok(inline.w > 0 && inline.h > 0 && inline.va < 0);
  // The source travels along for quoting, copying and a fallback when the image fails.
  assert.equal(inline.tex, String.raw`\frac{0}{0}`);
  const list = blocks[1]!;
  assert.ok(list.t === "list");
  assert.deepEqual(
    list.items.map((i) => [i.n, i.lv]),
    [
      ["1.", 0],
      ["◦", 1],
    ],
  );
  const display = blocks[2]!;
  assert.ok(display.t === "math" && display.w > 5);
  assert.match(display.tex, /^\\lim_/);
});

test("limits, integrals and fractions in a sentence are drawn full size", async () => {
  const md = new MarkdownRenderer(new FormulaRenderer(dir()));
  const lim = String.raw`\lim_{x\to 0}\frac{\sin x}{x}`;
  const blocks = await md.render(String.raw`求 $${lim}$，再看 $x^{3}$。`, "#1f2937");
  const p = blocks[0]!;
  assert.ok(p.t === "p");
  const [big, small] = p.c.filter((c) => c.t === "math") as {
    id: string;
    tex: string;
    h: number;
  }[];
  assert.equal(big!.id, formulaId(String.raw`\displaystyle ${lim}`, false, "#1f2937"));
  assert.equal(big!.tex, lim);
  assert.equal(small!.id, formulaId("x^{3}", false, "#1f2937"));
  assert.ok(big!.h > small!.h);
});

test("a long displayed equation breaks onto lines that fit a phone", async () => {
  const formulas = new FormulaRenderer(dir());
  const long = await formulas.render(
    String.raw`\int x^2 e^x\,dx = x^2 e^x - 2(xe^x - e^x) + C = (x^2 - 2x + 2)e^x + C`,
    true,
    "#1f2937",
  );
  assert.ok(long && long.w <= 18 && long.h > 3, JSON.stringify(long));
  const short = await formulas.render("x^2+1", true, "#1f2937");
  assert.ok(short && short.h < 2, JSON.stringify(short));
});

test("broken TeX falls back to its source instead of failing the reply", async () => {
  const md = new MarkdownRenderer(new FormulaRenderer(dir()));
  const blocks = await md.render(
    String.raw`看 $\frac{1}{$ 和 $\begin{x}$`,
    "#1f2937",
  );
  assert.equal(blocks.length, 1);
  const kinds = (blocks[0] as { c: { t: string }[] }).c.map((c) => c.t);
  assert.ok(kinds.includes("tex"), JSON.stringify(blocks));
});

test("titles and previews write formulas out as plain text", () => {
  assert.equal(
    readable(String.raw`求极限 $\lim_{x\to 0}\frac{e^{3x}-1-3x}{x^{2}}$。`),
    "求极限 lim(x→0) (e³ˣ-1-3x)/x²。",
  );
  assert.equal(
    readable(String.raw`设 $f(x)=\sqrt{1+x^2}$，求 $\int_0^1 \frac{\ln(1+x)}{1+x^2}dx$`),
    "设 f(x)=√(1+x²)，求 ∫₀¹ (ln(1+x))/(1+x²)dx",
  );
  assert.equal(answerText(String.raw`-\frac{1}{6}`), "-1/6");
  assert.equal(answerText("x^2e^x-2xe^x+2e^x+C"), "x²eˣ-2xeˣ+2eˣ+C");
  assert.equal(answerText("48 元"), "48 元");
  // Prices are not formulas; markdown marks go.
  assert.equal(readable("价格 $5 和 $6，**重点**"), "价格 $5 和 $6，重点");
  // ">" inside text and formulas stays; only blockquote markers at a line start go.
  assert.equal(readable("当 $x>0$ 时，a > b"), "当 x>0 时，a > b");
  assert.equal(
    readable("> 引用一句\n>> 再引用\n  > x>1"),
    "引用一句 再引用 x>1",
  );
  assert.equal(answerText("x>0"), "x>0");
  // A quote inside a list item loses its marker too; the list marker stays.
  assert.equal(readable("- > 注意：分母不能为 0"), "- 注意：分母不能为 0");
  assert.equal(readable("1. > 引用在列表里"), "1. 引用在列表里");
  // TeX \gt and \lt are written out, not dropped.
  assert.equal(
    readable(String.raw`$x \gt 0$ 且 $y \lt 1$，$a \geqslant b$`),
    "x>0 且 y<1，a≥b",
  );
});

test("streaming cuts only after finished paragraphs", () => {
  assert.equal(stableLength("第一段\n\n第二段还没写完"), "第一段\n\n".length);
  // A blank line inside a display formula or a code fence is not a cut.
  assert.equal(stableLength("a\n\n$$\nx\n\ny$$\nmore"), 3);
  assert.equal(
    stableLength("a\n\n```\ncode\n\nmore\n```\n\nb"),
    "a\n\n```\ncode\n\nmore\n```\n\n".length,
  );
  assert.equal(stableLength("没有空行"), 0);
});

test("formula images are public, cacheable and loadable cross-origin", async () => {
  const app = makeApp(fakeServices());
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: {},
  });
  const token = login.json().data.token as string;
  const denied = await app.inject({
    method: "POST",
    url: "/v1/render",
    payload: { text: "$x$" },
  });
  assert.equal(denied.statusCode, 401);
  const rendered = await app.inject({
    method: "POST",
    url: "/v1/render",
    headers: { authorization: `Bearer ${token}` },
    payload: { text: String.raw`求 $\sqrt{2}$` },
  });
  assert.equal(rendered.statusCode, 200);
  const math = rendered.json().data.blocks[0].c[1];
  assert.equal(math.t, "math");
  const image = await app.inject({
    method: "GET",
    url: `/v1/formula/${math.id}.png`,
  });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers["content-type"], "image/png");
  assert.equal(image.headers["cross-origin-resource-policy"], "cross-origin");
  assert.match(String(image.headers["cache-control"]), /immutable/);
  assert.equal(image.rawPayload.subarray(1, 4).toString(), "PNG");
  const missing = await app.inject({
    method: "GET",
    url: `/v1/formula/${"0".repeat(40)}.png`,
  });
  assert.equal(missing.statusCode, 404);
  const bad = await app.inject({
    method: "GET",
    url: "/v1/formula/..%2f..%2fapp.sqlite",
  });
  assert.equal(bad.statusCode, 404);
  await app.close();
});

test("pruning drops old cached formulas but keeps recent and remembered ones", async () => {
  const folder = dir();
  const formulas = new FormulaRenderer(folder);
  const used = await formulas.render("x^2", false, "#1f2937");
  assert.ok(used);
  const usedFile = join(folder, `${used.id}.png`);
  const old = join(folder, `${"a".repeat(40)}.png`);
  const fresh = join(folder, `${"b".repeat(40)}.png`);
  const other = join(folder, "notes.txt");
  const past = new Date(Date.now() - 40 * 86400000);
  for (const file of [old, fresh, other]) writeFileSync(file, "");
  for (const file of [old, usedFile, other]) utimesSync(file, past, past);
  assert.equal(formulas.prune(30 * 86400000), 1);
  assert.equal(existsSync(old), false);
  assert.ok(existsSync(fresh) && existsSync(other));
  assert.ok(existsSync(usedFile), "a remembered image keeps its file without a new read refreshing its age");
  // After a restart nothing is remembered: the old image goes, then comes back on use.
  const restarted = new FormulaRenderer(folder);
  assert.equal(restarted.prune(30 * 86400000), 1);
  assert.equal(restarted.file(used.id), null);
  assert.deepEqual(await restarted.render("x^2", false, "#1f2937"), used);
  assert.ok(restarted.file(used.id));
  assert.equal(new FormulaRenderer(join(folder, "missing")).prune(1), 0);
});
