import MathJax from "mathjax";
import { Resvg } from "@resvg/resvg-js";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { FORMULA_CACHE_FILES } from "./cache-limits.js";
// Sizes are in em so the page can scale formulas with its own font size.
export type FormulaImage = { id: string; w: number; h: number; va: number };
// 48 px per em keeps 16 px text sharp on 3x screens.
const PX_PER_EM = 48;
const MAX_PX = 4096;
const MAX_TEX = 2000;
// MathJax sizes a formula in thousands of em without complaint (\rule, \raise,
// \style, or \left( inside nested fractions, which doubles per level), and resvg
// then allocates the whole bitmap: gigabytes, or a panic that aborts the process.
// A formula beyond these bounds falls back to its TeX text.
const MAX_EM = 200;
const MAX_AREA = 2_000_000; // pixels; a page-high derivation is about 1 million
// Each <text> run (Chinese in \text{}) costs resvg about 16 ms.
const MAX_TEXT = 40;
// resvg-js has no free: a bitmap stays in native memory until a full GC
// collects its small wrapper and the next turn of the event loop runs the
// finalizer. V8 sees no reason to collect, so one request with a couple of
// hundred large formulas held 1.5 GB. After every GC_BYTES of bitmaps we collect
// ourselves (serial then turns the event loop); the flag needs nothing on the
// node command line.
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;
const GC_BYTES = 64 * 2 ** 20;
let drawn = 0;
// A render over its caller's pixel budget: null, but not remembered.
const OVER = Symbol("over budget");
// A displayed formula wider than this breaks onto more lines (at = and +), so a
// long chain of equalities fits a phone card (about 20 em wide) without scrolling.
const DISPLAY_EM = 18;
// Chinese inside \text{} is drawn as <text>; without a CJK font it would vanish.
const CJK_FONT = [
  "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
  "C:/Windows/Fonts/simsun.ttc",
  "C:/Windows/Fonts/msyh.ttc",
].find((file) => existsSync(file));
const round = (n: number) => Math.round(n * 1000) / 1000;
let ready: Promise<unknown> | null = null;
// MathJax keeps global state, so conversions run one at a time. Between two the
// event loop turns: other requests get in, and finalizers free what was collected.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next
    .catch(() => undefined)
    .then(() => new Promise((done) => setImmediate(done)));
  return next;
}
export const formulaId = (tex: string, display: boolean, color: string) =>
  createHash("sha256")
    .update(`${display ? `D${DISPLAY_EM}` : "I"}|${color}|${tex}`)
    .digest("hex")
    .slice(0, 40);
class LocalFormulaRenderer {
  bytesWritten = 0;
  // Recently used formulas with their sizes; null marks TeX that failed to render.
  private readonly known = new Map<string, FormulaImage | null>();
  constructor(
    private readonly dir: string,
    private readonly limit = FORMULA_CACHE_FILES,
  ) {}
  // budget: new pixels this caller may still draw; it shrinks as formulas draw.
  async render(
    tex: string,
    display: boolean,
    color: string,
    budget?: { px: number },
  ): Promise<FormulaImage | null> {
    tex = tex.trim();
    if (!tex || tex.length > MAX_TEX) return null;
    const id = formulaId(tex, display, color);
    const hit = this.known.get(id);
    if (hit !== undefined) {
      this.known.delete(id);
      this.known.set(id, hit);
      if (hit) {
        try { const now = new Date(); utimesSync(this.path(id), now, now); } catch { /* Already removed. */ }
      }
      return hit;
    }
    const image = await serial(() =>
      this.draw(id, tex, display, color, budget),
    ).catch(() => null);
    if (image === OVER) return null;
    this.known.set(id, image);
    if (this.known.size > this.limit)
      this.known.delete(this.known.keys().next().value!);
    return image;
  }
  file(id: string): Buffer | null {
    if (!/^[0-9a-f]{40}$/.test(id)) return null;
    try {
      return readFileSync(this.path(id));
    } catch {
      return null;
    }
  }
  private path(id: string) {
    return join(this.dir, `${id}.png`);
  }
  private async draw(
    id: string,
    tex: string,
    display: boolean,
    color: string,
    budget?: { px: number },
  ): Promise<FormulaImage | null | typeof OVER> {
    ready ??= MathJax.init({
      loader: {
        load: ["input/tex", "output/svg"],
        // Node's ESM loader needs file URLs for Windows drive-letter paths.
        require: (file: string) =>
          import(isAbsolute(file) ? pathToFileURL(file).href : file),
      },
      tex: { maxBuffer: 8_000, maxMacros: 1_000 },
      // Inline line breaking would split one formula into several pieces.
      svg: {
        fontCache: "none",
        linebreaks: { inline: false },
        displayOverflow: "linebreak",
      },
    });
    await ready;
    const adaptor = MathJax.startup.adaptor;
    const node = await MathJax.tex2svgPromise(tex, {
      display,
      em: 16,
      ex: 8,
      containerWidth: DISPLAY_EM * 16,
    });
    let svg = adaptor.serializeXML(adaptor.firstChild(node));
    if (svg.includes("data-mjx-error") || svg.includes("<merror")) return null;
    // Only self-contained glyphs go to the native rasterizer. This also keeps
    // future MathJax extensions from introducing local-file or URL resources.
    if (/<(?:image|foreignObject)\b/i.test(svg) || /(?:href|src)\s*=\s*["'](?!#)/i.test(svg)) return null;
    const box = svg.match(/viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/);
    const heightEx = Number(svg.match(/height="([\d.]+)ex"/)?.[1]);
    const alignEx = Number(
      svg.match(/vertical-align:\s*(-?[\d.]+)ex/)?.[1] ?? 0,
    );
    if (!box || !heightEx) return null;
    // The viewBox is in thousandths of an em.
    const w = Number(box[3]) / 1000,
      h = Number(box[4]) / 1000;
    if (!(w > 0 && h > 0) || w > MAX_EM || h > MAX_EM) return null;
    if ((svg.match(/<text/g)?.length ?? 0) > MAX_TEXT) return null;
    const scale = Math.min(
      PX_PER_EM,
      MAX_PX / w,
      MAX_PX / h,
      Math.sqrt(MAX_AREA / (w * h)),
    );
    const width = Math.max(1, Math.round(w * scale));
    // A hairline far taller than wide: one pixel across is already too tall.
    if ((h * width) / w > MAX_PX) return null;
    const va = (alignEx * h) / heightEx;
    if (!existsSync(this.path(id))) {
      const px = width * Math.ceil((h * width) / w);
      if (budget) {
        if (px > budget.px) return OVER;
        budget.px -= px;
      }
      svg = svg.replace(/currentColor/g, color);
      const cjk = svg.includes("<text") && CJK_FONT;
      const png = new Resvg(svg, {
        fitTo: { mode: "width", value: width },
        font: cjk
          ? { loadSystemFonts: false, fontFiles: [CJK_FONT] }
          : { loadSystemFonts: false },
      })
        .render()
        .asPng();
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.path(id), png);
      this.bytesWritten = png.length;
      drawn += px * 4;
      if (drawn > GC_BYTES) {
        collect();
        drawn = 0;
      }
    } else {
      // Handed out again: the daily prune counts age from the last use.
      try {
        const now = new Date();
        utimesSync(this.path(id), now, now);
      } catch {
        // Gone in between: the next page asking for it draws it again.
      }
    }
    return { id, w: round(w), h: round(h), va: round(va) };
  }
}

export async function processFormula(input: unknown) {
  const data = input as { dir: string; limit: number; tex: string; display: boolean; color: string; px: number };
  const budget = { px: data.px };
  const renderer = new LocalFormulaRenderer(data.dir, data.limit);
  const image = await renderer.render(data.tex, data.display, data.color, budget);
  return { image, px: budget.px, bytesWritten: renderer.bytesWritten };
}
