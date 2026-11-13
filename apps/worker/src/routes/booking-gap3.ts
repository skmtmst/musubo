import { liffBookingJson } from './liff-booking-response.js';
import {EntitlementError} from '../features/booking/booking-entitlements/index.js';
import {partyInput,previewParty,createBulkBooking} from '../features/booking/booking-bulk/index.js';
import {previewSeries,recurrenceDates} from '../features/booking/booking-series/index.js';
import {requirePermission} from '../middleware/role-guard.js';
import {Hono,type Context} from 'hono';
import type { Env } from '../worker-env.js';
import {GapError,gapAccount,gapBody,gapVersion,gapWrite} from '../services/gap-common.js';
import {depositRule,validDeposit,depositEstimate,cancellationCardRequired} from '../features/booking/booking-deposit/index.js';
import {resolveAccountIdFromLiff,verifyCallerLineUserId,resolveFriendId} from './booking.js';
import {bookingCancellationQuote,cancellationPolicy,cancellationQuote} from '../features/booking/booking-cancellation/index.js';
import {getAccountTimeZone} from '../services/availability.js';
import {bookingPaymentSelection} from '../features/booking/booking-payment-selection/index.js';
import {assertChanged,clearAssertions} from '../features/booking/booking-series/index.js';
export const bookingGap3=new Hono<Env>();
bookingGap3.use('/api/booking/admin/*',requirePermission('/booking/bookings'));
bookingGap3.onError((e,c)=>(c.req.path.startsWith('/api/liff/') ? liffBookingJson(c, {success:false,error:e instanceof GapError||e instanceof EntitlementError?e.code:'booking_unavailable'}, e instanceof GapError||e instanceof EntitlementError?e.status:503) : c.json({success:false,error:e instanceof GapError||e instanceof EntitlementError?e.code:'booking_unavailable'},e instanceof GapError||e instanceof EntitlementError?e.status:503)));
async function book(c:Context<Env>,a:string){const r=await c.env.DB.prepare('SELECT * FROM bookings WHERE id=? AND line_account_id=?').bind(c.req.param('id'),a).first<Record<string,unknown>>();if(!r)throw new GapError('not_found',404);return r;}
async function deposit(c:Context<Env>,menu=''){
 const a=await gapAccount(c);if(menu&&!await c.env.DB.prepare('SELECT id FROM menus WHERE id=? AND line_account_id=? AND deleted_at IS NULL').bind(menu,a).first())throw new GapError('not_found',404);
 if(c.req.method==='GET')return c.json({success:true,data:await depositRule(c.env.DB,a,menu)});
 gapWrite(c,{admin:true});const b=await gapBody(c),v=gapVersion(b.expectedVersion),rule=validDeposit(b);if(menu&&typeof b.inherit!=='boolean')throw new GapError('invalid_inherit');
 const r=await c.env.DB.prepare(`INSERT INTO booking_deposit_rules(account_id,scope_id,rule_json,inherit,updated_by,updated_at) SELECT ?,?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM booking_deposit_rules WHERE account_id=? AND scope_id=? AND version=?) ON CONFLICT(account_id,scope_id) DO UPDATE SET rule_json=excluded.rule_json,inherit=excluded.inherit,version=version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at WHERE version=?`).bind(a,menu,JSON.stringify(rule),menu&&b.inherit?1:0,c.get('staff').id,new Date().toISOString(),v,a,menu,v,v).run();if(!r.meta.changes)throw new GapError('version_conflict',409);
 return c.json({success:true,data:await depositRule(c.env.DB,a,menu)});
}
bookingGap3.on(['GET','PUT'],'/api/booking/admin/deposit-rules',c=>deposit(c));
bookingGap3.on(['GET','PUT'],'/api/booking/admin/menus/:id/deposit',c=>deposit(c,c.req.param('id')));
bookingGap3.on(['GET','PUT'],'/api/booking/admin/cancellation-options',async c=>{
 const a=await gapAccount(c);
 if(c.req.method==='PUT'){
 gapWrite(c,{admin:true});const b=await gapBody(c),v=gapVersion(b.expectedVersion);if(!['all','no_show_flagged','conditions'].includes(String(b.cardRequiredFor))||!['manual','auto'].includes(String(b.chargeMode)))throw new GapError('invalid_cancellation_options');
 if(b.cardRequiredFor==='conditions')throw new GapError('custom_card_conditions_not_available',409);
 if(b.chargeMode==='auto')throw new GapError('automatic_charge_not_available',409);
 const r=await c.env.DB.prepare(`INSERT INTO booking_cancellation_options(account_id,card_required_for,charge_mode) SELECT ?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM booking_cancellation_options WHERE account_id=? AND version=?) ON CONFLICT(account_id) DO UPDATE SET card_required_for=excluded.card_required_for,charge_mode=excluded.charge_mode,version=version+1 WHERE version=?`).bind(a,b.cardRequiredFor,b.chargeMode,v,a,v,v).run();if(!r.meta.changes)throw new GapError('version_conflict',409);
 }
 const r=await c.env.DB.prepare('SELECT * FROM booking_cancellation_options WHERE account_id=?').bind(a).first<Record<string,unknown>>();return c.json({success:true,data:{cardRequiredFor:r?.card_required_for??'all',chargeMode:r?.charge_mode??'manual',version:r?.version??0,autoChargeAvailable:false}});
});
bookingGap3.get('/api/booking/admin/bookings/:id/payment-method',async c=>{
 const a=await gapAccount(c),b=await book(c,a);
 if(c.get('impersonation'))return c.json({success:true,data:null});
 const r=await c.env.DB.prepare("SELECT card_brand,card_last4,created_at FROM booking_payment_methods WHERE id=? AND friend_id=? AND line_account_id=? AND status='ready' LIMIT 1").bind(b.booking_payment_method_id??null,b.friend_id,a).first<{card_brand:string;card_last4:string;created_at:string}>();
 return c.json({success:true,data:r?{brand:r.card_brand,last4:r.card_last4,registeredAt:r.created_at}:null});
});
export async function groupView(db:D1Database,a:string,id:string){
 const g=await db.prepare('SELECT g.*,f.display_name FROM booking_groups g JOIN friends f ON f.id=g.friend_id AND f.line_account_id=g.line_account_id WHERE g.id=? AND g.line_account_id=?').bind(id,a).first<{id:string;display_name:string;version:number}>();if(!g)throw new GapError('not_found',404);
 const rows=(await db.prepare('SELECT b.*,m.name menu_name,s.name staff_name FROM bookings b JOIN menus m ON m.id=b.menu_id LEFT JOIN staff s ON s.id=b.staff_id WHERE b.group_id=? AND b.line_account_id=? ORDER BY b.group_index,b.id').bind(id,a).all<Record<string,unknown>>()).results;
 return {groupId:g.id,ownerName:g.display_name,version:g.version,members:rows.map(b=>({bookingId:b.id,personName:b.person_label,label:b.person_label,menuName:b.menu_name,staffName:b.staff_name,startsAt:b.starts_at,endsAt:b.ends_at,status:b.status,version:b.lock_version}))};
}
bookingGap3.get('/api/booking/admin/bookings/:id/group',async c=>{const a=await gapAccount(c),b=await book(c,a);return c.json({success:true,data:b.group_id?await groupView(c.env.DB,a,String(b.group_id)):null});});
bookingGap3.get('/api/booking/admin/bookings/:id/series',async c=>{
 const a=await gapAccount(c),b=await book(c,a);return c.json({success:true,data:b.series_id?{series:await c.env.DB.prepare('SELECT * FROM booking_series WHERE id=? AND line_account_id=?').bind(b.series_id,a).first(),bookings:(await c.env.DB.prepare('SELECT * FROM bookings WHERE series_id=? AND line_account_id=? ORDER BY series_index').bind(b.series_id,a).all()).results}:null});
});
async function cancelGroup(c:Context<Env>,id?:string){
 gapWrite(c);const a=await gapAccount(c),b=await gapBody(c);if(typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>500)throw new GapError('reason_required');
 const gid=id??String((await book(c,a)).group_id??'');if(!gid)throw new GapError('not_found',404);
 const g=await groupView(c.env.DB,a,gid),v=b.expectedVersion===undefined?g.version:gapVersion(b.expectedVersion);
 const expected=b.expectedMembers;
 if(expected!==undefined&&(!Array.isArray(expected)||expected.length>100||expected.some(m=>!m||typeof m!=='object'||typeof m.bookingId!=='string'||!m.bookingId||!Number.isSafeInteger(m.version)||m.version<0||typeof m.status!=='string')||new Set(expected.map(m=>m.bookingId)).size!==expected.length))throw new GapError('invalid_expected_members');
 const pending=g.members.filter(m=>['requested','confirmed'].includes(String(m.status)));
 const fees=await Promise.all(pending.map(async m=>({bookingId:m.bookingId,...await bookingCancellationQuote(c.env.DB,String(m.bookingId),a)})));
 const memberGuard=expected===undefined?'':` AND (SELECT COUNT(*) FROM bookings WHERE group_id=? AND line_account_id=?)=json_array_length(?)
   AND NOT EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.group_id=? AND b.line_account_id=? AND b.id=json_extract(e.value,'$.bookingId') AND b.lock_version=json_extract(e.value,'$.version') AND b.status=json_extract(e.value,'$.status')))`;
 const encoded=JSON.stringify(expected??[]);
 try{await c.env.DB.batch([c.env.DB.prepare(`UPDATE booking_groups SET version=version+1 WHERE id=? AND line_account_id=? AND version=?${memberGuard}`).bind(gid,a,v,...(expected===undefined?[]:[gid,a,encoded,encoded,gid,a])),assertChanged(c.env.DB),c.env.DB.prepare("UPDATE bookings SET confirmation_revision = confirmation_revision + 1, status='cancelled',cancellation_reason=?,lock_version=lock_version+1,decided_at=? WHERE group_id=? AND line_account_id=? AND status IN('confirmed','requested')").bind(b.reason,new Date().toISOString(),gid,a),clearAssertions(c.env.DB)]);}catch(e){if(/CHECK constraint/.test(String(e))){let current;try{current=await groupView(c.env.DB,a,gid);}catch(err){if(!(err instanceof GapError)||err.status!==404)throw err;current=null;}return c.json({success:false,error:'version_conflict',data:current},409);}throw e;}
 return c.json({success:true,data:{cancelled:pending.length,fees,version:v+1}});
}
bookingGap3.post('/api/booking/admin/bookings/:id/group/cancel',c=>cancelGroup(c));
bookingGap3.post('/api/booking/admin/groups/:id/cancel',c=>cancelGroup(c,c.req.param('id')));
bookingGap3.get('/api/liff/booking/cost-estimate',async c=>{
 const a=await resolveAccountIdFromLiff(c),u=await verifyCallerLineUserId(c);if(!a||!u)throw new GapError('unauthorized',401);const friend=await resolveFriendId(c,u,a);if(!friend)throw new GapError('not_found',404);
 const id=c.req.query('menu_id'),start=c.req.query('starts_at')??'',people=Number(c.req.query('party_size')??1);if(!Number.isFinite(Date.parse(start))||!Number.isInteger(people)||people<1||people>6)throw new GapError('invalid_booking');
 const staffId=c.req.query('staff_id');
 const m=await c.env.DB.prepare(`SELECT m.base_price,COALESCE(sm.override_price,m.base_price)+CASE WHEN s.is_designation_optional=0 THEN COALESCE(s.nomination_fee,0) ELSE 0 END price,
   CASE WHEN s.id IS NOT NULL THEN sm.is_offered END is_offered FROM menus m LEFT JOIN staff_menus sm ON sm.menu_id=m.id AND sm.staff_id=?
   LEFT JOIN staff s ON s.id=sm.staff_id AND s.line_account_id=m.line_account_id AND s.is_active=1 AND s.deleted_at IS NULL
   WHERE m.id=? AND m.line_account_id=? AND m.is_active=1 AND m.deleted_at IS NULL`)
   .bind(staffId??null,id,a).first<{base_price:number;price:number;is_offered:number|null}>();if(!m)throw new GapError('not_found',404);
 if(staffId&&m.is_offered!==1)return liffBookingJson(c, {success:false,error:'menu_not_offered'},422);
 const price=staffId?m.price:m.base_price,policy=await cancellationPolicy(c.env.DB,a);
 const payment=await bookingPaymentSelection(c.env.DB,a,String(id),friend);
 return liffBookingJson(c, {success:true,data:{cancellation:{...policy,price,...cancellationQuote(policy,start,price),cardRequired:await cancellationCardRequired(c.env.DB,a,friend)},deposit:await depositEstimate(c.env.DB,a,String(id),price,start,people,await getAccountTimeZone(c.env.DB,a)),payment:{mode:payment.config.mode,allowedMethods:payment.allowedMethods}}});
});

async function self(c:Context<Env>){const a=await resolveAccountIdFromLiff(c),u=await verifyCallerLineUserId(c,a??undefined);if(!a||!u)throw new GapError('unauthorized',401);const f=await resolveFriendId(c,u,a);if(!f)throw new GapError('not_found',404);return {a,f};}
bookingGap3.get('/api/liff/booking/group-availability',async c=>{
 const {a,f}=await self(c);let members:unknown;try{members=JSON.parse(c.req.query('members')??'null');}catch{throw new GapError('invalid_members');}
 return liffBookingJson(c, {success:true,data:await previewParty(c.env.DB,a,await partyInput(c.env.DB,a,f,members),c.req.query('startMode')??'parallel',c.req.query('from')??'',c.req.query('to')??c.req.query('from')??'',c.env)});
});
bookingGap3.post('/api/booking/admin/groups',async c=>{gapWrite(c);const a=await gapAccount(c),b=await gapBody(c);if(typeof b.friendId!=='string')throw new GapError('friend_id_required');return createBulkBooking(c,a,b.friendId,b,true);});
bookingGap3.on(['GET','POST'],'/api/liff/booking/series/preview',async c=>{
 const {a,f}=await self(c);let b:Record<string,unknown>;try{b=c.req.method==='POST'?await gapBody(c):{menuId:c.req.query('menuId')??c.req.query('menu_id'),startsAt:c.req.query('startsAt')??c.req.query('starts_at'),staffId:c.req.query('staffId')??c.req.query('staff_id'),rule:JSON.parse(c.req.query('rule')??'null')};}catch{throw new GapError('invalid_series');}
 const menuId=String(b.menuId??b.menu_id??''),startsAt=String(b.startsAt??b.starts_at??''),rule=(b.rule??b.recurrence) as import('@line-crm/shared').BookingRecurrence;
 const menu=await c.env.DB.prepare('SELECT customer_recurring_enabled,recurring_freqs_json,recurring_max_count FROM menus WHERE id=? AND line_account_id=? AND is_active=1 AND deleted_at IS NULL').bind(menuId,a).first<{customer_recurring_enabled:number;recurring_freqs_json:string;recurring_max_count:number}>();if(!menu||!rule||!menu.customer_recurring_enabled||!JSON.parse(menu.recurring_freqs_json).includes(rule.freq))throw new GapError('recurring_not_allowed');
 if(recurrenceDates(startsAt,rule,await getAccountTimeZone(c.env.DB,a)).length>Math.min(12,menu.recurring_max_count))throw new GapError('invalid_count');
 const {menuAudience}=await import('../features/booking/booking-audience/index.js');if(!(await menuAudience(c.env.DB,a,menuId,f)).visible)throw new GapError('menu_not_available',403);
 return liffBookingJson(c, {success:true,data:{occurrences:await previewSeries(c.env.DB,a,{menuId,friendId:f,staffId:typeof b.staffId==='string'?b.staffId:undefined,startsAt,rule},c.env,undefined,true)}});
});
bookingGap3.get('/api/booking/admin/meeting-capabilities',async c=>{await gapAccount(c);return c.json({success:true,data:{meetingTypes:['online','in_person','customer_choice'],providers:[{id:'google_meet',automatic:false},{id:'zoom',automatic:false},{id:'teams',automatic:false}],outlook:{available:false},manualMeetingUrl:true,reconnectGoogle:true}});});
