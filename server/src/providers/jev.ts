/*
 * 判断服务客户端：封装概率判断、候选选择等接口，供判题、分类和筛查使用。
 * 只处理请求、响应和错误；判断阈值及失败后如何展示，由调用它的业务模块决定。
 */
import { setTimeout as realSleep } from "node:timers/promises";
import { z } from "zod";
import { bindCallContext } from "../shared/call-context.js";
import type { CommercialMeter } from "../shared/commercial-meter.js";
import type { UsageMeter } from "../shared/usage-ledger.js";
import { boundedResponseText } from "./response-limits.js";
import { checkInputComplexity } from "../shared/request-safety.js";

export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

/** Probability of "yes", 0–1. */
export type JevNoulAnswer = { noul: number };
/** `probabilities` is keyed by criteria label. */
export type JevChoiceAnswer = {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};
/**
 * `score` is an expected rubric index (may be fractional); `probabilities` is keyed by index ("0", "1",...).
 */
export type JevScoreAnswer = {
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
};
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;
export type JevAnswerFor<Q extends JevQuestion> = Q extends { type: "noul" }
  ? JevNoulAnswer
  : Q extends { type: "choice" }
    ? JevChoiceAnswer
    : JevScoreAnswer;
export type JevAnswers<Q extends Record<string, JevQuestion>> = {
  [K in keyof Q]: JevAnswerFor<Q[K]>;
};
export type BackgroundJev = Pick<Jev, "noul" | "choice">;

export type JevErrorCode =
  | "JEV_NOT_CONFIGURED"
  | "JEV_TIMEOUT"
  | "JEV_UNAVAILABLE"
  | "JEV_AUTH"
  | "JEV_BUSY"
  | "JEV_BAD_OUTPUT";

const messages: Record<JevErrorCode, string> = {
  JEV_NOT_CONFIGURED: "判断服务未配置（缺少 API Key）",
  JEV_TIMEOUT: "判断服务响应超时，请稍后重试",
  JEV_UNAVAILABLE: "判断服务暂时不可用，请稍后重试",
  JEV_AUTH: "判断服务鉴权失败，请检查 API Key",
  JEV_BUSY: "判断服务繁忙，请稍后重试",
  JEV_BAD_OUTPUT: "判断服务返回的结果格式不正确",
};

export class JevError extends Error {
  readonly code: JevErrorCode;
  /** "unknown": the request may have reached the model and been billed. */
  readonly billing: "none" | "unknown";
  readonly detail: string | undefined;

  constructor(code: JevErrorCode, detail?: string, cause?: unknown) {
    super(messages[code], { cause });
    this.name = "JevError";
    this.code = code;
    this.billing = ["JEV_TIMEOUT", "JEV_UNAVAILABLE", "JEV_BAD_OUTPUT"].includes(code) ? "unknown" : "none";
    this.detail = detail;
  }
}

const prob = z.number().min(0).max(1);
const probs = z.record(prob);
const noulSchema = z.object({ type: z.literal("noul").optional(), noul: prob });
const choiceSchema = z.object({
  type: z.literal("choice").optional(),
  choice: z.string(),
  confidence: prob,
  probabilities: probs,
});
const scoreSchema = z.object({
  type: z.literal("score").optional(),
  score: z.number().finite(),
  confidence: prob,
  probabilities: probs,
});
const responseSchema = z.object({ answers: z.record(z.unknown()) });

function parseAnswer(id: string, q: JevQuestion, raw: unknown): JevAnswer {
  const bad = (why: string) =>
    new JevError("JEV_BAD_OUTPUT", `answer "${id}": ${why}`);
  if (q.type === "noul") {
    const r = noulSchema.safeParse(raw);
    if (!r.success) throw bad(r.error.message);
    return { noul: r.data.noul };
  }
  if (q.type === "choice") {
    const r = choiceSchema.safeParse(raw);
    if (!r.success) throw bad(r.error.message);
    if (!Object.hasOwn(q.criteria, r.data.choice))
      throw bad(`unknown choice "${r.data.choice}"`);
    const { choice, confidence, probabilities } = r.data;
    return { choice, confidence, probabilities };
  }
  const r = scoreSchema.safeParse(raw);
  if (!r.success) throw bad(r.error.message);
  if (r.data.score < 0 || r.data.score > q.criteria.length - 1)
    throw bad(`score ${r.data.score} out of range`);
  const { score, confidence, probabilities } = r.data;
  return { score, confidence, probabilities };
}

export type JevOptions = {
  apiKey?: string;
  // Answers the same questions with another model instead of the Jev API
  // (Jev is not reachable from the production region).
  answer?: (
    request: { state: unknown; questions: Record<string, JevQuestion> },
    signal?: AbortSignal,
  ) => Promise<unknown>;
  baseUrl?: string;
  // Answers with another model when the Jev API itself fails (not on aborts).
  fallback?: JevOptions["answer"];
  model?: string;
  timeoutMs: number;
  usageMeter?: UsageMeter;
  commercialMeter?: Pick<CommercialMeter, "run"> & Partial<Pick<CommercialMeter, "action">>;
};

const RETRY_DELAYS_MS = [500, 1500];

type BackgroundEntry<T> = {
  run: (judge: BackgroundJev) => Promise<T>;
  signal: AbortSignal | undefined;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  removeAbortListener: () => void;
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export class Jev {
  private readonly apiKey: string | undefined;
  private readonly url: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly usageMeter: UsageMeter | undefined;
  private readonly commercialMeter: (Pick<CommercialMeter, "run"> & Partial<Pick<CommercialMeter, "action">>) | undefined;
  private foregroundCalls = 0;
  private foregroundWaiters = 0;
  private backgroundActive: Promise<void> | undefined;
  private readonly backgroundQueue: BackgroundEntry<unknown>[] = [];

  constructor(
    opts: JevOptions,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      realSleep(ms),
  ) {
    this.apiKey = opts.apiKey || undefined;
    this.answer = opts.answer;
    this.fallback = opts.fallback;
    this.url = `${(opts.baseUrl ?? "https://api.typesafe.ai").replace(/\/+$/, "")}/v1/systemone`;
    this.model = opts.model ?? "jev-1.13.0";
    this.timeoutMs = opts.timeoutMs;
    this.usageMeter = opts.usageMeter;
    this.commercialMeter = opts.commercialMeter;
  }

  private readonly answer: JevOptions["answer"];
  private readonly fallback: JevOptions["fallback"];

  get configured(): boolean {
    return this.answer !== undefined || this.apiKey !== undefined;
  }

  async ask<Q extends Record<string, JevQuestion>>(
    state: unknown,
    questions: Q,
    signal?: AbortSignal,
  ): Promise<JevAnswers<Q>> {
    if (this.foregroundWaiters + this.foregroundCalls >= 32)
      throw new JevError("JEV_BUSY");
    this.foregroundWaiters += 1;
    let admitted = false;
    try {
      await this.waitForBackground(signal);
      this.foregroundWaiters -= 1;
      admitted = true;
      this.foregroundCalls += 1;
      return await this.askNow(state, questions, signal);
    } finally {
      if (admitted) this.foregroundCalls -= 1;
      else this.foregroundWaiters -= 1;
      this.pumpBackground();
    }
  }

  /**
   * Runs low-priority work after foreground requests. The callback receives direct
   * judges so its own calls do not enter this queue again.
   *
   */
  background<T>(
    run: (judge: BackgroundJev) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.backgroundQueue.length >= 32) return Promise.reject(new JevError("JEV_BUSY"));

    return new Promise<T>((resolve, reject) => {
      const entry: BackgroundEntry<T> = {
        run: bindCallContext((judge) => this.commercialMeter?.action
          ? this.commercialMeter.action(() => run(judge)) : run(judge)),
        signal,
        resolve,
        reject,
        removeAbortListener: () => undefined,
      };
      if (signal) {
        const onAbort = () => {
          const index = this.backgroundQueue.indexOf(entry as BackgroundEntry<unknown>);
          if (index >= 0) this.backgroundQueue.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }
      this.backgroundQueue.push(entry as BackgroundEntry<unknown>);
      this.pumpBackground();
    });
  }

  private async askNow<Q extends Record<string, JevQuestion>>(
    state: unknown,
    questions: Q,
    signal?: AbortSignal,
  ): Promise<JevAnswers<Q>> {
    let json: unknown;
    const answer = this.answer;
    if (answer) {
      try {
        json = await answer({ state, questions }, signal);
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        throw new JevError(
          "JEV_UNAVAILABLE",
          err instanceof Error ? err.message : String(err),
          err,
        );
      }
    } else {
      if (!this.apiKey) throw new JevError("JEV_NOT_CONFIGURED");
      const body = JSON.stringify({ state, model: this.model, questions });
      let transportParsed = false;
      try {
        const invoke = async () => {
          const text = await this.send(this.apiKey!, body, signal);
          let result: unknown;
          try {
            result = JSON.parse(text);
          } catch (err) {
            throw new JevError("JEV_BAD_OUTPUT", "response is not JSON", err);
          }
          try { checkInputComplexity(result); }
          catch (error) { throw new JevError("JEV_BAD_OUTPUT", "response complexity limit exceeded", error); }
          transportParsed = true;
          return this.parseAnswers(result, questions);
        };
        return this.commercialMeter
          ? await this.commercialMeter.run(
              {
                kind: "jev",
                provider: new URL(this.url).host,
                model: this.model,
                source: "jev",
              },
              invoke,
              () => ({ requests: 1 }),
              signal,
            )
          : await invoke();
      } catch (err) {
        if (transportParsed || !this.fallback || signal?.aborted || !(err instanceof JevError))
          throw err;
        try {
          json = await this.fallback({ state, questions }, signal);
        } catch {
          if (signal?.aborted) throw signal.reason;
          throw err;
        }
      }
    }
    return this.parseAnswers(json, questions);
  }

  private parseAnswers<Q extends Record<string, JevQuestion>>(
    json: unknown,
    questions: Q,
  ): JevAnswers<Q> {
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success)
      throw new JevError("JEV_BAD_OUTPUT", "response has no answers object");

    const out: Record<string, JevAnswer> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (!Object.hasOwn(parsed.data.answers, id))
        throw new JevError("JEV_BAD_OUTPUT", `missing answer "${id}"`);
      out[id] = parseAnswer(id, q, parsed.data.answers[id]);
    }
    return out as JevAnswers<Q>;
  }

  private async waitForBackground(signal?: AbortSignal): Promise<void> {
    const active = this.backgroundActive;
    if (!active) return;

    let removeAbortListener: () => void = () => {};
    const aborted = signal
      ? new Promise<void>((_, reject) => {
          if (signal.aborted) reject(abortReason(signal));
          else {
            const onAbort = () => reject(abortReason(signal));
            signal.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () => signal.removeEventListener("abort", onAbort);
          }
        })
      : undefined;
    try {
      // Each backfill turn owns its two-second deadline; queue waiting does not
      // spend it or admit foreground work before that turn has actually ended.
      await Promise.race([active, ...(aborted ? [aborted] : [])]);
    } finally {
      removeAbortListener();
    }
  }

  private pumpBackground(): void {
    if (this.backgroundActive || this.foregroundCalls > 0 || this.foregroundWaiters > 0) return;
    const entry = this.backgroundQueue.shift();
    if (!entry) return;
    if (entry.signal?.aborted) {
      entry.removeAbortListener();
      entry.reject(abortReason(entry.signal));
      this.pumpBackground();
      return;
    }
    entry.removeAbortListener();

    const judge: BackgroundJev = {
      noul: (state, instructions, signal) => this.noulNow(state, instructions, signal),
      choice: (state, instructions, criteria, signal) =>
        this.choiceNow(state, instructions, criteria, signal),
    };
    let active: Promise<void>;
    active = Promise.resolve()
      .then(() => entry.run(judge))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        entry.removeAbortListener();
        if (this.backgroundActive === active) this.backgroundActive = undefined;
        this.pumpBackground();
      });
    this.backgroundActive = active;
  }

  async noul(
    state: unknown,
    instructions: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const { q } = await this.ask(
      state,
      { q: { type: "noul", instructions } },
      signal,
    );
    return q.noul;
  }

  private async noulNow(
    state: unknown,
    instructions: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const { q } = await this.askNow(
      state,
      { q: { type: "noul", instructions } },
      signal,
    );
    return q.noul;
  }

  async choice(
    state: unknown,
    instructions: string,
    criteria: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<JevChoiceAnswer> {
    const { q } = await this.ask(
      state,
      { q: { type: "choice", instructions, criteria } },
      signal,
    );
    return q;
  }

  private async choiceNow(
    state: unknown,
    instructions: string,
    criteria: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<JevChoiceAnswer> {
    const { q } = await this.askNow(
      state,
      { q: { type: "choice", instructions, criteria } },
      signal,
    );
    return q;
  }

  /** POST with retries on 429/529; returns the 2xx body text. */
  private async send(
    apiKey: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const { status, text } = await this.attempt(apiKey, body, signal);
      if (status >= 200 && status < 300) return text;
      if (status === 401 || status === 403)
        throw new JevError("JEV_AUTH", `HTTP ${status}`);
      if (status === 429 || status === 529) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined)
          throw new JevError("JEV_BUSY", `HTTP ${status}`);
        await this.sleep(delay);
        signal?.throwIfAborted();
        continue;
      }
      // 5xx and unexpected 4xx (e.g. 400/422) alike: the service could not answer.
      throw new JevError(
        "JEV_UNAVAILABLE",
        `HTTP ${status}: ${text.slice(0, 200)}`,
      );
    }
  }

  private async attempt(apiKey: string, body: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const finishUsage = this.usageMeter?.start({
      source: "jev",
      provider: new URL(this.url).host,
      model: this.model,
    });
    try {
      const res = await this.fetcher(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const text = await boundedResponseText(res);
      finishUsage?.({ status: res.ok ? "succeeded" : "failed" });
      return { status: res.status, text };
    } catch (err) {
      finishUsage?.({ status: "unknown" });
      if (signal?.aborted) throw signal.reason;
      if (timeout.aborted)
        throw new JevError(
          "JEV_TIMEOUT",
          `no response within ${this.timeoutMs}ms`,
          err,
        );
      throw new JevError(
        "JEV_UNAVAILABLE",
        err instanceof Error ? err.message : String(err),
        err,
      );
    }
  }
}
