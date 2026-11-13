-- G6-cap: separate ledger for verified, company-wide notification reservations.
-- Existing simulation records do not represent real deliveries and are not imported.
CREATE TABLE ec_auto_line_product_identities (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  account_id TEXT NOT NULL REFERENCES line_accounts(id),
  product_id TEXT NOT NULL,
  canonical_product_id TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (tenant_id, account_id, product_id)
);

CREATE TABLE ec_auto_line_cap_reservations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  account_id TEXT NOT NULL REFERENCES line_accounts(id),
  friend_id TEXT NOT NULL REFERENCES friends(id),
  candidate_id TEXT NOT NULL REFERENCES ec_auto_line_sends(id),
  mode TEXT NOT NULL CHECK (mode IN ('simulation', 'live')),
  canonical_product_id TEXT NOT NULL,
  source_product_id TEXT NOT NULL,
  day_jst TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'started', 'accepted', 'unknown', 'released')),
  release_actor TEXT,
  release_reason TEXT,
  released_at TEXT,
  UNIQUE (tenant_id, mode, candidate_id),
  CHECK ((state = 'released' AND release_actor IS NOT NULL AND release_reason IS NOT NULL AND released_at IS NOT NULL)
      OR (state != 'released' AND release_actor IS NULL AND release_reason IS NULL AND released_at IS NULL))
);
CREATE UNIQUE INDEX ec_auto_line_cap_one_per_day
  ON ec_auto_line_cap_reservations(tenant_id, user_id, mode, day_jst) WHERE state != 'released';
CREATE INDEX ec_auto_line_cap_rolling
  ON ec_auto_line_cap_reservations(tenant_id, user_id, mode, reserved_at, canonical_product_id) WHERE state != 'released';
