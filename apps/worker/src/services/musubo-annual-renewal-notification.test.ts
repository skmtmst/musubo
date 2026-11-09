import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE, jstDateOffset } from '@line-crm/shared';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { WorkerBindings } from '../worker-bindings.js';
import { sendPlainMail } from './plain-mail.js';
import { sweepMusuboAnnualRenewalNotices } from './musubo-annual-renewal-notification.js';

vi.mock('./plain-mail.js', () => ({ sendPlainMail: vi.fn(async () => undefined) }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it('sends one annual renewal estimate after applying a scheduled LINE removal', async () => {
  const f = createTestD1();
  const renewalDate = jstDateOffset(29);
  const yesterday = jstDateOffset(-1);
  const now = new Date().toISOString();
  f.raw.prepare('UPDATE tenants SET contact_email=? WHERE id=?')
    .run('owner@example.com', DEFAULT_TENANT_ID);
  const condition = { sourceConditionId: 'normal', sourceVersion: 1, internalName: '通常条件',
    appliedAt: yesterday, trialPeriod: { unit: 'days', value: 30 },
    lineBasicDiscountPercent: 0, schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE };
  f.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,core_subscription_id,
      next_annual_renewal_at,created_at,updated_at)
    VALUES (?,?, 'year','active','sub_core',?,?,?)`)
    .run(DEFAULT_TENANT_ID, JSON.stringify(condition), renewalDate, now, now);
  for (const id of ['line-one', 'line-two']) {
    f.raw.prepare(`INSERT INTO line_accounts
      (id,channel_id,name,channel_access_token,channel_secret,tenant_id,is_active)
      VALUES (?,?,?,'token','secret',?,1)`).run(id, id, id, DEFAULT_TENANT_ID);
    f.raw.prepare(`INSERT INTO musubo_line_usage
      (line_account_id,tenant_id,status,activated_at,friend_count_excluding_blocked,
        friend_count_measured_on,updated_at)
      VALUES (?,?,'active',?,2800,?,?)`)
      .run(id, DEFAULT_TENANT_ID, yesterday, yesterday, now);
  }
  f.raw.prepare(`INSERT INTO musubo_line_removals
    (id,tenant_id,line_account_id,status,effective_at,requested_at,updated_at)
    VALUES ('removal',?, 'line-two','scheduled',?,?,?)`)
    .run(DEFAULT_TENANT_ID, `${renewalDate}T00:00:00+09:00`, now, now);
  const env = { DB: f.db, ADMIN_PUBLIC_URL: 'https://admin.example.com' } as WorkerBindings;
  expect(await sweepMusuboAnnualRenewalNotices(env, now))
    .toEqual({ checked: 1, pending: 1, failed: 0 });
  expect(vi.mocked(sendPlainMail).mock.calls[0]?.[1].body).toContain('更新後の有効LINE：1個');
  expect(vi.mocked(sendPlainMail).mock.calls[0]?.[1].body).toContain('¥63,720');
  expect(await sweepMusuboAnnualRenewalNotices(env, now))
    .toEqual({ checked: 0, pending: 0, failed: 0 });
  expect(sendPlainMail).toHaveBeenCalledTimes(1);
});
