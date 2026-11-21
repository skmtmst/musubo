import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {gapFixture,gapApp,gapCall,gapOwner} from '../test-utils/gap1.js';
import {ecAutoLine} from './ec-auto-line.js';
import {createBroadcastRetryKey} from '../features/broadcasts/broadcast-retry-key/index.js';
import {processLiveAutoLine} from '../features/ec-commerce/ec-auto-line-live.js';
let f:ReturnType<typeof gapFixture>;
const path='/api/ec/auto-line/live/unknown';
const app=(staff=gapOwner)=>gapApp(f,[ecAutoLine],staff);
beforeEach(async()=>{
 f=gapFixture();vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('external forbidden');}));
 f.raw.exec(`INSERT INTO ec_auto_line_live_intents(id,account_id,kind,occurrence_key,friend_id,product_id,due_at,payload_json,state,created_at,updated_at) VALUES('u','a','cart','event','f','p','2026-01-01','[]','unknown','2026-01-01','v1'),('s','a','browse','event2','f','p','2026-01-01','[]','scheduled','2026-01-01','v1');`);
 f.raw.exec("INSERT INTO users(id,tenant_id) VALUES('u1','t'); INSERT INTO ec_auto_line_cap_reservations(id,tenant_id,user_id,account_id,friend_id,live_intent_id,mode,canonical_product_id,source_product_id,day_jst,reserved_at,state) VALUES('cap','t','u1','a','f','u','live','p','p','2026-01-01','now','unknown')");
 const key=await createBroadcastRetryKey('notification','ec-live:u','line','f');
 f.raw.prepare("INSERT INTO outbound_send_requests(idempotency_key,channel,resource_id,payload_hash,line_account_id,status,failure_code,last_failed_at,created_at,updated_at) VALUES(?,'line','ec-live:u','hash','a','unknown','TIMEOUT','now','now','now')").run(key);
});
afterEach(()=>{f.raw.close();vi.unstubAllGlobals();});
it('管理者だけが結果不明と台帳を閲覧できる',async()=>{
 for(const staff of [{...gapOwner,role:'staff' as const},{...gapOwner,readOnly:true}])expect((await gapCall(app(staff),path+'?account_id=a')).status).toBe(403);
 const res=await gapCall(app(),path+'?account_id=a');expect(res.status).toBe(200);
 const data=await res.json() as any;expect(data.data.items).toHaveLength(1);expect(data.data.items[0]).toMatchObject({id:'u',kind:'cart',friendId:'f',version:'v1',ledger:{status:'unknown',failureCode:'TIMEOUT'}});
});
it.each([['sent','sent'],['not_sent','failed']])('確認 %s は監査し再送しない',async(resolution,state)=>{
 const url=path+'/u/resolve?account_id=a',body={resolution,reason:'台帳と照合',expectedVersion:'v1'};
 for(const staff of [{...gapOwner,role:'staff' as const},{...gapOwner,readOnly:true}])expect((await gapCall(app(staff),url,'POST',body)).status).toBe(403);
 expect((await gapCall(app(),url,'POST',{...body,reason:' '})).status).toBe(400);
 expect((await gapCall(app(),url,'POST',{...body,expectedVersion:'old'})).status).toBe(409);
 expect((await gapCall(app(),url,'POST',body)).status).toBe(200);
 expect(f.raw.prepare("SELECT state FROM ec_auto_line_live_intents WHERE id='u'").get()).toEqual({state});
 expect(f.raw.prepare("SELECT state FROM ec_auto_line_cap_reservations WHERE id='cap'").get()).toEqual({state:resolution==='sent'?'accepted':'released'});
 expect(f.raw.prepare("SELECT action,actor_id,detail_json FROM operation_audit WHERE target_id='u'").get()).toMatchObject({action:'unknown_resolved',actor_id:gapOwner.id,detail_json:expect.stringContaining('台帳と照合')});
 expect((await gapCall(app(),url,'POST',body)).status).toBe(409);
 const send=vi.fn();await processLiveAutoLine(f.db,new Date('2026-11-01'),send);expect(send).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it('台帳が受理済みか処理中なら未送信として解除しない',async()=>{
 const url=path+'/u/resolve?account_id=a',body={resolution:'not_sent',reason:'照合',expectedVersion:'v1'};
 f.raw.exec("UPDATE outbound_send_requests SET failure_code='NOTIFICATION_DELIVERY_UNKNOWN' WHERE resource_id='ec-live:u'");
 const refused=await gapCall(app(),url,'POST',body);expect(refused.status).toBe(409);expect(await refused.json()).toMatchObject({error:'ledger_indicates_sent_or_pending'});
 f.raw.exec("UPDATE outbound_send_requests SET status='in_progress' WHERE resource_id='ec-live:u'");
 expect((await gapCall(app(),url,'POST',body)).status).toBe(409);
 f.raw.exec("UPDATE outbound_send_requests SET status='succeeded',response_id='accepted',completed_at='now' WHERE resource_id='ec-live:u'");
 expect((await gapCall(app(),url,'POST',body)).status).toBe(409);
 expect(f.raw.prepare("SELECT state FROM ec_auto_line_live_intents WHERE id='u'").get()).toEqual({state:'unknown'});
 expect(f.raw.prepare("SELECT count(*) n FROM operation_audit WHERE target_id='u'").get()).toEqual({n:0});
});
it('確認直後に台帳が受理済みに変わっても解除しない',async()=>{
 const db={...f.db,batch:async (statements:D1PreparedStatement[])=>{
  f.raw.exec("UPDATE outbound_send_requests SET status='succeeded',response_id='accepted',completed_at='now' WHERE resource_id='ec-live:u'");
  return f.db.batch(statements);
 }} as D1Database;
 const racing=gapApp(f,[ecAutoLine],gapOwner,false,{DB:db});
 const res=await gapCall(racing,path+'/u/resolve?account_id=a','POST',{resolution:'not_sent',reason:'照合',expectedVersion:'v1'});
 expect(res.status).toBe(409);expect(f.raw.prepare("SELECT state FROM ec_auto_line_live_intents WHERE id='u'").get()).toEqual({state:'unknown'});
 expect(f.raw.prepare("SELECT state FROM ec_auto_line_cap_reservations WHERE id='cap'").get()).toEqual({state:'unknown'});
});
it('代理と不正なページ、他店の予定を拒否する',async()=>{
 expect((await gapCall(gapApp(f,[ecAutoLine],gapOwner,true),path+'?account_id=a')).status).toBe(403);
 for(const offset of ['-1','abc'])expect((await gapCall(app(),path+'?account_id=a&offset='+offset)).status).toBe(400);
 expect((await gapCall(app(),path+'/missing/resolve?account_id=a','POST',{resolution:'sent',reason:'照合',expectedVersion:'v1'})).status).toBe(404);
});
