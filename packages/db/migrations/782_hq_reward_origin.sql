ALTER TABLE mileage_rewards ADD COLUMN hq_template_id TEXT;
ALTER TABLE mileage_rewards ADD COLUMN hq_template_version_id TEXT;
-- 既存の配布記録が成功した景品だけ、最後に配ったひな形を記録する。
UPDATE mileage_rewards AS reward SET
 hq_template_id=(SELECT r.template_id FROM hq_template_preflight_resolutions r JOIN hq_template_distribution_results d ON d.preflight_id=r.preflight_id AND d.tenant_id=r.tenant_id WHERE r.item_kind='mileage_reward' AND r.target_id=reward.id AND r.target_account_id=reward.line_account_id AND d.status='succeeded' ORDER BY d.finished_at DESC,d.rowid DESC LIMIT 1),
 hq_template_version_id=(SELECT r.template_version_id FROM hq_template_preflight_resolutions r JOIN hq_template_distribution_results d ON d.preflight_id=r.preflight_id AND d.tenant_id=r.tenant_id WHERE r.item_kind='mileage_reward' AND r.target_id=reward.id AND r.target_account_id=reward.line_account_id AND d.status='succeeded' ORDER BY d.finished_at DESC,d.rowid DESC LIMIT 1)
 WHERE EXISTS(SELECT 1 FROM hq_template_preflight_resolutions r JOIN hq_template_distribution_results d ON d.preflight_id=r.preflight_id AND d.tenant_id=r.tenant_id WHERE r.item_kind='mileage_reward' AND r.target_id=reward.id AND r.target_account_id=reward.line_account_id AND d.status='succeeded');
CREATE TRIGGER mileage_reward_hq_origin_update BEFORE UPDATE OF hq_template_id,hq_template_version_id ON mileage_rewards
WHEN NEW.hq_template_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM hq_templates t JOIN hq_template_versions v ON v.template_id=t.id AND v.tenant_id=t.tenant_id
 JOIN line_accounts a ON a.tenant_id=t.tenant_id WHERE t.id=NEW.hq_template_id AND t.archived_at IS NULL
 AND v.id=NEW.hq_template_version_id AND a.id=NEW.line_account_id
) BEGIN SELECT RAISE(ABORT,'hq_origin_account_mismatch'); END;
