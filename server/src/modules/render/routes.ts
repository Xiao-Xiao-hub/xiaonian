/*
 * 公式图片接口：根据渲染模块生成的标识读取缓存图片，供小程序富文本组件展示。
 * 公式生成与缓存写入由 formula.ts 负责；此入口只按既定标识提供对应资源。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../../shared/domain.js";
import type { AuthService } from "../auth/service.js";
import type { FormulaRenderer } from "./formula.js";
import type { MarkdownRenderer } from "./markdown.js";
// Formula ink per skin tone; the image cache is keyed by colour.
export const INK = { light: "#1f2937", dark: "#e5e7eb" } as const;
export type Tone = keyof typeof INK;
export const toneSchema = z.enum(["light", "dark"]).default("light");
export function registerRenderRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthService;
    formulas: FormulaRenderer;
    markdown: MarkdownRenderer;
  },
) {
  const { auth, formulas, markdown } = deps;
  // Public on purpose: <image> cannot send the session header, and a formula image
  // holds only typeset maths under an unguessable content hash.
  app.get(
    "/v1/formula/:file",
    { config: { rateLimit: { max: 1200, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { file } = z.object({ file: z.string().max(64) }).parse(req.params);
      const id = /^([0-9a-f]{40})\.png$/.exec(file)?.[1];
      const png = id ? formulas.file(id) : null;
      if (!png) throw new AppError(404, "NOT_FOUND", "公式图片不存在");
      return reply
        .header("cache-control", "public, max-age=31536000, immutable")
        .header("cross-origin-resource-policy", "cross-origin")
        .type("image/png")
        .send(png);
    },
  );
  app.post("/v1/render", async (req) => {
    auth.require(req);
    const body = z
      .object({ text: z.string().max(8000), tone: toneSchema })
      .strict()
      .parse(req.body);
    return {
      data: { blocks: await markdown.render(body.text, INK[body.tone]) },
    };
  });
}
