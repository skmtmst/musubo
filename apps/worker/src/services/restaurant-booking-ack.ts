import { StyleError } from './style-setup.js';
import { readWindow } from './style-analytics-core.js';

const MAX_ACK = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// rt_reservations.created_at は SQLite の datetime('now') が作る UTC。
const requested = `julianday(r.created_at)`;

export async function acknowledgeRestaurantBookings(db:D1Database, input:{accountId:string;storeId:string;actorId:string;operationId:string;bookingId:string|null;now?:number}) {
  if(!UUID.test(input.operationId) || !input.storeId || (input.bookingId !== null && (!input.bookingId || input.bookingId.length>200))) throw new StyleError('invalid_request');
  const store=await db.prepare('SELECT timezone FROM rt_stores WHERE id=? AND line_account_id=?').bind(input.storeId,input.accountId).first<{timezone:string}>();
  if(!store)throw new StyleError('not_found',404);
  const now=input.now??Date.now();
  const window=readWindow({},store.timezone,now);
  const kind=input.bookingId===null?'all':'single';
  const eligible=`r.store_id=? AND r.status NOT IN ('cancelled','rejected','expired') AND ${requested}>=julianday(?) AND ${requested}<julianday(?) AND (? IS NULL OR r.id=?)`;
  // changes() binds the snapshot to the first successful insertion; a repeated operation never captures newer bookings.
  const results=await db.batch([
    db.prepare(`INSERT INTO restaurant_booking_ack_operations(id,line_account_id,store_id,actor_id,operation_kind,requested_booking_id,state,created_at)
      SELECT ?,?,?,?,?,?,'active',? WHERE EXISTS(SELECT 1 FROM rt_stores WHERE id=? AND line_account_id=?)
      AND (? IS NULL OR EXISTS(SELECT 1 FROM rt_reservations WHERE id=? AND store_id=?)) AND (SELECT COUNT(*) FROM (SELECT r.id FROM rt_reservations r WHERE ${eligible}
      AND NOT EXISTS(SELECT 1 FROM restaurant_booking_acknowledgements a WHERE a.line_account_id=? AND a.store_id=r.store_id AND a.booking_kind='restaurant' AND a.booking_id=r.id) LIMIT 1001))<=?
      ON CONFLICT(id) DO NOTHING`).bind(input.operationId,input.accountId,input.storeId,input.actorId,kind,input.bookingId,new Date(now).toISOString(),input.storeId,input.accountId,input.bookingId,input.bookingId,input.storeId,input.storeId,window.from,window.to,input.bookingId,input.bookingId,input.accountId,MAX_ACK),
    db.prepare(`INSERT INTO restaurant_booking_ack_operation_items(operation_id,booking_kind,booking_id)
      SELECT ?,'restaurant',r.id FROM rt_reservations r
      WHERE changes()=1 AND ${eligible} AND EXISTS(SELECT 1 FROM rt_stores s WHERE s.id=r.store_id AND s.line_account_id=?)
      AND (?='single' OR NOT EXISTS(SELECT 1 FROM restaurant_booking_acknowledgements a WHERE a.line_account_id=? AND a.store_id=r.store_id AND a.booking_kind='restaurant' AND a.booking_id=r.id))`)
      .bind(input.operationId,input.storeId,window.from,window.to,input.bookingId,input.bookingId,input.accountId,kind,input.accountId),
    db.prepare(`INSERT INTO restaurant_booking_acknowledgements(line_account_id,store_id,booking_kind,booking_id,acknowledged_at,actor_id,operation_id)
      SELECT ?,r.store_id,i.booking_kind,i.booking_id,?,?,i.operation_id FROM restaurant_booking_ack_operation_items i
      JOIN rt_reservations r ON r.id=i.booking_id WHERE i.operation_id=? AND changes()>0
      ON CONFLICT(line_account_id,store_id,booking_kind,booking_id) DO UPDATE SET
        acknowledged_at=excluded.acknowledged_at,actor_id=excluded.actor_id,operation_id=excluded.operation_id`)
      .bind(input.accountId,new Date(now).toISOString(),input.actorId,input.operationId),
    db.prepare(`UPDATE restaurant_booking_ack_operations SET acknowledged_count=(SELECT COUNT(*) FROM restaurant_booking_ack_operation_items WHERE operation_id=?)
      WHERE id=? AND changes()>0`).bind(input.operationId,input.operationId),
  ]);
  const op=await db.prepare('SELECT line_account_id,store_id,actor_id,operation_kind,requested_booking_id,state,acknowledged_count FROM restaurant_booking_ack_operations WHERE id=?').bind(input.operationId).first<{line_account_id:string;store_id:string;actor_id:string;operation_kind:string;requested_booking_id:string|null;state:string;acknowledged_count:number}>();
  if(!op)throw input.bookingId === null ? new StyleError('too_many_bookings',422) : new StyleError('not_found',404);
  if(op.line_account_id!==input.accountId || op.store_id!==input.storeId || op.actor_id!==input.actorId || op.operation_kind!==kind || op.requested_booking_id!==input.bookingId)throw new StyleError('operation_conflict',409);
  return {operationId:input.operationId,acknowledgedCount:op.acknowledged_count,state:op.state,replayed:results[0].meta.changes===0};
}

export async function undoRestaurantBookingAcknowledgement(db:D1Database,input:{accountId:string;storeId:string;actorId:string;operationId:string}) {
  if(!UUID.test(input.operationId))throw new StyleError('invalid_request');
  const op=await db.prepare('SELECT state FROM restaurant_booking_ack_operations WHERE id=? AND line_account_id=? AND store_id=? AND actor_id=?').bind(input.operationId,input.accountId,input.storeId,input.actorId).first<{state:string}>();
  if(!op)throw new StyleError('not_found',404);
  const result=await db.batch([
    db.prepare("UPDATE restaurant_booking_ack_operations SET state='undone' WHERE id=? AND line_account_id=? AND store_id=? AND actor_id=? AND state='active'").bind(input.operationId,input.accountId,input.storeId,input.actorId),
    db.prepare('DELETE FROM restaurant_booking_acknowledgements WHERE operation_id=? AND line_account_id=? AND store_id=? AND actor_id=? AND changes()=1').bind(input.operationId,input.accountId,input.storeId,input.actorId),
  ]);
  return {operationId:input.operationId,undoneCount:result[1].meta.changes??0,state:'undone' as const,replayed:result[0].meta.changes===0};
}
