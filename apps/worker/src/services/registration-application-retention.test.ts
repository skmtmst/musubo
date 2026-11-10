import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { purgeExpiredRegistrationApplications } from './registration-application-retention.js';

let db: SqliteD1;
const now = new Date('2026-11-04T03:00:00.000Z');
beforeEach(() => { db = createTestD1(); });
afterEach(() => { db.raw.close(); });
function insert(id: string, status: string, updated: string, created = updated) {
  db.raw.prepare(`INSERT INTO registration_applications
    (id,company_name,contact_name,email,phone,referral_source,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id,'fixture','fixture',`${id}@example.test`,'000','fixture',status,created,updated);
}
function ids() { return (db.raw.prepare('SELECT id FROM registration_applications ORDER BY id').all() as {id:string}[]).map(row => row.id); }

it('未成立と却下のうち最終更新から365日を過ぎた行だけ消す', async () => {
  for (const status of ['pending','contacted','approved','rejected','activated']) {
    insert(`old-${status}`,status,'2025-11-04T11:59:59.000+09:00');
    insert(`new-${status}`,status,'2025-11-04T12:00:01.000+09:00');
  }
  insert('boundary','rejected','2025-11-04T12:00:00.000+09:00');
  insert('updated','approved','2026-11-01T12:00:00.000+09:00','2024-01-01T00:00:00.000+09:00');
  expect(await purgeExpiredRegistrationApplications(db.db,now)).toBe(4);
  expect(ids()).toEqual(['boundary','new-activated','new-approved','new-contacted','new-pending','new-rejected','old-activated','updated']);
  expect(await purgeExpiredRegistrationApplications(db.db,now)).toBe(0);
});

it('保存した時刻のオフセットを解釈し、UTCの同じ瞬間と比較する', async () => {
  insert('jst-old','rejected','2025-11-04T11:30:00.000+09:00');
  insert('utc-old','pending','2025-11-04T02:30:00.000Z');
  insert('jst-new','contacted','2025-11-04T12:30:00.000+09:00');
  insert('utc-new','approved','2025-11-04T03:30:00.000Z');
  insert('invalid','rejected','not-a-date');
  expect(await purgeExpiredRegistrationApplications(db.db,now)).toBe(2);
  expect(ids()).toEqual(['invalid','jst-new','utc-new']);
});
