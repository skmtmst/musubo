import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';

const dbMocks = vi.hoisted(() => ({
  getDashboardOverview: vi.fn(),
  getLineAccounts: vi.fn(),
  getLineAccountScopeEntries: vi.fn(),
  getLineAccountsByIds: vi.fn(),
  getLineAccountById: vi.fn(),
  getDashboardPreference: vi.fn(),
  getDashboardDefaultPreference: vi.fn(),
  saveDashboardPreference: vi.fn(),
  deleteDashboardPreference: vi.fn(),
  saveDashboardDefaultPreference: vi.fn(),
  getListStats: vi.fn(),
  getStaffById: vi.fn(),
  getStaffAccountScopeIds: vi.fn(),
}));

vi.mock('@line-crm/db', () => ({
  ...dbMocks,
  dashboardFreshness: (
    asOf: string | null,
    options: { failedSources?: number; totalSources?: number } = {},
  ) => {
    const failed = options.failedSources ?? 0;
    const total = options.totalSources ?? 1;
    if (failed >= total || !asOf) return 'unavailable';
    return failed > 0 ? 'partial' : 'fresh';
  },
  summarizeDashboardFreshness: (sections: Record<string, { asOf: string | null; freshness: string }>) => {
    const values = Object.values(sections);
    const missing = values.filter((section) => section.freshness === 'unavailable').length;
    return {
      asOf: values.map((section) => section.asOf).find((value) => value !== null) ?? null,
      freshness: values.some((section) => section.freshness === 'partial')
        || (missing > 0 && missing < values.length)
        ? 'partial'
        : missing === values.length ? 'unavailable' : 'fresh',
    };
  },
}));

import { dashboard } from './dashboard.js';

const account = (id: string) => ({
  id, channel_id: id, name: id, channel_access_token: `${id}-token`,
  channel_secret: 'secret', is_active: 1, parent_line_account_id: null,
  official_profile_url: null, updated_at: '2026-08-26T10:00:00+09:00',
});

function app(tenantId?: string, role: 'owner' | 'admin' | 'staff' = 'staff') {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', {
      id: 'staff-1', name: '担当者', role, readOnly: false,
      assignedLineAccountId: 'account-1', canAccessDescendantAccounts: false,
      tenantId,
    });
    return next();
  });
  instance.route('/', dashboard);
  return instance;
}

function env(): Env['Bindings'] {
  return { DB: {} as D1Database, LINE_CHANNEL_ACCESS_TOKEN: 'env-token' } as Env['Bindings'];
}

function overview(delivery: Record<string, unknown> = {}) {
  return {
    delivery,
    asOf: '2026-08-26T10:00:00+09:00',
    freshness: 'fresh',
    partialFailures: [],
    sections: {
      quota: {
        status: 'unavailable', asOf: null, freshness: 'unavailable',
        reason: 'not_loaded', period: 'this-month',
      },
    },
    metrics: {
      activeFriends: {
        value: 0, state: 'empty', reason: null,
        asOf: '2026-08-26T10:00:00+09:00', period: 'latest',
      },
      monthlyQuota: {
        value: null, state: 'unavailable', reason: 'not_loaded', asOf: null, period: 'this-month',
      },
      friendTrend: {
        value: [], state: 'empty', reason: null,
        asOf: '2026-08-26T10:00:00+09:00', period: 'last7-fixed',
      },
      officialProfileUrl: {
        value: null, state: 'unavailable', reason: 'not_loaded', asOf: null, period: 'latest',
      },
    },
  };
}

describe('dashboard organization account policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
    dbMocks.getLineAccounts.mockResolvedValue([account('account-1'), account('account-2')]);
    dbMocks.getLineAccountScopeEntries.mockImplementation(async () =>
      dbMocks.getLineAccounts());
    dbMocks.getLineAccountsByIds.mockImplementation(async (_db, ids: string[]) => {
      const rows = await dbMocks.getLineAccounts();
      return rows.filter((row: { id: string }) => ids.includes(row.id));
    });
    dbMocks.getStaffById.mockResolvedValue({ account_scope: 'all' });
    dbMocks.getStaffAccountScopeIds.mockResolvedValue([]);
    dbMocks.getLineAccountById.mockImplementation(async (_db: unknown, id: string) => account(id));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('staff can select another account in the same organization', async () => {
    dbMocks.getDashboardOverview.mockResolvedValue(overview());
    const response = await app().request('/api/dashboard/overview?accountId=account-2', {}, env());
    expect(response.status).toBe(200);
    expect(dbMocks.getDashboardOverview).toHaveBeenCalledWith(expect.anything(), 'today', {
      allowedAccountIds: ['account-2'], includeUnassigned: false,
    }, {
      allowedAccountIds: ['account-2'], includeUnassigned: true,
    }, undefined);
  });

  test('30日の要求を今日へ戻さず、同じアカウント範囲で集計する', async () => {
    dbMocks.getDashboardOverview.mockResolvedValue(overview());
    const response = await app().request('/api/dashboard/overview?accountId=account-2&period=last30', {}, env());
    expect(response.status).toBe(200);
    expect(dbMocks.getDashboardOverview).toHaveBeenCalledWith(expect.anything(), 'last30', {
      allowedAccountIds: ['account-2'], includeUnassigned: false,
    }, { allowedAccountIds: ['account-2'], includeUnassigned: true }, undefined);
  });

  test('期間の入力を検査し、不正な値を今日に置き換えない', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T15:00:00Z'));
    try {
      for (const query of ['period=30d', 'period=custom', 'period=custom&from=2026-02-30&to=2026-03-01', 'period=custom&from=2026-11-16&to=2026-11-16', 'period=custom&from=2025-11-14&to=2026-11-15', 'period=custom&from=2026-11-15&to=2026-11-14']) {
        expect((await app().request(`/api/dashboard/overview?accountId=account-1&${query}`, {}, env())).status).toBe(400);
      }
      dbMocks.getDashboardOverview.mockResolvedValue(overview());
      const response = await app().request('/api/dashboard/overview?accountId=account-1&period=custom&from=2025-11-15&to=2026-11-15', {}, env());
      expect(response.status).toBe(200);
      expect(dbMocks.getDashboardOverview.mock.calls.at(-1)?.at(-1)).toEqual({ from: '2025-11-15', to: '2026-11-15' });
    } finally { vi.useRealTimers(); }
  });

  test('account-scoped staff cannot select an unassigned account', async () => {
    dbMocks.getStaffById.mockResolvedValue({ account_scope: 'accounts' });
    dbMocks.getStaffAccountScopeIds.mockResolvedValue(['account-1']);

    const response = await app().request('/api/dashboard/overview?accountId=account-2', {}, env());

    expect(response.status).toBe(404);
    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
    expect(dbMocks.getDashboardOverview).not.toHaveBeenCalled();
  });

  test('an explicit account is required instead of silently aggregating visible accounts', async () => {
    const response = await app().request('/api/dashboard/overview', {}, env());
    expect(response.status).toBe(400);
    expect(dbMocks.getDashboardOverview).not.toHaveBeenCalled();
  });

  test('list stats can be limited to the explicitly selected visible account', async () => {
    dbMocks.getListStats.mockResolvedValue({});
    const response = await app().request('/api/list-stats?accountId=account-1', {}, env());
    expect(response.status).toBe(200);
    expect(dbMocks.getListStats).toHaveBeenCalledWith(expect.anything(), {
      allowedAccountIds: ['account-1'], includeUnassigned: false,
    });
  });

  test('list stats reject an account outside the visible account scope', async () => {
    const response = await app().request('/api/list-stats?accountId=account-missing', {}, env());
    expect(response.status).toBe(404);
    expect(dbMocks.getListStats).not.toHaveBeenCalled();
  });

  test('non-default tenant uses only the explicitly selected account token for quota', async () => {
    dbMocks.getLineAccounts.mockResolvedValue([
      { ...account('account-1'), tenant_id: 'tenant-b' },
      { ...account('account-2'), tenant_id: 'tenant-a' },
    ]);
    dbMocks.getDashboardOverview.mockResolvedValue(overview({ sent: 12, broadcasts: 3 }));
    const response = await app('tenant-b').request('/api/dashboard/overview?accountId=account-1', {}, env());

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: { Authorization: 'Bearer account-1-token' },
    }));
    expect(dbMocks.getDashboardOverview).toHaveBeenCalledWith(expect.anything(), 'today', {
      allowedAccountIds: ['account-1'], includeUnassigned: false,
    }, {
      // tenant-b の担当者は未割り当て（MAIL）が見えない範囲のため、受信箱も LINE だけ。
      allowedAccountIds: ['account-1'], includeUnassigned: false,
    }, undefined);
    const body = await response.json() as { data: { delivery: Record<string, unknown> } };
    expect(body.data.delivery).toMatchObject({
      sent: 12, broadcasts: 3, quotaLimit: null, quotaUsed: null,
    });
  });

  test('returns real quota values and the configured official profile URL', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({
      ...account('account-1'),
      official_profile_url: 'https://lin.ee/nen-official',
    });
    dbMocks.getDashboardOverview.mockResolvedValue(overview());
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/quota')) return Response.json({ type: 'limited', value: 200 });
      return Response.json({ totalUsage: 3 });
    });

    const response = await app().request('/api/dashboard/overview?accountId=account-1', {}, env());
    const body = await response.json() as { data: ReturnType<typeof overview> };

    expect(response.status).toBe(200);
    expect(body.data.metrics.monthlyQuota).toMatchObject({
      value: { used: 3, limit: 200, remaining: 197 },
      state: 'available', reason: null, period: 'this-month',
    });
    expect(body.data.metrics.monthlyQuota.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.data.metrics.officialProfileUrl).toEqual({
      value: 'https://lin.ee/nen-official',
      state: 'available',
      reason: null,
      asOf: '2026-08-26T10:00:00+09:00',
      period: 'latest',
    });
  });

  test('unconfigured LINE connection returns null instead of a false zero', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({
      ...account('account-1'), channel_access_token: '', official_profile_url: null,
    });
    dbMocks.getDashboardOverview.mockResolvedValue(overview());

    const response = await app().request('/api/dashboard/overview?accountId=account-1', {}, env());
    const body = await response.json() as { data: ReturnType<typeof overview> };

    expect(response.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(body.data.metrics.monthlyQuota).toMatchObject({
      value: null, state: 'unavailable', reason: 'not_connected', asOf: null,
    });
    expect(body.data.metrics.officialProfileUrl).toMatchObject({
      value: null, state: 'unavailable', reason: 'not_connected', asOf: null,
    });
  });

  test('LINE quota failure returns null and records a partial failure', async () => {
    dbMocks.getDashboardOverview.mockResolvedValue(overview());
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));

    const response = await app().request('/api/dashboard/overview?accountId=account-1', {}, env());
    const body = await response.json() as { data: ReturnType<typeof overview> };

    expect(response.status).toBe(200);
    expect(body.data.metrics.monthlyQuota).toMatchObject({
      value: null, state: 'unavailable', reason: 'fetch_failed', asOf: null,
    });
    expect(body.data.sections.quota).toMatchObject({
      status: 'unavailable', freshness: 'unavailable', reason: 'fetch_failed', asOf: null,
    });
    expect(body.data.partialFailures).toContain('quota');
  });

  test('organization quotaの一部取得失敗はokや全体成功に見せずpartial', async () => {
    dbMocks.getLineAccounts.mockResolvedValue([
      { ...account('account-1'), tenant_id: 'tenant-b' },
      { ...account('account-2'), tenant_id: 'tenant-b' },
    ]);
    dbMocks.getDashboardOverview.mockResolvedValue(overview());
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
      if (authorization.includes('account-2-token')) return new Response(null, { status: 503 });
      return String(input).endsWith('/quota')
        ? Response.json({ type: 'limited', value: 100 })
        : Response.json({ totalUsage: 1 });
    });

    const response = await app('tenant-b', 'owner').request(
      '/api/dashboard/organization-overview', {}, env(),
    );
    const body = await response.json() as { data: ReturnType<typeof overview> };

    expect(response.status).toBe(200);
    expect(body.data.sections.quota).toMatchObject({
      status: 'partial', freshness: 'partial', reason: 'fetch_failed',
    });
    expect(body.data.metrics.monthlyQuota).toMatchObject({
      value: null, state: 'partial', reason: 'fetch_failed',
    });
    expect(body.data.partialFailures).toContain('quota');
    expect(body.data.freshness).toBe('partial');
  });

  test('loads the signed-in staff preference for the selected account', async () => {
    dbMocks.getDashboardPreference.mockResolvedValue({
      version: 2,
      cards: JSON.stringify({
        today: [{ id: 'today-inbox', visible: true }],
        main: [{ id: 'friend-trend', visible: true }],
        right: [{ id: 'send-quota', visible: true }],
      }),
      updated_at: '2026-08-26T10:00:00+09:00',
    });
    const response = await app().request('/api/dashboard/preferences?account_id=account-1', {}, env());
    expect(response.status).toBe(200);
    expect(dbMocks.getDashboardPreference).toHaveBeenCalledWith(expect.anything(), 'staff-1', 'account-1');
    expect(await response.json()).toMatchObject({ data: { source: 'personal', version: 2 } });
  });

  test('accepts every card the editor can send, including support-mark-status (DASH-01)', async () => {
    /*
     * 画面のカード定義とAPIの許可一覧が別々だと、画面が必ず送るIDを
     * APIが拒否して全保存が400になる。共有定義の全IDをそのまま送る。
     */
    const { DASHBOARD_CARD_GROUPS } = await import('@line-crm/shared');
    const cards = Object.fromEntries(
      Object.entries(DASHBOARD_CARD_GROUPS).map(([group, ids]) => [
        group,
        ids.map((id) => ({ id, visible: true })),
      ]),
    );
    // 上限超過で弾かれないよう、today は4件だけONにする。
    cards.today = cards.today.map((item, index) => ({ ...item, visible: index < 4 }));
    dbMocks.saveDashboardPreference.mockResolvedValue({
      status: 'saved',
      row: { version: 3, updated_at: '2026-08-26T10:00:00+09:00' },
    });
    const response = await app().request('/api/dashboard/preferences?account_id=account-1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, cards }),
    }, env());
    expect(response.status).toBe(200);
    expect(dbMocks.saveDashboardPreference).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ staffId: 'staff-1', lineAccountId: 'account-1', expectedVersion: 2 }),
    );
  });

  test('keeps unknown cards as hidden instead of rejecting the whole save', async () => {
    /*
     * 機能OFF・廃止で候補から外れたIDが残っていても、編集保存全体を
     * 400にしない。未知IDは visible=false で保持し、表示には使わない。
     */
    dbMocks.saveDashboardPreference.mockResolvedValue({
      status: 'saved',
      row: { version: 3, updated_at: '2026-08-26T10:00:00+09:00' },
    });
    const response = await app().request('/api/dashboard/preferences?account_id=account-1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        cards: {
          today: [{ id: 'today-inbox', visible: true }],
          main: [{ id: 'retired-card', visible: true }],
          right: [],
        },
      }),
    }, env());
    expect(response.status).toBe(200);
    expect(dbMocks.saveDashboardPreference).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cards: {
          today: [{ id: 'today-inbox', visible: true }],
          main: [{ id: 'retired-card', visible: false }],
          right: [],
        },
      }),
    );
  });

  test('rejects malformed cards instead of persisting arbitrary JSON', async () => {
    const badBodies = [
      { today: [{ id: 1, visible: true }], main: [], right: [] },
      { today: [{ id: 'today-inbox', visible: 'yes' }], main: [], right: [] },
      {
        today: [
          { id: 'today-inbox', visible: true },
          { id: 'today-inbox', visible: false },
        ],
        main: [],
        right: [],
      },
    ];
    for (const cards of badBodies) {
      const response = await app().request('/api/dashboard/preferences?account_id=account-1', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 0, cards }),
      }, env());
      expect(response.status).toBe(400);
    }
    expect(dbMocks.saveDashboardPreference).not.toHaveBeenCalled();
  });

  test('organization quota fetch runs at most five accounts at a time', async () => {
    const accounts = Array.from({ length: 12 }, (_, index) => ({
      ...account(`account-${index + 1}`), tenant_id: 'tenant-b',
    }));
    dbMocks.getLineAccounts.mockResolvedValue(accounts);
    dbMocks.getDashboardOverview.mockResolvedValue(overview());
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(fetch).mockImplementation(async (input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const url = String(input);
      return url.endsWith('/quota')
        ? Response.json({ type: 'limited', value: 100 })
        : Response.json({ totalUsage: 1 });
    });

    const response = await app('tenant-b', 'owner').request('/api/dashboard/organization-overview', {}, env());
    const body = await response.json() as { data: ReturnType<typeof overview> };

    expect(response.status).toBe(200);
    /* 12件×2口=24回は全部取りに行くが、同時は5件ぶん(10口)までに抑える。 */
    expect(fetch).toHaveBeenCalledTimes(24);
    expect(maxInFlight).toBeLessThanOrEqual(10);
    expect(body.data.metrics.monthlyQuota).toMatchObject({
      value: { used: 12, limit: 1200, remaining: 1188 },
      state: 'available', reason: null,
    });
  });

  test('organization totals are available only to owners and stay inside their tenant', async () => {
    dbMocks.getLineAccounts.mockResolvedValue([
      { ...account('account-1'), tenant_id: 'tenant-b' },
      { ...account('account-2'), tenant_id: 'tenant-a' },
    ]);
    dbMocks.getDashboardOverview.mockResolvedValue(overview());
    expect((await app('tenant-b').request('/api/dashboard/organization-overview', {}, env())).status).toBe(403);

    const response = await app('tenant-b', 'owner').request('/api/dashboard/organization-overview', {}, env());
    expect(response.status).toBe(200);
    expect(dbMocks.getDashboardOverview).toHaveBeenCalledWith(expect.anything(), 'today', {
      allowedAccountIds: ['account-1'], includeUnassigned: false,
    }, {
      allowedAccountIds: ['account-1'], includeUnassigned: false,
    }, undefined);
  });
});
