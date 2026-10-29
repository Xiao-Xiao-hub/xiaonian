import { randomBytes } from "node:crypto";
import { AppError, type User } from "../../shared/domain.js";
import type { SqliteStore } from "../../shared/store.js";
import type { Clock } from "../../shared/time.js";
import { CommercialCatalog, type CommercialCatalogGood } from "./catalog.js";
import { recordPaymentAnomaly } from "./anomalies.js";
import {
  PLAN_MS,
  planChain,
  planRuleError,
  planTier,
  quotePlan,
  type UpgradeDetails,
} from "./plan-chain.js";
export { COMMERCIAL_ORDERS_SCHEMA } from "./orders-schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const PAYMENT_FUTURE_GRACE_MS = 5 * 60 * 1000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,128}$/;

type OrderStatus =
  | "created"
  | "paid"
  | "delivered"
  | "refunding"
  | "refunded"
  | "closed";
type Platform = "android" | "ios";
type OrderRow = {
  id: string;
  user_id: string;
  idempotency_key: string;
  good_id: string;
  amount_cents: number;
  snapshot: string;
  catalog_version: string;
  env: number;
  status: OrderStatus;
  wx_order_id: string | null;
  platform: Platform | null;
  paid_at: number | null;
  created_at: number;
  buyer_openid: string;
  account_erased_at: number | null;
  superseded_by?: string | null;
};
type OrderSnapshot = {
  version: string;
  good: CommercialCatalogGood;
  upgrade?: UpgradeDetails;
};

export type CommercialOrder = Readonly<{
  id: string;
  goodId: string;
  amountCents: number;
  /** The good's list price; above amountCents only for a plan upgrade. */
  listPriceCents: number;
  catalogVersion: string;
  env: 0;
  status: OrderStatus;
  platform: Platform | null;
  paidAtMs: number | null;
  createdAtMs: number;
}>;
export type CommercialOrderDetail = CommercialOrder &
  Readonly<{ snapshot: unknown }>;
export type VerifiedPayment = {
  orderId: string;
  wxOrderId: string;
  openid: string;
  productId: string;
  amountCents: number;
  platform: Platform;
  env: 0;
  paidAtMs: number;
};
export type PurchaseEligibility = Readonly<{
  /** Required at every purchase; account ageBand only distinguishes under 14. */
  ageBand?: "14_17" | "adult";
  /** Legacy route compatibility; only its derived band is stored. */
  age?: number;
  /** Required for the 14--17 declaration. */
  guardianConsent?: boolean;
}>;

const orderNumber = () => randomBytes(12).toString("hex");
const safeInteger = (value: unknown, name: string) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new AppError(400, "PAYMENT_INVALID", `${name}无效`);
  return value as number;
};
const paymentValue = (value: VerifiedPayment) => {
  if (
    typeof value.orderId !== "string" ||
    typeof value.wxOrderId !== "string" ||
    typeof value.openid !== "string" ||
    typeof value.productId !== "string" ||
    !value.orderId ||
    !value.wxOrderId ||
    !value.openid ||
    !value.productId ||
    value.wxOrderId.length > 128
  )
    throw new AppError(400, "PAYMENT_INVALID", "支付结果无效");
  if (value.platform !== "android" && value.platform !== "ios")
    throw new AppError(400, "PAYMENT_INVALID", "支付平台无效");
  if (value.env !== 0)
    throw new AppError(400, "PAYMENT_ENV_INVALID", "支付环境无效");
  safeInteger(value.amountCents, "支付金额");
  safeInteger(value.paidAtMs, "支付时间");
};
const listPrice = (row: OrderRow) => {
  try {
    const price = (JSON.parse(row.snapshot) as Partial<OrderSnapshot>)?.good?.priceCents;
    return Number.isSafeInteger(price) && price! >= row.amount_cents ? price! : row.amount_cents;
  } catch {
    return row.amount_cents;
  }
};
const publicOrder = (row: OrderRow): CommercialOrder =>
  Object.freeze({
    id: row.id,
    goodId: row.good_id,
    amountCents: row.amount_cents,
    listPriceCents: listPrice(row),
    catalogVersion: row.catalog_version,
    env: 0,
    status: row.status,
    platform: row.platform,
    paidAtMs: row.paid_at,
    createdAtMs: row.created_at,
  });

export class CommercialOrders {
  constructor(
    private readonly store: SqliteStore,
    private readonly catalog: CommercialCatalog,
    private readonly clock: Clock,
  ) {}

  create(
    userId: string,
    goodId: string,
    idempotencyKey: string,
    eligibility: PurchaseEligibility = {},
    options: Readonly<{ platform?: string }> = {},
  ): CommercialOrder {
    if (!IDEMPOTENCY_KEY.test(idempotencyKey))
      throw new AppError(400, "ORDER_IDEMPOTENCY_INVALID", "下单标识无效");
    return this.store.transaction(() => {
      const user = this.user(userId);
      const existing = this.store.db
        .prepare(
          "SELECT * FROM commercial_orders WHERE user_id=? AND idempotency_key=?",
        )
        .get(user.id, idempotencyKey) as OrderRow | undefined;
      if (existing) {
        if (existing.good_id !== goodId)
          throw new AppError(
            409,
            "ORDER_IDEMPOTENCY_CONFLICT",
            "下单标识已用于另一商品",
          );
        return publicOrder(existing);
      }
      const purchaseConsent = this.purchaseConsent(user, eligibility);
      const good = this.catalog.require(goodId);
      const snapshot = this.catalog.snapshot(goodId);
      const createdAt = this.clock().getTime();
      let amountCents = good.priceCents;
      let plan: Record<string, unknown> = {};
      if (good.kind === "plan") {
        // One plan at a time: same tier queues, higher tier upgrades the
        // remaining time, lower tier waits. Recomputed here, never trusted
        // from the client's quote.
        const quote = quotePlan(this.store, user.id, good, createdAt, options.platform);
        if (quote.action === "blocked") throw planRuleError(quote.reason!);
        amountCents = quote.priceCents;
        plan = {
          planAction: quote.action,
          ...(quote.upgrade ? { upgrade: quote.upgrade } : {}),
        };
      }
      const id = orderNumber();
      this.store.db
        .prepare(
          "INSERT INTO commercial_orders(id,user_id,idempotency_key,good_id,amount_cents,snapshot,catalog_version,env,status,created_at,buyer_openid) VALUES(?,?,?,?,?,?,?,0,'created',?,?)",
        )
        .run(
          id,
          user.id,
          idempotencyKey,
          good.id,
          amountCents,
          JSON.stringify({ ...JSON.parse(snapshot.json), purchaseConsent, ...plan }),
          snapshot.version,
          createdAt,
          user.openid,
        );
      return publicOrder(
        this.store.db
          .prepare("SELECT * FROM commercial_orders WHERE id=?")
          .get(id) as OrderRow,
      );
    });
  }

  // Called only by a signature-verified payment notification or query-order
  // adapter. It has no HTTP entry point and is safe to replay verbatim.
  receiveVerifiedPayment(payment: VerifiedPayment): CommercialOrder {
    paymentValue(payment);
    return this.store.transaction(() => {
      const order = this.store.db
        .prepare("SELECT * FROM commercial_orders WHERE id=?")
        .get(payment.orderId) as OrderRow | undefined;
      if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "订单不存在");
      const byWechat = this.store.db
        .prepare("SELECT * FROM commercial_orders WHERE wx_order_id=?")
        .get(payment.wxOrderId) as OrderRow | undefined;
      if (byWechat && byWechat.id !== order.id)
        throw new AppError(409, "PAYMENT_CONFLICT", "支付单号已对应另一订单");
      if (
        order.good_id !== payment.productId ||
        order.amount_cents !== payment.amountCents ||
        order.env !== payment.env
      )
        throw new AppError(409, "PAYMENT_MISMATCH", "支付结果与订单不一致");
      if (order.buyer_openid !== payment.openid)
        throw new AppError(
          409,
          "PAYMENT_USER_MISMATCH",
          "支付用户与订单不一致",
        );
      const now = this.clock().getTime();
      if (
        payment.paidAtMs < Math.floor(order.created_at / 1000) * 1000 ||
        payment.paidAtMs > now + PAYMENT_FUTURE_GRACE_MS
      )
        throw new AppError(409, "PAYMENT_TIME_INVALID", "支付时间无效");
      if (order.account_erased_at !== null) {
        if (byWechat) {
          if (order.platform !== payment.platform || order.paid_at !== payment.paidAtMs)
            throw new AppError(409, "PAYMENT_CONFLICT", "支付结果与历史订单不一致");
          // Delivered before the account was erased: a WeChat re-push or a
          // manual query is a replay of a fulfilled order, not a late payment.
          if (["delivered", "refunding", "refunded"].includes(order.status))
            return publicOrder(order);
        } else {
          const paid = this.store.db.prepare(
            "UPDATE commercial_orders SET status='paid',wx_order_id=?,platform=?,paid_at=? WHERE id=? AND status IN ('created','closed')",
          ).run(payment.wxOrderId, payment.platform, payment.paidAtMs, order.id);
          if (paid.changes !== 1)
            throw new AppError(409, "PAYMENT_CONFLICT", "订单已完成或正在处理");
        }
        this.recordErasedPayment(order.id);
        return publicOrder(this.store.db.prepare("SELECT * FROM commercial_orders WHERE id=?").get(order.id) as OrderRow);
      }
      if (byWechat) {
        if (!["delivered", "refunding", "refunded"].includes(order.status) ||
          order.platform !== payment.platform || order.paid_at !== payment.paidAtMs)
          throw new AppError(
            409,
            "PAYMENT_CONFLICT",
            "支付结果与已发货订单不一致",
          );
        return publicOrder(order);
      }
      if (order.status !== "created")
        throw new AppError(409, "PAYMENT_CONFLICT", "订单已完成或正在处理");
      const snapshot = JSON.parse(order.snapshot) as OrderSnapshot;
      const good = snapshot.good;
      const upgrade = snapshot.upgrade;
      if (
        !good ||
        good.id !== order.good_id ||
        (upgrade
          ? good.kind !== "plan" ||
            upgrade.priceCents !== order.amount_cents ||
            upgrade.listPriceCents !== good.priceCents ||
            !Array.isArray(upgrade.segments)
          : good.priceCents !== order.amount_cents)
      )
        throw new AppError(409, "ORDER_SNAPSHOT_INVALID", "订单快照无效");
      this.store.db
        .prepare(
          "UPDATE commercial_orders SET status='delivered',wx_order_id=?,platform=?,paid_at=?,delivered_at=? WHERE id=? AND status='created'",
        )
        .run(payment.wxOrderId, payment.platform, payment.paidAtMs, now, order.id);
      if (upgrade)
        this.upgradePlan(order.id, order.user_id, good, upgrade, payment.platform, now);
      else
        this.grant(order.id, order.user_id, good, payment.platform, payment.paidAtMs);
      return publicOrder(
        this.store.db
          .prepare("SELECT * FROM commercial_orders WHERE id=?")
          .get(order.id) as OrderRow,
      );
    });
  }

  /** Close only an unpaid local order after query_order returned status 6. */
  closeVerifiedUnpaid(orderId: string): CommercialOrder {
    if (typeof orderId !== "string" || !orderId.length)
      throw new AppError(400, "PAYMENT_INVALID", "订单号无效");
    return this.store.transaction(() => {
      const order = this.store.db.prepare(
        "SELECT * FROM commercial_orders WHERE id=?",
      ).get(orderId) as OrderRow | undefined;
      if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "订单不存在");
      if (order.status === "created") {
        const closed = this.store.db.prepare(
          "UPDATE commercial_orders SET status='closed',closed_at=? WHERE id=? AND status='created'",
        ).run(this.clock().getTime(), order.id);
        if (closed.changes === 1)
          this.store.audit("system:payment", "commercial.order.closed", order.id, {
            source: "query_order",
            platformStatus: 6,
          });
      }
      // A concurrent payment/delivery always wins. Never rewrite a paid,
      // delivered, refunding or refunded order to closed.
      return publicOrder(this.store.db.prepare(
        "SELECT * FROM commercial_orders WHERE id=?",
      ).get(order.id) as OrderRow);
    });
  }

  list(userId: string): CommercialOrder[] {
    this.user(userId);
    return this.store.db
      .prepare(
        "SELECT * FROM commercial_orders WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 100",
      )
      .all(userId)
      .map((row) => publicOrder(row as OrderRow));
  }

  private recordErasedPayment(orderId: string) {
    recordPaymentAnomaly(this.store, this.clock, `commercial-erased-payment:${orderId}`, orderId,
      { source: "payment", phase: "deliver", code: "ORDER_ACCOUNT_ERASED" });
  }

  detail(userId: string, id: string): CommercialOrderDetail {
    this.user(userId);
    const row = this.store.db
      .prepare("SELECT * FROM commercial_orders WHERE id=? AND user_id=?")
      .get(id, userId) as OrderRow | undefined;
    if (!row) throw new AppError(404, "ORDER_NOT_FOUND", "订单不存在");
    return Object.freeze({
      ...publicOrder(row),
      snapshot: JSON.parse(row.snapshot),
    });
  }

  private user(userId: string): User {
    const user = this.store.getUser(userId);
    if (!user) throw new AppError(401, "SESSION_EXPIRED", "登录状态已失效");
    if (user.authMode !== "wechat")
      throw new AppError(403, "WECHAT_REQUIRED", "请使用微信账号购买");
    return user;
  }

  private purchaseConsent(user: User, input: PurchaseEligibility) {
    // Existing "child" is the account's under-14 classification. Existing
    // "adult" only means 已满14岁, so it cannot prove adulthood for a paid
    // purchase; each purchase needs its smaller age-band declaration.
    if (user.ageBand === "child")
      throw new AppError(403, "PURCHASE_AGE_FORBIDDEN", "未满14周岁不能购买");
    let ageBand = input.ageBand;
    if (ageBand === undefined && input.age !== undefined) {
      if (!Number.isSafeInteger(input.age) || input.age < 0 || input.age > 130)
        throw new AppError(
          400,
          "PURCHASE_AGE_REQUIRED",
          "请明确选择购买年龄段",
        );
      if (input.age < 14)
        throw new AppError(403, "PURCHASE_AGE_FORBIDDEN", "未满14周岁不能购买");
      ageBand = input.age < 18 ? "14_17" : "adult";
    }
    if (ageBand !== "14_17" && ageBand !== "adult")
      throw new AppError(400, "PURCHASE_AGE_REQUIRED", "请明确选择购买年龄段");
    if (ageBand === "14_17" && input.guardianConsent !== true)
      throw new AppError(
        403,
        "PURCHASE_GUARDIAN_REQUIRED",
        "14至18周岁购买需要监护人同意",
      );
    return Object.freeze({
      ageBand,
      guardianConsent: ageBand === "14_17",
      recordedAt: this.clock().toISOString(),
    });
  }

  private grant(
    orderId: string,
    userId: string,
    good: CommercialCatalogGood,
    platform: Platform,
    paidAt: number,
  ) {
    const benefits = good[platform];
    if (good.kind === "points") {
      this.insertBuckets(orderId, userId, [{
        id: `wallet:${orderId}`,
        kind: "wallet",
        credits: benefits.credits,
        startsAt: paidAt,
        endsAt: null,
      }]);
      return;
    }
    // A new or renewed plan starts where the user's current chain ends, read
    // again at delivery: two orders paid together queue instead of overlapping.
    const tail = planChain(this.store, userId, paidAt, orderId).endsAt;
    const startsAt = tail === null ? paidAt : Math.max(tail, paidAt);
    const expiresAt = startsAt + PLAN_MS;
    this.insertBuckets(orderId, userId, [
      {
        id: `plan-total:${orderId}`,
        kind: "plan_total",
        credits: benefits.credits,
        startsAt,
        endsAt: expiresAt,
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `plan-week:${orderId}:${index + 1}`,
        kind: "plan_week" as const,
        credits: benefits.weeklyCredits!,
        startsAt: startsAt + index * WEEK_MS,
        endsAt: Math.min(startsAt + (index + 1) * WEEK_MS, expiresAt),
      })),
    ]);
  }

  /** Converts the chain segments listed in the upgrade snapshot that are still
   * on the chain to the target tier from `at`. Expiry dates do not change. */
  private upgradePlan(
    orderId: string,
    userId: string,
    good: CommercialCatalogGood,
    upgrade: UpgradeDetails,
    platform: Platform,
    at: number,
  ) {
    const benefits = good[platform];
    const target = planTier(good.id);
    const listed = new Set(upgrade.segments.map((item) => item.totalBucketId));
    const chain = planChain(this.store, userId, at, orderId);
    const bucket = (id: string) => this.store.db.prepare(
      "SELECT id,starts_at,ends_at FROM commercial_buckets WHERE id=?",
    ).get(id) as { id: string; starts_at: number; ends_at: number };
    const balance = (id: string) => Number((this.store.db.prepare(
      "SELECT COALESCE(SUM(delta),0) n FROM commercial_entries WHERE bucket_id=?",
    ).get(id) as { n: number }).n);
    // Old buckets cannot be deleted (their entries are the ledger) and a
    // zero-length span violates the CHECK, so a bucket that has not started
    // moves to [at-1, at) and a running one ends at `at`.
    const retire = (row: { id: string; starts_at: number }) => {
      if (row.starts_at < at)
        this.store.db.prepare("UPDATE commercial_buckets SET ends_at=? WHERE id=?").run(at, row.id);
      else
        this.store.db.prepare("UPDATE commercial_buckets SET starts_at=?,ends_at=? WHERE id=?").run(at - 1, at, row.id);
    };
    const owners = new Set<string>();
    const converted = new Set<string>();
    for (const segment of chain.segments) {
      if (!listed.has(segment.totalBucketId) || segment.tier >= target) continue;
      const total = bucket(segment.totalBucketId);
      const suffix = total.id.slice("plan-total:".length);
      const weeks = this.store.db.prepare(
        `SELECT b.id,b.starts_at,b.ends_at FROM commercial_buckets b
         JOIN commercial_order_grants g ON g.bucket_id=b.id AND g.order_id=?
         WHERE b.kind='plan_week' AND substr(b.id,1,?)=? AND b.ends_at>?
         ORDER BY b.starts_at,b.id`,
      ).all(segment.orderId, `plan-week:${suffix}:`.length, `plan-week:${suffix}:`, at) as Array<{
        id: string; starts_at: number; ends_at: number;
      }>;
      const running = total.starts_at < at;
      const remaining = total.ends_at - Math.max(total.starts_at, at);
      const next = [
        {
          id: `plan-total:${orderId}:${suffix}`,
          kind: "plan_total" as const,
          credits: running
            ? Number((BigInt(benefits.credits) * BigInt(remaining)) / BigInt(PLAN_MS))
            : benefits.credits,
          startsAt: Math.max(total.starts_at, at),
          endsAt: total.ends_at,
        },
        ...weeks.map((week, index) => {
          const current = week.starts_at < at;
          const used = Math.max(0, segment.weeklyCredits - balance(week.id));
          return {
            id: `plan-week:${orderId}:${suffix}:${index + 1}`,
            kind: "plan_week" as const,
            credits: current
              ? Math.max(0, benefits.weeklyCredits! - used)
              : benefits.weeklyCredits!,
            startsAt: Math.max(week.starts_at, at),
            endsAt: week.ends_at,
          };
        }),
      ];
      retire(total);
      for (const week of weeks) retire(week);
      this.insertBuckets(orderId, userId, next);
      owners.add(segment.orderId);
      converted.add(segment.totalBucketId);
    }
    for (const owner of owners) {
      const live = this.store.db.prepare(
        `SELECT 1 FROM commercial_order_grants g JOIN commercial_buckets b ON b.id=g.bucket_id
         WHERE g.order_id=? AND b.kind='plan_total' AND b.ends_at>? LIMIT 1`,
      ).get(owner, at);
      if (!live)
        this.store.db.prepare(
          "UPDATE commercial_orders SET superseded_by=? WHERE id=? AND superseded_by IS NULL",
        ).run(orderId, owner);
    }
    // A segment that changed after the quote (expired, refunding, refunded or
    // taken by another upgrade) was paid for but not converted: an operator
    // refunds the difference. With nothing converted the order holds no grant
    // and the admin refund refunds it in full.
    if (converted.size !== listed.size) {
      const segment = (item: UpgradeDetails["segments"][number]) =>
        ({ orderId: item.orderId, totalBucketId: item.totalBucketId });
      recordPaymentAnomaly(this.store, this.clock, `commercial-upgrade-partial:${orderId}`, orderId, {
        source: "payment",
        phase: "deliver",
        code: "PLAN_UPGRADE_PARTIAL",
        converted: upgrade.segments.filter((item) => converted.has(item.totalBucketId)).map(segment),
        unconverted: upgrade.segments.filter((item) => !converted.has(item.totalBucketId)).map(segment),
      });
    }
  }

  private insertBuckets(
    orderId: string,
    userId: string,
    buckets: Array<{
      id: string;
      kind: "wallet" | "plan_total" | "plan_week";
      credits: number;
      startsAt: number;
      endsAt: number | null;
    }>,
  ) {
    const insertBucket = this.store.db.prepare(
      "INSERT INTO commercial_buckets(id,user_id,kind,starts_at,ends_at,grant_credits,created_at) VALUES(?,?,?,?,?,?,?)",
    );
    const insertEntry = this.store.db.prepare(
      "INSERT INTO commercial_entries(bucket_id,call_id,event_key,kind,delta,created_at) VALUES(?,NULL,?,'grant',?,?)",
    );
    const insertGrant = this.store.db.prepare(
      "INSERT INTO commercial_order_grants(order_id,bucket_id) VALUES(?,?)",
    );
    for (const bucket of buckets) {
      insertBucket.run(
        bucket.id,
        userId,
        bucket.kind,
        bucket.startsAt,
        bucket.endsAt,
        bucket.credits,
        this.clock().toISOString(),
      );
      insertEntry.run(
        bucket.id,
        `grant:order:${orderId}:${bucket.id}`,
        bucket.credits,
        this.clock().toISOString(),
      );
      insertGrant.run(orderId, bucket.id);
    }
  }
}
