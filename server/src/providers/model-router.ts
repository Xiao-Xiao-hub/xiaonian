/*
 * 大模型接口路由：按管理台配置的顺序选用接口，并应用场景参数与冷却规则。
 * 只有允许切换的失败才尝试下一个接口；已经输出或结果未知时保留原来的失败语义，避免重复调用。
 */
import { randomUUID } from "node:crypto";
import { z, type output, type ZodTypeAny } from "zod";
import type { SqliteStore } from "../shared/store.js";
import type { UsageMeter } from "../shared/usage-ledger.js";
import {
  ChatModel,
  ProviderError,
  SCENARIOS,
  type ChatMessage,
  type LlmClient,
  type LlmRequestOptions,
  type LlmUsage,
  normalizeScenario,
  type Scenario,
  type StreamJsonOptions,
} from "./llm.js";

export const FORMATS = [
  "none",
  "reasoning_effort",
  "thinking_type",
  "enable_thinking",
] as const;
export type ThinkingFormat = (typeof FORMATS)[number];
export const LEVELS = ["off", "low", "medium", "high", "max"] as const;
export type ThinkingLevel = (typeof LEVELS)[number];
export const DEFAULT_THINKING: Record<
  (typeof SCENARIOS)[number],
  ThinkingLevel
> = {
  "chat.study": "low",
  "chat.life": "low",
  "chat.mood": "low",
  card_tidy: "low",
  import_split: "low",
  brainstorm: "high",
  map_stuck: "low",
  vision: "low",
  recheck: "high",
  study: "low",
  judge: "low",
};
const BUDGET = { low: 1024, medium: 4096, high: 16384, max: 32768 };
const LEGACY_SCENARIO: Partial<Record<(typeof SCENARIOS)[number], string>> = {
  "chat.study": "ask",
  card_tidy: "notes",
  vision: "photo",
};
const isGlm53 = (model: string) => /^glm-5\.3(?:-|$)/i.test(model);
const glmThinkingBody = (level: ThinkingLevel) => ({
  thinking: { type: "enabled" },
  reasoning_effort:
    level === "off" || level === "low"
      ? "low"
      : level === "max"
        ? "max"
        : "high",
});
// Request fields for one level, merged over the endpoint's extra body.
// reasoning_effort has no "off" every provider accepts, so off sends nothing
// and the extra body (e.g. {"reasoning_effort":"no_think"}) decides.
export function thinkingBody(
  format: ThinkingFormat,
  level: ThinkingLevel,
): Record<string, unknown> {
  if (format === "reasoning_effort")
    return level === "off" ? {} : { reasoning_effort: level };
  if (format === "thinking_type")
    return { thinking: { type: level === "off" ? "disabled" : "enabled" } };
  if (format === "enable_thinking")
    return level === "off"
      ? { enable_thinking: false }
      : { enable_thinking: true, thinking_budget: BUDGET[level] };
  return {};
}
// Seeding only; the admin page can change it.
export function guessFormat(baseUrl: string): ThinkingFormat {
  const host = new URL(baseUrl).host;
  if (/bigmodel\.cn|z\.ai|volces\.com|volcengine/.test(host))
    return "thinking_type";
  if (/dashscope|aliyuncs\.com|siliconflow/.test(host))
    return "enable_thinking";
  if (/openai\.com|tencentmaas|hunyuan/.test(host)) return "reasoning_effort";
  return "none";
}

export type Endpoint = {
  id: string;
  alias: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  vision: boolean;
  thinkingFormat: ThinkingFormat;
  extraBody: Record<string, unknown>;
  timeoutMs: number;
  position: number;
  enabled: boolean;
};
type Row = Record<string, unknown>;
export const endpointOf = (r: Row): Endpoint => ({
  id: String(r.id),
  alias: String(r.alias),
  baseUrl: String(r.base_url),
  apiKey: String(r.api_key),
  model: String(r.model),
  vision: r.vision === 1,
  thinkingFormat: String(r.thinking_format) as ThinkingFormat,
  extraBody: JSON.parse(String(r.extra_body)),
  timeoutMs: Number(r.timeout_ms),
  position: Number(r.position),
  enabled: r.enabled === 1,
});
export const newEndpointId = () =>
  `aep_${randomUUID().replaceAll("-", "")}`;

// Failures where nothing was generated, so another endpoint may answer; the
// value is how long the endpoint is skipped afterwards.
const COOLDOWN_MS: Record<string, number> = {
  AI_QUOTA: 10 * 60_000,
  AI_AUTH: 10 * 60_000,
  AI_BUSY: 60_000,
  AI_UNAVAILABLE: 60_000,
};
const hasImage = (messages: ChatMessage[]) =>
  messages.some(
    (m) =>
      Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
  );
type Health = {
  until: number;
  error?: { code: string; message: string; at: number };
  okAt?: number;
};
export type EndpointHealth = {
  coolingUntil: string | null;
  lastError: { code: string; message: string; at: string } | null;
  lastOkAt: string | null;
};
export type SeedEnv = {
  LLM_BASE_URL: string;
  LLM_API_KEY?: string;
  LLM_MODEL: string;
  LLM_EXTRA_BODY: Record<string, unknown>;
  LLM_TIMEOUT_MS: number;
  OCR_VISION_MODEL: string;
};
// The admin test call's expected reply.
export const PING = z.object({ ok: z.literal(true) });

// Tries the enabled endpoints in order and moves on only when a call failed
// before anything was generated (billing "none"): out of credit, rate limited,
// bad key, unreachable or a 5xx. A timeout, a broken stream or unusable output
// may already be billed and goes back to the caller. Endpoints and levels are
// read on every call, so admin edits apply at once; cooldowns live in memory.
export class ModelRouter {
  private readonly health = new Map<string, Health>();
  constructor(
    private readonly store: SqliteStore,
    private readonly opts: {
      usageMeter?: UsageMeter;
      fetcher?: typeof fetch;
      now?: () => number;
    } = {},
  ) {}
  private now() {
    return (this.opts.now ?? Date.now)();
  }
  endpoints(): Endpoint[] {
    return (
      this.store.db
        .prepare("SELECT * FROM ai_endpoints ORDER BY position,created_at")
        .all() as Row[]
    ).map(endpointOf);
  }
  thinking(): Record<(typeof SCENARIOS)[number], ThinkingLevel> {
    const row = this.store.db
      .prepare("SELECT value FROM settings WHERE key='ai.thinking'")
      .get() as { value: string } | undefined;
    const saved = (row ? JSON.parse(row.value) : {}) as Record<string, string>;
    return Object.fromEntries(
      SCENARIOS.map((s) => [
        s,
        (LEVELS as readonly string[]).includes(
          saved[s] ?? saved[LEGACY_SCENARIO[s] ?? ""] ?? "",
        )
          ? saved[s] ?? saved[LEGACY_SCENARIO[s] ?? ""]
          : DEFAULT_THINKING[s],
      ]),
    ) as Record<(typeof SCENARIOS)[number], ThinkingLevel>;
  }
  routes(): Partial<Record<(typeof SCENARIOS)[number], string[]>> {
    const row = this.store.db
      .prepare("SELECT value FROM settings WHERE key='ai.routes'")
      .get() as { value: string } | undefined;
    const saved = (row ? JSON.parse(row.value) : {}) as Record<string, unknown>;
    return Object.fromEntries(
      SCENARIOS.flatMap((scenario) => {
        const ids = saved[scenario] ?? saved[LEGACY_SCENARIO[scenario] ?? ""];
        return Array.isArray(ids) && ids.every((id) => typeof id === "string")
          ? [[scenario, ids] as const]
          : [];
      }),
    ) as Partial<Record<(typeof SCENARIOS)[number], string[]>>;
  }
  // Enabled endpoints that can take the call: ready ones in order, then the
  // cooling ones as a last resort, so one hiccup never stops every call.
  candidates(scenario: Scenario, messages: ChatMessage[] = []): Endpoint[] {
    const normalized = normalizeScenario(scenario);
    const image = normalized === "vision" || hasImage(messages);
    const now = this.now();
    const usable = this.endpoints().filter(
      (e) => e.enabled && (!image || e.vision),
    );
    const route = this.routes()[normalized];
    const selected = route?.length
      ? route
          .map((id) => usable.find((endpoint) => endpoint.id === id))
          .filter((endpoint): endpoint is Endpoint => Boolean(endpoint))
      : usable;
    const cooling = (e: Endpoint) => (this.health.get(e.id)?.until ?? 0) > now;
    return [
      ...selected.filter((e) => !cooling(e)),
      ...selected.filter(cooling),
    ];
  }
  healthOf(id: string): EndpointHealth {
    const h = this.health.get(id);
    const iso = (t?: number) => (t ? new Date(t).toISOString() : null);
    return {
      coolingUntil: h && h.until > this.now() ? iso(h.until) : null,
      lastError: h?.error ? { ...h.error, at: iso(h.error.at)! } : null,
      lastOkAt: iso(h?.okAt),
    };
  }
  forget(id: string) {
    this.health.delete(id);
  }
  private model(
    endpoint: Endpoint,
    level: ThinkingLevel,
    test = false,
    scenario?: Scenario,
  ) {
    return new ChatModel(
      {
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey,
        model: endpoint.model,
        extraBody: {
          ...endpoint.extraBody,
          ...(isGlm53(endpoint.model)
            ? glmThinkingBody(level)
            : thinkingBody(endpoint.thinkingFormat, level)),
        },
        // Some models think even when off, so off still gets room.
        thinkingTokens: BUDGET[level === "off" ? "medium" : level],
        timeoutMs: endpoint.timeoutMs,
        usageMeter: this.opts.usageMeter,
        endpoint: endpoint.alias,
        test,
        scenario,
      },
      this.opts.fetcher,
    );
  }
  private succeeded(id: string) {
    const h = this.health.get(id);
    this.health.set(id, { until: 0, error: h?.error, okAt: this.now() });
  }
  private failed(id: string, error: ProviderError) {
    const now = this.now();
    this.health.set(id, {
      ...this.health.get(id),
      until: now + (COOLDOWN_MS[error.code] ?? 0),
      error: { code: error.code, message: error.message, at: now },
    });
  }
  async run<T>(
    scenario: Scenario,
    messages: ChatMessage[],
    call: (model: ChatModel) => Promise<T>,
  ): Promise<T> {
    const normalized = normalizeScenario(scenario);
    const list = this.candidates(normalized, messages);
    if (!list.length)
      throw new ProviderError("AI_NOT_CONFIGURED", "AI 这会儿用不了，过会儿再试");
    const level = this.thinking()[normalized];
    let last: ProviderError | undefined;
    for (const endpoint of list) {
      try {
        const result = await call(this.model(endpoint, level, false, normalized));
        this.succeeded(endpoint.id);
        return result;
      } catch (error) {
        if (
          !(error instanceof ProviderError) ||
          error.billing !== "none" ||
          !(error.code in COOLDOWN_MS)
        )
          throw error;
        this.failed(endpoint.id, error);
        last = error;
      }
    }
    // Callers know the long-standing codes; out of credit reads as unavailable.
    if (last!.code !== "AI_QUOTA") throw last!;
    throw Object.assign(
      new ProviderError("AI_UNAVAILABLE", "AI 服务暂时不可用，请稍后重试"),
      { usage: (last as { usage?: unknown }).usage },
    );
  }
  client(scenario: Scenario): LlmClient {
    const router = this;
    return {
      get configured() {
        return router.candidates(scenario).length > 0;
      },
      get model() {
        return router.candidates(scenario)[0]?.model ?? "";
      },
      json: <S extends ZodTypeAny>(
        messages: ChatMessage[],
        schema: S,
        signal?: AbortSignal,
        options: LlmRequestOptions = {},
      ): Promise<{ data: output<S>; usage: LlmUsage }> =>
        router.run(options.scenario ?? scenario, messages, (m) => {
          const { scenario: _scenario, ...rest } = options;
          return m.json(messages, schema, signal, rest);
        }),
      stream: (messages, handlers, options = {}) => {
        const { scenario: override, ...rest } = options;
        return router.run(override ?? scenario, messages, (m) =>
          m.stream(messages, handlers, rest),
        );
      },
      streamJson: (messages, schema, options: StreamJsonOptions) => {
        const { scenario: override, ...rest } = options;
        return router.run(override ?? scenario, messages, (m) =>
          m.streamJson(messages, schema, rest),
        );
      },
    };
  }
  // Admin test: this endpoint alone, no failover, one small real JSON call.
  async test(endpoint: Endpoint, level: ThinkingLevel = "off") {
    const started = this.now();
    try {
      const { usage } = await this.model(endpoint, level, true).json(
        [
          {
            role: "system",
            content: '只输出这个 JSON 对象，不要输出别的：{"ok": true}',
          },
          { role: "user", content: "ping" },
        ],
        PING,
      );
      this.succeeded(endpoint.id);
      return {
        ok: true as const,
        ms: usage.ms,
        model: usage.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      if (error.billing === "none" && error.code in COOLDOWN_MS)
        this.failed(endpoint.id, error);
      return {
        ok: false as const,
        ms: this.now() - started,
        code: error.code,
        message: error.message,
      };
    }
  }
  // First start with a model key only: the.env settings become the first
  // endpoints so an existing deployment keeps working. After that the admin
  // page owns them; deleting every endpoint stays deleted across restarts.
  seed(env: SeedEnv) {
    if (!env.LLM_API_KEY) return;
    const db = this.store.db;
    this.store.transaction(() => {
      if (db.prepare("SELECT 1 FROM settings WHERE key='ai.seeded'").get())
        return;
      const now = new Date().toISOString();
      if (!db.prepare("SELECT 1 FROM ai_endpoints LIMIT 1").get()) {
        const insert = db.prepare(
          "INSERT INTO ai_endpoints(id,alias,base_url,api_key,model,vision,thinking_format,extra_body,timeout_ms,position,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)",
        );
        const format = guessFormat(env.LLM_BASE_URL);
        const extra = JSON.stringify(env.LLM_EXTRA_BODY);
        insert.run(
          newEndpointId(),
          "默认",
          env.LLM_BASE_URL,
          env.LLM_API_KEY!,
          env.LLM_MODEL,
          0,
          format,
          extra,
          env.LLM_TIMEOUT_MS,
          0,
          now,
          now,
        );
        if (env.OCR_VISION_MODEL)
          insert.run(
            newEndpointId(),
            "识图",
            env.LLM_BASE_URL,
            env.LLM_API_KEY!,
            env.OCR_VISION_MODEL,
            1,
            format,
            extra,
            env.LLM_TIMEOUT_MS,
            1,
            now,
            now,
          );
      }
      db.prepare(
        "INSERT INTO settings(key,value,updated_at) VALUES('ai.seeded','true',?)",
      ).run(now);
    });
  }
}
