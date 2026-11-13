import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { validateNenWebhookHeaders, verifyNenWebhook } from '../lib/hmac.js';
import { WEBHOOK_BODY_BYTES, isWebhookBodyTooLarge } from '../lib/webhook-body.js';
import {simulateAttribution,simulationResults} from '../features/ec-commerce/ec-auto-line-attribution/index.js';
import {assertChanged,clearAssertions} from '../features/booking/booking-series/index.js';
import {requirePermission} from '../middleware/role-guard.js';
import {Hono} from 'hono';
import type { Env } from '../worker-env.js';
import {GapError,gapAccount,gapBody,gapVersion,gapWrite,gapKey} from '../services/gap-common.js';
import {autoKinds,autoLineRules,ingestBehavior,processAutoLineMock} from '../features/ec-commerce/ec-auto-line/index.js';
import {getConnectorSecret} from './ec-connector-secret.js';
import {resolveUnknownAutoLineSimulationCap} from '../features/ec-commerce/ec-auto-line-cap.js';
export const ecAutoLine=new Hono<Env>();
ecAutoLine.use('/api/ec/auto-line/*',requirePermission('/ec-commerce'));
ecAutoLine.onError((e,c)=>c.json({success:false,error:e instanceof GapError?e.code:'auto_line_unavailable'},e instanceof GapError?e.status:503));
ecAutoLine.post('/api/ec/events',async c=>{
 const a=c.req.header('x-line-account-id');
 const signed={profile:'ec-auto-line' as const,timestamp:c.req.header('x-nen-timestamp'),signature:c.req.header('x-nen-signature'),nowSeconds:Date.now()/1000};
 if(!a||!validateNenWebhookHeaders(signed).ok)throw new GapError('invalid_signature',401);
 const secret=await getConnectorSecret(c.env.DB,a,c.env.LINE_CREDENTIAL_ENCRYPTION_KEY);if(!secret)throw new GapError('invalid_signature',401);
 const raw=await c.req.text();if(isWebhookBodyTooLarge(raw,WEBHOOK_BODY_BYTES.ecAutoLine))throw new GapError('body_too_large');
 if(!(await verifyNenWebhook({...signed,secret,rawBody:raw})).ok)throw new GapError('invalid_signature',401);
 const connector=await c.env.DB.prepare("SELECT e.id FROM ec_connectors e JOIN line_accounts a ON a.id=e.line_account_id JOIN tenants t ON t.id=a.tenant_id WHERE e.line_account_id=? AND t.status='active' AND e.status='connected' AND a.is_active=1 AND a.archived_at IS NULL").bind(a).first();if(!connector)throw new GapError('connector_unavailable',409);
 const count=await c.env.DB.prepare("SELECT count(*) n FROM ec_behavior_events WHERE account_id=? AND julianday(received_at)>=julianday(?,'-1 minute')").bind(a,new Date().toISOString()).first<{n:number}>();if((count?.n??0)>=600)return c.json({success:false,error:'rate_limited'},429);
 let body;try{body=JSON.parse(raw);}catch{throw new GapError('invalid_body');}return c.json({success:true,data:await ingestBehavior(c.env.DB,a,body)},202);
});
ecAutoLine.get('/api/ec/auto-line/rules',async c=>{const a=await gapAccount(c);return c.json({success:true,data:await autoLineRules(c.env.DB,a)});});
for(const method of ['PUT','POST']as const)ecAutoLine.on(method,method==='PUT'?'/api/ec/auto-line/rules/:kind':'/api/ec/auto-line/rules/:kind/enable',async c=>{
 const a=await gapAccount(c),b=await gapBody(c),kind=c.req.param('kind')as typeof autoKinds[number],v=gapVersion(b.expectedVersion);gapWrite(c,{admin:true,impersonation:b.enabled===false});
 if(!autoKinds.includes(kind)||b.testMode!==true)throw new GapError('test_mode_required');
 if(c.get('impersonation')&&(b.enabled!==false||typeof b.reason!=='string'||!b.reason.trim()))throw new GapError('IMPERSONATION_WRITE_BLOCKED',403);
 const requestKey=method==='POST'?gapKey(c):crypto.randomUUID(),request=JSON.stringify({method,kind,...b});
 if(method==='POST'){const old=await c.env.DB.prepare('SELECT request_json,response_json FROM ec_auto_line_rule_events WHERE account_id=? AND request_key=?').bind(a,requestKey).first<{request_json:string;response_json:string}>();if(old){if(old.request_json!==request)throw new GapError('idempotency_conflict',409);return c.json({success:true,data:JSON.parse(old.response_json)});}}
 const current=(await autoLineRules(c.env.DB,a)).find(r=>r.kind===kind)!;
 if(method==='POST'&&(b.confirmed!==true||b.enabled!==true))throw new GapError('confirmation_required');
 const enabled=method==='POST'?true:b.enabled===false?false:current.enabled;
 if(method==='PUT'&&b.enabled===true&&!current.enabled)throw new GapError('confirmation_required');
 const wait=method==='POST'?current.waitMinutes:b.waitMinutes,messages=method==='POST'?current.messages:b.messages;
 if(!Number.isInteger(wait)||Number(wait)<0||Number(wait)>10080||!Array.isArray(messages)||messages.length>5||JSON.stringify(messages).length>10000)throw new GapError('invalid_rule');
 if(enabled&&!await c.env.DB.prepare("SELECT id FROM ec_connectors WHERE line_account_id=? AND status='connected'").bind(a).first())throw new GapError('connector_unavailable',409);
 const mutation=c.env.DB.prepare(`INSERT INTO ec_auto_line_rules(account_id,kind,enabled,wait_minutes,messages_json,updated_by) SELECT ?,?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM ec_auto_line_rules WHERE account_id=? AND kind=? AND version=?) ON CONFLICT(account_id,kind) DO UPDATE SET enabled=excluded.enabled,wait_minutes=excluded.wait_minutes,messages_json=excluded.messages_json,updated_by=excluded.updated_by,version=version+1 WHERE version=?`).bind(a,kind,enabled?1:0,wait,JSON.stringify(messages),c.get('staff').id,v,a,kind,v,v);
 const data={kind,enabled,waitMinutes:wait,messages,version:v+1,testMode:true};
 try{await c.env.DB.batch([mutation,assertChanged(c.env.DB),c.env.DB.prepare('INSERT INTO ec_auto_line_rule_events(account_id,request_key,kind,actor_id,impersonation_id,reason,request_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(a,requestKey,kind,c.get('staff').id,c.get('impersonation')?.id??null,typeof b.reason==='string'?b.reason:null,request,JSON.stringify(data),new Date().toISOString()),clearAssertions(c.env.DB)]);}catch(e){
  if(method==='POST'){const old=await c.env.DB.prepare('SELECT request_json,response_json FROM ec_auto_line_rule_events WHERE account_id=? AND request_key=?').bind(a,requestKey).first<{request_json:string;response_json:string}>();if(old?.request_json===request)return c.json({success:true,data:JSON.parse(old.response_json)});}
  if(/CHECK constraint|UNIQUE constraint/.test(String(e)))throw new GapError('version_conflict',409);throw e;
 }
 return c.json({success:true,data});
});
ecAutoLine.get('/api/ec/auto-line/sends',async c=>{
 const a=await gapAccount(c),offset=parseOffsetPaging({ offset: c.req.query('offset') }, { offsetPolicy: {} }).offset,kind=c.req.query('kind')??'',status=c.req.query('status')??'';if(!Number.isSafeInteger(offset)||offset<0)throw new GapError('invalid_pagination');
 const where="account_id=? AND (?='' OR rule_kind=?) AND (?='' OR status=?)",bindings=[a,kind,kind,status,status];
 const total=await c.env.DB.prepare(`SELECT count(*) n FROM ec_auto_line_sends WHERE ${where}`).bind(...bindings).first<{n:number}>();
 const items=(await c.env.DB.prepare(`SELECT id,rule_kind kind,scheduled_at scheduledAt,status,sent_at simulatedAt,test_mode testMode FROM ec_auto_line_sends WHERE ${where} ORDER BY scheduled_at DESC,id LIMIT 20 OFFSET ?`).bind(...bindings,offset).all()).results;return c.json({success:true,data:buildOffsetListResponse({ items,total:total?.n??0, paging: { limit: 20, offset }, sort: [{ field: 'scheduledAt', direction: 'desc' }, { field: 'id', direction: 'asc' }] })});
});
ecAutoLine.get('/api/ec/auto-line/stats',async c=>{
 const a=await gapAccount(c),r=await c.env.DB.prepare("SELECT count(*) total,count(CASE WHEN status='simulated' THEN 1 END) simulated,count(CASE WHEN status LIKE 'skipped_%' THEN 1 END) skipped FROM ec_auto_line_sends WHERE account_id=?").bind(a).first();return c.json({success:true,data:{...r,sent:0,clicks:null,purchases:null,simulatedResults:await simulationResults(c.env.DB,a),testMode:true}});
});
ecAutoLine.post('/api/ec/auto-line/rules/:kind/test',async c=>{gapWrite(c,{admin:true});const a=await gapAccount(c),kind=c.req.param('kind');if(!autoKinds.includes(kind as typeof autoKinds[number]))throw new GapError('invalid_kind');return c.json({success:true,data:{preview:(await autoLineRules(c.env.DB,a)).find(r=>r.kind===kind),sent:false,testMode:true}});});

// Only a verified store administrator can inspect or resolve simulated unknown outcomes.
ecAutoLine.get('/api/ec/auto-line/cap/unknown',async c=>{
 gapWrite(c,{admin:true});const a=await gapAccount(c);
 const items=(await c.env.DB.prepare("SELECT r.id,r.candidate_id candidateId,r.reserved_at reservedAt FROM ec_auto_line_cap_reservations r JOIN line_accounts a ON a.id=r.account_id AND a.tenant_id=r.tenant_id WHERE r.account_id=? AND r.mode='simulation' AND r.state='unknown' ORDER BY r.reserved_at,r.id LIMIT 100").bind(a).all()).results;
 return c.json({success:true,data:{items,testMode:true}});
});
ecAutoLine.post('/api/ec/auto-line/cap/unknown/:id/release',async c=>{
 gapWrite(c,{admin:true});const a=await gapAccount(c),b=await gapBody(c);
 if(b.testMode!==true||b.confirmedNotSent!==true||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>500)throw new GapError('confirmation_required');
 const account=await c.env.DB.prepare('SELECT tenant_id FROM line_accounts WHERE id=? AND tenant_id IS NOT NULL').bind(a).first<{tenant_id:string}>();
 if(!account)throw new GapError('not_found',404);
 const released=await resolveUnknownAutoLineSimulationCap(c.env.DB,account.tenant_id,a,c.req.param('id'),c.get('staff').id,b.reason.trim());
 if(!released)throw new GapError('not_found',404);
 return c.json({success:true,data:{released:true,testMode:true}});
});

ecAutoLine.post('/api/ec/auto-line/simulate',async c=>{
 gapWrite(c,{admin:true});const a=await gapAccount(c),b=await gapBody(c);
 if(b.testMode!==true)throw new GapError('test_mode_required');
 return c.json({success:true,data:{...await processAutoLineMock(c.env.DB,new Date(),a),sent:false,testMode:true}});
});

ecAutoLine.post('/api/ec/auto-line/attribution/simulate',async c=>{gapWrite(c,{admin:true});const a=await gapAccount(c),b=await gapBody(c);return c.json({success:true,data:await simulateAttribution(c.env.DB,a,b)});});
ecAutoLine.get('/api/ec/auto-line/sends/:id',async c=>{const a=await gapAccount(c);const send=await c.env.DB.prepare('SELECT id,rule_kind kind,status,scheduled_at scheduledAt,sent_at simulatedAt,test_mode testMode,messages_snapshot_json FROM ec_auto_line_sends WHERE id=? AND account_id=?').bind(c.req.param('id'),a).first<Record<string,unknown>>();if(!send)throw new GapError('not_found',404);return c.json({success:true,data:{...send,messages:JSON.parse(String(send.messages_snapshot_json)),messages_snapshot_json:undefined,results:await simulationResults(c.env.DB,a,c.req.param('id'))}});});
