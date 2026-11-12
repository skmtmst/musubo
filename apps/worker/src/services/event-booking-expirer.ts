import { logger } from '@line-crm/shared/server';
// 24時間経過した申込と冪等行を失効させる。要件にイベントの期限切れ通知がないため、サロンと異なり通知はしない。

import { purgeExpiredEventIdempotency } from './event-booking-idempotency.js';
import { featureJobCanRun } from './feature-enforcement.js';
import { REQUESTED_EXPIRE_HOURS } from './event-booking-types.js';
import { enqueueEventWaitlistPromotion } from './event-waitlist.js';
import { cancelByTrigger } from './reminder-trigger.js';

interface StaleRow {
  id: string;
  line_account_id: string;
  friend_id: string;
  event_id: string;
  slot_id: string;
  starts_at: string | null;
}

export interface RunEventBookingExpirerParams {
  now: Date;
}

export async function runEventBookingExpirer(
  db: D1Database,
  params: RunEventBookingExpirerParams,
): Promise<{ expired: number; idempotencyPurged: number }> {
  const cutoff = new Date(
    params.now.getTime() - REQUESTED_EXPIRE_HOURS * 3600_000,
  ).toISOString();
  const stale = await db
    .prepare(
      `SELECT b.id, b.line_account_id, b.friend_id, b.event_id, b.slot_id, s.starts_at
         FROM event_bookings b
         LEFT JOIN event_slots s ON s.id = b.slot_id
        WHERE b.status = 'requested'
          AND (
            (b.approval_expires_at IS NOT NULL AND b.approval_expires_at <= ?)
            OR (b.approval_expires_at IS NULL AND b.requested_at <= ?)
          )
        LIMIT 200`,
    )
    .bind(params.now.toISOString(), cutoff)
    .all<StaleRow>();

  let expired = 0;
  for (const row of stale.results ?? []) {
    // 機能オフ中は期限切れにせずrequestedのまま残す。再オンで再開する。
    if (row.line_account_id && !await featureJobCanRun(db, { accountId: row.line_account_id, featureId: 'events', job: 'event booking expirer' })) {
      continue;
    }
    // 同時の担当者判断を上書きしないよう、元の状態を更新条件へ含める。
    const upd = await db
      .prepare(
        `UPDATE event_bookings
            SET status = 'expired', decided_at = ?, updated_at = ?, confirmation_revision = confirmation_revision + 1
          WHERE id = ? AND status = 'requested'`,
      )
      .bind(params.now.toISOString(), params.now.toISOString(), row.id)
      .run();
    if ((upd.meta?.changes ?? 0) === 0) continue;
    await db
      .prepare(
        `UPDATE event_booking_reminders
            SET status = 'cancelled'
          WHERE booking_id = ? AND status IN ('pending','failed')`,
      )
      .bind(row.id)
      .run();
    // 期限切れも取消と同じく の未送信予定だけを止める。送信済み履歴は残す。
    // 1件の失敗で残りを止めないよう行単位で握る。失敗行は末尾の修復走査で拾い直す。
    try {
      await cancelByTrigger(db, {
        triggerType: 'event',
        sourceId: row.id,
        sourceEventId: row.id,
        friendId: row.friend_id,
        startsAtIso: row.starts_at,
        lineAccountId: row.line_account_id,
        cancelReason: `event_expired:${row.id}:by:system`,
      });
    } catch (error) {
      logger.error("event_booking.cancel_reminders_failed");
    }
    await enqueueEventWaitlistPromotion(db, {
      lineAccountId: row.line_account_id,
      eventId: row.event_id,
      occurrenceId: row.slot_id,
      sourceKey: `booking:${row.id}:expired`,
      now: params.now,
    });
    expired++;
  }

  // 部分失敗の回復: 業務は終わっているのに が active のまま残った行を止める。
  // 取消が投げた行は次回 cron で拾い直す。手動取消・落選の取りこぼしも
  // source 連動に限って拾う。legacy・手動登録には触れない。
  // 修復自体の失敗で期限切れを壊さないよう外側でも握る。
  try {
    const leftovers = await db
      .prepare(
        `SELECT b.id, b.line_account_id, b.friend_id
           FROM event_bookings b
          WHERE b.status IN ('expired', 'cancelled', 'rejected')
            AND EXISTS (
              SELECT 1 FROM friend_reminders fr
               WHERE fr.status = 'active' AND fr.source_kind = 'event'
                 AND (fr.source_id = b.id OR fr.source_event_id = b.id)
            )
          LIMIT 50`,
      )
      .all<StaleRow>();
    for (const row of leftovers.results ?? []) {
      try {
        await cancelByTrigger(db, {
          triggerType: 'event',
          sourceKind: 'event',
          sourceId: row.id,
          sourceEventId: row.id,
          friendId: row.friend_id,
          startsAtIso: row.starts_at,
          lineAccountId: row.line_account_id,
          cancelReason: `event_repair:${row.id}:by:system`,
          allowLegacyFallback: false,
        });
      } catch (error) {
        logger.error("event_booking.repair_reminders_failed");
      }
    }
  } catch (error) {
    logger.error("event_booking.scan_stale_reminders_failed");
  }

  const idempotencyPurged = await purgeExpiredEventIdempotency(db, params.now);
  return { expired, idempotencyPurged };
}
