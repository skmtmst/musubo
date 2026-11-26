import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { getLineAccountById } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { QA_STAGING_DATABASE } from '../services/staging-qa-safety.js';
import { SCHEDULED_CRONS, STAGING_LINE_TOKEN_REFRESH_CRON } from '../services/scheduled-job-isolation.js';
import { scheduled } from './scheduled.js';
import * as tokenRefresh from '../services/token-refresh.js';

const heldSweep = vi.hoisted(() => vi.fn(async () => ({ checked: 0, deleted: 0, failed: 0 })));
vi.mock('../services/restaurant-media-email-import.js', async original => ({
  ...await original<Record<string, unknown>>(), expireHeldReservationEmails: heldSweep,
}));

const staging = {
  DEPLOY_ENV: 'staging',
  WORKER_NAME: 'nen-line-stg',
  D1_DATABASE_ID: QA_STAGING_DATABASE,
  WORKER_PUBLIC_URL: 'https://stg-api.musubo.jp',
  LINE_CREDENTIAL_ENCRYPTION_KEY: 'A'.repeat(43),
} as const;

function tick(cron: string, bindings: Partial<Env['Bindings']>) {
  return scheduled(
    { cron, scheduledTime: Date.now() } as ScheduledEvent,
    bindings as Env['Bindings'],
    {} as ExecutionContext,
  );
}

describe('staging LINE token renewal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    heldSweep.mockClear();
    vi.restoreAllMocks();
  });

  it('検証環境の実際の5分tickで保留メールの期限を掃除し、環境や機能が一致しなければ動かさない', async () => {
    const { db, raw } = createTestD1();
    try {
      await tick(STAGING_LINE_TOKEN_REFRESH_CRON, { ...staging, DB: db, RESTAURANT_TEST_ENABLED: 'true' });
      expect(heldSweep).toHaveBeenCalledOnce();
      expect(heldSweep).toHaveBeenCalledWith(expect.objectContaining({ DB: db }), expect.objectContaining({ maxPerRun: 200, now: expect.any(Date) }));
      heldSweep.mockClear();
      await tick(STAGING_LINE_TOKEN_REFRESH_CRON, { ...staging, DB: db, RESTAURANT_TEST_ENABLED: 'false' });
      await tick(STAGING_LINE_TOKEN_REFRESH_CRON, { ...staging, DB: db, RESTAURANT_TEST_ENABLED: 'true', D1_DATABASE_ID: 'incorrect-db' });
      await tick(STAGING_LINE_TOKEN_REFRESH_CRON, { ...staging, DB: db, RESTAURANT_TEST_ENABLED: 'true', DEPLOY_ENV: 'production' });
      expect(heldSweep).not.toHaveBeenCalled();
    } finally { raw.close(); }
  });

  it('トークン更新が失敗しても保留メールを掃除し、更新失敗を隠さない', async () => {
    const { db, raw } = createTestD1();
    try {
      vi.spyOn(tokenRefresh, 'refreshLineAccessTokens').mockRejectedValueOnce(new Error('token refresh failed'));
      await expect(tick(STAGING_LINE_TOKEN_REFRESH_CRON, { ...staging, DB: db, RESTAURANT_TEST_ENABLED: 'true' })).rejects.toThrow('token refresh failed');
      expect(heldSweep).toHaveBeenCalledOnce();
    } finally { raw.close(); }
  });

  it('registers exactly the token renewal tick in the deployed staging configuration', async () => {
    const { unstable_readConfig } = await import('wrangler');
    const config = unstable_readConfig({ config: fileURLToPath(new URL('../../wrangler.staging.toml', import.meta.url)) });
    expect(config.triggers?.crons).toEqual([STAGING_LINE_TOKEN_REFRESH_CRON]);
  });

  it('renews an expired token from stored credentials and skips fresh and inactive accounts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-22T02:00:00Z'));
    const { db, raw } = createTestD1();
    const insert = raw.prepare(`INSERT INTO line_accounts (id, name, channel_id, channel_secret,
      channel_access_token, token_expires_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insert.run('expired', 'Expired', '1001', 'test-secret', 'expired-token', '2026-11-21T00:00:00Z', 1);
    insert.run('fresh', 'Fresh', '1002', 'test-secret', 'fresh-token', '2026-12-22T00:00:00Z', 1);
    insert.run('inactive', 'Inactive', '1003', 'test-secret', 'inactive-token', '2026-11-21T00:00:00Z', 0);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.line.me/v2/oauth/accessToken');
      expect(new URLSearchParams(init?.body as URLSearchParams).get('client_id')).toBe('1001');
      return Response.json({ access_token: 'renewed-token', expires_in: 30 * 86_400, token_type: 'Bearer' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await tick(STAGING_LINE_TOKEN_REFRESH_CRON, { ...staging, DB: db });
    await tick(STAGING_LINE_TOKEN_REFRESH_CRON, { ...staging, DB: db });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const updated = await getLineAccountById(db, 'expired', staging.LINE_CREDENTIAL_ENCRYPTION_KEY);
    expect(updated).toMatchObject({
      channel_access_token: 'renewed-token',
      token_expires_at: '2026-12-22T11:00:00.000+09:00',
    });
    expect(updated?.channel_access_token_encrypted).toMatch(/^v1\./);
    expect(updated?.channel_access_token_encrypted).not.toContain('renewed-token');
  });

  it('ignores delivery in staging and renewal in a mismatched environment', async () => {
    const db = { prepare: vi.fn(() => { throw new Error('no database access expected'); }) } as unknown as D1Database;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await tick(SCHEDULED_CRONS.delivery, { ...staging, DB: db });
    await tick(STAGING_LINE_TOKEN_REFRESH_CRON, { ...staging, DB: db, D1_DATABASE_ID: 'incorrect-db' });
    await tick(STAGING_LINE_TOKEN_REFRESH_CRON, { ...staging, DB: db, DEPLOY_ENV: 'production' });
    await tick(SCHEDULED_CRONS.delivery, { ...staging, DB: db, DEPLOY_ENV: 'production' });
    expect(db.prepare).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not overwrite credentials changed while LINE is issuing a token', async () => {
    const { db, raw } = createTestD1();
    raw.prepare(`INSERT INTO line_accounts (id, name, channel_id, channel_secret, channel_access_token)
      VALUES ('account', 'Test', '1001', 'prior-secret', 'prior-token')`).run();
    const fetchMock = vi.fn(async () => {
      raw.prepare(`UPDATE line_accounts SET channel_secret = 'replacement-secret',
        channel_access_token = 'replacement-token' WHERE id = 'account'`).run();
      return Response.json({ access_token: 'late-token', expires_in: 30 * 86_400, token_type: 'Bearer' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await tick(STAGING_LINE_TOKEN_REFRESH_CRON, { ...staging, DB: db });

    expect(fetchMock).toHaveBeenCalledOnce();
    const current = await getLineAccountById(db, 'account', staging.LINE_CREDENTIAL_ENCRYPTION_KEY);
    expect(current?.channel_access_token).toBe('replacement-token');
  });
});
