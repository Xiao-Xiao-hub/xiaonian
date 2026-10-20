/*
 * 调用消耗总账：记录提供商请求状态、用量及耗时，供管理台核对。
 * 记录消耗与删除用户内容是两条流程；总账不得为了补记而重新发送一次外部请求。
 */
import type { SqliteStore } from "./store.js";
import { now as businessNow, type Clock } from "./time.js";

export type UsageStart = {
  source: "llm.json" | "llm.stream" | "llm.test" | "jev" | "ocr.tencent";
  provider: string;
  model: string;
  // The admin alias of the AI endpoint that took the call, when routed.
  endpoint?: string;
  scene?: string;
};
export type UsageEnd = {
  status: "succeeded" | "failed" | "unknown";
  promptTokens?: unknown;
  completionTokens?: unknown;
  cachedTokens?: unknown;
};
export type UsageMeter = {
  start(input: UsageStart): (result: UsageEnd) => void;
};

const tokenCount = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

// An operational ledger, deliberately without user, material, job, request id,
// prompt, response, file path or credential. Deleting learner data cannot erase
// consumed provider calls. Each network attempt has its own row, including retries.
export class UsageLedger implements UsageMeter {
  private writeFailures = 0;
  get accountingWriteFailures() {
    return this.writeFailures;
  }
  constructor(
    private readonly store: SqliteStore,
    private readonly clock: Clock = businessNow,
  ) {
    store.db
      .prepare(
        "UPDATE usage_ledger SET status='unknown' WHERE status='pending'",
      )
      .run();
  }

  start(input: UsageStart) {
    const started = Date.now();
    // Record before sending: a crash or interrupted stream remains observable.
    // If the database cannot record an attempt, do not start an unmetered call.
    const row = this.store.db
      .prepare(
        "INSERT INTO usage_ledger(source,provider,model,endpoint,scene,status,created_at) VALUES(?,?,?,?,?,'pending',?)",
      )
      .run(
        input.source,
        input.provider.slice(0, 128),
        input.model.slice(0, 128),
        input.endpoint?.slice(0, 64) ?? null,
        input.scene?.slice(0, 64) ?? null,
        this.clock().toISOString(),
      );
    let complete = false;
    return (result: UsageEnd) => {
      if (complete) return;
      // Completion is best-effort after the network call: preserve the original
      // pending receipt if persistence fails, and expose a fixed counter for
      // operations. Never let a provider catch replace known usage with unknown,
      // retry a paid call, or mask a successfully generated answer.
      complete = true;
      try {
        this.store.db
          .prepare(
            "UPDATE usage_ledger SET status=?,prompt_tokens=?,completion_tokens=?,cached_tokens=?,duration_ms=?,finished_at=? WHERE id=?",
          )
          .run(
            result.status,
            tokenCount(result.promptTokens),
            tokenCount(result.completionTokens),
            tokenCount(result.cachedTokens),
            Math.max(0, Date.now() - started),
            this.clock().toISOString(),
            row.lastInsertRowid,
          );
      } catch {
        this.writeFailures++;
      }
    };
  }
}
