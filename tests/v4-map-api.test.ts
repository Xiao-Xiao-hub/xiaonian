import assert from "node:assert/strict";
import test from "node:test";
import { fakeServices, makeApp } from "./fixtures.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";
import { MAP_CARDS } from "../server/src/modules/learn/map-cards.js";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthService } from "../server/src/modules/auth/service.js";
import { registerLearnRoutes } from "../server/src/modules/learn/routes.js";
import type { LearnService } from "../server/src/modules/learn/service.js";
import { FormulaRenderer } from "../server/src/modules/render/formula.js";
import type { MarkdownRenderer } from "../server/src/modules/render/markdown.js";
const Fastify = createRequire(new URL("../server/package.json", import.meta.url))(
  "fastify",
) as typeof import("fastify").default;

async function fixture() {
  const clock = { at: new Date("2026-10-12T01:00:00.000Z") };
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, () => clock.at, store);
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: { key: "v4-map" },
  });
  const userId = login.json().data.user.id as string;
  const headers = { authorization: `Bearer ${login.json().data.token}` };
  const get = (url: string) => app.inject({ method: "GET", url, headers });
  return { app, store, clock, userId, get };
}

type Inline = { t: string; tex?: string; v?: string };
type Block = { t: string; c?: Inline[]; tex?: string };
// Inline pieces of rendered blocks, paragraphs included.
const inlines = (blocks: Block[]) =>
  blocks.flatMap((block) => (block.c ? block.c : [block as Inline]));

// Progress fields that the public map must not carry.
const PERSONAL = [
  "state", "stateReason", "red", "stuck", "stuckAt", "inferredBy", "retest",
  "cards", "mistakeCount", "taught", "ready", "next", "rank", "done", "self",
  "extDone", "up", "summary", "taughtTo", "resumeActive", "hidden", "started",
  "mistakesOpen",
];

test("v4 地图：每个点带坐标、公式、要点和渲染块，每章带画布和连线，旧字段都在", async () => {
  const f = await fixture();
  try {
    const res = await f.get("/v1/learn/map?cards=1");
    assert.equal(res.statusCode, 200);
    const data = res.json().data;
    // Old fields stay for 0.2.x / 0.4.0.
    for (const field of ["title", "taughtTo", "chapters", "summary", "resumeActive"])
      assert.ok(field in data, field);
    // 错题本 tile on the learn home (v4 fix C).
    assert.equal(data.mistakesOpen, 0);
    assert.equal(data.chapters.length, CALC_MAP.chapters.length);
    for (const chapter of data.chapters) {
      for (const field of ["id", "label", "short", "book", "hidden", "started", "rank",
        "done", "total", "self", "extDone", "tiers", "up", "nodes", "sides", "next",
        "main", "side", "points"])
        assert.ok(field in chapter, `${chapter.id}.${field}`);
      assert.ok(chapter.canvas.width >= 375 && chapter.canvas.height > 0);
      assert.ok(chapter.lines.length > 0);
      const ids = new Set(chapter.points.map((p: { id: string }) => p.id));
      for (const line of chapter.lines) {
        assert.ok(ids.has(line.from) && ids.has(line.to), `${line.from}>${line.to}`);
        assert.ok(["main", "up", "opt"].includes(line.type));
        assert.ok(line.points.length >= 2);
        for (const q of line.points)
          assert.ok(typeof q.x === "number" && typeof q.y === "number");
      }
      const places = new Set<string>();
      for (const point of chapter.points) {
        for (const field of ["id", "name", "section", "tier", "line", "side", "key",
          "hard", "level", "exam", "short", "state", "stateReason", "red", "stuck",
          "stuckAt", "inferredBy", "prereqs", "followers", "retest", "cards",
          "mistakeCount", "taught", "ready"])
          assert.ok(field in point, `${point.id}.${field}`);
        assert.ok(point.pos.x >= 0 && point.pos.x <= chapter.canvas.width, point.id);
        assert.ok(point.pos.y >= 0 && point.pos.y <= chapter.canvas.height, point.id);
        assert.ok(["below", "left"].includes(point.pos.label));
        places.add(`${point.pos.x},${point.pos.y}`);
        assert.deepEqual(point.formulas, MAP_CARDS[point.id]!.formulas);
        assert.deepEqual(point.keys, MAP_CARDS[point.id]!.keys);
        assert.equal(point.keys.length, 3);
        assert.equal(point.formulaBlocks.length, point.formulas.length);
        assert.equal(point.keyBlocks.length, 3);
      }
      assert.equal(places.size, chapter.points.length, `${chapter.id} 坐标不重复`);
    }
  } finally {
    await f.app.close();
  }
});

test("v4 卡片公式都能渲染成图片，不落回 TeX 原文；深色主题用另一种墨色", async () => {
  const f = await fixture();
  try {
    const light = (await f.get("/v1/learn/map?cards=1")).json().data;
    for (const chapter of light.chapters)
      for (const point of chapter.points) {
        for (const blocks of point.formulaBlocks as Block[][]) {
          const pieces = inlines(blocks);
          assert.equal(pieces.length, 1, point.id);
          assert.equal(pieces[0]!.t, "math", `${point.id} ${pieces[0]!.tex ?? pieces[0]!.v}`);
        }
        for (const blocks of point.keyBlocks as Block[][])
          assert.ok(
            inlines(blocks).every((piece) => piece.t !== "tex"),
            `${point.id} 要点里的公式`,
          );
      }
    const point = light.chapters[0].points[0];
    // Without cards=1 (old clients) the map has the card text but no blocks.
    const plain = (await f.get("/v1/learn/map")).json().data.chapters[0].points[0];
    assert.deepEqual(plain.keys, point.keys);
    assert.ok(plain.pos && !("formulaBlocks" in plain) && !("keyBlocks" in plain));
    const dark = (await f.get("/v1/learn/map?cards=1&tone=dark")).json().data.chapters[0].points[0];
    assert.notDeepEqual(dark.formulaBlocks, point.formulaBlocks);
    // The point detail carries the same card.
    const detail = (await f.get(`/v1/learn/points/${point.id}`)).json().data;
    assert.deepEqual(detail.formulas, point.formulas);
    assert.deepEqual(detail.formulaBlocks, point.formulaBlocks);
    assert.deepEqual(detail.pos, point.pos);
    // 练一题's dark kp card: the first formula in the dark tone.
    assert.deepEqual(detail.kpFormulaBlocks, dark.formulaBlocks[0]);
  } finally {
    await f.app.close();
  }
});

test("v4 公开地图不用登录，不带进度，也不记事件", async () => {
  const f = await fixture();
  try {
    const res = await f.app.inject({ method: "GET", url: "/v1/learn/map/public" });
    assert.equal(res.statusCode, 200);
    const data = res.json().data;
    assert.equal(data.chapters.length, CALC_MAP.chapters.length);
    const walk = (value: unknown, path: string) => {
      if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
      else if (value && typeof value === "object")
        for (const [k, v] of Object.entries(value)) {
          if (path.split(".").length <= 4 && !path.includes("Blocks"))
            assert.ok(!PERSONAL.includes(k), `${path}.${k}`);
          walk(v, `${path}.${k}`);
        }
    };
    for (const k of Object.keys(data)) assert.ok(!PERSONAL.includes(k), k);
    for (const chapter of data.chapters) {
      for (const k of Object.keys(chapter)) assert.ok(!PERSONAL.includes(k), `${chapter.id}.${k}`);
      assert.ok(chapter.canvas && chapter.lines.length);
      for (const point of chapter.points) {
        for (const k of Object.keys(point)) assert.ok(!PERSONAL.includes(k), `${point.id}.${k}`);
        assert.ok(point.pos && point.formulas.length && point.keys.length === 3);
        assert.equal(point.formulaBlocks.length, point.formulas.length);
        for (const field of ["name", "tier", "key", "hard", "side", "line"])
          assert.ok(field in point, `${point.id}.${field}`);
        // Prerequisites are plain ids (the sheet lists them all, across chapters).
        assert.ok(point.prereqs.every((id: unknown) => typeof id === "string"));
      }
    }
    walk(data, "data");
    const events = f.store.db
      .prepare("SELECT count(*) AS n FROM events WHERE name='map_open'")
      .get() as { n: number };
    assert.equal(events.n, 0);
  } finally {
    await f.app.close();
  }
});

test("v4 关掉个性化推荐时，下一步按课本顺序", async () => {
  const f = await fixture();
  try {
    const chapter = CALC_MAP.chapters.find((c) => c.id === "limit")!;
    const at = f.clock.at.toISOString();
    // One point done, so the chapter is past D101's fresh start.
    const done = chapter.points.find((p) => p.line === "main")!;
    f.store.db
      .prepare(
        "INSERT INTO map_points(user_id,point_id,correct_at,due_on,interval,practice_on,updated_at) VALUES(?,?,?,'2026-10-20',7,NULL,?)",
      )
      .run(f.userId, done.id, at, at);
    const next = async () =>
      (await f.get("/v1/learn/map")).json().data.chapters.find(
        (c: { id: string }) => c.id === "limit",
      ).next as { id: string; reason: string };
    const textbook = chapter.points.find((p) => p.line === "main" && p.id !== done.id)!;
    const personal = await next();
    assert.notEqual(personal.id, textbook.id, "个性化时按重点排序，和课本顺序不同");

    f.store.db
      .prepare("UPDATE users SET data=json_set(data,'$.personalized',json('false')) WHERE id=?")
      .run(f.userId);
    const ordered = await next();
    assert.equal(ordered.id, textbook.id);
    assert.equal(ordered.reason, "接着往下学");

    f.store.db
      .prepare("UPDATE users SET data=json_set(data,'$.personalized',json('true')) WHERE id=?")
      .run(f.userId);
    assert.equal((await next()).id, personal.id);
  } finally {
    await f.app.close();
  }
});

test("v4 关掉个性化推荐时，下一步也不提随心记里聊过的点", async () => {
  const f = await fixture();
  try {
    const chapter = CALC_MAP.chapters.find((c) => c.id === "limit")!;
    const talked = chapter.points.filter((p) => p.line === "main").at(-1)!;
    f.store.db
      .prepare("INSERT INTO events(user_id,name,data,created_at) VALUES(?,'resume_show',?,?)")
      .run(f.userId, JSON.stringify({ src: "point", srcId: talked.id }), f.clock.at.toISOString());
    const next = async () =>
      (await f.get("/v1/learn/map")).json().data.chapters.find(
        (c: { id: string }) => c.id === "limit",
      ).next as { id: string; reason: string };
    const personal = await next();
    assert.equal(personal.id, talked.id);
    assert.equal(personal.reason, "今天在随心记聊过它");
    f.store.db
      .prepare("UPDATE users SET data=json_set(data,'$.personalized',json('false')) WHERE id=?")
      .run(f.userId);
    const ordered = await next();
    assert.notEqual(ordered.reason, "今天在随心记聊过它");
    assert.notEqual(ordered.id, talked.id);
  } finally {
    await f.app.close();
  }
});

test("v4 公开地图每个地址每分钟 60 次", async () => {
  const f = await fixture();
  try {
    const get = () =>
      f.app.inject({ method: "GET", url: "/v1/learn/map/public", remoteAddress: "203.0.113.9" });
    for (let i = 0; i < 60; i++) assert.equal((await get()).statusCode, 200, `request ${i + 1}`);
    assert.equal((await get()).statusCode, 429);
  } finally {
    await f.app.close();
  }
});

// The learn routes alone, with a markdown renderer that counts its calls.
async function cardsApp(deps: { cardTtlMs?: number; prewarm?: boolean }) {
  const app = Fastify();
  let calls = 0;
  const markdown = {
    render: async () => {
      calls++;
      return [];
    },
  } as unknown as MarkdownRenderer;
  const learn = { publicMap: () => ({ chapters: [{ points: [{ id: "limit-rules" }] }] }) } as unknown as LearnService;
  registerLearnRoutes(app, { auth: {} as AuthService, learn, markdown, ...deps });
  await app.ready();
  return { app, calls: () => calls };
}
const cardCount = Object.keys(MAP_CARDS).length;

test("v4 地图卡片的渲染缓存会过期，过期后重新渲染", async () => {
  const kept = await cardsApp({ prewarm: false });
  try {
    await kept.app.inject({ method: "GET", url: "/v1/learn/map/public" });
    const first = kept.calls();
    assert.ok(first >= cardCount, String(first));
    await kept.app.inject({ method: "GET", url: "/v1/learn/map/public" });
    assert.equal(kept.calls(), first, "within the TTL nothing is drawn again");
  } finally {
    await kept.app.close();
  }
  const short = await cardsApp({ prewarm: false, cardTtlMs: 0 });
  try {
    await short.app.inject({ method: "GET", url: "/v1/learn/map/public" });
    const first = short.calls();
    await short.app.inject({ method: "GET", url: "/v1/learn/map/public" });
    assert.equal(short.calls(), first * 2, "expired cards go through render() again");
  } finally {
    await short.app.close();
  }
});

test("v4 地图卡片启动约 10 秒后在后台预热两种主题，测试里默认不预热", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const off = await cardsApp({});
  try {
    t.mock.timers.tick(20_000);
    await new Promise((done) => setImmediate(done));
    assert.equal(off.calls(), 0);
  } finally {
    await off.app.close();
  }
  const on = await cardsApp({ prewarm: true });
  try {
    t.mock.timers.tick(9_000);
    await new Promise((done) => setImmediate(done));
    assert.equal(on.calls(), 0);
    t.mock.timers.tick(1_000);
    for (let i = 0; i < 50 && on.calls() < 2 * cardCount * 2; i++)
      await new Promise((done) => setImmediate(done));
    const both = on.calls();
    assert.ok(both > cardCount, `both tones rendered (${both})`);
    await on.app.inject({ method: "GET", url: "/v1/learn/map/public?tone=dark" });
    assert.equal(on.calls(), both, "the dark tone was warm already");
  } finally {
    await on.app.close();
  }
});

test("v4 复用已有的公式图片会刷新修改时间，免得被每日清理删掉", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zhiye-formula-"));
  const first = await new FormulaRenderer(dir).render("x^2+1", false, "#1f2937");
  assert.ok(first);
  const file = join(dir, `${first.id}.png`);
  const old = new Date(Date.now() - 40 * 86400000);
  utimesSync(file, old, old);
  // A fresh process (empty memory) hands the same image out again.
  const again = new FormulaRenderer(dir);
  assert.deepEqual(await again.render("x^2+1", false, "#1f2937"), first);
  assert.ok(Date.now() - statSync(file).mtimeMs < 60_000);
  assert.equal(new FormulaRenderer(dir).prune(30 * 86400000), 0);
  assert.ok(existsSync(file));
});
