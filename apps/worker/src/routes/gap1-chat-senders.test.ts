import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import {Hono} from 'hono';
import {createTestD1,type SqliteD1} from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import {lineSenders} from './line-senders.js';
import {broadcastSendPreview} from '../services/gap-send-preview.js';
import {getBroadcastById} from '@line-crm/db';
const push=vi.hoisted(()=>vi.fn().mockResolvedValue({}));
vi.mock('@line-crm/line-sdk',()=>({LineClient:vi.fn().mockImplementation(function(){return {pushMessage:push};})}));
const {chats}=await import('./chats.js');
let d:SqliteD1;
const owner:AuthenticatedStaff={id:'o',name:'管理者',role:'owner',readOnly:false,tenantId:'t'};
function app(staff=owner,impersonate=false) {
 const a=new Hono<Env>();a.use('*',async(c,next)=>{c.env={DB:d.db} as Env['Bindings'];c.set('staff',staff);if(impersonate)c.set('impersonation',{id:'im',tenantId:'t',mode:'write',piiRevealed:true,startedAt:'2026-10-16'});await next();});
 a.route('/',lineSenders);a.route('/',chats);return a;
}
function call(path:string,method='GET',body?:unknown,staff=owner,im=false,key=crypto.randomUUID()) {
 return app(staff,im).request(path,{method,headers:{'Content-Type':'application/json','Idempotency-Key':key},...(body?{body:JSON.stringify(body)}:{})});
}
beforeEach(()=>{d=createTestD1();push.mockClear();d.raw.exec(`
 INSERT INTO tenants(id,name) VALUES('t','店'),('other','他店');
 INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES('a','ch','店','token','secret','t'),('b','ch2','他店','token','secret','other');
 INSERT INTO staff_members(id,name,role,api_key,tenant_id,account_scope,permission_keys) VALUES('o','管理者','owner','key','t','all','[]'),('s','担当','staff','staffkey','t','all','["/chats"]');
 INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES('f','Uf','お客さま','a'),('f2','Uf2','他店','b');
 INSERT INTO chats(id,friend_id,status,created_at,updated_at) VALUES('c','f','unread',datetime('now'),datetime('now'));
 INSERT INTO messages_log(id,friend_id,direction,message_type,content,source,line_account_id) VALUES('m','f','outgoing','text','誤り','manual','a'),('m2','f2','outgoing','text','別','manual','b');
 `);});
afterEach(()=>d.raw.close());
const staff={...owner,id:'s',role:'staff' as const,permissionKeys:['/chats']};
test('UNS-01 UNS-02: 即時送信・訂正元を保存し元を残す',async()=>{
 const r=await call('/api/chats/c/send','POST',{content:'正しい文',correctionOfMessageId:'m'});
 expect(r.status).toBe(200);expect(push).toHaveBeenCalledTimes(1);
 expect(d.raw.prepare('SELECT correction_of_message_id FROM messages_log WHERE content=?').get('正しい文')).toEqual({correction_of_message_id:'m'});
 expect(d.raw.prepare('SELECT content FROM messages_log WHERE id=?').get('m')).toEqual({content:'誤り'});
 const detail=await (await call('/api/chats/c')).json() as any;expect(detail.data.messages.find((m:any)=>m.id==='m').corrections).toHaveLength(1);
});
test('UNS-02: 他人の訂正元は拒否し送信も保存もしない',async()=>{expect((await call('/api/chats/c/send','POST',{content:'正',correctionOfMessageId:'m2'})).status).toBe(404);expect(push).not.toHaveBeenCalled();});
test('UNS-04 UNS-05: 60秒の境界をDBの条件付き更新で守る',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
 try {
 for(const [id,seconds,expected] of [['early',61,200],['edge',60,200],['late',59,409]] as const){
  const r=await call('/api/chats/c/schedule','POST',{content:id,scheduledAt:new Date(Date.now()+seconds*1000).toISOString()});expect(r.status).toBe(200);
  const b=await r.json() as any;const cancel=await call(`/api/chats/c/scheduled/${b.data.id}`,'DELETE');expect(cancel.status).toBe(expected);
  if(expected===409)expect(await cancel.json()).toMatchObject({code:'SCHEDULE_TOO_LATE'});
 }
 } finally {vi.useRealTimers();}
});
test('UNS-18: 代理書き込みも送信を拒否、理由付き予約取消は許可',async()=>{
 expect((await call('/api/chats/c/send','POST',{content:'正'},owner,true)).status).toBe(403);expect(push).not.toHaveBeenCalled();
 const b=await (await call('/api/chats/c/schedule','POST',{content:'予約',scheduledAt:new Date(Date.now()+600000).toISOString()})).json() as any;
 expect((await call(`/api/chats/c/scheduled/${b.data.id}`,'DELETE',undefined,owner,true)).status).toBe(400);
 const r=await app(owner,true).request(`/api/chats/c/scheduled/${b.data.id}`,{method:'DELETE',headers:{'X-Impersonation-Reason':'cancel-before-send'}});expect(r.status).toBe(200);
 expect(d.raw.prepare('SELECT cancellation_reason FROM scheduled_chat_sends WHERE id=?').get(b.data.id)).toEqual({cancellation_reason:'cancel-before-send'});
});
test('UNS-06 UNS-09 UNS-12: 配信の送れる人数・除外・承認、壊れた条件は0にしない',async()=>{
 d.raw.exec(`INSERT INTO broadcasts(id,title,message_type,message_content,target_type,line_account_id,status) VALUES('bc','配信','text','本文','all','a','draft');
 INSERT INTO friends(id,line_user_id,line_account_id,is_following) VALUES('blocked','Ublocked','a',0);
 INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('a','f','marketing','revoked','停止','manual');`);
 const p=await broadcastSendPreview(d.db,(await getBroadcastById(d.db,'bc'))!);expect(p.recipients).toBe(0);expect(p.excluded).toMatchObject({blocked:1,optedOut:1});expect(push).not.toHaveBeenCalled();
 d.raw.exec("UPDATE broadcasts SET target_type='segment',segment_conditions='broken' WHERE id='bc'");
 await expect(broadcastSendPreview(d.db,(await getBroadcastById(d.db,'bc'))!)).rejects.toThrow();
});
test('SND-01 SND-15: 同じ追加は1件、違う内容のキー再利用は409',async()=>{
 const key=crypto.randomUUID(),body={name:'渋谷店 予約係',visibility:'all'};
 expect((await call('/api/line-accounts/a/senders','POST',body,owner,false,key)).status).toBe(201);
 expect((await call('/api/line-accounts/a/senders','POST',body,owner,false,key)).status).toBe(201);
 expect((await call('/api/line-accounts/a/senders','POST',{...body,name:'別'},owner,false,key)).status).toBe(409);
 expect(d.raw.prepare('SELECT COUNT(*) n FROM line_senders').get()).toEqual({n:1});
});
test.each(['あ'.repeat(21),'LINE サポート','ライン担当','　','😀'])('SND-02 SND-03: 不正な名前 %s を拒否',async name=>{expect((await call('/api/line-accounts/a/senders','POST',{name,visibility:'all'})).status).toBe(400);});
test('SND-10 SND-11 SND-12 SND-13: 本人だけ・閲覧のみ・代理・他店の境界',async()=>{
 expect((await call('/api/line-accounts/a/senders','POST',{name:'係',visibility:'all'},staff)).status).toBe(403);
 const b=await (await call('/api/line-accounts/a/senders','POST',{name:'担当本人',visibility:'owner_only'},staff)).json() as any;
 expect((await call('/api/chats/c/send','POST',{content:'顔',senderId:b.data.id},{...staff,id:'other'})).status).toBe(403);
 for(const [who,im] of [[{...owner,readOnly:true},false],[owner,true]] as const)expect((await call('/api/line-accounts/a/senders','POST',{name:'係',visibility:'all'},who,im)).status).toBe(403);
 expect((await call('/api/line-accounts/b/senders')).status).toBe(404);
});
test('SND-05 SND-14 SND-08: 送り手をLINEと履歴に保存し、古い版・使用停止を拒否',async()=>{
 const b=await (await call('/api/line-accounts/a/senders','POST',{name:'予約係',visibility:'all'})).json() as any,id=b.data.id;
 expect((await call('/api/chats/c/send','POST',{content:'顔',senderId:id})).status).toBe(200);expect(push.mock.calls[0][1][0].sender).toEqual({name:'予約係'});
 expect(d.raw.prepare('SELECT sender_id,sender_snapshot_json FROM messages_log WHERE content=?').get('顔')).toEqual({sender_id:id,sender_snapshot_json:'{"name":"予約係"}'});
 expect((await call(`/api/line-accounts/a/senders/${id}`,'PUT',{name:'新',expectedVersion:1})).status).toBe(200);
 expect((await call(`/api/line-accounts/a/senders/${id}`,'PUT',{name:'旧',expectedVersion:1})).status).toBe(409);
 expect((await call(`/api/line-accounts/a/senders/${id}`,'DELETE',{expectedVersion:2})).status).toBe(200);
 expect((await call('/api/chats/c/send','POST',{content:'止',senderId:id})).status).toBe(404);
 expect(d.raw.prepare('SELECT sender_snapshot_json FROM messages_log WHERE content=?').get('顔')).toEqual({sender_snapshot_json:'{"name":"予約係"}'});
});
test('SND-17: 同時に追加しても21件目を作らない',async()=>{const results=await Promise.all(Array.from({length:21},(_,i)=>call('/api/line-accounts/a/senders','POST',{name:`係${i}`,visibility:'all'})));expect(results.filter(r=>r.status===201)).toHaveLength(20);expect(results.filter(r=>r.status===409)).toHaveLength(1);});
test('SND-18: 大きな画像・非正方形・別店の画像は保存しない',async()=>{
 d.raw.exec("INSERT INTO media(id,kind,filename,mime_type,size_bytes,width,height,r2_key,public_url,line_account_id) VALUES('big','image','big','image/png',3000000,100,100,'big','https://example.test/icon.png','a')");
 expect((await call('/api/line-accounts/a/senders','POST',{name:'係',visibility:'all',iconMediaId:'big'})).status).toBe(400);
});
test('UNS-06 UNS-09 UNS-13 UNS-21: 1万人はSQLで集計し、古い人数の確定を送信前に拒否',async()=>{
 d.raw.exec(`WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<9999)
 INSERT INTO friends(id,line_user_id,line_account_id) SELECT 'many-'||x,'Umany-'||x,'a' FROM n;
 INSERT INTO broadcasts(id,title,message_type,message_content,target_type,line_account_id,status) VALUES('many','配信','text','本文','all','a','draft');`);
 const started=performance.now(),p=await broadcastSendPreview(d.db,(await getBroadcastById(d.db,'many'))!);
 expect(p.recipients).toBe(10000);expect(p.needsApproval).toBe(true);expect(performance.now()-started).toBeLessThan(3000);
 const {broadcasts}=await import('./broadcasts.js');
 const r=await gapBroadcastApp(broadcasts).request('/api/broadcasts/many/send',{method:'POST',headers:{'Content-Type':'application/json','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({expectedVersion:p.expectedVersion,confirmedRecipientCount:9999})});
 expect(r.status).toBe(409);expect(push).not.toHaveBeenCalled();expect(d.raw.prepare('SELECT status FROM broadcasts WHERE id=?').get('many')).toEqual({status:'draft'});
});
function gapBroadcastApp(route:Hono<Env>){const a=new Hono<Env>();a.use('*',async(c,next)=>{c.env={DB:d.db} as Env['Bindings'];c.set('staff',owner);await next();});a.route('/',route);return a;}
test('UNS-11: 21時30分の確認では翌朝8時へずらす（店舗の時間帯）',async()=>{
 const {broadcastQuietHoursShift}=await import('../services/gap-send-preview.js');
 expect(await broadcastQuietHoursShift(d.db,'a','2026-10-16T12:30:00Z')).toBe('2026-10-16T23:00:00.000Z');
 expect(await broadcastQuietHoursShift(d.db,'a','2026-10-16T23:00:00Z')).toBeNull();
});
test('SND-05 UNS-02: 複数の文章の1回送信でも全て同じ送り手・先頭に訂正元を残す',async()=>{
 const b=await (await call('/api/line-accounts/a/senders','POST',{name:'予約係',visibility:'all'})).json() as any;
 expect((await call('/api/chats/c/send-combined','POST',{texts:['訂正1','訂正2'],senderId:b.data.id,correctionOfMessageId:'m'})).status).toBe(200);
 expect(push.mock.calls[0][1].map((m:any)=>m.sender)).toEqual([{name:'予約係'},{name:'予約係'}]);
 expect(d.raw.prepare("SELECT correction_of_message_id FROM messages_log WHERE content='訂正1'").get()).toEqual({correction_of_message_id:'m'});
});
test('SND-19: 送り手が断られても勝手に送り手なしで再送しない',async()=>{
 const b=await (await call('/api/line-accounts/a/senders','POST',{name:'予約係',visibility:'all'})).json() as any;
 push.mockRejectedValueOnce(Object.assign(new Error('sender rejected'),{status:400}));
 const r=await call('/api/chats/c/send','POST',{content:'拒否',senderId:b.data.id});expect(r.status).toBeGreaterThanOrEqual(400);expect(push).toHaveBeenCalledTimes(1);expect(d.raw.prepare("SELECT COUNT(*) n FROM messages_log WHERE content='拒否'").get()).toEqual({n:0});
});
test('UNS-11: 夜の確定は送らず翌朝の予約にする',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T12:30:00Z'));
 try {
 d.raw.exec("INSERT INTO broadcasts(id,title,message_type,message_content,target_type,line_account_id,status) VALUES('night','配信','text','本文','all','a','draft')");
 const {broadcasts}=await import('./broadcasts.js');const r=await gapBroadcastApp(broadcasts).request('/api/broadcasts/night/send',{method:'POST',headers:{'Content-Type':'application/json','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({expectedVersion:1,confirmedRecipientCount:1})});
 expect(r.status).toBe(200);expect(await r.json()).toMatchObject({data:{scheduled:true,scheduledAt:'2026-10-16T23:00:00.000Z'}});expect(push).not.toHaveBeenCalled();
 }finally{vi.useRealTimers();}
});
test('SND-20: アイコンの保管後はアカウントの送り手で送る',async()=>{
 d.raw.exec("INSERT INTO media(id,kind,filename,mime_type,size_bytes,width,height,r2_key,public_url,line_account_id) VALUES('icon','image','icon','image/png',1000,100,100,'icon','https://example.test/icon.png','a')");
 const b=await (await call('/api/line-accounts/a/senders','POST',{name:'係',visibility:'all',iconMediaId:'icon'})).json() as any;
 d.raw.exec("UPDATE media SET archived_at=datetime('now') WHERE id='icon'");
 expect((await (await call('/api/line-accounts/a/senders')).json() as any).data[0].iconMissing).toBe(true);
 expect((await call('/api/chats/c/send','POST',{content:'顔なし',senderId:b.data.id})).status).toBe(200);expect(push.mock.calls[0][1][0]).not.toHaveProperty('sender');
});

test('UNS-17: 配信の閲覧権限だけの担当は送信を開始できない',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));
 try{
  d.raw.exec("INSERT INTO broadcasts(id,title,message_type,message_content,target_type,line_account_id,status) VALUES('limited','配信','text','本文','all','a','draft')");
  const {broadcasts}=await import('./broadcasts.js');
  const a=new Hono<Env>();a.use('*',async(c,next)=>{c.env={DB:d.db} as Env['Bindings'];c.set('staff',{...staff,permissionKeys:['/broadcasts']});await next();});a.route('/',broadcasts);
  const r=await a.request('/api/broadcasts/limited/send',{method:'POST',headers:{'Content-Type':'application/json','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({expectedVersion:1,confirmedRecipientCount:1})});
  expect(r.status).toBe(403);expect(push).not.toHaveBeenCalled();expect(d.raw.prepare("SELECT status FROM broadcasts WHERE id='limited'").get()).toEqual({status:'draft'});
 }finally{vi.useRealTimers();}
});

test('G4-16: 担当者の個別返信をmanualとして履歴へ保存する',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));
 try{
  const r=await call('/api/chats/c/send','POST',{content:'担当からの返事'},staff);
  expect(r.status).toBe(200);expect(push).toHaveBeenCalledTimes(1);
  expect(d.raw.prepare("SELECT direction,source FROM messages_log WHERE content='担当からの返事'").get()).toEqual({direction:'outgoing',source:'manual'});
 }finally{vi.useRealTimers();}
});
