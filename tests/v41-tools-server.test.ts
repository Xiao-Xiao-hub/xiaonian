// V4.1 G5 : the four study tools. 拍一道题 (scan purpose, 做到一半卡住),
// 批改草稿 (POST /v1/chat/drafts), 整页作业 (a problem into 错题本 by hand) and
// 讲一遍 (key points while explaining, POST /v1/chat/threads/:id/teach-review).
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
import { STUCK_RULE } from "../server/src/modules/chat/tools-prompts.js";

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
function setup() {
  const calls: { stream: boolean; system: string; last: string }[] = [];
  const json: Record<string, Json[]> = { draft: [], review: [] };
  const script: (string | number)[] = [];
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
      const next = script.shift() ?? "（没有更多回复）";
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
    else if (system.includes("[DRAFT_GRADE]")) content = pick(json.draft!);
    else if (system.includes("[TEACH_REVIEW]")) content = pick(json.review!);
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

test("scan: a purpose steers the reading and suggests the tool the photo fits", async () => {
  const t = setup();
  try {
    const old = (await t.upload()).json().data;
    assert.equal("suggest" in old, false, "no purpose: the reply is as before");
    assert.equal(t.calls.at(-1)!.last.includes("识别这张图片。"), true);
    const asProblem = (await t.upload("?purpose=problem&tone=light")).json().data;
    assert.equal(asProblem.suggest, "draft");
    assert.match(t.calls.at(-1)!.last, /拍一道题/);
    const asDraft = (await t.upload("?purpose=draft")).json().data;
    assert.equal(asDraft.suggest, null);
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
    assert.equal((await t.upload("?purpose=draft")).json().data.suggest, "homework");
    assert.equal((await t.upload("?purpose=homework")).json().data.suggest, null);
    t.vision.scan = { type: "problems", problems: [{ text: PROBLEM, unclear: "" }], solution: null, notes: "" };
    assert.equal((await t.upload("?purpose=homework")).json().data.suggest, "problem");
    assert.equal((await t.upload("?purpose=draft")).json().data.suggest, "problem");
    assert.equal((await t.upload("?purpose=other")).statusCode, 400);
  } finally {
    await t.app.close();
  }
});

test("做到一半卡住: the stuck turn tells the tutor to hint from where the learner stopped", async () => {
  const t = setup();
  try {
    t.script.push("先看你第二步。", "好的。");
    const events = await t.send({
      problem: { text: PROBLEM },
      text: "我做到一半卡住了。已经写了：洛必达一次。卡在：第二次求导",
      stuck: true,
      mode: "auto",
      origin: "solve",
    });
    assert.ok(events.some((e) => e.e === "done"), JSON.stringify(events));
    const first = t.calls.filter((c) => c.stream).at(-1)!;
    assert.ok(first.system.includes(STUCK_RULE));
    assert.ok(first.system.endsWith(IDENTITY_RULE), "the identity rule stays last");
    const threadId = events.find((e) => e.e === "start")!.thread.id;
    await t.send({ threadId, text: "接着呢", mode: "auto" });
    assert.equal(t.calls.filter((c) => c.stream).at(-1)!.system.includes(STUCK_RULE), false, "only for that turn");
  } finally {
    await t.app.close();
  }
});

test("批改草稿: steps come back ✓/✗ with the first error, kept as a solve chat and counted once", async () => {
  const t = setup();
  try {
    // The model passes every step; the program's wrong step 2 stays wrong.
    t.json.draft!.push({
      steps: [{ status: "ok", note: "" }, { status: "ok", note: "" }, { status: "ok" }, { status: "ok" }, { status: "ok" }],
      first: null,
      summary: "整体思路是洛必达",
    });
    const before = await t.used();
    const res = await t.call("POST", "/v1/chat/drafts", { problem: PROBLEM, steps: DRAFT, tone: "light" });
    assert.equal(res.statusCode, 200, res.body);
    const out = res.json().data;
    const graded = t.calls.find((c) => c.system.includes("[DRAFT_GRADE]"))!;
    assert.ok(graded.system.includes(IDENTITY_RULE));
    assert.match(graded.last, /共 4 步/);
    assert.equal(out.message.kind, "draft");
    const d = out.message.draft;
    assert.equal(d.verdict, "wrong");
    assert.equal(d.by, "json");
    // the steps after the first error are carried, never ✓.
    assert.deepEqual(d.steps.map((s: { status: string }) => s.status), ["ok", "wrong", "carried", "carried"]);
    assert.equal(d.steps.length, 4, "extra model steps are dropped");
    assert.equal(d.first.step, 2);
    assert.ok(d.first.why.length && d.steps[1].blocks.length);
    assert.match(JSON.stringify(out.message.blocks), /结论/);
    assert.equal(out.question.kind, "steps");
    assert.equal(await t.used(), before + 1);
    // Listed with the problem chats, and the problem has a record: 错题本 by hand.
    const solve = (await t.call("GET", "/v1/chat/threads?kind=solve")).json().data.threads;
    assert.equal(solve.find((x: { id: string }) => x.id === out.thread.id)?.tool, "draft", "reopens on 批改草稿");
    // a wrong draft is filed by itself, as a graded page is.
    assert.equal(out.thread.mistake?.status, "open", "a wrong draft is filed");
    const added = await t.call("POST", `/v1/chat/messages/${out.message.id}/mistake`, { tone: "light" });
    assert.equal(added.statusCode, 200, added.body);
    assert.equal(added.json().data.mistake.status, "open");
    // Reopened later, the same result.
    const again = (await t.call("GET", `/v1/chat/threads/${out.thread.id}?tone=light`)).json().data;
    const kept = again.messages.find((m: { kind: string }) => m.kind === "draft");
    assert.deepEqual(kept.draft.steps.map((s: { status: string }) => s.status), ["ok", "wrong", "carried", "carried"]);
    // A right draft: no first error.
    t.json.draft!.push({ steps: RIGHT.map(() => ({ status: "ok" })), first: null, summary: "过程没问题" });
    const right = (await t.call("POST", "/v1/chat/drafts", { problem: PROBLEM, steps: RIGHT, tone: "light" })).json().data;
    assert.equal(right.message.draft.verdict, "correct");
    assert.equal(right.message.draft.first, null);
  } finally {
    await t.app.close();
  }
});

test("批改草稿: unusable JSON falls back to a plain grading; nothing usable is a 502 and not counted", async () => {
  const t = setup();
  try {
    t.json.draft!.push("不是 JSON", "还不是");
    t.script.push("第 3 步约分错了。\n\n**结论**：第 3 步有误，约分时丢了系数。");
    const before = await t.used();
    const res = await t.call("POST", "/v1/chat/drafts", { problem: PROBLEM, steps: RIGHT, tone: "light" });
    assert.equal(res.statusCode, 200, res.body);
    const d = res.json().data.message.draft;
    assert.equal(d.by, "text");
    assert.deepEqual(d.steps.map((s: { status: string }) => s.status), ["ok", "ok", "wrong", "unclear"]);
    assert.equal(d.first.step, 3);
    assert.equal(await t.used(), before + 1);
    // Both fail: an error the page can show, no chat left behind, no count.
    t.json.draft!.push("x", "y");
    t.script.push(500, 500, 500);
    const threads = (await t.call("GET", "/v1/chat/threads")).json().data.threads.length;
    const failed = await t.call("POST", "/v1/chat/drafts", { problem: PROBLEM, steps: RIGHT, tone: "light" });
    assert.equal(failed.statusCode, 502, failed.body);
    assert.equal(failed.json().code, "DRAFT_FAILED");
    assert.equal((await t.call("GET", "/v1/chat/threads")).json().data.threads.length, threads);
    assert.equal(await t.used(), before + 1);
    // A reply with no conclusion (a busy message) is not a grade either.
    t.json.draft!.push("x", "y");
    t.script.push("服务繁忙，请稍后再试");
    const busy = await t.call("POST", "/v1/chat/drafts", { problem: PROBLEM, steps: RIGHT, tone: "light" });
    assert.equal(busy.statusCode, 502, busy.body);
    assert.equal(await t.used(), before + 1);
    // A malformed step number falls back too, never a 500.
    t.json.draft!.push(
      { steps: RIGHT.map(() => ({ status: "ok" })), first: { step: { toString: "1" }, why: "x" }, summary: "" },
      { steps: RIGHT.map(() => ({ status: "ok" })), first: { step: [2], why: "x" }, summary: "" },
    );
    t.script.push("**结论**：过程正确");
    const odd = await t.call("POST", "/v1/chat/drafts", { problem: PROBLEM, steps: RIGHT, tone: "light" });
    assert.equal(odd.statusCode, 200, odd.body);
    assert.equal(odd.json().data.message.draft.by, "text");
    // Bad input is refused before any call.
    assert.equal((await t.call("POST", "/v1/chat/drafts", { problem: PROBLEM, steps: [], tone: "light" })).statusCode, 400);
  } finally {
    await t.app.close();
  }
});

test("批改草稿: a crisis message is answered with the safety reply, no grading", async () => {
  const t = setup();
  try {
    const res = await t.call("POST", "/v1/chat/drafts", { problem: "我不想活了", steps: ["1"], tone: "light" });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().data, { crisis: true });
    assert.equal(t.calls.some((c) => c.system.includes("[DRAFT_GRADE]")), false);
  } finally {
    await t.app.close();
  }
});

test("讲一遍: 小狸 asks with the point's key points; 讲完了 compares and counts as an answer", async () => {
  const t = setup();
  try {
    const thread = (
      await t.call("POST", "/v1/chat/threads", { mode: "teach", pointId: POINT.id, text: POINT.name, origin: "solve", tone: "light" })
    ).json().data.thread;
    t.script.push("那为什么要这样？");
    const said = "我觉得这个知识点最重要的是先看清楚条件再下结论";
    await t.send({ threadId: thread.id, text: said, mode: "auto" });
    const asked = t.calls.filter((c) => c.stream).at(-1)!.system;
    assert.ok(asked.includes(KEYS[0]!), "key points are in the prompt");
    assert.ok(asked.includes(POINT.name));
    assert.ok(asked.endsWith(IDENTITY_RULE));
    t.json.review!.push({
      points: [
        { text: "x", status: "covered", quote: "先看清楚条件" },
        { text: "y", status: "covered", quote: "我没说过这句" },
      ],
      wrong: [
        { quote: "再下结论", why: "顺序不对", fix: "先验证" },
        { quote: "编出来的话", why: "无", fix: "" },
      ],
      best: said,
    });
    const before = await t.used();
    const res = await t.call("POST", `/v1/chat/threads/${thread.id}/teach-review`, { tone: "light" });
    assert.equal(res.statusCode, 200, res.body);
    const out = res.json().data;
    const reviewed = t.calls.find((c) => c.system.includes("[TEACH_REVIEW]"))!;
    assert.ok(reviewed.system.includes(IDENTITY_RULE));
    assert.match(reviewed.last, /参照要点/);
    assert.equal(out.fallback, false);
    const r = out.message.review;
    assert.equal(out.message.kind, "teach_review");
    assert.equal(r.points.length, KEYS.length, "one row per key point");
    assert.equal(r.points[0].text, KEYS[0]);
    assert.equal(r.points[0].status, "covered");
    assert.equal(r.points[1].status, "partial", "covered without the learner's words is partial");
    assert.equal(r.points[1].quote, "");
    assert.ok(r.points.slice(2).every((p: { status: string }) => p.status === "missed"));
    assert.equal(r.wrong.length, 1, "a wrong claim needs the learner's own words");
    assert.equal(r.best, said);
    assert.equal(r.pointId, POINT.id);
    assert.equal(await t.used(), before + 1);
    // Unusable JSON: the key points to check by hand, nothing kept or counted.
    // (V4.2 G7: nothing said since gives the same review, so something is.)
    t.json.review!.push("坏的", "还是坏的");
    const fb = (
      await t.call("POST", `/v1/chat/threads/${thread.id}/teach-review`, { tone: "light", text: "再补一句：先看定义域" })
    ).json().data;
    assert.equal(fb.fallback, true);
    assert.deepEqual(fb.keys, KEYS);
    assert.equal(fb.message, null);
    assert.equal(await t.used(), before + 1);
    // Only a teach chat, and only once something was said.
    const plain = (await t.call("POST", "/v1/chat/threads", { text: "聊聊", tone: "light" })).json().data.thread;
    assert.equal((await t.call("POST", `/v1/chat/threads/${plain.id}/teach-review`, { tone: "light" })).statusCode, 400);
    const empty = (await t.call("POST", "/v1/chat/threads", { mode: "teach", pointId: POINT.id, tone: "light" })).json().data.thread;
    assert.equal((await t.call("POST", `/v1/chat/threads/${empty.id}/teach-review`, { tone: "light" })).json().code, "TEXT_EMPTY");
  } finally {
    await t.app.close();
  }
});

test("讲一遍 on a topic of one's own: the topic steers the follow-ups and the review lists its own points", async () => {
  const t = setup();
  try {
    const thread = (
      await t.call("POST", "/v1/chat/threads", { mode: "teach", topic: "泰勒公式的余项", text: "泰勒公式的余项", origin: "solve", tone: "light" })
    ).json().data.thread;
    t.script.push("余项是什么意思？");
    await t.send({ threadId: thread.id, text: "余项就是展开后剩下的误差部分", mode: "auto" });
    assert.match(t.calls.filter((c) => c.stream).at(-1)!.system, /泰勒公式的余项/);
    t.json.review!.push({
      points: [
        { text: "余项表示误差", status: "covered", quote: "剩下的误差部分" },
        { text: "皮亚诺余项", status: "missed", quote: "" },
      ],
      wrong: [],
      best: "",
    });
    const r = (await t.call("POST", `/v1/chat/threads/${thread.id}/teach-review`, { tone: "light" })).json().data.message.review;
    assert.deepEqual(r.points.map((p: { status: string }) => p.status), ["covered", "missed"]);
    assert.equal(r.topic, "泰勒公式的余项");
    const listed = (await t.call("GET", "/v1/chat/threads")).json().data.threads;
    assert.equal(listed.find((x: { id: string }) => x.id === thread.id)?.tool, "teach", "reopens on 讲一遍");
    assert.equal(r.pointId, null);
    // A topic is only kept for 讲一遍 without a point; old bodies still work.
    assert.equal((await t.call("POST", "/v1/chat/threads", { mode: "teach", tone: "light" })).statusCode, 200);
    assert.equal((await t.call("POST", "/v1/chat/threads", { topic: "", tone: "light" })).statusCode, 400);
  } finally {
    await t.app.close();
  }
});

test("整页作业: a graded problem can be put into 错题本 by hand; the page says which are there", async () => {
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
    t.script.push("**结论**：过程正确", "**结论**：过程正确");
    const scan = (await t.upload("?purpose=homework")).json().data;
    const hw = (await t.call("POST", "/v1/chat/homework", { imageId: scan.imageId, tone: "light" })).json().data;
    let view = hw;
    for (let i = 0; i < 50 && view.homework.counts.grading; i++) {
      await new Promise((r) => setTimeout(r, 20));
      view = (await t.call("GET", `/v1/chat/threads/${hw.id}?tone=light`)).json().data.thread;
    }
    assert.equal(view.homework.counts.correct, 2, JSON.stringify(view.homework.counts));
    assert.deepEqual(view.homework.items.map((i: { inBook: boolean }) => i.inBook), [false, false]);
    const res = await t.call("POST", `/v1/chat/threads/${hw.id}/homework/1/mistake`, { tone: "light" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().data.mistake.status, "open");
    assert.deepEqual(res.json().data.thread.homework.items.map((i: { inBook: boolean }) => i.inBook), [false, true]);
    assert.equal((await t.call("POST", `/v1/chat/threads/${hw.id}/homework/4/mistake`, { tone: "light" })).statusCode, 404);
  } finally {
    await t.app.close();
  }
});
