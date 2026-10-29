import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { safeError } from "../server/src/shared/logging.js";
import { SqliteStore } from "../server/src/shared/store.js";

const KEY = "synthetic-test-admin-0123456789abcdef";
const ORIGIN = "http://127.0.0.1:8788";
const HOST = "127.0.0.1:8788";
function create(now?: () => Date) {
  return buildApp({
    env: loadEnv({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      LOG_LEVEL: "silent",
      ADMIN_API_KEY: KEY,
    }),
    now,
  });
}
async function login(app: ReturnType<typeof create>, cookie?: string) {
  return app.inject({
    method: "POST",
    url: "/v1/admin/session",
    headers: { host: HOST, origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    payload: { key: KEY },
  });
}
function cookieOf(response: Awaited<ReturnType<typeof login>>) {
  assert.equal(response.statusCode, 200, response.body);
  return String(response.headers["set-cookie"]).split(";")[0]!;
}
const requestHeaders = (cookie: string) => ({
  host: HOST,
  cookie,
  origin: ORIGIN,
});

test("admin login exchanges the long-lived key for an opaque, server-owned session", async () => {
  const app = create();
  try {
    const response = await login(app);
    const cookie = cookieOf(response);
    assert.match(
      String(response.headers["set-cookie"]),
      /HttpOnly; SameSite=Strict/,
    );
    assert.match(String(response.headers["set-cookie"]), /Path=\/v1\/admin/);
    assert.doesNotMatch(response.body + cookie, new RegExp(KEY));
    assert.equal(response.json().data.idleTimeoutSec, 900);
    assert.equal(response.json().data.authenticated, true);
    const overview = await app.inject({
      url: "/v1/admin/overview",
      headers: requestHeaders(cookie),
    });
    assert.equal(overview.statusCode, 200);
    assert.equal(overview.json().data.users, 0);
    const me = await app.inject({
      url: "/v1/auth/me",
      headers: requestHeaders(cookie),
    });
    assert.equal(
      me.statusCode,
      401,
      "an admin cookie is never a learner identity",
    );
    const audit = await app.inject({
      url: "/v1/admin/audit",
      headers: requestHeaders(cookie),
    });
    assert.match(audit.body, /admin.session.created/);
    assert.doesNotMatch(audit.body, new RegExp(KEY));
    assert.doesNotMatch(audit.body, new RegExp(cookie.split("=")[1]!));
  } finally {
    await app.close();
  }
});

test("browser login and cookie-authenticated writes reject missing or foreign origins", async () => {
  const app = create();
  try {
    for (const origin of [undefined, "https://unrelated.example", "null"]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/admin/session",
        payload: { key: KEY },
        headers: { host: HOST, ...(origin ? { origin } : {}) },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().code, "ADMIN_ORIGIN_REJECTED");
    }
    const cookie = cookieOf(await login(app));
    for (const headers of [
      { host: HOST, cookie },
      { host: HOST, cookie, origin: "https://unrelated.example" },
      { host: HOST, cookie, origin: ORIGIN, "sec-fetch-site": "same-site" },
    ]) {
      const result = await app.inject({
        method: "DELETE",
        url: "/v1/admin/session",
        headers,
      });
      assert.equal(result.statusCode, 403);
    }
    assert.equal(
      (
        await app.inject({
          url: "/v1/admin/overview",
          headers: requestHeaders(cookie),
        })
      ).statusCode,
      200,
    );
    const foreignRead = await app.inject({
      url: "/v1/admin/overview",
      headers: { host: HOST, cookie, origin: "https://unrelated.example" },
    });
    assert.equal(foreignRead.statusCode, 403);
    const foreignKeyRead = await app.inject({
      url: "/v1/admin/overview",
      headers: {
        host: HOST,
        "x-admin-key": KEY,
        origin: "https://unrelated.example",
      },
    });
    assert.equal(foreignKeyRead.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("logout, login rotation and duplicate cookies cannot reuse an old admin session", async () => {
  const app = create();
  try {
    const oldCookie = cookieOf(await login(app));
    const cookie = cookieOf(await login(app, oldCookie));
    assert.notEqual(cookie, oldCookie);
    assert.equal(
      (
        await app.inject({
          url: "/v1/admin/overview",
          headers: requestHeaders(oldCookie),
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url: "/v1/admin/overview",
          headers: requestHeaders(`${cookie}; ${oldCookie}`),
        })
      ).statusCode,
      401,
    );
    const out = await app.inject({
      method: "DELETE",
      url: "/v1/admin/session",
      headers: requestHeaders(cookie),
    });
    assert.equal(out.statusCode, 200);
    assert.match(String(out.headers["set-cookie"]), /Max-Age=0/);
    const expired = await app.inject({
      url: "/v1/admin/session",
      headers: requestHeaders(cookie),
    });
    assert.equal(expired.statusCode, 401);
    assert.equal(expired.json().code, "ADMIN_SESSION_EXPIRED");
  } finally {
    await app.close();
  }
});

test("the server enforces admin idle expiry independently of JavaScript", async () => {
  let now = Date.parse("2026-10-04T00:00:00Z");
  const app = create(() => new Date(now));
  try {
    const cookie = cookieOf(await login(app));
    now += 14 * 60_000;
    assert.equal(
      (
        await app.inject({
          url: "/v1/admin/session",
          headers: requestHeaders(cookie),
        })
      ).statusCode,
      200,
    );
    now += 15 * 60_000;
    assert.equal(
      (
        await app.inject({
          url: "/v1/admin/session",
          headers: requestHeaders(cookie),
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});

test("active admin sessions cannot extend their eight-hour absolute lifetime", async () => {
  let now = Date.parse("2026-10-04T00:00:00Z");
  const beginning = now;
  const app = create(() => new Date(now));
  try {
    const cookie = cookieOf(await login(app));
    for (let i = 0; i < 34; i++) {
      now += 14 * 60_000;
      assert.equal(
        (
          await app.inject({
            url: "/v1/admin/session",
            headers: requestHeaders(cookie),
          })
        ).statusCode,
        200,
      );
    }
    now = beginning + 8 * 60 * 60_000;
    assert.equal(
      (
        await app.inject({
          url: "/v1/admin/session",
          headers: requestHeaders(cookie),
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});

test("admin login failures are throttled and audit records contain no submitted key", async () => {
  const app = create();
  try {
    for (let i = 0; i < 5; i++) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/admin/session",
        headers: { host: HOST, origin: ORIGIN },
        payload: { key: "synthetic-wrong-key-never-log" },
      });
      assert.equal(response.statusCode, 401);
    }
    assert.equal((await login(app)).statusCode, 429);
    const audit = await app.inject({
      url: "/v1/admin/audit",
      headers: { "x-admin-key": KEY },
    });
    assert.equal(audit.json().data.length, 5);
    assert.ok(
      audit
        .json()
        .data.every(
          (entry: { action: string }) => entry.action === "admin.login.failed",
        ),
    );
    assert.doesNotMatch(audit.body, /synthetic-wrong-key/);
  } finally {
    await app.close();
  }
});

test("production rejects ambiguous origins and issues secure admin cookies", async () => {
  const base = {
    NODE_ENV: "production",
    DATABASE_PATH: "synthetic.sqlite",
    WECHAT_APP_ID: "test-wechat",
    WECHAT_APP_SECRET: "test-secret",
    ADMIN_API_KEY: KEY,
    LOG_LEVEL: "silent",
  };
  for (const ADMIN_ORIGIN of [
    undefined,
    "http://admin.example.test",
    "https://admin.example.test/",
    "https://user:pass@admin.example.test",
    "https://admin.example.test/path",
  ]) {
    assert.throws(() => loadEnv({ ...base, ADMIN_ORIGIN }));
  }
  // Long enough but trivially guessable keys are refused in production.
  for (const ADMIN_API_KEY of ["a".repeat(40), "abcabcabcabcabcabcabcabcabcabcabcabc"])
    assert.throws(
      () => loadEnv({ ...base, ADMIN_API_KEY, ADMIN_ORIGIN: "https://admin.example.test" }),
      /too weak/,
    );
  const production = loadEnv({
    ...base,
    ADMIN_ORIGIN: "https://admin.example.test",
  });
  // The database is still entirely in memory; only the cookie/config mode is production.
  const app = buildApp({ env: { ...production, DATABASE_PATH: ":memory:" } });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/session",
      headers: { host: "internal-service", origin: production.ADMIN_ORIGIN! },
      payload: { key: KEY },
    });
    assert.equal(response.statusCode, 200);
    assert.match(
      String(response.headers["set-cookie"]),
      /^__Secure-zhiye_admin=.*; Secure$/,
    );
    const untrusted = await app.inject({
      method: "POST",
      url: "/v1/admin/session",
      headers: {
        host: "attacker.invalid",
        origin: "https://attacker.invalid",
        "x-forwarded-host": "admin.example.test",
      },
      payload: { key: KEY },
    });
    assert.equal(untrusted.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("diagnostics retain safe codes without serializing upstream messages or properties", () => {
  const error = Object.assign(new TypeError("synthetic learner private text"), {
    code: "AI_TIMEOUT",
    authorization: "synthetic-secret",
    cause: { body: "synthetic provider reply" },
  });
  assert.deepEqual(safeError(error), { code: "AI_TIMEOUT", type: "TypeError" });
  assert.deepEqual(
    safeError({ code: "secret with spaces", message: "private" }),
    { code: "INTERNAL_ERROR", type: "Error" },
  );
});

test("operations publishes useful state without private paths or credentials", async () => {
  const app = create();
  try {
    const response = await app.inject({
      url: "/v1/admin/operations",
      headers: { "x-admin-key": KEY },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.backup.status, "unknown");
    assert.deepEqual(response.json().data.accounting, {
      status: "ok",
      writeFailures: 0,
      commercialWriteFailures: 0,
    });
    assert.equal(response.json().data.security.adminIdleTimeoutSec, 900);
    assert.ok(response.json().data.process.rssBytes > 0);
    assert.doesNotMatch(response.body, new RegExp(KEY));
    assert.doesNotMatch(
      response.body,
      /DATABASE_PATH|UPLOAD_DIR|WECHAT_APP_SECRET|LLM_API_KEY/,
    );
  } finally {
    await app.close();
  }
});

test("registered route limits apply and untrusted forwarding cannot reset a login bucket", async () => {
  const app = create();
  try {
    for (let i = 0; i < 6; i++) {
      const result = await app.inject({
        method: "POST",
        url: "/v1/admin/session",
        remoteAddress: "192.0.2.10",
        headers: {
          host: HOST,
          origin: ORIGIN,
          "x-forwarded-for": `198.51.100.${i + 1}`,
        },
        payload: { key: "synthetic-wrong-key" },
      });
      assert.equal(result.statusCode, i < 5 ? 401 : 429);
    }
    const learner = buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        DEV_LOGIN_ENABLED: "true",
        DATABASE_PATH: ":memory:",
        LOG_LEVEL: "silent",
      }),
    });
    try {
      for (let i = 0; i < 11; i++) {
        const result = await learner.inject({
          method: "POST",
          url: "/v1/auth/dev-login",
          payload: { key: "limit-test" },
        });
        assert.equal(result.statusCode, i < 10 ? 200 : 429);
      }
    } finally {
      await learner.close();
    }
  } finally {
    await app.close();
  }
});

test("health probes and static admin assets do not consume traffic statistics or a client bucket", async () => {
  const app = create();
  try {
    for (const url of [
      "/health/live",
      "/health/ready",
      "/admin/",
      "/admin/app.js",
    ]) {
      const response = await app.inject({ url });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["x-ratelimit-limit"], undefined);
    }
    const metrics = await app.inject({
      url: "/metrics",
      headers: { "x-admin-key": KEY },
    });
    assert.match(metrics.body, /framework_http_requests_total 0/);
    const operation = await app.inject({
      url: "/v1/admin/operations",
      headers: { "x-admin-key": KEY },
    });
    assert.equal(operation.json().data.metrics.requestCount, 0);
    const next = await app.inject({
      url: "/v1/admin/operations",
      headers: { "x-admin-key": KEY },
    });
    assert.equal(next.json().data.metrics.requestCount, 1);
  } finally {
    await app.close();
  }
});

test("wrong x-admin-key guesses are limited per address and audited", async () => {
  const store = new SqliteStore(":memory:");
  const app = buildApp({
    env: loadEnv({ NODE_ENV: "test", DATABASE_PATH: ":memory:", LOG_LEVEL: "silent", ADMIN_API_KEY: KEY }),
    store,
  });
  try {
    const guess = (key: string, remoteAddress = "198.51.100.7") =>
      app.inject({
        url: "/v1/admin/operations",
        headers: { "x-admin-key": key },
        remoteAddress,
      });
    for (let i = 0; i < 5; i++)
      assert.equal((await guess(`wrong-${i}`)).statusCode, 401);
    // The sixth try is refused before the key is compared, even the right key.
    assert.equal((await guess("wrong-5")).statusCode, 429);
    assert.equal((await guess(KEY)).statusCode, 429);
    // Another address is not affected.
    assert.equal((await guess(KEY, "198.51.100.8")).statusCode, 200);
    assert.equal(
      store.audits().filter((a) => a.action === "admin.key.failed").length,
      5,
    );
  } finally {
    await app.close();
  }
});
