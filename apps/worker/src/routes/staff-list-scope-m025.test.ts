import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

/** 氏名・役割・範囲を漏らさないよう、範囲限定の担当者には権限者一覧を403で拒むことを役割ごとに確かめる。 */

const { staff } = await import('./staff.js');

let testDb: SqliteD1;

const member = (overrides: Partial<AuthenticatedStaff> = {}): AuthenticatedStaff => ({
  id: 'staff-1',
  name: '見本 141',
  role: 'admin',
  readOnly: false,
  tenantId: DEFAULT_TENANT_ID,
  ...overrides,
});

function app(current: AuthenticatedStaff) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', current);
    return next();
  });
  instance.route('/', staff);
  return instance;
}

async function list(current: AuthenticatedStaff) {
  return app(current).request('/api/staff', { method: 'GET' }, { DB: testDb.db } as Env['Bindings']);
}

beforeEach(() => {
  testDb = createTestD1();
  testDb.raw.prepare(
    `INSERT INTO staff_members (id, name, email, role, api_key, tenant_id, account_scope)
     VALUES ('staff-1', '見本 141', 'masato@example.com', 'admin', 'key-1', ?, 'all')`,
  ).run(DEFAULT_TENANT_ID);
  testDb.raw.prepare(
    `INSERT INTO staff_members (id, name, email, role, api_key, tenant_id, account_scope)
     VALUES ('scoped-1', '範囲限定の人', 'scoped@example.com', 'staff', 'key-scoped', ?, 'accounts')`,
  ).run(DEFAULT_TENANT_ID);
});

describe('GET /api/staff — 範囲限定は403（M025）', () => {
  it('全店舗の統括・管理者・担当者は一覧を読める', async () => {
    expect((await list(member({ role: 'owner' }))).status).toBe(200);
    expect((await list(member({ role: 'admin' }))).status).toBe(200);
    expect((await list(member({ role: 'staff' }))).status).toBe(200);
  });

  it('範囲限定の管理者は403', async () => {
    const res = await list(member({ id: 'scoped-1', role: 'admin' }));
    expect(res.status).toBe(403);
  });

  it('範囲限定の担当者は403', async () => {
    const res = await list(member({ id: 'scoped-1', role: 'staff' }));
    expect(res.status).toBe(403);
  });

  it('env-ownerは通す', async () => {
    const res = await list(member({ id: 'env-owner', role: 'owner' }));
    expect(res.status).toBe(200);
  });
});
