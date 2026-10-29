/*
 * 法律文件读取：将服务端保存的隐私与协议文件整理为小程序和网页可展示的内容。
 * 公开入口由 routes.ts 注册；修改文件时需同步核对版本号、同意记录和展示页面。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Block, MarkdownRenderer } from "../render/markdown.js";
import { INK } from "../render/routes.js";
// 运行时只从 server/legal 读取；开发源码与编译后的 dist 使用相同相对位置。
// 公开源码包放置可运行的示例模板，实际部署应使用运营方核实后的正式正文。
// 文件格式与版本通过工程内测试验证，不依赖工程外的设计资料。
export const LEGAL_DIR = fileURLToPath(new URL("../../../legal/", import.meta.url));
export const LEGAL_DOCS = [
  "user-agreement",
  "privacy-policy",
  "children-privacy",
] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];
export type LegalView = {
  doc: LegalDoc;
  title: string;
  version: string;
  summary: { head: string; note: string; blocks: Block[] };
  // Text between the summary and the first chapter.
  blocks: Block[];
  // One per "## " chapter; the page lists their titles as the contents.
  sections: { title: string; blocks: Block[] }[];
};
// The documents are laid out alike: "# title", a 版本 line, a "> " summary whose
// first line is its bold heading, some lead text, "---", then "## " chapters.
// The summary is rendered on its own because the renderer flattens a list
// inside a quote.
export function split(source: string) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let title = "",
    version = "";
  const quote: string[] = [],
    lead: string[] = [],
    sections: { title: string; lines: string[] }[] = [];
  for (const line of lines) {
    const current = sections.at(-1);
    if (current && !line.startsWith("## ")) current.lines.push(line);
    else if (line.startsWith("## "))
      sections.push({ title: line.slice(3).trim(), lines: [] });
    else if (!title && line.startsWith("# ")) title = line.slice(2).trim();
    else if (!version && line.startsWith("版本：")) version = line.trim();
    else if (line.startsWith(">")) quote.push(line.replace(/^> ?/, ""));
    else if (line.trim() !== "---") lead.push(line);
  }
  const first = quote.findIndex((l) => l.trim());
  const heading = first < 0 ? "" : quote[first]!.trim();
  // "**摘要**（详细内容以正文为准）" or "**摘要（请监护人阅读）**"
  const m = /^\*\*(.+?)\*\*(.*)$/.exec(heading);
  return {
    title,
    version,
    summaryHead: m ? m[1]! : heading,
    summaryNote: m ? m[2]!.trim() : "",
    summary: quote.slice(first + 1).join("\n"),
    lead: lead.join("\n"),
    sections: sections.map((s) => ({
      title: s.title,
      body: s.lines.join("\n"),
    })),
  };
}
export class LegalService {
  private cache = new Map<LegalDoc, Promise<LegalView>>();
  constructor(
    private readonly markdown: MarkdownRenderer,
    private readonly dir = LEGAL_DIR,
  ) {}
  // Rendered once per document; the files only change with a new image.
  view(doc: LegalDoc) {
    let found = this.cache.get(doc);
    if (!found) {
      found = this.render(doc);
      found.catch(() => this.cache.delete(doc));
      this.cache.set(doc, found);
    }
    return found;
  }
  private async render(doc: LegalDoc): Promise<LegalView> {
    const parts = split(await readFile(join(this.dir, `${doc}.md`), "utf8"));
    const render = (text: string) => this.markdown.render(text, INK.light);
    const summaryBlocks = await render(parts.summary);
    const leadBlocks = await render(parts.lead);
    const sections = [];
    for (const section of parts.sections)
      sections.push({ title: section.title, blocks: await render(section.body) });
    return {
      doc,
      title: parts.title,
      version: parts.version,
      summary: {
        head: parts.summaryHead,
        note: parts.summaryNote,
        blocks: summaryBlocks,
      },
      blocks: leadBlocks,
      sections,
    };
  }
}
