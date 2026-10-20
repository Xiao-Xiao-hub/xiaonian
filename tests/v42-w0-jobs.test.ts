// V4.2 W0: failed long jobs revert their import or brainstorm, cost nothing,
// and the same request starts a fresh job. Synthetic data only.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import {
  JobRunner,
  NOT_VOID,
  publicJob,
} from "../server/src/modules/jobs/runner.js";
import type { ImportFileTools } from "../server/src/modules/imports/parser.js";
import { DEFAULT_THINKING } from "../server/src/providers/model-router.js";
import { jobStreamMs, withJobDeadline } from "../server/src/shared/job-deadline.js";
import { SqliteStore } from "../server/src/shared/store.js";

const usage = { prompt_tokens: 3, completion_tokens: 2 };
const idea = {
  title: "把几张卡摆开",
  groups: [{ name: "共同", common: "都在整理复习", cards: [1, 2] }],
  tensions: [{ a: 1, b: 2, note: "先理解还是先练习" }],
  more: [{ type: "question", title: "怎样安排复习", from: [1] }],
  ifs: [{ if: "能找到共同卡点", from: [1, 2] }],
  directions: [{ title: "比较卡点", why: "两张卡都提到复习", from: [1, 2] }],
  drafts: [{ text: "先找共同卡点再安排练习", from: [1, 2] }],
  ask: { q: "先看哪一部分", options: ["共同点", "矛盾"] },
};
type Step = "ok" | "fail" | "hang" | "hold";
// Each model kind answers by the next step in its list ("ok" once empty).
function fake(plan: Partial<Record<"split" | "vision" | "brainstorm" | "report", Step[]>>) {
  const calls: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
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
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      const q = body.questions.q;
      return new Response(
        JSON.stringify({
          answers: {
            q:
              q.type === "noul"
                ? { noul: 0 }
                : { choice: "none", confidence: 0.9, probabilities: { none: 0.9 } },
          },
        }),
      );
    }
    const system = String(body.messages[0].content);
    const kind = system.includes("[IMPORT_SPLIT]")
      ? "split"
      : system.includes("[BRAINSTORM_REPORT]")
        ? "report"
        : system.includes("[BRAINSTORM]")
          ? "brainstorm"
          : "vision";
    calls.push(kind);
    const step = plan[kind]?.shift() ?? "ok";
    if (step === "fail") return new Response("busy", { status: 503 });
    if (step === "hold") await held;
    if (step === "hang")
      await new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), {
          once: true,
        }),
      );
    if (kind === "split")
      return sse(
        JSON.stringify({
          cards: [
            {
              type: "idea",
              scene: "study",
              title: "极限定义",
              summary: "整理极限定义",
              src: [1],
              tags: [],
            },
          ],
        }),
      );
    if (kind === "brainstorm") return sse(JSON.stringify(idea));
    const content =
      kind === "report"
        ? {
            sections: {
              links: [{ text: "两张卡都在说复习", from: [1] }],
              improve: [],
              expand: [],
              advice: [],
            },
          }
        : { paragraphs: ["照片里认出来的一段正文"] };
    // The report is streamed since V4.2 G1b.
    if (body.stream) return sse(JSON.stringify(content));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage }),
    );
  }) as typeof fetch;
  return { fetcher, calls, release };
}
const tools: ImportFileTools = {
  readDocx: async () => "Word 文件里的正文内容",
  readPdf: async () => ({ totalPages: 1, pages: [] }),
  rasterizePdfPage: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
};
function setup(
  plan: Parameters<typeof fake>[0] = {},
  env: Record<string, string> = {},
  store = new SqliteStore(":memory:"),
) {
  const uploads = mkdtempSync(join(tmpdir(), "zhiye-w0-"));
  const f = fake(plan);
  const app = buildApp({
    store,
    importTools: tools,
    fetcher: f.fetcher,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: uploads,
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-w0-formula-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "fake",
      JEV_API_KEY: "fake",
      OCR_VISION_MODEL: "fake-vision",
      DAILY_OCR_LIMIT: "20",
      DAILY_IMPORT_LIMIT: "10",
      DAILY_BRAINSTORM_LIMIT: "10",
      JOB_CONCURRENCY: "1",
      ...env,
    }),
  });
  return { app, store, uploads, ...f };
}
async function session(app: ReturnType<typeof buildApp>, key = "w0-owner") {
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: { key },
  });
  const token = login.json().data.token as string;
  return (
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      payload: payload as string,
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
}
type Call = Awaited<ReturnType<typeof session>>;
async function settle(call: Call, jobId: string) {
  for (let i = 0; i < 400; i++) {
    const job = (await call("GET", `/v1/jobs/${jobId}`)).json().data;
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("job did not settle");
}
const charged = (store: SqliteStore, kind: string) =>
  Number(
    store.db
      .prepare(`SELECT COUNT(*) n FROM quota_receipts r WHERE kind=? AND ${NOT_VOID}`)
      .get(kind)!.n,
  );
function multipart(data: Buffer, filename: string) {
  const boundary = "----zhiye-w0-boundary";
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
function cards(store: SqliteStore, owner: string, ids: string[]) {
  const at = "2026-10-12T01:00:00.000Z";
  for (const id of ids)
    store.db
      .prepare(
        `INSERT INTO cards(id,user_id,type,scene,title,title_by,mine,mine_at,quote,quote_on,origin,crisis,created_at,updated_at)
         VALUES(?,?,'idea','life',?,'user',?,?,?,date(?,'+8 hours'),'jot',0,?,?)`,
      )
      .run(id, owner, `${id}标题`, `${id}是我自己写下的一段完整内容`, at, `${id}原话`, at, at, at);
}
const ownerId = (store: SqliteStore, key = "w0-owner") =>
  String(store.db.prepare("SELECT id FROM users WHERE openid=?").get(`dev:${key}`)!.id);

test("a failed split goes back to read for free; the same retry runs a new job; a pending one is reused", async () => {
  // Two endpoints are configured in tests, so a failure is two answers.
  const f = setup({ split: ["fail", "fail", "hold"] });
  try {
    const call = await session(f.app);
    const created = (
      await call("POST", "/v1/imports", {
        clientId: "w0-paste",
        // paragraphs long enough not to be merged as a short tail.
        text: "极限的定义是这一节的重点，要能写出 ε-N 的说法。\n\n还要记住常用的几个重要极限，以及它们成立的条件。",
      })
    ).json().data.import;
    const first = (
      await call("POST", `/v1/imports/${created.id}/cards`, { clientId: "w0-split" })
    ).json().data.import;
    assert.equal(first?.status, "splitting", JSON.stringify(f.calls));
    const failed = await settle(call, first.job.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "AI_UNAVAILABLE");
    assert.equal(failed.error.message, "这会儿有点忙，过一会儿再试一次");
    const back = (await call("GET", `/v1/imports/${created.id}`)).json().data;
    assert.equal(back.status, "read");
    assert.equal(back.job, null);
    assert.equal(back.segments.length, 2, "the text read stays");
    assert.equal(back.failedJob.id, first.job.id);
    assert.equal(back.failedJob.error.code, "AI_UNAVAILABLE");
    assert.equal(charged(f.store, "import_cards"), 0, "a failure is free");

    const again = (
      await call("POST", `/v1/imports/${created.id}/cards`, { clientId: "w0-split" })
    ).json().data.import;
    assert.notEqual(again.job.id, first.job.id);
    assert.equal(again.failedJob, null);
    // While it runs, the same request returns the same job.
    const replay = (
      await call("POST", `/v1/imports/${created.id}/cards`, { clientId: "w0-split" })
    ).json().data.import;
    assert.equal(replay.job.id, again.job.id);
    f.release();
    assert.equal((await settle(call, again.job.id)).status, "succeeded");
    const picked = (await call("GET", `/v1/imports/${created.id}`)).json().data;
    assert.equal(picked.status, "picking");
    assert.equal(charged(f.store, "import_cards"), 1);
  } finally {
    f.release();
    await f.app.close();
  }
});

test("a split reports its stage and batch while it runs", async () => {
  const f = setup({ split: ["hold"] });
  try {
    const call = await session(f.app);
    const created = (
      await call("POST", "/v1/imports", { clientId: "w0-stage", text: "一段要拆成卡的文字。" })
    ).json().data.import;
    const job = (
      await call("POST", `/v1/imports/${created.id}/cards`, { clientId: "w0-stage" })
    ).json().data.import.job;
    let progress: Record<string, unknown> | undefined;
    for (let i = 0; i < 200 && !progress; i++) {
      progress = (await call("GET", `/v1/jobs/${job.id}`)).json().data.progress;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.deepEqual(
      { stage: progress!.stage, step: progress!.step, steps: progress!.steps },
      { stage: "split", step: 1, steps: 1 },
    );
    f.release();
    await settle(call, job.id);
  } finally {
    f.release();
    await f.app.close();
  }
});

test("a brainstorm stream inside a 300 s job is capped by the job, not 240 s; its timeout reverts, frees and retries", async (t) => {
  const real = AbortSignal.timeout.bind(AbortSignal);
  const asked: number[] = [];
  let expire = true;
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    asked.push(ms);
    // Only the stream cap of the 300 s brainstorm job expires at once.
    if (expire && ms > 240_000 && ms < 300_000) {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("cap", "TimeoutError")), 5);
      return controller.signal;
    }
    return real(ms);
  });
  const f = setup({ brainstorm: ["hang"] }, { DAILY_BRAINSTORM_LIMIT: "1" });
  try {
    const call = await session(f.app);
    const owner = ownerId(f.store);
    cards(f.store, owner, ["c1", "c2", "c3"]);
    const start = () =>
      call("POST", "/v1/brainstorms", { clientId: "w0-brain", cardIds: ["c1", "c2", "c3"] });
    const first = (await start()).json().data.brainstorm;
    assert.equal(first.status, "running");
    const ended = await settle(call, first.jobId);
    assert.equal(ended.status, "unknown");
    assert.equal(ended.error.code, "AI_TIMEOUT");
    assert.equal(ended.error.message, "这次想得有点久，没跑完，可以再试一次");
    assert.ok(asked.includes(300_000), "the job itself has 300 s");
    const cap = asked.find((ms) => ms > 240_000 && ms < 300_000);
    assert.ok(cap && cap >= 290_000, `stream cap follows the job: ${cap}`);
    const back = (await call("GET", `/v1/brainstorms/${first.id}`)).json().data;
    assert.equal(back.status, "picked");
    assert.equal(back.job.status, "unknown", "the failed job stays visible");
    // Free: the limit of one still lets the retry through.
    assert.equal(charged(f.store, "brainstorm"), 0);
    const open = (await call("GET", "/v1/brainstorms?open=1")).json().data.items;
    assert.deepEqual(
      open.map((item: { id: string; status: string }) => [item.id, item.status]),
      [[first.id, "picked"]],
    );
    expire = false;
    const retried = (await start()).json().data.brainstorm;
    assert.equal(retried.id, first.id);
    assert.notEqual(retried.jobId, first.jobId);
    assert.equal(retried.status, "running");
    const replay = (await start()).json().data.brainstorm;
    assert.equal(replay.jobId, retried.jobId, "a running job is returned, not doubled");
    assert.equal((await settle(call, retried.jobId)).status, "succeeded");
    assert.equal(
      (await call("GET", `/v1/brainstorms/${first.id}`)).json().data.status,
      "ready",
    );
    assert.equal(charged(f.store, "brainstorm"), 1);
  } finally {
    await f.app.close();
  }
});

test("a failed report with the same clientId starts a new report job", async () => {
  const f = setup({ report: ["fail", "fail"] });
  try {
    const call = await session(f.app);
    cards(f.store, ownerId(f.store), ["c1", "c2", "c3"]);
    const made = (
      await call("POST", "/v1/brainstorms", { clientId: "w0-r", cardIds: ["c1", "c2", "c3"] })
    ).json().data.brainstorm;
    await settle(call, made.jobId);
    const ask = () =>
      call("POST", `/v1/brainstorms/${made.id}/report`, { clientId: "report-w0-1" });
    const first = (await ask()).json().data.job;
    const failed = await settle(call, first.id);
    assert.equal(failed.status, "failed", JSON.stringify(f.calls));
    const second = (await ask()).json().data.job;
    assert.notEqual(second.id, first.id);
    assert.equal((await settle(call, second.id)).status, "succeeded");
    assert.ok((await call("GET", `/v1/brainstorms/${made.id}`)).json().data.report);
  } finally {
    await f.app.close();
  }
});

test("a timed-out photo read keeps the pages read, frees its pages and reads only the rest again", async (t) => {
  const real = AbortSignal.timeout.bind(AbortSignal);
  let expire = true;
  // import_read has 3 × 60 s + 30 s; that job timeout fires at once.
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    if (expire && ms === 210_000) {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("job", "TimeoutError")), 20);
      return controller.signal;
    }
    return real(ms);
  });
  const f = setup({ vision: ["ok", "hang"] });
  try {
    const call = await session(f.app);
    let latest: Record<string, any> = {};
    for (const index of [0, 1, 2]) {
      const part = multipart(jpeg(), `${index}.jpg`);
      const response = await call(
        "POST",
        `/v1/imports/photo?clientId=w0-photos&source=photo&index=${index}&count=3`,
        part.payload,
        part.headers,
      );
      assert.equal(response.statusCode, 200, response.body);
      latest = response.json().data.import;
    }
    const ended = await settle(call, latest.job.id);
    assert.equal(ended.status, "unknown");
    assert.equal(ended.error.code, "TIMEOUT");
    expire = false;
    const back = (await call("GET", `/v1/imports/${latest.id}`)).json().data;
    assert.equal(back.status, "reading");
    assert.equal(back.job, null);
    assert.equal(back.failedJob.error.code, "TIMEOUT");
    assert.deepEqual(back.pages.map((page: { ok: boolean }) => page.ok), [true, false, false]);
    assert.equal(back.segments.length, 1);
    assert.equal(back.retryPages, 2);
    assert.equal(charged(f.store, "import_read"), 0);
    const open = (await call("GET", "/v1/imports?open=1")).json().data.items;
    assert.equal(open.length, 1);
    assert.deepEqual(open[0].pages, { done: 1, total: 3 });
    assert.equal(open[0].job.status, "unknown");

    const retry = (await call("POST", `/v1/imports/${latest.id}/read`, { pages: 2 })).json().data
      .import;
    assert.notEqual(retry.job.id, latest.job.id);
    assert.equal((await settle(call, retry.job.id)).status, "succeeded");
    const done = (await call("GET", `/v1/imports/${latest.id}`)).json().data;
    assert.equal(done.status, "read");
    assert.deepEqual(done.pages.map((page: { ok: boolean }) => page.ok), [true, true, true]);
    assert.equal(charged(f.store, "import_read"), 2, "only the pages read again count");
    assert.equal(
      f.calls.filter((kind) => kind === "vision").length,
      4,
      "page 1 is not read again",
    );
    assert.equal(existsSync(join(f.uploads, ownerId(f.store), "imports", latest.id)), false);
  } finally {
    await f.app.close();
  }
});

test("a photo that failed inside a finished read can be read again from 'read'", async () => {
  const f = setup({ vision: ["ok", "fail"] });
  try {
    const call = await session(f.app);
    let latest: Record<string, any> = {};
    for (const index of [0, 1]) {
      const part = multipart(jpeg(), `${index}.jpg`);
      latest = (
        await call(
          "POST",
          `/v1/imports/photo?clientId=w0-partial&source=photo&index=${index}&count=2`,
          part.payload,
          part.headers,
        )
      ).json().data.import;
    }
    await settle(call, latest.job.id);
    const read = (await call("GET", `/v1/imports/${latest.id}`)).json().data;
    assert.equal(read.status, "read");
    assert.equal(read.retryPages, 1);
    const retry = (await call("POST", `/v1/imports/${latest.id}/read`, { pages: 1 })).json().data
      .import;
    assert.equal(retry.status, "reading");
    assert.equal((await settle(call, retry.job.id)).status, "succeeded");
    const done = (await call("GET", `/v1/imports/${latest.id}`)).json().data;
    assert.deepEqual(done.pages.map((page: { ok: boolean }) => page.ok), [true, true]);
    assert.equal(done.retryPages, 0);
  } finally {
    await f.app.close();
  }
});

test("abandon hides an unfinished import from the open list without deleting it", async () => {
  const f = setup();
  try {
    const call = await session(f.app);
    const created = (
      await call("POST", "/v1/imports", { clientId: "w0-left", text: "贴进来还没拆的一段文字。" })
    ).json().data.import;
    const open = (await call("GET", "/v1/imports?open=1")).json().data.items;
    assert.equal(open.length, 1);
    assert.equal(open[0].title, "贴进来还没拆的一段文字。");
    assert.equal(open[0].status, "read");
    const full = (await call("GET", "/v1/imports")).json().data.items;
    assert.ok(full[0].segments, "the list without ?open stays as before");
    const abandoned = (await call("POST", `/v1/imports/${created.id}/abandon`)).json().data.import;
    assert.equal(abandoned.status, "abandoned");
    assert.deepEqual((await call("GET", "/v1/imports?open=1")).json().data.items, []);
    assert.equal((await call("GET", `/v1/imports/${created.id}`)).statusCode, 200);
  } finally {
    await f.app.close();
  }
});

test("jobs interrupted by a restart revert their import and brainstorm and free their receipts", async () => {
  const store = new SqliteStore(":memory:");
  const owner = store.upsertUser("dev:w0-owner", "合成", "dev").id;
  const at = new Date().toISOString();
  const job = (id: string, kind: string, status: string, params: unknown) =>
    store.db
      .prepare(
        "INSERT INTO jobs(id,user_id,kind,params,params_hash,status,error_code,error_message,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        owner,
        kind,
        JSON.stringify(params),
        id,
        status,
        status === "running" ? null : "AI_BAD_OUTPUT",
        status === "running" ? null : "旧的说明",
        at,
      );
  const imp = (id: string, jobId: string) =>
    store.db
      .prepare(
        "INSERT INTO imports(id,user_id,source,own,segments,status,job_id,created_at,updated_at) VALUES(?,?,'paste',0,?,'splitting',?,?,?)",
      )
      .run(id, owner, JSON.stringify([{ n: 1, text: "一段原文" }]), jobId, at, at);
  job("job_run_split", "import_cards", "running", { importId: "imp_a" });
  imp("imp_a", "job_run_split");
  // Left behind by an older server: failed already, parent still splitting.
  job("job_old_split", "import_cards", "unknown", { importId: "imp_b" });
  imp("imp_b", "job_old_split");
  job("job_run_brain", "brainstorm", "running", { cards: [] });
  store.db
    .prepare(
      "INSERT INTO brainstorms(id,user_id,scene,size,cards,facts,status,job_id,created_at,updated_at) VALUES('brain_a',?,'life','small','[]','{}','running','job_run_brain',?,?)",
    )
    .run(owner, at, at);
  const f = setup({}, {}, store);
  try {
    const row = (sql: string) => store.db.prepare(sql).get() as Record<string, unknown>;
    assert.deepEqual(
      { ...row("SELECT status,job_id FROM imports WHERE id='imp_a'") },
      { status: "read", job_id: null },
    );
    assert.deepEqual(
      { ...row("SELECT status,job_id FROM imports WHERE id='imp_b'") },
      { status: "read", job_id: null },
    );
    assert.deepEqual(
      { ...row("SELECT status,job_id FROM brainstorms WHERE id='brain_a'") },
      { status: "picked", job_id: "job_run_brain" },
    );
    const interrupted = row("SELECT status,error_code,error_message FROM jobs WHERE id='job_run_split'");
    assert.equal(interrupted.status, "unknown");
    assert.equal(interrupted.error_code, "INTERRUPTED");
    assert.equal(interrupted.error_message, "这次没跑完，可以再试一次");
    assert.equal(charged(store, "import_cards"), 1, "only the older failure still counts");
    assert.equal(charged(store, "brainstorm"), 0);
  } finally {
    await f.app.close();
  }
});

test("void receipts (per-unit too) do not count; an admin retry counts them again", async () => {
  const store = new SqliteStore(":memory:");
  const userId = store.upsertUser("dev:w0-units", "合成", "dev").id;
  let fail = true;
  const runner = new JobRunner(
    store,
    {
      pages: {
        quota: "ocr",
        quotaUnits: (params) => Number(params.n),
        run: async () => {
          if (fail) throw new Error("synthetic");
          return { output: { ok: true } };
        },
      },
    },
    { concurrency: 1, timeoutMs: 5000, limits: { ocr: 3 } },
  );
  try {
    const first = runner.enqueue({ userId, kind: "pages", params: { n: 3 } }).job;
    await runner.idle();
    assert.equal(runner.get(first.id)?.status, "failed");
    assert.equal(runner.get(first.id)?.error?.message, "这次没跑完，可以再试一次");
    assert.equal(runner.usedToday(userId, "ocr"), 0);
    assert.equal(
      Number(store.db.prepare("SELECT COUNT(*) n FROM quota_voids WHERE job_id=?").get(first.id)!.n),
      3,
    );
    // The full limit is still there for a new job.
    const second = runner.enqueue({ userId, kind: "pages", params: { n: 3, again: 1 } }).job;
    await runner.idle();
    assert.equal(runner.get(second.id)?.status, "failed");
    store.db
      .prepare("UPDATE jobs SET error_code='AI_BUSY' WHERE id=?")
      .run(second.id);
    fail = false;
    runner.retry(second.id);
    await runner.idle();
    assert.equal(runner.get(second.id)?.status, "succeeded");
    assert.equal(runner.usedToday(userId, "ocr"), 3);
  } finally {
    await runner.stop();
    store.close();
  }
});

test("streams follow the job deadline inside a job and keep 240 s outside; brainstorm thinks at high", async () => {
  assert.equal(jobStreamMs(), undefined);
  const inside = withJobDeadline(Date.now() + 300_000, () => jobStreamMs());
  assert.ok(inside! > 290_000 && inside! <= 295_000, String(inside));
  assert.equal(withJobDeadline(Date.now() + 1000, () => jobStreamMs()), 1000);
  assert.equal(DEFAULT_THINKING.brainstorm, "high");
  // A stage is passed through publicJob untouched.
  assert.deepEqual(
    publicJob({
      id: "j",
      userId: "u",
      materialId: null,
      kind: "brainstorm",
      version: null,
      params: {},
      status: "running",
      result: null,
      error: null,
      usage: null,
      createdAt: "",
      startedAt: null,
      finishedAt: null,
      progress: { chars: 3, expect: 800, stage: "think" },
    }).progress,
    { chars: 3, expect: 800, stage: "think" },
  );
});
