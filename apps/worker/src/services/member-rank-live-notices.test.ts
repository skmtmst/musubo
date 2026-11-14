import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {gapFixture,gapApp,gapCall} from '../test-utils/gap1.js';
import {memberRanks} from '../routes/member-ranks.js';
import {processLiveRankNotices} from './member-rank-live-notices.js';
const fakeProxy=vi.hoisted(()=>vi.fn(async (_request:Request)=>new Response('',{status:200,headers:{'x-line-request-id':'fake-request'}})));
vi.mock('./local-line-proxy.js',()=>({dispatchLineProxyLocally:fakeProxy}));
vi.mock('./feature-enforcement.js',()=>({featureJobCanRun:vi.fn(async()=>true)}));

let fixture:ReturnType<typeof gapFixture>;
const now=new Date('2026-10-17T01:00:00.000Z');
const transmit=vi.fn(async()=>undefined);
beforeEach(()=>{
 fixture=gapFixture();fakeProxy.mockClear();vi.useFakeTimers();vi.setSystemTime(now);transmit.mockReset().mockResolvedValue(undefined);
 fixture.raw.exec(`INSERT INTO tags(id,name,line_account_id) VALUES('rank-tag','ランク','a');
 INSERT INTO member_rank_programs(account_id,status,updated_at) VALUES('a','active','2026-10-17T00:00:00Z');
 INSERT INTO member_rank_tiers(id,account_id,sort,name,threshold,tag_id) VALUES('tier','a',0,'金',0,'rank-tag');
 INSERT INTO member_rank_notices(id,account_id,friend_id,change_key,kind,tier_id,purpose,messages_json,base_messages_json,scheduled_at)
 VALUES('notice-1','a','f','2026-10-17T00:00:00.000Z:tier','upgrade','tier','marketing','[{"type":"text","text":"ランク変更"},{"type":"text","text":"特典"}]','[{"type":"text","text":"ランク変更"}]','2026-10-17T01:00:00.000Z');`);
});
afterEach(()=>{vi.useRealTimers();fixture.raw.close()});
it('模擬の送信先へ一度だけ送り、共通台帳に受理を残す',async()=>{
 await processLiveRankNotices(fixture.db,now,{transmit});await processLiveRankNotices(fixture.db,now,{transmit});
 expect(transmit).toHaveBeenCalledTimes(1);
 expect(fixture.raw.prepare("SELECT status FROM outbound_send_requests WHERE resource_id='rank-notice:notice-1'").get()).toEqual({status:'succeeded'});
 const response=await gapCall(gapApp(fixture,[memberRanks]),'/api/member-ranks/notices?account_id=a');
 const body=await response.json() as {data:{items:Array<{status:string;testMode:number}>}};
 expect(body.data.items[0]).toMatchObject({status:'sent',testMode:0});
 fixture.raw.exec("INSERT INTO member_rank_history(id,account_id,friend_id,to_tier_id,reason,at) VALUES('history','a','f','tier','upgrade','2026-10-17T00:00:00.000Z')");
 const history=await gapCall(gapApp(fixture,[memberRanks]),'/api/friends/f/member-rank?account_id=a');
 const details=await history.json() as {data:{history:Array<{notified:number}>}};expect(details.data.history[0].notified).toBe(1);
});
it('宣伝を停止した人には基本の知らせだけを送り、通知自体の停止なら送らない',async()=>{
 fixture.raw.exec("INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('a','f','marketing','revoked','本人','liff')");
 await processLiveRankNotices(fixture.db,now,{transmit});
 expect(transmit).toHaveBeenCalledWith(expect.objectContaining({messages:[{type:'text',text:'ランク変更'}]}));
 expect(fixture.raw.prepare('SELECT purpose FROM member_rank_notices').get()).toEqual({purpose:'notice'});
});
it.each(['通知停止','ブロック','3時間超過'] as const)('%s では送らない',async condition=>{
 if(condition==='通知停止')fixture.raw.exec("INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('a','f','notice','revoked','本人','liff')");
 if(condition==='ブロック')fixture.raw.exec("UPDATE friends SET is_following=0 WHERE id='f'");
 if(condition==='3時間超過')vi.setSystemTime(new Date('2026-10-17T04:01:00.000Z'));
 await processLiveRankNotices(fixture.db,new Date(),{transmit});expect(transmit).not.toHaveBeenCalled();
});

it('送信の直前に通知を停止したら送らず、台帳に再確認待ちを残す',async()=>{
 const original=fixture.db.prepare.bind(fixture.db);let reads=0;
 vi.spyOn(fixture.db,'prepare').mockImplementation((sql:string)=>{
  if(sql.includes('SELECT n.id,n.account_id')&&++reads===2){fixture.raw.exec("INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('a','f','notice','revoked','本人','liff')");}
  return original(sql);
 });
 await processLiveRankNotices(fixture.db,now,{transmit});expect(transmit).not.toHaveBeenCalled();
});
it('夜間と予定時刻前には送らない',async()=>{
 fixture.raw.exec("UPDATE member_rank_notices SET scheduled_at='2026-10-16T23:00:00.000Z'");
 vi.setSystemTime(new Date('2026-10-16T23:10:00.000Z'));
 await processLiveRankNotices(fixture.db,new Date(),{transmit});expect(transmit).not.toHaveBeenCalled();
 fixture.raw.exec("UPDATE member_rank_notices SET scheduled_at='2026-10-17T01:01:00.000Z'");vi.setSystemTime(now);
 await processLiveRankNotices(fixture.db,new Date(),{transmit});expect(transmit).not.toHaveBeenCalled();
});
it('受理が不明な場合は自動で再送せず、一覧から分かる',async()=>{
 transmit.mockRejectedValue(new Error('connection lost'));
 await processLiveRankNotices(fixture.db,now,{transmit});await processLiveRankNotices(fixture.db,now,{transmit});
 expect(transmit).toHaveBeenCalledTimes(1);
 expect(fixture.raw.prepare("SELECT status FROM outbound_send_requests WHERE resource_id='rank-notice:notice-1'").get()).toEqual({status:'unknown'});
 const response=await gapCall(gapApp(fixture,[memberRanks]),'/api/member-ranks/notices?account_id=a');
 const body=await response.json() as {data:{items:Array<{status:string;testMode:number}>}};
 expect(body.data.items[0]).toMatchObject({status:'delivery_unknown',testMode:0});
});
it.each([{DEPLOY_ENV:'production',RANK_NOTICE_STAGING_DELIVERY_ENABLED:'true'},{DEPLOY_ENV:'staging'},{DEPLOY_ENV:'test',RANK_NOTICE_STAGING_DELIVERY_ENABLED:'true'}])('検証環境で明示されない送信口は動かない: %o',async settings=>{
 const {processStagingRankNotices}=await import('./member-rank-live-notices.js');
 await expect(processStagingRankNotices({DB:fixture.db,...settings} as never,now)).rejects.toThrow('rank_notice_delivery_disabled');
 expect(fixture.raw.prepare('SELECT count(*) n FROM outbound_send_requests').get()).toEqual({n:0});
});
it('宣伝の同意が直前に変わったら、古い本文は送らない',async()=>{
 const original=fixture.db.prepare.bind(fixture.db);let reads=0;
 vi.spyOn(fixture.db,'prepare').mockImplementation((sql:string)=>{
  if(sql.includes('SELECT n.id,n.account_id')&&++reads===2)fixture.raw.exec("INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('a','f','marketing','revoked','本人','liff')");
  return original(sql);
 });
 await processLiveRankNotices(fixture.db,now,{transmit});expect(transmit).not.toHaveBeenCalled();
});
it('送信前に宣伝の同意が変わったら、次回は基本の知らせを送れる',async()=>{
 const original=fixture.db.prepare.bind(fixture.db);let reads=0;
 const spy=vi.spyOn(fixture.db,'prepare').mockImplementation((sql:string)=>{
  if(sql.includes('SELECT n.id,n.account_id')&&++reads===2)fixture.raw.exec("INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('a','f','marketing','revoked','本人','liff')");
  return original(sql);
 });
 await processLiveRankNotices(fixture.db,now,{transmit});expect(transmit).not.toHaveBeenCalled();
 spy.mockRestore();
 await processLiveRankNotices(fixture.db,now,{transmit});
 expect(transmit).toHaveBeenCalledWith(expect.objectContaining({messages:[{type:'text',text:'ランク変更'}]}));
});
it('運用の停止により送信口が断った場合は受理不明として扱わない',async()=>{
 const {NotificationDeliveryBlocked}=await import('./recorded-notification-send.js');
 transmit.mockRejectedValue(new NotificationDeliveryBlocked('sending_stopped'));
 await processLiveRankNotices(fixture.db,now,{transmit});
 expect(fixture.raw.prepare("SELECT status,failure_code FROM outbound_send_requests WHERE resource_id='rank-notice:notice-1'").get()).toEqual({status:'failed',failure_code:'NOTIFICATION_PRECONDITION_CHANGED'});
 const response=await gapCall(gapApp(fixture,[memberRanks]),'/api/member-ranks/notices?account_id=a');
 const body=await response.json() as {data:{items:Array<{status:string}>}};expect(body.data.items[0].status).toBe('delivery_blocked');
});
it('受理後に台帳の完了保存が失敗しても再送しない',async()=>{
 fixture.raw.exec("CREATE TRIGGER stop_rank_complete BEFORE UPDATE ON outbound_send_requests WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'fixture'); END");
 await processLiveRankNotices(fixture.db,now,{transmit});await processLiveRankNotices(fixture.db,now,{transmit});
 expect(transmit).toHaveBeenCalledTimes(1);
 expect(fixture.raw.prepare("SELECT status FROM outbound_send_requests WHERE resource_id='rank-notice:notice-1'").get()).toEqual({status:'unknown'});
});
it('停止後のランク通知は送らない',async()=>{
 fixture.raw.exec("UPDATE member_rank_programs SET status='stopped' WHERE account_id='a'");
 await processLiveRankNotices(fixture.db,now,{transmit});expect(transmit).not.toHaveBeenCalled();
 expect(fixture.raw.prepare('SELECT status FROM member_rank_notices').get()).toEqual({status:'skipped_disabled'});
});

it('別の店の友だちを参照する不正な行は送らない',async()=>{
 fixture.raw.exec("INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES('other-f','Uother','見本','b'); UPDATE member_rank_notices SET friend_id='other-f' WHERE id='notice-1'");
 await processLiveRankNotices(fixture.db,now,{transmit});
 expect(transmit).not.toHaveBeenCalled();
});

it('検証環境の送信はプロキシの偽応答と共通の再試行キーを使う',async()=>{
 const {processStagingRankNotices}=await import('./member-rank-live-notices.js');
 const env={DB:fixture.db,DEPLOY_ENV:'staging',RANK_NOTICE_STAGING_DELIVERY_ENABLED:'true',WORKER_PUBLIC_URL:'https://worker.invalid'} as never;
 await processStagingRankNotices(env,now);await processStagingRankNotices(env,now);
 expect(fakeProxy).toHaveBeenCalledTimes(1);
 const request=fakeProxy.mock.calls[0][0];expect(request.headers.get('x-line-retry-key')).toMatch(/^[0-9a-f-]{36}$/);
 expect(request.headers.get('x-line-harness-source')).toBeNull();
 expect(await request.json()).toMatchObject({to:'Uf',messages:[{type:'text',text:'ランク変更'},{type:'text',text:'特典'}]});
});
it('本文のJSONに空白があっても同じ内容として送信前に照合する',async()=>{
 fixture.raw.prepare('UPDATE member_rank_notices SET messages_json=?').run('[ { "type": "text", "text": "ランク変更" } ]');
 const {processStagingRankNotices}=await import('./member-rank-live-notices.js');
 await processStagingRankNotices({DB:fixture.db,DEPLOY_ENV:'staging',RANK_NOTICE_STAGING_DELIVERY_ENABLED:'true',WORKER_PUBLIC_URL:'https://worker.invalid'} as never,now);
 expect(fakeProxy).toHaveBeenCalledTimes(1);
 expect(await fakeProxy.mock.calls[0][0].json()).toMatchObject({messages:[{type:'text',text:'ランク変更'}]});
});
it('機能が停止中なら送信せず、共通台帳に理由を残す',async()=>{
 const {featureJobCanRun}=await import('./feature-enforcement.js');vi.mocked(featureJobCanRun).mockResolvedValueOnce(false);
 const {processStagingRankNotices}=await import('./member-rank-live-notices.js');
 await processStagingRankNotices({DB:fixture.db,DEPLOY_ENV:'staging',RANK_NOTICE_STAGING_DELIVERY_ENABLED:'true'} as never,now);
 expect(fakeProxy).not.toHaveBeenCalled();
 expect(fixture.raw.prepare("SELECT status,failure_code FROM outbound_send_requests WHERE resource_id='rank-notice:notice-1'").get()).toEqual({status:'failed',failure_code:'NOTIFICATION_PRECONDITION_CHANGED'});
 const response=await gapCall(gapApp(fixture,[memberRanks]),'/api/member-ranks/notices?account_id=a');
 const body=await response.json() as {data:{items:Array<{status:string}>}};expect(body.data.items[0].status).toBe('delivery_blocked');
});
