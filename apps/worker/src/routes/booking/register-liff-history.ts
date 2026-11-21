import { liffBookingJson } from '../liff-booking-response.js';
import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { cancellationQuote, customerCancellationDeadline } from '../../features/booking/booking-cancellation/index.js';
import { customerBookingPayments } from '../../features/booking/booking-payment-history/index.js';
import { bookingHistoryItem } from '../../features/booking/booking-history-item/index.js';
import type { BookingHistoryItem, BookingHistoryResponse } from '@line-crm/shared';
import { resolveAccountIdFromLiff, verifyCallerLineUserId, resolveFriendId } from './identity.js';

export function registerLiffHistory(booking: Hono<Env>): void {
booking.get('/api/liff/booking/me', async (c) => {
  const accountId = await resolveAccountIdFromLiff(c);
  if (!accountId) return liffBookingJson(c, { error: 'unknown_liff' }, 404);
  // 履歴も idToken 検証必須。query の lineUserId に頼ると他人の履歴を覗けてしまう。
  const callerLineUserId = await verifyCallerLineUserId(c, accountId);
  if (!callerLineUserId) return liffBookingJson(c, { error: 'unauthorized' }, 401);
  const friendId = await resolveFriendId(c, callerLineUserId, accountId);
  if (!friendId) return liffBookingJson(c, { upcoming: [], past: [] });

  const upcoming = await c.env.DB
    .prepare(
      `SELECT b.menu_snapshot_json, b.id, b.starts_at, b.ends_at, b.status, b.customer_note,
              b.lock_version, b.menu_id, b.staff_id,b.meeting_mode,CASE WHEN b.status='confirmed' THEN (CASE WHEN b.meeting_url_source='manual' THEN b.meeting_url ELSE COALESCE((SELECT ml.meeting_url FROM booking_meeting_links ml WHERE ml.booking_id=b.id AND b.status='confirmed' AND ml.status='active' LIMIT 1),b.meeting_url) END) ELSE NULL END meeting_url,b.meeting_url_source,b.policy_snapshot_json,b.price_at_booking,EXISTS(SELECT 1 FROM booking_entitlement_uses u WHERE u.booking_id=b.id) ticket,
              m.name AS menu_name,
              COALESCE(m.cancel_deadline_hours_before * 60, bs.cancel_deadline_minutes_before, 1440) AS cancel_deadline_minutes_before,
              s.display_name AS staff_name, s.profile_image_url
         FROM bookings b
         INNER JOIN menus m ON m.id = b.menu_id
         INNER JOIN staff s ON s.id = b.staff_id
         LEFT JOIN booking_settings bs ON bs.line_account_id = b.line_account_id
        WHERE b.friend_id = ? AND b.line_account_id = ?
          AND b.status IN ('requested','confirmed')
          AND b.starts_at >= ?
        ORDER BY b.starts_at ASC`,
    )
    .bind(friendId, accountId, new Date().toISOString())
    .all<BookingHistoryItem & {policy_snapshot_json:string|null;price_at_booking:number;ticket:number}>();

  const past = await c.env.DB
    .prepare(
      `SELECT b.menu_snapshot_json, b.id, b.starts_at, b.ends_at, b.status, b.lock_version, b.menu_id, b.staff_id,b.meeting_mode,CASE WHEN b.status='confirmed' THEN (CASE WHEN b.meeting_url_source='manual' THEN b.meeting_url ELSE COALESCE((SELECT ml.meeting_url FROM booking_meeting_links ml WHERE ml.booking_id=b.id AND b.status='confirmed' AND ml.status='active' LIMIT 1),b.meeting_url) END) ELSE NULL END meeting_url,b.meeting_url_source,
              m.name AS menu_name,
              s.display_name AS staff_name, s.profile_image_url
         FROM bookings b
         INNER JOIN menus m ON m.id = b.menu_id
         INNER JOIN staff s ON s.id = b.staff_id
        WHERE b.friend_id = ? AND b.line_account_id = ?
          AND (b.status NOT IN ('requested','confirmed') OR b.starts_at < ?)
        ORDER BY b.starts_at DESC
        LIMIT 50`,
    )
    .bind(friendId, accountId, new Date().toISOString())
    .all<BookingHistoryItem>();

  const payments = await customerBookingPayments(c.env.DB,accountId,friendId);
  const historyItem = <T extends BookingHistoryItem>(row: T) => ({...bookingHistoryItem(row),
    ...(payments.has(row.id) ? {payment:payments.get(row.id)!} : {})});
  return liffBookingJson(c, { upcoming: upcoming.results.map(row => {
    const {policy_snapshot_json,price_at_booking,ticket,...item}=historyItem(row);
    const policy=policy_snapshot_json?JSON.parse(policy_snapshot_json):null;
    const quote=policy?.enabled?cancellationQuote(policy,row.starts_at,price_at_booking,new Date(),!!ticket):null;
    return {...item,...(quote?{cancellationQuote:quote}:{}),cancel_deadline_at:customerCancellationDeadline(row.starts_at,!!quote?.policyAcceptedRequired,Number(row.cancel_deadline_minutes_before))};
  }), past: past.results.map(historyItem) } satisfies BookingHistoryResponse);
});
}
