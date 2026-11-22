import { retentionCutoff } from '@line-crm/db';

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
