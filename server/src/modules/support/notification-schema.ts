export const SUPPORT_NOTIFICATION_SCHEMA = `
CREATE TABLE support_notifications(
  ticket_id TEXT PRIMARY KEY REFERENCES support_tickets(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('accepted','pending','sending','sent','failed','unknown','declined')),
  reply_id TEXT REFERENCES ticket_replies(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
