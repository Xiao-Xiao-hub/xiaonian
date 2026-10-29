import { createHash } from "node:crypto";
import { AppError } from "./domain.js";
import type { SqliteStore } from "./store.js";
import { costMicroyuan, creditsForExactCost, nonNegativeSafeInteger } from "./commercial-cost.js";
import { now as businessNow, type Clock } from "./time.js";

export type BucketKind = "free_day" | "free_week" | "free_month" | "plan_week" | "plan_total" | "wallet";
export type CreditSource = { name: string; buckets: string[] };
type FreeCostCap = { month: string; limitMicroyuan: number; microyuanPerCredit: number };
type Allocation = CreditSource & { credits: number; freeCostCap?: FreeCostCap };
type CallRow = {
  id: string; user_id: string; fingerprint: string; status: "held" | "settled" | "released";
  allocations: string; price: string; reserved_credits: number; cost_microyuan: number | null;
  exact_numerator: string | null; exact_denominator: string | null;
  microyuan_per_credit: number | null; charged_credits: number | null;
  remainder_before: string | null; remainder_after: string | null;
  overrun_credits: number | null;
};
const integer = (value: unknown, name: string) => Number(nonNegativeSafeInteger(value, name));
const signedInteger = (value: unknown, name: string) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new RangeError(`${name}超出安全整数范围`);
  return value;
};
const positive = (value: unknown, name: string) => {
  const result = integer(value, name);
  if (!result) throw new RangeError(`${name}必须大于零`);
  return result;
};
const key = (value: string) => {
  if (typeof value !== "string" || !value.length || value.length > 256)
    throw new TypeError("流水标识无效");
  return value;
};
const conflict = () => new AppError(409, "CREDIT_CONFLICT", "操作已处理，请刷新后查看");

/** Single-process SQLite accounting. Every check and monetary write shares
 * BEGIN IMMEDIATE; two HTTP requests or two DB connections cannot overspend.
 * A source may have multiple caps (free day + week, plan week + total). All
 * those buckets are debited together, but user consumption is counted once.
 */
export class CommercialLedger {
  constructor(private readonly store: SqliteStore, private readonly clock: Clock = businessNow) {}

  ensureBucket(input: {
    id: string; userId: string; kind: BucketKind; credits: number;
    startsAt: number; endsAt: number | null;
  }) {
    key(input.id);
    integer(input.credits, "额度");
    integer(input.startsAt, "开始时间");
    if (input.endsAt !== null && integer(input.endsAt, "结束时间") <= input.startsAt)
      throw new RangeError("结束时间必须晚于开始时间");
    return this.store.transaction(() => {
      const old = this.store.db.prepare("SELECT * FROM commercial_buckets WHERE id=?").get(input.id);
      if (old) {
        if (old.user_id !== input.userId || old.kind !== input.kind || old.grant_credits !== input.credits ||
            old.starts_at !== input.startsAt || old.ends_at !== input.endsAt) throw conflict();
        return;
      }
      this.store.db.prepare(
        "INSERT INTO commercial_buckets(id,user_id,kind,starts_at,ends_at,grant_credits,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(input.id, input.userId, input.kind, input.startsAt, input.endsAt, input.credits, this.clock().toISOString());
      this.entry(input.id, null, `grant:${input.id}`, "grant", input.credits);
    });
  }

  private entry(bucket: string, call: string | null, event: string, kind: string, delta: number) {
    if (!Number.isSafeInteger(delta)) throw new RangeError("流水超出安全整数范围");
    this.store.db.prepare(
      "INSERT INTO commercial_entries(bucket_id,call_id,event_key,kind,delta,created_at) VALUES(?,?,?,?,?,?)",
    ).run(bucket, call, event, kind, delta, this.clock().toISOString());
  }

  balance(bucketId: string): number {
    const row = this.store.db.prepare("SELECT COALESCE(SUM(delta),0) balance FROM commercial_entries WHERE bucket_id=?").get(bucketId)!;
    return integer(row.balance, "余额");
  }

  freeCostRemaining(month: string): number | null {
    const row = this.store.db.prepare("SELECT COUNT(*) n,COALESCE(SUM(delta),0) balance FROM commercial_free_entries WHERE month=?").get(month)!;
    return Number(row.n) === 0 ? null : signedInteger(row.balance, "全站免费成本剩余额度");
  }

  private freeEntry(month: string, call: string | null, event: string, kind: string, delta: number) {
    if (!Number.isSafeInteger(delta)) throw new RangeError("全站免费成本超出安全整数范围");
    this.store.db.prepare("INSERT INTO commercial_free_entries(month,call_id,event_key,kind,delta,created_at) VALUES(?,?,?,?,?,?)")
      .run(month, call, event, kind, delta, this.clock().toISOString());
  }

  private call(userId: string, id: string): CallRow | undefined {
    const row = this.store.db.prepare("SELECT * FROM commercial_calls WHERE id=? AND user_id=?").get(id, userId);
    return row as CallRow | undefined;
  }

  reserve(input: {
    id: string; userId: string; source: string; credits: number;
    sources: CreditSource[]; price: object; leaseMs: number; freeCostCap?: FreeCostCap;
  }): { id: string; status: CallRow["status"]; credits: number } {
    key(input.id); key(input.source);
    integer(input.credits, "预留额度");
    positive(input.leaseMs, "预留期限");
    if (input.freeCostCap) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.freeCostCap.month)) throw new TypeError("免费成本月份无效");
      integer(input.freeCostCap.limitMicroyuan, "全站免费成本上限");
      positive(input.freeCostCap.microyuanPerCredit, "免费成本换算率");
      if (input.sources.filter(source => source.name === "free").length > 1) throw new TypeError("免费来源重复");
    }
    const ids = input.sources.flatMap((source) => source.buckets);
    if (new Set(ids).size !== ids.length || input.sources.some((s) => !s.buckets.length))
      throw new TypeError("额度来源重复或为空");
    ids.forEach(key);
    const price = JSON.stringify(input.price);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      user: input.userId, source: input.source, credits: input.credits, sources: input.sources, price, freeCostCap: input.freeCostCap,
    })).digest("hex");
    return this.store.transaction(() => {
      const existing = this.store.db.prepare("SELECT * FROM commercial_calls WHERE id=?").get(input.id) as CallRow | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.user_id !== input.userId) throw conflict();
        return { id: input.id, status: existing.status, credits: existing.reserved_credits };
      }
      const now = this.clock().getTime();
      integer(now + input.leaseMs, "预留截止时间");
      let remaining = input.credits;
      const allocations: Allocation[] = [];
      if (input.freeCostCap && this.freeCostRemaining(input.freeCostCap.month) === null)
        this.freeEntry(input.freeCostCap.month, null, `grant:${input.freeCostCap.month}`, "grant", input.freeCostCap.limitMicroyuan);
      for (const source of input.sources) {
        let available = remaining;
        for (const id of source.buckets) {
          const row = this.store.db.prepare("SELECT * FROM commercial_buckets WHERE id=? AND user_id=?").get(id, input.userId);
          if (!row) throw new AppError(404, "CREDIT_BUCKET_MISSING", "额度记录不存在");
          const active = Number(row.starts_at) <= now && (row.ends_at === null || now < Number(row.ends_at));
          available = Math.min(available, active ? this.balance(id) : 0);
        }
        const cap = source.name === "free" ? input.freeCostCap : undefined;
        if (cap) available = Math.min(available, Math.max(0,
          Number(BigInt(this.freeCostRemaining(cap.month)!) / BigInt(cap.microyuanPerCredit))));
        if (available > 0) allocations.push({ ...source, credits: available, ...(cap ? { freeCostCap: cap } : {}) });
        remaining -= available;
      }
      if (remaining > 0) throw new AppError(429, "CREDIT_LIMIT", "可用额度不足，请稍后再试或查看额度");
      this.store.db.prepare(
        "INSERT INTO commercial_calls(id,user_id,fingerprint,source,price,allocations,reserved_credits,status,lease_until,created_at) VALUES(?,?,?,?,?,?,?,'held',?,?)",
      ).run(input.id, input.userId, fingerprint, input.source, price, JSON.stringify(allocations), input.credits, now + input.leaseMs, this.clock().toISOString());
      for (const allocation of allocations) {
        for (const bucket of allocation.buckets)
          this.entry(bucket, input.id, `reserve:${input.id}:${bucket}`, "reserve", -allocation.credits);
        if (allocation.freeCostCap) {
          const cap = allocation.freeCostCap;
          this.freeEntry(cap.month, input.id, `reserve:${input.id}`, "reserve", -integer(BigInt(allocation.credits) * BigInt(cap.microyuanPerCredit), "预留免费成本"));
        }
      }
      return { id: input.id, status: "held" as const, credits: input.credits };
    });
  }

  settle(userId: string, id: string, costMicroyuan: number, microyuanPerCredit: number) {
    integer(costMicroyuan, "实际成本"); positive(microyuanPerCredit, "积分换算率");
    return this.settleExact(userId, id, BigInt(costMicroyuan), 1n, microyuanPerCredit);
  }

  settleExact(
    userId: string,
    id: string,
    numerator: bigint,
    denominator: bigint,
    microyuanPerCredit: number,
  ) {
    if (typeof numerator !== "bigint" || numerator < 0n) throw new TypeError("成本分子必须是非负 BigInt");
    if (typeof denominator !== "bigint" || denominator <= 0n) throw new TypeError("成本分母必须是正 BigInt");
    positive(microyuanPerCredit, "积分换算率");
    const numeratorText = numerator.toString();
    const denominatorText = denominator.toString();
    const displayCost = integer(costMicroyuan(numerator, denominator), "实际成本");
    return this.store.transaction(() => {
      const call = this.call(userId, id);
      // Account deletion cascades receipts. A late response must not recreate it.
      if (!call || call.status === "released") return null;
      const price = JSON.parse(call.price) as { microyuanPerCredit?: number };
      if (price.microyuanPerCredit !== undefined && price.microyuanPerCredit !== microyuanPerCredit)
        throw conflict();
      if (call.status === "settled") {
        if (call.exact_numerator !== numeratorText || call.exact_denominator !== denominatorText ||
            call.microyuan_per_credit !== microyuanPerCredit) throw conflict();
        return { charged: call.charged_credits!, overrun: call.overrun_credits! };
      }
      const previous = this.store.db.prepare(
        "SELECT remainder_after FROM commercial_calls WHERE user_id=? AND status='settled' AND exact_denominator=? AND microyuan_per_credit=? AND remainder_after IS NOT NULL ORDER BY settlement_seq DESC LIMIT 1",
      ).get(userId, denominatorText, microyuanPerCredit) as { remainder_after: string } | undefined;
      const remainder = previous ? BigInt(previous.remainder_after) : 0n;
      const converted = creditsForExactCost(numerator, denominator, remainder, BigInt(microyuanPerCredit));
      const requested = integer(converted.credits, "实际积分");
      const charged = Math.min(call.reserved_credits, requested);
      let left = charged;
      for (const allocation of JSON.parse(call.allocations) as Allocation[]) {
        const used = Math.min(left, allocation.credits);
        left -= used;
        for (const bucket of allocation.buckets)
          this.entry(bucket, id, `settle:${id}:${bucket}`, "settle", allocation.credits - used);
        if (allocation.freeCostCap) {
          const cap = allocation.freeCostCap;
          const held = integer(BigInt(allocation.credits) * BigInt(cap.microyuanPerCredit), "预留免费成本");
          this.freeEntry(cap.month, id, `settle:${id}`, "settle", held - Math.min(held, displayCost));
        }
      }
      this.store.db.prepare(
        "UPDATE commercial_calls SET status='settled',settlement_seq=(SELECT COALESCE(MAX(settlement_seq),0)+1 FROM commercial_calls),cost_microyuan=?,exact_numerator=?,exact_denominator=?,microyuan_per_credit=?,charged_credits=?,remainder_delta=NULL,remainder_before=?,remainder_after=?,overrun_credits=?,finished_at=? WHERE id=?",
      ).run(displayCost, numeratorText, denominatorText, microyuanPerCredit, charged, remainder.toString(),
        converted.remainderNumerator.toString(), requested - charged, this.clock().toISOString(), id);
      return { charged, overrun: requested - charged };
    });
  }

  private finalizeFreeRelease(call: CallRow, incurredCostMicroyuan: number | undefined) {
    if (incurredCostMicroyuan === undefined) return;
    integer(incurredCostMicroyuan, "已发生成本");
    for (const allocation of JSON.parse(call.allocations) as Allocation[]) {
      if (!allocation.freeCostCap) continue;
      const cap = allocation.freeCostCap;
      const held = integer(BigInt(allocation.credits) * BigInt(cap.microyuanPerCredit), "预留免费成本");
      const delta = held - incurredCostMicroyuan;
      const event = `release:${call.id}`;
      const existing = this.store.db.prepare("SELECT delta FROM commercial_free_entries WHERE event_key=?")
        .get(event) as { delta: number } | undefined;
      if (existing) {
        if (existing.delta !== delta || (call.cost_microyuan !== null && call.cost_microyuan !== incurredCostMicroyuan))
          throw conflict();
      } else {
        this.freeEntry(cap.month, call.id, event, incurredCostMicroyuan === 0 ? "release" : "settle", delta);
      }
    }
    if (call.cost_microyuan !== null && call.cost_microyuan !== incurredCostMicroyuan) throw conflict();
    this.store.db.prepare("UPDATE commercial_calls SET cost_microyuan=? WHERE id=?")
      .run(incurredCostMicroyuan, call.id);
  }

  private releaseHeld(call: CallRow, incurredCostMicroyuan: number | undefined) {
    for (const allocation of JSON.parse(call.allocations) as Allocation[]) {
      for (const bucket of allocation.buckets)
        this.entry(bucket, call.id, `release:${call.id}:${bucket}`, "release", allocation.credits);
    }
    this.finalizeFreeRelease(call, incurredCostMicroyuan);
    this.store.db.prepare("UPDATE commercial_calls SET status='released',finished_at=? WHERE id=?")
      .run(this.clock().toISOString(), call.id);
  }

  release(userId: string, id: string, incurredCostMicroyuan?: number) {
    if (incurredCostMicroyuan !== undefined) integer(incurredCostMicroyuan, "已发生成本");
    return this.store.transaction(() => {
      const call = this.call(userId, id);
      if (call?.status === "held") this.releaseHeld(call, incurredCostMicroyuan);
      else if (call?.status === "released") this.finalizeFreeRelease(call, incurredCostMicroyuan);
    });
  }

  /** Run on startup and periodically. A late completion cannot spend after its
   * reservation was released. Network operations must have shorter deadlines. */
  releaseExpired() {
    return this.store.transaction(() => {
      const rows = this.store.db.prepare("SELECT * FROM commercial_calls WHERE status='held' AND lease_until<=?")
        .all(this.clock().getTime()) as CallRow[];
      // Expired work cannot charge the learner's free pool. Merchant exposure
      // is retained by the independent daily safety ledger.
      for (const row of rows) this.releaseHeld(row, 0);
      return rows.length;
    });
  }
}
