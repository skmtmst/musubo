import { externalBookingStripeObject } from '../features/booking/booking-stripe-webhooks/index.js';
import { liffBookingJson } from './liff-booking-response.js';
import {Hono,type Context} from 'hono';
import type { Env } from '../worker-env.js';
import {gapAccount,gapBody,gapKey,gapVersion,gapWrite,GapError} from '../services/gap-common.js';
import {startCardCheckout,chargeCancellation,refundCancellationCharge,cancellationPolicy,validCancellationPolicy,requireCancellationTestConnection,bookingCancellationQuote,bookingCancellationReview} from '../features/booking/booking-cancellation/index.js';
import {resolveAccountIdFromLiff,resolveFriendId,verifyCallerLineUserId} from './booking.js';
import {readBodyWithinLimit,isStripeTestEvent,verifyStripeSignature} from '../services/stripe-signature.js';
export const bookingCancellation=new Hono<Env>();
bookingCancellation.onError((e,c)=>(c.req.path.startsWith('/api/liff/') ? liffBookingJson(c, {success:false,error:e instanceof GapError?e.code:'cancellation_unavailable'}, e instanceof GapError?e.status:503) : c.json({success:false,error:e instanceof GapError?e.code:'cancellation_unavailable'},e instanceof GapError?e.status:503)));
async function liff(c:import('hono').Context<Env>){
 const account=await resolveAccountIdFromLiff(c),user=await verifyCallerLineUserId(c);
 if(!account||!user)throw new GapError('unauthorized',401);
 const friend=await resolveFriendId(c,user,account);if(!friend)throw new GapError('not_found',404);
 return {account,friend};
}
bookingCancellation.get('/api/booking/admin/cancellation-policy',async (c:Context<Env>):Promise<Response>=>{const account=await gapAccount(c);return c.json({success:true,data:await cancellationPolicy(c.env.DB,account)});});
bookingCancellation.put('/api/booking/admin/cancellation-policy',async (c:Context<Env>):Promise<Response>=>{
 gapWrite(c,{admin:true});const account=await gapAccount(c),b=await gapBody(c),v=gapVersion(b.expectedVersion);
 if(!validCancellationPolicy(b))throw new GapError('policy_gap');
 if(b.chargeMode!==undefined&&b.chargeMode!=='manual')throw new GapError('unsupported_charge_mode');
 if(b.enabled)await requireCancellationTestConnection(c.env.DB,account);
 const r=await c.env.DB.prepare(`INSERT INTO booking_cancellation_policies(line_account_id,enabled,tiers_json,no_show_percent,updated_by,updated_at)
  SELECT ?,?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM booking_cancellation_policies WHERE line_account_id=? AND version=?)
  ON CONFLICT(line_account_id) DO UPDATE SET enabled=excluded.enabled,tiers_json=excluded.tiers_json,no_show_percent=excluded.no_show_percent,
  version=version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at WHERE version=?`)
 .bind(account,b.enabled?1:0,JSON.stringify(b.tiers),b.noShowPercent,c.get('staff').id,new Date().toISOString(),v,account,v,v).run();
 if(!r.meta.changes)throw new GapError('version_conflict',409);
 return c.json({success:true,data:await cancellationPolicy(c.env.DB,account)});
});
bookingCancellation.get('/api/liff/booking/cancellation-quote',async (c:Context<Env>):Promise<Response>=>{
 const {account,friend}=await liff(c),id=c.req.query('booking_id');
 if(!id||!await c.env.DB.prepare('SELECT id FROM bookings WHERE id=? AND line_account_id=? AND friend_id=?').bind(id,account,friend).first())throw new GapError('not_found',404);
 return liffBookingJson(c, {success:true,data:await bookingCancellationReview(c.env.DB,id,account)});
});
bookingCancellation.post('/api/liff/booking/setup-intent',async (c:Context<Env>):Promise<Response>=>{
 const {account,friend}=await liff(c),key=gapKey(c),b=await gapBody(c);await requireCancellationTestConnection(c.env.DB,account);
 if(typeof b.menuId!=='string'||!await c.env.DB.prepare('SELECT id FROM menus WHERE id=? AND line_account_id=? AND is_active=1 AND deleted_at IS NULL').bind(b.menuId,account).first())throw new GapError('invalid_menu');
 if(b.policyAccepted!==true)throw new GapError('policy_acceptance_required');
 const data=await startCardCheckout(c.env,account,friend,key,b);
 return liffBookingJson(c,{success:true,data},201);
});
// 署名を検証した試験イベントだけが登録済みに進められる。クライアントの自己申告は受けない。
bookingCancellation.post('/api/liff/booking/setup-webhook',async (c:Context<Env>):Promise<Response>=>{
 const raw=await readBodyWithinLimit(c.req.raw),secret=c.env.STRIPE_TEST_WEBHOOK_SECRET;
 if(raw===null)return liffBookingJson(c,{success:false,error:'body_too_large'},413);
 if(!secret||!await verifyStripeSignature(secret,raw,c.req.header('stripe-signature')??''))throw new GapError('invalid_signature',401);
 let b:{account?:unknown;livemode?:unknown;type?:string;data?:{object?:{id?:string;customer?:string;payment_method?:string;status?:string}}};
 try{b=JSON.parse(raw);}catch{throw new GapError('invalid_event');}
 if(!isStripeTestEvent(b))throw new GapError('live_mode_not_approved',409);
 if(b.account!==undefined)throw new GapError('connect_webhook_required',409);
 const o=b.data?.object;
 if(b.type!=='setup_intent.succeeded'||o?.status!=='succeeded'||typeof o.id!=='string'||typeof o.customer!=='string'||typeof o.payment_method!=='string')throw new GapError('invalid_event');
 if(await externalBookingStripeObject(c.env.DB,o.id))throw new GapError('connect_webhook_required',409);
 await c.env.DB.prepare(`UPDATE booking_payment_methods SET status='ready',stripe_customer_id=?,stripe_payment_method_id=? WHERE setup_id=? AND test_mode=1 AND status='pending'`).bind(o.customer,o.payment_method,o.id).run();
 return liffBookingJson(c, {success:true});
});
bookingCancellation.get('/api/booking/admin/bookings/:id/charges',async (c:Context<Env>):Promise<Response>=>{
 const a=await gapAccount(c),id=c.req.param('id')!,quote=await bookingCancellationQuote(c.env.DB,id,a);
 const rows=(await c.env.DB.prepare(`SELECT c.*,r.idempotency_key refund_key,r.status refund_status,r.reason refund_reason
   FROM booking_charges c LEFT JOIN booking_charge_refund_requests r ON r.charge_id=c.id AND r.line_account_id=c.line_account_id
   WHERE c.booking_id=? AND c.line_account_id=? ORDER BY c.created_at,c.id`).bind(id,a).all()).results;
 return c.json({success:true,data:{charges:rows,quote,testMode:true}});
});
bookingCancellation.post('/api/booking/admin/bookings/:id/charges',async (c:Context<Env>):Promise<Response>=>{
 gapWrite(c);const account=await gapAccount(c),id=c.req.param('id')!,key=gapKey(c),b=await gapBody(c);
 if(!['cancellation_fee','no_show_fee'].includes(String(b.kind)))throw new GapError('invalid_kind');
 const result=await chargeCancellation(c.env,account,id,key,b,gapVersion(b.expectedVersion),c.get('staff').id);
 return c.json({success:true,data:result.row,replayed:result.replayed,testMode:true});
});
bookingCancellation.post('/api/booking/admin/charges/:id/waive',async (c:Context<Env>):Promise<Response>=>{
 gapWrite(c);const a=await gapAccount(c),b=await gapBody(c),v=gapVersion(b.expectedVersion);
 if(typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>500)throw new GapError('reason_required');
 const r=await c.env.DB.prepare(`UPDATE booking_charges SET status='waived',reason=?,actor_staff_id=?,version=version+1,updated_at=? WHERE id=? AND line_account_id=? AND status IN ('pending','failed') AND version=?`)
 .bind(b.reason.trim(),c.get('staff').id,new Date().toISOString(),c.req.param('id')!,a,v).run();
 if(!r.meta.changes)throw new GapError('version_conflict',409);
 return c.json({success:true,data:{id:c.req.param('id')!,status:'waived',version:v+1}});
});
bookingCancellation.post('/api/booking/admin/charges/:id/refund',async (c:Context<Env>):Promise<Response>=>{
 gapWrite(c,{admin:true});const account=await gapAccount(c),b=await gapBody(c),key=gapKey(c),v=gapVersion(b.expectedVersion);
 if(typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>500||b.confirmed!==true||b.confirmedIrreversible!==true)throw new GapError('refund_confirmation_required');
 const real=await c.env.DB.prepare('SELECT stripe_connected_account_id FROM booking_charges WHERE id=? AND line_account_id=?').bind(c.req.param('id')!,account).first<{stripe_connected_account_id:string|null}>();
 if(real?.stripe_connected_account_id) return c.json({success:true,data:await refundCancellationCharge(c.env,account,c.req.param('id')!,key,v,b.reason.trim(),c.get('staff').id),testMode:true,requestKey:key});
 await requireCancellationTestConnection(c.env.DB,account);
 const r=await c.env.DB.prepare(`UPDATE booking_charges SET status='refunded',reason=?,actor_staff_id=?,version=version+1,updated_at=? WHERE id=? AND line_account_id=? AND status='succeeded' AND version=? AND test_mode=1 AND stripe_connected_account_id IS NULL`)
 .bind(b.reason.trim(),c.get('staff').id,new Date().toISOString(),c.req.param('id')!,account,v).run();
 if(!r.meta.changes)throw new GapError('already_refunded',409);
 return c.json({success:true,data:{id:c.req.param('id')!,status:'refunded',version:v+1},testMode:true,requestKey:key});
});
