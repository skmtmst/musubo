import {getStoreCapacitySnapshot} from '../services/availability.js';
import {STORE_CAPACITY_GUARD_EXCLUDE_SQL,STORE_SETTINGS_VERSION_GUARD_SQL} from '../features/booking/booking-store-capacity/index.js';
import {BOOKING_RESOURCE_CAPACITY_GUARD_EXCLUDE_SQL,bookingResourceGuardExcludeBindings} from '../features/booking/booking-resource-capacity/index.js';
import {Hono,type Context} from 'hono';
import type { Env } from '../worker-env.js';
import type {SeriesInput,SeriesOccurrence} from '@line-crm/shared';
import {GapError,gapAccount,gapBody,gapKey,gapVersion,gapWrite} from '../services/gap-common.js';
import {previewSeries,seriesInsert,assertChanged,clearAssertions} from '../features/booking/booking-series/index.js';
import {bookingCancellationQuote} from '../features/booking/booking-cancellation/index.js';
export const bookingSeries=new Hono<Env>();
bookingSeries.onError((e,c)=>c.json({success:false,error:e instanceof GapError?e.code:'series_unavailable'},e instanceof GapError?e.status:503));
async function seriesPermission(c:Context<Env>,next:()=>Promise<void>){
 const staff=c.get('staff'),view=['GET','HEAD'].includes(c.req.method)||c.req.method==='POST'&&(c.req.path.endsWith('/preview')||c.req.path.endsWith('/impact'));
 if(!staff||!(['owner','admin'].includes(staff.role)||staff.permissionKeys?.includes('/booking/bookings')||view&&staff.viewPermissionKeys?.includes('/booking/bookings')))throw new GapError('forbidden',403);
 await next();
}
bookingSeries.use('/api/booking/admin/series/*',seriesPermission);
bookingSeries.use('/api/booking/admin/series',seriesPermission);
function input(b:Record<string,unknown>):SeriesInput{
 if(typeof b.menuId!=='string'||typeof b.friendId!=='string'||typeof b.startsAt!=='string'||!b.rule||typeof b.rule!=='object'||(b.staffId!==undefined&&b.staffId!==null&&typeof b.staffId!=='string'))throw new GapError('invalid_series');
 const v=b as unknown as SeriesInput;
 if(v.choices&&(!Array.isArray(v.choices)||v.choices.length>52||new Set(v.choices.map(x=>x.index)).size!==v.choices.length||v.choices.some(x=>!Number.isInteger(x.index)||x.index<0||!['keep','skip'].includes(x.action)||(x.alternativeStartsAt!==undefined&&!Number.isFinite(Date.parse(x.alternativeStartsAt))))))throw new GapError('invalid_choices');
 return v;
}
async function checkFriend(c:Context<Env>,a:string,f:string){if(!await c.env.DB.prepare('SELECT id FROM friends WHERE id=? AND line_account_id=?').bind(f,a).first())throw new GapError('friend_not_found',404);}
bookingSeries.post('/api/booking/admin/series/preview',async(c)=>{
 const a=await gapAccount(c),b=input(await gapBody(c));await checkFriend(c,a,b.friendId);
 return c.json({success:true,data:{occurrences:await previewSeries(c.env.DB,a,b,c.env)}});
});
bookingSeries.get('/api/booking/admin/series/:id',async(c)=>{
 const a=await gapAccount(c),series=await c.env.DB.prepare('SELECT * FROM booking_series WHERE id=? AND line_account_id=?').bind(c.req.param('id'),a).first();
 if(!series)throw new GapError('not_found',404);
 return c.json({success:true,data:{series,bookings:(await c.env.DB.prepare('SELECT * FROM bookings WHERE series_id=? AND line_account_id=? ORDER BY series_index').bind(c.req.param('id'),a).all()).results}});
});
bookingSeries.post('/api/booking/admin/series',async(c)=>{
 gapWrite(c);const a=await gapAccount(c),b=input(await gapBody(c)),key=gapKey(c),actor=c.get('staff').id;await checkFriend(c,a,b.friendId);
 const load=()=>c.env.DB.prepare('SELECT * FROM booking_series WHERE line_account_id=? AND created_by=? AND idempotency_key=?').bind(a,actor,key).first<{id:string;request_json:string}>();
 const replay=async(s:{id:string;request_json:string})=>{if(s.request_json!==JSON.stringify(b))throw new GapError('idempotency_conflict',409);return c.json({success:true,data:{series:s,bookings:(await c.env.DB.prepare('SELECT * FROM bookings WHERE series_id=?').bind(s.id).all()).results},replayed:true},201);};
 const existing=await load();if(existing)return replay(existing);
 const occurrences=await previewSeries(c.env.DB,a,b,c.env),chosen:SeriesOccurrence[]=[];
 for(const o of occurrences){const choice=b.choices?.find(x=>x.index===o.index);if(choice?.action==='skip')continue;
  if(choice?.alternativeStartsAt){const alt=await previewSeries(c.env.DB,a,{...b,startsAt:choice.alternativeStartsAt,rule:{freq:'weekly',count:2}},c.env);chosen.push({...alt[0],index:o.index});}else chosen.push(o);
 }
 const conflicts=chosen.filter(x=>!x.available);if(conflicts.length)return c.json({success:false,error:'series_conflict',conflicts},409);
 if(!chosen.length)throw new GapError('no_occurrences');
 const id=crypto.randomUUID(),statements=[c.env.DB.prepare(`INSERT INTO booking_series(id,line_account_id,friend_id,menu_id,staff_policy,rule_json,created_by,created_at,idempotency_key,request_json) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(id,a,b.friendId,b.menuId,b.staffId?'same':'auto',JSON.stringify(b.rule),actor,new Date().toISOString(),key,JSON.stringify(b))];
 for(const o of chosen)statements.push(...await seriesInsert(c.env.DB,a,b.friendId,b.menuId,o.staffId!,o.startsAt,crypto.randomUUID(),id,o.index,actor));statements.push(clearAssertions(c.env.DB));
 try{await c.env.DB.batch(statements);}catch(e){const saved=await load();if(saved)return replay(saved);if(/CHECK constraint|UNIQUE constraint/.test(String(e)))throw new GapError('series_conflict',409);throw e;}
 return c.json({success:true,data:{series:await c.env.DB.prepare('SELECT * FROM booking_series WHERE id=?').bind(id).first(),bookings:(await c.env.DB.prepare('SELECT * FROM bookings WHERE series_id=? ORDER BY series_index').bind(id).all()).results,skipped:occurrences.filter(x=>!chosen.some(y=>x.index===y.index))}},201);
});
async function selection(c:Context<Env>,a:string,b:Record<string,unknown>){
 const id=c.req.param('id')!,version=gapVersion(b.expectedVersion);
 if(!['this','following'].includes(String(b.scope))||typeof b.fromBookingId!=='string')throw new GapError('invalid_scope');
 const series=await c.env.DB.prepare('SELECT version FROM booking_series WHERE id=? AND line_account_id=?').bind(id,a).first<{version:number}>();if(!series)throw new GapError('not_found',404);if(series.version!==version)throw new GapError('version_conflict',409);
 const from=await c.env.DB.prepare('SELECT series_index FROM bookings WHERE id=? AND series_id=? AND line_account_id=?').bind(b.fromBookingId,id,a).first<{series_index:number}>();if(!from)throw new GapError('not_found',404);
 const rows=(await c.env.DB.prepare(`SELECT * FROM bookings WHERE series_id=? AND line_account_id=? AND series_index ${b.scope==='this'?'=':'>='} ? AND status IN('confirmed','requested') ORDER BY series_index`).bind(id,a,from.series_index).all<{id:string;staff_id:string;menu_id:string;friend_id:string;starts_at:string;ends_at:string;block_ends_at:string;price_at_booking:number;lock_version:number}>()).results;
 return {id,version,rows};
}
bookingSeries.post('/api/booking/admin/series/:id/cancel',async(c)=>{
 gapWrite(c);const a=await gapAccount(c),b=await gapBody(c),s=await selection(c,a,b),fees=[];
 for(const row of s.rows)fees.push({bookingId:row.id,...await bookingCancellationQuote(c.env.DB,row.id,a)});
 const statements=[c.env.DB.prepare('UPDATE booking_series SET version=version+1 WHERE id=? AND version=?').bind(s.id,s.version),assertChanged(c.env.DB)];
 for(const row of s.rows)statements.push(c.env.DB.prepare(`UPDATE bookings SET confirmation_revision = confirmation_revision + 1, status='cancelled',decided_at=?,lock_version=lock_version+1 WHERE id=? AND line_account_id=? AND lock_version=? AND status IN('confirmed','requested')`).bind(new Date().toISOString(),row.id,a,row.lock_version),assertChanged(c.env.DB));
 statements.push(c.env.DB.prepare("UPDATE booking_series SET status='cancelled' WHERE id=? AND NOT EXISTS(SELECT 1 FROM bookings WHERE series_id=? AND status IN('confirmed','requested'))").bind(s.id,s.id),clearAssertions(c.env.DB));
 try{await c.env.DB.batch(statements);}catch(e){if(/CHECK constraint/.test(String(e)))throw new GapError('version_conflict',409);throw e;}
 return c.json({success:true,data:{cancelled:s.rows.map(x=>x.id),fees,version:s.version+1}});
});
bookingSeries.patch('/api/booking/admin/series/:id',async(c)=>{
 gapWrite(c);const a=await gapAccount(c),b=await gapBody(c),s=await selection(c,a,b),change=b.change as {startsAt?:string;staffId?:string}|undefined;
 if(!change||(!change.startsAt&&!change.staffId)||(change.startsAt&&!Number.isFinite(Date.parse(change.startsAt))))throw new GapError('invalid_change');
 const delta=change.startsAt&&s.rows.length?Date.parse(change.startsAt)-Date.parse(s.rows[0].starts_at):0,changed:string[]=[],conflicts:string[]=[],planned:Array<{id:string;statement:D1PreparedStatement}>=[];
 for(const row of s.rows){
  const start=new Date(Date.parse(row.starts_at)+delta).toISOString(),staff=change.staffId??row.staff_id;
  const p=await previewSeries(c.env.DB,a,{friendId:row.friend_id,menuId:row.menu_id,staffId:staff,startsAt:start,rule:{freq:'weekly',count:2}},c.env,row.id);
  if(!p[0].available){conflicts.push(row.id);continue;}
  const end=new Date(Date.parse(row.ends_at)+delta).toISOString(),block=new Date(Date.parse(row.block_ends_at)+delta).toISOString(),cap=await getStoreCapacitySnapshot(c.env.DB,a,new Date(start),new Date(block));
  const statement=c.env.DB.prepare(`UPDATE bookings SET confirmation_revision = confirmation_revision + 1, starts_at=?,ends_at=?,block_ends_at=?,staff_id=?,lock_version=lock_version+1 WHERE id=? AND lock_version=? AND status IN('confirmed','requested') AND NOT EXISTS(SELECT 1 FROM bookings occupied WHERE occupied.id<>? AND occupied.staff_id=? AND occupied.status IN('confirmed','requested') AND julianday(occupied.starts_at)<julianday(?) AND julianday(occupied.block_ends_at)>julianday(?)) ${STORE_CAPACITY_GUARD_EXCLUDE_SQL} ${STORE_SETTINGS_VERSION_GUARD_SQL} ${BOOKING_RESOURCE_CAPACITY_GUARD_EXCLUDE_SQL}`).bind(start,end,block,staff,row.id,row.lock_version,row.id,staff,block,start,JSON.stringify(cap.windows),a,row.id,a,row.id,a,cap.settingsVersion,...bookingResourceGuardExcludeBindings({menuId:row.menu_id,lineAccountId:a,excludeBookingId:row.id,startsAt:start,blockEndsAt:block}));
  planned.push({id:row.id,statement});
 }
 // 組の版を1回だけ獲得し、同じ取引で範囲全体を変更する。競合した回は元のまま返す。
 try{
  const results=await c.env.DB.batch([c.env.DB.prepare('UPDATE booking_series SET version=version+1 WHERE id=? AND version=?').bind(s.id,s.version),assertChanged(c.env.DB),...planned.map(x=>x.statement),clearAssertions(c.env.DB)]);
  planned.forEach((p,index)=>{if(results[index+2].meta.changes)changed.push(p.id);else conflicts.push(p.id);});
 }catch(e){if(/CHECK constraint/.test(String(e)))throw new GapError('version_conflict',409);throw e;}
 return c.json({success:true,data:{changed,conflicts,version:s.version+1}});
});

bookingSeries.post('/api/booking/admin/series/:id/impact',async c=>{
 const a=await gapAccount(c),b=await gapBody(c);
 if(b.expectedVersion===undefined){const row=await c.env.DB.prepare('SELECT version FROM booking_series WHERE id=? AND line_account_id=?').bind(c.req.param('id'),a).first<{version:number}>();if(!row)throw new GapError('not_found',404);b.expectedVersion=row.version;}
 const s=await selection(c,a,b),change=b.change as {startsAt?:string}|undefined;
 if(change&&(!change.startsAt||!Number.isFinite(Date.parse(change.startsAt))))throw new GapError('invalid_change');
 const delta=change?.startsAt&&s.rows.length?Date.parse(change.startsAt)-Date.parse(s.rows[0].starts_at):null;
 const items=[];
 for(const row of s.rows){
  const after=delta===null?null:new Date(Date.parse(row.starts_at)+delta).toISOString();
  const preview=after?await previewSeries(c.env.DB,a,{friendId:row.friend_id,menuId:row.menu_id,staffId:row.staff_id,startsAt:after,rule:{freq:'weekly',count:2}},c.env,row.id):null;
  const fee=after?null:await bookingCancellationQuote(c.env.DB,row.id,a);
  items.push({bookingId:row.id,startsAt:row.starts_at,after,blocked:preview?!preview[0].available:false,fee:fee?{amount:fee.feeNow,percent:row.price_at_booking?Math.round(100*fee.feeNow/row.price_at_booking):0,reason:fee.text}:null});
 }
 return c.json({success:true,data:{items}});
});
