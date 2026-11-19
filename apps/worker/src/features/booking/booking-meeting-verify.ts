import type { MeetingProvider } from './booking-meeting-create.js';

/** 通信結果が不明な操作は、相手先の読み取りだけで照合する。時刻や担当者だけでは特定せず、会議に保存した一意の鍵が完全一致した場合だけ found を返す。 */
export interface MeetingVerifier {
  verifyCreate(input: { staffId: string; idempotencyKey: string; signal: AbortSignal }): Promise<{kind:'found'; meetingId:string; url:string; idempotencyKey:string}|{kind:'absent'}|{kind:'unknown'}>;
  verifyDelete(input: { staffId: string; meetingId:string; signal: AbortSignal }): Promise<'deleted'|'present'|'unknown'>;
}

async function bounded<T>(call:(signal:AbortSignal)=>Promise<T>):Promise<T|null> {
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),8000);
 try {return await Promise.race([call(controller.signal),new Promise<null>(resolve=>controller.signal.addEventListener('abort',()=>resolve(null),{once:true}))]);}
 catch{return null;}finally{clearTimeout(timer);}
}
export async function verifyUnknownMeeting(db:D1Database, input:{linkId:string;accountId:string;verifier:MeetingVerifier}):Promise<'verified'|'unknown'|'not_found'> {
 const row=await db.prepare(`SELECT l.id,l.booking_id,l.provider,l.staff_id,l.status,l.last_error_code,l.idempotency_key,l.external_meeting_id,l.starts_at,l.ends_at,l.updated_at,l.attempt_count
   FROM booking_meeting_links l JOIN bookings b ON b.id=l.booking_id
   WHERE l.id=? AND b.line_account_id=?`).bind(input.linkId,input.accountId).first<{
   id:string;booking_id:string;provider:MeetingProvider;staff_id:string|null;status:string;last_error_code:string|null;
   idempotency_key:string;external_meeting_id:string|null;starts_at:string|null;ends_at:string|null;updated_at:string;attempt_count:number}>();
 if(!row||!row.staff_id)return 'not_found';
 if(row.status==='pending'&&(row.last_error_code==='result_unknown'||(row.last_error_code===null&&row.attempt_count>0))) {
  if(row.last_error_code===null && (Date.now()-Date.parse(row.updated_at)<60_000 || !Number.isFinite(Date.parse(row.updated_at)))) return 'unknown';
  const staffId=row.staff_id;
  const result=await bounded(signal=>input.verifier.verifyCreate({staffId,idempotencyKey:row.idempotency_key,signal}));
  if(!result || result.kind==='unknown')return 'unknown';
  // 検索への反映遅れがあるため、不在だけでは未作成と断定しない。
  if(result.kind==='absent'||result.idempotencyKey!==row.idempotency_key)return 'unknown';
  try {if(new URL(result.url).protocol!=='https:'||!result.meetingId)return 'unknown';}catch{return 'unknown';}
  const r=await db.prepare(`UPDATE booking_meeting_links SET external_meeting_id=?,meeting_url=?,last_error_code=NULL,updated_at=?,
    status=CASE WHEN EXISTS (SELECT 1 FROM bookings b WHERE b.id=booking_id AND b.line_account_id=? AND b.status='confirmed'
      AND b.meeting_mode='online' AND b.meeting_url_source IS NOT 'manual' AND b.staff_id=? AND b.starts_at=? AND b.ends_at=?) THEN 'active' ELSE 'cancel_pending' END
    WHERE id=? AND status='pending' AND last_error_code IS ?`)
   .bind(result.meetingId,result.url,new Date().toISOString(),input.accountId,row.staff_id,row.starts_at,row.ends_at,row.id,row.last_error_code).run();
  return r.meta.changes===1?'verified':'unknown';
 }
 if(row.status==='cancel_pending'&&['delete_unknown','delete_started'].includes(row.last_error_code??'')&&row.external_meeting_id){
  if(row.last_error_code==='delete_started' && (Date.now()-Date.parse(row.updated_at)<60_000 || !Number.isFinite(Date.parse(row.updated_at)))) return 'unknown';
  const staffId=row.staff_id,meetingId=row.external_meeting_id;
  const result=await bounded(signal=>input.verifier.verifyDelete({staffId,meetingId,signal}));
  if(!result || result==='unknown')return 'unknown';
  const r=await db.prepare(`UPDATE booking_meeting_links SET status=?,last_error_code=?,updated_at=?
    WHERE id=? AND status='cancel_pending' AND last_error_code=?`)
   .bind(result==='deleted'?'cancelled':'cancel_pending',result==='deleted'?null:'delete_failed',new Date().toISOString(),row.id,row.last_error_code).run();
  return r.meta.changes===1?'verified':'unknown';
 }
 return 'not_found';
}
