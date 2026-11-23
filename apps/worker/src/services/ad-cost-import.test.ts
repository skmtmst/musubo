import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { importAdCosts, importAdCostNow } from './ad-cost-import.js';

const NOW = '2026-09-21T00:00:00+09:00';

function seed(testDb: SqliteD1): void {
  testDb.raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
  testDb.raw.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
     VALUES ('a1', 'channel-a1', 'a1', 'token', 'secret', 1, 'tenant-1')`,
  ).run();
}

function addPlatform(
  testDb: SqliteD1,
  id: string,
  name: string,
  config: Record<string, unknown>,
  isActive = 1,
): void {
  testDb.raw.prepare(
    `INSERT INTO ad_platforms (id, name, display_name, config, is_active, line_account_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'a1', ?, ?)`,
  ).run(id, name, `${name}広告`, JSON.stringify(config), isActive, NOW, NOW);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('広告費を日ごとに取り込み成功と失敗を記録する', () => {
  it('媒体の応答を最小通貨単位にして台帳へ載せ、成功を残す', async () => {
    const testDb = createTestD1();
    seed(testDb);
    addPlatform(testDb, 'p-meta', 'meta', {
      ad_account_id: 'act_123', access_token: 'token-1234567890',
    });
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({ data: [{ spend: '1234.56' }] }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await importAdCosts(testDb.db, { day: '2026-09-20' });
    expect(result).toEqual({ processed: 1, imported: 1, failed: 0, skipped: 0 });

    const entry = testDb.raw
      .prepare(`SELECT amount_minor, currency, source, imported_at FROM ad_cost_entries WHERE ad_platform_id = 'p-meta'`)
      .get() as { amount_minor: number; currency: string; source: string; imported_at: string };
    // JPY は小数点以下の無い通貨なので「1234.56円」は 1235 に丸まる
    expect(entry.amount_minor).toBe(1235);
    expect(entry.currency).toBe('JPY');
    expect(entry.source).toBe('import');
    expect(entry.imported_at).toBeTruthy();

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('act_123/insights');
    expect(url).toContain('2026-09-20');
  });

  it('取れなかった日は失敗を残し、行は作らない', async () => {
    const testDb = createTestD1();
    seed(testDb);
    addPlatform(testDb, 'p-tiktok', 'tiktok', {
      advertiser_id: 'adv-1', access_token: 'token-1234567890',
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 401, text: async () => 'unauthorized',
    })));

    const result = await importAdCosts(testDb.db, { day: '2026-09-20' });
    expect(result.failed).toBe(1);
    const run = testDb.raw
      .prepare(`SELECT status, error_message FROM ad_cost_import_runs WHERE ad_platform_id = 'p-tiktok'`)
      .get() as { status: string; error_message: string };
    expect(run.status).toBe('failed');
    expect(run.error_message).toContain('401');
    const { c } = testDb.raw
      .prepare(`SELECT COUNT(*) AS c FROM ad_cost_entries`)
      .get() as { c: number };
    expect(c).toBe(0);
  });

  it('成功済みの日は取り直さないが、画面からの取り直しは通す', async () => {
    const testDb = createTestD1();
    seed(testDb);
    addPlatform(testDb, 'p-meta', 'meta', {
      ad_account_id: 'act_123', access_token: 'token-1234567890',
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ data: [{ spend: '10' }] }), text: async () => '',
    })));

    const first = await importAdCosts(testDb.db, { day: '2026-09-20' });
    expect(first.imported).toBe(1);
    const second = await importAdCosts(testDb.db, { day: '2026-09-20' });
    expect(second.skipped).toBe(1);

    // 媒体側で数値が確定・修正されることがあるので、手動は同じ日を取り直せる
    const forced = await importAdCostNow(testDb.db, 'p-meta', { day: '2026-09-20' });
    expect(forced.status).toBe('success');
  });

  it('連携設定が足りない媒体は失敗にして他を止めない', async () => {
    const testDb = createTestD1();
    seed(testDb);
    addPlatform(testDb, 'p-broken', 'meta', { access_token: 'token-1234567890' });
    addPlatform(testDb, 'p-google', 'google', {
      customer_id: '123-456-7890', oauth_token: 'token-1234567890', developer_token: 'dev-1',
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => [{
        results: [{ metrics: { costMicros: '5000000' }, customer: { currencyCode: 'JPY' } }],
      }],
      text: async () => '',
    })));

    const result = await importAdCosts(testDb.db, { day: '2026-09-20' });
    expect(result).toEqual({ processed: 2, imported: 1, failed: 1, skipped: 0 });

    const failed = testDb.raw
      .prepare(`SELECT error_message FROM ad_cost_import_runs WHERE ad_platform_id = 'p-broken'`)
      .get() as { error_message: string };
    expect(failed.error_message).toContain('ad_account_id');
    const google = testDb.raw
      .prepare(`SELECT amount_minor, currency FROM ad_cost_entries WHERE ad_platform_id = 'p-google'`)
      .get() as { amount_minor: number; currency: string };
    // 5,000,000 マイクロ = 5円
    expect(google).toEqual({ amount_minor: 5, currency: 'JPY' });
  });

  it('止めている連携は対象にしない', async () => {
    const testDb = createTestD1();
    seed(testDb);
    addPlatform(testDb, 'p-off', 'meta', {
      ad_account_id: 'act_123', access_token: 'token-1234567890',
    }, 0);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await importAdCosts(testDb.db, { day: '2026-09-20' });
    expect(result.processed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
