import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEnv } from "../server/src/config/env.js";
import { buildApp } from "../server/src/index.js";
import { approvedCommercialCatalog } from "../server/src/modules/commercial/policy.js";
import { CommercialBilling } from "../server/src/shared/commercial-billing.js";
import { SqliteStore } from "../server/src/shared/store.js";

const PROBLEM = String.raw`求极限 $\lim_{x\to 0}\frac{e^{3x}-1-3x}{x^{2}}$。`;
const verify = (answer: string) =>
  `\n<verify>{"answer":"${answer}","revealed":true,"checks":[{"kind":"limit","expr":"(exp(3*x)-1-3*x)/x^2","at":"0","answer":"${answer}"}]}</verify>`;
const WRONG = `所以极限是 $1.5$。\n\n**答案**：$1.5$${verify("1.5")}`;
const RIGHT = `用泰勒展开可得极限是 $\\frac{9}{2}$。\n\n**答案**：$\\frac{9}{2}$${verify("9/2")}`;

function streamingFetcher(script: string[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      const body = JSON.parse(String(init?.body));
      const question = body.questions.q;
      return Response.json({
        answers: {
          q:
            question.type === "noul"
              ? { noul: 0.9 }
              : {
                  choice: "none",
                  confidence: 1,
                  probabilities: { none: 1 },
                },
        },
      });
    }
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    const text = script.shift() ?? "没有更多回复";
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const piece of text.match(/[\s\S]{1,12}/g) ?? []) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`,
            ),
          );
        }
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2000 } })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
}

async function fixture(script: string[]) {
  const store = new SqliteStore(":memory:");
  store.saveSetting("commercial.enabled", true);
  store.saveSetting("commercial.catalog", approvedCommercialCatalog());
  store.saveSetting("commercial.prices", {
    jev: { microyuanPerRequest: 1 },
  });
  store.saveSetting("ai.prices", [
    {
      host: "provider.test",
      model: "meter-model",
      input: 0.5,
      output: 0.5,
      cached: 0.5,
      note: "chat settlement test",
    },
  ]);
  const app = buildApp({
    store,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-chat-commercial-")),
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-formula-commercial-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "test-llm",
      LLM_BASE_URL: "https://provider.test/v1",
      LLM_MODEL: "meter-model",
      JEV_API_KEY: "test-jev",
    }),
    fetcher: streamingFetcher(script),
  });
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: {},
  });
  const token = login.json().data.token as string;
  const userId = String(
    (store.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string })
      .id,
  );
  let sent = 0;
  const send = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/v1/chat/send",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        clientId: `commercial-chat-${++sent}`,
        tone: "light",
        ...payload,
      },
    });
  return { app, store, userId, send };
}

function events(body: string) {
  return body
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>);
}

test("chat final message and commercial settlement commit together", async () => {
  const f = await fixture(["先列出已知条件，再逐步计算。"]);
  try {
    const response = await f.send({ text: "今天怎样复习高数？", mode: "auto" });
    assert.equal(response.statusCode, 200);
    assert.ok(events(response.body).some((event) => event.e === "done"));
    const message = f.store.db
      .prepare(
        "SELECT status,charged FROM messages WHERE role='assistant' AND kind='reply'",
      )
      .get() as { status: string; charged: number };
    assert.deepEqual({ ...message }, { status: "done", charged: 1 });
    const call = f.store.db
      .prepare("SELECT status,charged_credits FROM commercial_calls")
      .get() as { status: string; charged_credits: number };
    assert.equal(call.status, "settled");
    assert.equal(call.charged_credits, 1);
    assert.equal(
      new CommercialBilling(f.store).accounts.available(f.userId).free,
      29,
    );
  } finally {
    await f.app.close();
  }
});

test("provider success followed by final message commit failure releases the hold", async () => {
  const f = await fixture(["这条回答已经由模型完整生成。"]);
  try {
    f.store.db.exec(`
      CREATE TRIGGER fail_chat_final_commit
      BEFORE UPDATE OF status ON messages
      WHEN OLD.status='streaming' AND NEW.status='done'
      BEGIN SELECT RAISE(FAIL,'synthetic final message failure'); END
    `);
    const response = await f.send({ text: "解释一下函数极限。", mode: "auto" });
    assert.equal(response.statusCode, 200, "the stream had already started");
    assert.ok(events(response.body).some((event) => event.e === "error"));
    const message = f.store.db
      .prepare(
        "SELECT status,charged FROM messages WHERE role='assistant' AND kind='reply'",
      )
      .get() as { status: string; charged: number };
    assert.deepEqual({ ...message }, { status: "streaming", charged: 0 });
    assert.deepEqual(
      f.store.db
        .prepare("SELECT status FROM commercial_calls")
        .all()
        .map((row) => String(row.status)),
      ["released"],
    );
    assert.equal(
      new CommercialBilling(f.store).accounts.available(f.userId).free,
      30,
    );
    const usage = f.store.db
      .prepare("SELECT status,cost_microyuan FROM commercial_usage")
      .get() as { status: string; cost_microyuan: number };
    assert.equal(usage.status, "succeeded");
    assert.ok(usage.cost_microyuan > 0, "provider cost remains observable");
  } finally {
    await f.app.close();
  }
});

test("free recheck records provider cost without inheriting the learner payment source", async () => {
  const f = await fixture([WRONG, RIGHT]);
  try {
    const response = await f.send({ text: PROBLEM, mode: "solution" });
    assert.equal(response.statusCode, 200);
    assert.ok(events(response.body).some((event) => event.e === "recheck"));
    const calls = f.store.db
      .prepare("SELECT status,charged_credits FROM commercial_calls")
      .all() as { status: string; charged_credits: number }[];
    const usage = f.store.db
      .prepare(
        `SELECT u.user_id,u.kind,u.status,u.cost_microyuan,
                c.id commercial_call_id,c.status commercial_call_status
         FROM commercial_usage u
         LEFT JOIN commercial_calls c ON c.id=u.id`,
      )
      .all() as {
      user_id: string | null;
      kind: string;
      status: string;
      cost_microyuan: number;
      commercial_call_id: string | null;
      commercial_call_status: string | null;
    }[];
    assert.equal(calls.filter((row) => row.status === "settled").length, 1);
    assert.ok(
      calls.every(
        (row) => row.status === "settled" || row.status === "released",
      ),
    );
    assert.equal(
      calls.reduce((sum, row) => sum + (row.charged_credits ?? 0), 0),
      1,
    );
    assert.equal(usage.length, 3);
    const llmUsage = usage.filter(
      (row) => row.kind === "llm" && row.status === "succeeded",
    );
    assert.equal(llmUsage.length, 2);
    const paid = llmUsage.find((row) => row.user_id === f.userId);
    const recheck = llmUsage.find((row) => row.user_id === null);
    assert.equal(paid?.commercial_call_status, "settled");
    assert.ok(paid?.commercial_call_id);
    assert.equal(recheck?.commercial_call_id, null);
    assert.equal(recheck?.commercial_call_status, null);
    assert.ok(llmUsage.every((row) => row.cost_microyuan > 0));
    assert.equal(
      new CommercialBilling(f.store).accounts.available(f.userId).free,
      29,
    );
  } finally {
    await f.app.close();
  }
});
