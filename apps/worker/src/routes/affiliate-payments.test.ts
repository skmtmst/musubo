import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker-env.js';
import { unhandledWorkerError } from '../lib/unhandled-error.js';

const report = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../services/codex-slack-relay.js', () => ({ reportHarnessErrorToSlack: report }));

const dbMocks = {
  getAffiliates: vi.fn(),
  getAffiliateById: vi.fn(),
  getAffiliateByCode: vi.fn(),
  createAffiliate: vi.fn(),
  createAffiliateWithRandomCode: vi.fn(),
  createAffiliateLink: vi.fn(),
  updateAffiliate: vi.fn(),
  recordAffiliateClick: vi.fn(),
  getAffiliateReport: vi.fn(),
  getAffiliateReportV2: vi.fn(),
  getFriendById: vi.fn(),
  getFriendJourney: vi.fn(),
  getAffiliateByFriendId: vi.fn(),
  getAffiliateJourneys: vi.fn(),
  getAffiliatePaymentSummaries: vi.fn(),
  getAffiliateArchiveImpact: vi.fn(),
  updateAffiliateLifecycle: vi.fn(),
  previewAffiliateSettlement: vi.fn(),
  confirmAffiliateSettlement: vi.fn(),
  listAffiliateLinks: vi.fn(),
  listAffiliateOffers: vi.fn(),
};
const accountAccess = { getVisibleLineAccountScope: vi.fn() };

vi.mock('@line-crm/db', () => dbMocks);
vi.mock('../services/account-access.js', () => accountAccess);

const { affiliates } = await import('./affiliates.js');

function makeApp(role: 'owner' | 'admin' | 'staff' = 'owner') {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '担当', role, readOnly: false, tenantId: 'tenant-1' });
    return next();
  });
  app.route('/', affiliates);
  app.onError(unhandledWorkerError);
  return app;
}

const env = { DB: {} as D1Database };

function get(path: string, role?: 'owner' | 'admin' | 'staff') {
  return makeApp(role).fetch(new Request(`https://example.com${path}`), env);
}

function post(path: string, body: unknown, role?: 'owner' | 'admin' | 'staff') {
  return makeApp(role).fetch(new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
}

beforeEach(() => {
  vi.clearAllMocks();
  accountAccess.getVisibleLineAccountScope.mockResolvedValue({
    accounts: [{ id: 'account-1' }],
    allowedAccountIds: ['account-1'],
    canSeeUnassigned: false,
    ids: ['account-1'],
  });
  dbMocks.getAffiliatePaymentSummaries.mockResolvedValue([{ affiliateId: 'affiliate-1' }]);
  dbMocks.getAffiliateById.mockResolvedValue({
    id: 'affiliate-1',
    name: '見本 168',
    line_account_id: 'account-1',
  });
  dbMocks.getAffiliateArchiveImpact.mockResolvedValue({
    affiliateId: 'affiliate-1',
    affiliateName: '見本 168',
    lifecycle: 'active',
    activeLinks: 3,
    unsettledConversions: 2,
    unsettledReward: 24000,
    pendingConversions: 2,
    checkedAt: '2026-09-06T00:00:00.000Z',
  });
  dbMocks.updateAffiliateLifecycle.mockResolvedValue(true);
  dbMocks.previewAffiliateSettlement.mockResolvedValue({
    affiliateId: 'affiliate-1',
    affiliateName: '見本 168',
    code: 'tanaka01',
    amount: 72000,
    conversionCount: 18,
    periodFrom: '2026-08-01T00:00:00.000Z',
    periodTo: '2026-08-31T14:59:59.000Z',
    closeDate: null,
    paymentDate: null,
    bankDestination: null,
    breakdown: [{ offerName: '定期便', conversions: 8, unitReward: 5000, subtotal: 40000 }],
    entries: [{ conversionEventId: 'cv-1' }],
  });
  dbMocks.confirmAffiliateSettlement.mockResolvedValue({
    kind: 'created',
    settlementId: 'settlement-1',
    amount: 72000,
    conversionCount: 18,
    closedAt: '2026-09-06T00:00:00.000Z',
  });
});

describe('GET /api/affiliate-payments', () => {
  it('選択中アカウントを再認可して支払い集計を返す', async () => {
    const res = await get('/api/affiliate-payments?lineAccountId=account-1');
    expect(res.status).toBe(200);
    expect(dbMocks.getAffiliatePaymentSummaries).toHaveBeenCalledWith(env.DB, 'account-1', 'tenant-1');
    expect(await res.json()).toMatchObject({
      success: true,
      data: [{ affiliateId: 'affiliate-1' }],
      limitations: { payoutHistory: false, settlementHistory: true, bankDestination: false, settlementSchedule: false },
    });
  });

  it('アカウント未選択と閲覧範囲外を空配列にしない', async () => {
    expect((await get('/api/affiliate-payments')).status).toBe(400);
    expect((await get('/api/affiliate-payments?lineAccountId=account-2')).status).toBe(404);
    expect(dbMocks.getAffiliatePaymentSummaries).not.toHaveBeenCalled();
  });

  it('スタッフ権限では閲覧できない', async () => {
    const res = await get('/api/affiliate-payments?lineAccountId=account-1', 'staff');
    expect(res.status).toBe(403);
    expect(dbMocks.getAffiliatePaymentSummaries).not.toHaveBeenCalled();
  });

  it('取得失敗を0件として返さない', async () => {
    dbMocks.getAffiliatePaymentSummaries.mockRejectedValue(new Error('db unavailable'));
    const res = await get('/api/affiliate-payments?lineAccountId=account-1');
    expect(res.status).toBe(500);
    const body = await res.json<{ incidentId: string }>();
    expect(body).toMatchObject({ success: false, error: 'Internal Server Error' });
    expect(body.incidentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toContain('db unavailable');
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      source: 'worker', message: 'unhandled_worker_error', path: 'GET /api/affiliate-payments', incidentId: body.incidentId,
    });
  });
});

describe('紹介停止・アーカイブ', () => {
  it('影響を実データで返し、過去記録を残したまま停止する', async () => {
    const impact = await get('/api/affiliates/affiliate-1/archive-impact');
    expect(impact.status).toBe(200);
    expect(await impact.json()).toMatchObject({
      success: true,
      data: { activeLinks: 3, unsettledReward: 24000, pendingConversions: 2 },
    });

    const stopped = await post('/api/affiliates/affiliate-1/archive', { mode: 'pause' });
    expect(stopped.status).toBe(200);
    expect(dbMocks.updateAffiliateLifecycle).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      tenantId: 'tenant-1',
      lineAccountId: 'account-1',
      lifecycle: 'paused',
    }));
    expect(await stopped.json()).toMatchObject({ success: true, data: { recordsPreserved: true } });
  });

  it('アーカイブは紹介者名の一致を必要とする', async () => {
    expect((await post('/api/affiliates/affiliate-1/archive', {
      mode: 'archive', confirmationName: '別の名前',
    })).status).toBe(400);
    expect(dbMocks.updateAffiliateLifecycle).not.toHaveBeenCalled();
  });

  it('権限不足と取得失敗を成功扱いにしない', async () => {
    expect((await get('/api/affiliates/affiliate-1/archive-impact', 'staff')).status).toBe(403);
    dbMocks.getAffiliateArchiveImpact.mockRejectedValueOnce(new Error('db unavailable'));
    expect((await get('/api/affiliates/affiliate-1/archive-impact')).status).toBe(500);
  });
});

describe('支払い確定', () => {
  it('通常のプレビューを返し、内部の成果IDは返さない', async () => {
    const res = await get('/api/affiliate-payments/affiliate-1/preview?lineAccountId=account-1');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ amount: 72000, conversionCount: 18 });
    expect(body.data).not.toHaveProperty('entries');
  });

  it('0件・取得失敗・権限不足を通常データと区別する', async () => {
    dbMocks.previewAffiliateSettlement.mockResolvedValueOnce({
      affiliateId: 'affiliate-1', affiliateName: '見本 168', code: 'tanaka01',
      amount: 0, conversionCount: 0, periodFrom: null, periodTo: '2026-09-06T00:00:00.000Z',
      closeDate: null, paymentDate: null, bankDestination: null, breakdown: [], entries: [],
    });
    const empty = await get('/api/affiliate-payments/affiliate-1/preview?lineAccountId=account-1');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ data: { amount: 0, conversionCount: 0 } });

    dbMocks.previewAffiliateSettlement.mockRejectedValueOnce(new Error('db unavailable'));
    expect((await get('/api/affiliate-payments/affiliate-1/preview?lineAccountId=account-1')).status).toBe(500);
    expect((await get('/api/affiliate-payments/affiliate-1/preview?lineAccountId=account-1', 'staff')).status).toBe(403);
  });

  it('金額と再試行キーを検証して追記台帳へ確定する', async () => {
    const res = await post('/api/affiliate-payments/affiliate-1/confirm', {
      lineAccountId: 'account-1',
      expectedAmount: 72000,
      idempotencyKey: 'confirm-20260906-1',
    });
    expect(res.status).toBe(201);
    expect(dbMocks.confirmAffiliateSettlement).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      tenantId: 'tenant-1',
      actorId: 'staff-1',
      expectedAmount: 72000,
      idempotencyKey: 'confirm-20260906-1',
    }));
  });

  it('金額変更・重複再試行・権限不足を区別する', async () => {
    dbMocks.confirmAffiliateSettlement.mockResolvedValueOnce({ kind: 'changed' });
    const changed = await post('/api/affiliate-payments/affiliate-1/confirm', {
      lineAccountId: 'account-1', expectedAmount: 72000, idempotencyKey: 'confirm-changed-1',
    });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: 'SETTLEMENT_CHANGED' });

    dbMocks.confirmAffiliateSettlement.mockResolvedValueOnce({
      kind: 'duplicate', settlementId: 'settlement-1', amount: 72000,
      conversionCount: 18, closedAt: '2026-09-06T00:00:00.000Z',
    });
    expect((await post('/api/affiliate-payments/affiliate-1/confirm', {
      lineAccountId: 'account-1', expectedAmount: 72000, idempotencyKey: 'confirm-duplicate-1',
    })).status).toBe(200);
    expect((await post('/api/affiliate-payments/affiliate-1/confirm', {
      lineAccountId: 'account-1', expectedAmount: 72000, idempotencyKey: 'confirm-staff-1',
    }, 'staff')).status).toBe(403);
  });

  it('同じ再実行キーで別入力が来たら409で別紹介者の確定にしない', async () => {
    dbMocks.confirmAffiliateSettlement.mockResolvedValueOnce({ kind: 'idempotency_conflict' });
    const res = await post('/api/affiliate-payments/affiliate-1/confirm', {
      lineAccountId: 'account-1', expectedAmount: 72000, idempotencyKey: 'confirm-conflict-1',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});
