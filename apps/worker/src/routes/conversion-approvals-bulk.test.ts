import { describe, it, expect, vi, beforeEach } from 'vitest';

// 実 SQL は DB パッケージで検証する。ここでは部分失敗でも処理済み・失敗の一覧を返し、再試行で不足した承認通知だけが1回届くことを確かめる。
const dbMocks = {
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getLineAccountScopeEntries: vi.fn(async (...args: unknown[]) => dbMocks.getLineAccounts(...args)),
  getAccountSetting: vi.fn().mockResolvedValue(null),
  getVersionedAccountSetting: vi.fn().mockResolvedValue({
    version: 1,
    data: { features: { affiliates: true } },
  }),
  getPlatformSetting: async () => 'false', // Explicit Off fixture for route authorization.
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
  decideConversionApproval: vi.fn(),
  getConversionApprovalNotifyInfo: vi.fn(),
  getConversionOfferActionPlan: vi.fn().mockResolvedValue(null),
  syncAffiliateConversionMileage: vi.fn().mockResolvedValue(undefined),
  // 再送が already_set でも通知を取り残さないよう、送信記録を使う。
  getApprovalNotificationState: vi.fn(),
  markApprovalNotified: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const notifyAffiliateApproval = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/affiliate-notifier.js', () => ({ notifyAffiliateApproval }));

const worker = (await import('../index.js')).default;

const API_KEY = 'test-owner-key';
const env = {
  DB: {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn(async () => (sql.includes('WHERE ce.id = ?') ? { line_account_id: 'account-1' } : null)),
      all: vi.fn(async () => ({ results: [] })),
    })),
  } as unknown as D1Database,
  LINE_LOGIN_CHANNEL_ID: '2000000000',
  API_KEY,
  WORKER_URL: 'https://worker.example.com',
} as unknown as import('../index.js').Env['Bindings'];

function req(path: string, body: unknown) {
  const separator = path.includes('?') ? '&' : '?';
  const headers = new Headers({
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  });
  return worker.fetch(
    new Request(`https://worker.example.com${path}${separator}accountId=account-1`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
}

function bulkItems(ids: string[]) {
  return {
    items: ids.map((id) => ({ id, status: 'approved', expectedStatus: 'pending' })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getLineAccounts.mockResolvedValue([
    { id: 'account-1', tenant_id: '00000000-0000-4000-8000-000000000001' },
  ]);
  dbMocks.decideConversionApproval.mockResolvedValue({ outcome: 'updated', currentStatus: 'approved' });
  dbMocks.syncAffiliateConversionMileage.mockResolvedValue(undefined);
  dbMocks.getConversionApprovalNotifyInfo.mockResolvedValue({
    affiliateId: 'aff-1',
    offerName: '案件X',
    rewardAmount: 1000,
    notifyOnConversion: true,
  });
  dbMocks.getApprovalNotificationState.mockResolvedValue({ send: true, approvedAt: '2026-09-01T00:00:00.000+09:00' });
  dbMocks.markApprovalNotified.mockResolvedValue(true);
});

describe('成果の一括承認は途中の失敗を分けて残りを処理する', () => {
  it('途中で保存に失敗しても処理済みと失敗の一覧を返す', async () => {
    dbMocks.syncAffiliateConversionMileage.mockImplementation(
      async (_db: unknown, eventId: string) => {
        if (eventId === 'ce-2') throw new Error('engagement_events INSERT failed');
      },
    );
    const res = await req('/api/conversions/approvals/bulk', bulkItems(['ce-1', 'ce-2', 'ce-3']));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { succeeded: string[]; failed: Array<{ id: string; error: string }> };
    };
    expect(body.success).toBe(true);
    expect(body.data.succeeded).toEqual(['ce-1', 'ce-3']);
    expect(body.data.failed).toHaveLength(1);
    expect(body.data.failed[0]).toMatchObject({ id: 'ce-2' });
  });

  it('承認判断そのものが落ちても残りを処理する', async () => {
    dbMocks.decideConversionApproval.mockImplementation(async (_db: unknown, eventId: string) => {
      if (eventId === 'ce-1') throw new Error('D1 busy');
      return { outcome: 'updated', currentStatus: 'approved' };
    });
    const res = await req('/api/conversions/approvals/bulk', bulkItems(['ce-1', 'ce-2']));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { succeeded: string[]; failed: Array<{ id: string }> };
    };
    expect(body.data.succeeded).toEqual(['ce-2']);
    expect(body.data.failed.map((item) => item.id)).toEqual(['ce-1']);
  });

  it('当時額が未確定の成果（F-23 unbillable）は成功に入れず失敗に分ける', async () => {
    dbMocks.decideConversionApproval.mockImplementation(async (_db: unknown, eventId: string) => {
      if (eventId === 'ce-1') return { outcome: 'unbillable', currentStatus: 'pending' };
      return { outcome: 'updated', currentStatus: 'approved' };
    });
    const res = await req('/api/conversions/approvals/bulk', bulkItems(['ce-1', 'ce-2']));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { succeeded: string[]; failed: Array<{ id: string }> };
    };
    expect(body.data.succeeded).toEqual(['ce-2']);
    expect(body.data.failed.map((item) => item.id)).toEqual(['ce-1']);
  });
});

describe('成果の一括承認の再試行は未送信の通知だけを送る', () => {
  it('再試行（already_set）で欠けた通知を1回だけ送る', async () => {
    dbMocks.decideConversionApproval.mockResolvedValue({ outcome: 'already_set', currentStatus: 'approved' });
    const res = await req('/api/conversions/approvals/bulk', bulkItems(['ce-1']));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { succeeded: string[] } };
    expect(body.data.succeeded).toEqual(['ce-1']);
    expect(notifyAffiliateApproval).toHaveBeenCalledTimes(1);
    expect(notifyAffiliateApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'aff-1',
      '案件X',
      1000,
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    );
    expect(dbMocks.markApprovalNotified).toHaveBeenCalledTimes(1);
  });

  it('通知済みの再送では送らない（二重送信しない）', async () => {
    dbMocks.decideConversionApproval.mockResolvedValue({ outcome: 'already_set', currentStatus: 'approved' });
    dbMocks.getApprovalNotificationState.mockResolvedValue({
      send: false,
      approvedAt: '2026-09-01T00:00:00.000+09:00',
    });
    const res = await req('/api/conversions/approvals/bulk', bulkItems(['ce-1']));
    expect(res.status).toBe(200);
    expect(notifyAffiliateApproval).not.toHaveBeenCalled();
    expect(dbMocks.markApprovalNotified).not.toHaveBeenCalled();
  });
});
