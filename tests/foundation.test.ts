import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { MIGRATIONS, SqliteStore } from "../server/src/shared/store.js";
import {
  chinaDate,
  chinaDayStart,
  addDays,
} from "../server/src/shared/time.js";
import {
  JobError,
  JobRunner,
  type JobHandler,
} from "../server/src/modules/jobs/runner.js";
import { ChatModel, ProviderError } from "../server/src/providers/llm.js";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";

// Tests live outside server/, so resolve server dependencies from there.
const { z } = createRequire(new URL("../server/package.json", import.meta.url))(
  "zod",
) as typeof import("zod");
const tempDb = () => join(mkdtempSync(join(tmpdir(), "zhiye-")), "app.sqlite");
const schemaVersion = (db: DatabaseSync) =>
  (
    db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
      v: number;
    }
  ).v;

test("a fresh database is migrated to the latest schema", () => {
  const store = new SqliteStore(":memory:");
  try {
    assert.equal(schemaVersion(store.db), MIGRATIONS.length);
    for (const table of [
      "materials",
      "material_versions",
      "jobs",
      "artifacts",
      "attempts",
      "reviews",
      "review_logs",
      "reports",
      "cards",
      "card_versions",
      "card_links",
      "card_uses",
      "tags",
      "card_tags",
      "resume_items",
      "brainstorms",
      "imports",
      "retests",
    ])
      assert.ok(
        store.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table),
        table,
      );
  } finally {
    store.close();
  }
});

test("a v1 database with a user is upgraded in place and keeps the user", () => {
  const path = tempDb();
  const v1 = new DatabaseSync(path);
  v1.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
  );
  v1.exec(MIGRATIONS[0]!);
  v1.prepare("INSERT INTO schema_migrations VALUES(1,?)").run(
    new Date().toISOString(),
  );
  const user = {
    id: "usr_old",
    nickname: "旧用户",
    role: "user",
    openid: "openid-old-user",
    authMode: "wechat",
    createdAt: "2026-09-01T00:00:00.000Z",
  };
  v1.prepare("INSERT INTO users VALUES(?,?,?)").run(
    user.id,
    user.openid,
    JSON.stringify(user),
  );
  v1.close();
  const store = new SqliteStore(path);
  try {
    assert.equal(schemaVersion(store.db), MIGRATIONS.length);
    assert.deepEqual(store.getUser("usr_old"), user);
    // The commerce prototype's tables are gone.
    const tables = (
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[]
    ).map((t) => t.name);
    assert.ok(!tables.includes("orders") && !tables.includes("items"));
    store.db
      .prepare(
        "INSERT INTO materials(id,user_id,kind,title,status,created_at,updated_at) VALUES('m1','usr_old','note','t','draft','x','x')",
      )
      .run();
  } finally {
    store.close();
  }
  const reopened = new SqliteStore(path);
  assert.equal(schemaVersion(reopened.db), MIGRATIONS.length);
  reopened.close();
});

test("a database from a newer server is refused", () => {
  const path = tempDb();
  new SqliteStore(path).close();
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(
    MIGRATIONS.length + 1,
    "later",
  );
  db.close();
  assert.throws(() => new SqliteStore(path), /newer than this server/);
});

test("calendar days follow UTC+8 whatever the process time zone", () => {
  const lateUtc = Date.parse("2026-10-01T16:30:00Z"); // 00:30 on 10-02 in China
  assert.equal(chinaDate(lateUtc), "2026-10-02");
  assert.equal(chinaDayStart(lateUtc), "2026-10-01T16:00:00.000Z");
  assert.equal(addDays("2026-10-30", 4), "2026-11-03");
});

function seedUser(store: SqliteStore, openid = "dev:runner") {
  return store.upsertUser(openid, "测试", "dev").id;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("jobs dedupe identical requests, respect concurrency and store handler results", async () => {
  const store = new SqliteStore(":memory:");
  const userId = seedUser(store);
  let running = 0,
    peak = 0;
  const handler: JobHandler = {
    async run(job) {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { output: { echo: job.params.n }, usage: { calls: 1 } };
    },
    commit: (_job, output) => ({ saved: output }),
  };
  const runner = new JobRunner(
    store,
    { echo: handler },
    { concurrency: 2, timeoutMs: 5000, limits: {} },
  );
  try {
    const a = runner.enqueue({ userId, kind: "echo", params: { n: 1 } });
    const again = runner.enqueue({ userId, kind: "echo", params: { n: 1 } });
    assert.equal(again.reused, true);
    assert.equal(again.job.id, a.job.id);
    runner.enqueue({ userId, kind: "echo", params: { n: 2 } });
    const c = runner.enqueue({ userId, kind: "echo", params: { n: 3 } });
    assert.equal(runner.get(c.job.id)!.status, "queued");
    await runner.idle();
    assert.equal(peak, 2);
    assert.equal(runner.get(c.job.id)!.status, "succeeded");
    const done = runner.get(a.job.id)!;
    assert.equal(done.status, "succeeded");
    assert.deepEqual(done.result, { saved: { echo: 1 } });
    assert.deepEqual(done.usage, { calls: 1 });
    assert.equal(
      runner.enqueue({ userId, kind: "echo", params: { n: 1 } }).reused,
      true,
    );
    assert.equal(
      runner.enqueue({ userId, kind: "echo", params: { n: 1 }, refresh: true })
        .reused,
      false,
    );
    await runner.idle();
  } finally {
    await runner.stop();
    store.close();
  }
});

test("job failures keep a user-facing reason and unknown billing is never reported as a plain failure", async () => {
  const store = new SqliteStore(":memory:");
  const userId = seedUser(store);
  const runner = new JobRunner(
    store,
    {
      refuse: {
        run: async () => {
          throw new JobError("TOO_VAGUE", "题目条件不完整");
        },
      },
      timeout: {
        run: async () => {
          throw new ProviderError("AI_TIMEOUT", "AI 生成超时", "unknown");
        },
      },
      crash: {
        run: async () => {
          throw new TypeError("secret internal detail");
        },
      },
    },
    { concurrency: 3, timeoutMs: 5000, limits: {}, log: () => {} },
  );
  try {
    const ids = ["refuse", "timeout", "crash"].map(
      (kind) => runner.enqueue({ userId, kind }).job.id,
    );
    await runner.idle();
    const [refuse, timeout, crash] = ids.map((id) => runner.get(id)!);
    assert.equal(refuse!.status, "failed");
    assert.deepEqual(refuse!.error, {
      code: "TOO_VAGUE",
      message: "题目条件不完整",
    });
    assert.equal(timeout!.status, "unknown");
    assert.equal(crash!.status, "failed");
    assert.equal(crash!.error!.code, "JOB_FAILED");
    assert.doesNotMatch(crash!.error!.message, /secret/);
    // A failed job is not reused: retrying creates a new attempt.
    assert.equal(runner.enqueue({ userId, kind: "refuse" }).reused, false);
    await runner.idle();
  } finally {
    await runner.stop();
    store.close();
  }
});

test("after a restart running jobs become unknown and queued jobs resume", async () => {
  const path = tempDb();
  const store = new SqliteStore(path);
  const userId = seedUser(store);
  const insert = store.db.prepare(
    "INSERT INTO jobs(id,user_id,kind,params,params_hash,status,created_at) VALUES(?,?,?,?,?,?,?)",
  );
  insert.run(
    "job_running",
    userId,
    "echo",
    "{}",
    "h1",
    "running",
    new Date().toISOString(),
  );
  insert.run(
    "job_queued",
    userId,
    "echo",
    "{}",
    "h2",
    "queued",
    new Date().toISOString(),
  );
  store.close();
  const reopened = new SqliteStore(path);
  let calls = 0;
  const runner = new JobRunner(
    reopened,
    { echo: { run: async () => ({ output: ++calls }) } },
    { concurrency: 1, timeoutMs: 5000, limits: {} },
  );
  try {
    runner.recover();
    await runner.idle();
    assert.equal(runner.get("job_running")!.status, "unknown");
    assert.equal(runner.get("job_running")!.error!.code, "INTERRUPTED");
    assert.equal(runner.get("job_queued")!.status, "succeeded");
    assert.equal(calls, 1);
  } finally {
    await runner.stop();
    reopened.close();
  }
});

test("daily quota counts new jobs only and deleted materials do not break a running job", async () => {
  const store = new SqliteStore(":memory:");
  const userId = seedUser(store);
  const now = new Date().toISOString();
  store.db
    .prepare(
      "INSERT INTO materials(id,user_id,kind,title,status,current_version,created_at,updated_at) VALUES('m1',?,'note','t','confirmed',1,?,?)",
    )
    .run(userId, now, now);
  const gate = deferred();
  const runner = new JobRunner(
    store,
    {
      explain: {
        quota: "ai",
        run: async () => {
          await gate.promise;
          return { output: 1 };
        },
      },
    },
    { concurrency: 1, timeoutMs: 5000, limits: { ai: 2 } },
  );
  try {
    const first = runner.enqueue({
      userId,
      kind: "explain",
      materialId: "m1",
      version: 1,
    });
    runner.enqueue({ userId, kind: "explain", materialId: "m1", version: 1 }); // reused, not counted
    runner.enqueue({
      userId,
      kind: "explain",
      materialId: "m1",
      version: 1,
      params: { q: 2 },
    });
    assert.equal(runner.usedToday(userId, "ai"), 2);
    assert.throws(
      () =>
        runner.enqueue({
          userId,
          kind: "explain",
          materialId: "m1",
          version: 1,
          params: { q: 3 },
        }),
      (error: { code?: string }) => error.code === "DAILY_LIMIT",
    );
    store.db.prepare("DELETE FROM materials WHERE id='m1'").run();
    gate.resolve();
    await runner.idle();
    assert.equal(runner.get(first.job.id), undefined);
  } finally {
    await runner.stop();
    store.close();
  }
});

test("stopping the runner marks in-flight work unknown instead of losing it", async () => {
  const store = new SqliteStore(":memory:");
  const userId = seedUser(store);
  const runner = new JobRunner(
    store,
    {
      slow: {
        run: (_job, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          ),
      },
    },
    { concurrency: 1, timeoutMs: 5000, limits: {} },
  );
  const { job } = runner.enqueue({ userId, kind: "slow" });
  await runner.stop();
  assert.equal(runner.get(job.id)!.status, "unknown");
  assert.equal(runner.get(job.id)!.error!.code, "INTERRUPTED");
  store.close();
});

test("job status is visible to its owner only", async () => {
  const store = new SqliteStore(":memory:");
  const app = buildApp({
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      LOG_LEVEL: "silent",
    }),
    store,
  });
  try {
    const login = async (key: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/v1/auth/dev-login",
          payload: { key },
        })
      ).json().data;
    const owner = await login("owner");
    const other = await login("other");
    const now = new Date().toISOString();
    store.db
      .prepare(
        "INSERT INTO jobs(id,user_id,kind,params,params_hash,status,result,created_at,finished_at) VALUES('job_x',?,'echo','{}','h','succeeded','{\"ok\":true}',?,?)",
      )
      .run(owner.user.id, now, now);
    const mine = await app.inject({
      url: "/v1/jobs/job_x",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(mine.json().data.status, "succeeded");
    assert.deepEqual(mine.json().data.result, { ok: true });
    const theirs = await app.inject({
      url: "/v1/jobs/job_x",
      headers: { authorization: `Bearer ${other.token}` },
    });
    assert.equal(theirs.statusCode, 404);
  } finally {
    await app.close();
  }
});

const llmResponse = (content: string, status = 200) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status },
  );
const chat = (fetcher: typeof fetch, timeoutMs = 2000, apiKey = "test-key") =>
  new ChatModel(
    {
      baseUrl: "https://llm.example.test/v1",
      apiKey,
      model: "hy4-preview",
      extraBody: { reasoning_effort: "no_think" },
      timeoutMs,
    },
    fetcher,
  );
const Points = z.object({ points: z.array(z.string()).min(1) });

test("the chat model sends JSON-mode requests and validates the reply", async () => {
  const bodies: Record<string, unknown>[] = [];
  const headers: Headers[] = [];
  const model = chat((async (url, init) => {
    assert.equal(String(url), "https://llm.example.test/v1/chat/completions");
    bodies.push(JSON.parse(String(init!.body)));
    headers.push(new Headers(init!.headers));
    return llmResponse('```json\n{"points":["蒸发"]}\n```');
  }) as typeof fetch);
  const { data, usage } = await model.json(
    [{ role: "user", content: "hi" }],
    Points,
  );
  assert.deepEqual(data, { points: ["蒸发"] });
  assert.equal(bodies[0]!.model, "hy4-preview");
  assert.equal(bodies[0]!.reasoning_effort, "no_think");
  assert.deepEqual(bodies[0]!.response_format, { type: "json_object" });
  assert.equal(headers[0]!.get("authorization"), "Bearer test-key");
  assert.equal(usage.calls, 1);
  assert.equal(usage.promptTokens, 10);
});

test("the chat model retries once on unusable output, then reports it", async () => {
  let calls = 0;
  const fixed = chat((async () =>
    ++calls === 1
      ? llmResponse("not json")
      : llmResponse('{"points":["a"]}')) as typeof fetch);
  assert.deepEqual((await fixed.json([], Points)).data, { points: ["a"] });
  assert.equal(calls, 2);
  calls = 0;
  const broken = chat((async () => {
    calls++;
    return llmResponse('{"points":[]}');
  }) as typeof fetch);
  await assert.rejects(
    broken.json([], Points),
    (error: ProviderError) => error.code === "AI_BAD_OUTPUT",
  );
  assert.equal(calls, 2);
});

test("chat model failures map to clear codes and a timeout keeps billing unknown", async () => {
  let called = false;
  await assert.rejects(
    chat(
      (async () => {
        called = true;
        return llmResponse("{}");
      }) as typeof fetch,
      2000,
      "",
    ).json([], Points),
    (error: ProviderError) => error.code === "AI_NOT_CONFIGURED",
  );
  assert.equal(called, false);
  await assert.rejects(
    chat((async () => llmResponse("{}", 401)) as typeof fetch).json([], Points),
    (error: ProviderError) => error.code === "AI_AUTH",
  );
  await assert.rejects(
    chat((async () => llmResponse("{}", 429)) as typeof fetch).json([], Points),
    (error: ProviderError) => error.code === "AI_BUSY",
  );
  // A dropped connection may already have been billed; a refused one was not.
  await assert.rejects(
    chat((async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch).json([], Points),
    (error: ProviderError) =>
      error.code === "AI_UNAVAILABLE" && error.billing === "unknown",
  );
  const refused = () =>
    Object.assign(new TypeError("fetch failed"), {
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    });
  let tries = 0;
  await assert.rejects(
    chat((async () => {
      tries++;
      throw refused();
    }) as typeof fetch).json([], Points),
    (error: ProviderError) =>
      error.code === "AI_UNAVAILABLE" && error.billing === "none",
  );
  assert.equal(tries, 2);
  tries = 0;
  const flaky = chat((async () => {
    if (tries++ === 0) throw refused();
    return llmResponse('{"points":["a"]}');
  }) as typeof fetch);
  assert.deepEqual((await flaky.json([], Points)).data, { points: ["a"] });
  const hang = (async (_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) =>
      init!.signal!.addEventListener("abort", () =>
        reject(init!.signal!.reason),
      ),
    )) as typeof fetch;
  await assert.rejects(
    chat(hang, 20).json([], Points),
    (error: ProviderError) =>
      error.code === "AI_TIMEOUT" && error.billing === "unknown",
  );
  const controller = new AbortController();
  const pending = chat(hang, 5000).json([], Points, controller.signal);
  controller.abort(new Error("stopped"));
  await assert.rejects(pending, /stopped/);
});
