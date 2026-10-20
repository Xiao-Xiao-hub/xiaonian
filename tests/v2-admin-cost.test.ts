import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { monthlyCost, PRICE_AS_OF } from "../server/src/modules/admin/cost.js";

const now = Date.parse("2026-10-12T04:00:00.000Z");
const at = new Date(now).toISOString();
const usage = {
  provider: "open.bigmodel.cn",
  model: "glm-5.3",
  calls: 1,
  promptTokens: 1000,
  completionTokens: 1000,
  cachedTokens: 100,
};

function setup() {
  const store = new SqliteStore(":memory:");
  const userId = store.upsertUser("dev:cost", "测试", "dev").id;
  return { store, userId };
}

test("monthly estimate combines the three user-owned usage stores at the fixed price snapshot", () => {
  const { store, userId } = setup();
  try {
    store.db
      .prepare("INSERT INTO jobs(id,user_id,kind,params,params_hash,status,usage,created_at) VALUES('job',?,'x','{}','job','succeeded',?,?)")
      .run(userId, JSON.stringify(usage), at);
    store.db
      .prepare("INSERT INTO threads(id,user_id,title,created_at,updated_at) VALUES('thread',?,'t',?,?)")
      .run(userId, at, at);
    store.db
      .prepare("INSERT INTO messages(id,thread_id,user_id,role,kind,status,usage,created_at) VALUES('message','thread',?,'assistant','reply','done',?,?)")
      .run(userId, JSON.stringify([usage]), at);
    store.db
      .prepare("INSERT INTO chat_images(id,user_id,path,usage,created_at) VALUES('image',?,'/tmp/image',?,?)")
      .run(userId, JSON.stringify(usage), at);
    const result = monthlyCost(store, userId, now);
    const perCall = (900 * 8 + 100 * 2 + 1000 * 28) / 1_000_000;
    assert.deepEqual(
      result,
      {
        period: "2026-10",
        currency: "CNY",
        priceAsOf: PRICE_AS_OF,
        amount: perCall * 3,
        knownCalls: 3,
        unknownCalls: 0,
        stuckCalls: 0,
        stuckAverage: null,
      },
    );
  } finally {
    store.close();
  }
});

// priced from the admin's table; an unpriced model is charged at
// the table's highest rate (counted in unknownCalls) instead of making the
// month unknown, and 卡点 help is priced from its own spend row.
test("unknown usage is priced at the highest rate and never becomes zero-cost", () => {
  const { store, userId } = setup();
  try {
    store.db
      .prepare("INSERT INTO jobs(id,user_id,kind,params,params_hash,status,usage,created_at) VALUES('unknown',?,'x','{}','unknown','succeeded',?,?)")
      .run(
        userId,
        JSON.stringify({ ...usage, model: "old-model", calls: 2 }),
        at,
      );
    const result = monthlyCost(store, userId, now);
    assert.equal(result.amount, (900 * 36 + 100 * 3.6 + 1000 * 180) / 1_000_000);
    assert.equal(result.knownCalls, 0);
    assert.equal(result.unknownCalls, 2);
    assert.equal(result.stuckCalls, 0);
    assert.equal(result.stuckAverage, null);
    // Once the admin prices it, it is known.
    store.saveSetting("ai.prices", [
      { host: "", model: "old-model", input: 1, output: 1, cached: 1, note: "" },
    ]);
    const priced = monthlyCost(store, userId, now);
    assert.equal(priced.amount, 2000 / 1_000_000);
    assert.equal(priced.knownCalls, 2);
  } finally {
    store.close();
  }
});

test("estimate uses China month bounds, isolates users and counts delivered stuck help once", () => {
  const { store, userId } = setup();
  try {
    const other = store.upsertUser("dev:other-cost", "其他", "dev").id;
    const insert = store.db.prepare("INSERT INTO jobs(id,user_id,kind,params,params_hash,status,usage,created_at) VALUES(?,?,'x','{}',?,'succeeded',?,?)");
    for (const [id, owner, time, data] of [
      ["previous", userId, "2026-09-30T15:59:59.999Z", usage],
      ["first", userId, "2026-09-30T16:00:00.000Z", usage],
      ["next", userId, "2026-10-31T16:00:00.000Z", usage],
      ["other", other, at, usage],
      ["stuck-copy", userId, at, { ...usage, scene: "map_stuck" }],
    ] as const) insert.run(id, owner, id, JSON.stringify(data), time);
    const spend = store.db.prepare("INSERT INTO quota_spend(source,source_id,user_id,usage,created_at) VALUES(?,?,?,?,?)");
    spend.run("chat", "map_one", userId, JSON.stringify([{ ...usage, scene: "map_stuck" }]), at);
    // Spend rows of jobs are already in the jobs table: not added again.
    spend.run("job", "first", userId, JSON.stringify(usage), at);
    const result = monthlyCost(store, userId, now);
    assert.equal(result.amount, 2 * (900 * 8 + 100 * 2 + 1000 * 28) / 1_000_000);
    assert.equal(result.knownCalls, 2);
    assert.equal(result.stuckCalls, 1);
    assert.equal(result.unknownCalls, 0);
  } finally { store.close(); }
});
