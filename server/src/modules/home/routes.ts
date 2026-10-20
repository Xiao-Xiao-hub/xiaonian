/*
 * 首页汇总接口层：把 HTTP 路径、查询和请求体转换为服务调用。
 * 从 auth 获取当前用户，并校验外部输入；数据归属、版本和状态转换仍由对应服务负责。
 * 新增接口时同步维护 API 文档，并在 tests 中验证正常流程与权限、版本冲突等边界。
 */
import type { FastifyInstance } from "fastify";
import type { AuthService } from "../auth/service.js";
import type { HomeService } from "./service.js";
export function registerHomeRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService; home: HomeService },
) {
  const { auth, home } = deps;
  app.get("/v1/home", async (req) => {
    const user = auth.require(req);
    return { data: home.summary(user.id) };
  });
}
