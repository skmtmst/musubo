import { beforeEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { adminAuth } from './admin-auth.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';

let fixture: SqliteD1;
const staff: AuthenticatedStaff = { id: 'pricing-admin', name: '検証担当', role: 'admin', readOnly: false, tenantId: DEFAULT_TENANT_ID };

beforeEach(() => {
  fixture = createTestD1();
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,created_at,updated_at)
    VALUES (?,?,'month','awaiting_first_line',?,?)`).run(
    DEFAULT_TENANT_ID, JSON.stringify({ sourceConditionId: 'normal', sourceVersion: 1,
      internalName: '通常条件', trialPeriod: { unit: 'days', value: 30 },
      lineBasicDiscountPercent: 0, discountEndsOn: null, schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE }),
    '2026-11-11T10:00:00+09:00', '2026-11-11T10:00:00+09:00',
  );
});

function app() {
  const hono = new Hono<Env>();
  hono.use('*', async (c, next) => { c.set('staff', staff); await next(); });
  hono.route('/', adminAuth);
  return hono;
}

it('認証応答に初回LINE前の再開状態を含め、利用開始後は解除する', async () => {
  const env = { DB: fixture.db } as Env['Bindings'];
  const pending = await app().request('/api/auth/session', {}, env);
  expect(pending.status, await pending.clone().text()).toBe(200);
  expect(await pending.json()).toMatchObject({ data: { onboarding: {
    status: 'awaiting_first_line', consentedAt: null, quoteId: null,
  } } });

  fixture.raw.prepare("UPDATE musubo_tenant_billing SET status='trialing' WHERE tenant_id=?").run(DEFAULT_TENANT_ID);
  const active = await app().request('/api/auth/session', {}, env);
  expect(active.status, await active.clone().text()).toBe(200);
  expect(await active.json()).toMatchObject({ data: { onboarding: null } });
});
