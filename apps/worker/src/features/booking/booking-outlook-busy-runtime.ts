import {accountFeatureOffExclusionSql} from '@line-crm/db';
import type {Env} from '../../worker-env.js';
import {outlookCalendar} from './booking-outlook-calendar.js';
import {meetingAccessToken} from './booking-meeting-access.js';
import {cachedMeetingAccess} from './booking-meeting-credentials.js';
import {meetingOAuthConfig} from './booking-meeting-oauth-config.js';
import {cleanupOwnEventIds} from './booking-external-cleanup-busy.js';

type Input={lineAccountId:string;staffId:string;timeMin:string;timeMax:string};
/** 担当者本人の LINE 友だちが同一アカウントの試験送信先に含まれるか。 */
export async function outlookStaffIsTestRecipient(db:D1Database,input:{lineAccountId:string;staffId:string}):Promise<boolean>{
 const row=await db.prepare(`SELECT f.id friend_id,a.value FROM staff s JOIN staff_members m ON m.id=s.staff_member_id
  JOIN friends f ON f.line_user_id=m.line_user_id AND f.line_account_id=s.line_account_id
  JOIN account_settings a ON a.line_account_id=s.line_account_id AND a.key='test_recipients'
  WHERE s.id=? AND s.line_account_id=? AND s.deleted_at IS NULL AND m.is_active=1 LIMIT 1`).bind(input.staffId,input.lineAccountId).first<{friend_id:string;value:string}>();
 try{const recipients:unknown=JSON.parse(row?.value??'null');return !!row&&Array.isArray(recipients)&&recipients.includes(row.friend_id);}catch{return false;}
}
/** 予定の読み取りは検証環境で、試験送信先に本人が登録された担当者だけに限る。 */
export async function outlookBusyForStaff(env:Env['Bindings'],input:Input):Promise<Array<{start:string;end:string}>> {
 if(env.DEPLOY_ENV!=='staging'||env.BOOKING_MEETING_REAL_ENABLED!=='true'||!env.LINE_CREDENTIAL_ENCRYPTION_KEY)throw new Error('outlook_read_unavailable');
 const eligible=()=>outlookStaffIsTestRecipient(env.DB,input);
 if(!await eligible())throw new Error('outlook_test_staff_required');
 const config=meetingOAuthConfig(env,'outlook');if(!config)throw new Error('outlook_read_unavailable');
 const access=await meetingAccessToken(env.DB,{accountId:input.lineAccountId,staffId:input.staffId,provider:'outlook',encryptionKey:env.LINE_CREDENTIAL_ENCRYPTION_KEY,config,signal:new AbortController().signal});
 if(access.kind!=='ready')throw new Error('outlook_read_unavailable');
 const calendar=outlookCalendar(async staffId=>{
  if(staffId!==input.staffId||!await eligible())return null;
  const current=await cachedMeetingAccess(env.DB,{accountId:input.lineAccountId,staffId,provider:'outlook',encryptionKey:env.LINE_CREDENTIAL_ENCRYPTION_KEY!});
  return current?.connectionId===access.connectionId?{token:current.token,accountId:current.externalAccountId}:null;
 });
 const own=await env.DB.prepare(`SELECT json_extract(result_json,'$.eventId') id FROM workflow_steps
  WHERE scope_id=? AND process_kind='booking_outlook_sync' AND step_key='current' AND json_extract(result_json,'$.staffId')=?
  AND json_extract(result_json,'$.accountId')=? AND json_extract(result_json,'$.eventId') IS NOT NULL`)
  .bind(`line:${input.lineAccountId}`,input.staffId,access.externalAccountId).all<{id:string}>();
 const cleanup=await cleanupOwnEventIds(env.DB,{accountId:input.lineAccountId,staffId:input.staffId,provider:'outlook',externalAccountId:access.externalAccountId,encryptionKey:env.LINE_CREDENTIAL_ENCRYPTION_KEY});
 const busy=await calendar.busy({staffId:input.staffId,start:input.timeMin,end:input.timeMax,ownEventIds:[...(own.results??[]).map(row=>row.id),...cleanup],signal:AbortSignal.timeout(8000)});
 const intervals=busy.map(({start,end})=>({start,end}));const now=Date.now();
 const still=await env.DB.prepare("SELECT id FROM booking_meeting_connections WHERE id=? AND line_account_id=? AND staff_id=? AND provider='outlook' AND refresh_state='ready'")
  .bind(access.connectionId,input.lineAccountId,input.staffId).first();
 if(!still)throw new Error('outlook_read_unavailable');
 await env.DB.prepare(`INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,result_json,created_at,updated_at)
  VALUES(?,'booking_outlook_busy',?,'current','succeeded',?,?,?,?) ON CONFLICT(scope_id,process_kind,subject_id,step_key)
  DO UPDATE SET result_json=excluded.result_json,status='succeeded',updated_at=excluded.updated_at`)
  .bind(`line:${input.lineAccountId}`,input.staffId,`outlook-busy:${input.staffId}`,JSON.stringify({connectionId:access.connectionId,timeMin:input.timeMin,timeMax:input.timeMax,intervals}),now,now).run();
 return intervals;
}

/** 予約可能期間の空きを定期取得する。試験対象外の担当者には通信しない。 */
export async function refreshOutlookBusyCaches(env:Env['Bindings'],now=new Date()):Promise<number> {
 if(env.DEPLOY_ENV!=='staging'||env.BOOKING_MEETING_REAL_ENABLED!=='true'||!env.LINE_CREDENTIAL_ENCRYPTION_KEY||!meetingOAuthConfig(env,'outlook'))return 0;
 const {createFeatureJobGate}=await import('../../services/feature-enforcement.js');
 const gate=createFeatureJobGate();
 const rows=await env.DB.prepare(`SELECT c.line_account_id,c.staff_id,COALESCE(bs.booking_window_days,60) window_days FROM booking_meeting_connections c
  JOIN staff s ON s.id=c.staff_id AND s.line_account_id=c.line_account_id AND s.deleted_at IS NULL
  JOIN staff_members m ON m.id=s.staff_member_id JOIN friends f ON f.line_user_id=m.line_user_id AND f.line_account_id=s.line_account_id
  JOIN account_settings a ON a.line_account_id=c.line_account_id AND a.key='test_recipients'
  JOIN booking_calendar_switches store ON store.line_account_id=c.line_account_id AND store.scope_id='' AND store.read_enabled=1
  JOIN booking_calendar_switches member ON member.line_account_id=c.line_account_id AND member.scope_id=c.staff_id AND member.read_enabled=1
  LEFT JOIN booking_settings bs ON bs.line_account_id=c.line_account_id
  LEFT JOIN workflow_steps probe ON probe.scope_id='line:'||c.line_account_id AND probe.process_kind='booking_outlook_busy_probe' AND probe.subject_id=c.staff_id AND probe.step_key='current'
  WHERE c.provider='outlook' AND c.refresh_state!='unknown' AND m.is_active=1 AND NOT ${accountFeatureOffExclusionSql('c.line_account_id','booking')} AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(a.value) THEN a.value ELSE '[]' END) j WHERE j.value=f.id)
  GROUP BY c.line_account_id,c.staff_id ORDER BY COALESCE(probe.updated_at,0),c.staff_id LIMIT 50`).all<{line_account_id:string;staff_id:string;window_days:number}>();
 const list=rows.results??[];
 for(let i=0;i<list.length;i+=5)await Promise.allSettled(list.slice(i,i+5).map(async row=>{
  if(!await gate.canRun(env.DB,row.line_account_id,'booking','calendar busy cache and switch jobs'))return;
  try{await outlookBusyForStaff(env,{lineAccountId:row.line_account_id,staffId:row.staff_id,timeMin:new Date(now.getTime()-86400000).toISOString(),timeMax:new Date(now.getTime()+(Math.min(365,Math.max(1,row.window_days))+1)*86400000).toISOString()});}catch{/* 読めない場合は空き枠の入口で閉じる。 */}
  await env.DB.prepare(`INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,created_at,updated_at)
   VALUES(?,'booking_outlook_busy_probe',?,'current','succeeded',?,?,?) ON CONFLICT(scope_id,process_kind,subject_id,step_key) DO UPDATE SET updated_at=excluded.updated_at`)
   .bind(`line:${row.line_account_id}`,row.staff_id,`outlook-busy-probe:${row.staff_id}`,now.getTime(),now.getTime()).run();
 }));
 return rows.results?.length??0;
}

/** 既存の空き枠計算に Outlook の読み取りを渡す。 */
export function calendarCredentialsForEnv(env:Env['Bindings']) {
 return {email:env.GOOGLE_SERVICE_ACCOUNT_EMAIL,privateKey:env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  cleanupEventIds:(input:{lineAccountId:string;staffId:string;calendarId:string;connectionId:string})=>cleanupOwnEventIds(env.DB,{accountId:input.lineAccountId,staffId:input.staffId,provider:'google_calendar',calendarId:input.calendarId,connectionId:input.connectionId,encryptionKey:env.LINE_CREDENTIAL_ENCRYPTION_KEY}),
  outlookBusy:(input:Input)=>outlookBusyForStaff(env,input)};
}
