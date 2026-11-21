import {beforeEach,afterEach,expect,test} from 'vitest';
import {gapFixture,seedGapBooking} from '../test-utils/gap1.js';
import type {SqliteD1} from '../test-utils/d1-sqlite.js';
import {purgeTablesChildFirst,tenantScopeCondition} from '@line-crm/db';
import {deleteCustomerData} from '../services/customer-data-deletion.js';
let d:SqliteD1;
beforeEach(()=>{
 d=gapFixture();seedGapBooking(d);d.raw.exec(`
 INSERT INTO line_senders(id,account_id,name,visibility,created_by,updated_at,idempotency_key,request_json) VALUES('sender','a','担当','all','o',datetime('now'),'s','{}');
 INSERT INTO booking_payment_methods(id,friend_id,line_account_id,setup_id,idempotency_key,created_at) VALUES('pm','f','a','seti_test','key',datetime('now'));
 INSERT INTO booking_card_checkout_requests(id,line_account_id,friend_id,idempotency_key,booking_json,connect_account,created_at) VALUES('pm','a','f','key','{}','acct_test',datetime('now'));
 INSERT INTO booking_charges(id,booking_id,line_account_id,kind,amount,policy_snapshot_json,status,created_at,updated_at) VALUES('charge','bk','a','cancellation_fee',4200,'{}','succeeded',datetime('now'),datetime('now'));
 INSERT INTO booking_cancellation_events(id,charge_id,actor_id,action,created_at) VALUES('event','charge','o','charge_test',datetime('now'));
 INSERT INTO booking_calendar_switch_audit(id,line_account_id,scope_id,actor_id,before_json,after_json,created_at) VALUES('audit','a','','o','{}','{}',datetime('now'));
 INSERT INTO booking_calendar_switch_jobs(id,line_account_id,staff_id,booking_id,action,switch_scope,switch_version,created_at) VALUES('job','a','bs','bk','write','bs',1,datetime('now'));
 `);d.raw.pragma('foreign_keys=ON');
});
afterEach(()=>d.raw.close());
test('B1-14 B7-45: 店のデータ削除でも請求と監査を残し、カード参照と順番待ちは消す',()=>{
 d.raw.transaction(()=>{d.raw.pragma('defer_foreign_keys=ON');for(const table of purgeTablesChildFirst())d.raw.prepare(`DELETE FROM ${table} WHERE ${tenantScopeCondition(table)}`).run('t');})();
 expect(d.raw.prepare('SELECT amount FROM booking_charges').get()).toEqual({amount:4200});
 expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_cancellation_events').get()).toEqual({n:1});expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_calendar_switch_audit').get()).toEqual({n:1});
 expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_card_checkout_requests').get()).toEqual({n:0});expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_payment_methods').get()).toEqual({n:0});expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_calendar_switch_jobs').get()).toEqual({n:0});expect(d.raw.prepare('SELECT COUNT(*) n FROM line_senders').get()).toEqual({n:0});
 expect(d.raw.prepare("SELECT id FROM line_accounts WHERE id='b'").get()).toEqual({id:'b'});expect(d.raw.pragma('foreign_key_check')).toEqual([]);
});
test('B1-08: 本人データの削除でカードの試験用参照を消し、請求履歴と別人は残す',async()=>{
 await deleteCustomerData({DB:d.db},{kind:'friend_data',id:'f',accountId:'a',friendId:'f',lineUserId:'Uf'},'o');
 expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_card_checkout_requests').get()).toEqual({n:0});expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_payment_methods').get()).toEqual({n:0});expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_calendar_switch_jobs').get()).toEqual({n:0});expect(d.raw.prepare('SELECT amount FROM booking_charges').get()).toEqual({amount:4200});expect(d.raw.prepare("SELECT id FROM friends WHERE id='f2'").get()).toEqual({id:'f2'});expect(d.raw.pragma('foreign_key_check')).toEqual([]);
});
