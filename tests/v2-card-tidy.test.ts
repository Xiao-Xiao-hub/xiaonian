import assert from "node:assert/strict";
import test from "node:test";
import { fakeServices, makeApp } from "./fixtures.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { CardService } from "../server/src/modules/cards/service.js";
import {
  CardTidyService,
  validateTidy,
} from "../server/src/modules/cards/tidy.js";
import { CrisisSafetyService } from "../server/src/modules/safety/service.js";
import { JobRunner } from "../server/src/modules/jobs/runner.js";
import { ProviderError, type LlmClient } from "../server/src/providers/llm.js";

const result = {
  title: "先理清安排",
  summary: "想先理清学习安排",
  slots: [{ key: "claim", text: "先列出任务" }],
  open: [
    { key: "start", cat: "decide", text: "先从哪里开始", quote: "学习安排" },
  ],
  followup: { q: "准备先做什么", options: ["列出任务", "排好时间"] },
  tags: ["学习"],
};
test("saving a card automatically queues one tidy and keeps a durable job for the detail page", async () => {
  const services = fakeServices();
  services.judge.noul = 0;
  const store = new SqliteStore(":memory:");
  const app = makeApp(services, {}, undefined, store);
  try {
    const login = (
      await app.inject({
        method: "POST",
        url: "/v1/auth/dev-login",
        payload: { key: "tidy-api" },
      })
    ).json().data;
    const headers = { authorization: `Bearer ${login.token}` };
    const saved = await app.inject({
      method: "POST",
      url: "/v1/cards",
      headers,
      payload: { text: "我想先理清这周要做的事情", type: "idea" },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const card = saved.json().data.card;
    for (let i = 0; i < 100; i++) {
      const current = (
        await app.inject({ url: `/v1/cards/${card.id}`, headers })
      ).json().data;
      if (current.aiJob?.status === "succeeded") {
        assert.equal(current.stage, "written");
        assert.equal(current.mine, null);
        assert.equal(current.titleBy, "ai");
        assert.equal(current.quote, "我想先理清这周要做的事情");
        assert.equal(
          services.llm.filter((call) => call.kind === "card_tidy").length,
          1,
        );
        return;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail("automatic tidy did not finish");
  } finally {
    await app.close();
  }
});
function setup(limit = 30, run?: () => Promise<void>) {
  const store = new SqliteStore(":memory:");
  const user = store.upsertUser("dev:tidy", "测试", "dev").id;
  const calls: unknown[][] = [];
  const llm = {
    configured: true,
    model: "fake",
    json: async (...args: unknown[]) => {
      calls.push(args);
      await run?.();
      return {
        data: result,
        usage: {
          provider: "fake",
          model: "fake",
          calls: 1,
          promptTokens: 1,
          completionTokens: 1,
          ms: 1,
        },
      };
    },
  } as unknown as LlmClient;
  const cards = new CardService(
    store,
    new CrisisSafetyService({ noul: async () => 0 }),
  );
  const tidy = new CardTidyService(store, cards, llm);
  const runner = new JobRunner(store, tidy.handlers(), {
    concurrency: 4,
    timeoutMs: 2000,
    limits: { notes: limit },
    log: (error) => {
      console.error(error);
    },
  });
  return {
    store,
    user,
    calls,
    llm,
    cards,
    tidy,
    runner,
    async close() {
      await runner.stop();
      store.close();
    },
  };
}
async function finish(runner: JobRunner, id: string) {
  for (let i = 0; i < 100; i++) {
    const job = runner.get(id)!;
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("synthetic job did not settle");
}

test("tidy writes AI fields without advancing stages; duplicates reuse one quota receipt", async () => {
  const s = setup();
  try {
    const card = (
      await s.cards.create(s.user, { text: "学习安排需要先理清", type: "idea" })
    ).card;
    const a = s.tidy.enqueue(s.user, card.id, 1, s.runner)!;
    const b = s.tidy.enqueue(s.user, card.id, 1, s.runner)!;
    assert.equal(a.job.id, b.job.id);
    const finished = await finish(s.runner, a.job.id);
    assert.equal(finished.status, "succeeded", JSON.stringify(finished.error));
    assert.equal(s.calls.length, 1);
    assert.equal(s.runner.usedToday(s.user, "notes"), 1);
    const updated = s.cards.detail(s.user, card.id);
    assert.equal(updated.title, result.title);
    assert.equal(updated.stage, "written");
    assert.equal(updated.mine, null);
    assert.equal(updated.quote, card.quote);
    assert.equal(updated.tags.length, 1);
    assert.deepEqual(s.calls[0]![3], {
      scenario: "card_tidy",
      maxTokens: 800,
      truncateAsError: true,
    });
    assert.equal(s.tidy.latest(s.user, card.id)!.status, "succeeded");
  } finally {
    await s.close();
  }
});

test("quota exhaustion skips automatic tidy silently and manual request asks for tomorrow", async () => {
  const s = setup(0);
  try {
    const card = (
      await s.cards.create(s.user, { text: "学习安排需要先理清", type: "idea" })
    ).card;
    assert.equal(
      s.tidy.enqueue(s.user, card.id, 1, s.runner, { automatic: true }),
      null,
    );
    assert.throws(() => s.tidy.enqueue(s.user, card.id, 1, s.runner), {
      code: "DAILY_LIMIT",
      message: "今天理卡的次数用完了，明天再来",
    });
    assert.equal(s.calls.length, 0);
    assert.equal(s.cards.detail(s.user, card.id).quote, card.quote);
  } finally {
    await s.close();
  }
});

test("unsupported numbers and forged quotes are removed individually, and text is bounded", async () => {
  const s = setup();
  try {
    const card = (
      await s.cards.create(s.user, { text: "学习安排需要先理清", type: "idea" })
    ).card;
    const clean = validateTidy(
      {
        ...result,
        title: "计划7天完成",
        summary: "摘要".repeat(70),
        slots: [
          ...result.slots,
          { key: "why", text: "需要3小时" },
          { key: "ask", text: "错误类型" },
        ],
        open: [
          ...result.open,
          { key: "fake", cat: "verify", text: "核实一下", quote: "没有的原话" },
        ],
        tags: ["学习", "学习", "非常长的标签名字", "另一个"],
      },
      card,
    );
    assert.equal(clean.title, undefined);
    assert.equal(clean.summary!.length, 60);
    assert.equal(clean.slots!.length, 1);
    assert.equal(clean.open!.length, 1);
    assert.deepEqual(clean.tags, ["学习", "非常长的标签", "另一个"]);
  } finally {
    await s.close();
  }
});

test("version changes and deletion during the network call cannot be overwritten", async () => {
  for (const remove of [false, true]) {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = setup(30, () => waiting);
    try {
      const card = (
        await s.cards.create(s.user, {
          text: "学习安排需要先理清",
          type: "idea",
        })
      ).card;
      const queued = s.tidy.enqueue(s.user, card.id, 1, s.runner)!;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (remove) s.cards.remove(s.user, card.id);
      else
        await s.cards.update(s.user, card.id, 1, { title: "用户刚改的标题" });
      release();
      const done = await finish(s.runner, queued.job.id);
      assert.equal(done.status, "failed");
      if (remove)
        assert.throws(() => s.cards.detail(s.user, card.id), {
          code: "NOT_FOUND",
        });
      else
        assert.equal(s.cards.detail(s.user, card.id).title, "用户刚改的标题");
    } finally {
      release();
      await s.close();
    }
  }
});

test("truncated output is failed, and unknown outcomes require an explicit retry", async () => {
  const s = setup(30, async () => {
    throw new ProviderError("OUTPUT_TRUNCATED", "输出被截断", "unknown");
  });
  try {
    const card = (
      await s.cards.create(s.user, { text: "学习安排需要先理清", type: "idea" })
    ).card;
    const queued = s.tidy.enqueue(s.user, card.id, 1, s.runner)!;
    assert.equal((await finish(s.runner, queued.job.id)).status, "failed");
    assert.equal(s.calls.length, 1);
    assert.equal(s.cards.detail(s.user, card.id).title, "");
    s.store.db
      .prepare("UPDATE jobs SET status='unknown' WHERE id=?")
      .run(queued.job.id);
    assert.throws(() => s.tidy.enqueue(s.user, card.id, 1, s.runner), {
      code: "JOB_UNKNOWN",
    });
    const retried = s.tidy.enqueue(s.user, card.id, 1, s.runner, {
      retryUnknown: true,
    })!;
    assert.notEqual(retried.job.id, queued.job.id);
    await finish(s.runner, retried.job.id);
    // both attempts failed, so neither is charged.
    assert.equal(s.runner.usedToday(s.user, "notes"), 0);
  } finally {
    await s.close();
  }
});

test("answering and thinking have different stages; crisis answers never persist", async () => {
  const s = setup();
  try {
    const card = (
      await s.cards.create(s.user, { text: "学习安排需要先理清", type: "idea" })
    ).card;
    const ai = s.cards.applyAIData(s.user, card.id, 1, result);
    const thinking = await s.cards.answer(s.user, card.id, ai.version, {
      kind: "followup",
      action: "thinking",
    });
    assert.equal(thinking.card.stage, "written");
    const crisis = await s.cards.answer(
      s.user,
      card.id,
      thinking.card.version,
      { kind: "followup", action: "answer", text: "我不想活了" },
    );
    assert.equal(crisis.crisis, true);
    assert.equal(crisis.card.version, thinking.card.version);
    const answered = await s.cards.answer(
      s.user,
      card.id,
      thinking.card.version,
      {
        kind: "followup",
        action: "answer",
        text: "我决定先列出这周要完成的事情",
      },
    );
    assert.equal(answered.card.stage, "organized");
    assert.equal(answered.offerMine, true);
    assert.equal(answered.card.mine, null);
    const done = await s.cards.answer(s.user, card.id, answered.card.version, {
      kind: "open",
      key: "start",
      action: "done",
    });
    assert.equal(done.card.open.length, 0);
    const retidy = s.cards.applyAIData(
      s.user,
      card.id,
      done.card.version,
      result,
    );
    assert.equal(retidy.open.length, 0);
  } finally {
    await s.close();
  }
});
