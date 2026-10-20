import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { loadEnv } from "../server/src/config/env.js";
import { JobRunner, publicJob, type JobHandler } from "../server/src/modules/jobs/runner.js";
import { ProviderError } from "../server/src/providers/llm.js";

const hold = () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
};

test("handler timeout overrides the runner default and missing timeout uses it", async (t) => {
  const store = new SqliteStore(":memory:");
  const userId = store.upsertUser("dev:v2-timeout", "测试", "dev").id;
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, "timeout", (timeoutMs: number) => {
    timeouts.push(timeoutMs);
    const controller = new AbortController();
    queueMicrotask(() => controller.abort());
    return controller.signal;
  });
  const waitForAbort = async (_job: unknown, signal: AbortSignal) =>
    new Promise<never>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  const handlers: Record<string, JobHandler> = {
    custom: { timeoutMs: () => 10, run: waitForAbort },
    default: { run: waitForAbort },
  };
  const runner = new JobRunner(store, handlers, {
    concurrency: 1,
    timeoutMs: 60,
    limits: {},
  });
  try {
    const custom = runner.enqueue({ userId, kind: "custom" }).job;
    await runner.idle();
    assert.deepEqual(runner.get(custom.id)?.error, {
      code: "TIMEOUT",
      message: "这次想得有点久，没跑完，可以再试一次",
    });
    const fallback = runner.enqueue({ userId, kind: "default" }).job;
    await runner.idle();
    assert.equal(runner.get(fallback.id)?.error?.code, "TIMEOUT");
    assert.deepEqual(timeouts, [10, 60]);
  } finally {
    await runner.stop();
    store.close();
  }
});

test("job concurrency defaults to four", () => {
  assert.equal(loadEnv({ NODE_ENV: "test" }).JOB_CONCURRENCY, 4);
});

test("only one PDF scan runs while other jobs use remaining concurrency", async () => {
  const store = new SqliteStore(":memory:");
  const userId = store.upsertUser("dev:v2-scan", "测试", "dev").id;
  const scanOne = hold();
  const scanTwo = hold();
  const other = hold();
  const started: string[] = [];
  const runner = new JobRunner(
    store,
    {
      import_scan_pdf: {
        run: async (job) => {
          started.push(String(job.params.name));
          await (job.params.name === "scan-one" ? scanOne.wait : scanTwo.wait);
          return { output: null };
        },
      },
      other: {
        run: async () => {
          started.push("other");
          await other.wait;
          return { output: null };
        },
      },
    },
    { concurrency: 2, timeoutMs: 5000, limits: {} },
  );
  try {
    runner.enqueue({ userId, kind: "import_scan_pdf", params: { name: "scan-one" } });
    runner.enqueue({ userId, kind: "import_scan_pdf", params: { name: "scan-two" } });
    runner.enqueue({ userId, kind: "other" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ["scan-one", "other"]);
    other.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ["scan-one", "other"]);
    scanOne.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ["scan-one", "other", "scan-two"]);
    scanTwo.release();
    await runner.idle();
  } finally {
    scanOne.release();
    scanTwo.release();
    other.release();
    await runner.stop();
    store.close();
  }
});

test("recover marks a running job unknown without re-running it", async () => {
  const store = new SqliteStore(":memory:");
  const userId = store.upsertUser("dev:v2-recover", "测试", "dev").id;
  store.db
    .prepare(
      "INSERT INTO jobs(id,user_id,kind,params,params_hash,status,created_at) VALUES('running',?,'other','{}','running','running','2026-10-12T00:00:00.000Z')",
    )
    .run(userId);
  let runs = 0;
  const runner = new JobRunner(
    store,
    { other: { run: async () => ({ output: ++runs }) } },
    { concurrency: 1, timeoutMs: 5000, limits: {} },
  );
  try {
    runner.recover();
    await runner.idle();
    assert.equal(runs, 0);
    assert.equal(runner.get("running")?.status, "unknown");
    assert.equal(runner.get("running")?.error?.code, "INTERRUPTED");
  } finally {
    await runner.stop();
    store.close();
  }
});

test("job progress is visible while running, cleared on completion and never persisted", async () => {
  const store = new SqliteStore(":memory:");
  const userId = store.upsertUser("dev:progress", "合成", "dev").id;
  const pending = hold();
  const runner = new JobRunner(store, { brainstorm: {
    run: async (_job, _signal, report) => {
      report({ chars: 0, expect: 800, thinking: true });
      await pending.wait;
      report({ chars: 11, expect: 800 });
      return { output: { ok: true } };
    },
  } }, { concurrency: 1, timeoutMs: 5000, limits: {} });
  try {
    const { job } = runner.enqueue({ userId, kind: "brainstorm" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(publicJob(runner.get(job.id)!).progress, { chars: 0, expect: 800, thinking: true });
    assert.doesNotMatch(JSON.stringify(store.db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id)), /thinking|expect/);
    pending.release();
    await runner.idle();
    assert.equal(publicJob(runner.get(job.id)!).progress, undefined);
  } finally { pending.release(); await runner.stop(); store.close(); }
});

test("truncated output is a known failure and never committed as a partial result", async () => {
  const store = new SqliteStore(":memory:");
  const userId = store.upsertUser("dev:truncated", "合成", "dev").id;
  let committed = false;
  const runner = new JobRunner(store, { brainstorm: {
    run: async () => { throw new ProviderError("OUTPUT_TRUNCATED", "AI 返回的内容格式不对，请重试", "unknown"); },
    commit: () => { committed = true; },
  } }, { concurrency: 1, timeoutMs: 5000, limits: {} });
  try {
    const { job } = runner.enqueue({ userId, kind: "brainstorm" });
    await runner.idle();
    assert.equal(runner.get(job.id)!.status, "failed");
    assert.equal(runner.get(job.id)!.error!.code, "OUTPUT_TRUNCATED");
    assert.equal(runner.get(job.id)!.result, null);
    assert.equal(committed, false);
  } finally { await runner.stop(); store.close(); }
});
