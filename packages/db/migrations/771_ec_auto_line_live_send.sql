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

-- Record the source occurrence and immutable message snapshot with the event itself.
-- The dispatcher is separately gated off by default; these triggers never transmit.
CREATE TRIGGER ec_live_cart_browse_intent AFTER INSERT ON ec_behavior_events WHEN NEW.friend_id IS NOT NULL AND NEW.type IN ('cart_add','product_view') BEGIN INSERT INTO ec_auto_line_live_intents (id,account_id,kind,occurrence_key,friend_id,product_id,due_at,original_due_at,payload_json,created_at,updated_at) SELECT lower(hex(randomblob(16))),NEW.account_id,r.kind,NEW.id,NEW.friend_id,NEW.product_id, strftime('%Y-%m-%dT%H:%M:%fZ',NEW.occurred_at,printf('+%d minutes',r.wait_minutes)),strftime('%Y-%m-%dT%H:%M:%fZ',NEW.occurred_at,printf('+%d minutes',r.wait_minutes)),r.messages_json,NEW.received_at,NEW.received_at FROM ec_auto_line_rules r JOIN friends f ON f.id=NEW.friend_id AND f.line_account_id=NEW.account_id WHERE r.account_id=NEW.account_id AND r.enabled=1 AND r.kind=CASE NEW.type WHEN 'cart_add' THEN 'cart' ELSE 'browse' END AND (r.kind!='browse' OR (SELECT count(*) FROM ec_behavior_events e WHERE e.account_id=NEW.account_id AND e.friend_id=NEW.friend_id AND e.product_id=NEW.product_id AND e.type='product_view' AND julianday(e.occurred_at)>=julianday(NEW.occurred_at,'-24 hours'))>=2) ON CONFLICT(account_id,kind,occurrence_key,friend_id) DO NOTHING; END;
CREATE TRIGGER ec_live_restock_intents AFTER INSERT ON ec_behavior_events WHEN NEW.type='restock' AND json_extract(NEW.product_snapshot_json,'$.stock')>0 BEGIN INSERT INTO ec_restock_occurrences(id,account_id,product_id,source_event_id,occurred_at) VALUES(lower(hex(randomblob(16))),NEW.account_id,NEW.product_id,NEW.id,NEW.occurred_at) ON CONFLICT(account_id,source_event_id) DO NOTHING; INSERT INTO ec_auto_line_live_intents (id,account_id,kind,occurrence_key,friend_id,product_id,due_at,original_due_at,payload_json,created_at,updated_at) SELECT lower(hex(randomblob(16))),NEW.account_id,'restock',NEW.id,subscription.friend_id,NEW.product_id, NEW.occurred_at,NEW.occurred_at,r.messages_json,NEW.received_at,NEW.received_at FROM ec_auto_line_rules r JOIN ec_behavior_events subscription ON subscription.account_id=NEW.account_id AND subscription.product_id=NEW.product_id AND subscription.type='restock_subscribe' AND subscription.friend_id IS NOT NULL AND julianday(subscription.occurred_at)<julianday(NEW.occurred_at) JOIN friends f ON f.id=subscription.friend_id AND f.line_account_id=NEW.account_id WHERE r.account_id=NEW.account_id AND r.kind='restock' AND r.enabled=1 ON CONFLICT(account_id,kind,occurrence_key,friend_id) DO NOTHING; END;

-- Keep the existing cap ledger and its reservations while allowing a live intent as its candidate.
CREATE TABLE ec_auto_line_cap_reservations_new (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
 account_id TEXT NOT NULL REFERENCES line_accounts(id), friend_id TEXT NOT NULL REFERENCES friends(id),
 candidate_id TEXT REFERENCES ec_auto_line_sends(id), live_intent_id TEXT REFERENCES ec_auto_line_live_intents(id),
 mode TEXT NOT NULL CHECK(mode IN ('simulation','live')), canonical_product_id TEXT NOT NULL, source_product_id TEXT NOT NULL,
 day_jst TEXT NOT NULL, reserved_at TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('reserved','started','accepted','unknown','released')),
 release_actor TEXT, release_reason TEXT, released_at TEXT,
 UNIQUE(tenant_id,mode,candidate_id), UNIQUE(tenant_id,mode,live_intent_id),
 CHECK((candidate_id IS NOT NULL AND live_intent_id IS NULL) OR (mode='live' AND candidate_id IS NULL AND live_intent_id IS NOT NULL)),
 CHECK((state='released' AND release_actor IS NOT NULL AND release_reason IS NOT NULL AND released_at IS NOT NULL)
  OR (state!='released' AND release_actor IS NULL AND release_reason IS NULL AND released_at IS NULL))
);
INSERT INTO ec_auto_line_cap_reservations_new(id,tenant_id,user_id,account_id,friend_id,candidate_id,mode,canonical_product_id,source_product_id,day_jst,reserved_at,state,release_actor,release_reason,released_at)
 SELECT id,tenant_id,user_id,account_id,friend_id,candidate_id,mode,canonical_product_id,source_product_id,day_jst,reserved_at,state,release_actor,release_reason,released_at FROM ec_auto_line_cap_reservations;
DROP TABLE ec_auto_line_cap_reservations;
ALTER TABLE ec_auto_line_cap_reservations_new RENAME TO ec_auto_line_cap_reservations;
CREATE UNIQUE INDEX ec_auto_line_cap_one_per_day ON ec_auto_line_cap_reservations(tenant_id,user_id,mode,day_jst) WHERE state!='released';
CREATE INDEX ec_auto_line_cap_rolling ON ec_auto_line_cap_reservations(tenant_id,user_id,mode,reserved_at,canonical_product_id) WHERE state!='released';
