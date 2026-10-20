import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { sseFrame } from "../server/src/modules/chat/routes.js";
import { REPLIES } from "./fixtures.js";
import { gradeConclusion } from "../server/src/modules/mistakes/service.js";

const PROBLEM = String.raw`求极限 $\lim_{x\to 0}\frac{e^{3x}-1-3x}{x^{2}}$。`;
const verify = (answer: string, revealed = true) =>
  `\n<verify>{"answer":"${answer}","revealed":${revealed},"checks":[{"kind":"limit","expr":"(exp(3*x)-1-3*x)/x^2","at":"0","answer":"${answer}"}]}</verify>`;
const SOLUTION_RIGHT = `用泰勒展开：$e^{3x}=1+3x+\\frac{9x^2}{2}+o(x^2)$。\n\n所以极限是 $\\frac{9}{2}$。\n\n**答案**：$\\frac{9}{2}$${verify("9/2")}`;
const SOLUTION_WRONG = `所以极限是 $1.5$。\n\n**答案**：$1.5$${verify("1.5")}`;
const HINT = `先看看分子分母在 $x\\to0$ 时各趋于什么，这是什么类型的未定式？${verify("9/2", false)}`;
// A fake chat model that streams scripted replies, plus vision, Jev and JSON jobs.
function services(script: string[]) {
  const calls: {
    stream: boolean;
    model: string;
    system: string;
    last: string;
    extra: unknown;
    history: string;
  }[] = [];
  const judge = { noul: 0.9 };
  const pause: { stream?: (signal: AbortSignal) => Promise<void> } = {};
  // What the vision model reads off a photo; a test can put another page here.
  const vision: { scan: unknown } = {
    scan: {
      type: "problems",
      problems: [
        { text: PROBLEM, unclear: "" },
        {
          text: String.raw`（2）计算 $\int x e^{x}\,dx$。`,
          unclear: "指数可能是 x 也可能是 2x",
        },
      ],
      solution: null,
      notes: "",
    },
  };
  // Replies picked by what is asked, for answers streamed side by side.
  const routes: [RegExp, string][] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      const q = body.questions.q;
      return new Response(
        JSON.stringify({
          answers: {
            q:
              q.type === "noul"
                ? { noul: judge.noul }
                : q.criteria?.["application-taylor-limit"]
                  ? { choice: "none", confidence: 1, probabilities: { none: 1 } }
                : q.criteria?.limit
                  ? // The chapter of a mistake.
                    {
                      choice: "limit",
                      confidence: 0.7,
                      probabilities: { limit: 0.7 },
                    }
                  : {
                      choice: "calc",
                      confidence: 0.8,
                      probabilities: { calc: 0.8 },
                    },
          },
        }),
      );
    }
    const system = String(body.messages[0].content);
    const lastContent = body.messages.at(-1).content;
    const last =
      typeof lastContent === "string"
        ? lastContent
        : JSON.stringify(lastContent);
    calls.push({
      stream: Boolean(body.stream),
      model: body.model,
      system,
      last,
      extra: body.reasoning_effort,
      history: JSON.stringify(body.messages),
    });
    if (body.stream) {
      await pause.stream?.(init!.signal as AbortSignal);
      const routed = routes.findIndex(([when]) => when.test(last));
      const text =
        routed >= 0
          ? routes.splice(routed, 1)[0]![1]
          : (script.shift() ?? "（没有更多回复）");
      const pieces = text.match(/[\s\S]{1,7}/g) ?? [];
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          for (const p of pieces)
            controller.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`,
              ),
            );
          controller.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\n`,
            ),
          );
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    let content: unknown;
    if (system.includes("数学题图片识别")) content = vision.scan;
    else if (system.includes("专项练"))
      content = {
        question: String.raw`求函数 $y=x^{2}\sin x$ 的导数。`,
        answer: String.raw`2x\sin x+x^{2}\cos x`,
        options: [
          String.raw`$2x\cos x$`,
          String.raw`$2x\sin x+x^{2}\cos x$`,
          String.raw`$2x\sin x-x^{2}\cos x$`,
          String.raw`$x^{2}\cos x$`,
        ],
        correct: 1,
        steps: ["用乘积求导法则", String.raw`$y'=2x\sin x+x^{2}\cos x$`],
        solution: String.raw`乘积求导。

**答案**：$2x\sin x+x^{2}\cos x$`,
        checks: [
          {
            kind: "derivative",
            expr: "x^2*sin(x)",
            answer: "2*x*sin(x)+x^2*cos(x)",
          },
        ],
      };
    else if (system.includes("同类题"))
      content =
        script.length && script[0]!.startsWith("{")
          ? JSON.parse(script.shift()!)
          : {
              question: String.raw`求极限 $\lim_{x\to 0}\frac{e^{2x}-1-2x}{x^{2}}$。`,
              answer: "2",
              options: ["$2$", "$1$", "$4$", "$-2$"],
              correct: 0,
              steps: ["把 $e^{2x}$ 展开到二阶", "约去 $x^2$ 得 2"],
              solution: "泰勒展开得 2。\n\n**答案**：2",
              checks: [
                {
                  kind: "limit",
                  expr: "(exp(2*x)-1-2*x)/x^2",
                  at: "0",
                  answer: "2",
                },
              ],
            };
    else if (system.includes("写一段反馈")) content = REPLIES.feedback;
    else content = REPLIES.hints;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    );
  }) as typeof fetch;
  return { fetcher, calls, judge, vision, routes, pause };
}
async function setup(
  script: string[],
  env: Record<string, string> = {},
  now?: () => Date,
) {
  const fake = services(script);
  const store = new SqliteStore(":memory:");
  const app = buildApp({
    now,
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
    fetcher: fake.fetcher,
  });
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: {},
  });
  const token = login.json().data.token as string;
  const auth = { authorization: `Bearer ${token}` };
  let n = 0;
  const send = async (payload: Record<string, unknown>) => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/send",
      headers: auth,
      payload: { clientId: `client-${++n}-abcdef`, ...payload },
    });
    const events = res.headers["content-type"]
      ?.toString()
      .startsWith("text/event-stream")
      ? res.body
          .split("\n\n")
          .filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
          .map((f) => JSON.parse(f.slice(6)) as Record<string, any>)
      : [];
    return { res, events };
  };
  return { app, fake, auth, send, store };
}

test("frames are pure ASCII so the phone can decode them byte by byte", () => {
  const frame = sseFrame({ e: "tail", text: "极限是 ½ 😀" });
  assert.match(frame, /^[\x00-\x7f]*$/);
  assert.equal(JSON.parse(frame.slice(6)).text, "极限是 ½ 😀");
});

test("crisis send saves only the flagged question, retries once and excludes it from future context", async () => {
  const { app, send, fake, store, auth } = await setup(["先把任务分成两步。"]);
  try {
    const payload = { problem: { text: "我不想活了" }, clientId: "crisis-client-001" };
    const first = await send(payload);
    assert.deepEqual(first.events.map((e) => e.e), ["crisis"]);
    assert.equal(first.events[0]!.question.crisis, 1);
    assert.equal(fake.calls.length, 0);
    for (const table of ["materials", "jobs", "quota_receipts"])
      assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0, table);
    const repeat = await send(payload);
    assert.equal(repeat.events[0]!.question.id, first.events[0]!.question.id);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages").get()!.n, 1);
    const logs = store.db.prepare("SELECT data FROM events WHERE name='crisis_shown'").all();
    assert.deepEqual(logs.map((r) => JSON.parse(String(r.data))), [{}]);
    const threadId = first.events[0]!.thread.id;
    const next = await send({ threadId, text: "怎么安排今天的作业？" });
    assert.ok(next.events.some((e) => e.e === "done"));
    assert.doesNotMatch(fake.calls.find((c) => c.stream)!.history, /不想活/);
    const saved = await app.inject({ url: `/v1/chat/threads/${threadId}`, headers: auth });
    assert.equal(saved.json().data.messages[0].crisis, 1);
  } finally { await app.close(); }
});

test("crisis screening checks quotes, steps and pending problems before creating jobs", async () => {
  const { app, send, fake, store } = await setup([]);
  try {
    for (const payload of [
      { text: "解释这句话", quote: "想死" },
      { steps: ["割腕"], mode: "grade" },
      { problem: { text: "数学作业", pending: ["轻生"] } },
    ]) assert.deepEqual((await send(payload)).events.map((e) => e.e), ["crisis"]);
    assert.equal(fake.calls.length, 0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM jobs").get()!.n, 0);
  } finally { await app.close(); }
});

test("existing life scene uses crisis judge while study checks keywords only", async () => {
  const { app, send, fake, store } = await setup(["先列出一件小事。"]);
  try {
    const first = await send({ text: "细胞死亡是什么意思？" });
    assert.ok(first.events.some((e) => e.e === "done"));
    const threadId = first.events[0]!.thread.id;
    store.db.prepare("UPDATE threads SET scene='life' WHERE id=?").run(threadId);
    const count = fake.calls.length;
    const risk = await send({ threadId, text: "我准备彻底离开这个世界了" });
    assert.deepEqual(risk.events.map((e) => e.e), ["crisis"]);
    assert.equal(fake.calls.length, count, "no generation after risk judge");
  } finally { await app.close(); }
});

test("a crisis message cancels an active reply without charging or continuing guidance", async () => {
  const { app, send, fake, store } = await setup(["已中断，不应出现", "可以继续安排任务。"]);
  try {
    let started!: () => void;
    const ready = new Promise<void>((r) => { started = r; });
    fake.pause.stream = (signal) => new Promise<void>((_, reject) => {
      started();
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const first = send({ text: "任务怎么安排？" });
    await ready;
    const threadId = String(store.db.prepare("SELECT id FROM threads").get()!.id);
    const crisis = await send({ threadId, text: "不想活" });
    assert.equal(crisis.events[0]!.e, "crisis");
    const stopped = await first;
    assert.ok(!stopped.events.some((e) => ["blocks", "tail", "done"].includes(e.e)));
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM quota_receipts").get()!.n, 0);
    fake.pause.stream = undefined;
    const next = await send({ threadId, text: "现在先做哪项作业？" });
    assert.ok(next.events.some((e) => e.e === "done"));
  } finally { await app.close(); }
});

test("deleting mood content cancels its current stream and does not recreate the conversation", async () => {
  const { app, send, fake, store, auth } = await setup(["先整理一件事。", "不应保存的晚到回复"]);
  try {
    const first = await send({ text: "怎么安排今天的任务？" });
    const threadId = first.events[0]!.thread.id;
    store.db.prepare("UPDATE threads SET scene='mood' WHERE id=?").run(threadId);
    fake.judge.noul = 0;
    let started!: () => void;
    const ready = new Promise<void>((r) => { started = r; });
    fake.pause.stream = (signal) => new Promise<void>((_, reject) => {
      started();
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const pending = send({ threadId, text: "还有一件事没想清。" });
    await ready;
    const deleted = await app.inject({ method: "DELETE", url: "/v1/mood", headers: auth });
    assert.equal(deleted.statusCode, 200, deleted.body);
    const late = await pending;
    assert.ok(!late.events.some((e) => ["blocks", "tail", "done"].includes(e.e)));
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM threads").get()!.n, 0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages").get()!.n, 0);
    assert.equal((await app.inject({ url: "/v1/mood", headers: auth })).json().data.threads.length, 0);
  } finally { await app.close(); }
});

test("a full solution streams, is saved without the check block, and is verified", async () => {
  const { app, send, auth, fake } = await setup([SOLUTION_RIGHT]);
  const { res, events } = await send({ text: PROBLEM, mode: "solution" });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /^[\x00-\x7f]*$/);
  const kinds = events.map((e) => e.e);
  assert.equal(kinds[0], "start");
  assert.ok(kinds.includes("blocks"), kinds.join());
  assert.ok(kinds.includes("done"));
  const done = events.find((e) => e.e === "done")!;
  const text = JSON.stringify(done.message.blocks);
  assert.doesNotMatch(text, /verify|checks/);
  const verified = events.find((e) => e.e === "verify")!;
  assert.equal(verified.verify.state, "pass");
  assert.match(verified.verify.items[0].tex, /lim/);
  // No tail ever showed the hidden block.
  for (const e of events.filter((x) => x.e === "tail"))
    assert.doesNotMatch(e.text, /<v/);
  const threadId = events[0]!.thread.id;
  const thread = await app.inject({
    method: "GET",
    url: `/v1/chat/threads/${threadId}`,
    headers: auth,
  });
  const messages = thread.json().data.messages;
  assert.deepEqual(
    messages.map((m: any) => m.role),
    ["user", "assistant"],
  );
  assert.equal(messages[1].verify.state, "pass");
  const usage = await app.inject({
    method: "GET",
    url: "/v1/chat/usage",
    headers: auth,
  });
  assert.equal(usage.json().data.answers.used, 1);
  assert.equal(fake.calls.filter((c) => c.stream).length, 1);
  await app.close();
});

test("a wrong result is rechecked once, free, with reasoning on", async () => {
  const { app, send, auth, fake } = await setup([
    SOLUTION_WRONG,
    SOLUTION_RIGHT,
  ]);
  const { events } = await send({ text: PROBLEM, mode: "solution" });
  const verifies = events.filter((e) => e.e === "verify");
  assert.equal(verifies[0]!.verify.state, "conflict");
  assert.ok(events.some((e) => e.e === "recheck"));
  const last = verifies.at(-1)!;
  assert.equal(last.verify.state, "pass");
  const streamed = fake.calls.filter((c) => c.stream);
  assert.equal(streamed.length, 2);
  assert.equal(streamed[1]!.extra, "high");
  assert.match(streamed[1]!.last, /程序独立计算/);
  const usage = await app.inject({
    method: "GET",
    url: "/v1/chat/usage",
    headers: auth,
  });
  assert.equal(usage.json().data.answers.used, 1, "the recheck is not charged");
  await app.close();
});

test("an answer that says other than its own checks is not shown as checked", async () => {
  // The checks are right (9/2); the answer written in the reply is not.
  const SAYS_WRONG = `所以极限是 $1.5$。\n\n**答案**：$1.5$\n<verify>{"answer":"1.5","revealed":true,"checks":[{"kind":"limit","expr":"(exp(3*x)-1-3*x)/x^2","at":"0","answer":"9/2"}]}</verify>`;
  const { app, send } = await setup([SAYS_WRONG, SOLUTION_RIGHT]);
  const { events } = await send({ text: PROBLEM, mode: "solution" });
  const verifies = events.filter((e) => e.e === "verify");
  assert.equal(verifies[0]!.verify.state, "conflict");
  assert.match(verifies[0]!.verify.items[0].detail, /1\.5/);
  assert.ok(events.some((e) => e.e === "recheck"));
  assert.equal(verifies.at(-1)!.verify.state, "pass");
  await app.close();
});

test("still wrong after the recheck is shown as unconfirmed", async () => {
  const { app, send } = await setup([SOLUTION_WRONG, SOLUTION_WRONG]);
  const { events } = await send({ text: PROBLEM, mode: "solution" });
  assert.equal(
    events.filter((e) => e.e === "verify").at(-1)!.verify.state,
    "unsure",
  );
  await app.close();
});

test("a checked expression that does not match the problem is not counted", async () => {
  // A later step of the working, not the problem: its limit is 9/2 all the same.
  const STEP = `所以极限是 $\\frac{9}{2}$。\n\n**答案**：$\\frac{9}{2}$\n<verify>{"answer":"9/2","revealed":true,"checks":[{"kind":"limit","expr":"(3*exp(3*x)-3)/(2*x)","at":"0","answer":"9/2"}]}</verify>`;
  const { app, send, fake } = await setup([STEP, SOLUTION_RIGHT]);
  fake.judge.noul = 0.1;
  const { events } = await send({ text: PROBLEM, mode: "solution" });
  const v = events.find((e) => e.e === "verify")!.verify;
  assert.equal(v.state, "unverified");
  assert.match(v.items[0].detail, /对不上/);
  // The problem's own expression counts without asking Jev.
  const own = await send({ text: PROBLEM, mode: "solution" });
  assert.equal(own.events.find((e) => e.e === "verify")!.verify.state, "pass");
  await app.close();
});

test("hints keep the worked-out answer hidden", async () => {
  const { app, send, auth } = await setup([HINT]);
  const { events } = await send({ problem: { text: PROBLEM }, mode: "auto" });
  assert.ok(!events.some((e) => e.e === "verify"));
  const threadId = events[0]!.thread.id;
  const thread = (
    await app.inject({
      method: "GET",
      url: `/v1/chat/threads/${threadId}`,
      headers: auth,
    })
  ).json().data;
  assert.equal(thread.messages[1].verify, null);
  assert.doesNotMatch(JSON.stringify(thread), /9\/2|hidden/);
  assert.ok(thread.thread.materialId, "the problem got a library record");
  assert.ok(thread.thread.problem.length > 0);
  await app.close();
});

test("the program's own result goes to the model first; a hint built on a wrong one is redone as a hint", async () => {
  // The hint says the first-order terms cancel and its hidden answer is 3/2.
  const HINT_WRONG = `把 $e^{3x}$ 展开后一次项会消掉，剩下的就好算了。${verify("3/2", false)}`;
  const { app, send, fake, auth } = await setup([
    HINT_WRONG,
    HINT,
    "先把 $e^x$ 展开，看看分子剩下几次项。",
  ]);
  const { events } = await send({ problem: { text: PROBLEM }, mode: "auto" });
  const streamed = fake.calls.filter((c) => c.stream);
  assert.match(streamed[0]!.system, /程序已经独立算出题目里的[\s\S]*：4\.5/);
  assert.match(streamed[0]!.system, /正文里不要写出这个结果/);
  assert.ok(events.some((e) => e.e === "recheck"));
  assert.ok(!events.some((e) => e.e === "verify"), "a hint shows no checks");
  assert.equal(streamed.length, 2);
  assert.equal(streamed[1]!.extra, "low", "v2 hints use low reasoning");
  assert.match(streamed[1]!.last, /给学生下一步提示[\s\S]*正文没有说错[\s\S]*不要说“更正”/);
  const threadId = events[0]!.thread.id;
  const thread = (
    await app.inject({ method: "GET", url: `/v1/chat/threads/${threadId}`, headers: auth })
  ).json().data;
  const again = thread.messages.find((m: { kind: string }) => m.kind === "recheck");
  assert.equal(again.mode, "auto");
  assert.equal(again.verify, null);
  // Timestamps left out: "…:14.5…Z" would match 4.5.
  assert.doesNotMatch(
    JSON.stringify(thread, (k, v) => (k === "createdAt" ? undefined : v)),
    /9\/2|4\.5|hidden/,
  );
  const usage = await app.inject({ method: "GET", url: "/v1/chat/usage", headers: auth });
  assert.equal(usage.json().data.answers.used, 1, "the redone hint is not charged");
  // A typed problem the program can work out is a problem even when the hint
  // leaves out its checks.
  const bare = await send({ text: "求极限 lim(x→0) (e^x − 1 − 5x)/x²", mode: "auto" });
  assert.ok(bare.events.some((e) => e.e === "thread" && e.thread.problem));
  // A concept question has nothing for the program to work out.
  await send({ text: "什么是一致连续？", mode: "auto" });
  assert.doesNotMatch(fake.calls.filter((c) => c.stream).at(-1)!.system, /程序已经独立算出/);
  await app.close();
});

test("a typed problem the model hints at becomes the thread's problem; a concept question does not", async () => {
  const CONCEPT = `洛必达法则要求分子分母同时趋于 0 或无穷，例如 $\\lim_{x\\to0}\\frac{\\sin x}{x}=1$。${verify("1")}`;
  const { app, send, auth } = await setup([HINT, CONCEPT, HINT]);
  const typed = await send({ text: PROBLEM, mode: "auto" });
  const attached = typed.events.find((e) => e.e === "thread");
  assert.ok(attached, JSON.stringify(typed.events.map((e) => e.e)));
  assert.ok(attached.thread.materialId);
  assert.ok(attached.thread.problem.length > 0);
  // An explanation that shows its own worked example stays a plain question.
  const concept = await send({ text: "洛必达法则什么时候能用？", mode: "auto" });
  assert.ok(!concept.events.some((e) => e.e === "thread"));
  const threadId = concept.events[0]!.thread.id;
  // A later message in that thread is a follow-up, not a new problem.
  const later = await send({ threadId, text: PROBLEM, mode: "auto" });
  assert.ok(!later.events.some((e) => e.e === "thread"));
  const thread = (
    await app.inject({ method: "GET", url: `/v1/chat/threads/${threadId}`, headers: auth })
  ).json().data.thread;
  assert.equal(thread.materialId, null);
  await app.close();
});

test("the same message sent twice is answered and charged once", async () => {
  const { app, auth, fake } = await setup([SOLUTION_RIGHT, SOLUTION_RIGHT]);
  const payload = {
    text: PROBLEM,
    mode: "solution",
    clientId: "same-client-1",
  };
  const first = await app.inject({
    method: "POST",
    url: "/v1/chat/send",
    headers: auth,
    payload,
  });
  const second = await app.inject({
    method: "POST",
    url: "/v1/chat/send",
    headers: auth,
    payload,
  });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.match(second.body, /"e":"done"/);
  assert.equal(fake.calls.filter((c) => c.stream).length, 1);
  const usage = await app.inject({
    method: "GET",
    url: "/v1/chat/usage",
    headers: auth,
  });
  assert.equal(usage.json().data.answers.used, 1);
  await app.close();
});

test("a failed answer is not charged and the daily limit answers as JSON", async () => {
  // the budget, crossed by one streamed answer (≈ ¥0.004).
  const { app, send, auth } = await setup([], { DAILY_BUDGET_CNY: "0.001" });
  // An empty script makes the fake model reply with a placeholder; force a failure instead.
  const brokenStore = new SqliteStore(":memory:");
  const broken = buildApp({
    store: brokenStore,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-")),
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-formula-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "test-llm",
    }),
    fetcher: (async () =>
      new Response("busy", { status: 429 })) as typeof fetch,
  });
  const token = (
    await broken.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: {},
    })
  ).json().data.token;
  const failed = await broken.inject({
    method: "POST",
    url: "/v1/chat/send",
    headers: { authorization: `Bearer ${token}` },
    payload: { text: "什么是极限？", clientId: "fail-client-1" },
  });
  assert.match(
    failed.body,
    /"e":"error","id":"msg_[0-9a-f]+","code":"AI_BUSY"/,
  );
  const used = await broken.inject({
    method: "GET",
    url: "/v1/chat/usage",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(used.json().data.answers.used, 0);
  assert.equal(used.json().data.budget.day.pct, 0, "a failure spends nothing");
  assert.equal(brokenStore.db.prepare("SELECT COUNT(*) n FROM quota_spend").get()!.n, 0);
  // Failures are counted, so their rate can be watched.
  const failures = brokenStore.db
    .prepare("SELECT data FROM events WHERE name='chat_failed'")
    .all() as { data: string }[];
  assert.deepEqual(
    failures.map((f) => JSON.parse(f.data)),
    [{ mode: "auto", code: "AI_BUSY" }],
  );
  await broken.close();
  await send({ text: "什么是极限？" });
  const over = await send({ text: "什么是连续？" });
  assert.equal(over.res.statusCode, 429);
  assert.equal(over.res.json().code, "DAILY_LIMIT");
  // Errors before the first event are JSON, still pure ASCII for the phone's decoder.
  assert.match(over.res.body, /^[\x00-\x7f]*$/);
  assert.equal(over.res.json().message, "今天的额度用完了，明天 0 点恢复");
  void auth;
  await app.close();
});

// A one-pixel PNG sent the way wx.uploadFile sends it.
async function upload(app: Awaited<ReturnType<typeof setup>>["app"], auth: Record<string, string>) {
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
      "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
    "hex",
  );
  const boundary = "----zhiye";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: "POST",
    url: "/v1/chat/scan",
    headers: {
      ...auth,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
}

test("a photo with two problems lets the learner pick one", async () => {
  const { app, auth, send } = await setup([HINT]);
  const scan = await upload(app, auth);
  assert.equal(scan.statusCode, 200, scan.body);
  const data = scan.json().data;
  assert.equal(data.type, "problems");
  assert.equal(data.problems.length, 2);
  assert.match(data.problems[1].unclear, /指数/);
  assert.ok(data.problems[0].blocks.length);
  // The worksheet's "（2）" is dropped: the problem stands on its own.
  assert.match(data.problems[1].text, /^计算 \$/);
  const usage = await app.inject({
    method: "GET",
    url: "/v1/chat/usage",
    headers: auth,
  });
  assert.equal(usage.json().data.photos.used, 1);
  const { events } = await send({
    problem: { text: data.problems[0].text, pending: [data.problems[1].text] },
    imageId: data.imageId,
    mode: "auto",
  });
  assert.deepEqual(events[0]!.thread.pending, [data.problems[1].text]);
  // The chips under the reply show it as plain text.
  assert.deepEqual(events[0]!.thread.pendingText, ["计算 ∫ x eˣ dx。"]);
  // The problem is kept for judging and review, but listed as the conversation only.
  assert.ok(events[0]!.thread.materialId);
  const listed = await app.inject({ method: "GET", url: "/v1/materials", headers: auth });
  assert.deepEqual(listed.json().data, []);
  assert.deepEqual(events[0]!.question.images, [data.imageId]);
  const image = await app.inject({
    method: "GET",
    url: `/v1/chat/images/${data.imageId}`,
    headers: auth,
  });
  assert.equal(image.statusCode, 200);
  const other = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: { key: "other" },
  });
  const theirs = await app.inject({
    method: "GET",
    url: `/v1/chat/images/${data.imageId}`,
    headers: { authorization: `Bearer ${other.json().data.token}` },
  });
  assert.equal(theirs.statusCode, 404);
  // Deleting the conversation deletes its photo too.
  await app.inject({
    method: "DELETE",
    url: `/v1/chat/threads/${events[0]!.thread.id}`,
    headers: auth,
  });
  const gone = await app.inject({
    method: "GET",
    url: `/v1/chat/images/${data.imageId}`,
    headers: auth,
  });
  assert.equal(gone.statusCode, 404);
  await app.close();
});

test("answering in the chat goes through the judge and lands in the thread", async () => {
  const { app, auth, send } = await setup([HINT]);
  const { events } = await send({ problem: { text: PROBLEM }, mode: "auto" });
  const threadId = events[0]!.thread.id;
  const answered = await app.inject({
    method: "POST",
    url: `/v1/chat/threads/${threadId}/answer`,
    headers: auth,
    payload: { answer: "1.5", clientId: "answer-client-1" },
  });
  assert.equal(answered.statusCode, 200, answered.body);
  const out = answered.json().data;
  assert.equal(out.question.kind, "answer");
  assert.equal(out.judge.kind, "judge");
  assert.ok(out.judge.attempt);
  for (let i = 0; i < 200; i++) {
    const job = (
      await app.inject({
        method: "GET",
        url: `/v1/jobs/${out.judge.job.id}`,
        headers: auth,
      })
    ).json().data;
    if (!["queued", "running"].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  const judged = (
    await app.inject({
      method: "GET",
      url: `/v1/chat/messages/${out.judge.id}`,
      headers: auth,
    })
  ).json().data;
  const result = judged.attempt.result;
  assert.ok(result, JSON.stringify(judged.attempt));
  // The comment comes typeset, so formulas in it show as images.
  assert.ok(judged.blocks.length > 0);
  assert.ok(
    JSON.stringify(judged.blocks).includes(result.comment.slice(0, 4)),
    JSON.stringify(judged.blocks),
  );
  await app.close();
});

test("only similar problems whose answer the program confirmed are handed out", async () => {
  const wrong = JSON.stringify({
    question: "求极限 $\\lim_{x\\to 0}\\frac{e^{2x}-1-2x}{x^{2}}$。",
    answer: "1",
    options: ["$1$", "$2$", "$3$", "$4$"],
    correct: 0,
    steps: ["展开", "得 1"],
    solution: "**答案**：1",
    checks: [
      { kind: "limit", expr: "(exp(2*x)-1-2*x)/x^2", at: "0", answer: "1" },
    ],
  });
  // The program confirms the checks, but the answer shown says otherwise.
  const disagrees = JSON.stringify({
    question: "求极限 $\\lim_{x\\to 0}\\frac{e^{2x}-1-2x}{x^{2}}$。",
    answer: "$1$",
    options: ["$1$", "$2$", "$3$", "$4$"],
    correct: 0,
    steps: ["展开", "得 1"],
    solution: "**答案**：1",
    checks: [
      { kind: "limit", expr: "(exp(2*x)-1-2*x)/x^2", at: "0", answer: "2" },
    ],
  });
  const { app, auth, send, store } = await setup([HINT, wrong, disagrees]);
  const { events } = await send({ problem: { text: PROBLEM }, mode: "auto" });
  const threadId = events[0]!.thread.id;
  const refused = await app.inject({
    method: "POST",
    url: `/v1/chat/threads/${threadId}/similar`,
    headers: auth,
    payload: {},
  });
  assert.equal(refused.statusCode, 503);
  assert.equal(refused.json().code, "SIMILAR_UNRELIABLE");
  assert.deepEqual(
    (
      store.db
        .prepare(
          "SELECT json_extract(data,'$.state') AS state FROM events WHERE name='similar_rejected' ORDER BY rowid",
        )
        .all() as { state: string }[]
    ).map((r) => r.state),
    ["conflict", "mismatch"],
  );
  const before = (
    await app.inject({ method: "GET", url: "/v1/chat/usage", headers: auth })
  ).json().data.answers.used;
  const made = await app.inject({
    method: "POST",
    url: `/v1/chat/threads/${threadId}/similar`,
    headers: auth,
    payload: {},
  });
  assert.equal(made.statusCode, 200, made.body);
  const similar = made.json().data;
  assert.equal(similar.similar.verify.state, "pass");
  assert.equal(
    similar.similar.answer,
    null,
    "the answer stays hidden until asked",
  );
  const shown = await app.inject({
    method: "POST",
    url: `/v1/chat/messages/${similar.id}/reveal`,
    headers: auth,
    payload: {},
  });
  assert.ok(shown.json().data.similar.answer.length);
  const after = (
    await app.inject({ method: "GET", url: "/v1/chat/usage", headers: auth })
  ).json().data.answers.used;
  assert.equal(after, before + 1);
  await app.close();
});

test("an integral right but for its constant is told so", async () => {
  const integral = JSON.stringify({
    question: "求不定积分 $\\int x e^{x}\\,dx$。",
    answer: "$(x-1)e^{x}+C$",
    options: ["$(x+1)e^{x}+C$", "$(x-2)e^{x}+C$", "$(x-1)e^{x}+C$", "$xe^{x}+C$"],
    correct: 2,
    steps: ["设 $u=x$，$dv=e^x dx$", "得 $(x-1)e^{x}+C$"],
    solution: "分部积分。\n\n**答案**：$(x-1)e^{x}+C$",
    checks: [{ kind: "antiderivative", expr: "x*exp(x)", answer: "(x-1)*exp(x)" }],
  });
  const { app, auth, send } = await setup([HINT, integral]);
  const { events } = await send({ problem: { text: PROBLEM }, mode: "auto" });
  const made = (
    await app.inject({
      method: "POST",
      url: `/v1/chat/threads/${events[0]!.thread.id}/similar`,
      headers: auth,
      payload: {},
    })
  ).json().data;
  const answer = (value: string, clientId: string) =>
    app.inject({
      method: "POST",
      url: `/v1/chat/messages/${made.id}/answer`,
      headers: auth,
      payload: { answer: value, clientId },
    });
  const noC = (await answer("(x-1)e^x", "no-constant-1")).json().data.judge;
  assert.equal(noC.attempt.result.verdict, "incorrect");
  assert.match(JSON.stringify(noC.blocks), /只差积分常数/);
  const right = (await answer("(x-1)e^x+C", "with-constant-1")).json().data.judge;
  assert.equal(right.attempt.result.verdict, "correct");
  await app.close();
});

test("a result right but for its sign is told so", async () => {
  const { app, auth, send } = await setup([HINT]);
  const { events } = await send({ problem: { text: PROBLEM }, mode: "auto" });
  const made = (
    await app.inject({
      method: "POST",
      url: `/v1/chat/threads/${events[0]!.thread.id}/similar`,
      headers: auth,
      payload: {},
    })
  ).json().data;
  const judge = (
    await app.inject({
      method: "POST",
      url: `/v1/chat/messages/${made.id}/answer`,
      headers: auth,
      payload: { answer: "-2", clientId: "sign-client-1" },
    })
  ).json().data.judge;
  assert.equal(judge.attempt.result.verdict, "incorrect");
  assert.match(JSON.stringify(judge.blocks), /符号反了/);
  await app.close();
});

test("threads are private, listed newest first and can be deleted", async () => {
  const { app, auth, send } = await setup([SOLUTION_RIGHT, SOLUTION_RIGHT]);
  const a = await send({ text: "第一个问题", mode: "solution" });
  const b = await send({ text: "第二个问题", mode: "solution" });
  const list = (
    await app.inject({ method: "GET", url: "/v1/chat/threads", headers: auth })
  ).json().data;
  assert.deepEqual(
    list.threads.map((t: any) => t.title),
    ["第二个问题", "第一个问题"],
  );
  const other = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: { key: "other" },
  });
  const peek = await app.inject({
    method: "GET",
    url: `/v1/chat/threads/${a.events[0]!.thread.id}`,
    headers: { authorization: `Bearer ${other.json().data.token}` },
  });
  assert.equal(peek.statusCode, 404);
  const removed = await app.inject({
    method: "DELETE",
    url: `/v1/chat/threads/${b.events[0]!.thread.id}`,
    headers: auth,
  });
  assert.equal(removed.statusCode, 200);
  const after = (
    await app.inject({ method: "GET", url: "/v1/chat/threads", headers: auth })
  ).json().data;
  assert.equal(after.threads.length, 1);
  const exported = (
    await app.inject({ method: "GET", url: "/v1/me/export", headers: auth })
  ).json();
  assert.equal(exported.conversations.length, 1);
  assert.equal(exported.conversations[0].messages[0].content, "第一个问题");
  await app.close();
});

test("wrong answers and graded errors go to the 错题本; a right answer the next day masters them", async () => {
  const GRADED = `第 1 步对。第 2 步把 $-$ 写成了 $+$。\n\n**结论**：第 2 步有误，分部积分那一项的符号写反了。`;
  const clock = { at: new Date() };
  const { app, auth, send } = await setup([HINT, GRADED], {}, () => clock.at);
  const get = async (url: string) =>
    (await app.inject({ method: "GET", url, headers: auth })).json().data;
  const { events } = await send({ problem: { text: PROBLEM }, mode: "auto" });
  const threadId = events[0]!.thread.id;
  const answer = async (value: string, clientId: string) => {
    const out = (
      await app.inject({
        method: "POST",
        url: `/v1/chat/threads/${threadId}/answer`,
        headers: auth,
        payload: { answer: value, clientId },
      })
    ).json().data;
    for (let i = 0; i < 200; i++) {
      const job = await get(`/v1/jobs/${out.judge.job.id}`);
      if (!["queued", "running"].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  await answer("1.5", "answer-client-1");
  let list = await get("/v1/mistakes");
  for (let i = 0; i < 100 && !list.items[0]?.chapter; i++) {
    await new Promise((r) => setTimeout(r, 5));
    list = await get("/v1/mistakes");
  }
  assert.equal(list.items.length, 1);
  const [item] = list.items;
  assert.equal(item.answer, "1.5");
  assert.equal(item.source, "judge");
  assert.equal(item.cause, "计算失误");
  assert.equal(item.threadId, threadId);
  assert.ok(item.blocks.length > 0);
  // Jev files it under a chapter; it is due again tomorrow, not today.
  assert.deepEqual([item.chapter, item.chapterLabel], ["limit", "函数与极限"]);
  assert.equal(item.due, false);
  assert.deepEqual(list.counts.chapters, [
    { chapter: "limit", label: "函数与极限", n: 1 },
  ]);
  // The conversation knows the problem is in the book.
  assert.equal((await get(`/v1/chat/threads/${threadId}`)).thread.mistake.id, item.id);

  // A graded solution that found an error counts as getting it wrong again.
  await send({ threadId, steps: ["分部积分", "符号"], mode: "grade" });
  list = await get("/v1/mistakes");
  assert.equal(list.items[0].wrong, 2);
  assert.equal(list.items[0].source, "grade");
  assert.equal(list.items[0].cause, "第 2 步有误，分部积分那一项的符号写反了。");

  // Right the same day, just after the solution: not mastered yet.
  await answer("48", "answer-client-2");
  assert.equal((await get("/v1/mistakes")).counts.open, 1);

  // The home page counts only what was done today.
  const home = await get("/v1/home");
  assert.equal(home.streak, 1);
  assert.equal(home.todayDone, true);
  assert.deepEqual(home.todayStats, { asked: 2, answered: 2, correct: 1 });
  assert.equal(home.week.length, 7);
  assert.equal(home.week[6].active, true);
  assert.equal(home.threads[0].id, threadId);
  assert.equal(home.usage.answers.used, 2);
  assert.equal(home.mistakes.due, 0);

  // The next day it is due; a similar problem answered right masters it.
  clock.at = new Date(clock.at.getTime() + 86_400_000);
  assert.equal((await get("/v1/home")).mistakes.due, 1);
  const similar = (
    await app.inject({
      method: "POST",
      url: `/v1/chat/threads/${threadId}/similar`,
      headers: auth,
      payload: {},
    })
  ).json().data;
  const reply = async (value: string, clientId: string) =>
    (
      await app.inject({
        method: "POST",
        url: `/v1/chat/messages/${similar.id}/answer`,
        headers: auth,
        payload: { answer: value, clientId },
      })
    ).json().data;
  const wrong = await reply("3", "similar-client-1");
  assert.equal(wrong.judge.attempt.result.verdict, "incorrect");
  assert.equal(wrong.judge.attempt.result.reference, null);
  assert.equal(wrong.judge.similarOf, similar.id);
  // A wrong try at a similar problem is not a new mistake.
  assert.equal((await get("/v1/mistakes")).items[0].wrong, 2);
  const right = await reply("2", "similar-client-2");
  assert.equal(right.judge.attempt.result.verdict, "correct");
  assert.equal(right.judge.attempt.result.reference.text, "2");
  assert.deepEqual((await get("/v1/mistakes")).items, []);
  const thread = await get(`/v1/chat/threads/${threadId}`);
  assert.equal(thread.thread.mistake.status, "mastered");
  assert.equal(
    thread.messages.find((m: { id: string }) => m.id === similar.id).similar.revealed,
    true,
  );
  // A resend is not judged again.
  assert.equal((await reply("2", "similar-client-2")).question.id, right.question.id);

  const mastered = await get("/v1/mistakes?status=mastered");
  assert.equal(mastered.items.length, 1);
  assert.equal(mastered.counts.mastered, 1);
  // The learner can put it back, and remove it from the book.
  const id = mastered.items[0].id;
  await app.inject({
    method: "POST",
    url: `/v1/mistakes/${id}`,
    headers: auth,
    payload: { status: "open" },
  });
  const reopened = await get("/v1/mistakes");
  assert.equal(reopened.items[0].due, true);
  const exported = (
    await app.inject({ method: "GET", url: "/v1/me/export", headers: auth })
  ).json();
  assert.deepEqual(
    exported.mistakes.map((k: { wrong: number; status: string }) => [k.wrong, k.status]),
    [[2, "open"]],
  );
  await app.inject({ method: "DELETE", url: `/v1/mistakes/${id}`, headers: auth });
  assert.equal((await get("/v1/mistakes")).counts.open, 0);
  await app.close();
});

// A photographed draft whose step 2 lost the 3 of (e^{3x})′ but still ends at 9/2.
const DRAFT = [
  String.raw`1. 解：原式 $=\lim_{x\to 0}\dfrac{e^{3x}-1-3x}{x^2}$ （$\frac{0}{0}$ 型，洛必达）`,
  String.raw`$=\lim_{x\to 0}\dfrac{e^{3x}-3}{2x}$`,
  String.raw`$=\lim_{x\to 0}\dfrac{9e^{3x}}{2}$`,
  String.raw`$=\dfrac{9}{2}=4.5$`,
];
const PASSED = `第 2 步只是写法不同。\n\n**结论**：过程正确${verify("9/2")}`;
const CAUGHT = `第 2 步求导漏乘了 3：$(e^{3x})'=3e^{3x}$。\n\n**结论**：第 2 步有误，$e^{3x}$ 求导漏乘了 3。${verify("9/2")}`;

test("a graded draft is checked step by step; a wrong step passed as right is rechecked as a grade", async () => {
  const clock = { at: new Date() };
  const { app, fake, auth, send } = await setup([HINT, PASSED, CAUGHT], {}, () => clock.at);
  const get = async (url: string) =>
    (await app.inject({ method: "GET", url, headers: auth })).json().data;
  const { events } = await send({ problem: { text: PROBLEM }, mode: "auto" });
  const threadId = events[0]!.thread.id;
  // Wrong yesterday, so it is due today: a grade that says 过程正确 would master it.
  const out = (
    await app.inject({
      method: "POST",
      url: `/v1/chat/threads/${threadId}/answer`,
      headers: auth,
      payload: { answer: "1.5", clientId: "answer-client-1" },
    })
  ).json().data;
  for (let i = 0; i < 200; i++) {
    const job = await get(`/v1/jobs/${out.judge.job.id}`);
    if (!["queued", "running"].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  clock.at = new Date(clock.at.getTime() + 86_400_000);
  assert.equal((await get("/v1/mistakes")).counts.due, 1);

  const graded = await send({ threadId, steps: DRAFT, mode: "grade" });
  // The model is told which step the program found wrong.
  const asked = fake.calls.find((c) => c.last.includes("这是我的解题过程"))!;
  assert.match(asked.last, /程序判定：第 2 步是第一处/);
  const verifies = graded.events.filter((e) => e.e === "verify");
  assert.equal(verifies[0]!.verify.state, "conflict");
  assert.match(verifies[0]!.verify.items[0].detail, /第 2 步.*批改没有指出/);
  // The recheck is a grade again, with the program's finding.
  const recheck = graded.events.find((e) => e.e === "recheck")!;
  const again = fake.calls.at(-1)!;
  assert.match(again.system, /请你批改/);
  assert.match(again.last, /第 2 步有误：这一步的值/);
  assert.equal(verifies[1]!.id, recheck.id);
  assert.equal(verifies[1]!.verify.state, "pass");
  assert.match(verifies[1]!.verify.items[0].detail, /和批改结论一致/);
  const thread = await get(`/v1/chat/threads/${threadId}`);
  assert.equal(
    thread.messages.find((m: { id: string }) => m.id === recheck.id).mode,
    "grade",
  );
  // Filed once, from the recheck: still open, not mastered by the first grade.
  const list = await get("/v1/mistakes");
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].source, "grade");
  assert.equal(list.items[0].wrong, 2);
  assert.match(list.items[0].cause, /^第 2 步有误/);
  await app.close();
});

test("a grade that keeps passing a step the program found wrong still files it", async () => {
  const { app, auth, send } = await setup([HINT, PASSED, PASSED]);
  const { events } = await send({ problem: { text: PROBLEM }, mode: "auto" });
  const graded = await send({ threadId: events[0]!.thread.id, steps: DRAFT, mode: "grade" });
  // The last word on each reply: the grade, then its recheck.
  const states = new Map(
    graded.events.filter((e) => e.e === "verify").map((e) => [e.id, e.verify.state]),
  );
  assert.deepEqual([...states.values()], ["conflict", "unsure"]);
  const list = (
    await app.inject({ method: "GET", url: "/v1/mistakes", headers: auth })
  ).json().data;
  assert.equal(list.items[0].source, "grade");
  assert.match(list.items[0].cause, /^第 2 步有误/);
  await app.close();
});

// 回归样例 1： a product rule draft where (e^{2x})′ lost its 2.
const DERIVATIVE = String.raw`设 $y=\ln(1+x^2)e^{2x}$，求 $y'$`;
const D_DRAFT = [
  String.raw`$y'=\left[\ln(1+x^2)\right]'e^{2x}+\ln(1+x^2)\left(e^{2x}\right)'$`,
  String.raw`$=\frac{2x}{1+x^2}e^{2x}+\ln(1+x^2)e^{2x}$`,
];
const dverify = (answer: string, revealed = true) =>
  `\n<verify>{"answer":"${answer}","revealed":${revealed},"checks":[{"kind":"derivative","expr":"log(1+x^2)*exp(2*x)","answer":"${answer}"}]}</verify>`;
const D_RIGHT = "2*x/(1+x^2)*exp(2*x)+2*log(1+x^2)*exp(2*x)";

test("a graded derivative draft is checked step by step too (D038)", async () => {
  const { app, fake, send } = await setup([
    `先用乘积法则。${dverify(D_RIGHT, false)}`,
    `乘积法则用对了。\n\n**结论**：过程正确${dverify(D_RIGHT)}`,
    `第 2 步 $(e^{2x})'$ 应为 $2e^{2x}$。\n\n**结论**：第 2 步有误，$e^{2x}$ 求导漏乘了 2。${dverify(D_RIGHT)}`,
  ]);
  const { events } = await send({ problem: { text: DERIVATIVE }, mode: "auto" });
  const graded = await send({ threadId: events[0]!.thread.id, steps: D_DRAFT, mode: "grade" });
  const asked = fake.calls.find((c) => c.last.includes("这是我的解题过程"))!;
  assert.match(asked.last, /程序逐步核对了上面过程里的求导/);
  assert.match(asked.last, /第 2 步有误：这一步的式子不等于 y'/);
  const verifies = graded.events.filter((e) => e.e === "verify");
  assert.equal(verifies[0]!.verify.state, "conflict");
  assert.equal(verifies[1]!.verify.state, "pass");
  await app.close();
});

test("practice by chapter: a checked problem in its own conversation, wrongs filed under that chapter", async () => {
  const clock = { at: new Date() };
  const { app, fake, auth } = await setup([], {}, () => clock.at);
  const get = async (url: string) =>
    (await app.inject({ method: "GET", url, headers: auth })).json().data;
  const post = async (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url, headers: auth, payload });
  const refused = await post("/v1/chat/practice", { chapter: "ode" });
  assert.equal(refused.statusCode, 400);

  const made = (await post("/v1/chat/practice", { chapter: "derivative" })).json().data;
  assert.deepEqual(made.thread.practice, { chapter: "derivative", label: "导数与微分" });
  assert.ok(made.thread.materialId);
  assert.equal(made.message.kind, "similar");
  assert.equal(made.message.practice, "derivative");
  assert.equal(made.message.similar.verify.state, "pass");
  assert.equal(made.message.similar.answer, null);
  assert.equal(made.message.similar.key, undefined, "the key is the answer");
  assert.equal((await get("/v1/chat/usage")).answers.used, 1);
  // The answer is already checked, so no key is written for it.
  assert.equal(fake.calls.filter((c) => c.system.includes("解题教练")).length, 0);
  // A practice problem does not clutter the materials list.
  assert.deepEqual(await get("/v1/materials"), []);

  // Wrong: filed under the practice chapter, not reclassified by Jev.
  fake.judge.noul = 0.1;
  const wrong = (
    await post(`/v1/chat/messages/${made.message.id}/answer`, {
      answer: "2x\\cos x",
      clientId: "practice-client-1",
    })
  ).json().data;
  assert.equal(wrong.judge.attempt.result.verdict, "incorrect");
  let list = await get("/v1/mistakes");
  await new Promise((r) => setTimeout(r, 20));
  list = await get("/v1/mistakes");
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].chapter, "derivative");
  assert.equal(list.items[0].threadId, made.thread.id);

  // The next day, redoing it from the 错题本 (the thread's answer route) is
  // judged against the same checked answer, and masters it.
  clock.at = new Date(clock.at.getTime() + 86_400_000);
  const redo = (
    await post(`/v1/chat/threads/${made.thread.id}/answer`, {
      answer: "2x\\sin x + x^2\\cos x",
      clientId: "practice-client-2",
    })
  ).json().data;
  assert.equal(redo.judge.similarOf, made.message.id);
  assert.equal(redo.judge.attempt.result.verdict, "correct");
  assert.equal(redo.judge.job, null);
  assert.deepEqual((await get("/v1/mistakes")).items, []);
  assert.equal((await get("/v1/mistakes?status=mastered")).items[0].chapter, "derivative");

  // Practice problems already handed out are not asked for again.
  await post("/v1/chat/practice", { chapter: "derivative" });
  const prompt = fake.calls.filter((c) => c.system.includes("专项练")).at(-1)!;
  assert.match(prompt.last, /已经出过的题/);
  await app.close();
});


// 回归样例 2： a page of three problems, the last one smudged.
test("a page of homework is graded problem by problem; an unclear one waits for the learner (D040)", async () => {
  const { app, fake, auth } = await setup([]);
  const get = async (url: string) =>
    (await app.inject({ method: "GET", url, headers: auth })).json().data;
  const INTEGRAL = String.raw`计算 $\int x e^{x}\,dx$。`;
  fake.vision.scan = {
    type: "homework",
    problems: [],
    solution: null,
    notes: "",
    homework: [
      { no: "1", text: `1. ${PROBLEM}`, steps: DRAFT, unclear: "" },
      {
        no: "2",
        text: DERIVATIVE,
        steps: [String.raw`$y'=\frac{2x}{1+x^2}e^{2x}+2\ln(1+x^2)e^{2x}$`],
        unclear: "",
      },
      { no: "3", text: INTEGRAL, steps: [String.raw`$=xe^x-？$`], unclear: "最后一项被涂抹，看不清" },
    ],
  };
  fake.routes.push(
    [/e\^\{3x\}-3/, CAUGHT],
    [/2\\ln\(1\+x\^2\)/, `乘积法则用对了。\n\n**结论**：过程正确${dverify(D_RIGHT)}`],
    [/xe\^x-e\^x/, "分部积分用对了。\n\n**结论**：过程正确"],
  );
  const scan = (await upload(app, auth)).json().data;
  assert.equal(scan.type, "homework");
  assert.equal(scan.homework, 3);
  // Each problem can still be asked about on its own.
  assert.equal(scan.problems.length, 3);

  const start = await app.inject({
    method: "POST",
    url: "/v1/chat/homework",
    headers: auth,
    payload: { imageId: scan.imageId },
  });
  assert.equal(start.statusCode, 200, start.body);
  const id = start.json().data.id;
  assert.equal(start.json().data.title, "作业 · 3 题");
  assert.deepEqual(
    start.json().data.homework.items.map((i: { status: string }) => i.status),
    ["grading", "grading", "unclear"],
  );
  const settled = async () => {
    for (let i = 0; i < 400; i++) {
      const t = await get(`/v1/chat/threads/${id}`);
      if (!t.thread.homework.counts.grading) return t.thread.homework;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("still grading");
  };
  let homework = await settled();
  assert.deepEqual(
    { ...homework.counts },
    { correct: 1, wrong: 1, unsure: 0, unclear: 1, grading: 0, failed: 0 },
  );
  const [first, second, third] = homework.items;
  assert.equal(first.verdict, "wrong");
  assert.match(first.cause, /第 2 步有误/);
  // The worksheet's "1." is dropped from the problem.
  assert.match(first.text, /^求极限/);
  assert.equal(second.verdict, "correct");
  assert.equal(third.threadId, null);
  assert.match(third.unclear, /涂抹/);
  // Only the two clear problems were graded and charged.
  const grades = fake.calls.filter((c) => c.stream && c.last.includes("这是我的解题过程"));
  assert.equal(grades.length, 2);
  assert.equal((await get("/v1/chat/usage")).answers.used, 2);
  // Each problem is a graded thread of its own, checked step by step.
  const graded = await get(`/v1/chat/threads/${first.threadId}`);
  assert.equal(graded.thread.homeworkOf, id);
  assert.ok(graded.messages.some((m: { steps: string[] | null }) => m.steps?.length));
  // The wrong one is in the 错题本; the history lists the page, not its problems.
  const mistakes = await get("/v1/mistakes");
  assert.equal(mistakes.items.length, 1);
  assert.equal(mistakes.items[0].source, "grade");
  const threads = (await get("/v1/chat/threads")).threads;
  assert.deepEqual(
    threads.map((t: { id: string; homework: boolean }) => [t.id, t.homework]),
    [[id, true]],
  );
  // The same photo sent twice opens the same page.
  const again = await app.inject({
    method: "POST",
    url: "/v1/chat/homework",
    headers: auth,
    payload: { imageId: scan.imageId },
  });
  assert.equal(again.json().data.id, id);

  // The smudged one: a "？" left in is refused, the corrected work is graded.
  const grade3 = (steps: string[]) =>
    app.inject({
      method: "POST",
      url: `/v1/chat/threads/${id}/homework/2`,
      headers: auth,
      payload: { steps },
    });
  assert.equal((await grade3([String.raw`$=xe^x-？$`])).statusCode, 400);
  const fixed = await grade3([String.raw`$=xe^x-e^x+C$`]);
  assert.equal(fixed.statusCode, 200, fixed.body);
  homework = await settled();
  assert.equal(homework.items[2].verdict, "correct");
  assert.equal(homework.items[2].unclear, "");
  assert.equal((await grade3([String.raw`$=xe^x-e^x+C$`])).statusCode, 409);

  // Deleting the page deletes its problems' threads.
  await app.inject({ method: "DELETE", url: `/v1/chat/threads/${id}`, headers: auth });
  const child = await app.inject({
    method: "GET",
    url: `/v1/chat/threads/${first.threadId}`,
    headers: auth,
  });
  assert.equal(child.statusCode, 404);
  await app.close();
});

// was "needs a reply for each clear problem" (the whole page refused).
test("a page of homework with fewer answers left than problems grades the first and holds the rest", async () => {
  // decided by the budget at the start of each problem. The test
  // model is unpriced (highest rate): the scan costs about ¥0.0005, one
  // streamed grade about ¥0.004, so the first problem crosses ¥0.003.
  const { app, fake, auth } = await setup([], { DAILY_BUDGET_CNY: "0.003" });
  const get = async (url: string) =>
    (await app.inject({ method: "GET", url, headers: auth })).json().data;
  fake.vision.scan = {
    type: "homework",
    homework: [
      { no: "1", text: PROBLEM, steps: DRAFT },
      { no: "2", text: DERIVATIVE, steps: D_DRAFT },
    ],
  };
  fake.routes.push([/e\^\{3x\}-3/, CAUGHT]);
  const scan = (await upload(app, auth)).json().data;
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/homework",
    headers: auth,
    payload: { imageId: scan.imageId },
  });
  assert.equal(res.statusCode, 200, res.body);
  const id = res.json().data.id;
  let page = res.json().data.homework;
  for (let i = 0; i < 400 && page.counts.grading; i++) {
    await new Promise((r) => setTimeout(r, 5));
    page = (await get(`/v1/chat/threads/${id}`)).thread.homework;
  }
  assert.equal(page.items[0].status, "done");
  assert.equal(page.items[1].status, "unclear");
  assert.equal(page.items[1].hold, "quota");
  assert.equal(page.items[1].unclear, "今天的额度用完了，这道先放着，明天再批");
  assert.match(page.items[1].holdUntil, /T16:00:00\.000Z$/);
  assert.equal((await get("/v1/chat/usage")).budget.day.pct, 100);
  // The held one is graded once there is budget again; today it says why not.
  const later = await app.inject({
    method: "POST",
    url: `/v1/chat/threads/${id}/homework/1`,
    headers: auth,
    payload: { steps: D_DRAFT },
  });
  assert.equal(later.statusCode, 429);
  assert.match(later.body, /今天的额度用完了，明天 0 点恢复/);
  // Listed as not finished.
  const listed = (await get("/v1/chat/threads?tool=grade")).threads;
  assert.deepEqual(listed.map((t: { id: string; open: boolean }) => [t.id, t.open]), [[id, true]]);
  await app.close();
});

test("a grade that leads with its conclusion is read too", () => {
  assert.deepEqual(gradeConclusion("逐步看。\n\n**结论**：第 2 步有误，漏乘 3。"), {
    correct: false,
    text: "第 2 步有误，漏乘 3。",
  });
  assert.deepEqual(gradeConclusion("**过程正确。**\n\n第 1 步……"), { correct: true, text: "过程正确" });
  assert.deepEqual(gradeConclusion("**结论先行：** 第 1 步有误，错在等价替换。\n\n……"), {
    correct: false,
    text: "第 1 步有误，错在等价替换",
  });
  assert.equal(gradeConclusion("你的思路和第 1 步都对，问题出在**第 2 步的符号**。"), null);
  // Right but for something left out still loses marks.
  assert.equal(gradeConclusion("**结论**：过程正确，但漏了积分常数 $C$。")?.correct, false);
  assert.equal(gradeConclusion("**结论**：过程正确，没有遗漏。")?.correct, true);
  assert.equal(gradeConclusion("**过程正确，但漏了积分常数 C。**\n\n……")?.correct, false);
});

test("a problem flagged by the guide on a later message becomes the thread's problem and the reply is guided", async () => {
  const GUIDED_HINT = `${HINT}\n<guide>{"quote":"求极限","options":[],"problem":true}</guide>`;
  const { app, send, auth } = await setup([
    "导数描述函数在一点附近变化的快慢。",
    GUIDED_HINT,
  ]);
  const concept = await send({ text: "导数是什么意思？", mode: "auto" });
  const conceptDone = concept.events.find((e) => e.e === "done")!;
  assert.equal(conceptDone.message.guided, false);
  assert.ok(!concept.events.some((e) => e.e === "thread"));
  const threadId = concept.events[0]!.thread.id;
  const later = await send({ threadId, text: PROBLEM, mode: "auto" });
  const attached = later.events.find((e) => e.e === "thread");
  assert.ok(attached?.thread.materialId);
  const reply = later.events.find((e) => e.e === "done")!.message;
  assert.equal(reply.guided, true);
  // 收进错题本 is idempotent.
  const first = await app.inject({
    method: "POST",
    url: `/v1/chat/messages/${reply.id}/mistake`,
    headers: auth,
    payload: {},
  });
  assert.equal(first.statusCode, 200, first.body);
  const { mistake, thread } = first.json().data;
  assert.equal(mistake.status, "open");
  assert.equal(thread.id, threadId);
  const again = await app.inject({
    method: "POST",
    url: `/v1/chat/messages/${reply.id}/mistake`,
    headers: auth,
    payload: {},
  });
  assert.equal(again.json().data.mistake.id, mistake.id);
  // filed by hand, nothing has gone wrong yet.
  assert.equal(again.json().data.mistake.wrong, 0);
  const missing = await app.inject({
    method: "POST",
    url: `/v1/chat/messages/msg_missing/mistake`,
    headers: auth,
    payload: {},
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, "MESSAGE_NOT_FOUND");
  // The earlier concept reply is not filed as the later problem's mistake.
  const concepted = await app.inject({
    method: "POST",
    url: `/v1/chat/messages/${conceptDone.message.id}/mistake`,
    headers: auth,
    payload: {},
  });
  assert.equal(concepted.statusCode, 409);
  assert.equal(concepted.json().code, "NOT_A_PROBLEM");
  await app.close();
});

test("a concept conversation cannot be filed as a mistake", async () => {
  const { app, send, auth } = await setup(["一致连续是说整个区间上用同一个 δ 就够。"]);
  const concept = await send({ text: "什么是一致连续？", mode: "auto" });
  const reply = concept.events.find((e) => e.e === "done")!.message;
  const res = await app.inject({
    method: "POST",
    url: `/v1/chat/messages/${reply.id}/mistake`,
    headers: auth,
    payload: {},
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, "NOT_A_PROBLEM");
  await app.close();
});
