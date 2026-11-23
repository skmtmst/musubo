import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';

const mocks = {
  getEntryRoutes: vi.fn(),
  // 一覧が共通境界へ委譲するため、範囲解決の口も用意する。
  getLineAccountScopeEntries: vi.fn(async () => []),
  getStaffById: vi.fn(async () => null),
  getStaffAccountScopeIds: vi.fn(async () => []),
  getEntryRouteById: vi.fn(),
  createEntryRoute: vi.fn(),
  updateEntryRoute: vi.fn(),
  deleteEntryRoute: vi.fn(),
  getEntryRouteFunnel: vi.fn(),
  getEntryRouteSources: vi.fn(),
  getEntryRouteGenres: vi.fn(),
  createEntryRouteGenre: vi.fn(),
  updateEntryRouteGenre: vi.fn(),
};
vi.mock('@line-crm/db', () => mocks);

const { entryRoutes } = await import('./entry-routes.js');
const app = new Hono<Env>();
// 更新系はオーナー／管理者限定になった。ここで見たいのは本体の挙動なので、
// 認証は通った状態にしてから渡す。権限の検証は role-guard.test.ts が持つ。
app.use('*', async (c, next) => {
  c.set('staff', { id: 'owner-1', name: 'Owner', role: 'owner', readOnly: false, tenantId: 'tenant-a' });
  return next();
});
app.route('/', entryRoutes);
const env = { DB: {} as D1Database };

function post(body: unknown) {
  return app.fetch(new Request('https://example.com/api/entry-routes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
}

function appForStaff(
  role: 'owner' | 'admin' | 'staff',
  permissionKeys: string[] = [],
) {
  const roleApp = new Hono<Env>();
  roleApp.use('*', async (c, next) => {
    c.set('staff', {
      id: `${role}-1`, name: role, role, readOnly: false, tenantId: 'tenant-a', permissionKeys,
    });
    return next();
  });
  roleApp.route('/', entryRoutes);
  return roleApp;
}

function mutateWith(
  roleApp: Hono<Env>,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
) {
  return roleApp.fetch(new Request(`https://example.com${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
}

function postGenre(body: unknown) {
  return app.fetch(new Request('https://example.com/api/entry-route-genres', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
}

function patchGenre(id: string, body: unknown) {
  return app.fetch(new Request(`https://example.com/api/entry-route-genres/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
}

beforeEach(() => vi.clearAllMocks());

function deleteRoute(id: string, confirmationName?: string) {
  return app.fetch(new Request(`https://example.com/api/entry-routes/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: confirmationName === undefined ? undefined : JSON.stringify({ confirmationName }),
  }), env);
}

describe('POST /api/entry-routes', () => {
  // 作成は選択中アカウントの所属が必須。可視範囲の解決は
  // getLineAccountScopeEntries のモックで acc-1 を見える状態にする。
  beforeEach(() => {
    mocks.getLineAccountScopeEntries.mockResolvedValue([
      { id: 'acc-1', tenant_id: 'tenant-a' },
    ] as never);
  });

  it('creates a named link inside a genre', async () => {
    mocks.createEntryRoute.mockResolvedValue({
      id: 'route-1', ref_code: 'ashop-instagram', genre: 'A店', name: 'Instagram',
      tag_id: null, scenario_id: null, redirect_url: null, pool_id: null,
      intro_template_id: null, run_account_friend_add_scenarios: 1, is_active: 1,
      line_account_id: 'acc-1',
      created_at: '2026-08-14', updated_at: '2026-08-14',
    });
    const response = await post({ genre: ' A店 ', name: ' Instagram ', refCode: 'ashop-instagram', lineAccountId: 'acc-1' });
    expect(response.status).toBe(201);
    const body = await response.json() as { data: { genre: string; name: string; lineAccountId: string | null } };
    expect(body.data).toMatchObject({ genre: 'A店', name: 'Instagram', lineAccountId: 'acc-1' });
    expect(mocks.createEntryRoute).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      genre: 'A店', name: 'Instagram', refCode: 'ashop-instagram', tenantId: 'tenant-a', lineAccountId: 'acc-1',
    }));
  });

  it('keeps legacy genre-less API calls compatible and rejects unsafe ref codes', async () => {
    mocks.createEntryRoute.mockResolvedValue({
      id: 'route-legacy', ref_code: 'instagram', genre: null, name: 'Instagram',
      tag_id: null, scenario_id: null, redirect_url: null, pool_id: null,
      intro_template_id: null, run_account_friend_add_scenarios: 1, is_active: 1,
      line_account_id: 'acc-1',
      created_at: '2026-08-14', updated_at: '2026-08-14',
    });
    expect((await post({ name: 'Instagram', refCode: 'instagram', lineAccountId: 'acc-1' })).status).toBe(201);
    expect((await post({ genre: 'A店', name: 'Instagram', refCode: 'bad code', lineAccountId: 'acc-1' })).status).toBe(400);
    expect(mocks.createEntryRoute).toHaveBeenCalledTimes(1);
  });

  it('returns a useful conflict for duplicate ref codes', async () => {
    mocks.createEntryRoute.mockRejectedValue(new Error('UNIQUE constraint failed: entry_routes.ref_code'));
    const response = await post({ genre: 'A店', name: 'Instagram', refCode: 'duplicate', lineAccountId: 'acc-1' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'この ref_code は既に使われています' });
  });

  it('所属なしの作成はLINE_ACCOUNT_REQUIREDで保存しない', async () => {
    const response = await post({ name: '所属なし', refCode: 'no-account' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'LINE_ACCOUNT_REQUIRED' });
    expect(mocks.createEntryRoute).not.toHaveBeenCalled();
  });

  it('範囲外アカウントの作成は404で保存しない', async () => {
    const response = await post({ name: '他所', refCode: 'foreign', lineAccountId: 'acc-x' });
    expect(response.status).toBe(404);
    expect(mocks.createEntryRoute).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'] as const)('%sは従来どおり作成できる', async (role) => {
    mocks.createEntryRoute.mockResolvedValue({
      id: `route-${role}`, ref_code: `${role}-ref`, genre: null, name: role,
      tag_id: null, scenario_id: null, redirect_url: null, pool_id: null,
      intro_template_id: null, run_account_friend_add_scenarios: 1, is_active: 1,
      line_account_id: 'acc-1',
      tenant_id: 'tenant-a', created_at: '2026-09-16', updated_at: '2026-09-16',
    });
    const response = await mutateWith(
      appForStaff(role),
      'POST',
      '/api/entry-routes',
      { name: role, refCode: `${role}-ref`, lineAccountId: 'acc-1' },
    );
    expect(response.status).toBe(201);
    expect(mocks.createEntryRoute).toHaveBeenCalledTimes(1);
  });

  it('inflow-links権限を持つstaffは作成できる', async () => {
    mocks.createEntryRoute.mockResolvedValue({
      id: 'route-staff', ref_code: 'staff-ref', genre: null, name: '担当者経路',
      tag_id: null, scenario_id: null, redirect_url: null, pool_id: null,
      intro_template_id: null, run_account_friend_add_scenarios: 1, is_active: 1,
      line_account_id: 'acc-1',
      tenant_id: 'tenant-a', created_at: '2026-09-16', updated_at: '2026-09-16',
    });
    const response = await mutateWith(
      appForStaff('staff', ['/inflow-links']),
      'POST',
      '/api/entry-routes',
      { name: '担当者経路', refCode: 'staff-ref', lineAccountId: 'acc-1' },
    );
    expect(response.status).toBe(201);
    expect(mocks.createEntryRoute).toHaveBeenCalledTimes(1);
  });

  it('権限なしstaffは作成を403にしてDB書き込み0件にする', async () => {
    const response = await mutateWith(
      appForStaff('staff'),
      'POST',
      '/api/entry-routes',
      { name: '拒否対象', refCode: 'denied-ref' },
    );
    expect(response.status).toBe(403);
    expect(mocks.createEntryRoute).not.toHaveBeenCalled();
  });
});

describe('entry route tenant scope', () => {
  const otherRoute = {
    id: 'route-b', ref_code: 'b-ref', genre: null, name: 'B', tag_id: null,
    scenario_id: null, redirect_url: 'https://before.example', pool_id: null,
    intro_template_id: null, run_account_friend_add_scenarios: 1, is_active: 1,
    tenant_id: 'tenant-b', created_at: '2026-08-14', updated_at: '2026-08-14',
  };

  it('passes the current tenant to the list query', async () => {
    mocks.getEntryRoutes.mockResolvedValue([]);
    const response = await app.fetch(new Request('https://example.com/api/entry-routes'), env);
    expect(response.status).toBe(200);
    expect(mocks.getEntryRoutes).toHaveBeenCalledWith(env.DB, 'tenant-a');
  });

  it('returns 404 without patching another tenant route', async () => {
    mocks.getEntryRouteById.mockResolvedValue(otherRoute);
    const response = await app.fetch(new Request('https://example.com/api/entry-routes/route-b', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirectUrl: 'https://after.example' }),
    }), env);
    expect(response.status).toBe(404);
    expect(mocks.updateEntryRoute).not.toHaveBeenCalled();
  });

  it('rejects changing ref_code after creation', async () => {
    mocks.getEntryRouteById.mockResolvedValue({ ...otherRoute, tenant_id: 'tenant-a' });
    const response = await app.fetch(new Request('https://example.com/api/entry-routes/route-b', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refCode: 'changed-ref' }),
    }), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'ref_code は作成後に変更できません' });
    expect(mocks.updateEntryRoute).not.toHaveBeenCalled();
  });

  it('returns 404 without deleting another tenant route', async () => {
    mocks.getEntryRouteById.mockResolvedValue(otherRoute);
    const response = await app.fetch(new Request('https://example.com/api/entry-routes/route-b', {
      method: 'DELETE',
    }), env);
    expect(response.status).toBe(404);
    expect(mocks.deleteEntryRoute).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/entry-routes/:id safety', () => {
  const ownRoute = {
    id: 'route-a', ref_code: 'a-ref', genre: null, name: '店頭QR', tag_id: null,
    scenario_id: null, redirect_url: null, pool_id: null, intro_template_id: null,
    run_account_friend_add_scenarios: 1, is_active: 1, tenant_id: 'tenant-a',
    line_account_id: 'account-a', created_at: '2026-09-16', updated_at: '2026-09-16',
  };

  beforeEach(() => {
    mocks.getEntryRouteById.mockResolvedValue(ownRoute);
    mocks.getLineAccountScopeEntries.mockResolvedValue([
      { id: 'account-a', tenant_id: 'tenant-a' },
    ] as never);
  });

  it('経路名の欠落・不一致は422で、DB削除を呼ばない', async () => {
    expect((await deleteRoute(ownRoute.id)).status).toBe(422);
    const mismatch = await deleteRoute(ownRoute.id, '店頭ＱＲ');
    expect(mismatch.status).toBe(422);
    expect(await mismatch.json()).toMatchObject({
      code: 'ENTRY_ROUTE_NAME_CONFIRMATION_MISMATCH',
    });
    expect(mocks.deleteEntryRoute).not.toHaveBeenCalled();
  });

  it('不正JSONも422へ倒し、DB削除を呼ばない', async () => {
    const response = await app.fetch(new Request(`https://example.com/api/entry-routes/${ownRoute.id}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{',
    }), env);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: 'ENTRY_ROUTE_NAME_CONFIRMATION_MISMATCH',
    });
    expect(mocks.deleteEntryRoute).not.toHaveBeenCalled();
  });

  it('利用履歴ありは409で、停止を案内して経路を残す', async () => {
    mocks.deleteEntryRoute.mockResolvedValue('in_use');
    const response = await deleteRoute(ownRoute.id, ownRoute.name);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'ENTRY_ROUTE_IN_USE',
      error: expect.stringContaining('受付停止'),
    });
    expect(mocks.deleteEntryRoute).toHaveBeenCalledWith(env.DB, ownRoute.id, ownRoute.name);
  });

  it('未利用かつ現在名が完全一致した場合だけ200にする', async () => {
    mocks.deleteEntryRoute.mockResolvedValue('deleted');
    const response = await deleteRoute(ownRoute.id, ownRoute.name);
    expect(response.status).toBe(200);
  });

  it('別accountの実在経路は404で、削除を呼ばない', async () => {
    mocks.getEntryRouteById.mockResolvedValue({ ...ownRoute, line_account_id: 'account-b' });
    const response = await deleteRoute(ownRoute.id, ownRoute.name);
    expect(response.status).toBe(404);
    expect(mocks.deleteEntryRoute).not.toHaveBeenCalled();
  });

  it('別accountの経路は受付停止への更新も0件にする', async () => {
    mocks.getEntryRouteById.mockResolvedValue({ ...ownRoute, line_account_id: 'account-b' });
    const response = await app.fetch(new Request(`https://example.com/api/entry-routes/${ownRoute.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    }), env);
    expect(response.status).toBe(404);
    expect(mocks.updateEntryRoute).not.toHaveBeenCalled();
  });

  it('権限なしstaffは完全削除・受付停止とも実在経路を読まず、書き込み0件にする', async () => {
    const staffApp = appForStaff('staff');
    const deletion = await staffApp.fetch(new Request(`https://example.com/api/entry-routes/${ownRoute.id}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationName: ownRoute.name }),
    }), env);
    const stop = await staffApp.fetch(new Request(`https://example.com/api/entry-routes/${ownRoute.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    }), env);
    expect(deletion.status).toBe(403);
    expect(stop.status).toBe(403);
    expect(mocks.getEntryRouteById).not.toHaveBeenCalled();
    expect(mocks.deleteEntryRoute).not.toHaveBeenCalled();
    expect(mocks.updateEntryRoute).not.toHaveBeenCalled();
  });

  it('inflow-links権限staffは自accountの編集・受付停止ができる', async () => {
    const staffApp = appForStaff('staff', ['/inflow-links']);
    mocks.getEntryRouteById.mockResolvedValue(ownRoute);
    mocks.updateEntryRoute.mockResolvedValue({ ...ownRoute, name: '店頭QR更新', is_active: 0 });

    const edit = await mutateWith(
      staffApp,
      'PATCH',
      `/api/entry-routes/${ownRoute.id}`,
      { name: ' 店頭QR更新 ' },
    );
    const stop = await mutateWith(
      staffApp,
      'PATCH',
      `/api/entry-routes/${ownRoute.id}`,
      { isActive: false },
    );

    expect(edit.status).toBe(200);
    expect(stop.status).toBe(200);
    expect(mocks.updateEntryRoute).toHaveBeenNthCalledWith(1, env.DB, ownRoute.id, { name: '店頭QR更新' });
    expect(mocks.updateEntryRoute).toHaveBeenNthCalledWith(2, env.DB, ownRoute.id, { isActive: false });
  });

  it('inflow-links権限staffでも別accountは404で書き込み0件にする', async () => {
    const staffApp = appForStaff('staff', ['/inflow-links']);
    mocks.getEntryRouteById.mockResolvedValue({ ...ownRoute, line_account_id: 'account-b' });

    const response = await mutateWith(
      staffApp,
      'PATCH',
      `/api/entry-routes/${ownRoute.id}`,
      { isActive: false },
    );

    expect(response.status).toBe(404);
    expect(mocks.updateEntryRoute).not.toHaveBeenCalled();
  });

  it('inflow-links権限staffでも完全削除は403で読み書き0件にする', async () => {
    const response = await mutateWith(
      appForStaff('staff', ['/inflow-links']),
      'DELETE',
      `/api/entry-routes/${ownRoute.id}`,
      { confirmationName: ownRoute.name },
    );

    expect(response.status).toBe(403);
    expect(mocks.getEntryRouteById).not.toHaveBeenCalled();
    expect(mocks.deleteEntryRoute).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'] as const)('%sは従来どおり受付停止できる', async (role) => {
    mocks.getEntryRouteById.mockResolvedValue(ownRoute);
    mocks.updateEntryRoute.mockResolvedValue({ ...ownRoute, is_active: 0 });
    const response = await mutateWith(
      appForStaff(role),
      'PATCH',
      `/api/entry-routes/${ownRoute.id}`,
      { isActive: false },
    );
    expect(response.status).toBe(200);
    expect(mocks.updateEntryRoute).toHaveBeenCalledWith(env.DB, ownRoute.id, { isActive: false });
  });
});

describe('entry route genre API', () => {
  it('lists independent genres, including genres with no links', async () => {
    mocks.getEntryRouteGenres.mockResolvedValue([
      { id: 'genre-1', name: 'A店', created_at: '2026-08-14', updated_at: '2026-08-14' },
    ]);
    const response = await app.fetch(new Request('https://example.com/api/entry-route-genres'), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [{ id: 'genre-1', name: 'A店' }] });
  });

  it('creates a trimmed genre', async () => {
    mocks.createEntryRouteGenre.mockResolvedValue({
      id: 'genre-1', name: 'A店', created_at: '2026-08-14', updated_at: '2026-08-14',
    });
    const response = await postGenre({ name: ' A店 ' });
    expect(response.status).toBe(201);
    expect(mocks.createEntryRouteGenre).toHaveBeenCalledWith(env.DB, 'A店');
  });

  it('renames a genre and returns the updated value', async () => {
    mocks.updateEntryRouteGenre.mockResolvedValue({
      id: 'genre-1', name: 'A店 SNS', created_at: '2026-08-14', updated_at: '2026-08-14',
    });
    const response = await patchGenre('genre-1', { name: ' A店 SNS ' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { id: 'genre-1', name: 'A店 SNS' } });
    expect(mocks.updateEntryRouteGenre).toHaveBeenCalledWith(env.DB, 'genre-1', 'A店 SNS');
  });
});

 it('returns full monthly funnel values', async () => {
  mocks.getEntryRouteById.mockResolvedValue({id:'r',tenant_id:'tenant-a'});
  mocks.getEntryRouteFunnel.mockResolvedValue({remainingCount:198,blockedCount:2,valuePerFriend:1200,monthly:[{month:'2026-10',friendAddCount:200}]});
  const response=await app.request('/api/entry-routes/r/funnel',{},env);
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({data:{remainingCount:198,monthly:[{friendAddCount:200}]}});
 });
