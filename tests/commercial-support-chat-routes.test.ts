import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { FastifyRequest } from "fastify";
import { registerSupportChatRoutes } from "../server/src/modules/support/chat-routes.js";
import { SupportGate } from "../server/src/modules/support/gate.js";
import { SupportService } from "../server/src/modules/support/service.js";
import { AppError } from "../server/src/shared/domain.js";
import { SqliteStore } from "../server/src/shared/store.js";

const Fastify = createRequire(
  new URL("../server/package.json", import.meta.url),
)("fastify") as () => import("fastify").FastifyInstance;

function setup() {
  const store = new SqliteStore(":memory:");
  const owner = store.upsertUser("support-route-owner", "本人", "wechat");
  const other = store.upsertUser("support-route-other", "他人", "wechat");
  const users = new Map([
    [owner.id, owner],
    [other.id, other],
  ]);
  const service = new SupportService(store, { gate: new SupportGate() });
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => {
    const validation = error.name === "ZodError";
    const status =
      error instanceof AppError
        ? error.statusCode
        : validation
          ? 400
          : 500;
    reply.code(status).send({
      error: {
        code:
          error instanceof AppError
            ? error.code
            : validation
              ? "VALIDATION_ERROR"
              : "INTERNAL_ERROR",
      },
    });
  });
  registerSupportChatRoutes(app, {
    auth: {
      require(req: FastifyRequest) {
        const id = req.headers["x-test-user"];
        if (typeof id !== "string" || !users.has(id))
          throw new AppError(401, "AUTH_REQUIRED", "请登录");
        return users.get(id)!;
      },
    },
    support: service,
  });
  return { store, owner, other, app };
}

test("authenticated chat routes create, answer and return the owned persisted session", async () => {
  const f = setup();
  try {
    const created = await f.app.inject({
      method: "POST",
      url: "/v1/support/chat/sessions",
      headers: { "x-test-user": f.owner.id },
      payload: {},
    });
    assert.equal(created.statusCode, 200);
    const sessionId = created.json().data.id as string;
    const sent = await f.app.inject({
      method: "POST",
      url: `/v1/support/chat/sessions/${sessionId}/turns`,
      headers: { "x-test-user": f.owner.id },
      payload: {
        text: "套餐会自动续费吗",
        idempotencyKey: "route-message-1",
      },
    });
    assert.equal(sent.statusCode, 200);
    assert.equal(sent.json().data.sessionId, sessionId);
    assert.equal(sent.json().data.layer, "answer");
    assert.equal(sent.json().data.resourcePath, null);
    assert.ok(sent.json().data.faqs.length > 0);
    const detail = await f.app.inject({
      method: "GET",
      url: `/v1/support/chat/sessions/${sessionId}`,
      headers: { "x-test-user": f.owner.id },
    });
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(
      Object.keys(detail.json().data.turns[0]).sort(),
      [
        "answer",
        "id",
        "layer",
        "resourcePath",
        "text",
        "ticketEligible",
      ],
    );
  } finally {
    await f.app.close();
    f.store.close();
  }
});

test("chat routes require auth, enforce owner scope and reject extra or overlong input", async () => {
  const f = setup();
  try {
    const unauthorized = await f.app.inject({
      method: "POST",
      url: "/v1/support/chat/sessions",
      payload: {},
    });
    assert.equal(unauthorized.statusCode, 401);
    const created = await f.app.inject({
      method: "POST",
      url: "/v1/support/chat/sessions",
      headers: { "x-test-user": f.owner.id },
      payload: {},
    });
    const sessionId = created.json().data.id as string;
    const foreign = await f.app.inject({
      method: "GET",
      url: `/v1/support/chat/sessions/${sessionId}`,
      headers: { "x-test-user": f.other.id },
    });
    assert.equal(foreign.statusCode, 404);
    const forged = await f.app.inject({
      method: "POST",
      url: `/v1/support/chat/sessions/${sessionId}/turns`,
      headers: { "x-test-user": f.owner.id },
      payload: {
        text: "订单怎么了",
        idempotencyKey: "route-message-2",
        paid: true,
      },
    });
    assert.equal(forged.statusCode, 400);
    const overlong = await f.app.inject({
      method: "POST",
      url: `/v1/support/chat/sessions/${sessionId}/turns`,
      headers: { "x-test-user": f.owner.id },
      payload: {
        text: "问".repeat(201),
        idempotencyKey: "route-message-3",
      },
    });
    assert.equal(overlong.statusCode, 400);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM support_chat_requests").get()!.n,
      0,
    );
  } finally {
    await f.app.close();
    f.store.close();
  }
});
