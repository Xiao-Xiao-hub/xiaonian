/*
 * 账号数据与额度接口层：把 HTTP 路径、查询和请求体转换为服务调用。
 * 从 auth 获取当前用户，并校验外部输入；数据归属、版本和状态转换仍由对应服务负责。
 * 新增接口时同步维护 API 文档，并在 tests 中验证正常流程与权限、版本冲突等边界。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import type { AccountService } from "./service.js";
export function registerAccountRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService; account: AccountService },
) {
  const { auth, account } = deps;
  app.get("/v1/me/usage", async (req) => {
    const user = auth.require(req, { allowBanned: true });
    return { data: account.usage(user.id) };
  });
  // A file download, so the body is the export itself rather than { data }.
  app.get("/v1/me/export", async (req, reply) => {
    const user = auth.require(req, { allowBanned: true });
    const data = account.export(user);
    const day = data.exportedAt.slice(0, 10);
    return reply
      .type("application/json; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="export-${day}.json"; filename*=UTF-8''${encodeURIComponent(`晓念数据导出-${day}.json`)}`,
      )
      .send(JSON.stringify(data, null, 2));
  });
  // Agreement to the three documents and the age band. Allowed
  // for a stopped account too, like export and deletion.
  app.put("/v1/me/consent", async (req) => {
    const user = auth.require(req, { allowBanned: true });
    const body = z
      .object({
        version: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d{1,3}$/),
        ageBand: z.enum(["adult", "child"]),
        guardian: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    return { data: account.consent(user.id, body) };
  });
  app.get("/v1/me/consent", async (req) => {
    const user = auth.require(req, { allowBanned: true });
    return { data: account.consentOf(user) };
  });
  // Revoking: recorded only; the data stays until the user deletes it.
  app.delete("/v1/me/consent", async (req) => {
    const user = auth.require(req, { allowBanned: true });
    return { data: account.withdraw(user.id) };
  });
  // 个性化学习推荐 and 学习时长统计.
  app.get("/v1/me/prefs", async (req) => {
    const user = auth.require(req, { allowBanned: true });
    return { data: account.prefs(user) };
  });
  app.put("/v1/me/prefs", async (req) => {
    const user = auth.require(req, { allowBanned: true });
    const body = z
      .object({
        personalized: z.boolean().optional(),
        studyTime: z.boolean().optional(),
      })
      .strict()
      .refine((b) => b.personalized !== undefined || b.studyTime !== undefined)
      .parse(req.body);
    return { data: account.setPrefs(user.id, body) };
  });
  app.delete("/v1/me", async (req) => {
    const user = auth.require(req, { allowBanned: true });
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    account.erase(user.id);
    return { data: { deleted: true } };
  });
}
