import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { health } from './health.js';
import type { Env } from '../worker-env.js';

vi.mock('@line-crm/db', () => ({
  getPlatformSetting: async () => 'false', // Explicit Off fixture for route authorization.
  getStaffByApiKey: vi.fn(async () => null),
  getAccountHealthLogs: vi.fn(async () => []),
  getLatestRiskLevel: vi.fn(async () => null),
  getLineAccountListStats: vi.fn(async () => ({})),
  getAccountMigrations: vi.fn(async () => []),
  getAccountMigrationById: vi.fn(async () => null),
  createAccountMigration: vi.fn(),
  updateAccountMigration: vi.fn(),
}));

vi.mock('../services/account-access.js', () => ({
  getVisibleLineAccountScope: vi.fn(async () => ({
    accounts: [],
    allowedAccountIds: [],
    canSeeUnassigned: false,
    ids: [],
    isAccountScoped: true,
  })),
}));

function env(): Env['Bindings'] {
  return {
    DB: {} as D1Database,
    IMAGES: {} as R2Bucket,
    RAW_MAIL: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 'secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    API_KEY: 'env-key',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'line-channel',
    LINE_LOGIN_CHANNEL_ID: 'login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://worker.example.test',
  };
}

function app() {
  const a = new Hono<Env>();
  a.use('*', authMiddleware);
  a.route('/', health);
  return a;
}

// 配備後の CLI が認証なしで到達を確認できるよう、liveness は資格情報なしで200を返す。
describe('liveness endpoints are public', () => {
  test.each(['/health', '/api/health'])('%s returns deployed SHA through auth middleware without secrets', async (path) => {
    const bindings = { ...env(), BUILD_GIT_COMMIT: 'a'.repeat(40), BUILD_VERSION: '0.24.0', BUILD_RELEASED_AT: '2026-10-09T00:00:00Z' };
    const res = await app().request(path, {}, bindings);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ success: true, data: {
      status: 'ok', git_commit: bindings.BUILD_GIT_COMMIT, version: '0.24.0', released_at: bindings.BUILD_RELEASED_AT,
    } });
  });
  test.each(['/health', '/api/health'])('GET %s → 200 without credentials', async (path) => {
    const res = await app().request(path, {}, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { status: string } };
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ok');
  });
});

describe('account health stays auth-guarded', () => {
  test('GET /api/accounts/:id/health without credentials → 401', async () => {
    const res = await app().request('/api/accounts/a1/health', {}, env());
    expect(res.status).toBe(401);
  });

  test('GET /api/accounts/health-summary without credentials → 401', async () => {
    const res = await app().request('/api/accounts/health-summary', {}, env());
    expect(res.status).toBe(401);
  });
});

describe('GET /api/accounts/health-summary', () => {
  test('staff可視範囲だけを1回で数え、ログ本文を返さない', async () => {
    const db = await import('@line-crm/db');
    const access = await import('../services/account-access.js');
    vi.mocked(access.getVisibleLineAccountScope).mockResolvedValue({
      accounts: [],
      allowedAccountIds: ['a1', 'a2'],
      canSeeUnassigned: false,
      ids: ['a1', 'a2'],
      isAccountScoped: true,
    });
    vi.mocked(db.getLineAccountListStats).mockResolvedValue({
      a1: { connection: { status: 'warn', issues: [{ kind: 'bot_info', httpStatus: 403 }] } },
      a9: { connection: { status: 'warn' } },
    } as unknown as Awaited<ReturnType<typeof db.getLineAccountListStats>>);

    const res = await app().request(
      '/api/accounts/health-summary',
      { headers: { Authorization: 'Bearer env-key' } },
      env(),
    );
    expect(res.status).toBe(200);
    expect(db.getLineAccountListStats).toHaveBeenCalledWith(expect.anything(), ['a1', 'a2']);
    const body = (await res.json()) as {
      success: boolean;
      data: {
        items: Array<{ lineAccountId: string; riskLevel: string | null }>;
        warningCount: number;
        dangerCount: number;
      };
    };
    expect(body.success).toBe(true);
    // a2 は記録なし → null で並ぶ。a9 は範囲外なので出ない。
    expect(body.data.items).toEqual([
      { lineAccountId: 'a1', riskLevel: 'danger' },
      { lineAccountId: 'a2', riskLevel: null },
    ]);
    expect(body.data.warningCount).toBe(0);
    expect(body.data.dangerCount).toBe(1);
    // ログ本文なし = logs という鍵を持たない。
    expect(JSON.stringify(body)).not.toContain('"logs"');
  });
});


test('health reports invalid retired payment key configuration', async () => {
  const a=new Hono<Env>(); a.route('/',health);
  const response=await a.request('/api/health',{}, {...env(),PURGED_PAYMENT_HMAC_PREVIOUS_SECRETS:'{bad'});
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({error:'purged_payment_key_configuration_invalid'});
});
