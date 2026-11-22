import {afterEach,beforeEach,expect,test,vi} from 'vitest';
const proxy=vi.hoisted(()=>vi.fn(async (_request:Request)=>new Response('{}',{status:200})));
vi.mock('../../services/local-line-proxy.js',()=>({dispatchLineProxyLocally:proxy}));
import type {Env} from '../../worker-env.js';
import {gapFixture,gapApp,gapCall,gapOwner} from '../../test-utils/gap1.js';
import type {SqliteD1} from '../../test-utils/d1-sqlite.js';
import {broadcastAb} from '../../routes/broadcast-ab.js';
import {broadcasts} from '../../routes/broadcasts.js';
import {startAbLive} from './broadcast-ab-live.js';
import {decideAbLiveTests} from './broadcast-ab-live-decision.js';
import {chooseAbLive,processAbLiveRemainders} from './broadcast-ab-live-remainder.js';
let d:SqliteD1;
const start=new Date('2026-11-18T01:00:00Z'),decide=new Date('2026-11-18T03:00:00Z');
const env=()=>({DB:d.db,DEPLOY_ENV:'staging',AB_LIVE_DELIVERY_ENABLED:'true',WORKER_URL:'https://worker.invalid'} as Env['Bindings']);
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(start);proxy.mockReset();proxy.mockImplementation(async()=>new Response('{}',{status:200}));vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>new Response(JSON.stringify(String(input).includes('consumption')?{totalUsage:0}:{type:'limited',value:5000}),{status:200}))); d=gapFixture();d.raw.exec("INSERT INTO tags(id,name,line_account_id) VALUES('audience','対象','a');INSERT INTO broadcasts(id,title,message_type,message_content,target_type,target_tag_id,line_account_id) VALUES('br','試す','text','A','tag','audience','a')");const add=d.raw.prepare("INSERT INTO friends(id,line_user_id,line_account_id) VALUES(?,?,'a')"),tag=d.raw.prepare("INSERT INTO friend_tags(friend_id,tag_id) VALUES(?,'audience')");for(let i=0;i<20;i++){add.run('p'+i,'Up'+i);tag.run('p'+i);}d.raw.prepare("INSERT INTO account_settings(id,line_account_id,key,value) VALUES('test-setting','a','test_recipients',?)").run(JSON.stringify(Array.from({length:20},(_,i)=>'p'+i)));});
afterEach(()=>{d.raw.close();vi.unstubAllGlobals();vi.useRealTimers();});
async function prepare(){const app=gapApp(d,[broadcastAb],gapOwner,false,env());for(const [key,v] of [['A',1],['B',2]] as const)expect((await gapCall(app,`/api/broadcasts/br/variants/${key}`,'PUT',{text:key,expectedVersion:v})).status).toBe(200);expect((await gapCall(app,'/api/broadcasts/br/ab-test','PUT',{testRatioPct:20,metric:'click',decideAfterMinutes:60,undecidedPolicy:'stop',expectedVersion:3})).status).toBe(200);await startAbLive(d.db,'br',4,20,'start',{transmit:async()=>undefined,liveDeliveryEnabled:true,now:start});vi.setSystemTime(decide);await decideAbLiveTests(d.db,decide);return app;}
test('人数不足の結果を手動で選び、残りだけ一度ずつ送る',async()=>{
 await prepare();const selected=await chooseAbLive(d.db,'br','a','o','choose','B',16,decide);expect(selected).toMatchObject({variant:'B',replayed:false});
 expect(await chooseAbLive(d.db,'br','a','o','choose','B',16,decide)).toMatchObject({replayed:true});
 await expect(chooseAbLive(d.db,'br','a','o','other','A',16,decide)).rejects.toThrow('already_chosen');
 await Promise.all([processAbLiveRemainders(env(),decide),processAbLiveRemainders(env(),decide)]);await processAbLiveRemainders(env(),decide);
 expect(proxy).toHaveBeenCalledTimes(16);expect(d.raw.prepare("SELECT COUNT(*) n FROM broadcast_ab_live_recipients WHERE variant_key='R' AND state='sent'").get()).toEqual({n:16});
 expect(d.raw.prepare('SELECT status,winner FROM broadcast_ab_live_tests').get()).toEqual({status:'live_finished',winner:'B'});
 for(const [request] of proxy.mock.calls){const body=await request.json() as {messages:Array<{text:string}>};expect(body.messages[0].text).toBe('B');}
});
test('送らず終了・人数の変更・期限切れは残りを送らない',async()=>{
 await prepare();await expect(chooseAbLive(d.db,'br','a','o','bad','A',15,decide)).rejects.toThrow('SEND_PREVIEW_CHANGED');
 await expect(chooseAbLive(d.db,'br','a','o','late','A',16,new Date(decide.getTime()+86400000))).rejects.toThrow('already_chosen');
 await chooseAbLive(d.db,'br','a','o','none','none',16,decide);await processAbLiveRemainders(env(),decide);
 expect(proxy).not.toHaveBeenCalled();expect(d.raw.prepare('SELECT status FROM broadcast_ab_live_tests').get()).toEqual({status:'live_finished'});
});
test('応答が不明なら停止し、定時処理を繰り返しても再送しない',async()=>{
 await prepare();await chooseAbLive(d.db,'br','a','o','choose','A',16,decide);proxy.mockImplementation(async()=>{throw new Error('lost');});
 await processAbLiveRemainders(env(),decide);await processAbLiveRemainders(env(),decide);
 expect(proxy).toHaveBeenCalledTimes(1);expect(d.raw.prepare('SELECT status FROM broadcast_ab_live_tests').get()).toEqual({status:'live_stopped'});
 expect(d.raw.prepare("SELECT COUNT(*) n FROM broadcast_ab_live_recipients WHERE variant_key='R' AND state='unknown'").get()).toEqual({n:1});
});
test('本番や旗オフでは残りを送らない',async()=>{
 await prepare();await chooseAbLive(d.db,'br','a','o','choose','A',16,decide);
 await processAbLiveRemainders({...env(),DEPLOY_ENV:'production'},decide);await processAbLiveRemainders({...env(),AB_LIVE_DELIVERY_ENABLED:'false'},decide);
 expect(proxy).not.toHaveBeenCalled();expect(d.raw.prepare('SELECT status FROM broadcast_ab_live_tests').get()).toEqual({status:'live_decided'});
});
test('送信確認を経た選択は1回だけ通り、別の選択は競合する',async()=>{
 const app=await prepare();const request=(variant:string,key:string,confirm=true)=>app.request('/api/broadcasts/br/ab-test/choose',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key,...(confirm?{'X-Confirm-Irreversible':'broadcast-send'}:{})},body:JSON.stringify({variant,confirmedRecipientCount:16,liveMode:true})});
 expect((await request('A','without-confirm',false)).status).toBe(428);
 const responses=await Promise.all([request('A','first'),request('B','second')]);expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
 expect(proxy).not.toHaveBeenCalled();
});
test('対象外になった人は飛ばし、残りの有効な人へ送る',async()=>{
 await prepare();await chooseAbLive(d.db,'br','a','o','choose','B',16,decide);
 const victim=(d.raw.prepare("SELECT friend_id FROM broadcast_ab_live_recipients WHERE broadcast_id='br' AND variant_key='R' ORDER BY friend_id LIMIT 1 OFFSET 1").get() as {friend_id:string}).friend_id;
 let calls=0;proxy.mockImplementation(async()=>{if(++calls===1)d.raw.prepare("DELETE FROM friend_tags WHERE friend_id=? AND tag_id='audience'").run(victim);return new Response('{}',{status:200});});
 await processAbLiveRemainders(env(),decide);
 expect(proxy).toHaveBeenCalledTimes(15);expect(d.raw.prepare("SELECT state FROM broadcast_ab_live_recipients WHERE broadcast_id='br' AND friend_id=?").get(victim)).toEqual({state:'failed'});
 expect(d.raw.prepare('SELECT status FROM broadcast_ab_live_tests').get()).toEqual({status:'live_finished'});
});
test.each(['short','unknown'])('残りの枠が%sなら一人も送らない',async condition=>{
 await prepare();await chooseAbLive(d.db,'br','a','o','choose','A',16,decide);
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{if(condition==='unknown')throw new Error('unavailable');return new Response(JSON.stringify(String(input).includes('consumption')?{totalUsage:0}:{type:'limited',value:15}),{status:200});}));
 await processAbLiveRemainders(env(),decide);expect(proxy).not.toHaveBeenCalled();expect(d.raw.prepare('SELECT status FROM broadcast_ab_live_tests').get()).toEqual({status:'live_stopped'});expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE event_type='broadcast_ab_remainder_stopped'").get()).toEqual({n:1});
});

test('試し中の配信を止めると、選択も残りの送信も行わない',async()=>{
 await prepare();const app=gapApp(d,[broadcastAb,broadcasts],gapOwner,false,env());
 const r=await gapCall(app,'/api/broadcasts/br/stop','POST',{expectedVersion:5});expect(r.status).toBe(200);
 await expect(chooseAbLive(d.db,'br','a','o','choose','A',16,decide)).rejects.toThrow('already_chosen');
 await processAbLiveRemainders(env(),decide);expect(proxy).not.toHaveBeenCalled();
 expect(d.raw.prepare('SELECT status FROM broadcast_ab_live_tests').get()).toEqual({status:'live_stopped'});
});
test('残りの送信中に停止すると次の人には送らない',async()=>{
 await prepare();await chooseAbLive(d.db,'br','a','o','choose','B',16,decide);const app=gapApp(d,[broadcastAb,broadcasts],gapOwner,false,env());
 let n=0;proxy.mockImplementation(async()=>{if(++n===1){const r=await gapCall(app,'/api/broadcasts/br/stop','POST',{expectedVersion:5});expect(r.status).toBe(200);}return new Response('{}',{status:200});});
 await processAbLiveRemainders(env(),decide);await processAbLiveRemainders(env(),decide);
 expect(proxy).toHaveBeenCalledTimes(1);expect(d.raw.prepare('SELECT status FROM broadcast_ab_live_tests').get()).toEqual({status:'live_stopped'});
});
