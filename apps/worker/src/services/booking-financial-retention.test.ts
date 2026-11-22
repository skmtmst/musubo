import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { processBookingFinancialRetention } from './booking-financial-retention.js';
let db:ReturnType<typeof createTestD1>;
const now=new Date('2026-11-22T00:00:00Z');
beforeEach(()=>{db=createTestD1();db.raw.exec("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('a','a','fixture','x','x')");});
afterEach(()=>db.raw.close());
function payment(id:string,created='2010-01-01T00:00:00Z'){
 db.raw.prepare("INSERT INTO booking_payments(id,line_account_id,amount,status,provider,idempotency_key,created_at,updated_at) VALUES(?,'a',1000,'paid','stripe',?,?,?)").run(id,id,created,created);
}
it('期限を過ぎた決済と返金を一括削除し、番号を監査に残さない',async()=>{
 payment('old');
 db.raw.exec("INSERT INTO booking_payment_refunds(id,payment_id,line_account_id,idempotency_key,amount,reason,actor_id,actor_label,notification_status,created_at) VALUES('refund','old','a','key',100,'reason','actor','staff','not_requested','2011-01-01T00:00:00Z')");
 expect(await processBookingFinancialRetention(db.db,now)).toEqual({deleted:1,failed:0});
 expect(db.raw.prepare('SELECT count(*) n FROM booking_payments').get()).toEqual({n:0});
 expect(db.raw.prepare('SELECT count(*) n FROM booking_payment_refunds').get()).toEqual({n:0});
 const audit=JSON.stringify(db.raw.prepare("SELECT after_json FROM audit_events WHERE action='privacy.booking_financial.expired'").get());
 expect(audit).not.toContain('old');expect(audit).not.toContain('refund');
});
it('後の返金が期限前なら決済も保管し、12年弱の取引は保管する',async()=>{
 payment('new-refund');payment('boundary','2015-10-01T00:00:00Z');
 db.raw.exec("INSERT INTO booking_payment_refunds(id,payment_id,line_account_id,idempotency_key,amount,reason,actor_id,actor_label,notification_status,created_at) VALUES('recent','new-refund','a','key',100,'reason','actor','staff','not_requested','2025-01-01T00:00:00Z')");
 expect(await processBookingFinancialRetention(db.db,now)).toEqual({deleted:0,failed:0});
 expect(db.raw.prepare('SELECT count(*) n FROM booking_payments').get()).toEqual({n:2});
});
it('保持停止なら削除せず、監査書き込み失敗時は一括で戻す',async()=>{
 payment('old');
 db.raw.exec("INSERT INTO account_settings(line_account_id,key,value) VALUES('a','security.personalDataRetention.v1','{\"enabled\":false,\"hold\":true,\"responseDays\":365,\"blockedFriendDays\":365}')");
 expect((await processBookingFinancialRetention(db.db,now)).deleted).toBe(0);
 db.raw.exec("DELETE FROM account_settings; CREATE TRIGGER audit_fail BEFORE INSERT ON audit_events WHEN NEW.action='privacy.booking_financial.expired' BEGIN SELECT RAISE(ABORT,'failure'); END;");
 expect(await processBookingFinancialRetention(db.db,now)).toEqual({deleted:0,failed:1});
 expect(db.raw.prepare('SELECT count(*) n FROM booking_payments').get()).toEqual({n:1});
});
it('期限を過ぎた手数料と取消記録を一括削除する',async()=>{
 db.raw.exec("INSERT INTO booking_charges(id,booking_id,line_account_id,kind,amount,policy_snapshot_json,status,created_at,updated_at) VALUES('charge','deleted-booking','a','cancellation_fee',100,'{}','waived','2010-01-01','2010-01-01'); INSERT INTO booking_cancellation_events(id,charge_id,action,created_at) VALUES('c-event','charge','waive','2010-01-02')");
 expect(await processBookingFinancialRetention(db.db,now)).toEqual({deleted:1,failed:0});
 expect(db.raw.prepare('SELECT count(*) n FROM booking_charges').get()).toEqual({n:0});
 expect(db.raw.prepare('SELECT count(*) n FROM booking_cancellation_events').get()).toEqual({n:0});
});
it('日本時間の早朝の期限は月末をまたいでも早く消さない',async()=>{
 payment('edge','2026-03-01T00:30:00+09:00');
 expect((await processBookingFinancialRetention(db.db,new Date('2037-06-01T15:29:59Z'))).deleted).toBe(0);
 expect((await processBookingFinancialRetention(db.db,new Date('2037-06-01T15:30:00Z'))).deleted).toBe(1);
});
it('日付だけの値は日本時間として扱う',async()=>{
 payment('day','2026-03-01');
 expect((await processBookingFinancialRetention(db.db,new Date('2037-06-01T14:59:59Z'))).deleted).toBe(0);
 expect((await processBookingFinancialRetention(db.db,new Date('2037-06-01T15:00:00Z'))).deleted).toBe(1);
});
it('古い孤立通知と再処理、Stripe 記録を番号ごと消す',async()=>{
 db.raw.exec("INSERT INTO booking_payment_events(id,line_account_id,provider,provider_event_id,provider_payment_id,kind,outcome,received_at,result) VALUES('evt','a','stripe','stripe-id','pi-id','paid','paid','2010-01-01T00:00:00Z','applied'); INSERT INTO booking_payment_event_replays(id,event_id,actor_id,occurred_at,source_version,result) VALUES('replay','evt','staff','2010-01-01T00:00:00Z',1,'applied'); INSERT INTO stripe_events(id,stripe_event_id,event_type,processed_at) VALUES('stripe-row','stripe-old','paid','2010-01-01T00:00:00Z')");
 expect(await processBookingFinancialRetention(db.db,now)).toEqual({deleted:2,failed:0});
 for(const table of ['booking_payment_events','booking_payment_event_replays','stripe_events'])expect(db.raw.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({n:0});
});
it('店の保持停止中は所属不明の Stripe 記録も消さない',async()=>{
 db.raw.exec("INSERT INTO account_settings(line_account_id,key,value) VALUES('a','security.personalDataRetention.v1','{\"enabled\":false,\"hold\":true,\"responseDays\":365,\"blockedFriendDays\":365}'); INSERT INTO stripe_events(id,stripe_event_id,event_type,processed_at) VALUES('stripe-row','stripe-old','paid','2010-01-01T00:00:00Z')");
 expect((await processBookingFinancialRetention(db.db,now)).deleted).toBe(0);
 expect(db.raw.prepare('SELECT count(*) n FROM stripe_events').get()).toEqual({n:1});
});
it('対象外の古い決済が21件あっても別の店の対象を処理する',async()=>{
 db.raw.exec("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('b','b','other','x','x'); INSERT INTO account_settings(line_account_id,key,value) VALUES('a','security.personalDataRetention.v1','{\"enabled\":false,\"hold\":true,\"responseDays\":365,\"blockedFriendDays\":365}')");
 for(let i=0;i<21;i++)payment(`held-${i}`);
 db.raw.exec("INSERT INTO booking_payments(id,line_account_id,amount,status,provider,idempotency_key,created_at,updated_at) VALUES('eligible','b',1000,'paid','stripe','eligible','2010-01-01','2010-01-01')");
 expect(await processBookingFinancialRetention(db.db,now)).toEqual({deleted:1,failed:0});
 expect(db.raw.prepare("SELECT count(*) n FROM booking_payments WHERE line_account_id='a'").get()).toEqual({n:21});
 expect(db.raw.prepare("SELECT count(*) n FROM booking_payments WHERE line_account_id='b'").get()).toEqual({n:0});
});
it('消去直前に保持停止されたら決済と子の記録を残す',async()=>{
 payment('old');
 const wrapped=new Proxy(db.db,{get(target,prop,receiver){if(prop==='batch')return async (statements:D1PreparedStatement[])=>{
   db.raw.prepare('INSERT OR IGNORE INTO account_settings(line_account_id,key,value) VALUES(?,?,?)').run('a','security.personalDataRetention.v1',JSON.stringify({enabled:false,hold:true,responseDays:365,blockedFriendDays:365}));
   return target.batch(statements);
  };return Reflect.get(target,prop,receiver);}});
 expect((await processBookingFinancialRetention(wrapped,now)).deleted).toBe(0);
 expect(db.raw.prepare('SELECT count(*) n FROM booking_payments').get()).toEqual({n:1});
});
it('終わった決済工程は番号とともに削除し、別の決済の工程は残す',async()=>{
 payment('old');
 db.raw.exec("INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,created_at,updated_at) VALUES('line:a','booking_late_payment','old','__run','succeeded','x',1262304000000,1262304000000),('line:a','booking_late_payment','another','__run','pending','y',1262304000000,1262304000000)");
 expect((await processBookingFinancialRetention(db.db,now)).deleted).toBe(1);
 expect(db.raw.prepare('SELECT subject_id FROM workflow_steps').all()).toEqual([{subject_id:'another'}]);
});
it('未終了の決済工程は束を保護する',async()=>{
 payment('old');
 db.raw.exec("INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,created_at,updated_at) VALUES('line:a','booking_late_payment','old','__run','failed','x',1262304000000,1262304000000)");
 expect((await processBookingFinancialRetention(db.db,now)).deleted).toBe(0);
 expect(db.raw.prepare('SELECT count(*) n FROM booking_payments').get()).toEqual({n:1});
});
it('削除済み予約の履歴 ID に結び付く完了工程を消す',async()=>{
 payment('old');db.raw.exec("UPDATE booking_payments SET booking_id_history='deleted-booking' WHERE id='old'; INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,created_at,updated_at) VALUES('line:a','booking_payment_start','deleted-booking','__run','succeeded','x',1262304000000,1262304000000)");
 expect((await processBookingFinancialRetention(db.db,now)).deleted).toBe(1);
 expect(db.raw.prepare('SELECT count(*) n FROM workflow_steps').get()).toEqual({n:0});
});
it('終わった工程でも更新が新しければ束を残す',async()=>{
 payment('old');db.raw.exec("INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,created_at,updated_at) VALUES('line:a','booking_late_payment','old','__run','succeeded','x',1262304000000,1760000000000)");
 expect((await processBookingFinancialRetention(db.db,now)).deleted).toBe(0);
});
it('同じ予約の別の決済があれば予約の工程を残す',async()=>{
 payment('old');payment('new','2025-01-01T00:00:00Z');
 db.raw.exec("UPDATE booking_payments SET booking_id_history='same-booking'; INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,created_at,updated_at) VALUES('line:a','booking_payment_start','same-booking','__run','succeeded','x',1262304000000,1262304000000)");
 expect((await processBookingFinancialRetention(db.db,now)).deleted).toBe(1);
 expect(db.raw.prepare('SELECT subject_id FROM workflow_steps').all()).toEqual([{subject_id:'same-booking'}]);
});
