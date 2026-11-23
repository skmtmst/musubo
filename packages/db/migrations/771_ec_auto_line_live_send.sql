-- migration-policy: table-rebuild
-- G6: live delivery intents are separate from the existing simulation history.
CREATE TABLE ec_auto_line_live_intents (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES line_accounts(id),
 kind TEXT NOT NULL CHECK(kind IN ('cart','browse','restock')),
 occurrence_key TEXT NOT NULL,
 friend_id TEXT NOT NULL REFERENCES friends(id),
 product_id TEXT NOT NULL,
 due_at TEXT NOT NULL,
 original_due_at TEXT,
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


-- Keep the existing cap ledger and its reservations while allowing a live intent as its candidate.
CREATE TABLE ec_auto_line_cap_reservations_new (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
 account_id TEXT NOT NULL REFERENCES line_accounts(id), friend_id TEXT NOT NULL REFERENCES friends(id),
 candidate_id TEXT REFERENCES ec_auto_line_sends(id), live_intent_id TEXT REFERENCES ec_auto_line_live_intents(id),
 mode TEXT NOT NULL CHECK(mode IN ('simulation','live')), canonical_product_id TEXT NOT NULL, source_product_id TEXT NOT NULL,
 day_jst TEXT NOT NULL, reserved_at TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('reserved','started','accepted','unknown','released')),
 release_actor TEXT, release_reason TEXT, released_at TEXT,
 UNIQUE(tenant_id,mode,candidate_id),
 CHECK((candidate_id IS NOT NULL AND live_intent_id IS NULL) OR (mode='live' AND candidate_id IS NULL AND live_intent_id IS NOT NULL)),
 CHECK((state='released' AND release_actor IS NOT NULL AND release_reason IS NOT NULL AND released_at IS NOT NULL)
  OR (state!='released' AND release_actor IS NULL AND release_reason IS NULL AND released_at IS NULL))
);
INSERT INTO ec_auto_line_cap_reservations_new(id,tenant_id,user_id,account_id,friend_id,candidate_id,mode,canonical_product_id,source_product_id,day_jst,reserved_at,state,release_actor,release_reason,released_at)
 SELECT id,tenant_id,user_id,account_id,friend_id,candidate_id,mode,canonical_product_id,source_product_id,day_jst,reserved_at,state,release_actor,release_reason,released_at FROM ec_auto_line_cap_reservations;
DROP TABLE ec_auto_line_cap_reservations;
ALTER TABLE ec_auto_line_cap_reservations_new RENAME TO ec_auto_line_cap_reservations;
CREATE UNIQUE INDEX ec_auto_line_cap_live_intent ON ec_auto_line_cap_reservations(tenant_id,mode,live_intent_id) WHERE live_intent_id IS NOT NULL AND state!='released';
CREATE UNIQUE INDEX ec_auto_line_cap_one_per_day ON ec_auto_line_cap_reservations(tenant_id,user_id,mode,day_jst) WHERE state!='released';
CREATE INDEX ec_auto_line_cap_rolling ON ec_auto_line_cap_reservations(tenant_id,user_id,mode,reserved_at,canonical_product_id) WHERE state!='released';
