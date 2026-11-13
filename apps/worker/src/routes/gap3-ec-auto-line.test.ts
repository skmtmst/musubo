import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {gapFixture,gapApp,gapCall,gapOwner} from '../test-utils/gap1.js';
import {ecAutoLine} from './ec-auto-line.js';
import {ingestBehavior,processAutoLineMock} from '../features/ec-commerce/ec-auto-line.js';
import {encryptCredential} from '@line-crm/db';
let d:ReturnType<typeof gapFixture>;
const encryptionKey=btoa('x'.repeat(32));
const at=new Date('2026-10-16T03:00:00Z'); // 東京の正午を基準にする。
beforeEach(()=>{d=gapFixture();vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('external_forbidden');}));d.raw.exec("INSERT INTO ec_connectors(id,line_account_id,provider,shop_domain,status,created_at,updated_at) VALUES('ec','a','ec_cube','example.test','connected','now','now'); INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('a','f','marketing','granted','本人','liff')");});
beforeEach(()=>{
 if(!d.raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ec_auto_line_cap_reservations'").get())d.raw.exec(readFileSync(new URL('../../../../packages/db/migrations/765_ec_auto_line_cap.sql',import.meta.url),'utf8'));
 d.raw.exec(`INSERT INTO users(id,tenant_id) VALUES('cap-user','t');
 INSERT INTO identity_candidates(id,tenant_id,kind,status,confidence_score,detector_version,left_subject_kind,left_subject_id,left_line_account_id,left_snapshot_json,right_subject_kind,right_subject_id,right_line_account_id,right_snapshot_json,evidence_fingerprint,evidence_json,impact_json,detected_at,created_at,updated_at) VALUES('cap-candidate','t','friend_duplicate','linked',100,'v1','friend','f','a','{}','friend','f2','a','{}','cap-fingerprint','[]','[]','2026-10-01','2026-10-01','2026-10-01');
 INSERT INTO friend_identity_links(id,tenant_id,candidate_id,user_id,friend_id,link_method,evidence_snapshot_json,confidence_score,linked_at) VALUES('cap-link','t','cap-candidate','cap-user','f','operator_review','[]',100,'2026-10-01');
 INSERT INTO ec_auto_line_product_identities(tenant_id,account_id,product_id,canonical_product_id,evidence_ref,verified_at) VALUES('t','a','p','p','test-catalog','2026-10-01');`);
});
afterEach(()=>{d.raw.close();vi.unstubAllGlobals();vi.useRealTimers();});
const app=(s=gapOwner,im=false)=>gapApp(d,[ecAutoLine],s,im,{LINE_CREDENTIAL_ENCRYPTION_KEY:encryptionKey});
const rule={waitMinutes:60,messages:[{type:'text',text:'お忘れ物があります'}],testMode:true,expectedVersion:0};
async function enable(kind='cart'){
 let r=await gapCall(app(),`/api/ec/auto-line/rules/${kind}?account_id=a`,'PUT',rule);expect(r.status).toBe(200);
 r=await gapCall(app(),`/api/ec/auto-line/rules/${kind}/enable?account_id=a`,'POST',{enabled:true,confirmed:true,testMode:true,expectedVersion:1},'enable-'+kind);expect(r.status).toBe(200);
}
function scheduled(id='e',product='p',kind='cart',due='2026-10-16T02:00:00Z'){
 d.raw.prepare("INSERT OR IGNORE INTO ec_auto_line_product_identities(tenant_id,account_id,product_id,canonical_product_id,evidence_ref,verified_at) VALUES('t','a',?,?, 'test-catalog','2026-10-01')").run(product,product);
 d.raw.prepare("INSERT INTO ec_behavior_events(id,account_id,friend_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key) VALUES(?,'a','f',?,?,?,?,'now',?)").run(id,kind==='browse'?'product_view':'cart_add',product,'{}','2026-10-16T01:00:00Z',id);
 d.raw.prepare("INSERT INTO ec_auto_line_sends(id,account_id,rule_kind,friend_id,product_id,trigger_event_id,scheduled_at,original_due_at,messages_snapshot_json) VALUES(?,'a',?,'f',?,?,?,?,?)").run('send-'+id,kind,product,id,due,due,'[]');
}
const states=()=>d.raw.prepare('SELECT status FROM ec_auto_line_sends ORDER BY id').all();
test('EC-02/15/17/18/19/20: 初期停止・版・確認・冪等・代理は理由つき停止だけを監査',async()=>{
 const initial=(await (await gapCall(app(),'/api/ec/auto-line/rules?account_id=a')).json() as any).data;expect(initial.every((r:any)=>r.enabled===false)).toBe(true);
 expect((await gapCall(app(),'/api/ec/auto-line/rules/cart?account_id=a','PUT',{...rule,enabled:true})).status).toBe(400);
 await enable();expect((await gapCall(app(),'/api/ec/auto-line/rules/cart/enable?account_id=a','POST',{enabled:true,confirmed:true,testMode:true,expectedVersion:1},'enable-cart')).status).toBe(200);
 expect(d.raw.prepare('SELECT count(*) n FROM ec_auto_line_rule_events').get()).toEqual({n:2});
 expect((await gapCall(app(),'/api/ec/auto-line/rules/cart?account_id=a','PUT',rule)).status).toBe(409);
 for(const s of [{...gapOwner,readOnly:true},{...gapOwner,role:'staff' as const}])expect((await gapCall(app(s),'/api/ec/auto-line/rules/cart?account_id=a','PUT',rule)).status).toBe(403);
 expect((await gapCall(app(gapOwner,true),'/api/ec/auto-line/rules/cart/enable?account_id=a','POST',{enabled:true,confirmed:true,testMode:true,expectedVersion:2})).status).toBe(403);
 expect((await gapCall(app(gapOwner,true),'/api/ec/auto-line/rules/cart?account_id=a','PUT',{...rule,enabled:false,reason:'緊急停止',expectedVersion:2})).status).toBe(200);
 expect(d.raw.prepare('SELECT impersonation_id,reason FROM ec_auto_line_rule_events WHERE impersonation_id IS NOT NULL').get()).toEqual({impersonation_id:'im',reason:'緊急停止'});expect(fetch).not.toHaveBeenCalled();
});
test('EC-03/04/05/06/07: 10分待機・直前の購入・宣伝停止・3種類共通で1日1通',async()=>{
 await enable();scheduled();await processAutoLineMock(d.db,new Date('2026-10-16T02:09:00Z'));expect(states()).toEqual([{status:'scheduled'}]);
 await processAutoLineMock(d.db,at);expect(states()).toEqual([{status:'simulated'}]);
 await enable('browse');scheduled('e2','p2','browse');await processAutoLineMock(d.db,at);expect(states()).toEqual([{status:'simulated'},{status:'scheduled'}]);
 d.raw.exec("DELETE FROM ec_auto_line_cap_reservations;DELETE FROM ec_auto_line_sends;DELETE FROM ec_behavior_events");scheduled();d.raw.exec("INSERT INTO ec_behavior_events(id,account_id,friend_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key) VALUES('buy','a','f','purchase','other','{}','2026-10-16T01:50:00Z','now','buy')");
 await processAutoLineMock(d.db,at);expect(states()).toEqual([{status:'skipped_purchased'}]);
 d.raw.exec("DELETE FROM ec_auto_line_cap_reservations;DELETE FROM ec_auto_line_sends;DELETE FROM ec_behavior_events;UPDATE friend_delivery_consents SET state='revoked' WHERE line_account_id='a' AND friend_id='f' AND purpose='marketing'");scheduled();await processAutoLineMock(d.db,at);expect(states()).toEqual([{status:'skipped_opted_out'}]);expect(fetch).not.toHaveBeenCalled();
});
test('EC-08/09/13/27: 夜は朝へ・古いカゴを除外・本文は予定時の控え',async()=>{
 await enable();scheduled('night','p','cart','2026-10-16T14:00:00Z');await processAutoLineMock(d.db,new Date('2026-10-16T14:10:00Z'));
 expect(d.raw.prepare('SELECT scheduled_at FROM ec_auto_line_sends').get()).toEqual({scheduled_at:'2026-10-16T23:00:00.000Z'});
 await processAutoLineMock(d.db,new Date('2026-10-16T23:00:00Z'));expect(states()).toEqual([{status:'simulated'}]);
 scheduled('stale','other','cart','2026-10-17T01:00:00Z');await processAutoLineMock(d.db,new Date('2026-10-17T05:00:00Z'));expect(states()).toContainEqual({status:'skipped_late'});
});
test('日次の上限は店舗の時間帯に関係なく日本時間の日付で区切る',async()=>{
 d.raw.prepare("UPDATE booking_settings SET timezone='Pacific/Honolulu' WHERE line_account_id='a'").run();
 await enable();scheduled('previous','old','cart','2026-10-15T13:00:00Z');
 d.raw.prepare("UPDATE ec_auto_line_sends SET status='simulated',sent_at='2026-10-15T14:00:00Z' WHERE id='send-previous'").run();
 scheduled('current','new','cart','2026-10-16T00:00:00Z');
 await processAutoLineMock(d.db,new Date('2026-10-16T01:10:00Z'));
 expect(d.raw.prepare("SELECT status FROM ec_auto_line_sends WHERE id='send-current'").get()).toEqual({status:'simulated'});
});
test('夜間にかからない予定は3時間ちょうどの遅れでも対象から外す',async()=>{
 await enable();scheduled('late','p','cart','2026-10-16T02:00:00Z');
 await processAutoLineMock(d.db,new Date('2026-10-16T05:00:00Z'));
 expect(states()).toEqual([{status:'skipped_late'}]);
});
test('宣伝同意が不明・欠落・矛盾なら保留し、直前の変更も再確認する',async()=>{
 await enable();scheduled();
 d.raw.exec("DELETE FROM friend_delivery_consents WHERE line_account_id='a' AND friend_id='f'");
 expect(await processAutoLineMock(d.db,at)).toEqual({processed:0});expect(states()).toEqual([{status:'scheduled'}]);
 d.raw.exec("INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('a','f','marketing','granted','本人','liff'),('a','f','promotion','unknown','確認待ち','liff')");
 expect(await processAutoLineMock(d.db,at)).toEqual({processed:0});expect(states()).toEqual([{status:'scheduled'}]);
 d.raw.exec("DELETE FROM friend_delivery_consents WHERE purpose='promotion'");
 let injected=false;const original=d.db.prepare.bind(d.db);
 const racing={...d.db,prepare(sql:string){if(!injected&&sql.startsWith('UPDATE ec_auto_line_sends SET status=?')){injected=true;d.raw.exec("UPDATE friend_delivery_consents SET state='unknown' WHERE line_account_id='a' AND friend_id='f'");}return original(sql);}} as D1Database;
 expect(await processAutoLineMock(racing,at)).toEqual({processed:0});expect(injected).toBe(true);expect(states()).toEqual([{status:'scheduled'}]);expect(fetch).not.toHaveBeenCalled();
 d.raw.exec("UPDATE friend_delivery_consents SET state='granted' WHERE line_account_id='a' AND friend_id='f'");injected=false;
 const revoked={...d.db,prepare(sql:string){if(!injected&&sql.startsWith('UPDATE ec_auto_line_sends SET status=?')){injected=true;d.raw.exec("UPDATE friend_delivery_consents SET state='revoked' WHERE line_account_id='a' AND friend_id='f'");}return original(sql);}} as D1Database;
 expect(await processAutoLineMock(revoked,at)).toEqual({processed:1});expect(injected).toBe(true);expect(states()).toEqual([{status:'skipped_opted_out'}]);expect(fetch).not.toHaveBeenCalled();
});
test('EC-23/24/25: 署名・時刻・重複・同意・他店の本人を使わない',async()=>{
 const event={eventId:'event',customerId:'unknown',productId:'p',type:'cart_add',occurredAt:at.toISOString(),trackingConsent:true};
 expect(await ingestBehavior(d.db,'a',{...event,trackingConsent:false},at)).toMatchObject({accepted:false});
 expect(await ingestBehavior(d.db,'a',event,at)).toMatchObject({accepted:true,matched:false});expect(await ingestBehavior(d.db,'a',event,at)).toMatchObject({duplicate:true});
 await expect(ingestBehavior(d.db,'a',{...event,customerId:'different'},at)).rejects.toThrow('idempotency_conflict');
 expect((await gapCall(app(),'/api/ec/events','POST',event)).status).toBe(401);
 const secret='mock-connector-secret-32-characters-long';d.raw.prepare('UPDATE ec_connectors SET inbound_secret_encrypted=?').run(await encryptCredential(secret,encryptionKey));
 const timestamp=String(Math.floor(Date.now()/1000)),raw=JSON.stringify({...event,eventId:'signed',occurredAt:new Date().toISOString()});
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(timestamp+'.'+raw))),x=>x.toString(16).padStart(2,'0')).join('');
 const response=await app().request('/api/ec/events',{method:'POST',headers:{'x-line-account-id':'a','x-nen-timestamp':timestamp,'x-nen-signature':signature},body:raw});expect(response.status).toBe(202);
 const insert=d.raw.prepare("INSERT INTO ec_behavior_events(id,account_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key) VALUES(?,'a','restock','p','{}',?,?,?)");
 d.raw.transaction(()=>{for(let i=0;i<600;i++)insert.run('rate-'+i,new Date().toISOString(),new Date().toISOString(),'rate-'+i);})();
 expect((await app().request('/api/ec/events',{method:'POST',headers:{'x-line-account-id':'a','x-nen-timestamp':timestamp,'x-nen-signature':signature},body:raw})).status).toBe(429);expect(fetch).not.toHaveBeenCalled();
});

test('EC-03/12/13/23: 本人の結び付けから予定を一度だけ作り、編集後も控えを保持',async()=>{
 // 本人の承認判定は既存の解決処理が行うため、ここでは承認済みの結び付きを fixture に使う。
 d.raw.exec("INSERT INTO ec_identity_links(id,tenant_id,candidate_id,source_key,shop_key,external_customer_id,line_account_id,friend_id,linked_at) VALUES('link','t','approved-candidate','ec_cube','example.test','customer','a','f','2026-10-16')");
 await enable();const event={eventId:'matched',customerId:'customer',productId:'p',type:'cart_add',occurredAt:'2026-10-16T01:00:00Z',trackingConsent:true};
 await ingestBehavior(d.db,'a',event,at);await ingestBehavior(d.db,'a',event,at);expect(d.raw.prepare('SELECT count(*) n FROM ec_auto_line_sends').get()).toEqual({n:1});
 expect((await gapCall(app(),'/api/ec/auto-line/rules/cart?account_id=a','PUT',{...rule,messages:[{type:'text',text:'変更後'}],expectedVersion:2})).status).toBe(200);
 expect(d.raw.prepare('SELECT messages_snapshot_json FROM ec_auto_line_sends').get()).toEqual({messages_snapshot_json:JSON.stringify(rule.messages)});
 await processAutoLineMock(d.db,at);expect(states()).toEqual([{status:'simulated'}]);expect(fetch).not.toHaveBeenCalled();
});

test('EC-03/06/20/28: 店内の予定だけを模擬実行・実績0・再実行と閲覧と代理を守る',async()=>{
 vi.useFakeTimers();vi.setSystemTime(at);await enable();scheduled();
 d.raw.exec("INSERT INTO ec_behavior_events(id,account_id,friend_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key) VALUES('other','b','other-f','cart_add','p','{}','2026-10-16T01:00:00Z','now','other'); INSERT INTO ec_auto_line_sends(id,account_id,rule_kind,friend_id,product_id,trigger_event_id,scheduled_at,original_due_at,messages_snapshot_json) VALUES('other-send','b','cart','other-f','p','other','2026-10-16T02:00:00Z','2026-10-16T02:00:00Z','[]')");
 const url='/api/ec/auto-line/simulate?account_id=a';
 for(const [staff,im]of [[{...gapOwner,readOnly:true},false],[gapOwner,true]]as const)expect((await gapCall(app(staff,im),url,'POST',{testMode:true})).status).toBe(403);
 expect((await gapCall(app(),url,'POST',{testMode:false})).status).toBe(400);
 const result=(await (await gapCall(app(),url,'POST',{testMode:true})).json() as any).data;expect(result).toEqual({processed:1,sent:false,testMode:true});
 expect((await (await gapCall(app(),url,'POST',{testMode:true})).json() as any).data.processed).toBe(0);
 expect(d.raw.prepare("SELECT status FROM ec_auto_line_sends WHERE account_id='b'").get()).toEqual({status:'scheduled'});
 expect((await (await gapCall(app(),'/api/ec/auto-line/stats?account_id=a')).json() as any).data).toMatchObject({sent:0,simulated:1,clicks:null,purchases:null});
});

test('EC-03: 購入が事前確認の直後に増えても、最後のUPDATEで模擬配信を止める',async()=>{
 await enable();scheduled();let injected=false;const original=d.db.prepare.bind(d.db);
 const racing={...d.db,prepare(sql:string){
  if(!injected&&sql.startsWith('UPDATE ec_auto_line_sends SET status=?')){
   injected=true;d.raw.exec("INSERT INTO ec_behavior_events(id,account_id,friend_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key) VALUES('last-buy','a','f','purchase','p','{}','2026-10-16T02:59:59Z','now','last-buy')");
  }
  return original(sql);
 }} as D1Database;
 await processAutoLineMock(racing,at);expect(injected).toBe(true);expect(states()).toEqual([{status:'skipped_purchased'}]);
 expect(d.raw.prepare('SELECT count(*) n FROM ec_auto_line_cap_reservations').get()).toEqual({n:0});
});

test('EC-11: 在庫が事前確認の直後に0へ戻っても最後のUPDATEで止める',async()=>{
 await enable('restock');scheduled('r','p','restock');d.raw.exec("INSERT INTO ec_behavior_events(id,account_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key) VALUES('stock','a','restock','p','{\"stock\":5}','2026-10-16T02:55:00Z','now','stock')");
 let injected=false;const original=d.db.prepare.bind(d.db);
 const racing={...d.db,prepare(sql:string){if(!injected&&sql.startsWith('UPDATE ec_auto_line_sends SET status=?')){injected=true;d.raw.exec("INSERT INTO ec_behavior_events(id,account_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key) VALUES('stock0','a','restock','p','{\"stock\":0}','2026-10-16T02:59:59Z','now','stock0')");}return original(sql);}} as D1Database;
 await processAutoLineMock(racing,at);expect(injected).toBe(true);expect(states()).toEqual([{status:'skipped_stock'}]);
});
test('閲覧後のカート投入が事前確認直後に届いても最後のUPDATEで止める',async()=>{
 await enable('browse');scheduled('view','p','browse');let injected=false;const original=d.db.prepare.bind(d.db);
 const racing={...d.db,prepare(sql:string){if(!injected&&sql.startsWith('UPDATE ec_auto_line_sends SET status=?')){injected=true;d.raw.exec("INSERT INTO ec_behavior_events(id,account_id,friend_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key) VALUES('cart-last','a','f','cart_add','p','{}','2026-10-16T02:59:59Z','now','cart-last')");}return original(sql);}} as D1Database;
 await processAutoLineMock(racing,at);expect(injected).toBe(true);expect(states()).toEqual([{status:'skipped_cart'}]);expect(fetch).not.toHaveBeenCalled();
});
test('後の候補を確保する直前に先の候補が現れたら、先の候補を優先する',async()=>{
 await enable('browse');await enable('cart');scheduled('later','later-product','browse','2026-10-16T02:00:00Z');
 let injected=false;const original=d.db.prepare.bind(d.db);
 const racing={...d.db,prepare(sql:string){if(!injected&&sql.startsWith('UPDATE ec_auto_line_sends SET status=?')){injected=true;scheduled('earlier','earlier-product','cart','2026-10-16T01:30:00Z');}return original(sql);}} as D1Database;
 expect(await processAutoLineMock(racing,at)).toEqual({processed:0});
 expect(d.raw.prepare("SELECT status FROM ec_auto_line_sends WHERE id='send-later'").get()).toEqual({status:'scheduled'});
 await processAutoLineMock(d.db,at);
 expect(d.raw.prepare('SELECT id,status FROM ec_auto_line_sends ORDER BY id').all()).toEqual([{id:'send-earlier',status:'simulated'},{id:'send-later',status:'scheduled'}]);
});

test('本人や商品同一性の根拠が欠ければ模擬処理も保留し、根拠が揃えば枠と結果を同時に記録する',async()=>{
 await enable();scheduled();
 d.raw.exec("UPDATE friend_identity_links SET unlinked_at='2026-10-15' WHERE id='cap-link'");
 expect(await processAutoLineMock(d.db,at)).toEqual({processed:0});
 expect(states()).toEqual([{status:'scheduled'}]);
 d.raw.exec("UPDATE friend_identity_links SET unlinked_at=NULL WHERE id='cap-link'; UPDATE ec_auto_line_product_identities SET revoked_at='2026-10-15' WHERE account_id='a'");
 expect(await processAutoLineMock(d.db,at)).toEqual({processed:0});
 d.raw.exec("UPDATE ec_auto_line_product_identities SET revoked_at=NULL WHERE account_id='a'");
 expect(await processAutoLineMock(d.db,at)).toEqual({processed:1});
 expect(states()).toEqual([{status:'simulated'}]);
 expect(d.raw.prepare('SELECT candidate_id,mode,state FROM ec_auto_line_cap_reservations').all()).toEqual([{candidate_id:'send-e',mode:'simulation',state:'accepted'}]);
 expect(fetch).not.toHaveBeenCalled();
});
