/*
 * 学习时长接口层：把 HTTP 路径、查询和请求体转换为服务调用。
 * 从 auth 获取当前用户，并校验外部输入；数据归属、版本和状态转换仍由对应服务负责。
 * 新增接口时同步维护 API 文档，并在 tests 中验证正常流程与权限、版本冲突等边界。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import { MAX_REPORT, type StudyTimeService } from "./service.js";
// 学习时长: report seconds, read the heat map, delete it all.
export function registerStudyTimeRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService; studyTime: StudyTimeService },
) {
  const { auth, studyTime } = deps;
  app.post("/v1/me/study-time", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({ seconds: z.number().int().min(1).max(MAX_REPORT) })
      .strict()
      .parse(req.body);
    return { data: studyTime.record(user, body.seconds) };
  });
  // Reading and deleting stay open for a stopped account, like export.
  app.get("/v1/me/study-time", async (req) => {
    const user = auth.require(req, { allowBanned: true });
    return { data: studyTime.view(user) };
  });
  app.delete("/v1/me/study-time", async (req) => {
    const user = auth.require(req, { allowBanned: true });
    return { data: studyTime.erase(user.id) };
  });
}
