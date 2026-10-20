// Formulas MathJax sizes far beyond a page fall back to their TeX text instead
// of making resvg allocate gigabytes or abort the process. The oversized cases
// here are kept small enough that a broken bound costs megabytes, not the machine.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FormulaRenderer } from "../server/src/modules/render/formula.js";
import { MarkdownRenderer } from "../server/src/modules/render/markdown.js";
import { fakeServices, makeApp } from "./fixtures.js";

const dir = () => mkdtempSync(join(tmpdir(), "zhiye-formula-"));
// Each level of \left( inside a fraction doubles the height: 10 levels is about 300 em.
const nested = (n: number) =>
  String.raw`\frac{1}{\left(`.repeat(n) + "x" + String.raw`\right)}`.repeat(n);

test("formulas sized beyond a page fall back to text", async () => {
  const formulas = new FormulaRenderer(dir());
  for (const tex of [
    nested(10),
    String.raw`\rule{1em}{250em}`,
    String.raw`\raise{300em}{x}`,
    String.raw`\require{html}\style{font-size:3000em}{x}`,
    String.raw`\text{中}`.repeat(41),
  ])
    for (const display of [false, true])
      assert.equal(await formulas.render(tex, display, "#1f2937"), null, tex);
});

test("large formulas within the bounds render at a capped pixel size", async () => {
  const formulas = new FormulaRenderer(dir());
  const rows = Array.from({ length: 20 }, (_, i) => `a_{${i}} & b_{${i}}`);
  for (const [tex, display] of [
    [
      String.raw`\begin{array}{cc}${rows.join(String.raw`\\`)}\end{array}`,
      true,
    ],
    [nested(8), false],
    [String.raw`\rule{40em}{40em}`, false],
    [String.raw`\require{html}\style{font-size:300em}{x}`, false],
    ["x+".repeat(60) + "x", false],
    [String.raw`\text{中}`.repeat(40), false],
  ] as const) {
    const image = await formulas.render(tex, display, "#1f2937");
    assert.ok(image, tex);
    const png = formulas.file(image.id)!;
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    assert.ok(
      w <= 4096 && h <= 4096 && w * h <= 2_010_000,
      `${tex}: ${w}x${h}`,
    );
  }
});

test("one text packed with large formulas draws only its share", async () => {
  const md = new MarkdownRenderer(new FormulaRenderer(dir()));
  const texs = Array.from(
    { length: 30 },
    (_, i) => String.raw`\rule{40em}{40em}${i}`,
  );
  const [block] = await md.render(
    texs.map((t) => `$${t}$`).join(" "),
    "#1f2937",
  );
  assert.ok(block?.t === "p");
  const kinds = block.c.map((c) => c.t).filter((t) => t !== "text");
  const drawn = kinds.filter((t) => t === "math").length;
  assert.equal(kinds.length, 30);
  assert.ok(drawn >= 1 && drawn <= 20, `drew ${drawn}`);
  // A formula left out was not remembered as undrawable: alone it draws.
  const [alone] = await md.render(`$${texs[kinds.indexOf("tex")]}$`, "#1f2937");
  assert.ok(alone?.t === "p");
  assert.equal(alone.c[0]?.t, "math");
});

test("an answer with a runaway formula still renders the rest", async () => {
  const app = makeApp(fakeServices());
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: {},
  });
  const token = login.json().data.token as string;
  const res = await app.inject({
    method: "POST",
    url: "/v1/render",
    headers: { authorization: `Bearer ${token}` },
    payload: { text: `看 $${nested(10)}$ 和 $\\sqrt{2}$` },
  });
  assert.equal(res.statusCode, 200);
  const kinds = res.json().data.blocks[0].c.map((c: { t: string }) => c.t);
  assert.deepEqual(
    kinds.filter((t: string) => t !== "text"),
    ["tex", "math"],
  );
});
