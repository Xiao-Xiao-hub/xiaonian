/** Migration 21 candidate. Append after SUPPORT_TICKETS_SCHEMA. */
export const SUPPORT_SESSION_SCHEMA = `
CREATE TABLE support_sessions(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  turn_count INTEGER NOT NULL DEFAULT 0 CHECK(turn_count BETWEEN 0 AND 10),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX support_sessions_owner ON support_sessions(user_id,updated_at DESC);

CREATE TABLE support_session_turns(
  session_id TEXT NOT NULL REFERENCES support_sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL UNIQUE REFERENCES support_turns(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 10),
  PRIMARY KEY(session_id,position)
);

CREATE TABLE support_chat_requests(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES support_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('processing','completed')),
  turn_id TEXT,
  position INTEGER CHECK(position IS NULL OR position BETWEEN 1 AND 10),
  answer TEXT,
  layer TEXT,
  ticket_eligible INTEGER CHECK(ticket_eligible IS NULL OR ticket_eligible IN(0,1)),
  resource_path TEXT,
  duplicate INTEGER NOT NULL DEFAULT 0 CHECK(duplicate IN(0,1)),
  created_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(user_id,idempotency_key)
);
CREATE INDEX support_chat_requests_rate ON support_chat_requests(user_id,created_ms);
CREATE INDEX support_chat_requests_dedupe ON support_chat_requests(user_id,session_id,text_hash,created_ms DESC);

CREATE TABLE support_cost_holds(
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('judge','generate')),
  reserved_microyuan INTEGER NOT NULL CHECK(reserved_microyuan BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN('held','retained','released')),
  created_ms INTEGER NOT NULL,
  finished_at TEXT
);
CREATE INDEX support_cost_holds_day ON support_cost_holds(day,status,id);
`;
