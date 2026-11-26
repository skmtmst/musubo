import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { unhandledWorkerError } from '../lib/unhandled-error.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import { emptyFollowerImportState, FOLLOWER_IMPORT_STATE_KEY } from '../services/follower-import.js';
import { setAccountSetting } from '@line-crm/db';
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

function setupApp(db: D1Database | ReturnType<typeof makeDbStub> = makeDbStub(), role?: { role: 'staff'; hqRole?: 'operator' }) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'test-staff', name: 'Test', role: 'owner', readOnly: false, ...role });
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
  dbMocks.getLineAccountById.mockReset().mockImplementation(async (_db, id: string) => ({ id, is_active: 1, archived_at: null, created_by_staff_id: 'test-staff' }));
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

  test.each([
    { is_active: 0, archived_at: null, created_by_staff_id: 'test-staff', status: 409, code: 'LINE_ACCOUNT_INACTIVE' },
    { is_active: 0, archived_at: '2026-11-24', created_by_staff_id: 'test-staff', status: 404, code: 'LINE_ACCOUNT_NOT_FOUND' },
    { is_active: 1, archived_at: null, created_by_staff_id: 'other-staff', status: 404, code: 'LINE_ACCOUNT_NOT_FOUND' },
  ])('does not use receipt history of an ineligible account ($code)', async ({ status, code, ...account }) => {
    dbMocks.getLineAccountById.mockResolvedValueOnce({ id: 'acc-1', ...account });
    const db = makeDbStub();
    const response = await setupApp(db).request('/api/line-accounts/acc-1/registration-receipt');
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ success: false, code });
    expect(db.prepare).not.toHaveBeenCalled();
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


test('only discovers a visible, active, initially unconfigured registration for the same creator', async () => {
  const fixture = createTestD1();
  try {
    fixture.raw.exec(`
      INSERT INTO line_accounts (id, channel_id, name, created_by_staff_id, channel_access_token, channel_secret)
      VALUES ('acc-1', '1234567890', '追加店舗', 'test-staff', 'token', 'secret'),
             ('acc-other', '1234567891', '別担当', 'another-staff', 'token', 'secret');
      INSERT INTO account_styles (line_account_id, style, selection_mode, answers_json, updated_at)
      VALUES ('acc-1', 'standard', 'later', '{"style":{"selectionPending":true}}', '2026-11-24'),
             ('acc-other', 'standard', 'later', '{"style":{"selectionPending":true}}', '2026-11-24');
    `);
    const app = setupApp(fixture.db);
    const resume = (channelId: string) => app.request(`/api/line-accounts/registration-resume?channel_id=${channelId}`);
    const own = await resume('1234567890');
    expect(own.status).toBe(200);
    expect(own.headers.get('Cache-Control')).toBe('no-store');
    expect(await own.json()).toEqual({ success: true, data: { accountId: 'acc-1' } });
    expect((await resume('1234567891')).status).toBe(404);
    expect((await resume('invalid')).status).toBe(422);

    const entry = async (accountId: string) =>
      (await app.request(`/api/line-accounts/${accountId}/follower-import?entry=1`)).json();
    expect(await entry('acc-1')).toMatchObject({ data: { destination: 'registration', canResume: true } });
    const operator = setupApp(fixture.db, { role: 'staff', hqRole: 'operator' });
    const operatorEntry = await operator.request('/api/line-accounts/acc-1/follower-import?entry=1');
    expect(await operatorEntry.json()).toMatchObject({ data: { destination: 'registration', canResume: true } });
    expect(await entry('acc-other')).toMatchObject({ data: { destination: 'unavailable', canResume: false } });
    dbMocks.getStaffById.mockResolvedValueOnce({ account_scope: 'accounts' });
    expect(await entry('acc-1')).toMatchObject({ data: { destination: 'unavailable', canResume: false } });

    fixture.raw.prepare("UPDATE line_accounts SET is_active = 0 WHERE id = 'acc-1'").run();
    expect((await resume('1234567890')).status).toBe(404);
    expect(await entry('acc-1')).toMatchObject({ data: { destination: 'unavailable', canResume: false } });
    fixture.raw.prepare(`
      INSERT INTO musubo_pending_additions
        (id, tenant_id, kind, line_account_id, status, amount_due_yen, price_snapshot_json, expires_at, created_at, updated_at)
      VALUES ('charge-1', ?, 'line', 'acc-1', 'awaiting_payment', 1000, '{}', '2026-12-01', '2026-11-24', '2026-11-24')
    `).run(DEFAULT_TENANT_ID);
    expect(await entry('acc-1')).toMatchObject({ data: { destination: 'billing', canResume: false } });
    expect(await entry('acc-other')).toMatchObject({ data: { destination: 'unavailable', canResume: false } });

    fixture.raw.prepare("UPDATE line_accounts SET is_active = 1, archived_at = '2026-11-24' WHERE id = 'acc-1'").run();
    expect((await resume('1234567890')).status).toBe(404);
    expect(await entry('acc-1')).toMatchObject({ success: false, code: 'LINE_ACCOUNT_NOT_FOUND' });
    fixture.raw.prepare("UPDATE line_accounts SET archived_at = NULL WHERE id = 'acc-1'").run();
    fixture.raw.prepare("UPDATE musubo_pending_additions SET status = 'activated' WHERE id = 'charge-1'").run();
    expect(await entry('acc-1')).toMatchObject({ data: { destination: 'registration', canResume: true } });
    fixture.raw.prepare("UPDATE account_styles SET selection_mode = 'configured', selected_at = '2026-11-24' WHERE line_account_id = 'acc-1'").run();
    expect((await resume('1234567890')).status).toBe(404);
    expect(await entry('acc-1')).toMatchObject({ data: { destination: 'dashboard', canResume: true } });
    const importState = { ...emptyFollowerImportState(), phase: 'importing_ids' };
    await setAccountSetting(fixture.db, 'acc-1', FOLLOWER_IMPORT_STATE_KEY, JSON.stringify(importState));
    const staff = setupApp(fixture.db, { role: 'staff' });
    const staffEntry = await staff.request('/api/line-accounts/acc-1/follower-import?entry=1');
    expect(await staffEntry.json()).toMatchObject({ data: { destination: 'dashboard', canResume: false } });
    expect(await entry('acc-1')).toMatchObject({ data: { destination: 'handover', canResume: true } });
  } finally {
    fixture.raw.close();
  }
});
