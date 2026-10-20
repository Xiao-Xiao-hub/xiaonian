/*
 * 心情记录与单独同意接口：查询、删除心情记录，提交或撤回处理心情内容的同意。
 * 从 auth 获取当前用户，并校验外部输入；数据归属、版本和状态转换仍由对应服务负责。
 * 新增接口时同步维护 API 文档，并在 tests 中验证正常流程与权限、版本冲突等边界。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import type { MoodService } from "./mood.js";

export function registerMoodRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService; mood: MoodService },
) {
  const { auth, mood } = deps;
  app.get("/v1/mood", async (req) => ({ data: mood.list(auth.require(req).id) }));
  // { guardian: true } is required for a child's account.
  app.put("/v1/me/mood-consent", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({ guardian: z.boolean().optional() })
      .strict()
      .parse(req.body ?? {});
    return { data: mood.consent(user.id, body.guardian === true) };
  });
  app.delete("/v1/me/mood-consent", async (req) => {
    const user = auth.require(req);
    mood.withdrawConsent(user.id);
    return { data: { deleted: true } };
  });
  app.delete("/v1/mood", async (req) => {
    const user = auth.require(req);
    mood.remove(user.id);
    return { data: { deleted: true } };
  });
}
