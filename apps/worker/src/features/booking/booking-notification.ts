import { logger } from '@line-crm/shared/server';
import { liffActionUrl, type AccountStyle } from '@line-crm/shared';

import { activeTenantLineAccountSql, isOperationCapabilityStopped, resolveLineCredential } from '@line-crm/db';
import { bookingCancellationQuote } from './booking-cancellation.js';
import { queueBookingOperation, finishBookingOperation } from './booking-operation-runs.js';
import { formatStartsAtForStore, notificationTiming, renderNotificationText, sendBookingNotification, type NotificationKind, type NotificationContext } from './booking-notifier.js';
import { runBookingExternalStep } from './booking-external-step.js';
import { API_RETRY_WAIT, lineFailure } from '../../lib/external-call/index.js';
import { type CallState } from '../../lib/external-call/types.js';
import { featureJobCanRun } from '../../services/feature-enforcement.js';

interface NotificationSnapshot {
  kind: NotificationKind;
  ctx: NotificationContext;
  to: string;
  friendId: string;
  version: number;
}

interface BookingNotificationRow {
      liff_id:string|null;notification_style:AccountStyle|null;cancel_deadline_minutes_before:number;
      starts_at: string; line_account_id: string; status: string; lock_version: number; friend_id: string;
      meeting_mode: string | null; meeting_url: string | null; policy_snapshot_json: string | null;
      menu_name: string; staff_name: string; channel_access_token: string;
      channel_access_token_encrypted: string | null; line_user_id: string; timezone: string | null;
    }

async function loadNotificationRow(db:D1Database,bookingId:string,accountId?:string) {
  return await db.prepare(`SELECT b.starts_at,b.line_account_id,b.status,b.lock_version,b.friend_id,
    b.meeting_mode,b.meeting_url,b.policy_snapshot_json,m.name AS menu_name,s.display_name AS staff_name,
    la.channel_access_token,la.channel_access_token_encrypted,la.liff_id,ast.style AS notification_style,f.line_platform_user_id AS line_user_id,bs.timezone,
    COALESCE(m.cancel_deadline_hours_before*60,bs.cancel_deadline_minutes_before,1440) cancel_deadline_minutes_before
    FROM bookings b INNER JOIN menus m ON m.id=b.menu_id INNER JOIN staff s ON s.id=b.staff_id
    INNER JOIN line_accounts la ON la.id=b.line_account_id
    INNER JOIN friends f ON f.id=b.friend_id AND f.line_account_id=b.line_account_id
    LEFT JOIN booking_settings bs ON bs.line_account_id=b.line_account_id
    LEFT JOIN account_styles ast ON ast.line_account_id=b.line_account_id AND ast.selection_mode='configured' WHERE b.id=?${accountId===undefined?'':' AND b.line_account_id=?'}`)
    .bind(bookingId,...(accountId===undefined?[]:[accountId])).first<BookingNotificationRow>();
}

async function notificationContext(db:D1Database,bookingId:string,row:BookingNotificationRow,now:number):Promise<NotificationContext> {
  const timezone=row.timezone??'Asia/Tokyo';
  const quote=row.policy_snapshot_json?await bookingCancellationQuote(db,bookingId,row.line_account_id,new Date(now)):null;
  const deadline=quote?.policyAcceptedRequired?Date.parse(row.starts_at)
    :Date.parse(row.starts_at)-Number(row.cancel_deadline_minutes_before??1440)*60_000;
  let selfManagement:NotificationContext['selfManagement'];
  if(row.liff_id&&Number.isInteger(row.lock_version)&&row.lock_version>=0&&now<Date.parse(row.starts_at)&&now<=deadline) {
    try {selfManagement={historyUrl:liffActionUrl({kind:'booking_history',liffId:row.liff_id}),
      deadlineLabel:formatStartsAtForStore(new Date(deadline).toISOString(),timezone)};}
    catch {/* An invalid LIFF setting retains contact-only guidance. */}
  }
  return {style:row.notification_style??'standard',selfManagement,meetingMode:row.meeting_mode,meetingUrl:row.meeting_url,
    ...(quote?{cancellationText:quote.text}:{}),menuName:row.menu_name,staffName:row.staff_name,
    startsAt:formatStartsAtForStore(row.starts_at,timezone),...notificationTiming(row.starts_at,timezone,new Date(now))};
}

/** 実送信と異なるプレビューを出さないよう、同じ組立とコンテキストを読み取り専用で使う。 */
export async function previewBookingConfirmation(db:D1Database,bookingId:string,accountId:string,now=new Date()):Promise<string|null> {
  try {
    const row=await loadNotificationRow(db,bookingId,accountId);
    if(!row||!row.line_user_id||!['requested','confirmed'].includes(row.status))return null;
    return renderNotificationText('approved',await notificationContext(db,bookingId,row,now.getTime()));
  } catch {
    logger.warn('booking_confirmation_preview_failed');
    return null;
  }
}

/** 自動送信は同じ記録・宛先・本文・キーで行い、結果不明を手動でも再送しない。 */
export async function notifyForBooking(db: D1Database, bookingId: string, kind: NotificationKind,
  existingOperationId?: string, retryKey?: string): Promise<void> {
  const row = await loadNotificationRow(db,bookingId);
  if (!row || kind === 'approved' && row.status !== 'confirmed') return;
  const operationId = existingOperationId ?? await queueBookingOperation(db, {
    bookingId, lineAccountId: row.line_account_id, kind: 'confirmation_line',
    idempotencyKey: `${bookingId}:confirmation-line:${kind}`, result: { notificationKind: kind },
  });
  const prior = await db.prepare(`SELECT status,error_code FROM booking_operation_runs
    WHERE id=? AND booking_id=? AND line_account_id=? AND kind='confirmation_line'`)
    .bind(operationId, bookingId, row.line_account_id).first<{ status: string; error_code: string | null }>();
  if (!prior || ['succeeded', 'skipped', 'cancelled'].includes(prior.status)) return;
  if (prior.error_code === 'delivery_unknown') throw new Error('delivery_unknown');
  const now = Date.now(), nowIso = new Date(now).toISOString();
  if (!existingOperationId) {
    const claimed = await db.prepare(`UPDATE booking_operation_runs SET opened_at=?,updated_at=?
      WHERE id=? AND status IN ('queued','retry_wait') AND error_code IS NOT 'delivery_unknown'
        AND (opened_at IS NULL OR opened_at<?)`)
      .bind(nowIso, nowIso, operationId, new Date(now - 600_000).toISOString()).run();
    if (claimed.meta.changes !== 1) return;
  }
  let prepared = false;
  try {
    const token = await resolveLineCredential(row.channel_access_token_encrypted, row.channel_access_token,
      { lineAccountId: row.line_account_id, field: 'channel_access_token' });
    const snapshot:NotificationSnapshot={kind,to:row.line_user_id,friendId:row.friend_id,version:row.lock_version,
      ctx:await notificationContext(db,bookingId,row,now)};
    const eligibleSql = `SELECT 1 ok FROM bookings b JOIN friends f ON f.id=b.friend_id
      WHERE b.id=? AND b.line_account_id=? AND b.friend_id=? AND b.lock_version=?
        AND f.line_account_id=b.line_account_id AND f.is_following=1 AND f.line_platform_user_id=?
        AND ${activeTenantLineAccountSql('b.line_account_id')}
        AND (? NOT IN ('approved','changed') OR b.status='confirmed')
        AND (? NOT IN ('approved','changed') OR json_extract(b.notification_policy_snapshot,
          CASE WHEN ?='approved' THEN '$.send_line_confirmation' ELSE '$.send_line_change' END) IS NOT 0)`;
    const eligibleArgs = [bookingId, row.line_account_id, snapshot.friendId, snapshot.version, snapshot.to, kind, kind, kind];
    prepared = true;
    const result = await runBookingExternalStep(db, {
      ref: { scopeId: `line:${row.line_account_id}`, processKind: 'booking_notification', subjectId: operationId, stepKey: 'send' },
      identity: { scope: { accountId: row.line_account_id, storeId: row.line_account_id, destination: 'line', connectionId: row.line_account_id },
        operationId, idempotencyKey: retryKey ?? operationId, snapshotId: operationId, effect: 'write' },
      policy: { category: 'api', maxAttempts: 1, timeoutMs: 10_000, deadlineAt: now + 86_400_000, wait: API_RETRY_WAIT },
      snapshot,
      authorize: async saved => saved.version === row.lock_version && !!await db.prepare(eligibleSql).bind(...eligibleArgs).first()
        && !await isOperationCapabilityStopped(db, row.line_account_id, 'broadcast_dispatch')
        && await featureJobCanRun(db, { accountId: row.line_account_id, featureId: 'booking', job: 'booking notification' }),
      execute: async (signal, saved, identity) => {
        try {
          await sendBookingNotification({ channelAccessToken: token, toLineUserId: saved.to, kind: saved.kind,
            ctx: saved.ctx, messages: [{ type: 'text', text: renderNotificationText(saved.kind, saved.ctx) }],
            retryKey: identity.idempotencyKey, signal });
          return { kind: 'success', value: { notificationKind: saved.kind, openTracking: 'inbox' } };
        } catch (error) { return lineFailure(error, identity, Date.now()); }
      },
      statements: (next: Readonly<CallState>, value) => [
        ...(next.phase === 'started' ? [db.prepare(`SELECT json(CASE WHEN EXISTS(${eligibleSql})
          THEN 'true' ELSE 'booking_notification_obsolete' END)`).bind(...eligibleArgs)] : []),
        db.prepare(`UPDATE booking_operation_runs SET status=?,error_code=?,result_json=?,completed_at=?,updated_at=?
          WHERE id=? AND booking_id=? AND line_account_id=? AND status NOT IN ('cancelled','skipped','succeeded')`)
          .bind(next.phase === 'succeeded' ? 'succeeded' : 'permanent_failed',
            next.phase === 'started' || next.phase === 'unknown' ? 'delivery_unknown' : next.phase === 'stopped' ? 'notification_stopped' : null,
            JSON.stringify(value ?? { notificationKind: kind }), next.phase === 'started' ? null : new Date().toISOString(),
            new Date().toISOString(), operationId, bookingId, row.line_account_id),
      ],
    });
    if (!['success', 'succeeded'].includes(result.kind)) throw new Error(result.kind === 'unknown' ? 'delivery_unknown' : 'notification_stopped');
  } catch (error) {
    if (!prepared) {
      await finishBookingOperation(db, { id: operationId, status: 'retry_wait', completedAt: nowIso,
        errorCode: 'notification_preflight_failed', result: { notificationKind: kind } });
      await db.prepare('UPDATE booking_operation_runs SET opened_at=NULL WHERE id=?').bind(operationId).run();
    }
    throw error;
  }
}
