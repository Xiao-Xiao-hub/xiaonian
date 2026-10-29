import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyRequest } from "fastify";
import { SqliteStore } from "../server/src/shared/store.js";
import { AuthService } from "../server/src/modules/auth/service.js";
import { loadEnv } from "../server/src/config/env.js";
import { buildApp } from "../server/src/index.js";
import { CommercialMeter } from "../server/src/shared/commercial-meter.js";
import { runWithCallContext } from "../server/src/shared/call-context.js";

const request = (token: string) =>
  ({ headers: { authorization: `Bearer ${token}` } }) as FastifyRequest;
const env = () =>
  loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_PATH: ":memory:",
    DEV_LOGIN_ENABLED: "true",
    WECHAT_APP_ID: "wx-test",
    WECHAT_APP_SECRET: "synthetic-secret",
  });

test("wechat keys stay bound to opaque sessions, refresh on login and cascade on logout", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  let key = Buffer.alloc(16, 1).toString("base64");
  const auth = new AuthService(store, env(), (async () =>
    Response.json({
      openid: "openid-account-test",
      session_key: key,
    })) as typeof fetch);
  const first = await auth.wechat("synthetic-code-1");
  assert.equal(auth.wechatPaymentSession(request(first.token)).sessionKey, key);
  assert.doesNotMatch(
    JSON.stringify(first),
    new RegExp(key.replace(/[+]/g, "\\+")),
  );
  key = Buffer.alloc(16, 2).toString("base64");
  const second = await auth.wechat("synthetic-code-2");
  assert.notEqual(first.token, second.token);
  assert.equal(
    auth.wechatPaymentSession(request(second.token)).sessionKey,
    key,
  );
  auth.logout(request(first.token));
  assert.equal(
    store.db.prepare("SELECT COUNT(*) n FROM wechat_payment_sessions").get()!.n,
    1,
  );
  assert.throws(() => auth.wechatPaymentSession(request(first.token)), {
    code: "SESSION_EXPIRED",
  });
  auth.logout(request(second.token));
  assert.equal(
    store.db.prepare("SELECT COUNT(*) n FROM wechat_payment_sessions").get()!.n,
    0,
  );
});

test("a missing payment key preserves basic login but cannot sign a purchase; dev login cannot purchase", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const auth = new AuthService(store, env(), (async () =>
    Response.json({
      openid: "openid-account-test",
      session_key: "invalid",
    })) as typeof fetch);
  const login = await auth.wechat("synthetic-code");
  assert.ok(auth.require(request(login.token)));
  assert.throws(() => auth.wechatPaymentSession(request(login.token)), {
    code: "WECHAT_SESSION_REFRESH",
  });
  const dev = auth.dev("synthetic-dev", "用户");
  assert.throws(() => auth.wechatPaymentSession(request(dev.token)), {
    code: "WECHAT_LOGIN_REQUIRED",
  });
});

test("account export contains only its own commercial records and never payment keys; erase removes them", async (t) => {
  const store = new SqliteStore(":memory:");
  const paymentKey = Buffer.alloc(16, 3).toString("base64");
  const app = buildApp({
    store,
    env: env(),
    fetcher: (async () =>
      Response.json({
        openid: "openid-export-test",
        session_key: paymentKey,
      })) as typeof fetch,
  });
  t.after(() => app.close());
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/wechat-login",
    payload: { code: "synthetic-code" },
  });
  assert.equal(login.statusCode, 200);
  const { token, user } = login.json().data;
  const other = store.upsertUser("dev:other", "另一个用户", "dev");
  const meter = new CommercialMeter(store);
  for (const id of [user.id, other.id]) {
    await runWithCallContext({ userId: id, source: "test" }, () =>
      meter.run(
        { kind: "jev", provider: "test", model: "test", source: "judge" },
        async () => true,
        () => ({ requests: 1 }),
      ),
    );
  }
  const createdAt = Date.parse("2026-10-24T00:00:00.000Z");
  for (const [id, owner] of [
    ["order-own", user.id],
    ["order-other", other.id],
  ] as const)
    store.db
      .prepare(
        'INSERT INTO commercial_orders(id,user_id,idempotency_key,good_id,amount_cents,snapshot,catalog_version,env,status,platform,paid_at,created_at) VALUES(?,?,?,?,?,\'{"purchaseConsent":{"ageBand":"adult","guardianConsent":false,"recordedAt":"2026-10-24T00:00:00.000Z"}}\',\'v1\',0,\'delivered\',\'android\',?,?)',
      )
      .run(id, owner, `key-${id}`, "points_10", 1000, createdAt, createdAt);
  store.db
    .prepare(
      "INSERT INTO commercial_buckets(id,user_id,kind,starts_at,ends_at,grant_credits,created_at) VALUES(?,?, 'wallet', ?,NULL,?,?)",
    )
    .run(
      "wallet:order-own",
      user.id,
      createdAt,
      22,
      new Date(createdAt).toISOString(),
    );
  store.db
    .prepare(
      "INSERT INTO commercial_order_grants(order_id,bucket_id) VALUES(?,?)",
    )
    .run("order-own", "wallet:order-own");
  const headers = { authorization: `Bearer ${token}` };
  const exported = await app.inject({ url: "/v1/me/export", headers });
  assert.equal(exported.statusCode, 200);
  assert.equal(exported.json().commercial.usage.length, 1);
  assert.deepEqual(exported.json().commercial.orders, [
    {
      id: "order-own",
      goodId: "points_10",
      amountCents: 1000,
      catalogVersion: "v1",
      env: 0,
      status: "delivered",
      paidAt: createdAt,
      createdAt,
      purchaseConsent: {
        ageBand: "adult",
        guardianConsent: false,
        recordedAt: "2026-10-24T00:00:00.000Z",
      },
      entitlements: [
        {
          id: "wallet:order-own",
          kind: "wallet",
          startsAt: createdAt,
          endsAt: null,
          grantCredits: 22,
        },
      ],
    },
  ]);
  for (const secret of [paymentKey, "openid-export-test", other.id])
    assert.ok(!exported.body.includes(secret));
  const erased = await app.inject({
    method: "DELETE",
    url: "/v1/me",
    headers,
    payload: { confirm: true },
  });
  assert.equal(erased.statusCode, 200);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) n FROM wechat_payment_sessions").get()!.n,
    0,
  );
  assert.equal(
    store.db
      .prepare("SELECT COUNT(*) n FROM commercial_usage WHERE user_id=?")
      .get(user.id)!.n,
    0,
  );
  assert.equal(
    store.db
      .prepare("SELECT COUNT(*) n FROM commercial_usage WHERE user_id=?")
      .get(other.id)!.n,
    1,
  );
});
