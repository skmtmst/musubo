import {afterEach,beforeEach,expect,test} from 'vitest';
import {gapFixture,gapApp,gapCall} from '../../test-utils/gap1.js';
import {broadcastAb} from '../../routes/broadcast-ab.js';
import type {SqliteD1} from '../../test-utils/d1-sqlite.js';
import {decideAbLiveTests,liveAbStats} from './broadcast-ab-live-decision.js';
let d:SqliteD1;
const now=new Date('2026-11-18T05:00:00Z');
beforeEach(()=>{d=gapFixture();d.raw.exec(`INSERT INTO broadcasts(id,title,message_type,message_content,target_type,line_account_id) VALUES('br','試験','text','a','tag','a');
 INSERT INTO broadcast_ab_tests(broadcast_id,test_ratio_pct,metric,decide_after_minutes,undecided_policy) VALUES('br',20,'click',60,'stop');
 INSERT INTO broadcast_ab_live_tests(broadcast_id,test_ratio_pct,metric,decide_after_minutes,undecided_policy,status,started_at,decide_at,start_result_json,created_at) VALUES('br',20,'click',60,'send_a','live_testing','2026-11-18T00:00:00Z','2026-11-18T04:00:00Z','{}','2026-11-18T00:00:00Z')`);});
afterEach(()=>d.raw.close());
function recipients(n:number){const f=d.raw.prepare("INSERT INTO friends(id,line_user_id,line_account_id) VALUES(?,?,'a')"),r=d.raw.prepare("INSERT INTO broadcast_ab_live_recipients(broadcast_id,friend_id,variant_key,state,sent_at) VALUES('br',?,?,'sent','2026-11-18T01:00:00Z')");for(let i=0;i<n;i++){f.run(`p${i}`,`U${i}`);r.run(`p${i}`,i<n/2?'A':'B');}}
test('人数不足はsend_aの設定でも決めず、残りへ自動送信しない',async()=>{
 recipients(20);await decideAbLiveTests(d.db,now);await decideAbLiveTests(d.db,now);
 const row=d.raw.prepare('SELECT status,winner,remainder_scheduled_at,stats_json FROM broadcast_ab_live_tests').get() as {status:string;winner:string|null;remainder_scheduled_at:string|null;stats_json:string};
 expect(row).toMatchObject({status:'live_undecided',winner:null,remainder_scheduled_at:null});expect(JSON.parse(row.stats_json)).toMatchObject({reason:'delivery_too_small'});
 expect(d.raw.prepare("SELECT count(*) n FROM notifications WHERE event_type='broadcast_ab_undecided'").get()).toEqual({n:1});
 await decideAbLiveTests(d.db,new Date(now.getTime()+86400001));expect(d.raw.prepare('SELECT status FROM broadcast_ab_live_tests').get()).toEqual({status:'live_expired'});
});
test('送信確認済みの人だけでクリック率を数え、リンクやクリックの重複で分母を増やさない',async()=>{
 recipients(100);d.raw.exec(`INSERT INTO tracked_links(id,name,original_url,dedup_key) VALUES('l','link','https://example.com','a|ab-live:br:A|https://example.com'),('lb','link b','https://example.org','a|ab-live:br:B|https://example.org')`);
 const click=d.raw.prepare("INSERT INTO link_clicks(id,tracked_link_id,friend_id,clicked_at) VALUES(?,'l',?,'2026-11-18T02:00:00Z')");for(let i=0;i<20;i++)click.run(`c${i}`,`p${i}`);click.run('dup','p0');
 expect(await liveAbStats(d.db,'br','2026-11-18T04:00:00Z')).toMatchObject([{key:'A',sent:50,clicks:20},{key:'B',sent:50,clicks:0}]);
 await decideAbLiveTests(d.db,now);expect(d.raw.prepare('SELECT status,winner FROM broadcast_ab_live_tests').get()).toEqual({status:'live_decided',winner:'A'});
});
test('計測リンクがない時は0と決めつけず、自動では送らない',async()=>{
 recipients(100);await decideAbLiveTests(d.db,now);const row=d.raw.prepare('SELECT status,winner,stats_json FROM broadcast_ab_live_tests').get() as {status:string;winner:string|null;stats_json:string};
 expect(row).toMatchObject({status:'live_undecided',winner:null});expect(JSON.parse(row.stats_json).reason).toBe('tracking_unavailable');
});
test('結果不明や判定時刻後のクリックを分母・分子に含めず、同時の判定でも通知は1件',async()=>{
 recipients(100);d.raw.exec(`UPDATE broadcast_ab_live_recipients SET state='unknown',sent_at=NULL WHERE friend_id='p0';
 INSERT INTO tracked_links(id,name,original_url,dedup_key) VALUES('l','link','https://example.com','a|ab-live:br:A|https://example.com'),('lb','link b','https://example.org','a|ab-live:br:B|https://example.org');
 INSERT INTO link_clicks(id,tracked_link_id,friend_id,clicked_at) VALUES('unknown-click','l','p0','2026-11-18T02:00:00Z'),('late-click','l','p1','2026-11-18T04:01:00Z');`);
 expect((await liveAbStats(d.db,'br','2026-11-18T04:00:00Z'))[0]).toMatchObject({sent:49,unknown:1,clicks:0});
 await Promise.all([decideAbLiveTests(d.db,now),decideAbLiveTests(d.db,now)]);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM notifications WHERE event_type='broadcast_ab_undecided'").get()).toEqual({n:1});
 expect(d.raw.prepare('SELECT status,winner FROM broadcast_ab_live_tests').get()).toEqual({status:'live_undecided',winner:null});
});

test('結果APIは模擬の記録ではなく、実際に送った人数と人数不足の理由を返す',async()=>{
 recipients(20);await decideAbLiveTests(d.db,now);
 const r=await gapCall(gapApp(d,[broadcastAb]),'/api/broadcasts/br/ab-result');
 expect(r.status).toBe(200);expect(await r.json()).toMatchObject({data:{status:'live_undecided',testMode:false,reason:'delivery_too_small',variants:[{key:'A',sent:10,clicks:null},{key:'B',sent:10,clicks:null}]}});
});
test('同じ配信の通常テスト送信リンクはA/Bのクリックに数えない',async()=>{
 recipients(100);d.raw.exec(`INSERT INTO tracked_links(id,name,original_url,dedup_key) VALUES('other','other','https://example.com','a|broadcast:br|https://example.com');
 INSERT INTO broadcast_tracked_links VALUES('br','other','other','2026-11-18T00:00:00Z');
 INSERT INTO link_clicks(id,tracked_link_id,friend_id,clicked_at) VALUES('not-ab','other','p0','2026-11-18T02:00:00Z')`);
 const stats=await liveAbStats(d.db,'br','2026-11-18T04:00:00Z');expect(stats[0].clicks).toBe(0);
 await decideAbLiveTests(d.db,now);const row=d.raw.prepare('SELECT status,stats_json FROM broadcast_ab_live_tests').get() as {status:string;stats_json:string};
 expect(row.status).toBe('live_undecided');expect(JSON.parse(row.stats_json).reason).toBe('tracking_unavailable');
});
