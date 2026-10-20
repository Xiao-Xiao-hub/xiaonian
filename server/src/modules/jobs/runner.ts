/*
 * 后台任务执行器：使用 SQLite 记录任务，在当前进程内限制并发、调度和恢复。
 * 领域服务提供 run/commit/onFail：run 做耗时工作，commit 在事务内保存结果，onFail 恢复可重试状态。
 * unknown 表示外部请求可能已发生且结果无法确认；任务状态、用户扣额和提供商消耗要分别理解。
 */
import { randomUUID } from "node:crypto";
import type { Budget } from "../../shared/budget.js";
import { AppError } from "../../shared/domain.js";
import { withJobDeadline } from "../../shared/job-deadline.js";
import { digest, type SqliteStore } from "../../shared/store.js";
import {
  chinaDayStart,
  now as businessNow,
  type Clock,
} from "../../shared/time.js";
export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "unknown";
export type Job = {
  id: string;
  userId: string;
  materialId: string | null;
  kind: string;
  version: number | null;
  params: Record<string, unknown>;
  status: JobStatus;
  result: unknown;
  error: { code: string; message: string } | null;
  usage: unknown;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress?: JobProgress;
};
// stage names the handler's current real step; step/steps count
// batches inside that stage. Old clients ignore both.
export type JobProgress = (
  | { chars: number; expect: number; thinking?: boolean }
  | { page: number; pages: number }
  | { stage: string }
) & { stage?: string; step?: number; steps?: number };
// Expected failure with a user-facing message. billing "unknown" means an
// external call may have been charged, so the job ends as "unknown", not "failed".
export class JobError extends Error {
  constructor(
    public code: string,
    message: string,
    public billing: "none" | "unknown" = "none",
  ) {
    super(message);
  }
}
export type JobHandler = {
  // Quota bucket counted per user per day; unmetered when absent.
  quota?: string;
  // One receipt is written for each unit. Scan handlers use this for pages.
  quotaUnits?: (params: Record<string, unknown>) => number;
  // A task can derive its own timeout from its parameters; otherwise the
  // runner-wide timeout applies.
  timeoutMs?: (params: Record<string, unknown>) => number | undefined;
  // Network work normally stays side-effect free. Long per-page import jobs
  // may checkpoint completed pages so a process restart does not lose them.
  run(
    job: Job,
    signal: AbortSignal,
    reportProgress: (progress: JobProgress) => void,
  ): Promise<{ output: unknown; usage?: unknown }>;
  // Synchronous, inside the completion transaction; the return value becomes job.result.
  commit?(job: Job, output: unknown): unknown;
  // Synchronous, inside the transaction that ends the job as failed or
  // unknown (errors, timeouts, interrupts, restarts). Puts the parent row
  // back where the user can retry this step; must be idempotent, because
  // recover calls it again for recent failures.
  onFail?(job: Job, failure: { code: string; message: string }, status: JobStatus): void;
};
export type RunnerOptions = {
  concurrency: number;
  timeoutMs: number;
  limits: Record<string, number>;
  // Per-account limit (admin overrides and global settings); falls back to limits.
  limitFor?: (userId: string, bucket: string) => number | undefined;
  log?: (error: unknown, job: Job) => void;
  now?: Clock;
  // V4.2 : with a budget, quota checks are the learner's yuan budget and
  // the hidden daily cap; the per-bucket count limits apply only without one.
  // A succeeded job's usage is charged to it.
  budget?: Budget;
};
// User-facing failure lines : failures are free, so no fee warning.
const INTERRUPTED = "这次没跑完，可以再试一次";
const TIMED_OUT = "这次想得有点久，没跑完，可以再试一次";
const PROVIDER_DOWN = "这会儿有点忙，过一会儿再试一次";
// Failures where the provider did not answer usefully and nothing was billed.
const RETRYABLE =
  /^(JOB_FAILED|AI_(UNAVAILABLE|BUSY|QUOTA|AUTH|BAD_OUTPUT|NOT_CONFIGURED)|OCR_(UNAVAILABLE|QUOTA|AUTH|FAILED|NOT_CONFIGURED)|JEV_(UNAVAILABLE|BUSY|AUTH|BAD_OUTPUT|NOT_CONFIGURED))$/;
// A receipt in quota_voids is free. Use with the receipts aliased as r.
export const NOT_VOID =
  "NOT EXISTS(SELECT 1 FROM quota_voids v WHERE v.source=r.source AND v.source_id=r.source_id)";
const json = (value: unknown) =>
  value === undefined ? null : JSON.stringify(value);
const parse = (text: unknown) =>
  typeof text === "string" ? (JSON.parse(text) as unknown) : null;
export function toJob(row: Record<string, unknown>): Job {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    materialId: (row.material_id as string | null) ?? null,
    kind: String(row.kind),
    version: (row.version as number | null) ?? null,
    params: parse(row.params) as Record<string, unknown>,
    status: row.status as JobStatus,
    result: parse(row.result),
    error: row.error_code
      ? { code: String(row.error_code), message: String(row.error_message) }
      : null,
    usage: parse(row.usage),
    createdAt: String(row.created_at),
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}
const expected = (
  error: unknown,
): error is Error & { code: string; billing: "none" | "unknown" } =>
  error instanceof Error &&
  typeof (error as { code?: unknown }).code === "string" &&
  ["none", "unknown"].includes((error as { billing?: string }).billing ?? "");
export const publicJob = (job: Job) => ({
  id: job.id,
  kind: job.kind,
  status: job.status,
  materialId: job.materialId,
  version: job.version,
  result: job.status === "succeeded" ? job.result : null,
  error: job.error,
  createdAt: job.createdAt,
  finishedAt: job.finishedAt,
  ...(job.progress ? { progress: job.progress } : {}),
});
// SQLite-backed queue executed in-process with bounded concurrency.
export class JobRunner {
  private readonly active = new Set<Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly progress = new Map<string, JobProgress>();
  private scanActive = false;
  private stopping = false;
  constructor(
    private readonly store: SqliteStore,
    private readonly handlers: Record<string, JobHandler>,
    private readonly options: RunnerOptions,
  ) {}
  private now() {
    return this.options.now?.() ?? businessNow();
  }
  get(id: string) {
    const row = this.store.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    return row ? { ...toJob(row), progress: this.progress.get(id) } : undefined;
  }
  get kinds() {
    return Object.keys(this.handlers);
  }
  quotaKinds(bucket: string) {
    return this.kinds.filter((kind) => this.handlers[kind]!.quota === bucket);
  }
  // Identical requests (same user, kind, material version and params) reuse the
  // queued, running or succeeded job; refresh skips succeeded ones.
  enqueue(input: {
    userId: string;
    kind: string;
    materialId?: string | null;
    version?: number | null;
    params?: Record<string, unknown>;
    refresh?: boolean;
  }): { job: Job; reused: boolean } {
    const handler = this.handlers[input.kind];
    if (!handler)
      throw new AppError(400, "UNSUPPORTED_JOB", "不支持的任务类型");
    const params = input.params ?? {};
    const hash = digest(
      JSON.stringify([input.materialId ?? null, input.version ?? null, params]),
    );
    const outcome = this.store.transaction(() => {
      const existing = this.store.db
        .prepare(
          `SELECT * FROM jobs WHERE user_id=? AND kind=? AND params_hash=? AND status IN (${input.refresh ? "'queued','running'" : "'queued','running','succeeded'"}) ORDER BY created_at DESC,rowid DESC LIMIT 1`,
        )
        .get(input.userId, input.kind, hash);
      if (existing) return { job: toJob(existing), reused: true };
      const quotaUnits = handler.quota
        ? this.validateQuotaUnits(handler.quotaUnits?.(params) ?? 1)
        : 0;
      if (handler.quota)
        this.checkQuota(input.userId, handler.quota, quotaUnits);
      const id = `job_${randomUUID().replaceAll("-", "")}`;
      const createdAt = this.now().toISOString();
      this.store.db
        .prepare(
          "INSERT INTO jobs(id,user_id,material_id,kind,version,params,params_hash,status,created_at) VALUES(?,?,?,?,?,?,?,'queued',?)",
        )
        .run(
          id,
          input.userId,
          input.materialId ?? null,
          input.kind,
          input.version ?? null,
          JSON.stringify(params),
          hash,
          createdAt,
        );
      if (handler.quota && quotaUnits > 1)
        for (let page = 2; page <= quotaUnits; page++)
          this.store.db
            .prepare(
              "INSERT INTO quota_receipts(source,source_id,user_id,kind,created_at) VALUES('job',?,?,?,?)",
            )
            .run(`${id}:p${page}`, input.userId, input.kind, createdAt);
      return { job: this.get(id)!, reused: false };
    });
    if (!outcome.reused) this.pump();
    return outcome;
  }
  usedToday(userId: string, bucket: string) {
    const since = chinaDayStart(this.now().getTime());
    if (bucket === "chat" || bucket === "photos")
      return (
        this.store.db
          .prepare(
            `SELECT COUNT(*) AS n FROM quota_receipts r WHERE source=? AND user_id=? AND created_at>=? AND ${NOT_VOID}`,
          )
          .get(bucket === "chat" ? "chat" : "photo", userId, since) as {
          n: number;
        }
      ).n;
    const kinds = this.quotaKinds(bucket);
    if (!kinds.length) return 0;
    return (
      this.store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM quota_receipts r WHERE source='job' AND user_id=? AND created_at>=? AND ${NOT_VOID} AND kind IN (${kinds.map(() => "?").join(",")})`,
        )
        .get(userId, since, ...kinds) as { n: number }
    ).n;
  }
  // Whether quota checks are the yuan budget; its message then
  // already says what ran out and when it comes back.
  get budgeted() {
    return Boolean(this.options.budget);
  }
  // Before an AI action outside a quota bucket; no-op without a budget.
  checkBudget(userId: string, units = 1) {
    this.options.budget?.check(userId, units);
  }
  // How many of `units` pages may start now: all of them while the budget
  // allows (the crossing one may finish), else none; by count without one.
  available(userId: string, bucket: string, units: number) {
    if (this.options.budget)
      return this.options.budget.allows(userId, units) ? units : 0;
    const limit = this.limit(userId, bucket);
    return limit === undefined
      ? units
      : Math.max(0, limit - this.usedToday(userId, bucket));
  }
  // Also called before side effects that must not happen once the quota is used up.
  limit(userId: string, bucket: string) {
    return (
      this.options.limitFor?.(userId, bucket) ?? this.options.limits[bucket]
    );
  }
  checkQuota(userId: string, bucket: string, units = 1) {
    this.validateQuotaUnits(units);
    if (this.options.budget) return this.options.budget.check(userId, units);
    const limit = this.limit(userId, bucket);
    if (limit !== undefined && this.usedToday(userId, bucket) + units > limit)
      throw new AppError(
        429,
        "DAILY_LIMIT",
        `今日额度已用完（${limit} 次），明天再试`,
      );
  }
  private validateQuotaUnits(units: number) {
    if (!Number.isSafeInteger(units) || units < 1)
      throw new AppError(400, "INVALID_QUOTA_UNITS", "任务额度数量无效");
    return units;
  }
  // Admin retry : a recent failed job runs again under the same id. Its
  // quota receipt already exists, so the learner is not charged a second time.
  // Only provider-side failures qualify; a newer identical job supersedes it.
  retryable(row: Record<string, unknown>) {
    return (
      row.status === "failed" &&
      RETRYABLE.test(String(row.error_code ?? "")) &&
      !String(row.params_hash).startsWith("deleted:") &&
      Date.parse(String(row.created_at)) >=
        this.now().getTime() - 7 * 86400_000 &&
      Boolean(this.handlers[String(row.kind)])
    );
  }
  retry(id: string) {
    const job = this.store.transaction(() => {
      const row = this.store.db
        .prepare("SELECT * FROM jobs WHERE id=?")
        .get(id) as Record<string, unknown> | undefined;
      if (!row) throw new AppError(404, "NOT_FOUND", "任务不存在");
      if (!this.retryable(row))
        throw new AppError(
          409,
          "NOT_RETRYABLE",
          "只有最近 7 天内因服务原因失败的任务可以重试",
        );
      if (
        this.store.db
          .prepare(
            "SELECT 1 FROM jobs WHERE user_id=? AND kind=? AND params_hash=? AND id<>? AND status IN ('queued','running','succeeded')",
          )
          .get(
            row.user_id as string,
            row.kind as string,
            row.params_hash as string,
            id,
          )
      )
        throw new AppError(
          409,
          "SUPERSEDED",
          "用户已经重新发起过同样的任务，无需重试",
        );
      this.store.db
        .prepare(
          "UPDATE jobs SET status='queued',result=NULL,error_code=NULL,error_message=NULL,started_at=NULL,finished_at=NULL WHERE id=? AND status='failed'",
        )
        .run(id);
      // The same receipts count again; failing again frees them again.
      this.store.db.prepare("DELETE FROM quota_voids WHERE job_id=?").run(id);
      return toJob(row);
    });
    this.pump();
    return job;
  }
  // After a restart, jobs that were mid-flight are marked unknown instead of
  // silently re-running them; each ends like any failure (receipts freed,
  // parent row reverted). Recent failures get onFail again, so rows a crash
  // or an older server left mid-step become retryable; the hooks only act on
  // rows still pointing at that job.
  recover() {
    const failure = { code: "INTERRUPTED", message: INTERRUPTED };
    for (const row of this.store.db
      .prepare("SELECT * FROM jobs WHERE status='running'")
      .all())
      this.store.transaction(() => {
        const job = toJob(row);
        this.store.db
          .prepare(
            "UPDATE jobs SET status='unknown',error_code=?,error_message=?,finished_at=? WHERE id=? AND status='running'",
          )
          .run(failure.code, failure.message, this.now().toISOString(), job.id);
        this.failed(job, failure, "unknown");
      });
    const since = new Date(this.now().getTime() - 7 * 86400_000).toISOString();
    for (const row of this.store.db
      .prepare(
        "SELECT * FROM jobs WHERE status IN ('failed','unknown') AND created_at>=? AND params_hash NOT LIKE 'deleted:%'",
      )
      .all(since)) {
      const job = toJob(row);
      if (this.handlers[job.kind]?.onFail)
        this.store.transaction(() =>
          this.failed(job, job.error ?? failure, job.status, false),
        );
    }
    this.pump();
  }
  // Frees the job's receipts (its own and the per-unit ones) and lets the
  // handler revert its parent row. A broken hook never keeps a job running.
  private failed(
    job: Job,
    failure: { code: string; message: string },
    status: JobStatus,
    free = true,
  ) {
    if (free)
      this.store.db
        .prepare(
          "INSERT OR IGNORE INTO quota_voids(source,source_id,user_id,job_id,created_at) SELECT source,source_id,user_id,?,? FROM quota_receipts WHERE source='job' AND (source_id=? OR source_id LIKE ? ESCAPE '\\')",
        )
        .run(
          job.id,
          this.now().toISOString(),
          job.id,
          `${job.id.replaceAll("_", "\\_")}:p%`,
        );
    try {
      this.handlers[job.kind]?.onFail?.(job, failure, status);
    } catch (error) {
      this.options.log?.(error, job);
    }
  }
  pump() {
    while (!this.stopping && this.active.size < this.options.concurrency) {
      const row = this.store.db
        .prepare(
          "SELECT * FROM jobs WHERE status='queued' AND (?=0 OR kind<>'import_scan_pdf') ORDER BY created_at,rowid LIMIT 1",
        )
        .get(this.scanActive ? 1 : 0);
      if (!row) return;
      const startedAt = this.now().toISOString();
      const claimed = this.store.db
        .prepare(
          "UPDATE jobs SET status='running',started_at=? WHERE id=? AND status='queued'",
        )
        .run(startedAt, row.id as string).changes;
      if (!claimed) continue;
      const job: Job = { ...toJob(row), status: "running", startedAt };
      const scan = job.kind === "import_scan_pdf";
      if (scan) this.scanActive = true;
      const task: Promise<void> = this.execute(job).finally(() => {
        this.active.delete(task);
        if (scan) this.scanActive = false;
        this.pump();
      });
      this.active.add(task);
    }
  }
  async idle() {
    while (this.active.size) await Promise.allSettled([...this.active]);
  }
  async stop() {
    this.stopping = true;
    for (const controller of this.controllers.values()) controller.abort();
    await this.idle();
  }
  // Content deletion keeps a scrubbed receipt but must stop an active provider
  // call and reject any late commit for that specific job.
  cancel(ids: readonly string[]) {
    for (const id of ids) this.controllers.get(id)?.abort();
  }
  // queued jobs nobody waits for any more end as failed before
  // they start (no provider call), freeing their receipts like any failure.
  // Running ones are left to cancel.
  drop(ids: readonly string[], failure: { code: string; message: string }) {
    for (const id of ids)
      this.store.transaction(() => {
        const row = this.store.db
          .prepare("SELECT * FROM jobs WHERE id=? AND status='queued'")
          .get(id);
        if (!row) return;
        this.finish(id, "failed", { error: failure });
        this.failed(toJob(row), failure, "failed");
      });
  }
  private finish(
    id: string,
    status: JobStatus,
    fields: { result?: unknown; error?: Job["error"]; usage?: unknown },
  ) {
    this.store.db
      .prepare(
        "UPDATE jobs SET status=?,result=?,error_code=?,error_message=?,usage=?,finished_at=? WHERE id=?",
      )
      .run(
        status,
        json(fields.result),
        fields.error?.code ?? null,
        fields.error?.message ?? null,
        json(fields.usage),
        this.now().toISOString(),
        id,
      );
  }
  private running(id: string) {
    return Boolean(
      this.store.db
        .prepare("SELECT 1 FROM jobs WHERE id=? AND status='running'")
        .get(id),
    );
  }
  private async execute(job: Job) {
    const handler = this.handlers[job.kind];
    const controller = new AbortController();
    let timeout: AbortSignal | undefined;
    let completedUsage: unknown;
    this.controllers.set(job.id, controller);
    try {
      const timeoutMs = this.timeoutFor(handler, job.params);
      timeout = AbortSignal.timeout(timeoutMs);
      if (!handler) throw new JobError("UNSUPPORTED_JOB", "不支持的任务类型");
      const signal = AbortSignal.any([controller.signal, timeout]);
      const { output, usage } = await withJobDeadline(
        Date.now() + timeoutMs,
        () =>
          handler.run(job, signal, (progress) =>
            this.progress.set(job.id, { ...progress }),
          ),
      );
      // Network usage survives a rejected/rolled-back commit. It describes the
      // same calls as any commit error metadata, so never add the two together.
      completedUsage = usage;
      this.store.transaction(() => {
        // The material (and with it this job) may have been deleted meanwhile.
        if (!this.running(job.id)) {
          // Content deletion leaves a scrubbed job row as the quota receipt.
          // If the provider still returned successfully, retain only its usage;
          // never restore the deleted params, result or terminal status.
          if (usage !== undefined)
            this.store.db
              .prepare("UPDATE jobs SET usage=COALESCE(usage,?) WHERE id=?")
              .run(json(usage), job.id);
          // The calls finished, so they are spent like the receipt.
          this.options.budget?.charge(job.userId, "job", job.id, usage);
          return;
        }
        const result = handler.commit ? handler.commit(job, output) : output;
        this.finish(job.id, "succeeded", { result, usage });
        // Only a succeeded job is charged : failures cost nothing.
        this.options.budget?.charge(job.userId, "job", job.id, usage);
      });
    } catch (error) {
      let status: JobStatus = "failed";
      let failure = { code: "JOB_FAILED", message: INTERRUPTED };
      if (controller.signal.aborted) {
        status = "unknown";
        failure = { code: "INTERRUPTED", message: INTERRUPTED };
      } else if (expected(error)) {
        status =
          error.billing === "unknown" && error.code !== "OUTPUT_TRUNCATED"
            ? "unknown"
            : "failed";
        // A handler's JobError already speaks to the user; provider errors
        // (timeouts, busy, bad output) get one calm line instead.
        failure = {
          code: error.code,
          message:
            error instanceof JobError
              ? error.message
              : /TIMEOUT$/.test(error.code)
                ? TIMED_OUT
                : /^(AI|OCR|JEV)_(UNAVAILABLE|BUSY|QUOTA|AUTH|NOT_CONFIGURED)$/.test(
                      error.code,
                    )
                  ? PROVIDER_DOWN
                  : INTERRUPTED,
        };
        // The user sees the plain message; keep the reason behind it in the server log.
        if (error.cause) this.options.log?.(error.cause, job);
      } else if (timeout?.aborted) {
        status = "unknown";
        failure = { code: "TIMEOUT", message: TIMED_OUT };
      } else this.options.log?.(error, job);
      try {
        this.store.transaction(() => {
          if (this.running(job.id)) {
            this.finish(job.id, status, {
              error: failure,
              usage:
                completedUsage ??
                (error as { usage?: unknown } | undefined)?.usage,
            });
            this.failed(job, failure, status);
          } else {
            const usage =
              completedUsage ??
              (error as { usage?: unknown } | undefined)?.usage;
            if (usage !== undefined)
              this.store.db
                .prepare("UPDATE jobs SET usage=COALESCE(usage,?) WHERE id=?")
                .run(json(usage), job.id);
          }
        });
      } catch (inner) {
        this.options.log?.(inner, job);
      }
    } finally {
      this.controllers.delete(job.id);
      this.progress.delete(job.id);
    }
  }
  private timeoutFor(
    handler: JobHandler | undefined,
    params: Record<string, unknown>,
  ) {
    const timeoutMs = handler?.timeoutMs?.(params) ?? this.options.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new Error("Job handler timeout must be a positive integer");
    return timeoutMs;
  }
}
