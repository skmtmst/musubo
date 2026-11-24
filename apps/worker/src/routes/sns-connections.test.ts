import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import { stripeApi, type StripeSubscription } from '../services/stripe-api.js';
import { snsConnections } from './sns-connections.js';

const ACCOUNT = 'sns-account';
const CONNECTION = 'google-connection';

let fixture: SqliteD1;
let role: 'owner' | 'admin' | 'staff';
let readOnly: boolean;

function seed(): void {
  fixture.raw.prepare(`INSERT INTO line_accounts
    (id,channel_id,name,channel_access_token,channel_secret,tenant_id)
    VALUES (?,?,?,?,?,?)`).run(ACCOUNT, 'sns-channel', 'SNS店', 'token', 'secret', DEFAULT_TENANT_ID);
  fixture.raw.prepare(`INSERT INTO rt_organizations(id,account_id,name,status,tenant_id)
    VALUES ('sns-org',?,'SNS店','active',?)`).run(ACCOUNT, DEFAULT_TENANT_ID);
  fixture.raw.prepare(`INSERT INTO rt_stores(id,organization_id,name,code,status,line_account_id)
    VALUES ('sns-store','sns-org','SNS店','SNS','active',?)`).run(ACCOUNT);
  fixture.raw.prepare(`INSERT INTO rt_google_connections
    (id,store_id,line_account_id,location_name,location_title,status,connected_at,confirmation_revision)
    VALUES (?,'sns-store',?,'locations/1','SNS店 本店','connected','2026-11-01',3)`)
    .run(CONNECTION, ACCOUNT);
  fixture.raw.prepare(`INSERT INTO instagram_connections
    (line_account_id,page_id,instagram_id,page_name,username,page_token_encrypted,user_token_encrypted,
      expires_at,refreshed_at,connected_by,version,scopes)
    VALUES (?,'page','instagram-1','SNS店','sns','page-token','user-token','2099-01-01',
      '2026-11-01','owner',1,
      'instagram_business_basic,instagram_business_content_publish')`).run(ACCOUNT);
  fixture.raw.prepare(`INSERT INTO musubo_line_usage
    (line_account_id,tenant_id,status,activated_at,updated_at,contracted_linked_slots)
    VALUES (?,?,'active','2026-11-01','2026-11-01',3)`).run(ACCOUNT, DEFAULT_TENANT_ID);
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,billing_interval,status,first_line_activated_at,first_charge_date,
      created_at,updated_at)
    VALUES (?,'{}','month','trialing','2026-11-01','2026-12-01','2026-11-01','2026-11-01')`)
    .run(DEFAULT_TENANT_ID);
}

function app(): Hono<Env> {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', {
      id: 'env-owner', name: 'Owner', role, readOnly, tenantId: DEFAULT_TENANT_ID,
    });
    await next();
  });
  instance.route('/', snsConnections);
  return instance;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  return app().request(path, init, { DB: fixture.db, STRIPE_SECRET_KEY: 'sk_test' } as Env['Bindings']);
}

beforeEach(() => {
  fixture = createTestD1();
  role = 'owner';
  readOnly = false;
  seed();
  vi.restoreAllMocks();
});

describe('SNS connection ports', () => {
  it('keeps the default primary in the same order as Google operations and switches only the selected connection', async () => {
    fixture.raw.prepare(`UPDATE rt_google_connections SET sort_order=9 WHERE id=?`).run(CONNECTION);
    fixture.raw.prepare(`INSERT INTO rt_google_connections
      (id,store_id,line_account_id,location_name,location_title,status,connected_at,confirmation_revision,sort_order)
      VALUES ('google-second','sns-store',?,'locations/2','SNS店 支店','connected','2026-11-02',2,0)`)
      .run(ACCOUNT);
    const read = () => request(`/api/settings/sns/connections?lineAccountId=${ACCOUNT}`);
    const before = await (await read()).json() as { data: { googleConnections: Array<{ id: string; isPrimary: boolean }> } };
    expect(before.data.googleConnections.map(row => [row.id,row.isPrimary])).toEqual([
      ['google-second',true], [CONNECTION,false],
    ]);
    const response = await request('/api/settings/sns/google-primary', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccountId: ACCOUNT, connectionId: CONNECTION, expectedVersion: 0, tenantId: 'spoofed' }),
    });
    expect(response.status).toBe(200);
    const after = await (await read()).json() as typeof before;
    expect(after.data.googleConnections.map(row => [row.id,row.isPrimary])).toEqual([
      [CONNECTION,true], ['google-second',false],
    ]);
    expect(fixture.raw.prepare('SELECT COUNT(*) AS n FROM rt_google_connections').get()).toEqual({ n: 2 });
  });

  it('returns no contract for legacy accounts without inventing a trial or expanding their quota', async () => {
    fixture.raw.prepare('DELETE FROM musubo_line_usage WHERE line_account_id=?').run(ACCOUNT);
    const response = await request(`/api/settings/sns/connections?lineAccountId=${ACCOUNT}`);
    expect(response.status).toBe(404);
  });

  it('returns the contracted slots, trial state, counts, and the first Google connection as primary', async () => {
    role = 'admin';
    const response = await request(`/api/settings/sns/connections?lineAccountId=${ACCOUNT}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        lineAccountId: ACCOUNT,
        contracted: 3,
        counts: { googleBusiness: 1, instagram: 1 },
        linkedSlots: 0,
        billing: { kind: 'trialing' },
        googleConnections: [{
          id: CONNECTION,
          label: 'SNS店 本店',
          state: 'connected',
          version: 3,
          isPrimary: true,
        }],
        primaryVersion: 0,
      },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('uses the verified Stripe monthly period to return paid billing days', async () => {
    fixture.raw.prepare(`UPDATE tenants SET stripe_customer_id='cus_sns' WHERE id=?`)
      .run(DEFAULT_TENANT_ID);
    fixture.raw.prepare(`UPDATE musubo_tenant_billing
      SET status='active',options_subscription_id='sub_options' WHERE tenant_id=?`)
      .run(DEFAULT_TENANT_ID);
    vi.spyOn(stripeApi, 'retrieveSubscription').mockResolvedValue({
      id: 'sub_options', status: 'active', customer: 'cus_sns',
      current_period_start: Date.parse('2026-11-01T00:00:00Z') / 1000,
      current_period_end: Date.parse('2026-12-01T00:00:00Z') / 1000,
      metadata: { tenant_id: DEFAULT_TENANT_ID, purpose: 'musubo_options' },
      items: { data: [] },
    } satisfies StripeSubscription);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T03:00:00Z'));
    try {
      const response = await request(`/api/settings/sns/connections?lineAccountId=${ACCOUNT}`);
      expect(response.status).toBe(200);
      expect((await response.json() as { data: { billing: unknown } }).data.billing).toEqual({
        kind: 'paid', monthlyDaysRemaining: 13, monthlyDaysInPeriod: 30,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null billing when a paid period cannot be verified', async () => {
    fixture.raw.prepare(`UPDATE tenants SET stripe_customer_id='cus_sns' WHERE id=?`)
      .run(DEFAULT_TENANT_ID);
    fixture.raw.prepare(`UPDATE musubo_tenant_billing
      SET status='active',options_subscription_id='sub_options' WHERE tenant_id=?`)
      .run(DEFAULT_TENANT_ID);
    vi.spyOn(stripeApi, 'retrieveSubscription').mockRejectedValue(new Error('unavailable'));
    const response = await request(`/api/settings/sns/connections?lineAccountId=${ACCOUNT}`);
    expect(response.status).toBe(200);
    expect((await response.json() as { data: { billing: unknown } }).data.billing).toBeNull();
  });

  it('switches the Google primary with CAS and returns 409 for a stale version', async () => {
    const save = () => request('/api/settings/sns/google-primary', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccountId: ACCOUNT, connectionId: CONNECTION, expectedVersion: 0 }),
    });
    const first = await save();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      success: true, data: { connectionId: CONNECTION, version: 1 },
    });
    const stale = await save();
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      success: false,
      code: 'VERSION_CONFLICT',
      current: { connectionId: CONNECTION, version: 1 },
    });
  });

  it('rejects staff reads and read-only primary changes', async () => {
    role = 'staff';
    expect((await request(`/api/settings/sns/connections?lineAccountId=${ACCOUNT}`)).status).toBe(403);
    role = 'admin';
    readOnly = true;
    expect((await request('/api/settings/sns/google-primary', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccountId: ACCOUNT, connectionId: CONNECTION, expectedVersion: 0 }),
    })).status).toBe(403);
  });
});
