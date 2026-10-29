// Append this schema after COMMERCIAL_SCHEMA. Payment callbacks only update an
// existing created order; entitlement rows remain in the append-only buckets
// and entries tables owned by the commercial ledger.
export const COMMERCIAL_ORDERS_SCHEMA = `
CREATE TABLE commercial_orders(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  good_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 9007199254740991),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  catalog_version TEXT NOT NULL,
  env INTEGER NOT NULL CHECK(env=0),
  status TEXT NOT NULL CHECK(status IN ('created','paid','delivered','refunding','refunded','closed')),
  wx_order_id TEXT UNIQUE,
  platform TEXT CHECK(platform IN ('android','ios')),
  paid_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id,idempotency_key)
);
CREATE INDEX commercial_orders_owner ON commercial_orders(user_id,created_at DESC);
CREATE TABLE commercial_order_grants(
  order_id TEXT NOT NULL REFERENCES commercial_orders(id) ON DELETE CASCADE,
  bucket_id TEXT NOT NULL REFERENCES commercial_buckets(id) ON DELETE CASCADE,
  PRIMARY KEY(order_id,bucket_id)
);
`;
