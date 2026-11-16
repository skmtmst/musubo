import {beforeEach,afterEach,test,expect,vi} from 'vitest';
import {operatorPush} from './operator-push.js';
import {deliverOperatorPush,pushPayload} from '../services/operator-push.js';
import {sendWebPush} from '../services/web-push.js';
import {gapFixture,gapApp,gapCall,gapOwner} from '../test-utils/gap1.js';
import type {SqliteD1} from '../test-utils/d1-sqlite.js';
import {useSqliteClock} from '../test-utils/sqlite-clock.js';
let d:SqliteD1;let body:any;
const b64=(b:Uint8Array)=>Buffer.from(b).toString('base64url');
beforeEach(async()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-19T03:00:00Z'));d=gapFixture();useSqliteClock(d.raw,()=>new Date());d.raw.exec("INSERT INTO chats(id,friend_id,created_at,updated_at) VALUES('chat','f',datetime('now'),datetime('now'))");const key=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']) as CryptoKeyPair;body={endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{p256dh:b64(new Uint8Array(await crypto.subtle.exportKey('raw',key.publicKey) as ArrayBuffer)),auth:b64(crypto.getRandomValues(new Uint8Array(16)))},label:'試験端末'};vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('external_forbidden');}));});
afterEach(()=>{d.raw.close();vi.unstubAllGlobals();vi.useRealTimers();});
test('G4-01 G4-04 G4-14: 端末1件・本人だけ・代理で登録しない',async()=>{
 const url='/api/me/push/subscriptions';expect((await gapCall(gapApp(d,[operatorPush]),url,'POST',body)).status).toBe(201);expect((await gapCall(gapApp(d,[operatorPush]),url,'POST',body)).status).toBe(201);expect(d.raw.prepare('SELECT count(*) n FROM operator_push_subscriptions').get()).toEqual({n:1});expect((await gapCall(gapApp(d,[operatorPush],gapOwner,true),url,'POST',body)).status).toBe(403);
 expect((await gapCall(gapApp(d,[operatorPush],{...gapOwner,id:'s',role:'staff'}),url,'POST',body)).status).toBe(409);expect((await gapCall(gapApp(d,[operatorPush]),url,'POST',{...body,endpoint:'https://127.0.0.1/secret'})).status).toBe(400);
});
test('G4-05 G4-07 G4-11: 本文・個人情報なし、他店に届かず、410は外す',async()=>{
 await gapCall(gapApp(d,[operatorPush]),'/api/me/push/subscriptions','POST',body);const send=vi.fn(async(_subscription:unknown,_payload:unknown)=>({status:410,ok:false}));
 expect(await deliverOperatorPush(d.db,{}, {staffId:'o',account:'b',kind:'new_inquiry',refId:'outside',chatId:'chat'},send)).toEqual({sent:0,failed:0});expect(send).not.toHaveBeenCalled();
 await deliverOperatorPush(d.db,{}, {staffId:'o',account:'a',kind:'new_inquiry',refId:'msg',chatId:'chat'},send);expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0]?.[1]).toEqual(pushPayload('new_inquiry','f'));expect(d.raw.prepare('SELECT status FROM operator_push_deliveries').get()).toEqual({status:'gone'});expect((d.raw.prepare('SELECT revoked_at FROM operator_push_subscriptions').get() as any).revoked_at).toBeTruthy();
});
test('G4-13 G4-24: 好みの古い版409・役割変更で全端末を外す',async()=>{
 await gapCall(gapApp(d,[operatorPush]),'/api/me/push/subscriptions','POST',body);const preferences={kinds:['new_inquiry'],quietStart:'22:00',quietEnd:'08:00',quietAllowCritical:false,expectedVersion:0};expect((await gapCall(gapApp(d,[operatorPush]),'/api/me/push/preferences','PUT',preferences)).status).toBe(200);expect((await gapCall(gapApp(d,[operatorPush]),'/api/me/push/preferences','PUT',preferences)).status).toBe(409);d.raw.exec("UPDATE staff_members SET role='admin' WHERE id='o'");expect((d.raw.prepare('SELECT revoked_at FROM operator_push_subscriptions').get() as any).revoked_at).toBeTruthy();
});
test('G4-01 G4-06: RFC8291で暗号化しVAPID署名、外部通信は模擬のみ',async()=>{
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']) as CryptoKeyPair,jwk=await crypto.subtle.exportKey('jwk',pair.privateKey) as JsonWebKey,pub=new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey) as ArrayBuffer),capture=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response('',{status:201}));
 const r=await sendWebPush({endpoint:body.endpoint,p256dh:body.keys.p256dh,auth:body.keys.auth,payload:pushPayload('new_inquiry','chat'),publicKey:b64(pub),privateKey:jwk.d!,subject:'mailto:operator@example.test'},capture);expect(r.ok).toBe(true);const init=capture.mock.calls[0][1]!;expect((init.headers as any).Authorization).toMatch(/^vapid t=/);expect(init.redirect).toBe('error');expect(Buffer.from(init.body as Uint8Array).toString()).not.toContain('新しい問い合わせ');expect(fetch).not.toHaveBeenCalled();
});
test('G4-08: 夜の3件は送らず、朝にまとめて1件だけ',async()=>{
 const {sweepOperatorPush}=await import('../services/operator-push.js');await gapCall(gapApp(d,[operatorPush]),'/api/me/push/subscriptions','POST',body);
 await gapCall(gapApp(d,[operatorPush]),'/api/me/push/preferences','PUT',{kinds:['new_inquiry'],quietStart:'00:00',quietEnd:'23:59',quietAllowCritical:false,expectedVersion:0});
 const send=vi.fn(async(_s:unknown,_p:unknown)=>({ok:true,status:201}));for(let i=0;i<3;i++){d.raw.prepare("INSERT INTO messages_log(id,friend_id,direction,message_type,content,line_account_id) VALUES(?,'f','incoming','text','秘密の本文','a')").run('night'+i);await deliverOperatorPush(d.db,{}, {staffId:'o',account:'a',kind:'new_inquiry',refId:'night'+i,chatId:'chat'},send);}expect(send).not.toHaveBeenCalled();
 d.raw.exec("UPDATE operator_push_preferences SET quiet_start='22:00',quiet_end='08:00'");await sweepOperatorPush(d.db,{},new Date('2026-11-20T00:00:00Z'),send);expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][1]).toMatchObject({title:'夜の間に3件のお知らせ',url:'/chats'});expect(d.raw.prepare("SELECT COUNT(*) n FROM operator_push_deliveries WHERE status='batched'").get()).toEqual({n:3});
});
test.each(['assignment','preference'])('G4-07 G4-08: 朝のまとめも変更後の担当と好みで確認する（%s）',async change=>{
 const {sweepOperatorPush}=await import('../services/operator-push.js');await gapCall(gapApp(d,[operatorPush]),'/api/me/push/subscriptions','POST',body);
 d.raw.exec("UPDATE chats SET assignee_staff_id='o';INSERT INTO messages_log(id,friend_id,direction,message_type,content,line_account_id) VALUES('changed-night','f','incoming','text','秘密の本文','a')");
 await gapCall(gapApp(d,[operatorPush]),'/api/me/push/preferences','PUT',{kinds:['assigned_reply'],quietStart:'00:00',quietEnd:'23:59',quietAllowCritical:false,expectedVersion:0});
 const send=vi.fn(async()=>({ok:true,status:201}));await deliverOperatorPush(d.db,{}, {staffId:'o',account:'a',kind:'assigned_reply',refId:'changed-night',chatId:'chat'},send);
 d.raw.exec("UPDATE operator_push_preferences SET quiet_start='22:00',quiet_end='08:00'");if(change==='assignment')d.raw.exec("UPDATE chats SET assignee_staff_id='s'");else d.raw.exec("UPDATE operator_push_preferences SET kinds_json='[]'");
 await sweepOperatorPush(d.db,{},new Date('2026-11-20T00:00:00Z'),send);expect(send).not.toHaveBeenCalled();expect(d.raw.prepare('SELECT status,error_code FROM operator_push_deliveries').get()).toEqual({status:'failed',error_code:'push_no_longer_authorized'});
});
test('G4-12: 5xxだけ上限つきで再試行し、成功した物は繰り返さない',async()=>{
 const {retryOperatorPush}=await import('../services/operator-push.js');await gapCall(gapApp(d,[operatorPush]),'/api/me/push/subscriptions','POST',body);d.raw.exec("INSERT INTO messages_log(id,friend_id,direction,message_type,content,line_account_id) VALUES('retry-msg','f','incoming','text','秘密の本文','a')");
 const fail=vi.fn(async(_s:unknown,_p:unknown)=>({ok:false,status:503}));await deliverOperatorPush(d.db,{}, {staffId:'o',account:'a',kind:'new_inquiry',refId:'retry-msg',chatId:'chat'},fail);expect(d.raw.prepare('SELECT status,attempts FROM operator_push_deliveries').get()).toEqual({status:'failed',attempts:1});
 const send=vi.fn(async(_s:unknown,_p:unknown)=>({ok:true,status:201})),future=new Date(Date.now()+120000);await retryOperatorPush(d.db,{},future,send);await retryOperatorPush(d.db,{},future,send);expect(send).toHaveBeenCalledTimes(1);expect(d.raw.prepare('SELECT status,attempts FROM operator_push_deliveries').get()).toEqual({status:'sent',attempts:2});expect(JSON.stringify(send.mock.calls)).not.toContain('秘密の本文');
});
test('旧名簿と同じIDでも新しい担当でなければ担当通知を送らない',async()=>{
 await gapCall(gapApp(d,[operatorPush]),'/api/me/push/subscriptions','POST',body);
 d.raw.exec("INSERT INTO operators(id,name,email) VALUES ('o','旧担当','old@example.test'); UPDATE chats SET operator_id='o',assignee_staff_id=NULL WHERE id='chat'");
 const send=vi.fn(async()=>({ok:true,status:201}));
 await deliverOperatorPush(d.db,{}, {staffId:'o',account:'a',kind:'assigned_reply',refId:'collision',chatId:'chat'},send);
 expect(send).not.toHaveBeenCalled();
});
test.each(['quiet','retry'])('旧名簿のIDが同じでも%sでは新担当に通知しない',async(mode)=>{
 const {sweepOperatorPush,retryOperatorPush}=await import('../services/operator-push.js');
 await gapCall(gapApp(d,[operatorPush]),'/api/me/push/subscriptions','POST',body);
 d.raw.exec("INSERT INTO operators(id,name,email) VALUES ('o','旧担当','old@example.test'); UPDATE chats SET operator_id='o',assignee_staff_id='o' WHERE id='chat'; INSERT INTO messages_log(id,friend_id,direction,message_type,content,line_account_id) VALUES('pending-msg','f','incoming','text','本文','a')");
 if(mode==='quiet') await gapCall(gapApp(d,[operatorPush]),'/api/me/push/preferences','PUT',{kinds:['assigned_reply'],quietStart:'00:00',quietEnd:'23:59',quietAllowCritical:false,expectedVersion:0});
 const send=vi.fn(async()=>({ok:false,status:503}));
 await deliverOperatorPush(d.db,{}, {staffId:'o',account:'a',kind:'assigned_reply',refId:'pending-msg',chatId:'chat'},send);
 d.raw.exec("UPDATE chats SET assignee_staff_id=NULL WHERE id='chat'; UPDATE operator_push_preferences SET quiet_start='22:00',quiet_end='08:00'");
 send.mockClear();
 if(mode==='quiet') await sweepOperatorPush(d.db,{},new Date('2026-11-20T00:00:00Z'),send);
 else await retryOperatorPush(d.db,{},new Date(Date.now()+120000),send);
 expect(send).not.toHaveBeenCalled();
});
test.each(['immediate','quiet','retry'])('担当が閲覧のみになったら%sの通知を送らない',async(mode)=>{
 const {sweepOperatorPush,retryOperatorPush}=await import('../services/operator-push.js');
 await gapCall(gapApp(d,[operatorPush]),'/api/me/push/subscriptions','POST',body);
 d.raw.exec("UPDATE chats SET assignee_staff_id='o' WHERE id='chat'; INSERT INTO messages_log(id,friend_id,direction,message_type,content,line_account_id) VALUES('revoked-msg','f','incoming','text','本文','a')");
 if(mode==='quiet') await gapCall(gapApp(d,[operatorPush]),'/api/me/push/preferences','PUT',{kinds:['assigned_reply'],quietStart:'00:00',quietEnd:'23:59',quietAllowCritical:false,expectedVersion:0});
 const send=vi.fn(async()=>({ok:false,status:503}));
 if(mode!=='immediate') await deliverOperatorPush(d.db,{}, {staffId:'o',account:'a',kind:'assigned_reply',refId:'revoked-msg',chatId:'chat'},send);
 d.raw.exec("UPDATE staff_members SET access_level='read_only' WHERE id='o'; UPDATE operator_push_preferences SET quiet_start='22:00',quiet_end='08:00'");
 send.mockClear();
 if(mode==='immediate') await deliverOperatorPush(d.db,{}, {staffId:'o',account:'a',kind:'assigned_reply',refId:'revoked-msg',chatId:'chat'},send);
 if(mode==='quiet') await sweepOperatorPush(d.db,{},new Date('2026-11-20T00:00:00Z'),send);
 if(mode==='retry') await retryOperatorPush(d.db,{},new Date(Date.now()+120000),send);
 expect(send).not.toHaveBeenCalled();
});
test('G4-11: 消えた端末だけを外し、他の端末には送る',async()=>{
 await gapCall(gapApp(d,[operatorPush]),'/api/me/push/subscriptions','POST',body);
 await gapCall(gapApp(d,[operatorPush]),'/api/me/push/subscriptions','POST',{...body,endpoint:body.endpoint+'-second'});
 const send=vi.fn(async(s:{endpoint:string})=>s.endpoint.endsWith('-second')?{ok:true,status:201}:{ok:false,status:410});
 const result=await deliverOperatorPush(d.db,{}, {staffId:'o',account:'a',kind:'new_inquiry',refId:'two-devices',chatId:'chat'},send);
 expect(result).toEqual({sent:1,failed:1});
 expect(send).toHaveBeenCalledTimes(2);
 const rows=d.raw.prepare('SELECT endpoint,revoked_at FROM operator_push_subscriptions ORDER BY endpoint').all() as {endpoint:string;revoked_at:string|null}[];
 expect(rows.find(r=>r.endpoint===body.endpoint)?.revoked_at).toBeTruthy();
 expect(rows.find(r=>r.endpoint.endsWith('-second'))?.revoked_at).toBeNull();
});
