import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/domain.js";
import type { SqliteStore } from "../../shared/store.js";
import { SUPPORT_TICKETS_SCHEMA } from "./tickets-schema.js";

export { SUPPORT_TICKETS_SCHEMA } from "./tickets-schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_MAIL_ATTEMPTS = 3;
export const DEFAULT_OPERATIONS_EMAIL = "xiaonian-live@foxmail.com";
type Row = Record<string, unknown>;

export type SupportMailer = {
  sendMail(input: {
    to: string;
    subject: string;
    text: string;
    messageId: string;
    idempotencyKey: string;
  }): Promise<void>;
};

export class SupportMailError extends Error {
  constructor(
    readonly delivery: "not_sent" | "unknown",
    message = "邮件发送状态不明",
  ) {
    super(message);
  }
}

export class SupportTickets {
  constructor(
    private store: SqliteStore,
    private mailer?: SupportMailer,
    private readonly operationsEmail = DEFAULT_OPERATIONS_EMAIL,
  ) {}

  create(
    userId: string,
    turnId: string,
    additionalText: string,
    idempotencyKey: string,
  ) {
    if (
      !idempotencyKey ||
      idempotencyKey.length > 128 ||
      !additionalText.trim() ||
      additionalText.length > 2000
    )
      throw new AppError(400, "TICKET_INVALID", "工单内容无效");
    return this.store.transaction(() => {
      const existing = this.store.db
        .prepare(
          "SELECT * FROM support_tickets WHERE user_id=? AND idempotency_key=?",
        )
        .get(userId, idempotencyKey) as Row | undefined;
      if (existing) {
        if (
          existing.turn_id !== turnId ||
          existing.content !== additionalText.trim()
        )
          throw new AppError(
            409,
            "TICKET_IDEMPOTENCY_CONFLICT",
            "幂等键已用于其他工单内容",
          );
        return existing;
      }
      const turn = this.store.db
        .prepare("SELECT * FROM support_turns WHERE id=? AND user_id=?")
        .get(turnId, userId) as Row | undefined;
      if (!turn)
        throw new AppError(
          404,
          "SUPPORT_TURN_NOT_FOUND",
          "未找到本人的客服记录",
        );
      // ticket_eligible is written only by SupportService after repeated
      // unresolved signals in one session; refused layers never qualify.
      if (
        Number(turn.ticket_eligible) !== 1 ||
        ["reject", "injection", "crisis", "limit"].includes(String(turn.layer))
      )
        throw new AppError(403, "TICKET_NOT_ELIGIBLE", "该问题不能提交工单");
      const existingTurn = this.store.db
        .prepare("SELECT * FROM support_tickets WHERE turn_id=?")
        .get(turnId) as Row | undefined;
      if (existingTurn) return existingTurn;
      const now = this.store.now();
      const id = `st_${randomUUID().replaceAll("-", "")}`;
      const dueAt = new Date(Date.parse(now) + 3 * DAY_MS).toISOString();
      this.store.db
        .prepare("INSERT INTO support_tickets VALUES(?,?,?,?,'open',?,?,?,?)")
        .run(
          id,
          userId,
          turnId,
          idempotencyKey,
          additionalText.trim(),
          dueAt,
          now,
          now,
        );
      this.store.db
        .prepare(
          "INSERT INTO support_mail_outbox(ticket_id,status,attempts,created_at,updated_at) VALUES(?,'pending',0,?,?)",
        )
        .run(id, now, now);
      return this.store.db
        .prepare("SELECT * FROM support_tickets WHERE id=?")
        .get(id) as Row;
    });
  }

  list(userId: string, limit = 100) {
    return this.store.db
      .prepare(
        "SELECT * FROM support_tickets WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
      )
      .all(userId, Math.max(1, Math.min(100, Math.floor(limit)))) as Row[];
  }

  adminList(limit = 100) {
    return this.store.db
      .prepare("SELECT * FROM support_tickets ORDER BY created_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(100, Math.floor(limit)))).map(row => ({ ...row, mail: this.mailStatus(String(row.id)),
        notification: this.store.db.prepare("SELECT status,attempts,error_code,updated_at FROM support_notifications WHERE ticket_id=?").get(String(row.id)) ?? null }));
  }

  mailStatus(ticketId: string) {
    const row = this.store.db.prepare("SELECT status,attempts,next_attempt_at,error_code,updated_at FROM support_mail_outbox WHERE ticket_id=?").get(ticketId);
    return { ...row, configured: Boolean(this.mailer), status: this.mailer ? (row?.status ?? "missing") : "unconfigured" };
  }

  retryMail(actor: string, ticketId: string, reason: string) {
    if (!this.mailer) throw new AppError(409, "SUPPORT_MAIL_UNCONFIGURED", "发信服务尚未配置");
    if (!reason.trim() || reason.length > 500) throw new AppError(400, "SUPPORT_MAIL_REASON", "请填写重试原因");
    return this.store.transaction(() => {
      const updated = this.store.db.prepare("UPDATE support_mail_outbox SET status='pending',attempts=0,next_attempt_at=NULL,error_code=NULL,updated_at=? WHERE ticket_id=? AND status IN('failed','unknown')").run(this.store.now(), ticketId);
      // An unknown result is retried only by an operator who checked the mail log (the reason is audited).
      if (updated.changes !== 1) throw new AppError(409, "SUPPORT_MAIL_NOT_RETRYABLE", "仅发送失败或状态未知的邮件可重试；状态未知时先核对发信记录");
      this.store.audit(actor, "support.mail.retry", ticketId, { reason: reason.trim() });
      return this.mailStatus(ticketId);
    });
  }

  ownDetail(userId: string, ticketId: string) {
    const ticket = this.store.db
      .prepare("SELECT * FROM support_tickets WHERE id=? AND user_id=?")
      .get(ticketId, userId) as Row | undefined;
    if (!ticket) throw new AppError(404, "TICKET_NOT_FOUND", "工单不存在");
    return {
      ...ticket,
      replies: this.store.db
        .prepare(
          "SELECT content,created_at FROM ticket_replies WHERE ticket_id=? ORDER BY created_at",
        )
        .all(ticketId),
    };
  }

  reply(actor: string, ticketId: string, content: string, reason: string, idempotencyKey?: string) {
    if (
      !actor ||
      actor.length > 128 ||
      !reason.trim() ||
      reason.length > 500 ||
      !content.trim() ||
      content.length > 2000 ||
      (idempotencyKey !== undefined && !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey))
    )
      throw new AppError(400, "TICKET_REPLY_INVALID", "回复无效");
    return this.store.transaction(() => {
      const ticket = this.store.db
        .prepare("SELECT * FROM support_tickets WHERE id=?")
        .get(ticketId) as Row | undefined;
      if (!ticket) throw new AppError(404, "TICKET_NOT_FOUND", "工单不存在");
      if (idempotencyKey) {
        const existing = this.store.db.prepare(
          "SELECT actor,reason,content FROM ticket_replies WHERE ticket_id=? AND idempotency_key=?",
        ).get(ticketId, idempotencyKey) as Row | undefined;
        if (existing) {
          if (existing.actor !== actor || existing.reason !== reason.trim() || existing.content !== content.trim())
            throw new AppError(409, "TICKET_REPLY_IDEMPOTENCY_CONFLICT", "幂等键已用于其他工单回复");
          return { ticketId, status: "replied" as const };
        }
      }
      if (ticket.status === "closed")
        throw new AppError(409, "TICKET_CLOSED", "工单已关闭");
      const now = this.store.now();
      this.store.db
        .prepare("INSERT INTO ticket_replies(id,ticket_id,actor,reason,content,created_at,idempotency_key) VALUES(?,?,?,?,?,?,?)")
        .run(
          `sr_${randomUUID().replaceAll("-", "")}`,
          ticketId,
          actor,
          reason.trim(),
          content.trim(),
          now,
          idempotencyKey ?? null,
        );
      this.store.db
        .prepare(
          "UPDATE support_tickets SET status='replied',updated_at=? WHERE id=?",
        )
        .run(now, ticketId);
      this.store.audit(actor, "support.ticket.replied", ticketId, {
        reason: reason.trim(),
      });
      return { ticketId, status: "replied" as const };
    });
  }

  close(actor: string, ticketId: string, reason: string) {
    if (!actor || actor.length > 128 || !reason.trim() || reason.length > 500)
      throw new AppError(400, "TICKET_CLOSE_INVALID", "关闭原因无效");
    return this.store.transaction(() => {
      const ticket = this.store.db
        .prepare("SELECT status FROM support_tickets WHERE id=?")
        .get(ticketId) as { status: string } | undefined;
      if (!ticket) throw new AppError(404, "TICKET_NOT_FOUND", "工单不存在");
      if (ticket.status === "closed")
        return { ticketId, status: "closed" as const };
      this.store.db
        .prepare(
          "UPDATE support_tickets SET status='closed',updated_at=? WHERE id=?",
        )
        .run(this.store.now(), ticketId);
      this.store.audit(actor, "support.ticket.closed", ticketId, {
        reason: reason.trim(),
      });
      return { ticketId, status: "closed" as const };
    });
  }

  export(userId: string) {
    const tickets = this.list(userId);
    return {
      turns: this.store.db
        .prepare(
          "SELECT id,raw_text,answer,layer,ticket_eligible,created_at FROM support_turns WHERE user_id=? ORDER BY created_at",
        )
        .all(userId),
      tickets: tickets.map((ticket) => ({
        ...ticket,
        replies: this.store.db
          .prepare(
            "SELECT content,created_at FROM ticket_replies WHERE ticket_id=? ORDER BY created_at",
          )
          .all(String(ticket.id)),
      })),
    };
  }

  async sendPending() {
    if (!this.mailer) return 0;
    const now = this.store.now();
    const candidates = this.store.db
      .prepare(
        "SELECT ticket_id FROM support_mail_outbox WHERE status IN('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND attempts<? ORDER BY created_at LIMIT 20",
      )
      .all(now, MAX_MAIL_ATTEMPTS) as Array<{ ticket_id: string }>;
    let sent = 0;
    for (const candidate of candidates) {
      const claimed = this.store.db
        .prepare(
          "UPDATE support_mail_outbox SET status='sending',attempts=attempts+1,updated_at=? WHERE ticket_id=? AND status IN('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND attempts<?",
        )
        .run(now, candidate.ticket_id, now, MAX_MAIL_ATTEMPTS);
      if (claimed.changes !== 1) continue;
      const ticket = this.store.db
        .prepare(
          "SELECT t.id,s.layer FROM support_tickets t JOIN support_turns s ON s.id=t.turn_id WHERE t.id=?",
        )
        .get(candidate.ticket_id) as { id: string; layer: string } | undefined;
      if (!ticket) continue;
      try {
        await this.mailer.sendMail({
          to: this.operationsEmail,
          subject: `晓念工单 ${ticket.id}`,
          text: `工单号：${ticket.id}\n类别：${ticket.layer}\n请在管理台查看。`,
          messageId: ticket.id,
          idempotencyKey: ticket.id,
        });
      } catch (error) {
        if (
          error instanceof SupportMailError &&
          error.delivery === "not_sent"
        ) {
          const failedAt = this.store.now();
          this.store.db
            .prepare(
              "UPDATE support_mail_outbox SET status='failed',next_attempt_at=?,error_code='SEND_NOT_SENT',updated_at=? WHERE ticket_id=? AND status='sending'",
            )
            .run(
              new Date(Date.parse(failedAt) + DAY_MS).toISOString(),
              failedAt,
              ticket.id,
            );
        } else this.markUnknown(ticket.id, "DELIVERY_UNKNOWN");
        continue;
      }
      try {
        this.store.db
          .prepare(
            "UPDATE support_mail_outbox SET status='sent',error_code=NULL,updated_at=? WHERE ticket_id=? AND status='sending'",
          )
          .run(this.store.now(), ticket.id);
        sent++;
      } catch {
        this.markUnknown(ticket.id, "SENT_MARK_UNKNOWN");
      }
    }
    return sent;
  }

  recoverSending() {
    return this.store.db
      .prepare(
        "UPDATE support_mail_outbox SET status='unknown',error_code='RECOVERED_SENDING_UNKNOWN',updated_at=? WHERE status='sending'",
      )
      .run(this.store.now()).changes;
  }

  private markUnknown(ticketId: string, errorCode: string) {
    try {
      this.store.db
        .prepare(
          "UPDATE support_mail_outbox SET status='unknown',error_code=?,updated_at=? WHERE ticket_id=? AND status='sending'",
        )
        .run(errorCode, this.store.now(), ticketId);
    } catch (_) {
      /* preserve sending: recovery will classify it unknown */
    }
  }
}
