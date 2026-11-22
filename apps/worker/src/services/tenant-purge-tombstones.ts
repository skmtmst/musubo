import { retentionCutoff } from '@line-crm/db';

/** 券が参照するメニューの金額・期間を残し、説明と連絡先を消す。 */
export async function tombstoneBookingMenu(db: D1Database, tenantId: string, menuId: string, now: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE menus SET name='削除済み', category_label=NULL, description=NULL,
    is_active=0, deleted_at=COALESCE(deleted_at,?), auto_tag_id=NULL, intake_question=NULL,
    meeting_location=NULL, fixed_meeting_url=NULL, audience_tag_ids_json='[]', addon_menu_ids_json='[]',
    image_url=NULL, photo_media_id=NULL, hq_template_id=NULL, hq_template_version_id=NULL,
    updated_at=?, version=version+1, data_purged_at=?
    WHERE id=? AND data_purged_at IS NULL AND EXISTS (SELECT 1 FROM line_accounts a JOIN tenants t ON t.id=a.tenant_id
      WHERE a.id=menus.line_account_id AND a.tenant_id=? AND a.data_purged_at IS NOT NULL AND t.data_purged_at IS NULL
        AND (t.plan_status='canceled' OR (t.plan_status='trialing' AND t.trial_ends_at IS NOT NULL AND t.trial_ends_at < ?))
        AND (t.purge_requested_at IS NOT NULL OR (t.retention_anchor_at IS NOT NULL AND t.retention_anchor_at < ?)))`)
    .bind(now, now, now, menuId, tenantId, now, retentionCutoff(now)).run();
  return Number(result.meta.changes ?? 0) === 1;
}

/** 販売を止め、金額・有効期間を残して券プランの識別情報を消す。 */
export async function tombstonePassPlan(db: D1Database, tenantId: string, planId: string, now: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE booking_pass_plans SET name='削除済み', status='stopped',
    created_by=?, idempotency_key=?, request_json=json_set(request_json,'$.name','削除済み'),
    version=version+1, data_purged_at=?
    WHERE id=? AND data_purged_at IS NULL AND json_valid(request_json) AND EXISTS (SELECT 1 FROM line_accounts a JOIN tenants t ON t.id=a.tenant_id
      WHERE a.id=booking_pass_plans.line_account_id AND a.tenant_id=? AND a.data_purged_at IS NOT NULL AND t.data_purged_at IS NULL
        AND (t.plan_status='canceled' OR (t.plan_status='trialing' AND t.trial_ends_at IS NOT NULL AND t.trial_ends_at < ?))
        AND (t.purge_requested_at IS NOT NULL OR (t.retention_anchor_at IS NOT NULL AND t.retention_anchor_at < ?)))`)
    .bind(`purged:${crypto.randomUUID()}`, `purged:${crypto.randomUUID()}`, now, planId, tenantId, now, retentionCutoff(now)).run();
  return Number(result.meta.changes ?? 0) === 1;
}

/** 配信の承認履歴を残し、停止済みアカウントの配信内容を消す。 */
export async function tombstoneBroadcast(db: D1Database, tenantId: string, broadcastId: string, now: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE broadcasts SET
    title='削除済み', message_type='text', message_content='', target_type='all', target_tag_id=NULL,
    status=CASE WHEN status='sent' THEN 'sent' ELSE 'draft' END, scheduled_at=NULL, alt_text=NULL, line_request_id=NULL, aggregation_unit=NULL,
    segment_conditions=NULL, account_ids=NULL, dedup_priority=NULL, failed_account_ids=NULL, dedup_progress=NULL,
    batch_lock_at=NULL, message_bubbles_json=NULL, folder_id=NULL, internal_memo=NULL, draft_step=NULL,
    draft_payload_json=NULL, message_options_json=NULL, after_action_version_id=NULL, stopped_at=CASE WHEN status='sent' THEN stopped_at ELSE ? END, stopped_by=NULL,
    common_var_snapshot=NULL, common_var_snapshot_at=NULL, approval_requested_by_staff_id=NULL,
    approval_approver_staff_id=NULL, approval_note=NULL, approval_decided_by_staff_id=NULL, approval_reject_reason=NULL,
    lock_version=lock_version+1, data_purged_at=?
    WHERE id=? AND data_purged_at IS NULL AND EXISTS (
      SELECT 1 FROM tenants t WHERE t.id=? AND t.data_purged_at IS NULL
        AND (t.plan_status='canceled' OR (t.plan_status='trialing' AND t.trial_ends_at IS NOT NULL AND t.trial_ends_at < ?))
        AND (t.purge_requested_at IS NOT NULL OR (t.retention_anchor_at IS NOT NULL AND t.retention_anchor_at < ?)))
      AND (EXISTS (SELECT 1 FROM line_accounts a WHERE a.id=broadcasts.line_account_id AND a.tenant_id=? AND a.data_purged_at IS NOT NULL)
        OR (broadcasts.target_type='multi-account-dedup' AND json_array_length(broadcasts.account_ids)>0))
      AND NOT EXISTS (SELECT 1 FROM line_accounts a WHERE a.id=broadcasts.line_account_id AND (a.tenant_id IS NOT ? OR a.data_purged_at IS NULL))
      AND NOT EXISTS (SELECT 1 FROM broadcast_ab_tests ab WHERE ab.broadcast_id=broadcasts.id)
      AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(broadcasts.account_ids,'[]')) j
        WHERE NOT EXISTS (SELECT 1 FROM line_accounts a WHERE a.id=j.value AND a.tenant_id=? AND a.data_purged_at IS NOT NULL))`)
    .bind(now, now, broadcastId, tenantId, now, retentionCutoff(now), tenantId, tenantId, tenantId).run();
  return Number(result.meta.changes ?? 0) === 1;
}

/** 組織参照の履歴を残し、店舗の処理が済んだ組織の識別情報を消す。 */
export async function tombstoneRestaurantOrganization(db: D1Database, tenantId: string, organizationId: string, now: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE rt_organizations SET
    name='削除済み', account_id=?, status='archived', updated_at=?, data_purged_at=?
    WHERE id=? AND tenant_id=? AND data_purged_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM rt_stores s WHERE s.organization_id=rt_organizations.id AND s.data_purged_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM line_accounts a WHERE a.tenant_id=rt_organizations.tenant_id AND a.data_purged_at IS NULL)
      AND EXISTS (SELECT 1 FROM tenants t WHERE t.id=rt_organizations.tenant_id AND t.data_purged_at IS NULL
        AND (t.plan_status='canceled' OR (t.plan_status='trialing' AND t.trial_ends_at IS NOT NULL AND t.trial_ends_at < ?))
        AND (t.purge_requested_at IS NOT NULL OR (t.retention_anchor_at IS NOT NULL AND t.retention_anchor_at < ?)))`)
    .bind(`purged:${crypto.randomUUID()}`, now, now, organizationId, tenantId, now, retentionCutoff(now)).run();
  return Number(result.meta.changes ?? 0) === 1;
}

/** 承認履歴が参照する店舗を残し、統括とアカウントの範囲を確認して匿名化する。 */
export async function tombstoneRestaurantStore(db: D1Database, tenantId: string, storeId: string, now: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE rt_stores SET
    name='削除済み', code=?, area=NULL, latitude=NULL, longitude=NULL,
    status='archived', line_status='unconfigured', google_status='unconfigured',
    capacity=0, updated_at=?, data_purged_at=?
    WHERE id=? AND data_purged_at IS NULL AND EXISTS (
      SELECT 1 FROM rt_organizations o JOIN tenants t ON t.id=o.tenant_id
      WHERE o.id=rt_stores.organization_id AND t.id=?
        AND (rt_stores.line_account_id IS NULL OR EXISTS (
          SELECT 1 FROM line_accounts a WHERE a.id=rt_stores.line_account_id
            AND a.tenant_id=t.id AND a.data_purged_at IS NOT NULL))
        AND t.data_purged_at IS NULL
        AND (t.plan_status='canceled' OR (t.plan_status='trialing' AND t.trial_ends_at IS NOT NULL AND t.trial_ends_at < ?))
        AND (t.purge_requested_at IS NOT NULL OR (t.retention_anchor_at IS NOT NULL AND t.retention_anchor_at < ?))
    )`).bind(`purged:${crypto.randomUUID()}`, now, now, storeId, tenantId, now, retentionCutoff(now)).run();
  return Number(result.meta.changes ?? 0) === 1;
}

/** 保持参照の親を消さず、期限到来済みの統括のアカウントから識別情報と資格情報を消す。 */
export async function tombstoneLineAccount(db: D1Database, tenantId: string, accountId: string, now: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE line_accounts SET
    channel_id=?, name='削除済み', channel_access_token='', channel_secret='',
    channel_access_token_encrypted=NULL, channel_secret_encrypted=NULL,
    channel_access_token_updated_at=NULL, channel_secret_updated_at=NULL, login_channel_secret_updated_at=NULL,
    is_active=0, is_default=0, archived_at=COALESCE(archived_at,?), archived_by=NULL, archived_reason=NULL,
    country=NULL, role=NULL, display_order=0, og_site_name=NULL, og_default_image_url=NULL,
    og_default_description=NULL, official_profile_url=NULL, login_channel_id=NULL, login_channel_secret=NULL,
    liff_id=NULL, token_expires_at=NULL, friend_capacity=NULL, capacity_warn_at=NULL, icon_url=NULL,
    parent_line_account_id=NULL, timezone='Asia/Tokyo', provider_id=NULL, revision=revision+1,
    line_display_name=NULL, line_picture_url=NULL, line_basic_id=NULL, line_profile_synced_at=NULL,
    inactive_reason='manual', inactive_reason_detail=NULL, inactivated_at=?, login_channel_secret_encrypted=NULL,
    last_webhook_received_at=NULL, webhook_silence_exempt=0, folder_id=NULL, created_by_staff_id=NULL,
    updated_at=?, data_purged_at=?
    WHERE id=? AND tenant_id=? AND data_purged_at IS NULL AND EXISTS (
      SELECT 1 FROM tenants t WHERE t.id=line_accounts.tenant_id AND t.data_purged_at IS NULL
        AND (t.plan_status='canceled' OR (t.plan_status='trialing' AND t.trial_ends_at IS NOT NULL AND t.trial_ends_at < ?))
        AND (t.purge_requested_at IS NOT NULL OR (t.retention_anchor_at IS NOT NULL AND t.retention_anchor_at < ?))
    )`).bind(`purged:${crypto.randomUUID()}`, now, now, now, now, accountId, tenantId, now, retentionCutoff(now)).run();
  return Number(result.meta.changes ?? 0) === 1;
}

/** 月謝などの保持参照のために必要な友だちの行を、アカウント墓石の下だけで匿名化する。 */
export async function tombstoneFriend(db: D1Database, accountId: string, friendId: string, now: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE friends SET
    line_user_id=?, display_name=NULL, picture_url=NULL, status_message=NULL, is_following=0,
    user_id=NULL, ig_igsid=NULL, score=0, last_ref_code=NULL, last_ref_at=NULL,
    first_followed_at=NULL, current_follow_started_at=NULL, last_followed_at=NULL, last_unfollowed_at=NULL,
    unfollow_count=0, ref_code=NULL, metadata='{}', first_tracked_link_id=NULL, support_mark_id=NULL,
    is_hidden=1, real_name=NULL, system_display_name=NULL, private_memo=NULL, photo_watch_required=0,
    member_number=NULL, created_at=?, updated_at=?, data_purged_at=?
    WHERE id=? AND line_account_id=? AND data_purged_at IS NULL
      AND EXISTS(SELECT 1 FROM line_accounts a JOIN tenants t ON t.id=a.tenant_id
        WHERE a.id=friends.line_account_id AND a.data_purged_at IS NOT NULL AND t.data_purged_at IS NULL
          AND (t.plan_status='canceled' OR (t.plan_status='trialing' AND t.trial_ends_at IS NOT NULL AND t.trial_ends_at < ?))
          AND (t.purge_requested_at IS NOT NULL OR (t.retention_anchor_at IS NOT NULL AND t.retention_anchor_at < ?)))`)
    .bind(`purged:${crypto.randomUUID()}`, now, now, now, friendId, accountId, now, retentionCutoff(now)).run();
  return Number(result.meta.changes ?? 0) === 1;
}
