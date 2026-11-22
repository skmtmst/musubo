import {requestMcpBroadcast} from '../services/mcp-broadcast-request.js';
import {mcpBroadcastDraft} from '../services/mcp-broadcast-drafts.js';
import {canAccessAllLineAccounts} from '../services/account-access.js';
import {Hono} from 'hono';
import type { Env } from '../worker-env.js';
import {sha256Hex} from '../middleware/auth.js';
import {comparisonPeriod,storeNumbers} from '../services/store-comparison.js';
export const mcpRpc=new Hono<Env>();
const tools=[
 {name:'request_broadcast_send',description:'この接続の模擬配信について人の承認を依頼する（実送信しない）'},
 {name:'create_broadcast_draft',description:'配信のテキスト下書きを作る（送らない）'},
 {name:'update_broadcast_draft',description:'この接続が作った未依頼の下書きを直す（送らない）'},
 {name:'get_account_summary',description:'店の友だちの人数（個人情報は含まない）'},
 {name:'list_tags',description:'店のタグと付いている人数'},
 {name:'list_broadcasts',description:'配信の一覧（本文は含まない）'},
 {name:'get_broadcast_result',description:'配信の件数と状態'},
 {name:'get_booking_counts',description:'指定期間の予約・来店・無断の件数'},
 {name:'get_analytics',description:'店の集計（未取得は null）'},
];
mcpRpc.post('/mcp',async c=>{
 c.header('Cache-Control','no-store');
 const token=c.req.header('Authorization')?.match(/^Bearer (mcp_[a-f0-9]{64})$/)?.[1];if(!token)return c.json({error:'unauthorized'},401);
 const now=new Date().toISOString(),hash=await sha256Hex(token);
 const row=await c.env.DB.prepare(`SELECT m.* FROM mcp_connections m JOIN tenants t ON t.id=m.organization_id JOIN staff_members s ON s.id=m.created_by AND s.tenant_id=m.organization_id WHERE m.status='active' AND julianday(m.expires_at)>julianday(?) AND (m.key_hash=? OR m.previous_key_hash=? AND julianday(m.previous_key_expires_at)>julianday(?)) AND t.status='active' AND t.purge_started_at IS NULL AND t.data_purged_at IS NULL AND s.is_active=1 AND s.role='owner' AND (m.level='read' OR s.access_level='full')`).bind(now,hash,hash,now).first<{id:string;organization_id:string;account_ids_json:string;level:string;created_by:string}>();if(!row)return c.json({error:'unauthorized'},401);
 const size=Number(c.req.header('content-length')??0);if(size>16384)return c.json({error:'body_too_large'},413);
 const raw=await c.req.text();if(new TextEncoder().encode(raw).length>16384)return c.json({error:'body_too_large'},413);
 let b:Record<string,unknown>;try{b=JSON.parse(raw);}catch{return c.json({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}},400);}
 if(!b||Array.isArray(b)||b.jsonrpc!=='2.0'||typeof b.method!=='string')return c.json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}},400);
 const id=b.id??null,params=b.params as {name?:string;arguments?:Record<string,unknown>}|undefined;
 const finish=async(result:unknown)=>{await c.env.DB.prepare('UPDATE mcp_connections SET last_used_at=? WHERE id=?').bind(now,row.id).run();return c.json({jsonrpc:'2.0',id,result});};
 const log=async(result:string,tool='protocol',account:string|null=null)=>{await c.env.DB.prepare("INSERT INTO mcp_call_logs(id,connection_id,tool,account_id,kind,result,summary,at) VALUES(?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),row.id,tools.some(t=>t.name===tool)?tool:'unknown',account,tool==='request_broadcast_send'?'send_request':tool.endsWith('_draft')?'draft':'read',result,result==='ok'?'集計を読んだ':result==='rate_limited'?'回数の上限':'許可されていない操作',now).run();};
 // 拒否された呼出も含め、計数と INSERT を同じトランザクションへ入れる。
 const attempt=crypto.randomUUID();const claimed=await c.env.DB.batch([
 c.env.DB.prepare("INSERT INTO mcp_call_logs(id,connection_id,tool,kind,result,summary,at) SELECT ?,?,'protocol','read','ok','接続の呼び出し',? WHERE (SELECT count(*) FROM mcp_call_logs WHERE connection_id=? AND tool='protocol' AND julianday(at)>julianday(?,'-1 minute'))<60").bind(attempt,row.id,now,row.id,now)]);
 if(!claimed[0].meta.changes){await log('rate_limited');return c.json({error:'rate_limited'},429);}
 if(b.method==='initialize')return finish({protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:false}},serverInfo:{name:'musubo',version:'1.0.0'}});
 if(b.method==='notifications/initialized')return c.body(null,202);
 if(b.method==='ping')return finish({});
 if(b.method==='tools/list')return finish({tools:tools.filter(t=>(row.level!=='read'||!t.name.endsWith('_draft'))&&(t.name!=='request_broadcast_send'||row.level==='send_request')).map(t=>({...t,inputSchema:{type:'object',properties:{accountId:{type:'string'},from:{type:'string'},to:{type:'string'},broadcastId:{type:'string'},title:{type:'string'},text:{type:'string'},targetTagId:{type:'string'},expectedVersion:{type:'integer'},idempotencyKey:{type:'string'},approverStaffId:{type:'string'},testMode:{type:'boolean'}},required:['accountId'],additionalProperties:false}}))});
 if(b.method!=='tools/call')return c.json({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}});
 const tool=typeof params?.name==='string'?params.name:'',args=params?.arguments&&typeof params.arguments==='object'&&!Array.isArray(params.arguments)?params.arguments:{},account=String(args.accountId??''),allowed=JSON.parse(row.account_ids_json) as string[];
 if(!tools.some(t=>t.name===tool)||(tool.endsWith('_draft')&&row.level==='read')||(tool==='request_broadcast_send'&&row.level!=='send_request')||!allowed.includes(account)||!await canAccessAllLineAccounts(c.env.DB,{id:row.created_by,tenantId:row.organization_id,role:'owner',name:'',readOnly:true},[account])||!await c.env.DB.prepare('SELECT id FROM line_accounts WHERE id=? AND tenant_id=? AND is_active=1 AND archived_at IS NULL AND data_purged_at IS NULL').bind(account,row.organization_id).first()){
 await log('refused',tool);return finish({isError:true,content:[{type:'text',text:'この操作は許可されていません'}]});}
 try{
 let data:unknown;
 if(tool==='request_broadcast_send'){data=await requestMcpBroadcast(c.env.DB,{connectionId:row.id,account,actor:row.created_by,args,now});return finish({content:[{type:'text',text:JSON.stringify(data)}]});}
 if(tool==='create_broadcast_draft'||tool==='update_broadcast_draft'){
  data=await mcpBroadcastDraft(c.env.DB,{connectionId:row.id,account,tool,args,now});
  return finish({content:[{type:'text',text:JSON.stringify(data)}]});
 }
 if(tool==='get_account_summary')data=await c.env.DB.prepare('SELECT count(*) friends,count(CASE WHEN is_following=1 THEN 1 END) following FROM friends WHERE line_account_id=?').bind(account).first();
 else if(tool==='list_tags')data=(await c.env.DB.prepare('SELECT t.id,t.name,(SELECT count(*) FROM friend_tags ft JOIN friends f ON f.id=ft.friend_id WHERE ft.tag_id=t.id AND f.line_account_id=?) count FROM tags t WHERE t.line_account_id=? AND t.archived_at IS NULL ORDER BY t.id LIMIT 100').bind(account,account).all()).results;
 else if(tool==='list_broadcasts')data=(await c.env.DB.prepare('SELECT id,title,status,sent_at FROM broadcasts WHERE line_account_id=? ORDER BY created_at DESC,id LIMIT 20').bind(account).all()).results;
 else if(tool==='get_broadcast_result')data=await c.env.DB.prepare('SELECT id,status,total_count totalRecipients,success_count sent,MAX(0,total_count-success_count) failed FROM broadcasts WHERE id=? AND line_account_id=?').bind(String(args.broadcastId??''),account).first();
 else {const period=comparisonPeriod(typeof args.from==='string'?args.from:undefined,typeof args.to==='string'?args.to:undefined),n=await storeNumbers(c.env.DB,account,period);data=tool==='get_booking_counts'?{bookings:n.values.bookings,visits:n.values.visits,noShowRate:n.values.noShowRate,computedAt:n.computedAt}:n.values;}
 await log('ok',tool,account);return finish({content:[{type:'text',text:JSON.stringify(data)}]});
 }catch{await log('error',tool,account);return finish({isError:true,content:[{type:'text',text:'操作を完了できませんでした'}]});}
});
