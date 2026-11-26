import { logger } from '@line-crm/shared/server';
import { cancelByTrigger } from '../../services/reminder-trigger.js';
import { sendEventBookingNotification, type EventNotificationKind } from '../../services/event-booking-notifier.js';
import { resolveLineCredential } from '@line-crm/db';
import { startsAtJst } from './time-input.js';

export interface BookingActionRow {
  id: string;
  line_account_id: string;
  event_id: string;
  slot_id: string;
  friend_id: string;
  status: string;
  lock_version:number;
  decided_at: string | null;
}

export async function loadBookingForAction(
  db: D1Database,
  _account_id: string,
  event_id: string,
  booking_id: string,
): Promise<BookingActionRow | null> {
  // 認可は呼び出し元の ownsEvent (event の account_ids / line_account_id に
  // caller account が含まれるか) で実施済。booking.line_account_id は通知の
  // 送信元アカ識別用なので、ここでは event_id だけで booking を一意取得する。
  // multi-account event では booking が別アカ経由で作られていても admin から
  // 操作可能にする。
  const row = await db
    .prepare(
      `SELECT id, line_account_id, event_id, slot_id, friend_id, status, decided_at,lock_version
         FROM event_bookings
        WHERE id = ? AND event_id = ?`,
    )
    .bind(booking_id, event_id)
    .first<BookingActionRow>();
  return row ?? null;
}

export async function notifyBookingFriend(
  db: D1Database,
  booking_id: string,
  kind: EventNotificationKind,
): Promise<void> {
  try {
    const row = await db
      .prepare(
        `SELECT e.name AS event_name, e.venue_name, e.venue_url,
                e.confirmation_message_extra,
                s.starts_at AS slot_starts_at,
                b.line_account_id,b.status,b.slot_id,b.lock_version,
                la.channel_access_token,
                la.channel_access_token_encrypted,
                f.line_platform_user_id AS line_user_id
           FROM event_bookings b
           JOIN events e ON e.id = b.event_id
           JOIN event_slots s ON s.id = b.slot_id
           JOIN line_accounts la ON la.id = b.line_account_id
           JOIN friends f ON f.id = b.friend_id
          WHERE b.id = ?`,
      )
      .bind(booking_id)
      .first<{
        event_name: string;
        venue_name: string | null;
        venue_url: string | null;
        confirmation_message_extra: string | null;
        slot_starts_at: string;
        line_account_id: string; status: string; slot_id: string; lock_version:number;
        channel_access_token: string;
        channel_access_token_encrypted: string | null;
        line_user_id: string;
      }>();
    if (!row || !row.channel_access_token) return;
    const accessToken = await resolveLineCredential(
      row.channel_access_token_encrypted,
      row.channel_access_token,
      { lineAccountId: row.line_account_id, field: 'channel_access_token' },
    );
    await sendEventBookingNotification({
      delivery: { db, accountId: row.line_account_id, operationId: `event-transition:${booking_id}:${row.lock_version}`,
        subject:{version:row.lock_version,bookingId:booking_id,slotId:row.slot_id,status:row.status,startsAt:row.slot_starts_at},
        authorize: async () => !!await db.prepare('SELECT 1 ok FROM event_bookings WHERE id=? AND line_account_id=? AND status=? AND slot_id=?')
          .bind(booking_id,row.line_account_id,row.status,row.slot_id).first() },
      channelAccessToken: accessToken,
      toLineUserId: row.line_user_id,
      kind,
      ctx: {
        eventName: row.event_name,
        startsAtJst: startsAtJst(row.slot_starts_at),
        venueName: row.venue_name,
        venueUrl: row.venue_url,
        confirmationExtra: row.confirmation_message_extra,
      },
    });
  } catch (e) {
    logger.error("events.notify_booking_friend_failed");
  }
}

/**
 * 落選ずみの予約の 未送信予定だけを止める (再送の修復受付と初回で共用)。
 * 状態更新の後に呼ぶ。送信権の貸出中は投げる (呼び出し側は 409 で再試行)。
 */
export async function repairRejectedBookingV6(
  db: D1Database,
  booking: BookingActionRow,
  cancelReason: string,
): Promise<void> {
  const slot = await db
    .prepare(`SELECT starts_at FROM event_slots WHERE id = ?`)
    .bind(booking.slot_id)
    .first<{ starts_at: string }>();
  await cancelByTrigger(db, {
    triggerType: 'event',
    sourceId: booking.id,
    sourceEventId: booking.id,
    friendId: booking.friend_id,
    startsAtIso: slot?.starts_at ?? null,
    lineAccountId: booking.line_account_id,
    cancelReason,
    failOnSendInFlight: true,
  });
}
