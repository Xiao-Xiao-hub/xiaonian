import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import type { SupportService } from "./service.js";

const sessionParams = z
  .object({ id: z.string().regex(/^ss_[a-f0-9]{32}$/) })
  .strict();
const sendBody = z
  .object({
    text: z.string().max(200),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  })
  .strict();
const emptyBody = z.object({}).strict().optional().default({});

/** Authenticated support chat only. The service owns persisted rate limits,
 * idempotency, ownership checks and provider-cost admission. */
export function registerSupportChatRoutes(
  app: FastifyInstance,
  deps: {
    auth: Pick<AuthService, "require">;
    support: SupportService;
  },
) {
  app.post("/v1/support/chat/sessions", async (req) => {
    emptyBody.parse(req.body);
    const user = deps.auth.require(req);
    return { data: deps.support.createSession(user.id) };
  });

  app.get("/v1/support/chat/sessions/:id", async (req) => {
    const user = deps.auth.require(req);
    const params = sessionParams.parse(req.params);
    return { data: deps.support.detail(user.id, params.id) };
  });

  app.post("/v1/support/chat/sessions/:id/turns", async (req) => {
    const user = deps.auth.require(req);
    const params = sessionParams.parse(req.params);
    const body = sendBody.parse(req.body);
    return {
      data: await deps.support.send(user.id, params.id, body),
    };
  });
}
