/*
 * 资料导入：接收文字、文档或图片，分步完成读取、原文校对、拆卡与确认保存。
 * parser.ts 处理文件内容，schema.ts 校验结构，JobRunner 执行长任务；routes.ts 是页面请求入口。
 * 耗时步骤保留任务及进度；结果提交前重新核对归属和版本，未读完的内容不能冒充已经处理。
 */
import { BANNED_PHRASES } from "../safety/banned-phrases.js";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  ProviderError,
  type ChatMessage,
  type LlmClient,
  type LlmUsage,
} from "../../providers/llm.js";
import type { Jev } from "../../providers/jev.js";
import type { OcrProvider } from "../../providers/tencent-ocr.js";
import { AppError } from "../../shared/domain.js";
import { IDENTITY_RULE } from "../../shared/identity.js";
import type { SqliteStore } from "../../shared/store.js";
import { now as businessNow } from "../../shared/time.js";
import type { CardService } from "../cards/service.js";
import {
  CARD_KIND_GUIDE,
  KIND_TYPE,
  type CardKind,
  type CardView,
} from "../cards/types.js";
import { isQuote } from "../cards/schema.js";
import { POINT_IDS } from "../notes/schema.js";
import { CALC_MAP } from "../learn/calc-map.js";
import type { CrisisSafetyService } from "../safety/service.js";
import { imageType } from "../materials/service.js";
import {
  JobError,
  publicJob,
  type Job,
  type JobHandler,
  type JobRunner,
} from "../jobs/runner.js";
import { defaultImportFileTools, type ImportFileTools } from "./parser.js";
import { mergeParagraphs, segmentText } from "./segment.js";
import {
  candidateSchema,
  imageOutputSchema,
  photoOutputSchema,
  splitOutputSchema,
  type ImportCandidate,
  type ImportPage,
  type ImportSegment,
  type ImportSource,
} from "./schema.js";

// cards per batch, as many as splitOutputSchema takes; batches of
// SPLIT_BATCH_CHARS until all the text is sent.
export const SPLIT_MAX_CARDS = 8;
export const SPLIT_BATCH_CHARS = 6000;
export const SPLIT_SYSTEM = `[IMPORT_SPLIT] 把原文拆成候选卡。每张只讲一件事；这一批最多 ${SPLIT_MAX_CARDS} 张，内容多时合并相近的点，只留最值得记的；不写用户的“我的话”；src只能填输入中的段号，每张最多 8 个。优先复用已有标签。${CARD_KIND_GUIDE}不得使用这些说法：${BANNED_PHRASES.join("、")}。只返回JSON：{"cards":[{"type":"spark|idea|question|method|todo|knowledge|note","scene":"study|life","title":"不超过16字","summary":"不超过60字","src":[1],"open":null,"tags":["不超过6字，最多3个"]}]}\n${IDENTITY_RULE}`;
// one call decides whether a picture is a chat or a page of text.
export const IMAGE_READ_SYSTEM = `[IMPORT_READ] 先看这张图是不是聊天截图（有对话气泡、头像或昵称）。是聊天截图：按阅读顺序转写每条消息，自己发的（通常在右侧）是 me，别人发的是 other，返回 {"chat":true,"lines":[{"who":"me|other","text":"原文"}]}。不是聊天截图（笔记、课本、讲义、题目、文档等）：按阅读顺序转写全部正文，同一段因排版换行断开的句子接成一段，段与段分开，公式用LaTeX，不改写不解题，返回 {"chat":false,"paragraphs":["原文段落"]}。图里没有文字时返回 {"chat":false,"paragraphs":[]}。只返回JSON。`;
// the same 20000 as the import page; text past it is kept as `rest`.
export const IMPORT_TEXT_LIMIT = 20_000;
export const IMPORT_FILE_LIMIT = 10 * 1024 * 1024;
export const IMPORT_IMAGE_LIMIT = 5 * 1024 * 1024;
export const IMPORT_PAGE_LIMIT = 20;
const SCAN_TEXT_BELOW = 50;
const SOURCE_TITLES: Record<string, string> = {
  photo: "拍的照片",
  screenshot: "聊天截图",
  paste: "贴的文字",
};
type Row = Record<string, unknown>;
type SplitCard = Omit<ImportCandidate, "id" | "crisis" | "savedCardId">;
type SavePick = {
  candidateId?: string;
  quote?: string;
  type?: ImportCandidate["type"];
  // one of the seven kinds; wins over type.
  kind?: CardKind;
  summary?: string;
  scene?: "study" | "life" | "mood";
  title?: string;
  tags?: string[];
  pointId?: string | null;
  mine?: string;
};
type SaveResult = { cards: CardView[]; crisis: boolean };
const POINT_NAMES = new Map(
  CALC_MAP.chapters.flatMap((chapter) =>
    chapter.points.map((point) => [point.id, point.name] as const),
  ),
);

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const countChars = (value: string) =>
  Array.from(value.replace(/\s/g, "")).length;
const parse = <T>(value: unknown, fallback: T): T => {
  try {
    return value === null || value === undefined
      ? fallback
      : (JSON.parse(String(value)) as T);
  } catch {
    return fallback;
  }
};
const normalizeText = (value: string) => value.replace(/\r\n?/g, "\n").trim();
const sourceOf = (name: string): ImportSource | null => {
  const extension = name.toLowerCase().split(".").pop();
  return extension && ["txt", "md", "docx", "pdf"].includes(extension)
    ? (extension as ImportSource)
    : null;
};
// Calls of one job summed per provider and model : a batch that
// fell back to another model keeps that model, so each is priced at its own
// row. One model gives one object as before; more give a list of them.
export const usageSum = (items: LlmUsage[]): LlmUsage | LlmUsage[] | undefined => {
  const groups = new Map<string, LlmUsage[]>();
  for (const item of items) {
    const key = JSON.stringify([item.provider, item.model]);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const sums = [...groups.values()].map((group): LlmUsage => {
    const first = group[0]!;
    return {
      provider: first.provider,
      model: first.model,
      calls: group.reduce((n, x) => n + x.calls, 0),
      promptTokens: group.reduce((n, x) => n + x.promptTokens, 0),
      completionTokens: group.reduce((n, x) => n + x.completionTokens, 0),
      cachedTokens: group.some((x) => x.cachedTokens !== undefined)
        ? group.reduce((n, x) => n + (x.cachedTokens ?? 0), 0)
        : undefined,
      scene: first.scene,
      finishReason: group.at(-1)?.finishReason,
      ms: group.reduce((n, x) => n + x.ms, 0),
      ...(group.some((x) => x.estimated) ? { estimated: true } : {}),
    };
  });
  return sums.length > 1 ? sums : sums[0];
};

// real paragraphs (segment.ts), not one segment per line.
const segmentsFrom = (
  text: string,
  start = 1,
  fields: Pick<ImportSegment, "page" | "who"> = {},
) =>
  segmentText(normalizeText(text)).map((part, index) => ({
    n: start + index,
    text: part,
    ...fields,
  }));
// What a picture read gives: paragraphs merged by the same rules, or chat
// lines as they are (one message each).
const pageSegments = (
  page: number,
  read: { paragraphs?: string[]; lines?: { who: "me" | "other"; text: string }[] },
): Omit<ImportSegment, "n">[] =>
  read.lines?.length
    ? read.lines
        .map((line) => ({ text: line.text.trim(), page, who: line.who }))
        .filter((line) => line.text)
    : mergeParagraphs(read.paragraphs ?? []).map((text) => ({ text, page }));
// Recognised lines: those of one paragraph joined, then merged as paragraphs;
// without paragraph numbers the lines are segmented like pasted text.
export const ocrParagraphs = (lines: { text: string; paragraph: number | null }[]) => {
  if (!lines.some((line) => line.paragraph !== null))
    return segmentText(lines.map((line) => line.text).join("\n"));
  const groups: { paragraph: number | null; text: string }[] = [];
  for (const line of lines) {
    const last = groups.at(-1);
    const text = line.text.trim();
    if (!text) continue;
    if (last && line.paragraph !== null && last.paragraph === line.paragraph)
      last.text +=
        /[\u3000-\u9fff\uff00-\uffef]$/.test(last.text) ||
        /^[\u3000-\u9fff\uff00-\uffef]/.test(text)
          ? text
          : ` ${text}`;
    else groups.push({ paragraph: line.paragraph, text });
  }
  return mergeParagraphs(groups.map((group) => group.text));
};

// Whole segments up to IMPORT_TEXT_LIMIT; the rest is returned as text so it
// can be imported next, never silently dropped.
const capSegments = (segments: ImportSegment[]) => {
  const kept: ImportSegment[] = [];
  const rest: Omit<ImportSegment, "n">[] = [];
  let used = 0;
  for (const segment of segments) {
    const chars = Array.from(segment.text);
    const { n: _n, truncated: _cut, ...fields } = segment;
    if (rest.length || used + chars.length > IMPORT_TEXT_LIMIT) {
      // A first segment over the limit keeps its head.
      if (!kept.length && !rest.length) {
        kept.push({
          ...segment,
          n: 1,
          text: chars.slice(0, IMPORT_TEXT_LIMIT).join("").trim(),
        });
        used = IMPORT_TEXT_LIMIT;
        rest.push({ ...fields, text: chars.slice(IMPORT_TEXT_LIMIT).join("").trim() });
        continue;
      }
      rest.push(fields);
      continue;
    }
    kept.push({ ...segment, n: kept.length + 1 });
    used += chars.length;
  }
  const left = rest.filter((segment) => segment.text);
  const truncated =
    segments.some((segment) => segment.truncated) || rest.length > 0;
  if (truncated && kept.length) kept[kept.length - 1]!.truncated = true;
  return {
    segments: kept,
    truncated,
    rest: left.map((segment) => segment.text).join("\n\n"),
    restSegments: left,
  };
};
// imports.extra (V4.2, NULL on older rows): text left past the limit and the
// pictures a document had that were not read. a scanned import
// also keeps the rest by page (restSegments), so a page read later or again
// is placed among them and the rest is worked out from all pages each time.
type ImportExtra = {
  rest?: string;
  restSegments?: Omit<ImportSegment, "n">[];
  mathImages?: number;
  images?: number;
};
const extraJson = (extra: ImportExtra) => {
  const kept = Object.fromEntries(
    Object.entries(extra).filter(([, value]) =>
      Array.isArray(value) ? value.length : value,
    ),
  );
  return Object.keys(kept).length ? JSON.stringify(kept) : null;
};
// A split answer with lengths trimmed to the schema: a title one character
// too long is not worth a failed batch.
const looseCards = z.object({ cards: z.array(z.unknown()) }).passthrough();
const trimCard = (card: unknown) => {
  if (!card || typeof card !== "object") return card;
  const value = { ...(card as Record<string, unknown>) };
  const cut = (text: unknown, max: number) =>
    typeof text === "string" ? text.trim().slice(0, max).trim() : text;
  value.title = cut(value.title, 16);
  value.summary = cut(value.summary, 60);
  if (Array.isArray(value.src))
    value.src = [...new Set(value.src)].slice(0, 8);
  if (Array.isArray(value.tags))
    value.tags = value.tags
      .map((tag) => cut(tag, 6))
      .filter((tag) => typeof tag !== "string" || tag)
      .slice(0, 3);
  if (value.open && typeof value.open === "object")
    value.open = {
      ...(value.open as Record<string, unknown>),
      text: cut((value.open as Record<string, unknown>).text, 30),
    };
  return value;
};
const issuesOf = (error: z.ZodError) =>
  error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.join(".") || "根"}: ${issue.message}`)
    .join("；");

// Segments in batches of up to SPLIT_BATCH_CHARS, in order, all of them.
const splitBatches = (segments: ImportSegment[]) => {
  const chunks: ImportSegment[][] = [];
  let chunk: ImportSegment[] = [],
    chars = 0;
  for (const segment of segments) {
    const n = Array.from(segment.text).length;
    if (chunk.length && chars + n > SPLIT_BATCH_CHARS) {
      chunks.push(chunk);
      chunk = [];
      chars = 0;
    }
    chunk.push(segment);
    chars += n;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
};

export class ImportService {
  private parsing = false;
  private readonly saving = new Map<
    string,
    { clientId: string; promise: Promise<SaveResult> }
  >();
  private readonly uploadRoot: string;
  constructor(
    private readonly store: SqliteStore,
    private readonly cards: CardService,
    private readonly splitModel: LlmClient,
    private readonly visionModel: LlmClient,
    private readonly ocr: OcrProvider,
    private readonly judge: Pick<Jev, "choice">,
    private readonly safety: CrisisSafetyService,
    uploadDir: string,
    private readonly tools: ImportFileTools = defaultImportFileTools,
    private readonly clock: () => Date = businessNow,
  ) {
    this.uploadRoot = resolve(uploadDir);
  }
  private now() {
    return this.clock().toISOString();
  }
  private id(userId: string, clientId?: string) {
    return clientId
      ? `imp_${digest(`${userId}:${clientId}`).slice(0, 32)}`
      : `imp_${randomUUID().replaceAll("-", "")}`;
  }
  private own(userId: string, id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM imports WHERE id=? AND user_id=?")
      .get(id, userId) as Row | undefined;
    if (!row) throw new AppError(404, "NOT_FOUND", "这次导入找不到了，可能已经删掉");
    return row;
  }
  private insert(
    userId: string,
    input: {
      id: string;
      source: ImportSource;
      fileName?: string;
      own?: boolean;
      segments?: ImportSegment[];
      pages?: ImportPage[];
      status: "reading" | "read";
      extra?: ImportExtra;
    },
  ) {
    const at = this.now();
    this.store.db
      .prepare(
        `INSERT OR IGNORE INTO imports(id,user_id,source,file_name,own,segments,pages,status,created_at,updated_at,extra)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        userId,
        input.source,
        input.fileName ?? null,
        input.own ? 1 : 0,
        JSON.stringify(input.segments ?? []),
        input.pages ? JSON.stringify(input.pages) : null,
        input.status,
        at,
        at,
        extraJson(input.extra ?? {}),
      );
    return this.own(userId, input.id);
  }
  private tempDir(userId: string, id: string) {
    return join(this.uploadRoot, userId, "imports", id);
  }
  private tempFile(userId: string, id: string, name: string) {
    return join(this.tempDir(userId, id), name);
  }
  private saveTemp(userId: string, id: string, name: string, data: Buffer) {
    mkdirSync(this.tempDir(userId, id), { recursive: true, mode: 0o700 });
    writeFileSync(this.tempFile(userId, id, name), data, { mode: 0o600 });
  }
  private clearTemp(userId: string, id: string) {
    rmSync(this.tempDir(userId, id), { recursive: true, force: true });
  }
  cleanupOld() {
    if (!existsSync(this.uploadRoot)) return 0;
    const cutoff = this.clock().getTime() - 60 * 60_000;
    let removed = 0;
    for (const user of readdirSync(this.uploadRoot, { withFileTypes: true })) {
      if (!user.isDirectory()) continue;
      const imports = join(this.uploadRoot, user.name, "imports");
      if (!existsSync(imports)) continue;
      for (const entry of readdirSync(imports, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("imp_")) continue;
        const folder = join(imports, entry.name);
        if (statSync(folder).mtimeMs < cutoff) {
          rmSync(folder, { recursive: true, force: true });
          removed++;
        }
      }
    }
    return removed;
  }
  createPaste(
    userId: string,
    input: { clientId?: string; text: string; own?: boolean },
  ) {
    const id = this.id(userId, input.clientId);
    const existing = this.store.db
      .prepare("SELECT 1 FROM imports WHERE id=? AND user_id=?")
      .get(id, userId);
    if (existing) return this.own(userId, id);
    const text = normalizeText(input.text);
    if (!countChars(text))
      throw new AppError(400, "TEXT_EMPTY", "先贴一段文字吧");
    const capped = capSegments(segmentsFrom(text));
    return this.insert(userId, {
      id,
      source: "paste",
      own: input.own,
      segments: capped.segments,
      status: "read",
      extra: { rest: capped.rest },
    });
  }
  async createFile(
    userId: string,
    input: {
      clientId?: string;
      fileName: string;
      data: Buffer;
      start: number;
      own?: boolean;
    },
    runner: JobRunner,
  ) {
    const id = this.id(userId, input.clientId);
    if (
      this.store.db
        .prepare("SELECT 1 FROM imports WHERE id=? AND user_id=?")
        .get(id, userId)
    )
      return this.own(userId, id);
    const source = sourceOf(input.fileName);
    if (!source)
      throw new AppError(
        415,
        "IMPORT_TYPE",
        "这种文件还打不开，换成 Word、PDF 或纯文字试试",
      );
    if (this.parsing)
      throw new AppError(409, "IMPORT_BUSY", "还在读另一份文件，过一会儿再试");
    this.parsing = true;
    try {
      if (source === "pdf") {
        if (!input.data.subarray(0, 5).equals(Buffer.from("%PDF-")))
          throw new AppError(415, "IMPORT_TYPE", "这个 PDF 打不开，换一份试试");
        let parsed;
        try {
          parsed = await this.tools.readPdf(
            input.data,
            input.start,
            IMPORT_PAGE_LIMIT,
          );
        } catch {
          throw new AppError(
            400,
            "IMPORT_READ_FAILED",
            "这个 PDF 打不开（可能加了密或坏了）",
          );
        }
        if (input.start > parsed.totalPages)
          throw new AppError(400, "IMPORT_PAGE", "这份 PDF 没有这么多页，起始页改小一点");
        const pages: ImportPage[] = parsed.pages.map((page) => ({
          n: page.n,
          scan: countChars(page.text) < SCAN_TEXT_BELOW,
          ok: countChars(page.text) >= SCAN_TEXT_BELOW,
        }));
        if (
          pages.length &&
          parsed.totalPages >= input.start + IMPORT_PAGE_LIMIT
        )
          pages[pages.length - 1]!.truncated = true;
        const textSegments = parsed.pages.flatMap((page) =>
          countChars(page.text) >= SCAN_TEXT_BELOW
            ? segmentsFrom(page.text, 1, { page: page.n })
            : [],
        );
        const capped = capSegments(textSegments);
        const scans = pages.filter((page) => page.scan).map((page) => page.n);
        this.insert(userId, {
          id,
          source,
          fileName: input.fileName.slice(0, 255),
          own: input.own,
          segments: capped.segments,
          pages,
          status: scans.length ? "reading" : "read",
          // Scanned pages read later are placed among these by page.
          extra: {
            rest: capped.rest,
            ...(scans.length ? { restSegments: capped.restSegments } : {}),
          },
        });
        if (scans.length) {
          this.saveTemp(userId, id, "source.pdf", input.data);
          const remaining = runner.available(userId, "ocr", scans.length);
          if (scans.length <= remaining)
            this.startRead(userId, id, scans.length, runner);
        }
        return this.own(userId, id);
      }
      let text: string;
      let pictures: { mathImages: number; images: number } = {
        mathImages: 0,
        images: 0,
      };
      try {
        if (source === "docx") {
          if (input.data[0] !== 0x50 || input.data[1] !== 0x4b)
            throw new Error("not zip");
          if (this.tools.readDocxFull) {
            const read = await this.tools.readDocxFull(input.data);
            text = read.text;
            pictures = { mathImages: read.mathImages, images: read.images };
          } else text = await this.tools.readDocx(input.data);
        } else
          text = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(input.data);
      } catch {
        throw new AppError(
          400,
          "IMPORT_READ_FAILED",
          "这个文件打不开，换一份试试",
        );
      }
      if (!countChars(text))
        throw new AppError(
          400,
          "TEXT_EMPTY",
          pictures.mathImages || pictures.images
            ? "文件里只有图片，没读到文字，截图后再导试试"
            : "文件里没有读到文字",
        );
      const capped = capSegments(segmentsFrom(text));
      return this.insert(userId, {
        id,
        source,
        fileName: input.fileName.slice(0, 255),
        own: input.own,
        segments: capped.segments,
        status: "read",
        extra: { rest: capped.rest, ...pictures },
      });
    } finally {
      this.parsing = false;
    }
  }
  addPhoto(
    userId: string,
    input: {
      clientId: string;
      source: "photo" | "screenshot";
      index: number;
      count: number;
      own?: boolean;
      data: Buffer;
    },
    runner: JobRunner,
  ) {
    const type = imageType(input.data);
    if (!type || type === "bmp")
      throw new AppError(415, "IMAGE_TYPE", "这种图片还打不开，换成 JPG 或 PNG 试试");
    const id = this.id(userId, input.clientId);
    const pages = Array.from({ length: input.count }, (_, index) => ({
      n: index + 1,
      scan: true,
      ok: false,
    }));
    const row = this.insert(userId, {
      id,
      source: input.source,
      own: input.own,
      pages,
      status: "reading",
    });
    if (
      row.source !== input.source ||
      parse<ImportPage[]>(row.pages, []).length !== input.count
    )
      throw new AppError(
        409,
        "IMPORT_CHANGED",
        "照片有变化，重新选一次吧",
      );
    if (row.status !== "reading" || row.job_id) return row;
    for (const ext of ["jpg", "png"])
      rmSync(this.tempFile(userId, id, `${input.index}.${ext}`), {
        force: true,
      });
    this.saveTemp(userId, id, `${input.index}.${type}`, input.data);
    const files = Array.from({ length: input.count }, (_, index) =>
      ["jpg", "png"]
        .map((ext) => `${index}.${ext}`)
        .find((name) => existsSync(this.tempFile(userId, id, name))),
    );
    if (files.every((name): name is string => !!name)) {
      runner.checkQuota(userId, "ocr", input.count);
      const { job } = runner.enqueue({
        userId,
        kind: "import_read",
        params: { importId: id, source: input.source, files },
      });
      this.store.db
        .prepare(
          "UPDATE imports SET job_id=?,updated_at=? WHERE id=? AND user_id=? AND job_id IS NULL",
        )
        .run(job.id, this.now(), id, userId);
    }
    return this.own(userId, id);
  }
  // Reads the first `pages` unread pages, or with 0 goes on with what was
  // read. also photos and screenshots, and again from 'read' for pages
  // that failed, while their files are still kept (see cleanupOld).
  startRead(userId: string, id: string, pages: number, runner: JobRunner) {
    const row = this.own(userId, id);
    const photos = row.source === "photo" || row.source === "screenshot";
    if (
      !(photos || row.source === "pdf") ||
      !(row.status === "reading" || (row.status === "read" && pages > 0))
    )
      throw new AppError(409, "IMPORT_STATE", "这份已经读完了");
    const current = row.job_id ? runner.get(String(row.job_id)) : undefined;
    if (current && ["queued", "running"].includes(current.status)) return row;
    const pending = parse<ImportPage[]>(row.pages, []).filter(
      (page) => page.scan && !page.ok,
    );
    if (pages < 0 || pages > pending.length)
      throw new AppError(400, "IMPORT_PAGE", "页数不对，再试一次");
    if (pages === 0) {
      this.clearTemp(userId, id);
      this.store.db
        .prepare(
          "UPDATE imports SET status='read',job_id=NULL,updated_at=? WHERE id=? AND user_id=? AND status='reading'",
        )
        .run(this.now(), id, userId);
      return this.own(userId, id);
    }
    // only pages whose upload is still kept are read (as
    // retryPages counts them); the others wait for their picture or file to
    // be picked again (POST /:id/page, `missingPages`).
    const selected = pending
      .filter((page) => this.pageFile(userId, row, page.n))
      .slice(0, pages)
      .map((page) => page.n);
    if (!selected.length)
      throw new AppError(
        410,
        "IMPORT_EXPIRED",
        photos ? "图片放久了，重新选一次吧" : "文件放久了，重新选一次吧",
      );
    const files = selected.map((n) => this.pageFile(userId, row, n)!);
    runner.checkQuota(userId, "ocr", selected.length);
    const { job } = runner.enqueue({
      userId,
      kind: photos ? "import_read" : "import_scan_pdf",
      // An earlier read of the same pages may have succeeded with failures.
      refresh: true,
      params: photos
        ? { importId: id, source: row.source, files, pages: selected }
        : { importId: id, pages: selected },
    });
    this.store.db
      .prepare(
        "UPDATE imports SET status='reading',job_id=?,updated_at=? WHERE id=? AND user_id=? AND status=? AND COALESCE(job_id,'')=?",
      )
      .run(
        job.id,
        this.now(),
        id,
        userId,
        String(row.status),
        String(row.job_id ?? ""),
      );
    return this.own(userId, id);
  }
  // the picture of an unread page (or a PDF's file) picked again
  // after the upload was cleared (cleanupOld). Only pages not read yet are
  // given a file; pages read stay as they are and are not read or charged
  // again. Nothing is read here: POST /:id/read reads what is unread.
  async replacePage(
    userId: string,
    id: string,
    input: { n?: number; data: Buffer },
    runner: JobRunner,
  ) {
    const row = this.own(userId, id);
    const photos = row.source === "photo" || row.source === "screenshot";
    if (
      !(photos || row.source === "pdf") ||
      !["reading", "read"].includes(String(row.status))
    )
      throw new AppError(409, "IMPORT_STATE", "这份已经读完了");
    const current = row.job_id ? runner.get(String(row.job_id)) : undefined;
    if (current && ["queued", "running"].includes(current.status))
      throw new AppError(409, "IMPORT_BUSY", "还在读，读完再换");
    const unread = parse<ImportPage[]>(row.pages, []).filter(
      (page) => page.scan && !page.ok,
    );
    if (photos) {
      if (!unread.some((page) => page.n === input.n))
        throw new AppError(400, "IMPORT_PAGE", "这一页已经读好了");
      const type = imageType(input.data);
      if (!type || type === "bmp")
        throw new AppError(415, "IMAGE_TYPE", "这种图片还打不开，换成 JPG 或 PNG 试试");
      for (const ext of ["jpg", "png"])
        rmSync(this.tempFile(userId, id, `${input.n! - 1}.${ext}`), {
          force: true,
        });
      this.saveTemp(userId, id, `${input.n! - 1}.${type}`, input.data);
    } else {
      if (!unread.length)
        throw new AppError(400, "IMPORT_PAGE", "这一份已经读好了");
      if (!input.data.subarray(0, 5).equals(Buffer.from("%PDF-")))
        throw new AppError(415, "IMPORT_TYPE", "这个 PDF 打不开，换一份试试");
      if (this.parsing)
        throw new AppError(409, "IMPORT_BUSY", "还在读另一份文件，过一会儿再试");
      this.parsing = true;
      let total: number;
      try {
        total = (await this.tools.readPdf(input.data, unread.at(-1)!.n, 1))
          .totalPages;
      } catch {
        throw new AppError(
          400,
          "IMPORT_READ_FAILED",
          "这个 PDF 打不开（可能加了密或坏了）",
        );
      } finally {
        this.parsing = false;
      }
      if (total < unread.at(-1)!.n)
        throw new AppError(409, "IMPORT_CHANGED", "页数对不上，选原来那份 PDF");
      this.saveTemp(userId, id, "source.pdf", input.data);
    }
    this.store.db
      .prepare("UPDATE imports SET updated_at=? WHERE id=? AND user_id=?")
      .run(this.now(), id, userId);
    return this.own(userId, id);
  }
  // The kept upload a page is read from, if it is still there.
  private pageFile(userId: string, row: Row, page: number) {
    const id = String(row.id);
    if (row.source === "pdf")
      return existsSync(this.tempFile(userId, id, "source.pdf"))
        ? "source.pdf"
        : undefined;
    return ["jpg", "png"]
      .map((ext) => `${page - 1}.${ext}`)
      .find((name) => existsSync(this.tempFile(userId, id, name)));
  }
  // `segments` replaces the read text after the user fixed, merged or
  // split segments; `from` names the segment a text came from, which keeps
  // its page and speaker.
  update(
    userId: string,
    id: string,
    input: {
      own?: boolean;
      keepSegments?: number[];
      segments?: { text: string; from?: number }[];
    },
  ) {
    const row = this.own(userId, id);
    if (
      ((input.keepSegments !== undefined || input.segments !== undefined) &&
        row.status !== "read") ||
      !["read", "picking"].includes(String(row.status))
    )
      throw new AppError(409, "IMPORT_STATE", "开始拆卡以后，原文就改不了了");
    let segments = parse<ImportSegment[]>(row.segments, []);
    if (input.keepSegments) {
      const keep = new Set(input.keepSegments);
      segments = segments
        .filter((segment) => keep.has(segment.n))
        .map((segment, index) => ({ ...segment, n: index + 1 }));
      if (!segments.length)
        throw new AppError(400, "TEXT_EMPTY", "这是最后一段了，留着它吧");
    }
    if (input.segments) {
      const byNumber = new Map(segments.map((segment) => [segment.n, segment]));
      const next = input.segments
        .map((segment) => ({
          text: normalizeText(segment.text),
          from: segment.from === undefined ? undefined : byNumber.get(segment.from),
        }))
        .filter((segment) => countChars(segment.text));
      if (!next.length)
        throw new AppError(400, "TEXT_EMPTY", "这是最后一段了，留着它吧");
      if (
        next.reduce((n, segment) => n + Array.from(segment.text).length, 0) >
        IMPORT_TEXT_LIMIT
      )
        throw new AppError(
          400,
          "TEXT_TOO_LONG",
          `原文最多 ${IMPORT_TEXT_LIMIT} 字，删掉一些再存`,
        );
      const cut = segments.some((segment) => segment.truncated);
      segments = next.map((segment, index) => ({
        n: index + 1,
        text: segment.text,
        ...(segment.from?.page ? { page: segment.from.page } : {}),
        ...(segment.from?.who ? { who: segment.from.who } : {}),
        ...(cut && index === next.length - 1 ? { truncated: true } : {}),
      }));
    }
    this.store.db
      .prepare(
        "UPDATE imports SET own=COALESCE(?,own),segments=?,updated_at=? WHERE id=? AND user_id=?",
      )
      .run(
        input.own === undefined ? null : Number(input.own),
        JSON.stringify(segments),
        this.now(),
        id,
        userId,
      );
    return this.own(userId, id);
  }
  // the text past the limit becomes a new import of its own (same
  // source and file name), read and ready to split; the same clientId
  // returns the same import.
  continueRest(userId: string, id: string, clientId: string) {
    const row = this.own(userId, id);
    const rest = parse<ImportExtra>(row.extra, {}).rest ?? "";
    if (!countChars(rest))
      throw new AppError(400, "TEXT_EMPTY", "后面没有剩下的了");
    const next = this.id(userId, `rest:${id}:${clientId}`);
    if (
      this.store.db
        .prepare("SELECT 1 FROM imports WHERE id=? AND user_id=?")
        .get(next, userId)
    )
      return this.own(userId, next);
    const capped = capSegments(segmentsFrom(rest));
    return this.insert(userId, {
      id: next,
      source: ["txt", "md", "docx"].includes(String(row.source))
        ? (row.source as ImportSource)
        : "paste",
      fileName: (row.file_name as string | null) ?? undefined,
      own: Boolean(row.own),
      segments: capped.segments,
      status: "read",
      extra: { rest: capped.rest },
    });
  }
  split(userId: string, id: string, clientId: string, runner: JobRunner) {
    const row = this.own(userId, id);
    if (
      row.status === "splitting" ||
      row.status === "picking" ||
      row.status === "saved"
    )
      return row;
    if (row.status !== "read")
      throw new AppError(409, "IMPORT_STATE", "还在读，读完再拆");
    const segments = parse<ImportSegment[]>(row.segments, []);
    if (!segments.length)
      throw new AppError(400, "TEXT_EMPTY", "没有能拆成卡的文字");
    const revision = digest(JSON.stringify(segments));
    const { job } = runner.enqueue({
      userId,
      kind: "import_cards",
      params: {
        importId: id,
        revision,
        clientId,
        batches: splitBatches(segments).length,
      },
    });
    this.store.db
      .prepare(
        "UPDATE imports SET status='splitting',job_id=?,updated_at=? WHERE id=? AND user_id=?",
      )
      .run(job.id, this.now(), id, userId);
    return this.own(userId, id);
  }
  private async enrich(
    userId: string,
    raw: SplitCard[],
    segments: ImportSegment[],
    signal: AbortSignal,
  ) {
    const points = Object.fromEntries([...POINT_IDS].map((id) => [id, id]));
    const byNumber = new Map(segments.map((segment) => [segment.n, segment]));
    const out: ImportCandidate[] = [];
    for (const card of raw) {
      const src = [...new Set(card.src)].filter((n) => byNumber.has(n));
      if (!src.length) continue;
      const text = src
        .map((n) => byNumber.get(n)!.text)
        .join("\n")
        .slice(0, 1000);
      const crisis = await this.safety.check(
        `${card.title}\n${card.summary}\n${text}`,
        { scene: card.scene, source: "import" },
        signal,
      );
      let pointId: string | null = null,
        pointConfidence: number | null = null;
      if (!crisis && card.scene === "study")
        try {
          const result = await this.judge.choice(
            { text: `${card.title}\n${card.summary}` },
            "选择最直接对应的高数知识点；不确定选 none。",
            { none: "没有可靠对应", ...points },
            signal,
          );
          if (
            result.choice !== "none" &&
            result.confidence >= 0.7 &&
            POINT_IDS.has(result.choice)
          ) {
            pointId = result.choice;
            pointConfidence = result.confidence;
          }
        } catch {
          /* Suggestions are optional. */
        }
      let moodSuggested = false;
      if (!crisis && card.scene === "life")
        try {
          const mood = await this.judge.choice(
            { text: `${card.title}\n${card.summary}` },
            "判断是否主要是当下情绪或感受。",
            { mood: "主要是情绪感受", other: "不是" },
            signal,
          );
          moodSuggested = mood.choice === "mood" && mood.confidence >= 0.8;
        } catch {
          /* Suggestions are optional. */
        }
      out.push(
        candidateSchema.parse({
          ...card,
          id: `c${out.length + 1}`,
          src,
          pointId,
          pointConfidence,
          moodSuggested,
          crisis,
          savedCardId: null,
        }),
      );
    }
    return out;
  }
  // One batch: enough room to answer, the lengths trimmed to the schema, and
  // one more try that names what was wrong (V4.2; the blind retry repeated
  // the same mistake). A second answer with too many cards keeps the first
  // SPLIT_MAX_CARDS.
  private async splitBatch(
    messages: ChatMessage[],
    signal: AbortSignal,
    onProgress: (progress: { chars: number; expect: number; thinking?: boolean }) => void,
    usages: LlmUsage[],
  ) {
    let extra: ChatMessage[] = [];
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      let data: z.infer<typeof looseCards>;
      try {
        const options = {
          scenario: "import_split" as const,
          maxTokens: 3000,
          jsonRetries: 0 as const,
          truncateAsError: true,
        };
        const result = this.splitModel.streamJson
          ? await this.splitModel.streamJson([...messages, ...extra], looseCards, {
              ...options,
              signal,
              expect: 1500,
              onProgress,
            })
          : await this.splitModel.json(
              [...messages, ...extra],
              looseCards,
              signal,
              options,
            );
        usages.push(result.usage);
        data = result.data;
      } catch (error) {
        const usage = (error as { usage?: LlmUsage }).usage;
        if (usage) usages.push(usage);
        if (
          !(error instanceof ProviderError) ||
          !["AI_BAD_OUTPUT", "OUTPUT_TRUNCATED"].includes(error.code) ||
          attempt
        )
          throw error;
        failure = error;
        extra = [
          {
            role: "user",
            content: `上一次的输出${error.code === "OUTPUT_TRUNCATED" ? "太长被截断了" : "不是完整的 JSON"}。这一批最多 ${SPLIT_MAX_CARDS} 张，摘要写短一点，只输出一个 JSON 对象。`,
          },
        ];
        continue;
      }
      const cards = data.cards.map(trimCard);
      const checked = splitOutputSchema.safeParse({
        ...data,
        cards: attempt ? cards.slice(0, SPLIT_MAX_CARDS) : cards,
      });
      if (checked.success) return checked.data.cards;
      failure = checked.error;
      extra = [
        { role: "assistant", content: JSON.stringify(data) },
        {
          role: "user",
          content: `上面的输出不符合要求：${issuesOf(checked.error)}。这一批最多 ${SPLIT_MAX_CARDS} 张，按要求改好后重新输出完整的 JSON。`,
        },
      ];
    }
    if (failure instanceof ProviderError) throw failure;
    throw new JobError("AI_BAD_OUTPUT", "这次没拆好，再拆一次试试");
  }
  handlers(): Record<string, JobHandler> {
    return {
      import_read: this.readHandler(false),
      import_scan_pdf: this.readHandler(true),
      import_cards: {
        quota: "import",
        // Two minutes a batch (V4.2: all batches run), at least the old five.
        timeoutMs: (params) =>
          Math.max(300_000, Number(params.batches ?? 0) * 120_000 + 60_000),
        run: async (job, signal, report) => {
          const row = this.own(job.userId, String(job.params.importId));
          const segments = parse<ImportSegment[]>(row.segments, []);
          if (digest(JSON.stringify(segments)) !== job.params.revision)
            throw new JobError("IMPORT_CHANGED", "原文改过了，再拆一次吧");
          const existingTags = (
            this.cards.tagList(job.userId) as { name: string }[]
          )
            .slice(0, 50)
            .map((tag) => tag.name);
          // every batch is sent; none is dropped past the third.
          const chunks = splitBatches(segments);
          const usages: LlmUsage[] = [],
            raw: SplitCard[] = [];
          for (const [index, part] of chunks.entries()) {
            const stage = {
              stage: "split",
              step: index + 1,
              steps: chunks.length,
            };
            report(stage);
            const cards = await this.splitBatch(
              [
                { role: "system", content: SPLIT_SYSTEM },
                {
                  role: "user",
                  content: JSON.stringify({ existingTags, segments: part }),
                },
              ],
              signal,
              (progress) => report({ ...progress, ...stage }),
              usages,
            );
            // the kind is kept next to its four-way type.
            raw.push(
              ...cards.map((card) => ({
                ...card,
                type: KIND_TYPE[card.type],
                kind: card.type,
              })),
            );
          }
          if (
            BANNED_PHRASES.some((phrase) =>
              JSON.stringify(raw).includes(phrase),
            )
          )
            throw new JobError(
              "AI_BAD_OUTPUT",
              "这次没拆好，改改原文再试试",
            );
          report({ stage: "check" });
          const candidates = await this.enrich(
            job.userId,
            raw,
            segments,
            signal,
          );
          return { output: { candidates }, usage: usageSum(usages) };
        },
        // Back to 'read' with the text kept, so 拆卡 can simply run again.
        onFail: (job) => {
          this.store.db
            .prepare(
              "UPDATE imports SET status='read',job_id=NULL,updated_at=? WHERE id=? AND user_id=? AND status='splitting' AND job_id=?",
            )
            .run(this.now(), String(job.params.importId), job.userId, job.id);
        },
        commit: (job, output) => {
          const row = this.own(job.userId, String(job.params.importId));
          if (row.status !== "splitting" || row.job_id !== job.id)
            throw new JobError("IMPORT_CHANGED", "这次导入有变化，退出这页再进来");
          const candidates = (output as { candidates: ImportCandidate[] })
            .candidates;
          this.store.db
            .prepare(
              "UPDATE imports SET candidates=?,status='picking',updated_at=? WHERE id=? AND user_id=?",
            )
            .run(
              JSON.stringify(candidates),
              this.now(),
              String(row.id),
              job.userId,
            );
          return { count: candidates.length };
        },
      },
    };
  }
  private readHandler(scanPdf: boolean): JobHandler {
    return {
      quota: "ocr",
      quotaUnits: (params) =>
        scanPdf
          ? (params.pages as unknown[]).length
          : (params.files as unknown[]).length,
      timeoutMs: (params) =>
        scanPdf
          ? (params.pages as unknown[]).length * 40_000 + 60_000
          : (params.files as unknown[]).length * 60_000 + 30_000,
      run: async (job, signal, report) => {
        const importId = String(job.params.importId),
          usages: LlmUsage[] = [];
        // Pages whose read failed (the call, not an empty page).
        let unread = 0;
        const results: {
          page: number;
          ok: boolean;
          segments: Omit<ImportSegment, "n">[];
        }[] = [];
        // A retry of failed photos names their pages.
        const retryPages = job.params.pages as number[] | undefined;
        const entries: { page: number; file?: string }[] = scanPdf
          ? (job.params.pages as number[]).map((page) => ({ page }))
          : (job.params.files as string[]).map((file, index) => ({
              page: retryPages?.[index] ?? index + 1,
              file,
            }));
        for (const [index, entry] of entries.entries()) {
          signal.throwIfAborted();
          report({ page: index + 1, pages: entries.length, stage: "read" });
          let result: {
            page: number;
            ok: boolean;
            segments: Omit<ImportSegment, "n">[];
          };
          try {
            const image = scanPdf
              ? await this.tools.rasterizePdfPage(
                  this.tempFile(job.userId, importId, "source.pdf"),
                  entry.page,
                  signal,
                )
              : readFileSync(this.tempFile(job.userId, importId, entry.file!));
            const screenshot = job.params.source === "screenshot";
            if (!scanPdf && !screenshot) {
              const recognized = await this.ocr.recognize(image, signal);
              // lines of one paragraph make one segment.
              const segments = ocrParagraphs(recognized.lines).map((text) => ({
                text,
                page: entry.page,
              }));
              // only a page that gave words is paid for.
              if (
                segments.length &&
                recognized.usage &&
                typeof recognized.usage === "object" &&
                "calls" in recognized.usage &&
                "promptTokens" in recognized.usage
              )
                usages.push(recognized.usage as LlmUsage);
              result = { page: entry.page, ok: segments.length > 0, segments };
              this.checkpointPage(job, result);
              results.push(result);
              continue;
            }
            const messages = [
              {
                role: "system" as const,
                // a picture sent as a screenshot may be a page of notes
                // or a textbook; the model says which and reads it so.
                content: screenshot
                  ? IMAGE_READ_SYSTEM
                  : `[IMPORT_READ] 按阅读顺序转写全部正文，同一段因排版换行断开的句子接成一段，公式用LaTeX，不改写不解题。只返回JSON：{"paragraphs":["原文段落"]}`,
              },
              {
                role: "user" as const,
                content: [
                  {
                    type: "image_url" as const,
                    image_url: {
                      url: `data:image/${image[0] === 0x89 ? "png" : "jpeg"};base64,${image.toString("base64")}`,
                    },
                  },
                  { type: "text" as const, text: "转写这一页。" },
                ],
              },
            ];
            const options = {
              scenario: "vision" as const,
              maxTokens: 4000,
              jsonRetries: 1 as const,
              truncateAsError: true,
            };
            const modelResult = screenshot
              ? await this.visionModel.json(
                  messages,
                  imageOutputSchema,
                  signal,
                  options,
                )
              : await this.visionModel.json(
                  messages,
                  photoOutputSchema,
                  signal,
                  options,
                );
            const segments = pageSegments(entry.page, modelResult.data);
            // Nothing read is a failed page, offered again (retryPages), and
            // not paid for.
            if (segments.length) usages.push(modelResult.usage);
            result = { page: entry.page, ok: segments.length > 0, segments };
          } catch (error) {
            if (signal.aborted) throw error;
            unread += 1;
            result = { page: entry.page, ok: false, segments: [] };
          }
          this.checkpointPage(job, result);
          results.push(result);
        }
        // 所有页面都没有读出文字时，将本次读取标为失败并作废扣额凭证，页面保留未读状态，由用户决定重试。
        // 只有每一页都因服务故障无法读取时，才提示服务不可用；空白页面不等于服务故障。
        if (!results.some((result) => result.ok))
          throw unread && unread === entries.length
            ? new JobError("IMPORT_READ_FAILED", "这次没读成，可以再试一次")
            : new JobError("IMPORT_NO_TEXT", "这几页没认出字，可以再试一次");
        return { output: { results }, usage: usageSum(usages) };
      },
      // Pages read so far stay; without a job the import offers reading
      // the rest again (needsOcr, retryPages) or going on with what was read.
      onFail: (job) => {
        this.store.db
          .prepare(
            "UPDATE imports SET job_id=NULL,updated_at=? WHERE id=? AND user_id=? AND status='reading' AND job_id=?",
          )
          .run(this.now(), String(job.params.importId), job.userId, job.id);
      },
      commit: (job, output) => {
        const row = this.own(job.userId, String(job.params.importId));
        if (row.status !== "reading" || row.job_id !== job.id)
          throw new JobError("IMPORT_CHANGED", "这次导入有变化，退出这页再进来");
        const results = (
          output as {
            results: {
              page: number;
              ok: boolean;
              segments: Omit<ImportSegment, "n">[];
            }[];
          }
        ).results;
        this.store.db
          .prepare(
            "UPDATE imports SET status='read',updated_at=? WHERE id=? AND user_id=?",
          )
          .run(this.now(), String(row.id), job.userId);
        // Uploads stay only while a failed page may be read again.
        if (
          !parse<ImportPage[]>(this.own(job.userId, String(row.id)).pages, []).some(
            (page) => page.scan && !page.ok,
          )
        )
          this.clearTemp(job.userId, String(row.id));
        return {
          pages: results.length,
          failed: results
            .filter((result) => !result.ok)
            .map((result) => result.page),
        };
      },
    };
  }
  private checkpointPage(
    job: Job,
    result: { page: number; ok: boolean; segments: Omit<ImportSegment, "n">[] },
  ) {
    this.store.transaction(() => {
      const row = this.store.db
        .prepare("SELECT * FROM imports WHERE id=? AND user_id=?")
        .get(String(job.params.importId), job.userId) as Row | undefined;
      if (!row || row.status !== "reading" || row.job_id !== job.id)
        throw new JobError("IMPORT_CHANGED", "这次导入有变化，退出这页再进来");
      const pages = parse<ImportPage[]>(row.pages, []);
      const page = pages.find((candidate) => candidate.n === result.page);
      if (!page) throw new JobError("IMPORT_CHANGED", "页码有变化，再试一次");
      page.ok = result.ok;
      // what is past the limit is kept, never dropped. The text is
      // worked out again from every page read so far: the kept segments, the
      // rest kept before (by page) and this page; `rest` is overwritten.
      const extra = parse<ImportExtra>(row.extra, {});
      const before: Omit<ImportSegment, "n">[] =
        extra.restSegments ??
        // A row from before FX5a kept the rest as text only: it stays last.
        (extra.rest ? segmentText(extra.rest).map((text) => ({ text })) : []);
      const others = (list: Omit<ImportSegment, "n">[]) =>
        list
          .filter((segment) => segment.page !== result.page)
          .map(({ truncated: _cut, ...segment }) => ({ ...segment, n: 1 }));
      const next = [
        ...others(parse<ImportSegment[]>(row.segments, [])),
        ...others(before),
        ...result.segments.map((segment) => ({ ...segment, n: 1 })),
      ].sort(
        (a, b) =>
          (a.page ?? Number.MAX_SAFE_INTEGER) - (b.page ?? Number.MAX_SAFE_INTEGER),
      );
      const capped = capSegments(next);
      this.store.db
        .prepare(
          "UPDATE imports SET segments=?,pages=?,extra=?,updated_at=? WHERE id=? AND user_id=?",
        )
        .run(
          JSON.stringify(capped.segments),
          JSON.stringify(pages),
          extraJson({
            ...extra,
            rest: capped.rest,
            restSegments: capped.restSegments,
          }),
          this.now(),
          String(row.id),
          job.userId,
        );
    });
  }
  async save(
    userId: string,
    id: string,
    selections: SavePick[],
    clientId = "",
  ) {
    const key = `${userId}:${id}`;
    const active = this.saving.get(key);
    if (active) {
      if (active.clientId === clientId) return active.promise;
      throw new AppError(409, "IMPORT_BUSY", "正在存，过一会儿再看");
    }
    const promise = this.saveOnce(userId, id, selections);
    this.saving.set(key, { clientId, promise });
    try {
      return await promise;
    } finally {
      if (this.saving.get(key)?.promise === promise) this.saving.delete(key);
    }
  }
  private async saveOnce(
    userId: string,
    id: string,
    selections: SavePick[],
  ): Promise<SaveResult> {
    const row = this.own(userId, id);
    if (row.status === "saved") {
      const cards = this.store.db
        .prepare(
          "SELECT id FROM cards WHERE user_id=? AND origin='import' AND src_id=? ORDER BY created_at,id",
        )
        .all(userId, id)
        .map((found) => this.cards.detail(userId, String(found.id)));
      return { cards, crisis: cards.some((card) => card.crisis) };
    }
    if (row.status !== "picking")
      throw new AppError(409, "IMPORT_STATE", "还没拆好，拆完再存");
    if (!selections.length)
      throw new AppError(400, "IMPORT_EMPTY", "先勾一张吧");
    if (
      selections.length > 1 &&
      selections.some((selection) => !selection.candidateId)
    )
      throw new AppError(
        400,
        "IMPORT_CANDIDATE",
        "从原文选的话，一次存一张",
      );
    const candidates = parse<ImportCandidate[]>(row.candidates, []),
      segments = parse<ImportSegment[]>(row.segments, []);
    const byNumber = new Map(segments.map((segment) => [segment.n, segment]));
    const output: CardView[] = [];
    for (const pick of selections) {
      const manual = !pick.candidateId;
      const candidate = manual
        ? undefined
        : candidates.find((item) => item.id === pick.candidateId);
      if (!manual && !candidate)
        throw new AppError(400, "IMPORT_CANDIDATE", "这张卡找不到了");
      if (manual && (!pick.quote || !(pick.type || pick.kind) || !pick.scene))
        throw new AppError(
          400,
          "IMPORT_CANDIDATE",
          "选好原文和卡的种类再存",
        );
      if (candidate?.savedCardId) {
        output.push(this.cards.detail(userId, candidate.savedCardId));
        continue;
      }
      const quote = manual
        ? pick.quote!.trim()
        : candidate!.src
            .map((n) => byNumber.get(n)?.text ?? "")
            .filter(Boolean)
            .join("\n")
            .slice(0, 1000);
      if (!quote)
        throw new AppError(409, "IMPORT_CHANGED", "这张卡的原文删掉了");
      if (
        manual &&
        !isQuote(
          quote,
          segments.map((segment) => segment.text),
        )
      )
        throw new AppError(
          400,
          "IMPORT_CANDIDATE",
          "选的这句不在这次的原文里",
        );
      if (pick.pointId && !POINT_IDS.has(pick.pointId))
        throw new AppError(400, "INVALID_CARD", "这个知识点找不到了");
      if (pick.mine) {
        if (!row.own)
          throw new AppError(
            400,
            "IMPORT_MINE",
            "打开“原文是我自己写的”，就能存成我的话",
          );
        const selected = manual
          ? segments.filter((part) => isQuote(quote, [part.text]))
          : candidate!.src
              .map((n) => byNumber.get(n))
              .filter((part): part is ImportSegment => !!part);
        // a screenshot read as a page of text has no speakers.
        const allowed = selected
          .filter((part) => row.source !== "screenshot" || part.who !== "other")
          .map((part) => part.text);
        if (!isQuote(pick.mine.trim(), allowed))
          throw new AppError(400, "IMPORT_MINE", "我的话要从你自己写的原文里挑");
      }
      const title = pick.title?.trim();
      // the kind chosen, else the candidate's while its type was kept
      // (a 0.4.0–0.6.0 client sends only the four-way type).
      const type =
        pick.type ?? (pick.kind ? KIND_TYPE[pick.kind] : candidate!.type);
      const kind =
        pick.kind ??
        (candidate?.kind && KIND_TYPE[candidate.kind] === type
          ? candidate.kind
          : undefined);
      const created = await this.cards.create(
        userId,
        {
          quote,
          type,
          ...(kind ? { kind } : {}),
          scene: pick.scene ?? candidate!.scene,
          ...(title ? { title } : {}),
          mine: pick.mine?.trim(),
          origin: "import",
          srcId: id,
          pointId: pick.pointId || undefined,
        },
        { skipTidy: true },
      );
      let card = created.card;
      if (candidate?.crisis && !card.crisis) {
        this.store.db
          .prepare(
            "UPDATE cards SET crisis=1,resume='off',version=version+1 WHERE id=? AND user_id=?",
          )
          .run(card.id, userId);
        card = this.cards.detail(userId, card.id);
      }
      if (!card.crisis)
        card = this.cards.applyAIData(userId, card.id, card.version, {
          ...(title || manual ? {} : { title: candidate!.title }),
          ...(manual ? {} : { summary: candidate!.summary }),
          open: candidate?.open ? [{ ...candidate.open, key: "import" }] : [],
          tags: pick.tags ? undefined : candidate?.tags,
        });
      if (pick.tags) {
        const ids: string[] = [];
        for (const name of [
          ...new Set(pick.tags.map((tag) => tag.trim()).filter(Boolean)),
        ].slice(0, 3)) {
          const found = this.cards
            .tagList(userId)
            .find((item) => item.name === name);
          ids.push(
            found?.id ??
              this.cards.tagCreate(
                userId,
                name,
                this.cards.tagList(userId).length % 8,
              ).id,
          );
        }
        card = this.cards.tagsReplace(userId, card.id, card.version, ids);
      }
      // a summary the user rewrote is theirs.
      const summary = pick.summary?.trim();
      if (summary && !card.crisis && summary !== candidate?.summary)
        card = (
          await this.cards.update(userId, card.id, card.version, { summary })
        ).card;
      if (candidate) {
        candidate.savedCardId = card.id;
        this.store.db
          .prepare(
            "UPDATE imports SET candidates=?,updated_at=? WHERE id=? AND user_id=? AND status='picking'",
          )
          .run(JSON.stringify(candidates), this.now(), id, userId);
      }
      output.push(card);
    }
    this.store.db
      .prepare(
        "UPDATE imports SET candidates=?,status='saved',updated_at=? WHERE id=? AND user_id=?",
      )
      .run(JSON.stringify(candidates), this.now(), id, userId);
    return { cards: output, crisis: output.some((card) => card.crisis) };
  }
  list(userId: string, runner: JobRunner) {
    return (
      this.store.db
        .prepare(
          "SELECT * FROM imports WHERE user_id=? ORDER BY updated_at DESC,rowid DESC",
        )
        .all(userId) as Row[]
    ).map((row) => this.view(row, runner));
  }
  detail(userId: string, id: string, runner: JobRunner) {
    return this.view(this.own(userId, id), runner);
  }
  // the last job of an import that has none now, when it did not
  // finish, so a page opened later can say why and offer the retry.
  private failedJob(row: Row, runner: JobRunner) {
    if (row.job_id) return null;
    const found = this.store.db
      .prepare(
        "SELECT id FROM jobs WHERE user_id=? AND json_extract(params,'$.importId')=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get(String(row.user_id), String(row.id)) as Row | undefined;
    const job = found ? runner.get(String(found.id)) : undefined;
    return job && ["failed", "unknown"].includes(job.status) ? job : null;
  }
  // Pages that failed or were not read yet and can be read again now.
  private retryPages(row: Row, runner: JobRunner) {
    if (!["reading", "read"].includes(String(row.status))) return 0;
    const job = row.job_id ? runner.get(String(row.job_id)) : undefined;
    if (job && ["queued", "running"].includes(job.status)) return 0;
    if (!["pdf", "photo", "screenshot"].includes(String(row.source))) return 0;
    return parse<ImportPage[]>(row.pages, []).filter(
      (page) =>
        page.scan &&
        !page.ok &&
        this.pageFile(String(row.user_id), row, page.n),
    ).length;
  }
  // 随心记's 进行中 strip : imports not saved or given up, touched in
  // the last 7 days, in a small shape. `all` lists every
  // unfinished import, however old (the import page's full list).
  open(userId: string, runner: JobRunner, all = false) {
    const since = all
      ? ""
      : new Date(this.clock().getTime() - 7 * 86400_000).toISOString();
    return (
      this.store.db
        .prepare(
          `SELECT * FROM imports WHERE user_id=? AND status IN ('reading','read','splitting','picking') AND updated_at>=? ORDER BY updated_at DESC,rowid DESC${all ? "" : " LIMIT 10"}`,
        )
        .all(userId, since) as Row[]
    ).map((row) => {
      const pages = parse<ImportPage[]>(row.pages, []);
      const segments = parse<ImportSegment[]>(row.segments, []);
      const current = row.job_id ? runner.get(String(row.job_id)) : undefined;
      const job = current ?? this.failedJob(row, runner);
      return {
        id: String(row.id),
        status: row.status,
        source: row.source,
        // By code point, so an emoji is never cut in half.
        title: Array.from(
          (row.file_name as string | null) ||
            segments[0]?.text ||
            SOURCE_TITLES[String(row.source)] ||
            "这次导入",
        )
          .slice(0, 16)
          .join(""),
        pages: pages.length
          ? { done: pages.filter((page) => page.ok).length, total: pages.length }
          : null,
        candidates: parse<ImportCandidate[]>(row.candidates, []).length,
        retryPages: this.retryPages(row, runner),
        job: job ? publicJob(job) : null,
        updatedAt: String(row.updated_at),
      };
    });
  }
  // 放弃: hidden from the strip and the import entry; nothing is deleted.
  abandon(userId: string, id: string, runner: JobRunner) {
    const row = this.own(userId, id);
    if (["saved", "abandoned"].includes(String(row.status))) return row;
    if (row.job_id) runner.cancel([String(row.job_id)]);
    this.store.db
      .prepare(
        "UPDATE imports SET status='abandoned',updated_at=? WHERE id=? AND user_id=? AND status NOT IN ('saved','abandoned')",
      )
      .run(this.now(), id, userId);
    // its queued jobs end before they start, so no model is
    // called; jobs.status has no 'cancelled', so they fail like a deleted
    // import's, with their receipts freed. A running one is aborted above.
    runner.drop(
      (
        this.store.db
          .prepare(
            "SELECT id FROM jobs WHERE user_id=? AND status='queued' AND json_extract(params,'$.importId')=?",
          )
          .all(userId, id) as { id: string }[]
      ).map((job) => job.id),
      { code: "IMPORT_ABANDONED", message: "这次导入不导了" },
    );
    this.clearTemp(userId, id);
    return this.own(userId, id);
  }
  private view(row: Row, runner: JobRunner) {
    const segments = parse<ImportSegment[]>(row.segments, []),
      pages = parse<ImportPage[]>(row.pages, []);
    const rawCandidates = parse<ImportCandidate[]>(row.candidates, []);
    const byNumber = new Map(segments.map((segment) => [segment.n, segment]));
    const candidates = rawCandidates.map((candidate) => ({
      ...candidate,
      pointName: candidate.pointId
        ? (POINT_NAMES.get(candidate.pointId) ?? null)
        : null,
      quote: candidate.crisis
        ? ""
        : candidate.src
            .map((n) => byNumber.get(n)?.text ?? "")
            .filter(Boolean)
            .join("\n")
            .slice(0, 1000),
      summary: candidate.crisis ? "" : candidate.summary,
      selected: !candidate.crisis,
    }));
    const pending = pages.filter((page) => page.scan && !page.ok);
    const available = runner.available(
      String(row.user_id),
      "ocr",
      pending.length,
    );
    const job = row.job_id ? runner.get(String(row.job_id)) : undefined;
    const extra = parse<ImportExtra>(row.extra, {});
    return {
      id: String(row.id),
      source: row.source,
      fileName: row.file_name ?? null,
      own: Boolean(row.own),
      status: row.status,
      segments,
      pages,
      candidates,
      savedCards:
        row.status === "saved"
          ? this.store.db
              .prepare(
                "SELECT id FROM cards WHERE user_id=? AND origin='import' AND src_id=? ORDER BY created_at,id",
              )
              .all(String(row.user_id), String(row.id))
              .map((card) =>
                this.cards.detail(String(row.user_id), String(card.id)),
              )
          : [],
      chars: segments.reduce((n, segment) => n + countChars(segment.text), 0),
      pageRange: pages.length
        ? { from: pages[0]!.n, to: pages.at(-1)!.n }
        : null,
      truncated:
        pages.some((page) => page.truncated) ||
        segments.some((segment) => segment.truncated) ||
        segments.reduce(
          (n, segment) => n + Array.from(segment.text).length,
          0,
        ) >= IMPORT_TEXT_LIMIT,
      partial: pages.some((page) => !page.ok),
      needsOcr:
        row.status === "reading" && !row.job_id && pending.length
          ? { pages: pending.length, available }
          : null,
      job: job ? publicJob(job) : null,
      failedJob: (() => {
        const failed = this.failedJob(row, runner);
        return failed ? publicJob(failed) : null;
      })(),
      retryPages: this.retryPages(row, runner),
      // for photos and screenshots, the pages whose picture is on
      // the server now; a page missing here while no read job ever started
      // never arrived, and the client sends it again (same clientId).
      received:
        row.source === "photo" || row.source === "screenshot"
          ? pages
              .filter((page) => this.pageFile(String(row.user_id), row, page.n))
              .map((page) => page.n)
          : null,
      // unread pages whose picture (or the PDF) was cleared, to
      // pick again (POST /:id/page); null for imports that are not scanned.
      missingPages: ["pdf", "photo", "screenshot"].includes(String(row.source))
        ? ["reading", "read"].includes(String(row.status))
          ? pending
              .filter((page) => !this.pageFile(String(row.user_id), row, page.n))
              .map((page) => page.n)
          : []
        : null,
      // characters left past the limit (POST /:id/rest imports them),
      // and pictures in a document that were not read.
      limit: IMPORT_TEXT_LIMIT,
      restChars: extra.rest ? countChars(extra.rest) : 0,
      unread:
        extra.mathImages || extra.images
          ? { formulas: extra.mathImages ?? 0, images: extra.images ?? 0 }
          : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  remove(userId: string, id: string, runner: JobRunner) {
    const row = this.own(userId, id),
      jobId = row.job_id ? String(row.job_id) : null;
    if (jobId) runner.cancel([jobId]);
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "DELETE FROM resume_items WHERE user_id=? AND src='import' AND src_id=?",
        )
        .run(userId, id);
      this.store.db
        .prepare(
          `UPDATE jobs SET params='{"deleted":true}',params_hash='deleted:'||id,result=NULL,
         status=CASE WHEN status IN ('queued','running') THEN 'failed' ELSE status END,
         error_code=CASE WHEN status IN ('queued','running') THEN 'IMPORT_DELETED' ELSE error_code END,
         error_message=CASE WHEN status IN ('queued','running') THEN '导入记录已删除' ELSE error_message END,
         finished_at=COALESCE(finished_at,?) WHERE user_id=? AND json_extract(params,'$.importId')=?`,
        )
        .run(this.now(), userId, id);
      this.store.db
        .prepare("DELETE FROM imports WHERE id=? AND user_id=?")
        .run(id, userId);
    });
    this.clearTemp(userId, id);
  }
}
