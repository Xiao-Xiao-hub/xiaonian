/*
 * 公式图片接口：根据渲染模块生成的标识读取缓存图片，供小程序富文本组件展示。
 * 公式生成与缓存写入由 formula.ts 负责；此入口只按既定标识提供对应资源。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../../shared/domain.js";
import type { AuthService } from "../auth/service.js";
import type { FormulaRenderer } from "./formula.js";
import type { MarkdownRenderer } from "./markdown.js";
import { onResponseEnd } from "../../shared/response-lifecycle.js";
// Formula ink per skin tone; the image cache is keyed by colour.
export const INK = { light: "#1f2937", dark: "#e5e7eb" } as const;
export type Tone = keyof typeof INK;
export const toneSchema = z.enum(["light", "dark"]).default("light");
export const RENDER_ACTIVE_PER_USER = 2;
export const RENDER_WAITING_PER_USER = 64;
export const RENDER_WAIT_MS = 20_000;
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
  const users = new Map<string, { active: number; waiting: (() => void)[] }>();
  const busy = () => new AppError(429, "RENDER_BUSY", "你的排版任务较多，请稍后再试");
  const disconnected = () => new AppError(499, "REQUEST_ABORTED", "请求已取消");
  const acquire = (userId: string, req: FastifyRequest, reply: FastifyReply) => {
    const state = users.get(userId) ?? { active: 0, waiting: [] };
    if (state.active >= RENDER_ACTIVE_PER_USER && state.waiting.length >= RENDER_WAITING_PER_USER)
      return Promise.reject(busy());
    users.set(userId, state);
    return new Promise<() => void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let endResponse: (() => void) | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        req.raw.removeListener("aborted", abort);
        const index = state.waiting.indexOf(enter);
        if (index >= 0) state.waiting.splice(index, 1);
        // onResponseEnd's returned disposer also invokes its callback.
        // Mark settled before disposing so cleanup cannot cancel admission.
        endResponse?.();
      };
      const cancel = (error: AppError) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!state.active && !state.waiting.length) users.delete(userId);
        reject(error);
      };
      const abort = () => cancel(disconnected());
      const enter = () => {
        if (settled) return;
        settled = true;
        cleanup();
        state.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          state.active--;
          // Only two requests per user enter the shared formula worker queue;
          // waiting pages consume no worker slots and cannot crowd out others.
          if (state.waiting.length) state.waiting[0]!();
          else if (!state.active) users.delete(userId);
        });
      };
      req.raw.once("aborted", abort);
      endResponse = onResponseEnd(reply.raw, abort);
      if (req.raw.aborted || req.raw.socket?.destroyed) abort();
      if (settled) return;
      if (state.active < RENDER_ACTIVE_PER_USER) enter();
      else {
        state.waiting.push(enter);
        timer = setTimeout(() => cancel(busy()), RENDER_WAIT_MS);
        timer.unref();
      }
    });
  };
  app.post("/v1/render", async (req, reply) => {
    const user = auth.require(req);
    const body = z
      .object({ text: z.string().max(8000), tone: toneSchema })
      .strict()
      .parse(req.body);
    const release = await acquire(user.id, req, reply);
    try {
      if (req.raw.aborted || reply.raw.destroyed || reply.raw.socket?.destroyed)
        throw disconnected();
      return { data: { blocks: await markdown.render(body.text, INK[body.tone]) } };
    } finally {
      release();
    }
  });
}
