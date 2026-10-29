import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { loadEnv } from "../server/src/config/env.js";
import { AuthService } from "../server/src/modules/auth/service.js";
import { registerAdminSessionRoutes } from "../server/src/modules/auth/admin-session.js";
import { registerCommercialAdminRoutes } from "../server/src/modules/commercial/admin-routes.js";
import {
  COMMERCIAL_CATALOG_SETTING,
  CommercialCatalog,
  PUBLISHED_COMMERCIAL_GOODS,
} from "../server/src/modules/commercial/catalog.js";
import { CommercialOrders } from "../server/src/modules/commercial/orders.js";
import {
  CommercialRefunds,
  type RefundPlatformInput,
} from "../server/src/modules/commercial/refunds.js";
import { AppError } from "../server/src/shared/domain.js";
import { SqliteStore } from "../server/src/shared/store.js";

const Fastify = createRequire(
  new URL("../server/package.json", import.meta.url),
)("fastify") as () => any;
const KEY = "synthetic-commercial-admin-key-0123456789";
const ORIGIN = "http://commercial-admin.test";

test("payment anomaly resolution is authenticated, idempotent, preserves audit and updates open counts", async t => {
  const f = fixture();
  t.after(async () => { await f.app.close(); f.store.close(); });
  f.store.audit("system:payment", "commercial.payment.anomaly", f.delivered.id,
    { code: "DELIVERY_FAILED", source: "manual", phase: "notify_provide_goods", privatePayload: "must-not-leak" });
  const list = await f.adminGet("/v1/admin/commercial/anomalies");
  const anomaly = list.json().data[0];
  assert.equal(anomaly.code, "DELIVERY_FAILED");
  assert.equal(anomaly.phase, "notify_provide_goods");
  assert.equal(list.body.includes("must-not-leak"), false);
  const url = `/v1/admin/commercial/anomalies/${encodeURIComponent(anomaly.id)}/resolve`;
  const post = (payload: unknown, authorized = true) => f.app.inject({ method: "POST", url,
    headers: authorized ? { "x-admin-key": KEY, origin: ORIGIN } : { origin: ORIGIN }, payload });
  assert.equal((await post({ reason: "已核对" }, false)).statusCode, 401);
  assert.equal((await post({ reason: " " })).statusCode, 400);
  assert.equal((await post({ reason: "已核对", actor: "spoof" })).statusCode, 400);
  const balance = f.store.db.prepare("SELECT SUM(delta) n FROM commercial_entries").get()!.n;
  for (let n = 0; n < 2; n++) assert.equal((await post({ reason: "已人工核对" })).statusCode, 200);
  const resolved = (await f.adminGet("/v1/admin/commercial/anomalies")).json().data[0];
  assert.equal(resolved.resolutionReason, "已人工核对");
  assert.equal(typeof resolved.resolvedAt, "string");
  const overview = (await f.adminGet("/v1/admin/commercial/overview")).json().data;
  assert.equal(overview.alerts.paymentAnomalies, 1);
  assert.equal(overview.alerts.unresolvedPaymentAnomalies, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='commercial.payment.anomaly.resolved'").get()!.n, 1);
  assert.equal(f.store.db.prepare("SELECT SUM(delta) n FROM commercial_entries").get()!.n, balance);
});

function fixture(submitUnknown = false) {
  let nowMs = Date.parse("2026-10-24T08:00:00.000Z");
  const clock = () => new Date(nowMs);
  const store = new SqliteStore(":memory:", clock);
  store.saveSetting(COMMERCIAL_CATALOG_SETTING, {
    version: "admin-v1",
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
    "wx-commercial-admin",
    "商业测试用户",
    "wechat",
  );
  const orders = new CommercialOrders(
    store,
    new CommercialCatalog(store),
    clock,
  );
  const delivered = orders.create(user.id, "points_10", "admin-delivered", {
    ageBand: "adult",
  });
  orders.receiveVerifiedPayment({
    orderId: delivered.id,
    wxOrderId: `wx-${delivered.id}`,
    openid: user.openid,
    productId: delivered.goodId,
    amountCents: delivered.amountCents,
    platform: "android",
    env: 0,
    paidAtMs: nowMs,
  });
  nowMs += 1_000;
  const awaitingPayment = orders.create(
    user.id,
    "points_30",
    "admin-awaiting",
    { ageBand: "adult" },
  );
  store.db
    .prepare(
      `INSERT INTO commercial_usage(
        id,user_id,source,kind,price,status,usage,cost_microyuan,
        exact_numerator,exact_denominator,created_at,finished_at
      ) VALUES(?,?,?,?,?,'succeeded',?,?,?,?,?,?)`,
    )
    .run(
      "usage-known",
      user.id,
      "synthetic-test",
      "llm",
      JSON.stringify({ version: "test-price" }),
      JSON.stringify({ inputTokens: 2, outputTokens: 1 }),
      12_345,
      "12345",
      "1",
      clock().toISOString(),
      clock().toISOString(),
    );
  store.db
    .prepare(
      `INSERT INTO commercial_usage(
        id,user_id,source,kind,price,status,created_at,finished_at
      ) VALUES(?,?,?,?,?,'failed',?,?)`,
    )
    .run(
      "usage-unknown",
      user.id,
      "synthetic-test",
      "jev",
      JSON.stringify({ version: "test-price" }),
      clock().toISOString(),
      clock().toISOString(),
    );

  let refundCalls = 0;
  let lastRefundInput: RefundPlatformInput | undefined;
  const refunds = new CommercialRefunds(
    store,
    {
      refundOrder: async (input) => {
        refundCalls += 1;
        lastRefundInput = input;
        if (submitUnknown) throw new Error("synthetic transport timeout");
        return { state: "accepted" };
      },
    },
    { queryRefund: async () => ({ state: "pending", status: 3 }) },
    clock,
  );
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
    refunds,
    configuration: {
      paymentConfigured: true,
      callbackConfigured: false,
      accessTokenConfigured: true,
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
  const adminGet = (url: string) =>
    app.inject({ url, headers: { "x-admin-key": KEY } });
  return {
    app,
    store,
    delivered,
    awaitingPayment,
    adminGet,
    refundCalls: () => refundCalls,
    lastRefundInput: () => lastRefundInput,
    advance: (ms: number) => { nowMs += ms; },
  };
}

test("admin unknown-refund exit requires authentication, reason, attempt and a fresh eligible platform query", async t => {
  const f = fixture(true);
  t.after(async () => { await f.app.close(); f.store.close(); });
  const requested = await f.app.inject({ method: "POST", url: `/v1/admin/commercial/orders/${f.delivered.id}/refund`,
    headers: { "x-admin-key": KEY, origin: ORIGIN }, payload: { reason: "用户退款", reasonCode: 0 } });
  const refund = requested.json().data;
  assert.equal(refund.submissionStatus, "unknown");
  const listed = (await f.adminGet("/v1/admin/commercial/refunds")).json().data[0];
  assert.equal(listed.manualReviewReason, "unknown_submission");
  assert.equal(listed.manualReviewAt, refund.updatedAtMs + 24 * 3_600_000);
  const url = `/v1/admin/commercial/refunds/${refund.id}/resolve-unknown`;
  const payload = { reason: "已在平台核对，申请重试", expectedAttempt: refund.attempt };
  assert.equal((await f.app.inject({ method: "POST", url, headers: { origin: ORIGIN }, payload })).statusCode, 401);
  const post = (body: object) => f.app.inject({ method: "POST", url, headers: { "x-admin-key": KEY, origin: ORIGIN }, payload: body });
  assert.equal((await post({ ...payload, actor: "spoof" })).statusCode, 400);
  assert.equal((await post({ reason: "没有次数" })).statusCode, 400);
  const early = await post(payload);
  assert.equal(early.statusCode, 409);
  assert.equal(early.json().code, "REFUND_MANUAL_TOO_EARLY");
  f.advance(24 * 3_600_000);
  const done = await post(payload);
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().data.status, "failed");
  assert.equal(done.json().data.manualReviewReason, null);
  assert.equal(done.json().data.manualReviewAt, null);
  assert.equal(f.refundCalls(), 1, "manual resolution must not submit another refund");
  assert.equal((await post(payload)).statusCode, 409);
  const audit = f.store.db.prepare("SELECT actor,details FROM audit WHERE action='commercial.refund.manual_failed'").get()!;
  assert.equal(audit.actor, "admin:shared");
  assert.equal(JSON.parse(String(audit.details)).reason, payload.reason);
});

test("refund list exposes retry-status7 eligibility from its first observation rather than updatedAt", async t => {
  const f = fixture(); t.after(async () => { await f.app.close(); f.store.close(); });
  const response = await f.app.inject({ method: "POST", url: `/v1/admin/commercial/orders/${f.delivered.id}/refund`,
    headers: { "x-admin-key": KEY, origin: ORIGIN }, payload: { reason: "用户申请", reasonCode: 0 } });
  assert.equal(response.statusCode, 200);
  const row = response.json().data;
  const firstSeen = row.updatedAtMs + 3_600_000;
  f.store.db.prepare("UPDATE commercial_refunds SET attempt=2,status7_first_seen_at=? WHERE id=?").run(firstSeen, row.id);
  const listed = (await f.adminGet("/v1/admin/commercial/refunds")).json().data[0];
  assert.equal(listed.manualReviewReason, "status7_after_retry");
  assert.equal(listed.manualReviewAt, firstSeen + 24 * 3_600_000);
});

test("commercial overview separates local receipts and usage costs from provider settlement", async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.app.close();
    f.store.close();
  });
  const denied = await f.app.inject({ url: "/v1/admin/commercial/overview" });
  assert.equal(denied.statusCode, 401);
  f.store.audit("system:payment", "commercial.payment.anomaly", f.awaitingPayment.id, {
    source: "callback",
    code: "PAYMENT_MISMATCH",
  });

  const response = await f.adminGet("/v1/admin/commercial/overview");
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json().data;
  assert.deepEqual(data.basis, {
    kind: "local_records",
    productionSettlementVerified: false,
    note: "仅汇总本库记录，不代表微信结算到账或真实生产收入",
  });
  assert.equal(data.configuration.enabled, false);
  assert.deepEqual(data.configuration.missing, ["billingSwitch", "callback"]);
  assert.equal(data.orders.total, 2);
  assert.equal(data.orders.recordedPaidCents, 1_000);
  assert.equal(data.orders.confirmedRefundCents, 0);
  assert.equal(data.orders.recordedNetCents, 1_000);
  assert.equal(data.usage.recordedCostMicroyuan, 12_345);
  assert.equal(data.usage.unknownFinishedCostRecords, 1);
  assert.equal(data.alerts.paymentAnomalies, 1);
  assert.equal(typeof data.alerts.latestPaymentAnomalyAt, "string");
  assert.equal(data.ledger.activeConstraintCredits, 100);
  assert.equal(JSON.stringify(data).includes("wx-commercial-admin"), false);
});

test("commercial read APIs filter integer records and expose pending compensation without mutation", async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.app.close();
    f.store.close();
  });
  const created = await f.adminGet(
    "/v1/admin/commercial/orders?status=created&platform=unconfirmed",
  );
  assert.equal(created.statusCode, 200, created.body);
  assert.deepEqual(
    created.json().data.map((item: { id: string }) => item.id),
    [f.awaitingPayment.id],
  );
  assert.deepEqual(
    created.json().data.map((item: { goodId: string; goodName: string }) => [item.goodName, item.goodId]),
    [["晓念积分包30元", "points_30"]],
  );

  const costs = await f.adminGet("/v1/admin/commercial/costs?limit=2");
  assert.equal(costs.statusCode, 200, costs.body);
  const known = costs
    .json()
    .data.find((item: { id: string }) => item.id === "usage-known");
  assert.equal(known.costMicroyuan, 12_345);
  assert.deepEqual(known.usage, { inputTokens: 2, outputTokens: 1 });

  const ledger = await f.adminGet("/v1/admin/commercial/ledger?limit=1");
  assert.equal(ledger.statusCode, 200, ledger.body);
  assert.equal(Number.isInteger(ledger.json().data[0].deltaCredits), true);

  const pending = await f.adminGet("/v1/admin/commercial/pending");
  assert.equal(pending.statusCode, 200, pending.body);
  assert.deepEqual(
    pending.json().data.orders.map((item: { id: string }) => item.id),
    [f.awaitingPayment.id],
  );
  assert.deepEqual(pending.json().data.refunds, []);
  assert.equal(f.refundCalls(), 0);
});

test("manual refund uses the server actor and existing admin-session origin protection", async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.app.close();
    f.store.close();
  });
  const login = await f.app.inject({
    method: "POST",
    url: "/v1/admin/session",
    headers: { origin: ORIGIN },
    payload: { key: KEY },
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const url = `/v1/admin/commercial/orders/${f.delivered.id}/refund`;

  const noOrigin = await f.app.inject({
    method: "POST",
    url,
    headers: { cookie },
    payload: { reason: "用户申请退款", reasonCode: 3 },
  });
  assert.equal(noOrigin.statusCode, 403);
  assert.equal(noOrigin.json().code, "ADMIN_ORIGIN_REJECTED");

  const spoofedActor = await f.app.inject({
    method: "POST",
    url,
    headers: { cookie, origin: ORIGIN },
    payload: {
      reason: "用户申请退款",
      reasonCode: 3,
      actor: "request-controlled",
    },
  });
  assert.equal(spoofedActor.statusCode, 400);
  assert.equal(f.refundCalls(), 0);

  const accepted = await f.app.inject({
    method: "POST",
    url,
    headers: { cookie, origin: ORIGIN },
    payload: { reason: "用户申请退款", reasonCode: 3 },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().data.actor, "admin:shared");
  assert.equal(accepted.json().data.status, "pending");
  assert.equal(f.refundCalls(), 1);
  assert.equal(f.lastRefundInput()!.orderId, f.delivered.id);
  assert.equal(
    f.store.db
      .prepare("SELECT actor FROM commercial_refunds WHERE order_id=?")
      .get(f.delivered.id)!.actor,
    "admin:shared",
  );

  const pending = await f.adminGet("/v1/admin/commercial/pending");
  assert.deepEqual(
    pending
      .json()
      .data.refunds.map((item: { orderId: string }) => item.orderId),
    [f.delivered.id],
  );
});

test("order list marks upgrade and superseded orders and says why a refund cannot start", async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.app.close();
    f.store.close();
  });
  const rows = async () => (await f.adminGet("/v1/admin/commercial/orders")).json().data as Array<{
    id: string; planAction: string | null; supersededBy: string | null; refundBlockReason: string | null;
  }>;
  const delivered = (await rows()).find(row => row.id === f.delivered.id)!;
  assert.deepEqual([delivered.planAction, delivered.supersededBy, delivered.refundBlockReason], [null, null, null]);
  f.store.db
    .prepare("UPDATE commercial_orders SET snapshot=json_set(snapshot,'$.planAction','upgrade'),superseded_by='later' WHERE id=?")
    .run(f.delivered.id);
  f.advance(8 * 24 * 60 * 60 * 1000);
  const blocked = (await rows()).find(row => row.id === f.delivered.id)!;
  assert.deepEqual([blocked.planAction, blocked.supersededBy, blocked.refundBlockReason],
    ["upgrade", "later", "订单已超过七日退款期限"]);
  assert.equal((await rows()).find(row => row.id === f.awaitingPayment.id)!.refundBlockReason, null);
});
