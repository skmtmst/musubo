import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import {Hono} from 'hono';
import type { Env } from '../worker-env.js';
import {requirePermission} from '../middleware/role-guard.js';
import {GapError,gapAccount,gapBody,gapVersion,gapWrite} from '../services/gap-common.js';
import {processPassNotices} from '../features/booking/booking-pass-notices/index.js';
export const bookingPassNotices=new Hono<Env>();
bookingPassNotices.use('/api/booking/admin/*',requirePermission('/booking/bookings'));
bookingPassNotices.onError((e,c)=>c.json({success:false,error:e instanceof GapError?e.code:'pass_notices_unavailable'},e instanceof GapError?e.status:503));
async function settings(db:D1Database,a:string,id:string,deliveryAvailable=false){
 const row=await db.prepare('SELECT notify_remaining_one,notify_expiry_14_days,version FROM booking_pass_plans WHERE id=? AND line_account_id=?').bind(id,a).first<{notify_remaining_one:number;notify_expiry_14_days:number;version:number}>();
 if(!row)throw new GapError('not_found',404);
 return {remainingOne:!!row.notify_remaining_one,expiry14Days:!!row.notify_expiry_14_days,version:row.version,testMode:true,deliveryAvailable};
}
bookingPassNotices.get('/api/booking/admin/pass-plans/:id/notice-settings',async c=>c.json({success:true,data:await settings(c.env.DB,await gapAccount(c),c.req.param('id'),c.env.DEPLOY_ENV==='staging'&&c.env.PASS_NOTICE_STAGING_DELIVERY_ENABLED==='true')}));
bookingPassNotices.put('/api/booking/admin/pass-plans/:id/notice-settings',async c=>{
 gapWrite(c,{admin:true});const a=await gapAccount(c),b=await gapBody(c),v=gapVersion(b.expectedVersion),id=c.req.param('id');
 if(typeof b.remainingOne!=='boolean'||typeof b.expiry14Days!=='boolean'||b.testMode!==true||Object.keys(b).some(k=>!['remainingOne','expiry14Days','expectedVersion','testMode'].includes(k)))throw new GapError('invalid_notice_settings');
 await settings(c.env.DB,a,id);
 const r=await c.env.DB.prepare('UPDATE booking_pass_plans SET notify_remaining_one=?,notify_expiry_14_days=?,version=version+1 WHERE id=? AND line_account_id=? AND version=?').bind(b.remainingOne?1:0,b.expiry14Days?1:0,id,a,v).run();
 if(!r.meta.changes)throw new GapError('version_conflict',409);
 return c.json({success:true,data:await settings(c.env.DB,a,id,c.env.DEPLOY_ENV==='staging'&&c.env.PASS_NOTICE_STAGING_DELIVERY_ENABLED==='true')});
});
bookingPassNotices.get('/api/booking/admin/pass-notices',async c=>{
 const a=await gapAccount(c),offset=parseOffsetPaging({ offset: c.req.query('offset') }, { offsetPolicy: {} }).offset,limit=parseOffsetPaging({ limit: c.req.query('limit') }, { defaultLimit: 20, limitPolicy: {} }).limit,plan=c.req.query('planId');
 if(!Number.isSafeInteger(offset)||offset<0||![10,20,50].includes(limit))throw new GapError('invalid_pagination');
 const where='line_account_id=? AND (? IS NULL OR plan_id=?)',binds=[a,plan??null,plan??null];
 const items=(await c.env.DB.prepare(`SELECT id,entitlement_id entitlementId,plan_id planId,kind,purpose,messages_json,scheduled_at scheduledAt,
 CASE WHEN EXISTS(SELECT 1 FROM outbound_send_requests o WHERE o.resource_id='pass-notice:'||booking_entitlement_notices.id AND o.status='succeeded') THEN 'sent'
 WHEN EXISTS(SELECT 1 FROM outbound_send_requests o WHERE o.resource_id='pass-notice:'||booking_entitlement_notices.id AND o.status IN ('in_progress','unknown')) THEN 'delivery_unknown'
 WHEN EXISTS(SELECT 1 FROM outbound_send_requests o WHERE o.resource_id='pass-notice:'||booking_entitlement_notices.id AND o.status='failed' AND COALESCE(o.failure_code,'')!='NOTIFICATION_PRECONDITION_CHANGED') THEN 'delivery_failed' ELSE status END status,
 processed_at processedAt,test_mode testMode FROM booking_entitlement_notices WHERE ${where} ORDER BY scheduled_at DESC,id LIMIT ? OFFSET ?`).bind(...binds,limit,offset).all<{messages_json:string;status:string}>()).results.map(({messages_json,...r})=>({...r,messages:JSON.parse(messages_json)}));
 const total=await c.env.DB.prepare(`SELECT count(*) n FROM booking_entitlement_notices WHERE ${where}`).bind(...binds).first<{n:number}>();
 return c.json({success:true,data:buildOffsetListResponse({ items,total:total?.n??0,sent:items.some(item=>item.status==='sent'),testMode:true, paging: { limit, offset }, sort: [{ field: 'scheduledAt', direction: 'desc' }, { field: 'id', direction: 'asc' }] })});
});
bookingPassNotices.post('/api/booking/admin/pass-notices/simulate',async c=>{
 gapWrite(c,{admin:true});const a=await gapAccount(c),b=await gapBody(c);if(b.testMode!==true)throw new GapError('test_mode_required');
 return c.json({success:true,data:await processPassNotices(c.env.DB,new Date(),a)});
});
