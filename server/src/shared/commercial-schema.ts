// Append this schema as one migration. Monetary changes live only in entries;
// calls contain lifecycle metadata, never a mutable account balance.
export const COMMERCIAL_SCHEMA = `
CREATE TABLE commercial_buckets(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('free_day','free_week','free_month','plan_week','plan_total','wallet')),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER CHECK(ends_at IS NULL OR ends_at>starts_at),
  grant_credits INTEGER NOT NULL CHECK(grant_credits BETWEEN 0 AND 9007199254740991),
  created_at TEXT NOT NULL
);
CREATE INDEX commercial_buckets_owner ON commercial_buckets(user_id,kind,ends_at);
CREATE TABLE commercial_calls(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  source TEXT NOT NULL,
  price TEXT NOT NULL CHECK(json_valid(price)),
  allocations TEXT NOT NULL CHECK(json_valid(allocations)),
  reserved_credits INTEGER NOT NULL CHECK(reserved_credits BETWEEN 0 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN ('held','settled','released')),
  lease_until INTEGER NOT NULL,
  cost_microyuan INTEGER CHECK(cost_microyuan BETWEEN 0 AND 9007199254740991),
  exact_numerator TEXT CHECK(exact_numerator IS NULL OR (length(exact_numerator)>0 AND exact_numerator NOT GLOB '*[^0-9]*')),
  exact_denominator TEXT CHECK(exact_denominator IS NULL OR (length(exact_denominator)>0 AND exact_denominator NOT GLOB '*[^0-9]*' AND ltrim(exact_denominator,'0')<>'')),
  microyuan_per_credit INTEGER CHECK(microyuan_per_credit BETWEEN 1 AND 9007199254740991),
  charged_credits INTEGER CHECK(charged_credits BETWEEN 0 AND 9007199254740991),
  remainder_delta INTEGER,
  remainder_before TEXT CHECK(remainder_before IS NULL OR (length(remainder_before)>0 AND remainder_before NOT GLOB '*[^0-9]*')),
  remainder_after TEXT CHECK(remainder_after IS NULL OR (length(remainder_after)>0 AND remainder_after NOT GLOB '*[^0-9]*')),
  overrun_credits INTEGER CHECK(overrun_credits BETWEEN 0 AND 9007199254740991),
  settlement_seq INTEGER UNIQUE,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX commercial_calls_owner ON commercial_calls(user_id,status,created_at);
CREATE INDEX commercial_calls_expiry ON commercial_calls(status,lease_until);
CREATE INDEX commercial_calls_exact_remainder ON commercial_calls(user_id,status,exact_denominator,microyuan_per_credit,settlement_seq DESC);
CREATE TABLE commercial_free_entries(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,
  call_id TEXT REFERENCES commercial_calls(id) ON DELETE SET NULL,
  event_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('grant','reserve','settle','release')),
  delta INTEGER NOT NULL CHECK(delta BETWEEN -9007199254740991 AND 9007199254740991),
  created_at TEXT NOT NULL
);
CREATE INDEX commercial_free_entries_month ON commercial_free_entries(month,id);
CREATE TABLE commercial_entries(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket_id TEXT NOT NULL REFERENCES commercial_buckets(id) ON DELETE CASCADE,
  call_id TEXT REFERENCES commercial_calls(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('grant','reserve','settle','release','refund')),
  delta INTEGER NOT NULL CHECK(delta BETWEEN -9007199254740991 AND 9007199254740991),
  created_at TEXT NOT NULL
);
CREATE INDEX commercial_entries_bucket ON commercial_entries(bucket_id,id);
CREATE TABLE commercial_usage(
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('llm','jev','ocr')),
  price TEXT NOT NULL CHECK(json_valid(price)),
  status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed','unknown')),
  usage TEXT CHECK(usage IS NULL OR json_valid(usage)),
  cost_microyuan INTEGER CHECK(cost_microyuan BETWEEN 0 AND 9007199254740991),
  exact_numerator TEXT CHECK(exact_numerator IS NULL OR (length(exact_numerator)>0 AND exact_numerator NOT GLOB '*[^0-9]*')),
  exact_denominator TEXT CHECK(exact_denominator IS NULL OR (length(exact_denominator)>0 AND exact_denominator NOT GLOB '*[^0-9]*' AND ltrim(exact_denominator,'0')<>'')),
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX commercial_usage_owner ON commercial_usage(user_id,created_at);
CREATE TABLE wechat_payment_sessions(
  session_hash TEXT PRIMARY KEY REFERENCES sessions(hash) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  refreshed_at TEXT NOT NULL
);
`;
