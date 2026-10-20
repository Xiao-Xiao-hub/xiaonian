import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { CardService } from "../server/src/modules/cards/service.js";
import { CrisisSafetyService } from "../server/src/modules/safety/service.js";
import { ResumeService } from "../server/src/modules/resume/service.js";
import { WRAP_SYSTEM } from "../server/src/modules/chat/service.js";

// a reminder's date says when, the card's follow-up says how;
// chat wrap decides the follow-up by content and a later tidy may change an
// AI one, never the learner's. Synthetic text only.
function setup() {
  const store = new SqliteStore(":memory:");
  const user = store.upsertUser("dev:fx5c", "甲", "dev").id;
  const created = "2026-09-01T02:00:00.000Z";
  store.db
    .prepare(
      "UPDATE users SET data=json_set(data,'$.createdAt',?,'$.moodConsentAt',?) WHERE id=?",
    )
    .run(created, created, user);
  let date = new Date("2026-10-01T02:00:00.000Z");
  const clock = () => new Date(date);
  const safety = new CrisisSafetyService({ noul: async () => 0 });
  const cards = new CardService(store, safety, clock);
  const resume = new ResumeService(store, cards, safety, clock);
  const items = (cardId: string) =>
    store.db
      .prepare(
        "SELECT item_key,kind,state,due_on FROM resume_items WHERE src='card' AND src_id=? ORDER BY item_key",
      )
      .all(cardId)
      .map((r) => ({ ...r }));
  const asked = (cardId: string) =>
    resume.list(user).find((i) => i.card?.id === cardId)!;
  return {
    store,
    user,
    cards,
    resume,
    items,
    asked,
    set: (value: string) => {
      date = new Date(value);
    },
  };
}

test("F04: a 知识点 with a weekly reminder asks to recall it, and 做了 never closes it", async () => {
  const s = setup();
  try {
    const known = (
      await s.cards.create(s.user, {
        text: "等价无穷小：x 趋于 0 时 sin x ~ x",
        kind: "knowledge",
        mine: "sin x 和 x 在零点附近差不多",
      })
    ).card;
    await s.cards.update(s.user, known.id, s.cards.detail(s.user, known.id).version, {
      remindEvery: "week",
    });
    s.resume.sync(s.user);
    // Only the reminder: the spaced 还记得吗 waits while the learner's date asks.
    assert.deepEqual(
      s.items(known.id).map((i) => [i.item_key, i.kind, i.due_on]),
      [["remind:2026-10-08", "recall", "2026-10-08"]],
    );
    s.set("2026-10-08T02:00:00Z");
    const item = s.asked(known.id);
    assert.equal(item.kind, "recall");
    assert.doesNotMatch(item.question, /做了|约好/);
    assert.deepEqual(item.options, ["记住了", "有点忘", "不用提醒"]);
    assert.equal(item.canClose, false);
    // An old client sends the words it knows: 做了 is an answer, not a close.
    const answered = await s.resume.act(s.user, item.id, { action: "answer", text: "做了" });
    assert.equal(answered.offerClose, false);
    const after = s.cards.detail(s.user, known.id);
    assert.notEqual(after.stage, "closed");
    assert.equal(after.remindEvery, "week");
    assert.equal(after.remindOn, "2026-10-15");
  } finally {
    s.store.close();
  }
});

test("F04: 有点忘 on a repeating reminder asks again tomorrow", async () => {
  const s = setup();
  try {
    const known = (await s.cards.create(s.user, { text: "二战于1945年结束", kind: "knowledge" })).card;
    await s.cards.update(s.user, known.id, known.version, { remindEvery: "day" });
    s.set("2026-10-02T02:00:00Z");
    const item = s.asked(known.id);
    assert.equal(item.kind, "recall");
    await s.resume.act(s.user, item.id, { action: "answer", text: "有点忘" });
    assert.equal(s.cards.detail(s.user, known.id).remindOn, "2026-10-03");
    s.resume.sync(s.user);
    assert.deepEqual(
      s.items(known.id).filter((i) => i.state !== "done").map((i) => [i.item_key, i.due_on]),
      [["remind:2026-10-03", "2026-10-03"]],
    );
  } finally {
    s.store.close();
  }
});

test("F04: each follow-up asks its own way on a picked date; a 待办 still closes on 做了", async () => {
  const s = setup();
  try {
    const todo = (await s.cards.create(s.user, { text: "周五前交线代作业", kind: "todo" })).card;
    const talk = (await s.cards.create(s.user, { text: "保研和考研哪个更适合我", kind: "question" })).card;
    const note = (await s.cards.create(s.user, { text: "图书馆三楼靠窗有插座", kind: "note" })).card;
    for (const card of [todo, talk, note])
      await s.cards.update(s.user, card.id, s.cards.detail(s.user, card.id).version, {
        remindOn: "2026-10-05",
      });
    s.resume.sync(s.user);
    // The picked date stands in for the automatic item that asks the same way.
    assert.deepEqual(s.items(todo.id).map((i) => [i.item_key, i.kind]), [["remind:2026-10-05", "todo"]]);
    assert.deepEqual(s.items(talk.id).map((i) => [i.item_key, i.kind]), [["remind:2026-10-05", "chat"]]);
    assert.deepEqual(s.items(note.id).map((i) => [i.item_key, i.kind]), [["remind:2026-10-05", "look"]]);
    s.set("2026-10-05T02:00:00Z");
    assert.deepEqual(s.asked(talk.id).options, ["接着聊", "先放着", "不用提醒"]);
    const look = s.asked(note.id);
    assert.deepEqual(look.options, ["没有了", "写一句", "不用提醒"]);
    assert.deepEqual(look.acts, ["answer", "write", "never"]);
    assert.doesNotMatch(look.question, /做了|约好/);
    const ask = s.asked(todo.id);
    assert.deepEqual(ask.options, ["做了", "还没", "不用提醒"]);
    await s.resume.act(s.user, ask.id, { action: "answer", text: "做了" });
    assert.equal(s.cards.detail(s.user, todo.id).stage, "closed");
  } finally {
    s.store.close();
  }
});

test("F04: 不提醒 then a date (manual) still shows the reminder; old rows keep their kind's default", async () => {
  const s = setup();
  try {
    const known = (await s.cards.create(s.user, { text: "牛顿-莱布尼茨公式", kind: "knowledge" })).card;
    const off = await s.cards.update(s.user, known.id, known.version, { resume: "off" });
    const dated = await s.cards.update(s.user, known.id, off.card.version, { remindOn: "2026-10-04" });
    assert.equal(dated.card.resume, "manual");
    s.resume.sync(s.user);
    assert.equal(s.cards.detail(s.user, known.id).nextResumeOn, "2026-10-04");
    s.set("2026-10-04T02:00:00Z");
    assert.equal(s.asked(known.id).kind, "recall");
    // A v4.1 row: no kind, no follow. An idea's default is 接着聊.
    const old = (await s.cards.create(s.user, { text: "我觉得期末前不该再报竞赛", type: "idea" })).card;
    s.store.db.prepare("UPDATE cards SET kind=NULL,follow=NULL,remind_on='2026-10-06' WHERE id=?").run(old.id);
    s.resume.sync(s.user);
    assert.deepEqual(s.items(old.id).map((i) => [i.item_key, i.kind]), [["remind:2026-10-06", "chat"]]);
  } finally {
    s.store.close();
  }
});

test("F05: a later tidy updates an AI follow-up but never the learner's", async () => {
  const s = setup();
  try {
    const card = (await s.cards.create(s.user, { text: "背单词先过音标再造句", kind: "method" })).card;
    let detail = s.cards.applyAIData(s.user, card.id, card.version, { follow: "review" });
    assert.equal(detail.follow, "review");
    // 补充 / 再理一遍: the new judgement replaces the AI's own.
    detail = s.cards.applyAIData(s.user, card.id, detail.version, { follow: "chat" });
    assert.equal(detail.follow, "chat");
    // The 之后 chips are the learner's: a later tidy leaves them.
    const chosen = await s.cards.update(s.user, card.id, detail.version, { follow: "done" });
    detail = s.cards.applyAIData(s.user, card.id, chosen.card.version, { follow: "review" });
    assert.equal(detail.follow, "done");
    // A kind change without a follow-up clears the choice with it.
    const moved = await s.cards.update(s.user, card.id, detail.version, { kind: "idea" });
    detail = s.cards.applyAIData(s.user, card.id, moved.card.version, { follow: "chat" });
    assert.equal(detail.follow, "chat");
    detail = s.cards.applyAIData(s.user, card.id, detail.version, { follow: "review" });
    assert.equal(detail.follow, "review");

    // 不提醒 picked on saving is the learner's too.
    const quiet = (await s.cards.create(s.user, { text: "周末去图书馆", kind: "todo", follow: "none" })).card;
    detail = s.cards.applyAIData(s.user, quiet.id, quiet.version, { follow: "done" });
    assert.equal(detail.follow, "none");
  } finally {
    s.store.close();
  }
});

// Chat wrap over HTTP, the model's answer in the real JSON shape.
const USER_WORDS = "洛必达法则要求分母导数不为零，我得记住这个条件";
async function wrapFixture(cardFields: Record<string, unknown>) {
  const store = new SqliteStore(":memory:");
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      const q = body.questions.q;
      const answer =
        q.type === "noul"
          ? { noul: 0 }
          : {
              choice: Object.keys(q.criteria ?? {})[0] ?? "life",
              confidence: 0.9,
              probabilities: Object.fromEntries(
                Object.keys(q.criteria ?? {}).map((key) => [key, 0.9]),
              ),
            };
      return new Response(JSON.stringify({ answers: { q: answer } }));
    }
    if (!String(body.messages?.[0]?.content).includes("[CHAT_WRAP]"))
      throw new Error("only the wrap is asked here");
    const content = {
      summary: "洛必达的条件",
      cards: [
        {
          key: "main",
          type: "method",
          kind: "knowledge",
          title: "洛必达的条件",
          summary: "分母导数不能为零",
          quote: USER_WORDS,
          tags: ["极限"],
          ...cardFields,
        },
      ],
      open: [],
      next: null,
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
      UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-fx5c-")),
      FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-fx5c-formula-")),
      LOG_LEVEL: "silent",
      LLM_API_KEY: "test-llm",
      JEV_API_KEY: "test-jev",
    }),
  });
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: { key: "fx5c-wrap" },
  });
  const userId = login.json().data.user.id as string;
  const auth = { authorization: `Bearer ${login.json().data.token}` };
  const made = await app.inject({
    method: "POST",
    url: "/v1/chat/threads",
    headers: auth,
    payload: { text: "洛必达", tone: "light" },
  });
  const threadId = made.json().data.thread.id as string;
  store.db.prepare("UPDATE threads SET scene='study' WHERE id=?").run(threadId);
  const add = (id: string, role: string, content: string, at: string) =>
    store.db
      .prepare(
        "INSERT INTO messages(id,thread_id,user_id,role,kind,content,data,status,created_at) VALUES(?,?,?,?,?,?,'{}','done',?)",
      )
      .run(id, threadId, userId, role, "reply", content, at);
  add("fx5c-user", "user", USER_WORDS, "2026-10-12T01:00:00.000Z");
  add("fx5c-ai", "assistant", "对，条件很重要。", "2026-10-12T01:00:01.000Z");
  const wrap = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/v1/chat/threads/${threadId}/wrap`,
      headers: auth,
      payload,
    });
  const card = async (id: string) =>
    (await app.inject({ url: `/v1/cards/${id}`, headers: auth })).json().data;
  return { app, wrap, card };
}

test("F05: chat wrap names each card's follow-up and question; saving keeps them", async () => {
  assert.match(WRAP_SYSTEM, /follow/);
  assert.match(WRAP_SYSTEM, /review=/);
  const f = await wrapFixture({
    follow: "review",
    ask: { q: "洛必达要满足什么条件，还记得吗？", yes: "记住了", no: "有点忘" },
  });
  try {
    const opened = await f.wrap({ action: "open" });
    assert.equal(opened.statusCode, 200, opened.body);
    const draft = opened.json().data;
    assert.equal(draft.cards[0].follow, "review");
    assert.equal(draft.cards[0].ask.q, "洛必达要满足什么条件，还记得吗？");
    const saved = await f.wrap({ action: "save", draftId: draft.id, picks: ["main"] });
    assert.equal(saved.statusCode, 200, saved.body);
    const card = await f.card(saved.json().data.savedCardIds[0]);
    assert.equal(card.kind, "knowledge");
    assert.equal(card.follow, "review");
    assert.deepEqual(card.followAsk, {
      follow: "review",
      q: "洛必达要满足什么条件，还记得吗？",
      yes: "记住了",
      no: "有点忘",
    });
  } finally {
    await f.app.close();
  }
});

test("F05: a follow-up picked on the save page wins; a bad or missing one falls back to the kind", async () => {
  const picked = await wrapFixture({ follow: "chat", ask: null });
  try {
    const draft = (await picked.wrap({ action: "open" })).json().data;
    const saved = await picked.wrap({ action: "save", draftId: draft.id, picks: ["main"], follow: "none" });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal((await picked.card(saved.json().data.savedCardIds[0])).follow, "none");
  } finally {
    await picked.app.close();
  }
  const bad = await wrapFixture({ follow: "sometimes", ask: { q: 1 } });
  try {
    const opened = await bad.wrap({ action: "open" });
    assert.equal(opened.statusCode, 200, opened.body);
    const draft = opened.json().data;
    assert.equal(draft.cards[0].follow, undefined);
    const saved = await bad.wrap({ action: "save", draftId: draft.id, picks: ["main"] });
    const card = await bad.card(saved.json().data.savedCardIds[0]);
    // The kind's default: a 知识点 is reviewed.
    assert.equal(card.follow, "review");
    assert.equal(card.followAsk, null);
  } finally {
    await bad.app.close();
  }
});
