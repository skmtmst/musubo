import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';

const dbMocks = vi.hoisted(() => ({
  listEcOrders: vi.fn(),
  listEcActionExecutions: vi.fn(),
  listEcIdentityCandidates: vi.fn(),
  retryEcActionExecution: vi.fn(),
}));
const canAccess = vi.hoisted(() => vi.fn());

vi.mock('@line-crm/db', () => dbMocks);
vi.mock('../services/account-access.js', () => ({ canAccessAllLineAccounts: canAccess }));

const { ecOperations } = await import('./ec-operations.js');

const DB = {} as D1Database;

function app(role: 'owner' | 'admin' | 'staff' = 'owner', permissionKeys: string[] = []) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', {
      id: 'staff-1', name: '担当者', role, readOnly: false,
      tenantId: 'tenant-1', permissionKeys,
    });
    await next();
  });
  instance.route('/', ecOperations);
  return instance;
}

function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    role?: 'owner' | 'admin' | 'staff';
    permissions?: string[];
  } = {},
) {
  return app(options.role, options.permissions).fetch(new Request(`https://example.com${path}`, {
    method: options.method,
    headers: { 'content-type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), { DB } as Env['Bindings']);
}

beforeEach(() => {
  vi.clearAllMocks();
  canAccess.mockResolvedValue(true);
  dbMocks.listEcOrders.mockResolvedValue({
    items: [{
      id: 'order-1', orderNumber: 'NEN-1001', totalAmount: 4200, currency: 'JPY',
      status: 'current', version: 1,
      orderLines: [{ id: 'line-1', productName: '鹿肉フード', quantity: 2 }],
    }],
    total: 1,
    summary: { total: 1, current: 1, refunded: 0, cancelled: 0, totalAmount: 4200 },
  });
  dbMocks.listEcActionExecutions.mockResolvedValue({
    items: [{
      id: 'action-1', status: 'retryable_failed', version: 2,
      attemptCount: 1, maxAttempts: 3, retryAvailable: true,
    }],
    total: 1,
    summary: {
      pending: 0, processing: 0, succeeded: 0, skipped: 0,
      retryable_failed: 1, permanent_failed: 0,
    },
  });
  dbMocks.listEcIdentityCandidates.mockResolvedValue({
    items: [{
      id: 'candidate-1', version: 1,
      left: { attributes: [{ label: 'メール', valuePreview: 'ta***@example.com' }] },
      right: { attributes: [{ label: '電話', valuePreview: '***1234' }] },
      impact: [{ key: 'orders', value: 6, unit: '件' }],
    }],
    total: 1,
    summary: {
      unmatched: 1, candidates: 1, candidateExternalCustomers: 1,
      duplicateSuspicions: 0, linked: 20, potentialRevenue: 4200,
    },
  });
  dbMocks.retryEcActionExecution.mockResolvedValue({
    kind: 'queued', execution: { id: 'action-1', status: 'pending', version: 3, retryAvailable: false },
  });
});

describe('EC order and action read models', () => {
  it('本物の注文明細と空状態を200で返す', async () => {
    const normal = await request('/api/ec-commerce/orders?lineAccountId=account-1');
    expect(normal.status).toBe(200);
    expect(await normal.json()).toMatchObject({
      data: { items: [{ orderNumber: 'NEN-1001', orderLines: [{ productName: '鹿肉フード' }] }] },
    });

    dbMocks.listEcOrders.mockResolvedValueOnce({
      items: [], total: 0,
      summary: { total: 0, current: 0, refunded: 0, cancelled: 0, totalAmount: 0 },
    });
    const empty = await request('/api/ec-commerce/orders?lineAccountId=account-1');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ data: { items: [], total: 0 } });
  });

  it('注文日の半開区間を検証してDBへ渡す', async () => {
    const from = '2026-10-27T15:00:00.000Z';
    const to = '2026-10-28T15:00:00.000Z';
    expect((await request(`/api/ec-commerce/orders?lineAccountId=account-1&from=${from}&to=${to}`)).status).toBe(200);
    expect(dbMocks.listEcOrders).toHaveBeenCalledWith(DB, expect.objectContaining({ lineAccountId: 'account-1', from, to }));
    expect((await request(`/api/ec-commerce/orders?lineAccountId=account-1&from=${to}&to=${from}`)).status).toBe(400);
    expect((await request(`/api/ec-commerce/orders?lineAccountId=account-1&from=${from}`)).status).toBe(400);
  });

  it('staffの閲覧権限とaccount範囲をサーバで検査する', async () => {
    const path = '/api/ec-commerce/action-executions?lineAccountId=account-1';
    expect((await request(path, { role: 'staff' })).status).toBe(403);
    expect((await request(path, { role: 'staff', permissions: ['ec.event.view'] })).status).toBe(200);
    canAccess.mockResolvedValueOnce(false);
    expect((await request('/api/ec-commerce/orders?lineAccountId=other')).status).toBe(403);
  });

  it('DB異常を空扱いにせず500にする', async () => {
    dbMocks.listEcOrders.mockRejectedValueOnce(new Error('db unavailable'));
    expect((await request('/api/ec-commerce/orders?lineAccountId=account-1')).status).toBe(500);
  });
});

describe('EC identity candidates and retry', () => {
  it('照合候補の集計・影響を返し、平文PIIを含めない', async () => {
    const response = await request('/api/ec-commerce/identity-candidates?lineAccountId=account-1');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('potentialRevenue');
    expect(text).toContain('ta***@example.com');
    expect(text).not.toContain('tanaka@example.com');
    expect(text).not.toContain('09000001234');
  });

  it('retry可能な失敗だけを版・冪等キー付きで待ち行列へ戻す', async () => {
    const response = await request('/api/ec-commerce/action-executions/action-1/retry', {
      method: 'POST', permissions: ['ec.action.retry'], role: 'staff',
      headers: { 'Idempotency-Key': 'retry-action-request-1' },
      body: { lineAccountId: 'account-1', expectedVersion: 2 },
    });
    expect(response.status).toBe(202);
    expect(dbMocks.retryEcActionExecution).toHaveBeenCalledWith(DB, expect.objectContaining({
      id: 'action-1', lineAccountId: 'account-1', expectedVersion: 2,
      idempotencyKey: 'retry-action-request-1', requestedBy: 'staff-1',
    }));
  });

  it('版競合・成功済み・別accountを409/404へ分ける', async () => {
    dbMocks.retryEcActionExecution.mockResolvedValueOnce({ kind: 'changed' });
    const changed = await request('/api/ec-commerce/action-executions/action-1/retry', {
      method: 'POST', headers: { 'Idempotency-Key': 'retry-action-request-2' },
      body: { lineAccountId: 'account-1', expectedVersion: 2 },
    });
    expect(changed.status).toBe(409);

    dbMocks.retryEcActionExecution.mockResolvedValueOnce({ kind: 'invalid_state', status: 'succeeded' });
    const succeeded = await request('/api/ec-commerce/action-executions/action-1/retry', {
      method: 'POST', headers: { 'Idempotency-Key': 'retry-action-request-3' },
      body: { lineAccountId: 'account-1', expectedVersion: 2 },
    });
    expect(succeeded.status).toBe(409);

    canAccess.mockResolvedValueOnce(false);
    const hidden = await request('/api/ec-commerce/action-executions/action-1/retry', {
      method: 'POST', headers: { 'Idempotency-Key': 'retry-action-request-4' },
      body: { lineAccountId: 'other', expectedVersion: 2 },
    });
    expect(hidden.status).toBe(404);
  });
});

 it('returns full revenue and independent member counts without recalculating from the page', async () => {
  dbMocks.listEcIdentityCandidates.mockResolvedValue({items:[],total:1000,summary:{potentialRevenue:123456,withoutCandidates:7,candidateExternalCustomers:10}});
  const response = await request('/api/ec-commerce/identity-candidates?lineAccountId=account-1&limit=1');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({data:{items:[],summary:{potentialRevenue:123456,withoutCandidates:7}}});
 });
