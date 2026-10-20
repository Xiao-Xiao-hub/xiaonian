/*
 * 管理台统计：聚合用户、任务、消耗和运行状态，供十一页管理界面读取。
 * 读接口在 routes.ts，写操作在 manage.ts，模型接口配置在 ai.ts；管理权限由 auth 模块检查。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SqliteStore } from "../../shared/store.js";
import { chinaDate, chinaDayStart } from "../../shared/time.js";
import { NOT_VOID, type JobRunner } from "../jobs/runner.js";
import { CALC_MAP } from "../learn/calc-map.js";
type Row = Record<string, unknown>;
const DAY_MS = 86400_000;
const STATUSES = ["queued", "running", "succeeded", "failed", "unknown"];
const ARTIFACT_KINDS = ["explain", "answer", "quiz", "hints", "variant"];
const REASONS = ["wrong", "unclear", "citation", "other"];
const MAP_REASONS = ["judge", "problem", "unclear", "other"];
// Aggregates for the admin console: counts and metadata only. Never return
// learner text, answers, generated content, job params or user ids.
export class AdminService {
  constructor(
    private readonly store: SqliteStore,
    private readonly runner: JobRunner,
    private readonly options: {
      limits: Record<string, number>;
      uploadDir: string;
      chatLimits?: { answers: number; photos: number };
    },
  ) {}
  // Jobs created in the last 7 China days (today included), per kind and status.
  jobs() {
    const current = Date.parse(this.store.now());
    const start = current - 6 * DAY_MS;
    const since = chinaDayStart(start);
    const kinds = new Map<string, Record<string, unknown>>();
    const blank = (kind: string) => ({
      kind,
      ...Object.fromEntries(STATUSES.map((status) => [status, 0])),
      avgSec: null,
      p95Sec: null,
    });
    for (const kind of this.runner.kinds) kinds.set(kind, blank(kind));
    const rows = this.store.db
      .prepare(
        `SELECT kind,${STATUSES.map((s) => `SUM(status='${s}') AS ${s}`).join(",")},
          AVG(CASE WHEN status='succeeded' THEN (julianday(finished_at)-julianday(created_at))*86400 END) AS sec
        FROM jobs WHERE created_at>=? GROUP BY kind`,
      )
      .all(since) as Row[];
    for (const row of rows) {
      const kind = String(row.kind);
      kinds.set(kind, {
        ...blank(kind),
        ...Object.fromEntries(STATUSES.map((s) => [s, Number(row[s])])),
        avgSec: row.sec === null ? null : Math.round(Number(row.sec) * 10) / 10,
      });
    }
    // Nearest-rank p95; count only successful jobs with valid durations.
    const durationSql =
      "MAX(0,(julianday(finished_at)-julianday(created_at))*86400)";
    const ranked = this.store.db
      .prepare(
        `
      WITH durations AS (
        SELECT kind,${durationSql} AS sec FROM jobs
        WHERE created_at>=? AND status='succeeded' AND finished_at IS NOT NULL
      ), ranked AS (
        SELECT kind,sec,ROW_NUMBER() OVER(PARTITION BY kind ORDER BY sec) AS r,
          COUNT(*) OVER(PARTITION BY kind) AS n FROM durations
      ) SELECT kind,MIN(sec) AS sec FROM ranked WHERE r>=CEIL(n*0.95) GROUP BY kind
    `,
      )
      .all(since) as Row[];
    for (const row of ranked)
      kinds.get(String(row.kind))!.p95Sec =
        Math.round(Number(row.sec) * 10) / 10;
    const totals = Object.fromEntries(
      STATUSES.map((status) => [
        status,
        [...kinds.values()].reduce((sum, row) => sum + Number(row[status]), 0),
      ]),
    );
    const finished = totals.succeeded! + totals.failed! + totals.unknown!;
    const percentile = this.store.db
      .prepare(
        `
      WITH ranked AS (
        SELECT ${durationSql} AS sec, ROW_NUMBER() OVER(ORDER BY ${durationSql}) AS r,
          COUNT(*) OVER() AS n FROM jobs
        WHERE created_at>=? AND status='succeeded' AND finished_at IS NOT NULL
      ) SELECT MIN(sec) AS sec FROM ranked WHERE r>=CEIL(n*0.95)
    `,
      )
      .get(since) as Row;
    const queueRows = this.store.db
      .prepare(
        "SELECT status,COUNT(*) AS n,MIN(CASE WHEN status='running' THEN COALESCE(started_at,created_at) ELSE created_at END) AS oldest FROM jobs WHERE status IN ('queued','running') GROUP BY status",
      )
      .all() as Row[];
    const queue = {
      queued: 0,
      running: 0,
      oldestQueuedSec: null as number | null,
      oldestRunningSec: null as number | null,
    };
    for (const row of queueRows) {
      const status = row.status as "queued" | "running";
      queue[status] = Number(row.n);
      queue[status === "queued" ? "oldestQueuedSec" : "oldestRunningSec"] =
        Math.max(
          0,
          Math.floor((current - Date.parse(String(row.oldest))) / 1000),
        );
    }
    const recent = (
      this.store.db
        .prepare(
          "SELECT id,kind,status,error_code,error_message,params_hash,created_at,finished_at FROM jobs WHERE status IN ('failed','unknown') ORDER BY created_at DESC,rowid DESC LIMIT 50",
        )
        .all() as Row[]
    ).map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      code: row.error_code,
      message: row.error_message,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      retryable: this.runner.retryable(row),
    }));
    return {
      from: chinaDate(start),
      kinds: [...kinds.values()],
      recent,
      queue,
      summary: {
        total: finished + totals.queued! + totals.running!,
        finished,
        succeeded: totals.succeeded!,
        failed: totals.failed!,
        unknown: totals.unknown!,
        successRate: finished ? totals.succeeded! / finished : null,
        failureRate: finished ? totals.failed! / finished : null,
        p95Sec:
          percentile.sec === null
            ? null
            : Math.round(Number(percentile.sec) * 10) / 10,
      },
    };
  }
  // Current materials, and every stored generated result with the learner
  // reports against it (all time). Report notes are never read.
  quality() {
    const all = (sql: string) => this.store.db.prepare(sql).all() as Row[];
    const materials = new Map(
      ["note", "problem"].map((kind) => [
        kind,
        { kind, draft: 0, confirmed: 0, images: 0 },
      ]),
    );
    for (const row of all(
      "SELECT kind,SUM(status='draft') AS draft,SUM(status='confirmed') AS confirmed,SUM(image_path IS NOT NULL) AS images FROM materials GROUP BY kind",
    ))
      materials.set(String(row.kind), {
        kind: String(row.kind),
        draft: Number(row.draft),
        confirmed: Number(row.confirmed),
        images: Number(row.images),
      });
    const generated = new Map<
      string,
      {
        kind: string;
        count: number;
        reported: number;
        reports: Record<string, number>;
      }
    >();
    const entry = (kind: string) => {
      if (!generated.has(kind))
        generated.set(kind, {
          kind,
          count: 0,
          reported: 0,
          reports: Object.fromEntries(REASONS.map((reason) => [reason, 0])),
        });
      return generated.get(kind)!;
    };
    ARTIFACT_KINDS.forEach(entry);
    for (const row of all(
      "SELECT kind,COUNT(*) AS n,SUM(EXISTS(SELECT 1 FROM reports r WHERE r.artifact_id=a.id)) AS reported FROM artifacts a GROUP BY kind",
    ))
      Object.assign(entry(String(row.kind)), {
        count: Number(row.n),
        reported: Number(row.reported),
      });
    for (const row of all(
      "SELECT a.kind,r.reason,COUNT(*) AS n FROM reports r JOIN artifacts a ON a.id=r.artifact_id GROUP BY a.kind,r.reason",
    ))
      entry(String(row.kind)).reports[String(row.reason)] = Number(row.n);
    // 这题有问题 per map point: counts only, no answer, note or reporter.
    const points = CALC_MAP.chapters.flatMap((chapter, c) =>
      chapter.points.map((point, i) => ({
        chapter,
        point,
        order: c * 1000 + i,
      })),
    );
    const mapReports = all(
      `SELECT point_id,COUNT(*) AS total,COUNT(DISTINCT user_id) AS users,${MAP_REASONS.map((r) => `SUM(reason='${r}') AS ${r}`).join(",")} FROM map_reports GROUP BY point_id`,
    )
      .map((row) => ({
        row,
        at: points.find((p) => p.point.id === String(row.point_id)),
      }))
      .filter((x) => x.at)
      .sort(
        (a, b) =>
          Number(b.row.total) - Number(a.row.total) ||
          a.at!.order - b.at!.order,
      )
      .map(({ row, at }) => ({
        pointId: at!.point.id,
        name: at!.point.name,
        chapter: at!.chapter.short,
        total: Number(row.total),
        users: Number(row.users),
        reasons: Object.fromEntries(
          MAP_REASONS.map((r) => [r, Number(row[r])]),
        ),
      }));
    return {
      materials: [...materials.values()],
      generated: [...generated.values()],
      mapReports,
    };
  }
  // Today's quota use (counted like the runner: jobs created since China
  // midnight, any status), model tokens and storage size.
  usage() {
    const current = Date.parse(this.store.now());
    const since = chinaDayStart(current);
    const buckets = Object.entries(this.options.limits).map(
      ([bucket, limit]) => {
        const kinds = this.runner.quotaKinds(bucket);
        const counts = kinds.length
          ? (
              this.store.db
                .prepare(
                  `SELECT COUNT(*) AS n FROM quota_receipts r WHERE source='job' AND created_at>=? AND ${NOT_VOID} AND kind IN (${kinds.map(() => "?").join(",")}) GROUP BY user_id`,
                )
                .all(since, ...kinds) as Row[]
            ).map((row) => Number(row.n))
          : [];
        return {
          bucket,
          limit,
          jobs: counts.reduce((total, n) => total + n, 0),
          users: counts.length,
          nearLimit: counts.filter((n) => n < limit && n >= limit * 0.8).length,
          atLimit: counts.filter((n) => n >= limit).length,
        };
      },
    );
    for (const [bucket, source, limit] of this.options.chatLimits
      ? ([
          ["chat", "chat", this.options.chatLimits.answers],
          ["photos", "photo", this.options.chatLimits.photos],
        ] as const)
      : []) {
      const counts = (
        this.store.db
          .prepare(
            `SELECT COUNT(*) AS n FROM quota_receipts r WHERE source=? AND created_at>=? AND ${NOT_VOID} GROUP BY user_id`,
          )
          .all(source, since) as Row[]
      ).map((row) => Number(row.n));
      buckets.push({
        bucket,
        limit,
        jobs: counts.reduce((sum, n) => sum + n, 0),
        users: counts.length,
        nearLimit: counts.filter((n) => n < limit && n >= limit * 0.8).length,
        atLimit: counts.filter((n) => n >= limit).length,
      });
    }
    const llm = { calls: 0, promptTokens: 0, completionTokens: 0 };
    for (const row of this.store.db
      .prepare(
        `SELECT usage FROM jobs WHERE created_at>=? AND usage IS NOT NULL
         UNION ALL SELECT usage FROM messages WHERE created_at>=? AND usage IS NOT NULL
         UNION ALL SELECT usage FROM chat_images WHERE created_at>=? AND usage IS NOT NULL`,
      )
      .all(since, since, since) as Row[]) {
      const parsed = JSON.parse(String(row.usage)) as unknown;
      for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
        // OCR records carry no token counts.
        if (typeof entry?.promptTokens !== "number") continue;
        const safe = (n: unknown) =>
          typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
        llm.calls += safe(entry.calls);
        llm.promptTokens += safe(entry.promptTokens);
        llm.completionTokens += safe(entry.completionTokens);
      }
    }
    const pragma = (name: string) =>
      Number((this.store.db.prepare(`PRAGMA ${name}`).get() as Row)[name]);
    const uploads = { files: 0, bytes: 0 };
    try {
      for (const entry of readdirSync(this.options.uploadDir, {
        recursive: true,
        withFileTypes: true,
      }))
        if (entry.isFile()) {
          uploads.files++;
          uploads.bytes += statSync(join(entry.parentPath, entry.name)).size;
        }
    } catch (error) {
      // The directory is created with the first uploaded image.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      date: chinaDate(current),
      buckets,
      llm,
      ledger: this.ledger(),
      cost: {
        status: "unavailable",
        amount: null,
        currency: null,
        note: "未接入提供商账单和合同价格，调用次数与 token 不能作为实付金额；失败、重试与结果未知的调用需核对供应商账单。",
      },
      coverage: {
        scope: "anonymous-ledger",
        limitations: [
          "匿名总账从本版数据库升级时开始，不回填旧版或已删除数据；个人内容删除不会减少此后的调用累计。",
          "总账记录每次提供商网络尝试；成功是接口成功响应，不代表学习内容正确或已经扣费。重试逐次记录。",
          "缺失 token 以未报告标记；Jev 和腾讯 OCR 不返回 token，不能按零消耗计价。",
          "日期按北京时间的调用开始时间归属；中断或进程重启后无法确认结果的调用保留为未知。",
        ],
      },
      storage: {
        databaseBytes: pragma("page_count") * pragma("page_size"),
        schemaVersion: Number(
          (
            this.store.db
              .prepare("SELECT MAX(version) AS v FROM schema_migrations")
              .get() as Row
          ).v,
        ),
        uploads,
      },
    };
  }

  private ledger() {
    const current = Date.parse(this.store.now());
    const since = chinaDayStart(current);
    const fields = `COUNT(*) AS calls,
      COALESCE(SUM(prompt_tokens),0) AS promptTokens,
      COALESCE(SUM(completion_tokens),0) AS completionTokens,
      COALESCE(SUM(status='unknown'),0) AS unknown,
      COALESCE(SUM(status='pending'),0) AS pending,
      COALESCE(SUM(status='failed'),0) AS failed,
      COALESCE(SUM(status='succeeded'),0) AS succeeded,
      COALESCE(SUM(prompt_tokens IS NULL OR completion_tokens IS NULL),0) AS unreported`;
    const numberRow = (row: Row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
    const totals = numberRow(
      this.store.db
        .prepare(`SELECT ${fields} FROM usage_ledger WHERE created_at>=?`)
        .get(since) as Row,
    );
    const cumulative = numberRow(
      this.store.db.prepare(`SELECT ${fields} FROM usage_ledger`).get() as Row,
    );
    const providers = (
      this.store.db
        .prepare(
          `SELECT source,provider,model,${fields} FROM usage_ledger WHERE created_at>=? GROUP BY source,provider,model ORDER BY calls DESC,provider,model,source`,
        )
        .all(since) as Row[]
    ).map(({ source, provider, model, ...counts }) => ({
      source,
      provider,
      model,
      ...numberRow(counts),
    }));
    const start = current - 6 * DAY_MS;
    const daily = new Map(
      (
        this.store.db
          .prepare(
            `SELECT date(created_at,'+8 hours') AS date,${fields} FROM usage_ledger WHERE created_at>=? GROUP BY date(created_at,'+8 hours')`,
          )
          .all(chinaDayStart(start)) as Row[]
      ).map(({ date, ...counts }) => [String(date), numberRow(counts)]),
    );
    const trend = Array.from({ length: 7 }, (_, i) => {
      const date = chinaDate(start + i * DAY_MS);
      return {
        date,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        unknown: 0,
        pending: 0,
        failed: 0,
        succeeded: 0,
        unreported: 0,
        ...daily.get(date),
      };
    });
    const startedAt = (
      this.store.db
        .prepare("SELECT applied_at FROM schema_migrations WHERE version=11")
        .get() as Row
    ).applied_at;
    return {
      period: "today",
      timezone: "Asia/Shanghai",
      startedAt,
      totals,
      cumulative,
      providers,
      trend,
    };
  }
}
