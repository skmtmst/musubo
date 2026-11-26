import { formatStartsAtForStore } from '../features/booking/booking-notifier/index.js';
import { reservationInstant } from '@line-crm/shared';
import type { RestaurantBookingContext } from './restaurant-booking-context.js';

/** 招待先の店のLIFFを使い、予約と見送りの入口を同じ場所で組み立てる。 */
export async function restaurantWaitlistVariables(db:D1Database,accountId:string,waitlistId:string,liffUrl?:string){
 const account=liffUrl?null:await db.prepare('SELECT liff_id FROM line_accounts WHERE id=? AND archived_at IS NULL').bind(accountId).first<{liff_id:string|null}>();
 const base=liffUrl?.replace(/\/$/,'')??(account?.liff_id?`https://liff.line.me/${encodeURIComponent(account.liff_id)}`:'');
 if(!/^https:\/\//.test(base))throw new Error('restaurant_liff_unavailable');
 const wait=await db.prepare('SELECT hold_expires_at FROM rt_seat_waitlist WHERE id=?').bind(waitlistId).first<{hold_expires_at:string}>();
 return {waitlist_book_url:`${base}/booking?seat_waitlist=${encodeURIComponent(waitlistId)}`,
  waitlist_decline_url:`${base}/booking?seat_waitlist=${encodeURIComponent(waitlistId)}&action=decline`,
  waitlist_hold_expires_at:wait?.hold_expires_at??''};
}

/** 既存の来店確認の本人・予約版・期限の保護を、送り手が変わっても保つ。 */
export async function restaurantConfirmationVariables(db:D1Database,requestId:string,context:RestaurantBookingContext,now:string){
 await db.prepare(`INSERT OR IGNORE INTO rt_reservation_confirmations(request_id,reservation_id,reservation_version,friend_id,requested_at,expires_at)
  SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id
   JOIN friends f ON f.id=? AND f.line_account_id=s.line_account_id AND f.line_platform_user_id=r.line_uid
   WHERE r.id=? AND r.customer_version=? AND r.status='confirmed' AND s.line_account_id=?)`)
  .bind(requestId,context.reservation_id,context.customer_version,context.friend_id,now,context.starts_at,context.friend_id,context.reservation_id,context.customer_version,context.line_account_id).run();
 const row=await db.prepare('SELECT 1 FROM rt_reservation_confirmations WHERE request_id=? AND reservation_id=? AND reservation_version=? AND friend_id=? AND julianday(expires_at)>julianday(?)')
  .bind(requestId,context.reservation_id,context.customer_version,context.friend_id,now).first();
 if(!row)throw new Error('restaurant_confirmation_changed');
 return {restaurant_going:`rc:${requestId}:going`,restaurant_change:`rc:${requestId}:change_requested`,restaurant_cancel:`rc:${requestId}:cancel`,
  reservation_datetime:formatStartsAtForStore(reservationInstant(context.starts_at),context.timezone)};
}
