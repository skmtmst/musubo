import { logger } from '@line-crm/shared/server';
import { effectiveAnniversaryMonthDay, parseMonthDay, zonedWallTime } from '@line-crm/shared';
import { activeTenantLineAccountSql, parseScenarioVersionSteps, type ScenarioVersion } from '@line-crm/db';

import type { ScenarioSourceJob } from '../features/scenarios/source-job-types/index.js';

type Candidate=ScenarioVersion & {store_id:string;line_account_id:string;friend_id:string;line_uid:string;timezone:string;store_name:string;value:string;template_version:number;approved_version_id:string;live_step_id:string;offset_minutes:number;anniversary_time:string};
const anniversarySql=()=>`SELECT v.*,s.id store_id,s.line_account_id,s.name store_name,s.timezone,f.id friend_id,f.line_platform_user_id line_uid,
 ff.value,t.template_version,t.approved_version_id,b.step_id live_step_id,b.offset_minutes,b.anniversary_time
 FROM rt_store_followup_templates t JOIN rt_stores s ON s.id=t.store_id AND s.status='active'
 JOIN scenarios sc ON sc.id=t.scenario_id AND sc.line_account_id=s.line_account_id AND sc.current_published_version_id=t.approved_version_id
 JOIN scenario_versions v ON v.id=t.approved_version_id AND v.scenario_id=t.scenario_id AND v.status='published'
 JOIN rt_approval_requests a ON a.id=t.approval_id AND a.status='approved'
 JOIN rt_store_followup_step_bindings b ON b.store_id=s.id AND b.trigger='anniversary_before' AND b.enabled=1
 JOIN friends f ON f.line_account_id=s.line_account_id AND f.is_following=1 AND f.is_hidden=0
 JOIN friend_field_values ff ON ff.friend_id=f.id AND ff.field_id=(SELECT field_id FROM friend_fixed_fields WHERE fixed_key='anniversary')
 JOIN line_accounts la ON la.id=s.line_account_id AND la.is_active=1 AND la.archived_at IS NULL

 WHERE NOT EXISTS(SELECT 1 FROM rt_store_followup_targets ft WHERE ft.store_id=b.store_id AND ft.trigger=b.trigger AND ft.engine!='scenario') AND ${activeTenantLineAccountSql('la.id')} AND t.sending_status='active' AND json_extract(a.payload_json,'$.templateVersion')=t.template_version
 AND json_extract(a.payload_json,'$.scenarioVersionId')=t.approved_version_id AND json_extract(a.payload_json,'$.lineAccountId')=s.line_account_id`;

function localInstant(date:string,timeZone:string,time:string,offset:number) {
  return Date.parse(zonedWallTime(date,time,timeZone,offset/1440));
}

async function key(row:Candidate,date:string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([row.store_id,row.friend_id,date])))),x=>x.toString(16).padStart(2,'0')).join('');
}
function dates(row:Candidate,now:Date) {
  if (!Number.isSafeInteger(row.offset_minutes) || row.offset_minutes%1440!==0) { logger.warn('restaurant_followup.invalid_anniversary_day_offset'); return []; }
  const md=parseMonthDay(row.value); if(!md)return [];
  // 部分的な保存形式を読む処理でも、実在しない暦日は拒む。
  if(md.day>new Date(Date.UTC(2000,md.month,0)).getUTCDate())return [];
  const year=Number(new Intl.DateTimeFormat('en',{timeZone:row.timezone,year:'numeric'}).format(now));
  return [year,year+1].flatMap(y=>{
    const day=effectiveAnniversaryMonthDay(md.month,md.day,y,'feb28'); if(!day)return [];
    const date=`${y}-${day}`,at=localInstant(date,row.timezone,row.anniversary_time,row.offset_minutes);
    return [{date,at}];
  });
}
/** 共通の承認済みシナリオジョブ・再試行キー・権利・送信停止の検査を再利用する。 */
export async function scheduleRestaurantAnniversaries(db:D1Database,now=new Date()) {
  const rows=(await db.prepare(anniversarySql()).all<Candidate>()).results;
  for(const row of rows) for(const {date,at} of dates(row,now)) {
    if(at>now.getTime()||at<=now.getTime()-86400000)continue;
    const step=parseScenarioVersionSteps(row).find(s=>s.live_step_id===row.live_step_id&&!s.is_draft); if(!step)continue;
    const event=await key(row,date);
    if(await db.prepare(`SELECT 1 FROM scenario_source_jobs j JOIN scenario_versions old ON old.id=j.scenario_version_id
      WHERE j.source_kind='restaurant_anniversary' AND j.source_event_id=? AND j.attempt_count>0
      AND EXISTS(SELECT 1 FROM json_each(old.steps_snapshot) st WHERE json_extract(st.value,'$.version_step_id')=j.step_id AND json_extract(st.value,'$.live_step_id')=?)`).bind(event,row.live_step_id).first())continue;
    const retryKey=crypto.randomUUID();
    await db.prepare(`INSERT OR IGNORE INTO scenario_source_jobs(id,line_account_id,friend_id,scenario_version_id,step_id,source_kind,source_id,source_event_id,source_version,scheduled_at,idempotency_key)
      VALUES(?,?,?,?,?,'restaurant_anniversary',?,?,?,?,?)`).bind(crypto.randomUUID(),row.line_account_id,row.friend_id,row.id,step.id,row.store_id,event,row.template_version,new Date(at).toISOString(),retryKey).run();
  }
}
export async function restaurantAnniversaryState(db:D1Database,job:ScenarioSourceJob,now=new Date()) {
  const rows=(await db.prepare(anniversarySql()+' AND s.id=? AND f.id=? AND s.line_account_id=? AND v.id=? AND t.template_version=?').bind(job.source_id,job.friend_id,job.line_account_id,job.scenario_version_id,job.source_version).all<Candidate>()).results;
  for(const row of rows)for(const {date,at} of dates(row,now)) {
    const step=parseScenarioVersionSteps(row).find(s=>s.id===job.step_id&&s.live_step_id===row.live_step_id&&!s.is_draft);
    if(!step||await key(row,date)!==job.source_event_id||at!==Date.parse(job.scheduled_at))continue;
    return {store_id:row.store_id,trigger:'anniversary_before',template_version:row.template_version,timezone:row.timezone,approved_version_id:row.approved_version_id,
      store_name:row.store_name,line_uid:row.line_uid,event_payload:'{}',starts_at:new Date(localInstant(date,row.timezone,row.anniversary_time,0)).toISOString(),ends_at:new Date(localInstant(date,row.timezone,row.anniversary_time,0)).toISOString(),status:'confirmed',departed_at:null,customer_version:0,guest_count:0,course_name:null};
  }
  return null;
}
