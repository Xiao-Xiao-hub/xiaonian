// V4.2 导入分段: text → segments on real paragraph boundaries. A segment is
// what a candidate card cites (at most 8 per card), so a paragraph, a
// numbered problem with its options or a formula with its sentence stays in
// one segment; headings and very short fragments join a neighbour.

// A segment longer than this is cut at sentence ends; merges stop at MERGE_MAX.
export const SEGMENT_MAX = 600;
const MERGE_MAX = 900;
// Fragments up to this many visible characters join a neighbour.
const SHORT = 20;

const visible = (text: string) => Array.from(text.replace(/\s/g, "")).length;
const SENTENCE_END = /[。！？!?；…」”]$|[^.\d]\.$/;
const endsSentence = (text: string) => SENTENCE_END.test(text.trim());
const HEADING =
  /^(?:#{1,6}\s+\S|第[一二三四五六七八九十百零〇\d]+[章节讲课部分篇单元]|[一二三四五六七八九十]+[、．.]\s*\S|[（(][一二三四五六七八九十]+[)）])/;
// 例 1 / 定理 2 alone on a line: a label for what follows, like a heading.
const LABEL =
  /^(?:定义|定理|性质|推论|引理|例题?|习题|练习)\s*[\d.．]*\s*[:：]?$/;
// 1.2 小节名: a numbered heading, short and not a sentence.
const NUMBERED = /^\d+(?:\.\d+)+\s*[^\d\s.]/;
// 1. / 1、/ 2) / （3） / ① / - / • / 定理 2 / 例：…: a new item starts
// (例如 / 定义，… inside a sentence does not).
const LIST =
  /^(?:\d{1,3}[.．、)）](?!\d)|[（(]\d{1,3}[)）]|[①-⑳]|[-*•·]\s+|(?:定义|定理|性质|推论|引理|例题?|习题|练习)\s*(?:\d[\d.．]*\s*[:：（(]?|[:：（(]))/;
// A. / (B) / C、: an option of the problem above, never a new segment.
const OPTION = /^(?:[A-H][.．、)）]|[（(][A-H][)）])/;
const DISPLAY = /^(?:\$\$[\s\S]*\$\$|\\\[[\s\S]*\\\]|\$[^$]+\$)[，,。.;；]?$/;
const MATH = /[=+\-*/^_∫∑∏√≤≥≠→∞≈±×÷]|\\[a-zA-Z]+/;
const CJK = /[㐀-鿿]/g;
// A line that is only a formula: display math, or math with almost no words.
export const isFormula = (line: string) => {
  const text = line.trim();
  if (!text) return false;
  if (DISPLAY.test(text)) return true;
  return (
    MATH.test(text) &&
    (text.match(CJK) ?? []).length <= 2 &&
    !/[a-zA-Z]{5,}/.test(text.replace(/\\[a-zA-Z]+/g, "")) &&
    Array.from(text).length <= 200
  );
};
const CONTINUES = /^(?:其中|这里|即|故|所以|因此|从而|于是|则|得|可得|此时|当|且|并且|[，,；;])/;
// 解 / 答 / 证明 / 分析 … of the problem above. It and the lines
// after it stay with that problem until the next problem number or heading.
const SOLUTION =
  /^(?:【\s*)?(?:解答?|解析|解法[一二三四\d]*|答案?|证明?|分析|提示|思路|点评)\s*(?:】\s*)?[:：]/;
// A problem starts: 1. / 第3题 / 例 1 / 习题 2 (sub-items like （1） or ① do not).
const PROBLEM =
  /^(?:\d{1,3}[.．、](?!\d)|第\s*\d+\s*题|(?:例题?|习题|练习)\s*\d)/;
// “2）”或“2)”既可能是下一题题号，也可能是当前题的选项或步骤。
// 只有数字大于上一题题号，且上一题没有开始自己的“1）”分项时，才按新题切分；题号不要求连续。
// “（2）”不作为这种新题边界。
const PAREN_NO = /^(\d{1,3})[)）](?!\d)/;
// 行首、解答标签之后或带冒号的题干之后出现“1）”，表示当前题的分项或步骤。
// 例如“解：1）…”是在给本题解答编号，不能切成下一道题。
const OPENS = /(?:^|\n|[:：])\s*1[)）](?!\d)/;
const NUMBER =
  /^(?:(\d{1,3})[.．、)）](?!\d)|第\s*(\d+)\s*题|(?:例题?|习题|练习)\s*(\d+))/;
const numberOf = (text: string) => {
  const match = NUMBER.exec(text);
  const value = match && (match[1] ?? match[2] ?? match[3]);
  return value ? Number(value) : undefined;
};

type Block = {
  text: string;
  formula: boolean;
  list: boolean;
  heading: boolean;
};

const lineKind = (line: string) =>
  HEADING.test(line) ||
  LABEL.test(line) ||
  (NUMBERED.test(line) &&
    Array.from(line).length <= 30 &&
    !endsSentence(line))
    ? "heading"
    : OPTION.test(line)
      ? "option"
      : LIST.test(line)
        ? "list"
        : isFormula(line)
          ? "formula"
          : "text";

// Lines → blocks. Blank lines always end a paragraph. When the text has real
// paragraphs (a few lines between blank lines) single newlines are kept inside
// them; otherwise a line ending a sentence ends its paragraph too.
const blocksOf = (text: string): Block[] => {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const filled = lines.filter((line) => line.trim()).length;
  const groups = text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t　]*\n/)
    .filter((part) => part.trim()).length;
  const soft = groups > 1 && filled / groups <= 6;
  const blocks: Block[] = [];
  let current: string[] = [],
    kinds: string[] = [];
  const flush = () => {
    if (current.length)
      blocks.push({
        text: current.join("\n"),
        formula: kinds.every((kind) => kind === "formula"),
        list: kinds[0] === "list",
        heading: kinds[0] === "heading",
      });
    current = [];
    kinds = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const kind = lineKind(line);
    if (current.length) {
      const before = current.at(-1)!;
      const last = kinds.at(-1)!;
      const indented = /^(?:　|\s{2,})\S/.test(raw);
      if (
        kind === "heading" ||
        kind === "list" ||
        last === "heading" ||
        (kind === "text" &&
          (indented || (!soft && endsSentence(before) && last !== "formula")))
      )
        flush();
    }
    current.push(line);
    kinds.push(kind);
  }
  flush();
  return blocks;
};

// A block over SEGMENT_MAX is cut at sentence ends or line breaks; a single
// sentence over it is cut by length.
const splitLong = (block: Block): Block[] => {
  if (Array.from(block.text).length <= SEGMENT_MAX) return [block];
  const pieces = block.text.match(/[^。！？!?；\n]*(?:[。！？!?；]+|\n|$)/g) ?? [];
  const out: Block[] = [];
  let current = "";
  const push = () => {
    if (current.trim())
      out.push({
        text: current.trim(),
        formula: false,
        list: false,
        heading: false,
      });
    current = "";
  };
  for (const piece of pieces) {
    if (!piece) continue;
    if (Array.from(current + piece).length > SEGMENT_MAX) push();
    let rest = piece;
    while (Array.from(rest).length > SEGMENT_MAX) {
      const chars = Array.from(rest);
      out.push({
        text: chars.slice(0, SEGMENT_MAX).join("").trim(),
        formula: false,
        list: false,
        heading: false,
      });
      rest = chars.slice(SEGMENT_MAX).join("");
    }
    current += rest;
  }
  push();
  if (out[0]) out[0].list = block.list;
  return out;
};

const fits = (a: string, b: string) =>
  Array.from(a).length + Array.from(b).length < MERGE_MAX;

// Blocks → segments: a formula joins its sentence, the sentence after a
// formula (其中 / 所以 …) joins it, items after a "…：" stem and short items
// of one list stay together, a heading or a short label joins what follows,
// a short tail joins what came before.
const problemStart = (text: string) =>
  PROBLEM.test(text) ||
  PAREN_NO.test(text) ||
  LABEL.test(text.split("\n")[0]!.trim());
type Segment = {
  text: string;
  afterFormula: boolean;
  open: boolean;
  list: boolean;
  // it is a numbered problem, and its solution has started.
  problem?: boolean;
  solving?: boolean;
  // Its number, and whether 1）items or steps began inside it.
  no?: number;
  items?: boolean;
};
const nextProblem = (prev: Segment | undefined, text: string) => {
  const match = PAREN_NO.exec(text);
  return Boolean(
    match &&
      prev?.problem &&
      !prev.items &&
      prev.no !== undefined &&
      Number(match[1]) > prev.no,
  );
};
const colon = (text: string) => /[:：]$/.test(text.trim());
const merge = (blocks: Block[]): string[] => {
  const out: Segment[] = [];
  let pending = "";
  for (const block of blocks.flatMap(splitLong)) {
    let text = block.text,
      stem = "";
    if (pending) {
      if (fits(pending, text)) {
        stem = pending;
        text = `${pending}\n${text}`;
      } else
        out.push({ text: pending, afterFormula: false, open: false, list: false });
      pending = "";
    }
    const prev = out.at(-1);
    const join = (next: Partial<Segment>) => {
      prev!.text = `${prev!.text}\n${text}`;
      prev!.afterFormula = Boolean(next.afterFormula);
      prev!.open = Boolean(next.open);
      prev!.list = Boolean(next.list);
      prev!.solving = next.solving ?? prev!.solving;
      // A solution numbers its own steps, from its own 1）on.
      prev!.items = SOLUTION.test(text) ? OPENS.test(text) : prev!.items || OPENS.test(text);
    };
    const short = visible(text) <= SHORT;
    // A solution joins its problem, and what follows it joins too, until the
    // next problem or a heading or label (before the short-fragment rules: a short
    // "答：1" belongs to the problem above, not to the next one).
    if (
      prev?.problem &&
      !stem &&
      !block.heading &&
      !PROBLEM.test(text) &&
      !nextProblem(prev, text) &&
      (SOLUTION.test(text) || prev.solving) &&
      fits(prev.text, text)
    ) {
      join({ afterFormula: block.formula, solving: true });
      continue;
    }
    // Stacked headings (第二章 / 2.1 …) wait together for their text.
    if (stem && block.heading && visible(text) <= 2 * SHORT) {
      pending = text;
      continue;
    }
    if (!stem && prev && fits(prev.text, text)) {
      if (block.formula) {
        join({ afterFormula: true, open: prev.open, list: prev.list });
        continue;
      }
      if (prev.afterFormula && CONTINUES.test(text)) {
        join({});
        continue;
      }
      // The next numbered problem is not an item of the stem above
      // ; short items of one list still stay together.
      if (
        block.list &&
        ((prev.open &&
          !(prev.problem && (PROBLEM.test(text) || nextProblem(prev, text)))) ||
          (prev.list && short))
      ) {
        join({ open: prev.open, list: true });
        continue;
      }
    }
    if (!stem && short && !endsSentence(text) && (block.heading || !block.list)) {
      pending = text;
      continue;
    }
    if (!stem && short && !block.list && prev && fits(prev.text, text)) {
      join({});
      continue;
    }
    out.push({
      text,
      afterFormula: block.formula,
      open: colon(stem) || colon(text),
      list: block.list,
      // A title or label above it (the stem) does not hide the number.
      problem: problemStart(text) || problemStart(block.text),
      no: numberOf(block.text) ?? numberOf(text),
      // 1）items or steps inside it, after its own number.
      items: OPENS.test(block.text.replace(NUMBER, "")),
    });
  }
  if (pending) {
    const prev = out.at(-1);
    if (prev && fits(prev.text, pending)) prev.text = `${prev.text}\n${pending}`;
    else out.push({ text: pending, afterFormula: false, open: false, list: false });
  }
  return out.map((segment) => segment.text.trim()).filter(Boolean);
};

// Plain text (pasted, txt/md, docx, a PDF page) → segment texts.
export const segmentText = (text: string): string[] => merge(blocksOf(text));

// Paragraphs that are already paragraphs (OCR, a model's transcription):
// only the formula, label and short-fragment rules apply.
export const mergeParagraphs = (paragraphs: string[]): string[] =>
  merge(
    paragraphs
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => ({
        text: paragraph,
        formula: paragraph.split("\n").every(isFormula),
        list: LIST.test(paragraph),
        heading: lineKind(paragraph.split("\n")[0]!) === "heading",
      })),
  );
