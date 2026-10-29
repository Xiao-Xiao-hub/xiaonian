import { createHash, randomUUID } from "node:crypto";
import { runWithCallContext } from "../../shared/call-context.js";
import { AppError } from "../../shared/domain.js";
import type { SqliteStore } from "../../shared/store.js";
import { SupportGate, UNRESOLVED, type SupportGateResult } from "./gate.js";
import { SUPPORT_KNOWLEDGE } from "./knowledge.js";
import { BANNED_PHRASES } from "../safety/banned-phrases.js";

const MINUTE_MS = 60_000;
const BEIJING_OFFSET_MS = 8 * 60 * MINUTE_MS;
const MAX_TURNS = 10;
const MAX_ANSWER_CHARS = 400;

export const SUPPORT_FAQS = Object.freeze(
  [
    ...SUPPORT_KNOWLEDGE.filter(({ id }) => id !== "ticket").slice(0, 6),
    SUPPORT_KNOWLEDGE.find(({ id }) => id === "ticket")!,
  ].map(({ id, title, answer }) => ({ id, title, answer })),
);

const FALLBACK =
  "这次没能可靠回答。可以换个说法再问，或先看下面的常见问题。";
const TICKET_HINT = "可以提交工单，人工会在 3 天内回复。";
// Turns that can never count toward or open a ticket.
const NO_TICKET_LAYERS = new Set(["reject", "injection", "crisis", "limit"]);
// Turns that show the session is about Xiaonian support, so a short
// "still not working" can be answered with that context. An ambiguous
// (clarify) judgment is not enough.
const SUPPORTED_LAYERS = ["answer", "account", "generate", "fallback"];
const MINUTE_RATE_LIMITED =
  "这分钟的客服消息有点多，请稍后再试。你也可以先选择下面的常见问题。";
const DAY_RATE_LIMITED =
  "今天的客服消息已到上限，请明天再试。你也可以先选择下面的常见问题。";
const GENERATED_UNSAFE = /(jev|glm|智谱|混元|火山|豆包|typesafe|bigmodel|deepseek|qwen|通义|文心|kimi|gpt|claude|openai|anthropic|\bflash\b)/i;
const GENERATED_PROMISE = /保证.{0,8}(?:退款|补偿|到账)|(?:一定|必定).{0,8}(?:退款|补偿|到账)/g;
const RECOVERED =
  "上一条客服请求未能确认完成，为避免重复调用已停止重试。你可以选择常见问题，或重新描述问题。";

// A negation earlier in the same clause ("不一定能补偿", "不会保证退款",
// "无法向你保证退款") or inside the match ("保证不了退款") is a disclaimer.
const PROMISE_NEGATED_BEFORE = /(?:无法|不能|不会|没法|没办法|难以|未必|不敢|并不|不可能|不)(?:向|对|给)?(?:你|您)?\s*$/;
const hasGeneratedPromise = (answer: string) => {
  for (const match of answer.matchAll(GENERATED_PROMISE)) {
    const before = answer.slice(0, match.index);
    if (PROMISE_NEGATED_BEFORE.test(before) || /不|无法|没法/.test(match[0])) continue;
    return true;
  }
  return false;
};

/** One unresolved signal: the user says it is still not solved or asks for
 * a person, or a supported question could not be answered (generation
 * failure, cost cap). Rejected, crisis and rate-limited turns never count. */
const unresolvedSignal = (text: string, layer: string, answer: string) =>
  !NO_TICKET_LAYERS.has(layer) &&
  ((layer === "fallback" && answer !== RECOVERED) || UNRESOLVED.test(text));

export type SupportAccountSnapshot = Readonly<{
  quotaSummary: string;
  planSummary: string;
  walletBalance: number | null;
  orders: readonly Readonly<{
    id: string;
    productName: string;
    status: string;
    platform: string | null;
    amountCents: number;
    paidAt: string | null;
  }>[];
  lastFailure: string | null;
}>;

export type SupportGeneratorAccount = Readonly<{
  quotaSummary: string;
  planSummary: string;
  walletBalance: number | null;
  orders: readonly Readonly<{
    productName: string;
    status: string;
    platform: string | null;
    amountCents: number;
    paidAt: string | null;
  }>[];
  lastFailure: string | null;
}>;

export type SupportAccountReader =
  | ((
      userId: string,
    ) => Promise<SupportAccountSnapshot> | SupportAccountSnapshot)
  | {
      read(
        userId: string,
      ): Promise<SupportAccountSnapshot> | SupportAccountSnapshot;
    };

export type SupportGeneratorInput = Readonly<{
  text: string;
  context: readonly Readonly<{ user: string; assistant: string }>[];
  knowledge: readonly Readonly<{ title: string; answer: string }>[];
  account: SupportGeneratorAccount | null;
  maxChars: number;
}>;

export type SupportGenerator = {
  generate(
    input: SupportGeneratorInput,
  ): Promise<Readonly<{ answer: string; confident: boolean }>>;
};

export type SupportReply = Readonly<{
  sessionId: string;
  turnId: string;
  answer: string;
  layer: string;
  ticketEligible: boolean;
  duplicate: boolean;
  resourcePath: string | null;
  faqs: typeof SUPPORT_FAQS;
}>;

export type SupportSessionDetail = Readonly<{
  id: string;
  turnCount: number;
  maxTurns: number;
  turns: readonly Readonly<{
    id: string;
    text: string;
    answer: string;
    layer: string;
    ticketEligible: boolean;
    resourcePath: string | null;
  }>[];
}>;

export type SupportCostLimits = Readonly<{
  dailyCapMicroyuan: number;
  judgeUpperMicroyuan: number;
  generateUpperMicroyuan: number;
}>;

type CostKind = "judge" | "generate";
type CostReservation = Readonly<{
  retain(): void;
  releaseNotStarted(): void;
}>;

const safeNonNegativeInteger = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name}必须是非负安全整数`);
  return value;
};

const beijingDay = (time: number) =>
  new Date(time + BEIJING_OFFSET_MS).toISOString().slice(0, 10);

const beijingDayStart = (time: number) => {
  const shifted = new Date(time + BEIJING_OFFSET_MS);
  return Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ) - BEIJING_OFFSET_MS;
};

/** A conservative support-only cost ceiling. A started call retains its full
 * configured upper bound; only an explicitly not-started call releases it.
 * CommercialMeter remains the source of actual operational cost records. */
export class SupportCostGuard {
  private lastLimitLog = -Infinity;
  constructor(
    private readonly store: SqliteStore,
    private readonly configured:
      | SupportCostLimits
      | (() => SupportCostLimits),
    private readonly now: () => number = Date.now,
    private readonly onLimit?: () => void,
  ) {
    // A process exit may have happened after a provider accepted the request.
    // Keeping the whole hold is the only safe recovery without provider usage.
    this.store.db
      .prepare(
        "UPDATE support_cost_holds SET status='retained',finished_at=? WHERE status='held'",
      )
      .run(this.store.now());
  }

  private limits(): SupportCostLimits {
    const limits =
      typeof this.configured === "function"
        ? this.configured()
        : this.configured;
    return {
      dailyCapMicroyuan: safeNonNegativeInteger(
        limits.dailyCapMicroyuan,
        "客服每日成本上限",
      ),
      judgeUpperMicroyuan: safeNonNegativeInteger(
        limits.judgeUpperMicroyuan,
        "客服判断成本上限",
      ),
      generateUpperMicroyuan: safeNonNegativeInteger(
        limits.generateUpperMicroyuan,
        "客服生成成本上限",
      ),
    };
  }

  private limited() {
    const at = this.now();
    if (at - this.lastLimitLog >= 60_000) {
      this.lastLimitLog = at;
      this.onLimit?.();
    }
    return null;
  }

  reserve(id: string, kind: CostKind): CostReservation | null {
    const limits = this.limits();
    const upper =
      kind === "judge"
        ? limits.judgeUpperMicroyuan
        : limits.generateUpperMicroyuan;
    if (limits.dailyCapMicroyuan === 0 || upper === 0) return this.limited();
    const day = beijingDay(this.now());
    const accepted = this.store.transaction(() => {
      const existing = this.store.db
        .prepare("SELECT * FROM support_cost_holds WHERE id=?")
        .get(id) as
        | {
            day: string;
            kind: string;
            reserved_microyuan: number;
            status: string;
          }
        | undefined;
      if (existing) {
        if (
          existing.day !== day ||
          existing.kind !== kind ||
          Number(existing.reserved_microyuan) !== upper
        )
          throw new AppError(
            409,
            "SUPPORT_COST_CONFLICT",
            "客服成本预留冲突",
          );
        return existing.status !== "released";
      }
      const used = Number(
        (
          this.store.db
            .prepare(
              "SELECT COALESCE(SUM(reserved_microyuan),0) AS n FROM support_cost_holds WHERE day=? AND status IN('held','retained')",
            )
            .get(day) as { n: number }
        ).n,
      );
      if (used + upper > limits.dailyCapMicroyuan) return false;
      this.store.db
        .prepare(
          "INSERT INTO support_cost_holds(id,day,kind,reserved_microyuan,status,created_ms) VALUES(?,?,?,?,'held',?)",
        )
        .run(id, day, kind, upper, this.now());
      return true;
    });
    if (!accepted) return this.limited();
    let finished = false;
    const finish = (status: "retained" | "released") => {
      if (finished) return;
      finished = true;
      this.store.db
        .prepare(
          "UPDATE support_cost_holds SET status=?,finished_at=? WHERE id=? AND status='held'",
        )
        .run(status, this.store.now(), id);
    };
    return Object.freeze({
      retain: () => finish("retained"),
      releaseNotStarted: () => finish("released"),
    });
  }
}

type RequestRow = {
  id: string;
  session_id: string;
  user_id: string;
  idempotency_key: string;
  text_hash: string;
  raw_text: string;
  status: "processing" | "completed";
  turn_id: string | null;
  position: number | null;
  answer: string | null;
  layer: string | null;
  ticket_eligible: number | null;
  resource_path: string | null;
  duplicate: number;
  created_ms: number;
};

type Limits = Readonly<{
  perMinute: number;
  perDay: number;
  duplicateWindowMs: number;
}>;

type Claimed = Readonly<{
  requestId: string;
  turnId: string;
  position: number;
}>;

const requestId = () => `scr_${randomUUID().replaceAll("-", "")}`;
const turnId = () => `sturn_${randomUUID().replaceAll("-", "")}`;
const sessionId = () => `ss_${randomUUID().replaceAll("-", "")}`;
const hashText = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const accountQuestion = (text: string) =>
  /(?:我的|我还有|我当前).{0,8}(?:额度|积分|余额|套餐|到期|订单|失败)|(?:额度|积分|余额|套餐|订单).{0,8}(?:还有多少|剩多少|状态|到期)/.test(
    text,
  );

const ORDER_STATUS: Readonly<Record<string, string>> = Object.freeze({
  created: "待支付",
  paid: "已支付，待到账",
  delivered: "已到账",
  refunding: "退款处理中",
  refunded: "已退款",
  closed: "已关闭",
});

const accountAnswer = (account: SupportAccountSnapshot) => {
  const wallet =
    account.walletBalance === null
      ? "暂时没有可显示的积分余额"
      : `积分余额 ${account.walletBalance}`;
  const recent = account.orders[0];
  const order = recent
    ? `最近订单“${recent.productName}”状态：${ORDER_STATUS[recent.status] ?? "未知"}`
    : "暂无订单";
  const failure = account.lastFailure ?? "最近的使用都已完成";
  return [
    account.quotaSummary || "暂时无法读取额度",
    account.planSummary || "暂时无法读取套餐",
    wallet,
    order,
    failure,
  ].map(part => part.replace(/[。；\s]+$/u, "")).join("；") + "。";
};

const validIdempotencyKey = (value: string) =>
  /^[A-Za-z0-9_-]{8,64}$/.test(value);

export class SupportService {
  private readonly offlineGate = new SupportGate();
  private readonly now: () => number;
  private readonly inFlightRequests = new Map<string, Promise<SupportReply>>();

  constructor(
    private readonly store: SqliteStore,
    private readonly deps: {
      gate: Pick<SupportGate, "check">;
      generator?: SupportGenerator;
      accountReader?: SupportAccountReader;
      costGuard?: SupportCostGuard;
      limits?: Partial<Limits> | (() => Partial<Limits>);
      now?: () => number;
    },
  ) {
    this.now = deps.now ?? Date.now;
    this.limits();
    this.recoverInflight();
  }

  private limits(): Limits {
    const configured = typeof this.deps.limits === "function"
      ? this.deps.limits()
      : (this.deps.limits ?? {});
    const limits = {
      perMinute: configured.perMinute ?? 6,
      perDay: configured.perDay ?? 30,
      duplicateWindowMs: configured.duplicateWindowMs ?? 60_000,
    };
    for (const [value, name] of [
      [limits.perMinute, "客服每分钟限额"],
      [limits.perDay, "客服每日限额"],
      [limits.duplicateWindowMs, "客服重复窗口"],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError(`${name}必须是正安全整数`);
    }
    if (limits.perMinute > limits.perDay)
      throw new RangeError("客服每分钟限额不能高于每日限额");
    return limits;
  }

  createSession(userId: string) {
    if (!this.store.getUser(userId))
      throw new AppError(401, "SESSION_EXPIRED", "登录状态已失效");
    const id = sessionId();
    const now = this.store.now();
    this.store.db
      .prepare("INSERT INTO support_sessions VALUES(?,?,0,?,?)")
      .run(id, userId, now, now);
    return { id, turnCount: 0, maxTurns: MAX_TURNS } as const;
  }

  detail(userId: string, id: string): SupportSessionDetail {
    const session = this.store.db
      .prepare(
        "SELECT id,turn_count FROM support_sessions WHERE id=? AND user_id=?",
      )
      .get(id, userId) as { id: string; turn_count: number } | undefined;
    if (!session)
      throw new AppError(
        404,
        "SUPPORT_SESSION_NOT_FOUND",
        "客服会话不存在",
      );
    const turns = this.store.db
      .prepare(
        `SELECT t.id,t.raw_text,t.answer,t.layer,t.ticket_eligible,
                (SELECT r.resource_path FROM support_chat_requests r
                  WHERE r.turn_id=t.id ORDER BY r.duplicate,r.created_ms LIMIT 1) AS resource_path
           FROM support_session_turns m
           JOIN support_turns t ON t.id=m.turn_id
          WHERE m.session_id=? ORDER BY m.position`,
      )
      .all(id) as Array<Record<string, unknown>>;
    return {
      id: session.id,
      turnCount: Number(session.turn_count),
      maxTurns: MAX_TURNS,
      turns: turns.map((row) => ({
        id: String(row.id),
        text: String(row.raw_text),
        answer: String(row.answer),
        layer: String(row.layer),
        ticketEligible: Number(row.ticket_eligible) === 1,
        resourcePath:
          row.resource_path === null ? null : String(row.resource_path),
      })),
    };
  }

  async send(
    userId: string,
    id: string,
    input: { text: string; idempotencyKey: string },
  ): Promise<SupportReply> {
    if (
      typeof input.text !== "string" ||
      input.text.length > 200 ||
      !validIdempotencyKey(input.idempotencyKey)
    )
      throw new AppError(400, "SUPPORT_MESSAGE_INVALID", "客服消息无效");
    const text = input.text.trim();
    const textHash = hashText(text);
    const now = this.now();
    const limits = this.limits();
    const result = this.store.transaction(() => {
      const session = this.store.db
        .prepare(
          "SELECT turn_count FROM support_sessions WHERE id=? AND user_id=?",
        )
        .get(id, userId) as { turn_count: number } | undefined;
      if (!session)
        throw new AppError(
          404,
          "SUPPORT_SESSION_NOT_FOUND",
          "客服会话不存在",
        );
      const existing = this.store.db
        .prepare(
          "SELECT * FROM support_chat_requests WHERE user_id=? AND idempotency_key=?",
        )
        .get(userId, input.idempotencyKey) as RequestRow | undefined;
      if (existing) {
        if (existing.session_id !== id || existing.raw_text !== text)
          throw new AppError(
            409,
            "SUPPORT_IDEMPOTENCY_CONFLICT",
            "幂等键已用于其他客服消息",
          );
        return existing.status === "completed"
          ? ({ kind: "reply", reply: this.reply(existing) } as const)
          : ({ kind: "processing", requestId: existing.id } as const);
      }
      const request = requestId();
      this.store.db
        .prepare(
          `INSERT INTO support_chat_requests(
             id,session_id,user_id,idempotency_key,text_hash,raw_text,status,created_ms,created_at
           ) VALUES(?,?,?,?,?,?,'processing',?,?)`,
        )
        .run(
          request,
          id,
          userId,
          input.idempotencyKey,
          textHash,
          text,
          now,
          this.store.now(),
        );
      const minuteCount = Number(
        (
          this.store.db
            .prepare(
              "SELECT COUNT(*) AS n FROM support_chat_requests WHERE user_id=? AND created_ms>?",
            )
            .get(userId, now - MINUTE_MS) as { n: number }
        ).n,
      );
      const dayCount = Number(
        (
          this.store.db
            .prepare(
              "SELECT COUNT(*) AS n FROM support_chat_requests WHERE user_id=? AND created_ms>=?",
            )
            .get(userId, beijingDayStart(now)) as { n: number }
        ).n,
      );
      const recent = this.store.db
        .prepare(
          `SELECT * FROM support_chat_requests
            WHERE user_id=? AND session_id=? AND text_hash=? AND id<>?
              AND status='completed' AND layer<>'limit' AND turn_id IS NOT NULL AND created_ms>=?
            ORDER BY created_ms DESC LIMIT 1`,
        )
        .get(
          userId,
          id,
          textHash,
          request,
          now - limits.duplicateWindowMs,
        ) as RequestRow | undefined;
      if (recent) {
        this.copyReply(request, recent);
        return {
          kind: "reply",
          reply: { ...this.reply({ ...recent, duplicate: 1 }), duplicate: true },
        } as const;
      }
      const processing = this.store.db
        .prepare(
          `SELECT * FROM support_chat_requests
            WHERE user_id=? AND session_id=? AND text_hash=? AND id<>?
              AND status='processing' AND turn_id IS NOT NULL AND created_ms>=?
            ORDER BY created_ms DESC LIMIT 1`,
        )
        .get(
          userId,
          id,
          textHash,
          request,
          now - limits.duplicateWindowMs,
        ) as RequestRow | undefined;
      if (processing)
        return {
          kind: "wait",
          requestId: request,
          sourceRequestId: processing.id,
        } as const;
      if (Number(session.turn_count) >= MAX_TURNS)
        throw new AppError(
          409,
          "SUPPORT_SESSION_LIMIT",
          "本次客服会话已达到 10 轮，请新建会话",
        );
      if (minuteCount > limits.perMinute || dayCount > limits.perDay) {
        const reply = this.persistLimited(
          userId,
          id,
          text,
          request,
          minuteCount > limits.perMinute ? MINUTE_RATE_LIMITED : DAY_RATE_LIMITED,
        );
        return { kind: "reply", reply } as const;
      }
      const position = Number(session.turn_count) + 1;
      const turn = turnId();
      this.store.db
        .prepare(
          "UPDATE support_sessions SET turn_count=?,updated_at=? WHERE id=? AND user_id=? AND turn_count=?",
        )
        .run(position, this.store.now(), id, userId, session.turn_count);
      this.store.db
        .prepare(
          "UPDATE support_chat_requests SET turn_id=?,position=? WHERE id=? AND status='processing'",
        )
        .run(turn, position, request);
      const claim = { requestId: request, turnId: turn, position };
      return { kind: "claimed", claim } as const;
    });
    if (result.kind === "reply") return result.reply;
    if (result.kind === "processing") {
      const pending = this.inFlightRequests.get(result.requestId);
      if (pending) return pending;
      this.recoverRequest(result.requestId);
      const recovered = this.request(result.requestId);
      if (!recovered || recovered.status !== "completed")
        throw new AppError(409, "SUPPORT_REQUEST_PENDING", "客服请求仍在处理中");
      return this.reply(recovered);
    }
    if (result.kind === "wait") {
      let original: SupportReply;
      const pending = this.inFlightRequests.get(result.sourceRequestId);
      if (pending) original = await pending;
      else {
        this.recoverRequest(result.sourceRequestId);
        const source = this.request(result.sourceRequestId);
        if (!source || source.status !== "completed")
          throw new AppError(
            409,
            "SUPPORT_REQUEST_PENDING",
            "客服请求仍在处理中",
          );
        original = this.reply(source);
      }
      return this.store.transaction(() => {
        const row = this.request(result.requestId);
        if (!row)
          throw new AppError(
            404,
            "SUPPORT_SESSION_NOT_FOUND",
            "客服会话不存在",
          );
        this.store.db
          .prepare(
            "UPDATE support_chat_requests SET turn_id=?,position=NULL,answer=?,layer=?,ticket_eligible=?,resource_path=?,duplicate=1,status='completed',finished_at=? WHERE id=? AND status='processing'",
          )
          .run(
            original.turnId,
            original.answer,
            original.layer,
            original.ticketEligible ? 1 : 0,
            original.resourcePath,
            this.store.now(),
            result.requestId,
          );
        return { ...original, duplicate: true };
      });
    }
    const claim = result.claim;
    const pending = this.process(userId, id, text, claim);
    this.inFlightRequests.set(claim.requestId, pending);
    try {
      return await pending;
    } finally {
      this.inFlightRequests.delete(claim.requestId);
    }
  }

  private async process(
    userId: string,
    id: string,
    text: string,
    claim: Claimed,
  ): Promise<SupportReply> {
    let gate: SupportGateResult;
    let judged = true;
    const options = { followUp: this.hasSupportedTurn(id) };
    const judge = this.reserveCost(
      `${claim.requestId}:judge`,
      "judge",
    );
    if (!judge) {
      judged = false;
      gate = await this.offlineGate.check(text, options);
    } else {
      try {
        gate = await runWithCallContext({ source: "support" }, () => this.deps.gate.check(text, options));
        if (gate.remoteUsed) judge.retain();
        else judge.releaseNotStarted();
      } catch {
        judge.retain();
        judged = false;
        gate = await this.offlineGate.check(text, options);
      }
    }
    // A support-worded question that could not be judged (cost cap or judge
    // failure) is an unanswered question, not a request to rephrase.
    if (!judged && gate.layer === "clarify")
      return this.persist(userId, id, text, claim, FALLBACK, "fallback", null);
    if (gate.layer !== "generate") {
      if (gate.layer === "answer" && accountQuestion(text)) {
        try {
          if (!this.deps.accountReader) throw new Error("account reader absent");
          const account = await this.readAccount(userId);
          return this.persist(
            userId,
            id,
            text,
            claim,
            accountAnswer(account),
            "account",
            null,
          );
        } catch {
          return this.persist(
            userId,
            id,
            text,
            claim,
            FALLBACK,
            "fallback",
            null,
          );
        }
      }
      return this.persist(
        userId,
        id,
        text,
        claim,
        gate.message,
        gate.intent === "injection" ? "injection" : gate.layer,
        gate.resourcePath ?? null,
      );
    }
    const generate = this.reserveCost(
      `${claim.requestId}:generate`,
      "generate",
    );
    if (!generate)
      return this.persist(
        userId,
        id,
        text,
        claim,
        FALLBACK,
        "fallback",
        null,
      );
    if (!this.deps.generator) {
      generate.releaseNotStarted();
      return this.persist(
        userId,
        id,
        text,
        claim,
        FALLBACK,
        "fallback",
        null,
      );
    }
    let account: SupportGeneratorAccount | null = null;
    try {
      const snapshot = this.deps.accountReader
        ? await this.readAccount(userId)
        : null;
      account = snapshot
        ? {
            quotaSummary: snapshot.quotaSummary,
            planSummary: snapshot.planSummary,
            walletBalance: snapshot.walletBalance,
            orders: snapshot.orders.slice(0, 3).map(({ id: _id, ...order }) =>
              order,
            ),
            lastFailure: snapshot.lastFailure,
          }
        : null;
    } catch {
      account = null;
    }
    try {
      const generated = await runWithCallContext({ source: "support" }, () =>
        this.deps.generator!.generate({
          text,
          context: this.context(id),
          knowledge: SUPPORT_KNOWLEDGE.map(({ title, answer }) => ({
            title,
            answer,
          })),
          account,
          maxChars: MAX_ANSWER_CHARS,
        }),
      );
      generate.retain();
      const answer = generated.answer.trim();
      if (
        !generated.confident ||
        !answer ||
        answer.length > MAX_ANSWER_CHARS ||
        BANNED_PHRASES.some(phrase => answer.includes(phrase)) ||
        GENERATED_UNSAFE.test(answer) ||
        hasGeneratedPromise(answer)
      )
        return this.persist(
          userId,
          id,
          text,
          claim,
          FALLBACK,
          "fallback",
          null,
        );
      return this.persist(
        userId,
        id,
        text,
        claim,
        answer,
        "generate",
        null,
      );
    } catch (error) {
      if ((error as { billing?: unknown } | null)?.billing === "none")
        generate.releaseNotStarted();
      else generate.retain();
      return this.persist(
        userId,
        id,
        text,
        claim,
        FALLBACK,
        "fallback",
        null,
      );
    }
  }

  private context(id: string) {
    const rows = this.store.db
      .prepare(
        `SELECT t.raw_text,t.answer
           FROM support_session_turns m
           JOIN support_turns t ON t.id=m.turn_id
          WHERE m.session_id=? ORDER BY m.position DESC LIMIT 3`,
      )
      .all(id) as Array<{ raw_text: string; answer: string }>;
    return rows.reverse().map((row) => ({
      user: row.raw_text,
      assistant: row.answer,
    }));
  }

  private hasSupportedTurn(id: string) {
    return Boolean(this.store.db
      .prepare(
        `SELECT 1 FROM support_session_turns m JOIN support_turns t ON t.id=m.turn_id
          WHERE m.session_id=? AND t.layer IN (${SUPPORTED_LAYERS.map(() => "?").join(",")}) LIMIT 1`,
      )
      .get(id, ...SUPPORTED_LAYERS));
  }

  /** Signals already recorded in this session's conversation turns. */
  private priorSignals(id: string) {
    const rows = this.store.db
      .prepare(
        `SELECT t.raw_text,t.layer,t.answer FROM support_session_turns m
           JOIN support_turns t ON t.id=m.turn_id WHERE m.session_id=?`,
      )
      .all(id) as Array<{ raw_text: string; layer: string; answer: string }>;
    return rows.filter(row =>
      unresolvedSignal(String(row.raw_text), String(row.layer), String(row.answer))).length;
  }

  private readAccount(userId: string) {
    const reader = this.deps.accountReader;
    if (!reader) throw new Error("account reader absent");
    return typeof reader === "function" ? reader(userId) : reader.read(userId);
  }

  private reserveCost(id: string, kind: CostKind) {
    try {
      return this.deps.costGuard?.reserve(id, kind) ?? null;
    } catch {
      // Invalid or unavailable runtime pricing must fail closed before remote
      // work. The persisted turn still receives the fixed FAQ fallback.
      return null;
    }
  }

  private persist(
    userId: string,
    id: string,
    text: string,
    claim: Claimed,
    rawAnswer: string,
    layer: string,
    resourcePath: string | null,
  ): SupportReply {
    return this.store.transaction(() => {
      const request = this.request(claim.requestId);
      if (!request)
        throw new AppError(
          404,
          "SUPPORT_SESSION_NOT_FOUND",
          "客服会话不存在",
        );
      if (request.status === "completed") return this.reply(request);
      // The ticket entry opens only on a turn that is itself unresolved and
      // brings the session to at least two unresolved signals.
      const ticketEligible = unresolvedSignal(text, layer, rawAnswer) &&
        this.priorSignals(id) + 1 >= 2;
      const answer = ticketEligible
        ? `${rawAnswer}${/[。！？!?]$/.test(rawAnswer) ? "" : "。"}${TICKET_HINT}`
        : rawAnswer;
      const createdAt = this.store.now();
      this.store.db
        .prepare("INSERT INTO support_turns VALUES(?,?,?,?,?,?,?)")
        .run(
          claim.turnId,
          userId,
          text,
          answer,
          layer,
          ticketEligible ? 1 : 0,
          createdAt,
        );
      this.store.db
        .prepare("INSERT INTO support_session_turns VALUES(?,?,?)")
        .run(id, claim.turnId, claim.position);
      this.store.db
        .prepare(
          "UPDATE support_chat_requests SET status='completed',answer=?,layer=?,ticket_eligible=?,resource_path=?,finished_at=? WHERE id=? AND status='processing'",
        )
        .run(
          answer,
          layer,
          ticketEligible ? 1 : 0,
          resourcePath,
          createdAt,
          claim.requestId,
        );
      return {
        sessionId: id,
        turnId: claim.turnId,
        answer,
        layer,
        ticketEligible,
        duplicate: false,
        resourcePath,
        faqs: SUPPORT_FAQS,
      };
    });
  }

  /** Rate-limit replies remain idempotent and rate-counted, but never consume
   * one of the ten conversation positions. They are deliberately not restored
   * in the session transcript after a refresh. */
  private persistLimited(
    userId: string,
    sessionId: string,
    text: string,
    requestId: string,
    answer: string,
  ): SupportReply {
    const id = turnId();
    const createdAt = this.store.now();
    this.store.db
      .prepare("INSERT INTO support_turns VALUES(?,?,?,?,?,?,?)")
      .run(id, userId, text, answer, "limit", 0, createdAt);
    this.store.db
      .prepare(
        "UPDATE support_chat_requests SET turn_id=?,answer=?,layer='limit',ticket_eligible=0,resource_path=NULL,status='completed',finished_at=? WHERE id=? AND status='processing'",
      )
      .run(id, answer, createdAt, requestId);
    return {
      sessionId,
      turnId: id,
      answer,
      layer: "limit",
      ticketEligible: false,
      duplicate: false,
      resourcePath: null,
      faqs: SUPPORT_FAQS,
    };
  }

  private copyReply(id: string, source: RequestRow) {
    this.store.db
      .prepare(
        "UPDATE support_chat_requests SET status='completed',turn_id=?,answer=?,layer=?,ticket_eligible=?,resource_path=?,duplicate=1,finished_at=? WHERE id=? AND status='processing'",
      )
      .run(
        source.turn_id,
        source.answer,
        source.layer,
        source.ticket_eligible,
        source.resource_path,
        this.store.now(),
        id,
      );
  }

  private reply(row: RequestRow): SupportReply {
    if (
      row.status !== "completed" ||
      !row.turn_id ||
      row.answer === null ||
      row.layer === null ||
      row.ticket_eligible === null
    )
      throw new AppError(409, "SUPPORT_REQUEST_PENDING", "客服请求仍在处理中");
    return {
      sessionId: row.session_id,
      turnId: row.turn_id,
      answer: row.answer,
      layer: row.layer,
      ticketEligible: row.ticket_eligible === 1,
      duplicate: row.duplicate === 1,
      resourcePath: row.resource_path,
      faqs: SUPPORT_FAQS,
    };
  }

  private request(id: string) {
    return this.store.db
      .prepare("SELECT * FROM support_chat_requests WHERE id=?")
      .get(id) as RequestRow | undefined;
  }

  private recoverInflight() {
    const rows = this.store.db
      .prepare(
        "SELECT * FROM support_chat_requests WHERE status='processing' ORDER BY position IS NULL,created_ms,id",
      )
      .all() as RequestRow[];
    for (const row of rows) this.recoverRequest(row.id);
    return rows.length;
  }

  private recoverRequest(id: string) {
    this.store.transaction(() => {
      const row = this.request(id);
      if (!row || row.status !== "processing") return;
      if (!row.turn_id || row.position === null) {
        const source = this.store.db
          .prepare(
            `SELECT * FROM support_chat_requests
              WHERE user_id=? AND session_id=? AND text_hash=? AND id<>?
                AND status='completed' AND layer<>'limit' AND turn_id IS NOT NULL AND created_ms<=?
              ORDER BY created_ms DESC LIMIT 1`,
          )
          .get(
            row.user_id,
            row.session_id,
            row.text_hash,
            row.id,
            row.created_ms,
          ) as RequestRow | undefined;
        if (source) this.copyReply(row.id, source);
        return;
      }
      const session = this.store.db
        .prepare("SELECT 1 FROM support_sessions WHERE id=? AND user_id=?")
        .get(row.session_id, row.user_id);
      if (!session) return;
      this.store.db
        .prepare("INSERT OR IGNORE INTO support_turns VALUES(?,?,?,?,?,?,?)")
        .run(
          row.turn_id,
          row.user_id,
          row.raw_text,
          RECOVERED,
          "fallback",
          0,
          this.store.now(),
        );
      this.store.db
        .prepare(
          "INSERT OR IGNORE INTO support_session_turns VALUES(?,?,?)",
        )
        .run(row.session_id, row.turn_id, row.position);
      this.store.db
        .prepare(
          "UPDATE support_chat_requests SET status='completed',answer=?,layer='fallback',ticket_eligible=0,resource_path=NULL,finished_at=? WHERE id=? AND status='processing'",
        )
        .run(RECOVERED, this.store.now(), row.id);
    });
  }
}
