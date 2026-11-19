import {beforeEach,afterEach,test,expect,vi} from 'vitest';
const proxy=vi.hoisted(()=>vi.fn(async (_request:Request)=>new Response('{}',{status:200,headers:{'x-line-request-id':'accepted'}})));
vi.mock('../../services/local-line-proxy.js',()=>({dispatchLineProxyLocally:proxy}));
import {broadcastAb} from '../../routes/broadcast-ab.js';
import {broadcasts} from '../../routes/broadcasts.js';
import {setBroadcastApprovalThreshold} from './broadcast-approval.js';
import {startAbMock} from './broadcast-ab.js';
import {startAbLive} from './broadcast-ab-live.js';
import type {AbLiveTransmitInput} from './broadcast-ab-live.js';
import {gapFixture,gapApp,gapCall,gapOwner} from '../../test-utils/gap1.js';
import type {SqliteD1} from '../../test-utils/d1-sqlite.js';
let d:SqliteD1;const p='/api/broadcasts/br/ab-test';
beforeEach(()=>{proxy.mockClear();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-18T01:00:00Z'));d=gapFixture();d.raw.exec("INSERT INTO tags(id,name,line_account_id) VALUES('audience','対象','a');INSERT INTO broadcasts(id,title,message_type,message_content,target_type,target_tag_id,line_account_id) VALUES('br','試す','text','A','tag','audience','a')");const add=d.raw.prepare("INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES(?,?,?,'a')"),tag=d.raw.prepare("INSERT INTO friend_tags(friend_id,tag_id) VALUES(?,'audience')");d.raw.transaction(()=>{for(let i=0;i<2400;i++){const id='abf'+i;add.run(id,'U'+id,id);tag.run(id);}})();d.raw.prepare("INSERT INTO account_settings(id,line_account_id,key,value) VALUES('test-setting','a','test_recipients',?)").run(JSON.stringify(Array.from({length:20},(_,i)=>'abf'+i)));vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('external_forbidden');}));});
afterEach(()=>{d.raw.close();vi.unstubAllGlobals();vi.useRealTimers();});
async function configure(){const app=gapApp(d,[broadcastAb]);for(const [key,v] of [['A',1],['B',2]] as const)expect((await gapCall(app,`/api/broadcasts/br/variants/${key}`,'PUT',{text:key,expectedVersion:v})).status).toBe(200);expect((await gapCall(app,p,'PUT',{testRatioPct:20,metric:'click',decideAfterMinutes:60,undecidedPolicy:'stop',expectedVersion:3})).status).toBe(200);}
const transmit=()=>vi.fn(async(_input:AbLiveTransmitInput)=>undefined);
function allowQuota(){vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>new Response(JSON.stringify(String(input).includes('consumption')?{totalUsage:0}:{type:'limited',value:20}),{status:200})));}

test('R4a-01: 旗がなければ本送信は始めない（既定オフ）',async()=>{
 await configure();const send=transmit();
 await expect(startAbLive(d.db,'br',4,20,'live-1',{transmit:send,liveDeliveryEnabled:false})).rejects.toThrow('live_delivery_disabled');
 expect(send).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
 expect(d.raw.prepare('SELECT COUNT(*) n FROM broadcast_ab_live_tests').get()).toEqual({n:0});
 expect(d.raw.prepare('SELECT status FROM broadcast_ab_tests').get()).toEqual({status:'draft'});
});

test('R4a-02: 旗があれば試しを送り残りは待つ、710は触らない',async()=>{
 await configure();const send=transmit();
 const r=await startAbLive(d.db,'br',4,20,'live-1',{transmit:send,liveDeliveryEnabled:true});
 expect(r).toMatchObject({status:'live_testing',counts:{A:2,B:2,R:16}});
 expect(send).toHaveBeenCalledTimes(4);
 expect(send.mock.calls.map(c=>c[0].variantKey).sort()).toEqual(['A','A','B','B']);
 expect(send.mock.calls[0][0].to).toHaveLength(1);
 expect(fetch).not.toHaveBeenCalled();
 expect(d.raw.prepare("SELECT state,count(*) n FROM broadcast_ab_live_recipients GROUP BY state ORDER BY state").all()).toEqual([{state:'pending',n:16},{state:'sent',n:4}]);
 expect(d.raw.prepare('SELECT status FROM broadcast_ab_tests').get()).toEqual({status:'draft'});
 expect(d.raw.prepare('SELECT status FROM broadcasts').get()).toEqual({status:'draft'});
 expect(d.raw.prepare('SELECT COUNT(*) n FROM broadcast_ab_recipients').get()).toEqual({n:0});
});

test('R4a-03: 同じ鍵の再送は同じ結果で二重送信しない',async()=>{
 await configure();const send=transmit();const opts={transmit:send,liveDeliveryEnabled:true};
 const first=await startAbLive(d.db,'br',4,20,'live-1',opts);
 expect(await startAbLive(d.db,'br',4,20,'live-1',opts)).toEqual(first);
 expect(send).toHaveBeenCalledTimes(4);
 await expect(startAbLive(d.db,'br',4,21,'live-1',opts)).rejects.toThrow('idempotency_conflict');
 await expect(startAbLive(d.db,'br',4,20,'live-2',opts)).rejects.toThrow('ab_already_started');
});

test('応答不明の宛先は再送せず、停止したことを記録する',async()=>{
 await configure();
 const send=vi.fn(async()=>{throw new Error('response_lost');});
 await expect(startAbLive(d.db,'br',4,20,'live-1',{transmit:send,liveDeliveryEnabled:true})).rejects.toThrow('ab_delivery_unknown');
 expect(d.raw.prepare("SELECT COUNT(*) n FROM broadcast_ab_live_recipients WHERE state='unknown'").get()).toEqual({n:1});
 expect(await startAbLive(d.db,'br',4,20,'live-1',{transmit:send,liveDeliveryEnabled:true})).toMatchObject({status:'live_stopped',reason:'ab_delivery_unknown'});
 expect(send).toHaveBeenCalledTimes(1);
});

test('R4a-04: 人数の確かめが変われば始めない',async()=>{
 await configure();
 await expect(startAbLive(d.db,'br',4,21,'live-1',{transmit:transmit(),liveDeliveryEnabled:true})).rejects.toThrow('SEND_PREVIEW_CHANGED');
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
 await expect(startAbLive(d.db,'br',4,20,'live-1',{transmit:send,liveDeliveryEnabled:true})).rejects.toThrow('ab_live_personalization_unsupported');
 expect(send).not.toHaveBeenCalled();
 expect(d.raw.prepare('SELECT COUNT(*) n FROM broadcast_ab_live_tests').get()).toEqual({n:0});
});

test('A/B配信は未解決の共通情報を送らず、値があれば置き換える',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-18T01:00:00Z'));
 try{
  const app=gapApp(d,[broadcastAb]);
  expect((await gapCall(app,'/api/broadcasts/br/variants/A','PUT',{text:'営業時間: {{var.hours}}',expectedVersion:1})).status).toBe(200);
  expect((await gapCall(app,'/api/broadcasts/br/variants/B','PUT',{text:'B',expectedVersion:2})).status).toBe(200);
  expect((await gapCall(app,p,'PUT',{testRatioPct:20,metric:'click',decideAfterMinutes:60,undecidedPolicy:'stop',expectedVersion:3})).status).toBe(200);
  const send=transmit(),opts={transmit:send,liveDeliveryEnabled:true,now:new Date()};
  await expect(startAbLive(d.db,'br',4,20,'live-var',opts)).rejects.toMatchObject({message:expect.stringContaining('common_var_unresolved')});
  expect(send).not.toHaveBeenCalled();
  expect(d.raw.prepare('SELECT var_key,reason FROM common_var_resolution_failures').all()).toEqual([{var_key:'hours',reason:'missing'}]);
  expect(d.raw.prepare('SELECT COUNT(*) n FROM broadcast_ab_live_tests').get()).toEqual({n:0});
  d.raw.prepare("INSERT INTO common_vars(id,line_account_id,name,var_key,type,value) VALUES ('hours','a','営業時間','hours','text','10時')").run();
  await startAbLive(d.db,'br',4,20,'live-var',opts);
  expect(send).toHaveBeenCalledTimes(4);
  expect(send.mock.calls.find(([call])=>call.variantKey==='A')?.[0].messages).toEqual([{type:'text',text:'営業時間: 10時'}]);
 }finally{vi.useRealTimers();}
});

test('登録のない宛先は送らず、人数が変わると確認し直す',async()=>{
 await configure();
 const send=transmit();
 await expect(startAbLive(d.db,'br',4,2400,'outside',{transmit:send,liveDeliveryEnabled:true})).rejects.toThrow('SEND_PREVIEW_CHANGED');
 await startAbLive(d.db,'br',4,20,'inside',{transmit:send,liveDeliveryEnabled:true});
 const allowed=new Set(Array.from({length:20},(_,i)=>'Uabf'+i));
 expect(send.mock.calls.flatMap(([call])=>call.to).every(id=>allowed.has(id))).toBe(true);
 expect(d.raw.prepare('SELECT COUNT(*) n FROM broadcast_ab_live_recipients').get()).toEqual({n:20});
});

test('案の間にテスト宛先が変わった場合は次の送信を止める',async()=>{
 await configure();
 const send=vi.fn(async()=>{d.raw.prepare("UPDATE account_settings SET value='[]' WHERE id='test-setting'").run();});
 await expect(startAbLive(d.db,'br',4,20,'changed',{transmit:send,liveDeliveryEnabled:true})).rejects.toThrow('test_recipients_changed');
 expect(send).toHaveBeenCalledTimes(1);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM broadcast_ab_live_recipients WHERE state='sent'").get()).toEqual({n:1});
});

test('外部に渡す前に結果不明として記録し、成功後だけ送信済みにする',async()=>{
 await configure();
 const send=vi.fn(async(input:AbLiveTransmitInput)=>{
  expect(d.raw.prepare("SELECT COUNT(*) n FROM broadcast_ab_live_recipients WHERE variant_key=? AND state='unknown'").get(input.variantKey)).toEqual({n:1});
 });
 await startAbLive(d.db,'br',4,20,'claim',{transmit:send,liveDeliveryEnabled:true});
 expect(d.raw.prepare("SELECT COUNT(*) n FROM broadcast_ab_live_recipients WHERE state='sent'").get()).toEqual({n:4});
 expect(d.raw.prepare("SELECT COUNT(*) n FROM outbound_send_requests WHERE status='succeeded'").get()).toEqual({n:4});
});

test('本番では設定がオンでも実送信を開始できない',async()=>{
 await configure();await setBroadcastApprovalThreshold(d.db,'a',10000);
 const app=gapApp(d,[broadcastAb,broadcasts],gapOwner,false,{DEPLOY_ENV:'production',AB_LIVE_DELIVERY_ENABLED:'true'});
 const r=await app.request('/api/broadcasts/br/send',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'prod','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({expectedVersion:4,confirmedRecipientCount:2400,confirmedTestRecipientCount:20,liveMode:true})});
 expect(r.status).toBe(409);expect(await r.json()).toMatchObject({error:'live_delivery_disabled'});
 expect(fetch).not.toHaveBeenCalled();
});

test('実送信開始後は案も設定も変更できない',async()=>{
 await configure();await startAbLive(d.db,'br',4,20,'started',{transmit:transmit(),liveDeliveryEnabled:true});
 const app=gapApp(d,[broadcastAb]);
 expect((await gapCall(app,'/api/broadcasts/br/variants/B','PUT',{text:'changed',expectedVersion:5})).status).toBe(409);
 expect((await gapCall(app,p,'DELETE',{expectedVersion:5})).status).toBe(409);
 expect((await gapCall(app,p,'PUT',{testRatioPct:20,metric:'click',decideAfterMinutes:60,undecidedPolicy:'stop',expectedVersion:5})).status).toBe(409);
});

test('実送信後には同じ配信で模擬を始められない',async()=>{
 await configure();await startAbLive(d.db,'br',4,20,'live',{transmit:transmit(),liveDeliveryEnabled:true});
 await expect(startAbMock(d.db,'br',5,2400,'mock')).rejects.toThrow('version_conflict');
 expect(d.raw.prepare('SELECT COUNT(*) n FROM broadcast_ab_recipients').get()).toEqual({n:0});
});

test('処理が中断して15分を過ぎたら停止とし、再送しない',async()=>{
 await configure();
 d.raw.prepare(`INSERT INTO broadcast_ab_live_tests(broadcast_id,test_ratio_pct,metric,decide_after_minutes,undecided_policy,status,started_at,decide_at,start_key,start_request_json,created_at) VALUES('br',20,'click',60,'stop','live_testing',? ,?,'lost',? ,?)`).run('2026-11-18T00:00:00.000Z','2026-11-18T01:00:00.000Z',JSON.stringify({expectedVersion:4,count:20}),'2026-11-18T00:00:00.000Z');
 const app=gapApp(d,[broadcastAb]);
 const response=await gapCall(app,'/api/broadcasts/br/ab-result');
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({data:{status:'live_stopped',liveStart:{reason:'interrupted'}}});
 expect(fetch).not.toHaveBeenCalled();
});

test('検証環境の送信入口は Proxy と送信台帳を使い、登録宛先だけに送る',async()=>{
 allowQuota();await configure();await setBroadcastApprovalThreshold(d.db,'a',10000);
 const app=gapApp(d,[broadcastAb,broadcasts],gapOwner,false,{DEPLOY_ENV:'staging',AB_LIVE_DELIVERY_ENABLED:'true',WORKER_URL:'https://worker.invalid'});
 const r=await app.request('/api/broadcasts/br/send',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'staging','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({expectedVersion:4,confirmedRecipientCount:2400,confirmedTestRecipientCount:20,liveMode:true})});
 expect(await r.clone().json()).toMatchObject({success:true});expect(r.status).toBe(202);
 expect(proxy).toHaveBeenCalledTimes(4);
 for(const [req] of proxy.mock.calls){
  const body=await req.json() as {to:string};expect(body.to).toMatch(/^Uabf(?:[0-9]|1[0-9])$/);
  expect(req.headers.get('X-Line-Retry-Key')).toMatch(/^[0-9a-f-]{36}$/);
  expect(req.headers.get('X-Line-Harness-Capability')).toBe('broadcast_dispatch');
 }
 expect(d.raw.prepare("SELECT COUNT(*) n FROM outbound_send_requests WHERE status='succeeded'").get()).toEqual({n:4});
});

test('店舗のトークンがなければ既定トークンを使わない',async()=>{
 await configure();await setBroadcastApprovalThreshold(d.db,'a',10000);
 d.raw.exec("UPDATE line_accounts SET channel_access_token='',channel_access_token_encrypted=NULL WHERE id='a'");
 const app=gapApp(d,[broadcastAb,broadcasts],gapOwner,false,{DEPLOY_ENV:'staging',AB_LIVE_DELIVERY_ENABLED:'true',WORKER_URL:'https://worker.invalid',LINE_CHANNEL_ACCESS_TOKEN:'default-should-not-be-used'});
 const r=await app.request('/api/broadcasts/br/send',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'missing-token','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({expectedVersion:4,confirmedRecipientCount:2400,confirmedTestRecipientCount:20,liveMode:true})});
 expect(r.status).toBe(409);expect(proxy).not.toHaveBeenCalled();
 expect(d.raw.prepare("SELECT COUNT(*) n FROM broadcast_ab_live_tests WHERE broadcast_id='br'").get()).toEqual({n:0});
});

test('本送信では案ごとに違う計測リンクを作り、宛先の署名を付ける',async()=>{
 allowQuota();await configure();await setBroadcastApprovalThreshold(d.db,'a',10000);
 d.raw.prepare("UPDATE broadcast_variants SET messages_json=? WHERE broadcast_id='br' AND variant_key='A'").run(JSON.stringify([{type:'text',text:'案 A https://example.com/a'}]));
 d.raw.prepare("UPDATE broadcast_variants SET messages_json=? WHERE broadcast_id='br' AND variant_key='B'").run(JSON.stringify([{type:'text',text:'案 B https://example.com/b'}]));
 const app=gapApp(d,[broadcastAb,broadcasts],gapOwner,false,{DEPLOY_ENV:'staging',AB_LIVE_DELIVERY_ENABLED:'true',WORKER_URL:'https://worker.invalid'});
 const r=await app.request('/api/broadcasts/br/send',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'track','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({expectedVersion:4,confirmedRecipientCount:2400,confirmedTestRecipientCount:20,liveMode:true})});
 expect(r.status).toBe(202);expect(proxy).toHaveBeenCalledTimes(4);
 for(const [req] of proxy.mock.calls){const body=await req.json() as {messages:Array<{text:string}>};expect(body.messages[0].text).toMatch(/https:\/\/worker\.invalid\/t\/[^ ]+\?identity=/);}
 const links=d.raw.prepare("SELECT dedup_key FROM tracked_links WHERE dedup_key LIKE 'a|ab-live:br:%' ORDER BY dedup_key").all() as Array<{dedup_key:string}>;
 expect(links.map(x=>x.dedup_key)).toEqual(['a|ab-live:br:A|https://example.com/a','a|ab-live:br:B|https://example.com/b']);
});

test('計測できないLINEリンクは試しの記録や送信より前に止める',async()=>{
 await configure();d.raw.prepare("UPDATE broadcast_variants SET messages_json=? WHERE broadcast_id='br' AND variant_key='A'").run(JSON.stringify([{type:'text',text:'https://line.me/R/example'}]));
 const send=transmit();await expect(startAbLive(d.db,'br',4,20,'unsupported',{transmit:send,liveDeliveryEnabled:true})).rejects.toThrow('ab_tracking_unsupported');
 expect(send).not.toHaveBeenCalled();expect(d.raw.prepare('SELECT COUNT(*) n FROM broadcast_ab_live_tests').get()).toEqual({n:0});
});

test('試しの途中で停止すると残りを送らず、同じ鍵の再要求にも停止を返す',async()=>{
 await configure();const app=gapApp(d,[broadcastAb,broadcasts]);let n=0;
 const send=vi.fn(async()=>{if(++n===1){const r=await gapCall(app,'/api/broadcasts/br/stop','POST',{expectedVersion:5});expect(r.status).toBe(200);}});
 await expect(startAbLive(d.db,'br',4,20,'stop-mid',{transmit:send,liveDeliveryEnabled:true})).rejects.toThrow('ab_delivery_stopped');
 expect(send).toHaveBeenCalledTimes(1);
 expect(await startAbLive(d.db,'br',4,20,'stop-mid',{transmit:send,liveDeliveryEnabled:true})).toMatchObject({status:'live_stopped',reason:'stopped'});
});
