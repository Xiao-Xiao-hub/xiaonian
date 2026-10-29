/*
 * 导入文件解析边界：根据文件类型提取文字或待识别页面，供导入与聊天附件共用。
 * 解析工具可注入以便测试；读取失败、截断和扫描件需要由上层继续处理，不能伪装完整内容。
 */
import type { DocxText } from "./docx.js";
import { AppError } from "../../shared/domain.js";
import { runIsolated } from "../../shared/isolated-worker.js";
import { ResourceLimitError, processingRejected } from "../../shared/isolated-worker.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ParsedPdfPage = { n: number; text: string };
export type ParsedPdf = { totalPages: number; pages: ParsedPdfPage[] };
export type ImportFileTools = {
  readDocx(data: Buffer): Promise<string>;
  // the text with formulas, and the pictures that were not read.
  readDocxFull?(data: Buffer): Promise<DocxText>;
  readPdf(data: Buffer, start: number, count: number): Promise<ParsedPdf>;
  rasterizePdfPage(
    path: string,
    page: number,
    signal: AbortSignal,
  ): Promise<Buffer>;
};

// Temporary worker pressure must not label a user's valid document corrupt.
export function documentReadError(error: unknown, code: string, message: string) {
  if (error instanceof ResourceLimitError && ["queue_full", "timeout"].includes(error.reason))
    return new AppError(503, code, "文件处理暂时繁忙，请稍后再试");
  if (error instanceof ResourceLimitError && ["worker_failed", "memory_limit"].includes(error.reason))
    return new AppError(400, code, "文件处理未能完成，请缩小文件或拆分后重新上传");
  return new AppError(400, code, message);
}

export function readPlainText(data: Buffer, ignoreBOM: boolean) {
  if (data.length > 1_500_000) {
    processingRejected("document", "text_size");
    throw new ResourceLimitError("text_size");
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM }).decode(data);
  if (text.length > 500_000) {
    processingRejected("document", "text_size");
    throw new ResourceLimitError("text_size");
  }
  return text;
}

// One pdf.js text item where it sits on the page (PDF units, y upwards).
export type PdfTextItem = {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  eol?: boolean;
};
type PdfLine = { text: string; x: number; y: number; right: number; h: number };
const CJK_END = /[\u3000-\u9fff\uff00-\uffef]$/;
const CJK_START = /^[\u3000-\u9fff\uff00-\uffef]/;
const PARAGRAPH_START =
  /^(?:\d{1,3}[.．、)）](?!\d)|[（(]\d{1,3}[)）]|[①-⑳]|[-•·]\s|第[一二三四五六七八九十\d]+[章节讲]|[一二三四五六七八九十]+、|(?:定义|定理|性质|推论|引理|例题?|习题)\s*(?:\d|[:：（(]))/;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
// a page's text with its paragraphs rebuilt. Items on one baseline make
// a line; wrapped lines of a paragraph are joined; a paragraph ends at a
// bigger vertical gap, an indented line, a numbered item, or a short line
// that ends a sentence. Paragraphs are separated by a blank line.
export const pdfParagraphs = (items: PdfTextItem[]): string => {
  const lines: PdfLine[] = [];
  let line: PdfLine | null = null;
  for (const item of items) {
    const h = item.h || 10;
    if (item.str) {
      if (!line || Math.abs(item.y - line.y) > Math.max(h, line.h) * 0.5) {
        if (line) lines.push(line);
        line = { text: "", x: item.x, y: item.y, right: item.x, h };
      }
      const gap = item.x - line.right;
      if (
        line.text &&
        gap > h * 0.25 &&
        !/\s$/.test(line.text) &&
        !/^\s/.test(item.str)
      )
        line.text += " ";
      line.text += item.str;
      line.x = Math.min(line.x, item.x);
      line.right = Math.max(line.right, item.x + (item.w || 0));
      line.h = Math.max(line.h, h);
    }
    if (item.eol && line) {
      lines.push(line);
      line = null;
    }
  }
  if (line) lines.push(line);
  const kept = lines
    .map((entry) => ({ ...entry, text: entry.text.replace(/\s+/g, " ").trim() }))
    .filter((entry) => entry.text);
  if (!kept.length) return "";
  const gaps = kept
    .slice(1)
    .map((entry, index) => kept[index]!.y - entry.y)
    .filter((gap) => gap > 0);
  const lineGap = median(gaps) || kept[0]!.h * 1.4;
  const left = median(kept.map((entry) => entry.x));
  const right = Math.max(...kept.map((entry) => entry.right));
  const paragraphs: string[] = [];
  let current = "";
  kept.forEach((entry, index) => {
    const before = kept[index - 1];
    const breaks =
      !before ||
      before.y - entry.y > lineGap * 1.5 ||
      before.y - entry.y < -entry.h ||
      entry.x > left + entry.h * 1.5 ||
      PARAGRAPH_START.test(entry.text) ||
      (/[。！？!?；:：]$/.test(before.text) &&
        before.right < right - entry.h * 2);
    if (breaks) {
      if (current) paragraphs.push(current);
      current = entry.text;
      return;
    }
    current =
      /-$/.test(current) && /^[a-z]/.test(entry.text)
        ? current.slice(0, -1) + entry.text
        : CJK_END.test(current) || CJK_START.test(entry.text)
          ? current + entry.text
          : `${current} ${entry.text}`;
  });
  if (current) paragraphs.push(current);
  return paragraphs.join("\n\n");
};
export const defaultImportFileTools: ImportFileTools = {
  async readDocx(data) {
    return (await runIsolated<DocxText>("document", "docx", { data })).text;
  },
  readDocxFull: (data) => runIsolated<DocxText>("document", "docx", { data }),
  readPdf: (data, start, count) => runIsolated<ParsedPdf>("document", "pdf", { data, start, count }),
  async rasterizePdfPage(path, page, signal) {
    signal.throwIfAborted();
    const folder = await mkdtemp(join(tmpdir(), "zhiye-import-"));
    try {
      const image = await runIsolated<Buffer>("document", "raster", { path, page, prefix: join(folder, "page") });
      signal.throwIfAborted();
      return image;
    } finally {
      // Parent cleanup also runs after a timed-out or crashed worker is killed.
      await rm(folder, { recursive: true, force: true });
    }
  },
};
