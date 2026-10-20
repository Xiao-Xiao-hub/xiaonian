// the learning tools. One 批改 (scan purpose "grade"), a draft graded
// once per clientId, steps after the first error never ✓, wrong drafts filed,
// a page graded as far as the answers go, a graded problem corrected and graded
// again, each tool's own history, and 讲完了 with the unsent words, reused
// when nothing new was said, over the whole talk (or saying what it left out).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { IDENTITY_RULE } from "../server/src/shared/identity.js";
import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";
import { CARD_MARK, MAP_CARDS } from "../server/src/modules/learn/map-cards.js";
import { TOOL_BUDGET_MS } from "../server/src/modules/chat/service.js";

const PROBLEM = String.raw`求极限 $\lim_{x\to 0}\frac{e^{3x}-1-3x}{x^{2}}$。`;
// Step 2 lost the 3 of (e^{3x})′: the program finds it.
const DRAFT = [
  String.raw`原式 $=\lim_{x\to 0}\dfrac{e^{3x}-1-3x}{x^2}$`,
  String.raw`$=\lim_{x\to 0}\dfrac{e^{3x}-3}{2x}$`,
  String.raw`$=\lim_{x\to 0}\dfrac{9e^{3x}}{2}$`,
  String.raw`$=\dfrac{9}{2}$`,
];
const RIGHT = [
  String.raw`原式 $=\lim_{x\to 0}\dfrac{e^{3x}-1-3x}{x^2}$`,
  String.raw`$=\lim_{x\to 0}\dfrac{3e^{3x}-3}{2x}$`,
  String.raw`$=\lim_{x\to 0}\dfrac{9e^{3x}}{2}$`,
  String.raw`$=\dfrac{9}{2}$`,
];
const POINT = CALC_MAP.chapters
  .flatMap((c) => c.points)
  .find((p) => MAP_CARDS[p.id]?.keys.length)!;
const KEYS = MAP_CARDS[POINT.id]!.keys.map((k) => k.replace(CARD_MARK, "$2"));

type Json = unknown | (() => unknown);
type Reply = string | number | (() => Promise<string>);
function setup() {
  const calls: { stream: boolean; system: string; last: string }[] = [];
  const json: Record<string, Json[]> = { draft: [], review: [] };
  const script: Reply[] = [];
  const vision: { scan: unknown } = {
    scan: { type: "solution", problems: [{ text: PROBLEM, unclear: "" }], solution: { steps: DRAFT, unclear: "" }, notes: "" },
  };
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      const q = body.questions.q;
      return new Response(
        JSON.stringify({
          answers: {
            q: q.type === "noul" ? { noul: 0.9 } : { choice: "calc", confidence: 0.8, probabilities: { calc: 0.8 } },
          },
        }),
      );
    }
    const system = String(body.messages[0].content);
    const lastContent = body.messages.at(-1).content;
    const last = typeof lastContent === "string" ? lastContent : JSON.stringify(lastContent);
    calls.push({ stream: Boolean(body.stream), system, last });
    if (body.stream) {
      const queued = script.shift() ?? "（没有更多回复）";
      const next = typeof queued === "function" ? await queued() : queued;
      if (typeof next === "number") return new Response("down", { status: next });
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const p of next.match(/[\s\S]{1,7}/g) ?? [])
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    let content: unknown;
    const pick = (queue: Json[]) => {
      const item = queue.shift();
      return typeof item === "function" ? item() : item;
    };
    if (system.includes("数学题图片识别")) content = vision.scan;
    else if (system.includes("[DRAFT_GRADE]")) content = await pick(json.draft!);
    else if (system.includes("[TEACH_REVIEW]")) content = await pick(json.review!);
    else
      content = {
        complete: true,
        missing: "",
        levels: ["a", "b", "c"],
        finalAnswer: "9/2",
        expression: "9/2",
        note: "",
      };
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
    const res = await call("POST", "/v1/chat/send", { clientId: `tools-${++n}-abcdef`, tone: "light", ...payload });
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
  return { app, calls, json, script, vision, call, send, used, upload, store };
}

const later = () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  return { gate, open };
};
const tick = () => new Promise((r) => setTimeout(r, 10));
const statuses = (d: { steps: { status: string }[] }) => d.steps.map((s) => s.status);
const draftBody = (extra: Record<string, unknown> = {}) => ({ problem: PROBLEM, steps: DRAFT, tone: "light", ...extra });

test("批改 scan: purpose grade takes one problem's steps and a page; bare problems go to 拍一道题", async () => {
  const t = setup();
  try {
    const one = (await t.upload("?purpose=grade")).json().data;
    assert.equal(one.type, "solution");
    assert.equal(one.suggest, null);
    assert.match(t.calls.at(-1)!.last, /“批改”/);
    t.vision.scan = {
      type: "homework",
      problems: [],
      solution: null,
      notes: "",
      homework: [
        { no: "1", text: PROBLEM, steps: RIGHT, unclear: "" },
        { no: "2", text: PROBLEM, steps: DRAFT, unclear: "" },
      ],
    };
    assert.equal((await t.upload("?purpose=grade")).json().data.suggest, null);
    t.vision.scan = { type: "problems", problems: [{ text: PROBLEM, unclear: "" }], solution: null, notes: "" };
    assert.equal((await t.upload("?purpose=grade")).json().data.suggest, "problem");
    // The 0.6.0 purposes answer as before.
    assert.equal((await t.upload("?purpose=draft")).json().data.suggest, "problem");
  } finally {
    await t.app.close();
  }
});

test("批改: steps after the first error are carried, never ✓; the verdict and first error stay right", async () => {
  const t = setup();
  try {
    // 1. The model says step 2 is wrong and marks 3 and 4 ok (the 0.6.0 rule):
    //    3 and 4 build on (e^{3x})' = e^{3x}, so they are not shown as right.
    t.json.draft!.push({
      steps: [{ status: "ok" }, { status: "wrong", note: "漏乘 3" }, { status: "ok", note: "沿用了前面的错误结果" }, { status: "ok" }],
      first: { step: 2, why: "$(e^{3x})'=3e^{3x}$，漏乘了 3", fix: "分子应为 $3e^{3x}-3$" },
      summary: "第二步求导出错",
    });
    let d = (await t.call("POST", "/v1/chat/drafts", draftBody())).json().data.message.draft;
    assert.deepEqual(statuses(d), ["ok", "wrong", "carried", "carried"]);
    assert.equal(d.verdict, "wrong");
    assert.equal(d.first.step, 2);
    assert.equal(d.steps[2].note, "沿用了前面的错误结果");
    // 2. The model passes every step: the program finds step 2 wrong
    //    (3e^{3x}-3 ≠ e^{3x}-3 at x = 1), and 3, 4 follow from it.
    t.json.draft!.push({ steps: DRAFT.map(() => ({ status: "ok" })), first: null, summary: "" });
    d = (await t.call("POST", "/v1/chat/drafts", draftBody())).json().data.message.draft;
    assert.deepEqual(statuses(d), ["ok", "wrong", "carried", "carried"]);
    assert.equal(d.first.step, 2);
    // 3. The model's own "carried" is kept; a right draft is all ✓ and correct.
    t.json.draft!.push({
      steps: [{ status: "ok" }, { status: "wrong" }, { status: "carried" }, { status: "carried" }],
      first: { step: 2, why: "漏乘 3", fix: "" },
      summary: "",
    });
    d = (await t.call("POST", "/v1/chat/drafts", draftBody())).json().data.message.draft;
    assert.deepEqual(statuses(d), ["ok", "wrong", "carried", "carried"]);
    t.json.draft!.push({ steps: RIGHT.map(() => ({ status: "ok" })), first: null, summary: "" });
    d = (await t.call("POST", "/v1/chat/drafts", draftBody({ steps: RIGHT }))).json().data.message.draft;
    assert.deepEqual(statuses(d), ["ok", "ok", "ok", "ok"]);
    assert.equal(d.verdict, "correct");
    // 4. A step the model could not read stays ?, and nothing wrong means unsure, not correct.
    t.json.draft!.push({
      steps: [{ status: "ok" }, { status: "ok" }, { status: "unclear", note: "指数看不清" }, { status: "ok" }],
      first: null,
      summary: "",
    });
    d = (await t.call("POST", "/v1/chat/drafts", draftBody({ steps: RIGHT }))).json().data.message.draft;
    assert.deepEqual(statuses(d), ["ok", "ok", "unclear", "ok"]);
    assert.equal(d.verdict, "unsure");
    assert.equal(d.first, null);
    // The model is told to mark them carried.
    assert.match(t.calls.find((c) => c.system.includes("[DRAFT_GRADE]"))!.system, /carried/);
  } finally {
    await t.app.close();
  }
});

test("批改: a wrong draft goes into 错题本 by itself; a right one or an unsure one does not", async () => {
  const t = setup();
  try {
    t.json.draft!.push({ steps: DRAFT.map(() => ({ status: "ok" })), first: null, summary: "" });
    const wrong = (await t.call("POST", "/v1/chat/drafts", draftBody())).json().data;
    assert.equal(wrong.thread.mistake?.status, "open");
    const book = (await t.call("GET", "/v1/mistakes")).json().data.items;
    assert.equal(book.length, 1);
    assert.equal(book[0].source, "grade");
    assert.match(book[0].cause, /第 2 步有误/);
    t.json.draft!.push({ steps: RIGHT.map(() => ({ status: "ok" })), first: null, summary: "" });
    const right = (await t.call("POST", "/v1/chat/drafts", draftBody({ steps: RIGHT }))).json().data;
    assert.equal(right.message.draft.verdict, "correct");
    assert.equal(right.thread.mistake, null);
    t.json.draft!.push({ steps: RIGHT.map(() => ({ status: "unclear" })), first: null, summary: "" });
    const unsure = (await t.call("POST", "/v1/chat/drafts", draftBody({ steps: RIGHT }))).json().data;
    assert.equal(unsure.message.draft.verdict, "unsure");
    assert.equal(unsure.thread.mistake, null);
    assert.equal((await t.call("GET", "/v1/mistakes")).json().data.items.length, 1);
  } finally {
    await t.app.close();
  }
});

test("批改: one clientId is graded once — a repeat gets the stored grade, a retry while it runs waits for it", async () => {
  const t = setup();
  try {
    const hold = later();
    t.json.draft!.push(async () => {
      await hold.gate;
      return { steps: DRAFT.map(() => ({ status: "ok" })), first: null, summary: "" };
    });
    const before = await t.used();
    const first = t.call("POST", "/v1/chat/drafts", draftBody({ clientId: "grade-client-0001" }));
    await tick();
    // The page timed out and asked again (or was opened again): no second grading.
    const second = t.call("POST", "/v1/chat/drafts", draftBody({ clientId: "grade-client-0001" }));
    await tick();
    hold.open();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(a.json().data.thread.id, b.json().data.thread.id);
    assert.equal(a.json().data.message.id, b.json().data.message.id);
    assert.equal(t.calls.filter((c) => c.system.includes("[DRAFT_GRADE]")).length, 1);
    assert.equal(await t.used(), before + 1);
    // Asked again later: the stored grade, same shape, nothing new.
    const third = (await t.call("POST", "/v1/chat/drafts", draftBody({ clientId: "grade-client-0001" }))).json().data;
    assert.deepEqual(Object.keys(third).sort(), ["message", "question", "thread"]);
    assert.equal(third.message.id, a.json().data.message.id);
    assert.deepEqual(statuses(third.message.draft), ["ok", "wrong", "carried", "carried"]);
    assert.equal(await t.used(), before + 1);
    // The problem as typed comes with the grade, to correct and grade again.
    assert.equal(third.message.draft.problemText, draftBody({}).problem);
    assert.deepEqual(third.message.draft.steps.map((s: { text: string }) => s.text), draftBody({}).steps);
    const solve = (await t.call("GET", "/v1/chat/threads?tool=grade")).json().data.threads;
    assert.equal(solve.length, 1);
    // Without a clientId (0.6.0) every call grades, as before.
    t.json.draft!.push({ steps: DRAFT.map(() => ({ status: "ok" })), first: null, summary: "" });
    t.json.draft!.push({ steps: DRAFT.map(() => ({ status: "ok" })), first: null, summary: "" });
    const old1 = (await t.call("POST", "/v1/chat/drafts", draftBody())).json().data;
    const old2 = (await t.call("POST", "/v1/chat/drafts", draftBody())).json().data;
    assert.notEqual(old1.thread.id, old2.thread.id);
    assert.deepEqual(Object.keys(old1).sort(), ["message", "question", "thread"]);
    assert.equal(await t.used(), before + 3);
    assert.equal((await t.call("POST", "/v1/chat/drafts", draftBody({ clientId: "bad id" }))).statusCode, 400);
  } finally {
    await t.app.close();
  }
});

test("批改: a grading that fails is not counted, and the same clientId can be tried again", async () => {
  const t = setup();
  try {
    const before = await t.used();
    // Unusable JSON twice, then a plain reply with no conclusion (and steps
    // the program finds nothing wrong in): no grade at all.
    t.json.draft!.push("坏的", "还是坏的");
    t.script.push("嗯……");
    const res = await t.call("POST", "/v1/chat/drafts", draftBody({ steps: RIGHT, clientId: "grade-client-0002" }));
    assert.equal(res.statusCode, 502, res.body);
    assert.equal(res.json().code, "DRAFT_FAILED");
    assert.equal(await t.used(), before);
    assert.equal((await t.call("GET", "/v1/chat/threads?tool=grade")).json().data.threads.length, 0);
    t.json.draft!.push({ steps: RIGHT.map(() => ({ status: "ok" })), first: null, summary: "" });
    const again = await t.call("POST", "/v1/chat/drafts", draftBody({ steps: RIGHT, clientId: "grade-client-0002" }));
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(await t.used(), before + 1);
    // The tools give up before the page does (150 s).
    assert.ok(TOOL_BUDGET_MS < 150_000);
  } finally {
    await t.app.close();
  }
});

test("整页: a graded problem whose reading was wrong is corrected and graded again (again)", async () => {
  const t = setup();
  try {
    t.vision.scan = {
      type: "homework",
      problems: [],
      solution: null,
      notes: "",
      homework: [
        { no: "1", text: PROBLEM, steps: DRAFT, unclear: "" },
        { no: "2", text: PROBLEM, steps: RIGHT, unclear: "" },
      ],
    };
    // Read as 3e^{3x}-3 → e^{3x}-3: graded wrong, though the paper was right.
    t.script.push("**结论**：第 2 步有误，漏乘 3。", "**结论**：过程正确");
    const scan = (await t.upload("?purpose=grade")).json().data;
    const hw = (await t.call("POST", "/v1/chat/homework", { imageId: scan.imageId, tone: "light" })).json().data;
    const settle = async () => {
      let view = (await t.call("GET", `/v1/chat/threads/${hw.id}?tone=light`)).json().data.thread;
      for (let i = 0; i < 100 && view.homework.counts.grading; i++) {
        await tick();
        view = (await t.call("GET", `/v1/chat/threads/${hw.id}?tone=light`)).json().data.thread;
      }
      return view.homework;
    };
    let page = await settle();
    assert.equal(page.items[0].verdict, "wrong");
    const child = page.items[0].threadId;
    const before = await t.used();
    const url = `/v1/chat/threads/${hw.id}/homework/0`;
    // Without again, or with nothing changed, a graded one is refused as before.
    assert.equal((await t.call("POST", url, { steps: RIGHT, tone: "light" })).statusCode, 409);
    assert.equal((await t.call("POST", url, { steps: DRAFT, again: true, tone: "light" })).statusCode, 409);
    t.script.push("**结论**：过程正确");
    const fixed = await t.call("POST", url, { steps: RIGHT, again: true, tone: "light" });
    assert.equal(fixed.statusCode, 200, fixed.body);
    page = await settle();
    assert.equal(page.items[0].verdict, "correct");
    assert.equal(page.items[0].threadId, child, "same problem: same conversation");
    assert.equal(await t.used(), before + 1);
    // A corrected problem text is another problem: a conversation of its own.
    t.script.push("**结论**：过程正确");
    const retyped = await t.call("POST", url, { text: "求极限 $\\lim_{x\\to 0}\\frac{e^{3x}-1-3x}{x^2}$", steps: RIGHT, again: true, tone: "light" });
    assert.equal(retyped.statusCode, 200, retyped.body);
    page = await settle();
    assert.notEqual(page.items[0].threadId, child);
    assert.equal(page.items[0].verdict, "correct");
  } finally {
    await t.app.close();
  }
});

test("整页: while a page is graded, another tool is told which task holds it", async () => {
  const t = setup();
  try {
    t.vision.scan = {
      type: "homework",
      problems: [],
      solution: null,
      notes: "",
      homework: [
        { no: "1", text: PROBLEM, steps: RIGHT, unclear: "" },
        { no: "2", text: PROBLEM, steps: RIGHT, unclear: "" },
      ],
    };
    const hold = later();
    t.script.push(async () => {
      await hold.gate;
      return "**结论**：过程正确";
    }, "**结论**：过程正确");
    const scan = (await t.upload("?purpose=grade")).json().data;
    await t.call("POST", "/v1/chat/homework", { imageId: scan.imageId, tone: "light" });
    await tick();
    const busy = await t.call("POST", "/v1/chat/drafts", draftBody());
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.json().code, "STILL_ANSWERING");
    assert.match(busy.json().message, /作业还在批改/);
    hold.open();
  } finally {
    await t.app.close();
  }
});

test("history: each tool lists its own, unfinished ones are marked, and older ones come page by page", async () => {
  const t = setup();
  try {
    t.json.draft!.push({ steps: RIGHT.map(() => ({ status: "ok" })), first: null, summary: "" });
    const draft = (await t.call("POST", "/v1/chat/drafts", draftBody({ steps: RIGHT }))).json().data.thread;
    const teach = (
      await t.call("POST", "/v1/chat/threads", { mode: "teach", topic: "泰勒公式", text: "泰勒公式", origin: "solve", tone: "light" })
    ).json().data.thread;
    t.script.push("嗯？", "好。");
    await t.send({ threadId: teach.id, text: "泰勒公式是用多项式逼近函数", mode: "auto" });
    const asked = await t.send({ problem: { text: PROBLEM }, mode: "auto", origin: "solve" });
    const askId = asked.find((e) => e.e === "start")!.thread.id;
    const list = async (q: string) =>
      (await t.call("GET", `/v1/chat/threads?kind=solve${q}`)).json().data.threads as { id: string; open: boolean; updatedAt: string }[];
    assert.deepEqual((await list("&tool=grade")).map((x) => x.id), [draft.id]);
    assert.deepEqual((await list("&tool=teach")).map((x) => [x.id, x.open]), [[teach.id, true]]);
    assert.deepEqual((await list("&tool=ask")).map((x) => x.id), [askId]);
    // Without tool, all of them, as before.
    assert.equal((await list("")).length, 3);
    // Reviewed: no longer unfinished.
    t.json.review!.push({ points: [{ text: "多项式逼近", status: "covered", quote: "用多项式逼近函数" }], wrong: [], best: "" });
    await t.call("POST", `/v1/chat/threads/${teach.id}/teach-review`, { tone: "light" });
    assert.deepEqual((await list("&tool=teach")).map((x) => x.open), [false]);
    // The page after an updatedAt.
    const all = await list("");
    const rest = await list(`&before=${encodeURIComponent(all[0]!.updatedAt)}`);
    assert.deepEqual(rest.map((x) => x.id), all.slice(1).map((x) => x.id));
    assert.equal((await t.call("GET", "/v1/chat/threads?tool=other")).statusCode, 400);
  } finally {
    await t.app.close();
  }
});

test("讲完了: the unsent words are kept and reviewed; asked again with nothing new, the same review", async () => {
  const t = setup();
  try {
    const thread = (
      await t.call("POST", "/v1/chat/threads", { mode: "teach", pointId: POINT.id, origin: "solve", tone: "light" })
    ).json().data.thread;
    t.script.push("然后呢？");
    await t.send({ threadId: thread.id, text: "先看清楚条件，再下结论", mode: "auto" });
    t.json.review!.push({ points: [{ text: "x", status: "covered", quote: "先看清楚条件" }], wrong: [], best: "" });
    const before = await t.used();
    const res = await t.call("POST", `/v1/chat/threads/${thread.id}/teach-review`, { tone: "light", text: "最后补一句：要验证端点" });
    assert.equal(res.statusCode, 200, res.body);
    const review = t.calls.filter((c) => c.system.includes("[TEACH_REVIEW]")).at(-1)!;
    assert.match(review.last, /最后补一句：要验证端点/);
    const kept = (await t.call("GET", `/v1/chat/threads/${thread.id}?tone=light`)).json().data.messages;
    assert.ok(kept.some((m: { role: string; kind: string }) => m.role === "user" && m.kind === "text"));
    assert.equal(kept.filter((m: { content?: string; blocks: unknown }) => JSON.stringify(m.blocks).includes("要验证端点")).length, 1);
    assert.equal(await t.used(), before + 1);
    // 接着讲, then 讲完了 with nothing said: the same review, no call, not counted.
    const again = await t.call("POST", `/v1/chat/threads/${thread.id}/teach-review`, { tone: "light" });
    assert.equal(again.json().data.message.id, res.json().data.message.id);
    assert.equal(t.calls.filter((c) => c.system.includes("[TEACH_REVIEW]")).length, 1);
    assert.equal(await t.used(), before + 1);
    // Empty text is ignored like before; a crisis in it gets the safety reply.
    assert.equal((await t.call("POST", `/v1/chat/threads/${thread.id}/teach-review`, { tone: "light", text: "" })).statusCode, 200);
  } finally {
    await t.app.close();
  }
});

test("讲完了: a long talk is reviewed in full up to a length; what was left out is said, not marked missed silently", async () => {
  const t = setup();
  try {
    const thread = (
      await t.call("POST", "/v1/chat/threads", { mode: "teach", pointId: POINT.id, origin: "solve", tone: "light" })
    ).json().data.thread;
    const user = (t.store.db.prepare("SELECT user_id FROM threads WHERE id=?").get(thread.id) as { user_id: string }).user_id;
    const add = t.store.db.prepare(
      "INSERT INTO messages(id,thread_id,user_id,role,kind,content,data,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    );
    // 25 things said: more than the 20 the review used to read.
    for (let i = 0; i < 25; i++)
      add.run(`msg_t${i}`, thread.id, user, "user", "text", `第${i}段：${"讲".repeat(100)}`, "{}", "done", new Date(Date.now() + 1000 + i * 1000).toISOString());
    t.json.review!.push({ points: [{ text: "x", status: "covered", quote: "第0段" }], wrong: [], best: "" });
    let r = (await t.call("POST", `/v1/chat/threads/${thread.id}/teach-review`, { tone: "light" })).json().data.message.review;
    let sent = t.calls.filter((c) => c.system.includes("[TEACH_REVIEW]")).at(-1)!.last;
    assert.match(sent, /第0段/, "the first things said are read too");
    assert.match(sent, /第24段/);
    assert.equal(r.said, null);
    // Far longer: the latest words that fit, and the review says how many.
    for (let i = 25; i < 60; i++)
      add.run(`msg_t${i}`, thread.id, user, "user", "text", `第${i}段：${"讲".repeat(400)}`, "{}", "done", new Date(Date.now() + 100_000 + i * 1000).toISOString());
    t.json.review!.push({ points: [{ text: "x", status: "covered", quote: "第59段" }], wrong: [], best: "" });
    r = (await t.call("POST", `/v1/chat/threads/${thread.id}/teach-review`, { tone: "light" })).json().data.message.review;
    sent = t.calls.filter((c) => c.system.includes("[TEACH_REVIEW]")).at(-1)!.last;
    assert.match(sent, /第59段/);
    assert.doesNotMatch(sent, /第0段/);
    assert.equal(r.said.total, 60);
    assert.ok(r.said.seen > 20 && r.said.seen < 60, JSON.stringify(r.said));
  } finally {
    await t.app.close();
  }
});
