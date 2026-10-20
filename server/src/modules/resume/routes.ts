/*
 * 卡片回顾与接续接口层：把 HTTP 路径、查询和请求体转换为服务调用。
 * 从 auth 获取当前用户，并校验外部输入；数据归属、版本和状态转换仍由对应服务负责。
 * 新增接口时同步维护 API 文档，并在 tests 中验证正常流程与权限、版本冲突等边界。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import type { CardTidyService } from "../cards/tidy.js";
import type { JobRunner } from "../jobs/runner.js";
import type { ResumeService } from "./service.js";

export function registerResumeRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthService;
    resume: ResumeService;
    tidy: CardTidyService;
    runner: JobRunner;
  },
) {
  const { auth, resume } = deps;
  const id = (params: unknown) =>
    z.object({ id: z.string().min(1).max(80) }).parse(params).id;
  app.get("/v1/resume/settings", async (req) => ({
    data: resume.settings(auth.require(req).id),
  }));
  app.put("/v1/resume/settings", async (req) => ({
    data: resume.setSettings(auth.require(req).id, req.body),
  }));
  app.get("/v1/resume", async (req) => {
    const query = z
      .object({ state: z.enum(["waiting", "never"]).optional() })
      .parse(req.query);
    return { data: resume.list(auth.require(req).id, query.state) };
  });
  app.post("/v1/resume/open", async (req) => {
    const body = z
      .object({ visitId: z.string().min(1).max(100) })
      .strict()
      .parse(req.body);
    const id = auth.require(req).id;
    return {
      data: {
        ...resume.open(id, body.visitId),
        lastChat: resume.lastChat(id),
        first: resume.isFirst(id),
      },
    };
  });
  app.post("/v1/resume/undo", async (req) => {
    const body = z
      .object({ token: z.string().min(1).max(80) })
      .strict()
      .parse(req.body);
    return { data: resume.undoAct(auth.require(req).id, body.token) };
  });
  app.post("/v1/resume/:id/act", async (req) => {
    const body = z
      .object({
        action: z.enum(["answer", "skip", "never", "remind", "restore"]),
        text: z.string().max(300).optional(),
        remindAt: z.string().datetime({ offset: true }).optional(),
      })
      .strict()
      .parse(req.body);
    return {
      data: await resume.act(auth.require(req).id, id(req.params), body),
    };
  });
  app.post("/v1/resume/:id/ai", async (req) => {
    const user = auth.require(req),
      item = resume.get(user.id, id(req.params));
    const body = z
      .object({ retryUnknown: z.boolean().optional() })
      .strict()
      .parse(req.body ?? {});
    return {
      data: deps.tidy.enqueue(
        user.id,
        item.card.id,
        item.card.version,
        deps.runner,
        { ...body, refresh: true },
      ),
    };
  });
  app.post("/v1/resume/:id/feedback", async (req) => {
    const body = z
      .object({ value: z.enum(["useful", "ok", "bother", "dismiss"]) })
      .strict()
      .parse(req.body);
    return {
      data: resume.feedback(auth.require(req).id, id(req.params), body.value),
    };
  });
  app.post("/v1/resume/:id/when", async (req) => {
    const body = z
      .object({
        when: z.enum(["week", "next_week"]),
        version: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    return {
      data: await resume.when(
        auth.require(req).id,
        id(req.params),
        body.when,
        body.version,
      ),
    };
  });
}
