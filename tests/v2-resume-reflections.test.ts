import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { CardService } from "../server/src/modules/cards/service.js";
import { CrisisSafetyService } from "../server/src/modules/safety/service.js";
import { ResumeService } from "../server/src/modules/resume/service.js";
import { RetestService } from "../server/src/modules/learn/retests.js";

function setup() {
  const store = new SqliteStore(":memory:");
  const user = store.upsertUser("dev:reflection", "甲", "dev").id;
  let now = new Date("2026-10-01T12:00:00Z");
  const clock = () => new Date(now);
  const cards = new CardService(
    store,
    new CrisisSafetyService({ noul: async () => 0 }),
    clock,
  );
  const resume = new ResumeService(
    store,
    cards,
    new CrisisSafetyService({
      noul: async () => {
        throw new Error("reflection must not call a model");
      },
    }),
    clock,
  );
  return {
    store,
    user,
    cards,
    resume,
    clock,
    set: (s: string) => (now = new Date(s)),
  };
}

test("closed cards are shown once each, at most twice daily, and repeat visits recheck their source", async () => {
  const f = setup();
  try {
    for (let i = 0; i < 3; i++) {
      const card = (
        await f.cards.create(f.user, {
          text: `第${i}件事情先把时间安排清楚`,
          type: "idea",
        })
      ).card;
      await f.cards.close(
        f.user,
        card.id,
        card.version,
        `第${i}件事情已经问清时间然后做了决定`,
      );
    }
    const first = f.resume.open(f.user, "one");
    assert.equal(first.kind, "lookback");
    assert.deepEqual(f.resume.open(f.user, "one"), first);
    assert.equal(f.resume.open(f.user, "two").kind, "lookback");
    assert.equal(f.resume.open(f.user, "three").kind, "none");
    const data = String(
      f.store.db
        .prepare(
          "SELECT group_concat(data) data FROM events WHERE name LIKE 'resume_%'",
        )
        .get()!.data,
    );
    assert.ok(
      !data.includes("做了决定"),
      "events store IDs, never copied content",
    );
    f.set("2026-10-02T12:00:00Z");
    assert.equal(f.resume.open(f.user, "four").kind, "lookback");
    assert.equal(f.resume.open(f.user, "five").kind, "none");
    f.cards.remove(f.user, decodeURIComponent(first.url!.split("id=")[1]!));
    assert.equal(f.resume.open(f.user, "one").kind, "none");
  } finally {
    f.store.close();
  }
});

test("changed own words and independent retests are reflected, while mood and hints stay private", async () => {
  const f = setup();
  try {
    const card = (
      await f.cards.create(f.user, {
        text: "我想先比较这两个安排再做决定",
        type: "idea",
      })
    ).card;
    const one = (
      await f.cards.mine(f.user, card.id, card.version, {
        text: "我先去问清活动的截止日期再决定",
      })
    ).card;
    await f.cards.mine(f.user, card.id, one.version, {
      text: "现在我会先安排复习再决定报名时间",
    });
    const changed = f.resume.open(f.user, "changed");
    assert.equal(changed.kind, "lookback");
    assert.match(changed.text!, /现在改成/);
    f.store.db.prepare("UPDATE cards SET scene='mood' WHERE id=?").run(card.id);
    assert.equal(f.resume.open(f.user, "changed").kind, "none");
    const retests = new RetestService(f.store, f.clock);
    retests.schedule(f.user, "limit-equivalent", "hint");
    retests.schedule(f.user, "limit-discontinuity", "hint");
    f.set("2026-10-03T12:00:00Z");
    f.store.transaction(() => {
      retests.finishInTransaction(
        f.user,
        retests.current(f.user, "limit-equivalent")!,
        "right",
      );
      retests.finishInTransaction(
        f.user,
        retests.current(f.user, "limit-discontinuity")!,
        "hinted",
      );
    });
    const learned = f.resume.open(f.user, "learned");
    assert.equal(learned.kind, "lookback");
    assert.match(learned.url!, /limit-equivalent/);
    assert.match(learned.text!, /不看提示/);
    f.resume.setSettings(f.user, {
      ...f.resume.settings(f.user),
      types: { cards: true, study: false, mood: false },
    });
    assert.equal(f.resume.open(f.user, "learned").kind, "none");
    assert.equal(f.resume.open(f.user, "no-hinted-reflection").kind, "none");
  } finally {
    f.store.close();
  }
});

test("greeting is only on the first daily opening, quotes owned words and respects switches", async () => {
  const f = setup();
  try {
    const card = (
      await f.cards.create(f.user, {
        text: "今天想报一个羽毛球兴趣班",
        type: "idea",
      })
    ).card;
    const first = f.resume.open(f.user, "first");
    assert.equal(first.kind, "greet");
    assert.match(first.text!, /晚上好。10\/1 你记下“今天想报一个羽毛球兴趣班”/);
    assert.deepEqual(f.resume.open(f.user, "first"), first);
    const later = f.resume.open(f.user, "later");
    assert.equal(later.kind, "none");
    assert.equal(later.text, "回顾和提醒 ›");
    f.store.db.prepare("UPDATE cards SET crisis=1 WHERE id=?").run(card.id);
    assert.equal(f.resume.open(f.user, "first").kind, "none");
    f.set("2026-10-02T12:00:00Z");
    f.resume.setSettings(f.user, {
      ...f.resume.settings(f.user),
      greet: false,
    });
    assert.equal(f.resume.open(f.user, "disabled").kind, "none");
    f.resume.setSettings(f.user, { ...f.resume.settings(f.user), mode: "off" });
    assert.deepEqual(f.resume.open(f.user, "off"), {
      kind: "none",
      item: null,
    });
  } finally {
    f.store.close();
  }
});

test("answer daily cap still allows a lookback, and a long absence shows only one item of any kind", async () => {
  const f = setup();
  try {
    const card = (
      await f.cards.create(f.user, {
        text: "把最近想到的事情慢慢理顺",
        type: "idea",
      })
    ).card;
    await f.cards.close(
      f.user,
      card.id,
      card.version,
      "我已经决定先安排学习再去参加活动",
    );
    for (let i = 0; i < 3; i++)
      f.store.db
        .prepare(
          "INSERT INTO events(user_id,name,data,created_at) VALUES(?,'resume_show','{}',?)",
        )
        .run(f.user, f.clock().toISOString());
    assert.equal(f.resume.open(f.user, "cap").kind, "lookback");
    f.set("2026-10-16T12:00:00Z");
    assert.equal(f.resume.open(f.user, "return").kind, "greet");
    assert.equal(f.resume.open(f.user, "return-again").kind, "none");
  } finally {
    f.store.close();
  }
});

test("lastChat picks the latest recent non-mood, non-crisis chat and first is only for a blank account", async () => {
  const f = setup();
  f.set("2026-10-10T04:00:00Z");
  assert.equal(f.resume.isFirst(f.user), true);
  assert.equal(f.resume.lastChat(f.user), null);
  const thread = (id: string, scene: string, title: string, at: string) =>
    f.store.db
      .prepare("INSERT INTO threads(id,user_id,title,scene,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(id, f.user, title, scene, at, at);
  let n = 0;
  const say = (threadId: string, content: string, at: string, data = "{}") =>
    f.store.db
      .prepare("INSERT INTO messages(id,thread_id,user_id,role,kind,content,data,status,created_at) VALUES(?,?,?,'user','text',?,?,'done',?)")
      .run(`msg_${++n}`, threadId, f.user, content, data, at);
  thread("t_old", "study", "很久以前的题", "2026-09-20T00:00:00Z");
  say("t_old", "旧问题", "2026-09-20T00:00:00Z");
  thread("t_empty", "study", "空的", "2026-10-09T12:00:00Z");
  assert.equal(f.resume.lastChat(f.user), null);
  assert.equal(f.resume.isFirst(f.user), false);
  thread("t_study", "life", "", "2026-10-09T00:00:00Z");
  say("t_study", "周末先复习哪一章比较好呢", "2026-10-08T00:00:00Z");
  say("t_study", "那我先把极限这一章的错题都过一遍，然后再去做导数的练习题吧，最后还要整理一下笔记", "2026-10-09T00:00:00Z");
  thread("t_mood", "mood", "心情", "2026-10-09T10:00:00Z");
  say("t_mood", "今天有点烦", "2026-10-09T10:00:00Z");
  thread("t_crisis", "life", "不好的", "2026-10-09T11:00:00Z");
  say("t_crisis", "不太好", "2026-10-09T11:00:00Z", JSON.stringify({ crisis: 1 }));
  const last = f.resume.lastChat(f.user)!;
  assert.equal(last.threadId, "t_study");
  assert.equal(last.title, "周末先复习哪一章比较好呢");
  assert.equal(Array.from(last.quote).length, 31);
  assert.ok(last.quote.startsWith("那我先把极限这一章"));
  assert.equal(last.at, "2026-10-09T00:00:00Z");
  // A card or brainstorm chat keeps the placeholder title: show the first question.
  thread("t_card", "life", "新的对话", "2026-10-09T13:00:00Z");
  say("t_card", "这几张卡里最该先做哪件", "2026-10-09T13:00:00Z");
  assert.equal(f.resume.lastChat(f.user)!.title, "这几张卡里最该先做哪件");
  // Two weeks on it is no longer offered.
  f.set("2026-10-24T01:00:00Z");
  assert.equal(f.resume.lastChat(f.user), null);
});
