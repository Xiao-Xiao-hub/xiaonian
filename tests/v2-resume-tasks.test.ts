import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { CardService } from "../server/src/modules/cards/service.js";
import { CrisisSafetyService } from "../server/src/modules/safety/service.js";
import { ResumeService } from "../server/src/modules/resume/service.js";
import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";

function setup() {
  const store = new SqliteStore(":memory:");
  const user = store.upsertUser("dev:resume-tasks", "甲", "dev").id;
  let now = new Date("2026-10-01T02:00:00Z");
  const clock = () => new Date(now);
  const safety = new CrisisSafetyService({ noul: async () => 0 });
  const cards = new CardService(store, safety, clock);
  const resume = new ResumeService(store, cards, safety, clock);
  return {
    store,
    user,
    cards,
    resume,
    clock,
    set: (s: string) => (now = new Date(s)),
  };
}

test("finished import and brainstorm work is immediately resumable and saved or deleted sources disappear", async () => {
  const f = setup();
  try {
    f.store.db
      .prepare(
        "INSERT INTO imports(id,user_id,source,file_name,status,created_at,updated_at) VALUES('a',?,'paste','这次笔记','picking',?,?)",
      )
      .run(f.user, f.clock().toISOString(), f.clock().toISOString());
    // Materialize the first resume item before advancing the injected clock.
    // Source timestamps alone do not determine resume_items.created_at.
    f.resume.list(f.user);
    f.set("2026-10-01T02:00:01Z");
    f.store.db
      .prepare(
        "INSERT INTO brainstorms(id,user_id,scene,size,cards,result,status,created_at,updated_at) VALUES('b',?,'study','small','[]','{}','ready',?,?)",
      )
      .run(f.user, f.clock().toISOString(), f.clock().toISOString());
    const initial = f.resume.list(f.user);
    assert.deepEqual(initial.map((item) => item.src).sort(), ["brainstorm", "import"]);
    const first = f.resume.open(f.user, "one").item!;
    assert.equal(first.src, "import");
    assert.equal(first.title, "这次笔记");
    assert.match(first.url!, /import\/split/);
    assert.equal(first.quote, null);
    await f.resume.act(f.user, first.id, { action: "answer", text: "看看" });
    const second = f.resume.open(f.user, "two").item!;
    assert.equal(second.src, "brainstorm");
    assert.match(second.url!, /brainstorm\/process/);
    f.store.db
      .prepare("UPDATE brainstorms SET status='saved' WHERE id='b'")
      .run();
    assert.equal(f.resume.open(f.user, "two").item, null);
    f.store.db.prepare("DELETE FROM imports WHERE id='a'").run();
    assert.equal(f.resume.open(f.user, "one").item, null);
    assert.equal(f.resume.list(f.user).length, 0);
  } finally {
    f.store.close();
  }
});

test("chapter batch is live, never preselects, and repeats no sooner than fourteen days", async () => {
  const f = setup();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push(
        (
          await f.cards.create(f.user, {
            text: `第${i}个极限的学习念头`,
            type: "spark",
            scene: "study",
            pointId: CALC_MAP.chapters[0]!.points[i]!.id,
          })
        ).card.id,
      );
    const first = f.resume.open(f.user, "batch").item!;
    assert.equal(first.kind, "batch");
    assert.match(first.url!, /batch=chapter/);
    assert.equal(first.quote, null);
    await f.resume.act(f.user, first.id, { action: "answer", text: "看看" });
    f.set("2026-10-14T02:00:00Z");
    assert.notEqual(f.resume.open(f.user, "early").item?.kind, "batch");
    f.set("2026-10-15T02:00:00Z");
    const repeated = f.resume.open(f.user, "fourteen").item!;
    assert.equal(repeated.id, first.id);
    await f.resume.act(f.user, first.id, { action: "never" });
    f.set("2026-11-01T02:00:00Z");
    assert.notEqual(f.resume.open(f.user, "never").item?.kind, "batch");
    assert.equal(
      f.resume.list(f.user, "never").find((item) => item.id === first.id)
        ?.state,
      "never",
    );
    await f.resume.act(f.user, first.id, { action: "restore" });
    f.cards.remove(f.user, ids[0]!);
    assert.ok(!f.resume.list(f.user).some((item) => item.kind === "batch"));
    assert.equal(f.resume.open(f.user, "batch").item, null);
  } finally {
    f.store.close();
  }
});

test("saved imports form their own batch and sensitive batches respect mood consent and weekly cadence", async () => {
  const f = setup();
  try {
    f.store.db
      .prepare(
        "UPDATE users SET data=json_set(data,'$.moodConsentAt',?) WHERE id=?",
      )
      .run(f.clock().toISOString(), f.user);
    f.store.db
      .prepare(
        "INSERT INTO imports(id,user_id,source,status,created_at,updated_at) VALUES('mood-import',?,'paste','saved',?,?)",
      )
      .run(f.user, f.clock().toISOString(), f.clock().toISOString());
    for (let i = 0; i < 3; i++)
      await f.cards.create(f.user, {
        text: `第${i}件让我有些感受的小事`,
        type: "idea",
        scene: "mood",
        origin: "import",
        srcId: "mood-import",
      });
    const first = f.resume.open(f.user, "mood").item!;
    assert.equal(first.kind, "batch");
    assert.match(first.url!, /batch=import/);
    f.resume.setSettings(f.user, {
      ...f.resume.settings(f.user),
      types: { cards: true, study: true, mood: false },
    });
    assert.equal(f.resume.open(f.user, "mood").item, null);
    f.resume.setSettings(f.user, {
      ...f.resume.settings(f.user),
      types: { cards: true, study: true, mood: true },
    });
    f.store.db
      .prepare(
        "INSERT INTO brainstorms(id,user_id,scene,size,cards,result,status,created_at,updated_at) VALUES('mood-brainstorm',?,'mood','small','[]','{}','ready',?,?)",
      )
      .run(f.user, f.clock().toISOString(), f.clock().toISOString());
    assert.notEqual(f.resume.open(f.user, "same-week").item?.src, "brainstorm");
    f.store.db
      .prepare(
        "UPDATE users SET data=json_remove(data,'$.moodConsentAt') WHERE id=?",
      )
      .run(f.user);
    assert.equal(f.resume.open(f.user, "mood").item, null);
  } finally {
    f.store.close();
  }
});
