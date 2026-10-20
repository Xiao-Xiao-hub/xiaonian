/*
 * 法律文件公开接口：按允许的文档名称返回协议内容及版本，不依赖用户登录。
 * 文件解析交给 LegalService，页面展示仍需保留同意与撤回的业务流程。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../../shared/domain.js";
import { LEGAL_DOCS, type LegalDoc, type LegalService } from "./service.js";
// 用户协议、隐私政策、儿童隐私政策. Public on purpose, like
// /v1/formula: the welcome page shows them before anyone agrees or logs in.
export function registerLegalRoutes(
  app: FastifyInstance,
  deps: { legal: LegalService },
) {
  app.get(
    "/v1/legal/:doc",
    { config: { rateLimit: { max: 1200, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { doc } = z.object({ doc: z.string().max(32) }).parse(req.params);
      if (!(LEGAL_DOCS as readonly string[]).includes(doc))
        throw new AppError(404, "NOT_FOUND", "没有这份文件");
      const data = await deps.legal.view(doc as LegalDoc);
      return reply.header("cache-control", "public, max-age=3600").send({ data });
    },
  );
}
