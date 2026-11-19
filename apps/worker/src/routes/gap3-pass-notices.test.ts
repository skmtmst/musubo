import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {gapFixture,gapApp,gapCall,gapOwner,seedGapBooking} from '../test-utils/gap1.js';
import {useSqliteClock} from '../test-utils/sqlite-clock.js';
import {bookingPassNotices} from './booking-pass-notices.js';
import {processPassNotices} from '../features/booking/booking-pass-notices.js';
import {entitlementUseStatement} from '../features/booking/booking-entitlements.js';
import {readFileSync} from 'node:fs';
import {processLivePassNotices,processStagingPassNotices} from '../features/booking/booking-pass-live-notices.js';
import type {Env} from '../worker-env.js';
let d:ReturnType<typeof gapFixture>;
let now:Date;
beforeEach(()=>{
 now=new Date('2026-10-16T01:00:00Z');d=gapFixture();useSqliteClock(d.raw,()=>now);vi.useFakeTimers();vi.setSystemTime(now);
 vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('external_forbidden');}));
 d.raw.exec(`INSERT INTO booking_pass_plans(id,line_account_id,kind,name,price,count,valid_days,status,created_by,created_at,idempotency_key,request_json) VALUES('p','a','ticket','ヨガ5回券',5000,5,180,'on_sale','o','2026-10-01','plan','{}');
 INSERT INTO booking_entitlements(id,line_account_id,friend_id,kind,name,remaining,valid_from,expires_at,created_at,updated_at,plan_id)
 VALUES('e','a','f','ticket','ヨガ5回券',2,'2026-10-01T00:00:00Z','2026-10-30T09:00:00Z','2026-10-01','2026-10-01','p');`);
});
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();d.raw.close();vi.useRealTimers();vi.unstubAllGlobals();});
const base='/api/booking/admin/pass-plans/p/notice-settings?account_id=a';
const app=(s=gapOwner,im=false)=>gapApp(d,[bookingPassNotices],s,im);
async function enable(remainingOne=true,expiry14Days=true){const r=await gapCall(app(),base,'PUT',{remainingOne,expiry14Days,expectedVersion:1,testMode:true});expect(r.status,await r.clone().text()).toBe(200);}
async function consume(id='bk'){
 seedGapBooking(d,id,'requested','2026-10-20T01:00:00Z');await entitlementUseStatement(d.db,id,'e','2026-10-20T01:00:00Z','Asia/Tokyo').run();
 d.raw.prepare("UPDATE bookings SET status='confirmed' WHERE id=?").run(id);
}
const notices=()=>d.raw.prepare('SELECT kind,status,scheduled_at,purpose,test_mode FROM booking_entitlement_notices ORDER BY kind').all();
test('B2-18/19-DEFAULT: 初期オフ、オンには版と模擬を要求、閲覧のみ/代理/担当外は変更不可',async()=>{
 const r=await gapCall(app(),base);expect((await r.json() as any).data).toMatchObject({remainingOne:false,expiry14Days:false,version:1,deliveryAvailable:false,testMode:true});
 await consume();await processPassNotices(d.db,now,'a');expect(notices()).toEqual([]);
 for(const [staff,im]of [[{...gapOwner,readOnly:true},false],[gapOwner,true],[{...gapOwner,role:'staff' as const,permissionKeys:['/booking/bookings'] as string[]},false]]as const){
  expect((await gapCall(app(staff,im),base)).status).toBe(200);
  expect((await gapCall(app(staff,im),base,'PUT',{remainingOne:true,expiry14Days:true,expectedVersion:1,testMode:true})).status).toBe(403);
  expect((await gapCall(app(staff,im),'/api/booking/admin/pass-notices/simulate?account_id=a','POST',{testMode:true})).status).toBe(403);
 }
 expect((await gapCall(app(),base.replace('account_id=a','account_id=b'))).status).toBe(404);
 expect((await gapCall(app(),base,'PUT',{remainingOne:true,expiry14Days:true,expectedVersion:1})).status).toBe(400);
 await enable();expect((await gapCall(app(),base,'PUT',{remainingOne:false,expiry14Days:false,expectedVersion:1,testMode:true})).status).toBe(409);
 // 有効化より前に起きた残り1回のイベントを、さかのぼって作らない。
 expect(notices()).toEqual([]);
});
test('検証のテスト宛先だけ本送信し、送信直前に宛先変更があれば止める',async()=>{
 d.raw.exec(readFileSync(new URL('../../../../packages/db/migrations/772_monthly_failure_notices.sql',import.meta.url),'utf8'));
 d.raw.exec(readFileSync(new URL('../../../../packages/db/migrations/773_monthly_notice_cap.sql',import.meta.url),'utf8'));
 await enable(true,false);await consume();
 const send=vi.fn(async()=>{});
 expect(await processStagingPassNotices({DB:d.db,DEPLOY_ENV:'staging'} as Env['Bindings'],now)).toEqual({processed:0});
 d.raw.exec(`INSERT INTO account_settings(line_account_id,key,value) VALUES('a','test_recipients','["f"]')`);
 await processPassNotices(d.db,now,'a',true);expect(notices()).toMatchObject([{status:'scheduled'}]);
 const changed=()=>{d.raw.exec("UPDATE account_settings SET value='[]' WHERE line_account_id='a' AND key='test_recipients'");return now;};
 expect(await processLivePassNotices(d.db,now,send,changed)).toEqual({processed:0});expect(send).not.toHaveBeenCalled();
 d.raw.exec(`UPDATE account_settings SET value='["f"]' WHERE line_account_id='a' AND key='test_recipients'`);
 expect(await processLivePassNotices(d.db,now,send,()=>now)).toEqual({processed:1});
 expect(send).toHaveBeenCalledOnce();expect(await processLivePassNotices(d.db,now,send,()=>now)).toEqual({processed:0});
 const result=await (await gapCall(app(),'/api/booking/admin/pass-notices?account_id=a&planId=p&limit=10')).json() as any;
 expect(result.data.items[0].status).toBe('sent');
});
test('期限14日前の通知も検証先に送り、設定停止・同意撤回・夜間は送らない',async()=>{
 d.raw.exec(readFileSync(new URL('../../../../packages/db/migrations/772_monthly_failure_notices.sql',import.meta.url),'utf8'));
 d.raw.exec(readFileSync(new URL('../../../../packages/db/migrations/773_monthly_notice_cap.sql',import.meta.url),'utf8'));
 await enable(false,true);
 d.raw.exec(`INSERT INTO account_settings(line_account_id,key,value) VALUES('a','test_recipients','["f"]')`);
 await processPassNotices(d.db,now,'a',true);expect(notices()).toMatchObject([{kind:'expiry_14_days',status:'scheduled'}]);
 const send=vi.fn(async()=>{});
 d.raw.exec("INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('a','f','transaction','revoked','test','manual')");
 expect(await processLivePassNotices(d.db,now,send,()=>now)).toEqual({processed:0});
 d.raw.exec("DELETE FROM friend_delivery_consents WHERE friend_id='f'; UPDATE booking_pass_plans SET notify_expiry_14_days=0 WHERE id='p'");
 expect(await processLivePassNotices(d.db,now,send,()=>now)).toEqual({processed:0});
 d.raw.exec("UPDATE booking_pass_plans SET notify_expiry_14_days=1 WHERE id='p'");
 expect(await processLivePassNotices(d.db,new Date('2026-10-16T13:00:00Z'),send,()=>now)).toEqual({processed:0});
 expect(await processLivePassNotices(d.db,now,send,()=>now)).toEqual({processed:1});
 expect(send).toHaveBeenCalledWith(expect.objectContaining({messages:[expect.objectContaining({text:expect.stringContaining('あと14日')})]}));
});
test('B2-18: 申込では知らせ0、確定の減算と同時に1件、取消/再利用でも二重にしない',async()=>{
 await enable(true,false);
 seedGapBooking(d,'bk','requested','2026-10-20T01:00:00Z');await entitlementUseStatement(d.db,'bk','e','2026-10-20T01:00:00Z','Asia/Tokyo').run();expect(notices()).toEqual([]);
 d.raw.exec("UPDATE bookings SET status='confirmed' WHERE id='bk'");expect(notices()).toHaveLength(1);
 await Promise.all([processPassNotices(d.db,now,'a'),processPassNotices(d.db,now,'a')]);expect(notices()).toMatchObject([{kind:'remaining_one',status:'simulated',purpose:'transaction',test_mode:1}]);
 d.raw.exec("UPDATE bookings SET status='cancelled',cancelled_at='2026-10-16T01:00:00Z' WHERE id='bk'");await consume('bk2');await processPassNotices(d.db,now,'a');expect(notices()).toHaveLength(1);
 const r=await gapCall(app(),'/api/booking/admin/pass-notices?account_id=a&planId=p&limit=10');expect((await r.json() as any).data).toMatchObject({total:1,sent:false,testMode:true,items:[{messages:[{type:'text',text:expect.stringContaining('残りは1回')}]}]});
 expect(d.raw.prepare('SELECT count(*) n FROM messages_log').get()).toEqual({n:0});
});
test('B2-18-ATOMIC: 通知の記録に失敗したら確定・残り・消費履歴も全部戻す',async()=>{
 await enable(true,false);d.raw.exec("CREATE TRIGGER fail_notice BEFORE INSERT ON booking_entitlement_notices BEGIN SELECT RAISE(ABORT,'notice_failed'); END;");
 await expect(consume()).rejects.toThrow('notice_failed');
 expect(d.raw.prepare("SELECT status FROM bookings WHERE id='bk'").get()).toEqual({status:'requested'});
 expect(d.raw.prepare("SELECT remaining FROM booking_entitlements WHERE id='e'").get()).toEqual({remaining:2});
 expect(d.raw.prepare("SELECT consumed_at FROM booking_entitlement_uses WHERE booking_id='bk'").get()).toEqual({consumed_at:null});
 expect(d.raw.prepare("SELECT count(*) n FROM booking_entitlement_events WHERE action='consume'").get()).toEqual({n:0});
});
test('B2-19: 14日前の朝8時に1回だけ、13日前/15日前では予定を作らない',async()=>{
 await enable(false,true);
 for(const at of ['2026-10-15T23:00:00Z','2026-10-16T23:00:00Z'])await processPassNotices(d.db,new Date(at),'a');
 // 店舗の時間帯で10月30日の14日前になる10月16日だけを対象にする。
 expect(notices()).toHaveLength(1);expect(notices()).toMatchObject([{kind:'expiry_14_days',status:'simulated',scheduled_at:'2026-10-15T23:00:00.000Z'}]);
 await processPassNotices(d.db,now,'a');expect(notices()).toHaveLength(1);
});
test('B2-18/19-QUIET: 夜の確定は翌朝、朝7時は処理せず8時に模擬。古い知らせは復活しない',async()=>{
 await enable(true,false);now=new Date('2026-10-16T13:00:00Z');await consume();
 await processPassNotices(d.db,now,'a');expect(notices()).toMatchObject([{status:'scheduled',scheduled_at:'2026-10-16T23:00:00.000Z'}]);
 await processPassNotices(d.db,new Date('2026-10-16T22:00:00Z'),'a');expect(notices()).toMatchObject([{status:'scheduled'}]);
 await processPassNotices(d.db,new Date('2026-10-16T23:00:00Z'),'a');expect(notices()).toMatchObject([{status:'simulated'}]);
 d.raw.exec("UPDATE booking_entitlement_notices SET status='scheduled',scheduled_at='2026-10-15T13:00:00Z'");
 await processPassNotices(d.db,new Date('2026-10-17T00:00:00Z'),'a');expect(notices()).toMatchObject([{status:'skipped_late'}]);
});
test('B2-19-TZ: 店の現地日付で14日前、夏時間のある店でも朝8時',async()=>{
 await enable(false,true);d.raw.exec("UPDATE booking_settings SET timezone='America/New_York';UPDATE booking_entitlements SET expires_at='2026-11-10T15:00:00Z'");
 await processPassNotices(d.db,new Date('2026-10-27T11:00:00Z'),'a');expect(notices()).toMatchObject([{status:'scheduled',scheduled_at:'2026-10-27T12:00:00.000Z'}]);
 await processPassNotices(d.db,new Date('2026-10-27T12:00:00Z'),'a');expect(notices()).toMatchObject([{status:'simulated'}]);
});
test.each(['disabled','revoked','blocked','returned','expired','transaction','marketing'] as const)('B2-18-SAFETY: 直前の%sを確認する',async kind=>{
 await enable(true,false);await consume();
 if(kind==='disabled')d.raw.exec('UPDATE booking_pass_plans SET notify_remaining_one=0');
 if(kind==='revoked')d.raw.exec("UPDATE booking_entitlements SET status='revoked'");
 if(kind==='blocked')d.raw.exec('UPDATE friends SET is_following=0');
 if(kind==='returned')d.raw.exec("UPDATE bookings SET status='cancelled',cancelled_at='2026-10-16T01:00:00Z' WHERE id='bk'");
 if(kind==='expired')d.raw.exec("UPDATE booking_entitlements SET expires_at='2026-10-15T00:00:00Z'");
 if(kind==='transaction'||kind==='marketing')d.raw.prepare("INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('a','f',?,'revoked','本人希望','manual')").run(kind);
 await processPassNotices(d.db,now,'a');
 expect(notices()).toMatchObject([{status:kind==='disabled'?'skipped_disabled':kind==='transaction'?'skipped_opted_out':kind==='marketing'?'simulated':'skipped_unavailable'}]);
});
test('B2-19-EXTEND: 期限変更後は古い予定を使わず、新しい期限で1回だけ',async()=>{
 await enable(false,true);await processPassNotices(d.db,new Date('2026-10-15T22:00:00Z'),'a');
 expect(notices()).toMatchObject([{status:'scheduled'}]);d.raw.exec("UPDATE booking_entitlements SET expires_at='2026-11-13T09:00:00Z'");
 await processPassNotices(d.db,new Date('2026-10-15T23:00:00Z'),'a');expect(notices()).toMatchObject([{status:'skipped_unavailable'}]);
 await processPassNotices(d.db,new Date('2026-10-29T23:00:00Z'),'a');expect(notices()).toHaveLength(2);expect(notices().filter((n:any)=>n.status==='simulated')).toHaveLength(1);
});
test('B2-18-EXPIRY-TEXT: 期限延長後の残数通知は現在の期限を使い、実送信をDBでも拒否する',async()=>{
 await enable(true,false);await consume();d.raw.exec("UPDATE booking_entitlements SET expires_at='2026-11-30T09:00:00Z'");
 await processPassNotices(d.db,now,'a');
 const row=d.raw.prepare('SELECT messages_json FROM booking_entitlement_notices').get() as any;
 expect(JSON.parse(row.messages_json)[0].text).toContain('2026-11-30');
 expect(()=>d.raw.exec('UPDATE booking_entitlement_notices SET test_mode=0')).toThrow('CHECK');
});
