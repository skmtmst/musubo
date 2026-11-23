import { afterEach, expect, test } from 'vitest';
import { monthlyFixture, monthlyContract, monthlyCycle } from '../test-utils/monthly-ledger.js';
import { deleteCustomerData } from '../services/customer-data-deletion.js';
import type { SqliteD1 } from '../test-utils/d1-sqlite.js';

let db:SqliteD1;
afterEach(()=>db.raw.close());
const target={kind:'friend_data' as const,id:'f',friendId:'f',accountId:'a',lineUserId:'Uf'};
function monthlyNotices(friend:string,audience:'friend'|'store',day:string){
 db.raw.prepare("INSERT INTO booking_monthly_failure_notices(cycle_id,audience,account_id,friend_id,created_at) VALUES('cycle',?,'a',?,'2026-11-20')").run(audience,friend);
 db.raw.prepare("INSERT INTO booking_monthly_notice_cap(cycle_id,audience,account_id,friend_id,day_jst,reserved_at) VALUES('cycle',?,'a',?,?,'2026-11-20')").run(audience,friend,day);
}

test('保持する月謝契約がある友だちの削除は止まり、通知も残る',async()=>{
 db=monthlyFixture();await monthlyContract(db);monthlyCycle(db);
 monthlyNotices('f','friend','2026-11-20');monthlyNotices('f','store','2026-11-21');
 expect(db.raw.pragma('foreign_keys',{simple:true})).toBe(1);
 await expect(deleteCustomerData({DB:db.db},target,'o')).rejects.toMatchObject({status:409});
 for(const [table,n] of [['friends',2],['booking_monthly_contracts',1],['booking_monthly_cycles',1],['booking_monthly_failure_notices',2],['booking_monthly_notice_cap',2]] as const)
  expect(db.raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({n});
});

test('通知の子を先に消し、別の友だちの記録は残す',async()=>{
 db=monthlyFixture();await monthlyContract(db,{friendId:'f2'});monthlyCycle(db);
 // 実際には作られない、別人の契約のcycleを参照する通知を使い、保持契約の409とは別に削除順を検証する。
 monthlyNotices('f','friend','2026-11-20');monthlyNotices('f2','store','2026-11-21');
 db.raw.exec(`INSERT INTO booking_entitlements(id,line_account_id,friend_id,kind,name,monthly_limit,valid_from,expires_at,created_at,updated_at,plan_id,source)
   VALUES('ent','a','f2','monthly','月謝',4,'2026-11-01','2026-12-01','2026-11-01','2026-11-01','plan','online');
  INSERT INTO booking_entitlement_notices(id,line_account_id,friend_id,entitlement_id,plan_id,kind,dedupe_key,messages_json,scheduled_at) VALUES
   ('notice-f','a','f','ent','plan','remaining_one','f','[]','2026-11-20'),('notice-f2','a','f2','ent','plan','remaining_one','f2','[]','2026-11-20');
  INSERT INTO booking_pass_notice_cap(notice_id,account_id,friend_id,day_jst,reserved_at) VALUES
   ('notice-f','a','f','2026-11-20','2026-11-20'),('notice-f2','a','f2','2026-11-20','2026-11-20');`);
 expect(db.raw.pragma('foreign_keys',{simple:true})).toBe(1);
 expect(await deleteCustomerData({DB:db.db},target,'o')).toMatchObject({deleted:true});
 expect(db.raw.prepare('SELECT friend_id FROM booking_monthly_failure_notices').all()).toEqual([{friend_id:'f2'}]);
 expect(db.raw.prepare('SELECT friend_id FROM booking_monthly_notice_cap').all()).toEqual([{friend_id:'f2'}]);
 expect(db.raw.prepare('SELECT friend_id FROM booking_pass_notice_cap').all()).toEqual([{friend_id:'f2'}]);
 expect(db.raw.prepare('SELECT friend_id FROM booking_entitlement_notices').all()).toEqual([{friend_id:'f2'}]);
 expect(db.raw.prepare('SELECT id FROM booking_monthly_cycles').all()).toEqual([{id:'cycle'}]);
 expect(db.raw.prepare('SELECT friend_id FROM booking_monthly_contracts').all()).toEqual([{friend_id:'f2'}]);
 expect(db.raw.pragma('foreign_key_check')).toEqual([]);
});
