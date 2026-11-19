import { logger } from '@line-crm/shared/server';
import { recordConversionSourceEvent, accountFeatureOffExclusionSql } from '@line-crm/db';
import { featureJobCanRun } from '../../services/feature-enforcement.js';
import { dispatchAutomationEventWithLogging } from '../automations/automation-triggers/index.js';
import { syncConfirmedBookingToGoogle } from './booking-calendar-sync.js';
import { getReminderTiming, insertConfirmationReminders } from './booking-confirm.js';
import { notifyForBooking } from './booking-notification.js';
import { finishBookingOperation, queueBookingOperation, type BookingOperationKind } from './booking-operation-runs.js';
import { createConfirmedBookingMeeting, type MeetingCreator } from './booking-meeting-create.js';
import { notifyMeetingIssue, notifyMeetingUnavailable } from './booking-meeting-notice.js';
import type { GoogleServiceAccountCredentials } from '../../services/google-service-account.js';

const workflowKey = (id: string) => `${id}:confirmation-effects`;

/** 確定の保存と同じbatchに入れる。途中で止まってもcronが未完了を見つけられる。 */
export function confirmationWorkflowStatement(db: D1Database, bookingId: string, transitionOnly = false): D1PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO booking_operation_runs
    (id, booking_id, line_account_id, kind, status, idempotency_key, result_json)
    SELECT ?, id, line_account_id, 'automation', 'queued', ?, '{"workflow":"confirmation"}'
    FROM bookings WHERE id = ? AND status = 'confirmed' ${transitionOnly ? 'AND changes() = 1' : ''}`)
    .bind(crypto.randomUUID(), workflowKey(bookingId), bookingId);
}

interface Options { now?: Date; credentials?: GoogleServiceAccountCredentials; meetingCreator?: MeetingCreator; meetingDeferredOnly?: boolean; meetingCreatorForBooking?: (bookingId:string)=>Promise<MeetingCreator|null|'deferred'|'unavailable'> }

/** 3入口共通。成功した工程は飛ばす。LINEの到達不明は人の確認に残す。 */
export async function runConfirmedBookingSideEffects(db: D1Database, bookingId: string, options: Options = {}): Promise<void> {
  const row = await db.prepare(`SELECT line_account_id, friend_id, staff_id, menu_id, starts_at,
    notification_policy_snapshot FROM bookings WHERE id = ? AND status = 'confirmed'`)
    .bind(bookingId).first<{
      line_account_id: string; friend_id: string | null; staff_id: string; menu_id: string;
      starts_at: string; notification_policy_snapshot: string;
    }>();
  if (!row) return;
  await confirmationWorkflowStatement(db, bookingId).run();
  const now = options.now ?? new Date();
  let policy: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.notification_policy_snapshot);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) policy = parsed as Record<string, unknown>;
  } catch { /* 旧行は既定 */ }
  let pending = false;
  // ローカルの書込みと冪等な入口だけ再試行する。送信はnotifyForBookingが別途保護する。
  async function step(kind: BookingOperationKind, suffix: string, work: (operationId: string) => Promise<Record<string, unknown>>) {
    const id = await queueBookingOperation(db, {
      bookingId, lineAccountId: row!.line_account_id, kind, idempotencyKey: `${bookingId}:${suffix}`,
    });
    const claimed = await db.prepare(`UPDATE booking_operation_runs SET opened_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued','retry_wait')
        AND (opened_at IS NULL OR opened_at < ?)`)
      .bind(now.toISOString(), now.toISOString(), id, new Date(now.getTime() - 600_000).toISOString()).run();
    if ((claimed.meta?.changes ?? 0) !== 1) {
      const op = await db.prepare('SELECT status FROM booking_operation_runs WHERE id = ?').bind(id).first<{ status: string }>();
      if (!op || ['queued', 'retry_wait'].includes(op.status)) pending = true;
      return;
    }
    try {
      const result = await work(id);
      await finishBookingOperation(db, { id, status: result.skipped ? 'skipped' : 'succeeded', completedAt: now.toISOString(), result });
    } catch {
      pending = true;
      await finishBookingOperation(db, { id, status: 'retry_wait', completedAt: now.toISOString(), errorCode: 'confirmation_step_failed' });
      await db.prepare('UPDATE booking_operation_runs SET opened_at = NULL WHERE id = ?').bind(id).run();
    }
  }
  await step('conversion', 'confirmation-reminders', async () => {
    if (!row.friend_id) return { skipped: true };
    const timing = await getReminderTiming(db, row.line_account_id);
    await insertConfirmationReminders(db, {
      bookingId, startsAt: new Date(row.starts_at), now, ...timing,
      kinds: { dayBefore: policy.day_before !== false, hoursBefore: policy.hours_before !== false },
    });
    return { reminders: 'registered' };
  });
  await step('conversion', 'conversion:confirmed', async () => {
    if (!row.friend_id) return { skipped: true };
    const result = await recordConversionSourceEvent(db, {
      sourceType: 'reservation_confirmed', lineAccountId: row.line_account_id, friendId: row.friend_id,
      sourceEventId: bookingId, metadata: { bookingId, bookingType: 'salon' },
    });
    if (result.failed > 0) throw new Error('conversion_incomplete');
    return { conversion: 'recorded' };
  });
  let meetingDeferred=false;
  try {
    const creator=options.meetingCreator ?? await options.meetingCreatorForBooking?.(bookingId);
    if(creator==='deferred'){
      const workflow=await db.prepare('SELECT created_at FROM booking_operation_runs WHERE idempotency_key=? AND line_account_id=?').bind(workflowKey(bookingId),row.line_account_id).first<{created_at:string}>();
      const created=workflow?.created_at??'';
      const createdAt=Date.parse(created && !/[zZ]|[+-]\d\d:\d\d$/.test(created)?`${created}Z`:created);
      if(Number.isFinite(createdAt) && now.getTime()-createdAt<300000){meetingDeferred=true;pending=true;}
      else await notifyMeetingUnavailable(db,{accountId:row.line_account_id,bookingId});
    } else if(creator==='unavailable')await notifyMeetingUnavailable(db,{accountId:row.line_account_id,bookingId});
    else if(creator){
      const result=await createConfirmedBookingMeeting(db, bookingId, creator);
      if(result==='failed'){
        const link=await db.prepare("SELECT id FROM booking_meeting_links WHERE booking_id=? AND status='failed' ORDER BY created_at DESC,id DESC LIMIT 1").bind(bookingId).first<{id:string}>();
        if(link)await notifyMeetingIssue(db,{accountId:row.line_account_id,bookingId,linkId:link.id,reason:'failed'});
      }
    }
  } catch { logger.warn('booking_meeting_create_failed'); }
  await db.prepare(`UPDATE booking_operation_runs SET result_json=${meetingDeferred ? "json_set(result_json,'$.meetingDeferred',1)" : "json_remove(result_json,'$.meetingDeferred')"},updated_at=?
    WHERE line_account_id=? AND idempotency_key=? AND status IN ('queued','retry_wait')`)
    .bind(now.toISOString(),row.line_account_id,workflowKey(bookingId)).run();
  await step('google_calendar', 'google-calendar:create', async (operationId) => {
    const result = await syncConfirmedBookingToGoogle(db, options.credentials ?? {}, bookingId, `lh${operationId.replaceAll('-', '')}`);
    return { calendarSync: result.synced ? 'synced' : 'not_configured', skipped: !result.synced };
  });
  if (row.friend_id && policy.send_line_confirmation !== false && !meetingDeferred) {
    try { await notifyForBooking(db, bookingId, 'approved'); }
    catch { /* 台帳に到達不明を残す。自動で二度送らない。残りの工程は続ける。 */ }
    const op = await db.prepare(`SELECT status FROM booking_operation_runs WHERE line_account_id = ? AND idempotency_key = ?`)
      .bind(row.line_account_id, `${bookingId}:confirmation-line:approved`).first<{ status: string }>();
    if (!op || ['queued', 'retry_wait'].includes(op.status)) pending = true;
  }
  await step('automation', 'automation:calendar-booked', async () => {
    if (!row.friend_id) return { skipped: true };
    const results = await dispatchAutomationEventWithLogging(db, {
      lineAccountId: row.line_account_id, eventType: 'calendar_booked', sourceEventId: bookingId,
      friendId: row.friend_id, eventData: { bookingType: 'salon', bookingId, menuId: row.menu_id, staffId: row.staff_id },
    });
    // 設定/DB失敗が戻り値になっても成功として閉じない。自動化自身の安定キーを再利用する。
    if (results.some(result => result.kind === 'configuration_error')) throw new Error('automation_incomplete');
    return { eventType: 'calendar_booked' };
  });
  if (!pending) {
    const op = await db.prepare('SELECT id FROM booking_operation_runs WHERE line_account_id = ? AND idempotency_key = ?')
      .bind(row.line_account_id, workflowKey(bookingId)).first<{ id: string }>();
    if (op) await finishBookingOperation(db, { id: op.id, status: 'succeeded', completedAt: now.toISOString(), result: { workflow: 'confirmation' } });
  }
}

export async function recoverConfirmedBookingSideEffects(db: D1Database, options: Options = {}): Promise<void> {
  const rows = await db.prepare(`SELECT b.id,b.line_account_id FROM bookings b JOIN booking_operation_runs op
    ON op.booking_id = b.id AND op.line_account_id = b.line_account_id
    WHERE b.status = 'confirmed' AND NOT ${accountFeatureOffExclusionSql('b.line_account_id','booking')} AND op.idempotency_key = b.id || ':confirmation-effects'
      AND op.status IN ('queued','retry_wait')
      ${options.meetingDeferredOnly ? "AND json_extract(op.result_json,'$.meetingDeferred')=1 AND julianday(op.updated_at)<=julianday(?,'-1 minute')" : ''}
      ORDER BY op.created_at, op.id LIMIT 200`)
    .bind(...(options.meetingDeferredOnly ? [(options.now??new Date()).toISOString()] : [])).all<{ id: string; line_account_id:string }>();
  for (const row of rows.results ?? []) {
    if(!await featureJobCanRun(db,{accountId:row.line_account_id,featureId:'booking',job:'booking meeting recovery'}))continue;
    try { await runConfirmedBookingSideEffects(db, row.id, options); }
    catch { logger.error("booking_confirmation_recovery_failed"); }
  }
}
