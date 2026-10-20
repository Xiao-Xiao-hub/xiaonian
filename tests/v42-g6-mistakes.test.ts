// V4.2 G6 (report B 错题本): a problem filed by hand has not gone wrong yet;
// 弄懂了 says whether the learner marked it or redid it right; the list pages
// and filters by chapter on the server, so old entries past 200 can be read.
import assert from "node:assert/strict";
import test from "node:test";
import { fakeServices, makeApp } from "./fixtures.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { MistakeService } from "../server/src/modules/mistakes/service.js";
import type { Jev } from "../server/src/providers/jev.js";

async function fixture() {
  const clock = { at: new Date("2026-10-12T01:00:00.000Z") };
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, () => clock.at, store);
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: { key: "v42-mistakes" },
  });
  const userId = login.json().data.user.id as string;
  const headers = { authorization: `Bearer ${login.json().data.token}` };
  const get = async (url: string) => {
    const res = await app.inject({ method: "GET", url, headers });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().data;
  };
  const post = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers, payload: payload as string });
  const problem = (id: string) => {
    const at = clock.at.toISOString();
    store.db
      .prepare(
        "INSERT INTO materials(id,user_id,kind,title,status,current_version,created_at,updated_at) VALUES(?,?,'problem','题','confirmed',1,?,?)",
      )
      .run(id, userId, at, at);
    store.db
      .prepare(
        "INSERT INTO material_versions(material_id,version,origin,text,paragraphs,created_at) VALUES(?,1,'typed',?,'[]',?)",
      )
      .run(id, `题 ${id}`, at);
  };
  const mistakes = new MistakeService(
    store,
    { configured: false } as unknown as Jev,
    () => clock.at,
  );
  return { app, store, clock, userId, headers, get, post, problem, mistakes };
}

test("a problem filed by hand starts at 错过 0 次; a real wrong answer counts from there", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  f.problem("m1");
  const filed = f.mistakes.addManual(f.userId, "m1");
  assert.equal(filed.wrong, 0);
  assert.equal(filed.status, "open");
  // Filing it again changes nothing.
  assert.equal(f.mistakes.addManual(f.userId, "m1").wrong, 0);
  f.mistakes.judged(f.userId, "m1", "3", "incorrect", null, "limit");
  assert.equal(f.mistakes.forMaterial(f.userId, "m1")!.wrong, 1);
  // A judged mistake still starts at 1.
  f.problem("m2");
  f.mistakes.judged(f.userId, "m2", "5", "incorrect", null, "limit");
  assert.equal(f.mistakes.forMaterial(f.userId, "m2")!.wrong, 1);
  const { items } = await f.get("/v1/mistakes?status=open&tone=light");
  assert.deepEqual(
    items.map((i: { materialId: string; wrong: number }) => [i.materialId, i.wrong]).sort(),
    [
      ["m1", 1],
      ["m2", 1],
    ],
  );
});

test("弄懂了 tells 我会了 (self) from redone right (redo); reopening clears it", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  f.problem("a");
  f.problem("b");
  f.mistakes.judged(f.userId, "a", "1", "incorrect", null, "limit");
  f.mistakes.judged(f.userId, "b", "1", "incorrect", null, "limit");
  const open = await f.get("/v1/mistakes?status=open&tone=light");
  assert.ok(open.items.every((i: { masteredBy: unknown }) => i.masteredBy === null));
  const a = open.items.find((i: { materialId: string }) => i.materialId === "a");
  assert.equal((await f.post(`/v1/mistakes/${a.id}`, { status: "mastered" })).statusCode, 200);
  // b is redone right the next day, once it is due.
  f.clock.at = new Date("2026-10-13T01:00:00.000Z");
  f.mistakes.judged(f.userId, "b", "2", "correct", null);
  const done = await f.get("/v1/mistakes?status=mastered&tone=light");
  const by = Object.fromEntries(
    done.items.map((i: { materialId: string; masteredBy: string }) => [i.materialId, i.masteredBy]),
  );
  assert.deepEqual(by, { a: "self", b: "redo" });
  // Back to 没弄懂: the mark goes with it.
  assert.equal((await f.post(`/v1/mistakes/${a.id}`, { status: "open" })).statusCode, 200);
  const reopened = await f.get("/v1/mistakes?status=open&tone=light");
  assert.equal(reopened.items[0].masteredBy, null);
  assert.equal(
    f.store.db.prepare("SELECT mastered_by FROM mistakes WHERE id=?").get(a.id)!.mastered_by,
    null,
  );
});

test("the list pages and filters by chapter on the server; counts stay whole", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  for (let i = 0; i < 5; i++) {
    f.problem(`p${i}`);
    // Three in 函数与极限, two never classified (listed under 其他).
    f.mistakes.judged(f.userId, `p${i}`, "1", "incorrect", null, i < 3 ? "limit" : undefined);
  }
  // Without paging: everything, as before, and nothing more.
  const all = await f.get("/v1/mistakes?status=open&tone=light");
  assert.equal(all.items.length, 5);
  assert.equal(all.more, false);
  assert.equal(all.counts.open, 5);
  const first = await f.get("/v1/mistakes?status=open&tone=light&limit=2");
  assert.equal(first.items.length, 2);
  assert.equal(first.more, true);
  const second = await f.get("/v1/mistakes?status=open&tone=light&limit=2&offset=2");
  const last = await f.get("/v1/mistakes?status=open&tone=light&limit=2&offset=4");
  assert.equal(last.items.length, 1);
  assert.equal(last.more, false);
  const ids = [...first.items, ...second.items, ...last.items].map((i: { id: string }) => i.id);
  assert.equal(new Set(ids).size, 5, "pages do not overlap");
  const limit = await f.get("/v1/mistakes?status=open&tone=light&chapter=limit");
  assert.equal(limit.items.length, 3);
  assert.ok(limit.items.every((i: { chapter: string }) => i.chapter === "limit"));
  const other = await f.get("/v1/mistakes?status=open&tone=light&chapter=other");
  assert.equal(other.items.length, 2);
  // The chips still count every chapter.
  assert.equal(other.counts.open, 5);
  const bad = await f.app.inject({
    method: "GET",
    url: "/v1/mistakes?status=open&limit=0",
    headers: f.headers,
  });
  assert.equal(bad.statusCode, 400);
});
