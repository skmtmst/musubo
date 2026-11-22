import { expect, test } from 'vitest';
import { gapFixture } from '../test-utils/gap1.js';
import { archiveAndResetTenantBilling, deleteExpiredBillingHistory } from './tenant-purge-billing-history.js';

test('archives permitted contract terms and clears identifiers in one batch', async () => {
  const f=gapFixture();
  f.raw.exec("ALTER TABLE billing_events ADD COLUMN retained_until TEXT");
  f.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,core_subscription_id,created_at,updated_at)
    VALUES ('t',?,'year','ended','sub_private','2026-01-01','2026-01-01')`)
    .run(JSON.stringify({internalName:'private name',schedule:{firstLineYen:1000},trialPeriod:{unit:'days',value:30}}));
  f.raw.exec("UPDATE tenants SET purge_started_at='2026-11-22' WHERE id='t'");
  await archiveAndResetTenantBilling(f.db,'t','2026-11-22T00:00:00Z','2038-03-01T00:00:00Z');
  await archiveAndResetTenantBilling(f.db,'t','2026-11-22T00:00:00Z','2038-03-01T00:00:00Z');
  const events=f.raw.prepare("SELECT summary,retained_until FROM billing_events WHERE type='internal.purge_billing'").all() as {summary:string;retained_until:string}[];
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0].summary).schedule.firstLineYen).toBe(1000);
  expect(events[0].summary).not.toContain('private');
  expect(events[0].retained_until).toBe('2038-03-01T00:00:00Z');
  expect(f.raw.prepare("SELECT core_subscription_id,pricing_snapshot_json,status FROM musubo_tenant_billing WHERE tenant_id='t'").get()).toEqual({core_subscription_id:null,pricing_snapshot_json:'{}',status:'ended'});
});

test('failed reset rolls back the archive', async () => {
  const f=gapFixture();
  f.raw.exec("ALTER TABLE billing_events ADD COLUMN retained_until TEXT");
  f.raw.exec(`INSERT INTO musubo_tenant_billing(tenant_id,pricing_snapshot_json,billing_interval,status,created_at,updated_at)
    VALUES ('t','{}','month','ended','2026-01-01','2026-01-01');
    UPDATE tenants SET purge_started_at='2026-11-22' WHERE id='t';
    CREATE TRIGGER reject_billing_reset BEFORE UPDATE ON musubo_tenant_billing BEGIN SELECT RAISE(ABORT,'failure'); END;`);
  await expect(archiveAndResetTenantBilling(f.db,'t','2026-11-22T00:00:00Z','2038-03-01T00:00:00Z')).rejects.toThrow();
  expect(f.raw.prepare("SELECT id FROM billing_events WHERE type='internal.purge_billing'").all()).toHaveLength(0);
});

test('expired history is deleted without deleting ordinary billing events', async () => {
  const f=gapFixture();
  f.raw.exec("ALTER TABLE billing_events ADD COLUMN retained_until TEXT");
  f.raw.exec(`INSERT INTO billing_events(id,type,tenant_id,summary,retained_until) VALUES
    ('expired','internal.purge_billing','t','{}','2030-01-01T00:00:00Z'),
    ('current','internal.purge_billing','t','{}','2031-01-01T00:00:00Z'),
    ('ordinary','invoice.paid','t','ok','2029-01-01T00:00:00Z')`);
  expect(await deleteExpiredBillingHistory(f.db,'2030-01-01T00:00:00Z')).toBe(1);
  expect(f.raw.prepare('SELECT id FROM billing_events ORDER BY id').all()).toEqual([{id:'current'},{id:'ordinary'}]);
});
