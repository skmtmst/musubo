import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { unhandledWorkerError } from '../lib/unhandled-error.js';

const report = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../services/codex-slack-relay.js', () => ({ reportHarnessErrorToSlack: report }));

const mocks = {
  ANALYTICS_REPORT_SECTIONS: ['friends', 'reactions', 'routes', 'usage', 'mileage'],
  DEFAULT_TENANT_ID: 'tenant-default',
  getDailyMessageCounts: vi.fn(),
  getTrackedLinkStats: vi.fn(),
  getLinkClickSummary: vi.fn(),
  getBroadcastSummary: vi.fn(),
  getFunnelsWithCurrentVersions: vi.fn(),
  getLegacyFunnels: vi.fn(),
  getFunnelById: vi.fn(),
  getFunnelSteps: vi.fn(),
  createFunnel: vi.fn(),
  deleteFunnel: vi.fn(),
  countFunnelStep: vi.fn(),
  createVersionedFunnel: vi.fn(),
  createFunnelVersion: vi.fn(),
  getFunnelWithCurrentVersion: vi.fn(),
  setFunnelStatus: vi.fn(),
  runChronologicalFunnel: vi.fn(),
  getLatestFunnelRun: vi.fn(),
  createFunnelResultAudience: vi.fn(),
  createAnalyticsCrossRun: vi.fn(),
  getAnalyticsCrossRun: vi.fn(),
  getAnalyticsFriendsOverview: vi.fn(),
  getAnalyticsReactionsOverview: vi.fn(),
  getAnalyticsRoutesOverview: vi.fn(),
  getAnalyticsUrlClicksOverview: vi.fn(),
  getAnalyticsUsageOverview: vi.fn(),
  createSavedAnalyticsFromResult: vi.fn(),
  getSavedAnalytics: vi.fn(),
  getSavedAnalyticsSnapshots: vi.fn(),
  getAnalyticsReportSchedules: vi.fn(),
  getRecentOneTimeAnalyticsReportRuns: vi.fn(async () => []),
  getAnalyticsReportSchedule: vi.fn(),
  getAnalyticsReportScheduleIncludingArchived: vi.fn(),
  getAnalyticsReportRuns: vi.fn(),
  requeueOneTimeAnalyticsReportSchedule: vi.fn(),
  createAnalyticsReportSchedule: vi.fn(),
  updateAnalyticsReportSchedule: vi.fn(),
  setAnalyticsReportScheduleStatus: vi.fn(),
  getStaffMembers: vi.fn(),
  createAnalyticsCrossAudience: vi.fn(),
  addConversionDefinitionUsage: vi.fn(),
  getCurrentFunnelVersion: vi.fn(),
  getLineAccountById: vi.fn(),
  getLineAccounts: vi.fn(),
  getLineAccountScopeEntries: vi.fn(async (...args: unknown[]) => mocks.getLineAccounts(...args)),
  getStaffById: vi.fn(),
  getStaffAccountScopeIds: vi.fn(),
  FUNNEL_STEP_KINDS: [
    'tag',
    'field',
    'form',
    'site_event',
    'purchase',
    'link_click',
    'conversion',
  ],
  buildFunnelResult: (
    steps: Array<{ step_order: number; label: string }>,
    reached: string[][],
  ) =>
    steps.map((s, i) => ({
      stepOrder: s.step_order,
      label: s.label,
      reached: reached[i]?.length ?? 0,
      conversionFromPrevious: 1,
    })),
};
vi.mock('@line-crm/db', () => mocks);

const { analytics, readAnalyticsOverviewRange } = await import('./analytics.js');

const app = new Hono<Env>();
app.use('*', async (c, next) => {
  c.set('staff', { id: 'u-1', name: 'テスト', role: 'owner', readOnly: false });
  return next();
});
app.route('/', analytics);
app.onError(unhandledWorkerError);
const staffApp = new Hono<Env>();
staffApp.use('*', async (c, next) => {
  c.set('staff', {
    id: 'staff-1', name: '担当者', role: 'staff', readOnly: false,
    permissionKeys: ['/analytics'], assignedLineAccountId: 'account-a',
    canAccessDescendantAccounts: false,
  });
  return next();
});
staffApp.route('/', analytics);
staffApp.onError(unhandledWorkerError);
// 実行間隔ガード(点検の中4)が読む最小の入れ物。テストごとに中身を変える。
const guardRows: { crossBusy: { id: string } | null; lastFunnelRunAt: string | null } = {
  crossBusy: null,
  lastFunnelRunAt: null,
};
const env = {
  DB: {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          if (sql.includes('FROM analytics_cross_runs')) return guardRows.crossBusy;
          if (sql.includes('FROM analytics_funnel_runs')) {
            return guardRows.lastFunnelRunAt ? { created_at: guardRows.lastFunnelRunAt } : null;
          }
          return null;
        },
      }),
    }),
  } as unknown as D1Database,
};

function req(path: string, method = 'GET', body?: unknown) {
  return app.fetch(
    new Request(`https://example.com${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
}

function reqAsStaff(path: string, method = 'GET', body?: unknown) {
  return staffApp.fetch(
    new Request(`https://example.com${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
}

async function expectUnhandledFailure(response: Response, path: string) {
  expect(response.status).toBe(500);
  const body = await response.json() as { incidentId: string };
  expect(body).toEqual({ success: false, error: 'Internal Server Error', incidentId: expect.any(String) });
  expect(body.incidentId).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.stringify(body)).not.toMatch(/D1 unavailable|db down/);
  expect(report).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    source: 'worker', message: 'unhandled_worker_error', path: `GET ${path}`, incidentId: body.incidentId,
  });
}

const FUNNEL = { id: 'fn-1', line_account_id: 'account-a', name: '購入まで', segment_json: null, window_days: 30, created_at: '2026-08-16', status: 'active' };

beforeEach(() => {
  vi.clearAllMocks();
  guardRows.crossBusy = null;
  guardRows.lastFunnelRunAt = null;
  mocks.getStaffById.mockResolvedValue({ account_scope: 'all' });
  mocks.getStaffAccountScopeIds.mockResolvedValue([]);
  mocks.getDailyMessageCounts.mockResolvedValue([]);
  mocks.getTrackedLinkStats.mockResolvedValue([]);
  mocks.getLinkClickSummary.mockResolvedValue([]);
  mocks.getBroadcastSummary.mockResolvedValue([]);
  mocks.getFunnelsWithCurrentVersions.mockResolvedValue({
    items: [{
      ...FUNNEL,
      currentVersion: {
        id: 'fv-1', versionNumber: 1, createdAt: '2026-08-01T00:00:00.000Z',
      },
    }],
    total: 1,
    page: 1,
    pageSize: 200,
  });
  mocks.getLegacyFunnels.mockResolvedValue([FUNNEL]);
  mocks.getFunnelById.mockResolvedValue(FUNNEL);
  mocks.getFunnelSteps.mockResolvedValue([
    { id: 's1', funnel_id: 'fn-1', step_order: 1, label: '友だち追加', kind: 'tag', match_json: '{}' },
    { id: 's2', funnel_id: 'fn-1', step_order: 2, label: '購入', kind: 'conversion', match_json: '{}' },
  ]);
  mocks.createFunnel.mockResolvedValue(FUNNEL);
  mocks.countFunnelStep.mockResolvedValue(['f-1', 'f-2']);
  mocks.createVersionedFunnel.mockResolvedValue({
    funnelId: 'fn-v6', version: { id: 'fv-1', versionNumber: 1 },
  });
  mocks.createFunnelVersion.mockResolvedValue({ id: 'fv-2', versionNumber: 2 });
  mocks.runChronologicalFunnel.mockResolvedValue({
    runId: 'run-1', state: 'available', stateReason: null,
    dataCutoffAt: '2026-08-26T00:00:00.000Z',
    groups: [{
      key: 'all', label: '全体', entrants: 2, completed: 1,
      steps: [
        { stepOrder: 1, label: '友だち追加', reached: 2, conversionFromPrevious: 1 },
        { stepOrder: 2, label: '購入', reached: 1, conversionFromPrevious: 0.5 },
      ],
    }],
  });
  mocks.getLatestFunnelRun.mockResolvedValue({
    runId: 'run-1', state: 'available', stateReason: null,
    dataCutoffAt: '2026-08-26T00:00:00.000Z',
    groups: [{
      key: 'all', label: '全体', entrants: 2, completed: 1,
      steps: [
        { stepOrder: 1, label: '友だち追加', reached: 2, conversionFromPrevious: 1 },
        { stepOrder: 2, label: '購入', reached: 1, conversionFromPrevious: 0.5 },
      ],
    }],
  });
  mocks.createFunnelResultAudience.mockResolvedValue({
    id: 'audience-1', memberCount: 1, expiresAt: '2026-08-27T00:00:00.000Z',
  });
  mocks.createAnalyticsCrossRun.mockResolvedValue({ id: 'cross-1', state: 'pending' });
  mocks.getAnalyticsCrossRun.mockResolvedValue({
    id: 'cross-1', state: 'available', errorCode: null,
    result: { state: 'available', cells: [], totalValue: 0 },
    createdAt: '2026-08-26T00:00:00.000Z',
    queuePosition: null, pendingAhead: 0, estimatedWaitMs: null, nextTickAt: null,
  });
  mocks.getAnalyticsFriendsOverview.mockResolvedValue({ lineAccountId: 'account-a', data: {} });
  mocks.getAnalyticsReactionsOverview.mockResolvedValue({ lineAccountId: 'account-a', data: {} });
  mocks.getAnalyticsRoutesOverview.mockResolvedValue({ lineAccountId: 'account-a', data: {} });
  mocks.getAnalyticsUrlClicksOverview.mockResolvedValue({ lineAccountId: 'account-a', data: {} });
  mocks.getAnalyticsUsageOverview.mockResolvedValue({ lineAccountId: 'account-a', data: {} });
  mocks.createSavedAnalyticsFromResult.mockResolvedValue({
    id: 'saved-1', versionId: 'saved-version-1', snapshotId: 'snapshot-1',
  });
  mocks.getSavedAnalytics.mockResolvedValue([]);
  mocks.getSavedAnalyticsSnapshots.mockResolvedValue([]);
  mocks.getAnalyticsReportSchedules.mockResolvedValue([]);
  mocks.createAnalyticsReportSchedule.mockImplementation(async (_db, input) => ({
    id: 'report-1', ...input, status: 'active', isOneTime: Boolean(input.isOneTime),
    lineAccountId: input.lineAccountId, createdAt: input.now, updatedAt: input.now,
  }));
  mocks.getAnalyticsReportSchedule.mockResolvedValue(null);
  mocks.getAnalyticsReportScheduleIncludingArchived.mockResolvedValue(null);
  mocks.getAnalyticsReportRuns.mockResolvedValue([]);
  mocks.requeueOneTimeAnalyticsReportSchedule.mockResolvedValue('requeued');
  mocks.updateAnalyticsReportSchedule.mockResolvedValue('updated');
  mocks.setAnalyticsReportScheduleStatus.mockResolvedValue('updated');
  mocks.getStaffMembers.mockResolvedValue([
    { id: 'u-1', name: 'テスト', role: 'owner', email: 'owner@example.com', line_user_id: 'U1', is_active: 1, invite_status: 'active', account_scope: 'all' },
  ]);
  mocks.createAnalyticsCrossAudience.mockResolvedValue({
    id: 'audience-cross-1', memberCount: 2, expiresAt: '2026-08-27T00:00:00.000Z',
  });
  mocks.getCurrentFunnelVersion.mockResolvedValue({
    id: 'fv-1', versionNumber: 1, createdAt: '2026-08-01T00:00:00.000Z',
  });
  mocks.getLineAccountById.mockResolvedValue({ id: 'account-a', timezone: 'Asia/Tokyo' });
  mocks.getLineAccounts.mockResolvedValue([
    { id: 'account-a', tenant_id: null },
    { id: 'account-b', tenant_id: 'other-tenant' },
  ]);
});

const ACCOUNT = 'account_id=account-a';

describe('期間の指定', () => {
  it('省略すると直近30日になる', async () => {
    const res = await req(`/api/analytics/messages?${ACCOUNT}`);
    expect(res.status).toBe(200);
    const [, accountId, range] = mocks.getDailyMessageCounts.mock.calls[0];
    expect(accountId).toBe('account-a');
    expect(range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('終了日はその日いっぱいを含める', async () => {
    // '2026-08-16' で切ると、その日のぶんがまるごと落ちる。
    await req(`/api/analytics/messages?${ACCOUNT}&from=2026-08-01&to=2026-08-16`);
    const [, , range] = mocks.getDailyMessageCounts.mock.calls[0];
    expect(range.to).toBe('2026-08-16T23:59:59.999');
  });

  it('形が違えば弾く', async () => {
    const res = await req(`/api/analytics/messages?${ACCOUNT}&from=2026/08/01`);
    expect(res.status).toBe(400);
    expect(mocks.getDailyMessageCounts).not.toHaveBeenCalled();
  });

  it('開始と終了が逆なら弾く', async () => {
    const res = await req(`/api/analytics/messages?${ACCOUNT}&from=2026-08-20&to=2026-08-01`);
    expect(res.status).toBe(400);
  });

  it('長すぎる期間は弾く', async () => {
    // 期間を長くするほど走査する行が増える。
    const res = await req(`/api/analytics/messages?${ACCOUNT}&from=2020-01-01&to=2026-08-16`);
    expect(res.status).toBe(400);
  });
});

describe('分析の概要API', () => {
  it('既定はアカウントの現地日付で30日、夏時間の日境界も保つ', () => {
    const result = readAnalyticsOverviewRange(
      () => undefined,
      'America/New_York',
      new Date('2026-03-20T12:00:00.000Z'),
    );
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        fromDate: '2026-02-19',
        toDate: '2026-03-20',
        from: '2026-02-19T05:00:00.000Z',
        toExclusive: '2026-03-21T04:00:00.000Z',
      }),
    });
  });

  it.each([
    ['friends', 'getAnalyticsFriendsOverview'],
    ['reactions', 'getAnalyticsReactionsOverview'],
    ['routes', 'getAnalyticsRoutesOverview'],
    ['usage', 'getAnalyticsUsageOverview'],
  ] as const)('%s は選択中アカウントと期間を渡す', async (path, mockName) => {
    const res = await req(
      `/api/analytics/${path}?${ACCOUNT}&from=2026-08-01&to=2026-08-30`,
    );
    expect(res.status).toBe(200);
    expect(mocks[mockName]).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        lineAccountId: 'account-a',
        timeZone: 'Asia/Tokyo',
        fromDate: '2026-08-01',
        toDate: '2026-08-30',
        from: '2026-07-31T15:00:00.000Z',
        toExclusive: '2026-08-30T15:00:00.000Z',
      }),
    );
  });

  it('使われ方は参照切れの0・partial・failedと確認時刻を変えずに返す', async () => {
    mocks.getAnalyticsUsageOverview.mockResolvedValueOnce({
      lineAccountId: 'account-a',
      timeZone: 'Asia/Tokyo',
      period: { from: '2026-08-01', to: '2026-08-30' },
      dataCutoffAt: '2026-08-30T16:00:00.000Z',
      data: {
        state: 'partial',
        stateReason: '一部の参照を確認できません',
        checkedAt: '2026-08-30T16:00:00.000Z',
        automaticDeletion: false,
        summary: {
          brokenReferences: {
            value: 1,
            state: 'partial',
            reason: '確認できた分類だけの合計です',
          },
        },
        categories: [
          { key: 'templates', brokenReferences: { value: 0, state: 'available', reason: null } },
          { key: 'automations', brokenReferences: { value: 1, state: 'partial', reason: '未対応の参照種別があります' } },
          { key: 'rich_menus', brokenReferences: { value: null, state: 'failed', reason: '参照を確認できませんでした' } },
        ],
        features: [
          {
            featureId: 'broadcasts',
            activityBasis: 'last90days',
            activityUnit: '配信',
            activity: { value: 2, state: 'available', reason: null },
            lastUsedAt: { value: '2026-08-20T00:00:00.000Z', state: 'available', reason: null },
          },
          {
            featureId: 'analytics',
            activityBasis: 'unmeasured',
            activityUnit: '',
            activity: { value: null, state: 'unavailable', reason: '利用回数の記録はありません。分析ページは内容確認用です' },
            lastUsedAt: { value: null, state: 'unavailable', reason: '閲覧時刻は記録していません' },
          },
        ],
      },
    });

    const res = await req(`/api/analytics/usage?${ACCOUNT}&from=2026-08-01&to=2026-08-30`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      data: {
        lineAccountId: 'account-a',
        data: {
          checkedAt: '2026-08-30T16:00:00.000Z',
          summary: { brokenReferences: { value: 1, state: 'partial' } },
          categories: [
            { key: 'templates', brokenReferences: { value: 0, state: 'available' } },
            { key: 'automations', brokenReferences: { value: 1, state: 'partial' } },
            { key: 'rich_menus', brokenReferences: { value: null, state: 'failed' } },
          ],
          // 全任意機能を共有カタログIDで返し、未計測は0ではなく理由付きのまま透過する。
          features: [
            { featureId: 'broadcasts', activity: { value: 2, state: 'available' } },
            { featureId: 'analytics', activity: { value: null, state: 'unavailable' } },
          ],
        },
      },
    });
  });

  it('使われ方の取得自体に失敗したとき正常な空データにせず500を返す', async () => {
    mocks.getAnalyticsUsageOverview.mockRejectedValueOnce(new Error('D1 unavailable'));
    const res = await req(`/api/analytics/usage?${ACCOUNT}`);
    await expectUnhandledFailure(res, '/api/analytics/usage');
  });

  it('存在しない日付と13か月を超える期間を弾く', async () => {
    expect((await req(`/api/analytics/friends?${ACCOUNT}&from=2026-02-31`)).status).toBe(400);
    expect((await req(
      `/api/analytics/friends?${ACCOUNT}&from=2025-01-01&to=2026-08-30`,
    )).status).toBe(400);
    expect(mocks.getAnalyticsFriendsOverview).not.toHaveBeenCalled();
  });

  it('URLクリックは期間と表示件数を渡す', async () => {
    const res = await req(
      `/api/analytics/url-clicks?${ACCOUNT}&from=2026-08-01&to=2026-08-30&limit=50`,
    );
    expect(res.status).toBe(200);
    expect(mocks.getAnalyticsUrlClicksOverview).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        lineAccountId: 'account-a',
        fromDate: '2026-08-01',
        toDate: '2026-08-30',
      }),
      50,
      undefined,
    );
  });

  it('URLクリックは検索語をそのまま渡す', async () => {
    const res = await req(`/api/analytics/url-clicks?${ACCOUNT}&query=${encodeURIComponent('支店')}`);
    expect(res.status).toBe(200);
    expect(mocks.getAnalyticsUrlClicksOverview).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ lineAccountId: 'account-a' }),
      200,
      '支店',
    );
  });

  it.each(['0', '201', '1.5', 'abc'])('URLクリックの不正な表示件数 %s を弾く', async (limit) => {
    const res = await req(`/api/analytics/url-clicks?${ACCOUNT}&limit=${limit}`);
    expect(res.status).toBe(400);
    expect(mocks.getAnalyticsUrlClicksOverview).not.toHaveBeenCalled();
  });
});

describe('旧クロス集計', () => {
  it('画面未使用の同期GET口は公開しない', async () => {
    const res = await req(`/api/analytics/cross?${ACCOUNT}&fieldId=ff-1`);
    expect(res.status).toBe(404);
  });
});

describe('クロス分析API', () => {
  const body = {
    rowAxis: { kind: 'route' },
    columnAxis: { kind: 'tag' },
    measure: { kind: 'unique_friends' },
    filters: [],
    periodFrom: '2026-08-01T00:00:00.000Z',
    periodTo: '2026-08-07T23:59:59.999Z',
  };

  it('重い集計をHTTP内で行わずpendingの結果IDを返す', async () => {
    const res = await req(`/api/analytics/cross/query?${ACCOUNT}`, 'POST', body);
    expect(res.status).toBe(202);
    expect(mocks.createAnalyticsCrossRun).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        lineAccountId: 'account-a', timeZone: 'Asia/Tokyo', createdBy: 'u-1', query: body,
      }),
    );
    expect(await res.json()).toMatchObject({ data: { id: 'cross-1', state: 'pending' } });
  });

  it('終わっていない集計がある間は受け付けず429にする(点検#508の中4)', async () => {
    guardRows.crossBusy = { id: 'cross-0' };
    const res = await req(`/api/analytics/cross/query?${ACCOUNT}`, 'POST', body);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ success: false, error: 'analytics_cross_busy' });
    expect(mocks.createAnalyticsCrossRun).not.toHaveBeenCalled();
  });

  //  「数えるもの」は人数固定ではなく、イベントの回数も選べる。
  // ルートは種類をこねず検証層へそのまま渡す。検証と集計は packages/db の
  // 実SQLite試験(analytics-cross.test.ts)が担う。
  it('イベントの回数を数えるmeasureも検証層へそのまま渡す', async () => {
    const eventsBody = { ...body, measure: { kind: 'events', eventType: 'postback_received' } };
    const res = await req(`/api/analytics/cross/query?${ACCOUNT}`, 'POST', eventsBody);
    expect(res.status).toBe(202);
    expect(mocks.createAnalyticsCrossRun).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ query: eventsBody }),
    );
  });

  it('選択中アカウント内の結果だけを返す', async () => {
    const res = await req(`/api/analytics/cross/results/cross-1?${ACCOUNT}`);
    expect(res.status).toBe(200);
    expect(mocks.getAnalyticsCrossRun).toHaveBeenCalledWith(env.DB, 'account-a', 'cross-1');
  });

  it('待ち順と目安を同一アカウントの範囲だけで返す', async () => {
    mocks.getAnalyticsCrossRun.mockResolvedValueOnce({
      id: 'cross-1', state: 'pending', errorCode: null, result: null,
      createdAt: '2026-08-26T00:00:00.000Z',
      queuePosition: 1, pendingAhead: 0, estimatedWaitMs: 300_000,
      nextTickAt: '2026-08-26T00:06:00.000Z',
    });
    const res = await req(`/api/analytics/cross/results/cross-1?${ACCOUNT}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        id: 'cross-1', state: 'pending',
        queuePosition: 1, pendingAhead: 0, estimatedWaitMs: 300_000,
        nextTickAt: '2026-08-26T00:06:00.000Z',
      },
    });
  });

  it('別アカウントの結果は存在ごと404にする', async () => {
    mocks.getAnalyticsCrossRun.mockResolvedValueOnce(null);
    const res = await req(`/api/analytics/cross/results/cross-1?${ACCOUNT}`);
    expect(res.status).toBe(404);
  });

  it('セルから友だちIDではなく24時間の対象者IDを返す', async () => {
    const res = await req(`/api/analytics/results/cross-1/audiences?${ACCOUNT}`, 'POST', {
      sourceKind: 'cross', rowKey: 'route-1', columnKey: 'tag-1',
    });
    expect(res.status).toBe(201);
    expect(mocks.createAnalyticsCrossAudience).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        lineAccountId: 'account-a', runId: 'cross-1',
        rowKey: 'route-1', columnKey: 'tag-1', createdBy: 'u-1',
      }),
    );
    expect(await res.json()).toMatchObject({ data: { id: 'audience-cross-1', memberCount: 2 } });
  });
});

describe('保存した分析API', () => {
  it('選択中アカウントの保存済み分析だけを返す', async () => {
    const res = await req(`/api/analytics/saved?${ACCOUNT}`);
    expect(res.status).toBe(200);
    expect(mocks.getSavedAnalytics).toHaveBeenCalledWith(env.DB, 'account-a');
  });

  it('確定した結果から定義版とスナップショットを同時に作る', async () => {
    const res = await req(`/api/analytics/saved?${ACCOUNT}`, 'POST', {
      name: '経路 × タグ', sourceKind: 'cross', sourceResultId: 'cross-1',
    });
    expect(res.status).toBe(201);
    expect(mocks.createSavedAnalyticsFromResult).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        lineAccountId: 'account-a', name: '経路 × タグ', sourceKind: 'cross',
        sourceResultId: 'cross-1', createdBy: 'u-1', createdByName: 'テスト',
      }),
    );
  });

  it('別アカウントの保存結果は履歴でも見せない', async () => {
    mocks.getSavedAnalyticsSnapshots.mockResolvedValueOnce(null);
    const res = await req(`/api/analytics/saved/saved-b/snapshots?${ACCOUNT}`);
    expect(res.status).toBe(404);
  });

  it('担当者は集計を読めるが、保存結果と個人一覧を作れない', async () => {
    expect((await reqAsStaff(`/api/analytics/saved?${ACCOUNT}`)).status).toBe(200);
    expect((await reqAsStaff(`/api/analytics/saved?${ACCOUNT}`, 'POST', {
      name: '保存不可', sourceKind: 'cross', sourceResultId: 'cross-1',
    })).status).toBe(403);
    expect((await reqAsStaff(`/api/analytics/results/cross-1/audiences?${ACCOUNT}`, 'POST', {
      sourceKind: 'cross', rowKey: 'route-1', columnKey: 'tag-1',
    })).status).toBe(403);
  });
});

describe('ファネルの作成', () => {
  const validSteps = [
    { label: '友だち追加', kind: 'tag', match: { tagId: 't1' } },
    { label: '購入', kind: 'conversion', match: { conversionPointId: 'cp1' } },
  ];

  it('2段以上でないと作れない', async () => {
    // 1段は「ただの件数」で、離脱を見るという目的を果たさない。
    const res = await req(`/api/funnels?${ACCOUNT}`, 'POST', { name: 'x', steps: [validSteps[0]] });
    expect(res.status).toBe(422);
    expect(mocks.createFunnel).not.toHaveBeenCalled();
  });

  it('10段を超えたら弾く', async () => {
    const res = await req(`/api/funnels?${ACCOUNT}`, 'POST', {
      name: 'x',
      steps: Array.from({ length: 11 }, () => validSteps[0]),
    });
    expect(res.status).toBe(422);
  });

  it('知らない段の種類は弾く', async () => {
    const res = await req(`/api/funnels?${ACCOUNT}`, 'POST', {
      name: 'x',
      steps: [validSteps[0], { label: 'y', kind: 'horoscope', match: {} }],
    });
    expect(res.status).toBe(422);
  });

  it('段の名前が空なら弾く', async () => {
    const res = await req(`/api/funnels?${ACCOUNT}`, 'POST', {
      name: 'x',
      steps: [validSteps[0], { label: '  ', kind: 'tag', match: {} }],
    });
    expect(res.status).toBe(422);
  });

  it('正しければ作れる', async () => {
    const res = await req(`/api/funnels?${ACCOUNT}`, 'POST', { name: '購入まで', steps: validSteps });
    expect(res.status).toBe(201);
    expect(mocks.createFunnel).toHaveBeenCalledWith(env.DB, expect.objectContaining({ lineAccountId: 'account-a' }));
  });
});

describe('ファネルの結果', () => {
  it('前の段を通った人だけを次の段で見る', async () => {
    await req(`/api/funnels/fn-1/result?${ACCOUNT}`);
    const secondCall = mocks.countFunnelStep.mock.calls[1];
    expect(secondCall[2].friendIds).toEqual(['f-1', 'f-2']);
    expect(secondCall[2].lineAccountId).toBe('account-a');
  });

  it('誰も通らなかったら、その先は問い合わせない', async () => {
    mocks.countFunnelStep.mockResolvedValueOnce([]);
    const res = await req(`/api/funnels/fn-1/result?${ACCOUNT}`);
    expect(res.status).toBe(200);
    expect(mocks.countFunnelStep).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { data: { steps: Array<{ reached: number }> } };
    expect(body.data.steps[1].reached).toBe(0);
  });

  it('無いファネルは404', async () => {
    mocks.getFunnelById.mockResolvedValue(null);
    const res = await req(`/api/funnels/nope/result?${ACCOUNT}`);
    expect(res.status).toBe(404);
  });

  it('停止・保管したファネルのその場集計は新規runとして拒否する', async () => {
    for (const status of ['stopped', 'archived'] as const) {
      vi.clearAllMocks();
      mocks.getFunnelById.mockResolvedValue({ ...FUNNEL, status });
      mocks.getStaffById.mockResolvedValue({ account_scope: 'all' });
      mocks.getStaffAccountScopeIds.mockResolvedValue([]);
      const res = await req(`/api/funnels/fn-1/result?${ACCOUNT}`);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.error).toBe('analytics_funnel_not_active');
      expect(mocks.countFunnelStep).not.toHaveBeenCalled();
    }
  });
});

describe('現行ファネルの削除', () => {
  it('の版付き定義は現行APIから削除できない', async () => {
    const res = await req(`/api/funnels/fn-1?${ACCOUNT}`, 'DELETE');
    expect(res.status).toBe(404);
    expect(mocks.deleteFunnel).not.toHaveBeenCalled();
  });

  it('現行形式だけを削除できる', async () => {
    mocks.getCurrentFunnelVersion.mockResolvedValueOnce(null);
    const res = await req(`/api/funnels/fn-1?${ACCOUNT}`, 'DELETE');
    expect(res.status).toBe(200);
    expect(mocks.deleteFunnel).toHaveBeenCalledWith(env.DB, 'account-a', 'fn-1');
  });

  it('停止・保管したファネルは物理削除できない', async () => {
    mocks.getFunnelById.mockResolvedValue({ ...FUNNEL, status: 'archived' });
    mocks.getCurrentFunnelVersion.mockResolvedValueOnce(null);
    const res = await req(`/api/funnels/fn-1?${ACCOUNT}`, 'DELETE');
    expect(res.status).toBe(422);
    expect(mocks.deleteFunnel).not.toHaveBeenCalled();
  });
});

describe('ファネルAPI', () => {
  const body = {
    name: '購入まで',
    windowDays: 14,
    steps: [
      { label: '追加', kind: 'friend_add', match: {} },
      { label: '購入', kind: 'purchase', match: { status: 'confirmed' } },
    ],
  };

  it('一覧で現行定義の移行要否を分ける', async () => {
    mocks.getFunnelsWithCurrentVersions.mockResolvedValueOnce({
      items: [{ ...FUNNEL, currentVersion: null }], total: 1, page: 2, pageSize: 50,
    });
    const res = await req(`/api/analytics/funnels?${ACCOUNT}&page=2&pageSize=50`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: [{ id: 'fn-1', currentVersion: null, migrationState: 'needs_migration' }],
      pagination: { page: 2, pageSize: 50, total: 1 },
    });
    expect(mocks.getFunnelsWithCurrentVersions).toHaveBeenCalledWith(
      env.DB, 'account-a', { page: 2, pageSize: 50, includeInactive: false },
    );
    expect(mocks.getCurrentFunnelVersion).not.toHaveBeenCalled();
  });

  it('一覧の表示件数を最大200件に制限する', async () => {
    const res = await req(`/api/analytics/funnels?${ACCOUNT}&pageSize=201`);
    expect(res.status).toBe(400);
    expect(mocks.getFunnelsWithCurrentVersions).not.toHaveBeenCalled();
  });

  it.each(['0', '1.5', 'invalid'])(
    '一覧の不正なページ番号 %s は取得前に400で止める',
    async (page) => {
      const res = await req(`/api/analytics/funnels?${ACCOUNT}&page=${page}`);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        success: false,
        error: 'ページは1以上の整数で指定してください',
      });
      expect(mocks.getFunnelsWithCurrentVersions).not.toHaveBeenCalled();
    },
  );

  it('一覧の一括取得に失敗したときは空一覧と偽らず500を返す', async () => {
    mocks.getFunnelsWithCurrentVersions.mockRejectedValueOnce(new Error('D1 unavailable'));

    const res = await req(`/api/analytics/funnels?${ACCOUNT}`);

    await expectUnhandledFailure(res, '/api/analytics/funnels');
  });

  it('作成時に第1版を固定する', async () => {
    const res = await req(`/api/analytics/funnels?${ACCOUNT}`, 'POST', body);
    expect(res.status).toBe(201);
    expect(mocks.createVersionedFunnel).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ lineAccountId: 'account-a', windowDays: 14, createdBy: 'u-1' }),
    );
  });

  it('タイムゾーン付き期間で不変結果を作る', async () => {
    const res = await req(`/api/analytics/funnels/fn-1/run?${ACCOUNT}`, 'POST', {
      cohortFrom: '2026-08-01T00:00:00.000+09:00',
      cohortTo: '2026-08-10T23:59:59.999+09:00',
    });
    expect(res.status).toBe(201);
    expect(mocks.runChronologicalFunnel).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        lineAccountId: 'account-a', funnelId: 'fn-1', timeZone: 'Asia/Tokyo', persist: true,
      }),
    );
  });

  it('画面表示では再計算せず最後の不変結果を返す', async () => {
    const res = await req(`/api/analytics/funnels/fn-1/runs/latest?${ACCOUNT}`);
    expect(res.status).toBe(200);
    expect(mocks.getLatestFunnelRun).toHaveBeenCalledWith(env.DB, 'account-a', 'fn-1');
  });

  it('同一ファネルの60秒以内の再集計は429にする(点検#508の中4)', async () => {
    guardRows.lastFunnelRunAt = new Date().toISOString();
    const res = await req(`/api/analytics/funnels/fn-1/run?${ACCOUNT}`, 'POST', {
      cohortFrom: '2026-08-01T00:00:00.000+09:00',
      cohortTo: '2026-08-10T23:59:59.999+09:00',
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ success: false, error: 'analytics_funnel_too_soon' });
    expect(mocks.runChronologicalFunnel).not.toHaveBeenCalled();
  });

  it('61秒前の再集計は受け付ける(点検#508の中4)', async () => {
    guardRows.lastFunnelRunAt = new Date(Date.now() - 61_000).toISOString();
    const res = await req(`/api/analytics/funnels/fn-1/run?${ACCOUNT}`, 'POST', {
      cohortFrom: '2026-08-01T00:00:00.000+09:00',
      cohortTo: '2026-08-10T23:59:59.999+09:00',
    });
    expect(res.status).toBe(201);
    expect(mocks.runChronologicalFunnel).toHaveBeenCalled();
  });

  it('時刻にタイムゾーンがなければ集計しない', async () => {
    const res = await req(`/api/analytics/funnels/fn-1/run?${ACCOUNT}`, 'POST', {
      cohortFrom: '2026-08-01T00:00:00',
      cohortTo: '2026-08-10T23:59:59',
    });
    expect(res.status).toBe(422);
    expect(mocks.runChronologicalFunnel).not.toHaveBeenCalled();
  });

  it('対象者IDだけを返し、友だちIDをURLへ出さない', async () => {
    const res = await req(`/api/analytics/results/run-1/audiences?${ACCOUNT}`, 'POST', {
      stepOrder: 2,
      selection: 'stopped',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      success: true,
      data: { id: 'audience-1', memberCount: 1 },
    });
  });

  it('一覧は includeInactive=1 のときだけ停止・保管済みも返す(N-273)', async () => {
    mocks.getFunnelsWithCurrentVersions.mockResolvedValueOnce({
      items: [
        { ...FUNNEL, currentVersion: { id: 'v-1', versionNumber: 1, createdAt: '2026-08-16' } },
        { ...FUNNEL, id: 'fn-2', status: 'stopped', currentVersion: null },
      ],
      total: 2, page: 1, pageSize: 200,
    });
    const res = await req(`/api/analytics/funnels?${ACCOUNT}&includeInactive=1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: [{ id: 'fn-1', status: 'active' }, { id: 'fn-2', status: 'stopped' }],
    });
    expect(mocks.getFunnelsWithCurrentVersions).toHaveBeenCalledWith(
      env.DB, 'account-a', expect.objectContaining({ includeInactive: true }),
    );
  });

  it('1件の定義を現在版つきで返し、別アカウントや無いものは404(N-272)', async () => {
    mocks.getFunnelWithCurrentVersion.mockResolvedValueOnce({
      funnel: FUNNEL,
      currentVersion: {
        id: 'v-1', funnelId: 'fn-1', lineAccountId: 'account-a', versionNumber: 2,
        windowDays: 14,
        steps: [{ stepOrder: 1, label: '追加', kind: 'friend_add', match: {} }],
        segment: { kind: 'all' }, comparisonGroups: [],
        createdBy: 'u-1', createdAt: '2026-08-16',
      },
    });
    const res = await req(`/api/analytics/funnels/fn-1?${ACCOUNT}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { id: 'fn-1', status: 'active', currentVersion: { versionNumber: 2, windowDays: 14 } },
    });
    expect(mocks.getFunnelWithCurrentVersion).toHaveBeenCalledWith(env.DB, 'account-a', 'fn-1');

    mocks.getFunnelWithCurrentVersion.mockResolvedValueOnce(null);
    const missing = await req(`/api/analytics/funnels/nope?${ACCOUNT}`);
    expect(missing.status).toBe(404);
  });

  it('新版保存は expectedVersionNumber と名前をdbへ渡し、版競合は409(N-272)', async () => {
    mocks.createFunnelVersion.mockResolvedValueOnce({ id: 'v-2', versionNumber: 2 });
    const res = await req(`/api/analytics/funnels/fn-1/versions?${ACCOUNT}`, 'POST', {
      windowDays: 14,
      steps: body.steps,
      name: '購入まで v2',
      expectedVersionNumber: 1,
    });
    expect(res.status).toBe(201);
    expect(mocks.createFunnelVersion).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        lineAccountId: 'account-a', funnelId: 'fn-1',
        name: '購入まで v2', expectedVersionNumber: 1, createdBy: 'u-1',
      }),
    );

    mocks.createFunnelVersion.mockRejectedValueOnce(new Error('analytics_funnel_version_conflict'));
    const conflict = await req(`/api/analytics/funnels/fn-1/versions?${ACCOUNT}`, 'POST', {
      windowDays: 14, steps: body.steps, expectedVersionNumber: 0,
    });
    expect(conflict.status).toBe(409);
  });

  it('確認版をDBに渡し、不一致は409、無効な版は拒否する', async () => {
    mocks.setFunnelStatus.mockResolvedValueOnce({ ...FUNNEL, status: 'stopped', confirmation_revision: 2 });
    const ok = await req(`/api/analytics/funnels/fn-1/status?${ACCOUNT}`, 'PUT', { status: 'stopped', expectedStatus: 'active', expectedRevision: 1 });
    expect(ok.status).toBe(200);
    expect(mocks.setFunnelStatus).toHaveBeenCalledWith(env.DB, expect.objectContaining({ expectedRevision: 1 }));
    expect((await ok.json() as { data: { confirmationRevision: number } }).data.confirmationRevision).toBe(2);
    mocks.setFunnelStatus.mockRejectedValueOnce(new Error('analytics_funnel_status_conflict'));
    const stale = await req(`/api/analytics/funnels/fn-1/status?${ACCOUNT}`, 'PUT', { status: 'stopped', expectedStatus: 'active', expectedRevision: 1 });
    expect(stale.status).toBe(409);
    const invalid = await req(`/api/analytics/funnels/fn-1/status?${ACCOUNT}`, 'PUT', { status: 'stopped', expectedStatus: 'active', expectedRevision: '1' });
    expect(invalid.status).toBe(422);
  });

  it('停止・再開・保管は現在状態を要し、競合409・不正遷移422・staffは403(N-273)', async () => {
    mocks.setFunnelStatus.mockResolvedValueOnce({ ...FUNNEL, status: 'stopped' });
    const stopped = await req(`/api/analytics/funnels/fn-1/status?${ACCOUNT}`, 'PUT', {
      status: 'stopped', expectedStatus: 'active',
    });
    expect(stopped.status).toBe(200);
    expect(mocks.setFunnelStatus).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', funnelId: 'fn-1',
      status: 'stopped', expectedStatus: 'active',
    });

    mocks.setFunnelStatus.mockRejectedValueOnce(new Error('analytics_funnel_status_conflict'));
    const conflict = await req(`/api/analytics/funnels/fn-1/status?${ACCOUNT}`, 'PUT', {
      status: 'stopped', expectedStatus: 'active',
    });
    expect(conflict.status).toBe(409);

    mocks.setFunnelStatus.mockRejectedValueOnce(new Error('analytics_funnel_invalid_transition'));
    const invalid = await req(`/api/analytics/funnels/fn-1/status?${ACCOUNT}`, 'PUT', {
      status: 'active', expectedStatus: 'archived',
    });
    expect(invalid.status).toBe(422);

    const missing = await req(`/api/analytics/funnels/fn-1/status?${ACCOUNT}`, 'PUT', {
      status: 'unknown',
    });
    expect(missing.status).toBe(422);

    // 現在状態なしの遷移は二重操作を弾けないので受け付けない。
    const noExpected = await req(`/api/analytics/funnels/fn-1/status?${ACCOUNT}`, 'PUT', {
      status: 'stopped',
    });
    expect(noExpected.status).toBe(422);
    const badExpected = await req(`/api/analytics/funnels/fn-1/status?${ACCOUNT}`, 'PUT', {
      status: 'stopped', expectedStatus: 'unknown',
    });
    expect(badExpected.status).toBe(422);
    expect(mocks.setFunnelStatus).toHaveBeenCalledTimes(3);

    const staff = await reqAsStaff(`/api/analytics/funnels/fn-1/status?${ACCOUNT}`, 'PUT', {
      status: 'stopped', expectedStatus: 'active',
    });
    expect(staff.status).toBe(403);
  });

  it('停止・保管したファネルの再集計と新版は422で止める(N-273)', async () => {
    mocks.runChronologicalFunnel.mockRejectedValueOnce(new Error('analytics_funnel_not_active'));
    const res = await req(`/api/analytics/funnels/fn-1/run?${ACCOUNT}`, 'POST', {
      cohortFrom: '2026-08-01T00:00:00.000+09:00',
      cohortTo: '2026-08-10T23:59:59.999+09:00',
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'analytics_funnel_not_active' , fields: expect.any(Object), error: expect.any(String) });

    mocks.createFunnelVersion.mockRejectedValueOnce(new Error('analytics_funnel_not_active'));
    const version = await req(`/api/analytics/funnels/fn-1/versions?${ACCOUNT}`, 'POST', {
      windowDays: 14, steps: body.steps,
    });
    expect(version.status).toBe(422);
  });

  describe('段の成果地点への利用先記録', () => {
    const conversionSteps = [
      { label: '追加', kind: 'friend_add', match: {} },
      { label: '購入', kind: 'conversion', match: { conversionPointId: 'cp-1' } },
    ];
    // 成果地点の版と名前だけを返す DB（利用先記録の CAS が読む）。
    const pointEnv = {
      DB: {
        prepare: (sql: string) => ({
          bind: () => ({
            first: async () => sql.includes('FROM conversion_points') ? { version: 3, name: '購入完了' } : null,
          }),
        }),
      } as unknown as D1Database,
    };
    const send = (path: string, payload: unknown) => app.fetch(
      new Request(`https://example.com${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }),
      pointEnv,
    );

    it('作成と新版は、下書き・停止中の地点にも allowInactive で記し、成功なら断りを返さない', async () => {
      mocks.createVersionedFunnel.mockResolvedValueOnce({
        funnelId: 'fn-v6', version: { id: 'fv-1', versionNumber: 1, steps: conversionSteps },
      });
      const created = await send(`/api/analytics/funnels?${ACCOUNT}`, { name: '購入まで', windowDays: 14, steps: conversionSteps });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ success: true, data: { funnelId: 'fn-v6', usageWarnings: [] } });
      expect(mocks.addConversionDefinitionUsage).toHaveBeenCalledWith(pointEnv.DB, expect.objectContaining({
        conversionPointId: 'cp-1', lineAccountId: 'account-a', expectedVersion: 3,
        refKind: 'analytics', refId: 'fn-v6', refVersionId: 'fv-1', allowInactive: true,
      }));

      mocks.createFunnelVersion.mockResolvedValueOnce({ id: 'fv-2', versionNumber: 2, steps: conversionSteps });
      const version = await send(`/api/analytics/funnels/fn-v6/versions?${ACCOUNT}`, { windowDays: 14, steps: conversionSteps, expectedVersionNumber: 1 });
      expect(version.status).toBe(201);
      expect(await version.json()).toMatchObject({ data: { id: 'fv-2', usageWarnings: [] } });
      expect(mocks.addConversionDefinitionUsage).toHaveBeenLastCalledWith(pointEnv.DB, expect.objectContaining({
        refId: 'fn-v6', refVersionId: 'fv-2', allowInactive: true,
      }));
    });

    it('記録に失敗した地点は作成を失敗にせず、地点名を応答の usageWarnings に載せる', async () => {
      mocks.createVersionedFunnel.mockResolvedValueOnce({
        funnelId: 'fn-v6', version: { id: 'fv-1', versionNumber: 1, steps: conversionSteps },
      });
      mocks.addConversionDefinitionUsage.mockRejectedValue(new Error('conversion_definition_inactive'));
      const created = await send(`/api/analytics/funnels?${ACCOUNT}`, { name: '購入まで', windowDays: 14, steps: conversionSteps });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ success: true, data: { funnelId: 'fn-v6', usageWarnings: ['購入完了'] } });

      mocks.createFunnelVersion.mockResolvedValueOnce({ id: 'fv-2', versionNumber: 2, steps: conversionSteps });
      const version = await send(`/api/analytics/funnels/fn-v6/versions?${ACCOUNT}`, { windowDays: 14, steps: conversionSteps, expectedVersionNumber: 1 });
      expect(version.status).toBe(201);
      expect(await version.json()).toMatchObject({ data: { usageWarnings: ['購入完了'] } });
      mocks.addConversionDefinitionUsage.mockReset();
    });
  });
});

describe('LINE公式アカウントの分離', () => {
  it('アカウント指定がなければ集計しない', async () => {
    const res = await req('/api/analytics/messages');
    expect(res.status).toBe(400);
    expect(mocks.getDailyMessageCounts).not.toHaveBeenCalled();
  });

  it('権限外アカウントは存在を明かさない', async () => {
    const res = await req('/api/analytics/messages?account_id=account-b');
    expect(res.status).toBe(404);
    expect(mocks.getDailyMessageCounts).not.toHaveBeenCalled();
  });

  it('ファネル一覧も選択中アカウントだけで読む', async () => {
    const res = await req(`/api/funnels?${ACCOUNT}`);
    expect(res.status).toBe(200);
    expect(mocks.getLegacyFunnels).toHaveBeenCalledWith(env.DB, 'account-a');
  });
});

describe('定期レポートAPI', () => {
  const body = {
    name: '週次まとめ', sections: ['friends', 'reactions'], savedAnalysisIds: [],
    cadence: 'weekly', weekday: 1, monthDay: null, sendTime: '09:00',
    timeZone: 'Asia/Tokyo', periodDays: 7,
    recipients: [{ kind: 'staff', staffId: 'u-1', label: 'テスト' }],
    channels: ['dashboard', 'line'],
    alertRules: [{ metric: 'friend_adds', operator: 'decrease_percent', threshold: 20, minimumSample: 20 }],
  };

  it('通常と空状態を同じアカウント境界で返す', async () => {
    const res = await req(`/api/analytics/report-schedules?${ACCOUNT}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      data: { items: [], options: { timeZone: 'Asia/Tokyo', recipients: [{ id: 'u-1' }] } },
    });
    expect(mocks.getAnalyticsReportSchedules).toHaveBeenCalledWith(env.DB, 'account-a');
  });

  it('統括は実在する保存分析と宛先だけで作れる', async () => {
    const res = await req(`/api/analytics/report-schedules?${ACCOUNT}`, 'POST', body);
    expect(res.status).toBe(201);
    expect(mocks.createAnalyticsReportSchedule).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ lineAccountId: 'account-a', name: '週次まとめ', isOneTime: false }),
    );
  });

  it('運用担当は閲覧できるが作成できない', async () => {
    expect((await reqAsStaff(`/api/analytics/report-schedules?${ACCOUNT}`)).status).toBe(200);
    expect((await reqAsStaff(`/api/analytics/report-schedules?${ACCOUNT}`, 'POST', body)).status).toBe(403);
  });

  it('権限外の宛先と別アカウントは拒否する', async () => {
    const badRecipient = await req(`/api/analytics/report-schedules?${ACCOUNT}`, 'POST', {
      ...body, recipients: [{ kind: 'staff', staffId: 'other', label: '別担当' }],
    });
    expect(badRecipient.status).toBe(422);
    expect((await req('/api/analytics/report-schedules?account_id=account-b')).status).toBe(404);
  });

  it('R228: 正しい宛先と形の合わない宛先が混ざっていても止める', async () => {
    // 送ったつもりで欠落しないよう、不正な宛先を含む作成は拒む。
    const mixed = await req(`/api/analytics/report-schedules?${ACCOUNT}`, 'POST', {
      ...body,
      recipients: [
        { kind: 'email', email: 'ops@example.com', label: '運用' },
        { kind: 'email', email: 'not-an-address', label: '壊れた行' },
      ],
    });
    expect(mixed.status).toBe(422);
    expect(await mixed.json()).toMatchObject({ success: false });
    expect(mocks.createAnalyticsReportSchedule).not.toHaveBeenCalled();

    const staffMixed = await req(`/api/analytics/report-schedules?${ACCOUNT}`, 'POST', {
      ...body,
      recipients: [
        { kind: 'staff', staffId: 'u-1', label: 'テスト' },
        { kind: 'email', email: 'missing-at.example.com', label: '壊れた行' },
      ],
    });
    expect(staffMixed.status).toBe(422);
    expect(mocks.createAnalyticsReportSchedule).not.toHaveBeenCalled();

    // 読み取れない形の行（kind が不明 / staffId なし）も黙って捨てない。
    const unknown = await req(`/api/analytics/report-schedules?${ACCOUNT}`, 'POST', {
      ...body,
      recipients: [{ kind: 'staff', staffId: 'u-1' }, { kind: 'fax', email: 'x@example.com' }],
    });
    expect(unknown.status).toBe(422);

    // 正しい宛先だけなら従来どおり作れる（回帰）。
    const ok = await req(`/api/analytics/report-schedules?${ACCOUNT}`, 'POST', {
      ...body,
      recipients: [
        { kind: 'staff', staffId: 'u-1', label: 'テスト' },
        { kind: 'email', email: 'OPS@example.com', label: '運用' },
      ],
    });
    expect(ok.status).toBe(201);
  });

  it('読取失敗は500で返し、未取得を空に見せない', async () => {
    mocks.getAnalyticsReportSchedules.mockRejectedValueOnce(new Error('db down'));
    const res = await req(`/api/analytics/report-schedules?${ACCOUNT}`);
    await expectUnhandledFailure(res, '/api/analytics/report-schedules');
  });

  const existingSchedule = {
    id: 'report-1', lineAccountId: 'account-a', name: '週次まとめ',
    sections: ['friends'], savedAnalysisIds: [], cadence: 'weekly', weekday: 1,
    monthDay: null, sendTime: '09:00', timeZone: 'Asia/Tokyo', periodDays: 7,
    recipients: [{ kind: 'staff', staffId: 'u-1', label: 'テスト' }],
    channels: ['dashboard', 'line'], alertRules: [], status: 'active',
    isOneTime: false, nextRunAt: '2026-09-21T00:00:00.000Z', createdBy: 'u-1',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  };

  it('統括は読み取った版つきで内容を更新でき、次回予定を新しい間隔で置き直す', async () => {
    mocks.getAnalyticsReportSchedule.mockResolvedValue(existingSchedule);
    const res = await req(`/api/analytics/report-schedules/report-1?${ACCOUNT}`, 'PUT', {
      ...body, name: '火曜のまとめ', expectedUpdatedAt: existingSchedule.updatedAt,
    });
    expect(res.status).toBe(200);
    expect(mocks.updateAnalyticsReportSchedule).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        id: 'report-1', lineAccountId: 'account-a', name: '火曜のまとめ',
        expectedUpdatedAt: '2026-09-01T00:00:00.000Z',
      }),
    );
    // 次回予定は過去でなく未来に置き直す(積み残しの回を送り直さない)
    const call = mocks.updateAnalyticsReportSchedule.mock.calls[0][1] as { nextRunAt: string };
    expect(Date.parse(call.nextRunAt)).toBeGreaterThan(Date.now());
  });

  it('版なし・版ずれ・存在しないID・1回きりの予定は更新できない', async () => {
    mocks.getAnalyticsReportSchedule.mockResolvedValue(existingSchedule);
    expect((await req(`/api/analytics/report-schedules/report-1?${ACCOUNT}`, 'PUT', body)).status).toBe(422);
    mocks.updateAnalyticsReportSchedule.mockResolvedValueOnce('conflict');
    const conflict = await req(`/api/analytics/report-schedules/report-1?${ACCOUNT}`, 'PUT', {
      ...body, expectedUpdatedAt: 'old',
    });
    expect(conflict.status).toBe(409);
    mocks.getAnalyticsReportSchedule.mockResolvedValue(null);
    expect((await req(`/api/analytics/report-schedules/ghost?${ACCOUNT}`, 'PUT', {
      ...body, expectedUpdatedAt: 'x',
    })).status).toBe(404);
    mocks.getAnalyticsReportSchedule.mockResolvedValue({ ...existingSchedule, isOneTime: true });
    expect((await req(`/api/analytics/report-schedules/report-1?${ACCOUNT}`, 'PUT', {
      ...body, expectedUpdatedAt: existingSchedule.updatedAt,
    })).status).toBe(422);
  });

  it('運用担当は更新も状態変更もできない', async () => {
    expect((await reqAsStaff(`/api/analytics/report-schedules/report-1?${ACCOUNT}`, 'PUT', {
      ...body, expectedUpdatedAt: 'x',
    })).status).toBe(403);
    expect((await reqAsStaff(`/api/analytics/report-schedules/report-1/status?${ACCOUNT}`, 'PUT', {
      status: 'paused', expectedUpdatedAt: 'x',
    })).status).toBe(403);
  });

  it('止める・また送る・しまうを版つきで受け、再開は未来の次回だけを予約する', async () => {
    mocks.getAnalyticsReportSchedule.mockResolvedValue(existingSchedule);
    const paused = await req(`/api/analytics/report-schedules/report-1/status?${ACCOUNT}`, 'PUT', {
      status: 'paused', expectedUpdatedAt: existingSchedule.updatedAt,
    });
    expect(paused.status).toBe(200);
    expect(mocks.setAnalyticsReportScheduleStatus).toHaveBeenCalledWith(
      env.DB, expect.objectContaining({ status: 'paused', nextRunAt: undefined }),
    );

    mocks.getAnalyticsReportSchedule.mockResolvedValue({ ...existingSchedule, status: 'paused' });
    const resumed = await req(`/api/analytics/report-schedules/report-1/status?${ACCOUNT}`, 'PUT', {
      status: 'active', expectedUpdatedAt: existingSchedule.updatedAt,
    });
    expect(resumed.status).toBe(200);
    const resumeCall = mocks.setAnalyticsReportScheduleStatus.mock.calls.at(-1)![1] as { nextRunAt?: string };
    expect(resumeCall.nextRunAt && Date.parse(resumeCall.nextRunAt)).toBeGreaterThan(Date.now());

    const archived = await req(`/api/analytics/report-schedules/report-1/status?${ACCOUNT}`, 'PUT', {
      status: 'archived', expectedUpdatedAt: existingSchedule.updatedAt,
    });
    expect(archived.status).toBe(200);

    mocks.setAnalyticsReportScheduleStatus.mockResolvedValueOnce('conflict');
    mocks.getAnalyticsReportSchedule.mockResolvedValue({ ...existingSchedule, status: 'paused' });
    expect((await req(`/api/analytics/report-schedules/report-1/status?${ACCOUNT}`, 'PUT', {
      status: 'active', expectedUpdatedAt: 'old',
    })).status).toBe(409);
    expect((await req(`/api/analytics/report-schedules/report-1/status?${ACCOUNT}`, 'PUT', {
      status: 'bogus', expectedUpdatedAt: 'x',
    })).status).toBe(422);
    expect((await req(`/api/analytics/report-schedules/report-1/status?${ACCOUNT}`, 'PUT', {
      status: 'paused',
    })).status).toBe(422);

    // 同じ状態への再送は冪等に200で返し、書き込みは起こさない
    mocks.getAnalyticsReportSchedule.mockResolvedValue({ ...existingSchedule, status: 'paused' });
    mocks.setAnalyticsReportScheduleStatus.mockClear();
    const idempotent = await req(`/api/analytics/report-schedules/report-1/status?${ACCOUNT}`, 'PUT', {
      status: 'paused', expectedUpdatedAt: existingSchedule.updatedAt,
    });
    expect(idempotent.status).toBe(200);
    expect(mocks.setAnalyticsReportScheduleStatus).not.toHaveBeenCalled();
  });
});

describe('R454 1回送信の履歴と送り直し', () => {
  const archivedOneTime = {
    id: 'once-1', lineAccountId: 'account-a', name: '1回送信', sections: ['friends'],
    savedAnalysisIds: [], cadence: 'weekly', weekday: 1, monthDay: null,
    sendTime: '09:00', timeZone: 'Asia/Tokyo', periodDays: 7,
    recipients: [{ kind: 'email', email: 'a@example.com', label: 'a@example.com' }],
    channels: ['email'], alertRules: [], status: 'archived', isOneTime: true,
    nextRunAt: '2026-09-07T00:00:00.000Z', createdBy: 'u-1',
    createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-07T01:00:00.000Z',
  };
  const failedRun = {
    id: 'run-1', scheduleId: 'once-1', lineAccountId: 'account-a',
    scheduledFor: '2026-09-07T00:00:00.000Z', state: 'failed',
    deliveryResults: [{ channel: 'email', recipient: 'a@example.com', status: 'failed', reason: 'x' }],
    errorCode: 'synthetic_mail_failed',
  };

  it('しまった1回送信の履歴を依頼IDで返す', async () => {
    mocks.getAnalyticsReportScheduleIncludingArchived.mockImplementation(async (_db, id) => (
      id === 'once-1' ? archivedOneTime : null
    ));
    mocks.getAnalyticsReportRuns.mockResolvedValue([failedRun]);
    const res = await req(`/api/analytics/report-schedules/once-1/runs?${ACCOUNT}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true, data: { schedule: { id: 'once-1' }, runs: [{ id: 'run-1' }] },
    });
    expect((await req(`/api/analytics/report-schedules/ghost/runs?${ACCOUNT}`)).status).toBe(404);
    expect((await req(`/api/analytics/report-schedules/once-1/runs?account_id=account-b`)).status).toBe(404);
  });

  it('全部失敗の1回送信だけ送り直せる', async () => {
    mocks.getAnalyticsReportScheduleIncludingArchived.mockResolvedValue(archivedOneTime);
    mocks.getAnalyticsReportRuns.mockResolvedValue([failedRun]);
    mocks.getAnalyticsReportSchedule.mockResolvedValue({ ...archivedOneTime, status: 'active' });
    const res = await req(`/api/analytics/report-schedules/once-1/retry?${ACCOUNT}`, 'POST', {});
    expect(res.status).toBe(200);
    expect(mocks.requeueOneTimeAnalyticsReportSchedule).toHaveBeenCalled();
    // 運用担当は送り直せない
    expect((await reqAsStaff(`/api/analytics/report-schedules/once-1/retry?${ACCOUNT}`, 'POST', {})).status).toBe(403);
  });

  it('一部でも届いたものは送り直さない', async () => {
    mocks.getAnalyticsReportScheduleIncludingArchived.mockResolvedValue(archivedOneTime);
    mocks.getAnalyticsReportRuns.mockResolvedValue([{
      ...failedRun,
      deliveryResults: [
        { channel: 'dashboard', status: 'sent' },
        { channel: 'email', recipient: 'a@example.com', status: 'failed', reason: 'x' },
      ],
    }]);
    const res = await req(`/api/analytics/report-schedules/once-1/retry?${ACCOUNT}`, 'POST', {});
    expect(res.status).toBe(422);
    expect(mocks.requeueOneTimeAnalyticsReportSchedule).not.toHaveBeenCalled();
  });

  it('定期レポートや実行中は送り直さない', async () => {
    mocks.getAnalyticsReportScheduleIncludingArchived.mockResolvedValue({ ...archivedOneTime, isOneTime: false });
    expect((await req(`/api/analytics/report-schedules/once-1/retry?${ACCOUNT}`, 'POST', {})).status).toBe(404);
    mocks.getAnalyticsReportScheduleIncludingArchived.mockResolvedValue(archivedOneTime);
    mocks.getAnalyticsReportRuns.mockResolvedValue([{ ...failedRun, state: 'running' }]);
    expect((await req(`/api/analytics/report-schedules/once-1/retry?${ACCOUNT}`, 'POST', {})).status).toBe(422);
  });
});

it.each(['messages','link-clicks','tracked-links','broadcasts'])('API-02 %s rejects a non-existent date',async path=>{
 expect((await req(`/api/analytics/${path}?${ACCOUNT}&from=2026-02-30&to=2026-03-01`)).status).toBe(400);
});
