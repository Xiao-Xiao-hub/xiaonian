import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { CardService } from "../server/src/modules/cards/service.js";
import {
  CardTidyService,
  validateTidy,
} from "../server/src/modules/cards/tidy.js";
import { CrisisSafetyService } from "../server/src/modules/safety/service.js";
import { JobRunner } from "../server/src/modules/jobs/runner.js";
import type { LlmClient } from "../server/src/providers/llm.js";

// 存成卡 on one AI reply (问 AI / 聊一聊): the card gets the student's question
// as 原话, a plain-text gist, a title, and a scene that follows the content.
const REPLY =
  "**思路：用重要极限 $\\lim\\limits_{u\\to 0}\\dfrac{\\sin u}{u}=1$。**\n\n这道题分子是 $\\sin 3x$，令 $u=3x$，结果是 3。";

function setup(judged?: { choice: string; confidence: number }) {
  const store = new SqliteStore(":memory:");
  const user = store.upsertUser("dev:chat-card", "测试", "dev").id;
  const judgeCalls: string[] = [];
  const judge = judged
    ? {
        choice: async (input: { text: string }) => {
          judgeCalls.push(input.text);
          return judged;
        },
      }
    : undefined;
  const cards = new CardService(
    store,
    new CrisisSafetyService({ noul: async () => 0 }),
    undefined,
    undefined,
    judge as never,
  );
  let at = 0;
  const thread = (id: string, scene = "study", data = "{}") =>
    store.db
      .prepare(
        "INSERT INTO threads(id,user_id,title,scene,data,created_at,updated_at) VALUES(?,?,'t',?,?,?,?)",
      )
      .run(id, user, scene, data, "2026-10-14T00:00:00.000Z", "2026-10-14T00:00:00.000Z");
  const message = (
    id: string,
    threadId: string,
    role: string,
    content: string,
    data: Record<string, unknown> = {},
  ) =>
    store.db
      .prepare(
        "INSERT INTO messages(id,thread_id,user_id,role,kind,content,data,status,created_at) VALUES(?,?,?,?,?,?,?,'done',?)",
      )
      .run(
        id,
        threadId,
        user,
        role,
        role === "user" ? "text" : "reply",
        content,
        JSON.stringify(data),
        `2026-10-14T00:00:0${at++}.000Z`,
      );
  return { store, user, cards, thread, message, judgeCalls };
}

test("a card saved from an AI reply keeps the question as 原话, a plain gist and a short title", async () => {
  const s = setup();
  try {
    s.thread("t1");
    s.message("q1", "t1", "user", "求 lim(x→0) sin3x/x");
    s.message("r1", "t1", "assistant", REPLY);
    // A tapped option is not the student's question.
    s.message("q2", "t1", "user", "再给一步提示", { guideChoice: true });
    s.message("r2", "t1", "assistant", "令 $u=3x$，再看 $\\dfrac{\\sin u}{u}$。");
    const { card } = await s.cards.create(s.user, {
      origin: "chat",
      srcId: "t1",
      messageId: "r2",
      type: "question",
    });
    assert.equal(card.quote, "求 lim(x→0) sin3x/x");
    assert.ok(card.summary);
    assert.doesNotMatch(card.summary!, /[*$\\]/);
    assert.match(card.summary!, /u=3x/);
    assert.equal(card.scene, "study");
    // 17 characters: too long for a title, the tidy job names it.
    assert.equal(card.title, "");
    assert.equal(card.titleBy, "ai");

    s.thread("t2");
    s.message("q3", "t2", "user", "周末怎么安排才能放松一点？");
    s.message("r3", "t2", "assistant", "**先说结论**：留一两件想做的事。");
    const life = (
      await s.cards.create(s.user, { origin: "chat", srcId: "t2", messageId: "r3" })
    ).card;
    assert.equal(life.title, "周末怎么安排才能放松一点");
    assert.equal(life.titleBy, "ai");
    assert.equal(life.summary, "先说结论：留一两件想做的事。");
    // No judge: the chat's scene stays.
    assert.equal(life.scene, "study");
  } finally {
    s.store.close();
  }
});

test("the scene of a card from a 问 AI chat follows its content, never mood", async () => {
  const s = setup({ choice: "life", confidence: 0.9 });
  try {
    s.thread("t1");
    s.message("q1", "t1", "user", "周末怎么安排才能放松一点？");
    s.message("r1", "t1", "assistant", "留一两件想做的事，其余时间空着。");
    const life = await s.cards.create(s.user, {
      origin: "chat",
      srcId: "t1",
      messageId: "r1",
      type: "idea",
    });
    assert.equal(life.card.scene, "life");
    assert.equal(s.judgeCalls.length, 1);
    assert.match(s.judgeCalls[0]!, /周末/);

    // A problem is study without asking the judge, even if it would say life.
    s.thread("t2");
    s.message("q2", "t2", "user", "求 lim(x→0) sin3x/x");
    s.message("r2", "t2", "assistant", REPLY);
    const study = await s.cards.create(s.user, {
      origin: "chat",
      srcId: "t2",
      messageId: "r2",
      type: "question",
    });
    assert.equal(study.card.scene, "study");
    assert.equal(s.judgeCalls.length, 1);

    // A chat about a map point stays study.
    s.thread("t3", "study", JSON.stringify({ pointId: "limit-def" }));
    s.message("q4", "t3", "user", "周末怎么安排才能放松一点？");
    s.message("r4", "t3", "assistant", "留一两件想做的事。");
    const point = await s.cards.create(s.user, {
      origin: "chat",
      srcId: "t3",
      messageId: "r4",
      type: "idea",
    });
    assert.equal(point.card.scene, "study");

    // A life or mood chat keeps its own scene.
    s.store.db
      .prepare("UPDATE users SET data=json_set(data,'$.moodConsentAt',?) WHERE id=?")
      .run("2026-10-14T00:00:00.000Z", s.user);
    s.thread("t4", "mood");
    s.message("q5", "t4", "user", "今天有点累，想说说话");
    s.message("r5", "t4", "assistant", "「有点累」，想先说说发生了什么吗？");
    const mood = await s.cards.create(s.user, {
      origin: "chat",
      srcId: "t4",
      messageId: "r5",
      type: "idea",
    });
    assert.equal(mood.card.scene, "mood");
    assert.equal(s.judgeCalls.length, 1);
  } finally {
    s.store.close();
  }
});

test("the tidy of an AI-reply card sees the reply, and numbers from it are kept", async () => {
  const s = setup();
  const calls: { content: unknown }[][] = [];
  const llm = {
    configured: true,
    model: "fake",
    json: async (messages: { content: unknown }[]) => {
      calls.push(messages);
      return {
        data: {
          title: "sin3x/x 的极限是 3",
          summary: "用重要极限，令 u=3x，结果是 3。",
          slots: [],
          open: [],
          followup: { q: "下一步做什么", options: ["换一道题", "看看公式"] },
          tags: ["极限"],
        },
        usage: { provider: "fake", model: "fake", calls: 1, promptTokens: 1, completionTokens: 1, ms: 1 },
      };
    },
  } as unknown as LlmClient;
  const tidy = new CardTidyService(s.store, s.cards, llm);
  const runner = new JobRunner(s.store, tidy.handlers(), {
    concurrency: 1,
    timeoutMs: 2000,
    limits: { notes: 30 },
    log: (error) => console.error(error),
  });
  try {
    s.thread("t1");
    s.message("q1", "t1", "user", "求 lim(x→0) sin3x/x");
    s.message("r1", "t1", "assistant", REPLY);
    const { card } = await s.cards.create(s.user, {
      origin: "chat",
      srcId: "t1",
      messageId: "r1",
      type: "question",
    });
    const queued = tidy.enqueue(s.user, card.id, card.version, runner)!;
    for (let i = 0; i < 100; i++) {
      const job = runner.get(queued.job.id)!;
      if (!["queued", "running"].includes(job.status)) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(runner.get(queued.job.id)!.status, "succeeded");
    const input = JSON.parse(String(calls[0]![1]!.content));
    assert.match(input.reply, /sin 3x/);
    assert.doesNotMatch(input.reply, /[*$]/);
    const after = s.cards.detail(s.user, card.id);
    assert.equal(after.title, "sin3x/x 的极限是 3");
    assert.equal(after.summary, "用重要极限，令 u=3x，结果是 3。");
    assert.equal(after.quote, "求 lim(x→0) sin3x/x");

    // Without the text the model saw, a number from nowhere is still dropped.
    const bare = validateTidy(
      {
        title: "7 天计划",
        summary: "要点",
        slots: [],
        open: [],
        followup: { q: "下一步", options: ["一", "二"] },
        tags: [],
      },
      after,
      JSON.stringify({ reply: "没有数字" }),
    );
    assert.equal(bare.title, undefined);

    // A long summary ends at a full sentence, not mid-word.
    const long = validateTidy(
      {
        title: "极限",
        summary: `先用半角公式把分子化成正弦，再看分母和重要极限的关系。${"再把分母凑成相关的形式".repeat(6)}`,
        slots: [],
        open: [],
        followup: { q: "下一步", options: ["一", "二"] },
        tags: [],
      },
      after,
    );
    assert.equal(long.summary, "先用半角公式把分子化成正弦，再看分母和重要极限的关系。");
  } finally {
    await runner.stop();
    s.store.close();
  }
});
