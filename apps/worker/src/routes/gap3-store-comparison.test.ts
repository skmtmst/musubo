import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {gapFixture,gapApp,gapCall,gapOwner,seedGapBooking} from '../test-utils/gap1.js';
import {readAccountAttention} from '../services/hq-account-attention.js';
import {storeComparison} from './store-comparison.js';
import {snapshotStoreMetrics,storeNumbers,comparisonPeriod,processStoreComparison,comparisonTrend} from '../services/store-comparison.js';
let d:ReturnType<typeof gapFixture>;
beforeEach(()=>{d=gapFixture();vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('external_forbidden');}));d.raw.exec("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES('a2','cha2','2店','token','secret','t'),('a3','cha3','3店','token','secret','t')");});
afterEach(()=>{d.raw.close();vi.unstubAllGlobals();});
const url='/api/hq/store-comparison?from=2026-10-15&to=2026-10-15';
function snapshot(a:string,n:number,day='2026-10-15'){
 d.raw.prepare("INSERT INTO hq_store_daily_metrics(account_id,date,bookings,visits,no_shows,friends_added,friends_blocked,friends_at_start,state,computed_at) VALUES(?,?,?,?,?,4,1,100,'partial','2026-10-16T00:00:00Z')").run(a,day,n,n,1);
}
async function read(path=url,s=gapOwner){const r=await gapCall(gapApp(d,[storeComparison],s),path);expect(r.status,await r.clone().text()).toBe(200);return (await r.json() as any).data;}
test('アーカイブした店は比較一覧・平均・詳細から消え、停止中の店は残る',async()=>{
 snapshot('a',2);snapshot('a2',4);snapshot('a3',6);
 d.raw.exec("UPDATE line_accounts SET archived_at='2026-10-16T00:00:00Z',is_active=0 WHERE id='a2'; UPDATE line_accounts SET is_active=0 WHERE id='a3'");
 const data=await read(url+'&compare=average');
 expect(data.rows.map((r:any)=>r.accountId).sort()).toEqual(['a','a3']);
 expect(data.total).toBe(2);
 expect(data.average.bookings).toBeNull();
 expect((await gapCall(gapApp(d,[storeComparison]),'/api/hq/store-comparison/a2?from=2026-10-15&to=2026-10-15')).status).toBe(404);
 expect((await read('/api/hq/store-comparison/a3?from=2026-10-15&to=2026-10-15')).values.bookings).toBe(6);
});
test('CMP-01/03/04/09/10/12/17: 店の範囲・期間・平均との差、未取得を0にしない',async()=>{
 snapshot('a',5);snapshot('a2',2);snapshot('a3',8);snapshot('b',999);
 let data=await read(url+'&compare=average',{...gapOwner});expect(data.rows.map((r:any)=>r.accountId)).toEqual(['a2','a','a3']);expect(data.average.bookings).toBe(5);expect(data.rows[0].metrics.bookings).toMatchObject({value:2,diff:-3,unit:'件',available:true});expect(data.rows[0].metrics.clickRate).toMatchObject({value:null,diff:null,available:false});
 snapshot('a',3,'2026-10-14');data=await read();expect(data.rows.find((r:any)=>r.accountId==='a').metrics.bookings.diff).toBe(2);
 d.raw.exec("UPDATE staff_members SET account_scope='accounts' WHERE id='o'; INSERT INTO staff_account_scopes(staff_id,line_account_id,created_at) VALUES('o','a','now')");
 data=await read(url+'&compare=average',{...gapOwner});expect(data.rows.map((r:any)=>r.accountId)).toEqual(['a']);expect(data.average.bookings).toBeNull();
 expect((await gapCall(gapApp(d,[storeComparison]),'/api/hq/store-comparison/b?from=2026-10-15&to=2026-10-15')).status).toBe(404);
 expect((await gapCall(gapApp(d,[storeComparison],{...gapOwner,id:'s',role:'staff'}),url)).status).toBe(403);expect(fetch).not.toHaveBeenCalled();
});
test('CMP-11/13/16/17: 閲覧だけも読め、欠測の日はそろった日の分で数え、失敗だけの期間は未取得',async()=>{
 snapshot('a',0);expect((await read(url,{...gapOwner,readOnly:true})).rows[0].metrics.bookings.value).toBe(0);
 const numbers=await storeNumbers(d.db,'a',comparisonPeriod('2026-10-14','2026-10-15'));expect(numbers).toMatchObject({coveredDays:1,periodDays:2,values:{bookings:0}});
 d.raw.exec("UPDATE hq_store_daily_metrics SET state='failed' WHERE account_id='a'");const failed=(await read()).rows.find((r:any)=>r.accountId==='a');expect(failed.metrics.bookings.value).toBeNull();expect(failed).toMatchObject({coveredDays:0,periodDays:1,computedAt:null});
 expect((await gapCall(gapApp(d,[storeComparison]),url.replace('2026-10-15','2026-02-30'))).status).toBe(400);
});
test('CMP-04/16: 日別の控えは日本時間・来店/取消、単一店舗の失敗でも次の店舗へ',async()=>{
 seedGapBooking(d,'yes','confirmed','2026-10-14T15:30:00Z');seedGapBooking(d,'no','cancelled','2026-10-15T01:00:00Z');seedGapBooking(d,'outside','confirmed','2026-10-15T15:00:00Z');
 await snapshotStoreMetrics(d.db,'a','2026-10-15',new Date('2026-10-16T00:00:00Z'));
 expect(d.raw.prepare("SELECT bookings,friends_added FROM hq_store_daily_metrics WHERE account_id='a'").get()).toEqual({bookings:1,friends_added:null});
 d.raw.exec("DELETE FROM hq_store_daily_metrics; CREATE TRIGGER fail_one BEFORE INSERT ON hq_store_daily_metrics WHEN NEW.account_id='a' AND NEW.state!='failed' BEGIN SELECT RAISE(ABORT,'snapshot failure'); END");
 await expect(processStoreComparison(d.db,new Date('2026-10-16T00:00:00Z'))).rejects.toThrow('snapshot failure');
 await processStoreComparison(d.db,new Date('2026-10-16T00:01:00Z'));expect(d.raw.prepare('SELECT account_id,state FROM hq_store_daily_metrics ORDER BY account_id').all()).toEqual([{account_id:'a',state:'failed'},{account_id:'a2',state:'partial'}]);
});

test('CMP-01: 最初の人の返事は会話が再開しても消えず、期間の中央値を出す',async()=>{
 d.raw.exec("INSERT INTO chats(id,friend_id,pending_since,created_at,updated_at) VALUES('chat','f','2026-10-15T01:00:00Z','now','now'); UPDATE chats SET first_response_at='2026-10-15T01:01:00Z' WHERE id='chat'; UPDATE chats SET pending_since='2026-10-15T02:00:00Z',first_response_at=NULL WHERE id='chat';UPDATE chats SET first_response_at='2026-10-15T02:10:00Z' WHERE id='chat'");
 await snapshotStoreMetrics(d.db,'a','2026-10-15');d.raw.exec("UPDATE chats SET pending_since='2026-10-15T03:00:00Z',first_response_at=NULL WHERE id='chat'");
 const result=await storeNumbers(d.db,'a',comparisonPeriod('2026-10-15','2026-10-15'));expect(result.values.responseMinutes).toBeCloseTo(5.5,4);expect(d.raw.prepare('SELECT count(*) n FROM hq_store_response_samples').get()).toEqual({n:2});
});

test('CMP-03: ECの店は使わない予約を0とせず、平均の対象から外す',async()=>{
 d.raw.exec("INSERT INTO account_styles(line_account_id,style,selection_mode,updated_at) VALUES('a','ec','configured','now')");await snapshotStoreMetrics(d.db,'a','2026-10-15');const n=await storeNumbers(d.db,'a',comparisonPeriod('2026-10-15','2026-10-15'));expect(n.values.bookings).toBeNull();expect(n.values.visits).toBeNull();expect(n.style).toBe('ec');
});

test('CMP-20: 運営の本人と店の統括が違っても検証済みの代理は読め、通常の偽の所属は拒否',async()=>{
 d.raw.exec("UPDATE staff_members SET tenant_id='other' WHERE id='o'");
 expect((await gapCall(gapApp(d,[storeComparison],{...gapOwner}),url)).status).toBe(403);
 expect((await gapCall(gapApp(d,[storeComparison],{...gapOwner},true),url)).status).toBe(200);
});

test('CMP-05/09/10: プールと現在の可視店の交差だけで比較し、指標ごとに3店未満の平均はnull',async()=>{
 snapshot('a',3);snapshot('a2',9);snapshot('a3',6);snapshot('b',999);
 d.raw.exec("INSERT INTO traffic_pools(id,slug,name,active_account_id,is_active,created_at,updated_at) VALUES('pool','p','比較用','a',1,'now','now'),('foreign','f','他統括','b',1,'now','now'); INSERT INTO pool_accounts(id,pool_id,line_account_id) VALUES('pa','pool','a'),('pb','pool','a2'),('pc','pool','b')");
 let data=await read(url+'&poolId=pool&compare=average');expect(data.rows.map((r:any)=>r.accountId)).toEqual(['a','a2']);expect(data.average.bookings).toBeNull();expect(data.rows.every((r:any)=>r.metrics.bookings.diff===null)).toBe(true);
 d.raw.exec("INSERT INTO pool_accounts(id,pool_id,line_account_id) VALUES('pd','pool','a3')");data=await read(url+'&poolId=pool&compare=average&order=desc');expect(data.average.bookings).toBe(6);expect(data.rows[0].accountId).toBe('a2');
 d.raw.exec("UPDATE hq_store_daily_metrics SET bookings=NULL WHERE account_id='a3'");expect((await read(url+'&poolId=pool&compare=average')).average.bookings).toBeNull();
 expect((await gapCall(gapApp(d,[storeComparison]),url+'&poolId=foreign')).status).toBe(404);expect((await gapCall(gapApp(d,[storeComparison]),url+'&poolId=missing')).status).toBe(404);
 d.raw.exec("UPDATE staff_members SET account_scope='accounts' WHERE id='o'; INSERT INTO staff_account_scopes(staff_id,line_account_id,created_at) VALUES('o','a','now')");data=await read(url+'&poolId=pool',{...gapOwner});expect(data.rows.map((r:any)=>r.accountId)).toEqual(['a']);
});

test('日付が変わっても過去の失敗・欠測を少しずつ回収し、集計期間を回復する', async()=>{
 d.raw.exec("UPDATE line_accounts SET is_active=0 WHERE id!='a'; UPDATE line_accounts SET created_at='2026-10-13T15:00:00Z' WHERE id='a'");
 snapshot('a',1,'2026-10-14');
 snapshot('b',999,'2026-10-15');
 d.raw.exec("INSERT INTO hq_store_daily_metrics(account_id,date,state,computed_at) VALUES('a','2026-10-15','failed','2026-10-16T00:00:00Z')");
 const now=new Date('2026-10-18T00:00:00Z');
 for(let i=0;i<4;i++)await processStoreComparison(d.db,now);
 expect(d.raw.prepare("SELECT date,state FROM hq_store_daily_metrics WHERE account_id='a' ORDER BY date").all()).toEqual([
  {date:'2026-10-14',state:'partial'},{date:'2026-10-15',state:'partial'},
  {date:'2026-10-16',state:'partial'},{date:'2026-10-17',state:'partial'},
 ]);
 const period=comparisonPeriod('2026-10-14','2026-10-17'),recovered=await storeNumbers(d.db,'a',period);
 expect(recovered.values.bookings).toBe(1);
 expect(comparisonTrend(recovered.trend,period).map(day=>({date:day.date,state:day.state,bookings:day.values.bookings}))).toEqual([
  {date:'2026-10-14',state:'partial',bookings:1},{date:'2026-10-15',state:'partial',bookings:0},
  {date:'2026-10-16',state:'partial',bookings:0},{date:'2026-10-17',state:'partial',bookings:0},
 ]);
 expect(recovered.trend.every(row=>row.account_id==='a')).toBe(true);
 expect(fetch).not.toHaveBeenCalled();
});


test('昨日の未処理店舗が残っていても過去枠を確保し、JST表記の作成日を落とさない',async()=>{
 d.raw.exec("UPDATE line_accounts SET created_at='2026-10-15T20:00:00' WHERE id='a'; INSERT INTO hq_store_daily_metrics(account_id,date,state,computed_at) VALUES('a','2026-10-15','failed','2026-10-16T00:00:00Z')");
 await processStoreComparison(d.db,new Date('2026-10-18T00:00:00Z'));
 expect(d.raw.prepare("SELECT state FROM hq_store_daily_metrics WHERE account_id='a' AND date='2026-10-15'").get()).toEqual({state:'partial'});
 expect(d.raw.prepare("SELECT count(*) n FROM hq_store_daily_metrics WHERE date='2026-10-17'").get()).toEqual({n:1});
 expect(d.raw.prepare("SELECT count(*) n FROM line_accounts WHERE is_active=1").get()).toEqual({n:4});
});

test('CMP-06: 日別実値、欠測、失敗、日付と中央値を守る',()=>{
 const days=comparisonTrend([{date:'2026-10-14',state:'ready',friends_added:1,friends_blocked:4,friends_at_start:20,broadcast_recipients:100,broadcast_clicks:8,bookings:0,visits:4,no_shows:1,first_response_median_minutes:3.5},{date:'2026-10-15',state:'failed',bookings:99}],comparisonPeriod('2026-10-14','2026-10-16'));
 expect(days.map(d=>d.date)).toEqual(['2026-10-14','2026-10-15','2026-10-16']);expect(days[0].values).toEqual({friendChange:-3,blockRate:20,clickRate:8,bookings:0,visits:4,noShowRate:20,responseMinutes:3.5});
 expect(days[1].state).toBe('failed');expect(days[2].state).toBe('missing');expect(Object.values(days[1].values).every(value=>value===null)).toBe(true);expect(Object.values(days[2].values).every(value=>value===null)).toBe(true);
});
test('CMP-06/08: 詳細は可視店の対応実件数だけを返し閲覧権限を守る',async()=>{
 snapshot('a',0);seedGapBooking(d,'requested','requested');d.raw.exec("UPDATE friends SET line_account_id='b' WHERE id='f2'; INSERT INTO chats(id,friend_id,line_account_id,status,created_at,updated_at) VALUES('waiting','f','a','unread','now','now'),('foreign','f2','a','unread','now','now')");
 const detail=await read('/api/hq/store-comparison/a?from=2026-10-15&to=2026-10-16',{...gapOwner,readOnly:true});
 expect(detail.attention).toMatchObject({status:'ready',counts:{unhandledChats:1,pendingBookings:1,unpaid:0,connections:0}});expect(detail.attention.details).toBeUndefined();expect(detail.trend[1]).toMatchObject({state:'missing',values:{bookings:null}});
 expect((await gapCall(gapApp(d,[storeComparison]),'/api/hq/store-comparison/b')).status).toBe(404);
});
test('CMP-06: 対応の取得失敗を0件と偽らず推移は残す',async()=>{
 snapshot('a',0);d.raw.exec('ALTER TABLE line_account_connection_checks RENAME TO unavailable_connection_checks');
 const detail=await read('/api/hq/store-comparison/a?from=2026-10-15&to=2026-10-15');expect(detail.attention).toEqual({status:'unavailable',counts:null});expect(detail.trend[0].values.bookings).toBe(0);
});

test('CMP-08: 対応件数と同じ範囲のstatusと予約定義IDを行き先へ集計し、B312の詳細は維持する',async()=>{
 d.raw.exec("INSERT INTO chats(id,friend_id,line_account_id,status,created_at,updated_at) VALUES('progress','f','a','in_progress','now','now'),('held','f2','a','on_hold','now','now'); INSERT INTO events(id,line_account_id,name) VALUES('definition a&b','a','公開イベント'); INSERT INTO event_slots(id,event_id,starts_at,ends_at) VALUES('occurrence-a','definition a&b','2026-11-01T01:00:00Z','2026-11-01T02:00:00Z'); INSERT INTO event_bookings(id,line_account_id,event_id,slot_id,friend_id,identity_key,status,requested_at) VALUES('booking-private-id','a','definition a&b','occurrence-a','f','friend:f','requested','now')");
 const detail=await read('/api/hq/store-comparison/a');
 expect(detail.attention.targets.unhandledChats).toEqual([{href:'/chats?status=in_progress',count:1},{href:'/chats?status=on_hold',count:1}]);
 expect(detail.attention.targets.pendingBookings).toEqual([{href:'/events/bookings?id=definition%20a%26b',count:1}]);expect(JSON.stringify(detail.attention)).not.toContain('booking-private-id');
 const original=await readAccountAttention(d.db,'a');expect(original.details.pendingBookings).toEqual([{id:'booking-private-id',href:'/events/bookings'}]);
});

test('CMP-17: 開いて日が浅い店は、そろった日だけで数を出し何日分かを返す（0日・一部・全部）',async()=>{
 // 期間は 10/13〜10/15 の 3 日。a と a2 は 3 日そろう、a3 は 10/15 の 1 日だけ、b は見えない店。
 const period='/api/hq/store-comparison?from=2026-10-13&to=2026-10-15&compare=average';
 for(const day of ['2026-10-13','2026-10-14','2026-10-15']){snapshot('a',2,day);snapshot('a2',4,day);}
 snapshot('a3',9,'2026-10-15');
 d.raw.exec("UPDATE hq_store_daily_metrics SET broadcast_recipients=10,broadcast_clicks=CASE account_id WHEN 'a3' THEN 5 ELSE 1 END");
 let data=await read(period);
 const row=(id:string)=>data.rows.find((r:any)=>r.accountId===id);
 expect(row('a')).toMatchObject({coveredDays:3,periodDays:3});expect(row('a3')).toMatchObject({coveredDays:1,periodDays:3});
 expect(row('a3').computedAt).toBe('2026-10-16T00:00:00Z');
 // 件数：一部の店も数は出す（1日分の 9 件）。日数の違う店と比べないので、差と平均は全部の日がそろった店だけ。
 expect(row('a3').metrics.bookings).toMatchObject({value:9,diff:null,available:true});
 expect(data.average.bookings).toBeNull();
 // 割合：そろった日の分で、全店の平均との差を出す（(10+10+50)/3）。
 expect(row('a3').metrics.clickRate.value).toBe(50);expect(data.average.clickRate).toBeCloseTo(70/3,6);expect(row('a3').metrics.clickRate.diff).toBeCloseTo(50-70/3,6);
 // 3 店とも全部の日がそろえば件数の平均と差も出る。
 for(const day of ['2026-10-13','2026-10-14'])snapshot('a3',0,day);
 data=await read(period);expect(row('a3')).toMatchObject({coveredDays:3,periodDays:3});expect(data.average.bookings).toBe((6+12+9)/3);expect(row('a3').metrics.bookings.diff).toBe(0);
 // 0 日の店は今のまま「—」（null）で、何日分かは 0。
 d.raw.exec("DELETE FROM hq_store_daily_metrics WHERE account_id='a3'");
 data=await read(period);expect(row('a3')).toMatchObject({coveredDays:0,periodDays:3,computedAt:null});expect(Object.values(row('a3').metrics).every((m:any)=>m.value===null&&m.diff===null)).toBe(true);
 // 詳細の口も同じ日数を返す。
 expect(await read('/api/hq/store-comparison/a3?from=2026-10-13&to=2026-10-15')).toMatchObject({coveredDays:0,periodDays:3});
 expect(await read('/api/hq/store-comparison/a?from=2026-10-12&to=2026-10-15')).toMatchObject({coveredDays:3,periodDays:4,values:{bookings:6}});
});
test('CMP-17: 前の期間との差は、両方の期間の全部の日がそろった時だけ件数を比べる',async()=>{
 for(const day of ['2026-10-14','2026-10-15'])snapshot('a',3,day);snapshot('a',1,'2026-10-13');
 const now=await read('/api/hq/store-comparison?from=2026-10-14&to=2026-10-15');
 const a=now.rows.find((r:any)=>r.accountId==='a');expect(a.metrics.bookings).toMatchObject({value:6,diff:null});
 snapshot('a',2,'2026-10-12');
 const full=(await read('/api/hq/store-comparison?from=2026-10-14&to=2026-10-15')).rows.find((r:any)=>r.accountId==='a');expect(full.metrics.bookings).toMatchObject({value:6,diff:3});
 // 今の期間が一部だけなら、前の期間がそろっていても件数は比べない（割合は比べる）。
 d.raw.exec("DELETE FROM hq_store_daily_metrics WHERE account_id='a' AND date='2026-10-14'");
 const partial=(await read('/api/hq/store-comparison?from=2026-10-14&to=2026-10-15')).rows.find((r:any)=>r.accountId==='a');expect(partial).toMatchObject({coveredDays:1,periodDays:2});expect(partial.metrics.bookings).toMatchObject({value:3,diff:null});expect(partial.metrics.blockRate).toMatchObject({value:1,diff:-1});
});
test('CMP-01/17: 返事の速さは、そろった日の返事だけで真ん中の値を出す',async()=>{
 d.raw.exec(`INSERT INTO hq_store_response_samples(account_id,chat_id,pending_since,responded_at,minutes) VALUES('a','c1','2026-10-13T00:00:00Z','2026-10-13T01:00:00Z',100),('a','c2','2026-10-14T00:00:00Z','2026-10-14T01:00:00Z',4),('a','c3','2026-10-14T23:00:00Z','2026-10-14T23:30:00Z',6)`);
 snapshot('a',0,'2026-10-14');snapshot('a',0,'2026-10-15');d.raw.exec("INSERT INTO hq_store_daily_metrics(account_id,date,state,computed_at) VALUES('a','2026-10-13','failed','2026-10-16T00:00:00Z')");
 // 10/13 は失敗の日なので 100 分は入れない。10/14 23:30Z は日本時間 10/15 の返事。
 const n=await storeNumbers(d.db,'a',comparisonPeriod('2026-10-13','2026-10-15'));expect(n).toMatchObject({coveredDays:2,periodDays:3});expect(n.values.responseMinutes).toBe(5);
});

test('クリックした人を特定できない記録は、比較用のクリック率を0としない',async()=>{
 d.raw.exec(`INSERT INTO broadcasts(id,title,message_type,message_content,line_account_id,status,sent_at,success_count) VALUES('b1','配信','text','本文','a','sent','2026-10-15T01:00:00Z',20);
 INSERT INTO tracked_links(id,name,original_url,line_account_id) VALUES('l1','リンク','https://example.com','a');
 INSERT INTO broadcast_tracked_links(broadcast_id,tracked_link_id,label,created_at) VALUES('b1','l1','リンク','2026-10-15');
 INSERT INTO link_clicks(id,tracked_link_id,friend_id,clicked_at) VALUES('anonymous','l1',NULL,'2026-10-15T02:00:00Z');`);
 await snapshotStoreMetrics(d.db,'a','2026-10-15');
 const n=await storeNumbers(d.db,'a',comparisonPeriod('2026-10-15','2026-10-15'));
 expect(n.values.clickRate).toBeNull();
});
