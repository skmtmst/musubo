import { liffBookingJson } from './liff-booking-response.js';
import {Hono,type Context} from 'hono';
import type { Env } from '../worker-env.js';
import {GapError,gapAccount,gapBody,gapKey,gapWrite} from '../services/gap-common.js';
import {MakeupSlotUnavailable,absence,expireMakeup,makeupRule,makeupOptions,useMakeup,extendMakeup} from '../features/booking/booking-makeup/index.js';
import {resolveAccountIdFromLiff,verifyCallerLineUserId,resolveFriendId} from './booking.js';
import {requirePermission} from '../middleware/role-guard.js';
export const bookingMakeup=new Hono<Env>();
bookingMakeup.onError((e,c)=>(c.req.path.startsWith('/api/liff/') ? liffBookingJson(c, {success:false,error:e instanceof GapError?e.code:'makeup_unavailable',...(e instanceof MakeupSlotUnavailable?{alternatives:e.alternatives}:{})}, e instanceof GapError?e.status:503) : c.json({success:false,error:e instanceof GapError?e.code:'makeup_unavailable'},e instanceof GapError?e.status:503)));
async function self(c:Context<Env>){const a=await resolveAccountIdFromLiff(c),u=await verifyCallerLineUserId(c);if(!a||!u)throw new GapError('unauthorized',401);const f=await resolveFriendId(c,u,a);if(!f)throw new GapError('not_found',404);return {a,f};}
bookingMakeup.put('/api/events/admin/:id/makeup-rule',requirePermission('/events'),async(c)=>{
 gapWrite(c,{admin:true});const a=await gapAccount(c),b=await gapBody(c),r=makeupRule(b.rule);
 if(!Number.isInteger(b.expectedRevision))throw new GapError('expected_revision_required');
 if(r.target==='list'&&(await c.env.DB.prepare('SELECT id FROM events WHERE line_account_id=? AND deleted_at IS NULL AND id IN(SELECT value FROM json_each(?))').bind(a,JSON.stringify([...new Set(r.targetIds)])).all()).results.length!==new Set(r.targetIds).size)throw new GapError('invalid_makeup_targets');
 const result=await c.env.DB.prepare('UPDATE events SET makeup_rule_json=?,version=version+1 WHERE id=? AND line_account_id=? AND version=? AND deleted_at IS NULL').bind(JSON.stringify(r),c.req.param('id'),a,b.expectedRevision).run();if(!result.meta.changes)throw new GapError('version_conflict',409);return c.json({success:true,data:{rule:r,revision:Number(b.expectedRevision)+1}});
});
bookingMakeup.post('/api/liff/events/bookings/:id/absence',async(c)=>{const {a,f}=await self(c);gapKey(c);return liffBookingJson(c, {success:true,data:await absence(c.env.DB,a,f,c.req.param('id'),'customer')});});
bookingMakeup.post('/api/events/admin/bookings/:id/absence',requirePermission('/events'),async(c)=>{
 gapWrite(c);const a=await gapAccount(c),b=await gapBody(c),row=await c.env.DB.prepare('SELECT friend_id FROM event_bookings WHERE id=? AND line_account_id=?').bind(c.req.param('id'),a).first<{friend_id:string}>();if(!row)throw new GapError('not_found',404);
 if(b.grantMakeup!==undefined&&typeof b.grantMakeup!=='boolean')throw new GapError('invalid_grant');if(b.reason!==undefined&&typeof b.reason!=='string')throw new GapError('invalid_reason');
 return c.json({success:true,data:await absence(c.env.DB,a,row.friend_id,c.req.param('id'),c.get('staff').id,b.grantMakeup as boolean|undefined,b.reason as string|undefined)});
});
bookingMakeup.get('/api/liff/events/makeup-credits',async(c)=>{const {a,f}=await self(c);await expireMakeup(c.env.DB);return liffBookingJson(c, {success:true,data:(await c.env.DB.prepare('SELECT * FROM booking_makeup_credits WHERE line_account_id=? AND friend_id=? ORDER BY expires_at,id').bind(a,f).all()).results});});
bookingMakeup.get('/api/booking/admin/makeup-credits',requirePermission('/booking/bookings'),async(c)=>{const a=await gapAccount(c),f=c.req.query('friend_id');if(!f)throw new GapError('friend_id_required');await expireMakeup(c.env.DB);return c.json({success:true,data:(await c.env.DB.prepare('SELECT * FROM booking_makeup_credits WHERE line_account_id=? AND friend_id=? ORDER BY expires_at,id').bind(a,f).all()).results});});
bookingMakeup.get('/api/liff/events/makeup-credits/:id/options',async(c)=>{const {a,f}=await self(c),from=c.req.query('from');if(from&&!/^\d{4}-\d{2}-\d{2}$/.test(from))throw new GapError('invalid_from');return liffBookingJson(c, {success:true,data:await makeupOptions(c.env.DB,a,f,c.req.param('id'),from)});});
bookingMakeup.post('/api/liff/events/makeup-credits/:id/use',async(c)=>{const {a,f}=await self(c),b=await gapBody(c),key=gapKey(c);if(typeof b.eventSlotId!=='string')throw new GapError('event_slot_required');return liffBookingJson(c, {success:true,data:await useMakeup(c.env.DB,a,f,c.req.param('id'),b.eventSlotId,key)},201);});

bookingMakeup.post('/api/booking/admin/makeup-credits/:id/operations',requirePermission('/booking/bookings'),async(c)=>{
 gapWrite(c);const staff=c.get('staff');if(!staff.tenantId||!['owner','admin'].includes(staff.role))throw new GapError('forbidden',403);
 const account=await gapAccount(c),body=await gapBody(c);return c.json({success:true,data:await extendMakeup(c.env.DB,account,c.req.param('id'),{id:staff.id,role:staff.role,tenantId:staff.tenantId},body)});
});
