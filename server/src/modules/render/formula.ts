import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { runIsolated } from "../../shared/isolated-worker.js";
import { FORMULA_CACHE_BYTES, FORMULA_CACHE_FILES, FORMULA_CACHE_GRACE_MS } from "./cache-limits.js";
export type FormulaImage = { id: string; w: number; h: number; va: number };
export const formulaId = (tex: string, display: boolean, color: string) =>
  createHash("sha256").update(`${display ? "D18" : "I"}|${color}|${tex}`).digest("hex").slice(0, 40);
export class FormulaRenderer {
  private readonly known = new Map<string, FormulaImage | null>();
  private readonly drawing = new Map<string, Promise<FormulaImage | null>>();
  private usage = { count: 0, bytes: 0 };
  private cleaning?: Promise<number>;
  private writesDuringCleanup?: Map<string, number>;
  private maintenance?: { timer: NodeJS.Timeout; pressure?: NodeJS.Timeout; notify: (removed: number) => void };
  constructor(private readonly dir: string, private readonly limit = FORMULA_CACHE_FILES) {}
  // The long-lived application owns maintenance. Workers exit after a second
  // idle, so neither worker startup nor a newly drawn image scans the directory.
  startMaintenance(notify: (removed: number) => void = () => {}, intervalMs = 60_000) {
    const run = () => { void this.maintain().then(notify).catch(() => undefined); };
    const timer = setInterval(run, intervalMs);
    timer.unref();
    this.maintenance = { timer, notify };
    run();
    return () => {
      clearInterval(timer);
      clearTimeout(this.maintenance?.pressure);
      this.maintenance = undefined;
    };
  }
  maintain(maxAgeMs = 30 * 86400_000, now = Date.now()): Promise<number> {
    if (this.cleaning) return this.cleaning;
    this.writesDuringCleanup = new Map();
    this.cleaning = this.trim(maxAgeMs, now).finally(() => {
      this.cleaning = undefined;
      this.writesDuringCleanup = undefined;
    });
    return this.cleaning;
  }
  private async trim(maxAgeMs: number, now: number) {
    let names: string[];
    try { names = await readdir(this.dir); } catch { return 0; }
    const files: { id: string; bytes: number; time: number }[] = [];
    // Limit outstanding disk operations and yield throughout the scan.
    for (let offset = 0; offset < names.length; offset += 128) {
      await Promise.all(names.slice(offset, offset + 128).map(async (name) => {
        if (!/^[0-9a-f]{40}\.png$/.test(name)) return;
        try {
          const value = await stat(join(this.dir, name));
          if (value.isFile()) files.push({ id: name.slice(0, -4), bytes: value.size, time: value.mtimeMs });
        } catch { /* Removed while scanning. */ }
      }));
    }
    files.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    const scanned = new Set(files.map((file) => file.id));
    let count = files.length, bytes = files.reduce((sum, file) => sum + file.bytes, 0), removed = 0;
    for (const file of files) {
      const overCapacity = count > Math.min(this.limit, FORMULA_CACHE_FILES) || bytes > FORMULA_CACHE_BYTES;
      const expired = !this.known.has(file.id) && now - file.time >= Math.max(maxAgeMs, FORMULA_CACHE_GRACE_MS);
      if (!overCapacity && !expired) continue;
      try {
        // A render/cache hit may have reused this image during the async scan.
        if ((await stat(this.path(file.id))).mtimeMs !== file.time) continue;
        await unlink(this.path(file.id));
        this.known.delete(file.id);
        count--;
        bytes -= file.bytes;
        removed++;
      } catch { /* Removed or replaced concurrently; rescan next time. */ }
    }
    for (const [id, size] of this.writesDuringCleanup ?? []) {
      if (!scanned.has(id)) { count++; bytes += size; }
    }
    this.usage = { count, bytes };
    return removed;
  }
  private written(id: string, bytes: number) {
    if (!bytes) return;
    this.usage.count++;
    this.usage.bytes += bytes;
    this.writesDuringCleanup?.set(id, bytes);
    const maintenance = this.maintenance;
    if (!maintenance || maintenance.pressure || this.cleaning ||
        (this.usage.count <= Math.min(this.limit, FORMULA_CACHE_FILES) && this.usage.bytes <= FORMULA_CACHE_BYTES)) return;
    // Coalesce a busy burst rather than rescanning once per new formula. The
    // regular minute timer also catches external writes and quiet overshoots.
    maintenance.pressure = setTimeout(() => {
      void this.maintain().then(maintenance.notify).catch(() => undefined).finally(() => { maintenance.pressure = undefined; });
    }, 10_000);
    maintenance.pressure.unref();
  }
  async render(tex: string, display: boolean, color: string, budget?: { px: number }): Promise<FormulaImage | null> {
    tex = tex.trim();
    if (!tex || tex.length > 2000 || !/^#[0-9a-f]{6}$/i.test(color)) return null;
    const id = formulaId(tex, display, color);
    const cached = this.known.get(id);
    if (cached !== undefined && (!cached || existsSync(this.path(id)))) {
      this.known.delete(id);
      this.known.set(id, cached);
      if (cached) {
        try { const now = new Date(); utimesSync(this.path(id), now, now); } catch { /* Gone between lookup and touch. */ }
      }
      return cached;
    }
    // The same equation may be visible in several concurrent pages. Draw it
    // once; a cache hit (including one in progress) does not occupy the queue.
    const existing = this.drawing.get(id);
    if (existing) return existing;
    const drawing = this.draw(tex, display, color, id, budget);
    this.drawing.set(id, drawing);
    try { return await drawing; } finally { this.drawing.delete(id); }
  }
  private async draw(tex: string, display: boolean, color: string, id: string, budget?: { px: number }) {
    try {
      const result = await runIsolated<{ image: FormulaImage | null; px: number; bytesWritten: number }>("formula", "formula", {
        dir: this.dir, limit: this.limit, tex, display, color, px: budget?.px ?? 2_010_000,
      });
      // Queue submission is bounded and the shared budget is reserved up front
      // by MarkdownRenderer's sequential loop.
      if (budget) budget.px = result.px;
      this.written(id, result.bytesWritten);
      if (result.image) this.known.set(id, result.image);
      if (this.known.size > this.limit) this.known.delete(this.known.keys().next().value!);
      return result.image;
    } catch { return null; }
  }
  file(id: string): Buffer | null {
    if (!/^[0-9a-f]{40}$/.test(id)) return null;
    try {
      const image = readFileSync(this.path(id));
      // Cached card blocks bypass render(), but fetching their image is still
      // a real use for LRU purposes.
      try { const now = new Date(); utimesSync(this.path(id), now, now); } catch { /* Evicted after reading. */ }
      return image;
    } catch {
      return null;
    }
  }
  // Deletes cached images written or reused more than maxAgeMs ago, except those still
  // in `known`: render hands their URLs out without looking at the disk.
  // A deleted image is drawn again the next time a page asks for it.
  prune(maxAgeMs: number, now = Date.now()) {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const id = name.slice(0, -4);
      if (!/^[0-9a-f]{40}\.png$/.test(name) || this.known.has(id)) continue;
      try {
        if (now - statSync(this.path(id)).mtimeMs < Math.max(maxAgeMs, FORMULA_CACHE_GRACE_MS)) continue;
        unlinkSync(this.path(id));
        removed++;
      } catch {
        // Already gone or unreadable: leave it for the next round.
      }
    }
    return removed;
  }
  private path(id: string) {
    return join(this.dir, `${id}.png`);
  }
}
