import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEnv } from "../server/src/config/env.js";
import { buildApp } from "../server/src/index.js";
import { cut, parseGuide } from "../server/src/modules/chat/guide.js";
import { GUIDE_VOICE, guideSystem, studyGuide, teachSystem } from "../server/src/modules/chat/guide-prompts.js";
import { CHAT_PROMPT_VERSION } from "../server/src/modules/chat/prompts.js";
import { unfinishedChat } from "../server/src/modules/chat/service.js";
import { readable } from "../server/src/modules/render/markdown.js";
import { BANNED_PHRASES } from "../server/src/modules/safety/banned-phrases.js";
import { SqliteStore } from "../server/src/shared/store.js";

// V4.2 : 聊一聊 — warm voice without echo, the threads list for chips,
// history and replay, one scene judgement, attachments charged on send.

const REPLY = '嗯，先慢慢说。<guide>{"options":["接着说"]}</guide>';

function api(start = new Date("2026-10-18T02:00:00.000Z")) {
  const state = {
    jev: [] as string[],
    inFlight: 0,
    overlap: 0,
    choices: [] as string[],
    noul: 0,
    jevDelay: 0,
    streams: 0,
  };
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      const q = body.questions.q;
      state.jev.push(q.type);
      state.inFlight += 1;
      state.overlap = Math.max(state.overlap, state.inFlight);
      await new Promise((r) => setTimeout(r, state.jevDelay));
      state.inFlight -= 1;
      const choice = state.choices.shift() ?? "life";
      const answer = q.type === "noul" ? { noul: state.noul } : { choice, confidence: 0.9, probabilities: { [choice]: 0.9 } };
      return new Response(JSON.stringify({ answers: { q: answer } }));
    }
    state.streams += 1;
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: REPLY } }] })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  const store = new SqliteStore(":memory:");
  let clock = start;
  const app = buildApp({
    store,
    now: () => new Date(clock),
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-g5-")),
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-g5-formula-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "test-llm",
      JEV_API_KEY: "test-jev",
    }),
    fetcher,
  });
  const login = async (key = "g5-chat") => {
    const res = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key } });
    const { token, user } = res.json().data as { token: string; user: { id: string } };
    return { headers: { authorization: `Bearer ${token}` }, userId: user.id };
  };
  return { app, store, state, login, setNow: (next: Date) => { clock = next; } };
}

function seedCard(store: SqliteStore, id: string, userId: string, scene: string) {
  store.db
    .prepare(
      "INSERT INTO cards(id,user_id,type,scene,title,title_by,summary,mine,slots,open,origin,crisis,created_at,updated_at) VALUES(?,?,'idea',?,?,'user','摘要',NULL,'[]','[]','jot',0,?,?)",
    )
    .run(id, userId, scene, `卡-${id}`, "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z");
  return id;
}

async function sse(app: ReturnType<typeof buildApp>, headers: Record<string, string>, payload: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/v1/chat/send", headers, payload: { mode: "auto", tone: "light", ...payload } });
  return res.body.split("\n\n")
    .filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
    .map((f) => JSON.parse(f.slice(6)) as Record<string, any>);
}

test("prompts are warm, never ask to quote the user, and the version moved on", () => {
  assert.notEqual(CHAT_PROMPT_VERSION, "2026-10-17.chat.15");
  assert.match(CHAT_PROMPT_VERSION, /^2026-10-18\.chat\.\d+$/);
  const all = [
    guideSystem("life", false),
    guideSystem("mood", false),
    guideSystem("life", true),
    guideSystem("mood", false, false, true),
    studyGuide,
    teachSystem(true),
    teachSystem(false),
  ];
  for (const text of all) {
    assert.doesNotMatch(text, /先用「」引用|引用本轮用户原话|"quote"/);
  }
  for (const text of all.slice(0, 4)) {
    assert.match(text, /不复述、不引用用户刚说的话/);
    assert.match(text, /温柔/);
    assert.match(text, /一次最多问一个温和的小问题/);
    // The framework stays in mind only.
    assert.match(text, /不用“事实、感受、选项、顾虑”这类分析的词/);
  }
  assert.match(studyGuide, /不要输出 quote/);
  // The voice itself uses none of the banned words (the list is quoted only
  // as a rule, after it).
  for (const phrase of BANNED_PHRASES) assert.ok(!GUIDE_VOICE.includes(phrase), phrase);
});

test("guide cards carry a G3 kind; titles and options cut by code point", () => {
  const guide = parseGuide('{"options":["😀😀😀😀😀😀😀😀😀😀😀😀😀"],"card":{"kind":"todo","title":"周五前交😀😀😀😀😀😀😀😀😀😀😀😀😀😀"}}', []);
  assert.deepEqual(guide!.card, { type: "idea", kind: "todo", title: "周五前交😀😀😀😀😀😀😀😀😀😀😀😀" });
  assert.equal(Array.from(guide!.options[0]!).length, 12);
  assert.ok(!/[\uD800-\uDBFF]$/.test(guide!.options[0]!));
  assert.deepEqual(parseGuide('{"options":[],"card":{"kind":"knowledge","title":"夹逼定理"}}', [])!.card,
    { type: "method", kind: "knowledge", title: "夹逼定理" });
  // Old shape still read.
  assert.deepEqual(parseGuide('{"options":[],"card":{"type":"question","title":"为什么"}}', [])!.card,
    { type: "question", title: "为什么" });
  assert.equal(cut("𠀀𠀁𠀂", 2), "𠀀𠀁");
});

test("readable keeps a lone * and # in text but drops markdown marks", () => {
  assert.equal(readable("C# 入门 a*b*c 和 #3"), "C# 入门 a*b*c 和 #3");
  assert.equal(readable("## 标题\n**重点** 和 *斜体*"), "标题 重点 和 斜体");
});

test("a chat title is cut by code point", async (t) => {
  const { app, login } = api();
  t.after(() => app.close());
  const { headers } = await login();
  const made = await app.inject({ method: "POST", url: "/v1/chat/threads", headers,
    payload: { text: "😀".repeat(30), tone: "light" } });
  const title = made.json().data.thread.title as string;
  assert.equal(title, `${"😀".repeat(24)}…`);
});

test("unfinished: each branch of the rule", () => {
  const now = Date.parse("2026-10-18T02:00:00.000Z");
  const recent = now - 3 * 24 * 60 * 60_000;
  const base = {
    lastAt: "2026-10-17T02:00:00.000Z",
    recent,
    lastRole: "assistant",
    lastStatus: "done",
    rounds: 1,
    savedCards: 0,
    ended: false,
    crisis: false,
    tool: null,
  };
  assert.equal(unfinishedChat(base), false); // one round, answered
  assert.equal(unfinishedChat({ ...base, lastRole: "user" }), true); // no reply landed
  assert.equal(unfinishedChat({ ...base, lastStatus: "failed" }), true); // the reply failed
  assert.equal(unfinishedChat({ ...base, rounds: 2 }), true); // ≥ 2 rounds, nothing saved
  assert.equal(unfinishedChat({ ...base, rounds: 2, savedCards: 1 }), false); // a card saved
  assert.equal(unfinishedChat({ ...base, rounds: 2, ended: true }), false); // 先聊到这儿
  assert.equal(unfinishedChat({ ...base, lastRole: "user", lastAt: "2026-10-14T01:00:00.000Z" }), false); // > 3 days
  assert.equal(unfinishedChat({ ...base, lastRole: "user", crisis: true }), false); // crisis
  assert.equal(unfinishedChat({ ...base, lastRole: "user", tool: "teach" }), false); // a tool page
  assert.equal(unfinishedChat({ ...base, lastRole: null }), false); // nothing said
});

test("threads list: unfinished, ended and saved cards over the API", async (t) => {
  const { app, store, login, setNow } = api();
  t.after(() => app.close());
  const { headers, userId } = await login();
  const make = async (text: string) =>
    (await app.inject({ method: "POST", url: "/v1/chat/threads", headers, payload: { text, tone: "light" } }))
      .json().data.thread.id as string;
  const insert = store.db.prepare(
    "INSERT INTO messages(id,thread_id,user_id,role,kind,content,data,status,client_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  let n = 0;
  const say = (threadId: string, role: string, at: string, data = "{}") => {
    const content = `这是第${(n += 1)}句话`;
    insert.run(`m${n}`, threadId, userId, role, "text", content, data, "done", null, at);
    return content;
  };
  const asked = await make("等回复的");
  say(asked, "user", "2026-10-18T01:00:00.000Z");
  const talked = await make("聊了两轮");
  say(talked, "user", "2026-10-18T01:00:00.000Z");
  say(talked, "assistant", "2026-10-18T01:00:01.000Z");
  say(talked, "user", "2026-10-18T01:01:00.000Z");
  say(talked, "assistant", "2026-10-18T01:01:01.000Z");
  const saved = await make("存过卡的");
  const mine = say(saved, "user", "2026-10-18T01:00:00.000Z");
  say(saved, "assistant", "2026-10-18T01:00:01.000Z");
  say(saved, "user", "2026-10-18T01:01:00.000Z");
  say(saved, "assistant", "2026-10-18T01:01:01.000Z");
  const card = await app.inject({ method: "POST", url: "/v1/cards", headers,
    payload: { text: mine, origin: "chat", srcId: saved, scene: "life" } });
  assert.equal(card.statusCode, 200, card.body);
  const old = await make("很久以前");
  say(old, "user", "2026-10-10T01:00:00.000Z");
  const scary = await make("危机");
  say(scary, "user", "2026-10-18T01:00:00.000Z", '{"crisis":true}');
  const list = async (query = "kind=chat") =>
    (await app.inject({ method: "GET", url: `/v1/chat/threads?${query}`, headers })).json().data;
  const byId = async () => Object.fromEntries((await list()).threads.map((x: any) => [x.id, x]));
  let rows = await byId();
  assert.equal(rows[asked].unfinished, true);
  assert.equal(rows[talked].unfinished, true);
  assert.equal(rows[talked].savedCards, 0);
  assert.equal(rows[talked].lastAt, "2026-10-18T01:01:01.000Z");
  assert.equal(rows[talked].scene, "study");
  assert.equal(rows[saved].savedCards, 1);
  assert.equal(rows[saved].unfinished, false);
  assert.equal(rows[old].unfinished, false);
  assert.equal(rows[scary].unfinished, false);
  // 先聊到这儿, then something new is said.
  setNow(new Date("2026-10-18T02:05:00.000Z"));
  const ended = await app.inject({ method: "PATCH", url: `/v1/chat/threads/${talked}`, headers,
    payload: { ended: true, tone: "light" } });
  assert.equal(ended.statusCode, 200, ended.body);
  rows = await byId();
  assert.equal(rows[talked].ended, true);
  assert.equal(rows[talked].unfinished, false);
  say(talked, "user", "2026-10-18T02:06:00.000Z");
  rows = await byId();
  assert.equal(rows[talked].ended, false);
  assert.equal(rows[talked].unfinished, true);
  // The default answer has no `next`, as before.
  assert.equal("next" in (await list()), false);
});

test("threads list pages on updatedAt with limit, and finds a card's chat", async (t) => {
  const { app, store, login, setNow } = api();
  t.after(() => app.close());
  const { headers, userId } = await login();
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    setNow(new Date(Date.parse("2026-10-18T02:00:00.000Z") + i * 60_000));
    ids.push((await app.inject({ method: "POST", url: "/v1/chat/threads", headers,
      payload: { text: `第${i}个话题`, tone: "light" } })).json().data.thread.id);
  }
  const page = async (query: string) =>
    (await app.inject({ method: "GET", url: `/v1/chat/threads?kind=chat&${query}`, headers })).json().data;
  const first = await page("limit=2");
  assert.deepEqual(first.threads.map((x: any) => x.id), [ids[4], ids[3]]);
  // next is "updatedAt|id", so equal times are not skipped.
  assert.equal(first.next, `${first.threads[1].updatedAt}|${first.threads[1].id}`);
  const second = await page(`limit=2&before=${encodeURIComponent(first.next)}`);
  assert.deepEqual(second.threads.map((x: any) => x.id), [ids[2], ids[1]]);
  const last = await page(`limit=2&before=${encodeURIComponent(second.next)}`);
  assert.deepEqual(last.threads.map((x: any) => x.id), [ids[0]]);
  assert.equal(last.next, null);
  // Words in the title; % is a plain character.
  const found3 = await page(`q=${encodeURIComponent("第3个")}`);
  assert.deepEqual(found3.threads.map((x: any) => x.id), [ids[3]]);
  assert.equal(found3.next, null);
  assert.deepEqual((await page(`q=${encodeURIComponent("%")}`)).threads, []);
  // A card's chats: the newest one that carries it.
  const card = { id: seedCard(store, "card-g5-page", userId, "study") };
  const made = await app.inject({ method: "POST", url: "/v1/chat/threads", headers,
    payload: { cardIds: [card.id], tone: "light" } });
  assert.equal(made.statusCode, 200, made.body);
  const withCard = made.json().data.thread.id;
  const found = await page(`cardId=${card.id}&limit=1`);
  assert.deepEqual(found.threads.map((x: any) => x.id), [withCard]);
  // An opened chat says whether cards wait to be stored.
  const opened = (await app.inject({ method: "GET", url: `/v1/chat/threads/${withCard}?tone=light`, headers })).json().data;
  assert.equal(opened.thread.wrapReady, false);
});

test("a life card's chat talks as life; a study card's as study", async (t) => {
  const { app, store, login } = api();
  t.after(() => app.close());
  const { headers, userId } = await login();
  const card = async (scene: string) => seedCard(store, `card-g5-${scene}`, userId, scene);
  const open = async (id: string) =>
    (await app.inject({ method: "POST", url: "/v1/chat/threads", headers, payload: { cardIds: [id], tone: "light" } }))
      .json().data.thread.scene;
  assert.equal(await open(await card("life")), "life");
  assert.equal(await open(await card("study")), "study");
});

test("the scene is judged once for the same words, alongside the crisis check", async (t) => {
  const { app, state, login } = api();
  t.after(() => app.close());
  const { headers } = await login();
  state.jevDelay = 30;
  // Made from 随心记 with the words, then sent: one scene judgement, not two.
  state.choices.push("life");
  const made = await app.inject({ method: "POST", url: "/v1/chat/threads", headers,
    payload: { entry: "jot", text: "周末要不要回家一趟", tone: "light" } });
  const id = made.json().data.thread.id;
  assert.deepEqual(state.jev, ["choice"]);
  const events = await sse(app, headers, { threadId: id, text: "周末要不要回家一趟", clientId: "g5-dedupe-1" });
  assert.ok(events.some((e) => e.e === "done"), JSON.stringify(events));
  assert.deepEqual(state.jev, ["choice", "noul"]);
  // A first jot sent directly: the judge and the crisis check run together.
  state.jev = [];
  state.overlap = 0;
  state.choices.push("life");
  const first = await sse(app, headers, { entry: "jot", text: "想换个社团试试", clientId: "g5-dedupe-2" });
  assert.ok(first.some((e) => e.e === "done"), JSON.stringify(first));
  assert.deepEqual(state.jev.slice().sort(), ["choice", "noul"]);
  assert.equal(state.overlap, 2);
});

test("a crisis still stops the answer while the scene judge runs alongside", async (t) => {
  const { app, state, login } = api();
  t.after(() => app.close());
  const { headers } = await login();
  state.jevDelay = 30;
  state.noul = 0.9;
  const events = await sse(app, headers, { entry: "jot", text: "周末的安排让我很乱", clientId: "g5-crisis-1" });
  // The judge says crisis; both checks ran, together.
  assert.deepEqual(state.jev.slice().sort(), ["choice", "noul"]);
  assert.equal(state.overlap, 2);
  assert.ok(events.some((e) => e.e === "crisis"), JSON.stringify(events));
  assert.ok(!events.some((e) => e.e === "delta" || e.e === "done"));
  assert.equal(state.streams, 0);
});
