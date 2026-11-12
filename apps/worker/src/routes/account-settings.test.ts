import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1, insertFriend } from '../test-utils/d1-sqlite.js';

const accessMocks = vi.hoisted(() => ({ canAccess: vi.fn(async () => true) }));
vi.mock('../services/account-access.js', () => ({
  canAccessAllLineAccounts: accessMocks.canAccess,
}));

const { accountSettings } = await import('./account-settings.js');

const app = new Hono<Env>();
app.use('*', async (c, next) => {
  c.set('staff', {
    id: 'owner', name: 'Owner', role: 'owner', readOnly: false, tenantId: 'tenant-a',
  });
  await next();
});
app.route('/', accountSettings);

function appForTenant(tenantId: string) {
  const tenantApp = new Hono<Env>();
  tenantApp.use('*', async (c, next) => {
    c.set('staff', {
      id: 'owner', name: 'Owner', role: 'owner', readOnly: false, tenantId,
    });
    await next();
  });
  tenantApp.route('/', accountSettings);
  return tenantApp;
}

function appForRole(role: 'owner' | 'admin' | 'staff' | null) {
  const roleApp = new Hono<Env>();
  roleApp.use('*', async (c, next) => {
    if (role) {
      c.set('staff', {
        id: role, name: role, role, readOnly: false, tenantId: 'tenant-a',
      });
    }
    await next();
  });
  roleApp.route('/', accountSettings);
  return roleApp;
}

describe('GET /api/account-settings/test-recipient-login-users', () => {
  test('accountIdがない場合はDBを読まない', async () => {
    const prepare = vi.fn();
    const response = await app.request('/api/account-settings/test-recipient-login-users', {}, {
      DB: { prepare },
    });
    expect(response.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });

  test('LINE連携済みの有効なログインユーザーをテスト送信候補へ変換する', async () => {
    const all = vi.fn(async () => ({
      results: [
        {
          id: 'friend-masato',
          display_name: 'LINE上の表示名',
          picture_url: 'https://example.com/masato.png',
          staff_name: 'Masato.S',
          same_account: 0,
        },
        {
          id: 'friend-owner',
          display_name: null,
          picture_url: null,
          staff_name: '管理者',
          same_account: 1,
        },
      ],
    }));
    const bind = vi.fn((..._accountIds: string[]) => ({ all }));
    const prepare = vi.fn((_sql: string) => ({ bind }));

    const response = await app.request(
      '/api/account-settings/test-recipient-login-users?accountId=line-account-1',
      {},
      { DB: { prepare } },
    );

    expect(response.status).toBe(200);
    expect(bind).toHaveBeenCalledWith(
      'line-account-1',
      'line-account-1',
      'line-account-1',
      '00000000-0000-4000-8000-000000000001',
      'tenant-a',
      'tenant-a',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001',
      'tenant-a',
    );
    expect(prepare.mock.calls[0]?.[0]).toContain('JOIN friends f ON f.line_user_id = sm.line_user_id');
    expect(prepare.mock.calls[0]?.[0]).toContain('scoped.line_account_id = ?');
    expect(prepare.mock.calls[0]?.[0]).toContain('fallback_account.id = f.line_account_id');
    expect(prepare.mock.calls[0]?.[0]).toContain('COALESCE(fallback_account.tenant_id, ?) = ?');
    expect(prepare.mock.calls[0]?.[0]).toContain('COALESCE(sm.tenant_id, ?) = ?');
    expect(await response.json()).toEqual({
      success: true,
      data: [
        {
          id: 'friend-masato',
          displayName: 'LINE上の表示名',
          pictureUrl: 'https://example.com/masato.png',
          staffName: 'Masato.S',
          sameAccount: false,
        },
        {
          id: 'friend-owner',
          displayName: '管理者',
          pictureUrl: null,
          staffName: '管理者',
          sameAccount: true,
        },
      ],
    });
  });

  test('SQLでリクエスト元職員の統括だけに絞る', async () => {
    const all = vi.fn(async () => ({ results: [] }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn((_sql: string) => ({ bind }));

    await app.request(
      '/api/account-settings/test-recipient-login-users?accountId=line-account-1',
      {}, { DB: { prepare } },
    );

    expect(bind.mock.calls[0]?.slice(-6)).toEqual([
      '00000000-0000-4000-8000-000000000001', 'tenant-a',
      'tenant-a', '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001', 'tenant-a',
    ]);
  });

  test('フォールバック候補をリクエスト元職員と同じ統括のアカウントに限る', async () => {
    const all = vi.fn(async () => ({ results: [] }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn((_sql: string) => ({ bind }));

    await app.request(
      '/api/account-settings/test-recipient-login-users?accountId=line-account-1',
      {}, { DB: { prepare } },
    );

    const sql = prepare.mock.calls[0]?.[0];
    expect(sql).toMatch(/NOT EXISTS[\s\S]+AND \([\s\S]+EXISTS \([\s\S]+FROM line_accounts fallback_account/);
    expect(bind).toHaveBeenCalledWith(
      'line-account-1', 'line-account-1', 'line-account-1',
      '00000000-0000-4000-8000-000000000001', 'tenant-a',
      'tenant-a', '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001', 'tenant-a',
    );
  });

  test.each([
    { tenantId: DEFAULT_TENANT_ID, expectedIds: ['friend-unassigned'], label: '既定統括' },
    { tenantId: 'tenant-other', expectedIds: [], label: '既定統括でない統括' },
  ])('$labelでは未割当の友だちを統括の可視範囲どおりに扱う', async ({ tenantId, expectedIds }) => {
    const testDb = createTestD1();
    try {
      insertFriend(testDb.raw, 'friend-unassigned', {
        line_user_id: 'U-unassigned',
        line_account_id: null,
      });
      testDb.raw.prepare(`INSERT INTO staff_members
        (id, name, role, api_key, line_user_id, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
          `staff-${tenantId}`, '未割当スタッフ', 'staff', `key-${tenantId}`,
          'U-unassigned', tenantId,
        );

      const response = await appForTenant(tenantId).request(
        '/api/account-settings/test-recipient-login-users?accountId=line-account-1',
        {}, { DB: testDb.db },
      );

      expect(response.status).toBe(200);
      const body = await response.json() as { data: Array<{ id: string }> };
      expect(body.data.map(({ id }) => id)).toEqual(expectedIds);
    } finally {
      testDb.raw.close();
    }
  });
});

describe('PUT /api/account-settings/test-recipients', () => {
  test('テスト送信先の保存を重ねると版が進み、読み出しにも含まれる', async () => {
    const d = createTestD1();
    try {
      const save = () => app.request('/api/account-settings/test-recipients', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: 'line-account-1', friendIds: [] }),
      }, { DB: d.db });
      expect((await save()).status).toBe(200);
      expect((await save()).status).toBe(200);
      const res = await app.request('/api/account-settings/test-recipients?accountId=line-account-1', {}, { DB: d.db });
      expect(await res.json()).toMatchObject({ success: true, confirmationRevision: 2 });
    } finally { d.raw.close(); }
  });

  test.each(['owner', 'admin'] as const)('%sは同じアカウントの友だちを保存できる', async (role) => {
    const testDb = createTestD1();
    try {
      insertFriend(testDb.raw, 'friend-1', { line_account_id: 'line-account-1' });

      const response = await appForRole(role).request('/api/account-settings/test-recipients', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: 'line-account-1', friendIds: ['friend-1'] }),
      }, { DB: testDb.db });

      expect(response.status).toBe(200);
      expect(testDb.raw.prepare(
        `SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'test_recipients'`,
      ).get('line-account-1')).toEqual({ value: JSON.stringify(['friend-1']) });
    } finally {
      testDb.raw.close();
    }
  });

  test.each([
    { role: 'staff' as const, label: 'staff' },
    { role: null, label: '未認証ユーザー' },
  ])('$labelは保存できない', async ({ role }) => {
    const prepare = vi.fn();

    const response = await appForRole(role).request('/api/account-settings/test-recipients', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'line-account-1', friendIds: ['friend-1'] }),
    }, { DB: { prepare } });

    expect(response.status).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
  });

  test('adminでも別統括のアカウントは保存前に403にする', async () => {
    accessMocks.canAccess.mockResolvedValueOnce(false);
    const prepare = vi.fn();

    const response = await appForRole('admin').request('/api/account-settings/test-recipients', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'other-account', friendIds: ['friend-1'] }),
    }, { DB: { prepare } });

    expect(response.status).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
  });

  test('adminでも別アカウントの友だちIDが混ざると保存前に400にする', async () => {
    const all = vi.fn(async () => ({ results: [{ id: 'friend-1' }] }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));

    const response = await appForRole('admin').request('/api/account-settings/test-recipients', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'line-account-1', friendIds: ['friend-1', 'friend-other'] }),
    }, { DB: { prepare } });

    expect(response.status).toBe(400);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith('line-account-1', JSON.stringify(['friend-1', 'friend-other']));
  });

  test('空配列は友だち照合をせず保存できる', async () => {
    const run = vi.fn(async () => ({ success: true }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));

    const response = await app.request('/api/account-settings/test-recipients', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'line-account-1', friendIds: [] }),
    }, { DB: { prepare } });

    expect(response.status).toBe(200);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledOnce();
  });

  test('上限を超える件数はDBを読まず400にする', async () => {
    const prepare = vi.fn();
    const response = await app.request('/api/account-settings/test-recipients', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'line-account-1',
        friendIds: Array.from({ length: 91 }, (_, index) => `friend-${index}`),
      }),
    }, { DB: { prepare } });

    expect(response.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });

  test('friendIdsが配列でなければDBを読まず400にする', async () => {
    const prepare = vi.fn();
    const response = await app.request('/api/account-settings/test-recipients', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'line-account-1', friendIds: 'friend-1' }),
    }, { DB: { prepare } });

    expect(response.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });
});
