import { expect, it, vi } from 'vitest';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from '@line-crm/shared';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { WorkerBindings } from '../worker-bindings.js';

const sent = vi.hoisted(() => vi.fn(async (_env: unknown, _input: {
  to: string; subject: string; body: string; html?: string }) => undefined));
const recorded = vi.hoisted(() => vi.fn(async (_db: unknown, input: {
  send: () => Promise<void> }) => { await input.send(); }));
vi.mock('./plain-mail.js', () => ({ sendPlainMail: sent }));
vi.mock('./recorded-notification-send.js', () => ({ sendRecordedNotification: recorded }));
vi.mock('./musubo-line-resumption.js', () => ({
  getMusuboLineResumptionComplete: vi.fn(async () => ({ kind: 'annual_paid',
    restartedAt: '2027-08-01T00:00:00+09:00', paidThrough: '2027-12-07T23:59:59+09:00',
    renewalAt: '2027-12-08T00:00:00+09:00', nextAnnualLineBaseYen: 63_720,
    chargedNowYen: 3_300, optionsMonthlyYen: 3_300 })),
}));

import { deliverMusuboResumptionNotice } from './musubo-resumption-notification.js';

it('sends Mail 17 once per accepted resumption generation with the total and monthly option', async () => {
  sent.mockClear(); recorded.mockClear();
  const fixture = createTestD1();
  fixture.raw.prepare('UPDATE tenants SET contact_email=? WHERE id=?')
    .run('owner@example.test', DEFAULT_TENANT_ID);
  fixture.raw.prepare(`INSERT INTO line_accounts
    (id,channel_id,name,channel_access_token,channel_secret,tenant_id,is_active)
    VALUES ('old','123456','旧LINE','token','secret',?,1)`).run(DEFAULT_TENANT_ID);
  fixture.raw.prepare(`INSERT INTO musubo_line_usage
    (line_account_id,tenant_id,status,activated_at,updated_at)
    VALUES ('old',?,'active','2027-08-01T00:00:00+09:00','2027-08-01T00:00:00+09:00')`)
    .run(DEFAULT_TENANT_ID);
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,resumption_generation,
      resumed_at,created_at,updated_at) VALUES (?,?,'year','active',2,
      '2027-08-01T00:00:00+09:00','2027-08-01T00:00:00+09:00','2027-08-01T00:00:00+09:00')`)
    .run(DEFAULT_TENANT_ID, JSON.stringify({ schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE }));
  const env = { DB: fixture.db, ADMIN_PUBLIC_URL: 'https://admin.example.test' } as WorkerBindings;
  expect(await deliverMusuboResumptionNotice(env, DEFAULT_TENANT_ID)).toBe(true);
  expect(recorded.mock.calls[0]?.[1]).toMatchObject({
    sourceId: `musubo-resumption:${DEFAULT_TENANT_ID}:2`, channel: 'email',
    recipient: 'owner@example.test',
  });
  expect(sent.mock.calls[0]?.[1]).toMatchObject({ to: 'owner@example.test' });
  expect(sent.mock.calls[0]?.[1].body).toContain('本日の請求合計');
  expect(sent.mock.calls[0]?.[1].body).toContain('¥3,300');
});
