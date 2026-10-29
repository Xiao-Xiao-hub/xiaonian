/*
 * 错题记录接口层：把 HTTP 路径、查询和请求体转换为服务调用。
 * 从 auth 获取当前用户，并校验外部输入；数据归属、版本和状态转换仍由对应服务负责。
 * 新增接口时同步维护 API 文档，并在 tests 中验证正常流程与权限、版本冲突等边界。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import type { MarkdownRenderer } from "../render/markdown.js";
import { INK, toneSchema } from "../render/routes.js";
import type { MistakeService } from "./service.js";
const idParams = z.object({ id: z.string().min(1).max(64) });
const status = z.enum(["open", "mastered"]);
export function registerMistakeRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthService;
    mistakes: MistakeService;
    markdown: MarkdownRenderer;
  },
) {
  const { auth, mistakes, markdown } = deps;
  app.get("/v1/mistakes", async (req) => {
    const user = auth.require(req);
    const query = z
      .object({
        status: status.default("open"),
        tone: toneSchema,
        pointId: z.string().min(1).max(64).optional(),
        // paging and the chapter filter (as counts.chapters names it);
        // without them the first 200, as before.
        offset: z.coerce.number().int().min(0).max(100000).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        chapter: z.string().min(1).max(32).optional(),
      })
      .passthrough()
      .parse(req.query);
    const page = mistakes.list(user.id, query.status, query.pointId, {
      offset: query.offset,
      limit: query.limit,
      chapter: query.chapter,
    });
    const items = [];
    for (const item of page.items)
      items.push({ ...item, blocks: await markdown.render(item.problem, INK[query.tone]) });
    return {
      data: {
        items,
        counts: mistakes.counts(user.id, query.pointId),
        more: page.more,
      },
    };
  });
  app.post("/v1/mistakes/:id", async (req) => {
    const user = auth.require(req);
    const body = z.object({ status }).strict().parse(req.body);
    mistakes.setStatus(user.id, idParams.parse(req.params).id, body.status);
    return { data: { status: body.status } };
  });
  app.delete("/v1/mistakes/:id", async (req) => {
    const user = auth.require(req);
    mistakes.remove(user.id, idParams.parse(req.params).id);
    return { data: { deleted: true } };
  });
}
