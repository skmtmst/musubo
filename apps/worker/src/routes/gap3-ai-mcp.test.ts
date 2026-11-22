import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {gapFixture,gapApp,gapCall,gapOwner} from '../test-utils/gap1.js';
import {aiDrafts} from './ai-drafts.js';
import {aiAnswerLogs} from './ai-answer-logs.js';
import {mcpConnections} from './mcp-connections.js';
import {mcpRpc} from './mcp-rpc.js';
import {sha256Hex,permissionForApiPath,gap2ReadOperation} from '../middleware/auth.js';
import {isStepUpPurpose} from '../lib/step-up.js';
import {adminAuth} from './admin-auth.js';
let d:ReturnType<typeof gapFixture>;
beforeEach(()=>{d=gapFixture();vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('external_forbidden');}));});
afterEach(()=>{d.raw.close();vi.unstubAllGlobals();});
const app=(s=gapOwner,im=false)=>gapApp(d,[aiDrafts,aiAnswerLogs,mcpConnections,mcpRpc,adminAuth],s,im);
async function session(){const hash=await sha256Hex('test-session');d.raw.prepare('INSERT INTO admin_sessions(token_hash,staff_id,expires_at,step_up_at) VALUES(?,?,?,?)').run(hash,'o',new Date(Date.now()+3600000).toISOString(),new Date().toISOString());}
async function manage(path:string,body:unknown){return app().request(path,{method:'POST',headers:{Authorization:'Bearer lh_session:test-session','Content-Type':'application/json'},body:JSON.stringify(body)});}
async function create(){await session();const r=await manage('/api/mcp-connections?account_id=a',{name:'分析用',level:'read',expiryDays:90});const b=await r.json() as any;expect(r.status,JSON.stringify(b)).toBe(201);return b.data;}
async function rpc(key:string,name:string,args:Record<string,unknown>){return app().request('/mcp',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});}
test('AI-09/10/14/20/21: {items,total}と記録のQA・afterNote、代理では質問と回答を伏せる',async()=>{
 const created=await gapCall(app(),'/api/qa-entries?account_id=a','POST',{questions:['営業時間'],answer:'18時まで'},'qa');const q=(await created.json() as any).data;
 d.raw.prepare("INSERT INTO ai_answer_logs(id,account_id,friend_id,question_text,action,qa_entry_id,qa_version,answer_snapshot_json,after_note,created_at) VALUES('log','a','f','営業時間','answered',?,1,?,'後でお客さまが人を呼んだ','2026-10-16')").run(q.id,'[{"type":"text","text":"前の回答"}]');
 const list=(await (await gapCall(app(),'/api/qa-entries?account_id=a')).json() as any).data;expect(list.total).toBe(1);expect(list.items[0].id).toBe(q.id);
 const logs=(await (await gapCall(app(),'/api/ai-answer-logs?account_id=a')).json() as any).data;expect(logs.total).toBe(1);expect(logs.items[0].qaTitle).toBe('営業時間');
 const detail=(await (await gapCall(app(),'/api/ai-answer-logs/log?account_id=a')).json() as any).data;expect(detail).toMatchObject({answerText:'前の回答',afterNote:'後でお客さまが人を呼んだ',qa:{id:q.id,currentAnswerText:'18時まで'}});
 const masked=(await (await gapCall(app(gapOwner,true),'/api/ai-answer-logs/log?account_id=a')).json() as any).data;expect(masked.answerText).toBeNull();expect(masked.questionText).toBe('（非表示）');
 expect((await gapCall(app(),'/api/ai-answer-logs/log?account_id=b')).status).toBe(404);expect(isStepUpPurpose('ai.settings')).toBe(true);expect(isStepUpPurpose('mcp.connection')).toBe(true);expect(fetch).not.toHaveBeenCalled();
});
test('MCP-01/02/03/06/07: 再確認・鍵は一度だけ表示、ハッシュ保存と権限外操作の拒否',async()=>{
 expect((await gapCall(app(),'/api/mcp-connections?account_id=a','POST',{name:'分析用',level:'read'})).status).toBe(401);
 const {key,connection}=await create();expect(key).toMatch(/^mcp_[a-f0-9]{64}$/);expect(JSON.stringify(d.raw.prepare('SELECT * FROM mcp_connections').all())).not.toContain(key);
 const list=await gapCall(app(),'/api/mcp-connections?account_id=a');expect(JSON.stringify(await list.json())).not.toContain(key);
 let response=await rpc(key,'get_account_summary',{accountId:'a'});expect(JSON.parse((await response.json() as any).result.content[0].text)).toEqual({friends:2,following:2});
 response=await rpc(key,'get_account_summary',{accountId:'b'});expect((await response.json() as any).result.isError).toBe(true);
 response=await rpc(key,'send_message',{accountId:'a',text:'個人情報の文章'});expect((await response.json() as any).result.isError).toBe(true);expect(JSON.stringify(d.raw.prepare('SELECT * FROM mcp_call_logs').all())).not.toContain('個人情報');
 expect((await gapCall(app({...gapOwner,readOnly:true}),`/api/mcp-connections/${connection.id}/stop?account_id=a`,'POST',{expectedVersion:1})).status).toBe(403);
 expect((await gapCall(app(gapOwner,true),'/api/mcp-connections?account_id=a','POST',{name:'禁止',level:'read'})).status).toBe(403);expect(fetch).not.toHaveBeenCalled();
});
test('MCP-08/09/12/16: 鍵の入替24時間・停止即時・他店の記録を読めない',async()=>{
 const first=await create(),id=first.connection.id;
 const rotated=await manage(`/api/mcp-connections/${id}/rotate?account_id=a`,{expectedVersion:1});expect(rotated.status).toBe(200);const second=(await rotated.json() as any).data;
 expect((await rpc(first.key,'get_account_summary',{accountId:'a'})).status).toBe(200);
 d.raw.exec("UPDATE mcp_connections SET previous_key_expires_at='2000-01-01'");expect((await rpc(first.key,'get_account_summary',{accountId:'a'})).status).toBe(401);expect((await rpc(second.key,'get_account_summary',{accountId:'a'})).status).toBe(200);
 expect((await gapCall(app(),`/api/mcp-connections/logs?account_id=b&connectionId=${id}`)).status).toBe(404);
 expect((await gapCall(app(gapOwner,true),`/api/mcp-connections/${id}/stop?account_id=a`,'POST',{expectedVersion:2,reason:'緊急停止'})).status).toBe(200);expect((await rpc(second.key,'get_account_summary',{accountId:'a'})).status).toBe(401);
});
test('GAP3-AUTH-01: 新しい読取口を権限へ接続し、previewを閲覧と分けて扱う',()=>{
 expect(permissionForApiPath('/api/line-accounts/a/sender-icons')).toBe('/chats');expect(permissionForApiPath('/api/analytics/customer-segments')).toBe('/analytics');expect(permissionForApiPath('/api/friends/f/member-rank')).toBe('/mileage');expect(gap2ReadOperation('POST','/api/member-ranks/preview')).toBe(true);
});

test('MCP connection cannot authenticate during purge and remains stopped after resumption',async()=>{
 const {processTenantDataPurge}=await import('../services/tenant-data-purge.js');
 const {key,connection}=await create();
 expect((await rpc(key,'get_account_summary',{accountId:'a'})).status).toBe(200);
 d.raw.exec("UPDATE tenants SET purge_started_at='2027-01-01' WHERE id='t'");
 expect((await rpc(key,'get_account_summary',{accountId:'a'})).status).toBe(401);
 d.raw.exec("UPDATE tenants SET plan_status='canceled',purge_requested_at='2026-01-01' WHERE id='t'");
 const result=await processTenantDataPurge({DB:d.db},{now:'2027-05-01T00:00:00Z'});
 expect(result.completed).toBe(1);
 expect(d.raw.prepare('SELECT status FROM mcp_connections WHERE id=?').get(connection.id)).toEqual({status:'stopped'});
 expect((d.raw.prepare('SELECT count(*) AS n FROM mcp_call_logs WHERE connection_id=?').get(connection.id) as {n:number}).n).toBeGreaterThan(0);
 d.raw.exec("UPDATE tenants SET data_purged_at=NULL,plan_status='active' WHERE id='t'");
 expect((await rpc(key,'get_account_summary',{accountId:'a'})).status).toBe(401);
});
