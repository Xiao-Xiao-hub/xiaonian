import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMERCIAL_CATALOG_SETTING,
  CommercialCatalog,
  PUBLISHED_COMMERCIAL_GOODS,
} from "../server/src/modules/commercial/catalog.js";
import { CommercialOrders } from "../server/src/modules/commercial/orders.js";
import { AppError } from "../server/src/shared/domain.js";
import { SqliteStore } from "../server/src/shared/store.js";

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const store = new SqliteStore(":memory:");
  let now = Date.parse("2026-10-24T08:00:00.000Z");
  const catalog = new CommercialCatalog(store);
  const orders = new CommercialOrders(store, catalog, () => new Date(now));
  const user = store.upsertUser("wx-order-owner", "购买者", "wechat");
  store.db
    .prepare("UPDATE users SET data=? WHERE id=?")
    .run(JSON.stringify({ ...user, ageBand: "adult" }), user.id);
  const other = store.upsertUser("wx-order-other", "另一位", "wechat");
  store.saveSetting(COMMERCIAL_CATALOG_SETTING, {
    version: "catalog-v1",
    approved: true,
    goods: PUBLISHED_COMMERCIAL_GOODS.map((good) => ({
      id: good.id,
      enabled: true,
      android: {
        credits: good.kind === "plan" ? 70 : 11,
        ...(good.kind === "plan" ? { weeklyCredits: 7 } : {}),
      },
      ios: {
        credits: good.kind === "plan" ? 80 : 22,
        ...(good.kind === "plan" ? { weeklyCredits: 8 } : {}),
      },
    })),
  });
  const payment = (
    order: { id: string; goodId: string; amountCents: number },
    extra: Partial<{
      wxOrderId: string;
      openid: string;
      productId: string;
      amountCents: number;
      platform: "android" | "ios";
      env: 0 | 1;
      paidAtMs: number;
    }> = {},
  ) => ({
    orderId: order.id,
    wxOrderId: `wx_${order.id}`,
    openid: user.openid,
    productId: order.goodId,
    amountCents: order.amountCents,
    platform: "android" as const,
    env: 0 as const,
    paidAtMs: now,
    ...extra,
  });
  return {
    store,
    orders,
    user,
    other,
    adultPurchase: { ageBand: "adult" as const },
    payment,
    advance: (ms: number) => (now += ms),
  };
}

const appError = (code: string) => (error: unknown) => {
  assert.ok(error instanceof AppError);
  assert.equal(error.code, code);
  return true;
};

test("create is wechat-only and idempotent without trusting client prices", () => {
  const f = setup();
  try {
    const dev = f.store.upsertUser("dev-order", "开发", "dev");
    assert.throws(
      () => f.orders.create(dev.id, "points_10", "same"),
      appError("WECHAT_REQUIRED"),
    );
    const created = f.orders.create(
      f.user.id,
      "points_10",
      "same-key",
      f.adultPurchase,
    );
    const replay = f.orders.create(f.user.id, "points_10", "same-key");
    assert.equal(created.id, replay.id);
    assert.match(created.id, /^[a-f0-9]{24}$/);
    assert.equal(created.amountCents, 1000);
    assert.throws(
      () =>
        f.orders.create(f.user.id, "points_30", "same-key", f.adultPurchase),
      appError("ORDER_IDEMPOTENCY_CONFLICT"),
    );
  } finally {
    f.store.close();
  }
});

test("purchase age eligibility rejects child and unknown accounts, and freezes minor guardian consent once", () => {
  const f = setup();
  try {
    assert.throws(
      () => f.orders.create(f.user.id, "points_10", "adult-must-declare"),
      appError("PURCHASE_AGE_REQUIRED"),
    );
    const child = f.store.upsertUser("wx-under-14", "儿童", "wechat");
    f.store.db
      .prepare("UPDATE users SET data=? WHERE id=?")
      .run(JSON.stringify({ ...child, ageBand: "child" }), child.id);
    assert.throws(
      () => f.orders.create(child.id, "points_10", "under-14"),
      appError("PURCHASE_AGE_FORBIDDEN"),
    );
    const unknown = f.store.upsertUser("wx-age-unknown", "未知", "wechat");
    assert.throws(
      () => f.orders.create(unknown.id, "points_10", "unknown-age"),
      appError("PURCHASE_AGE_REQUIRED"),
    );
    assert.throws(
      () =>
        f.orders.create(unknown.id, "points_10", "minor-no-guardian", {
          ageBand: "14_17",
        }),
      appError("PURCHASE_GUARDIAN_REQUIRED"),
    );
    const created = f.orders.create(unknown.id, "points_10", "minor-guardian", {
      ageBand: "14_17",
      guardianConsent: true,
    });
    const snapshot = f.orders.detail(unknown.id, created.id).snapshot as {
      purchaseConsent: {
        ageBand: "14_17" | "adult";
        guardianConsent: boolean;
        recordedAt: string;
      };
    };
    assert.equal(snapshot.purchaseConsent.ageBand, "14_17");
    assert.equal(snapshot.purchaseConsent.guardianConsent, true);
    const replay = f.orders.create(unknown.id, "points_10", "minor-guardian");
    assert.equal(replay.id, created.id);
    assert.deepEqual(
      f.orders.detail(unknown.id, created.id).snapshot,
      snapshot,
    );
  } finally {
    f.store.close();
  }
});

test("verified payment uses its platform entitlement and replays without double grants", () => {
  const f = setup();
  try {
    const created = f.orders.create(
      f.user.id,
      "points_10",
      "points-ios",
      f.adultPurchase,
    );
    const receipt = f.payment(created, { platform: "ios" });
    const paid = f.orders.receiveVerifiedPayment(receipt);
    const replay = f.orders.receiveVerifiedPayment(receipt);
    assert.deepEqual(replay, paid);
    assert.equal(paid.status, "delivered");
    assert.throws(
      () =>
        f.orders.receiveVerifiedPayment(
          f.payment(created, {
            platform: "android",
            productId: "points_30",
          }),
        ),
      appError("PAYMENT_MISMATCH"),
    );
    assert.throws(
      () =>
        f.orders.receiveVerifiedPayment(
          f.payment(created, { platform: "android" }),
        ),
      appError("PAYMENT_CONFLICT"),
    );
    const bucket = f.store.db
      .prepare("SELECT * FROM commercial_buckets WHERE user_id=?")
      .get(f.user.id)!;
    assert.equal(bucket.kind, "wallet");
    assert.equal(bucket.grant_credits, 22);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) count FROM commercial_entries").get()!
        .count,
      1,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) count FROM commercial_order_grants")
        .get()!.count,
      1,
    );
  } finally {
    f.store.close();
  }
});

test("plan delivery uses the approved snapshot and creates a total plus five weekly windows", () => {
  const f = setup();
  try {
    const created = f.orders.create(
      f.user.id,
      "plan_entry_30d",
      "plan-snapshot",
      f.adultPurchase,
    );
    const originalSnapshot = f.orders.detail(f.user.id, created.id).snapshot;
    const changed = JSON.parse(
      JSON.stringify(f.store.setting(COMMERCIAL_CATALOG_SETTING)),
    );
    changed.version = "catalog-v2";
    changed.goods[0].android = { credits: 999, weeklyCredits: 99 };
    f.store.saveSetting(COMMERCIAL_CATALOG_SETTING, changed);
    f.orders.receiveVerifiedPayment(f.payment(created));
    const buckets = f.store.db
      .prepare(
        "SELECT kind,grant_credits,starts_at,ends_at FROM commercial_buckets WHERE user_id=? ORDER BY id",
      )
      .all(f.user.id) as Array<{
      kind: string;
      grant_credits: number;
      starts_at: number;
      ends_at: number;
    }>;
    assert.equal(buckets.length, 6);
    assert.deepEqual(
      buckets.map((bucket) => [bucket.kind, bucket.grant_credits]),
      [
        ["plan_total", 70],
        ...Array.from({ length: 5 }, () => ["plan_week", 7]),
      ],
    );
    const weekEnds = buckets
      .filter((bucket) => bucket.kind === "plan_week")
      .map((bucket) => bucket.ends_at);
    assert.equal(weekEnds.at(-1)! - weekEnds.at(-2)!, 2 * DAY);
    assert.deepEqual(
      f.orders.detail(f.user.id, created.id).snapshot,
      originalSnapshot,
    );
  } finally {
    f.store.close();
  }
});

test("payment mismatches, stale receipt times and conflicting wx ids do not deliver", () => {
  const f = setup();
  try {
    const one = f.orders.create(
      f.user.id,
      "points_10",
      "mismatch-one",
      f.adultPurchase,
    );
    assert.throws(
      () => f.orders.receiveVerifiedPayment(f.payment(one, { amountCents: 1 })),
      appError("PAYMENT_MISMATCH"),
    );
    assert.throws(
      () =>
        f.orders.receiveVerifiedPayment(
          f.payment(one, { openid: f.other.openid }),
        ),
      appError("PAYMENT_USER_MISMATCH"),
    );
    assert.throws(
      () => f.orders.receiveVerifiedPayment(f.payment(one, { env: 1 })),
      appError("PAYMENT_ENV_INVALID"),
    );
    assert.throws(
      () =>
        f.orders.receiveVerifiedPayment(
          f.payment(one, { paidAtMs: one.createdAtMs - 1 }),
        ),
      appError("PAYMENT_TIME_INVALID"),
    );
    f.advance(123);
    const sameSecond = f.orders.create(
      f.user.id,
      "points_30",
      "same-second-payment",
      f.adultPurchase,
    );
    assert.equal(
      f.orders.receiveVerifiedPayment(
        f.payment(sameSecond, {
          paidAtMs: Math.floor(sameSecond.createdAtMs / 1000) * 1000,
        }),
      ).status,
      "delivered",
    );
    f.orders.receiveVerifiedPayment(f.payment(one));
    const two = f.orders.create(
      f.user.id,
      "points_50",
      "mismatch-two",
      f.adultPurchase,
    );
    assert.throws(
      () =>
        f.orders.receiveVerifiedPayment(
          f.payment(two, { wxOrderId: `wx_${one.id}` }),
        ),
      appError("PAYMENT_CONFLICT"),
    );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) count FROM commercial_buckets").get()!
        .count,
      2,
    );
  } finally {
    f.store.close();
  }
});

test("a grant SQL failure rolls the paid state and every delivery write back", () => {
  const f = setup();
  try {
    const created = f.orders.create(
      f.user.id,
      "points_10",
      "roll-back",
      f.adultPurchase,
    );
    f.store.db.exec(
      "CREATE TRIGGER fail_order_grant BEFORE INSERT ON commercial_entries BEGIN SELECT RAISE(FAIL,'synthetic grant failure'); END",
    );
    assert.throws(
      () => f.orders.receiveVerifiedPayment(f.payment(created)),
      /synthetic grant failure/,
    );
    const row = f.store.db
      .prepare("SELECT status,wx_order_id FROM commercial_orders WHERE id=?")
      .get(created.id)!;
    assert.deepEqual({ ...row }, { status: "created", wx_order_id: null });
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) count FROM commercial_buckets").get()!
        .count,
      0,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) count FROM commercial_order_grants")
        .get()!.count,
      0,
    );
  } finally {
    f.store.close();
  }
});

test("order list and detail stay owner-scoped and omit openid", () => {
  const f = setup();
  try {
    const created = f.orders.create(
      f.user.id,
      "points_10",
      "private-order",
      f.adultPurchase,
    );
    const listed = f.orders.list(f.user.id);
    assert.equal(listed.length, 1);
    assert.ok(!JSON.stringify(listed).includes(f.user.openid));
    assert.throws(
      () => f.orders.detail(f.other.id, created.id),
      appError("ORDER_NOT_FOUND"),
    );
  } finally {
    f.store.close();
  }
});
