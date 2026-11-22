import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { securityAlerts } from './security-alerts.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { observeSecurityAlert } from '../services/security-monitor-store.js';
import { deferPurgedBillingEvent } from '../services/tenant-purge-tombstones.js';

const stripeRead = vi.hoisted(() => vi.fn());
vi.mock('../services/stripe-api.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/stripe-api.js')>()), stripeRequest: stripeRead,
}));
let store: ReturnType<typeof createTestD1>;
const member = { id: 'admin-a', role: 'admin', name: 'A', readOnly: false, tenantId: 'tenant-a' } satisfies AuthenticatedStaff;
function app(staff: AuthenticatedStaff | null = member, impersonation = false) {
  const a = new Hono<Env>();
  a.use('*', async (c, next) => {
    if (staff) c.set('staff', { ...staff });
    if (impersonation) c.set('impersonation', { tenantId: 'tenant-a' } as Env['Variables']['impersonation'] & {});
    await next();
  });
  a.route('/', securityAlerts);
  return a;
}
function bindings() { return { DB: store.db } as Env['Bindings']; }
async function request(path: string, staff: AuthenticatedStaff | null = member, body?: unknown, impersonation = false) {
  return app(staff, impersonation).request(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined, bindings());
}
async function seedAlert(tenant: string, account: string | null, key = 'key_rotations') {
  await observeSecurityAlert(store.db, { tenant_id: tenant, line_account_id: account, rule_key: key as 'key_rotations', count: 1 }, 1, new Date().toISOString());
  return store.raw.prepare('SELECT id FROM security_alerts WHERE tenant_id = ? AND line_account_id IS ?').get(tenant, account) as { id: string };
}

beforeEach(() => {
  store = createTestD1();
  store.raw.exec(`INSERT INTO tenants (id, name) VALUES ('tenant-a','A'),('tenant-b','B');
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
      VALUES ('a1','c1','A1','test','test','tenant-a'),('a2','c2','A2','test','test','tenant-a'),('b','cb','B','test','test','tenant-b');
    INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope)
      VALUES ('admin-a','A','admin','test-a','tenant-a','accounts'),('platform','P','owner','test-p','tenant-a','all');
    INSERT INTO staff_account_scopes (staff_id,line_account_id,created_at) VALUES ('admin-a','a1','2026-10-16T00:00:00');
    INSERT INTO platform_admins (staff_id, is_active, activation_state) VALUES ('platform',1,'active')`);
});
afterEach(() => { stripeRead.mockReset(); store.raw.close(); });

describe('security alert HTTP permissions and operator actions', () => {
  it('platform operators can inspect purged-tenant Stripe amount without exposing it to tenant staff', async () => {
    store.raw.exec("UPDATE tenants SET purge_started_at='2027-01-01' WHERE id='tenant-b'; INSERT INTO billing_events(id,type,tenant_id,summary) VALUES('evt_review','invoice.paid','tenant-b','pending')");
    await deferPurgedBillingEvent(store.db,{tenantId:'tenant-b',eventId:'evt_review',eventType:'invoice.paid',amount:3000,currency:'jpy',now:'2027-01-01T00:00:00.000Z'});
    for(const [eventId,eventType,amount,currency] of [['evt_refund','charge.refunded',1000,'jpy'],['evt_missing','invoice.payment_failed',null,null],['evt_usd','checkout.session.completed',1234,'usd']] as const){
      store.raw.prepare("INSERT INTO billing_events(id,type,tenant_id,summary) VALUES(?,?,'tenant-b','pending')").run(eventId,eventType);
      await deferPurgedBillingEvent(store.db,{tenantId:'tenant-b',eventId,eventType,amount,currency,now:'2027-01-01T00:00:00.000Z'});
    }
    const own = await request('/api/operations/security-alerts?account_id=a1');
    const ownText=await own.text();
    expect(ownText).not.toContain('evt_review');
    expect(ownText).not.toContain('3,000');
    const platform = await request('/api/ops/security-alerts', {...member,id:'platform',role:'owner'});
    expect(platform.status).toBe(200);
    const result=await platform.json() as {data:{items:Array<{summary:string}>}};
    expect(result.data.items.map(item=>item.summary)).toEqual(expect.arrayContaining([
      '¥3,000・支払われた額・削除済み統括のStripe通知',
      '¥1,000・返金の累計・削除済み統括のStripe通知',
      '金額不明・請求した額（未払いを含む）・削除済み統括のStripe通知',
      'USD 1,234（最小単位）・申込の合計額・削除済み統括のStripe通知',
    ]));
  });
  it('only returns the permitted account, never tenant-wide or hidden platform records', async () => {
    const first = await seedAlert('tenant-a', 'a1');
    await seedAlert('tenant-a', 'a2');
    await seedAlert('tenant-b', 'b');
    await seedAlert('tenant-a', null, 'impersonation');
    const response = await request('/api/operations/security-alerts?account_id=a1');
    expect(response.status).toBe(200);
    const result = await response.json() as { data: { items: Array<{ id: string }>; monitor: { status: string } } };
    expect(result.data.items.map(row => row.id)).toEqual([first.id]);
    expect(result.data.monitor.status).toBe('unknown');
    const later = await request('/api/operations/security-alerts?account_id=a1&offset=1');
    expect(await later.json()).toMatchObject({ data: { items: [], total: 1, offset: 1 } });
    expect(JSON.stringify(result)).not.toContain('tenant-b');
    for (const account of ['a2', 'b', 'missing', '']) expect((await request(`/api/operations/security-alerts?account_id=${account}`)).status).toBe(403);
  });

  it('denies anonymous/staff and unregistered owners at the platform boundary', async () => {
    for (const staff of [null, { ...member, role: 'staff' as const }]) {
      expect((await request('/api/operations/security-alerts?account_id=a1', staff)).status).toBe(403);
    }
    expect((await request('/api/ops/security-alerts', { ...member, role: 'owner' })).status).toBe(403);
    const hidden = await seedAlert('tenant-a', null, 'impersonation');
    for (const action of ['acknowledge', 'resolve']) {
      const path = `/api/ops/security-alerts/${hidden.id}/${action}`;
      for (const staff of [null, member, { ...member, role: 'owner' as const }, { ...member, id: 'platform', role: 'owner' as const, readOnly: true }]) {
        expect((await request(path, staff, { expectedVersion: 1 })).status).toBe(403);
      }
      expect((await request(path, { ...member, id: 'platform', role: 'owner' }, { expectedVersion: 1 }, true)).status).toBe(403);
    }
    const response = await request('/api/ops/security-alerts', { ...member, id: 'platform', role: 'owner' });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('代理ログイン');
    expect((await request(`/api/ops/security-alerts/${hidden.id}/acknowledge`, { ...member, id: 'platform', role: 'owner' }, { expectedVersion: 1 })).status).toBe(200);
  });

  it('read-only may read, but read-only and impersonated sessions cannot acknowledge or resolve', async () => {
    const alert = await seedAlert('tenant-a', 'a1');
    expect((await request('/api/operations/security-alerts?account_id=a1', { ...member, readOnly: true })).status).toBe(200);
    for (const verb of ['acknowledge', 'resolve']) {
      const path = `/api/operations/security-alerts/${alert.id}/${verb}?account_id=a1`;
      expect((await request(path, { ...member, readOnly: true }, { expectedVersion: 1 })).status).toBe(403);
      expect((await request(path, member, { expectedVersion: 1 }, true)).status).toBe(403);
    }
    expect(store.raw.prepare('SELECT status FROM security_alerts').get()).toEqual({ status: 'open' });
  });

  it('checks resource scope and current version and records successful human decisions', async () => {
    const own = await seedAlert('tenant-a', 'a1');
    const other = await seedAlert('tenant-a', 'a2');
    const base = '/api/operations/security-alerts/';
    expect((await request(`${base}${other.id}/resolve?account_id=a1`, member, { expectedVersion: 1 })).status).toBe(404);
    expect((await request(`${base}${own.id}/acknowledge?account_id=a1`, member, { expectedVersion: 1 })).status).toBe(200);
    expect((await request(`${base}${own.id}/resolve?account_id=a1`, member, { expectedVersion: 1 })).status).toBe(409);
    expect((await request(`${base}${own.id}/resolve?account_id=a1`, member, { expectedVersion: 2 })).status).toBe(200);
    expect((await request('/api/operations/security-alerts?account_id=a1')).status).toBe(200);
    expect(store.raw.prepare("SELECT action FROM audit_events WHERE action GLOB 'security.alert.*' ORDER BY action").all())
      .toEqual([{ action: 'security.alert.acknowledged' }, { action: 'security.alert.resolved' }]);
  });

  it('unapplied schema returns unavailable rather than an empty healthy result', async () => {
    store.raw.exec('DROP TABLE security_alerts');
    const response = await request('/api/operations/security-alerts?account_id=a1');
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('SECURITY_MONITOR_UNAVAILABLE');
  });
});


describe('staging-only manual security sweep', () => {
  const path = '/api/ops/security-alerts/run-once';
  const operator = { ...member, id: 'platform', role: 'owner' as const };
  it('denies production/unknown environments, nonoperators, read-only and impersonated sessions before counting', async () => {
    for (const DEPLOY_ENV of ['production', 'test', '', undefined]) {
      const response = await app(operator).request(path, { method: 'POST' }, { ...bindings(), DEPLOY_ENV });
      expect(response.status).toBe(404);
    }
    for (const staff of [null, member, { ...member, role: 'owner' as const }, { ...operator, readOnly: true }]) {
      expect((await app(staff).request(path, { method: 'POST' }, { ...bindings(), DEPLOY_ENV: 'staging' })).status).toBe(403);
    }
    expect((await app(operator, true).request(path, { method: 'POST' }, { ...bindings(), DEPLOY_ENV: 'staging' })).status).toBe(403);
    expect(store.raw.prepare('SELECT count(*) AS n FROM security_monitor_state').get()).toEqual({ n: 0 });
  });
  it('counts and notifies once without invoking deliveries, respects the lease, and reports schema failure', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetcher);
    try {
      store.raw.exec(`INSERT INTO audit_events(id,tenant_id,category,action,result)
        VALUES ('fixture-key-event','tenant-a','auth','auth.api_key.rotate','success')`);
      const env = { ...bindings(), DEPLOY_ENV: 'staging', SLACK_BOT_TOKEN: 'fixture', SLACK_ERROR_CHANNEL_ID: 'CERROR' };
      const response = await app(operator).request(path, { method: 'POST' }, env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, data: { monitor: { status: 'running' } } });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(String(fetcher.mock.calls[0]?.[0])).toContain('slack.com/api/chat.postMessage');
      expect((await app(operator).request(path, { method: 'POST' }, env)).status).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(1);
      store.raw.exec('DROP TABLE security_monitor_state');
      expect((await app(operator).request(path, { method: 'POST' }, env)).status).toBe(503);
    } finally { vi.unstubAllGlobals(); }
  });
});


describe('billing review retry', () => {
  it('二人が同時に再処理すると一人だけが処理し、成功監査は一件', async () => {
    const {observeUncertainBillingEffects}=await import('../services/billing-external-review.js');
    store.raw.exec(`UPDATE tenants SET stripe_customer_id='cus_concurrent' WHERE id='tenant-a';
      INSERT INTO billing_events(id,type,tenant_id,summary,lease_until,external_effect_pending)
      VALUES('evt_concurrent','fixture.ignored','tenant-a','pending','2020-01-01',1)`);
    await observeUncertainBillingEffects(store.db,'2026-10-17T00:00:00Z');
    const alert=store.raw.prepare("SELECT id,version FROM security_alerts WHERE rule_key='stripe_external_effect_review'").get() as {id:string;version:number};
    let release!: () => void;
    let started!: () => void;
    const wait = new Promise<void>(resolve => {release=resolve});
    const entered = new Promise<void>(resolve => {started=resolve});
    stripeRead.mockImplementationOnce(async () => {started(); await wait; return {id:'evt_concurrent',type:'fixture.ignored',data:{object:{customer:'cus_concurrent'}}}});
    store.raw.exec("INSERT INTO staff_members(id,name,role,api_key,tenant_id,account_scope) VALUES('platform-2','P2','owner','test-p2','tenant-a','all'); INSERT INTO platform_admins(staff_id,is_active,activation_state) VALUES('platform-2',1,'active')");
    const operator={...member,id:'platform',role:'owner' as const};
    const run=(id: string) => app({...operator,id}).request(`/api/ops/security-alerts/${alert.id}/retry-billing`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedVersion:alert.version}),
    },{...bindings(),STRIPE_SECRET_KEY:'sk_test',STRIPE_BILLING_WEBHOOK_SECRET:'whsec_test'});
    const first=run('platform');
    await entered;
    const review=await app({...operator,id:'platform-2'}).request(`/api/ops/security-alerts/${alert.id}/acknowledge`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedVersion:alert.version})},bindings());
    expect(review.status).toBe(409);
    const second=await run('platform-2');
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({error:'ほかの人が処理しています',code:'BILLING_RETRY_BUSY'});
    release();
    expect((await first).status).toBe(200);
    expect(store.raw.prepare("SELECT count(*) AS n FROM audit_events WHERE action='security.alert.retry_billing'").get()).toEqual({n:1});
    expect(stripeRead).toHaveBeenCalledTimes(1);
  });
  it('失敗した処理は借受を返し、次の人が再処理できる', async () => {
    const {observeUncertainBillingEffects}=await import('../services/billing-external-review.js');
    store.raw.exec(`UPDATE tenants SET stripe_customer_id='cus_recover' WHERE id='tenant-a';
      INSERT INTO billing_events(id,type,tenant_id,summary,lease_until,external_effect_pending)
      VALUES('evt_recover','fixture.ignored','tenant-a','pending','2020-01-01',1)`);
    await observeUncertainBillingEffects(store.db,'2026-10-17T00:00:00Z');
    const alert=store.raw.prepare("SELECT id,version FROM security_alerts WHERE rule_key='stripe_external_effect_review'").get() as {id:string;version:number};
    stripeRead.mockRejectedValueOnce(new Error('Stripe unavailable')).mockResolvedValueOnce({id:'evt_recover',type:'fixture.ignored',data:{object:{customer:'cus_recover'}}});
    const operator={...member,id:'platform',role:'owner' as const};
    const run=() => app(operator).request(`/api/ops/security-alerts/${alert.id}/retry-billing`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedVersion:alert.version}),
    },{...bindings(),STRIPE_SECRET_KEY:'sk_test',STRIPE_BILLING_WEBHOOK_SECRET:'whsec_test'});
    expect((await run()).status).toBe(503);
    expect(store.raw.prepare("SELECT billing_retry_token FROM security_alerts WHERE id=?").get(alert.id)).toEqual({billing_retry_token:null});
    expect(store.raw.prepare("SELECT count(*) AS n FROM audit_events WHERE action='security.alert.retry_billing'").get()).toEqual({n:0});
    expect((await run()).status).toBe(200);
    expect(store.raw.prepare("SELECT count(*) AS n FROM audit_events WHERE action='security.alert.retry_billing'").get()).toEqual({n:1});
  });
  it('処理後に記録の確定が失敗しても完了済みの受付から回復する', async () => {
    const {observeUncertainBillingEffects}=await import('../services/billing-external-review.js');
    store.raw.exec(`INSERT INTO billing_events(id,type,tenant_id,summary,lease_until,external_effect_pending)
      VALUES('evt_reconciled','fixture.ignored','tenant-a','pending','2020-01-01',1)`);
    await observeUncertainBillingEffects(store.db,'2026-10-17T00:00:00Z');
    const alert=store.raw.prepare("SELECT id,version FROM security_alerts WHERE rule_key='stripe_external_effect_review'").get() as {id:string;version:number};
    store.raw.prepare("UPDATE billing_events SET summary=? WHERE id='evt_reconciled'").run(JSON.stringify({state:'completed'}));
    store.raw.prepare("UPDATE security_alerts SET billing_retry_token='abandoned',billing_retry_until='2020-01-01T00:00:00.000Z' WHERE id=?").run(alert.id);
    const operator={...member,id:'platform',role:'owner' as const};
    const response=await app(operator).request(`/api/ops/security-alerts/${alert.id}/retry-billing`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedVersion:alert.version}),
    },{...bindings(),STRIPE_BILLING_WEBHOOK_SECRET:'whsec_test'});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({data:{status:'reconciled'}});
    expect(stripeRead).not.toHaveBeenCalled();
    expect(store.raw.prepare("SELECT action FROM audit_events WHERE target_id=?").all(alert.id)).toEqual([{action:'security.alert.retry_billing_reconciled'}]);
    expect(store.raw.prepare("SELECT status FROM security_alerts WHERE id=?").get(alert.id)).toEqual({status:'resolved'});
  });
  it('platform operator retrieves the event and retries it through the fenced handler', async () => {
    const {observeUncertainBillingEffects}=await import('../services/billing-external-review.js');
    store.raw.exec(`UPDATE tenants SET stripe_customer_id='cus_retry' WHERE id='tenant-a';
      INSERT INTO billing_events(id,type,tenant_id,summary,lease_until,external_effect_pending)
      VALUES('evt_retry','fixture.ignored','tenant-a','pending','2020-01-01',1)`);
    await observeUncertainBillingEffects(store.db,'2026-10-17T00:00:00Z');
    const alert=store.raw.prepare("SELECT id,version FROM security_alerts WHERE rule_key='stripe_external_effect_review'").get() as {id:string;version:number};
    stripeRead.mockResolvedValue({id:'evt_retry',type:'fixture.ignored',data:{object:{customer:'cus_retry'}}});
    const operator={...member,id:'platform',role:'owner' as const};
    const response=await app(operator).request(`/api/ops/security-alerts/${alert.id}/retry-billing`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedVersion:alert.version}),
    },{...bindings(),STRIPE_SECRET_KEY:'sk_test',STRIPE_BILLING_WEBHOOK_SECRET:'whsec_test'});
    expect(response.status).toBe(200);
    expect((store.raw.prepare("SELECT summary FROM billing_events WHERE id='evt_retry'").get() as {summary:string}).summary).toContain('completed');
    expect(store.raw.prepare('SELECT status FROM security_alerts WHERE id=?').get(alert.id)).toEqual({status:'resolved'});
    expect(stripeRead).toHaveBeenCalledWith(expect.anything(),'GET','/v1/events/evt_retry');
  });
});
