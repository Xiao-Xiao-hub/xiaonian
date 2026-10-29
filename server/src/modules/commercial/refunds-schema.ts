// Appended by the main migration after commercial orders. Refund holds and
// final deductions remain append-only commercial_entries rows.
export const COMMERCIAL_REFUNDS_SCHEMA = `
CREATE TABLE commercial_refunds(
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES commercial_orders(id) ON DELETE CASCADE,
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 128),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  reason_code INTEGER NOT NULL CHECK(reason_code BETWEEN 0 AND 5),
  amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 9007199254740991),
  holdings TEXT NOT NULL CHECK(json_valid(holdings)),
  status TEXT NOT NULL CHECK(status IN ('pending','refunded','failed')),
  submission_status TEXT NOT NULL CHECK(submission_status IN ('unknown','accepted','failed')),
  failure_code TEXT,
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX commercial_refunds_pending ON commercial_refunds(status,requested_at,id);
`;
