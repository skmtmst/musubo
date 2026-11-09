-- Generated from schema.sql + migrations by scripts/generate-bootstrap.mjs.
-- Do not edit manually. Run `pnpm --dir packages/db generate:bootstrap`.
CREATE TABLE _556_folders_backup_auto_replies (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _556_folders_backup_broadcasts (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _556_folders_backup_common_vars (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _556_folders_backup_forms (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _556_folders_backup_friend_fields (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _556_folders_backup_media (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _556_folders_backup_media_upload_sessions (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _556_folders_backup_reminders (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _556_folders_backup_rich_menu_groups (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _556_folders_backup_scenarios (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _556_folders_backup_tags (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _556_folders_backup_templates (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _556_folders_backup_webinars (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_auto_replies (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_automation_definitions (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_broadcasts (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_common_actions (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_common_vars (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_conversion_points (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_folder_parents (id TEXT PRIMARY KEY, parent_id TEXT);

CREATE TABLE _617_backup_folders(
  id TEXT,
  kind TEXT,
  name TEXT,
  parent_id TEXT,
  display_order INT,
  created_at TEXT,
  updated_at TEXT,
  color TEXT,
  account_id TEXT
);

CREATE TABLE _617_backup_forms (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_friend_fields (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_incoming_webhooks (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_media (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_media_upload_sessions (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_mileage_rewards(
  id TEXT,
  line_account_id TEXT,
  program_id TEXT,
  name TEXT,
  description TEXT,
  image_url TEXT,
  reward_kind TEXT,
  status TEXT,
  sort_order INT,
  current_draft_version_id TEXT,
  current_published_version_id TEXT,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT,
  archived_at TEXT,
  folder_id TEXT
);

CREATE TABLE _617_backup_outgoing_webhooks (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_reminders (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_rich_menu_groups (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_scenarios (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_tags (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_templates (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE _617_backup_webinars (id TEXT PRIMARY KEY, folder_id TEXT);

CREATE TABLE account_ai_features (
 account_id TEXT NOT NULL REFERENCES line_accounts(id),feature TEXT NOT NULL CHECK(feature IN('banner','google_review')),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),version INTEGER NOT NULL DEFAULT 1,
 consent_by TEXT,consent_at TEXT,disclosure_version TEXT,
 CHECK(enabled=0 OR (consent_by IS NOT NULL AND consent_at IS NOT NULL AND disclosure_version IS NOT NULL)),
 PRIMARY KEY(account_id,feature)
);

CREATE TABLE account_handover_decisions (
  id              TEXT PRIMARY KEY,
  handover_id     TEXT NOT NULL REFERENCES account_handovers(id) ON DELETE CASCADE,
  -- 引き継ぎ元の友だち。
  from_friend_id  TEXT NOT NULL,
  -- 結びつける先。link のときだけ入る。
  to_friend_id    TEXT,
  /*
    決めたこと。
      link … 同じ人として結びつける
      new  … 別人として新しく作る
      skip … 引き継がない
  */
  decision        TEXT NOT NULL CHECK (decision IN ('link','new','skip')),
  -- 事前確認がどの区分に入れたか。人が覆した記録を残すため。
  bucket          TEXT NOT NULL CHECK (bucket IN ('auto','review','unmatched','lookalike')),
  note            TEXT,
  decided_by      TEXT,
  decided_at      TEXT NOT NULL,
  UNIQUE (handover_id, from_friend_id)
);

CREATE TABLE account_handovers (
  id                  TEXT PRIMARY KEY,
  -- 引き継ぎ元。コードを出した側。
  from_account_id     TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  -- 引き継ぎ先。コードを読んだ側。読まれるまでは null。
  to_account_id       TEXT REFERENCES line_accounts(id) ON DELETE CASCADE,
  -- 段1で出すコード。読まれたあとも記録として残す。
  code                TEXT NOT NULL UNIQUE,
  code_expires_at     TEXT NOT NULL,
  /*
    段。設計の5段に対応する。
      code_issued … 1 コードを出した
      linked      … 2 受け取り先で読んだ
      previewed   … 3 事前確認が終わった
      resolved    … 4 競合の判断が終わった
      executing   … 5 本実行の最中
      completed   … 5 本実行と照合が終わった
    途中でやめたときは cancelled、失敗したときは failed。
  */
  status              TEXT NOT NULL DEFAULT 'code_issued'
                        CHECK (status IN ('code_issued','linked','previewed','resolved',
                                          'executing','completed','failed','cancelled')),
  /*
    プロバイダーが同じか。**分からないことを「同じ」と書かない。**
    どちらかの provider_id が入っていなければ unknown。
  */
  provider_match      TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (provider_match IN ('same','different','unknown')),
  /*
    事前確認の結果。**4区分の合計が source_friend_total と必ず合う。**
    合わないと、どこかの人が消えたように見える。まだ確認していない間は null。
  */
  source_friend_total INTEGER,
  auto_count          INTEGER,
  review_count        INTEGER,
  unmatched_count     INTEGER,
  lookalike_count     INTEGER,
  -- 本実行の進み。照合はこの2つを突き合わせて出す。
  moved_count         INTEGER NOT NULL DEFAULT 0,
  failed_count        INTEGER NOT NULL DEFAULT 0,
  failure_reason      TEXT,
  created_by          TEXT,
  created_at          TEXT NOT NULL,
  linked_at           TEXT,
  previewed_at        TEXT,
  resolved_at         TEXT,
  executed_at         TEXT,
  completed_at        TEXT
, declared_friend_total INTEGER, rolled_back_at TEXT, rolled_back_by TEXT, rollback_note TEXT);

CREATE TABLE account_health_logs (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  error_code      INTEGER,
  error_count     INTEGER NOT NULL DEFAULT 0,
  check_period    TEXT NOT NULL,
  risk_level      TEXT NOT NULL DEFAULT 'normal' CHECK (risk_level IN ('normal', 'warning', 'danger')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE account_migrations (
  id               TEXT PRIMARY KEY,
  from_account_id  TEXT NOT NULL,
  to_account_id    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  migrated_count   INTEGER NOT NULL DEFAULT 0,
  total_count      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  completed_at     TEXT
);

CREATE TABLE account_pool_switch_events (
  id              TEXT PRIMARY KEY,
  pool_id         TEXT NOT NULL REFERENCES traffic_pools(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL CHECK (direction IN ('out', 'in')),
  reason          TEXT NOT NULL,
  actor           TEXT NOT NULL DEFAULT 'system',
  created_at      TEXT NOT NULL
);

CREATE TABLE account_settings (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE(line_account_id, key)
);

CREATE TABLE account_skipped_deliveries (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  ref_id          TEXT NOT NULL,
  title           TEXT,
  reason          TEXT NOT NULL DEFAULT 'account_inactive',
  skipped_at      TEXT NOT NULL,
  UNIQUE (kind, ref_id)
);

CREATE TABLE account_styles (
 line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id),
 style TEXT NOT NULL CHECK(style IN('standard','ec','restaurant','salon','consult','lesson')),
 answers_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(answers_json)),
 cards_json TEXT CHECK(cards_json IS NULL OR json_valid(cards_json)),
 selected_at TEXT,
settings_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(settings_json)),
 version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT
, selection_mode TEXT NOT NULL DEFAULT 'configured' CHECK(selection_mode IN ('configured','later','manual')), metrics_json TEXT CHECK(metrics_json IS NULL OR json_valid(metrics_json)));

CREATE TABLE action_score_rule_sets (
  id                           TEXT PRIMARY KEY,
  line_account_id              TEXT NOT NULL UNIQUE REFERENCES line_accounts(id),
  status                       TEXT NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft', 'published', 'stopped')),
  current_draft_version_id     TEXT REFERENCES action_score_rule_versions(id)
                                 DEFERRABLE INITIALLY DEFERRED,
  current_published_version_id TEXT REFERENCES action_score_rule_versions(id)
                                 DEFERRABLE INITIALLY DEFERRED,
  created_by                   TEXT,
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE action_score_rule_versions (
  id               TEXT PRIMARY KEY,
  rule_set_id      TEXT NOT NULL REFERENCES action_score_rule_sets(id),
  version_number   INTEGER NOT NULL CHECK (version_number > 0),
  status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'published')),
  rules_json       TEXT NOT NULL DEFAULT '[]',
  min_score        INTEGER NOT NULL DEFAULT 0,
  max_score        INTEGER NOT NULL DEFAULT 100,
  normal_min       INTEGER NOT NULL DEFAULT 30,
  high_min         INTEGER NOT NULL DEFAULT 70,
  created_by       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  published_by     TEXT,
  published_at     TEXT,
  UNIQUE (rule_set_id, version_number),
  CHECK (min_score >= 0),
  CHECK (max_score > min_score),
  CHECK (normal_min > min_score AND normal_min < high_min),
  CHECK (high_min < max_score)
);

CREATE TABLE ad_conversion_event_accounts (
  conversion_event_id TEXT PRIMARY KEY REFERENCES conversion_events(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  platform_ids_json TEXT NOT NULL CHECK(json_valid(platform_ids_json))
);

CREATE TABLE ad_conversion_logs (
  id                  TEXT PRIMARY KEY,
  ad_platform_id      TEXT NOT NULL,
  friend_id           TEXT NOT NULL,
  conversion_point_id TEXT,
  event_name          TEXT NOT NULL,
  click_id            TEXT,
  click_id_type       TEXT,
  status              TEXT DEFAULT 'pending',
  request_body        TEXT,
  response_body       TEXT,
  error_message       TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL, idempotency_key TEXT, lease_token TEXT, provider_event_id TEXT);

CREATE TABLE ad_conversion_outbox (
  id                TEXT PRIMARY KEY,
  ad_platform_id    TEXT NOT NULL REFERENCES ad_platforms(id) ON DELETE CASCADE,
  friend_id         TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  line_account_id   TEXT REFERENCES line_accounts(id) ON DELETE SET NULL,
  event_name        TEXT NOT NULL,
  event_value       REAL,
  currency          TEXT NOT NULL DEFAULT 'JPY',
  amount_in_minor_unit INTEGER NOT NULL DEFAULT 0,
  idempotency_key   TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at   TEXT,
  lease_token       TEXT,
  provider_event_id TEXT,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL, ref_tracking_id TEXT, click_id TEXT, click_id_type TEXT, click_recorded_at TEXT, click_expires_at TEXT, click_consent_at TEXT, click_context_json TEXT, selection_reason TEXT NOT NULL DEFAULT 'legacy_unsnapshotted', is_retryable INTEGER NOT NULL DEFAULT 1
  CHECK (is_retryable IN (0, 1)),
  UNIQUE (ad_platform_id, friend_id, event_name, idempotency_key)
);

CREATE TABLE ad_cost_entries (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  ad_platform_id  TEXT REFERENCES ad_platforms(id) ON DELETE SET NULL,
  entry_route_id  TEXT REFERENCES entry_routes(id) ON DELETE SET NULL,
  source_label    TEXT NOT NULL,
  day             TEXT NOT NULL,
  amount_minor    INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency        TEXT NOT NULL DEFAULT 'JPY',
  source          TEXT NOT NULL CHECK (source IN ('import', 'manual')),
  imported_at     TEXT,
  created_by      TEXT REFERENCES staff_members(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, cancelled_at TEXT, cancel_reason TEXT);

CREATE TABLE ad_cost_import_runs (
  id             TEXT PRIMARY KEY,
  ad_platform_id TEXT NOT NULL REFERENCES ad_platforms(id) ON DELETE CASCADE,
  day            TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  error_message  TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (ad_platform_id, day)
);

CREATE TABLE ad_event_mapping_dispatches (
  conversion_event_id TEXT NOT NULL REFERENCES conversion_events(id) ON DELETE CASCADE,
  ad_platform_id TEXT NOT NULL REFERENCES ad_platforms(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(conversion_event_id,ad_platform_id)
);

CREATE TABLE ad_event_mappings (
  conversion_point_id TEXT NOT NULL REFERENCES conversion_points(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('meta','google')),
  mode TEXT NOT NULL CHECK(mode IN ('auto','manual','off')),
  event_name TEXT,
  google_action_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(conversion_point_id,line_account_id,provider)
);

CREATE TABLE ad_platforms (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  display_name TEXT,
  config       TEXT NOT NULL DEFAULT '{}',
  is_active    INTEGER DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT REFERENCES line_accounts(id) ON DELETE CASCADE, config_encrypted TEXT, verified_at TEXT);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id   TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), selected_restaurant_store_id TEXT
  REFERENCES rt_stores(id) ON DELETE SET NULL, user_agent TEXT, ip_prefix TEXT, step_up_at TEXT, device_hash TEXT, unfamiliar_at TEXT,
  FOREIGN KEY (staff_id) REFERENCES staff_members(id) ON DELETE CASCADE
);

CREATE TABLE admin_two_factor_challenges (
  token_hash TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), purpose TEXT NOT NULL DEFAULT 'verify', remember INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (staff_id) REFERENCES staff_members(id) ON DELETE CASCADE
);

CREATE TABLE admin_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, two_factor_enabled INTEGER NOT NULL DEFAULT 0);

CREATE TABLE affiliate_adjustments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenants(id),
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  affiliate_id TEXT NOT NULL REFERENCES affiliates(id),
  source_entry_id TEXT REFERENCES affiliate_reward_entries(id),
  applied_settlement_id TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'JPY' CHECK (currency = 'JPY'),
  reason_type TEXT NOT NULL CHECK (reason_type IN ('refund', 'cancel', 'manual')),
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied')),
  idempotency_key TEXT NOT NULL UNIQUE,
  applied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE affiliate_attribution_decisions (
  id TEXT PRIMARY KEY,
  conversion_event_id TEXT NOT NULL UNIQUE REFERENCES conversion_events(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL,
  conversion_point_id TEXT NOT NULL,
  -- 付けた先。付けなかったときは空。
  affiliate_id TEXT REFERENCES affiliates(id),
  ref_code TEXT,
  offer_id TEXT REFERENCES affiliate_offers(id),
  -- 判断に使った案件の版。版を変えてもこの記録は変わらない。
  offer_version_id TEXT REFERENCES affiliate_offer_versions(id),
  -- 判断の理由。画面には人の言葉で出す。
  reason TEXT NOT NULL CHECK (reason IN (
    'matched_last_touch',
    'no_touch',
    'out_of_window',
    'self_referral',
    'inactive_link',
    'inactive_affiliate',
    'other_account',
    'reception_closed',
    'capped_total',
    'capped_monthly'
  )),
  -- 判断に使った数える期間(日)。案件の版があればその値、なければ全体の既定。
  window_days INTEGER NOT NULL CHECK (window_days BETWEEN 1 AND 365),
  -- 候補になった紹介の写し(JSON)。紹介者名・案件名・開いた時刻・結果を
  -- 判断の時点で残す。後から名前が変わっても、この記録は書き換えない。
  candidates_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE affiliate_bank_profiles (
  affiliate_id TEXT PRIMARY KEY REFERENCES affiliates(id),
  organization_id TEXT NOT NULL REFERENCES tenants(id),
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  bank_code TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  branch_code TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('ordinary', 'checking')),
  account_number_encrypted TEXT NOT NULL,
  account_last4 TEXT NOT NULL,
  account_holder_name TEXT NOT NULL,
  account_fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  last_idempotency_key TEXT NOT NULL,
  last_request_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (organization_id, line_account_id, last_idempotency_key)
);

CREATE TABLE affiliate_clicks (
  id           TEXT PRIMARY KEY,
  affiliate_id TEXT NOT NULL REFERENCES affiliates (id) ON DELETE CASCADE,
  url          TEXT,
  ip_address   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE affiliate_links (
  id              TEXT PRIMARY KEY,
  affiliate_id    TEXT NOT NULL REFERENCES affiliates (id),
  ref_code        TEXT NOT NULL UNIQUE,
  label           TEXT,
  line_account_id TEXT REFERENCES line_accounts (id),
  offer_id        TEXT REFERENCES affiliate_offers (id),
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  click_count     INTEGER NOT NULL DEFAULT 0
, operation_id TEXT);

CREATE TABLE affiliate_offer_versions (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES affiliate_offers(id),
  version_number INTEGER NOT NULL,
  -- 1件あたりの報酬。固定額(円)とマイル。
  reward_amount INTEGER NOT NULL DEFAULT 0 CHECK (reward_amount >= 0),
  reward_miles INTEGER NOT NULL DEFAULT 0 CHECK (reward_miles >= 0),
  -- リンクを開いてから数える期間(日)。既定 30。
  window_days INTEGER NOT NULL DEFAULT 30 CHECK (window_days BETWEEN 1 AND 365),
  -- 上限。空は「上限なし」。上限に達したら受付を自動で止める。
  cap_total INTEGER CHECK (cap_total IS NULL OR cap_total > 0),
  cap_monthly_per_affiliate INTEGER CHECK (cap_monthly_per_affiliate IS NULL OR cap_monthly_per_affiliate > 0),
  -- 受付の期間。空の端は「区切りなし」。期間外の紹介には成果を付けない。
  reception_from TEXT,
  reception_to TEXT,
  -- 使い始めの日時。空は「公開と同時」。未来の日時は「予約」の札で見せる。
  effective_from TEXT,
  created_by_staff_id TEXT,
  -- 同じ確認キーの再送では版を増やさないための鍵。
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (offer_id, version_number)
);

CREATE TABLE affiliate_offers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  reward_amount   INTEGER NOT NULL DEFAULT 0,
  reward_miles    INTEGER NOT NULL DEFAULT 0,
  mileage_program_id TEXT NOT NULL DEFAULT 'default' REFERENCES mileage_programs (id),
  line_account_id TEXT REFERENCES line_accounts (id),
  tag_id          TEXT REFERENCES tags (id),
  scenario_id     TEXT REFERENCES scenarios (id),
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
, operation_id TEXT, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL);

CREATE TABLE "affiliate_payout_batch_lines" (
  affiliate_id_history TEXT,
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES affiliate_payout_batches(id),
  settlement_line_id TEXT NOT NULL REFERENCES affiliate_settlement_lines(id),
  affiliate_id TEXT REFERENCES affiliates(id) ON DELETE SET NULL,
  amount_minor INTEGER NOT NULL,
  bank_code TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  branch_code TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('ordinary', 'checking')),
  account_number_encrypted TEXT NOT NULL,
  account_last4 TEXT NOT NULL,
  account_holder_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (batch_id, settlement_line_id)
);

CREATE TABLE affiliate_payout_batches (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenants(id),
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  settlement_id TEXT NOT NULL REFERENCES affiliate_settlements(id),
  total_amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'JPY' CHECK (currency = 'JPY'),
  line_count INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('created', 'approved', 'exported', 'imported')),
  bank_format TEXT,
  file_checksum TEXT,
  created_by TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  exported_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, version INTEGER NOT NULL DEFAULT 1, idempotency_key TEXT, request_fingerprint TEXT, export_object_key TEXT, export_expires_at TEXT, download_token_hash TEXT, export_idempotency_key TEXT, export_request_fingerprint TEXT);

CREATE TABLE "affiliate_payout_results" (
  affiliate_id_history TEXT,
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES affiliate_payout_batches(id),
  affiliate_id TEXT REFERENCES affiliates(id) ON DELETE SET NULL,
  settlement_line_id TEXT NOT NULL REFERENCES affiliate_settlement_lines(id),
  paid_amount_minor INTEGER NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('paid', 'failed', 'returned')),
  external_reference TEXT,
  imported_by TEXT NOT NULL,
  paid_at TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE affiliate_reward_calculations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenants(id),
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  affiliate_id TEXT NOT NULL REFERENCES affiliates(id),
  conversion_event_id TEXT NOT NULL REFERENCES conversion_events(id),
  offer_id TEXT REFERENCES affiliate_offers(id),
  formula TEXT NOT NULL CHECK (formula IN ('rate', 'fixed', 'legacy')),
  commission_rate_snapshot REAL,
  base_amount_snapshot REAL,
  fixed_reward_snapshot INTEGER,
  offer_name_snapshot TEXT NOT NULL DEFAULT '',
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'JPY' CHECK (currency = 'JPY'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (conversion_event_id)
);

CREATE TABLE affiliate_reward_entries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenants(id),
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  affiliate_id TEXT NOT NULL REFERENCES affiliates(id),
  conversion_event_id TEXT NOT NULL REFERENCES conversion_events(id),
  offer_id TEXT REFERENCES affiliate_offers(id),
  offer_version_id TEXT,
  reward_calculation_id TEXT,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('credit', 'debit')),
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'JPY' CHECK (currency = 'JPY'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'held', 'payable', 'settled', 'paid', 'reversed')),
  approved_at TEXT,
  payable_at TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (conversion_event_id, entry_type)
);

CREATE TABLE "affiliate_settlement_lines" (
  adjustment_id_history TEXT,
  entry_id_history TEXT,
  affiliate_id_history TEXT,
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES affiliate_settlements(id),
  affiliate_id TEXT REFERENCES affiliates(id) ON DELETE SET NULL,
  entry_id TEXT REFERENCES affiliate_reward_entries(id) ON DELETE SET NULL,
  adjustment_id TEXT REFERENCES affiliate_adjustments(id) ON DELETE SET NULL,
  amount_minor INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'included' CHECK (status IN ('included', 'withheld')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((COALESCE(entry_id, entry_id_history) IS NOT NULL AND COALESCE(adjustment_id, adjustment_id_history) IS NULL) OR (COALESCE(entry_id, entry_id_history) IS NULL AND COALESCE(adjustment_id, adjustment_id_history) IS NOT NULL))
);

CREATE TABLE "affiliate_settlements" (
  affiliate_id_history TEXT,
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenants(id),
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  affiliate_id TEXT REFERENCES affiliates(id) ON DELETE SET NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  currency TEXT NOT NULL DEFAULT 'JPY' CHECK (currency = 'JPY'),
  total_amount_minor INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('preview', 'closed', 'exported', 'paid', 'partial', 'failed')),
  closed_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL UNIQUE,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, request_fingerprint TEXT NOT NULL DEFAULT '');

CREATE TABLE "affiliate_statements" (
  affiliate_id_history TEXT,
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenants(id),
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  affiliate_id TEXT REFERENCES affiliates(id) ON DELETE SET NULL,
  settlement_id TEXT NOT NULL REFERENCES affiliate_settlements(id),
  total_amount_minor INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('generated', 'expired', 'revoked')),
  version INTEGER NOT NULL DEFAULT 1,
  pdf_object_key TEXT NOT NULL,
  generated_by TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, idempotency_key TEXT, request_fingerprint TEXT, snapshot_json TEXT NOT NULL DEFAULT '{}', file_checksum TEXT);

CREATE TABLE affiliates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  code            TEXT NOT NULL UNIQUE,
  commission_rate REAL NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  friend_id       TEXT REFERENCES friends (id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, email TEXT, hold_days INTEGER, payout_cycle TEXT, notify_on_conversion INTEGER NOT NULL DEFAULT 0, tenant_id TEXT REFERENCES tenants(id), line_account_id TEXT REFERENCES line_accounts(id), lifecycle_status TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle_status IN ('active', 'paused', 'archived')), archived_at TEXT, operation_id TEXT, reward_mode TEXT CHECK (reward_mode IN ('none', 'fixed', 'rate')), folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL);

CREATE TABLE ai_answer_logs (
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES line_accounts(id),chat_id TEXT,friend_id TEXT,
 question_text TEXT NOT NULL DEFAULT '',action TEXT NOT NULL CHECK(action IN('answered','handed_off','customer_asked_human')),
 handoff_reason TEXT,qa_entry_id TEXT,qa_version INTEGER,answer_snapshot_json TEXT,after_note TEXT,created_at TEXT NOT NULL
);

CREATE TABLE ai_loop_slack_reports (
  work_key        TEXT PRIMARY KEY,
  slack_ts        TEXT,
  revision        INTEGER NOT NULL,
  claim_token     TEXT,
  claim_expires_at INTEGER,
  updated_at      INTEGER NOT NULL,
  CHECK (revision >= 946684800000),
  CHECK ((claim_token IS NULL AND claim_expires_at IS NULL)
      OR (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL))
);

CREATE TABLE ai_request_claims(chat_id TEXT NOT NULL REFERENCES chats(id),kind TEXT NOT NULL,claim_id TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(chat_id,kind));

CREATE TABLE ai_settings(account_id TEXT PRIMARY KEY REFERENCES line_accounts(id),mode TEXT NOT NULL DEFAULT 'off' CHECK(mode IN('off','draft_only','auto_qa','suspended')),confidence_threshold REAL NOT NULL DEFAULT 0.8,handoff_message TEXT,handoff_message_enabled INTEGER NOT NULL DEFAULT 1,monthly_limit_drafts INTEGER NOT NULL DEFAULT 3000,monthly_limit_answers INTEGER NOT NULL DEFAULT 3000,updated_by TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);

CREATE TABLE ai_usage_counters(account_id TEXT NOT NULL REFERENCES line_accounts(id),month TEXT NOT NULL,calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0),PRIMARY KEY(account_id,month));

CREATE TABLE analytics_cross_run_members (
  run_id           TEXT NOT NULL REFERENCES analytics_cross_runs(id) ON DELETE CASCADE,
  line_account_id  TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  row_key          TEXT NOT NULL,
  col_key          TEXT NOT NULL,
  friend_id        TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  PRIMARY KEY (run_id, lease_generation, row_key, col_key, friend_id)
);

CREATE TABLE analytics_cross_runs (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  query_json        TEXT NOT NULL CHECK (json_valid(query_json)),
  state             TEXT NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending','running','available','partial','unavailable','failed')),
  result_json       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result_json)),
  error_code        TEXT,
  period_from       TEXT NOT NULL,
  period_to         TEXT NOT NULL,
  time_zone         TEXT NOT NULL,
  data_cutoff_at    TEXT NOT NULL,
  created_by        TEXT,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  completed_at      TEXT
, lease_generation INTEGER NOT NULL DEFAULT 0, result_generation INTEGER);

CREATE TABLE analytics_daily_metrics (
  line_account_id  TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  metric_date      TEXT NOT NULL,
  metric_key       TEXT NOT NULL,
  dimension_key    TEXT NOT NULL DEFAULT '',
  dimension_value  TEXT NOT NULL DEFAULT '',
  numerator        INTEGER,
  denominator      INTEGER,
  value            REAL,
  state            TEXT NOT NULL DEFAULT 'available'
                     CHECK (state IN (
                       'available', 'pending', 'unavailable',
                       'insufficient', 'partial', 'failed'
                     )),
  data_cutoff_at   TEXT NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (
    line_account_id, metric_date, metric_key, dimension_key, dimension_value
  )
);

CREATE TABLE analytics_event_coverage (
  line_account_id  TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  event_type       TEXT NOT NULL,
  available_from   TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('available', 'partial', 'unavailable', 'failed')),
  reason           TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (line_account_id, event_type)
);

CREATE TABLE analytics_events (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_id         TEXT REFERENCES friends(id) ON DELETE SET NULL,
  visitor_key       TEXT,
  event_type        TEXT NOT NULL,
  source_kind       TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  occurred_at       TEXT NOT NULL,
  dimensions_json  TEXT NOT NULL DEFAULT '{}'
                       CHECK (json_valid(dimensions_json)),
  numeric_value     REAL,
  currency          TEXT,
  idempotency_key   TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (line_account_id, idempotency_key)
);

CREATE TABLE analytics_export_jobs (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  target TEXT NOT NULL
    CHECK (target IN ('reactions', 'url-clicks', 'cross', 'funnel', 'saved')),
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'expired')),
  row_count INTEGER CHECK (row_count IS NULL OR row_count >= 0),
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  csv_text TEXT,
  created_by TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  expires_at TEXT NOT NULL,
  failure_reason TEXT
);

CREATE TABLE analytics_funnel_run_members (
  run_id               TEXT NOT NULL REFERENCES analytics_funnel_runs(id) ON DELETE CASCADE,
  line_account_id      TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_id            TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  group_key            TEXT NOT NULL DEFAULT 'all',
  highest_step_order   INTEGER NOT NULL,
  state                TEXT NOT NULL CHECK (state IN ('completed', 'in_progress', 'dropped')),
  started_at           TEXT NOT NULL,
  last_reached_at      TEXT NOT NULL,
  deadline_at          TEXT NOT NULL,
  PRIMARY KEY (run_id, friend_id, group_key)
);

CREATE TABLE analytics_funnel_runs (
  id                  TEXT PRIMARY KEY,
  line_account_id     TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  funnel_id           TEXT NOT NULL REFERENCES funnels(id) ON DELETE RESTRICT,
  funnel_version_id   TEXT REFERENCES analytics_funnel_versions(id) ON DELETE RESTRICT,
  cohort_from         TEXT NOT NULL,
  cohort_to           TEXT NOT NULL,
  time_zone           TEXT NOT NULL,
  data_cutoff_at      TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN (
                        'pending', 'available', 'unavailable', 'partial', 'failed'
                      )),
  result_json         TEXT NOT NULL CHECK (json_valid(result_json)),
  created_by          TEXT,
  created_at          TEXT NOT NULL
);

CREATE TABLE analytics_funnel_versions (
  id                     TEXT PRIMARY KEY,
  funnel_id              TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  line_account_id        TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  version_number         INTEGER NOT NULL CHECK (version_number >= 1),
  window_days            INTEGER NOT NULL CHECK (window_days BETWEEN 1 AND 365),
  steps_json             TEXT NOT NULL CHECK (json_valid(steps_json)),
  segment_json           TEXT CHECK (segment_json IS NULL OR json_valid(segment_json)),
  comparison_groups_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(comparison_groups_json)),
  created_by             TEXT,
  created_at             TEXT NOT NULL,
  UNIQUE (funnel_id, version_number)
);

CREATE TABLE analytics_projection_friend_stage (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  cycle_id        TEXT NOT NULL,
  metric_date     TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  friend_id       TEXT NOT NULL,
  PRIMARY KEY (line_account_id, cycle_id, metric_date, event_type, friend_id)
);

CREATE TABLE analytics_projection_metric_stage (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  cycle_id        TEXT NOT NULL,
  metric_date     TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  event_count     INTEGER NOT NULL,
  unique_friend_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (line_account_id, cycle_id, metric_date, event_type)
);

CREATE TABLE analytics_projection_progress (
  line_account_id   TEXT PRIMARY KEY REFERENCES line_accounts(id) ON DELETE CASCADE,
  cycle_id          TEXT NOT NULL,
  range_from        TEXT NOT NULL,
  range_to          TEXT NOT NULL,
  time_zone         TEXT NOT NULL,
  data_cutoff_at    TEXT NOT NULL,
  broad_from        TEXT NOT NULL,
  broad_to          TEXT NOT NULL,
  last_occurred_at  TEXT NOT NULL DEFAULT '',
  last_event_id     TEXT NOT NULL DEFAULT '',
  source_event_count INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL
, phase TEXT NOT NULL DEFAULT 'scan');

CREATE TABLE analytics_projection_scheduler_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  last_account_id TEXT NOT NULL DEFAULT '',
  updated_at      TEXT NOT NULL
);

CREATE TABLE analytics_reconciliation_runs (
  id                 TEXT PRIMARY KEY,
  line_account_id    TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  range_from         TEXT NOT NULL,
  range_to           TEXT NOT NULL,
  source_event_count INTEGER NOT NULL DEFAULT 0,
  projected_count    INTEGER NOT NULL DEFAULT 0,
  mismatch_count     INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL CHECK (status IN ('matched', 'mismatched', 'failed')),
  error_code         TEXT,
  started_at         TEXT NOT NULL,
  completed_at       TEXT NOT NULL,
  UNIQUE (line_account_id, range_to)
);

CREATE TABLE analytics_report_runs (
  id                         TEXT PRIMARY KEY,
  schedule_id                TEXT NOT NULL REFERENCES analytics_report_schedules(id) ON DELETE CASCADE,
  line_account_id            TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  scheduled_for              TEXT NOT NULL,
  period_from                TEXT NOT NULL,
  period_to                  TEXT NOT NULL,
  time_zone                  TEXT NOT NULL,
  data_cutoff_at             TEXT NOT NULL,
  state                      TEXT NOT NULL CHECK (state IN ('running','available','partial','unavailable','failed')),
  result_json                TEXT NOT NULL CHECK (json_valid(result_json)),
  delivery_results_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(delivery_results_json)),
  error_code                 TEXT,
  started_at                 TEXT NOT NULL,
  completed_at               TEXT,
  UNIQUE (schedule_id, scheduled_for)
);

CREATE TABLE analytics_report_schedules (
  id                         TEXT PRIMARY KEY,
  line_account_id            TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name                       TEXT NOT NULL,
  sections_json              TEXT NOT NULL CHECK (json_valid(sections_json)),
  saved_analysis_ids_json    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(saved_analysis_ids_json)),
  cadence                    TEXT NOT NULL CHECK (cadence IN ('weekly','monthly')),
  weekday                    INTEGER CHECK (weekday BETWEEN 0 AND 6),
  month_day                  INTEGER CHECK (month_day BETWEEN 1 AND 28),
  send_time                  TEXT NOT NULL CHECK (send_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  time_zone                  TEXT NOT NULL,
  period_days                INTEGER NOT NULL CHECK (period_days BETWEEN 1 AND 397),
  recipients_json            TEXT NOT NULL CHECK (json_valid(recipients_json)),
  channels_json              TEXT NOT NULL CHECK (json_valid(channels_json)),
  alert_rules_json           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alert_rules_json)),
  status                     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  is_one_time                INTEGER NOT NULL DEFAULT 0 CHECK (is_one_time IN (0,1)),
  next_run_at                TEXT NOT NULL,
  created_by                 TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  CHECK ((cadence = 'weekly' AND weekday IS NOT NULL AND month_day IS NULL)
      OR (cadence = 'monthly' AND month_day IS NOT NULL AND weekday IS NULL))
);

CREATE TABLE "analytics_result_audience_members" (
 audience_id TEXT NOT NULL REFERENCES "analytics_result_audiences"(id) ON DELETE CASCADE,
 friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
 PRIMARY KEY(audience_id,friend_id)
);

CREATE TABLE "analytics_result_audiences" (
 id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
 source_kind TEXT NOT NULL CHECK(source_kind IN('funnel','cross','booking')),
 source_result_id TEXT NOT NULL, selection_key TEXT NOT NULL, member_count INTEGER NOT NULL DEFAULT 0,
 expires_at TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL
);

CREATE TABLE analytics_saved_analyses (
  id                     TEXT PRIMARY KEY,
  line_account_id        TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  kind                   TEXT NOT NULL CHECK (kind IN ('cross','funnel')),
  current_version_number INTEGER NOT NULL DEFAULT 1 CHECK (current_version_number >= 1),
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by             TEXT,
  created_by_name        TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE analytics_saved_analysis_snapshots (
  id                    TEXT PRIMARY KEY,
  saved_analysis_id     TEXT NOT NULL REFERENCES analytics_saved_analyses(id) ON DELETE CASCADE,
  analysis_version_id   TEXT NOT NULL REFERENCES analytics_saved_analysis_versions(id) ON DELETE RESTRICT,
  line_account_id       TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  source_kind           TEXT NOT NULL CHECK (source_kind IN ('cross','funnel')),
  source_result_id      TEXT NOT NULL,
  period_from           TEXT NOT NULL,
  period_to             TEXT NOT NULL,
  time_zone             TEXT NOT NULL,
  data_cutoff_at        TEXT NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN ('available','partial','unavailable','failed')),
  result_json           TEXT NOT NULL CHECK (json_valid(result_json)),
  created_by            TEXT,
  created_at            TEXT NOT NULL
);

CREATE TABLE analytics_saved_analysis_versions (
  id                  TEXT PRIMARY KEY,
  saved_analysis_id   TEXT NOT NULL REFERENCES analytics_saved_analyses(id) ON DELETE CASCADE,
  line_account_id     TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  version_number      INTEGER NOT NULL CHECK (version_number >= 1),
  definition_json     TEXT NOT NULL CHECK (json_valid(definition_json)),
  created_by          TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (saved_analysis_id, version_number)
);

CREATE TABLE analytics_url_exposure_queue (
  message_id            TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','processing','processed','failed')),
  attempts              INTEGER NOT NULL DEFAULT 0,
  available_at          TEXT NOT NULL,
  processing_started_at TEXT,
  processed_at          TEXT,
  last_error            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE analytics_url_exposures (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL,
  friend_id       TEXT REFERENCES friends(id) ON DELETE SET NULL,
  tracked_link_id TEXT NOT NULL,
  source_kind     TEXT NOT NULL,
  source_id       TEXT,
  audience_state  TEXT NOT NULL DEFAULT 'known'
                  CHECK (audience_state IN ('known','unknown')),
  sent_at         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (line_account_id, message_id, tracked_link_id)
);

CREATE TABLE audit_events (
  id                 TEXT PRIMARY KEY,
  source_kind        TEXT,
  source_id          TEXT,
  tenant_id          TEXT NOT NULL,
  line_account_id    TEXT,
  category           TEXT NOT NULL CHECK (category IN ('auth', 'business')),
  actor_principal_id TEXT,
  actor_role         TEXT,
  action             TEXT NOT NULL,
  target_kind        TEXT,
  target_id          TEXT,
  result             TEXT NOT NULL CHECK (result IN ('success', 'denied', 'failed')),
  before_json        TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json         TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  reason             TEXT,
  request_trace_id   TEXT,
  ip_prefix          TEXT,
  device_family      TEXT,
  risk_level         TEXT NOT NULL DEFAULT 'normal'
                     CHECK (risk_level IN ('normal', 'suspicious', 'high')),
  retention_class    TEXT NOT NULL DEFAULT 'general'
                     CHECK (retention_class IN ('general', 'security', 'personal_data')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), security_created_at_jd REAL,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE SET NULL,
  UNIQUE (source_kind, source_id)
);

CREATE TABLE auth_email_tokens (
  id             TEXT PRIMARY KEY,
  purpose        TEXT NOT NULL CHECK (purpose IN ('signup', 'password_reset')),
  token_hash     TEXT NOT NULL UNIQUE,
  email          TEXT NOT NULL,
  staff_id       TEXT,
  ip_hash        TEXT,
  device_marker  TEXT,
  expires_at     TEXT NOT NULL,
  consumed_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, application_id TEXT);

CREATE TABLE auth_known_devices (
  staff_id TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (staff_id, device_hash)
);

CREATE TABLE auth_step_up_attempts (
  staff_id          TEXT PRIMARY KEY,
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_started_at TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  FOREIGN KEY (staff_id) REFERENCES staff_members(id) ON DELETE CASCADE
);

CREATE TABLE auth_step_up_grants (
  token_hash  TEXT PRIMARY KEY,
  staff_id    TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  created_at  TEXT NOT NULL
, session_token_hash TEXT, issued_policy_version INTEGER);

CREATE TABLE auth_throttles (
  key           TEXT PRIMARY KEY,
  count         INTEGER NOT NULL DEFAULT 0,
  window_start  TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE auto_replies (
  id               TEXT PRIMARY KEY,
  keyword          TEXT NOT NULL,
  match_type       TEXT NOT NULL CHECK (match_type IN ('exact', 'contains')) DEFAULT 'exact',
  response_type    TEXT NOT NULL DEFAULT 'text',
  response_content TEXT NOT NULL,
  template_id      TEXT REFERENCES templates(id) ON DELETE SET NULL,
  line_account_id  TEXT DEFAULT NULL,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  -- 151: 応答したときに順に実行することの並び（シナリオのアクションと同じ形）。
  actions_json           TEXT,
  -- 151: 応答する曜日（0=日 … 6=土）。時間帯は active_from / active_until が持つ。
  response_weekdays_json TEXT,
  -- 151: 'ignore' | 'include' | 'exclude'
  response_holiday_rule  TEXT,
  -- 151: 1人につき1回だけ応答する。cooldown_minutes（N分空ける）とは別。
  once_per_friend        INTEGER NOT NULL DEFAULT 0,
  -- 151: キーワードを複数行持つ。未設定なら keyword / match_type を見る。
  keywords_json          TEXT,
  -- 157: キーワードを問わず、届いたメッセージすべてに応答する（営業時間外の案内など）。
  respond_to_all         INTEGER NOT NULL DEFAULT 0,
  -- 158: 管理用の名前。空なら keyword を代わりに出す。
  name                   TEXT,
  -- 158: キーワードが複数あるとき 'any'（どれか1つ）か 'all'（すべて）か。
  keyword_match_mode     TEXT NOT NULL DEFAULT 'any'
, active_from TEXT, active_until TEXT, cooldown_minutes INTEGER, skip_when_operator_active INTEGER NOT NULL DEFAULT 0, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL, display_order INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0, message_kinds_json TEXT
  CHECK (message_kinds_json IS NULL OR json_valid(message_kinds_json)), friend_conditions_json TEXT
  CHECK (friend_conditions_json IS NULL OR json_valid(friend_conditions_json)), lifecycle_status TEXT NOT NULL DEFAULT 'published'
  CHECK (lifecycle_status IN ('draft', 'published', 'stopped')), current_draft_version_id TEXT, current_published_version_id TEXT, created_from_recipe_id TEXT REFERENCES recipes(id), recipe_clone_run_id TEXT REFERENCES recipe_clone_runs(id), stopped_at TEXT, stopped_by_staff_id TEXT, stop_reason TEXT, stop_idempotency_key TEXT, deleted_at TEXT, deleted_by_staff_id TEXT);

CREATE TABLE auto_reply_action_runs (
  id                  TEXT PRIMARY KEY,
  evaluation_id       TEXT NOT NULL,
  action_stable_id    TEXT NOT NULL,
  action_version      INTEGER NOT NULL DEFAULT 1,
  action_type         TEXT NOT NULL,
  action_snapshot     TEXT NOT NULL CHECK (json_valid(action_snapshot)),
  idempotency_key     TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'claimed', 'succeeded', 'skipped',
      'retry_wait', 'permanent_failed', 'cancelled'
    )),
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  last_error_code     TEXT,
  result_json         TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  started_at          TEXT,
  completed_at        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (evaluation_id, action_stable_id)
);

CREATE TABLE auto_reply_create_requests (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT REFERENCES line_accounts(id),
  operation         TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  auto_reply_id     TEXT NOT NULL REFERENCES auto_replies(id) ON DELETE CASCADE,
  version_id        TEXT REFERENCES auto_reply_versions(id) ON DELETE SET NULL,
  response_json     TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at        TEXT NOT NULL,
  UNIQUE(idempotency_key)
);

CREATE TABLE auto_reply_deliveries (
  id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL UNIQUE REFERENCES auto_reply_evaluations(id),
  friend_id TEXT NOT NULL REFERENCES friends(id),
  line_account_id TEXT REFERENCES line_accounts(id),
  version_id TEXT NOT NULL REFERENCES auto_reply_versions(id),
  message_json TEXT NOT NULL,
  action_summary TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','accepted','failed','skipped')),
  completed_at TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE auto_reply_evaluation_details (
  id                 TEXT PRIMARY KEY,
  evaluation_id      TEXT NOT NULL,
  auto_reply_id      TEXT NOT NULL,
  rule_version_id    TEXT,
  evaluation_order   INTEGER NOT NULL,
  result             TEXT NOT NULL CHECK (result IN ('not_matched', 'skipped', 'won')),
  reason_codes_json  TEXT NOT NULL CHECK (json_valid(reason_codes_json)),
  created_at         TEXT NOT NULL,
  UNIQUE (evaluation_id, auto_reply_id)
);

CREATE TABLE auto_reply_evaluations (
  id                       TEXT PRIMARY KEY,
  incoming_event_id        TEXT NOT NULL UNIQUE,
  incoming_message_log_id  TEXT,
  line_account_id          TEXT,
  friend_id                TEXT NOT NULL,
  message_kind             TEXT NOT NULL,
  normalized_text_hash     TEXT NOT NULL,
  input_preview_masked     TEXT,
  evaluated_at             TEXT NOT NULL,
  completed_at             TEXT,
  winning_auto_reply_id    TEXT,
  winning_version_id       TEXT,
  status                   TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN (
      'received', 'evaluated', 'matched', 'skipped', 'reply_accepted',
      'reply_failed', 'actions_running', 'completed', 'partial_failed', 'failed'
    )),
  skip_reason              TEXT,
  matched_keyword          TEXT,
  reply_status             TEXT NOT NULL DEFAULT 'not_attempted'
    CHECK (reply_status IN ('not_attempted', 'accepted', 'failed')),
  line_request_id          TEXT,
  message_log_id           TEXT,
  action_summary           TEXT CHECK (action_summary IS NULL OR json_valid(action_summary)),
  error_code               TEXT,
  duration_ms              INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE TABLE auto_reply_hits (
  id              TEXT PRIMARY KEY,
  auto_reply_id   TEXT NOT NULL,
  friend_id       TEXT,
  line_account_id TEXT,
  matched_keyword TEXT,
  hit_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE auto_reply_unmatched_settings (
 line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id) ON DELETE CASCADE,
 message TEXT CHECK(message IS NULL OR length(message) BETWEEN 1 AND 5000),
 version INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE auto_reply_versions (
  id                    TEXT PRIMARY KEY,
  auto_reply_id         TEXT NOT NULL,
  version_number        INTEGER NOT NULL,
  line_account_id       TEXT,
  definition_snapshot   TEXT NOT NULL CHECK (json_valid(definition_snapshot)),
  status                TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN ('draft', 'published', 'retired')),
  published_at          TEXT,
  published_by_staff_id TEXT,
  created_at            TEXT NOT NULL, last_test_status TEXT
  CHECK (last_test_status IN ('succeeded', 'failed')), last_tested_at TEXT, last_tested_by_staff_id TEXT, publish_idempotency_key TEXT, updated_at TEXT,
  UNIQUE (auto_reply_id, version_number)
);

CREATE TABLE automation_definitions (
  id                           TEXT PRIMARY KEY,
  line_account_id              TEXT NOT NULL REFERENCES line_accounts(id),
  name                         TEXT NOT NULL,
  description                  TEXT,
  status                       TEXT NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft', 'active', 'stopped', 'archived')),
  priority                     INTEGER NOT NULL DEFAULT 0,
  current_draft_version_id     TEXT REFERENCES automation_versions(id)
                                 DEFERRABLE INITIALLY DEFERRED,
  current_published_version_id TEXT REFERENCES automation_versions(id)
                                 DEFERRABLE INITIALLY DEFERRED,
  legacy_automation_id         TEXT UNIQUE,
  created_by                   TEXT,
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at                  TEXT
, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL);

CREATE TABLE automation_logs (
  id             TEXT PRIMARY KEY,
  automation_id  TEXT NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  friend_id      TEXT REFERENCES friends (id) ON DELETE SET NULL,
  event_data     TEXT,
  actions_result TEXT,
  status         TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'partial', 'failed')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE automation_run_daily_counts (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  automation_id   TEXT NOT NULL,
  day             TEXT NOT NULL,
  status          TEXT NOT NULL,
  run_count       INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  step_count      INTEGER NOT NULL DEFAULT 0 CHECK (step_count >= 0),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (line_account_id, automation_id, day, status)
);

CREATE TABLE automation_run_steps (
  id                       TEXT PRIMARY KEY,
  automation_run_id        TEXT NOT NULL REFERENCES automation_runs(id),
  step_key                 TEXT NOT NULL,
  action_type              TEXT NOT NULL,
  common_action_version_id TEXT REFERENCES common_action_versions(id),
  attempt_number           INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number > 0),
  idempotency_key          TEXT NOT NULL UNIQUE,
  status                   TEXT NOT NULL DEFAULT 'queued'
                             CHECK (status IN (
                               'queued', 'running', 'waiting', 'success',
                               'failed', 'skipped', 'cancelled'
                             )),
  input_json               TEXT NOT NULL DEFAULT '{}',
  output_json              TEXT,
  error_code               TEXT,
  error_message            TEXT,
  retry_at                 TEXT,
  started_at               TEXT,
  completed_at             TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')), lease_expires_at TEXT,
  UNIQUE (automation_run_id, step_key, attempt_number)
);

CREATE TABLE automation_runs (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL REFERENCES line_accounts(id),
  automation_id         TEXT NOT NULL REFERENCES automation_definitions(id),
  automation_version_id TEXT NOT NULL REFERENCES automation_versions(id),
  friend_id             TEXT REFERENCES friends(id) ON DELETE SET NULL,
  source_event_id       TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN (
                            'queued', 'running', 'waiting', 'success', 'partial',
                            'failed', 'cancelled', 'skipped_condition'
                          )),
  current_step          INTEGER NOT NULL DEFAULT 0 CHECK (current_step >= 0),
  resume_at             TEXT,
  input_event_json      TEXT NOT NULL DEFAULT '{}',
  is_test               INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  started_at            TEXT,
  completed_at          TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')), lease_expires_at TEXT, execution_plan_json TEXT,
  UNIQUE (line_account_id, automation_id, idempotency_key)
);

CREATE TABLE automation_versions (
  id                TEXT PRIMARY KEY,
  automation_id     TEXT NOT NULL REFERENCES automation_definitions(id),
  version_number    INTEGER NOT NULL CHECK (version_number > 0),
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'published')),
  trigger_type      TEXT NOT NULL,
  trigger_config    TEXT NOT NULL DEFAULT '{}',
  condition_config  TEXT NOT NULL DEFAULT '{}',
  action_config     TEXT NOT NULL DEFAULT '[]',
  created_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  published_at      TEXT,
  UNIQUE (automation_id, version_number)
);

CREATE TABLE automations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  event_type  TEXT NOT NULL,
  conditions  TEXT NOT NULL DEFAULT '{}',
  actions     TEXT NOT NULL DEFAULT '[]',
  is_active   INTEGER NOT NULL DEFAULT 1,
  priority    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT);

CREATE TABLE banner_generations (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  project_id       TEXT NOT NULL REFERENCES banner_projects(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'done', 'failed', 'canceled')),
  mode             TEXT NOT NULL CHECK (mode IN ('banner', 'free')),
  preset_key       TEXT NOT NULL,
  aspect_ratio     TEXT NOT NULL,
  api_size         TEXT NOT NULL,
  quality          TEXT NOT NULL CHECK (quality IN ('low', 'medium', 'high')),
  text_lines       TEXT NOT NULL DEFAULT '[]',
  main_color       TEXT,
  sub_color        TEXT,
  person_option    TEXT NOT NULL DEFAULT 'without' CHECK (person_option IN ('with', 'without')),
  custom_prompt    TEXT NOT NULL DEFAULT '',
  free_prompt      TEXT NOT NULL DEFAULT '',
  final_prompt     TEXT NOT NULL,
  engine           TEXT NOT NULL DEFAULT 'openai',
  model_name       TEXT,
  requested_count  INTEGER NOT NULL DEFAULT 1,
  done_count       INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  units_per_image  INTEGER NOT NULL DEFAULT 1,
  error_message    TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  started_at       TEXT,
  finished_at      TEXT
, reference_image_id TEXT REFERENCES banner_images(id), reference_mode TEXT
  CHECK (reference_mode IS NULL OR reference_mode IN ('edit', 'inspire')), base_color TEXT, accent_color TEXT, reference_images TEXT, emphasis_lines TEXT, crop_gravity TEXT NOT NULL DEFAULT 'center'
  CHECK (crop_gravity IN ('center','top','bottom')), stop_requested_at TEXT, ai_account_id TEXT REFERENCES line_accounts(id));

CREATE TABLE banner_image_deliveries (
  id               TEXT PRIMARY KEY,
  banner_image_id  TEXT NOT NULL REFERENCES banner_images(id) ON DELETE CASCADE,
  line_account_id  TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  media_id         TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  delivered_by     TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (banner_image_id, line_account_id)
);

CREATE TABLE banner_images (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  project_id       TEXT NOT NULL REFERENCES banner_projects(id) ON DELETE CASCADE,
  generation_id    TEXT REFERENCES banner_generations(id) ON DELETE SET NULL,
  media_id         TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  sequence         INTEGER NOT NULL DEFAULT 1,
  source           TEXT NOT NULL DEFAULT 'generated'
                     CHECK (source IN ('generated', 'upload', 'edited')),
  parent_image_id  TEXT,
  is_favorite      INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, folder_id TEXT REFERENCES hq_banner_folders(id) ON DELETE SET NULL);

CREATE TABLE banner_projects (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  is_favorite  INTEGER NOT NULL DEFAULT 0,
  archived_at  TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, folder_id TEXT REFERENCES hq_banner_folders(id) ON DELETE SET NULL);

CREATE TABLE banner_usage_ledger (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  generation_id  TEXT,
  units          INTEGER NOT NULL,
  reason         TEXT NOT NULL CHECK (reason IN ('generate', 'refund', 'edit')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE billing_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  tenant_id    TEXT,
  summary      TEXT NOT NULL DEFAULT '',
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE billing_invoices (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  stripe_customer_id  TEXT,
  subscription_id     TEXT,
  status              TEXT,
  amount_paid         INTEGER NOT NULL DEFAULT 0,
  amount_due          INTEGER NOT NULL DEFAULT 0,
  amount_refunded     INTEGER NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'jpy',
  interval            TEXT CHECK (interval IN ('month', 'year')),
  period_start        TEXT,
  period_end          TEXT,
  paid_at             TEXT,
  hosted_invoice_url  TEXT,
  raw_updated_at      TEXT,
  synced_at           TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE TABLE booking_addons(booking_id TEXT NOT NULL REFERENCES bookings(id),addon_menu_id TEXT NOT NULL REFERENCES menus(id),duration_min INTEGER NOT NULL CHECK(duration_min>0),price_at_booking INTEGER NOT NULL CHECK(price_at_booking>=0),PRIMARY KEY(booking_id,addon_menu_id));

CREATE TABLE booking_assignment_settings (
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('staff','table')),
  scope_id TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'balanced' CHECK(method IN ('balanced','priority','random')),
  balance_period TEXT NOT NULL DEFAULT 'day' CHECK(balance_period IN ('day','week')),
  resources_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(resources_json) AND json_type(resources_json)='array'),
  version INTEGER NOT NULL CHECK(version>0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(scope_kind,scope_id)
);

CREATE TABLE "booking_audit_logs" (
  booking_id_history TEXT,
  id              TEXT PRIMARY KEY,
  booking_id      TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  action          TEXT NOT NULL,
  before_json     TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json      TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  reason          TEXT,
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('customer', 'staff', 'system')),
  actor_id        TEXT,
  actor_name      TEXT,
  occurred_at     TEXT NOT NULL,   -- UTC ISO8601。Worker が書く
  request_id      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE booking_availability_exceptions (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('store', 'staff', 'resource')),
  scope_id TEXT,
  date_from TEXT NOT NULL CHECK (date_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  date_to TEXT NOT NULL CHECK (date_to GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  kind TEXT NOT NULL CHECK (kind IN ('closed', 'custom_hours', 'open')),
  hours_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  CHECK (date_from <= date_to),
  CHECK ((scope_kind = 'store' AND scope_id IS NULL) OR (scope_kind != 'store' AND length(trim(scope_id)) > 0)),
  CHECK ((kind = 'closed' AND hours_json = '[]') OR kind != 'closed')
);

CREATE TABLE booking_batch_assertions(id TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1));

CREATE TABLE booking_business_hours (
  id TEXT PRIMARY KEY,
  booking_settings_id TEXT NOT NULL REFERENCES booking_settings(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL CHECK (
    start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND substr(start_time, 1, 2) <= '23'
  ),
  end_time TEXT NOT NULL CHECK (
    end_time GLOB '[0-2][0-9]:[0-5][0-9]' AND substr(end_time, 1, 2) <= '23'
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), capacity INTEGER NOT NULL DEFAULT 1
  CHECK (capacity BETWEEN 1 AND 1000),
  CHECK (start_time < end_time),
  UNIQUE (booking_settings_id, weekday, start_time, end_time)
);

CREATE TABLE booking_calendar_busy_cache (
 line_account_id TEXT NOT NULL,staff_id TEXT NOT NULL,connection_id TEXT NOT NULL,calendar_id TEXT NOT NULL,
 time_min TEXT NOT NULL,time_max TEXT NOT NULL,busy_json TEXT NOT NULL CHECK(json_valid(busy_json)),last_read_at TEXT NOT NULL,
 PRIMARY KEY(line_account_id,staff_id)
);

CREATE TABLE booking_calendar_read_health (
 line_account_id TEXT NOT NULL,staff_id TEXT NOT NULL,last_success_at TEXT,failed_since TEXT,error_code TEXT,
 PRIMARY KEY(line_account_id,staff_id)
);

CREATE TABLE booking_calendar_switch_audit (
 id TEXT PRIMARY KEY,line_account_id TEXT NOT NULL,scope_id TEXT NOT NULL,actor_id TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at TEXT NOT NULL
);

CREATE TABLE booking_calendar_switch_jobs (
 id TEXT PRIMARY KEY,line_account_id TEXT NOT NULL,staff_id TEXT NOT NULL,booking_id TEXT NOT NULL REFERENCES bookings(id),
 action TEXT NOT NULL CHECK(action IN('delete','write')),external_event_id TEXT,calendar_id TEXT,
 switch_scope TEXT NOT NULL,switch_version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','failed','done','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0,error_code TEXT,created_at TEXT NOT NULL,UNIQUE(booking_id,action,switch_scope,switch_version)
);

CREATE TABLE booking_calendar_switches (
 line_account_id TEXT NOT NULL REFERENCES line_accounts(id),scope_id TEXT NOT NULL DEFAULT '',
 read_enabled INTEGER NOT NULL DEFAULT 0 CHECK(read_enabled IN(0,1)),write_enabled INTEGER NOT NULL DEFAULT 0 CHECK(write_enabled IN(0,1)),
 version INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL,mutation_token TEXT,PRIMARY KEY(line_account_id,scope_id)
);

CREATE TABLE booking_cancellation_events (
 id TEXT PRIMARY KEY,charge_id TEXT NOT NULL REFERENCES booking_charges(id),actor_id TEXT,action TEXT NOT NULL,reason TEXT,created_at TEXT NOT NULL
);

CREATE TABLE booking_cancellation_options (
 account_id TEXT PRIMARY KEY REFERENCES line_accounts(id),card_required_for TEXT NOT NULL DEFAULT 'all' CHECK(card_required_for IN('all','no_show_flagged','conditions')),
 charge_mode TEXT NOT NULL DEFAULT 'manual' CHECK(charge_mode IN('manual','auto')),version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE booking_cancellation_policies (
 line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id), enabled INTEGER NOT NULL DEFAULT 0,
 tiers_json TEXT NOT NULL CHECK(json_valid(tiers_json)), no_show_percent INTEGER NOT NULL CHECK(no_show_percent BETWEEN 0 AND 100),
 charge_mode TEXT NOT NULL DEFAULT 'manual' CHECK(charge_mode='manual'), version INTEGER NOT NULL DEFAULT 1,
 updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE booking_charges (
 -- 支払の証跡のIDは削除後も残す。顧客・予約・店へのFKで削除を妨げない。
 id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,line_account_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('cancellation_fee','no_show_fee')),amount INTEGER NOT NULL CHECK(amount>=0),
 policy_snapshot_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('pending','processing','succeeded','failed','unknown','waived','refunded')),
 reason TEXT,actor_staff_id TEXT,stripe_payment_intent_id TEXT,idempotency_key TEXT,version INTEGER NOT NULL DEFAULT 1,
 test_mode INTEGER NOT NULL DEFAULT 1 CHECK(test_mode=1),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(booking_id,kind),UNIQUE(line_account_id,idempotency_key)
);

CREATE TABLE booking_customers (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_id             TEXT REFERENCES friends(id) ON DELETE SET NULL,
  display_name          TEXT NOT NULL,
  phone_normalized_hash TEXT NOT NULL,
  phone_encrypted       TEXT NOT NULL,
  phone_last4           TEXT NOT NULL,
  email_encrypted       TEXT,
  pet_name              TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE booking_deposit_rules (
 account_id TEXT NOT NULL REFERENCES line_accounts(id),scope_id TEXT NOT NULL DEFAULT '',rule_json TEXT NOT NULL CHECK(json_valid(rule_json)),
 inherit INTEGER NOT NULL DEFAULT 0 CHECK(inherit IN(0,1)),version INTEGER NOT NULL DEFAULT 1,updated_by TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(account_id,scope_id)
);

CREATE TABLE booking_entitlement_events (
  id TEXT PRIMARY KEY,
  entitlement_id TEXT NOT NULL REFERENCES booking_entitlements(id) ON DELETE RESTRICT,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK(action IN ('grant','adjust','extend','revoke','consume')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('staff','system')),
  actor_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  before_json TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
  after_json TEXT NOT NULL CHECK(json_valid(after_json)),
  created_at TEXT NOT NULL,
  UNIQUE(line_account_id,request_key)
);

CREATE TABLE booking_entitlement_month_limits (
  entitlement_id TEXT NOT NULL REFERENCES booking_entitlements(id) ON DELETE RESTRICT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  allowance INTEGER NOT NULL CHECK(allowance>=0),
  PRIMARY KEY(entitlement_id,period_start)
);

CREATE TABLE booking_entitlement_notices (
 id TEXT PRIMARY KEY,line_account_id TEXT NOT NULL REFERENCES line_accounts(id),friend_id TEXT NOT NULL REFERENCES friends(id),
 entitlement_id TEXT NOT NULL REFERENCES booking_entitlements(id),plan_id TEXT NOT NULL REFERENCES booking_pass_plans(id),
 kind TEXT NOT NULL CHECK(kind IN('remaining_one','expiry_14_days')),dedupe_key TEXT NOT NULL,
 purpose TEXT NOT NULL DEFAULT 'transaction' CHECK(purpose='transaction'),messages_json TEXT NOT NULL CHECK(json_valid(messages_json)),
 scheduled_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN('scheduled','simulated','skipped_disabled','skipped_unavailable','skipped_opted_out','skipped_late')),
 processed_at TEXT,test_mode INTEGER NOT NULL DEFAULT 1 CHECK(test_mode=1),UNIQUE(entitlement_id,kind,dedupe_key)
);

CREATE TABLE booking_entitlement_uses (
  booking_id TEXT UNIQUE REFERENCES bookings(id) ON DELETE SET NULL,
  booking_id_history TEXT PRIMARY KEY NOT NULL,
  entitlement_id TEXT NOT NULL REFERENCES booking_entitlements(id) ON DELETE RESTRICT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL CHECK(julianday(period_end)>julianday(period_start)),
  consumed_at TEXT
, returned_at TEXT);

CREATE TABLE "booking_entitlements" (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES friends(id) ON DELETE SET NULL,
  menu_id TEXT REFERENCES menus(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('ticket','monthly')),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  remaining INTEGER CHECK(remaining IS NULL OR remaining>=0),
  monthly_limit INTEGER CHECK(monthly_limit IS NULL OR monthly_limit>0),
  valid_from TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(julianday(expires_at)>julianday(valid_from)),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, plan_id TEXT REFERENCES booking_pass_plans(id), source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN('manual','online')), billing_status TEXT NOT NULL DEFAULT 'ok' CHECK(billing_status IN('ok','grace','stopped')), stripe_subscription_id TEXT, grace_until TEXT,
  CHECK((kind='ticket' AND remaining IS NOT NULL AND monthly_limit IS NULL)
    OR (kind='monthly' AND remaining IS NULL))
);

CREATE TABLE booking_groups (
 id TEXT PRIMARY KEY,line_account_id TEXT NOT NULL REFERENCES line_accounts(id),friend_id TEXT NOT NULL REFERENCES friends(id),
 start_mode TEXT NOT NULL DEFAULT 'parallel' CHECK(start_mode IN('parallel','sequential')),version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_json TEXT NOT NULL,
 UNIQUE(line_account_id,friend_id,idempotency_key)
);

CREATE TABLE booking_idempotency_keys (
  key              TEXT PRIMARY KEY,
  line_account_id  TEXT NOT NULL,
  friend_id        TEXT NOT NULL,
  response_status  INTEGER NOT NULL,
  response_body    TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  expires_at       TEXT NOT NULL                  -- UTC ISO8601
);

CREATE TABLE booking_makeup_credits(
 id TEXT PRIMARY KEY,line_account_id TEXT NOT NULL REFERENCES line_accounts(id),friend_id TEXT NOT NULL REFERENCES friends(id),
 source_event_booking_id TEXT UNIQUE REFERENCES event_bookings(id),source_event_id TEXT NOT NULL REFERENCES events(id),entitlement_id TEXT REFERENCES booking_entitlements(id),
 expires_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','used','expired','revoked')),used_event_booking_id TEXT REFERENCES event_bookings(id),
 reason TEXT,granted_by TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,rule_snapshot_json TEXT NOT NULL CHECK(json_valid(rule_snapshot_json)),
 use_idempotency_key TEXT,use_request_json TEXT
);

CREATE TABLE "booking_menu_resources" (
  menu_id TEXT NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES booking_resources(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (menu_id, resource_id)
);

CREATE TABLE booking_monthly_active_slots (
 tenant_id TEXT NOT NULL, account_id TEXT NOT NULL, friend_id TEXT NOT NULL,
 class_kind TEXT NOT NULL, class_id TEXT NOT NULL, contract_id TEXT NOT NULL UNIQUE,
 PRIMARY KEY(tenant_id,account_id,friend_id,class_kind,class_id),
 FOREIGN KEY(contract_id,tenant_id,account_id,friend_id,class_kind,class_id)
 REFERENCES booking_monthly_contracts(id,tenant_id,account_id,friend_id,class_kind,class_id) ON DELETE RESTRICT
);

CREATE TABLE booking_monthly_attempts (
 cycle_id TEXT NOT NULL, tenant_id TEXT NOT NULL, account_id TEXT NOT NULL,
 attempt_no INTEGER NOT NULL CHECK(typeof(attempt_no)='integer' AND attempt_no BETWEEN 0 AND 3),
 scheduled_at TEXT NOT NULL CHECK(julianday(scheduled_at) IS NOT NULL),
 payment_method_id TEXT NOT NULL, payment_method_version INTEGER NOT NULL CHECK(payment_method_version>0),
 request_key TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','running','processing','unknown','succeeded','failed','canceled')),
 error_code TEXT, started_at TEXT, finished_at TEXT,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(cycle_id,attempt_no),
 FOREIGN KEY(cycle_id,tenant_id,account_id) REFERENCES booking_monthly_cycles(id,tenant_id,account_id) ON DELETE RESTRICT
);

CREATE TABLE booking_monthly_contracts (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL, account_id TEXT NOT NULL, friend_id TEXT NOT NULL,
 class_kind TEXT NOT NULL CHECK(class_kind IN('menu','event')), class_id TEXT NOT NULL,
 plan_id TEXT NOT NULL, plan_version INTEGER NOT NULL CHECK(plan_version>0), name TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount BETWEEN 50 AND 100000000),
 currency TEXT NOT NULL DEFAULT 'jpy' CHECK(currency='jpy'),
 monthly_limit INTEGER CHECK(monthly_limit IS NULL OR typeof(monthly_limit)='integer' AND monthly_limit>0),
 timezone TEXT NOT NULL, consent_version TEXT NOT NULL, consented_at TEXT NOT NULL CHECK(julianday(consented_at) IS NOT NULL),
 connected_account TEXT NOT NULL CHECK(connected_account GLOB 'acct_*'), connection_identity TEXT NOT NULL,
 customer_id TEXT, payment_method_id TEXT, payment_method_version INTEGER NOT NULL DEFAULT 0 CHECK(payment_method_version>=0),
 setup_session_id TEXT, setup_expires_at TEXT CHECK(setup_expires_at IS NULL OR julianday(setup_expires_at) IS NOT NULL),
 state TEXT NOT NULL DEFAULT 'applying' CHECK(state IN('applying','expired','active','stop_scheduled','stopped')),
 stop_reason TEXT CHECK(stop_reason IN('member_request','store_request','store_immediate','unpaid')),
 stop_effective_at TEXT CHECK(stop_effective_at IS NULL OR julianday(stop_effective_at) IS NOT NULL),
 service_state TEXT NOT NULL DEFAULT 'enabled' CHECK(service_state IN('enabled','review_hold')),
 service_reason TEXT,
 attention_episode_id TEXT, attention_started_at TEXT CHECK(attention_started_at IS NULL OR julianday(attention_started_at) IS NOT NULL),
 request_key TEXT NOT NULL, request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 test_mode INTEGER NOT NULL DEFAULT 1 CHECK(test_mode=1), version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL), updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL),
 UNIQUE(id,tenant_id,account_id), UNIQUE(id,tenant_id,account_id,friend_id,class_kind,class_id),
 UNIQUE(id,tenant_id,account_id,connected_account), UNIQUE(account_id,friend_id,request_key),
 FOREIGN KEY(account_id,tenant_id) REFERENCES line_accounts(id,tenant_id) ON DELETE RESTRICT,
 FOREIGN KEY(friend_id,account_id) REFERENCES friends(id,line_account_id) ON DELETE RESTRICT,
 FOREIGN KEY(plan_id,account_id) REFERENCES booking_pass_plans(id,line_account_id) ON DELETE RESTRICT,
 CHECK((attention_episode_id IS NULL)=(attention_started_at IS NULL)),
 CHECK(service_state!='review_hold' OR service_reason IS NOT NULL AND length(trim(service_reason))>0),
 CHECK(state NOT IN('stop_scheduled','stopped') OR stop_reason IS NOT NULL AND stop_effective_at IS NOT NULL)
);

CREATE TABLE booking_monthly_cycles (
 id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, tenant_id TEXT NOT NULL, account_id TEXT NOT NULL,
 connected_account TEXT NOT NULL,
 month_key TEXT NOT NULL CHECK(month_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(month_key,6,2) BETWEEN '01' AND '12'),
 kind TEXT NOT NULL CHECK(kind IN('initial','renewal')),
 due_at TEXT NOT NULL CHECK(julianday(due_at) IS NOT NULL),
 period_start TEXT NOT NULL CHECK(julianday(period_start) IS NOT NULL),
 service_start TEXT NOT NULL CHECK(julianday(service_start) IS NOT NULL),
 service_end TEXT NOT NULL CHECK(julianday(service_end) IS NOT NULL AND julianday(service_end)>julianday(service_start)),
 amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount BETWEEN 50 AND 100000000),
 currency TEXT NOT NULL DEFAULT 'jpy' CHECK(currency='jpy'),
 invoice_id TEXT, invoice_status TEXT CHECK(invoice_status IN('draft','open','paid','void','uncollectible')),
 auto_advance INTEGER CHECK(auto_advance=0),
 state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN('planned','preparing','open','retry_wait','requires_action','processing','unknown','paid','exhausted','blocked','void')),
 first_failed_at TEXT CHECK(first_failed_at IS NULL OR julianday(first_failed_at) IS NOT NULL),
 paid_at TEXT CHECK(paid_at IS NULL OR julianday(paid_at) IS NOT NULL),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), test_mode INTEGER NOT NULL DEFAULT 1 CHECK(test_mode=1),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(contract_id,month_key), UNIQUE(connected_account,invoice_id),
 UNIQUE(id,contract_id,tenant_id,account_id), UNIQUE(id,tenant_id,account_id),
 FOREIGN KEY(contract_id,tenant_id,account_id,connected_account)
 REFERENCES booking_monthly_contracts(id,tenant_id,account_id,connected_account) ON DELETE RESTRICT,
 CHECK(invoice_id IS NULL OR auto_advance IS 0),
 CHECK(julianday(period_start)<=julianday(service_start)),
 CHECK(state!='paid' OR invoice_status IS 'paid' AND invoice_id IS NOT NULL AND paid_at IS NOT NULL),
 CHECK(state!='void' OR invoice_status IS 'void' AND invoice_id IS NOT NULL)
);

CREATE TABLE booking_monthly_event_applications (
 source TEXT NOT NULL, connected_account TEXT NOT NULL, provider_event_id TEXT NOT NULL,
 receipt_id TEXT NOT NULL UNIQUE, payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
 contract_id TEXT NOT NULL, cycle_id TEXT, tenant_id TEXT NOT NULL, account_id TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN('setup_ready','paid','failed','processing','void','ignored')),
 applied_at TEXT NOT NULL,
 PRIMARY KEY(source,connected_account,provider_event_id),
 FOREIGN KEY(contract_id,tenant_id,account_id,connected_account)
 REFERENCES booking_monthly_contracts(id,tenant_id,account_id,connected_account) ON DELETE RESTRICT,
 FOREIGN KEY(cycle_id,contract_id,tenant_id,account_id)
 REFERENCES booking_monthly_cycles(id,contract_id,tenant_id,account_id) ON DELETE RESTRICT
);

CREATE TABLE booking_monthly_operations (
 id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, tenant_id TEXT NOT NULL, account_id TEXT NOT NULL,
 request_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('stop_next_month','stop_now','waive','payment_method','expire','restore')),
 actor_type TEXT NOT NULL CHECK(actor_type IN('friend','staff','system')), actor_id TEXT NOT NULL,
 expected_version INTEGER NOT NULL CHECK(expected_version>0), reason TEXT NOT NULL,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)), response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','unknown','succeeded','failed')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(account_id,request_key),
 FOREIGN KEY(contract_id,tenant_id,account_id) REFERENCES booking_monthly_contracts(id,tenant_id,account_id) ON DELETE RESTRICT
);

CREATE TABLE booking_monthly_rights (
 contract_id TEXT NOT NULL, cycle_id TEXT NOT NULL, tenant_id TEXT NOT NULL, account_id TEXT NOT NULL,
 month_key TEXT NOT NULL, entitlement_id TEXT NOT NULL UNIQUE REFERENCES booking_entitlements(id) ON DELETE RESTRICT,
 state TEXT NOT NULL CHECK(state IN('paid','provisional','revoked','review_hold')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), updated_at TEXT NOT NULL,
 PRIMARY KEY(contract_id,month_key), UNIQUE(cycle_id),
 FOREIGN KEY(cycle_id,contract_id,tenant_id,account_id)
 REFERENCES booking_monthly_cycles(id,contract_id,tenant_id,account_id) ON DELETE RESTRICT
);

CREATE TABLE booking_noshow_flag_events (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('manual_on', 'manual_off')),
  reason TEXT,
  staff_id TEXT,
  staff_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE booking_noshow_flags (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'manual_on', 'manual_off')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (line_account_id, friend_id)
);

CREATE TABLE booking_noshow_thresholds (
  line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id) ON DELETE CASCADE,
  threshold INTEGER NOT NULL DEFAULT 3 CHECK (threshold BETWEEN 1 AND 100),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)), window_months INTEGER NOT NULL DEFAULT 6 CHECK (window_months BETWEEN 1 AND 120), no_payment_mode TEXT NOT NULL DEFAULT 'notice_call'
    CHECK (no_payment_mode IN ('notice', 'notice_call')));

CREATE TABLE booking_operation_runs (
  id              TEXT PRIMARY KEY,
  booking_id      TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'confirmation_line', 'google_calendar', 'conversion',
                    'mileage', 'automation'
                  )),
  status          TEXT NOT NULL CHECK (status IN (
                    'queued', 'succeeded', 'skipped', 'retry_wait',
                    'permanent_failed', 'cancelled'
                  )),
  scheduled_at    TEXT,
  completed_at    TEXT,
  opened_at       TEXT,
  result_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result_json)),
  error_code      TEXT,
  idempotency_key TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  UNIQUE (line_account_id, idempotency_key)
);

CREATE TABLE booking_page_views(id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL REFERENCES line_accounts(id), menu_id TEXT REFERENCES menus(id), friend_id TEXT REFERENCES friends(id), entry_point TEXT, viewed_at TEXT NOT NULL);

CREATE TABLE booking_pass_billing_events (
 event_id TEXT PRIMARY KEY,purchase_id TEXT NOT NULL REFERENCES booking_pass_purchases(id),subscription_id TEXT,invoice_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN('checkout.session.completed','invoice.paid','invoice.payment_failed','customer.subscription.deleted')),
 period_start TEXT NOT NULL,period_end TEXT NOT NULL,occurred_at TEXT NOT NULL,request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 result TEXT NOT NULL CHECK(result IN('recorded','applied','ignored')),test_mode INTEGER NOT NULL DEFAULT 1 CHECK(test_mode=1)
);

CREATE TABLE "booking_pass_plans" (
 id TEXT PRIMARY KEY,line_account_id TEXT NOT NULL REFERENCES line_accounts(id),kind TEXT NOT NULL CHECK(kind IN('ticket','monthly')),name TEXT NOT NULL,
 price INTEGER NOT NULL CHECK(price>=0),count INTEGER,monthly_limit INTEGER,valid_days INTEGER NOT NULL CHECK(valid_days BETWEEN 1 AND 3650),
 target_scope_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(target_scope_json)),allow_without_pass INTEGER NOT NULL DEFAULT 1 CHECK(allow_without_pass IN(0,1)),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','on_sale','stopped')),version INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_json TEXT NOT NULL, notify_remaining_one INTEGER NOT NULL DEFAULT 0 CHECK(notify_remaining_one IN(0,1)), notify_expiry_14_days INTEGER NOT NULL DEFAULT 0 CHECK(notify_expiry_14_days IN(0,1)), event_target_scope_json TEXT CHECK(event_target_scope_json IS NULL OR json_valid(event_target_scope_json) AND json_type(event_target_scope_json)='array'),
 UNIQUE(line_account_id,created_by,idempotency_key),CHECK(kind='ticket' AND count>0 AND monthly_limit IS NULL OR kind='monthly' AND count IS NULL AND (monthly_limit IS NULL OR monthly_limit>0))
);

CREATE TABLE booking_pass_purchases (
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES line_accounts(id),friend_id TEXT NOT NULL REFERENCES friends(id),plan_id TEXT NOT NULL REFERENCES booking_pass_plans(id),
 amount INTEGER NOT NULL CHECK(amount>=0),snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),request_key TEXT NOT NULL,checkout_id TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','paid')),entitlement_id TEXT REFERENCES booking_entitlements(id),subscription_id TEXT UNIQUE,
 test_mode INTEGER NOT NULL DEFAULT 1 CHECK(test_mode=1),created_at TEXT NOT NULL,paid_at TEXT,UNIQUE(account_id,friend_id,request_key)
);

CREATE TABLE booking_payment_booking_links (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES booking_payments(id),
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  actor_id TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL)
);

CREATE TABLE booking_payment_choices (
  booking_id TEXT PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('onsite','online')),
  provider TEXT NOT NULL CHECK(provider IN ('onsite','stripe')),
  hold_minutes INTEGER NOT NULL CHECK(hold_minutes BETWEEN 5 AND 1440)
);

CREATE TABLE "booking_payment_configs" (
  line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'none' CHECK(mode IN ('none','onsite','online','customer_choice')),
  provider TEXT NOT NULL DEFAULT 'none',
  hold_minutes INTEGER NOT NULL DEFAULT 30 CHECK(hold_minutes BETWEEN 5 AND 1440),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE booking_payment_connections (
  line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider='stripe'),
  provider_account_id TEXT NOT NULL CHECK(length(provider_account_id) BETWEEN 6 AND 255),
  test_mode INTEGER NOT NULL DEFAULT 1 CHECK(test_mode IN (0,1)),
  connected_at TEXT NOT NULL CHECK(julianday(connected_at) IS NOT NULL),
  disconnected_at TEXT CHECK(disconnected_at IS NULL OR julianday(disconnected_at) IS NOT NULL),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE booking_payment_event_replays (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES booking_payment_events(id),
  actor_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('applied','duplicate','failed')),
  error_code TEXT,
  UNIQUE(event_id,source_version)
);

CREATE TABLE booking_payment_events (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  payment_id TEXT REFERENCES booking_payments(id) ON DELETE SET NULL,
  provider_payment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('paid','refunded','expired','other')),
  outcome TEXT NOT NULL CHECK(outcome IN ('paid','failed','refunded','expired')),
  amount INTEGER CHECK(amount IS NULL OR (typeof(amount)='integer' AND amount>=0)),
  currency TEXT,
  receipt_url TEXT,
  received_at TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT 'failed' CHECK(result IN ('applied','duplicate','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  repeat_count INTEGER NOT NULL DEFAULT 0 CHECK(repeat_count>=0),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
  lease_token TEXT,
  lease_until TEXT,
  applied_at TEXT,
  error_code TEXT, refunded_amount INTEGER
  CHECK(refunded_amount IS NULL OR (typeof(refunded_amount)='integer' AND refunded_amount>0 AND refunded_amount<=amount)),
  UNIQUE(provider,line_account_id,provider_event_id)
);

CREATE TABLE "booking_payment_menu_settings" (
  menu_id TEXT PRIMARY KEY REFERENCES menus(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('none','onsite','online','customer_choice')),
  provider TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE booking_payment_methods (
 id TEXT PRIMARY KEY, friend_id TEXT NOT NULL REFERENCES friends(id),line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
 setup_id TEXT NOT NULL UNIQUE, stripe_customer_id TEXT, stripe_payment_method_id TEXT,card_brand TEXT,card_last4 TEXT,
 test_mode INTEGER NOT NULL DEFAULT 1 CHECK(test_mode=1),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','ready','detached')),
 idempotency_key TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(line_account_id,friend_id,idempotency_key)
);

CREATE TABLE booking_payment_refunds (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES booking_payments(id),
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
  requested_amount INTEGER CHECK(requested_amount IS NULL OR (typeof(requested_amount)='integer' AND requested_amount>0)),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  actor_id TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  notify_line INTEGER NOT NULL DEFAULT 0 CHECK(notify_line IN (0,1)),
  notification_status TEXT NOT NULL CHECK(notification_status IN ('not_requested','simulated','unavailable')),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  UNIQUE(payment_id,idempotency_key)
);

CREATE TABLE "booking_payments" (
  booking_id_history TEXT,
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'JPY',
  status TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (status IN ('unpaid', 'pending', 'paid', 'failed', 'refunded', 'expired')),
  provider TEXT NOT NULL,
  provider_payment_id TEXT,
  idempotency_key TEXT NOT NULL,
  hold_until TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, refunded_at TEXT, receipt_url TEXT, refunded_amount INTEGER NOT NULL DEFAULT 0
  CHECK(typeof(refunded_amount)='integer' AND refunded_amount>=0 AND refunded_amount<=amount), actor_label TEXT, action_reason TEXT,
  UNIQUE (line_account_id, idempotency_key)
);

CREATE TABLE "booking_reminders" (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL REFERENCES "bookings"(id),
  kind          TEXT NOT NULL CHECK (kind IN ('day_before','hours_before')),
  scheduled_at  TEXT NOT NULL,
  sent_at       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','failed','failed_permanent','cancelled')),
  retry_count   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
, retry_key TEXT, recipient_line_user_id TEXT, messages_json TEXT);

CREATE TABLE booking_resource_consumptions (
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  resource_id TEXT NOT NULL REFERENCES booking_resources(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  snapshot_source TEXT NOT NULL
    CHECK (snapshot_source IN ('booking', 'migration_current_assignment')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (booking_id, resource_id)
);

CREATE TABLE booking_resources (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 1000),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0));

CREATE TABLE booking_routing_staff_groups(id TEXT PRIMARY KEY,line_account_id TEXT NOT NULL REFERENCES line_accounts(id),name TEXT NOT NULL,staff_ids_json TEXT NOT NULL CHECK(json_valid(staff_ids_json)),version INTEGER NOT NULL DEFAULT 1);

CREATE TABLE booking_series (
 id TEXT PRIMARY KEY,line_account_id TEXT NOT NULL REFERENCES line_accounts(id),friend_id TEXT NOT NULL REFERENCES friends(id),menu_id TEXT NOT NULL REFERENCES menus(id),
 staff_policy TEXT NOT NULL CHECK(staff_policy IN('same','auto')),rule_json TEXT NOT NULL CHECK(json_valid(rule_json)),created_by TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','ended','cancelled')),version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,request_json TEXT NOT NULL,UNIQUE(line_account_id,created_by,idempotency_key)
);

CREATE TABLE booking_settings (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL UNIQUE REFERENCES line_accounts(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo' CHECK (length(trim(timezone)) > 0),
  booking_window_days INTEGER NOT NULL DEFAULT 60 CHECK (booking_window_days BETWEEN 1 AND 365),
  cutoff_minutes_before INTEGER NOT NULL DEFAULT 1440 CHECK (cutoff_minutes_before BETWEEN 0 AND 43200),
  cancel_deadline_minutes_before INTEGER NOT NULL DEFAULT 1440 CHECK (cancel_deadline_minutes_before BETWEEN 0 AND 43200),
  max_active_bookings_per_friend INTEGER NOT NULL DEFAULT 1 CHECK (max_active_bookings_per_friend BETWEEN 1 AND 100),
  approval_mode TEXT NOT NULL DEFAULT 'automatic' CHECK (approval_mode IN ('automatic', 'manual')),
  hold_minutes INTEGER NOT NULL DEFAULT 15 CHECK (hold_minutes BETWEEN 1 AND 1440),
  slot_granularity_minutes INTEGER NOT NULL DEFAULT 15 CHECK (slot_granularity_minutes IN (5, 10, 15, 30, 60)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, business_hours_configured INTEGER NOT NULL DEFAULT 0
  CHECK (business_hours_configured IN (0, 1)), reminder_day_before_time TEXT
  CHECK (reminder_day_before_time IS NULL
         OR (reminder_day_before_time GLOB '[0-2][0-9]:[0-5][0-9]'
             AND substr(reminder_day_before_time, 1, 2) <= '23')), reminder_hours_before INTEGER
  CHECK (reminder_hours_before IS NULL
         OR reminder_hours_before BETWEEN 1 AND 72), liff_date_view TEXT NOT NULL DEFAULT 'list'
  CHECK (liff_date_view IN ('list', 'calendar')), waitlist_hold_minutes INTEGER NOT NULL DEFAULT 30
  CHECK (waitlist_hold_minutes BETWEEN 1 AND 1440), store_photo_media_id TEXT, store_photo_interior_media_id TEXT, store_photo_waiting_media_id TEXT, store_photo_order_json TEXT NOT NULL
  DEFAULT '["exterior","interior","waiting"]'
  CHECK (COALESCE(json_valid(store_photo_order_json) AND json_type(store_photo_order_json) = 'array'
    AND json_array_length(store_photo_order_json) = 3
    AND json_extract(store_photo_order_json,'$[0]') IN ('exterior','interior','waiting')
    AND json_extract(store_photo_order_json,'$[1]') IN ('exterior','interior','waiting')
    AND json_extract(store_photo_order_json,'$[2]') IN ('exterior','interior','waiting')
    AND json_extract(store_photo_order_json,'$[0]') <> json_extract(store_photo_order_json,'$[1]')
    AND json_extract(store_photo_order_json,'$[0]') <> json_extract(store_photo_order_json,'$[2]')
    AND json_extract(store_photo_order_json,'$[1]') <> json_extract(store_photo_order_json,'$[2]'),0)));

CREATE TABLE booking_stripe_connect_states (
  line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL UNIQUE CHECK(length(state_hash)=64),
  staff_id TEXT NOT NULL,
  session_hash TEXT NOT NULL CHECK(length(session_hash)=64),
  status TEXT NOT NULL CHECK(status IN ('pending','exchanging','disconnecting','finished','failed')),
  expires_at TEXT NOT NULL CHECK(julianday(expires_at) IS NOT NULL),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE booking_sync_notice_outbox (
 id TEXT PRIMARY KEY, notice_id TEXT NOT NULL REFERENCES booking_sync_notices(id), generation INTEGER NOT NULL,
 retry_key TEXT NOT NULL, sent_at TEXT, lease_until TEXT, lease_token TEXT,
 UNIQUE(notice_id,generation)
);

CREATE TABLE booking_sync_notice_queue (
 line_account_id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);

CREATE TABLE booking_sync_notices (
 id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL REFERENCES line_accounts(id), notice_key TEXT NOT NULL,
 staff_id TEXT NOT NULL REFERENCES staff(id), target_date TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('calendar_disconnected','daily_limit','conflict')),
 status TEXT NOT NULL CHECK(status IN ('open','done','resolved')), booking_id TEXT,
 booking_count INTEGER NOT NULL DEFAULT 0, daily_limit INTEGER, message TEXT NOT NULL,
 generation INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT(datetime('now')), updated_at TEXT NOT NULL DEFAULT(datetime('now')),
 UNIQUE(line_account_id,notice_key)
);

CREATE TABLE booking_sync_rules (
 line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id),
 auto_assign INTEGER NOT NULL CHECK(auto_assign IN (0,1)),
 notify_conflicts INTEGER NOT NULL CHECK(notify_conflicts IN (0,1)),
 notify_calendar_disconnected INTEGER NOT NULL CHECK(notify_calendar_disconnected IN (0,1)),
 notify_daily_limit INTEGER NOT NULL CHECK(notify_daily_limit IN (0,1)),
 daily_limit INTEGER NOT NULL CHECK(daily_limit BETWEEN 1 AND 1000),
 near_limit_remaining INTEGER NOT NULL CHECK(near_limit_remaining>=0 AND near_limit_remaining<daily_limit),
 version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);

CREATE TABLE booking_visit_marks (
  id                    TEXT PRIMARY KEY,
  booking_id            TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  line_account_id       TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  -- visited: 来店した / late: 遅れる / no_show: 来なかった
  kind                  TEXT NOT NULL CHECK (kind IN ('visited', 'late', 'no_show')),
  -- late のときだけ必須の遅れ分数。
  late_minutes          INTEGER CHECK (late_minutes IS NULL OR (late_minutes BETWEEN 1 AND 1440)),
  -- 付けた人（ログイン利用者）。予約の担当表とは別物なので外部キーは付けない
  -- （監査の actor と同じ考え方）。表示名も一緒に残す。
  marked_by_staff_id    TEXT,
  marked_by_name        TEXT,
  -- UTC ISO8601。付けた時刻。
  marked_at             TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  CHECK ((kind = 'late' AND late_minutes IS NOT NULL)
      OR (kind != 'late' AND late_minutes IS NULL))
);

CREATE TABLE "booking_waitlist" (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  staff_id              TEXT NOT NULL REFERENCES staff(id),
  menu_id               TEXT NOT NULL REFERENCES menus(id),
  starts_at             TEXT NOT NULL,
  friend_id             TEXT REFERENCES friends(id) ON DELETE SET NULL,
  booking_customer_id   TEXT REFERENCES booking_customers(id) ON DELETE SET NULL,
  -- 枠の中の本人確認。friend_id / booking_customer_id のどちらか。
  -- 同じ枠に同じ人が二度並べないための鍵。
  identity_key          TEXT NOT NULL,
  -- waiting: 待っている / invited: 空きを知らせた（仮押さえ中）
  -- / converted: 予約になった / cancelled: 本人が取り消した
  status                TEXT NOT NULL DEFAULT 'waiting'
                          CHECK (status IN ('waiting', 'invited', 'converted', 'cancelled', 'finished')),
  hold_minutes          INTEGER NOT NULL DEFAULT 30 CHECK (hold_minutes BETWEEN 1 AND 1440),
  invited_at            TEXT,
  hold_expires_at       TEXT,
  -- LINE を送った時刻。LINE 未連携の電話客は店が電話するため NULL のまま。
  notified_at           TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ends_at TEXT, block_ends_at TEXT, capacity_windows_json TEXT NOT NULL DEFAULT '[]', finish_reason TEXT, notification_retry_key TEXT, notification_claim_until TEXT, last_processed_at TEXT,
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (friend_id IS NOT NULL OR booking_customer_id IS NOT NULL)
);

CREATE TABLE booking_waitlist_resources(waitlist_id TEXT NOT NULL REFERENCES booking_waitlist(id) ON DELETE CASCADE,resource_id TEXT NOT NULL REFERENCES booking_resources(id),quantity INTEGER NOT NULL,PRIMARY KEY(waitlist_id,resource_id));

CREATE TABLE "bookings" (
  id                           TEXT PRIMARY KEY,
  line_account_id              TEXT NOT NULL,
  friend_id                    TEXT,
  booking_customer_id          TEXT REFERENCES booking_customers(id) ON DELETE RESTRICT,
  staff_id                     TEXT NOT NULL,
  menu_id                      TEXT NOT NULL,
  starts_at                    TEXT NOT NULL,
  ends_at                      TEXT NOT NULL,
  block_ends_at                TEXT NOT NULL,
  status                       TEXT NOT NULL CHECK (status IN ('requested','confirmed','rejected','expired','cancelled','completed','no_show')),
  customer_note                TEXT,
  internal_note                TEXT,
  price_at_booking             INTEGER NOT NULL,
  requested_at                 TEXT NOT NULL,
  decided_at                   TEXT,
  decided_by_staff_id          TEXT,
  external_event_id            TEXT,
  external_calendar_id         TEXT,
  source                       TEXT NOT NULL DEFAULT 'liff'
                                 CHECK (source IN ('liff','phone','counter','operator','import')),
  created_by_staff_id          TEXT,
  updated_by_staff_id          TEXT,
  lock_version                 INTEGER NOT NULL DEFAULT 0,
  notification_policy_snapshot TEXT NOT NULL DEFAULT '{}'
                                 CHECK (json_valid(notification_policy_snapshot)),
  cancelled_at                 TEXT,
  completed_at                 TEXT,
  created_at                   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at                   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), menu_version_number INTEGER CHECK (menu_version_number IS NULL OR menu_version_number > 0), menu_snapshot_json TEXT CHECK (menu_snapshot_json IS NULL OR json_valid(menu_snapshot_json)), cancel_claim_id TEXT, waitlist_entry_id TEXT, meeting_mode TEXT CHECK(meeting_mode IN('online','in_person')), meeting_url TEXT, meeting_location TEXT, consultation_outcome TEXT CHECK(consultation_outcome IN('considering','won','lost')), outcome_recorded_at TEXT, outcome_recorded_by TEXT, cancellation_reason TEXT, designation TEXT NOT NULL DEFAULT 'unspecified' CHECK(designation IN('designated','any','unspecified')), entry_point TEXT, policy_snapshot_json TEXT CHECK(policy_snapshot_json IS NULL OR json_valid(policy_snapshot_json)), meeting_url_source TEXT CHECK(meeting_url_source IN('staff','menu','manual')), nominated INTEGER NOT NULL DEFAULT 0 CHECK(nominated IN(0,1)), nomination_fee_at_booking INTEGER NOT NULL DEFAULT 0 CHECK(nomination_fee_at_booking >= 0), series_id TEXT REFERENCES booking_series(id), series_index INTEGER, routing_rule_index INTEGER, routing_form_version_id TEXT REFERENCES form_versions(id), group_id TEXT REFERENCES booking_groups(id), person_label TEXT, group_index INTEGER, deposit_snapshot_json TEXT, booking_payment_method_id TEXT REFERENCES booking_payment_methods(id),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (friend_id) REFERENCES friends(id),
  FOREIGN KEY (staff_id) REFERENCES staff(id),
  FOREIGN KEY (menu_id) REFERENCES menus(id),
  FOREIGN KEY (created_by_staff_id) REFERENCES staff(id),
  FOREIGN KEY (updated_by_staff_id) REFERENCES staff(id),
  CHECK (friend_id IS NOT NULL OR booking_customer_id IS NOT NULL)
);

CREATE TABLE broadcast_ab_recipients(broadcast_id TEXT NOT NULL REFERENCES broadcasts(id),friend_id TEXT NOT NULL REFERENCES friends(id),variant_key TEXT NOT NULL CHECK(variant_key IN('A','B','R')),state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','sent','failed','unknown')),sent_at TEXT,test_mode INTEGER NOT NULL DEFAULT 1 CHECK(test_mode=1),PRIMARY KEY(broadcast_id,friend_id));

CREATE TABLE broadcast_ab_tests(broadcast_id TEXT PRIMARY KEY REFERENCES broadcasts(id),test_ratio_pct INTEGER NOT NULL CHECK(test_ratio_pct IN(10,20,30,50)),metric TEXT NOT NULL DEFAULT 'click' CHECK(metric='click'),decide_after_minutes INTEGER NOT NULL CHECK(decide_after_minutes IN(60,120,240,480,1440)),undecided_policy TEXT NOT NULL DEFAULT 'stop' CHECK(undecided_policy IN('stop','send_a')),status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','testing','decided','undecided','finished','expired','stopped')),winner TEXT CHECK(winner IN('A','B')),decided_at TEXT,decided_by TEXT,remainder_scheduled_at TEXT,remainder_sent_at TEXT,stats_json TEXT,started_at TEXT,decide_at TEXT,version INTEGER NOT NULL DEFAULT 1,test_mode INTEGER NOT NULL DEFAULT 1 CHECK(test_mode=1),choice_key TEXT,choice_value TEXT, start_key TEXT, start_request_json TEXT CHECK(start_request_json IS NULL OR json_valid(start_request_json)), start_result_json TEXT CHECK(start_result_json IS NULL OR json_valid(start_result_json)));

CREATE TABLE broadcast_after_action_runs (
  id                       TEXT PRIMARY KEY,
  broadcast_id             TEXT NOT NULL REFERENCES broadcasts (id) ON DELETE CASCADE,
  friend_id                TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  common_action_version_id TEXT NOT NULL,
  action_id                TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempt_count            INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts             INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  error_code               TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (broadcast_id, friend_id, action_id)
);

CREATE TABLE broadcast_approval_events (
  id              TEXT PRIMARY KEY,
  broadcast_id    TEXT NOT NULL REFERENCES broadcasts (id) ON DELETE CASCADE,
  actor_staff_id  TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('requested', 'approved', 'rejected', 'cancelled', 'expired', 'reminded')),
  reason          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE broadcast_asset_folders (
  id TEXT PRIMARY KEY,
  line_account_id TEXT REFERENCES line_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE broadcast_asset_publish_keys (
  asset_id TEXT NOT NULL REFERENCES broadcast_message_assets(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  published_version INTEGER NOT NULL,
  draft_revision INTEGER NOT NULL,
  draft_fingerprint TEXT NOT NULL DEFAULT '',
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, idempotency_key)
);

CREATE TABLE broadcast_asset_versions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES broadcast_message_assets(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_by_staff_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, version_number)
);

CREATE TABLE broadcast_execution_contexts (
 broadcast_id TEXT PRIMARY KEY REFERENCES broadcasts(id) ON DELETE CASCADE,account_id TEXT NOT NULL REFERENCES line_accounts(id),
 purpose TEXT NOT NULL CHECK(purpose IN('transaction','notice','marketing')),execution_mode TEXT NOT NULL DEFAULT 'simulation' CHECK(execution_mode='simulation'),
 created_via TEXT NOT NULL CHECK(created_via IN('manual','mcp')),created_by TEXT NOT NULL,mcp_connection_id TEXT REFERENCES mcp_connections(id),
 request_key TEXT NOT NULL,request_fingerprint TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN('draft','scheduled','completed')),
 execution_key TEXT,execution_request_json TEXT,confirmed_count INTEGER,completed_at TEXT,
 UNIQUE(account_id,created_by,request_key)
);

CREATE TABLE broadcast_insights (
  id                  TEXT PRIMARY KEY,
  broadcast_id        TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  delivered           INTEGER,
  unique_impression   INTEGER,
  unique_click        INTEGER,
  unique_media_played INTEGER,
  open_rate           REAL,
  click_rate          REAL,
  raw_response        TEXT,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  retry_count         INTEGER NOT NULL DEFAULT 0,
  fetched_at          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE broadcast_lifecycle_events (
  id              TEXT PRIMARY KEY,
  broadcast_id    TEXT NOT NULL REFERENCES broadcasts (id) ON DELETE CASCADE,
  actor_staff_id  TEXT,
  action          TEXT NOT NULL CHECK (action IN (
    'created', 'updated', 'scheduled', 'send_started',
    'stopped', 'resumed', 'retried', 'cancelled'
  )),
  reason          TEXT,
  detail_json     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE broadcast_media_upload_sessions (
  id TEXT PRIMARY KEY,
  line_account_id TEXT REFERENCES line_accounts(id),
  created_by TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  public_key TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  expected_size INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE broadcast_message_assets (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT REFERENCES line_accounts(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('rich_message', 'card_message', 'coupon', 'research')),
  name            TEXT NOT NULL,
  payload_json    TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
, folder_id TEXT REFERENCES broadcast_asset_folders(id) ON DELETE SET NULL, published_version INTEGER NOT NULL DEFAULT 0, published_at TEXT, draft_payload_json TEXT CHECK (draft_payload_json IS NULL OR json_valid(draft_payload_json)), draft_revision INTEGER NOT NULL DEFAULT 0);

CREATE TABLE broadcast_saved_views (
  id               TEXT PRIMARY KEY,
  line_account_id  TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  filters_json     TEXT NOT NULL DEFAULT '{}'
                   CHECK (json_valid(filters_json)),
  sort_key         TEXT NOT NULL DEFAULT 'newest'
                   CHECK (sort_key IN ('newest', 'oldest', 'title', 'scheduled')),
  page_size        INTEGER NOT NULL DEFAULT 20
                   CHECK (page_size IN (20, 50, 100)),
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (line_account_id, name)
);

CREATE TABLE broadcast_send_claims (
  broadcast_id    TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  friend_id       TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  line_account_id TEXT,
  attempt_no      INTEGER NOT NULL DEFAULT 1 CHECK (attempt_no >= 1),
  state           TEXT NOT NULL CHECK (state IN ('claimed', 'sent', 'failed', 'unknown')),
  dispatched_at   TEXT,
  settled_at      TEXT,
  error_code      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), line_request_id TEXT, variant_key TEXT CHECK(variant_key IN('A','B','R')),
  PRIMARY KEY (broadcast_id, friend_id)
);

CREATE TABLE broadcast_tracked_links (
  broadcast_id     TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  tracked_link_id  TEXT NOT NULL REFERENCES tracked_links(id) ON DELETE RESTRICT,
  label            TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (broadcast_id, tracked_link_id)
);

CREATE TABLE broadcast_variants(id TEXT PRIMARY KEY,broadcast_id TEXT NOT NULL REFERENCES broadcasts(id),variant_key TEXT NOT NULL CHECK(variant_key IN('A','B')),messages_json TEXT NOT NULL CHECK(json_valid(messages_json)),version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,UNIQUE(broadcast_id,variant_key));

CREATE TABLE "broadcasts" (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  message_type       TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'location', 'video', 'audio', 'sticker', 'carousel', 'imagemap', 'rich_message', 'coupon')),
  message_content    TEXT NOT NULL,
  target_type        TEXT NOT NULL CHECK (target_type IN ('all', 'tag', 'segment', 'multi-account-dedup')) DEFAULT 'all',
  target_tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,
  status             TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'sending', 'sent')) DEFAULT 'draft',
  scheduled_at       TEXT,
  sent_at            TEXT,
  total_count        INTEGER NOT NULL DEFAULT 0,
  success_count      INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  line_account_id    TEXT,
  alt_text           TEXT,
  line_request_id    TEXT,
  aggregation_unit   TEXT,
  batch_offset       INTEGER NOT NULL DEFAULT 0,
  segment_conditions TEXT,
  account_ids        TEXT CHECK (account_ids IS NULL OR json_valid(account_ids)),
  dedup_priority     TEXT CHECK (dedup_priority IS NULL OR json_valid(dedup_priority)),
  failed_account_ids TEXT CHECK (failed_account_ids IS NULL OR json_valid(failed_account_ids)),
  dedup_progress     TEXT,
  batch_lock_at      TEXT,
  track_links        INTEGER NOT NULL DEFAULT 1,
  message_bubbles_json TEXT CHECK (message_bubbles_json IS NULL OR json_valid(message_bubbles_json)),
  stealth_spread_minutes INTEGER NOT NULL DEFAULT 0
, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL, measure_opens INTEGER NOT NULL DEFAULT 1, internal_memo TEXT, draft_step TEXT
  CHECK (draft_step IS NULL OR draft_step IN ('basic', 'audience', 'message', 'schedule', 'confirm')), draft_payload_json TEXT
  CHECK (draft_payload_json IS NULL OR json_valid(draft_payload_json)), message_options_json TEXT
  CHECK (message_options_json IS NULL OR json_valid(message_options_json)), after_action_version_id TEXT
  REFERENCES common_action_versions(id) ON DELETE RESTRICT, lock_version INTEGER NOT NULL DEFAULT 1
  CHECK (lock_version > 0), stopped_at TEXT, stopped_by TEXT, send_attempt_no INTEGER NOT NULL DEFAULT 1, common_var_snapshot TEXT
  CHECK (common_var_snapshot IS NULL OR json_valid(common_var_snapshot)), common_var_snapshot_at TEXT, approval_status TEXT NOT NULL DEFAULT 'none', approval_requested_by_staff_id TEXT, approval_requested_at TEXT, approval_approver_staff_id TEXT, approval_note TEXT, approval_decided_by_staff_id TEXT, approval_decided_at TEXT, approval_reject_reason TEXT, approval_confirmed_count INTEGER, hq_run_id TEXT REFERENCES hq_broadcast_runs(id));

CREATE TABLE calendar_bookings (
  id             TEXT PRIMARY KEY,
  connection_id  TEXT NOT NULL REFERENCES google_calendar_connections (id) ON DELETE CASCADE,
  friend_id      TEXT REFERENCES friends (id) ON DELETE SET NULL,
  event_id       TEXT,
  title          TEXT NOT NULL,
  start_at       TEXT NOT NULL,
  end_at         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled', 'completed')),
  metadata       TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE carousel_taps (
  id              TEXT PRIMARY KEY,
  template_id     TEXT NOT NULL,
  column_index    INTEGER NOT NULL,
  action_index    INTEGER NOT NULL,
  action_label    TEXT,
  friend_id       TEXT,
  line_account_id TEXT,
  tapped_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE "chats" (
  id                       TEXT PRIMARY KEY,
  friend_id                TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  operator_id              TEXT REFERENCES operators (id) ON DELETE SET NULL,
  status                   TEXT NOT NULL DEFAULT 'unread'
                           CHECK (status IN ('unread', 'in_progress', 'on_hold', 'resolved')),
  notes                    TEXT,
  last_message_at          TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  line_account_id          TEXT,
  first_replied_at         TEXT,
  last_incoming_at         TEXT,
  revision                 INTEGER NOT NULL DEFAULT 0,
  last_customer_message_at TEXT,
  last_operator_message_at TEXT,
  next_response_due_at     TEXT
, assigned_by TEXT CHECK(assigned_by IN ('auto','manual')), pending_since TEXT, sla_due_at TEXT, first_response_at TEXT, sla_notified_stage INTEGER NOT NULL DEFAULT 0, assignment_token TEXT, assigned_at TEXT, assignee_staff_id TEXT);

CREATE TABLE codex_cloud_tasks (
  slack_event_id               TEXT PRIMARY KEY,
  team_id                      TEXT NOT NULL,
  channel_id                   TEXT NOT NULL,
  message_ts                   TEXT NOT NULL,
  thread_ts                    TEXT NOT NULL,
  requester_user_id            TEXT NOT NULL,
  status                       TEXT NOT NULL DEFAULT 'detected'
                                 CHECK (status IN (
                                   'detected',
                                   'official_running',
                                   'official_failed',
                                   'fallback_starting',
                                   'fallback_running',
                                   'fallback_suspended',
                                   'duplicate_risk',
                                   'completed',
                                   'failed'
                                 )),
  official_task_url            TEXT,
  fallback_run_id              TEXT,
  fallback_conversation_url    TEXT,
  detected_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel_id, message_ts)
);

CREATE TABLE common_action_binding_migration_events (
  id                       TEXT PRIMARY KEY,
  line_account_id          TEXT NOT NULL REFERENCES line_accounts(id),
  common_action_id         TEXT NOT NULL REFERENCES common_actions(id),
  binding_id               TEXT NOT NULL REFERENCES common_action_bindings(id),
  from_action_version_id   TEXT NOT NULL REFERENCES common_action_versions(id),
  to_action_version_id     TEXT NOT NULL REFERENCES common_action_versions(id),
  actor_id                 TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE common_action_bindings (
  id                       TEXT PRIMARY KEY,
  line_account_id          TEXT NOT NULL REFERENCES line_accounts(id),
  common_action_id         TEXT NOT NULL REFERENCES common_actions(id),
  common_action_version_id TEXT NOT NULL REFERENCES common_action_versions(id),
  consumer_type            TEXT NOT NULL,
  consumer_id              TEXT NOT NULL,
  consumer_path            TEXT NOT NULL DEFAULT '',
  created_by               TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (line_account_id, consumer_type, consumer_id, consumer_path, common_action_id)
);

CREATE TABLE common_action_versions (
  id               TEXT PRIMARY KEY,
  common_action_id TEXT NOT NULL REFERENCES common_actions(id),
  version_number   INTEGER NOT NULL CHECK (version_number > 0),
  status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'published')),
  action_config    TEXT NOT NULL DEFAULT '[]',
  created_by       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  published_at     TEXT, draft_revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE (common_action_id, version_number)
);

CREATE TABLE common_actions (
  id                           TEXT PRIMARY KEY,
  line_account_id              TEXT NOT NULL REFERENCES line_accounts(id),
  name                         TEXT NOT NULL,
  description                  TEXT,
  status                       TEXT NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft', 'published', 'archived')),
  current_draft_version_id     TEXT REFERENCES common_action_versions(id)
                                 DEFERRABLE INITIALLY DEFERRED,
  current_published_version_id TEXT REFERENCES common_action_versions(id)
                                 DEFERRABLE INITIALLY DEFERRED,
  created_by                   TEXT,
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at                  TEXT
, client_request_key TEXT, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL);

CREATE TABLE common_var_export_jobs (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  filter_json TEXT NOT NULL CHECK (json_valid(filter_json)),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','failed','expired')),
  total_count INTEGER CHECK (total_count IS NULL OR total_count >= 0),
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  row_count INTEGER CHECK (row_count IS NULL OR row_count >= 0),
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  csv_text TEXT,
  created_by TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  expires_at TEXT NOT NULL,
  failure_reason TEXT
);

CREATE TABLE "common_var_replacement_runs" (id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE, source_common_var_id TEXT NOT NULL REFERENCES "common_vars"(id), replacement_common_var_id TEXT NOT NULL REFERENCES "common_vars"(id), source_version INTEGER NOT NULL, expected_usage_count INTEGER NOT NULL, replaced_usage_count INTEGER NOT NULL, actor_id TEXT, status TEXT NOT NULL CHECK (status IN ('completed', 'partial')), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')));

CREATE TABLE "common_var_resolution_failures" (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  source_kind     TEXT NOT NULL CHECK (source_kind IN (
    'broadcast', 'scenario', 'first_step', 'reminder',
    'form_reply', 'auto_reply', 'test_send', 'chat',
    'automation', 'friend_direct', 'rich_menu_tap', 'carousel_tap', 'liff',
    'notification'
  )),
  source_id       TEXT NOT NULL,
  var_key         TEXT NOT NULL,
  reason          TEXT NOT NULL CHECK (reason IN ('missing', 'not_started', 'expired', 'fallback_missing', 'invalid_window', 'stopped', 'draft')),
  retryable       INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1)),
  execution_at    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  UNIQUE(source_kind, source_id, var_key, execution_at)
);

CREATE TABLE "common_var_schedules" (id TEXT PRIMARY KEY, var_id TEXT NOT NULL REFERENCES "common_vars"(id) ON DELETE CASCADE, effective_from TEXT NOT NULL, value TEXT NOT NULL, applied_at TEXT);

CREATE TABLE "common_var_versions" (id TEXT PRIMARY KEY, common_var_id TEXT NOT NULL REFERENCES "common_vars"(id) ON DELETE CASCADE, version_no INTEGER NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, memo TEXT NOT NULL DEFAULT '', change_reason TEXT NOT NULL, actor_id TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')), UNIQUE(common_var_id, version_no));

CREATE TABLE "common_vars" (
  id TEXT PRIMARY KEY,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  var_key TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text','url','image','number','long_text','date','datetime','boolean')),
  value TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  line_account_id TEXT REFERENCES line_accounts(id) ON DELETE CASCADE,
  memo TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT, archived_at TEXT, replacement_run_id TEXT, valid_from TEXT, valid_until TEXT, fallback_value TEXT, expiry_behavior TEXT NOT NULL DEFAULT 'stop'
  CHECK (expiry_behavior IN ('stop', 'fallback')), status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('draft', 'active', 'stopped')), stopped_at TEXT, expiry_notice_14_at TEXT, expiry_notice_3_at TEXT,
  UNIQUE(line_account_id, var_key)
);

CREATE TABLE conversion_anonymous_days (
  conversion_point_id TEXT NOT NULL REFERENCES conversion_points(id) ON DELETE CASCADE,
  day                 TEXT NOT NULL,
  anonymous_count     INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  PRIMARY KEY (conversion_point_id, day)
);

CREATE TABLE conversion_definition_operations (
  id                  TEXT PRIMARY KEY,
  conversion_point_id TEXT NOT NULL,
  action              TEXT NOT NULL CHECK (action IN ('stop', 'replace', 'delete')),
  replacement_id      TEXT,
  affected_usages     INTEGER NOT NULL DEFAULT 0 CHECK (affected_usages >= 0),
  reason              TEXT,
  performed_by        TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE TABLE conversion_definition_revisions (
  id                  TEXT PRIMARY KEY,
  conversion_point_id TEXT NOT NULL REFERENCES conversion_points(id) ON DELETE CASCADE,
  from_version        INTEGER NOT NULL CHECK (from_version > 0),
  to_version          INTEGER NOT NULL CHECK (to_version > from_version),
  before_config_json  TEXT NOT NULL CHECK (json_valid(before_config_json)),
  after_config_json   TEXT NOT NULL CHECK (json_valid(after_config_json)),
  affected_usages     INTEGER NOT NULL DEFAULT 0 CHECK (affected_usages >= 0),
  reason              TEXT,
  performed_by        TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  UNIQUE (conversion_point_id, to_version)
);

CREATE TABLE conversion_definition_usages (
  id                       TEXT PRIMARY KEY,
  conversion_point_id      TEXT NOT NULL REFERENCES conversion_points(id),
  definition_version       INTEGER NOT NULL CHECK (definition_version > 0),
  line_account_id          TEXT NOT NULL REFERENCES line_accounts(id),
  ref_kind                 TEXT NOT NULL CHECK (ref_kind IN (
    'affiliate_offer', 'analytics', 'auto_reply', 'scenario', 'nen_campaign',
    'mileage_rule', 'automation', 'ad_platform'
  )),
  ref_id                   TEXT NOT NULL,
  ref_version_id           TEXT,
  created_by               TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE TABLE conversion_event_dedup_claims (
  conversion_point_id TEXT NOT NULL REFERENCES conversion_points(id) ON DELETE CASCADE,
  friend_id           TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  mode                TEXT NOT NULL CHECK (mode IN ('lifetime', 'window')),
  window_days         INTEGER CHECK (window_days IS NULL OR window_days BETWEEN 1 AND 365),
  last_event_id       TEXT NOT NULL,
  last_at             TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (conversion_point_id, friend_id),
  CHECK ((mode = 'lifetime' AND window_days IS NULL)
      OR (mode = 'window' AND window_days IS NOT NULL))
);

CREATE TABLE conversion_event_reversals (
  id                  TEXT PRIMARY KEY,
  conversion_event_id TEXT NOT NULL REFERENCES conversion_events(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('reverse', 'restore')),
  reason              TEXT NOT NULL,
  actor_id            TEXT,
  actor_name          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
);

CREATE TABLE conversion_events (
  id                   TEXT PRIMARY KEY,
  conversion_point_id  TEXT NOT NULL REFERENCES conversion_points (id) ON DELETE CASCADE,
  friend_id            TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  user_id              TEXT,
  affiliate_code       TEXT,
  metadata             TEXT,
  affiliate_id         TEXT REFERENCES affiliates (id),
  attributed_ref_code  TEXT,
  approval_status      TEXT CHECK (approval_status IN ('pending','approved','rejected')),
  approved_at          TEXT,
  point_name_snapshot  TEXT,
  event_type_snapshot  TEXT,
  value_snapshot       REAL,
  idempotency_key      TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, point_version_snapshot INTEGER, tenant_id TEXT REFERENCES tenants(id), approval_amount_minor INTEGER, approval_formula TEXT, approval_commission_rate REAL, approval_base_amount REAL, approval_fixed_reward INTEGER, approval_reward_miles INTEGER, approval_notified_generation TEXT);

CREATE TABLE conversion_ingestion_events (
  id                  TEXT PRIMARY KEY,
  conversion_point_id TEXT NOT NULL,
  result              TEXT NOT NULL
                      CHECK (result IN ('recorded', 'duplicate', 'rejected')),
  reason              TEXT,
  source_event_id     TEXT,
  friend_id           TEXT,
  payload_shape_json  TEXT,
  signature_sha256    TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, is_test INTEGER NOT NULL DEFAULT 0);

CREATE TABLE "conversion_points" (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  event_type TEXT NOT NULL,
  value      REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  status     TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active', 'stopped', 'draft')),
  stopped_at TEXT,
  updated_at TEXT,
  measure_method TEXT NOT NULL DEFAULT 'manual'
             CHECK (measure_method IN ('url_reach', 'webhook', 'manual')),
  target_url TEXT,
  count_repeat INTEGER NOT NULL DEFAULT 1,
  attribution_days INTEGER,
  line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL,
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  source_config_json TEXT NOT NULL DEFAULT '{}'
             CHECK (json_valid(source_config_json)),
  deduplication_mode TEXT NOT NULL DEFAULT 'every'
             CHECK (deduplication_mode IN ('every', 'once_per_friend', 'window')),
  deduplication_window_days INTEGER
             CHECK (deduplication_window_days IS NULL OR deduplication_window_days BETWEEN 1 AND 365),
  value_mode TEXT NOT NULL DEFAULT 'fixed'
             CHECK (value_mode IN ('source', 'fixed', 'none')),
  reversal_policy TEXT NOT NULL DEFAULT 'manual'
             CHECK (reversal_policy IN ('source_cancelled', 'manual', 'none')),
  tenant_id  TEXT REFERENCES tenants(id),
  ingest_secret_encrypted TEXT,
  ingest_disabled_at TEXT
, count_anonymous INTEGER NOT NULL DEFAULT 0, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL);

CREATE TABLE coupon_redemptions (
  id TEXT PRIMARY KEY,
  -- 素材を削除しても使用履歴を残す。設定はpayload_snapshotに固定する。
  asset_id TEXT NOT NULL,
  friend_id TEXT NOT NULL REFERENCES friends(id),
  line_account_id TEXT REFERENCES line_accounts(id),
  incoming_event_id TEXT NOT NULL UNIQUE,
  used_at TEXT NOT NULL,
  use_number INTEGER NOT NULL,
  payload_snapshot TEXT NOT NULL
, entry_route_coupon_receipt_id TEXT REFERENCES entry_route_coupon_receipts(id));

CREATE TABLE customer_activity_daily (
 account_id TEXT NOT NULL REFERENCES line_accounts(id),friend_id TEXT NOT NULL REFERENCES friends(id),basis TEXT NOT NULL CHECK(basis IN('visit','purchase','both')),
 activity_count INTEGER NOT NULL,amount INTEGER NOT NULL,last_activity_at TEXT,r_bucket INTEGER,f_bucket INTEGER,m_bucket INTEGER,computed_at TEXT NOT NULL,
 PRIMARY KEY(account_id,friend_id,basis)
);

CREATE TABLE customer_activity_runs(account_id TEXT PRIMARY KEY REFERENCES line_accounts(id),computed_at TEXT,last_attempt_at TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('ready','failed')));

CREATE TABLE customer_notification_definitions (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  key                   TEXT NOT NULL,
  name                  TEXT NOT NULL,
  category              TEXT NOT NULL,
  source_event_type     TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'stopped')),
  current_version_id    TEXT,
  draft_config_json     TEXT NOT NULL DEFAULT '{}',
  transactional_only    INTEGER NOT NULL DEFAULT 1
                        CHECK (transactional_only = 1),
  version               INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by            TEXT NOT NULL,
  updated_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (line_account_id, key)
);

CREATE TABLE customer_notification_versions (
  id                      TEXT PRIMARY KEY,
  definition_id           TEXT NOT NULL REFERENCES customer_notification_definitions(id) ON DELETE CASCADE,
  version_number          INTEGER NOT NULL CHECK (version_number > 0),
  config_json             TEXT NOT NULL,
  line_template_json      TEXT NOT NULL,
  aggregation_rule        TEXT NOT NULL DEFAULT 'definition_day',
  email_fallback_policy   TEXT NOT NULL DEFAULT 'disabled',
  published_by            TEXT NOT NULL,
  published_at            TEXT NOT NULL,
  UNIQUE (definition_id, version_number)
);

CREATE TABLE dashboard_default_preferences (
  line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  cards TEXT NOT NULL CHECK (json_valid(cards)),
  updated_by TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE dashboard_preferences (
  staff_id TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  cards TEXT NOT NULL CHECK (json_valid(cards)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (staff_id, line_account_id)
);

CREATE TABLE ec_action_execution_attempts (
  id TEXT PRIMARY KEY,
  action_execution_id TEXT NOT NULL REFERENCES ec_action_executions(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('automatic', 'manual')),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  requested_by TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  error_code TEXT,
  error_message_safe TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (action_execution_id, attempt_number)
);

CREATE TABLE ec_action_executions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES ec_events(id) ON DELETE RESTRICT,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'skipped', 'retryable_failed', 'permanent_failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  error_code TEXT,
  error_message_safe TEXT,
  last_attempted_at TEXT,
  next_retry_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (event_id, action_type, rule_version)
);

CREATE TABLE ec_auto_line_attribution_events (
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES line_accounts(id),send_id TEXT NOT NULL REFERENCES ec_auto_line_sends(id),friend_id TEXT NOT NULL REFERENCES friends(id),
 kind TEXT NOT NULL CHECK(kind IN('click','purchase')),external_event_id TEXT NOT NULL,order_id TEXT,amount INTEGER CHECK(amount>=0),occurred_at TEXT NOT NULL,
 test_mode INTEGER NOT NULL DEFAULT 1 CHECK(test_mode=1),request_json TEXT NOT NULL,
 UNIQUE(account_id,external_event_id)
);

CREATE TABLE ec_auto_line_rule_events (
 account_id TEXT NOT NULL REFERENCES line_accounts(id),request_key TEXT NOT NULL,kind TEXT NOT NULL,
 actor_id TEXT NOT NULL,impersonation_id TEXT,reason TEXT,request_json TEXT NOT NULL,response_json TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(account_id,request_key)
);

CREATE TABLE ec_auto_line_rules (
 account_id TEXT NOT NULL REFERENCES line_accounts(id),kind TEXT NOT NULL CHECK(kind IN('cart','browse','restock')),enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
 wait_minutes INTEGER NOT NULL,messages_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(messages_json)),version INTEGER NOT NULL DEFAULT 1,test_mode INTEGER NOT NULL DEFAULT 1 CHECK(test_mode=1),updated_by TEXT,PRIMARY KEY(account_id,kind)
);

CREATE TABLE ec_auto_line_sends (
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES line_accounts(id),rule_kind TEXT NOT NULL,friend_id TEXT NOT NULL REFERENCES friends(id),product_id TEXT NOT NULL,
 trigger_event_id TEXT NOT NULL REFERENCES ec_behavior_events(id),scheduled_at TEXT NOT NULL,original_due_at TEXT NOT NULL,messages_snapshot_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',
 sent_at TEXT,test_mode INTEGER NOT NULL DEFAULT 1 CHECK(test_mode=1),claim_token TEXT,UNIQUE(trigger_event_id,rule_kind)
);

CREATE TABLE ec_behavior_events (
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES line_accounts(id),friend_id TEXT REFERENCES friends(id),ec_customer_id TEXT,
 type TEXT NOT NULL CHECK(type IN('cart_add','cart_remove','product_view','purchase','restock','restock_subscribe')),
 product_id TEXT NOT NULL,product_snapshot_json TEXT NOT NULL CHECK(json_valid(product_snapshot_json)),occurred_at TEXT NOT NULL,received_at TEXT NOT NULL,dedupe_key TEXT NOT NULL,
 UNIQUE(account_id,dedupe_key)
);

CREATE TABLE ec_connectors (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('ec_cube', 'shopify')),
  shop_domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'degraded', 'paused', 'auth_expired', 'rate_limited')),
  inbound_secret_encrypted TEXT,
  inbound_secret_last4 TEXT,
  secret_updated_at TEXT,
  event_types_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(event_types_json) AND json_type(event_types_json) = 'array'),
  identity_rules_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(identity_rules_json) AND json_type(identity_rules_json) = 'array'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (line_account_id)
);

CREATE TABLE ec_events (
  id                TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  line_account_id   TEXT REFERENCES line_accounts(id),
  customer_id       TEXT,
  line_user_id      TEXT,
  friend_id         TEXT,
  payload           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received', 'identity_pending', 'processing', 'processed', 'skipped', 'failed')),
  error_message     TEXT,
  received_at       TEXT NOT NULL,
  processed_at      TEXT,
  updated_at        TEXT NOT NULL, identity_recovery_mode TEXT CHECK(identity_recovery_mode IN ('analytics_snapshot','non_delivery_actions')),
  UNIQUE (source, external_event_id),
  FOREIGN KEY (friend_id) REFERENCES friends(id) ON DELETE SET NULL
);

CREATE TABLE ec_identity_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL REFERENCES identity_candidates(id) ON DELETE RESTRICT,
  source_key TEXT NOT NULL,
  shop_key TEXT NOT NULL,
  external_customer_id TEXT NOT NULL,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE RESTRICT,
  linked_by TEXT,
  linked_at TEXT NOT NULL,
  unlinked_by TEXT,
  unlinked_at TEXT,
  unlink_reason TEXT
);

CREATE TABLE ec_notification_account_settings (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL REFERENCES ec_notification_settings(event_type) ON DELETE CASCADE,
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  title_override TEXT,
  intro_text TEXT,
  outro_text TEXT,
  button_label TEXT,
  button_url TEXT,
  image_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (line_account_id, event_type)
);

CREATE TABLE ec_notification_settings (
  event_type TEXT PRIMARY KEY,
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  title_override TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, intro_text TEXT, outro_text TEXT, category TEXT NOT NULL DEFAULT 'order', button_label TEXT, button_url TEXT, image_url TEXT, display_order INTEGER NOT NULL DEFAULT 100);

CREATE TABLE ec_order_lines (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES ec_orders(id) ON DELETE CASCADE,
  line_index INTEGER NOT NULL CHECK (line_index >= 0),
  external_product_id TEXT,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_amount_minor INTEGER,
  line_amount_minor INTEGER,
  product_url TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (order_id, line_index)
);

CREATE TABLE ec_orders (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  source_key TEXT NOT NULL,
  external_order_id TEXT NOT NULL,
  customer_id TEXT,
  friend_id TEXT REFERENCES friends(id) ON DELETE SET NULL,
  order_number TEXT NOT NULL,
  normalized_status TEXT NOT NULL DEFAULT 'current'
    CHECK (normalized_status IN ('current', 'refunded', 'cancelled')),
  provider_status TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'JPY',
  total_amount_minor INTEGER,
  refunded_amount_minor INTEGER,
  ordered_at TEXT NOT NULL,
  detail_url TEXT,
  last_event_id TEXT NOT NULL REFERENCES ec_events(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (line_account_id, source_key, external_order_id)
);

CREATE TABLE ec_v6_dispatches (
  event_id        TEXT NOT NULL REFERENCES ec_events(id) ON DELETE CASCADE,
  subscriber      TEXT NOT NULL CHECK (subscriber IN ('notification', 'v6')),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'failed')),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  idempotency_key TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (event_id, subscriber)
);

CREATE TABLE engagement_events (
  id                TEXT PRIMARY KEY,
  program_id        TEXT NOT NULL REFERENCES mileage_programs(id),
  idempotency_key   TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  source            TEXT NOT NULL,
  source_event_id   TEXT,
  actor_user_id     TEXT REFERENCES users(id),
  actor_friend_id   TEXT REFERENCES friends(id),
  subject_user_id   TEXT REFERENCES users(id),
  subject_friend_id TEXT REFERENCES friends(id),
  identity_provider TEXT,
  identity_subject  TEXT,
  metadata          TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  occurred_at       TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (program_id, idempotency_key)
);

CREATE TABLE entry_route_coupon_receipts (
  id TEXT PRIMARY KEY,
  entry_route_id TEXT NOT NULL REFERENCES entry_routes(id),
  asset_id TEXT NOT NULL,
  friend_id TEXT NOT NULL REFERENCES friends(id),
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'received', 'sent', 'failed', 'unknown')),
  asset_name TEXT NOT NULL,
  payload_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  received_at TEXT,
  UNIQUE (entry_route_id, friend_id)
);

CREATE TABLE entry_route_genres (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE entry_route_stop_suppressions (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  line_user_id    TEXT NOT NULL,
  friend_id       TEXT REFERENCES friends(id) ON DELETE SET NULL,
  ref_code        TEXT NOT NULL,
  source          TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE entry_routes (
  id          TEXT PRIMARY KEY,
  ref_code    TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,
  scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  redirect_url TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
, pool_id TEXT REFERENCES traffic_pools (id) ON DELETE SET NULL, intro_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL, run_account_friend_add_scenarios INTEGER NOT NULL DEFAULT 1, genre TEXT, tenant_id TEXT REFERENCES tenants(id), line_account_id TEXT REFERENCES line_accounts(id) ON DELETE CASCADE, stopped_at TEXT, stopped_reason TEXT, coupon_asset_id TEXT REFERENCES broadcast_message_assets(id) ON DELETE SET NULL, coupon_enabled INTEGER NOT NULL DEFAULT 0 CHECK (coupon_enabled IN (0, 1)), coupon_audience TEXT NOT NULL DEFAULT 'new_friends' CHECK (coupon_audience IN ('new_friends', 'all_friends')));

CREATE TABLE error_messages (
  -- エラーコード。code が無い現行 route は error 文字列そのものを鍵にする（§9-1）。
  code               TEXT PRIMARY KEY,
  -- 運用者向け文面。{incidentId} {n} {max} などの差し込みは画面側で埋める。
  message            TEXT NOT NULL,
  -- 次の行動の種類。押せるものだけを出す。
  next_action_kind   TEXT NOT NULL DEFAULT 'none'
                       CHECK (next_action_kind IN ('navigate', 'retry', 'contact_admin', 'none')),
  -- navigate の行き先（管理画面のパス）。navigate 以外は NULL。
  next_action_target TEXT,
  -- 出典（route または service）。追加するときは必ず埋める（§9-2）。
  source             TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE event_booking_entitlement_uses (
 event_booking_id TEXT UNIQUE REFERENCES event_bookings(id) ON DELETE SET NULL,
 event_booking_id_history TEXT PRIMARY KEY NOT NULL,
 line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
 event_id TEXT NOT NULL,slot_id TEXT NOT NULL,starts_at TEXT NOT NULL,
 entitlement_id TEXT NOT NULL REFERENCES booking_entitlements(id) ON DELETE RESTRICT,
 period_start TEXT NOT NULL,period_end TEXT NOT NULL CHECK(julianday(period_end)>julianday(period_start)),
 consumed_at TEXT,returned_at TEXT,makeup_credit_id TEXT REFERENCES booking_makeup_credits(id),
 operation_key TEXT NOT NULL UNIQUE,version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);

CREATE TABLE event_booking_idempotency_keys (
  key              TEXT PRIMARY KEY,
  line_account_id  TEXT NOT NULL,
  friend_id        TEXT NOT NULL,
  response_status  INTEGER NOT NULL,
  response_body    TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  expires_at       TEXT NOT NULL
);

CREATE TABLE event_booking_reminders (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('day_before','hours_before')),
  scheduled_at  TEXT NOT NULL,
  sent_at       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','failed_permanent','cancelled')),
  retry_count   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT, booking_version INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (booking_id) REFERENCES event_bookings(id)
);

CREATE TABLE event_booking_transition_runs (
 id TEXT PRIMARY KEY,
 line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
 event_id TEXT NOT NULL,
 booking_id TEXT REFERENCES event_bookings(id) ON DELETE SET NULL,
 booking_id_history TEXT NOT NULL,
 expected_booking_version INTEGER NOT NULL,
 booking_version INTEGER NOT NULL,
 event_version TEXT,
 operation_key TEXT NOT NULL UNIQUE,
 action TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','complete','obsolete','attention')),
 input_snapshot TEXT NOT NULL CHECK(json_valid(input_snapshot)),
 steps_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(steps_json)),
 before_json TEXT NOT NULL CHECK(json_valid(before_json)),
 after_json TEXT NOT NULL CHECK(json_valid(after_json)),
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(line_account_id,booking_id_history,expected_booking_version,operation_key)
);

CREATE TABLE event_bookings (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  event_id              TEXT NOT NULL,
  slot_id               TEXT NOT NULL,
  friend_id             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('requested','confirmed','rejected','cancelled','expired','no_show','attended')),
  customer_note         TEXT,
  internal_note         TEXT,
  requested_at          TEXT NOT NULL,
  decided_at            TEXT,
  decided_by_staff_id   TEXT,
  cancelled_at          TEXT,
  cancelled_by          TEXT CHECK (cancelled_by IN ('friend','admin','system')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), identity_key TEXT, party_size INTEGER NOT NULL DEFAULT 1 CHECK (party_size >= 1), answer_snapshot_json TEXT CHECK (
    answer_snapshot_json IS NULL OR json_valid(answer_snapshot_json)
  ), first_participation INTEGER CHECK (first_participation IN (0, 1)), first_participation_attended_count INTEGER CHECK (
    first_participation_attended_count IS NULL OR first_participation_attended_count >= 0
  ), first_participation_checked_at TEXT, event_version_id TEXT REFERENCES event_versions(id), event_snapshot_json TEXT CHECK (event_snapshot_json IS NULL OR json_valid(event_snapshot_json)), approval_expires_at TEXT, participation_mode TEXT NOT NULL DEFAULT 'classroom' CHECK(participation_mode IN('classroom','online')), absence_reported_at TEXT, lock_version INTEGER NOT NULL DEFAULT 1 CHECK(lock_version>0),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (slot_id) REFERENCES event_slots(id),
  FOREIGN KEY (friend_id) REFERENCES friends(id)
);

CREATE TABLE event_change_logs (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  event_id              TEXT NOT NULL,
  slot_id               TEXT,
  actor_id              TEXT,
  actor_role            TEXT,
  action                TEXT NOT NULL
    CHECK (action IN (
      'lifecycle',
      'change_review_apply',
      'waitlist_promote',
      'waitlist_reorder',
      'waitlist_skip',
      'booking_change'
    )),
  reason                TEXT,
  before_json           TEXT,
  after_json            TEXT,
  affected_confirmed    INTEGER NOT NULL DEFAULT 0,
  affected_waiting       INTEGER NOT NULL DEFAULT 0,
  affected_reminders     INTEGER NOT NULL DEFAULT 0,
  notify_planned         INTEGER NOT NULL DEFAULT 0,
  notify_sent            INTEGER NOT NULL DEFAULT 0,
  idempotency_key       TEXT,
  created_at            TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE event_occurrence_applicant_snapshots (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  occurrence_id   TEXT NOT NULL REFERENCES event_slots(id) ON DELETE CASCADE,
  staff_id        TEXT NOT NULL,
  payload_json    TEXT NOT NULL CHECK (json_valid(payload_json)),
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE event_payment_settings (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  mode TEXT CHECK(mode IS NULL OR mode IN ('none','onsite','online','customer_choice')),
  unit_price INTEGER NOT NULL DEFAULT 0 CHECK(typeof(unit_price)='integer' AND unit_price BETWEEN 0 AND 9007199254740991),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE event_slots (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL,
  starts_at   TEXT NOT NULL,
  ends_at     TEXT NOT NULL,
  capacity    INTEGER,
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1), client_key TEXT, instructor_id TEXT REFERENCES staff(id), classroom_capacity INTEGER CHECK(classroom_capacity IS NULL OR classroom_capacity>=0), online_capacity INTEGER CHECK(online_capacity IS NULL OR online_capacity>=0),
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE event_versions (
  id                       TEXT PRIMARY KEY,
  event_id                 TEXT NOT NULL,
  line_account_id          TEXT NOT NULL,
  version_number           INTEGER NOT NULL,
  snapshot_json            TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  approval_deadline_hours  INTEGER NOT NULL CHECK (approval_deadline_hours IN (2, 24, 72)),
  published_at             TEXT NOT NULL,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  UNIQUE (event_id, version_number)
);

CREATE TABLE "event_waitlist" (
  id                             TEXT PRIMARY KEY,
  line_account_id                TEXT NOT NULL,
  event_id                       TEXT NOT NULL,
  slot_id                        TEXT NOT NULL,
  friend_id                      TEXT NOT NULL,
  identity_key                   TEXT NOT NULL,
  status                         TEXT NOT NULL DEFAULT 'waiting'
                                 CHECK (status IN (
                                   'waiting', 'offered', 'accepted',
                                   'converted', 'expired', 'cancelled'
                                 )),
  party_size                     INTEGER NOT NULL DEFAULT 1 CHECK (party_size >= 1),
  answer_snapshot_json           TEXT CHECK (
                                   answer_snapshot_json IS NULL OR json_valid(answer_snapshot_json)
  ),
  first_participation            INTEGER CHECK (first_participation IN (0, 1)),
  first_participation_attended_count INTEGER CHECK (
                                   first_participation_attended_count IS NULL
                                   OR first_participation_attended_count >= 0
                                 ),
  first_participation_checked_at TEXT,
  offered_at                     TEXT,
  offer_expires_at               TEXT,
  offer_token_hash               TEXT UNIQUE,
  notified_at                    TEXT,
  version                        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at                     TEXT NOT NULL,
  updated_at                     TEXT NOT NULL, event_version_id TEXT REFERENCES event_versions(id), event_snapshot_json TEXT CHECK (event_snapshot_json IS NULL OR json_valid(event_snapshot_json)), sort_order INTEGER NOT NULL DEFAULT 0, participation_mode TEXT NOT NULL DEFAULT 'classroom' CHECK(participation_mode IN('classroom','online')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (slot_id) REFERENCES event_slots(id),
  FOREIGN KEY (friend_id) REFERENCES friends(id)
);

CREATE TABLE event_waitlist_promotion_jobs (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL,
  event_id          TEXT NOT NULL,
  slot_id           TEXT NOT NULL,
  source_key        TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'retryable_failed', 'completed')),
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at      TEXT NOT NULL,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (slot_id) REFERENCES event_slots(id)
);

CREATE TABLE events (
  id                            TEXT PRIMARY KEY,
  line_account_id               TEXT NOT NULL,
  name                          TEXT NOT NULL,
  venue_name                    TEXT,
  venue_url                     TEXT,
  image_url                     TEXT,
  description                   TEXT,
  description_centered          INTEGER NOT NULL DEFAULT 0,
  max_bookings_per_friend       INTEGER,
  requires_approval             INTEGER NOT NULL DEFAULT 0,
  cancel_deadline_hours_before  INTEGER,
  reminder_day_before_enabled   INTEGER NOT NULL DEFAULT 1,
  reminder_hours_before         INTEGER,
  is_published                  INTEGER NOT NULL DEFAULT 0,
  folder_id                     TEXT,
  sort_order                    INTEGER NOT NULL DEFAULT 0,
  deleted_at                    TEXT,
  created_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), target_type TEXT NOT NULL DEFAULT 'single'
  CHECK (target_type IN ('single', 'multi-account-dedup')), account_ids TEXT
  CHECK (account_ids IS NULL OR json_valid(account_ids)), dedup_priority TEXT
  CHECK (dedup_priority IS NULL OR json_valid(dedup_priority)), failed_account_ids TEXT
  CHECK (failed_account_ids IS NULL OR json_valid(failed_account_ids)), confirmation_message_extra TEXT, reminder_message_extra TEXT, og_title TEXT, og_description TEXT, og_image_url TEXT, visible_tag_id TEXT, waitlist_enabled INTEGER NOT NULL DEFAULT 0, entry_cutoff_hours_before INTEGER, version INTEGER NOT NULL DEFAULT 1, current_published_version_id TEXT, version_write_token TEXT, approval_deadline_hours INTEGER NOT NULL DEFAULT 24
  CHECK (approval_deadline_hours IN (2, 24, 72)), questions_json TEXT CHECK (
    questions_json IS NULL OR json_valid(questions_json)
  ), lifecycle_status TEXT NOT NULL DEFAULT 'draft'
  CHECK (lifecycle_status IN ('draft', 'published', 'paused', 'ended', 'cancelled')), lifecycle_changed_at TEXT, lifecycle_change_reason TEXT, venue_address TEXT, is_trial INTEGER NOT NULL DEFAULT 0 CHECK(is_trial IN(0,1)), makeup_rule_json TEXT NOT NULL DEFAULT '{"enabled":false,"cutoffHours":3,"validDays":30,"monthlyCap":2,"target":"same_kind","targetIds":[]}' CHECK(json_valid(makeup_rule_json)),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);

CREATE TABLE field_migration_items (
  run_id          TEXT NOT NULL REFERENCES field_migration_runs(id) ON DELETE CASCADE,
  friend_id       TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  source_value    TEXT NOT NULL,
  converted_value TEXT,
  status          TEXT NOT NULL CHECK (status IN ('convertible', 'review', 'invalid', 'succeeded', 'failed')),
  reason          TEXT,
  migrated_at     TEXT,
  PRIMARY KEY (run_id, friend_id)
);

CREATE TABLE field_migration_runs (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  line_account_id       TEXT NOT NULL REFERENCES line_accounts(id),
  source_field_id       TEXT NOT NULL REFERENCES friend_fields(id),
  target_field_id       TEXT NOT NULL REFERENCES friend_fields(id),
  source_version        INTEGER NOT NULL,
  target_version        INTEGER NOT NULL,
  preview_token_hash    TEXT NOT NULL UNIQUE,
  preview_snapshot_hash TEXT NOT NULL,
  preview_expires_at    TEXT NOT NULL,
  idempotency_key       TEXT,
  status                TEXT NOT NULL DEFAULT 'previewed'
    CHECK (status IN ('previewed', 'queued', 'running', 'partial', 'succeeded', 'failed', 'stale')),
  usage_targets_json    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(usage_targets_json)),
  total_count           INTEGER NOT NULL DEFAULT 0,
  convertible_count     INTEGER NOT NULL DEFAULT 0,
  review_count          INTEGER NOT NULL DEFAULT 0,
  invalid_count         INTEGER NOT NULL DEFAULT 0,
  processed_count       INTEGER NOT NULL DEFAULT 0,
  succeeded_count       INTEGER NOT NULL DEFAULT 0,
  failed_count          INTEGER NOT NULL DEFAULT 0,
  error_message         TEXT,
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  started_at            TEXT,
  completed_at          TEXT,
  rollback_deadline     TEXT,
  updated_at            TEXT NOT NULL
);

CREATE TABLE file_scan_configs (
  line_account_id      TEXT PRIMARY KEY REFERENCES line_accounts(id) ON DELETE CASCADE,
  external_provider    TEXT,
  external_endpoint_url TEXT,
  external_secret_ref  TEXT,
  external_timeout_ms  INTEGER NOT NULL DEFAULT 10000 CHECK (external_timeout_ms > 0),
  max_bytes_override   INTEGER CHECK (max_bytes_override IS NULL OR max_bytes_override > 0),
  max_pixels_override  INTEGER CHECK (max_pixels_override IS NULL OR max_pixels_override > 0),
  stopped_notified_at  TEXT,
  updated_by           TEXT,
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE "folders" (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN (
                  'tag','template','scenario','reminder','auto_reply',
                  'rich_menu','webinar','form','media','common_var',
                  'mileage_rule','automation','event','entry_route','broadcast',
                  'friend_field','common_action','webhook','conversion','affiliate','affiliate_offer','mileage_reward','friend_add_rule')),
  name          TEXT NOT NULL,
  parent_id     TEXT REFERENCES folders(id) ON DELETE CASCADE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  color         TEXT,
  account_id    TEXT REFERENCES line_accounts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
);

CREATE TABLE form_accounts (
  form_id         TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (form_id, line_account_id)
);

CREATE TABLE form_capacity_claims (
  form_id       TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  slot_key      TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (form_id, slot_key, submission_id)
);

CREATE TABLE form_opens (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  friend_id TEXT,
  friend_name TEXT,
  opened_at TEXT NOT NULL DEFAULT (datetime('now'))
, is_test INTEGER NOT NULL DEFAULT 0
  CHECK (is_test IN (0, 1)));

CREATE TABLE form_submission_files (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  form_id TEXT NOT NULL REFERENCES forms(id),
  form_version_id TEXT,
  block_id TEXT NOT NULL,
  friend_id TEXT NOT NULL REFERENCES friends(id),
  submission_id TEXT REFERENCES form_submissions(id),
  file_kind TEXT NOT NULL CHECK (file_kind IN ('image', 'pdf', 'identity')),
  side TEXT NOT NULL CHECK (side IN ('single', 'front', 'back')),
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  scan_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  deleted_at TEXT,
  deletion_reason TEXT
);

CREATE TABLE form_submissions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES forms (id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES friends (id) ON DELETE SET NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, destination_write_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (destination_write_status IN ('pending', 'succeeded', 'partial', 'failed', 'not_requested', 'unknown')), destination_write_attempted INTEGER, destination_write_succeeded INTEGER, destination_write_failed INTEGER, destination_write_completed_at TEXT, form_version_id TEXT REFERENCES form_versions(id), is_test INTEGER NOT NULL DEFAULT 0
  CHECK (is_test IN (0, 1)));

CREATE TABLE form_submit_claims (
  tenant_id TEXT NOT NULL DEFAULT '',
  line_account_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'failed', 'completed')),
  steps TEXT NOT NULL DEFAULT '[]',
  webhook TEXT,
  submission_id TEXT,
  owner TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  lease_generation INTEGER NOT NULL DEFAULT 1,
  effect_stats TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, step_completed_at_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(step_completed_at_json) AND json_type(step_completed_at_json) = 'object'),
  PRIMARY KEY (tenant_id, line_account_id, form_id, friend_id, idempotency_key)
);

CREATE TABLE form_submit_outbox (
  tenant_id TEXT NOT NULL DEFAULT '',
  line_account_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed')),
  payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, line_account_id, form_id, friend_id, idempotency_key, kind)
);

CREATE TABLE form_test_tokens (
  id                  TEXT PRIMARY KEY,
  form_id             TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  token_hash          TEXT NOT NULL UNIQUE,
  created_by_staff_id TEXT,
  expires_at          TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
);

CREATE TABLE form_versions (
  id                             TEXT PRIMARY KEY,
  form_id                        TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  version_number                 INTEGER NOT NULL CHECK (version_number >= 1),
  source_content_revision        INTEGER NOT NULL CHECK (source_content_revision >= 1),
  name                           TEXT NOT NULL,
  description                    TEXT,
  fields                         TEXT NOT NULL DEFAULT '[]',
  layout                         TEXT,
  on_submit_tag_id               TEXT,
  on_submit_scenario_id          TEXT,
  on_submit_message_type         TEXT CHECK (on_submit_message_type IN ('text', 'flex')),
  on_submit_message_content      TEXT,
  on_submit_webhook_url          TEXT,
  on_submit_webhook_headers      TEXT,
  on_submit_webhook_fail_message TEXT,
  save_to_metadata               INTEGER NOT NULL CHECK (save_to_metadata IN (0, 1)),
  og_title                       TEXT,
  og_description                 TEXT,
  og_image_url                   TEXT,
  status                         TEXT NOT NULL DEFAULT 'published' CHECK (status = 'published'),
  published_at                   TEXT NOT NULL,
  created_at                     TEXT NOT NULL,
  UNIQUE (form_id, version_number),
  UNIQUE (form_id, source_content_revision)
);

CREATE TABLE forms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  fields TEXT NOT NULL DEFAULT '[]',
  on_submit_tag_id TEXT REFERENCES tags (id) ON DELETE SET NULL,
  on_submit_scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  save_to_metadata INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  submit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, on_submit_message_type TEXT CHECK (on_submit_message_type IN ('text', 'flex')) DEFAULT NULL, on_submit_message_content TEXT DEFAULT NULL, on_submit_webhook_url TEXT, on_submit_webhook_headers TEXT, on_submit_webhook_fail_message TEXT, og_title TEXT, og_description TEXT, og_image_url TEXT, layout TEXT, status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'archived')), archived_at TEXT, revision INTEGER NOT NULL DEFAULT 1
  CHECK (revision >= 1), content_revision INTEGER NOT NULL DEFAULT 1
  CHECK (content_revision >= 1), current_published_version_id TEXT, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL);

CREATE TABLE "friend_add_action_runs" (
  id                  TEXT PRIMARY KEY,
  event_id            TEXT NOT NULL REFERENCES "friend_add_events"(id) ON DELETE CASCADE,
  action_stable_id    TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at       TEXT,
  last_error_code     TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), action_type TEXT NOT NULL DEFAULT 'unknown', action_snapshot TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(action_snapshot)), started_at TEXT, completed_at TEXT,
  UNIQUE (event_id, action_stable_id)
);

CREATE TABLE friend_add_attribution_candidates (
  id                   TEXT PRIMARY KEY,
  line_account_id      TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_id            TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  ref_code             TEXT NOT NULL,
  entry_route_id       TEXT REFERENCES entry_routes(id) ON DELETE SET NULL,
  source               TEXT NOT NULL CHECK (source IN ('line_login', 'liff', 'short_link')),
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'consumed', 'expired', 'late')),
  occurred_at          TEXT NOT NULL,
  consumed_by_event_id TEXT,
  expires_at           TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE "friend_add_events" (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_id             TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  webhook_event_id      TEXT NOT NULL,
  friend_kind           TEXT NOT NULL CHECK (friend_kind IN ('first_time', 'returning')),
  is_unblocked_hint     INTEGER CHECK (is_unblocked_hint IS NULL OR is_unblocked_hint IN (0, 1)),
  attribution_status    TEXT NOT NULL DEFAULT 'unavailable'
                          CHECK (attribution_status IN ('captured', 'unavailable')),
  ref_code              TEXT,
  entry_route_id        TEXT REFERENCES entry_routes(id) ON DELETE SET NULL,
  candidate_id          TEXT REFERENCES friend_add_attribution_candidates(id) ON DELETE SET NULL,
  routing_rule_id       TEXT,
  routing_status        TEXT NOT NULL DEFAULT 'pending'
                          CHECK (routing_status IN ('pending', 'completed', 'failed', 'suppressed', 'partial_failed')),
  occurred_at           TEXT NOT NULL,
  processed_at          TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  winning_rule_version_id TEXT,
  error_code            TEXT,
  scenario_enrollment_id TEXT REFERENCES friend_scenarios(id) ON DELETE SET NULL,
  delivery_count        INTEGER NOT NULL DEFAULT 0
                          CHECK (delivery_count >= 0),
  first_delivery_sent_at TEXT, action_base_status TEXT
  CHECK (action_base_status IS NULL OR action_base_status IN ('pending', 'completed', 'failed', 'suppressed', 'partial_failed')), action_base_error_code TEXT,
  UNIQUE (line_account_id, webhook_event_id)
);

CREATE TABLE friend_add_routing_versions (
  id                         TEXT PRIMARY KEY,
  line_account_id            TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  version_number             INTEGER NOT NULL,
  definition_snapshot        TEXT NOT NULL CHECK (json_valid(definition_snapshot)),
  status                     TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  last_test_status           TEXT CHECK (last_test_status IN ('succeeded', 'failed')),
  last_tested_at             TEXT,
  last_tested_by_staff_id    TEXT,
  published_at               TEXT,
  published_by_staff_id      TEXT,
  publish_idempotency_key    TEXT,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (line_account_id, version_number),
  UNIQUE (line_account_id, publish_idempotency_key)
);

CREATE TABLE friend_add_rule_folders (
  id                      TEXT PRIMARY KEY,
  line_account_id         TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  create_idempotency_key  TEXT NOT NULL,
  created_by_staff_id     TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL, color TEXT
  CHECK (color IS NULL OR (typeof(color) = 'text' AND length(color) = 7 AND color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]')),
  UNIQUE (line_account_id, name),
  UNIQUE (line_account_id, create_idempotency_key)
);

CREATE TABLE friend_add_rule_versions (
  id                       TEXT PRIMARY KEY,
  rule_id                  TEXT NOT NULL REFERENCES friend_add_rules(id) ON DELETE CASCADE,
  version_number           INTEGER NOT NULL,
  definition_snapshot      TEXT NOT NULL CHECK (json_valid(definition_snapshot)),
  status                   TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  last_test_status         TEXT CHECK (last_test_status IN ('succeeded', 'failed')),
  last_tested_at           TEXT,
  last_tested_by_staff_id  TEXT,
  draft_save_idempotency_key TEXT,
  published_at             TEXT,
  published_by_staff_id    TEXT,
  publish_idempotency_key  TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (rule_id, version_number),
  UNIQUE (rule_id, draft_save_idempotency_key),
  UNIQUE (rule_id, publish_idempotency_key)
);

CREATE TABLE friend_add_rules (
  id                         TEXT PRIMARY KEY,
  line_account_id            TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_kind                TEXT NOT NULL CHECK (friend_kind IN ('first_time', 'returning')),
  name                       TEXT NOT NULL,
  folder_name                TEXT,
  priority                   INTEGER NOT NULL CHECK (priority > 0),
  is_unknown_route_fallback  INTEGER NOT NULL DEFAULT 0
                               CHECK (is_unknown_route_fallback IN (0, 1)),
  status                     TEXT NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft', 'published', 'stopped', 'archived')),
  current_version_id         TEXT,
  create_idempotency_key     TEXT,
  archived_at                TEXT,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, lock_version INTEGER NOT NULL DEFAULT 1
  CHECK (lock_version > 0), stop_idempotency_key TEXT, stopped_at TEXT, stopped_by_staff_id TEXT, created_from_recipe_id TEXT REFERENCES recipes(id), recipe_clone_run_id TEXT REFERENCES recipe_clone_runs(id), folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL);

CREATE TABLE friend_add_send_claims (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_id       TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  event_id        TEXT NOT NULL,
  generation      INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  claimed_at      TEXT NOT NULL,
  dispatched_at   TEXT,
  PRIMARY KEY (line_account_id, friend_id)
);

CREATE TABLE friend_bulk_message_approval_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES friend_bulk_runs(id),
  actor_staff_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('requested', 'approved', 'confirmed', 'expired')),
  created_at TEXT NOT NULL
);

CREATE TABLE friend_bulk_message_approvals (
  run_id TEXT PRIMARY KEY REFERENCES friend_bulk_runs(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'confirmed', 'expired')),
  recipient_count INTEGER NOT NULL,
  threshold INTEGER NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  confirmed_count INTEGER
);

CREATE TABLE friend_bulk_run_items (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES friend_bulk_runs(id) ON DELETE CASCADE,
  friend_id         TEXT NOT NULL REFERENCES friends(id) ON DELETE RESTRICT,
  line_account_id   TEXT,
  ordinal           INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','running','waiting','success','skipped','temporary_failure','permanent_failure')),
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  idempotency_key   TEXT NOT NULL,
  before_json       TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json        TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  error_code        TEXT,
  error_message     TEXT,
  retry_at          TEXT,
  lease_expires_at  TEXT,
  started_at        TEXT,
  completed_at      TEXT,
  updated_at        TEXT NOT NULL,
  UNIQUE (run_id, friend_id),
  UNIQUE (idempotency_key)
);

CREATE TABLE friend_bulk_runs (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  created_by               TEXT NOT NULL,
  selection_json           TEXT NOT NULL CHECK (json_valid(selection_json)),
  operation_json           TEXT NOT NULL CHECK (json_valid(operation_json)),
  execution_plan_json      TEXT CHECK (execution_plan_json IS NULL OR json_valid(execution_plan_json)),
  status                   TEXT NOT NULL DEFAULT 'preparing'
                             CHECK (status IN ('preparing','queued','running','waiting','success','partial','failed','cancelled')),
  target_count             INTEGER NOT NULL DEFAULT 0,
  excluded_count           INTEGER NOT NULL DEFAULT 0,
  success_count            INTEGER NOT NULL DEFAULT 0,
  skipped_count            INTEGER NOT NULL DEFAULT 0,
  temporary_failure_count  INTEGER NOT NULL DEFAULT 0,
  permanent_failure_count  INTEGER NOT NULL DEFAULT 0,
  reversible               INTEGER NOT NULL DEFAULT 0 CHECK (reversible IN (0,1)),
  idempotency_key          TEXT NOT NULL,
  scheduled_at             TEXT,
  undo_of_run_id           TEXT REFERENCES friend_bulk_runs(id),
  error_message            TEXT,
  created_at               TEXT NOT NULL,
  started_at               TEXT,
  completed_at             TEXT,
  updated_at               TEXT NOT NULL,
  UNIQUE (tenant_id, created_by, idempotency_key)
);

CREATE TABLE friend_daily_snapshots (
  -- JST の日付（YYYY-MM-DD）。LINEアカウントごとに1行。
  date              TEXT NOT NULL,
  -- どのLINEアカウントぶんか。全体の合計は line_account_id = '' で持つ。
  -- NULL にすると主キーに使えない（SQLite は NULL 同士を別物として扱う）。
  line_account_id   TEXT NOT NULL DEFAULT '',

  -- その日の終わりの状態。
  active            INTEGER NOT NULL DEFAULT 0,
  total             INTEGER NOT NULL DEFAULT 0,
  blocked_by_them   INTEGER NOT NULL DEFAULT 0,
  hidden_by_us      INTEGER NOT NULL DEFAULT 0,

  -- その日に増えた／減った数。差分は active の引き算でも出せるが、
  -- 記録が飛んだ日があると引き算が壊れるので、その日の実数も持つ。
  added             INTEGER NOT NULL DEFAULT 0,
  blocked           INTEGER NOT NULL DEFAULT 0,

  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),

  PRIMARY KEY (date, line_account_id)
);

CREATE TABLE friend_delivery_consent_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 line_account_id TEXT NOT NULL, friend_id TEXT NOT NULL, purpose TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('insert','update','delete')),
 before_json TEXT, after_json TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE friend_delivery_consents (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(length(purpose) BETWEEN 1 AND 80),
  state TEXT NOT NULL CHECK(state IN ('granted','unknown','revoked')),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
  source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 100),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  PRIMARY KEY(line_account_id,friend_id,purpose)
);

CREATE TABLE friend_export_jobs (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  filter_json TEXT NOT NULL CHECK (json_valid(filter_json)),
  columns_json TEXT NOT NULL CHECK (json_valid(columns_json)),
  encoding TEXT NOT NULL CHECK (encoding IN ('utf-8','shift_jis')),
  status TEXT NOT NULL CHECK (status IN ('completed','failed','expired')),
  row_count INTEGER CHECK (row_count IS NULL OR row_count >= 0),
  created_by TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  failure_reason TEXT
);

CREATE TABLE friend_field_create_requests (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL REFERENCES line_accounts(id),
  idempotency_key   TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  field_id          TEXT NOT NULL REFERENCES friend_fields(id),
  response_json     TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at        TEXT NOT NULL,
  UNIQUE(line_account_id, idempotency_key)
);

CREATE TABLE friend_field_reminder_scan_states (
  reminder_id TEXT PRIMARY KEY REFERENCES reminders(id) ON DELETE CASCADE,
  cursor      TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE friend_field_scopes (
  field_id         TEXT PRIMARY KEY REFERENCES friend_fields(id) ON DELETE CASCADE,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  line_account_id  TEXT REFERENCES line_accounts(id),
  created_at       TEXT NOT NULL
);

CREATE TABLE friend_field_values (
  friend_id   TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  field_id    TEXT NOT NULL REFERENCES friend_fields(id) ON DELETE CASCADE,
  value       TEXT,
  -- staff.id / 'form' / 'ec' / 'automation'。誰が入れた値かで扱いが変わる。
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')), value_text TEXT, value_number REAL, value_date TEXT, value_datetime TEXT, value_json TEXT
  CHECK (value_json IS NULL OR json_valid(value_json)), media_id TEXT REFERENCES media(id) ON DELETE SET NULL, source_type TEXT, source_id TEXT, version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (friend_id, field_id)
);

CREATE TABLE friend_fields (
  id             TEXT PRIMARY KEY,
  folder_id      TEXT REFERENCES folders(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  -- 差し込み変数名。{pet_name} のように使うので、日本語・記号は入れない。
  -- 形の検証はAPI側（^[a-z][a-z0-9_]{0,31}$）。
  field_key      TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL CHECK (type IN (
                   'text','textarea','number','date','select',
                   'multi_select','checkbox','url','tel','email')),
  options_json   TEXT CHECK (options_json IS NULL OR json_valid(options_json)),
  default_value  TEXT,
  source         TEXT NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('manual','form','ec','automation')),
  -- EC連携時のマッピング元。ec_is_master が1なら EC 側を正とし、
  -- 管理画面からは書き換えさせない。
  ec_field_path  TEXT,
  ec_is_master   INTEGER NOT NULL DEFAULT 0,
  -- 本名・電話・住所など。閲覧を役割で絞り、開いたら記録を残す。
  is_personal    INTEGER NOT NULL DEFAULT 0,
  is_starred     INTEGER NOT NULL DEFAULT 0,
  display_order  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
, status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'read_only', 'archived')), version INTEGER NOT NULL DEFAULT 1, type_v6 TEXT
  CHECK (type_v6 IS NULL OR type_v6 IN (
    'text','textarea','number','date','datetime','tel','email','url',
    'select','multi_select','checkbox','image','pdf'
  )), type_v8 TEXT
  CHECK (type_v8 IS NULL OR type_v8 = 'time'));

CREATE TABLE "friend_fixed_fields" (
 fixed_key TEXT PRIMARY KEY CHECK(fixed_key IN('name','kana','birthday','age','email','tel','address','allergy','anniversary','seat_preference')),
 field_id TEXT NOT NULL UNIQUE REFERENCES friend_fields(id) ON DELETE RESTRICT
);

CREATE TABLE friend_identity_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL REFERENCES identity_candidates(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE RESTRICT,
  link_method TEXT NOT NULL,
  evidence_snapshot_json TEXT NOT NULL CHECK (json_valid(evidence_snapshot_json)),
  confidence_score INTEGER NOT NULL CHECK (confidence_score BETWEEN 0 AND 100),
  linked_by TEXT,
  linked_at TEXT NOT NULL,
  unlinked_by TEXT,
  unlinked_at TEXT,
  unlink_reason TEXT
);

CREATE TABLE friend_import_jobs (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  source_filename TEXT NOT NULL,
  source_checksum TEXT NOT NULL,
  rows_json TEXT NOT NULL CHECK (json_valid(rows_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  status TEXT NOT NULL CHECK (status IN ('previewed','completed','failed')),
  total_count INTEGER NOT NULL CHECK (total_count >= 0),
  add_count INTEGER NOT NULL DEFAULT 0 CHECK (add_count >= 0),
  update_count INTEGER NOT NULL DEFAULT 0 CHECK (update_count >= 0),
  unchanged_count INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  conflict_count INTEGER NOT NULL DEFAULT 0 CHECK (conflict_count >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  created_by TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  executed_at TEXT,
  failure_reason TEXT,
  UNIQUE(line_account_id, source_checksum)
);

CREATE TABLE friend_reminder_deliveries (
  id                TEXT PRIMARY KEY,
  friend_reminder_id TEXT NOT NULL REFERENCES friend_reminders (id) ON DELETE CASCADE,
  reminder_step_id  TEXT NOT NULL REFERENCES reminder_steps (id) ON DELETE CASCADE,
  delivered_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (friend_reminder_id, reminder_step_id)
);

CREATE TABLE friend_reminders (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  reminder_id     TEXT NOT NULL REFERENCES reminders (id) ON DELETE CASCADE,
  target_date     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, reminder_version_id TEXT REFERENCES reminder_versions(id), source_kind TEXT NOT NULL DEFAULT 'manual', source_id TEXT, source_event_id TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo', cancel_reason TEXT, completed_at TEXT, lock_version INTEGER NOT NULL DEFAULT 0, template_version_snapshot TEXT);

CREATE TABLE friend_scenario_op_keys (
  op_idempotency_key TEXT PRIMARY KEY,
  friend_scenario_id TEXT NOT NULL,
  op TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
, request_fingerprint TEXT);

CREATE TABLE "friend_scenarios" (
  id                 TEXT PRIMARY KEY,
  friend_id          TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  scenario_id        TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
  current_step_order INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'delivering')) DEFAULT 'active',
  started_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  next_delivery_at   TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, previous_scenario_id TEXT, published_version_id TEXT REFERENCES scenario_versions (id), pause_reason TEXT);

CREATE TABLE friend_scores (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  scoring_rule_id TEXT REFERENCES scoring_rules (id) ON DELETE SET NULL,
  score_change    INTEGER NOT NULL,
  reason          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT REFERENCES line_accounts(id), event_type TEXT, source TEXT, source_event_id TEXT, subject_key TEXT, frequency_key TEXT, rule_key TEXT, rule_version_id TEXT REFERENCES action_score_rule_versions(id), idempotency_key TEXT, operation TEXT
  CHECK (operation IS NULL OR operation IN ('delta', 'set', 'manual_adjustment')), score_before INTEGER, score_after INTEGER, occurred_at TEXT, executed_by_staff_id TEXT, executed_by_staff_name TEXT);

CREATE TABLE friend_tag_side_effect_runs (
  friend_id       TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  tag_id          TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  step_key        TEXT NOT NULL
                    CHECK (step_key IN ('mileage', 'scenario_enroll', 'event_tag_change')),
  assigned_at     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'failed', 'completed')),
  attempt_count   INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error      TEXT,
  last_attempt_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (friend_id, tag_id, step_key)
);

CREATE TABLE friend_tags (
  friend_id   TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (friend_id, tag_id)
);

CREATE TABLE friends (
  id               TEXT PRIMARY KEY,
  line_user_id     TEXT UNIQUE NOT NULL,
  display_name     TEXT,
  picture_url      TEXT,
  status_message   TEXT,
  is_following     INTEGER NOT NULL DEFAULT 1,
  user_id          TEXT,
  ig_igsid         TEXT,
  score            INTEGER NOT NULL DEFAULT 0,
  last_ref_code    TEXT,
  last_ref_at      TEXT,
  first_followed_at TEXT,
  current_follow_started_at TEXT,
  last_followed_at TEXT,
  last_unfollowed_at TEXT,
  unfollow_count   INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, ref_code TEXT, metadata TEXT NOT NULL DEFAULT '{}', line_account_id TEXT REFERENCES line_accounts(id), first_tracked_link_id TEXT REFERENCES tracked_links (id) ON DELETE SET NULL, support_mark_id TEXT REFERENCES support_marks(id) ON DELETE SET NULL, is_hidden INTEGER NOT NULL DEFAULT 0, real_name TEXT, system_display_name TEXT, private_memo TEXT, photo_watch_required INTEGER NOT NULL DEFAULT 0, member_number TEXT);

CREATE TABLE funnel_steps (
  id         TEXT PRIMARY KEY,
  funnel_id  TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  label      TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN (
               'tag','field','form','site_event','purchase','link_click','conversion')),
  match_json TEXT NOT NULL CHECK (json_valid(match_json)),
  UNIQUE (funnel_id, step_order)
);

CREATE TABLE funnels (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  segment_json TEXT CHECK (segment_json IS NULL OR json_valid(segment_json)),
  -- 何日以内に次の段へ進んだものを数えるか。
  window_days  INTEGER NOT NULL DEFAULT 30,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
, line_account_id TEXT REFERENCES line_accounts(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'stopped', 'archived')));

CREATE TABLE google_calendar_connections (
  id            TEXT PRIMARY KEY,
  calendar_id   TEXT NOT NULL,
  line_account_id TEXT,
  staff_id      TEXT,
  access_token  TEXT,
  refresh_token TEXT,
  api_key       TEXT,
  auth_type     TEXT NOT NULL DEFAULT 'api_key',
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_verified_at TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE google_sheets_integrations (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL UNIQUE REFERENCES line_accounts(id) ON DELETE CASCADE,
  tenant_id TEXT,
  google_account_email TEXT,
  refresh_token_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_target'
    CHECK (status IN ('pending_target', 'connected', 'expired')),
  spreadsheet_id TEXT,
  spreadsheet_title TEXT,
  -- データ種別ごとの再開点。{"friends": {"after": "...", "lastId": "..."}} の形。
  -- 途中で止まった同期が前回の続きから書き直すためのもの。
  sync_cursor_json TEXT NOT NULL DEFAULT '{}',
  last_synced_at TEXT,
  last_sync_status TEXT
    CHECK (last_sync_status IN ('ok', 'partial', 'error') OR last_sync_status IS NULL),
  last_sync_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  connected_by_staff_id TEXT,
  connected_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE google_sheets_oauth_states (
  state TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  staff_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('connect', 'reconnect')),
  code_verifier_enc TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE google_sheets_sync_runs (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES google_sheets_integrations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'scheduled')),
  data_type TEXT NOT NULL CHECK (data_type IN ('friends', 'form_answers')),
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'error')),
  rows_written INTEGER NOT NULL DEFAULT 0 CHECK (rows_written >= 0),
  cursor_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, run_date TEXT, spreadsheet_id TEXT);

CREATE TABLE hq_banner_folders (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
 kind TEXT NOT NULL CHECK(kind IN ('project','image')), name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 color TEXT CHECK(color IS NULL OR (typeof(color)='text' AND length(color)=7 AND color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]')), display_order INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 archived_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE hq_broadcast_audit (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES hq_broadcast_runs(id), line_account_id TEXT NOT NULL,
 actor_id TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT(datetime('now'))
);

CREATE TABLE hq_broadcast_folders (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, archived_at TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, color TEXT
  CHECK (color IS NULL OR (typeof(color) = 'text' AND length(color) = 7 AND color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]')), display_order INTEGER NOT NULL DEFAULT 0);

CREATE TABLE hq_broadcast_runs (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), request_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 input_json TEXT NOT NULL CHECK(json_valid(input_json)), status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','scheduled','stopped','cancelled')),
 version INTEGER NOT NULL DEFAULT 1, scheduled_at TEXT, dispatch_token TEXT,
 created_at TEXT NOT NULL DEFAULT(datetime('now')), updated_at TEXT NOT NULL DEFAULT(datetime('now')), approval_json TEXT CHECK(approval_json IS NULL OR json_valid(approval_json)), UNIQUE(tenant_id,request_id)
);

CREATE TABLE hq_broadcast_saved_views (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  staff_id TEXT NOT NULL REFERENCES staff_members(id),
  scope TEXT NOT NULL DEFAULT 'hq' CHECK(scope IN ('private','hq')),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  conditions_json TEXT NOT NULL CHECK(json_valid(conditions_json) AND json_type(conditions_json)='object'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at TEXT
);

CREATE TABLE hq_broadcast_targets (
 run_id TEXT NOT NULL REFERENCES hq_broadcast_runs(id), line_account_id TEXT NOT NULL,
 account_name TEXT NOT NULL, tag_id TEXT, excluded INTEGER NOT NULL DEFAULT 0 CHECK(excluded IN (0,1)),
 broadcast_id TEXT UNIQUE, preflight_json TEXT CHECK(preflight_json IS NULL OR json_valid(preflight_json)),
 PRIMARY KEY(run_id,line_account_id)
);

CREATE TABLE hq_form_test_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  template_id TEXT NOT NULL,
  template_version_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  created_by_staff_id TEXT NOT NULL REFERENCES staff_members(id),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(template_id,tenant_id) REFERENCES hq_templates(id,tenant_id),
  FOREIGN KEY(template_version_id,template_id,tenant_id) REFERENCES hq_template_versions(id,template_id,tenant_id)
);

CREATE TABLE hq_store_comparison_export_jobs (
 id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),requested_by TEXT NOT NULL REFERENCES staff_members(id),
 request_key TEXT NOT NULL,filters_json TEXT NOT NULL CHECK(json_valid(filters_json)),account_ids_json TEXT NOT NULL CHECK(json_valid(account_ids_json)),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','completed','failed')),csv_text TEXT,row_count INTEGER,error_code TEXT,
 created_at TEXT NOT NULL,expires_at TEXT NOT NULL,completed_at TEXT,UNIQUE(tenant_id,requested_by,request_key)
);

CREATE TABLE hq_store_daily_metrics (
 account_id TEXT NOT NULL REFERENCES line_accounts(id),date TEXT NOT NULL,
 friends_added INTEGER,friends_blocked INTEGER,friends_at_start INTEGER,broadcast_recipients INTEGER,broadcast_clicks INTEGER,
 bookings INTEGER,visits INTEGER,no_shows INTEGER,first_response_median_minutes REAL,first_response_count INTEGER,
 state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN('ready','partial','failed')),computed_at TEXT NOT NULL,
 PRIMARY KEY(account_id,date)
);

CREATE TABLE hq_store_response_samples (
 account_id TEXT NOT NULL REFERENCES line_accounts(id),chat_id TEXT NOT NULL REFERENCES chats(id),
 pending_since TEXT NOT NULL,responded_at TEXT NOT NULL,minutes REAL NOT NULL CHECK(minutes>=0),
 PRIMARY KEY(account_id,chat_id,pending_since)
);

CREATE TABLE hq_support_messages (
  id               TEXT PRIMARY KEY,
  request_id       TEXT NOT NULL REFERENCES hq_support_requests(id) ON DELETE CASCADE,
  author_kind      TEXT NOT NULL CHECK (author_kind IN ('tenant', 'ops')),
  author_staff_id  TEXT,
  author_name      TEXT NOT NULL DEFAULT '',
  body             TEXT NOT NULL,
  attachment_keys  TEXT NOT NULL DEFAULT '[]',
  -- AI の下書きをそのまま／直して送ったか（品質の振り返り用）
  ai_assisted      INTEGER NOT NULL DEFAULT 0,
  -- 統括へ届けた手段の記録（JSON 配列: email / screen / line）
  delivered_via    TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE hq_support_reply_drafts (
  request_id       TEXT PRIMARY KEY REFERENCES hq_support_requests(id) ON DELETE CASCADE,
  body             TEXT NOT NULL,
  ai_generated     INTEGER NOT NULL DEFAULT 0,
  generated_at     TEXT,
  author_staff_id  TEXT,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, knowledge_references TEXT NOT NULL DEFAULT '[]');

CREATE TABLE hq_support_requests (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  staff_id         TEXT,
  staff_name       TEXT NOT NULL DEFAULT '',
  staff_email      TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('usage', 'bug', 'billing', 'feature', 'other')),
  subject          TEXT NOT NULL,
  body             TEXT NOT NULL,
  line_account_id  TEXT REFERENCES line_accounts(id) ON DELETE SET NULL,
  -- 添付した画像の R2 キー（JSON 配列）。実体は IMAGES バケットの support/ 配下。
  attachment_keys  TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  notified_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, ticket_no INTEGER, stage TEXT NOT NULL DEFAULT 'new'
  CHECK (stage IN ('new', 'in_progress', 'waiting', 'resolved', 'closed')), priority TEXT NOT NULL DEFAULT 'medium'
  CHECK (priority IN ('low', 'medium', 'high')), channel TEXT NOT NULL DEFAULT 'admin'
  CHECK (channel IN ('admin', 'line', 'ops')), subject_auto INTEGER NOT NULL DEFAULT 0, assignee_staff_id TEXT, first_replied_at TEXT, last_message_at TEXT, resolved_at TEXT, closed_at TEXT, knowledge_revision INTEGER NOT NULL DEFAULT 0);

CREATE TABLE hq_template_distribution_results (
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  preflight_id TEXT NOT NULL,
  idempotency_fingerprint TEXT NOT NULL,
  snapshot_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'staged', 'succeeded', 'failed', 'version_conflict', 'unsupported')),
  error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT, created_name TEXT,
  PRIMARY KEY (run_id, tenant_id, target_account_id),
  UNIQUE (tenant_id, target_account_id, idempotency_fingerprint),
  UNIQUE (preflight_id, tenant_id),
  FOREIGN KEY (run_id, tenant_id, template_id, template_version_id)
    REFERENCES hq_template_distribution_runs(id, tenant_id, template_id, template_version_id)
    ON DELETE CASCADE,
  FOREIGN KEY (
    preflight_id, tenant_id, template_id, template_version_id, target_account_id,
    idempotency_fingerprint, snapshot_token
  ) REFERENCES hq_template_preflights(
    id, tenant_id, template_id, template_version_id, target_account_id,
    idempotency_fingerprint, snapshot_token
  )
);

CREATE TABLE hq_template_distribution_runs (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version_id TEXT NOT NULL,
  idempotency_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  PRIMARY KEY (id, tenant_id),
  UNIQUE (tenant_id, idempotency_fingerprint),
  UNIQUE (id, tenant_id, template_id, template_version_id),
  FOREIGN KEY (template_id, tenant_id)
    REFERENCES hq_templates(id, tenant_id),
  FOREIGN KEY (template_version_id, template_id, tenant_id)
    REFERENCES hq_template_versions(id, template_id, tenant_id)
);

CREATE TABLE hq_template_folders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  revision INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), color TEXT
  CHECK (color IS NULL OR (typeof(color) = 'text' AND length(color) = 7 AND color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]')), display_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(id, tenant_id)
);

CREATE TABLE hq_template_owned_r2_keys (
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staged', 'committed', 'cleanup_pending', 'cleaned', 'reconciled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (run_id, tenant_id, target_account_id, object_key),
  FOREIGN KEY (run_id, tenant_id, target_account_id)
    REFERENCES hq_template_distribution_results(run_id, tenant_id, target_account_id)
    ON DELETE CASCADE
);

CREATE TABLE hq_template_preflight_resolutions (
  preflight_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  idempotency_fingerprint TEXT NOT NULL,
  snapshot_token TEXT NOT NULL,
  source_id TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  resolution_mode TEXT NOT NULL CHECK (resolution_mode IN ('create', 'overwrite', 'alias')),
  target_id TEXT,
  alias_name TEXT,
  expected_revision TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), friend_attribute_mode TEXT
  CHECK (friend_attribute_mode IS NULL OR (friend_attribute_mode='skip' AND resolution_mode='overwrite' AND NOT (target_id IS NULL))),
  PRIMARY KEY (preflight_id, tenant_id, source_id),
  CHECK (resolution_mode != 'overwrite' OR (target_id IS NOT NULL AND expected_revision IS NOT NULL)),
  CHECK (resolution_mode != 'alias' OR alias_name IS NOT NULL),
  FOREIGN KEY (
    preflight_id, tenant_id, template_id, template_version_id, target_account_id,
    idempotency_fingerprint, snapshot_token
  ) REFERENCES hq_template_preflights(
    id, tenant_id, template_id, template_version_id, target_account_id,
    idempotency_fingerprint, snapshot_token
  ) ON DELETE CASCADE
);

CREATE TABLE hq_template_preflights (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  distribution_mode TEXT NOT NULL CHECK (distribution_mode IN ('create', 'overwrite', 'alias')),
  idempotency_fingerprint TEXT NOT NULL,
  snapshot_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'blocked', 'expired', 'consumed')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT, text_override TEXT
  CHECK (text_override IS NULL OR length(trim(text_override)) BETWEEN 1 AND 5000), initial_insert INTEGER NOT NULL DEFAULT 0 CHECK(initial_insert IN (0,1)),
  PRIMARY KEY (id, tenant_id),
  UNIQUE (tenant_id, target_account_id, idempotency_fingerprint),
  UNIQUE (
    id, tenant_id, template_id, template_version_id, target_account_id,
    idempotency_fingerprint, snapshot_token
  ),
  FOREIGN KEY (template_id, tenant_id)
    REFERENCES hq_templates(id, tenant_id),
  FOREIGN KEY (template_version_id, template_id, tenant_id)
    REFERENCES hq_template_versions(id, template_id, tenant_id)
);

CREATE TABLE hq_template_saved_views (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  owner_staff_id TEXT NOT NULL REFERENCES staff_members(id),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  filters_json TEXT NOT NULL CHECK(json_valid(filters_json)),
  scope TEXT NOT NULL CHECK(scope IN ('personal','tenant')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE hq_template_versions (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  definition_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (id, tenant_id),
  UNIQUE (template_id, tenant_id, version),
  UNIQUE (id, template_id, tenant_id),
  FOREIGN KEY (template_id, tenant_id)
    REFERENCES hq_templates(id, tenant_id)
);

CREATE TABLE hq_templates (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  template_type TEXT NOT NULL CHECK (template_type IN ('tag', 'template', 'rich_menu', 'form')),
  name TEXT NOT NULL,
  description TEXT,
  current_version_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at TEXT, folder_id TEXT, extended_type TEXT CHECK (extended_type IS NULL OR extended_type='scenario'), friend_attribute_type TEXT
  CHECK (friend_attribute_type IS NULL OR friend_attribute_type IN ('friend_field','mark')), delivery_type TEXT
  CHECK (delivery_type IS NULL OR delivery_type IN ('auto_reply','friend_add_rule','reminder')), catalog_type TEXT
  CHECK (catalog_type IS NULL OR catalog_type IN ('booking_menu','mileage_reward')),
  PRIMARY KEY (id, tenant_id),
  FOREIGN KEY (current_version_id, id, tenant_id)
    REFERENCES hq_template_versions(id, template_id, tenant_id)
);

CREATE TABLE identity_candidate_decisions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES identity_candidates(id) ON DELETE RESTRICT,
  candidate_version INTEGER NOT NULL CHECK (candidate_version >= 2),
  from_status TEXT NOT NULL
    CHECK (from_status IN ('pending', 'linked', 'different', 'deferred', 'invalidated')),
  to_status TEXT NOT NULL
    CHECK (to_status IN ('pending', 'linked', 'different', 'deferred', 'invalidated')),
  actor_staff_id TEXT,
  actor_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  impact_snapshot_json TEXT NOT NULL CHECK (json_valid(impact_snapshot_json)),
  reprocess_scope_json TEXT CHECK (reprocess_scope_json IS NULL OR json_valid(reprocess_scope_json)),
  decided_at TEXT NOT NULL,
  UNIQUE(candidate_id, candidate_version)
);

CREATE TABLE identity_candidates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('friend_duplicate', 'ec_member')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'linked', 'different', 'deferred', 'invalidated')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  confidence_score INTEGER NOT NULL CHECK (confidence_score BETWEEN 0 AND 100),
  detector_version TEXT NOT NULL,
  left_subject_kind TEXT NOT NULL CHECK (left_subject_kind IN ('friend', 'ec_event')),
  left_subject_id TEXT NOT NULL,
  left_line_account_id TEXT REFERENCES line_accounts(id) ON DELETE RESTRICT,
  left_shop_key TEXT,
  left_snapshot_json TEXT NOT NULL CHECK (json_valid(left_snapshot_json)),
  right_subject_kind TEXT NOT NULL CHECK (right_subject_kind = 'friend'),
  right_subject_id TEXT NOT NULL REFERENCES friends(id) ON DELETE RESTRICT,
  right_line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  right_shop_key TEXT,
  right_snapshot_json TEXT NOT NULL CHECK (json_valid(right_snapshot_json)),
  source_key TEXT,
  external_customer_id TEXT,
  evidence_fingerprint TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  impact_json TEXT NOT NULL CHECK (json_valid(impact_json)),
  detected_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind = 'friend_duplicate' AND left_subject_kind = 'friend'
      AND left_line_account_id IS NOT NULL AND left_subject_id < right_subject_id)
    OR
    (kind = 'ec_member' AND left_subject_kind = 'ec_event'
      AND left_line_account_id = right_line_account_id
      AND left_shop_key IS NOT NULL AND source_key IS NOT NULL
      AND external_customer_id IS NOT NULL)
  ),
  UNIQUE (
    tenant_id, kind, left_subject_kind, left_subject_id,
    right_subject_kind, right_subject_id
  )
);

CREATE TABLE identity_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  candidate_id TEXT REFERENCES identity_candidates(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('candidate', 'link', 'unlink', 'profile', 'priority', 'migration')),
  summary TEXT NOT NULL,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  actor_staff_id TEXT,
  actor_name TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL
);

CREATE TABLE imagemap_images (
  id TEXT PRIMARY KEY,
  line_account_id TEXT REFERENCES line_accounts(id),
  r2_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE impersonation_sessions (
  id             TEXT PRIMARY KEY,
  staff_id       TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mode           TEXT NOT NULL DEFAULT 'read' CHECK (mode IN ('read', 'write')),
  write_reason   TEXT,
  -- 個人情報の一時表示。理由を入れると 1 になり、終了で戻る。
  pii_revealed   INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  write_started_at TEXT,
  ended_at       TEXT
);

CREATE TABLE inbox_assignment_logs (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES line_accounts(id),chat_id TEXT NOT NULL REFERENCES chats(id),
 staff_id TEXT NOT NULL REFERENCES staff_members(id),strategy TEXT NOT NULL,decided_at TEXT NOT NULL,mutation_token TEXT NOT NULL UNIQUE
);

CREATE TABLE inbox_assignment_settings (
 account_id TEXT PRIMARY KEY REFERENCES line_accounts(id),
 strategy TEXT NOT NULL DEFAULT 'none' CHECK(strategy IN('none','even','priority','random_weighted')),
 targets_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(targets_json))
);

CREATE TABLE inbox_conversation_events (
  id              TEXT PRIMARY KEY,
  channel         TEXT NOT NULL CHECK (channel IN ('line', 'email')),
  conversation_id TEXT NOT NULL,
  event_type      TEXT NOT NULL
                  CHECK (event_type IN ('assignment', 'status', 'note', 'read', 'send', 'conflict', 'unsend')),
  before_json     TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json      TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  actor_staff_id  TEXT,
  reason          TEXT,
  correlation_id  TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE inbox_notes (
  id                    TEXT PRIMARY KEY,
  channel               TEXT NOT NULL CHECK (channel IN ('line', 'email')),
  conversation_id       TEXT NOT NULL,
  body                  TEXT NOT NULL,
  created_by_staff_id   TEXT,
  correction_of_note_id TEXT REFERENCES inbox_notes (id) ON DELETE SET NULL,
  invalidation_reason   TEXT,
  created_at            TEXT NOT NULL
);

CREATE TABLE inbox_reply_leases (
  channel               TEXT NOT NULL CHECK (channel IN ('line', 'email')),
  conversation_id       TEXT NOT NULL,
  staff_id              TEXT NOT NULL,
  acquired_at           TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  conversation_revision INTEGER NOT NULL,
  PRIMARY KEY (channel, conversation_id)
);

CREATE TABLE inbox_routing_settings (
 account_id TEXT PRIMARY KEY REFERENCES line_accounts(id), strategy TEXT NOT NULL DEFAULT 'none' CHECK(strategy='none'),
 sla_enabled INTEGER NOT NULL DEFAULT 0 CHECK(sla_enabled IN (0,1)),
 sla_first_response_minutes INTEGER NOT NULL DEFAULT 30 CHECK(sla_first_response_minutes BETWEEN 5 AND 1440),
 sla_business_hours_only INTEGER NOT NULL DEFAULT 1 CHECK(sla_business_hours_only IN (0,1)),
 notify_before_minutes INTEGER NOT NULL DEFAULT 15, escalate_after_minutes INTEGER NOT NULL DEFAULT 30,
 escalate_team_id TEXT, version INTEGER NOT NULL DEFAULT 1, updated_by TEXT, updated_at TEXT NOT NULL, mutation_token TEXT
);

CREATE TABLE inbox_staff_reads (
  staff_id        TEXT NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('line', 'email')),
  conversation_id TEXT NOT NULL,
  last_read_at    TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (staff_id, channel, conversation_id)
);

CREATE TABLE incoming_webhook_queue (
  source_event_id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES incoming_webhooks(id),
  signature_hash TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  payload_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE incoming_webhook_receipts (
  webhook_id     TEXT NOT NULL REFERENCES incoming_webhooks(id) ON DELETE CASCADE,
  signature_hash TEXT NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','processing','completed','retryable_failed')),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  last_error_code TEXT,
  received_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), config_version INTEGER, identity_match_json TEXT, action_refs_json TEXT, body_hash TEXT,
  PRIMARY KEY (webhook_id, signature_hash)
);

CREATE TABLE incoming_webhook_steps (
  source_event_id TEXT NOT NULL REFERENCES incoming_webhook_receipts(source_event_id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing','completed')),
  result_json TEXT,
  PRIMARY KEY (source_event_id, step_key)
);

CREATE TABLE "incoming_webhook_unmatched_events" (
  id                    TEXT PRIMARY KEY,
  webhook_id            TEXT NOT NULL REFERENCES incoming_webhooks(id),
  line_account_id       TEXT NOT NULL REFERENCES line_accounts(id),
  source_event_id       TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('unmatched', 'candidate', 'ambiguous')),
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'resolved', 'dismissed')),
  identity_attempts_json TEXT NOT NULL DEFAULT '[]'
                        CHECK (json_valid(identity_attempts_json)),
  masked_shape_json     TEXT CHECK (masked_shape_json IS NULL OR json_valid(masked_shape_json)),
  -- kind='ambiguous' の届物だけが持つ、一致した友だちIDの並び。
  candidate_friend_ids_json TEXT CHECK (candidate_friend_ids_json IS NULL OR json_valid(candidate_friend_ids_json)),
  resolved_friend_id    TEXT REFERENCES friends(id),
  resolved_by           TEXT,
  resolved_at           TEXT,
  received_at           TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (webhook_id, source_event_id)
);

CREATE TABLE incoming_webhooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'custom',
  secret      TEXT,
  line_account_id TEXT REFERENCES line_accounts (id),
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, version INTEGER NOT NULL DEFAULT 1
  CHECK (version > 0), identity_match_json TEXT NOT NULL DEFAULT
  '{"methods":[],"onNotFound":"do_nothing"}', action_refs_json TEXT NOT NULL DEFAULT '[]', latest_masked_sample_json TEXT, latest_received_at TEXT, secret_encrypted TEXT, deleted_at TEXT, deleted_by_staff_id TEXT, secret_previous_encrypted TEXT, secret_rotated_at TEXT, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL);

CREATE TABLE "instagram_connections" (
 line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id), page_id TEXT NOT NULL,
 instagram_id TEXT NOT NULL, page_name TEXT NOT NULL, username TEXT,
 page_token_encrypted TEXT NOT NULL, user_token_encrypted TEXT NOT NULL,
 expires_at TEXT NOT NULL, data_access_expires_at TEXT, profile_json TEXT, posts_json TEXT,
 refreshed_at TEXT NOT NULL, synced_at TEXT, connected_by TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, scopes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE "instagram_messages" (
 id TEXT NOT NULL, line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
 instagram_id TEXT NOT NULL, sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
 content TEXT NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(attachments_json)), received_at TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(line_account_id,id)
);

CREATE TABLE instagram_oauth_states (
 state_hash TEXT PRIMARY KEY, line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
 staff_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('started','exchanging','selecting','connecting')),
 candidates_encrypted TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE integration_api_tokens (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  name            TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  -- 一覧で「どれか」見分けるための先頭部分だけ。照合には使わない。
  token_prefix    TEXT NOT NULL,
  scopes          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes)),
  created_by      TEXT,
  last_used_at    TEXT,
  revoked_at      TEXT,
  revoked_by      TEXT,
  rotated_from_id TEXT REFERENCES integration_api_tokens(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE lesson_memberships (
 id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL REFERENCES line_accounts(id), friend_id TEXT NOT NULL REFERENCES friends(id),
 plan_name TEXT, joined_at TEXT NOT NULL, ended_at TEXT, withdrawal_reason TEXT, expires_at TEXT,
 remaining_uses INTEGER CHECK(remaining_uses IS NULL OR remaining_uses>=0), updated_by TEXT,
 version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
 UNIQUE(line_account_id,friend_id)
);

CREATE TABLE line_account_connection_checks (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  check_kind        TEXT NOT NULL CHECK (check_kind IN (
    'bot_info', 'webhook_endpoint', 'webhook_test', 'liff_config', 'token_refresh'
  )),
  result            TEXT NOT NULL CHECK (result IN (
    'matched', 'mismatched', 'unconfigured', 'unknown', 'ok', 'failed'
  )),
  expected_url      TEXT,
  registered_url    TEXT,
  webhook_active    INTEGER CHECK (webhook_active IN (0, 1) OR webhook_active IS NULL),
  http_status       INTEGER,
  checked_by        TEXT NOT NULL,
  checked_at        TEXT NOT NULL,
  correlation_id    TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  account_revision  INTEGER NOT NULL,
  UNIQUE (line_account_id, idempotency_key, check_kind)
);

CREATE TABLE line_account_hq_admin_memberships (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  staff_id TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (line_account_id, staff_id)
);

CREATE TABLE line_account_tag_links (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  PRIMARY KEY (line_account_id, tag_id),
  FOREIGN KEY (tag_id, tenant_id) REFERENCES line_account_tags(id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE "line_account_tags" (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  color TEXT CHECK (color IS NULL OR
    (length(color)=7 AND substr(color,1,1)='#'
      AND substr(color,2) NOT GLOB '*[^0-9A-Fa-f]*')),
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE line_accounts (
  id                     TEXT PRIMARY KEY,
  channel_id             TEXT NOT NULL UNIQUE,
  name                   TEXT NOT NULL,
  channel_access_token   TEXT NOT NULL,
  channel_secret         TEXT NOT NULL,
  -- 172: AES-GCM encrypted values. Legacy plaintext columns remain during migration.
  channel_access_token_encrypted TEXT,
  channel_secret_encrypted       TEXT,
  channel_access_token_updated_at TEXT,
  channel_secret_updated_at       TEXT,
  login_channel_secret_updated_at TEXT,
  is_active              INTEGER NOT NULL DEFAULT 1,
  is_default             INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  archived_at            TEXT,
  archived_by            TEXT,
  archived_reason        TEXT,
  country                TEXT,
  role                   TEXT,
  display_order          INTEGER NOT NULL DEFAULT 0,
  og_site_name           TEXT,
  og_default_image_url   TEXT,
  og_default_description TEXT,
  official_profile_url   TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, login_channel_id TEXT, login_channel_secret TEXT, liff_id TEXT, token_expires_at TEXT, friend_capacity INTEGER, capacity_warn_at INTEGER, icon_url TEXT, parent_line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL, tenant_id TEXT REFERENCES tenants(id), timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo', provider_id TEXT, revision INTEGER NOT NULL DEFAULT 1, line_display_name TEXT, line_picture_url TEXT, line_basic_id TEXT, line_profile_synced_at TEXT, inactive_reason TEXT
  CHECK (inactive_reason IS NULL OR inactive_reason IN ('manual', 'ban_detected', 'credential_invalid')), inactive_reason_detail TEXT, inactivated_at TEXT, login_channel_secret_encrypted TEXT, last_webhook_received_at TEXT, webhook_silence_exempt INTEGER NOT NULL DEFAULT 0
  CHECK (webhook_silence_exempt IN (0, 1)), folder_id TEXT REFERENCES line_account_tags(id) ON DELETE SET NULL, created_by_staff_id TEXT REFERENCES staff_members(id) ON DELETE SET NULL);

CREATE TABLE line_message_unsends (
  line_message_account_key TEXT NOT NULL,
  line_message_id          TEXT NOT NULL,
  source_user_id           TEXT,
  unsent_at                TEXT NOT NULL,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (line_message_account_key, line_message_id)
);

CREATE TABLE line_senders (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES line_accounts(id), name TEXT NOT NULL,
 icon_media_id TEXT REFERENCES media(id) ON DELETE SET NULL, icon_url TEXT,
 visibility TEXT NOT NULL CHECK(visibility IN ('all','owner_only')),
 owner_staff_id TEXT REFERENCES staff_members(id), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
 version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, updated_at TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, request_json TEXT NOT NULL, UNIQUE(account_id,idempotency_key),
 CHECK(visibility!='owner_only' OR owner_staff_id IS NOT NULL)
);

CREATE TABLE line_webhook_events (
  webhook_event_id TEXT PRIMARY KEY,
  line_account_id  TEXT,
  event_type       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received', 'processing', 'succeeded', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT CHECK (
                     last_error IS NULL OR
                     last_error IN ('line_api_error', 'db_error', 'unknown')
                   ),
  received_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE link_clicks (
  id TEXT PRIMARY KEY,
  tracked_link_id TEXT NOT NULL REFERENCES tracked_links (id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES friends (id) ON DELETE SET NULL,
  clicked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE login_audit (
  id            TEXT PRIMARY KEY,
  admin_user_id TEXT,
  action        TEXT NOT NULL CHECK (action IN ('login','logout','fail','view_personal','export')),
  screen        TEXT,
  ip            TEXT,
  user_agent    TEXT,
  result        TEXT NOT NULL DEFAULT 'ok',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
);

CREATE TABLE manual_link_check_history (
  id          TEXT PRIMARY KEY,
  link_key    TEXT NOT NULL REFERENCES manual_links(key) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('ok', 'broken')),
  http_status INTEGER,
  error_code  TEXT,
  checked_by  TEXT,
  checked_at  TEXT NOT NULL
);

CREATE TABLE manual_links (
  -- 画面ID（`2-1` など）か、作業ID（`createOfficialAccount` など）。
  -- 要件 §8-2「正本表に『作業 ID』の列を足して吸収する」。
  key           TEXT PRIMARY KEY,
  /*
    どちらの ID か。
      screen … 画面ID。トップバーの「マニュアル」が引く
      task   … 作業ID。はじめの設定や店舗登録の案内リンクが引く
  */
  key_kind      TEXT NOT NULL CHECK (key_kind IN ('screen', 'task')),
  name          TEXT NOT NULL,
  -- 公式記事の URL。まだ決めていなければ null。**空文字を入れない。**
  url           TEXT,
  /*
    リンクの状態。
      ok     … 開ける（確かめた）
      broken … 開けない
      unset  … まだ決めていない
    **確かめていない URL を ok にしない。** 確かめて初めて言える。
  */
  status        TEXT NOT NULL DEFAULT 'unset' CHECK (status IN ('ok', 'broken', 'unset')),
  last_checked_at TEXT,
  -- 開けなかったときの手がかり（HTTP の状態など）。
  last_error    TEXT,
  updated_by    TEXT,
  updated_at    TEXT NOT NULL
, version INTEGER NOT NULL DEFAULT 1
  CHECK (version > 0), last_http_status INTEGER);

CREATE TABLE mcp_call_logs (
 id TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES mcp_connections(id),tool TEXT NOT NULL,account_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN('read','draft','send_request','manage')),result TEXT NOT NULL CHECK(result IN('ok','refused','error','rate_limited')),
 refused_reason TEXT,target_type TEXT,target_id TEXT,summary TEXT NOT NULL,at TEXT NOT NULL
);

CREATE TABLE mcp_connections (
 id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES tenants(id),name TEXT NOT NULL,
 level TEXT NOT NULL CHECK(level IN('read','draft','send_request')),account_ids_json TEXT NOT NULL CHECK(json_valid(account_ids_json)),
 key_hash TEXT NOT NULL UNIQUE,key_prefix TEXT NOT NULL,previous_key_hash TEXT,previous_key_expires_at TEXT,
 expires_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','stopped')),created_by TEXT NOT NULL,stopped_by TEXT,
 last_used_at TEXT,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL
);

CREATE TABLE measurement_domain_rejections (
  site_id        TEXT NOT NULL REFERENCES measurement_sites(id) ON DELETE CASCADE,
  host           TEXT NOT NULL,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  last_seen_at   TEXT NOT NULL,
  PRIMARY KEY (site_id, host)
);

CREATE TABLE measurement_site_domains (
  site_id    TEXT NOT NULL REFERENCES measurement_sites(id) ON DELETE CASCADE,
  host       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  PRIMARY KEY (site_id, host)
);

CREATE TABLE measurement_sites (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  updated_at      TEXT
, stopped_at TEXT, stopped_reason TEXT, last_received_at TEXT);

CREATE TABLE media (
  id          TEXT PRIMARY KEY,
  folder_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('image','video','audio','file')),
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  duration_ms INTEGER,
  r2_key      TEXT NOT NULL UNIQUE,
  public_url  TEXT,
  uploaded_by TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
, line_account_id TEXT REFERENCES line_accounts(id) ON DELETE CASCADE, archived_at TEXT, archived_by TEXT, archive_reason TEXT, usage_expires_at TEXT, usage_consent_note TEXT, revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1));

CREATE TABLE media_file_scans (
  id               TEXT PRIMARY KEY,
  -- 全体で使う素材（配信用画像など）はアカウントを持たないため NULL を許す。
  line_account_id  TEXT REFERENCES line_accounts(id) ON DELETE CASCADE,
  -- form_file / broadcast_asset / generic_image は R2 キーを subject_id に入れる。
  subject_kind     TEXT NOT NULL CHECK (subject_kind IN (
                     'media', 'media_version', 'upload_session', 'photo',
                     'form_file', 'broadcast_asset', 'generic_image')),
  subject_id       TEXT NOT NULL,
  media_id         TEXT REFERENCES media(id) ON DELETE SET NULL,
  filename         TEXT NOT NULL,
  mime_type        TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL CHECK (size_bytes >= 0),
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'clean', 'rejected', 'quarantined')),
  reason_code      TEXT,
  reason_detail    TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at    TEXT,
  scanned_at       TEXT,
  quarantined_at   TEXT,
  released_at      TEXT,
  release_reason   TEXT,
  released_by      TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE media_storage_quotas (
  line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id) ON DELETE CASCADE,
  limit_bytes     INTEGER NOT NULL DEFAULT 10737418240 CHECK (limit_bytes > 0),
  updated_by      TEXT,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
);

CREATE TABLE media_upload_sessions (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  target_media_id   TEXT REFERENCES media(id) ON DELETE CASCADE,
  result_media_id   TEXT REFERENCES media(id) ON DELETE SET NULL,
  folder_id         TEXT REFERENCES folders(id) ON DELETE SET NULL,
  filename          TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('image','video','audio','file')),
  expected_mime     TEXT NOT NULL,
  expected_size     INTEGER NOT NULL CHECK (expected_size > 0),
  r2_key            TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','verified','completed','failed','expired')),
  failure_code      TEXT,
  etag              TEXT,
  expires_at        TEXT NOT NULL,
  created_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  completed_at      TEXT
, width INTEGER
  CHECK (width IS NULL OR width > 0), height INTEGER
  CHECK (height IS NULL OR height > 0), duration_ms INTEGER
  CHECK (duration_ms IS NULL OR duration_ms > 0), page_count INTEGER
  CHECK (page_count IS NULL OR page_count > 0), codec TEXT);

CREATE TABLE media_usage_scan_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  source_index     INTEGER NOT NULL DEFAULT 0,
  last_ref_id      TEXT NOT NULL DEFAULT '',
  cycle_started_at TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE "media_usages" (
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  ref_kind TEXT NOT NULL CHECK (ref_kind IN (
    'template','broadcast','rich_menu','scenario_step','nen_column','event','webinar',
    'booking_menu','booking_staff','booking_settings','form')),
  ref_id TEXT NOT NULL,
  scanned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  PRIMARY KEY (media_id, ref_kind, ref_id)
);

CREATE TABLE media_versions (
  id             TEXT PRIMARY KEY,
  media_id       TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  version_no     INTEGER NOT NULL CHECK (version_no > 0),
  r2_key         TEXT NOT NULL UNIQUE,
  mime_type      TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL CHECK (size_bytes >= 0),
  width          INTEGER,
  height         INTEGER,
  duration_ms    INTEGER,
  page_count     INTEGER,
  codec          TEXT,
  content_hash   TEXT,
  etag           TEXT,
  scan_status    TEXT NOT NULL DEFAULT 'verified'
                     CHECK (scan_status IN ('pending','verified','failed','quarantined')),
  scan_result    TEXT,
  scanned_at     TEXT,
  change_reason  TEXT,
  uploaded_by    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  published_at   TEXT,
  UNIQUE (media_id, version_no)
);

CREATE TABLE meet_callback_receipts (
  session_id   TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  received_at  TEXT NOT NULL
);

CREATE TABLE meet_consultation_notification_runs (
 id TEXT PRIMARY KEY,
 consultation_id TEXT NOT NULL REFERENCES meet_consultations(id) ON DELETE CASCADE,
 schedule_revision INTEGER NOT NULL DEFAULT 0 CHECK(schedule_revision>=0),
 booking_id TEXT, booking_version INTEGER,
 line_account_id TEXT NOT NULL DEFAULT '' REFERENCES line_accounts(id),
 friend_id TEXT NOT NULL DEFAULT '', recipient_id TEXT NOT NULL DEFAULT '',
 starts_at TEXT NOT NULL DEFAULT '', ends_at TEXT NOT NULL DEFAULT '', meet_url TEXT NOT NULL DEFAULT '',
 kind TEXT NOT NULL CHECK(kind IN('day_before','hour_before')),
 scheduled_at TEXT NOT NULL,
 retry_key TEXT NOT NULL DEFAULT '' UNIQUE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','failed','sent','cancelled')),
 retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 3),
 next_at TEXT, call_state TEXT, result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
 sent_at TEXT, last_error TEXT, created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(consultation_id,schedule_revision,kind)
);

CREATE TABLE meet_consultation_reminders (
  id               TEXT PRIMARY KEY,
  consultation_id  TEXT NOT NULL REFERENCES meet_consultations (id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('day_before', 'hour_before')),
  scheduled_at     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'failed', 'sent', 'cancelled')),
  retry_count      INTEGER NOT NULL DEFAULT 0,
  sent_at          TEXT,
  last_error       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (consultation_id, kind)
);

CREATE TABLE meet_consultations (
  id                TEXT PRIMARY KEY,
  external_event_id TEXT NOT NULL UNIQUE,
  friend_id         TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  starts_at         TEXT NOT NULL,
  ends_at           TEXT NOT NULL,
  meet_url          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'confirmed'
                    CHECK (status IN ('confirmed', 'cancelled', 'completed')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, booking_id TEXT, booking_version INTEGER, cancel_claim_id TEXT, staff_id TEXT REFERENCES staff(id), attendance TEXT CHECK(attendance IN('visited','late','no_show')), consultation_outcome TEXT CHECK(consultation_outcome IN('considering','won','lost')), outcome_recorded_at TEXT, outcome_recorded_by TEXT, schedule_revision INTEGER NOT NULL DEFAULT 0 CHECK(schedule_revision>=0));

CREATE TABLE member_rank_history(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES line_accounts(id),friend_id TEXT NOT NULL REFERENCES friends(id),from_tier_id TEXT,to_tier_id TEXT NOT NULL,reason TEXT NOT NULL,notified INTEGER NOT NULL DEFAULT 0 CHECK(notified=0),at TEXT NOT NULL);

CREATE TABLE member_rank_mutations(account_id TEXT NOT NULL REFERENCES line_accounts(id),request_key TEXT NOT NULL,request_json TEXT NOT NULL,response_json TEXT NOT NULL,PRIMARY KEY(account_id,request_key));

CREATE TABLE member_rank_notices (
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES line_accounts(id),friend_id TEXT NOT NULL REFERENCES friends(id),
 change_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('upgrade','downgrade_warning')),tier_id TEXT NOT NULL REFERENCES member_rank_tiers(id),
 purpose TEXT NOT NULL CHECK(purpose IN('notice','marketing')),messages_json TEXT NOT NULL CHECK(json_valid(messages_json)),base_messages_json TEXT NOT NULL CHECK(json_valid(base_messages_json)),
 scheduled_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN('scheduled','simulated','cancelled','skipped_late','skipped_opted_out','skipped_blocked','skipped_disabled')),
 processed_at TEXT,test_mode INTEGER NOT NULL DEFAULT 1 CHECK(test_mode=1),UNIQUE(account_id,friend_id,change_key,kind)
);

CREATE TABLE member_rank_programs (
 account_id TEXT PRIMARY KEY REFERENCES line_accounts(id),metric TEXT NOT NULL DEFAULT 'visits' CHECK(metric IN('visits','amount','miles')),window_months INTEGER NOT NULL DEFAULT 6 CHECK(window_months BETWEEN 1 AND 36),
 status TEXT NOT NULL DEFAULT 'stopped' CHECK(status IN('stopped','active')),version INTEGER NOT NULL DEFAULT 1,activated_at TEXT,updated_at TEXT NOT NULL,initial_version INTEGER NOT NULL DEFAULT 0,evaluation_token TEXT
, notify_upgrade INTEGER NOT NULL DEFAULT 1 CHECK(notify_upgrade IN(0,1)), notify_downgrade INTEGER NOT NULL DEFAULT 1 CHECK(notify_downgrade IN(0,1)));

CREATE TABLE member_rank_tiers (
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES line_accounts(id),sort INTEGER NOT NULL,name TEXT NOT NULL,threshold INTEGER NOT NULL CHECK(threshold>=0),mile_multiplier REAL NOT NULL DEFAULT 1 CHECK(mile_multiplier BETWEEN 1 AND 3),tag_id TEXT NOT NULL REFERENCES tags(id)
, coupon_code TEXT, upgrade_message_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(upgrade_message_json)), downgrade_message_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(downgrade_message_json)), benefit_descriptions_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(benefit_descriptions_json)));

CREATE TABLE member_ranks(account_id TEXT NOT NULL REFERENCES line_accounts(id),friend_id TEXT NOT NULL REFERENCES friends(id),tier_id TEXT NOT NULL REFERENCES member_rank_tiers(id),since TEXT NOT NULL,downgrade_due_at TEXT,PRIMARY KEY(account_id,friend_id));

CREATE TABLE menu_versions (
  id TEXT PRIMARY KEY,
  menu_id TEXT NOT NULL
    REFERENCES menus(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  name TEXT NOT NULL,
  category_label TEXT,
  description TEXT,
  duration_minutes INTEGER NOT NULL,
  buffer_after_minutes INTEGER NOT NULL DEFAULT 0,
  base_price INTEGER NOT NULL,
  price_mode TEXT NOT NULL DEFAULT 'fixed'
    CHECK (price_mode IN ('fixed', 'free', 'inquiry')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  -- 受付条件の上書き（booking_window_days / cutoff_hours_before /
  -- cancel_deadline_hours_before / intake_question / concurrent_capacity）。
  -- 空は「店舗の決まりを使う」。
  rules_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(rules_json)),
  created_by_staff_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (menu_id, version_number)
);

CREATE TABLE menus (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  name                  TEXT NOT NULL,
  category_label        TEXT,
  description           TEXT,
  duration_minutes      INTEGER NOT NULL,
  buffer_after_minutes  INTEGER NOT NULL DEFAULT 0,
  base_price            INTEGER NOT NULL,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  is_active             INTEGER NOT NULL DEFAULT 1,
  deleted_at            TEXT,
  auto_tag_id           TEXT,                  -- 予約申込時に friend に自動付与するタグ
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), concurrent_capacity INTEGER NOT NULL DEFAULT 1, booking_window_days INTEGER, cutoff_hours_before INTEGER, cancel_deadline_hours_before INTEGER, intake_question TEXT, price_mode TEXT NOT NULL DEFAULT 'fixed'
  CHECK (price_mode IN ('fixed', 'free', 'inquiry') AND (price_mode = 'fixed' OR base_price = 0)), version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0), meeting_mode TEXT NOT NULL DEFAULT 'in_person' CHECK(meeting_mode IN('online','in_person','customer_choice')), meeting_location TEXT, fixed_meeting_url TEXT, audience_mode TEXT NOT NULL DEFAULT 'all' CHECK(audience_mode IN('all','include_tags','exclude_tags')), audience_tag_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(audience_tag_ids_json)), customer_recurring_enabled INTEGER NOT NULL DEFAULT 0 CHECK(customer_recurring_enabled IN(0,1)), recurring_freqs_json TEXT NOT NULL DEFAULT '["weekly"]' CHECK(json_valid(recurring_freqs_json)), recurring_max_count INTEGER NOT NULL DEFAULT 12 CHECK(recurring_max_count BETWEEN 2 AND 12), max_party_size INTEGER NOT NULL DEFAULT 1 CHECK(max_party_size BETWEEN 1 AND 6), addon_menu_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(addon_menu_ids_json)), addon_only INTEGER NOT NULL DEFAULT 0 CHECK(addon_only IN(0,1)), hq_template_id TEXT, hq_template_version_id TEXT, hq_customized INTEGER NOT NULL DEFAULT 0 CHECK(hq_customized IN(0,1)), image_url TEXT, photo_media_id TEXT,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (auto_tag_id) REFERENCES tags(id) ON DELETE SET NULL
);

CREATE TABLE message_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'flex')),
  message_content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages_log (
  id               TEXT PRIMARY KEY,
  friend_id        TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  direction        TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  message_type     TEXT NOT NULL,
  content          TEXT NOT NULL,
  broadcast_id     TEXT REFERENCES broadcasts (id) ON DELETE SET NULL,
  scenario_step_id TEXT REFERENCES scenario_steps (id) ON DELETE SET NULL,
  template_id_at_send TEXT,
  delivery_type    TEXT CHECK (delivery_type IN ('push', 'reply', 'test')),
  source           TEXT,
  line_account_id  TEXT,
  sent_by_staff_id TEXT,
  line_event_at    TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, origin_kind TEXT, origin_id TEXT, scenario_version_step_id TEXT, line_message_id TEXT, line_message_account_key TEXT, unsent_at TEXT, quote_token TEXT, quoted_message_id TEXT, search_content TEXT, correction_of_message_id TEXT REFERENCES messages_log(id), sender_id TEXT REFERENCES line_senders(id), sender_snapshot_json TEXT);

CREATE TABLE "mileage_adjustment_approval_events" (
  request_id_history TEXT,
  id              TEXT PRIMARY KEY,
  request_id      TEXT REFERENCES mileage_adjustment_approval_requests(id) ON DELETE SET NULL,
  actor_staff_id  TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('requested', 'approved', 'rejected', 'cancelled')),
  reason          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE mileage_adjustment_approval_requests (
  id                     TEXT PRIMARY KEY,
  line_account_id        TEXT NOT NULL,
  program_id             TEXT NOT NULL DEFAULT 'default',
  friend_id              TEXT NOT NULL,
  direction              TEXT NOT NULL CHECK (direction IN ('increase', 'decrease')),
  amount                 INTEGER NOT NULL CHECK (amount > 0),
  reason_category        TEXT NOT NULL,
  reason                 TEXT NOT NULL,
  source_reference_id    TEXT,
  expires_at             TEXT,
  notify_friend          INTEGER NOT NULL DEFAULT 0,
  idempotency_key        TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by_staff_id  TEXT NOT NULL,
  requested_by_staff_name TEXT NOT NULL,
  decided_by_staff_id    TEXT,
  decided_by_staff_name  TEXT,
  decided_at             TEXT,
  decision_reason        TEXT,
  ledger_entry_id        TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (line_account_id, idempotency_key)
);

CREATE TABLE mileage_adjustment_notifications (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL REFERENCES line_accounts(id),
  friend_id         TEXT NOT NULL REFERENCES friends(id),
  ledger_entry_id   TEXT NOT NULL UNIQUE REFERENCES mileage_ledger(id),
  idempotency_key   TEXT NOT NULL,
  message_text      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sent', 'failed')),
  attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  line_request_id   TEXT,
  error_code        TEXT,
  first_failed_at   TEXT,
  sent_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (line_account_id, idempotency_key)
);

CREATE TABLE mileage_earning_rule_drafts (
  rule_id             TEXT PRIMARY KEY REFERENCES mileage_rules(id),
  line_account_id     TEXT NOT NULL REFERENCES line_accounts(id),
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  draft_json          TEXT NOT NULL CHECK (json_valid(draft_json)),
  updated_by_staff_id TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE mileage_earning_rule_published_versions (
  id                      TEXT PRIMARY KEY,
  rule_id                 TEXT NOT NULL REFERENCES mileage_rules(id) ON DELETE CASCADE,
  version_number          INTEGER NOT NULL CHECK (version_number >= 0),
  content_json            TEXT NOT NULL CHECK (json_valid(content_json)),
  status                  TEXT NOT NULL DEFAULT 'published'
                          CHECK (status IN ('published', 'retired')),
  publish_idempotency_key TEXT,
  published_at            TEXT NOT NULL,
  published_by_staff_id   TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (rule_id, version_number),
  UNIQUE (rule_id, publish_idempotency_key)
);

CREATE TABLE mileage_event_queue (
  engagement_event_id   TEXT PRIMARY KEY REFERENCES engagement_events(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','processed','failed')),
  attempts              INTEGER NOT NULL DEFAULT 0,
  available_at          TEXT NOT NULL,
  processing_started_at TEXT,
  processed_at          TEXT,
  last_error            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
, applied_published_snapshot TEXT NULL
  CHECK (applied_published_snapshot IS NULL OR json_valid(applied_published_snapshot)));

CREATE TABLE mileage_grant_lots (
  ledger_entry_id       TEXT PRIMARY KEY REFERENCES mileage_ledger(id),
  program_id            TEXT NOT NULL REFERENCES mileage_programs(id),
  beneficiary_key       TEXT NOT NULL,
  original_amount       INTEGER NOT NULL CHECK (original_amount > 0),
  remaining_amount      INTEGER NOT NULL CHECK (remaining_amount >= 0),
  available_at          TEXT NOT NULL,
  expires_at            TEXT,
  status                TEXT NOT NULL DEFAULT 'available'
                          CHECK (status IN ('available', 'exhausted', 'expired', 'void')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE mileage_ledger (
  id                    TEXT PRIMARY KEY,
  program_id            TEXT NOT NULL REFERENCES mileage_programs(id),
  beneficiary_user_id   TEXT REFERENCES users(id),
  beneficiary_friend_id TEXT REFERENCES friends(id),
  engagement_event_id   TEXT REFERENCES engagement_events(id),
  mileage_rule_id       TEXT REFERENCES mileage_rules(id),
  entry_type            TEXT NOT NULL
                        CHECK (entry_type IN ('grant','reversal','spend','expiration','adjustment')),
  status                TEXT NOT NULL DEFAULT 'available'
                        CHECK (status IN ('pending','available','void')),
  amount                INTEGER NOT NULL CHECK (amount != 0),
  reason                TEXT NOT NULL,
  source                TEXT NOT NULL,
  source_event_id       TEXT,
  idempotency_key       TEXT NOT NULL,
  reverses_entry_id     TEXT REFERENCES mileage_ledger(id),
  metadata              TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  occurred_at           TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  UNIQUE (program_id, idempotency_key)
);

CREATE TABLE mileage_programs (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active','paused','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mileage_redemption_attempts (
  id              TEXT PRIMARY KEY,
  redemption_id   TEXT NOT NULL REFERENCES mileage_redemptions(id),
  attempt_number  INTEGER NOT NULL CHECK (attempt_number > 0),
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'succeeded', 'failed')),
  error_code      TEXT,
  error_message   TEXT,
  started_at      TEXT NOT NULL,
  completed_at    TEXT,
  UNIQUE (redemption_id, attempt_number)
);

CREATE TABLE mileage_redemption_step_deliveries (
  redemption_id   TEXT NOT NULL REFERENCES mileage_redemptions(id),
  step_key        TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'started'
                    CHECK (status IN ('started', 'sent')),
  attempt_count   INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')), owner TEXT, lease_expires_at TEXT, generation INTEGER NOT NULL DEFAULT 1, fence_token TEXT, needs_reconcile INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (redemption_id, step_key)
);

CREATE TABLE mileage_redemptions (
  id                       TEXT PRIMARY KEY,
  line_account_id          TEXT NOT NULL REFERENCES line_accounts(id),
  program_id               TEXT NOT NULL REFERENCES mileage_programs(id),
  beneficiary_key          TEXT NOT NULL,
  beneficiary_user_id      TEXT REFERENCES users(id),
  beneficiary_friend_id    TEXT REFERENCES friends(id),
  reward_id                TEXT NOT NULL REFERENCES mileage_rewards(id),
  reward_version_id        TEXT NOT NULL REFERENCES mileage_reward_versions(id),
  spend_ledger_entry_id    TEXT REFERENCES mileage_ledger(id),
  reward_code_id           TEXT,
  idempotency_key          TEXT NOT NULL,
  request_fingerprint      TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'reserved'
                             CHECK (status IN (
                               'reserved', 'delivering', 'succeeded',
                               'delivery_failed', 'refunded'
                             )),
  attempt_count            INTEGER NOT NULL DEFAULT 0,
  next_retry_at            TEXT,
  failure_code             TEXT,
  failure_message          TEXT,
  delivered_at             TEXT,
  refunded_at              TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')), reward_name_snapshot TEXT, reward_kind_snapshot TEXT,
  UNIQUE (program_id, idempotency_key)
);

CREATE TABLE mileage_reward_codes (
  id                 TEXT PRIMARY KEY,
  reward_version_id  TEXT NOT NULL REFERENCES mileage_reward_versions(id),
  code_ciphertext    TEXT NOT NULL,
  code_fingerprint   TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'available'
                       CHECK (status IN ('available', 'reserved', 'issued', 'void')),
  redemption_id      TEXT UNIQUE REFERENCES mileage_redemptions(id),
  reserved_at        TEXT,
  issued_at          TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (reward_version_id, code_fingerprint)
);

CREATE TABLE mileage_reward_folders (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mileage_reward_versions (
  id                       TEXT PRIMARY KEY,
  reward_id                TEXT NOT NULL REFERENCES mileage_rewards(id),
  version_number           INTEGER NOT NULL CHECK (version_number > 0),
  status                   TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'published')),
  required_miles           INTEGER NOT NULL CHECK (required_miles > 0),
  stock_limit              INTEGER CHECK (stock_limit IS NULL OR stock_limit >= 0),
  per_friend_limit         INTEGER CHECK (per_friend_limit IS NULL OR per_friend_limit > 0),
  starts_at                TEXT,
  ends_at                  TEXT,
  benefit_expires_days     INTEGER CHECK (benefit_expires_days IS NULL OR benefit_expires_days > 0),
  common_action_version_id TEXT REFERENCES common_action_versions(id),
  failure_policy           TEXT NOT NULL DEFAULT 'retry'
                             CHECK (failure_policy IN ('retry', 'refund', 'manual')),
  customer_message         TEXT NOT NULL DEFAULT '',
  created_by               TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  published_at             TEXT, target_conditions TEXT, revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE (reward_id, version_number)
);

CREATE TABLE "mileage_rewards" (
  id                           TEXT PRIMARY KEY,
  line_account_id              TEXT NOT NULL REFERENCES line_accounts(id),
  program_id                   TEXT NOT NULL DEFAULT 'default' REFERENCES mileage_programs(id),
  name                         TEXT NOT NULL,
  description                  TEXT,
  image_url                    TEXT,
  reward_kind                  TEXT NOT NULL
                                 CHECK (reward_kind IN (
                                   'coupon', 'tag', 'scenario', 'template',
                                   'early_access', 'rank'
                                 )),
  status                       TEXT NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft', 'published', 'stopped', 'archived')),
  sort_order                   INTEGER NOT NULL DEFAULT 0,
  current_draft_version_id     TEXT REFERENCES mileage_reward_versions(id)
                                 DEFERRABLE INITIALLY DEFERRED,
  current_published_version_id TEXT REFERENCES mileage_reward_versions(id)
                                 DEFERRABLE INITIALLY DEFERRED,
  created_by                   TEXT,
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at                  TEXT
, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL);

CREATE TABLE mileage_rules (
  id             TEXT PRIMARY KEY,
  program_id     TEXT NOT NULL REFERENCES mileage_programs(id),
  name           TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  source         TEXT,
  amount         INTEGER NOT NULL CHECK (amount > 0),
  initial_status TEXT NOT NULL DEFAULT 'available'
                 CHECK (initial_status IN ('pending','available')),
  conditions     TEXT CHECK (conditions IS NULL OR json_valid(conditions)),
  line_account_id TEXT REFERENCES line_accounts(id),
  is_active      INTEGER NOT NULL DEFAULT 1,
  valid_from     TEXT,
  valid_until    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
, published_version_number INTEGER NULL);

CREATE TABLE mileage_spend_allocations (
  id                TEXT PRIMARY KEY,
  redemption_id     TEXT NOT NULL REFERENCES mileage_redemptions(id),
  spend_ledger_id   TEXT NOT NULL REFERENCES mileage_ledger(id),
  grant_lot_id      TEXT NOT NULL REFERENCES mileage_grant_lots(ledger_entry_id),
  amount            INTEGER NOT NULL CHECK (amount > 0),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (redemption_id, grant_lot_id)
);

CREATE TABLE mileage_wallets (
  program_id            TEXT NOT NULL REFERENCES mileage_programs(id),
  beneficiary_key       TEXT NOT NULL,
  beneficiary_user_id   TEXT REFERENCES users(id),
  beneficiary_friend_id TEXT REFERENCES friends(id),
  available             INTEGER NOT NULL DEFAULT 0,
  pending               INTEGER NOT NULL DEFAULT 0,
  version               INTEGER NOT NULL DEFAULT 0,
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (program_id, beneficiary_key)
);

CREATE TABLE musubo_final_line_notices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event TEXT NOT NULL CHECK (event IN ('scheduled', 'immediate', 'cancelled')),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

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

CREATE TABLE musubo_line_usage (
  line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'ending', 'ended')),
  activated_at TEXT,
  ended_at TEXT,
  google_business_count INTEGER NOT NULL DEFAULT 0 CHECK (google_business_count >= 0),
  instagram_count INTEGER NOT NULL DEFAULT 0 CHECK (instagram_count >= 0),
  friend_count_excluding_blocked INTEGER CHECK (friend_count_excluding_blocked IS NULL OR friend_count_excluding_blocked >= 0),
  friend_count_measured_on TEXT,
  billed_linked_slots INTEGER NOT NULL DEFAULT 0 CHECK (billed_linked_slots >= 0),
  linked_slots_reduction_at TEXT,
  updated_at TEXT NOT NULL
);

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
  payment_failed_at TEXT,
  mail05_sent_at TEXT,
  mail19_sent_at TEXT,
  mail20_sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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
  trial_started_mail_sent_at TEXT,
  trial_ending_mail_sent_at TEXT,
  core_subscription_id TEXT,
  options_subscription_id TEXT,
  next_monthly_charge_at TEXT,
  next_annual_renewal_at TEXT,
  termination_requested_at TEXT,
  termination_effective_at TEXT,
  termination_synced_at TEXT,
  ended_at TEXT,
  resumption_generation INTEGER NOT NULL DEFAULT 0 CHECK (resumption_generation >= 0),
  resumption_offer_json TEXT CHECK (resumption_offer_json IS NULL OR json_valid(resumption_offer_json)),
  resumption_consented_at TEXT,
  resumption_requested_at TEXT,
  resumption_line_account_id TEXT REFERENCES line_accounts(id),
  resumption_friend_count INTEGER CHECK (resumption_friend_count IS NULL OR resumption_friend_count >= 0),
  resumption_friend_measured_on TEXT,
  resumed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (pricing_consented_at IS NULL OR pricing_selection_json IS NOT NULL),
  CHECK (resumption_consented_at IS NULL OR resumption_offer_json IS NOT NULL),
  CHECK (resumption_requested_at IS NULL OR
    (resumption_consented_at IS NOT NULL AND resumption_line_account_id IS NOT NULL
      AND resumption_friend_count IS NOT NULL AND resumption_friend_measured_on IS NOT NULL)),
  CHECK (first_line_activated_at IS NOT NULL OR
    (trial_last_free_date IS NULL AND first_charge_date IS NULL))
);

CREATE TABLE nen_birthday_coupon_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  code_prefix TEXT NOT NULL DEFAULT 'NENBDAY',
  benefit_label TEXT NOT NULL DEFAULT 'お誕生日月限定クーポン',
  discount_amount INTEGER NOT NULL DEFAULT 500 CHECK (discount_amount BETWEEN 1 AND 100000),
  validity_days INTEGER NOT NULL DEFAULT 31 CHECK (validity_days BETWEEN 1 AND 365),
  updated_at TEXT NOT NULL
);

CREATE TABLE nen_campaign_settings (
  campaign_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('transactional', 'follow_up', 'column', 'birthday')),
  trigger_event TEXT,
  delay_days INTEGER NOT NULL DEFAULT 0 CHECK (delay_days BETWEEN 0 AND 365),
  delivery_time TEXT NOT NULL DEFAULT '10:00',
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  title TEXT NOT NULL,
  body_text TEXT NOT NULL DEFAULT '',
  button_label TEXT,
  button_url TEXT,
  image_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE nen_care_flags (
  id TEXT PRIMARY KEY,
  pet_id TEXT NOT NULL REFERENCES nen_pet_profiles(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  flag_type TEXT NOT NULL CHECK (flag_type IN ('poor_appetite','abnormal_stool')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved')),
  consecutive_days INTEGER NOT NULL DEFAULT 0,
  advice_ready INTEGER NOT NULL DEFAULT 1 CHECK (advice_ready IN (0,1)),
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (pet_id, flag_type)
);

CREATE TABLE nen_column_read_events (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  column_id TEXT NOT NULL REFERENCES nen_columns(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('opened', 'completed')),
  idempotency_key TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (line_account_id, idempotency_key)
);

CREATE TABLE nen_columns (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  category TEXT,
  excerpt TEXT NOT NULL DEFAULT '',
  article_url TEXT NOT NULL,
  image_url TEXT,
  published_at TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'draft' CHECK (delivery_status IN ('draft', 'scheduled', 'queued', 'sent')),
  delivery_at TEXT,
  line_account_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, intro_text TEXT, target_mode TEXT NOT NULL DEFAULT 'all'
  CHECK (target_mode IN ('all', 'tag')), target_tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL, completion_event_name TEXT, completion_tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL, source_column_id TEXT REFERENCES nen_columns(id) ON DELETE SET NULL);

CREATE TABLE nen_consultation_logs (
  id TEXT PRIMARY KEY,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  pet_id TEXT REFERENCES nen_pet_profiles(id) ON DELETE SET NULL,
  topic TEXT NOT NULL CHECK (topic IN ('tear_stain','appetite','allergy')),
  answers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(answers_json)),
  result_key TEXT NOT NULL,
  result_text TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE nen_consultation_logs_v2 (
  id TEXT PRIMARY KEY,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  pet_id TEXT REFERENCES nen_pet_profiles(id) ON DELETE SET NULL,
  animal_type TEXT NOT NULL DEFAULT 'dog' CHECK (animal_type IN ('dog','cat')),
  topic TEXT NOT NULL DEFAULT 'free_text',
  question_text TEXT NOT NULL DEFAULT '',
  answers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(answers_json)),
  result_key TEXT NOT NULL,
  result_text TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  source_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_ids_json)),
  safety_level TEXT NOT NULL DEFAULT 'general' CHECK (safety_level IN ('general','caution','urgent')),
  created_at TEXT NOT NULL
);

CREATE TABLE nen_coupon_issues (
  id TEXT PRIMARY KEY,
  pet_id TEXT NOT NULL REFERENCES nen_pet_profiles(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  issue_year INTEGER NOT NULL,
  coupon_code TEXT NOT NULL UNIQUE,
  benefit_label TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  used_at TEXT,
  UNIQUE (pet_id, issue_year)
);

CREATE TABLE nen_delivery_jobs (
  id TEXT PRIMARY KEY,
  campaign_key TEXT NOT NULL REFERENCES nen_campaign_settings(campaign_key),
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  line_account_id TEXT,
  source_key TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'skipped', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, campaign_snapshot TEXT CHECK (
  campaign_snapshot IS NULL OR json_valid(campaign_snapshot)
), version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1), retry_generation INTEGER NOT NULL DEFAULT 0 CHECK (retry_generation >= 0), last_retry_reason TEXT CHECK (
    last_retry_reason IS NULL OR length(last_retry_reason) BETWEEN 1 AND 500
  ), last_retry_requested_by TEXT, last_retry_requested_at TEXT, next_attempt_at TEXT, claim_token TEXT,
  UNIQUE (campaign_key, friend_id, source_key)
);

CREATE TABLE nen_ec_member_snapshots (
  friend_id TEXT PRIMARY KEY REFERENCES friends(id) ON DELETE CASCADE,
  customer_id TEXT,
  orders_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(orders_json)),
  subscription_json TEXT CHECK (subscription_json IS NULL OR json_valid(subscription_json)),
  purchase_count INTEGER NOT NULL DEFAULT 0,
  purchase_amount INTEGER NOT NULL DEFAULT 0,
  point_balance INTEGER NOT NULL DEFAULT 0,
  member_rank TEXT NOT NULL DEFAULT '会員',
  synced_at TEXT NOT NULL
, annual_miles_yen INTEGER NOT NULL DEFAULT 0, lifetime_miles_yen INTEGER NOT NULL DEFAULT 0, member_rank_key TEXT, mile_rate_percent REAL, rank_valid_until TEXT, mile_balance INTEGER NOT NULL DEFAULT 0, miles_used_this_month INTEGER NOT NULL DEFAULT 0, last_purchased_at TEXT, ec_member_rank_name TEXT);

CREATE TABLE nen_feeding_products (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  kcal_per_100g   REAL NOT NULL CHECK (kcal_per_100g > 0 AND kcal_per_100g <= 1000),
  is_default      INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
, kind TEXT NOT NULL DEFAULT 'staple' CHECK (kind IN ('staple', 'nen')));

CREATE TABLE nen_feeding_settings (
  line_account_id     TEXT PRIMARY KEY REFERENCES line_accounts(id) ON DELETE CASCADE,
  treat_limit_percent INTEGER NOT NULL DEFAULT 10 CHECK (treat_limit_percent BETWEEN 1 AND 30),
  updated_at          TEXT NOT NULL
);

CREATE TABLE "nen_friend_add_coupon_issues" (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_id       TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  coupon_code     TEXT NOT NULL,
  discount_rate   INTEGER NOT NULL CHECK (discount_rate BETWEEN 1 AND 100),
  valid_from      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'coupon_created', 'sent', 'failed_create', 'failed_send')),
  last_error      TEXT,
  issued_at       TEXT,
  sent_at         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (line_account_id, friend_id)
);

CREATE TABLE nen_health_logs (
  id TEXT PRIMARY KEY,
  pet_id TEXT NOT NULL REFERENCES nen_pet_profiles(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  logged_on TEXT NOT NULL,
  weight_kg REAL,
  stool_status TEXT NOT NULL CHECK (stool_status IN ('normal','soft','hard','diarrhea','bloody','other')),
  appetite TEXT NOT NULL CHECK (appetite IN ('good','normal','poor')),
  skin_status TEXT NOT NULL DEFAULT 'normal' CHECK (skin_status IN ('normal','itchy','red','other')),
  tear_stain_status TEXT NOT NULL DEFAULT 'normal' CHECK (tear_stain_status IN ('normal','mild','concern')),
  note TEXT NOT NULL DEFAULT '',
  care_flag INTEGER NOT NULL DEFAULT 0 CHECK (care_flag IN (0,1)),
  created_at TEXT NOT NULL, heart_rate_bpm INTEGER, respiratory_rate_bpm INTEGER,
  UNIQUE (pet_id, logged_on)
);

CREATE TABLE nen_knowledge_articles (
  id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  animal_type TEXT NOT NULL CHECK (animal_type IN ('dog','cat','all')),
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  body TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, source_kind TEXT NOT NULL DEFAULT 'commercial_editorial', authority_rank INTEGER NOT NULL DEFAULT 40, language TEXT NOT NULL DEFAULT 'ja', reviewed_at TEXT);

CREATE TABLE nen_lifetime_milestones (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  threshold_yen   INTEGER NOT NULL CHECK (threshold_yen > 0),
  title           TEXT NOT NULL,
  benefit_kind    TEXT,
  benefit_note    TEXT,
  notify_on_reach INTEGER NOT NULL DEFAULT 1 CHECK (notify_on_reach IN (0, 1)),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE nen_member_rank_sync (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  friend_id TEXT NOT NULL,
  customer_id TEXT,
  rank_key TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  expected_version INTEGER CHECK (expected_version IS NULL OR expected_version >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'failed', 'synced')),
  error_code TEXT,
  error_reason TEXT,
  result_version INTEGER,
  duplicate INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (operation_id, friend_id)
);

CREATE TABLE nen_pet_profiles (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  customer_id TEXT,
  name TEXT NOT NULL,
  animal_type TEXT NOT NULL DEFAULT 'dog' CHECK (animal_type IN ('dog', 'cat', 'other')),
  gender TEXT NOT NULL DEFAULT 'unknown' CHECK (gender IN ('male', 'female', 'unknown')),
  birthday TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, breed TEXT, weight_kg REAL, concerns TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(concerns)), recommended_daily_grams INTEGER, recommended_daily_min_grams INTEGER, recommended_daily_max_grams INTEGER, venison_daily_grams INTEGER, food_cycle_days INTEGER, image_r2_key TEXT, image_url TEXT, neutered INTEGER CHECK (neutered IN (0, 1)), activity_level TEXT NOT NULL DEFAULT 'normal' CHECK (activity_level IN ('low', 'normal', 'high')), daily_kcal INTEGER, feeding_product_id TEXT, weight_updated_at TEXT, archived_at TEXT);

CREATE TABLE "nen_photo_assessment_runs" (
  photo_id_history TEXT,
  id TEXT PRIMARY KEY,
  photo_id TEXT REFERENCES nen_photo_submissions(id) ON DELETE SET NULL,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  requested_version INTEGER NOT NULL CHECK (requested_version > 0),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  requested_by TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  provider TEXT,
  model_version TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(line_account_id, requested_by, idempotency_key)
);

CREATE TABLE nen_photo_asset_jobs (
  id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL REFERENCES nen_photo_submissions(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  operation TEXT NOT NULL CHECK (operation IN ('review', 'public', 'thumbnail', 'all')),
  requested_version INTEGER NOT NULL CHECK (requested_version > 0),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  requested_by TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(line_account_id, requested_by, idempotency_key)
);

CREATE TABLE nen_photo_bulk_decision_receipts (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  requested_by TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  UNIQUE(line_account_id, requested_by, idempotency_key)
);

CREATE TABLE nen_photo_derivatives (
  id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL REFERENCES nen_photo_submissions(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('review', 'public', 'thumbnail')),
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  created_at TEXT NOT NULL,
  UNIQUE(photo_id, kind, source_version)
);

CREATE TABLE "nen_photo_original_download_audit" (
  photo_id_history TEXT,
  id TEXT PRIMARY KEY,
  photo_id TEXT REFERENCES nen_photo_submissions(id) ON DELETE SET NULL,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  requested_by TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('issued', 'downloaded')),
  created_at TEXT NOT NULL
);

CREATE TABLE "nen_photo_original_download_grants" (
  photo_id_history TEXT,
  token_hash TEXT PRIMARY KEY,
  photo_id TEXT REFERENCES nen_photo_submissions(id) ON DELETE SET NULL,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  requested_by TEXT NOT NULL,
  requested_version INTEGER NOT NULL CHECK (requested_version > 0),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(line_account_id, requested_by, idempotency_key)
);

CREATE TABLE nen_photo_publication_daily_views (
  publication_id TEXT NOT NULL REFERENCES nen_photo_publications(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  view_date TEXT NOT NULL CHECK (length(view_date) = 10),
  placement_label TEXT NOT NULL DEFAULT '',
  view_count INTEGER NOT NULL CHECK (view_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (publication_id, view_date, placement_label)
);

CREATE TABLE nen_photo_publication_placements (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES nen_photo_publications(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  placement_type TEXT NOT NULL CHECK (placement_type IN ('rich_menu', 'column', 'form', 'site')),
  placement_label TEXT NOT NULL,
  view_count INTEGER CHECK (view_count IS NULL OR view_count >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE(publication_id, placement_type, placement_label)
);

CREATE TABLE nen_photo_publication_reward_outbox (
  id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL UNIQUE REFERENCES nen_photo_submissions(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  provider_award_key TEXT NOT NULL UNIQUE,
  policy_version TEXT NOT NULL,
  points INTEGER NOT NULL CHECK (points > 0),
  status TEXT NOT NULL CHECK (status IN ('pending','processing','synced','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,
  synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE nen_photo_publications (
  id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL UNIQUE REFERENCES nen_photo_submissions(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'withdrawn')),
  show_owner_name INTEGER NOT NULL DEFAULT 0 CHECK (show_owner_name IN (0, 1)),
  view_count INTEGER CHECK (view_count IS NULL OR view_count >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  last_idempotency_key TEXT,
  published_at TEXT NOT NULL,
  withdrawn_at TEXT,
  withdrawn_by TEXT,
  updated_at TEXT NOT NULL
, sort_order INTEGER NOT NULL DEFAULT 0, reward_policy_key TEXT, reward_points INTEGER CHECK (reward_points BETWEEN 0 AND 100000));

CREATE TABLE "nen_photo_review_events" (
  photo_id_history TEXT,
  id TEXT PRIMARY KEY,
  photo_id TEXT REFERENCES nen_photo_submissions(id) ON DELETE SET NULL,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  from_status TEXT NOT NULL CHECK (from_status = 'pending'),
  to_status TEXT NOT NULL CHECK (to_status IN ('adopted', 'rejected')),
  reason_code TEXT CHECK (reason_code IS NULL OR reason_code IN ('quality', 'privacy', 'unrelated', 'duplicate', 'other')),
  reason_note TEXT,
  awarded_points INTEGER NOT NULL DEFAULT 0,
  reviewed_by TEXT NOT NULL,
  reviewed_by_name TEXT NOT NULL,
  notification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (notification_status IN ('pending', 'sending', 'sent', 'failed')),
  notification_error TEXT,
  notification_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (notification_attempt_count >= 0),
  notification_first_failed_at TEXT,
  notification_sent_at TEXT,
  notification_lease_id TEXT,
  notification_lease_expires_at TEXT,
  notification_generation INTEGER NOT NULL DEFAULT 0
    CHECK (notification_generation >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, idempotency_key TEXT, resubmit_invite INTEGER NOT NULL DEFAULT 1,
  UNIQUE(photo_id, from_status)
);

CREATE TABLE nen_photo_reward_outbox (
  id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL UNIQUE REFERENCES nen_photo_submissions(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  provider_award_key TEXT NOT NULL UNIQUE,
  policy_version TEXT NOT NULL,
  points INTEGER NOT NULL CHECK (points > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'synced', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  next_attempt_at TEXT,
  synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE "nen_photo_risk_assessments" (
  photo_id_history TEXT,
  id TEXT PRIMARY KEY,
  photo_id TEXT REFERENCES nen_photo_submissions(id) ON DELETE SET NULL,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  flag TEXT NOT NULL,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  note TEXT,
  provider TEXT,
  model_version TEXT,
  assessed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE nen_photo_submissions (
  id TEXT PRIMARY KEY,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  pet_id TEXT NOT NULL REFERENCES nen_pet_profiles(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  image_url TEXT NOT NULL,
  content_type TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','adopted','rejected')),
  awarded_points INTEGER NOT NULL DEFAULT 0,
  point_transaction_id TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  updated_at TEXT NOT NULL
, line_account_id TEXT REFERENCES line_accounts(id), publication_consent_version TEXT, publication_consent_at TEXT, publication_withdrawn_at TEXT, public_pet_name INTEGER NOT NULL DEFAULT 0
  CHECK (public_pet_name IN (0, 1)), review_reason_code TEXT
  CHECK (review_reason_code IS NULL OR review_reason_code IN ('quality', 'privacy', 'unrelated', 'duplicate', 'other')), review_reason_note TEXT, reviewed_by TEXT, reviewed_by_name TEXT, review_notification_status TEXT NOT NULL DEFAULT 'not_required'
  CHECK (review_notification_status IN ('not_required', 'pending', 'sent', 'failed')), review_image_url TEXT, public_image_url TEXT, image_width INTEGER CHECK (image_width IS NULL OR image_width > 0), image_height INTEGER CHECK (image_height IS NULL OR image_height > 0), image_byte_size INTEGER CHECK (image_byte_size IS NULL OR image_byte_size >= 0), captured_device TEXT, review_version INTEGER NOT NULL DEFAULT 1 CHECK (review_version > 0), display_rotation INTEGER NOT NULL DEFAULT 0
  CHECK (display_rotation IN (0, 90, 180, 270)), rotation_idempotency_key TEXT, notification_retry_key TEXT, content_hash TEXT, review_r2_key TEXT, public_r2_key TEXT);

CREATE TABLE nen_point_ledger (
  id TEXT PRIMARY KEY,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  reason TEXT NOT NULL,
  external_ref TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE nen_rank_rules (
  line_account_id  TEXT PRIMARY KEY REFERENCES line_accounts(id) ON DELETE CASCADE,
  year_start_month INTEGER NOT NULL DEFAULT 1 CHECK (year_start_month BETWEEN 1 AND 12),
  apply_on_reach   TEXT NOT NULL DEFAULT 'immediate' CHECK (apply_on_reach IN ('immediate')),
  keep_until       TEXT NOT NULL DEFAULT 'end_of_next_year' CHECK (keep_until IN ('end_of_next_year')),
  count_orders     TEXT NOT NULL DEFAULT 'paid_excluding_cancel_refund' CHECK (count_orders IN ('paid_excluding_cancel_refund')),
  -- 保存のたびに +1。ECはこの番号で冪等に受け取る。
  version          INTEGER NOT NULL DEFAULT 1,
  sync_status      TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'failed')),
  sync_error       TEXT,
  synced_at        TEXT,
  updated_at       TEXT NOT NULL
);

CREATE TABLE nen_rank_settings (
  id                   TEXT PRIMARY KEY,
  line_account_id      TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  rank_key             TEXT NOT NULL,
  name                 TEXT NOT NULL,
  annual_threshold_yen INTEGER NOT NULL DEFAULT 0 CHECK (annual_threshold_yen >= 0),
  mile_rate_percent    REAL NOT NULL DEFAULT 1 CHECK (mile_rate_percent >= 0 AND mile_rate_percent <= 10),
  -- 自動で付け替える友だち属性タグ（tags.id）。
  tag_id               TEXT,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (line_account_id, rank_key)
);

CREATE TABLE nen_rich_menu_jobs (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  rich_menu_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE nen_tag_refresh_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  last_friend_id   TEXT NOT NULL DEFAULT '',
  cycle_started_at TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE notification_aggregate_metrics (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  definition_id         TEXT NOT NULL REFERENCES customer_notification_definitions(id) ON DELETE CASCADE,
  metric_date           TEXT NOT NULL,
  aggregation_unit      TEXT NOT NULL,
  accepted_count        INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  display_count         INTEGER CHECK (display_count IS NULL OR display_count >= 0),
  click_count           INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0),
  state                 TEXT NOT NULL CHECK (state IN ('waiting', 'ready', 'unavailable_privacy', 'failed')),
  reason                TEXT,
  updated_at            TEXT NOT NULL,
  UNIQUE (line_account_id, definition_id, metric_date, aggregation_unit)
);

CREATE TABLE notification_deliveries (
  id                      TEXT PRIMARY KEY,
  line_account_id         TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  instance_id             TEXT NOT NULL REFERENCES notification_instances(id) ON DELETE CASCADE,
  audience_type           TEXT NOT NULL CHECK (audience_type IN ('customer', 'operator')),
  recipient_type          TEXT NOT NULL CHECK (recipient_type IN ('friend', 'staff', 'team', 'role')),
  recipient_id            TEXT NOT NULL,
  channel                 TEXT NOT NULL CHECK (channel IN ('line', 'email', 'in_app')),
  idempotency_key         TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'provider_accepted', 'excluded', 'retry_wait', 'failed')),
  retryable               INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  attempts                INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at           TEXT,
  provider_request_id     TEXT,
  provider_status         TEXT,
  error_code              TEXT,
  error_message_safe      TEXT,
  queued_at               TEXT NOT NULL,
  accepted_at             TEXT,
  failed_at               TEXT,
  execution_mode          TEXT NOT NULL DEFAULT 'automatic'
                          CHECK (execution_mode IN ('automatic', 'retry', 'resend', 'test')),
  version                 INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at              TEXT NOT NULL, source TEXT,
  UNIQUE (line_account_id, idempotency_key)
);

CREATE TABLE notification_delivery_attempts (
  id                    TEXT PRIMARY KEY,
  delivery_id           TEXT NOT NULL REFERENCES notification_deliveries(id) ON DELETE CASCADE,
  attempt_number        INTEGER NOT NULL CHECK (attempt_number > 0),
  retry_key             TEXT NOT NULL,
  outcome               TEXT NOT NULL CHECK (outcome IN ('provider_accepted', 'retry_wait', 'failed')),
  provider_request_id   TEXT,
  error_code            TEXT,
  error_message_safe    TEXT,
  attempted_at          TEXT NOT NULL,
  UNIQUE (delivery_id, attempt_number)
);

CREATE TABLE notification_instances (
  id                      TEXT PRIMARY KEY,
  line_account_id         TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  audience_type           TEXT NOT NULL CHECK (audience_type IN ('customer', 'operator')),
  definition_id           TEXT,
  definition_version_id   TEXT,
  source_event_type       TEXT NOT NULL,
  source_event_id         TEXT NOT NULL,
  source_metadata_json    TEXT,
  dedupe_key              TEXT NOT NULL,
  occurrence_count        INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  grouped_count           INTEGER NOT NULL DEFAULT 1 CHECK (grouped_count > 0),
  status                  TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'completed', 'excluded', 'failed')),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (line_account_id, dedupe_key)
);

CREATE TABLE notification_interactions (
  id            TEXT PRIMARY KEY,
  delivery_id   TEXT NOT NULL REFERENCES notification_deliveries(id) ON DELETE CASCADE,
  link_key      TEXT NOT NULL,
  clicked_at    TEXT NOT NULL,
  UNIQUE (delivery_id, link_key, clicked_at)
);

CREATE TABLE notification_rules (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  conditions   TEXT NOT NULL DEFAULT '{}',
  channels     TEXT NOT NULL DEFAULT '["webhook"]',
  line_account_id TEXT REFERENCES line_accounts(id),
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0));

CREATE TABLE notifications (
  id              TEXT PRIMARY KEY,
  rule_id         TEXT REFERENCES notification_rules (id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  channel         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  metadata        TEXT,
  line_account_id TEXT REFERENCES line_accounts(id),
  category        TEXT NOT NULL DEFAULT 'info' CHECK (category IN ('error', 'update', 'info')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE operation_alert_events (
  id                    TEXT PRIMARY KEY,
  alert_id              TEXT NOT NULL REFERENCES operation_alerts(id) ON DELETE CASCADE,
  line_account_id       TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  source_run_id         TEXT REFERENCES operation_health_runs(id) ON DELETE SET NULL,
  action                TEXT NOT NULL CHECK (action IN ('opened', 'escalated', 'acknowledged', 'resolved', 'reopened')),
  severity              TEXT NOT NULL CHECK (severity IN ('unknown', 'warning', 'danger')),
  summary               TEXT NOT NULL,
  actor_id              TEXT,
  note                  TEXT,
  alert_version         INTEGER NOT NULL CHECK (alert_version > 0),
  notification_enqueued_at TEXT,
  notification_recipient_count INTEGER NOT NULL DEFAULT 0 CHECK (notification_recipient_count >= 0),
  notification_missing_contact_count INTEGER NOT NULL DEFAULT 0 CHECK (notification_missing_contact_count >= 0),
  created_at            TEXT NOT NULL,
  UNIQUE (alert_id, alert_version)
);

CREATE TABLE operation_alert_notification_outbox (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES operation_alert_events(id) ON DELETE CASCADE,
  line_account_id    TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  staff_id           TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  channel            TEXT NOT NULL CHECK (channel IN ('line', 'email')),
  status             TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempt_count      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at    TEXT NOT NULL,
  last_error         TEXT,
  sent_at            TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (event_id, staff_id, channel)
);

CREATE TABLE "operation_alerts" (
  id                   TEXT PRIMARY KEY,
  line_account_id      TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  check_key            TEXT NOT NULL CHECK (check_key IN (
    'line_connection', 'message_quota', 'external_integrations',
    'webhook', 'dispatch_jobs', 'friend_change',
    'monitoring_heartbeat', 'infra_canary', 'credential_expiry'
  )),
  status               TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
  severity             TEXT NOT NULL CHECK (severity IN ('unknown', 'warning', 'danger')),
  summary              TEXT NOT NULL,
  source_run_id        TEXT NOT NULL REFERENCES operation_health_runs(id) ON DELETE CASCADE,
  first_detected_at    TEXT NOT NULL,
  last_detected_at     TEXT NOT NULL,
  acknowledged_at      TEXT,
  acknowledged_by_id   TEXT,
  acknowledgement_note TEXT,
  resolved_at          TEXT,
  version              INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  reopened_count       INTEGER NOT NULL DEFAULT 0 CHECK (reopened_count >= 0),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (line_account_id, check_key)
);

CREATE TABLE operation_audit (
  id            TEXT PRIMARY KEY,
  -- 何に対する操作か。'support_mark' | 'saved_search' | 'tag' など。
  target_kind   TEXT NOT NULL,
  target_id     TEXT,
  -- 何をしたか。'changed' | 'used' | 'created' | 'deleted' など。
  action        TEXT NOT NULL,
  -- 誰が。自動なら NULL。
  actor_id      TEXT,
  -- 対象の友だち。友だちに紐づかない操作なら NULL。
  friend_id     TEXT,
  -- 補足。変更前後の値など。JSON。
  detail_json   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE operation_control_sets (
  scope_key          TEXT PRIMARY KEY,
  line_account_id    TEXT REFERENCES line_accounts(id),
  version            INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  states_json        TEXT NOT NULL CHECK (json_valid(states_json)),
  active_incident_id TEXT,
  reason             TEXT,
  actor_id            TEXT,
  stopped_at         TEXT,
  updated_at         TEXT NOT NULL
);

CREATE TABLE operation_deployment_events (
  id                 TEXT PRIMARY KEY,
  deployment_id      TEXT NOT NULL,
  phase              TEXT NOT NULL CHECK (phase IN (
    'queued', 'deploying', 'verifying', 'succeeded', 'failed', 'rolled_back'
  )),
  environment        TEXT NOT NULL,
  from_commit        TEXT,
  to_commit          TEXT,
  version            TEXT,
  migration_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(migration_json)),
  rollback_available INTEGER NOT NULL DEFAULT 0 CHECK (rollback_available IN (0, 1)),
  downtime_seconds   INTEGER CHECK (downtime_seconds IS NULL OR downtime_seconds >= 0),
  pull_request       INTEGER,
  release_summary    TEXT,
  actor              TEXT NOT NULL,
  smoke_check_json   TEXT CHECK (smoke_check_json IS NULL OR json_valid(smoke_check_json)),
  occurred_at        TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  UNIQUE (deployment_id, phase)
);

CREATE TABLE operation_dispatcher_heartbeats (
  job_name         TEXT PRIMARY KEY,
  last_started_at  TEXT NOT NULL,
  last_completed_at TEXT,
  last_status      TEXT NOT NULL CHECK (last_status IN ('running', 'succeeded', 'failed')),
  updated_at       TEXT NOT NULL
);

CREATE TABLE "operation_health_results" (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES operation_health_runs(id) ON DELETE CASCADE,
  check_key      TEXT NOT NULL CHECK (check_key IN (
    'line_connection', 'message_quota', 'external_integrations',
    'webhook', 'dispatch_jobs', 'friend_change',
    'monitoring_heartbeat', 'infra_canary', 'credential_expiry'
  )),
  status         TEXT NOT NULL CHECK (status IN ('normal', 'warning', 'danger', 'unknown')),
  summary        TEXT NOT NULL,
  value_json     TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
  threshold_json TEXT CHECK (threshold_json IS NULL OR json_valid(threshold_json)),
  source         TEXT NOT NULL,
  observed_at    TEXT NOT NULL,
  UNIQUE (run_id, check_key)
);

CREATE TABLE operation_health_runs (
  id                TEXT PRIMARY KEY,
  scope_key         TEXT NOT NULL,
  line_account_id   TEXT REFERENCES line_accounts(id),
  window_started_at TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('scheduled', 'manual')),
  status            TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  overall_status    TEXT NOT NULL CHECK (overall_status IN ('normal', 'warning', 'danger', 'unknown')),
  actor_id          TEXT,
  started_at        TEXT NOT NULL,
  completed_at      TEXT,
  error_message     TEXT,
  UNIQUE (scope_key, window_started_at)
);

CREATE TABLE operation_incidents (
  id                    TEXT PRIMARY KEY,
  scope_key             TEXT NOT NULL,
  line_account_id       TEXT REFERENCES line_accounts(id),
  status                TEXT NOT NULL CHECK (status IN ('preparing', 'stopped', 'resolved', 'failed')),
  capabilities_json     TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  reason                TEXT NOT NULL,
  detail                TEXT,
  actor_id               TEXT NOT NULL,
  resolved_by_actor_id  TEXT,
  control_version       INTEGER,
  before_snapshot_json  TEXT NOT NULL CHECK (json_valid(before_snapshot_json)),
  stopped_snapshot_json TEXT CHECK (stopped_snapshot_json IS NULL OR json_valid(stopped_snapshot_json)),
  restored_snapshot_json TEXT CHECK (restored_snapshot_json IS NULL OR json_valid(restored_snapshot_json)),
  error_message         TEXT,
  stopped_at            TEXT,
  resolved_at           TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
, stopped_definitions_json TEXT
  CHECK (stopped_definitions_json IS NULL OR json_valid(stopped_definitions_json)), restore_report_json TEXT
  CHECK (restore_report_json IS NULL OR json_valid(restore_report_json)));

CREATE TABLE operation_infra_probes (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('d1')),
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE operation_notification_outbox (
  id              TEXT PRIMARY KEY,
  incident_id     TEXT NOT NULL REFERENCES operation_incidents(id),
  event_kind      TEXT NOT NULL CHECK (event_kind IN ('stopped', 'restored')),
  channel         TEXT NOT NULL CHECK (channel IN ('line', 'email')),
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  payload_json    TEXT NOT NULL CHECK (json_valid(payload_json)),
  attempt_count   INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  sent_at         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (incident_id, event_kind, channel)
);

CREATE TABLE operation_request_receipts (
  action          TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  resource_id     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (action, actor_id, idempotency_key)
);

CREATE TABLE operator_notification_occurrences (
 rule_id TEXT NOT NULL, line_account_id TEXT NOT NULL, source_event_id TEXT NOT NULL,
 instance_id TEXT NOT NULL REFERENCES notification_instances(id) ON DELETE CASCADE,
 PRIMARY KEY(rule_id,line_account_id,source_event_id)
);

CREATE TABLE operator_notification_teams (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  staff_ids TEXT NOT NULL CHECK(json_valid(staff_ids) AND json_type(staff_ids) = 'array'),
  version INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE operator_push_deliveries(id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL REFERENCES operator_push_subscriptions(id),kind TEXT NOT NULL,ref_id TEXT NOT NULL,line_account_id TEXT REFERENCES line_accounts(id),status TEXT NOT NULL CHECK(status IN('pending','sent','failed','gone','suppressed_quiet','batched')),error_code TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,created_at TEXT NOT NULL,UNIQUE(subscription_id,kind,ref_id));

CREATE TABLE operator_push_preferences(staff_id TEXT PRIMARY KEY REFERENCES staff_members(id),kinds_json TEXT NOT NULL DEFAULT '["new_inquiry","assigned_reply"]' CHECK(json_valid(kinds_json)),quiet_start TEXT NOT NULL DEFAULT '22:00',quiet_end TEXT NOT NULL DEFAULT '08:00',quiet_allow_critical INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1);

CREATE TABLE operator_push_subscriptions(id TEXT PRIMARY KEY,staff_id TEXT NOT NULL REFERENCES staff_members(id),endpoint TEXT NOT NULL UNIQUE,p256dh TEXT NOT NULL,auth TEXT NOT NULL,user_agent_label TEXT NOT NULL,created_at TEXT NOT NULL,last_success_at TEXT,last_error_code TEXT,revoked_at TEXT);

CREATE TABLE operators (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'operator')),
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE "outbound_send_requests" (
  idempotency_key TEXT PRIMARY KEY,
  channel         TEXT NOT NULL CHECK (channel IN ('line', 'email')),
  resource_id     TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL,
  status          TEXT NOT NULL CHECK (status IN ('in_progress', 'succeeded', 'failed', 'unknown')),
  response_id     TEXT,
  failure_code    TEXT,
  attempt_count   INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  retryable       INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  next_retry_at   TEXT,
  last_failed_at  TEXT,
  lease_token     TEXT,
  lease_expires_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  completed_at    TEXT,
  CHECK (
    (status = 'succeeded' AND response_id IS NOT NULL AND completed_at IS NOT NULL)
    OR status != 'succeeded'
  ),
  CHECK (
    (status IN ('failed', 'unknown') AND failure_code IS NOT NULL AND last_failed_at IS NOT NULL)
    OR status NOT IN ('failed', 'unknown')
  ),
  CHECK (status != 'unknown' OR retryable = 0)
);

CREATE TABLE outgoing_webhook_deliveries (
  id                   TEXT PRIMARY KEY,
  line_account_id      TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  webhook_id           TEXT NOT NULL REFERENCES outgoing_webhooks(id) ON DELETE CASCADE,
  event_type           TEXT NOT NULL,
  body_json            TEXT NOT NULL,
  idempotency_key      TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'retry_wait', 'delivered', 'failed')),
  attempts             INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  /** 初回を含む試行の上限。1 + min(max_retries, 7)（要件26 §6-4 の最大8回）。 */
  max_attempts         INTEGER NOT NULL CHECK (max_attempts >= 1),
  next_retry_at        TEXT,
  /** sweep の引き取り証。取り掛かったまま止まった行を lease_until で見放す。 */
  lease_token          TEXT,
  lease_until          TEXT,
  last_response_status INTEGER,
  error_code           TEXT,
  /** 相手の応答本文や秘密値は残さない。運用者が次の行動を選べる文だけ。 */
  error_message_safe   TEXT,
  queued_at            TEXT NOT NULL,
  delivered_at         TEXT,
  failed_at            TEXT,
  updated_at           TEXT NOT NULL,
  UNIQUE (webhook_id, idempotency_key)
);

CREATE TABLE outgoing_webhooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  event_types TEXT NOT NULL DEFAULT '[]',
  secret      TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, max_retries INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0, last_failed_at TEXT, line_account_id TEXT REFERENCES line_accounts(id), secret_encrypted TEXT, auto_stopped_at TEXT, deleted_at TEXT, deleted_by_staff_id TEXT, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL, version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1), updated_by_staff_id TEXT);

CREATE TABLE photo_reward_policies (
  id TEXT PRIMARY KEY,
  version_number INTEGER NOT NULL UNIQUE,
  -- 付与の記録に写す鍵。第1版は既存の 'legacy-5' と同じ鍵にする。
  -- 第2版からは 'v2' 'v3' …と付ける。
  policy_key TEXT NOT NULL UNIQUE,
  -- 採用1枚につき付けるポイント数。
  points INTEGER NOT NULL CHECK (points > 0 AND points <= 100000),
  -- 版の中身のひとこと。「報酬を5pt→10ptに」など。
  summary TEXT NOT NULL DEFAULT '',
  -- 使い始めの日時。空は「公開と同時」。未来の日時は「予約」の札で見せる。
  effective_from TEXT,
  created_by_staff_id TEXT,
  -- 同じ確認キーの再送では版を増やさないための鍵。
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, publication_points INTEGER NOT NULL DEFAULT 0 CHECK (publication_points BETWEEN 0 AND 100000));

CREATE TABLE pii_reveal_logs (
  id                        TEXT PRIMARY KEY,
  impersonation_session_id  TEXT NOT NULL REFERENCES impersonation_sessions(id) ON DELETE CASCADE,
  staff_id                  TEXT NOT NULL,
  tenant_id                 TEXT NOT NULL,
  reason                    TEXT NOT NULL,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE platform_admin_invites (
  id          TEXT PRIMARY KEY,
  staff_id    TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  invited_by  TEXT,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE platform_admins (
  staff_id      TEXT PRIMARY KEY REFERENCES staff_members(id) ON DELETE CASCADE,
  is_active     INTEGER NOT NULL DEFAULT 1,
  -- 追加を承認した運営マスター（要件 §3 37-10。最初の 3 名は移行時に NULL）。
  approved_by   TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, activation_state TEXT NOT NULL DEFAULT 'active'
  CHECK (activation_state IN ('invited', 'awaiting_totp', 'active')), invited_by TEXT, invited_at TEXT, activated_at TEXT);

CREATE TABLE platform_ai_calls (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('draft','article')),
  request_id TEXT NOT NULL REFERENCES hq_support_requests(id),
  staff_id TEXT REFERENCES staff_members(id),
  model TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE platform_announcement_recipients (
  id               TEXT PRIMARY KEY,
  announcement_id  TEXT NOT NULL REFERENCES platform_announcements(id) ON DELETE CASCADE,
  tenant_id        TEXT NOT NULL,
  staff_id         TEXT NOT NULL,
  channels         TEXT NOT NULL DEFAULT '[]',
  line_sent_at     TEXT,
  line_error       TEXT,
  mail_sent_at     TEXT,
  mail_error       TEXT,
  screen_read_at   TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE(announcement_id, staff_id)
);

CREATE TABLE platform_announcements (
  id                   TEXT PRIMARY KEY,
  subject              TEXT NOT NULL,
  body                 TEXT NOT NULL,
  audience_kind        TEXT NOT NULL DEFAULT 'all' CHECK (audience_kind IN ('all', 'plan', 'tenants')),
  -- プラン別のときのプラン（JSON 配列: light/standard/pro/trial）、契約先を選ぶときの tenants.id（JSON 配列）
  audience_plans       TEXT NOT NULL DEFAULT '[]',
  audience_tenant_ids  TEXT NOT NULL DEFAULT '[]',
  -- 送り方（JSON 配列: line / screen / email）
  channels             TEXT NOT NULL DEFAULT '["screen"]',
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed')),
  -- 公開日時（JST の ISO）。NULL の下書きは予約しない。scheduled はこの時刻以降に cron が送る
  publish_at           TEXT,
  sent_at              TEXT,
  recipients_total     INTEGER NOT NULL DEFAULT 0,
  line_sent            INTEGER NOT NULL DEFAULT 0,
  line_failed          INTEGER NOT NULL DEFAULT 0,
  mail_sent            INTEGER NOT NULL DEFAULT 0,
  mail_failed          INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  created_by_staff_id  TEXT NOT NULL,
  created_by_name      TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE platform_audit_logs (
  id                 TEXT PRIMARY KEY,
  staff_id           TEXT NOT NULL,
  staff_name         TEXT NOT NULL DEFAULT '',
  tenant_id          TEXT,
  tenant_name        TEXT,
  action             TEXT NOT NULL,
  reason             TEXT,
  detail             TEXT NOT NULL DEFAULT '{}',
  ip                 TEXT,
  visible_to_tenant  INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, security_created_at_jd REAL);

CREATE TABLE platform_counters (
  name   TEXT PRIMARY KEY,
  value  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE platform_knowledge_articles (
  id TEXT PRIMARY KEY,
  source_request_id TEXT NOT NULL REFERENCES hq_support_requests(id),
  source_revision INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('usage','bug','billing','feature','other')),
  keywords TEXT NOT NULL DEFAULT '[]',
  visibility TEXT NOT NULL DEFAULT 'ops_only' CHECK (visibility = 'ops_only'),
  review_state TEXT NOT NULL CHECK (review_state IN ('pending','approved','needs_review','dismissed')),
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('active','disabled')),
  evidence TEXT NOT NULL DEFAULT '[]',
  review_reason TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  approved_by_staff_id TEXT REFERENCES staff_members(id),
  approved_at TEXT,
  used_count INTEGER NOT NULL DEFAULT 0,
  helpful_count INTEGER NOT NULL DEFAULT 0,
  unhelpful_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, article_kind TEXT NOT NULL DEFAULT 'verified'
  CHECK (article_kind IN ('verified','answer_example')),
  UNIQUE(source_request_id, source_revision)
);

CREATE TABLE platform_knowledge_jobs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES hq_support_requests(id),
  source_revision INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','stale')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(request_id, source_revision)
);

CREATE TABLE platform_knowledge_usage (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES platform_knowledge_articles(id),
  article_version INTEGER NOT NULL,
  request_id TEXT NOT NULL REFERENCES hq_support_requests(id),
  staff_id TEXT NOT NULL REFERENCES staff_members(id),
  feedback TEXT CHECK (feedback IN ('helpful','unhelpful')),
  created_at TEXT NOT NULL,
  UNIQUE(article_id, request_id)
);

CREATE TABLE platform_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE pool_accounts (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES traffic_pools(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(pool_id, line_account_id)
);

CREATE TABLE postal_codes (
  postal_code TEXT NOT NULL,
  prefecture TEXT NOT NULL,
  city TEXT NOT NULL,
  town TEXT NOT NULL DEFAULT '',
  source_name TEXT,
  imported_at TEXT,
  PRIMARY KEY (postal_code, prefecture, city, town)
);

CREATE TABLE postal_import_manifest (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  input_bytes INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE TABLE public_ingress_receipts (
  kind TEXT NOT NULL CHECK (kind IN ('conversion_nonce', 'site_event')),
  scope_id TEXT NOT NULL,
  receipt_key TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (kind, scope_id, receipt_key)
);

CREATE TABLE qa_entries(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES line_accounts(id),questions_json TEXT NOT NULL CHECK(json_valid(questions_json)),answer_messages_json TEXT NOT NULL CHECK(json_valid(answer_messages_json)),tags_json TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','published','stopped')),source TEXT NOT NULL DEFAULT 'manual',version INTEGER NOT NULL DEFAULT 1,use_count INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL,updated_at TEXT NOT NULL,idempotency_key TEXT NOT NULL,UNIQUE(account_id,created_by,idempotency_key));

CREATE TABLE "recipe_clone_items" (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES "recipe_clone_runs"(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE "recipe_clone_runs" (
  id                  TEXT PRIMARY KEY,
  recipe_id           TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  recipe_version      INTEGER NOT NULL,
  line_account_id     TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name_prefix         TEXT,
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'succeeded', 'failed', 'rolled_back')),
  idempotency_key     TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  created_count       INTEGER NOT NULL DEFAULT 0,
  failure_reason      TEXT,
  created_by          TEXT,
  created_at          TEXT NOT NULL,
  finished_at         TEXT,
  UNIQUE (line_account_id, idempotency_key)
);

CREATE TABLE recipes (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  purpose        TEXT NOT NULL,
  -- 作られるものの1行。設計 34-2 の「作られるもの：」に出す。
  creates_summary TEXT NOT NULL,
  -- 版。**複製したあとに新版を出しても、作られた定義は変わらない**（§7-4）。
  version        INTEGER NOT NULL DEFAULT 1,
  -- 初期同梱か、組織が作ったものか。
  origin         TEXT NOT NULL DEFAULT 'builtin' CHECK (origin IN ('builtin', 'org')),
  -- 必要な機能。機能設定の鍵の配列。切れない機能は入れない。
  required_features TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(required_features)),
  /*
    作られるものの内訳。**決まっていないものを埋めない。**
    決まっていなければ null にして、画面で「まだ決まっていません」と言う。
  */
  items_json     TEXT CHECK (items_json IS NULL OR json_valid(items_json)),
  -- 全部でいくつ作られるか。内訳が決まっていなくても数だけは分かる。
  item_count     INTEGER,
  display_order  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
, line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL, created_by_staff_id TEXT);

CREATE TABLE ref_tracking (
  id              TEXT PRIMARY KEY,
  ref_code        TEXT NOT NULL,
  friend_id       TEXT REFERENCES friends (id) ON DELETE CASCADE,
  entry_route_id  TEXT REFERENCES entry_routes (id) ON DELETE SET NULL,
  source_url      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
, fbclid TEXT, gclid TEXT, twclid TEXT, ttclid TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, user_agent TEXT, ip_address TEXT, line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL, ad_conversion_consent_at TEXT);

CREATE TABLE registration_applications (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  referral_source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'contacted', 'approved', 'rejected', 'activated')),
  contact_note TEXT,
  contacted_by TEXT,
  contacted_at TEXT,
  approved_by TEXT,
  approved_at TEXT,
  invite_sent_at TEXT,
  tenant_id TEXT,
  ip_hash TEXT,
  device_marker TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, pricing_condition_id TEXT, pricing_snapshot_json TEXT
  CHECK (pricing_snapshot_json IS NULL OR json_valid(pricing_snapshot_json)));

CREATE TABLE reminder_delivery_runs (
  id                         TEXT PRIMARY KEY,
  -- 古いリマインダにはアカウントが未設定の行がある。送信を止めずに履歴化し、
  -- 画面の到達可否は親 reminder の権限で判定するため、移行中だけNULLを許す。
  line_account_id            TEXT,
  reminder_id                TEXT NOT NULL,
  friend_reminder_id         TEXT NOT NULL,
  friend_id                  TEXT NOT NULL,
  reminder_step_id           TEXT NOT NULL,
  scheduled_at               TEXT NOT NULL,
  idempotency_key            TEXT NOT NULL UNIQUE,
  line_retry_key             TEXT NOT NULL UNIQUE,
  status                     TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'claimed', 'succeeded', 'skipped',
      'retry_wait', 'permanent_failed', 'cancelled'
    )),
  attempt_count              INTEGER NOT NULL DEFAULT 0,
  retry_cycle_attempt_count  INTEGER NOT NULL DEFAULT 0,
  next_retry_at              TEXT,
  lease_expires_at           TEXT,
  last_error_code            TEXT,
  last_error_message         TEXT,
  line_request_id            TEXT,
  -- 実際に送った本文はmessages_logを正本にし、この実行から1本で辿れるようにする。
  message_log_id             TEXT,
  manual_retry_key           TEXT UNIQUE,
  started_at                 TEXT,
  completed_at               TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL, sent_message_type TEXT, sent_message_content TEXT, sent_template_id TEXT, sent_template_version INTEGER,
  UNIQUE (friend_reminder_id, reminder_step_id, scheduled_at)
);

CREATE TABLE "reminder_steps" (
  id              TEXT PRIMARY KEY,
  reminder_id     TEXT NOT NULL REFERENCES reminders (id) ON DELETE CASCADE,
  offset_minutes  INTEGER NOT NULL,
  message_type    TEXT NOT NULL CHECK (message_type IN (
                    'text', 'image', 'flex', 'location', 'video', 'audio', 'sticker', 'carousel'
                  )),
  message_content TEXT NOT NULL,
  offset_days     INTEGER,
  send_at_time    TEXT,
  template_id     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE reminder_version_steps (
  id TEXT PRIMARY KEY,
  reminder_version_id TEXT NOT NULL REFERENCES reminder_versions(id) ON DELETE CASCADE,
  stable_step_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  offset_minutes INTEGER NOT NULL,
  message_type TEXT NOT NULL,
  message_content TEXT NOT NULL,
  offset_days INTEGER,
  send_at_time TEXT,
  template_id TEXT,
  target_condition_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(target_condition_json)),
  action_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(action_json)),
  created_at TEXT NOT NULL,
  UNIQUE (reminder_version_id, stable_step_id)
);

CREATE TABLE reminder_versions (
  id TEXT PRIMARY KEY,
  reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'superseded')),
  settings_snapshot TEXT NOT NULL CHECK (json_valid(settings_snapshot)),
  last_test_status TEXT CHECK (last_test_status IN ('succeeded', 'failed')),
  last_tested_at TEXT,
  last_tested_by_staff_id TEXT,
  published_at TEXT,
  published_by_staff_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (reminder_id, version_number)
);

CREATE TABLE "reminders" (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  line_account_id TEXT,
  trigger_type  TEXT NOT NULL DEFAULT 'manual'
                CHECK (trigger_type IN ('manual', 'booking', 'event', 'friend_field')),
  trigger_offset_minutes INTEGER,
  send_at_time  TEXT,
  target_tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL,
  folder_id     TEXT REFERENCES folders(id) ON DELETE SET NULL,
  delivery_mode TEXT NOT NULL DEFAULT 'countdown',
  -- 154: 友だち情報欄の日付を起点にするときの設定
  trigger_field_id TEXT,
  repeat_yearly INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, display_order INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, lifecycle_status TEXT NOT NULL DEFAULT 'published'
  CHECK (lifecycle_status IN ('draft', 'published', 'stopped')), current_draft_version_id TEXT, current_published_version_id TEXT, created_from_recipe_id TEXT REFERENCES recipes(id), recipe_clone_run_id TEXT REFERENCES recipe_clone_runs(id), trigger_event_id TEXT, leap_year_policy TEXT NOT NULL DEFAULT 'mar1'
  CHECK (leap_year_policy IN ('feb28', 'mar1', 'skip')));

CREATE TABLE restaurant_course_payment_settings (
  menu_id TEXT PRIMARY KEY REFERENCES rt_menu_items(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  mode TEXT CHECK(mode IS NULL OR mode IN ('none','onsite','online','customer_choice')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE rfm_segment_names(account_id TEXT NOT NULL REFERENCES line_accounts(id),r_bucket INTEGER NOT NULL CHECK(r_bucket BETWEEN 1 AND 5),f_bucket INTEGER NOT NULL CHECK(f_bucket BETWEEN 1 AND 5),name TEXT NOT NULL,PRIMARY KEY(account_id,r_bucket,f_bucket));

CREATE TABLE rich_menu_area_taps (
  id              TEXT PRIMARY KEY,
  area_id         TEXT NOT NULL,
  page_id         TEXT NOT NULL,
  group_id        TEXT NOT NULL,
  area_label      TEXT,
  friend_id       TEXT,
  line_account_id TEXT,
  tapped_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE rich_menu_areas (
  id              TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL REFERENCES rich_menu_pages(id) ON DELETE CASCADE,
  bounds_x        INTEGER NOT NULL,
  bounds_y        INTEGER NOT NULL,
  bounds_width    INTEGER NOT NULL,
  bounds_height   INTEGER NOT NULL,
  action_type     TEXT NOT NULL CHECK (action_type IN ('uri','message','postback','richmenuswitch')),
  action_data     TEXT NOT NULL,
  -- 146: 運用者から見た「何をするボタンか」。LINE の action_type 4種の上に乗せる
  -- 言い換え（url / tel / text / template / form / switch / postback）。空なら
  -- action_type から推測する。
  intent          TEXT,
  label           TEXT,
  tag_ids         TEXT,
  score_change    INTEGER,
  template_id     TEXT,
  form_id         TEXT,
  tracked_link_id TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE rich_menu_assignment_runs (
  id                     TEXT PRIMARY KEY,
  version_id             TEXT,
  friend_id              TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  line_account_id        TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  group_id               TEXT REFERENCES rich_menu_groups(id) ON DELETE SET NULL,
  source_event_id        TEXT,
  idempotency_key        TEXT NOT NULL,
  previous_assignment_id TEXT,
  operation              TEXT NOT NULL CHECK (operation IN ('link', 'unlink')),
  status                 TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  attempt_count          INTEGER NOT NULL DEFAULT 1,
  next_retry_at          TEXT,
  last_error_code        TEXT,
  started_at             TEXT NOT NULL,
  completed_at           TEXT,
  UNIQUE (line_account_id, idempotency_key)
);

CREATE TABLE rich_menu_assignments (
  id                 TEXT PRIMARY KEY,
  friend_id          TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  line_account_id    TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  group_id           TEXT NOT NULL REFERENCES rich_menu_groups(id) ON DELETE CASCADE,
  version_id         TEXT,
  line_richmenu_id   TEXT NOT NULL,
  reason_kind        TEXT NOT NULL,
  reason_event_id    TEXT,
  assigned_at        TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (line_account_id, friend_id)
);

CREATE TABLE rich_menu_device_confirmations (
  id                     TEXT PRIMARY KEY,
  group_id               TEXT NOT NULL REFERENCES rich_menu_groups(id) ON DELETE CASCADE,
  -- 確認した時点の下書きの fingerprint。公開時は今の下書きと突き合わせる。
  definition_fingerprint TEXT NOT NULL,
  version_id             TEXT REFERENCES rich_menu_versions(id) ON DELETE SET NULL,
  staff_id               TEXT NOT NULL,
  confirmed_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
);

CREATE TABLE rich_menu_duplicate_requests (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  source_group_id   TEXT NOT NULL,
  created_group_id  TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (account_id, idempotency_key)
);

CREATE TABLE rich_menu_groups (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  chat_bar_text      TEXT NOT NULL,
  size               TEXT NOT NULL CHECK (size IN ('large','compact')),
  default_page_id    TEXT,
  is_default_for_all INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  publishing_at      TEXT,
  -- 149: 友だちごとの出し分け。条件の形は一斉配信・シナリオと同じ
  -- （SegmentCondition の JSON）。priority は当てはまったときの順番で、
  -- 小さいほうが先。
  targeting_condition TEXT,
  targeting_priority  INTEGER NOT NULL DEFAULT 0,
  targeting_enabled   INTEGER NOT NULL DEFAULT 0,
  -- 159: フォルダで分ける。箱そのものは folders（kind='rich_menu'）。
  folder_id           TEXT REFERENCES folders(id) ON DELETE SET NULL,
  -- 160: 自分で決める並び順。小さいほど先。同じなら更新の新しい順。
  display_order       INTEGER NOT NULL DEFAULT 0,
  -- V8: トークを開いたときメニューを出した状態にするか（LINE payload の
  -- `selected`）。0=閉じておく（従来どおり）、1=開いておく。
  default_open        INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, publishing_owner TEXT, publishing_expires_at TEXT, publishing_generation INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);

CREATE TABLE rich_menu_manual_publish_requests (
  id                    TEXT PRIMARY KEY,
  group_id              TEXT NOT NULL REFERENCES rich_menu_groups(id) ON DELETE CASCADE,
  account_id            TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  definition_snapshot   TEXT NOT NULL,
  request_fingerprint   TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  result_json           TEXT,
  last_error_code       TEXT,
  requested_by_staff_id TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL, execution_token TEXT,
  UNIQUE (account_id, idempotency_key)
);

CREATE TABLE rich_menu_manual_publish_shells (
  request_id       TEXT NOT NULL REFERENCES rich_menu_manual_publish_requests(id) ON DELETE CASCADE,
  page_id          TEXT NOT NULL,
  order_index      INTEGER NOT NULL,
  new_richmenu_id  TEXT NOT NULL,
  old_richmenu_id  TEXT,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (request_id, page_id)
);

CREATE TABLE rich_menu_pages (
  id                 TEXT PRIMARY KEY,
  group_id           TEXT NOT NULL REFERENCES rich_menu_groups(id) ON DELETE CASCADE,
  order_index        INTEGER NOT NULL,
  name               TEXT NOT NULL,
  alias_id           TEXT NOT NULL,
  line_richmenu_id   TEXT,
  image_r2_key       TEXT,
  image_content_type TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (group_id, order_index)
);

CREATE TABLE rich_menu_publish_run_pages (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES rich_menu_publish_runs(id) ON DELETE CASCADE,
  page_id             TEXT NOT NULL,
  order_index         INTEGER NOT NULL,
  alias_id            TEXT NOT NULL,
  old_line_richmenu_id TEXT,
  new_line_richmenu_id TEXT,
  create_status       TEXT NOT NULL DEFAULT 'pending'
    CHECK (create_status IN ('pending', 'succeeded', 'failed')),
  image_status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (image_status IN ('pending', 'succeeded', 'failed')),
  alias_status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (alias_status IN ('pending', 'succeeded', 'failed')),
  cleanup_status      TEXT NOT NULL DEFAULT 'pending'
    CHECK (cleanup_status IN ('pending', 'succeeded', 'failed', 'skipped')),
  last_error_code     TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
);

CREATE TABLE rich_menu_publish_runs (
  id                    TEXT PRIMARY KEY,
  group_id              TEXT NOT NULL REFERENCES rich_menu_groups(id) ON DELETE CASCADE,
  version_id            TEXT REFERENCES rich_menu_versions(id) ON DELETE SET NULL,
  idempotency_key       TEXT NOT NULL,
  mode                  TEXT NOT NULL
    CHECK (mode IN ('publish', 'unpublish', 'retry', 'reconcile', 'scheduled_reconcile')),
  status                TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'failed')),
  requested_by_staff_id TEXT,
  -- 照合のときだけ使う。見つかったずれの一覧（JSON配列）。
  diffs_json            TEXT,
  last_error_code       TEXT,
  started_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  completed_at          TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
);

CREATE TABLE rich_menu_schedule_publications (
  schedule_id      TEXT NOT NULL REFERENCES rich_menu_schedules(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL DEFAULT 'publish' CHECK (kind IN ('publish', 'restore')),
  page_id          TEXT NOT NULL,
  line_richmenu_id TEXT NOT NULL,
  run_id           TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (schedule_id, kind, page_id)
);

CREATE TABLE rich_menu_schedules (
  id                    TEXT PRIMARY KEY,
  group_id              TEXT NOT NULL REFERENCES rich_menu_groups(id) ON DELETE CASCADE,
  account_id            TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  mode                  TEXT NOT NULL CHECK (mode IN ('scheduled', 'period')),
  starts_at             TEXT NOT NULL,
  ends_at               TEXT,
  restore_group_id      TEXT REFERENCES rich_menu_groups(id) ON DELETE SET NULL,
  definition_snapshot   TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'scheduled'
                        CHECK (status IN ('scheduled', 'publishing', 'published', 'restoring', 'completed', 'cancelled', 'failed')),
  idempotency_key       TEXT NOT NULL,
  requested_by_staff_id TEXT NOT NULL,
  started_run_id        TEXT,
  ended_run_id          TEXT,
  last_error_code       TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0), next_retry_at TEXT, lease_expires_at TEXT, restore_default_state TEXT
  CHECK (restore_default_state IN ('captured', 'no_default')), restore_default_line_id TEXT,
  CHECK (mode = 'scheduled' OR ends_at IS NOT NULL),
  UNIQUE (account_id, idempotency_key)
);

CREATE TABLE rich_menu_test_applies (
  id                    TEXT PRIMARY KEY,
  group_id              TEXT NOT NULL REFERENCES rich_menu_groups(id) ON DELETE CASCADE,
  account_id            TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  staff_id              TEXT NOT NULL,
  line_user_id          TEXT NOT NULL,
  /** 適用前にその人へ出ていたLINEメニュー。無ければ NULL。戻す時の行き先。 */
  previous_richmenu_id  TEXT,
  /** previous を読み終えた印。0のままなら再開時に読み直す。 */
  previous_captured     INTEGER NOT NULL DEFAULT 0,
  /** 本人へ割り当てたメニュー(既定ページ)。公開済みなら既存ID、下書きなら lht: メニュー。 */
  applied_richmenu_id   TEXT,
  /** 下書きテストで作ったLINEメニューIDのJSON配列。戻す時に消す。 */
  test_shell_ids        TEXT,
  status                TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','applied','reverting','reverted','failed')),
  last_error_code       TEXT,
  idempotency_key       TEXT NOT NULL,
  revert_idempotency_key TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (account_id, idempotency_key)
);

CREATE TABLE rich_menu_versions (
  id                   TEXT PRIMARY KEY,
  group_id             TEXT NOT NULL REFERENCES rich_menu_groups(id) ON DELETE CASCADE,
  version_number       INTEGER NOT NULL CHECK (version_number >= 1),
  -- 公開を実行した時点の下書きの中身（ページ・領域・割当条件の写し）。
  definition_snapshot  TEXT NOT NULL,
  -- 下書きの要約と公開版の照合に使う。下書きが変わると変わる。
  definition_fingerprint TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  created_by_staff_id  TEXT,
  published_at         TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
);

CREATE TABLE rt_approval_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES rt_organizations(id) ON DELETE CASCADE,
  store_id TEXT REFERENCES rt_stores(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('gbp_post', 'line_message', 'menu_change')),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'scheduled', 'completed', 'returned')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  requested_by TEXT,
  reviewed_by TEXT,
  review_comment TEXT,
  scheduled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE rt_channel_close_tasks (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES rt_stores(id), slot_id TEXT NOT NULL REFERENCES rt_inventory_slots(id),
 channel TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('close','done','reopen')),
 reason TEXT NOT NULL CHECK(reason IN ('full','limited','table_conflict')), remaining_seats INTEGER NOT NULL,
 recipient_ids_json TEXT NOT NULL DEFAULT '[]', generation INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT(datetime('now')), updated_at TEXT NOT NULL DEFAULT(datetime('now')), trigger_reservation_id TEXT, trigger_source TEXT, trigger_sources_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(trigger_sources_json) AND json_type(trigger_sources_json)='array'),
 UNIQUE(slot_id,channel)
);

CREATE TABLE rt_close_notification_settings (
 store_id TEXT PRIMARY KEY REFERENCES rt_stores(id), notify_reopen INTEGER NOT NULL DEFAULT 1 CHECK(notify_reopen IN (0,1)),
 recipient_mode TEXT NOT NULL DEFAULT 'responsible' CHECK(recipient_mode IN ('responsible','manager','selected')),
 membership_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(membership_ids_json)), version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE rt_closure_close_outbox (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES rt_closure_close_tasks(id), generation INTEGER NOT NULL,
 membership_id TEXT NOT NULL REFERENCES rt_memberships(id), retry_key TEXT NOT NULL, sent_at TEXT, lease_until TEXT, lease_token TEXT,
 UNIQUE(task_id,generation,membership_id)
);

CREATE TABLE rt_closure_close_tasks (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES rt_stores(id), closure_id TEXT NOT NULL REFERENCES rt_closures(id),
 closure_version INTEGER NOT NULL, channel TEXT NOT NULL, kind TEXT NOT NULL,
 start_date TEXT NOT NULL, end_date TEXT NOT NULL, all_day INTEGER NOT NULL, start_time TEXT, end_time TEXT,
 table_ids_json TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('close','done','reopen')), generation INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT(datetime('now')), updated_at TEXT NOT NULL DEFAULT(datetime('now')),
 UNIQUE(closure_id,closure_version,channel)
);

CREATE TABLE rt_closures (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES rt_stores(id),
 start_date TEXT NOT NULL, end_date TEXT NOT NULL CHECK(end_date>=start_date),
 all_day INTEGER NOT NULL CHECK(all_day IN (0,1)), start_time TEXT, end_time TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('temporary_closed','private_event','maintenance','other')),
 memo TEXT, table_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(table_ids_json) AND json_type(table_ids_json)='array'),
 periods_json TEXT NOT NULL CHECK(json_valid(periods_json) AND json_type(periods_json)='array' AND json_array_length(periods_json)>0),
 created_by TEXT, created_by_name TEXT, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_at TEXT NOT NULL DEFAULT(datetime('now')), updated_at TEXT NOT NULL DEFAULT(datetime('now')), archived_at TEXT, notify_media INTEGER NOT NULL DEFAULT 1 CHECK(notify_media IN (0,1)),
 CHECK((all_day=1 AND start_time IS NULL AND end_time IS NULL) OR (all_day=0 AND start_time IS NOT NULL AND end_time>start_time))
);

CREATE TABLE rt_connector_status (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('restaurant_board', 'reszaiko', 'hotpepper', 'tabelog', 'gurunavi', 'ikyu', 'retty', 'google_business_profile', 'line')),
  mode TEXT NOT NULL DEFAULT 'disabled' CHECK (mode IN ('disabled', 'inbound_only')),
  status TEXT NOT NULL DEFAULT 'unconfigured' CHECK (status IN ('connected', 'warning', 'error', 'unconfigured', 'disabled')),
  last_synced_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(store_id, provider)
);

CREATE TABLE rt_customer_notice_outbox (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES rt_stores(id),
 reservation_id TEXT NOT NULL REFERENCES rt_reservations(id), customer_version INTEGER NOT NULL,
 line_uid TEXT NOT NULL, message TEXT NOT NULL, retry_key TEXT NOT NULL UNIQUE,
 sent_at TEXT, lease_until TEXT, lease_token TEXT, created_at TEXT NOT NULL DEFAULT(datetime('now')), valid INTEGER NOT NULL DEFAULT 1 CHECK(valid IN(0,1)),
 UNIQUE(reservation_id,customer_version)
);

CREATE TABLE rt_delivery_dispatches (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  service TEXT NOT NULL CHECK (service IN ('ubereats','demaecan','rocketnow')),
  action TEXT NOT NULL CHECK (action IN (
    'accept','reject','ready','handed_over','cancel',
    'menu_sold_out','menu_resume','intake_stop','intake_resume'
  )),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('order','menu_item','service')),
  target_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','succeeded','failed','retryable_failed','exhausted')),
  -- 失敗は分類済みの符号だけを残す。サービスから返った自由文・本文・例外は保存しない。
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER,
  requested_at INTEGER NOT NULL,
  completed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE rt_delivery_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  service TEXT NOT NULL CHECK (service IN ('ubereats','demaecan','rocketnow')),
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  external_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','processed','failed','retryable_failed','ignored')),
  -- 共通形式へ変換する前の本文。再処理に使う。サービスから返った自由文のエラー本文は入れない。
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (service, external_event_id)
);

CREATE TABLE rt_delivery_menu_items (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  price INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),
  sold_out INTEGER NOT NULL DEFAULT 0 CHECK (sold_out IN (0,1)),
  sold_out_at INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- サービスごとの商品ID（{"ubereats":"...","demaecan":"..."}）。未連携は入れない。
  external_item_ids_json TEXT
    CHECK (external_item_ids_json IS NULL OR json_valid(external_item_ids_json)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (store_id, name)
);

CREATE TABLE rt_delivery_order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  name TEXT NOT NULL,
  -- 「特製タレ増量（無料）」のような補足行。無ければ NULL。
  note TEXT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE (order_id, position)
);

CREATE TABLE "rt_delivery_orders" (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  -- 'line' を追加。LINEから直接受けた注文も同じ表に並べ、画面と日次売上を1本に保つ。
  service TEXT NOT NULL CHECK (service IN ('ubereats','demaecan','rocketnow','line')),
  external_order_id TEXT NOT NULL,
  order_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','cooking','ready','handed_over','canceled','rejected')),
  total_amount INTEGER NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'JPY',
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  pickup_method TEXT,
  wanted_at INTEGER,
  customer_note TEXT,
  urgency TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('urgent','normal','watch')),
  urgency_reason TEXT,
  urgency_computed_at INTEGER,
  cancel_reason_code TEXT,
  canceled_by TEXT CHECK (canceled_by IS NULL OR canceled_by IN ('store','customer','service')),
  received_at INTEGER NOT NULL,
  accepted_at INTEGER,
  ready_at INTEGER,
  handed_over_at INTEGER,
  canceled_at INTEGER,
  -- 注文がどこから来たか。既存の3サービス経由は 'external'、LINEの自社注文は 'line_direct'。
  -- 既存行は 'external' のまま。手数料の考え方が違うので service とは別に持つ。
  order_source TEXT NOT NULL DEFAULT 'external'
    CHECK (order_source IN ('external','line_direct')),
  -- 配達を誰が運ぶか。'service'=そのサービスの配達員（既存）、'store'=店舗が自分で運ぶ、
  -- 'uber_direct'/'wolt_drive'=自社注文の配送委託先（フェーズ2）。未確定は NULL。
  delivery_provider TEXT CHECK (delivery_provider IS NULL OR delivery_provider IN (
    'service','store','uber_direct','wolt_drive'
  )),
  -- 委託先が払い出す配達の追跡ID。お客様への追跡案内と、失敗時の照会に使う。
  delivery_tracking_id TEXT,
  -- 委託先へ実際に払った配送実費（円）。サービスの手数料と比べて得かどうかを
  -- 後から数字で示すために、注文の行に残す。外部サービス経由の注文では NULL。
  delivery_fee_amount INTEGER CHECK (delivery_fee_amount IS NULL OR delivery_fee_amount >= 0),
  -- 自動適用したクーポン。金額の内訳を後から説明できるようにする。
  coupon_id TEXT,
  -- 注文したお客様（友だち）。LINEから直接受けた注文に後続の配信やタグ付けを繋げるため。
  -- 外部サービス経由の注文は相手のIDを貰えないので NULL。本人が特定できる前の
  -- 下書き段階でも入れられるよう、NULL を許す。
  friend_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (service, external_order_id),
  -- 外部サービス経由の注文に委託配送は付かない。経路と業者の食い違いを表の側で止める。
  CHECK (order_source = 'line_direct' OR delivery_provider IS NULL OR delivery_provider IN ('service','store')),
  CHECK (order_source = 'external' OR service = 'line')
);

CREATE TABLE rt_delivery_service_states (
  account_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  service TEXT NOT NULL CHECK (service IN ('ubereats','demaecan','rocketnow')),
  connection_status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (connection_status IN ('connected','disconnected','error')),
  intake_status TEXT NOT NULL DEFAULT 'open' CHECK (intake_status IN ('open','stopped')),
  -- 受付停止の自動再開時刻（30分・60分・90分・本日中）。停止していない間は NULL。
  stop_until INTEGER,
  stop_requested_at INTEGER,
  stop_requested_by TEXT,
  resumed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (store_id, service),
  CHECK (intake_status = 'stopped' OR stop_until IS NULL)
);

CREATE TABLE rt_delivery_uber_app_tokens (
  id TEXT PRIMARY KEY,
  access_token_enc TEXT NOT NULL,
  access_token_expires_at INTEGER NOT NULL,
  granted_scope TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE rt_delivery_uber_connections (
  store_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  -- Uber 側の店舗ID。これが照合の正。外部店舗IDは変わりうるので単独の照合キーにしない。
  uber_store_id TEXT,
  uber_store_name TEXT,
  external_store_id TEXT,
  access_token_enc TEXT,
  access_token_expires_at INTEGER,
  -- 許された権限を空白区切りで記録する。要求と違う権限が返ったときの切り分けに使う。
  granted_scope TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('pending_store', 'connected', 'expired', 'no_permission', 'disconnected')),
  connected_by_staff_id TEXT,
  connected_at INTEGER,
  disconnected_at INTEGER,
  -- POST /pos_data が通った時刻。ここが入って初めて Uber 側で連携が有効。
  provisioned_at INTEGER,
  last_error TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE rt_delivery_uber_oauth_states (
  state TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('connect', 'reconnect')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE rt_delivery_uber_store_candidates (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  uber_store_id TEXT NOT NULL,
  uber_store_name TEXT NOT NULL,
  external_store_id TEXT,
  address_text TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (store_id, uber_store_id)
);

CREATE TABLE rt_email_digests (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES rt_media(id),
  target_date TEXT NOT NULL,
  reported_count INTEGER NOT NULL CHECK (reported_count >= 0),
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  inbound_email_id TEXT NOT NULL UNIQUE REFERENCES rt_inbound_emails(id)
);

CREATE TABLE rt_floors (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES rt_stores(id), name TEXT NOT NULL,
 width REAL NOT NULL DEFAULT 1000 CHECK(width>0), height REAL NOT NULL DEFAULT 700 CHECK(height>0),
 outline_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(outline_json)),
 fixtures_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(fixtures_json)),
 version INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL DEFAULT 'floor' CHECK(kind IN ('floor','area')), parent_floor_id TEXT REFERENCES rt_floors(id), sort_order INTEGER NOT NULL DEFAULT 0, archived_at TEXT, archived_name TEXT, UNIQUE(store_id,name)
);

CREATE TABLE rt_gbp_posts (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  post_type TEXT NOT NULL CHECK (post_type IN ('standard', 'event', 'offer')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  media_url TEXT,
  cta_type TEXT CHECK (cta_type IN ('book', 'call', 'learn_more')),
  cta_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'scheduled', 'published')),
  scheduled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE rt_gbp_reviews (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  external_review_id TEXT NOT NULL,
  author_name TEXT,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  reviewed_at TEXT NOT NULL,
  reply_status TEXT NOT NULL DEFAULT 'unreplied' CHECK (reply_status IN ('unreplied', 'draft', 'approved', 'replied')),
  reply_draft TEXT,
  sentiment TEXT CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(store_id, external_review_id)
);

CREATE TABLE rt_google_changes (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('special_hours', 'regular_hours', 'profile', 'photo')),
  source TEXT NOT NULL CHECK (source IN ('shortcut', 'text', 'calendar', 'weekly', 'profile_edit', 'photo')),
  summary TEXT NOT NULL,
  target_json TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT NOT NULL,
  input_text TEXT,
  reservation_impact_count INTEGER NOT NULL DEFAULT 0,
  base_fingerprint TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_confirm', 'accepted', 'applied', 'failed', 'conflict', 'cancelled')),
  staff_id TEXT,
  staff_name TEXT,
  request_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  applied_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE rt_google_connections (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL UNIQUE REFERENCES rt_stores(id) ON DELETE CASCADE,
  line_account_id TEXT REFERENCES line_accounts(id),
  google_account_email TEXT,
  location_name TEXT,
  location_title TEXT,
  location_maps_url TEXT,
  refresh_token_enc TEXT,
  access_token_enc TEXT,
  access_token_expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('pending_location', 'connected', 'expired', 'no_permission', 'disconnected')),
  connected_by_staff_id TEXT,
  connected_at TEXT,
  disconnected_at TEXT,
  last_synced_at TEXT,
  last_sync_error TEXT,
  average_rating REAL,
  total_review_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, last_posts_synced_at TEXT, last_metrics_synced_at TEXT);

CREATE TABLE rt_google_location_candidates (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  location_name TEXT NOT NULL,
  location_title TEXT NOT NULL,
  address_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(store_id, location_name)
);

CREATE TABLE rt_google_metrics_daily (
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                       -- YYYY-MM-DD（店舗所在地の暦日。Googleの日次区切りに従う）

  -- プロフィール表示（Business Impressions）の内訳
  impressions_desktop_maps INTEGER,
  impressions_desktop_search INTEGER,
  impressions_mobile_maps INTEGER,
  impressions_mobile_search INTEGER,

  -- 行動（クリック等）
  direction_requests INTEGER,               -- ルート検索
  call_clicks INTEGER,                      -- 電話ボタンのクリック（通話成立数ではない）
  website_clicks INTEGER,                   -- サイトへのクリック

  -- 飲食店向け
  menu_clicks INTEGER,                      -- メニュー閲覧
  bookings INTEGER,                         -- Google経由の予約（連携サービス未対応の店舗は NULL）
  food_orders INTEGER,                      -- 料理の注文（同上）

  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (store_id, date)
);

CREATE TABLE rt_google_oauth_states (
  state TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  line_account_id TEXT,
  staff_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('connect', 'reconnect')),
  code_verifier_enc TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE rt_google_posts (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('standard', 'event', 'offer', 'alert')),
  origin TEXT NOT NULL DEFAULT 'admin' CHECK (origin IN ('admin', 'google')),

  -- 本文・タイトル（イベント／特典はタイトル必須。最新情報は空文字のまま使わない）
  summary TEXT NOT NULL DEFAULT '',
  title TEXT,

  -- イベント／特典の期間。Google の TimeInterval は日付と時刻が別項目なので分けて持つ。
  -- タイムゾーンは店舗の所在地に合わせてGoogle側が解釈する（既定Asia/Tokyo）。
  event_start_date TEXT,
  event_start_time TEXT,
  event_end_date TEXT,
  event_end_time TEXT,

  -- ボタン。特典（offer）ではGoogleが無視するため送らない（画面にも出さない）。
  cta_type TEXT CHECK (cta_type IN ('none', 'book', 'order', 'shop', 'learn_more', 'sign_up', 'call')),
  cta_url TEXT,

  -- 特典だけの項目（いずれも任意）
  coupon_code TEXT,
  redeem_online_url TEXT,
  terms_conditions TEXT,

  -- 画像。[{ mediaId, filename, sourceUrl }] のJSON配列。第3段は社内の登録メディアから1枚まで。
  -- Local Posts の media は sourceUrl のみ対応のため、登録メディアの公開URLをそのまま入れる。
  media_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(media_json)),

  publish_mode TEXT NOT NULL DEFAULT 'now' CHECK (publish_mode IN ('now', 'scheduled')),
  publish_at TEXT,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'pending_confirm', 'accepted', 'published',
                      'rejected', 'failed', 'cancelled', 'deleted')),

  -- Google 側の識別子。accounts/{account}/locations/{location}/localPosts/{id} の形。
  google_post_name TEXT,
  google_state TEXT,
  search_url TEXT,
  google_create_time TEXT,
  google_update_time TEXT,

  -- 送信内容の指紋（SHA-256先頭32文字）。送信結果が不明なとき、Googleの一覧から
  -- 自分が出した投稿を見つけて二重投稿を避けるための照合キー。
  content_fingerprint TEXT,
  request_id TEXT,

  staff_id TEXT,
  staff_name TEXT,
  error TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  sent_at TEXT,
  published_at TEXT,
  checked_at TEXT,
  deleted_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, instagram_enabled INTEGER NOT NULL DEFAULT 0 CHECK(instagram_enabled IN (0,1)), instagram_caption TEXT, instagram_status TEXT NOT NULL DEFAULT 'none' CHECK(instagram_status IN ('none','pending','published','failed','skipped')), instagram_media_id TEXT, instagram_permalink TEXT, instagram_error TEXT, instagram_published_at TEXT);

CREATE TABLE rt_google_profiles (
  store_id TEXT PRIMARY KEY REFERENCES rt_stores(id) ON DELETE CASCADE,
  location_name TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE rt_google_reviews (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  review_name TEXT NOT NULL,
  reviewer_display_name TEXT,
  star_rating INTEGER NOT NULL CHECK (star_rating BETWEEN 1 AND 5),
  comment TEXT,
  create_time TEXT NOT NULL,
  update_time TEXT,
  needs_attention INTEGER NOT NULL DEFAULT 0,
  reply_status TEXT NOT NULL DEFAULT 'unreplied'
    CHECK (reply_status IN ('unreplied', 'draft', 'pending_confirm', 'replied', 'published')),
  reply_draft TEXT,
  reply_draft_ai_generated INTEGER NOT NULL DEFAULT 0,
  reply_draft_generated_at TEXT,
  reply_comment TEXT,
  reply_update_time TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(store_id, review_name)
);

CREATE TABLE rt_google_write_log (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('review_reply', 'connect', 'reconnect', 'disconnect')),
  target_name TEXT,
  staff_id TEXT,
  before_text TEXT,
  after_text TEXT,
  request_id TEXT,
  result TEXT NOT NULL CHECK (result IN ('accepted', 'failed', 'unknown')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE rt_inbound_emails (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  store_id TEXT REFERENCES rt_stores(id) ON DELETE SET NULL,
  r2_key TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'storing'
    CHECK (status IN ('storing', 'stored', 'received', 'quarantined', 'storage_failed', 'raw_deleted')),
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  quarantine_reason TEXT
, media_id TEXT REFERENCES rt_media(id));

CREATE TABLE rt_intake_addresses (
  id TEXT PRIMARY KEY,
  local_part TEXT NOT NULL UNIQUE,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE TABLE rt_inventory_notification_outbox (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES rt_channel_close_tasks(id), generation INTEGER NOT NULL,
 membership_id TEXT NOT NULL REFERENCES rt_memberships(id), retry_key TEXT NOT NULL, sent_at TEXT,
 lease_until TEXT, lease_token TEXT, UNIQUE(task_id,generation,membership_id)
);

CREATE TABLE rt_inventory_rule_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT NOT NULL, slot_id TEXT NOT NULL, starts_at TEXT NOT NULL,
 before_line INTEGER NOT NULL, after_line INTEGER NOT NULL, before_same_day INTEGER NOT NULL, after_same_day INTEGER NOT NULL,
 cause TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT(datetime('now'))
);

CREATE TABLE rt_inventory_rule_queue (
 store_id TEXT PRIMARY KEY REFERENCES rt_stores(id), generation INTEGER NOT NULL DEFAULT 1,
 cause TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);

CREATE TABLE rt_inventory_rule_source_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 store_id TEXT NOT NULL REFERENCES rt_stores(id), slot_id TEXT NOT NULL REFERENCES rt_inventory_slots(id),
 reservation_id TEXT NOT NULL, source TEXT NOT NULL, event TEXT NOT NULL CHECK(event IN ('insert','update','delete')),
 created_at TEXT NOT NULL DEFAULT(datetime('now'))
);

CREATE TABLE rt_inventory_rules (
 store_id TEXT PRIMARY KEY REFERENCES rt_stores(id), threshold INTEGER NOT NULL CHECK(threshold>=0),
 stop_line INTEGER NOT NULL CHECK(stop_line IN (0,1)), stop_same_day INTEGER NOT NULL CHECK(stop_same_day IN (0,1)),
 notify INTEGER NOT NULL CHECK(notify IN (0,1)), version INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);

CREATE TABLE rt_inventory_slots (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  slot_minutes INTEGER NOT NULL DEFAULT 30 CHECK (slot_minutes IN (15, 30)),
  total_capacity INTEGER NOT NULL CHECK (total_capacity >= 0),
  ota_capacity INTEGER NOT NULL DEFAULT 0 CHECK (ota_capacity >= 0),
  line_capacity INTEGER NOT NULL DEFAULT 0 CHECK (line_capacity >= 0),
  walk_in_capacity INTEGER NOT NULL DEFAULT 0 CHECK (walk_in_capacity >= 0),
  reserved_count INTEGER NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1), updated_by TEXT, same_day_capacity INTEGER NOT NULL DEFAULT 0 CHECK(same_day_capacity>=0), auto_line_original INTEGER, auto_same_day_original INTEGER,
  UNIQUE(store_id, starts_at)
);

CREATE TABLE rt_line_flows (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES rt_organizations(id) ON DELETE CASCADE,
  store_id TEXT REFERENCES rt_stores(id) ON DELETE CASCADE,
  flow_type TEXT NOT NULL CHECK (flow_type IN ('reservation_24h', 'reservation_2h', 'post_visit', 'review_request', 'member_card', 'one_tap_booking')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  timing_minutes INTEGER,
  is_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
  delivery_mode TEXT NOT NULL DEFAULT 'preview_only' CHECK (delivery_mode IN ('preview_only', 'disabled')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(organization_id, store_id, flow_type)
);

CREATE TABLE "rt_media" (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sender_addresses TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sender_addresses)),
  parser_key TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
, accepts_reservations INTEGER NOT NULL DEFAULT 1 CHECK(accepts_reservations IN (0,1)));

CREATE TABLE rt_memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES rt_organizations(id) ON DELETE CASCADE,
  store_id TEXT REFERENCES rt_stores(id) ON DELETE CASCADE,
  staff_name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'store_manager', 'staff')),
  line_uid TEXT,
  google_email TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, staff_id TEXT REFERENCES staff_members(id) ON DELETE SET NULL);

CREATE TABLE rt_menu_change_requests (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL UNIQUE REFERENCES rt_approval_requests(id),
  menu_id TEXT NOT NULL REFERENCES rt_menu_items(id),
  store_id TEXT NOT NULL REFERENCES rt_stores(id),
  before_price INTEGER NOT NULL CHECK (before_price >= 0),
  after_price INTEGER NOT NULL CHECK (after_price >= 0),
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'returned', 'applied', 'failed')),
  return_reason TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, effective_at TEXT);

CREATE TABLE rt_menu_items (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('course', 'a_la_carte')),
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  tax_mode TEXT NOT NULL DEFAULT 'tax_included' CHECK (tax_mode IN ('tax_included', 'tax_excluded')),
  allergens_json TEXT NOT NULL DEFAULT '[]',
  service_periods_json TEXT NOT NULL DEFAULT '["dinner"]',
  duration_minutes INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, published_once INTEGER NOT NULL DEFAULT 0 CHECK (published_once IN (0, 1)), publication_history_unknown INTEGER NOT NULL DEFAULT 0 CHECK (publication_history_unknown IN (0, 1)), description TEXT, image_media_id TEXT REFERENCES media(id));

CREATE TABLE rt_opening_hours_settings (
  store_id TEXT PRIMARY KEY REFERENCES rt_stores(id) ON DELETE CASCADE,
  hours_json TEXT NOT NULL CHECK (json_valid(hours_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, late_cancel_after_minutes INTEGER CHECK(late_cancel_after_minutes BETWEEN 1 AND 1440), late_arrival_message TEXT CHECK(length(late_arrival_message)<=1000));

CREATE TABLE rt_organization_agreements (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES rt_organizations(id) ON DELETE CASCADE,
  document_key TEXT NOT NULL,
  document_version TEXT NOT NULL,
  agreed_by_staff_id TEXT,
  agreed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(organization_id, document_key, document_version)
);

CREATE TABLE rt_organizations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'test' CHECK (status IN ('test', 'active', 'archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, tenant_id TEXT REFERENCES tenants(id));

CREATE TABLE rt_reservation_close_outbox (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES rt_reservation_close_tasks(id), generation INTEGER NOT NULL,
 membership_id TEXT NOT NULL REFERENCES rt_memberships(id), retry_key TEXT NOT NULL, sent_at TEXT, lease_until TEXT, lease_token TEXT,
 UNIQUE(task_id,generation,membership_id)
);

CREATE TABLE rt_reservation_close_tasks (
 id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES rt_stores(id), reservation_id TEXT NOT NULL REFERENCES rt_reservations(id),
 channel TEXT NOT NULL, starts_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('close','done','reopen')),
 generation INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT(datetime('now')), updated_at TEXT NOT NULL DEFAULT(datetime('now')), trigger_source TEXT,
 UNIQUE(reservation_id,channel,starts_at)
);

CREATE TABLE rt_reservation_confirmations (
 request_id TEXT PRIMARY KEY,
 reservation_id TEXT NOT NULL REFERENCES rt_reservations(id),
 reservation_version INTEGER NOT NULL CHECK(reservation_version>=1),
 friend_id TEXT NOT NULL REFERENCES friends(id),
 response TEXT CHECK(response IN('going','change_requested','cancel')),
 requested_at TEXT NOT NULL,
 responded_at TEXT,
 expires_at TEXT NOT NULL,
 UNIQUE(reservation_id,reservation_version,request_id)
);

CREATE TABLE rt_reservation_departures (
 id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES rt_reservations(id),
 store_id TEXT NOT NULL REFERENCES rt_stores(id), request_id TEXT NOT NULL,
 occurred_at TEXT NOT NULL, actor_id TEXT, undone_at TEXT, undone_by TEXT, undone_request_id TEXT, result_version INTEGER,
 UNIQUE(reservation_id,request_id)
);

CREATE TABLE rt_reservation_event_receipts (
 event_id TEXT NOT NULL REFERENCES rt_reservation_events(id), consumer_key TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','running','succeeded','failed')),
 attempt_count INTEGER NOT NULL DEFAULT 0, lease_until TEXT, lease_owner TEXT, next_attempt_at TEXT, result_ref TEXT,
 PRIMARY KEY(event_id,consumer_key)
);

CREATE TABLE rt_reservation_events (
 id TEXT PRIMARY KEY, reservation_id TEXT REFERENCES rt_reservations(id),
 store_id TEXT NOT NULL REFERENCES rt_stores(id), event_type TEXT NOT NULL,
 reservation_version INTEGER NOT NULL, occurred_at TEXT NOT NULL, request_id TEXT NOT NULL,
 line_account_id TEXT, friend_id TEXT, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 UNIQUE(reservation_id,reservation_version,event_type)
);

CREATE TABLE rt_reservation_external_links (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES rt_stores(id),
  provider TEXT NOT NULL CHECK (provider IN ('restaurant_board','reszaiko','hotpepper','tabelog','gurunavi','ikyu','retty','google_reservation','tablecheck')),
  external_id TEXT NOT NULL CHECK (length(trim(external_id)) BETWEEN 1 AND 200 AND external_id = trim(external_id)),
  reservation_id TEXT NOT NULL REFERENCES rt_reservations(id),
  origin_provider TEXT CHECK (origin_provider IS NULL OR origin_provider IN ('restaurant_board','reszaiko','hotpepper','tabelog','gurunavi','ikyu','retty','google_reservation','tablecheck')),
  provider_updated_at TEXT,
  last_event_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  unlinked_at TEXT,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (store_id, provider, external_id)
);

CREATE TABLE rt_reservation_links (
 store_id TEXT PRIMARY KEY REFERENCES rt_stores(id), token TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL DEFAULT(datetime('now'))
);

CREATE TABLE rt_reservation_referrals (
 id TEXT PRIMARY KEY,
 source_store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
 target_store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
 source_reservation_id TEXT REFERENCES rt_reservations(id) ON DELETE SET NULL,
 source_waitlist_id TEXT REFERENCES rt_seat_waitlist(id) ON DELETE SET NULL,
 offered_at TEXT NOT NULL DEFAULT(datetime('now')),
 accepted_at TEXT,
 CHECK(source_store_id<>target_store_id)
);

CREATE TABLE rt_reservation_table_links (
 reservation_id TEXT NOT NULL REFERENCES rt_reservations(id) ON DELETE CASCADE,
 table_id TEXT NOT NULL REFERENCES rt_tables(id), PRIMARY KEY(reservation_id,table_id)
);

CREATE TABLE "rt_reservations" (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('restaurant_board', 'reszaiko', 'hotpepper', 'tabelog', 'gurunavi', 'ikyu', 'retty', 'line', 'phone', 'manual', 'walk_in')),
  external_id TEXT,
  hub_source TEXT,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  line_uid TEXT,
  guest_count INTEGER NOT NULL CHECK (guest_count > 0),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  table_id TEXT REFERENCES rt_tables(id) ON DELETE SET NULL,
  course_id TEXT REFERENCES rt_menu_items(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'seated', 'visited', 'cancelled', 'no_show')),
  allergy_note TEXT,
  note TEXT,
  sync_direction TEXT NOT NULL DEFAULT 'inbound_only' CHECK (sync_direction = 'inbound_only'),
  source_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, media_id TEXT REFERENCES rt_media(id), hold_expires_at TEXT, cancel_reason TEXT, stay_minutes INTEGER, media_store_code TEXT, table_label TEXT, inbound_email_id TEXT REFERENCES rt_inbound_emails(id), parser_key TEXT, parser_version TEXT, waitlist_entry_id TEXT, customer_version INTEGER NOT NULL DEFAULT 1, customer_request_id TEXT, dining_snapshot_json TEXT CHECK(dining_snapshot_json IS NULL OR json_valid(dining_snapshot_json)), departed_at TEXT, staff_id TEXT REFERENCES staff(id));

CREATE TABLE rt_resource_locks (
  resource_key TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE rt_seat_visit_marks (
  id                    TEXT PRIMARY KEY,
  reservation_id        TEXT NOT NULL REFERENCES rt_reservations(id) ON DELETE CASCADE,
  store_id              TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  -- visited: 来店した / late: 遅れる / no_show: 来なかった
  kind                  TEXT NOT NULL CHECK (kind IN ('visited', 'late', 'no_show')),
  -- late のときだけ必須の遅れ分数。
  late_minutes          INTEGER CHECK (late_minutes IS NULL OR (late_minutes BETWEEN 1 AND 1440)),
  -- 付けた人（ログイン利用者）。監査の actor と同じ考え方で外部キーは付けない。
  marked_by_staff_id    TEXT,
  marked_by_name        TEXT,
  -- UTC ISO8601。付けた時刻。
  marked_at             TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')), undone_at TEXT, undone_by TEXT, request_id TEXT, undone_request_id TEXT, result_version INTEGER,
  CHECK ((kind = 'late' AND late_minutes IS NOT NULL)
      OR (kind != 'late' AND late_minutes IS NULL))
);

CREATE TABLE "rt_seat_waitlist" (
  id                    TEXT PRIMARY KEY,
  store_id              TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  starts_at             TEXT NOT NULL,
  guest_count           INTEGER NOT NULL CHECK (guest_count BETWEEN 1 AND 100),
  customer_name         TEXT NOT NULL,
  customer_phone        TEXT,
  line_uid              TEXT,
  -- 同じ開始時刻に同じ組が二度並べないための鍵（電話番号かLINE IDか名前）。
  identity_key          TEXT NOT NULL,
  -- waiting: 待っている / invited: 空きを知らせた（仮押さえ中）
  -- / converted: 予約になった / cancelled: 本人が取り消した
  status                TEXT NOT NULL DEFAULT 'waiting'
                          CHECK (status IN ('waiting', 'invited', 'converted', 'cancelled', 'finished')),
  hold_minutes          INTEGER NOT NULL DEFAULT 30 CHECK (hold_minutes BETWEEN 1 AND 1440),
  -- 招待したときに空いた席。組の人数が入る席だけを候補にする。
  table_id              TEXT REFERENCES rt_tables(id) ON DELETE SET NULL,
  invited_at            TEXT,
  hold_expires_at       TEXT,
  -- LINE を送った時刻。LINE 未連携の組は店が電話するため NULL のまま。
  notified_at           TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  ends_at TEXT, finish_reason TEXT, notification_retry_key TEXT, notification_claim_until TEXT, last_processed_at TEXT,
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE rt_seat_waitlist_table_links (
 waitlist_id TEXT NOT NULL REFERENCES rt_seat_waitlist(id) ON DELETE CASCADE,
 table_id TEXT NOT NULL REFERENCES rt_tables(id), PRIMARY KEY(waitlist_id,table_id)
);

CREATE TABLE rt_store_feature_flags (
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  feature TEXT NOT NULL CHECK (feature IN (
    'delivery',              -- デリバリー受注そのもの
    'delivery_line_direct',  -- LINEからの自社受注（フェーズ2）
    'delivery_dispatch',     -- 配送を外部業者へ委託する（フェーズ2）
    'reservation',           -- 席の予約
    'coupon'                 -- クーポン
  )),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  config_json TEXT CHECK (config_json IS NULL OR json_valid(config_json)),
  updated_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (store_id, feature)
);

CREATE TABLE rt_store_followup_preferences (
 store_id TEXT PRIMARY KEY REFERENCES rt_stores(id),
 not_using INTEGER NOT NULL DEFAULT 0 CHECK(not_using IN(0,1)),
 decided_at TEXT,
 decided_by TEXT,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
);

CREATE TABLE rt_store_followup_rows (
 store_id TEXT NOT NULL REFERENCES rt_stores(id),
 trigger TEXT NOT NULL CHECK(trigger IN('reservation_created','reservation_24h','reservation_2h','post_visit','review_request','waitlist_invited','anniversary_before')),
 initial_key TEXT NOT NULL,
 step_id TEXT REFERENCES scenario_steps(id) ON DELETE SET NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 PRIMARY KEY(store_id,trigger)
);

CREATE TABLE rt_store_followup_step_bindings (
 store_id TEXT NOT NULL REFERENCES rt_stores(id),
 trigger TEXT NOT NULL,
 step_id TEXT NOT NULL REFERENCES scenario_steps(id),
 offset_minutes INTEGER NOT NULL DEFAULT 0,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
 version INTEGER NOT NULL DEFAULT 1, anniversary_time TEXT NOT NULL DEFAULT '10:00'
 CHECK(anniversary_time GLOB '[0-2][0-9]:[0-5][0-9]' AND anniversary_time<'24:00'),
 PRIMARY KEY(store_id,trigger,step_id)
);

CREATE TABLE rt_store_followup_targets (
 store_id TEXT NOT NULL,
 trigger TEXT NOT NULL,
 engine TEXT NOT NULL DEFAULT 'scenario' CHECK(engine IN ('scenario','reminder','automation')),
 reminder_id TEXT UNIQUE REFERENCES reminders(id),
 automation_id TEXT UNIQUE REFERENCES automation_definitions(id),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 sending_status TEXT NOT NULL DEFAULT 'stopped' CHECK(sending_status IN ('stopped','pending','active')),
 approved_version_id TEXT,
 approved_content_hash TEXT,
 approval_id TEXT REFERENCES rt_approval_requests(id),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
 PRIMARY KEY(store_id,trigger),
 FOREIGN KEY(store_id,trigger) REFERENCES rt_store_followup_rows(store_id,trigger),
 CHECK(engine != 'reminder' OR reminder_id IS NOT NULL),
 CHECK(engine != 'automation' OR automation_id IS NOT NULL),
 CHECK(sending_status != 'active' OR (approval_id IS NOT NULL AND approved_version_id IS NOT NULL AND approved_content_hash IS NOT NULL))
);

CREATE TABLE rt_store_followup_templates (
 store_id TEXT PRIMARY KEY REFERENCES rt_stores(id),
 scenario_id TEXT NOT NULL UNIQUE REFERENCES scenarios(id),
 template_version INTEGER NOT NULL DEFAULT 1,
 sending_status TEXT NOT NULL DEFAULT 'stopped' CHECK(sending_status IN('stopped','pending','active')),
 approved_version_id TEXT REFERENCES scenario_versions(id),
 approval_id TEXT REFERENCES rt_approval_requests(id)
);

CREATE TABLE rt_store_group_members (
 group_id TEXT NOT NULL REFERENCES rt_store_groups(id) ON DELETE CASCADE,
 store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
 referral_enabled INTEGER NOT NULL DEFAULT 0 CHECK(referral_enabled IN(0,1)),
 max_distance REAL NOT NULL DEFAULT 5 CHECK(max_distance>=0 AND max_distance<=1000),
 PRIMARY KEY(group_id,store_id)
);

CREATE TABLE rt_store_groups (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES rt_organizations(id) ON DELETE CASCADE,
 name TEXT NOT NULL
);

CREATE TABLE rt_store_media_links (
 store_id TEXT NOT NULL REFERENCES rt_stores(id), media_id TEXT NOT NULL REFERENCES rt_media(id),
 page_url TEXT, login_url TEXT, close_on_booking INTEGER NOT NULL DEFAULT 0 CHECK(close_on_booking IN (0,1)),
 version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT(datetime('now')),
 PRIMARY KEY(store_id,media_id)
);

CREATE TABLE rt_stores (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES rt_organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  area TEXT,
  capacity INTEGER NOT NULL DEFAULT 24 CHECK (capacity >= 0),
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  line_status TEXT NOT NULL DEFAULT 'unconfigured' CHECK (line_status IN ('connected', 'warning', 'error', 'unconfigured')),
  google_status TEXT NOT NULL DEFAULT 'unconfigured' CHECK (google_status IN ('connected', 'warning', 'error', 'unconfigured')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), line_account_id TEXT REFERENCES line_accounts(id), latitude REAL CHECK(latitude IS NULL OR latitude BETWEEN -90 AND 90), longitude REAL CHECK(longitude IS NULL OR longitude BETWEEN -180 AND 180),
  UNIQUE(organization_id, code)
);

CREATE TABLE rt_sync_events (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction = 'inbound'),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received', 'processed', 'duplicate', 'failed')),
  error_message TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  UNIQUE(store_id, provider, external_event_id)
);

CREATE TABLE rt_tables (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  seat_type TEXT NOT NULL CHECK (seat_type IN ('counter', 'table', 'private_room', 'terrace')),
  min_capacity INTEGER NOT NULL DEFAULT 1 CHECK (min_capacity > 0),
  max_capacity INTEGER NOT NULL CHECK (max_capacity >= min_capacity),
  floor_x INTEGER NOT NULL DEFAULT 0,
  floor_y INTEGER NOT NULL DEFAULT 0,
  join_group TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), floor_id TEXT REFERENCES rt_floors(id), shape TEXT NOT NULL DEFAULT 'rectangle' CHECK(shape IN ('rectangle','circle','long','counter','sofa')), width REAL NOT NULL DEFAULT 80 CHECK(width>0), height REAL NOT NULL DEFAULT 64 CHECK(height>0), rotation REAL NOT NULL DEFAULT 0, smoking_policy TEXT NOT NULL DEFAULT 'non_smoking' CHECK(smoking_policy IN ('non_smoking','smoking','heated_tobacco')), partition_type TEXT NOT NULL DEFAULT 'open' CHECK(partition_type IN ('open','semi_private','private')), shoes_allowed INTEGER NOT NULL DEFAULT 1 CHECK(shoes_allowed IN (0,1)), visible_on_map INTEGER NOT NULL DEFAULT 1 CHECK(visible_on_map IN (0,1)), chair_arrangement TEXT NOT NULL DEFAULT 'both' CHECK(chair_arrangement IN ('both','one','all')), chair_side TEXT CHECK(chair_side IN ('top','right','bottom','left')), seat_detail_type TEXT CHECK(seat_detail_type IN ('table','counter','horigotatsu','zashiki','private_room','terrace')),
  UNIQUE(store_id, code)
);

CREATE TABLE saved_search_references (
  saved_search_id TEXT NOT NULL,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  reference_kind TEXT NOT NULL
    CHECK (reference_kind IN ('broadcast','automation','scenario','other')),
  reference_id TEXT NOT NULL,
  reference_name TEXT NOT NULL,
  reference_mode TEXT NOT NULL DEFAULT 'live'
    CHECK (reference_mode IN ('live','fixed')),
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')), revision INTEGER,
  PRIMARY KEY (saved_search_id, reference_kind, reference_id),
  FOREIGN KEY (saved_search_id, line_account_id)
    REFERENCES saved_searches(id, line_account_id) ON DELETE RESTRICT
);

CREATE TABLE saved_search_revisions (
  saved_search_id TEXT NOT NULL,
  line_account_id TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  name TEXT NOT NULL,
  conditions_json TEXT NOT NULL CHECK (json_valid(conditions_json)),
  is_shared INTEGER NOT NULL CHECK (is_shared IN (0, 1)),
  display_order INTEGER NOT NULL,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (saved_search_id, revision),
  FOREIGN KEY (saved_search_id, line_account_id)
    REFERENCES saved_searches(id, line_account_id) ON DELETE CASCADE
);

CREATE TABLE saved_search_usage_events (
  id TEXT PRIMARY KEY,
  saved_search_id TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  reference_kind TEXT NOT NULL
    CHECK (reference_kind IN ('friends','broadcast','automation','scenario','other')),
  reference_id TEXT,
  used_by TEXT,
  used_at TEXT NOT NULL,
  FOREIGN KEY (saved_search_id, line_account_id)
    REFERENCES saved_searches(id, line_account_id) ON DELETE RESTRICT
);

CREATE TABLE saved_searches (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'friends'
                    CHECK (scope IN ('friends','chats','bookings')),
  -- { all: [...], any: [...], visibility: '...' } の形。AND群とOR群の2グループ。
  conditions_json TEXT NOT NULL CHECK (json_valid(conditions_json)),
  created_by      TEXT,
  is_shared       INTEGER NOT NULL DEFAULT 1,
  display_order   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
, line_account_id TEXT REFERENCES line_accounts(id) ON DELETE CASCADE, condition_format TEXT NOT NULL DEFAULT 'search_v1'
  CHECK (condition_format IN ('search_v1','segment_v1')), revision INTEGER NOT NULL DEFAULT 1
  CHECK (revision >= 1), updated_by TEXT, updated_at TEXT);

CREATE TABLE scenario_action_fires (
  action_id TEXT NOT NULL REFERENCES scenario_actions (id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  fired_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (action_id, friend_id)
);

CREATE TABLE "scenario_actions" (
  id               TEXT PRIMARY KEY,
  scenario_id      TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
  hook             TEXT NOT NULL CHECK (hook IN ('step_sent', 'scenario_completed', 'choice_selected')),
  step_id          TEXT REFERENCES scenario_steps (id) ON DELETE CASCADE,
  choice_index     INTEGER,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  action_type      TEXT NOT NULL CHECK (action_type IN ('tag', 'friend_field', 'support_mark', 'scenario', 'common_var', 'send_message', 'send_template', 'reminder', 'event_booking')),
  config_json      TEXT NOT NULL CHECK (json_valid(config_json)),
  condition_json   TEXT CHECK (condition_json IS NULL OR json_valid(condition_json)),
  repeat_on_refire INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE scenario_drafts (
  scenario_id        TEXT PRIMARY KEY REFERENCES scenarios(id) ON DELETE CASCADE,
  line_account_id    TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  version            INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  after_actions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(after_actions_json)),
  updated_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE scenario_edit_drafts (
 line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
 draft_key TEXT NOT NULL,
 content_json TEXT NOT NULL CHECK(json_valid(content_json)),
 scenario_id TEXT REFERENCES scenarios(id) ON DELETE SET NULL, step_id TEXT REFERENCES scenario_steps(id) ON DELETE SET NULL,
 version TEXT NOT NULL CHECK(length(version) = 36),
 updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 PRIMARY KEY(line_account_id,draft_key)
);

CREATE TABLE scenario_pinned_action_fires (
  action_key TEXT NOT NULL,
  friend_id  TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  fired_at   TEXT NOT NULL,
  PRIMARY KEY (action_key, friend_id)
);

CREATE TABLE scenario_publish_keys (
  publish_idempotency_key   TEXT PRIMARY KEY,
  scenario_id               TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
  version_id                TEXT NOT NULL,
  content_snapshot          TEXT NOT NULL,
  created_at                TEXT NOT NULL
);

CREATE TABLE scenario_source_jobs (
 id TEXT PRIMARY KEY,
 line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
 friend_id TEXT NOT NULL REFERENCES friends(id),
 scenario_version_id TEXT NOT NULL REFERENCES scenario_versions(id),
 step_id TEXT NOT NULL,
 source_kind TEXT NOT NULL,
 source_id TEXT NOT NULL,
 source_event_id TEXT NOT NULL,
 source_version INTEGER NOT NULL,
 scheduled_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','running','sent','cancelled','failed')),
 attempt_count INTEGER NOT NULL DEFAULT 0,
 lease_until TEXT,
 idempotency_key TEXT NOT NULL UNIQUE,
 message_log_id TEXT,
 UNIQUE(source_kind,source_id,source_event_id,scenario_version_id,step_id)
);

CREATE TABLE "scenario_steps" (
  id              TEXT PRIMARY KEY,
  scenario_id     TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
  step_order      INTEGER NOT NULL,
  delay_minutes   INTEGER NOT NULL DEFAULT 0,
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'location', 'video', 'audio', 'sticker', 'carousel', 'imagemap', 'rich_message', 'coupon')),
  message_content TEXT NOT NULL,
  message_bubbles_json TEXT CHECK (message_bubbles_json IS NULL OR json_valid(message_bubbles_json)),
  offset_days     INTEGER,
  offset_minutes  INTEGER,
  delivery_time   TEXT,
  template_id     TEXT REFERENCES templates(id) ON DELETE SET NULL,
  on_reach_tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  condition_type  TEXT,
  condition_value TEXT,
  next_step_on_false INTEGER,
  after_send      TEXT NOT NULL DEFAULT 'continue' CHECK (after_send IN ('continue', 'pause')),
  target_condition_json TEXT,
  question_json   TEXT,
  is_draft        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (scenario_id, step_order)
);

CREATE TABLE scenario_test_send_claims (
  claim_key TEXT PRIMARY KEY,
  claimed_at TEXT NOT NULL
);

CREATE TABLE "scenario_triggers" (
  id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('friend_add', 'tag_added', 'form_answer', 'booking_confirmed')),
  tag_id TEXT REFERENCES tags (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE scenario_versions (
  id                        TEXT PRIMARY KEY,
  scenario_id               TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
  version_number            INTEGER NOT NULL,
  delivery_mode             TEXT NOT NULL DEFAULT 'relative',
  audience_condition_json   TEXT,
  on_complete_mode          TEXT NOT NULL DEFAULT 'pause',
  on_complete_scenario_id   TEXT,
  steps_snapshot            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(steps_snapshot)),
  actions_snapshot          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(actions_snapshot)),
  status                    TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN ('published', 'retired')),
  published_at              TEXT NOT NULL,
  published_by_staff_id     TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  UNIQUE (scenario_id, version_number)
);

CREATE TABLE scenarios (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('friend_add', 'tag_added', 'manual')),
  trigger_tag_id  TEXT REFERENCES tags (id) ON DELETE SET NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  delivery_mode   TEXT NOT NULL DEFAULT 'relative' CHECK (delivery_mode IN ('relative', 'elapsed', 'absolute_time')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL, display_order INTEGER NOT NULL DEFAULT 0, allow_concurrent INTEGER NOT NULL DEFAULT 0, audience_condition_json TEXT, on_complete_mode TEXT NOT NULL DEFAULT 'pause', on_complete_scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL, created_from_recipe_id TEXT REFERENCES recipes(id), recipe_clone_run_id TEXT REFERENCES recipe_clone_runs(id), current_published_version_id TEXT, stopped_reason TEXT
  CHECK (stopped_reason IS NULL OR length(stopped_reason) <= 200), stopped_by TEXT, stopped_at TEXT);

CREATE TABLE scheduled_chat_sends (
  id TEXT PRIMARY KEY,
  friend_id TEXT NOT NULL,
  line_account_id TEXT,
  staff_id TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL,
  quoted_message_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  lease_token TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error TEXT,
  sent_message_id TEXT,
  sent_at TEXT,
  failed_at TEXT,
  cancelled_by_staff_id TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, cancellation_reason TEXT, sender_id TEXT REFERENCES line_senders(id), sender_snapshot_json TEXT);

CREATE TABLE scoring_rules (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  score_value INTEGER NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE security_alerts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  line_account_id TEXT,
  scope_key TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  observed_count INTEGER NOT NULL CHECK (observed_count >= 0),
  threshold_count INTEGER NOT NULL CHECK (threshold_count > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  first_detected_at TEXT NOT NULL,
  last_detected_at TEXT NOT NULL,
  latest_event_at REAL NOT NULL,
  reviewed_at TEXT,
  slack_sent_version INTEGER NOT NULL DEFAULT 0,
  notification_id TEXT NOT NULL,
  slack_lease_until TEXT,
  slack_lease_token TEXT,
  slack_last_error TEXT,
  UNIQUE (scope_key, rule_key)
);

CREATE TABLE security_monitor_state (
  id TEXT PRIMARY KEY CHECK (id = 'security'),
  lease_until TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  last_started_at TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  last_completed_at TEXT,
  last_error TEXT
);

CREATE TABLE site_consent_days (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  day             TEXT NOT NULL,
  suppressed      INTEGER NOT NULL DEFAULT 0,
  granted         INTEGER NOT NULL DEFAULT 0,
  declined        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (line_account_id, day)
);

CREATE TABLE site_events (
  id          TEXT PRIMARY KEY,
  visitor_id  TEXT NOT NULL REFERENCES site_visitors(id) ON DELETE CASCADE,
  friend_id   TEXT REFERENCES friends(id) ON DELETE SET NULL,
  event_type  TEXT NOT NULL CHECK (event_type IN (
                'page_view','click','scroll_depth','custom','purchase')),
  path        TEXT,
  label       TEXT,
  value_num   INTEGER,
  referrer    TEXT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
, line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL, host TEXT);

CREATE TABLE site_tracking_keys (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL UNIQUE REFERENCES line_accounts(id) ON DELETE CASCADE,
  tracking_key    TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
);

CREATE TABLE site_visitors (
  id            TEXT PRIMARY KEY,
  friend_id     TEXT REFERENCES friends(id) ON DELETE SET NULL,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  linked_at     TEXT,
  linked_by     TEXT CHECK (linked_by IS NULL OR linked_by IN ('entry_route','liff','form','manual'))
, line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL, consent_state TEXT CHECK (consent_state IS NULL OR consent_state IN ('granted', 'declined')), consent_at TEXT);

CREATE TABLE staff (
  id                       TEXT PRIMARY KEY,
  line_account_id          TEXT NOT NULL,
  name                     TEXT NOT NULL,
  display_name             TEXT NOT NULL,
  role                     TEXT,
  profile_image_url        TEXT,
  bio                      TEXT,
  sort_order               INTEGER NOT NULL DEFAULT 0,
  is_designation_optional  INTEGER NOT NULL DEFAULT 0,
  is_active                INTEGER NOT NULL DEFAULT 1,
  deleted_at               TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), staff_member_id TEXT, fixed_meeting_url TEXT, meeting_url_version INTEGER NOT NULL DEFAULT 0, nomination_fee INTEGER NOT NULL DEFAULT 0 CHECK(nomination_fee >= 0), photo_media_id TEXT, photo_version INTEGER NOT NULL DEFAULT 1 CHECK(photo_version > 0),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);

CREATE TABLE staff_account_scopes (
  staff_id        TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (staff_id, line_account_id)
);

CREATE TABLE staff_availability_rules (
  id          TEXT PRIMARY KEY,
  staff_id    TEXT NOT NULL,
  weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (staff_id, weekday),
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);

CREATE TABLE staff_break_dates (
  id               TEXT PRIMARY KEY,
  staff_id         TEXT NOT NULL,
  work_date        TEXT NOT NULL, -- YYYY-MM-DD
  start_time       TEXT NOT NULL, -- HH:MM
  end_time         TEXT NOT NULL, -- HH:MM
  time_zone        TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  start_utc_offset TEXT NOT NULL DEFAULT '+09:00',
  end_utc_offset   TEXT NOT NULL DEFAULT '+09:00',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (staff_id, work_date, start_time, end_time),
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);

CREATE TABLE staff_breaks (
  id          TEXT PRIMARY KEY,
  staff_id    TEXT NOT NULL,
  weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=Sun
  start_time  TEXT NOT NULL,                                    -- HH:MM
  end_time    TEXT NOT NULL,                                    -- HH:MM
  time_zone   TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (staff_id, weekday, start_time, end_time),
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);

CREATE TABLE staff_line_link_codes (
  code        TEXT PRIMARY KEY,
  staff_id    TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE staff_members (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'staff')),
  access_level TEXT NOT NULL DEFAULT 'full' CHECK (access_level IN ('full', 'read_only')),
  api_key    TEXT UNIQUE NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  permission_keys TEXT NOT NULL DEFAULT '[]',
  notification_preferences TEXT NOT NULL DEFAULT '{}',
  invite_status TEXT NOT NULL DEFAULT 'active',
  invite_token_hash TEXT,
  invite_expires_at TEXT,
  email_verified_at TEXT,
  line_linked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_user_id TEXT, totp_secret_enc TEXT, totp_pending_secret_enc TEXT, totp_enabled_at TEXT, totp_last_used_step INTEGER, assigned_line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL, can_access_descendant_accounts INTEGER NOT NULL DEFAULT 0, tenant_id TEXT REFERENCES tenants(id), account_scope TEXT NOT NULL DEFAULT 'all'
  CHECK (account_scope IN ('all', 'accounts')), policy_version INTEGER NOT NULL DEFAULT 1, password_hash TEXT, password_updated_at TEXT, role_bundle TEXT, view_permission_keys TEXT, email_mask TEXT, notice_friend_id TEXT, notice_linked_at TEXT, email_change_new TEXT, email_change_token_hash TEXT, email_change_expires_at TEXT, getting_started_dismissed_at TEXT);

CREATE TABLE staff_menus (
  staff_id                  TEXT NOT NULL,
  menu_id                   TEXT NOT NULL,
  is_offered                INTEGER NOT NULL DEFAULT 1,
  override_duration_minutes INTEGER,
  override_price            INTEGER,
  PRIMARY KEY (staff_id, menu_id),
  FOREIGN KEY (staff_id) REFERENCES staff(id),
  FOREIGN KEY (menu_id) REFERENCES menus(id)
);

CREATE TABLE staff_notification_reads (
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  staff_id        TEXT NOT NULL,
  read_at         TEXT NOT NULL,
  PRIMARY KEY (notification_id, staff_id)
);

CREATE TABLE staff_passkey_challenges (
  token_hash TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('register', 'login')),
  staff_id TEXT REFERENCES staff_members(id) ON DELETE CASCADE,
  session_token_hash TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE staff_passkeys (
  credential_id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(transports)),
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE staff_permission_receipts (
  idempotency_key TEXT NOT NULL,
  staff_id        TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  request_hash    TEXT NOT NULL,
  policy_version  INTEGER NOT NULL,
  result          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (idempotency_key, staff_id)
);

CREATE TABLE staff_presence (
 staff_id TEXT PRIMARY KEY REFERENCES staff_members(id), away INTEGER NOT NULL DEFAULT 0 CHECK(away IN(0,1)), last_seen_at TEXT NOT NULL
);

CREATE TABLE staff_shifts (
  id          TEXT PRIMARY KEY,
  staff_id    TEXT NOT NULL,
  work_date   TEXT NOT NULL,    -- YYYY-MM-DD (JST)
  start_time  TEXT NOT NULL,    -- HH:MM (JST)
  end_time    TEXT NOT NULL,    -- HH:MM (JST)
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), is_responsible INTEGER NOT NULL DEFAULT 0 CHECK(is_responsible IN (0,1)),
  UNIQUE (staff_id, work_date),
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);

CREATE TABLE staff_two_factor_setup_attempts (
  staff_id          TEXT PRIMARY KEY,
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_started_at TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  FOREIGN KEY (staff_id) REFERENCES staff_members(id) ON DELETE CASCADE
);

CREATE TABLE stripe_events (
  id               TEXT PRIMARY KEY,
  stripe_event_id  TEXT NOT NULL UNIQUE,
  event_type       TEXT NOT NULL,
  friend_id        TEXT REFERENCES friends (id) ON DELETE SET NULL,
  amount           REAL,
  currency         TEXT,
  metadata         TEXT,
  processed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE style_analytics_results(id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL REFERENCES line_accounts(id), style TEXT NOT NULL, selection_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);

CREATE TABLE style_change_logs(id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL);

CREATE TABLE style_holidays(line_account_id TEXT NOT NULL REFERENCES line_accounts(id), date TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(line_account_id,date));

CREATE TABLE style_starter_catalog_items (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  template_id TEXT NOT NULL,
  template_version_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  set_id TEXT NOT NULL REFERENCES style_starter_sets(id),
  set_version INTEGER NOT NULL CHECK(set_version > 0),
  style TEXT NOT NULL CHECK(style IN ('standard','ec','restaurant','salon','consult','lesson')),
  kind TEXT NOT NULL CHECK(kind IN ('rich_menu','template','tag','auto_reply','coupon','form')),
  initiated_by TEXT NOT NULL REFERENCES staff_members(id),
  approved_by TEXT NOT NULL REFERENCES staff_members(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','succeeded','blocked','failed')),
  distribution_run_id TEXT,
  error_code TEXT,
  lease_token TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(line_account_id,template_id),
  FOREIGN KEY(template_id,tenant_id) REFERENCES hq_templates(id,tenant_id),
  FOREIGN KEY(template_version_id,template_id,tenant_id) REFERENCES hq_template_versions(id,template_id,tenant_id)
);

CREATE TABLE style_starter_catalog_resources (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  resource_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  source_snapshot TEXT NOT NULL CHECK(json_valid(source_snapshot)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(line_account_id,resource_kind,target_id)
);

CREATE TABLE style_starter_items (
 line_account_id TEXT NOT NULL REFERENCES line_accounts(id), style TEXT NOT NULL, item_key TEXT NOT NULL,
 kind TEXT NOT NULL, target_id TEXT NOT NULL, is_sample INTEGER NOT NULL DEFAULT 1,
 feature TEXT, set_id TEXT, set_version INTEGER NOT NULL, applied_at TEXT NOT NULL, source_snapshot TEXT CHECK(source_snapshot IS NULL OR json_valid(source_snapshot)), pending_update TEXT CHECK(pending_update IS NULL OR json_valid(pending_update)),
 PRIMARY KEY(line_account_id,style,item_key)
);

CREATE TABLE style_starter_sets (
 id TEXT PRIMARY KEY, tenant_id TEXT REFERENCES tenants(id), style TEXT NOT NULL, name TEXT NOT NULL,
 definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
 version INTEGER NOT NULL DEFAULT 1, archived_at TEXT, updated_at TEXT NOT NULL, updated_by TEXT
, auto_insert INTEGER NOT NULL DEFAULT 1 CHECK(auto_insert IN (0,1)));

CREATE TABLE style_targets(line_account_id TEXT NOT NULL REFERENCES line_accounts(id), metric TEXT NOT NULL, period TEXT NOT NULL, value REAL NOT NULL CHECK(value>=0), PRIMARY KEY(line_account_id,metric,period));

CREATE TABLE "support_email_messages" (
  id                TEXT PRIMARY KEY,
  thread_id         TEXT NOT NULL REFERENCES "support_email_threads" (id) ON DELETE CASCADE,
  direction         TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  sender_email      TEXT NOT NULL,
  sender_name       TEXT,
  recipient_email   TEXT NOT NULL,
  subject           TEXT NOT NULL,
  body_text         TEXT NOT NULL,
  message_id        TEXT UNIQUE,
  in_reply_to       TEXT,
  references_header TEXT,
  sent_by_staff_id  TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE support_email_sync_state (
  mailbox TEXT PRIMARY KEY,
  uid_validity TEXT,
  last_uid INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE "support_email_threads" (
  id                       TEXT PRIMARY KEY,
  customer_email           TEXT NOT NULL,
  customer_name            TEXT,
  subject                  TEXT NOT NULL,
  normalized_subject       TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'unread'
                           CHECK (status IN ('unread', 'in_progress', 'on_hold', 'resolved')),
  assigned_staff_id        TEXT,
  last_message_at          TEXT NOT NULL,
  last_incoming_at         TEXT NOT NULL,
  last_outgoing_at         TEXT,
  resolved_at              TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  notes                    TEXT,
  revision                 INTEGER NOT NULL DEFAULT 0,
  last_customer_message_at TEXT,
  last_operator_message_at TEXT,
  next_response_due_at     TEXT
);

CREATE TABLE support_mark_archive_requests (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL REFERENCES line_accounts(id),
  mark_id           TEXT NOT NULL REFERENCES support_marks(id),
  idempotency_key   TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  response_json     TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at        TEXT NOT NULL,
  UNIQUE(line_account_id, idempotency_key)
);

CREATE TABLE support_mark_create_requests (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL REFERENCES line_accounts(id),
  idempotency_key   TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  mark_id           TEXT NOT NULL REFERENCES support_marks(id),
  response_json     TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at        TEXT NOT NULL,
  UNIQUE(line_account_id, idempotency_key)
);

CREATE TABLE support_mark_rule_create_requests (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL REFERENCES line_accounts(id),
  mark_id           TEXT NOT NULL REFERENCES support_marks(id),
  idempotency_key   TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  rule_id           TEXT NOT NULL REFERENCES automation_definitions(id),
  response_json     TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at        TEXT NOT NULL,
  UNIQUE(line_account_id, idempotency_key)
);

CREATE TABLE support_mark_scopes (
  mark_id         TEXT PRIMARY KEY REFERENCES support_marks(id),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  line_account_id TEXT REFERENCES line_accounts(id),
  created_at      TEXT NOT NULL
);

CREATE TABLE support_marks (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  color           TEXT NOT NULL DEFAULT '#94A3B8',
  -- 新規友だちの初期値。1行だけ1にする（複数あってもアプリ側で最初の1件を使う）。
  is_default      INTEGER NOT NULL DEFAULT 0,
  -- 友だちから受信したとき自動でこれにする。
  auto_on_inbound INTEGER NOT NULL DEFAULT 0,
  display_order   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
, archived_at TEXT, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT, created_by TEXT, updated_by TEXT, display_locations_json TEXT NOT NULL DEFAULT '["inbox","friends","friend_detail"]'
  CHECK(json_valid(display_locations_json) AND json_type(display_locations_json)='array'));

CREATE TABLE tag_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tag_update_requests (
  id                  TEXT PRIMARY KEY,
  tag_id              TEXT NOT NULL REFERENCES tags(id),
  idempotency_key     TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  resulting_version   INTEGER NOT NULL,
  response_json       TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at          TEXT NOT NULL,
  UNIQUE(tag_id, idempotency_key)
);

CREATE TABLE "tags" (
  id                          TEXT PRIMARY KEY,
  name                        TEXT NOT NULL,
  color                       TEXT NOT NULL DEFAULT '#3B82F6',
  mileage_reward              INTEGER NOT NULL DEFAULT 0 CHECK (mileage_reward >= 0),
  referral_mileage_reward     INTEGER NOT NULL DEFAULT 0 CHECK (referral_mileage_reward >= 0),
  mileage_multiplier_bps      INTEGER CHECK (mileage_multiplier_bps IS NULL OR mileage_multiplier_bps BETWEEN 1000 AND 100000),
  mileage_multiplier_priority INTEGER NOT NULL DEFAULT 0,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, group_id TEXT REFERENCES tag_groups(id) ON DELETE SET NULL, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL, is_starred INTEGER NOT NULL DEFAULT 0, display_order INTEGER NOT NULL DEFAULT 0, line_account_id TEXT REFERENCES line_accounts(id), description TEXT, normalized_name TEXT, manual_assignment_allowed INTEGER NOT NULL DEFAULT 1
  CHECK (manual_assignment_allowed IN (0, 1)), reapply_policy TEXT NOT NULL DEFAULT 'first_only'
  CHECK (reapply_policy IN ('first_only', 'every_time')), linked_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (linked_enabled IN (0, 1)), status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'archived')), version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0), created_by TEXT, updated_by TEXT, updated_at TEXT, created_from_recipe_id TEXT REFERENCES recipes(id), recipe_clone_run_id TEXT REFERENCES recipe_clone_runs(id));

CREATE TABLE template_publish_keys (
  template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  published_version INTEGER NOT NULL,
  draft_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  -- 再審査対応: 同キー再試行の内容比較用指紋と、固定応答の控え。
  -- 指紋が違えば別操作の使い回しとして409。応答は記録時の版・本文を返す。
  draft_fingerprint TEXT NOT NULL DEFAULT '',
  message_type TEXT,
  message_content TEXT,
  PRIMARY KEY (template_id, idempotency_key)
);

CREATE TABLE template_references (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL
    REFERENCES templates(id) ON DELETE CASCADE,
  -- 使っている版 (templates.published_version と同じ番号)。版履歴より前の
  -- 参照は空のままにし、画面では「—」と出す（無い版番号をでっち上げない）。
  template_version_number INTEGER,
  consumer_kind TEXT NOT NULL
    CHECK (consumer_kind IN ('broadcast', 'scenario', 'auto_reply')),
  consumer_id TEXT NOT NULL,
  reference_mode TEXT NOT NULL DEFAULT 'fixed'
    CHECK (reference_mode IN ('fixed', 'latest')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (template_id, consumer_kind, consumer_id)
);

CREATE TABLE template_versions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL
    REFERENCES templates(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  message_type TEXT NOT NULL,
  message_content TEXT NOT NULL,
  carousel_actions_json TEXT,
  carousel_tap_limit_mode TEXT,
  carousel_tap_limit_text TEXT,
  question_json TEXT,
  question_status TEXT,
  -- 使い始めの日時。空は「公開と同時」。未来の日時は「予約」の札で見せる。
  effective_from TEXT,
  created_by_staff_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), message_bubbles_json TEXT
  CHECK(message_bubbles_json IS NULL OR (json_valid(message_bubbles_json) AND json_type(message_bubbles_json)='array' AND json_array_length(message_bubbles_json) BETWEEN 1 AND 5)), hq_template_version_id TEXT,
  UNIQUE (template_id, version_number)
);

CREATE TABLE "templates" (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'general',
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'carousel', 'imagemap', 'rich_message', 'coupon')),
  message_content TEXT NOT NULL,
  -- 162: カルーセルの選択肢を押したときの動き。
  -- { "0": { "0": [アクションの並び] } }（パネル番号 → 選択肢番号 → 中身）
  carousel_actions_json TEXT,
  -- 162: 選択肢の押せる回数。'none'（制限なし）／'once'（全体で1回）
  carousel_tap_limit_mode TEXT NOT NULL DEFAULT 'none',
  -- 162: 制限を超えたときに返すテキスト。空なら何も返さない。
  carousel_tap_limit_text TEXT,
  -- 質問テンプレート。scenario_steps.question_json と同じ形。
  question_json TEXT CHECK (question_json IS NULL OR json_valid(question_json)),
  question_status TEXT NOT NULL DEFAULT 'published' CHECK (question_status IN ('draft', 'published')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL, display_order INTEGER NOT NULL DEFAULT 0, line_account_id TEXT REFERENCES line_accounts(id), created_from_recipe_id TEXT REFERENCES recipes(id), recipe_clone_run_id TEXT REFERENCES recipe_clone_runs(id), published_version INTEGER NOT NULL DEFAULT 1, published_at TEXT, draft_message_type TEXT, draft_message_content TEXT, draft_carousel_actions_json TEXT, draft_carousel_tap_limit_mode TEXT, draft_carousel_tap_limit_text TEXT, draft_question_json TEXT
  CHECK (draft_question_json IS NULL OR json_valid(draft_question_json)), draft_question_status TEXT
  CHECK (draft_question_status IS NULL OR draft_question_status IN ('draft', 'published')), publish_idempotency_key TEXT, draft_revision INTEGER NOT NULL DEFAULT 0, message_bubbles_json TEXT
  CHECK(message_bubbles_json IS NULL OR (json_valid(message_bubbles_json) AND json_type(message_bubbles_json)='array' AND json_array_length(message_bubbles_json) BETWEEN 1 AND 5)), draft_message_bubbles_json TEXT
  CHECK(draft_message_bubbles_json IS NULL OR (json_valid(draft_message_bubbles_json) AND json_type(draft_message_bubbles_json)='array' AND json_array_length(draft_message_bubbles_json) BETWEEN 1 AND 5)), deleted_at TEXT);

CREATE TABLE tenant_data_purge_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- immediate: 早期削除の要請による削除 / expired: 保存期限の満了による削除
  reason TEXT NOT NULL,
  -- 保存起点。どの時点から数えて期限が切れたのかを後から確かめられるようにする。
  retention_anchor_at TEXT,
  started_at TEXT NOT NULL,
  -- 全ての表を消し終えた回だけ入る。途中で上限に達した回は空のままにする。
  finished_at TEXT,
  -- この回に消した行数の合計と、表ごとの内訳 {"friends": 12, ...}
  deleted_rows INTEGER NOT NULL DEFAULT 0,
  deleted_rows_by_table TEXT NOT NULL DEFAULT '{}',
  -- この回に消した画像(R2)の数
  deleted_objects INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, feature_packs TEXT NOT NULL DEFAULT '[]', plan_key TEXT, plan_status TEXT NOT NULL DEFAULT 'exempt'
  CHECK (plan_status IN ('exempt', 'trialing', 'active', 'past_due', 'canceled')), trial_ends_at TEXT, stripe_customer_id TEXT, stripe_subscription_id TEXT, current_period_ends_at TEXT, plan_updated_at TEXT, signup_device_marker TEXT, retention_anchor_at TEXT, purge_requested_at TEXT, data_purged_at TEXT, login_display_name TEXT, logo_media_id TEXT REFERENCES media(id) ON DELETE SET NULL, logo_background_color TEXT NOT NULL DEFAULT '#ffffff', company_settings_version INTEGER NOT NULL DEFAULT 0
  CHECK (company_settings_version >= 0), legal_company_name TEXT, company_postal_code TEXT, company_address TEXT, company_building TEXT, company_phone TEXT, contact_name TEXT, contact_email TEXT, invoice_addressee TEXT);

CREATE TABLE tiktok_pnl_order_lines (
  -- `<TikTok注文ID>:<行番号>`。シートのキー列（A列）にもこの値を使う。
  -- 主キーは line_account_id と組にする。TikTok注文IDはアカウントをまたいで
  -- 重複し得るため、単独キーにすると先に取り込んだアカウントが行を占有し、
  -- 別アカウントの同一注文IDが混入・欠落する。
  line_key TEXT NOT NULL,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  tiktok_order_id TEXT NOT NULL,
  line_index INTEGER NOT NULL,
  -- 集計の基準日（JST）。支払日、なければ注文日から求める。YYYY-MM-DD。
  order_date_jst TEXT NOT NULL,
  paid_at TEXT,
  -- EC側から届いた生のステータス。表示用の日本語化は書き出し時に行う。
  order_status TEXT,
  sku TEXT,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price_yen INTEGER,
  line_amount_yen INTEGER,
  -- 同日・同一購入者を1発送と数えるための識別子（EC側で正規化済み）。
  buyer_key TEXT,
  source_updated_at TEXT,
  fetched_at TEXT NOT NULL,
  -- 1 = シートへ未反映（新規または内容が変わった）。書き出し成功で 0 に戻す。
  sheet_dirty INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (line_account_id, line_key)
);

CREATE TABLE tiktok_pnl_settings (
  line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id) ON DELETE CASCADE,
  -- 1 = このアカウントで利益計算シートを使う。既定は 0。
  -- cron は 1 のアカウントだけ処理する。Google Sheets連携が繋がっているだけで
  -- 勝手にスプレッドシートを作らないための明示的な有効化。
  -- 管理画面の手動同期が押された時に 1 へ上げる。
  enabled INTEGER NOT NULL DEFAULT 0,
  spreadsheet_id TEXT,
  spreadsheet_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'error')),
  -- 同期中の目印（開始時刻）。手動同期と定期実行が重なると同じ明細を
  -- 二重に追記してしまうため、アカウント単位の排他に使う。
  -- 途中で落ちた場合も古い値は期限切れとして無視する。
  sync_started_at TEXT,
  -- 雛形（見出し・数式・マスタ）を書き込み終えた時刻。
  -- 作成と書き込みを分けたので、ここが空なら次tickで書き込みだけやり直す。
  -- 2つ目のスプレッドシートを作らないための目印。
  template_filled_at TEXT,
  -- EC側取り込みの再開点（source_updated_at ベース）。
  import_cursor TEXT,
  last_import_at TEXT,
  last_sheet_sync_at TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tracked_links (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  original_url TEXT NOT NULL,
  tag_id TEXT REFERENCES tags (id) ON DELETE SET NULL,
  scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  click_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, intro_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL, reward_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL, og_title TEXT, og_description TEXT, og_image_url TEXT, line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL, short_code TEXT, dedup_key TEXT, template_id TEXT);

CREATE TABLE traffic_pools (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  active_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE uid_migration_delivery_consents (
 item_id TEXT NOT NULL REFERENCES uid_migration_items(id),
 purpose TEXT NOT NULL, source_state TEXT, before_json TEXT, after_json TEXT,
 PRIMARY KEY(item_id,purpose)
);

CREATE TABLE uid_migration_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES uid_migration_runs(id) ON DELETE RESTRICT,
  old_uid TEXT NOT NULL,
  new_uid TEXT,
  old_friend_id TEXT REFERENCES friends(id) ON DELETE RESTRICT,
  new_friend_id TEXT REFERENCES friends(id) ON DELETE RESTRICT,
  candidate_name TEXT,
  evidence_type TEXT NOT NULL
    CHECK (evidence_type IN ('same_provider','line_login','signed_customer_id','verified_contact','operator_csv','manual')),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  classification TEXT NOT NULL
    CHECK (classification IN ('auto','review','unmatched','conflict')),
  conflict_reason TEXT,
  decision TEXT NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('pending','link','create','exclude')),
  decided_by TEXT,
  decided_at TEXT,
  result TEXT NOT NULL DEFAULT 'pending'
    CHECK (result IN ('pending','applied','skipped','failed','rolled_back')),
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE uid_migration_runs (
  id TEXT PRIMARY KEY,
  from_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  to_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('csv','verified_api','manual')),
  source_filename TEXT,
  source_checksum TEXT,
  status TEXT NOT NULL DEFAULT 'dry_run'
    CHECK (status IN ('dry_run','review','ready','executing','completed','failed','rolled_back')),
  dry_run_revision INTEGER NOT NULL DEFAULT 1 CHECK (dry_run_revision >= 1),
  total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  auto_count INTEGER NOT NULL DEFAULT 0 CHECK (auto_count >= 0),
  review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  unmatched_count INTEGER NOT NULL DEFAULT 0 CHECK (unmatched_count >= 0),
  conflict_count INTEGER NOT NULL DEFAULT 0 CHECK (conflict_count >= 0),
  applied_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  created_by TEXT NOT NULL,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  executed_at TEXT,
  completed_at TEXT,
  rolled_back_at TEXT,
  failure_reason TEXT,
  CHECK (from_account_id <> to_account_id),
  CHECK (total_count = auto_count + review_count + unmatched_count + conflict_count)
);

CREATE TABLE update_history (
  id                          TEXT PRIMARY KEY,
  started_at                  INTEGER NOT NULL,
  completed_at                INTEGER,
  from_version                TEXT NOT NULL,
  to_version                  TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN ('running','success','failed','rolled_back')),
  snapshot_worker_url         TEXT,
  snapshot_admin_deployment   TEXT,
  snapshot_liff_deployment    TEXT,
  events_jsonl                TEXT NOT NULL DEFAULT '',
  error                       TEXT,
  rollback_of                 TEXT REFERENCES update_history(id),
  rollback_expires_at         INTEGER
);

CREATE TABLE user_delivery_priorities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL
    CHECK (purpose IN ('broadcast', 'scenario', 'reminder', 'transactional', 'manual')),
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE RESTRICT,
  priority INTEGER NOT NULL CHECK (priority >= 1),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  reason TEXT NOT NULL,
  selected_by TEXT,
  selected_at TEXT NOT NULL,
  retired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_profile_values (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  field_key TEXT NOT NULL,
  field_label TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  value_preview TEXT,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('friend', 'friend_field', 'form', 'ec', 'manual')),
  source_id TEXT,
  source_label TEXT NOT NULL,
  source_friend_id TEXT REFERENCES friends(id) ON DELETE RESTRICT,
  verified_at TEXT,
  selected_by TEXT,
  selected_by_name TEXT NOT NULL,
  selected_at TEXT NOT NULL,
  update_mode TEXT NOT NULL CHECK (update_mode IN ('auto', 'fixed')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email        TEXT,
  phone        TEXT,
  external_id  TEXT,
  display_name TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT, status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'review', 'archived')), primary_display_name TEXT, revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1), created_by TEXT, archived_at TEXT);

CREATE TABLE visit_stamp_card_accounts (
 card_id TEXT NOT NULL REFERENCES visit_stamp_cards(id), line_account_id TEXT NOT NULL REFERENCES line_accounts(id), PRIMARY KEY(card_id,line_account_id)
);

CREATE TABLE visit_stamp_cards (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL,
 settings_json TEXT NOT NULL CHECK(json_valid(settings_json)), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 write_token TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT(datetime('now')), updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);

CREATE TABLE visit_stamp_checkouts (
 kind TEXT NOT NULL CHECK(kind IN ('restaurant','booking')), visit_id TEXT NOT NULL, line_account_id TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount>=0), recorded_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT(datetime('now')), PRIMARY KEY(kind,visit_id)
);

CREATE TABLE visit_stamp_entries (
 id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES visit_stamp_cards(id), friend_id TEXT NOT NULL, line_account_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('visit','manual','paper','redeem','reverse','restore','expire')), delta INTEGER NOT NULL,
 actor_id TEXT, reason TEXT NOT NULL, idempotency_key TEXT NOT NULL, original_id TEXT UNIQUE REFERENCES visit_stamp_entries(id),
 visit_key TEXT, expires_at TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT(datetime('now')),
 UNIQUE(card_id,friend_id,idempotency_key)
);

CREATE TABLE visit_stamp_paper_photos (
 id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES visit_stamp_cards(id), friend_id TEXT NOT NULL REFERENCES friends(id),
 line_account_id TEXT NOT NULL REFERENCES line_accounts(id), object_key TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL,
 size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 5242880), created_at TEXT NOT NULL DEFAULT(datetime('now'))
);

CREATE TABLE visit_stamp_paper_requests (
 id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES visit_stamp_cards(id), friend_id TEXT NOT NULL REFERENCES friends(id),
 line_account_id TEXT NOT NULL REFERENCES line_accounts(id), photo_url TEXT NOT NULL, stamps INTEGER NOT NULL CHECK(stamps BETWEEN 1 AND 10000),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), reason TEXT, reviewed_by TEXT, reviewed_at TEXT,
 created_at TEXT NOT NULL DEFAULT(datetime('now'))
, submitted_friend_id TEXT REFERENCES friends(id));

CREATE TABLE visit_stamp_pin_attempts (
 line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id), attempts INTEGER NOT NULL DEFAULT 0, locked_until TEXT
);

CREATE TABLE visit_stamp_qr_codes (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES visit_stamp_cards(id),
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  kind TEXT NOT NULL CHECK(kind IN ('storefront','staff')),
  token TEXT NOT NULL UNIQUE,
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  card_version INTEGER NOT NULL,
  base_count INTEGER NOT NULL CHECK(base_count BETWEEN 1 AND 10000),
  amount INTEGER CHECK(amount BETWEEN 0 AND 100000000),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','used','revoked')),
  consumed_friend_id TEXT,
  consumed_at TEXT,
  consumed_entry_id TEXT REFERENCES visit_stamp_entries(id),
  request_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>0),
  rotation_key TEXT,
  UNIQUE(card_id,line_account_id,kind,issued_by,request_id),
  UNIQUE(card_id,line_account_id,kind,session_id,generation),
  CHECK((kind='staff' AND expires_at IS NOT NULL) OR (kind='storefront' AND expires_at IS NULL)),
  CHECK((status='used' AND consumed_friend_id IS NOT NULL AND consumed_at IS NOT NULL AND consumed_entry_id IS NOT NULL) OR status<>'used')
);

CREATE TABLE visit_stamp_redemptions (
 id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES visit_stamp_cards(id), friend_id TEXT NOT NULL, line_account_id TEXT NOT NULL,
 reward_id TEXT NOT NULL, reward_name TEXT NOT NULL, stamps INTEGER NOT NULL CHECK(stamps>0),
 status TEXT NOT NULL DEFAULT 'offered' CHECK(status IN ('offered','used','cancelled')), request_id TEXT NOT NULL,
 used_by TEXT, used_at TEXT, cancelled_at TEXT, created_at TEXT NOT NULL DEFAULT(datetime('now')),
 UNIQUE(card_id,friend_id,request_id)
);

CREATE TABLE visit_stamp_staff_pins (
 line_account_id TEXT NOT NULL REFERENCES line_accounts(id), staff_id TEXT NOT NULL REFERENCES staff_members(id),
 salt TEXT NOT NULL, hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, locked_until TEXT,
 updated_at TEXT NOT NULL DEFAULT(datetime('now')), PRIMARY KEY(line_account_id,staff_id)
);

CREATE TABLE visit_stamp_visit_queue (
 kind TEXT NOT NULL CHECK(kind IN ('restaurant','booking')), visit_id TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL DEFAULT(datetime('now')), PRIMARY KEY(kind,visit_id)
);

CREATE TABLE visit_stamp_wallets (
 card_id TEXT NOT NULL REFERENCES visit_stamp_cards(id), friend_id TEXT NOT NULL REFERENCES friends(id),
 version INTEGER NOT NULL DEFAULT 0, balance INTEGER NOT NULL DEFAULT 0, earned_total INTEGER NOT NULL DEFAULT 0, visit_count INTEGER NOT NULL DEFAULT 0, expires_at TEXT, last_visit_at TEXT,
 PRIMARY KEY(card_id,friend_id)
);

CREATE TABLE "webhook_interaction_logs" (
  id                 TEXT PRIMARY KEY,
  line_account_id    TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  direction          TEXT NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
  webhook_id         TEXT,
  webhook_name       TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  trigger_summary    TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'retried')),
  request_body_json  TEXT,
  response_status    INTEGER,
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  duration_ms        INTEGER,
  failure_reason     TEXT CHECK (
    failure_reason IS NULL OR failure_reason IN (
      'connection_failed', 'response_4xx', 'response_429',
      'response_5xx', 'processing_failed', 'unknown', 'secret_unavailable'
    )
  ),
  idempotency_key    TEXT NOT NULL,
  retry_of_id        TEXT REFERENCES webhook_interaction_logs(id) ON DELETE SET NULL,
  started_at         TEXT NOT NULL,
  completed_at       TEXT,
  created_at         TEXT NOT NULL
);

CREATE TABLE webinar_action_executions (
  id               TEXT PRIMARY KEY,
  webinar_action_id TEXT NOT NULL REFERENCES webinar_actions(id),
  webinar_id       TEXT NOT NULL REFERENCES webinars(id),
  friend_id        TEXT NOT NULL REFERENCES friends(id),
  session_start_at INTEGER,
  trigger          TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'succeeded', 'skipped', 'retry_wait', 'permanent_failed', 'cancelled')),
  attempt          INTEGER NOT NULL DEFAULT 0,
  idempotency_key  TEXT NOT NULL UNIQUE,
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE webinar_actions (
  id            TEXT PRIMARY KEY,
  webinar_id    TEXT NOT NULL REFERENCES webinars(id),
  trigger       TEXT NOT NULL CHECK (trigger IN ('completed', 'cta_clicked', 'unviewed')),
  action_type   TEXT NOT NULL CHECK (action_type IN ('add_tag', 'remove_tag', 'start_scenario', 'stop_scenario', 'resume_scenario', 'send_message', 'send_webhook', 'switch_rich_menu', 'remove_rich_menu')),
  config_json   TEXT NOT NULL DEFAULT '{}',
  position      INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 1,
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (webinar_id, trigger, position, version)
);

CREATE TABLE webinar_comments (
  id TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  at_seconds INTEGER NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE webinar_ctas (
  id TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  at_seconds INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('form', 'url')),
  title TEXT NOT NULL,
  body TEXT,
  button_label TEXT NOT NULL,
  auto_open INTEGER NOT NULL DEFAULT 0,
  form_id TEXT REFERENCES forms(id),
  url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE webinar_editor_settings (
  webinar_id                 TEXT PRIMARY KEY REFERENCES webinars(id) ON DELETE CASCADE,
  version                    INTEGER NOT NULL DEFAULT 1,
  delivery_kind              TEXT NOT NULL DEFAULT 'on_demand'
                             CHECK (delivery_kind IN ('on_demand', 'scheduled', 'external')),
  viewing_condition_json     TEXT NOT NULL DEFAULT '{"kind":"registered","label":"申込者向け"}',
  public_description         TEXT NOT NULL DEFAULT '',
  registration_form_id       TEXT REFERENCES forms(id) ON DELETE SET NULL,
  notification_messages_json TEXT NOT NULL DEFAULT '{}',
  notification_test_json     TEXT,
  action_template_body       TEXT NOT NULL DEFAULT '',
  missing_result_policy      TEXT NOT NULL DEFAULT 'escalate'
                             CHECK (missing_result_policy IN ('escalate', 'retry_next_day')),
  public_page_test_json       TEXT,
  published_version          INTEGER,
  published_at               TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

CREATE TABLE webinar_followup_configs (
  webinar_id          TEXT PRIMARY KEY REFERENCES webinars(id) ON DELETE CASCADE,
  enabled_at          TEXT NOT NULL,
  first_delay_minutes INTEGER NOT NULL DEFAULT 30,
  second_delay_minutes INTEGER NOT NULL DEFAULT 1440,
  is_active           INTEGER NOT NULL DEFAULT 1
, stage_enabled_at TEXT, picker_delay_minutes INTEGER NOT NULL DEFAULT 30, no_show_delay_minutes INTEGER NOT NULL DEFAULT 30, booking_delay_minutes INTEGER NOT NULL DEFAULT 30, booking_second_delay_minutes INTEGER NOT NULL DEFAULT 1440, booking_menu_id TEXT, booking_url TEXT);

CREATE TABLE webinar_followups (
  id             TEXT PRIMARY KEY,
  webinar_id     TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  friend_id      TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('after_30m', 'after_24h')),
  retry_key      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  sent_at        TEXT,
  last_error     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (webinar_id, friend_id, kind)
);

CREATE TABLE webinar_funnel_events (
  id               TEXT PRIMARY KEY,
  webinar_id       TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  friend_id        TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  session_start_at INTEGER NOT NULL,
  event_type       TEXT NOT NULL CHECK (event_type IN (
    'cta_impression',
    'cta_click',
    'form_open',
    'form_start',
    'field_complete',
    'submit_attempt',
    'submit_success',
    'submit_error'
  )),
  cta_id           TEXT NOT NULL DEFAULT '',
  form_id          TEXT NOT NULL DEFAULT '',
  field_name       TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE webinar_heartbeat_rejects (
  id TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  session_start_at INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('position_jump', 'negative_gap', 'invalid_rate')),
  position_seconds INTEGER NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE webinar_journey_followups (
  id          TEXT PRIMARY KEY,
  webinar_id  TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  friend_id   TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN (
    'picker_no_registration',
    'registered_no_show',
    'submitted_no_booking_30m',
    'submitted_no_booking_24h'
  )),
  retry_key   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  sent_at     TEXT,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (webinar_id, friend_id, kind)
);

CREATE TABLE webinar_notification_jobs (
  id                TEXT PRIMARY KEY,
  webinar_id        TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  registration_id   TEXT NOT NULL REFERENCES webinar_registrations(id) ON DELETE CASCADE,
  friend_id         TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  session_start_at  INTEGER NOT NULL,
  settings_version  INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN (
    'day_before', 'hour_before', 'session_start', 'missed', 'completed'
  )),
  scheduled_at      INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN (
                      'queued', 'claimed', 'succeeded', 'skipped',
                      'retry_wait', 'permanent_failed', 'cancelled'
                    )),
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  next_retry_at     INTEGER,
  lease_expires_at  INTEGER,
  line_retry_key    TEXT NOT NULL,
  line_request_id   TEXT,
  sent_at           TEXT,
  cancelled_at      TEXT,
  last_error_code   TEXT,
  last_error_message TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (registration_id, settings_version, kind)
);

CREATE TABLE webinar_notification_settings (
  webinar_id                  TEXT PRIMARY KEY REFERENCES webinars(id) ON DELETE CASCADE,
  version                     INTEGER NOT NULL DEFAULT 1,
  registration_enabled        INTEGER NOT NULL DEFAULT 1,
  day_before_enabled          INTEGER NOT NULL DEFAULT 1,
  day_before_time_minutes     INTEGER NOT NULL DEFAULT 1200,
  hour_before_enabled         INTEGER NOT NULL DEFAULT 1,
  hour_before_minutes         INTEGER NOT NULL DEFAULT 60,
  start_enabled               INTEGER NOT NULL DEFAULT 1,
  missed_enabled              INTEGER NOT NULL DEFAULT 1,
  missed_time_minutes         INTEGER NOT NULL DEFAULT 600,
  completed_enabled           INTEGER NOT NULL DEFAULT 1,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL, missed_window_days INTEGER NOT NULL DEFAULT 7
  CHECK (missed_window_days BETWEEN 1 AND 30),
  CHECK (day_before_time_minutes BETWEEN 0 AND 1439),
  CHECK (hour_before_minutes BETWEEN 1 AND 10080),
  CHECK (missed_time_minutes BETWEEN 0 AND 1439)
);

CREATE TABLE webinar_picker_opens (
  id              TEXT PRIMARY KEY,
  webinar_id      TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  friend_id       TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  opened_at       TEXT NOT NULL,
  UNIQUE (webinar_id, friend_id)
);

CREATE TABLE webinar_registrations (
  id TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES friends(id),
  session_start_at INTEGER NOT NULL,
  notified_at TEXT,
  created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'cancelled')), cancelled_at TEXT,
  UNIQUE (webinar_id, friend_id, session_start_at)
);

CREATE TABLE webinar_sessions (
  id TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  session_start_at INTEGER NOT NULL,
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  reserved_count INTEGER NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  state TEXT NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'full', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (webinar_id, session_start_at)
);

CREATE TABLE webinar_user_comments (
  id TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES friends(id),
  session_start_at INTEGER NOT NULL,
  at_seconds INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE webinar_versions (
  id            TEXT PRIMARY KEY,
  webinar_id    TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft', 'published', 'superseded')),
  snapshot_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  published_at  TEXT,
  UNIQUE (webinar_id, version)
);

CREATE TABLE webinar_video_assets (
  id TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (stage IN (
      'uploaded', 'inspecting', 'converting', 'packaging',
      'thumbnail', 'ready', 'failed'
    )),
  provider TEXT NOT NULL DEFAULT 'r2_hls',
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  checksum TEXT,
  error_code TEXT,
  expires_at TEXT,
  purged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE webinar_view_segments (
  id               TEXT PRIMARY KEY,
  webinar_id       TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  friend_id        TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  session_start_at INTEGER NOT NULL,
  start_seconds    INTEGER NOT NULL CHECK (start_seconds >= 0),
  end_seconds      INTEGER NOT NULL CHECK (end_seconds > start_seconds),
  received_at      TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE
, playback_rate REAL NOT NULL DEFAULT 1
  CHECK (playback_rate > 0 AND playback_rate <= 4), client_at_ms INTEGER);

CREATE TABLE webinar_viewers (
  id TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES friends(id),
  session_start_at INTEGER NOT NULL,
  joined_at TEXT NOT NULL,
  last_position_seconds INTEGER NOT NULL DEFAULT 0,
  cta_clicked_at TEXT, last_heartbeat_at INTEGER,
  UNIQUE (webinar_id, friend_id, session_start_at)
);

CREATE TABLE webinars (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES line_accounts(id),
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  video_prefix TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  schedule_json TEXT NOT NULL DEFAULT '[]',
  cta_json TEXT,
  tag_on_attend TEXT,
  tag_on_cta_click TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL, publication_starts_at TEXT, publication_ends_at TEXT, video_asset_id TEXT REFERENCES webinar_video_assets(id) ON DELETE SET NULL, cta_version INTEGER NOT NULL DEFAULT 0, cta_updated_by TEXT, cta_updated_at TEXT, cta_write_token TEXT);

CREATE TABLE workflow_steps (
  scope_id TEXT NOT NULL,
  process_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','succeeded','failed','exhausted','unknown','canceled')),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  next_attempt_at INTEGER,
  retry_key TEXT NOT NULL,
  input_json TEXT,
  result_json TEXT,
  error_code TEXT,
  first_attempt_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_id, process_kind, subject_id, step_key),
  CHECK ((status = 'running' AND NOT (lease_owner IS NULL) AND NOT (lease_expires_at IS NULL))
      OR (status <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL))
);

CREATE INDEX ai_answer_logs_account ON ai_answer_logs(account_id,created_at,id);

CREATE INDEX booking_entitlement_notices_due ON booking_entitlement_notices(status,scheduled_at);

CREATE UNIQUE INDEX booking_monthly_attempt_unresolved ON booking_monthly_attempts(cycle_id)
 WHERE state IN('pending','running','processing','unknown');

CREATE INDEX booking_monthly_cycles_due ON booking_monthly_cycles(state,due_at,id);

CREATE UNIQUE INDEX booking_monthly_initial_cycle ON booking_monthly_cycles(contract_id) WHERE kind='initial';

CREATE INDEX booking_pass_billing_cycle ON booking_pass_billing_events(subscription_id,period_start,occurred_at);

CREATE UNIQUE INDEX booking_pass_subscription ON booking_entitlements(line_account_id,stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

CREATE INDEX booking_sync_notices_account ON booking_sync_notices(line_account_id,status,target_date);

CREATE INDEX bookings_group ON bookings(group_id);

CREATE INDEX bookings_series ON bookings(series_id,series_index);

CREATE INDEX broadcasts_hq_run ON broadcasts(hq_run_id);

CREATE INDEX customer_activity_cells ON customer_activity_daily(account_id,basis,r_bucket,f_bucket,friend_id);

CREATE UNIQUE INDEX ec_auto_line_attribution_order ON ec_auto_line_attribution_events(account_id,order_id) WHERE kind='purchase';

CREATE INDEX ec_auto_line_attribution_send ON ec_auto_line_attribution_events(send_id,kind,occurred_at);

CREATE INDEX ec_auto_line_sends_caps ON ec_auto_line_sends(account_id,friend_id,sent_at,product_id);

CREATE INDEX ec_auto_line_sends_due ON ec_auto_line_sends(status,scheduled_at);

CREATE INDEX ec_behavior_friend ON ec_behavior_events(account_id,friend_id,occurred_at,type);

CREATE INDEX friend_delivery_consents_dispatch ON friend_delivery_consents(line_account_id,state,friend_id);

CREATE UNIQUE INDEX friends_account_member_number ON friends(line_account_id,member_number);

CREATE INDEX hq_store_comparison_exports_due ON hq_store_comparison_export_jobs(status,created_at);

CREATE INDEX hq_store_response_period ON hq_store_response_samples(account_id,responded_at);

CREATE INDEX idx_account_handovers_from ON account_handovers (from_account_id);

CREATE INDEX idx_account_handovers_status ON account_handovers (status);

CREATE INDEX idx_account_pool_switch_events_account
  ON account_pool_switch_events(line_account_id, created_at DESC);

CREATE INDEX idx_account_skipped_deliveries_account
  ON account_skipped_deliveries(line_account_id, skipped_at DESC);

CREATE INDEX idx_action_score_rule_sets_account_status
  ON action_score_rule_sets(line_account_id, status);

CREATE INDEX idx_action_score_rule_versions_set_status
  ON action_score_rule_versions(rule_set_id, status, version_number DESC);

CREATE INDEX idx_ad_conversion_logs_account ON ad_conversion_logs(line_account_id);

CREATE INDEX idx_ad_conversion_logs_friend ON ad_conversion_logs (friend_id);

CREATE INDEX idx_ad_conversion_logs_friend_event_key
  ON ad_conversion_logs(friend_id, event_name, idempotency_key);

CREATE UNIQUE INDEX idx_ad_conversion_logs_idempotency
  ON ad_conversion_logs(ad_platform_id, friend_id, event_name, idempotency_key);

CREATE INDEX idx_ad_conversion_logs_platform ON ad_conversion_logs (ad_platform_id);

CREATE INDEX idx_ad_conversion_logs_status ON ad_conversion_logs (status);

CREATE INDEX idx_ad_conversion_outbox_due
  ON ad_conversion_outbox(status, next_attempt_at);

CREATE INDEX idx_ad_conversion_outbox_friend
  ON ad_conversion_outbox(friend_id);

CREATE INDEX idx_ad_conversion_outbox_retryable_due
  ON ad_conversion_outbox(is_retryable, status, next_attempt_at);

CREATE INDEX idx_ad_cost_entries_account_day ON ad_cost_entries(line_account_id, day);

CREATE INDEX idx_ad_cost_entries_route ON ad_cost_entries(entry_route_id, day);

CREATE UNIQUE INDEX idx_ad_cost_entries_unique_day
  ON ad_cost_entries(
    line_account_id,
    COALESCE(ad_platform_id, ''),
    COALESCE(entry_route_id, ''),
    source_label,
    day
  );

CREATE INDEX idx_ad_mapping_dispatch_account ON ad_event_mapping_dispatches(line_account_id,completed);

CREATE INDEX idx_ad_platforms_account ON ad_platforms(line_account_id);

CREATE UNIQUE INDEX idx_ad_platforms_account_name
  ON ad_platforms(line_account_id, name);

CREATE INDEX idx_admin_sessions_expires_at ON admin_sessions(expires_at);

CREATE INDEX idx_admin_sessions_restaurant_store
  ON admin_sessions(selected_restaurant_store_id)
  WHERE selected_restaurant_store_id IS NOT NULL;

CREATE INDEX idx_admin_sessions_staff_device
  ON admin_sessions(staff_id, device_hash);

CREATE INDEX idx_admin_sessions_staff_id ON admin_sessions(staff_id);

CREATE INDEX idx_admin_sessions_staff_ip_prefix
  ON admin_sessions(staff_id, ip_prefix);

CREATE INDEX idx_admin_two_factor_challenges_expires
  ON admin_two_factor_challenges(expires_at);

CREATE INDEX idx_admin_two_factor_challenges_staff
  ON admin_two_factor_challenges(staff_id);

CREATE INDEX idx_affiliate_attribution_decisions_friend
  ON affiliate_attribution_decisions (friend_id, created_at DESC);

CREATE INDEX idx_affiliate_attribution_decisions_offer
  ON affiliate_attribution_decisions (offer_id, created_at DESC);

CREATE INDEX idx_affiliate_bank_profiles_scope
  ON affiliate_bank_profiles(organization_id, line_account_id, affiliate_id);

CREATE INDEX idx_affiliate_clicks_affiliate ON affiliate_clicks (affiliate_id);

CREATE INDEX idx_affiliate_links_affiliate ON affiliate_links (affiliate_id);

CREATE INDEX idx_affiliate_links_offer ON affiliate_links (offer_id);

CREATE UNIQUE INDEX idx_affiliate_links_operation_id
  ON affiliate_links(affiliate_id, operation_id)
  WHERE operation_id IS NOT NULL;

CREATE INDEX idx_affiliate_offer_versions_offer
  ON affiliate_offer_versions (offer_id, version_number DESC);

CREATE INDEX idx_affiliate_offers_folder ON affiliate_offers(line_account_id,folder_id);

CREATE UNIQUE INDEX idx_affiliate_offers_operation_id
  ON affiliate_offers(line_account_id, operation_id)
  WHERE operation_id IS NOT NULL;

CREATE UNIQUE INDEX idx_affiliate_payout_batches_idempotency
  ON affiliate_payout_batches(organization_id, line_account_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_affiliate_reward_calculations_scope
  ON affiliate_reward_calculations(organization_id, line_account_id, affiliate_id);

CREATE INDEX idx_affiliate_reward_entries_scope_status
  ON affiliate_reward_entries(organization_id, line_account_id, affiliate_id, status, created_at DESC);

CREATE UNIQUE INDEX idx_affiliate_settlement_lines_adjustment
  ON affiliate_settlement_lines(adjustment_id) WHERE adjustment_id IS NOT NULL;

CREATE UNIQUE INDEX idx_affiliate_settlement_lines_entry
  ON affiliate_settlement_lines(entry_id) WHERE entry_id IS NOT NULL;

CREATE INDEX idx_affiliate_settlements_scope_created
  ON affiliate_settlements(organization_id, line_account_id, affiliate_id, created_at DESC);

CREATE UNIQUE INDEX idx_affiliate_statements_idempotency
  ON affiliate_statements(organization_id, line_account_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_affiliates_folder ON affiliates(line_account_id,folder_id);

CREATE UNIQUE INDEX idx_affiliates_friend ON affiliates (friend_id) WHERE friend_id IS NOT NULL;

CREATE UNIQUE INDEX idx_affiliates_operation_id
  ON affiliates(tenant_id, line_account_id, operation_id)
  WHERE operation_id IS NOT NULL;

CREATE INDEX idx_affiliates_tenant_account_created
  ON affiliates(tenant_id, line_account_id, created_at DESC);

CREATE INDEX idx_analytics_cross_members_selection
  ON analytics_cross_run_members(run_id, lease_generation, row_key, col_key, friend_id);

CREATE INDEX idx_analytics_cross_runs_account_time
  ON analytics_cross_runs(line_account_id, created_at DESC, id DESC);

CREATE INDEX idx_analytics_cross_runs_pending
  ON analytics_cross_runs(state, created_at, id);

CREATE INDEX idx_analytics_daily_metrics_account_date
  ON analytics_daily_metrics(line_account_id, metric_date DESC, metric_key);

CREATE INDEX idx_analytics_events_account_time
  ON analytics_events(line_account_id, occurred_at, id);

CREATE INDEX idx_analytics_events_account_type_time
  ON analytics_events(line_account_id, event_type, occurred_at, id);

CREATE INDEX idx_analytics_events_friend_time
  ON analytics_events(line_account_id, friend_id, occurred_at, id)
  WHERE friend_id IS NOT NULL;

CREATE INDEX idx_analytics_export_jobs_account
  ON analytics_export_jobs(line_account_id, created_at DESC);

CREATE INDEX idx_analytics_funnel_members_selection
  ON analytics_funnel_run_members(run_id, group_key, highest_step_order, state, friend_id);

CREATE INDEX idx_analytics_funnel_runs_account_time
  ON analytics_funnel_runs(line_account_id, created_at DESC, id DESC);

CREATE INDEX idx_analytics_funnel_versions_current
  ON analytics_funnel_versions(line_account_id, funnel_id, version_number DESC);

CREATE INDEX idx_analytics_reconciliation_account_time
  ON analytics_reconciliation_runs(line_account_id, completed_at DESC);

CREATE INDEX idx_analytics_report_runs_history
  ON analytics_report_runs(line_account_id, schedule_id, scheduled_for DESC);

CREATE INDEX idx_analytics_report_schedules_due
  ON analytics_report_schedules(status, next_run_at, line_account_id);

CREATE INDEX idx_analytics_result_audiences_expiry ON analytics_result_audiences(line_account_id,expires_at);

CREATE INDEX idx_analytics_saved_analyses_account
  ON analytics_saved_analyses(line_account_id, status, updated_at DESC, id DESC);

CREATE INDEX idx_analytics_saved_snapshots_history
  ON analytics_saved_analysis_snapshots(line_account_id, saved_analysis_id, created_at DESC, id DESC);

CREATE INDEX idx_analytics_saved_versions_current
  ON analytics_saved_analysis_versions(line_account_id, saved_analysis_id, version_number DESC);

CREATE INDEX idx_analytics_url_exposure_queue_due
  ON analytics_url_exposure_queue(status, available_at, created_at)
  WHERE status IN ('pending','failed');

CREATE INDEX idx_analytics_url_exposures_friend_time
  ON analytics_url_exposures(line_account_id, friend_id, sent_at)
  WHERE friend_id IS NOT NULL;

CREATE INDEX idx_analytics_url_exposures_link_time
  ON analytics_url_exposures(line_account_id, tracked_link_id, sent_at, friend_id);

CREATE INDEX idx_audit_events_account_created
  ON audit_events (line_account_id, created_at DESC);

CREATE INDEX idx_audit_events_action_created
  ON audit_events (action, created_at DESC);

CREATE INDEX idx_audit_events_actor_created
  ON audit_events (actor_principal_id, created_at DESC);

CREATE INDEX idx_audit_events_security_utc ON audit_events (security_created_at_jd);

CREATE INDEX idx_audit_events_tenant_created
  ON audit_events (tenant_id, created_at DESC);

CREATE INDEX idx_auth_email_tokens_application
  ON auth_email_tokens(application_id, created_at DESC);

CREATE INDEX idx_auth_email_tokens_email
  ON auth_email_tokens(purpose, email, created_at DESC);

CREATE INDEX idx_auth_email_tokens_ip
  ON auth_email_tokens(purpose, ip_hash, created_at DESC);

CREATE INDEX idx_auth_known_devices_last_seen ON auth_known_devices(last_seen_at);

CREATE INDEX idx_auth_step_up_grants_staff_expiry
  ON auth_step_up_grants(staff_id, expires_at);

CREATE INDEX idx_auto_replies_template_id ON auto_replies(template_id);

CREATE INDEX idx_auto_reply_action_runs_evaluation
  ON auto_reply_action_runs (evaluation_id, status);

CREATE INDEX idx_auto_reply_create_requests_rule
  ON auto_reply_create_requests(auto_reply_id, created_at DESC);

CREATE INDEX idx_auto_reply_deliveries_due ON auto_reply_deliveries(status, due_at);

CREATE INDEX idx_auto_reply_evaluation_details_evaluation
  ON auto_reply_evaluation_details (evaluation_id, evaluation_order);

CREATE INDEX idx_auto_reply_evaluations_account_time
  ON auto_reply_evaluations (line_account_id, evaluated_at DESC);

CREATE INDEX idx_auto_reply_evaluations_rule_time
  ON auto_reply_evaluations (winning_auto_reply_id, evaluated_at DESC);

CREATE INDEX idx_auto_reply_evaluations_status_time
  ON auto_reply_evaluations (status, evaluated_at DESC);

CREATE INDEX idx_auto_reply_hits_friend ON auto_reply_hits(auto_reply_id, friend_id);

CREATE INDEX idx_auto_reply_hits_rule   ON auto_reply_hits(auto_reply_id, hit_at);

CREATE INDEX idx_auto_reply_versions_current
  ON auto_reply_versions (auto_reply_id, version_number DESC);

CREATE UNIQUE INDEX idx_auto_reply_versions_publish_key
  ON auto_reply_versions (publish_idempotency_key)
  WHERE publish_idempotency_key IS NOT NULL;

CREATE INDEX idx_auto_reply_versions_status
  ON auto_reply_versions (auto_reply_id, status, version_number DESC);

CREATE INDEX idx_automation_definitions_account_status
  ON automation_definitions(line_account_id, status, priority DESC);

CREATE INDEX idx_automation_definitions_folder ON automation_definitions(line_account_id, folder_id);

CREATE INDEX idx_automation_logs_automation ON automation_logs (automation_id);

CREATE INDEX idx_automation_run_daily_counts_day
  ON automation_run_daily_counts(day);

CREATE INDEX idx_automation_run_steps_common_action_metrics
  ON automation_run_steps(common_action_version_id, automation_run_id, status, step_key)
  WHERE common_action_version_id IS NOT NULL;

CREATE UNIQUE INDEX idx_automation_run_steps_one_per_step
  ON automation_run_steps(automation_run_id, step_key);

CREATE INDEX idx_automation_run_steps_retry
  ON automation_run_steps(status, retry_at)
  WHERE status IN ('queued', 'waiting', 'failed');

CREATE INDEX idx_automation_run_steps_run
  ON automation_run_steps(automation_run_id, step_key, attempt_number);

CREATE INDEX idx_automation_runs_account_status_created
  ON automation_runs(line_account_id, status, created_at DESC);

CREATE INDEX idx_automation_runs_automation_created
  ON automation_runs(automation_id, created_at DESC);

CREATE INDEX idx_automation_runs_definition_metrics
  ON automation_runs(automation_id, is_test, created_at DESC, status);

CREATE INDEX idx_automation_runs_due
  ON automation_runs(status, resume_at, lease_expires_at)
  WHERE status IN ('queued', 'waiting', 'running');

CREATE INDEX idx_automation_runs_friend_created
  ON automation_runs(friend_id, created_at DESC);

CREATE INDEX idx_automation_runs_waiting
  ON automation_runs(status, resume_at)
  WHERE status = 'waiting';

CREATE INDEX idx_automation_versions_automation_status
  ON automation_versions(automation_id, status, version_number DESC);

CREATE INDEX idx_automations_active ON automations (is_active);

CREATE INDEX idx_automations_event ON automations (event_type);

CREATE INDEX idx_banner_generations_project
  ON banner_generations(project_id, created_at DESC);

CREATE INDEX idx_banner_generations_reference
  ON banner_generations(reference_image_id) WHERE reference_image_id IS NOT NULL;

CREATE INDEX idx_banner_generations_tenant_status
  ON banner_generations(tenant_id, status);

CREATE INDEX idx_banner_images_folder ON banner_images(tenant_id,folder_id,deleted_at);

CREATE INDEX idx_banner_images_project
  ON banner_images(project_id, deleted_at, created_at DESC);

CREATE INDEX idx_banner_images_tenant
  ON banner_images(tenant_id, deleted_at, created_at DESC);

CREATE INDEX idx_banner_projects_folder ON banner_projects(tenant_id,folder_id,archived_at);

CREATE INDEX idx_banner_projects_tenant
  ON banner_projects(tenant_id, archived_at, updated_at DESC);

CREATE INDEX idx_banner_usage_tenant_created
  ON banner_usage_ledger(tenant_id, created_at);

CREATE INDEX idx_billing_events_tenant
  ON billing_events(tenant_id, received_at DESC);

CREATE INDEX idx_billing_invoices_paid
  ON billing_invoices(paid_at);

CREATE INDEX idx_billing_invoices_tenant_paid
  ON billing_invoices(tenant_id, paid_at);

CREATE INDEX idx_booking_audit_logs_booking
  ON booking_audit_logs(line_account_id, booking_id, occurred_at);

CREATE INDEX idx_booking_business_hours_setting_weekday
  ON booking_business_hours(booking_settings_id, weekday, start_time);

CREATE INDEX idx_booking_customers_account_name
  ON booking_customers(line_account_id, display_name);

CREATE INDEX idx_booking_customers_account_phone
  ON booking_customers(line_account_id, phone_normalized_hash);

CREATE INDEX idx_booking_entitlement_events_history ON booking_entitlement_events(entitlement_id,created_at,id);

CREATE INDEX idx_booking_entitlement_uses_balance ON booking_entitlement_uses(entitlement_id,consumed_at);

CREATE INDEX idx_booking_entitlements_friend ON booking_entitlements(line_account_id,friend_id,status);

CREATE INDEX idx_booking_exceptions_account_dates
  ON booking_availability_exceptions(line_account_id, date_from, date_to, scope_kind);

CREATE INDEX idx_booking_menu_resources_resource
  ON booking_menu_resources(resource_id, menu_id);

CREATE INDEX idx_booking_noshow_flag_events_friend
  ON booking_noshow_flag_events(line_account_id, friend_id, created_at DESC);

CREATE INDEX idx_booking_noshow_flags_friend
  ON booking_noshow_flags(friend_id, line_account_id);

CREATE INDEX idx_booking_operation_runs_booking
  ON booking_operation_runs(line_account_id, booking_id, created_at DESC);

CREATE INDEX idx_booking_operation_runs_status
  ON booking_operation_runs(status, scheduled_at);

CREATE INDEX idx_booking_payment_booking_links_payment ON booking_payment_booking_links(payment_id,created_at);

CREATE INDEX idx_booking_payment_events_account_received ON booking_payment_events(line_account_id,received_at DESC,id);

CREATE INDEX idx_booking_payment_refunds_account_date ON booking_payment_refunds(line_account_id,created_at);

CREATE INDEX idx_booking_payments_booking
  ON booking_payments(booking_id, created_at DESC);

CREATE INDEX idx_booking_payments_status_hold
  ON booking_payments(line_account_id, status, hold_until);

CREATE INDEX idx_booking_reminders_v298_status_scheduled
  ON booking_reminders(status, scheduled_at);

CREATE INDEX idx_booking_resource_consumptions_resource
  ON booking_resource_consumptions(line_account_id, resource_id, booking_id);

CREATE INDEX idx_booking_resources_account_active
  ON booking_resources(line_account_id, is_active, id);

CREATE INDEX idx_booking_visit_marks_account
  ON booking_visit_marks(line_account_id, marked_at DESC);

CREATE INDEX idx_booking_visit_marks_booking
  ON booking_visit_marks(booking_id, marked_at DESC);

CREATE UNIQUE INDEX idx_booking_waitlist_conversion ON bookings(waitlist_entry_id) WHERE waitlist_entry_id IS NOT NULL;

CREATE INDEX idx_booking_waitlist_slot_created
  ON booking_waitlist(line_account_id, staff_id, starts_at, status, created_at);

CREATE UNIQUE INDEX idx_booking_waitlist_slot_identity
  ON booking_waitlist(line_account_id, staff_id, starts_at, identity_key)
  WHERE status IN ('waiting', 'invited');

CREATE INDEX idx_bookings_menu_version
  ON bookings (menu_id, menu_version_number);

CREATE INDEX idx_bookings_v298_account_status_starts
  ON bookings(line_account_id, status, starts_at);

CREATE INDEX idx_bookings_v298_customer_starts
  ON bookings(booking_customer_id, starts_at DESC);

CREATE INDEX idx_bookings_v298_friend_starts
  ON bookings(friend_id, starts_at DESC);

CREATE INDEX idx_bookings_v298_staff_overlap
  ON bookings(staff_id, status, starts_at, block_ends_at);

CREATE INDEX idx_broadcast_after_action_runs_due
  ON broadcast_after_action_runs (status, updated_at);

CREATE INDEX idx_broadcast_approval_events_broadcast
  ON broadcast_approval_events (broadcast_id, created_at DESC);

CREATE INDEX idx_broadcast_asset_folders_account
  ON broadcast_asset_folders(line_account_id, display_order);

CREATE INDEX idx_broadcast_asset_versions_asset
  ON broadcast_asset_versions(asset_id, version_number DESC);

CREATE INDEX idx_broadcast_insights_broadcast_id ON broadcast_insights(broadcast_id);

CREATE INDEX idx_broadcast_insights_status ON broadcast_insights(status);

CREATE INDEX idx_broadcast_lifecycle_events_broadcast
  ON broadcast_lifecycle_events (broadcast_id, created_at DESC);

CREATE INDEX idx_broadcast_message_assets_account_kind
  ON broadcast_message_assets(line_account_id, kind, updated_at DESC);

CREATE INDEX idx_broadcast_saved_views_account_updated
  ON broadcast_saved_views(line_account_id, updated_at DESC, id);

CREATE INDEX idx_broadcast_send_claims_state
  ON broadcast_send_claims (broadcast_id, state);

CREATE INDEX idx_broadcast_tracked_links_link
  ON broadcast_tracked_links(tracked_link_id, broadcast_id);

CREATE INDEX idx_broadcasts_approval_approver ON broadcasts (approval_approver_staff_id);

CREATE INDEX idx_broadcasts_approval_status ON broadcasts (approval_status);

CREATE INDEX idx_broadcasts_status_lookup ON broadcasts (status);

CREATE INDEX idx_broadcasts_stopped
  ON broadcasts (status, stopped_at);

CREATE INDEX idx_calendar_bookings_friend ON calendar_bookings (friend_id);

CREATE INDEX idx_calendar_bookings_start ON calendar_bookings (start_at);

CREATE INDEX idx_carousel_taps_action ON carousel_taps(template_id, column_index, action_index);

CREATE INDEX idx_carousel_taps_friend ON carousel_taps(template_id, friend_id);

CREATE INDEX idx_chats_assignee_staff ON chats(assignee_staff_id);

CREATE INDEX idx_chats_friend_status_message ON chats (friend_id, status, last_message_at);

CREATE UNIQUE INDEX idx_chats_friend_unique ON chats (friend_id);

CREATE INDEX idx_chats_operator ON chats (operator_id);

CREATE INDEX idx_chats_sla_due ON chats(sla_due_at) WHERE first_response_at IS NULL;

CREATE INDEX idx_chats_status ON chats (status);

CREATE INDEX idx_chats_unanswered_page
  ON chats (last_customer_message_at DESC, friend_id DESC)
  WHERE status != 'resolved' AND last_customer_message_at IS NOT NULL;

CREATE INDEX idx_codex_cloud_tasks_status
  ON codex_cloud_tasks(status, updated_at DESC);

CREATE INDEX idx_codex_cloud_tasks_thread
  ON codex_cloud_tasks(channel_id, thread_ts, detected_at DESC);

CREATE INDEX idx_common_action_binding_migrations_binding
  ON common_action_binding_migration_events(binding_id, created_at DESC);

CREATE INDEX idx_common_action_bindings_action
  ON common_action_bindings(common_action_id, common_action_version_id);

CREATE INDEX idx_common_action_bindings_consumer
  ON common_action_bindings(line_account_id, consumer_type, consumer_id);

CREATE INDEX idx_common_action_versions_action_status
  ON common_action_versions(common_action_id, status, version_number DESC);

CREATE INDEX idx_common_actions_account_status
  ON common_actions(line_account_id, status, updated_at DESC);

CREATE INDEX idx_common_actions_folder ON common_actions(line_account_id, folder_id);

CREATE UNIQUE INDEX idx_common_actions_request_key
  ON common_actions(line_account_id, client_request_key);

CREATE INDEX idx_common_var_export_jobs_account
  ON common_var_export_jobs(line_account_id, created_at DESC);

CREATE INDEX idx_common_var_replacement_runs_v403_source ON common_var_replacement_runs(source_common_var_id, created_at DESC);

CREATE INDEX idx_common_var_resolution_failures_source_v485
  ON common_var_resolution_failures(source_kind, source_id, created_at DESC);

CREATE INDEX idx_common_var_schedules_v403_pending ON common_var_schedules(var_id, effective_from) WHERE applied_at IS NULL;

CREATE INDEX idx_common_var_versions_v403_history ON common_var_versions(common_var_id, version_no DESC);

CREATE INDEX idx_common_vars_v403_account_active ON common_vars(line_account_id, archived_at, name, id);

CREATE INDEX idx_common_vars_v403_account_name ON common_vars(line_account_id, name, id);

CREATE INDEX idx_conversion_definition_operations_point
  ON conversion_definition_operations(conversion_point_id, created_at DESC);

CREATE INDEX idx_conversion_definition_revisions_point
  ON conversion_definition_revisions(conversion_point_id, created_at DESC);

CREATE INDEX idx_conversion_definition_usages_account
  ON conversion_definition_usages(line_account_id, ref_kind, ref_id);

CREATE INDEX idx_conversion_definition_usages_point
  ON conversion_definition_usages(conversion_point_id, created_at DESC);

CREATE UNIQUE INDEX idx_conversion_definition_usages_reference
  ON conversion_definition_usages(
    conversion_point_id,
    line_account_id,
    ref_kind,
    ref_id,
    COALESCE(ref_version_id, '')
  );

CREATE INDEX idx_conversion_event_dedup_claims_event
  ON conversion_event_dedup_claims(last_event_id);

CREATE INDEX idx_conversion_event_reversals_event
  ON conversion_event_reversals(conversion_event_id, created_at DESC);

CREATE INDEX idx_conversion_events_affiliate ON conversion_events (affiliate_code);

CREATE INDEX idx_conversion_events_created_friend ON conversion_events(created_at, friend_id);

CREATE INDEX idx_conversion_events_friend ON conversion_events (friend_id);

CREATE INDEX idx_conversion_events_point ON conversion_events (conversion_point_id);

CREATE UNIQUE INDEX idx_conversion_events_point_idempotency
  ON conversion_events(conversion_point_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_conversion_events_tenant
  ON conversion_events(tenant_id);

CREATE INDEX idx_conversion_ingestion_events_point
  ON conversion_ingestion_events(conversion_point_id, created_at DESC);

CREATE INDEX idx_conversion_points_folder ON conversion_points(line_account_id, folder_id);

CREATE INDEX idx_conversion_points_ingest ON conversion_points(id)
  WHERE ingest_secret_encrypted IS NOT NULL;

CREATE INDEX idx_conversion_points_status ON conversion_points(status, created_at DESC);

CREATE INDEX idx_conversion_points_tenant ON conversion_points(tenant_id);

CREATE INDEX idx_coupon_redemptions_friend ON coupon_redemptions(asset_id, friend_id);

CREATE INDEX idx_coupon_redemptions_receipt ON coupon_redemptions(entry_route_coupon_receipt_id);

CREATE INDEX idx_customer_notification_definitions_account
  ON customer_notification_definitions(line_account_id, status, category, name, id);

CREATE INDEX idx_dashboard_preferences_account
  ON dashboard_preferences(line_account_id, updated_at DESC);

CREATE INDEX idx_ec_action_attempts_execution
  ON ec_action_execution_attempts(action_execution_id, attempt_number DESC);

CREATE INDEX idx_ec_action_executions_account_status
  ON ec_action_executions(line_account_id, status, updated_at DESC);

CREATE INDEX idx_ec_action_executions_event
  ON ec_action_executions(event_id, created_at);

CREATE INDEX idx_ec_connectors_status
  ON ec_connectors(status, updated_at DESC);

CREATE INDEX idx_ec_events_account_received ON ec_events(line_account_id, received_at DESC);

CREATE INDEX idx_ec_events_customer ON ec_events(customer_id, received_at DESC);

CREATE INDEX idx_ec_events_friend ON ec_events(friend_id, received_at DESC);

CREATE INDEX idx_ec_events_identity_pending
  ON ec_events(line_account_id, received_at DESC) WHERE status = 'identity_pending';

CREATE INDEX idx_ec_events_status_received ON ec_events(status, received_at);

CREATE UNIQUE INDEX idx_ec_identity_links_active_customer
  ON ec_identity_links(tenant_id, source_key, shop_key, external_customer_id)
  WHERE unlinked_at IS NULL;

CREATE INDEX idx_ec_identity_links_friend
  ON ec_identity_links(tenant_id, line_account_id, friend_id, linked_at DESC);

CREATE INDEX idx_ec_order_lines_order
  ON ec_order_lines(order_id, line_index);

CREATE INDEX idx_ec_orders_account_ordered
  ON ec_orders(line_account_id, ordered_at DESC, id DESC);

CREATE INDEX idx_ec_orders_customer
  ON ec_orders(line_account_id, customer_id, ordered_at DESC);

CREATE UNIQUE INDEX idx_ec_v6_dispatches_idempotency
  ON ec_v6_dispatches (idempotency_key);

CREATE INDEX idx_engagement_events_actor_friend
  ON engagement_events(program_id, actor_friend_id, occurred_at DESC);

CREATE INDEX idx_engagement_events_actor_user
  ON engagement_events(program_id, actor_user_id, occurred_at DESC);

CREATE INDEX idx_engagement_events_source
  ON engagement_events(source, source_event_id);

CREATE INDEX idx_entry_coupon_receipts_asset_friend ON entry_route_coupon_receipts(asset_id, friend_id, received_at);

CREATE INDEX idx_entry_route_genres_created
  ON entry_route_genres (created_at ASC);

CREATE INDEX idx_entry_routes_account_active
  ON entry_routes(line_account_id, is_active);

CREATE INDEX idx_entry_routes_genre
  ON entry_routes (genre, created_at DESC);

CREATE INDEX idx_entry_routes_line_account_active
  ON entry_routes(line_account_id, is_active, name, id);

CREATE INDEX idx_entry_routes_pool ON entry_routes (pool_id);

CREATE INDEX idx_entry_routes_ref ON entry_routes (ref_code);

CREATE INDEX idx_entry_routes_tenant
  ON entry_routes(tenant_id);

CREATE INDEX idx_event_booking_idempotency_expires ON event_booking_idempotency_keys (expires_at);

CREATE INDEX idx_event_booking_reminders_status_scheduled ON event_booking_reminders (status, scheduled_at);

CREATE INDEX idx_event_bookings_account_status_event ON event_bookings (line_account_id, status, event_id);

CREATE INDEX idx_event_bookings_friend_requested ON event_bookings (friend_id, requested_at DESC);

CREATE INDEX idx_event_bookings_identity_status
  ON event_bookings (event_id, identity_key, status);

CREATE INDEX idx_event_bookings_requested_expiry
  ON event_bookings (status, approval_expires_at);

CREATE INDEX idx_event_bookings_slot_status ON event_bookings (slot_id, status);

CREATE INDEX idx_event_change_logs_event
  ON event_change_logs (event_id, created_at);

CREATE UNIQUE INDEX idx_event_change_logs_idem
  ON event_change_logs (line_account_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_event_entitlement_month ON event_booking_entitlement_uses(entitlement_id,consumed_at,period_start);

CREATE INDEX idx_event_occurrence_applicant_snapshots_expiry
  ON event_occurrence_applicant_snapshots(expires_at);

CREATE INDEX idx_event_occurrence_applicant_snapshots_scope_expiry
  ON event_occurrence_applicant_snapshots(line_account_id, occurrence_id, staff_id, expires_at);

CREATE UNIQUE INDEX idx_event_slots_client_key
  ON event_slots (event_id, client_key)
  WHERE client_key IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX idx_event_slots_event_starts ON event_slots (event_id, starts_at);

CREATE INDEX idx_event_transition_pending ON event_booking_transition_runs(status,created_at);

CREATE INDEX idx_event_versions_account_event
  ON event_versions (line_account_id, event_id, version_number DESC);

CREATE INDEX idx_event_waitlist_offer_expiry
  ON event_waitlist(status, offer_expires_at);

CREATE INDEX idx_event_waitlist_promotion_due
  ON event_waitlist_promotion_jobs(status, available_at, created_at);

CREATE INDEX idx_event_waitlist_slot_created
  ON event_waitlist(slot_id, status, created_at);

CREATE UNIQUE INDEX idx_event_waitlist_slot_identity
  ON event_waitlist(slot_id, identity_key)
  WHERE status IN ('waiting', 'offered', 'accepted');

CREATE INDEX idx_event_waitlist_slot_order
  ON event_waitlist (slot_id, status, sort_order, created_at);

CREATE INDEX idx_events_account_published_sort ON events (line_account_id, is_published, sort_order);

CREATE INDEX idx_events_lifecycle
  ON events (line_account_id, lifecycle_status);

CREATE INDEX idx_ffv_field ON friend_field_values(field_id, value);

CREATE INDEX idx_field_migration_items_status
  ON field_migration_items(run_id, status, friend_id);

CREATE UNIQUE INDEX idx_field_migration_runs_idempotency
  ON field_migration_runs(tenant_id, line_account_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_field_migration_runs_scope
  ON field_migration_runs(tenant_id, line_account_id, created_at DESC);

CREATE UNIQUE INDEX idx_folders_friend_add_name ON folders(account_id,name) WHERE kind='friend_add_rule';

CREATE INDEX idx_folders_kind_order_556 ON folders(kind, display_order);

CREATE INDEX idx_folders_webinar_account_order_556
  ON folders(kind, account_id, display_order, name);

CREATE INDEX idx_form_accounts_account
  ON form_accounts(line_account_id, form_id);

CREATE INDEX idx_form_capacity_claims_slot
  ON form_capacity_claims (form_id, slot_key);

CREATE INDEX idx_form_capacity_claims_submission
  ON form_capacity_claims (form_id, submission_id);

CREATE INDEX idx_form_opens_form ON form_opens (form_id, opened_at);

CREATE INDEX idx_form_opens_test_month
  ON form_opens(form_id, is_test, opened_at);

CREATE INDEX idx_form_submission_files_expiry ON form_submission_files(expires_at) WHERE deleted_at IS NULL;

CREATE INDEX idx_form_submission_files_owner ON form_submission_files(line_account_id, form_id, friend_id, block_id);

CREATE INDEX idx_form_submission_files_submission ON form_submission_files(submission_id);

CREATE INDEX idx_form_submissions_form ON form_submissions (form_id);

CREATE INDEX idx_form_submissions_form_friend
  ON form_submissions (form_id, friend_id);

CREATE INDEX idx_form_submissions_form_write_status
  ON form_submissions(form_id, destination_write_status, created_at DESC);

CREATE INDEX idx_form_submissions_friend ON form_submissions (friend_id);

CREATE INDEX idx_form_submissions_test_month
  ON form_submissions(form_id, is_test, created_at);

CREATE INDEX idx_form_submissions_version
  ON form_submissions(form_version_id)
  WHERE form_version_id IS NOT NULL;

CREATE INDEX idx_form_submit_claims_submission
  ON form_submit_claims (submission_id);

CREATE INDEX idx_form_submit_claims_updated
  ON form_submit_claims (updated_at);

CREATE INDEX idx_form_test_tokens_form
  ON form_test_tokens(form_id, expires_at);

CREATE INDEX idx_form_versions_form_number
  ON form_versions(form_id, version_number DESC);

CREATE INDEX idx_forms_status_updated
  ON forms(status, updated_at DESC);

CREATE INDEX idx_friend_add_action_runs_v357_event_status
  ON friend_add_action_runs(event_id, status, created_at, id);

CREATE INDEX idx_friend_add_action_runs_v357_retry
  ON friend_add_action_runs(status, next_retry_at);

CREATE INDEX idx_friend_add_candidates_expiry
  ON friend_add_attribution_candidates(status, expires_at);

CREATE INDEX idx_friend_add_candidates_match
  ON friend_add_attribution_candidates(line_account_id, friend_id, status, occurred_at DESC);

CREATE INDEX idx_friend_add_events_v357_account_state
  ON friend_add_events(line_account_id, friend_kind, attribution_status, routing_status);

CREATE INDEX idx_friend_add_events_v357_account_time
  ON friend_add_events(line_account_id, occurred_at DESC, id DESC);

CREATE INDEX idx_friend_add_events_v357_friend
  ON friend_add_events(line_account_id, friend_id, occurred_at DESC);

CREATE INDEX idx_friend_add_events_v357_rule_time
  ON friend_add_events(line_account_id, routing_rule_id, occurred_at DESC, id DESC);

CREATE UNIQUE INDEX idx_friend_add_routing_one_draft
  ON friend_add_routing_versions (line_account_id)
  WHERE status = 'draft';

CREATE UNIQUE INDEX idx_friend_add_routing_one_published
  ON friend_add_routing_versions (line_account_id)
  WHERE status = 'published';

CREATE INDEX idx_friend_add_routing_versions_status
  ON friend_add_routing_versions (line_account_id, status, version_number DESC);

CREATE INDEX idx_friend_add_rule_folders_account_name
  ON friend_add_rule_folders(line_account_id, name, id);

CREATE UNIQUE INDEX idx_friend_add_rule_versions_one_draft
  ON friend_add_rule_versions (rule_id)
  WHERE status = 'draft';

CREATE UNIQUE INDEX idx_friend_add_rule_versions_one_published
  ON friend_add_rule_versions (rule_id)
  WHERE status = 'published';

CREATE INDEX idx_friend_add_rules_account_kind_priority
  ON friend_add_rules (line_account_id, friend_kind, priority, created_at);

CREATE UNIQUE INDEX idx_friend_add_rules_create_idempotency
  ON friend_add_rules (line_account_id, create_idempotency_key)
  WHERE create_idempotency_key IS NOT NULL;

CREATE INDEX idx_friend_add_rules_folder ON friend_add_rules(line_account_id,folder_id);

CREATE UNIQUE INDEX idx_friend_add_rules_stop_idempotency
  ON friend_add_rules(line_account_id, stop_idempotency_key)
  WHERE stop_idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX idx_friend_add_rules_unknown_fallback
  ON friend_add_rules (line_account_id, friend_kind)
  WHERE is_unknown_route_fallback = 1 AND archived_at IS NULL;

CREATE INDEX idx_friend_add_send_claims_stale
  ON friend_add_send_claims(claimed_at);

CREATE INDEX idx_friend_bulk_run_items_work
  ON friend_bulk_run_items(run_id, status, retry_at, lease_expires_at, ordinal);

CREATE INDEX idx_friend_bulk_runs_actor
  ON friend_bulk_runs(tenant_id, created_by, created_at DESC);

CREATE INDEX idx_friend_bulk_runs_due
  ON friend_bulk_runs(status, scheduled_at, updated_at);

CREATE INDEX idx_friend_daily_snapshots_date
  ON friend_daily_snapshots (line_account_id, date);

CREATE INDEX idx_friend_export_jobs_account
  ON friend_export_jobs(line_account_id, created_at DESC);

CREATE INDEX idx_friend_field_create_requests_field
  ON friend_field_create_requests(line_account_id, field_id, created_at DESC);

CREATE INDEX idx_friend_field_scopes_account
  ON friend_field_scopes(tenant_id, line_account_id);

CREATE INDEX idx_friend_fields_order ON friend_fields(display_order, id);

CREATE UNIQUE INDEX idx_friend_identity_links_active_friend
  ON friend_identity_links(friend_id) WHERE unlinked_at IS NULL;

CREATE INDEX idx_friend_identity_links_user
  ON friend_identity_links(tenant_id, user_id, linked_at DESC);

CREATE INDEX idx_friend_import_jobs_account
  ON friend_import_jobs(line_account_id, created_at DESC);

CREATE INDEX idx_friend_reminders_friend ON friend_reminders (friend_id);

CREATE UNIQUE INDEX idx_friend_reminders_source_event
  ON friend_reminders (reminder_id, friend_id, source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE INDEX idx_friend_reminders_status ON friend_reminders (status);

CREATE INDEX idx_friend_scenarios_due_delivery
ON friend_scenarios (next_delivery_at, id)
WHERE status = 'active' AND next_delivery_at IS NOT NULL;

CREATE INDEX idx_friend_scenarios_friend_id ON friend_scenarios (friend_id);

CREATE INDEX idx_friend_scenarios_next_delivery_at ON friend_scenarios (next_delivery_at);

CREATE INDEX idx_friend_scenarios_published_version
  ON friend_scenarios (published_version_id)
  WHERE published_version_id IS NOT NULL;

CREATE INDEX idx_friend_scenarios_status ON friend_scenarios (status);

CREATE UNIQUE INDEX idx_friend_scenarios_unique ON friend_scenarios (friend_id, scenario_id) WHERE status != 'completed';

CREATE UNIQUE INDEX idx_friend_scores_account_idempotency
  ON friend_scores(line_account_id, idempotency_key)
  WHERE line_account_id IS NOT NULL AND idempotency_key IS NOT NULL;

CREATE INDEX idx_friend_scores_created ON friend_scores (created_at);

CREATE INDEX idx_friend_scores_friend ON friend_scores (friend_id);

CREATE INDEX idx_friend_scores_rule_frequency
  ON friend_scores(line_account_id, friend_id, rule_key, frequency_key, occurred_at);

CREATE INDEX idx_friend_scores_source_event
  ON friend_scores(line_account_id, source, source_event_id);

CREATE INDEX idx_friend_tag_side_effect_runs_unfinished
  ON friend_tag_side_effect_runs(status, updated_at);

CREATE INDEX idx_friend_tags_tag_id ON friend_tags (tag_id);

CREATE INDEX idx_friends_account_created
  ON friends(line_account_id, created_at DESC);

CREATE INDEX idx_friends_follow_tenure ON friends(is_following, current_follow_started_at);

CREATE INDEX idx_friends_hidden_created ON friends(is_hidden, created_at DESC);

CREATE INDEX idx_friends_ig_igsid ON friends (ig_igsid);

CREATE INDEX idx_friends_line_user_id ON friends (line_user_id);

CREATE INDEX idx_friends_mark ON friends(support_mark_id);

CREATE INDEX idx_friends_user_id ON friends (user_id);

CREATE INDEX idx_funnels_line_account_created
  ON funnels(line_account_id, created_at DESC);

CREATE INDEX idx_google_calendar_connections_staff
  ON google_calendar_connections (line_account_id, staff_id, is_active);

CREATE INDEX idx_google_sheets_oauth_states_expires
  ON google_sheets_oauth_states(expires_at);

CREATE INDEX idx_google_sheets_sync_runs_integration
  ON google_sheets_sync_runs(integration_id, started_at DESC);

CREATE INDEX idx_google_sheets_sync_runs_running
  ON google_sheets_sync_runs(integration_id, status)
  WHERE status = 'running';

CREATE INDEX idx_handover_decisions_handover
  ON account_handover_decisions (handover_id);

CREATE INDEX idx_health_logs_account ON account_health_logs (line_account_id);

CREATE UNIQUE INDEX idx_hq_banner_folder_name ON hq_banner_folders(tenant_id,kind,name) WHERE archived_at IS NULL;

CREATE UNIQUE INDEX idx_hq_broadcast_folder_name ON hq_broadcast_folders(tenant_id,name) WHERE archived_at IS NULL;

CREATE INDEX idx_hq_broadcast_folders_order ON hq_broadcast_folders(tenant_id,archived_at,display_order,name,id);

CREATE UNIQUE INDEX idx_hq_broadcast_saved_views_name ON hq_broadcast_saved_views(tenant_id,staff_id,scope,name) WHERE archived_at IS NULL;

CREATE INDEX idx_hq_broadcast_saved_views_visible ON hq_broadcast_saved_views(tenant_id,scope,staff_id,archived_at,updated_at);

CREATE UNIQUE INDEX idx_hq_folder_name ON hq_template_folders(tenant_id, name) WHERE archived_at IS NULL;

CREATE INDEX idx_hq_form_test_tokens_active ON hq_form_test_tokens(tenant_id,template_id,expires_at);

CREATE INDEX idx_hq_support_messages_request
  ON hq_support_messages(request_id, created_at);

CREATE INDEX idx_hq_support_requests_stage
  ON hq_support_requests(stage, last_message_at DESC);

CREATE INDEX idx_hq_support_requests_tenant
  ON hq_support_requests(tenant_id, created_at DESC);

CREATE UNIQUE INDEX idx_hq_support_requests_ticket_no
  ON hq_support_requests(ticket_no) WHERE ticket_no IS NOT NULL;

CREATE INDEX idx_hq_template_folders_order ON hq_template_folders(tenant_id,archived_at,display_order,name,id);

CREATE INDEX idx_hq_template_owned_r2_reconcile
  ON hq_template_owned_r2_keys(tenant_id, state, updated_at);

CREATE INDEX idx_hq_template_preflights_target
  ON hq_template_preflights(tenant_id, target_account_id, created_at);

CREATE INDEX idx_hq_template_resolutions_preflight
  ON hq_template_preflight_resolutions(tenant_id, preflight_id, source_id);

CREATE INDEX idx_hq_template_results_status
  ON hq_template_distribution_results(tenant_id, run_id, status);

CREATE INDEX idx_hq_template_runs_template
  ON hq_template_distribution_runs(tenant_id, template_id, created_at);

CREATE INDEX idx_hq_template_saved_views_scope ON hq_template_saved_views(tenant_id,scope,owner_staff_id,archived_at);

CREATE INDEX idx_hq_template_versions_template
  ON hq_template_versions(tenant_id, template_id, version DESC);

CREATE INDEX idx_hq_templates_folder ON hq_templates(tenant_id, folder_id, archived_at);

CREATE INDEX idx_hq_templates_tenant_type
  ON hq_templates(tenant_id, template_type, archived_at, updated_at);

CREATE INDEX idx_idempotency_expires ON booking_idempotency_keys (expires_at);

CREATE INDEX idx_identity_candidate_decisions_history
  ON identity_candidate_decisions(candidate_id, decided_at DESC);

CREATE INDEX idx_identity_candidates_left_account
  ON identity_candidates(tenant_id, left_line_account_id, status);

CREATE INDEX idx_identity_candidates_review_queue
  ON identity_candidates(tenant_id, kind, status, detected_at DESC);

CREATE INDEX idx_identity_candidates_right_account
  ON identity_candidates(tenant_id, right_line_account_id, status);

CREATE INDEX idx_identity_events_candidate_history
  ON identity_events(tenant_id, candidate_id, occurred_at DESC);

CREATE INDEX idx_identity_events_user_history
  ON identity_events(tenant_id, user_id, occurred_at DESC);

CREATE INDEX idx_impersonation_sessions_active
  ON impersonation_sessions(staff_id, ended_at);

CREATE INDEX idx_impersonation_sessions_tenant
  ON impersonation_sessions(tenant_id, started_at DESC);

CREATE UNIQUE INDEX idx_inbox_conversation_events_correlation
  ON inbox_conversation_events (correlation_id, event_type);

CREATE INDEX idx_inbox_conversation_events_lookup
  ON inbox_conversation_events (channel, conversation_id, created_at DESC);

CREATE INDEX idx_inbox_notes_lookup
  ON inbox_notes (channel, conversation_id, created_at ASC);

CREATE INDEX idx_inbox_reply_leases_expiry ON inbox_reply_leases (expires_at);

CREATE INDEX idx_inbox_staff_reads_conversation
  ON inbox_staff_reads (channel, conversation_id, staff_id);

CREATE INDEX idx_incoming_webhook_queue_due ON incoming_webhook_queue(status,next_attempt_at);

CREATE UNIQUE INDEX idx_incoming_webhook_receipts_body
  ON incoming_webhook_receipts (webhook_id, body_hash);

CREATE INDEX idx_incoming_webhook_receipts_received
  ON incoming_webhook_receipts (received_at);

CREATE INDEX idx_incoming_webhook_unmatched_account_status
  ON incoming_webhook_unmatched_events (line_account_id, status, received_at);

CREATE INDEX idx_incoming_webhooks_folder ON incoming_webhooks(line_account_id, folder_id);

CREATE INDEX idx_incoming_webhooks_line_account ON incoming_webhooks (line_account_id);

CREATE INDEX idx_instagram_connections_instagram_id ON instagram_connections(instagram_id);

CREATE INDEX idx_instagram_messages_account_time_754 ON instagram_messages(line_account_id,received_at,id);

CREATE INDEX idx_integration_api_tokens_account
  ON integration_api_tokens (line_account_id, revoked_at);

CREATE INDEX idx_line_account_connection_checks_correlation
  ON line_account_connection_checks(correlation_id);

CREATE INDEX idx_line_account_connection_checks_latest
  ON line_account_connection_checks(line_account_id, checked_at DESC);

CREATE INDEX idx_line_account_hq_admin_memberships_staff
  ON line_account_hq_admin_memberships(staff_id);

CREATE INDEX idx_line_account_tag_links_tag ON line_account_tag_links(tag_id, line_account_id);

CREATE INDEX idx_line_account_tags_order ON line_account_tags(tenant_id,display_order,name);

CREATE INDEX idx_line_accounts_archived
  ON line_accounts (archived_at, display_order, created_at);

CREATE INDEX idx_line_accounts_creator ON line_accounts(created_by_staff_id);

CREATE INDEX idx_line_accounts_display_order
  ON line_accounts (display_order, created_at);

CREATE INDEX idx_line_accounts_folder ON line_accounts(folder_id);

CREATE UNIQUE INDEX idx_line_accounts_liff_id_unique
  ON line_accounts(liff_id);

CREATE UNIQUE INDEX idx_line_accounts_login_channel_id_unique
  ON line_accounts(login_channel_id);

CREATE UNIQUE INDEX idx_line_accounts_one_default_per_tenant
  ON line_accounts (COALESCE(tenant_id, '00000000-0000-4000-8000-000000000001'))
  WHERE is_default = 1;

CREATE INDEX idx_line_accounts_parent
  ON line_accounts(parent_line_account_id);

CREATE INDEX idx_line_accounts_tenant
  ON line_accounts(tenant_id);

CREATE INDEX idx_line_senders_account ON line_senders(account_id,status);

CREATE INDEX idx_line_webhook_events_account
  ON line_webhook_events(line_account_id, received_at DESC);

CREATE INDEX idx_line_webhook_events_status
  ON line_webhook_events(status, received_at);

CREATE INDEX idx_link_clicks_friend ON link_clicks (friend_id);

CREATE INDEX idx_link_clicks_link ON link_clicks (tracked_link_id);

CREATE INDEX idx_login_audit_user ON login_audit(admin_user_id, created_at);

CREATE INDEX idx_manual_link_check_history_v316_key_time
  ON manual_link_check_history(link_key, checked_at DESC);

CREATE INDEX idx_manual_links_status ON manual_links (status);

CREATE INDEX idx_measurement_sites_account ON measurement_sites(line_account_id);

CREATE INDEX idx_media_account_archived_v424
  ON media(line_account_id, archived_at);

CREATE INDEX idx_media_account_created
  ON media(line_account_id, created_at DESC, id);

CREATE INDEX idx_media_file_scans_account_status
  ON media_file_scans(line_account_id, status, updated_at DESC);

CREATE INDEX idx_media_file_scans_media
  ON media_file_scans(media_id, status) WHERE media_id IS NOT NULL;

CREATE INDEX idx_media_file_scans_retry
  ON media_file_scans(status, next_retry_at) WHERE status = 'pending';

CREATE INDEX idx_media_file_scans_subject
  ON media_file_scans(subject_kind, subject_id);

CREATE INDEX idx_media_kind ON media(kind, created_at DESC);

CREATE INDEX idx_media_upload_sessions_account_status
  ON media_upload_sessions(line_account_id, status, expires_at);

CREATE INDEX idx_media_upload_sessions_target
  ON media_upload_sessions(target_media_id, status, created_at DESC);

CREATE INDEX idx_media_usages_media_scanned ON media_usages(media_id,scanned_at);

CREATE INDEX idx_media_versions_media_created
  ON media_versions(media_id, version_no DESC, created_at DESC);

CREATE INDEX idx_meet_callback_receipts_received
  ON meet_callback_receipts(received_at);

CREATE INDEX idx_meet_consultation_reminders_due
  ON meet_consultation_reminders (status, scheduled_at);

CREATE INDEX idx_meet_consultations_friend ON meet_consultations (friend_id);

CREATE INDEX idx_meet_consultations_start ON meet_consultations (status, starts_at);

CREATE INDEX idx_meet_notification_runs_due ON meet_consultation_notification_runs(status,scheduled_at);

CREATE INDEX idx_menu_versions_menu
  ON menu_versions (menu_id, version_number DESC);

CREATE INDEX idx_menus_account_sort ON menus (line_account_id, sort_order);

CREATE INDEX idx_message_correction_of ON messages_log(correction_of_message_id) WHERE correction_of_message_id IS NOT NULL;

CREATE INDEX idx_messages_account_direction_created ON messages_log(line_account_id, direction, created_at);

CREATE INDEX idx_messages_conversation_position ON messages_log(friend_id,COALESCE(line_event_at,created_at),id) WHERE delivery_type IS NULL OR delivery_type!='test';

CREATE INDEX idx_messages_log_broadcast_friend_direction
  ON messages_log (broadcast_id, friend_id, direction);

CREATE INDEX idx_messages_log_broadcast_id ON messages_log(broadcast_id);

CREATE INDEX idx_messages_log_created_at ON messages_log (created_at);

CREATE INDEX idx_messages_log_friend_direction_created ON messages_log (friend_id, direction, created_at);

CREATE INDEX idx_messages_log_friend_direction_source_created
  ON messages_log (friend_id, direction, source, created_at DESC);

CREATE INDEX idx_messages_log_friend_id ON messages_log (friend_id);

CREATE INDEX idx_messages_log_friend_source ON messages_log (friend_id, source);

CREATE INDEX idx_messages_log_line_event_at ON messages_log (line_event_at);

CREATE UNIQUE INDEX idx_messages_log_line_message_scope
  ON messages_log (line_message_account_key, line_message_id)
  WHERE line_message_id IS NOT NULL AND line_message_account_key IS NOT NULL;

CREATE INDEX idx_messages_log_origin
  ON messages_log (origin_kind, created_at);

CREATE INDEX idx_messages_log_quoted
  ON messages_log (quoted_message_id);

CREATE INDEX idx_messages_log_version_step
  ON messages_log (friend_id, scenario_version_step_id)
  WHERE scenario_version_step_id IS NOT NULL;

CREATE INDEX idx_messages_search_pending ON messages_log(friend_id,id) WHERE search_content IS NULL AND unsent_at IS NULL AND (delivery_type IS NULL OR delivery_type!='test');

CREATE INDEX idx_mileage_adj_approval_account
  ON mileage_adjustment_approval_requests (line_account_id, status, created_at DESC);

CREATE INDEX idx_mileage_adj_approval_events_request
  ON mileage_adjustment_approval_events (request_id, created_at DESC);

CREATE INDEX idx_mileage_adj_approval_friend
  ON mileage_adjustment_approval_requests (friend_id, created_at DESC);

CREATE INDEX idx_mileage_adjustment_notifications_retry
  ON mileage_adjustment_notifications(status, updated_at)
  WHERE status = 'failed';

CREATE INDEX idx_mileage_earning_rule_drafts_account
  ON mileage_earning_rule_drafts(line_account_id, updated_at DESC);

CREATE INDEX idx_mileage_earning_rule_published_versions_rule
  ON mileage_earning_rule_published_versions(rule_id, version_number);

CREATE INDEX idx_mileage_event_queue_due
  ON mileage_event_queue(status, available_at, created_at);

CREATE INDEX idx_mileage_grant_lots_spend_order
  ON mileage_grant_lots(program_id, beneficiary_key, status, expires_at, available_at);

CREATE INDEX idx_mileage_ledger_friend
  ON mileage_ledger(program_id, beneficiary_friend_id, status, occurred_at DESC);

CREATE UNIQUE INDEX idx_mileage_ledger_one_reversal
  ON mileage_ledger(reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;

CREATE INDEX idx_mileage_ledger_rule
  ON mileage_ledger(program_id, mileage_rule_id, occurred_at DESC);

CREATE INDEX idx_mileage_ledger_source
  ON mileage_ledger(program_id, source, source_event_id);

CREATE INDEX idx_mileage_ledger_user
  ON mileage_ledger(program_id, beneficiary_user_id, status, occurred_at DESC);

CREATE INDEX idx_mileage_redemptions_friend_created
  ON mileage_redemptions(beneficiary_friend_id, created_at DESC);

CREATE INDEX idx_mileage_redemptions_retry
  ON mileage_redemptions(status, next_retry_at)
  WHERE status = 'delivery_failed';

CREATE INDEX idx_mileage_redemptions_reward_created
  ON mileage_redemptions(reward_id, created_at DESC);

CREATE INDEX idx_mileage_reward_codes_available
  ON mileage_reward_codes(reward_version_id, status, created_at);

CREATE INDEX idx_mileage_reward_folders_account ON mileage_reward_folders(line_account_id, display_order);

CREATE INDEX idx_mileage_reward_versions_reward_status
  ON mileage_reward_versions(reward_id, status, version_number DESC);

CREATE INDEX idx_mileage_rewards_account_status
  ON mileage_rewards(line_account_id, status, sort_order, updated_at DESC);

CREATE INDEX idx_mileage_rewards_folder ON mileage_rewards(line_account_id, folder_id);

CREATE INDEX idx_mileage_rules_account ON mileage_rules(line_account_id);

CREATE INDEX idx_mileage_rules_match
  ON mileage_rules(program_id, event_type, source, is_active);

CREATE INDEX idx_mileage_spend_allocations_grant
  ON mileage_spend_allocations(grant_lot_id);

CREATE INDEX idx_mileage_step_deliveries_reconcile
  ON mileage_redemption_step_deliveries (needs_reconcile, lease_expires_at);

CREATE UNIQUE INDEX idx_musubo_billing_core_subscription
  ON musubo_tenant_billing(core_subscription_id) WHERE core_subscription_id IS NOT NULL;

CREATE UNIQUE INDEX idx_musubo_billing_options_subscription
  ON musubo_tenant_billing(options_subscription_id) WHERE options_subscription_id IS NOT NULL;

CREATE UNIQUE INDEX idx_musubo_conditions_active_version
  ON musubo_pricing_conditions(condition_key) WHERE status = 'active';

CREATE INDEX idx_musubo_conditions_code
  ON musubo_pricing_conditions(code_digest, status, valid_until)
  WHERE code_digest IS NOT NULL;

CREATE INDEX idx_musubo_conditions_company
  ON musubo_pricing_conditions(company_name_key, status, valid_until)
  WHERE company_name_key IS NOT NULL;

CREATE INDEX idx_musubo_final_line_notices_pending
  ON musubo_final_line_notices(delivered_at, created_at);

CREATE INDEX idx_musubo_line_usage_tenant
  ON musubo_line_usage(tenant_id, status);

CREATE UNIQUE INDEX idx_musubo_pending_additions_invoice
  ON musubo_pending_additions(stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

CREATE UNIQUE INDEX idx_musubo_pending_additions_one_in_flight
  ON musubo_pending_additions(tenant_id)
  WHERE status IN ('awaiting_payment', 'paid');

CREATE INDEX idx_musubo_pending_additions_tenant
  ON musubo_pending_additions(tenant_id, status, expires_at);

CREATE INDEX idx_musubo_quotes_application
  ON musubo_individual_quotes(application_id, revision DESC);

CREATE INDEX idx_musubo_quotes_tenant
  ON musubo_individual_quotes(tenant_id, status);

CREATE INDEX idx_nen_care_flags_friend_status
  ON nen_care_flags(friend_id, status);

CREATE INDEX idx_nen_care_flags_status ON nen_care_flags(status, detected_at DESC);

CREATE INDEX idx_nen_column_read_events_column
  ON nen_column_read_events(line_account_id, column_id, event_kind, occurred_at DESC);

CREATE INDEX idx_nen_column_read_events_friend
  ON nen_column_read_events(friend_id, occurred_at DESC);

CREATE INDEX idx_nen_columns_target_tag
  ON nen_columns(line_account_id, target_tag_id, delivery_status);

CREATE INDEX idx_nen_consultations_friend ON nen_consultation_logs(friend_id, created_at DESC);

CREATE INDEX idx_nen_consultations_v2_friend ON nen_consultation_logs_v2(friend_id, created_at DESC);

CREATE INDEX idx_nen_consultations_v2_safety ON nen_consultation_logs_v2(safety_level, created_at DESC);

CREATE INDEX idx_nen_delivery_jobs_account_schedule
  ON nen_delivery_jobs(line_account_id, scheduled_at DESC, id DESC);

CREATE INDEX idx_nen_delivery_jobs_due
  ON nen_delivery_jobs(status, scheduled_at);

CREATE INDEX idx_nen_delivery_jobs_friend
  ON nen_delivery_jobs(friend_id, created_at DESC);

CREATE INDEX idx_nen_delivery_retry_due ON nen_delivery_jobs(status, next_attempt_at);

CREATE INDEX idx_nen_feeding_products_account
  ON nen_feeding_products(line_account_id, sort_order);

CREATE INDEX idx_nen_friend_coupon_status
  ON nen_friend_add_coupon_issues(line_account_id, status, updated_at);

CREATE INDEX idx_nen_health_logs_friend_date
  ON nen_health_logs(friend_id, logged_on DESC);

CREATE INDEX idx_nen_health_logs_pet_date ON nen_health_logs(pet_id, logged_on DESC);

CREATE INDEX idx_nen_knowledge_animal ON nen_knowledge_articles(animal_type, is_active);

CREATE INDEX idx_nen_knowledge_authority
  ON nen_knowledge_articles(is_active, animal_type, authority_rank DESC);

CREATE INDEX idx_nen_lifetime_milestones_account
  ON nen_lifetime_milestones(line_account_id, threshold_yen);

CREATE INDEX idx_nen_member_rank ON nen_ec_member_snapshots(member_rank, purchase_amount DESC);

CREATE INDEX idx_nen_member_rank_sync_operation
  ON nen_member_rank_sync(line_account_id, operation_id, status);

CREATE INDEX idx_nen_pet_profiles_birthday
  ON nen_pet_profiles(substr(birthday, 6, 2), friend_id);

CREATE INDEX idx_nen_pet_profiles_customer
  ON nen_pet_profiles(customer_id);

CREATE INDEX idx_nen_pet_profiles_friend
  ON nen_pet_profiles(friend_id);

CREATE INDEX idx_nen_photo_assessment_runs_photo_created
  ON nen_photo_assessment_runs(photo_id, created_at DESC);

CREATE INDEX idx_nen_photo_asset_jobs_photo_created
  ON nen_photo_asset_jobs(photo_id, created_at DESC);

CREATE INDEX idx_nen_photo_derivatives_photo_kind
  ON nen_photo_derivatives(photo_id, kind, source_version DESC);

CREATE INDEX idx_nen_photo_original_download_audit_photo
  ON nen_photo_original_download_audit(photo_id, created_at DESC);

CREATE INDEX idx_nen_photo_original_download_grants_expiry
  ON nen_photo_original_download_grants(line_account_id, requested_by, expires_at);

CREATE INDEX idx_nen_photo_placements_account_active
  ON nen_photo_publication_placements(line_account_id, active, created_at DESC);

CREATE INDEX idx_nen_photo_publications_account_status
  ON nen_photo_publications(line_account_id, status, published_at DESC);

CREATE UNIQUE INDEX idx_nen_photo_publications_idempotency
  ON nen_photo_publications(line_account_id, last_idempotency_key)
  WHERE last_idempotency_key IS NOT NULL;

CREATE INDEX idx_nen_photo_review_events_v352_account_created
  ON nen_photo_review_events(line_account_id, created_at DESC);

CREATE INDEX idx_nen_photo_review_events_v352_notification
  ON nen_photo_review_events(notification_status, created_at)
  WHERE notification_status IN ('pending', 'sending', 'failed');

CREATE INDEX idx_nen_photo_review_events_v428_idempotency
  ON nen_photo_review_events(line_account_id, photo_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_nen_photo_reward_outbox_pending
  ON nen_photo_reward_outbox(status, next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX idx_nen_photo_risks_photo_created
  ON nen_photo_risk_assessments(photo_id, created_at DESC);

CREATE INDEX idx_nen_photo_submissions_friend_status
  ON nen_photo_submissions(friend_id, status);

CREATE INDEX idx_nen_photos_account_status
  ON nen_photo_submissions(line_account_id, status, created_at DESC);

CREATE INDEX idx_nen_photos_publication
  ON nen_photo_submissions(line_account_id, publication_consent_at, reviewed_at DESC)
  WHERE status = 'adopted' AND publication_withdrawn_at IS NULL;

CREATE INDEX idx_nen_photos_status ON nen_photo_submissions(status, created_at DESC);

CREATE INDEX idx_nen_point_ledger_friend_created
  ON nen_point_ledger(friend_id, created_at DESC);

CREATE INDEX idx_nen_rank_settings_account
  ON nen_rank_settings(line_account_id, sort_order);

CREATE INDEX idx_nen_rich_menu_jobs_status
  ON nen_rich_menu_jobs(status, created_at);

CREATE INDEX idx_notification_deliveries_account_status
  ON notification_deliveries(line_account_id, status, queued_at DESC, id DESC);

CREATE INDEX idx_notification_deliveries_origin
  ON notification_deliveries(line_account_id, status, source, failed_at DESC);

CREATE INDEX idx_notification_deliveries_retry
  ON notification_deliveries(status, retryable, next_retry_at);

CREATE INDEX idx_notification_interactions_delivery
  ON notification_interactions(delivery_id, clicked_at DESC);

CREATE INDEX idx_notification_metrics_account_date
  ON notification_aggregate_metrics(line_account_id, metric_date DESC, definition_id);

CREATE INDEX idx_notification_rules_account ON notification_rules(line_account_id, event_type, is_active);

CREATE INDEX idx_notifications_center ON notifications(line_account_id, category, created_at DESC);

CREATE INDEX idx_notifications_created ON notifications (created_at);

CREATE INDEX idx_notifications_status ON notifications (status);

CREATE INDEX idx_operation_alert_events_alert_created
  ON operation_alert_events(alert_id, created_at DESC);

CREATE INDEX idx_operation_alert_notification_due
  ON operation_alert_notification_outbox(status, next_attempt_at);

CREATE INDEX idx_operation_alerts_account_status_v496
  ON operation_alerts(line_account_id, status, updated_at DESC);

CREATE INDEX idx_operation_audit_kind_date
  ON operation_audit (target_kind, created_at);

CREATE INDEX idx_operation_deployment_events_occurred
  ON operation_deployment_events(occurred_at DESC, id DESC);

CREATE INDEX idx_operation_health_results_run_v496
  ON operation_health_results(run_id, check_key);

CREATE INDEX idx_operation_health_runs_scope_started
  ON operation_health_runs(scope_key, started_at DESC, id DESC);

CREATE INDEX idx_operation_incidents_scope_created
  ON operation_incidents(scope_key, created_at DESC, id DESC);

CREATE INDEX idx_operation_incidents_status_created
  ON operation_incidents(status, created_at DESC, id DESC);

CREATE INDEX idx_operation_notification_outbox_due
  ON operation_notification_outbox(status, next_attempt_at);

CREATE UNIQUE INDEX idx_operator_notification_instance_source
  ON notification_instances(
    line_account_id,
    definition_id,
    source_event_type,
    source_event_id
  )
  WHERE audience_type = 'operator';

CREATE INDEX idx_operator_notification_teams_account ON operator_notification_teams(line_account_id, archived_at);

CREATE INDEX idx_outbound_send_requests_account_failure
  ON outbound_send_requests(line_account_id, status, next_retry_at, updated_at DESC);

CREATE INDEX idx_outbound_send_requests_active_lease
  ON outbound_send_requests(status, lease_expires_at)
  WHERE status = 'in_progress';

CREATE INDEX idx_outbound_send_requests_created
  ON outbound_send_requests(created_at);

CREATE INDEX idx_outgoing_webhook_deliveries_due
  ON outgoing_webhook_deliveries(status, next_retry_at);

CREATE INDEX idx_outgoing_webhook_deliveries_webhook
  ON outgoing_webhook_deliveries(webhook_id, queued_at DESC);

CREATE INDEX idx_outgoing_webhooks_folder ON outgoing_webhooks(line_account_id, folder_id);

CREATE INDEX idx_outgoing_webhooks_line_account
  ON outgoing_webhooks(line_account_id, is_active, updated_at DESC);

CREATE INDEX idx_photo_daily_views_account_date
  ON nen_photo_publication_daily_views(line_account_id, view_date);

CREATE INDEX idx_photo_public_r2_key ON nen_photo_submissions(public_r2_key);

CREATE INDEX idx_photo_publication_reward_due ON nen_photo_publication_reward_outbox(status,next_attempt_at);

CREATE INDEX idx_photo_review_r2_key ON nen_photo_submissions(review_r2_key);

CREATE INDEX idx_photo_reward_policies_version
  ON photo_reward_policies (version_number DESC);

CREATE INDEX idx_photo_submissions_content_hash
  ON nen_photo_submissions (line_account_id, content_hash);

CREATE INDEX idx_pii_reveal_logs_tenant
  ON pii_reveal_logs(tenant_id, created_at DESC);

CREATE INDEX idx_platform_admin_invites_staff ON platform_admin_invites(staff_id, created_at DESC);

CREATE INDEX idx_platform_ai_calls_month ON platform_ai_calls(created_at, purpose);

CREATE INDEX idx_platform_announcement_recipients_staff
  ON platform_announcement_recipients(staff_id, screen_read_at);

CREATE INDEX idx_platform_announcements_status
  ON platform_announcements(status, publish_at);

CREATE INDEX idx_platform_audit_logs_action
  ON platform_audit_logs(action, created_at DESC);

CREATE INDEX idx_platform_audit_logs_created
  ON platform_audit_logs(created_at DESC);

CREATE INDEX idx_platform_audit_logs_security_utc ON platform_audit_logs (security_created_at_jd);

CREATE INDEX idx_platform_audit_logs_tenant
  ON platform_audit_logs(tenant_id, created_at DESC);

CREATE INDEX idx_platform_knowledge_articles_kind_review
  ON platform_knowledge_articles(article_kind, review_state, status, kind);

CREATE INDEX idx_platform_knowledge_articles_review ON platform_knowledge_articles(review_state, status, kind);

CREATE INDEX idx_platform_knowledge_jobs_pending ON platform_knowledge_jobs(status, lease_until);

CREATE INDEX idx_postal_codes_code
  ON postal_codes(postal_code);

CREATE INDEX idx_public_ingress_receipts_received ON public_ingress_receipts(received_at);

CREATE INDEX idx_recipe_clone_items_v316_run
  ON recipe_clone_items(run_id, created_at, id);

CREATE INDEX idx_recipe_clone_runs_v316_account
  ON recipe_clone_runs(line_account_id, created_at DESC);

CREATE INDEX idx_recipe_clone_runs_v316_recipe
  ON recipe_clone_runs(recipe_id, created_at DESC);

CREATE INDEX idx_recipes_v464_account ON recipes(line_account_id);

CREATE INDEX idx_ref_tracking_ad_click_scope
  ON ref_tracking(friend_id, line_account_id, created_at DESC);

CREATE INDEX idx_ref_tracking_friend ON ref_tracking (friend_id);

CREATE INDEX idx_ref_tracking_friend_created ON ref_tracking(friend_id, created_at);

CREATE INDEX idx_ref_tracking_ref    ON ref_tracking (ref_code);

CREATE INDEX idx_ref_tracking_ref_created ON ref_tracking(ref_code, created_at);

CREATE UNIQUE INDEX idx_registration_applications_active_email
  ON registration_applications(lower(email)) WHERE status <> 'rejected';

CREATE INDEX idx_registration_applications_pricing_condition
  ON registration_applications(pricing_condition_id);

CREATE INDEX idx_registration_applications_status_created
  ON registration_applications(status, created_at DESC);

CREATE INDEX idx_reminder_delivery_runs_due
  ON reminder_delivery_runs (status, next_retry_at, lease_expires_at, scheduled_at);

CREATE INDEX idx_reminder_delivery_runs_friend
  ON reminder_delivery_runs (friend_id, scheduled_at DESC);

CREATE UNIQUE INDEX idx_reminder_delivery_runs_message_log
  ON reminder_delivery_runs (message_log_id)
  WHERE message_log_id IS NOT NULL;

CREATE INDEX idx_reminder_delivery_runs_reminder
  ON reminder_delivery_runs (line_account_id, reminder_id, scheduled_at DESC);

CREATE INDEX idx_reminder_steps_by_reminder ON reminder_steps (reminder_id);

CREATE INDEX idx_reminder_version_steps_order
  ON reminder_version_steps (reminder_version_id, position, stable_step_id);

CREATE UNIQUE INDEX idx_reminder_versions_one_draft
  ON reminder_versions (reminder_id) WHERE status = 'draft';

CREATE UNIQUE INDEX idx_reminder_versions_one_published
  ON reminder_versions (reminder_id) WHERE status = 'published';

CREATE INDEX idx_reminder_versions_status
  ON reminder_versions (reminder_id, status, version_number DESC);

CREATE INDEX idx_reminders_display_order ON reminders(display_order, created_at);

CREATE INDEX idx_reminders_folder ON reminders(folder_id);

CREATE INDEX idx_reminders_trigger_event ON reminders (trigger_event_id);

CREATE INDEX idx_reminders_visible_order
  ON reminders (line_account_id, display_order, created_at)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_rich_menu_area_taps_area  ON rich_menu_area_taps(area_id, tapped_at);

CREATE INDEX idx_rich_menu_area_taps_group ON rich_menu_area_taps(group_id, tapped_at);

CREATE INDEX idx_rich_menu_areas_page     ON rich_menu_areas(page_id);

CREATE INDEX idx_rich_menu_assignment_runs_monthly
  ON rich_menu_assignment_runs (line_account_id, group_id, status, completed_at, friend_id);

CREATE INDEX idx_rich_menu_assignments_group
  ON rich_menu_assignments (line_account_id, group_id);

CREATE INDEX idx_rich_menu_device_confirmations_group
  ON rich_menu_device_confirmations(group_id, confirmed_at DESC);

CREATE UNIQUE INDEX idx_rich_menu_device_confirmations_group_fp_staff
  ON rich_menu_device_confirmations(group_id, definition_fingerprint, staff_id);

CREATE INDEX idx_rich_menu_duplicate_requests_source
  ON rich_menu_duplicate_requests(source_group_id);

CREATE INDEX idx_rich_menu_groups_account ON rich_menu_groups(account_id, status);

CREATE INDEX idx_rich_menu_manual_publish_requests_group
  ON rich_menu_manual_publish_requests (group_id, created_at DESC);

CREATE INDEX idx_rich_menu_pages_group    ON rich_menu_pages(group_id, order_index);

CREATE INDEX idx_rich_menu_publish_run_pages_run
  ON rich_menu_publish_run_pages(run_id, order_index);

CREATE UNIQUE INDEX idx_rich_menu_publish_run_pages_run_page
  ON rich_menu_publish_run_pages(run_id, page_id);

CREATE INDEX idx_rich_menu_publish_runs_group
  ON rich_menu_publish_runs(group_id, started_at DESC);

CREATE UNIQUE INDEX idx_rich_menu_publish_runs_idem
  ON rich_menu_publish_runs(group_id, idempotency_key);

CREATE INDEX idx_rich_menu_schedules_due
  ON rich_menu_schedules (status, starts_at, ends_at);

CREATE INDEX idx_rich_menu_schedules_group
  ON rich_menu_schedules (group_id, created_at DESC);

CREATE INDEX idx_rich_menu_schedules_lease
  ON rich_menu_schedules (status, lease_expires_at);

CREATE INDEX idx_rich_menu_schedules_retry
  ON rich_menu_schedules (status, next_retry_at);

CREATE INDEX idx_rich_menu_test_applies_group
  ON rich_menu_test_applies(group_id, staff_id, status);

CREATE UNIQUE INDEX idx_rich_menu_versions_group_number
  ON rich_menu_versions(group_id, version_number);

CREATE INDEX idx_rich_menu_versions_group_status
  ON rich_menu_versions(group_id, status);

CREATE INDEX idx_rt_approvals_queue ON rt_approval_requests(organization_id, status, created_at DESC);

CREATE UNIQUE INDEX idx_rt_customer_request ON rt_reservations(store_id,line_uid,customer_request_id) WHERE customer_request_id IS NOT NULL;

CREATE INDEX idx_rt_email_digests_store_date
  ON rt_email_digests (store_id, target_date, media_id);

CREATE INDEX idx_rt_floors_active_store ON rt_floors(store_id,archived_at,sort_order);

CREATE INDEX idx_rt_followup_targets_approval ON rt_store_followup_targets(approval_id);

CREATE INDEX idx_rt_gbp_reviews_store ON rt_gbp_reviews(store_id, reply_status, reviewed_at DESC);

CREATE INDEX idx_rt_google_changes_status ON rt_google_changes(store_id, status);

CREATE INDEX idx_rt_google_changes_store ON rt_google_changes(store_id, created_at DESC);

CREATE INDEX idx_rt_google_metrics_daily_store_date
  ON rt_google_metrics_daily(store_id, date DESC);

CREATE INDEX idx_rt_google_oauth_states_expires ON rt_google_oauth_states(expires_at);

CREATE INDEX idx_rt_google_posts_fingerprint
  ON rt_google_posts(store_id, content_fingerprint) WHERE content_fingerprint IS NOT NULL;

CREATE UNIQUE INDEX idx_rt_google_posts_google_name
  ON rt_google_posts(store_id, google_post_name) WHERE google_post_name IS NOT NULL;

CREATE INDEX idx_rt_google_posts_status ON rt_google_posts(store_id, status);

CREATE INDEX idx_rt_google_posts_store ON rt_google_posts(store_id, created_at DESC);

CREATE INDEX idx_rt_google_reviews_store
  ON rt_google_reviews(store_id, reply_status, create_time DESC);

CREATE INDEX idx_rt_google_write_log_store ON rt_google_write_log(store_id, created_at DESC);

CREATE INDEX idx_rt_inbound_emails_retention
  ON rt_inbound_emails (received_at, status);

CREATE INDEX idx_rt_inbound_emails_store
  ON rt_inbound_emails (store_id, received_at DESC);

CREATE INDEX idx_rt_intake_addresses_store
  ON rt_intake_addresses (store_id, status);

CREATE INDEX idx_rt_inventory_store_time ON rt_inventory_slots(store_id, starts_at);

CREATE UNIQUE INDEX idx_rt_manual_email_import ON rt_reservations(inbound_email_id) WHERE parser_key = 'manual_import';

CREATE UNIQUE INDEX idx_rt_membership_login ON rt_memberships(organization_id,staff_id) WHERE staff_id IS NOT NULL;

CREATE INDEX idx_rt_memberships_org ON rt_memberships(organization_id, store_id, role);

CREATE UNIQUE INDEX idx_rt_menu_change_pending ON rt_menu_change_requests(menu_id) WHERE status IN ('pending', 'approved');

CREATE INDEX idx_rt_menu_store ON rt_menu_items(store_id, status, kind);

CREATE INDEX idx_rt_org_agreements_org
  ON rt_organization_agreements(organization_id, document_key);

CREATE UNIQUE INDEX idx_rt_organizations_account ON rt_organizations(account_id);

CREATE INDEX idx_rt_organizations_tenant
  ON rt_organizations(tenant_id);

CREATE UNIQUE INDEX idx_rt_organizations_tenant_unique
  ON rt_organizations(tenant_id);

CREATE INDEX idx_rt_reservation_hold_expiry ON rt_reservations(hold_expires_at) WHERE status = 'pending' AND hold_expires_at IS NOT NULL;

CREATE UNIQUE INDEX idx_rt_reservations_external
  ON rt_reservations(store_id, source, external_id);

CREATE INDEX idx_rt_reservations_timeline ON rt_reservations(store_id, starts_at, status);

CREATE INDEX idx_rt_seat_visit_marks_reservation
  ON rt_seat_visit_marks(reservation_id, marked_at DESC);

CREATE INDEX idx_rt_seat_visit_marks_store
  ON rt_seat_visit_marks(store_id, marked_at DESC);

CREATE INDEX idx_rt_seat_waitlist_slot_created
  ON rt_seat_waitlist(store_id, starts_at, status, created_at);

CREATE UNIQUE INDEX idx_rt_seat_waitlist_slot_identity
  ON rt_seat_waitlist(store_id, starts_at, identity_key)
  WHERE status IN ('waiting', 'invited');

CREATE UNIQUE INDEX idx_rt_stores_line_account
  ON rt_stores (line_account_id) WHERE line_account_id IS NOT NULL;

CREATE INDEX idx_rt_stores_org ON rt_stores(organization_id, status);

CREATE INDEX idx_rt_sync_events_recent ON rt_sync_events(store_id, received_at DESC);

CREATE INDEX idx_rt_tables_store ON rt_tables(store_id, is_active);

CREATE UNIQUE INDEX idx_rt_waitlist_conversion ON rt_reservations(waitlist_entry_id) WHERE waitlist_entry_id IS NOT NULL;

CREATE INDEX idx_saved_search_references_account
  ON saved_search_references(line_account_id, saved_search_id, reference_kind);

CREATE INDEX idx_saved_search_usage_month
  ON saved_search_usage_events(line_account_id, saved_search_id, used_at);

CREATE INDEX idx_saved_search_usage_reference
  ON saved_search_usage_events(
    line_account_id, saved_search_id, reference_kind, reference_id, used_at
  );

CREATE INDEX idx_saved_searches_account_format
  ON saved_searches(line_account_id, scope, condition_format, created_by, display_order);

CREATE INDEX idx_saved_searches_account_scope
  ON saved_searches(line_account_id, scope, created_by, display_order);

CREATE UNIQUE INDEX idx_saved_searches_id_account
  ON saved_searches(id, line_account_id);

CREATE INDEX idx_saved_searches_scope ON saved_searches(scope, display_order);

CREATE INDEX idx_scenario_actions_lookup
  ON scenario_actions (scenario_id, hook, step_id, choice_index, sort_order);

CREATE INDEX idx_scenario_drafts_account_updated
  ON scenario_drafts(line_account_id, updated_at DESC, scenario_id);

CREATE INDEX idx_scenario_edit_drafts_expiry ON scenario_edit_drafts(expires_at);

CREATE INDEX idx_scenario_pinned_action_fires_friend
  ON scenario_pinned_action_fires (friend_id);

CREATE INDEX idx_scenario_publish_keys_scenario
  ON scenario_publish_keys (scenario_id);

CREATE INDEX idx_scenario_steps_scenario_lookup ON scenario_steps (scenario_id);

CREATE INDEX idx_scenario_triggers_lookup ON scenario_triggers (kind, tag_id);

CREATE UNIQUE INDEX idx_scenario_triggers_unique
  ON scenario_triggers (scenario_id, kind, COALESCE(tag_id, ''));

CREATE INDEX idx_scenario_versions_scenario
  ON scenario_versions (scenario_id, status, version_number DESC);

CREATE INDEX idx_scenarios_order ON scenarios (display_order);

CREATE INDEX idx_schedule_publications_schedule
  ON rich_menu_schedule_publications (schedule_id, kind);

CREATE INDEX idx_scheduled_chat_sends_due
  ON scheduled_chat_sends (status, scheduled_at);

CREATE INDEX idx_scheduled_chat_sends_friend
  ON scheduled_chat_sends (friend_id, status, scheduled_at);

CREATE INDEX idx_scheduled_chat_sends_lease
  ON scheduled_chat_sends (status, lease_expires_at);

CREATE INDEX idx_security_alerts_pending ON security_alerts(slack_sent_version, version);

CREATE INDEX idx_security_alerts_scope ON security_alerts(tenant_id, line_account_id, status);

CREATE INDEX idx_shifts_staff_date ON staff_shifts (staff_id, work_date);

CREATE INDEX idx_site_events_account_host_path
  ON site_events(line_account_id, host, path, occurred_at);

CREATE INDEX idx_site_events_account_occurred ON site_events(line_account_id, occurred_at);

CREATE INDEX idx_site_events_friend ON site_events(friend_id, occurred_at);

CREATE INDEX idx_site_events_path ON site_events(path, occurred_at);

CREATE INDEX idx_site_visitors_account ON site_visitors(line_account_id);

CREATE INDEX idx_site_visitors_friend ON site_visitors(friend_id);

CREATE INDEX idx_staff_account_scopes_account
  ON staff_account_scopes(line_account_id);

CREATE INDEX idx_staff_account_sort ON staff (line_account_id, sort_order);

CREATE INDEX idx_staff_availability_rules_staff
  ON staff_availability_rules (staff_id, weekday, is_active);

CREATE INDEX idx_staff_break_dates_staff
  ON staff_break_dates (staff_id, work_date);

CREATE INDEX idx_staff_breaks_staff
  ON staff_breaks (staff_id, weekday);

CREATE INDEX idx_staff_line_link_codes_staff
  ON staff_line_link_codes(staff_id, expires_at);

CREATE INDEX idx_staff_member_link ON staff (staff_member_id);

CREATE UNIQUE INDEX idx_staff_members_api_key ON staff_members(api_key);

CREATE INDEX idx_staff_members_assigned_line_account
  ON staff_members(assigned_line_account_id);

CREATE INDEX idx_staff_members_email_lower
  ON staff_members(lower(email));

CREATE INDEX idx_staff_members_invite_token ON staff_members(invite_token_hash);

CREATE UNIQUE INDEX idx_staff_members_line_user_id
  ON staff_members(line_user_id)
  WHERE line_user_id IS NOT NULL;

CREATE UNIQUE INDEX idx_staff_members_password_email
  ON staff_members(lower(email)) WHERE password_hash IS NOT NULL;

CREATE INDEX idx_staff_members_role ON staff_members(role);

CREATE INDEX idx_staff_members_tenant
  ON staff_members(tenant_id);

CREATE UNIQUE INDEX idx_staff_members_tenant_email_unique
  ON staff_members(COALESCE(tenant_id, ''), lower(email)) WHERE email IS NOT NULL;

CREATE INDEX idx_staff_notification_reads_staff
  ON staff_notification_reads(staff_id, read_at DESC);

CREATE INDEX idx_staff_passkey_challenges_expires ON staff_passkey_challenges(expires_at);

CREATE INDEX idx_staff_passkeys_staff ON staff_passkeys(staff_id, created_at);

CREATE INDEX idx_staff_permission_receipts_staff_v527
  ON staff_permission_receipts (staff_id, created_at DESC);

CREATE INDEX idx_starter_catalog_tenant_account ON style_starter_catalog_items(tenant_id,line_account_id);

CREATE UNIQUE INDEX idx_stop_suppressions_dedup
  ON entry_route_stop_suppressions (line_account_id, line_user_id, ref_code);

CREATE INDEX idx_stop_suppressions_lookup
  ON entry_route_stop_suppressions (line_account_id, line_user_id, expires_at);

CREATE INDEX idx_stripe_events_friend ON stripe_events (friend_id);

CREATE INDEX idx_stripe_events_type ON stripe_events (event_type);

CREATE INDEX idx_style_page_views ON booking_page_views(line_account_id,viewed_at);

CREATE INDEX idx_style_starter_account_key ON style_starter_items(line_account_id,item_key);

CREATE UNIQUE INDEX idx_style_starter_tenant_style ON style_starter_sets(COALESCE(tenant_id,''),style) WHERE archived_at IS NULL;

CREATE INDEX idx_support_email_messages_reply_lookup
  ON support_email_messages (message_id);

CREATE INDEX idx_support_email_messages_thread_created
  ON support_email_messages (thread_id, created_at ASC);

CREATE INDEX idx_support_email_threads_customer_subject
  ON support_email_threads (customer_email, normalized_subject, last_message_at DESC);

CREATE INDEX idx_support_email_threads_status_last
  ON support_email_threads (status, last_message_at DESC);

CREATE INDEX idx_support_mark_archive_requests_mark
  ON support_mark_archive_requests(line_account_id, mark_id, created_at DESC);

CREATE INDEX idx_support_mark_create_requests_mark
  ON support_mark_create_requests(line_account_id, mark_id, created_at DESC);

CREATE INDEX idx_support_mark_rule_create_requests_rule
  ON support_mark_rule_create_requests(line_account_id, rule_id, created_at DESC);

CREATE INDEX idx_support_mark_scopes_account
  ON support_mark_scopes(tenant_id, line_account_id);

CREATE INDEX idx_support_marks_active
  ON support_marks(archived_at, display_order, created_at);

CREATE INDEX idx_tag_groups_sort ON tag_groups(sort_order, id);

CREATE INDEX idx_tag_update_requests_tag
  ON tag_update_requests(tag_id, created_at DESC);

CREATE UNIQUE INDEX idx_tags_account_exact_name
  ON tags(line_account_id, name) WHERE line_account_id IS NOT NULL;

CREATE UNIQUE INDEX idx_tags_account_normalized_name
  ON tags(line_account_id, normalized_name)
  WHERE line_account_id IS NOT NULL AND normalized_name IS NOT NULL;

CREATE INDEX idx_tags_account_status_name
  ON tags(line_account_id, status, name, id);

CREATE INDEX idx_tags_group ON tags(group_id, name);

CREATE UNIQUE INDEX idx_tags_legacy_name ON tags(name) WHERE line_account_id IS NULL;

CREATE UNIQUE INDEX idx_tags_legacy_normalized_name
  ON tags(normalized_name)
  WHERE line_account_id IS NULL AND normalized_name IS NOT NULL;

CREATE INDEX idx_tags_line_account
  ON tags(line_account_id, display_order, id);

CREATE INDEX idx_tags_order ON tags (folder_id, display_order);

CREATE INDEX idx_template_references_consumer
  ON template_references (consumer_kind, consumer_id);

CREATE INDEX idx_template_references_template
  ON template_references (template_id);

CREATE INDEX idx_template_versions_template
  ON template_versions (template_id, version_number DESC);

CREATE INDEX idx_templates_category ON templates (category);

CREATE INDEX idx_templates_deleted ON templates(deleted_at);

CREATE INDEX idx_templates_line_account
  ON templates(line_account_id, display_order, id);

CREATE INDEX idx_templates_publish_key ON templates (publish_idempotency_key);

CREATE INDEX idx_tenant_data_purge_audit_tenant
  ON tenant_data_purge_audit (tenant_id, created_at DESC);

CREATE INDEX idx_tenants_retention_pending
  ON tenants (retention_anchor_at)
  WHERE data_purged_at IS NULL;

CREATE INDEX idx_tenants_signup_device_marker
  ON tenants(signup_device_marker) WHERE signup_device_marker IS NOT NULL;

CREATE UNIQUE INDEX idx_tenants_stripe_customer
  ON tenants(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

CREATE INDEX idx_tiktok_pnl_lines_account_date
  ON tiktok_pnl_order_lines(line_account_id, order_date_jst);

CREATE INDEX idx_tiktok_pnl_lines_dirty
  ON tiktok_pnl_order_lines(line_account_id, sheet_dirty);

CREATE UNIQUE INDEX idx_tracked_links_dedup_key
  ON tracked_links (dedup_key) WHERE dedup_key IS NOT NULL;

CREATE UNIQUE INDEX idx_tracked_links_short_code
  ON tracked_links (short_code) WHERE short_code IS NOT NULL;

CREATE INDEX idx_tracked_links_template
  ON tracked_links (template_id);

CREATE INDEX idx_uid_migration_items_old_uid
  ON uid_migration_items(run_id, old_uid);

CREATE INDEX idx_uid_migration_items_run
  ON uid_migration_items(run_id, classification, decision);

CREATE INDEX idx_uid_migration_runs_accounts
  ON uid_migration_runs(from_account_id, to_account_id, created_at DESC);

CREATE INDEX idx_uid_migration_runs_status
  ON uid_migration_runs(status, created_at DESC);

CREATE INDEX idx_update_history_started ON update_history(started_at DESC);

CREATE UNIQUE INDEX idx_user_delivery_priorities_active_friend
  ON user_delivery_priorities(tenant_id, user_id, purpose, friend_id)
  WHERE retired_at IS NULL;

CREATE UNIQUE INDEX idx_user_delivery_priorities_active_order
  ON user_delivery_priorities(tenant_id, user_id, purpose, priority)
  WHERE retired_at IS NULL;

CREATE INDEX idx_user_delivery_priorities_lookup
  ON user_delivery_priorities(tenant_id, user_id, purpose, priority);

CREATE UNIQUE INDEX idx_user_profile_values_active_field
  ON user_profile_values(tenant_id, user_id, field_key) WHERE is_active = 1;

CREATE INDEX idx_user_profile_values_history
  ON user_profile_values(tenant_id, user_id, field_key, selected_at DESC);

CREATE INDEX idx_users_email ON users (email);

CREATE INDEX idx_users_external_id ON users (external_id);

CREATE INDEX idx_users_phone ON users (phone);

CREATE INDEX idx_users_tenant_status
  ON users(tenant_id, status, updated_at DESC);

CREATE INDEX idx_webhook_interactions_account_created_v532
  ON webhook_interaction_logs (line_account_id, created_at DESC);

CREATE INDEX idx_webhook_interactions_account_status_v532
  ON webhook_interaction_logs (line_account_id, status, created_at DESC);

CREATE INDEX idx_webhook_interactions_connection_period_v532
  ON webhook_interaction_logs(line_account_id, webhook_id, created_at DESC, status);

CREATE INDEX idx_webhook_interactions_webhook_v532
  ON webhook_interaction_logs (line_account_id, webhook_id, created_at DESC);

CREATE INDEX idx_webinar_action_executions_status
  ON webinar_action_executions (status, updated_at);

CREATE INDEX idx_webinar_action_executions_webinar
  ON webinar_action_executions (webinar_id, created_at);

CREATE INDEX idx_webinar_actions_webinar
  ON webinar_actions (webinar_id, trigger, position);

CREATE INDEX idx_webinar_comments_webinar
  ON webinar_comments (webinar_id, at_seconds);

CREATE INDEX idx_webinar_ctas_webinar
  ON webinar_ctas (webinar_id, at_seconds);

CREATE INDEX idx_webinar_followups_status
  ON webinar_followups (status, updated_at);

CREATE UNIQUE INDEX idx_webinar_funnel_events_unique
  ON webinar_funnel_events (
    webinar_id, friend_id, session_start_at, event_type, cta_id, form_id, field_name
  );

CREATE INDEX idx_webinar_funnel_events_webinar_created
  ON webinar_funnel_events (webinar_id, created_at);

CREATE INDEX idx_webinar_heartbeat_rejects_webinar
  ON webinar_heartbeat_rejects (webinar_id, received_at);

CREATE INDEX idx_webinar_journey_followups_status
  ON webinar_journey_followups (status, updated_at);

CREATE INDEX idx_webinar_notification_jobs_due
  ON webinar_notification_jobs (status, scheduled_at, next_retry_at);

CREATE INDEX idx_webinar_notification_jobs_webinar
  ON webinar_notification_jobs (webinar_id, created_at);

CREATE INDEX idx_webinar_picker_opens_opened
  ON webinar_picker_opens (webinar_id, opened_at);

CREATE INDEX idx_webinar_regs_active_friend
  ON webinar_registrations (webinar_id, friend_id, status, session_start_at);

CREATE INDEX idx_webinar_regs_due
  ON webinar_registrations (notified_at, session_start_at);

CREATE INDEX idx_webinar_regs_friend
  ON webinar_registrations (webinar_id, friend_id);

CREATE INDEX idx_webinar_sessions_webinar
  ON webinar_sessions (webinar_id, session_start_at);

CREATE INDEX idx_webinar_user_comments_webinar
  ON webinar_user_comments (webinar_id, created_at);

CREATE INDEX idx_webinar_versions_state
  ON webinar_versions (webinar_id, state, version DESC);

CREATE INDEX idx_webinar_video_assets_webinar
  ON webinar_video_assets (webinar_id, stage);

CREATE INDEX idx_webinar_view_segments_coverage
  ON webinar_view_segments (webinar_id, start_seconds, end_seconds);

CREATE INDEX idx_webinar_view_segments_rate
  ON webinar_view_segments (webinar_id, playback_rate);

CREATE INDEX idx_webinar_viewers_webinar
  ON webinar_viewers (webinar_id, session_start_at);

CREATE INDEX idx_webinars_account_status_folder
  ON webinars (account_id, status, folder_id);

CREATE INDEX inbox_assignment_recent ON inbox_assignment_logs(account_id,staff_id,decided_at);

CREATE INDEX makeup_friend_status ON booking_makeup_credits(line_account_id,friend_id,status,expires_at);

CREATE INDEX mcp_call_logs_connection ON mcp_call_logs(connection_id,at,id);

CREATE UNIQUE INDEX member_rank_active_sort ON member_rank_tiers(account_id,sort) WHERE sort>=0;

CREATE INDEX member_rank_history_friend ON member_rank_history(account_id,friend_id,at);

CREATE INDEX member_rank_notices_due ON member_rank_notices(status,scheduled_at);

CREATE UNIQUE INDEX monthly_account_scope ON line_accounts(id,tenant_id);

CREATE UNIQUE INDEX monthly_friend_scope ON friends(id,line_account_id);

CREATE UNIQUE INDEX monthly_plan_scope ON booking_pass_plans(id,line_account_id);

CREATE INDEX rt_closures_store_dates ON rt_closures(store_id,start_date,end_date) WHERE archived_at IS NULL;

CREATE INDEX rt_confirmation_reservation ON rt_reservation_confirmations(reservation_id,reservation_version);

CREATE INDEX rt_delivery_dispatches_due
  ON rt_delivery_dispatches(status, next_attempt_at);

CREATE INDEX rt_delivery_dispatches_target
  ON rt_delivery_dispatches(target_kind, target_id, requested_at);

CREATE INDEX rt_delivery_events_account
  ON rt_delivery_events(account_id, received_at);

CREATE INDEX rt_delivery_events_status
  ON rt_delivery_events(status, received_at);

CREATE INDEX rt_delivery_menu_items_sold_out
  ON rt_delivery_menu_items(store_id, sold_out, sort_order);

CREATE INDEX rt_delivery_menu_items_store
  ON rt_delivery_menu_items(store_id, sort_order);

CREATE INDEX rt_delivery_order_items_order
  ON rt_delivery_order_items(order_id, position);

CREATE INDEX rt_delivery_orders_friend_received
  ON rt_delivery_orders(friend_id, received_at)
  WHERE friend_id IS NOT NULL;

CREATE INDEX rt_delivery_orders_store_received
  ON rt_delivery_orders(store_id, received_at);

CREATE INDEX rt_delivery_orders_store_service_received
  ON rt_delivery_orders(store_id, service, received_at);

CREATE INDEX rt_delivery_orders_store_source_received
  ON rt_delivery_orders(store_id, order_source, received_at);

CREATE INDEX rt_delivery_orders_store_status
  ON rt_delivery_orders(store_id, status, received_at);

CREATE INDEX rt_delivery_service_states_due
  ON rt_delivery_service_states(intake_status, stop_until);

CREATE INDEX rt_delivery_uber_connections_status
  ON rt_delivery_uber_connections(status, access_token_expires_at);

CREATE INDEX rt_delivery_uber_oauth_states_expires
  ON rt_delivery_uber_oauth_states(expires_at);

CREATE UNIQUE INDEX rt_departure_one_active ON rt_reservation_departures(reservation_id) WHERE undone_at IS NULL;

CREATE INDEX rt_event_pending ON rt_reservation_event_receipts(status,next_attempt_at);

CREATE INDEX rt_external_links_reservation ON rt_reservation_external_links(reservation_id, unlinked_at);

CREATE INDEX rt_inventory_outbox_pending ON rt_inventory_notification_outbox(sent_at,lease_until);

CREATE INDEX rt_inventory_rule_source_events_slot ON rt_inventory_rule_source_events(store_id,slot_id,id);

CREATE INDEX rt_reserved_table ON rt_reservation_table_links(table_id,reservation_id);

CREATE INDEX rt_store_feature_flags_feature
  ON rt_store_feature_flags(feature, enabled);

CREATE UNIQUE INDEX rt_visit_request ON rt_seat_visit_marks(reservation_id,request_id) WHERE request_id IS NOT NULL;

CREATE INDEX rt_waiting_table ON rt_seat_waitlist_table_links(table_id,waitlist_id);

CREATE INDEX scenario_source_due ON scenario_source_jobs(status,scheduled_at);

CREATE INDEX scenario_source_reservation ON scenario_source_jobs(source_kind,source_id);

CREATE INDEX template_versions_hq_source ON template_versions(template_id,hq_template_version_id,version_number);

CREATE UNIQUE INDEX uq_google_calendar_connections_active_staff
  ON google_calendar_connections (staff_id)
  WHERE staff_id IS NOT NULL AND is_active = 1;

CREATE UNIQUE INDEX visit_stamp_one_paper ON visit_stamp_paper_requests(card_id,friend_id) WHERE status IN ('pending','approved');

CREATE UNIQUE INDEX visit_stamp_one_visit ON visit_stamp_entries(card_id,friend_id,visit_key) WHERE kind='visit';

CREATE INDEX visit_stamp_qr_account ON visit_stamp_qr_codes(line_account_id);

CREATE UNIQUE INDEX visit_stamp_qr_one_active
  ON visit_stamp_qr_codes(card_id,line_account_id,kind,session_id) WHERE status='active';

CREATE INDEX workflow_steps_due ON workflow_steps(process_kind, status, next_attempt_at, lease_expires_at);

CREATE TRIGGER ab_block_active_edit BEFORE UPDATE OF message_content,message_bubbles_json,message_options_json ON broadcasts WHEN EXISTS(SELECT 1 FROM broadcast_ab_tests WHERE broadcast_id=NEW.id AND status!='draft')
BEGIN SELECT RAISE(ABORT,'ab_test_active'); END;

CREATE TRIGGER ab_block_standard_send BEFORE UPDATE OF status ON broadcasts WHEN NEW.status IN('sending','scheduled') AND EXISTS(SELECT 1 FROM broadcast_ab_tests WHERE broadcast_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'ab_test_requires_test_transport'); END;

CREATE TRIGGER ab_stop_broadcast AFTER UPDATE OF stopped_at ON broadcasts WHEN NEW.stopped_at IS NOT NULL
BEGIN UPDATE broadcast_ab_tests SET status='stopped',version=version+1 WHERE broadcast_id=NEW.id AND status NOT IN('finished','expired','stopped'); END;

CREATE TRIGGER affiliate_offers_folder_insert BEFORE INSERT ON affiliate_offers WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM folders WHERE id=NEW.folder_id AND kind='affiliate_offer' AND account_id=NEW.line_account_id) BEGIN SELECT RAISE(ABORT,'folder_assignment_invalid'); END;

CREATE TRIGGER affiliate_offers_folder_update BEFORE UPDATE OF folder_id,line_account_id ON affiliate_offers WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM folders WHERE id=NEW.folder_id AND kind='affiliate_offer' AND account_id=NEW.line_account_id) BEGIN SELECT RAISE(ABORT,'folder_assignment_invalid'); END;

CREATE TRIGGER affiliate_payout_batch_lines_history_detach AFTER UPDATE OF affiliate_id ON affiliate_payout_batch_lines BEGIN UPDATE affiliate_payout_batch_lines SET affiliate_id_history = COALESCE(NEW.affiliate_id, OLD.affiliate_id, OLD.affiliate_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER affiliate_payout_batch_lines_history_insert AFTER INSERT ON affiliate_payout_batch_lines BEGIN UPDATE affiliate_payout_batch_lines SET affiliate_id_history = COALESCE(NEW.affiliate_id, NEW.affiliate_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER affiliate_payout_results_history_detach AFTER UPDATE OF affiliate_id ON affiliate_payout_results BEGIN UPDATE affiliate_payout_results SET affiliate_id_history = COALESCE(NEW.affiliate_id, OLD.affiliate_id, OLD.affiliate_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER affiliate_payout_results_history_insert AFTER INSERT ON affiliate_payout_results BEGIN UPDATE affiliate_payout_results SET affiliate_id_history = COALESCE(NEW.affiliate_id, NEW.affiliate_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER affiliate_settlement_lines_history_detach AFTER UPDATE OF adjustment_id, entry_id, affiliate_id ON affiliate_settlement_lines BEGIN UPDATE affiliate_settlement_lines SET adjustment_id_history = COALESCE(NEW.adjustment_id, OLD.adjustment_id, OLD.adjustment_id_history), entry_id_history = COALESCE(NEW.entry_id, OLD.entry_id, OLD.entry_id_history), affiliate_id_history = COALESCE(NEW.affiliate_id, OLD.affiliate_id, OLD.affiliate_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER affiliate_settlement_lines_history_insert AFTER INSERT ON affiliate_settlement_lines BEGIN UPDATE affiliate_settlement_lines SET adjustment_id_history = COALESCE(NEW.adjustment_id, NEW.adjustment_id_history), entry_id_history = COALESCE(NEW.entry_id, NEW.entry_id_history), affiliate_id_history = COALESCE(NEW.affiliate_id, NEW.affiliate_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER affiliate_settlements_history_detach AFTER UPDATE OF affiliate_id ON affiliate_settlements BEGIN UPDATE affiliate_settlements SET affiliate_id_history = COALESCE(NEW.affiliate_id, OLD.affiliate_id, OLD.affiliate_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER affiliate_settlements_history_insert AFTER INSERT ON affiliate_settlements BEGIN UPDATE affiliate_settlements SET affiliate_id_history = COALESCE(NEW.affiliate_id, NEW.affiliate_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER affiliate_statements_history_detach AFTER UPDATE OF affiliate_id ON affiliate_statements BEGIN UPDATE affiliate_statements SET affiliate_id_history = COALESCE(NEW.affiliate_id, OLD.affiliate_id, OLD.affiliate_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER affiliate_statements_history_insert AFTER INSERT ON affiliate_statements BEGIN UPDATE affiliate_statements SET affiliate_id_history = COALESCE(NEW.affiliate_id, NEW.affiliate_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER affiliates_folder_insert BEFORE INSERT ON affiliates WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM folders WHERE id=NEW.folder_id AND kind='affiliate' AND account_id=NEW.line_account_id) BEGIN SELECT RAISE(ABORT,'folder_assignment_invalid'); END;

CREATE TRIGGER affiliates_folder_update BEFORE UPDATE OF folder_id,line_account_id ON affiliates WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM folders WHERE id=NEW.folder_id AND kind='affiliate' AND account_id=NEW.line_account_id) BEGIN SELECT RAISE(ABORT,'folder_assignment_invalid'); END;

CREATE TRIGGER analytics_projection_friend_stage_count
AFTER INSERT ON analytics_projection_friend_stage
BEGIN UPDATE analytics_projection_metric_stage SET unique_friend_count = unique_friend_count + 1 WHERE line_account_id = NEW.line_account_id AND cycle_id = NEW.cycle_id AND metric_date = NEW.metric_date AND event_type = NEW.event_type; END;

CREATE TRIGGER audit_events_security_time_insert AFTER INSERT ON audit_events
BEGIN UPDATE audit_events SET security_created_at_jd = julianday(CASE WHEN substr(NEW.created_at, 20) NOT GLOB '*[Z+-]*' THEN NEW.created_at || '+09:00' ELSE NEW.created_at END) WHERE rowid = NEW.rowid; END;

CREATE TRIGGER audit_events_security_time_update AFTER UPDATE OF created_at ON audit_events
BEGIN UPDATE audit_events SET security_created_at_jd = julianday(CASE WHEN substr(NEW.created_at, 20) NOT GLOB '*[Z+-]*' THEN NEW.created_at || '+09:00' ELSE NEW.created_at END) WHERE rowid = NEW.rowid; END;

CREATE TRIGGER automation_definitions_folder_delete AFTER DELETE ON folders
BEGIN UPDATE automation_definitions SET folder_id = NULL WHERE folder_id = OLD.id; END;

CREATE TRIGGER automation_definitions_folder_insert BEFORE INSERT ON automation_definitions
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM folders WHERE id = NEW.folder_id AND kind = 'automation' AND account_id = NEW.line_account_id
) BEGIN SELECT RAISE(ABORT, 'folder_assignment_invalid'); END;

CREATE TRIGGER automation_definitions_folder_update BEFORE UPDATE OF folder_id, line_account_id ON automation_definitions
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM folders WHERE id = NEW.folder_id AND kind = 'automation' AND account_id = NEW.line_account_id
) BEGIN SELECT RAISE(ABORT, 'folder_assignment_invalid'); END;

CREATE TRIGGER banner_images_folder_insert BEFORE INSERT ON banner_images WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hq_banner_folders WHERE id=NEW.folder_id AND tenant_id=NEW.tenant_id AND kind='image' AND archived_at IS NULL) BEGIN SELECT RAISE(ABORT,'folder_assignment_invalid'); END;

CREATE TRIGGER banner_images_folder_update BEFORE UPDATE OF folder_id,tenant_id ON banner_images WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hq_banner_folders WHERE id=NEW.folder_id AND tenant_id=NEW.tenant_id AND kind='image' AND archived_at IS NULL) BEGIN SELECT RAISE(ABORT,'folder_assignment_invalid'); END;

CREATE TRIGGER banner_projects_folder_insert BEFORE INSERT ON banner_projects WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hq_banner_folders WHERE id=NEW.folder_id AND tenant_id=NEW.tenant_id AND kind='project' AND archived_at IS NULL) BEGIN SELECT RAISE(ABORT,'folder_assignment_invalid'); END;

CREATE TRIGGER banner_projects_folder_update BEFORE UPDATE OF folder_id,tenant_id ON banner_projects WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hq_banner_folders WHERE id=NEW.folder_id AND tenant_id=NEW.tenant_id AND kind='project' AND archived_at IS NULL) BEGIN SELECT RAISE(ABORT,'folder_assignment_invalid'); END;

CREATE TRIGGER booking_audit_logs_history_detach AFTER UPDATE OF booking_id ON booking_audit_logs BEGIN UPDATE booking_audit_logs SET booking_id_history = COALESCE(NEW.booking_id, OLD.booking_id, OLD.booking_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER booking_audit_logs_history_insert AFTER INSERT ON booking_audit_logs BEGIN UPDATE booking_audit_logs SET booking_id_history = COALESCE(NEW.booking_id, NEW.booking_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER booking_auto_assign_sync_rules_insert AFTER INSERT ON account_settings WHEN NEW.key='booking_auto_assign' BEGIN UPDATE booking_sync_rules SET auto_assign=CASE WHEN NEW.value='true' THEN 1 ELSE 0 END,version=version+1,updated_at=datetime('now') WHERE line_account_id=NEW.line_account_id AND auto_assign<>CASE WHEN NEW.value='true' THEN 1 ELSE 0 END; END;

CREATE TRIGGER booking_auto_assign_sync_rules_update AFTER UPDATE ON account_settings WHEN NEW.key='booking_auto_assign' BEGIN UPDATE booking_sync_rules SET auto_assign=CASE WHEN NEW.value='true' THEN 1 ELSE 0 END,version=version+1,updated_at=datetime('now') WHERE line_account_id=NEW.line_account_id AND auto_assign<>CASE WHEN NEW.value='true' THEN 1 ELSE 0 END; END;

CREATE TRIGGER booking_cancellation_fee AFTER UPDATE OF status ON bookings
WHEN NEW.status IN('cancelled','no_show') AND OLD.status!=NEW.status AND NEW.policy_snapshot_json IS NOT NULL
 AND json_extract(NEW.policy_snapshot_json,'$.enabled')=1 AND NOT EXISTS(SELECT 1 FROM booking_entitlement_uses WHERE booking_id=NEW.id)
BEGIN INSERT OR IGNORE INTO booking_charges(id,booking_id,line_account_id,kind,amount,policy_snapshot_json,status,created_at,updated_at)
 SELECT lower(hex(randomblob(16))),NEW.id,NEW.line_account_id,CASE WHEN NEW.status='no_show' THEN 'no_show_fee' ELSE 'cancellation_fee' END,
 CAST(NEW.price_at_booking * (CASE WHEN NEW.status='no_show' THEN json_extract(NEW.policy_snapshot_json,'$.noShowPercent')
 ELSE COALESCE((SELECT json_extract(value,'$.percent') FROM json_each(NEW.policy_snapshot_json,'$.tiers')
 WHERE (json_extract(value,'$.beforeHours')=0 OR julianday(NEW.starts_at)>=julianday(COALESCE(NEW.decided_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')))+json_extract(value,'$.beforeHours')/24.0)
 ORDER BY json_extract(value,'$.beforeHours') DESC LIMIT 1),0) END)/100 AS INTEGER),
 NEW.policy_snapshot_json,'pending',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE NEW.price_at_booking>0 AND (NEW.cancellation_reason IS NULL OR NEW.cancellation_reason NOT IN('store','store_cancelled'))
 AND NEW.price_at_booking*(CASE WHEN NEW.status='no_show' THEN json_extract(NEW.policy_snapshot_json,'$.noShowPercent') ELSE COALESCE((SELECT json_extract(value,'$.percent') FROM json_each(NEW.policy_snapshot_json,'$.tiers') WHERE (json_extract(value,'$.beforeHours')=0 OR julianday(NEW.starts_at)>=julianday(COALESCE(NEW.decided_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')))+json_extract(value,'$.beforeHours')/24.0) ORDER BY json_extract(value,'$.beforeHours') DESC LIMIT 1),0) END)>=100
 ON CONFLICT(booking_id,kind) DO UPDATE SET amount=excluded.amount,policy_snapshot_json=excluded.policy_snapshot_json,status='pending',reason=NULL,actor_staff_id=NULL,version=booking_charges.version+1,updated_at=excluded.updated_at
 WHERE booking_charges.status='waived' AND booking_charges.reason='cancellation_reverted'; END;

CREATE TRIGGER booking_cancellation_fee_revert AFTER UPDATE OF status ON bookings WHEN OLD.status IN('cancelled','no_show') AND NEW.status NOT IN('cancelled','no_show')
BEGIN UPDATE booking_charges SET status='waived',reason='cancellation_reverted',version=version+1 WHERE booking_id=NEW.id AND status='pending'; END;

CREATE TRIGGER booking_cancellation_policy_snapshot AFTER INSERT ON bookings
BEGIN UPDATE bookings SET policy_snapshot_json=(SELECT json_object('enabled',json(CASE WHEN enabled=1 THEN 'true' ELSE 'false' END),'tiers',json(tiers_json),'noShowPercent',no_show_percent,'version',version)
 FROM booking_cancellation_policies WHERE line_account_id=NEW.line_account_id) WHERE id=NEW.id AND policy_snapshot_json IS NULL; END;

CREATE TRIGGER booking_entitlement_confirm AFTER UPDATE OF status ON bookings
WHEN NEW.status='confirmed' AND OLD.status<>'confirmed'
BEGIN  UPDATE booking_entitlement_uses SET consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE booking_id=NEW.id AND consumed_at IS NULL; END;

CREATE TRIGGER booking_entitlement_consume AFTER UPDATE OF consumed_at ON booking_entitlement_uses
WHEN OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
BEGIN  UPDATE booking_entitlements SET remaining=CASE WHEN kind='ticket' THEN remaining-1 ELSE NULL END,version=version+1,updated_at=NEW.consumed_at WHERE id=NEW.entitlement_id;  INSERT INTO booking_entitlement_events(id,entitlement_id,line_account_id,action,reason,actor_type,actor_id,request_key,request_json,after_json,created_at) SELECT lower(hex(randomblob(16))),e.id,e.line_account_id,'consume','予約確定による1回利用','system',NEW.booking_id,'consume:'||NEW.booking_id,json_object('bookingId',NEW.booking_id),json_object('remaining',e.remaining,'version',e.version),NEW.consumed_at FROM booking_entitlements e WHERE e.id=NEW.entitlement_id; END;

CREATE TRIGGER booking_entitlement_consume_guard BEFORE UPDATE OF consumed_at ON booking_entitlement_uses WHEN OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL BEGIN  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM booking_entitlements e JOIN bookings b ON b.id=NEW.booking_id WHERE e.id=NEW.entitlement_id AND b.line_account_id=e.line_account_id AND b.friend_id=e.friend_id AND (e.menu_id IS NULL OR e.menu_id=b.menu_id) AND e.status='active' AND julianday(b.starts_at)>=julianday(e.valid_from) AND julianday(b.starts_at)<julianday(e.expires_at) AND (e.kind='ticket' AND e.remaining>0 OR e.kind='monthly' AND julianday(b.starts_at)>=julianday(NEW.period_start) AND julianday(b.starts_at)<julianday(NEW.period_end) AND (COALESCE((SELECT allowance FROM booking_entitlement_month_limits ml WHERE ml.entitlement_id=e.id AND ml.period_start=NEW.period_start),e.monthly_limit) IS NULL OR ((SELECT COUNT(*) FROM booking_entitlement_uses u JOIN bookings other ON other.id=u.booking_id WHERE u.entitlement_id=e.id AND u.consumed_at IS NOT NULL AND u.returned_at IS NULL AND julianday(other.starts_at)>=julianday(NEW.period_start) AND julianday(other.starts_at)<julianday(NEW.period_end)) + (SELECT COUNT(*) FROM event_booking_entitlement_uses u WHERE u.entitlement_id=e.id AND u.consumed_at IS NOT NULL AND u.returned_at IS NULL AND julianday(u.starts_at)>=julianday(NEW.period_start) AND julianday(u.starts_at)<julianday(NEW.period_end)))<COALESCE((SELECT allowance FROM booking_entitlement_month_limits ml WHERE ml.entitlement_id=e.id AND ml.period_start=NEW.period_start),e.monthly_limit)))) THEN RAISE(ABORT,'entitlement_unavailable') END; END;

CREATE TRIGGER booking_entitlement_immediate AFTER INSERT ON booking_entitlement_uses
WHEN (SELECT status FROM bookings WHERE id=NEW.booking_id)='confirmed'
BEGIN  UPDATE booking_entitlement_uses SET consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE booking_id=NEW.booking_id AND consumed_at IS NULL; END;

CREATE TRIGGER booking_entitlement_month_change BEFORE UPDATE OF starts_at ON bookings
WHEN EXISTS(SELECT 1 FROM booking_entitlement_uses u JOIN booking_entitlements e ON e.id=u.entitlement_id WHERE u.booking_id=NEW.id AND e.kind='monthly' AND (julianday(NEW.starts_at)<julianday(u.period_start) OR julianday(NEW.starts_at)>=julianday(u.period_end)))
BEGIN  SELECT RAISE(ABORT,'entitlement_month_change'); END;

CREATE TRIGGER booking_entitlement_reschedule BEFORE UPDATE OF starts_at,menu_id,friend_id,line_account_id ON bookings
WHEN EXISTS(SELECT 1 FROM booking_entitlement_uses u JOIN booking_entitlements e ON e.id=u.entitlement_id WHERE u.booking_id=NEW.id AND (NEW.line_account_id<>e.line_account_id OR NEW.friend_id IS NOT NULL AND NEW.friend_id IS NOT e.friend_id OR e.menu_id IS NOT NULL AND NEW.menu_id<>e.menu_id OR julianday(NEW.starts_at)<julianday(e.valid_from) OR julianday(NEW.starts_at)>=julianday(e.expires_at)))
BEGIN SELECT RAISE(ABORT,'entitlement_unavailable'); END;

CREATE TRIGGER booking_entitlement_use_validate BEFORE INSERT ON booking_entitlement_uses
BEGIN  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM bookings b JOIN booking_entitlements e ON e.id=NEW.entitlement_id WHERE b.id=NEW.booking_id AND b.line_account_id=e.line_account_id AND b.friend_id=e.friend_id AND e.status='active' AND (e.menu_id IS NULL OR e.menu_id=b.menu_id) AND julianday(b.starts_at)>=julianday(e.valid_from) AND julianday(b.starts_at)<julianday(e.expires_at) AND b.status IN ('requested','confirmed') AND NEW.consumed_at IS NULL) THEN RAISE(ABORT,'entitlement_unavailable') END; END;

CREATE TRIGGER booking_fixed_meeting_cancel AFTER UPDATE OF status ON bookings WHEN NEW.status IN('cancelled','rejected','expired')
BEGIN UPDATE bookings SET meeting_url=NULL,meeting_url_source=NULL WHERE id=NEW.id; END;

CREATE TRIGGER booking_fixed_meeting_confirm AFTER UPDATE OF status,staff_id ON bookings
WHEN NEW.status='confirmed' AND (OLD.status!='confirmed' OR OLD.staff_id!=NEW.staff_id)
BEGIN UPDATE bookings SET meeting_url=COALESCE((SELECT fixed_meeting_url FROM staff WHERE id=NEW.staff_id AND line_account_id=NEW.line_account_id),(SELECT fixed_meeting_url FROM menus WHERE id=NEW.menu_id AND line_account_id=NEW.line_account_id)),
 meeting_url_source=CASE WHEN (SELECT fixed_meeting_url FROM staff WHERE id=NEW.staff_id) IS NOT NULL THEN 'staff' ELSE 'menu' END
 WHERE id=NEW.id AND NEW.meeting_mode='online'; END;

CREATE TRIGGER booking_fixed_meeting_insert AFTER INSERT ON bookings WHEN NEW.status='confirmed'
BEGIN UPDATE bookings SET meeting_url=COALESCE((SELECT fixed_meeting_url FROM staff WHERE id=NEW.staff_id AND line_account_id=NEW.line_account_id),(SELECT fixed_meeting_url FROM menus WHERE id=NEW.menu_id AND line_account_id=NEW.line_account_id)),
 meeting_url_source=CASE WHEN (SELECT fixed_meeting_url FROM staff WHERE id=NEW.staff_id) IS NOT NULL THEN 'staff' ELSE 'menu' END
 WHERE id=NEW.id AND COALESCE(NEW.meeting_mode,(SELECT meeting_mode FROM menus WHERE id=NEW.menu_id))='online' AND NEW.meeting_url IS NULL; END;

CREATE TRIGGER booking_hq_archive_origin AFTER UPDATE OF archived_at ON hq_templates WHEN NEW.archived_at IS NOT NULL
BEGIN UPDATE menus SET hq_template_id=NULL,hq_template_version_id=NULL,hq_customized=0 WHERE hq_template_id=NEW.id; END;

CREATE TRIGGER booking_hq_local_edit AFTER UPDATE OF name,description,duration_minutes,base_price,buffer_after_minutes,category_label,audience_mode,audience_tag_ids_json ON menus
WHEN OLD.hq_template_id IS NOT NULL AND NEW.hq_template_version_id IS OLD.hq_template_version_id
AND (OLD.name IS NOT NEW.name OR OLD.description IS NOT NEW.description OR OLD.duration_minutes IS NOT NEW.duration_minutes OR OLD.base_price IS NOT NEW.base_price OR OLD.buffer_after_minutes IS NOT NEW.buffer_after_minutes OR OLD.category_label IS NOT NEW.category_label OR OLD.audience_mode IS NOT NEW.audience_mode OR OLD.audience_tag_ids_json IS NOT NEW.audience_tag_ids_json)
BEGIN UPDATE menus SET hq_customized=1 WHERE id=NEW.id; END;

CREATE TRIGGER booking_hq_origin_insert BEFORE INSERT ON menus WHEN NEW.hq_template_id IS NOT NULL
AND NOT EXISTS(SELECT 1 FROM hq_templates t JOIN hq_template_versions v ON v.template_id=t.id AND v.tenant_id=t.tenant_id JOIN line_accounts a ON a.tenant_id=t.tenant_id WHERE t.id=NEW.hq_template_id AND v.id=NEW.hq_template_version_id AND a.id=NEW.line_account_id)
BEGIN SELECT RAISE(ABORT,'hq_origin_account_mismatch'); END;

CREATE TRIGGER booking_hq_origin_update BEFORE UPDATE OF hq_template_id,hq_template_version_id ON menus WHEN NEW.hq_template_id IS NOT NULL
AND NOT EXISTS(SELECT 1 FROM hq_templates t JOIN hq_template_versions v ON v.template_id=t.id AND v.tenant_id=t.tenant_id JOIN line_accounts a ON a.tenant_id=t.tenant_id WHERE t.id=NEW.hq_template_id AND v.id=NEW.hq_template_version_id AND a.id=NEW.line_account_id)
BEGIN SELECT RAISE(ABORT,'hq_origin_account_mismatch'); END;

CREATE TRIGGER booking_menu_photo_guard_insert BEFORE INSERT ON menus BEGIN SELECT CASE WHEN NEW.photo_media_id IS NOT NULL AND NEW.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM media WHERE id = NEW.photo_media_id AND line_account_id = NEW.line_account_id AND kind = 'image' AND (archived_at IS NULL OR NEW.photo_media_id IS NULL)) THEN RAISE(ABORT, 'booking_photo_media_unavailable') END; END;

CREATE TRIGGER booking_menu_photo_guard_update BEFORE UPDATE ON menus BEGIN SELECT CASE WHEN NEW.photo_media_id IS NOT NULL AND NEW.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM media WHERE id = NEW.photo_media_id AND line_account_id = NEW.line_account_id AND kind = 'image' AND (archived_at IS NULL OR NEW.photo_media_id IS OLD.photo_media_id)) THEN RAISE(ABORT, 'booking_photo_media_unavailable') END; END;

CREATE TRIGGER booking_menu_photo_usage_delete AFTER DELETE ON menus BEGIN DELETE FROM media_usages WHERE ref_kind = 'booking_menu' AND ref_id = OLD.id; END;

CREATE TRIGGER booking_menu_photo_usage_insert AFTER INSERT ON menus BEGIN DELETE FROM media_usages WHERE ref_kind = 'booking_menu' AND ref_id = NEW.id; INSERT INTO media_usages(media_id,ref_kind,ref_id) SELECT NEW.photo_media_id, 'booking_menu', NEW.id WHERE NEW.photo_media_id IS NOT NULL AND NEW.deleted_at IS NULL; END;

CREATE TRIGGER booking_menu_photo_usage_update AFTER UPDATE ON menus BEGIN DELETE FROM media_usages WHERE ref_kind = 'booking_menu' AND ref_id = NEW.id; INSERT INTO media_usages(media_id,ref_kind,ref_id) SELECT NEW.photo_media_id, 'booking_menu', NEW.id WHERE NEW.photo_media_id IS NOT NULL AND NEW.deleted_at IS NULL; END;

CREATE TRIGGER booking_monthly_attempt_delete BEFORE DELETE ON booking_monthly_attempts BEGIN SELECT RAISE(ABORT,'monthly_attempt_immutable'); END;

CREATE TRIGGER booking_monthly_attempt_identity BEFORE UPDATE ON booking_monthly_attempts WHEN NEW.cycle_id IS NOT OLD.cycle_id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.account_id IS NOT OLD.account_id  OR NEW.attempt_no IS NOT OLD.attempt_no OR NEW.scheduled_at IS NOT OLD.scheduled_at OR NEW.request_key IS NOT OLD.request_key  OR NEW.payment_method_id IS NOT OLD.payment_method_id OR NEW.payment_method_version IS NOT OLD.payment_method_version  OR NEW.version!=OLD.version+1 OR OLD.state IN('succeeded','failed','canceled') AND NEW.state!=OLD.state BEGIN SELECT RAISE(ABORT,'monthly_attempt_conflict'); END;

CREATE TRIGGER booking_monthly_attempt_validate BEFORE INSERT ON booking_monthly_attempts BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM booking_monthly_cycles y JOIN booking_monthly_contracts c ON c.id=y.contract_id  WHERE y.id=NEW.cycle_id AND y.tenant_id=NEW.tenant_id AND y.account_id=NEW.account_id  AND y.invoice_id IS NOT NULL AND y.invoice_status='open' AND y.state IN('open','retry_wait','requires_action')  AND c.state IN('applying','active','stop_scheduled') AND c.service_state='enabled'  AND c.payment_method_id=NEW.payment_method_id AND c.payment_method_version=NEW.payment_method_version  AND (c.stop_effective_at IS NULL OR julianday(c.stop_effective_at)>julianday('now'))  AND ((NEW.attempt_no=0 AND NOT EXISTS(SELECT 1 FROM booking_monthly_attempts a WHERE a.cycle_id=y.id))   OR (NEW.attempt_no>0 AND EXISTS(SELECT 1 FROM booking_monthly_attempts a WHERE a.cycle_id=y.id AND a.attempt_no=NEW.attempt_no-1 AND a.state='failed')    AND y.first_failed_at IS NOT NULL AND julianday(NEW.scheduled_at)=julianday(y.first_failed_at)+CASE NEW.attempt_no WHEN 1 THEN 3 WHEN 2 THEN 5 ELSE 7 END)))  THEN RAISE(ABORT,'monthly_attempt_unavailable') END; END;

CREATE TRIGGER booking_monthly_contract_delete BEFORE DELETE ON booking_monthly_contracts BEGIN SELECT RAISE(ABORT,'monthly_contract_immutable'); END;

CREATE TRIGGER booking_monthly_contract_identity BEFORE UPDATE ON booking_monthly_contracts WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.account_id IS NOT OLD.account_id  OR NEW.friend_id IS NOT OLD.friend_id OR NEW.class_kind IS NOT OLD.class_kind OR NEW.class_id IS NOT OLD.class_id  OR NEW.plan_id IS NOT OLD.plan_id OR NEW.plan_version IS NOT OLD.plan_version OR NEW.amount IS NOT OLD.amount  OR NEW.monthly_limit IS NOT OLD.monthly_limit OR NEW.timezone IS NOT OLD.timezone OR NEW.connected_account IS NOT OLD.connected_account  OR NEW.connection_identity IS NOT OLD.connection_identity OR NEW.consent_version IS NOT OLD.consent_version  OR NEW.consented_at IS NOT OLD.consented_at OR NEW.request_key IS NOT OLD.request_key OR NEW.request_json IS NOT OLD.request_json  OR (OLD.customer_id IS NOT NULL AND NEW.customer_id IS NOT OLD.customer_id)  OR NEW.version!=OLD.version+1  OR (OLD.state='expired' AND NEW.state!=OLD.state)  OR (OLD.state='stopped' AND NEW.state!=OLD.state AND NOT(NEW.state='active' AND OLD.stop_reason='unpaid'    AND NEW.stop_reason IS NULL AND NEW.stop_effective_at IS NULL AND EXISTS(SELECT 1 FROM booking_monthly_cycles y      WHERE y.contract_id=NEW.id AND y.state='paid' AND julianday(y.service_start)<=julianday('now') AND julianday(y.service_end)>julianday('now'))))  OR (OLD.state IN('active','stop_scheduled') AND NEW.state IN('applying','expired'))  OR (OLD.stop_reason IN('member_request','store_request','store_immediate') AND    (NEW.stop_reason IS NOT OLD.stop_reason AND NOT(NEW.stop_reason IS 'store_immediate' AND julianday(NEW.stop_effective_at)<=julianday(OLD.stop_effective_at))     OR NEW.stop_effective_at IS NULL OR julianday(NEW.stop_effective_at)>julianday(OLD.stop_effective_at)))  OR (NEW.state IN('active','stop_scheduled') AND NOT EXISTS(SELECT 1 FROM booking_monthly_active_slots s WHERE s.contract_id=NEW.id))  OR (OLD.state='applying' AND NEW.state IN('active','stop_scheduled') AND NOT EXISTS(SELECT 1 FROM booking_monthly_cycles y WHERE y.contract_id=NEW.id AND y.kind='initial' AND y.state='paid'))  OR (NEW.payment_method_id IS NOT OLD.payment_method_id AND NEW.payment_method_version!=OLD.payment_method_version+1)  OR (OLD.attention_started_at IS NOT NULL AND NEW.attention_started_at IS NOT NULL AND julianday(NEW.attention_started_at)>julianday(OLD.attention_started_at)) BEGIN SELECT RAISE(ABORT,'monthly_contract_conflict'); END;

CREATE TRIGGER booking_monthly_contract_slot AFTER INSERT ON booking_monthly_contracts BEGIN INSERT INTO booking_monthly_active_slots VALUES(NEW.tenant_id,NEW.account_id,NEW.friend_id,NEW.class_kind,NEW.class_id,NEW.id); END;

CREATE TRIGGER booking_monthly_contract_validate BEFORE INSERT ON booking_monthly_contracts BEGIN  SELECT CASE WHEN NEW.state!='applying' OR NEW.version!=1 OR NOT EXISTS(   SELECT 1 FROM line_accounts a JOIN tenants t ON t.id=a.tenant_id   JOIN friends f ON f.id=NEW.friend_id AND f.line_account_id=a.id   JOIN booking_pass_plans p ON p.id=NEW.plan_id AND p.line_account_id=a.id   WHERE a.id=NEW.account_id AND a.tenant_id=NEW.tenant_id AND a.is_active=1 AND a.archived_at IS NULL AND t.status='active'   AND p.kind='monthly' AND p.status='on_sale' AND p.version=NEW.plan_version AND p.price=NEW.amount   AND p.monthly_limit IS NEW.monthly_limit   AND ((NEW.class_kind='menu' AND EXISTS(SELECT 1 FROM menus m WHERE m.id=NEW.class_id AND m.line_account_id=a.id AND m.deleted_at IS NULL)     AND (json_array_length(p.target_scope_json)=0 OR EXISTS(SELECT 1 FROM json_each(p.target_scope_json) WHERE value=NEW.class_id)))    OR (NEW.class_kind='event' AND EXISTS(SELECT 1 FROM events ev WHERE ev.id=NEW.class_id AND ev.line_account_id=a.id AND ev.deleted_at IS NULL)     AND p.event_target_scope_json IS NOT NULL AND (json_array_length(p.event_target_scope_json)=0 OR EXISTS(SELECT 1 FROM json_each(p.event_target_scope_json) WHERE value=NEW.class_id)))))  THEN RAISE(ABORT,'monthly_contract_unavailable') END; END;

CREATE TRIGGER booking_monthly_cycle_delete BEFORE DELETE ON booking_monthly_cycles BEGIN SELECT RAISE(ABORT,'monthly_cycle_immutable'); END;

CREATE TRIGGER booking_monthly_cycle_identity BEFORE UPDATE ON booking_monthly_cycles WHEN NEW.id IS NOT OLD.id OR NEW.contract_id IS NOT OLD.contract_id OR NEW.account_id IS NOT OLD.account_id OR NEW.tenant_id IS NOT OLD.tenant_id  OR NEW.connected_account IS NOT OLD.connected_account OR NEW.month_key IS NOT OLD.month_key OR NEW.kind IS NOT OLD.kind  OR NEW.amount IS NOT OLD.amount OR NEW.currency IS NOT OLD.currency OR NEW.due_at IS NOT OLD.due_at OR NEW.period_start IS NOT OLD.period_start OR NEW.service_start IS NOT OLD.service_start OR NEW.service_end IS NOT OLD.service_end  OR (OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS NOT OLD.invoice_id) OR NEW.version!=OLD.version+1  OR (OLD.state='paid' AND NEW.state!='paid')  OR (OLD.first_failed_at IS NOT NULL AND NEW.first_failed_at IS NOT OLD.first_failed_at) BEGIN SELECT RAISE(ABORT,'monthly_cycle_conflict'); END;

CREATE TRIGGER booking_monthly_cycle_validate BEFORE INSERT ON booking_monthly_cycles BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM booking_monthly_contracts c WHERE c.id=NEW.contract_id  AND c.account_id=NEW.account_id AND c.tenant_id=NEW.tenant_id AND c.connected_account=NEW.connected_account  AND c.amount=NEW.amount AND c.currency=NEW.currency AND c.state IN('applying','active','stop_scheduled')  AND (c.stop_effective_at IS NULL OR julianday(NEW.service_start)<julianday(c.stop_effective_at)))  THEN RAISE(ABORT,'monthly_cycle_unavailable') END; END;

CREATE TRIGGER booking_monthly_event_bounds BEFORE UPDATE OF event_booking_id,line_account_id,event_id,slot_id,starts_at,period_start,period_end ON event_booking_entitlement_uses WHEN NEW.event_booking_id IS NOT NULL AND EXISTS(SELECT 1 FROM booking_monthly_rights WHERE entitlement_id=NEW.entitlement_id) BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM event_bookings b JOIN event_slots s ON s.id=b.slot_id  JOIN booking_monthly_bound_rights v ON v.entitlement_id=NEW.entitlement_id  WHERE b.id=NEW.event_booking_id AND b.line_account_id=NEW.line_account_id AND v.account_id=b.line_account_id AND v.friend_id=b.friend_id  AND v.class_kind='event' AND v.class_id=b.event_id AND NEW.event_id=b.event_id AND NEW.slot_id=s.id  AND julianday(NEW.starts_at)=julianday(s.starts_at) AND julianday(NEW.starts_at)>=julianday(v.service_start) AND julianday(NEW.starts_at)<julianday(v.service_end)  AND julianday(NEW.period_start)=julianday(v.period_start) AND julianday(NEW.period_end)=julianday(v.service_end))  THEN RAISE(ABORT,'entitlement_unavailable') END; END;

CREATE TRIGGER booking_monthly_event_consume BEFORE UPDATE OF consumed_at ON event_booking_entitlement_uses WHEN EXISTS(SELECT 1 FROM booking_monthly_rights WHERE entitlement_id=NEW.entitlement_id) AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM event_bookings b JOIN event_slots s ON s.id=b.slot_id WHERE b.id=NEW.event_booking_id AND EXISTS(  SELECT 1 FROM booking_monthly_available_rights v WHERE v.entitlement_id=NEW.entitlement_id  AND v.account_id=b.line_account_id AND v.friend_id=b.friend_id AND v.class_kind='event' AND v.class_id=b.event_id  AND julianday(s.starts_at)>=julianday(v.service_start) AND julianday(s.starts_at)<julianday(v.service_end)  AND julianday(NEW.period_start)=julianday(v.period_start) AND julianday(NEW.period_end)=julianday(v.service_end)  AND (v.stop_effective_at IS NULL OR julianday(s.starts_at)<julianday(v.stop_effective_at))))  THEN RAISE(ABORT,'entitlement_unavailable') END; END;

CREATE TRIGGER booking_monthly_event_delete BEFORE DELETE ON booking_monthly_event_applications BEGIN SELECT RAISE(ABORT,'monthly_event_immutable'); END;

CREATE TRIGGER booking_monthly_event_identity BEFORE UPDATE ON booking_monthly_event_applications BEGIN SELECT RAISE(ABORT,'monthly_event_immutable'); END;

CREATE TRIGGER booking_monthly_event_select BEFORE INSERT ON event_booking_entitlement_uses WHEN EXISTS(SELECT 1 FROM booking_monthly_rights WHERE entitlement_id=NEW.entitlement_id) BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM event_bookings b JOIN event_slots s ON s.id=b.slot_id WHERE b.id=NEW.event_booking_id AND EXISTS(  SELECT 1 FROM booking_monthly_available_rights v WHERE v.entitlement_id=NEW.entitlement_id  AND v.account_id=b.line_account_id AND v.friend_id=b.friend_id AND v.class_kind='event' AND v.class_id=b.event_id  AND julianday(s.starts_at)>=julianday(v.service_start) AND julianday(s.starts_at)<julianday(v.service_end)  AND julianday(NEW.period_start)=julianday(v.period_start) AND julianday(NEW.period_end)=julianday(v.service_end)  AND (v.stop_effective_at IS NULL OR julianday(s.starts_at)<julianday(v.stop_effective_at))))  THEN RAISE(ABORT,'entitlement_unavailable') END; END;

CREATE TRIGGER booking_monthly_event_transfer BEFORE UPDATE OF event_booking_id,slot_id,starts_at,period_start,period_end ON event_booking_entitlement_uses WHEN NEW.event_booking_id IS NOT OLD.event_booking_id AND NEW.event_booking_id IS NOT NULL  AND EXISTS(SELECT 1 FROM booking_monthly_rights WHERE entitlement_id=NEW.entitlement_id) BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM event_bookings b JOIN event_slots s ON s.id=b.slot_id WHERE b.id=NEW.event_booking_id AND EXISTS(  SELECT 1 FROM booking_monthly_available_rights v WHERE v.entitlement_id=NEW.entitlement_id  AND v.account_id=b.line_account_id AND v.friend_id=b.friend_id AND v.class_kind='event' AND v.class_id=b.event_id  AND julianday(s.starts_at)>=julianday(v.service_start) AND julianday(s.starts_at)<julianday(v.service_end)  AND julianday(NEW.period_start)=julianday(v.period_start) AND julianday(NEW.period_end)=julianday(v.service_end)  AND (v.stop_effective_at IS NULL OR julianday(s.starts_at)<julianday(v.stop_effective_at))))  THEN RAISE(ABORT,'entitlement_unavailable') END; END;

CREATE TRIGGER booking_monthly_event_use_identity BEFORE UPDATE OF entitlement_id ON event_booking_entitlement_uses WHEN NEW.entitlement_id IS NOT OLD.entitlement_id AND EXISTS(SELECT 1 FROM booking_monthly_rights WHERE entitlement_id IN(OLD.entitlement_id,NEW.entitlement_id)) BEGIN SELECT RAISE(ABORT,'entitlement_unavailable'); END;

CREATE TRIGGER booking_monthly_right_delete BEFORE DELETE ON booking_monthly_rights BEGIN SELECT RAISE(ABORT,'monthly_right_immutable'); END;

CREATE TRIGGER booking_monthly_right_identity BEFORE UPDATE ON booking_monthly_rights WHEN NEW.contract_id IS NOT OLD.contract_id OR NEW.cycle_id IS NOT OLD.cycle_id OR NEW.tenant_id IS NOT OLD.tenant_id  OR NEW.account_id IS NOT OLD.account_id OR NEW.month_key IS NOT OLD.month_key OR NEW.entitlement_id IS NOT OLD.entitlement_id  OR NEW.version!=OLD.version+1  OR (NEW.state='paid' AND NOT EXISTS(SELECT 1 FROM booking_monthly_cycles WHERE id=NEW.cycle_id AND state='paid')) BEGIN SELECT RAISE(ABORT,'monthly_right_conflict'); END;

CREATE TRIGGER booking_monthly_right_validate BEFORE INSERT ON booking_monthly_rights BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM booking_monthly_cycles y JOIN booking_monthly_contracts c ON c.id=y.contract_id  JOIN booking_entitlements e ON e.id=NEW.entitlement_id AND e.line_account_id=c.account_id AND e.friend_id=c.friend_id  WHERE y.id=NEW.cycle_id AND y.contract_id=NEW.contract_id AND y.tenant_id=NEW.tenant_id AND y.account_id=NEW.account_id  AND y.month_key=NEW.month_key AND e.kind='monthly' AND e.source='online' AND e.plan_id=c.plan_id  AND e.monthly_limit IS c.monthly_limit AND e.stripe_subscription_id IS NULL  AND julianday(e.valid_from)=julianday(y.service_start) AND julianday(e.expires_at)=julianday(y.service_end)  AND ((c.class_kind='menu' AND e.menu_id=c.class_id) OR (c.class_kind='event' AND e.menu_id IS NULL))  AND ((NEW.state='paid' AND y.state='paid') OR (NEW.state='provisional' AND y.kind='renewal'  AND EXISTS(SELECT 1 FROM booking_monthly_cycles past WHERE past.contract_id=c.id AND past.state='paid' AND past.month_key<y.month_key))))  THEN RAISE(ABORT,'monthly_right_unavailable') END; END;

CREATE TRIGGER booking_monthly_slot_delete BEFORE DELETE ON booking_monthly_active_slots WHEN EXISTS(SELECT 1 FROM booking_monthly_contracts c WHERE c.id=OLD.contract_id AND  (c.state NOT IN('expired','stopped') OR julianday(c.stop_effective_at)>julianday('now')  OR EXISTS(SELECT 1 FROM booking_monthly_cycles y WHERE y.contract_id=c.id AND   (y.state IN('preparing','open','retry_wait','requires_action','processing','unknown','exhausted','blocked') OR y.invoice_status IN('draft','open')))  OR EXISTS(SELECT 1 FROM booking_monthly_rights r JOIN booking_monthly_cycles y ON y.id=r.cycle_id   WHERE r.contract_id=c.id AND r.state IN('paid','provisional') AND julianday(y.service_end)>julianday('now'))  OR EXISTS(SELECT 1 FROM workflow_steps w WHERE w.scope_id='line:'||c.account_id AND w.process_kind='booking_monthly'   AND w.status IN('pending','running','unknown') AND (w.subject_id=c.id OR w.subject_id IN(    SELECT id FROM booking_monthly_cycles WHERE contract_id=c.id UNION ALL SELECT id FROM booking_monthly_operations WHERE contract_id=c.id))))) BEGIN SELECT RAISE(ABORT,'monthly_slot_unresolved'); END;

CREATE TRIGGER booking_monthly_slot_identity BEFORE UPDATE ON booking_monthly_active_slots BEGIN SELECT RAISE(ABORT,'monthly_slot_immutable'); END;

CREATE TRIGGER booking_monthly_slot_reschedule BEFORE UPDATE OF starts_at,event_id ON event_slots WHEN EXISTS(SELECT 1 FROM event_booking_entitlement_uses u JOIN booking_monthly_rights r ON r.entitlement_id=u.entitlement_id WHERE u.slot_id=NEW.id AND u.returned_at IS NULL) BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM event_booking_entitlement_uses u  WHERE u.slot_id=NEW.id AND u.returned_at IS NULL AND EXISTS(SELECT 1 FROM booking_monthly_rights WHERE entitlement_id=u.entitlement_id)  AND NOT EXISTS(SELECT 1 FROM booking_monthly_bound_rights v WHERE v.entitlement_id=u.entitlement_id  AND v.class_kind='event' AND v.class_id=NEW.event_id AND julianday(NEW.starts_at)>=julianday(v.service_start)  AND julianday(NEW.starts_at)<julianday(v.service_end)))  THEN RAISE(ABORT,'entitlement_unavailable') END; END;

CREATE TRIGGER booking_monthly_use_consume BEFORE UPDATE OF consumed_at ON booking_entitlement_uses WHEN EXISTS(SELECT 1 FROM booking_monthly_rights WHERE entitlement_id=NEW.entitlement_id) AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM bookings b WHERE b.id=NEW.booking_id AND EXISTS(  SELECT 1 FROM booking_monthly_available_rights v WHERE v.entitlement_id=NEW.entitlement_id  AND v.account_id=b.line_account_id AND v.friend_id=b.friend_id AND v.class_kind='menu' AND v.class_id=b.menu_id  AND julianday(b.starts_at)>=julianday(v.service_start) AND julianday(b.starts_at)<julianday(v.service_end)  AND julianday(NEW.period_start)=julianday(v.period_start) AND julianday(NEW.period_end)=julianday(v.service_end)  AND (v.stop_effective_at IS NULL OR julianday(b.starts_at)<julianday(v.stop_effective_at))))  THEN RAISE(ABORT,'entitlement_unavailable') END; END;

CREATE TRIGGER booking_monthly_use_identity BEFORE UPDATE OF entitlement_id ON booking_entitlement_uses WHEN NEW.entitlement_id IS NOT OLD.entitlement_id AND EXISTS(SELECT 1 FROM booking_monthly_rights WHERE entitlement_id IN(OLD.entitlement_id,NEW.entitlement_id)) BEGIN SELECT RAISE(ABORT,'entitlement_unavailable'); END;

CREATE TRIGGER booking_monthly_use_reschedule BEFORE UPDATE OF starts_at,menu_id,friend_id,line_account_id ON bookings WHEN EXISTS(SELECT 1 FROM booking_entitlement_uses u JOIN booking_monthly_rights r ON r.entitlement_id=u.entitlement_id WHERE u.booking_id=NEW.id AND u.returned_at IS NULL) BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM booking_entitlement_uses u JOIN booking_monthly_bound_rights v ON v.entitlement_id=u.entitlement_id  WHERE u.booking_id=NEW.id AND v.account_id=NEW.line_account_id AND v.friend_id=NEW.friend_id AND v.class_kind='menu' AND v.class_id=NEW.menu_id  AND julianday(NEW.starts_at)>=julianday(v.service_start) AND julianday(NEW.starts_at)<julianday(v.service_end))  THEN RAISE(ABORT,'entitlement_unavailable') END; END;

CREATE TRIGGER booking_monthly_use_select BEFORE INSERT ON booking_entitlement_uses WHEN EXISTS(SELECT 1 FROM booking_monthly_rights WHERE entitlement_id=NEW.entitlement_id) BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM bookings b WHERE b.id=NEW.booking_id AND EXISTS(  SELECT 1 FROM booking_monthly_available_rights v WHERE v.entitlement_id=NEW.entitlement_id  AND v.account_id=b.line_account_id AND v.friend_id=b.friend_id AND v.class_kind='menu' AND v.class_id=b.menu_id  AND julianday(b.starts_at)>=julianday(v.service_start) AND julianday(b.starts_at)<julianday(v.service_end)  AND julianday(NEW.period_start)=julianday(v.period_start) AND julianday(NEW.period_end)=julianday(v.service_end)  AND (v.stop_effective_at IS NULL OR julianday(b.starts_at)<julianday(v.stop_effective_at))))  THEN RAISE(ABORT,'entitlement_unavailable') END; END;

CREATE TRIGGER booking_nomination_reassign AFTER UPDATE OF staff_id ON bookings
WHEN OLD.staff_id IS NOT NEW.staff_id AND OLD.nominated=1
BEGIN UPDATE bookings SET nominated=0,nomination_fee_at_booking=0,
 price_at_booking=MAX(0,NEW.price_at_booking-OLD.nomination_fee_at_booking) WHERE id=NEW.id; END;

CREATE TRIGGER booking_pass_grace_consumption BEFORE UPDATE OF consumed_at ON booking_entitlement_uses WHEN OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL AND EXISTS(SELECT 1 FROM booking_entitlements e WHERE e.id=NEW.entitlement_id AND NOT EXISTS(SELECT 1 FROM booking_monthly_rights mr WHERE mr.entitlement_id=e.id) AND e.billing_status='grace' AND julianday(e.grace_until)<=julianday('now')) BEGIN SELECT RAISE(ABORT,'entitlement_unavailable'); END;

CREATE TRIGGER booking_pass_grace_selection BEFORE INSERT ON booking_entitlement_uses WHEN EXISTS(SELECT 1 FROM booking_entitlements e WHERE e.id=NEW.entitlement_id AND NOT EXISTS(SELECT 1 FROM booking_monthly_rights mr WHERE mr.entitlement_id=e.id) AND e.billing_status='grace' AND julianday(e.grace_until)<=julianday('now')) BEGIN SELECT RAISE(ABORT,'entitlement_unavailable'); END;

CREATE TRIGGER booking_pass_remaining_notice AFTER INSERT ON booking_entitlement_events
WHEN NEW.action='consume'
BEGIN  INSERT INTO booking_entitlement_notices(id,line_account_id,friend_id,entitlement_id,plan_id,kind,dedupe_key,messages_json,scheduled_at) SELECT lower(hex(randomblob(16))),e.line_account_id,e.friend_id,e.id,e.plan_id,'remaining_one','once',json_array(json_object('type','text','text',e.name||'の残りは1回です（期限 '||e.expires_at||'）')),NEW.created_at FROM booking_entitlements e JOIN booking_pass_plans p ON p.id=e.plan_id AND p.line_account_id=e.line_account_id WHERE e.id=NEW.entitlement_id AND e.kind='ticket' AND e.remaining=1 AND e.status='active' AND e.friend_id IS NOT NULL AND p.notify_remaining_one=1 ON CONFLICT(entitlement_id,kind,dedupe_key) DO NOTHING; END;

CREATE TRIGGER booking_payments_history_detach AFTER UPDATE OF booking_id ON booking_payments BEGIN UPDATE booking_payments SET booking_id_history = COALESCE(NEW.booking_id, OLD.booking_id, OLD.booking_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER booking_payments_history_insert AFTER INSERT ON booking_payments BEGIN UPDATE booking_payments SET booking_id_history = COALESCE(NEW.booking_id, NEW.booking_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER booking_resource_consumptions_account_insert
BEFORE INSERT ON booking_resource_consumptions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM bookings b
  INNER JOIN booking_resources r ON r.id = NEW.resource_id
  WHERE b.id = NEW.booking_id
    AND b.line_account_id = NEW.line_account_id
    AND r.line_account_id = NEW.line_account_id
)
BEGIN
  SELECT RAISE(ABORT, 'booking_resource_consumption_account_mismatch'); END;

CREATE TRIGGER booking_resource_consumptions_immutable
BEFORE UPDATE ON booking_resource_consumptions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'booking_resource_consumption_immutable'); END;

CREATE TRIGGER booking_settings_photo_guard_insert BEFORE INSERT ON booking_settings BEGIN SELECT CASE WHEN NEW.store_photo_media_id IS NOT NULL AND 1 AND NOT EXISTS (SELECT 1 FROM media WHERE id = NEW.store_photo_media_id AND line_account_id = NEW.line_account_id AND kind = 'image' AND (archived_at IS NULL OR NEW.store_photo_media_id IS NULL)) THEN RAISE(ABORT, 'booking_photo_media_unavailable') END; SELECT CASE WHEN NEW.store_photo_interior_media_id IS NOT NULL AND 1 AND NOT EXISTS (SELECT 1 FROM media WHERE id = NEW.store_photo_interior_media_id AND line_account_id = NEW.line_account_id AND kind = 'image' AND (archived_at IS NULL OR NEW.store_photo_interior_media_id IS NULL)) THEN RAISE(ABORT, 'booking_photo_media_unavailable') END; SELECT CASE WHEN NEW.store_photo_waiting_media_id IS NOT NULL AND 1 AND NOT EXISTS (SELECT 1 FROM media WHERE id = NEW.store_photo_waiting_media_id AND line_account_id = NEW.line_account_id AND kind = 'image' AND (archived_at IS NULL OR NEW.store_photo_waiting_media_id IS NULL)) THEN RAISE(ABORT, 'booking_photo_media_unavailable') END; END;

CREATE TRIGGER booking_settings_photo_guard_update BEFORE UPDATE ON booking_settings BEGIN SELECT CASE WHEN NEW.store_photo_media_id IS NOT NULL AND 1 AND NOT EXISTS (SELECT 1 FROM media WHERE id = NEW.store_photo_media_id AND line_account_id = NEW.line_account_id AND kind = 'image' AND (archived_at IS NULL OR NEW.store_photo_media_id IS OLD.store_photo_media_id)) THEN RAISE(ABORT, 'booking_photo_media_unavailable') END; SELECT CASE WHEN NEW.store_photo_interior_media_id IS NOT NULL AND 1 AND NOT EXISTS (SELECT 1 FROM media WHERE id = NEW.store_photo_interior_media_id AND line_account_id = NEW.line_account_id AND kind = 'image' AND (archived_at IS NULL OR NEW.store_photo_interior_media_id IS OLD.store_photo_interior_media_id)) THEN RAISE(ABORT, 'booking_photo_media_unavailable') END; SELECT CASE WHEN NEW.store_photo_waiting_media_id IS NOT NULL AND 1 AND NOT EXISTS (SELECT 1 FROM media WHERE id = NEW.store_photo_waiting_media_id AND line_account_id = NEW.line_account_id AND kind = 'image' AND (archived_at IS NULL OR NEW.store_photo_waiting_media_id IS OLD.store_photo_waiting_media_id)) THEN RAISE(ABORT, 'booking_photo_media_unavailable') END; END;

CREATE TRIGGER booking_settings_photo_usage_delete AFTER DELETE ON booking_settings BEGIN DELETE FROM media_usages WHERE ref_kind = 'booking_settings' AND ref_id = OLD.id; END;

CREATE TRIGGER booking_settings_photo_usage_insert AFTER INSERT ON booking_settings BEGIN DELETE FROM media_usages WHERE ref_kind = 'booking_settings' AND ref_id = NEW.id; INSERT INTO media_usages(media_id,ref_kind,ref_id) SELECT NEW.store_photo_media_id, 'booking_settings', NEW.id WHERE NEW.store_photo_media_id IS NOT NULL AND 1 UNION SELECT NEW.store_photo_interior_media_id, 'booking_settings', NEW.id WHERE NEW.store_photo_interior_media_id IS NOT NULL AND 1 UNION SELECT NEW.store_photo_waiting_media_id, 'booking_settings', NEW.id WHERE NEW.store_photo_waiting_media_id IS NOT NULL AND 1; END;

CREATE TRIGGER booking_settings_photo_usage_update AFTER UPDATE ON booking_settings BEGIN DELETE FROM media_usages WHERE ref_kind = 'booking_settings' AND ref_id = NEW.id; INSERT INTO media_usages(media_id,ref_kind,ref_id) SELECT NEW.store_photo_media_id, 'booking_settings', NEW.id WHERE NEW.store_photo_media_id IS NOT NULL AND 1 UNION SELECT NEW.store_photo_interior_media_id, 'booking_settings', NEW.id WHERE NEW.store_photo_interior_media_id IS NOT NULL AND 1 UNION SELECT NEW.store_photo_waiting_media_id, 'booking_settings', NEW.id WHERE NEW.store_photo_waiting_media_id IS NOT NULL AND 1; END;

CREATE TRIGGER booking_staff_photo_guard_insert BEFORE INSERT ON staff BEGIN SELECT CASE WHEN NEW.photo_media_id IS NOT NULL AND NEW.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM media WHERE id = NEW.photo_media_id AND line_account_id = NEW.line_account_id AND kind = 'image' AND (archived_at IS NULL OR NEW.photo_media_id IS NULL)) THEN RAISE(ABORT, 'booking_photo_media_unavailable') END; END;

CREATE TRIGGER booking_staff_photo_guard_update BEFORE UPDATE ON staff BEGIN SELECT CASE WHEN NEW.photo_media_id IS NOT NULL AND NEW.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM media WHERE id = NEW.photo_media_id AND line_account_id = NEW.line_account_id AND kind = 'image' AND (archived_at IS NULL OR NEW.photo_media_id IS OLD.photo_media_id)) THEN RAISE(ABORT, 'booking_photo_media_unavailable') END; END;

CREATE TRIGGER booking_staff_photo_usage_delete AFTER DELETE ON staff BEGIN DELETE FROM media_usages WHERE ref_kind = 'booking_staff' AND ref_id = OLD.id; END;

CREATE TRIGGER booking_staff_photo_usage_insert AFTER INSERT ON staff BEGIN DELETE FROM media_usages WHERE ref_kind = 'booking_staff' AND ref_id = NEW.id; INSERT INTO media_usages(media_id,ref_kind,ref_id) SELECT NEW.photo_media_id, 'booking_staff', NEW.id WHERE NEW.photo_media_id IS NOT NULL AND NEW.deleted_at IS NULL; END;

CREATE TRIGGER booking_staff_photo_usage_update AFTER UPDATE ON staff BEGIN DELETE FROM media_usages WHERE ref_kind = 'booking_staff' AND ref_id = NEW.id; INSERT INTO media_usages(media_id,ref_kind,ref_id) SELECT NEW.photo_media_id, 'booking_staff', NEW.id WHERE NEW.photo_media_id IS NOT NULL AND NEW.deleted_at IS NULL; END;

CREATE TRIGGER booking_sync_notice_booking_delete AFTER DELETE ON bookings BEGIN INSERT INTO booking_sync_notice_queue(line_account_id) VALUES(OLD.line_account_id) ON CONFLICT(line_account_id) DO UPDATE SET generation=generation+1,updated_at=datetime('now'); END;

CREATE TRIGGER booking_sync_notice_booking_insert AFTER INSERT ON bookings BEGIN INSERT INTO booking_sync_notice_queue(line_account_id) VALUES(NEW.line_account_id) ON CONFLICT(line_account_id) DO UPDATE SET generation=generation+1,updated_at=datetime('now'); END;

CREATE TRIGGER booking_sync_notice_booking_update AFTER UPDATE ON bookings BEGIN INSERT INTO booking_sync_notice_queue(line_account_id) VALUES(NEW.line_account_id) ON CONFLICT(line_account_id) DO UPDATE SET generation=generation+1,updated_at=datetime('now'); END;

CREATE TRIGGER booking_sync_rules_insert AFTER INSERT ON booking_sync_rules BEGIN INSERT INTO account_settings(id,line_account_id,key,value) VALUES(lower(hex(randomblob(16))),NEW.line_account_id,'booking_auto_assign',CASE WHEN NEW.auto_assign=1 THEN 'true' ELSE 'false' END) ON CONFLICT(line_account_id,key) DO UPDATE SET value=excluded.value; INSERT INTO booking_sync_notice_queue(line_account_id) VALUES(NEW.line_account_id) ON CONFLICT(line_account_id) DO UPDATE SET generation=generation+1,updated_at=datetime('now'); END;

CREATE TRIGGER booking_sync_rules_update AFTER UPDATE ON booking_sync_rules BEGIN INSERT INTO account_settings(id,line_account_id,key,value) VALUES(lower(hex(randomblob(16))),NEW.line_account_id,'booking_auto_assign',CASE WHEN NEW.auto_assign=1 THEN 'true' ELSE 'false' END) ON CONFLICT(line_account_id,key) DO UPDATE SET value=excluded.value; INSERT INTO booking_sync_notice_queue(line_account_id) VALUES(NEW.line_account_id) ON CONFLICT(line_account_id) DO UPDATE SET generation=generation+1,updated_at=datetime('now'); END;

CREATE TRIGGER booking_waitlist_booking_insert BEFORE INSERT ON bookings WHEN NEW.status IN ('requested','confirmed') AND ((NEW.waitlist_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM booking_waitlist w JOIN bookings b ON b.waitlist_entry_id=w.id WHERE b.id=NEW.id AND w.id=NEW.waitlist_entry_id AND w.status='converted') AND NOT EXISTS(SELECT 1 FROM booking_waitlist w WHERE w.id=NEW.waitlist_entry_id AND w.line_account_id=NEW.line_account_id AND w.friend_id=NEW.friend_id AND w.staff_id=NEW.staff_id AND w.menu_id=NEW.menu_id AND julianday(w.starts_at)=julianday(NEW.starts_at) AND ((w.status='invited' AND julianday(w.hold_expires_at)>julianday('now')) OR (w.status='converted' AND EXISTS(SELECT 1 FROM bookings b WHERE b.id=NEW.id AND b.waitlist_entry_id=w.id))))) OR (EXISTS(SELECT 1 FROM booking_waitlist w WHERE w.line_account_id=NEW.line_account_id AND w.status='invited' AND julianday(w.hold_expires_at)>julianday('now')) AND (EXISTS(SELECT 1 FROM booking_slot_allocations a WHERE a.line_account_id=NEW.line_account_id AND a.id<>NEW.id AND (NEW.waitlist_entry_id IS NULL OR COALESCE(a.waitlist_id,'')<>NEW.waitlist_entry_id) AND a.staff_id=NEW.staff_id AND a.menu_id<>NEW.menu_id AND julianday(a.starts_at)<julianday(NEW.block_ends_at) AND julianday(a.block_ends_at)>julianday(NEW.starts_at)) OR (SELECT COUNT(*) FROM booking_slot_allocations a WHERE a.line_account_id=NEW.line_account_id AND a.id<>NEW.id AND (NEW.waitlist_entry_id IS NULL OR COALESCE(a.waitlist_id,'')<>NEW.waitlist_entry_id) AND a.staff_id=NEW.staff_id AND a.menu_id=NEW.menu_id AND julianday(a.starts_at)<julianday(NEW.block_ends_at) AND julianday(a.block_ends_at)>julianday(NEW.starts_at))>=COALESCE((SELECT concurrent_capacity FROM menus WHERE id=NEW.menu_id),1) OR EXISTS(SELECT 1 FROM booking_menu_resources mr JOIN booking_resources r ON r.id=mr.resource_id WHERE mr.menu_id=NEW.menu_id AND (r.is_active<>1 OR r.line_account_id<>NEW.line_account_id OR mr.quantity+(SELECT COALESCE(SUM(a.quantity),0) FROM booking_slot_resources a WHERE a.line_account_id=NEW.line_account_id AND a.id<>NEW.id AND (NEW.waitlist_entry_id IS NULL OR COALESCE(a.waitlist_id,'')<>NEW.waitlist_entry_id) AND a.resource_id=r.id AND julianday(a.starts_at)<julianday(NEW.block_ends_at) AND julianday(a.block_ends_at)>julianday(NEW.starts_at))>r.capacity)) OR EXISTS(SELECT 1 FROM json_each(COALESCE((SELECT json_group_array(json(value)) FROM booking_waitlist w,json_each(w.capacity_windows_json) WHERE w.line_account_id=NEW.line_account_id AND w.status='invited' AND julianday(w.hold_expires_at)>julianday('now') AND julianday(w.starts_at)<julianday(NEW.block_ends_at) AND julianday(w.block_ends_at)>julianday(NEW.starts_at)),'[]')) win WHERE EXISTS(SELECT 1 FROM (SELECT julianday(json_extract(win.value,'$.start')) point UNION ALL SELECT julianday(a.starts_at) FROM booking_slot_allocations a WHERE a.line_account_id=NEW.line_account_id AND a.id<>NEW.id AND (NEW.waitlist_entry_id IS NULL OR COALESCE(a.waitlist_id,'')<>NEW.waitlist_entry_id) AND julianday(a.starts_at)>julianday(json_extract(win.value,'$.start')) AND julianday(a.starts_at)<julianday(json_extract(win.value,'$.end'))) p WHERE (SELECT COUNT(*) FROM booking_slot_allocations a WHERE a.line_account_id=NEW.line_account_id AND a.id<>NEW.id AND (NEW.waitlist_entry_id IS NULL OR COALESCE(a.waitlist_id,'')<>NEW.waitlist_entry_id) AND julianday(a.starts_at)<=p.point AND julianday(a.block_ends_at)>p.point)>=json_extract(win.value,'$.capacity')))))) BEGIN SELECT RAISE(ABORT,'waitlist_hold_conflict'); END;

CREATE TRIGGER booking_waitlist_booking_update BEFORE UPDATE OF staff_id,menu_id,starts_at,block_ends_at,status ON bookings WHEN NEW.status IN ('requested','confirmed') AND ((NEW.waitlist_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM booking_waitlist w JOIN bookings b ON b.waitlist_entry_id=w.id WHERE b.id=NEW.id AND w.id=NEW.waitlist_entry_id AND w.status='converted') AND NOT EXISTS(SELECT 1 FROM booking_waitlist w WHERE w.id=NEW.waitlist_entry_id AND w.line_account_id=NEW.line_account_id AND w.friend_id=NEW.friend_id AND w.staff_id=NEW.staff_id AND w.menu_id=NEW.menu_id AND julianday(w.starts_at)=julianday(NEW.starts_at) AND ((w.status='invited' AND julianday(w.hold_expires_at)>julianday('now')) OR (w.status='converted' AND EXISTS(SELECT 1 FROM bookings b WHERE b.id=NEW.id AND b.waitlist_entry_id=w.id))))) OR (EXISTS(SELECT 1 FROM booking_waitlist w WHERE w.line_account_id=NEW.line_account_id AND w.status='invited' AND julianday(w.hold_expires_at)>julianday('now')) AND (EXISTS(SELECT 1 FROM booking_slot_allocations a WHERE a.line_account_id=NEW.line_account_id AND a.id<>NEW.id AND (NEW.waitlist_entry_id IS NULL OR COALESCE(a.waitlist_id,'')<>NEW.waitlist_entry_id) AND a.staff_id=NEW.staff_id AND a.menu_id<>NEW.menu_id AND julianday(a.starts_at)<julianday(NEW.block_ends_at) AND julianday(a.block_ends_at)>julianday(NEW.starts_at)) OR (SELECT COUNT(*) FROM booking_slot_allocations a WHERE a.line_account_id=NEW.line_account_id AND a.id<>NEW.id AND (NEW.waitlist_entry_id IS NULL OR COALESCE(a.waitlist_id,'')<>NEW.waitlist_entry_id) AND a.staff_id=NEW.staff_id AND a.menu_id=NEW.menu_id AND julianday(a.starts_at)<julianday(NEW.block_ends_at) AND julianday(a.block_ends_at)>julianday(NEW.starts_at))>=COALESCE((SELECT concurrent_capacity FROM menus WHERE id=NEW.menu_id),1) OR EXISTS(SELECT 1 FROM booking_menu_resources mr JOIN booking_resources r ON r.id=mr.resource_id WHERE mr.menu_id=NEW.menu_id AND (r.is_active<>1 OR r.line_account_id<>NEW.line_account_id OR mr.quantity+(SELECT COALESCE(SUM(a.quantity),0) FROM booking_slot_resources a WHERE a.line_account_id=NEW.line_account_id AND a.id<>NEW.id AND (NEW.waitlist_entry_id IS NULL OR COALESCE(a.waitlist_id,'')<>NEW.waitlist_entry_id) AND a.resource_id=r.id AND julianday(a.starts_at)<julianday(NEW.block_ends_at) AND julianday(a.block_ends_at)>julianday(NEW.starts_at))>r.capacity)) OR EXISTS(SELECT 1 FROM json_each(COALESCE((SELECT json_group_array(json(value)) FROM booking_waitlist w,json_each(w.capacity_windows_json) WHERE w.line_account_id=NEW.line_account_id AND w.status='invited' AND julianday(w.hold_expires_at)>julianday('now') AND julianday(w.starts_at)<julianday(NEW.block_ends_at) AND julianday(w.block_ends_at)>julianday(NEW.starts_at)),'[]')) win WHERE EXISTS(SELECT 1 FROM (SELECT julianday(json_extract(win.value,'$.start')) point UNION ALL SELECT julianday(a.starts_at) FROM booking_slot_allocations a WHERE a.line_account_id=NEW.line_account_id AND a.id<>NEW.id AND (NEW.waitlist_entry_id IS NULL OR COALESCE(a.waitlist_id,'')<>NEW.waitlist_entry_id) AND julianday(a.starts_at)>julianday(json_extract(win.value,'$.start')) AND julianday(a.starts_at)<julianday(json_extract(win.value,'$.end'))) p WHERE (SELECT COUNT(*) FROM booking_slot_allocations a WHERE a.line_account_id=NEW.line_account_id AND a.id<>NEW.id AND (NEW.waitlist_entry_id IS NULL OR COALESCE(a.waitlist_id,'')<>NEW.waitlist_entry_id) AND julianday(a.starts_at)<=p.point AND julianday(a.block_ends_at)>p.point)>=json_extract(win.value,'$.capacity')))))) BEGIN SELECT RAISE(ABORT,'waitlist_hold_conflict'); END;

CREATE TRIGGER booking_waitlist_claim BEFORE UPDATE OF status ON booking_waitlist WHEN NEW.status='invited' AND OLD.status='waiting' AND (EXISTS(SELECT 1 FROM booking_slot_allocations a WHERE a.line_account_id=NEW.line_account_id AND a.id<>NEW.id AND (NULL IS NULL OR COALESCE(a.waitlist_id,'')<>NULL) AND a.staff_id=NEW.staff_id AND a.menu_id<>NEW.menu_id AND julianday(a.starts_at)<julianday(NEW.block_ends_at) AND julianday(a.block_ends_at)>julianday(NEW.starts_at)) OR (SELECT COUNT(*) FROM booking_slot_allocations a WHERE a.line_account_id=NEW.line_account_id AND a.id<>NEW.id AND (NULL IS NULL OR COALESCE(a.waitlist_id,'')<>NULL) AND a.staff_id=NEW.staff_id AND a.menu_id=NEW.menu_id AND julianday(a.starts_at)<julianday(NEW.block_ends_at) AND julianday(a.block_ends_at)>julianday(NEW.starts_at))>=COALESCE((SELECT concurrent_capacity FROM menus WHERE id=NEW.menu_id),1) OR EXISTS(SELECT 1 FROM booking_menu_resources mr JOIN booking_resources r ON r.id=mr.resource_id WHERE mr.menu_id=NEW.menu_id AND (r.is_active<>1 OR r.line_account_id<>NEW.line_account_id OR mr.quantity+(SELECT COALESCE(SUM(a.quantity),0) FROM booking_slot_resources a WHERE a.line_account_id=NEW.line_account_id AND a.id<>NEW.id AND (NULL IS NULL OR COALESCE(a.waitlist_id,'')<>NULL) AND a.resource_id=r.id AND julianday(a.starts_at)<julianday(NEW.block_ends_at) AND julianday(a.block_ends_at)>julianday(NEW.starts_at))>r.capacity)) OR EXISTS(SELECT 1 FROM json_each(NEW.capacity_windows_json) win WHERE EXISTS(SELECT 1 FROM (SELECT julianday(json_extract(win.value,'$.start')) point UNION ALL SELECT julianday(a.starts_at) FROM booking_slot_allocations a WHERE a.line_account_id=NEW.line_account_id AND a.id<>NEW.id AND (NULL IS NULL OR COALESCE(a.waitlist_id,'')<>NULL) AND julianday(a.starts_at)>julianday(json_extract(win.value,'$.start')) AND julianday(a.starts_at)<julianday(json_extract(win.value,'$.end'))) p WHERE (SELECT COUNT(*) FROM booking_slot_allocations a WHERE a.line_account_id=NEW.line_account_id AND a.id<>NEW.id AND (NULL IS NULL OR COALESCE(a.waitlist_id,'')<>NULL) AND julianday(a.starts_at)<=p.point AND julianday(a.block_ends_at)>p.point)>=json_extract(win.value,'$.capacity')))) BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER booking_waitlist_conversion AFTER INSERT ON bookings WHEN NEW.waitlist_entry_id IS NOT NULL BEGIN UPDATE booking_waitlist SET status='converted',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.waitlist_entry_id; END;

CREATE TRIGGER booking_waitlist_registration BEFORE INSERT ON booking_waitlist BEGIN SELECT CASE WHEN julianday(NEW.starts_at)<=julianday('now','+1 hour') THEN RAISE(ABORT,'waitlist_registration_closed') WHEN ((SELECT COUNT(*) FROM booking_waitlist w WHERE w.line_account_id=NEW.line_account_id AND w.status IN ('waiting','invited') AND (w.friend_id=NEW.friend_id OR (w.booking_customer_id IS NOT NULL AND w.booking_customer_id=NEW.booking_customer_id))) + (SELECT COUNT(*) FROM rt_seat_waitlist w JOIN rt_stores s ON s.id=w.store_id WHERE s.line_account_id=NEW.line_account_id AND w.status IN ('waiting','invited') AND w.line_uid=(SELECT line_user_id FROM friends WHERE id=NEW.friend_id AND line_account_id=NEW.line_account_id)))>=3 THEN RAISE(ABORT,'waitlist_limit') END; END;

CREATE TRIGGER booking_waitlist_resource_snapshot AFTER UPDATE OF status ON booking_waitlist WHEN NEW.status='invited' AND OLD.status='waiting' BEGIN INSERT OR REPLACE INTO booking_waitlist_resources SELECT NEW.id,resource_id,quantity FROM booking_menu_resources WHERE menu_id=NEW.menu_id; END;

CREATE TRIGGER broadcast_simulation_dispatch_insert BEFORE INSERT ON broadcast_send_claims
WHEN (NEW.dispatched_at IS NOT NULL OR NEW.state='sent') AND EXISTS(SELECT 1 FROM broadcast_execution_contexts WHERE broadcast_id=NEW.broadcast_id)
BEGIN SELECT RAISE(ABORT,'simulation_transport_forbidden'); END;

CREATE TRIGGER broadcast_simulation_dispatch_update BEFORE UPDATE ON broadcast_send_claims
WHEN (NEW.dispatched_at IS NOT NULL OR NEW.state='sent') AND EXISTS(SELECT 1 FROM broadcast_execution_contexts WHERE broadcast_id=NEW.broadcast_id)
BEGIN SELECT RAISE(ABORT,'simulation_transport_forbidden'); END;

CREATE TRIGGER capture_ad_conversion_account AFTER INSERT ON conversion_events BEGIN INSERT INTO ad_conversion_event_accounts(conversion_event_id,line_account_id,platform_ids_json) SELECT NEW.id,f.line_account_id,(SELECT json_group_array(p.id) FROM ad_platforms p WHERE p.line_account_id = f.line_account_id AND p.is_active = 1 AND p.verified_at IS NOT NULL AND p.name IN ('meta','google')) FROM friends f WHERE f.id = NEW.friend_id AND f.line_account_id IS NOT NULL; END;

CREATE TRIGGER chats_sla_manual_response AFTER UPDATE OF last_operator_message_at ON chats
WHEN NEW.pending_since IS NOT NULL AND NEW.first_response_at IS NULL AND julianday(NEW.last_operator_message_at)>=julianday(NEW.pending_since)
BEGIN UPDATE chats SET first_response_at=NEW.last_operator_message_at,sla_due_at=NULL WHERE id=NEW.id; END;

CREATE TRIGGER chats_sla_pending_insert AFTER INSERT ON chats WHEN NEW.last_customer_message_at IS NOT NULL
BEGIN UPDATE chats SET pending_since=NEW.last_customer_message_at WHERE id=NEW.id; END;

CREATE TRIGGER chats_sla_pending_update AFTER UPDATE OF last_customer_message_at ON chats
WHEN NEW.last_customer_message_at IS NOT NULL AND (OLD.pending_since IS NULL OR OLD.first_response_at IS NOT NULL)
 AND (NEW.last_operator_message_at IS NULL OR julianday(NEW.last_customer_message_at)>julianday(NEW.last_operator_message_at))
BEGIN UPDATE chats SET pending_since=NEW.last_customer_message_at,sla_due_at=NULL,first_response_at=NULL,sla_notified_stage=0 WHERE id=NEW.id; END;

CREATE TRIGGER common_actions_folder_delete AFTER DELETE ON folders
BEGIN UPDATE common_actions SET folder_id = NULL WHERE folder_id = OLD.id; END;

CREATE TRIGGER common_actions_folder_insert BEFORE INSERT ON common_actions
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM folders WHERE id = NEW.folder_id AND kind = 'common_action' AND account_id = NEW.line_account_id
) BEGIN SELECT RAISE(ABORT, 'folder_assignment_invalid'); END;

CREATE TRIGGER common_actions_folder_update BEFORE UPDATE OF folder_id, line_account_id ON common_actions
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM folders WHERE id = NEW.folder_id AND kind = 'common_action' AND account_id = NEW.line_account_id
) BEGIN SELECT RAISE(ABORT, 'folder_assignment_invalid'); END;

CREATE TRIGGER conversion_points_folder_delete AFTER DELETE ON folders
BEGIN UPDATE conversion_points SET folder_id = NULL WHERE folder_id = OLD.id; END;

CREATE TRIGGER conversion_points_folder_insert BEFORE INSERT ON conversion_points
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM folders WHERE id = NEW.folder_id AND kind = 'conversion' AND account_id = NEW.line_account_id
) BEGIN SELECT RAISE(ABORT, 'folder_assignment_invalid'); END;

CREATE TRIGGER conversion_points_folder_update BEFORE UPDATE OF folder_id, line_account_id ON conversion_points
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM folders WHERE id = NEW.folder_id AND kind = 'conversion' AND account_id = NEW.line_account_id
) BEGIN SELECT RAISE(ABORT, 'folder_assignment_invalid'); END;

CREATE TRIGGER conversion_points_prevent_delete
BEFORE DELETE ON conversion_points
WHEN EXISTS (
  SELECT 1 FROM conversion_events WHERE conversion_point_id = OLD.id
) OR EXISTS (
  SELECT 1 FROM conversion_definition_usages WHERE conversion_point_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'conversion point with events or usages cannot be deleted'); END;

CREATE TRIGGER event_booking_transition_version AFTER UPDATE OF status,slot_id,friend_id,line_account_id,participation_mode ON event_bookings WHEN NEW.status IS NOT OLD.status OR NEW.slot_id IS NOT OLD.slot_id OR NEW.friend_id IS NOT OLD.friend_id OR NEW.line_account_id IS NOT OLD.line_account_id OR NEW.participation_mode IS NOT OLD.participation_mode BEGIN  UPDATE event_bookings SET lock_version=OLD.lock_version+1 WHERE id=NEW.id;  INSERT INTO event_booking_transition_runs  (id,line_account_id,event_id,booking_id,booking_id_history,expected_booking_version,booking_version,event_version,operation_key,action,input_snapshot,before_json,after_json,created_at,updated_at)  SELECT lower(hex(randomblob(16))),NEW.line_account_id,NEW.event_id,NEW.id,NEW.id,OLD.lock_version,OLD.lock_version+1,e.current_published_version_id,  'event-transition:'||NEW.id||':'||(OLD.lock_version+1),  CASE WHEN NEW.slot_id<>OLD.slot_id THEN 'change' WHEN NEW.status='cancelled' THEN 'cancel' WHEN NEW.status='rejected' THEN 'reject' ELSE NEW.status END,  json_object('friendId',NEW.friend_id,'recipient',f.line_user_id,'slotId',NEW.slot_id,'startsAt',s.starts_at,'status',NEW.status,'eventName',e.name,'venueName',e.venue_name,'venueUrl',e.venue_url,'cancelledBy',NEW.cancelled_by),  json_object('status',OLD.status,'slotId',OLD.slot_id,'version',OLD.lock_version),  json_object('status',NEW.status,'slotId',NEW.slot_id,'version',OLD.lock_version+1),  strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')  FROM events e JOIN event_slots s ON s.id=NEW.slot_id JOIN friends f ON f.id=NEW.friend_id WHERE e.id=NEW.event_id; END;

CREATE TRIGGER event_entitlement_confirm AFTER UPDATE OF status ON event_bookings WHEN NEW.status='confirmed' AND OLD.status='requested' BEGIN UPDATE event_booking_entitlement_uses SET consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_booking_id=NEW.id AND consumed_at IS NULL; END;

CREATE TRIGGER event_entitlement_consume AFTER UPDATE OF consumed_at ON event_booking_entitlement_uses WHEN OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL BEGIN UPDATE booking_entitlements SET remaining=CASE WHEN kind='ticket' THEN remaining-1 ELSE NULL END,version=version+1,updated_at=NEW.consumed_at WHERE id=NEW.entitlement_id; INSERT INTO booking_entitlement_events(id,entitlement_id,line_account_id,action,reason,actor_type,actor_id,request_key,request_json,after_json,created_at) SELECT lower(hex(randomblob(16))),e.id,e.line_account_id,'consume','クラスの確定による1回利用','system',NEW.event_booking_id_history,'event-consume:'||NEW.event_booking_id_history,json_object('eventBookingId',NEW.event_booking_id_history),json_object('remaining',e.remaining,'version',e.version),NEW.consumed_at FROM booking_entitlements e WHERE e.id=NEW.entitlement_id; END;

CREATE TRIGGER event_entitlement_consume_guard BEFORE UPDATE OF consumed_at ON event_booking_entitlement_uses WHEN OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM event_bookings b JOIN event_slots s ON s.id=b.slot_id JOIN events ev ON ev.id=b.event_id AND ev.line_account_id=b.line_account_id  JOIN booking_entitlements e ON e.id=NEW.entitlement_id JOIN booking_pass_plans p ON p.id=e.plan_id  WHERE b.id=NEW.event_booking_id AND b.line_account_id=NEW.line_account_id AND e.line_account_id=b.line_account_id AND p.line_account_id=b.line_account_id  AND e.friend_id=b.friend_id AND e.menu_id IS NULL AND e.status='active' AND (EXISTS(SELECT 1 FROM booking_monthly_rights mr WHERE mr.entitlement_id=e.id) OR (e.billing_status<>'stopped' AND NOT(e.billing_status='grace' AND julianday(e.grace_until)<=julianday('now'))))  AND b.party_size=1 AND b.event_id=NEW.event_id AND b.slot_id=NEW.slot_id AND julianday(s.starts_at)=julianday(NEW.starts_at)  AND julianday(s.starts_at)>=julianday(e.valid_from) AND julianday(s.starts_at)<julianday(e.expires_at)  AND julianday(s.starts_at)>=julianday(NEW.period_start) AND julianday(s.starts_at)<julianday(NEW.period_end)  AND (EXISTS(SELECT 1 FROM booking_monthly_rights mr WHERE mr.entitlement_id=e.id) OR (p.event_target_scope_json IS NOT NULL AND (json_array_length(p.event_target_scope_json)=0 OR EXISTS(SELECT 1 FROM json_each(p.event_target_scope_json) WHERE value=b.event_id)))) AND b.status='confirmed' AND (e.kind='ticket' AND e.remaining>0 OR e.kind='monthly' AND (COALESCE((SELECT allowance FROM booking_entitlement_month_limits ml WHERE ml.entitlement_id=e.id AND ml.period_start=NEW.period_start),e.monthly_limit) IS NULL OR ((SELECT COUNT(*) FROM booking_entitlement_uses u JOIN bookings b ON b.id=u.booking_id WHERE u.entitlement_id=e.id AND u.consumed_at IS NOT NULL AND u.returned_at IS NULL AND julianday(b.starts_at)>=julianday(NEW.period_start) AND julianday(b.starts_at)<julianday(NEW.period_end)) + (SELECT COUNT(*) FROM event_booking_entitlement_uses u WHERE u.entitlement_id=e.id AND u.consumed_at IS NOT NULL AND u.returned_at IS NULL AND julianday(u.starts_at)>=julianday(NEW.period_start) AND julianday(u.starts_at)<julianday(NEW.period_end)))<COALESCE((SELECT allowance FROM booking_entitlement_month_limits ml WHERE ml.entitlement_id=e.id AND ml.period_start=NEW.period_start),e.monthly_limit)))) THEN RAISE(ABORT,'entitlement_unavailable') END; END;

CREATE TRIGGER event_entitlement_immediate AFTER INSERT ON event_booking_entitlement_uses WHEN (SELECT status FROM event_bookings WHERE id=NEW.event_booking_id)='confirmed' BEGIN UPDATE event_booking_entitlement_uses SET consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_booking_id=NEW.event_booking_id AND consumed_at IS NULL; END;

CREATE TRIGGER event_entitlement_month_change BEFORE UPDATE OF starts_at ON event_slots WHEN EXISTS(SELECT 1 FROM event_booking_entitlement_uses u JOIN booking_entitlements e ON e.id=u.entitlement_id WHERE u.slot_id=NEW.id AND u.returned_at IS NULL AND (julianday(NEW.starts_at)<julianday(e.valid_from) OR julianday(NEW.starts_at)>=julianday(e.expires_at) OR e.kind='monthly' AND (julianday(NEW.starts_at)<julianday(u.period_start) OR julianday(NEW.starts_at)>=julianday(u.period_end)))) BEGIN SELECT RAISE(ABORT,'entitlement_month_change'); END;

CREATE TRIGGER event_entitlement_return AFTER UPDATE OF returned_at ON event_booking_entitlement_uses WHEN OLD.returned_at IS NULL AND NEW.returned_at IS NOT NULL AND NEW.consumed_at IS NOT NULL BEGIN UPDATE booking_entitlements SET remaining=CASE WHEN kind='ticket' THEN remaining+1 ELSE NULL END,version=version+1,updated_at=NEW.returned_at WHERE id=NEW.entitlement_id; INSERT INTO booking_entitlement_events(id,entitlement_id,line_account_id,action,reason,actor_type,actor_id,request_key,request_json,after_json,created_at) SELECT lower(hex(randomblob(16))),e.id,e.line_account_id,'adjust','クラスの取消で戻した','system',NEW.event_booking_id_history,'event-return:'||NEW.event_booking_id_history,json_object('eventBookingId',NEW.event_booking_id_history),json_object('remaining',e.remaining,'version',e.version),NEW.returned_at FROM booking_entitlements e WHERE e.id=NEW.entitlement_id; END;

CREATE TRIGGER event_entitlement_selection BEFORE INSERT ON event_booking_entitlement_uses BEGIN SELECT CASE WHEN NEW.consumed_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM event_bookings b JOIN event_slots s ON s.id=b.slot_id JOIN events ev ON ev.id=b.event_id AND ev.line_account_id=b.line_account_id  JOIN booking_entitlements e ON e.id=NEW.entitlement_id JOIN booking_pass_plans p ON p.id=e.plan_id  WHERE b.id=NEW.event_booking_id AND b.line_account_id=NEW.line_account_id AND e.line_account_id=b.line_account_id AND p.line_account_id=b.line_account_id  AND e.friend_id=b.friend_id AND e.menu_id IS NULL AND e.status='active' AND (EXISTS(SELECT 1 FROM booking_monthly_rights mr WHERE mr.entitlement_id=e.id) OR (e.billing_status<>'stopped' AND NOT(e.billing_status='grace' AND julianday(e.grace_until)<=julianday('now'))))  AND b.party_size=1 AND b.event_id=NEW.event_id AND b.slot_id=NEW.slot_id AND julianday(s.starts_at)=julianday(NEW.starts_at)  AND julianday(s.starts_at)>=julianday(e.valid_from) AND julianday(s.starts_at)<julianday(e.expires_at)  AND julianday(s.starts_at)>=julianday(NEW.period_start) AND julianday(s.starts_at)<julianday(NEW.period_end)  AND (EXISTS(SELECT 1 FROM booking_monthly_rights mr WHERE mr.entitlement_id=e.id) OR (p.event_target_scope_json IS NOT NULL AND (json_array_length(p.event_target_scope_json)=0 OR EXISTS(SELECT 1 FROM json_each(p.event_target_scope_json) WHERE value=b.event_id)))) AND b.status IN('requested','confirmed')) THEN RAISE(ABORT,'entitlement_unavailable') END; END;

CREATE TRIGGER event_entitlement_slot_snapshot AFTER UPDATE OF starts_at ON event_slots BEGIN UPDATE event_booking_entitlement_uses SET starts_at=NEW.starts_at,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE slot_id=NEW.id AND returned_at IS NULL; END;

CREATE TRIGGER event_entitlement_transfer BEFORE UPDATE OF event_booking_id,slot_id,starts_at,period_start,period_end ON event_booking_entitlement_uses WHEN NEW.event_booking_id IS NOT NULL AND NEW.event_booking_id IS NOT OLD.event_booking_id BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM event_bookings b JOIN event_slots s ON s.id=b.slot_id JOIN events ev ON ev.id=b.event_id AND ev.line_account_id=b.line_account_id  JOIN booking_entitlements e ON e.id=NEW.entitlement_id JOIN booking_pass_plans p ON p.id=e.plan_id  WHERE b.id=NEW.event_booking_id AND b.line_account_id=NEW.line_account_id AND e.line_account_id=b.line_account_id AND p.line_account_id=b.line_account_id  AND e.friend_id=b.friend_id AND e.menu_id IS NULL AND e.status='active' AND (EXISTS(SELECT 1 FROM booking_monthly_rights mr WHERE mr.entitlement_id=e.id) OR (e.billing_status<>'stopped' AND NOT(e.billing_status='grace' AND julianday(e.grace_until)<=julianday('now'))))  AND b.party_size=1 AND b.event_id=NEW.event_id AND b.slot_id=NEW.slot_id AND julianday(s.starts_at)=julianday(NEW.starts_at)  AND julianday(s.starts_at)>=julianday(e.valid_from) AND julianday(s.starts_at)<julianday(e.expires_at)  AND julianday(s.starts_at)>=julianday(NEW.period_start) AND julianday(s.starts_at)<julianday(NEW.period_end)  AND (EXISTS(SELECT 1 FROM booking_monthly_rights mr WHERE mr.entitlement_id=e.id) OR (p.event_target_scope_json IS NOT NULL AND (json_array_length(p.event_target_scope_json)=0 OR EXISTS(SELECT 1 FROM json_each(p.event_target_scope_json) WHERE value=b.event_id)))) AND b.status IN('requested','confirmed') AND (e.kind='ticket' OR COALESCE((SELECT allowance FROM booking_entitlement_month_limits ml WHERE ml.entitlement_id=e.id AND ml.period_start=NEW.period_start),e.monthly_limit) IS NULL OR ((SELECT COUNT(*) FROM booking_entitlement_uses u JOIN bookings b ON b.id=u.booking_id WHERE u.entitlement_id=e.id AND u.consumed_at IS NOT NULL AND u.returned_at IS NULL AND julianday(b.starts_at)>=julianday(NEW.period_start) AND julianday(b.starts_at)<julianday(NEW.period_end)) + (SELECT COUNT(*) FROM event_booking_entitlement_uses u WHERE u.entitlement_id=e.id AND u.event_booking_id_history<>OLD.event_booking_id_history AND u.consumed_at IS NOT NULL AND u.returned_at IS NULL AND julianday(u.starts_at)>=julianday(NEW.period_start) AND julianday(u.starts_at)<julianday(NEW.period_end)))<COALESCE((SELECT allowance FROM booking_entitlement_month_limits ml WHERE ml.entitlement_id=e.id AND ml.period_start=NEW.period_start),e.monthly_limit))) THEN RAISE(ABORT,'entitlement_unavailable') END; END;

CREATE TRIGGER event_payment_scope_insert BEFORE INSERT ON event_payment_settings
WHEN NOT EXISTS(SELECT 1 FROM events e WHERE e.id=NEW.event_id AND e.line_account_id=NEW.line_account_id)
BEGIN SELECT RAISE(ABORT,'event_payment_scope_mismatch'); END;

CREATE TRIGGER event_payment_scope_update BEFORE UPDATE ON event_payment_settings
WHEN NOT EXISTS(SELECT 1 FROM events e WHERE e.id=NEW.event_id AND e.line_account_id=NEW.line_account_id)
BEGIN SELECT RAISE(ABORT,'event_payment_scope_mismatch'); END;

CREATE TRIGGER event_slot_transition_generations AFTER UPDATE OF starts_at,ends_at ON event_slots WHEN NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at BEGIN  UPDATE event_bookings SET lock_version=lock_version+1 WHERE slot_id=NEW.id AND status IN('requested','confirmed');  INSERT INTO event_booking_transition_runs  (id,line_account_id,event_id,booking_id,booking_id_history,expected_booking_version,booking_version,event_version,operation_key,action,input_snapshot,before_json,after_json,created_at,updated_at)  SELECT lower(hex(randomblob(16))),b.line_account_id,b.event_id,b.id,b.id,b.lock_version-1,b.lock_version,e.current_published_version_id,  'event-transition:'||b.id||':'||b.lock_version,'schedule_changed',  json_object('friendId',b.friend_id,'recipient',f.line_user_id,'slotId',b.slot_id,'startsAt',NEW.starts_at,'status',b.status,'eventName',e.name,'venueName',e.venue_name,'venueUrl',e.venue_url),  json_object('startsAt',OLD.starts_at,'endsAt',OLD.ends_at,'version',b.lock_version-1),  json_object('startsAt',NEW.starts_at,'endsAt',NEW.ends_at,'version',b.lock_version),  strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')  FROM event_bookings b JOIN events e ON e.id=b.event_id JOIN friends f ON f.id=b.friend_id  WHERE b.slot_id=NEW.id AND b.status IN('requested','confirmed'); END;

CREATE TRIGGER event_venue_transition_generations AFTER UPDATE OF venue_name,venue_url ON events WHEN NEW.venue_name IS NOT OLD.venue_name OR NEW.venue_url IS NOT OLD.venue_url BEGIN  UPDATE event_bookings SET lock_version=lock_version+1 WHERE event_id=NEW.id AND status IN('requested','confirmed');  INSERT INTO event_booking_transition_runs  (id,line_account_id,event_id,booking_id,booking_id_history,expected_booking_version,booking_version,event_version,operation_key,action,input_snapshot,before_json,after_json,created_at,updated_at)  SELECT lower(hex(randomblob(16))),b.line_account_id,b.event_id,b.id,b.id,b.lock_version-1,b.lock_version,e.current_published_version_id,  'event-transition:'||b.id||':'||b.lock_version,'schedule_changed',  json_object('friendId',b.friend_id,'recipient',f.line_user_id,'slotId',b.slot_id,'startsAt',s.starts_at,'status',b.status,'eventName',e.name,'venueName',e.venue_name,'venueUrl',e.venue_url),  json_object('venueName',OLD.venue_name,'venueUrl',OLD.venue_url,'version',b.lock_version-1),  json_object('venueName',NEW.venue_name,'venueUrl',NEW.venue_url,'version',b.lock_version),  strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')  FROM event_bookings b JOIN events e ON e.id=b.event_id JOIN event_slots s ON s.id=b.slot_id JOIN friends f ON f.id=b.friend_id  WHERE b.event_id=NEW.id AND b.status IN('requested','confirmed'); END;

CREATE TRIGGER fixed_friend_field_definition_guard BEFORE UPDATE ON friend_fields WHEN EXISTS(SELECT 1 FROM friend_fixed_fields WHERE field_id=OLD.id) AND (NEW.name IS NOT OLD.name OR NEW.field_key IS NOT OLD.field_key OR NEW.type IS NOT OLD.type OR NEW.type_v6 IS NOT OLD.type_v6 OR NEW.type_v8 IS NOT OLD.type_v8 OR NEW.folder_id IS NOT NULL OR NEW.is_personal<>1 OR NEW.ec_is_master<>0 OR NEW.status<>'active') BEGIN SELECT RAISE(ABORT,'FIXED_FRIEND_FIELD_IMMUTABLE'); END;

CREATE TRIGGER fixed_name_friend_insert AFTER INSERT ON friends
WHEN NEW.real_name IS NOT NULL AND TRIM(NEW.real_name) <> ''
BEGIN   INSERT INTO friend_field_values (friend_id, field_id, value, updated_by, updated_at)
  VALUES (NEW.id, 'fixed-name', NEW.real_name, 'manual', NEW.updated_at); END;

CREATE TRIGGER fixed_name_friend_update AFTER UPDATE OF real_name ON friends
WHEN OLD.real_name IS NOT NEW.real_name
BEGIN   DELETE FROM friend_field_values WHERE friend_id = NEW.id AND field_id = 'fixed-name'
    AND (NEW.real_name IS NULL OR TRIM(NEW.real_name) = '');   INSERT INTO friend_field_values (friend_id, field_id, value, updated_by, updated_at, source_type, source_id)
  SELECT NEW.id, 'fixed-name', NEW.real_name, 'manual', NEW.updated_at, NULL, NULL
  WHERE NEW.real_name IS NOT NULL AND TRIM(NEW.real_name) <> ''
  ON CONFLICT(friend_id, field_id) DO UPDATE SET value = excluded.value,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at, source_type = NULL, source_id = NULL
  WHERE friend_field_values.value IS NOT excluded.value; END;

CREATE TRIGGER fixed_name_value_delete AFTER DELETE ON friend_field_values
WHEN OLD.field_id = 'fixed-name'
BEGIN   UPDATE friends SET real_name = NULL WHERE id = OLD.friend_id AND real_name IS NOT NULL; END;

CREATE TRIGGER fixed_name_value_insert AFTER INSERT ON friend_field_values
WHEN NEW.field_id = 'fixed-name'
BEGIN   UPDATE friends SET real_name = NEW.value, updated_at = NEW.updated_at
  WHERE id = NEW.friend_id AND real_name IS NOT NEW.value; END;

CREATE TRIGGER fixed_name_value_update AFTER UPDATE OF value ON friend_field_values
WHEN NEW.field_id = 'fixed-name'
BEGIN   UPDATE friends SET real_name = NEW.value, updated_at = NEW.updated_at
  WHERE id = NEW.friend_id AND real_name IS NOT NEW.value; END;

CREATE TRIGGER folders_friend_add_rename AFTER UPDATE OF name ON folders WHEN NEW.kind='friend_add_rule' AND NEW.name IS NOT OLD.name BEGIN UPDATE friend_add_rules SET folder_name=NEW.name,lock_version=lock_version+1,updated_at=NEW.updated_at WHERE folder_id=NEW.id AND line_account_id=NEW.account_id; END;

CREATE TRIGGER folders_friend_add_rule_legacy_delete AFTER DELETE ON folders WHEN OLD.kind='friend_add_rule' BEGIN DELETE FROM friend_add_rule_folders WHERE id=OLD.id AND line_account_id=OLD.account_id; END;

CREATE TRIGGER folders_friend_add_rule_legacy_insert AFTER INSERT ON folders WHEN NEW.kind='friend_add_rule' BEGIN INSERT OR IGNORE INTO friend_add_rule_folders(id,line_account_id,name,color,created_at,updated_at,create_idempotency_key,created_by_staff_id) VALUES(NEW.id,NEW.account_id,NEW.name,NEW.color,NEW.created_at,NEW.updated_at,'common-'||NEW.id,'folder-api'); END;

CREATE TRIGGER folders_friend_add_rule_legacy_update AFTER UPDATE ON folders WHEN NEW.kind='friend_add_rule' BEGIN UPDATE friend_add_rule_folders SET name=NEW.name,color=NEW.color,updated_at=NEW.updated_at WHERE id=NEW.id AND line_account_id=NEW.account_id AND (name IS NOT NEW.name OR color IS NOT NEW.color); END;

CREATE TRIGGER folders_mileage_reward_legacy_delete AFTER DELETE ON folders WHEN OLD.kind='mileage_reward' BEGIN DELETE FROM mileage_reward_folders WHERE id=OLD.id AND line_account_id=OLD.account_id; END;

CREATE TRIGGER folders_mileage_reward_legacy_insert AFTER INSERT ON folders WHEN NEW.kind='mileage_reward' BEGIN INSERT OR IGNORE INTO mileage_reward_folders(id,line_account_id,name,display_order,created_at,updated_at) VALUES(NEW.id,NEW.account_id,NEW.name,NEW.display_order,NEW.created_at,NEW.updated_at); END;

CREATE TRIGGER folders_mileage_reward_legacy_update AFTER UPDATE ON folders WHEN NEW.kind='mileage_reward' BEGIN UPDATE mileage_reward_folders SET name=NEW.name,display_order=NEW.display_order,updated_at=NEW.updated_at WHERE id=NEW.id AND line_account_id=NEW.account_id AND (name IS NOT NEW.name OR display_order IS NOT NEW.display_order); END;

CREATE TRIGGER friend_add_rule_folders_common_delete AFTER DELETE ON friend_add_rule_folders BEGIN DELETE FROM folders WHERE id=OLD.id AND kind='friend_add_rule' AND account_id=OLD.line_account_id; END;

CREATE TRIGGER friend_add_rule_folders_common_insert AFTER INSERT ON friend_add_rule_folders WHEN NOT EXISTS(SELECT 1 FROM folders WHERE id=NEW.id) BEGIN INSERT INTO folders(id,kind,account_id,name,color,created_at,updated_at) VALUES(NEW.id,'friend_add_rule',NEW.line_account_id,NEW.name,NEW.color,NEW.created_at,NEW.updated_at); END;

CREATE TRIGGER friend_add_rule_folders_common_update AFTER UPDATE ON friend_add_rule_folders WHEN EXISTS(SELECT 1 FROM folders WHERE id=NEW.id AND (name IS NOT NEW.name OR color IS NOT NEW.color)) BEGIN UPDATE folders SET name=NEW.name,color=NEW.color,revision=revision+1,updated_at=NEW.updated_at WHERE id=NEW.id AND kind='friend_add_rule' AND account_id=NEW.line_account_id; END;

CREATE TRIGGER friend_add_rules_folder_id_insert AFTER INSERT ON friend_add_rules WHEN NEW.folder_id IS NOT NULL BEGIN UPDATE friend_add_rules SET folder_name=(SELECT name FROM folders WHERE id=NEW.folder_id) WHERE id=NEW.id AND folder_name IS NOT (SELECT name FROM folders WHERE id=NEW.folder_id); END;

CREATE TRIGGER friend_add_rules_folder_id_update AFTER UPDATE OF folder_id ON friend_add_rules WHEN NEW.folder_id IS NOT OLD.folder_id BEGIN UPDATE friend_add_rules SET folder_name=(SELECT name FROM folders WHERE id=NEW.folder_id),lock_version=lock_version+1 WHERE id=NEW.id AND folder_name IS NOT (SELECT name FROM folders WHERE id=NEW.folder_id); END;

CREATE TRIGGER friend_add_rules_folder_insert BEFORE INSERT ON friend_add_rules WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM folders WHERE id=NEW.folder_id AND kind='friend_add_rule' AND account_id=NEW.line_account_id) BEGIN SELECT RAISE(ABORT,'folder_assignment_invalid'); END;

CREATE TRIGGER friend_add_rules_folder_name_insert AFTER INSERT ON friend_add_rules WHEN NEW.folder_name IS NOT NULL AND NEW.folder_id IS NULL BEGIN INSERT OR IGNORE INTO folders(id,kind,account_id,name) SELECT 'friend-add-name-'||hex(NEW.line_account_id)||'-'||hex(NEW.folder_name)||'-'||lower(hex(randomblob(8))),'friend_add_rule',NEW.line_account_id,NEW.folder_name WHERE NOT EXISTS(SELECT 1 FROM folders WHERE kind='friend_add_rule' AND account_id=NEW.line_account_id AND name=NEW.folder_name); UPDATE friend_add_rules SET folder_id=(SELECT id FROM folders WHERE kind='friend_add_rule' AND account_id=NEW.line_account_id AND name=NEW.folder_name) WHERE id=NEW.id; END;

CREATE TRIGGER friend_add_rules_folder_name_update AFTER UPDATE OF folder_name ON friend_add_rules WHEN NEW.folder_name IS NOT OLD.folder_name BEGIN INSERT INTO folders(id,kind,account_id,name) SELECT 'friend-add-name-'||hex(NEW.line_account_id)||'-'||hex(NEW.folder_name)||'-'||lower(hex(randomblob(8))),'friend_add_rule',NEW.line_account_id,NEW.folder_name WHERE NEW.folder_name IS NOT NULL AND NOT EXISTS (SELECT 1 FROM folders WHERE kind='friend_add_rule' AND account_id=NEW.line_account_id AND name=NEW.folder_name); UPDATE friend_add_rules SET folder_id=(SELECT id FROM folders WHERE kind='friend_add_rule' AND account_id=NEW.line_account_id AND name=NEW.folder_name) WHERE id=NEW.id; END;

CREATE TRIGGER friend_add_rules_folder_update BEFORE UPDATE OF folder_id,line_account_id ON friend_add_rules WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM folders WHERE id=NEW.folder_id AND kind='friend_add_rule' AND account_id=NEW.line_account_id) BEGIN SELECT RAISE(ABORT,'folder_assignment_invalid'); END;

CREATE TRIGGER friend_delivery_consents_audit_delete AFTER DELETE ON friend_delivery_consents BEGIN  INSERT INTO friend_delivery_consent_events(line_account_id,friend_id,purpose,operation,before_json)  VALUES(OLD.line_account_id,OLD.friend_id,OLD.purpose,'delete',json_object('state',OLD.state,'reason',OLD.reason,'source',OLD.source,'updatedBy',OLD.updated_by,'updatedAt',OLD.updated_at,'version',OLD.version)); END;

CREATE TRIGGER friend_delivery_consents_audit_insert AFTER INSERT ON friend_delivery_consents BEGIN  INSERT INTO friend_delivery_consent_events(line_account_id,friend_id,purpose,operation,after_json)  VALUES(NEW.line_account_id,NEW.friend_id,NEW.purpose,'insert',json_object('state',NEW.state,'reason',NEW.reason,'source',NEW.source,'updatedBy',NEW.updated_by,'updatedAt',NEW.updated_at,'version',NEW.version)); END;

CREATE TRIGGER friend_delivery_consents_audit_update AFTER UPDATE ON friend_delivery_consents BEGIN  INSERT INTO friend_delivery_consent_events(line_account_id,friend_id,purpose,operation,before_json,after_json)  VALUES(NEW.line_account_id,NEW.friend_id,NEW.purpose,'update',json_object('state',OLD.state,'reason',OLD.reason,'source',OLD.source,'updatedBy',OLD.updated_by,'updatedAt',OLD.updated_at,'version',OLD.version),json_object('state',NEW.state,'reason',NEW.reason,'source',NEW.source,'updatedBy',NEW.updated_by,'updatedAt',NEW.updated_at,'version',NEW.version)); END;

CREATE TRIGGER friend_delivery_consents_scope_insert BEFORE INSERT ON friend_delivery_consents BEGIN  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM friends WHERE id=NEW.friend_id AND line_account_id=NEW.line_account_id)  THEN RAISE(ABORT,'delivery_consent_scope') END; END;

CREATE TRIGGER friend_delivery_consents_scope_update BEFORE UPDATE ON friend_delivery_consents BEGIN  SELECT CASE WHEN NEW.line_account_id<>OLD.line_account_id OR NEW.friend_id<>OLD.friend_id OR NEW.purpose<>OLD.purpose  OR NOT EXISTS(SELECT 1 FROM friends WHERE id=NEW.friend_id AND line_account_id=NEW.line_account_id)  THEN RAISE(ABORT,'delivery_consent_scope') END; END;

CREATE TRIGGER friend_field_value_source_clear AFTER UPDATE OF value, updated_by, updated_at ON friend_field_values
WHEN NEW.updated_by IS NOT 'form' AND NEW.source_type = 'form'
BEGIN   UPDATE friend_field_values SET source_type = NULL, source_id = NULL
  WHERE friend_id = NEW.friend_id AND field_id = NEW.field_id; END;

CREATE TRIGGER friends_issue_member_number AFTER INSERT ON friends WHEN NEW.member_number IS NULL BEGIN
 UPDATE friends SET member_number=upper(hex(randomblob(8))) WHERE id=NEW.id; END;

CREATE TRIGGER hq_attribute_skip_insert BEFORE INSERT ON hq_template_preflight_resolutions
WHEN NEW.friend_attribute_mode IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM hq_templates t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id
    AND t.friend_attribute_type=NEW.item_kind)
BEGIN SELECT RAISE(ABORT,'HQ_ATTRIBUTE_SKIP_INVALID'); END;

CREATE TRIGGER hq_attribute_skip_update BEFORE UPDATE ON hq_template_preflight_resolutions
WHEN NEW.friend_attribute_mode IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM hq_templates t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id
    AND t.friend_attribute_type=NEW.item_kind)
BEGIN SELECT RAISE(ABORT,'HQ_ATTRIBUTE_SKIP_INVALID'); END;

CREATE TRIGGER hq_store_first_response_sample AFTER UPDATE OF first_response_at ON chats WHEN NEW.first_response_at IS NOT NULL AND NEW.pending_since IS NOT NULL AND julianday(NEW.first_response_at)>=julianday(NEW.pending_since) BEGIN INSERT OR IGNORE INTO hq_store_response_samples(account_id,chat_id,pending_since,responded_at,minutes) SELECT f.line_account_id,NEW.id,NEW.pending_since,NEW.first_response_at,(julianday(NEW.first_response_at)-julianday(NEW.pending_since))*1440 FROM friends f WHERE f.id=NEW.friend_id AND f.line_account_id IS NOT NULL; END;

CREATE TRIGGER hq_template_binding_guard
BEFORE UPDATE ON hq_templates
WHEN NEW.id != OLD.id
  OR NEW.tenant_id != OLD.tenant_id
  OR NEW.template_type != OLD.template_type
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_BINDING_IMMUTABLE'); END;

CREATE TRIGGER hq_template_catalog_insert BEFORE INSERT ON hq_templates WHEN NEW.catalog_type IS NOT NULL AND (NEW.template_type<>'template' OR NEW.extended_type IS NOT NULL OR NEW.friend_attribute_type IS NOT NULL OR NEW.delivery_type IS NOT NULL) BEGIN SELECT RAISE(ABORT,'HQ_TYPE_INVALID'); END;

CREATE TRIGGER hq_template_catalog_update BEFORE UPDATE ON hq_templates WHEN NEW.catalog_type IS NOT OLD.catalog_type OR (NEW.catalog_type IS NOT NULL AND (NEW.template_type<>'template' OR NEW.extended_type IS NOT NULL OR NEW.friend_attribute_type IS NOT NULL OR NEW.delivery_type IS NOT NULL)) BEGIN SELECT RAISE(ABORT,'HQ_TYPE_IMMUTABLE'); END;

CREATE TRIGGER hq_template_delivery_insert BEFORE INSERT ON hq_templates
WHEN NEW.delivery_type IS NOT NULL AND
  (NEW.template_type!='template' OR NEW.extended_type IS NOT NULL OR NEW.friend_attribute_type IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'HQ_TYPE_INVALID'); END;

CREATE TRIGGER hq_template_delivery_update BEFORE UPDATE ON hq_templates
WHEN NEW.delivery_type IS NOT OLD.delivery_type OR
  (NEW.delivery_type IS NOT NULL AND (NEW.template_type!='template' OR NEW.extended_type IS NOT NULL OR NEW.friend_attribute_type IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'HQ_TYPE_IMMUTABLE'); END;

CREATE TRIGGER hq_template_extended_type_insert BEFORE INSERT ON hq_templates
WHEN NEW.extended_type IS NOT NULL AND NEW.template_type!='template'
BEGIN SELECT RAISE(ABORT,'HQ_TYPE_INVALID'); END;

CREATE TRIGGER hq_template_extended_type_update BEFORE UPDATE OF extended_type ON hq_templates
WHEN NEW.extended_type IS NOT OLD.extended_type
BEGIN SELECT RAISE(ABORT,'HQ_TYPE_IMMUTABLE'); END;

CREATE TRIGGER hq_template_folder_insert BEFORE INSERT ON hq_templates
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hq_template_folders WHERE id=NEW.folder_id AND tenant_id=NEW.tenant_id AND archived_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'HQ_FOLDER_SCOPE_INVALID'); END;

CREATE TRIGGER hq_template_folder_update BEFORE UPDATE OF folder_id, tenant_id ON hq_templates
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hq_template_folders WHERE id=NEW.folder_id AND tenant_id=NEW.tenant_id AND archived_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'HQ_FOLDER_SCOPE_INVALID'); END;

CREATE TRIGGER hq_template_friend_attribute_insert BEFORE INSERT ON hq_templates
WHEN NEW.friend_attribute_type IS NOT NULL
  AND (NEW.template_type!='tag' OR NEW.extended_type IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'HQ_TYPE_INVALID'); END;

CREATE TRIGGER hq_template_friend_attribute_update BEFORE UPDATE OF friend_attribute_type ON hq_templates
WHEN NEW.friend_attribute_type IS NOT OLD.friend_attribute_type
BEGIN SELECT RAISE(ABORT,'HQ_TYPE_IMMUTABLE'); END;

CREATE TRIGGER hq_template_logical_archive_only
BEFORE DELETE ON hq_templates
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_USE_LOGICAL_ARCHIVE'); END;

CREATE TRIGGER hq_template_preflight_binding_guard
BEFORE UPDATE ON hq_template_preflights
WHEN NEW.id != OLD.id
  OR NEW.tenant_id != OLD.tenant_id
  OR NEW.template_id != OLD.template_id
  OR NEW.template_version_id != OLD.template_version_id
  OR NEW.target_account_id != OLD.target_account_id
  OR NEW.distribution_mode != OLD.distribution_mode
  OR NEW.idempotency_fingerprint != OLD.idempotency_fingerprint
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_PREFLIGHT_BINDING_IMMUTABLE'); END;

CREATE TRIGGER hq_template_preflight_terminal_guard
BEFORE UPDATE ON hq_template_preflights
WHEN OLD.status IN ('expired', 'consumed') AND NEW.status != OLD.status
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_PREFLIGHT_TERMINAL'); END;

CREATE TRIGGER hq_template_r2_binding_guard
BEFORE UPDATE ON hq_template_owned_r2_keys
WHEN NEW.run_id != OLD.run_id
  OR NEW.tenant_id != OLD.tenant_id
  OR NEW.target_account_id != OLD.target_account_id
  OR NEW.object_key != OLD.object_key
  OR NEW.owner_token != OLD.owner_token
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_R2_BINDING_IMMUTABLE'); END;

CREATE TRIGGER hq_template_r2_no_delete
BEFORE DELETE ON hq_template_owned_r2_keys
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_R2_RECOVERY_LEDGER_IMMUTABLE'); END;

CREATE TRIGGER hq_template_r2_state_guard
BEFORE UPDATE OF state ON hq_template_owned_r2_keys
WHEN NOT (
  NEW.state = OLD.state
  OR (OLD.state = 'staged' AND NEW.state IN ('committed', 'cleanup_pending'))
  OR (OLD.state = 'committed' AND NEW.state = 'reconciled')
  OR (OLD.state = 'cleanup_pending' AND NEW.state IN ('cleaned', 'reconciled'))
)
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_R2_INVALID_TRANSITION'); END;

CREATE TRIGGER hq_template_result_binding_guard
BEFORE UPDATE ON hq_template_distribution_results
WHEN NEW.tenant_id != OLD.tenant_id
  OR NEW.run_id != OLD.run_id
  OR NEW.template_id != OLD.template_id
  OR NEW.template_version_id != OLD.template_version_id
  OR NEW.target_account_id != OLD.target_account_id
  OR NEW.preflight_id != OLD.preflight_id
  OR NEW.idempotency_fingerprint != OLD.idempotency_fingerprint
  OR NEW.snapshot_token != OLD.snapshot_token
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_RESULT_BINDING_IMMUTABLE'); END;

CREATE TRIGGER hq_template_result_consume_preflight
AFTER INSERT ON hq_template_distribution_results
BEGIN UPDATE hq_template_preflights SET status = 'consumed' WHERE id = NEW.preflight_id AND tenant_id = NEW.tenant_id AND template_id = NEW.template_id AND template_version_id = NEW.template_version_id AND target_account_id = NEW.target_account_id AND idempotency_fingerprint = NEW.idempotency_fingerprint AND snapshot_token = NEW.snapshot_token AND status = 'ready'; SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'HQ_TEMPLATE_PREFLIGHT_NOT_CONSUMED') END; END;

CREATE TRIGGER hq_template_result_no_delete
BEFORE DELETE ON hq_template_distribution_results
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_RESULT_RECOVERY_LEDGER_IMMUTABLE'); END;

CREATE TRIGGER hq_template_result_terminal_guard
BEFORE UPDATE OF status ON hq_template_distribution_results
WHEN OLD.status IN ('succeeded', 'version_conflict', 'unsupported') AND NEW.status != OLD.status
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_RESULT_TERMINAL'); END;

CREATE TRIGGER hq_template_run_binding_guard
BEFORE UPDATE ON hq_template_distribution_runs
WHEN NEW.id != OLD.id
  OR NEW.tenant_id != OLD.tenant_id
  OR NEW.template_id != OLD.template_id
  OR NEW.template_version_id != OLD.template_version_id
  OR NEW.idempotency_fingerprint != OLD.idempotency_fingerprint
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_RUN_BINDING_IMMUTABLE'); END;

CREATE TRIGGER hq_template_run_no_delete
BEFORE DELETE ON hq_template_distribution_runs
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_RUN_RECOVERY_LEDGER_IMMUTABLE'); END;

CREATE TRIGGER hq_template_run_terminal_guard
BEFORE UPDATE OF status ON hq_template_distribution_runs
WHEN OLD.status != 'running' AND NEW.status != OLD.status
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_RUN_TERMINAL'); END;

CREATE TRIGGER hq_template_text_override_immutable BEFORE UPDATE OF text_override ON hq_template_preflights
WHEN NEW.text_override IS NOT OLD.text_override
BEGIN SELECT RAISE(ABORT,'HQ_TEXT_OVERRIDE_IMMUTABLE'); END;

CREATE TRIGGER hq_template_version_binding_guard
BEFORE UPDATE ON hq_template_versions
WHEN NEW.id != OLD.id
  OR NEW.template_id != OLD.template_id
  OR NEW.tenant_id != OLD.tenant_id
  OR NEW.version != OLD.version
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_VERSION_BINDING_IMMUTABLE'); END;

CREATE TRIGGER incoming_webhooks_folder_delete AFTER DELETE ON folders
BEGIN UPDATE incoming_webhooks SET folder_id = NULL WHERE folder_id = OLD.id; END;

CREATE TRIGGER incoming_webhooks_folder_insert BEFORE INSERT ON incoming_webhooks
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM folders WHERE id = NEW.folder_id AND kind = 'webhook' AND account_id = NEW.line_account_id
) BEGIN SELECT RAISE(ABORT, 'folder_assignment_invalid'); END;

CREATE TRIGGER incoming_webhooks_folder_update BEFORE UPDATE OF folder_id, line_account_id ON incoming_webhooks
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM folders WHERE id = NEW.folder_id AND kind = 'webhook' AND account_id = NEW.line_account_id
) BEGIN SELECT RAISE(ABORT, 'folder_assignment_invalid'); END;

CREATE TRIGGER instagram_connection_tenant_insert BEFORE INSERT ON instagram_connections WHEN EXISTS(SELECT 1 FROM instagram_connections existing JOIN line_accounts old_account ON old_account.id=existing.line_account_id JOIN line_accounts new_account ON new_account.id=NEW.line_account_id WHERE existing.instagram_id=NEW.instagram_id AND existing.line_account_id<>NEW.line_account_id AND COALESCE(old_account.tenant_id,'00000000-0000-4000-8000-000000000001')<>COALESCE(new_account.tenant_id,'00000000-0000-4000-8000-000000000001')) BEGIN SELECT RAISE(ABORT,'instagram_cross_tenant'); END;

CREATE TRIGGER instagram_connection_tenant_update BEFORE UPDATE OF instagram_id,line_account_id ON instagram_connections WHEN EXISTS(SELECT 1 FROM instagram_connections existing JOIN line_accounts old_account ON old_account.id=existing.line_account_id JOIN line_accounts new_account ON new_account.id=NEW.line_account_id WHERE existing.instagram_id=NEW.instagram_id AND existing.line_account_id<>NEW.line_account_id AND COALESCE(old_account.tenant_id,'00000000-0000-4000-8000-000000000001')<>COALESCE(new_account.tenant_id,'00000000-0000-4000-8000-000000000001')) BEGIN SELECT RAISE(ABORT,'instagram_cross_tenant'); END;

CREATE TRIGGER line_account_tag_links_scope
BEFORE INSERT ON line_account_tag_links
WHEN NOT EXISTS (
  SELECT 1 FROM line_accounts WHERE id = NEW.line_account_id
    AND COALESCE(tenant_id, '00000000-0000-4000-8000-000000000001') = NEW.tenant_id
    AND archived_at IS NULL
)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_TAG_SCOPE_INVALID'); END;

CREATE TRIGGER line_accounts_folder_scope_insert BEFORE INSERT ON line_accounts
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM line_account_tags WHERE id=NEW.folder_id
    AND tenant_id=COALESCE(NEW.tenant_id,'00000000-0000-4000-8000-000000000001')
) BEGIN SELECT RAISE(ABORT,'ACCOUNT_FOLDER_SCOPE_INVALID'); END;

CREATE TRIGGER line_accounts_folder_scope_update BEFORE UPDATE OF folder_id,tenant_id ON line_accounts
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM line_account_tags WHERE id=NEW.folder_id
    AND tenant_id=COALESCE(NEW.tenant_id,'00000000-0000-4000-8000-000000000001')
) BEGIN SELECT RAISE(ABORT,'ACCOUNT_FOLDER_SCOPE_INVALID'); END;

CREATE TRIGGER line_sender_limit BEFORE INSERT ON line_senders
WHEN NEW.status='active' AND (SELECT COUNT(*) FROM line_senders WHERE account_id=NEW.account_id AND status='active')>=20
 AND NOT EXISTS(SELECT 1 FROM line_senders WHERE account_id=NEW.account_id AND idempotency_key=NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT,'sender_limit'); END;

CREATE TRIGGER line_sender_owner_disabled AFTER UPDATE OF is_active ON staff_members WHEN NEW.is_active=0
BEGIN UPDATE line_senders SET status='inactive',version=version+1 WHERE owner_staff_id=NEW.id AND visibility='owner_only' AND status='active'; END;

CREATE TRIGGER makeup_cancel_restore AFTER UPDATE OF status ON event_bookings WHEN NEW.status IN('cancelled','rejected','expired') AND OLD.status IN('requested','confirmed')
BEGIN UPDATE booking_makeup_credits SET status=CASE WHEN julianday(expires_at)>julianday('now') THEN 'open' ELSE 'expired' END,used_event_booking_id=NULL,version=version+1,use_idempotency_key=NULL,use_request_json=NULL
 WHERE used_event_booking_id=NEW.id AND status='used' AND (NEW.cancelled_by IN('admin','system') OR julianday('now') <= julianday((SELECT starts_at FROM event_slots WHERE id=NEW.slot_id))-COALESCE(json_extract(rule_snapshot_json,'$.cutoffHours'),3)/24.0); END;

CREATE TRIGGER meet_run_snapshot AFTER INSERT ON meet_consultation_notification_runs WHEN NEW.retry_key='' BEGIN UPDATE meet_consultation_notification_runs SET retry_key=NEW.id,booking_id=(SELECT booking_id FROM meet_consultations WHERE id=NEW.consultation_id),booking_version=(SELECT booking_version FROM meet_consultations WHERE id=NEW.consultation_id),line_account_id=(SELECT f.line_account_id FROM meet_consultations c JOIN friends f ON f.id=c.friend_id WHERE c.id=NEW.consultation_id),friend_id=(SELECT friend_id FROM meet_consultations WHERE id=NEW.consultation_id),recipient_id=(SELECT f.line_user_id FROM meet_consultations c JOIN friends f ON f.id=c.friend_id WHERE c.id=NEW.consultation_id),starts_at=(SELECT starts_at FROM meet_consultations WHERE id=NEW.consultation_id),ends_at=(SELECT ends_at FROM meet_consultations WHERE id=NEW.consultation_id),meet_url=(SELECT meet_url FROM meet_consultations WHERE id=NEW.consultation_id),schedule_revision=(SELECT schedule_revision FROM meet_consultations WHERE id=NEW.consultation_id) WHERE id=NEW.id; END;

CREATE TRIGGER messages_search_invalidate AFTER UPDATE OF content,unsent_at,delivery_type ON messages_log
WHEN OLD.content IS NOT NEW.content OR OLD.unsent_at IS NOT NEW.unsent_at OR OLD.delivery_type IS NOT NEW.delivery_type
BEGIN UPDATE messages_log SET search_content=NULL WHERE id=NEW.id; END;

CREATE TRIGGER mileage_adjustment_approval_events_history_detach AFTER UPDATE OF request_id ON mileage_adjustment_approval_events BEGIN UPDATE mileage_adjustment_approval_events SET request_id_history = COALESCE(NEW.request_id, OLD.request_id, OLD.request_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER mileage_adjustment_approval_events_history_insert AFTER INSERT ON mileage_adjustment_approval_events BEGIN UPDATE mileage_adjustment_approval_events SET request_id_history = COALESCE(NEW.request_id, NEW.request_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER mileage_reward_folders_common_delete AFTER DELETE ON mileage_reward_folders BEGIN DELETE FROM folders WHERE id=OLD.id AND kind='mileage_reward' AND account_id=OLD.line_account_id; END;

CREATE TRIGGER mileage_reward_folders_common_insert AFTER INSERT ON mileage_reward_folders WHEN NOT EXISTS(SELECT 1 FROM folders WHERE id=NEW.id) BEGIN INSERT INTO folders(id,kind,account_id,name,display_order,created_at,updated_at) VALUES(NEW.id,'mileage_reward',NEW.line_account_id,NEW.name,NEW.display_order,NEW.created_at,NEW.updated_at); END;

CREATE TRIGGER mileage_reward_folders_common_update AFTER UPDATE ON mileage_reward_folders WHEN EXISTS(SELECT 1 FROM folders WHERE id=NEW.id AND (name IS NOT NEW.name OR display_order IS NOT NEW.display_order)) BEGIN UPDATE folders SET name=NEW.name,display_order=NEW.display_order,revision=revision+1,updated_at=NEW.updated_at WHERE id=NEW.id AND kind='mileage_reward' AND account_id=NEW.line_account_id; END;

CREATE TRIGGER mileage_rewards_folder_insert BEFORE INSERT ON mileage_rewards WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM folders WHERE id=NEW.folder_id AND kind='mileage_reward' AND account_id=NEW.line_account_id) BEGIN SELECT RAISE(ABORT,'folder_assignment_invalid'); END;

CREATE TRIGGER mileage_rewards_folder_update BEFORE UPDATE OF folder_id,line_account_id ON mileage_rewards WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM folders WHERE id=NEW.folder_id AND kind='mileage_reward' AND account_id=NEW.line_account_id) BEGIN SELECT RAISE(ABORT,'folder_assignment_invalid'); END;

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

CREATE TRIGGER musubo_quote_accepted_immutable BEFORE UPDATE ON musubo_individual_quotes
WHEN OLD.status = 'accepted' AND
  (NEW.status IS NOT OLD.status OR NEW.accepted_at IS NOT OLD.accepted_at
   OR NEW.accepted_by IS NOT OLD.accepted_by)
BEGIN SELECT RAISE(ABORT, 'accepted_quote_immutable'); END;

CREATE TRIGGER musubo_quote_sent_terms_immutable BEFORE UPDATE ON musubo_individual_quotes
WHEN OLD.status <> 'draft' AND
  (NEW.id IS NOT OLD.id OR NEW.application_id IS NOT OLD.application_id
   OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.revision IS NOT OLD.revision
   OR NEW.final_prices_json IS NOT OLD.final_prices_json
   OR NEW.customer_summary_json IS NOT OLD.customer_summary_json
   OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_by IS NOT OLD.created_by
   OR NEW.created_at IS NOT OLD.created_at)
BEGIN SELECT RAISE(ABORT, 'sent_quote_terms_immutable'); END;

CREATE TRIGGER nen_photo_assessment_runs_history_detach AFTER UPDATE OF photo_id ON nen_photo_assessment_runs BEGIN UPDATE nen_photo_assessment_runs SET photo_id_history = COALESCE(NEW.photo_id, OLD.photo_id, OLD.photo_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER nen_photo_assessment_runs_history_insert AFTER INSERT ON nen_photo_assessment_runs BEGIN UPDATE nen_photo_assessment_runs SET photo_id_history = COALESCE(NEW.photo_id, NEW.photo_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER nen_photo_original_download_audit_history_detach AFTER UPDATE OF photo_id ON nen_photo_original_download_audit BEGIN UPDATE nen_photo_original_download_audit SET photo_id_history = COALESCE(NEW.photo_id, OLD.photo_id, OLD.photo_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER nen_photo_original_download_audit_history_insert AFTER INSERT ON nen_photo_original_download_audit BEGIN UPDATE nen_photo_original_download_audit SET photo_id_history = COALESCE(NEW.photo_id, NEW.photo_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER nen_photo_original_download_grants_history_detach AFTER UPDATE OF photo_id ON nen_photo_original_download_grants BEGIN UPDATE nen_photo_original_download_grants SET photo_id_history = COALESCE(NEW.photo_id, OLD.photo_id, OLD.photo_id_history) WHERE token_hash = NEW.token_hash; END;

CREATE TRIGGER nen_photo_original_download_grants_history_insert AFTER INSERT ON nen_photo_original_download_grants BEGIN UPDATE nen_photo_original_download_grants SET photo_id_history = COALESCE(NEW.photo_id, NEW.photo_id_history) WHERE token_hash = NEW.token_hash; END;

CREATE TRIGGER nen_photo_review_events_history_detach AFTER UPDATE OF photo_id ON nen_photo_review_events BEGIN UPDATE nen_photo_review_events SET photo_id_history = COALESCE(NEW.photo_id, OLD.photo_id, OLD.photo_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER nen_photo_review_events_history_insert AFTER INSERT ON nen_photo_review_events BEGIN UPDATE nen_photo_review_events SET photo_id_history = COALESCE(NEW.photo_id, NEW.photo_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER nen_photo_risk_assessments_history_detach AFTER UPDATE OF photo_id ON nen_photo_risk_assessments BEGIN UPDATE nen_photo_risk_assessments SET photo_id_history = COALESCE(NEW.photo_id, OLD.photo_id, OLD.photo_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER nen_photo_risk_assessments_history_insert AFTER INSERT ON nen_photo_risk_assessments BEGIN UPDATE nen_photo_risk_assessments SET photo_id_history = COALESCE(NEW.photo_id, NEW.photo_id_history) WHERE id = NEW.id; END;

CREATE TRIGGER operator_push_logout AFTER DELETE ON admin_sessions
BEGIN UPDATE operator_push_subscriptions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE staff_id=OLD.staff_id AND revoked_at IS NULL; END;

CREATE TRIGGER operator_push_revoke_staff AFTER UPDATE OF is_active,role,password_hash,permission_keys,view_permission_keys,account_scope,assigned_line_account_id ON staff_members
BEGIN UPDATE operator_push_subscriptions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE staff_id=NEW.id AND revoked_at IS NULL; END;

CREATE TRIGGER operator_push_scope_delete AFTER DELETE ON staff_account_scopes
BEGIN UPDATE operator_push_subscriptions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE staff_id=OLD.staff_id AND revoked_at IS NULL; END;

CREATE TRIGGER operator_push_scope_insert AFTER INSERT ON staff_account_scopes
BEGIN UPDATE operator_push_subscriptions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE staff_id=NEW.staff_id AND revoked_at IS NULL; END;

CREATE TRIGGER outgoing_webhook_config_version
AFTER UPDATE OF name, url, event_types, secret, secret_encrypted, is_active, max_retries, deleted_at
ON outgoing_webhooks
WHEN NEW.version = OLD.version
BEGIN
  UPDATE outgoing_webhooks SET version = OLD.version + 1, updated_by_staff_id = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
  WHERE id = NEW.id; END;

CREATE TRIGGER outgoing_webhooks_folder_delete AFTER DELETE ON folders
BEGIN UPDATE outgoing_webhooks SET folder_id = NULL WHERE folder_id = OLD.id; END;

CREATE TRIGGER outgoing_webhooks_folder_insert BEFORE INSERT ON outgoing_webhooks
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM folders WHERE id = NEW.folder_id AND kind = 'webhook' AND account_id = NEW.line_account_id
) BEGIN SELECT RAISE(ABORT, 'folder_assignment_invalid'); END;

CREATE TRIGGER outgoing_webhooks_folder_update BEFORE UPDATE OF folder_id, line_account_id ON outgoing_webhooks
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM folders WHERE id = NEW.folder_id AND kind = 'webhook' AND account_id = NEW.line_account_id
) BEGIN SELECT RAISE(ABORT, 'folder_assignment_invalid'); END;

CREATE TRIGGER pass_plan_cancel_return AFTER UPDATE OF status ON bookings WHEN NEW.status='cancelled' AND OLD.status='confirmed' AND EXISTS(SELECT 1 FROM booking_entitlement_uses WHERE booking_id=NEW.id AND consumed_at IS NOT NULL AND returned_at IS NULL)  AND julianday(NEW.starts_at)>=julianday(COALESCE(NEW.cancelled_at,NEW.decided_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')))+COALESCE((SELECT m.cancel_deadline_hours_before/24.0 FROM menus m WHERE m.id=NEW.menu_id),(SELECT s.cancel_deadline_minutes_before/1440.0 FROM booking_settings s WHERE s.line_account_id=NEW.line_account_id),1) BEGIN  UPDATE booking_entitlements SET remaining=CASE WHEN kind='ticket' THEN remaining+1 ELSE NULL END,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=(SELECT entitlement_id FROM booking_entitlement_uses WHERE booking_id=NEW.id AND returned_at IS NULL);  INSERT INTO booking_entitlement_events(id,entitlement_id,line_account_id,action,reason,actor_type,actor_id,request_key,request_json,after_json,created_at)  SELECT lower(hex(randomblob(16))),e.id,e.line_account_id,'adjust','取消で戻した','system',NEW.id,'cancel-return:'||NEW.id,json_object('bookingId',NEW.id),json_object('remaining',e.remaining,'version',e.version),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM booking_entitlements e JOIN booking_entitlement_uses u ON u.entitlement_id=e.id WHERE u.booking_id=NEW.id AND u.returned_at IS NULL;  UPDATE booking_entitlement_uses SET returned_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE booking_id=NEW.id AND returned_at IS NULL; END;

CREATE TRIGGER pass_plan_cancelled_reconfirm BEFORE UPDATE OF status ON bookings
WHEN NEW.status='confirmed' AND OLD.status='cancelled' AND EXISTS(SELECT 1 FROM booking_entitlement_uses WHERE booking_id=NEW.id AND returned_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'entitlement_cancelled_retry'); END;

CREATE TRIGGER pass_plan_consume BEFORE UPDATE OF consumed_at ON booking_entitlement_uses WHEN OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL AND EXISTS(SELECT 1 FROM booking_entitlements e JOIN bookings b ON b.id=NEW.booking_id JOIN booking_pass_plans p ON p.id=e.plan_id WHERE e.id=NEW.entitlement_id AND NOT EXISTS(SELECT 1 FROM booking_monthly_rights mr WHERE mr.entitlement_id=e.id) AND (e.billing_status='stopped' OR json_array_length(p.target_scope_json)>0 AND NOT EXISTS(SELECT 1 FROM json_each(p.target_scope_json) WHERE value=b.menu_id))) BEGIN SELECT RAISE(ABORT,'entitlement_unavailable'); END;

CREATE TRIGGER pass_plan_reschedule BEFORE UPDATE OF menu_id ON bookings WHEN EXISTS(SELECT 1 FROM booking_entitlement_uses u JOIN booking_entitlements e ON e.id=u.entitlement_id JOIN booking_pass_plans p ON p.id=e.plan_id WHERE u.booking_id=NEW.id AND NOT EXISTS(SELECT 1 FROM booking_monthly_rights mr WHERE mr.entitlement_id=e.id) AND json_array_length(p.target_scope_json)>0 AND NOT EXISTS(SELECT 1 FROM json_each(p.target_scope_json) WHERE value=NEW.menu_id)) BEGIN SELECT RAISE(ABORT,'entitlement_unavailable'); END;

CREATE TRIGGER pass_plan_selection BEFORE INSERT ON booking_entitlement_uses WHEN EXISTS(SELECT 1 FROM booking_entitlements e JOIN bookings b ON b.id=NEW.booking_id JOIN booking_pass_plans p ON p.id=e.plan_id WHERE e.id=NEW.entitlement_id AND NOT EXISTS(SELECT 1 FROM booking_monthly_rights mr WHERE mr.entitlement_id=e.id) AND (e.billing_status='stopped' OR p.line_account_id<>b.line_account_id OR json_array_length(p.target_scope_json)>0 AND NOT EXISTS(SELECT 1 FROM json_each(p.target_scope_json) WHERE value=b.menu_id))) BEGIN SELECT RAISE(ABORT,'entitlement_unavailable'); END;

CREATE TRIGGER photo_derivative_keys_insert AFTER INSERT ON nen_photo_submissions BEGIN UPDATE nen_photo_submissions SET review_r2_key=CASE WHEN (NEW.review_image_url LIKE 'https://%/images/nen-photo-review/%' OR NEW.review_image_url LIKE 'https://%/images/nen-photo-public/%') AND instr(NEW.review_image_url,'?')=0 AND instr(NEW.review_image_url,'#')=0 AND instr(NEW.review_image_url,'%')=0 AND instr(substr(NEW.review_image_url,instr(NEW.review_image_url,'/images/')+8),'..')=0 AND instr(NEW.review_image_url,char(92))=0 THEN substr(NEW.review_image_url,instr(NEW.review_image_url,'/images/')+8) ELSE NULL END,public_r2_key=CASE WHEN (NEW.public_image_url LIKE 'https://%/images/nen-photo-review/%' OR NEW.public_image_url LIKE 'https://%/images/nen-photo-public/%') AND instr(NEW.public_image_url,'?')=0 AND instr(NEW.public_image_url,'#')=0 AND instr(NEW.public_image_url,'%')=0 AND instr(substr(NEW.public_image_url,instr(NEW.public_image_url,'/images/')+8),'..')=0 AND instr(NEW.public_image_url,char(92))=0 THEN substr(NEW.public_image_url,instr(NEW.public_image_url,'/images/')+8) ELSE NULL END WHERE id=NEW.id; END;

CREATE TRIGGER photo_derivative_keys_update AFTER UPDATE OF review_image_url,public_image_url ON nen_photo_submissions BEGIN UPDATE nen_photo_submissions SET review_r2_key=CASE WHEN (NEW.review_image_url LIKE 'https://%/images/nen-photo-review/%' OR NEW.review_image_url LIKE 'https://%/images/nen-photo-public/%') AND instr(NEW.review_image_url,'?')=0 AND instr(NEW.review_image_url,'#')=0 AND instr(NEW.review_image_url,'%')=0 AND instr(substr(NEW.review_image_url,instr(NEW.review_image_url,'/images/')+8),'..')=0 AND instr(NEW.review_image_url,char(92))=0 THEN substr(NEW.review_image_url,instr(NEW.review_image_url,'/images/')+8) ELSE NULL END,public_r2_key=CASE WHEN (NEW.public_image_url LIKE 'https://%/images/nen-photo-review/%' OR NEW.public_image_url LIKE 'https://%/images/nen-photo-public/%') AND instr(NEW.public_image_url,'?')=0 AND instr(NEW.public_image_url,'#')=0 AND instr(NEW.public_image_url,'%')=0 AND instr(substr(NEW.public_image_url,instr(NEW.public_image_url,'/images/')+8),'..')=0 AND instr(NEW.public_image_url,char(92))=0 THEN substr(NEW.public_image_url,instr(NEW.public_image_url,'/images/')+8) ELSE NULL END WHERE id=NEW.id; END;

CREATE TRIGGER platform_audit_logs_security_time_insert AFTER INSERT ON platform_audit_logs
BEGIN UPDATE platform_audit_logs SET security_created_at_jd = julianday(CASE WHEN substr(NEW.created_at, 20) NOT GLOB '*[Z+-]*' THEN NEW.created_at || '+09:00' ELSE NEW.created_at END) WHERE rowid = NEW.rowid; END;

CREATE TRIGGER platform_audit_logs_security_time_update AFTER UPDATE OF created_at ON platform_audit_logs
BEGIN UPDATE platform_audit_logs SET security_created_at_jd = julianday(CASE WHEN substr(NEW.created_at, 20) NOT GLOB '*[Z+-]*' THEN NEW.created_at || '+09:00' ELSE NEW.created_at END) WHERE rowid = NEW.rowid; END;

CREATE TRIGGER restaurant_course_payment_scope_insert BEFORE INSERT ON restaurant_course_payment_settings
WHEN NOT EXISTS(SELECT 1 FROM rt_menu_items m JOIN rt_stores s ON s.id=m.store_id
  WHERE m.id=NEW.menu_id AND m.kind='course' AND s.id=NEW.store_id AND s.line_account_id=NEW.line_account_id)
BEGIN SELECT RAISE(ABORT,'course_payment_scope_mismatch'); END;

CREATE TRIGGER restaurant_course_payment_scope_update BEFORE UPDATE ON restaurant_course_payment_settings
WHEN NOT EXISTS(SELECT 1 FROM rt_menu_items m JOIN rt_stores s ON s.id=m.store_id
  WHERE m.id=NEW.menu_id AND m.kind='course' AND s.id=NEW.store_id AND s.line_account_id=NEW.line_account_id)
BEGIN SELECT RAISE(ABORT,'course_payment_scope_mismatch'); END;

CREATE TRIGGER rt_closure_reservation_insert BEFORE INSERT ON rt_reservations WHEN NEW.status NOT IN ('cancelled','no_show') AND NEW.departed_at IS NULL AND EXISTS(SELECT 1 FROM rt_closures c, json_each(c.periods_json) p WHERE c.store_id=NEW.store_id AND c.archived_at IS NULL AND julianday(json_extract(p.value,'$.startsAt'))<julianday(NEW.ends_at) AND julianday(json_extract(p.value,'$.endsAt'))>julianday(NEW.starts_at) AND (json_array_length(c.table_ids_json)=0 OR NEW.table_id IS NULL OR EXISTS(SELECT 1 FROM json_each(c.table_ids_json) t WHERE t.value=NEW.table_id))) BEGIN SELECT RAISE(ABORT,'closure_conflict'); END;

CREATE TRIGGER rt_closure_reservation_update BEFORE UPDATE ON rt_reservations WHEN NEW.status NOT IN ('cancelled','no_show') AND NEW.departed_at IS NULL AND (OLD.departed_at IS NOT NULL OR NEW.store_id<>OLD.store_id OR NEW.table_id IS NOT OLD.table_id OR julianday(NEW.starts_at)<>julianday(OLD.starts_at) OR julianday(NEW.ends_at)<>julianday(OLD.ends_at) OR OLD.status IN ('cancelled','no_show') OR (OLD.status='pending' AND OLD.hold_expires_at IS NOT NULL AND NEW.status<>'pending')) AND EXISTS(SELECT 1 FROM rt_closures c, json_each(c.periods_json) p WHERE c.store_id=NEW.store_id AND c.archived_at IS NULL AND julianday(json_extract(p.value,'$.startsAt'))<julianday(NEW.ends_at) AND julianday(json_extract(p.value,'$.endsAt'))>julianday(NEW.starts_at) AND (json_array_length(c.table_ids_json)=0 OR NEW.table_id IS NULL OR EXISTS(SELECT 1 FROM json_each(c.table_ids_json) t WHERE t.value=NEW.table_id))) BEGIN SELECT RAISE(ABORT,'closure_conflict'); END;

CREATE TRIGGER rt_closure_tasks_insert AFTER INSERT ON rt_closures WHEN NEW.archived_at IS NULL BEGIN INSERT INTO rt_closure_close_tasks(id,store_id,closure_id,closure_version,channel,kind,start_date,end_date,all_day,start_time,end_time,table_ids_json,starts_at,ends_at,status) SELECT lower(hex(randomblob(16))),NEW.store_id,NEW.id,NEW.version,m.code,NEW.kind,NEW.start_date,NEW.end_date,NEW.all_day,NEW.start_time,NEW.end_time,NEW.table_ids_json, json_extract(NEW.periods_json,'$[0].startsAt'),json_extract(NEW.periods_json,'$[#-1].endsAt'),'close' FROM rt_store_media_links l JOIN rt_media m ON m.id=l.media_id WHERE NEW.notify_media=1 AND l.store_id=NEW.store_id AND l.close_on_booking=1 AND m.accepts_reservations=1; INSERT INTO rt_inventory_rule_queue(store_id,cause) VALUES(NEW.store_id,'closure_saved') ON CONFLICT(store_id) DO UPDATE SET generation=generation+1,cause=excluded.cause,updated_at=datetime('now'); END;

CREATE TRIGGER rt_closure_tasks_update AFTER UPDATE ON rt_closures BEGIN UPDATE rt_closure_close_tasks SET status='reopen',generation=generation+1,updated_at=datetime('now') WHERE closure_id=NEW.id AND status<>'reopen'; INSERT INTO rt_closure_close_tasks(id,store_id,closure_id,closure_version,channel,kind,start_date,end_date,all_day,start_time,end_time,table_ids_json,starts_at,ends_at,status) SELECT lower(hex(randomblob(16))),NEW.store_id,NEW.id,NEW.version,m.code,NEW.kind,NEW.start_date,NEW.end_date,NEW.all_day,NEW.start_time,NEW.end_time,NEW.table_ids_json, json_extract(NEW.periods_json,'$[0].startsAt'),json_extract(NEW.periods_json,'$[#-1].endsAt'),'close' FROM rt_store_media_links l JOIN rt_media m ON m.id=l.media_id WHERE NEW.notify_media=1 AND NEW.archived_at IS NULL AND l.store_id=NEW.store_id AND l.close_on_booking=1 AND m.accepts_reservations=1; INSERT INTO rt_inventory_rule_queue(store_id,cause) VALUES(NEW.store_id,'closure_changed') ON CONFLICT(store_id) DO UPDATE SET generation=generation+1,cause=excluded.cause,updated_at=datetime('now'); END;

CREATE TRIGGER rt_closure_waitlist_insert BEFORE INSERT ON rt_seat_waitlist WHEN NEW.status IN ('waiting','invited') AND EXISTS(SELECT 1 FROM rt_closures c, json_each(c.periods_json) p WHERE c.store_id=NEW.store_id AND c.archived_at IS NULL AND julianday(json_extract(p.value,'$.startsAt'))<julianday(COALESCE(NEW.ends_at,datetime(NEW.starts_at,'+120 minutes'))) AND julianday(json_extract(p.value,'$.endsAt'))>julianday(NEW.starts_at)) AND NOT EXISTS( SELECT 1 FROM rt_tables t WHERE t.store_id=NEW.store_id AND t.is_active=1 AND t.min_capacity<=NEW.guest_count AND t.max_capacity>=NEW.guest_count AND (NEW.status='waiting' OR t.id=NEW.table_id) AND NOT EXISTS(SELECT 1 FROM rt_closures c,json_each(c.periods_json) p WHERE c.store_id=t.store_id AND c.archived_at IS NULL AND (json_array_length(c.table_ids_json)=0 OR EXISTS(SELECT 1 FROM json_each(c.table_ids_json) ct WHERE ct.value=t.id)) AND julianday(json_extract(p.value,'$.startsAt'))<julianday(COALESCE(NEW.ends_at,datetime(NEW.starts_at,'+120 minutes'))) AND julianday(json_extract(p.value,'$.endsAt'))>julianday(NEW.starts_at))) BEGIN SELECT RAISE(ABORT,'closure_conflict'); END;

CREATE TRIGGER rt_closure_waitlist_update BEFORE UPDATE ON rt_seat_waitlist WHEN NEW.status IN ('waiting','invited') AND (NEW.status<>OLD.status OR NEW.store_id<>OLD.store_id OR NEW.table_id IS NOT OLD.table_id OR NEW.starts_at<>OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at OR NEW.guest_count<>OLD.guest_count) AND EXISTS(SELECT 1 FROM rt_closures c, json_each(c.periods_json) p WHERE c.store_id=NEW.store_id AND c.archived_at IS NULL AND julianday(json_extract(p.value,'$.startsAt'))<julianday(COALESCE(NEW.ends_at,datetime(NEW.starts_at,'+120 minutes'))) AND julianday(json_extract(p.value,'$.endsAt'))>julianday(NEW.starts_at)) AND NOT EXISTS( SELECT 1 FROM rt_tables t WHERE t.store_id=NEW.store_id AND t.is_active=1 AND t.min_capacity<=NEW.guest_count AND t.max_capacity>=NEW.guest_count AND (NEW.status='waiting' OR t.id=NEW.table_id) AND NOT EXISTS(SELECT 1 FROM rt_closures c,json_each(c.periods_json) p WHERE c.store_id=t.store_id AND c.archived_at IS NULL AND (json_array_length(c.table_ids_json)=0 OR EXISTS(SELECT 1 FROM json_each(c.table_ids_json) ct WHERE ct.value=t.id)) AND julianday(json_extract(p.value,'$.startsAt'))<julianday(COALESCE(NEW.ends_at,datetime(NEW.starts_at,'+120 minutes'))) AND julianday(json_extract(p.value,'$.endsAt'))>julianday(NEW.starts_at))) BEGIN SELECT RAISE(ABORT,'closure_conflict'); END;

CREATE TRIGGER rt_closures_overlap_insert BEFORE INSERT ON rt_closures WHEN NEW.archived_at IS NULL AND EXISTS(SELECT 1 FROM rt_closures c, json_each(c.periods_json) cp, json_each(NEW.periods_json) np WHERE c.store_id=NEW.store_id AND c.archived_at IS NULL AND c.id<>NEW.id AND julianday(json_extract(cp.value,'$.startsAt'))<julianday(json_extract(np.value,'$.endsAt')) AND julianday(json_extract(cp.value,'$.endsAt'))>julianday(json_extract(np.value,'$.startsAt')) AND (json_array_length(c.table_ids_json)=0 OR json_array_length(NEW.table_ids_json)=0 OR EXISTS(SELECT 1 FROM json_each(c.table_ids_json) a JOIN json_each(NEW.table_ids_json) b ON a.value=b.value))) BEGIN SELECT RAISE(ABORT,'closure_overlap'); END;

CREATE TRIGGER rt_closures_overlap_update BEFORE UPDATE ON rt_closures WHEN NEW.archived_at IS NULL AND EXISTS(SELECT 1 FROM rt_closures c, json_each(c.periods_json) cp, json_each(NEW.periods_json) np WHERE c.store_id=NEW.store_id AND c.archived_at IS NULL AND c.id<>NEW.id AND julianday(json_extract(cp.value,'$.startsAt'))<julianday(json_extract(np.value,'$.endsAt')) AND julianday(json_extract(cp.value,'$.endsAt'))>julianday(json_extract(np.value,'$.startsAt')) AND (json_array_length(c.table_ids_json)=0 OR json_array_length(NEW.table_ids_json)=0 OR EXISTS(SELECT 1 FROM json_each(c.table_ids_json) a JOIN json_each(NEW.table_ids_json) b ON a.value=b.value))) BEGIN SELECT RAISE(ABORT,'closure_overlap'); END;

CREATE TRIGGER rt_customer_identity_insert BEFORE INSERT ON rt_reservations WHEN NEW.customer_request_id IS NOT NULL AND NEW.status NOT IN ('cancelled','no_show') AND NEW.departed_at IS NULL AND EXISTS(SELECT 1 FROM rt_reservations r WHERE r.store_id=NEW.store_id AND r.line_uid=NEW.line_uid AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR julianday(r.hold_expires_at)>julianday('now')) AND julianday(r.starts_at)<julianday(NEW.ends_at) AND julianday(r.ends_at)>julianday(NEW.starts_at)) BEGIN SELECT RAISE(ABORT,'customer_duplicate_booking'); END;

CREATE TRIGGER rt_customer_identity_update BEFORE UPDATE OF departed_at,starts_at,ends_at ON rt_reservations WHEN NEW.customer_request_id IS NOT NULL AND NEW.status NOT IN ('cancelled','no_show') AND NEW.departed_at IS NULL AND EXISTS(SELECT 1 FROM rt_reservations r WHERE r.id<>NEW.id AND r.store_id=NEW.store_id AND r.line_uid=NEW.line_uid AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR julianday(r.hold_expires_at)>julianday('now')) AND julianday(r.starts_at)<julianday(NEW.ends_at) AND julianday(r.ends_at)>julianday(NEW.starts_at)) BEGIN SELECT RAISE(ABORT,'customer_duplicate_booking'); END;

CREATE TRIGGER rt_customer_line_capacity_insert BEFORE INSERT ON rt_reservations WHEN NEW.customer_request_id IS NOT NULL AND NEW.status NOT IN ('cancelled','no_show') AND NEW.departed_at IS NULL AND EXISTS(SELECT 1 FROM rt_inventory_slots i WHERE i.store_id=NEW.store_id AND julianday(i.starts_at)<julianday(NEW.ends_at) AND julianday(i.starts_at,'+'||i.slot_minutes||' minutes')>julianday(NEW.starts_at) AND i.line_capacity < NEW.guest_count + (SELECT COALESCE(SUM(r.guest_count),0) FROM rt_reservations r WHERE r.id<>NEW.id AND r.store_id=NEW.store_id AND r.source='line' AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR julianday(r.hold_expires_at)>julianday('now')) AND julianday(r.starts_at)<julianday(i.starts_at,'+'||i.slot_minutes||' minutes') AND julianday(r.ends_at)>julianday(i.starts_at))) BEGIN SELECT RAISE(ABORT,'customer_line_capacity'); END;

CREATE TRIGGER rt_customer_line_capacity_update BEFORE UPDATE OF departed_at,table_id,starts_at,ends_at,guest_count ON rt_reservations WHEN NEW.customer_request_id IS NOT NULL AND NEW.status NOT IN ('cancelled','no_show') AND NEW.departed_at IS NULL AND (NEW.departed_at IS NOT OLD.departed_at OR NEW.table_id IS NOT OLD.table_id OR NEW.starts_at<>OLD.starts_at OR NEW.ends_at<>OLD.ends_at OR NEW.guest_count<>OLD.guest_count) AND EXISTS(SELECT 1 FROM rt_inventory_slots i WHERE i.store_id=NEW.store_id AND julianday(i.starts_at)<julianday(NEW.ends_at) AND julianday(i.starts_at,'+'||i.slot_minutes||' minutes')>julianday(NEW.starts_at) AND i.line_capacity < NEW.guest_count + (SELECT COALESCE(SUM(r.guest_count),0) FROM rt_reservations r WHERE r.id<>NEW.id AND r.store_id=NEW.store_id AND r.source='line' AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR julianday(r.hold_expires_at)>julianday('now')) AND julianday(r.starts_at)<julianday(i.starts_at,'+'||i.slot_minutes||' minutes') AND julianday(r.ends_at)>julianday(i.starts_at))) BEGIN SELECT RAISE(ABORT,'customer_line_capacity'); END;

CREATE TRIGGER rt_customer_table_insert BEFORE INSERT ON rt_reservations WHEN NEW.status NOT IN ('cancelled','no_show') AND NEW.departed_at IS NULL AND (NEW.status<>'pending' OR NEW.hold_expires_at IS NULL OR julianday(NEW.hold_expires_at)>julianday('now')) AND NEW.table_id IS NOT NULL AND EXISTS(SELECT 1 FROM rt_reservations r WHERE r.store_id=NEW.store_id AND r.table_id=NEW.table_id AND r.id<>NEW.id AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR julianday(r.hold_expires_at)>julianday('now')) AND (NEW.customer_request_id IS NOT NULL OR r.customer_request_id IS NOT NULL) AND julianday(r.starts_at)<julianday(NEW.ends_at) AND julianday(r.ends_at)>julianday(NEW.starts_at)) BEGIN SELECT RAISE(ABORT,'customer_table_conflict'); END;

CREATE TRIGGER rt_customer_table_update BEFORE UPDATE OF departed_at,table_id,starts_at,ends_at,status ON rt_reservations WHEN NEW.status NOT IN ('cancelled','no_show') AND NEW.departed_at IS NULL AND (NEW.status<>'pending' OR NEW.hold_expires_at IS NULL OR julianday(NEW.hold_expires_at)>julianday('now')) AND NEW.table_id IS NOT NULL AND EXISTS(SELECT 1 FROM rt_reservations r WHERE r.store_id=NEW.store_id AND r.table_id=NEW.table_id AND r.id<>NEW.id AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR julianday(r.hold_expires_at)>julianday('now')) AND (NEW.customer_request_id IS NOT NULL OR r.customer_request_id IS NOT NULL) AND julianday(r.starts_at)<julianday(NEW.ends_at) AND julianday(r.ends_at)>julianday(NEW.starts_at)) BEGIN SELECT RAISE(ABORT,'customer_table_conflict'); END;

CREATE TRIGGER rt_departure_preserve_visit BEFORE UPDATE OF status ON rt_reservations WHEN OLD.departed_at IS NOT NULL AND NEW.status IS NOT OLD.status BEGIN SELECT RAISE(ABORT,'undo_departure_first'); END;

CREATE TRIGGER rt_departure_requires_visit BEFORE UPDATE OF departed_at ON rt_reservations WHEN NEW.departed_at IS NOT NULL AND (NEW.status NOT IN ('visited','seated') OR NOT EXISTS( SELECT 1 FROM rt_seat_visit_marks m WHERE m.reservation_id=NEW.id AND m.kind='visited' AND m.undone_at IS NULL AND julianday(m.marked_at)<=julianday(NEW.departed_at))) BEGIN SELECT RAISE(ABORT,'departure_requires_visit'); END;

CREATE TRIGGER rt_departure_undo_closure BEFORE UPDATE OF departed_at ON rt_reservations WHEN OLD.departed_at IS NOT NULL AND NEW.departed_at IS NULL AND EXISTS(SELECT 1 FROM rt_closures c,json_each(c.periods_json) p WHERE c.store_id=NEW.store_id AND c.archived_at IS NULL AND (json_array_length(c.table_ids_json)=0 OR EXISTS(SELECT 1 FROM rt_reservation_table_links l,json_each(c.table_ids_json) t WHERE l.reservation_id=NEW.id AND l.table_id=t.value)) AND julianday(json_extract(p.value,'$.startsAt'))<julianday(NEW.ends_at) AND julianday(json_extract(p.value,'$.endsAt'))>julianday(NEW.starts_at)) BEGIN SELECT RAISE(ABORT,'closure_conflict'); END;

CREATE TRIGGER rt_departure_undo_stopped BEFORE UPDATE OF departed_at ON rt_reservations WHEN OLD.departed_at IS NOT NULL AND NEW.departed_at IS NULL AND EXISTS(SELECT 1 FROM rt_reservation_table_links l JOIN rt_tables t ON t.id=l.table_id WHERE l.reservation_id=NEW.id AND t.is_active=0) BEGIN SELECT RAISE(ABORT,'restaurant_table_conflict'); END;

CREATE TRIGGER rt_departure_version AFTER UPDATE OF departed_at ON rt_reservations WHEN NEW.departed_at IS NOT OLD.departed_at AND NEW.customer_version=OLD.customer_version BEGIN UPDATE rt_reservations SET customer_version=OLD.customer_version+1 WHERE id=NEW.id; END;

CREATE TRIGGER rt_dining_snapshot_insert AFTER INSERT ON rt_reservations WHEN NEW.dining_snapshot_json IS NULL BEGIN UPDATE rt_reservations SET dining_snapshot_json=json_object( 'allergy',COALESCE(NEW.allergy_note,(SELECT v.value FROM friend_field_values v JOIN friends f ON f.id=v.friend_id JOIN rt_stores s ON s.line_account_id=f.line_account_id WHERE s.id=NEW.store_id AND f.line_user_id=NEW.line_uid AND v.field_id='fixed-allergy' LIMIT 1)), 'anniversary',(SELECT v.value FROM friend_field_values v JOIN friends f ON f.id=v.friend_id JOIN rt_stores s ON s.line_account_id=f.line_account_id WHERE s.id=NEW.store_id AND f.line_user_id=NEW.line_uid AND v.field_id='fixed-anniversary' LIMIT 1), 'seatPreference',(SELECT v.value FROM friend_field_values v JOIN friends f ON f.id=v.friend_id JOIN rt_stores s ON s.line_account_id=f.line_account_id WHERE s.id=NEW.store_id AND f.line_user_id=NEW.line_uid AND v.field_id='fixed-seat_preference' LIMIT 1), 'courseId',NEW.course_id,'courseAllergens',json(COALESCE((SELECT allergens_json FROM rt_menu_items WHERE id=NEW.course_id AND store_id=NEW.store_id),'[]')),'capturedAt',NEW.created_at) WHERE id=NEW.id; END;

CREATE TRIGGER rt_direct_close_source AFTER INSERT ON rt_reservation_close_tasks BEGIN  UPDATE rt_reservation_close_tasks SET trigger_source=(SELECT source FROM rt_reservations WHERE id=NEW.reservation_id AND store_id=NEW.store_id) WHERE id=NEW.id; END;

CREATE TRIGGER rt_direct_close_source_generation AFTER UPDATE OF generation ON rt_reservation_close_tasks WHEN NEW.generation<>OLD.generation AND NEW.status='close' BEGIN UPDATE rt_reservation_close_tasks SET trigger_source=(SELECT source FROM rt_reservations WHERE id=NEW.reservation_id AND store_id=NEW.store_id) WHERE id=NEW.id; END;

CREATE TRIGGER rt_event_receipts AFTER INSERT ON rt_reservation_events BEGIN INSERT INTO rt_reservation_event_receipts(event_id,consumer_key) VALUES(NEW.id,'event_bus'),(NEW.id,'mileage'); INSERT INTO rt_reservation_event_receipts(event_id,consumer_key) SELECT NEW.id,'visit_stamp_queue' WHERE NEW.event_type IN('restaurant.arrived','restaurant.arrival_undone'); END;

CREATE TRIGGER rt_external_links_legacy_insert BEFORE INSERT ON rt_reservation_external_links
WHEN NEW.unlinked_at IS NULL AND EXISTS (
  SELECT 1 FROM rt_reservations WHERE store_id = NEW.store_id AND source = NEW.provider
    AND trim(external_id) = NEW.external_id AND id <> NEW.reservation_id
)
BEGIN SELECT RAISE(ABORT, 'external_link_legacy_conflict'); END;

CREATE TRIGGER rt_external_links_legacy_update BEFORE UPDATE ON rt_reservation_external_links
WHEN NEW.unlinked_at IS NULL AND EXISTS (
  SELECT 1 FROM rt_reservations WHERE store_id = NEW.store_id AND source = NEW.provider
    AND trim(external_id) = NEW.external_id AND id <> NEW.reservation_id
)
BEGIN SELECT RAISE(ABORT, 'external_link_legacy_conflict'); END;

CREATE TRIGGER rt_external_links_store_insert BEFORE INSERT ON rt_reservation_external_links
WHEN NOT EXISTS (SELECT 1 FROM rt_reservations WHERE id = NEW.reservation_id AND store_id = NEW.store_id)
BEGIN SELECT RAISE(ABORT, 'external_link_store_mismatch'); END;

CREATE TRIGGER rt_external_links_store_update BEFORE UPDATE OF reservation_id, store_id ON rt_reservation_external_links
WHEN NOT EXISTS (SELECT 1 FROM rt_reservations WHERE id = NEW.reservation_id AND store_id = NEW.store_id)
BEGIN SELECT RAISE(ABORT, 'external_link_store_mismatch'); END;

CREATE TRIGGER rt_floor_new_store AFTER INSERT ON rt_stores BEGIN INSERT INTO rt_floors(id,store_id,name) VALUES('floor-'||NEW.id,NEW.id,'1階'); END;

CREATE TRIGGER rt_floor_new_table AFTER INSERT ON rt_tables WHEN NEW.floor_id IS NULL BEGIN UPDATE rt_tables SET floor_id='floor-'||NEW.store_id WHERE id=NEW.id; END;

CREATE TRIGGER rt_followup_approval_apply AFTER UPDATE OF status ON rt_approval_requests WHEN json_extract(NEW.payload_json,'$.operation')='start_restaurant_followup' AND NEW.status IN('approved','returned') BEGIN UPDATE rt_store_followup_templates SET sending_status=CASE WHEN NEW.status='approved' THEN 'active' ELSE 'stopped' END WHERE approval_id=NEW.id; END;

CREATE TRIGGER rt_followup_approval_check BEFORE UPDATE OF status ON rt_approval_requests WHEN NEW.status='approved' AND json_extract(NEW.payload_json,'$.operation')='start_restaurant_followup' AND NOT EXISTS(SELECT 1 FROM rt_store_followup_templates t JOIN scenarios s ON s.id=t.scenario_id JOIN rt_stores store ON store.id=t.store_id WHERE t.store_id=NEW.store_id AND t.approval_id=NEW.id AND t.sending_status='pending' AND t.template_version=json_extract(NEW.payload_json,'$.templateVersion') AND t.approved_version_id=json_extract(NEW.payload_json,'$.scenarioVersionId') AND s.current_published_version_id=t.approved_version_id AND s.line_account_id=store.line_account_id AND store.line_account_id=json_extract(NEW.payload_json,'$.lineAccountId') AND EXISTS(SELECT 1 FROM scenario_versions v WHERE v.id=t.approved_version_id AND v.status='published')) BEGIN SELECT RAISE(ABORT,'followup_approval_version_conflict'); END;

CREATE TRIGGER rt_followup_binding_deleted AFTER DELETE ON rt_store_followup_step_bindings BEGIN UPDATE rt_store_followup_templates SET template_version=template_version+1,sending_status='stopped',approved_version_id=NULL,approval_id=NULL WHERE store_id=OLD.store_id; END;

CREATE TRIGGER rt_followup_binding_inserted AFTER INSERT ON rt_store_followup_step_bindings BEGIN UPDATE rt_store_followup_templates SET template_version=template_version+1,sending_status='stopped',approved_version_id=NULL,approval_id=NULL WHERE store_id=NEW.store_id; END;

CREATE TRIGGER rt_followup_binding_updated AFTER UPDATE ON rt_store_followup_step_bindings BEGIN UPDATE rt_store_followup_templates SET template_version=template_version+1,sending_status='stopped',approved_version_id=NULL,approval_id=NULL WHERE store_id=NEW.store_id; END;

CREATE TRIGGER rt_followup_customer_notice AFTER INSERT ON rt_customer_notice_outbox WHEN EXISTS(SELECT 1 FROM rt_reservation_events e JOIN rt_reservation_event_receipts receipt ON receipt.event_id=e.id JOIN rt_stores s ON s.id=e.store_id AND (EXISTS(SELECT 1 FROM rt_store_followup_templates WHERE store_id=s.id) OR EXISTS(SELECT 1 FROM rt_store_followup_rows WHERE store_id=s.id)) WHERE e.reservation_id=NEW.reservation_id AND e.reservation_version=NEW.customer_version AND e.event_type='restaurant.reservation.created' AND receipt.consumer_key='followup') BEGIN UPDATE rt_customer_notice_outbox SET valid=0 WHERE id=NEW.id; END;

CREATE TRIGGER rt_followup_event_receipt AFTER INSERT ON rt_reservation_events BEGIN INSERT INTO rt_reservation_event_receipts(event_id,consumer_key) VALUES(NEW.id,'followup'); END;

CREATE TRIGGER rt_followup_legacy_edit BEFORE UPDATE ON rt_line_flows WHEN EXISTS(SELECT 1 FROM rt_store_followup_templates WHERE store_id=OLD.store_id) OR EXISTS(SELECT 1 FROM rt_store_followup_rows WHERE store_id=OLD.store_id) BEGIN SELECT RAISE(ABORT,'edit_restaurant_followup_in_common_scenario'); END;

CREATE TRIGGER rt_followup_no_enrollment BEFORE INSERT ON friend_scenarios WHEN EXISTS(SELECT 1 FROM rt_store_followup_templates WHERE scenario_id=NEW.scenario_id) BEGIN SELECT RAISE(ABORT,'restaurant_followup_requires_source_job'); END;

CREATE TRIGGER rt_followup_preference_binding_enabled AFTER UPDATE OF enabled ON rt_store_followup_step_bindings WHEN NEW.enabled=1
 BEGIN UPDATE rt_store_followup_preferences SET not_using=0,decided_at=NULL,decided_by=NULL,version=version+1 WHERE store_id=NEW.store_id AND not_using=1; END;

CREATE TRIGGER rt_followup_preference_binding_inserted AFTER INSERT ON rt_store_followup_step_bindings WHEN NEW.enabled=1
 BEGIN UPDATE rt_store_followup_preferences SET not_using=0,decided_at=NULL,decided_by=NULL,version=version+1 WHERE store_id=NEW.store_id AND not_using=1; END;

CREATE TRIGGER rt_followup_preference_target_enabled AFTER UPDATE OF enabled ON rt_store_followup_targets WHEN NEW.enabled=1
 BEGIN UPDATE rt_store_followup_preferences SET not_using=0,decided_at=NULL,decided_by=NULL,version=version+1 WHERE store_id=NEW.store_id AND not_using=1; END;

CREATE TRIGGER rt_followup_preference_target_inserted AFTER INSERT ON rt_store_followup_targets WHEN NEW.enabled=1
 BEGIN UPDATE rt_store_followup_preferences SET not_using=0,decided_at=NULL,decided_by=NULL,version=version+1 WHERE store_id=NEW.store_id AND not_using=1; END;

CREATE TRIGGER rt_followup_published AFTER UPDATE OF current_published_version_id ON scenarios WHEN NEW.current_published_version_id IS NOT OLD.current_published_version_id BEGIN UPDATE rt_store_followup_templates SET template_version=template_version+1,sending_status='stopped',approved_version_id=NULL,approval_id=NULL WHERE scenario_id=NEW.id; END;

CREATE TRIGGER rt_followup_row_binding_deleted AFTER DELETE ON rt_store_followup_step_bindings BEGIN UPDATE rt_store_followup_rows SET version=version+1 WHERE store_id=OLD.store_id AND trigger=OLD.trigger; END;

CREATE TRIGGER rt_followup_row_binding_inserted AFTER INSERT ON rt_store_followup_step_bindings BEGIN UPDATE rt_store_followup_rows SET step_id=COALESCE(step_id,NEW.step_id),version=version+1 WHERE store_id=NEW.store_id AND trigger=NEW.trigger; END;

CREATE TRIGGER rt_followup_row_binding_updated AFTER UPDATE ON rt_store_followup_step_bindings BEGIN UPDATE rt_store_followup_rows SET version=version+1 WHERE store_id=NEW.store_id AND trigger=NEW.trigger; END;

CREATE TRIGGER rt_followup_row_step_deleted AFTER DELETE ON scenario_steps BEGIN UPDATE rt_store_followup_rows SET step_id=NULL,version=version+1 WHERE step_id=OLD.id; END;

CREATE TRIGGER rt_followup_step_deleted AFTER DELETE ON scenario_steps BEGIN UPDATE rt_store_followup_templates SET template_version=template_version+1,sending_status='stopped',approved_version_id=NULL,approval_id=NULL WHERE scenario_id=OLD.scenario_id; END;

CREATE TRIGGER rt_followup_step_inserted AFTER INSERT ON scenario_steps BEGIN UPDATE rt_store_followup_templates SET template_version=template_version+1,sending_status='stopped',approved_version_id=NULL,approval_id=NULL WHERE scenario_id=NEW.scenario_id; END;

CREATE TRIGGER rt_followup_step_unbound BEFORE DELETE ON scenario_steps BEGIN DELETE FROM rt_store_followup_step_bindings WHERE step_id=OLD.id; END;

CREATE TRIGGER rt_followup_step_updated AFTER UPDATE ON scenario_steps BEGIN UPDATE rt_store_followup_templates SET template_version=template_version+1,sending_status='stopped',approved_version_id=NULL,approval_id=NULL WHERE scenario_id=NEW.scenario_id; END;

CREATE TRIGGER rt_followup_store_added AFTER INSERT ON rt_stores BEGIN INSERT OR IGNORE INTO rt_store_followup_rows(store_id,trigger,initial_key) SELECT NEW.id,value,value FROM json_each('["reservation_created","reservation_24h","reservation_2h","post_visit","review_request","waitlist_invited","anniversary_before"]') WHERE NEW.line_account_id IS NOT NULL; END;

CREATE TRIGGER rt_followup_store_connected AFTER UPDATE OF line_account_id ON rt_stores WHEN OLD.line_account_id IS NULL AND NEW.line_account_id IS NOT NULL BEGIN INSERT OR IGNORE INTO rt_store_followup_rows(store_id,trigger,initial_key) SELECT NEW.id,value,value FROM json_each('["reservation_created","reservation_24h","reservation_2h","post_visit","review_request","waitlist_invited","anniversary_before"]') WHERE NEW.line_account_id IS NOT NULL; END;

CREATE TRIGGER rt_followup_target_event_receipt AFTER INSERT ON rt_reservation_events
 WHEN NEW.reservation_id IS NOT NULL AND NEW.event_type LIKE 'restaurant.reservation.%'
 BEGIN INSERT INTO rt_reservation_event_receipts(event_id,consumer_key) VALUES(NEW.id,'followup_targets'); END;

CREATE TRIGGER rt_inventory_reservation_delete AFTER DELETE ON rt_reservations BEGIN UPDATE rt_inventory_slots SET version=version+1, updated_at=datetime('now'), reserved_count=COALESCE((SELECT SUM(r.guest_count) FROM rt_reservations r WHERE r.store_id=rt_inventory_slots.store_id AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR datetime(r.hold_expires_at)>datetime('now')) AND datetime(r.starts_at)<datetime(rt_inventory_slots.starts_at, '+' || rt_inventory_slots.slot_minutes || ' minutes') AND datetime(r.ends_at)>datetime(rt_inventory_slots.starts_at)),0) WHERE (store_id=OLD.store_id AND datetime(starts_at)<datetime(OLD.ends_at) AND datetime(starts_at, '+' || slot_minutes || ' minutes')>datetime(OLD.starts_at)); END;

CREATE TRIGGER rt_inventory_reservation_insert AFTER INSERT ON rt_reservations BEGIN UPDATE rt_inventory_slots SET version=version+1, updated_at=datetime('now'), reserved_count=COALESCE((SELECT SUM(r.guest_count) FROM rt_reservations r WHERE r.store_id=rt_inventory_slots.store_id AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR datetime(r.hold_expires_at)>datetime('now')) AND datetime(r.starts_at)<datetime(rt_inventory_slots.starts_at, '+' || rt_inventory_slots.slot_minutes || ' minutes') AND datetime(r.ends_at)>datetime(rt_inventory_slots.starts_at)),0) WHERE (store_id=NEW.store_id AND datetime(starts_at)<datetime(NEW.ends_at) AND datetime(starts_at, '+' || slot_minutes || ' minutes')>datetime(NEW.starts_at)); END;

CREATE TRIGGER rt_inventory_reservation_update AFTER UPDATE ON rt_reservations BEGIN UPDATE rt_inventory_slots SET version=version+1, updated_at=datetime('now'), reserved_count=COALESCE((SELECT SUM(r.guest_count) FROM rt_reservations r WHERE r.store_id=rt_inventory_slots.store_id AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR datetime(r.hold_expires_at)>datetime('now')) AND datetime(r.starts_at)<datetime(rt_inventory_slots.starts_at, '+' || rt_inventory_slots.slot_minutes || ' minutes') AND datetime(r.ends_at)>datetime(rt_inventory_slots.starts_at)),0) WHERE (store_id=OLD.store_id AND datetime(starts_at)<datetime(OLD.ends_at) AND datetime(starts_at, '+' || slot_minutes || ' minutes')>datetime(OLD.starts_at)) OR (store_id=NEW.store_id AND datetime(starts_at)<datetime(NEW.ends_at) AND datetime(starts_at, '+' || slot_minutes || ' minutes')>datetime(NEW.starts_at)); END;

CREATE TRIGGER rt_inventory_rules_apply AFTER UPDATE OF total_capacity,reserved_count ON rt_inventory_slots WHEN EXISTS(SELECT 1 FROM rt_inventory_rules WHERE store_id=NEW.store_id) BEGIN UPDATE rt_inventory_slots SET auto_line_original=CASE WHEN (SELECT stop_line FROM rt_inventory_rules WHERE store_id=NEW.store_id)=1 AND total_capacity-(SELECT occupied_seats+unassigned_guests FROM rt_inventory_occupancy WHERE id=NEW.id)<=(SELECT threshold FROM rt_inventory_rules WHERE store_id=NEW.store_id) THEN COALESCE(auto_line_original,line_capacity) ELSE NULL END, line_capacity=CASE WHEN (SELECT stop_line FROM rt_inventory_rules WHERE store_id=NEW.store_id)=1 AND total_capacity-(SELECT occupied_seats+unassigned_guests FROM rt_inventory_occupancy WHERE id=NEW.id)<=(SELECT threshold FROM rt_inventory_rules WHERE store_id=NEW.store_id) THEN 0 ELSE COALESCE(auto_line_original,line_capacity) END, auto_same_day_original=CASE WHEN (SELECT stop_same_day FROM rt_inventory_rules WHERE store_id=NEW.store_id)=1 AND total_capacity-(SELECT occupied_seats+unassigned_guests FROM rt_inventory_occupancy WHERE id=NEW.id)<=(SELECT threshold FROM rt_inventory_rules WHERE store_id=NEW.store_id) THEN COALESCE(auto_same_day_original,same_day_capacity) ELSE NULL END, same_day_capacity=CASE WHEN (SELECT stop_same_day FROM rt_inventory_rules WHERE store_id=NEW.store_id)=1 AND total_capacity-(SELECT occupied_seats+unassigned_guests FROM rt_inventory_occupancy WHERE id=NEW.id)<=(SELECT threshold FROM rt_inventory_rules WHERE store_id=NEW.store_id) THEN 0 ELSE COALESCE(auto_same_day_original,same_day_capacity) END, version=version+1,updated_at=datetime('now') WHERE id=NEW.id; END;

CREATE TRIGGER rt_inventory_rules_changed AFTER INSERT ON rt_inventory_rules BEGIN INSERT INTO rt_inventory_rule_queue(store_id,cause) VALUES(NEW.store_id,'rules_saved') ON CONFLICT(store_id) DO UPDATE SET generation=generation+1,cause=excluded.cause,updated_at=datetime('now'); UPDATE rt_inventory_slots SET reserved_count=reserved_count WHERE store_id=NEW.store_id; END;

CREATE TRIGGER rt_inventory_rules_log AFTER UPDATE OF line_capacity,same_day_capacity ON rt_inventory_slots WHEN (OLD.line_capacity<>NEW.line_capacity OR OLD.same_day_capacity<>NEW.same_day_capacity) AND (OLD.auto_line_original IS NOT NULL OR NEW.auto_line_original IS NOT NULL OR OLD.auto_same_day_original IS NOT NULL OR NEW.auto_same_day_original IS NOT NULL) BEGIN INSERT INTO rt_inventory_rule_log(store_id,slot_id,starts_at,before_line,after_line,before_same_day,after_same_day,cause) VALUES(NEW.store_id,NEW.id,NEW.starts_at,OLD.line_capacity,NEW.line_capacity,OLD.same_day_capacity,NEW.same_day_capacity, COALESCE((SELECT cause FROM rt_inventory_rule_queue WHERE store_id=NEW.store_id),'inventory_recalculated')); END;

CREATE TRIGGER rt_inventory_rules_slot_insert AFTER INSERT ON rt_inventory_slots BEGIN UPDATE rt_inventory_slots SET reserved_count=COALESCE((SELECT guest_count FROM rt_inventory_occupancy WHERE id=NEW.id),0) WHERE id=NEW.id; INSERT INTO rt_inventory_rule_queue(store_id,cause) VALUES(NEW.store_id,'inventory_generated') ON CONFLICT(store_id) DO UPDATE SET generation=generation+1,cause=excluded.cause,updated_at=datetime('now'); END;

CREATE TRIGGER rt_inventory_rules_updated AFTER UPDATE ON rt_inventory_rules BEGIN INSERT INTO rt_inventory_rule_queue(store_id,cause) VALUES(NEW.store_id,'rules_saved') ON CONFLICT(store_id) DO UPDATE SET generation=generation+1,cause=excluded.cause,updated_at=datetime('now'); UPDATE rt_inventory_slots SET reserved_count=reserved_count WHERE store_id=NEW.store_id; END;

CREATE TRIGGER rt_inventory_slot_insert AFTER INSERT ON rt_inventory_slots BEGIN UPDATE rt_inventory_slots SET total_capacity = COALESCE((SELECT SUM(max_capacity) FROM rt_tables WHERE store_id = NEW.store_id AND is_active = 1), 0) WHERE id = NEW.id; END;

CREATE TRIGGER rt_inventory_source_delete AFTER DELETE ON rt_reservations BEGIN  INSERT INTO rt_inventory_rule_source_events(store_id,slot_id,reservation_id,source,event)  SELECT i.store_id,i.id,OLD.id,OLD.source,'delete' FROM rt_inventory_slots i WHERE (i.store_id=OLD.store_id AND julianday(i.starts_at)<julianday(OLD.ends_at) AND julianday(i.starts_at,'+'||i.slot_minutes||' minutes')>julianday(OLD.starts_at)); END;

CREATE TRIGGER rt_inventory_source_insert AFTER INSERT ON rt_reservations BEGIN  INSERT INTO rt_inventory_rule_source_events(store_id,slot_id,reservation_id,source,event)  SELECT i.store_id,i.id,NEW.id,NEW.source,'insert' FROM rt_inventory_slots i WHERE (i.store_id=NEW.store_id AND julianday(i.starts_at)<julianday(NEW.ends_at) AND julianday(i.starts_at,'+'||i.slot_minutes||' minutes')>julianday(NEW.starts_at)); END;

CREATE TRIGGER rt_inventory_source_update AFTER UPDATE ON rt_reservations WHEN OLD.store_id IS NOT NEW.store_id OR OLD.source IS NOT NEW.source OR OLD.starts_at IS NOT NEW.starts_at OR OLD.ends_at IS NOT NEW.ends_at OR OLD.guest_count IS NOT NEW.guest_count OR OLD.table_id IS NOT NEW.table_id OR OLD.status IS NOT NEW.status OR OLD.hold_expires_at IS NOT NEW.hold_expires_at OR OLD.departed_at IS NOT NEW.departed_at BEGIN INSERT INTO rt_inventory_rule_source_events(store_id,slot_id,reservation_id,source,event) SELECT i.store_id,i.id,OLD.id,OLD.source,'update' FROM rt_inventory_slots i WHERE i.store_id=OLD.store_id AND julianday(i.starts_at)<julianday(OLD.ends_at) AND julianday(i.starts_at,'+'||i.slot_minutes||' minutes')>julianday(OLD.starts_at) UNION SELECT i.store_id,i.id,NEW.id,NEW.source,'update' FROM rt_inventory_slots i WHERE i.store_id=NEW.store_id AND julianday(i.starts_at)<julianday(NEW.ends_at) AND julianday(i.starts_at,'+'||i.slot_minutes||' minutes')>julianday(NEW.starts_at); END;

CREATE TRIGGER rt_inventory_table_delete AFTER DELETE ON rt_tables BEGIN UPDATE rt_inventory_slots SET total_capacity = COALESCE((SELECT SUM(max_capacity) FROM rt_tables WHERE store_id = OLD.store_id AND is_active = 1), 0), version = version + 1, updated_at = datetime('now') WHERE store_id = OLD.store_id; END;

CREATE TRIGGER rt_inventory_table_insert AFTER INSERT ON rt_tables BEGIN UPDATE rt_inventory_slots SET total_capacity = COALESCE((SELECT SUM(max_capacity) FROM rt_tables WHERE store_id = NEW.store_id AND is_active = 1), 0), version = version + 1, updated_at = datetime('now') WHERE store_id = NEW.store_id; END;

CREATE TRIGGER rt_inventory_table_update AFTER UPDATE OF max_capacity, is_active, store_id ON rt_tables BEGIN UPDATE rt_inventory_slots SET total_capacity = COALESCE((SELECT SUM(max_capacity) FROM rt_tables WHERE store_id = rt_inventory_slots.store_id AND is_active = 1), 0), version = version + 1, updated_at = datetime('now') WHERE store_id IN (OLD.store_id, NEW.store_id); END;

CREATE TRIGGER rt_membership_login_policy AFTER UPDATE OF role,is_active,invite_status ON staff_members BEGIN UPDATE rt_memberships SET role=CASE NEW.role WHEN 'owner' THEN 'super_admin' WHEN 'admin' THEN 'store_manager' ELSE 'staff' END,status=CASE WHEN NEW.is_active=0 THEN 'suspended' WHEN NEW.invite_status='active' THEN 'active' ELSE 'invited' END,updated_at=datetime('now') WHERE staff_id=NEW.id; END;

CREATE TRIGGER rt_membership_login_scope AFTER UPDATE OF account_scope ON staff_members BEGIN UPDATE rt_memberships SET store_id=CASE WHEN (SELECT account_scope FROM staff_members WHERE id=NEW.id)='all' THEN NULL ELSE COALESCE((SELECT s.id FROM rt_stores s JOIN staff_account_scopes a ON a.line_account_id=s.line_account_id WHERE a.staff_id=NEW.id AND s.organization_id=rt_memberships.organization_id AND s.id=rt_memberships.store_id LIMIT 1),(SELECT s.id FROM rt_stores s JOIN staff_account_scopes a ON a.line_account_id=s.line_account_id WHERE a.staff_id=NEW.id AND s.organization_id=rt_memberships.organization_id ORDER BY s.code LIMIT 1)) END,updated_at=datetime('now') WHERE staff_id=NEW.id; END;

CREATE TRIGGER rt_membership_login_scope_add AFTER INSERT ON staff_account_scopes BEGIN UPDATE rt_memberships SET store_id=CASE WHEN (SELECT account_scope FROM staff_members WHERE id=NEW.staff_id)='all' THEN NULL ELSE COALESCE((SELECT s.id FROM rt_stores s JOIN staff_account_scopes a ON a.line_account_id=s.line_account_id WHERE a.staff_id=NEW.staff_id AND s.organization_id=rt_memberships.organization_id AND s.id=rt_memberships.store_id LIMIT 1),(SELECT s.id FROM rt_stores s JOIN staff_account_scopes a ON a.line_account_id=s.line_account_id WHERE a.staff_id=NEW.staff_id AND s.organization_id=rt_memberships.organization_id ORDER BY s.code LIMIT 1)) END,updated_at=datetime('now') WHERE staff_id=NEW.staff_id; END;

CREATE TRIGGER rt_membership_login_scope_remove AFTER DELETE ON staff_account_scopes BEGIN UPDATE rt_memberships SET store_id=CASE WHEN (SELECT account_scope FROM staff_members WHERE id=OLD.staff_id)='all' THEN NULL ELSE COALESCE((SELECT s.id FROM rt_stores s JOIN staff_account_scopes a ON a.line_account_id=s.line_account_id WHERE a.staff_id=OLD.staff_id AND s.organization_id=rt_memberships.organization_id AND s.id=rt_memberships.store_id LIMIT 1),(SELECT s.id FROM rt_stores s JOIN staff_account_scopes a ON a.line_account_id=s.line_account_id WHERE a.staff_id=OLD.staff_id AND s.organization_id=rt_memberships.organization_id ORDER BY s.code LIMIT 1)) END,updated_at=datetime('now') WHERE staff_id=OLD.staff_id; END;

CREATE TRIGGER rt_menu_change_apply AFTER UPDATE OF status ON rt_menu_change_requests WHEN OLD.status IN ('pending','approved') AND NEW.status='approved' AND (NEW.effective_at IS NULL OR datetime(NEW.effective_at)<=datetime('now')) BEGIN UPDATE rt_menu_items SET price=NEW.after_price,updated_at=datetime('now') WHERE id=NEW.menu_id AND store_id=NEW.store_id AND price=NEW.before_price; UPDATE rt_menu_change_requests SET status=CASE WHEN changes()=1 THEN 'applied' ELSE 'failed' END,failure_reason=CASE WHEN changes()=1 THEN NULL ELSE 'メニューが変更または削除されています。再申請してください' END,updated_at=datetime('now') WHERE id=NEW.id; END;

CREATE TRIGGER rt_menu_change_review AFTER UPDATE OF status ON rt_approval_requests WHEN NEW.kind = 'menu_change' AND OLD.status = 'pending' AND NEW.status IN ('approved', 'returned') BEGIN UPDATE rt_menu_change_requests SET status = NEW.status, return_reason = CASE WHEN NEW.status = 'returned' THEN NEW.review_comment ELSE NULL END, updated_at = datetime('now') WHERE approval_id = NEW.id AND status = 'pending'; END;

CREATE TRIGGER rt_menu_published_insert AFTER INSERT ON rt_menu_items WHEN NEW.status = 'active' BEGIN UPDATE rt_menu_items SET published_once = 1 WHERE id = NEW.id; END;

CREATE TRIGGER rt_menu_published_update AFTER UPDATE OF status ON rt_menu_items WHEN NEW.status = 'active' BEGIN UPDATE rt_menu_items SET published_once = 1 WHERE id = NEW.id; END;

CREATE TRIGGER rt_notice_booking_change AFTER UPDATE OF starts_at,ends_at,guest_count,status ON rt_reservations WHEN NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at OR NEW.guest_count IS NOT OLD.guest_count OR (NEW.status IN('cancelled','no_show') AND NEW.status IS NOT OLD.status) BEGIN UPDATE rt_customer_notice_outbox SET valid=0 WHERE reservation_id=NEW.id AND sent_at IS NULL; END;

CREATE TRIGGER rt_referral_member_org BEFORE INSERT ON rt_store_group_members
WHEN NOT EXISTS(SELECT 1 FROM rt_store_groups g JOIN rt_stores s ON s.organization_id=g.organization_id WHERE g.id=NEW.group_id AND s.id=NEW.store_id)
BEGIN SELECT RAISE(ABORT,'referral_organization_conflict'); END;

CREATE TRIGGER rt_referral_member_org_update BEFORE UPDATE ON rt_store_group_members
WHEN NOT EXISTS(SELECT 1 FROM rt_store_groups g JOIN rt_stores s ON s.organization_id=g.organization_id WHERE g.id=NEW.group_id AND s.id=NEW.store_id)
BEGIN SELECT RAISE(ABORT,'referral_organization_conflict'); END;

CREATE TRIGGER rt_reservation_event_insert AFTER INSERT ON rt_reservations WHEN NEW.status IN('confirmed','seated','visited') BEGIN INSERT OR IGNORE INTO rt_reservation_events(id,reservation_id,store_id,event_type,reservation_version,occurred_at,request_id,line_account_id,friend_id,payload_json) SELECT 'rt:'||NEW.id||':'||NEW.customer_version||':restaurant.reservation.created',NEW.id,NEW.store_id,'restaurant.reservation.created',NEW.customer_version,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NEW.id||':'||NEW.customer_version,s.line_account_id, (SELECT id FROM friends WHERE line_account_id=s.line_account_id AND line_user_id=NEW.line_uid), json_object('reservationId',NEW.id,'storeId',NEW.store_id,'startsAt',NEW.starts_at,'endsAt',NEW.ends_at,'status',NEW.status,'guestCount',NEW.guest_count) FROM rt_stores s WHERE s.id=NEW.store_id; END;

CREATE TRIGGER rt_reservation_event_update AFTER UPDATE OF customer_version ON rt_reservations WHEN NEW.customer_version>OLD.customer_version BEGIN INSERT OR IGNORE INTO rt_reservation_events(id,reservation_id,store_id,event_type,reservation_version,occurred_at,request_id,line_account_id,friend_id,payload_json) SELECT 'rt:'||NEW.id||':'||NEW.customer_version||':'|| CASE WHEN NEW.departed_at IS NOT OLD.departed_at THEN CASE WHEN NEW.departed_at IS NULL THEN 'restaurant.departure_undone' ELSE 'restaurant.departed' END WHEN NEW.status IN('cancelled','no_show') AND NEW.status IS NOT OLD.status THEN 'restaurant.reservation.cancelled' WHEN NEW.status='visited' AND OLD.status<>'visited' THEN 'restaurant.arrived' WHEN OLD.status IN('visited','seated') AND NEW.status='confirmed' THEN 'restaurant.arrival_undone' WHEN OLD.status='pending' AND NEW.status='confirmed' THEN 'restaurant.reservation.created' ELSE 'restaurant.reservation.changed' END, NEW.id,NEW.store_id, CASE WHEN NEW.departed_at IS NOT OLD.departed_at THEN CASE WHEN NEW.departed_at IS NULL THEN 'restaurant.departure_undone' ELSE 'restaurant.departed' END WHEN NEW.status IN('cancelled','no_show') AND NEW.status IS NOT OLD.status THEN 'restaurant.reservation.cancelled' WHEN NEW.status='visited' AND OLD.status<>'visited' THEN 'restaurant.arrived' WHEN OLD.status IN('visited','seated') AND NEW.status='confirmed' THEN 'restaurant.arrival_undone' WHEN OLD.status='pending' AND NEW.status='confirmed' THEN 'restaurant.reservation.created' ELSE 'restaurant.reservation.changed' END, NEW.customer_version,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NEW.id||':'||NEW.customer_version,s.line_account_id, (SELECT id FROM friends WHERE line_account_id=s.line_account_id AND line_user_id=NEW.line_uid), json_object('reservationId',NEW.id,'storeId',NEW.store_id,'startsAt',NEW.starts_at,'endsAt',NEW.ends_at,'status',NEW.status,'guestCount',NEW.guest_count,'departedAt',NEW.departed_at,'previousVersion',OLD.customer_version, 'scheduleChanged',NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at OR NEW.guest_count IS NOT OLD.guest_count) FROM rt_stores s WHERE s.id=NEW.store_id; END;

CREATE TRIGGER rt_reservation_hold_insert BEFORE INSERT ON rt_reservations WHEN NEW.table_id IS NOT NULL AND NEW.status NOT IN ('cancelled', 'no_show') AND NEW.departed_at IS NULL AND EXISTS (SELECT 1 FROM rt_reservations r WHERE r.store_id = NEW.store_id AND r.table_id = NEW.table_id AND r.status NOT IN ('cancelled', 'no_show') AND r.departed_at IS NULL AND datetime(r.starts_at) < datetime(NEW.ends_at) AND datetime(r.ends_at) > datetime(NEW.starts_at) AND (NEW.hold_expires_at IS NOT NULL OR r.hold_expires_at IS NOT NULL) AND (r.hold_expires_at IS NULL OR r.status <> 'pending' OR datetime(r.hold_expires_at) > datetime('now'))) BEGIN SELECT RAISE(ABORT, 'restaurant_table_conflict'); END;

CREATE TRIGGER rt_reservation_hold_update BEFORE UPDATE OF departed_at,table_id, starts_at, ends_at, status ON rt_reservations WHEN NEW.table_id IS NOT NULL AND NEW.status NOT IN ('cancelled', 'no_show') AND NEW.departed_at IS NULL AND EXISTS (SELECT 1 FROM rt_reservations r WHERE r.id <> NEW.id AND r.store_id = NEW.store_id AND r.table_id = NEW.table_id AND r.status NOT IN ('cancelled', 'no_show') AND r.departed_at IS NULL AND datetime(r.starts_at) < datetime(NEW.ends_at) AND datetime(r.ends_at) > datetime(NEW.starts_at) AND (NEW.hold_expires_at IS NOT NULL OR r.hold_expires_at IS NOT NULL) AND (r.hold_expires_at IS NULL OR r.status <> 'pending' OR datetime(r.hold_expires_at) > datetime('now'))) BEGIN SELECT RAISE(ABORT, 'restaurant_table_conflict'); END;

CREATE TRIGGER rt_reservation_table_links_guard BEFORE INSERT ON rt_reservation_table_links WHEN EXISTS(SELECT 1 FROM rt_reservations r WHERE r.id=NEW.reservation_id AND r.status NOT IN('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR julianday(r.hold_expires_at)>julianday('now')) AND ( NOT EXISTS(SELECT 1 FROM rt_tables t WHERE t.id=NEW.table_id AND t.store_id=r.store_id AND t.is_active=1) OR EXISTS(SELECT 1 FROM rt_reservations other JOIN rt_reservation_table_links l ON l.reservation_id=other.id WHERE other.id<>r.id AND l.table_id=NEW.table_id AND other.status NOT IN('cancelled','no_show') AND other.departed_at IS NULL AND (other.status<>'pending' OR other.hold_expires_at IS NULL OR julianday(other.hold_expires_at)>julianday('now')) AND julianday(other.starts_at)<julianday(r.ends_at) AND julianday(other.ends_at)>julianday(r.starts_at)) OR EXISTS(SELECT 1 FROM rt_seat_waitlist other JOIN rt_seat_waitlist_table_links l ON l.waitlist_id=other.id WHERE l.table_id=NEW.table_id AND other.status='invited' AND julianday(other.hold_expires_at)>julianday('now') AND julianday(other.starts_at)<julianday(r.ends_at) AND julianday(COALESCE(other.ends_at,datetime(other.starts_at,'+120 minutes')))>julianday(r.starts_at)) OR EXISTS(SELECT 1 FROM rt_closures c,json_each(c.periods_json) p WHERE c.store_id=r.store_id AND c.archived_at IS NULL AND (json_array_length(c.table_ids_json)=0 OR NEW.table_id IN(SELECT value FROM json_each(c.table_ids_json))) AND julianday(json_extract(p.value,'$.startsAt'))<julianday(r.ends_at) AND julianday(json_extract(p.value,'$.endsAt'))>julianday(r.starts_at)) )) BEGIN SELECT RAISE(ABORT,'restaurant_table_conflict'); END;

CREATE TRIGGER rt_reservation_version AFTER UPDATE ON rt_reservations WHEN NEW.customer_version=OLD.customer_version AND ( NEW.customer_name IS NOT OLD.customer_name OR NEW.customer_phone IS NOT OLD.customer_phone OR NEW.guest_count IS NOT OLD.guest_count OR NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at OR NEW.table_id IS NOT OLD.table_id OR NEW.course_id IS NOT OLD.course_id OR NEW.status IS NOT OLD.status OR NEW.allergy_note IS NOT OLD.allergy_note OR NEW.note IS NOT OLD.note OR NEW.hold_expires_at IS NOT OLD.hold_expires_at) BEGIN UPDATE rt_reservations SET customer_version=OLD.customer_version+1 WHERE id=NEW.id; END;

CREATE TRIGGER rt_reservations_linked_insert AFTER INSERT ON rt_reservations BEGIN DELETE FROM rt_reservation_table_links WHERE reservation_id=NEW.id; INSERT INTO rt_reservation_table_links(reservation_id,table_id) SELECT NEW.id,t.id FROM rt_tables t JOIN rt_tables main ON main.id=NEW.table_id WHERE t.store_id=NEW.store_id AND (t.id=main.id OR (NEW.guest_count>main.max_capacity AND main.join_group IS NOT NULL AND t.join_group=main.join_group)); END;

CREATE TRIGGER rt_reservations_linked_time_update BEFORE UPDATE OF departed_at,starts_at,ends_at,status,hold_expires_at ON rt_reservations WHEN NEW.table_id IS OLD.table_id AND NEW.guest_count=OLD.guest_count AND NEW.status NOT IN('cancelled','no_show') AND NEW.departed_at IS NULL AND (NEW.status<>'pending' OR NEW.hold_expires_at IS NULL OR julianday(NEW.hold_expires_at)>julianday('now')) AND (EXISTS(SELECT 1 FROM rt_reservations r JOIN rt_reservation_table_links l ON l.reservation_id=r.id WHERE r.store_id=NEW.store_id AND r.id<>NEW.id AND r.status NOT IN('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR julianday(r.hold_expires_at)>julianday('now')) AND l.table_id IN (SELECT table_id FROM rt_reservation_table_links WHERE reservation_id=NEW.id) AND julianday(r.starts_at)<julianday(NEW.ends_at) AND julianday(r.ends_at)>julianday(NEW.starts_at)) OR EXISTS(SELECT 1 FROM rt_seat_waitlist w JOIN rt_seat_waitlist_table_links l ON l.waitlist_id=w.id WHERE w.store_id=NEW.store_id AND w.status='invited' AND julianday(w.hold_expires_at)>julianday('now') AND l.table_id IN (SELECT table_id FROM rt_reservation_table_links WHERE reservation_id=NEW.id) AND julianday(w.starts_at)<julianday(NEW.ends_at) AND julianday(COALESCE(w.ends_at,datetime(w.starts_at,'+120 minutes')))>julianday(NEW.starts_at))) BEGIN SELECT RAISE(ABORT,'restaurant_table_conflict'); END;

CREATE TRIGGER rt_reservations_linked_update AFTER UPDATE OF table_id,guest_count ON rt_reservations WHEN NEW.table_id IS NOT OLD.table_id OR NEW.guest_count IS NOT OLD.guest_count BEGIN DELETE FROM rt_reservation_table_links WHERE reservation_id=NEW.id; INSERT INTO rt_reservation_table_links(reservation_id,table_id) SELECT NEW.id,t.id FROM rt_tables t JOIN rt_tables main ON main.id=NEW.table_id WHERE t.store_id=NEW.store_id AND (t.id=main.id OR (NEW.guest_count>main.max_capacity AND main.join_group IS NOT NULL AND t.join_group=main.join_group)); END;

CREATE TRIGGER rt_reservations_rule_queue_delete AFTER DELETE ON rt_reservations BEGIN INSERT INTO rt_inventory_rule_queue(store_id,cause) VALUES(OLD.store_id,'rt_reservations:delete:'||OLD.id) ON CONFLICT(store_id) DO UPDATE SET generation=generation+1,cause=excluded.cause,updated_at=datetime('now'); END;

CREATE TRIGGER rt_reservations_rule_queue_insert AFTER INSERT ON rt_reservations BEGIN INSERT INTO rt_inventory_rule_queue(store_id,cause) VALUES(NEW.store_id,'rt_reservations:insert:'||NEW.id) ON CONFLICT(store_id) DO UPDATE SET generation=generation+1,cause=excluded.cause,updated_at=datetime('now'); END;

CREATE TRIGGER rt_reservations_rule_queue_update AFTER UPDATE ON rt_reservations BEGIN INSERT INTO rt_inventory_rule_queue(store_id,cause) VALUES(NEW.store_id,'rt_reservations:update:'||NEW.id) ON CONFLICT(store_id) DO UPDATE SET generation=generation+1,cause=excluded.cause,updated_at=datetime('now'); END;

CREATE TRIGGER rt_seat_waitlist_claim BEFORE UPDATE OF status ON rt_seat_waitlist WHEN NEW.status='invited' AND OLD.status='waiting' AND (EXISTS(SELECT 1 FROM rt_reservations r WHERE r.store_id=NEW.store_id AND r.table_id=NEW.table_id AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR julianday(r.hold_expires_at)>julianday('now')) AND julianday(r.starts_at)<julianday(NEW.ends_at) AND julianday(r.ends_at)>julianday(NEW.starts_at)) OR EXISTS(SELECT 1 FROM rt_seat_waitlist w WHERE w.id<>NEW.id AND w.store_id=NEW.store_id AND w.table_id=NEW.table_id AND w.status='invited' AND julianday(w.hold_expires_at)>julianday('now') AND julianday(w.starts_at)<julianday(NEW.ends_at) AND julianday(w.ends_at)>julianday(NEW.starts_at))) BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER rt_seat_waitlist_conversion AFTER INSERT ON rt_reservations WHEN NEW.waitlist_entry_id IS NOT NULL BEGIN UPDATE rt_seat_waitlist SET status='converted',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.waitlist_entry_id; END;

CREATE TRIGGER rt_seat_waitlist_linked_insert AFTER INSERT ON rt_seat_waitlist BEGIN DELETE FROM rt_seat_waitlist_table_links WHERE waitlist_id=NEW.id; INSERT INTO rt_seat_waitlist_table_links(waitlist_id,table_id) SELECT NEW.id,t.id FROM rt_tables t JOIN rt_tables main ON main.id=NEW.table_id WHERE t.store_id=NEW.store_id AND (t.id=main.id OR (NEW.guest_count>main.max_capacity AND main.join_group IS NOT NULL AND t.join_group=main.join_group)); END;

CREATE TRIGGER rt_seat_waitlist_linked_time_update BEFORE UPDATE OF starts_at,ends_at,status,hold_expires_at ON rt_seat_waitlist WHEN NEW.table_id IS OLD.table_id AND NEW.guest_count=OLD.guest_count AND NEW.status='invited' AND julianday(NEW.hold_expires_at)>julianday('now') AND (EXISTS(SELECT 1 FROM rt_reservations r JOIN rt_reservation_table_links l ON l.reservation_id=r.id WHERE r.store_id=NEW.store_id AND r.status NOT IN('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR julianday(r.hold_expires_at)>julianday('now')) AND l.table_id IN (SELECT table_id FROM rt_seat_waitlist_table_links WHERE waitlist_id=NEW.id) AND julianday(r.starts_at)<julianday(NEW.ends_at) AND julianday(r.ends_at)>julianday(NEW.starts_at)) OR EXISTS(SELECT 1 FROM rt_seat_waitlist w JOIN rt_seat_waitlist_table_links l ON l.waitlist_id=w.id WHERE w.store_id=NEW.store_id AND w.id<>NEW.id AND w.status='invited' AND julianday(w.hold_expires_at)>julianday('now') AND l.table_id IN (SELECT table_id FROM rt_seat_waitlist_table_links WHERE waitlist_id=NEW.id) AND julianday(w.starts_at)<julianday(NEW.ends_at) AND julianday(COALESCE(w.ends_at,datetime(w.starts_at,'+120 minutes')))>julianday(NEW.starts_at))) BEGIN SELECT RAISE(ABORT,'restaurant_table_conflict'); END;

CREATE TRIGGER rt_seat_waitlist_linked_update AFTER UPDATE OF table_id,guest_count ON rt_seat_waitlist WHEN NEW.table_id IS NOT OLD.table_id OR NEW.guest_count IS NOT OLD.guest_count BEGIN DELETE FROM rt_seat_waitlist_table_links WHERE waitlist_id=NEW.id; INSERT INTO rt_seat_waitlist_table_links(waitlist_id,table_id) SELECT NEW.id,t.id FROM rt_tables t JOIN rt_tables main ON main.id=NEW.table_id WHERE t.store_id=NEW.store_id AND (t.id=main.id OR (NEW.guest_count>main.max_capacity AND main.join_group IS NOT NULL AND t.join_group=main.join_group)); END;

CREATE TRIGGER rt_seat_waitlist_registration BEFORE INSERT ON rt_seat_waitlist BEGIN SELECT CASE WHEN julianday(NEW.starts_at)<=julianday('now','+1 hour') THEN RAISE(ABORT,'waitlist_registration_closed') WHEN ((SELECT COUNT(*) FROM booking_waitlist w WHERE w.line_account_id=(SELECT line_account_id FROM rt_stores WHERE id=NEW.store_id) AND w.status IN ('waiting','invited') AND (w.friend_id=(SELECT id FROM friends WHERE line_user_id=NEW.line_uid AND line_account_id=(SELECT line_account_id FROM rt_stores WHERE id=NEW.store_id)) OR (w.booking_customer_id IS NOT NULL AND w.booking_customer_id=NULL))) + (SELECT COUNT(*) FROM rt_seat_waitlist w JOIN rt_stores s ON s.id=w.store_id WHERE s.line_account_id=(SELECT line_account_id FROM rt_stores WHERE id=NEW.store_id) AND w.status IN ('waiting','invited') AND (w.line_uid=NEW.line_uid OR (NEW.line_uid IS NULL AND w.identity_key=NEW.identity_key))))>=3 THEN RAISE(ABORT,'waitlist_limit') END; END;

CREATE TRIGGER rt_seat_waitlist_table_links_guard BEFORE INSERT ON rt_seat_waitlist_table_links WHEN EXISTS(SELECT 1 FROM rt_seat_waitlist w WHERE w.id=NEW.waitlist_id AND w.status='invited' AND julianday(w.hold_expires_at)>julianday('now') AND ( NOT EXISTS(SELECT 1 FROM rt_tables t WHERE t.id=NEW.table_id AND t.store_id=w.store_id AND t.is_active=1) OR EXISTS(SELECT 1 FROM rt_reservations other JOIN rt_reservation_table_links l ON l.reservation_id=other.id WHERE l.table_id=NEW.table_id AND other.status NOT IN('cancelled','no_show') AND other.departed_at IS NULL AND (other.status<>'pending' OR other.hold_expires_at IS NULL OR julianday(other.hold_expires_at)>julianday('now')) AND julianday(other.starts_at)<julianday(w.ends_at) AND julianday(other.ends_at)>julianday(w.starts_at)) OR EXISTS(SELECT 1 FROM rt_seat_waitlist other JOIN rt_seat_waitlist_table_links l ON l.waitlist_id=other.id WHERE other.id<>w.id AND l.table_id=NEW.table_id AND other.status='invited' AND julianday(other.hold_expires_at)>julianday('now') AND julianday(other.starts_at)<julianday(w.ends_at) AND julianday(COALESCE(other.ends_at,datetime(other.starts_at,'+120 minutes')))>julianday(w.starts_at)) OR EXISTS(SELECT 1 FROM rt_closures c,json_each(c.periods_json) p WHERE c.store_id=w.store_id AND c.archived_at IS NULL AND (json_array_length(c.table_ids_json)=0 OR NEW.table_id IN(SELECT value FROM json_each(c.table_ids_json))) AND julianday(json_extract(p.value,'$.startsAt'))<julianday(w.ends_at) AND julianday(json_extract(p.value,'$.endsAt'))>julianday(w.starts_at)) )) BEGIN SELECT RAISE(ABORT,'restaurant_table_conflict'); END;

CREATE TRIGGER rt_tables_rule_queue_delete AFTER DELETE ON rt_tables BEGIN INSERT INTO rt_inventory_rule_queue(store_id,cause) VALUES(OLD.store_id,'rt_tables:delete:'||OLD.id) ON CONFLICT(store_id) DO UPDATE SET generation=generation+1,cause=excluded.cause,updated_at=datetime('now'); END;

CREATE TRIGGER rt_tables_rule_queue_insert AFTER INSERT ON rt_tables BEGIN INSERT INTO rt_inventory_rule_queue(store_id,cause) VALUES(NEW.store_id,'rt_tables:insert:'||NEW.id) ON CONFLICT(store_id) DO UPDATE SET generation=generation+1,cause=excluded.cause,updated_at=datetime('now'); END;

CREATE TRIGGER rt_tables_rule_queue_update AFTER UPDATE ON rt_tables BEGIN INSERT INTO rt_inventory_rule_queue(store_id,cause) VALUES(NEW.store_id,'rt_tables:update:'||NEW.id) ON CONFLICT(store_id) DO UPDATE SET generation=generation+1,cause=excluded.cause,updated_at=datetime('now'); END;

CREATE TRIGGER rt_waitlist_invite_event AFTER UPDATE OF status ON rt_seat_waitlist WHEN NEW.status='invited' AND OLD.status='waiting' BEGIN INSERT OR IGNORE INTO rt_reservation_events(id,store_id,event_type,reservation_version,occurred_at,request_id,line_account_id,friend_id,payload_json) SELECT 'rt-waitlist:'||NEW.id||':'||NEW.notification_retry_key,NEW.store_id,'restaurant.waitlist.invited',0,NEW.invited_at,NEW.notification_retry_key,s.line_account_id, (SELECT id FROM friends WHERE line_account_id=s.line_account_id AND line_user_id=NEW.line_uid), json_object('waitlistId',NEW.id,'storeId',NEW.store_id,'startsAt',NEW.starts_at,'holdExpiresAt',NEW.hold_expires_at) FROM rt_stores s WHERE s.id=NEW.store_id; END;

CREATE TRIGGER rt_waitlist_reservation_insert BEFORE INSERT ON rt_reservations WHEN NEW.status NOT IN ('cancelled','no_show') AND NEW.departed_at IS NULL AND ((NEW.waitlist_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_seat_waitlist w JOIN rt_reservations r ON r.waitlist_entry_id=w.id WHERE r.id=NEW.id AND w.id=NEW.waitlist_entry_id AND w.status='converted') AND NOT EXISTS(SELECT 1 FROM rt_seat_waitlist w WHERE w.id=NEW.waitlist_entry_id AND w.store_id=NEW.store_id AND w.line_uid=NEW.line_uid AND w.table_id=NEW.table_id AND w.guest_count=NEW.guest_count AND julianday(w.starts_at)=julianday(NEW.starts_at) AND julianday(w.ends_at)=julianday(NEW.ends_at) AND ((w.status='invited' AND julianday(w.hold_expires_at)>julianday('now')) OR (w.status='converted' AND EXISTS(SELECT 1 FROM rt_reservations r WHERE r.id=NEW.id AND r.waitlist_entry_id=w.id))))) OR (EXISTS(SELECT 1 FROM rt_seat_waitlist w WHERE w.store_id=NEW.store_id AND w.status='invited' AND julianday(w.hold_expires_at)>julianday('now') AND COALESCE(NEW.waitlist_entry_id,'')<>w.id AND (NEW.table_id IS NULL OR w.table_id=NEW.table_id) AND julianday(w.starts_at)<julianday(NEW.ends_at) AND julianday(w.ends_at)>julianday(NEW.starts_at))) OR (NEW.waitlist_entry_id IS NOT NULL AND (EXISTS(SELECT 1 FROM rt_reservations r WHERE r.id<>NEW.id AND r.store_id=NEW.store_id AND r.table_id=NEW.table_id AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR julianday(r.hold_expires_at)>julianday('now')) AND julianday(r.starts_at)<julianday(NEW.ends_at) AND julianday(r.ends_at)>julianday(NEW.starts_at))))) BEGIN SELECT RAISE(ABORT,'restaurant_table_conflict'); END;

CREATE TRIGGER rt_waitlist_reservation_update BEFORE UPDATE OF departed_at,table_id,starts_at,ends_at,status ON rt_reservations WHEN NEW.status NOT IN ('cancelled','no_show') AND NEW.departed_at IS NULL AND ((NEW.waitlist_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rt_seat_waitlist w JOIN rt_reservations r ON r.waitlist_entry_id=w.id WHERE r.id=NEW.id AND w.id=NEW.waitlist_entry_id AND w.status='converted') AND NOT EXISTS(SELECT 1 FROM rt_seat_waitlist w WHERE w.id=NEW.waitlist_entry_id AND w.store_id=NEW.store_id AND w.line_uid=NEW.line_uid AND w.table_id=NEW.table_id AND w.guest_count=NEW.guest_count AND julianday(w.starts_at)=julianday(NEW.starts_at) AND julianday(w.ends_at)=julianday(NEW.ends_at) AND ((w.status='invited' AND julianday(w.hold_expires_at)>julianday('now')) OR (w.status='converted' AND EXISTS(SELECT 1 FROM rt_reservations r WHERE r.id=NEW.id AND r.waitlist_entry_id=w.id))))) OR (EXISTS(SELECT 1 FROM rt_seat_waitlist w WHERE w.store_id=NEW.store_id AND w.status='invited' AND julianday(w.hold_expires_at)>julianday('now') AND COALESCE(NEW.waitlist_entry_id,'')<>w.id AND (NEW.table_id IS NULL OR w.table_id=NEW.table_id) AND julianday(w.starts_at)<julianday(NEW.ends_at) AND julianday(w.ends_at)>julianday(NEW.starts_at))) OR (NEW.waitlist_entry_id IS NOT NULL AND (EXISTS(SELECT 1 FROM rt_reservations r WHERE r.id<>NEW.id AND r.store_id=NEW.store_id AND r.table_id=NEW.table_id AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR julianday(r.hold_expires_at)>julianday('now')) AND julianday(r.starts_at)<julianday(NEW.ends_at) AND julianday(r.ends_at)>julianday(NEW.starts_at))))) BEGIN SELECT RAISE(ABORT,'restaurant_table_conflict'); END;

CREATE TRIGGER rt_walkin_arrival_event AFTER INSERT ON rt_seat_visit_marks WHEN NEW.kind='visited' AND NEW.undone_at IS NULL BEGIN INSERT OR IGNORE INTO rt_reservation_events(id,reservation_id,store_id,event_type,reservation_version,occurred_at,request_id,line_account_id,friend_id,payload_json) SELECT 'rt:'||r.id||':'||r.customer_version||':restaurant.arrived',r.id,r.store_id,'restaurant.arrived',r.customer_version,NEW.marked_at,COALESCE(NEW.request_id,NEW.id),s.line_account_id,(SELECT id FROM friends WHERE line_account_id=s.line_account_id AND line_user_id=r.line_uid),json_object('reservationId',r.id,'storeId',r.store_id,'startsAt',r.starts_at,'endsAt',r.ends_at,'status',r.status,'guestCount',r.guest_count) FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id WHERE r.id=NEW.reservation_id AND r.status IN('visited','seated'); END;

CREATE TRIGGER style_booking_meeting_snapshot AFTER INSERT ON bookings
WHEN NEW.meeting_mode IS NULL OR NEW.meeting_location IS NULL
BEGIN UPDATE bookings SET meeting_mode=COALESCE(NEW.meeting_mode,(SELECT CASE WHEN meeting_mode='customer_choice' THEN NULL ELSE meeting_mode END FROM menus WHERE id=NEW.menu_id AND line_account_id=NEW.line_account_id)),meeting_location=COALESCE(NEW.meeting_location,(SELECT meeting_location FROM menus WHERE id=NEW.menu_id AND line_account_id=NEW.line_account_id)) WHERE id=NEW.id; END;

CREATE TRIGGER style_bookings_stage AFTER UPDATE OF consultation_outcome ON bookings
 WHEN NEW.consultation_outcome IS NOT NULL AND NEW.consultation_outcome IS NOT OLD.consultation_outcome AND NEW.friend_id IS NOT NULL
 BEGIN INSERT INTO tags(id,name,line_account_id,normalized_name) SELECT lower(hex(randomblob(16))),CASE NEW.consultation_outcome WHEN 'considering' THEN '面談：検討中' WHEN 'won' THEN '面談：成約' ELSE '面談：見送り' END,NEW.line_account_id,CASE NEW.consultation_outcome WHEN 'considering' THEN '面談：検討中' WHEN 'won' THEN '面談：成約' ELSE '面談：見送り' END WHERE NOT EXISTS(SELECT 1 FROM tags WHERE line_account_id=NEW.line_account_id AND name=CASE NEW.consultation_outcome WHEN 'considering' THEN '面談：検討中' WHEN 'won' THEN '面談：成約' ELSE '面談：見送り' END); DELETE FROM friend_tags WHERE friend_id=NEW.friend_id AND tag_id IN(SELECT id FROM tags WHERE line_account_id=NEW.line_account_id AND name IN('面談：検討中','面談：成約','面談：見送り')); INSERT OR IGNORE INTO friend_tags(friend_id,tag_id) SELECT NEW.friend_id,id FROM tags WHERE line_account_id=NEW.line_account_id AND name=CASE NEW.consultation_outcome WHEN 'considering' THEN '面談：検討中' WHEN 'won' THEN '面談：成約' ELSE '面談：見送り' END; END;

CREATE TRIGGER style_event_bookings_insert_capacity BEFORE INSERT ON event_bookings
WHEN NEW.status IN('requested','confirmed') AND EXISTS(SELECT 1 FROM event_slots s WHERE s.id=NEW.slot_id AND (s.classroom_capacity IS NOT NULL OR s.online_capacity IS NOT NULL)
 AND CASE WHEN NEW.participation_mode='classroom' THEN s.classroom_capacity ELSE s.online_capacity END IS NOT NULL
 AND COALESCE((SELECT SUM(b.party_size) FROM event_bookings b WHERE b.slot_id=s.id AND b.id<>NEW.id AND b.participation_mode=NEW.participation_mode AND b.status IN('requested','confirmed')),0)
 + COALESCE((SELECT SUM(w.party_size) FROM event_waitlist w WHERE w.slot_id=s.id AND w.participation_mode=NEW.participation_mode AND w.status IN('offered','accepted') AND w.identity_key IS NOT NEW.identity_key),0)
 + NEW.party_size > CASE WHEN NEW.participation_mode='classroom' THEN s.classroom_capacity ELSE s.online_capacity END)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER style_event_bookings_update_capacity BEFORE UPDATE ON event_bookings
WHEN NEW.status IN('requested','confirmed') AND EXISTS(SELECT 1 FROM event_slots s WHERE s.id=NEW.slot_id AND (s.classroom_capacity IS NOT NULL OR s.online_capacity IS NOT NULL)
 AND CASE WHEN NEW.participation_mode='classroom' THEN s.classroom_capacity ELSE s.online_capacity END IS NOT NULL
 AND COALESCE((SELECT SUM(b.party_size) FROM event_bookings b WHERE b.slot_id=s.id AND b.id<>NEW.id AND b.participation_mode=NEW.participation_mode AND b.status IN('requested','confirmed')),0)
 + COALESCE((SELECT SUM(w.party_size) FROM event_waitlist w WHERE w.slot_id=s.id AND w.participation_mode=NEW.participation_mode AND w.status IN('offered','accepted') AND w.identity_key IS NOT NEW.identity_key),0)
 + NEW.party_size > CASE WHEN NEW.participation_mode='classroom' THEN s.classroom_capacity ELSE s.online_capacity END)
BEGIN SELECT RAISE(ABORT,'style_mode_capacity_full'); END;

CREATE TRIGGER style_event_waitlist_insert_capacity BEFORE INSERT ON event_waitlist
WHEN NEW.status IN('offered','accepted') AND EXISTS(SELECT 1 FROM event_slots s WHERE s.id=NEW.slot_id AND (s.classroom_capacity IS NOT NULL OR s.online_capacity IS NOT NULL)
 AND CASE WHEN NEW.participation_mode='classroom' THEN s.classroom_capacity ELSE s.online_capacity END IS NOT NULL
 AND COALESCE((SELECT SUM(b.party_size) FROM event_waitlist b WHERE b.slot_id=s.id AND b.id<>NEW.id AND b.participation_mode=NEW.participation_mode AND b.status IN('offered','accepted')),0)
 + COALESCE((SELECT SUM(w.party_size) FROM event_bookings w WHERE w.slot_id=s.id AND w.participation_mode=NEW.participation_mode AND w.status IN('requested','confirmed') AND w.identity_key IS NOT NEW.identity_key),0)
 + NEW.party_size > CASE WHEN NEW.participation_mode='classroom' THEN s.classroom_capacity ELSE s.online_capacity END)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER style_event_waitlist_update_capacity BEFORE UPDATE ON event_waitlist
WHEN NEW.status IN('offered','accepted') AND EXISTS(SELECT 1 FROM event_slots s WHERE s.id=NEW.slot_id AND (s.classroom_capacity IS NOT NULL OR s.online_capacity IS NOT NULL)
 AND CASE WHEN NEW.participation_mode='classroom' THEN s.classroom_capacity ELSE s.online_capacity END IS NOT NULL
 AND COALESCE((SELECT SUM(b.party_size) FROM event_waitlist b WHERE b.slot_id=s.id AND b.id<>NEW.id AND b.participation_mode=NEW.participation_mode AND b.status IN('offered','accepted')),0)
 + COALESCE((SELECT SUM(w.party_size) FROM event_bookings w WHERE w.slot_id=s.id AND w.participation_mode=NEW.participation_mode AND w.status IN('requested','confirmed') AND w.identity_key IS NOT NEW.identity_key),0)
 + NEW.party_size > CASE WHEN NEW.participation_mode='classroom' THEN s.classroom_capacity ELSE s.online_capacity END)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER style_meet_consultations_stage AFTER UPDATE OF consultation_outcome ON meet_consultations
 WHEN NEW.consultation_outcome IS NOT NULL AND NEW.consultation_outcome IS NOT OLD.consultation_outcome AND 1=1
 BEGIN INSERT INTO tags(id,name,line_account_id,normalized_name) SELECT lower(hex(randomblob(16))),CASE NEW.consultation_outcome WHEN 'considering' THEN '面談：検討中' WHEN 'won' THEN '面談：成約' ELSE '面談：見送り' END,(SELECT line_account_id FROM friends WHERE id=NEW.friend_id),CASE NEW.consultation_outcome WHEN 'considering' THEN '面談：検討中' WHEN 'won' THEN '面談：成約' ELSE '面談：見送り' END WHERE NOT EXISTS(SELECT 1 FROM tags WHERE line_account_id=(SELECT line_account_id FROM friends WHERE id=NEW.friend_id) AND name=CASE NEW.consultation_outcome WHEN 'considering' THEN '面談：検討中' WHEN 'won' THEN '面談：成約' ELSE '面談：見送り' END); DELETE FROM friend_tags WHERE friend_id=NEW.friend_id AND tag_id IN(SELECT id FROM tags WHERE line_account_id=(SELECT line_account_id FROM friends WHERE id=NEW.friend_id) AND name IN('面談：検討中','面談：成約','面談：見送り')); INSERT OR IGNORE INTO friend_tags(friend_id,tag_id) SELECT NEW.friend_id,id FROM tags WHERE line_account_id=(SELECT line_account_id FROM friends WHERE id=NEW.friend_id) AND name=CASE NEW.consultation_outcome WHEN 'considering' THEN '面談：検討中' WHEN 'won' THEN '面談：成約' ELSE '面談：見送り' END; END;

CREATE TRIGGER style_membership_insert AFTER INSERT ON lesson_memberships
 BEGIN INSERT INTO tags(id,name,line_account_id,normalized_name) SELECT lower(hex(randomblob(16))),'会員',NEW.line_account_id,'会員' WHERE NEW.ended_at IS NULL AND NOT EXISTS(SELECT 1 FROM tags WHERE line_account_id=NEW.line_account_id AND name='会員'); INSERT OR IGNORE INTO friend_tags(friend_id,tag_id,assigned_at) SELECT NEW.friend_id,id,NEW.joined_at FROM tags WHERE NEW.ended_at IS NULL AND line_account_id=NEW.line_account_id AND name='会員'; DELETE FROM friend_tags WHERE NEW.ended_at IS NOT NULL AND friend_id=NEW.friend_id AND tag_id IN(SELECT id FROM tags WHERE line_account_id=NEW.line_account_id AND name='会員'); END;

CREATE TRIGGER style_membership_update AFTER UPDATE ON lesson_memberships
 BEGIN INSERT INTO tags(id,name,line_account_id,normalized_name) SELECT lower(hex(randomblob(16))),'会員',NEW.line_account_id,'会員' WHERE NEW.ended_at IS NULL AND NOT EXISTS(SELECT 1 FROM tags WHERE line_account_id=NEW.line_account_id AND name='会員'); INSERT OR IGNORE INTO friend_tags(friend_id,tag_id,assigned_at) SELECT NEW.friend_id,id,NEW.joined_at FROM tags WHERE NEW.ended_at IS NULL AND line_account_id=NEW.line_account_id AND name='会員'; DELETE FROM friend_tags WHERE NEW.ended_at IS NOT NULL AND friend_id=NEW.friend_id AND tag_id IN(SELECT id FROM tags WHERE line_account_id=NEW.line_account_id AND name='会員'); END;

CREATE TRIGGER style_slot_capacity_update BEFORE UPDATE OF classroom_capacity,online_capacity ON event_slots
WHEN EXISTS(SELECT 1 FROM (SELECT 'classroom' mode,NEW.classroom_capacity capacity UNION ALL SELECT 'online',NEW.online_capacity) c WHERE c.capacity IS NOT NULL
 AND COALESCE((SELECT SUM(party_size) FROM event_bookings b WHERE b.slot_id=NEW.id AND b.participation_mode=c.mode AND b.status IN('requested','confirmed')),0)
 +COALESCE((SELECT SUM(party_size) FROM event_waitlist w WHERE w.slot_id=NEW.id AND w.participation_mode=c.mode AND w.status IN('offered','accepted')),0)>c.capacity)
BEGIN SELECT RAISE(ABORT,'style_mode_capacity_full'); END;

CREATE TRIGGER trg_action_score_published_version_immutable
BEFORE UPDATE ON action_score_rule_versions
WHEN OLD.status = 'published'
BEGIN SELECT RAISE(ABORT, 'published action score version is immutable'); END;

CREATE TRIGGER trg_action_score_published_version_no_delete
BEFORE DELETE ON action_score_rule_versions
WHEN OLD.status = 'published'
BEGIN SELECT RAISE(ABORT, 'published action score version cannot be deleted'); END;

CREATE TRIGGER trg_ad_platforms_account_required_insert
BEFORE INSERT ON ad_platforms
WHEN NEW.line_account_id IS NULL
BEGIN SELECT RAISE(ABORT, 'ad_platforms.line_account_id is required'); END;

CREATE TRIGGER trg_ad_platforms_account_required_update
BEFORE UPDATE OF line_account_id ON ad_platforms
WHEN NEW.line_account_id IS NULL
BEGIN SELECT RAISE(ABORT, 'ad_platforms.line_account_id cannot be cleared'); END;

CREATE TRIGGER trg_analytics_cross_runs_completed_immutable
BEFORE UPDATE ON analytics_cross_runs
WHEN OLD.state IN ('available','partial','unavailable','failed')
BEGIN SELECT RAISE(ABORT, 'analytics_cross_run_immutable'); END;

CREATE TRIGGER trg_analytics_funnel_runs_completed_immutable
BEFORE UPDATE ON analytics_funnel_runs
WHEN OLD.state != 'pending'
BEGIN SELECT RAISE(ABORT, 'analytics_funnel_run_immutable'); END;

CREATE TRIGGER trg_analytics_funnel_versions_no_delete
BEFORE DELETE ON analytics_funnel_versions
BEGIN SELECT RAISE(ABORT, 'analytics_funnel_version_immutable'); END;

CREATE TRIGGER trg_analytics_funnel_versions_no_update
BEFORE UPDATE ON analytics_funnel_versions
BEGIN SELECT RAISE(ABORT, 'analytics_funnel_version_immutable'); END;

CREATE TRIGGER trg_analytics_report_runs_snapshot_immutable
BEFORE UPDATE OF period_from, period_to, time_zone, data_cutoff_at, result_json
ON analytics_report_runs
WHEN OLD.state != 'running'
BEGIN SELECT RAISE(ABORT, 'analytics_report_snapshot_immutable'); END;

CREATE TRIGGER trg_analytics_result_audiences_booking_reference BEFORE INSERT ON analytics_result_audiences
WHEN NEW.source_kind='booking' AND NOT EXISTS(SELECT 1 FROM style_analytics_results WHERE id=NEW.source_result_id AND line_account_id=NEW.line_account_id)
BEGIN SELECT RAISE(ABORT,'analytics_result_source_not_found'); END;

CREATE TRIGGER trg_analytics_result_audiences_cross_reference BEFORE INSERT ON analytics_result_audiences
WHEN NEW.source_kind='cross' AND NOT EXISTS(SELECT 1 FROM analytics_cross_runs WHERE id=NEW.source_result_id AND line_account_id=NEW.line_account_id)
BEGIN SELECT RAISE(ABORT,'analytics_result_source_not_found'); END;

CREATE TRIGGER trg_analytics_result_audiences_funnel_reference BEFORE INSERT ON analytics_result_audiences
WHEN NEW.source_kind='funnel' AND NOT EXISTS(SELECT 1 FROM analytics_funnel_runs WHERE id=NEW.source_result_id AND line_account_id=NEW.line_account_id)
BEGIN SELECT RAISE(ABORT,'analytics_result_source_not_found'); END;

CREATE TRIGGER trg_analytics_saved_snapshots_no_update
BEFORE UPDATE ON analytics_saved_analysis_snapshots
BEGIN SELECT RAISE(ABORT, 'analytics_saved_snapshot_immutable'); END;

CREATE TRIGGER trg_analytics_saved_snapshots_same_parent
BEFORE INSERT ON analytics_saved_analysis_snapshots
WHEN NOT EXISTS (
  SELECT 1
    FROM analytics_saved_analyses a
    JOIN analytics_saved_analysis_versions v
      ON v.id = NEW.analysis_version_id
     AND v.saved_analysis_id = a.id
     AND v.line_account_id = a.line_account_id
   WHERE a.id = NEW.saved_analysis_id
     AND a.line_account_id = NEW.line_account_id
)
BEGIN SELECT RAISE(ABORT, 'analytics_saved_parent_mismatch'); END;

CREATE TRIGGER trg_analytics_saved_versions_no_delete
BEFORE DELETE ON analytics_saved_analysis_versions
BEGIN SELECT RAISE(ABORT, 'analytics_saved_version_immutable'); END;

CREATE TRIGGER trg_analytics_saved_versions_no_update
BEFORE UPDATE ON analytics_saved_analysis_versions
BEGIN SELECT RAISE(ABORT, 'analytics_saved_version_immutable'); END;

CREATE TRIGGER trg_analytics_saved_versions_same_account
BEFORE INSERT ON analytics_saved_analysis_versions
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_saved_analyses a
   WHERE a.id = NEW.saved_analysis_id AND a.line_account_id = NEW.line_account_id
)
BEGIN SELECT RAISE(ABORT, 'analytics_saved_parent_mismatch'); END;

CREATE TRIGGER trg_auto_reply_versions_immutable_delete
BEFORE DELETE ON auto_reply_versions
WHEN OLD.status IN ('published', 'retired')
BEGIN SELECT RAISE(ABORT, 'published auto reply versions cannot be deleted'); END;

CREATE TRIGGER trg_auto_reply_versions_immutable_update
BEFORE UPDATE OF auto_reply_id, version_number, line_account_id, definition_snapshot
ON auto_reply_versions
WHEN OLD.status IN ('published', 'retired')
BEGIN SELECT RAISE(ABORT, 'published auto reply versions are immutable'); END;

CREATE TRIGGER trg_auto_reply_versions_status_transition
BEFORE UPDATE OF status ON auto_reply_versions
WHEN OLD.status IN ('published', 'retired')
 AND NEW.status <> OLD.status
 AND NOT (OLD.status = 'published' AND NEW.status = 'retired')
BEGIN SELECT RAISE(ABORT, 'published auto reply version status cannot move backwards'); END;

CREATE TRIGGER trg_automation_published_version_immutable
BEFORE UPDATE ON automation_versions
WHEN OLD.status = 'published'
BEGIN SELECT RAISE(ABORT, 'published automation version is immutable'); END;

CREATE TRIGGER trg_automation_published_version_no_delete
BEFORE DELETE ON automation_versions
WHEN OLD.status = 'published'
BEGIN SELECT RAISE(ABORT, 'published automation version cannot be deleted'); END;

CREATE TRIGGER trg_common_action_binding_migrations_no_delete
BEFORE DELETE ON common_action_binding_migration_events
BEGIN SELECT RAISE(ABORT, 'common action binding migration history cannot be deleted'); END;

CREATE TRIGGER trg_common_action_binding_migrations_no_update
BEFORE UPDATE ON common_action_binding_migration_events
BEGIN SELECT RAISE(ABORT, 'common action binding migration history is immutable'); END;

CREATE TRIGGER trg_common_action_published_version_immutable
BEFORE UPDATE ON common_action_versions
WHEN OLD.status = 'published'
BEGIN SELECT RAISE(ABORT, 'published common action version is immutable'); END;

CREATE TRIGGER trg_common_action_published_version_no_delete
BEFORE DELETE ON common_action_versions
WHEN OLD.status = 'published'
BEGIN SELECT RAISE(ABORT, 'published common action version cannot be deleted'); END;

CREATE TRIGGER trg_form_versions_immutable
BEFORE UPDATE ON form_versions
BEGIN SELECT RAISE(ABORT, 'published form versions are immutable'); END;

CREATE TRIGGER trg_forms_activation_requires_published_version
BEFORE UPDATE OF is_active ON forms
WHEN NEW.is_active = 1 AND NEW.current_published_version_id IS NULL
BEGIN SELECT RAISE(ABORT, 'form publish is required before activation'); END;

CREATE TRIGGER trg_forms_initial_published_version
AFTER INSERT ON forms
WHEN NEW.status = 'active' AND NEW.is_active = 1
BEGIN INSERT INTO form_versions (id, form_id, version_number, source_content_revision, name, description, fields, layout, on_submit_tag_id, on_submit_scenario_id, on_submit_message_type, on_submit_message_content, on_submit_webhook_url, on_submit_webhook_headers, on_submit_webhook_fail_message, save_to_metadata, og_title, og_description, og_image_url, status, published_at, created_at) VALUES ('form-version-v1-' || NEW.id, NEW.id, 1, NEW.content_revision, NEW.name, NEW.description, NEW.fields, NEW.layout, NEW.on_submit_tag_id, NEW.on_submit_scenario_id, NEW.on_submit_message_type, NEW.on_submit_message_content, NEW.on_submit_webhook_url, NEW.on_submit_webhook_headers, NEW.on_submit_webhook_fail_message, NEW.save_to_metadata, NEW.og_title, NEW.og_description, NEW.og_image_url, 'published', NEW.updated_at, NEW.updated_at); UPDATE forms SET current_published_version_id = 'form-version-v1-' || NEW.id WHERE id = NEW.id; END;

CREATE TRIGGER trg_forms_published_version_ownership_insert
BEFORE INSERT ON forms
WHEN NEW.current_published_version_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM form_versions
   WHERE id = NEW.current_published_version_id AND form_id = NEW.id
 )
BEGIN SELECT RAISE(ABORT, 'published version belongs to another form'); END;

CREATE TRIGGER trg_forms_published_version_ownership_update
BEFORE UPDATE OF current_published_version_id ON forms
WHEN NEW.current_published_version_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM form_versions
   WHERE id = NEW.current_published_version_id AND form_id = NEW.id
 )
BEGIN SELECT RAISE(ABORT, 'published version belongs to another form'); END;

CREATE TRIGGER trg_forms_revision_account_delete
AFTER DELETE ON form_accounts
BEGIN UPDATE forms SET revision = revision + 1 WHERE id = OLD.form_id; END;

CREATE TRIGGER trg_forms_revision_account_insert
AFTER INSERT ON form_accounts
BEGIN UPDATE forms SET revision = revision + 1 WHERE id = NEW.form_id; END;

CREATE TRIGGER trg_forms_revision_account_update
AFTER UPDATE OF form_id, line_account_id ON form_accounts
WHEN OLD.form_id IS NOT NEW.form_id OR OLD.line_account_id IS NOT NEW.line_account_id
BEGIN UPDATE forms SET revision = revision + 1 WHERE id IN (OLD.form_id, NEW.form_id); END;

CREATE TRIGGER trg_forms_revision_open_delete
AFTER DELETE ON form_opens
BEGIN UPDATE forms SET revision = revision + 1 WHERE id = OLD.form_id; END;

CREATE TRIGGER trg_forms_revision_open_insert
AFTER INSERT ON form_opens
BEGIN UPDATE forms SET revision = revision + 1 WHERE id = NEW.form_id; END;

CREATE TRIGGER trg_forms_revision_open_update
AFTER UPDATE OF form_id ON form_opens
WHEN OLD.form_id IS NOT NEW.form_id
BEGIN UPDATE forms SET revision = revision + 1 WHERE id IN (OLD.form_id, NEW.form_id); END;

CREATE TRIGGER trg_forms_revision_rich_menu_delete
AFTER DELETE ON rich_menu_areas
WHEN OLD.form_id IS NOT NULL
BEGIN UPDATE forms SET revision = revision + 1 WHERE id = OLD.form_id; END;

CREATE TRIGGER trg_forms_revision_rich_menu_insert
AFTER INSERT ON rich_menu_areas
WHEN NEW.form_id IS NOT NULL
BEGIN UPDATE forms SET revision = revision + 1 WHERE id = NEW.form_id; END;

CREATE TRIGGER trg_forms_revision_rich_menu_update
AFTER UPDATE OF form_id ON rich_menu_areas
WHEN OLD.form_id IS NOT NEW.form_id
BEGIN UPDATE forms SET revision = revision + 1 WHERE id IN (OLD.form_id, NEW.form_id); END;

CREATE TRIGGER trg_forms_revision_submission_delete
AFTER DELETE ON form_submissions
BEGIN UPDATE forms SET revision = revision + 1 WHERE id = OLD.form_id; END;

CREATE TRIGGER trg_forms_revision_submission_insert
AFTER INSERT ON form_submissions
BEGIN UPDATE forms SET revision = revision + 1 WHERE id = NEW.form_id; END;

CREATE TRIGGER trg_forms_revision_submission_update
AFTER UPDATE OF form_id ON form_submissions
WHEN OLD.form_id IS NOT NEW.form_id
BEGIN UPDATE forms SET revision = revision + 1 WHERE id IN (OLD.form_id, NEW.form_id); END;

CREATE TRIGGER trg_forms_revision_webinar_cta_delete
AFTER DELETE ON webinar_ctas
WHEN OLD.form_id IS NOT NULL
BEGIN UPDATE forms SET revision = revision + 1 WHERE id = OLD.form_id; END;

CREATE TRIGGER trg_forms_revision_webinar_cta_insert
AFTER INSERT ON webinar_ctas
WHEN NEW.form_id IS NOT NULL
BEGIN UPDATE forms SET revision = revision + 1 WHERE id = NEW.form_id; END;

CREATE TRIGGER trg_forms_revision_webinar_cta_update
AFTER UPDATE OF form_id ON webinar_ctas
WHEN OLD.form_id IS NOT NEW.form_id
BEGIN UPDATE forms SET revision = revision + 1 WHERE id IN (OLD.form_id, NEW.form_id); END;

CREATE TRIGGER trg_friend_add_routing_versions_immutable_delete
BEFORE DELETE ON friend_add_routing_versions
WHEN OLD.status IN ('published', 'retired')
BEGIN SELECT RAISE(ABORT, 'published friend-add routing versions cannot be deleted'); END;

CREATE TRIGGER trg_friend_add_routing_versions_immutable_update
BEFORE UPDATE OF line_account_id, version_number, definition_snapshot
ON friend_add_routing_versions
WHEN OLD.status IN ('published', 'retired')
BEGIN SELECT RAISE(ABORT, 'published friend-add routing versions are immutable'); END;

CREATE TRIGGER trg_friend_add_routing_versions_status_transition
BEFORE UPDATE OF status ON friend_add_routing_versions
WHEN OLD.status IN ('published', 'retired')
 AND NEW.status <> OLD.status
 AND NOT (OLD.status = 'published' AND NEW.status = 'retired')
BEGIN SELECT RAISE(ABORT, 'published friend-add routing version status cannot move backwards'); END;

CREATE TRIGGER trg_friend_add_rule_versions_immutable_delete
BEFORE DELETE ON friend_add_rule_versions
WHEN OLD.status IN ('published', 'retired')
BEGIN SELECT RAISE(ABORT, 'published friend-add rule versions cannot be deleted'); END;

CREATE TRIGGER trg_friend_add_rule_versions_immutable_update
BEFORE UPDATE OF rule_id, version_number, definition_snapshot
ON friend_add_rule_versions
WHEN OLD.status IN ('published', 'retired')
BEGIN SELECT RAISE(ABORT, 'published friend-add rule versions are immutable'); END;

CREATE TRIGGER trg_friend_scenarios_version_ownership_insert
BEFORE INSERT ON friend_scenarios
WHEN NEW.published_version_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM scenario_versions
   WHERE id = NEW.published_version_id AND scenario_id = NEW.scenario_id
 )
BEGIN SELECT RAISE(ABORT, 'published version belongs to another scenario'); END;

CREATE TRIGGER trg_friend_scenarios_version_ownership_update
BEFORE UPDATE OF published_version_id ON friend_scenarios
WHEN NEW.published_version_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM scenario_versions
   WHERE id = NEW.published_version_id AND scenario_id = NEW.scenario_id
 )
BEGIN SELECT RAISE(ABORT, 'published version belongs to another scenario'); END;

CREATE TRIGGER trg_friend_scores_v6_snapshot
AFTER INSERT ON friend_scores
WHEN NEW.line_account_id IS NOT NULL
 AND NEW.operation IN ('delta', 'set', 'manual_adjustment')
 AND NEW.score_after IS NOT NULL
BEGIN UPDATE friends SET score = NEW.score_after, updated_at = COALESCE(NEW.occurred_at, NEW.created_at, updated_at) WHERE id = NEW.friend_id AND line_account_id = NEW.line_account_id; SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'action score friend account mismatch') END; END;

CREATE TRIGGER trg_messages_log_queue_url_exposure
AFTER INSERT ON messages_log
WHEN NEW.direction = 'outgoing'
 AND instr(NEW.content, '/t/') > 0
 AND COALESCE(
       NEW.line_account_id,
       (SELECT line_account_id FROM friends WHERE id = NEW.friend_id)
     ) IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO analytics_url_exposure_queue (
    message_id, line_account_id, status, attempts, available_at, created_at, updated_at
  ) VALUES (
    NEW.id,
    COALESCE(
      NEW.line_account_id,
      (SELECT line_account_id FROM friends WHERE id = NEW.friend_id)
    ),
    'pending', 0, NEW.created_at, NEW.created_at, NEW.created_at
  ); END;

CREATE TRIGGER trg_mileage_grant_lot_after_ledger_insert
AFTER INSERT ON mileage_ledger
WHEN NEW.amount > 0
 AND NEW.status = 'available'
 AND NEW.entry_type IN ('grant', 'adjustment')
BEGIN
  INSERT OR IGNORE INTO mileage_grant_lots
    (ledger_entry_id, program_id, beneficiary_key, original_amount, remaining_amount,
     available_at, expires_at, status, created_at)
  SELECT NEW.id,
         NEW.program_id,
         CASE
           WHEN COALESCE(NEW.beneficiary_user_id, f.user_id) IS NOT NULL
             THEN 'user:' || COALESCE(NEW.beneficiary_user_id, f.user_id)
           ELSE 'friend:' || NEW.beneficiary_friend_id
         END,
         NEW.amount,
         NEW.amount,
         NEW.occurred_at,
         json_extract(NEW.metadata, '$.expiresAt'),
         'available',
         NEW.created_at
    FROM (SELECT 1) seed
    LEFT JOIN friends f ON f.id = NEW.beneficiary_friend_id; END;

CREATE TRIGGER trg_mileage_redemption_attempts_no_delete
BEFORE DELETE ON mileage_redemption_attempts
BEGIN SELECT RAISE(ABORT, 'mileage redemption attempt history cannot be deleted'); END;

CREATE TRIGGER trg_mileage_redemption_step_deliveries_no_delete
BEFORE DELETE ON mileage_redemption_step_deliveries
BEGIN SELECT RAISE(ABORT, 'mileage redemption step delivery history cannot be deleted'); END;

CREATE TRIGGER trg_mileage_redemptions_no_delete
BEFORE DELETE ON mileage_redemptions
BEGIN SELECT RAISE(ABORT, 'mileage redemption history cannot be deleted'); END;

CREATE TRIGGER trg_mileage_reward_published_version_immutable
BEFORE UPDATE ON mileage_reward_versions
WHEN OLD.status = 'published'
BEGIN SELECT RAISE(ABORT, 'published mileage reward version is immutable'); END;

CREATE TRIGGER trg_mileage_reward_published_version_no_delete
BEFORE DELETE ON mileage_reward_versions
WHEN OLD.status = 'published'
BEGIN SELECT RAISE(ABORT, 'published mileage reward version cannot be deleted'); END;

CREATE TRIGGER trg_mileage_wallet_after_ledger_insert
AFTER INSERT ON mileage_ledger
WHEN NEW.beneficiary_friend_id IS NOT NULL OR NEW.beneficiary_user_id IS NOT NULL
BEGIN
  INSERT INTO mileage_wallets
    (program_id, beneficiary_key, beneficiary_user_id, beneficiary_friend_id,
     available, pending, version, updated_at)
  SELECT NEW.program_id,
         CASE
           WHEN COALESCE(NEW.beneficiary_user_id, f.user_id) IS NOT NULL
             THEN 'user:' || COALESCE(NEW.beneficiary_user_id, f.user_id)
           ELSE 'friend:' || NEW.beneficiary_friend_id
         END,
         COALESCE(NEW.beneficiary_user_id, f.user_id),
         CASE WHEN COALESCE(NEW.beneficiary_user_id, f.user_id) IS NULL
              THEN NEW.beneficiary_friend_id ELSE NULL END,
         CASE WHEN NEW.status = 'available' THEN NEW.amount ELSE 0 END,
         CASE WHEN NEW.status = 'pending' THEN NEW.amount ELSE 0 END,
         1,
         NEW.created_at
    FROM (SELECT 1) seed
    LEFT JOIN friends f ON f.id = NEW.beneficiary_friend_id
  ON CONFLICT(program_id, beneficiary_key) DO UPDATE SET
    available = mileage_wallets.available + excluded.available,
    pending = mileage_wallets.pending + excluded.pending,
    version = mileage_wallets.version + 1,
    updated_at = excluded.updated_at; END;

CREATE TRIGGER trg_reminder_version_steps_immutable_delete
BEFORE DELETE ON reminder_version_steps
WHEN COALESCE((SELECT status FROM reminder_versions WHERE id = OLD.reminder_version_id), '') <> 'draft'
BEGIN SELECT RAISE(ABORT, 'published reminder version steps are immutable'); END;

CREATE TRIGGER trg_reminder_version_steps_immutable_insert
BEFORE INSERT ON reminder_version_steps
WHEN COALESCE((SELECT status FROM reminder_versions WHERE id = NEW.reminder_version_id), '') <> 'draft'
BEGIN SELECT RAISE(ABORT, 'published reminder version steps are immutable'); END;

CREATE TRIGGER trg_reminder_version_steps_immutable_update
BEFORE UPDATE ON reminder_version_steps
WHEN COALESCE((SELECT status FROM reminder_versions WHERE id = OLD.reminder_version_id), '') <> 'draft'
BEGIN SELECT RAISE(ABORT, 'published reminder version steps are immutable'); END;

CREATE TRIGGER trg_reminder_versions_immutable_delete
BEFORE DELETE ON reminder_versions
WHEN OLD.status IN ('published', 'superseded')
BEGIN SELECT RAISE(ABORT, 'published reminder versions cannot be deleted'); END;

CREATE TRIGGER trg_reminder_versions_immutable_update
BEFORE UPDATE OF reminder_id, version_number, settings_snapshot ON reminder_versions
WHEN OLD.status IN ('published', 'superseded')
BEGIN SELECT RAISE(ABORT, 'published reminder versions are immutable'); END;

CREATE TRIGGER trg_reminder_versions_status_transition
BEFORE UPDATE OF status ON reminder_versions
WHEN OLD.status IN ('published', 'superseded')
 AND NEW.status <> OLD.status
 AND NOT (OLD.status = 'published' AND NEW.status = 'superseded')
BEGIN SELECT RAISE(ABORT, 'published reminder version status cannot move backwards'); END;

CREATE TRIGGER trg_scenario_versions_immutable_delete
BEFORE DELETE ON scenario_versions
WHEN OLD.status IN ('published', 'retired')
 AND EXISTS (SELECT 1 FROM scenarios WHERE id = OLD.scenario_id)
BEGIN SELECT RAISE(ABORT, 'published scenario versions cannot be deleted'); END;

CREATE TRIGGER trg_scenario_versions_immutable_update
BEFORE UPDATE OF scenario_id, version_number, delivery_mode, audience_condition_json,
  on_complete_mode, on_complete_scenario_id, steps_snapshot, actions_snapshot
ON scenario_versions
WHEN OLD.status IN ('published', 'retired')
BEGIN SELECT RAISE(ABORT, 'published scenario versions are immutable'); END;

CREATE TRIGGER trg_scenario_versions_status_transition
BEFORE UPDATE OF status ON scenario_versions
WHEN OLD.status IN ('published', 'retired')
 AND NEW.status <> OLD.status
 AND NOT (OLD.status = 'published' AND NEW.status = 'retired')
BEGIN SELECT RAISE(ABORT, 'published scenario version status cannot move backwards'); END;

CREATE TRIGGER trg_scenarios_pointer_ownership
BEFORE UPDATE OF current_published_version_id ON scenarios
WHEN NEW.current_published_version_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM scenario_versions
   WHERE id = NEW.current_published_version_id AND scenario_id = NEW.id
 )
BEGIN SELECT RAISE(ABORT, 'published version belongs to another scenario'); END;

CREATE TRIGGER uid_migration_delivery_consents_apply AFTER UPDATE OF result ON uid_migration_items WHEN NEW.result='applied' AND OLD.result<>'applied' BEGIN SELECT CASE WHEN (SELECT user_id FROM friends WHERE id=NEW.old_friend_id) IS NOT json_extract(NEW.after_json,'$.userId') OR (SELECT user_id FROM friends WHERE id=NEW.new_friend_id) IS NOT json_extract(NEW.after_json,'$.userId') THEN RAISE(ABORT,'delivery_consent_identity_conflict') END; SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM uid_migration_runs r JOIN friends f ON f.id=NEW.old_friend_id AND f.line_account_id=r.from_account_id JOIN friends t ON t.id=NEW.new_friend_id AND t.line_account_id=r.to_account_id WHERE r.id=NEW.run_id)  THEN RAISE(ABORT,'delivery_consent_scope') END;  INSERT INTO uid_migration_delivery_consents(item_id,purpose,source_state,before_json)  SELECT NEW.id,p.purpose,s.state,CASE WHEN t.friend_id IS NULL THEN NULL ELSE json_object('state',t.state,'reason',t.reason,'source',t.source,'updatedBy',t.updated_by,'updatedAt',t.updated_at,'version',t.version) END  FROM (SELECT purpose FROM friend_delivery_consents WHERE friend_id=NEW.old_friend_id UNION SELECT purpose FROM friend_delivery_consents WHERE friend_id=NEW.new_friend_id) p  LEFT JOIN friend_delivery_consents s ON s.friend_id=NEW.old_friend_id AND s.purpose=p.purpose  LEFT JOIN friend_delivery_consents t ON t.friend_id=NEW.new_friend_id AND t.purpose=p.purpose;  INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source,updated_by,version) SELECT r.to_account_id,NEW.new_friend_id,s.purpose,  CASE WHEN s.source_state='revoked' OR json_extract(s.before_json,'$.state')='revoked' THEN 'revoked'  WHEN COALESCE(s.source_state,'unknown')='unknown' OR COALESCE(json_extract(s.before_json,'$.state'),'unknown')='unknown' THEN 'unknown' ELSE 'granted' END,  'UID移行：移行元と移行先の厳しい状態を引き継ぎ','uid_migration',r.approved_by,COALESCE((SELECT MAX(CAST(json_extract(COALESCE(e.after_json,e.before_json),'$.version') AS INTEGER)) FROM friend_delivery_consent_events e WHERE e.friend_id=NEW.new_friend_id AND e.purpose=s.purpose),0)+1 FROM uid_migration_delivery_consents s JOIN uid_migration_runs r ON r.id=NEW.run_id WHERE s.item_id=NEW.id  ON CONFLICT(line_account_id,friend_id,purpose) DO UPDATE SET state=excluded.state,reason=excluded.reason,source=excluded.source,updated_by=excluded.updated_by,updated_at=excluded.updated_at,version=friend_delivery_consents.version+1;  UPDATE uid_migration_delivery_consents SET after_json=(SELECT json_object('state',c.state,'reason',c.reason,'source',c.source,'updatedBy',c.updated_by,'updatedAt',c.updated_at,'version',c.version) FROM friend_delivery_consents c WHERE c.friend_id=NEW.new_friend_id AND c.purpose=uid_migration_delivery_consents.purpose) WHERE item_id=NEW.id;  UPDATE uid_migration_items SET before_json=json_set(before_json,'$.deliveryConsents',(SELECT json_group_array(json_object('purpose',purpose,'value',json(before_json))) FROM uid_migration_delivery_consents WHERE item_id=NEW.id)),  after_json=json_set(after_json,'$.deliveryConsentsRecorded',1,'$.deliveryConsents',(SELECT json_group_array(json_object('purpose',purpose,'value',json(after_json))) FROM uid_migration_delivery_consents WHERE item_id=NEW.id)) WHERE id=NEW.id; END;

CREATE TRIGGER uid_migration_delivery_consents_restore BEFORE UPDATE OF result ON uid_migration_items WHEN NEW.result='rolled_back' AND OLD.result='applied' AND json_extract(OLD.after_json,'$.deliveryConsentsRecorded')=1 BEGIN  SELECT CASE WHEN EXISTS(SELECT 1 FROM uid_migration_delivery_consents s LEFT JOIN friend_delivery_consents c ON c.friend_id=OLD.new_friend_id AND c.purpose=s.purpose WHERE s.item_id=OLD.id AND (c.friend_id IS NULL OR c.version<>json_extract(s.after_json,'$.version') OR c.state<>json_extract(s.after_json,'$.state') OR c.reason<>json_extract(s.after_json,'$.reason') OR c.source<>json_extract(s.after_json,'$.source') OR c.updated_by IS NOT json_extract(s.after_json,'$.updatedBy') OR c.updated_at<>json_extract(s.after_json,'$.updatedAt')))  OR EXISTS(SELECT 1 FROM friend_delivery_consents c WHERE c.friend_id=OLD.new_friend_id AND NOT EXISTS(SELECT 1 FROM uid_migration_delivery_consents s WHERE s.item_id=OLD.id AND s.purpose=c.purpose))  THEN RAISE(ABORT,'delivery_consent_conflict') END;  DELETE FROM friend_delivery_consents WHERE friend_id=OLD.new_friend_id AND purpose IN (SELECT purpose FROM uid_migration_delivery_consents WHERE item_id=OLD.id AND before_json IS NULL);  UPDATE friend_delivery_consents SET  state=json_extract(s.before_json,'$.state'),reason=json_extract(s.before_json,'$.reason'),source=json_extract(s.before_json,'$.source'),updated_by=json_extract(s.before_json,'$.updatedBy'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1  FROM uid_migration_delivery_consents s WHERE s.item_id=OLD.id AND s.purpose=friend_delivery_consents.purpose AND friend_id=OLD.new_friend_id AND s.before_json IS NOT NULL; END;

CREATE TRIGGER v8_photo_publication_policy_insert AFTER INSERT ON nen_photo_publications
BEGIN UPDATE nen_photo_publications SET reward_policy_key=COALESCE((SELECT policy_key FROM photo_reward_policies WHERE effective_from IS NULL OR julianday(effective_from,CASE WHEN substr(effective_from,11) GLOB '*[Zz+-]*' THEN '+0 hours' ELSE '-9 hours' END)<=julianday('now') ORDER BY version_number DESC LIMIT 1),'legacy-5'), reward_points=COALESCE((SELECT publication_points FROM photo_reward_policies WHERE effective_from IS NULL OR julianday(effective_from,CASE WHEN substr(effective_from,11) GLOB '*[Zz+-]*' THEN '+0 hours' ELSE '-9 hours' END)<=julianday('now') ORDER BY version_number DESC LIMIT 1),0) WHERE id=NEW.id; END;

CREATE TRIGGER v8_photo_publication_reward_adopt AFTER UPDATE OF status ON nen_photo_submissions WHEN NEW.status='adopted' AND OLD.status<>'adopted'
BEGIN INSERT INTO nen_photo_publication_reward_outbox (id,photo_id,line_account_id,friend_id,customer_id,provider_award_key,policy_version,points,status,last_error,created_at,updated_at) SELECT 'photo-publication-reward:' || ps.id,ps.id,ps.line_account_id,ps.friend_id,COALESCE(member.customer_id,''), 'photo-publication-reward:' || ps.id,pub.reward_policy_key,pub.reward_points, CASE WHEN member.customer_id IS NOT NULL AND member.customer_id != '' THEN 'pending' ELSE 'failed' END, CASE WHEN member.customer_id IS NOT NULL AND member.customer_id != '' THEN NULL ELSE 'customer_unlinked' END, (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours') || '+09:00'),(strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours') || '+09:00') FROM nen_photo_submissions ps JOIN nen_photo_publications pub ON pub.photo_id=ps.id AND pub.line_account_id=ps.line_account_id AND pub.status='published' JOIN friends f ON f.id=ps.friend_id AND f.line_account_id=ps.line_account_id LEFT JOIN nen_ec_member_snapshots member ON member.friend_id=ps.friend_id WHERE ps.id=NEW.id AND ps.status='adopted' AND ps.publication_consent_at IS NOT NULL AND ps.publication_withdrawn_at IS NULL AND pub.reward_policy_key IS NOT NULL AND pub.reward_points>0 ON CONFLICT DO NOTHING; END;

CREATE TRIGGER v8_photo_publication_reward_restore AFTER UPDATE OF status ON nen_photo_publications WHEN NEW.status='published' AND OLD.status<>'published'
BEGIN INSERT INTO nen_photo_publication_reward_outbox (id,photo_id,line_account_id,friend_id,customer_id,provider_award_key,policy_version,points,status,last_error,created_at,updated_at) SELECT 'photo-publication-reward:' || ps.id,ps.id,ps.line_account_id,ps.friend_id,COALESCE(member.customer_id,''), 'photo-publication-reward:' || ps.id,pub.reward_policy_key,pub.reward_points, CASE WHEN member.customer_id IS NOT NULL AND member.customer_id != '' THEN 'pending' ELSE 'failed' END, CASE WHEN member.customer_id IS NOT NULL AND member.customer_id != '' THEN NULL ELSE 'customer_unlinked' END, (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours') || '+09:00'),(strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours') || '+09:00') FROM nen_photo_submissions ps JOIN nen_photo_publications pub ON pub.photo_id=ps.id AND pub.line_account_id=ps.line_account_id AND pub.status='published' JOIN friends f ON f.id=ps.friend_id AND f.line_account_id=ps.line_account_id LEFT JOIN nen_ec_member_snapshots member ON member.friend_id=ps.friend_id WHERE pub.id=NEW.id AND ps.status='adopted' AND ps.publication_consent_at IS NOT NULL AND ps.publication_withdrawn_at IS NULL AND pub.reward_policy_key IS NOT NULL AND pub.reward_points>0 ON CONFLICT DO NOTHING; END;

CREATE TRIGGER v8_photo_publication_reward_snapshot AFTER UPDATE OF reward_points ON nen_photo_publications
BEGIN INSERT INTO nen_photo_publication_reward_outbox (id,photo_id,line_account_id,friend_id,customer_id,provider_award_key,policy_version,points,status,last_error,created_at,updated_at) SELECT 'photo-publication-reward:' || ps.id,ps.id,ps.line_account_id,ps.friend_id,COALESCE(member.customer_id,''), 'photo-publication-reward:' || ps.id,pub.reward_policy_key,pub.reward_points, CASE WHEN member.customer_id IS NOT NULL AND member.customer_id != '' THEN 'pending' ELSE 'failed' END, CASE WHEN member.customer_id IS NOT NULL AND member.customer_id != '' THEN NULL ELSE 'customer_unlinked' END, (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours') || '+09:00'),(strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours') || '+09:00') FROM nen_photo_submissions ps JOIN nen_photo_publications pub ON pub.photo_id=ps.id AND pub.line_account_id=ps.line_account_id AND pub.status='published' JOIN friends f ON f.id=ps.friend_id AND f.line_account_id=ps.line_account_id LEFT JOIN nen_ec_member_snapshots member ON member.friend_id=ps.friend_id WHERE pub.id=NEW.id AND ps.status='adopted' AND ps.publication_consent_at IS NOT NULL AND ps.publication_withdrawn_at IS NULL AND pub.reward_policy_key IS NOT NULL AND pub.reward_points>0 ON CONFLICT DO NOTHING; END;

CREATE TRIGGER visit_stamp_booking_mark AFTER INSERT ON booking_visit_marks WHEN NEW.kind='visited' BEGIN INSERT INTO visit_stamp_visit_queue(kind,visit_id) VALUES('booking',NEW.booking_id) ON CONFLICT(kind,visit_id) DO UPDATE SET generation=generation+1; END;

CREATE TRIGGER visit_stamp_booking_update AFTER UPDATE OF status ON bookings WHEN NEW.status<>OLD.status AND (NEW.status='completed' OR OLD.status='completed') BEGIN INSERT INTO visit_stamp_visit_queue(kind,visit_id) VALUES('booking',NEW.id) ON CONFLICT(kind,visit_id) DO UPDATE SET generation=generation+1; END;

CREATE TRIGGER visit_stamp_entry_balance AFTER INSERT ON visit_stamp_entries BEGIN UPDATE visit_stamp_wallets SET version=version+1, visit_count=CASE WHEN NEW.kind='visit' THEN visit_count+1 WHEN NEW.kind='paper' AND NEW.delta>0 THEN MAX(visit_count,1) ELSE visit_count END, balance=balance+NEW.delta, earned_total=earned_total+CASE WHEN NEW.kind IN ('visit','manual','paper') AND NEW.delta>0 THEN NEW.delta ELSE 0 END, last_visit_at=CASE WHEN NEW.kind='visit' THEN NEW.occurred_at ELSE last_visit_at END, expires_at=CASE WHEN NEW.kind IN ('visit','manual','paper') THEN NEW.expires_at ELSE expires_at END WHERE card_id=NEW.card_id AND friend_id=NEW.friend_id; END;

CREATE TRIGGER visit_stamp_rt_insert AFTER INSERT ON rt_reservations WHEN NEW.status IN ('visited','seated') BEGIN INSERT INTO visit_stamp_visit_queue(kind,visit_id) VALUES('restaurant',NEW.id) ON CONFLICT(kind,visit_id) DO UPDATE SET generation=generation+1; END;

CREATE TRIGGER visit_stamp_rt_update AFTER UPDATE OF status ON rt_reservations WHEN NEW.status<>OLD.status AND (NEW.status IN ('visited','seated') OR OLD.status IN ('visited','seated')) BEGIN INSERT INTO visit_stamp_visit_queue(kind,visit_id) VALUES('restaurant',NEW.id) ON CONFLICT(kind,visit_id) DO UPDATE SET generation=generation+1; END;

CREATE VIEW booking_monthly_available_rights AS
 SELECT r.entitlement_id,c.id contract_id,c.account_id,c.friend_id,c.class_kind,c.class_id,y.period_start,y.service_start,y.service_end,c.stop_effective_at
 FROM booking_monthly_rights r JOIN booking_monthly_contracts c ON c.id=r.contract_id
 JOIN booking_monthly_cycles y ON y.id=r.cycle_id
 JOIN booking_entitlements e ON e.id=r.entitlement_id AND e.line_account_id=c.account_id AND e.friend_id=c.friend_id
 JOIN line_accounts a ON a.id=c.account_id AND a.tenant_id=c.tenant_id JOIN tenants t ON t.id=c.tenant_id
 WHERE (r.state='paid' AND y.state='paid' OR r.state='provisional' AND y.state NOT IN('exhausted','void')) AND e.status='active' AND c.state IN('active','stop_scheduled')
 AND c.service_state='enabled' AND (c.attention_started_at IS NULL OR julianday(c.attention_started_at)+7>julianday('now'))
 AND (c.stop_effective_at IS NULL OR julianday(c.stop_effective_at)>julianday('now'))
 AND a.is_active=1 AND a.archived_at IS NULL AND t.status='active'
 AND ((c.class_kind='menu' AND EXISTS(SELECT 1 FROM menus m WHERE m.id=c.class_id AND m.line_account_id=c.account_id AND m.deleted_at IS NULL))
 OR (c.class_kind='event' AND EXISTS(SELECT 1 FROM events ev WHERE ev.id=c.class_id AND ev.line_account_id=c.account_id AND ev.deleted_at IS NULL)));

CREATE VIEW booking_monthly_bound_rights AS
 SELECT r.entitlement_id,c.account_id,c.friend_id,c.class_kind,c.class_id,y.period_start,y.service_start,y.service_end
 FROM booking_monthly_rights r JOIN booking_monthly_contracts c ON c.id=r.contract_id
 JOIN booking_monthly_cycles y ON y.id=r.cycle_id;

CREATE VIEW booking_slot_allocations AS SELECT id,line_account_id,staff_id,menu_id,starts_at,block_ends_at,NULL AS waitlist_id FROM bookings WHERE status IN ('requested','confirmed') UNION ALL SELECT 'waitlist:'||id,line_account_id,staff_id,menu_id,starts_at,block_ends_at,id FROM booking_waitlist WHERE status='invited' AND julianday(hold_expires_at)>julianday('now');

CREATE VIEW booking_slot_resources AS SELECT a.*,c.resource_id,c.quantity FROM booking_slot_allocations a JOIN booking_resource_consumptions c ON c.booking_id=a.id UNION ALL SELECT a.*,c.resource_id,c.quantity FROM booking_slot_allocations a JOIN booking_waitlist_resources c ON c.waitlist_id=a.waitlist_id;

CREATE VIEW rt_inventory_occupancy AS SELECT i.*,
 COALESCE((SELECT SUM(r.guest_count) FROM rt_reservations r WHERE r.store_id=i.store_id
  AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR datetime(r.hold_expires_at)>datetime('now'))
  AND datetime(r.starts_at)<datetime(i.starts_at, '+' || i.slot_minutes || ' minutes') AND datetime(r.ends_at)>datetime(i.starts_at)),0) AS guest_count,
 COALESCE((SELECT SUM(t.max_capacity) FROM rt_tables t WHERE t.store_id=i.store_id AND t.is_active=1
  AND EXISTS (SELECT 1 FROM rt_reservations r WHERE EXISTS(SELECT 1 FROM rt_reservation_table_links l WHERE l.reservation_id=r.id AND l.table_id=t.id) AND r.store_id=i.store_id
   AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR datetime(r.hold_expires_at)>datetime('now'))
   AND datetime(r.starts_at)<datetime(i.starts_at, '+' || i.slot_minutes || ' minutes') AND datetime(r.ends_at)>datetime(i.starts_at))),0) AS occupied_seats,
 (SELECT json_group_array(t.id) FROM rt_tables t WHERE t.store_id=i.store_id AND t.is_active=1
  AND EXISTS (SELECT 1 FROM rt_reservations r WHERE EXISTS(SELECT 1 FROM rt_reservation_table_links l WHERE l.reservation_id=r.id AND l.table_id=t.id) AND r.store_id=i.store_id
   AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR datetime(r.hold_expires_at)>datetime('now'))
   AND datetime(r.starts_at)<datetime(i.starts_at, '+' || i.slot_minutes || ' minutes') AND datetime(r.ends_at)>datetime(i.starts_at))) AS occupied_table_ids_json,
 COALESCE((SELECT SUM(r.guest_count) FROM rt_reservations r WHERE r.store_id=i.store_id AND r.table_id IS NULL
  AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR datetime(r.hold_expires_at)>datetime('now'))
  AND datetime(r.starts_at)<datetime(i.starts_at, '+' || i.slot_minutes || ' minutes') AND datetime(r.ends_at)>datetime(i.starts_at)),0) AS unassigned_guests
 FROM rt_inventory_slots i;

-- Seed data required by tenant-aware inserts on a fresh database.
INSERT OR IGNORE INTO tenants (id, name) VALUES
  ('00000000-0000-4000-8000-000000000001', '既定の統括');
INSERT OR IGNORE INTO musubo_pricing_conditions (id,condition_key,version,name,status,trial_unit,trial_value,line_discount_percent,price_schedule_json,created_by,created_at,activated_at) VALUES ('normal','normal',1,'通常条件','active','days',30,0,'{"firstLineYen":5900,"secondToFifthLineYen":7900,"sixthToTenthLineYen":6900,"headquartersYen":5500,"linkedAccountSlotYen":3300,"extraFriendBlockYen":1100,"extraFriendBlockSize":10000}','system','2026-11-09T00:00:00+09:00','2026-11-09T00:00:00+09:00');

INSERT OR IGNORE INTO friend_fields (id,name,field_key,type,source,is_personal,display_order) VALUES ('fixed-name','名前','fixed_name','text','form',1,-7);
INSERT OR IGNORE INTO friend_fixed_fields (fixed_key,field_id) VALUES ('name','fixed-name');
INSERT OR IGNORE INTO friend_fields (id,name,field_key,type,source,is_personal,display_order) VALUES ('fixed-kana','ふりがな','fixed_kana','text','form',1,-6);
INSERT OR IGNORE INTO friend_fixed_fields (fixed_key,field_id) VALUES ('kana','fixed-kana');
INSERT OR IGNORE INTO friend_fields (id,name,field_key,type,source,is_personal,display_order) VALUES ('fixed-birthday','生年月日','fixed_birthday','date','form',1,-5);
INSERT OR IGNORE INTO friend_fixed_fields (fixed_key,field_id) VALUES ('birthday','fixed-birthday');
INSERT OR IGNORE INTO friend_fields (id,name,field_key,type,source,is_personal,display_order) VALUES ('fixed-age','年齢','fixed_age','number','form',1,-4);
INSERT OR IGNORE INTO friend_fixed_fields (fixed_key,field_id) VALUES ('age','fixed-age');
INSERT OR IGNORE INTO friend_fields (id,name,field_key,type,source,is_personal,display_order) VALUES ('fixed-email','メール','fixed_email','email','form',1,-3);
INSERT OR IGNORE INTO friend_fixed_fields (fixed_key,field_id) VALUES ('email','fixed-email');
INSERT OR IGNORE INTO friend_fields (id,name,field_key,type,source,is_personal,display_order) VALUES ('fixed-tel','電話','fixed_tel','tel','form',1,-2);
INSERT OR IGNORE INTO friend_fixed_fields (fixed_key,field_id) VALUES ('tel','fixed-tel');
INSERT OR IGNORE INTO friend_fields (id,name,field_key,type,source,is_personal,display_order) VALUES ('fixed-address','住所','fixed_address','textarea','form',1,-1);
INSERT OR IGNORE INTO friend_fixed_fields (fixed_key,field_id) VALUES ('address','fixed-address');
INSERT OR IGNORE INTO friend_fields (id,name,field_key,type,source,is_personal,display_order) VALUES ('fixed-allergy','アレルギー','fixed_allergy','text','form',1,0);
INSERT OR IGNORE INTO friend_fixed_fields (fixed_key,field_id) VALUES ('allergy','fixed-allergy');
INSERT OR IGNORE INTO friend_fields (id,name,field_key,type,source,is_personal,display_order) VALUES ('fixed-anniversary','記念日','fixed_anniversary','date','form',1,1);
INSERT OR IGNORE INTO friend_fixed_fields (fixed_key,field_id) VALUES ('anniversary','fixed-anniversary');
INSERT OR IGNORE INTO friend_fields (id,name,field_key,type,source,is_personal,display_order) VALUES ('fixed-seat_preference','席の好み','fixed_seat_preference','text','form',1,2);
INSERT OR IGNORE INTO friend_fixed_fields (fixed_key,field_id) VALUES ('seat_preference','fixed-seat_preference');
