import type { SqliteStore } from "../../shared/store.js";
import { AppError } from "../../shared/domain.js";
import { now as businessNow, type Clock } from "../../shared/time.js";
import { PUBLISHED_COMMERCIAL_GOODS } from "../commercial/catalog.js";
import { commercialAllowances } from "../commercial/settings.js";
import { planChain } from "../commercial/plan-chain.js";

type Row = Record<string, unknown>;
const integer = (value: unknown) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("账户汇总无效");
  return n;
};

/** Only SELECT statements. Reading support context cannot grant, reserve,
 * refund or consume any entitlement, including a new free window. */
const beijingDate = (ms: number) => {
  const date = new Date(ms + 8 * 3_600_000);
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
};

export function supportAccountReader(store: SqliteStore, clock: Clock = businessNow) {
  return (userId: string) => {
    if (!store.getUser(userId)) throw new AppError(401, "SESSION_EXPIRED", "请先登录");
    const at = clock().getTime();
    const buckets = store.db.prepare(`
      SELECT b.id,b.kind,b.grant_credits,b.ends_at,COALESCE(SUM(e.delta),0) AS remaining
      FROM commercial_buckets b LEFT JOIN commercial_entries e ON e.bucket_id=b.id
      WHERE b.user_id=? AND b.starts_at<=? AND (b.ends_at IS NULL OR b.ends_at>?)
      GROUP BY b.id ORDER BY b.ends_at,b.id
    `).all(userId, at, at) as Row[];
    const allowances = commercialAllowances(store);
    const free = (kind: string, configured: number) => {
      const bucket = buckets.find(item => item.kind === kind);
      // The commercial centre creates these buckets lazily. Before that first
      // read, present the configured unused allowance without writing a bucket.
      if (!bucket) return configured > 0 ? 100 : 0;
      const grant = integer(bucket.grant_credits);
      const remaining = integer(bucket.remaining);
      return grant ? Math.min(100, Math.floor(remaining * 100 / grant)) : 0;
    };
    const day = free("free_day", allowances.freeDayCredits);
    const week = free("free_week", allowances.freeWeekCredits);
    const quotaSummary = `今天的免费额度还剩${day}%，本周还剩${week}%。`;
    const plans = buckets.filter(item => item.kind === "plan_total");
    const planSummary = plans.length
      ? plans.map(item => `套餐还剩${integer(item.grant_credits) ? Math.min(100, Math.floor(integer(item.remaining) * 100 / integer(item.grant_credits))) : 0}%${item.ends_at === null ? "" : `，${beijingDate(integer(item.ends_at))}到期`}`).join("；")
      : "目前没有有效套餐。";
    // Renewals queue behind the running plan; say how far the chain reaches.
    const chainEnd = planChain(store, userId, at).endsAt;
    const runningEnd = Math.max(0, ...plans.map(item => item.ends_at === null ? 0 : integer(item.ends_at)));
    const planText = plans.length && chainEnd !== null && chainEnd > runningEnd
      ? `${planSummary}；已续费到${beijingDate(chainEnd)}`
      : planSummary;
    const wallets = buckets.filter(item => item.kind === "wallet");
    const walletBalance = wallets.length ? wallets.reduce((sum, item) => integer(sum + integer(item.remaining)), 0) : null;
    const orders = (store.db.prepare(`SELECT id,good_id,status,platform,amount_cents,paid_at
      FROM commercial_orders WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 3`).all(userId) as Row[])
      .map(item => ({
        id: String(item.id),
        productName: PUBLISHED_COMMERCIAL_GOODS.find(good => good.id === item.good_id)?.name ?? "历史商品",
        status: String(item.status),
        platform: item.platform === null ? null : String(item.platform),
        amountCents: integer(item.amount_cents),
        paidAt: item.paid_at === null ? null : new Date(integer(item.paid_at)).toISOString(),
      }));
    const failed = store.db.prepare(`SELECT status FROM commercial_usage
      WHERE user_id=? AND status IN ('failed','unknown') ORDER BY created_at DESC,id DESC LIMIT 1`).get(userId) as Row | undefined;
    return {
      quotaSummary, planSummary: planText, walletBalance, orders,
      lastFailure: failed?.status === "failed" ? "最近一次使用没有完成，没有扣额度"
        : failed ? "最近一次使用的扣费结果还在核对" : null,
    };
  };
}
