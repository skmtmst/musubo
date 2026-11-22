import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestD1 } from '../test-utils/d1-sqlite.js';

// 取り替えた鍵は暗号化して保存する。試験用の全ゼロの鍵（本物ではない）。
vi.mock('cloudflare:workers', () => ({ env: { LINE_CREDENTIAL_ENCRYPTION_KEY: 'A'.repeat(43) } }));

const DAY = 24 * 60 * 60_000;
const START = Date.parse('2026-09-01T00:00:00.000Z');

let testDb: ReturnType<typeof createTestD1>;

beforeEach(() => {
  testDb = createTestD1();
  testDb.raw.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, token_expires_at, line_profile_synced_at)
     VALUES ('account-1', 'channel-1', 'LINE 1', 'old-token-value', 'channel-secret-value', ?, ?)`,
  ).run(new Date(START + 30 * DAY).toISOString(), new Date(START + 365 * DAY).toISOString());
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function credentialStatusAt(now: number) {
  const { runOperationHealthChecks } = await import('./operations-health.js');
  const checked = await runOperationHealthChecks(testDb.db, {
    lineAccountId: 'account-1', source: 'manual', now: new Date(now).toISOString(),
  });
  return checked.run.results.find((r) => r.checkKey === 'credential_expiry');
}

describe('鍵の期限の稼働確認', () => {
  it('正常に自動交換される間は14日前の予告で運用の注意を鳴らさない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ type: 'unlimited' })));
    const warnings: number[] = [];
    for (let day = 0; day < 60; day += 1) {
      const now = START + day * DAY + 60_000;
      const row = testDb.raw.prepare('SELECT token_expires_at FROM line_accounts WHERE id = ?')
        .get('account-1') as { token_expires_at: string };
      // 取り替えの処理と同じ「残り7日未満なら新しい30日の鍵」を、1日1回に縮めて回す。
      if (Date.parse(row.token_expires_at) - now < 7 * DAY) {
        testDb.raw.prepare('UPDATE line_accounts SET token_expires_at = ? WHERE id = ?')
          .run(new Date(now + 30 * DAY).toISOString(), 'account-1');
      }
      const check = await credentialStatusAt(now);
      if (check?.status !== 'normal') warnings.push(day);
    }
    expect(warnings).toEqual([]);
  }, 30_000);

  it('期限の14日前の注意を、自動で取り替える7日前の窓と混ぜない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ type: 'unlimited' })));
    testDb.raw.prepare('UPDATE line_accounts SET token_expires_at = ? WHERE id = ?')
      .run(new Date(START + 10 * DAY + 60_000).toISOString(), 'account-1');
    expect(await credentialStatusAt(START)).toMatchObject({ status: 'normal', value: { daysLeft: 10 } });
    testDb.raw.prepare('UPDATE line_accounts SET token_expires_at = ? WHERE id = ?')
      .run(new Date(START + 5 * DAY + 20 * 60_000).toISOString(), 'account-1');
    expect(await credentialStatusAt(START + 10 * 60_000)).toMatchObject({ status: 'warning', value: { daysLeft: 5, refreshFailed: false } });
  });
});

type NoticeRow = { event_type: string; title: string; body: string; category: string; channel: string; metadata: string; line_account_id: string };

function notices(): NoticeRow[] {
  return testDb.raw.prepare(
    "SELECT event_type, title, body, category, channel, metadata, line_account_id FROM notifications WHERE event_type LIKE 'line_token_%' ORDER BY json_extract(metadata, '$.failedAt'), event_type",
  ).all() as NoticeRow[];
}

function setExpiry(value: string | null, id = 'account-1') {
  testDb.raw.prepare('UPDATE line_accounts SET token_expires_at = ? WHERE id = ?').run(value, id);
}

function lineIssues(...statuses: number[]) {
  const fetchMock = vi.fn(async () => {
    const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
    return status === 200
      ? Response.json({ access_token: 'new-token-value', expires_in: 30 * 24 * 60 * 60, token_type: 'Bearer' })
      : new Response('{"error":"invalid_client","error_description":"channel-secret-value"}', { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function refreshAt(now: number) {
  vi.setSystemTime(new Date(now));
  const { refreshLineAccessTokens } = await import('./token-refresh.js');
  await refreshLineAccessTokens(testDb.db);
}

describe('鍵の期限の知らせ', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  it('期限まで8日なら取り替えずに知らせも書かない。6日で取り替えに成功しても書かない', async () => {
    const fetchMock = lineIssues(200);
    setExpiry(new Date(START + 8 * DAY).toISOString());
    await refreshAt(START);
    expect(fetchMock).not.toHaveBeenCalled();

    setExpiry(new Date(START + 6 * DAY).toISOString());
    await refreshAt(START);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notices()).toEqual([]);
  });

  it('期限まで6日で一時的な失敗なら1件だけ書き、次の cron で同じ失敗でも増えない', async () => {
    lineIssues(503);
    setExpiry(new Date(START + 6 * DAY + 60_000).toISOString());
    await refreshAt(START);
    await refreshAt(START + 5 * 60_000);
    await refreshAt(START + DAY / 2);

    const rows = notices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: 'line_token_expiring',
      title: 'LINE接続の自動更新を再試行しています',
      body: '接続状況はLINEアカウントの詳細で確認できます。',
      category: 'error',
      channel: 'dashboard',
      line_account_id: 'account-1',
    });
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ reason: 'temporary', daysLeft: 6 });

    // 稼働確認も、取り替えの失敗が残っている間は注意にする。
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ type: 'unlimited' })));
    const check = await credentialStatusAt(START + DAY / 2 + 60_000);
    expect(check).toMatchObject({ status: 'warning', value: { refreshFailed: true } });
  });

  it('チャネルの情報が違って断られたら、期限が分からなくてもすぐ1件、直し方つきで書く', async () => {
    lineIssues(401);
    setExpiry(null);
    await refreshAt(START);
    await refreshAt(START + 5 * 60_000);

    const rows = notices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_type: 'line_token_refresh_failed', category: 'error' });
    expect(rows[0].body).toContain('チャネルシークレットを確かめ');
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ reason: 'credentials', expiresAt: null, daysLeft: null });
  });

  it('期限が残り6日でもチャネルの情報の失敗は「取り替えられない」で書く', async () => {
    lineIssues(400);
    setExpiry(new Date(START + 6 * DAY).toISOString());
    await refreshAt(START);
    expect(notices().map((row) => row.event_type)).toEqual(['line_token_refresh_failed']);
  });

  it('取り替えに成功して期限が延びたら新しくは書かず、次の周期で同じ失敗ならまた1件', async () => {
    const fetchMock = lineIssues(503, 200, 503);
    setExpiry(new Date(START + 6 * DAY).toISOString());
    await refreshAt(START);
    await refreshAt(START + 5 * 60_000);
    expect(notices()).toHaveLength(1);
    const renewed = testDb.raw.prepare('SELECT token_expires_at, channel_access_token FROM line_accounts WHERE id = ?')
      .get('account-1') as { token_expires_at: string; channel_access_token: string };
    expect(renewed.channel_access_token).toBe('new-token-value');

    // 新しい鍵の間（残り7日以上）は取り替えず、前の知らせは消さずに残す。
    await refreshAt(START + 10 * 60_000);
    expect(notices()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await refreshAt(Date.parse(renewed.token_expires_at) - 6 * DAY);
    await refreshAt(Date.parse(renewed.token_expires_at) - 6 * DAY + 5 * 60_000);
    const rows = notices();
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1].metadata)).toMatchObject({ expiresAt: renewed.token_expires_at });
  });

  it('期限の無い鍵には「あと何日」を作らない', async () => {
    lineIssues(503);
    setExpiry(null);
    await refreshAt(START);
    expect(notices()).toEqual([]);
  });

  it('期限が切れて取り替えも失敗したら「切れています」を1件', async () => {
    lineIssues(503);
    setExpiry(new Date(START - 60_000).toISOString());
    await refreshAt(START);
    await refreshAt(START + 5 * 60_000);
    const rows = notices();
    expect(rows.map((row) => row.event_type)).toEqual(['line_token_expired']);
    expect(rows[0].body).toBe('接続状況はLINEアカウントの詳細で確認できます。');
  });

  it('期限が残り6日で失敗のまま切れたら、注意と切れたの2段で1件ずつ', async () => {
    lineIssues(503);
    setExpiry(new Date(START + 6 * DAY).toISOString());
    for (let tick = 0; tick < 7 * 24; tick += 1) await refreshAt(START + tick * 60 * 60_000);
    expect(notices().map((row) => row.event_type)).toEqual(['line_token_expiring', 'line_token_expired']);
  });

  it('停止中のアカウントには取り替えも知らせもしない', async () => {
    const fetchMock = lineIssues(401);
    setExpiry(new Date(START - DAY).toISOString());
    testDb.raw.prepare('UPDATE line_accounts SET is_active = 0 WHERE id = ?').run('account-1');
    await refreshAt(START);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
  });

  it('知らせの本文と記録に鍵の値・チャネルシークレット・LINE の応答本文を入れない', async () => {
    lineIssues(401);
    setExpiry(new Date(START - 60_000).toISOString());
    await refreshAt(START);
    setExpiry(new Date(START + 3 * DAY).toISOString());
    await refreshAt(START);
    lineIssues(503);
    setExpiry(new Date(START + 4 * DAY).toISOString());
    await refreshAt(START);

    const rows = notices();
    expect(rows.map((row) => row.event_type).sort()).toEqual(['line_token_expired', 'line_token_expiring', 'line_token_refresh_failed']);
    const written = JSON.stringify(rows);
    for (const secret of ['old-token-value', 'new-token-value', 'channel-secret-value', 'invalid_client']) {
      expect(written).not.toContain(secret);
    }
  });

  it('書いた知らせはそのアカウントの通知の口に「システム」として出て、ほかのアカウントには出ない', async () => {
    testDb.raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, line_profile_synced_at)
       VALUES ('account-2', 'channel-2', 'LINE 2', 'other-token', 'other-secret', ?)`,
    ).run(new Date(START + 365 * DAY).toISOString());
    lineIssues(503);
    setExpiry(new Date(START + 2 * DAY).toISOString());
    await refreshAt(START);

    const { getNotificationCenter } = await import('@line-crm/db');
    const { isSystemNotification } = await import('@line-crm/shared');
    const mine = await getNotificationCenter(testDb.db, { lineAccountId: 'account-1', staffId: 'staff-1', category: 'error' });
    expect(mine.map((row) => row.event_type)).toEqual(['line_token_expiring']);
    expect(isSystemNotification({ category: mine[0].category, eventType: mine[0].event_type })).toBe(true);
    const other = await getNotificationCenter(testDb.db, { lineAccountId: 'account-2', staffId: 'staff-1' });
    expect(other).toEqual([]);
  });
});

 it.each([14,10,7])('期限まで%s日なら画面の予告だけで運用の注意を鳴らさない',async(days)=>{
   vi.stubGlobal('fetch',vi.fn(async()=>Response.json({type:'unlimited'})))
   testDb.raw.prepare('UPDATE line_accounts SET token_expires_at=? WHERE id=?').run(new Date(START+days*DAY).toISOString(),'account-1')
   expect(await credentialStatusAt(START)).toMatchObject({status:'normal'})
 })
 it('7日を切った未交換と、期限不明でも判明した交換失敗は注意にする',async()=>{
   vi.stubGlobal('fetch',vi.fn(async()=>Response.json({type:'unlimited'})))
   testDb.raw.prepare('UPDATE line_accounts SET token_expires_at=? WHERE id=?').run(new Date(START+7*DAY-1).toISOString(),'account-1')
   expect(await credentialStatusAt(START)).toMatchObject({status:'warning',value:{refreshFailed:false}})
   testDb.raw.prepare('UPDATE line_accounts SET token_expires_at=NULL WHERE id=?').run('account-1')
   const {recordLineTokenRefreshFailure}=await import('./line-token-notices.js')
   await recordLineTokenRefreshFailure(testDb.db,{id:'account-1',token_expires_at:null},'credentials',START+10*60_000)
   expect(await credentialStatusAt(START+10*60_000)).toMatchObject({status:'warning',value:{daysLeft:null,refreshFailed:true}})
 })
