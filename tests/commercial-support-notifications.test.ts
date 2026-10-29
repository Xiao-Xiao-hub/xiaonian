import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { createSupportMailer } from "../server/src/modules/support/mailer.js";
import { SupportTickets, SupportMailError } from "../server/src/modules/support/tickets.js";
import { SupportNotifications } from "../server/src/modules/support/notifications.js";

const seedTurn = (store: SqliteStore, userId: string, id: string) => store.db.prepare(
  "INSERT INTO support_turns VALUES(?,?,?,'请确认提交工单','answer',1,?)",
).run(id, userId, "合成待处理问题", store.now());

test("SMTP stays disconnected without configuration and classifies delivery uncertainty without leaking errors", async () => {
  let factories = 0;
  const env = loadEnv({ NODE_ENV: "test" });
  assert.equal(createSupportMailer(env, () => { factories++; throw new Error("must not connect"); }), undefined);
  assert.equal(factories, 0);
  const config = { ...env, SMTP_HOST: "smtp.example.test", SMTP_USER: "operator", SMTP_PASSWORD: "synthetic-password", SMTP_FROM: "operator@example.test" };
  let delivered: Record<string, unknown> | undefined;
  const mail = { to: "recipient@example.test", subject: "合成工单", text: "仅编号", messageId: "st_synthetic", idempotencyKey: "st_synthetic" };
  const sender = createSupportMailer(config, () => ({ sendMail: async input => { delivered = input; } }));
  await sender!.sendMail(mail);
  assert.equal(delivered!.messageId, "<st_synthetic@example.test>");
  assert.equal(delivered!.from, config.SMTP_FROM);
  for (const [error, expected] of [
    [{ code: "EAUTH", message: "synthetic-password" }, "not_sent"],
    [{ code: "ETIMEDOUT", command: "DATA", message: "private content" }, "unknown"],
  ] as const) {
    const failing = createSupportMailer(config, () => ({ sendMail: async () => { throw error; } }));
    await assert.rejects(failing!.sendMail(mail), (caught: unknown) => caught instanceof SupportMailError && caught.delivery === expected && !caught.message.includes(error.message));
  }
});

test("runtime wakes the mail queue only for an eligible ticket; failed delivery is visible and audited retry works", async t => {
  const store = new SqliteStore(":memory:");
  let calls = 0;
  const key = "synthetic-admin-key-".padEnd(40, "x");
  const app = buildApp({ store, env: loadEnv({ NODE_ENV: "test", DEV_LOGIN_ENABLED: "true", LOG_LEVEL: "silent", ADMIN_API_KEY: key }),
    supportMailer: { sendMail: async mail => { calls++; assert.equal(mail.to, "xiaonian-live@foxmail.com"); assert.doesNotMatch(mail.text, /合成待处理问题/); if (calls === 1) throw new SupportMailError("not_sent"); } } });
  t.after(() => app.close());
  await app.ready();
  assert.equal(calls, 0);
  const login = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { key: "support-mail-runtime" } });
  const { token, user } = login.json().data;
  seedTurn(store, user.id, "eligible-mail-turn");
  const headers = { authorization: `Bearer ${token}` };
  const options = await app.inject({ method: "GET", url: "/v1/support/notifications/options", headers });
  assert.deepEqual(options.json().data, { enabled: false });
  const created = await app.inject({ method: "POST", url: "/v1/support/tickets", headers,
    payload: { turnId: "eligible-mail-turn", content: "合成补充", idempotencyKey: "mail-runtime" } });
  assert.equal(created.statusCode, 200, created.body);
  const ticket = created.json().data;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  const list = await app.inject({ method: "GET", url: "/v1/admin/support/tickets", headers: { "x-admin-key": key } });
  assert.equal(list.json().data[0].mail.status, "failed");
  const retried = await app.inject({ method: "POST", url: `/v1/admin/support/tickets/${ticket.id}/mail/retry`, headers: { "x-admin-key": key }, payload: { reason: "合成验收重试" } });
  assert.equal(retried.statusCode, 200, retried.body);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(store.db.prepare("SELECT status FROM support_mail_outbox").get()!.status, "sent");
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='support.mail.retry'").get()!.n, 1);
});

test("one accepted subscription sends only the first reply; declined and foreign tickets never send", async t => {
  const store = new SqliteStore(":memory:"); t.after(() => store.close());
  const owner = store.upsertUser("sub-owner", "合成用户", "wechat");
  const other = store.upsertUser("sub-other", "另一用户", "wechat");
  seedTurn(store, owner.id, "sub-turn"); seedTurn(store, owner.id, "declined-turn");
  const tickets = new SupportTickets(store);
  const ticket = tickets.create(owner.id, "sub-turn", "私密内容不进入通知", "sub-key");
  const declined = tickets.create(owner.id, "declined-turn", "拒绝订阅仍可建单", "declined-key");
  let calls = 0;
  const notifications = new SupportNotifications(store, { templateId: "synthetic-template", state: "trial", fields: { title: "thing1", status: "phrase2", time: "time3" },
    getAccessToken: async () => "synthetic-access-token", fetcher: (async (url, init) => {
      calls++; assert.ok(String(url).startsWith("https://api.weixin.qq.com/cgi-bin/message/subscribe/send?"));
      const body = JSON.parse(String(init?.body));
      assert.equal(body.touser, owner.openid); assert.equal(body.template_id, "synthetic-template"); assert.equal(body.miniprogram_state, "trial");
      assert.match(body.page, /^pages\/support\/ticket\/index\?id=/); assert.doesNotMatch(String(init?.body), /私密内容/);
      return new Response('{"errcode":0}', { status: 200 });
    }) as typeof fetch });
  notifications.accept(other.id, String(ticket.id), { templateId: "synthetic-template", status: "accept" });
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM support_notifications").get()!.n, 0);
  notifications.accept(owner.id, String(ticket.id), { templateId: "synthetic-template", status: "accept" });
  notifications.accept(owner.id, String(declined.id), { templateId: "synthetic-template", status: "reject" });
  for (const id of [ticket.id, declined.id]) { tickets.reply("admin:test", String(id), "合成回复", "验收"); notifications.queueReply(String(id)); }
  await Promise.all([notifications.sendPending(), notifications.sendPending()]);
  tickets.reply("admin:test", String(ticket.id), "第二次回复", "验收"); notifications.queueReply(String(ticket.id));
  await notifications.sendPending();
  assert.equal(calls, 1);
  assert.equal(store.db.prepare("SELECT status FROM support_notifications WHERE ticket_id=?").get(String(declined.id))!.status, "declined");
  store.db.prepare("DELETE FROM users WHERE id=?").run(owner.id);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM support_notifications").get()!.n, 0);
});
