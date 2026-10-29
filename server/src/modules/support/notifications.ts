import type { SqliteStore } from "../../shared/store.js";
import { AppError } from "../../shared/domain.js";

export type SubscriptionChoice = { templateId: string; status: "accept" | "reject" | "ban" };
export type SupportNotificationConfig = {
  templateId: string;
  state: "developer" | "trial" | "formal";
  fields: { title: string; status: string; time: string };
  getAccessToken: () => Promise<string>;
  fetcher?: typeof fetch;
};

/** One consent funds at most the first reply notification for one ticket. */
export class SupportNotifications {
  constructor(private store: SqliteStore, private config?: SupportNotificationConfig) {}
  options() { return this.config ? { enabled: true, templateId: this.config.templateId } : { enabled: false }; }

  accept(userId: string, ticketId: string, choice?: SubscriptionChoice) {
    if (!this.config || !choice || choice.templateId !== this.config.templateId) return;
    const own = this.store.db.prepare("SELECT id FROM support_tickets WHERE id=? AND user_id=?").get(ticketId, userId);
    if (!own) return;
    this.store.db.prepare("INSERT OR IGNORE INTO support_notifications(ticket_id,template_id,status,created_at,updated_at) VALUES(?,?,?,?,?)")
      .run(ticketId, choice.templateId, choice.status === "accept" ? "accepted" : "declined", this.store.now(), this.store.now());
  }

  queueReply(ticketId: string) {
    const reply = this.store.db.prepare("SELECT id FROM ticket_replies WHERE ticket_id=? ORDER BY created_at,rowid LIMIT 1").get(ticketId);
    if (!reply) return;
    this.store.db.prepare("UPDATE support_notifications SET status='pending',reply_id=?,updated_at=? WHERE ticket_id=? AND status='accepted'")
      .run(String(reply.id), this.store.now(), ticketId);
  }

  recoverSending() {
    this.store.db.prepare("UPDATE support_notifications SET status='unknown',error_code='RECOVERED_SENDING_UNKNOWN',updated_at=? WHERE status='sending'").run(this.store.now());
  }

  retry(actor: string, ticketId: string, reason: string) {
    if (!this.config) throw new AppError(409, "SUPPORT_NOTIFICATION_UNCONFIGURED", "订阅消息尚未配置");
    if (!reason.trim()) throw new AppError(400, "SUPPORT_NOTIFICATION_REASON", "请填写重试原因");
    return this.store.transaction(() => {
      const change = this.store.db.prepare("UPDATE support_notifications SET status='pending',error_code=NULL,updated_at=? WHERE ticket_id=? AND status IN('failed','unknown') AND attempts<3 AND error_code<>'WECHAT_43101'").run(this.store.now(), ticketId);
      if (change.changes !== 1) throw new AppError(409, "SUPPORT_NOTIFICATION_NOT_RETRYABLE", "仅发送失败或状态未知、且仍有订阅授权的消息可重试，最多3次");
      this.store.audit(actor, "support.notification.retry", ticketId, { reason: reason.trim() });
      return { status: "pending" };
    });
  }

  async sendPending() {
    const config = this.config;
    if (!config) return 0;
    // Recover a crash after the reply was committed but before its wake-up.
    const accepted = this.store.db.prepare("SELECT ticket_id FROM support_notifications WHERE status='accepted' AND EXISTS(SELECT 1 FROM ticket_replies r WHERE r.ticket_id=support_notifications.ticket_id)").all();
    for (const row of accepted) this.queueReply(String(row.ticket_id));
    const rows = this.store.db.prepare(`SELECT n.ticket_id,n.template_id,u.openid,r.created_at
      FROM support_notifications n JOIN support_tickets t ON t.id=n.ticket_id
      JOIN users u ON u.id=t.user_id JOIN ticket_replies r ON r.id=n.reply_id
      WHERE n.status='pending' ORDER BY n.created_at LIMIT 50`).all();
    let sent = 0;
    for (const row of rows) {
      if (row.template_id !== config.templateId) continue;
      const claim = this.store.db.prepare("UPDATE support_notifications SET status='sending',attempts=attempts+1,updated_at=? WHERE ticket_id=? AND status='pending'").run(this.store.now(), String(row.ticket_id));
      if (claim.changes !== 1) continue;
      let token: string;
      try { token = await config.getAccessToken(); }
      catch {
        this.finish(String(row.ticket_id), "failed", "ACCESS_TOKEN_UNAVAILABLE");
        continue;
      }
      const time = new Date(Date.parse(String(row.created_at)) + 8 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
      try {
        const response = await (config.fetcher ?? fetch)(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`, {
          method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8_000),
          body: JSON.stringify({ touser: String(row.openid), template_id: config.templateId,
            miniprogram_state: config.state,
            page: `pages/support/ticket/index?id=${encodeURIComponent(String(row.ticket_id))}`,
            lang: "zh_CN", data: { [config.fields.title]: { value: "晓念工单有新回复" }, [config.fields.status]: { value: "已回复" }, [config.fields.time]: { value: time } } }),
        });
        const result = await response.json() as { errcode?: number };
        if (response.ok && result.errcode === 0) {
          this.finish(String(row.ticket_id), "sent", null); sent++;
        } else if (response.ok && Number.isInteger(result.errcode)) {
          this.finish(String(row.ticket_id), "failed", `WECHAT_${result.errcode}`);
        } else this.finish(String(row.ticket_id), "unknown", "DELIVERY_UNKNOWN");
      } catch { this.finish(String(row.ticket_id), "unknown", "DELIVERY_UNKNOWN"); }
    }
    return sent;
  }

  private finish(ticketId: string, status: string, code: string | null) {
    this.store.db.prepare("UPDATE support_notifications SET status=?,error_code=?,updated_at=? WHERE ticket_id=? AND status='sending'").run(status, code, this.store.now(), ticketId);
  }
}
