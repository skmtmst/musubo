import { getAccountTimeZone } from './availability.js';
import { reservationInstant } from '@line-crm/shared';
import { formatStartsAtForStore } from '../features/booking/booking-notifier/index.js';

export const CHAT_RESERVATION_KEYS = ['reservation_datetime', 'course_name', 'guest_count'] as const;

/** 手動返信では、飲食の予約を優先し、なければ他の予約の中から最も近いものを選ぶ。 */
export async function chatReservationVariables(db: D1Database, friendId: string, accountId: string | null): Promise<Record<string, string>> {
  if (!accountId) return {};
  const restaurant = await db.prepare(`SELECT r.starts_at, r.guest_count, s.timezone,
      (SELECT m.name FROM rt_menu_items m WHERE m.id=r.course_id AND m.store_id=r.store_id) course_name
    FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id
    JOIN friends f ON f.line_account_id=s.line_account_id AND f.line_user_id=r.line_uid
    WHERE f.id=? AND s.line_account_id=? AND julianday(r.starts_at)>julianday('now')
      AND r.status IN ('pending','confirmed','seated')
    ORDER BY julianday(r.starts_at), r.id LIMIT 1`).bind(friendId, accountId)
    .first<{ starts_at: string; guest_count: number; timezone: string; course_name: string | null }>();
  if (restaurant) return {
    reservation_datetime: formatStartsAtForStore(reservationInstant(restaurant.starts_at), restaurant.timezone),
    guest_count: String(restaurant.guest_count), course_name: restaurant.course_name ?? '席のみ',
  };
  const booking = await db.prepare(`SELECT starts_at, course_name FROM (
    SELECT b.starts_at, m.name course_name FROM bookings b JOIN menus m ON m.id=b.menu_id AND m.line_account_id=b.line_account_id
      WHERE b.friend_id=? AND b.line_account_id=? AND b.status IN ('requested','confirmed')
    UNION ALL
    SELECT s.starts_at, e.name course_name FROM event_bookings b JOIN event_slots s ON s.id=b.slot_id
      JOIN events e ON e.id=b.event_id AND e.line_account_id=b.line_account_id AND s.event_id=e.id
      WHERE b.friend_id=? AND b.line_account_id=? AND b.status IN ('requested','confirmed')
    UNION ALL
    SELECT c.start_at starts_at, c.title course_name FROM calendar_bookings c JOIN friends f ON f.id=c.friend_id
      WHERE c.friend_id=? AND f.line_account_id=? AND c.status='confirmed'
    ) WHERE julianday(starts_at)>julianday('now') ORDER BY julianday(starts_at), course_name LIMIT 1`)
    .bind(friendId, accountId, friendId, accountId, friendId, accountId)
    .first<{ starts_at: string; course_name: string }>();
  if (!booking) return {};
  const timeZone = await getAccountTimeZone(db, accountId);
  return { reservation_datetime: formatStartsAtForStore(reservationInstant(booking.starts_at), timeZone), course_name: booking.course_name };
}
