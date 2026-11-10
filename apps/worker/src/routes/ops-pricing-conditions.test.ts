import { beforeEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { opsPricingConditions } from './ops-pricing-conditions.js';

let database: SqliteD1;
const admin: AuthenticatedStaff = { id: 'ops-master', name: '運営担当', role: 'owner', readOnly: false, tenantId: null };
const viewer: AuthenticatedStaff = { ...admin, readOnly: true };

function app(staff: AuthenticatedStaff) {
  const hono = new Hono<Env>();
  hono.use('*', async (c, next) => { c.set('staff', staff); await next(); });
  hono.route('/', opsPricingConditions);
  return hono;
}
function environment(): Env['Bindings'] { return { DB: database.db } as Env['Bindings']; }
function body(input: unknown) { return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }; }
const definition = {
  internalName: '特約店', status: 'active', trialPeriod: { unit: 'months', value: 3 },
  lineBasicDiscountPercent: 50, discountEndsOn: null, approvalUseUntil: '2027-12-31',
  allowedCompanyName: '株式会社サンプル', schedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE },
};

beforeEach(() => {
  database = createTestD1();
  database.raw.prepare("INSERT INTO staff_members (id,name,role,api_key) VALUES ('ops-master','運営担当','owner','fixture-key')").run();
  database.raw.prepare("INSERT INTO platform_admins (staff_id,is_active) VALUES ('ops-master',1)").run();
});

it('operational conditions are versioned and read-only staff cannot edit them', async () => {
  const route = '/api/ops/pricing-conditions';
  expect((await app(viewer).request(route, body(definition), environment())).status).toBe(403);
  const initial = await app(admin).request(route, {}, environment());
  expect(initial.status).toBe(200);
  expect(await initial.json()).toMatchObject({ data: [{ id: 'normal', status: 'active', trialPeriod: { value: 30 } }] });

  const created = await app(admin).request(route, body(definition), environment());
  expect(created.status).toBe(201);
  const first = (await created.json() as { data: { id: string; version: number; status: string } }).data;
  expect(first).toMatchObject({ version: 1, status: 'active' });
  const change = { ...definition, trialPeriod: { unit: 'months', value: 6 }, schedule: {
    ...definition.schedule, headquartersYen: 6_000,
  } };
  const updated = await app(admin).request(`${route}/${first.id}`, { ...body(change), method: 'PUT' }, environment());
  expect(updated.status).toBe(200);
  const second = (await updated.json() as { data: { id: string; version: number; schedule: { headquartersYen: number } } }).data;
  expect(second).toMatchObject({ version: 2, schedule: { headquartersYen: 6_000 } });
  expect(second.id).not.toBe(first.id);
  expect(database.raw.prepare('SELECT status FROM musubo_pricing_conditions WHERE id=?').get(first.id))
    .toEqual({ status: 'disabled' });
  expect((await app(admin).request(`${route}/${first.id}`, { ...body(change), method: 'PUT' }, environment())).status).toBe(409);
  expect((await app(admin).request(`${route}/normal`, {
    ...body({ ...definition, status: 'inactive' }), method: 'PUT',
  }, environment())).status).toBe(400);
  expect(database.raw.prepare('SELECT COUNT(*) AS n FROM platform_audit_logs WHERE action LIKE ?')
    .get('pricing_condition.%')).toEqual({ n: 2 });
});
