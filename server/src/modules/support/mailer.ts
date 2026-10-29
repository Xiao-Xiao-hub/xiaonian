import nodemailer from "nodemailer";
import type { Env } from "../../config/env.js";
import { SupportMailError, type SupportMailer } from "./tickets.js";

type MailConfig = Pick<Env, "SMTP_HOST" | "SMTP_PORT" | "SMTP_SECURE" | "SMTP_USER" | "SMTP_PASSWORD" | "SMTP_FROM">;
type Transport = { sendMail(input: { from: string; to: string; subject: string; text: string; messageId: string }): Promise<unknown> };

/** No connection/verification is attempted until an eligible queued ticket exists. */
export function createSupportMailer(config: MailConfig, factory = (options: object): Transport => nodemailer.createTransport(options)) : SupportMailer | undefined {
  if (!config.SMTP_HOST || !config.SMTP_USER || !config.SMTP_PASSWORD || !config.SMTP_FROM) return undefined;
  const transport = factory({
    host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE,
    requireTLS: !config.SMTP_SECURE,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
  });
  const from = config.SMTP_FROM;
  const domain = from.slice(from.lastIndexOf("@") + 1);
  return { async sendMail(input) {
    try {
      await transport.sendMail({ from, to: input.to, subject: input.subject, text: input.text,
        messageId: `<${input.messageId}@${domain}>` });
    } catch (error) {
      const failure = error as { code?: string; responseCode?: number; command?: string };
      const rejected = Number.isInteger(failure.responseCode) && failure.responseCode! >= 400 && failure.responseCode! < 600;
      const beforeSend = ["EAUTH", "EDNS", "ECONNECTION", "ETLS", "EENVELOPE", "EMESSAGE"].includes(failure.code ?? "") ||
        (failure.code === "ETIMEDOUT" && /^(CONN|EHLO|HELO|STARTTLS|AUTH)/.test(failure.command ?? ""));
      // Never persist SMTP error text: it may contain credentials or message content.
      throw new SupportMailError(rejected || beforeSend ? "not_sent" : "unknown");
    }
  } };
}
