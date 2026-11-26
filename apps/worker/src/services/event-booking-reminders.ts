import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { recoverEventTransitions } from './event-transition-recovery.js';
import type { AccountStyle } from '@line-crm/shared';
import { recoverEventBookingNotifications } from './event-notification-recovery.js';
import { deliverBookingLine, BookingLineDeliveryIncomplete } from '../features/booking/booking-line-delivery/index.js';


import {
  REMINDER_MAX_RETRY,
  type EventReminderKind,
} from './event-booking-types.js';
import type {
  EventBookingNotificationSender,
  EventNotificationKind,
} from './event-booking-notifier.js';
import {
  ensureWorkflowStep, claimWorkflowStep, finishWorkflowStep, failWorkflowStep, releaseWorkflowStep,
  activeTenantLineAccountSql,
  isOperationCapabilityStopped,
  resolveLineCredential,
} from '@line-crm/db';
import { stoppedTenantLineAccountSql } from './tenant-runtime-status.js';
import { featureJobCanRun } from './feature-enforcement.js';

export {computeRemindersForBooking,insertRemindersForBooking,type ComputedReminder,type ComputeRemindersInput} from './event-reminder-schedule.js';
export {cancelPendingRemindersFor} from './event-reminder-cleanup.js';
const JST_OFFSET_MS=9*3600_000;

interface DueEventReminderRow {
  id: string;
  booking_id: string;
  booking_version:number;
  line_account_id: string;
  kind: EventReminderKind;
  retry_count: number;
  event_name: string;
  venue_name: string | null;
  venue_url: string | null;
  reminder_message_extra: string | null;
  starts_at: string;
  channel_access_token: string;
  channel_access_token_encrypted: string | null;
  line_user_id: string;
  reminder_hours_before: number | null;
  notification_style: AccountStyle | null;
}

function startsAtJstFmt(utcIso: string): string {
  const jst = japanCalendar(new Date(utcIso)).toISOString();
  return `${jst.slice(0, 10)} ${jst.slice(11, 16)}`;
}

function notificationKindFor(reminderKind: EventReminderKind): EventNotificationKind {
  return reminderKind === 'day_before' ? 'reminder_day_before' : 'reminder_hours_before';
}

export interface ProcessDueEventRemindersParams {
  now: Date;
  sender: EventBookingNotificationSender;
}

export async function processDueEventReminders(
  db: D1Database,
  params: ProcessDueEventRemindersParams,
): Promise<{ sent: number; failed: number }> {
  await db.prepare(
    `UPDATE event_booking_reminders
        SET status = 'cancelled', last_error = 'tenant_suspended'
      WHERE status IN ('pending','failed')
        AND scheduled_at <= ?
        AND EXISTS (
          SELECT 1 FROM event_bookings stopped_booking
           WHERE stopped_booking.id = event_booking_reminders.booking_id
             AND ${stoppedTenantLineAccountSql('stopped_booking.line_account_id')}
        )`,
  ).bind(params.now.toISOString()).run();
  // pending と再試行可能な failed だけを拾い、成功・恒久失敗・取消を除く。処理時点でも予約が確定済みで開始前であることを求める。
  const due = await db
    .prepare(
      `SELECT r.id, r.booking_id, r.kind, r.retry_count,r.booking_version,
              b.line_account_id,
              e.name AS event_name, e.venue_name, e.venue_url,
              e.reminder_message_extra, e.reminder_hours_before,
              s.starts_at,
              la.channel_access_token,
              la.channel_access_token_encrypted,
              f.line_platform_user_id AS line_user_id, ast.style AS notification_style
         FROM event_booking_reminders r
         INNER JOIN event_bookings b ON b.id = r.booking_id
         INNER JOIN events e ON e.id = b.event_id
         INNER JOIN event_slots s ON s.id = b.slot_id
         INNER JOIN line_accounts la ON la.id = b.line_account_id
         INNER JOIN friends f ON f.id = b.friend_id AND f.line_account_id=b.line_account_id
         LEFT JOIN account_styles ast ON ast.line_account_id=b.line_account_id AND ast.selection_mode='configured'
        WHERE r.status IN ('pending','failed')
          AND r.scheduled_at <= ?
          AND f.is_following=1
          AND b.status = 'confirmed' AND b.lock_version=r.booking_version
          AND s.starts_at > ?
          AND ${activeTenantLineAccountSql('b.line_account_id')}
          AND NOT EXISTS(SELECT 1 FROM workflow_steps ws WHERE ws.scope_id='line:' || b.line_account_id
            AND ws.process_kind='event_reminder' AND ws.subject_id=r.id AND ws.step_key='send'
            AND (ws.status IN ('exhausted','unknown','canceled') OR ws.next_attempt_at>?
              OR (ws.status='running' AND ws.lease_expires_at>?)))
        LIMIT 100`,
    )
    .bind(params.now.toISOString(), params.now.toISOString(),params.now.getTime(),params.now.getTime())
    .all<DueEventReminderRow>();

  let sent = 0;
  let failed = 0;
  for (const row of due.results ?? []) {
    // 機能オフ中はclaimせずpendingのまま残す。再オンで再開する。
    if (row.line_account_id && !await featureJobCanRun(db, { accountId: row.line_account_id, featureId: 'events', job: 'event reminders' })) {
      continue;
    }
    // 緊急停止 : reminder_dispatch が止まっている統括は claim せず
    // pending のまま残す。復旧すれば次の cron が拾う。
    if (await isOperationCapabilityStopped(db, row.line_account_id, 'reminder_dispatch')) {
      continue;
    }
    const ref = { scopeId: `line:${row.line_account_id}`, processKind: 'event_reminder', subjectId: row.id, stepKey: 'send' };
    const now = params.now.getTime();
    const snapshot = await ensureWorkflowStep(db, ref, {
      now, maxAttempts: REMINDER_MAX_RETRY, initialAttempts:row.retry_count,
      input: {
        toLineUserId: row.line_user_id,
        kind: notificationKindFor(row.kind),
        ctx: { style:row.notification_style??'standard',eventName: row.event_name, startsAtJst: startsAtJstFmt(row.starts_at),
          venueName: row.venue_name, venueUrl: row.venue_url,
          hoursBefore: row.reminder_hours_before ?? 0, reminderExtra: row.reminder_message_extra },
      },
    });
    // 外部の受理後に業務保存だけが失敗した場合は、再送せず照合する。
    if (snapshot.status === 'succeeded') {
      await db.prepare(`UPDATE event_booking_reminders SET status='sent', sent_at=?
        WHERE id=? AND status IN ('pending','failed')`).bind(params.now.toISOString(),row.id).run();
      continue;
    }
    const lease = await claimWorkflowStep(db,ref,{now});
    if (!lease) continue;
    const owner = lease.lease_owner!;
    try {
      const accessToken = await resolveLineCredential(row.channel_access_token_encrypted,row.channel_access_token,
        { lineAccountId: row.line_account_id, field: 'channel_access_token' });
      const eligible = await db.prepare(`SELECT 1 ok FROM event_booking_reminders r
        JOIN event_bookings b ON b.id=r.booking_id WHERE r.id=? AND r.status IN ('pending','failed')
        AND b.status='confirmed' AND b.lock_version=r.booking_version AND ${activeTenantLineAccountSql('b.line_account_id')}`).bind(row.id).first();
      if (!eligible || await isOperationCapabilityStopped(db,row.line_account_id,'reminder_dispatch')) {
        await releaseWorkflowStep(db,ref,owner,now);
        continue;
      }
      // LINE の再試行 UUID の保持は24時間なので、古い送達不明は人へ照合を求める。
      if (lease.attempt_count > 1 && now - lease.first_attempt_at! >= 23 * 3600_000) {
        await failWorkflowStep(db,ref,owner,{now,unknown:true,code:'delivery_unknown'});
        continue;
      }
      const input = JSON.parse(lease.input_json!) as Omit<Parameters<EventBookingNotificationSender>[0], 'channelAccessToken' | 'retryKey'>;
      await deliverBookingLine(db, {
        accountId: row.line_account_id, operationId: `event-reminder:${row.id}`, retryKey: lease.retry_key,
        snapshot: input, deadlineAt: Date.parse(row.starts_at), maxAttempts: REMINDER_MAX_RETRY,
        initialAttempts: lease.attempt_count - 1,
        // 旧送信の再取得は「未実行」と証明できない。新しいcheckpointでも送らない。
        legacyUnknown: snapshot.attempt_count > 0 && snapshot.error_code !== 'notification_preflight_failed',
        now: () => params.now.getTime(),
        authorize: async saved => !await isOperationCapabilityStopped(db,row.line_account_id,'reminder_dispatch')
          && !!await db.prepare(`SELECT 1 ok FROM event_booking_reminders r JOIN event_bookings b ON b.id=r.booking_id
            JOIN friends f ON f.id=b.friend_id AND f.line_account_id=b.line_account_id
            WHERE r.id=? AND r.status IN ('pending','failed') AND b.status='confirmed' AND b.lock_version=r.booking_version
              AND f.is_following=1 AND f.line_platform_user_id=? AND b.line_account_id=?
              AND ${activeTenantLineAccountSql('b.line_account_id')}`).bind(row.id,saved.toLineUserId,row.line_account_id).first(),
        statements: next => next.phase==='started'?[db.prepare(`SELECT json(CASE WHEN EXISTS(
          SELECT 1 FROM event_booking_reminders r JOIN event_bookings b ON b.id=r.booking_id
          JOIN friends f ON f.id=b.friend_id AND f.line_account_id=b.line_account_id
          WHERE r.id=? AND r.status IN ('pending','failed') AND b.status='confirmed' AND b.lock_version=r.booking_version AND b.line_account_id=?
            AND f.is_following=1 AND f.line_platform_user_id=? AND ${activeTenantLineAccountSql('b.line_account_id')})
          THEN 'true' ELSE 'event_reminder_obsolete' END)`).bind(row.id,row.line_account_id,input.toLineUserId)]
          : next.phase==='succeeded' ? [db.prepare(`UPDATE event_booking_reminders
              SET status='sent',sent_at=?,retry_count=?,last_error=NULL
              WHERE id=? AND status IN ('pending','failed')`)
            .bind(params.now.toISOString(),next.attempts,row.id)] : [],
        send: (signal, saved, key) => params.sender({ ...saved, channelAccessToken: accessToken, retryKey: key, signal }),
      });
      await finishWorkflowStep(db,ref,owner,{now,result:{accepted:true},statements:[
        db.prepare(`UPDATE event_booking_reminders SET status='sent',sent_at=?,retry_count=?,last_error=NULL
          WHERE id=? AND status IN ('pending','failed')`).bind(params.now.toISOString(),lease.attempt_count,row.id),
      ]});
      sent++;
    } catch (error) {
      if (error instanceof BookingLineDeliveryIncomplete && error.beforeSend) {
        // 遮断・送信前の保存失敗では外部要求0。外側の準備用leaseは予算に数えない。
        await releaseWorkflowStep(db, ref, owner, now);
        continue;
      }
      await failWorkflowStep(db,ref,owner,{now,unknown: error instanceof BookingLineDeliveryIncomplete && error.kind === 'unknown',delayMs:60_000,code:error instanceof BookingLineDeliveryIncomplete ? 'delivery_unknown' : 'notification_preflight_failed'});
      // 自分の実行権の失敗だけを反映し、取消や受理済みの通知を上書きしない。
      await db.prepare(`UPDATE event_booking_reminders SET status=?,retry_count=?,last_error='delivery_unknown'
        WHERE id=? AND status IN ('pending','failed') AND EXISTS (SELECT 1 FROM workflow_steps
          WHERE scope_id=? AND process_kind='event_reminder' AND subject_id=? AND step_key='send'
            AND attempt_count=? AND status IN ('failed','exhausted','unknown'))`)
        .bind(error instanceof BookingLineDeliveryIncomplete && error.kind === 'unknown' || lease.attempt_count>=REMINDER_MAX_RETRY?'failed_permanent':'failed',lease.attempt_count,row.id,
          ref.scopeId,row.id,lease.attempt_count).run();
      failed++;
    }
  }
  const remaining=Math.max(0,100-(due.results??[]).length);
  const transitions=await recoverEventTransitions(db,params.now,remaining);
  const recovered=await recoverEventBookingNotifications(db,params.now,Math.max(0,remaining-transitions));
  return { sent:sent+recovered.sent, failed:failed+recovered.failed };
}

export const _internals = { REMINDER_MAX_RETRY };
