/*
 * 头脑风暴接口层：把 HTTP 路径、查询和请求体转换为服务调用。
 * 从 auth 获取当前用户，并校验外部输入；数据归属、版本和状态转换仍由对应服务负责。
 * 新增接口时同步维护 API 文档，并在 tests 中验证正常流程与权限、版本冲突等边界。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import type { JobRunner } from "../jobs/runner.js";
import { picksSchema } from "./schema.js";
import type { BrainstormService } from "./service.js";

const idParams = z.object({ id: z.string().min(1).max(80) }).strict();
const clientId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);

export function registerBrainstormRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthService;
    brainstorms: BrainstormService;
    runner: JobRunner;
  },
) {
  const { auth, brainstorms, runner } = deps;
  app.post("/v1/brainstorms", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        clientId,
        cardIds: z.array(z.string().min(1).max(80)).min(3).max(50),
      })
      .strict()
      .parse(req.body);
    const row = await brainstorms.create(user.id, body, runner);
    return {
      data: {
        brainstorm: brainstorms.detail(user.id, String(row.id), runner),
      },
    };
  });
  app.get("/v1/brainstorms/suggest", async (req) => {
    const user = auth.require(req);
    const query = z
      .object({
        kind: z.enum(["chapter", "import"]).optional(),
        sourceId: z.string().min(1).max(80).optional(),
      })
      .strict()
      .refine(
        (value) => Boolean(value.kind) === Boolean(value.sourceId),
        "kind 和 sourceId 须同时提供",
      )
      .parse(req.query ?? {});
    return { data: { items: brainstorms.suggest(user.id, query) } };
  });
  app.post("/v1/brainstorms/suggest/dismiss", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        kind: z.enum(["chapter", "import"]),
        sourceId: z.string().min(1).max(80),
      })
      .strict()
      .parse(req.body);
    brainstorms.dismiss(user.id, body.kind, body.sourceId);
    return { data: { dismissed: true } };
  });
  // ?open=1 : unfinished brainstorms of the last 7 days, small rows.
  app.get("/v1/brainstorms", async (req) => {
    const user = auth.require(req);
    const { open } = z
      .object({ open: z.enum(["0", "1", "true", "false"]).optional() })
      .parse(req.query ?? {});
    return {
      data: {
        items:
          open === "1" || open === "true"
            ? brainstorms.open(user.id, runner)
            : brainstorms.list(user.id, runner),
      },
    };
  });
  app.get("/v1/brainstorms/:id", async (req) => {
    const user = auth.require(req);
    return {
      data: brainstorms.detail(user.id, idParams.parse(req.params).id, runner),
    };
  });
  app.put("/v1/brainstorms/:id/picks", async (req) => {
    const user = auth.require(req),
      id = idParams.parse(req.params).id;
    brainstorms.update(user.id, id, picksSchema.parse(req.body));
    return { data: { brainstorm: brainstorms.detail(user.id, id, runner) } };
  });
  app.post("/v1/brainstorms/:id/save", async (req) => {
    const user = auth.require(req),
      id = idParams.parse(req.params).id,
      body = z.object({ clientId }).strict().parse(req.body);
    return { data: await brainstorms.save(user.id, id, body.clientId) };
  });
  app.post("/v1/brainstorms/:id/report", async (req) => {
    const user = auth.require(req),
      id = idParams.parse(req.params).id,
      body = z
        .object({
          clientId: z.string().min(8).max(80),
          // V4.2 : write a stale report again.
          refresh: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
    return {
      data: brainstorms.report(
        user.id,
        id,
        body.clientId,
        runner,
        body.refresh ?? false,
      ),
    };
  });
  app.delete("/v1/brainstorms/:id", async (req) => {
    const user = auth.require(req);
    brainstorms.remove(user.id, idParams.parse(req.params).id, runner);
    return { data: { deleted: true } };
  });
}
