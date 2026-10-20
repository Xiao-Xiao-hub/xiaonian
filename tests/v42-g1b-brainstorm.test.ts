// one brainstorm is one charge, a shorter prompt, results saved by
// what they mean, stale reports, short conclusions and code-point titles.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { NOT_VOID } from "../server/src/modules/jobs/runner.js";

const usage = { prompt_tokens: 5, completion_tokens: 4 };
const RESULT = {
  title: "复习怎么排",
  groups: [
    { name: "为什么", common: "都说先懂概念再做题", cards: [1, 2], slot: "why" },
    { name: "怎么做", common: "都想按章节整理错题", cards: [3, 4], slot: "steps" },
  ],
  tensions: [
    { a: 1, b: 2, note: "定义到底考不考", kind: "verify" },
    { a: 3, b: 4, note: "先刷题还是先整理", kind: "choose" },
    { a: 1, b: 3, note: "一个说白天一个说晚上", kind: "differ" },
  ],
  more: [{ type: "question", title: "哪章最容易错", from: [3] }],
  ifs: [{ if: "周末有空", from: [3] }],
  directions: [{ title: "先列章节表", why: "两张卡都提到按章整理", from: [3, 4] }],
  drafts: [
    { text: "这周先把错题按章节整理一遍", from: [3, 4], kind: "todo" },
    { text: "先弄懂概念再刷题", from: [1, 2], kind: "method" },
  ],
  ask: null,
};
const REPORT = {
  sections: {
    links: [{ text: "前两张都在说先懂概念", from: [1, 2] }],
    improve: [],
    expand: [],
    advice: [{ text: "先挑一章试试", from: [] }],
  },
};

function setup(env: Record<string, string> = {}) {
  const store = new SqliteStore(":memory:");
  const state = {
    result: RESULT as unknown,
    calls: [] as Array<{
      kind: string;
      system: string;
      user: string;
      body: Record<string, unknown>;
    }>,
  };
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
    const system = String(body.messages[0].content),
      user = String(body.messages.at(-1).content);
    const kind = system.includes("[BRAINSTORM_REPORT]")
      ? "report"
      : system.includes("[BRAINSTORM]")
        ? "brainstorm"
        : "other";
    state.calls.push({ kind, system, user, body });
    const content = JSON.stringify(kind === "report" ? REPORT : state.result);
    return body.stream
      ? sse(content)
      : new Response(JSON.stringify({ choices: [{ message: { content } }], usage }));
  }) as typeof fetch;
  const app = buildApp({
    store,
    fetcher,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-g1b-")),
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-g1b-f-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "fake",
      JEV_API_KEY: "fake",
      DAILY_BRAINSTORM_LIMIT: "10",
      JOB_CONCURRENCY: "1",
      ...env,
    }),
  });
  return { app, store, state };
}
type Setup = ReturnType<typeof setup>;

async function login(f: Setup) {
  const token = (
    await f.app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "g1b" } })
  ).json().data.token as string;
  const owner = String(
    f.store.db.prepare("SELECT id FROM users WHERE openid=?").get("dev:g1b")!.id,
  );
  const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
    f.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  return { call, owner };
}
type Call = Awaited<ReturnType<typeof login>>["call"];

function seed(
  f: Setup,
  owner: string,
  id: string,
  text: string,
  options: { title?: string; kind?: string; type?: string } = {},
) {
  const at = new Date().toISOString();
  f.store.db
    .prepare(
      `INSERT INTO cards(id,user_id,type,kind,scene,title,title_by,mine,mine_at,quote,quote_on,origin,created_at,updated_at)
       VALUES(?,?,?,?,'study',?,'user',?,?,?,date(?,'+8 hours'),'jot',?,?)`,
    )
    .run(
      id,
      owner,
      options.type ?? "idea",
      options.kind ?? null,
      options.title ?? `${id}标题`,
      text,
      at,
      text,
      at,
      at,
      at,
    );
}
async function settle(call: Call, jobId: string) {
  for (let i = 0; i < 500; i++) {
    const job = (await call("GET", `/v1/jobs/${jobId}`)).json().data;
    if (["succeeded", "failed", "unknown"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("job did not settle");
}
async function ready(call: Call, ids: string[], clientId = "g1b-1") {
  const started = await call("POST", "/v1/brainstorms", { clientId, cardIds: ids });
  assert.equal(started.statusCode, 200, started.body);
  const brainstorm = started.json().data.brainstorm;
  assert.equal((await settle(call, brainstorm.jobId)).status, "succeeded");
  return (await call("GET", `/v1/brainstorms/${brainstorm.id}`)).json().data;
}
async function makeReport(call: Call, id: string, body: Record<string, unknown> = {}) {
  const response = await call("POST", `/v1/brainstorms/${id}/report`, {
    clientId: `report-${Math.random().toString(36).slice(2, 10)}`,
    ...body,
  });
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json().data;
  if (data.job) assert.equal((await settle(call, data.job.id)).status, "succeeded");
  return data;
}
const counted = (f: Setup, owner: string) =>
  Number(
    f.store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM quota_receipts r WHERE user_id=? AND source='job' AND ${NOT_VOID}`,
      )
      .get(owner)!.n,
  );

test("a brainstorm and its reports cost one receipt; both are spent, and a refresh waits once the budget is used up", async (t) => {
  // a tiny budget, crossed by the brainstorm itself.
  const f = setup({ DAILY_BUDGET_CNY: "0.0001" });
  t.after(() => f.app.close());
  const { call, owner } = await login(f);
  for (const id of ["c1", "c2", "c3", "c4", "c5"]) seed(f, owner, id, `${id}的内容`);
  const brainstorm = await ready(call, ["c1", "c2", "c3", "c4"]);
  assert.equal(counted(f, owner), 1);
  // The last brainstorm of the day still gets its report.
  const first = await makeReport(call, brainstorm.id);
  assert.ok(first.job);
  assert.equal(counted(f, owner), 1);
  const reportJob = String(first.job.id);
  // Both receipts exist; the report's is void from the start.
  assert.deepEqual(
    f.store.db
      .prepare(
        "SELECT r.kind, v.job_id AS voided FROM quota_receipts r LEFT JOIN quota_voids v ON v.source=r.source AND v.source_id=r.source_id WHERE r.user_id=? ORDER BY r.kind",
      )
      .all(owner)
      .map((row) => ({ ...row })),
    [
      { kind: "brainstorm", voided: null },
      { kind: "brainstorm_report", voided: reportJob },
    ],
  );
  // Both jobs' usage is spent, the void report's too.
  assert.deepEqual(
    f.store.db
      .prepare("SELECT source_id FROM quota_spend WHERE user_id=? ORDER BY source_id")
      .all(owner)
      .map((row) => row.source_id),
    [brainstorm.jobId, reportJob].sort(),
  );
  // A report written again after the groups changed is a new action: with
  // the budget used up it waits, so refreshing is not free.
  const groups = brainstorm.result.groups.map((g: { common: string }, i: number) =>
    i ? g : { ...g, common: "改过的共同点" },
  );
  assert.equal(
    (await call("PUT", `/v1/brainstorms/${brainstorm.id}/picks`, { groups })).statusCode,
    200,
  );
  const again = await call("POST", `/v1/brainstorms/${brainstorm.id}/report`, {
    clientId: "report-again",
    refresh: true,
  });
  assert.equal(again.statusCode, 429, again.body);
  assert.equal(again.json().message, "今天的额度用完了，明天 0 点恢复");
  assert.equal(counted(f, owner), 1);
  // A second brainstorm the same day is still over the limit.
  const blocked = await call("POST", "/v1/brainstorms", {
    clientId: "g1b-2",
    cardIds: ["c1", "c2", "c5"],
  });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().code, "DAILY_LIMIT");
});

test("the prompt is one line a card within a text budget, output is capped and the report is streamed", async (t) => {
  const f = setup();
  t.after(() => f.app.close());
  const { call, owner } = await login(f);
  const long = "复习的时候先把概念弄清楚再去做题，".repeat(20);
  const ids = Array.from({ length: 50 }, (_, i) => `k${String(i).padStart(2, "0")}`);
  ids.forEach((id, i) =>
    // Line breaks inside a card do not break its line.
    seed(f, owner, id, i === 2 ? `${id}：第一行\n\n第二行${long}` : `${id}：${long}`, {
      // Titles that are the start of the text are not sent twice.
      title: i % 2 ? `${id}：复习的时候` : `${id}的标题`,
      ...(i === 0 ? { kind: "todo" } : {}),
    }),
  );
  const brainstorm = await ready(call, ids);
  const sent = f.state.calls.find((c) => c.kind === "brainstorm")!;
  const lines = sent.user.split("\n");
  assert.match(lines[0]!, /^场景：study；大型，50张$/);
  assert.equal(lines.length, 51);
  assert.match(lines[1]!, /^1 \[待办\] k00的标题｜k00：复习/);
  assert.match(lines[2]!, /^2 \[想法\] k01：复习的时候/);
  assert.doesNotMatch(lines[2]!, /｜/);
  assert.match(lines[3]!, /^3 \[想法\] k02的标题｜k02：第一行 第二行复习/);
  // 4800 / 50 = 96 characters of text per card.
  assert.ok(lines.every((line) => !line.includes("★") || line.endsWith(" ★")));
  const text = lines[2]!.replace(/^2 \[想法\] /, "").replace(/ ★$/, "");
  assert.equal(Array.from(text).length, 96);
  assert.ok(Array.from(sent.user).length < 6500, String(Array.from(sent.user).length));
  assert.match(sent.system, /slot/);
  assert.match(sent.system, /verify/);
  assert.equal(sent.body.max_tokens, 6144 + 16384);
  await makeReport(call, brainstorm.id);
  const report = f.state.calls.find((c) => c.kind === "report")!;
  assert.equal(report.body.stream, true);
  assert.equal(report.body.max_tokens, 2048 + 16384);
  assert.ok(Array.from(report.user).length < 5000, String(Array.from(report.user).length));
  assert.doesNotMatch(report.user, /"text"/);
});

test("groups, differences and drafts are saved by what they mean", async (t) => {
  const f = setup();
  t.after(() => f.app.close());
  const { call, owner } = await login(f);
  const six = ["c1", "c2", "c3", "c4", "c5", "c6"];
  for (const id of six) seed(f, owner, id, `${id}的内容`);
  const brainstorm = await ready(call, six);
  assert.deepEqual(
    brainstorm.result.groups.slice(0, 2).map((g: { slot: string }) => g.slot),
    ["why", "steps"],
  );
  assert.deepEqual(
    brainstorm.result.tensions.map((x: { kind: string }) => x.kind),
    ["verify", "choose", "differ"],
  );
  assert.equal(brainstorm.result.drafts[0].kind, "todo");
  // The page echoes the new fields back; stances on two of the differences.
  const tensions = brainstorm.result.tensions.map(
    (x: Record<string, unknown>, i: number) =>
      i === 0 ? { ...x, choice: "a" } : i === 1 ? { ...x, choice: "b" } : x,
  );
  const put = await call("PUT", `/v1/brainstorms/${brainstorm.id}/picks`, {
    groups: brainstorm.result.groups,
    tensions,
    drafts: brainstorm.result.drafts,
    // No kind sent: the draft used decides (待办).
    conclusion: { text: brainstorm.result.drafts[0].text, draftId: "d1" },
  });
  assert.equal(put.statusCode, 200, put.body);
  // Stored items keep the v4.1 shape (its picks schema takes no slot / kind,
  // and old clients send back what they got); meanings sit beside them.
  const row = f.store.db
    .prepare("SELECT result,picks FROM brainstorms WHERE id=?")
    .get(brainstorm.id) as { result: string; picks: string };
  const storedResult = JSON.parse(row.result),
    storedPicks = JSON.parse(row.picks);
  for (const list of [
    storedResult.groups,
    storedResult.tensions,
    storedResult.drafts,
    storedPicks.groups,
    storedPicks.tensions,
    storedPicks.drafts,
  ])
    for (const item of list) assert.ok(!("slot" in item) && !("kind" in item), JSON.stringify(item));
  assert.deepEqual(storedResult.meanings.tensions, { t1: "verify", t2: "choose", t3: "differ" });
  assert.equal(storedResult.meanings.slots.g1, "why");
  assert.equal(storedResult.meanings.drafts.d1, "todo");
  // Reads carry them on the items again, picks included.
  const read = (await call("GET", `/v1/brainstorms/${brainstorm.id}`)).json().data;
  assert.equal(read.picks.tensions[1].kind, "choose");
  assert.equal(read.picks.groups[0].slot, "why");
  assert.equal(read.result.drafts[0].kind, "todo");
  const saved = (
    await call("POST", `/v1/brainstorms/${brainstorm.id}/save`, { clientId: "save-g1b" })
  ).json().data;
  const card = saved.cards[0];
  assert.equal(card.kind, "todo");
  assert.equal(card.type, "idea");
  // idea slots are claim / why: only the group about reasons fills one.
  assert.deepEqual(
    card.slots.map((s: { key: string; text: string }) => [s.key, s.text]),
    [["why", "为什么：都说先懂概念再做题"]],
  );
  // 要核实 / 要决定 by kind; a mere difference of angle is left out.
  assert.deepEqual(
    card.open.map((o: { cat: string; text: string; answer?: string }) => [o.cat, o.text, o.answer]),
    [
      ["verify", "定义到底考不考", "「c1标题」对"],
      ["decide", "先刷题还是先整理", "选「c4标题」"],
    ],
  );

  // A method conclusion takes the steps group; a kind chosen wins.
  const other = await ready(call, ["c1", "c2", "c3"], "g1b-other");
  await call("PUT", `/v1/brainstorms/${other.id}/picks`, {
    conclusion: { text: "先查表", type: "idea", kind: "todo" },
  });
  assert.equal(
    (await call("GET", `/v1/brainstorms/${other.id}`)).json().data.picks.conclusion.kind,
    "todo",
  );
  const otherPicks = () =>
    JSON.parse(
      (f.store.db.prepare("SELECT picks FROM brainstorms WHERE id=?").get(other.id) as { picks: string }).picks,
    );
  // The kind is kept beside the conclusion, not in it.
  assert.equal(otherPicks().conclusionKind, "todo");
  assert.ok(!("kind" in otherPicks().conclusion));
  // An old client (through a v4.1 server) changed the type and left the kind
  // beside it: the stale kind no longer counts.
  f.store.db
    .prepare("UPDATE brainstorms SET picks=? WHERE id=?")
    .run(JSON.stringify({ ...otherPicks(), conclusion: { text: "先查表", type: "method" } }), other.id);
  const reread = (await call("GET", `/v1/brainstorms/${other.id}`)).json().data;
  assert.equal(reread.picks.conclusion.kind, undefined);
  assert.equal(reread.picks.conclusionKind, undefined);
  await call("PUT", `/v1/brainstorms/${other.id}/picks`, {
    conclusion: { text: "先查表", type: "method", kind: "method" },
  });
  assert.equal(
    (await call("GET", `/v1/brainstorms/${other.id}`)).json().data.picks.conclusion.kind,
    "method",
  );
  const method = (
    await call("POST", `/v1/brainstorms/${other.id}/save`, { clientId: "save-g1b-2" })
  ).json().data.cards[0];
  assert.equal(method.kind, "method");
  assert.deepEqual(
    method.slots.map((s: { key: string }) => s.key),
    ["steps"],
  );
  // A clear short sentence is enough, and it is the user's own words.
  assert.equal(method.mine, "先查表");
  assert.equal(method.titleBy, "user");
});

test("meanings the model made up are dropped; results without them keep the old fill", async (t) => {
  const f = setup();
  t.after(() => f.app.close());
  const { call, owner } = await login(f);
  for (const id of ["c1", "c2", "c3", "c4"]) seed(f, owner, id, `${id}的内容`);
  f.state.result = {
    ...RESULT,
    groups: RESULT.groups.map((g) => ({ ...g, slot: "whatever" })),
    tensions: [{ ...RESULT.tensions[0], kind: "maybe" }],
    drafts: [{ ...RESULT.drafts[0], kind: "poem" }],
  };
  const brainstorm = await ready(call, ["c1", "c2", "c3", "c4"]);
  assert.ok(brainstorm.result.groups.every((g: object) => !("slot" in g)));
  assert.ok(!("kind" in brainstorm.result.tensions[0]));
  assert.ok(!("kind" in brainstorm.result.drafts[0]));
  // Too short is still refused.
  await call("PUT", `/v1/brainstorms/${brainstorm.id}/picks`, {
    conclusion: { text: "好" },
  });
  const short = await call("POST", `/v1/brainstorms/${brainstorm.id}/save`, {
    clientId: "save-short",
  });
  assert.equal(short.statusCode, 400);
  assert.equal(short.json().code, "CONCLUSION_TOO_SHORT");
  await call("PUT", `/v1/brainstorms/${brainstorm.id}/picks`, {
    tensions: [{ ...brainstorm.result.tensions[0], choice: "a" }],
    conclusion: { text: "按章节整理错题" },
  });
  const card = (
    await call("POST", `/v1/brainstorms/${brainstorm.id}/save`, { clientId: "save-old" })
  ).json().data.cards[0];
  // Study scene default and the order-based fill, as before G1b.
  assert.equal(card.type, "method");
  assert.deepEqual(
    card.slots.map((s: { key: string }) => s.key),
    ["when", "steps"],
  );
  assert.deepEqual(
    card.open.map((o: { cat: string; answer: string }) => [o.cat, o.answer]),
    [["decide", "「c1标题」更对"]],
  );
});

test("a report goes stale when groups or differences change and can be written again", async (t) => {
  const f = setup();
  t.after(() => f.app.close());
  const { call, owner } = await login(f);
  for (const id of ["c1", "c2", "c3", "c4"]) seed(f, owner, id, `${id}的内容`);
  const brainstorm = await ready(call, ["c1", "c2", "c3", "c4"]);
  const firstId = "report-first-0001";
  await makeReport(call, brainstorm.id, { clientId: firstId });
  const detail = async () =>
    (await call("GET", `/v1/brainstorms/${brainstorm.id}`)).json().data;
  assert.equal((await detail()).report.stale, false);
  // Title, stances and the conclusion do not change what the report read.
  await call("PUT", `/v1/brainstorms/${brainstorm.id}/picks`, {
    title: "新标题",
    tensions: brainstorm.result.tensions.map((x: object) => ({ ...x, choice: "depends" })),
    conclusion: { text: "先按章节整理" },
  });
  assert.equal((await detail()).report.stale, false);
  // Moving a card to another group does.
  const groups = [
    { ...brainstorm.result.groups[0], cards: [1, 2, 3] },
    { ...brainstorm.result.groups[1], cards: [4] },
  ];
  await call("PUT", `/v1/brainstorms/${brainstorm.id}/picks`, { groups });
  const stale = await detail();
  assert.equal(stale.report.stale, true);
  // Old clients only ask when there is no report; without refresh nothing runs.
  const reportCalls = () => f.state.calls.filter((c) => c.kind === "report").length;
  const plain = await makeReport(call, brainstorm.id);
  assert.equal(plain.job, null);
  assert.equal(plain.report.stale, true);
  assert.equal(reportCalls(), 1);
  const fresh = await makeReport(call, brainstorm.id, { refresh: true });
  assert.ok(fresh.job);
  // The old report is still shown while the new one is written.
  assert.ok(fresh.report);
  assert.equal(reportCalls(), 2);
  assert.match(f.state.calls.at(-1)!.user, /"cards":\[1,2,3\]/);
  assert.equal((await detail()).report.stale, false);
  // A report that is not stale is not written again.
  assert.equal((await makeReport(call, brainstorm.id, { refresh: true })).job, null);
  assert.equal(reportCalls(), 2);
  // Stale again, and the page sends the clientId of the job that wrote the
  // first report: that finished job is not reused, a new report is written.
  await call("PUT", `/v1/brainstorms/${brainstorm.id}/picks`, {
    groups: [groups[0], { ...groups[1], common: "又改了一次" }],
  });
  assert.equal((await detail()).report.stale, true);
  const again = await makeReport(call, brainstorm.id, { clientId: firstId, refresh: true });
  assert.ok(again.job);
  assert.equal(reportCalls(), 3);
  assert.equal((await detail()).report.stale, false);
});

test("titles are cut by code point", async (t) => {
  const f = setup();
  t.after(() => f.app.close());
  const { call, owner } = await login(f);
  // 15 characters then an emoji: a UTF-16 cut at 16 splits the emoji.
  const text = "一二三四五六七八九十一二三四五😀后面还有";
  for (const id of ["c1", "c2", "c3"]) seed(f, owner, id, text, { title: "" });
  const brainstorm = await ready(call, ["c1", "c2", "c3"]);
  assert.equal(brainstorm.cards[0].title, "一二三四五六七八九十一二三四五😀");
  await call("PUT", `/v1/brainstorms/${brainstorm.id}/picks`, {
    conclusion: { text },
  });
  const saved = await call("POST", `/v1/brainstorms/${brainstorm.id}/save`, {
    clientId: "save-emoji",
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const card = saved.json().data.cards[0];
  // Card titles allow 16 UTF-16 units: the emoji is left out, not split.
  assert.equal(card.title, "一二三四五六七八九十一二三四五");
});
