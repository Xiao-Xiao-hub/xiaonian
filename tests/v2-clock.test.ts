import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";
import {
  addDays,
  chinaDate,
  DAY_MS,
  shiftedClock,
} from "../server/src/shared/time.js";

const env = (days = 0) =>
  loadEnv({
    NODE_ENV: "test",
    DEV_LOGIN_ENABLED: "true",
    DATABASE_PATH: ":memory:",
    LOG_LEVEL: "silent",
    TEST_CLOCK_DAYS: String(days),
  });

test("test clock accepts whole-day offsets and production refuses them", () => {
  const base = new Date("2026-10-10T04:00:00.000Z");
  assert.equal(
    shiftedClock(2, () => base)().toISOString(),
    "2026-10-12T04:00:00.000Z",
  );
  assert.throws(() => shiftedClock(0.5), /integer/);
  assert.throws(
    () =>
      loadEnv({
        NODE_ENV: "production",
        DEV_LOGIN_ENABLED: "false",
        DATABASE_PATH: "/srv/data/app.sqlite",
        ADMIN_API_KEY: "synthetic-admin-key-for-isolated-tests-01",
        ADMIN_ORIGIN: "https://admin.example.test",
        WECHAT_APP_ID: "wx-test",
        WECHAT_APP_SECRET: "server-secret",
        TEST_CLOCK_DAYS: "1",
      }),
    /TEST_CLOCK_DAYS/,
  );
});

test("two-day env offset makes tomorrow's retest and continuation due", async () => {
  const store = new SqliteStore(":memory:");
  const started = Date.now();
  const app = buildApp({ env: env(2), store });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: {},
    });
    const serviceAt = Date.parse(String(login.headers["x-service-time"]));
    assert.ok(serviceAt >= started + 2 * DAY_MS - 2000);
    assert.ok(serviceAt <= Date.now() + 2 * DAY_MS + 2000);
    const { token, user } = login.json().data;
    const due = addDays(chinaDate(Date.now()), 1);
    store.db
      .prepare(
        "INSERT INTO retests(user_id,point_id,cause,problem_index,round,due_on,created_at) VALUES(?,?,?,?,1,?,?)",
      )
      .run(user.id, "limit-rules", "hint", 2, due, store.now());
    const headers = { authorization: `Bearer ${token}` };
    const point = await app.inject({
      url: "/v1/learn/points/limit-rules?tone=dark",
      headers,
    });
    assert.equal(point.statusCode, 200);
    assert.equal(point.json().data.mode, "retest");
    assert.equal(point.json().data.retest.mode, true);

    const continuation = await app.inject({
      method: "POST",
      url: "/v1/resume/open",
      headers,
      payload: { visitId: "clock-two-days" },
    });
    assert.equal(continuation.statusCode, 200);
    assert.equal(continuation.json().data.kind, "item");
    assert.equal(continuation.json().data.item.srcId, "limit-rules");
  } finally {
    await app.close();
  }
});

test("an injected clock remains authoritative over the env offset", async () => {
  const fixed = new Date("2026-10-20T02:03:04.000Z");
  const app = buildApp({ env: env(7), now: () => fixed });
  try {
    const response = await app.inject({ url: "/health/live" });
    assert.equal(response.headers["x-service-time"], fixed.toISOString());
  } finally {
    await app.close();
  }
});
