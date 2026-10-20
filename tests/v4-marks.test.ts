import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FormulaRenderer } from "../server/src/modules/render/formula.js";
import {
  MarkdownRenderer,
  readable,
  unmark,
  type Block,
  type Inline,
} from "../server/src/modules/render/markdown.js";
import { validateTidy } from "../server/src/modules/cards/tidy.js";
import { MARK_RULE, tutorSystem } from "../server/src/modules/chat/prompts.js";
import { guideSystem } from "../server/src/modules/chat/guide-prompts.js";

// Colour marks, docs/mvp/progress/V4.md 约定 1.
const md = new MarkdownRenderer(new FormulaRenderer(mkdtempSync(join(tmpdir(), "zhiye-formula-"))));
const line = async (source: string): Promise<Inline[]> => {
  const blocks: Block[] = await md.render(source, "#1f2329");
  const first = blocks[0]!;
  assert.ok("c" in first, `first block is ${first.t}`);
  return first.c;
};
const words = (c: Inline[]) => c.map((x) => (x.t === "text" ? x.v : x.t === "tex" ? x.v : `$${x.tex}$`)).join("");
const marked = (c: Inline[]) => c.filter((x) => x.mk).map((x) => [x.t === "math" ? `$${x.tex}$` : (x as { v: string }).v, x.mk, x.hi ?? 0]);

test("a mark colours its words and leaves the rest plain", async () => {
  const c = await line("先看[[k:分母]]，再用[[w:等价无穷小]]。");
  assert.equal(words(c), "先看分母，再用等价无穷小。");
  assert.deepEqual(marked(c), [
    ["分母", "key", 0],
    ["等价无穷小", "way", 0],
  ]);
  assert.ok(c.filter((x) => !x.mk).every((x) => x.t === "text" && !x.v.includes("[")));
});

test("all four letters and the stronger grade with !", async () => {
  const c = await line("[[k!:必考]] [[w:换元]] [[f:公式]] [[x!:别漏 C]]");
  assert.deepEqual(marked(c), [
    ["必考", "key", 1],
    ["换元", "way", 0],
    ["公式", "fx", 0],
    ["别漏 C", "warn", 1],
  ]);
});

test("broken marks lose their syntax and show as plain text", async () => {
  for (const [source, shown] of [
    ["这里[[k:没有收尾", "这里没有收尾"],
    ["[[z:不认识的字母]]就是普通字", "不认识的字母就是普通字"],
    ["[[k:外层[[w:里层]]还在]]", "外层里层还在"],
    ["空的[[k:]]也不算", "空的也不算"],
  ]) {
    const c = await line(source!);
    assert.equal(words(c), shown, source);
    assert.deepEqual(marked(c), [], source);
  }
  // A mark does not run across lines: its opener goes, and a "]]" on a later
  // line is someone else's and stays.
  const blocks = await md.render("[[k:第一行\n\n第二行]]", "#1f2329");
  assert.ok(blocks.every((b) => !("c" in b) || b.c.every((x) => !x.mk)));
  assert.deepEqual(blocks.map((b) => ("c" in b ? words(b.c) : b.t)), ["第一行", "第二行]]"]);
});

test("marks may hold single brackets, and a run of ]]] closes on its last two", async () => {
  let c = await line("[[k:闭区间 [a,b] 上]] 和 [[w:换元]]");
  assert.equal(words(c), "闭区间 [a,b] 上 和 换元");
  assert.deepEqual(marked(c), [
    ["闭区间 [a,b] 上", "key", 0],
    ["换元", "way", 0],
  ]);
  c = await line("[[k:在 [x_0,x] 上可积]]，[[x:端点 [x_0,x]]]");
  assert.deepEqual(marked(c), [
    ["在 [x_0,x] 上可积", "key", 0],
    ["端点 [x_0,x]", "warn", 0],
  ]);
  assert.equal(unmark("在 [[k:闭区间 [a,b] 上连续]] 才行"), "在 闭区间 [a,b] 上连续 才行");
});

test("a mark cut by a line break does not eat a later ]], and code keeps its text", async () => {
  assert.equal(unmark("[[k:abc\n后面 arr[[1]] 和 m[0]]"), "abc\n后面 arr[[1]] 和 m[0]]");
  const blocks = await md.render("```\nx = [[k:abc\n```\n然后 a[b[0]]", "#1f2329");
  const code = blocks.find((b) => b.t === "code");
  assert.ok(code && code.t === "code");
  assert.equal(code.v, "x = [[k:abc");
  const para = blocks.find((b) => b.t === "p");
  assert.ok(para && para.t === "p");
  assert.equal(words(para.c), "然后 a[b[0]]");
  const c = await line("用 `[[k:x]]` 写，[[w:换元]]");
  assert.deepEqual(marked(c), [["换元", "way", 0]]);
  assert.ok(c.some((x) => x.t === "text" && x.code === 1 && x.v === "[[k:x]]"));
});

test("a spaced opener shows plain words; an escaped one loses its backslash", async () => {
  let c = await line("[[k :空格]] 和 [[ w:也是]]");
  assert.equal(words(c), "空格 和 也是");
  assert.deepEqual(marked(c), []);
  c = await line("\\[[k:x 的值]] 和 [[w:换元]]");
  assert.equal(words(c), "x 的值 和 换元");
  assert.deepEqual(marked(c), [
    ["x 的值", "key", 0],
    ["换元", "way", 0],
  ]);
});

test("tidy keeps marks with brackets and cuts slots by visible characters", () => {
  const card = { type: "idea", quote: "端点 x_0 处先约分再求导" } as unknown as Parameters<typeof validateTidy>[1];
  const slots = (text: string) =>
    validateTidy(
      { title: "t", summary: "s", slots: [{ key: "claim", text }], open: [], followup: { q: "q", options: ["a", "b"] }, tags: [] },
      card,
    ).slots[0]!.text;
  assert.equal(slots("在 [[k:闭区间 [a,b] 上连续]] 才行"), "在 [[k:闭区间 [a,b] 上连续]] 才行");
  assert.equal(slots("[[x:端点 [x_0,x]]] 要算"), "[[x:端点 [x_0,x]]] 要算");
  assert.equal(slots("[[k :空格]]和\\[[w:换元]]"), "空格和[[w:换元]]");
  const head = "一".repeat(57);
  // 57 + 3 visible: the cut counts visible characters only, but with its
  // syntax the stored text would pass 60 (older servers check the raw
  // column), so the slot keeps its words without the mark.
  assert.equal(slots(`${head}[[k:abc]]后面`), `${head}abc`);
  // A mark that fits with its syntax stays.
  assert.equal(slots(`${"一".repeat(50)}[[k:abc]]后`), `${"一".repeat(50)}[[k:abc]]后`);
  // The cut runs through the mark: its syntax goes, no stray "]".
  assert.equal(slots(`${head}[[k:abcdef]]`), `${head}abc`);
  assert.equal(slots(`${"一".repeat(59)}[[k:abc]]`), `${"一".repeat(59)}a`);
  // Static text keeps a final "[".
  assert.equal(slots("x ["), "x [");
});

test("a formula inside a mark gets the same mark, bold keeps working", async () => {
  const c = await line(String.raw`[[f!:$\frac{a}{b}$ 的导数]]，[[k:**先**约分]]`);
  const math = c.find((x) => x.t === "math" || x.t === "tex")!;
  assert.equal(math.mk, "fx");
  assert.equal(math.hi, 1);
  assert.deepEqual(
    c.filter((x) => x.t === "text" && x.mk).map((x) => [(x as { v: string }).v, x.mk, (x as { b?: 1 }).b ?? 0]),
    [
      [" 的导数", "fx", 0],
      ["先", "key", 1],
      ["约分", "key", 0],
    ],
  );
  assert.ok(c.filter((x) => x.mk === "fx").every((x) => x.hi === 1));
});

test("lists, headings and tables carry marks; code shows the syntax as written", async () => {
  const blocks = await md.render("1. 第一步[[w:配方]]\n\n| a | b |\n|---|---|\n| [[x:符号]] | 2 |\n\n```\n[[k:代码]]\n```", "#1f2329");
  const list = blocks.find((b) => b.t === "list");
  assert.ok(list && list.t === "list");
  assert.deepEqual(marked(list.items[0]!.c), [["配方", "way", 0]]);
  const table = blocks.find((b) => b.t === "table");
  assert.ok(table && table.t === "table");
  assert.deepEqual(marked(table.rows[0]![0]!), [["符号", "warn", 0]]);
  const code = blocks.find((b) => b.t === "code");
  assert.ok(code && code.t === "code");
  assert.equal(code.v, "[[k:代码]]");
});

test("plain text drops the marks", () => {
  assert.equal(unmark("先看[[k!:分母]]，[[x:别漏]]"), "先看分母，别漏");
  assert.equal(unmark("没关上[[k:半句"), "没关上半句");
  assert.doesNotMatch(readable("先看[[k:分母]]，再用 [[f:$x^2$]]。"), /\[\[|\]\]/);
});

test("answer prompts ask for marks; tidy keeps them in slots only", () => {
  assert.ok(MARK_RULE.includes("每段最多两三处"));
  assert.ok(tutorSystem("auto", {}).includes(MARK_RULE));
  assert.ok(tutorSystem("solution", {}).includes("[[k:…]]"));
  assert.ok(guideSystem("life", true).includes(MARK_RULE));
  assert.ok(!guideSystem("life", false).includes(MARK_RULE));
  const card = { type: "idea", quote: "先约分再求导" } as unknown as Parameters<typeof validateTidy>[1];
  const out = validateTidy(
    {
      title: "[[k:约分]]",
      summary: "先[[w:约分]]。",
      slots: [{ key: "claim", text: "先[[k:约分]]再[[w:求导" }],
      open: [],
      followup: { q: "[[k:哪一步]]难？", options: ["约分", "求导"] },
      tags: ["[[k:导数]]"],
    },
    card,
  );
  assert.equal(out.title, "约分");
  assert.equal(out.summary, "先约分。");
  assert.equal(out.followup?.q, "哪一步难？");
  assert.deepEqual(out.tags, ["导数"]);
  assert.deepEqual(out.slots, [{ key: "claim", text: "先[[k:约分]]再求导" }]);
});
