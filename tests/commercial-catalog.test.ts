import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMERCIAL_CATALOG_SETTING,
  CommercialCatalog,
  PUBLISHED_COMMERCIAL_GOODS,
  validateCommercialCatalog,
} from "../server/src/modules/commercial/catalog.js";
import { AppError } from "../server/src/shared/domain.js";
import { SqliteStore } from "../server/src/shared/store.js";

const configured = (approved = true) => ({
  version: "catalog-2026-10-24",
  approved,
  goods: PUBLISHED_COMMERCIAL_GOODS.map((good, index) => ({
    id: good.id,
    enabled: true,
    android: {
      credits: 100 + index,
      ...(good.kind === "plan" ? { weeklyCredits: 10 } : {}),
    },
    ios: {
      credits: 200 + index,
      ...(good.kind === "plan" ? { weeklyCredits: 20 } : {}),
    },
  })),
});

test("published catalog keeps the six fixed names, prices and non-renewing plan duration", () => {
  assert.deepEqual(
    PUBLISHED_COMMERCIAL_GOODS.map((good) => [
      good.id,
      good.name,
      good.priceCents,
    ]),
    [
      ["plan_entry_30d", "晓念Plus", 1000],
      ["plan_standard_30d", "晓念Pro", 3000],
      ["plan_advanced_30d", "晓念Max", 6000],
      ["points_10", "晓念积分包10元", 1000],
      ["points_30", "晓念积分包30元", 3000],
      ["points_50", "晓念积分包50元", 5000],
    ],
  );
  assert.ok(
    PUBLISHED_COMMERCIAL_GOODS.every(
      (good) =>
        good.autoRenew === false &&
        (good.kind !== "plan" || good.durationDays === 30),
    ),
  );
});

test("unapproved or absent settings display the directory but cannot be required", () => {
  const store = new SqliteStore(":memory:");
  const catalog = new CommercialCatalog(store);
  try {
    assert.ok(catalog.list().every((good) => !good.purchasable));
    assert.throws(
      () => catalog.require("points_10"),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.statusCode, 503);
        assert.equal(error.code, "COMMERCIAL_NOT_READY");
        return true;
      },
    );
    store.saveSetting(COMMERCIAL_CATALOG_SETTING, configured(false));
    assert.ok(catalog.list().every((good) => !good.purchasable));
  } finally {
    store.close();
  }
});

test("approved benefits create a frozen, versioned purchase snapshot without changing prices", () => {
  const store = new SqliteStore(":memory:");
  const catalog = new CommercialCatalog(store);
  try {
    store.saveSetting(COMMERCIAL_CATALOG_SETTING, configured());
    const good = catalog.require("plan_standard_30d");
    assert.equal(good.priceCents, 3000);
    assert.equal(good.android.weeklyCredits, 10);
    assert.ok(catalog.list().every((item) => item.purchasable));
    const snapshot = catalog.snapshot("plan_standard_30d");
    assert.equal(snapshot.version, "catalog-2026-10-24");
    assert.ok(Object.isFrozen(snapshot));
    assert.deepEqual(JSON.parse(snapshot.json), {
      version: snapshot.version,
      good,
    });
  } finally {
    store.close();
  }
});

test("catalog validation rejects changed prices, unknown fields, duplicate goods and unsafe entitlements", () => {
  const base = configured();
  assert.throws(() => validateCommercialCatalog({ ...base, priceCents: 1 }));
  assert.throws(() =>
    validateCommercialCatalog({
      ...base,
      goods: [...base.goods, base.goods[0]],
    }),
  );
  const weeklyTooHigh = configured();
  weeklyTooHigh.goods[0]!.android = { credits: 9, weeklyCredits: 10 };
  assert.throws(() => validateCommercialCatalog(weeklyTooHigh));
  const pointsWithWeekly = configured();
  pointsWithWeekly.goods[3]!.android = { credits: 9, weeklyCredits: 1 };
  assert.throws(() => validateCommercialCatalog(pointsWithWeekly));
  const zeroCredits = configured();
  zeroCredits.goods[0]!.ios = { credits: 0 };
  assert.throws(() => validateCommercialCatalog(zeroCredits));
});
