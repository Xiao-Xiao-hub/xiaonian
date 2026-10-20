import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { CardService } from "../server/src/modules/cards/service.js";
import { CrisisSafetyService } from "../server/src/modules/safety/service.js";
import { ResumeService } from "../server/src/modules/resume/service.js";
import { RetestService } from "../server/src/modules/learn/retests.js";
import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";

function setup() {
  const store = new SqliteStore(":memory:");
  const user = store.upsertUser("dev:learning-resume", "甲", "dev").id;
  const other = store.upsertUser("dev:other-learning-resume", "乙", "dev").id;
  let at = new Date("2026-10-01T02:00:00Z");
  const clock = () => new Date(at),
    safety = new CrisisSafetyService({ noul: async () => 0 });
  const cards = new CardService(store, safety, clock),
    resume = new ResumeService(store, cards, safety, clock),
    retests = new RetestService(store, clock);
  const point = CALC_MAP.chapters[0]!.points[0]!.id;
  return {
    store,
    user,
    other,
    cards,
    resume,
    retests,
    point,
    set: (s: string) => (at = new Date(s)),
  };
}

test("learning continuation defers only its reminder and can stop, undo, restore a fresh retest", async () => {
  const f = setup();
  try {
    const scheduled = f.retests.schedule(f.user, f.point, "hint")!;
    f.set("2026-10-03T02:00:00Z");
    const item = f.resume.open(f.user, "first").item!;
    assert.equal(item.src, "point");
    assert.equal(item.kind, "retest");
    assert.deepEqual(item.options, ["做一题", "先放着"]);
    assert.equal(item.quote, null);
    assert.match(item.url!, /point/);
    const skipped = await f.resume.act(f.user, item.id, { action: "skip" });
    assert.equal(skipped.item!.dueOn, "2026-10-06");
    assert.equal(f.retests.current(f.user, f.point)!.due_on, scheduled.dueOn);
    const stopped = await f.resume.act(f.user, item.id, { action: "never" });
    assert.equal(f.retests.current(f.user, f.point), null);
    assert.equal(f.retests.schedule(f.user, f.point, "hint"), null);
    f.resume.undoAct(f.user, stopped.undoToken!);
    assert.equal(f.retests.current(f.user, f.point)!.id, scheduled.id);
    const stoppedAgain = await f.resume.act(f.user, item.id, {
      action: "never",
    });
    const restored = await f.resume.act(f.user, item.id, { action: "restore" });
    const fresh = f.retests.current(f.user, f.point)!;
    assert.notEqual(fresh.id, scheduled.id);
    assert.equal(fresh.due_on, "2026-10-05");
    assert.throws(() => f.resume.undoAct(f.user, stoppedAgain.undoToken!), {
      code: "UNDO_EXPIRED",
    });
    f.resume.undoAct(f.user, restored.undoToken!);
    assert.equal(f.retests.current(f.user, f.point), null);
    assert.equal(f.resume.list(f.user, "never")[0]!.state, "never");
    assert.throws(() => f.resume.undoAct(f.other, restored.undoToken!), {
      code: "UNDO_EXPIRED",
    });
  } finally {
    f.store.close();
  }
});

test("cards precede due learning, completed retests disappear, and hidden chapters are not offered", async () => {
  const f = setup();
  try {
    const card = (
      await f.cards.create(f.user, {
        text: "今天想到的事情想再理清楚",
        type: "idea",
      })
    ).card;
    f.retests.schedule(f.user, f.point, "ask");
    f.set("2026-10-03T02:00:00Z");
    const item = f.resume.open(f.user, "card-first").item!;
    assert.equal(item.card!.id, card.id);
    const learning = f.resume.list(f.user).find((i) => i.src === "point")!;
    f.store.transaction(() =>
      f.retests.finishInTransaction(
        f.user,
        f.retests.current(f.user, f.point)!,
        "right",
        "yes",
      ),
    );
    assert.equal(
      f.resume.list(f.user).some((i) => i.id === learning.id),
      false,
    );
    const point = CALC_MAP.chapters[0]!.points[1]!.id;
    f.retests.schedule(f.user, point, "hint");
    f.store.db
      .prepare(
        "INSERT INTO map_chapters(user_id,chapter_id,hidden_at) VALUES(?,?,?)",
      )
      .run(f.user, CALC_MAP.chapters[0]!.id, "2026-10-03T02:00:00Z");
    assert.equal(
      f.resume.list(f.user).some((i) => i.src === "point"),
      false,
    );
    assert.equal(f.resume.list(f.other).length, 0);
  } finally {
    f.store.close();
  }
});

test("confidence totals exclude old repeated second rounds, no prediction and incomplete outcomes", () => {
  const f = setup();
  try {
    const cases: [number, string | null, string, boolean][] = [
      [1, "yes", "right", false],
      [1, "yes", "wrong", false],
      [2, "yes", "right", true],
      [2, "yes", "hinted", false],
      [1, null, "right", false],
      [1, "yes", "early", false],
      [1, "yes", "dropped", false],
    ];
    for (const [round, predicted, result, repeated] of cases) {
      const row = f.store.db
        .prepare(
          "INSERT INTO retests(user_id,point_id,cause,problem_index,round,due_on,predicted,result,created_at,done_at) VALUES(?,?,'hint',0,?,'2026-10-03',?,?,?,?)",
        )
        .run(
          f.user,
          f.point,
          round,
          predicted,
          result,
          "2026-10-01T02:00:00Z",
          "2026-10-03T02:00:00Z",
        );
      f.store.db
        .prepare(
          "INSERT INTO events(user_id,name,data,created_at) VALUES(?,'retest_scheduled',?,?)",
        )
        .run(
          f.user,
          JSON.stringify({ retestId: Number(row.lastInsertRowid), repeated }),
          "2026-10-01T02:00:00Z",
        );
    }
    const s = f.cards.stats(f.user);
    assert.equal(s.retestCount, 3);
    assert.equal(s.predicted, 3);
    assert.equal(s.actual, 1);
    assert.equal(f.cards.stats(f.other).retestCount, 0);
  } finally {
    f.store.close();
  }
});
