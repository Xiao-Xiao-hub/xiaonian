import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { fakeServices, makeApp } from "./fixtures.js";

// 学习时长 (V4.md 约定 6, D108).
function fixture(t: TestContext, start = "2026-10-16T04:00:00.000Z") {
  let at = Date.parse(start);
  const now = () => new Date(at);
  const store = new SqliteStore(":memory:", now);
  const app = makeApp(fakeServices(), {}, now, store);
  t.after(() => app.close());
  const login = async (key: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key },
    });
    const { token, user } = response.json().data;
    return {
      userId: user.id as string,
      call: (
        method: "GET" | "POST" | "PUT" | "DELETE",
        url: string,
        payload?: object,
      ) =>
        app.inject({
          method,
          url,
          payload,
          headers: { authorization: "Bearer " + token },
        }),
    };
  };
  return {
    store,
    login,
    setNow: (iso: string) => {
      at = Date.parse(iso);
    },
  };
}
type Me = Awaited<ReturnType<ReturnType<typeof fixture>["login"]>>;
const report = (me: Me, seconds: unknown) =>
  me.call("POST", "/v1/me/study-time", { seconds });
// Seeds whole days directly: { "2026-10-01": minutes }.
function seed(store: SqliteStore, userId: string, days: Record<string, number>) {
  for (const [day, minutes] of Object.entries(days))
    store.db
      .prepare("INSERT INTO study_days VALUES(?,?,?,?)")
      .run(userId, day, minutes * 60, "2026-10-16T00:00:00.000Z");
}

test("a report must be 1 to 900 whole seconds", async (t) => {
  const { login } = fixture(t);
  const me = await login("st-bounds");
  for (const bad of [0, -5, 901, 1.5, "60", null])
    assert.equal((await report(me, bad)).statusCode, 400, String(bad));
  assert.equal(
    (await me.call("POST", "/v1/me/study-time", { seconds: 60, day: "2020-01-01" }))
      .statusCode,
    400,
  );
  const one = await report(me, 1);
  assert.equal(one.statusCode, 200);
  assert.equal(one.json().data.recorded, true);
  const max = await report(me, 900);
  assert.equal(max.statusCode, 200);
  assert.equal(max.json().data.today, 15);
});

test("a day adds up and stops at 86400 seconds", async (t) => {
  const { login, store } = fixture(t);
  const me = await login("st-cap");
  for (let i = 0; i < 100; i++) await report(me, 900);
  const row = store.db
    .prepare("SELECT seconds FROM study_days WHERE user_id=?")
    .get(me.userId) as { seconds: number };
  assert.equal(row.seconds, 86400);
  const view = (await me.call("GET", "/v1/me/study-time")).json().data;
  assert.equal(view.today, 1440);
  assert.equal(view.totalMinutes, 1440);
});

test("the day is the server's Beijing date", async (t) => {
  const { login, setNow } = fixture(t, "2026-10-16T15:59:00.000Z");
  const me = await login("st-day");
  // 23:59 on the 16th in Beijing.
  await report(me, 120);
  setNow("2026-10-16T16:00:30.000Z");
  // 00:00 on the 17th.
  await report(me, 180);
  const view = (await me.call("GET", "/v1/me/study-time")).json().data;
  assert.equal(view.day, "2026-10-17");
  assert.deepEqual(view.days, [
    { day: "2026-10-16", minutes: 2 },
    { day: "2026-10-17", minutes: 3 },
  ]);
  assert.equal(view.today, 3);
  assert.equal(view.currentStreak, 2);
});

test("nothing is recorded while the statistics are off", async (t) => {
  const { login, store } = fixture(t);
  const me = await login("st-off");
  await me.call("PUT", "/v1/me/prefs", { studyTime: false });
  const off = await report(me, 300);
  assert.equal(off.statusCode, 200);
  assert.deepEqual(off.json().data, { recorded: false });
  const count = store.db
    .prepare("SELECT COUNT(*) AS n FROM study_days WHERE user_id=?")
    .get(me.userId) as { n: number };
  assert.equal(count.n, 0);
  const view = (await me.call("GET", "/v1/me/study-time")).json().data;
  assert.equal(view.enabled, false);
  await me.call("PUT", "/v1/me/prefs", { studyTime: true });
  assert.equal((await report(me, 300)).json().data.recorded, true);
});

test("the four numbers come from the same days as the heat map", async (t) => {
  // Beijing 2026-10-16.
  const { login, store } = fixture(t);
  const me = await login("st-view");
  seed(store, me.userId, {
    // Older than 126 days: counted in the total and the best run only.
    "2026-05-01": 30,
    "2026-05-02": 30,
    "2026-05-03": 30,
    "2026-05-04": 30,
    // Inside the window.
    "2026-06-13": 10,
    "2026-10-10": 20,
    "2026-10-11": 40,
    "2026-10-13": 5,
    "2026-10-14": 70,
    "2026-10-15": 15,
  });
  // Under a minute is not a study day.
  store.db
    .prepare("INSERT INTO study_days VALUES(?,?,?,?)")
    .run(me.userId, "2026-10-12", 59, "2026-10-16T00:00:00.000Z");
  const view = (await me.call("GET", "/v1/me/study-time")).json().data;
  assert.equal(view.enabled, true);
  assert.equal(view.day, "2026-10-16");
  assert.equal(view.today, 0);
  // 2026-06-13 is the first day of the 126-day window.
  assert.deepEqual(
    view.days.map((d: { day: string }) => d.day),
    ["2026-06-13", "2026-10-10", "2026-10-11", "2026-10-13", "2026-10-14", "2026-10-15"],
  );
  assert.equal(view.totalMinutes, 120 + 10 + 20 + 40 + 5 + 70 + 15);
  // V4.2 累计天数: every day with a whole minute, inside the window or not;
  // the 59 seconds of 10-12 are not a day.
  assert.equal(view.totalDays, 10);
  // Today has nothing yet: the run ending yesterday still counts.
  assert.equal(view.currentStreak, 3);
  assert.equal(view.bestStreak, 4);
  await report(me, 120);
  const after = (await me.call("GET", "/v1/me/study-time")).json().data;
  assert.equal(after.currentStreak, 4);
  assert.equal(after.today, 2);
  assert.equal(after.totalDays, 11);
});

test("a gap of a day ends the current run", async (t) => {
  const { login, store } = fixture(t);
  const me = await login("st-gap");
  seed(store, me.userId, { "2026-10-13": 10, "2026-10-14": 10 });
  const view = (await me.call("GET", "/v1/me/study-time")).json().data;
  assert.equal(view.currentStreak, 0);
  assert.equal(view.bestStreak, 2);
  const empty = await login("st-empty");
  assert.deepEqual((await empty.call("GET", "/v1/me/study-time")).json().data, {
    enabled: true,
    day: "2026-10-16",
    today: 0,
    days: [],
    totalMinutes: 0,
    totalDays: 0,
    currentStreak: 0,
    bestStreak: 0,
  });
});

test("delete removes only the caller's days", async (t) => {
  const { login, store } = fixture(t);
  const me = await login("st-del");
  const other = await login("st-del-other");
  seed(store, me.userId, { "2026-10-14": 10, "2026-10-15": 10 });
  seed(store, other.userId, { "2026-10-15": 10 });
  const gone = await me.call("DELETE", "/v1/me/study-time");
  assert.equal(gone.statusCode, 200);
  assert.equal(gone.json().data.deleted, 2);
  assert.equal(
    (await me.call("GET", "/v1/me/study-time")).json().data.totalMinutes,
    0,
  );
  assert.equal(
    (await other.call("GET", "/v1/me/study-time")).json().data.totalMinutes,
    10,
  );
});

test("the export lists the days and deleting the account removes them", async (t) => {
  const { login, store } = fixture(t);
  const me = await login("st-export");
  await report(me, 125);
  const exported = (await me.call("GET", "/v1/me/export")).json();
  assert.deepEqual(exported.studyDays, [
    {
      day: "2026-10-16",
      seconds: 125,
      minutes: 2,
      updatedAt: "2026-10-16T04:00:00.000Z",
    },
  ]);
  const erased = await me.call("DELETE", "/v1/me", { confirm: true });
  assert.equal(erased.statusCode, 200);
  const count = store.db
    .prepare("SELECT COUNT(*) AS n FROM study_days WHERE user_id=?")
    .get(me.userId) as { n: number };
  assert.equal(count.n, 0);
});

test("the table is added without a new schema version", () => {
  const store = new SqliteStore(":memory:");
  const version = store.db
    .prepare("SELECT MAX(version) AS v FROM schema_migrations")
    .get() as { v: number };
  assert.equal(version.v, 16);
  const columns = (
    store.db.prepare("PRAGMA table_info(study_days)").all() as { name: string }[]
  ).map((c) => c.name);
  assert.deepEqual(columns, ["user_id", "day", "seconds", "updated_at"]);
});

test("signing in is required", async (t) => {
  const app = makeApp(fakeServices());
  t.after(() => app.close());
  for (const method of ["GET", "POST", "DELETE"] as const)
    assert.equal(
      (
        await app.inject({
          method,
          url: "/v1/me/study-time",
          payload: method === "POST" ? { seconds: 60 } : undefined,
        })
      ).statusCode,
      401,
    );
});
