import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";

const usage = { prompt_tokens: 5, completion_tokens: 4 };
const RESULT = {
  title: "把几张卡摆开",
  groups: [{ name: "共同", common: "都在整理复习", cards: [1, 2] }],
  tensions: [{ a: 1, b: 2, note: "先理解还是先练习" }],
  more: [],
  ifs: [],
  directions: [{ title: "比较卡点", why: "两张卡都提到复习", from: [1, 2] }],
  drafts: [],
  ask: null,
};
const REPORT = {
  sections: {
    links: [{ text: "前两张都在说复习顺序", from: [1, 2] }],
    improve: [{ text: "第三张还缺具体做法", from: [3] }],
    expand: [],
    advice: [{ text: "先挑一张试一周", from: [] }],
  },
};

function setup() {
  const store = new SqliteStore(":memory:");
  const state: {
    report: unknown;
    hold?: Promise<void>;
    calls: { system: string; messages: string }[];
  } = { report: REPORT, calls: [] };
  const sse = (content: string) =>
    new Response(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}`,
        `data: ${JSON.stringify({ choices: [], usage })}`,
        "data: [DONE]",
        "",
      ].join("\n"),
      { headers: { "content-type": "text/event-stream" } },
    );
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/"))
      return new Response(
        JSON.stringify({
          answers: {
            q:
              body.questions.q.type === "noul"
                ? { noul: 0 }
                : { choice: "idea", confidence: 0.9, probabilities: { idea: 0.9 } },
          },
        }),
      );
    const system = String(body.messages[0].content);
    state.calls.push({ system, messages: JSON.stringify(body.messages) });
    if (system.includes("[BRAINSTORM]")) return sse(JSON.stringify(RESULT));
    if (system.includes("[BRAINSTORM_REPORT]")) {
      await state.hold;
      // Streamed since V4.2 G1b.
      if (body.stream) return sse(JSON.stringify(state.report));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(state.report) } }],
          usage,
        }),
      );
    }
    if (body.stream) return sse("先说说你最想先做哪一张。");
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "{}" } }], usage }),
    );
  }) as typeof fetch;
  const app = buildApp({
    store,
    fetcher,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-report-")),
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-formula-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "fake",
      JEV_API_KEY: "fake",
      DAILY_BRAINSTORM_LIMIT: "10",
      JOB_CONCURRENCY: "1",
    }),
  });
  return { app, store, state };
}

async function login(app: ReturnType<typeof buildApp>, store: SqliteStore) {
  const token = (
    await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "report-owner" } })
  ).json().data.token as string;
  const owner = String(
    store.db.prepare("SELECT id FROM users WHERE openid=?").get("dev:report-owner")!.id,
  );
  const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  return { call, owner };
}
type Call = Awaited<ReturnType<typeof login>>["call"];

function seedCards(store: SqliteStore, owner: string, ids: string[]) {
  const at = new Date().toISOString();
  for (const id of ids)
    store.db
      .prepare(
        `INSERT INTO cards(id,user_id,type,scene,title,title_by,mine,mine_at,quote,quote_on,origin,created_at,updated_at)
         VALUES(?,?,'idea','life',?,'user',?,?,?,date(?,'+8 hours'),'jot',?,?)`,
      )
      .run(id, owner, `${id}标题`, `${id}是我自己写下的一段完整内容`, at, `${id}原话`, at, at, at);
}
async function settle(call: Call, jobId: string) {
  for (let i = 0; i < 500; i++) {
    const job = (await call("GET", `/v1/jobs/${jobId}`)).json().data;
    if (["succeeded", "failed", "unknown"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("job did not settle");
}
async function ready(call: Call) {
  const started = await call("POST", "/v1/brainstorms", {
    clientId: "brain-report-1",
    cardIds: ["card_a", "card_b", "card_c"],
  });
  assert.equal(started.statusCode, 200, started.body);
  const brainstorm = started.json().data.brainstorm;
  return { brainstorm, job: brainstorm.jobId as string };
}
async function used(store: SqliteStore, owner: string) {
  return Number(
    store.db
      .prepare("SELECT count(*) AS n FROM jobs WHERE user_id=? AND kind='brainstorm_report'")
      .get(owner)!.n,
  );
}

test("a report waits for the result, then is made once with its cards resolved", async (t) => {
  const { app, store, state } = setup();
  t.after(() => app.close());
  const { call, owner } = await login(app, store);
  seedCards(store, owner, ["card_a", "card_b", "card_c"]);
  let release!: () => void;
  state.hold = new Promise((resolve) => (release = resolve));
  const { brainstorm, job } = await ready(call);
  assert.equal((await settle(call, job)).status, "succeeded");
  // Not ready until the first pass has a result.
  const saved = store.db.prepare("SELECT result FROM brainstorms WHERE id=?").get(brainstorm.id)!.result;
  store.db.prepare("UPDATE brainstorms SET result=NULL WHERE id=?").run(brainstorm.id);
  const early = await call("POST", `/v1/brainstorms/${brainstorm.id}/report`, { clientId: "report-client-0" });
  assert.equal(early.statusCode, 409);
  assert.equal(early.json().code, "BRAINSTORM_NOT_READY");
  store.db.prepare("UPDATE brainstorms SET result=? WHERE id=?").run(saved, brainstorm.id);
  const before = (await call("GET", `/v1/brainstorms/${brainstorm.id}`)).json().data;
  assert.equal(before.report, null);
  assert.equal(before.reportJob, null);
  const asked = await call("POST", `/v1/brainstorms/${brainstorm.id}/report`, { clientId: "report-client-1" });
  assert.equal(asked.statusCode, 200, asked.body);
  assert.equal(asked.json().data.report, null);
  const reportJob = asked.json().data.job;
  assert.equal(reportJob.kind, "brainstorm_report");
  // A retry with the same clientId gets the same job.
  const retry = await call("POST", `/v1/brainstorms/${brainstorm.id}/report`, { clientId: "report-client-1" });
  assert.equal(retry.json().data.job.id, reportJob.id);
  release();
  assert.equal((await settle(call, reportJob.id)).status, "succeeded");
  const detail = (await call("GET", `/v1/brainstorms/${brainstorm.id}`)).json().data;
  assert.equal(detail.reportJob.id, reportJob.id);
  const cards = detail.cards as { id: string; title: string }[];
  assert.deepEqual(detail.report.sections.links, [
    { text: "前两张都在说复习顺序", cards: [cards[0], cards[1]].map((c) => ({ id: c.id, title: c.title })) },
  ]);
  assert.deepEqual(detail.report.sections.improve[0].cards, [{ id: cards[2]!.id, title: cards[2]!.title }]);
  assert.deepEqual(detail.report.sections.expand, []);
  assert.deepEqual(detail.report.sections.advice[0].cards, []);
  assert.ok(detail.report.createdAt);
  // Once stored it is returned without a new job or charge.
  const again = await call("POST", `/v1/brainstorms/${brainstorm.id}/report`, { clientId: "report-client-2" });
  assert.equal(again.json().data.job, null);
  assert.deepEqual(again.json().data.report, detail.report);
  assert.equal(await used(store, owner), 1);
  // The list keeps its shape.
  const listed = (await call("GET", "/v1/brainstorms")).json().data.items[0];
  assert.ok(!("report" in listed));
});

test("card numbers the model wrote into a report are shown as card titles", async (t) => {
  const { app, store, state } = setup();
  t.after(() => app.close());
  const { call, owner } = await login(app, store);
  seedCards(store, owner, ["card_a", "card_b", "card_c"]);
  state.report = {
    sections: {
      links: [{ text: "卡2和卡 3都在说复习，卡9不在", from: [2, 3] }],
      improve: [],
      expand: [],
      advice: [],
    },
  };
  const { brainstorm, job } = await ready(call);
  assert.equal((await settle(call, job)).status, "succeeded");
  const asked = await call("POST", `/v1/brainstorms/${brainstorm.id}/report`, { clientId: "report-client-n" });
  assert.equal((await settle(call, asked.json().data.job.id)).status, "succeeded");
  assert.match(state.calls.find((c) => c.system.includes("[BRAINSTORM_REPORT]"))!.system, /不写“卡1”/);
  const detail = (await call("GET", `/v1/brainstorms/${brainstorm.id}`)).json().data;
  const cards = detail.cards as { id: string; title: string }[];
  assert.equal(
    detail.report.sections.links[0].text,
    `「${cards[1]!.title}」和「${cards[2]!.title}」都在说复习，卡9不在`,
  );
});

test("a report citing a card that is not there fails", async (t) => {
  const { app, store, state } = setup();
  t.after(() => app.close());
  const { call, owner } = await login(app, store);
  seedCards(store, owner, ["card_a", "card_b", "card_c"]);
  const { brainstorm, job } = await ready(call);
  await settle(call, job);
  state.report = { sections: { links: [{ text: "说到了第四张", from: [4] }], improve: [], expand: [], advice: [] } };
  const asked = await call("POST", `/v1/brainstorms/${brainstorm.id}/report`, { clientId: "report-client-3" });
  const failed = await settle(call, asked.json().data.job.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "AI_BAD_OUTPUT");
  assert.equal((await call("GET", `/v1/brainstorms/${brainstorm.id}`)).json().data.report, null);
});

test("a chat opened from a brainstorm carries its findings to the model", async (t) => {
  const { app, store, state } = setup();
  t.after(() => app.close());
  const { call, owner } = await login(app, store);
  seedCards(store, owner, ["card_a", "card_b", "card_c"]);
  const { brainstorm, job } = await ready(call);
  await settle(call, job);
  const asked = await call("POST", `/v1/brainstorms/${brainstorm.id}/report`, { clientId: "report-client-4" });
  await settle(call, asked.json().data.job.id);
  const missing = await call("POST", "/v1/chat/threads", { brainstormId: "brain_missing" });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, "BRAINSTORM_NOT_FOUND");
  const opened = await call("POST", "/v1/chat/threads", { brainstormId: brainstorm.id, cardIds: ["card_a"] });
  assert.equal(opened.statusCode, 200, opened.body);
  const threadId = opened.json().data.thread.id;
  const sent = await call("POST", "/v1/chat/send", {
    threadId,
    text: "我觉得第一张最要紧",
    clientId: "send-brainstorm-1",
  });
  assert.equal(sent.statusCode, 200, sent.body);
  const last = state.calls.at(-1)!;
  assert.match(last.messages, /这次头脑风暴：把几张卡摆开/);
  assert.match(last.messages, /关联：前两张都在说复习顺序/);
  // A brainstorm alone, with no cards, still reaches the model.
  const alone = await call("POST", "/v1/chat/threads", { brainstormId: brainstorm.id });
  await call("POST", "/v1/chat/send", {
    threadId: alone.json().data.thread.id,
    text: "接着聊",
    clientId: "send-brainstorm-2",
  });
  assert.match(state.calls.at(-1)!.messages, /这次头脑风暴：把几张卡摆开/);
});
