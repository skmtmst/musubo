import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { jstCalendar as japanCalendar } from '@line-crm/shared';
import {g2OpenAiAvailable} from '../services/account-ai-features.js';
import {Hono,type Context} from 'hono';
import type { Env } from '../worker-env.js';
import {GapError,gapAccount,gapBody,gapKey,gapVersion,gapWrite} from '../services/gap-common.js';
import {aiSettings,makeAiDraft} from '../services/ai-drafts.js';
import {acquireInboxReplyLease,releaseInboxReplyLease} from '../services/inbox-events.js';
import {sensitiveStepUpSatisfied,stepUpRequiredResponse} from '../lib/step-up.js';
import {hasStaffPermission,requirePermission} from '../middleware/role-guard.js';
export const aiDrafts=new Hono<Env>();
aiDrafts.onError((e,c)=>c.json({success:false,error:e instanceof GapError?e.code:'ai_unavailable'},e instanceof GapError?e.status:503));
async function settings(c:Context<Env>,a:string){
 const counts=await c.env.DB.prepare("SELECT count(CASE WHEN status='published' THEN 1 END) publishedQaCount,count(CASE WHEN status='draft' THEN 1 END) draftQaCount FROM qa_entries WHERE account_id=?").bind(a).first();
 const configured=await aiSettings(c.env.DB,a);
 const start=new Date(`${japanCalendar().toISOString().slice(0,7)}-01T00:00:00+09:00`).toISOString();
 const usage=await c.env.DB.prepare("SELECT count(*) n FROM ai_answer_logs WHERE account_id=? AND id LIKE 'ai-sim:%' AND action='answered' AND julianday(created_at)>=julianday(?)").bind(a,start).first<{n:number}>();
 const limit=(await c.env.DB.prepare('SELECT monthly_limit_answers FROM ai_settings WHERE account_id=?').bind(a).first<{monthly_limit_answers:number}>())?.monthly_limit_answers??3000;
 const used=usage?.n??0;
 return {...configured,...counts,providerAvailable:g2OpenAiAvailable(c.env),providerUnavailableReason:g2OpenAiAvailable(c.env)?null:'g2_ai_unavailable',suspendedReason:configured.mode==='suspended'?'suspended':used>=limit?'monthly_limit':null,simulatedUsage:{used,limit,warning:used>=limit*0.8},autoReplyAvailable:false,simulationAvailable:true,testMode:true};
}
async function chat(c:Context<Env>){
 const row=await c.env.DB.prepare('SELECT c.id,c.friend_id,f.line_account_id FROM chats c JOIN friends f ON f.id=c.friend_id WHERE c.id=?').bind(c.req.param('id')).first<{id:string;friend_id:string;line_account_id:string}>();
 if(!row)throw new GapError('not_found',404);await gapAccount(c,row.line_account_id);

 return row;
}
aiDrafts.get('/api/ai-settings',requirePermission('/auto-replies'),async(c)=>{const a=await gapAccount(c);return c.json({success:true,data:await settings(c,a)});});
aiDrafts.put('/api/ai-settings',requirePermission('/auto-replies'),async(c)=>{
 const a=await gapAccount(c),b=await gapBody(c),v=gapVersion(b.expectedVersion),im=c.get('impersonation');
 gapWrite(c,{admin:true,impersonation:b.mode==='off'||b.mode==='suspended'});
 if(im&&(b.mode!=='off'&&b.mode!=='suspended'))throw new GapError('IMPERSONATION_WRITE_BLOCKED',403);
 if(im&&(typeof b.reason!=='string'||!b.reason.trim()))throw new GapError('reason_required');
 if(b.mode==='auto_qa'){
  if(c.get('staff').role!=='owner')throw new GapError('owner_required',403);
  if(b.testMode!==true)throw new GapError('auto_qa_not_available',409);
  if(b.confirmed!==true)throw new GapError('confirmation_required');
  if(!await c.env.DB.prepare("SELECT 1 FROM qa_entries WHERE account_id=? AND status='published' LIMIT 1").bind(a).first())throw new GapError('published_qa_required',409);
  if(!await sensitiveStepUpSatisfied(c,'ai.settings'))return stepUpRequiredResponse(c,'自動応答の模擬実行には本人確認が必要です');
 }
 if(!['off','draft_only','suspended','auto_qa'].includes(String(b.mode)))throw new GapError('invalid_ai_mode');if(b.mode==='draft_only'&&b.confirmed!==true)throw new GapError('confirmation_required');
 const stmt=c.env.DB.prepare(`INSERT INTO ai_settings(account_id,mode,updated_by) SELECT ?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM ai_settings WHERE account_id=? AND version=?) ON CONFLICT(account_id) DO UPDATE SET mode=excluded.mode,updated_by=excluded.updated_by,version=version+1 WHERE version=?`).bind(a,b.mode,c.get('staff').id,v,a,v,v);
 const changes=await c.env.DB.batch([stmt,c.env.DB.prepare(`INSERT INTO operation_audit(id,target_kind,target_id,action,actor_id,detail_json) SELECT ?,'ai_settings',?,'changed',?,? WHERE changes()=1`).bind(crypto.randomUUID(),a,c.get('staff').id,JSON.stringify({mode:b.mode,testMode:true,impersonationId:im?.id??null,reason:b.reason??null}))]);if(!changes[0].meta.changes)throw new GapError('version_conflict',409);
 return c.json({success:true,data:await settings(c,a)});
});
aiDrafts.post('/api/chats/:id/ai/summary',async(c)=>{const row=await chat(c);return c.json({success:true,data:await makeAiDraft(c.env.DB,{account:row.line_account_id,friend:row.friend_id,chat:row.id,kind:'summary',apiKey:c.env.OPENAI_API_KEY??'',masked:!!c.get('impersonation'),providerEnabled:g2OpenAiAvailable(c.env)})});});
aiDrafts.post('/api/chats/:id/ai/draft',async(c)=>{gapWrite(c);const row=await chat(c);if(!hasStaffPermission(c,'/chats'))throw new GapError('forbidden',403);return c.json({success:true,data:await makeAiDraft(c.env.DB,{account:row.line_account_id,friend:row.friend_id,chat:row.id,kind:'draft',apiKey:c.env.OPENAI_API_KEY??'',masked:false,providerEnabled:g2OpenAiAvailable(c.env)})});});
aiDrafts.post('/api/chats/:id/ai/typing',async c=>{
 gapWrite(c);if(!hasStaffPermission(c,'/chats'))throw new GapError('forbidden',403);
 const row=await chat(c),b=await gapBody(c),staffId=c.get('staff').id;
 if(typeof b.typing!=='boolean')throw new GapError('invalid_typing');
 if(!b.typing){await releaseInboxReplyLease(c.env.DB,{channel:'line',conversationId:row.id,staffId});return c.json({success:true,data:{typing:false}});}
 const revision=(await c.env.DB.prepare('SELECT revision FROM chats WHERE id=?').bind(row.id).first<{revision:number}>())!.revision;
 const now=new Date(),expiresAt=new Date(now.getTime()+60000).toISOString();
 const lease=await acquireInboxReplyLease(c.env.DB,{channel:'line',conversationId:row.id,staffId,conversationRevision:revision,now:now.toISOString(),expiresAt});
 if(!lease.acquired)throw new GapError('reply_in_progress',409);
 return c.json({success:true,data:{typing:true,expiresAt}});
});
aiDrafts.get('/api/qa-entries',requirePermission('/auto-replies'),async(c)=>{
 const a=await gapAccount(c),query=c.req.query('q')??'',offset=parseOffsetPaging({ offset: c.req.query('offset') }, { offsetPolicy: {} }).offset;if(!Number.isSafeInteger(offset)||offset<0||query.length>200)throw new GapError('invalid_pagination');
 const rows=(await c.env.DB.prepare("SELECT * FROM qa_entries WHERE account_id=? AND (questions_json LIKE ? OR answer_messages_json LIKE ?) ORDER BY updated_at DESC,id LIMIT 20 OFFSET ?").bind(a,`%${query}%`,`%${query}%`,offset).all()).results;
 const count=await c.env.DB.prepare('SELECT count(*) total FROM qa_entries WHERE account_id=? AND (questions_json LIKE ? OR answer_messages_json LIKE ?)').bind(a,`%${query}%`,`%${query}%`).first<{total:number}>();return c.json({success:true,data:buildOffsetListResponse({ items:rows,total:count?.total??0,nextOffset:rows.length===20?offset+20:null, paging: { limit: 20, offset }, sort: [{ field: 'updated_at', direction: 'desc' }, { field: 'id', direction: 'asc' }] })});
});
function qaBody(b:Record<string,unknown>){if(!Array.isArray(b.questions)||!b.questions.length||b.questions.length>20||b.questions.some(x=>typeof x!=='string'||!x.trim()||x.length>500)||typeof b.answer!=='string'||!b.answer.trim()||b.answer.length>5000)throw new GapError('invalid_qa');return {questions:b.questions as string[],answer:b.answer as string};}
aiDrafts.post('/api/qa-entries',requirePermission('/auto-replies'),async(c)=>{
 gapWrite(c);const a=await gapAccount(c),b=qaBody(await gapBody(c)),key=gapKey(c),actor=c.get('staff').id;
 await c.env.DB.prepare(`INSERT INTO qa_entries(id,account_id,questions_json,answer_messages_json,created_by,updated_at,idempotency_key) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,created_by,idempotency_key) DO NOTHING`).bind(crypto.randomUUID(),a,JSON.stringify(b.questions),JSON.stringify([{type:'text',text:b.answer}]),actor,new Date().toISOString(),key).run();
 const saved=await c.env.DB.prepare('SELECT * FROM qa_entries WHERE account_id=? AND created_by=? AND idempotency_key=?').bind(a,actor,key).first<{questions_json:string;answer_messages_json:string}>();if(saved?.questions_json!==JSON.stringify(b.questions)||saved.answer_messages_json!==JSON.stringify([{type:'text',text:b.answer}]))throw new GapError('idempotency_conflict',409);return c.json({success:true,data:saved},201);
});
aiDrafts.put('/api/qa-entries/:id',requirePermission('/auto-replies'),async(c)=>{
 gapWrite(c);const a=await gapAccount(c),raw=await gapBody(c),b=qaBody(raw),v=gapVersion(raw.expectedVersion),staff=c.get('staff');
 const r=await c.env.DB.prepare(`UPDATE qa_entries SET questions_json=?,answer_messages_json=?,status='draft',version=version+1,updated_at=? WHERE id=? AND account_id=? AND version=? AND (?=1 OR status='draft')`).bind(JSON.stringify(b.questions),JSON.stringify([{type:'text',text:b.answer}]),new Date().toISOString(),c.req.param('id'),a,v,['owner','admin'].includes(staff.role)||staff.hqRole==='operator'?1:0).run();if(!r.meta.changes)throw new GapError('version_conflict_or_forbidden',409);return c.json({success:true,data:{version:v+1,status:'draft'}});
});
for(const [method,suffix,status] of [['post','publish','published'],['post','stop','stopped'],['delete','','stopped']] as const){
 const handler=async(c:Context<Env>)=>{gapWrite(c,{admin:true});const a=await gapAccount(c),b=await gapBody(c),v=gapVersion(b.expectedVersion);const r=await c.env.DB.prepare('UPDATE qa_entries SET status=?,version=version+1,updated_at=? WHERE id=? AND account_id=? AND version=?').bind(status,new Date().toISOString(),c.req.param('id')!,a,v).run();if(!r.meta.changes)throw new GapError('version_conflict',409);return c.json({success:true,data:{status,version:v+1}});};
 if(method==='post')aiDrafts.post(`/api/qa-entries/:id/${suffix}`,requirePermission('/auto-replies'),handler);else aiDrafts.delete('/api/qa-entries/:id',requirePermission('/auto-replies'),handler);
}
