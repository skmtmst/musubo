import { logger } from '@line-crm/shared/server';
import type { AccountStyle } from '@line-crm/shared';


import { recoverExpiredBookingPayments, recoverPaidBookingPayments, recoverOrphanedOnlineBookings } from './booking-payment-recovery.js';
import { recoverConfirmedBookingSideEffects } from './booking-confirmed-effects.js';
import type { GoogleServiceAccountCredentials } from '../../services/google-service-account.js';
import type { BookingNotificationSender } from './booking-notifier.js';
import { formatStartsAtForStore, notificationTiming } from './booking-notifier.js';
import { purgeExpiredIdempotency } from './booking-idempotency.js';
import { REQUEST_TTL_HOURS } from './booking-types.js';
import { cancelByTrigger } from '../../services/reminder-trigger.js';
import { recordBookingAudit, resolveLineCredential, isOperationCapabilityStopped, accountFeatureOffExclusionSql } from '@line-crm/db';
import { featureJobCanRun } from '../../services/feature-enforcement.js';

interface StaleRow {
  id: string;
  line_account_id: string;
  friend_id: string;
  starts_at: string;
  menu_name: string;
  staff_name: string;
  channel_access_token: string;
  channel_access_token_encrypted: string | null;
  line_user_id: string;
  /** 店舗のタイムゾーン。文面の日時に使う。 */
  timezone: string | null;
  notification_style: AccountStyle | null;
}

export interface RunExpirerParams {
  now: Date;
  sender: BookingNotificationSender;
  credentials?: GoogleServiceAccountCredentials;
}

export async function runExpirer(
  db: D1Database,
  params: RunExpirerParams,
): Promise<{ expired: number; idempotencyPurged: number }> {
  await recoverPaidBookingPayments(db, params.now, params.credentials);
  await recoverConfirmedBookingSideEffects(db, { now: params.now, credentials: params.credentials });
  await recoverExpiredBookingPayments(db, params.now);
  await recoverOrphanedOnlineBookings(db, params.now);
  const cutoff = new Date(params.now.getTime() - REQUEST_TTL_HOURS * 3600_000).toISOString();
  // 機能オフはSQLで先に除き、緊急停止中の行も消費枠に数えず、IDで次のページへ進む。
  const stale: StaleRow[] = [];
  const eligibleAccounts = new Map<string, boolean>();
  let cursor = '';
  while (stale.length < 200) {
    const page = await db
    .prepare(
      `SELECT b.id, b.line_account_id, b.friend_id, b.starts_at,
              m.name AS menu_name,
              s.display_name AS staff_name,
              la.channel_access_token,
              la.channel_access_token_encrypted,
              f.line_user_id,
              bs.timezone, ast.style AS notification_style
         FROM bookings b
         INNER JOIN menus m ON m.id = b.menu_id
         INNER JOIN staff s ON s.id = b.staff_id
         INNER JOIN line_accounts la ON la.id = b.line_account_id
         INNER JOIN friends f ON f.id = b.friend_id
          LEFT JOIN booking_settings bs ON bs.line_account_id = b.line_account_id
         LEFT JOIN account_styles ast ON ast.line_account_id=b.line_account_id AND ast.selection_mode='configured'
        WHERE b.status = 'requested'
          AND b.requested_at < ? AND b.id > ?
          AND NOT EXISTS (SELECT 1 FROM booking_payments p
            WHERE p.booking_id = b.id AND p.line_account_id = b.line_account_id AND p.status = 'paid')
          AND NOT ${accountFeatureOffExclusionSql('b.line_account_id', 'booking')}
        ORDER BY b.id
        LIMIT 200`,
    )
    .bind(cutoff, cursor)
    .all<StaleRow>();
    for (const row of page.results) {
      let eligible = eligibleAccounts.get(row.line_account_id);
      if (eligible === undefined) {
        eligible = !row.line_account_id || (
          await featureJobCanRun(db, { accountId: row.line_account_id, featureId: 'booking', job: 'booking expirer' })
          && !await isOperationCapabilityStopped(db, row.line_account_id, 'reminder_dispatch')
        );
        eligibleAccounts.set(row.line_account_id, eligible);
      }
      if (eligible) stale.push(row);
      if (stale.length === 200) break;
    }
    const next = page.results.at(-1)?.id;
    if (page.results.length < 200 || !next || next <= cursor) break;
    cursor = next;
  }

  let expired = 0;
  for (const row of stale) {
    // 機能オフ中は期限切れにせずrequestedのまま残す。再オンで再開する。
    if (row.line_account_id && !await featureJobCanRun(db, { accountId: row.line_account_id, featureId: 'booking', job: 'booking expirer' })) {
      continue;
    }
    // 緊急停止 : reminder_dispatch 停止中は期限切れ通知を出せない
    // ので、期限切れ化そのものを保留し requested のまま残す。
    if (row.line_account_id && await isOperationCapabilityStopped(db, row.line_account_id, 'reminder_dispatch')) {
      continue;
    }
    // 条件付き UPDATE: cron 走行中に admin が同じ予約を承認/拒否した場合、
    // requested 行に対してのみ expired 化する。changes=0 なら後続処理（通知/reminders cancel）
    // をスキップして、誤通知を防ぐ。
    const upd = await db
      .prepare(`UPDATE bookings SET confirmation_revision = confirmation_revision + 1, status='expired', decided_at = ? WHERE id = ? AND status = 'requested'
        AND NOT EXISTS (SELECT 1 FROM booking_payments p WHERE p.booking_id = bookings.id
          AND p.line_account_id = bookings.line_account_id AND p.status = 'paid')`)
      .bind(params.now.toISOString(), row.id)
      .run();
    if ((upd.meta?.changes ?? 0) === 0) continue;
    // 期限切れも状態遷移として監査へ残す。誰がではなく system。
    await recordBookingAudit(db, {
      bookingId: row.id,
      lineAccountId: row.line_account_id,
      action: 'status_changed',
      before: { status: 'requested' },
      after: { status: 'expired' },
      reason: 'request_ttl_expired',
      actorType: 'system',
      occurredAt: params.now.toISOString(),
    }).catch((error) => logger.error("services_booking_expirer_failed"));
    await db
      .prepare(
        `UPDATE booking_reminders SET status='cancelled' WHERE booking_id = ? AND status IN ('pending','failed')`,
      )
      .bind(row.id)
      .run();
    // 期限切れも取消と同じく の未送信予定だけを止める。送信済み履歴は残す。
    // 1件の失敗で残り200件を止めないよう行単位で握る。失敗行は末尾の修復走査で拾い直す。
    try {
      await cancelByTrigger(db, {
        triggerType: 'booking',
        sourceId: row.id,
        sourceEventId: row.id,
        friendId: row.friend_id,
        startsAtIso: row.starts_at,
        lineAccountId: row.line_account_id,
        cancelReason: `booking_expired:${row.id}:by:system`,
      });
    } catch (error) {
      logger.error("services_booking_expirer_failed");
    }
    try {
      const accessToken = await resolveLineCredential(
        row.channel_access_token_encrypted,
        row.channel_access_token,
        { lineAccountId: row.line_account_id, field: 'channel_access_token' },
      );
      const timeZone = row.timezone ?? 'Asia/Tokyo';
      const timing = notificationTiming(row.starts_at, timeZone, params.now);
      await params.sender({
        channelAccessToken: accessToken,
        toLineUserId: row.line_user_id,
        kind: 'expired',
        ctx: {
          style:row.notification_style??'standard',
          menuName: row.menu_name,
          staffName: row.staff_name,
          startsAt: formatStartsAtForStore(row.starts_at, timeZone),
          ...timing,
        },
      });
    } catch {
      // 通知失敗は許容、expirer 自体は完了
    }
    expired++;
  }

  // 部分失敗の回復: 業務は終わっているのに が active のまま残った行を止める。
  // 取消が投げた行は次回 cron で拾い直す。手動取消・却下の取りこぼしも
  // source 連動に限って拾う。legacy・手動登録には触れない。
  // 修復自体の失敗で期限切れを壊さないよう外側でも握る。
  try {
    const leftovers = await db
      .prepare(
        `SELECT b.id, b.line_account_id, b.friend_id, b.starts_at
           FROM bookings b
          WHERE b.status IN ('expired', 'cancelled', 'rejected')
            AND EXISTS (
              SELECT 1 FROM friend_reminders fr
               WHERE fr.status = 'active' AND fr.source_kind = 'booking'
                 AND (fr.source_id = b.id OR fr.source_event_id = b.id)
            )
          LIMIT 50`,
      )
      .all<StaleRow>();
    for (const row of leftovers.results ?? []) {
      try {
        await cancelByTrigger(db, {
          triggerType: 'booking',
          sourceKind: 'booking',
          sourceId: row.id,
          sourceEventId: row.id,
          friendId: row.friend_id,
          startsAtIso: row.starts_at,
          lineAccountId: row.line_account_id,
          cancelReason: `booking_repair:${row.id}:by:system`,
          allowLegacyFallback: false,
        });
      } catch (error) {
        logger.error("services_booking_expirer_failed");
      }
    }
  } catch (error) {
    logger.error("services_booking_expirer_failed");
  }

  const idempotencyPurged = await purgeExpiredIdempotency(db, params.now);
  return { expired, idempotencyPurged };
}
