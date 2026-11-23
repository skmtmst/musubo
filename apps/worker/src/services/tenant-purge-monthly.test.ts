import { expect, test } from 'vitest';
import { monthlyContract, monthlyFixture } from '../test-utils/monthly-ledger.js';
import { anonymizeMonthlyContract } from './tenant-purge-tombstones.js';

test('monthly contract is anonymized only during purge and remains idempotent', async () => {
  const f=monthlyFixture();
  await monthlyContract(f);
  f.raw.exec("UPDATE booking_monthly_contracts SET customer_id='cus_private',payment_method_id='pm_private',payment_method_version=1,version=version+1 WHERE id='contract'");
  f.raw.exec("UPDATE line_accounts SET data_purged_at='2027-01-01' WHERE id='a'");
  expect(await anonymizeMonthlyContract(f.db,'t','contract','2027-01-01T00:00:00Z')).toBe(false);
  expect(f.raw.prepare("SELECT customer_id FROM booking_monthly_contracts WHERE id='contract'").get()).toEqual({customer_id:'cus_private'});
  f.raw.exec("UPDATE tenants SET purge_started_at='2027-01-01' WHERE id='t'");
  await anonymizeMonthlyContract(f.db,'t','contract','2027-01-01T00:00:00Z');
  await anonymizeMonthlyContract(f.db,'t','contract','2027-01-01T00:00:00Z');
  expect(f.raw.prepare("SELECT name,customer_id,payment_method_id,state,amount FROM booking_monthly_contracts WHERE id='contract'").get())
    .toEqual({name:'削除済み',customer_id:null,payment_method_id:null,state:'expired',amount:6000});
});


test('purge cannot finish if a contract update is ignored', async () => {
  const { processTenantDataPurge } = await import('./tenant-data-purge.js');
  const f=monthlyFixture();
  await monthlyContract(f);
  f.raw.exec(`UPDATE tenants SET plan_status='canceled',retention_anchor_at='2026-01-01' WHERE id='t';
    CREATE TRIGGER ignore_monthly_anonymization BEFORE UPDATE ON booking_monthly_contracts BEGIN SELECT RAISE(IGNORE); END;`);
  const result=await processTenantDataPurge({DB:f.db},{now:'2027-05-01T00:00:00Z'});
  expect(result.completed).toBe(0);
  expect(f.raw.prepare("SELECT data_purged_at FROM tenants WHERE id='t'").get()).toEqual({data_purged_at:null});
});
