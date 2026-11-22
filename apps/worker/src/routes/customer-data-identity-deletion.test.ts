import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { deleteCustomerData } from '../services/customer-data-deletion.js';

let f: SqliteD1;
const target = { kind: 'friend_data' as const, id: 'f', friendId: 'f', accountId: 'a', lineUserId: 'line-person' };
beforeEach(() => {
  f = createTestD1({ foreignKeys: true });
  f.raw.exec(`INSERT INTO tenants(id,name) VALUES('t','T');
    INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret,tenant_id) VALUES('a','A','a','token','secret','t'),('b','B','b','token','secret','t');
    INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES('f','line-person','a','同じ名前'),('other','line-other','a','同じ名前');
    INSERT INTO rt_organizations(id,account_id,name,tenant_id) VALUES('org','a','Org','t');
    INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('sa','org','A','a','a'),('sb','org','B','b','b');
    INSERT INTO rt_inbound_emails(id,message_id,store_id,r2_key,status) VALUES('mail','message','sa','raw/mail','stored');
    INSERT INTO rt_reservations(id,store_id,source,customer_name,customer_phone,line_uid,guest_count,starts_at,ends_at,allergy_note,note,cancel_reason,dining_snapshot_json)
    VALUES('mine','sa','line','同じ名前','09000000000','line-person',2,'2030-01-01','2030-01-02','アレルギー','個人メモ','理由','{"name":"個人","courseId":"course","courseAllergens":["乳"]}'),
      ('other','sa','line','同じ名前','09000000000','line-other',2,'2030-01-03','2030-01-04','別人','別人メモ',NULL,NULL),
      ('phone','sa','phone','同じ名前','09000000000',NULL,2,'2030-01-05','2030-01-06',NULL,NULL,NULL,NULL),
      ('foreign','sb','line','同じ名前','09000000000','line-person',2,'2030-01-07','2030-01-08',NULL,NULL,NULL,NULL);
    INSERT INTO line_message_unsends(line_message_account_key,line_message_id,source_user_id,unsent_at) VALUES('account:a','m1','line-person','now'),('account:b','m2','line-person','now'),('destination:old','m3','line-person','now');
    INSERT INTO rt_seat_waitlist(id,store_id,starts_at,guest_count,customer_name,customer_phone,line_uid,identity_key,status) VALUES('wait','sa','2030-01-01',2,'同じ名前','09000000000','line-person','line:line-person','converted');
    INSERT INTO rt_seat_waitlist(id,store_id,starts_at,guest_count,customer_name,customer_phone,line_uid,identity_key,status) VALUES('unlinked','sa','2030-01-09',2,'同じ名前','09000000000','line-person','line:line-person','finished');
    UPDATE rt_reservations SET waitlist_entry_id='wait' WHERE id='mine';
    UPDATE rt_reservations SET inbound_email_id='mail' WHERE id IN ('mine','other');
    INSERT INTO rt_customer_notice_outbox(id,store_id,reservation_id,customer_version,line_uid,message,retry_key) VALUES('notice','sa','mine',1,'line-person','個人への通知','retry');
    INSERT INTO rt_reservation_close_tasks(id,store_id,reservation_id,channel,starts_at,status) VALUES('task','sa','mine','line','2030-01-01','done');`);
});
afterEach(() => { f.raw.close(); vi.restoreAllMocks(); });

it('同じアカウントと LINE ID の組だけを匿名化し、同名・同電話と別アカウントを守る', async () => {
  expect(await deleteCustomerData({ DB: f.db }, target, 'owner')).toEqual({ deleted: true, replayed: false });
  expect(f.raw.prepare("SELECT customer_name,customer_phone,line_uid,allergy_note,note,cancel_reason,dining_snapshot_json FROM rt_reservations WHERE id='mine'").get()).toEqual({ customer_name: '削除済みのお客さま', customer_phone: null, line_uid: null, allergy_note: null, note: null, cancel_reason: null, dining_snapshot_json: '{"courseId":"course","courseAllergens":["乳"]}' });
  expect(f.raw.prepare("SELECT id,customer_name,customer_phone,line_uid FROM rt_reservations WHERE id<>'mine' ORDER BY id").all()).toEqual([
    { id: 'foreign', customer_name: '同じ名前', customer_phone: '09000000000', line_uid: 'line-person' },
    { id: 'other', customer_name: '同じ名前', customer_phone: '09000000000', line_uid: 'line-other' },
    { id: 'phone', customer_name: '同じ名前', customer_phone: '09000000000', line_uid: null },
  ]);
  expect(f.raw.prepare('SELECT line_message_id,source_user_id FROM line_message_unsends ORDER BY line_message_id').all()).toEqual([{ line_message_id: 'm1', source_user_id: null }, { line_message_id: 'm2', source_user_id: 'line-person' }, { line_message_id: 'm3', source_user_id: 'line-person' }]);
  expect(f.raw.prepare("SELECT line_uid,message,valid FROM rt_customer_notice_outbox WHERE id='notice'").get()).toEqual({ line_uid: '', message: '', valid: 0 });
  expect(f.raw.prepare("SELECT reservation_id FROM rt_reservation_close_tasks WHERE id='task'").get()).toEqual({ reservation_id: 'mine' });
  expect(f.raw.prepare("SELECT id,inbound_email_id FROM rt_reservations WHERE id IN ('mine','other') ORDER BY id").all()).toEqual([{ id: 'mine', inbound_email_id: 'mail' }, { id: 'other', inbound_email_id: 'mail' }]);
  expect(f.raw.prepare("SELECT r2_key FROM rt_inbound_emails WHERE id='mail'").get()).toEqual({ r2_key: 'raw/mail' });
  expect(f.raw.prepare("SELECT COUNT(*) n FROM rt_reservation_events WHERE reservation_id='mine' AND event_type='restaurant.reservation.changed'").get()).toEqual({ n: 0 });
  expect(f.raw.prepare("SELECT customer_version FROM rt_reservations WHERE id='mine'").get()).toEqual({ customer_version: 2 });
  expect(f.raw.prepare("SELECT COUNT(*) n FROM rt_reservation_event_receipts WHERE event_id='rt:mine:2:restaurant.reservation.changed'").get()).toEqual({ n: 0 });
  const audit = f.raw.prepare("SELECT detail_json FROM operation_audit WHERE id='customer-delete:friend_data:f'").get() as { detail_json: string };
  expect(JSON.parse(audit.detail_json)).toMatchObject({ anonymizedRows: 4, unlinkedCandidates: { legacyDestinationMatchingLineId: 1, accountReservationsWithoutLineId: 1, unlinkedWaitlistMatchingLineId: 1, reservationsWithRawEmail: 1 } });
  expect(audit.detail_json).not.toContain('09000000000');
  expect(audit.detail_json).not.toContain('line-person');
  expect(f.raw.prepare("SELECT customer_name,customer_phone,line_uid,identity_key,status FROM rt_seat_waitlist WHERE id='wait'").get()).toEqual({ customer_name: '削除済みのお客さま', customer_phone: null, line_uid: null, identity_key: 'deleted:wait', status: 'converted' });
  expect(f.raw.prepare("SELECT line_uid FROM rt_seat_waitlist WHERE id='unlinked'").get()).toEqual({ line_uid: 'line-person' });
  expect(f.raw.pragma('foreign_key_check')).toEqual([]);
});

it('古い本人情報では削除を開始しない', async () => {
  await expect(deleteCustomerData({ DB: f.db }, { ...target, lineUserId: 'line-other' }, 'owner')).rejects.toMatchObject({ status: 409 });
  expect(f.raw.prepare("SELECT id FROM friends WHERE id='f'").get()).toEqual({ id: 'f' });
  expect(f.raw.prepare("SELECT line_uid FROM rt_reservations WHERE id='mine'").get()).toEqual({ line_uid: 'line-person' });
});

it('予約に結び付く待ち行の本人が異なるときは別人を守って止める', async () => {
  f.raw.exec("UPDATE rt_seat_waitlist SET line_uid='line-other' WHERE id='wait'");
  await expect(deleteCustomerData({ DB: f.db }, target, 'owner')).rejects.toMatchObject({ status: 409 });
  expect(f.raw.prepare("SELECT line_uid,customer_name FROM rt_seat_waitlist WHERE id='wait'").get()).toEqual({ line_uid: 'line-other', customer_name: '同じ名前' });
});

it('予約に結び付く待ち行の通知が送信中なら削除を止める', async () => {
  f.raw.exec("UPDATE rt_seat_waitlist SET notification_claim_until=datetime('now','+5 minutes') WHERE id='wait'");
  await expect(deleteCustomerData({ DB: f.db }, target, 'owner')).rejects.toMatchObject({ status: 409, code: 'deletion_in_progress' });
  expect(f.raw.prepare("SELECT line_uid FROM rt_seat_waitlist WHERE id='wait'").get()).toEqual({ line_uid: 'line-person' });
});

it('送信中の通知があれば削除と匿名化を確定しない', async () => {
  f.raw.exec("UPDATE rt_customer_notice_outbox SET valid=1,lease_until=datetime('now','+5 minutes'),lease_token='sending' WHERE id='notice'");
  await expect(deleteCustomerData({ DB: f.db }, target, 'owner')).rejects.toMatchObject({ status: 409 });
  expect(f.raw.prepare("SELECT line_uid FROM rt_reservations WHERE id='mine'").get()).toEqual({ line_uid: 'line-person' });
  expect(f.raw.prepare("SELECT id FROM friends WHERE id='f'").get()).toEqual({ id: 'f' });
});

it('無効化後でも送信の借受が残っていれば削除を止める', async () => {
  f.raw.exec("UPDATE rt_customer_notice_outbox SET valid=0,lease_until=datetime('now','+5 minutes'),lease_token='sending' WHERE id='notice'");
  await expect(deleteCustomerData({ DB: f.db }, target, 'owner')).rejects.toMatchObject({ status: 409, code: 'deletion_in_progress' });
  expect(f.raw.prepare("SELECT id FROM friends WHERE id='f'").get()).toEqual({ id: 'f' });
});

it('予約の通知先が別人なら通知を消さず削除を止める', async () => {
  f.raw.exec("UPDATE rt_customer_notice_outbox SET line_uid='line-other' WHERE id='notice'");
  await expect(deleteCustomerData({ DB: f.db }, target, 'owner')).rejects.toMatchObject({ status: 409 });
  expect(f.raw.prepare("SELECT line_uid,message FROM rt_customer_notice_outbox WHERE id='notice'").get()).toEqual({ line_uid: 'line-other', message: '個人への通知' });
  expect(f.raw.prepare("SELECT id FROM friends WHERE id='f'").get()).toEqual({ id: 'f' });
});

it('予約に別人の履歴が結び付いていてもその履歴を変更しない', async () => {
  f.raw.exec(`INSERT INTO rt_reservation_events(id,reservation_id,store_id,event_type,reservation_version,occurred_at,request_id,line_account_id,friend_id,payload_json)
    VALUES('other-event','mine','sa','other.event',99,'2030-01-01','other-request','a','other','{"name":"別人"}')`);
  await expect(deleteCustomerData({ DB: f.db }, target, 'owner')).resolves.toMatchObject({ deleted: true });
  expect(f.raw.prepare("SELECT payload_json FROM rt_reservation_events WHERE id='other-event'").get()).toEqual({ payload_json: '{"name":"別人"}' });
});

it('ファイル削除の途中で送信が始まれば DB の匿名化は巻き戻る', async () => {
  f.raw.exec(`INSERT INTO forms(id,name,fields) VALUES('form','F','[]');
    INSERT INTO media_file_scans(id,line_account_id,subject_kind,subject_id,filename,mime_type,size_bytes,status)
      VALUES('scan','a','form_file','private/doc','doc','application/pdf',12,'clean');
    INSERT INTO form_submission_files(id,line_account_id,form_id,block_id,friend_id,file_kind,side,r2_key,filename,mime_type,size_bytes,scan_id,created_at)
      VALUES('doc','a','form','block','f','identity','single','private/doc','doc','application/pdf',12,'scan','2026-10-10');`);
  const remove = vi.fn(async () => { f.raw.exec("UPDATE rt_customer_notice_outbox SET valid=1,lease_until=datetime('now','+5 minutes'),lease_token='sending' WHERE id='notice'"); });
  await expect(deleteCustomerData({ DB: f.db, IMAGES: { delete: remove } }, target, 'owner')).rejects.toMatchObject({ status: 503 });
  expect(remove).toHaveBeenCalled();
  expect(f.raw.prepare("SELECT id FROM friends WHERE id='f'").get()).toEqual({ id: 'f' });
  expect(f.raw.prepare("SELECT line_uid FROM rt_reservations WHERE id='mine'").get()).toEqual({ line_uid: 'line-person' });
});
