import assert from "node:assert/strict";
import test from "node:test";
import { approvedCommercialCatalog } from "../server/src/modules/commercial/policy.js";
import { CommercialAccounts } from "../server/src/shared/commercial-accounts.js";
import { CommercialLedger } from "../server/src/shared/commercial-ledger.js";
import { SqliteStore } from "../server/src/shared/store.js";

const DAY = 24 * 60 * 60 * 1000;

function fixture(at = "2026-10-24T15:59:00.000Z") {
  let time = Date.parse(at);
  const clock = () => new Date(time);
  const store = new SqliteStore(":memory:", clock);
  const user = store.upsertUser("accounts-owner", "额度用户", "wechat");
  const ledger = new CommercialLedger(store, clock);
  const accounts = new CommercialAccounts(store, ledger, clock);
  return {
    store,
    user,
    ledger,
    accounts,
    set: (iso: string) => (time = Date.parse(iso)),
    add: (ms: number) => (time += ms),
  };
}

function order(f: ReturnType<typeof fixture>, id: string, paidAt: number) {
  f.store.db
    .prepare(
      "INSERT INTO commercial_orders(id,user_id,idempotency_key,good_id,amount_cents,snapshot,catalog_version,env,status,platform,paid_at,created_at) VALUES(?,?,?,?,?,'{}','v1',0,'delivered','android',?,?)",
    )
    .run(id, f.user.id, `key-${id}`, "plan_entry_30d", 1000, paidAt, paidAt);
}

function grantPlan(
  f: ReturnType<typeof fixture>,
  orderId: string,
  paidAt: number,
) {
  order(f, orderId, paidAt);
  const total = `plan-total:${orderId}`;
  f.ledger.ensureBucket({
    id: total,
    userId: f.user.id,
    kind: "plan_total",
    credits: 400,
    startsAt: paidAt,
    endsAt: paidAt + 30 * DAY,
  });
  f.store.db
    .prepare(
      "INSERT INTO commercial_order_grants(order_id,bucket_id) VALUES(?,?)",
    )
    .run(orderId, total);
  for (let i = 0; i < 5; i++) {
    const id = `plan-week:${orderId}:${i}`;
    f.ledger.ensureBucket({
      id,
      userId: f.user.id,
      kind: "plan_week",
      credits: 100,
      startsAt: paidAt + i * 7 * DAY,
      endsAt: Math.min(paidAt + (i + 1) * 7 * DAY, paidAt + 30 * DAY),
    });
    f.store.db
      .prepare(
        "INSERT INTO commercial_order_grants(order_id,bucket_id) VALUES(?,?)",
      )
      .run(orderId, id);
  }
}

test("free sources use China day/week windows, retain first grants, and carry the monthly cap", () => {
  const f = fixture();
  try {
    const first = f.accounts.sources(f.user.id, 1_000);
    assert.deepEqual(first.freeCostCap, {
      month: "2026-10",
      limitMicroyuan: 100_000_000,
      microyuanPerCredit: 1_000,
    });
    assert.deepEqual(first.sources[0], {
      name: "free",
      buckets: [
        `free:day:${f.user.id}:2026-10-24`,
        `free:week:${f.user.id}:2026-10-19`,
      ],
    });
    assert.equal(f.ledger.balance(first.sources[0]!.buckets[0]!), 30);
    assert.equal(f.ledger.balance(first.sources[0]!.buckets[1]!), 150);
    f.set("2026-10-24T16:00:00.000Z"); // China 00:00 next day, same week.
    const nextDay = f.accounts.sources(f.user.id, 1_000);
    assert.notEqual(
      nextDay.sources[0]!.buckets[0],
      first.sources[0]!.buckets[0],
    );
    assert.equal(nextDay.sources[0]!.buckets[1], first.sources[0]!.buckets[1]);
    f.set("2026-10-25T16:00:00.000Z"); // China Monday 00:00.
    const nextWeek = f.accounts.sources(f.user.id, 1_000);
    assert.notEqual(
      nextWeek.sources[0]!.buckets[1],
      first.sources[0]!.buckets[1],
    );
    f.store.db
      .prepare("UPDATE users SET quota=? WHERE id=?")
      .run('{"budget":{"day":9}}', f.user.id);
    f.accounts.sources(f.user.id, 1_000);
    assert.equal(
      f.ledger.balance(nextWeek.sources[0]!.buckets[0]!),
      30,
      "existing window is never re-granted",
    );
  } finally {
    f.store.close();
  }
});

test("the global free-cost month rolls over at Beijing midnight across Oct 31 to Nov 1", () => {
  const f = fixture("2026-10-31T15:59:59.999Z"); // Beijing 2026-10-31 23:59:59.999.
  try {
    const october = f.accounts.sources(f.user.id, 1_000);
    assert.equal(october.freeCostCap.month, "2026-10");
    f.set("2026-10-31T16:00:00.000Z"); // Beijing 2026-11-01 00:00:00.
    const november = f.accounts.sources(f.user.id, 1_000);
    assert.equal(november.freeCostCap.month, "2026-11");
    assert.notEqual(november.sources[0]!.buckets[0], october.sources[0]!.buckets[0]);
  } finally {
    f.store.close();
  }
});

test("legacy personal yuan budget overrides stay at least as large as approved free credits", () => {
  const f = fixture();
  try {
    f.store.db
      .prepare("UPDATE users SET quota=? WHERE id=?")
      .run('{"budget":{"day":1,"week":0.12}}', f.user.id);
    const source = f.accounts.sources(f.user.id, 1_000).sources[0]!;
    assert.equal(f.ledger.balance(source.buckets[0]!), 1_000);
    assert.equal(f.ledger.balance(source.buckets[1]!), 120);
  } finally {
    f.store.close();
  }
});

test("valid zero and lower personal quota overrides are retained", () => {
  const f = fixture();
  try {
    f.store.db
      .prepare("UPDATE users SET quota=? WHERE id=?")
      .run('{"budget":{"day":0,"week":0.01}}', f.user.id);
    const source = f.accounts.sources(f.user.id, 1_000).sources[0]!;
    assert.equal(f.ledger.balance(source.buckets[0]!), 0);
    assert.equal(f.ledger.balance(source.buckets[1]!), 10);
  } finally {
    f.store.close();
  }
});

test("available takes each paired source's lower balance and the global free cap", () => {
  const f = fixture();
  try {
    const free = f.accounts.sources(f.user.id, 1_000).sources[0]!;
    f.store.db
      .prepare(
        "INSERT INTO commercial_entries(bucket_id,call_id,event_key,kind,delta,created_at) VALUES(?,NULL,?,'reserve',?,?)",
      )
      .run(free.buckets[0], "free-spend", -20, new Date().toISOString());
    assert.equal(f.accounts.available(f.user.id, 1_000).free, 10);
    f.store.db
      .prepare(
        "INSERT INTO commercial_free_entries(month,call_id,event_key,kind,delta,created_at) VALUES(?,NULL,?,'grant',?,?)",
      )
      .run("2026-10", "cap-left", 500, new Date().toISOString());
    assert.equal(f.accounts.available(f.user.id, 1_000).free, 0);
  } finally {
    f.store.close();
  }
});

test("plan sources use a purchase-relative seven-day window and expire at thirty days", () => {
  const f = fixture("2026-10-01T00:00:00.000Z");
  try {
    const paid = Date.parse("2026-10-01T00:00:00.000Z");
    const freeBefore = f.accounts.sources(f.user.id, 1_000).sources[0]!;
    grantPlan(f, "order-plan", paid);
    const afterPayment = f.accounts.sources(f.user.id, 1_000);
    assert.deepEqual(
      afterPayment.sources[0],
      freeBefore,
      "payment does not reset free periods",
    );
    assert.deepEqual(afterPayment.sources[1], {
      name: "plan:order-plan",
      buckets: ["plan-total:order-plan", "plan-week:order-plan:0"],
    });
    f.store.db
      .prepare(
        "INSERT INTO commercial_entries(bucket_id,call_id,event_key,kind,delta,created_at) VALUES(?,NULL,?,'reserve',?,?)",
      )
      .run(
        "plan-week:order-plan:0",
        "week-spent",
        -100,
        new Date().toISOString(),
      );
    assert.equal(f.accounts.available(f.user.id, 1_000).plan, 0);
    assert.deepEqual(f.accounts.view(f.user.id, 1_000).plans[0], {
      orderId: "order-plan",
      weekPercent: 100,
      totalPercent: 0,
      expiresAt: "2026-10-31T00:00:00.000Z",
      nextResetAt: "2026-10-08T00:00:00.000Z",
    });
    f.add(7 * DAY);
    assert.deepEqual(f.accounts.sources(f.user.id, 1_000).sources[1], {
      name: "plan:order-plan",
      buckets: ["plan-total:order-plan", "plan-week:order-plan:1"],
    });
    f.add(23 * DAY);
    assert.equal(
      f.accounts
        .sources(f.user.id, 1_000)
        .sources.some((source) => source.name === "plan:order-plan"),
      false,
    );
    assert.equal(f.accounts.view(f.user.id, 1_000).plans.length, 0);
  } finally {
    f.store.close();
  }
});

test("wallets stay out until server-side consent and remain owner/order scoped", () => {
  const f = fixture();
  try {
    const id = "wallet-order";
    order(f, id, Date.parse("2026-10-24T15:59:00.000Z"));
    f.ledger.ensureBucket({
      id: "wallet:wallet-order",
      userId: f.user.id,
      kind: "wallet",
      credits: 700,
      startsAt: Date.parse("2026-10-24T15:59:00.000Z"),
      endsAt: null,
    });
    f.store.db
      .prepare(
        "INSERT INTO commercial_order_grants(order_id,bucket_id) VALUES(?,?)",
      )
      .run(id, "wallet:wallet-order");
    assert.equal(
      f.accounts
        .sources(f.user.id, 1_000)
        .sources.some((source) => source.name === "wallet:wallet-order"),
      false,
    );
    assert.deepEqual(f.accounts.view(f.user.id, 1_000).wallet, {
      balance: 700,
      consentRequired: true,
    });
    f.accounts.consentWallet(f.user.id);
    assert.equal(
      f.accounts.sources(f.user.id, 1_000).sources.at(-1)!.name,
      "wallet:wallet-order",
    );
    assert.deepEqual(f.accounts.view(f.user.id, 1_000).wallet, {
      balance: 700,
      consentRequired: false,
    });
  } finally {
    f.store.close();
  }
});

test("active plans consume in expiry order and future plans do not enter sources or the view", () => {
  const f = fixture("2026-10-10T00:00:00.000Z");
  try {
    grantPlan(f, "early", Date.parse("2026-10-01T00:00:00.000Z"));
    grantPlan(f, "later", Date.parse("2026-10-02T00:00:00.000Z"));
    grantPlan(f, "future", Date.parse("2026-10-11T00:00:00.000Z"));
    const sources = f.accounts.sources(f.user.id, 1_000).sources;
    assert.deepEqual(
      sources.slice(1).map((source) => source.name),
      ["plan:early", "plan:later"],
    );
    assert.deepEqual(
      f.accounts.view(f.user.id, 1_000).plans.map((plan) => plan.orderId),
      ["early", "later"],
    );
  } finally {
    f.store.close();
  }
});

test("commercial enablement requires both the explicit switch and approved catalog", () => {
  const f = fixture();
  try {
    assert.equal(f.accounts.enabled(), false);
    f.store.saveSetting("commercial.enabled", true);
    assert.equal(f.accounts.enabled(), false);
    f.store.saveSetting("commercial.catalog", approvedCommercialCatalog());
    assert.equal(f.accounts.enabled(), true);
  } finally {
    f.store.close();
  }
});
