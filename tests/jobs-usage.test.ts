import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { AdminService } from "../server/src/modules/admin/service.js";
import { JobError, JobRunner } from "../server/src/modules/jobs/runner.js";

const usage = {
  provider: "synthetic.invalid",
  model: "synthetic-model",
  calls: 1,
  promptTokens: 30,
  completionTokens: 12,
  ms: 4,
};
const totals = { calls: 1, promptTokens: 30, completionTokens: 12 };
const options = { concurrency: 1, timeoutMs: 5000, limits: { notes: 10 } };
const adminFor = (store: SqliteStore, runner: JobRunner) =>
  new AdminService(store, runner, {
    limits: options.limits,
    uploadDir: "nonexistent-synthetic-usage-uploads",
  });

test("job usage survives a rolled-back commit without counting the same call twice", async () => {
  const store = new SqliteStore(":memory:"),
    userId = store.upsertUser("dev:usage", "测试", "dev").id;
  store.db.exec("CREATE TABLE synthetic_writes(value INTEGER)");
  let calls = 0;
  const runner = new JobRunner(
    store,
    {
      note_organize: {
        quota: "notes",
        run: async () => {
          calls++;
          return { output: { privateText: "synthetic output" }, usage };
        },
        commit: () => {
          store.db.exec("INSERT INTO synthetic_writes VALUES(1)");
          throw Object.assign(new JobError("NOTE_CHANGED", "随心记已更新"), {
            usage,
          });
        },
      },
    },
    options,
  );
  try {
    const { job } = runner.enqueue({ userId, kind: "note_organize" });
    await runner.idle();
    const saved = runner.get(job.id)!;
    assert.equal(saved.status, "failed");
    assert.equal(saved.error?.code, "NOTE_CHANGED");
    assert.equal(saved.result, null);
    assert.deepEqual(saved.usage, usage);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM synthetic_writes").get()?.n,
      0,
    );
    // a failed or unknown job is not charged.
    assert.equal(runner.usedToday(userId, "notes"), 0);
    const admin = adminFor(store, runner);
    assert.deepEqual(admin.usage().llm, totals);
    runner.recover();
    await runner.idle();
    assert.deepEqual(admin.usage().llm, totals);
    assert.equal(calls, 1);
  } finally {
    await runner.stop();
    store.close();
  }
});

test("job usage comes from a completed run even when commit has no usage metadata", async () => {
  const store = new SqliteStore(":memory:"),
    userId = store.upsertUser("dev:usage", "测试", "dev").id;
  const runner = new JobRunner(
    store,
    {
      note_organize: {
        quota: "notes",
        run: async () => ({ output: null, usage }),
        commit: () => {
          throw new JobError("NOTE_CHANGED", "随心记已更新");
        },
      },
    },
    options,
  );
  try {
    const { job } = runner.enqueue({ userId, kind: "note_organize" });
    await runner.idle();
    assert.deepEqual(runner.get(job.id)?.usage, usage);
    assert.deepEqual(adminFor(store, runner).usage().llm, totals);
  } finally {
    await runner.stop();
    store.close();
  }
});

test("job usage still records provider-reported calls when run itself fails", async () => {
  const store = new SqliteStore(":memory:"),
    userId = store.upsertUser("dev:usage", "测试", "dev").id;
  const runner = new JobRunner(
    store,
    {
      note_organize: {
        quota: "notes",
        run: async () => {
          throw Object.assign(
            new JobError("AI_TIMEOUT", "结果未知", "unknown"),
            {
              usage: [usage, usage],
            },
          );
        },
      },
    },
    options,
  );
  try {
    const { job } = runner.enqueue({ userId, kind: "note_organize" });
    await runner.idle();
    assert.equal(runner.get(job.id)?.status, "unknown");
    assert.deepEqual(runner.get(job.id)?.usage, [usage, usage]);
    assert.deepEqual(adminFor(store, runner).usage().llm, {
      calls: 2,
      promptTokens: 60,
      completionTokens: 24,
    });
    // a failed or unknown job is not charged.
    assert.equal(runner.usedToday(userId, "notes"), 0);
  } finally {
    await runner.stop();
    store.close();
  }
});

test("late success and failure never recreate erased users or their job receipts", async () => {
  for (const fail of [false, true]) {
    const store = new SqliteStore(":memory:"),
      userId = store.upsertUser("dev:usage", "测试", "dev").id;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let commits = 0;
    const runner = new JobRunner(
      store,
      {
        note_organize: {
          quota: "notes",
          run: async () => {
            await gate;
            if (fail)
              throw Object.assign(
                new JobError("AI_TIMEOUT", "结果未知", "unknown"),
                { usage },
              );
            return {
              output: { privateText: "deleted synthetic output" },
              usage,
            };
          },
          commit: () => {
            commits++;
          },
        },
      },
      options,
    );
    try {
      const { job } = runner.enqueue({ userId, kind: "note_organize" });
      store.db.prepare("DELETE FROM users WHERE id=?").run(userId);
      release();
      await runner.idle();
      assert.equal(store.getUser(userId), undefined);
      assert.equal(runner.get(job.id), undefined);
      assert.equal(commits, 0);
      assert.deepEqual(adminFor(store, runner).usage().llm, {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
      });
    } finally {
      release();
      await runner.stop();
      store.close();
    }
  }
});
