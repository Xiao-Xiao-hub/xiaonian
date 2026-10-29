import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { AuthService } from "../server/src/modules/auth/service.js";
import { JobRunner } from "../server/src/modules/jobs/runner.js";
import { Jev } from "../server/src/providers/jev.js";
import {
  bindCallUser,
  currentCallContext,
  runWithCallContext,
} from "../server/src/shared/call-context.js";
import { SqliteStore } from "../server/src/shared/store.js";

const env = () =>
  loadEnv({
    NODE_ENV: "test",
    DEV_LOGIN_ENABLED: "true",
    DATABASE_PATH: ":memory:",
    LOG_LEVEL: "silent",
  });

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("parallel HTTP calls keep their authenticated users separate", async () => {
  const store = new SqliteStore(":memory:");
  const configuration = env();
  const auth = new AuthService(store, configuration);
  const first = auth.dev("context-one", "一号");
  const second = auth.dev("context-two", "二号");
  const app = buildApp({ store, env: configuration });
  const bothEntered = deferred<void>();
  let entered = 0;
  app.get("/_test/call-context", async (req) => {
    auth.require(req);
    if (++entered === 2) bothEntered.resolve();
    await bothEntered.promise;
    return currentCallContext();
  });
  try {
    const [one, two] = await Promise.all([
      app.inject({
        url: "/_test/call-context",
        headers: { authorization: `Bearer ${first.token}` },
      }),
      app.inject({
        url: "/_test/call-context",
        headers: { authorization: `Bearer ${second.token}` },
      }),
    ]);
    assert.deepEqual(one.json(), { userId: first.user.id, source: "http" });
    assert.deepEqual(two.json(), { userId: second.user.id, source: "http" });
  } finally {
    await app.close();
  }
});

test("job handlers and their commits retain the queued job owner", async () => {
  const store = new SqliteStore(":memory:");
  const one = store.upsertUser("context-job-one", "一号", "dev");
  const two = store.upsertUser("context-job-two", "二号", "dev");
  const bothStarted = deferred<void>();
  const release = deferred<void>();
  let started = 0;
  const seen: Array<{
    phase: string;
    context: Readonly<{ userId?: string; source: string }>;
  }> = [];
  const runner = new JobRunner(
    store,
    {
      context: {
        run: async () => {
          seen.push({ phase: "run", context: currentCallContext() });
          if (++started === 2) bothStarted.resolve();
          await release.promise;
          return { output: null };
        },
        commit: () => {
          seen.push({ phase: "commit", context: currentCallContext() });
          return null;
        },
      },
    },
    { concurrency: 2, timeoutMs: 5_000, limits: {} },
  );
  try {
    runner.enqueue({ userId: one.id, kind: "context" });
    runner.enqueue({
      userId: two.id,
      kind: "context",
      params: { second: true },
    });
    await bothStarted.promise;
    release.resolve();
    await runner.idle();
    assert.deepEqual(
      seen
        .map(({ phase, context }) => [phase, context.userId, context.source])
        .sort(),
      [
        ["commit", one.id, "job"],
        ["commit", two.id, "job"],
        ["run", one.id, "job"],
        ["run", two.id, "job"],
      ].sort(),
    );
  } finally {
    await runner.stop();
    store.close();
  }
});

test("Jev background queue snapshots the enqueuing user and defaults to system", async () => {
  const jev = new Jev({
    timeoutMs: 5_000,
    answer: async () => ({ answers: {} }),
  });
  const release = deferred<void>();
  const seen: Array<Readonly<{ userId?: string; source: string }>> = [];
  const first = runWithCallContext(
    { userId: "queue-one", source: "http" },
    () =>
      jev.background(async () => {
        seen.push(currentCallContext());
        await release.promise;
        return 1;
      }),
  );
  await new Promise<void>((done) => setImmediate(done));
  const second = runWithCallContext(
    { userId: "queue-two", source: "http" },
    () =>
      jev.background(async () => {
        seen.push(currentCallContext());
        return 2;
      }),
  );
  release.resolve();
  await Promise.all([first, second]);
  const system = await jev.background(async () => currentCallContext());
  assert.deepEqual(seen, [
    { userId: "queue-one", source: "http" },
    { userId: "queue-two", source: "http" },
  ]);
  assert.deepEqual(system, { source: "system" });
});

test("binding does not create ambient user state", () => {
  bindCallUser("must-not-leak");
  assert.deepEqual(currentCallContext(), { source: "system" });
});
