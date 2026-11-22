import { Miniflare } from 'miniflare';
import { expect, test } from 'vitest';
import { billingEventLeaseFence, prepareBillingEventLeaseCompletion } from './tenant-purge-tombstones.js';

test('D1 rolls back tenant updates when billing lease expires before completion', async () => {
  const mf=new Miniflare({modules:true,script:'export default { fetch() { return new Response("ok") } }',d1Databases:['DB']});
  try {
    const native=await mf.getD1Database('DB');
    const db=native as unknown as D1Database;
    await native.batch([
      native.prepare('CREATE TABLE tenants(id TEXT PRIMARY KEY,name TEXT,purge_started_at TEXT,data_purged_at TEXT)'),
      native.prepare('CREATE TABLE billing_events(id TEXT PRIMARY KEY,tenant_id TEXT,summary TEXT,lease_token TEXT,lease_until TEXT)'),
      native.prepare("INSERT INTO tenants(id,name) VALUES('t','original')"),
      native.prepare("INSERT INTO billing_events VALUES('evt','t','pending','token','2999-01-01T00:00:00Z')"),
    ]);
    const fence=billingEventLeaseFence('evt','t','token');
    await expect(native.batch([
      native.prepare(`UPDATE tenants SET name='changed' WHERE id='t' AND ${fence.sql}`).bind(...fence.values),
      native.prepare("UPDATE billing_events SET lease_until='2000-01-01T00:00:00Z' WHERE id='evt'"),
      ...prepareBillingEventLeaseCompletion(db,'evt','token','completed'),
    ])).rejects.toThrow();
    expect(await native.prepare("SELECT name FROM tenants WHERE id='t'").first()).toEqual({name:'original'});
    expect(await native.prepare("SELECT summary FROM billing_events WHERE id='evt'").first()).toEqual({summary:'pending'});
    await native.batch([
      native.prepare(`UPDATE tenants SET name='changed' WHERE id='t' AND ${fence.sql}`).bind(...fence.values),
      ...prepareBillingEventLeaseCompletion(db,'evt','token','completed'),
    ]);
    expect(await native.prepare("SELECT name FROM tenants WHERE id='t'").first()).toEqual({name:'changed'});
  } finally { await mf.dispose(); }
},30000);
