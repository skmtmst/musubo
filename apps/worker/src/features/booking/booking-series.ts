import {calendarCredentialsForEnv} from './booking-outlook-busy-runtime.js';
import type {Env} from '../../worker-env.js';
import type {BookingRecurrence,SeriesInput,SeriesOccurrence} from '@line-crm/shared';
import {getAccountTimeZone,getAvailability,tzDateStr,tzHHMM} from '../../services/availability.js';
import {restaurantCivilTime} from '../../services/restaurant-booking.js';
import {assignBookingStaff} from './booking-assignment.js';
import {GapError} from '../../services/gap-common.js';
import {BOOKING_RESOURCE_CAPACITY_GUARD_SQL,bookingResourceGuardBindings} from './booking-resource-capacity.js';
import {STORE_CAPACITY_GUARD_SQL,STORE_SETTINGS_VERSION_GUARD_SQL} from './booking-store-capacity.js';
import {getStoreCapacitySnapshot} from '../../services/availability.js';
import {BOOKING_PERSON_LIMIT_GUARD_SQL,bookingPersonLimitBindings} from './booking-person-limit.js';
export function recurrenceDates(startsAt:string,rule:BookingRecurrence,tz:string):string[]{
 if(!rule||!['weekly','biweekly','monthly_nth'].includes(rule.freq)||!Number.isFinite(Date.parse(startsAt)))throw new GapError('invalid_recurrence');
 if(rule.count!==undefined&&(!Number.isInteger(rule.count)||rule.count<2||rule.count>52))throw new GapError('invalid_count');
 if(!rule.count&&!rule.until)throw new GapError('recurrence_end_required');
 if(rule.until&&(!/^\d{4}-\d{2}-\d{2}$/.test(rule.until)||!Number.isFinite(Date.parse(rule.until))))throw new GapError('invalid_until');
 const date=tzDateStr(tz,new Date(startsAt)),time=tzHHMM(tz,new Date(startsAt)),mins=Number(time.slice(0,2))*60+Number(time.slice(3)),base=new Date(`${date}T00:00:00Z`);
 const weekday=rule.weekday??base.getUTCDay(),nth=rule.nth??Math.ceil(base.getUTCDate()/7);
 if(!Number.isInteger(weekday)||weekday<0||weekday>6||!Number.isInteger(nth)||nth<1||nth>5)throw new GapError('invalid_recurrence');
 const out:string[]=[];
 for(let i=0;i<120&&out.length<(rule.count??52);i++){
  let d:Date;
  if(rule.freq==='monthly_nth'){
   d=new Date(Date.UTC(base.getUTCFullYear(),base.getUTCMonth()+i,1));
   const month=d.getUTCMonth();d.setUTCDate(1+(weekday-d.getUTCDay()+7)%7+7*(nth-1));if(d.getUTCMonth()!==month)continue;
  }else d=new Date(base.getTime()+i*(rule.freq==='weekly'?7:14)*86400000);
  const day=d.toISOString().slice(0,10);if(day<date)continue;if(rule.until&&day>rule.until)break;
  out.push(restaurantCivilTime(day,mins,tz));
 }
 if(out.length<2||(!rule.count&&out.length===52&&rule.until!<tzDateStr(tz,new Date(out[51]))))throw new GapError('invalid_recurrence_end');
 return out;
}
export async function previewSeries(db:D1Database,account:string,input:SeriesInput,env:Record<string,unknown>,excludeBookingId?:string,customerFacing=false):Promise<SeriesOccurrence[]>{
 const tz=await getAccountTimeZone(db,account),dates=recurrenceDates(input.startsAt,input.rule,tz);
 if(dates.some(d=>Date.parse(d)<Date.now()))throw new GapError('past_datetime');
 const availability=await getAvailability(db,{lineAccountId:account,menuId:input.menuId,staffId:input.staffId??undefined,from:tzDateStr(tz,new Date(dates[0])),to:tzDateStr(tz,new Date(dates.at(-1)!)),now:new Date(),minLeadTimeMinutes:customerFacing?60:0,applyStoreRules:customerFacing,excludeBookingId,forceCalendarRefresh:true,googleCredentials:calendarCredentialsForEnv(env as unknown as Env['Bindings'])});
 const actual=new Set((await db.prepare('SELECT id FROM staff WHERE line_account_id=? AND is_active=1 AND deleted_at IS NULL AND is_designation_optional=0').bind(account).all<{id:string}>()).results.map(r=>r.id));
 const out:SeriesOccurrence[]=[];
 for(let index=0;index<dates.length;index++){
  const startsAt=dates[index],candidates=availability.by_staff.filter(s=>actual.has(s.staff_id)&&s.slots.some(t=>Date.parse(t.startUtc!)===Date.parse(startsAt))).map(s=>s.staff_id);
  const staffId=input.staffId?(candidates.includes(input.staffId)?input.staffId:null):await assignBookingStaff(db,account,startsAt,tz,candidates);
  const alternatives=[...new Set(availability.by_staff.flatMap(s=>s.slots.filter(t=>t.date===tzDateStr(tz,new Date(startsAt))).map(t=>t.startUtc!)))].sort((a,b)=>Math.abs(Date.parse(a)-Date.parse(startsAt))-Math.abs(Date.parse(b)-Date.parse(startsAt))).slice(0,3);
  out.push({index,startsAt,available:!!staffId,staffId,reason:staffId?null:'slot_unavailable',alternatives});
 }
 return out;
}
export function assertChanged(db:D1Database){return db.prepare('INSERT INTO booking_batch_assertions(id,ok) VALUES(?,changes())').bind(crypto.randomUUID());}
export function clearAssertions(db:D1Database){return db.prepare('DELETE FROM booking_batch_assertions');}
export async function seriesInsert(db:D1Database,a:string,friend:string,menu:string,staff:string,start:string,id:string,series:string|null,index:number,actor:string,options:{status?:'confirmed'|'requested';groupId?:string;label?:string;addonDuration?:number;extraPrice?:number;policy?:unknown;meetingMode?:string}={}){
 const m=await db.prepare(`SELECT m.*,COALESCE(sm.override_duration_minutes,m.duration_minutes) dur,COALESCE(sm.override_price,m.base_price) price FROM menus m JOIN staff_menus sm ON sm.menu_id=m.id AND sm.staff_id=? AND sm.is_offered=1 JOIN staff s ON s.id=sm.staff_id AND s.line_account_id=m.line_account_id AND s.is_active=1 AND s.deleted_at IS NULL WHERE m.id=? AND m.line_account_id=? AND m.is_active=1 AND m.deleted_at IS NULL`).bind(staff,menu,a).first<{dur:number;buffer_after_minutes:number;price:number;version:number}>();
 if(!m)throw new GapError('menu_not_offered');
 m.dur+=options.addonDuration??0;m.price+=options.extraPrice??0;
 const end=new Date(Date.parse(start)+m.dur*60000).toISOString(),block=new Date(Date.parse(end)+m.buffer_after_minutes*60000).toISOString(),cap=await getStoreCapacitySnapshot(db,a,new Date(start),new Date(block));
 // 各回は既存の資源/店の定員/本人の上限と同じSQLを通る。0件ならbatch全体を戻す。
 const insert=db.prepare(`INSERT INTO bookings(id,line_account_id,friend_id,menu_id,staff_id,starts_at,ends_at,block_ends_at,status,price_at_booking,requested_at,decided_at,decided_by_staff_id,series_id,series_index,menu_version_number,menu_snapshot_json,group_id,group_index,person_label,policy_snapshot_json,meeting_mode)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM menus WHERE id=? AND version=? AND is_active=1)
 AND NOT EXISTS(SELECT 1 FROM bookings WHERE staff_id=? AND status IN('confirmed','requested') AND julianday(starts_at)<julianday(?) AND julianday(block_ends_at)>julianday(?))
 ${STORE_CAPACITY_GUARD_SQL} ${STORE_SETTINGS_VERSION_GUARD_SQL} ${BOOKING_RESOURCE_CAPACITY_GUARD_SQL} ${BOOKING_PERSON_LIMIT_GUARD_SQL}`)
 .bind(id,a,friend,menu,staff,start,end,block,options.status??'confirmed',m.price,new Date().toISOString(),options.status==='requested'?null:new Date().toISOString(),actor,series,index,m.version,JSON.stringify(m),options.groupId??null,options.groupId?index:null,options.label??null,options.policy?JSON.stringify(options.policy):null,options.meetingMode??'in_person',menu,m.version,staff,block,start,JSON.stringify(cap.windows),a,a,a,cap.settingsVersion,...bookingResourceGuardBindings({menuId:menu,lineAccountId:a,startsAt:start,blockEndsAt:block}),...bookingPersonLimitBindings(a,friend,null));
 const snapshot=db.prepare(`INSERT INTO booking_resource_consumptions(booking_id,line_account_id,resource_id,quantity,snapshot_source) SELECT ?,?,resource_id,quantity,'booking' FROM booking_menu_resources WHERE menu_id=?`).bind(id,a,menu);
 return [insert,assertChanged(db),snapshot];
}
