import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import mammoth from "mammoth";
import { getDocumentProxy } from "unpdf";
import { readDocxText, type DocxText } from "./docx.js";
import { boundedDocx } from "./zip-limits.js";
import { ResourceLimitError } from "../../shared/isolated-worker.js";
import { pdfParagraphs, type PdfTextItem, type ParsedPdf, type ParsedPdfPage, type ImportFileTools } from "./parser.js";
type PdfPage = Awaited<ReturnType<Awaited<ReturnType<typeof getDocumentProxy>>["getPage"]>>;
const pageText = async (page: PdfPage) => {
  const content = await page.getTextContent();
  if (content.items.length > 20_000) throw new ResourceLimitError("pdf_items");
  const items: PdfTextItem[] = [];
  for (const item of content.items) {
    if (!("str" in item)) continue;
    items.push({
      str: item.str,
      x: item.transform[4] ?? 0,
      y: item.transform[5] ?? 0,
      w: item.width,
      h: item.height || Math.abs(item.transform[3] ?? 0),
      eol: item.hasEOL,
    });
  }
  page.cleanup();
  return pdfParagraphs(items);
};

const fileTools: ImportFileTools = {
  async readDocx(data) {
    return (await fileTools.readDocxFull!(data)).text;
  },
  // The document walk first (formulas, line breaks); mammoth's raw text when
  // it finds nothing, e.g. a Strict Open XML file.
  async readDocxFull(data) {
    let read: DocxText | undefined;
    try {
      read = await readDocxText(data);
      if (read.text.length > 500_000) throw new ResourceLimitError("docx_text");
      if (read.text.replace(/\s/g, "")) return read;
    } catch (error) {
      if (error instanceof ResourceLimitError) throw error;
      /* mammoth below */
    }
    const inspected = await boundedDocx(data, true);
    const text = (await mammoth.extractRawText({
      buffer: await inspected.generateAsync({ type: "nodebuffer" }),
    })).value
      .replace(/\r\n?/g, "\n")
      .trim();
    if (text.length > 500_000) throw new ResourceLimitError("docx_text");
    // Nothing either way: keep the picture counts of the walk.
    if (read && !text.replace(/\s/g, "")) return read;
    return { text, mathImages: 0, images: 0 };
  },
  async readPdf(data, start, count) {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    try {
      if (pdf.numPages > 2_000 || count > 50 || start < 1) throw new ResourceLimitError("pdf_pages");
      const pages: ParsedPdfPage[] = [];
      let chars = 0;
      const end = Math.min(pdf.numPages, start + count - 1);
      for (let n = start; n <= end; n++) {
        const text = await pageText(await pdf.getPage(n));
        chars += text.length;
        if (chars > 500_000) throw new ResourceLimitError("pdf_text");
        pages.push({ n, text });
      }
      return { totalPages: pdf.numPages, pages };
    } finally {
      await pdf.loadingTask.destroy();
    }
  },
  async rasterizePdfPage() { throw new Error("Rasterization requires a parent-owned output path"); },
};

export async function processDocument(action: string, input: unknown) {
  const data = input as { data: Buffer; start: number; count: number; path: string; page: number; prefix: string };
  if (data.data && data.data.length > 10 * 1024 * 1024) throw new ResourceLimitError("file_size");
  if (action === "docx") return fileTools.readDocxFull!(data.data);
  if (action === "pdf") return fileTools.readPdf(data.data, data.start, data.count);
  if (action === "raster") {
    await new Promise<void>((resolve, reject) => {
      execFile(process.platform === "linux" ? "prlimit" : "pdftoppm", [
        ...(process.platform === "linux" ? ["--as=268435456", "--cpu=3", "--fsize=16777216", "--", "pdftoppm"] : []),
        "-f", String(data.page), "-l", String(data.page), "-singlefile", "-r", "150", "-scale-to", "2000", "-png", data.path, data.prefix,
      ], { windowsHide: true, timeout: 3_000, maxBuffer: 64 * 1024, killSignal: "SIGKILL" }, (error) => error ? reject(error) : resolve());
    });
    return readFile(`${data.prefix}.png`);
  }
  throw new Error("Unknown document operation");
}
