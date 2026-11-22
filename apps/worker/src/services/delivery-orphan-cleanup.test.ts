import { describe, expect, it } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { cleanupDeliveryOrphans } from './delivery-orphan-cleanup.js';

function fixture() {
  const f = createTestD1({ foreignKeys: true });
  f.raw.exec(`INSERT INTO rt_delivery_orders(id,account_id,store_id,service,external_order_id,order_number,received_at,created_at,updated_at)
    VALUES('parent','account','store','line','external','1',1,1,1);
    INSERT INTO rt_delivery_order_items(id,order_id,name,note,created_at) VALUES
      ('orphan','missing','secret name','secret note',1),('linked','parent','keep name','keep note',1);`);
  return f;
}
describe('delivery orphan cleanup', () => {
  it('removes only orphan items and audits the count once across retries', async () => {
    const f = fixture();
    expect(await cleanupDeliveryOrphans(f.db)).toBe(1);
    expect(await cleanupDeliveryOrphans(f.db)).toBe(0);
    expect(f.raw.prepare('SELECT id FROM rt_delivery_order_items').all()).toEqual([{ id:'linked' }]);
    const audits = f.raw.prepare("SELECT after_json FROM audit_events WHERE action='privacy.delivery_orphans.cleaned'").all();
    expect(audits).toEqual([{ after_json:'{"deletedRows":1}' }]);
    expect(JSON.stringify(audits)).not.toMatch(/secret|orphan|missing/);
  });
  it('rolls back deletion when audit fails and succeeds on retry', async () => {
    const f = fixture();
    f.raw.exec("CREATE TRIGGER fail_orphan_audit BEFORE INSERT ON audit_events WHEN NEW.action='privacy.delivery_orphans.cleaned' BEGIN SELECT RAISE(ABORT,'fixture'); END");
    await expect(cleanupDeliveryOrphans(f.db)).rejects.toThrow();
    expect(f.raw.prepare("SELECT id FROM rt_delivery_order_items WHERE id='orphan'").get()).toBeTruthy();
    f.raw.exec('DROP TRIGGER fail_orphan_audit');
    expect(await cleanupDeliveryOrphans(f.db)).toBe(1);
    expect(await cleanupDeliveryOrphans(f.db)).toBe(0);
  });
});
