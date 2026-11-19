import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {gapFixture} from '../../test-utils/gap1.js';
import {NotificationDeliveryBlocked} from '../../services/recorded-notification-send.js';
import {processLiveAutoLine,processStagingAutoLine} from './ec-auto-line-live.js';
const fakeProxy=vi.hoisted(()=>vi.fn(async (_request:Request)=>new Response('',{status:200,headers:{'x-line-request-id':'fake'}})));
vi.mock('../../services/local-line-proxy.js',()=>({dispatchLineProxyLocally:fakeProxy}));
vi.mock('../../services/feature-enforcement.js',()=>({featureJobCanRun:vi.fn(async()=>true)}));
let f:ReturnType<typeof gapFixture>;
const now=new Date('2026-10-16T03:00:00Z');
const send=vi.fn(async()=>{});
beforeEach(()=>{
 f=gapFixture();fakeProxy.mockClear();vi.useFakeTimers();vi.setSystemTime(now);send.mockReset().mockResolvedValue(undefined);
 f.raw.exec(`INSERT INTO ec_connectors(id,line_account_id,provider,shop_domain,status,created_at,updated_at) VALUES('ec','a','ec_cube','example.test','connected','now','now');
 INSERT INTO users(id,tenant_id) VALUES('u','t');
 INSERT INTO identity_candidates(id,tenant_id,kind,status,confidence_score,detector_version,left_subject_kind,left_subject_id,left_line_account_id,left_snapshot_json,right_subject_kind,right_subject_id,right_line_account_id,right_snapshot_json,evidence_fingerprint,evidence_json,impact_json,detected_at,created_at,updated_at) VALUES('candidate','t','friend_duplicate','linked',100,'v1','friend','f','a','{}','friend','f2','a','{}','cap-fingerprint','[]','[]','2026-10-01','2026-10-01','2026-10-01');
 INSERT INTO friend_identity_links(id,tenant_id,candidate_id,user_id,friend_id,link_method,evidence_snapshot_json,confidence_score,linked_at) VALUES('link','t','candidate','u','f','operator_review','[]',100,'2026-10-01');
 INSERT INTO ec_auto_line_product_identities(tenant_id,account_id,product_id,canonical_product_id,evidence_ref,verified_at) VALUES('t','a','p','p','catalog','2026-10-01');
 INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('a','f','marketing','granted','本人','liff');
 INSERT INTO account_settings(id,line_account_id,key,value) VALUES('test','a','test_recipients','["f"]');
 INSERT INTO ec_auto_line_rules(account_id,kind,enabled,wait_minutes,messages_json) VALUES('a','cart',1,60,'[{"type":"text","text":"お知らせ"}]');
 INSERT INTO ec_behavior_events(id,account_id,friend_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key) VALUES('event','a','f','cart_add','p','{}','2026-10-16T01:00:00Z','2026-10-16T01:00:00Z','event');`);
});
afterEach(()=>{vi.useRealTimers();f.raw.close();});
const state=()=>f.raw.prepare('SELECT state FROM ec_auto_line_live_intents').get();
it('受理されたら送信済みとし、上限を記録して重複送信しない',async()=>{
 expect(await processLiveAutoLine(f.db,now,send)).toEqual({processed:1});
 expect(await processLiveAutoLine(f.db,now,send)).toEqual({processed:0});
 expect(send).toHaveBeenCalledTimes(1);expect(state()).toEqual({state:'sent'});
 expect(f.raw.prepare("SELECT mode,state FROM ec_auto_line_cap_reservations").get()).toEqual({mode:'live',state:'accepted'});
});
it('結果不明を保持し自動再送しない',async()=>{
 send.mockRejectedValue(new Error('connection lost'));
 await processLiveAutoLine(f.db,now,send);await processLiveAutoLine(f.db,now,send);
 expect(send).toHaveBeenCalledTimes(1);expect(state()).toEqual({state:'unknown'});
 expect(f.raw.prepare('SELECT state FROM ec_auto_line_cap_reservations').get()).toEqual({state:'unknown'});
});
it('送信前の拒否は失敗として残す',async()=>{
 send.mockRejectedValue(new NotificationDeliveryBlocked('stopped'));
 await processLiveAutoLine(f.db,now,send);await processLiveAutoLine(f.db,now,send);
 expect(send).toHaveBeenCalledTimes(1);expect(state()).toEqual({state:'failed'});
 expect(f.raw.prepare('SELECT state,release_reason FROM ec_auto_line_cap_reservations').get()).toEqual({state:'released',release_reason:'delivery_failed_before_acceptance'});
});
it('検証先以外・同意の撤回・ブロックでは送らない',async()=>{
 f.raw.exec("UPDATE account_settings SET value='[]' WHERE id='test'");await processLiveAutoLine(f.db,now,send);
 f.raw.exec("UPDATE account_settings SET value='[\"f\"]' WHERE id='test'; UPDATE friend_delivery_consents SET state='revoked'");await processLiveAutoLine(f.db,now,send);
 f.raw.exec("UPDATE friend_delivery_consents SET state='granted'; UPDATE friends SET is_following=0 WHERE id='f'");await processLiveAutoLine(f.db,now,send);
 expect(send).not.toHaveBeenCalled();expect(state()).toEqual({state:'scheduled'});
});
it.each([{DEPLOY_ENV:'staging'},{DEPLOY_ENV:'production',EC_AUTO_LINE_LIVE_SEND_ENABLED:'true'},{DEPLOY_ENV:'test',EC_AUTO_LINE_LIVE_SEND_ENABLED:'true'}])('明示的な検証設定がなければ送らない %o',async settings=>{
 expect(await processStagingAutoLine({DB:f.db,...settings} as never,now)).toEqual({processed:0});
 expect(state()).toEqual({state:'scheduled'});
});
it.each(['browse','restock'] as const)('%s の予定も検証先に一度だけ送る',async kind=>{
 f.raw.exec("DELETE FROM ec_auto_line_live_intents;DELETE FROM ec_behavior_events;DELETE FROM ec_auto_line_rules");
 f.raw.prepare('INSERT INTO ec_auto_line_rules(account_id,kind,enabled,wait_minutes,messages_json) VALUES(?,?,1,0,?)').run('a',kind,'[{"type":"text","text":"お知らせ"}]');
 if(kind==='browse')f.raw.exec(`INSERT INTO ec_behavior_events(id,account_id,friend_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key) VALUES
 ('v1','a','f','product_view','p','{}','2026-10-16T01:00:00Z','2026-10-16T01:00:00Z','v1'),
 ('v2','a','f','product_view','p','{}','2026-10-16T02:00:00Z','2026-10-16T02:00:00Z','v2')`);
 else f.raw.exec(`INSERT INTO ec_behavior_events(id,account_id,friend_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key) VALUES
 ('sub','a','f','restock_subscribe','p','{}','2026-10-16T01:00:00Z','2026-10-16T01:00:00Z','sub'),
 ('stock','a',NULL,'restock','p','{"stock":1}','2026-10-16T02:00:00Z','2026-10-16T02:00:00Z','stock')`);
 await processLiveAutoLine(f.db,now,send);await processLiveAutoLine(f.db,now,send);
 expect(send).toHaveBeenCalledTimes(1);expect(state()).toEqual({state:'sent'});
});
it('夜間の予定は翌朝へ延期する',async()=>{
 f.raw.exec("UPDATE ec_auto_line_live_intents SET due_at='2026-10-16T13:00:00.000Z',original_due_at='2026-10-16T13:00:00.000Z'");
 const night=new Date('2026-10-16T13:30:00Z');vi.setSystemTime(night);
 await processLiveAutoLine(f.db,night,send);
 expect(send).not.toHaveBeenCalled();
 expect(f.raw.prepare('SELECT due_at,state FROM ec_auto_line_live_intents').get()).toEqual({due_at:'2026-10-16T23:00:00.000Z',state:'scheduled'});
});

it('HTTP 408 の結果は不明として保留し自動再送しない',async()=>{
 send.mockRejectedValue(Object.assign(new Error('timeout'),{status:408}));
 await processLiveAutoLine(f.db,now,send);await processLiveAutoLine(f.db,now,send);
 expect(send).toHaveBeenCalledTimes(1);expect(state()).toEqual({state:'unknown'});
 expect(f.raw.prepare('SELECT state FROM ec_auto_line_cap_reservations').get()).toEqual({state:'unknown'});
});
it('上限枠を確保した後に検証先を外されたら送らない',async()=>{
 const original=f.db.prepare.bind(f.db);let changed=false;
 const racing={...f.db,prepare(sql:string){
  if(!changed&&sql.startsWith("UPDATE ec_auto_line_cap_reservations SET state='started'")){
   changed=true;f.raw.exec("UPDATE account_settings SET value='[]' WHERE id='test'");
  }
  return original(sql);
 }} as D1Database;
 await processLiveAutoLine(racing,now,send);
 expect(changed).toBe(true);expect(send).not.toHaveBeenCalled();expect(state()).toEqual({state:'failed'});
});
it('上限枠を確保した後に同意を撤回されたら送らない',async()=>{
 const original=f.db.prepare.bind(f.db);let changed=false;
 const racing={...f.db,prepare(sql:string){
  if(!changed&&sql.startsWith("UPDATE ec_auto_line_cap_reservations SET state='started'")){
   changed=true;f.raw.exec("UPDATE friend_delivery_consents SET state='revoked'");
  }
  return original(sql);
 }} as D1Database;
 await processLiveAutoLine(racing,now,send);
 expect(changed).toBe(true);expect(send).not.toHaveBeenCalled();expect(state()).toEqual({state:'failed'});
});
it('LINE が400で拒否したら失敗にし再送しない',async()=>{
 send.mockRejectedValue(Object.assign(new Error('rejected'),{status:400}));
 await processLiveAutoLine(f.db,now,send);await processLiveAutoLine(f.db,now,send);
 expect(send).toHaveBeenCalledTimes(1);expect(state()).toEqual({state:'failed'});
});

it('検証設定が有効なら模擬プロキシへ送り、LINE の再試行キーを渡す',async()=>{
 const env={DB:f.db,DEPLOY_ENV:'staging',EC_AUTO_LINE_LIVE_SEND_ENABLED:'true',WORKER_PUBLIC_URL:'https://worker.invalid'} as never;
 await processStagingAutoLine(env,now);await processStagingAutoLine(env,now);
 expect(fakeProxy).toHaveBeenCalledTimes(1);
 const request=fakeProxy.mock.calls[0][0];
 expect(request.headers.get('x-line-retry-key')).toMatch(/^[0-9a-f-]{36}$/);
 expect(await request.json()).toMatchObject({to:'Uf',messages:[{type:'text',text:'お知らせ'}]});
 expect(state()).toEqual({state:'sent'});
});
it('受理後の保存が失敗しても次回に台帳から復旧し、再送しない',async()=>{
 f.raw.exec("CREATE TRIGGER fail_intent_complete BEFORE UPDATE ON ec_auto_line_live_intents WHEN NEW.state='sent' BEGIN SELECT RAISE(ABORT,'failed'); END");
 await expect(processLiveAutoLine(f.db,now,send)).rejects.toThrow();
 expect(send).toHaveBeenCalledTimes(1);expect(state()).toEqual({state:'sending'});
 f.raw.exec('DROP TRIGGER fail_intent_complete');
 await processLiveAutoLine(f.db,now,send);
 expect(send).toHaveBeenCalledTimes(1);expect(state()).toEqual({state:'sent'});
 expect(f.raw.prepare('SELECT state FROM ec_auto_line_cap_reservations').get()).toEqual({state:'accepted'});
});
it('同じ人の複数の商品も1日の上限を共有する',async()=>{
 f.raw.exec(`INSERT INTO ec_auto_line_product_identities(tenant_id,account_id,product_id,canonical_product_id,evidence_ref,verified_at) VALUES('t','a','other-product','other-product','catalog','2026-10-01');
 INSERT INTO ec_behavior_events(id,account_id,friend_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key) VALUES('event2','a','f','cart_add','other-product','{}','2026-10-16T01:01:00Z','2026-10-16T01:01:00Z','event2')`);
 await processLiveAutoLine(f.db,now,send);await processLiveAutoLine(f.db,now,send);
 expect(send).toHaveBeenCalledTimes(1);
 expect(f.raw.prepare("SELECT count(*) n FROM ec_auto_line_cap_reservations WHERE mode='live' AND state='accepted'").get()).toEqual({n:1});
 expect(f.raw.prepare("SELECT count(*) n FROM ec_auto_line_live_intents WHERE state='sent'").get()).toEqual({n:1});
});
