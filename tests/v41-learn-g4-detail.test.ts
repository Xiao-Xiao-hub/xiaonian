import test from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../server/src/shared/store.js";
import { fakeServices, makeApp } from "./fixtures.js";

// the point detail page took over the map's detail sheet, so the
// detail API adds (only adds) what that sheet read from the map: line kind,
// difficulty, the learner's flags, the open retest, linked cards and mistakes.
const ID = "derivative-chain";
const ADDED = [
  "side",
  "level",
  "ready",
  "red",
  "stuck",
  "stuckAt",
  "inferredBy",
  "retest",
  "cards",
  "mistakeCount",
  "taught",
];

test("detail adds the sheet's fields, the same as the map's point; a guest gets defaults", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, () => new Date("2026-10-04T20:00:00Z"), store);
  t.after(() => app.close());
  const { token, user } = (
    await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "g4" } })
  ).json().data;
  const headers = { authorization: `Bearer ${token}` };
  const get = async (url: string) =>
    (await app.inject({ method: "GET", url, headers })).json().data;
  const post = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers, payload: payload as string });

  assert.equal(
    (await post("/v1/learn/marks", { action: "stuck", pointId: ID })).statusCode,
    200,
  );
  const at = "2026-10-04T19:00:00.000Z";
  store.db
    .prepare(
      `INSERT INTO cards(id,user_id,type,scene,title,title_by,mine,mine_at,quote,quote_on,origin,src_id,mistake_id,point_id,saw_answer,crisis,closed_at,created_at,updated_at)
       VALUES(?,?,'question','study','链式法则卡','user','内容',?,'原话',date(?,'+8 hours'),'jot',NULL,NULL,?,0,0,NULL,?,?)`,
    )
    .run("card-g4", user.id, at, at, ID, at, at);

  const d = await get(`/v1/learn/points/${ID}/detail`);
  const map = await get("/v1/learn/map");
  const onMap = map.chapters
    .flatMap((c: any) => c.points)
    .find((p: any) => p.id === ID);
  for (const key of ADDED) assert.deepEqual(d[key], onMap[key], key);
  assert.equal(d.stuck, true);
  assert.equal(d.state, "stuck");
  assert.equal(d.cards.count, 1);
  assert.equal(d.cards.items[0].title, "链式法则卡");
  assert.equal(d.ready, true);
  // The old fields are still there, unchanged in kind.
  assert.ok(Array.isArray(d.formulas) && d.keys.length === 3);
  assert.equal(typeof d.bank.problems, "number");

  const g = (
    await app.inject({ method: "GET", url: `/v1/learn/points/${ID}/detail/public` })
  ).json().data;
  assert.equal(g.guest, true);
  assert.equal(g.level, d.level);
  assert.equal(g.side, d.side);
  assert.deepEqual(
    [g.red, g.stuck, g.stuckAt, g.inferredBy, g.retest, g.cards, g.mistakeCount, g.taught],
    [false, false, null, null, null, { count: 0, items: [] }, 0, true],
  );
});
