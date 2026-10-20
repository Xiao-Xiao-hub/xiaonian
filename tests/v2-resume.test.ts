import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { CardService } from "../server/src/modules/cards/service.js";
import { CrisisSafetyService } from "../server/src/modules/safety/service.js";
import { ResumeService } from "../server/src/modules/resume/service.js";

function setup(created = "2026-10-01T02:00:00.000Z") {
  const store = new SqliteStore(":memory:");
  const user = store.upsertUser("dev:resume", "甲", "dev").id;
  const other = store.upsertUser("dev:resume-other", "乙", "dev").id;
  store.db
    .prepare(
      "UPDATE users SET data=json_set(data,'$.createdAt',?,'$.moodConsentAt',?) WHERE id=?",
    )
    .run(created, created, user);
  let date = new Date(created);
  const clock = () => new Date(date);
  const safety = new CrisisSafetyService({ noul: async () => 0 });
  const cards = new CardService(store, safety, clock);
  const resume = new ResumeService(store, cards, safety, clock);
  return {
    store,
    user,
    other,
    cards,
    resume,
    set: (value: string) => {
      date = new Date(value);
    },
  };
}

test("new-user first card appears after two days and one visit is idempotent", async () => {
  const s = setup();
  try {
    const card = (
      await s.cards.create(s.user, {
        text: "想把这周的任务安排清楚",
        type: "idea",
      })
    ).card;
    s.set("2026-10-02T02:00:00Z");
    assert.equal(s.resume.open(s.user, "one").item, null);
    s.set("2026-10-03T02:00:00Z");
    const first = s.resume.open(s.user, "two");
    assert.equal(first.kind, "item");
    assert.equal(first.item!.card!.id, card.id);
    const again = s.resume.open(s.user, "two");
    assert.equal(again.item!.id, first.item!.id);
    assert.equal(
      s.store.db
        .prepare("SELECT count(*) AS n FROM events WHERE name='resume_show'")
        .get()!.n,
      1,
    );
    assert.throws(() => s.resume.get(s.other, first.item!.id), {
      code: "NOT_FOUND",
    });
  } finally {
    s.store.close();
  }
});

test("two unanswered visits defer exactly three days then go dormant; a real edit revives", async () => {
  const s = setup("2026-09-01T02:00:00Z");
  try {
    s.set("2026-10-01T02:00:00Z");
    await s.cards.create(s.user, { text: "第一张先记录", type: "idea" });
    const card = (
      await s.cards.create(s.user, {
        text: "按步骤来安排这一件事",
        type: "method",
      })
    ).card;
    s.set("2026-10-08T02:00:00Z");
    s.resume.setSettings(s.user, {
      ...s.resume.settings(s.user),
      types: { study: false, cards: true, mood: false },
    });
    s.resume.sync(s.user);
    const item = s.resume.list(s.user).find((i) => i.card?.id === card.id)!;
    await s.resume.act(s.user, item.id, { action: "skip" });
    let row = s.store.db
      .prepare("SELECT * FROM resume_items WHERE id=?")
      .get(item.id)!;
    assert.equal(row.due_on, "2026-10-11");
    assert.equal(row.no_resp, 1);
    s.resume.sync(s.user);
    row = s.store.db
      .prepare("SELECT * FROM resume_items WHERE id=?")
      .get(item.id)!;
    assert.equal(row.due_on, "2026-10-11");
    s.set("2026-10-11T02:00:00Z");
    await s.resume.act(s.user, item.id, { action: "skip" });
    assert.equal(
      s.resume.list(s.user).find((i) => i.id === item.id)!.state,
      "dormant",
    );
    s.set("2026-10-12T02:00:00Z");
    await s.cards.update(s.user, card.id, 1, { title: "实际改了标题" });
    assert.equal(
      s.resume.list(s.user).find((i) => i.id === item.id)!.state,
      "waiting",
    );
  } finally {
    s.store.close();
  }
});

test("actual answers advance stage; thinking does not; undo is timed and cannot overwrite newer edits", async () => {
  const s = setup();
  try {
    const card = (
      await s.cards.create(s.user, {
        text: "我想把这件事慢慢理清楚",
        type: "idea",
      })
    ).card;
    s.set("2026-10-03T02:00:00Z");
    const item = s.resume.open(s.user, "visit").item!;
    const thinking = await s.resume.act(s.user, item.id, {
      action: "answer",
      text: "还在想",
    });
    assert.equal(s.cards.detail(s.user, card.id).stage, "written");
    s.resume.undoAct(s.user, thinking.undoToken!);
    const answer = await s.resume.act(s.user, item.id, {
      action: "answer",
      text: "定了",
    });
    assert.equal(answer.offerClose, true);
    assert.equal(s.cards.detail(s.user, card.id).stage, "organized");
    s.resume.undoAct(s.user, answer.undoToken!);
    assert.equal(s.cards.detail(s.user, card.id).stage, "written");
    const again = await s.resume.act(s.user, item.id, {
      action: "answer",
      text: "我准备从最容易的一件小事开始",
    });
    assert.equal(again.offerMine, true);
    assert.equal(s.cards.detail(s.user, card.id).mine, null);
    s.set("2026-10-03T02:00:06Z");
    assert.throws(() => s.resume.undoAct(s.user, again.undoToken!), {
      code: "UNDO_EXPIRED",
    });
  } finally {
    s.store.close();
  }
});

test("mood cadence is weekly and never closes; crisis answers prevent all future continuation", async () => {
  const s = setup("2026-09-01T02:00:00Z");
  try {
    s.set("2026-10-01T02:00:00Z");
    s.store.db
      .prepare(
        "INSERT INTO brainstorms(id,user_id,scene,size,cards,status,created_at,updated_at) VALUES('bs_test',?,'mood','small','[]','picked',?,?)",
      )
      .run(s.user, "2026-10-01T02:00:00Z", "2026-10-01T02:00:00Z");
    const mood = (
      await s.cards.create(s.user, {
        text: "现在想记录一下自己的感受",
        type: "idea",
        // mood cards ask nothing unless a follow-up is chosen.
        follow: "chat",
        scene: "mood",
        origin: "brainstorm",
        srcId: "bs_test",
      })
    ).card;
    const mood2 = (
      await s.cards.create(s.user, {
        text: "还有一些新的感受想先写下",
        type: "idea",
        follow: "chat",
        scene: "mood",
        origin: "brainstorm",
        srcId: "bs_test",
      })
    ).card;
    s.set("2026-10-07T02:00:00Z");
    assert.equal(s.resume.open(s.user, "before").item, null);
    s.set("2026-10-08T02:00:00Z");
    const item = s.resume.open(s.user, "due").item!;
    assert.equal(item.kind, "mood");
    assert.equal(item.canClose, false);
    await s.resume.act(s.user, item.id, { action: "answer", text: "好一些了" });
    s.set("2026-10-09T02:00:00Z");
    assert.equal(s.resume.open(s.user, "weekcap").item, null);
    const next = s.resume
      .list(s.user)
      .find((i) => i.card?.id !== item.card!.id)!;
    const crisis = await s.resume.act(s.user, next.id, {
      action: "answer",
      text: "我不想活了",
    });
    assert.equal(crisis.crisis, true);
    assert.equal(s.cards.detail(s.user, next.card!.id).crisis, true);
    assert.equal(
      s.store.db
        .prepare(
          "SELECT count(*) AS n FROM card_versions WHERE card_id=? AND kind='resume_answer'",
        )
        .get(next.card!.id)!.n,
      0,
    );
    assert.equal(s.cards.detail(s.user, mood.id).mine, null);
    assert.equal(s.cards.detail(s.user, mood2.id).mine, null);
  } finally {
    s.store.close();
  }
});

test("promise/time settings, daily cap and no-repeat-card precedence are enforced", async () => {
  const s = setup();
  try {
    for (let i = 0; i < 4; i++)
      await s.cards.create(s.user, {
        text: `想把第${i}件事情记下来`,
        type: "idea",
      });
    s.set("2026-10-03T02:00:00Z");
    s.resume.setSettings(s.user, {
      ...s.resume.settings(s.user),
      mode: "time",
      at: "21:00",
    });
    assert.equal(s.resume.open(s.user, "morning").kind, "time");
    s.set("2026-10-03T13:00:00Z");
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const item = s.resume.open(s.user, `night${i}`).item!;
      assert.ok(item);
      ids.add(item.srcId);
      await s.resume.act(s.user, item.id, {
        action: "answer",
        text: "有些想法",
      });
    }
    assert.equal(ids.size, 3);
    assert.equal(s.resume.open(s.user, "fourth").item, null);
    const pending = s.resume.list(s.user).find((i) => !ids.has(i.srcId))!;
    await s.resume.act(s.user, pending.id, {
      action: "remind",
      remindAt: "2026-10-06T13:00:00Z",
    });
    s.set("2026-10-05T13:00:00Z");
    assert.equal(s.resume.open(s.user, "tooearly").item, null);
    s.set("2026-10-06T13:00:00Z");
    assert.equal(s.resume.open(s.user, "promised").item!.id, pending.id);
  } finally {
    s.store.close();
  }
});

test("undo cannot overwrite a later card edit or revive a deleted source", async () => {
  const s = setup();
  try {
    const card = (
      await s.cards.create(s.user, {
        text: "想把这件事情安排得更清楚",
        type: "idea",
      })
    ).card;
    s.set("2026-10-03T02:00:00Z");
    const item = s.resume.open(s.user, "first").item!;
    const acted = await s.resume.act(s.user, item.id, {
      action: "answer",
      text: "我会先列清楚这件事情的步骤",
    });
    const current = s.cards.detail(s.user, card.id);
    await s.cards.update(s.user, card.id, current.version, {
      title: "后来改了标题",
    });
    assert.throws(() => s.resume.undoAct(s.user, acted.undoToken!), {
      code: "RESUME_CHANGED",
    });
    assert.equal(s.cards.detail(s.user, card.id).title, "后来改了标题");
    s.cards.remove(s.user, card.id);
    assert.throws(() => s.resume.undoAct(s.user, acted.undoToken!), {
      code: "NOT_FOUND",
    });
    assert.equal(s.resume.open(s.user, "first").item, null);
  } finally {
    s.store.close();
  }
});

test("point-linked study and mood cards reject closing through continuation options", async () => {
  const s = setup();
  try {
    const card = (
      await s.cards.create(s.user, {
        text: "为什么这里需要看左右极限",
        type: "question",
        origin: "map",
        pointId: "limit-one-sided",
      })
    ).card;
    const own = await s.cards.mine(s.user, card.id, card.version, {
      text: "左右两边必须分别存在而且相等",
    });
    s.set("2026-10-03T02:00:00Z");
    const item = s.resume.open(s.user, "study").item!;
    assert.equal(item.learning, true);
    assert.equal(item.canClose, false);
    assert.ok(item.options.includes("做一题"));
    await s.resume.act(s.user, item.id, { action: "answer", text: "解决了" });
    assert.equal(s.cards.detail(s.user, card.id).closedAt, null);
    assert.equal(s.cards.detail(s.user, card.id).mine, own.card.mine);
    assert.equal(
      s.store.db
        .prepare("SELECT count(*) AS n FROM map_points WHERE user_id=?")
        .get(s.user)!.n,
      0,
    );
  } finally {
    s.store.close();
  }
});

test("closing a clear card records closure and undo restores both histories and stage", async () => {
  const s = setup();
  try {
    const card = (
      await s.cards.create(s.user, {
        text: "先把这件事情想清楚再做选择",
        type: "idea",
      })
    ).card;
    await s.cards.mine(s.user, card.id, card.version, {
      text: "我会先问清时间再决定这次要不要参加",
    });
    s.set("2026-10-03T02:00:00Z");
    const item = s.resume.open(s.user, "close").item!;
    const reply = await s.resume.act(s.user, item.id, {
      action: "answer",
      text: "定了",
    });
    assert.equal(s.cards.detail(s.user, card.id).stage, "closed");
    assert.equal(
      s.store.db
        .prepare(
          "SELECT count(*) n FROM card_versions WHERE card_id=? AND kind='close'",
        )
        .get(card.id)!.n,
      1,
    );
    s.resume.undoAct(s.user, reply.undoToken!);
    assert.equal(s.cards.detail(s.user, card.id).stage, "clear");
    assert.equal(
      s.store.db
        .prepare(
          "SELECT count(*) n FROM card_versions WHERE card_id=? AND kind IN ('close','resume_answer')",
        )
        .get(card.id)!.n,
      0,
    );
  } finally {
    s.store.close();
  }
});

test("receipt feedback is offered once weekly and date choices write an owned next step", async () => {
  const s = setup();
  try {
    const a = (
      await s.cards.create(s.user, {
        text: "要不要报名参加周末的活动",
        type: "idea",
      })
    ).card;
    await s.cards.create(s.user, {
      text: "周末的另一件事先记下来",
      type: "idea",
    });
    s.set("2026-10-03T02:00:00Z");
    const item = s.resume.open(s.user, "a").item!;
    const answer = await s.resume.act(s.user, item.id, {
      action: "answer",
      text: "定了",
    });
    assert.equal(answer.feedback, true);
    s.resume.feedback(s.user, item.id, "dismiss");
    s.resume.feedback(s.user, item.id, "useful");
    assert.equal(
      s.store.db
        .prepare("SELECT count(*) n FROM events WHERE name='resume_feedback'")
        .get()!.n,
      1,
    );
    const updated = s.cards.detail(s.user, item.card!.id);
    const receipt = await s.resume.when(
      s.user,
      item.id,
      "next_week",
      updated.version,
    );
    assert.equal((receipt.card.next as { on: string }).on, "2026-10-11");
    await assert.rejects(
      () => s.resume.when(s.other, item.id, "week", updated.version),
      { code: "NOT_FOUND" },
    );
    const second = s.resume.open(s.user, "b").item!;
    assert.notEqual(second.card!.id, item.card!.id);
    const secondAnswer = await s.resume.act(s.user, second.id, {
      action: "answer",
      text: "我会先把需要准备的东西写清楚",
    });
    assert.equal(secondAnswer.feedback, false);
    assert.ok(s.cards.detail(s.user, a.id));
  } finally {
    s.store.close();
  }
});
