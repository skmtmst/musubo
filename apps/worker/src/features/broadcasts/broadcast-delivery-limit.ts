import type { Broadcast } from '@line-crm/db';
import type { BroadcastDeliveryLimit, SegmentCondition } from '@line-crm/shared';
import { parseBroadcastDeliveryLimit } from '@line-crm/shared';
import { DELIVERY_CONSENT_ALLOWED_SQL } from '@line-crm/db/src/friend-delivery-consents.js';
import { getLineAccountById, jstNow } from '@line-crm/db';
import { scopeStoredBroadcastSegmentQuery, restrictSegmentInput } from '../../services/segment-query-scope.js';
import { assertAnalyticsAudiencesUsable } from '../../services/segment-audience-guard.js';
import { buildBroadcastAudienceQuery } from './broadcast-audience-query.js';
import { fetchQuotaDetails, tryReserveQuotaSlot, releaseQuotaSlot } from './broadcast-quota-guard.js';

type DeliveryDefinition = Pick<Broadcast, 'id' | 'line_account_id' | 'target_type' | 'target_tag_id' | 'segment_conditions' | 'message_options_json' | 'lock_version'>;
type Confirmation = { broadcastId: string; recipientCount: number; version: number };
type Query = { sql: string; bindings: unknown[] };
export class LimitedBroadcastError extends Error {}

/** 内部の確認印はクライアント入力として受け付けない。 */
export function deliveryLimitFromOptions(options: unknown): BroadcastDeliveryLimit | null {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return null;
  return parseBroadcastDeliveryLimit((options as Record<string, unknown>).deliveryLimit);
}
export function storedDeliveryLimit(broadcast: Pick<Broadcast, 'message_options_json'>): BroadcastDeliveryLimit | null {
  if (!broadcast.message_options_json) return null;
  let options: unknown;
  try { options = JSON.parse(broadcast.message_options_json); }
  catch { throw new LimitedBroadcastError('配信の設定を読めません。下書きで内容を確かめてください。'); }
  try { return deliveryLimitFromOptions(options); }
  catch { throw new LimitedBroadcastError('配信の上限設定を読めません。下書きで人数を確かめてください。'); }
}
function storedConfirmation(broadcast: DeliveryDefinition): Confirmation {
  const options = JSON.parse(broadcast.message_options_json ?? '{}') as Record<string, unknown>;
  const value = options.deliveryLimitConfirmation as Partial<Confirmation> | undefined;
  if (!value || value.broadcastId !== broadcast.id || !Number.isSafeInteger(value.recipientCount) || Number(value.recipientCount) <= 0
    || value.version !== (broadcast.lock_version ?? 1)) {
    throw new LimitedBroadcastError('送る人数の確認が必要です。下書きで人数を確かめ直してください。');
  }
  return value as Confirmation;
}

/** 数えるときと抽選するときは、同じ所属・同意・宛先の式を使う。 */
export async function eligibleLimitedAudience(db: D1Database, broadcast: DeliveryDefinition): Promise<Query> {
  if (!broadcast.line_account_id || !['all', 'tag', 'segment'].includes(broadcast.target_type)) {
    throw new LimitedBroadcastError('人数に上限を付ける配信は、1つのLINEアカウントで作ってください。');
  }
  let conditions: SegmentCondition;
  if (broadcast.target_type === 'segment') {
    try { conditions = JSON.parse(broadcast.segment_conditions ?? '') as SegmentCondition; }
    catch { throw new LimitedBroadcastError('送る相手の条件を読み直してください。'); }
    if (!Array.isArray(conditions.rules)) throw new LimitedBroadcastError('送る相手の条件を読み直してください。');
    await assertAnalyticsAudiencesUsable(db, conditions, broadcast.line_account_id);
  } else if (broadcast.target_type === 'tag') {
    if (!broadcast.target_tag_id) throw new LimitedBroadcastError('送る相手のタグを選び直してください。');
    conditions = { operator: 'AND', rules: [{ type: 'tag_exists', value: broadcast.target_tag_id }] };
  } else {
    conditions = { operator: 'AND', rules: [{ type: 'is_following', value: true }] };
  }
  const scoped = await scopeStoredBroadcastSegmentQuery(db, buildBroadcastAudienceQuery(conditions), broadcast.line_account_id);
  return restrictSegmentInput(scoped, `trim(COALESCE(f.line_user_id,'')) != '' AND (${DELIVERY_CONSENT_ALLOWED_SQL})`);
}

export async function countLimitedAudience(db: D1Database, broadcast: DeliveryDefinition) {
  const query = await eligibleLimitedAudience(db, broadcast);
  const count = await db.prepare(`SELECT COUNT(*) AS n FROM (${query.sql})`).bind(...query.bindings).first<{ n: number }>();
  if (!count || !Number.isSafeInteger(count.n) || count.n < 0) throw new LimitedBroadcastError('送る人数を確認できません。もう一度確かめてください。');
  return {query,candidateCount:count.n};
}

export async function limitedDeliveryPlan(db: D1Database, broadcast: DeliveryDefinition,
  options: { requireConfirmation?: boolean; quota?: Awaited<ReturnType<typeof fetchQuotaDetails>> } = {}) {
  const limit = storedDeliveryLimit(broadcast);
  if (!limit) return null;
  const {query,candidateCount} = await countLimitedAudience(db,broadcast);
  const account = await getLineAccountById(db, broadcast.line_account_id!);
  if (!account) throw new LimitedBroadcastError('LINEアカウントを読み直してください。');
  const quota = options.quota ?? await fetchQuotaDetails(account.channel_access_token);
  if (!quota.unlimited && (quota.limit === null || quota.used === null)) {
    throw new LimitedBroadcastError(quota.reason ?? '送信枠を確認できません。LINEの接続設定を確かめてください。');
  }
  // 予約・承認の後に確認画面を開き直しても、先に了承した上限を広げない。
  // 下書きの内容を変えたときは保存口で確認印を取り除く。
  const confirmation = options.requireConfirmation === false
    ? (() => { try { return storedConfirmation(broadcast); } catch { return null; } })()
    : storedConfirmation(broadcast);
  const remaining = quota.unlimited ? null : Math.max(0, quota.limit! - quota.used!);
  const requested = Math.min(candidateCount, limit.maxRecipients ?? candidateCount, confirmation?.recipientCount ?? candidateCount);
  const recipientCount = limit.upToRemainingQuota && remaining !== null ? Math.min(requested, remaining) : requested;
  if (remaining !== null && recipientCount > remaining) throw new LimitedBroadcastError('送信枠が不足しています。上限人数を減らすか、残りの枠まで送る設定を選んでください。');
  if (recipientCount <= 0) throw new LimitedBroadcastError('送れる人数が0人です。対象と送信枠を確かめてください。');
  return { query, candidateCount, recipientCount, quota, remaining };
}

export async function assertLimitedAudienceNames(db: D1Database, query: Query): Promise<void> {
  const missing = await db.prepare(`SELECT COUNT(*) n FROM (${query.sql}) q WHERE q.display_name IS NULL OR trim(q.display_name)=''`).bind(...query.bindings).first<{n:number}>();
  if (!missing || Number(missing.n) > 0) throw new LimitedBroadcastError('名前が登録されていない相手がいるため差し込めません。名前と対象を確かめてください。');
}

/** 了承した数と版を、確定させる同じCAS更新へ渡す。 */
export function optionsWithDeliveryConfirmation(broadcast: Broadcast, recipientCount: number, version: number): string {
  const options = JSON.parse(broadcast.message_options_json ?? '{}') as Record<string, unknown>;
  if (!storedDeliveryLimit(broadcast) || !Number.isSafeInteger(recipientCount) || recipientCount <= 0) {
    throw new LimitedBroadcastError('送る人数を確かめ直してください。');
  }
  return JSON.stringify({ ...options, deliveryLimitConfirmation: { broadcastId: broadcast.id, recipientCount, version } });
}

/** 抽選は最初の1回だけ。再開・失敗再送で宛先の追加や補充をしない。 */
export async function freezeLimitedAudience(db: D1Database, broadcast: Broadcast, guardCount: number): Promise<void> {
  storedConfirmation(broadcast);
  const existing = await db.prepare('SELECT COUNT(*) AS n FROM broadcast_send_claims WHERE broadcast_id=?')
    .bind(broadcast.id).first<{ n: number }>();
  if (Number(existing?.n ?? 0) > 0) return;
  if (broadcast.success_count > 0 || Number((broadcast as Broadcast & { batch_offset?: number }).batch_offset ?? 0) > 0 || Number(broadcast.send_attempt_no ?? 1) > 1) {
    throw new LimitedBroadcastError('開始時の宛先を確認できません。現在の条件で選び直さず送信を止めました。');
  }
  if (!Number.isSafeInteger(guardCount) || guardCount <= 0) throw new LimitedBroadcastError('送る人数を確かめ直してください。');
  const query = await eligibleLimitedAudience(db, broadcast);
  const cap = Math.min(guardCount, storedConfirmation(broadcast).recipientCount, storedDeliveryLimit(broadcast)!.maxRecipients ?? guardCount);
  const marker = broadcast.segment_conditions ?? JSON.stringify({ operator: 'AND', rules: broadcast.target_tag_id
    ? [{ type: 'tag_exists', value: broadcast.target_tag_id }] : [{ type: 'is_following', value: true }] });
  await db.batch([
    db.prepare(`INSERT INTO broadcast_send_claims(broadcast_id,friend_id,line_account_id,attempt_no,state)
      SELECT ?, q.id, ?, ?, 'claimed' FROM (${query.sql}) q
      WHERE NOT EXISTS(SELECT 1 FROM broadcast_send_claims WHERE broadcast_id=?)
        AND EXISTS(SELECT 1 FROM broadcasts WHERE id=? AND status='sending' AND lock_version=? AND stopped_at IS NULL)
        ORDER BY random() LIMIT ?`)
      .bind(broadcast.id, broadcast.line_account_id, broadcast.send_attempt_no ?? 1, ...query.bindings, broadcast.id, broadcast.id, broadcast.lock_version ?? 1, cap),
    db.prepare(`UPDATE broadcasts SET total_count=(SELECT COUNT(*) FROM broadcast_send_claims WHERE broadcast_id=?),
      segment_conditions=?, batch_offset=0 WHERE id=? AND status='sending' AND lock_version=?`)
      .bind(broadcast.id, marker, broadcast.id, broadcast.lock_version ?? 1),
  ]);
  const fixed = await db.prepare('SELECT COUNT(*) AS n FROM broadcast_send_claims WHERE broadcast_id=?').bind(broadcast.id).first<{ n: number }>();
  if (!fixed?.n) throw new LimitedBroadcastError('送る相手を固定できませんでした。人数を確かめ直してください。');
}

/** 予約で直せない状態を毎回再試行せず、内容を保って知らせる。 */
export async function holdLimitedBroadcast(db: D1Database, broadcast: Broadcast, reason: string): Promise<void> {
  const { createNotification } = await import('@line-crm/db');
  const dispatched = await db.prepare('SELECT 1 FROM broadcast_send_claims WHERE broadcast_id=? AND dispatched_at IS NOT NULL LIMIT 1').bind(broadcast.id).first();
  const result = dispatched
    ? await db.prepare(`UPDATE broadcasts SET stopped_at=?,batch_lock_at=NULL,batch_offset=0 WHERE id=? AND status='sending' AND stopped_at IS NULL AND lock_version=?`).bind(jstNow(),broadcast.id,broadcast.lock_version ?? 1).run()
    : await db.prepare(`UPDATE broadcasts SET status='draft',scheduled_at=NULL,batch_lock_at=NULL WHERE id=? AND status IN ('scheduled','sending') AND lock_version=?`).bind(broadcast.id,broadcast.lock_version ?? 1).run();
  if (!result.meta.changes) return;
  if (broadcast.line_account_id) await releaseQuotaSlot(db,broadcast.line_account_id,broadcast.id,{ expectedLockVersion: broadcast.lock_version ?? 1 });
  await createNotification(db, { eventType: 'broadcast.quota_short', title: `「${broadcast.title}」を送れませんでした`,
    body: reason, channel: 'dashboard', category: 'error', lineAccountId: broadcast.line_account_id,
    metadata: JSON.stringify({ broadcastId: broadcast.id, reason: 'limited_delivery_unavailable', at: jstNow() }) });
}

/** 期限切れの予約でも、次の束を送る前に残りを取り直す。 */
export async function renewLimitedReservation(db: D1Database, broadcast: Broadcast, pending: number): Promise<void> {
  if (!storedDeliveryLimit(broadcast)) return;
  const confirmation = storedConfirmation(broadcast);
  if (!broadcast.line_account_id || pending > confirmation.recipientCount) throw new LimitedBroadcastError('固定した送信先と確認した人数が合いません。');
  const account = await getLineAccountById(db, broadcast.line_account_id);
  if (!account) throw new LimitedBroadcastError('LINEアカウントを読み直してください。');
  const quota = await fetchQuotaDetails(account.channel_access_token);
  if (quota.unlimited) return;
  if (quota.limit === null || quota.used === null) throw new LimitedBroadcastError(quota.reason ?? '送信枠を確認できません。');
  if (!await tryReserveQuotaSlot(db, broadcast.line_account_id, broadcast.id, pending, quota.used, quota.limit, {replaceOwn:true,expectedLockVersion:broadcast.lock_version ?? 1})) {
    throw new LimitedBroadcastError('残りの送信枠を確保できないため、未送信の分を止めました。送信枠を確かめてから再開してください。');
  }
}
