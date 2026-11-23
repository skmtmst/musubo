import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';

// 承認の権限と成功時の監査記録の契約を検証する。
//
// M1: 旧口3つ(GET points/events/approvals)は定義系と同じ
//     `conversionPermission('view')` で縛る。`/conversions` 権限の無い
//     職員は 403、権限あり・owner は 200。
// M7: 承認 PATCH の監査は成功確定後に残す。400/404 の失敗では
//     `conversion.approval.update` の監査を残さない。
const dbMocks = {
  recordAuditEvent: vi.fn(async () => undefined),
  maskAuditIp: () => null,
  auditDeviceFamily: () => null,
  getConversionPoints: vi.fn(),
  getConversionEvents: vi.fn(),
  getConversionApprovalQueue: vi.fn(),
  setConversionApproval: vi.fn(),
  decideConversionApproval: vi.fn(),
  syncAffiliateConversionMileage: vi.fn().mockResolvedValue(undefined),
  getConversionApprovalNotifyInfo: vi.fn().mockResolvedValue(null),
  //  の案件動作はここでは対象外 — 案件なしとして通す。
  getConversionOfferActionPlan: vi.fn().mockResolvedValue(null),
  // 取消台帳。権限試験では「取り消し無し」にする。
  getReversedEventIds: vi.fn().mockResolvedValue(new Set<string>()),
  listConversionReversals: vi.fn().mockResolvedValue([]),
  appendConversionReversal: vi.fn(),
  ConversionDefinitionError: class ConversionDefinitionError extends Error {},
  CONVERSION_DEFINITION_USAGE_KINDS: [],
};
vi.mock('@line-crm/db', () => dbMocks);

const accessMocks = {
  canAccessAllLineAccounts: vi.fn().mockResolvedValue(true),
  getVisibleLineAccountScope: vi.fn().mockResolvedValue({
    allowedAccountIds: ['account-1'], canSeeUnassigned: false,
  }),
};
vi.mock('../services/account-access.js', () => accessMocks);
vi.mock('../services/affiliate-notifier.js', () => ({
  notifyAffiliateApproval: vi.fn().mockResolvedValue(undefined),
}));

const { conversions } = await import('./conversions.js');

// 可視判定の SQL は通すが、行は db モックが返す。PATCH の可視判定
// (`WHERE ce.id = ?`) には行があるものとして返す。
const fakeDb = {
  prepare: vi.fn(() => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: [] })),
    first: vi.fn(async () => ({ line_account_id: 'account-1' })),
  })),
} as unknown as D1Database;
const env = { DB: fakeDb } as unknown as Env['Bindings'];

function app(role: 'owner' | 'admin' | 'staff', permissionKeys: string[]) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', {
      id: 'actor-1', name: '担当', role, readOnly: false, permissionKeys,
      tenantId: 'tenant-a', assignedLineAccountId: null, canAccessDescendantAccounts: false,
    });
    return next();
  });
  instance.route('/', conversions);
  return instance;
}

function request(
  method: string,
  path: string,
  role: 'owner' | 'admin' | 'staff' = 'staff',
  permissionKeys: string[] = [],
  body?: unknown,
) {
  const headers = new Headers();
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return app(role, permissionKeys).fetch(
    new Request(`https://example.com${path}`, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    env,
  );
}

function auditLogged(calls: unknown[][]): boolean {
  return dbMocks.recordAuditEvent.mock.calls.some((args) =>
    (args as unknown as [unknown, { action: string }])[1].action === 'conversion.approval.update');
}

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.canAccessAllLineAccounts.mockResolvedValue(true);
  accessMocks.getVisibleLineAccountScope.mockResolvedValue({
    allowedAccountIds: ['account-1'], canSeeUnassigned: false,
  });
  dbMocks.getConversionPoints.mockResolvedValue([]);
  dbMocks.getConversionEvents.mockResolvedValue([]);
  dbMocks.getConversionApprovalQueue.mockResolvedValue([]);
  dbMocks.syncAffiliateConversionMileage.mockResolvedValue(undefined);
  dbMocks.getConversionApprovalNotifyInfo.mockResolvedValue(null);
});

describe('成果地点・成果・承認の一覧は閲覧権限を確認する', () => {
  it.each([
    ['/api/conversions/points'],
    ['/api/conversions/events'],
    ['/api/conversions/approvals?status=pending'],
  ])('%s は権限なし職員に 403', async (path) => {
    const res = await request('GET', path, 'staff', []);
    expect(res.status).toBe(403);
  });

  it.each([
    ['/api/conversions/points'],
    ['/api/conversions/events'],
    ['/api/conversions/approvals?status=pending'],
  ])('%s は /conversions 権限あり職員に 200', async (path) => {
    const res = await request('GET', path, 'staff', ['/conversions']);
    expect(res.status).toBe(200);
  });

  it('owner は権限キーなしでも 200', async () => {
    for (const path of ['/api/conversions/points', '/api/conversions/events', '/api/conversions/approvals?status=pending']) {
      const res = await request('GET', path, 'owner', []);
      expect(res.status).toBe(200);
    }
  });
});

describe('成果の承認は保存が成功したときだけ監査を残す', () => {
  it('入力不備の 400 では監査を残さない', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await request('PATCH', '/api/conversions/events/ev-1/approval', 'owner', [], { status: 'maybe' });
      expect(res.status).toBe(400);
      expect(auditLogged(log.mock.calls)).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it('成功の 200 では監査を残す', async () => {
    dbMocks.decideConversionApproval.mockResolvedValue({ outcome: 'updated', currentStatus: 'approved' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await request('PATCH', '/api/conversions/events/ev-1/approval', 'owner', [], { status: 'approved', expectedStatus: 'pending' });
      expect(res.status).toBe(200);
      expect(auditLogged(log.mock.calls)).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});
