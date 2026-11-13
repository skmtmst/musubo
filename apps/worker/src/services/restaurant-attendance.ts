import { StampError } from './visit-stamps.js';
export type AttendanceAction = 'visited'|'late'|'no_show'|'undo_visit'|'depart'|'undo_departure';
export interface AttendanceInput { action:AttendanceAction; expectedVersion:number; requestId:string; lateMinutes?:number; }
/** 実来店・退店の唯一の保存口。CAS・監査・占有変更をD1 batchで確定する。 */
export async function setRestaurantAttendance(db:D1Database,id:string,storeId:string,input:AttendanceInput,actorId:string|null,actorName:string|null) {
 if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1)throw new StampError('最新の予約を読み込んでください',400,['expectedVersion']);
 if(typeof input.requestId!=='string'||!/^[\w:-]{1,160}$/.test(input.requestId))throw new StampError('操作の識別番号を確認してください',400,['requestId']);
 const current=await db.prepare('SELECT status,customer_version,departed_at FROM rt_reservations WHERE id=? AND store_id=?').bind(id,storeId).first<{status:string;customer_version:number;departed_at:string|null}>();
 if(!current)throw new StampError('予約が見つかりません',404);
 // 同じ操作の再送は版が進んでも元の結果を返す。新しい操作の古い版は拒否。
 const prior=await db.prepare(`SELECT kind AS action,late_minutes FROM rt_seat_visit_marks WHERE reservation_id=?1 AND request_id=?2 UNION ALL SELECT 'undo_visit',NULL FROM rt_seat_visit_marks WHERE reservation_id=?1 AND undone_request_id=?2 UNION ALL SELECT 'depart',NULL FROM rt_reservation_departures WHERE reservation_id=?1 AND request_id=?2 UNION ALL SELECT 'undo_departure',NULL FROM rt_reservation_departures WHERE reservation_id=?1 AND undone_request_id=?2`).bind(id,input.requestId).first<{action:string;late_minutes:number|null}>();
 if(prior){if(prior.action!==input.action||(input.action==='late'&&prior.late_minutes!==input.lateMinutes))throw new StampError('同じ操作の内容が変わっています',409);return current;}
 if(current.customer_version!==input.expectedVersion)throw new StampError('version_conflict',409);
 const at=new Date().toISOString(),op=crypto.randomUUID();
 const sql:D1PreparedStatement[]=[];
 let next=current.status;
 if(['visited','late','no_show'].includes(input.action)) {
  if(input.action==='no_show'&&current.status==='pending')throw new StampError('approval_required',409);
  if(input.action==='no_show'&&current.status==='seated')throw new StampError('already_arrived',409);
  if(input.action==='no_show'&&await db.prepare("SELECT 1 FROM rt_seat_visit_marks WHERE reservation_id=? AND kind='visited' AND undone_at IS NULL LIMIT 1").bind(id).first())throw new StampError('already_arrived',409);
  if(current.departed_at||!['pending','confirmed','seated'].includes(current.status))throw new StampError('この状態からは付けられません',409);
  if(input.action==='late'&&(!Number.isInteger(input.lateMinutes)||input.lateMinutes!<1||input.lateMinutes!>1440))throw new StampError('遅れ分数は1〜1440です',400,['lateMinutes']);
  next=input.action==='late'?current.status:input.action;
  sql.push(db.prepare(`INSERT INTO rt_seat_visit_marks(id,reservation_id,store_id,kind,late_minutes,marked_by_staff_id,marked_by_name,marked_at,request_id,result_version)
  SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM rt_reservations WHERE id=? AND customer_version=?)`).bind(op,id,storeId,input.action,input.action==='late'?input.lateMinutes!:null,actorId,actorName,at,input.requestId,input.expectedVersion+1,id,input.expectedVersion));
 } else if(input.action==='undo_visit') {
  if(current.departed_at)throw new StampError('先に退店の記録を取り消してください',409);
  const mark=await db.prepare('SELECT id,kind FROM rt_seat_visit_marks WHERE reservation_id=? AND undone_at IS NULL ORDER BY marked_at DESC,rowid DESC LIMIT 1').bind(id).first<{id:string;kind:string}>();
  if(!mark)throw new StampError('印がありません',404);
  if(mark.kind!=='late')next='confirmed';
  sql.push(db.prepare(`UPDATE rt_seat_visit_marks SET undone_at=?,undone_by=?,undone_request_id=?,result_version=? WHERE id=? AND undone_at IS NULL
  AND EXISTS(SELECT 1 FROM rt_reservations WHERE id=? AND customer_version=?)`).bind(at,actorId,input.requestId,input.expectedVersion+1,mark.id,id,input.expectedVersion));
 } else if(input.action==='depart') {
  if(current.departed_at)throw new StampError('退店は記録済みです',409);
  sql.push(db.prepare(`INSERT INTO rt_reservation_departures(id,reservation_id,store_id,request_id,occurred_at,actor_id,result_version)
  SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM rt_reservations WHERE id=? AND customer_version=? AND status IN ('visited','seated'))`).bind(op,id,storeId,input.requestId,at,actorId,input.expectedVersion+1,id,input.expectedVersion));
 } else if(input.action==='undo_departure') {
  if(!current.departed_at)throw new StampError('退店の記録がありません',409);
  sql.push(db.prepare(`UPDATE rt_reservation_departures SET undone_at=?,undone_by=?,undone_request_id=?,result_version=? WHERE reservation_id=? AND undone_at IS NULL
  AND EXISTS(SELECT 1 FROM rt_reservations WHERE id=? AND customer_version=?)`).bind(at,actorId,input.requestId,input.expectedVersion+1,id,id,input.expectedVersion));
 } else throw new StampError('操作を確認してください',400,['action']);
 sql.push(db.prepare(`UPDATE rt_reservations SET confirmation_revision = confirmation_revision + 1, status=?,departed_at=?,customer_version=customer_version+1,updated_at=?
 WHERE id=? AND customer_version=? AND changes()=1`).bind(next,input.action==='depart'?at:input.action==='undo_departure'?null:current.departed_at,at,id,input.expectedVersion));
 const results=await db.batch(sql);
 if(!results[1].meta.changes)throw new StampError('version_conflict',409);
 return db.prepare(`SELECT r.status,r.customer_version,r.departed_at,(SELECT marked_at FROM rt_seat_visit_marks WHERE reservation_id=r.id AND kind='visited' AND undone_at IS NULL ORDER BY marked_at DESC LIMIT 1) AS arrived_at FROM rt_reservations r WHERE r.id=?`).bind(id).first();
}
