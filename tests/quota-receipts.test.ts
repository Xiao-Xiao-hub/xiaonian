import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { MIGRATIONS, SqliteStore } from "../server/src/shared/store.js";
import { chinaDayStart } from "../server/src/shared/time.js";
import { JobError, JobRunner } from "../server/src/modules/jobs/runner.js";

const KEY = "q".repeat(40);
const streamReply = () =>
  new Response(
    'data: {"choices":[{"delta":{"content":"A short synthetic reply."}}]}\n\ndata: {"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
  );
async function setup(
  fetcher?: typeof fetch,
  jobFailure = false,
  extraEnv: Record<string, string> = {},
) {
  const store = new SqliteStore(":memory:");
  const app = buildApp({
    store,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      LOG_LEVEL: "silent",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "quota-uploads-")),
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "quota-formulas-")),
      ADMIN_API_KEY: KEY,
      LLM_API_KEY: "synthetic",
      OCR_VISION_MODEL: "synthetic-vision",
      CHAT_DAILY_LIMIT: "1",
      PHOTO_DAILY_LIMIT: "1",
      DAILY_AI_LIMIT: "1",
      ...extraEnv,
    }),
    fetcher:
      fetcher ??
      ((async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.stream) return streamReply();
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    type: "problems",
                    problems: [{ text: "Explain a limit", unclear: "" }],
                    solution: null,
                    notes: "",
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 3 },
          }),
        );
      }) as typeof fetch),
    handlers: {
      explain: {
        quota: "ai",
        run: async () => {
          if (jobFailure)
            throw new JobError("SYNTHETIC_UNKNOWN", "unknown", "unknown");
          // an unpriced model at the highest rate, about ¥0.18.
          return {
            output: {},
            usage: { provider: "test", model: "test", promptTokens: 0, completionTokens: 1000 },
          };
        },
      },
    },
  });
  const login = (
    await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: {} })
  ).json().data;
  const auth = { authorization: `Bearer ${login.token}` };
  const call = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: object,
  ) => app.inject({ method, url, headers: auth, payload });
  const summary = async () =>
    (
      await app.inject({
        url: "/v1/admin/usage",
        headers: { "x-admin-key": KEY },
      })
    ).json().data;
  return { store, app, auth, call, summary, userId: login.user.id };
}
async function photo(
  app: Awaited<ReturnType<typeof setup>>["app"],
  auth: Record<string, string>,
) {
  const boundary = "synthetic-photo";
  return app.inject({
    method: "POST",
    url: "/v1/chat/scan",
    headers: {
      ...auth,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
        "hex",
      ),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}
const firstEvent = (body: string) =>
  JSON.parse(body.split("\n\n")[0]!.slice(6));

test("a multi-page OCR job reserves one receipt per page and retry or reuse does not charge again", async () => {
  const store = new SqliteStore(":memory:");
  const userId = store.upsertUser("dev:pages", "测试", "dev").id;
  let fail = true;
  const runner = new JobRunner(
    store,
    {
      import_scan_pdf: {
        quota: "ocr",
        quotaUnits: (params) => Number(params.pages),
        run: async () => {
          if (fail) throw new JobError("AI_UNAVAILABLE", "服务暂不可用");
          return { output: null };
        },
      },
    },
    { concurrency: 1, timeoutMs: 5000, limits: { ocr: 5 } },
  );
  try {
    const first = runner.enqueue({
      userId,
      kind: "import_scan_pdf",
      params: { pages: 5 },
    });
    await runner.idle();
    assert.equal(runner.get(first.job.id)?.status, "failed");
    // the failed job's five receipts stay but are voided, so they are free.
    assert.equal(runner.usedToday(userId, "ocr"), 0);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM quota_voids WHERE job_id=?").get(first.job.id)!.n,
      5,
    );
    assert.deepEqual(
      store.db
        .prepare("SELECT source_id FROM quota_receipts ORDER BY source_id")
        .all()
        .map((row) => String(row.source_id).replace(first.job.id, "job")),
      ["job", "job:p2", "job:p3", "job:p4", "job:p5"],
    );
    fail = false;
    runner.retry(first.job.id);
    await runner.idle();
    assert.equal(runner.get(first.job.id)?.status, "succeeded");
    assert.equal(runner.usedToday(userId, "ocr"), 5);
    assert.equal(
      runner.enqueue({
        userId,
        kind: "import_scan_pdf",
        params: { pages: 5 },
      }).reused,
      true,
    );
    assert.throws(
      () =>
        runner.enqueue({
          userId,
          kind: "import_scan_pdf",
          params: { pages: 1 },
        }),
      { code: "DAILY_LIMIT" },
    );
  } finally {
    await runner.stop();
    store.close();
  }
});

test("five-page OCR is rejected with three units remaining without creating a job or partial receipts", async () => {
  const store = new SqliteStore(":memory:");
  const userId = store.upsertUser("dev:page-limit", "测试", "dev").id;
  const runner = new JobRunner(store, {
    import_scan_pdf: {
      quota: "ocr",
      quotaUnits: (params) => Number(params.pages),
      run: async () => ({ output: null }),
    },
  }, { concurrency: 1, timeoutMs: 5000, limits: { ocr: 5 } });
  try {
    runner.enqueue({ userId, kind: "import_scan_pdf", params: { pages: 2 } });
    await runner.idle();
    assert.equal(runner.usedToday(userId, "ocr"), 2);
    assert.throws(() => runner.enqueue({
      userId, kind: "import_scan_pdf", params: { pages: 5 },
    }), { code: "DAILY_LIMIT" });
    assert.equal(runner.usedToday(userId, "ocr"), 2);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()!.n, 1);
    assert.throws(() => runner.checkQuota(userId, "ocr", 0), { code: "INVALID_QUOTA_UNITS" });
  } finally {
    await runner.stop();
    store.close();
  }
});

test("a failed page receipt rolls back the entire OCR enqueue", async () => {
  const store = new SqliteStore(":memory:");
  const userId = store.upsertUser("dev:page-rollback", "测试", "dev").id;
  let calls = 0;
  const runner = new JobRunner(store, {
    import_scan_pdf: {
      quota: "ocr", quotaUnits: () => 5,
      run: async () => { calls++; return { output: null }; },
    },
  }, { concurrency: 1, timeoutMs: 5000, limits: { ocr: 5 } });
  try {
    store.db.exec(`CREATE TEMP TRIGGER reject_third_page BEFORE INSERT ON quota_receipts
      WHEN NEW.source_id LIKE '%:p3' BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END;`);
    assert.throws(() => runner.enqueue({ userId, kind: "import_scan_pdf" }), /synthetic receipt failure/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()!.n, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM quota_receipts").get()!.n, 0);
    assert.equal(calls, 0);
  } finally {
    await runner.stop();
    store.close();
  }
});

test("deleting a conversation and its photo does not refund either daily allowance; erasing the account removes receipts", async () => {
  // the scan (≈ ¥0.0007) and the answer (≈ ¥0.0005) together cross ¥0.001.
  const { app, store, auth, call, summary } = await setup(undefined, false, {
    DAILY_BUDGET_CNY: "0.001",
  });
  try {
    const scan = await photo(app, auth);
    assert.equal(scan.statusCode, 200, scan.body);
    const sent = await call("POST", "/v1/chat/send", {
      text: "Explain a limit",
      imageId: scan.json().data.imageId,
      clientId: "quota-client-1",
    });
    assert.equal(sent.statusCode, 200, sent.body);
    const thread = firstEvent(sent.body).thread.id;
    assert.equal(
      (await call("DELETE", `/v1/chat/threads/${thread}`)).statusCode,
      200,
    );
    assert.equal(
      (await call("GET", `/v1/chat/images/${scan.json().data.imageId}`))
        .statusCode,
      404,
    );
    const usage = (await call("GET", "/v1/chat/usage")).json().data;
    assert.equal(usage.answers.used, 1);
    assert.equal(usage.photos.used, 1);
    const admin = await summary();
    for (const bucket of ["chat", "photos"])
      assert.equal(
        admin.buckets.find((row: { bucket: string }) => row.bucket === bucket)
          .jobs,
        1,
      );
    assert.equal(
      (
        await call("POST", "/v1/chat/send", {
          text: "Another question",
          clientId: "quota-client-2",
        })
      ).statusCode,
      429,
    );
    assert.equal((await photo(app, auth)).statusCode, 429);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM quota_receipts").get()!.n,
      2,
    );
    const exported = (await call("GET", "/v1/me/export")).json();
    assert.equal(
      exported.quotaUsage.reduce(
        (sum: number, row: { used: number }) => sum + row.used,
        0,
      ),
      2,
    );
    const ledgerBefore = store.db
      .prepare("SELECT COUNT(*) AS n FROM usage_ledger")
      .get()!.n;
    assert.equal(
      (await call("DELETE", "/v1/me", { confirm: true })).statusCode,
      200,
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM quota_receipts").get()!.n,
      0,
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM usage_ledger").get()!.n,
      ledgerBefore,
    );
  } finally {
    await app.close();
  }
});

for (const unknown of [false, true])
  test(`deleting a material keeps its successful job allowance consumed${unknown ? " (an unknown one is free)" : ""}`, async () => {
    // one finished explain (≈ ¥0.18) uses up a ¥0.1 day.
    const { app, call, summary } = await setup(undefined, unknown, {
      DAILY_BUDGET_CNY: "0.1",
    });
    try {
      const material = async () => {
        const made = await call("POST", "/v1/materials", {
          kind: "note",
          text: "Synthetic lesson notes",
        });
        const id = made.json().data.id;
        assert.equal(
          (
            await call("PUT", `/v1/materials/${id}`, {
              expectedVersion: 1,
              confirm: true,
            })
          ).statusCode,
          200,
        );
        return id;
      };
      const id = await material();
      assert.equal(
        (await call("POST", `/v1/materials/${id}/explain`)).statusCode,
        200,
      );
      assert.equal(
        (await call("DELETE", `/v1/materials/${id}`)).statusCode,
        200,
      );
      // an unknown job is voided when it ends, so it is free.
      const expected = unknown ? 0 : 1;
      for (let i = 0; i < 200; i++) {
        if ((await call("GET", "/v1/me/usage")).json().data.ai.used === expected) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal((await call("GET", "/v1/me/usage")).json().data.ai.used, expected);
      assert.equal(
        (await summary()).buckets.find(
          (row: { bucket: string }) => row.bucket === "ai",
        ).jobs,
        expected,
      );
      assert.equal(
        (await call("POST", `/v1/materials/${await material()}/explain`))
          .statusCode,
        unknown ? 200 : 429,
      );
    } finally {
      await app.close();
    }
  });

test("busy and interrupted chat/photo responses do not consume success-based allowances", async () => {
  for (const interrupted of [false, true]) {
    const { app, auth, call, store } = await setup((async () => {
      if (interrupted) throw new Error("synthetic network interrupted");
      return new Response("busy", { status: 429 });
    }) as typeof fetch);
    try {
      const sent = await call("POST", "/v1/chat/send", {
        text: "Question",
        clientId: "failed-quota-1",
      });
      assert.match(sent.body, /"e":"error"/);
      assert.equal((await photo(app, auth)).statusCode, 502);
      const usage = (await call("GET", "/v1/chat/usage")).json().data;
      assert.equal(usage.answers.used, 0);
      assert.equal(usage.photos.used, 0);
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS n FROM quota_receipts").get()!.n,
        0,
      );
    } finally {
      await app.close();
    }
  }
});

test("a late successful reply keeps its receipt after content deletion but cannot recreate an erased account", async () => {
  for (const erase of [false, true]) {
    let release!: (response: Response) => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { app, store, call } = await setup((async () => {
      reached();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }) as typeof fetch);
    try {
      const pending = call("POST", "/v1/chat/send", {
        text: "A synthetic concept question",
        clientId: "late-quota-1",
      }).then((result) => result);
      await waiting;
      const thread = store.db.prepare("SELECT id FROM threads LIMIT 1").get()!
        .id;
      assert.equal(
        (
          await call(
            "DELETE",
            erase ? "/v1/me" : `/v1/chat/threads/${thread}`,
            erase ? { confirm: true } : undefined,
          )
        ).statusCode,
        200,
      );
      release(streamReply());
      await pending;
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS n FROM quota_receipts").get()!.n,
        erase ? 0 : 1,
      );
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n,
        0,
      );
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS n FROM threads").get()!.n,
        0,
      );
    } finally {
      await app.close();
    }
  }
});

test("migration backfills existing charges once and preserves the original China-day attribution", async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "quota-migration-")),
    "app.sqlite",
  );
  const old = new DatabaseSync(path);
  old.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)",
  );
  for (let i = 0; i < 11; i++) {
    old.exec(MIGRATIONS[i]!);
    old
      .prepare("INSERT INTO schema_migrations VALUES(?,?)")
      .run(i + 1, new Date().toISOString());
  }
  const today = chinaDayStart();
  const yesterday = new Date(Date.parse(today) - 1).toISOString();
  old.exec("INSERT INTO users VALUES('usr_migrate','openid_migrate','{}')");
  old
    .prepare(
      "INSERT INTO threads(id,user_id,title,created_at,updated_at) VALUES('t','usr_migrate','private',?,?)",
    )
    .run(today, today);
  const message = old.prepare(
    "INSERT INTO messages(id,thread_id,user_id,role,kind,content,status,charged,created_at) VALUES(?,'t','usr_migrate','assistant','reply','private','done',?,?)",
  );
  message.run("today", 1, today);
  message.run("old", 1, yesterday);
  message.run("failed", 0, today);
  old.close();
  const store = new SqliteStore(path);
  try {
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM quota_receipts").get()!.n,
      2,
    );
    store.db.exec("UPDATE messages SET charged=1 WHERE id='today'");
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM quota_receipts").get()!.n,
      2,
    );
    store.db.exec("DELETE FROM threads");
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM quota_receipts WHERE created_at>=?")
        .get(today)!.n,
      1,
    );
    const text = JSON.stringify(
      store.db.prepare("SELECT * FROM quota_receipts").all(),
    );
    assert.ok(!text.includes("private"));
  } finally {
    store.close();
  }
  const reopened = new SqliteStore(path);
  assert.equal(
    reopened.db.prepare("SELECT COUNT(*) AS n FROM quota_receipts").get()!.n,
    2,
  );
  reopened.close();
});

test("one remaining answer cannot be consumed by concurrent conversations or practice, and failure releases the slot", async () => {
  for (const failFirst of [false, true]) {
    let release!: (response: Response) => void;
    let reached!: () => void;
    let sent = 0;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    // One endpoint, so a failed answer is not taken over by another.
    const { app, call, store } = await setup(
      (async () => {
        sent++;
        if (sent > 1) return streamReply();
        reached();
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }) as typeof fetch,
      false,
      // one answer (≈ ¥0.0005) uses up the day.
      { OCR_VISION_MODEL: "", DAILY_BUDGET_CNY: "0.0001" },
    );
    try {
      const first = call("POST", "/v1/chat/send", {
        text: "First concept",
        clientId: "concurrent-quota-1",
      }).then((res) => res);
      await waiting;
      const second = await call("POST", "/v1/chat/send", {
        text: "Another concept",
        clientId: "concurrent-quota-2",
      });
      assert.equal(second.statusCode, 409, second.body);
      assert.equal(second.json().code, "STILL_ANSWERING");
      const practice = await call("POST", "/v1/chat/practice", {
        chapter: "derivative",
      });
      assert.equal(practice.statusCode, 409, practice.body);
      assert.equal(sent, 1);
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS n FROM threads").get()!.n,
        1,
      );
      release(
        failFirst ? new Response("busy", { status: 429 }) : streamReply(),
      );
      await first;
      const next = await call("POST", "/v1/chat/send", {
        text: "Try after completion",
        clientId: "concurrent-quota-3",
      });
      assert.equal(next.statusCode, failFirst ? 200 : 429, next.body);
      assert.equal(sent, failFirst ? 2 : 1);
      assert.equal(
        (await call("GET", "/v1/chat/usage")).json().data.answers.used,
        1,
      );
    } finally {
      await app.close();
    }
  }
});

test("one remaining photo rejects a simultaneous scan before a second provider call and releases on failure", async () => {
  for (const failFirst of [false, true]) {
    let release!: (response: Response) => void;
    let reached!: () => void;
    let sent = 0;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const ok = () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  type: "problems",
                  problems: [{ text: "A concept", unclear: "" }],
                  solution: null,
                  notes: "",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 3 },
        }),
      );
    // one scan (≈ ¥0.0007) uses up the day.
    const { app, call, auth } = await setup((async () => {
      sent++;
      if (sent > 1) return ok();
      reached();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }) as typeof fetch, false, { DAILY_BUDGET_CNY: "0.0001" });
    try {
      const first = photo(app, auth);
      await waiting;
      const second = await photo(app, auth);
      assert.equal(second.statusCode, 409, second.body);
      assert.equal(second.json().code, "STILL_SCANNING");
      assert.equal(sent, 1);
      release(failFirst ? new Response("busy", { status: 429 }) : ok());
      await first;
      const next = await photo(app, auth);
      assert.equal(next.statusCode, failFirst ? 200 : 429, next.body);
      assert.equal(sent, failFirst ? 2 : 1);
      assert.equal(
        (await call("GET", "/v1/chat/usage")).json().data.photos.used,
        1,
      );
    } finally {
      await app.close();
    }
  }
});

test("failed remote similar judging releases its slot without charge; successful retry and replay share one receipt", async () => {
  let calls = 0;
  const { app, store, call, userId } = await setup(
    (async () => {
      calls++;
      return calls === 1
        ? new Response("auth rejected", { status: 401 })
        : new Response('{"answers":{"q":{"noul":0.9}}}');
    }) as typeof fetch,
    false,
    { JEV_API_KEY: "synthetic" },
  );
  try {
    const at = new Date().toISOString();
    store.db
      .prepare(
        "INSERT INTO threads(id,user_id,title,created_at,updated_at) VALUES('quota-judge-thread',?,'Synthetic',?,?)",
      )
      .run(userId, at, at);
    store.db
      .prepare(
        "INSERT INTO messages(id,thread_id,user_id,role,kind,data,status,created_at) VALUES('quota-judge-message','quota-judge-thread',?,'assistant','similar',?,'done',?)",
      )
      .run(
        userId,
        JSON.stringify({
          similar: {
            question: "How many?",
            answer: "2",
            key: "2",
            solution: "Two",
            verify: { state: "pass", items: [] },
          },
        }),
        at,
      );
    const payload = { answer: "两件", clientId: "remote-judge-retry" };
    const failed = await call(
      "POST",
      "/v1/chat/messages/quota-judge-message/answer",
      payload,
    );
    assert.equal(failed.statusCode, 503, failed.body);
    // Jev judging is free; the receipt is what is counted.
    assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS n FROM quota_receipts").get()!.n), 0);
    const retried = await call(
      "POST",
      "/v1/chat/messages/quota-judge-message/answer",
      payload,
    );
    assert.equal(retried.statusCode, 200, retried.body);
    const replay = await call(
      "POST",
      "/v1/chat/messages/quota-judge-message/answer",
      payload,
    );
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().data.judge.id, retried.json().data.judge.id);
    assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS n FROM quota_receipts").get()!.n), 1);
    assert.equal(calls, 2);
  } finally {
    await app.close();
  }
});
