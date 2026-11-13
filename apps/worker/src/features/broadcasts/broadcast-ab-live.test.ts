import {beforeEach,afterEach,test,expect,vi} from 'vitest';
import {broadcastAb} from '../../routes/broadcast-ab.js';
import {broadcasts} from '../../routes/broadcasts.js';
import {setBroadcastApprovalThreshold} from './broadcast-approval.js';
import {startAbMock} from './broadcast-ab.js';
import {createAbLiveTransmit,startAbLive} from './broadcast-ab-live.js';
import type {AbLiveTransmitInput} from './broadcast-ab-live.js';
import {gapFixture,gapApp,gapCall,gapOwner} from '../../test-utils/gap1.js';
import type {SqliteD1} from '../../test-utils/d1-sqlite.js';
let d:SqliteD1;const p='/api/broadcasts/br/ab-test';
beforeEach(()=>{d=gapFixture();d.raw.exec("INSERT INTO tags(id,name,line_account_id) VALUES('audience','対象','a');INSERT INTO broadcasts(id,title,message_type,message_content,target_type,target_tag_id,line_account_id) VALUES('br','試す','text','A','tag','audience','a')");const add=d.raw.prepare("INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES(?,?,?,'a')"),tag=d.raw.prepare("INSERT INTO friend_tags(friend_id,tag_id) VALUES(?,'audience')");d.raw.transaction(()=>{for(let i=0;i<2400;i++){const id='abf'+i;add.run(id,'U'+id,id);tag.run(id);}})();vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('external_forbidden');}));});
afterEach(()=>{d.raw.close();vi.unstubAllGlobals();});
async function configure(){const app=gapApp(d,[broadcastAb]);for(const [key,v] of [['A',1],['B',2]] as const)expect((await gapCall(app,`/api/broadcasts/br/variants/${key}`,'PUT',{text:key,expectedVersion:v})).status).toBe(200);expect((await gapCall(app,p,'PUT',{testRatioPct:20,metric:'click',decideAfterMinutes:60,undecidedPolicy:'stop',expectedVersion:3})).status).toBe(200);}
const transmit=()=>vi.fn(async(_input:AbLiveTransmitInput)=>undefined);

test('R4a-01: 旗がなければ本送信は始めない（既定オフ）',async()=>{
 await configure();const send=transmit();
 await expect(startAbLive(d.db,'br',4,2400,'live-1',{transmit:send,liveDeliveryEnabled:false})).rejects.toThrow('live_delivery_disabled');
 expect(send).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
 expect(d.raw.prepare('SELECT COUNT(*) n FROM broadcast_ab_live_tests').get()).toEqual({n:0});
 expect(d.raw.prepare('SELECT status FROM broadcast_ab_tests').get()).toEqual({status:'draft'});
});

test('R4a-02: 旗があれば試しを送り残りは待つ、710は触らない',async()=>{
 await configure();const send=transmit();
 const r=await startAbLive(d.db,'br',4,2400,'live-1',{transmit:send,liveDeliveryEnabled:true});
 expect(r).toMatchObject({status:'live_testing',counts:{A:240,B:240,R:1920}});
 expect(send).toHaveBeenCalledTimes(2);
 expect(send.mock.calls.map(c=>c[0].variantKey).sort()).toEqual(['A','B']);
 expect(send.mock.calls[0][0].to).toHaveLength(240);
 expect(fetch).not.toHaveBeenCalled();
 expect(d.raw.prepare("SELECT state,count(*) n FROM broadcast_ab_live_recipients GROUP BY state ORDER BY state").all()).toEqual([{state:'pending',n:1920},{state:'sent',n:480}]);
 expect(d.raw.prepare('SELECT status FROM broadcast_ab_tests').get()).toEqual({status:'draft'});
 expect(d.raw.prepare('SELECT status FROM broadcasts').get()).toEqual({status:'draft'});
 expect(d.raw.prepare('SELECT COUNT(*) n FROM broadcast_ab_recipients').get()).toEqual({n:0});
});

test('R4a-03: 同じ鍵の再送は同じ結果で二重送信しない',async()=>{
 await configure();const send=transmit();const opts={transmit:send,liveDeliveryEnabled:true};
 const first=await startAbLive(d.db,'br',4,2400,'live-1',opts);
 expect(await startAbLive(d.db,'br',4,2400,'live-1',opts)).toEqual(first);
 expect(send).toHaveBeenCalledTimes(2);
 await expect(startAbLive(d.db,'br',4,2401,'live-1',opts)).rejects.toThrow('idempotency_conflict');
 await expect(startAbLive(d.db,'br',4,2400,'live-2',opts)).rejects.toThrow('ab_already_started');
});

test('2つ目の送信単位が不明なら、成功分と未着手分を分けて残す',async()=>{
 await configure();
 d.raw.prepare("UPDATE broadcast_ab_tests SET test_ratio_pct=50 WHERE broadcast_id='br'").run();
 const send=vi.fn(async(input:AbLiveTransmitInput)=>{if(input.variantKey==='A'&&input.retryKey.endsWith(':1'))throw new Error('response_lost');});
 await startAbLive(d.db,'br',4,2400,'live-1',{transmit:send,liveDeliveryEnabled:true});
 expect(send.mock.calls.map(c=>[c[0].variantKey,c[0].to.length])).toEqual([['A',500],['A',500],['B',500],['B',500],['B',200]]);
 expect(d.raw.prepare("SELECT variant_key,state,count(*) n FROM broadcast_ab_live_recipients GROUP BY variant_key,state ORDER BY variant_key,state").all()).toEqual([
  {variant_key:'A',state:'pending',n:200},{variant_key:'A',state:'sent',n:500},{variant_key:'A',state:'unknown',n:500},
  {variant_key:'B',state:'sent',n:1200},
 ]);
});

test('R4a-04: 人数の確かめが変われば始めない',async()=>{
 await configure();
 await expect(startAbLive(d.db,'br',4,2401,'live-1',{transmit:transmit(),liveDeliveryEnabled:true})).rejects.toThrow('SEND_PREVIEW_CHANGED');
 expect(d.raw.prepare('SELECT COUNT(*) n FROM broadcast_ab_live_tests').get()).toEqual({n:0});
});

test('R4a-05: 試験行の守りは残す（通常送信への状態変更は止まる）',async()=>{
 await configure();
 expect(()=>d.raw.exec("UPDATE broadcasts SET status='sending' WHERE id='br'")).toThrow('ab_test_requires_test_transport');
 expect(d.raw.prepare('SELECT status FROM broadcasts').get()).toEqual({status:'draft'});
});

test('R4a-06: 模擬開始後の本開始は止まる',async()=>{
 await configure();await startAbMock(d.db,'br',4,2400,'mock-1');
 await expect(startAbLive(d.db,'br',5,2400,'live-1',{transmit:transmit(),liveDeliveryEnabled:true})).rejects.toThrow('ab_already_started');
 expect(d.raw.prepare('SELECT COUNT(*) n FROM broadcast_ab_live_tests').get()).toEqual({n:0});
});

test('R4a-07: 送る口は承認の後ろにあり、旗なしは409',async()=>{
 await configure();const app=gapApp(d,[broadcastAb,broadcasts]);
 const request=(body:unknown)=>app.request('/api/broadcasts/br/send',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'send-live','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify(body)});
 const blocked=await request({expectedVersion:4,confirmedRecipientCount:2400,liveMode:true});
 expect(blocked.status).toBe(409);
 await setBroadcastApprovalThreshold(d.db,'a',10000);
 const denied=await request({expectedVersion:4,confirmedRecipientCount:2400,liveMode:true});
 expect(denied.status).toBe(409);expect(await denied.json()).toMatchObject({error:'live_delivery_disabled'});
 expect(d.raw.prepare('SELECT status FROM broadcast_ab_tests').get()).toEqual({status:'draft'});
 expect(d.raw.prepare('SELECT COUNT(*) n FROM broadcast_ab_live_tests').get()).toEqual({n:0});
 expect(fetch).not.toHaveBeenCalled();
});

test('R4a-09: 人別の差し込みがある案は本開始しない',async()=>{
 const app=gapApp(d,[broadcastAb]);
 expect((await gapCall(app,'/api/broadcasts/br/variants/A','PUT',{text:'{{name}}様',expectedVersion:1})).status).toBe(200);
 expect((await gapCall(app,'/api/broadcasts/br/variants/B','PUT',{text:'B',expectedVersion:2})).status).toBe(200);
 expect((await gapCall(app,p,'PUT',{testRatioPct:20,metric:'click',decideAfterMinutes:60,undecidedPolicy:'stop',expectedVersion:3})).status).toBe(200);
 const send=transmit();
 await expect(startAbLive(d.db,'br',4,2400,'live-1',{transmit:send,liveDeliveryEnabled:true})).rejects.toThrow('ab_live_personalization_unsupported');
 expect(send).not.toHaveBeenCalled();
 expect(d.raw.prepare('SELECT COUNT(*) n FROM broadcast_ab_live_tests').get()).toEqual({n:0});
});

test('R4a-08: 試しは500人ずつに分けて送り、鍵を分ける',async()=>{
 const multicast=vi.fn(async(to:string[],_messages:unknown,_units?:string[],_retryKey?:string)=>undefined);
 const send=createAbLiveTransmit({multicast});
 const to=Array.from({length:1200},(_,i)=>'U'+i);
 await send({broadcastId:'br',variantKey:'A',to,messages:[{type:'text',text:'A'}] as never,retryKey:'key'});
 expect(multicast).toHaveBeenCalledTimes(3);
 expect(multicast.mock.calls[0][0]).toHaveLength(500);
 expect(multicast.mock.calls[2][0]).toHaveLength(200);
 expect(new Set(multicast.mock.calls.map(c=>c[3])).size).toBe(3);
 expect(multicast.mock.calls.every(c=>/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(c[3]??''))).toBe(true);
 expect(fetch).not.toHaveBeenCalled();
});
