import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import { SupportTickets } from "./tickets.js";
import type { SupportNotifications } from "./notifications.js";

const id = z.string().trim().min(1).max(128);
const create = z
  .object({
    turnId: id,
    content: z.string().trim().min(1).max(2000),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    subscription: z.object({ templateId: z.string().min(1).max(128), status: z.enum(["accept", "reject", "ban"]) }).strict().optional(),
  })
  .strict();
const reply = z
  .object({
    content: z.string().trim().min(1).max(2000),
    reason: z.string().trim().min(1).max(500),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  })
  .strict();
const close = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const limit = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(100) })
  .strict();

export function registerSupportRoutes(
  app: FastifyInstance,
  deps: {
    auth: Pick<AuthService, "require" | "admin">;
    tickets: SupportTickets;
    notifications?: SupportNotifications;
    wake?: () => void;
    adminAuth?: (req: FastifyRequest) => string;
  },
) {
  const admin = (req: FastifyRequest) =>
    deps.adminAuth?.(req) ?? (deps.auth.admin(req), "admin:shared");
  app.get("/v1/support/notifications/options", async req => {
    deps.auth.require(req);
    return { data: deps.notifications?.options() ?? { enabled: false } };
  });
  app.get("/v1/support/tickets", async (req) => {
    const user = deps.auth.require(req);
    return {
      data: deps.tickets.list(user.id, limit.parse(req.query ?? {}).limit),
    };
  });
  app.get("/v1/support/tickets/:id", async (req) => {
    const user = deps.auth.require(req);
    return {
      data: deps.tickets.ownDetail(
        user.id,
        id.parse((req.params as { id?: unknown }).id),
      ),
    };
  });
  app.post("/v1/support/tickets", async (req) => {
    const user = deps.auth.require(req);
    const body = create.parse(req.body);
    const ticket = deps.tickets.create(
        user.id,
        body.turnId,
        body.content,
        body.idempotencyKey,
      );
    deps.notifications?.accept(user.id, String(ticket.id), body.subscription);
    deps.wake?.();
    return { data: ticket };
  });
  app.get("/v1/admin/support/tickets", async (req) => {
    admin(req);
    return { data: deps.tickets.adminList(limit.parse(req.query ?? {}).limit) };
  });
  app.post("/v1/admin/support/tickets/:id/replies", async (req) => {
    const actor = admin(req);
    const body = reply.parse(req.body);
    const result = deps.tickets.reply(
        actor,
        id.parse((req.params as { id?: unknown }).id),
        body.content,
        body.reason,
        body.idempotencyKey,
      );
    deps.notifications?.queueReply(result.ticketId);
    deps.wake?.();
    return { data: result };
  });
  app.post("/v1/admin/support/tickets/:id/mail/retry", async req => {
    const actor = admin(req);
    const body = close.parse(req.body);
    const result = deps.tickets.retryMail(actor, id.parse((req.params as { id?: unknown }).id), body.reason);
    deps.wake?.();
    return { data: result };
  });
  app.post("/v1/admin/support/tickets/:id/notification/retry", async req => {
    const actor = admin(req);
    const body = close.parse(req.body);
    const result = deps.notifications?.retry(actor, id.parse((req.params as { id?: unknown }).id), body.reason);
    deps.wake?.();
    return { data: result ?? { status: "unconfigured" } };
  });
  app.post("/v1/admin/support/tickets/:id/close", async (req) => {
    const actor = admin(req);
    const body = close.parse(req.body);
    return {
      data: deps.tickets.close(
        actor,
        id.parse((req.params as { id?: unknown }).id),
        body.reason,
      ),
    };
  });
}
