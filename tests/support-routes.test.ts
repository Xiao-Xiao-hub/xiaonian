import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { AppError } from "../server/src/shared/domain.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { registerSupportRoutes } from "../server/src/modules/support/routes.js";
import { SupportTickets } from "../server/src/modules/support/tickets.js";
import { AccountService } from "../server/src/modules/account/service.js";

const Fastify = createRequire(
  new URL("../server/package.json", import.meta.url),
)("fastify") as () => any;
function fixture() {
  const store = new SqliteStore(":memory:"),
    app = Fastify();
  const owner = store.upsertUser("support-route-owner", "本人", "wechat");
  const other = store.upsertUser("support-route-other", "他人", "wechat");
  store.db
    .prepare("INSERT INTO support_turns VALUES(?,?,?,?,?,?,?)")
    .run(
      "turn-owner",
      owner.id,
      "订单问题",
      "请提交",
      "clarify",
      1,
      store.now(),
    );
  const auth = {
    require(req: { headers: Record<string, unknown> }) {
      return store.getUser(
        req.headers.authorization === "Bearer other" ? other.id : owner.id,
      )!;
    },
    admin(req: { headers: Record<string, unknown> }) {
      if (req.headers["x-admin-key"] !== "ok")
        throw new AppError(401, "ADMIN_AUTH_REQUIRED", "管理员凭证无效");
    },
  };
  registerSupportRoutes(app, {
    auth: auth as never,
    tickets: new SupportTickets(store),
  });
  app.setErrorHandler((error, _req, reply) =>
    reply
      .code(
        error instanceof AppError
          ? error.statusCode
          : "issues" in error
            ? 400
            : 500,
      )
      .send({
        code: error instanceof AppError ? error.code : "VALIDATION_ERROR",
      }),
  );
  return { app, store, owner, other };
}
test("support routes only create from the caller's eligible turn and keep details owner-scoped", async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.app.close();
    f.store.close();
  });
  const created = await f.app.inject({
    method: "POST",
    url: "/v1/support/tickets",
    headers: { authorization: "Bearer owner" },
    payload: {
      turnId: "turn-owner",
      content: "请人工核实",
      idempotencyKey: "route-one",
    },
  });
  assert.equal(created.statusCode, 200);
  const id = created.json().data.id;
  assert.equal(
    (
      await f.app.inject({
        url: `/v1/support/tickets/${id}`,
        headers: { authorization: "Bearer other" },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/v1/support/tickets",
        headers: { authorization: "Bearer other" },
        payload: {
          turnId: "turn-owner",
          content: "越权",
          idempotencyKey: "route-two",
        },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    f.store.db
      .prepare("SELECT status FROM support_mail_outbox WHERE ticket_id=?")
      .get(id)!.status,
    "pending",
  );
});
test("admin reply and close require existing admin authentication and preserve audit actor", async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.app.close();
    f.store.close();
  });
  const id = (
    await f.app.inject({
      method: "POST",
      url: "/v1/support/tickets",
      payload: {
        turnId: "turn-owner",
        content: "请人工核实",
        idempotencyKey: "route-one",
      },
    })
  ).json().data.id;
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `/v1/admin/support/tickets/${id}/replies`,
        payload: { content: "已核实", reason: "订单核实", idempotencyKey: "admin-reply-route-1" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `/v1/admin/support/tickets/${id}/replies`,
        headers: { "x-admin-key": "ok" },
        payload: { content: "已核实", reason: "订单核实", idempotencyKey: "admin-reply-route-1" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `/v1/admin/support/tickets/${id}/close`,
        headers: { "x-admin-key": "ok" },
        payload: { reason: "已答复" },
      })
    ).json().data.status,
    "closed",
  );
  assert.equal(
    f.store.db
      .prepare("SELECT actor FROM audit WHERE action='support.ticket.closed'")
      .get()!.actor,
    "admin:shared",
  );
});

test("account export includes only the owner's support turns and public replies", () => {
  const f = fixture();
  try {
    const tickets = new SupportTickets(f.store);
    const ticket = tickets.create(
      f.owner.id,
      "turn-owner",
      "请人工核实",
      "export-one",
    );
    tickets.reply("admin:shared", String(ticket.id), "已核实", "订单核实");
    f.store.db
      .prepare("INSERT INTO support_turns VALUES(?,?,?,?,?,?,?)")
      .run(
        "turn-other",
        f.other.id,
        "别人的内容",
        "答复",
        "clarify",
        1,
        f.store.now(),
      );
    const data = new AccountService(
      f.store,
      {} as never,
      {} as never,
      {} as never,
    ).export(f.owner);
    assert.equal(data.support.turns.length, 1);
    assert.equal(data.support.tickets.length, 1);
    assert.deepEqual(data.support.tickets[0]!.replies, [
      {
        content: "已核实",
        createdAt: data.support.tickets[0]!.replies[0]!.createdAt,
      },
    ]);
    assert.ok(!JSON.stringify(data.support).includes("admin:shared"));
    assert.ok(!JSON.stringify(data.support).includes("别人的内容"));
  } finally {
    f.store.close();
  }
});
