import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { loadEnv } from "../server/src/config/env.js";
import { registerAdminSessionRoutes } from "../server/src/modules/auth/admin-session.js";
import { AuthService } from "../server/src/modules/auth/service.js";
import { registerCommercialAdminRoutes } from "../server/src/modules/commercial/admin-routes.js";
import {
  CommercialCatalog,
  PUBLISHED_COMMERCIAL_GOODS,
} from "../server/src/modules/commercial/catalog.js";
import { CommercialOrders } from "../server/src/modules/commercial/orders.js";
import { PaymentReconciliation } from "../server/src/modules/commercial/reconciliation.js";
import type {
  QueryPaymentInput,
  QueryPaymentResult,
} from "../server/src/modules/commercial/wechat-api.js";
import { AppError } from "../server/src/shared/domain.js";
import { SqliteStore } from "../server/src/shared/store.js";

const Fastify = createRequire(
  new URL("../server/package.json", import.meta.url),
)("fastify") as () => any;
const KEY = "synthetic-admin-reconcile-key-0123456789";
const ORIGIN = "http://admin-reconcile.test";

type Adapter = {
  queryVerifiedPayment(input: QueryPaymentInput): Promise<QueryPaymentResult>;
};

function fixture(options: { adapter?: Adapter; configured?: boolean } = {}) {
  let nowMs = Date.parse("2026-10-24T08:00:00.000Z");
  const clock = () => new Date(nowMs);
  const store = new SqliteStore(":memory:", clock);
  store.saveSetting("commercial.catalog", {
    version: "admin-reconcile-v1",
    approved: true,
    goods: PUBLISHED_COMMERCIAL_GOODS.map((good) => ({
      id: good.id,
      enabled: true,
      android: {
        credits: good.kind === "plan" ? 400 : 100,
        ...(good.kind === "plan" ? { weeklyCredits: 100 } : {}),
      },
      ios: {
        credits: good.kind === "plan" ? 320 : 80,
        ...(good.kind === "plan" ? { weeklyCredits: 80 } : {}),
      },
    })),
  });
  const user = store.upsertUser(
    "wx-admin-reconcile",
    "人工查单测试用户",
    "wechat",
  );
  const orders = new CommercialOrders(
    store,
    new CommercialCatalog(store),
    clock,
  );
  const order = orders.create(user.id, "points_10", "admin-reconcile-order", {
    ageBand: "adult",
  });
  const receipt = {
    orderId: order.id,
    wxOrderId: "wx-admin-reconcile-paid",
    openid: user.openid,
    productId: order.goodId,
    amountCents: order.amountCents,
    platform: "android" as const,
    env: 0 as const,
    paidAtMs: nowMs,
  };
  const target = (): QueryPaymentInput => {
    const row = store.db
      .prepare(
        "SELECT id,user_id,good_id,amount_cents,env FROM commercial_orders WHERE id=?",
      )
      .get(order.id) as {
      id: string;
      user_id: string;
      good_id: string;
      amount_cents: number;
      env: 0;
    };
    const owner = store.getUser(row.user_id)!;
    return {
      openid: owner.openid,
      orderId: row.id,
      env: row.env,
      productId: row.good_id,
      amountCents: row.amount_cents,
    };
  };
  let calls = 0;
  const adapter: Adapter = options.adapter ?? {
    queryVerifiedPayment: async () => {
      calls += 1;
      return { state: "paid", status: 2, receipt };
    },
  };
  const counted: Adapter = {
    queryVerifiedPayment: async (input) => {
      if (options.adapter) calls += 1;
      return adapter.queryVerifiedPayment(input);
    },
  };
  const reconciliation = new PaymentReconciliation(orders, counted, {
    clock,
    minIntervalMs: 0,
  });
  const auth = new AuthService(
    store,
    loadEnv({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      LOG_LEVEL: "silent",
      ADMIN_API_KEY: KEY,
      ADMIN_ORIGIN: ORIGIN,
    }),
  );
  const app = Fastify();
  registerAdminSessionRoutes(app, auth);
  registerCommercialAdminRoutes(app, {
    auth,
    store,
    ...(options.configured === false
      ? {}
      : {
          syncOrder: () => reconciliation.reconcile(target()),
        }),
    configuration: {
      paymentConfigured: options.configured !== false,
      accessTokenConfigured: options.configured !== false,
    },
  });
  app.setErrorHandler((error: unknown, _req: unknown, reply: any) => {
    if (error instanceof AppError)
      return reply.code(error.statusCode).send({ code: error.code });
    const status =
      typeof error === "object" && error !== null && "issues" in error
        ? 400
        : 500;
    return reply
      .code(status)
      .send({ code: status === 400 ? "VALIDATION_ERROR" : "INTERNAL_ERROR" });
  });
  const post = (id = order.id, payload: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: `/v1/admin/commercial/orders/${id}/sync`,
      headers: { "x-admin-key": KEY },
      payload: { reason: "支付通知疑似丢失，人工复核", ...payload },
    });
  return {
    app,
    store,
    user,
    order,
    receipt,
    post,
    calls: () => calls,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

test("manual sync requires admin authorization, origin and a strict reason", async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.app.close();
    f.store.close();
  });
  const denied = await f.app.inject({
    method: "POST",
    url: `/v1/admin/commercial/orders/${f.order.id}/sync`,
    payload: { reason: "人工复核" },
  });
  assert.equal(denied.statusCode, 403);
  const unauthenticated = await f.app.inject({
    method: "POST",
    url: `/v1/admin/commercial/orders/${f.order.id}/sync`,
    headers: { origin: ORIGIN },
    payload: { reason: "人工复核" },
  });
  assert.equal(unauthenticated.statusCode, 401);

  const login = await f.app.inject({
    method: "POST",
    url: "/v1/admin/session",
    headers: { origin: ORIGIN },
    payload: { key: KEY },
  });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const noOrigin = await f.app.inject({
    method: "POST",
    url: `/v1/admin/commercial/orders/${f.order.id}/sync`,
    headers: { cookie },
    payload: { reason: "人工复核" },
  });
  assert.equal(noOrigin.statusCode, 403);

  const emptyReason = await f.app.inject({
    method: "POST",
    url: `/v1/admin/commercial/orders/${f.order.id}/sync`,
    headers: { cookie, origin: ORIGIN },
    payload: { reason: "  " },
  });
  assert.equal(emptyReason.statusCode, 400);
  const spoofedPayment = await f.post(f.order.id, {
    platform: "android",
    paid: true,
    amountCents: f.order.amountCents,
  });
  assert.equal(spoofedPayment.statusCode, 400);
  assert.equal(f.calls(), 0);
});

test("unknown orders return 404 and missing payment configuration returns 503 without querying", async (t) => {
  const f = fixture({ configured: false });
  t.after(async () => {
    await f.app.close();
    f.store.close();
  });
  const unknown = await f.post("missing-order");
  assert.equal(unknown.statusCode, 404);
  const unavailable = await f.post();
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().code, "COMMERCIAL_SYNC_NOT_CONFIGURED");
  assert.equal(f.calls(), 0);
  const audit = f.store.db
    .prepare(
      "SELECT action,details FROM audit WHERE resource_id=? ORDER BY created_at,id",
    )
    .all(f.order.id) as { action: string; details: string }[];
  assert.deepEqual(
    audit.map((row) => row.action).sort(),
    ["commercial.order.sync.attempt", "commercial.order.sync.error"].sort(),
  );
  const failed = audit.find(
    (row) => row.action === "commercial.order.sync.error",
  )!;
  assert.equal(
    JSON.parse(failed.details).code,
    "COMMERCIAL_SYNC_NOT_CONFIGURED",
  );
});

test("concurrent and repeated paid checks query safely and grant exactly once", async (t) => {
  let resolve!: (result: QueryPaymentResult) => void;
  let started!: () => void;
  const reached = new Promise<void>((done) => {
    started = done;
  });
  let receipt!: ReturnType<typeof fixture>["receipt"];
  const waiting = new Promise<QueryPaymentResult>((done) => {
    resolve = done;
  });
  let response = waiting;
  const f = fixture({
    adapter: {
      queryVerifiedPayment: async () => {
        started();
        return response;
      },
    },
  });
  receipt = f.receipt;
  t.after(async () => {
    await f.app.close();
    f.store.close();
  });
  const first = f.post();
  const duplicate = f.post();
  await reached;
  for (let i = 0; i < 20; i++) {
    const attempts = Number(
      f.store.db
        .prepare(
          "SELECT COUNT(*) n FROM audit WHERE action='commercial.order.sync.attempt'",
        )
        .get()!.n,
    );
    if (attempts === 2) break;
    await new Promise((done) => setImmediate(done));
  }
  assert.equal(
    f.store.db
      .prepare(
        "SELECT COUNT(*) n FROM audit WHERE action='commercial.order.sync.attempt'",
      )
      .get()!.n,
    2,
  );
  assert.equal(f.calls(), 1);
  resolve({ state: "paid", status: 2, receipt });
  const [one, two] = await Promise.all([first, duplicate]);
  assert.equal(one.statusCode, 200, one.body);
  assert.equal(two.statusCode, 200, two.body);
  assert.equal(one.json().data.state, "delivered");
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM commercial_order_grants").get()!
      .n,
    1,
  );
  response = Promise.resolve({ state: "paid", status: 4, receipt });
  const repeated = await f.post();
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.equal(f.calls(), 2);
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM commercial_order_grants").get()!
      .n,
    1,
  );

  const audits = f.store.db
    .prepare(
      "SELECT details FROM audit WHERE action LIKE 'commercial.order.sync.%'",
    )
    .all() as { details: string }[];
  assert.ok(audits.length >= 6);
  const serialized = JSON.stringify(audits);
  assert.equal(serialized.includes(f.user.openid), false);
  assert.equal(serialized.includes(f.receipt.wxOrderId), false);
  assert.equal(serialized.includes(KEY), false);
});

test("a mismatched platform receipt is audited and never delivered", async (t) => {
  let bad!: QueryPaymentResult;
  const f = fixture({
    adapter: { queryVerifiedPayment: async () => bad },
  });
  bad = {
    state: "paid",
    status: 2,
    receipt: { ...f.receipt, amountCents: f.order.amountCents + 1 },
  };
  t.after(async () => {
    await f.app.close();
    f.store.close();
  });
  const response = await f.post();
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, "PAYMENT_MISMATCH");
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM commercial_order_grants").get()!
      .n,
    0,
  );
  assert.equal(
    f.store.db
      .prepare("SELECT status FROM commercial_orders WHERE id=?")
      .get(f.order.id)!.status,
    "created",
  );
  const error = f.store.db
    .prepare(
      "SELECT details FROM audit WHERE action='commercial.order.sync.error' AND resource_id=?",
    )
    .get(f.order.id) as { details: string };
  assert.equal(JSON.parse(error.details).code, "PAYMENT_MISMATCH");
});
