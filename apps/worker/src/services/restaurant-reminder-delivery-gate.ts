import { nextAnniversary, toJstParts, reservationInstant } from '@line-crm/shared';
import type { V6WriteGuard } from '@line-crm/db';
import { readFollowupEngineGate, type FollowupApprovalScope, type FollowupEngineGate } from './restaurant-followup-engine-approval.js';
import { readRestaurantBookingContext, type RestaurantBookingContext } from './restaurant-booking-context.js';

export type RestaurantReminderDeliveryGate = { allowed:false; reason:string } | {
  allowed:true; approval:Extract<FollowupEngineGate,{allowed:true}>;
  context:RestaurantBookingContext|null; guard:V6WriteGuard;
};

/** 保存済みの登録を読み、別予約・旧承認・旧日時のままでは送信しない。 */
export async function readRestaurantReminderDeliveryGate(db:D1Database,enrollmentId:string,known?:{
 reminderId:string;versionId:string;lineAccountId:string;sourceKind:string;scope:FollowupApprovalScope;
}):Promise<RestaurantReminderDeliveryGate>{
  if(known){
    const approval=await readFollowupEngineGate(db,{engine:'reminder',targetId:known.reminderId,lineAccountId:known.lineAccountId,versionId:known.versionId},known.scope);
    if(!approval.managed&&known.sourceKind!=='restaurant_reservation')return {allowed:true,approval,context:null,guard:{sql:'1',binds:[]}};
    if(!approval.allowed)return {allowed:false,reason:'restaurant_followup_not_approved'};
  }
  const row=await db.prepare(`SELECT fr.*,f.line_account_id FROM friend_reminders fr JOIN friends f ON f.id=fr.friend_id WHERE fr.id=?`)
    .bind(enrollmentId).first<{reminder_id:string;reminder_version_id:string|null;friend_id:string;line_account_id:string|null;
      target_date:string;source_kind:string;source_id:string|null;status:string;template_version_snapshot:string|null;timezone:string}>();
  if(!row)return {allowed:false,reason:'reminder_enrollment_not_found'};
  const approval=await readFollowupEngineGate(db,{engine:'reminder',targetId:row.reminder_id,
    lineAccountId:row.line_account_id??'',versionId:row.reminder_version_id??''},known?.scope);
  if(!approval.allowed)return {allowed:false,reason:'restaurant_followup_not_approved'};
  if(!approval.managed){
    return row.source_kind==='restaurant_reservation'
      ? {allowed:false,reason:'restaurant_followup_not_approved'}
      : {allowed:true,approval,context:null,guard:{sql:'1',binds:[]}};
  }
  let fingerprint:unknown;
  try{fingerprint=JSON.parse(row.template_version_snapshot??'{}').__source?.fingerprint;}catch{/* 不正な写しは許可しない。 */}
  if(row.status!=='active'||fingerprint!==approval.snapshot.contentHash)return {allowed:false,reason:'restaurant_followup_approval_changed'};
  const clauses=[approval.guard.sql],binds=[...approval.guard.binds];
  clauses.push(`EXISTS(SELECT 1 FROM friend_reminders WHERE id=? AND status='active' AND reminder_version_id=?
    AND target_date=? AND source_kind=? AND source_id IS ? AND template_version_snapshot IS ? AND timezone=?)`);
  binds.push(enrollmentId,row.reminder_version_id,row.target_date,row.source_kind,row.source_id,row.template_version_snapshot,row.timezone);
  let context:RestaurantBookingContext|null=null;
  if(row.source_kind==='restaurant_reservation'){
    if(!row.source_id||!row.line_account_id)return {allowed:false,reason:'restaurant_source_changed'};
    context=await readRestaurantBookingContext(db,{reservationId:row.source_id,lineAccountId:row.line_account_id,friendId:row.friend_id});
    if(!context||context.store_id!==approval.storeId||context.status!=='confirmed'||context.departed_at
      ||Date.parse(reservationInstant(context.starts_at))!==Date.parse(row.target_date)||context.timezone!==row.timezone)
      return {allowed:false,reason:'restaurant_source_changed'};
    clauses.push(`EXISTS(SELECT 1 FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id
      JOIN friends f ON f.line_account_id=s.line_account_id AND f.line_platform_user_id=r.line_uid
      WHERE r.id=? AND r.store_id=? AND r.customer_version=? AND r.starts_at=? AND r.ends_at=? AND r.guest_count=?
        AND r.status='confirmed' AND r.departed_at IS NULL AND s.status='active' AND s.line_account_id=?
        AND f.id=? AND f.is_following=1 AND f.is_hidden=0)`);
    binds.push(context.reservation_id,context.store_id,context.customer_version,context.starts_at,context.ends_at,context.guest_count,row.line_account_id,row.friend_id);
  }else{
    if(approval.trigger!=='anniversary_before')return {allowed:false,reason:'restaurant_source_changed'};
    const field=await db.prepare(`SELECT r.trigger_field_id,v.value,r.leap_year_policy FROM reminders r
      JOIN friend_field_values v ON v.field_id=r.trigger_field_id AND v.friend_id=?
      WHERE r.id=? AND r.trigger_type='friend_field' AND r.repeat_yearly=1
      AND r.trigger_field_id=(SELECT field_id FROM friend_fixed_fields WHERE fixed_key='anniversary')`)
      .bind(row.friend_id,row.reminder_id).first<{trigger_field_id:string;value:string;leap_year_policy:'feb28'|'mar1'|'skip'}>();
    const baseline=new Date(row.target_date);
    if(!field||!Number.isFinite(baseline.getTime())||nextAnniversary(field.value,baseline,field.leap_year_policy)!==toJstParts(baseline).date)
      return {allowed:false,reason:'restaurant_source_changed'};
    clauses.push('EXISTS(SELECT 1 FROM friend_field_values WHERE friend_id=? AND field_id=? AND value=?)');
    binds.push(row.friend_id,field.trigger_field_id,field.value);
  }
  return {allowed:true,approval,context,guard:{sql:clauses.map(sql=>`(${sql})`).join(' AND '),binds}};
}
