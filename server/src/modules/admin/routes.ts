/*
 * 管理台读取接口：先校验管理员会话，再调用 AdminService 返回聚合数据。
 * 写操作分别放在 manage.ts 和 ai.ts；不要把普通用户鉴权当成管理员权限。
 */
import type { FastifyInstance } from "fastify";
import type { AuthService } from "../auth/service.js";
import type { AdminService } from "./service.js";
export function registerAdminRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService; admin: AdminService },
) {
  const { auth, admin } = deps;
  app.get("/v1/admin/jobs", async (req) => {
    auth.admin(req);
    return { data: admin.jobs() };
  });
  app.get("/v1/admin/quality", async (req) => {
    auth.admin(req);
    return { data: admin.quality() };
  });
  app.get("/v1/admin/usage", async (req) => {
    auth.admin(req);
    return { data: admin.usage() };
  });
}
