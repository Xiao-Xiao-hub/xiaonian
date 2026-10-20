import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const admin = "a7cdd8ea570cf2dc1eed0ccf7165695288a53f3a";
const env = (path = ":memory:") =>
  loadEnv({
    NODE_ENV: "test",
    DEV_LOGIN_ENABLED: "true",
    DATABASE_PATH: path,
    LOG_LEVEL: "silent",
    ADMIN_API_KEY: admin,
  });

test("dev session can read itself, never exposes openid and is revoked by logout", async () => {
  const app = buildApp({ env: env() });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: {},
    });
    assert.equal(login.statusCode, 200);
    const { token, user } = login.json().data;
    assert.equal(user.openid, undefined);
    const headers = { authorization: `Bearer ${token}` };
    const me = await app.inject({ url: "/v1/auth/me", headers });
    assert.equal(me.json().data.id, user.id);
    const out = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers,
    });
    assert.equal(out.statusCode, 200);
    const after = await app.inject({ url: "/v1/auth/me", headers });
    assert.equal(after.statusCode, 401);
    assert.equal(after.json().code, "SESSION_EXPIRED");
    assert.ok(after.json().requestId);
  } finally {
    await app.close();
  }
});

test("wechat login exchanges server-side code, sessions are opaque and no secrets leak", async () => {
  let called = "";
  const app = buildApp({
    env: {
      ...env(),
      WECHAT_APP_ID: "wx-test",
      WECHAT_APP_SECRET: "server-secret",
    },
    fetcher: (async (input) => {
      called = String(input);
      return new Response(
        JSON.stringify({
          openid: "openid-user-example",
          session_key: "MUST_NOT_LEAK",
        }),
      );
    }) as typeof fetch,
  });
  try {
    const result = await app.inject({
      method: "POST",
      url: "/v1/auth/wechat-login",
      payload: { code: "valid-code" },
    });
    assert.equal(result.statusCode, 200);
    assert.ok(called.includes("jscode2session"));
    assert.ok(!result.body.includes("MUST_NOT_LEAK"));
    assert.ok(!result.body.includes("openid-user-example"));
    assert.equal(result.json().data.token.length, 43);
  } finally {
    await app.close();
  }
});

test("production needs login credentials, a real admin key and a persistent database, but no payment settings", () => {
  const production = {
    NODE_ENV: "production",
    DEV_LOGIN_ENABLED: "false",
    DATABASE_PATH: "/srv/data/app.sqlite",
    ADMIN_API_KEY: admin,
    WECHAT_APP_ID: "wx-test",
    WECHAT_APP_SECRET: "server-secret",
    ADMIN_ORIGIN: "https://admin.example.test",
  };
  assert.equal(loadEnv(production).NODE_ENV, "production");
  for (const missing of [
    "WECHAT_APP_ID",
    "WECHAT_APP_SECRET",
    "ADMIN_API_KEY",
    "DATABASE_PATH",
    "ADMIN_ORIGIN",
  ])
    assert.throws(() => loadEnv({ ...production, [missing]: undefined }));
  assert.throws(() => loadEnv({ ...production, DEV_LOGIN_ENABLED: "true" }));
  assert.throws(() =>
    loadEnv({
      ...production,
      ADMIN_API_KEY: "development-only-admin-key-replace-before-use",
    }),
  );
});

test("dev login maps one key to one stable user and is fully off when disabled", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "zhiye-")), "app.sqlite");
  const login = async (app: ReturnType<typeof buildApp>, key?: string) =>
    (
      await app.inject({
        method: "POST",
        url: "/v1/auth/dev-login",
        payload: key ? { key } : {},
      })
    ).json().data;
  let app = buildApp({ env: env(path) });
  let token = "";
  try {
    assert.equal((await app.inject({ url: "/v1/config" })).json().data.appName, "晓念");
    assert.equal(
      (await app.inject({ url: "/v1/config" })).json().data.devLogin,
      true,
    );
    const first = await login(app);
    token = first.token;
    assert.equal((await login(app)).user.id, first.user.id);
    assert.notEqual((await login(app, "tester")).user.id, first.user.id);
    assert.equal(first.user.authMode, "dev");
  } finally {
    await app.close();
  }
  app = buildApp({ env: { ...env(path), DEV_LOGIN_ENABLED: false } });
  try {
    assert.equal(
      (await app.inject({ url: "/v1/config" })).json().data.devLogin,
      false,
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: {},
    });
    assert.equal(response.statusCode, 404);
    const me = await app.inject({
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(me.statusCode, 401);
    assert.equal(me.json().code, "DEV_LOGIN_DISABLED");
  } finally {
    await app.close();
  }
});

test("admin API requires the key; admin entrypoint and its module dependency are served", async () => {
  const app = buildApp({ env: env() });
  try {
    const denied = await app.inject({ url: "/v1/admin/overview" });
    assert.equal(denied.statusCode, 401);
    const overview = await app.inject({
      url: "/v1/admin/overview",
      headers: { "x-admin-key": admin },
    });
    assert.equal(overview.json().data.users, 0);
    const html = await app.inject({ method: "GET", url: "/admin" });
    assert.equal(html.statusCode, 200);
    assert.match(html.body, /src="\/admin\/app\.js"/);
    for (const path of [
      "/admin/app.js",
      "/admin/model.mjs",
      "/admin/styles.css",
    ]) {
      const response = await app.inject({ method: "GET", url: path });
      assert.equal(response.statusCode, 200, path);
      assert.match(
        String(response.headers["content-type"]),
        path.endsWith(".css") ? /text\/css/ : /javascript/,
      );
    }
    const escape = await app.inject({
      method: "GET",
      url: "/admin/../server/.env",
    });
    assert.equal(escape.statusCode, 404);
  } finally {
    await app.close();
  }
});
