/*
 * 管理台写操作：处理反馈、用户停用、个别额度、任务重试与题库查询。
 * 每个入口使用管理员鉴权；修改会影响实际业务状态，应保留现有审计与输入校验。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../../shared/domain.js";
import {
  BUCKETS,
  Limits,
  MAX_LIMIT,
  type Bucket,
} from "../../shared/limits.js";
import type { SqliteStore } from "../../shared/store.js";
import { chinaDayStart } from "../../shared/time.js";
import type { ModelRouter } from "../../providers/model-router.js";
import type { AuthService } from "../auth/service.js";
import { NOT_VOID, type JobRunner } from "../jobs/runner.js";
import { CALC_MAP } from "../learn/calc-map.js";
import { BANK } from "../learn/problems.js";
import { answeredAs, pageForm } from "../learn/problems-choices.js";
import { month, monthlyCost } from "./cost.js";
import {
  BUDGET_LIMIT,
  DEFAULT_PRICES,
  priceTable,
  unpriced,
  validPrice,
  type Budget,
} from "../../shared/budget.js";

type Row = Record<string, unknown>;
const ACTOR = "admin:shared";
const DAY_MS = 86400_000;
const POINTS = CALC_MAP.chapters.flatMap((chapter, c) =>
  chapter.points.map((point, i) => ({ chapter, point, order: c * 1000 + i })),
);
const pointOf = (id: string) => POINTS.find((p) => p.point.id === id);
const parse = (text: unknown) =>
  typeof text === "string" ? (JSON.parse(text) as unknown) : null;
const userParams = z.object({ id: z.string().min(1).max(64) }).strict();
const note = z.string().trim().max(200).optional();
const quotaValue = z.number().int().min(0).max(MAX_LIMIT);
// Yuan, to the fen.
const yuan = z.number().min(0).max(BUDGET_LIMIT);
const priceRow = z
  .object({
    host: z.string().trim().toLowerCase().max(300),
    model: z.string().trim().min(1).max(128),
    input: yuan,
    output: yuan,
    cached: yuan,
    note: z.string().trim().max(200).default(""),
  })
  .strict();
// The admin workbench : a to-do summary, learner feedback with the
// answer it was about, accounts (ban, per-account quota), failed-job retry,
// the read-only problem bank and global daily limits. Learner notes, chat
// messages and material text never appear in any of these responses.
export function registerAdminManageRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthService;
    store: SqliteStore;
    runner: JobRunner;
    limits: Limits;
    models: ModelRouter;
    budget: Budget;
  },
) {
  const { auth, store, runner, limits, models, budget } = deps;
  const db = store.db;
  const businessMs = () => Date.parse(store.now());
  const one = (sql: string, ...args: (string | number)[]) =>
    db.prepare(sql).get(...args) as Row;
  const all = (sql: string, ...args: (string | number)[]) =>
    db.prepare(sql).all(...args) as Row[];
  // Today's use per bucket for one account, counted like the charging code.
  const usedToday = (userId: string) => {
    const rows = all(
      `SELECT source,kind,COUNT(*) AS n FROM quota_receipts r WHERE user_id=? AND created_at>=? AND ${NOT_VOID} GROUP BY source,kind`,
      userId,
      chinaDayStart(businessMs()),
    );
    const sum = (source: string, kinds?: string[]) =>
      rows
        .filter(
          (r) =>
            r.source === source && (!kinds || kinds.includes(String(r.kind))),
        )
        .reduce((total, r) => total + Number(r.n), 0);
    return {
      ai: sum("job", runner.quotaKinds("ai")),
      ocr: sum("job", runner.quotaKinds("ocr")),
      notes: sum("job", runner.quotaKinds("notes")),
      chat: sum("chat"),
      photos: sum("photo"),
      brainstorm: sum("job", runner.quotaKinds("brainstorm")),
      import: sum("job", runner.quotaKinds("import")),
    } satisfies Record<Bucket, number>;
  };
  // Yuan spent today, this week and this calendar month.
  const spend = (userId: string) => {
    const { day, week } = budget.status(userId);
    return {
      day: day.spent,
      week: week.spent,
      month: budget.spent(userId, month(businessMs()).since),
    };
  };
  const lastActive = `MAX(
      COALESCE((SELECT MAX(created_at) FROM quota_receipts q WHERE q.user_id=u.id),''),
      COALESCE((SELECT MAX(updated_at) FROM map_points m WHERE m.user_id=u.id),''),
      COALESCE((SELECT MAX(updated_at) FROM notes n WHERE n.user_id=u.id),''),
      COALESCE((SELECT MAX(updated_at) FROM materials t WHERE t.user_id=u.id),''),
      COALESCE((SELECT MAX(created_at) FROM audit a WHERE a.actor=u.id),''))`;
  const account = (row: Row) => {
    const data = JSON.parse(String(row.data)) as Row;
    return {
      id: String(row.id),
      nickname: String(data.nickname ?? ""),
      authMode: String(data.authMode ?? ""),
      createdAt: String(data.createdAt ?? ""),
      lastActiveAt: row.last_active ? String(row.last_active) : null,
      bannedAt: (row.banned_at as string | null) ?? null,
      banReason: (row.ban_reason as string | null) ?? null,
      quota: limits.overrides(String(row.id)),
    };
  };

  app.get("/v1/admin/todo", async (req) => {
    auth.admin(req);
    const day = new Date(businessMs() - DAY_MS).toISOString();
    const jobs = one(
      "SELECT SUM(status='failed') AS failed,SUM(status='unknown') AS unknown FROM jobs WHERE created_at>=?",
      day,
    );
    const retryable = all(
      "SELECT * FROM jobs WHERE status='failed' AND created_at>=?",
      new Date(businessMs() - 7 * DAY_MS).toISOString(),
    ).filter((row) => runner.retryable(row)).length;
    const endpoints = models.endpoints();
    const cooling = endpoints.filter(
      (e) => e.enabled && models.healthOf(e.id).coolingUntil,
    ).length;
    return {
      data: {
        feedback: {
          map: Number(
            one(
              "SELECT COUNT(*) AS n FROM map_reports WHERE handled_at IS NULL",
            ).n,
          ),
          artifact: Number(
            one("SELECT COUNT(*) AS n FROM reports WHERE handled_at IS NULL").n,
          ),
        },
        jobs: {
          failed24h: Number(jobs.failed ?? 0),
          unknown24h: Number(jobs.unknown ?? 0),
          retryable,
          queued: Number(
            one(
              "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')",
            ).n,
          ),
        },
        ai: {
          endpoints: endpoints.length,
          enabled: endpoints.filter((e) => e.enabled).length,
          vision: endpoints.filter((e) => e.enabled && e.vision).length,
          cooling,
          // enabled models without a price row.
          unpriced: unpriced(store).map((row) => row.model),
          // model calls of the last 24 hours that came back without
          // token usage (charged by estimate, see providers/llm.ts).
          noUsage24h: Number(
            one(
              "SELECT COUNT(*) AS n FROM usage_ledger WHERE source IN ('llm.json','llm.stream') AND status='succeeded' AND prompt_tokens IS NULL AND completion_tokens IS NULL AND created_at>=?",
              day,
            ).n,
          ),
        },
        users: {
          total: Number(one("SELECT COUNT(*) AS n FROM users WHERE erased_at IS NULL").n),
          banned: Number(
            one("SELECT COUNT(*) AS n FROM users WHERE erased_at IS NULL AND banned_at IS NOT NULL")
              .n,
          ),
          newToday: Number(
            one(
              "SELECT COUNT(*) AS n FROM users WHERE erased_at IS NULL AND json_extract(data,'$.createdAt')>=?",
              chinaDayStart(businessMs()),
            ).n,
          ),
          overrides: Number(
            one(
              "SELECT COUNT(*) AS n FROM users WHERE erased_at IS NULL AND quota IS NOT NULL AND quota<>'{}'",
            ).n,
          ),
        },
      },
    };
  });

  // ---- feedback ----------------------------------------------------------
  app.get("/v1/admin/feedback", async (req) => {
    auth.admin(req);
    const q = z
      .object({
        status: z.enum(["open", "handled", "all"]).default("open"),
        type: z.enum(["map", "artifact", "all"]).default("all"),
        point: z.string().max(64).optional(),
      })
      .strict()
      .parse(req.query ?? {});
    const handled = (alias = "") =>
      q.status === "open"
        ? `${alias}handled_at IS NULL`
        : q.status === "handled"
          ? `${alias}handled_at IS NOT NULL`
          : "1";
    const items: Row[] = [];
    if (q.type !== "artifact")
      for (const row of all(
        `SELECT id,point_id,reason,answer,understood,verdict,COALESCE(bank_index,problem_index) AS problem_index,problem_kind,answer_json,understood_json,form,created_at,handled_at,handled_note FROM map_reports WHERE ${handled()}${q.point ? " AND point_id=?" : ""} ORDER BY created_at DESC,rowid DESC LIMIT 300`,
        ...(q.point ? [q.point] : []),
      )) {
        const at = pointOf(String(row.point_id));
        const index = row.problem_index as number | null;
        const answer = row.answer_json ? parse(row.answer_json) : row.answer;
        // As the report route judged it : the bank form the
        // 0.6.0 page showed, else the point page form, or the authored
        // problem for a typed answer to a converted one.
        const served =
          index === null ? null : (BANK[String(row.point_id)]?.[index] ?? null);
        items.push({
          type: "map",
          id: row.id,
          pointId: row.point_id,
          pointName: at?.point.name ?? String(row.point_id),
          chapter: at?.chapter.short ?? "",
          reason: row.reason,
          problemIndex: index,
          problemKind: row.problem_kind,
          // What the learner was judged against; older rows lack the index.
          problem:
            served &&
            (row.form === "bank" ? served : answeredAs(pageForm(served), answer)),
          form: row.form ?? null,
          answer,
          understood: row.understood_json
            ? parse(row.understood_json)
            : row.understood,
          verdict: row.verdict,
          createdAt: row.created_at,
          handledAt: row.handled_at,
          handledNote: row.handled_note,
        });
      }
    if (q.type !== "map" && !q.point)
      for (const row of all(
        `SELECT r.id,r.reason,r.note,r.created_at,r.handled_at,r.handled_note,a.kind,json_extract(a.data,'$.model') AS model FROM reports r JOIN artifacts a ON a.id=r.artifact_id WHERE ${handled("r.")} ORDER BY r.created_at DESC,r.rowid DESC LIMIT 300`,
      ))
        items.push({
          type: "artifact",
          id: row.id,
          artifactKind: row.kind,
          model: row.model ?? null,
          reason: row.reason,
          note: row.note,
          createdAt: row.created_at,
          handledAt: row.handled_at,
          handledNote: row.handled_note,
        });
    items.sort((a, b) =>
      String(b.createdAt).localeCompare(String(a.createdAt)),
    );
    return { data: { items: items.slice(0, 300) } };
  });
  app.put("/v1/admin/feedback/:type/:id", async (req) => {
    auth.admin(req);
    const { type, id } = z
      .object({
        type: z.enum(["map", "artifact"]),
        id: z.string().min(1).max(64),
      })
      .strict()
      .parse(req.params);
    const body = z
      .object({ handled: z.boolean(), note })
      .strict()
      .parse(req.body);
    const table = type === "map" ? "map_reports" : "reports";
    store.transaction(() => {
      const changed = db
        .prepare(`UPDATE ${table} SET handled_at=?,handled_note=? WHERE id=?`)
        .run(
          body.handled ? store.now() : null,
          body.handled ? body.note || null : null,
          id,
        ).changes;
      if (!changed)
        throw new AppError(404, "NOT_FOUND", "这条反馈不存在或已删除");
      store.audit(
        ACTOR,
        body.handled ? "feedback.handled" : "feedback.reopened",
        id,
        {
          type,
          note: body.handled ? body.note || null : null,
          requestId: req.id,
        },
      );
    });
    return { data: { id, handled: body.handled } };
  });

  // ---- accounts ----------------------------------------------------------
  app.get("/v1/admin/users", async (req) => {
    auth.admin(req);
    const q = z
      .object({
        q: z.string().trim().max(64).optional(),
        filter: z.enum(["all", "banned", "custom"]).default("all"),
        page: z.coerce.number().int().min(1).max(10000).default(1),
      })
      .strict()
      .parse(req.query ?? {});
    const where: string[] = ["u.erased_at IS NULL"];
    const args: string[] = [];
    if (q.q) {
      where.push(
        "(u.id LIKE ? ESCAPE '\\' OR json_extract(u.data,'$.nickname') LIKE ? ESCAPE '\\')",
      );
      const like = q.q.replace(/[\\%_]/g, (c) => `\\${c}`);
      args.push(`${like}%`, `%${like}%`);
    }
    if (q.filter === "banned") where.push("u.banned_at IS NOT NULL");
    if (q.filter === "custom")
      where.push("u.quota IS NOT NULL AND u.quota<>'{}'");
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const size = 30;
    const total = Number(
      one(`SELECT COUNT(*) AS n FROM users u ${clause}`, ...args).n,
    );
    const rows = all(
      `SELECT u.id,u.data,u.banned_at,u.ban_reason,${lastActive} AS last_active FROM users u ${clause} ORDER BY last_active DESC,u.rowid DESC LIMIT ? OFFSET ?`,
      ...args,
      size,
      (q.page - 1) * size,
    );
    return {
      data: {
        items: rows.map((row) => ({
          ...account(row),
          today: usedToday(String(row.id)),
          spend: spend(String(row.id)),
        })),
        total,
        page: q.page,
        pages: Math.max(1, Math.ceil(total / size)),
        global: limits.global(),
        budget: budget.global(),
      },
    };
  });
  const detail = (id: string) => {
    const row = one(
      `SELECT u.id,u.data,u.banned_at,u.ban_reason,${lastActive} AS last_active FROM users u WHERE u.id=? AND u.erased_at IS NULL`,
      id,
    );
    if (!row) throw new AppError(404, "NOT_FOUND", "没有这个用户");
    const count = (sql: string) => Number(one(sql, id).n);
    const used = usedToday(id);
    return {
      ...account(row),
      counts: {
        materials: count("SELECT COUNT(*) AS n FROM materials WHERE user_id=?"),
        notes: count("SELECT COUNT(*) AS n FROM notes WHERE user_id=?"),
        threads: count("SELECT COUNT(*) AS n FROM threads WHERE user_id=?"),
        mapPoints: count(
          "SELECT COUNT(*) AS n FROM map_points WHERE user_id=? AND correct_at IS NOT NULL",
        ),
        mistakes: count(
          "SELECT COUNT(*) AS n FROM mistakes WHERE user_id=? AND status='open'",
        ),
        reports: count(
          "SELECT (SELECT COUNT(*) FROM map_reports WHERE user_id=?1)+(SELECT COUNT(*) FROM reports WHERE user_id=?1) AS n",
        ),
        jobs7d: Number(
          one(
            "SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND created_at>=?",
            id,
            new Date(businessMs() - 7 * DAY_MS).toISOString(),
          ).n,
        ),
      },
      usage: Object.fromEntries(
        BUCKETS.map((b) => [b, { used: used[b], limit: limits.for(id, b) }]),
      ),
      monthlyCost: monthlyCost(store, id),
      global: limits.global(),
      // yuan spent and allowed; `overrides` are this account's own.
      budget: {
        ...budget.status(id),
        month: spend(id).month,
        overrides: budget.overrides(id),
        global: budget.global(),
      },
      history: all(
        "SELECT action,details,created_at FROM audit WHERE resource_id=? AND actor=? ORDER BY rowid DESC LIMIT 20",
        id,
        ACTOR,
      ).map((r) => ({
        action: r.action,
        details: parse(r.details),
        createdAt: r.created_at,
      })),
    };
  };
  app.get("/v1/admin/users/:id", async (req) => {
    auth.admin(req);
    return { data: detail(userParams.parse(req.params).id) };
  });
  app.put("/v1/admin/users/:id/ban", async (req) => {
    auth.admin(req);
    const { id } = userParams.parse(req.params);
    const body = z
      .object({ banned: z.boolean(), reason: note })
      .strict()
      .parse(req.body);
    store.transaction(() => {
      const changed = db
        .prepare("UPDATE users SET banned_at=?,ban_reason=? WHERE id=? AND erased_at IS NULL")
        .run(
          body.banned ? store.now() : null,
          body.banned ? body.reason || null : null,
          id,
        ).changes;
      if (!changed) throw new AppError(404, "NOT_FOUND", "没有这个用户");
      store.audit(ACTOR, body.banned ? "user.banned" : "user.unbanned", id, {
        reason: body.banned ? body.reason || null : null,
        requestId: req.id,
      });
    });
    return { data: detail(id) };
  });
  app.put("/v1/admin/users/:id/quota", async (req) => {
    auth.admin(req);
    const { id } = userParams.parse(req.params);
    // null removes an override, so the account follows the global limit again.
    const body = z
      .object({
        ...(Object.fromEntries(
          BUCKETS.map((b) => [b, quotaValue.nullable().optional()]),
        ) as Record<Bucket, z.ZodOptional<z.ZodNullable<typeof quotaValue>>>),
        // the account's own yuan budget per day / week.
        budget: z
          .object({
            day: yuan.nullable().optional(),
            week: yuan.nullable().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(req.body);
    store.transaction(() => {
      const next: Record<string, unknown> = { ...limits.overrides(id) };
      for (const bucket of BUCKETS) {
        const value = body[bucket];
        if (value === null) delete next[bucket];
        else if (value !== undefined) next[bucket] = value;
      }
      const own: Record<string, number> = { ...budget.overrides(id) };
      for (const key of ["day", "week"] as const) {
        const value = body.budget?.[key];
        if (value === null) delete own[key];
        else if (value !== undefined) own[key] = value;
      }
      if (Object.keys(own).length) next.budget = own;
      const changed = db
        .prepare("UPDATE users SET quota=? WHERE id=? AND erased_at IS NULL")
        .run(
          Object.keys(next).length ? JSON.stringify(next) : null,
          id,
        ).changes;
      if (!changed) throw new AppError(404, "NOT_FOUND", "没有这个用户");
      store.audit(ACTOR, "user.quota.updated", id, {
        quota: next,
        requestId: req.id,
      });
    });
    return { data: detail(id) };
  });

  // ---- jobs --------------------------------------------------------------
  app.post("/v1/admin/jobs/:id/retry", async (req) => {
    auth.admin(req);
    const { id } = userParams.parse(req.params);
    const job = runner.retry(id);
    store.audit(ACTOR, "job.retried", id, {
      kind: job.kind,
      code: job.error?.code ?? null,
      requestId: req.id,
    });
    return { data: { id, status: "queued" } };
  });

  // ---- problem bank (read-only) ------------------------------------
  app.get("/v1/admin/bank", async (req) => {
    auth.admin(req);
    const counts = new Map(
      all(
        "SELECT point_id,COUNT(*) AS total,SUM(handled_at IS NULL) AS open FROM map_reports GROUP BY point_id",
      ).map((r) => [
        String(r.point_id),
        { total: Number(r.total), open: Number(r.open) },
      ]),
    );
    const points = POINTS.map(({ chapter, point, order }) => ({
      pointId: point.id,
      name: point.name,
      chapterId: chapter.id,
      chapter: chapter.short,
      section: point.section,
      tier: point.tier,
      order,
      reports: counts.get(point.id) ?? { total: 0, open: 0 },
      // As the bank serves them; `source` is the authored one.
      problems: (BANK[point.id] ?? []).map((problem, index) => ({
        index,
        ...problem,
      })),
    })).sort(
      (a, b) =>
        b.reports.open - a.reports.open ||
        b.reports.total - a.reports.total ||
        a.order - b.order,
    );
    return {
      data: {
        points,
        chapters: CALC_MAP.chapters.map((c) => ({
          id: c.id,
          short: c.short,
          label: c.label,
        })),
        problems: points.reduce((n, p) => n + p.problems.length, 0),
      },
    };
  });

  // ---- settings ----------------------------------------------------------
  const settings = () => {
    const table = priceTable(store);
    return {
      limits: { current: limits.global(), defaults: limits.defaults },
      // yuan budgets, the hidden daily cap and the price table;
      // `unpriced` lists enabled models charged at the highest rate.
      budget: {
        current: budget.global(),
        defaults: { day: budget.defaults.day, week: budget.defaults.week },
        safetyCap: budget.defaults.cap,
      },
      prices: {
        rows: table,
        custom: store.setting("ai.prices") !== undefined,
        defaults: DEFAULT_PRICES,
        unpriced: unpriced(store, table),
      },
    };
  };
  app.get("/v1/admin/settings", async (req) => {
    auth.admin(req);
    return { data: settings() };
  });
  app.put("/v1/admin/settings/limits", async (req) => {
    auth.admin(req);
    const body = z
      .object(
        Object.fromEntries(
          BUCKETS.map((b) => [b, quotaValue.optional()]),
        ) as Record<Bucket, z.ZodOptional<typeof quotaValue>>,
      )
      .strict()
      .parse(req.body);
    const next = { ...limits.global(), ...body };
    store.transaction(() => {
      store.saveSetting("quota.limits", next);
      store.audit(ACTOR, "settings.limits.updated", "quota-limits", {
        ...next,
        requestId: req.id,
      });
    });
    return { data: settings() };
  });
  app.put("/v1/admin/settings/budget", async (req) => {
    auth.admin(req);
    const body = z
      .object({ day: yuan.optional(), week: yuan.optional() })
      .strict()
      .parse(req.body);
    const next = { ...budget.global(), ...body };
    store.transaction(() => {
      store.saveSetting("quota.budget", next);
      store.audit(ACTOR, "settings.budget.updated", "quota-budget", {
        ...next,
        requestId: req.id,
      });
    });
    return { data: settings() };
  });
  // The whole table at once; host is the endpoint's base URL host, or empty
  // for the model on any host.
  app.put("/v1/admin/settings/prices", async (req) => {
    auth.admin(req);
    const { rows } = z
      .object({ rows: z.array(priceRow).max(200) })
      .strict()
      .parse(req.body);
    const keys = new Set(rows.map((row) => `${row.host}/${row.model.toLowerCase()}`));
    if (keys.size !== rows.length)
      throw new AppError(400, "DUPLICATE_PRICE", "同一模型的价格重复了");
    if (!rows.every(validPrice))
      throw new AppError(400, "INVALID_PRICE", "价格无效");
    store.transaction(() => {
      store.saveSetting("ai.prices", rows);
      store.audit(ACTOR, "settings.prices.updated", "ai-prices", {
        rows: rows.length,
        requestId: req.id,
      });
    });
    return { data: settings() };
  });
}
