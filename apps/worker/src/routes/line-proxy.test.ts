import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';

const lineClientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
}));

vi.mock('@line-crm/db', async (importOriginal) => ({
  normalizeFriendLineUserId: (await importOriginal<typeof import('@line-crm/db')>()).normalizeFriendLineUserId,
  getLineAccounts: vi.fn(),
  listLineAccountsWithTenantStatus: vi.fn(),
  getLineAccountScopeEntries: vi.fn(),
  getFriendByLineUserIdForAccount: vi.fn(),
  upsertFriend: vi.fn(),
  getChatByFriendId: vi.fn(),
  createChat: vi.fn(),
  updateChat: vi.fn(),
  isOperationCapabilityStopped: vi.fn(async () => false),
  OPERATION_CAPABILITIES: [
    'broadcast_dispatch',
    'scenario_dispatch',
    'reminder_dispatch',
    'automation_actions',
    'auto_reply_dispatch',
    'webhook_outgoing',
    'ad_postback',
  ],
  getStaffById: vi.fn(async () => ({ account_scope: 'all' })),
  getStaffAccountScopeIds: vi.fn(async () => []),
  jstNow: vi.fn(() => '2026-08-02T12:00:00.000'),
}));

vi.mock('../middleware/auth.js', () => ({
  authenticateApiToken: vi.fn(async () => null),
}));

vi.mock('../services/feature-enforcement.js', () => ({
  accountFeatureAvailability: vi.fn(),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    LineClient: vi.fn().mockImplementation(function () { return lineClientMocks; }),
  };
});

// 配信全体の依存を読まずに検証できるよう、messageToLogPayload と同じ入出力だけを保つ。
vi.mock('../services/step-delivery.js', () => ({
  messageToLogPayload: (message: { type: string; text?: string }) =>
    message.type === 'text'
      ? { messageType: 'text', content: message.text }
      : { messageType: message.type, content: JSON.stringify(message) },
}));

import {
  getLineAccounts,
  listLineAccountsWithTenantStatus,
  getLineAccountScopeEntries,
  getFriendByLineUserIdForAccount,
  upsertFriend,
  getChatByFriendId,
  createChat,
  updateChat,
  isOperationCapabilityStopped,
  getStaffById,
  getStaffAccountScopeIds,
} from '@line-crm/db';
import { authenticateApiToken } from '../middleware/auth.js';
import { accountFeatureAvailability } from '../services/feature-enforcement.js';
import { lineProxy } from './line-proxy.js';

type Exec = { sql: string; params: unknown[] };

const U = (n: number) => `U${n.toString(16).padStart(32, '0')}`;

/** multicast の IN 照会は friendsByUserId、全体送信のフォロー状態は broadcastFriendIds で試す。 */
function fakeDb(opts: {
  friendsByUserId?: Record<string, { id: string; line_user_id: string }>;
  broadcastFriendIds?: string[];
  suppressed?: boolean;
} = {}) {
  const executed: Exec[] = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) {
          stmt.params = params;
          return stmt;
        },
        async run() {
          executed.push({ sql, params: stmt.params });
          return {};
        },
        async all() {
          executed.push({ sql, params: stmt.params });
          if (sql.includes('line_platform_user_id IN')) {
            const rows = stmt.params
              .flatMap((p) => {
                const friend = opts.friendsByUserId?.[p as string];
                return friend ? [{ ...friend, line_platform_user_id: friend.line_user_id }] : [];
              });
            return { results: rows };
          }
          return { results: (opts.broadcastFriendIds ?? []).map((id) => ({ id })) };
        },
        async first() {
          if(sql.includes('AS delivery_suppressed')) {
            const friend = await getFriendByLineUserIdForAccount(db as unknown as D1Database, String(stmt.params[2]), String(stmt.params[0]));
            return friend ? {...friend, delivery_suppressed: opts.suppressed ? 1 : 0} : null;
          }
          if(sql.includes('friend_delivery_consents'))return opts.suppressed?{suppressed:1}:null;
          return null;
        },
      };
      return stmt;
    },
    async batch(stmts: Array<{ sql: string; params: unknown[] }>) {
      for (const s of stmts) executed.push({ sql: s.sql, params: s.params });
      return [];
    },
  };
  return { db: db as unknown as D1Database, executed };
}

/** 複数行の送信履歴 INSERT を、1行8引数の論理行へ展開して検証する。 */
function loggedRows(executed: Exec[]) {
  const rows: { friendId: unknown; messageType: unknown; content: unknown; deliveryType: unknown; source: unknown; lineAccountId: unknown }[] = [];
  for (const e of executed) {
    if (!e.sql.includes('INTO messages_log')) continue;
    for (let i = 0; i < e.params.length; i += 8) {
      rows.push({
        friendId: e.params[i + 1],
        messageType: e.params[i + 2],
        content: e.params[i + 3],
        deliveryType: e.params[i + 4],
        source: e.params[i + 5],
        lineAccountId: e.params[i + 6],
      });
    }
  }
  return rows;
}

function setupApp() {
  const app = new Hono();
  app.route('/', lineProxy);
  return app;
}

function env(db: D1Database) {
  return {
    DB: db,
    LINE_CHANNEL_ACCESS_TOKEN: 'env-token',
    API_KEY: 'harness-key',
  } as Record<string, unknown>;
}

const ACCOUNT = {
  id: 'acc-1',
  channel_id: 'ch-1',
  name: 'Main',
  channel_access_token: 'acc-token',
  channel_secret: 'secret',
  is_active: 1,
};

const ACCOUNT_2 = {
  ...ACCOUNT,
  id: 'acc-2',
  channel_id: 'ch-2',
  name: 'Sub',
  channel_access_token: 'acc-token-2',
};

const USER_A = U(0x123);
const FRIEND = { id: 'friend-1', line_user_id: USER_A, line_account_id: 'acc-1' };

let fetchMock: ReturnType<typeof vi.fn>;

function upstreamResponse(status = 200, body = '{}') {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', 'x-line-request-id': 'req-1' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn(async () => upstreamResponse());
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(getLineAccounts).mockResolvedValue([ACCOUNT] as never);
  vi.mocked(listLineAccountsWithTenantStatus).mockImplementation(
    async (db: D1Database) => (await vi.mocked(getLineAccounts)(db)).map((account) => ({
      ...account,
      tenant_status: 'active' as const,
    })) as never,
  );
  vi.mocked(getLineAccountScopeEntries).mockImplementation(
    async (db: D1Database) => vi.mocked(getLineAccounts)(db) as never,
  );
  vi.mocked(getFriendByLineUserIdForAccount).mockResolvedValue(FRIEND as never);
  vi.mocked(getChatByFriendId).mockResolvedValue({ id: 'chat-1', status: 'unread' } as never);
  vi.mocked(updateChat).mockResolvedValue(undefined as never);
  vi.mocked(authenticateApiToken).mockResolvedValue(null as never);
  // clearAllMocks は実装を戻さないので、停止状態は各テストで明示的に立てる。
  vi.mocked(isOperationCapabilityStopped).mockResolvedValue(false as never);
  vi.mocked(accountFeatureAvailability).mockResolvedValue({
    featureId: 'broadcasts', contractAvailable: true, companyEnabled: true,
    dependenciesEnabled: true, effectiveEnabled: true, reason: null,
    message: null, disabledDependencies: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function pushRequest(
  token: string | null,
  body: unknown = { to: USER_A, messages: [{ type: 'text', text: 'hello' }] },
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request('http://worker.test/line-api/v2/bot/message/push', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('account feature availability', () => {
  test.each([
    '/v2/bot/message/broadcast',
    `/v2/bot/user/${USER_A}/richmenu/rm-1`,
  ])('unregistered environment channel cannot update account-scoped feature %s', async path => {
    vi.mocked(getLineAccounts).mockResolvedValue([]);
    const { db, executed } = fakeDb();
    const res = await setupApp().request(`/line-api${path}`, {
      method: 'POST', headers: { Authorization: 'Bearer env-token' },
    }, env(db));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'LINE_ACCOUNT_REQUIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
  });

  test.each([
    ['POST', '/v2/bot/richmenu'],
    ['POST', '/v2/bot/user/all/richmenu/rm-1'],
    ['DELETE', '/v2/bot/user/all/richmenu'],
    ['POST', `/v2/bot/user/${USER_A}/richmenu/rm-1`],
    ['DELETE', `/v2/bot/user/${USER_A}/richmenu`],
  ])('disabled rich menus reject %s %s before upstream communication', async (method, path) => {
    const { db, executed } = fakeDb();
    vi.mocked(accountFeatureAvailability).mockResolvedValue({
      featureId: 'rich_menus', contractAvailable: true, companyEnabled: false,
      dependenciesEnabled: true, effectiveEnabled: false, reason: 'company_disabled',
      message: 'この機能は設定でオフになっています', disabledDependencies: [],
    });
    const res = await setupApp().request(`/line-api${path}`, {
      method, headers: { Authorization: 'Bearer acc-token' },
    }, env(db));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FEATURE_DISABLED', featureId: 'rich_menus' });
    expect(accountFeatureAvailability).toHaveBeenCalledWith(db, 'acc-1', 'rich_menus');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
  });

  test('enabled rich menu assignment forwards the channel request', async () => {
    const { db } = fakeDb();
    const res = await setupApp().request(`/line-api/v2/bot/user/${USER_A}/richmenu/rm-1`, {
      method: 'POST', headers: { Authorization: 'Bearer acc-token' },
    }, env(db));
    expect(res.status).toBe(200);
    expect(accountFeatureAvailability).toHaveBeenCalledWith(db, 'acc-1', 'rich_menus');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each(['broadcast', 'multicast', 'narrowcast'] as const)('disabled %s stops before upstream communication', async endpoint => {
    const { db, executed } = fakeDb();
    vi.mocked(accountFeatureAvailability).mockResolvedValue({
      featureId: 'broadcasts', contractAvailable: true, companyEnabled: false,
      dependenciesEnabled: true, effectiveEnabled: false, reason: 'company_disabled',
      message: 'この機能は設定でオフになっています', disabledDependencies: [],
    });
    const res = await setupApp().request(`/line-api/v2/bot/message/${endpoint}`, {
      method: 'POST', headers: { Authorization: 'Bearer acc-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: [USER_A], messages: [{ type: 'text', text: 'fixture message' }] }),
    }, env(db));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FEATURE_DISABLED', featureId: 'broadcasts' });
    expect(accountFeatureAvailability).toHaveBeenCalledWith(db, 'acc-1', 'broadcasts');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
  });

  test('staff permission does not replace the account feature switch', async () => {
    const { db } = fakeDb();
    vi.mocked(authenticateApiToken).mockResolvedValue({
      id: 'operator', name: 'Fixture', role: 'staff', readOnly: false,
      tenantId: DEFAULT_TENANT_ID, permissionKeys: ['/broadcasts'],
    } as never);
    vi.mocked(accountFeatureAvailability).mockResolvedValue({
      featureId: 'broadcasts', contractAvailable: false, companyEnabled: true,
      dependenciesEnabled: true, effectiveEnabled: false, reason: 'contract_unavailable',
      message: 'ご契約ではこの機能を利用できません', disabledDependencies: [],
    });
    const res = await setupApp().request('/line-api/v2/bot/message/broadcast', {
      method: 'POST', headers: { Authorization: 'Bearer harness-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ type: 'text', text: 'fixture message' }] }),
    }, env(db));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FEATURE_NOT_ENTITLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('core one-to-one push remains independent of the broadcast switch', async () => {
    const { db } = fakeDb();
    const res = await setupApp().request(pushRequest('acc-token'), {}, env(db));
    expect(res.status).toBe(200);
    expect(accountFeatureAvailability).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('auth', () => {
  test('no Authorization header → 401, upstream not called', async () => {
    const { db } = fakeDb();
    const res = await setupApp().request(pushRequest(null), {}, env(db));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('unknown token → 401 (no open relay)', async () => {
    const { db } = fakeDb();
    const res = await setupApp().request(pushRequest('stranger-token'), {}, env(db));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('env fallback token is accepted with null account', async () => {
    const { db, executed } = fakeDb();
    const res = await setupApp().request(pushRequest('env-token'), {}, env(db));
    expect(res.status).toBe(200);
    const rows = loggedRows(executed);
    expect(rows).toHaveLength(1);
    expect(rows[0].lineAccountId).toBeNull();
  });

  test('inactive account token → 401', async () => {
    vi.mocked(getLineAccounts).mockResolvedValue([{ ...ACCOUNT, is_active: 0 }] as never);
    const { db } = fakeDb();
    const res = await setupApp().request(pushRequest('acc-token'), {}, env(db));
    expect(res.status).toBe(401);
  });

  test('停止中アカウントのトークンがenv既定値と同じでも代理送信できない', async () => {
    vi.mocked(getLineAccounts).mockResolvedValue([
      { ...ACCOUNT, channel_access_token: 'env-token' },
    ] as never);
    vi.mocked(listLineAccountsWithTenantStatus).mockResolvedValue([
      { ...ACCOUNT, channel_access_token: 'env-token', tenant_status: 'suspended' },
    ] as never);
    const { db } = fakeDb();
    const res = await setupApp().request(pushRequest('env-token'), {}, env(db));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'TENANT_SUSPENDED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("account_scope='all' staff can operate another LINE account in the same organization", async () => {
    vi.mocked(getLineAccounts).mockResolvedValue([ACCOUNT, ACCOUNT_2] as never);
    vi.mocked(authenticateApiToken).mockResolvedValue({
      id: 'staff-1', name: 'Restricted', role: 'staff', readOnly: false,
      permissionKeys: ['/chats'], assignedLineAccountId: 'acc-1',
      canAccessDescendantAccounts: false,
    });
    const { db } = fakeDb();
    const res = await setupApp().request(
      pushRequest('staff-key', undefined, { 'X-Line-Account-Id': 'acc-2' }), {}, env(db),
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("account_scope='accounts' staff is rejected for an unassigned LINE account", async () => {
    vi.mocked(getLineAccounts).mockResolvedValue([ACCOUNT, ACCOUNT_2] as never);
    vi.mocked(getStaffById).mockResolvedValueOnce({ account_scope: 'accounts' } as never);
    vi.mocked(getStaffAccountScopeIds).mockResolvedValueOnce(['acc-1']);
    vi.mocked(authenticateApiToken).mockResolvedValue({
      id: 'staff-1', name: 'Restricted', role: 'staff', readOnly: false,
      permissionKeys: ['/chats'], assignedLineAccountId: 'acc-1',
      canAccessDescendantAccounts: false,
    });
    const { db } = fakeDb();
    const res = await setupApp().request(
      pushRequest('staff-key', undefined, { 'X-Line-Account-Id': 'acc-2' }), {}, env(db),
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('read-only staff key cannot send LINE messages', async () => {
    vi.mocked(authenticateApiToken).mockResolvedValue({
      id: 'staff-1', name: 'Viewer', role: 'staff', readOnly: true,
      permissionKeys: ['/chats'], assignedLineAccountId: 'acc-1',
      canAccessDescendantAccounts: false,
    });
    const { db } = fakeDb();
    const res = await setupApp().request(pushRequest('staff-key'), {}, env(db));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('staff with chat permission can push through its assigned account', async () => {
    vi.mocked(authenticateApiToken).mockResolvedValue({
      id: 'staff-1', name: 'Operator', role: 'staff', readOnly: false,
      permissionKeys: ['/chats'], assignedLineAccountId: 'acc-1',
      canAccessDescendantAccounts: false,
    });
    const { db } = fakeDb();
    const res = await setupApp().request(
      pushRequest('staff-key', undefined, { 'X-Line-Account-Id': 'acc-1' }), {}, env(db),
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('harness API key auth', () => {
  beforeEach(() => {
    vi.mocked(authenticateApiToken).mockImplementation(async (_c: unknown, token: unknown) =>
      token === 'harness-key' ? ({ id: 's1', name: 'Owner', role: 'owner' } as never) : null,
    );
  });

  test('single account: upstream gets the channel token, log carries account id', async () => {
    const { db, executed } = fakeDb();
    const res = await setupApp().request(pushRequest('harness-key'), {}, env(db));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.line.me/v2/bot/message/push',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer acc-token' }),
      }),
    );
    const rows = loggedRows(executed);
    expect(rows).toHaveLength(1);
    expect(rows[0].lineAccountId).toBe('acc-1');
  });

  test('multiple accounts without X-Line-Account-Id → 400', async () => {
    vi.mocked(getLineAccounts).mockResolvedValue([ACCOUNT, ACCOUNT_2] as never);
    const { db } = fakeDb();
    const res = await setupApp().request(pushRequest('harness-key'), {}, env(db));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('X-Line-Account-Id selects the account (by channel_id too)', async () => {
    vi.mocked(getLineAccounts).mockResolvedValue([ACCOUNT, ACCOUNT_2] as never);
    const { db, executed } = fakeDb();
    const res = await setupApp().request(
      pushRequest('harness-key', undefined, { 'X-Line-Account-Id': 'ch-2' }),
      {},
      env(db),
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer acc-token-2' }),
      }),
    );
    expect(loggedRows(executed)[0].lineAccountId).toBe('acc-2');
  });

  test('unknown X-Line-Account-Id → 400', async () => {
    vi.mocked(getLineAccounts).mockResolvedValue([ACCOUNT, ACCOUNT_2] as never);
    const { db } = fakeDb();
    const res = await setupApp().request(
      pushRequest('harness-key', undefined, { 'X-Line-Account-Id': 'nope' }),
      {},
      env(db),
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('legacy environment account authorization', () => {
  beforeEach(() => {
    vi.mocked(getLineAccounts).mockResolvedValue([]);
    vi.mocked(authenticateApiToken).mockResolvedValue({
      id: 'staff-legacy', name: 'Operator', role: 'staff', readOnly: false,
      permissionKeys: ['/chats'], tenantId: DEFAULT_TENANT_ID,
    });
  });

  test.each(['foreign tenant', 'assigned accounts', 'feature scope'] as const)(
    '%s cannot use the environment channel through either proxy', async (restriction) => {
      if (restriction === 'foreign tenant') {
        vi.mocked(authenticateApiToken).mockResolvedValue({
          id: 'foreign-staff', name: 'Operator', role: 'staff', readOnly: false,
          permissionKeys: ['/chats'], tenantId: 'other-tenant',
        });
      } else if (restriction === 'assigned accounts') {
        vi.mocked(getStaffById).mockResolvedValueOnce({ account_scope: 'accounts' } as never);
        vi.mocked(getStaffAccountScopeIds).mockResolvedValueOnce(['acc-1']);
      } else {
        vi.mocked(authenticateApiToken).mockResolvedValue({
          id: 'feature-staff', name: 'Operator', role: 'staff', readOnly: false,
          permissionKeys: ['/chats'], tenantId: DEFAULT_TENANT_ID,
          featureEnabledLineAccountIds: ['acc-1'],
        });
      }
      const { db, executed } = fakeDb();
      for (const request of [
        pushRequest('staff-key'),
        new Request('http://worker.test/line-api-data/v2/bot/message/message-1/content', {
          headers: { Authorization: 'Bearer staff-key' },
        }),
      ]) {
        const res = await setupApp().request(request, {}, env(db));
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ message: 'LINE account not found' });
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(executed).toEqual([]);
    },
  );

  test.each([
    { is_active: 0, tenant_status: 'active', directStatus: 401 },
    { is_active: 1, tenant_status: 'suspended', directStatus: 403 },
    { is_active: 1, tenant_status: 'archived', directStatus: 403 },
  ])('registered unavailable default $is_active/$tenant_status cannot fall back to legacy', async (state) => {
    const registered = { ...ACCOUNT, ...state, channel_access_token: 'env-token' };
    vi.mocked(getLineAccounts).mockResolvedValue([registered] as never);
    vi.mocked(listLineAccountsWithTenantStatus).mockResolvedValue([registered] as never);
    vi.mocked(authenticateApiToken).mockImplementation(async (_c, token) => token === 'staff-key'
      ? { id: 'staff-legacy', name: 'Operator', role: 'staff', readOnly: false,
        permissionKeys: ['/chats'], tenantId: DEFAULT_TENANT_ID }
      : null);
    const { db, executed } = fakeDb();
    for (const [token, status] of [['staff-key', 404], ['env-token', state.directStatus]] as const) {
      const res = await setupApp().request(pushRequest(token), {}, env(db));
      expect(res.status).toBe(status);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
  });

  test.each(['staff-legacy', 'env-owner'])(
    'authorized default-tenant %s retains unregistered environment access', async (id) => {
      vi.mocked(authenticateApiToken).mockResolvedValue({
        id, name: 'Operator', role: id === 'env-owner' ? 'owner' : 'staff', readOnly: false,
        permissionKeys: ['/chats'], tenantId: DEFAULT_TENANT_ID,
      });
      const { db, executed } = fakeDb();
      const res = await setupApp().request(pushRequest('staff-key'), {}, env(db));
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.line.me/v2/bot/message/push',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer env-token' }),
        }),
      );
      expect(loggedRows(executed)[0].lineAccountId).toBeNull();
    },
  );

  test('an active registered environment token keeps its account identity', async () => {
    vi.mocked(getLineAccounts).mockResolvedValue([
      { ...ACCOUNT, channel_access_token: 'env-token' },
    ] as never);
    const { db, executed } = fakeDb();
    const res = await setupApp().request(pushRequest('env-token'), {}, env(db));
    expect(res.status).toBe(200);
    expect(loggedRows(executed)[0].lineAccountId).toBe('acc-1');
    expect(authenticateApiToken).not.toHaveBeenCalled();
  });
});

describe('push', () => {
  test('forwards to api.line.me and logs source=external', async () => {
    const { db, executed } = fakeDb();
    const res = await setupApp().request(pushRequest('acc-token'), {}, env(db));

    expect(res.status).toBe(200);
    expect(res.headers.get('x-line-request-id')).toBe('req-1');
    expect(getFriendByLineUserIdForAccount).toHaveBeenCalledWith(
      db,
      USER_A,
      'acc-1',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.line.me/v2/bot/message/push',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer acc-token' }),
      }),
    );

    const rows = loggedRows(executed);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      friendId: 'friend-1',
      messageType: 'text',
      content: 'hello',
      deliveryType: 'push',
      source: 'external',
      lineAccountId: 'acc-1',
    });

    expect(updateChat).toHaveBeenCalledWith(
      expect.anything(),
      'chat-1',
      expect.objectContaining({ status: 'in_progress' }),
    );
  });

  /*
   * 同じ送信キー（X-Line-Retry-Key）の再送は履歴を二重に書かない。
   * 初回の200で履歴の保存が落ちても、LINEが「受理済み」を返す409の再送で
   * 同じ決まったIDの行へ補完する。
   */
  test('same retry key generates one log row across 200 and accepted-409 retries', async () => {
    const { db, executed } = fakeDb();
    const retryHeaders = { 'X-Line-Retry-Key': 'retry-key-1' };
    const first = await setupApp().request(
      pushRequest('acc-token', undefined, retryHeaders), {}, env(db),
    );
    expect(first.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Line-Retry-Key': 'retry-key-1' }),
      }),
    );

    fetchMock.mockImplementationOnce(async () => new Response('{"message":"accepted"}', {
      status: 409,
      headers: { 'content-type': 'application/json', 'x-line-accepted-request-id': 'req-1' },
    }));
    const second = await setupApp().request(
      pushRequest('acc-token', undefined, retryHeaders), {}, env(db),
    );
    // 受理済み409はそのまま呼び出し側へ返すが、履歴は書く
    expect(second.status).toBe(409);
    const inserts = executed.filter((e) => e.sql.includes('INTO messages_log'));
    expect(inserts).toHaveLength(2);
    // 同じ送信キー・同じ友だち・同じ位置 → 同じID。実DBでは INSERT OR IGNORE が1行に畳む。
    expect(inserts[0].params[0]).toBe(inserts[1].params[0]);
  });

  test('requests without a retry key still get fresh log ids', async () => {
    const { db, executed } = fakeDb();
    await setupApp().request(pushRequest('acc-token'), {}, env(db));
    await setupApp().request(pushRequest('acc-token'), {}, env(db));
    const inserts = executed.filter((e) => e.sql.includes('INTO messages_log'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params[0]).not.toBe(inserts[1].params[0]);
  });

  test('manual header logs a 1:1 operator reply as source=manual and is not forwarded', async () => {
    const { db, executed } = fakeDb();
    const res = await setupApp().request(
      pushRequest('acc-token', undefined, { 'X-Line-Harness-Source': 'manual' }),
      {},
      env(db),
    );

    expect(res.status).toBe(200);
    expect(loggedRows(executed)).toHaveLength(1);
    expect(loggedRows(executed)[0].source).toBe('manual');
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers).not.toHaveProperty('X-Line-Harness-Source');
  });

  test('unknown source header is rejected before upstream send', async () => {
    const { db } = fakeDb();
    const res = await setupApp().request(
      pushRequest('acc-token', undefined, { 'X-Line-Harness-Source': 'operator' }),
      {},
      env(db),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('manual source cannot be used for multicast', async () => {
    const { db } = fakeDb();
    const res = await setupApp().request(
      new Request('http://worker.test/line-api/v2/bot/message/multicast', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer acc-token',
          'Content-Type': 'application/json',
          'X-Line-Harness-Source': 'manual',
        },
        body: JSON.stringify({ to: [USER_A], messages: [{ type: 'text', text: 'hello' }] }),
      }),
      {},
      env(db),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('percent-encoded path still logs (no log-dodging)', async () => {
    const { db, executed } = fakeDb();
    const res = await setupApp().request(
      new Request('http://worker.test/line-api/v2/bot/message/%70ush', {
        method: 'POST',
        headers: { Authorization: 'Bearer acc-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: USER_A, messages: [{ type: 'text', text: 'sneaky' }] }),
      }),
      {},
      env(db),
    );
    expect(res.status).toBe(200);
    expect(loggedRows(executed)).toHaveLength(1);
  });

  test('group target (C…) is forwarded but never fabricates a friend', async () => {
    const { db, executed } = fakeDb();
    const res = await setupApp().request(
      pushRequest('acc-token', {
        to: `C${'0'.repeat(32)}`,
        messages: [{ type: 'text', text: 'to group' }],
      }),
      {},
      env(db),
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    expect(loggedRows(executed)).toHaveLength(0);
    expect(upsertFriend).not.toHaveBeenCalled();
  });

  test('unknown recipient → profile fetched, friend created, account pinned', async () => {
    const newUser = U(0x999);
    vi.mocked(getFriendByLineUserIdForAccount).mockResolvedValue(null as never);
    lineClientMocks.getProfile.mockResolvedValue({ displayName: 'New User' });
    vi.mocked(upsertFriend).mockResolvedValue({ id: 'friend-new', line_user_id: newUser } as never);
    vi.mocked(getChatByFriendId).mockResolvedValue(null as never);
    vi.mocked(createChat).mockResolvedValue({ id: 'chat-new' } as never);

    const { db, executed } = fakeDb();
    const res = await setupApp().request(
      pushRequest('acc-token', { to: newUser, messages: [{ type: 'text', text: 'yo' }] }),
      {},
      env(db),
    );

    expect(res.status).toBe(200);
    expect(lineClientMocks.getProfile).toHaveBeenCalledWith(newUser);
    expect(upsertFriend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        lineUserId: newUser,
        lineAccountId: 'acc-1',
        displayName: 'New User',
      }),
    );
    const accountPin = executed.find((e) => e.sql.includes('UPDATE friends SET line_account_id'));
    expect(accountPin).toBeDefined();
    expect(accountPin!.params).toEqual(['acc-1', 'friend-new']);
    expect(createChat).toHaveBeenCalled();
  });

  test('upstream 400 → status passthrough, nothing logged', async () => {
    fetchMock.mockResolvedValue(upstreamResponse(400, '{"message":"bad"}'));
    const { db, executed } = fakeDb();
    const res = await setupApp().request(pushRequest('acc-token'), {}, env(db));
    expect(res.status).toBe(400);
    expect(loggedRows(executed)).toHaveLength(0);
  });

  test('logging failure does not break the 200 response', async () => {
    const { db } = fakeDb();
    vi.spyOn(db, 'batch').mockRejectedValueOnce(new Error('db down'));
    const res = await setupApp().request(pushRequest('acc-token'), {}, env(db));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test('同意を確認できなければ上流へ送らず止める', async () => {
    vi.mocked(getFriendByLineUserIdForAccount).mockRejectedValue(new Error('db down'));
    const { db } = fakeDb();
    const res = await setupApp().request(pushRequest('acc-token'), {}, env(db));
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('multicast', () => {
  test('logs one row per recipient per message via chunked IN lookup', async () => {
    const [u1, u2] = [U(1), U(2)];
    const { db, executed } = fakeDb({
      friendsByUserId: {
        [u1]: { id: 'f1', line_user_id: u1 },
        [u2]: { id: 'f2', line_user_id: u2 },
      },
    });
    const res = await setupApp().request(
      new Request('http://worker.test/line-api/v2/bot/message/multicast', {
        method: 'POST',
        headers: { Authorization: 'Bearer acc-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: [u1, u2, u1], // duplicate must be deduped
          messages: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        }),
      }),
      {},
      env(db),
    );

    expect(res.status).toBe(200);
    const rows = loggedRows(executed);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.friendId))).toEqual(new Set(['f1', 'f2']));
    expect(getFriendByLineUserIdForAccount).not.toHaveBeenCalled();
  });

  test('unknown recipients beyond the creation cap are skipped, known ones still logged', async () => {
    const known = U(1);
    const strangers = Array.from({ length: 25 }, (_, i) => U(0x1000 + i));
    lineClientMocks.getProfile.mockResolvedValue(null);
    vi.mocked(upsertFriend).mockImplementation(
      async (_db: unknown, input: { lineUserId: string }) =>
        ({ id: `new-${input.lineUserId}`, line_user_id: input.lineUserId }) as never,
    );

    const { db, executed } = fakeDb({
      friendsByUserId: { [known]: { id: 'f-known', line_user_id: known } },
    });
    const res = await setupApp().request(
      new Request('http://worker.test/line-api/v2/bot/message/multicast', {
        method: 'POST',
        headers: { Authorization: 'Bearer acc-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: [known, ...strangers], messages: [{ type: 'text', text: 'x' }] }),
      }),
      {},
      env(db),
    );

    expect(res.status).toBe(200);
    // 既知1人と上限内の新規20人だけを記録し、超過5人は警告とともに除く。
    expect(loggedRows(executed)).toHaveLength(21);
    expect(upsertFriend).toHaveBeenCalledTimes(20);
  });
});

describe('broadcast', () => {
  test('single account install: logs the account friends including legacy NULL rows', async () => {
    const { db, executed } = fakeDb({ broadcastFriendIds: ['f1', 'f2', 'f3'] });
    const res = await setupApp().request(
      new Request('http://worker.test/line-api/v2/bot/message/broadcast', {
        method: 'POST',
        headers: { Authorization: 'Bearer acc-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ type: 'text', text: 'to everyone' }] }),
      }),
      {},
      env(db),
    );

    expect(res.status).toBe(200);
    const select = executed.find((e) => e.sql.includes('SELECT id FROM friends'));
    expect(select).toBeDefined();
    expect(select!.sql).toContain('line_account_id = ? OR line_account_id IS NULL');
    expect(select!.params).toEqual(['acc-1']);
    const rows = loggedRows(executed);
    expect(rows).toHaveLength(3);
    expect(rows[0].deliveryType).toBeNull();
  });

  test('single registered account does not claim an unrelated environment channel', async () => {
    const { db, executed } = fakeDb({ broadcastFriendIds: ['f1', 'f2'] });
    const res = await setupApp().request(
      new Request('http://worker.test/line-api/v2/bot/message/broadcast', {
        method: 'POST',
        headers: { Authorization: 'Bearer env-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ type: 'text', text: 'everyone' }] }),
      }),
      {},
      env(db),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'LINE_ACCOUNT_REQUIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
  });

  test('multi-account: scoped to the sending account', async () => {
    vi.mocked(getLineAccounts).mockResolvedValue([ACCOUNT, ACCOUNT_2] as never);
    const { db, executed } = fakeDb({ broadcastFriendIds: ['f1', 'f2'] });
    const res = await setupApp().request(
      new Request('http://worker.test/line-api/v2/bot/message/broadcast', {
        method: 'POST',
        headers: { Authorization: 'Bearer acc-token-2', 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ type: 'text', text: 'sub only' }] }),
      }),
      {},
      env(db),
    );
    expect(res.status).toBe(200);
    const select = executed.find((e) => e.sql.includes('SELECT id FROM friends'));
    expect(select!.sql).toContain('line_account_id = ?');
    expect(select!.params).toEqual(['acc-2']);
    expect(loggedRows(executed)).toHaveLength(2);
  });

  test('multi-account + unregistered env token requires a registered channel for broadcast', async () => {
    vi.mocked(getLineAccounts).mockResolvedValue([ACCOUNT, ACCOUNT_2] as never);
    const { db, executed } = fakeDb({ broadcastFriendIds: ['f1', 'f2'] });
    const res = await setupApp().request(
      new Request('http://worker.test/line-api/v2/bot/message/broadcast', {
        method: 'POST',
        headers: { Authorization: 'Bearer env-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ type: 'text', text: 'whose friends?' }] }),
      }),
      {},
      env(db),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'LINE_ACCOUNT_REQUIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggedRows(executed)).toHaveLength(0);
  });
});

describe('reply and passthrough', () => {
  test('reply is forwarded but not logged', async () => {
    const { db, executed } = fakeDb();
    const res = await setupApp().request(
      new Request('http://worker.test/line-api/v2/bot/message/reply', {
        method: 'POST',
        headers: { Authorization: 'Bearer acc-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ replyToken: 'rt', messages: [{ type: 'text', text: 'hi' }] }),
      }),
      {},
      env(db),
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    expect(loggedRows(executed)).toHaveLength(0);
  });

  test('GET /v2/bot/profile/:id passes through without logging', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"displayName":"X"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { db, executed } = fakeDb();
    const res = await setupApp().request(
      new Request(`http://worker.test/line-api/v2/bot/profile/${USER_A}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer acc-token' },
      }),
      {},
      env(db),
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.line.me/v2/bot/profile/${USER_A}`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(executed).toHaveLength(0);
  });

  test('line-api-data prefix targets api-data.line.me', async () => {
    const { db } = fakeDb();
    await setupApp().request(
      new Request('http://worker.test/line-api-data/v2/bot/message/m1/content', {
        method: 'GET',
        headers: { Authorization: 'Bearer acc-token' },
      }),
      {},
      env(db),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-data.line.me/v2/bot/message/m1/content',
      expect.anything(),
    );
  });

  test('path outside /v2/bot/ → 404, upstream not called', async () => {
    const { db } = fakeDb();
    const res = await setupApp().request(
      new Request('http://worker.test/line-api/oauth2/v2.1/token', {
        method: 'POST',
        headers: { Authorization: 'Bearer acc-token' },
        body: '{}',
      }),
      {},
      env(db),
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('binary upload (rich menu image) is forwarded byte-exact, not logged', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    const { db, executed } = fakeDb();
    const res = await setupApp().request(
      new Request('http://worker.test/line-api-data/v2/bot/richmenu/rm-1/content', {
        method: 'POST',
        headers: { Authorization: 'Bearer acc-token', 'Content-Type': 'image/png' },
        body: bytes,
      }),
      {},
      env(db),
    );
    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, { body: ArrayBuffer }];
    expect(new Uint8Array(init.body)).toEqual(bytes);
    expect(executed).toHaveLength(0);
  });

  test('oversized message body → 413', async () => {
    const { db } = fakeDb();
    const res = await setupApp().request(
      new Request('http://worker.test/line-api/v2/bot/message/push', {
        method: 'POST',
        headers: { Authorization: 'Bearer acc-token', 'Content-Type': 'application/json' },
        body: 'x'.repeat(1024 * 1024 + 1),
      }),
      {},
      env(db),
    );
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/*
 *  — broadcast_dispatch 緊急停止はプロキシ送信経路にも効く。
 * 停止中の一斉送信系 (broadcast/multicast/narrowcast/自動push) は上流へ
 * fetch しない。例外は reply と manual 明示の 1:1 push。
 */
describe('emergency stop (broadcast_dispatch)', () => {
  function sendRequest(path: string, extraHeaders: Record<string, string> = {}) {
    return new Request(`http://worker.test/line-api${path}`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer acc-token',
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify({ to: USER_A, messages: [{ type: 'text', text: 'hi' }] }),
    });
  }

  test.each([
    '/v2/bot/message/broadcast',
    '/v2/bot/message/multicast',
    '/v2/bot/message/narrowcast',
  ])('stopped: POST %s returns 409 and never reaches upstream', async (path) => {
    vi.mocked(isOperationCapabilityStopped).mockResolvedValue(true as never);
    const { db, executed } = fakeDb();
    const res = await setupApp().request(sendRequest(path), {}, env(db));

    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggedRows(executed)).toHaveLength(0);
    expect(isOperationCapabilityStopped).toHaveBeenCalledWith(
      db,
      'acc-1',
      'broadcast_dispatch',
    );
  });

  test('stopped: automatic push (no manual source) is also blocked', async () => {
    vi.mocked(isOperationCapabilityStopped).mockResolvedValue(true as never);
    const { db, executed } = fakeDb();
    const res = await setupApp().request(pushRequest('acc-token'), {}, env(db));

    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggedRows(executed)).toHaveLength(0);
  });

  test('stopped: manual push (X-Line-Harness-Source: manual) still goes through', async () => {
    vi.mocked(isOperationCapabilityStopped).mockResolvedValue(true as never);
    const { db, executed } = fakeDb();
    const res = await setupApp().request(
      pushRequest('acc-token', undefined, { 'X-Line-Harness-Source': 'manual' }),
      {},
      env(db),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loggedRows(executed)[0].source).toBe('manual');
  });

  test('stopped: reply still forwarded (1:1 reply is not dispatch)', async () => {
    vi.mocked(isOperationCapabilityStopped).mockResolvedValue(true as never);
    const { db } = fakeDb();
    const res = await setupApp().request(
      new Request('http://worker.test/line-api/v2/bot/message/reply', {
        method: 'POST',
        headers: { Authorization: 'Bearer acc-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ replyToken: 'rt', messages: [{ type: 'text', text: 'hi' }] }),
      }),
      {},
      env(db),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('running: broadcast forwards upstream and checks the capability first', async () => {
    const { db } = fakeDb();
    const res = await setupApp().request(
      sendRequest('/v2/bot/message/broadcast'),
      {},
      env(db),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isOperationCapabilityStopped).toHaveBeenCalledWith(
      db,
      'acc-1',
      'broadcast_dispatch',
    );
  });

  /*
   *  — X-Line-Harness-Capability で送信経路ごとの停止対象を名乗る。
   * 停止中は上流へ一切出さず 409 を返す。値が無い・知らない値の自動送信は
   * 従来どおり broadcast_dispatch (安全側) で止める。
   */
  test.each([
    'reminder_dispatch',
    'scenario_dispatch',
    'automation_actions',
  ])('stopped: capability header %s gates automatic push with that capability', async (capability) => {
    vi.mocked(isOperationCapabilityStopped).mockResolvedValue(true as never);
    const { db, executed } = fakeDb();
    const res = await setupApp().request(
      pushRequest('acc-token', undefined, { 'X-Line-Harness-Capability': capability }),
      {},
      env(db),
    );

    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggedRows(executed)).toHaveLength(0);
    expect(isOperationCapabilityStopped).toHaveBeenCalledWith(db, 'acc-1', capability);
  });

  test('capability header only narrows the capability that is stopped', async () => {
    // reminder_dispatch だけ止まっている想定。broadcast 既定の自動 push は
    // reminder_dispatch を名乗らないので broadcast_dispatch で判定する。
    vi.mocked(isOperationCapabilityStopped).mockImplementation(
      async (_db, _account, capability) => capability === 'reminder_dispatch',
    );
    const { db } = fakeDb();
    const res = await setupApp().request(pushRequest('acc-token'), {}, env(db));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isOperationCapabilityStopped).toHaveBeenCalledWith(db, 'acc-1', 'broadcast_dispatch');
  });

  test('unknown capability header falls back to broadcast_dispatch (safe default)', async () => {
    vi.mocked(isOperationCapabilityStopped).mockResolvedValue(true as never);
    const { db } = fakeDb();
    const res = await setupApp().request(
      pushRequest('acc-token', undefined, { 'X-Line-Harness-Capability': 'not_a_capability' }),
      {},
      env(db),
    );

    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isOperationCapabilityStopped).toHaveBeenCalledWith(db, 'acc-1', 'broadcast_dispatch');
  });

  test('manual push ignores the capability header entirely', async () => {
    // manual 1:1 返信は停止対象外。ヘッダが付いていても manual が優先され、
    // 停止判定自体を呼ばない。
    vi.mocked(isOperationCapabilityStopped).mockResolvedValue(true as never);
    const { db, executed } = fakeDb();
    const res = await setupApp().request(
      pushRequest('acc-token', undefined, {
        'X-Line-Harness-Source': 'manual',
        'X-Line-Harness-Capability': 'reminder_dispatch',
      }),
      {},
      env(db),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isOperationCapabilityStopped).not.toHaveBeenCalled();
    expect(loggedRows(executed)[0].source).toBe('manual');
  });

  test('stopped: unrelated proxy calls are unaffected', async () => {
    vi.mocked(isOperationCapabilityStopped).mockResolvedValue(true as never);
    fetchMock.mockResolvedValue(
      new Response('{"displayName":"X"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { db } = fakeDb();
    const res = await setupApp().request(
      new Request(`http://worker.test/line-api/v2/bot/profile/${USER_A}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer acc-token' },
      }),
      {},
      env(db),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isOperationCapabilityStopped).not.toHaveBeenCalled();
  });
});


describe('配信停止・同意の送信直前検査',()=>{
 test.each(['/v2/bot/message/push','/v2/bot/message/multicast','/v2/bot/message/broadcast','/v2/bot/message/narrowcast'])('停止対象を含む%sは上流へ出さない',async path=>{
  const {db}=fakeDb({suppressed:true});
  const response=await setupApp().request(new Request('http://worker.test/line-api'+path,{method:'POST',headers:{Authorization:'Bearer acc-token','Content-Type':'application/json'},body:JSON.stringify({to:path.endsWith('/multicast')?[USER_A]:USER_A,messages:[{type:'text',text:'案内'}]})}),{},env(db));
  expect(response.status).toBe(409);expect(fetchMock).not.toHaveBeenCalled();
 });
 test('manualの個別返信は配信停止中でも担当者が送れる',async()=>{
  const {db}=fakeDb({suppressed:true});
  const response=await setupApp().request(pushRequest('acc-token',undefined,{'X-Line-Harness-Source':'manual'}),{},env(db));
  expect(response.status).toBe(200);expect(fetchMock).toHaveBeenCalledOnce();
 });
});
