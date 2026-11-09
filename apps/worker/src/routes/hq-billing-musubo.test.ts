import { expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { hqBilling } from './hq-billing.js';

it('new pricing summary does not expose the legacy plan catalog', async () => {
  const fixture = createTestD1();
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,created_at,updated_at)
    VALUES (?,'{}','month','awaiting_first_line','2026-11-09','2026-11-09')`).run(DEFAULT_TENANT_ID);
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'owner', name: 'Owner', role: 'owner', readOnly: false,
      tenantId: DEFAULT_TENANT_ID });
    await next();
  });
  app.route('/', hqBilling);
  const response = await app.request('/api/hq/billing/summary', {},
    { DB: fixture.db, STRIPE_SECRET_KEY: 'sk_test_x' } as Env['Bindings']);
  expect(response.status).toBe(200);
  expect((await response.json() as { data: { plans: unknown[]; newPricing: { status: string; activeLines: unknown[] } } }).data)
    .toMatchObject({ plans: [], newPricing: { status: 'awaiting_first_line', activeLines: [] } });
});
