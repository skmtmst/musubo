import { beforeEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { hqMusuboPricing } from './hq-musubo-pricing.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const owner: AuthenticatedStaff = { id: 'owner', name: '契約者', role: 'owner', readOnly: false, tenantId };
let fixture: SqliteD1;

beforeEach(() => {
  fixture = createTestD1();
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,created_at,updated_at)
    VALUES (?,?,'month','awaiting_first_line',?,?)`).run(
    tenantId, JSON.stringify({ sourceConditionId: 'normal', sourceVersion: 1,
      internalName: '通常条件', trialPeriod: { unit: 'days', value: 30 },
      lineBasicDiscountPercent: 0, discountEndsOn: null, schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE }),
    '2026-11-09T10:00:00+09:00', '2026-11-09T10:00:00+09:00',
  );
});

function app(staff: AuthenticatedStaff = owner) {
  const hono = new Hono<Env>();
  hono.use('*', async (c, next) => { c.set('staff', staff); await next(); });
  hono.route('/', hqMusuboPricing);
  return hono;
}

const env = () => ({ DB: fixture.db }) as Env['Bindings'];
const path = '/api/hq/onboarding/pricing';
const selection = {
  lineCount: 1, friendCountExcludingBlocked: 2800,
  googleBusinessCount: 2, instagramCount: 1, interval: 'month',
};

it('stores consent with server-calculated prices before card setup', async () => {
  const read = await app().request(path, {}, env());
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ data: { condition: { name: '通常条件' }, consentedAt: null } });
  const response = await app().request(path, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selection, consent: true, price: { monthlyTotalYen: 1 } }),
  }, env());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { price: { monthlyTotalYen: 9200 } } });
  const row = fixture.raw.prepare(`SELECT pricing_selection_json,billing_interval,pricing_consented_at
    FROM musubo_tenant_billing WHERE tenant_id=?`).get(tenantId) as {
    pricing_selection_json: string; billing_interval: string; pricing_consented_at: string | null;
  };
  expect(JSON.parse(row.pricing_selection_json).price.monthlyTotalYen).toBe(9200);
  expect(row.billing_interval).toBe('month');
  expect(row.pricing_consented_at).not.toBeNull();
});

it('rejects an unconsented or quote-sized normal plan', async () => {
  for (const [planned, consent] of [[selection, false], [{ ...selection, lineCount: 11 }, true]]) {
    const response = await app().request(path, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection: planned, consent }),
    }, env());
    expect(response.status).toBe(400);
  }
  expect(fixture.raw.prepare('SELECT pricing_consented_at FROM musubo_tenant_billing WHERE tenant_id=?')
    .get(tenantId)).toEqual({ pricing_consented_at: null });
});
