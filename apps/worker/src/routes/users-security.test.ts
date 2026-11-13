import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';

const db = vi.hoisted(() => ({
  getUsersForAccess: vi.fn(),
  getUserById: vi.fn(),
  getUserByIdForAccess: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  linkFriendToUser: vi.fn(),
  getUserFriends: vi.fn(),
  getUserByEmailForAccess: vi.fn(),
  getUserByPhoneForAccess: vi.fn(),
  getFriendById: vi.fn(),
}));
const access = vi.hoisted(() => ({
  getVisibleLineAccountScope: vi.fn(),
  canAccessAllLineAccounts: vi.fn(),
}));

vi.mock('@line-crm/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@line-crm/db')>(),
  ...db,
}));
vi.mock('../services/account-access.js', () => access);

const { users } = await import('./users.js');

const ownUser = {
  id: 'user-own',
  tenant_id: DEFAULT_TENANT_ID,
  email: 'own@example.com',
  phone: '09000000000',
  external_id: null,
  display_name: 'Own User',
  created_at: '2026-09-06',
  updated_at: '2026-09-06',
};

function app(role: 'owner' | 'admin' | 'staff' = 'owner') {
  const instance = new Hono<any>();
  instance.use('*', async (c, next) => {
    c.set('staff', {
      id: 'staff-own', name: 'Own Staff', role, readOnly: false, tenantId: DEFAULT_TENANT_ID,
    });
    c.env = { DB: {} };
    await next();
  });
  instance.route('/', users);
  return instance;
}

function request(method: string, body?: unknown) {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  access.getVisibleLineAccountScope.mockResolvedValue({
    accounts: [], ids: ['account-own'], allowedAccountIds: ['account-own'],
    canSeeUnassigned: false, isAccountScoped: false,
  });
  access.canAccessAllLineAccounts.mockResolvedValue(true);
  db.getUsersForAccess.mockResolvedValue([ownUser]);
  db.getUserById.mockResolvedValue(null);
  db.getUserByIdForAccess.mockResolvedValue(ownUser);
  db.createUser.mockResolvedValue(ownUser);
  db.updateUser.mockResolvedValue(ownUser);
  db.getFriendById.mockResolvedValue({ id: 'friend-own', line_account_id: 'account-own' });
  db.getUserFriends.mockResolvedValue([
    { id: 'friend-own', line_user_id: 'U-own', display_name: 'Own Friend', is_following: 1 },
  ]);
  db.getUserByEmailForAccess.mockResolvedValue(ownUser);
  db.getUserByPhoneForAccess.mockResolvedValue(null);
});

describe('/api/users authorization boundaries', () => {
  test('list and detail pass the tenant and account boundary to the database', async () => {
    const instance = app('staff');
    expect((await instance.request('/api/users')).status).toBe(200);
    expect((await instance.request('/api/users/user-own')).status).toBe(200);
    expect(db.getUsersForAccess).toHaveBeenCalledWith({}, {
      tenantId: DEFAULT_TENANT_ID,
      allowedAccountIds: ['account-own'],
      includeUnlinked: true,
    });
    expect(db.getUserByIdForAccess).toHaveBeenCalledWith({}, 'user-own', expect.objectContaining({
      tenantId: DEFAULT_TENANT_ID,
      allowedAccountIds: ['account-own'],
    }));
  });

  test.each([
    ['GET', '/api/users/user-other', undefined],
    ['PUT', '/api/users/user-other', { displayName: 'Changed' }],
    ['DELETE', '/api/users/user-other', undefined],
    ['POST', '/api/users/user-other/link', { friendId: 'friend-own' }],
    ['GET', '/api/users/user-other/accounts', undefined],
  ] as const)('%s hides a user outside the boundary at %s', async (method, path, body) => {
    db.getUserByIdForAccess.mockResolvedValue(null);
    const response = await app().request(path, request(method, body));
    expect(response.status).toBe(404);
    expect(db.updateUser).not.toHaveBeenCalled();
    expect(db.deleteUser).not.toHaveBeenCalled();
    expect(db.linkFriendToUser).not.toHaveBeenCalled();
    expect(db.getUserFriends).not.toHaveBeenCalled();
  });

  test('link rejects a friend outside the visible account before changing it', async () => {
    access.canAccessAllLineAccounts.mockResolvedValue(false);
    const response = await app().request(
      '/api/users/user-own/link',
      request('POST', { friendId: 'friend-other' }),
    );
    expect(response.status).toBe(404);
    expect(db.linkFriendToUser).not.toHaveBeenCalled();
  });

  test('match cannot find email or phone outside the same boundary', async () => {
    db.getUserByEmailForAccess.mockResolvedValue(null);
    db.getUserByPhoneForAccess.mockResolvedValue(null);
    const response = await app().request(
      '/api/users/match',
      request('POST', { email: 'secret@example.com', phone: '09000009999' }),
    );
    expect(response.status).toBe(404);
    expect(db.getUserByEmailForAccess).toHaveBeenCalledWith(
      {}, 'secret@example.com', expect.objectContaining({ allowedAccountIds: ['account-own'] }),
    );
    expect(db.getUserByPhoneForAccess).toHaveBeenCalledWith(
      {}, '09000009999', expect.objectContaining({ allowedAccountIds: ['account-own'] }),
    );
  });

  test('account-scoped admin cannot create a user with no accountable LINE account', async () => {
    access.getVisibleLineAccountScope.mockResolvedValue({
      accounts: [], ids: ['account-own'], allowedAccountIds: ['account-own'],
      canSeeUnassigned: false, isAccountScoped: true,
    });
    const response = await app('admin').request(
      '/api/users',
      request('POST', { email: 'new@example.com' }),
    );
    expect(response.status).toBe(403);
    expect(db.createUser).not.toHaveBeenCalled();
  });

  test('tenant-wide admin creates a tenant-owned user and allowed operations still work', async () => {
    const instance = app('admin');
    const created = await instance.request('/api/users', request('POST', { email: 'own@example.com' }));
    expect(created.status).toBe(201);
    expect(db.createUser).toHaveBeenCalledWith({}, expect.objectContaining({
      tenantId: DEFAULT_TENANT_ID,
      createdBy: 'staff-own',
    }));
    expect((await instance.request('/api/users/user-own', request('PUT', { displayName: 'Changed' }))).status).toBe(200);
    // 結び直しは担当者を添えて呼び、成功すれば200。
    db.linkFriendToUser.mockResolvedValue(true);
    expect((await instance.request('/api/users/user-own/link', request('POST', { friendId: 'friend-own' }))).status).toBe(200);
    expect((await instance.request('/api/users/user-own/accounts')).status).toBe(200);
    expect((await instance.request('/api/users/match', request('POST', { email: 'own@example.com' }))).status).toBe(200);
    expect(db.updateUser).toHaveBeenCalled();
    expect(db.linkFriendToUser).toHaveBeenCalledWith({}, 'friend-own', 'user-own', { id: 'staff-own' });
    expect(db.getUserFriends).toHaveBeenCalledWith({}, 'user-own');
  });

  test('R394 linkで競合（false）が返ったら409で止める', async () => {
    db.linkFriendToUser.mockResolvedValue(false);
    const response = await app().request(
      '/api/users/user-own/link',
      request('POST', { friendId: 'friend-own' }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('最新の状態を読み直してください') });
  });

  test('role gate rejects staff mutations', async () => {
    const response = await app('staff').request(
      '/api/users',
      request('POST', { email: 'blocked@example.com' }),
    );
    expect(response.status).toBe(403);
    expect(db.createUser).not.toHaveBeenCalled();
  });
});
