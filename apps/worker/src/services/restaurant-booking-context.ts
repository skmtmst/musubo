import { reservationInstant } from '@line-crm/shared';
import { formatStartsAtForStore } from '../features/booking/booking-notifier/index.js';

/** 予約番号・店・本人を照合した飲食の差し込み。近い別予約を検索しない。 */
export interface RestaurantBookingContext {
  reservation_id: string;
  store_id: string;
  line_account_id: string;
  friend_id: string;
  starts_at: string;
  ends_at: string;
  guest_count: number;
  status: string;
  departed_at: string | null;
  customer_version: number;
  line_uid: string;
  timezone: string;
  store_name: string;
  course_name: string | null;
}

export async function readRestaurantBookingContext(db: D1Database, input: {
  reservationId: string; lineAccountId: string; friendId: string; requireActiveStore?:boolean;
}): Promise<RestaurantBookingContext | null> {
  return db.prepare(`SELECT r.id reservation_id,r.store_id,s.line_account_id,f.id friend_id,
    r.starts_at,r.ends_at,r.guest_count,r.status,r.departed_at,r.customer_version,r.line_uid,
    s.timezone,s.name store_name,
    (SELECT m.name FROM rt_menu_items m WHERE m.id=r.course_id AND m.store_id=r.store_id) course_name
    FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id
    JOIN friends f ON f.line_account_id=s.line_account_id AND f.line_platform_user_id=r.line_uid
    WHERE r.id=? AND s.line_account_id=? AND f.id=? AND (?=0 OR s.status='active')
      AND f.is_following=1 AND f.is_hidden=0`)
    .bind(input.reservationId,input.lineAccountId,input.friendId,input.requireActiveStore===false?0:1).first<RestaurantBookingContext>();
}

export function restaurantBookingVariables(context: RestaurantBookingContext): Record<string,string> {
  return {
    reservation_datetime: formatStartsAtForStore(reservationInstant(context.starts_at),context.timezone),
    reservation_end: formatStartsAtForStore(reservationInstant(context.ends_at),context.timezone),
    guest_count: String(context.guest_count),
    course_name: context.course_name ?? '席のみ',
    store_name: context.store_name,
  };
}

export function substituteRestaurantBooking(content: string, context: RestaurantBookingContext): string {
  const values = restaurantBookingVariables(context);
  return content
    .replace(/\{\{\s*reservation_datetime\s*\}\}/g,() => values.reservation_datetime)
    .replace(/\{\{\s*meet_url\s*\}\}/g,'');
}
