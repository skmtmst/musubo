import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { unhandledWorkerError } from '../lib/unhandled-error.js';
import type { Env } from '../worker-env.js';
import { lineAccounts } from './line-accounts.js';

const dbMocks = vi.hoisted(() => ({
  getLineAccountScopeEntries: vi.fn(),
  getLineAccountById: vi.fn(),
  getStaffById: vi.fn(),
  getStaffAccountScopeIds: vi.fn(),
}));
vi.mock('@line-crm/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@line-crm/db')>(),
  ...dbMocks,
}));

const receiptErrorReport = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../services/codex-slack-relay.js', () => ({ reportHarnessErrorToSlack: receiptErrorReport }));

function makeDbStub() {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })),
    })),
  };
}

function setupApp(db = makeDbStub()) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'test-staff', name: 'Test', role: 'owner', readOnly: false });
    c.env = { DB: db } as unknown as Env['Bindings'];
    await next();
  });
  app.route('/', lineAccounts);
  app.onError(unhandledWorkerError);
  return app;
}

beforeEach(() => {
  dbMocks.getLineAccountScopeEntries.mockReset().mockResolvedValue([
    { id: 'acc-1', tenant_id: null },
    { id: 'acc-other', tenant_id: null },
  ]);
  dbMocks.getLineAccountById.mockReset().mockImplementation(async (_db, id: string) => ({ id, archived_at: null }));
  dbMocks.getStaffById.mockReset().mockResolvedValue({ account_scope: 'all' });
  dbMocks.getStaffAccountScopeIds.mockReset().mockResolvedValue(['acc-1']);
});

describe('GET /api/line-accounts/:id/registration-receipt', () => {
  test.each(['account scope', 'inbound receipt'])('unexpected %s failure reaches the shared incident handler', async (stage) => {
    const secret = 'private-customer secret-token';
    const db = makeDbStub();
    if (stage === 'account scope') dbMocks.getLineAccountScopeEntries.mockRejectedValueOnce(new Error(secret));
    else db.prepare.mockImplementationOnce(() => { throw new Error(secret); });
    const response = await setupApp(db).request('/api/line-accounts/acc-1/registration-receipt?token=secret-token');
    const body = await response.json<{ incidentId: string }>();
    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.incidentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receiptErrorReport).toHaveBeenLastCalledWith(expect.anything(), {
      source: 'worker', message: 'unhandled_worker_error',
      path: 'GET /api/line-accounts/:id/registration-receipt', incidentId: body.incidentId,
    });
    expect(JSON.stringify([body, receiptErrorReport.mock.calls])).not.toMatch(/private-customer|secret-token/);
  });

  test('only exposes a receipt in the current account scope', async () => {
    dbMocks.getStaffById.mockResolvedValue({ account_scope: 'accounts' });
    const app = setupApp();
    const allowed = await app.request('/api/line-accounts/acc-1/registration-receipt');
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('Cache-Control')).toBe('no-store');
    expect(await allowed.json()).toEqual({
      success: true, data: { status: 'waiting', receivedAt: null },
    });
    const denied = await app.request('/api/line-accounts/acc-other/registration-receipt');
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ success: false, code: 'LINE_ACCOUNT_NOT_FOUND', error: 'LINE公式アカウントが見つかりません。一覧から開き直してください。' });
  });
});
