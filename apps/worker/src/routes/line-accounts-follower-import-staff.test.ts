vi.mock('../services/line-messaging-identity.js', () => ({ verifyLineMessagingIdentity: vi.fn().mockResolvedValue(true) }));
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono, type ErrorHandler } from 'hono';

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
  Bindings: { DB: D1Database };
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
    c.env = { DB: dbStub };
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

beforeEach(() => {
  styleMocks.initializeAccountStyle.mockClear();
  for (const fn of Object.values(dbMocks)) {
    if ('mockReset' in fn) fn.mockReset();
  }
  lineClientMocks.getFollowersInsight.mockReset();
  lineClientMocks.getFollowerIds.mockReset();
  dbMocks.getAccountSetting.mockResolvedValue(null);
  dbMocks.getLineAccountFoldersByAccountIds.mockResolvedValue({});
  dbMocks.getLineAccountTag.mockResolvedValue({id:'folder-1'});
  dbMocks.listLineAccountTags.mockResolvedValue([{id:'tag-own',tenant_id:'tenant-1'}]);
  dbMocks.getStaffById.mockResolvedValue({ account_scope: 'all' });
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

test('live LINE account list preserves valid checks alongside a legacy channel ID', async () => {
  dbMocks.getLineAccounts.mockResolvedValue([
    fakeAccount,
    { ...fakeAccount, id: 'acc-legacy', channel_id: 'legacy-account', name: '旧形式' },
  ]);
  const app = setupApp();
  const response = await app.request('/api/line-accounts?live=1');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    success: true,
    data: [
      { id: 'acc-1', webhook: { status: 'matched' }, plan: { key: 'communication' } },
      { id: 'acc-legacy', channelId: 'legacy-account', webhook: { status: 'unknown' }, plan: { key: 'unknown' } },
    ],
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});

describe('staff follower-import account scope', () => {
  test('reads a visible store and returns no state for an invisible store', async () => {
    dbMocks.getLineAccounts.mockResolvedValue([fakeAccount, { ...fakeAccount, id: 'acc-other' }]);
    dbMocks.getStaffById.mockResolvedValue({ account_scope: 'accounts' });
    dbMocks.getStaffAccountScopeIds.mockResolvedValue(['acc-1']);
    const app = setupApp('staff', makeDbStub(), {
      assignedLineAccountId: 'acc-1', canAccessDescendantAccounts: false,
    });
    const allowed = await app.request('/api/line-accounts/acc-1/follower-import');
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ success: true, data: { phase: 'not_started' } });
    expect(dbMocks.getAccountSetting).toHaveBeenCalled();
    dbMocks.getAccountSetting.mockClear();
    const denied = await app.request('/api/line-accounts/acc-other/follower-import');
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ success: false, code: 'LINE_ACCOUNT_NOT_FOUND', error: 'LINE公式アカウントが見つかりません。一覧から開き直してください。' });
    expect(dbMocks.getAccountSetting).not.toHaveBeenCalled();
  });
});
