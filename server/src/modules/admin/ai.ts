/*
 * 外部大模型接口管理：提供接口配置、顺序、启用状态、测试与场景思考程度的管理入口。
 * 配置保存在数据库，供 providers/model-router.ts 读取；响应不能把已保存的密钥回显给浏览器。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../../shared/domain.js";
import type { SqliteStore } from "../../shared/store.js";
import { SCENARIOS, type CanonicalScenario } from "../../providers/llm.js";
import {
  FORMATS,
  LEVELS,
  newEndpointId,
  type Endpoint,
  type ModelRouter,
} from "../../providers/model-router.js";
import type { AuthService } from "../auth/service.js";

const ACTOR = "admin:shared";
const idParams = z.object({ id: z.string().min(1).max(64) }).strict();
// The request already sets these; an extra body may not replace them.
const RESERVED = ["model", "messages", "stream", "response_format"];
const fields = {
  alias: z.string().trim().min(1).max(32),
  baseUrl: z
    .string()
    .trim()
    .url()
    .max(300)
    .refine((u) => /^https?:\/\//.test(u), "只支持 http 或 https"),
  apiKey: z.string().trim().min(1).max(512),
  model: z.string().trim().min(1).max(128),
  vision: z.boolean(),
  thinkingFormat: z.enum(FORMATS),
  extraBody: z
    .record(z.string(), z.unknown())
    .refine(
      (body) => !RESERVED.some((key) => key in body),
      `附加参数不能包含 ${RESERVED.join("、")}`,
    ),
  timeoutMs: z.number().int().min(5000).max(120000),
  enabled: z.boolean(),
};
const createInput = z
  .object({
    ...fields,
    vision: fields.vision.default(false),
    thinkingFormat: fields.thinkingFormat.default("none"),
    extraBody: fields.extraBody.default({}),
    timeoutMs: fields.timeoutMs.default(90000),
    enabled: fields.enabled.default(true),
  })
  .strict();
// An empty or missing key keeps the stored one, since it is never sent back.
const updateInput = z
  .object({ ...fields, apiKey: z.string().trim().max(512) })
  .partial()
  .strict();
const COLUMNS: Record<string, string> = {
  alias: "alias",
  baseUrl: "base_url",
  apiKey: "api_key",
  model: "model",
  vision: "vision",
  thinkingFormat: "thinking_format",
  extraBody: "extra_body",
  timeoutMs: "timeout_ms",
  enabled: "enabled",
};
const column = (key: string, value: unknown) =>
  typeof value === "boolean"
    ? Number(value)
    : key === "extraBody"
      ? JSON.stringify(value)
      : value;
const keyHint = (key: string) =>
  key.length > 8 ? `…${key.slice(-4)}` : "已设置";
const uniqueAlias = (error: unknown) => {
  if (String((error as Error)?.message).includes("UNIQUE"))
    throw new AppError(409, "ALIAS_TAKEN", "这个名称已经有接口在用");
  throw error;
};

// AI endpoints and per-scenario thinking levels. Keys are write-only:
// reads show the last four characters, audits never include them.
export function registerAdminAiRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService; store: SqliteStore; models: ModelRouter },
) {
  const { auth, store, models } = deps;
  const db = store.db;
  const find = (id: string): Endpoint => {
    const found = models.endpoints().find((e) => e.id === id);
    if (!found) throw new AppError(404, "NOT_FOUND", "没有这个接口");
    return found;
  };
  const view = () => {
    const since = new Date(Date.parse(store.now()) - 86400000).toISOString();
    const stats = new Map(
      (
        db
          .prepare(
            "SELECT endpoint,COUNT(*) AS calls,SUM(status='succeeded') AS succeeded,SUM(status='failed') AS failed,SUM(status IN ('unknown','pending')) AS unknown,SUM(prompt_tokens) AS promptTokens,SUM(completion_tokens) AS completionTokens,CAST(AVG(duration_ms) AS INTEGER) AS avgMs FROM usage_ledger WHERE created_at>=? AND endpoint IS NOT NULL AND source!='llm.test' GROUP BY endpoint",
          )
          .all(since) as Record<string, unknown>[]
      ).map((r) => [String(r.endpoint), r]),
    );
    return {
      endpoints: models.endpoints().map(({ apiKey, ...e }) => {
        const s = stats.get(e.alias);
        return {
          ...e,
          keyHint: keyHint(apiKey),
          health: models.healthOf(e.id),
          last24h: {
            calls: Number(s?.calls ?? 0),
            succeeded: Number(s?.succeeded ?? 0),
            failed: Number(s?.failed ?? 0),
            unknown: Number(s?.unknown ?? 0),
            promptTokens: Number(s?.promptTokens ?? 0),
            completionTokens: Number(s?.completionTokens ?? 0),
            avgMs: s?.avgMs == null ? null : Number(s.avgMs),
          },
        };
      }),
      thinking: models.thinking(),
      routes: models.routes(),
      scenarios: SCENARIOS,
      formats: FORMATS,
      levels: LEVELS,
    };
  };
  app.get("/v1/admin/ai", async (req) => {
    auth.admin(req);
    return { data: view() };
  });
  app.post("/v1/admin/ai/endpoints", async (req) => {
    auth.admin(req);
    const body = createInput.parse(req.body);
    const id = newEndpointId();
    const now = store.now();
    try {
      store.transaction(() => {
        const { next } = db
          .prepare(
            "SELECT COALESCE(MAX(position),-1)+1 AS next FROM ai_endpoints",
          )
          .get() as { next: number };
        db.prepare(
          "INSERT INTO ai_endpoints(id,alias,base_url,api_key,model,vision,thinking_format,extra_body,timeout_ms,position,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          id,
          body.alias,
          body.baseUrl,
          body.apiKey,
          body.model,
          Number(body.vision),
          body.thinkingFormat,
          JSON.stringify(body.extraBody),
          body.timeoutMs,
          next,
          Number(body.enabled),
          now,
          now,
        );
        store.audit(ACTOR, "ai.endpoint.created", id, {
          alias: body.alias,
          model: body.model,
          requestId: req.id,
        });
      });
    } catch (error) {
      uniqueAlias(error);
    }
    return { data: view() };
  });
  app.put("/v1/admin/ai/endpoints/:id", async (req) => {
    auth.admin(req);
    const { id } = idParams.parse(req.params);
    const body = updateInput.parse(req.body);
    if (!body.apiKey) delete body.apiKey;
    const changed = Object.keys(body);
    if (!changed.length) return { data: view() };
    const before = find(id);
    try {
      store.transaction(() => {
        db.prepare(
          `UPDATE ai_endpoints SET ${changed.map((k) => `${COLUMNS[k]}=?`).join(",")},updated_at=? WHERE id=?`,
        ).run(
          ...changed.map(
            (k) => column(k, body[k as keyof typeof body]) as string | number,
          ),
          store.now(),
          id,
        );
        store.audit(ACTOR, "ai.endpoint.updated", id, {
          alias: body.alias ?? before.alias,
          changed: changed.map((k) => (k === "apiKey" ? "apiKey(新密钥)" : k)),
          requestId: req.id,
        });
      });
    } catch (error) {
      uniqueAlias(error);
    }
    // A new address, key or model deserves a fresh start.
    if (body.apiKey || body.baseUrl || body.model) models.forget(id);
    return { data: view() };
  });
  app.delete("/v1/admin/ai/endpoints/:id", async (req) => {
    auth.admin(req);
    const { id } = idParams.parse(req.params);
    const before = find(id);
    store.transaction(() => {
      db.prepare("DELETE FROM ai_endpoints WHERE id=?").run(id);
      store.audit(ACTOR, "ai.endpoint.deleted", id, {
        alias: before.alias,
        requestId: req.id,
      });
    });
    models.forget(id);
    return { data: view() };
  });
  app.put("/v1/admin/ai/order", async (req) => {
    auth.admin(req);
    const { ids } = z
      .object({ ids: z.array(z.string().min(1).max(64)).max(50) })
      .strict()
      .parse(req.body);
    const current = models.endpoints().map((e) => e.id);
    if (
      ids.length !== current.length ||
      new Set(ids).size !== ids.length ||
      !ids.every((id) => current.includes(id))
    )
      throw new AppError(409, "ORDER_STALE", "接口列表已变化，请刷新后再排序");
    store.transaction(() => {
      const move = db.prepare("UPDATE ai_endpoints SET position=? WHERE id=?");
      ids.forEach((id, position) => move.run(position, id));
      store.audit(ACTOR, "ai.order.updated", "ai-endpoints", {
        requestId: req.id,
      });
    });
    return { data: view() };
  });
  app.post("/v1/admin/ai/endpoints/:id/test", async (req) => {
    auth.admin(req);
    const { id } = idParams.parse(req.params);
    const { level } = z
      .object({ level: z.enum(LEVELS).default("off") })
      .strict()
      .parse(req.body ?? {});
    const endpoint = find(id);
    const result = await models.test(endpoint, level);
    store.audit(ACTOR, "ai.endpoint.tested", id, {
      alias: endpoint.alias,
      ok: result.ok,
      code: result.ok ? null : result.code,
      requestId: req.id,
    });
    return { data: { result, ...view() } };
  });
  app.put("/v1/admin/ai/thinking", async (req) => {
    auth.admin(req);
    const level = z.enum(LEVELS).optional();
    const body = z.record(level).parse(req.body);
    if (
      !Object.keys(body).every((scenario) =>
        (SCENARIOS as readonly string[]).includes(scenario),
      )
    )
      throw new AppError(400, "VALIDATION_ERROR", "包含不支持的场景");
    const next = { ...models.thinking(), ...body };
    store.transaction(() => {
      db.prepare(
        "INSERT INTO settings(key,value,updated_at) VALUES('ai.thinking',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      ).run(JSON.stringify(next), store.now());
      store.audit(ACTOR, "ai.thinking.updated", "ai-thinking", {
        ...next,
        requestId: req.id,
      });
    });
    return { data: view() };
  });
  app.get("/v1/admin/ai/routes", async (req) => {
    auth.admin(req);
    return { data: { routes: models.routes() } };
  });
  app.put("/v1/admin/ai/routes", async (req) => {
    auth.admin(req);
    const body = z
      .record(z.array(z.string().min(1).max(64)).max(50))
      .parse(req.body);
    const endpointIds = new Set(
      models.endpoints().map((endpoint) => endpoint.id),
    );
    for (const [scenario, ids] of Object.entries(body)) {
      if (!(SCENARIOS as readonly string[]).includes(scenario))
        throw new AppError(400, "VALIDATION_ERROR", "包含不支持的场景");
      if (
        new Set(ids).size !== ids.length ||
        !ids.every((id) => endpointIds.has(id))
      )
        throw new AppError(400, "VALIDATION_ERROR", "接口列表无效");
    }
    const next = { ...models.routes(), ...body };
    store.transaction(() => {
      db.prepare(
        "INSERT INTO settings(key,value,updated_at) VALUES('ai.routes',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      ).run(JSON.stringify(next), store.now());
      store.audit(ACTOR, "ai.routes.updated", "ai-routes", {
        routes: next as Partial<Record<CanonicalScenario, string[]>>,
        requestId: req.id,
      });
    });
    return { data: { routes: models.routes() } };
  });
}
