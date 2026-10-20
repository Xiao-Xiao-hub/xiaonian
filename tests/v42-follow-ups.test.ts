import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { CardService } from "../server/src/modules/cards/service.js";
import { validateTidy } from "../server/src/modules/cards/tidy.js";
import { CrisisSafetyService } from "../server/src/modules/safety/service.js";
import { ResumeService } from "../server/src/modules/resume/service.js";

// follow-ups by content. Synthetic text only.
function setup(created = "2026-09-01T02:00:00.000Z") {
  const store = new SqliteStore(":memory:");
  const user = store.upsertUser("dev:follow", "甲", "dev").id;
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
        "SELECT item_key,kind,state,due_on,no_resp FROM resume_items WHERE src='card' AND src_id=? ORDER BY item_key",
      )
      .all(cardId)
      .map((r) => ({ ...r }));
  return {
    store,
    user,
    cards,
    resume,
    items,
    set: (value: string) => {
      date = new Date(value);
    },
  };
}

test("sync asks by follow-up mode and skips none, mood and 不提醒", async () => {
  const s = setup();
  try {
    const todo = (await s.cards.create(s.user, { text: "周五前交线代作业", kind: "todo" })).card;
    // Later the same day, so the 待办 stays the first card (it gets the first-card date).
    s.set("2026-10-01T03:00:00.000Z");
    const known = (await s.cards.create(s.user, { text: "二战于1945年结束", kind: "knowledge" })).card;
    const idea = (await s.cards.create(s.user, { text: "我觉得期末前不该再报竞赛", kind: "idea" })).card;
    const note = (await s.cards.create(s.user, { text: "王老师办公室在理科楼502", kind: "note" })).card;
    const spark = (await s.cards.create(s.user, { text: "要是宿舍楼下有共享书架", kind: "spark" })).card;
    const off = (await s.cards.create(s.user, { text: "明天下午去盖章", kind: "todo" })).card;
    await s.cards.update(s.user, off.id, off.version, { resume: "off" });
    const quiet = (await s.cards.create(s.user, { text: "背单词先过音标", kind: "method", follow: "none" })).card;
    s.resume.sync(s.user);
    assert.deepEqual(s.items(todo.id).map((i) => [i.item_key, i.kind, i.due_on]), [["type", "todo", "2026-10-03"]]);
    assert.deepEqual(s.items(known.id).map((i) => [i.item_key, i.kind, i.due_on]), [["recall:0", "recall", "2026-10-03"]]);
    assert.deepEqual(s.items(idea.id).map((i) => [i.item_key, i.kind, i.due_on]), [["type", "chat", "2026-10-04"]]);
    for (const card of [note, spark, off, quiet]) assert.deepEqual(s.items(card.id), [], card.kind);
    // A date the learner picked still comes when the mode is none.
    const dated = await s.cards.update(s.user, quiet.id, s.cards.detail(s.user, quiet.id).version, { remindOn: "2026-10-05" });
    s.resume.sync(s.user);
    assert.deepEqual(s.items(quiet.id).map((i) => i.item_key), ["remind:2026-10-05"]);
    // 不提醒 on a card with a date stops that too.
    await s.cards.update(s.user, quiet.id, dated.card.version, { resume: "off" });
    s.set("2026-10-05T02:00:00Z");
    assert.equal(s.resume.list(s.user).some((i) => i.card?.id === quiet.id), false);
  } finally {
    s.store.close();
  }
});

test("mood cards ask nothing by default", async () => {
  const s = setup();
  try {
    s.store.db
      .prepare(
        "INSERT INTO brainstorms(id,user_id,scene,size,cards,status,created_at,updated_at) VALUES('bs_mood',?,'mood','small','[]','picked',?,?)",
      )
      .run(s.user, "2026-10-01T02:00:00Z", "2026-10-01T02:00:00Z");
    const mood = (
      await s.cards.create(s.user, { text: "今天被批评了有点委屈", type: "idea", scene: "mood", origin: "brainstorm", srcId: "bs_mood" })
    ).card;
    assert.equal(mood.follow, "none");
    s.resume.sync(s.user);
    assert.deepEqual(s.items(mood.id), []);
  } finally {
    s.store.close();
  }
});

test("legacy rows without kind or follow derive the same follow-up", async () => {
  const s = setup();
  try {
    const card = (await s.cards.create(s.user, { text: "先列提纲再写正文", type: "method" })).card;
    s.store.db.prepare("UPDATE cards SET kind=NULL,follow=NULL WHERE id=?").run(card.id);
    s.resume.sync(s.user);
    assert.deepEqual(s.items(card.id).map((i) => i.kind), ["recall"]);
  } finally {
    s.store.close();
  }
});

test("the resume card offers the mode's options and each does what it says", async () => {
  const s = setup();
  try {
    const known = (await s.cards.create(s.user, { text: "等价无穷小 sin x ~ x", kind: "knowledge" })).card;
    s.set("2026-10-03T02:00:00Z");
    let item = s.resume.list(s.user).find((i) => i.card?.id === known.id)!;
    assert.deepEqual(item.options, ["记住了", "有点忘", "不用提醒"]);
    assert.deepEqual(item.acts, ["remember", "forgot", "never"]);
    assert.doesNotMatch(item.question, /完成了吗/);
    // 记住了 moves the next 还记得吗 further out.
    await s.resume.act(s.user, item.id, { action: "answer", text: "记住了" });
    s.resume.sync(s.user);
    assert.deepEqual(
      s.items(known.id).map((i) => [i.item_key, i.state, i.due_on]),
      [
        ["recall:0", "done", "2026-10-03"],
        ["recall:1", "waiting", "2026-10-07"],
      ],
    );
    s.set("2026-10-07T02:00:00Z");
    item = s.resume.list(s.user).find((i) => i.card?.id === known.id)!;
    // 有点忘: asked again tomorrow, not counted as ignored.
    await s.resume.act(s.user, item.id, { action: "answer", text: "有点忘" });
    assert.deepEqual(
      s.items(known.id).filter((i) => i.item_key === "recall:1").map((i) => [i.state, i.due_on, i.no_resp]),
      [["snoozed", "2026-10-08", 0]],
    );

    const todo = (await s.cards.create(s.user, { text: "买洗衣液和充电线", kind: "todo" })).card;
    s.set("2026-10-09T02:00:00Z");
    const ask = s.resume.list(s.user).find((i) => i.card?.id === todo.id)!;
    assert.deepEqual(ask.options, ["做了", "还没", "不用提醒"]);
    // 还没 is an answer: snoozed two days, not counted as ignored.
    await s.resume.act(s.user, ask.id, { action: "answer", text: "还没" });
    let row = s.items(todo.id)[0]!;
    assert.deepEqual([row.state, row.due_on, row.no_resp], ["snoozed", "2026-10-11", 0]);
    s.set("2026-10-11T02:00:00Z");
    const again = s.resume.list(s.user).find((i) => i.card?.id === todo.id)!;
    const done = await s.resume.act(s.user, again.id, { action: "answer", text: "做了" });
    // 做了 closes a 待办 without asking for words.
    assert.equal(s.cards.detail(s.user, todo.id).stage, "closed");
    assert.equal(done.askWhen, false);
    assert.equal(done.offerClose, false);

    const chat = (await s.cards.create(s.user, { text: "保研和考研哪个更适合我", kind: "question" })).card;
    s.set("2026-10-14T02:00:00Z");
    const talk = s.resume.list(s.user).find((i) => i.card?.id === chat.id)!;
    assert.deepEqual(talk.options, ["接着聊", "先放着", "不用提醒"]);
    await s.resume.act(s.user, talk.id, { action: "answer", text: "不用提醒" });
    assert.equal(s.cards.detail(s.user, chat.id).resume, "off");
    row = s.items(chat.id)[0]!;
    assert.equal(s.resume.list(s.user).some((i) => i.card?.id === chat.id), false);
  } finally {
    s.store.close();
  }
});

test("tidy's own question for the card is asked when it fits the mode", async () => {
  const s = setup();
  try {
    const card = (await s.cards.create(s.user, { text: "牛顿-莱布尼茨公式：定积分等于原函数之差", kind: "note" })).card;
    const tidy = validateTidy(
      {
        title: "牛顿莱布尼茨",
        summary: "定积分用原函数算",
        slots: [],
        open: [],
        followup: null,
        follow: "review",
        ask: { q: "定积分怎么用原函数算，还记得吗？", yes: "记得", no: "忘了" },
        tags: [],
      },
      card,
    );
    assert.equal(tidy.follow, "review");
    const tidied = s.cards.applyAIData(s.user, card.id, card.version, tidy);
    assert.equal(tidied.follow, "review");
    assert.equal(tidied.stage, "written");
    s.set("2026-10-03T02:00:00Z");
    const item = s.resume.list(s.user).find((i) => i.card?.id === card.id)!;
    assert.equal(item.question, "定积分怎么用原函数算，还记得吗？");
    assert.deepEqual(item.options, ["记得", "忘了", "不用提醒"]);
    assert.deepEqual(item.acts, ["remember", "forgot", "never"]);
    await s.resume.act(s.user, item.id, { action: "answer", text: "记得" });
    s.resume.sync(s.user);
    assert.ok(s.items(card.id).some((i) => i.item_key === "recall:1"));
    // The user's own choice wins over tidy's: later tidies leave it.
    const changed = await s.cards.update(s.user, card.id, s.cards.detail(s.user, card.id).version, { follow: "chat" });
    const again = s.cards.applyAIData(s.user, card.id, changed.card.version, { follow: "review" });
    assert.equal(again.follow, "chat");
    s.resume.sync(s.user);
    s.set("2026-10-20T02:00:00Z");
    const chat = s.resume.list(s.user).find((i) => i.card?.id === card.id)!;
    assert.deepEqual(chat.options, ["接着聊", "先放着", "不用提醒"]);
  } finally {
    s.store.close();
  }
});

test("tidy may leave out the follow-up question and keeps hesitant answers", () => {
  const card = {
    id: "card_x",
    type: "idea",
    kind: "idea",
    quote: "我觉得先复习再刷题",
  } as never;
  const none = validateTidy({ title: "复习", summary: "先复习", slots: [], open: [], followup: null, tags: [] }, card);
  assert.equal(none.followup, undefined);
  const kept = validateTidy(
    {
      title: "复习",
      summary: "先复习",
      slots: [],
      open: [],
      followup: { q: "现在倾向哪种？", options: ["先复习", "还在想", "写一句"] },
      tags: [],
    },
    card,
  );
  assert.deepEqual(kept.followup!.options, ["先复习", "还在想"]);
});

test("到点再问: a visit opened before the time is asked again once the time comes", async () => {
  const s = setup();
  try {
    await s.cards.create(s.user, { text: "周五前交线代作业", kind: "todo" });
    s.resume.setSettings(s.user, { ...s.resume.settings(s.user), mode: "time", at: "21:00" });
    s.set("2026-10-03T02:00:00Z");
    assert.equal(s.resume.open(s.user, "visit-1").kind, "time");
    s.set("2026-10-03T13:30:00Z");
    const later = s.resume.open(s.user, "visit-1");
    assert.equal(later.kind, "item");
    assert.ok(later.item);
    // The same visit keeps its answer from then on.
    assert.equal(s.resume.open(s.user, "visit-1").item!.id, later.item!.id);
  } finally {
    s.store.close();
  }
});
