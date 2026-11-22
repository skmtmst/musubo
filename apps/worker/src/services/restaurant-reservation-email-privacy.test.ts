import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import { processStoredRestaurantEmail } from './restaurant-reservation-email.js';

let fixture: SqliteD1;
const media = { id: 'gn', code: 'gurunavi' as const, name: '試験媒体', parser_key: 'gurunavi' };
const mail = (changed: boolean) => [
  'From: example@example.test',
  `Date: ${changed ? 'Wed, 21 Oct 2026 12:00:00 +0900' : 'Tue, 20 Oct 2026 12:00:00 +0900'}`,
  'Subject: 予約通知', 'Content-Type: text/plain; charset=utf-8', '',
  '［予約番号］: TEST-123', `［状態］: ${changed ? 'キャンセル' : '確定済'}`,
  `［予約者名］: ${changed ? '変更 太郎' : '元 太郎'}様`, `［電話番号］: ${changed ? '090-2222-2222' : '090-1111-1111'}`,
  `［来店日時］: ${changed ? '2026年11月1日(日) 12:30' : '2026年11月1日(日) 12:00'}`,
  `［来店人数］: ${changed ? '4名' : '2名'}`, `［コース］: ${changed ? '個人向けコース' : '通常コース'}`,
  ...(changed ? ['［キャンセル理由］: 私的な理由'] : []),
].join('\r\n');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('実通信は禁止'); }));
  fixture = createTestD1({ now: () => new Date('2026-10-20T00:00:00Z') });
  fixture.raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('acc','channel','店舗','','');
    INSERT INTO rt_organizations(id,account_id,name) VALUES('org','acc','店舗');
    INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('s','org','店舗','s','acc');
    INSERT INTO rt_media(id,code,name,sender_addresses,parser_key) VALUES('gn','gurunavi','試験媒体','[]','gurunavi');`);
});
afterEach(() => { fixture.raw.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function ingest(changed: boolean) {
  const bytes = new TextEncoder().encode(mail(changed));
  const env = { DB: fixture.db, RAW_MAIL: { async get() { return { size: bytes.length, body: new Blob([bytes]).stream() }; } } } as unknown as Env['Bindings'];
  await processStoredRestaurantEmail({ env, storeId: 's', inboundEmailId: 'email', eventId: 'event', objectKey: 'mail', media, fallbackSubject: '', fallbackDate: null });
}
const reservation = () => fixture.raw.prepare(`SELECT customer_name,customer_phone,note,cancel_reason,allergy_note,line_uid,guest_count,starts_at,ends_at,status
  FROM rt_reservations WHERE store_id='s' AND source='gurunavi' AND external_id='TEST-123'`).get();

it('顧客削除で匿名化した予約は媒体メールの再取込でも個人情報を復元せず、予約の変更は受ける', async () => {
  await ingest(false);
  expect(reservation()).toMatchObject({ customer_name: '元 太郎', customer_phone: '09011111111', guest_count: 2, status: 'confirmed' });
  // 顧客削除は名前をこの固定値にし、個人情報を NULL にする。
  fixture.raw.exec("UPDATE rt_reservations SET customer_name='削除済みのお客さま',customer_phone=NULL,line_uid=NULL,allergy_note=NULL,note=NULL,cancel_reason=NULL WHERE external_id='TEST-123'");
  const revisionBefore = fixture.raw.prepare("SELECT confirmation_revision FROM rt_reservations WHERE external_id='TEST-123'").get() as { confirmation_revision: number };
  await ingest(false);
  expect(reservation()).toMatchObject({ customer_name: '削除済みのお客さま', customer_phone: null, note: null, cancel_reason: null });
  expect(fixture.raw.prepare("SELECT confirmation_revision FROM rt_reservations WHERE external_id='TEST-123'").get())
    .toEqual({ confirmation_revision: revisionBefore.confirmation_revision + 1 });
  await ingest(true);
  expect(reservation()).toMatchObject({ customer_name: '削除済みのお客さま', customer_phone: null, line_uid: null, allergy_note: null, note: null, cancel_reason: null,
    guest_count: 4, starts_at: '2026-11-01T12:30:00+09:00', ends_at: '2026-11-01T05:30:00.000Z', status: 'cancelled' });
});

it('匿名化していない予約は媒体メールの再取込で名前・電話と予約内容を更新する', async () => {
  await ingest(false);
  await ingest(true);
  expect(reservation()).toMatchObject({ customer_name: '変更 太郎', customer_phone: '09022222222', note: '媒体コース: 個人向けコース', cancel_reason: '私的な理由',
    guest_count: 4, starts_at: '2026-11-01T12:30:00+09:00', ends_at: '2026-11-01T05:30:00.000Z', status: 'cancelled' });
});
