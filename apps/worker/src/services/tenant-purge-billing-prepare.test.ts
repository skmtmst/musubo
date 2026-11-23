import { expect, test } from 'vitest';
import { gapFixture } from '../test-utils/gap1.js';
import { preparePurgedTenantBilling } from './tenant-purge-billing-prepare.js';
import { findPurgedPaymentIdentifierHash, hashPurgedPaymentIdentifier, purgedPaymentIdentifierKeyVersion } from './tenant-purge-payment-hashes.js';

test('requires a secret before resetting a billing row with Stripe identifiers', async () => {
  const f=gapFixture();
  f.raw.exec(`UPDATE tenants SET purge_started_at='2027-01-01',stripe_customer_id='cus_private' WHERE id='t';
    INSERT INTO musubo_tenant_billing(tenant_id,pricing_snapshot_json,billing_interval,status,core_subscription_id,created_at,updated_at)
      VALUES('t','{}','month','ended','sub_private','2026-01-01','2026-01-01');`);
  await expect(preparePurgedTenantBilling(f.db,'t','2027-01-01T00:00:00Z',undefined)).rejects.toThrow('purge_payment_hash_key_missing');
  expect(f.raw.prepare("SELECT core_subscription_id FROM musubo_tenant_billing WHERE tenant_id='t'").get()).toEqual({core_subscription_id:'sub_private'});
  await preparePurgedTenantBilling(f.db,'t','2027-01-01T00:00:00Z','test-secret');
  const hash=(await hashPurgedPaymentIdentifier('test-secret','customer','cus_private'))!;
  const version=(await purgedPaymentIdentifierKeyVersion('test-secret'))!;
  expect(await findPurgedPaymentIdentifierHash(f.db,'customer',hash,version,'2027-01-01T00:00:00Z')).toEqual(['t']);
  expect(f.raw.prepare("SELECT core_subscription_id FROM musubo_tenant_billing WHERE tenant_id='t'").get()).toEqual({core_subscription_id:null});
  expect(f.raw.prepare("SELECT stripe_customer_id FROM tenants WHERE id='t'").get()).toEqual({stripe_customer_id:null});
  const saved=JSON.stringify(f.raw.prepare("SELECT * FROM stripe_events WHERE review_reason='identifier_hash'").all());
  expect(saved).not.toContain('cus_private'); expect(saved).not.toContain('sub_private');
});

test('uses the most recent JST payment date across invoices and bookings', async () => {
  const f=gapFixture();
  f.raw.exec(`UPDATE tenants SET purge_started_at='2027-04-01',stripe_customer_id='cus_private' WHERE id='t';
    INSERT INTO billing_invoices(id,tenant_id,amount_paid,paid_at,synced_at,created_at) VALUES('inv','t',100,'2027-02-02T00:00:00Z','2027-02-02','2027-02-02');
    INSERT INTO booking_payments(id,line_account_id,amount,provider,idempotency_key,paid_at,created_at,updated_at)
      VALUES('pay','a',100,'test','key','2027-03-01T16:00:00Z','2027-03-01','2027-03-01');`);
  await preparePurgedTenantBilling(f.db,'t','2027-04-01T00:00:00Z','test-secret');
  expect(f.raw.prepare("SELECT identifier_expires_at FROM stripe_events WHERE review_reason='identifier_hash'").get())
    .toEqual({identifier_expires_at:'2038-06-03T00:00:00.000Z'});
});

test('a missing HMAC key stops purge and creates an operational review alert', async () => {
  const { processTenantDataPurge }=await import('./tenant-data-purge.js');
  const f=gapFixture();
  f.raw.exec("UPDATE tenants SET plan_status='canceled',purge_requested_at='2025-01-01',stripe_customer_id='cus_private' WHERE id='t'");
  const result=await processTenantDataPurge({DB:f.db},{now:'2027-01-01T00:00:00Z'});
  expect(result.failedTenants).toBe(1);
  expect(f.raw.prepare("SELECT stripe_customer_id,data_purged_at FROM tenants WHERE id='t'").get()).toEqual({stripe_customer_id:'cus_private',data_purged_at:null});
  expect(f.raw.prepare("SELECT rule_key FROM security_alerts WHERE tenant_id='t'").get()).toEqual({rule_key:'stripe_hash_key_review'});
});


test('missing hash key is checked before marking tenant purge started', async () => {
  const { processTenantDataPurge } = await import('./tenant-data-purge.js');
  const f=gapFixture();
  f.raw.exec("UPDATE tenants SET plan_status='canceled',purge_requested_at='2026-01-01',stripe_customer_id='cus_private' WHERE id='t'");
  const result=await processTenantDataPurge({DB:f.db},{now:'2027-05-01T00:00:00Z'});
  expect(result.completed).toBe(0);
  expect(f.raw.prepare("SELECT purge_started_at FROM tenants WHERE id='t'").get()).toEqual({purge_started_at:null});
});


test('claim rechecks key requirement atomically if an identifier appears after preflight', async () => {
  const { claimTenantPurge } = await import('./tenant-purge-tombstones.js');
  const f=gapFixture();
  f.raw.exec("UPDATE tenants SET plan_status='canceled',purge_requested_at='2026-01-01',stripe_customer_id='cus_new' WHERE id='t'");
  expect(await claimTenantPurge(f.db,'t','2027-05-01T00:00:00Z',false)).toBe(false);
  expect(f.raw.prepare("SELECT purge_started_at FROM tenants WHERE id='t'").get()).toEqual({purge_started_at:null});
});
