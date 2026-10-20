/*
 * 兼容聊天接口客户端：负责请求格式、流式响应、结构化输出校验和调用用量。
 * 业务提示词由各领域模块提供；这里把网络错误转成统一错误，不直接写用户学习数据。
 * 协议字段、客户端标识和提供商兼容参数属于运行要求，修改时应验证实际接口兼容性。
 */
import type { output, ZodTypeAny } from "zod";
import { jobStreamMs } from "../shared/job-deadline.js";
import type { UsageEnd, UsageMeter } from "../shared/usage-ledger.js";

// Fixed client identity; the sub2api codex_cli_only whitelist matches it.
const CLIENT_HEADERS = { "user-agent": "zhiye-server/1.0", originator: "zhiye_server" };

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
};
export type LlmUsage = {
  provider: string;
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  scene?: string;
  finishReason?: string;
  ms: number;
  // the tokens are an estimate (see estimateTokens).
  estimated?: boolean;
};
// Where a call comes from; each has its own thinking level. "recheck"
// is a second, reasoning pass after the program found a conflict.
export const SCENARIOS = [
  "chat.study", "chat.life", "chat.mood", "card_tidy", "import_split",
  "brainstorm", "map_stuck", "vision", "recheck", "study", "judge",
] as const;
export type CanonicalScenario = (typeof SCENARIOS)[number];
export type Scenario = CanonicalScenario | "ask" | "notes" | "photo";
export const normalizeScenario = (scenario: Scenario): CanonicalScenario =>
  scenario === "ask" ? "chat.study" : scenario === "notes" ? "card_tidy" :
    scenario === "photo" ? "vision" : scenario;
export type LlmRequestOptions = {
  scenario?: Scenario;
  maxTokens?: number;
  jsonRetries?: 0 | 1;
  truncateAsError?: boolean;
};
type StreamHandlers = {
  onText: (piece: string) => void;
  onThinking?: (piece: string) => void;
};
export type StreamOptions = LlmRequestOptions & {
  signal?: AbortSignal; idleMs?: number; maxMs?: number;
  jsonMode?: boolean;
};
export type JsonProgress = { chars: number; expect: number; thinking?: boolean };
export type StreamJsonOptions = StreamOptions & {
  expect: number;
  onProgress?: (progress: JsonProgress) => void;
};
// What services call: one ChatModel, or the router's client for a scenario.
// `scenario` overrides the client's own for one call (e.g. "recheck").
export type LlmClient = {
  readonly configured: boolean;
  readonly model: string;
  json<S extends ZodTypeAny>(
    messages: ChatMessage[],
    schema: S,
    signal?: AbortSignal,
    options?: LlmRequestOptions,
  ): Promise<{ data: output<S>; usage: LlmUsage }>;
  stream(
    messages: ChatMessage[],
    handlers: StreamHandlers,
    options?: StreamOptions,
  ): Promise<{ text: string; usage: LlmUsage }>;
  streamJson?<S extends ZodTypeAny>(
    messages: ChatMessage[], schema: S, options: StreamJsonOptions,
  ): Promise<{ data: output<S>; usage: LlmUsage }>;
};
// billing "unknown": the request may have reached the provider and been charged.
export class ProviderError extends Error {
  constructor(
    public code: string,
    message: string,
    public billing: "none" | "unknown" = "none",
  ) {
    super(message);
  }
}
export type ChatOptions = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  extraBody: Record<string, unknown>;
  // Thinking tokens count toward max_tokens, so callers' limits get this on top.
  thinkingTokens?: number;
  timeoutMs: number;
  usageMeter?: UsageMeter;
  // Admin alias recorded in the usage ledger; `test` marks admin test calls.
  endpoint?: string;
  test?: boolean;
  scenario?: Scenario;
};
// Failures before the request left this machine; retrying cannot double-bill.
const CONNECT_ERRORS = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const connectFailed = (error: unknown) =>
  CONNECT_ERRORS.has(
    String((error as { cause?: { code?: unknown } })?.cause?.code ?? ""),
  );
// Out of credit, for providers that answer 400/401/403/429 instead of 402.
const QUOTA =
  /insufficient[_ ]?(quota|balance)|quota[_ ]?exceeded|exceeded your current quota|billing_hard_limit|arrearage|account ?overdue|余额|欠费|额度不足/i;
// Classifies a non-2xx answer; nothing was generated, so billing stays "none".
export function statusError(status: number, body: string): ProviderError {
  if (status === 402 || QUOTA.test(body.slice(0, 2048)))
    return new ProviderError("AI_QUOTA", "AI 服务额度不足，请联系管理员");
  if (status === 401 || status === 403)
    return new ProviderError("AI_AUTH", "AI 服务凭证无效，请联系管理员");
  if (status === 429)
    return new ProviderError("AI_BUSY", "AI 服务繁忙，请稍后重试");
  return new ProviderError("AI_UNAVAILABLE", "AI 服务暂时不可用，请稍后重试");
}
const parseBody = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
  } catch {
    return undefined;
  }
};
// OpenAI-compatible usage shape; each real endpoint's cache field still needs
// protocol verification. Missing or invalid counts remain unknown, not zero.
type TokenUsage = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown };
};
const cachedTokens = (usage?: TokenUsage): number | undefined => {
  const value = usage?.prompt_tokens_details?.cached_tokens;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : undefined;
};
// a call whose provider reports no token usage is still charged,
// by estimate: every 2 characters of the request's text and of the reply
// (thinking included) count as one token, rounded up. Images and hidden
// tokens are not counted, so the estimate stays below what the provider
// bills. The usage ledger keeps such calls' counts unknown (NULL); the admin
// to-do list counts them.
export const estimateTokens = (text: string) =>
  Math.ceil(Array.from(text).length / 2);
const requestText = (messages: ChatMessage[]) =>
  messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    )
    .join("");
const reported = (usage?: TokenUsage) =>
  typeof usage?.prompt_tokens === "number" ||
  typeof usage?.completion_tokens === "number";
// OpenAI-compatible chat endpoint: JSON mode for structured results, streaming for chat.
export class ChatModel {
  constructor(
    readonly opts: ChatOptions,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  get configured() {
    return Boolean(this.opts.apiKey);
  }
  get model() {
    return this.opts.model;
  }
  private scene(options: LlmRequestOptions) {
    const scene = options.scenario ?? this.opts.scenario;
    return scene ? normalizeScenario(scene) : undefined;
  }
  private requestBody(options: StreamOptions) {
    if (options.maxTokens !== undefined &&
      (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1))
      throw new Error("maxTokens must be a positive integer");
    return {
      ...(options.maxTokens === undefined
        ? {}
        : { max_tokens: options.maxTokens + (this.opts.thinkingTokens ?? 0) }),
      ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
    };
  }
  // Parse only after the stream is complete; progress is content length, never
  // an invented phase. A corrective JSON attempt is separately metered.
  async streamJson<S extends ZodTypeAny>(
    messages: ChatMessage[], schema: S, options: StreamJsonOptions,
  ): Promise<{ data: output<S>; usage: LlmUsage }> {
    const usage: LlmUsage = {
      provider: new URL(this.opts.baseUrl).host, model: this.opts.model,
      calls: 0, promptTokens: 0, completionTokens: 0, ms: 0,
      ...(this.scene(options) ? { scene: this.scene(options) } : {}),
    };
    const merge = (next: LlmUsage) => {
      usage.calls += next.calls;
      usage.promptTokens += next.promptTokens;
      usage.completionTokens += next.completionTokens;
      usage.ms += next.ms;
      if (next.cachedTokens !== undefined)
        usage.cachedTokens = (usage.cachedTokens ?? 0) + next.cachedTokens;
      if (next.finishReason !== undefined) usage.finishReason = next.finishReason;
      else delete usage.finishReason;
      if (next.estimated) usage.estimated = true;
    };
    const retries = options.jsonRetries ?? (this.scene(options) === "map_stuck" ? 0 : 1);
    for (let attempt = 0; attempt <= retries; attempt++) {
      let current = "";
      options.onProgress?.({ chars: 0, expect: options.expect });
      let result: { text: string; usage: LlmUsage };
      try {
        result = await this.stream(
          attempt ? [...messages, {
            role: "user", content: "上一次输出无法使用。请严格按要求只输出一个 JSON 对象。",
          }] : messages,
          {
            onText: (piece) => {
              current += piece;
              options.onProgress?.({ chars: Array.from(current).length, expect: options.expect });
            },
            onThinking: () => options.onProgress?.({
              chars: Array.from(current).length, expect: options.expect, thinking: true,
            }),
          },
          { ...options, jsonMode: true, truncateAsError: true },
        );
      } catch (error) {
        const failedUsage = (error as { usage?: LlmUsage })?.usage;
        if (failedUsage) merge(failedUsage);
        if (error instanceof ProviderError) Object.assign(error, { usage });
        throw error;
      }
      merge(result.usage);
      const checked = schema.safeParse(parseJson(result.text));
      if (checked.success) return { data: checked.data as output<S>, usage };
    }
    throw Object.assign(new ProviderError(
      "AI_BAD_OUTPUT", "AI 返回的内容格式不对，请重试", "unknown",
    ), { usage });
  }
  // One corrective retry when the output is not valid JSON for the schema.
  async json<S extends ZodTypeAny>(
    messages: ChatMessage[],
    schema: S,
    signal?: AbortSignal,
    options: LlmRequestOptions = {},
  ): Promise<{ data: output<S>; usage: LlmUsage }> {
    if (!this.opts.apiKey)
      throw new ProviderError("AI_NOT_CONFIGURED", "AI 这会儿用不了，过会儿再试");
    const started = Date.now();
    const usage: LlmUsage = {
      provider: new URL(this.opts.baseUrl).host,
      model: this.opts.model,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      ms: 0,
      ...(this.scene(options) ? { scene: this.scene(options) } : {}),
    };
    let problem = "";
    const retries = options.jsonRetries ?? (this.scene(options) === "map_stuck" ? 0 : 1);
    for (let attempt = 0; attempt <= retries; attempt++) {
      const content = await this.complete(
        attempt
          ? [
              ...messages,
              {
                role: "user",
                content: `上一次输出无法使用（${problem}）。请严格按要求只输出一个 JSON 对象。`,
              },
            ]
          : messages,
        usage,
        signal,
        options,
      );
      usage.ms = Date.now() - started;
      const parsed = parseJson(content);
      if (parsed === undefined) {
        problem = "不是合法的 JSON";
        continue;
      }
      const result = schema.safeParse(parsed);
      if (result.success) return { data: result.data as output<S>, usage };
      problem = result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "根"}: ${i.message}`)
        .join("；");
    }
    throw Object.assign(
      new ProviderError("AI_BAD_OUTPUT", "AI 返回的内容格式不对，请重试"),
      { usage },
    );
  }
  // Plain-text reply streamed piece by piece; reasoning pieces go to `onThinking`.
  async stream(
    messages: ChatMessage[],
    handlers: StreamHandlers,
    options: StreamOptions = {},
  ): Promise<{ text: string; usage: LlmUsage }> {
    if (!this.opts.apiKey)
      throw new ProviderError("AI_NOT_CONFIGURED", "AI 这会儿用不了，过会儿再试");
    const started = Date.now();
    const usage: LlmUsage = {
      provider: new URL(this.opts.baseUrl).host,
      model: this.opts.model,
      calls: 1,
      promptTokens: 0,
      completionTokens: 0,
      ms: 0,
      ...(this.scene(options) ? { scene: this.scene(options) } : {}),
    };
    // Long answers are fine as long as pieces keep arriving.
    const idle = new AbortController();
    const idleMs = options.idleMs ?? 45000;
    let timer = setTimeout(() => idle.abort(), idleMs);
    const poke = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(), idleMs);
    };
    // Inside a job the cap follows the job's remaining time.
    const cap = AbortSignal.timeout(options.maxMs ?? jobStreamMs() ?? 240000);
    const signals = [
      idle.signal,
      cap,
      ...(options.signal ? [options.signal] : []),
    ];
    let text = "";
    let thought = "";
    let received = false;
    let finishUsage: ((result: UsageEnd) => void) | undefined;
    let outcome: UsageEnd["status"] = "unknown";
    let reportedPrompt: unknown;
    let reportedCompletion: unknown;
    let reportedCached: unknown;
    try {
      let response: Response | undefined;
      for (let attempt = 0; !response; attempt++) {
        options.signal?.throwIfAborted();
        finishUsage = this.opts.usageMeter?.start({
          source: "llm.stream",
          provider: usage.provider,
          model: usage.model,
          endpoint: this.opts.endpoint,
          scene: this.scene(options),
        });
        try {
          response = await this.fetcher(
            `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${this.opts.apiKey}`,
                ...CLIENT_HEADERS,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model: this.opts.model,
                messages,
                temperature: 0.3,
                stream: true,
                ...this.opts.extraBody,
                stream_options: { include_usage: true },
                ...this.requestBody(options),
              }),
              signal: AbortSignal.any(signals),
            },
          );
        } catch (error) {
          finishUsage?.({
            status: connectFailed(error) ? "failed" : "unknown",
          });
          if (
            attempt === 0 &&
            connectFailed(error) &&
            !signals.some((s) => s.aborted)
          )
            continue;
          throw error;
        }
      }
      if (!response.ok) {
        outcome = "failed";
        throw statusError(
          response.status,
          await response.text().catch(() => ""),
        );
      }
      if (!response.body)
        throw new ProviderError(
          "AI_UNAVAILABLE",
          "AI 服务暂时不可用，请稍后重试",
        );
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        poke();
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let event: {
            choices?: {
              delta?: { content?: unknown; reasoning_content?: unknown };
              finish_reason?: string | null;
            }[];
            usage?: TokenUsage;
          };
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }
          received = true;
          if (event.usage) {
            reportedPrompt = event.usage.prompt_tokens;
            reportedCompletion = event.usage.completion_tokens;
            usage.promptTokens = Number(event.usage.prompt_tokens) || 0;
            usage.completionTokens = Number(event.usage.completion_tokens) || 0;
            reportedCached = cachedTokens(event.usage);
            if (reportedCached !== undefined) usage.cachedTokens = Number(reportedCached);
          }
          const reason = event.choices?.[0]?.finish_reason;
          if (typeof reason === "string") usage.finishReason = reason;
          const delta = event.choices?.[0]?.delta;
          if (
            typeof delta?.reasoning_content === "string" &&
            delta.reasoning_content
          ) {
            thought += delta.reasoning_content;
            handlers.onThinking?.(delta.reasoning_content);
          }
          if (typeof delta?.content === "string" && delta.content) {
            text += delta.content;
            handlers.onText(delta.content);
          }
        }
      }
      if (
        !reported({
          prompt_tokens: reportedPrompt,
          completion_tokens: reportedCompletion,
        })
      ) {
        usage.promptTokens = estimateTokens(requestText(messages));
        usage.completionTokens = estimateTokens(thought + text);
        usage.estimated = true;
      }
      outcome = "succeeded";
      if (options.truncateAsError && usage.finishReason === "length") {
        outcome = "failed";
        throw Object.assign(new ProviderError(
          "OUTPUT_TRUNCATED", "AI 返回的内容格式不对，请重试", "unknown",
        ), { usage });
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      const timedOut = idle.signal.aborted || cap.aborted;
      throw Object.assign(
        new ProviderError(
          timedOut ? "AI_TIMEOUT" : "AI_UNAVAILABLE",
          timedOut ? "AI 回答超时，请重试" : "AI 服务连接中断，请重试",
          received || !connectFailed(error) ? "unknown" : "none",
        ),
        { usage, partial: text },
      );
    } finally {
      clearTimeout(timer);
      usage.ms = Date.now() - started;
      finishUsage?.({
        status: outcome,
        promptTokens: reportedPrompt,
        completionTokens: reportedCompletion,
        cachedTokens: reportedCached,
      });
    }
    if (!text.trim())
      throw Object.assign(
        new ProviderError(
          "AI_BAD_OUTPUT",
          "AI 没有给出回答，请重试",
          "unknown",
        ),
        { usage },
      );
    return { text, usage };
  }
  private async complete(
    messages: ChatMessage[],
    usage: LlmUsage,
    signal?: AbortSignal,
    options: LlmRequestOptions = {},
  ) {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const failed = (error: unknown): never => {
      if (signal?.aborted) throw signal.reason ?? error;
      if (timeout.aborted)
        throw new ProviderError(
          "AI_TIMEOUT",
          "AI 生成超时。重试可能再次产生调用费用",
          "unknown",
        );
      if (connectFailed(error))
        throw new ProviderError(
          "AI_UNAVAILABLE",
          "AI 服务暂时无法连接，请稍后重试",
        );
      // The request may have reached the model before the connection broke.
      throw new ProviderError(
        "AI_UNAVAILABLE",
        "AI 服务连接中断，结果未知。重试可能再次产生调用费用",
        "unknown",
      );
    };
    let response: Response | undefined;
    let body: unknown;
    let raw = "";
    for (let attempt = 0; !response; attempt++) {
      signal?.throwIfAborted();
      const finishUsage = this.opts.usageMeter?.start({
        source: this.opts.test ? "llm.test" : "llm.json",
        provider: usage.provider,
        model: usage.model,
        endpoint: this.opts.endpoint,
        scene: this.scene(options),
      });
      try {
        response = await this.fetcher(
          `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.opts.apiKey}`,
              ...CLIENT_HEADERS,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: this.opts.model,
              messages,
              temperature: 0.3,
              response_format: { type: "json_object" },
              ...this.opts.extraBody,
              ...this.requestBody(options),
            }),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          },
        );
        usage.calls++;
        raw = await response.text().catch(() => "");
        body = parseBody(raw);
        const reported = body as
          | {
              usage?: TokenUsage;
            }
          | undefined;
        finishUsage?.({
          status: response.ok ? "succeeded" : "failed",
          promptTokens: reported?.usage?.prompt_tokens,
          completionTokens: reported?.usage?.completion_tokens,
          cachedTokens: cachedTokens(reported?.usage),
        });
      } catch (error) {
        finishUsage?.({ status: connectFailed(error) ? "failed" : "unknown" });
        if (
          attempt === 0 &&
          connectFailed(error) &&
          !timeout.aborted &&
          !signal?.aborted
        )
          continue;
        return failed(error);
      }
    }
    if (timeout.aborted || signal?.aborted) return failed(undefined);
    if (!response.ok) throw statusError(response.status, raw);
    const data = body as
      | {
          choices?: { message?: { content?: unknown }; finish_reason?: string }[];
          usage?: TokenUsage;
        }
      | undefined;
    usage.promptTokens += Number(data?.usage?.prompt_tokens) || 0;
    usage.completionTokens += Number(data?.usage?.completion_tokens) || 0;
    const cached = cachedTokens(data?.usage);
    if (cached !== undefined) usage.cachedTokens = (usage.cachedTokens ?? 0) + cached;
    const finishReason = data?.choices?.[0]?.finish_reason;
    if (finishReason !== undefined) usage.finishReason = finishReason;
    else delete usage.finishReason;
    if (usage.finishReason === "length")
      throw Object.assign(new ProviderError(
        "OUTPUT_TRUNCATED", "AI 返回的内容格式不对，请重试", "unknown",
      ), { usage });
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string")
      throw new ProviderError("AI_BAD_OUTPUT", "AI 返回的内容格式不对，请重试");
    if (!reported(data?.usage)) {
      usage.promptTokens += estimateTokens(requestText(messages));
      usage.completionTokens += estimateTokens(content);
      usage.estimated = true;
    }
    return content;
  }
}
