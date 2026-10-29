import assert from "node:assert/strict";
import test from "node:test";
import { COMMERCIAL_CATALOG_SETTING, CommercialCatalog } from "../server/src/modules/commercial/catalog.js";
import { CommercialOrders } from "../server/src/modules/commercial/orders.js";
import { approvedCommercialCatalog } from "../server/src/modules/commercial/policy.js";
import { planChain, quotePlan } from "../server/src/modules/commercial/plan-chain.js";
import { detachCommercialAccount } from "../server/src/modules/commercial/retention.js";
import { CommercialAccounts } from "../server/src/shared/commercial-accounts.js";
import { CommercialLedger } from "../server/src/shared/commercial-ledger.js";
import { AppError } from "../server/src/shared/domain.js";
import { SqliteStore } from "../server/src/shared/store.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const PRICES = { plan_entry_30d: 1000, plan_standard_30d: 3000, plan_advanced_30d: 6000 } as const;

function setup() {
  let now = Date.parse("2026-10-24T08:00:00.000Z");
  const clock = () => new Date(now);
  const store = new SqliteStore(":memory:", clock);
  const catalog = new CommercialCatalog(store);
  const orders = new CommercialOrders(store, catalog, clock);
  store.saveSetting(COMMERCIAL_CATALOG_SETTING, approvedCommercialCatalog());
  const user = store.upsertUser("wx-plan-owner", "购买者", "wechat");
  const ledger = new CommercialLedger(store, clock);
  const accounts = new CommercialAccounts(store, ledger, clock);
  let seq = 0;
  const buy = (goodId: string, options: { platform?: string } = { platform: "android" }) =>
    orders.create(user.id, goodId, `key-${++seq}`, { ageBand: "adult" }, options);
  const pay = (order: { id: string; goodId: string; amountCents: number }, platform: "android" | "ios" = "android") =>
    orders.receiveVerifiedPayment({
      orderId: order.id, wxOrderId: `wx_${order.id}`, openid: user.openid, productId: order.goodId,
      amountCents: order.amountCents, platform, env: 0, paidAtMs: now,
    });
  const buckets = (orderId: string) => store.db.prepare(
    `SELECT b.id,b.kind,b.starts_at,b.ends_at,b.grant_credits FROM commercial_order_grants g
     JOIN commercial_buckets b ON b.id=g.bucket_id WHERE g.order_id=? ORDER BY b.starts_at,b.kind,b.id`,
  ).all(orderId) as Array<{ id: string; kind: string; starts_at: number; ends_at: number; grant_credits: number }>;
  const planSources = () => accounts.sources(user.id, 1000).sources.filter(item => item.name.startsWith("plan:"));
  return {
    store, orders, user, accounts, buy, pay, buckets, planSources,
    now: () => now,
    advance: (ms: number) => (now += ms),
    close: () => store.close(),
  };
}

const appError = (code: string) => (error: unknown) => {
  assert.ok(error instanceof AppError, String(error));
  assert.equal(error.code, code);
  return true;
};

test("renewing the same plan queues it after the current one and keeps the credits per period", t => {
  const f = setup(); t.after(f.close);
  const first = f.pay(f.buy("plan_entry_30d"));
  const firstEnd = f.now() + MONTH;
  f.advance(3 * DAY);
  const quote = quotePlan(f.store, f.user.id, { id: "plan_entry_30d", priceCents: 1000 }, f.now(), "ios");
  assert.equal(quote.action, "renew");
  assert.equal(quote.priceCents, 1000);
  assert.equal(quote.startsAt, firstEnd);
  const second = f.pay(f.buy("plan_entry_30d", { platform: "ios" }));
  assert.equal(second.amountCents, 1000);
  const total = f.buckets(second.id).find(row => row.kind === "plan_total")!;
  assert.deepEqual([total.starts_at, total.ends_at, total.grant_credits], [firstEnd, firstEnd + MONTH, 5400]);
  const weeks = f.buckets(second.id).filter(row => row.kind === "plan_week");
  assert.deepEqual(weeks.map(row => row.starts_at - firstEnd), [0, 1, 2, 3, 4].map(n => n * WEEK));
  // Only the running plan is spent; the queued one waits.
  assert.deepEqual(f.planSources().map(item => item.name), [`plan:${first.id}`]);
  f.advance(MONTH);
  assert.deepEqual(f.planSources().map(item => item.name), [`plan:${second.id}`]);
  // Points are never affected by the plan chain.
  assert.equal(f.pay(f.buy("points_10")).status, "delivered");
});

test("two plan orders created together and both paid queue instead of overlapping", t => {
  const f = setup(); t.after(f.close);
  const one = f.buy("plan_advanced_30d");
  const two = f.buy("plan_advanced_30d");
  assert.equal(one.amountCents, 6000);
  assert.equal(two.amountCents, 6000);
  f.advance(1000);
  f.pay(two);
  f.advance(1000);
  f.pay(one);
  const start = (id: string) => f.buckets(id).find(row => row.kind === "plan_total")!;
  assert.equal(start(one.id).starts_at, start(two.id).ends_at);
  const chain = planChain(f.store, f.user.id, f.now());
  assert.equal(chain.segments.length, 2);
  assert.equal(chain.endsAt, start(one.id).ends_at);
  assert.equal(f.planSources().length, 1);
});

test("a lower plan is refused while a higher one runs; points stay purchasable", t => {
  const f = setup(); t.after(f.close);
  f.pay(f.buy("plan_advanced_30d"));
  assert.throws(() => f.buy("plan_entry_30d"), appError("PLAN_DOWNGRADE_BLOCKED"));
  assert.throws(() => f.buy("plan_standard_30d"), (error: unknown) =>
    error instanceof AppError && error.statusCode === 409 && error.message === "当前套餐到期后才能换成更低的套餐");
  assert.equal(f.buy("points_50").amountCents, 5000);
  f.advance(MONTH);
  assert.equal(f.buy("plan_entry_30d").amountCents, 1000);
});

test("upgrade charges the prorated difference and converts the running and queued plans", t => {
  const f = setup(); t.after(f.close);
  const t0 = f.now();
  const running = f.pay(f.buy("plan_entry_30d"));
  f.advance(DAY);
  const queued = f.pay(f.buy("plan_entry_30d"));
  f.advance(19 * DAY); // 10 days left on the running plan, in its third week.
  const week3 = f.buckets(running.id).find(row => row.kind === "plan_week" && row.starts_at === t0 + 2 * WEEK)!;
  const total1 = `plan-total:${running.id}`;
  f.store.db.prepare(
    "INSERT INTO commercial_entries(bucket_id,event_key,kind,delta,created_at) VALUES(?,?,'reserve',-300,'2026-11-13T08:00:00Z')",
  ).run(week3.id, "test-use-week");
  f.store.db.prepare(
    "INSERT INTO commercial_entries(bucket_id,event_key,kind,delta,created_at) VALUES(?,?,'reserve',-300,'2026-11-13T08:00:00Z')",
  ).run(total1, "test-use-total");

  // (3000-1000) x 10/30 + (3000-1000) x 30/30, rounded up once.
  const upgrade = f.buy("plan_standard_30d");
  assert.equal(upgrade.amountCents, 2667);
  assert.equal(upgrade.listPriceCents, 3000);
  const snapshot = f.orders.detail(f.user.id, upgrade.id).snapshot as {
    planAction: string; upgrade: { priceCents: number; listPriceCents: number; segments: Array<{ orderId: string; remainingMs: number }> };
  };
  assert.equal(snapshot.planAction, "upgrade");
  assert.deepEqual(snapshot.upgrade.segments.map(item => [item.orderId, item.remainingMs]),
    [[running.id, 10 * DAY], [queued.id, MONTH]]);

  f.advance(HOUR);
  const at = f.now();
  f.pay(upgrade);
  const runningEnd = t0 + MONTH;
  const queuedStart = runningEnd;
  // Old buckets stay with their entries: the running one stops at the upgrade,
  // the queued ones move to [at-1, at).
  const old = Object.fromEntries(f.buckets(running.id).map(row => [row.id, row]));
  assert.equal(old[total1]!.ends_at, at);
  assert.equal(old[week3.id]!.ends_at, at);
  for (const row of f.buckets(queued.id)) assert.deepEqual([row.starts_at, row.ends_at], [at - 1, at]);
  assert.deepEqual(
    f.store.db.prepare("SELECT id,superseded_by FROM commercial_orders WHERE id IN (?,?) ORDER BY id").all(running.id, queued.id)
      .map(row => row.superseded_by),
    [upgrade.id, upgrade.id],
  );
  const fresh = f.buckets(upgrade.id);
  assert.equal(new Set(fresh.map(row => row.id)).size, fresh.length);
  const runningTotal = fresh.find(row => row.id === `plan-total:${upgrade.id}:${running.id}`)!;
  const remaining = runningEnd - at;
  assert.deepEqual([runningTotal.starts_at, runningTotal.ends_at, runningTotal.grant_credits],
    [at, runningEnd, Math.floor(17700 * remaining / MONTH)]);
  const runningWeeks = fresh.filter(row => row.id.startsWith(`plan-week:${upgrade.id}:${running.id}:`));
  assert.deepEqual(runningWeeks.map(row => [row.starts_at, row.ends_at, row.grant_credits]), [
    [at, t0 + 3 * WEEK, 4425 - 300],
    [t0 + 3 * WEEK, t0 + 4 * WEEK, 4425],
    [t0 + 4 * WEEK, runningEnd, 4425],
  ]);
  const queuedTotal = fresh.find(row => row.id === `plan-total:${upgrade.id}:${queued.id}`)!;
  assert.deepEqual([queuedTotal.starts_at, queuedTotal.ends_at, queuedTotal.grant_credits],
    [queuedStart, queuedStart + MONTH, 17700]);
  assert.equal(fresh.filter(row => row.id.startsWith(`plan-week:${upgrade.id}:${queued.id}:`)).length, 5);

  // One source at a time, always the upgrade order; the expiry date is unchanged.
  const sources = f.planSources();
  assert.deepEqual(sources.map(item => item.buckets), [[runningTotal.id, runningWeeks[0]!.id]]);
  const view = f.accounts.view(f.user.id, 1000);
  assert.equal(view.plans.length, 1);
  assert.equal(view.plans[0]!.expiresAt, new Date(runningEnd).toISOString());
  const chain = planChain(f.store, f.user.id, f.now());
  assert.deepEqual([chain.goodId, chain.endsAt, chain.segments.length], ["plan_standard_30d", queuedStart + MONTH, 2]);
  f.advance(runningEnd - f.now());
  assert.deepEqual(f.planSources().map(item => item.buckets[0]), [queuedTotal.id]);
  assert.equal(f.accounts.view(f.user.id, 1000).plans.length, 1);

  // A second upgrade converts the converted segment again with unique ids.
  const max = f.buy("plan_advanced_30d");
  assert.equal(max.amountCents, 3000);
  f.pay(max);
  assert.equal(f.store.db.prepare("SELECT superseded_by FROM commercial_orders WHERE id=?").get(upgrade.id)!.superseded_by, max.id);
  assert.equal(f.planSources().length, 1);
  assert.match(f.planSources()[0]!.buckets[0]!, new RegExp(`^plan-total:${max.id}:${upgrade.id}:${queued.id}$`));
});

test("upgrade is Android-only, at least one yuan, and refused when it would exceed the list price", t => {
  const f = setup(); t.after(f.close);
  f.pay(f.buy("plan_entry_30d"));
  assert.throws(() => f.buy("plan_standard_30d", { platform: "ios" }), appError("PLAN_UPGRADE_ANDROID_ONLY"));
  // An old mini program sends no platform; PC, Mac and HarmonyOS are not whitelisted.
  assert.throws(() => f.buy("plan_standard_30d", {}), appError("PLAN_UPGRADE_APP_OUTDATED"));
  for (const platform of ["windows", "mac", "ohos"])
    assert.throws(() => f.buy("plan_standard_30d", { platform }), appError("PLAN_UPGRADE_DEVICE_UNSUPPORTED"));
  const devtools = quotePlan(f.store, f.user.id, { id: "plan_standard_30d", priceCents: 3000 }, f.now(), "devtools");
  assert.equal(devtools.action, "upgrade");
  f.advance(MONTH - 30 * HOUR);
  assert.equal(f.buy("plan_standard_30d").amountCents, 100);
  f.pay(f.buy("plan_entry_30d"));
  f.pay(f.buy("plan_entry_30d"));
  const quote = quotePlan(f.store, f.user.id, { id: "plan_advanced_30d", priceCents: PRICES.plan_advanced_30d }, f.now(), "android");
  assert.deepEqual([quote.action, quote.reason], ["blocked", "PLAN_UPGRADE_TOO_LONG"]);
  assert.throws(() => f.buy("plan_advanced_30d"), appError("PLAN_UPGRADE_TOO_LONG"));
});

test("a plan queued between upgrade order and payment is not converted and stays after the chain", t => {
  const f = setup(); t.after(f.close);
  const running = f.pay(f.buy("plan_entry_30d"));
  f.advance(DAY);
  const upgrade = f.buy("plan_standard_30d");
  const late = f.pay(f.buy("plan_entry_30d"));
  f.advance(HOUR);
  f.pay(upgrade);
  assert.equal(f.store.db.prepare("SELECT superseded_by FROM commercial_orders WHERE id=?").get(running.id)!.superseded_by, upgrade.id);
  assert.equal(f.store.db.prepare("SELECT superseded_by FROM commercial_orders WHERE id=?").get(late.id)!.superseded_by, null);
  const chain = planChain(f.store, f.user.id, f.now());
  assert.deepEqual(chain.segments.map(item => [item.orderId, item.goodId]), [
    [upgrade.id, "plan_standard_30d"], [late.id, "plan_entry_30d"],
  ]);
  assert.equal(chain.segments[1]!.startsAt, chain.segments[0]!.endsAt);
});

test("a delivered order replayed after account erasure returns quietly; a second receipt cannot overwrite a late payment", t => {
  const f = setup(); t.after(f.close);
  const delivered = f.buy("points_10");
  const receipt = {
    orderId: delivered.id, wxOrderId: `wx_${delivered.id}`, openid: f.user.openid, productId: "points_10",
    amountCents: 1000, platform: "android" as const, env: 0 as const, paidAtMs: f.now(),
  };
  f.orders.receiveVerifiedPayment(receipt);
  const late = f.buy("points_30");
  f.advance(3 * HOUR); // an abandoned draft no longer blocks erasure
  f.store.transaction(() => detachCommercialAccount(f.store, f.user.id));
  const anomalies = () => Number(f.store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='commercial.payment.anomaly'").get()!.n);
  assert.equal(f.orders.receiveVerifiedPayment(receipt).status, "delivered");
  assert.equal(anomalies(), 0);
  const lateReceipt = { ...receipt, orderId: late.id, wxOrderId: `wx_${late.id}`, productId: "points_30", amountCents: 3000 };
  assert.equal(f.orders.receiveVerifiedPayment(lateReceipt).status, "paid");
  assert.equal(anomalies(), 1);
  assert.throws(() => f.orders.receiveVerifiedPayment({ ...lateReceipt, wxOrderId: "wx_other" }), appError("PAYMENT_CONFLICT"));
  assert.equal(f.store.db.prepare("SELECT wx_order_id FROM commercial_orders WHERE id=?").get(late.id)!.wx_order_id, `wx_${late.id}`);
});

test("an upgrade paid while a queued plan is refunding does not take it and records both segment lists", t => {
  const f = setup(); t.after(f.close);
  const e1 = f.pay(f.buy("plan_entry_30d"));
  f.advance(25 * DAY);
  const e2 = f.pay(f.buy("plan_entry_30d"));
  const upgrade = f.buy("plan_standard_30d");
  // Payment is delayed; meanwhile the queued plan goes into refund.
  f.store.db.prepare("UPDATE commercial_orders SET status='refunding' WHERE id=?").run(e2.id);
  const e2Before = f.buckets(e2.id);
  for (const goodId of ["plan_entry_30d", "plan_standard_30d", "plan_advanced_30d"])
    assert.equal(quotePlan(f.store, f.user.id, { id: goodId, priceCents: PRICES[goodId as keyof typeof PRICES] }, f.now(), "android").reason,
      "PLAN_REFUND_PENDING");
  f.advance(HOUR);
  f.pay(upgrade);
  const superseded = (id: string) => f.store.db.prepare("SELECT superseded_by FROM commercial_orders WHERE id=?").get(id)!.superseded_by;
  assert.equal(superseded(e1.id), upgrade.id);
  assert.equal(superseded(e2.id), null);
  assert.deepEqual(f.buckets(e2.id), e2Before);
  assert.deepEqual(f.buckets(upgrade.id).filter(row => row.kind === "plan_total").map(row => row.id),
    [`plan-total:${upgrade.id}:${e1.id}`]);
  const anomalies = f.store.audits({ action: "commercial.payment.anomaly" });
  assert.deepEqual(anomalies.map(row => [row.details.code, row.details.converted, row.details.unconverted]), [[
    "PLAN_UPGRADE_PARTIAL",
    [{ orderId: e1.id, totalBucketId: `plan-total:${e1.id}` }],
    [{ orderId: e2.id, totalBucketId: `plan-total:${e2.id}` }],
  ]]);
});

test("a renewal paid while the chain's last plan is refunding starts after the delivered plans", t => {
  const f = setup(); t.after(f.close);
  const e1 = f.pay(f.buy("plan_entry_30d"));
  const e1End = f.now() + MONTH;
  f.advance(HOUR);
  const e2 = f.pay(f.buy("plan_entry_30d"));
  const renewal = f.buy("plan_entry_30d");
  f.store.db.prepare("UPDATE commercial_orders SET status='refunding' WHERE id=?").run(e2.id);
  f.pay(renewal);
  const total = f.buckets(renewal.id).find(row => row.kind === "plan_total")!;
  assert.deepEqual([total.starts_at, total.ends_at], [e1End, e1End + MONTH]);
  assert.equal(planChain(f.store, f.user.id, f.now()).segments.map(item => item.orderId).join(), [e1.id, renewal.id].join());
  // With the only plan refunding, buying is still refused until the refund ends.
  const g = setup(); t.after(g.close);
  const only = g.pay(g.buy("plan_entry_30d"));
  g.store.db.prepare("UPDATE commercial_orders SET status='refunding' WHERE id=?").run(only.id);
  assert.throws(() => g.buy("plan_entry_30d"), appError("PLAN_REFUND_PENDING"));
});

test("no upgrade is offered in the last 24 hours of the chain", t => {
  const f = setup(); t.after(f.close);
  f.pay(f.buy("plan_entry_30d"));
  f.advance(MONTH - 23 * HOUR);
  const quote = quotePlan(f.store, f.user.id, { id: "plan_standard_30d", priceCents: 3000 }, f.now(), "android");
  assert.deepEqual([quote.action, quote.reason], ["blocked", "PLAN_UPGRADE_EXPIRING"]);
  assert.throws(() => f.buy("plan_standard_30d"), (error: unknown) =>
    appError("PLAN_UPGRADE_EXPIRING")(error) && (error as AppError).message === "当前套餐即将到期，可到期后购买");
  assert.equal(f.buy("plan_entry_30d").amountCents, 1000);
});
