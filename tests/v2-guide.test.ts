import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEnv } from "../server/src/config/env.js";
import { buildApp } from "../server/src/index.js";
import { parseGuide, splitGuide, visibleGuide } from "../server/src/modules/chat/guide.js";
import { guideSystem, studyGuide } from "../server/src/modules/chat/guide-prompts.js";
import { entryScene, needsSceneJudge } from "../server/src/modules/chat/scenes.js";
import { splitVerify, visiblePart } from "../server/src/modules/chat/prompts.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { fakeServices, makeApp } from "./fixtures.js";

const GUIDE_REPLY = '先说说你最在意的那一点。<guide>{"quote":"","options":["继续说"]}</guide>';

function fixedGuideServices() {
  const state: {
    streamCalls: number;
    requests: Record<string, any>[];
    jev: { type: string; text: string }[];
    choices: string[];
    noul: number;
    reply: string;
    pieces?: string[];
    pause?: (signal: AbortSignal) => Promise<void>;
  } = { streamCalls: 0, requests: [], jev: [], choices: [], noul: 0,
    reply: GUIDE_REPLY };
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      const question = body.questions.q;
      state.jev.push({ type: question.type, text: String(body.state?.text ?? body.state ?? "") });
      const answer = question.type === "noul"
        ? { noul: state.noul }
        : (() => { const choice = state.choices.shift() ??
            (Object.hasOwn(question.criteria ?? {}, "mood") ? "mood" : Object.keys(question.criteria ?? {})[0]);
          return { choice, confidence: 0.9, probabilities: { [choice]: 0.9 } }; })();
      return new Response(JSON.stringify({ answers: { q: answer } }));
    }
    if (!body.stream) throw new Error("guide API tests only expect streamed generation");
    state.requests.push(body);
    state.streamCalls += 1;
    await state.pause?.(init?.signal as AbortSignal);
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const content of state.pieces ?? [state.reply])
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetcher, state };
}

async function guideApi(start = new Date("2026-10-12T00:00:00.000Z")) {
  const fixed = fixedGuideServices();
  const store = new SqliteStore(":memory:");
  let clock = start;
  const app = buildApp({
    store,
    now: () => new Date(clock),
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-guide-")),
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-guide-formula-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "test-llm",
      JEV_API_KEY: "test-jev",
    }),
    fetcher: fixed.fetcher,
  });
  const login = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "guide-api" } });
  const { token, user } = login.json().data as { token: string; user: { id: string } };
  const auth = { authorization: `Bearer ${token}` };
  const send = async (payload: Record<string, unknown>) => {
    const response = await app.inject({ method: "POST", url: "/v1/chat/send", headers: auth,
      payload: { mode: "auto", tone: "light", ...payload } });
    const events = response.body.split("\n\n")
      .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
      .map((frame) => JSON.parse(frame.slice(6)) as Record<string, any>);
    return { response, events };
  };
  return { app, auth, fixed, send, store, user, setNow: (next: Date) => { clock = next; } };
}

function seedMessages(store: SqliteStore, threadId: string, userId: string, start: Date, minutes: number[]) {
  const insert = store.db.prepare(
    "INSERT INTO messages(id,thread_id,user_id,role,kind,content,data,status,client_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  minutes.forEach((minute, index) => insert.run(`seed-${threadId}-${index}`, threadId, userId,
    "user", "text", `第${index + 1}段`, "{}", "done", null,
    new Date(start.getTime() + minute * 60_000).toISOString()));
}

// V4.2 : the reply no longer quotes the user, so a quote the model still
// sends is dropped; options stay bounded.
test("guide drops quotes and bounds options", () => {
  const guide = parseGuide('{"quote":"今天，被室友说了几句","spot":"不存在","options":["只想说说","理清发生了什么","想想能做什么","这是第四个选项","第五个"]}', ["今天被室友说了几句，很委屈。"]);
  assert.deepEqual(guide, { options: ["只想说说", "理清发生了什么", "想想能做什么", "这是第四个选项"] });
  assert.equal(parseGuide("{bad", ["x"]), null);
  assert.deepEqual(parseGuide('{"options":["一","二","三","四","五"],"card":{"type":"idea","title":"先问清截止日期"}}', [], true),
    { options: ["一", "二", "三", "四"] });
  assert.deepEqual(parseGuide('{"options":[],"card":{"type":"method","title":"先列三个选择"}}', []),
    { options: [], card: { type: "method", title: "先列三个选择" } });
  assert.equal(parseGuide('{"options":[],"card":"idea"}', []), null);
  assert.match(guideSystem("life", false), /"card":\{"kind":"note","title":/);
  assert.match(guideSystem("life", false), /spark=灵感/);
  assert.match(studyGuide, /覆盖上文/);
  assert.match(studyGuide, /<\/verify> 之后/);
});

test("guide and verify tags never leak while streaming or storing", () => {
  assert.equal(visibleGuide("正文<gui"), "正文");
  assert.equal(visiblePart("正文<guide>{}"), "正文");
  assert.deepEqual(splitGuide("正文<guide>{}</guide>"), { visible: "正文", raw: "{}" });
  assert.equal(splitVerify("正文<verify>{}</verify><guide>{}</guide>").visible, "正文");
});

test("jot entry remains study for formulas and otherwise starts life with an explicit mood candidate", () => {
  assert.deepEqual(entryScene("jot", "求导数 f(x)=x^2"), { scene: "study", moodCandidate: false });
  assert.deepEqual(entryScene("jot", "今天很委屈"), { scene: "life", moodCandidate: true });
  assert.deepEqual(entryScene(undefined, "随便问"), { scene: "study", moodCandidate: false });
  assert.equal(needsSceneJudge("周末先做什么"), true);
  assert.equal(needsSceneJudge("最近很焦虑"), false);
  assert.equal(needsSceneJudge("求导数 f(x)=x^2"), false);
});

test("mood scene requires consent and cannot be changed back", async () => {
  const app = makeApp(fakeServices());
  try {
    const login = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "guide-api" } });
    const auth = { authorization: `Bearer ${login.json().data.token}` };
    const made = await app.inject({ method: "POST", url: "/v1/chat/threads", headers: auth, payload: { entry: "jot", text: "今天很委屈", tone: "light" } });
    const id = made.json().data.thread.id;
    assert.equal((await app.inject({ method: "PATCH", url: `/v1/chat/threads/${id}`, headers: auth, payload: { scene: "mood", tone: "light" } })).statusCode, 409);
    await app.inject({ method: "PUT", url: "/v1/me/mood-consent", headers: auth });
    assert.equal((await app.inject({ method: "PATCH", url: `/v1/chat/threads/${id}`, headers: auth, payload: { scene: "mood", tone: "light" } })).statusCode, 200);
    assert.equal((await app.inject({ method: "PATCH", url: `/v1/chat/threads/${id}`, headers: auth, payload: { scene: "life", tone: "light" } })).statusCode, 409);
  } finally { await app.close(); }
});

test("a mood candidate waits without generation or charge and same-client retries stay idempotent", async () => {
  const { app, auth, fixed, send, store } = await guideApi();
  try {
    const payload = { entry: "jot", text: "今天很委屈", clientId: "candidate-client-1" };
    const first = await send(payload);
    const retry = await send(payload);
    assert.deepEqual(first.events.map((event) => event.e), ["scene_candidate"]);
    assert.deepEqual(retry.events.map((event) => event.e), ["scene_candidate"]);
    assert.equal(fixed.state.streamCalls, 0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM threads").get()!.n, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages").get()!.n, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM quota_receipts").get()!.n, 0);
    assert.equal((await app.inject({ url: "/v1/chat/usage", headers: auth })).json().data.answers.used, 0);

    const chosen = await send({ ...payload, sceneChoice: "life" });
    const chosenRetry = await send({ ...payload, sceneChoice: "life" });
    assert.ok(chosen.events.some((event) => event.e === "done"));
    assert.ok(chosenRetry.events.some((event) => event.e === "done"));
    assert.equal(fixed.state.streamCalls, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages").get()!.n, 2);
    assert.equal((await app.inject({ url: "/v1/chat/usage", headers: auth })).json().data.answers.used, 1);
  } finally { await app.close(); }
});

test("jot routing gives study rules priority, judges unclear text, and screens first messages as life", async () => {
  const { app, auth, fixed, send } = await guideApi();
  try {
    const formula = await app.inject({ method: "POST", url: "/v1/chat/threads", headers: auth,
      payload: { entry: "jot", text: "求导数 f(x)=x^2", tone: "light" } });
    assert.equal(formula.json().data.thread.scene, "study");
    assert.equal(fixed.state.jev.filter((call) => call.type === "choice").length, 0);

    fixed.state.choices.push("study");
    const judged = await app.inject({ method: "POST", url: "/v1/chat/threads", headers: auth,
      payload: { entry: "jot", text: "这篇论文从哪里开始看", tone: "light" } });
    assert.equal(judged.json().data.thread.scene, "study");
    assert.equal(fixed.state.jev.filter((call) => call.type === "choice").length, 1);

    fixed.state.noul = 0.9;
    const crisis = await send({ entry: "jot", text: "求导数 f(x)=x^2", clientId: "jot-crisis-client" });
    assert.deepEqual(crisis.events.map((event) => event.e), ["crisis"]);
    assert.equal(fixed.state.streamCalls, 0);
    assert.ok(fixed.state.jev.some((call) => call.type === "noul" && call.text.includes("求导数")));
  } finally { await app.close(); }
});

test("mixed jot stays life with the required first choice and a mid-thread feeling remains a nonblocking candidate", async () => {
  const { app, auth, fixed, send } = await guideApi();
  try {
    const mixed = await send({ entry: "jot", text: "最近很迷茫，不知道要选哪条路",
      clientId: "mixed-opening-client" });
    assert.ok(mixed.events.some((event) => event.e === "done"));
    assert.ok(!mixed.events.some((event) => event.e === "scene_candidate"));
    assert.match(fixed.state.requests.at(-1)!.messages[0].content,
      /想先说说感受，还是先理一理要做的选择/);
    const id = mixed.events.find((event) => event.e === "start")!.thread.id;

    const later = await send({ threadId: id, text: "今天真的很委屈",
      clientId: "mid-candidate-client" });
    assert.ok(later.events.some((event) => event.e === "scene_candidate" && event.pending === false));
    assert.ok(later.events.some((event) => event.e === "done"));
  } finally { await app.close(); }
});

test("life generation is capped, bypasses verify, and includes parsed guide in the final SSE message", async () => {
  const { app, fixed, send } = await guideApi();
  try {
    fixed.state.choices.push("life");
    fixed.state.reply = '先理清选择。<verify>{"answer":"42","revealed":true,"checks":[]}</verify><guide>{"quote":"先做计划","options":["列出选择"],"card":{"type":"idea","title":"先列选择"},"end":false}</guide>';
    const result = await send({ entry: "jot", text: "先做计划", clientId: "life-guide-client" });
    assert.equal(fixed.state.requests.at(-1)!.max_tokens, 600 + 1024);
    assert.ok(!result.events.some((event) => event.e === "verify"));
    const done = result.events.find((event) => event.e === "done")!;
    assert.deepEqual(done.message.guide, { options: ["列出选择"],
      card: { type: "idea", title: "先列选择" } });
    assert.doesNotMatch(JSON.stringify(done.message.blocks), /42/);
    assert.equal(done.message.verify, null);
  } finally { await app.close(); }
});

test("choosing mood requires consent and persists the selected scene", async () => {
  const { app, auth, send } = await guideApi();
  try {
    const payload = { entry: "jot", text: "今天很难过", clientId: "candidate-client-2" };
    const candidate = await send(payload);
    const id = candidate.events[0]!.thread.id;
    const refused = await send({ ...payload, sceneChoice: "mood" });
    assert.equal(refused.response.statusCode, 409);
    assert.equal(refused.response.json().code, "MOOD_CONSENT_REQUIRED");
    await app.inject({ method: "PUT", url: "/v1/me/mood-consent", headers: auth });
    const accepted = await send({ ...payload, sceneChoice: "mood" });
    assert.ok(accepted.events.some((event) => event.e === "done"));
    const thread = await app.inject({ url: `/v1/chat/threads/${id}?tone=light`, headers: auth });
    assert.equal(thread.json().data.thread.scene, "mood");
  } finally { await app.close(); }
});

test("supplement permission needs a real offer before consent and logs invalid add metadata only", async () => {
  const { app, auth, fixed, send, store, user } = await guideApi();
  try {
    fixed.state.choices.push("life");
    const made = await app.inject({ method: "POST", url: "/v1/chat/threads", headers: auth,
      payload: { entry: "jot", text: "生活安排", tone: "light" } });
    const id = made.json().data.thread.id as string;
    const insert = store.db.prepare(
      "INSERT INTO messages(id,thread_id,user_id,role,kind,content,data,status,client_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    );
    for (let index = 0; index < 3; index++) {
      insert.run(`policy-user-${index}`, id, user.id, "user", "text", `第${index + 1}轮完整回答`,
        "{}", "done", null, `2026-10-12T00:0${index}:00.000Z`);
      insert.run(`policy-ai-${index}`, id, user.id, "assistant", "reply", "可以再说一点吗？",
        "{}", "done", null, `2026-10-12T00:0${index}:30.000Z`);
    }
    fixed.state.reply = '要不要我补几个角度？<guide>{"options":["要","不用"],"add":true}</guide>';
    fixed.state.choices.push("life");
    await send({ threadId: id, text: "好", clientId: "policy-no-offer-client" });
    assert.match(fixed.state.requests.at(-1)!.messages[0].content, /本轮不补充看法或信息/);
    const violation = store.db.prepare(
      "SELECT data FROM events WHERE user_id=? AND name='chat_guide_violation' ORDER BY id DESC LIMIT 1",
    ).get(user.id) as { data: string };
    assert.deepEqual(JSON.parse(violation.data), { kind: "add_not_allowed" });
    assert.doesNotMatch(violation.data, /角度|好/);

    fixed.state.reply = GUIDE_REPLY;
    fixed.state.choices.push("life");
    await send({ threadId: id, text: "好", clientId: "policy-after-offer-client" });
    assert.match(fixed.state.requests.at(-1)!.messages[0].content, /本轮允许补充/);
  } finally { await app.close(); }
});

test("mood switches to action framing only after the exact action option", async () => {
  const { app, auth, fixed, send } = await guideApi();
  try {
    await app.inject({ method: "PUT", url: "/v1/me/mood-consent", headers: auth });
    fixed.state.choices.push("life");
    const made = await app.inject({ method: "POST", url: "/v1/chat/threads", headers: auth,
      payload: { entry: "jot", text: "聊聊今天的事", tone: "light" } });
    const id = made.json().data.thread.id as string;
    await app.inject({ method: "PATCH", url: `/v1/chat/threads/${id}`, headers: auth,
      payload: { scene: "mood", tone: "light" } });
    await send({ threadId: id, text: "理清发生了什么", clientId: "mood-reflect-client" });
    assert.match(fixed.state.requests.at(-1)!.messages[0].content, /不分析原因、不提建议/);
    await send({ threadId: id, text: "想想能做什么", clientId: "mood-action-client" });
    assert.match(fixed.state.requests.at(-1)!.messages[0].content, /心里先分清发生了什么、心情怎样/);
    assert.equal(fixed.state.requests.at(-1)!.max_tokens, 600 + 1024);
  } finally { await app.close(); }
});

test("forbidden model wording is withheld from stream, storage, guide data, and logs", async () => {
  const { app, auth, fixed, send, store, user } = await guideApi();
  try {
    fixed.state.reply = '我会陪伴你继续想。<guide>{"options":["心理治疗"],"card":{"type":"idea","title":"寻找治疗"}}</guide>';
    fixed.state.pieces = ["我会陪", '伴你继续想。<guide>{"options":["心理治',
      '疗"],"card":{"type":"idea","title":"寻找治疗"}}</guide>'];
    const result = await send({ entry: "jot", text: "最近很迷茫", clientId: "banned-output-client" });
    const rendered = JSON.stringify(result.events);
    assert.doesNotMatch(rendered, /陪伴|心理治疗|治疗/);
    const start = result.events.find((event) => event.e === "start")!;
    const saved = await app.inject({ url: `/v1/chat/threads/${start.thread.id}?tone=light`, headers: auth });
    assert.doesNotMatch(JSON.stringify(saved.json()), /陪伴|心理治疗|治疗/);
    const rows = store.db.prepare(
      "SELECT data FROM events WHERE user_id=? AND name='chat_guide_violation'",
    ).all(user.id) as { data: string }[];
    assert.ok(rows.some((row) => JSON.parse(row.data).kind === "banned_phrase"));
    assert.ok(rows.every((row) => !/陪伴|心理治疗|治疗/.test(row.data)));
  } finally { await app.close(); }
});

test("withdrawing mood consent aborts an awaited reply and late completion cannot restore it", async () => {
  const { app, auth, fixed, send, store, user } = await guideApi();
  let releaseReady!: () => void;
  const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
  try {
    await app.inject({ method: "PUT", url: "/v1/me/mood-consent", headers: auth });
    const made = await app.inject({ method: "POST", url: "/v1/chat/threads", headers: auth,
      payload: { entry: "jot", text: "想聊聊近况", tone: "light" } });
    const id = made.json().data.thread.id as string;
    await app.inject({ method: "PATCH", url: `/v1/chat/threads/${id}`, headers: auth,
      payload: { scene: "mood", tone: "light" } });
    fixed.state.pause = (signal) => new Promise<void>((_resolve, reject) => {
      releaseReady();
      signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
    });
    const pending = send({ threadId: id, text: "还有一件事没想清", clientId: "withdraw-client-1" });
    await ready;
    const withdrawn = await app.inject({ method: "DELETE", url: "/v1/me/mood-consent", headers: auth });
    assert.equal(withdrawn.statusCode, 200, withdrawn.body);
    const late = await pending;
    assert.ok(!late.events.some((event) => ["blocks", "tail", "done"].includes(event.e)));
    assert.equal(store.getUser(user.id)!.moodConsentAt, undefined);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM threads WHERE user_id=?").get(user.id)!.n, 0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages WHERE user_id=?").get(user.id)!.n, 0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM quota_receipts WHERE user_id=?").get(user.id)!.n, 0);
  } finally { await app.close(); }
});

test("life and mood emit the two-hour reminder while a thirty-minute break resets it", async () => {
  const start = new Date("2026-10-12T00:00:00.000Z");
  const { app, auth, send, setNow, store, user } = await guideApi(start);
  try {
    for (const scene of ["life", "mood"] as const) {
      if (scene === "mood")
        await app.inject({ method: "PUT", url: "/v1/me/mood-consent", headers: auth });
      const made = await app.inject({ method: "POST", url: "/v1/chat/threads", headers: auth,
        payload: { entry: "jot", text: `${scene}连续对话`, tone: "light" } });
      const id = made.json().data.thread.id as string;
      if (scene === "mood")
        await app.inject({ method: "PATCH", url: `/v1/chat/threads/${id}`, headers: auth,
          payload: { scene: "mood", tone: "light" } });
      seedMessages(store, id, user.id, start, [0, 25, 50, 75, 100]);
      setNow(new Date(start.getTime() + 121 * 60_000));
      const result = await send({ threadId: id, text: "继续", clientId: `break-${scene}-client` });
      assert.equal(result.events.filter((event) => event.e === "break_reminder").length, 1, scene);
    }

    const reset = await app.inject({ method: "POST", url: "/v1/chat/threads", headers: auth,
      payload: { entry: "jot", text: "有断点的生活对话", tone: "light" } });
    const resetId = reset.json().data.thread.id as string;
    seedMessages(store, resetId, user.id, start, [0, 30, 55, 80, 105]);
    setNow(new Date(start.getTime() + 125 * 60_000));
    const afterBreak = await send({ threadId: resetId, text: "继续", clientId: "break-reset-client" });
    assert.ok(!afterBreak.events.some((event) => event.e === "break_reminder"));
  } finally { await app.close(); }
});

test("study guide keeps a boolean problem flag and drops anything else", () => {
  assert.deepEqual(parseGuide('{"options":["再给一步"],"problem":true}', [], true), {
    options: ["再给一步"],
    problem: true,
  });
  assert.deepEqual(parseGuide('{"options":[],"problem":false}', [], true), { options: [], problem: false });
  assert.deepEqual(parseGuide('{"options":[],"problem":"true"}', [], true), { options: [] });
  assert.deepEqual(parseGuide('{"options":[],"problem":1}', [], true), { options: [] });
  assert.match(studyGuide, /"problem":false/);
});
