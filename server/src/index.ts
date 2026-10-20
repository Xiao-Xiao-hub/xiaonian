/*
 * 后端装配入口：创建 Fastify、数据库、服务与任务执行器，注册路由和关闭钩子。
 * createApp 也供自动测试注入依赖；各领域规则放在 modules，外部调用放在 providers。
 * 启动、后台定时任务和停机都在这里协调；单进程 SQLite 与进程内并发控制是当前运行边界。
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z, ZodError } from "zod";
import { loadEnv, type Env } from "./config/env.js";
import { SqliteStore } from "./shared/store.js";
import { AppError } from "./shared/domain.js";
import { AuthService, publicUser } from "./modules/auth/service.js";
import { registerAdminSessionRoutes } from "./modules/auth/admin-session.js";
import { safeError } from "./shared/logging.js";
import { shiftedClock } from "./shared/time.js";
import { UsageLedger } from "./shared/usage-ledger.js";
import {
  JobRunner,
  publicJob,
  type JobHandler,
} from "./modules/jobs/runner.js";
import { ModelRouter } from "./providers/model-router.js";
import { TencentOcr, type OcrProvider } from "./providers/tencent-ocr.js";
import { VisionOcr } from "./providers/vision-ocr.js";
import { Jev } from "./providers/jev.js";
import { llmJudge } from "./providers/llm-judge.js";
import {
  IMAGE_LIMIT,
  MaterialService,
  TEXT_LIMIT,
} from "./modules/materials/service.js";
import { registerMaterialRoutes } from "./modules/materials/routes.js";
import { StudyService } from "./modules/study/service.js";
import { registerStudyRoutes } from "./modules/study/routes.js";
import { ReviewService } from "./modules/review/service.js";
import { registerReviewRoutes } from "./modules/review/routes.js";
import { AccountService } from "./modules/account/service.js";
import { registerAccountRoutes } from "./modules/account/routes.js";
import { registerStudyTimeRoutes } from "./modules/study-time/routes.js";
import { StudyTimeService } from "./modules/study-time/service.js";
import { AdminService } from "./modules/admin/service.js";
import { registerAdminRoutes } from "./modules/admin/routes.js";
import { registerAdminAiRoutes } from "./modules/admin/ai.js";
import { registerAdminManageRoutes } from "./modules/admin/manage.js";
import { Limits } from "./shared/limits.js";
import { Budget } from "./shared/budget.js";
import { FormulaRenderer } from "./modules/render/formula.js";
import { MarkdownRenderer } from "./modules/render/markdown.js";
import { registerRenderRoutes } from "./modules/render/routes.js";
import { registerAssetRoutes } from "./modules/assets/routes.js";
import { registerLegalRoutes } from "./modules/legal/routes.js";
import { LegalService } from "./modules/legal/service.js";
import { ChatService } from "./modules/chat/service.js";
import { registerChatRoutes } from "./modules/chat/routes.js";
import { MistakeService } from "./modules/mistakes/service.js";
import { registerMistakeRoutes } from "./modules/mistakes/routes.js";
import { HomeService } from "./modules/home/service.js";
import { registerHomeRoutes } from "./modules/home/routes.js";
import { LearnService } from "./modules/learn/service.js";
import { registerLearnRoutes } from "./modules/learn/routes.js";
import { NoteService } from "./modules/notes/service.js";
import { ToolLinkService } from "./modules/learn/tool-links.js";
import { registerNoteRoutes } from "./modules/notes/routes.js";
import { CardBackfill, type CardType } from "./modules/cards/backfill.js";
import { CrisisSafetyService } from "./modules/safety/service.js";
import { MoodService } from "./modules/safety/mood.js";
import { CardService } from "./modules/cards/service.js";
import { CARD_TYPE_LABELS } from "./modules/cards/types.js";
import { registerCardRoutes } from "./modules/cards/routes.js";
import { CardTidyService } from "./modules/cards/tidy.js";
import { CardMergeService } from "./modules/cards/merge.js";
import { ResumeService } from "./modules/resume/service.js";
import { registerResumeRoutes } from "./modules/resume/routes.js";
import { registerMoodRoutes } from "./modules/safety/routes.js";
import { ImportService } from "./modules/imports/service.js";
import { registerImportRoutes } from "./modules/imports/routes.js";
import { BrainstormService } from "./modules/brainstorm/service.js";
import { registerBrainstormRoutes } from "./modules/brainstorm/routes.js";
import {
  defaultImportFileTools,
  type ImportFileTools,
} from "./modules/imports/parser.js";
declare module "fastify" {
  interface FastifyRequest {
    rawBody: string;
  }
}
export type BuildOptions = {
  env?: Env;
  store?: SqliteStore;
  // Shared by every outbound integration (WeChat, AI, OCR); tests pass a fake.
  fetcher?: typeof fetch;
  // Extra or replacement job handlers, used by tests.
  handlers?: Record<string, JobHandler>;
  // Clock for review scheduling; tests move it forward.
  now?: () => Date;
  // Deterministic file/PDF tools for import API tests.
  importTools?: ImportFileTools;
  // The explicit v2 client release switch keeps legacy note reads and deletion,
  // while all other legacy note writes return 410.
  legacyNotesReadOnly?: boolean;
};
export function buildApp(options: BuildOptions = {}) {
  const env = options.env || loadEnv(),
    businessNow = options.now ?? shiftedClock(env.TEST_CLOCK_DAYS),
    store = options.store || new SqliteStore(env.DATABASE_PATH, businessNow),
    auth = new AuthService(
      store,
      env,
      options.fetcher,
      options.now ? () => options.now!().getTime() : Date.now,
    );
  store.useClock(businessNow);
  const usageMeter = new UsageLedger(store, businessNow);
  // AI endpoints live in the database and fail over in order; the
  // LLM_* settings only seed them on the first start.
  const models = new ModelRouter(store, {
    usageMeter,
    fetcher: options.fetcher,
    now: options.now ? () => options.now!().getTime() : undefined,
  });
  models.seed(env);
  const llm = models.client("ask");
  const limits = new Limits(store, {
    ai: env.DAILY_AI_LIMIT,
    ocr: env.DAILY_OCR_LIMIT,
    notes: env.DAILY_NOTES_LIMIT,
    chat: env.CHAT_DAILY_LIMIT,
    photos: env.PHOTO_DAILY_LIMIT,
    brainstorm: env.DAILY_BRAINSTORM_LIMIT,
    import: env.DAILY_IMPORT_LIMIT,
  });
  // V4.2 : learners spend yuan per day and week; the counts above are
  // only the old clients' display and the budget-less fallback.
  const budget = new Budget(
    store,
    {
      day: env.DAILY_BUDGET_CNY,
      week: env.WEEKLY_BUDGET_CNY,
      cap: env.DAILY_SAFETY_CAP,
    },
    businessNow,
  );
  const tencentOcr = new TencentOcr(
    {
      secretId: env.TENCENT_SECRET_ID,
      secretKey: env.TENCENT_SECRET_KEY,
      region: env.OCR_REGION,
      timeoutMs: env.OCR_TIMEOUT_MS,
      usageMeter,
    },
    options.fetcher,
  );
  // Tencent OCR when its keys are set, otherwise an image-capable endpoint.
  const ocr: OcrProvider = tencentOcr.configured
    ? tencentOcr
    : new VisionOcr(models.client("photo"));
  const jev = new Jev(
    // Production reaches Jev through a relay (JEV_BASE_URL); "jev_llm" lets the
    // chat model answer when Jev fails, "llm" skips Jev entirely.
    {
      apiKey: env.JEV_API_KEY,
      baseUrl: env.JEV_BASE_URL,
      timeoutMs: env.JEV_TIMEOUT_MS,
      usageMeter,
      ...(env.JUDGE_PROVIDER === "llm"
        ? { answer: llmJudge(models.client("judge")) }
        : env.JUDGE_PROVIDER === "jev_llm"
          ? { fallback: llmJudge(models.client("judge")) }
          : {}),
    },
    options.fetcher,
  );
  const materials = new MaterialService(store, env.UPLOAD_DIR, businessNow);
  const toolLinks = new ToolLinkService(store, jev, businessNow);
  const mistakes = new MistakeService(
    store,
    jev,
    businessNow,
    undefined,
    toolLinks,
  );
  const notes = new NoteService(store, businessNow, models.client("notes"));
  const study = new StudyService(
    store,
    materials,
    models.client("study"),
    jev,
    mistakes,
    businessNow,
  );
  const reviews = new ReviewService(store, materials, study, businessNow);
  const started = Date.now();
  let requestCount = 0,
    errorCount = 0,
    totalDurationMs = 0;
  const app = Fastify({
    bodyLimit: 262144,
    requestTimeout: 30000,
    trustProxy: env.TRUST_PROXY === "loopback" ? "loopback" : false,
    logger: {
      level: env.LOG_LEVEL,
      serializers: {
        req: (req) => ({
          method: req.method,
          url: String(req.url || "").split("?")[0],
        }),
        err: (error) => ({
          ...safeError(error),
          message: "redacted",
          stack: "",
        }),
      },
      redact: [
        "req.headers.authorization",
        "req.headers.x-admin-key",
        "req.headers.cookie",
        "req.body",
        "res.headers.set-cookie",
      ],
    },
    genReqId: () => randomUUID(),
  });
  app.register(cors, { origin: false });
  app.register(helmet);
  app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.register(multipart);
  app.decorateRequest("rawBody", "");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      try {
        req.rawBody = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(body as Buffer);
        // wx.request sends an empty body for POST without data.
        done(null, req.rawBody.trim() ? JSON.parse(req.rawBody) : undefined);
      } catch {
        done(new AppError(400, "INVALID_JSON", "JSON格式无效"), undefined);
      }
    },
  );
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("cache-control", "no-store");
    reply.header("x-service-time", businessNow().toISOString());
  });
  app.addHook("onResponse", async (req, reply) => {
    // Probes and console assets must not inflate application traffic/error
    // counters (or turn frequent monitoring into a reported outage).
    const route = req.routeOptions.url || "";
    if (
      route.startsWith("/health/") ||
      route === "/metrics" ||
      route === "/admin" ||
      route.startsWith("/admin/")
    )
      return;
    requestCount++;
    totalDurationMs += reply.elapsedTime;
    if (reply.statusCode >= 500) errorCount++;
  });
  const safety = new CrisisSafetyService(jev);
  const cards = new CardService(
    store,
    safety,
    businessNow,
    (card) => {
      tidy.enqueue(
        String(
          store.db.prepare("SELECT user_id FROM cards WHERE id=?").get(card.id)!
            .user_id,
        ),
        card.id,
        card.version,
        runner,
        { automatic: true },
      );
    },
    jev,
  );
  const tidy = new CardTidyService(store, cards, models.client("card_tidy"));
  const merges = new CardMergeService(store, cards, models.client("card_tidy"));
  const imports = new ImportService(
    store,
    cards,
    models.client("import_split"),
    models.client("vision"),
    ocr,
    jev,
    safety,
    env.UPLOAD_DIR,
    options.importTools ?? defaultImportFileTools,
    businessNow,
  );
  const brainstorms = new BrainstormService(
    store,
    cards,
    models.client("brainstorm"),
    safety,
    businessNow,
  );
  const runner = new JobRunner(
    store,
    {
      ocr: materials.ocrHandler(ocr),
      ...study.handlers(),
      ...notes.handlers(),
      ...tidy.handlers(),
      ...merges.handlers(),
      ...imports.handlers(),
      ...brainstorms.handlers(),
      ...options.handlers,
    },
    {
      concurrency: env.JOB_CONCURRENCY,
      timeoutMs: env.LLM_TIMEOUT_MS + 30000,
      limits: {
        ai: env.DAILY_AI_LIMIT,
        ocr: env.DAILY_OCR_LIMIT,
        notes: env.DAILY_NOTES_LIMIT,
        brainstorm: env.DAILY_BRAINSTORM_LIMIT,
        import: env.DAILY_IMPORT_LIMIT,
      },
      limitFor: (userId, bucket) =>
        limits.for(
          userId,
          bucket as "ai" | "ocr" | "notes" | "brainstorm" | "import",
        ),
      budget,
      log: (error, job) =>
        app.log.error(
          { ...safeError(error), jobId: job.id, kind: job.kind },
          "job failed",
        ),
      now: businessNow,
    },
  );
  runner.recover();
  const backfillAbort = new AbortController();
  // The borrowed judge bypasses queue re-entry only within one background turn.
  let backfillJudge: Pick<Jev, "noul" | "choice"> = jev;
  const backfill = new CardBackfill(store, {
    schedule: (run, signal) =>
      jev.background(async (judge) => {
        backfillJudge = judge;
        return run();
      }, signal),
    checkCrisis: (text, scene, signal) =>
      new CrisisSafetyService(backfillJudge).check(
        text,
        { scene, source: "backfill" },
        signal,
      ),
    classify: async (text, signal) => {
      const answer = await backfillJudge.choice(
        { text },
        "按文字表达的内容选择一种卡片类型。灵感是还没展开的新点子，想法是已表态或已打算，思路是能复用的做法，问题是还没答案的疑问。",
        CARD_TYPE_LABELS,
        signal,
      );
      return { type: answer.choice as CardType, confidence: answer.confidence };
    },
  });
  let backfillTask: Promise<void> | undefined;
  app.addHook("onReady", async () => {
    const removed = imports.cleanupOld();
    if (removed) app.log.info({ removed }, "stale import uploads pruned");
    backfillTask = backfill.run(backfillAbort.signal).catch((error) => {
      app.log.warn(safeError(error), "card type backfill stopped");
    });
  });
  app.addHook("onClose", async () => {
    backfillAbort.abort();
    await backfillTask;
    await runner.stop();
    await toolLinks.stop();
    store.close();
  });
  app.setErrorHandler((err, req, reply) => {
    let status = 500,
      code = "INTERNAL_ERROR",
      message = "服务暂时不可用";
    if (err instanceof ZodError) {
      status = 400;
      code = "VALIDATION_ERROR";
      // The details are English and about fields; they stay in the log.
      message = "填的内容不太对，再看一下";
      req.log.warn(
        {
          issues: err.issues
            .slice(0, 5)
            .map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        "validation failed",
      );
    } else if (err instanceof AppError) {
      status = err.statusCode;
      code = err.code;
      message = err.message;
    } else if (
      err instanceof Error &&
      "statusCode" in err &&
      typeof err.statusCode === "number" &&
      err.statusCode >= 400 &&
      err.statusCode < 500
    ) {
      status = err.statusCode;
      code = "BAD_REQUEST";
      message = "请求无效或请求过于频繁";
    }
    if (status >= 500)
      req.log.error({ code, requestId: req.id }, "request failed");
    reply.code(status).send({ code, message, requestId: req.id });
  });
  app.setNotFoundHandler((req, reply) =>
    reply
      .code(404)
      .send({ code: "NOT_FOUND", message: "接口不存在", requestId: req.id }),
  );
  // rate-limit installs an onRoute hook asynchronously. Register application
  // routes only after plugins load, otherwise their configured limits are lost.
  app.after(() => {
    const userCount = () =>
      (
        store.db.prepare("SELECT COUNT(*) AS n FROM users").get() as {
          n: number;
        }
      ).n;
    app.get("/health/live", { config: { rateLimit: false } }, async () => ({
      status: "ok",
      uptimeSec: Math.floor((Date.now() - started) / 1000),
    }));
    app.get("/health/ready", { config: { rateLimit: false } }, async () => {
      store.health();
      return {
        status: "ready",
        dependencies: { store: "ok" },
        note: "只检查本地依赖；不代表微信登录或外部服务可用",
      };
    });
    app.get("/metrics", async (req, reply) => {
      auth.admin(req);
      reply.type("text/plain; version=0.0.4");
      return `# TYPE framework_http_requests_total counter\nframework_http_requests_total ${requestCount}\n# TYPE framework_http_errors_total counter\nframework_http_errors_total ${errorCount}\n# TYPE framework_http_duration_ms_total counter\nframework_http_duration_ms_total ${totalDurationMs.toFixed(2)}\n# TYPE framework_users gauge\nframework_users ${userCount()}\n# TYPE framework_usage_accounting_write_failures_total counter\nframework_usage_accounting_write_failures_total ${usageMeter.accountingWriteFailures}\n`;
    });
    app.get("/v1/config", async () => ({
      data: {
        appName: "晓念",
        devLogin: env.DEV_LOGIN_ENABLED,
        ai: llm.configured,
        judge: jev.configured,
        ocr: ocr.configured,
        limits: { textChars: TEXT_LIMIT, imageBytes: IMAGE_LIMIT },
      },
    }));
    app.post(
      "/v1/auth/dev-login",
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (req) => {
        const body = z
          .object({
            key: z
              .string()
              .regex(/^[a-z0-9_-]{1,32}$/)
              .default("owner"),
            nickname: z.string().trim().min(1).max(30).default("开发者"),
          })
          .strict()
          .parse(req.body || {});
        return { data: auth.dev(body.key, body.nickname) };
      },
    );
    app.post(
      "/v1/auth/wechat-login",
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (req) => {
        const body = z
          .object({ code: z.string().min(4).max(256) })
          .strict()
          .parse(req.body);
        return { data: await auth.wechat(body.code) };
      },
    );
    app.get("/v1/auth/me", async (req) => ({
      data: publicUser(auth.require(req)),
    }));
    app.post("/v1/auth/logout", async (req) => {
      auth.logout(req);
      return { data: { revoked: true } };
    });
    app.get("/v1/jobs/:id", async (req) => {
      const user = auth.require(req);
      const job = runner.get((req.params as { id: string }).id);
      if (!job || job.userId !== user.id)
        throw new AppError(404, "NOT_FOUND", "任务不存在");
      return { data: publicJob(job) };
    });
    registerMaterialRoutes(app, { auth, materials, runner });
    registerStudyRoutes(app, { auth, study, runner });
    registerReviewRoutes(app, { auth, reviews });
    const formulas = new FormulaRenderer(env.FORMULA_DIR);
    // Formula images are only a cache; without pruning the folder grows with
    // every new formula ever shown. Once at start, then daily; the
    // daily job is started below, once the chat service exists.
    const pruneFormulas = () => {
      const removed = formulas.prune(30 * 86400000);
      if (removed) app.log.info({ removed }, "formula cache pruned");
    };
    const markdown = new MarkdownRenderer(formulas);
    registerRenderRoutes(app, { auth, formulas, markdown });
    registerAssetRoutes(app);
    registerLegalRoutes(app, { legal: new LegalService(markdown) });
    const chat = new ChatService({
      now: businessNow,
      store,
      materials,
      study,
      runner,
      llm,
      vision: models.client("photo"),
      jev,
      markdown,
      mistakes,
      uploadDir: env.UPLOAD_DIR,
      limits: { answers: env.CHAT_DAILY_LIMIT, photos: env.PHOTO_DAILY_LIMIT },
      limitFor: (userId, bucket) => limits.for(userId, bucket),
      budget,
      log: (error, context) => app.log.warn(safeError(error), context),
    });
    registerChatRoutes(app, { auth, chat });
    // The daily job: the formula cache, and chat uploads left unsent for a
    // day by anyone (0.6.0; their owner's next visit drops them too).
    const daily = () => {
      pruneFormulas();
      const dropped = chat.sweepStale();
      if (dropped) app.log.info({ dropped }, "unsent chat attachments pruned");
    };
    daily();
    const pruning = setInterval(daily, 86400000);
    pruning.unref();
    app.addHook("onClose", async () => clearInterval(pruning));
    registerMoodRoutes(app, {
      auth,
      mood: new MoodService(
        store,
        {
          stopThreads: (ids) => chat.cancelThreads([...ids]),
          stopJobs: (_userId, ids) => runner.cancel(ids),
          removeThread: (userId, id) => chat.removeRecords(userId, id),
        },
        businessNow,
      ),
    });
    registerMistakeRoutes(app, { auth, mistakes, markdown });
    registerHomeRoutes(app, {
      auth,
      home: new HomeService(store, chat, mistakes, businessNow),
    });
    registerLearnRoutes(app, {
      auth,
      learn: new LearnService(store, businessNow, {
        llm,
        safety,
        limitFor: (userId) => limits.for(userId, "chat"),
        budget,
      }),
      markdown,
    });
    registerNoteRoutes(app, {
      auth,
      notes,
      runner,
      readOnly: options.legacyNotesReadOnly ?? env.LEGACY_NOTES_READ_ONLY,
    });
    registerImportRoutes(app, { auth, imports, runner });
    registerBrainstormRoutes(app, { auth, brainstorms, runner });
    registerCardRoutes(app, { auth, cards, tidy, merges, runner });
    registerResumeRoutes(app, {
      auth,
      resume: new ResumeService(store, cards, safety, businessNow),
      tidy,
      runner,
    });
    registerAccountRoutes(app, {
      auth,
      account: new AccountService(store, materials, runner, {
        ai: env.DAILY_AI_LIMIT,
        ocr: env.DAILY_OCR_LIMIT,
        notes: env.DAILY_NOTES_LIMIT,
        chat: env.CHAT_DAILY_LIMIT,
        photos: env.PHOTO_DAILY_LIMIT,
        brainstorm: env.DAILY_BRAINSTORM_LIMIT,
        import: env.DAILY_IMPORT_LIMIT,
      }, budget),
    });
    registerStudyTimeRoutes(app, {
      auth,
      studyTime: new StudyTimeService(store),
    });
    registerAdminSessionRoutes(app, auth);
    registerAdminAiRoutes(app, { auth, store, models });
    registerAdminManageRoutes(app, {
      auth,
      store,
      runner,
      limits,
      models,
      budget,
    });
    app.get("/v1/admin/overview", async (req) => {
      auth.admin(req);
      return {
        data: {
          users: userCount(),
          uptimeSec: Math.floor((Date.now() - started) / 1000),
        },
      };
    });
    app.get("/v1/admin/audit", async (req) => {
      auth.admin(req);
      const day = z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional();
      const q = z
        .object({
          action: z.string().trim().max(64).optional(),
          actor: z.string().trim().max(64).optional(),
          from: day,
          to: day,
        })
        .strict()
        .parse(req.query ?? {});
      // Dates are Beijing calendar days; "to" includes the whole day.
      const at = (date: string, days = 0) =>
        new Date(
          Date.parse(`${date}T00:00:00+08:00`) + days * 86400_000,
        ).toISOString();
      return {
        data: store.audits({
          action: q.action || undefined,
          actor: q.actor || undefined,
          from: q.from ? at(q.from) : undefined,
          to: q.to ? at(q.to, 1) : undefined,
        }),
      };
    });
    app.get("/v1/admin/operations", async (req) => {
      auth.admin(req);
      store.health();
      return {
        data: {
          database: "ok",
          mode: env.NODE_ENV,
          metrics: {
            requestCount,
            errorCount,
            avgDurationMs: requestCount
              ? Math.round((totalDurationMs / requestCount) * 100) / 100
              : 0,
          },
          startedAt: new Date(started).toISOString(),
          process: {
            uptimeSec: Math.floor(process.uptime()),
            rssBytes: process.memoryUsage().rss,
            heapUsedBytes: process.memoryUsage().heapUsed,
            nodeVersion: process.version,
          },
          security: {
            adminSessions: true,
            adminIdleTimeoutSec: 900,
            adminAbsoluteTimeoutSec: 28800,
            adminOriginConfigured: Boolean(env.ADMIN_ORIGIN),
            secureCookies: env.NODE_ENV === "production",
            devLoginEnabled: env.DEV_LOGIN_ENABLED,
            proxyMode: env.TRUST_PROXY,
          },
          integrations: {
            wechat: Boolean(env.WECHAT_APP_ID && env.WECHAT_APP_SECRET),
            ai: llm.configured,
            judge: jev.configured,
            ocr: ocr.configured,
          },
          backup: {
            status: "unknown",
            note: "未接入备份执行记录；请按运维手册定期备份并验证恢复",
          },
          accounting: {
            status: usageMeter.accountingWriteFailures ? "degraded" : "ok",
            writeFailures: usageMeter.accountingWriteFailures,
          },
        },
      };
    });
    registerAdminRoutes(app, {
      auth,
      // Getters: the global limits are admin-editable, read per request.
      admin: new AdminService(store, runner, {
        get limits() {
          const {
            ai,
            ocr,
            notes,
            brainstorm,
            import: importing,
          } = limits.global();
          return { ai, ocr, notes, brainstorm, import: importing };
        },
        uploadDir: env.UPLOAD_DIR,
        get chatLimits() {
          const { chat, photos } = limits.global();
          return { answers: chat, photos };
        },
      }),
    });
    const adminRoot = new URL("../../admin/", import.meta.url);
    for (const [url, file, type] of [
      ["/admin", "index.html", "text/html"],
      ["/admin/", "index.html", "text/html"],
      ["/admin/app.js", "app.js", "text/javascript"],
      ["/admin/model.mjs", "model.mjs", "text/javascript"],
      ["/admin/styles.css", "styles.css", "text/css"],
    ] as const)
      app.get(url, { config: { rateLimit: false } }, async (_req, reply) => {
        try {
          return reply
            .type(type)
            .send(await readFile(new URL(file, adminRoot), "utf8"));
        } catch {
          throw new AppError(404, "NOT_FOUND", "管理页面未安装");
        }
      });
  });
  return app;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const env = loadEnv(),
    app = buildApp({ env });
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  app.listen({ port: env.PORT, host: env.HOST }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
