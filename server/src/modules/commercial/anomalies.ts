import { createHash } from "node:crypto";
import type { SqliteStore } from "../../shared/store.js";
import type { Clock } from "../../shared/time.js";

const recorded = new WeakSet<object>();
/** Marks an error whose anomaly is already recorded, so an outer handler that
 * sees the same error does not record a second row for one failure. */
export function markAnomalyRecorded(error: unknown) {
  if (error !== null && typeof error === "object") recorded.add(error);
}
export const anomalyRecorded = (error: unknown) =>
  error !== null && typeof error === "object" && recorded.has(error);
const acknowledged = new WeakSet<object>();
/** Marks a recorded failure that a WeChat re-push cannot fix: the push
 * handler replies success instead of asking for a retry. */
export function markAnomalyAcknowledged(error: unknown) {
  markAnomalyRecorded(error);
  if (error !== null && typeof error === "object") acknowledged.add(error);
}
export const anomalyAcknowledged = (error: unknown) =>
  error !== null && typeof error === "object" && acknowledged.has(error);

/** Records one operator-visible payment anomaly until it is resolved. */
export function recordPaymentAnomaly(
  store: SqliteStore,
  clock: Clock,
  baseId: string,
  resourceId: string,
  details: Record<string, unknown>,
) {
  const latest = store.db.prepare(
    `SELECT id FROM audit WHERE action='commercial.payment.anomaly'
     AND (id=? OR substr(id,1,length(?)+1)=?||':') ORDER BY rowid DESC LIMIT 1`,
  ).get(baseId, baseId, baseId) as { id: string } | undefined;
  let id = baseId;
  if (latest) {
    const resolution = store.db.prepare(
      `SELECT id FROM audit WHERE action='commercial.payment.anomaly.resolved' AND resource_id=?
       ORDER BY created_at DESC,id DESC LIMIT 1`,
    ).get(latest.id) as { id: string } | undefined;
    if (!resolution) return false;
    const suffix = createHash("sha256").update(resolution.id).digest("hex").slice(0, 16);
    id = `${baseId}:${suffix}`;
  }
  return store.db.prepare(
    "INSERT OR IGNORE INTO audit(id,actor,action,resource_id,details,created_at) VALUES(?,'system:payment','commercial.payment.anomaly',?,?,?)",
  ).run(id, resourceId, JSON.stringify(details), clock().toISOString()).changes === 1;
}
