import { isLineAccountTenantActive, activeTenantLineAccountSql } from '@line-crm/db';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { verifyCallerLineIdentity } from '../services/liff-auth.js';

export const liffNotificationPreferences=new Hono<Env>();
const purposes=[{purpose:'booking_reminders',label:'予約のお知らせ'},{purpose:'marketing',label:'宣伝・キャンペーン'}] as const;
type Consent={purpose:string;state:'granted'|'unknown'|'revoked';version:number;updatedAt:string};
async function preferences(db:D1Database,friend:{id:string;accountId:string}) {
 const stored=(await db.prepare(`SELECT purpose,state,version,updated_at AS updatedAt FROM friend_delivery_consents WHERE friend_id=? AND line_account_id=?`).bind(friend.id,friend.accountId).all<Consent>()).results;
 // 未記録を、受取への同意や0件として扱わない。削除後の古い画面も衝突させる。
 const history=(await db.prepare(`SELECT purpose,MAX(CAST(json_extract(COALESCE(after_json,before_json),'$.version') AS INTEGER)) version FROM friend_delivery_consent_events WHERE friend_id=? AND line_account_id=? GROUP BY purpose`).bind(friend.id,friend.accountId).all<{purpose:string;version:number}>()).results;
 return {items:purposes.map(p=>{const row=stored.find(r=>r.purpose===p.purpose);return {...p,state:row?.state??'unknown',enabled:row?.state==='granted'?true:row?.state==='revoked'?false:null,recorded:!!row,version:row?.version??history.find(h=>h.purpose===p.purpose)?.version??0,updatedAt:row?.updatedAt??null};}),purposeSpecificEnforcement:false,deliveryEnforcement:'any_non_granted_suppresses_automatic' as const};
}
liffNotificationPreferences.use('/api/liff/notification-preferences*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
async function caller(c:import('hono').Context<Env>) {
 const accountId=c.req.query('lineAccountId');
 if(!accountId||accountId.length>100)return {response:c.json({success:false,error:'アカウントを確認してください'},400)} as const;
 const identity=await verifyCallerLineIdentity(c.req.header('Authorization'),c.env,accountId);
 if(!identity||identity.lineAccountId!==accountId)return {response:c.json({success:false,error:'LINEでログインし直してください'},401)} as const;
 if(!await isLineAccountTenantActive(c.env.DB,accountId))return {response:c.json({success:false,error:'このアカウントは現在ご利用いただけません'},503)} as const;
 const friend=await c.env.DB.prepare(`SELECT f.id,f.line_account_id accountId FROM friends f JOIN line_accounts a ON a.id=f.line_account_id WHERE f.line_account_id=? AND f.line_platform_user_id=? AND a.is_active=1 AND a.archived_at IS NULL`).bind(accountId,identity.lineUserId).first<{id:string;accountId:string}>();
 if(!friend)return {response:c.json({success:false,error:'お客さまの登録が見つかりません'},404)} as const;
 return {friend} as const;
}
liffNotificationPreferences.onError((_e,c)=>c.json({success:false,error:'お知らせの設定を確認できません。もう一度お試しください'},503));
liffNotificationPreferences.get('/api/liff/notification-preferences',async c=>{
 const result=await caller(c);if(result.response)return result.response;
 return c.json({success:true,data:await preferences(c.env.DB,result.friend)});
});
liffNotificationPreferences.put('/api/liff/notification-preferences/:purpose',inputJsonBoundary({enabled:['boolean'],expectedVersion:['number']}),async c=>{
 const result=await caller(c);if(result.response)return result.response;
 const body=await c.req.json<Record<string,unknown>>(),purpose=c.req.param('purpose');
 if(!purposes.some(p=>p.purpose===purpose)||typeof body.enabled!=='boolean'||!Number.isSafeInteger(body.expectedVersion)||Number(body.expectedVersion)<0||Object.keys(body).some(k=>!['enabled','expectedVersion'].includes(k)))return c.json({success:false,error:'受け取り方と読み込んだ版を確認してください'},400);
 const state=body.enabled?'granted':'revoked',reason=body.enabled?'本人がお知らせの受け取りを再開':'本人がお知らせの受け取りを停止';
 const {friend}=result;
 const row=await c.env.DB.prepare(`INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source,updated_by,version)
 SELECT ?,?,?,?,?,'liff_self_service',?,?+1 WHERE EXISTS(SELECT 1 FROM friends f JOIN line_accounts a ON a.id=f.line_account_id WHERE f.id=? AND f.line_account_id=? AND a.is_active=1 AND a.archived_at IS NULL AND ${activeTenantLineAccountSql('a.id')}) AND
 (EXISTS(SELECT 1 FROM friend_delivery_consents WHERE line_account_id=? AND friend_id=? AND purpose=? AND version=?) OR
  (NOT EXISTS(SELECT 1 FROM friend_delivery_consents WHERE line_account_id=? AND friend_id=? AND purpose=?) AND COALESCE((SELECT MAX(CAST(json_extract(COALESCE(after_json,before_json),'$.version') AS INTEGER)) FROM friend_delivery_consent_events WHERE line_account_id=? AND friend_id=? AND purpose=?),0)=?))
 ON CONFLICT(line_account_id,friend_id,purpose) DO UPDATE SET state=excluded.state,reason=excluded.reason,source=excluded.source,updated_by=excluded.updated_by,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=excluded.version WHERE friend_delivery_consents.version=?`)
 .bind(friend.accountId,friend.id,purpose,state,reason,friend.id,body.expectedVersion,friend.id,friend.accountId,friend.accountId,friend.id,purpose,body.expectedVersion,friend.accountId,friend.id,purpose,friend.accountId,friend.id,purpose,body.expectedVersion,body.expectedVersion).run();
 if(!row.meta.changes)return c.json({success:false,error:'お知らせの設定が変わりました。読み直してください'},409);
 return c.json({success:true,data:await preferences(c.env.DB,friend)});
});
