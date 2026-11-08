import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import {Hono,type Context} from 'hono';
import type { Env } from '../worker-env.js';
import {GapError,gapAccount,gapBody,gapVersion,gapWrite} from '../services/gap-common.js';
import {sensitiveStepUpSatisfied,stepUpRequiredResponse} from '../lib/step-up.js';
import {sha256Hex} from '../middleware/auth.js';
export const mcpConnections=new Hono<Env>();
mcpConnections.onError((e,c)=>c.json({success:false,error:e instanceof GapError?e.code:'mcp_unavailable'},e instanceof GapError?e.status:503));
async function account(c:Context<Env>){const staff=c.get('staff');if(!['owner','admin'].includes(staff?.role) && staff?.hqRole!=='operator')throw new GapError('forbidden',403);return gapAccount(c);}
async function visible(c:Context<Env>,a:string,id?:string){
 const rows=(await c.env.DB.prepare("SELECT * FROM mcp_connections WHERE organization_id=(SELECT tenant_id FROM line_accounts WHERE id=?) AND EXISTS(SELECT 1 FROM json_each(account_ids_json) WHERE value=?) AND (? IS NULL OR id=?) ORDER BY created_at DESC,id").bind(a,a,id??null,id??null).all<Record<string,unknown>>()).results;
 return Promise.all(rows.map(async r=>({id:r.id,name:r.name,level:r.level,accounts:[{id:a,name:(await c.env.DB.prepare('SELECT name FROM line_accounts WHERE id=?').bind(a).first<{name:string}>())?.name}],keyPrefix:r.key_prefix,expiresAt:r.expires_at,lastUsedAt:r.last_used_at,status:Date.parse(String(r.expires_at))<=Date.now()?'expired':r.status,previousKeyExpiresAt:r.previous_key_expires_at,version:r.version})));
}
function newKey(){const bytes=crypto.getRandomValues(new Uint8Array(32));return 'mcp_'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
mcpConnections.get('/api/mcp-connections',async c=>{const a=await account(c);return c.json({success:true,data:await visible(c,a)});});
mcpConnections.get('/api/mcp-connections/logs',async c=>{
 const a=await account(c),id=c.req.query('connectionId')??null,kind=c.req.query('kind')??'',result=c.req.query('result')??'',offset=parseOffsetPaging({ offset: c.req.query('offset') }, { offsetPolicy: {} }).offset;if(!Number.isSafeInteger(offset)||offset<0)throw new GapError('invalid_pagination');
 const connection=id?(await visible(c,a,id))[0]:null;if(id&&!connection)throw new GapError('not_found',404);
 const where="FROM mcp_call_logs l JOIN mcp_connections c ON c.id=l.connection_id WHERE c.organization_id=(SELECT tenant_id FROM line_accounts WHERE id=?) AND EXISTS(SELECT 1 FROM json_each(c.account_ids_json) WHERE value=?) AND (? IS NULL OR c.id=?) AND (?='' OR l.kind=?) AND (?='' OR l.result=?)";
 const bindings=[a,a,id,id,kind,kind,result,result];
 const total=await c.env.DB.prepare(`SELECT count(*) n ${where}`).bind(...bindings).first<{n:number}>();
 const rows=(await c.env.DB.prepare(`SELECT l.*,c.name connection_name ${where} ORDER BY l.at DESC,l.id LIMIT 20 OFFSET ?`).bind(...bindings,offset).all<Record<string,unknown>>()).results;
 return c.json({success:true,data:buildOffsetListResponse({ items:rows.map(r=>({id:r.id,at:r.at,connectionId:r.connection_id,connectionName:r.connection_name,kind:r.kind,result:r.result,summary:r.summary,targetType:r.target_type,targetId:r.target_id})),total:total?.n??0,connection, paging: { limit: 20, offset }, sort: [{ field: 'at', direction: 'desc' }, { field: 'id', direction: 'asc' }] })});
});
mcpConnections.post('/api/mcp-connections',async c=>{
 const a=await account(c);gapWrite(c,{admin:true});if(c.get('staff').role!=='owner'&&c.get('staff').hqRole!=='operator')throw new GapError('owner_required',403);
 const b=await gapBody(c);if(typeof b.name!=='string'||!b.name.trim()||b.name.length>80||!['read','draft','send_request'].includes(String(b.level))||![30,90,180,365].includes(Number(b.expiryDays??90)))throw new GapError('invalid_connection');
 // 一部範囲のキー管理を避けるため、1接続を1店舗に限定する。
 if(b.accountIds!==undefined&&(!Array.isArray(b.accountIds)||b.accountIds.length!==1||b.accountIds[0]!==a))throw new GapError('invalid_accounts');
 if(!await sensitiveStepUpSatisfied(c,'mcp.connection'))return stepUpRequiredResponse(c,'接続の作成には本人確認が必要です');
 const id=crypto.randomUUID(),key=newKey();
 await c.env.DB.prepare(`INSERT INTO mcp_connections(id,organization_id,name,level,account_ids_json,key_hash,key_prefix,expires_at,created_by,created_at) VALUES(?,(SELECT tenant_id FROM line_accounts WHERE id=?),?,?,?,?,?,?,?,?)`).bind(id,a,b.name.trim(),b.level,JSON.stringify([a]),await sha256Hex(key),key.slice(0,12),new Date(Date.now()+Number(b.expiryDays??90)*86400000).toISOString(),c.get('staff').id,new Date().toISOString()).run();
 c.header('Cache-Control','no-store');return c.json({success:true,data:{connection:(await visible(c,a,id))[0],url:new URL('/mcp',c.req.url).href,key}},201);
});
for(const action of ['stop','rotate'] as const)mcpConnections.post(`/api/mcp-connections/:id/${action}`,async c=>{
 const a=await account(c),b=await gapBody(c),v=gapVersion(b.expectedVersion);gapWrite(c,{admin:true,impersonation:action==='stop'});
 if(c.get('impersonation')&&(typeof b.reason!=='string'||!b.reason.trim()))throw new GapError('reason_required');
 const id=c.req.param('id')!,row=(await visible(c,a,id))[0];if(!row)throw new GapError('not_found',404);
 if(action==='rotate'&&c.get('staff').role!=='owner'&&c.get('staff').hqRole!=='operator')throw new GapError('owner_required',403);
 if(action==='rotate'&&!await sensitiveStepUpSatisfied(c,'mcp.connection'))return stepUpRequiredResponse(c,'鍵の作り直しには本人確認が必要です');
 const key=newKey(),token=crypto.randomUUID(),now=new Date().toISOString();
 const sql=action==='stop'?"UPDATE mcp_connections SET status='stopped',stopped_by=?,version=version+1 WHERE id=? AND version=? AND status='active'":"UPDATE mcp_connections SET previous_key_hash=key_hash,previous_key_expires_at=?,key_hash=?,key_prefix=?,version=version+1 WHERE id=? AND version=? AND status='active' AND julianday(expires_at)>julianday('now')";
 const stmt=action==='stop'?c.env.DB.prepare(sql).bind(c.get('staff').id,id,v):c.env.DB.prepare(sql).bind(new Date(Date.now()+86400000).toISOString(),await sha256Hex(key),key.slice(0,12),id,v);
 const result=await c.env.DB.batch([stmt,c.env.DB.prepare("INSERT INTO mcp_call_logs(id,connection_id,tool,kind,result,summary,at) SELECT ?,?,?,'manage','ok',?,? WHERE changes()=1").bind(token,id,action,action==='stop'?'接続を止めた':'鍵を作り直した',now)]);if(!result[0].meta.changes)throw new GapError('version_conflict',409);
 c.header('Cache-Control','no-store');const connection=(await visible(c,a,id))[0];return c.json({success:true,data:action==='stop'?connection:{connection,url:new URL('/mcp',c.req.url).href,key}});
});
