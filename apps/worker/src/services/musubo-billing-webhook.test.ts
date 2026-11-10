import { expect, it } from 'vitest';
import { getMusuboTenantBilling } from '@line-crm/db';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { processMusuboBillingEvent } from './musubo-billing-webhook.js';

it('keeps a failed addition pending and activates only its payment receipt', async () => {
  const fixture = createTestD1();
  const tenantId = DEFAULT_TENANT_ID;
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,first_line_activated_at,
      first_charge_date,core_subscription_id,options_subscription_id,created_at,updated_at)
    VALUES (?,'{}','month','active','2026-11-09','2026-12-09','sub_core','sub_options','2026-11-09','2026-11-09')`)
    .run(tenantId);
  fixture.raw.prepare(`INSERT INTO musubo_pending_additions
    (id,tenant_id,kind,status,amount_due_yen,price_snapshot_json,stripe_invoice_id,
      expires_at,created_at,updated_at)
    VALUES ('addition-one',?,'line','awaiting_payment',6700,'{}','in_addition',
      '2026-12-20T00:00:00Z','2026-12-13T00:00:00Z','2026-12-13T00:00:00Z')`).run(tenantId);
  const billing = (await getMusuboTenantBilling(fixture.db, tenantId))!;
  const send = async (id: string, type: string, paid: number) => {
    fixture.raw.prepare(`INSERT INTO billing_events (id,type,tenant_id,summary)
      VALUES (?,?,?,'pending')`).run(id, type, tenantId);
    return processMusuboBillingEvent({ db: fixture.db, tenantId, customerId: 'cus_1', billing,
      event: { id, type, created: Date.parse('2026-12-14T00:00:00Z') / 1000,
        data: { object: { id: 'in_addition', customer: 'cus_1', subscription: null,
          metadata: { tenant_id: tenantId, purpose: 'musubo_addition', addition_id: 'addition-one' },
          amount_due: 6700, amount_paid: paid, currency: 'jpy',
          status: paid ? 'paid' : 'open' } } },
    });
  };
  expect(await send('evt_add_failed', 'invoice.payment_failed', 0)).toBe('completed');
  expect((await getMusuboTenantBilling(fixture.db, tenantId))?.status).toBe('active');
  expect(fixture.raw.prepare('SELECT status FROM musubo_pending_additions WHERE id=?')
    .get('addition-one')).toEqual({ status: 'awaiting_payment' });
  expect(await send('evt_add_paid', 'invoice.paid', 6700)).toBe('completed');
  expect(fixture.raw.prepare('SELECT status FROM musubo_pending_additions WHERE id=?')
    .get('addition-one')).toEqual({ status: 'paid' });
  expect((await getMusuboTenantBilling(fixture.db, tenantId))?.status).toBe('active');
});

it('keeps the paid core invoice separate from options and restores access after payment', async () => {
  const fixture = createTestD1();
  const tenantId = DEFAULT_TENANT_ID;
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,first_line_activated_at,
      first_charge_date,core_subscription_id,options_subscription_id,created_at,updated_at)
    VALUES (?,'{}','month','trialing','2026-11-09','2026-12-09','sub_core','sub_options','2026-11-09','2026-11-09')`)
    .run(tenantId);
  const billing = (await getMusuboTenantBilling(fixture.db, tenantId))!;
  const event = (id: string, type: string, subscription: string, paid: number) => ({
    id, type, created: Date.parse('2026-12-09T01:00:00Z') / 1000,
    data: { object: { id: subscription === 'sub_core' ? 'in_core' : 'in_options', customer: 'cus_1', subscription,
      amount_due: 5900, amount_paid: paid, status: paid ? 'paid' : 'open', currency: 'jpy' } },
  });
  const process = async (value: ReturnType<typeof event>) => {
    fixture.raw.prepare(`INSERT INTO billing_events (id,type,tenant_id,summary)
      VALUES (?,?,?,'pending')`).run(value.id, value.type, tenantId);
    return processMusuboBillingEvent({ db: fixture.db, tenantId, customerId: 'cus_1',
      billing, event: value });
  };
  expect(await process(event('evt_option', 'invoice.payment_failed', 'sub_options', 0))).toBe('completed');
  expect((await getMusuboTenantBilling(fixture.db, tenantId))?.status).toBe('trialing');
  expect(await process(event('evt_core_failed', 'invoice.payment_failed', 'sub_core', 0))).toBe('completed');
  expect((await getMusuboTenantBilling(fixture.db, tenantId))?.status).toBe('past_due');
  expect(await process(event('evt_core_paid', 'invoice.paid', 'sub_core', 5900))).toBe('completed');
  expect((await getMusuboTenantBilling(fixture.db, tenantId))?.status).toBe('active');
  expect(await process(event('evt_core_late_failure', 'invoice.payment_failed', 'sub_core', 0))).toBe('completed');
  expect((await getMusuboTenantBilling(fixture.db, tenantId))?.status).toBe('active');
  expect(fixture.raw.prepare('SELECT status FROM billing_invoices WHERE id=?').get('in_core'))
    .toEqual({ status: 'paid' });
  expect(fixture.raw.prepare('SELECT status FROM billing_invoices WHERE id=?').get('in_options'))
    .toEqual({ status: 'open' });
});

it('does not start seven-day grace without a signed failure timestamp', async () => {
  const fixture = createTestD1();
  const tenantId = DEFAULT_TENANT_ID;
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,first_line_activated_at,
      first_charge_date,core_subscription_id,created_at,updated_at)
    VALUES (?,'{}','month','active','2026-11-09','2026-12-09','sub_core','2026-11-09','2026-11-09')`)
    .run(tenantId);
  fixture.raw.prepare(`INSERT INTO billing_events (id,type,tenant_id,summary)
    VALUES ('evt_bad','invoice.payment_failed',?,'pending')`).run(tenantId);
  expect(await processMusuboBillingEvent({ db: fixture.db, tenantId, customerId: 'cus_1',
    billing: (await getMusuboTenantBilling(fixture.db, tenantId))!,
    event: { id: 'evt_bad', type: 'invoice.payment_failed',
      data: { object: { id: 'in_bad', customer: 'cus_1', subscription: 'sub_core',
        amount_due: 5900, amount_paid: 0 } } },
  })).toBe('retry');
  expect((await getMusuboTenantBilling(fixture.db, tenantId))?.status).toBe('active');
});

it('records next renewal dates only from paid subscription cycles and never moves them backwards', async () => {
  const fixture = createTestD1();
  const tenantId = DEFAULT_TENANT_ID;
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,first_line_activated_at,
      first_charge_date,core_subscription_id,options_subscription_id,created_at,updated_at)
    VALUES (?,'{}','year','active','2026-11-09','2026-12-09','sub_core','sub_options','2026-11-09','2026-11-09')`)
    .run(tenantId);
  const billing = (await getMusuboTenantBilling(fixture.db, tenantId))!;
  const paid = async (id: string, subscription: string, next: string, reason = 'subscription_cycle') => {
    fixture.raw.prepare(`INSERT INTO billing_events (id,type,tenant_id,summary)
      VALUES (?,'invoice.paid',?,'pending')`).run(id, tenantId);
    return processMusuboBillingEvent({ db: fixture.db, tenantId, customerId: 'cus_1', billing,
      event: { id, type: 'invoice.paid', created: Date.parse('2026-12-09T01:00:00Z') / 1000,
        data: { object: { id: `in_${id}`, customer: 'cus_1', subscription,
          amount_due: 100, amount_paid: 100, currency: 'jpy', billing_reason: reason,
          period_end: Date.parse(next) / 1000 } } },
    });
  };
  await paid('annual', 'sub_core', '2027-12-08T15:00:00Z');
  await paid('monthly', 'sub_options', '2027-01-08T15:00:00Z');
  await paid('late', 'sub_core', '2027-01-08T15:00:00Z');
  await paid('proration', 'sub_options', '2027-03-08T15:00:00Z', 'subscription_update');
  const updated = await getMusuboTenantBilling(fixture.db, tenantId);
  expect(updated?.next_annual_renewal_at).toBe('2027-12-09');
  expect(updated?.next_monthly_charge_at).toBe('2027-01-09');
});
