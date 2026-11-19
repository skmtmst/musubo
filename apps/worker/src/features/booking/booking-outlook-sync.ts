import {calendarDirectionEnabled} from './calendar-switch-state.js';
import type {outlookCalendar} from './booking-outlook-calendar.js';

type Calendar=ReturnType<typeof outlookCalendar> & {accountId:string};
type EventRecord={eventId:string;accountId:string;staffId:string;startsAt:string;endsAt:string;generation?:number};
type Booking={status:string;staff_id:string;starts_at:string;ends_at:string;lock_version:number};
export async function notifyOutlookIssue(db:D1Database,input:{accountId:string;bookingId:string}):Promise<void>{
 await db.prepare(`INSERT OR IGNORE INTO notifications(id,event_type,title,body,channel,status,metadata,line_account_id,category)
  SELECT ?,'booking_outlook_issue','Outlook の確認が必要です','予約の予定を Outlook に反映できませんでした。連携と予定を確認してください。','dashboard','sent',?,line_account_id,'error' FROM bookings WHERE id=? AND line_account_id=?`)
  .bind(`outlook:${JSON.stringify([input.accountId,input.bookingId])}`,JSON.stringify({bookingId:input.bookingId}),input.bookingId,input.accountId).run();
}
type Snapshot={booking:Booking;transactionId:string;accountId:string;removeOnly?:boolean};
async function transactionId(scope:string,bookingId:string,booking:Booking,generation:number):Promise<string>{
 const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([scope,bookingId,booking.lock_version,booking.staff_id,generation]))));
 hash[6]=(hash[6]&15)|64;hash[8]=(hash[8]&63)|128;const x=Array.from(hash.slice(0,16),v=>v.toString(16).padStart(2,'0')).join('');
 return `${x.slice(0,8)}-${x.slice(8,12)}-${x.slice(12,16)}-${x.slice(16,20)}-${x.slice(20)}`;
}
export interface OutlookSyncDependencies {
 resolve(input:{accountId:string;bookingId:string;staffId:string;previous:boolean}):Promise<Calendar|null|'deferred'>;
 allowMutations:boolean;
 removeOnly?:boolean;
 authorizeRemoval?:()=>Promise<boolean>;
 now?:()=>number;
 /** 同期中に予約が変わった時、同じ要求内で追いつく回数を1回に制限する。 */
 followUp?:boolean;
}
/** 予約ごとに1つの台帳を使う。通信結果が不明な場合、外部書込みを自動再送しない。 */
export async function syncOutlookBooking(db:D1Database,input:{accountId:string;bookingId:string},deps:OutlookSyncDependencies):Promise<'done'|'skipped'|'failed'|'unknown'|'busy'> {
 let booking=await db.prepare('SELECT status,staff_id,starts_at,ends_at,lock_version FROM bookings WHERE id=? AND line_account_id=?')
  .bind(input.bookingId,input.accountId).first<Booking>();
 if(!booking)return 'skipped';
 const liveBooking=booking;
 const scope=`line:${input.accountId}`,kind='booking_outlook_sync',key='current',now=deps.now?.()??Date.now();
 const row=await db.prepare('SELECT status,result_json,input_json,lease_expires_at,next_attempt_at,attempt_count FROM workflow_steps WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key=?')
  .bind(scope,kind,input.bookingId,key).first<{status:string;result_json:string|null;input_json:string|null;lease_expires_at:number|null;next_attempt_at:number|null;attempt_count:number}>();
 let old:EventRecord|null=null,generation=0;
 try{if(row?.result_json){const data:unknown=JSON.parse(row.result_json);if(data&&typeof data==='object'&&!Array.isArray(data)){const item=data as Partial<EventRecord>;if(Number.isSafeInteger(item.generation)&&Number(item.generation)>=0)generation=Number(item.generation);if(typeof item.eventId==='string'&&typeof item.accountId==='string'&&typeof item.staffId==='string'&&typeof item.startsAt==='string'&&typeof item.endsAt==='string')old=item as EventRecord;}}}catch{return 'unknown';}
 let snapshot:Snapshot|null=null;
 if(row?.status==='failed'){
  let failedVersion:number|null=null;
  try{failedVersion=(JSON.parse(row.input_json??'null') as Snapshot|null)?.booking?.lock_version??null;}catch{/* 不明なら運用者が確認する */}
  if(failedVersion===null||failedVersion===booking.lock_version){await notifyOutlookIssue(db,input);return 'failed';}
 }
 if(row?.status==='unknown') {
  if(!row.input_json){await notifyOutlookIssue(db,input);return 'unknown';}
  let preliminary:Snapshot|null=null;try{preliminary=JSON.parse(row.input_json) as Snapshot;}catch{await notifyOutlookIssue(db,input);return 'unknown';}
  if(preliminary?.removeOnly&&!deps.removeOnly){
   if((row.next_attempt_at??0)>now)return 'busy';
   const waitForVerification=async()=>{
    await db.prepare("UPDATE workflow_steps SET next_attempt_at=?,updated_at=? WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key=? AND status='unknown' AND input_json=?")
     .bind(now+300000,now,scope,kind,input.bookingId,key,row.input_json).run();
    await notifyOutlookIssue(db,input);
   };
   if(!old){await waitForVerification();return 'unknown';}
   const reader=await deps.resolve({...input,staffId:old.staffId,previous:old.staffId!==liveBooking.staff_id});
   if(!reader||reader==='deferred'||reader.accountId!==old.accountId){await waitForVerification();return 'unknown';}
   const evidence=await reader.verify({staffId:old.staffId,accountId:old.accountId,eventId:old.eventId,signal:AbortSignal.timeout(8000)});
   if(evidence==='unknown'){await waitForVerification();return 'unknown';}
   if(evidence==='absent')generation++;
   const value=evidence==='present'?JSON.stringify({...old,generation}):JSON.stringify({generation});
   const saved=await db.prepare(`UPDATE workflow_steps SET status='succeeded',result_json=?,input_json=NULL,error_code=NULL,next_attempt_at=NULL,updated_at=?
    WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key=? AND status='unknown' AND input_json=? AND result_json IS ?`)
    .bind(value,now,scope,kind,input.bookingId,key,row.input_json,row.result_json).run();
   if(!saved.meta.changes)return 'busy';
   return syncOutlookBooking(db,input,{...deps,followUp:true});
  }
  if(row.attempt_count>=3){await notifyOutlookIssue(db,input);return 'unknown';}
  if((row.next_attempt_at??0)>now)return 'busy';
  try{snapshot=JSON.parse(row.input_json) as Snapshot;}catch{await notifyOutlookIssue(db,input);return 'unknown';}
  if(!!snapshot?.removeOnly!==!!deps.removeOnly){await notifyOutlookIssue(db,input);return 'unknown';}
  if(!snapshot?.booking||!snapshot.transactionId||!snapshot.accountId||typeof snapshot.booking.staff_id!=='string'||typeof snapshot.booking.status!=='string'||typeof snapshot.booking.starts_at!=='string'||typeof snapshot.booking.ends_at!=='string'||!Number.isSafeInteger(snapshot.booking.lock_version)){await notifyOutlookIssue(db,input);return 'unknown';}
  if((booking.lock_version!==snapshot.booking.lock_version||booking.status!==snapshot.booking.status)&&!deps.allowMutations){await notifyOutlookIssue(db,input);return 'unknown';}
  booking=snapshot.booking;
 }
 const active=booking.status==='confirmed'&&!deps.removeOnly;
 if(!old&&!active)return 'skipped';
 const needsMutation=!!old&&(!active||old.staffId!==booking.staff_id||old.startsAt!==booking.starts_at||old.endsAt!==booking.ends_at);
 if(needsMutation&&!deps.allowMutations)return 'skipped';
 if(needsMutation&&old&&!deps.removeOnly&&!await calendarDirectionEnabled(db,input.accountId,old.staffId,'write'))return 'skipped';
 if(deps.removeOnly&&(!deps.authorizeRemoval||!await deps.authorizeRemoval()))return 'skipped';
 if(active&&!await calendarDirectionEnabled(db,input.accountId,booking.staff_id,'write'))return 'skipped';

 if(row?.status==='running') {
  if(row.lease_expires_at!==null&&row.lease_expires_at<=now)await db.prepare("UPDATE workflow_steps SET status='unknown',lease_owner=NULL,lease_expires_at=NULL,error_code='outlook_result_unknown',next_attempt_at=updated_at+120000,updated_at=? WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key=? AND status='running' AND lease_expires_at<=?").bind(now,scope,kind,input.bookingId,key,now).run();
  return 'busy';
 }
 if(!needsMutation&&old)return 'done';
 const resolveStaff=old?.staffId??booking.staff_id;
 const calendar=await deps.resolve({...input,staffId:resolveStaff,previous:resolveStaff!==liveBooking.staff_id});
 if(calendar==='deferred'){
  await db.prepare(`INSERT OR IGNORE INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,max_attempts,created_at,updated_at)
   VALUES(?,?,?,?,'pending',?,3,?,?)`).bind(scope,kind,input.bookingId,key,`outlook:${input.bookingId}`,now,now).run();
  return 'busy';
 }
 if(!calendar){if(old||snapshot)await notifyOutlookIssue(db,input);return 'skipped';}
 if(snapshot&&calendar.accountId!==snapshot.accountId){
  await db.prepare("UPDATE workflow_steps SET error_code='outlook_account_changed',next_attempt_at=9007199254740991,updated_at=? WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key=? AND status='unknown' AND input_json=?").bind(now,scope,kind,input.bookingId,key,row?.input_json??null).run();
  await notifyOutlookIssue(db,input);return 'failed';
 }
 snapshot??={booking,transactionId:await transactionId(scope,input.bookingId,booking,generation),accountId:calendar.accountId,removeOnly:!!deps.removeOnly};
 await db.prepare(`INSERT OR IGNORE INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,max_attempts,created_at,updated_at)
  VALUES(?,?,?,?,'pending',?,3,?,?)`).bind(scope,kind,input.bookingId,key,`outlook:${input.bookingId}`,now,now).run();
 const lease=crypto.randomUUID();
 const claim=await db.prepare(`UPDATE workflow_steps SET status='running',lease_owner=?,lease_expires_at=?,updated_at=?,input_json=?,attempt_count=CASE WHEN status='unknown' THEN attempt_count+1 ELSE 1 END
  WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key=? AND status IN ('pending','succeeded','failed','unknown') AND (status!='unknown' OR (attempt_count<3 AND COALESCE(next_attempt_at,0)<=?))
   AND result_json IS ?`).bind(lease,now+60000,now,JSON.stringify(snapshot),scope,kind,input.bookingId,key,now,row?.result_json??null).run();
 if(!claim.meta.changes)return 'busy';
 const finish=async(status:'succeeded'|'pending'|'failed'|'unknown',record:EventRecord|null)=>{
  const result=await db.prepare(`UPDATE workflow_steps SET status=?,result_json=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?,error_code=?,next_attempt_at=?
   WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key=? AND status='running' AND lease_owner=?`)
   .bind(status,record?JSON.stringify({...record,generation}):(generation?JSON.stringify({generation}):null),deps.now?.()??Date.now(),status==='succeeded'||status==='pending'?null:'outlook_sync_unavailable',status==='unknown'?(deps.now?.()??Date.now())+120000:null,scope,kind,input.bookingId,key,lease).run();
  if(result.meta.changes&&status==='failed')await notifyOutlookIssue(db,input);
  if(result.meta.changes&&status==='unknown'){
   const attempts=await db.prepare('SELECT attempt_count FROM workflow_steps WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key=?').bind(scope,kind,input.bookingId,key).first<{attempt_count:number}>();
   if((attempts?.attempt_count??0)>=3)await notifyOutlookIssue(db,input);
  }
  return !!result.meta.changes;
 };
 const complete=async(record:EventRecord|null):Promise<'done'|'skipped'|'failed'|'unknown'|'busy'>=>{
  if(!await finish('succeeded',record))return 'unknown';
  if(row?.status==='unknown'&&!deps.followUp&&(liveBooking.lock_version!==booking.lock_version||liveBooking.status!==booking.status||liveBooking.staff_id!==booking.staff_id))
   return syncOutlookBooking(db,input,{...deps,followUp:true});
  return 'done';
 };
 try {
  const current=await db.prepare('SELECT lock_version,status,staff_id FROM bookings WHERE id=? AND line_account_id=?').bind(input.bookingId,input.accountId).first<Booking>();
  if(!current||(row?.status!=='unknown'&&(current.lock_version!==booking.lock_version||current.status!==booking.status||current.staff_id!==booking.staff_id))){await finish('pending',old);return 'busy';}
  let deletedPrevious=false;
  if(old&&needsMutation){
   const action=active&&old.staffId===booking.staff_id?'update':'delete';
   const outcome=await calendar.mutate({staffId:old.staffId,accountId:old.accountId,eventId:old.eventId,action,start:booking.starts_at,end:booking.ends_at,signal:AbortSignal.timeout(8000),authorize:deps.removeOnly?deps.authorizeRemoval:undefined});
   if(outcome!=='done'){
    if(deps.removeOnly&&deps.authorizeRemoval&&!await deps.authorizeRemoval()){await finish('succeeded',old);return 'skipped';}
    await finish(outcome==='unknown'?'unknown':'failed',old);return outcome;
   }
   if(action==='update'){const saved={...old,startsAt:booking.starts_at,endsAt:booking.ends_at};return await complete(saved);}
   old=null;generation++;deletedPrevious=true;
  }
  if(!active)return await complete(null);
  const target=resolveStaff===booking.staff_id?calendar:await deps.resolve({...input,staffId:booking.staff_id,previous:false});
  if(target==='deferred'){await finish('pending',null);return 'busy';}
  if(!target){await finish('failed',null);return 'failed';}
  if(deletedPrevious){
   snapshot={...snapshot,accountId:target.accountId,transactionId:await transactionId(scope,input.bookingId,booking,generation)};
   const saved=await db.prepare(`UPDATE workflow_steps SET result_json=?,input_json=? WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key=? AND status='running' AND lease_owner=?`)
    .bind(JSON.stringify({generation}),JSON.stringify(snapshot),scope,kind,input.bookingId,key,lease).run();
   if(!saved.meta.changes)return 'unknown';
  }
  const result=await target.create({staffId:booking.staff_id,calendarId:'primary',start:booking.starts_at,end:booking.ends_at,title:'予約',description:'管理画面で確認',transactionId:snapshot.transactionId,signal:AbortSignal.timeout(8000)});
  if(result.kind!=='created'||!result.accountId||result.accountId!==snapshot.accountId){const status=result.kind==='failed'?'failed':'unknown';await finish(status,null);return status;}
  return await complete({eventId:result.eventId,accountId:result.accountId,staffId:booking.staff_id,startsAt:booking.starts_at,endsAt:booking.ends_at});
 } catch {await finish('unknown',old);return 'unknown';}
}
