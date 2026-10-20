import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { SqliteStore } from "../server/src/shared/store.js";
import { NoteService } from "../server/src/modules/notes/service.js";
import { CardBackfill } from "../server/src/modules/cards/backfill.js";
import { fakeServices, makeApp } from "./fixtures.js";

test("app startup runs legacy backfill through the real judge protocol without quota receipts", async () => {
  const store = new SqliteStore(":memory:");
  const user = store.upsertUser("dev:startup-backfill", "测试", "dev");
  const notes = new NoteService(store);
  const note = notes.create(user.id, "复盘可以画成一张图");
  const services = fakeServices();
  const calls: string[] = [];
  services.fetcher = (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const q = body.questions.q;
    calls.push(q.type);
    return Response.json({ answers: { q: q.type === "noul"
      ? { noul: 0.01 }
      : { choice: "spark", confidence: 0.9, probabilities: { spark: 0.9, idea: 0.1 } } } });
  }) as typeof fetch;
  const app = makeApp(services, {}, undefined, store);
  try {
    await app.ready();
    const done = () => store.db.prepare("SELECT 1 FROM card_versions WHERE card_id=? AND kind='type' AND by='system'").get(`card_${note.id}`);
    for (let i = 0; i < 100 && !done(); i++) await setTimeout(5);
    assert.ok(done());
    assert.deepEqual(calls, ["noul", "choice"]);
    assert.equal((store.db.prepare("SELECT type FROM cards WHERE id=?").get(`card_${note.id}`) as {type:string}).type, "spark");
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM quota_receipts").get() as {n:number}).n, 0);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM usage_ledger WHERE source='jev'").get() as {n:number}).n, 2);
  } finally { await app.close(); }
});

test("deleting a legacy note deletes its copied card and cannot recreate it on the next backfill", async () => {
  const store = new SqliteStore(":memory:");
  try {
    const user = store.upsertUser("dev:delete-backfill", "测试", "dev");
    const notes = new NoteService(store);
    const note = notes.create(user.id, "如何计算");
    const retained = notes.create(user.id, "保留的笔记");
    const backfill = new CardBackfill(store, {
      checkCrisis: async () => false,
      classify: async () => ({ type: "idea", confidence: 1 }),
    });
    await backfill.run();
    store.db.prepare("INSERT INTO resume_items(id,user_id,src,src_id,item_key,kind,due_on,created_at,updated_at) VALUES('resume',?,'card',?,'type','question','2026-10-14','2026-10-12','2026-10-12')").run(user.id, `card_${note.id}`);
    notes.remove(user.id, note.id);
    await backfill.run();
    for (const table of ["cards", "card_versions"]) {
      const key = table === "cards" ? "id" : "card_id";
      assert.equal(store.db.prepare(`SELECT 1 FROM ${table} WHERE ${key}=?`).get(`card_${note.id}`), undefined);
    }
    assert.equal(store.db.prepare("SELECT 1 FROM resume_items WHERE id='resume'").get(), undefined);
    assert.ok(store.db.prepare("SELECT 1 FROM cards WHERE id=?").get(`card_${retained.id}`));
  } finally { store.close(); }
});
