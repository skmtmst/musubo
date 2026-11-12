import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {gapFixture,gapApp,gapCall,gapOwner} from '../test-utils/gap1.js';
import {aiDrafts} from './ai-drafts.js';
import {aiAnswerLogs} from './ai-answer-logs.js';
import {evaluateQa,simulateQa} from '../services/ai-auto-qa.js';
import {sha256Hex} from '../middleware/auth.js';
let d:ReturnType<typeof gapFixture>;
const app=(s=gapOwner,im=false)=>gapApp(d,[aiDrafts,aiAnswerLogs],s,im);
const path='/api/ai-settings?account_id=a',now=new Date('2026-10-16T02:00:00Z');
beforeEach(()=>{
 d=gapFixture();vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('external_forbidden');}));
 d.raw.exec(`INSERT INTO chats(id,friend_id,created_at,updated_at) VALUES('chat','f','now','now'),('chat2','f2','now','now');
 INSERT INTO qa_entries(id,account_id,questions_json,answer_messages_json,status,created_by,updated_at,idempotency_key) VALUES('qa','a','["駐車場"]','[{"type":"text","text":"裏に2台分あります"}]','published','o','now','qa');
 INSERT INTO ai_settings(account_id,mode,updated_by,handoff_message) VALUES('a','auto_qa','o','担当から返信します');`);
});
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();d.raw.close();vi.unstubAllGlobals();});
const simulate=(eventId:string,question='駐車場',more:Partial<Parameters<typeof simulateQa>[1]>={})=>simulateQa(d.db,{account:'a',chatId:'chat',eventId,question,now,...more});
test('AI-07/08/22/23: 模擬のオンはオーナー・本人確認・公開QA・確認が必須、代理停止は理由を記録',async()=>{
 d.raw.exec('DELETE FROM ai_settings');
 const body={mode:'auto_qa',confirmed:true,testMode:true,expectedVersion:0};
 expect((await gapCall(app(),path,'PUT',body)).status).toBe(401);
 expect((await gapCall(app({...gapOwner,role:'admin'}),path,'PUT',body)).status).toBe(403);
 expect((await gapCall(app({...gapOwner,readOnly:true}),path,'PUT',body)).status).toBe(403);
 expect((await gapCall(app(gapOwner,true),path,'PUT',body)).status).toBe(403);
 const hash=await sha256Hex('session');d.raw.prepare('INSERT INTO admin_sessions(token_hash,staff_id,expires_at,step_up_at) VALUES(?,?,?,?)').run(hash,'o',new Date(Date.now()+3600000).toISOString(),new Date().toISOString());
 const put=(b:unknown)=>app().request(path,{method:'PUT',headers:{Authorization:'Bearer lh_session:session','Content-Type':'application/json'},body:JSON.stringify(b)});
 expect((await put({...body,testMode:false})).status).toBe(409);expect((await put({...body,confirmed:false})).status).toBe(400);
 d.raw.exec("UPDATE qa_entries SET status='draft'");expect((await put(body)).status).toBe(409);d.raw.exec("UPDATE qa_entries SET status='published'");
 const response=await put(body);expect(response.status).toBe(200);expect((await response.json() as any).data).toMatchObject({mode:'auto_qa',testMode:true,autoReplyAvailable:false});expect((await put(body)).status).toBe(409);
 expect((await gapCall(app(gapOwner,true),path,'PUT',{mode:'off',expectedVersion:1,reason:'緊急停止'})).status).toBe(200);
 const audit=d.raw.prepare('SELECT detail_json FROM operation_audit ORDER BY rowid DESC LIMIT 1').get() as any;expect(JSON.parse(audit.detail_json)).toMatchObject({impersonationId:'im',reason:'緊急停止'});
});
test('AI-09/17/19: 公開QAそのままを模擬・二重再送しない・古い控えは後の編集で変わらない',async()=>{
 const first=await simulate('event');expect(first).toMatchObject({action:'answered',messages:[{type:'text',text:'裏に2台分あります'}],sent:false,testMode:true,replayed:false});
 expect(await simulate('event')).toMatchObject({...first,replayed:true});await expect(simulate('event','違う内容')).rejects.toMatchObject({code:'idempotency_conflict'});
 expect(await simulate('keyword','駐車場',{keywordMatched:true})).toMatchObject({skipped:'keyword_matched'});expect(d.raw.prepare('SELECT count(*) n FROM ai_answer_logs').get()).toEqual({n:1});
 d.raw.exec(`UPDATE qa_entries SET answer_messages_json='[{"type":"text","text":"今は1台です"}]',version=2`);
 expect(await simulate('new')).toMatchObject({messages:[{type:'text',text:'今は1台です'}]});expect(await simulate('event')).toMatchObject({messages:[{type:'text',text:'裏に2台分あります'}]});
 const logs=(await (await gapCall(app(),'/api/ai-answer-logs?account_id=a')).json() as any).data;expect(logs.summary.answered).toBe(0);expect(logs.items.every((r:any)=>r.testMode)).toBe(true);
 expect(d.raw.prepare('SELECT use_count FROM qa_entries').get()).toEqual({use_count:0});expect(d.raw.prepare('SELECT count(*) n FROM messages_log').get()).toEqual({n:0});
});
test('AI-10/11/12/13/14: 危険な質問は一致QAがあっても人へ。電話・名前は記録で伏せる',async()=>{
 for(const [question,reason] of [['返金してください','money'],['明日の予約を変えたい','booking_change'],['090-0000-5678 に連絡','pii'],['住所はどこ','pii'],['知らない質問','low_confidence']]){
  if(reason!=='low_confidence')d.raw.prepare("UPDATE qa_entries SET questions_json=?").run(JSON.stringify([question]));
  expect(await evaluateQa(d.db,'a',question)).toMatchObject({action:'handed_off',handoffReason:reason,qa:null});
 }
 const complaints=['最悪です','対応が悪い','苦情です','ひどい','酷い扱い','怒っています','ふざけるな','詐欺だ','許せない','クレームです','不満です','失礼ですね','納得できない','二度と使わない','責任を取れ','謝罪して','訴えます','馬鹿にするな','ムカつく','あり得ない'];
 for(const q of complaints)expect(await evaluateQa(d.db,'a',q)).toMatchObject({handoffReason:'complaint'});
 expect(await simulate('pii','お客さま 090-0000-5678')).toMatchObject({handoffReason:'pii'});expect(JSON.stringify(d.raw.prepare('SELECT * FROM ai_answer_logs').all())).not.toContain('090-1234');
});
test('AI-15/16/30/31/33: 入力の借用・30分3回・24時間の人希望・月の上限は並行実行でも守る',async()=>{
 d.raw.exec("INSERT INTO inbox_reply_leases(channel,conversation_id,staff_id,acquired_at,expires_at,conversation_revision) VALUES('line','chat','s','2026-10-16T01:59:30Z','2026-10-16T02:00:30Z',1)");
 expect(await simulate('typing')).toMatchObject({handoffReason:'typing'});d.raw.exec('DELETE FROM inbox_reply_leases');
 const results=await Promise.all(Array.from({length:5},(_,i)=>simulate('parallel'+i)));expect(results.filter(r=>'action'in r&&r.action==='answered')).toHaveLength(3);expect(results.filter(r=>'handoffReason'in r&&r.handoffReason==='rate')).toHaveLength(2);
 expect(await simulate('human','人と話したい')).toMatchObject({action:'customer_asked_human'});expect(await simulate('blocked','駐車場',{now:new Date(now.getTime()+1801000)})).toMatchObject({handoffReason:'customer_requested'});
 expect(await simulate('nextday','駐車場',{now:new Date(now.getTime()+86400001)})).toMatchObject({action:'answered'});
 d.raw.exec("UPDATE ai_settings SET monthly_limit_answers=4");expect(await simulate('monthly','駐車場',{chatId:'chat2'})).toMatchObject({action:'handed_off',handoffReason:'monthly_limit'});
 d.raw.exec("UPDATE ai_settings SET mode='suspended'");expect(await simulate('suspended','駐車場',{chatId:'chat2'})).toMatchObject({handoffReason:'suspended'});
});
test('AI-14/20/22: テストと模擬は同じ判定・模擬は閲覧と代理を拒否・別店拒否・記録は伏せる',async()=>{
 const tested=(await (await gapCall(app(),'/api/ai-settings/test?account_id=a','POST',{question:'予約をキャンセル'})).json() as any).data;expect(tested).toMatchObject({handoffReason:'booking_change',sent:false,testMode:true});
 const body={chatId:'chat',question:'駐車場',testMode:true},url='/api/ai-settings/simulate?account_id=a';
 for(const [s,im]of [[{...gapOwner,readOnly:true},false],[gapOwner,true]]as const)expect((await gapCall(app(s,im),url,'POST',body)).status).toBe(403);
 expect((await gapCall(app(),url,'POST',{...body,testMode:false})).status).toBe(400);expect((await gapCall(app(),url.replace('=a','=b'),'POST',body)).status).toBe(404);
 const response=await gapCall(app(),url,'POST',body,'same');expect(response.status).toBe(200);const id=(await response.json() as any).data.id;
 const log=(await (await gapCall(app(gapOwner,true),`/api/ai-answer-logs/${id}?account_id=a`)).json() as any).data;expect(log).toMatchObject({questionText:'（非表示）',answerText:null,afterNote:null,testMode:true});
});

test('AI-15: 入力の借用は1分・ほかの担当が外せない・本人だけ解放・閲覧と代理は禁止',async()=>{
 const url='/api/chats/chat/ai/typing',b={typing:true};
 const response=await gapCall(app(),url,'POST',b);expect(response.status).toBe(200);const data=(await response.json() as any).data;expect(Date.parse(data.expiresAt)-Date.now()).toBeGreaterThan(59000);
 const staff={...gapOwner,id:'s',role:'staff' as const,permissionKeys:['/chats']};
 expect((await gapCall(app(staff),url,'POST',b)).status).toBe(409);
 await gapCall(app(staff),url,'POST',{typing:false});expect(d.raw.prepare('SELECT staff_id FROM inbox_reply_leases').get()).toEqual({staff_id:'o'});
 for(const [s,im]of [[{...gapOwner,readOnly:true},false],[gapOwner,true]]as const)expect((await gapCall(app(s,im),url,'POST',b)).status).toBe(403);
 await gapCall(app(),url,'POST',{typing:false});expect(d.raw.prepare('SELECT count(*) n FROM inbox_reply_leases').get()).toEqual({n:0});
 expect((await gapCall(app(),'/api/chats/missing/ai/typing','POST',b)).status).toBe(404);
});
