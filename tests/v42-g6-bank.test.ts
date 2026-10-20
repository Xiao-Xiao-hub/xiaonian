// V4.2 G6 (report B 题库, 我的进度): the bank lists each problem of a point
// with how it went, so one problem can be opened from the list; study time
// says on how many days the learner studied at all.
import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { BANK } from "../server/src/modules/learn/problems.js";
import { fakeServices, makeApp } from "./fixtures.js";

async function fixture(t: test.TestContext, start = "2026-10-12T04:00:00.000Z") {
  let at = Date.parse(start);
  const now = () => new Date(at);
  const store = new SqliteStore(":memory:", now);
  const app = makeApp(fakeServices(), {}, now, store);
  t.after(() => app.close());
  const login = (
    await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "v42-bank" } })
  ).json().data;
  const headers = { authorization: `Bearer ${login.token}` };
  const call = (method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  return { app, store, call, userId: login.user.id as string, setNow: (iso: string) => (at = Date.parse(iso)) };
}

test("the bank lists each problem of a point: done right, tried, or not yet; a guest gets none", async (t) => {
  const f = await fixture(t);
  const pointId = Object.keys(BANK).find((id) => (BANK[id]?.length ?? 0) >= 3)!;
  const at = "2026-10-12T04:00:00.000Z";
  f.store.db
    .prepare("INSERT INTO map_points(user_id,point_id,attempts,updated_at) VALUES(?,?,?,?)")
    .run(
      f.userId,
      pointId,
      JSON.stringify({
        "0": { tries: 1, correctAt: at, last: "correct" },
        "1": { tries: 2, correctAt: null, last: "incorrect" },
      }),
      at,
    );
  const bank = (await f.call("GET", "/v1/learn/bank")).json().data;
  const point = bank.chapters.flatMap((c: { points: unknown[] }) => c.points).find((p: { id: string }) => p.id === pointId);
  assert.equal(point.items.length, BANK[pointId]!.length);
  assert.deepEqual(point.items.slice(0, 3), ["correct", "tried", "none"]);
  // The counts it already had agree.
  assert.equal(point.done, 2);
  assert.equal(point.correct, 1);
  const open = (await f.app.inject({ method: "GET", url: "/v1/learn/bank/public" })).json().data;
  const guestPoint = open.chapters.flatMap((c: { points: unknown[] }) => c.points).find((p: { id: string }) => p.id === pointId);
  assert.equal(guestPoint.items, undefined);
});

test("study time counts every day studied, not only the recent weeks", async (t) => {
  const f = await fixture(t, "2026-01-05T04:00:00.000Z");
  await f.call("POST", "/v1/me/study-time", { seconds: 600 });
  // Half a year later: outside the heat map's window, still a day studied.
  f.setNow("2026-07-06T04:00:00.000Z");
  await f.call("POST", "/v1/me/study-time", { seconds: 300 });
  f.setNow("2026-07-07T04:00:00.000Z");
  await f.call("POST", "/v1/me/study-time", { seconds: 120 });
  const view = (await f.call("GET", "/v1/me/study-time")).json().data;
  assert.equal(view.days.length, 2);
  assert.equal(view.totalDays, 3);
  assert.equal(view.totalMinutes, 17);
});
