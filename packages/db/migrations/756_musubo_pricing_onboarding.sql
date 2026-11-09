-- 新料金・利用開始フローの保存先を追加する。
-- この移行は既存の課金状態を変更しない。新フローの有効化は別工程とする。

CREATE TABLE musubo_pricing_conditions (
  id TEXT PRIMARY KEY,
  condition_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  name TEXT NOT NULL,
  code_digest TEXT CHECK (code_digest IS NULL OR length(code_digest) = 64),
  company_name_key TEXT,
  valid_from TEXT,
  valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'disabled')),
  trial_unit TEXT NOT NULL CHECK (trial_unit IN ('days', 'months')),
  trial_value INTEGER NOT NULL CHECK (trial_value > 0),
  line_discount_percent INTEGER NOT NULL DEFAULT 0
    CHECK (line_discount_percent BETWEEN 0 AND 100),
  discount_ends_on TEXT,
  price_schedule_json TEXT NOT NULL CHECK (json_valid(price_schedule_json)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  disabled_at TEXT,
  UNIQUE (condition_key, version),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);
CREATE INDEX idx_musubo_conditions_code
  ON musubo_pricing_conditions(code_digest, status, valid_until)
  WHERE code_digest IS NOT NULL;
CREATE INDEX idx_musubo_conditions_company
  ON musubo_pricing_conditions(company_name_key, status, valid_until)
  WHERE company_name_key IS NOT NULL;
CREATE UNIQUE INDEX idx_musubo_conditions_active_version
  ON musubo_pricing_conditions(condition_key) WHERE status = 'active';
CREATE TRIGGER musubo_condition_version_immutable BEFORE UPDATE ON musubo_pricing_conditions
WHEN NEW.id IS NOT OLD.id OR NEW.condition_key IS NOT OLD.condition_key
  OR NEW.version IS NOT OLD.version OR NEW.name IS NOT OLD.name
  OR NEW.code_digest IS NOT OLD.code_digest OR NEW.company_name_key IS NOT OLD.company_name_key
  OR NEW.valid_from IS NOT OLD.valid_from OR NEW.valid_until IS NOT OLD.valid_until
  OR NEW.trial_unit IS NOT OLD.trial_unit OR NEW.trial_value IS NOT OLD.trial_value
  OR NEW.line_discount_percent IS NOT OLD.line_discount_percent
  OR NEW.discount_ends_on IS NOT OLD.discount_ends_on
  OR NEW.price_schedule_json IS NOT OLD.price_schedule_json
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'condition_version_immutable'); END;

INSERT INTO musubo_pricing_conditions
  (id,condition_key,version,name,status,trial_unit,trial_value,line_discount_percent,
   price_schedule_json,created_by,created_at,activated_at)
VALUES
  ('normal','normal',1,'通常条件','active','days',30,0,
   '{"firstLineYen":5900,"secondToFifthLineYen":7900,"sixthToTenthLineYen":6900,"headquartersYen":5500,"linkedAccountSlotYen":3300,"extraFriendBlockYen":1100,"extraFriendBlockSize":10000}',
   'system','2026-11-09T00:00:00+09:00','2026-11-09T00:00:00+09:00');

-- 承認時点の条件を固定し、後から条件の版が変わっても料金を遡及させない。
ALTER TABLE registration_applications ADD COLUMN pricing_condition_id TEXT;
ALTER TABLE registration_applications ADD COLUMN pricing_snapshot_json TEXT
  CHECK (pricing_snapshot_json IS NULL OR json_valid(pricing_snapshot_json));
CREATE INDEX idx_registration_applications_pricing_condition
  ON registration_applications(pricing_condition_id);

-- 個別見積もりは表示用ではなく最終単価を保存する。同意時刻は期限判定の根拠。
CREATE TABLE musubo_individual_quotes (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES registration_applications(id),
  tenant_id TEXT REFERENCES tenants(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sending', 'sent', 'accepted', 'superseded', 'expired')),
  final_prices_json TEXT NOT NULL CHECK (json_valid(final_prices_json)),
  customer_summary_json TEXT NOT NULL CHECK (json_valid(customer_summary_json)),
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  send_claimed_at TEXT,
  sent_at TEXT,
  accepted_at TEXT,
  accepted_by TEXT,
  superseded_at TEXT,
  UNIQUE (application_id, revision),
  CHECK ((accepted_at IS NULL AND accepted_by IS NULL)
    OR (accepted_at IS NOT NULL AND accepted_by IS NOT NULL))
);
CREATE INDEX idx_musubo_quotes_application
  ON musubo_individual_quotes(application_id, revision DESC);
CREATE INDEX idx_musubo_quotes_tenant
  ON musubo_individual_quotes(tenant_id, status);
CREATE TRIGGER musubo_quote_sent_terms_immutable BEFORE UPDATE ON musubo_individual_quotes
WHEN OLD.status <> 'draft' AND
  (NEW.id IS NOT OLD.id OR NEW.application_id IS NOT OLD.application_id
   OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.revision IS NOT OLD.revision
   OR NEW.final_prices_json IS NOT OLD.final_prices_json
   OR NEW.customer_summary_json IS NOT OLD.customer_summary_json
   OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_by IS NOT OLD.created_by
   OR NEW.created_at IS NOT OLD.created_at)
BEGIN SELECT RAISE(ABORT, 'sent_quote_terms_immutable'); END;
CREATE TRIGGER musubo_quote_accepted_immutable BEFORE UPDATE ON musubo_individual_quotes
WHEN OLD.status = 'accepted' AND
  (NEW.status IS NOT OLD.status OR NEW.accepted_at IS NOT OLD.accepted_at
   OR NEW.accepted_by IS NOT OLD.accepted_by)
BEGIN SELECT RAISE(ABORT, 'accepted_quote_immutable'); END;

-- 旧 tenants.plan_* は既存契約用。新料金は別行で明示的に管理する。
CREATE TABLE musubo_tenant_billing (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  application_id TEXT REFERENCES registration_applications(id),
  quote_id TEXT REFERENCES musubo_individual_quotes(id),
  pricing_snapshot_json TEXT NOT NULL CHECK (json_valid(pricing_snapshot_json)),
  pricing_selection_json TEXT CHECK (pricing_selection_json IS NULL OR json_valid(pricing_selection_json)),
  pricing_consented_at TEXT,
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('month', 'year')),
  status TEXT NOT NULL DEFAULT 'awaiting_first_line'
    CHECK (status IN ('awaiting_first_line', 'trialing', 'active', 'past_due', 'ended')),
  first_line_activated_at TEXT,
  trial_last_free_date TEXT,
  first_charge_date TEXT,
  core_subscription_id TEXT,
  options_subscription_id TEXT,
  next_monthly_charge_at TEXT,
  next_annual_renewal_at TEXT,
  termination_requested_at TEXT,
  termination_effective_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (pricing_consented_at IS NULL OR pricing_selection_json IS NOT NULL),
  CHECK (first_line_activated_at IS NOT NULL OR
    (trial_last_free_date IS NULL AND first_charge_date IS NULL))
);
CREATE UNIQUE INDEX idx_musubo_billing_core_subscription
  ON musubo_tenant_billing(core_subscription_id) WHERE core_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX idx_musubo_billing_options_subscription
  ON musubo_tenant_billing(options_subscription_id) WHERE options_subscription_id IS NOT NULL;

-- LINEごとの有効化と追加連携枠の請求数を、実際の接続数から区別する。
CREATE TABLE musubo_line_usage (
  line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'ending', 'ended')),
  activated_at TEXT,
  ended_at TEXT,
  google_business_count INTEGER NOT NULL DEFAULT 0 CHECK (google_business_count >= 0),
  instagram_count INTEGER NOT NULL DEFAULT 0 CHECK (instagram_count >= 0),
  billed_linked_slots INTEGER NOT NULL DEFAULT 0 CHECK (billed_linked_slots >= 0),
  linked_slots_reduction_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_musubo_line_usage_tenant
  ON musubo_line_usage(tenant_id, status);

-- 追加分の支払い失敗は既存利用を止めず、対象だけを保留する。
CREATE TABLE musubo_pending_additions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL CHECK (kind IN ('line', 'linked_slot')),
  line_account_id TEXT REFERENCES line_accounts(id),
  status TEXT NOT NULL DEFAULT 'awaiting_payment'
    CHECK (status IN ('awaiting_payment', 'paid', 'activated', 'expired', 'cancelled')),
  amount_due_yen INTEGER NOT NULL CHECK (amount_due_yen >= 0),
  price_snapshot_json TEXT NOT NULL CHECK (json_valid(price_snapshot_json)),
  stripe_invoice_id TEXT,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  activated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_musubo_pending_additions_invoice
  ON musubo_pending_additions(stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;
CREATE INDEX idx_musubo_pending_additions_tenant
  ON musubo_pending_additions(tenant_id, status, expires_at);
