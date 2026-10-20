import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";

const USER_WORDS = "我想先把明天要做的三件事情按轻重排好";

async function fixture() {
  const store = new SqliteStore(":memory:");
  const state = { wraps: 0, bodies: [] as Record<string, any>[] };
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      const q = body.questions.q;
      const answer =
        q.type === "noul"
          ? { noul: JSON.stringify(body).includes("危险标题") ? 0.99 : 0 }
          : {
              choice: Object.keys(q.criteria ?? {})[0] ?? "life",
              confidence: 0.9,
              probabilities: Object.fromEntries(
                Object.keys(q.criteria ?? {}).map((key) => [key, 0.9]),
              ),
            };
      return new Response(JSON.stringify({ answers: { q: answer } }));
    }
    if (!String(body.messages?.[0]?.content).includes("[CHAT_WRAP]")) {
      const content = '可以接着说。<guide>{"options":["继续"]}</guide>';
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    state.wraps++;
    state.bodies.push(body);
    const content = {
      summary: "把明天的事情排个顺序",
      cards: [
        {
          key: "main",
          type: "idea",
          title: "明天的安排",
          summary: "先按轻重安排三件事",
          quote: USER_WORDS,
          tags: ["安排"],
        },
      ],
      open: [
        {
          key: "check",
          cat: "verify",
          text: "先后顺序是否合适",
          quote: "三件事情",
        },
      ],
      next: { if: "列完三件事", then: "标出第一件" },
    };
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 5, completion_tokens: 4 },
      }),
    );
  }) as typeof fetch;
  const app = buildApp({
    store,
    fetcher,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-wrap-")),
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-wrap-formula-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "test-llm",
      JEV_API_KEY: "test-jev",
    }),
  });
  const login = async (key: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key },
    });
    return {
      userId: response.json().data.user.id as string,
      auth: { authorization: `Bearer ${response.json().data.token}` },
    };
  };
  const owner = await login("wrap-owner"),
    other = await login("wrap-other");
  const made = await app.inject({
    method: "POST",
    url: "/v1/chat/threads",
    headers: owner.auth,
    payload: { text: "明天安排", tone: "light" },
  });
  const threadId = made.json().data.thread.id as string;
  store.db.prepare("UPDATE threads SET scene='life' WHERE id=?").run(threadId);
  const add = (
    id: string,
    role: "user" | "assistant",
    content: string,
    data: object,
    createdAt: string,
  ) =>
    store.db
      .prepare(
        "INSERT INTO messages(id,thread_id,user_id,role,kind,content,data,status,created_at) VALUES(?,?,?,?,?,?,?,'done',?)",
      )
      .run(
        id,
        threadId,
        owner.userId,
        role,
        "reply",
        content,
        JSON.stringify(data),
        createdAt,
      );
  add("wrap-user", "user", USER_WORDS, {}, "2026-10-12T01:00:00.000Z");
  add(
    "wrap-ai",
    "assistant",
    "可以先列出来，再判断哪件最重要。",
    { guide: { options: ["把明天的三件事排出顺序"] } },
    "2026-10-12T01:00:01.000Z",
  );
  add(
    "wrap-crisis",
    "user",
    "这句危机内容不能进入收尾提示",
    { crisis: true },
    "2026-10-12T01:00:02.000Z",
  );
  return { app, store, state, owner, other, threadId };
}

test("收尾草稿并发重开复用且排除危机消息，只扣一次整理额度", async () => {
  const f = await fixture();
  try {
    const open = () =>
      f.app.inject({
        method: "POST",
        url: `/v1/chat/threads/${f.threadId}/wrap`,
        headers: f.owner.auth,
        payload: { action: "open" },
      });
    const [one, two] = await Promise.all([open(), open()]);
    assert.equal(one.statusCode, 200);
    assert.equal(two.statusCode, 200);
    assert.equal(one.json().data.id, two.json().data.id);
    assert.equal(f.state.wraps, 1);
    assert.doesNotMatch(JSON.stringify(f.state.bodies[0]), /危机内容不能进入/);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT count(*) n FROM quota_receipts WHERE user_id=? AND kind='card_tidy'",
        )
        .get(f.owner.userId)!.n,
      1,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/v1/chat/threads/${f.threadId}/wrap`,
          headers: f.other.auth,
          payload: { action: "open" },
        })
      ).statusCode,
      404,
    );
    f.store.db
      .prepare("UPDATE threads SET mode='teach' WHERE id=?")
      .run(f.threadId);
    assert.equal((await open()).statusCode, 409);
  } finally {
    await f.app.close();
  }
});

test("收尾拒绝伪造我的话和草稿外修改，保存幂等且不再次整理", async () => {
  const f = await fixture();
  try {
    const opened = await f.app.inject({
      method: "POST",
      url: `/v1/chat/threads/${f.threadId}/wrap`,
      headers: f.owner.auth,
      payload: { action: "open" },
    });
    const draft = opened.json().data;
    const save = (payload: Record<string, unknown>) =>
      f.app.inject({
        method: "POST",
        url: `/v1/chat/threads/${f.threadId}/wrap`,
        headers: f.owner.auth,
        payload: {
          action: "save",
          draftId: draft.id,
          picks: ["main"],
          ...payload,
        },
      });
    // newly typed words are the user's; a copy of the AI reply is not.
    assert.equal(
      (await save({ mine: "可以先列出来，再判断哪件最重要。" })).statusCode,
      400,
    );
    assert.equal(
      (await save({ edits: [{ key: "forged", title: "伪造卡" }] })).statusCode,
      400,
    );
    assert.equal(
      (await save({ edits: [{ key: "main", title: "危险标题" }] })).statusCode,
      400,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) n FROM cards WHERE user_id=?")
        .get(f.owner.userId)!.n,
      0,
    );

    const payload = {
      mine: USER_WORDS,
      edits: [{ key: "main", title: "我改的标题" }],
      next: { if: "今晚有空", then: "先列出三件事" },
    };
    const [first, repeated] = await Promise.all([save(payload), save(payload)]);
    assert.equal(first.statusCode, 200);
    assert.equal(repeated.statusCode, 200);
    assert.deepEqual(
      first.json().data.savedCardIds,
      repeated.json().data.savedCardIds,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) n FROM cards WHERE user_id=?")
        .get(f.owner.userId)!.n,
      1,
    );
    const card = f.store.db
      .prepare(
        "SELECT title,title_by,mine,quote,next FROM cards WHERE user_id=?",
      )
      .get(f.owner.userId)!;
    assert.equal(card.title, "我改的标题");
    assert.equal(card.title_by, "user");
    assert.equal(card.mine, USER_WORDS);
    assert.equal(card.quote, USER_WORDS);
    assert.deepEqual(JSON.parse(String(card.next)), {
      if: "今晚有空",
      then: "先列出三件事",
      by: "user",
    });
    assert.equal(f.state.wraps, 1);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT count(*) n FROM jobs WHERE user_id=? AND kind='card_tidy'",
        )
        .get(f.owner.userId)!.n,
      0,
    );
    assert.equal(
      f.store.db
        .prepare(
          "SELECT count(*) n FROM quota_receipts WHERE user_id=? AND kind='card_tidy'",
        )
        .get(f.owner.userId)!.n,
      1,
    );
  } finally {
    await f.app.close();
  }
});

test("普通收卡也不能把 AI 回复伪装成我的话", async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({
      method: "POST",
      url: "/v1/cards",
      headers: f.owner.auth,
      payload: {
        origin: "chat",
        srcId: f.threadId,
        messageId: "wrap-ai",
        type: "idea",
        mine: "可以先列出来，再判断哪件最重要。",
      },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().message, /这句是 AI 说的/);

    f.store.db
      .prepare(
        "INSERT INTO messages(id,thread_id,user_id,role,kind,content,data,status,created_at) VALUES('guide-ai',?,?,'assistant','reply','可以继续选择',?,'done','2026-10-12T01:00:03.000Z')",
      )
      .run(
        f.threadId,
        f.owner.userId,
        JSON.stringify({ guide: { options: ["把明天的三件事排出顺序"] } }),
      );
    const selected = await f.app.inject({
      method: "POST",
      url: "/v1/chat/send",
      headers: f.owner.auth,
      payload: {
        threadId: f.threadId,
        text: "把明天的三件事排出顺序",
        mode: "auto",
        clientId: "guide-choice-001",
        tone: "light",
      },
    });
    const events = selected.body
      .split("\n\n")
      .filter((part) => part.startsWith("data: ") && part !== "data: [DONE]")
      .map((part) => JSON.parse(part.slice(6)));
    const question = events.find((event) => event.e === "start").question;
    assert.equal(question.guideChoice, true);
    const forged = await f.app.inject({
      method: "POST",
      url: "/v1/cards",
      headers: f.owner.auth,
      payload: {
        origin: "chat",
        srcId: f.threadId,
        messageId: question.id,
        type: "idea",
        mine: "把明天的三件事排出顺序",
      },
    });
    assert.equal(forged.statusCode, 400);
  } finally {
    await f.app.close();
  }
});
