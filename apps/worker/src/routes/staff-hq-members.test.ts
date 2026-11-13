import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const invite = vi.hoisted(() => ({ send: vi.fn(), line: vi.fn() }));
vi.mock('../services/staff-invite.js', () => ({ sendStaffInviteEmail: invite.send, sendStaffLineLinkEmail: invite.line }));
vi.mock('../lib/step-up.js', () => ({ sensitiveStepUpSatisfied: vi.fn().mockResolvedValue(true), consumeStepUpToken: vi.fn() }));

const { staff } = await import('./staff.js');

let testDb: SqliteD1;

const admin = (overrides: Partial<AuthenticatedStaff> = {}): AuthenticatedStaff => ({
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

async function call(method: string, path: string, body?: unknown, current = admin()) {
  return app(current).request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, { DB: testDb.db } as Env['Bindings']);
}

beforeEach(() => {
  testDb = createTestD1();
  invite.send.mockReset();
  testDb.raw.prepare(
    `INSERT INTO staff_members (id, name, email, role, api_key, tenant_id) VALUES ('staff-1', '見本 141', 'masato@example.com', 'admin', 'key-1', ?)`,
  ).run(DEFAULT_TENANT_ID);
  testDb.raw.prepare(
    `INSERT INTO staff_members (id, name, email, role, api_key, is_active, invite_status, invite_token_hash, invite_expires_at, tenant_id)
     VALUES ('staff-2', '招待中の人', 'invited@example.com', 'staff', 'key-2', 0, 'pending_email', 'old-hash', '2000-01-01T00:00:00.000Z', ?)`,
  ).run(DEFAULT_TENANT_ID);
  testDb.raw.prepare(
    `INSERT INTO login_audit (id, admin_user_id, action, result, created_at) VALUES ('a1', 'staff-1', 'login', 'ok', '2026-09-10T10:00:00.000')`,
  ).run();
  testDb.raw.prepare(
    `INSERT INTO login_audit (id, admin_user_id, action, result, created_at) VALUES ('a2', 'staff-1', 'login', 'ok', '2026-09-12T21:40:00.000')`,
  ).run();
  testDb.raw.prepare(
    `INSERT INTO login_audit (id, admin_user_id, action, result, created_at) VALUES ('a3', 'staff-1', 'fail', 'fail', '2026-09-13T01:00:00.000')`,
  ).run();
});

describe('統括のメンバー管理', () => {
  it('統括の担当者を個別権限なしで招待し、店舗スタッフとは別に保存する', async () => {
    const res = await call('POST', '/api/staff', {
      name: '担当者', email: 'operator@example.com', role: 'staff',
      managementContext: 'hq', assignedLineAccountId: null,
      accountScope: 'all', scopedLineAccountIds: [],
    });
    expect(res.status).toBe(201);
    const row = testDb.raw.prepare("SELECT role_bundle, permission_keys, account_scope FROM staff_members WHERE email='operator@example.com'")
      .get() as { role_bundle: string; permission_keys: string; account_scope: string };
    expect(row).toMatchObject({ role_bundle: 'hq_operator', permission_keys: '[]', account_scope: 'all' });
    expect(invite.send).toHaveBeenCalledTimes(1);
  });

  it('統括の閲覧のみは更新できない役割として保存する', async () => {
    const res = await call('POST', '/api/staff', {
      name: '閲覧者', email: 'viewer@example.com', role: 'viewer',
      managementContext: 'hq', assignedLineAccountId: null,
      accountScope: 'all', scopedLineAccountIds: [],
    });
    expect(res.status).toBe(201);
    const row = testDb.raw.prepare("SELECT role_bundle, access_level FROM staff_members WHERE email='viewer@example.com'")
      .get() as { role_bundle: string; access_level: string };
    expect(row).toMatchObject({ role_bundle: 'hq_viewer', access_level: 'read_only' });
  });

  it('管理者が統括の閲覧のみを担当者へ変更すると役割が保存される', async () => {
    const created = await call('POST', '/api/staff', {
      name: '閲覧者', email: 'viewer@example.com', role: 'viewer',
      managementContext: 'hq', assignedLineAccountId: null,
      accountScope: 'all', scopedLineAccountIds: [],
    });
    expect(created.status).toBe(201);
    const row = testDb.raw.prepare("SELECT id, policy_version FROM staff_members WHERE email='viewer@example.com'")
      .get() as { id: string; policy_version: number };
    const updated = await call('PATCH', `/api/staff/${row.id}`, {
      role: 'staff', managementContext: 'hq', expectedPolicyVersion: row.policy_version,
    });
    expect(updated.status).toBe(200);
    expect(testDb.raw.prepare('SELECT role_bundle, access_level FROM staff_members WHERE id=?').get(row.id))
      .toMatchObject({ role_bundle: 'hq_operator', access_level: 'full' });
  });

  it('最終ログインは成功したログインの最新だけを人ごとに返す', async () => {
    const res = await call('GET', '/api/staff/last-logins');
    expect(res.status).toBe(200);
    expect((await res.json<{ data: Record<string, string> }>()).data).toEqual({ 'staff-1': '2026-09-12T21:40:00.000' });
  });

  it('招待メールを送り直すと、前のURLは使えなくなり期限が延びる', async () => {
    const res = await call('POST', '/api/staff/staff-2/resend-invite');
    expect(res.status).toBe(200);
    expect(invite.send).toHaveBeenCalledTimes(1);
    expect((invite.send.mock.calls[0][1] as { email: string; verifyUrl: string }).email).toBe('invited@example.com');
    const row = testDb.raw.prepare('SELECT invite_token_hash, invite_expires_at FROM staff_members WHERE id = ?').get('staff-2') as { invite_token_hash: string; invite_expires_at: string };
    expect(row.invite_token_hash).not.toBe('old-hash');
    expect(Date.parse(row.invite_expires_at)).toBeGreaterThan(Date.now());
  });

  it('メールを確認済みの人には送り直さない', async () => {
    const res = await call('POST', '/api/staff/staff-1/resend-invite');
    expect(res.status).toBe(409);
    expect(invite.send).not.toHaveBeenCalled();
  });

  it('担当者は最終ログインを見られず、送り直しもできない', async () => {
    const current = admin({ id: 'staff-2', role: 'staff' });
    expect((await call('GET', '/api/staff/last-logins', undefined, current)).status).toBe(403);
    expect((await call('POST', '/api/staff/staff-2/resend-invite', undefined, current)).status).toBe(403);
  });
});
