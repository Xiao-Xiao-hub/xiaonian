// second-review server fixes — old-client card edits keep the
// kind, merged cards stay within the edit limits, slots moved on a type
// change, abandoned imports cancel queued jobs, the 卡点 help in the export,
// the thread-list cursor and calls without token usage. Synthetic data only.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { CardService } from "../server/src/modules/cards/service.js";
import { validateMerge } from "../server/src/modules/cards/merge.js";
import { SLOT_KEYS } from "../server/src/modules/cards/schema.js";
import { CrisisSafetyService } from "../server/src/modules/safety/service.js";
import { NOT_VOID } from "../server/src/modules/jobs/runner.js";
import type { ImportFileTools } from "../server/src/modules/imports/parser.js";
import { ChatModel, estimateTokens } from "../server/src/providers/llm.js";
import { DEFAULT_PRICES, usageCost } from "../server/src/shared/budget.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { fakeServices, makeApp } from "./fixtures.js";

const { z } = createRequire(new URL("../server/package.json", import.meta.url))("zod") as typeof import("zod");
const KEY = "f".repeat(40);
async function boot() {
  const store = new SqliteStore(":memory:");
  const services = fakeServices();
  services.judge.noul = 0;
  const app = makeApp(services, { ADMIN_API_KEY: KEY }, undefined, store);
  const login = (
    await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "fx3" } })
  ).json().data;
  const headers = { authorization: `Bearer ${login.token}` };
  const userId = String(login.user.id);
  const cards = new CardService(store, new CrisisSafetyService({ noul: async () => 0 }), () => new Date());
  const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as string }) });
  return { store, app, userId, cards, call };
}
type Boot = Awaited<ReturnType<typeof boot>>;
async function settle(s: Boot, id: string) {
  let card: any;
  for (let i = 0; i < 500; i++) {
    card = (await s.call("GET", `/v1/cards/${id}`)).json().data;
    if (!card.aiJob || !["queued", "running"].includes(card.aiJob.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return card;
}
// The 0.4.0–0.6.0 card editor (pages/card/index.js editorFor + saveEdit at
// 5e7b8fc): every save sends the whole editor, its type included, and only
// the slots of that type.
const TYPE_KEYS: Record<string, string[]> = {
  spark: ["seed", "expand"],
  idea: ["claim", "why"],
  question: ["ask", "known", "stuck", "cause"],
  method: ["when", "steps", "example", "pitfall"],
};
function oldEdit(card: any, change: { title?: string; type?: string } = {}) {
  const type = change.type ?? card.type ?? "idea";
  const current = new Map((card.slots ?? []).map((slot: any) => [slot.key, slot]));
  const slots = (TYPE_KEYS[type] ?? TYPE_KEYS.idea!)
    .map((key) => ({ key, text: String((current.get(key) as any)?.text ?? "").trim() }))
    .filter((slot) => slot.text);
  const open = (card.open ?? [])
    .filter((item: any) => item.text.trim())
    .map((item: any) => ({
      key: item.key,
      cat: item.cat,
      text: item.text.trim(),
      ...(item.quote ? { quote: item.quote } : {}),
    }));
  return {
    version: card.version,
    title: (change.title ?? card.title ?? "").trim(),
    summary: (card.summary ?? "").trim() || null,
    type,
    slots,
    open,
    next: card.next ? { if: card.next.if, then: card.next.then, on: card.next.on || null } : null,
    pointId: card.pointId || null,
    resume: card.resume || "on",
  };
}

test("M1: an old client's edit keeps a todo, note or knowledge card's kind and follow-up", async (t) => {
  const s = await boot();
  t.after(() => s.app.close());
  const made = [
    { text: "买洗衣液和充电线", kind: "todo", follow: "none" },
    { text: "图书馆三楼靠窗位置有插座", kind: "note", follow: "review" },
    { text: "等价无穷小：x 趋于 0 时 sin x 约等于 x", kind: "knowledge", follow: "none" },
  ];
  for (const input of made) {
    const created = await s.call("POST", "/v1/cards", input);
    assert.equal(created.statusCode, 200, created.body);
    const card = await settle(s, created.json().data.card.id);
    assert.equal(card.kind, input.kind);
    const saved = await s.call("PATCH", `/v1/cards/${card.id}`, oldEdit(card, { title: "改个标题" }));
    assert.equal(saved.statusCode, 200, saved.body);
    const after = saved.json().data.card;
    assert.equal(after.title, "改个标题");
    assert.equal(after.kind, input.kind, `${input.kind} stays ${input.kind}`);
    assert.equal(after.type, card.type);
    assert.equal(after.follow, input.follow);
    const versions = s.store.db
      .prepare("SELECT kind FROM card_versions WHERE card_id=? ORDER BY id DESC LIMIT 1")
      .get(card.id) as { kind: string };
    assert.notEqual(versions.kind, "type");
  }
  assert.equal(
    Number(s.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE name='card_type_change'").get()!.n),
    0,
  );
  // A real type change from an old client still changes the kind.
  const todo = (await s.call("GET", `/v1/cards?kind=todo`)).json().data.data[0];
  const full = await settle(s, todo.id);
  const changed = await s.call("PATCH", `/v1/cards/${full.id}`, oldEdit(full, { type: "question" }));
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().data.card.kind, "question");
  assert.equal(changed.json().data.card.type, "question");
});

test("L1: a type change moves the old type's slots into 补充 and stays editable", async (t) => {
  const s = await boot();
  t.after(() => s.app.close());
  const card = (await s.cards.create(s.userId, { text: "期末前不该再报新的竞赛了", kind: "idea" })).card;
  await s.cards.update(s.userId, card.id, card.version, {
    slots: [
      { key: "claim", text: "期末前不报新竞赛" },
      { key: "why", text: "精力不够" },
    ],
  });
  // 0.6.0 switches the type to 思路: its editor sends the method slots only.
  const before = s.cards.detail(s.userId, card.id);
  const res = await s.call("PATCH", `/v1/cards/${card.id}`, oldEdit(before, { type: "method" }));
  assert.equal(res.statusCode, 200, res.body);
  const after = s.cards.detail(s.userId, card.id);
  assert.equal(after.type, "method");
  assert.deepEqual(after.slots, []);
  assert.deepEqual(
    after.supplements.map((x) => x.text).sort(),
    ["因为：精力不够", "我认为：期末前不报新竞赛"],
  );
  assert.ok(after.supplements.every((x) => x.by === "user"), "the learner's slots stay theirs");
  // Every slot key fits the type, as v4.1 checks; the old editor saves again.
  const again = await s.call("PATCH", `/v1/cards/${card.id}`, oldEdit(after, { title: "再改一次" }));
  assert.equal(again.statusCode, 200, again.body);
  // The new client: kind with the earlier slots it does not show sent back.
  await s.cards.update(s.userId, card.id, s.cards.detail(s.userId, card.id).version, {
    slots: [{ key: "steps", text: "先列计划" }],
  });
  const now = s.cards.detail(s.userId, card.id);
  const moved = await s.call("PATCH", `/v1/cards/${card.id}`, {
    version: now.version,
    kind: "question",
    slots: [{ key: "ask", text: "该不该报" }, { key: "steps", text: "先列计划" }],
  });
  assert.equal(moved.statusCode, 200, moved.body);
  const last = s.cards.detail(s.userId, card.id);
  assert.deepEqual(last.slots.map((x) => x.key), ["ask"]);
  assert.ok(last.slots.every((x) => SLOT_KEYS[last.type].includes(x.key)));
  assert.ok(last.supplements.some((x) => x.text === "步骤：先列计划"));
  // Within one type family (想法 → 待办) nothing moves.
  await s.cards.update(s.userId, card.id, last.version, { kind: "idea", slots: [{ key: "claim", text: "不报" }] });
  const idea = s.cards.detail(s.userId, card.id);
  await s.cards.update(s.userId, card.id, idea.version, { kind: "todo" });
  assert.deepEqual(s.cards.detail(s.userId, card.id).slots.map((x) => x.key), ["claim"]);
});

test("M2: a merged card stays within the edit limits and keeps every word", async (t) => {
  const s = await boot();
  t.after(() => s.app.close());
  const make = async (text: string, open: string[], mine: string) => {
    let card = (await s.cards.create(s.userId, { text, kind: "idea" })).card;
    card = (
      await s.cards.update(s.userId, card.id, card.version, {
        open: open.map((q, i) => ({ key: `q${i + 1}`, text: q, cat: "decide" })),
      })
    ).card;
    card = (await s.cards.mine(s.userId, card.id, card.version, { text: mine })).card;
    return card;
  };
  const mineA = "甲".repeat(200),
    mineB = "乙".repeat(200);
  const a = await make("周末复习计划 A", ["先复习哪章？", "几点开始？"], mineA);
  const b = await make("周末复习计划 B", ["要不要做卷子？", "和谁一起？"], mineB);
  const at = new Date().toISOString();
  ["一", "二", "三", "四"].forEach((name, i) => {
    s.store.db
      .prepare("INSERT INTO tags(id,user_id,name,color,by,created_at) VALUES(?,?,?,1,'user',?)")
      .run(`tag_${i}`, s.userId, name, at);
    s.store.db
      .prepare("INSERT INTO card_tags(card_id,tag_id,user_id) VALUES(?,?,?)")
      .run(i < 2 ? a.id : b.id, `tag_${i}`, s.userId);
  });
  const id = s.cards.merge(
    s.userId,
    [a, b].map((c) => ({ id: c.id, version: s.cards.detail(s.userId, c.id).version })),
    { type: "idea", kind: "idea", scene: "study", title: "周末复习", summary: "合并", slots: [{ key: "claim", text: "周末复习" }] },
  );
  const merged = s.cards.detail(s.userId, id);
  assert.equal(merged.version, 1, "拆开 still possible");
  assert.equal((merged.open as unknown[]).length, 3);
  assert.equal(merged.tags.length, 3);
  assert.ok(merged.mine!.length <= 300);
  // No word lost: on the card or in 补充.
  const said = [
    merged.mine,
    ...(merged.open as { text: string }[]).map((o) => o.text),
    ...merged.supplements.map((x) => x.text),
  ].join("\n");
  for (const text of [mineA, mineB, "先复习哪章？", "几点开始？", "要不要做卷子？", "和谁一起？"])
    assert.ok(said.includes(text), text);
  assert.ok(merged.supplements.every((x) => x.by === "user"), "the learner's words stay theirs");
  assert.deepEqual(merged.aiSupplements, []);
  // The 0.6.0 editor, the tag panel and 我的话 all save it back.
  const patched = await s.call("PATCH", `/v1/cards/${id}`, oldEdit(merged, { title: "周末复习改" }));
  assert.equal(patched.statusCode, 200, patched.body);
  let version = patched.json().data.card.version;
  const tags = await s.call("PUT", `/v1/cards/${id}/tags`, { version, tagIds: merged.tags.map((x) => x.id) });
  assert.equal(tags.statusCode, 200, tags.body);
  version = tags.json().data.version;
  const mine = await s.call("POST", `/v1/cards/${id}/mine`, { version, text: merged.mine + "。" });
  assert.equal(mine.statusCode, 200, mine.body);
  // The tags past three stay on the hidden originals.
  assert.equal(s.cards.detail(s.userId, b.id, true).tags.length, 2);
  // The merge's AI summary is cut where the editors take it back.
  const output = validateMerge(
    { title: "复习", summary: "复".repeat(100), slots: [] },
    "idea",
    "复习",
  );
  assert.equal(output.summary.length, 60);
});

test("moved words keep who wrote them: AI slots and open items become AI 补充", async (t) => {
  const s = await boot();
  t.after(() => s.app.close());
  const at = new Date().toISOString();
  const slots = (id: string, value: unknown) =>
    s.store.db.prepare("UPDATE cards SET slots=? WHERE id=?").run(JSON.stringify(value), id);
  const open = (id: string, value: unknown) =>
    s.store.db.prepare("UPDATE cards SET open=? WHERE id=?").run(JSON.stringify(value), id);
  // 补充 stays the learner's own (what 0.4.0–0.6.0 list); the AI's words
  // come in aiSupplements.
  const shown = async (id: string) => {
    const card = (await s.call("GET", `/v1/cards/${id}`)).json().data;
    assert.ok(card.supplements.every((x: any) => x.by === "user"));
    assert.ok(card.aiSupplements.every((x: any) => x.by === "ai"));
    return [...card.supplements, ...card.aiSupplements]
      .map((x: { text: string; by: string }) => [x.text, x.by])
      .sort();
  };
  // A type change from the 0.6.0 editor: an AI slot, one without an author
  // (the AI's, as the card page shows it) and the learner's own.
  const a = (await s.cards.create(s.userId, { text: "期末前不该再报新的竞赛了", kind: "idea" })).card;
  slots(a.id, [
    { key: "claim", text: "期末前不报新竞赛", by: "ai" },
    { key: "why", text: "精力不够" },
  ]);
  const res = await s.call("PATCH", `/v1/cards/${a.id}`, oldEdit(s.cards.detail(s.userId, a.id), { type: "method" }));
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(await shown(a.id), [
    ["因为：精力不够", "ai"],
    ["我认为：期末前不报新竞赛", "ai"],
  ]);
  // The new client sends an earlier kind's slots back as they were: they
  // stay the AI's; one the learner rewrote is theirs.
  const b = (await s.cards.create(s.userId, { text: "背单词要不要用卡片", kind: "idea" })).card;
  slots(b.id, [
    { key: "claim", text: "要用卡片", by: "ai" },
    { key: "why", text: "方便复习", by: "ai" },
  ]);
  const moved = await s.call("PATCH", `/v1/cards/${b.id}`, {
    version: s.cards.detail(s.userId, b.id).version,
    kind: "question",
    slots: [
      { key: "ask", text: "用哪种卡片" },
      { key: "claim", text: "要用卡片" },
      { key: "why", text: "随时能翻" },
    ],
  });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.deepEqual(await shown(b.id), [
    ["因为：随时能翻", "user"],
    ["我认为：要用卡片", "ai"],
  ]);
  // A merge: AI open items past three, and an original's AI 补充, come along
  // as the AI's; the learner's own item stays theirs.
  const c = (await s.cards.create(s.userId, { text: "周末复习计划 C", kind: "idea" })).card;
  const d = (await s.cards.create(s.userId, { text: "周末复习计划 D", kind: "idea" })).card;
  open(c.id, [
    { key: "q1", cat: "decide", text: "先复习哪章？", by: "ai" },
    { key: "q2", cat: "decide", text: "几点开始？", by: "ai" },
  ]);
  open(d.id, [
    { key: "q1", cat: "decide", text: "要不要做卷子？", by: "user" },
    { key: "q2", cat: "verify", text: "图书馆开门吗？" },
    { key: "q3", cat: "decide", text: "和谁一起？", by: "ai" },
  ]);
  s.store.db
    .prepare("INSERT INTO card_versions(card_id,user_id,kind,by,data,created_at) VALUES(?,?,'supplement','ai',?,?)")
    .run(c.id, s.userId, JSON.stringify({ text: "例子：先做第三章", from: "type" }), at);
  const id = s.cards.merge(
    s.userId,
    [c, d].map((x) => ({ id: x.id, version: s.cards.detail(s.userId, x.id).version })),
    { type: "idea", kind: "idea", scene: "study", title: "周末复习", summary: "合并", slots: [] },
  );
  const merged = s.cards.detail(s.userId, id);
  assert.equal(merged.version, 1, "拆开 still possible");
  assert.deepEqual(
    (merged.open as { text: string }[]).map((x) => x.text),
    ["先复习哪章？", "几点开始？", "要不要做卷子？"],
  );
  assert.deepEqual(await shown(id), [
    ["例子：先做第三章", "ai"],
    ["还没想明白的：和谁一起？", "ai"],
    ["还没想明白的：图书馆开门吗？", "ai"],
  ]);
  // The export marks them as AI, like the other AI words.
  const data = (await s.call("GET", "/v1/me/export")).json();
  const versions = (data.cardVersions as any[]).filter((v) => v.kind === "supplement");
  assert.ok(versions.length >= 6);
  for (const v of versions)
    assert.equal(v.aiGenerated === true, v.by === "ai", String(v.data?.text));
  assert.ok(versions.some((v) => v.data.text === "因为：随时能翻" && !v.aiGenerated));
  // 我的话 only takes the learner's own words as a quote, not the AI's.
  const quote = (text: string) =>
    s.call("POST", `/v1/cards/${b.id}/mine`, { version: s.cards.detail(s.userId, b.id).version, quote: text });
  const theirs = await quote("我认为要用卡片");
  assert.equal(theirs.statusCode, 400, theirs.body);
  assert.match(theirs.body, /自己说过/);
  const own = await quote("随时能翻");
  assert.equal(own.statusCode, 200, own.body);
});

// ---- L4: abandoned imports --------------------------------------------------
test("L4: abandoning an import cancels its queued job before any model call", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let splits = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/"))
      return new Response(
        JSON.stringify({
          answers: {
            q:
              body.questions.q.type === "noul"
                ? { noul: 0 }
                : { choice: "none", confidence: 0.9, probabilities: { none: 0.9 } },
          },
        }),
      );
    splits++;
    await held;
    const cards = { cards: [{ type: "idea", scene: "study", title: "极限", summary: "极限定义", src: [1], tags: [] }] };
    return new Response(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(cards) }, finish_reason: "stop" }] })}`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } })}`,
        "data: [DONE]",
        "",
      ].join("\n"),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  const tools: ImportFileTools = {
    readDocx: async () => "",
    readPdf: async () => ({ totalPages: 1, pages: [] }),
    rasterizePdfPage: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  };
  const store = new SqliteStore(":memory:");
  const app = buildApp({
    store,
    importTools: tools,
    fetcher,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-fx3-")),
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-fx3-formula-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "fake",
      JEV_API_KEY: "fake",
      DAILY_IMPORT_LIMIT: "10",
      JOB_CONCURRENCY: "1",
    }),
  });
  t.after(async () => {
    release();
    await app.close();
  });
  const token = (
    await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "fx3-import" } })
  ).json().data.token;
  const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: payload as string });
  const split = async (clientId: string) => {
    const created = (await call("POST", "/v1/imports", { clientId, text: "一段要拆成卡的文字。" })).json().data.import;
    return (await call("POST", `/v1/imports/${created.id}/cards`, { clientId })).json().data.import;
  };
  const first = await split("fx3-first");
  for (let i = 0; i < 200 && !splits; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(splits, 1, "the first split is running");
  const second = await split("fx3-second");
  assert.equal(second.job.status, "queued");
  const left = await call("POST", `/v1/imports/${second.id}/abandon`);
  assert.equal(left.json().data.import.status, "abandoned");
  const job = (await call("GET", `/v1/jobs/${second.job.id}`)).json().data;
  assert.equal(job.status, "failed");
  assert.equal(job.error.code, "IMPORT_ABANDONED");
  // Its receipt is freed like any failure.
  assert.equal(
    Number(
      store.db
        .prepare(`SELECT COUNT(*) AS n FROM quota_receipts r WHERE source='job' AND source_id=? AND ${NOT_VOID}`)
        .get(second.job.id)!.n,
    ),
    0,
  );
  release();
  for (let i = 0; i < 400; i++) {
    const status = (await call("GET", `/v1/jobs/${first.job.id}`)).json().data.status;
    if (!["queued", "running"].includes(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(splits, 1, "the abandoned import's split never called the model");
});

test("L7: the export carries the 卡点 help as an object with its reply marked as AI", async (t) => {
  const s = await boot();
  t.after(() => s.app.close());
  const at = new Date().toISOString();
  s.store.db
    .prepare("INSERT INTO map_points(user_id,point_id,updated_at) VALUES(?,?,?)")
    .run(s.userId, "limit-order", at);
  const help = {
    text: "这一步看不懂",
    at,
    status: "ready",
    reply: { crisis: false, quote: null, ask: "卡在哪一步？", options: ["第一步", "第二步"], suggest: null },
  };
  s.store.db
    .prepare("UPDATE map_points SET stuck_help=? WHERE user_id=? AND point_id='limit-order'")
    .run(JSON.stringify(help), s.userId);
  const data = (await s.call("GET", "/v1/me/export")).json();
  const point = data.learn.points.find((p: any) => p.pointId === "limit-order");
  assert.equal(point.stuckHelp.text, "这一步看不懂");
  assert.equal(point.stuckHelp.reply.ask, "卡在哪一步？");
  assert.equal(point.stuckHelp.reply.aiGenerated, true);
  assert.equal(typeof point.stuckHelp.reply.aiLabel, "string");
  assert.equal(point.stuckHelp.aiGenerated, undefined, "the learner's words are not AI");
});

test("L8: thread pages do not skip threads updated at the same moment", async (t) => {
  const s = await boot();
  t.after(() => s.app.close());
  const at = "2026-10-18T02:00:00.000Z";
  const ids = ["thr_a", "thr_b", "thr_c", "thr_d"];
  for (const [i, id] of ids.entries())
    s.store.db
      .prepare("INSERT INTO threads(id,user_id,title,data,created_at,updated_at) VALUES(?,?,?,'{}',?,?)")
      .run(id, s.userId, `话题${i}`, at, i === 3 ? "2026-10-18T01:00:00.000Z" : at);
  const page = async (query: string) => {
    const res = await s.call("GET", `/v1/chat/threads?limit=2${query}`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().data as { threads: { id: string }[]; next: string | null };
  };
  const seen: string[] = [];
  let next: string | null = null;
  for (let i = 0; i < 5; i++) {
    const data = await page(next ? `&before=${encodeURIComponent(next)}` : "");
    seen.push(...data.threads.map((x) => x.id));
    next = data.next;
    if (!next) break;
  }
  assert.deepEqual(seen, ["thr_c", "thr_b", "thr_a", "thr_d"]);
  // A plain updatedAt (the G7 cursor) still pages as before.
  const plain = await page(`&before=${encodeURIComponent(at)}`);
  assert.deepEqual(plain.threads.map((x) => x.id), ["thr_d"]);
});

// ---- L11: calls without token usage ----------------------------------------
test("L11: a call without token usage is charged by estimate and counted for the admin", async (t) => {
  const reply = "先看看分子分母。";
  const system = "你是老师";
  const question = "这道极限怎么做？";
  const model = new ChatModel(
    { baseUrl: "https://llm.example/v1", apiKey: "k", model: "glm-5.3", extraBody: {}, timeoutMs: 5000 },
    (async (_url: string | URL | Request, init?: RequestInit) =>
      JSON.parse(String(init?.body)).stream
        ? new Response(
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "想想" } }] })}\n\n` +
              `data: ${JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        : new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }))) as typeof fetch,
  );
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: question },
  ];
  const streamed = await model.stream(messages, { onText: () => {} });
  assert.equal(streamed.usage.estimated, true);
  assert.equal(streamed.usage.promptTokens, estimateTokens(system + question));
  assert.equal(streamed.usage.completionTokens, estimateTokens("想想" + reply));
  assert.ok(usageCost(streamed.usage, DEFAULT_PRICES) > 0);
  const json = await model.json(messages, z.object({ ok: z.boolean() }));
  assert.equal(json.usage.estimated, true);
  assert.equal(json.usage.completionTokens, estimateTokens('{"ok":true}'));
  // Reported usage is kept as it is.
  const counted = new ChatModel(
    { baseUrl: "https://llm.example/v1", apiKey: "k", model: "glm-5.3", extraBody: {}, timeoutMs: 5000 },
    (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
      )) as typeof fetch,
  );
  const exact = await counted.json(messages, z.object({ ok: z.boolean() }));
  assert.equal(exact.usage.estimated, undefined);
  assert.deepEqual([exact.usage.promptTokens, exact.usage.completionTokens], [7, 3]);
  // The admin to-do list counts the day's model calls without usage.
  const s = await boot();
  t.after(() => s.app.close());
  const row = s.store.db.prepare(
    "INSERT INTO usage_ledger(source,provider,model,status,prompt_tokens,completion_tokens,created_at) VALUES(?,?,?,?,?,?,?)",
  );
  const now = s.store.now();
  row.run("llm.stream", "h", "m", "succeeded", null, null, now);
  row.run("llm.json", "h", "m", "succeeded", null, null, now);
  row.run("llm.json", "h", "m", "succeeded", 5, 2, now);
  row.run("llm.json", "h", "m", "failed", null, null, now);
  row.run("jev", "h", "m", "succeeded", null, null, now);
  row.run("llm.json", "h", "m", "succeeded", null, null, "2026-01-01T00:00:00.000Z");
  const todo = (
    await s.app.inject({ method: "GET", url: "/v1/admin/todo", headers: { "x-admin-key": KEY } })
  ).json().data;
  assert.equal(todo.ai.noUsage24h, 2);
});
