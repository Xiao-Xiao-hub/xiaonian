import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/domain.js";
import { CommercialLedger } from "../../shared/commercial-ledger.js";
import type { SqliteStore } from "../../shared/store.js";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
export const ACCOUNT_OPEN_ORDERS_MESSAGE =
  "有订单还没处理完（刚下单、已付款待到账或正在退款），处理完再注销。有疑问可以在客服里提工单。";

/** Caller keeps this and account deletion in the same synchronous transaction. */
export function detachCommercialAccount(store: SqliteStore, userId: string) {
  const db = store.db;
  const now = Date.parse(store.now());
  const pending = db.prepare(
    `SELECT 1 FROM commercial_orders WHERE user_id=? AND
     (status IN ('paid','refunding') OR (status='created' AND created_at>?)) LIMIT 1`,
  ).get(userId, now - TWO_HOURS_MS);
  if (pending) throw new AppError(409, "ACCOUNT_OPEN_ORDERS", ACCOUNT_OPEN_ORDERS_MESSAGE);

  // An interrupted call must not leave a retained purchase frozen. The ledger
  // appends release entries before calls/content are deleted by their owner FK.
  const ledger = new CommercialLedger(store, () => new Date(now));
  const held = db.prepare("SELECT id FROM commercial_calls WHERE user_id=? AND status='held'")
    .all(userId) as { id: string }[];
  for (const call of held) ledger.release(userId, call.id);

  const count = Number((db.prepare("SELECT COUNT(*) n FROM commercial_orders WHERE user_id=?")
    .get(userId) as { n: number }).n);
  if (!count) return 0;
  // One independent tombstone per erased account preserves (owner,key)
  // uniqueness without retaining the old user ID, openid, profile or consent.
  const tombstone = `erased_${randomUUID().replaceAll("-", "")}`;
  db.prepare("INSERT INTO users(id,openid,data,erased_at,banned_at) VALUES(?,?,'{}',?,?)")
    .run(tombstone, tombstone, now, store.now());
  db.prepare(
    `UPDATE commercial_entries SET call_id=NULL WHERE bucket_id IN (
       SELECT g.bucket_id FROM commercial_order_grants g JOIN commercial_orders o ON o.id=g.order_id WHERE o.user_id=?
     )`,
  ).run(userId);
  db.prepare(
    `UPDATE commercial_buckets SET user_id=? WHERE user_id=? AND id IN (
       SELECT g.bucket_id FROM commercial_order_grants g JOIN commercial_orders o ON o.id=g.order_id WHERE o.user_id=?
     )`,
  ).run(tombstone, userId, userId);
  // Expired local drafts may still get a late verified payment. The payment
  // handler records that as an erased-account anomaly and never grants it.
  db.prepare("UPDATE commercial_orders SET status='closed',closed_at=? WHERE user_id=? AND status='created'")
    .run(now, userId);
  db.prepare("UPDATE commercial_orders SET user_id=?,account_erased_at=? WHERE user_id=?")
    .run(tombstone, now, userId);
  return count;
}

/** Three calendar years in Beijing; Feb 29 ends on Feb 28 in a non-leap year. */
export function transactionRetentionEndsAt(completedAt: number) {
  const date = new Date(completedAt + BEIJING_OFFSET_MS);
  const day = date.getUTCDate();
  const month = date.getUTCMonth();
  date.setUTCDate(1);
  date.setUTCFullYear(date.getUTCFullYear() + 3);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime() - BEIJING_OFFSET_MS;
}

/** Run at startup and daily. Only detached, terminal transactions are eligible. */
export function pruneRetainedTransactions(store: SqliteStore) {
  return store.transaction(() => {
    const now = Date.parse(store.now());
    const rows = store.db.prepare(
      `SELECT o.id,o.user_id,MAX(COALESCE(o.paid_at,0),COALESCE(o.delivered_at,0),
        COALESCE(o.closed_at,0),COALESCE(r.completed_at,0)) completed_at
       FROM commercial_orders o JOIN users u ON u.id=o.user_id
       LEFT JOIN commercial_refunds r ON r.order_id=o.id
       WHERE o.account_erased_at IS NOT NULL AND u.erased_at IS NOT NULL
       AND o.status IN ('delivered','refunded','closed') AND (r.id IS NULL OR r.status<>'pending')`,
    ).all() as { id: string; user_id: string; completed_at: number }[];
    let orders = 0;
    const owners = new Set<string>();
    for (const row of rows) {
      if (!row.completed_at || transactionRetentionEndsAt(row.completed_at) > now) continue;
      store.db.prepare(
        `DELETE FROM commercial_buckets WHERE user_id=? AND id IN
         (SELECT bucket_id FROM commercial_order_grants WHERE order_id=?)
         AND NOT EXISTS (SELECT 1 FROM commercial_order_grants g WHERE g.bucket_id=commercial_buckets.id AND g.order_id<>?)`,
      ).run(row.user_id, row.id, row.id);
      store.db.prepare("DELETE FROM commercial_orders WHERE id=? AND account_erased_at IS NOT NULL").run(row.id);
      owners.add(row.user_id);
      orders++;
    }
    for (const id of owners) store.db.prepare(
      "DELETE FROM users WHERE id=? AND erased_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM commercial_orders WHERE user_id=?)",
    ).run(id, id);
    if (orders) store.audit("system:retention", "commercial.retention.pruned", "retained-transactions", { orders });
    return orders;
  });
}
