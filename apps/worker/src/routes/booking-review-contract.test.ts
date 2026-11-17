import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { gapApp, gapCall, gapFixture, seedGapBooking } from '../test-utils/gap1.js';
import booking from './booking.js';
import { bookingGap3 } from './booking-gap3.js';
import { bookingCancellation } from './booking-cancellation.js';

let d: ReturnType<typeof gapFixture>;
let background: Promise<unknown>[] = [];
const at = new Date('2026-11-18T04:00:00Z');
const startsAt = '2026-11-20T05:00:00.000Z';
const policy = { enabled: true, tiers: [{ beforeHours: 24, percent: 0 }, { beforeHours: 0, percent: 50 }], noShowPercent: 100, expectedVersion: 0 };
const app = () => gapApp(d, [booking, bookingGap3, bookingCancellation]);
const selfRequest = (path: string, body?: unknown) => app().request(`/api/liff/booking/${path}${path.includes('?') ? '&' : '?'}liffId=liff-a`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}, undefined, { waitUntil: (promise: Promise<unknown>) => { background.push(promise.catch(() => {})); }, passThroughOnException: () => {}, props: {} });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(at);
  background = [];
  d = gapFixture();
  d.raw.exec(`UPDATE booking_settings SET approval_mode='automatic', max_active_bookings_per_friend=52;
    INSERT INTO booking_payment_connections(line_account_id,provider,provider_account_id,test_mode,connected_at) VALUES('a','stripe','acct_test_123',1,'2026-11-18');
    UPDATE menus SET customer_recurring_enabled=1,recurring_freqs_json='["weekly"]',recurring_max_count=12;`);
  for (const date of ['2026-11-20', '2026-11-27', '2026-12-04', '2026-12-11']) {
    d.raw.prepare("INSERT INTO staff_shifts(id,staff_id,work_date,start_time,end_time) VALUES(?,'bs',?,'09:00','18:00')").run(date, date);
  }
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    if (String(input).includes('oauth2/v2.1/verify')) return new Response(JSON.stringify({ sub: 'Uf' }));
    throw new Error('unexpected_external_request');
  }));
});
afterEach(async () => { await Promise.all(background); d.raw.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function enablePolicy() {
  expect((await gapCall(app(), '/api/booking/admin/cancellation-policy?account_id=a', 'PUT', policy)).status).toBe(200);
}
function paid() {
  d.raw.exec(`INSERT INTO booking_payments(id,line_account_id,booking_id,amount,status,provider,provider_payment_id,idempotency_key,created_at,updated_at)
    VALUES('paid','a','bk',8400,'paid','stripe','pi_test_cancel','paid','2026-11-18','2026-11-18')`);
}
const state = () => d.raw.prepare("SELECT status,refunded_amount FROM booking_payments WHERE id='paid'").get();

test('予約前の実在する見積もりは、同意に必要な版・段・料金を返し、同じ版と登録IDで予約できる', async () => {
  await enablePolicy();
  const response = await selfRequest(`cost-estimate?menu_id=menu&staff_id=bs&starts_at=${startsAt}`);
  expect(response.status).toBe(200);
  const estimate = await response.json() as any;
  expect(estimate).toMatchObject({ success: true, data: { cancellation: { enabled: true, version: 1, price: 8400, cardRequired: true, tiers: policy.tiers, noShowPercent: 100, feeNow: 0 }, deposit: { amount: 0 } } });
  d.raw.exec("INSERT INTO booking_payment_methods(id,friend_id,line_account_id,setup_id,idempotency_key,status,created_at) VALUES('pm','f','a','seti_test_ready','ready','ready','2026-11-18')");
  const r = await selfRequest('requests', { menu_id: 'menu', staff_id: 'bs', starts_at: startsAt, policyAccepted: true, policyVersion: estimate.data.cancellation.version, setupIntentId: 'seti_test_ready' });
  expect(r.status, await r.clone().text()).toBe(201);
  expect(d.raw.prepare('SELECT status,booking_payment_method_id,policy_snapshot_json FROM bookings').get()).toMatchObject({ status: 'confirmed', booking_payment_method_id: 'pm', policy_snapshot_json: expect.stringContaining('"version":1') });
});
test('担当の上書き料金と指名料を見積もりに反映し、オフも正常応答として返す', async () => {
  d.raw.exec("UPDATE staff_menus SET override_price=9000 WHERE staff_id='bs'; UPDATE staff SET nomination_fee=500 WHERE id='bs'");
  const response = await selfRequest(`cost-estimate?menu_id=menu&staff_id=bs&starts_at=${startsAt}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { cancellation: { enabled: false, price: 9500, version: 0 } } });
  expect((await selfRequest(`cost-estimate?menu_id=menu&staff_id=bs2&starts_at=${startsAt}`)).status).toBe(422);
});
test('繰り返し見積もりはruleの回数と担当を使い、data.occurrencesにstartsAtを返す', async () => {
  const r = await selfRequest('series/preview', { menuId: 'menu', staffId: 'bs', startsAt, rule: { freq: 'weekly', count: 4 } });
  expect(r.status, await r.clone().text()).toBe(200);
  const data = await r.json() as any;
  expect(data.data.occurrences).toHaveLength(4);
  expect(data.data.occurrences[0]).toMatchObject({ index: 0, startsAt, available: true, staffId: 'bs', reason: null });
  expect((await selfRequest('series/preview', { menuId: 'menu', staffId: 'bs', startsAt, rule: { freq: 'weekly', count: 13 } })).status).toBe(400);
});
test.each([true, false])('期限内の本人取消は全額と返金履歴を残し、期限をまたいだ再送でも二重返金しない（決まり=%s）', async (enabled) => {
  if (enabled) await enablePolicy(); seedGapBooking(d); paid();
  const r = await selfRequest('bk/cancel', { lock_version: 0 });
  expect(r.status, await r.clone().text()).toBe(200);
  expect(state()).toEqual({ status: 'refunded', refunded_amount: 8400 });
  expect(d.raw.prepare('SELECT amount,reason,actor_id,actor_label FROM booking_payment_refunds').get()).toEqual({ amount: 8400, reason: '期限内の予約キャンセル', actor_id: 'f', actor_label: 'お客さま本人（予約キャンセル）' });
  vi.setSystemTime(new Date('2026-11-20T04:00:00Z'));
  expect((await selfRequest('bk/cancel', { lock_version: 0 })).status).toBe(200);
  expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_payment_refunds').get()).toEqual({ n: 1 });
  expect(d.raw.prepare("SELECT decided_at FROM bookings WHERE id='bk'").get()).toEqual({ decided_at: at.toISOString() });
  const audit = d.raw.prepare("SELECT after_json FROM booking_audit_logs WHERE booking_id='bk' AND action='cancel_retry_claimed'").get() as { after_json: string };
  expect(JSON.parse(audit.after_json)).toMatchObject({ decided_at: at.toISOString() });
});
test('返金保存が失敗したら成功と返さず、取消の再送で返金記録ごと回復する', async () => {
  await enablePolicy(); seedGapBooking(d); paid();
  d.raw.exec("CREATE TRIGGER fail_refund BEFORE UPDATE OF refunded_amount ON booking_payments BEGIN SELECT RAISE(ABORT,'refund_crash'); END");
  const r = await selfRequest('bk/cancel', { lock_version: 0 });
  expect(r.status).toBeGreaterThanOrEqual(500);
  expect(state()).toEqual({ status: 'paid', refunded_amount: 0 });
  expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_payment_refunds').get()).toEqual({ n: 0 });
  d.raw.exec('DROP TRIGGER fail_refund');
  // 再試行が無料期間後でも、最初に取り消した時刻で返金する。
  vi.setSystemTime(new Date('2026-11-20T04:00:00Z'));
  expect((await selfRequest('bk/cancel', { lock_version: 0 })).status).toBe(200);
  expect(state()).toEqual({ status: 'refunded', refunded_amount: 8400 });
});
test('期限後の本人取消はキャンセル料を記録し、支払いを返金しない', async () => {
  await enablePolicy(); seedGapBooking(d); paid();
  vi.setSystemTime(new Date('2026-11-20T04:00:00Z'));
  const r = await selfRequest('bk/cancel', { lock_version: 0, feeAccepted: true, expectedFeeAmount: 4200 });
  expect(r.status, await r.clone().text()).toBe(200);
  expect(state()).toEqual({ status: 'paid', refunded_amount: 0 });
  expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_payment_refunds').get()).toEqual({ n: 0 });
  expect(d.raw.prepare('SELECT amount FROM booking_charges').get()).toEqual({ amount: 4200 });
});
test('店頭払いと別人の取消は返金を作らず、別人の支払いを変えない', async () => {
  seedGapBooking(d); paid();
  d.raw.exec("UPDATE bookings SET friend_id='f2' WHERE id='bk'");
  expect((await selfRequest('bk/cancel', { lock_version: 0 })).status).toBe(404);
  expect(state()).toEqual({ status: 'paid', refunded_amount: 0 });
  seedGapBooking(d, 'onsite');
  expect((await selfRequest('onsite/cancel', { lock_version: 0 })).status).toBe(200);
  expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_payment_refunds').get()).toEqual({ n: 0 });
});

test('同時の本人取消でも返金と監査は一回分だけ', async () => {
  await enablePolicy(); seedGapBooking(d); paid();
  const responses = await Promise.all([selfRequest('bk/cancel', { lock_version: 0 }), selfRequest('bk/cancel', { lock_version: 0 })]);
  expect(responses.every((r) => r.status === 200 || r.status === 409)).toBe(true);
  expect(responses.some((r) => r.status === 200)).toBe(true);
  expect(state()).toEqual({ status: 'refunded', refunded_amount: 8400 });
  expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_payment_refunds').get()).toEqual({ n: 1 });
});

test('B4-09: 顧客向け繰り返しをオフにしたメニューでは直接送信を拒否する', async () => {
  d.raw.exec('UPDATE menus SET customer_recurring_enabled=0');
  const r = await selfRequest('requests', { menu_id: 'menu', staff_id: 'bs', starts_at: startsAt, recurrence: { freq: 'weekly', count: 3 } });
  expect(r.status).toBe(400); expect(await r.json()).toMatchObject({ success: false, error: 'recurring_not_allowed' });
  expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_series').get()).toEqual({ n: 0 });
  expect(d.raw.prepare('SELECT COUNT(*) n FROM bookings').get()).toEqual({ n: 0 });
});
test('B4-11: 顧客から13回の繰り返し予約は直接送信でも拒否する', async () => {
  const r = await selfRequest('requests', { menu_id: 'menu', staff_id: 'bs', starts_at: startsAt, recurrence: { freq: 'weekly', count: 13 } });
  expect(r.status).toBe(400); expect(await r.json()).toMatchObject({ success: false, error: 'invalid_count' });
  expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_series').get()).toEqual({ n: 0 });
  expect(d.raw.prepare('SELECT COUNT(*) n FROM bookings').get()).toEqual({ n: 0 });
});
