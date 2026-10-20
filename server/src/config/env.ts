import { z } from "zod";
const bool = z.preprocess(
  (v) => (v === "true" ? true : v === "false" ? false : v),
  z.boolean(),
);
const int = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: int(1, 65535, 8787),
  TEST_CLOCK_DAYS: int(-3650, 3650, 0),
  // Enable only after the v2 miniapp has been published, not on backend deploy.
  LEGACY_NOTES_READ_ONLY: bool.default(false),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_PATH: z.string().min(1).default("./data/app.sqlite"),
  UPLOAD_DIR: z.string().min(1).default("./data/uploads"),
  // Rendered formula images (content-addressed, safe to delete).
  FORMULA_DIR: z.string().min(1).default("./data/formulas"),
  DEV_LOGIN_ENABLED: bool.optional(),
  ADMIN_API_KEY: z.string().min(32).max(256).optional(),
  // Canonical public origin, never inferred from untrusted forwarding headers.
  ADMIN_ORIGIN: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && url.origin === value;
    }, "must be an exact HTTP(S) origin without a path")
    .optional(),
  TRUST_PROXY: z.enum(["none", "loopback"]).default("none"),
  SESSION_TTL_SECONDS: int(300, 2592000, 604800),
  WECHAT_APP_ID: z.string().optional(),
  WECHAT_APP_SECRET: z.string().optional(),
  WECHAT_HTTP_TIMEOUT_MS: int(1000, 30000, 8000),
  JOB_CONCURRENCY: int(1, 8, 4),
  DAILY_AI_LIMIT: int(1, 10000, 200),
  DAILY_OCR_LIMIT: int(1, 1000, 60),
  DAILY_NOTES_LIMIT: int(1, 1000, 30),
  // 每位用户每天成功完成的对话回答与图片识别次数上限。
  CHAT_DAILY_LIMIT: int(1, 10000, 60),
  PHOTO_DAILY_LIMIT: int(1, 1000, 20),
  DAILY_BRAINSTORM_LIMIT: int(1, 1000, 10),
  DAILY_IMPORT_LIMIT: int(1, 1000, 10),
  // V4.2 (G4): what a learner may spend, in yuan at the admin price table,
  // per Beijing day and per week from Monday; the admin console overrides
  // both. The count limits above no longer stop learners; one hidden cap on
  // all receipts of a day only guards against runaway loops.
  DAILY_BUDGET_CNY: z.coerce.number().min(0).max(100000).default(3),
  WEEKLY_BUDGET_CNY: z.coerce.number().min(0).max(100000).default(12),
  DAILY_SAFETY_CAP: int(1, 100000, 500),
  LLM_BASE_URL: z
    .string()
    .url()
    .default("https://tokenhub-intl.tencentmaas.com/v1"),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().min(1).default("hy4-preview"),
  LLM_EXTRA_BODY: z
    .string()
    .default('{"reasoning_effort":"no_think"}')
    .transform((text, ctx) => {
      try {
        const value: unknown = JSON.parse(text);
        if (value && typeof value === "object" && !Array.isArray(value))
          return value as Record<string, unknown>;
      } catch {}
      ctx.addIssue({ code: "custom", message: "must be a JSON object" });
      return z.NEVER;
    }),
  LLM_TIMEOUT_MS: int(5000, 120000, 90000),
  JEV_API_KEY: z.string().optional(),
  JEV_BASE_URL: z.string().url().optional(),
  JEV_TIMEOUT_MS: int(1000, 60000, 15000),
  // "llm" answers judge questions with the chat model instead of the Jev API.
  JUDGE_PROVIDER: z.enum(["jev", "llm", "jev_llm"]).default("jev"),
  TENCENT_SECRET_ID: z.string().optional(),
  TENCENT_SECRET_KEY: z.string().optional(),
  OCR_REGION: z.string().default("ap-guangzhou"),
  OCR_TIMEOUT_MS: int(1000, 60000, 20000),
  // Multimodal model on LLM_BASE_URL used for OCR when Tencent keys are absent; empty disables it.
  OCR_VISION_MODEL: z.string().default(""),
});
export type Env = z.infer<typeof schema> & { DEV_LOGIN_ENABLED: boolean };
export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const value = schema.parse(input);
  const env: Env = {
    ...value,
    DEV_LOGIN_ENABLED:
      value.DEV_LOGIN_ENABLED ?? value.NODE_ENV === "development",
  };
  if (env.NODE_ENV === "production") {
    if (env.TEST_CLOCK_DAYS !== 0)
      throw new Error("Production does not allow TEST_CLOCK_DAYS");
    if (env.DEV_LOGIN_ENABLED)
      throw new Error("Production disables development login");
    if (
      !env.WECHAT_APP_ID ||
      !env.WECHAT_APP_SECRET ||
      !env.ADMIN_API_KEY ||
      !input.DATABASE_PATH ||
      env.DATABASE_PATH === ":memory:"
    )
      throw new Error(
        "Production requires WeChat login credentials, strong admin secret and explicit persistent database",
      );
    if (/change|example|replace|development/i.test(env.ADMIN_API_KEY))
      throw new Error("Production admin key is a placeholder");
    // 32 random hex characters use about 14 distinct symbols; a repeated or
    // keyboard-walk key uses few. Generate one with: openssl rand -hex 32
    if (new Set(env.ADMIN_API_KEY).size < 10)
      throw new Error(
        "Production admin key is too weak; generate one with openssl rand -hex 32",
      );
    if (!env.ADMIN_ORIGIN?.startsWith("https://"))
      throw new Error("Production requires an explicit HTTPS ADMIN_ORIGIN");
  }
  return env;
}
