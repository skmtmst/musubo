import { readFollowupEngineGate } from './restaurant-followup-engine-approval.js';
import { cancelV6RemindersForSource, enrollFriendInReminder, rescheduleV6RemindersForSource, type V6WriteGuard } from '@line-crm/db';
import { reservationInstant } from '@line-crm/shared';
import type { RestaurantEvent } from './restaurant-event-types.js';

interface ReminderTarget {
  trigger: string;
  reminder_id: string;
  version: number;
  approved_version_id: string;
  approved_content_hash: string;
  timezone: string;
}

/** 管理対象だけに追加する柵。通常のリマインダの登録条件には混ぜない。 */
export const restaurantReminderTargetGate = `EXISTS (
 SELECT 1 FROM rt_store_followup_targets ft JOIN rt_stores fs ON fs.id=ft.store_id
 JOIN reminders frule ON frule.id=ft.reminder_id AND frule.line_account_id=fs.line_account_id
 JOIN rt_approval_requests fa ON fa.id=ft.approval_id AND fa.store_id=fs.id AND fa.organization_id=fs.organization_id
 WHERE ft.store_id=? AND ft.trigger=? AND ft.version=? AND ft.engine='reminder'
 AND ft.enabled=1 AND ft.sending_status='active' AND fs.status='active' AND fs.line_account_id=?
 AND frule.deleted_at IS NULL AND frule.lifecycle_status='published' AND frule.is_active=1
 AND frule.current_published_version_id=ft.approved_version_id AND ft.approved_version_id=?
 AND fa.status='approved' AND json_valid(fa.payload_json)
 AND json_extract(CASE WHEN json_valid(fa.payload_json) THEN fa.payload_json ELSE '{}' END,'$.operation')='start_restaurant_followup_engines'
 AND json_extract(CASE WHEN json_valid(fa.payload_json) THEN fa.payload_json ELSE '{}' END,'$.lineAccountId')=fs.line_account_id
 AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(fa.payload_json) THEN fa.payload_json ELSE '{}' END,'$.targets') approved
  WHERE json_extract(CASE WHEN json_valid(approved.value) THEN approved.value ELSE '{}' END,'$.trigger')=ft.trigger
  AND json_extract(CASE WHEN json_valid(approved.value) THEN approved.value ELSE '{}' END,'$.engine')=ft.engine
  AND json_extract(CASE WHEN json_valid(approved.value) THEN approved.value ELSE '{}' END,'$.targetId')=ft.reminder_id
  AND json_extract(CASE WHEN json_valid(approved.value) THEN approved.value ELSE '{}' END,'$.versionId')=ft.approved_version_id
  AND json_extract(CASE WHEN json_valid(approved.value) THEN approved.value ELSE '{}' END,'$.contentHash')=ft.approved_content_hash)
)`;

/** 予約IDを保った登録・変更・取消。日数と時刻の解釈は既存リマインダに任せる。 */
export async function syncRestaurantReminderTargets(db: D1Database, event: RestaurantEvent): Promise<void> {
  if (!event.reservation_id || !event.event_type.startsWith('restaurant.reservation.')) return;
  const reservation = await db.prepare(`SELECT r.starts_at,r.status,r.customer_version,r.line_uid,s.line_account_id,s.timezone
    FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id WHERE r.id=? AND r.store_id=?`)
    .bind(event.reservation_id,event.store_id).first<{starts_at:string;status:string;customer_version:number;line_uid:string;line_account_id:string|null;timezone:string}>();
  // 遅れて届いた旧版で新しい予約の登録を止めたり、基準日を戻したりしない。
  if (!reservation || event.reservation_version !== reservation.customer_version) return;
  const reservationGuard = {sql:'EXISTS(SELECT 1 FROM rt_reservations WHERE id=? AND store_id=? AND customer_version=?)',binds:[event.reservation_id,event.store_id,event.reservation_version]};
  const source = {sourceKind:'restaurant_reservation',sourceId:event.reservation_id,allowLegacyFallback:false};
  if (reservation.status !== 'confirmed') {
    await cancelV6RemindersForSource(db,{...source,cancelReason:'restaurant_reservation_cancelled',writeGuard:reservationGuard});
    return;
  }
  if (!event.line_account_id || !event.friend_id || event.line_account_id !== reservation.line_account_id) return;
  const friend = await db.prepare('SELECT id FROM friends WHERE id=? AND line_account_id=? AND line_platform_user_id=? AND is_following=1 AND is_hidden=0')
    .bind(event.friend_id,event.line_account_id,reservation.line_uid).first();
  if (!friend) return;
  const targets = await db.prepare(`SELECT ft.trigger,ft.reminder_id,ft.version,ft.approved_version_id,ft.approved_content_hash,s.timezone
    FROM rt_store_followup_targets ft JOIN rt_stores s ON s.id=ft.store_id
    WHERE ft.store_id=? AND ft.engine='reminder' AND ft.trigger IN ('reservation_24h','reservation_2h')`)
    .bind(event.store_id).all<ReminderTarget>();
  const targetDate = new Date(reservationInstant(reservation.starts_at)).toISOString();
  for (const target of targets.results) {
    const binds = [event.store_id,target.trigger,target.version,event.line_account_id,target.approved_version_id];
    let writeGuard:V6WriteGuard = {sql:`${restaurantReminderTargetGate} AND ${reservationGuard.sql}`,binds:[...binds,...reservationGuard.binds]};
    // 同じ人の同時刻の別予約と、同じ予約の別の送り方を別々に保つ。
    const sourceEventId = `restaurant:${event.store_id}:${target.trigger}:${event.reservation_id}`;
    const existing = await db.prepare(`SELECT id,target_date,status FROM friend_reminders
      WHERE reminder_id=? AND source_kind='restaurant_reservation' AND source_id=? AND source_event_id=? AND friend_id=?`)
      .bind(target.reminder_id,event.reservation_id,sourceEventId,event.friend_id).first<{id:string;target_date:string;status:string}>();
    if (existing) {
      // 取消済み・送信済みの登録を勝手に起こして再送しない。
      if (existing.status === 'active' && existing.target_date !== targetDate) {
        await rescheduleV6RemindersForSource(db,{...source,sourceEventId,moves:[{reminderId:target.reminder_id,fromTargetDate:existing.target_date,toTargetDate:targetDate}],writeGuard:reservationGuard});
      }
      continue;
    }
    if (!await db.prepare(`SELECT 1 WHERE ${restaurantReminderTargetGate}`).bind(...binds).first()) continue;
    const approval=await readFollowupEngineGate(db,{engine:'reminder',targetId:target.reminder_id,lineAccountId:event.line_account_id,versionId:target.approved_version_id});
    if(!approval.managed||!approval.allowed)continue;
    writeGuard={sql:`(${writeGuard.sql}) AND (${approval.guard.sql})`,binds:[...writeGuard.binds,...approval.guard.binds]};
    try {
      await enrollFriendInReminder(db,{
        friendId:event.friend_id,reminderId:target.reminder_id,targetDate,
        sourceKind:source.sourceKind,sourceId:event.reservation_id,sourceEventId,timezone:target.timezone,
        sourceFingerprint:target.approved_content_hash,
        writeGuard,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'V6_WRITE_GUARDED') continue;
      // 同じイベントの並行処理は、同じ登録が存在するときだけ成功とみなす。
      if (!String(error).includes('UNIQUE constraint failed') || !await db.prepare('SELECT 1 FROM friend_reminders WHERE reminder_id=? AND friend_id=? AND source_event_id=?')
        .bind(target.reminder_id,event.friend_id,sourceEventId).first()) throw error;
    }
  }
}
