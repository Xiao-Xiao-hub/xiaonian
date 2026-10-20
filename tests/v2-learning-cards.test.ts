import test from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../server/src/shared/store.js";
import { CardService } from "../server/src/modules/cards/service.js";
import { CrisisSafetyService } from "../server/src/modules/safety/service.js";
import { LearnService } from "../server/src/modules/learn/service.js";
import { MistakeService } from "../server/src/modules/mistakes/service.js";
import { Jev } from "../server/src/providers/jev.js";
import { canonicalInput } from "../server/src/modules/learn/answers.js";
import { PROBLEMS } from "../server/src/modules/learn/problems.js";

function setup() {
  const store = new SqliteStore(":memory:"),
    user = store.upsertUser("dev:close-study", "甲", "dev").id,
    other = store.upsertUser("dev:close-other", "乙", "dev").id;
  let now = new Date("2026-10-01T02:00:00Z");
  const clock = () => now;
  const cards = new CardService(
      store,
      new CrisisSafetyService({ noul: async () => 0 }),
      clock,
    ),
    learn = new LearnService(store, clock);
  const point = "limit-rules";
  const create = (type: "question" | "method", mine?: string) =>
    cards.create(user, {
      text: "这个计算为什么不能直接代入",
      type,
      origin: "map",
      pointId: point,
      scene: "study",
      mine,
    });
  const pass = () => {
    learn.retests.schedule(user, point, "hint", 0);
    now = new Date("2026-10-03T02:00:00Z");
    const p = learn.point(user, point);
    return learn.answer(
      user,
      point,
      canonicalInput(PROBLEMS[point]![p.problem!.index]!),
      p.problem!.index,
      "yes",
    );
  };
  return { store, user, other, cards, learn, point, create, pass, clock };
}

test("only a real independent retest closes clear questions; remaining cards require explicit words/use", async () => {
  const f = setup();
  try {
    const ready = (await f.create("question", "先把分子分母分别整理再计算极限"))
      .card;
    const pending = (await f.create("question")).card;
    const method = (await f.create("method", "先判断类型再决定能不能直接代入"))
      .card;
    const result = f.pass(),
      proof = result.learningCards!;
    assert.equal(result.retest?.result, "right");
    assert.ok(proof.proofId);
    assert.equal(f.cards.detail(f.user, ready.id).stage, "closed");
    assert.equal(f.cards.detail(f.user, pending.id).stage, "written");
    assert.equal(f.cards.detail(f.user, method.id).stage, "clear");
    await assert.rejects(
      f.cards.learningClose(f.user, pending.id, pending.version, {
        proofId: proof.proofId,
        // no ten-character floor any more; one character is still too short.
        text: "短",
      }),
      { code: "INVALID_CARD" },
    );
    await assert.rejects(
      f.cards.learningClose(f.user, method.id, method.version, {
        proofId: proof.proofId,
      }),
      { code: "INVALID_CARD" },
    );
    const closed = await f.cards.learningClose(
      f.user,
      pending.id,
      pending.version,
      { proofId: proof.proofId, text: "关键是把相同阶数的项合并后再计算" },
    );
    assert.equal(closed.card.stage, "closed");
    assert.equal(closed.card.mine, "关键是把相同阶数的项合并后再计算");
    assert.equal(
      (
        await f.cards.learningClose(f.user, method.id, method.version, {
          proofId: proof.proofId,
          used: true,
        })
      ).card.stage,
      "closed",
    );
    assert.throws(() => f.cards.learningCards(f.other, proof.proofId), {
      code: "NOT_FOUND",
    });
    const late = (await f.create("question")).card;
    await assert.rejects(
      f.cards.learningClose(f.user, late.id, late.version, {
        proofId: proof.proofId,
        text: "这是后来创建不能追认通过的卡片",
      }),
      { code: "INVALID_CARD" },
    );
  } finally {
    f.store.close();
  }
});

test("first lighting cannot close study cards; due review can and moved cards lose the proof", async () => {
  const f = setup();
  try {
    const c = (await f.create("question", "先判断分子分母最高次再进行计算"))
      .card;
    const p = f.learn.point(f.user, f.point);
    const result = f.learn.answer(
      f.user,
      f.point,
      canonicalInput(PROBLEMS[f.point]![p.problem!.index]!),
      p.problem!.index,
    );
    assert.equal(result.counted, "lit");
    assert.equal(result.learningCards, undefined);
    assert.equal(f.cards.detail(f.user, c.id).stage, "clear");
    f.store.db
      .prepare(
        "UPDATE map_points SET due_on='2026-10-01',reviewed_on=NULL WHERE user_id=? AND point_id=?",
      )
      .run(f.user, f.point);
    const pending = (await f.create("question")).card;
    const q = f.learn.point(f.user, f.point),
      review = f.learn.answer(
        f.user,
        f.point,
        canonicalInput(PROBLEMS[f.point]![q.problem!.index]!),
        q.problem!.index,
      );
    assert.equal(review.counted, "review");
    assert.ok(review.learningCards);
    assert.equal(f.cards.detail(f.user, c.id).stage, "closed");
    const moved = await f.cards.update(f.user, pending.id, pending.version, {
      pointId: "limit-squeeze",
    });
    assert.equal(moved.card.learningProofId, null);
    await assert.rejects(
      f.cards.learningClose(f.user, pending.id, moved.card.version, {
        proofId: review.learningCards!.proofId,
        text: "这是已经换了知识点的原有卡片",
      }),
      { code: "INVALID_CARD" },
    );
  } finally {
    f.store.close();
  }
});

test("manual mistake mastery follows D032 and creates one owned closing proof", async () => {
  const f = setup();
  try {
    const at = f.clock().toISOString();
    f.store.db
      .prepare(
        "INSERT INTO materials(id,user_id,kind,title,status,current_version,created_at,updated_at) VALUES('m',?,'problem','错题','confirmed',1,?,?)",
      )
      .run(f.user, at, at);
    f.store.db
      .prepare(
        "INSERT INTO mistakes(id,user_id,material_id,source,status,due_on,created_at,updated_at) VALUES('wrong',?,'m','judge','open','2026-10-01',?,?)",
      )
      .run(f.user, at, at);
    const c = (
      await f.cards.create(f.user, {
        text: "这道题忘了求导时乘上内层导数",
        origin: "mistake",
        mistakeId: "wrong",
        type: "question",
        scene: "study",
        mine: "复合函数求导时需要把内层导数也乘上",
      })
    ).card;
    const mistakes = new MistakeService(
      f.store,
      new Jev({ timeoutMs: 1000 }),
      f.clock,
    );
    mistakes.setStatus(f.user, "wrong", "mastered");
    mistakes.setStatus(f.user, "wrong", "mastered");
    assert.equal(f.cards.detail(f.user, c.id).stage, "closed");
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) AS n FROM events WHERE name='learning_pass'")
        .get()!.n,
      1,
    );
  } finally {
    f.store.close();
  }
});
