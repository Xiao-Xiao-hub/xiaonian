import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { approvedCommercialCatalog } from "../server/src/modules/commercial/policy.js";
import { CommercialBilling } from "../server/src/shared/commercial-billing.js";
import { SqliteStore } from "../server/src/shared/store.js";

function create(fetcher: typeof fetch, commercial = false) {
  const store = new SqliteStore(":memory:");
  if (commercial) {
    store.saveSetting("commercial.enabled", true);
    store.saveSetting("commercial.catalog", approvedCommercialCatalog());
    store.saveSetting("commercial.prices", {
      jev: { microyuanPerRequest: 1 },
    });
    store.saveSetting("ai.prices", [
      {
        host: "tokenhub-intl.tencentmaas.com",
        model: "hy4-preview",
        input: 0.5,
        output: 0.5,
        cached: 0.5,
        note: "quota boundary test",
      },
    ]);
  }
  const app = buildApp({
    store,
    fetcher,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      LOG_LEVEL: "silent",
      DATABASE_PATH: ":memory:",
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "quota-review-formulas-")),
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "quota-review-uploads-")),
      JEV_API_KEY: "synthetic-jev",
      LLM_API_KEY: "synthetic-llm",
      CHAT_DAILY_LIMIT: "1",
    }),
  });
  return { store, app };
}
async function identity(app: ReturnType<typeof create>["app"], key: string) {
  const login = (
    await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key },
    })
  ).json().data;
  return {
    id: login.user.id as string,
    headers: { authorization: `Bearer ${login.token}` },
  };
}
function seed(store: SqliteStore, userId: string, name: string) {
  const at = new Date().toISOString();
  const thread = `review-thread-${name}`;
  const message = `review-message-${name}`;
  store.db
    .prepare(
      "INSERT INTO threads(id,user_id,title,data,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    )
    .run(
      thread,
      userId,
      "Synthetic question",
      JSON.stringify({ problem: "What is one plus one?" }),
      at,
      at,
    );
  store.db
    .prepare(
      "INSERT INTO messages(id,thread_id,user_id,role,kind,content,data,status,created_at) VALUES(?,?,?,'assistant','similar','',?,'done',?)",
    )
    .run(
      message,
      thread,
      userId,
      JSON.stringify({
        similar: {
          question: "What is one plus one?",
          answer: "2",
          key: "2",
          solution: "1 + 1 = 2",
          verify: { state: "pass", items: [] },
        },
      }),
      at,
    );
  return { thread, message };
}
const equivalent = () =>
  new Response(JSON.stringify({ answers: { q: { noul: 0.9 } } }));
const similarResponse = () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              question: "求 x^2 的导数",
              answer: "2*x",
              options: ["$2x$", "$x^{2}$", "$2$", "$x$"],
              correct: 0,
              steps: ["幂函数求导", "得 $2x$"],
              solution: "幂函数求导得 2*x。",
              checks: [{ kind: "derivative", expr: "x^2", answer: "2*x" }],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }),
  );

test("remote similar-answer judging reserves per user; exhausted users keep free local judging", async () => {
  const releases: ((response: Response) => void)[] = [];
  const reached: (() => void)[] = [];
  const arrivals = [0, 1].map(
    (i) =>
      new Promise<void>((resolve) => {
        reached[i] = resolve;
      }),
  );
  let calls = 0;
  const { app, store } = create((async () => {
    const index = calls++;
    reached[index]?.();
    return new Promise<Response>((resolve) => {
      releases[index] = resolve;
    });
  }) as typeof fetch);
  try {
    const a = await identity(app, "quota-review-a");
    const b = await identity(app, "quota-review-b");
    const aQuestion = seed(store, a.id, "a");
    const bQuestion = seed(store, b.id, "b");
    const answer = (
      who: typeof a,
      message: string,
      text: string,
      clientId: string,
    ) =>
      app.inject({
        method: "POST",
        url: `/v1/chat/messages/${message}/answer`,
        headers: who.headers,
        payload: { answer: text, clientId },
      });
    const first = answer(a, aQuestion.message, "两个", "review-client-a1").then(
      (r) => r,
    );
    await arrivals[0];
    const busy = await answer(a, aQuestion.message, "一对", "review-client-a2");
    assert.equal(busy.statusCode, 409, busy.body);
    assert.equal(calls, 1);
    const other = answer(
      b,
      bQuestion.message,
      "two items",
      "review-client-b1",
    ).then((r) => r);
    await arrivals[1];
    releases[0]!(equivalent());
    releases[1]!(equivalent());
    const firstResult = await first;
    const otherResult = await other;
    assert.equal(firstResult.statusCode, 200);
    assert.equal(otherResult.statusCode, 200);
    assert.equal(firstResult.json().data.judge.attempt.result.judge, "jev");
    assert.equal(otherResult.json().data.judge.attempt.result.judge, "jev");
    // Jev judging costs nothing, so a's budget is used up by hand.
    store.db
      .prepare("UPDATE users SET quota=? WHERE id=?")
      .run(JSON.stringify({ budget: { day: 0 } }), a.id);
    const free = await answer(a, aQuestion.message, "2", "review-client-a3");
    assert.equal(free.statusCode, 200, free.body);
    assert.equal(free.json().data.judge.attempt.result.judge, "rule");
    const denied = await answer(
      a,
      aQuestion.message,
      "两份",
      "review-client-a4",
    );
    assert.equal(denied.statusCode, 429, denied.body);
    assert.equal(calls, 2);
    for (const who of [a, b]) {
      const usage = (
        await app.inject({ url: "/v1/chat/usage", headers: who.headers })
      ).json().data;
      // An old client sees a's answers used up; b is not stopped, so its
      // one answer of one still shows one left.
      assert.equal(usage.answers.used, who === a ? 1 : 0);
      const exported = (
        await app.inject({ url: "/v1/me/export", headers: who.headers })
      ).json();
      assert.equal(
        exported.quotaUsage.reduce(
          (n: number, row: { used: number }) => n + row.used,
          0,
        ),
        1,
      );
      assert.ok(
        !JSON.stringify(exported.quotaUsage).includes(who === a ? b.id : a.id),
      );
    }
  } finally {
    for (const release of releases) release?.(equivalent());
    await app.close();
  }
});

test("a verified similar result finishing after deletion keeps only a quota receipt; account erasure keeps none", async () => {
  for (const erase of [false, true]) {
    let release!: (response: Response) => void;
    let ready!: () => void;
    const arrived = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const { app, store } = create((async (url) => {
      if (String(url).startsWith("https://api.typesafe.ai/"))
        return equivalent();
      ready();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }) as typeof fetch);
    try {
      const who = await identity(app, "late-similar-review");
      const question = seed(store, who.id, "late");
      const pending = app
        .inject({
          method: "POST",
          url: `/v1/chat/threads/${question.thread}/similar`,
          headers: who.headers,
          payload: {},
        })
        .then((r) => r);
      await arrived;
      const removed = await app.inject({
        method: "DELETE",
        url: erase ? "/v1/me" : `/v1/chat/threads/${question.thread}`,
        headers: who.headers,
        ...(erase ? { payload: { confirm: true } } : {}),
      });
      assert.equal(removed.statusCode, 200);
      release(similarResponse());
      const response = await pending;
      assert.equal(response.statusCode, 404, response.body);
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS n FROM quota_receipts").get()!.n,
        erase ? 0 : 1,
      );
      // the finished call is spent; deleting the thread refunds nothing.
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS n FROM quota_spend").get()!.n,
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

test("commercial similar result finishing after deletion releases every hold", async () => {
  let release!: (response: Response) => void;
  let ready!: () => void;
  const arrived = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const { app, store } = create(
    (async (url) => {
      if (String(url).startsWith("https://api.typesafe.ai/"))
        return equivalent();
      ready();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }) as typeof fetch,
    true,
  );
  try {
    const who = await identity(app, "commercial-late-similar");
    const question = seed(store, who.id, "commercial-late");
    const pending = app.inject({
      method: "POST",
      url: `/v1/chat/threads/${question.thread}/similar`,
      headers: who.headers,
      payload: {},
    });
    await arrived;
    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/chat/threads/${question.thread}`,
      headers: who.headers,
    });
    assert.equal(removed.statusCode, 200);
    release(similarResponse());
    const response = await pending;
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM quota_receipts").get()!.n,
      0,
    );
    const calls = store.db
      .prepare("SELECT status,charged_credits FROM commercial_calls")
      .all() as { status: string; charged_credits: number | null }[];
    assert.ok(calls.length >= 1);
    assert.ok(calls.every((call) => call.status === "released"));
    assert.ok(calls.every((call) => call.charged_credits === null));
    assert.equal(
      new CommercialBilling(store).accounts.available(who.id).free,
      30,
    );
  } finally {
    await app.close();
  }
});
