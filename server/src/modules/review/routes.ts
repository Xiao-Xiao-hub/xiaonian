/*
 * 资料复习接口层：把 HTTP 路径、查询和请求体转换为服务调用。
 * 从 auth 获取当前用户，并校验外部输入；数据归属、版本和状态转换仍由对应服务负责。
 * 新增接口时同步维护 API 文档，并在 tests 中验证正常流程与权限、版本冲突等边界。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import type { ReviewService } from "./service.js";
const idParams = z.object({ id: z.string().min(1).max(64) });
export function registerReviewRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService; reviews: ReviewService },
) {
  const { auth, reviews } = deps;
  app.post("/v1/materials/:id/review", async (req) => {
    const user = auth.require(req);
    return { data: reviews.add(user.id, idParams.parse(req.params).id) };
  });
  app.delete("/v1/materials/:id/review", async (req) => {
    const user = auth.require(req);
    reviews.remove(user.id, idParams.parse(req.params).id);
    return { data: { removed: true } };
  });
  app.get("/v1/reviews", async (req) => {
    const user = auth.require(req);
    return { data: reviews.list(user.id) };
  });
  app.post("/v1/reviews/:id", async (req) => {
    const user = auth.require(req);
    const { outcome } = z
      .object({ outcome: z.enum(["remembered", "forgot"]) })
      .strict()
      .parse(req.body);
    return {
      data: reviews.answer(user.id, idParams.parse(req.params).id, outcome),
    };
  });
}
