import { expect, it } from 'vitest';
import { getTenantBilling } from '@line-crm/db';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { resolveTenantEntitlements } from './billing-plans.js';

it('starts the new trial only after LINE and core contract are ready', async () => {
  const fixture = createTestD1();
  const tenantId = DEFAULT_TENANT_ID;
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,first_line_activated_at,
      first_charge_date,core_subscription_id,options_subscription_id,created_at,updated_at)
    VALUES (?,'{}','month','trialing','2026-11-09','2026-12-09','sub_core','sub_options','2026-11-09','2026-11-09')`)
    .run(tenantId);
  const legacy = await getTenantBilling(fixture.db, tenantId);
  fixture.raw.prepare(`UPDATE musubo_tenant_billing SET options_subscription_id=NULL WHERE tenant_id=?`).run(tenantId);
  expect(await resolveTenantEntitlements(fixture.db, legacy, { now: new Date('2026-12-08T00:00:00Z') }))
    .toMatchObject({ state: 'trial_expired', canSend: false });
  fixture.raw.prepare(`UPDATE musubo_tenant_billing SET options_subscription_id='sub_options' WHERE tenant_id=?`).run(tenantId);
  expect(await resolveTenantEntitlements(fixture.db, legacy, { now: new Date('2026-12-08T14:59:59Z') }))
    .toMatchObject({ state: 'trialing', canSend: true });
  expect(await resolveTenantEntitlements(fixture.db, legacy, { now: new Date('2026-12-08T15:00:00Z') }))
    .toMatchObject({ state: 'trial_expired', canSend: false });
});

it('allows seven days after a paid core invoice fails, then suspends', async () => {
  const fixture = createTestD1();
  const tenantId = DEFAULT_TENANT_ID;
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,first_line_activated_at,
      first_charge_date,core_subscription_id,options_subscription_id,created_at,updated_at)
    VALUES (?,'{}','month','past_due','2026-11-09','2026-12-09','sub_core','sub_options','2026-11-09','2026-11-09')`)
    .run(tenantId);
  fixture.raw.prepare(`INSERT INTO billing_invoices
    (id,tenant_id,subscription_id,status,amount_due,amount_paid,amount_refunded,currency,synced_at,created_at)
    VALUES ('in_failed',?,'sub_core','open',5900,0,0,'jpy','2026-12-09','2026-12-09')`).run(tenantId);
  fixture.raw.prepare(`INSERT INTO billing_events (id,type,tenant_id,summary)
    VALUES ('evt_failed','invoice.payment_failed',?,?)`).run(tenantId,
      JSON.stringify({ state: 'completed', created: Date.parse('2026-12-09T00:00:00Z') / 1000,
        subjectId: 'in_failed' }));
  const legacy = await getTenantBilling(fixture.db, tenantId);
  expect(await resolveTenantEntitlements(fixture.db, legacy, { now: new Date('2026-12-15T23:59:59Z') }))
    .toMatchObject({ state: 'past_due', canSend: true });
  expect(await resolveTenantEntitlements(fixture.db, legacy, { now: new Date('2026-12-16T00:00:00Z') }))
    .toMatchObject({ state: 'payment_suspended', canSend: false });
});
