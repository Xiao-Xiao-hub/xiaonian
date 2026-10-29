export const SUPPORT_TICKETS_SCHEMA = `
CREATE TABLE support_turns(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,raw_text TEXT NOT NULL,answer TEXT NOT NULL,layer TEXT NOT NULL,ticket_eligible INTEGER NOT NULL CHECK(ticket_eligible IN(0,1)),created_at TEXT NOT NULL);
CREATE INDEX support_turns_owner ON support_turns(user_id,created_at);
CREATE TABLE support_tickets(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,turn_id TEXT NOT NULL UNIQUE REFERENCES support_turns(id) ON DELETE CASCADE,idempotency_key TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('open','replied','closed')),content TEXT NOT NULL,due_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(user_id,idempotency_key));
CREATE INDEX support_tickets_owner ON support_tickets(user_id,created_at);
CREATE TABLE ticket_replies(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,actor TEXT NOT NULL,reason TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE support_mail_outbox(ticket_id TEXT PRIMARY KEY REFERENCES support_tickets(id) ON DELETE CASCADE,status TEXT NOT NULL CHECK(status IN('pending','sending','sent','failed','unknown')),attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
`;
