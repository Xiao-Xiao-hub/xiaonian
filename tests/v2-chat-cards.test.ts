import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";

function services() {
  let jevGate: Promise<void> | undefined,
    enterJev: (() => void) | undefined,
    releaseJev: (() => void) | undefined;
  const state = {
    requests: [] as Record<string, any>[],
    jev: 0,
    jevEntered: Promise.resolve(),
    pauseJev() {
      this.jevEntered = new Promise<void>((resolve) => {
        enterJev = resolve;
      });
      jevGate = new Promise<void>((resolve) => {
        releaseJev = resolve;
      });
    },
    releaseJev() {
      releaseJev?.();
    },
  };
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      state.jev++;
      if (jevGate) {
        enterJev?.();
        await jevGate;
        jevGate = undefined;
        enterJev = undefined;
        releaseJev = undefined;
      }
      const q = body.questions.q;
      const probabilities = Object.fromEntries(
        Object.keys(q.criteria ?? {}).map((id) => [
          id,
          id.startsWith("card-related")
            ? 0.92
            : id === "card-low"
              ? 0.59
              : id === "none"
                ? 0.08
                : 0.1,
        ]),
      );
      const answer =
        q.type === "noul"
          ? { noul: 0 }
          : {
              choice: Object.keys(q.criteria ?? {})[0],
              confidence: 0.92,
              probabilities,
            };
      return new Response(JSON.stringify({ answers: { q: answer } }));
    }
    state.requests.push(body);
    const content = body.messages[0].content.includes("好奇的同学")
      ? '我听到你在解释这一步。哪里最容易跳过去？<verify>{"answer":"错"}</verify><guide>{"options":["泄漏"]}</guide>'
      : '先沿着这件事往下想。<guide>{"quote":"","options":["继续"]}</guide>';
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
          ),
        );
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\n`,
          ),
        );
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  return { fetcher, state };
}

async function fixture() {
  const fake = services(),
    store = new SqliteStore(":memory:");
  const app = buildApp({
    store,
    fetcher: fake.fetcher,
    env: loadEnv({
      NODE_ENV: "test",
      DEV_LOGIN_ENABLED: "true",
      DATABASE_PATH: ":memory:",
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-cards-chat-")),
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-cards-formula-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "test-llm",
      JEV_API_KEY: "test-jev",
    }),
  });
  const login = async (key: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key },
    });
    return {
      auth: { authorization: `Bearer ${res.json().data.token}` },
      userId: res.json().data.user.id as string,
    };
  };
  const one = await login("cards-one"),
    two = await login("cards-two");
  const card = (
    id: string,
    userId = one.userId,
    scene = "study",
    crisis = 0,
    title = id,
    mine: string | null = `我的话-${id}`,
  ) =>
    store.db
      .prepare(
        "INSERT INTO cards(id,user_id,type,scene,title,title_by,summary,mine,slots,open,origin,crisis,created_at,updated_at) VALUES(?,?,?,?,?,'user',?,?,?,'[]','jot',?,?,?)",
      )
      .run(
        id,
        userId,
        "idea",
        scene,
        title,
        `摘要-${id}`,
        mine,
        JSON.stringify([
          { key: "a", text: "一" },
          { key: "b", text: "二" },
          { key: "c", text: "三" },
        ]),
        crisis,
        "2026-10-12T00:00:00.000Z",
        "2026-10-12T00:00:00.000Z",
      );
  const thread = async (extra: Record<string, unknown> = {}) =>
    (
      await app.inject({
        method: "POST",
        url: "/v1/chat/threads",
        headers: one.auth,
        payload: { text: "求导数 x 的平方", tone: "light", ...extra },
      })
    ).json().data.thread;
  const events = (body: string) =>
    body
      .split("\n\n")
      .filter((x) => x.startsWith("data: ") && x !== "data: [DONE]")
      .map((x) => JSON.parse(x.slice(6)) as Record<string, any>);
  return { app, store, fake, one, two, card, thread, events };
}

test("带卡接口逐张校验所有权、危机标记和三张上限", async () => {
  const f = await fixture();
  try {
    ["card-a", "card-b", "card-c", "card-d"].forEach((id) => f.card(id));
    f.card("card-crisis", f.one.userId, "life", 1);
    f.card("card-other", f.two.userId);
    const t = await f.thread();
    const put = (ids: string[]) =>
      f.app.inject({
        method: "PUT",
        url: `/v1/chat/threads/${t.id}/cards`,
        headers: f.one.auth,
        payload: { cardIds: ids, tone: "light" },
      });
    assert.equal(
      (await put(["card-a", "card-b", "card-c", "card-d"])).statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/chat/send",
          headers: f.one.auth,
          payload: {
            threadId: t.id,
            text: "继续",
            cardIds: ["card-a", "card-b", "card-c", "card-d"],
            mode: "auto",
            clientId: "four-cards-client",
            tone: "light",
          },
        })
      ).statusCode,
      400,
    );
    assert.equal((await put(["card-crisis"])).statusCode, 409);
    assert.equal((await put(["card-other"])).statusCode, 404);
    const ok = await put(["card-a", "card-b", "card-c"]);
    assert.deepEqual(
      ok.json().data.thread.currentCards.map((c: any) => c.id),
      ["card-a", "card-b", "card-c"],
    );
  } finally {
    await f.app.close();
  }
});

test("只把所选卡写入提示和消息快照，使用次数幂等且心情标记只设不清", async () => {
  const f = await fixture();
  try {
    f.card("card-picked", f.one.userId, "study", 0, "选中的标题");
    f.card("card-mood", f.one.userId, "mood", 0, "心情标题", null);
    f.card("card-secret", f.one.userId, "life", 0, "未选择秘密");
    const t = await f.thread();
    const payload = {
      threadId: t.id,
      text: "我想理清计划",
      cardIds: ["card-picked", "card-mood"],
      mode: "auto",
      clientId: "cards-client-001",
      tone: "light",
    };
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/chat/send",
          headers: f.one.auth,
          payload: { ...payload, clientId: "cards-no-consent" },
        })
      ).statusCode,
      409,
    );
    await f.app.inject({
      method: "PUT",
      url: "/v1/me/mood-consent",
      headers: f.one.auth,
    });
    const sent = await f.app.inject({
      method: "POST",
      url: "/v1/chat/send",
      headers: f.one.auth,
      payload,
    });
    const prompt = JSON.stringify(f.fake.state.requests[0].messages);
    assert.match(prompt, /选中的标题/);
    assert.match(prompt, /心情标题/);
    assert.doesNotMatch(prompt, /未选择秘密/);
    const start = f.events(sent.body).find((event) => event.e === "start")!;
    assert.deepEqual(
      start.question.cards.map((c: any) => c.id),
      ["card-picked", "card-mood"],
    );
    await f.app.inject({
      method: "POST",
      url: "/v1/chat/send",
      headers: f.one.auth,
      payload,
    });
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) n FROM card_uses WHERE ref_id=?")
        .get(t.id)!.n,
      2,
    );
    assert.deepEqual(
      f.store.db
        .prepare(
          "SELECT id,use_count FROM cards WHERE id IN ('card-picked','card-mood') ORDER BY id",
        )
        .all()
        .map((row) => ({
          id: String(row.id),
          use_count: Number(row.use_count),
        })),
      [
        { id: "card-mood", use_count: 1 },
        { id: "card-picked", use_count: 1 },
      ],
    );
    const cleared = await f.app.inject({
      method: "PUT",
      url: `/v1/chat/threads/${t.id}/cards`,
      headers: f.one.auth,
      payload: { cardIds: [], tone: "light" },
    });
    assert.deepEqual(cleared.json().data.thread.currentCards, []);
    assert.equal(cleared.json().data.thread.moodCards, true);
  } finally {
    await f.app.close();
  }
});

test("推荐遵守开关、阈值、已带卡和本线程忽略列表", async () => {
  const f = await fixture();
  try {
    f.card("card-current");
    f.card("card-related");
    f.card("card-low");
    f.card("card-danger", f.one.userId, "life", 1);
    const t = await f.thread();
    await f.app.inject({
      method: "PUT",
      url: `/v1/chat/threads/${t.id}/cards`,
      headers: f.one.auth,
      payload: { cardIds: ["card-current"], tone: "light" },
    });
    const suggest = (body: unknown) =>
      f.app.inject({
        method: "POST",
        url: `/v1/chat/threads/${t.id}/suggest-cards`,
        headers: f.one.auth,
        payload: body,
      });
    assert.deepEqual(
      (await suggest({ text: "相关内容" }))
        .json()
        .data.cards.map((c: any) => c.id),
      ["card-related"],
    );
    assert.deepEqual(
      (await suggest({ text: "相关内容", omitIds: ["card-related"] })).json()
        .data.cards,
      [],
    );
    assert.equal(
      (
        await f.app.inject({ url: "/v1/me/suggest-cards", headers: f.one.auth })
      ).json().data.enabled,
      true,
    );
    await f.app.inject({
      method: "PUT",
      url: "/v1/me/suggest-cards",
      headers: f.one.auth,
      payload: { enabled: false },
    });
    const before = f.fake.state.jev;
    assert.deepEqual(
      (await suggest({ text: "相关内容" })).json().data.cards,
      [],
    );
    assert.equal(f.fake.state.jev, before);
  } finally {
    await f.app.close();
  }
});

test("推荐等待判断期间会重新核对卡片与心情同意", async () => {
  const f = await fixture();
  try {
    f.card("card-related-deleted");
    f.card("card-related-mood", f.one.userId, "mood");
    await f.app.inject({
      method: "PUT",
      url: "/v1/me/mood-consent",
      headers: f.one.auth,
    });
    const t = await f.thread();
    f.fake.state.pauseJev();
    const pending = f.app.inject({
      method: "POST",
      url: `/v1/chat/threads/${t.id}/suggest-cards`,
      headers: f.one.auth,
      payload: { text: "相关内容" },
    });
    await f.fake.state.jevEntered;
    f.store.db
      .prepare("DELETE FROM cards WHERE id=? AND user_id=?")
      .run("card-related-deleted", f.one.userId);
    await f.app.inject({
      method: "DELETE",
      url: "/v1/me/mood-consent",
      headers: f.one.auth,
    });
    f.fake.state.releaseJev();
    const response = await pending;
    assert.deepEqual(response.json().data.cards, []);
    assert.doesNotMatch(response.body, /card-related|我的话|摘要/);
  } finally {
    await f.app.close();
  }
});

test("teach 禁止心情模式、跳过解题验算并隐藏 guide", async () => {
  const f = await fixture();
  try {
    f.card("card-life-teach", f.one.userId, "life");
    const fromCard = await f.thread({
      mode: "teach",
      cardIds: ["card-life-teach"],
    });
    assert.equal(fromCard.scene, "life");
    f.card("card-mood-teach", f.one.userId, "mood");
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/chat/threads",
          headers: f.one.auth,
          payload: {
            text: "从这张卡开始",
            mode: "teach",
            cardIds: ["card-mood-teach"],
            tone: "light",
          },
        })
      ).statusCode,
      409,
    );
    const t = await f.thread({
      mode: "teach",
      pointId: "application-taylor-limit",
    });
    assert.equal(t.mode, "teach");
    assert.equal(t.pointId, "application-taylor-limit");
    await f.app.inject({
      method: "PUT",
      url: "/v1/me/mood-consent",
      headers: f.one.auth,
    });
    assert.equal(
      (
        await f.app.inject({
          method: "PUT",
          url: `/v1/chat/threads/${t.id}/cards`,
          headers: f.one.auth,
          payload: { cardIds: ["card-mood-teach"], tone: "light" },
        })
      ).statusCode,
      409,
    );
    const mood = await f.app.inject({
      method: "PATCH",
      url: `/v1/chat/threads/${t.id}`,
      headers: f.one.auth,
      payload: { scene: "mood", tone: "light" },
    });
    assert.equal(mood.json().data.thread.mode, "guide");
    assert.equal(
      (
        await f.app.inject({
          method: "PATCH",
          url: `/v1/chat/threads/${t.id}`,
          headers: f.one.auth,
          payload: { mode: "teach", tone: "light" },
        })
      ).statusCode,
      409,
    );

    const teach = await f.thread({ mode: "teach" });
    const sent = await f.app.inject({
      method: "POST",
      url: "/v1/chat/send",
      headers: f.one.auth,
      payload: {
        threadId: teach.id,
        text: "所以 x 平方的导数是二 x",
        mode: "auto",
        teachDone: true,
        clientId: "teach-client-001",
        tone: "light",
      },
    });
    const done = f
      .events(sent.body)
      .find((event) => event.e === "done")!.message;
    assert.equal(done.guide, null);
    assert.equal(done.verify, null);
    assert.equal(done.quote, "所以 x 平方的导数是二 x");
    assert.match(
      f.fake.state.requests.at(-1)!.messages[0].content,
      /好奇又友善的同学/,
    );
    assert.match(
      f.fake.state.requests.at(-1)!.messages[0].content,
      /最多用 3 句话/,
    );
    assert.equal(f.fake.state.requests.length, 1);
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) n FROM retests WHERE user_id=?")
        .get(f.one.userId)!.n,
      0,
    );
  } finally {
    await f.app.close();
  }
});
