// 接口回归：识别完成的整页作业在额度不足时仍保留，用户消息通过 plain 返回原话。
// 同一 clientId 的同类题重试只生成一题；旧批改记录兼容已有步骤，推荐卡片保留 type 与 kind。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";

const PROBLEM = String.raw`求极限 $\lim_{x\to 0}\frac{e^{3x}-1-3x}{x^{2}}$。`;
const RIGHT = [
  String.raw`原式 $=\lim_{x\to 0}\dfrac{e^{3x}-1-3x}{x^2}$`,
  String.raw`$=\lim_{x\to 0}\dfrac{3e^{3x}-3}{2x}$`,
  String.raw`$=\lim_{x\to 0}\dfrac{9e^{3x}}{2}$`,
  String.raw`$=\dfrac{9}{2}$`,
];
const MADE = {
  question: String.raw`求函数 $y=\sin x^{2}$ 的导数。`,
  answer: String.raw`2x\cos x^{2}`,
  options: [
    String.raw`$\cos x^{2}$`,
    String.raw`$2x\cos x^{2}$`,
    String.raw`$-2x\cos x^{2}$`,
    String.raw`$2\cos x^{2}$`,
  ],
  correct: 1,
  steps: ["用链式法则", String.raw`$y'=2x\cos x^{2}$`],
  solution: String.raw`链式法则。

**答案**：$2x\cos x^{2}$`,
  checks: [{ kind: "derivative", expr: "sin(x^2)", answer: "2*x*cos(x^2)" }],
};

type Json = unknown | (() => unknown);
function setup(env: Record<string, string> = {}) {
  const calls: { stream: boolean; system: string }[] = [];
  const json: Record<string, Json[]> = { draft: [], similar: [] };
  const vision: { scan: unknown } = { scan: null };
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      const q = body.questions.q;
      const keys = Object.keys(q.criteria ?? {});
      // Suggested cards: every card counts as related.
      const answer =
        q.type === "noul"
          ? { noul: 0.9 }
          : keys.some((k) => k.startsWith("card-"))
            ? {
                choice: keys[0],
                confidence: 0.9,
                probabilities: Object.fromEntries(keys.map((k) => [k, k.startsWith("card-") ? 0.9 : 0.05])),
              }
            : { choice: "calc", confidence: 0.8, probabilities: { calc: 0.8 } };
      return new Response(JSON.stringify({ answers: { q: answer } }));
    }
    const system = String(body.messages[0].content);
    calls.push({ stream: Boolean(body.stream), system });
    if (body.stream) {
      const enc = new TextEncoder();
      const text = "**结论**：过程正确";
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    const pick = async (queue: Json[], otherwise: unknown) => {
      const item = queue.length ? queue.shift() : otherwise;
      return typeof item === "function" ? await item() : item;
    };
    let content: unknown;
    if (system.includes("数学题图片识别")) content = vision.scan;
    else if (system.includes("[DRAFT_GRADE]")) content = await pick(json.draft!, null);
    else if (system.includes('"同类题"')) content = await pick(json.similar!, MADE);
    else
      content = { complete: true, missing: "", levels: ["a", "b", "c"], finalAnswer: "9/2", expression: "9/2", note: "" };
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    );
  }) as typeof fetch;
  const store = new SqliteStore(":memory:");
  const app = buildApp({
    store,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-")),
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-formula-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "test-llm",
      JEV_API_KEY: "test-jev",
      OCR_VISION_MODEL: "vision-model",
      ...env,
    }),
    fetcher,
  });
  let token = "";
  let n = 0;
  const call = async (method: string, url: string, payload?: unknown) => {
    if (!token)
      token = (await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: {} })).json().data.token;
    return app.inject({
      method: method as "GET",
      url,
      payload: payload as string,
      headers: { authorization: `Bearer ${token}` },
    });
  };
  const send = async (payload: Record<string, unknown>) => {
    const res = await call("POST", "/v1/chat/send", { clientId: `fx5b-${++n}-abcdef`, tone: "light", ...payload });
    return res.body
      .split("\n\n")
      .filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
      .map((f) => JSON.parse(f.slice(6)) as Record<string, any>);
  };
  const used = async () => (await call("GET", "/v1/chat/usage")).json().data.answers.used as number;
  const upload = async (query = "") => {
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
        "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
      "hex",
    );
    const boundary = "----zhiye";
    await call("GET", "/v1/chat/usage");
    return app.inject({
      method: "POST",
      url: `/v1/chat/scan${query}`,
      headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
  };
  const userId = () => (store.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string }).id;
  return { app, calls, json, vision, call, send, used, upload, store, userId };
}
const later = () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  return { gate, open };
};
const tick = () => new Promise((r) => setTimeout(r, 10));

test("F02 整页批改: the scan crosses the budget, then the page is still made, every problem kept to grade later", async () => {
  // The test model is unpriced: one scan (3 + 2 tokens) uses the whole day.
  const t = setup({ DAILY_BUDGET_CNY: "0.0001" });
  try {
    t.vision.scan = {
      type: "homework",
      problems: [],
      solution: null,
      notes: "",
      homework: [
        { no: "1", text: PROBLEM, steps: RIGHT, unclear: "" },
        { no: "2", text: PROBLEM, steps: RIGHT, unclear: "" },
        { no: "3", text: PROBLEM, steps: [], unclear: "" },
      ],
    };
    const scan = await t.upload("?purpose=grade");
    assert.equal(scan.statusCode, 200, scan.body);
    // The allowance is used up now: anything else asked is refused.
    const blocked = await t.call("POST", "/v1/chat/send", { text: "再问一个", clientId: "fx5b-block-1", tone: "light" });
    assert.equal(blocked.statusCode, 429);
    const streams = t.calls.filter((c) => c.stream).length;
    const res = await t.call("POST", "/v1/chat/homework", { imageId: scan.json().data.imageId, tone: "light" });
    assert.equal(res.statusCode, 200, res.body);
    const hw = res.json().data;
    assert.deepEqual(
      hw.homework.items.map((i: any) => [i.status, i.hold]),
      [
        ["unclear", "quota"],
        ["unclear", "quota"],
        ["unclear", null],
      ],
    );
    assert.match(hw.homework.items[0].unclear, /额度用完了/);
    assert.ok(Date.parse(hw.homework.items[0].holdUntil) > Date.now() - 86400000);
    assert.equal(hw.homework.counts.grading, 0);
    // Nothing was graded (no model call), and the page is in 批改's history.
    await tick();
    assert.equal(t.calls.filter((c) => c.stream).length, streams);
    const list = (await t.call("GET", "/v1/chat/threads?kind=solve&tool=grade&limit=20")).json().data.threads;
    assert.deepEqual(list.map((x: any) => x.id), [hw.id]);
    // Asked again (the page was left before the answer came): the same page.
    const again = (await t.call("POST", "/v1/chat/homework", { imageId: scan.json().data.imageId, tone: "light" })).json().data;
    assert.equal(again.id, hw.id);
  } finally {
    await t.app.close();
  }
});

test("F06: user messages carry their words as plain, in the thread and in the stream; replies do not", async () => {
  const t = setup();
  try {
    const thread = (await t.call("POST", "/v1/chat/threads", { text: "导数", tone: "light" })).json().data.thread;
    const words = String.raw`我懂了，$x^2$ 的导数是 **2x**`;
    const events = await t.send({ threadId: thread.id, text: words, mode: "auto" });
    const start = events.find((e) => e.e === "start");
    assert.ok(start, JSON.stringify(events));
    assert.equal(start.question.plain, words);
    assert.ok(Array.isArray(start.question.blocks));
    assert.equal("content" in start.question, false);
    const view = (await t.call("GET", `/v1/chat/threads/${thread.id}?tone=light`)).json().data;
    const mine = view.messages.find((m: any) => m.role === "user");
    const reply = view.messages.find((m: any) => m.role === "assistant");
    assert.equal(mine.plain, words);
    assert.equal("plain" in reply, false);
  } finally {
    await t.app.close();
  }
});

test("F16 同类题: the same clientId asked again waits for the first and gets its problem, charged once", async () => {
  const t = setup();
  try {
    const events = await t.send({ problem: { text: PROBLEM }, mode: "auto" });
    const threadId = events.find((e) => e.e === "start").thread.id;
    const hold = later();
    t.json.similar!.push(async () => {
      await hold.gate;
      return MADE;
    });
    const before = await t.used();
    const url = `/v1/chat/threads/${threadId}/similar`;
    const body = { tone: "light", clientId: "similar-client-01" };
    const first = t.call("POST", url, body);
    await tick();
    // A timeout and a retry while the first is still being made.
    const second = t.call("POST", url, body);
    await tick();
    hold.open();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(a.json().data.id, b.json().data.id);
    // Asked again after it was made (the answer never reached the page).
    const c = await t.call("POST", url, body);
    assert.equal(c.json().data.id, a.json().data.id);
    assert.equal(await t.used(), before + 1);
    const similars = (await t.call("GET", `/v1/chat/threads/${threadId}?tone=light`))
      .json()
      .data.messages.filter((m: any) => m.kind === "similar");
    assert.equal(similars.length, 1);
    // The same clientId on another problem is refused; none (0.6.0) makes a new one.
    const other = (await t.send({ problem: { text: PROBLEM }, mode: "auto" })).find((e) => e.e === "start").thread.id;
    const clash = await t.call("POST", `/v1/chat/threads/${other}/similar`, body);
    assert.equal(clash.statusCode, 409);
    assert.equal(clash.json().code, "CLIENT_ID_USED");
    const mid = await t.used();
    const old = await t.call("POST", url, { tone: "light" });
    assert.equal(old.statusCode, 200, old.body);
    assert.notEqual(old.json().data.id, a.json().data.id);
    assert.equal(await t.used(), mid + 1);
  } finally {
    await t.app.close();
  }
});

test("F17: an old 批改 record with ✓ after the first error reads those steps as carried", async () => {
  const t = setup();
  try {
    t.json.draft!.push({
      steps: [{ status: "ok" }, { status: "wrong", note: "漏乘 3" }, { status: "ok", note: "沿用了前面的错误结果" }, { status: "ok" }],
      first: { step: 2, why: "漏乘了 3", fix: "分子应为 $3e^{3x}-3$" },
      summary: "第二步求导出错",
    });
    const out = (await t.call("POST", "/v1/chat/drafts", { problem: PROBLEM, steps: RIGHT, tone: "light" })).json().data;
    // Stored the way graders before G7 did: ✓ after the first error.
    const row = t.store.db.prepare("SELECT data FROM messages WHERE id=?").get(out.message.id) as { data: string };
    const data = JSON.parse(row.data);
    data.draft.steps = data.draft.steps.map((s: any) => (s.status === "carried" ? { ...s, status: "ok" } : s));
    t.store.db.prepare("UPDATE messages SET data=? WHERE id=?").run(JSON.stringify(data), out.message.id);
    const view = (await t.call("GET", `/v1/chat/threads/${out.thread.id}?tone=light`)).json().data;
    const d = view.messages.find((m: any) => m.kind === "draft").draft;
    assert.deepEqual(d.steps.map((s: any) => s.status), ["ok", "wrong", "carried", "carried"]);
    assert.equal(d.steps[2].note, "沿用了前面的错误结果");
  } finally {
    await t.app.close();
  }
});

test("suggested cards carry type and kind (add-only)", async () => {
  const t = setup();
  try {
    const thread = (await t.call("POST", "/v1/chat/threads", { text: "下周交作业", tone: "light" })).json().data.thread;
    const insert = (id: string, type: string, kind: string | null) =>
      t.store.db
        .prepare(
          "INSERT INTO cards(id,user_id,type,kind,scene,title,title_by,summary,mine,slots,open,origin,crisis,created_at,updated_at) VALUES(?,?,?,?,'study',?,'user','摘要','', '[]','[]','jot',0,?,?)",
        )
        .run(id, t.userId(), type, kind, `卡 ${id}`, new Date().toISOString(), new Date().toISOString());
    insert("card-todo", "idea", "todo");
    insert("card-old", "method", null);
    const res = await t.call("POST", `/v1/chat/threads/${thread.id}/suggest-cards`, { text: "下周交作业" });
    assert.equal(res.statusCode, 200, res.body);
    const cards = res.json().data.cards;
    const byId = Object.fromEntries(cards.map((c: any) => [c.id, c]));
    assert.deepEqual(
      { type: byId["card-todo"].type, kind: byId["card-todo"].kind, title: byId["card-todo"].title },
      { type: "idea", kind: "todo", title: "卡 card-todo" },
    );
    assert.deepEqual([byId["card-old"].type, byId["card-old"].kind], ["method", "method"]);
    assert.ok("titleBy" in byId["card-todo"] && "score" in byId["card-todo"]);
  } finally {
    await t.app.close();
  }
});
