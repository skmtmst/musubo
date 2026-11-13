import { apiContractMiddleware } from '../middleware/api-contract.js';
vi.mock('../services/line-messaging-identity.js', () => ({ verifyLineMessagingIdentity: vi.fn().mockResolvedValue(true) }));
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono, type ErrorHandler } from 'hono';
import type { Env } from '../worker-env.js';

// route の責務である入力正規化と引数の接続を確かめるため、実 D1 でなく DB 関数へ渡る値を観測する。
const dbMocks = {
  getLineAccounts: vi.fn(),
  getLineAccountScopeEntries: vi.fn(),
  getLineAccountsByIds: vi.fn(),
  getLineAccountListStats: vi.fn(),
  getLineAccountFoldersByAccountIds: vi.fn(async()=>({})),
  getLineAccountTag: vi.fn(),
  getLineAccountTagsByAccountIds: vi.fn(async () => ({})),
  getLineAccountById: vi.fn(),
  getLineAccountCredentialHealth: vi.fn(),
  createLineAccount: vi.fn(),
  listLineAccountTags: vi.fn(async () => [{id:'tag-own',tenant_id:'tenant-1'}]),
  updateLineAccount: vi.fn(),
  updateLineAccountFields: vi.fn(),
  updateLineAccountOrder: vi.fn(),
  deleteUncommittedLineAccount: vi.fn(),
  getLineAccountArchiveBlockers: vi.fn(),
  setDefaultLineAccount: vi.fn(),
  archiveLineAccount: vi.fn(),
  restoreLineAccount: vi.fn(),
  deactivateLineAccount: vi.fn(),
  activateLineAccount: vi.fn(),
  listSkippedDeliveries: vi.fn(),
  getLineAccountConnectionChecksByIdempotencyKey: vi.fn(),
  saveLineAccountConnectionChecks: vi.fn(),
  getAccountSetting: vi.fn(),
  setAccountSetting: vi.fn(),
  getStaffById: vi.fn(),
  getTenantBilling: vi.fn(),
  getMusuboTenantBilling: vi.fn(),
  musuboLineConnectionAllowed: vi.fn(async () => 'legacy'),
  activateFirstMusuboLine: vi.fn(),
  getStaffAccountScopeIds: vi.fn(),
  CredentialEncryptionKeyError: class CredentialEncryptionKeyError extends Error {},
  LineAccountRevisionConflictError: class LineAccountRevisionConflictError extends Error {},
  LineAccountLifecycleError: class LineAccountLifecycleError extends Error {
    constructor(public readonly code: string) { super(code); this.name = 'LineAccountLifecycleError'; }
  },
  // 接続・鍵・停止の直前再確認。ここでは本体の検証を見たいので確認済みとして通す。
  consumeStepUpGrant: vi.fn(async () => true),
  getAdminSessionByTokenHash: vi.fn(async () => null),
  jstNow: vi.fn(() => '2026-08-10T12:00:00.000+09:00'),
};
vi.mock('@line-crm/db', () => dbMocks);

const styleMocks=vi.hoisted(()=>({initializeAccountStyle:vi.fn(async()=>({}))}));
vi.mock('../services/style-setup.js',()=>styleMocks);

const lineClientMocks = {
  getFollowersInsight: vi.fn(),
  getFollowerIds: vi.fn(),
};
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(function () { return lineClientMocks; }),
}));

// 差替済みの依存を使うよう、モック登録後に再読込する。
const { lineAccounts } = await import('./line-accounts.js');
const { unhandledWorkerError } = await import('../lib/unhandled-error.js');
const receiptErrorReport = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../services/codex-slack-relay.js', () => ({ reportHarnessErrorToSlack: receiptErrorReport }));

type TestEnv = {
  Variables: { staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff'; readOnly: boolean; assignedLineAccountId?: string | null; canAccessDescendantAccounts?: boolean; tenantId?: string | null } };
  Bindings: { DB: D1Database; STRIPE_PRODUCT_MUSUBO_CORE: string; STRIPE_PRODUCT_MUSUBO_OPTIONS: string };
};

// 一意性の検証は既定で未検出とし、重複を試す場合だけ firstResult を変える。
function makeDbStub(firstResult: unknown = null): D1Database {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn().mockResolvedValue({ results: [] }),
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(firstResult),
      })),
    })),
  } as unknown as D1Database;
}

function setupApp(
  role: 'owner' | 'admin' | 'staff' = 'owner',
  dbStub: D1Database = makeDbStub(),
  staffOverride: Partial<TestEnv['Variables']['staff']> = {},
) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'test-staff', name: 'Test', role, readOnly: false, ...staffOverride });
    c.env = { DB: dbStub, STRIPE_PRODUCT_MUSUBO_CORE: 'prod_test', STRIPE_PRODUCT_MUSUBO_OPTIONS: 'prod_options' };
    // 大事な操作の直前再確認。ここでは本体の検証を見たいので確認済みとして通す。
    c.req.raw.headers.set('x-step-up-token', 'test-step-up');
    await next();
  });
  app.route('/', lineAccounts);
  // 通知先が未設定でも応答を返せるため、最小の試験環境へ共通の失敗処理を接続する。
  app.onError(unhandledWorkerError as ErrorHandler);
  return app;
}

const fakeAccount = {
  id: 'acc-1',
  channel_id: '123456789',
  name: 'メイン',
  channel_access_token: 'token',
  channel_secret: 'secret',
  channel_access_token_updated_at: null,
  channel_secret_updated_at: null,
  login_channel_secret_updated_at: null,
  login_channel_id: null,
  login_channel_secret: null,
  liff_id: null,
  is_active: 1,
  is_default: 0,
  archived_at: null,
  archived_by: null,
  archived_reason: null,
  country: null,
  role: null,
  timezone: 'Asia/Tokyo',
  revision: 1,
  official_profile_url: null,
  display_order: 0,
  token_expires_at: null,
  created_at: '2026-05-08T00:00:00.000',
  updated_at: '2026-05-08T00:00:00.000',
};

describe('GET /api/line-accounts/:id/registration-receipt', () => {
  test.each(['account scope', 'inbound receipt'])('unexpected %s failure reaches the shared incident handler', async (stage) => {
    const secret = 'private-customer secret-token';
    const db = makeDbStub();
    if (stage === 'account scope') dbMocks.getLineAccountScopeEntries.mockRejectedValueOnce(new Error(secret));
    else vi.mocked(db.prepare).mockImplementationOnce(() => { throw new Error(secret); });
    const app = new Hono<Env>().route('/', setupApp('owner', db));
    app.onError(unhandledWorkerError);
    const response = await app.request('/api/line-accounts/acc-1/registration-receipt?token=secret-token');
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
    const app = setupApp('owner', makeDbStub(), {
      assignedLineAccountId: 'acc-1', canAccessDescendantAccounts: false,
    });
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

beforeEach(() => {
  styleMocks.initializeAccountStyle.mockClear();
  for (const fn of Object.values(dbMocks)) {
    if ('mockReset' in fn) fn.mockReset();
  }
  lineClientMocks.getFollowersInsight.mockReset();
  lineClientMocks.getFollowerIds.mockReset();
  dbMocks.getAccountSetting.mockResolvedValue(null);
  dbMocks.musuboLineConnectionAllowed.mockResolvedValue('legacy');
  dbMocks.getMusuboTenantBilling.mockResolvedValue(null);
  dbMocks.getLineAccountFoldersByAccountIds.mockResolvedValue({});
  dbMocks.getLineAccountTag.mockResolvedValue({id:'folder-1'});
  dbMocks.listLineAccountTags.mockResolvedValue([{id:'tag-own',tenant_id:'tenant-1'}]);
  dbMocks.getStaffById.mockResolvedValue({ is_active: 1, account_scope: 'all' });
  dbMocks.getStaffAccountScopeIds.mockResolvedValue([]);
  dbMocks.getLineAccounts.mockResolvedValue([{ ...fakeAccount, parent_line_account_id: null }]);
  dbMocks.getLineAccountScopeEntries.mockImplementation(async () =>
    dbMocks.getLineAccounts());
  dbMocks.getLineAccountsByIds.mockImplementation(async (_db, ids: string[]) => {
    const rows = await dbMocks.getLineAccounts();
    return rows.filter((row: { id: string }) => ids.includes(row.id));
  });
  dbMocks.getLineAccountListStats.mockResolvedValue({
    'acc-1': {
      friendCount: 12,
      activeScenarios: 3,
      messagesThisMonth: 8,
      staffCount: 2,
      connection: { status: 'ok', checkedAt: '2026-09-15T10:00:00.000Z' },
    },
  });
  dbMocks.getLineAccountCredentialHealth.mockResolvedValue(null);
  dbMocks.getLineAccountById.mockResolvedValue(fakeAccount);
  dbMocks.getLineAccountArchiveBlockers.mockResolvedValue([]);
  dbMocks.setDefaultLineAccount.mockResolvedValue({ ...fakeAccount, is_default: 1 });
  dbMocks.archiveLineAccount.mockResolvedValue({
    ...fakeAccount,
    is_active: 0,
    archived_at: '2026-08-10T12:00:00.000+09:00',
    archived_by: 'test-staff',
    archived_reason: '利用終了',
  });
  dbMocks.restoreLineAccount.mockResolvedValue({ ...fakeAccount, is_active: 0 });
  dbMocks.getLineAccountConnectionChecksByIdempotencyKey.mockResolvedValue([]);
  dbMocks.saveLineAccountConnectionChecks.mockImplementation(async (_db, input) =>
    input.checks.map((check: Record<string, unknown>, index: number) => ({
      id: `check-${index}`,
      line_account_id: input.lineAccountId,
      check_kind: check.kind,
      result: check.result,
      expected_url: check.expectedUrl ?? null,
      registered_url: check.registeredUrl ?? null,
      webhook_active: check.webhookActive == null ? null : (check.webhookActive ? 1 : 0),
      http_status: check.httpStatus ?? null,
      checked_by: input.checkedBy,
      checked_at: input.checkedAt,
      correlation_id: input.correlationId,
      idempotency_key: input.idempotencyKey,
      account_revision: input.expectedRevision + 1,
    })),
  );
  dbMocks.setAccountSetting.mockResolvedValue(undefined);
  dbMocks.jstNow.mockReturnValue('2026-08-10T12:00:00.000+09:00');
  lineClientMocks.getFollowerIds.mockResolvedValue({ userIds: [] });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/v2/bot/info')) return Response.json({ displayName: 'テスト' });
    if (url.endsWith('/v2/bot/channel/webhook/endpoint')) {
      return Response.json({ endpoint: 'http://localhost/webhook', active: true });
    }
    if (url.endsWith('/v2/bot/channel/webhook/test')) return Response.json({ success: true });
    if (url.endsWith('/v2/bot/message/quota')) return Response.json({ type: 'limited', value: 200 });
    return new Response(null, { status: 404 });
  }));
});

test.each([
  ['/api/line-accounts/connect', 'requires_payment'],
  ['/api/line-accounts', 'requires_payment'],
  ['/api/line-accounts/connect', 'first'],
  ['/api/line-accounts', 'first'],
] as const)('new pricing gate blocks unpaid LINE connection: %s / %s', async (path, state) => {
  dbMocks.musuboLineConnectionAllowed.mockResolvedValue(state);
  if (state === 'first') dbMocks.getTenantBilling.mockResolvedValue({ stripe_customer_id: null });
  const response = await setupApp('owner').request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  expect(response.status).toBe(409);
  expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
});

describe('LINE account default and archive lifecycle', () => {
  test('owner switches the one organization default', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ ...fakeAccount, tenant_id: 'tenant-a' });
    dbMocks.getLineAccounts.mockResolvedValue([
      { ...fakeAccount, tenant_id: 'tenant-a', parent_line_account_id: null },
    ]);
    const res = await setupApp('owner', makeDbStub(), { tenantId: 'tenant-a' }).request(
      '/api/line-accounts/default',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: 'acc-1' }),
      },
    );

    expect(res.status).toBe(200);
    expect(dbMocks.setDefaultLineAccount).toHaveBeenCalledWith(expect.anything(), 'acc-1', 'tenant-a');
    await expect(res.json()).resolves.toMatchObject({ data: { isDefault: true } });
  });

  test('archive returns every prerequisite blocker without changing the account', async () => {
    dbMocks.getLineAccountArchiveBlockers.mockResolvedValue([
      'account_active',
      'default_account',
      'delivery_job_running',
      'traffic_pool_member',
    ]);

    const res = await setupApp('owner').request('/api/line-accounts/acc-1/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '利用終了' }),
    });

    expect(res.status).toBe(409);
    expect(dbMocks.archiveLineAccount).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      error: 'LINE_ACCOUNT_ARCHIVE_BLOCKED',
      details: { blockers: ['account_active', 'default_account', 'delivery_job_running', 'traffic_pool_member'] },
    });
  });

  test('archive records actor and reason, while DELETE uses the same archive path', async () => {
    const app = setupApp('owner');
    const archive = await app.request('/api/line-accounts/acc-1/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '利用終了' }),
    });
    expect(archive.status).toBe(200);
    expect(dbMocks.archiveLineAccount).toHaveBeenLastCalledWith(
      expect.anything(), 'acc-1', 'test-staff', '利用終了',
    );

    const legacyDelete = await app.request('/api/line-accounts/acc-1', { method: 'DELETE' });
    expect(legacyDelete.status).toBe(200);
    expect(dbMocks.archiveLineAccount).toHaveBeenLastCalledWith(
      expect.anything(), 'acc-1', 'test-staff', '旧DELETE APIからのアーカイブ',
    );
    expect(dbMocks.deleteUncommittedLineAccount).not.toHaveBeenCalled();
  });

  test('archived accounts remain readable but reject writes with ACCOUNT_ARCHIVED', async () => {
    const archivedAccount = {
      ...fakeAccount,
      is_active: 0,
      archived_at: '2026-08-10T12:00:00.000+09:00',
    };
    dbMocks.getLineAccountById.mockResolvedValue(archivedAccount);
    dbMocks.getLineAccounts.mockResolvedValue([
      { ...archivedAccount, parent_line_account_id: null },
    ]);
    const app = setupApp('owner');

    expect((await app.request('/api/line-accounts/acc-1')).status).toBe(200);
    const write = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '変更不可' }),
    });
    expect(write.status).toBe(409);
    await expect(write.json()).resolves.toEqual({ success: false, error: 'ACCOUNT_ARCHIVED' });
  });

  test('owner restores an archived account in the stopped state', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      is_active: 0,
      archived_at: '2026-08-10T12:00:00.000+09:00',
    });
    const res = await setupApp('owner').request('/api/line-accounts/acc-1/restore', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(dbMocks.restoreLineAccount).toHaveBeenCalledWith(expect.anything(), 'acc-1');
    await expect(res.json()).resolves.toMatchObject({ data: { isActive: false, archivedAt: null } });
  });
});

// X-1: 送受信の停止・再開。理由は必須、再開は接続を確かめてから。
describe('POST /api/line-accounts/:id/deactivate', () => {
  const activeAccount = { ...fakeAccount, is_active: 1 };

  test('理由つきで止められる', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(activeAccount);
    dbMocks.deactivateLineAccount.mockResolvedValue({
      ...activeAccount,
      is_active: 0,
      inactive_reason: 'manual',
      inactive_reason_detail: 'LINE側の不具合調査のため',
      inactivated_at: '2026-08-10T12:00:00.000+09:00',
    });
    const res = await setupApp('owner').request('/api/line-accounts/acc-1/deactivate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'LINE側の不具合調査のため' }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.deactivateLineAccount).toHaveBeenCalledWith(expect.anything(), 'acc-1', {
      reason: 'manual',
      detail: 'LINE側の不具合調査のため',
    });
    await expect(res.json()).resolves.toMatchObject({
      data: { isActive: false, inactiveReason: 'manual', inactiveReasonDetail: 'LINE側の不具合調査のため' },
    });
  });

  test('理由が無いと422で止まる', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(activeAccount);
    const res = await setupApp('owner').request('/api/line-accounts/acc-1/deactivate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '' }),
    });
    expect(res.status).toBe(422);
    expect(dbMocks.deactivateLineAccount).not.toHaveBeenCalled();
  });

  test('既定アカウントは止められない（409 ACCOUNT_DEFAULT）', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ ...activeAccount, is_default: 1 });
    dbMocks.deactivateLineAccount.mockRejectedValue(
      new dbMocks.LineAccountLifecycleError('ACCOUNT_DEFAULT'),
    );
    const res = await setupApp('owner').request('/api/line-accounts/acc-1/deactivate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'テスト' }),
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'ACCOUNT_DEFAULT' });
  });

  test('アーカイブ済みは409 ACCOUNT_ARCHIVED', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({
      ...activeAccount, archived_at: '2026-08-10T12:00:00.000+09:00',
    });
    const res = await setupApp('owner').request('/api/line-accounts/acc-1/deactivate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'テスト' }),
    });
    expect(res.status).toBe(409);
    expect(dbMocks.deactivateLineAccount).not.toHaveBeenCalled();
  });

  test('adminも止められる（確認は別途）', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(activeAccount);
    dbMocks.deactivateLineAccount.mockResolvedValue({ ...activeAccount, is_active: 0 });
    const res = await setupApp('admin').request('/api/line-accounts/acc-1/deactivate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'テスト' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/line-accounts/:id/activate', () => {
  const stoppedAccount = {
    ...fakeAccount,
    is_active: 0,
    inactive_reason: 'manual',
    inactive_reason_detail: '調査',
    inactivated_at: '2026-08-09T12:00:00.000+09:00',
  };

  test('接続が通れば理由つきで再開できる', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(stoppedAccount);
    dbMocks.activateLineAccount.mockResolvedValue({ ...stoppedAccount, is_active: 1 });
    const res = await setupApp('owner').request('/api/line-accounts/acc-1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '接続を直した' }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.activateLineAccount).toHaveBeenCalledWith(expect.anything(), 'acc-1');
    // 接続確認の記録も残す（checks台帳へ書いている）。
    expect(dbMocks.saveLineAccountConnectionChecks).toHaveBeenCalled();
  });

  test('接続が通らないときは再開しない（422）', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(stoppedAccount);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    const res = await setupApp('owner').request('/api/line-accounts/acc-1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '接続を直したつもり' }),
    });
    expect(res.status).toBe(422);
    expect(dbMocks.activateLineAccount).not.toHaveBeenCalled();
    const body = await res.json() as { checks?: Array<{ kind: string }> };
    expect(body.checks?.some((check) => check.kind === 'bot_info')).toBe(true);
  });

  test('理由が無いと422（接続確認もしない）', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(stoppedAccount);
    const res = await setupApp('owner').request('/api/line-accounts/acc-1/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    expect(dbMocks.activateLineAccount).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/line-accounts/:id/skipped-deliveries', () => {
  test('止めている間に送らなかった配信の一覧を返す', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ ...fakeAccount, is_active: 0 });
    dbMocks.listSkippedDeliveries.mockResolvedValue([
      {
        id: 'skip-1', line_account_id: 'acc-1', kind: 'broadcast', ref_id: 'bc-1',
        title: 'おはよう配信', reason: 'account_inactive', skipped_at: '2026-08-10T12:00:00.000+09:00',
      },
    ]);
    const res = await setupApp('owner').request('/api/line-accounts/acc-1/skipped-deliveries');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: [{ kind: 'broadcast', refId: 'bc-1', title: 'おはよう配信', reason: 'account_inactive' }],
    });
  });
});

describe('PATCH/PUT の isActive 窓口（X-1）', () => {
  test('PATCH で isActive を変えることは422で断る（理由が必須のため別窓口へ）', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ ...fakeAccount, is_active: 1 });
    const res = await setupApp('owner').request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });
    expect(res.status).toBe(422);
    expect(dbMocks.updateLineAccountFields).not.toHaveBeenCalled();
  });
});

describe('GET /api/line-accounts/:id/credential-health', () => {
  const health = {
    channel_access_token: {
      encrypted: true,
      decryptable: false,
      source: 'plaintext' as const,
    },
    channel_secret: {
      encrypted: true,
      decryptable: true,
      source: 'encrypted' as const,
    },
  };

  test('returns only credential status for an account in the owner scope', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(fakeAccount);
    dbMocks.getLineAccountCredentialHealth.mockResolvedValue(health);
    const app = setupApp('owner');

    const res = await app.request('/api/line-accounts/acc-1/credential-health');

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: typeof health };
    expect(body).toEqual({ success: true, data: health });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('actual-access-value-must-not-return');
    expect(serialized).not.toContain('actual-secret-value-must-not-return');
    expect(Object.keys(body.data.channel_access_token).sort()).toEqual([
      'decryptable',
      'encrypted',
      'source',
    ]);
  });

  test('returns the same not-found response for an account outside the owner scope', async () => {
    const otherAccount = {
      ...fakeAccount,
      id: 'acc-other',
      tenant_id: 'other-organization',
      parent_line_account_id: null,
    };
    dbMocks.getLineAccountById.mockResolvedValue(otherAccount);
    dbMocks.getLineAccounts.mockResolvedValue([
      { ...fakeAccount, parent_line_account_id: null },
      otherAccount,
    ]);
    dbMocks.getLineAccountCredentialHealth.mockResolvedValue(health);
    const app = setupApp('owner', makeDbStub(), {
      assignedLineAccountId: 'acc-1',
      canAccessDescendantAccounts: true,
    });

    const res = await app.request('/api/line-accounts/acc-other/credential-health');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      success: false,
      code: 'LINE_ACCOUNT_NOT_FOUND', error: 'LINE公式アカウントが見つかりません。一覧から開き直してください。',
    });
    expect(dbMocks.getLineAccountCredentialHealth).not.toHaveBeenCalled();
    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
  });

  test.each(['admin', 'staff'] as const)('rejects %s with 403', async (role) => {
    dbMocks.getLineAccountCredentialHealth.mockResolvedValue(health);
    const app = setupApp(role);

    const res = await app.request('/api/line-accounts/acc-1/credential-health');

    expect(res.status).toBe(403);
    expect(dbMocks.getLineAccountCredentialHealth).not.toHaveBeenCalled();
  });
});

describe('GET /api/line-accounts/:id/follower-insight', () => {
  test('returns LINE follower insight without exposing account token', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(fakeAccount);
    lineClientMocks.getFollowersInsight.mockResolvedValue({
      status: 'ready',
      followers: 123,
      targetedReaches: 111,
      blocks: 4,
    });

    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts/acc-1/follower-insight?date=20260616');

    expect(res.status).toBe(200);
    expect(dbMocks.getLineAccountById).toHaveBeenCalledWith(expect.anything(), 'acc-1');
    expect(lineClientMocks.getFollowersInsight).toHaveBeenCalledWith('20260616');
    const body = (await res.json()) as {
      success: boolean;
      data: {
        lineAccountId: string;
        date: string;
        status: string;
        followers: number;
        targetedReaches: number;
        blocks: number;
        channelAccessToken?: string;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      lineAccountId: 'acc-1',
      date: '20260616',
      status: 'ready',
      followers: 123,
      targetedReaches: 111,
      blocks: 4,
    });
    expect(body.data.channelAccessToken).toBeUndefined();
  });

  test('rejects missing insight date', async () => {
    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts/acc-1/follower-insight');

    expect(res.status).toBe(400);
    expect(lineClientMocks.getFollowersInsight).not.toHaveBeenCalled();
  });

  test('assigned staff can fetch another account insight in the same organization', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ ...fakeAccount, id: 'acc-2' });
    dbMocks.getLineAccounts.mockResolvedValue([
      { ...fakeAccount, id: 'acc-1', parent_line_account_id: null },
      { ...fakeAccount, id: 'acc-2', parent_line_account_id: null },
    ]);
    lineClientMocks.getFollowersInsight.mockResolvedValue({
      status: 'ready', followers: 123, targetedReaches: 111, blocks: 4,
    });
    const app = setupApp('staff', makeDbStub(), {
      assignedLineAccountId: 'acc-1', canAccessDescendantAccounts: false,
    });
    const res = await app.request('/api/line-accounts/acc-2/follower-insight?date=20260616');
    expect(res.status).toBe(200);
    expect(lineClientMocks.getFollowersInsight).toHaveBeenCalled();
  });

  test('reports the LINE status number on failure so 401 is not hidden behind 502', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(fakeAccount);
    const lineError = Object.assign(new Error('LINE API error: 401 Unauthorized — {}'), { status: 401 });
    lineClientMocks.getFollowersInsight.mockRejectedValue(lineError);

    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts/acc-1/follower-insight?date=20260616');

    expect(res.status).toBe(502);
    const body = (await res.json()) as { success: boolean; error: string; lineStatus: number | null };
    expect(body.lineStatus).toBe(401);
    // 本文・トークンは外に出さない。
    expect(body.error).toBe('Failed to fetch LINE follower insight');
    expect(JSON.stringify(body)).not.toContain('Unauthorized');
    expect(JSON.stringify(body)).not.toContain(fakeAccount.channel_access_token);
  });

  test('keeps lineStatus null when the failure is not a LINE API response', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(fakeAccount);
    lineClientMocks.getFollowersInsight.mockRejectedValue(new Error('network down'));

    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts/acc-1/follower-insight?date=20260616');

    expect(res.status).toBe(502);
    const body = (await res.json()) as { lineStatus: number | null };
    expect(body.lineStatus).toBeNull();
  });
});

function installAutoConnectFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    if (url.endsWith('/v2/oauth/accessToken')) {
      return Response.json({ access_token: 'issued-token', expires_in: 2_592_000, token_type: 'Bearer' });
    }
    if (url.endsWith('/v2/bot/info')) {
      return Response.json({ displayName: 'LINE公式名', pictureUrl: 'https://example.com/icon.png', basicId: '@line', chatMode: 'bot' });
    }
    if (url.endsWith('/v2/bot/channel/webhook/endpoint') && method === 'PUT') return Response.json({});
    if (url.endsWith('/v2/bot/channel/webhook/endpoint')) {
      return Response.json({ endpoint: 'http://localhost/webhook/123456789', active: true });
    }
    if (url.endsWith('/v2/bot/channel/webhook/test')) return Response.json({ success: true });
    if (url.endsWith('/liff/v1/apps') && method === 'GET') return Response.json({ apps: [] });
    if (url.endsWith('/liff/v1/apps') && method === 'POST') return Response.json({ liffId: '2007123456-auto' });
    if (url.includes('/liff/v1/apps/') && method === 'PUT') return Response.json({});
    return new Response(null, { status: 404 });
  }));
}

const autoConnectBody = {
  channelId: '123456789',
  channelSecret: 'messaging-secret',
  loginChannelId: '2007123456',
  loginChannelSecret: 'login-secret',
};

describe('POST /api/line-accounts/connect', () => {
  test('接続失敗時はDBに行を作らない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    const res = await setupApp('owner').request('/api/line-accounts/connect/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(autoConnectBody),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { steps: Array<{ order: number; state: string }> } };
    expect(body.success).toBe(true);
    expect(body.data.steps[0]).toMatchObject({ order: 1, state: 'failed' });
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
  });

  test.each(['owner', 'admin'] as const)('%s の接続検査の成功時はV8の5行に載る内訳を返す', async (role) => {
    installAutoConnectFetch();
    lineClientMocks.getFollowerIds.mockResolvedValue({ userIds: [] });
    lineClientMocks.getFollowersInsight.mockResolvedValue({ status: 'ready', followers: 1284 });
    const res = await setupApp(role).request('/api/line-accounts/connect/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(autoConnectBody),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      data: {
        steps: Array<{ order: number; state: string }>;
        verification: {
          tokenOk: boolean; loginOk: boolean; sameProvider: boolean;
          webhook: { registeredUrl: string | null; active: boolean | null; testPassed: boolean | null };
          followerTotal: number | null;
        };
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.verification).toMatchObject({
      tokenOk: true,
      loginOk: true,
      sameProvider: true,
      webhook: { registeredUrl: 'http://localhost/webhook/123456789', active: true, testPassed: true },
      followerTotal: 1284,
    });
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
  });

  test('友だち総数が取れなくても検査は通りfollowerTotalはnullになる', async () => {
    installAutoConnectFetch();
    lineClientMocks.getFollowerIds.mockResolvedValue({ userIds: [] });
    lineClientMocks.getFollowersInsight.mockRejectedValue(new Error('LINE API error: 503 Service Unavailable'));
    const res = await setupApp('owner').request('/api/line-accounts/connect/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(autoConnectBody),
    });
    const body = await res.json() as { success: boolean; data: { followerImport: { capability: string }; verification: { followerTotal: number | null } } };
    expect(body.success).toBe(true);
    expect(body.data.verification.followerTotal).toBeNull();
  });

  test.each(['owner', 'admin'] as const)('%s は自分の統括に保存し、認証済みなら友だち取り込みを開始する', async (role) => {
    installAutoConnectFetch();
    let followerSetting: string | null = null;
    dbMocks.getAccountSetting.mockImplementation(async () => followerSetting);
    dbMocks.setAccountSetting.mockImplementation(async (_db, _id, _key, value) => { followerSetting = value; });
    dbMocks.createLineAccount.mockResolvedValue({
      ...fakeAccount,
      id: 'created-account',
      name: 'LINE公式名',
      channel_access_token: 'issued-token',
      login_channel_id: '2007123456',
      login_channel_secret: 'login-secret',
      liff_id: '2007123456-auto',
      revision: 1,
    });
    dbMocks.updateLineAccountFields.mockResolvedValue(fakeAccount);
    lineClientMocks.getFollowerIds.mockResolvedValue({ userIds: [] });

    const res = await setupApp(role, makeDbStub(), { tenantId: 'tenant-current' }).request('/api/line-accounts/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...autoConnectBody, tenantId: 'forged-tenant' }),
    });
    expect(res.status).toBe(201);
    expect(dbMocks.createLineAccount).toHaveBeenCalledOnce();
    expect(styleMocks.initializeAccountStyle).toHaveBeenCalledWith(expect.anything(),'created-account',expect.anything(),expect.anything(),undefined,{bucket:undefined,publicBaseUrl:undefined,reportError:expect.any(Function)});
    expect(dbMocks.createLineAccount.mock.calls[0][1]).toMatchObject({
      tenantId: 'tenant-current',
      name: 'LINE公式名',
      channelAccessToken: 'issued-token',
      loginChannelId: '2007123456',
      liffId: '2007123456-auto',
      timezone: 'Asia/Tokyo',
      lineDisplayName: 'LINE公式名',
      linePictureUrl: 'https://example.com/icon.png',
      lineBasicId: '@line',
      lineProfileSyncedAt: '2026-08-10T12:00:00.000+09:00',
    });
    expect(dbMocks.saveLineAccountConnectionChecks.mock.calls[0][1].checks)
      .toContainEqual(expect.objectContaining({ kind: 'webhook_endpoint', webhookActive: true }));
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      success: true,
      data: {
        id: 'created-account',
        displayName: 'LINE公式名',
        followerImport: { capability: 'available', phase: 'importing_ids' },
      },
    });
    expect(JSON.stringify(body)).not.toContain('messaging-secret');
    expect(JSON.stringify(body)).not.toContain('login-secret');
  });

  test('保存後に認証判定できなければ作成行を巻き戻す', async () => {
    installAutoConnectFetch();
    dbMocks.createLineAccount.mockResolvedValue({
      ...fakeAccount,
      id: 'rollback-account',
      channel_access_token: 'issued-token',
      revision: 1,
    });
    dbMocks.updateLineAccountFields.mockResolvedValue(fakeAccount);
    lineClientMocks.getFollowerIds.mockRejectedValue(new Error('LINE API error: 503 Service Unavailable'));
    const res = await setupApp('owner').request('/api/line-accounts/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(autoConnectBody),
    });
    expect(res.status).toBe(502);
    expect(dbMocks.deleteUncommittedLineAccount).toHaveBeenCalledWith(expect.anything(), 'rollback-account');
  });

  test('同時登録の負け側は重複したLoginチャネルIDを409で案内する', async () => {
    installAutoConnectFetch();
    // 事前検査は通ったがINSERTで一意制約に当たった競争の負け側。
    dbMocks.createLineAccount.mockRejectedValue(
      new Error('UNIQUE constraint failed: line_accounts.login_channel_id'),
    );
    const res = await setupApp('owner').request('/api/line-accounts/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(autoConnectBody),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toMatch(/loginChannelId.*already assigned/);
  });

  test('同時登録の負け側は重複したLIFF IDを409で案内する', async () => {
    installAutoConnectFetch();
    dbMocks.createLineAccount.mockRejectedValue(
      new Error('UNIQUE constraint failed: line_accounts.liff_id'),
    );
    const res = await setupApp('owner').request('/api/line-accounts/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(autoConnectBody),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toMatch(/liffId.*already assigned/);
  });
});

describe('POST /api/line-accounts', () => {
  test.each(['owner', 'admin'] as const)('%s registers credentials in the authenticated tenant only', async (role) => {
    dbMocks.createLineAccount.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009624792',
      login_channel_secret: 'login-secret',
      liff_id: '2009624792-XXXX',
    });

    const app = setupApp(role, makeDbStub(), { tenantId: 'tenant-line-owner' });
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: 'forged-tenant',
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelId: '2009624792',
        loginChannelSecret: 'login-secret',
        liffId: '2009624792-XXXX',
      }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createLineAccount).toHaveBeenCalledTimes(1);
    expect(dbMocks.createLineAccount.mock.calls[0][1]).toMatchObject({
      channelId: '123456789',
      loginChannelId: '2009624792',
      loginChannelSecret: 'login-secret',
      liffId: '2009624792-XXXX',
      tenantId: 'tenant-line-owner',
      lineDisplayName: 'テスト',
      lineProfileSyncedAt: '2026-08-10T12:00:00.000+09:00',
    });

    const body = (await res.json()) as { success: boolean; data: { loginChannelId: string | null; liffId: string | null; loginChannelSecret?: string | null; loginChannelSecretConfigured: boolean } };
    expect(body.success).toBe(true);
    expect(body.data.loginChannelId).toBe('2009624792');
    expect(body.data.liffId).toBe('2009624792-XXXX');
    // 保存した資格情報をブラウザへ返さないことを確かめる。
    expect(body.data.loginChannelSecret).toBeUndefined();
    expect(body.data.loginChannelSecretConfigured).toBe(true);
  });

  test('タイムゾーン・国地域・役割メモ・親アカウントを登録する', async () => {
    dbMocks.getLineAccounts.mockResolvedValue([
      { ...fakeAccount, id: 'parent', tenant_id: 'tenant-line-owner', parent_line_account_id: null },
    ]);
    dbMocks.createLineAccount.mockImplementation(async (_db, input) => ({
      ...fakeAccount,
      id: 'created',
      channel_id: input.channelId,
      name: input.name,
      login_channel_id: input.loginChannelId,
      login_channel_secret: input.loginChannelSecret,
      liff_id: input.liffId,
      timezone: input.timezone,
      country: input.country,
      role: input.role,
      parent_line_account_id: input.parentLineAccountId,
      tenant_id: input.tenantId,
    }));

    const res = await setupApp('owner', makeDbStub(), { tenantId: 'tenant-line-owner' }).request(
      '/api/line-accounts',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId: '123456789',
          name: ' ベトナム店舗 ',
          channelAccessToken: 'token',
          channelSecret: 'secret',
          loginChannelId: '2009624792',
          loginChannelSecret: 'login-secret',
          liffId: '2009624792-XXXX',
          timezone: 'Asia/Ho_Chi_Minh',
          country: 'VN',
          role: '現地運用チーム',
          parentLineAccountId: 'parent',
        }),
      },
    );

    expect(res.status).toBe(201);
    expect(dbMocks.createLineAccount.mock.calls[0][1]).toMatchObject({
      name: 'ベトナム店舗',
      timezone: 'Asia/Ho_Chi_Minh',
      country: 'VN',
      role: '現地運用チーム',
      parentLineAccountId: 'parent',
    });
    await expect(res.json()).resolves.toMatchObject({
      data: { timezone: 'Asia/Ho_Chi_Minh', revision: 1, parentLineAccountId: 'parent' },
    });
  });

  test.each(['owner', 'admin'] as const)('%s にも担当範囲外の親アカウントは存在を明かさず404にする', async (role) => {
    dbMocks.getLineAccounts.mockResolvedValue([{ ...fakeAccount, id: 'visible' }]);
    const res = await setupApp(role).request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelId: '2009624792',
        loginChannelSecret: 'login-secret',
        liffId: '2009624792-XXXX',
        parentLineAccountId: 'outside',
      }),
    });

    expect(res.status).toBe(404);
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
  });

  test('staffはアカウントを登録できない', async () => {
    const res = await setupApp('staff').request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
      }),
    });

    expect(res.status).toBe(403);
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
  });

  test('LINE LoginとLIFFがない場合は登録しない', async () => {
    dbMocks.createLineAccount.mockResolvedValue(fakeAccount);

    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
      }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
  });

  test('LIFF IDが空なら登録しない', async () => {
    dbMocks.createLineAccount.mockResolvedValue(fakeAccount);

    // 空白・空文字の正規化だけを試すため、ログイン ID と秘密値は両方そろえる。LIFF ID は独立に扱う。
    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelId: '  2009624792  ',
        loginChannelSecret: '  login-secret  ',
        liffId: '   ',
      }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
  });

  test('Messaging API接続確認が失敗した場合は登録しない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'invalid-token',
        channelSecret: 'secret',
        loginChannelId: '2009624792',
        loginChannelSecret: 'login-secret',
        liffId: '2009624792-XXXX',
      }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
  });
});

describe('POST /api/line-accounts/:id/connection-checks', () => {
  const requestCheck = (app: ReturnType<typeof setupApp>, expectedRevision = 1, key = 'account-check-0001') =>
    app.request('/api/line-accounts/acc-1/connection-checks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        'X-Correlation-ID': 'correlation-1',
      },
      body: JSON.stringify({ expectedRevision }),
    });

  test.each([
    ['matched', { endpoint: 'http://localhost/webhook', active: true }, 200],
    ['mismatched', { endpoint: 'https://old.example.com/webhook', active: true }, 200],
    ['unconfigured', { endpoint: '', active: false }, 200],
    ['unknown', null, 503],
  ] as const)('Webhookの %s 状態を実値から保存する', async (expected, endpoint, endpointStatus) => {
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009624792',
      login_channel_secret: 'login-secret',
      liff_id: '2009624792-XXXX',
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v2/bot/info')) return Response.json({ displayName: 'テスト' });
      if (url.endsWith('/v2/bot/channel/webhook/endpoint')) {
        return endpoint ? Response.json(endpoint) : new Response(null, { status: endpointStatus });
      }
      if (url.endsWith('/v2/bot/channel/webhook/test')) return Response.json({ success: true });
      return new Response(null, { status: 404 });
    }));

    const res = await requestCheck(setupApp('owner'));
    expect(res.status).toBe(200);
    const saved = dbMocks.saveLineAccountConnectionChecks.mock.calls[0][1];
    expect(saved).toMatchObject({
      lineAccountId: 'acc-1',
      expectedRevision: 1,
      checkedBy: 'test-staff',
      correlationId: 'correlation-1',
      idempotencyKey: 'account-check-0001',
    });
    expect(saved.checks.find((check: { kind: string }) => check.kind === 'webhook_endpoint')).toMatchObject({
      result: expected,
      registeredUrl: endpoint?.endpoint || null,
    });
    expect(dbMocks.updateLineAccountFields).toHaveBeenCalledWith(expect.anything(), 'acc-1', {
      lineDisplayName: 'テスト',
      linePictureUrl: null,
      lineBasicId: null,
      lineProfileSyncedAt: '2026-08-10T12:00:00.000+09:00',
    });
    await expect(res.json()).resolves.toMatchObject({
      data: {
        accountId: 'acc-1',
        revision: 2,
        expectedUrls: {
          webhook: 'http://localhost/webhook/123456789',
          callback: 'http://localhost/auth/callback',
          liffEndpoint: 'http://localhost?liffId=2009624792-XXXX',
        },
      },
    });
  });

  test.each([
    ['https://stg.example.test/webhook', 'matched'],
    ['https://alias.example.test/webhook', 'matched'],
    ['https://alias.example.test/webhook/', 'matched'],
    ['https://prod.example.test/webhook', 'mismatched'],
  ] as const)('この Worker の別の入口（%s）に登録された Webhook は %s と判定する', async (registered, expected) => {
    dbMocks.getLineAccountById.mockResolvedValue(fakeAccount);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v2/bot/info')) return Response.json({ displayName: 'テスト' });
      if (url.endsWith('/v2/bot/channel/webhook/endpoint')) return Response.json({ endpoint: registered, active: true });
      if (url.endsWith('/v2/bot/channel/webhook/test')) return Response.json({ success: true });
      return new Response(null, { status: 404 });
    }));
    const app = new Hono<TestEnv>();
    app.use('*', async (c, next) => {
      c.set('staff', { id: 'test-staff', name: 'Test', role: 'owner', readOnly: false });
      c.env = {
        DB: makeDbStub(),
        WORKER_PUBLIC_URL: 'https://stg.example.test',
        WORKER_URL: 'https://stg.example.test',
        WORKER_ALIAS_URLS: 'https://alias.example.test/, not-a-url',
      } as unknown as TestEnv['Bindings'];
      await next();
    });
    app.route('/', lineAccounts);

    const res = await requestCheck(app);
    expect(res.status).toBe(200);
    const webhook = dbMocks.saveLineAccountConnectionChecks.mock.calls[0][1].checks
      .find((check: { kind: string }) => check.kind === 'webhook_endpoint');
    expect(webhook).toMatchObject({
      result: expected,
      expectedUrl: 'https://stg.example.test/webhook/123456789',
      registeredUrl: registered,
    });
  });

  test('統括画面の管理者も接続情報を更新できる', async () => {
    const res = await requestCheck(setupApp('admin'));

    expect(res.status).toBe(200);
    expect(dbMocks.saveLineAccountConnectionChecks).toHaveBeenCalledOnce();
  });

  test('LIFF実値を取得できない場合はnullとunknownを保存する', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009624792',
      login_channel_secret: 'login-secret',
      liff_id: '2009624792-XXXX',
    });
    const res = await requestCheck(setupApp('owner'));

    expect(res.status).toBe(200);
    const liff = dbMocks.saveLineAccountConnectionChecks.mock.calls[0][1].checks
      .find((check: { kind: string }) => check.kind === 'liff_config');
    expect(liff).toMatchObject({ result: 'unknown', registeredUrl: null });
  });

  test('古い版はLINEへ問い合わせず409にする', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({ ...fakeAccount, revision: 3 });
    const res = await requestCheck(setupApp('owner'), 2);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'REVISION_CONFLICT', currentRevision: 3 });
    expect(fetch).not.toHaveBeenCalled();
    expect(dbMocks.saveLineAccountConnectionChecks).not.toHaveBeenCalled();
  });

  test('同じ冪等キーは保存済み結果を返し、再問い合わせしない', async () => {
    dbMocks.getLineAccountConnectionChecksByIdempotencyKey.mockResolvedValue([{
      id: 'check-1',
      line_account_id: 'acc-1',
      check_kind: 'webhook_endpoint',
      result: 'matched',
      expected_url: 'http://localhost/webhook',
      registered_url: 'http://localhost/webhook',
      webhook_active: 1,
      http_status: 200,
      checked_by: 'test-staff',
      checked_at: '2026-09-07T08:00:00.000+09:00',
      correlation_id: 'old-correlation',
      idempotency_key: 'account-check-0001',
      account_revision: 2,
    }]);
    const res = await requestCheck(setupApp('owner'), 1);

    expect(res.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(dbMocks.saveLineAccountConnectionChecks).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      data: { revision: 2, correlationId: 'old-correlation' },
    });
  });

  test('staffは403、担当範囲外は404、入力不備は422', async () => {
    expect((await requestCheck(setupApp('staff'))).status).toBe(403);

    dbMocks.getLineAccounts.mockResolvedValue([]);
    expect((await requestCheck(setupApp('owner'))).status).toBe(404);

    dbMocks.getLineAccounts.mockResolvedValue([{ ...fakeAccount, parent_line_account_id: null }]);
    expect((await requestCheck(setupApp('owner'), 0)).status).toBe(422);
    expect((await requestCheck(setupApp('owner'), 1, 'short')).status).toBe(422);
  });
});

describe('PATCH /api/line-accounts/hierarchy', () => {
  test('親子関係を検証して一括保存する', async () => {
    dbMocks.getLineAccounts.mockResolvedValue([
      { ...fakeAccount, id: 'parent', parent_line_account_id: null },
      { ...fakeAccount, id: 'child', parent_line_account_id: null },
    ]);
    const batch = vi.fn().mockResolvedValue([]);
    const db = Object.assign(makeDbStub(), { batch });
    const app = setupApp('owner', db);

    const res = await app.request('/api/line-accounts/hierarchy', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relationships: [{ id: 'child', parentLineAccountId: 'parent' }] }),
    });

    expect(res.status).toBe(200);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toHaveLength(1);
  });

  test('店舗の管理者による統括の親子構成変更を拒否する', async () => {
    dbMocks.getLineAccounts.mockResolvedValue([
      { ...fakeAccount, id: 'account-a', parent_line_account_id: 'unassigned' },
      { ...fakeAccount, id: 'unassigned', parent_line_account_id: 'account-b' },
      { ...fakeAccount, id: 'account-b', parent_line_account_id: null },
    ]);
    dbMocks.getStaffById.mockResolvedValue({ account_scope: 'accounts' });
    dbMocks.getStaffAccountScopeIds.mockResolvedValue(['account-a', 'account-b']);
    const batch = vi.fn().mockResolvedValue([]);
    const app = setupApp('admin', Object.assign(makeDbStub(), { batch }));

    const res = await app.request('/api/line-accounts/hierarchy', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relationships: [{ id: 'account-b', parentLineAccountId: 'account-a' }],
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: '統括の権限が必要です' });
    expect(batch).not.toHaveBeenCalled();
  });
});

describe('GET /api/line-accounts', () => {
  test('フォルダの色と1所属を返し、フォルダと未分類で一覧を絞る',async()=>{
    dbMocks.getLineAccounts.mockResolvedValue([{...fakeAccount,folder_id:'folder-1'},{...fakeAccount,id:'acc-2',channel_id:'2',folder_id:null}]);
    const f={id:'folder-1',name:'渋谷',color:'#2f6fde',kind:'line_account',parentId:null};
    dbMocks.getLineAccountFoldersByAccountIds.mockResolvedValue({'acc-1':f});
    const app=setupApp();
    const list=await app.request('/api/line-accounts?folderId=folder-1',{}, {DB:makeDbStub()} as any);
    expect(list.status).toBe(200);const result=await list.json() as any;
    expect(result.data).toHaveLength(1);expect(result.data[0]).toMatchObject({folderId:'folder-1',folder:f});
    const unclassified=await app.request('/api/line-accounts?folderId=__none__',{}, {DB:makeDbStub()} as any);
    expect((await unclassified.json() as any).data.map((a:any)=>a.id)).toEqual(['acc-2']);
  });
  test('資格情報は末尾4文字と更新日だけを返す' , async () => {
    dbMocks.getLineAccounts.mockResolvedValue([{
      ...fakeAccount,
      channel_access_token: 'full-access-token',
      channel_secret: 'full-channel-secret',
      login_channel_secret: 'full-login-secret',
      channel_access_token_last4: 'oken',
      channel_secret_last4: 'cret',
      login_channel_secret_last4: 'cret',
      channel_access_token_updated_at: '2026-09-01T10:00:00.000+09:00',
      channel_secret_updated_at: '2026-09-02T10:00:00.000+09:00',
      login_channel_secret_updated_at: '2026-09-03T10:00:00.000+09:00',
    }]);

    const res = await setupApp('owner').request('/api/line-accounts');

    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toMatchObject({
      channelAccessTokenLast4: 'oken',
      channelAccessTokenUpdatedAt: '2026-09-01T10:00:00.000+09:00',
      channelSecretLast4: 'cret',
      channelSecretUpdatedAt: '2026-09-02T10:00:00.000+09:00',
      loginChannelSecretLast4: 'cret',
      loginChannelSecretUpdatedAt: '2026-09-03T10:00:00.000+09:00',
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('full-access-token');
    expect(serialized).not.toContain('full-channel-secret');
    expect(serialized).not.toContain('full-login-secret');
  });

  test.each(['staff', 'admin'] as const)('%s は担当店舗だけを返し、担当外店舗を一覧から除外する', async (role) => {
    dbMocks.getLineAccounts.mockResolvedValue([
      fakeAccount,
      { ...fakeAccount, id: 'acc-2', channel_id: '987654321', name: '担当外' },
    ]);
    dbMocks.getStaffById.mockResolvedValue({ account_scope: 'accounts' });
    dbMocks.getStaffAccountScopeIds.mockResolvedValue(['acc-1']);

    const res = await setupApp(role).request('/api/line-accounts');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: [{ id: 'acc-1' }],
    });
  });

  test('通常一覧は集計を一括取得し、LINE APIを待たない', async () => {
    const accounts = Array.from({ length: 40 }, (_, index) => ({
      ...fakeAccount,
      id: `acc-${index + 1}`,
      channel_id: String(index + 1),
    }));
    dbMocks.getLineAccounts.mockResolvedValue(accounts);
    dbMocks.getLineAccountListStats.mockResolvedValue({
      'acc-1': {
        friendCount: 12,
        activeScenarios: 3,
        messagesThisMonth: 8,
        staffCount: 2,
        connection: { status: 'ok', checkedAt: '2026-09-15T10:00:00.000Z' },
      },
      'acc-2': {friendCount:0,activeScenarios:0,messagesThisMonth:0,staffCount:0,connection:{status:'unknown',checkedAt:null}},
      'acc-4': {friendCount:12,activeScenarios:0,messagesThisMonth:undefined,staffCount:0,connection:{status:'unknown',checkedAt:null}},
    });

    const res = await setupApp('owner').request('/api/line-accounts');

    expect(res.status).toBe(200);
    expect(dbMocks.getLineAccountListStats).toHaveBeenCalledTimes(1);
    expect(dbMocks.getLineAccountListStats).toHaveBeenCalledWith(expect.anything(), accounts.map((item) => item.id));
    expect(fetch).not.toHaveBeenCalled();
    const body = (await res.json()) as { data: Array<{ stats?: { friendCount: number; staffCount: number }; connection: { status: string } }> };
    expect(body.data).toHaveLength(40);
    expect(body.data[0].stats).toMatchObject({friendCount:12,staffCount:2});
    expect(body.data[0].connection.status).toBe('ok');
    expect(body.data[1]).toMatchObject({stats:{friendCount:0},connection:{status:'unknown'}});
    expect(body.data.slice(2,4).map(account=>account.stats)).toEqual([undefined,undefined]);
  });

  test('通常一覧はDBのLINE公式プロフィールと接続状態3分岐を返す', async () => {
    const accounts = [
      {
        ...fakeAccount,
        id: 'acc-1',
        line_display_name: 'LINE公式名',
        line_picture_url: 'https://example.com/line.png',
        line_basic_id: '@line',
      },
      { ...fakeAccount, id: 'acc-2', channel_id: '2', name: '要確認' },
      { ...fakeAccount, id: 'acc-3', channel_id: '3', name: '未確認' },
    ];
    dbMocks.getLineAccounts.mockResolvedValue(accounts);
    dbMocks.getLineAccountListStats.mockResolvedValue({
      'acc-1': { friendCount: 1, activeScenarios: 0, messagesThisMonth: 2, staffCount: 3, connection: { status: 'ok', checkedAt: '2026-09-15T10:00:00.000Z' } },
      'acc-2': { friendCount: 0, activeScenarios: 0, messagesThisMonth: 0, staffCount: 0, connection: { status: 'warn', checkedAt: '2026-09-15T10:01:00.000Z' } },
      'acc-3': { friendCount: 0, activeScenarios: 0, messagesThisMonth: 0, staffCount: 0, connection: { status: 'unknown', checkedAt: null } },
    });

    const res = await setupApp('owner').request('/api/line-accounts');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toMatchObject({
      displayName: 'LINE公式名', pictureUrl: 'https://example.com/line.png', basicId: '@line',
      stats: { staffCount: 3 }, connection: { status: 'ok' },
    });
    expect(body.data[1]).toMatchObject({ displayName: '要確認', pictureUrl: null, basicId: null, connection: { status: 'warn' } });
    expect(body.data[2]).toMatchObject({ connection: { status: 'unknown', checkedAt: null } });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('一括集計に失敗したときは全件0と偽らず500を返す', async () => {
    dbMocks.getLineAccountListStats.mockRejectedValueOnce(new Error('D1 unavailable'));

    const res = await setupApp('owner').request('/api/line-accounts');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'Internal Server Error', incidentId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('live=1のときだけWebhook URLとプランを秘密情報なしで返す', async () => {
    dbMocks.getLineAccounts.mockResolvedValue([fakeAccount]);
    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts?live=1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ webhook: { status: string; expectedUrl: string }; plan: { key: string; label: string; monthlyMessageLimit: number }; channelAccessToken?: string }>;
    };
    expect(body.data[0].webhook).toMatchObject({
      status: 'matched',
      expectedUrl: 'http://localhost/webhook/123456789',
    });
    expect(body.data[0].channelAccessToken).toBeUndefined();
    expect(body.data[0].plan).toMatchObject({
      key: 'communication',
      label: 'コミュニケーション',
      monthlyMessageLimit: 200,
    });
  });

  test('live=1でもLINEへの同時接続を6本以内に抑える', async () => {
    const accounts = Array.from({ length: 8 }, (_, index) => ({
      ...fakeAccount,
      id: `acc-${index + 1}`,
      channel_id: String(index + 1),
      channel_access_token: `token-${index + 1}`,
    }));
    dbMocks.getLineAccounts.mockResolvedValue(accounts);
    let active = 0;
    let maximum = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      const url = String(input);
      if (url.endsWith('/v2/bot/info')) return Response.json({ displayName: 'テスト' });
      if (url.endsWith('/v2/bot/channel/webhook/endpoint')) {
        return Response.json({ endpoint: 'http://localhost/webhook', active: true });
      }
      if (url.endsWith('/v2/bot/channel/webhook/test')) return Response.json({ success: true });
      if (url.endsWith('/v2/bot/message/quota')) {
        return Response.json({ type: 'limited', value: 200 });
      }
      return new Response(null, { status: 404 });
    }));

    const res = await setupApp('owner').request('/api/line-accounts?live=1');

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(8);
    expect(maximum).toBeLessThanOrEqual(6);
  });
});

test.each([
  ['PUT', '/api/line-accounts/default', { accountId: 'acc-1' }],
  ['PATCH', '/api/line-accounts/order', { ordered: [{ id: 'acc-1', displayOrder: 1 }] }],
  ['PATCH', '/api/line-accounts/hierarchy', { relationships: [{ id: 'acc-1', parentLineAccountId: null }] }],
  ['POST', '/api/line-accounts/acc-1/archive', { reason: 'test' }],
  ['POST', '/api/line-accounts/acc-1/restore', {}],
] as const)('店舗の管理者は統括の構成変更 %s %s を実行できない', async (method, path, body) => {
  dbMocks.getStaffById.mockResolvedValue({ is_active: 1, account_scope: 'accounts' });
  dbMocks.getStaffAccountScopeIds.mockResolvedValue(['acc-1']);
  const response = await setupApp('owner').request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(403);
});

describe('GET /api/line-accounts/profile-pictures', () => {
  test('閲覧可能で稼働中の公式アカウント画像だけを最新取得する', async () => {
    dbMocks.getLineAccounts.mockResolvedValue([
      { ...fakeAccount, id: 'acc-1', tenant_id: 'tenant-a' },
      { ...fakeAccount, id: 'acc-2', tenant_id: 'tenant-a', is_active: 0 },
      { ...fakeAccount, id: 'acc-3', tenant_id: 'tenant-b' },
    ]);
    const external = vi.fn(async () => Response.json({ displayName: 'THE SHED', pictureUrl: 'https://line.example/shed.png' }));
    vi.stubGlobal('fetch', external);

    const response = await setupApp('owner', makeDbStub(), { tenantId: 'tenant-a' })
      .request('/api/line-accounts/profile-pictures');

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [{ id: 'acc-1', pictureUrl: 'https://line.example/shed.png' }],
    });
    expect(external).toHaveBeenCalledTimes(1);
  });

  test('LINEへの画像照会失敗時は保存済みの画像を消す応答を返さない', async () => {
    const external = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', external);
    const response = await setupApp().request('/api/line-accounts/profile-pictures');
    await expect(response.json()).resolves.toEqual({ success: true, data: [] });
  });
});

describe('GET /api/line-accounts/summary', () => {
  test('閲覧できる稼働中アカウントの友だちを重複除外して集計する', async () => {
    dbMocks.getLineAccounts.mockResolvedValue([fakeAccount]);
    const first = vi.fn().mockResolvedValue({ count: 37 });
    const bind = vi.fn(() => ({ first }));
    const db = { prepare: vi.fn(() => ({ bind })) } as unknown as D1Database;
    const app = setupApp('owner', db);
    const res = await app.request('/api/line-accounts/summary');

    expect(res.status).toBe(200);
    expect(bind).toHaveBeenCalledWith(JSON.stringify(['acc-1']));
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: { uniqueFriendCount: 37 },
    });
  });
});

describe('PATCH /api/line-accounts/:id', () => {
  test.each([
    'https://lin.ee/nen-official',
    'https://line.me/R/ti/p/@nen-official',
  ])('stores the official profile URL %s and returns it', async (officialProfileUrl) => {
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      official_profile_url: officialProfileUrl,
    });

    const res = await setupApp('admin').request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ officialProfileUrl }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateLineAccountFields.mock.calls[0][2]).toMatchObject({
      officialProfileUrl,
    });
    await expect(res.json()).resolves.toMatchObject({
      data: { officialProfileUrl },
    });
  });

  test.each([
    'https://example.com/not-line',
    'https://line.me/other-path',
    'https://line.me/R/ti/p/nen-official',
  ])('rejects the invalid profile URL %s without updating data', async (officialProfileUrl) => {
    const res = await setupApp('admin').request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ officialProfileUrl }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.updateLineAccountFields).not.toHaveBeenCalled();
    expect(dbMocks.updateLineAccount).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('https://lin.ee/ or https://line.me/R/ti/p/@'),
    });
  });

  test('updates loginChannelId / loginChannelSecret / liffId via metadata path', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(fakeAccount);
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009999999',
      liff_id: '2009999999-YYYY',
    });

    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loginChannelId: '2009999999',
        loginChannelSecret: 'rotated',
        liffId: '2009999999-YYYY',
      }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateLineAccountFields).toHaveBeenCalledTimes(1);
    expect(dbMocks.updateLineAccountFields.mock.calls[0][2]).toMatchObject({
      loginChannelId: '2009999999',
      loginChannelSecret: 'rotated',
      liffId: '2009999999-YYYY',
    });
  });

  test('clears LIFF when explicitly set to empty string', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(fakeAccount);
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      liff_id: null,
    });

    const app = setupApp('admin');
    await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liffId: '' }),
    });

    expect(dbMocks.updateLineAccountFields.mock.calls[0][2]).toMatchObject({
      liffId: null,
    });
  });

  test('does not touch login/liff fields when not provided', async () => {
    dbMocks.updateLineAccountFields.mockResolvedValue(fakeAccount);
    dbMocks.getLineAccountById.mockResolvedValue(fakeAccount);

    const app = setupApp('admin');
    await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country: '日本' }),
    });

    const arg = dbMocks.updateLineAccountFields.mock.calls[0][2];
    expect(arg.country).toBe('日本');
    expect(arg.loginChannelId).toBeUndefined();
    expect(arg.loginChannelSecret).toBeUndefined();
    expect(arg.liffId).toBeUndefined();
  });
});

describe('Login pair / uniqueness validation', () => {
  test('POST: rejects loginChannelId without secret', async () => {
    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelId: '2009624792',
        // loginChannelSecret missing
      }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toMatch(/loginChannelSecret/);
  });

  test('POST: rejects loginChannelSecret without ID', async () => {
    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelSecret: 'orphan',
      }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
  });

  test('POST: rejects duplicate liffId', async () => {
    // 同じ liff_id を持つ別の行を返し、重複を検証する。
    const app = setupApp('owner', makeDbStub({ id: 'other-acc' }));

    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelId: '2009624792',
        loginChannelSecret: 'login-secret',
        liffId: '2009624792-DUPLICATE',
      }),
    });

    expect(res.status).toBe(409);
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toMatch(/already assigned/);
  });

  test('POST: 同時登録の負け側は重複したLoginチャネルIDを409で案内する', async () => {
    dbMocks.createLineAccount.mockRejectedValue(
      new Error('UNIQUE constraint failed: line_accounts.login_channel_id'),
    );
    const res = await setupApp('owner', makeDbStub(), { tenantId: 'tenant-line-owner' }).request(
      '/api/line-accounts',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId: '123456789',
          name: 'メイン',
          channelAccessToken: 'token',
          channelSecret: 'secret',
          loginChannelId: '2009624792',
          loginChannelSecret: 'login-secret',
          liffId: '2009624792-XXXX',
        }),
      },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toMatch(/loginChannelId.*already assigned/);
  });

  test('PATCH: LIFF-only edit succeeds against half-configured Login (id-only) account', async () => {
    // CLI が ID だけを保存した既存アカウントでも、ログイン項目に触れない LIFF 更新まで組合せ検査で拒まない。
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'setup-cli-id',
      login_channel_secret: null,
    });
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'setup-cli-id',
      login_channel_secret: null,
      liff_id: '2009624792-NEW',
    });

    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liffId: '2009624792-NEW' }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateLineAccountFields.mock.calls[0][2]).toMatchObject({
      liffId: '2009624792-NEW',
    });
  });

  test('PATCH: clearing both Login fields together succeeds', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'old-id',
      login_channel_secret: 'old-secret',
    });
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: null,
      login_channel_secret: null,
    });

    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginChannelId: null, loginChannelSecret: null }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateLineAccountFields.mock.calls[0][2]).toMatchObject({
      loginChannelId: null,
      loginChannelSecret: null,
    });
  });

  test('PATCH: clearing only loginChannelId is rejected (would orphan the secret)', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'old-id',
      login_channel_secret: 'old-secret',
    });

    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginChannelId: null }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.updateLineAccountFields).not.toHaveBeenCalled();
  });

  test('PATCH: keeps existing secret when only changing the loginChannelId', async () => {
    // ID だけの変更でも、保存済みの秘密値と組になれば許可する。
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'old-id',
      login_channel_secret: 'kept-secret',
    });
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'new-id',
      login_channel_secret: 'kept-secret',
    });

    const app = setupApp('admin');

    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginChannelId: 'new-id' }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateLineAccountFields).toHaveBeenCalled();
  });
});

describe('PUT /api/line-accounts/:id', () => {
  test('owner can update Login/LIFF + country/role in one request', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      login_channel_secret: 'existing-secret',
    });
    dbMocks.updateLineAccount.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009624792',
      login_channel_secret: 'existing-secret',
      liff_id: '2009624792-XXXX',
    });
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009624792',
      login_channel_secret: 'existing-secret',
      liff_id: '2009624792-XXXX',
      country: '日本',
      role: '本店',
    });

    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loginChannelId: '2009624792',
        liffId: '2009624792-XXXX',
        country: '日本',
        role: '本店',
      }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateLineAccount.mock.calls[0][2]).toMatchObject({
      login_channel_id: '2009624792',
      liff_id: '2009624792-XXXX',
    });
    // country/role は専用の項目更新関数へ渡る。
    expect(dbMocks.updateLineAccountFields.mock.calls[0][2]).toMatchObject({
      country: '日本',
      role: '本店',
    });
  });
});

test('登録前のタグをLINE通信前に検査する', async () => {
 const remote=vi.fn(); vi.stubGlobal('fetch',remote);
 for(const tagIds of [['not-own'],['tag-own','tag-own']]) {
  const response=await setupApp('owner').request('/api/line-accounts/connect/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...autoConnectBody,tagIds})});
  expect(response.status).toBe(tagIds[0] === 'not-own' ? 403 : 422);
 }
 expect(remote).not.toHaveBeenCalled();
});
test('登録に選んだタグを保存し、秘密と分けてLINE取得項目を返す', async () => {
 installAutoConnectFetch();
 let followerSetting: string | null = null;
 dbMocks.getAccountSetting.mockImplementation(async () => followerSetting);
 dbMocks.setAccountSetting.mockImplementation(async (_db,_id,_key,value) => {followerSetting=value;});
 dbMocks.createLineAccount.mockResolvedValue({...fakeAccount,id:'created-account',channel_access_token:'issued-token',revision:1});
 dbMocks.updateLineAccountFields.mockResolvedValue(fakeAccount);
 lineClientMocks.getFollowerIds.mockResolvedValue({userIds:[]});
 const insertTags = vi.fn();
 const db = { prepare: vi.fn((sql: string) => ({ bind: (...args: unknown[]) => {
  if (sql.startsWith('INSERT INTO line_account_tag_links')) insertTags(...args);
  return { first: async () => sql.startsWith('SELECT id FROM staff_members') || sql.startsWith('SELECT id FROM line_account_tags') ? {id:'valid'} : null };
 } })), batch: vi.fn(async () => []) } as unknown as D1Database;
 const response=await setupApp('owner', db).request('/api/line-accounts/connect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...autoConnectBody,tagIds:['tag-own']})});
 expect(response.status).toBe(201);
 expect(insertTags).toHaveBeenCalledExactlyOnceWith('created-account','tag-own', expect.any(String));
 expect(db.batch).toHaveBeenCalledOnce();
 expect(await response.json()).toMatchObject({data:{basicId:'@line',pictureUrl:'https://example.com/icon.png'}});
});


describe('selected registration style', () => {
  test.each(['standard','ec','restaurant','salon','consult','lesson'])('%s reaches the same account initializer',async style=>{
    installAutoConnectFetch();
    let followerSetting:string|null=null;
    dbMocks.getAccountSetting.mockImplementation(async()=>followerSetting);
    dbMocks.setAccountSetting.mockImplementation(async(_db,_id,_key,value)=>{followerSetting=value;});
    dbMocks.createLineAccount.mockResolvedValue({...fakeAccount,id:'created-account',tenant_id:'tenant-1',channel_access_token:'issued-token'});
    dbMocks.updateLineAccountFields.mockResolvedValue(fakeAccount);
    lineClientMocks.getFollowerIds.mockResolvedValue({userIds:[]});
    const res=await setupApp('owner').request('/api/line-accounts/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...autoConnectBody,style})});
    expect(res.status).toBe(201);
    expect(styleMocks.initializeAccountStyle).toHaveBeenCalledWith(expect.anything(),'created-account','tenant-1','test-staff',style,{bucket:undefined,publicBaseUrl:undefined,reportError:expect.any(Function)});
  });
  test.each(['meeting','',null,{},42])('rejects invalid style %j before external calls and creation',async style=>{
    const external=vi.fn();vi.stubGlobal('fetch',external);
    for(const path of ['/api/line-accounts','/api/line-accounts/connect']){
      const res=await setupApp('owner').request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...autoConnectBody,style})});
      expect(res.status).toBeGreaterThanOrEqual(400);expect(res.status).toBeLessThan(500);
    }
    expect(external).not.toHaveBeenCalled();expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
  });
  test.each([
    ['/api/line-accounts/connect',{...autoConnectBody,style:'consult'}],
    ['/api/line-accounts',{channelId:'123456789',name:'メイン',channelAccessToken:'token',channelSecret:'secret',loginChannelId:'2009624792',loginChannelSecret:'login-secret',liffId:'2009624792-XXXX',style:'consult'}],
  ])('returns the created account for style retry without deleting it or creating a second account: %s',async(path,body)=>{
    installAutoConnectFetch();let followerSetting:string|null=null;
    dbMocks.getAccountSetting.mockImplementation(async()=>followerSetting);dbMocks.setAccountSetting.mockImplementation(async(_db,_id,_key,value)=>{followerSetting=value;});
    dbMocks.createLineAccount.mockResolvedValue({...fakeAccount,id:'created-account',channel_access_token:'issued-token',login_channel_id:'2009624792',login_channel_secret:'login-secret',liff_id:'2009624792-XXXX'});
    dbMocks.updateLineAccountFields.mockResolvedValue(fakeAccount);lineClientMocks.getFollowerIds.mockResolvedValue({userIds:[]});styleMocks.initializeAccountStyle.mockRejectedValueOnce(new Error('db failure'));
    const app=new Hono<TestEnv>();app.use('*',apiContractMiddleware);app.route('/',setupApp('owner'));
    const res=await app.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({success:false,error:{code:'style_save_failed',requestId:res.headers.get('X-Request-ID'),fieldErrors:[]},data:{accountId:'created-account',style:'consult',styleSaved:false,retryAt:'/api/dashboard/style?account_id=created-account',starterRetryAt:'/api/dashboard/style/starter-items/ensure?account_id=created-account'}});
    expect(dbMocks.createLineAccount).toHaveBeenCalledOnce();expect(dbMocks.deleteUncommittedLineAccount).not.toHaveBeenCalled();
  });
});

test.each(['/api/line-accounts/connect/check', '/api/line-accounts/connect'])('registered channels are rejected before LINE changes: %s', async (path) => {
  const response = await setupApp('owner', makeDbStub({ id: 'other-customer' })).request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(autoConnectBody),
  });
  expect(response.status).toBe(409);
  expect(fetch).not.toHaveBeenCalled();
  expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
});

test('a mismatched Messaging credential cannot be saved by the owner', async () => {
  const { verifyLineMessagingIdentity } = await import('../services/line-messaging-identity.js');
  vi.mocked(verifyLineMessagingIdentity).mockResolvedValueOnce(false);
  const response = await setupApp('owner').request('/api/line-accounts/acc-1', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelAccessToken: 'other-shop-token' }),
  });
  expect(response.status).toBe(422);
  expect(dbMocks.updateLineAccount).not.toHaveBeenCalled();
});


describe('registration authorization boundaries', () => {
  const endpoints = ['/api/line-accounts/verify-connection', '/api/line-accounts/connect/check', '/api/line-accounts/connect', '/api/line-accounts'];
  test.each(endpoints)('%s rejects staff and read-only managers before LINE or DB side effects', async (path) => {
    for (const actor of [{ role: 'staff', readOnly: false }, { role: 'admin', readOnly: true }, { role: 'owner', readOnly: true }] as const) {
      const res = await setupApp(actor.role, makeDbStub(), { readOnly: actor.readOnly }).request(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(autoConnectBody),
      });
      expect(res.status).toBe(403);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
  });

  test.each(['/api/line-accounts/connect', '/api/line-accounts'])('%s still requires admin step-up verification', async (path) => {
    dbMocks.consumeStepUpGrant.mockResolvedValueOnce(false);
    const res = await setupApp('admin').request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(autoConnectBody),
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(fetch).not.toHaveBeenCalled();
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
  });

  test.each(['owner', 'admin'] as const)('%s can verify credentials before saving', async (role) => {
    const res = await setupApp(role).request('/api/line-accounts/verify-connection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelAccessToken: 'token', loginChannelId: '2007123456', loginChannelSecret: 'secret', liffId: '2007123456-test' }),
    });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalled();
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
  });
});


test.each(['/api/line-accounts/connect/check', '/api/line-accounts/connect'])('admin cannot grant staff access through registration: %s', async (path) => {
  const response = await setupApp('admin').request(path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...autoConnectBody, staffIds: ['another-staff'] }),
  });
  expect(response.status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
  expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
});
