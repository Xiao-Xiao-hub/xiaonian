import assert from "node:assert/strict";
import test from "node:test";
import {
  SupportMailError,
  SupportTickets,
  type SupportMailer,
} from "../server/src/modules/support/tickets.js";
import { AppError } from "../server/src/shared/domain.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { loadEnv } from "../server/src/config/env.js";

const DAY = 24 * 60 * 60 * 1000;
const appError = (code: string) => (error: unknown) => {
  assert.ok(error instanceof AppError);
  assert.equal(error.code, code);
  return true;
};

function setup(mailer?: SupportMailer) {
  let now = Date.parse("2026-10-24T08:00:00.000Z");
  const store = new SqliteStore(":memory:", () => new Date(now));
  const owner = store.upsertUser("support-owner", "提单人", "wechat");
  const other = store.upsertUser("support-other", "其他人", "wechat");
  const turn = (
    id: string,
    userId = owner.id,
    layer = "clarify",
    eligible = 1,
  ) => {
    store.db
      .prepare("INSERT INTO support_turns VALUES(?,?,?,?,?,?,?)")
      .run(
        id,
        userId,
        "我的订单没有到账",
        "请提交工单",
        layer,
        eligible,
        store.now(),
      );
    return id;
  };
  return {
    store,
    owner,
    other,
    turn,
    tickets: new SupportTickets(store, mailer),
    advance: (ms: number) => (now += ms),
  };
}

test("eligible owned turn creates one 72-hour ticket and retries the same idempotency key", () => {
  const f = setup();
  try {
    const turnId = f.turn("turn-one");
    const created = f.tickets.create(
      f.owner.id,
      turnId,
      "请帮我查一下",
      "key-one",
    );
    const replay = f.tickets.create(
      f.owner.id,
      turnId,
      "请帮我查一下",
      "key-one",
    );
    assert.equal(replay.id, created.id);
    assert.equal(created.status, "open");
    assert.equal(
      Date.parse(String(created.due_at)) -
        Date.parse(String(created.created_at)),
      3 * DAY,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) count FROM support_mail_outbox")
        .get()!.count,
      1,
    );
  } finally {
    f.store.close();
  }
});

test("a turn cannot create two tickets and foreign or ineligible turns are rejected", () => {
  const f = setup();
  try {
    const turnId = f.turn("turn-one");
    const created = f.tickets.create(
      f.owner.id,
      turnId,
      "需要人工处理",
      "key-one",
    );
    assert.equal(
      f.tickets.create(f.owner.id, turnId, "再提交", "key-two").id,
      created.id,
    );
    assert.throws(
      () =>
        f.tickets.create(
          f.owner.id,
          f.turn("turn-two"),
          "另一个问题",
          "key-one",
        ),
      appError("TICKET_IDEMPOTENCY_CONFLICT"),
    );
    assert.throws(
      () =>
        f.tickets.create(
          f.owner.id,
          f.turn("turn-other", f.other.id),
          "越权",
          "key-foreign",
        ),
      appError("SUPPORT_TURN_NOT_FOUND"),
    );
    assert.throws(
      () =>
        f.tickets.create(
          f.owner.id,
          f.turn("turn-reject", f.owner.id, "reject"),
          "无关",
          "key-reject",
        ),
      appError("TICKET_NOT_ELIGIBLE"),
    );
    assert.throws(
      () =>
        f.tickets.create(
          f.owner.id,
          f.turn("turn-crisis", f.owner.id, "crisis"),
          "危机",
          "key-crisis",
        ),
      appError("TICKET_NOT_ELIGIBLE"),
    );
    for (const layer of ["injection", "limit"])
      assert.throws(
        () => f.tickets.create(f.owner.id, f.turn(`turn-${layer}`, f.owner.id, layer), "绕过", `key-${layer}`),
        appError("TICKET_NOT_ELIGIBLE"),
        layer,
      );
    assert.throws(
      () => f.tickets.create(f.owner.id, f.turn("turn-first-signal", f.owner.id, "fallback", 0), "第一次没答上", "key-first"),
      appError("TICKET_NOT_ELIGIBLE"),
    );
  } finally {
    f.store.close();
  }
});

test("admin reply needs actor and reason, changes status, and writes audit", () => {
  const f = setup();
  try {
    const ticket = f.tickets.create(
      f.owner.id,
      f.turn("turn-one"),
      "请人工处理",
      "key-one",
    );
    assert.throws(
      () => f.tickets.reply("", String(ticket.id), "已处理", "核实"),
      appError("TICKET_REPLY_INVALID"),
    );
    assert.throws(
      () => f.tickets.reply("admin-1", String(ticket.id), "已处理", ""),
      appError("TICKET_REPLY_INVALID"),
    );
    assert.deepEqual(
      f.tickets.reply("admin-1", String(ticket.id), "已为你核对", "核实订单"),
      { ticketId: ticket.id, status: "replied" },
    );
    assert.equal(f.tickets.list(f.owner.id)[0]!.status, "replied");
    const audit = f.store.db
      .prepare("SELECT actor,action,resource_id,details FROM audit")
      .get()!;
    assert.deepEqual(
      { ...audit, details: JSON.parse(String(audit.details)) },
      {
        actor: "admin-1",
        action: "support.ticket.replied",
        resource_id: ticket.id,
        details: { reason: "核实订单" },
      },
    );
  } finally {
    f.store.close();
  }
});

test("admin reply idempotency writes one reply and rejects a conflicting replay", () => {
  const f = setup();
  try {
    const ticket = f.tickets.create(f.owner.id, f.turn("reply-idempotency"), "请人工处理", "ticket-reply-idempotency");
    const key = "admin-reply-idempotency";
    assert.deepEqual(f.tickets.reply("admin-1", String(ticket.id), "已核实", "订单核实", key), { ticketId: ticket.id, status: "replied" });
    assert.deepEqual(f.tickets.reply("admin-1", String(ticket.id), "已核实", "订单核实", key), { ticketId: ticket.id, status: "replied" });
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM ticket_replies WHERE ticket_id=?").get(ticket.id)!.n, 1);
    assert.throws(() => f.tickets.reply("admin-1", String(ticket.id), "另一回复", "订单核实", key), appError("TICKET_REPLY_IDEMPOTENCY_CONFLICT"));
  } finally {
    f.store.close();
  }
});

test("owned list and export do not leak another user's turns or tickets", () => {
  const f = setup();
  try {
    f.tickets.create(f.owner.id, f.turn("turn-owner"), "我的问题", "key-owner");
    f.tickets.create(
      f.other.id,
      f.turn("turn-other", f.other.id),
      "别人的问题",
      "key-other",
    );
    assert.equal(f.tickets.list(f.owner.id).length, 1);
    assert.equal(f.tickets.adminList().length, 2);
    const exported = f.tickets.export(f.owner.id);
    assert.equal(exported.turns.length, 1);
    assert.equal(exported.tickets.length, 1);
    assert.ok(!JSON.stringify(exported).includes("别人的问题"));
    f.tickets.reply(
      "admin-1",
      String(exported.tickets[0]!.id),
      "已核实",
      "订单核实",
    );
    const detail = f.tickets.ownDetail(
      f.owner.id,
      String(exported.tickets[0]!.id),
    );
    assert.deepEqual(
      detail.replies.map((reply) => ({ ...reply })),
      [{ content: "已核实", created_at: detail.replies[0]!.created_at }],
    );
    assert.ok(
      !JSON.stringify(f.tickets.export(f.owner.id)).includes("admin-1"),
    );
  } finally {
    f.store.close();
  }
});

test("no configured mailer keeps its pending operation pending", async () => {
  const f = setup();
  try {
    const ticket = f.tickets.create(
      f.owner.id,
      f.turn("turn-one"),
      "请处理",
      "key-one",
    );
    assert.equal(await f.tickets.sendPending(), 0);
    assert.equal(
      f.store.db
        .prepare("SELECT status FROM support_mail_outbox WHERE ticket_id=?")
        .get(ticket.id)!.status,
      "pending",
    );
  } finally {
    f.store.close();
  }
});

test("mail failure records a bounded retry and a sent operation cannot resend", async () => {
  let calls = 0;
  const delivered: Array<{ to: string; text: string }> = [];
  const f = setup({
    async sendMail(input) {
      calls++;
      if (calls === 1) throw new SupportMailError("not_sent");
      delivered.push({ to: input.to, text: input.text });
    },
  });
  try {
    const ticket = f.tickets.create(
      f.owner.id,
      f.turn("turn-one", f.owner.id, "clarify"),
      "私密补充内容",
      "key-one",
    );
    assert.equal(await f.tickets.sendPending(), 0);
    const failed = f.store.db
      .prepare(
        "SELECT status,attempts,next_attempt_at,error_code FROM support_mail_outbox WHERE ticket_id=?",
      )
      .get(ticket.id)!;
    assert.deepEqual(
      { ...failed },
      {
        status: "failed",
        attempts: 1,
        next_attempt_at: new Date(
          Date.parse(String(ticket.created_at)) + DAY,
        ).toISOString(),
        error_code: "SEND_NOT_SENT",
      },
    );
    f.advance(DAY);
    assert.equal(await f.tickets.sendPending(), 1);
    assert.equal(await f.tickets.sendPending(), 0);
    assert.equal(calls, 2);
    assert.deepEqual(delivered, [
      {
        to: "xiaonian-live@foxmail.com",
        text: `工单号：${ticket.id}\n类别：clarify\n请在管理台查看。`,
      },
    ]);
    assert.ok(!delivered[0]!.text.includes("私密补充内容"));
  } finally {
    f.store.close();
  }
});

test("operations email has a safe default and supports an environment override", async () => {
  assert.equal(loadEnv({ NODE_ENV: "test" }).SUPPORT_OPERATIONS_EMAIL, "xiaonian-live@foxmail.com");
  assert.equal(loadEnv({ NODE_ENV: "test", SUPPORT_OPERATIONS_EMAIL: "ops@example.com" }).SUPPORT_OPERATIONS_EMAIL, "ops@example.com");
  const delivered: string[] = [];
  const f = setup({ async sendMail(input) { delivered.push(input.to); } });
  try {
    const ticket = f.tickets.create(f.owner.id, f.turn("turn-operations-email"), "请处理", "operations-email-key");
    f.tickets = new SupportTickets(f.store, { async sendMail(input) { delivered.push(input.to); } }, "ops@example.com");
    assert.equal(await f.tickets.sendPending(), 1);
    assert.deepEqual(delivered, ["ops@example.com"]);
    assert.ok(ticket.id);
  } finally {
    f.store.close();
  }
});

test("a permanently failing mail operation stops after three attempts", async () => {
  let calls = 0;
  const f = setup({
    async sendMail() {
      calls++;
      throw new SupportMailError("not_sent");
    },
  });
  try {
    const ticket = f.tickets.create(
      f.owner.id,
      f.turn("turn-one"),
      "请处理",
      "key-one",
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal(await f.tickets.sendPending(), 0);
      f.advance(DAY);
    }
    assert.equal(await f.tickets.sendPending(), 0);
    assert.equal(calls, 3);
    assert.deepEqual(
      {
        ...f.store.db
          .prepare(
            "SELECT status,attempts,error_code FROM support_mail_outbox WHERE ticket_id=?",
          )
          .get(ticket.id),
      },
      { status: "failed", attempts: 3, error_code: "SEND_NOT_SENT" },
    );
  } finally {
    f.store.close();
  }
});

test("two pending pumps claim one operation before awaiting mail", async () => {
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const f = setup({
    async sendMail() {
      calls++;
      await waiting;
    },
  });
  try {
    const ticket = f.tickets.create(
      f.owner.id,
      f.turn("turn-one"),
      "请处理",
      "key-one",
    );
    const first = f.tickets.sendPending();
    await Promise.resolve();
    const second = f.tickets.sendPending();
    release!();
    assert.deepEqual(await Promise.all([first, second]), [1, 0]);
    assert.equal(calls, 1);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT status,attempts FROM support_mail_outbox WHERE ticket_id=?",
        )
        .get(ticket.id)!.status,
      "sent",
    );
  } finally {
    f.store.close();
  }
});

test("unknown delivery and a sent-mark database failure are never retried", async () => {
  let calls = 0;
  const f = setup({
    async sendMail() {
      calls++;
      throw new Error("network uncertain");
    },
  });
  try {
    const unknown = f.tickets.create(
      f.owner.id,
      f.turn("turn-unknown"),
      "请处理",
      "key-unknown",
    );
    assert.equal(await f.tickets.sendPending(), 0);
    f.advance(10 * DAY);
    assert.equal(await f.tickets.sendPending(), 0);
    assert.equal(calls, 1);
    assert.equal(
      f.store.db
        .prepare("SELECT status FROM support_mail_outbox WHERE ticket_id=?")
        .get(unknown.id)!.status,
      "unknown",
    );
    const sent = f.tickets.create(
      f.owner.id,
      f.turn("turn-sent"),
      "请处理",
      "key-sent",
    );
    f.store.db.exec(
      "CREATE TRIGGER sent_mark_fail BEFORE UPDATE ON support_mail_outbox WHEN NEW.status='sent' BEGIN SELECT RAISE(FAIL,'mark failed'); END",
    );
    const mailer = {
      async sendMail() {
        calls++;
      },
    };
    f.tickets = new SupportTickets(f.store, mailer);
    assert.equal(await f.tickets.sendPending(), 0);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT status,error_code FROM support_mail_outbox WHERE ticket_id=?",
        )
        .get(sent.id)!.status,
      "unknown",
    );
    f.advance(10 * DAY);
    assert.equal(await f.tickets.sendPending(), 0);
    assert.equal(calls, 2);
    // After checking the mail log, an operator can explicitly retry an unknown result.
    assert.equal(f.tickets.retryMail("admin-1", String(unknown.id), "已核对发信记录，未送达").status, "pending");
  } finally {
    f.store.close();
  }
});

test("recovering an interrupted sender marks it unknown and closed tickets cannot reply", () => {
  const f = setup();
  try {
    const ticket = f.tickets.create(
      f.owner.id,
      f.turn("turn-one"),
      "请处理",
      "key-one",
    );
    f.store.db
      .prepare(
        "UPDATE support_mail_outbox SET status='sending' WHERE ticket_id=?",
      )
      .run(ticket.id);
    assert.equal(f.tickets.recoverSending(), 1);
    assert.equal(
      f.store.db
        .prepare("SELECT status FROM support_mail_outbox WHERE ticket_id=?")
        .get(ticket.id)!.status,
      "unknown",
    );
    assert.deepEqual(
      f.tickets.close("admin-1", String(ticket.id), "已处理完毕"),
      { ticketId: ticket.id, status: "closed" },
    );
    assert.throws(
      () =>
        f.tickets.reply("admin-1", String(ticket.id), "不能回复", "继续处理"),
      appError("TICKET_CLOSED"),
    );
    assert.equal(
      f.store.db
        .prepare(
          "SELECT COUNT(*) count FROM audit WHERE action='support.ticket.closed'",
        )
        .get()!.count,
      1,
    );
  } finally {
    f.store.close();
  }
});

test("deleting a user cascades support records, replies and mail operations", () => {
  const f = setup();
  try {
    const ticket = f.tickets.create(
      f.owner.id,
      f.turn("turn-one"),
      "请处理",
      "key-one",
    );
    f.tickets.reply("admin-1", String(ticket.id), "已收到", "核实");
    f.store.db.prepare("DELETE FROM users WHERE id=?").run(f.owner.id);
    for (const table of [
      "support_turns",
      "support_tickets",
      "ticket_replies",
      "support_mail_outbox",
    ])
      assert.equal(
        f.store.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get()!.count,
        0,
      );
  } finally {
    f.store.close();
  }
});
