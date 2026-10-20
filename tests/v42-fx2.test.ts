// V4.2 FX2 (second review, report A): 讲完了 and AI 加练 asked again with the
// same clientId are done once (never a second insert, call or charge); a page
// problem still waiting its turn never shows as 没看完 and is never graded
// twice side by side; a 卡住了 fallback is marked, free and not help used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";
import { MAP_CARDS } from "../server/src/modules/learn/map-cards.js";
import { fakeServices, makeApp } from "./fixtures.js";

const PROBLEM = String.raw`求极限 $\lim_{x\to 0}\frac{e^{3x}-1-3x}{x^{2}}$。`;
const RIGHT = [
  String.raw`原式 $=\lim_{x\to 0}\dfrac{e^{3x}-1-3x}{x^2}$`,
  String.raw`$=\lim_{x\to 0}\dfrac{3e^{3x}-3}{2x}$`,
  String.raw`$=\lim_{x\to 0}\dfrac{9e^{3x}}{2}$`,
  String.raw`$=\dfrac{9}{2}$`,
];
const POINT = CALC_MAP.chapters
  .flatMap((c) => c.points)
  .find((p) => MAP_CARDS[p.id]?.keys.length)!;
// A point AI 加练 can make problems for (0.6.0 “AI 再出一道”).
const CHOICE_ID = "derivative-chain";
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
type Reply = string | (() => Promise<string>);
function setup() {
  const calls: { stream: boolean; system: string; last: string }[] = [];
  const json: Record<string, Json[]> = { review: [], practice: [] };
  const script: Reply[] = [];
  const vision: { scan: unknown } = { scan: null };
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
      const queued = script.shift() ?? "**结论**：过程正确";
      const next = typeof queued === "function" ? await queued() : queued;
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
    const pick = async (queue: Json[], otherwise: unknown) => {
      const item = queue.length ? queue.shift() : otherwise;
      return typeof item === "function" ? await item() : item;
    };
    let content: unknown;
    if (system.includes("数学题图片识别")) content = vision.scan;
    else if (system.includes("[TEACH_REVIEW]")) content = await pick(json.review!, null);
    else if (system.includes("专项练")) content = await pick(json.practice!, MADE);
    else if (calls.some((c) => c.system.includes("专项练"))) content = MADE;
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
    const res = await call("POST", "/v1/chat/send", { clientId: `fx2-${++n}-abcdef`, tone: "light", ...payload });
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
const REVIEW = { points: [{ text: "x", status: "covered", quote: "先看清楚条件" }], wrong: [], best: "" };

test("讲完了 (中-1): the same clientId asked again inserts the words once, reviews once and is counted once", async () => {
  const t = setup();
  try {
    const thread = (
      await t.call("POST", "/v1/chat/threads", { mode: "teach", pointId: POINT.id, origin: "solve", tone: "light" })
    ).json().data.thread;
    t.script.push("然后呢？");
    await t.send({ threadId: thread.id, text: "先看清楚条件，再下结论", mode: "auto" });
    const hold = later();
    t.json.review!.push(async () => {
      await hold.gate;
      return REVIEW;
    });
    const before = await t.used();
    const url = `/v1/chat/threads/${thread.id}/teach-review`;
    const body = { tone: "light", text: "最后补一句：要验证端点", clientId: "teach-client-0001" };
    const first = t.call("POST", url, body);
    await tick();
    // The page timed out (or was left and opened again) and asks again: it waits.
    const second = t.call("POST", url, body);
    await tick();
    hold.open();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(a.json().data.message.id, b.json().data.message.id);
    // Asked again after it finished (the answer never reached the page): the stored review.
    const third = await t.call("POST", url, body);
    assert.equal(third.statusCode, 200, third.body);
    assert.equal(third.json().data.message.id, a.json().data.message.id);
    assert.equal(third.json().data.fallback, false);
    const messages = (await t.call("GET", `/v1/chat/threads/${thread.id}?tone=light`)).json().data.messages;
    assert.equal(
      messages.filter((m: { blocks: unknown }) => JSON.stringify(m.blocks).includes("要验证端点")).length,
      1,
      "the words go in once",
    );
    assert.equal(messages.filter((m: { kind: string }) => m.kind === "teach_review").length, 1);
    assert.equal(t.calls.filter((c) => c.system.includes("[TEACH_REVIEW]")).length, 1);
    assert.equal(await t.used(), before + 1);
    // Without a clientId (0.6.0) the same text goes in again, as before.
    t.json.review!.push(REVIEW);
    const old = await t.call("POST", url, { tone: "light", text: "最后补一句：要验证端点" });
    assert.equal(old.statusCode, 200, old.body);
    assert.notEqual(old.json().data.message.id, a.json().data.message.id);
    assert.equal(await t.used(), before + 2);
    // A clientId that is not an id is refused.
    assert.equal((await t.call("POST", url, { tone: "light", clientId: "bad id" })).statusCode, 400);
  } finally {
    await t.app.close();
  }
});

test("讲完了 (中-1): a review that could not be made is free, and the same clientId reviews the words already in", async () => {
  const t = setup();
  try {
    const thread = (
      await t.call("POST", "/v1/chat/threads", { mode: "teach", topic: "泰勒公式", text: "泰勒公式", origin: "solve", tone: "light" })
    ).json().data.thread;
    const url = `/v1/chat/threads/${thread.id}/teach-review`;
    const body = { tone: "light", text: "泰勒公式是用多项式逼近函数", clientId: "teach-client-0002" };
    const before = await t.used();
    t.json.review!.push("坏的", "还是坏的", "又坏了");
    const failed = (await t.call("POST", url, body)).json().data;
    assert.equal(failed.fallback, true);
    assert.equal(await t.used(), before);
    t.json.review!.push(REVIEW);
    const ok = (await t.call("POST", url, body)).json().data;
    assert.equal(ok.fallback, false);
    const messages = (await t.call("GET", `/v1/chat/threads/${thread.id}?tone=light`)).json().data.messages;
    assert.equal(messages.filter((m: { role: string }) => m.role === "user").length, 1);
    assert.equal(await t.used(), before + 1);
  } finally {
    await t.app.close();
  }
});

test("AI 加练 (中-5): the same clientId makes one problem — a repeat while it is made waits, one after gets it", async () => {
  const t = setup();
  try {
    const hold = later();
    t.json.practice!.push(async () => {
      await hold.gate;
      return MADE;
    });
    const before = await t.used();
    const body = { pointId: CHOICE_ID, clientId: "practice-client-1", tone: "light" };
    const first = t.call("POST", "/v1/chat/practice", body);
    await tick();
    const second = t.call("POST", "/v1/chat/practice", body);
    await tick();
    hold.open();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(a.json().data.message.id, b.json().data.message.id);
    assert.equal(a.json().data.thread.id, b.json().data.thread.id);
    const third = (await t.call("POST", "/v1/chat/practice", body)).json().data;
    assert.equal(third.message.id, a.json().data.message.id);
    assert.equal(third.message.kind, "similar");
    assert.equal(third.message.practicePoint, CHOICE_ID);
    assert.deepEqual(Object.keys(third).sort(), ["message", "thread"]);
    assert.equal(t.calls.filter((c) => c.system.includes("专项练")).length, 1);
    const one = await t.used();
    assert.ok(one <= before + 1, `${before} → ${one}`);
    // Without a clientId (0.6.0) each tap is another problem, as before.
    const old1 = (await t.call("POST", "/v1/chat/practice", { pointId: CHOICE_ID, tone: "light" })).json().data;
    const old2 = (await t.call("POST", "/v1/chat/practice", { pointId: CHOICE_ID, tone: "light" })).json().data;
    assert.notEqual(old1.message.id, old2.message.id);
    assert.notEqual(old1.message.id, a.json().data.message.id);
    assert.equal(t.calls.filter((c) => c.system.includes("专项练")).length, 3);
  } finally {
    await t.app.close();
  }
});

test("整页 (中-3): a problem waiting its turn stays grading, cannot be graded beside itself, and is graded once", async () => {
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
        { no: "3", text: PROBLEM, steps: RIGHT, unclear: "" },
      ],
    };
    const hold = later();
    t.script.push(async () => {
      await hold.gate;
      return "**结论**：过程正确";
    });
    const scan = (await t.upload("?purpose=grade")).json().data;
    const hw = (await t.call("POST", "/v1/chat/homework", { imageId: scan.imageId, tone: "light" })).json().data;
    await tick();
    // The page was made eleven minutes ago; problem 1 is still being graded.
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    const row = t.store.db.prepare("SELECT data FROM threads WHERE id=?").get(hw.id) as { data: string };
    const data = JSON.parse(row.data);
    for (const item of data.homework.items.slice(1)) item.startedAt = old;
    t.store.db.prepare("UPDATE threads SET data=? WHERE id=?").run(JSON.stringify(data), hw.id);
    const view = async () =>
      (await t.call("GET", `/v1/chat/threads/${hw.id}?tone=light`)).json().data.thread.homework;
    let page = await view();
    assert.deepEqual(page.items.map((i: { status: string }) => i.status), ["grading", "grading", "grading"]);
    assert.equal(page.counts.failed, 0);
    // No 再批一次 beside the queued one.
    const again = await t.call("POST", `/v1/chat/threads/${hw.id}/homework/1`, { steps: RIGHT, tone: "light" });
    assert.equal(again.statusCode, 409, again.body);
    hold.open();
    for (let i = 0; i < 200 && page.counts.grading; i++) {
      await tick();
      page = await view();
    }
    assert.deepEqual(page.items.map((i: { status: string }) => i.status), ["done", "done", "done"]);
    assert.equal(t.calls.filter((c) => c.stream).length, 3, "each problem graded once");
    // Its grading started when its turn came, and the queue mark is gone.
    const items = JSON.parse(
      (t.store.db.prepare("SELECT data FROM threads WHERE id=?").get(hw.id) as { data: string }).data,
    ).homework.items;
    assert.ok(items.every((i: { queued?: boolean; startedAt: string }) => !i.queued && i.startedAt > old));
  } finally {
    await t.app.close();
  }
});

test("整页 (中-3): a queued problem the server forgot (a restart) shows failed and can be graded again; old pages keep the 10-minute rule", async () => {
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
    const scan = (await t.upload("?purpose=grade")).json().data;
    const hw = (await t.call("POST", "/v1/chat/homework", { imageId: scan.imageId, tone: "light" })).json().data;
    const view = async () =>
      (await t.call("GET", `/v1/chat/threads/${hw.id}?tone=light`)).json().data.thread.homework;
    let page = await view();
    for (let i = 0; i < 200 && page.counts.grading; i++) {
      await tick();
      page = await view();
    }
    // As a server that restarted would leave it: problem 2 queued, no one grading
    // it; problem 1 marked grading the old way (no queue mark), started just now.
    const now = new Date().toISOString();
    const row = t.store.db.prepare("SELECT data FROM threads WHERE id=?").get(hw.id) as { data: string };
    const data = JSON.parse(row.data);
    data.homework.items[0] = { ...data.homework.items[0], status: "grading", startedAt: now };
    data.homework.items[1] = { ...data.homework.items[1], status: "grading", startedAt: now, queued: true };
    t.store.db.prepare("UPDATE threads SET data=? WHERE id=?").run(JSON.stringify(data), hw.id);
    page = await view();
    assert.deepEqual(page.items.map((i: { status: string }) => i.status), ["grading", "failed"]);
    assert.equal((await t.call("POST", `/v1/chat/threads/${hw.id}/homework/0`, { steps: RIGHT, tone: "light" })).statusCode, 409);
    const retry = await t.call("POST", `/v1/chat/threads/${hw.id}/homework/1`, { steps: RIGHT, tone: "light" });
    assert.equal(retry.statusCode, 200, retry.body);
    page = await view();
    for (let i = 0; i < 200 && page.items[1].status === "grading"; i++) {
      await tick();
      page = await view();
    }
    assert.equal(page.items[1].status, "done");
  } finally {
    await t.app.close();
  }
});

test("卡住了 (低-11): the fallback is marked, free, and not counted as help used", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(
    fakeServices({ ask: { quote: "", ask: "x", options: ["只有一个"], suggest: null } }),
    {},
    () => new Date("2026-10-12T01:00:00.000Z"),
    store,
  );
  t.after(() => app.close());
  const login = (await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "fx2-stuck" } })).json().data;
  const sent = await app.inject({
    method: "POST",
    url: "/v1/learn/points/limit-order/stuck",
    headers: { authorization: `Bearer ${login.token}` },
    payload: { text: "这一步看不懂" },
  });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().data.fallback, true);
  assert.deepEqual(sent.json().data.options, []);
  const row = store.db
    .prepare("SELECT practice_on, stuck_at FROM map_points WHERE user_id=? AND point_id='limit-order'")
    .get(login.user.id) as { practice_on: string | null; stuck_at: string | null };
  assert.equal(row.practice_on, null, "a fallback is not help used");
  assert.ok(row.stuck_at, "the point is still marked stuck: the learner said so");
  assert.equal(
    Number(
      (store.db.prepare("SELECT count(*) n FROM quota_receipts WHERE user_id=? AND kind='map_stuck'").get(login.user.id) as { n: number }).n,
    ),
    0,
  );
});
