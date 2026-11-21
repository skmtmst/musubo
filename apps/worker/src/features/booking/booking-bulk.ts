import {verifyRoutingToken} from '../forms/form-routing/index.js';
import {depositEstimate,cancellationCardRequired} from './booking-deposit.js';
import type {Context} from 'hono';
import type { Env } from '../../worker-env.js';
import type {SeriesInput,BookingRecurrence} from '@line-crm/shared';
import {getBookingAdminSettings,resolveBookingPaymentConfig} from '@line-crm/db';
import {GapError,gapKey} from '../../services/gap-common.js';
import {getAvailability,getAccountTimeZone,tzDateStr} from '../../services/availability.js';
import {assignBookingStaff} from './booking-assignment.js';
import {bookingAddons,type BookingAddon} from './booking-addons.js';
import {menuAudience} from './booking-audience.js';
import {recurrenceDates,seriesInsert,clearAssertions} from './booking-series.js';
import {cancellationPolicy} from './booking-cancellation.js';
import {assertPassRequirement} from './booking-pass-plans.js';
import {entitlementUseStatement,validateEntitlementSelection} from './booking-entitlements.js';
export interface PartyInput {menuId:string;staffId?:string|null;addonIds?:string[];label?:string}
type PreparedMember=PartyInput&{addons:BookingAddon[];duration:number;buffer:number;version:number;price:number;meetingMode:string};
export async function partyInput(db:D1Database,a:string,f:string,value:unknown):Promise<PreparedMember[]>{
 if(!Array.isArray(value)||value.length<2||value.length>6)throw new GapError('invalid_members');
 const out:PreparedMember[]=[];
 for(const x of value){
 if(!x||typeof x!=='object'||typeof x.menuId!=='string'||x.staffId!=null&&typeof x.staffId!=='string'||x.label!==undefined&&(typeof x.label!=='string'||x.label.length>100))throw new GapError('invalid_members');
 const m=await db.prepare('SELECT duration_minutes,buffer_after_minutes,base_price,max_party_size,version,meeting_mode FROM menus WHERE id=? AND line_account_id=? AND is_active=1 AND deleted_at IS NULL AND addon_only=0').bind(x.menuId,a).first<{duration_minutes:number;buffer_after_minutes:number;base_price:number;max_party_size:number;version:number;meeting_mode:string}>();
 if(!m||m.max_party_size<value.length)throw new GapError('party_size_not_allowed');
 if(!(await menuAudience(db,a,x.menuId,f)).visible)throw new GapError('menu_not_available',403);
 const addons=await bookingAddons(db,a,x.menuId,x.addonIds,f);
 out.push({...x,addons,duration:m.duration_minutes+addons.reduce((n,r)=>n+r.duration_minutes,0),buffer:m.buffer_after_minutes,version:m.version,price:m.base_price+addons.reduce((n,r)=>n+r.base_price,0),meetingMode:m.meeting_mode});
 }
 return out;
}
/** 同じ枠を重複割当しないよう、公開前に各人の担当者と時間区間を確保する。 */
export async function previewParty(db:D1Database,a:string,members:PreparedMember[],startMode:unknown,from:string,to:string,env:Record<string,unknown>){
 if(!['parallel','sequential'].includes(String(startMode))||![from,to].every(x=>/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x)))||from>to||Date.parse(to)-Date.parse(from)>31*86400000)throw new GapError('invalid_party_range');
 const tz=await getAccountTimeZone(db,a),availability=await Promise.all(members.map(m=>getAvailability(db,{lineAccountId:a,menuId:m.menuId,staffId:m.staffId??undefined,from,to,minLeadTimeMinutes:60,now:new Date(),applyStoreRules:true,additionalDurationMinutes:m.addons.reduce((n,r)=>n+r.duration_minutes,0),forceCalendarRefresh:true,googleCredentials:{email:env.GOOGLE_SERVICE_ACCOUNT_EMAIL as string,privateKey:env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY as string}})));
 const starts=[...new Set(availability[0].by_staff.flatMap(s=>s.slots.map(t=>t.startUtc!)))].sort();
 const slots:Array<{startsAt:string;members:Array<{staffId:string;startsAt:string;endsAt:string}>}>=[];
 for(const start of starts){const chosen:Array<{staffId:string;startsAt:string;endsAt:string}>=[];let cursor=start;
 for(const [i,m]of members.entries()){
 const at=startMode==='sequential'?cursor:start;
 const candidates=availability[i].by_staff.filter(s=>s.slots.some(t=>Date.parse(t.startUtc!)===Date.parse(at))&&(!chosen.some(x=>x.staffId===s.staff_id&&Date.parse(x.startsAt)<Date.parse(at)+(m.duration+m.buffer)*60000&&Date.parse(x.endsAt)>Date.parse(at)))) .map(s=>s.staff_id);
 const forced=m.staffId??(startMode==='sequential'?chosen[0]?.staffId:undefined);
 const staff=forced?(candidates.includes(forced)?forced:null):await assignBookingStaff(db,a,at,tz,candidates);
 if(!staff)break;
 const specific=await db.prepare('SELECT COALESCE(override_duration_minutes,?) duration FROM staff_menus WHERE staff_id=? AND menu_id=? AND is_offered=1').bind(m.duration-m.addons.reduce((n,r)=>n+r.duration_minutes,0),staff,m.menuId).first<{duration:number}>();
 const duration=(specific?.duration??(m.duration-m.addons.reduce((n,r)=>n+r.duration_minutes,0)))+m.addons.reduce((n,r)=>n+r.duration_minutes,0);
 const end=new Date(Date.parse(at)+(duration+m.buffer)*60000).toISOString();chosen.push({staffId:staff,startsAt:at,endsAt:end});cursor=end;
 }
 if(chosen.length===members.length)slots.push({startsAt:start,members:chosen});
 }
 return {slots,timeZone:tz};
}
export async function createBulkBooking(c:Context<Env>,a:string,f:string,b:Record<string,unknown>,admin=false){
 const db=c.env.DB,key=gapKey(c),party=b.members!==undefined;
 if(party&&b.recurrence!==undefined)throw new GapError('cannot_combine_party_and_recurrence');
 if(b.party_size!==undefined&&b.party_size!==1)throw new GapError('unsupported_party_size');
 if(typeof b.starts_at!=='string'||!Number.isFinite(Date.parse(b.starts_at))||Date.parse(b.starts_at)<Date.now())throw new GapError('invalid_starts_at');
 if(!await db.prepare('SELECT id FROM friends WHERE id=? AND line_account_id=? AND is_following=1').bind(f,a).first())throw new GapError('cannot_book',403);
 if(b.payment_method!==undefined&&b.entitlement_id)throw new GapError('choose_entitlement_or_payment');
 if(b.waitlist_id!==undefined)throw new GapError('bulk_waitlist_not_available',409);
 const routingToken=b.routingToken??b.routing_token;
 if(routingToken!==undefined){
  const targets=party?(Array.isArray(b.members)?b.members:[]):[{menuId:b.menu_id,staffId:b.staff_id}];
  for(const member of targets){if(!member||typeof member.menuId!=='string')throw new GapError('invalid_members');
   const claim=await verifyRoutingToken(db,a,f,routingToken,member.menuId,member.staffId||undefined);
   if(claim.target.staffId){if(party)member.staffId=claim.target.staffId;else b.staff_id=claim.target.staffId;}
  }
 }
 const actor=admin?c.get('staff').id:`customer:${f}`,request=JSON.stringify(b),table=party?'booking_groups':'booking_series';
 const lookup=()=>party?db.prepare('SELECT id,request_json FROM booking_groups WHERE line_account_id=? AND friend_id=? AND idempotency_key=?').bind(a,f,key).first<{id:string;request_json:string}>():db.prepare('SELECT id,request_json FROM booking_series WHERE line_account_id=? AND created_by=? AND idempotency_key=?').bind(a,actor,key).first<{id:string;request_json:string}>();
 const response=async(id:string,replayed=false)=>{const rows=(await db.prepare(`SELECT id,menu_id,staff_id,starts_at,ends_at,status,price_at_booking FROM bookings WHERE ${party?'group_id':'series_id'}=? AND line_account_id=? ORDER BY ${party?'group_index':'series_index'}`).bind(id,a).all<Record<string,unknown>>()).results;return c.json({success:true,data:{...(party?{groupId:id}:{seriesId:id}),bookings:rows,total:rows.reduce((n,r)=>n+Number(r.price_at_booking),0),replayed,notificationsAvailable:false}},201);};
 const old=await lookup();if(old){if(old.request_json!==request)throw new GapError('idempotency_conflict',409);return response(old.id,true);}
 const tz=await getAccountTimeZone(db,a),policy=await cancellationPolicy(db,a),settings=await getBookingAdminSettings(db,a),id=crypto.randomUUID();
 let members:PreparedMember[],planned:Array<{member:PreparedMember;staffId:string;startsAt:string;index:number}>;
 if(party){
 members=await partyInput(db,a,f,b.members);const preview=await previewParty(db,a,members,b.startMode??'parallel',tzDateStr(tz,new Date(b.starts_at)),tzDateStr(tz,new Date(b.starts_at)),c.env);
 const slot=preview.slots.find(s=>Date.parse(s.startsAt)===Date.parse(String(b.starts_at)));if(!slot)throw new GapError('group_conflict',409);
 planned=slot.members.map((s,i)=>({...s,member:members[i],index:i}));
 }else{
 if(typeof b.menu_id!=='string')throw new GapError('menu_required');
 const menu=await db.prepare('SELECT * FROM menus WHERE id=? AND line_account_id=? AND is_active=1 AND deleted_at IS NULL').bind(b.menu_id,a).first<{customer_recurring_enabled:number;recurring_freqs_json:string;recurring_max_count:number;duration_minutes:number;buffer_after_minutes:number;base_price:number;version:number;meeting_mode:string}>();
 const rule=b.recurrence as BookingRecurrence;if(!menu||!rule||!menu.customer_recurring_enabled||!JSON.parse(menu.recurring_freqs_json).includes(rule.freq))throw new GapError('recurring_not_allowed');
 const dates=recurrenceDates(b.starts_at,rule,tz);if(dates.length>Math.min(12,menu.recurring_max_count))throw new GapError('invalid_count');
 if(!(await menuAudience(db,a,b.menu_id,f)).visible)throw new GapError('menu_not_available',403);
 const addons=await bookingAddons(db,a,b.menu_id,b.addonIds,f);
 const member:PreparedMember={menuId:b.menu_id,staffId:typeof b.staff_id==='string'?b.staff_id:null,addons,duration:menu.duration_minutes+addons.reduce((n,r)=>n+r.duration_minutes,0),buffer:menu.buffer_after_minutes,price:menu.base_price,version:menu.version,meetingMode:menu.meeting_mode};members=[member];
 const av=await getAvailability(db,{lineAccountId:a,menuId:member.menuId,staffId:member.staffId??undefined,from:tzDateStr(tz,new Date(dates[0])),to:tzDateStr(tz,new Date(dates.at(-1)!)),minLeadTimeMinutes:60,now:new Date(),applyStoreRules:true,additionalDurationMinutes:addons.reduce((n,r)=>n+r.duration_minutes,0),forceCalendarRefresh:true,googleCredentials:{email:c.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,privateKey:c.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY}});
 planned=[];for(const [index,start]of dates.entries()){
 const choice=Array.isArray(b.choices)?b.choices.find((x:{index:number})=>x.index===index):null;if(choice?.action==='skip')continue;
 const at=choice?.alternativeStartsAt??start;if(typeof at!=='string'||!Number.isFinite(Date.parse(at)))throw new GapError('invalid_choices');
 const candidates=av.by_staff.filter(s=>s.slots.some(t=>Date.parse(t.startUtc!)===Date.parse(at))).map(s=>s.staff_id),staff=member.staffId?(candidates.includes(member.staffId)?member.staffId:null):await assignBookingStaff(db,a,at,tz,candidates);
 if(!staff)throw new GapError('series_conflict',409);planned.push({member,staffId:staff,startsAt:at,index});
 }
 }
 if(!planned.length)throw new GapError('no_occurrences');
 // 決済や同伴者の取消料を黙って省略しないよう、対応する事業者アダプターがない処理は進めない。
 for(const [i,p]of planned.entries()){
 if(routingToken!==undefined){const claim=await verifyRoutingToken(db,a,f,routingToken,p.member.menuId,p.staffId);if(claim.target.meetingMode&&claim.target.meetingMode!==p.member.meetingMode)throw new GapError('routing_token_invalid');}
 const deposit=await depositEstimate(db,a,p.member.menuId,p.member.price,p.startsAt,party?members.length:1,tz);
 if(deposit.amount>0&&!(i===0&&b.entitlement_id))throw new GapError('deposit_collection_not_available',409);
 await assertPassRequirement(db,a,p.member.menuId,i===0?b.entitlement_id:undefined);
 const pay=await resolveBookingPaymentConfig(db,a,p.member.menuId);if(pay.mode==='online'&&!(i===0&&b.entitlement_id))throw new GapError('bulk_online_payment_not_available',409);
 if(policy.enabled&&!(i===0&&b.entitlement_id)){if(b.policyAccepted!==true||b.policyVersion!==policy.version)throw new GapError('policy_acceptance_required');if(await cancellationCardRequired(db,a,f))throw new GapError('bulk_cancellation_card_not_available',409);}
 if(p.member.meetingMode!=='in_person')throw new GapError('bulk_online_meeting_not_available',409);
 }
 const status=admin||settings?.approvalMode==='automatic'?'confirmed':'requested';
 const ops:D1PreparedStatement[]=[party?db.prepare('INSERT INTO booking_groups(id,line_account_id,friend_id,start_mode,created_at,idempotency_key,request_json) VALUES(?,?,?,?,?,?,?)').bind(id,a,f,b.startMode??'parallel',new Date().toISOString(),key,request):db.prepare("INSERT INTO booking_series(id,line_account_id,friend_id,menu_id,staff_policy,rule_json,created_by,created_at,idempotency_key,request_json) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(id,a,f,b.menu_id,b.staff_id?'same':'auto',JSON.stringify(b.recurrence),actor,new Date().toISOString(),key,request)];
 for(const [i,p]of planned.entries()){
 const bookingId=crypto.randomUUID(),extra=p.member.addons.reduce((n,r)=>n+r.base_price,0);
 const assignmentStaff=await db.prepare('SELECT is_designation_optional FROM staff WHERE id=? AND line_account_id=?').bind(p.staffId,a).first<{is_designation_optional:number}>();
 const assignmentMethod=assignmentStaff?.is_designation_optional===1?'unknown':routingToken!==undefined||!p.member.staffId?'automatic':admin?'manual':'designated';
 ops.push(...await seriesInsert(db,a,f,p.member.menuId,p.staffId,p.startsAt,bookingId,party?null:id,p.index,actor,{status,groupId:party?id:undefined,label:p.member.label,addonDuration:p.member.addons.reduce((n,r)=>n+r.duration_minutes,0),extraPrice:extra,policy,assignmentMethod}));
 for(const addon of p.member.addons)ops.push(db.prepare('INSERT INTO booking_addons(booking_id,addon_menu_id,duration_min,price_at_booking) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM menus WHERE id=? AND version=? AND is_active=1 AND deleted_at IS NULL)').bind(bookingId,addon.id,addon.duration_minutes,addon.base_price,addon.id,addon.version));
 if(i===0&&typeof b.entitlement_id==='string'){await validateEntitlementSelection(db,a,f,p.member.menuId,b.entitlement_id,p.startsAt);ops.push(entitlementUseStatement(db,bookingId,b.entitlement_id,p.startsAt,tz));}
 }
 ops.push(clearAssertions(db));try{await db.batch(ops);}catch(e){const saved=await lookup();if(saved){if(saved.request_json!==request)throw new GapError('idempotency_conflict',409);return response(saved.id,true);}if(/constraint|entitlement_|conflict/.test(String(e)))throw new GapError(party?'group_conflict':'series_conflict',409);throw e;}
 return response(id);
}
