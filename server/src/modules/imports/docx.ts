// the text of a.docx read from word/document.xml in body order, with
// Office Math kept as LaTeX ($…$ inline, $$…$$ on its own line) and line
// breaks inside a paragraph kept. mammoth's raw text dropped both.
import { DOMParser } from "@xmldom/xmldom";
import { boundedDocx } from "./zip-limits.js";
import { ResourceLimitError } from "../../shared/isolated-worker.js";
import { M_NS, ommlToLatex } from "./omml.js";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const O_NS = "urn:schemas-microsoft-com:office:office";
const V_NS = "urn:schemas-microsoft-com:vml";

export type DocxText = {
  text: string;
  // MathType / Equation Editor objects: pictures of formulas, not readable.
  mathImages: number;
  // Other pictures in the document, not read either.
  images: number;
};

type XmlNode = Parameters<typeof ommlToLatex>[0] & {
  getElementsByTagNameNS?: (ns: string, name: string) => ArrayLike<XmlNode>;
};
const elements = (node: XmlNode) =>
  Array.from(node.childNodes).filter(
    (child) => child.nodeType === 1,
  ) as XmlNode[];
const is = (node: XmlNode, ns: string, name: string) =>
  node.namespaceURI === ns && node.localName === name;
const SKIP = new Set(["del", "moveFrom", "instrText", "delText", "delInstrText"]);
// Containers whose children are read in order.
const PASS = new Set([
  "r", "ins", "moveTo", "hyperlink", "smartTag", "customXml", "fldSimple",
  "sdt", "sdtContent", "dir", "bdo", "txbxContent",
]);

export async function readDocxText(data: Buffer): Promise<DocxText> {
  const zip = await boundedDocx(data);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("not a docx");
  const xml = await file.async("string");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new ResourceLimitError("xml_entities");
  // Keep a normal 500,000-character, heavily formatted document within the
  // worker's heap by parsing body blocks separately, rather than building one
  // enormous DOM. Tables and each paragraph still retain their full context.
  const chunks: string[] = [];
  let depth = 0, nodes = 0, previousEnd = 0, bodyDepth = 0, bodyStart = 0,
    blockStart = 0, batchStart = 0, batchNodes = 0;
  let prefix = "", suffix = "", bodyName = "";
  const stack: string[] = [];
  for (const tag of xml.matchAll(/<!--[^]*?-->|<!\[CDATA\[[^]*?\]\]>|<[^>]*>/g)) {
    if (++nodes > 1_000_000) throw new ResourceLimitError("xml_nodes");
    if (tag.index! - previousEnd > 500_000) throw new ResourceLimitError("docx_text");
    previousEnd = tag.index! + tag[0].length;
    if (/^<[!?]/.test(tag[0])) continue;
    const closing = /^<\//.test(tag[0]);
    const name = /^<\/?([^\s/>]+)/.exec(tag[0])?.[1] ?? "";
    const selfClosing = /\/>$/.test(tag[0]);
    if (closing) {
      if (name !== stack.pop()) throw new Error("unbalanced xml");
      depth--;
      if (bodyDepth && depth === bodyDepth) {
        if (!batchStart) batchStart = blockStart;
        if (nodes - batchNodes >= 8_000) {
          chunks.push(xml.slice(batchStart, previousEnd));
          batchStart = 0;
          batchNodes = nodes;
        }
      } else if (bodyDepth && name === bodyName && depth === bodyDepth - 1) {
        if (batchStart) chunks.push(xml.slice(batchStart, tag.index));
        bodyDepth = 0;
      }
    } else {
      if (bodyDepth && depth === bodyDepth) blockStart = tag.index!;
      if (!selfClosing) {
        stack.push(name);
        depth++;
        if (depth > 64) throw new ResourceLimitError("xml_depth");
        if (!prefix && name.split(":").at(-1) === "body") {
          bodyDepth = depth;
          bodyName = name;
          bodyStart = previousEnd;
          prefix = xml.slice(0, bodyStart);
          suffix = stack.slice().reverse().map((entry) => `</${entry}>`).join("");
          batchNodes = nodes;
        }
      } else if (bodyDepth && depth === bodyDepth && !batchStart) batchStart = blockStart;
    }
  }
  if (depth || !prefix) throw new Error("no body");
  const counts = { mathImages: 0, images: 0 };

  // An embedded object or picture: counted, never read.
  const picture = (node: XmlNode) => {
    if (is(node, W_NS, "object")) {
      const ole = Array.from(
        node.getElementsByTagNameNS?.(O_NS, "OLEObject") ?? [],
      )[0];
      const progId =
        ole?.getAttribute?.("ProgID") ?? ole?.getAttributeNS?.("", "ProgID") ?? "";
      if (/^Equation\./i.test(progId)) counts.mathImages++;
      else counts.images++;
    } else if (is(node, W_NS, "drawing")) counts.images++;
    else if (
      is(node, W_NS, "pict") &&
      Array.from(node.getElementsByTagNameNS?.(V_NS, "imagedata") ?? []).length
    )
      counts.images++;
  };

  // Inline content of a paragraph.
  const inline = (node: XmlNode): string => {
    let out = "";
    for (const item of elements(node)) {
      if (item.namespaceURI === MC_NS) {
        // Only the first choice: the fallback repeats the same content.
        if (item.localName === "AlternateContent") {
          const choice = elements(item).find((c) => is(c, MC_NS, "Choice"));
          if (choice) out += inline(choice);
        }
        continue;
      }
      if (item.namespaceURI === M_NS) {
        if (item.localName === "oMathPara")
          out += `\n${elements(item)
            .filter((math) => is(math, M_NS, "oMath"))
            .map((math) => `$$${ommlToLatex(math)}$$`)
            .join("\n")}\n`;
        else if (item.localName === "oMath") out += `$${ommlToLatex(item)}$`;
        continue;
      }
      if (item.namespaceURI !== W_NS) continue;
      const name = item.localName ?? "";
      if (SKIP.has(name)) continue;
      if (name === "t") out += item.textContent ?? "";
      else if (name === "br" || name === "cr") out += "\n";
      else if (name === "tab" || name === "ptab") out += "\t";
      else if (name === "noBreakHyphen") out += "-";
      else if (name === "object" || name === "drawing" || name === "pict") {
        picture(item);
        // A text box inside a shape still has text worth reading.
        for (const box of Array.from(
          item.getElementsByTagNameNS?.(W_NS, "txbxContent") ?? [],
        ))
          out += `\n${blocks(box).join("\n")}\n`;
      } else if (PASS.has(name)) out += inline(item);
    }
    return out;
  };
  const paragraph = (node: XmlNode) =>
    inline(node)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim();
  // Block content: paragraphs, tables (one row per line, cells by " | "),
  // content controls and alternate content.
  const blocks = (node: XmlNode): string[] => {
    const out: string[] = [];
    for (const item of elements(node)) {
      if (is(item, MC_NS, "AlternateContent")) {
        const choice = elements(item).find((c) => is(c, MC_NS, "Choice"));
        if (choice) out.push(...blocks(choice));
      } else if (is(item, M_NS, "oMathPara")) {
        out.push(
          elements(item)
            .filter((math) => is(math, M_NS, "oMath"))
            .map((math) => `$$${ommlToLatex(math)}$$`)
            .join("\n"),
        );
      } else if (item.namespaceURI !== W_NS || SKIP.has(item.localName ?? ""))
        continue;
      else if (item.localName === "p") out.push(paragraph(item));
      else if (item.localName === "tbl") {
        const rows = elements(item)
          .filter((row) => is(row, W_NS, "tr"))
          .map((row) =>
            elements(row)
              .filter((cell) => is(cell, W_NS, "tc"))
              .map((cell) => blocks(cell).filter(Boolean).join(" "))
              .join(" | ")
              .trim(),
          )
          .filter((row) => row.replace(/[|\s]/g, ""));
        if (rows.length) out.push(rows.join("\n"));
      } else if (["sdt", "sdtContent", "customXml", "ins", "moveTo"].includes(item.localName ?? ""))
        out.push(...blocks(item));
    }
    return out;
  };
  const parts: string[] = [];
  let chars = 0;
  for (const chunk of chunks) {
    const document = new DOMParser({
      errorHandler: {
        warning: () => {}, error: () => {},
        fatalError: (message: string) => { throw new Error(message); },
      },
    } as never).parseFromString(prefix + chunk + suffix, "text/xml") as unknown as XmlNode;
    const body = (document.getElementsByTagNameNS?.(W_NS, "body") ?? [])[0];
    if (!body) throw new Error("no body");
    const part = blocks(body).join("\n\n");
    chars += part.length + (parts.length ? 2 : 0);
    if (chars > 500_000) throw new ResourceLimitError("docx_text");
    parts.push(part);
  }
  const text = parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, ...counts };
}
