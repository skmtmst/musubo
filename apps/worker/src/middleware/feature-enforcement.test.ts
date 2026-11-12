import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';

const mocks = vi.hoisted(() => ({
  getAccountSetting: vi.fn(),
  getVersionedAccountSetting: vi.fn(),
  getVisibleLineAccountScope: vi.fn(),
  accountFeatureAvailability: vi.fn(),
}));

vi.mock('@line-crm/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@line-crm/db')>(),
  getAccountSetting: mocks.getAccountSetting,
  getVersionedAccountSetting: mocks.getVersionedAccountSetting,
}));

vi.mock('../services/account-access.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/account-access.js')>(),
  getVisibleLineAccountScope: mocks.getVisibleLineAccountScope,
}));

vi.mock('../services/feature-enforcement.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/feature-enforcement.js')>(),
  accountFeatureAvailability: mocks.accountFeatureAvailability,
}));

import { featureEnforcementMiddleware } from './feature-enforcement.js';

function testApp(handler = vi.fn((c) => c.json({ success: true }))) {
  const app = new Hono<Env>();
  app.use('/api/*', async (c, next) => {
    c.set('staff', {
      id: 'staff-1', name: '管理者', role: 'owner', readOnly: false,
      assignedLineAccountId: null, canAccessDescendantAccounts: true,
    });
    await next();
  });
  app.use('/api/*', featureEnforcementMiddleware);
  app.get('/api/webinars', handler);
  app.post('/api/webinars', handler);
  app.get('/api/broadcasts', handler);
  app.post('/api/broadcasts', handler);
  app.get('/api/settings/features', handler);
  app.get('/api/instagram/connection', handler);
  app.post('/api/instagram/oauth/start', handler);
  app.post('/api/instagram/refresh', handler);
  app.delete('/api/instagram/connection', handler);
  app.get('/api/instagram/messages', handler);
  app.get('/api/restaurant-test/google/connection', handler);
  app.post('/api/restaurant-test/google/connect/start', handler);
  app.get('/api/restaurant-test/google/profile', handler);
  app.get('/api/restaurant-test/google/hours/workspace', handler);
  app.get('/api/restaurant-test/google/reviews', handler);
  app.get('/api/not-in-manifest', handler);
  app.post('/api/nen/rank-settings/initialize', handler);
  return { app, handler };
}

const env = { DB: {} as D1Database } as Env['Bindings'];

describe('featureEnforcementMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVersionedAccountSetting.mockResolvedValue(null);
    mocks.getVisibleLineAccountScope.mockResolvedValue({ ids: ['account-1'], all: true });
    mocks.accountFeatureAvailability.mockImplementation(async (_db, accountId, featureId) => {
      const bundle = await mocks.getVersionedAccountSetting(_db, accountId, 'feature.settings_bundle_v1');
      const bundled = bundle?.data?.features?.[featureId];
      const raw = typeof bundled === 'boolean'
        ? bundled
        : JSON.parse((await mocks.getAccountSetting(_db, accountId, `feature.${featureId}`)) ?? 'false').enabled;
      return {
        featureId,
        contractAvailable: true,
        companyEnabled: raw,
        dependenciesEnabled: true,
        effectiveEnabled: raw,
        reason: raw ? null : 'company_disabled',
        message: raw ? null : 'この機能は設定でオフになっています',
        disabledDependencies: [],
      };
    });
  });

  test.each([
    ['GET', '/api/instagram/connection'],
    ['POST', '/api/instagram/oauth/start'],
    ['POST', '/api/instagram/refresh'],
    ['DELETE', '/api/instagram/connection'],
    ['GET', '/api/restaurant-test/google/connection'],
    ['POST', '/api/restaurant-test/google/connect/start'],
    ['GET', '/api/restaurant-test/google/profile'],
    ['GET', '/api/restaurant-test/google/hours/workspace'],
  ])('%s %s は機能オフでもSNS接続設定を開ける', async (method, path) => {
    mocks.getAccountSetting.mockResolvedValue(JSON.stringify({ enabled: false }));
    const { app, handler } = testApp();
    const response = await app.request(`${path}?lineAccountId=account-1`, { method }, env);
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(mocks.accountFeatureAvailability).not.toHaveBeenCalled();
  });

  test.each([
    ['/api/instagram/messages', 'external_integrations'],
    ['/api/restaurant-test/google/reviews', 'restaurant_test'],
  ])('%s の利用は引き続き機能オフで止まる', async (path, featureId) => {
    mocks.getAccountSetting.mockResolvedValue(JSON.stringify({ enabled: false }));
    const { app, handler } = testApp();
    const response = await app.request(`${path}?lineAccountId=account-1`, {}, env);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FEATURE_DISABLED', featureId });
    expect(handler).not.toHaveBeenCalled();
  });

  test('EC機能オフの店では初期ランクを作れない', async () => {
    mocks.getAccountSetting.mockResolvedValue(JSON.stringify({ enabled: false }));
    const { app, handler } = testApp();
    const response = await app.request('/api/nen/rank-settings/initialize', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'account-1' }),
    }, env);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FEATURE_DISABLED', featureId: 'ec_commerce' });
    expect(handler).not.toHaveBeenCalled();
  });

  test('会社設定がオフなら handler を実行せず 403 + FEATURE_DISABLED を返す', async () => {
    mocks.getAccountSetting.mockResolvedValue(JSON.stringify({ enabled: false }));
    const { app, handler } = testApp();
    const response = await app.request('/api/webinars?account_id=account-1', {}, env);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: 'この機能は設定でオフになっています',
      code: 'FEATURE_DISABLED',
      featureId: 'webinars',
      reason: 'company_disabled',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test.each([
    {
      reason: 'contract_unavailable',
      code: 'FEATURE_NOT_ENTITLED',
      message: 'ご契約ではこの機能を利用できません',
    },
    {
      reason: 'dependency_disabled',
      code: 'FEATURE_DEPENDENCY_DISABLED',
      message: '必要な機能がオフになっているため利用できません',
    },
  ])('$reason は理由別の403を返し handler を実行しない', async ({ reason, code, message }) => {
    mocks.accountFeatureAvailability.mockResolvedValue({
      featureId: 'broadcasts',
      contractAvailable: reason !== 'contract_unavailable',
      companyEnabled: true,
      dependenciesEnabled: reason !== 'dependency_disabled',
      effectiveEnabled: false,
      reason,
      message,
      disabledDependencies: reason === 'dependency_disabled' ? ['templates'] : [],
    });
    const { app, handler } = testApp();
    const response = await app.request('/api/broadcasts?account_id=account-1', {
      method: reason === 'contract_unavailable' ? 'POST' : 'GET',
    }, env);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      success: false,
      error: message,
      code,
      featureId: 'broadcasts',
      reason,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test('契約だけが停止理由なら閲覧GETは従来処理へ進む', async () => {
    mocks.accountFeatureAvailability.mockResolvedValue({
      featureId: 'broadcasts',
      contractAvailable: false,
      companyEnabled: true,
      dependenciesEnabled: true,
      effectiveEnabled: false,
      reason: 'contract_unavailable',
      message: 'ご契約ではこの機能を利用できません',
      disabledDependencies: [],
    });
    const { app, handler } = testApp();
    const response = await app.request('/api/broadcasts?account_id=account-1', {}, env);

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  test('会社設定がオンなら従来の handler と入力契約へ進む', async () => {
    mocks.getVersionedAccountSetting.mockResolvedValue({
      version: 2,
      data: { features: { webinars: true } },
    });
    const handler = vi.fn((c) => c.json({ success: false, code: 'CONTRACT_ERROR' }, 422));
    const { app } = testApp(handler);
    const response = await app.request('/api/webinars?accountId=account-1', {}, env);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ success: false, code: 'CONTRACT_ERROR' });
    expect(handler).toHaveBeenCalledOnce();
  });

  test('機能付き管理 API の account 未指定を既定値へ寄せない', async () => {
    mocks.getVisibleLineAccountScope.mockResolvedValue({ ids: ['account-1', 'account-2'], all: true });
    const { app, handler } = testApp();
    const response = await app.request('/api/webinars', { method: 'POST' }, env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'LINE_ACCOUNT_REQUIRED' });
    expect(handler).not.toHaveBeenCalled();
  });

  test('複数 account の GET 一覧はオフ分を可視範囲から除き meta に件数を返す', async () => {
    mocks.getVisibleLineAccountScope.mockResolvedValue({
      ids: ['account-1', 'account-2'],
      allowedAccountIds: ['account-1', 'account-2'],
      accounts: [],
      canSeeUnassigned: false,
      isAccountScoped: false,
    });
    mocks.getAccountSetting.mockImplementation(async (_db, accountId) => (
      accountId === 'account-1' ? '{"enabled":true}' : '{"enabled":false}'
    ));
    const handler = vi.fn((c) => c.json({
      success: true,
      data: c.get('staff').featureEnabledLineAccountIds,
    }));
    const { app } = testApp(handler);
    const response = await app.request('/api/webinars', {}, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: ['account-1'],
      meta: { featureDisabledAccounts: 1 },
    });
  });

  test('可視 account が0件の GET 一覧は構造化403を返す', async () => {
    mocks.getVisibleLineAccountScope.mockResolvedValue({
      ids: [],
      allowedAccountIds: [],
      accounts: [],
      canSeeUnassigned: false,
      isAccountScoped: true,
    });
    const { app, handler } = testApp();
    const response = await app.request('/api/broadcasts', {}, env);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'FEATURE_DISABLED',
      featureId: 'broadcasts',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test.each(['account_id', 'accountId', 'line_account_id', 'lineAccountId'])(
    '本文の %s で指定した店舗の機能設定を確認する', async key => {
      mocks.getAccountSetting.mockResolvedValue(JSON.stringify({ enabled: true }));
      const { app, handler } = testApp();
      const response = await app.request('/api/webinars', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [key]: '  account-1  ' }),
      }, env);

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
      expect(mocks.accountFeatureAvailability).toHaveBeenCalledWith(
        env.DB, 'account-1', 'webinars', expect.anything(),
      );
    },
  );

  test('URL と本文の店舗が違えば処理せず拒否する', async () => {
    const { app, handler } = testApp();
    const response = await app.request('/api/webinars?account_id=account-query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-body' }),
    }, env);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'LINE_ACCOUNT_MISMATCH' });
    expect(handler).not.toHaveBeenCalled();
    expect(mocks.accountFeatureAvailability).not.toHaveBeenCalled();
  });

  test('core API は機能設定に関係なく従来処理へ進む', async () => {
    const { app, handler } = testApp();
    const response = await app.request('/api/settings/features', {}, env);

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(mocks.getAccountSetting).not.toHaveBeenCalled();
  });

  test('manifest 完成後の未知管理 API は runtime でも fail closed', async () => {
    const { app, handler } = testApp();
    const response = await app.request('/api/not-in-manifest', {}, env);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'ROUTE_FEATURE_UNCLASSIFIED' });
    expect(handler).not.toHaveBeenCalled();
  });
});
