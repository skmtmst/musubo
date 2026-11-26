import { limitedDeliveryPlan } from '../features/broadcasts/broadcast-delivery-limit/index.js';
import { DELIVERY_CONSENT_ALLOWED_SQL } from '@line-crm/db/src/friend-delivery-consents.js';
import { buildSegmentWhere, type Broadcast, type SegmentCondition } from '@line-crm/db';


import { getBroadcastApprovalThreshold } from '../features/broadcasts/broadcast-approval/index.js';

/** 人数だけをSQLで集計する。本文・全宛先はWorkerへ読み出さない。 */
export async function sendAudienceCounts(db: D1Database, accountId: string, condition?: SegmentCondition) {
  const where = condition ? buildSegmentWhere(condition) : { sql: '1=1', bindings: [] };
  const row = await db.prepare(`SELECT COUNT(*) matched,
    COALESCE(SUM(NOT f.is_following),0) blocked,
    COALESCE(SUM(f.is_following=1 AND COALESCE(f.is_hidden,0)=1),0) hidden,
    COALESCE(SUM(f.is_following=1 AND COALESCE(f.is_hidden,0)=0 AND (f.line_platform_user_id IS NULL OR trim(f.line_platform_user_id)='')),0) missing,
    COALESCE(SUM(f.is_following=1 AND COALESCE(f.is_hidden,0)=0 AND trim(COALESCE(f.line_platform_user_id,''))!='' AND NOT (${DELIVERY_CONSENT_ALLOWED_SQL})),0) optedOut,
    COALESCE(SUM(f.is_following=1 AND COALESCE(f.is_hidden,0)=0 AND trim(COALESCE(f.line_platform_user_id,''))!='' AND (${DELIVERY_CONSENT_ALLOWED_SQL})),0) recipients
    FROM friends f WHERE f.line_account_id=? AND (${where.sql})`).bind(accountId, ...where.bindings)
    .first<{matched:number;blocked:number;hidden:number;missing:number;optedOut:number;recipients:number}>();
  if (!row) throw new Error('send_preview_unavailable');
  return {recipients:row.recipients, excluded:{blocked:row.blocked, optedOut:row.optedOut, duplicate:0, hidden:row.hidden, missingDestination:row.missing}};
}
export async function broadcastSendPreview(db: D1Database, broadcast: Broadcast) {
  if (!broadcast.line_account_id || !['all','tag','segment'].includes(broadcast.target_type)) throw new Error('unsupported_preview_target');
  const condition: SegmentCondition | undefined = broadcast.target_type==='tag'
    ? {operator:'AND',rules:[{type:'tag_exists',value:broadcast.target_tag_id!}]}
    : broadcast.target_type==='segment' ? JSON.parse(broadcast.segment_conditions!) : undefined;
  if (broadcast.target_type==='segment' && !condition?.rules) throw new Error('invalid_preview_conditions');
  const counts=await sendAudienceCounts(db,broadcast.line_account_id,condition);
  const limited=await limitedDeliveryPlan(db,broadcast,{requireConfirmation:false});
  const recipients=limited?.recipientCount??counts.recipients;
  return {...counts,recipients,...(limited?{deliveryLimit:{candidateCount:limited.candidateCount,recipientCount:recipients,random:true}}:{}),purpose:'marketing' as const,scheduledAt:broadcast.scheduled_at??null,quietHoursShiftTo:await broadcastQuietHoursShift(db,broadcast.line_account_id,broadcast.scheduled_at??new Date().toISOString()),
    needsApproval:(limited?.candidateCount??counts.recipients)>=await getBroadcastApprovalThreshold(db,broadcast),
    firstText:broadcast.message_content.slice(0,200),sender:null,expectedVersion:broadcast.lock_version??1,
    stoppable:!!limited||broadcast.target_type!=='all'};
}

/** 最初の版の一斉配信は宣伝。21〜8時は店舗の次の8時へ送る。 */
export async function broadcastQuietHoursShift(db:D1Database,accountId:string,at=new Date().toISOString()):Promise<string|null> {
 const row=await db.prepare('SELECT timezone FROM booking_settings WHERE line_account_id=?').bind(accountId).first<{timezone:string}>();
 const tz=row?.timezone??'Asia/Tokyo',ms=Date.parse(at);
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(ms).map(p=>[p.type,p.value]));
 if(+p.hour>=8&&+p.hour<21)return null;
 const desired=Date.UTC(+p.year,+p.month-1,+p.day+(+p.hour>=21?1:0),8);let guess=desired;
 for(let i=0;i<4;i++){const v=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(guess).map(p=>[p.type,p.value]));guess+=desired-Date.UTC(+v.year,+v.month-1,+v.day,+v.hour,+v.minute,+v.second);}
 return new Date(guess).toISOString();
}
