import type {MeetingCreator,MeetingProvider} from './booking-meeting-create.js';
import type {MeetingVerifier} from './booking-meeting-verify.js';

type Adapter=MeetingCreator & MeetingVerifier;
type Outcome='created'|'failed'|'unknown'|'in_progress'|'unavailable';
async function bounded<T>(run:(signal:AbortSignal)=>Promise<T>):Promise<T|null>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 try{return await Promise.race([run(controller.signal),new Promise<null>(resolve=>controller.signal.addEventListener('abort',()=>resolve(null),{once:true}))]);}catch{return null;}finally{clearTimeout(timer);}
}

/** 結果不明の行は絶対に送らない。確実に失敗した同じ会議だけを照合後に再送する。 */
export async function retryFailedMeeting(db:D1Database,input:{accountId:string;bookingId:string;requestKey:string;resolve:()=>Promise<Adapter|null>}):Promise<Outcome>{
 const row=await db.prepare(`SELECT l.id,l.provider,l.idempotency_key,l.staff_id,l.starts_at,l.ends_at,b.lock_version
  FROM booking_meeting_links l JOIN bookings b ON b.id=l.booking_id
  WHERE b.id=? AND b.line_account_id=? AND b.status='confirmed' AND b.meeting_mode='online' AND b.meeting_url_source IS NOT 'manual'
   AND l.status='failed' AND l.idempotency_key='booking-meeting:'||b.id||':'||b.lock_version
   AND l.staff_id=b.staff_id AND l.starts_at=b.starts_at AND l.ends_at=b.ends_at
   AND NOT EXISTS(SELECT 1 FROM booking_meeting_links current WHERE current.booking_id=b.id AND current.status IN ('pending','active'))
  ORDER BY l.created_at DESC,l.id DESC LIMIT 1`).bind(input.bookingId,input.accountId).first<{id:string;provider:MeetingProvider;idempotency_key:string;staff_id:string;starts_at:string;ends_at:string;lock_version:number}>();
 const scope=`line:${input.accountId}`,now=Date.now(),owner=crypto.randomUUID();
 const previous=await db.prepare("SELECT status,result_json FROM workflow_steps WHERE scope_id=? AND process_kind='booking_meeting_retry' AND subject_id=? AND step_key=?").bind(scope,input.bookingId,input.requestKey).first<{status:string;result_json:string|null}>();
 if(previous){try{return previous.result_json?JSON.parse(previous.result_json).outcome as Outcome:'in_progress';}catch{return 'unknown';}}
 if(!row)return 'unavailable';
 const adapter=await input.resolve();if(!adapter||adapter.provider!==row.provider)return 'unavailable';
 const claim=await db.prepare(`INSERT OR IGNORE INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,lease_owner,lease_expires_at,retry_key,created_at,updated_at)
  VALUES(?,'booking_meeting_retry',?,?,'running',?,?,?, ?,?)`).bind(scope,input.bookingId,input.requestKey,owner,now+60000,row.id,now,now).run();
 if(!claim.meta.changes)return 'in_progress';
 async function finish(outcome:Outcome):Promise<Outcome>{await db.prepare("UPDATE workflow_steps SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,result_json=?,updated_at=? WHERE scope_id=? AND process_kind='booking_meeting_retry' AND subject_id=? AND step_key=? AND lease_owner=?")
  .bind(JSON.stringify({outcome}),Date.now(),scope,input.bookingId,input.requestKey,owner).run();return outcome;}
 const verification=await bounded(signal=>adapter.verifyCreate({staffId:row.staff_id,idempotencyKey:row.idempotency_key,signal}));
 if(!verification||verification.kind!=='absent')return finish('unknown');
 const locked=await db.prepare(`UPDATE booking_meeting_links SET status='pending',last_error_code=NULL,attempt_count=1,updated_at=?
  WHERE id=? AND status='failed' AND NOT EXISTS(SELECT 1 FROM booking_meeting_links c WHERE c.booking_id=booking_meeting_links.booking_id AND c.status IN ('pending','active'))
   AND EXISTS(SELECT 1 FROM bookings b WHERE b.id=booking_meeting_links.booking_id AND b.line_account_id=? AND b.status='confirmed' AND b.meeting_mode='online' AND b.meeting_url_source IS NOT 'manual' AND b.lock_version=? AND b.staff_id=? AND b.starts_at=? AND b.ends_at=?)`)
  .bind(new Date().toISOString(),row.id,input.accountId,row.lock_version,row.staff_id,row.starts_at,row.ends_at).run();
 if(!locked.meta.changes)return finish('unavailable');
 const result=await bounded(signal=>adapter.create({bookingId:input.bookingId,idempotencyKey:row.idempotency_key,staffId:row.staff_id,startsAt:row.starts_at,endsAt:row.ends_at,signal}));
 if(!result||result.kind==='unknown'){await db.prepare("UPDATE booking_meeting_links SET last_error_code='result_unknown',updated_at=? WHERE id=? AND status='pending' AND last_error_code IS NULL").bind(new Date().toISOString(),row.id).run();return finish('unknown');}
 if(result.kind==='failed'){
  await db.prepare("UPDATE booking_meeting_links SET status='failed',last_error_code='provider_failure',updated_at=? WHERE id=? AND status='pending' AND last_error_code IS NULL").bind(new Date().toISOString(),row.id).run();return finish('failed');
 }
 try{const url=new URL(result.url);if(url.protocol!=='https:'||url.username||url.password||!result.meetingId)return finish('unknown');}catch{return finish('unknown');}
 const saved=await db.prepare(`UPDATE booking_meeting_links SET external_meeting_id=?,meeting_url=?,last_error_code=NULL,updated_at=?,
  status=CASE WHEN EXISTS(SELECT 1 FROM bookings b WHERE b.id=booking_id AND b.line_account_id=? AND b.status='confirmed' AND b.lock_version=?) THEN 'active' ELSE 'cancel_pending' END
  WHERE id=? AND status='pending' AND last_error_code IS NULL`).bind(result.meetingId,result.url,new Date().toISOString(),input.accountId,row.lock_version,row.id).run();
 if(!saved.meta.changes)return finish('unknown');
 const current=await db.prepare('SELECT status FROM booking_meeting_links WHERE id=?').bind(row.id).first<{status:string}>();
 return finish(current?.status==='active'?'created':'unknown');
}
