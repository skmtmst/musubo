import { storedDeliveryLimit } from '../features/broadcasts/broadcast-delivery-limit/index.js';
import {Hono,type Context} from 'hono';
import type { Env } from '../worker-env.js';
import {GapError,gapAccount,gapBody,gapKey,gapWrite,gapVersion} from '../services/gap-common.js';
import {abSettings,abAudience,abStats,splitAb,startAbMock,finishMockRemainder,startAbLive,createAbLiveTransmit} from '../features/broadcasts/broadcast-ab/index.js';
import {assertChanged,clearAssertions} from '../features/booking/booking-series/index.js';
import {requirePermission,requireIrreversibleConfirmation,hasStaffPermission} from '../middleware/role-guard.js';
import {BROADCAST_DEFINITION_EDIT_KEY,BROADCAST_DEFINITION_PUBLISH_KEY} from '@line-crm/shared';
import {broadcastQuietHoursShift} from '../services/gap-send-preview.js';
export const broadcastAb=new Hono<Env>();
broadcastAb.onError((e,c)=>c.json({success:false,error:e instanceof GapError?e.code:'ab_unavailable'},e instanceof GapError?e.status:503));
async function scope(c:Context<Env>){const id=c.req.param('id')!,row=await c.env.DB.prepare('SELECT line_account_id,status,lock_version,message_options_json FROM broadcasts WHERE id=?').bind(id).first<{line_account_id:string;status:string;lock_version:number;message_options_json:string|null}>();if(!row)throw new GapError('not_found',404);await gapAccount(c,row.line_account_id);return row;}
broadcastAb.put('/api/broadcasts/:id/ab-test',requirePermission(BROADCAST_DEFINITION_EDIT_KEY),async(c)=>{
 gapWrite(c);const row=await scope(c);if(storedDeliveryLimit(row))throw new GapError('人数の上限とA/Bは併用できません。',409);const b=await gapBody(c),settings=abSettings(b),v=gapVersion(b.expectedVersion),id=c.req.param('id');
 if(row.status!=='draft')throw new GapError('draft_required',409);const audience=await abAudience(c.env.DB,id);splitAb(audience.ids,settings.test_ratio_pct);
 const old=await c.env.DB.prepare('SELECT status FROM broadcast_ab_tests WHERE broadcast_id=?').bind(id).first<{status:string}>();if(old&&old.status!=='draft')throw new GapError('ab_test_active',409);
 try{await c.env.DB.batch([c.env.DB.prepare("UPDATE broadcasts SET lock_version=lock_version+1,approval_status='none' WHERE id=? AND lock_version=? AND status='draft'").bind(id,v),assertChanged(c.env.DB),c.env.DB.prepare(`INSERT INTO broadcast_ab_tests(broadcast_id,test_ratio_pct,metric,decide_after_minutes,undecided_policy) VALUES(?,?,?,?,?) ON CONFLICT(broadcast_id) DO UPDATE SET test_ratio_pct=excluded.test_ratio_pct,decide_after_minutes=excluded.decide_after_minutes,undecided_policy=excluded.undecided_policy,version=version+1 WHERE status='draft'`).bind(id,settings.test_ratio_pct,settings.metric,settings.decide_after_minutes,settings.undecided_policy),assertChanged(c.env.DB),clearAssertions(c.env.DB)]);}catch(e){if(/CHECK constraint/.test(String(e)))throw new GapError('version_conflict',409);throw e;}
 return c.json({success:true,data:{...settings,version:v+1,testMode:true}});
});
broadcastAb.delete('/api/broadcasts/:id/ab-test',requirePermission(BROADCAST_DEFINITION_EDIT_KEY),async(c)=>{
 gapWrite(c);const row=await scope(c);const b=await gapBody(c),v=gapVersion(b.expectedVersion),id=c.req.param('id');if(row.status!=='draft')throw new GapError('draft_required',409);
 try{await c.env.DB.batch([c.env.DB.prepare("UPDATE broadcasts SET lock_version=lock_version+1,approval_status='none' WHERE id=? AND lock_version=? AND status='draft' AND EXISTS(SELECT 1 FROM broadcast_ab_tests WHERE broadcast_id=? AND status='draft')").bind(id,v,id),assertChanged(c.env.DB),c.env.DB.prepare('DELETE FROM broadcast_variants WHERE broadcast_id=?').bind(id),c.env.DB.prepare("DELETE FROM broadcast_ab_tests WHERE broadcast_id=? AND status='draft'").bind(id),clearAssertions(c.env.DB)]);}catch(e){if(/CHECK constraint/.test(String(e)))throw new GapError('version_conflict',409);throw e;}return c.json({success:true,data:{deleted:true,version:v+1}});
});
broadcastAb.put('/api/broadcasts/:id/variants/:key',requirePermission(BROADCAST_DEFINITION_EDIT_KEY),async(c)=>{
 gapWrite(c);const row=await scope(c);if(storedDeliveryLimit(row))throw new GapError('人数の上限とA/Bは併用できません。',409);const b=await gapBody(c),v=gapVersion(b.expectedVersion),id=c.req.param('id'),key=c.req.param('key');if(!['A','B'].includes(key)||typeof b.text!=='string'||!b.text.trim()||b.text.length>5000)throw new GapError('invalid_variant');
 // 最初の段はテキスト2案だけ。本文の版と同じロックで承認を必ず外す。
 try{await c.env.DB.batch([c.env.DB.prepare("UPDATE broadcasts SET lock_version=lock_version+1,approval_status='none' WHERE id=? AND lock_version=? AND status='draft' AND NOT EXISTS(SELECT 1 FROM broadcast_ab_tests WHERE broadcast_id=? AND status!='draft')").bind(id,v,id),assertChanged(c.env.DB),c.env.DB.prepare(`INSERT INTO broadcast_variants(id,broadcast_id,variant_key,messages_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(broadcast_id,variant_key) DO UPDATE SET messages_json=excluded.messages_json,version=version+1`).bind(crypto.randomUUID(),id,key,JSON.stringify([{type:'text',text:b.text}]),new Date().toISOString()),clearAssertions(c.env.DB)]);}catch(e){if(/CHECK constraint/.test(String(e)))throw new GapError('ab_test_active_or_version_conflict',409);throw e;}return c.json({success:true,data:{key,version:v+1}});
});
broadcastAb.get('/api/broadcasts/:id/ab-result',requirePermission('/broadcasts'),async(c)=>{
 await scope(c);const id=c.req.param('id'),test=await c.env.DB.prepare('SELECT * FROM broadcast_ab_tests WHERE broadcast_id=?').bind(id).first();if(!test)throw new GapError('not_found',404);
 const remainder=await c.env.DB.prepare("SELECT count(*) count,SUM(state='sent') sent FROM broadcast_ab_recipients WHERE broadcast_id=? AND variant_key='R'").bind(id).first();
 return c.json({success:true,data:{...test,variants:await abStats(c.env.DB,id),remainder,testMode:true}});
});
broadcastAb.post('/api/broadcasts/:id/ab-test/choose',requirePermission(BROADCAST_DEFINITION_PUBLISH_KEY),requireIrreversibleConfirmation('broadcast-send'),async(c)=>{
 gapWrite(c);const row=await scope(c);if(storedDeliveryLimit(row))throw new GapError('人数の上限とA/Bは併用できません。',409);const id=c.req.param('id'),b=await gapBody(c),key=gapKey(c);if(!['A','B','none'].includes(String(b.variant)))throw new GapError('invalid_variant');if(b.testMode!==true)throw new GapError('test_mode_required',409);
 const current=await c.env.DB.prepare('SELECT status,choice_key,choice_value FROM broadcast_ab_tests WHERE broadcast_id=?').bind(id).first<{status:string;choice_key:string|null;choice_value:string|null}>();if(!current)throw new GapError('not_found',404);
 if(current.choice_key===key&&current.choice_value===b.variant)return c.json({success:true,data:{variant:current.choice_value,testMode:true},replayed:true});
 const count=(await c.env.DB.prepare("SELECT COUNT(*) n FROM broadcast_ab_recipients WHERE broadcast_id=? AND variant_key='R' AND state='pending'").bind(id).first<{n:number}>())!.n;
 if(b.confirmedRecipientCount!==count)throw new GapError('SEND_PREVIEW_CHANGED',409);
 const shift=b.variant==='none'?null:await broadcastQuietHoursShift(c.env.DB,row.line_account_id,new Date().toISOString());
 const rs=await c.env.DB.prepare("UPDATE broadcast_ab_tests SET status=?,winner=?,choice_key=?,choice_value=?,decided_by=?,decided_at=?,remainder_scheduled_at=?,version=version+1 WHERE broadcast_id=? AND status='undecided'").bind(b.variant==='none'?'finished':'decided',b.variant==='none'?null:b.variant,key,b.variant,c.get('staff').id,new Date().toISOString(),b.variant==='none'?null:(shift??new Date().toISOString()),id).run();
 if(!rs.meta.changes)throw new GapError('already_chosen',409);if(b.variant!=='none'&&!shift)await finishMockRemainder(c.env.DB,id);
 return c.json({success:true,data:{variant:b.variant,scheduledAt:shift,testMode:true}});
});
/** 通常の承認と権限検査を通した後でだけ呼ぶ。 */
export async function maybeStartAb(c:Context<Env>,id:string,b:{testMode?:unknown;liveMode?:unknown;expectedVersion?:unknown;confirmedRecipientCount?:unknown}|null){
 if(!await c.env.DB.prepare('SELECT broadcast_id FROM broadcast_ab_tests WHERE broadcast_id=?').bind(id).first())return null;
 gapWrite(c);if(!hasStaffPermission(c,BROADCAST_DEFINITION_PUBLISH_KEY))throw new GapError('forbidden',403);
 if(b?.liveMode===true)return c.json({success:true,data:await startAbLiveRequest(c,id,b)},202);
 if(b?.testMode!==true)throw new GapError('test_mode_required',409);
 return c.json({success:true,data:await startAbMock(c.env.DB,id,gapVersion(b.expectedVersion),Number(b.confirmedRecipientCount),gapKey(c))},202);
}
/** 本送信の開始。通常の即時送信と同じ停止・課金・枠の判定を通し、実績は769の表だけに書く。旗がなければ始めない。 */
async function startAbLiveRequest(c:Context<Env>,id:string,b:{expectedVersion?:unknown;confirmedRecipientCount?:unknown}){
 if(c.env.AB_LIVE_DELIVERY_ENABLED!=='true')throw new GapError('live_delivery_disabled',409);
 const broadcast=await c.env.DB.prepare('SELECT * FROM broadcasts WHERE id=?').bind(id).first<Record<string,unknown>&{line_account_id:string|null}>();
 if(!broadcast)throw new GapError('not_found',404);
 const accountId=broadcast.line_account_id;
 const {getSendPermissionForAccount}=await import('../services/send-entitlements.js');
 if(!(await getSendPermissionForAccount(c.env.DB,accountId)).allowed)throw new GapError('配信が止まっています',409);
 const {isOperationCapabilityStopped}=await import('@line-crm/db');
 if(await isOperationCapabilityStopped(c.env.DB,accountId,'broadcast_dispatch'))throw new GapError('緊急停止中のため送信できません',409);
 const {guardScheduledBroadcastQuota}=await import('../features/broadcasts/broadcast/index.js');
 const quota=await guardScheduledBroadcastQuota(c.env.DB,broadcast as never,accountId,{reserveBroadcastId:id});
 if(quota.blocked)throw new GapError(quota.message??'送信枠が足りないため送れません',409);
 const {getLineAccountById}=await import('@line-crm/db');
 const account=accountId?await getLineAccountById(c.env.DB,accountId):null;
 const {resolveLineToken}=await import('../services/line-token.js');
 const {LineClient}=await import('@line-crm/line-sdk');
 const lineClient=new LineClient(resolveLineToken({accountToken:account?.channel_access_token??null,defaultToken:c.env.LINE_CHANNEL_ACCESS_TOKEN,accountId,context:'broadcasts.ab-live-send'}));
 return startAbLive(c.env.DB,id,gapVersion(b.expectedVersion),Number(b.confirmedRecipientCount),gapKey(c),{transmit:createAbLiveTransmit(lineClient),liveDeliveryEnabled:true});
}
/** 許可済みの開始操作の再送だけを扱い、新しい開始や送信は行わない。 */
export async function maybeReplayAbStart(c:Context<Env>,id:string,b:{testMode?:unknown;expectedVersion?:unknown;confirmedRecipientCount?:unknown}|null){
 const old=await c.env.DB.prepare('SELECT start_key FROM broadcast_ab_tests WHERE broadcast_id=?').bind(id).first<{start_key:string|null}>();
 if(!old?.start_key||old.start_key!==c.req.header('Idempotency-Key'))return null;
 return maybeStartAb(c,id,b);
}
