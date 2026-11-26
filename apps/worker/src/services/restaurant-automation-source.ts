import type { V6WriteGuard } from '@line-crm/db';
import { readRestaurantBookingContext, type RestaurantBookingContext } from './restaurant-booking-context.js';
import type { RestaurantEvent } from './restaurant-event-types.js';

export type RestaurantAutomationSource = { restaurant: false; allowed: true } | {
  restaurant: true; allowed: false;
} | {
  restaurant: true; allowed: true; context: RestaurantBookingContext; guard: V6WriteGuard;
  waitlistId?: string;
};

/** ルールのきっかけと保存済みの出来事を照合し、待機後の取消・訂正を見逃さない。 */
export async function readRestaurantAutomationSource(db: D1Database, input: {
  eventType: string; eventId: string; lineAccountId: string; friendId: string | null; now: string; strict?:boolean;
}): Promise<RestaurantAutomationSource> {
  const strict=input.strict!==false;
  if (!input.eventType.startsWith('restaurant.')) return {restaurant:false,allowed:true};
  if (!input.friendId) return {restaurant:true,allowed:false};
  const event = await db.prepare(`SELECT * FROM rt_reservation_events
    WHERE id=? AND event_type=? AND line_account_id=? AND friend_id=?`)
    .bind(input.eventId,input.eventType,input.lineAccountId,input.friendId).first<RestaurantEvent>();
  if (!event) return {restaurant:true,allowed:false};
  const eventSql = `EXISTS(SELECT 1 FROM rt_reservation_events WHERE id=? AND event_type=? AND line_account_id=? AND friend_id=? AND payload_json=?)`;
  const eventBinds = [input.eventId,input.eventType,input.lineAccountId,input.friendId,event.payload_json];
  if (event.event_type === 'restaurant.waitlist.invited') {
    let waitlistId: unknown, startsAt:unknown, holdExpiresAt:unknown;
    try { ({waitlistId,startsAt,holdExpiresAt} = JSON.parse(event.payload_json)); } catch { return {restaurant:true,allowed:false}; }
    if (typeof waitlistId !== 'string'||typeof startsAt!=='string'||typeof holdExpiresAt!=='string') return {restaurant:true,allowed:false};
    const context = await db.prepare(`SELECT w.id reservation_id,w.store_id,s.line_account_id,f.id friend_id,
      w.starts_at,w.ends_at,w.guest_count,w.status,NULL departed_at,0 customer_version,w.line_uid,
      s.timezone,s.name store_name,NULL course_name
      FROM rt_seat_waitlist w JOIN rt_stores s ON s.id=w.store_id
      JOIN friends f ON f.line_account_id=s.line_account_id AND f.line_platform_user_id=w.line_uid
      WHERE w.id=? AND w.store_id=? AND s.line_account_id=? AND f.id=? ${strict?"AND s.status='active'":''}
      AND f.is_following=1 AND f.is_hidden=0 AND w.status='invited'
      AND w.notification_retry_key=? AND julianday(w.hold_expires_at)>julianday(?)
      ${strict?'AND w.starts_at=? AND w.hold_expires_at=?':''}`)
      .bind(waitlistId,event.store_id,input.lineAccountId,input.friendId,event.request_id,input.now,...(strict?[startsAt,holdExpiresAt]:[])).first<RestaurantBookingContext>();
    if (!context) return {restaurant:true,allowed:false};
    return {restaurant:true,allowed:true,context,waitlistId,guard:{
      sql:`${eventSql} AND EXISTS(SELECT 1 FROM rt_seat_waitlist w JOIN rt_stores s ON s.id=w.store_id
        JOIN friends f ON f.line_account_id=s.line_account_id AND f.line_platform_user_id=w.line_uid
        WHERE w.id=? AND w.store_id=? AND s.line_account_id=? AND f.id=? ${strict?"AND s.status='active'":''}
        AND f.is_following=1 AND f.is_hidden=0 AND w.status='invited' AND w.notification_retry_key=?
        AND julianday(w.hold_expires_at)>julianday(?) ${strict?'AND w.hold_expires_at=? AND w.starts_at=? AND w.ends_at=? AND w.guest_count=?':''})`,
      binds:[...eventBinds,waitlistId,event.store_id,input.lineAccountId,input.friendId,event.request_id,input.now,...(strict?[holdExpiresAt,context.starts_at,context.ends_at,context.guest_count]:[])],
    }};
  }
  if (!event.reservation_id) return {restaurant:true,allowed:false};
  const context = await readRestaurantBookingContext(db,{reservationId:event.reservation_id,lineAccountId:input.lineAccountId,friendId:input.friendId,requireActiveStore:strict});
  if (!context || context.store_id !== event.store_id || strict && context.customer_version !== event.reservation_version)
    return {restaurant:true,allowed:false};
  if (event.event_type === 'restaurant.reservation.cancelled') {
    if (!['cancelled','no_show'].includes(context.status)) return {restaurant:true,allowed:false};
  } else if (['cancelled','no_show','pending'].includes(context.status)) return {restaurant:true,allowed:false};
  if (event.event_type === 'restaurant.departed' && !context.departed_at) return {restaurant:true,allowed:false};
  if (event.event_type === 'restaurant.departure_undone' && context.departed_at) return {restaurant:true,allowed:false};
  if(!strict){
    const state=event.event_type==='restaurant.reservation.cancelled'?"r.status IN ('cancelled','no_show')":"r.status NOT IN ('cancelled','no_show')";
    const undo=event.event_type==='restaurant.departed'?'restaurant.departure_undone':event.event_type==='restaurant.arrived'?'restaurant.arrival_undone':null;
    const undoSql=undo?` AND NOT EXISTS(SELECT 1 FROM rt_reservation_events correction WHERE correction.reservation_id=r.id
      AND correction.event_type=? AND correction.reservation_version>?)`:'';
    const phase=event.event_type==='restaurant.departed'?' AND r.departed_at IS NOT NULL':event.event_type==='restaurant.departure_undone'?' AND r.departed_at IS NULL':'';
    const sql=`${eventSql} AND EXISTS(SELECT 1 FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id
      JOIN friends f ON f.line_account_id=s.line_account_id AND f.line_platform_user_id=r.line_uid
      WHERE r.id=? AND r.store_id=? AND s.line_account_id=? AND f.id=? AND f.is_following=1 AND f.is_hidden=0
      AND ${state}${phase}${undoSql})`;
    const binds=[...eventBinds,context.reservation_id,context.store_id,input.lineAccountId,input.friendId,...(undo?[undo,event.reservation_version]:[])];
    if(!await db.prepare(`SELECT 1 WHERE ${sql}`).bind(...binds).first())return {restaurant:true,allowed:false};
    return {restaurant:true,allowed:true,context,guard:{sql,binds}};
  }
  return {restaurant:true,allowed:true,context,guard:{
    sql:`${eventSql} AND EXISTS(SELECT 1 FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id
      JOIN friends f ON f.line_account_id=s.line_account_id AND f.line_platform_user_id=r.line_uid
      WHERE r.id=? AND r.store_id=? AND r.customer_version=? AND r.status=? AND r.departed_at IS ?
        AND r.starts_at=? AND r.ends_at=? AND r.guest_count=? AND s.line_account_id=? AND f.id=?
        AND s.status='active' AND f.is_following=1 AND f.is_hidden=0)`,
    binds:[...eventBinds,context.reservation_id,context.store_id,context.customer_version,context.status,context.departed_at,
      context.starts_at,context.ends_at,context.guest_count,input.lineAccountId,input.friendId],
  }};
}
