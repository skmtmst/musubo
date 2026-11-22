import { expect, test } from 'vitest';
import { gapFixture } from '../test-utils/gap1.js';
import { deleteExpiredPurgedPaymentIdentifierHashes, findPurgedPaymentIdentifierHash, hashPurgedPaymentIdentifier, purgedPaymentIdentifierExpiry, purgedPaymentIdentifierKeyVersion, storePurgedPaymentIdentifierHash } from './tenant-purge-payment-hashes.js';

test('identifier hashes use a secret and retain no original ID', async () => {
  const f=gapFixture();
  expect(await hashPurgedPaymentIdentifier(undefined,'customer','cus_private')).toBeNull();
  const digest=await hashPurgedPaymentIdentifier('test-secret','customer','cus_private');
  const keyVersion=(await purgedPaymentIdentifierKeyVersion('test-secret'))!;
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(digest).not.toEqual(await hashPurgedPaymentIdentifier('other-secret','customer','cus_private'));
  expect(digest).not.toEqual(await hashPurgedPaymentIdentifier('test-secret','subscription','cus_private'));
  const now='2027-01-01T00:00:00.000Z', expiresAt='2037-01-01T00:00:00.000Z';
  f.raw.exec("INSERT INTO stripe_events(id,stripe_event_id,event_type,review_reason,processed_at,identifier_expires_at) VALUES('ordinary','evt_ordinary','invoice.paid','purged_tenant','2026-01-01','2026-01-01')");
  await storePurgedPaymentIdentifierHash(f.db,{tenantId:'t',kind:'customer',digest:digest!,keyVersion,expiresAt,now});
  expect(await findPurgedPaymentIdentifierHash(f.db,'customer',digest!,keyVersion,now)).toEqual(['t']);
  expect(await findPurgedPaymentIdentifierHash(f.db,'customer',digest!,(await purgedPaymentIdentifierKeyVersion('other-secret'))!,now)).toEqual([]);
  const row=f.raw.prepare("SELECT * FROM stripe_events WHERE review_reason='identifier_hash'").get();
  expect(JSON.stringify(row)).not.toContain('cus_private');
  expect(await deleteExpiredPurgedPaymentIdentifierHashes(f.db,'2036-12-31T23:59:59.999Z')).toBe(0);
  expect(await deleteExpiredPurgedPaymentIdentifierHashes(f.db,expiresAt)).toBe(1);
  expect(f.raw.prepare("SELECT id FROM stripe_events WHERE id='ordinary'").get()).toEqual({id:'ordinary'});
  expect(await findPurgedPaymentIdentifierHash(f.db,'customer',digest!,keyVersion,expiresAt)).toEqual([]);
});

test('retention expires ten years after one year and three months plus one day', () => {
  expect(purgedPaymentIdentifierExpiry('2026-01-15','2027-01-01')).toBe('2037-04-16T00:00:00.000Z');
  expect(purgedPaymentIdentifierExpiry(null,'2026-01-31')).toBe('2037-05-01T00:00:00.000Z');
  expect(() => purgedPaymentIdentifierExpiry('2026-02-30','2027-01-01')).toThrow('invalid_payment_retention_date');
  expect(() => purgedPaymentIdentifierExpiry('2026-01-15T20:00:00Z','2027-01-01')).toThrow('invalid_payment_retention_date');
});
