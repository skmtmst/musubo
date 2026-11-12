import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptCredential, setAccountSetting } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import {
  acquireSyncRun,
  parseSpreadsheetId,
  sheetsOauthClient,
  processDueGoogleSheetsSyncs,
  syncGoogleSheetsIntegration,
  syncOneDataType,
  type GoogleSheetsIntegrationRow,
} from './google-sheets.js';

const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SPREADSHEET_ID = 'sheet-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = '2026-09-27T06:00:00Z';

/** Google側のメモリ上のスプレッドシート。タブ名 → 行（配列）の表。 */
interface FakeSheet {
  tabs: Map<string, (string | null)[][]>;
}

function makeGoogleFetch(sheet: FakeSheet, opts?: {
  tokenFails?: 'invalid_grant';
}) {
  const calls: Array<{ url: string; method: string }> = [];
  /** authorizedJson の再試行も抜ける失敗を入れたいとき true にする。 */
  const flags = { failAppend: false, failBatchUpdate: false, appendWritesThenFails: false };
  return {
    calls,
    flags,
    fetch: async (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

      if (url === 'https://oauth2.googleapis.com/token') {
        if (opts?.tokenFails === 'invalid_grant') {
          return json({ error: 'invalid_grant' }, 400);
        }
        return json({ access_token: 'at-1', expires_in: 3600 });
      }
      const u = new URL(url);
      const batchUpdate = u.pathname.endsWith(':batchUpdate');
      const valuesAppend = /\/values\/.+:append$/.test(u.pathname);
      const valuesPath = /\/values\/(.+)$/.exec(u.pathname);

      if (batchUpdate) {
        if (flags.failBatchUpdate) return json({ error: { message: 'backend' } }, 500);
        const body = JSON.parse(String(init?.body)) as {
          requests?: Array<{ addSheet?: { properties?: { title?: string } } }>;
          data?: Array<{ range: string; values: (string | null)[][] }>;
        };
        if (body.requests) {
          for (const req of body.requests) {
            const title = req.addSheet?.properties?.title;
            if (title && !sheet.tabs.has(title)) sheet.tabs.set(title, []);
          }
          return json({});
        }
        for (const entry of body.data ?? []) {
          const m = /^'(.+)'!A(\d+)$/.exec(entry.range);
          if (!m) return json({ error: { message: 'bad range' } }, 400);
          const tab = sheet.tabs.get(m[1]!) ?? [];
          const rowIndex = Number(m[2]) - 1;
          while (tab.length <= rowIndex) tab.push([]);
          tab[rowIndex] = entry.values[0] ?? [];
          sheet.tabs.set(m[1]!, tab);
        }
        return json({});
      }
      if (valuesAppend) {
        if (flags.failAppend) return json({ error: { message: 'backend' } }, 500);
        const title = decodeURIComponent(/\/values\/'(.+)'!/.exec(u.pathname)?.[1] ?? '');
        const body = JSON.parse(String(init?.body)) as { values: (string | null)[][] };
        const tab = sheet.tabs.get(title) ?? [];
        tab.push(...body.values);
        sheet.tabs.set(title, tab);
        // 実際には書けたのに応答だけ落ちた、を再現する。
        if (flags.appendWritesThenFails) return json({ error: { message: 'lost response' } }, 500);
        return json({});
      }
      if (valuesPath) {
        const range = decodeURIComponent(valuesPath[1] ?? '');
        const m = /^'(.+)'!A(\d+)(?::A(\d+|))?$/.exec(range)
          ?? /^'(.+)'!A(\d+):Z(\d+)$/.exec(range);
        if (!m) return json({ values: [] });
        const tab = sheet.tabs.get(m[1]!) ?? [];
        const start = Number(m[2]);
        const end = m[3] ? Number(m[3]) : tab.length;
        const values = tab.slice(start - 1, end === 0 ? undefined : end);
        return json({ values });
      }
      if (/^\/v4\/spreadsheets\/[^/]+$/.test(u.pathname)) {
        if (u.searchParams.get('fields') === 'properties.title') {
          return json({ properties: { title: 'テスト用スプレッドシート' } });
        }
        return json({ sheets: [...sheet.tabs.keys()].map((title) => ({ properties: { title } })) });
      }
      return json({ error: { message: `unhandled ${method} ${url}` } }, 400);
    },
  };
}

function seed(testDb: SqliteD1): void {
  testDb.raw.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active)
    VALUES ('acc-1', 'ch-1', 'A1', 'tok', 'sec', 1);
    INSERT INTO friends (id, line_user_id, line_account_id, display_name, real_name, system_display_name, is_following, metadata, created_at, updated_at)
    VALUES
      ('f1', 'U001', 'acc-1', '一郎', '山田一郎', '山田さん', 1, '{}', '2026-01-01T00:00:00Z', '2026-09-01T00:00:00Z'),
      ('f2', 'U002', 'acc-1', '二郎', NULL, NULL, 0, '{}', '2026-01-02T00:00:00Z', '2026-09-02T00:00:00Z'),
      ('f3', 'U003', 'acc-1', '三郎', NULL, NULL, 1, '{}', '2026-01-03T00:00:00Z', '2026-09-03T00:00:00Z');
    INSERT INTO forms (id, name, fields, is_active, created_at, updated_at)
    VALUES ('form-1', 'アンケート', '[]', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO form_accounts (form_id, line_account_id) VALUES ('form-1', 'acc-1');
    INSERT INTO form_submissions (id, form_id, friend_id, data, created_at)
    VALUES
      ('sub-1', 'form-1', 'f1', '{"q1":"はい"}', '2026-09-10T00:00:00Z'),
      ('sub-2', 'form-1', 'f2', '{"q1":"いいえ"}', '2026-09-11T00:00:00Z');
  `);
}

async function makeIntegration(testDb: SqliteD1): Promise<GoogleSheetsIntegrationRow> {
  const enc = await encryptCredential('refresh-token-1', ENCRYPTION_KEY);
  testDb.raw.prepare(
    `INSERT INTO google_sheets_integrations
       (id, line_account_id, tenant_id, google_account_email, refresh_token_enc, status,
        spreadsheet_id, spreadsheet_title, connected_by_staff_id, connected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('int-1', 'acc-1', 'tenant-1', 'owner@example.com', enc, 'connected', SPREADSHEET_ID, 'テスト用', 'staff-1', NOW);
  return (await testDb.db.prepare('SELECT * FROM google_sheets_integrations WHERE id = ?')
    .bind('int-1').first<GoogleSheetsIntegrationRow>())!;
}

function envFor(testDb: SqliteD1): Env['Bindings'] {
  return {
    DB: testDb.db,
    LINE_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY,
    GOOGLE_SHEETS_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: 'client-secret',
  } as Env['Bindings'];
}

const sleep = async () => {};

describe('parseSpreadsheetId', () => {
  it('URLとIDの両方を受け取る', () => {
    expect(parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit#gid=0`)).toBe(SPREADSHEET_ID);
    expect(parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`)).toBe(SPREADSHEET_ID);
    expect(parseSpreadsheetId(SPREADSHEET_ID)).toBe(SPREADSHEET_ID);
  });
  it('変な値は弾く', () => {
    expect(parseSpreadsheetId('')).toBeNull();
    expect(parseSpreadsheetId('https://evil.example.com/x')).toBeNull();
    expect(parseSpreadsheetId('abc')).toBeNull();
    expect(parseSpreadsheetId('https://docs.google.com/spreadsheets/d/')).toBeNull();
  });
});

describe('sheetsOauthClient', () => {
  const REDIRECT = 'https://example.workers.dev/api/integrations/google-sheets/oauth/callback';
  type OauthEnv = Parameters<typeof sheetsOauthClient>[0];

  it('Sheets専用の設定がある環境ではそちらを使う', () => {
    const env = {
      GOOGLE_SHEETS_OAUTH_CLIENT_ID: 'sheets-id',
      GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: 'sheets-secret',
      GOOGLE_BUSINESS_OAUTH_CLIENT_ID: 'business-id',
      GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET: 'business-secret',
    } satisfies OauthEnv;
    expect(sheetsOauthClient(env, REDIRECT)).toEqual({
      clientId: 'sheets-id',
      clientSecret: 'sheets-secret',
      redirectUri: REDIRECT,
    });
  });

  it('Sheets専用が無ければGoogleビジネスの既存クライアントを共用する', () => {
    const env = {
      GOOGLE_BUSINESS_OAUTH_CLIENT_ID: 'business-id',
      GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET: 'business-secret',
    } satisfies OauthEnv;
    expect(sheetsOauthClient(env, REDIRECT)).toEqual({
      clientId: 'business-id',
      clientSecret: 'business-secret',
      redirectUri: REDIRECT,
    });
  });

  it('IDとシークレットを別クライアント間で混ぜない', () => {
    // Sheets側がIDだけの半端な設定。ここでビジネス側のシークレットと組むと必ず認可に失敗する。
    const env = {
      GOOGLE_SHEETS_OAUTH_CLIENT_ID: 'sheets-id',
      GOOGLE_BUSINESS_OAUTH_CLIENT_ID: 'business-id',
      GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET: 'business-secret',
    } satisfies OauthEnv;
    expect(sheetsOauthClient(env, REDIRECT)).toEqual({
      clientId: 'business-id',
      clientSecret: 'business-secret',
      redirectUri: REDIRECT,
    });
  });

  it('どちらの組も揃っていなければ null', () => {
    expect(sheetsOauthClient({} satisfies OauthEnv, REDIRECT)).toBeNull();
    expect(
      sheetsOauthClient({ GOOGLE_BUSINESS_OAUTH_CLIENT_ID: 'business-id' } satisfies OauthEnv, REDIRECT),
    ).toBeNull();
    expect(
      sheetsOauthClient(
        { GOOGLE_SHEETS_OAUTH_CLIENT_ID: '  ', GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: '  ' } satisfies OauthEnv,
        REDIRECT,
      ),
    ).toBeNull();
  });
});

describe('syncGoogleSheetsIntegration', () => {
  let testDb: SqliteD1;
  beforeEach(() => {
    testDb = createTestD1();
    seed(testDb);
  });

  it('初回は全件バックフィルしてタブとヘッダを作る', async () => {
    const integration = await makeIntegration(testDb);
    const sheet: FakeSheet = { tabs: new Map() };
    const { fetch } = makeGoogleFetch(sheet);
    const results = await syncGoogleSheetsIntegration(envFor(testDb), integration, {
      kind: 'manual', now: NOW, fetch: fetch as never, sleep,
    });
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok']);
    const friends = sheet.tabs.get('友だち')!;
    expect(friends[0]).toEqual(['LINEユーザーID', 'LINE表示名', '本名', 'システム表示名', 'フォロー状態', '登録日', '更新日']);
    expect(friends.length).toBe(4); // 見出し行とデータ3行。
    expect(friends[1]![0]).toBe('U001');
    const answers = sheet.tabs.get('回答')!;
    expect(answers.length).toBe(3); // 見出し行とデータ2行。
    const runs = await testDb.db.prepare(
      'SELECT status, rows_written FROM google_sheets_sync_runs ORDER BY data_type',
    ).all<{ status: string; rows_written: number }>();
    expect(runs.results).toEqual([
      { status: 'ok', rows_written: 2 },
      { status: 'ok', rows_written: 3 },
    ]);
    const saved = await testDb.db.prepare(
      'SELECT last_sync_status, consecutive_failures FROM google_sheets_integrations WHERE id = ?',
    ).bind('int-1').first<{ last_sync_status: string; consecutive_failures: number }>();
    expect(saved?.last_sync_status).toBe('ok');
    expect(saved?.consecutive_failures).toBe(0);
  });

  it('増分同期は変更行だけ書き、既存行は上書き（行が増えない）', async () => {
    const integration = await makeIntegration(testDb);
    const sheet: FakeSheet = { tabs: new Map() };
    const { fetch } = makeGoogleFetch(sheet);
    const env = envFor(testDb);
    await syncGoogleSheetsIntegration(env, integration, { kind: 'manual', now: NOW, fetch: fetch as never, sleep });

    // 既存行の更新 + 新規1件
    testDb.raw.prepare(
      `UPDATE friends SET display_name = '一郎改', updated_at = '2026-09-20T00:00:00Z' WHERE id = 'f1'`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO friends (id, line_user_id, line_account_id, display_name, is_following, metadata, created_at, updated_at)
       VALUES ('f4', 'U004', 'acc-1', '四郎', 1, '{}', '2026-01-04T00:00:00Z', '2026-09-21T00:00:00Z')`,
    ).run();
    const results = await syncGoogleSheetsIntegration(env, integration, {
      kind: 'manual', now: '2026-09-27T07:00:00Z', fetch: fetch as never, sleep,
    });
    expect(results[0]?.status).toBe('ok');
    const friends = sheet.tabs.get('友だち')!;
    expect(friends.length).toBe(5); // 重複行が増えない
    expect(friends.find((row) => row[0] === 'U001')?.[1]).toBe('一郎改');
    expect(friends.find((row) => row[0] === 'U004')).toBeTruthy();
  });

  it('書き込み途中で失敗してもカーソルを残し、次回は続きから再開する', async () => {
    const integration = await makeIntegration(testDb);
    const sheet: FakeSheet = { tabs: new Map() };
    const google = makeGoogleFetch(sheet);
    google.flags.failAppend = true;
    const env = envFor(testDb);
    const first = await syncOneDataType(env, integration, 'form_answers', {
      kind: 'manual', now: NOW, fetch: google.fetch as never, sleep,
    });
    // 回答タブのappendで落ちる → 行は書けず error（友人タブは動かしていない）
    expect(first.status).toBe('error');
    expect(sheet.tabs.get('回答')?.length ?? 0).toBeLessThanOrEqual(1);

    google.flags.failAppend = false;
    const second = await syncOneDataType(env, integration, 'form_answers', {
      kind: 'manual', now: NOW, fetch: google.fetch as never, sleep,
    });
    expect(second.status).toBe('ok');
    expect(sheet.tabs.get('回答')!.length).toBe(3); // 重複なく全部入る
  });

  it('refresh_token が失効したら連携を要再接続（expired）にする', async () => {
    const integration = await makeIntegration(testDb);
    const sheet: FakeSheet = { tabs: new Map() };
    const { fetch } = makeGoogleFetch(sheet, { tokenFails: 'invalid_grant' });
    const results = await syncGoogleSheetsIntegration(envFor(testDb), integration, {
      kind: 'manual', now: NOW, fetch: fetch as never, sleep,
    });
    expect(results[0]?.status).toBe('error');
    expect(results.length).toBe(1); // 落ちたら残りの種別は試さない
    const saved = await testDb.db.prepare(
      'SELECT status FROM google_sheets_integrations WHERE id = ?',
    ).bind('int-1').first<{ status: string }>();
    expect(saved?.status).toBe('expired');
  });

  it('running の同期がある間は新しい同期を始めない', async () => {
    const integration = await makeIntegration(testDb);
    testDb.raw.prepare(
      `INSERT INTO google_sheets_sync_runs (id, integration_id, kind, data_type, status, started_at)
       VALUES ('run-x', 'int-1', 'scheduled', 'friends', 'running', ?)`,
    ).run(NOW);
    const sheet: FakeSheet = { tabs: new Map() };
    const { fetch } = makeGoogleFetch(sheet);
    const result = await syncOneDataType(envFor(testDb), integration, 'friends', {
      kind: 'manual', now: '2026-09-27T06:05:00Z', fetch: fetch as never, sleep,
    });
    expect(result.status).toBe('already_running');
  });

  it('30分動いていない running は畳んで新しい同期を始める', async () => {
    const integration = await makeIntegration(testDb);
    testDb.raw.prepare(
      `INSERT INTO google_sheets_sync_runs (id, integration_id, kind, data_type, status, started_at)
       VALUES ('run-old', 'int-1', 'scheduled', 'friends', 'running', '2026-09-27T05:00:00Z')`,
    ).run();
    const sheet: FakeSheet = { tabs: new Map() };
    const { fetch } = makeGoogleFetch(sheet);
    const result = await syncOneDataType(envFor(testDb), integration, 'friends', {
      kind: 'manual', now: '2026-09-27T06:00:00Z', fetch: fetch as never, sleep,
    });
    expect(result.status).toBe('ok');
    const stale = await testDb.db.prepare(
      'SELECT status FROM google_sheets_sync_runs WHERE id = ?',
    ).bind('run-old').first<{ status: string }>();
    expect(stale?.status).toBe('error');
  });

  it('append への書き込みは自動再送しない（R439）', async () => {
    const integration = await makeIntegration(testDb);
    const sheet: FakeSheet = { tabs: new Map() };
    const google = makeGoogleFetch(sheet);
    google.flags.failAppend = true;
    const result = await syncOneDataType(envFor(testDb), integration, 'friends', {
      kind: 'manual', now: NOW, fetch: google.fetch as never, sleep,
    });
    expect(result.status).toBe('error');
    // 再送されると同じ行が二度並び得るので、1回だけ試して失敗で止める
    expect(google.calls.filter((c) => c.url.includes(':append')).length).toBe(1);
  });

  it('append が保存後に応答を落としても、次の同期で行が重ならない（R439）', async () => {
    const integration = await makeIntegration(testDb);
    const sheet: FakeSheet = { tabs: new Map() };
    const google = makeGoogleFetch(sheet);
    const env = envFor(testDb);
    google.flags.appendWritesThenFails = true;
    const first = await syncOneDataType(env, integration, 'friends', {
      kind: 'manual', now: NOW, fetch: google.fetch as never, sleep,
    });
    expect(first.status).toBe('error');
    // シート側には実は書けている
    expect(sheet.tabs.get('友だち')!.length).toBeGreaterThan(1);

    google.flags.appendWritesThenFails = false;
    const second = await syncOneDataType(env, integration, 'friends', {
      kind: 'manual', now: '2026-09-27T07:00:00Z', fetch: google.fetch as never, sleep,
    });
    expect(second.status).toBe('ok');
    const keys = sheet.tabs.get('友だち')!.slice(1).map((row) => row[0]);
    // 既に書けた行は上書きへ回るので、同じキーの行は1行だけ
    expect(keys.length).toBe(3);
    expect(new Set(keys).size).toBe(3);
  });

  it('同時に実行権を取りに来た場合は先に記録した方だけが実行する（R438）', async () => {
    await makeIntegration(testDb);
    const first = await acquireSyncRun(testDb.db, 'int-1', 'friends', {
      kind: 'manual', now: NOW, spreadsheetId: SPREADSHEET_ID,
    });
    const second = await acquireSyncRun(testDb.db, 'int-1', 'friends', {
      kind: 'manual', now: NOW, spreadsheetId: SPREADSHEET_ID,
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    // 負けた側の「実行中」の記録は履歴に残さない
    const running = await testDb.db.prepare(
      `SELECT id, spreadsheet_id FROM google_sheets_sync_runs WHERE status = 'running'`,
    ).all<{ id: string; spreadsheet_id: string | null }>();
    expect(running.results.length).toBe(1);
    // 履歴には書き出し先が残る
    expect(running.results[0]?.spreadsheet_id).toBe(SPREADSHEET_ID);
  });

  it('出力先を変えた直後の同期は、新しいシートへ全件書き出す（R437）', async () => {
    const integration = await makeIntegration(testDb);
    const env = envFor(testDb);
    const sheetA: FakeSheet = { tabs: new Map() };
    await syncGoogleSheetsIntegration(env, integration, {
      kind: 'manual', now: NOW, fetch: makeGoogleFetch(sheetA).fetch as never, sleep,
    });
    expect(sheetA.tabs.get('友だち')!.length).toBe(4);

    // 出力先を切り替える
    const SHEET_B = 'sheet-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    testDb.raw.prepare('UPDATE google_sheets_integrations SET spreadsheet_id = ? WHERE id = ?')
      .run(SHEET_B, 'int-1');
    const moved = (await testDb.db.prepare('SELECT * FROM google_sheets_integrations WHERE id = ?')
      .bind('int-1').first<GoogleSheetsIntegrationRow>())!;

    const sheetB: FakeSheet = { tabs: new Map() };
    const results = await syncGoogleSheetsIntegration(env, moved, {
      kind: 'manual', now: '2026-09-27T07:00:00Z', fetch: makeGoogleFetch(sheetB).fetch as never, sleep,
    });
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok']);
    // 新しいシートには既存データが全部入る（途中の続きから再開しない）
    expect(sheetB.tabs.get('友だち')!.length).toBe(4);
    expect(sheetB.tabs.get('回答')!.length).toBe(3);
    // 再開点は出力先ごとに持つので、Aへ戻したときの続きも残る
    const cursorJson = (await testDb.db.prepare(
      'SELECT sync_cursor_json FROM google_sheets_integrations WHERE id = ?',
    ).bind('int-1').first<{ sync_cursor_json: string }>())!.sync_cursor_json;
    const parsed = JSON.parse(cursorJson) as { targets?: Record<string, unknown> };
    expect(parsed.targets?.[SPREADSHEET_ID]).toBeTruthy();
    expect(parsed.targets?.[SHEET_B]).toBeTruthy();
  });

  it('共有フォームでも他アカウントの友だちの回答は書き出さない（R441）', async () => {
    // form-1 を acc-2 にも共有し、acc-2 の友だちの回答を足す
    testDb.raw.exec(`
      INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active)
      VALUES ('acc-2', 'ch-2', 'A2', 'tok', 'sec', 1);
      INSERT INTO form_accounts (form_id, line_account_id) VALUES ('form-1', 'acc-2');
      INSERT INTO friends (id, line_user_id, line_account_id, display_name, is_following, metadata, created_at, updated_at)
      VALUES ('f-other', 'U999', 'acc-2', '別店の客', 1, '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO form_submissions (id, form_id, friend_id, data, created_at)
      VALUES ('sub-other', 'form-1', 'f-other', '{"q1":"他店の回答"}', '2026-09-12T00:00:00Z');
    `);
    const integration = await makeIntegration(testDb);
    const sheet: FakeSheet = { tabs: new Map() };
    const result = await syncOneDataType(envFor(testDb), integration, 'form_answers', {
      kind: 'manual', now: NOW, fetch: makeGoogleFetch(sheet).fetch as never, sleep,
    });
    expect(result.status).toBe('ok');
    const answers = sheet.tabs.get('回答')!;
    expect(answers.length).toBe(3); // header + acc-1 の2件だけ
    expect(answers.flat().includes('U999')).toBe(false);
    expect(answers.flat().includes('別店の客')).toBe(false);
  });
});

describe('processDueGoogleSheetsSyncs', () => {
  let testDb: SqliteD1;
  beforeEach(() => {
    testDb = createTestD1();
    seed(testDb);
  });

  it('その日(JST)の scheduled 実行は1回だけ', async () => {
    const integration = await makeIntegration(testDb);
    const sheet: FakeSheet = { tabs: new Map() };
    const { fetch } = makeGoogleFetch(sheet);
    const env = envFor(testDb);
    const first = await processDueGoogleSheetsSyncs(env, { now: NOW, fetch: fetch as never, sleep });
    expect(first).toEqual({ synced: 1, skipped: 0, failed: 0 });
    const second = await processDueGoogleSheetsSyncs(env, { now: NOW, fetch: fetch as never, sleep });
    expect(second).toEqual({ synced: 0, skipped: 1, failed: 0 });
  });

  it('機能 external_integrations がオフのアカウントは同期しない', async () => {
    const integration = await makeIntegration(testDb);
    await setAccountSetting(testDb.db, 'acc-1', 'feature.external_integrations', 'false');
    const sheet: FakeSheet = { tabs: new Map() };
    const { fetch } = makeGoogleFetch(sheet);
    const result = await processDueGoogleSheetsSyncs(envFor(testDb), { now: NOW, fetch: fetch as never, sleep });
    expect(result.synced).toBe(0);
    expect(sheet.tabs.size).toBe(0);
  });

  it('出力先が未設定（pending_target）の連携は回さない', async () => {
    const enc = await encryptCredential('refresh-token-1', ENCRYPTION_KEY);
    testDb.raw.prepare(
      `INSERT INTO google_sheets_integrations
         (id, line_account_id, google_account_email, refresh_token_enc, status)
       VALUES ('int-2', 'acc-1', 'owner@example.com', ?, 'pending_target')`,
    ).run(enc);
    const result = await processDueGoogleSheetsSyncs(envFor(testDb), { now: NOW, fetch: (() => { throw new Error('should not fetch'); }) as never, sleep });
    expect(result.synced + result.failed).toBe(0);
  });

  it('JSTの日付で同日の定期実行は1回だけ（UTCの日付では見ない）（R442）', async () => {
    // UTCでは前日だがJSTでは今日の実行記録を置く
    await makeIntegration(testDb);
    testDb.raw.prepare(
      `INSERT INTO google_sheets_sync_runs
         (id, integration_id, kind, data_type, status, started_at, run_date, spreadsheet_id)
       VALUES ('run-jst-today', 'int-1', 'scheduled', 'friends', 'ok', '2026-09-26T16:30:00Z', '2026-09-27', ?)`,
    ).run(SPREADSHEET_ID);
    const sheet: FakeSheet = { tabs: new Map() };
    // NOW = 2026-09-27T06:00:00Z → JST 2026-09-27 15:00
    const result = await processDueGoogleSheetsSyncs(envFor(testDb), {
      now: NOW, fetch: makeGoogleFetch(sheet).fetch as never, sleep,
    });
    expect(result).toEqual({ synced: 0, skipped: 1, failed: 0 });
  });

  it('出力先を変えた日は、変える前のシートへの定期実行が残っていても新しい先へ走る（R442）', async () => {
    await makeIntegration(testDb);
    testDb.raw.prepare(
      `INSERT INTO google_sheets_sync_runs
         (id, integration_id, kind, data_type, status, started_at, run_date, spreadsheet_id)
       VALUES ('run-old-dest', 'int-1', 'scheduled', 'friends', 'ok', '2026-09-27T01:00:00Z', '2026-09-27', 'sheet-old')`,
    ).run();
    const sheet: FakeSheet = { tabs: new Map() };
    const result = await processDueGoogleSheetsSyncs(envFor(testDb), {
      now: NOW, fetch: makeGoogleFetch(sheet).fetch as never, sleep,
    });
    expect(result.synced).toBe(1);
    expect(sheet.tabs.get('友だち')!.length).toBe(4);
  });

  it('実行日を持たない古い記録は同日の抑止に使わない（R442）', async () => {
    await makeIntegration(testDb);
    testDb.raw.prepare(
      `INSERT INTO google_sheets_sync_runs
         (id, integration_id, kind, data_type, status, started_at)
       VALUES ('run-legacy', 'int-1', 'scheduled', 'friends', 'ok', '2026-09-27T01:00:00Z')`,
    ).run();
    const sheet: FakeSheet = { tabs: new Map() };
    const result = await processDueGoogleSheetsSyncs(envFor(testDb), {
      now: NOW, fetch: makeGoogleFetch(sheet).fetch as never, sleep,
    });
    expect(result.synced).toBe(1);
  });
});
