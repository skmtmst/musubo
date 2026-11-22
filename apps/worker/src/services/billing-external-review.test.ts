import { expect, test } from 'vitest';
import { gapFixture } from '../test-utils/gap1.js';
import { observeUncertainBillingEffects } from './billing-external-review.js';
import { publicSecurityAlert, type SecurityAlertRow } from './security-monitor-store.js';

test('expired uncertain billing effects become visible without duplicate alerts', async () => {
  const f=gapFixture();
  f.raw.exec(`INSERT INTO billing_events(id,type,tenant_id,summary,lease_until,external_effect_pending) VALUES
    ('evt_stale','invoice.paid','t','pending','2026-01-01T00:00:00Z',1),
    ('evt_live','invoice.paid','t','pending','2030-01-01T00:00:00Z',1),
    ('evt_done','invoice.paid','t','completed','2026-01-01T00:00:00Z',0)`);
  expect(await observeUncertainBillingEffects(f.db,'2027-01-01T00:00:00Z')).toBe(1);
  expect(await observeUncertainBillingEffects(f.db,'2027-01-01T00:00:00Z')).toBe(0);
  expect(f.raw.prepare("SELECT summary,external_effect_pending FROM billing_events WHERE id='evt_stale'").get()).toEqual({summary:'external_review',external_effect_pending:0});
  expect(f.raw.prepare("SELECT external_effect_pending FROM billing_events WHERE id='evt_live'").get()).toEqual({external_effect_pending:1});
  const rows=f.raw.prepare('SELECT * FROM security_alerts').all() as SecurityAlertRow[];
  expect(rows).toHaveLength(1);
  expect(publicSecurityAlert(rows[0]).summary).toBe('決済操作の結果確認が必要');
});
