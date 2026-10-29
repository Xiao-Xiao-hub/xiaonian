import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { FormulaRenderer } from "../server/src/modules/render/formula.js";
import { processFormula } from "../server/src/modules/render/formula-worker.js";
import { FORMULA_CACHE_BYTES, FORMULA_CACHE_FILES } from "../server/src/modules/render/cache-limits.js";
import { MarkdownRenderer, hasDegradedRender, type Block } from "../server/src/modules/render/markdown.js";
import { registerRenderRoutes } from "../server/src/modules/render/routes.js";
import { registerLearnRoutes } from "../server/src/modules/learn/routes.js";
import { MAP_CARDS } from "../server/src/modules/learn/map-cards.js";
import type { LearnService } from "../server/src/modules/learn/service.js";
import type { AuthService } from "../server/src/modules/auth/service.js";
import { LegalService } from "../server/src/modules/legal/service.js";
import { fakeServices, makeApp } from "./fixtures.js";
const Fastify = createRequire(new URL("../server/package.json", import.meta.url))("fastify") as typeof import("fastify").default;
const folder = () => mkdtempSync(join(tmpdir(), "security-render-maintenance-"));
const ink = "#1f2937";

// processFormula constructs a fresh local renderer for every image, including
// after a worker restart. No pre-scan or warm directory index is provided here.
test("new-formula cost stays comparable with zero and 20000 cached images", async (t) => {
  const empty = folder(), full = folder();
  for (let i = 0; i < FORMULA_CACHE_FILES; i++)
    writeFileSync(join(full, `${i.toString(16).padStart(40, "0")}.png`), "cached");
  const draw = (dir: string, tex: string) => processFormula({ dir, tex, display: false, color: ink, limit: FORMULA_CACHE_FILES, px: 2_010_000 });
  await draw(folder(), "x+0"); // MathJax initialization is independent of cache size.
  const timings: number[] = [];
  for (const dir of [empty, full]) {
    const start = performance.now();
    for (let i = 0; i < 10; i++) assert.ok((await draw(dir, `x+${i + 10}`)).image);
    timings.push((performance.now() - start) / 10);
  }
  t.diagnostic(`processFormula average over 10 new images: empty=${timings[0]!.toFixed(2)} ms, 20000=${timings[1]!.toFixed(2)} ms`);
  assert.ok(timings[1]! < timings[0]! * 4 + 10, `cache-size overhead: ${timings.join(" / ")} ms`);
  assert.equal(readdirSync(full).length, FORMULA_CACHE_FILES + 10, "new images are never refused during the cleanup interval");
  const renderer = new FormulaRenderer(full);
  assert.equal(await renderer.maintain(), 10);
  assert.equal(readdirSync(full).length, FORMULA_CACHE_FILES);
  assert.ok(await renderer.render("y+123", false, ink), "new formulas remain available after capacity eviction");
});

test("formula workers have no directory enumeration during startup or drawing", () => {
  const source = readFileSync(new URL("../server/src/modules/render/formula-worker.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /readdir|opendir|trimCache|\bprune\(/, "the short-lived worker must never own cache scans");
});

test("reading an image from cached card blocks refreshes its LRU position", async () => {
  const dir = folder();
  const renderer = new FormulaRenderer(dir, 2);
  const first = await renderer.render("x+110", false, ink);
  const second = await renderer.render("x+111", false, ink);
  assert.ok(first && second);
  const old = new Date(Date.now() - 120_000), newer = new Date(Date.now() - 60_000);
  utimesSync(join(dir, `${first.id}.png`), old, old);
  utimesSync(join(dir, `${second.id}.png`), newer, newer);
  assert.ok(renderer.file(first.id));
  const third = await renderer.render("x+112", false, ink);
  assert.ok(third);
  await renderer.maintain();
  assert.ok(renderer.file(first.id), "reading a published card image counts as use without rerendering its card");
  assert.equal(renderer.file(second.id), null);
  assert.ok(renderer.file(third.id));
});

test("the parent periodic timer reclaims excess files and bytes without another render", async (t) => {
  const dir = folder();
  const renderer = new FormulaRenderer(dir, 2);
  await renderer.maintain();
  t.after(renderer.startMaintenance(() => {}, 30));
  await delay(10); // Let the startup pass finish before exceeding the limits.
  for (let i = 0; i < 4; i++) writeFileSync(join(dir, `${i.toString(16).padStart(40, "0")}.png`), "cached");
  const large = join(dir, `${"f".repeat(40)}.png`);
  writeFileSync(large, "");
  truncateSync(large, FORMULA_CACHE_BYTES + 1);
  const withinLimit = () => {
    const names = readdirSync(dir);
    return names.length <= 2 && names.reduce((sum, name) => sum + statSync(join(dir, name)).size, 0) <= FORMULA_CACHE_BYTES;
  };
  const until = Date.now() + 3000;
  while (!withinLimit() && Date.now() < until) await delay(20);
  assert.ok(withinLimit(), "periodic maintenance runs independently of drawing");
  assert.ok(await renderer.render("x+10", false, ink));
});

test("ten simultaneous 200-formula requests from one user leave another user responsive", async (t) => {
  const app = makeApp(fakeServices());
  t.after(() => app.close());
  const users = [];
  for (const key of ["render-busy", "render-other"]) {
    const login = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key } });
    users.push({ authorization: `Bearer ${login.json().data.token}` });
  }
  const render = (headers: Record<string, string>, text: string) => app.inject({ method: "POST", url: "/v1/render", headers, payload: { text } });
  assert.equal((await render(users[1]!, "$x+1$")).statusCode, 200);
  const busy = Array.from({ length: 10 }, (_, request) => render(users[0]!, Array.from({ length: 200 }, (_, i) => `$x_{${request * 200 + i}}+1$`).join(" ")).then((response) => response));
  await delay(20);
  const started = performance.now();
  const other = await render(users[1]!, "$y+987$");
  const elapsed = performance.now() - started;
  t.diagnostic(`another user's formula completed in ${elapsed.toFixed(2)} ms during the 10-request burst`);
  assert.equal(other.statusCode, 200, other.body);
  assert.equal(other.json().data.blocks[0].c[0].t, "math");
  assert.ok(elapsed < 5000);
  const responses = await Promise.all(busy);
  assert.equal(responses.filter((response) => response.statusCode === 200).length, 10);
  assert.equal(responses.filter((response) => response.statusCode === 429).length, 0);
  for (const response of responses.filter((response) => response.statusCode === 200))
    assert.equal(response.json().data.blocks[0].c.filter((part: { t: string }) => part.t === "math").length, 200);
  assert.equal((await render(users[0]!, "$x+2$")).statusCode, 200, "completed work releases the user admission slot");
});

test("a rejected render releases its user slot", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  let failing = true;
  registerRenderRoutes(app, {
    auth: { require: () => ({ id: "user" }) } as unknown as AuthService,
    formulas: new FormulaRenderer(folder()),
    markdown: { render: async () => { if (failing) throw new Error("synthetic renderer failure"); return []; } } as unknown as MarkdownRenderer,
  });
  for (let i = 0; i < 3; i++) assert.equal((await app.inject({ method: "POST", url: "/v1/render", payload: { text: "a" } })).statusCode, 500);
  failing = false;
  assert.equal((await app.inject({ method: "POST", url: "/v1/render", payload: { text: "a" } })).statusCode, 200);
});

for (const degradation of ["formula", "raw-markdown"] as const)
  test(`map and nested detail caches retry after ${degradation} degradation`, async (t) => {
    const app = Fastify();
    t.after(() => app.close());
    const real = new MarkdownRenderer(new FormulaRenderer(folder()));
    const fallback: Block[] = degradation === "formula"
      ? [{ t: "p", c: [{ t: "tex", v: "x+1" }] }]
      : await real.render("长".repeat(200_001), ink);
    let recovering = false, calls = 0;
    const markdown = { render: async () => { calls++; return recovering ? [{ t: "p", c: [{ t: "text", v: "排版已恢复" }] }] : fallback; } } as unknown as MarkdownRenderer;
    const id = "limit-rules", card = MAP_CARDS[id]!;
    const learn = {
      publicMap: () => ({ chapters: [{ points: [{ id }] }] }),
      detail: () => ({ id, intro: "说明", formulas: card.formulas.map((tex) => ({ tex, note: "注释" })), keys: card.keys, example: null }),
    } as unknown as LearnService;
    registerLearnRoutes(app, { auth: {} as AuthService, learn, markdown, prewarm: false });
    const url = `/v1/learn/points/${id}/detail/public`;
    assert.equal((await app.inject(url)).statusCode, 200);
    assert.equal((await app.inject("/v1/learn/map/public")).statusCode, 200);
    const failedCalls = calls;
    recovering = true;
    const restored = await app.inject(url);
    assert.equal(restored.statusCode, 200, restored.body);
    assert.ok(calls > failedCalls, "degraded detail blocks and their formula cards are rendered again immediately");
    assert.equal(restored.json().data.formulas[0].blocks[0].c[0].v, "排版已恢复");
    await app.inject("/v1/learn/map/public");
    const successfulCalls = calls;
    await app.inject(url);
    await app.inject("/v1/learn/map/public");
    assert.equal(calls, successfulCalls, "successful rendering still retains the 12-hour cache");
  });

test("degraded status tracks internal fallback without changing JSON response fields", async () => {
  const markdown = new MarkdownRenderer({ render: async () => null } as unknown as FormulaRenderer);
  const blocks = await markdown.render("$x+1$", ink);
  assert.ok(hasDegradedRender({ nested: { blocks } }));
  assert.equal(JSON.stringify(blocks), '[{"t":"p","c":[{"t":"tex","v":"x+1"}]}]');
  const plain = await markdown.render("正常文字", ink);
  assert.equal(hasDegradedRender({ blocks: plain }), false);
});

test("legal sections use one render slot at a time and keep their original order", async () => {
  const dir = folder();
  writeFileSync(join(dir, "privacy-policy.md"), "# 隐私说明\n版本：测试\n> **摘要**\n> 摘要正文\n\n开头正文\n\n## 一\n第一节\n## 二\n第二节\n## 三\n第三节\n");
  let active = 0, maximum = 0;
  const calls: string[] = [];
  const markdown = { render: async (text: string) => {
    active++; maximum = Math.max(maximum, active); calls.push(text.trim());
    await delay(5);
    active--;
    return [];
  } } as unknown as MarkdownRenderer;
  const view = await new LegalService(markdown, dir).view("privacy-policy");
  assert.equal(maximum, 1);
  assert.deepEqual(calls, ["摘要正文", "开头正文", "第一节", "第二节", "第三节"]);
  assert.deepEqual(view.sections.map((section) => section.title), ["一", "二", "三"]);
});
