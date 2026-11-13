import {beforeEach,afterEach,test,expect,vi} from 'vitest';
import {aiDrafts} from './ai-drafts.js';
import {maskAiText} from '../services/ai-drafts.js';
import {gapFixture,gapApp,gapCall,gapOwner} from '../test-utils/gap1.js';
import type {SqliteD1} from '../test-utils/d1-sqlite.js';
let d:SqliteD1;const setting='/api/ai-settings?account_id=a';
const app=(who=gapOwner,im=false)=>{const a=gapApp(d,[aiDrafts],who,im);a.use('*',async()=>{});return a;};
beforeEach(()=>{d=gapFixture();d.raw.exec("INSERT INTO chats(id,friend_id,created_at,updated_at) VALUES('chat','f',datetime('now'),datetime('now'));INSERT INTO messages_log(id,friend_id,line_account_id,direction,message_type,content) VALUES('msg','f','a','incoming','text','お客さま 090-0000-5678 test@example.com 東京都千代田区1-2-3')");vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('external_forbidden');}));});
afterEach(()=>{d.raw.close();vi.unstubAllGlobals();});
test('AI-01 AI-02 AI-08 AI-22 Q-01: 初期off・確認・古い版・代理オン禁止、自動応答は未実装で閉じる',async()=>{
 expect((await (await gapCall(app(),setting)).json() as any).data.mode).toBe('off');expect((await gapCall(app(),setting,'PUT',{mode:'draft_only',expectedVersion:0})).status).toBe(400);
 expect((await gapCall(app(),setting,'PUT',{mode:'draft_only',expectedVersion:0,confirmed:true})).status).toBe(200);expect((await gapCall(app(),setting,'PUT',{mode:'draft_only',expectedVersion:0,confirmed:true})).status).toBe(409);
 expect((await gapCall(app({...gapOwner,role:'admin'}),setting,'PUT',{mode:'auto_qa',expectedVersion:1,confirmed:true})).status).toBe(403);expect((await gapCall(app(),setting,'PUT',{mode:'auto_qa',expectedVersion:1,confirmed:true})).status).toBe(409);
 expect((await gapCall(app(gapOwner,true),setting,'PUT',{mode:'draft_only',expectedVersion:1,confirmed:true})).status).toBe(403);
 expect((await gapCall(app(gapOwner,true),setting,'PUT',{mode:'off',expectedVersion:1,reason:'緊急停止'})).status).toBe(200);
});
test('AI-21 AI-27: staffは下書きまで・公開は管理者・古い版409・履歴は停止で残す',async()=>{
 const staff={...gapOwner,id:'s',role:'staff' as const,permissionKeys:['/auto-replies']};
 const r=await gapCall(app(staff),'/api/qa-entries?account_id=a','POST',{questions:['営業時間'],answer:'18時までです'},'qa');expect(r.status).toBe(201);const id=(await r.json() as any).data.id;
 expect((await gapCall(app(staff),`/api/qa-entries/${id}/publish?account_id=a`,'POST',{expectedVersion:1})).status).toBe(403);
 expect((await gapCall(app(),`/api/qa-entries/${id}/publish?account_id=a`,'POST',{expectedVersion:1})).status).toBe(200);expect((await gapCall(app(),`/api/qa-entries/${id}?account_id=a`,'PUT',{questions:['時間'],answer:'17時',expectedVersion:1})).status).toBe(409);
 expect((await gapCall(app(),`/api/qa-entries/${id}?account_id=a`,'DELETE',{expectedVersion:2})).status).toBe(200);expect(d.raw.prepare('SELECT status FROM qa_entries').get()).toEqual({status:'stopped'});
});
test('AI-03 AI-13 AI-20: 要約は伏せた形・返信案は閲覧と代理を拒否',async()=>{
 expect(maskAiText('佐藤 090-0000-5678 x@example.com 東京都千代田区1-2-3',['佐藤'])).not.toMatch(/佐藤|090|@|千代田/);
 for(const [who,im] of [[{...gapOwner,readOnly:true},false],[gapOwner,true]] as const)expect((await gapCall(app(who,im),'/api/chats/chat/ai/draft','POST',{})).status).toBe(403);
 expect((await gapCall(app(),'/api/chats/chat/ai/summary','POST',{})).status).toBe(409);expect(fetch).not.toHaveBeenCalled();
});
test('AI-03 AI-29: 模擬OpenAIの返信案には使った根拠。LINE送信と本文保存は0',async()=>{
 const {makeAiDraft}=await import('../services/ai-drafts.js');await gapCall(app(),setting,'PUT',{mode:'draft_only',expectedVersion:0,confirmed:true});
 d.raw.exec(`INSERT INTO qa_entries(id,account_id,questions_json,answer_messages_json,status,created_by,updated_at,idempotency_key) VALUES('qa','a','["営業時間"]','[{"type":"text","text":"18時です"}]','published','o',datetime('now'),'qa')`);
 let payload='';vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');payload=String(init.body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({text:'18時までです',sourceIds:['qa']})}}]}));}));
 const r=await makeAiDraft(d.db,{account:'a',friend:'f',chat:'chat',kind:'draft',apiKey:'fake-test-key',masked:false,providerEnabled:true}) as any;expect(r.sources).toEqual([{type:'qa',id:'qa',title:'営業時間'}]);expect(payload).not.toMatch(/090-1234|test@example|千代田/);expect(d.raw.prepare('SELECT count(*) n FROM messages_log').get()).toEqual({n:1});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:429})));await expect(makeAiDraft(d.db,{account:'a',friend:'f',chat:'chat',kind:'draft',apiKey:'fake-test-key',masked:false,providerEnabled:true})).rejects.toThrow('ai_rate_limit');
});

test.each([3999,4000,4500])('conversation content remains within 4000 characters with newest length %i',async length=>{
 const {makeAiDraft}=await import('../services/ai-drafts.js');
 await gapCall(app(),setting,'PUT',{mode:'draft_only',expectedVersion:0,confirmed:true});
 d.raw.exec('DELETE FROM messages_log');
 const insert=d.raw.prepare("INSERT INTO messages_log(id,friend_id,line_account_id,direction,message_type,content,created_at) VALUES(?,'f','a','incoming','text',?,?)");
 insert.run('old','o'.repeat(10000),'2026-01-01');insert.run('new','n'.repeat(length),'2026-01-02');
 let conversation:Array<{id:string;text:string}>=[];
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{
   const request=JSON.parse(String(init.body));conversation=JSON.parse(request.messages[1].content).conversation;
   return Response.json({choices:[{message:{content:JSON.stringify({text:'案',sourceIds:[]})}}]});
 }));
 await makeAiDraft(d.db,{account:'a',friend:'f',chat:'chat',kind:'draft',apiKey:'fake-test-key',masked:false,providerEnabled:true});
 expect(conversation.reduce((n,row)=>n+row.text.length,0)).toBe(4000);
 expect(conversation.at(-1)).toEqual({id:'new',role:'お客さま',text:'n'.repeat(Math.min(length,4000))});
 if(length>=4000)expect(conversation).toHaveLength(1);
});

test('Q&A content has an independent character budget and output retains its token budget',async()=>{
 const {makeAiDraft}=await import('../services/ai-drafts.js');
 await gapCall(app(),setting,'PUT',{mode:'draft_only',expectedVersion:0,confirmed:true});
 d.raw.prepare("INSERT INTO qa_entries(id,account_id,questions_json,answer_messages_json,status,created_by,updated_at,idempotency_key) VALUES('qa','a',?,?,'published','o',datetime('now'),'qa')")
  .run(JSON.stringify(['q'.repeat(8000)]),JSON.stringify([{type:'text',text:'a'.repeat(8000)}]));
 let references:Array<{questions:string;answer:string}>=[];
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{
  const request=JSON.parse(String(init.body));references=JSON.parse(request.messages[1].content).qa;
  expect(request.max_completion_tokens).toBe(1500);
  return Response.json({choices:[{message:{content:JSON.stringify({text:'案',sourceIds:[]})}}]});
 }));
 await makeAiDraft(d.db,{account:'a',friend:'f',chat:'chat',kind:'draft',apiKey:'fake-test-key',masked:false,providerEnabled:true});
 expect(references.reduce((n,q)=>n+q.questions.length+q.answer.length,0)).toBe(4000);
});
