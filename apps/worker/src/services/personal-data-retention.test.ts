import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { parseRetentionPolicy, processPersonalDataRetention, RETENTION_POLICY_KEY, retentionCutoff } from './personal-data-retention.js';
import { processBookingAuditRetention } from './booking-audit-retention.js';
let db:ReturnType<typeof createTestD1>;
beforeEach(()=>{
  db=createTestD1({foreignKeys:false});
  db.raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES ('a','a','Fixture','unused','unused'),('b','b','Other fixture','unused','unused');
    INSERT INTO friends(id,line_user_id,line_account_id,is_following,last_unfollowed_at) VALUES ('fa','Ua','a',1,NULL),('fb','Ub','b',1,NULL);
    INSERT INTO forms(id,name) VALUES ('form','Fixture');
    INSERT INTO form_submissions(id,form_id,friend_id,data,created_at) VALUES
    ('expired','form','fa','{"name":"private-old"}','2025-01-01T00:00:00Z'),
    ('boundary','form','fa','{"name":"private-boundary"}','2026-09-17T00:00:00Z'),
    ('recent','form','fa','{"name":"private-recent"}','2026-10-16T00:00:00Z'),
    ('other','form','fb','{"name":"other-store"}','2025-01-01T00:00:00Z');`);
});
afterEach(()=>db.raw.close());
function policy(hold=false){db.raw.prepare('INSERT OR REPLACE INTO account_settings(line_account_id,key,value) VALUES (?,?,?)').run('a',RETENTION_POLICY_KEY,JSON.stringify({enabled:true,hold,responseDays:30,blockedFriendDays:365}));}
const now=new Date('2026-10-17T00:00:00Z');
describe('personal data retention retains recent, held, active and other-store records',()=>{
  it('defaults to an unapproved proposal and refuses invalid settings and dates',()=>{
    expect(parseRetentionPolicy(null).enabled).toBe(false);
    for(const raw of ['{}','null','{"enabled":true,"hold":false,"responseDays":0,"blockedFriendDays":365}','{"enabled":true,"hold":false,"responseDays":-1,"blockedFriendDays":365}']) expect(()=>parseRetentionPolicy(raw)).toThrow();
    expect(()=>retentionCutoff(new Date('invalid'),1)).toThrow();
  });
  it('does nothing until explicitly enabled',async()=>{expect((await processPersonalDataRetention({DB:db.db},now)).deleted).toBe(0);expect(db.raw.prepare('SELECT COUNT(*) AS n FROM form_submissions').get()).toEqual({n:4});});
  it('deletes only before the cutoff and leaves a durable audit; replay is harmless',async()=>{
    policy();const result=await processPersonalDataRetention({DB:db.db},now);expect(result).toEqual({deleted:1,failed:0,held:0});
    expect(db.raw.prepare('SELECT id FROM form_submissions ORDER BY id').all()).toEqual([{id:'boundary'},{id:'other'},{id:'recent'}]);
    expect((await processPersonalDataRetention({DB:db.db},now)).deleted).toBe(0);
    expect(db.raw.prepare("SELECT action FROM operation_audit WHERE id='customer-delete:form_response:expired'").get()).toEqual({action:'deleted'});
  });
  it('honors the store hold, including attachments',async()=>{policy(true);expect((await processPersonalDataRetention({DB:db.db},now)).held).toBe(1);expect(db.raw.prepare('SELECT id FROM form_submissions WHERE id=?').get('expired')).toBeTruthy();});
  it('a deletion failure is reported and remains eligible on the next run',async()=>{
    policy();db.raw.exec("CREATE TRIGGER fixture_fail BEFORE DELETE ON form_submissions BEGIN SELECT RAISE(ABORT,'fixture_failure'); END;");
    expect((await processPersonalDataRetention({DB:db.db},now)).failed).toBe(1);expect(db.raw.prepare("SELECT id FROM form_submissions WHERE id='expired'").get()).toBeTruthy();
    db.raw.exec('DROP TRIGGER fixture_fail');expect((await processPersonalDataRetention({DB:db.db},now)).deleted).toBe(1);
  });
});

it('only expired blocked profiles are removed; an active profile and a recently blocked one survive',async()=>{
  policy();db.raw.exec("DELETE FROM form_submissions; UPDATE friends SET is_following=0,last_unfollowed_at='2024-01-01T00:00:00Z' WHERE id='fa'; INSERT INTO friends(id,line_user_id,line_account_id,is_following,last_unfollowed_at) VALUES ('recent-block','Urecent','a',0,'2026-10-16T00:00:00Z'),('active','Uactive','a',1,'2024-01-01T00:00:00Z')");
  const result=await processPersonalDataRetention({DB:db.db},now);expect(result).toEqual({deleted:1,failed:0,held:0});
  expect(db.raw.prepare('SELECT id FROM friends ORDER BY id').all()).toEqual([{id:'active'},{id:'fb'},{id:'recent-block'}]);
});

it('rechecks the policy before every deletion and honors a hold enabled during the run', async () => {
  policy();
  db.raw.exec("UPDATE form_submissions SET created_at='2025-01-02T00:00:00Z' WHERE id='recent'; CREATE TRIGGER fixture_hold AFTER DELETE ON form_submissions BEGIN UPDATE account_settings SET value=json_set(value,'$.hold',json('true')) WHERE line_account_id='a'; END;");
  expect(await processPersonalDataRetention({ DB: db.db }, now)).toEqual({ deleted: 1, failed: 0, held: 1 });
  expect(db.raw.prepare("SELECT id FROM form_submissions WHERE id='recent'").get()).toEqual({ id: 'recent' });
  expect(db.raw.prepare("SELECT id FROM form_submissions WHERE id='other'").get()).toEqual({ id: 'other' });
});

it('keeps the existing twenty-deletion budget and leaves the remainder for the next run', async () => {
  policy();
  const insert = db.raw.prepare("INSERT INTO form_submissions(id,form_id,friend_id,data,created_at) VALUES (?,'form','fa','{}','2025-01-02T00:00:00Z')");
  for (let i = 0; i < 25; i++) insert.run(`old-${i}`);
  expect(await processPersonalDataRetention({ DB: db.db }, now)).toEqual({ deleted: 20, failed: 0, held: 0 });
  expect(db.raw.prepare("SELECT COUNT(*) n FROM form_submissions WHERE friend_id='fa' AND created_at<'2026-01-01'").get()).toEqual({ n: 6 });
  expect((await processPersonalDataRetention({ DB: db.db }, now)).deleted).toBe(6);
  expect(db.raw.prepare("SELECT id FROM form_submissions WHERE id='other'").get()).toEqual({ id: 'other' });
});

it('顧客削除後の監査だけ10年で消し、保持停止・期限内・未匿名化の行は残す',async()=>{
 const cutoff=retentionCutoff(now,3650),old=new Date(Date.parse(cutoff)-1000).toISOString(),recent=new Date(Date.parse(cutoff)+1000).toISOString();
 const insert=db.raw.prepare("INSERT INTO booking_audit_logs(id,line_account_id,action,actor_type,occurred_at,customer_redacted_at) VALUES(?,?,'updated','system','2010-01-01',?)");
 insert.run('expired-a','a',old);insert.run('recent-a','a',recent);insert.run('unmarked','a',null);insert.run('held-b','b',old);
 db.raw.prepare('INSERT INTO account_settings(line_account_id,key,value) VALUES(?,?,?)').run('b',RETENTION_POLICY_KEY,JSON.stringify({enabled:false,hold:true,responseDays:365,blockedFriendDays:365}));
 db.raw.exec("UPDATE line_accounts SET is_active=0 WHERE id='a'");
 expect(await processBookingAuditRetention(db.db,now)).toEqual({deleted:1,failed:0});
 expect(db.raw.prepare('SELECT id FROM booking_audit_logs ORDER BY id').all()).toEqual([{id:'held-b'},{id:'recent-a'},{id:'unmarked'}]);
 expect(db.raw.prepare("SELECT after_json FROM audit_events WHERE action='privacy.booking_audit.expired' AND line_account_id='a'").get()).toEqual({after_json:JSON.stringify({deletedRows:1,cutoff})});
});

it('期限切れの監査の記録が失敗したら消去も巻き戻す',async()=>{
 db.raw.exec("INSERT INTO booking_audit_logs(id,line_account_id,action,actor_type,occurred_at,customer_redacted_at) VALUES('expired-a','a','updated','system','2010-01-01','2010-01-01'); CREATE TRIGGER fail_expiry_audit BEFORE INSERT ON audit_events WHEN NEW.action='privacy.booking_audit.expired' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
 expect((await processBookingAuditRetention(db.db,now)).failed).toBe(1);
 expect(db.raw.prepare("SELECT id FROM booking_audit_logs WHERE id='expired-a'").get()).toEqual({id:'expired-a'});
});

it('監査の期限処理は1回20件に限り、残りは次回に処理する',async()=>{
 const insert=db.raw.prepare("INSERT INTO booking_audit_logs(id,line_account_id,action,actor_type,occurred_at,customer_redacted_at) VALUES(?,'a','updated','system','2010-01-01','2010-01-01')");
 for(let i=0;i<25;i++)insert.run(`expired-${i}`);
 expect(await processBookingAuditRetention(db.db,now)).toEqual({deleted:20,failed:0});
 expect(await processBookingAuditRetention(db.db,now)).toEqual({deleted:5,failed:0});
});

it('監査の消去直前に保持停止された場合は削除しない',async()=>{
 db.raw.exec("INSERT INTO booking_audit_logs(id,line_account_id,action,actor_type,occurred_at,customer_redacted_at) VALUES('expired-a','a','updated','system','2010-01-01','2010-01-01')");
 const wrapped=new Proxy(db.db,{get(target,prop,receiver){
  if(prop==='batch')return async (statements:D1PreparedStatement[])=>{
   db.raw.prepare('INSERT INTO account_settings(line_account_id,key,value) VALUES(?,?,?)').run('a',RETENTION_POLICY_KEY,JSON.stringify({enabled:false,hold:true,responseDays:365,blockedFriendDays:365}));
   return target.batch(statements);
  };
  return Reflect.get(target,prop,receiver);
 }});
 expect(await processBookingAuditRetention(wrapped,now)).toEqual({deleted:0,failed:0});
 expect(db.raw.prepare("SELECT id FROM booking_audit_logs WHERE id='expired-a'").get()).toEqual({id:'expired-a'});
});

it('不正な方針の店が多数あっても、他の店の期限処理を妨げない',async()=>{
 const account=db.raw.prepare("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES(?,?, 'Fixture','unused','unused')");
 const setting=db.raw.prepare('INSERT INTO account_settings(line_account_id,key,value) VALUES(?,?,?)');
 const audit=db.raw.prepare("INSERT INTO booking_audit_logs(id,line_account_id,action,actor_type,occurred_at,customer_redacted_at) VALUES(?,?,'updated','system','2010-01-01','2010-01-01')");
 for(let i=0;i<21;i++){const id=`invalid-${i}`;account.run(id,id);setting.run(id,RETENTION_POLICY_KEY,'{"hold":false}');audit.run(id,id);}
 audit.run('valid-b','b');
 expect(await processBookingAuditRetention(db.db,now)).toEqual({deleted:1,failed:0});
 expect(db.raw.prepare("SELECT id FROM booking_audit_logs WHERE id='valid-b'").get()).toBeUndefined();
 expect(db.raw.prepare("SELECT count(*) n FROM booking_audit_logs WHERE id LIKE 'invalid-%'").get()).toEqual({n:21});
});
