import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { CommercialLedger } from "../server/src/shared/commercial-ledger.js";

test("outer business failure rolls back nested settlement and leaves a releasable hold", (t) => {
  const store = new SqliteStore(":memory:"); t.after(() => store.close());
  const user = store.upsertUser("dev:atomic", "用户", "dev");
  const ledger = new CommercialLedger(store);
  ledger.ensureBucket({ id: "wallet", userId: user.id, kind: "wallet", credits: 10, startsAt: 0, endsAt: null });
  ledger.reserve({ id: "call", userId: user.id, source: "test", credits: 5, sources: [{ name: "wallet", buckets: ["wallet"] }], price: {}, leaseMs: 10000 });
  assert.throws(() => store.transaction(() => {
    ledger.settle(user.id, "call", 2000, 1000);
    throw Error("answer-write-failed");
  }), /answer-write-failed/);
  assert.equal(ledger.balance("wallet"), 5);
  assert.equal(store.db.prepare("SELECT status FROM commercial_calls WHERE id='call'").get()!.status, "held");
  ledger.release(user.id, "call");
  assert.equal(ledger.balance("wallet"), 10);
});

test("caught inner failure rolls back only its savepoint; async transactions are rejected", (t) => {
  const store = new SqliteStore(":memory:"); t.after(() => store.close());
  store.transaction(() => {
    store.saveSetting("outer", 1);
    assert.throws(() => store.transaction(() => { store.saveSetting("inner", 2); throw Error("inner-failed"); }));
    store.saveSetting("after", 3);
  });
  assert.equal(store.setting("outer"), 1);
  assert.equal(store.setting("inner"), undefined);
  assert.equal(store.setting("after"), 3);
  assert.throws(() => store.transaction(async () => { store.saveSetting("async", 4); }), /同步/);
  assert.equal(store.setting("async"), undefined);
  store.transaction(() => store.saveSetting("healthy", true));
  assert.equal(store.setting("healthy"), true);
});
