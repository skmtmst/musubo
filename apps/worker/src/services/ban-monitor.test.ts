import { beforeEach, describe, expect, it, vi } from 'vitest';

const getLineAccounts = vi.fn();
const createAccountHealthLog = vi.fn();
const createNotification = vi.fn();
const getLatestRiskLevel = vi.fn();
const recordPoolSwitchEvent = vi.fn();
const listAutoSwitchedOutPoolAccounts = vi.fn();
const togglePoolAccount = vi.fn();
const recordAuditEvent = vi.fn();

vi.mock('@line-crm/db', () => ({
  getLineAccounts: (...args: unknown[]) => getLineAccounts(...args),
  createAccountHealthLog: (...args: unknown[]) => createAccountHealthLog(...args),
  createNotification: (...args: unknown[]) => createNotification(...args),
  getLatestRiskLevel: (...args: unknown[]) => getLatestRiskLevel(...args),
  recordPoolSwitchEvent: (...args: unknown[]) => recordPoolSwitchEvent(...args),
  listAutoSwitchedOutPoolAccounts: (...args: unknown[]) => listAutoSwitchedOutPoolAccounts(...args),
  togglePoolAccount: (...args: unknown[]) => togglePoolAccount(...args),
  recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args),
}));

function database(counts: Record<string, number>): D1Database {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...values: unknown[]) => ({
        first: vi.fn(async () => ({ count: counts[String(values[1])] ?? 0 })),
      })),
      sql,
    })),
  } as unknown as D1Database;
}

beforeEach(() => {
  vi.clearAllMocks();
  getLineAccounts.mockResolvedValue([
    { id: 'account-a', channel_access_token: 'token-a', is_active: 1 },
    { id: 'account-b', channel_access_token: 'token-b', is_active: 1 },
  ]);
  getLatestRiskLevel.mockResolvedValue('normal');
  listAutoSwitchedOutPoolAccounts.mockResolvedValue([]);
  createAccountHealthLog.mockImplementation(async (_db, input: { lineAccountId: string }) => ({
    id: `health-${input.lineAccountId}`,
  }));
  createNotification.mockResolvedValue({ id: 'notice-1' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

describe('account health dashboard notifications', () => {
  it('counts outgoing messages per LINE account and notifies only the changed warning account', async () => {
    const db = database({ 'account-a': 6001, 'account-b': 0 });
    const { checkAccountHealth } = await import('./ban-monitor.js');

    await checkAccountHealth(db);

    const sql = vi.mocked(db.prepare).mock.calls[0]?.[0] as string;
    expect(sql).toContain('line_account_id = ?');
    expect(createAccountHealthLog).toHaveBeenCalledWith(db, expect.objectContaining({
      lineAccountId: 'account-a', riskLevel: 'warning',
    }));
    expect(createAccountHealthLog).toHaveBeenCalledWith(db, expect.objectContaining({
      lineAccountId: 'account-b', riskLevel: 'normal',
    }));
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(db, expect.objectContaining({
      eventType: 'account_health_warning',
      lineAccountId: 'account-a',
      channel: 'dashboard',
      category: 'error',
    }));
  });

  it('does not create the same danger notification on every health check', async () => {
    getLineAccounts.mockResolvedValue([
      { id: 'account-a', channel_access_token: 'token-a', is_active: 1 },
    ]);
    getLatestRiskLevel.mockResolvedValue('danger');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    const { checkAccountHealth } = await import('./ban-monitor.js');

    await checkAccountHealth(database({ 'account-a': 0 }));

    expect(createAccountHealthLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      riskLevel: 'danger',
    }));
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('creates a recovery update after a warning or danger clears', async () => {
    getLineAccounts.mockResolvedValue([
      { id: 'account-a', channel_access_token: 'token-a', is_active: 1 },
    ]);
    getLatestRiskLevel.mockResolvedValue('warning');
    const { checkAccountHealth } = await import('./ban-monitor.js');

    await checkAccountHealth(database({ 'account-a': 0 }));

    expect(createNotification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'account_health_recovered',
      lineAccountId: 'account-a',
      category: 'update',
    }));
  });
});

// SQL ごとに first/all/run の返り値を指定できる stub。
function dbWith(
  handlers: Array<{ match: string; first?: unknown; all?: unknown[] }>,
): D1Database {
  return {
    batch: vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => Promise.all(statements.map(statement => statement.run()))),
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => {
        const handler = handlers.find((h) => sql.includes(h.match));
        return {
          first: vi.fn(async () => handler?.first ?? null),
          all: vi.fn(async () => ({ results: handler?.all ?? [] })),
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
        };
      }),
      sql,
    })),
  } as unknown as D1Database;
}

// X-3: Webhook が既定の24時間来ないアカウントは warning。
describe('webhook 無受信の監視', () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

  it('24時間以上受信が無いと warning', async () => {
    getLineAccounts.mockResolvedValue([
      { id: 'account-a', channel_access_token: 'token-a', is_active: 1,
        last_webhook_received_at: twoDaysAgo },
    ]);
    const { checkAccountHealth } = await import('./ban-monitor.js');
    await checkAccountHealth(dbWith([{ match: 'messages_log', first: { count: 0 } }]));
    expect(createAccountHealthLog).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ lineAccountId: 'account-a', riskLevel: 'warning' }));
    expect(createNotification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: 'Webhook が届いていません' }));
  });

  it('作ったばかり（24時間未満）で受信実績が無くても warning にしない', async () => {
    getLineAccounts.mockResolvedValue([
      { id: 'account-a', channel_access_token: 'token-a', is_active: 1,
        created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    ]);
    const { checkAccountHealth } = await import('./ban-monitor.js');
    await checkAccountHealth(dbWith([{ match: 'messages_log', first: { count: 0 } }]));
    expect(createAccountHealthLog).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ riskLevel: 'normal' }));
  });

  it('webhook_silence_exempt のアカウントは受信が無くても normal', async () => {
    getLineAccounts.mockResolvedValue([
      { id: 'account-a', channel_access_token: 'token-a', is_active: 1,
        webhook_silence_exempt: 1, last_webhook_received_at: twoDaysAgo },
    ]);
    const { checkAccountHealth } = await import('./ban-monitor.js');
    await checkAccountHealth(dbWith([{ match: 'messages_log', first: { count: 0 } }]));
    expect(createAccountHealthLog).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ riskLevel: 'normal' }));
  });
});

// X-4: danger になったアカウントをプールから自動で外し、24時間正常で戻す。
describe('プールの自動切替', () => {
  it('danger のアカウントをプールから外して記録・通知する', async () => {
    getLineAccounts.mockResolvedValue([
      { id: 'account-a', channel_access_token: 'token-a', is_active: 1,
        webhook_silence_exempt: 1 },
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    const db = dbWith([
      { match: 'messages_log', first: { count: 0 } },
      { match: 'FROM pool_accounts', all: [{ pool_account_id: 'pa-1', pool_id: 'pool-1' }] },
    ]);
    const { checkAccountHealth } = await import('./ban-monitor.js');
    await checkAccountHealth(db);

    expect(togglePoolAccount).toHaveBeenCalledWith(db, 'pa-1', false);
    expect(recordPoolSwitchEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      poolId: 'pool-1', lineAccountId: 'account-a', direction: 'out', reason: 'health_danger',
    }));
    expect(createNotification).toHaveBeenCalledWith(db, expect.objectContaining({
      eventType: 'account_pool_switched',
    }));
  });

  it('24時間「正常」が続いた外れ中アカウントをプールへ戻す', async () => {
    getLineAccounts.mockResolvedValue([]);
    listAutoSwitchedOutPoolAccounts.mockResolvedValue([
      { pool_id: 'pool-1', line_account_id: 'account-a', switched_at: '2026-09-26' },
    ]);
    const db = dbWith([
      { match: "risk_level != 'normal'", first: { count: 0 } },
      { match: "risk_level = 'normal'", first: { count: 30 } },
    ]);
    const { checkAccountHealth } = await import('./ban-monitor.js');
    await checkAccountHealth(db);

    expect(recordPoolSwitchEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      poolId: 'pool-1', lineAccountId: 'account-a', direction: 'in', reason: 'health_recovered_24h',
    }));
    expect(recordAuditEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      action: 'line_account.pool_switch', reason: 'health_recovered_24h',
    }));
  });

  it('正常の記録がまだ無い（外れたばかり）ときは戻さない', async () => {
    getLineAccounts.mockResolvedValue([]);
    listAutoSwitchedOutPoolAccounts.mockResolvedValue([
      { pool_id: 'pool-1', line_account_id: 'account-a', switched_at: '2026-09-27' },
    ]);
    const db = dbWith([
      { match: "risk_level != 'normal'", first: { count: 0 } },
      { match: "risk_level = 'normal'", first: { count: 0 } },
    ]);
    const { checkAccountHealth } = await import('./ban-monitor.js');
    await checkAccountHealth(db);

    expect(recordPoolSwitchEvent).not.toHaveBeenCalled();
  });
});
