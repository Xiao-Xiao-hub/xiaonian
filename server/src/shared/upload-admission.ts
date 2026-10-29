import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthService } from "../modules/auth/service.js";
import { AppError } from "./domain.js";
import { onResponseEnd } from "./response-lifecycle.js";

const receiving = new WeakMap<FastifyRequest, () => void>();

// The route releases after reading the bounded file/form, before parsing or
// provider calls. Request/response lifecycle hooks cover early failures too.
export function finishUpload(req: FastifyRequest) {
  receiving.get(req)?.();
}

export function registerUploadAdmission(app: FastifyInstance, auth: Pick<AuthService, "require">) {
  let active = 0;
  const byUser = new Map<string, number>();
  app.addHook("preHandler", async (req, reply) => {
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("multipart/")) return;
    const userId = auth.require(req).id;
    if ((byUser.get(userId) ?? 0) >= 2 || active >= 128)
      throw new AppError(429, "UPLOAD_BUSY", "上传任务较多，请稍后再试");
    active++;
    byUser.set(userId, (byUser.get(userId) ?? 0) + 1);
    let released = false;
    let endResponse: (() => void) | undefined;
    const release = () => {
      if (released) return;
      released = true;
      receiving.delete(req);
      active--;
      const remaining = byUser.get(userId)! - 1;
      if (remaining) byUser.set(userId, remaining);
      else byUser.delete(userId);
      req.raw.removeListener("end", release);
      req.raw.removeListener("aborted", release);
      req.raw.removeListener("error", release);
      endResponse?.();
    };
    receiving.set(req, release);
    req.raw.once("end", release);
    req.raw.once("aborted", release);
    req.raw.once("error", release);
    // Subscribe, then inspect: an earlier async hook may have yielded past a
    // disconnect, and onResponseEnd can release synchronously here.
    endResponse = onResponseEnd(reply.raw, release);
    if (req.raw.readableEnded || req.raw.aborted || req.raw.destroyed || req.raw.socket?.destroyed)
      release();
  });
  app.addHook("onRequestAbort", async (req) => finishUpload(req));
  app.addHook("onResponse", async (req) => finishUpload(req));
}
