import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { JobRunner } from "../server/src/modules/jobs/runner.js";
import { ProviderError } from "../server/src/providers/llm.js";
import { CommercialMeter } from "../server/src/shared/commercial-meter.js";
import { COST_SAFETY_TOTALS } from "../server/src/shared/cost-safety.js";
import { SqliteStore } from "../server/src/shared/store.js";

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
const REPORT = { sections: {
  links: [{ text: "前两张都在说先懂概念", from: [1, 2] }],
  improve: [], expand: [], advice: [{ text: "先挑一章试试", from: [] }],
} };

async function setup(failReport = false) {
  const store = new SqliteStore(":memory:");
  const calls: string[] = [];
  const fetcher = (async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      calls.push("jev");
      return new Response(JSON.stringify({ answers: { q: body.questions.q.type === "noul"
        ? { noul: 0 } : { choice: "idea", confidence: 0.9, probabilities: { idea: 0.9 } } } }));
    }
    const kind = String(body.messages[0].content).includes("[BRAINSTORM_REPORT]") ? "report" : "brainstorm";
    calls.push(kind);
    // A syntactically valid empty report is rejected by the real report handler.
    const content = JSON.stringify(kind === "report"
      ? (failReport ? { sections: { links: [], improve: [], expand: [], advice: [] } } : REPORT)
      : RESULT);
    const usage = { prompt_tokens: 5, completion_tokens: 4 };
    return body.stream
      ? new Response([
          `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}`,
          `data: ${JSON.stringify({ choices: [], usage })}`, "data: [DONE]", "",
        ].join("\n"), { headers: { "content-type": "text/event-stream" } })
      : new Response(JSON.stringify({ choices: [{ message: { content } }], usage }));
  }) as typeof fetch;
  const app = buildApp({ store, fetcher, env: loadEnv({
    NODE_ENV: "test", DEV_LOGIN_ENABLED: "true", DATABASE_PATH: ":memory:",
    UPLOAD_DIR: mkdtempSync(join(tmpdir(), "security-activity-")),
    FORMULA_DIR: mkdtempSync(join(tmpdir(), "security-activity-formula-")),
    LOG_LEVEL: "silent", LLM_API_KEY: "fake", JEV_API_KEY: "fake",
    DAILY_BRAINSTORM_LIMIT: "10", JOB_CONCURRENCY: "1", DAILY_SAFETY_CAP: "1",
  }) });
  const response = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "security-activity" } });
  assert.equal(response.statusCode, 200, response.body);
  const token = response.json().data.token;
  const owner = String(store.db.prepare("SELECT id FROM users WHERE openid=?").get("dev:security-activity")!.id);
  const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({
    method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}),
  });
  const at = new Date().toISOString();
  for (const id of ["c1", "c2", "c3", "c4"])
    store.db.prepare(`INSERT INTO cards(id,user_id,type,kind,scene,title,title_by,mine,mine_at,quote,quote_on,origin,created_at,updated_at)
      VALUES(?,?,'idea',NULL,'study',?,'user',?,?,?,date(?,'+8 hours'),'jot',?,?)`)
      .run(id, owner, `${id}标题`, `${id}的内容`, at, `${id}的内容`, at, at, at);
  const settle = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const response = await call("GET", `/v1/jobs/${id}`);
      assert.equal(response.statusCode, 200, response.body);
      const job = response.json().data;
      if (["succeeded", "failed", "unknown"].includes(job.status)) return job;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("job did not settle");
  };
  return { app, store, owner, calls, call, settle };
}

async function startBrainstorm(f: Awaited<ReturnType<typeof setup>>) {
  const response = await f.call("POST", "/v1/brainstorms", { clientId: "activity-parent", cardIds: ["c1", "c2", "c3", "c4"] });
  assert.equal(response.statusCode, 200, response.body);
  const brainstorm = response.json().data.brainstorm;
  assert.equal((await f.settle(brainstorm.jobId)).status, "succeeded");
  return brainstorm;
}

test("a real brainstorm and initial report share one safety activity while every provider call costs; refresh cannot reuse it", async t => {
  const f = await setup(); t.after(() => f.app.close());
  const brainstorm = await startBrainstorm(f);
  const response = await f.call("POST", `/v1/brainstorms/${brainstorm.id}/report`, { clientId: "first-report" });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await f.settle(response.json().data.job.id)).status, "succeeded");
  const rows = f.store.db.prepare("SELECT status,cost_microyuan,json_extract(price,'$.safetyActionId') activity FROM commercial_usage WHERE user_id=?").all(f.owner);
  assert.equal(rows.length, f.calls.length, "every underlying remote call is metered");
  assert.ok(f.calls.includes("brainstorm") && f.calls.includes("report"));
  assert.equal(new Set(rows.map(row => row.activity)).size, 1);
  assert.equal(rows[0]!.activity, `${brainstorm.jobId}:1`);
  assert.ok(rows.every(row => row.status === "succeeded" && Number(row.cost_microyuan) > 0));
  const spent = rows.reduce((sum, row) => sum + Number(row.cost_microyuan), 0);
  assert.equal(Object.values(f.store.setting<Record<string, number>>(COST_SAFETY_TOTALS)!).reduce((a, b) => a + b, 0), spent);
  const detail = (await f.call("GET", `/v1/brainstorms/${brainstorm.id}`)).json().data;
  const groups = detail.result.groups.map((group: { common: string }, i: number) => i ? group : { ...group, common: "新的共同点" });
  assert.equal((await f.call("PUT", `/v1/brainstorms/${brainstorm.id}/picks`, { groups })).statusCode, 200);
  const before = f.calls.length;
  const refresh = await f.call("POST", `/v1/brainstorms/${brainstorm.id}/report`, { clientId: "refresh-report", refresh: true });
  assert.equal(refresh.statusCode, 429, refresh.body);
  assert.equal(refresh.json().code, "DAILY_LIMIT");
  assert.equal(f.calls.length, before, "a refresh cannot get another remote call from its original activity");
});

test("an explicit new report after a failed first report cannot inherit the parent's spent activity", async t => {
  const f = await setup(true); t.after(() => f.app.close());
  const brainstorm = await startBrainstorm(f);
  const first = await f.call("POST", `/v1/brainstorms/${brainstorm.id}/report`, { clientId: "failed-report" });
  assert.equal(first.statusCode, 200, first.body);
  const firstId = first.json().data.job.id;
  assert.equal((await f.settle(firstId)).status, "failed");
  assert.equal(f.calls.filter(kind => kind === "report").length, 1);
  const before = f.calls.length;
  const retry = await f.call("POST", `/v1/brainstorms/${brainstorm.id}/report`, { clientId: "retry-report" });
  assert.equal(retry.statusCode, 200, retry.body);
  const nextId = retry.json().data.job.id;
  assert.notEqual(nextId, firstId);
  assert.equal((await f.settle(nextId)).status, "failed");
  assert.equal(f.calls.length, before, "the new report is rejected before another remote call");
  const params = JSON.parse(String(f.store.db.prepare("SELECT params FROM jobs WHERE id=?").get(nextId)!.params));
  assert.equal(params.continuationJobId, undefined);
  assert.equal(params._securityAttempt, 1);
});

test("administrative retry keeps the job ID but counts a new safety attempt before another remote call", async t => {
  const store = new SqliteStore(":memory:");
  const user = store.upsertUser("security-admin-retry", "Synthetic", "wechat");
  const events: Record<string, unknown>[] = [];
  const meter = new CommercialMeter(store, undefined, undefined, {
    dailySafetyCap: 1, logger: { warn: fields => { events.push(fields); } },
  });
  let calls = 0;
  const runner = new JobRunner(store, { synthetic: { run: async () => {
    await meter.run({ kind: "llm", provider: "safe.test", model: "test", source: "chat.study",
      upperUsage: { inputTokens: 10, outputTokens: 10 } }, async () => {
      calls++;
      throw new ProviderError("AI_UNAVAILABLE", "synthetic no-charge failure", "none");
    }, () => ({ inputTokens: 0, outputTokens: 0 }));
    return { output: null };
  } } }, { concurrency: 1, timeoutMs: 5000, limits: {} });
  t.after(async () => { await runner.stop(); store.close(); });
  const { job } = runner.enqueue({ userId: user.id, kind: "synthetic" });
  await runner.idle();
  assert.equal(runner.get(job.id)!.status, "failed");
  assert.equal(runner.get(job.id)!.error!.code, "AI_UNAVAILABLE");
  assert.equal(runner.get(job.id)!.params._securityAttempt, 1);
  runner.retry(job.id);
  await runner.idle();
  const retried = runner.get(job.id)!;
  assert.equal(retried.id, job.id);
  assert.equal(retried.status, "failed");
  assert.equal(retried.params._securityAttempt, 2);
  assert.equal(calls, 1, "retry is denied before dispatch even when the first attempt was unbilled");
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM commercial_usage WHERE user_id=?").get(user.id)!.n, 1);
  assert.ok(events.some(event => event.event === "cost_circuit_open" && event.reason === "user_attempt_cap"));
});
