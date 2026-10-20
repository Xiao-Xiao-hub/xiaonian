import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, SqliteStore } from "../server/src/shared/store.js";
import { JobRunner } from "../server/src/modules/jobs/runner.js";
import { NoteService, type Note } from "../server/src/modules/notes/service.js";
import { noteSchema } from "../server/src/modules/notes/schema.js";
import { fakeServices, makeApp, REPLIES } from "./fixtures.js";

const versions = (n: Note) => ({
  revision: n.revision,
  resultVersion: n.resultVersion,
});
function gatedServices() {
  const services = fakeServices(),
    fetcher = services.fetcher;
  let release = () => {},
    wait: Promise<void> | null = null;
  const hold = () => {
    wait = new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  services.fetcher = (async (url, init) => {
    const current = wait;
    if (current)
      await Promise.race([
        current,
        new Promise((_, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          ),
        ),
      ]);
    return fetcher(url, init);
  }) as typeof fetch;
  return {
    services,
    hold,
    release: () => {
      wait = null;
      release();
    },
  };
}
function setup(
  t: TestContext,
  services = fakeServices(),
  env: Record<string, string> = {},
) {
  const store = new SqliteStore(":memory:"),
    clock = { at: new Date("2026-10-03T01:00:00Z") };
  const app = makeApp(services, env, () => clock.at, store);
  t.after(() => app.close());
  const login = async (key: string) => {
    const { token, user } = (
      await app.inject({
        method: "POST",
        url: "/v1/auth/dev-login",
        payload: { key },
      })
    ).json().data;
    const call = (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET",
        url,
        payload: payload as string,
        headers: { authorization: `Bearer ${token}` },
      });
    const create = async (
      text = "想复习高数，还没决定从哪里开始，考试范围需要确认。",
    ) => (await call("POST", "/v1/notes", { text })).json().data as Note;
    const get = async (id: string) =>
      (await call("GET", `/v1/notes/${id}`)).json().data as Note;
    const organize = async (n: Note, refresh = false) =>
      call("POST", `/v1/notes/${n.id}/organize`, { ...versions(n), refresh });
    return { call, create, get, organize, userId: user.id as string };
  };
  const finished = async (id: string) => {
    for (let i = 0; i < 1000; i++) {
      const row = store.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
      if (!row || !["queued", "running"].includes(String(row.status)))
        return row;
      await delay(1);
    }
    throw new Error("Synthetic job did not finish");
  };
  return { app, store, clock, services, login, finished };
}

test("notes AI: authentication and ownership precede every content mutation and quota", async (t) => {
  const { app, store, login } = setup(t);
  const owner = await login("owner"),
    other = await login("other"),
    n = await owner.create();
  for (const [method, suffix, body] of [
    ["POST", "organize", { revision: 1, resultVersion: 0 }],
    [
      "POST",
      "supplements",
      { revision: 1, clientId: "valid-client-id-01", text: "补充" },
    ],
    [
      "PUT",
      "items/fake",
      { revision: 1, resultVersion: 0, group: "clear", text: "事项" },
    ],
    ["DELETE", "items/fake", { revision: 1, resultVersion: 0 }],
    ["PUT", "point", { pointId: "limit-rules", confirm: true }],
  ] as const) {
    const url = `/v1/notes/${n.id}/${suffix}`;
    assert.equal(
      (await app.inject({ method, url, payload: { unexpected: true } }))
        .statusCode,
      401,
    );
    assert.equal((await other.call(method, url, body)).statusCode, 404);
    assert.equal(
      (await owner.call(method, url, { ...body, unexpected: true })).statusCode,
      400,
    );
  }
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n, 0);
  assert.deepEqual(await owner.get(n.id), n);
});

test("notes AI: original and supplements remain exact, cached results and item edits do not call AI", async (t) => {
  const { store, services, login, finished } = setup(t);
  const u = await login("owner"),
    raw = " \r\n想复习高数\r\n 考试范围需确认 \t";
  let n = await u.create(raw);
  const supplement = {
    revision: n.revision,
    clientId: "client-supplement-01",
    text: " \r\n今晚有空，先做极限 \t",
  };
  n = (await u.call("POST", `/v1/notes/${n.id}/supplements`, supplement)).json()
    .data;
  assert.deepEqual([n.revision, n.sourceVersion, n.resultVersion], [2, 2, 0]);
  assert.equal(n.supplements[0]!.text, supplement.text);
  assert.deepEqual(
    (await u.call("POST", `/v1/notes/${n.id}/supplements`, supplement)).json()
      .data,
    n,
  );
  assert.equal(
    (
      await u.call("POST", `/v1/notes/${n.id}/supplements`, {
        ...supplement,
        text: "另一个内容",
      })
    ).statusCode,
    409,
  );
  const job = (await u.organize(n)).json().data.job;
  assert.equal((await finished(job.id))?.status, "succeeded");
  n = await u.get(n.id);
  assert.equal(n.text, raw);
  assert.equal(n.status, "organized");
  assert.equal(n.resultVersion, 1);
  assert.equal(n.result?.origin, "ai");
  assert.equal(n.result?.question.options.length, 2);
  assert.equal(n.pointId, null);
  assert.equal(services.jev.length, 0);
  const prompt = JSON.parse(services.llm[0]!.prompt);
  assert.equal(prompt.sources[0].text, raw);
  assert.equal(prompt.sources[1].text, supplement.text);
  assert.ok(
    prompt.availablePoints.every(
      (p: object) => !("why" in p) && !("answer" in p),
    ),
  );
  assert.equal((await u.organize(n)).json().data.job, null);
  const item = n.result!.items[0]!;
  n = (
    await u.call("PUT", `/v1/notes/${n.id}/items/${item.id}`, {
      ...versions(n),
      group: "decide",
      text: "先选哪一章",
    })
  ).json().data;
  assert.deepEqual([n.revision, n.resultVersion], [3, 2]);
  assert.equal(n.result!.items[0]!.edited, true);
  n = (
    await u.call("DELETE", `/v1/notes/${n.id}/items/${item.id}`, versions(n))
  ).json().data;
  assert.equal(n.result!.items.length, 2);
  assert.equal(services.llm.length, 1);
  assert.equal((await u.organize(n)).json().data.job, null);
  // The export marks the organised result as AI-generated (V4 A).
  assert.deepEqual((await u.call("GET", "/v1/me/export")).json().notes, [
    { ...n, aiLabel: "AI 生成", aiGeneratedFields: ["result"] },
  ]);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM map_points").get()?.n,
    0,
  );
  const jobRow = store.db
    .prepare("SELECT params,result FROM jobs WHERE id=?")
    .get(job.id)!;
  assert.doesNotMatch(JSON.stringify(jobRow), /考试范围|复习|今晚/);
});

test("notes AI: only explicit valid-point confirmation changes a link", async (t) => {
  const services = fakeServices({
    note_organize: {
      ...(REPLIES.note_organize as object),
      nextStep: { text: "可从极限运算开始", pointId: "limit-rules" },
    },
  });
  const { login, finished, store } = setup(t, services);
  const u = await login("owner");
  let n = await u.create();
  const job = (await u.organize(n)).json().data.job;
  await finished(job.id);
  n = await u.get(n.id);
  assert.equal(n.result?.nextStep.pointId, "limit-rules");
  assert.equal(n.pointId, null);
  for (const body of [
    { pointId: "limit-rules" },
    { pointId: "invalid", confirm: true },
  ])
    assert.equal(
      (await u.call("PUT", `/v1/notes/${n.id}/point`, body)).statusCode,
      400,
    );
  n = (
    await u.call("PUT", `/v1/notes/${n.id}/point`, {
      pointId: "limit-rules",
      confirm: true,
    })
  ).json().data;
  assert.equal(n.pointId, "limit-rules");
  assert.equal(n.revision, 1);
  n = (
    await u.call("PUT", `/v1/notes/${n.id}/point`, {
      pointId: null,
      confirm: true,
    })
  ).json().data;
  assert.equal(n.pointId, null);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM map_points").get()?.n,
    0,
  );
});

test("notes AI: in-flight title and link edits survive, identical requests reuse one job", async (t) => {
  const gate = gatedServices(),
    { login, finished } = setup(t, gate.services);
  const u = await login("owner");
  let n = await u.create();
  gate.hold();
  try {
    const first = (await u.organize(n)).json().data;
    const second = (await u.organize(n)).json().data;
    assert.equal(second.reused, true);
    assert.equal(second.job.id, first.job.id);
    n = (
      await u.call("PUT", `/v1/notes/${n.id}`, { title: "我自己的标题" })
    ).json().data;
    await u.call("PUT", `/v1/notes/${n.id}/point`, {
      pointId: "limit-rules",
      confirm: true,
    });
    gate.release();
    await finished(first.job.id);
    n = await u.get(n.id);
    assert.equal(n.title, "我自己的标题");
    assert.equal(n.pointId, "limit-rules");
    assert.equal(n.status, "organized");
    assert.equal(
      (await u.call("GET", "/v1/me/usage")).json().data.notes.used,
      1,
    );
  } finally {
    gate.release();
  }
});

test("notes AI: supplements and manual item edits reject late output without replacing saved results", async (t) => {
  const gate = gatedServices(),
    { login, finished } = setup(t, gate.services);
  const u = await login("owner");
  let n = await u.create();
  let job = (await u.organize(n)).json().data.job;
  await finished(job.id);
  n = await u.get(n.id);
  gate.hold();
  try {
    job = (await u.organize(n, true)).json().data.job;
    n = (
      await u.call("POST", `/v1/notes/${n.id}/supplements`, {
        revision: n.revision,
        clientId: "supplement-late-001",
        text: "新增一句",
      })
    ).json().data;
    assert.equal(n.resultStale, true);
    gate.release();
    const supplementedJob = await finished(job.id);
    assert.equal(supplementedJob?.error_code, "NOTE_CHANGED");
    assert.equal(JSON.parse(String(supplementedJob?.usage)).calls, 1);
    assert.deepEqual((await u.get(n.id)).result, n.result);
    job = (await u.organize(n)).json().data.job;
    await finished(job.id);
    n = await u.get(n.id);
    assert.equal(n.resultStale, false);
    gate.hold();
    job = (await u.organize(n, true)).json().data.job;
    const original = n;
    n = (
      await u.call("PUT", `/v1/notes/${n.id}/items/${n.result!.items[0]!.id}`, {
        ...versions(n),
        group: "clear",
        text: "这是我确认后的内容",
      })
    ).json().data;
    assert.equal((await u.organize(original, true)).statusCode, 409);
    gate.release();
    const editedJob = await finished(job.id);
    assert.equal(editedJob?.error_code, "NOTE_CHANGED");
    assert.equal(JSON.parse(String(editedJob?.usage)).calls, 1);
    assert.equal(
      (await u.get(n.id)).result!.items[0]!.text,
      "这是我确认后的内容",
    );
  } finally {
    gate.release();
  }
});

test("notes AI: deletion clears all text and active output but retains a content-free quota receipt", async (t) => {
  const gate = gatedServices(),
    { login, store, finished } = setup(t, gate.services, {
      DAILY_NOTES_LIMIT: "1",
      // the finished call is spent even though its note is gone.
      DAILY_BUDGET_CNY: "0.0001",
    });
  const u = await login("owner"),
    n = await u.create("PRIVATE_NOTE_WORDS");
  gate.hold();
  try {
    const job = (await u.organize(n)).json().data.job;
    await u.call("DELETE", `/v1/notes/${n.id}`);
    assert.equal((await u.call("GET", `/v1/notes/${n.id}`)).statusCode, 404);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM note_supplements").get()?.n,
      0,
    );
    gate.release();
    // Deletion marks the receipt failed before the in-flight call returns.
    // Wait for that call's usage, not merely the already-terminal status.
    for (let i = 0; i < 1000; i++) {
      if (
        store.db.prepare("SELECT usage FROM jobs WHERE id=?").get(job.id)?.usage
      )
        break;
      await delay(1);
    }
    await finished(job.id);
    const receipt = store.db
      .prepare("SELECT * FROM jobs WHERE id=?")
      .get(job.id)!;
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.result, null);
    assert.equal(receipt.error_code, "NOTE_DELETED");
    assert.equal(JSON.parse(String(receipt.usage)).calls, 1);
    assert.deepEqual(JSON.parse(String(receipt.params)), { deleted: true });
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_NOTE_WORDS/);
    assert.ok(!JSON.stringify(receipt).includes(n.id));
  } finally {
    gate.release();
  }
  assert.equal((await u.call("GET", "/v1/me/usage")).json().data.notes.used, 1);
  assert.equal((await u.organize(await u.create())).statusCode, 429);
  assert.deepEqual(
    (await u.call("GET", "/v1/me/export"))
      .json()
      .notes.map((x: Note) => x.text),
    ["想复习高数，还没决定从哪里开始，考试范围需要确认。"],
  );
});

test("notes AI: erasing an account while running cannot restore content or jobs", async (t) => {
  const gate = gatedServices(),
    { login, store } = setup(t, gate.services);
  const u = await login("owner"),
    other = await login("other"),
    n = await u.create();
  const kept = await other.create("另一位的内容");
  gate.hold();
  try {
    await u.organize(n);
    await u.call("DELETE", "/v1/me", { confirm: true });
    gate.release();
    await delay(15);
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id=?")
        .get(u.userId)?.n,
      0,
    );
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM notes WHERE user_id=?")
        .get(u.userId)?.n,
      0,
    );
    assert.deepEqual(await other.get(kept.id), kept);
  } finally {
    gate.release();
  }
});

test("notes AI: quota reserves ten concurrent tasks, reuse is free, deletion does not refill", async (t) => {
  const gate = gatedServices(),
    // reservations now count against the hidden daily cap.
    { login } = setup(t, gate.services, {
      DAILY_NOTES_LIMIT: "10",
      DAILY_SAFETY_CAP: "10",
    });
  const u = await login("owner"),
    notes: Note[] = [];
  for (let i = 0; i < 11; i++) notes.push(await u.create(`第${i}条`));
  gate.hold();
  try {
    const results = await Promise.all(notes.map((n) => u.organize(n)));
    assert.equal(results.filter((r) => r.statusCode === 200).length, 10);
    assert.equal(results.filter((r) => r.statusCode === 429).length, 1);
    assert.equal((await u.organize(notes[0]!)).json().data.reused, true);
    await u.call("DELETE", `/v1/notes/${notes[0]!.id}`);
    assert.equal((await u.organize(notes[10]!)).statusCode, 429);
    assert.equal(
      (await u.call("GET", "/v1/me/usage")).json().data.notes.used,
      10,
    );
  } finally {
    gate.release();
  }
});

test("notes AI: schema correction is one quota attempt and rejects invented ids and extra fields", async (t) => {
  const bad = {
    ...(REPLIES.note_organize as object),
    nextStep: { text: "错误建议", pointId: "not-on-map" },
  };
  const { services, login, finished } = setup(
    t,
    fakeServices({ note_organize: bad }),
  );
  const u = await login("owner"),
    n = await u.create();
  const job = (await u.organize(n)).json().data.job;
  assert.equal((await finished(job.id))?.error_code, "AI_BAD_OUTPUT");
  assert.equal(services.llm.length, 2);
  // the failed job is not charged.
  assert.equal((await u.call("GET", "/v1/me/usage")).json().data.notes.used, 0);
  assert.equal((await u.get(n.id)).result, null);
  const schema = noteSchema([{ id: "original", text: n.text }]);
  assert.equal(
    schema.safeParse({ ...(REPLIES.note_organize as object), score: 99 })
      .success,
    false,
  );
  assert.equal(
    schema.safeParse({
      ...(REPLIES.note_organize as object),
      items: [{ group: "clear", text: "内容", sourceIds: ["someone-else"] }],
    }).success,
    false,
  );
});

test("notes AI: unknown failures require an explicit new attempt and each attempt consumes quota", async (t) => {
  const services = fakeServices(),
    real = services.fetcher;
  let fail = true;
  services.fetcher = (async (url, init) => {
    if (fail) throw new Error("synthetic interrupted response");
    return real(url, init);
  }) as typeof fetch;
  const { login, finished } = setup(t, services),
    u = await login("owner"),
    n = await u.create();
  const first = (await u.organize(n)).json().data.job;
  const row = await finished(first.id);
  assert.equal(row?.status, "unknown");
  assert.match(String(row?.error_message), /再试/);
  fail = false;
  // Without the explicit retry flag nothing is enqueued or charged.
  const refused = await u.organize(n);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, "JOB_UNKNOWN");
  // the unknown job is not charged; only the successful retry counts.
  assert.equal((await u.call("GET", "/v1/me/usage")).json().data.notes.used, 0);
  const second = (
    await u.call("POST", `/v1/notes/${n.id}/organize`, {
      revision: n.revision,
      resultVersion: n.resultVersion,
      retryUnknown: true,
    })
  ).json().data.job;
  assert.notEqual(second.id, first.id);
  assert.equal((await finished(second.id))?.status, "succeeded");
  assert.equal((await u.call("GET", "/v1/me/usage")).json().data.notes.used, 1);
});

test("notes AI: supplement limits use UTF-16 length and permit no unbounded accumulation", async (t) => {
  const { login, services } = setup(t),
    u = await login("owner");
  let n = await u.create("字".repeat(2000));
  assert.equal(
    (
      await u.call("POST", `/v1/notes/${n.id}/supplements`, {
        revision: 1,
        clientId: "boundary-client-001",
        text: "📝".repeat(251),
      })
    ).statusCode,
    400,
  );
  for (let i = 0; i < 8; i++)
    n = (
      await u.call("POST", `/v1/notes/${n.id}/supplements`, {
        revision: n.revision,
        clientId: `boundary-client-${i}`,
        text: "📝".repeat(250),
      })
    ).json().data;
  assert.equal(n.supplements.length, 8);
  assert.equal(
    (
      await u.call("POST", `/v1/notes/${n.id}/supplements`, {
        revision: n.revision,
        clientId: "boundary-client-009",
        text: "字",
      })
    ).statusCode,
    400,
  );
  assert.equal(services.llm.length, 0);
});

test("notes AI: an unconfigured model leaves raw notes available and consumes no quota", async (t) => {
  const { login, store, services } = setup(t, fakeServices(), {
    LLM_API_KEY: undefined,
  } as unknown as Record<string, string>);
  const u = await login("owner"),
    n = await u.create("仅保存在这里");
  const response = await u.organize(n);
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, "AI_NOT_CONFIGURED");
  assert.deepEqual(await u.get(n.id), n);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n, 0);
  assert.equal(services.llm.length, 0);
});

test("notes AI: migration nine preserves legacy words and protects titles across reopen", () => {
  const path = join(
      mkdtempSync(join(tmpdir(), "zhiye-notes-ai-upgrade-")),
      "app.sqlite",
    ),
    old = new DatabaseSync(path),
    iso = "2026-10-02T00:00:00Z";
  try {
    old.exec(
      "PRAGMA foreign_keys=ON;CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)",
    );
    for (let i = 0; i < 8; i++) {
      old.exec(MIGRATIONS[i]!);
      old.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(i + 1, iso);
    }
    old
      .prepare("INSERT INTO users(id,openid,data) VALUES(?,?,?)")
      .run("u", "dev:u", JSON.stringify({ id: "u" }));
    old
      .prepare("INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?)")
      .run("n", "u", " \r\n原话📝 \t", "旧标题", "raw", null, null, iso, iso);
  } finally {
    old.close();
  }
  for (let i = 0; i < 2; i++) {
    const store = new SqliteStore(path);
    try {
      const n = new NoteService(store).detail("u", "n");
      assert.equal(n.text, " \r\n原话📝 \t");
      assert.equal(n.title, "旧标题");
      assert.equal(n.createdAt, iso);
      assert.deepEqual(
        [n.revision, n.sourceVersion, n.resultVersion],
        [1, 1, 0],
      );
      assert.equal(
        store.db.prepare("SELECT title_edited FROM notes WHERE id='n'").get()
          ?.title_edited,
        1,
      );
      assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      store.close();
    }
  }
});

test("notes AI: recovery marks running jobs unknown and keeps old-day attempts out of today's quota", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.upsertUser("dev:recover", "恢复", "dev");
    const user = store.db.prepare("SELECT id FROM users").get()!;
    store.db
      .prepare(
        "INSERT INTO jobs(id,user_id,kind,version,params,params_hash,status,created_at) VALUES('old',?,'note_organize',1,'{}','old','running','2000-01-01T00:00:00Z')",
      )
      .run(String(user.id));
    const runner = new JobRunner(
      store,
      {
        note_organize: {
          quota: "notes",
          run: async () => {
            throw new Error("Must not run recovery output");
          },
        },
      },
      { concurrency: 1, timeoutMs: 1000, limits: { notes: 10 } },
    );
    runner.recover();
    assert.equal(runner.get("old")?.status, "unknown");
    assert.equal(runner.usedToday(String(user.id), "notes"), 0);
  } finally {
    store.close();
  }
});

test("notes: deleting a note purges finished jobs' content but keeps their outcome", async (t) => {
  const { login, finished, store } = setup(t),
    u = await login("owner"),
    n = await u.create("PRIVATE_FINISHED_WORDS");
  const job = (await u.organize(n)).json().data.job;
  assert.equal((await finished(job.id))?.status, "succeeded");
  await u.call("DELETE", `/v1/notes/${n.id}`);
  const receipt = store.db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id)!;
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.error_code, null);
  assert.equal(receipt.result, null);
  assert.deepEqual(JSON.parse(String(receipt.params)), { deleted: true });
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_FINISHED_WORDS/);
  assert.equal((await u.call("GET", "/v1/me/usage")).json().data.notes.used, 1);
});

test("notes: a create retried with the same clientId returns the first note", async (t) => {
  const { login, store } = setup(t),
    u = await login("owner"),
    other = await login("other");
  const body = { text: "超时后重试的同一条", clientId: "retry-client-0001" };
  const first = await u.call("POST", "/v1/notes", body);
  const again = await u.call("POST", "/v1/notes", body);
  assert.equal(first.statusCode, 200);
  assert.equal(again.json().data.id, first.json().data.id);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM notes WHERE user_id=?").get(u.userId)?.n,
    1,
  );
  // Different text under the same id is refused, not silently merged.
  const changed = await u.call("POST", "/v1/notes", { ...body, text: "改过的文字" });
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().code, "CLIENT_ID_REUSED");
  // Another account may use the same id independently.
  const theirs = await other.call("POST", "/v1/notes", body);
  assert.notEqual(theirs.json().data.id, first.json().data.id);
  assert.equal((await u.call("POST", "/v1/notes", { ...body, clientId: "bad id" })).statusCode, 400);
});
