import { retentionCutoff } from '@line-crm/db';

/** 再開と同時に始めないよう、期限の確認と開始の印を同じ文で書く。 */
export async function claimTenantPurge(db: D1Database, tenantId: string, now: string, hasHashKey = true): Promise<boolean> {
  const result = await db.prepare(`UPDATE tenants SET purge_started_at=COALESCE(purge_started_at,?)
    WHERE id=? AND data_purged_at IS NULL
      AND (plan_status='canceled' OR (plan_status='trialing' AND trial_ends_at IS NOT NULL AND trial_ends_at < ?))
      AND (purge_requested_at IS NOT NULL OR (retention_anchor_at IS NOT NULL AND retention_anchor_at < ?))
      AND (?=1 OR (stripe_customer_id IS NULL AND stripe_subscription_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM musubo_tenant_billing b WHERE b.tenant_id=tenants.id AND (b.core_subscription_id IS NOT NULL OR b.options_subscription_id IS NOT NULL))
        AND NOT EXISTS(SELECT 1 FROM billing_invoices i WHERE i.tenant_id=tenants.id AND (i.stripe_customer_id IS NOT NULL OR i.subscription_id IS NOT NULL))))
      AND (purge_started_at IS NOT NULL OR (
        NOT EXISTS (SELECT 1 FROM billing_events e WHERE e.tenant_id=tenants.id AND (e.external_effect_pending=1 OR (e.summary='pending' AND e.lease_token IS NOT NULL AND julianday(e.lease_until)>julianday('now'))) )
        AND NOT EXISTS (SELECT 1 FROM musubo_tenant_billing b WHERE b.tenant_id=tenants.id AND b.resumption_requested_at IS NOT NULL)))`)
    .bind(now, tenantId, now, retentionCutoff(now),hasHashKey ? 1 : 0).run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function tenantPurgeInProgress(db: D1Database, tenantId: string): Promise<boolean> {
  const row = await db.prepare('SELECT purge_started_at FROM tenants WHERE id=?').bind(tenantId).first<{purge_started_at:string|null}>();
  return Boolean(row?.purge_started_at);
}

/** 通知処理の借受。purge の印と借受の取得を同じ文で照合する。 */
export async function claimBillingEventLease(db: D1Database, eventId: string, token: string, now: string, until: string): Promise<boolean> {
  if (!now.endsWith('Z') || !until.endsWith('Z') || !Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(until)) || Date.parse(until)<=Date.parse(now)) throw new Error('invalid_billing_lease_time');
  const result = await db.prepare(`UPDATE billing_events SET lease_token=?,lease_until=?
    WHERE id=? AND summary='pending' AND external_effect_pending=0 AND (lease_token IS NULL OR julianday(lease_until)<=julianday('now'))
      AND julianday(?)>julianday('now') AND julianday(?)<=julianday('now','+16 minutes')
      AND (tenant_id IS NULL OR EXISTS(SELECT 1 FROM tenants t WHERE t.id=billing_events.tenant_id
        AND t.purge_started_at IS NULL AND t.data_purged_at IS NULL))`)
    .bind(token, until, eventId, until, until).run();
  return Number(result.meta.changes ?? 0) === 1;
}

/** 請求書・統括への書き込みで使う借受フェンス。適用先の統括も同時に照合する。 */
export function billingEventLeaseFence(eventId:string, tenantId:string|null, token:string): {sql:string;values:unknown[]} {
  return {sql:`EXISTS (SELECT 1 FROM billing_events lease_event
    WHERE lease_event.id=? AND lease_event.tenant_id IS ? AND lease_event.summary='pending' AND lease_event.lease_token=?
      AND julianday(lease_event.lease_until)>julianday('now') AND (lease_event.tenant_id IS NULL OR EXISTS (
        SELECT 1 FROM tenants t WHERE t.id=lease_event.tenant_id AND t.purge_started_at IS NULL AND t.data_purged_at IS NULL)))`,
    values:[eventId,tenantId,token]};
}

/** 期限切れ・交代済みの処理による通知の完了を受け付けない。時刻は UTC の ISO 形式。 */
export function prepareCompleteBillingEventLease(db: D1Database, eventId: string, token: string, summary: string): D1PreparedStatement {
  return db.prepare(`UPDATE billing_events SET summary=?,lease_token=NULL,lease_until=NULL
    WHERE id=? AND summary='pending' AND lease_token=? AND julianday(lease_until)>julianday('now')
      AND (tenant_id IS NULL OR EXISTS(SELECT 1 FROM tenants t WHERE t.id=billing_events.tenant_id AND t.purge_started_at IS NULL AND t.data_purged_at IS NULL))`)
    .bind(summary,eventId,token);
}

/** 完了を最後に検証し、失敗なら同じ batch の前の書き込みも巻き戻す。 */
function prepareAssertBillingEventLeaseCompleted(db: D1Database): D1PreparedStatement {
  return db.prepare("SELECT json(CASE WHEN changes()=1 THEN 'true' ELSE 'BILLING_LEASE_EXPIRED' END)");
}

/** 完了と検証を隣接させ、途中の文によって changes() が変わるのを防ぐ。 */
export function prepareBillingEventLeaseCompletion(db: D1Database, eventId: string, token: string, summary: string): [D1PreparedStatement, D1PreparedStatement] {
  return [prepareCompleteBillingEventLease(db, eventId, token, summary), prepareAssertBillingEventLeaseCompleted(db)];
}

export async function releaseBillingEventLease(db: D1Database, eventId: string, token: string): Promise<boolean> {
  const result = await db.prepare('UPDATE billing_events SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND external_effect_pending=0')
    .bind(eventId, token).run();
  return Number(result.meta.changes ?? 0) === 1;
}

/** 削除中・削除済みへの通知を、本文や顧客情報なしで照合待ちとして保存する。 */
export async function recordPurgedTenantStripeEvent(db: D1Database, input: {
  tenantId: string; eventId: string; eventType: string; amount: number | null; currency: string | null; now: string;
}): Promise<boolean> {
  if (!/^evt_[A-Za-z0-9_]+$/.test(input.eventId) || !/^[a-z0-9_.]+$/.test(input.eventType)
    || (input.amount !== null && !Number.isSafeInteger(input.amount))
    || (input.currency !== null && !/^[a-z]{3}$/.test(input.currency))) throw new Error('invalid_stripe_review_event');
  const result = await db.prepare(`INSERT OR IGNORE INTO stripe_events
    (id,stripe_event_id,event_type,amount,currency,metadata,processed_at,tenant_id,review_reason)
    SELECT ?,?,?,?,?,NULL,?,?,'purged_tenant' WHERE EXISTS (
      SELECT 1 FROM tenants t WHERE t.id=? AND (t.purge_started_at IS NOT NULL OR t.data_purged_at IS NOT NULL))`)
    .bind(crypto.randomUUID(), input.eventId, input.eventType, input.amount, input.currency, input.now, input.tenantId, input.tenantId).run();
  return Number(result.meta.changes ?? 0) === 1;
}

/** 通知の受領記録を照合待ちにし、二度処理を始められないようにする。 */
export async function deferPurgedBillingEvent(db: D1Database, input: {
  tenantId: string; eventId: string; eventType: string; amount: number | null; currency: string | null; now: string; retiredMatch?: boolean;
}): Promise<boolean> {
  if (!input.now.endsWith('Z') || !Number.isFinite(Date.parse(input.now))) throw new Error('invalid_billing_lease_time');
  if (!/^evt_[A-Za-z0-9_]+$/.test(input.eventId) || !/^[a-z0-9_.]+$/.test(input.eventType)
    || (input.amount !== null && !Number.isSafeInteger(input.amount))
    || (input.currency !== null && !/^[a-z]{3}$/.test(input.currency))) throw new Error('invalid_stripe_review_event');
  const record = db.prepare(`INSERT OR IGNORE INTO stripe_events
    (id,stripe_event_id,event_type,amount,currency,metadata,processed_at,tenant_id,review_reason)
    SELECT ?,?,?,?,?,NULL,?,?,'purged_tenant' WHERE EXISTS (
      SELECT 1 FROM tenants t JOIN billing_events e ON e.tenant_id=t.id
      WHERE t.id=? AND e.id=? AND e.summary='pending' AND (e.lease_token IS NULL OR julianday(e.lease_until)<=julianday('now'))
        AND (t.purge_started_at IS NOT NULL OR t.data_purged_at IS NOT NULL OR ?=1))`)
    .bind(crypto.randomUUID(),input.eventId,input.eventType,input.amount,input.currency,input.now,input.tenantId,input.tenantId,input.eventId,input.retiredMatch ? 1 : 0);
  const defer = db.prepare(`UPDATE billing_events SET summary='purge_review',lease_token=NULL,lease_until=NULL
    WHERE id=? AND tenant_id=? AND summary='pending' AND (lease_token IS NULL OR julianday(lease_until)<=julianday('now')) AND EXISTS (
      SELECT 1 FROM stripe_events s WHERE s.stripe_event_id=billing_events.id
        AND s.tenant_id=billing_events.tenant_id AND s.review_reason='purged_tenant')`)
    .bind(input.eventId,input.tenantId);
  const alert = db.prepare(`INSERT INTO security_alerts
    (id,tenant_id,line_account_id,scope_key,rule_key,observed_count,threshold_count,first_detected_at,last_detected_at,latest_event_at,notification_id,slack_last_error)
    SELECT ?,?,NULL,json_array(?,?), 'stripe_purge_review',1,1,?,?,julianday(?),?,'unconfigured' WHERE changes()=1`)
    .bind(crypto.randomUUID(),input.tenantId,input.tenantId,input.eventId,input.now,input.now,input.now,crypto.randomUUID());
  const results = await db.batch([record,defer,alert]);
  if (Number(results[1].meta.changes ?? 0) === 1) return true;
  const existing = await db.prepare(`SELECT 1 AS found FROM billing_events e JOIN stripe_events s ON s.stripe_event_id=e.id
    WHERE e.id=? AND e.tenant_id=? AND e.summary='purge_review' AND s.tenant_id=e.tenant_id AND s.review_reason='purged_tenant'`)
    .bind(input.eventId,input.tenantId).first<{found:number}>();
  return Boolean(existing);
}

/** 期限切れの借受と借受なしの受領を、保存済み金額とともに照合待ちへ移す。 */
export async function deferStaleBillingReceipts(db: D1Database, tenantId: string, now: string, limit=100): Promise<number> {
  if (!now.endsWith('Z') || !Number.isFinite(Date.parse(now))) throw new Error('invalid_billing_lease_time');
  const rows=await db.prepare(`SELECT id,type,review_amount,review_currency FROM billing_events
    WHERE tenant_id=? AND summary='pending' AND external_effect_pending=0 AND (lease_token IS NULL OR julianday(lease_until)<=julianday('now'))
    ORDER BY received_at,id LIMIT ?`).bind(tenantId,Math.min(100,Math.max(1,Math.floor(limit)))).all<{
      id:string;type:string;review_amount:number|null;review_currency:string|null;
    }>();
  let deferred=0;
  for(const row of rows.results) {
    if(await deferPurgedBillingEvent(db,{tenantId,eventId:row.id,eventType:row.type,amount:row.review_amount,currency:row.review_currency,now})) deferred++;
  }
  return deferred;
}

/** 券が参照する店のメニュー定義を残し、再利用を止める。 */
export async function tombstoneBookingMenu(db: D1Database, tenantId: string, menuId: string, now: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE menus SET is_active=0, deleted_at=COALESCE(deleted_at,?),
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

/** Stop and anonymize a retained monthly contract after its account becomes a tombstone. */
export async function anonymizeMonthlyContract(db: D1Database, tenantId: string, contractId: string, now: string): Promise<boolean> {
  const scope = `id=? AND tenant_id=? AND EXISTS (SELECT 1 FROM line_accounts a JOIN tenants t ON t.id=a.tenant_id
    WHERE a.id=booking_monthly_contracts.account_id AND a.tenant_id=booking_monthly_contracts.tenant_id
      AND a.data_purged_at IS NOT NULL AND t.purge_started_at IS NOT NULL AND t.data_purged_at IS NULL)`;
  const result = await db.batch([
    db.prepare(`UPDATE booking_monthly_contracts SET name='削除済み',
      state=CASE WHEN state='applying' THEN 'expired' WHEN state='expired' THEN 'expired' ELSE 'stopped' END,
      stop_reason=CASE WHEN state IN ('applying','expired') THEN stop_reason ELSE COALESCE(stop_reason,'store_immediate') END,
      stop_effective_at=CASE WHEN state IN ('applying','expired') THEN stop_effective_at ELSE COALESCE(stop_effective_at,?) END,
      payment_method_version=payment_method_version+CASE WHEN payment_method_id IS NULL THEN 0 ELSE 1 END,
      payment_method_id=NULL,setup_session_id=NULL,setup_expires_at=NULL,version=version+1
      WHERE ${scope}`).bind(now,contractId,tenantId),
    db.prepare(`UPDATE booking_monthly_contracts SET customer_id=NULL,
      request_json=json_remove(request_json,'$.friendId'),version=version+1
      WHERE ${scope}`).bind(contractId,tenantId),
    db.prepare(`UPDATE booking_monthly_attempts SET payment_method_id='purged:'||cycle_id||':'||attempt_no,version=version+1
      WHERE tenant_id=? AND cycle_id IN (SELECT id FROM booking_monthly_cycles WHERE contract_id=? AND tenant_id=?)
        AND payment_method_id<>'purged:'||cycle_id||':'||attempt_no`).bind(tenantId,contractId,tenantId),
  ]);
  return Number(result[0]?.meta.changes ?? 0) === 1 && Number(result[1]?.meta.changes ?? 0) === 1;
}

/** An uncertain external effect blocks purge even after the ordinary lease expires. */
export async function beginBillingExternalEffect(db:D1Database, eventId:string, token:string):Promise<boolean> {
  const result=await db.prepare(`UPDATE billing_events SET external_effect_pending=1
    WHERE id=? AND summary='pending' AND lease_token=? AND external_effect_pending=0
      AND julianday(lease_until)>julianday('now') AND EXISTS(SELECT 1 FROM tenants t WHERE t.id=billing_events.tenant_id
        AND t.purge_started_at IS NULL AND t.data_purged_at IS NULL)`).bind(eventId,token).run();
  return Number(result.meta.changes ?? 0)===1;
}

/** Only a definitively finished effect can release the extra hold. */
export async function endBillingExternalEffect(db:D1Database, eventId:string, token:string):Promise<boolean> {
  const result=await db.prepare(`UPDATE billing_events SET external_effect_pending=0
    WHERE id=? AND lease_token=? AND external_effect_pending=1`).bind(eventId,token).run();
  return Number(result.meta.changes ?? 0)===1;
}
