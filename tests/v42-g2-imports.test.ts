// import segmentation, docx/PDF reading, all split batches, the
// seven kinds carried to saved cards, image classification, editable
// segments and the text past the limit. Synthetic data only.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { KIND_TYPE, defaultFollow } from "../server/src/modules/cards/types.js";
import { readDocxText } from "../server/src/modules/imports/docx.js";
import { M_NS, ommlToLatex } from "../server/src/modules/imports/omml.js";
import {
  defaultImportFileTools,
  pdfParagraphs,
  type ImportFileTools,
} from "../server/src/modules/imports/parser.js";
import { segmentText } from "../server/src/modules/imports/segment.js";
import { ocrParagraphs } from "../server/src/modules/imports/service.js";
import { SqliteStore } from "../server/src/shared/store.js";

const require = createRequire(new URL("../server/package.json", import.meta.url));
const JSZip = require("jszip") as {
  new (): {
    file(name: string, data: string): void;
    generateAsync(options: { type: "nodebuffer" }): Promise<Buffer>;
  };
};
const { DOMParser } = require("@xmldom/xmldom") as {
  DOMParser: new () => { parseFromString(xml: string, type: string): unknown };
};

// ---------------------------------------------------------------- segments

const CALCULUS = `第一章 函数与极限

1.1 数列的极限
设 {x_n} 是一个数列，如果存在常数 a，对任意给定的正数 ε，
总存在正整数 N，使得当 n > N 时不等式
|x_n - a| < ε
都成立，就称 a 是数列的极限，记作
$$\\lim_{n\\to\\infty} x_n = a$$
其中 N 依赖于 ε 的取法。

例 1
证明数列 1/n 的极限是 0。

下列说法正确的是：
A. 收敛数列一定有界
B. 有界数列一定收敛
C. 单调数列一定收敛
D. 以上都不对

1.2 函数的极限
函数极限和数列极限的区别在于自变量的变化方式，可以是 x 趋于某个点，也可以是 x 趋于无穷。`;

test("calculus notes split on paragraphs; a formula stays with its sentence", () => {
  const segments = segmentText(CALCULUS);
  assert.equal(segments.length, 4, JSON.stringify(segments, null, 1));
  // The headings join the paragraph they open; the wrapped lines, the two
  // formulas and the 其中 sentence after them are one segment.
  assert.match(segments[0]!, /^第一章 函数与极限\n1\.1 数列的极限\n设/);
  assert.match(segments[0]!, /\|x_n - a\| < ε\n都成立/);
  assert.match(segments[0]!, /记作\n\$\$\\lim_\{n\\to\\infty\} x_n = a\$\$\n其中/);
  // A label line goes with its problem; options stay with their stem.
  assert.equal(segments[1], "例 1\n证明数列 1/n 的极限是 0。");
  assert.match(segments[2]!, /^下列说法正确的是：\nA\. .*\nB\. .*\nC\. .*\nD\. 以上都不对$/);
  assert.match(segments[3]!, /^1\.2 函数的极限\n函数极限/);
});

test("pasted text: one paragraph per line; a short tail joins its neighbour; 例如 / 定义 inside a sentence is not an item", () => {
  const pasted = [
    "复习高数的时候，我发现最容易忘的是极限的几种定义方式，尤其是 ε-δ 的写法。",
    "所以我把每种定义都抄了一遍，然后自己默写，错了就再看。",
    "好。",
    "例如求导的时候，定义法总是写不完整，后来我改成先画图再写式子，慢慢就顺了。",
    "定义，是这门课最先要背下来的东西，背熟了做题会快很多，这一点老师也反复说过。",
  ].join("\n");
  const segments = segmentText(pasted);
  assert.deepEqual(segments, [
    "复习高数的时候，我发现最容易忘的是极限的几种定义方式，尤其是 ε-δ 的写法。",
    "所以我把每种定义都抄了一遍，然后自己默写，错了就再看。\n好。",
    "例如求导的时候，定义法总是写不完整，后来我改成先画图再写式子，慢慢就顺了。",
    "定义，是这门课最先要背下来的东西，背熟了做题会快很多，这一点老师也反复说过。",
  ]);
  // Real paragraphs (blank lines between) keep their single line breaks.
  const soft = segmentText(
    "第一段的第一行，写到一半\n接着写完第一段。\n\n第二段只有一行，但是也足够长了，不会被并进去。",
  );
  assert.deepEqual(soft, [
    "第一段的第一行，写到一半\n接着写完第一段。",
    "第二段只有一行，但是也足够长了，不会被并进去。",
  ]);
  // A very long paragraph is cut at sentence ends, never mid-sentence.
  const long = segmentText("这是一句不短不长的话，用来凑够长度。".repeat(60));
  assert.ok(long.length >= 2);
  for (const part of long) {
    assert.ok(Array.from(part).length <= 600);
    assert.match(part, /。$/);
  }
});

test("PDF lines are rebuilt into paragraphs", () => {
  const line = (str: string, y: number, x = 72) => ({
    str,
    x,
    y,
    w: Array.from(str).length * 10,
    h: 10,
  });
  const text = pdfParagraphs([
    line("第二章 导数", 760),
    line("导数描述函数在一点附近的变化快慢。设函数在点 x0 的某个邻域内有", 730, 92),
    line("定义，当自变量的增量趋于零时，增量之比的极限存在，就称函数在该", 715),
    line("点可导。", 700),
    line("几何上，导数是曲线在该点切线的斜率，这一点在做题时经常用到，", 685, 92),
    line("特别是求切线方程的题目。", 670),
    line("1. 求 y = x^2 在 x = 1 处的导数。", 640),
    line("2. 求曲线 y = sin x 在原点处的切线。", 625),
  ]);
  assert.equal(
    text,
    [
      "第二章 导数",
      "导数描述函数在一点附近的变化快慢。设函数在点 x0 的某个邻域内有定义，当自变量的增量趋于零时，增量之比的极限存在，就称函数在该点可导。",
      "几何上，导数是曲线在该点切线的斜率，这一点在做题时经常用到，特别是求切线方程的题目。",
      "1. 求 y = x^2 在 x = 1 处的导数。",
      "2. 求曲线 y = sin x 在原点处的切线。",
    ].join("\n\n"),
  );
  assert.deepEqual(segmentText(text), [
    "第二章 导数\n导数描述函数在一点附近的变化快慢。设函数在点 x0 的某个邻域内有定义，当自变量的增量趋于零时，增量之比的极限存在，就称函数在该点可导。",
    "几何上，导数是曲线在该点切线的斜率，这一点在做题时经常用到，特别是求切线方程的题目。",
    "1. 求 y = x^2 在 x = 1 处的导数。\n2. 求曲线 y = sin x 在原点处的切线。",
  ]);
  // Latin words broken by a hyphen at a line end are joined.
  assert.equal(
    pdfParagraphs([
      line("The derivative measures how fast a func-", 700),
      line("tion changes near a point.", 685),
    ]),
    "The derivative measures how fast a function changes near a point.",
  );
});

test("OCR lines of one paragraph make one segment", () => {
  assert.deepEqual(
    ocrParagraphs([
      { text: "函数在一点连续，是指当自变量", paragraph: 1 },
      { text: "趋于该点时函数值趋于该点的函数值。", paragraph: 1 },
      { text: "y = f(x)", paragraph: 2 },
      { text: "连续函数的和、差、积仍然连续，这是做题时最常用的性质。", paragraph: 3 },
    ]),
    [
      "函数在一点连续，是指当自变量趋于该点时函数值趋于该点的函数值。\ny = f(x)",
      "连续函数的和、差、积仍然连续，这是做题时最常用的性质。",
    ],
  );
  // Without paragraph numbers the lines are segmented like pasted text.
  assert.deepEqual(
    ocrParagraphs([
      { text: "第一行写到一半，", paragraph: null },
      { text: "第二行把这句话写完。", paragraph: null },
    ]),
    ["第一行写到一半，\n第二行把这句话写完。"],
  );
});

// ---------------------------------------------------------------- OMML

const r = (text: string) => `<m:r><m:t>${text}</m:t></m:r>`;
const e = (inner: string) => `<m:e>${inner}</m:e>`;
const math = (inner: string) => {
  const xml = `<m:oMath xmlns:m="${M_NS}" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${inner}</m:oMath>`;
  const doc = new DOMParser().parseFromString(xml, "text/xml") as {
    documentElement: Parameters<typeof ommlToLatex>[0];
  };
  return ommlToLatex(doc.documentElement);
};

test("Office Math becomes LaTeX for every construct notes use", () => {
  const cases: [string, string][] = [
    [`<m:f><m:num>${r("a")}</m:num><m:den>${r("b")}</m:den></m:f>`, "\\frac{a}{b}"],
    [`<m:f><m:fPr><m:type m:val="lin"/></m:fPr><m:num>${r("a")}</m:num><m:den>${r("b")}</m:den></m:f>`, "a/b"],
    [`<m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num>${r("n")}</m:num><m:den>${r("k")}</m:den></m:f>`, "{n \\atop k}"],
    [`<m:sSup>${e(r("x"))}<m:sup>${r("2")}</m:sup></m:sSup>`, "{x}^{2}"],
    [`<m:sSub>${e(r("a"))}<m:sub>${r("n")}</m:sub></m:sSub>`, "{a}_{n}"],
    [`<m:sSubSup>${e(r("a"))}<m:sub>${r("n")}</m:sub><m:sup>${r("2")}</m:sup></m:sSubSup>`, "{a}_{n}^{2}"],
    [`<m:sPre><m:sub>${r("1")}</m:sub><m:sup>${r("2")}</m:sup>${e(r("X"))}</m:sPre>`, "{}_{1}^{2}{X}"],
    [`<m:rad><m:deg>${r("3")}</m:deg>${e(r("x"))}</m:rad>`, "\\sqrt[3]{x}"],
    [`<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/>${e(r("y"))}</m:rad>`, "\\sqrt{y}"],
    [`<m:nary><m:naryPr><m:chr m:val="∫"/></m:naryPr><m:sub>${r("a")}</m:sub><m:sup>${r("b")}</m:sup>${e(r("f(x)dx"))}</m:nary>`, "\\int_{a}^{b} f(x)dx"],
    [`<m:nary><m:naryPr><m:chr m:val="∑"/><m:supHide m:val="1"/></m:naryPr><m:sub>${r("k")}</m:sub><m:sup/>${e(r("k"))}</m:nary>`, "\\sum_{k} k"],
    [`<m:nary><m:naryPr><m:chr m:val="∏"/></m:naryPr><m:sub>${r("i=1")}</m:sub><m:sup>${r("n")}</m:sup>${e(r("i"))}</m:nary>`, "\\prod_{i=1}^{n} i"],
    [`<m:d>${e(r("α+β"))}</m:d>`, "\\left(\\alpha +\\beta \\right)"],
    [`<m:d><m:dPr><m:begChr m:val="|"/><m:endChr m:val="|"/></m:dPr>${e(r("x"))}</m:d>`, "\\left|x\\right|"],
    [`<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val=""/></m:dPr>${e(r("a"))}${e(r("b"))}</m:d>`, "\\left[a|b\\right."],
    [`<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr>${e(`<m:m><m:mr>${e(r("1"))}${e(r("0"))}</m:mr><m:mr>${e(r("0"))}${e(r("1"))}</m:mr></m:m>`)}</m:d>`, "\\begin{bmatrix}1 & 0 \\\\ 0 & 1\\end{bmatrix}"],
    [`<m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val=""/></m:dPr>${e(`<m:eqArr>${e(r("x,x≥0"))}${e(r("−x,x&lt;0"))}</m:eqArr>`)}</m:d>`, "\\begin{cases}x,x\\ge 0 \\\\ -x,x<0\\end{cases}"],
    [`<m:eqArr>${e(r("a=b"))}${e(r("c=d"))}</m:eqArr>`, "\\begin{aligned}a=b \\\\ c=d\\end{aligned}"],
    [`<m:m><m:mr>${e(r("a"))}${e(r("b"))}</m:mr></m:m>`, "\\begin{matrix}a & b\\end{matrix}"],
    [`<m:func><m:fName>${r("sin")}</m:fName>${e(r("x"))}</m:func>`, "\\sin{x}"],
    [`<m:func><m:fName>${r("sgn")}</m:fName>${e(r("x"))}</m:func>`, "\\operatorname{sgn}{x}"],
    [`<m:func><m:fName><m:limLow>${e(r("lim"))}<m:lim>${r("x→0")}</m:lim></m:limLow></m:fName>${e(r("f(x)"))}</m:func>`, "\\lim_{x\\to 0}{f(x)}"],
    [`<m:limLow>${e(r("A"))}<m:lim>${r("n")}</m:lim></m:limLow>`, "\\underset{n}{A}"],
    [`<m:limUpp>${e(r("A"))}<m:lim>${r("def")}</m:lim></m:limUpp>`, "\\overset{def}{A}"],
    [`<m:acc><m:accPr><m:chr m:val="⃗"/></m:accPr>${e(r("v"))}</m:acc>`, "\\vec{v}"],
    [`<m:acc>${e(r("a"))}</m:acc>`, "\\hat{a}"],
    [`<m:bar><m:barPr><m:pos m:val="top"/></m:barPr>${e(r("z"))}</m:bar>`, "\\overline{z}"],
    [`<m:bar>${e(r("z"))}</m:bar>`, "\\underline{z}"],
    [`<m:groupChr>${e(r("a+b"))}</m:groupChr>`, "\\underbrace{a+b}"],
    [`<m:borderBox>${e(r("x=1"))}</m:borderBox>`, "x=1"],
    [`<m:box>${e(r("y"))}</m:box>`, "y"],
    [r("x≤∞且x≠0"), "\\text{x≤∞且x≠0}"],
    [r("ln x+e^x"), "\\ln x+e^x"],
  ];
  for (const [xml, latex] of cases) assert.equal(math(xml), latex, xml);
});

// ---------------------------------------------------------------- docx

const W_DOC = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="${M_NS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}<w:sectPr/></w:body></w:document>`;
async function docx(body: string) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
  );
  zip.file("word/document.xml", W_DOC(body));
  return zip.generateAsync({ type: "nodebuffer" });
}
const p = (inner: string) => `<w:p>${inner}</w:p>`;
const wr = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const NOTES_DOCX = [
  p(wr("第三章 积分")),
  p(`${wr("定积分的几何意义是曲边梯形的面积，")}<w:r><w:br/></w:r>${wr("换行后还是同一段。")}`),
  p(
    `${wr("留下的字")}<w:del><w:r><w:delText>删掉的字</w:delText></w:r></w:del><w:ins>${wr("插入的字")}</w:ins><w:moveFrom>${wr("挪走的字")}</w:moveFrom><w:moveTo>${wr("挪来的字")}</w:moveTo>` +
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "x" </w:instrText></w:r><w:hyperlink>${wr("链接文字")}</w:hyperlink>` +
      `${wr("，分数 ")}<m:oMath><m:f><m:num>${r("a")}</m:num><m:den>${r("b")}</m:den></m:f></m:oMath>${wr(" 和平方 ")}<m:oMath><m:sSup>${e(r("x"))}<m:sup>${r("2")}</m:sup></m:sSup></m:oMath>${wr("。")}`,
  ),
  p(wr("牛顿莱布尼茨公式写成：")),
  p(
    `<m:oMathPara><m:oMath><m:nary><m:naryPr><m:chr m:val="∫"/></m:naryPr><m:sub>${r("a")}</m:sub><m:sup>${r("b")}</m:sup>${e(r("f(x)dx=F(b)−F(a)"))}</m:nary></m:oMath></m:oMathPara>`,
  ),
  `<w:tbl><w:tr><w:tc>${p(wr("函数"))}</w:tc><w:tc>${p(wr("导数"))}</w:tc></w:tr><w:tr><w:tc>${p(`<m:oMath><m:sSup>${e(r("x"))}<m:sup>${r("n")}</m:sup></m:sSup></m:oMath>`)}</w:tc><w:tc>${p(`<m:oMath>${r("n")}<m:sSup>${e(r("x"))}<m:sup>${r("n−1")}</m:sup></m:sSup></m:oMath>`)}</w:tc></w:tr></w:tbl>`,
  p(
    `<mc:AlternateContent><mc:Choice Requires="wps">${wr("文本框里的字是这一段的一部分，")}</mc:Choice><mc:Fallback>${wr("备用里的字")}</mc:Fallback></mc:AlternateContent>${wr("读一遍就够了。")}`,
  ),
  p(
    `${wr("这个公式是图片，没法读出来：")}<w:r><w:object><v:shape id="s1"><v:imagedata r:id="rId9"/></v:shape><o:OLEObject Type="Embed" ProgID="Equation.DSMT4" ShapeID="s1"/></w:object></w:r><w:r><w:drawing><wp:inline/></w:drawing></w:r>`,
  ),
].join("");

test("a docx is read in order with formulas, line breaks, tables and tracked changes", async () => {
  const read = await readDocxText(await docx(NOTES_DOCX));
  assert.equal(read.mathImages, 1);
  assert.equal(read.images, 1);
  assert.equal(
    read.text,
    [
      "第三章 积分",
      "定积分的几何意义是曲边梯形的面积，\n换行后还是同一段。",
      "留下的字插入的字挪来的字链接文字，分数 $\\frac{a}{b}$ 和平方 ${x}^{2}$。",
      "牛顿莱布尼茨公式写成：",
      "$$\\int_{a}^{b} f(x)dx=F(b)-F(a)$$",
      "函数 | 导数\n${x}^{n}$ | $n{x}^{n-1}$",
      "文本框里的字是这一段的一部分，读一遍就够了。",
      "这个公式是图片，没法读出来：",
    ].join("\n\n"),
  );
  assert.doesNotMatch(read.text, /删掉|挪走|HYPERLINK|备用/);
  const segments = segmentText(read.text);
  // The display formula stays with the sentence that introduces it.
  assert.ok(
    segments.includes(
      "牛顿莱布尼茨公式写成：\n$$\\int_{a}^{b} f(x)dx=F(b)-F(a)$$",
    ),
    JSON.stringify(segments, null, 1),
  );
  assert.equal(segments[0], "第三章 积分\n定积分的几何意义是曲边梯形的面积，\n换行后还是同一段。");
  // An inline display paragraph inside a w:p (oMathPara among runs).
  const inline = await readDocxText(
    await docx(
      p(`${wr("由此得到")}<m:oMathPara><m:oMath>${r("y=2x")}</m:oMath></m:oMathPara>${wr("这就是切线。")}`),
    ),
  );
  assert.equal(inline.text, "由此得到\n$$y=2x$$\n这就是切线。");
});

// ---------------------------------------------------------------- service

const usage = { prompt_tokens: 3, completion_tokens: 2 };
type Vision = { chat?: boolean; lines?: { who: string; text: string }[]; paragraphs?: string[] };
function fake(options: { split?: (index: number, segments: { n: number }[], retry: boolean) => unknown; vision?: Vision[] } = {}) {
  const calls: { kind: string; body: { messages: { role: string; content: unknown }[] } }[] = [];
  const sse = (content: string) =>
    new Response(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}`,
        `data: ${JSON.stringify({ choices: [], usage })}`,
        "data: [DONE]",
        "",
      ].join("\n"),
      { headers: { "content-type": "text/event-stream" } },
    );
  let splits = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      const q = body.questions.q;
      return new Response(
        JSON.stringify({
          answers: {
            q:
              q.type === "noul"
                ? { noul: 0 }
                : { choice: "none", confidence: 0.9, probabilities: { none: 0.9 } },
          },
        }),
      );
    }
    const system = String(body.messages[0].content);
    if (system.includes("[IMPORT_SPLIT]")) {
      calls.push({ kind: "split", body });
      const user = JSON.parse(String(body.messages[1].content)) as {
        segments: { n: number }[];
      };
      const retry = body.messages.length > 2;
      if (!retry) splits++;
      // The batch this call is for (a retry is the same batch).
      const cards = options.split?.(splits - 1, user.segments, retry) ?? {
        cards: [
          {
            type: "knowledge",
            scene: "study",
            title: "极限的定义",
            summary: "数列极限用 ε-N 说清楚",
            src: [user.segments[0]!.n],
            tags: [],
          },
        ],
      };
      return sse(JSON.stringify(cards));
    }
    calls.push({ kind: system.includes("聊天截图") ? "image" : "vision", body });
    const content = options.vision?.shift() ?? { paragraphs: ["照片里认出来的一段正文，足够长不会被并掉。"] };
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage }),
    );
  }) as typeof fetch;
  return { fetcher, calls };
}
function setup(options: Parameters<typeof fake>[0] = {}, tools: Partial<ImportFileTools> = {}) {
  const f = fake(options);
  const store = new SqliteStore(":memory:");
  const app = buildApp({
    store,
    importTools: {
      readDocx: defaultImportFileTools.readDocx,
      readDocxFull: defaultImportFileTools.readDocxFull,
      readPdf: async () => ({ totalPages: 1, pages: [] }),
      rasterizePdfPage: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      ...tools,
    },
    fetcher: f.fetcher,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-g2-")),
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-g2-formula-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "fake",
      JEV_API_KEY: "fake",
      OCR_VISION_MODEL: "fake-vision",
      DAILY_OCR_LIMIT: "20",
      DAILY_IMPORT_LIMIT: "10",
      JOB_CONCURRENCY: "1",
    }),
  });
  return { app, store, ...f };
}
async function session(app: ReturnType<typeof buildApp>, key = "g2-owner") {
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: { key },
  });
  const token = login.json().data.token as string;
  return (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      payload: payload as string,
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
}
type Call = Awaited<ReturnType<typeof session>>;
async function settle(call: Call, jobId: string) {
  for (let i = 0; i < 1000; i++) {
    const job = (await call("GET", `/v1/jobs/${jobId}`)).json().data;
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("job did not settle");
}
function multipart(data: Buffer, filename: string) {
  const boundary = "----zhiye-g2-boundary";
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
const png = (seed: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, seed),
  ]);
// n paragraphs of about `size` characters each, blank lines between.
const paragraphs = (n: number, size = 480) =>
  Array.from({ length: n }, (_, i) => {
    const head = `第${i + 1}段笔记讲的是极限与连续里的一个小结论。`;
    return (head + "函数在这一点附近的取值越来越接近同一个数。".repeat(40)).slice(0, size - 1) + "。";
  }).join("\n\n");

test("every split batch is sent; a wrong answer is retried once with what was wrong; kinds reach the saved cards", async () => {
  const f = setup({
    split: (index, segments, retry) => {
      const card = (type: string, offset = 0, title = `第${index + 1}批卡`) => ({
        type,
        scene: "study",
        title,
        summary: "这一批原文里的一个要点",
        src: [segments[Math.min(offset, segments.length - 1)]!.n],
        tags: [],
      });
      // The first batch answers with too many cards; the retry is right.
      if (index === 0 && !retry)
        return {
          cards: Array.from({ length: 10 }, (_, i) => card("todo", i, `要做的事${i + 1}`)),
        };
      return {
        cards: [
          card(index === 1 ? "todo" : index === 2 ? "knowledge" : "note"),
          card("question", 1, `第${index + 1}批问题`),
        ],
      };
    },
  });
  try {
    const call = await session(f.app);
    const text = paragraphs(40);
    const created = (
      await call("POST", "/v1/imports", { clientId: "g2-batches", text })
    ).json().data.import;
    assert.equal(created.status, "read");
    assert.equal(created.segments.length, 40);
    const split = (
      await call("POST", `/v1/imports/${created.id}/cards`, { clientId: "g2-split" })
    ).json().data.import;
    const job = await settle(call, split.job.id);
    assert.equal(job.status, "succeeded", JSON.stringify(job));
    const splits = f.calls.filter((item) => item.kind === "split");
    // 40 × 480 characters in batches of up to 6000: four batches, all sent,
    // plus one retry of the first.
    assert.equal(splits.length, 5);
    const retry = splits[1]!.body.messages;
    assert.equal(retry.length, 4);
    assert.equal(retry[2]!.role, "assistant");
    assert.match(String(retry[3]!.content), /^上面的输出不符合要求：cards/);
    const sent = new Set(
      splits.flatMap((item) =>
        (JSON.parse(String(item.body.messages[1]!.content)).segments as { n: number }[]).map(
          (segment) => segment.n,
        ),
      ),
    );
    assert.equal(sent.size, 40, "every segment went to a batch");
    // The system prompt names the seven kinds and the cap.
    assert.match(String(splits[0]!.body.messages[0]!.content), /最多 8 张/);
    assert.match(String(splits[0]!.body.messages[0]!.content), /todo\|knowledge\|note/);

    const ready = (await call("GET", `/v1/imports/${created.id}`)).json().data;
    assert.equal(ready.status, "picking");
    const candidates = ready.candidates as { id: string; type: string; kind: string; title: string }[];
    assert.ok(candidates.some((c) => c.title.startsWith("第4批")), "the fourth batch made cards");
    for (const candidate of candidates)
      assert.equal(candidate.type, KIND_TYPE[candidate.kind as keyof typeof KIND_TYPE]);
    const todo = candidates.find((c) => c.kind === "todo")!;
    const knowledge = candidates.find((c) => c.kind === "knowledge")!;
    assert.equal(todo.type, "idea");
    assert.equal(knowledge.type, "method");
    assert.ok(candidates.filter((c) => c.title.startsWith("要做的事")).length <= 8);

    const saved = await call("POST", `/v1/imports/${created.id}/save`, {
      clientId: "g2-save",
      selections: [
        // An old client sends only the candidate: the kind still comes along.
        { candidateId: todo.id },
        // A new client changes the kind and rewrites the summary.
        { candidateId: knowledge.id, kind: "question", summary: "改过的一句摘要" },
      ],
    });
    assert.equal(saved.statusCode, 200, saved.body);
    // A sentence picked from the text is saved on its own: an old client's
    // with a four-way type, a new client's with one of the seven kinds.
    const quoted = [];
    for (const [i, selection] of [
      { quote: "介值定理和最值定理都要会用", type: "method", scene: "study" },
      { quote: "介值定理和最值定理都要会用", kind: "note", scene: "study" },
    ].entries()) {
      const other = (
        await call("POST", "/v1/imports", {
          clientId: `g2-quote-${i}`,
          text: "第二份笔记讲连续函数的性质，介值定理和最值定理都要会用。",
        })
      ).json().data.import;
      const otherSplit = (
        await call("POST", `/v1/imports/${other.id}/cards`, { clientId: `g2-quote-split-${i}` })
      ).json().data.import;
      assert.equal((await settle(call, otherSplit.job.id)).status, "succeeded");
      const one = await call("POST", `/v1/imports/${other.id}/save`, {
        clientId: `g2-quote-save-${i}`,
        selections: [selection],
      });
      assert.equal(one.statusCode, 200, one.body);
      quoted.push(...one.json().data.cards);
    }
    const cards = [...saved.json().data.cards, ...quoted] as {
      kind: string;
      type: string;
      follow: string;
      summary: string | null;
    }[];
    assert.deepEqual(
      cards.map((card) => [card.kind, card.type]),
      [
        ["todo", "idea"],
        ["question", "question"],
        ["method", "method"],
        ["note", "idea"],
      ],
    );
    assert.equal(cards[0]!.follow, defaultFollow("todo", "study"));
    assert.equal(cards[3]!.follow, defaultFollow("note", "study"));
    assert.equal(cards[1]!.summary, "改过的一句摘要");
  } finally {
    await f.app.close();
  }
});

test("a screenshot is read as a chat or as a page in the same call; an empty page can be retried", async () => {
  const f = setup({
    vision: [
      {
        chat: false,
        paragraphs: [
          "导数的定义：函数在一点的导数是增量之比的极限，",
          "$$f'(x_0)=\\lim_{\\Delta x\\to 0}\\frac{\\Delta y}{\\Delta x}$$",
          "这是课本第二章开头的内容，后面的例题都从这里出发。",
        ],
      },
      { chat: false, paragraphs: [] },
      {
        chat: true,
        lines: [
          { who: "other", text: "明天考第几章？" },
          { who: "me", text: "第二章，导数和微分。" },
        ],
      },
    ],
  });
  try {
    const call = await session(f.app);
    const upload = (clientId: string, index: number, count: number) => {
      const part = multipart(png(index + 1), `s${index}.png`);
      return call(
        "POST",
        `/v1/imports/photo?clientId=${clientId}&source=screenshot&index=${index}&count=${count}`,
        part.payload,
        part.headers,
      );
    };
    await upload("g2-shots", 0, 2);
    const second = (await upload("g2-shots", 1, 2)).json().data.import;
    await settle(call, second.job.id);
    const read = (await call("GET", `/v1/imports/${second.id}`)).json().data;
    assert.deepEqual(
      f.calls.map((item) => item.kind),
      ["image", "image"],
    );
    // A page of notes: the formula stays with its sentence, nobody's words.
    assert.equal(read.segments.length, 2, JSON.stringify(read.segments));
    assert.match(read.segments[0].text, /的极限，\n\$\$f'/);
    assert.ok(read.segments.every((segment: { who?: string }) => !segment.who));
    // The empty second page is a failed page, offered again.
    assert.equal(read.pages[1].ok, false);
    assert.equal(read.partial, true);
    assert.equal(read.retryPages, 1);

    const chat = (await upload("g2-chat", 0, 1)).json().data.import;
    await settle(call, chat.job.id);
    const lines = (await call("GET", `/v1/imports/${chat.id}`)).json().data.segments;
    assert.deepEqual(
      lines.map((line: { who: string; text: string }) => [line.who, line.text]),
      [
        ["other", "明天考第几章？"],
        ["me", "第二章，导数和微分。"],
      ],
    );
  } finally {
    await f.app.close();
  }
});

test("a docx import keeps its formulas and says how many pictures were not read", async () => {
  const f = setup();
  try {
    const call = await session(f.app);
    const file = multipart(await docx(NOTES_DOCX), "积分笔记.docx");
    const created = await call(
      "POST",
      "/v1/imports/file?clientId=g2-docx",
      file.payload,
      file.headers,
    );
    assert.equal(created.statusCode, 200, created.body);
    const view = created.json().data.import;
    assert.equal(view.source, "docx");
    assert.deepEqual(view.unread, { formulas: 1, images: 1 });
    assert.ok(
      view.segments.some((segment: { text: string }) => segment.text.includes("$$\\int_{a}^{b}")),
    );
    // Only pictures: the user is told to send a screenshot instead.
    const pictures = multipart(
      await docx(
        p(`<w:r><w:object><o:OLEObject ProgID="Equation.3"/></w:object></w:r>`),
      ),
      "图片.docx",
    );
    const empty = await call(
      "POST",
      "/v1/imports/file?clientId=g2-docx-empty",
      pictures.payload,
      pictures.headers,
    );
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.json().message, "文件里只有图片，没读到文字，截图后再导试试");
  } finally {
    await f.app.close();
  }
});

test("segments can be fixed, merged and split before splitting; the text past the limit is the next import", async () => {
  const f = setup();
  try {
    const call = await session(f.app);
    const created = (
      await call("POST", "/v1/imports", {
        clientId: "g2-edit",
        text: "第一段讲极限的定义，写得比较完整，也给了几个例子。\n\n第二段讲极限的性质，唯一性、有界性和保号性。\n\n第三段讲两个重要极限，要背下来，考试常考。",
      })
    ).json().data.import;
    assert.equal(created.segments.length, 3);
    const edited = await call("PATCH", `/v1/imports/${created.id}`, {
      segments: [
        // 1 and 2 merged, 3 split in two, one fixed by hand.
        { text: "第一段讲极限的定义，写得比较完整。\n第二段讲极限的性质，唯一性和有界性。", from: 1 },
        { text: "第三段讲两个重要极限，", from: 3 },
        { text: "要背下来，考试常考。", from: 3 },
      ],
    });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.deepEqual(
      edited.json().data.import.segments.map((s: { n: number; text: string }) => [s.n, s.text]),
      [
        [1, "第一段讲极限的定义，写得比较完整。\n第二段讲极限的性质，唯一性和有界性。"],
        [2, "第三段讲两个重要极限，"],
        [3, "要背下来，考试常考。"],
      ],
    );
    assert.equal(
      (await call("PATCH", `/v1/imports/${created.id}`, { segments: [{ text: "  " }] })).statusCode,
      400,
    );
    assert.equal(
      (
        await call("PATCH", `/v1/imports/${created.id}`, {
          segments: [{ text: "长".repeat(15_000) }, { text: "长".repeat(6_000) }],
        })
      ).statusCode,
      400,
    );

    // 21000 characters: whole paragraphs up to 20000 are kept, the rest waits.
    const long = (
      await call("POST", "/v1/imports", { clientId: "g2-long", text: paragraphs(42, 500) })
    ).json().data.import;
    assert.equal(long.truncated, true);
    assert.equal(long.limit, 20_000);
    assert.equal(long.segments.length, 40);
    assert.equal(long.restChars, 2 * 500);
    const rest = await call("POST", `/v1/imports/${long.id}/rest`, { clientId: "g2-rest" });
    assert.equal(rest.statusCode, 200, rest.body);
    const next = rest.json().data.import;
    assert.notEqual(next.id, long.id);
    assert.equal(next.status, "read");
    assert.equal(next.segments.length, 2);
    assert.match(next.segments[0].text, /^第41段/);
    assert.equal(next.restChars, 0);
    const again = (
      await call("POST", `/v1/imports/${long.id}/rest`, { clientId: "g2-rest" })
    ).json().data.import;
    assert.equal(again.id, next.id, "the same request returns the same import");
    assert.equal(
      (await call("POST", `/v1/imports/${next.id}/rest`, { clientId: "g2-rest-2" })).statusCode,
      400,
    );
  } finally {
    await f.app.close();
  }
});
