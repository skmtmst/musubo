-- 統括削除の墓石と、墓石の契約について個人識別子だけを除く例外。
ALTER TABLE line_accounts ADD COLUMN data_purged_at TEXT;
ALTER TABLE friends ADD COLUMN data_purged_at TEXT;
ALTER TABLE rt_stores ADD COLUMN data_purged_at TEXT;
ALTER TABLE rt_organizations ADD COLUMN data_purged_at TEXT;
ALTER TABLE broadcasts ADD COLUMN data_purged_at TEXT;
ALTER TABLE menus ADD COLUMN data_purged_at TEXT;
ALTER TABLE booking_pass_plans ADD COLUMN data_purged_at TEXT;
ALTER TABLE tenants ADD COLUMN purge_started_at TEXT;
ALTER TABLE tenants ADD COLUMN billing_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN last_purged_at TEXT;
ALTER TABLE billing_events ADD COLUMN lease_token TEXT;
ALTER TABLE billing_events ADD COLUMN lease_until TEXT;
ALTER TABLE billing_events ADD COLUMN review_amount INTEGER;
ALTER TABLE billing_events ADD COLUMN review_currency TEXT;
ALTER TABLE stripe_events ADD COLUMN tenant_id TEXT;
ALTER TABLE stripe_events ADD COLUMN review_reason TEXT;
ALTER TABLE stripe_events ADD COLUMN identifier_hash TEXT;
ALTER TABLE stripe_events ADD COLUMN identifier_kind TEXT;
ALTER TABLE stripe_events ADD COLUMN identifier_expires_at TEXT;
ALTER TABLE stripe_events ADD COLUMN identifier_key_version TEXT;
DROP INDEX idx_rt_organizations_tenant_unique;
CREATE UNIQUE INDEX idx_rt_organizations_tenant_unique ON rt_organizations(tenant_id) WHERE data_purged_at IS NULL;
DROP TRIGGER booking_monthly_contract_identity;
CREATE TRIGGER booking_monthly_contract_identity BEFORE UPDATE ON booking_monthly_contracts WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.account_id IS NOT OLD.account_id  OR NEW.friend_id IS NOT OLD.friend_id OR NEW.class_kind IS NOT OLD.class_kind OR NEW.class_id IS NOT OLD.class_id  OR NEW.plan_id IS NOT OLD.plan_id OR NEW.plan_version IS NOT OLD.plan_version OR NEW.amount IS NOT OLD.amount  OR NEW.monthly_limit IS NOT OLD.monthly_limit OR NEW.timezone IS NOT OLD.timezone OR NEW.connected_account IS NOT OLD.connected_account  OR NEW.connection_identity IS NOT OLD.connection_identity OR NEW.consent_version IS NOT OLD.consent_version  OR NEW.consented_at IS NOT OLD.consented_at OR NEW.request_key IS NOT OLD.request_key OR (NEW.request_json IS NOT OLD.request_json AND NOT ((EXISTS(SELECT 1 FROM line_accounts a JOIN tenants t ON t.id=a.tenant_id WHERE a.id=OLD.account_id AND a.tenant_id=OLD.tenant_id AND a.data_purged_at IS NOT NULL AND t.purge_started_at IS NOT NULL AND t.data_purged_at IS NULL) AND NEW."id" IS OLD."id" AND NEW."tenant_id" IS OLD."tenant_id" AND NEW."account_id" IS OLD."account_id" AND NEW."friend_id" IS OLD."friend_id" AND NEW."class_kind" IS OLD."class_kind" AND NEW."class_id" IS OLD."class_id" AND NEW."plan_id" IS OLD."plan_id" AND NEW."plan_version" IS OLD."plan_version" AND NEW."name" IS OLD."name" AND NEW."amount" IS OLD."amount" AND NEW."currency" IS OLD."currency" AND NEW."monthly_limit" IS OLD."monthly_limit" AND NEW."timezone" IS OLD."timezone" AND NEW."consent_version" IS OLD."consent_version" AND NEW."consented_at" IS OLD."consented_at" AND NEW."connected_account" IS OLD."connected_account" AND NEW."connection_identity" IS OLD."connection_identity" AND NEW."payment_method_id" IS OLD."payment_method_id" AND NEW."payment_method_version" IS OLD."payment_method_version" AND NEW."setup_session_id" IS OLD."setup_session_id" AND NEW."setup_expires_at" IS OLD."setup_expires_at" AND NEW."state" IS OLD."state" AND NEW."stop_reason" IS OLD."stop_reason" AND NEW."stop_effective_at" IS OLD."stop_effective_at" AND NEW."service_state" IS OLD."service_state" AND NEW."service_reason" IS OLD."service_reason" AND NEW."attention_episode_id" IS OLD."attention_episode_id" AND NEW."attention_started_at" IS OLD."attention_started_at" AND NEW."request_key" IS OLD."request_key" AND NEW."test_mode" IS OLD."test_mode" AND NEW."created_at" IS OLD."created_at") AND NEW.request_json = json_remove(OLD.request_json, '$.friendId')))  OR (OLD.customer_id IS NOT NULL AND NEW.customer_id IS NOT OLD.customer_id AND NOT ((EXISTS(SELECT 1 FROM line_accounts a JOIN tenants t ON t.id=a.tenant_id WHERE a.id=OLD.account_id AND a.tenant_id=OLD.tenant_id AND a.data_purged_at IS NOT NULL AND t.purge_started_at IS NOT NULL AND t.data_purged_at IS NULL) AND NEW."id" IS OLD."id" AND NEW."tenant_id" IS OLD."tenant_id" AND NEW."account_id" IS OLD."account_id" AND NEW."friend_id" IS OLD."friend_id" AND NEW."class_kind" IS OLD."class_kind" AND NEW."class_id" IS OLD."class_id" AND NEW."plan_id" IS OLD."plan_id" AND NEW."plan_version" IS OLD."plan_version" AND NEW."name" IS OLD."name" AND NEW."amount" IS OLD."amount" AND NEW."currency" IS OLD."currency" AND NEW."monthly_limit" IS OLD."monthly_limit" AND NEW."timezone" IS OLD."timezone" AND NEW."consent_version" IS OLD."consent_version" AND NEW."consented_at" IS OLD."consented_at" AND NEW."connected_account" IS OLD."connected_account" AND NEW."connection_identity" IS OLD."connection_identity" AND NEW."payment_method_id" IS OLD."payment_method_id" AND NEW."payment_method_version" IS OLD."payment_method_version" AND NEW."setup_session_id" IS OLD."setup_session_id" AND NEW."setup_expires_at" IS OLD."setup_expires_at" AND NEW."state" IS OLD."state" AND NEW."stop_reason" IS OLD."stop_reason" AND NEW."stop_effective_at" IS OLD."stop_effective_at" AND NEW."service_state" IS OLD."service_state" AND NEW."service_reason" IS OLD."service_reason" AND NEW."attention_episode_id" IS OLD."attention_episode_id" AND NEW."attention_started_at" IS OLD."attention_started_at" AND NEW."request_key" IS OLD."request_key" AND NEW."test_mode" IS OLD."test_mode" AND NEW."created_at" IS OLD."created_at") AND NEW.customer_id IS NULL))  OR NEW.version!=OLD.version+1  OR (OLD.state='expired' AND NEW.state!=OLD.state)  OR (OLD.state='stopped' AND NEW.state!=OLD.state AND NOT(NEW.state='active' AND OLD.stop_reason='unpaid'    AND NEW.stop_reason IS NULL AND NEW.stop_effective_at IS NULL AND EXISTS(SELECT 1 FROM booking_monthly_cycles y      WHERE y.contract_id=NEW.id AND y.state='paid' AND julianday(y.service_start)<=julianday('now') AND julianday(y.service_end)>julianday('now'))))  OR (OLD.state IN('active','stop_scheduled') AND NEW.state IN('applying','expired'))  OR (OLD.stop_reason IN('member_request','store_request','store_immediate') AND    (NEW.stop_reason IS NOT OLD.stop_reason AND NOT(NEW.stop_reason IS 'store_immediate' AND julianday(NEW.stop_effective_at)<=julianday(OLD.stop_effective_at))     OR NEW.stop_effective_at IS NULL OR julianday(NEW.stop_effective_at)>julianday(OLD.stop_effective_at)))  OR (NEW.state IN('active','stop_scheduled') AND NOT EXISTS(SELECT 1 FROM booking_monthly_active_slots s WHERE s.contract_id=NEW.id))  OR (OLD.state='applying' AND NEW.state IN('active','stop_scheduled') AND NOT EXISTS(SELECT 1 FROM booking_monthly_cycles y WHERE y.contract_id=NEW.id AND y.kind='initial' AND y.state='paid'))  OR (NEW.payment_method_id IS NOT OLD.payment_method_id AND NEW.payment_method_version!=OLD.payment_method_version+1)  OR (OLD.attention_started_at IS NOT NULL AND NEW.attention_started_at IS NOT NULL AND julianday(NEW.attention_started_at)>julianday(OLD.attention_started_at)) BEGIN SELECT RAISE(ABORT,'monthly_contract_conflict'); END;

-- 旧料金契約の照合用記録には期限を付ける。
ALTER TABLE billing_events ADD COLUMN retained_until TEXT;

-- 墓石の表示除外と再利用防止の正本。処理完了後・再開後も削除しない。
CREATE TABLE tenant_purge_tombstone_progress (
  tenant_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, table_name, row_id)
);

-- 外部操作の応答が未確定なら、借受期限が切れても purge を始めない。
ALTER TABLE billing_events ADD COLUMN external_effect_pending INTEGER NOT NULL DEFAULT 0 CHECK (external_effect_pending IN (0,1));

-- 終了済みの月謝履歴で決済手段の識別子だけを不可逆な固定値に置換する。
DROP TRIGGER booking_monthly_attempt_identity;
CREATE TRIGGER booking_monthly_attempt_identity BEFORE UPDATE ON booking_monthly_attempts WHEN
 NEW.cycle_id IS NOT OLD.cycle_id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.account_id IS NOT OLD.account_id
 OR NEW.attempt_no IS NOT OLD.attempt_no OR NEW.scheduled_at IS NOT OLD.scheduled_at OR NEW.request_key IS NOT OLD.request_key
 OR (NEW.payment_method_id IS NOT OLD.payment_method_id AND NOT (
   NEW.payment_method_id='purged:'||OLD.cycle_id||':'||OLD.attempt_no
   AND NEW.state IS OLD.state AND NEW.started_at IS OLD.started_at AND NEW.finished_at IS OLD.finished_at AND NEW.error_code IS OLD.error_code
   AND EXISTS(SELECT 1 FROM line_accounts a JOIN tenants t ON t.id=a.tenant_id JOIN booking_monthly_cycles y ON y.id=OLD.cycle_id JOIN booking_monthly_contracts c ON c.id=y.contract_id
     WHERE a.id=OLD.account_id AND a.tenant_id=OLD.tenant_id AND a.data_purged_at IS NOT NULL
       AND t.purge_started_at IS NOT NULL AND t.data_purged_at IS NULL AND c.state IN ('stopped','expired'))))
 OR NEW.payment_method_version IS NOT OLD.payment_method_version OR NEW.version!=OLD.version+1
 OR OLD.state IN('succeeded','failed','canceled') AND NEW.state!=OLD.state
BEGIN SELECT RAISE(ABORT,'monthly_attempt_conflict'); END;

-- 公開版のWebhook秘密だけを統括purge時に取り除く。
DROP TRIGGER trg_form_versions_immutable;
CREATE TRIGGER trg_form_versions_immutable
BEFORE UPDATE ON form_versions
WHEN NOT (NEW.on_submit_webhook_url IS NULL AND NEW.on_submit_webhook_headers IS NULL AND NEW."id" IS OLD."id" AND NEW."form_id" IS OLD."form_id" AND NEW."version_number" IS OLD."version_number" AND NEW."source_content_revision" IS OLD."source_content_revision" AND NEW."name" IS OLD."name" AND NEW."description" IS OLD."description" AND NEW."fields" IS OLD."fields" AND NEW."layout" IS OLD."layout" AND NEW."on_submit_tag_id" IS OLD."on_submit_tag_id" AND NEW."on_submit_scenario_id" IS OLD."on_submit_scenario_id" AND NEW."on_submit_message_type" IS OLD."on_submit_message_type" AND NEW."on_submit_message_content" IS OLD."on_submit_message_content" AND NEW."on_submit_webhook_fail_message" IS OLD."on_submit_webhook_fail_message" AND NEW."save_to_metadata" IS OLD."save_to_metadata" AND NEW."og_title" IS OLD."og_title" AND NEW."og_description" IS OLD."og_description" AND NEW."og_image_url" IS OLD."og_image_url" AND NEW."status" IS OLD."status" AND NEW."published_at" IS OLD."published_at" AND NEW."created_at" IS OLD."created_at"
  AND EXISTS (SELECT 1 FROM form_accounts fa JOIN line_accounts a ON a.id=fa.line_account_id JOIN tenants t ON t.id=a.tenant_id
    WHERE fa.form_id=OLD.form_id AND a.data_purged_at IS NOT NULL AND t.purge_started_at IS NOT NULL AND t.data_purged_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM form_accounts other JOIN line_accounts oa ON oa.id=other.line_account_id
        WHERE other.form_id=OLD.form_id AND (oa.tenant_id IS NOT t.id OR oa.data_purged_at IS NULL))))
BEGIN SELECT RAISE(ABORT, 'published form versions are immutable'); END;

-- 公開済みアクションは種類とIDだけを残して本文を消す。
DROP TRIGGER trg_common_action_published_version_immutable;
CREATE TRIGGER trg_common_action_published_version_immutable
BEFORE UPDATE ON common_action_versions
WHEN OLD.status = 'published' AND NOT (NEW."id" IS OLD."id" AND NEW."common_action_id" IS OLD."common_action_id" AND NEW."version_number" IS OLD."version_number" AND NEW."status" IS OLD."status" AND NEW."created_by" IS OLD."created_by" AND NEW."created_at" IS OLD."created_at" AND NEW."published_at" IS OLD."published_at" AND NEW."draft_revision" IS OLD."draft_revision" AND json_valid(OLD.action_config) AND json_type(OLD.action_config)='array'
  AND NEW.action_config=(SELECT json_group_array(json_object('id',CASE WHEN json_type(value,'$.id')='text' AND length(json_extract(value,'$.id')) BETWEEN 1 AND 80 AND json_extract(value,'$.id') NOT GLOB '*[^A-Za-z0-9_-]*' THEN json_extract(value,'$.id') ELSE NULL END,
    'type',CASE WHEN json_type(value,'$.type')='text' AND json_extract(value,'$.type') IN ('send_message','set_friend_fields','run_common_action','add_tag','remove_tag','explicit','segment','tag','friend_field','support_mark','scenario','common_var','send_template','reminder','event_booking','notify_staff','start_scenario','same_kind','list','daily','weekly','monthly','manual','purchase') THEN json_extract(value,'$.type') ELSE NULL END)) FROM json_each(OLD.action_config) WHERE type='object')
  AND EXISTS(SELECT 1 FROM common_actions ca JOIN line_accounts a ON a.id=ca.line_account_id JOIN tenants t ON t.id=a.tenant_id
    WHERE ca.id=OLD.common_action_id AND a.data_purged_at IS NOT NULL AND t.purge_started_at IS NOT NULL AND t.data_purged_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'published common action version is immutable'); END;
