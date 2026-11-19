-- G6: live delivery intents are separate from the existing simulation history.
CREATE TABLE ec_auto_line_live_intents (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES line_accounts(id),
 kind TEXT NOT NULL CHECK(kind IN ('cart','browse','restock')),
 occurrence_key TEXT NOT NULL,
 friend_id TEXT NOT NULL REFERENCES friends(id),
 product_id TEXT NOT NULL,
 due_at TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 state TEXT NOT NULL DEFAULT 'scheduled' CHECK(state IN ('scheduled','sending','sent','failed','unknown')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(account_id,kind,occurrence_key,friend_id)
);
CREATE INDEX ec_auto_line_live_intents_due ON ec_auto_line_live_intents(state,due_at);
CREATE TABLE ec_restock_occurrences (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES line_accounts(id),
 product_id TEXT NOT NULL,
 source_event_id TEXT NOT NULL,
 occurred_at TEXT NOT NULL,
 UNIQUE(account_id,source_event_id)
);
