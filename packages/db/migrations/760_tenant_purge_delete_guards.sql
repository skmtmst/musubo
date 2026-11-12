-- A marker exists only within the atomic tenant purge batch.
CREATE TABLE tenant_purge_guard (
  tenant_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  PRIMARY KEY (tenant_id, table_name)
);

DROP TRIGGER trg_action_score_published_version_no_delete;
CREATE TRIGGER trg_action_score_published_version_no_delete
BEFORE DELETE ON action_score_rule_versions
WHEN (OLD.status = 'published') AND NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'action_score_rule_versions' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.rule_set_id IN (SELECT p_action_score_rule_sets.id FROM action_score_rule_sets p_action_score_rule_sets WHERE p_action_score_rule_sets.line_account_id IN (SELECT id FROM line_accounts WHERE tenant_id = g.tenant_id)))
BEGIN SELECT RAISE(ABORT, 'published action score version cannot be deleted'); END;

DROP TRIGGER trg_analytics_funnel_versions_no_delete;
CREATE TRIGGER trg_analytics_funnel_versions_no_delete
BEFORE DELETE ON analytics_funnel_versions
WHEN NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'analytics_funnel_versions' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.line_account_id IN (SELECT id FROM line_accounts WHERE tenant_id = g.tenant_id))
BEGIN SELECT RAISE(ABORT, 'analytics_funnel_version_immutable'); END;

DROP TRIGGER trg_analytics_saved_versions_no_delete;
CREATE TRIGGER trg_analytics_saved_versions_no_delete
BEFORE DELETE ON analytics_saved_analysis_versions
WHEN NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'analytics_saved_analysis_versions' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.line_account_id IN (SELECT id FROM line_accounts WHERE tenant_id = g.tenant_id))
BEGIN SELECT RAISE(ABORT, 'analytics_saved_version_immutable'); END;

DROP TRIGGER trg_auto_reply_versions_immutable_delete;
CREATE TRIGGER trg_auto_reply_versions_immutable_delete
BEFORE DELETE ON auto_reply_versions
WHEN (OLD.status IN ('published', 'retired')) AND NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'auto_reply_versions' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.line_account_id IN (SELECT id FROM line_accounts WHERE tenant_id = g.tenant_id))
BEGIN SELECT RAISE(ABORT, 'published auto reply versions cannot be deleted'); END;

DROP TRIGGER trg_automation_published_version_no_delete;
CREATE TRIGGER trg_automation_published_version_no_delete
BEFORE DELETE ON automation_versions
WHEN (OLD.status = 'published') AND NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'automation_versions' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.automation_id IN (SELECT p_automation_definitions.id FROM automation_definitions p_automation_definitions WHERE p_automation_definitions.line_account_id IN (SELECT id FROM line_accounts WHERE tenant_id = g.tenant_id)))
BEGIN SELECT RAISE(ABORT, 'published automation version cannot be deleted'); END;

DROP TRIGGER trg_common_action_binding_migrations_no_delete;
CREATE TRIGGER trg_common_action_binding_migrations_no_delete
BEFORE DELETE ON common_action_binding_migration_events
WHEN NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'common_action_binding_migration_events' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.line_account_id IN (SELECT id FROM line_accounts WHERE tenant_id = g.tenant_id))
BEGIN SELECT RAISE(ABORT, 'common action binding migration history cannot be deleted'); END;

DROP TRIGGER trg_common_action_published_version_no_delete;
CREATE TRIGGER trg_common_action_published_version_no_delete
BEFORE DELETE ON common_action_versions
WHEN (OLD.status = 'published') AND NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'common_action_versions' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.common_action_id IN (SELECT p_common_actions.id FROM common_actions p_common_actions WHERE p_common_actions.line_account_id IN (SELECT id FROM line_accounts WHERE tenant_id = g.tenant_id)))
BEGIN SELECT RAISE(ABORT, 'published common action version cannot be deleted'); END;

DROP TRIGGER conversion_points_prevent_delete;
CREATE TRIGGER conversion_points_prevent_delete
BEFORE DELETE ON conversion_points
WHEN (EXISTS (
  SELECT 1 FROM conversion_events WHERE conversion_point_id = OLD.id
) OR EXISTS (
  SELECT 1 FROM conversion_definition_usages WHERE conversion_point_id = OLD.id
)) AND NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'conversion_points' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.tenant_id = g.tenant_id)
BEGIN SELECT RAISE(ABORT, 'conversion point with events or usages cannot be deleted'); END;

DROP TRIGGER trg_friend_add_routing_versions_immutable_delete;
CREATE TRIGGER trg_friend_add_routing_versions_immutable_delete
BEFORE DELETE ON friend_add_routing_versions
WHEN (OLD.status IN ('published', 'retired')) AND NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'friend_add_routing_versions' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.line_account_id IN (SELECT id FROM line_accounts WHERE tenant_id = g.tenant_id))
BEGIN SELECT RAISE(ABORT, 'published friend-add routing versions cannot be deleted'); END;

DROP TRIGGER trg_friend_add_rule_versions_immutable_delete;
CREATE TRIGGER trg_friend_add_rule_versions_immutable_delete
BEFORE DELETE ON friend_add_rule_versions
WHEN (OLD.status IN ('published', 'retired')) AND NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'friend_add_rule_versions' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.rule_id IN (SELECT p_friend_add_rules.id FROM friend_add_rules p_friend_add_rules WHERE p_friend_add_rules.line_account_id IN (SELECT id FROM line_accounts WHERE tenant_id = g.tenant_id)))
BEGIN SELECT RAISE(ABORT, 'published friend-add rule versions cannot be deleted'); END;

DROP TRIGGER hq_template_result_no_delete;
CREATE TRIGGER hq_template_result_no_delete
BEFORE DELETE ON hq_template_distribution_results
WHEN NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'hq_template_distribution_results' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.tenant_id = g.tenant_id)
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_RESULT_RECOVERY_LEDGER_IMMUTABLE'); END;

DROP TRIGGER hq_template_run_no_delete;
CREATE TRIGGER hq_template_run_no_delete
BEFORE DELETE ON hq_template_distribution_runs
WHEN NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'hq_template_distribution_runs' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.tenant_id = g.tenant_id)
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_RUN_RECOVERY_LEDGER_IMMUTABLE'); END;

DROP TRIGGER hq_template_r2_no_delete;
CREATE TRIGGER hq_template_r2_no_delete
BEFORE DELETE ON hq_template_owned_r2_keys
WHEN NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'hq_template_owned_r2_keys' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.tenant_id = g.tenant_id)
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_R2_RECOVERY_LEDGER_IMMUTABLE'); END;

DROP TRIGGER hq_template_logical_archive_only;
CREATE TRIGGER hq_template_logical_archive_only
BEFORE DELETE ON hq_templates
WHEN NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'hq_templates' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.tenant_id = g.tenant_id)
BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_USE_LOGICAL_ARCHIVE'); END;

DROP TRIGGER trg_mileage_redemption_attempts_no_delete;
CREATE TRIGGER trg_mileage_redemption_attempts_no_delete
BEFORE DELETE ON mileage_redemption_attempts
WHEN NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'mileage_redemption_attempts' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.redemption_id IN (SELECT p_mileage_redemptions.id FROM mileage_redemptions p_mileage_redemptions WHERE p_mileage_redemptions.line_account_id IN (SELECT id FROM line_accounts WHERE tenant_id = g.tenant_id)))
BEGIN SELECT RAISE(ABORT, 'mileage redemption attempt history cannot be deleted'); END;

DROP TRIGGER trg_mileage_redemption_step_deliveries_no_delete;
CREATE TRIGGER trg_mileage_redemption_step_deliveries_no_delete
BEFORE DELETE ON mileage_redemption_step_deliveries
WHEN NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'mileage_redemption_step_deliveries' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.redemption_id IN (SELECT p_mileage_redemptions.id FROM mileage_redemptions p_mileage_redemptions WHERE p_mileage_redemptions.line_account_id IN (SELECT id FROM line_accounts WHERE tenant_id = g.tenant_id)))
BEGIN SELECT RAISE(ABORT, 'mileage redemption step delivery history cannot be deleted'); END;

DROP TRIGGER trg_mileage_redemptions_no_delete;
CREATE TRIGGER trg_mileage_redemptions_no_delete
BEFORE DELETE ON mileage_redemptions
WHEN NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'mileage_redemptions' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.line_account_id IN (SELECT id FROM line_accounts WHERE tenant_id = g.tenant_id))
BEGIN SELECT RAISE(ABORT, 'mileage redemption history cannot be deleted'); END;

DROP TRIGGER trg_mileage_reward_published_version_no_delete;
CREATE TRIGGER trg_mileage_reward_published_version_no_delete
BEFORE DELETE ON mileage_reward_versions
WHEN (OLD.status = 'published') AND NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'mileage_reward_versions' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.reward_id IN (SELECT p_mileage_rewards.id FROM mileage_rewards p_mileage_rewards WHERE p_mileage_rewards.line_account_id IN (SELECT id FROM line_accounts WHERE tenant_id = g.tenant_id)))
BEGIN SELECT RAISE(ABORT, 'published mileage reward version cannot be deleted'); END;

DROP TRIGGER trg_reminder_version_steps_immutable_delete;
CREATE TRIGGER trg_reminder_version_steps_immutable_delete
BEFORE DELETE ON reminder_version_steps
WHEN (COALESCE((SELECT status FROM reminder_versions WHERE id = OLD.reminder_version_id), '') <> 'draft') AND NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'reminder_version_steps' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.reminder_version_id IN (SELECT p_reminder_versions.id FROM reminder_versions p_reminder_versions WHERE p_reminder_versions.reminder_id IN (SELECT p_reminders.id FROM reminders p_reminders WHERE p_reminders.line_account_id IN (SELECT id FROM line_accounts WHERE tenant_id = g.tenant_id))))
BEGIN SELECT RAISE(ABORT, 'published reminder version steps are immutable'); END;

DROP TRIGGER trg_reminder_versions_immutable_delete;
CREATE TRIGGER trg_reminder_versions_immutable_delete
BEFORE DELETE ON reminder_versions
WHEN (OLD.status IN ('published', 'superseded')) AND NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'reminder_versions' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.reminder_id IN (SELECT p_reminders.id FROM reminders p_reminders WHERE p_reminders.line_account_id IN (SELECT id FROM line_accounts WHERE tenant_id = g.tenant_id)))
BEGIN SELECT RAISE(ABORT, 'published reminder versions cannot be deleted'); END;

DROP TRIGGER trg_scenario_versions_immutable_delete;
CREATE TRIGGER trg_scenario_versions_immutable_delete
BEFORE DELETE ON scenario_versions
WHEN (OLD.status IN ('published', 'retired')
 AND EXISTS (SELECT 1 FROM scenarios WHERE id = OLD.scenario_id)) AND NOT EXISTS (SELECT 1 FROM tenant_purge_guard g JOIN tenants t ON t.id = g.tenant_id WHERE g.table_name = 'scenario_versions' AND t.data_purged_at IS NULL AND (t.plan_status = 'canceled' OR (t.plan_status = 'trialing' AND t.trial_ends_at IS NOT NULL AND t.retention_anchor_at IS NOT NULL)) AND OLD.scenario_id IN (SELECT p_scenarios.id FROM scenarios p_scenarios WHERE p_scenarios.line_account_id IN (SELECT id FROM line_accounts WHERE tenant_id = g.tenant_id)))
BEGIN SELECT RAISE(ABORT, 'published scenario versions cannot be deleted'); END;
