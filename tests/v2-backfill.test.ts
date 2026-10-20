import test from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../server/src/shared/store.js";
import { CardBackfill } from "../server/src/modules/cards/backfill.js";

const now = "2026-10-12T00:00:00.000Z";

function setup(result: object | null = null, text = "旧随心记") {
  const store = new SqliteStore(":memory:");
  const userId = store.upsertUser("dev:backfill", "测试", "dev").id;
  store.db
    .prepare(
      "INSERT INTO notes(id,user_id,text,title,status,result,created_at,updated_at,title_edited) VALUES('note_1',? ,?,'旧标题',?,?,?, ?,0)",
    )
    .run(userId, text, result ? "organized" : "raw", result && JSON.stringify(result), now, now);
  store.db
    .prepare(
      "INSERT INTO note_supplements(id,note_id,client_id,text,created_at) VALUES('supp_1','note_1','client_1','旧补充',?)",
    )
    .run(now);
  return { store, userId };
}

test("backfill copies omitted notes once, preserves legacy organization and marks the type", async () => {
  const { store, userId } = setup({
    items: [
      { id: "clear_1", group: "clear", text: "已经确认的事", sourceIds: ["original"] },
      { id: "clear_2", group: "clear", text: "另一件确认的事", sourceIds: ["supp_1"] },
      { id: "decide_1", group: "decide", text: "还要决定的事", sourceIds: ["original"] },
      { id: "verify_1", group: "verify", text: "还需核实的事", sourceIds: ["supp_1"] },
    ],
  });
  const calls: string[] = [];
  const backfill = new CardBackfill(store, {
    async checkCrisis(text, scene) {
      calls.push(`crisis:${scene}:${text}`);
      return false;
    },
    async classify(text) {
      calls.push(`classify:${text}`);
      return { type: "method", confidence: 0.8 };
    },
  });
  try {
    await backfill.run();
    await backfill.run();
    assert.deepEqual(calls, ["crisis:life:旧随心记", "classify:旧随心记"]);
    const card = store.db
      .prepare(
        "SELECT type,scene,summary,summary_by,slots,open,organized_at,crisis FROM cards WHERE id='card_note_1'",
      )
      .get() as Record<string, unknown>;
    assert.deepEqual({ ...card }, {
      type: "method",
      scene: "life",
      summary: "已经确认的事\n另一件确认的事",
      summary_by: "ai",
      slots: '[{"key":"steps","text":"已经确认的事\\n另一件确认的事","by":"ai"}]',
      open: '[{"key":"decide_1","cat":"decide","text":"还要决定的事","quote":"旧随心记","by":"ai"},{"key":"verify_1","cat":"verify","text":"还需核实的事","quote":"旧补充","by":"ai"}]',
      organized_at: null,
      crisis: 0,
    });
    assert.equal(
      (store.db
        .prepare("SELECT count(*) AS n FROM card_versions WHERE card_id='card_note_1' AND kind='create'")
        .get() as { n: number }).n,
      1,
    );
    assert.equal(
      (store.db
        .prepare("SELECT count(*) AS n FROM card_versions WHERE card_id='card_note_1' AND kind='supplement'")
        .get() as { n: number }).n,
      1,
    );
    assert.equal(
      (store.db
        .prepare("SELECT count(*) AS n FROM card_versions WHERE card_id='card_note_1' AND kind='type' AND by='system'")
        .get() as { n: number }).n,
      1,
    );
    assert.equal(
      (store.db.prepare("SELECT count(*) AS n FROM notes WHERE user_id=?").get(userId) as { n: number }).n,
      1,
    );
  } finally {
    store.close();
  }
});

test("backfill handles crisis, rules and failed classification without retrying marked cards", async () => {
  const crisis = setup(null, "需要危机判断");
  const question = setup(null, "为什么要复习");
  const method = setup(null, "先整理错题再复测");
  const failed = setup(null, "模型会失败");
  try {
    let crisisClassify = 0;
    await new CardBackfill(crisis.store, {
      async checkCrisis() {
        return true;
      },
      async classify() {
        crisisClassify++;
        return { type: "spark", confidence: 1 };
      },
    }).run();
    assert.equal(crisisClassify, 0);
    assert.deepEqual(
      {
        ...(crisis.store.db
          .prepare("SELECT type,crisis FROM cards WHERE id='card_note_1'")
          .get() as Record<string, unknown>),
      },
      { type: "idea", crisis: 1 },
    );

    let questionClassify = 0;
    await new CardBackfill(question.store, {
      async checkCrisis() {
        return false;
      },
      async classify() {
        questionClassify++;
        return { type: "idea", confidence: 1 };
      },
    }).run();
    assert.equal(questionClassify, 0);
    assert.equal(
      (question.store.db
        .prepare("SELECT type FROM cards WHERE id='card_note_1'")
        .get() as { type: string }).type,
      "question",
    );

    let methodClassify = 0;
    await new CardBackfill(method.store, {
      async checkCrisis() {
        return false;
      },
      async classify() {
        methodClassify++;
        return { type: "method", confidence: 1 };
      },
    }).run();
    // "先…再" is no longer a rule; the judge decides.
    assert.equal(methodClassify, 1);
    assert.equal(
      (method.store.db
        .prepare("SELECT type FROM cards WHERE id='card_note_1'")
        .get() as { type: string }).type,
      "method",
    );

    let classifyCalls = 0;
    const retrySafe = new CardBackfill(failed.store, {
      async checkCrisis() {
        return false;
      },
      async classify() {
        classifyCalls++;
        throw new Error("synthetic failure");
      },
    });
    await retrySafe.run();
    await retrySafe.run();
    assert.equal(classifyCalls, 1);
    assert.equal(
      (failed.store.db
        .prepare("SELECT type FROM cards WHERE id='card_note_1'")
        .get() as { type: string }).type,
      "idea",
    );
  } finally {
    crisis.store.close();
    question.store.close();
    method.store.close();
    failed.store.close();
  }
});

test("backfill accepts confidence 0.6 and defaults below it to idea", async () => {
  const exact = setup();
  const low = setup();
  try {
    await new CardBackfill(exact.store, {
      async checkCrisis() {
        return false;
      },
      async classify() {
        return { type: "method", confidence: 0.6 };
      },
    }).run();
    await new CardBackfill(low.store, {
      async checkCrisis() {
        return false;
      },
      async classify() {
        return { type: "method", confidence: 0.599 };
      },
    }).run();
    assert.equal(
      (exact.store.db.prepare("SELECT type FROM cards WHERE id='card_note_1'").get() as { type: string }).type,
      "method",
    );
    assert.equal(
      (low.store.db.prepare("SELECT type FROM cards WHERE id='card_note_1'").get() as { type: string }).type,
      "idea",
    );
  } finally {
    exact.store.close();
    low.store.close();
  }
});

test("backfill does not recreate or overwrite a card deleted while a check is pending", async () => {
  const { store } = setup();
  let startedResolve!: () => void;
  let gateResolve!: () => void;
  const started = new Promise<void>((resolve) => (startedResolve = resolve));
  const gate = new Promise<void>((resolve) => (gateResolve = resolve));
  const backfill = new CardBackfill(store, {
    async checkCrisis() {
      startedResolve();
      return gate.then(() => false);
    },
    async classify() {
      return { type: "idea", confidence: 1 };
    },
  });
  try {
    const pending = backfill.run();
    await started;
    store.db.prepare("DELETE FROM cards WHERE id='card_note_1'").run();
    gateResolve();
    await pending;
    assert.equal(
      store.db.prepare("SELECT 1 FROM cards WHERE id='card_note_1'").get(),
      undefined,
    );
  } finally {
    store.close();
  }
});

test("backfill does not overwrite a card edited or closed while a check is pending", async () => {
  for (const mutation of [
    "UPDATE cards SET title='用户编辑',version=version+1 WHERE id='card_note_1'",
    "UPDATE cards SET closed_at='2026-10-12T01:00:00.000Z',version=version+1 WHERE id='card_note_1'",
  ]) {
    const { store } = setup();
    let startedResolve!: () => void;
    let gateResolve!: () => void;
    const started = new Promise<void>((resolve) => (startedResolve = resolve));
    const gate = new Promise<void>((resolve) => (gateResolve = resolve));
    const backfill = new CardBackfill(store, {
      async checkCrisis() {
        startedResolve();
        return gate.then(() => false);
      },
      async classify() {
        return { type: "method", confidence: 1 };
      },
    });
    try {
      const pending = backfill.run();
      await started;
      store.db.exec(mutation);
      gateResolve();
      await pending;
      assert.equal(
        store.db
          .prepare("SELECT 1 FROM card_versions WHERE card_id='card_note_1' AND kind='type'")
          .get(),
        undefined,
        mutation,
      );
    } finally {
      store.close();
    }
  }
});

test("stopping backfill leaves the card unmarked for a later startup", async () => {
  const { store } = setup();
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => (startedResolve = resolve));
  const controller = new AbortController();
  const backfill = new CardBackfill(store, {
    async checkCrisis(_text, _scene, signal) {
      startedResolve();
      return new Promise<boolean>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    },
    async classify() {
      return { type: "idea", confidence: 1 };
    },
  });
  try {
    const pending = backfill.run(controller.signal);
    await started;
    controller.abort(new Error("server stopping"));
    await pending;
    assert.equal(
      store.db
        .prepare("SELECT 1 FROM card_versions WHERE card_id='card_note_1' AND kind='type'")
        .get(),
      undefined,
    );
  } finally {
    store.close();
  }
});

test("screening failures fall back to keywords and still apply question rules", async () => {
  for (const [text, crisis, type] of [["我不想活了", 1, "idea"], ["为什么求导", 0, "question"]] as const) {
    const { store } = setup(null, text);
    try {
      await new CardBackfill(store, {
        checkCrisis: async () => { throw new Error("screening timeout"); },
        classify: async () => { throw new Error("rules should avoid this call"); },
      }).run();
      assert.deepEqual({ ...store.db.prepare("SELECT crisis,type FROM cards WHERE id='card_note_1'").get() }, { crisis, type });
    } finally { store.close(); }
  }
});
