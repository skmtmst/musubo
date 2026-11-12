import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { normalizePhone } from '@line-crm/shared';
import { insertSeatWaitlistEntry } from '../routes/restaurant-test-definition.js';
import { normalizedPhoneSql } from './phone-sql.js';

it('実D1の深さ制限内でも旧番号の同時3件上限と別アカウントの分離を守る', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("local-only")}}', d1Databases: ['DB'], d1Persist: false });
  try {
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    await db.batch([
      db.prepare('CREATE TABLE rt_stores (id TEXT PRIMARY KEY, line_account_id TEXT)'),
      db.prepare("CREATE TABLE booking_waitlist (status TEXT, finish_reason TEXT, updated_at TEXT, starts_at TEXT, hold_expires_at TEXT, line_account_id TEXT)"),
      db.prepare("CREATE TABLE rt_seat_waitlist (id TEXT PRIMARY KEY, store_id TEXT, starts_at TEXT, guest_count INTEGER, customer_name TEXT, customer_phone TEXT, line_uid TEXT, identity_key TEXT, ends_at TEXT, created_at TEXT, status TEXT DEFAULT 'waiting', finish_reason TEXT, updated_at TEXT, hold_expires_at TEXT)"),
      db.prepare('CREATE TABLE rt_closures (id TEXT, store_id TEXT, archived_at TEXT, periods_json TEXT, start_date TEXT, start_time TEXT)'),
      db.prepare("INSERT INTO rt_stores VALUES ('a','account-a'),('b','account-b')"),
    ]);
    const revisionMigration = readFileSync(new URL('../../../../packages/db/migrations/757_confirmation_revisions.sql', import.meta.url), 'utf8');
    await db.prepare(revisionMigration.split('\n').find(line => line.startsWith('ALTER TABLE rt_seat_waitlist '))!).run();
    for (const input of ['０９０－００００－５６７８', '（０９０）００００ー５６７８', '090\u00a00000\u20095678', '⓪⑨⓪⓪⓪⓪⓪⑤⑥⑦⑧']) {
      expect(await db.prepare(`SELECT ${normalizedPhoneSql} AS phone FROM (SELECT ? AS customer_phone)`).bind(input).first()).toEqual({ phone: normalizePhone(input) });
    }
    const startsAt = new Date(Date.now() + 2 * 86400_000).toISOString();
    const phones = ['０９０－００００－５６７８', '(090) 0000 5678', '090\u00a00000\u20095678'];
    await db.batch(phones.map((phone, index) => db.prepare('INSERT INTO rt_seat_waitlist (id,store_id,starts_at,customer_phone,identity_key) VALUES (?,\'a\',?,?,?)')
      .bind(`old-${index}`, new Date(Date.parse(startsAt) + (index + 1) * 86400_000).toISOString(), phone, `phone:${phone}`)));
    const before = (await db.prepare('SELECT * FROM rt_seat_waitlist ORDER BY id').all()).results;
    const input = { storeId: 'a', startsAt, guestCount: 2, customerName: '試験の組', customerPhone: '０９０－００００－５６７８', lineUid: null };
    expect(await insertSeatWaitlistEntry(db, input)).toEqual({ ok: false, error: 'waitlist_limit' });
    expect((await db.prepare('SELECT * FROM rt_seat_waitlist ORDER BY id').all()).results).toEqual(before);
    expect(await insertSeatWaitlistEntry(db, { ...input, storeId: 'b' })).toMatchObject({ ok: true });
    expect(await db.prepare("SELECT customer_phone,identity_key FROM rt_seat_waitlist WHERE store_id='b'").first()).toEqual({ customer_phone: '09000005678', identity_key: 'phone:09000005678' });
    expect(await insertSeatWaitlistEntry(db, { ...input, storeId: 'b', customerPhone: '090 0000 5678' })).toEqual({ ok: false, error: 'already_waiting' });
  } finally {
    await mf.dispose();
  }
}, 20_000);
