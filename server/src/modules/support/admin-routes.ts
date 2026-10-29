import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import type { SqliteStore } from "../../shared/store.js";
import { now as businessNow, type Clock } from "../../shared/time.js";
import {
  SUPPORT_POLICY_KEY,
  supportPolicy,
  supportPolicyInputSchema,
} from "./runtime.js";
import type { SupportPricingStatus } from "./runtime.js";

const ACTOR = "admin:shared";
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const updateSchema = z.object({
  policy: supportPolicyInputSchema,
  reason: z.string().trim().min(1).max(500),
}).strict();

const safeInteger = (value: unknown, name: string) => {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new RangeError(`${name}超出安全整数范围`);
  return parsed;
};

const beijingDay = (time: number) =>
  new Date(time + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
const beijingDayStart = (time: number) => {
  const shifted = new Date(time + BEIJING_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - BEIJING_OFFSET_MS;
};

/** Administrator-only support policy and local operational summaries. */
export function registerSupportAdminRoutes(
  app: FastifyInstance,
  deps: {
    auth: Pick<AuthService, "admin">;
    store: SqliteStore;
    clock?: Clock;
    pricingStatus?: () => SupportPricingStatus;
  },
) {
  const { store } = deps;
  const clock = deps.clock ?? businessNow;

  app.get("/v1/admin/support/policy", async (req) => {
    deps.auth.admin(req);
    return {
      data: {
        configured: store.setting(SUPPORT_POLICY_KEY) !== undefined,
        policy: supportPolicy(store),
      },
    };
  });

  app.put("/v1/admin/support/policy", async (req) => {
    deps.auth.admin(req);
    const body = updateSchema.parse(req.body);
    const previous = supportPolicy(store);
    store.transaction(() => {
      store.saveSetting(SUPPORT_POLICY_KEY, body.policy);
      store.audit(ACTOR, "support.policy.updated", SUPPORT_POLICY_KEY, {
        reason: body.reason,
        previous,
        next: body.policy,
        requestId: req.id,
      });
    });
    return { data: { configured: true, policy: supportPolicy(store) } };
  });

  app.get("/v1/admin/support/stats", async (req) => {
    deps.auth.admin(req);
    const currentDate = clock();
    const current = currentDate.getTime();
    if (!Number.isSafeInteger(current)) throw new RangeError("客服统计时钟无效");
    const day = beijingDay(current);
    const start = beijingDayStart(current);
    const byLayerRows = store.db.prepare(
      `SELECT COALESCE(layer,'unknown') layer,COUNT(*) n
         FROM support_chat_requests
        WHERE created_ms>=?
        GROUP BY COALESCE(layer,'unknown') ORDER BY layer`,
    ).all(start) as Array<{ layer: string; n: number }>;
    const requests = store.db.prepare(
      `SELECT COUNT(*) total,
              COALESCE(SUM(duplicate),0) duplicates,
              COALESCE(SUM(status='processing'),0) processing
         FROM support_chat_requests WHERE created_ms>=?`,
    ).get(start) as Record<string, unknown>;
    const holds = store.db.prepare(
      `SELECT kind,status,COUNT(*) n,COALESCE(SUM(reserved_microyuan),0) amount
         FROM support_cost_holds WHERE day=? GROUP BY kind,status ORDER BY kind,status`,
    ).all(day) as Array<{ kind: string; status: string; n: number; amount: number }>;
    const tickets = store.db.prepare(
      `SELECT COALESCE(SUM(status='open'),0) pending,
              COALESCE(SUM(status='open' AND due_at<?),0) overdue
         FROM support_tickets`,
    ).get(currentDate.toISOString()) as Record<string, unknown>;
    const occupied = holds
      .filter(row => row.status === "held" || row.status === "retained")
      .reduce((sum, row) => safeInteger(sum + safeInteger(row.amount, "客服成本预留"), "客服成本预留"), 0);
    const measured = store.db.prepare(`SELECT COUNT(*) n,COALESCE(SUM(cost_microyuan),0) known,
        COALESCE(SUM(cost_microyuan IS NULL),0) unknown_count
        FROM commercial_usage WHERE source LIKE 'support:%' AND created_at>=? AND created_at<?`)
      .get(new Date(start).toISOString(), new Date(start + 86_400_000).toISOString()) as Record<string, unknown>;
    const unknown = safeInteger(measured.unknown_count, "未知客服成本记录数");
    const actual = unknown || (Number(measured.n) === 0 && occupied > 0) ? null : safeInteger(measured.known, "客服实际成本");
    return {
      data: {
        day,
        requests: {
          total: safeInteger(requests.total, "客服消息数"),
          duplicates: safeInteger(requests.duplicates, "客服重复消息数"),
          processing: safeInteger(requests.processing, "客服处理中消息数"),
          byLayer: Object.fromEntries(byLayerRows.map(row => [row.layer, safeInteger(row.n, "客服分层数")])),
        },
        costReservations: {
          occupiedMicroyuan: occupied,
          actualCostMicroyuan: actual,
          knownCostMicroyuan: safeInteger(measured.known, "客服已知成本"),
          unknownCostRecords: unknown,
          basis: "conservative_upper_bound",
          note: "这是客服远端调用的保守成本占用，不是实际成本",
          rows: holds.map(row => ({
            kind: row.kind,
            status: row.status,
            reservations: safeInteger(row.n, "客服成本预留数"),
            reservedMicroyuan: safeInteger(row.amount, "客服成本预留"),
          })),
        },
        tickets: {
          pending: safeInteger(tickets.pending, "待处理工单数"),
          overdue72h: safeInteger(tickets.overdue, "超时工单数"),
        },
        pricing: deps.pricingStatus?.() ?? { judge: "not_configured", generate: "not_configured" },
      },
    };
  });
}
