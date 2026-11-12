import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';

const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NOW = '2026-09-27T06:00:00Z';

// @line-crm/db の暗号は本物を使う（平文が残らないことを確かめるため）。
vi.mock('@line-crm/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@line-crm/db')>();
  return actual;
});

const accountAccess = { getVisibleLineAccountScope: vi.fn() };
vi.mock('../services/account-access.js', () => accountAccess);

const googleBusiness = {
  exchangeAuthorizationCode: vi.fn(),
  fetchAccountEmail: vi.fn(),
  refreshAccessToken: vi.fn(),
  revokeToken: vi.fn(),
};
vi.mock('../services/google-business.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/google-business.js')>();
  return { ...actual, ...googleBusiness };
});

const auditLogMod = { auditLog: vi.fn() };
vi.mock('../lib/audit-log.js', () => auditLogMod);

const { encryptCredential } = await import('@line-crm/db');
const { googleSheets } = await import('./google-sheets.js');

/** SQLの内容で振り分ける簡易D1。INSERTのbind値は記録する。 */
const statements: Array<{ sql: string; args: unknown[] }> = [];
const firstQueue: Array<unknown> = [];
/** run の changes を個別に仕込むためのキュー（未設定は1）。 */
const runChangesQueue: Array<number> = [];
function firstFor(sql: string) {
  return firstQueue.shift() ?? null;
}
const prepare = vi.fn((sql: string) => ({
  bind: (...args: unknown[]) => ({
    first: async () => firstFor(sql),
    all: async () => ({ results: [] }),
    run: async () => {
      statements.push({ sql, args });
      const changes = sql.includes('SET used_at') ? (runChangesQueue.shift() ?? 1) : 1;
      return { meta: { changes } };
    },
  }),
  first: async () => firstFor(sql),
  all: async () => ({ results: [] }),
  run: async () => ({ meta: { changes: 1 } }),
}));
const env = {
  DB: { prepare, batch: vi.fn(async () => []) } as unknown as D1Database,
  LINE_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY,
  GOOGLE_SHEETS_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: 'client-secret',
  ADMIN_PUBLIC_URL: 'https://admin.example.com',
} as unknown as Env['Bindings'];

const OWNER: AuthenticatedStaff = { id: 'owner-1', name: '統括', role: 'owner', readOnly: false } as AuthenticatedStaff;

function appFor(staff: AuthenticatedStaff = OWNER) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => { c.set('staff', staff); await next(); });
  app.route('/', googleSheets);
  return app;
}

function post(path: string, body: unknown) {
  return new Request(`https://worker.example.com${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
function put(path: string, body: unknown) {
  return new Request(`https://worker.example.com${path}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  statements.length = 0;
  firstQueue.length = 0;
  runChangesQueue.length = 0;
  accountAccess.getVisibleLineAccountScope.mockResolvedValue({ ids: ['acc-1'], accounts: [] });
});

describe('connect/start', () => {
  it('統括ownerは認可URLを受け取る（Sheets scope・PKCE・offline）', async () => {
    // integrationFor → なし（初回接続）
    firstQueue.push(null);
    const response = await appFor().fetch(post('/api/integrations/google-sheets/connect/start', { accountId: 'acc-1' }), env);
    expect(response.status).toBe(200);
    // 応答は data 包み（packages/shared が正本）。包みが無いと画面が止まる。
    const body = await response.json() as { data: { authorizeUrl: string; mode: string } };
    expect(body.data.mode).toBe('connect');
    const url = new URL(body.data.authorizeUrl);
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/spreadsheets openid email');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBe('https://worker.example.com/api/integrations/google-sheets/oauth/callback');
    const insert = statements.find((s) => s.sql.includes('INSERT INTO google_sheets_oauth_states'));
    expect(insert).toBeTruthy();
    // code_verifier は暗号化して持つ（平文でDBへ置かない）
    expect(String(insert!.args[4])).toMatch(/^v1\./);
    // 新しい接続操作の開始時に、このアカウントの古いstateは消す
    // （開始済みの古いcallbackが後から連携を上書きしないように）。
    const clearOld = statements.find(
      (s) => s.sql.includes('DELETE FROM google_sheets_oauth_states') && s.args[0] === 'acc-1',
    );
    expect(clearOld).toBeTruthy();
    const clearIndex = statements.indexOf(clearOld!);
    const insertIndex = statements.indexOf(insert!);
    expect(clearIndex).toBeLessThan(insertIndex);
  });

  it('全アカウント担当でないadminは403', async () => {
    // staff_members → account_scope が 'all' ではない
    firstQueue.push({ account_scope: 'assigned' });
    const admin: AuthenticatedStaff = { id: 'admin-1', name: '店舗管理者', role: 'admin', readOnly: false } as AuthenticatedStaff;
    const response = await appFor(admin).fetch(post('/api/integrations/google-sheets/connect/start', { accountId: 'acc-1' }), env);
    expect(response.status).toBe(403);
  });

  it('見えないアカウントへの接続開始は404', async () => {
    accountAccess.getVisibleLineAccountScope.mockResolvedValue({ ids: ['other'], accounts: [] });
    const response = await appFor().fetch(post('/api/integrations/google-sheets/connect/start', { accountId: 'acc-1' }), env);
    expect(response.status).toBe(404);
  });
});

describe('connection・runs の応答の形', () => {
  it('未接続でも data 包みで disconnected を返す', async () => {
    firstQueue.push(null); // integration なし
    firstQueue.push(null); // counts なし
    const response = await appFor().fetch(
      new Request('https://worker.example.com/api/integrations/google-sheets/connection?account_id=acc-1'),
      env,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      success: boolean;
      data: {
        connection: { status: string };
        oauthConfigured: boolean; syncRunning: boolean; canManage: boolean;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.connection.status).toBe('disconnected');
    expect(body.data.oauthConfigured).toBe(true);
    expect(body.data.syncRunning).toBe(false);
    expect(body.data.canManage).toBe(true);
  });

  it('連携なしの runs は data 包みの空配列', async () => {
    firstQueue.push(null); // integration なし
    const response = await appFor().fetch(
      new Request('https://worker.example.com/api/integrations/google-sheets/runs?account_id=acc-1'),
      env,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { runs: unknown[] } };
    expect(body.data.runs).toEqual([]);
  });

  it('一般staffは connection を読めない（403）', async () => {
    const staff: AuthenticatedStaff = { id: 'staff-1', name: '担当', role: 'staff', readOnly: false } as AuthenticatedStaff;
    const response = await appFor(staff).fetch(
      new Request('https://worker.example.com/api/integrations/google-sheets/connection?account_id=acc-1'),
      env,
    );
    expect(response.status).toBe(403);
  });
});

describe('oauth/callback', () => {
  it('S07 rejects a store removed from the caller scope after OAuth started', async () => {
    firstQueue.push({ state: 's1', line_account_id: 'acc-1', staff_id: 'owner-1', mode: 'connect',
      code_verifier_enc: await encryptCredential('fixture-verifier', ENCRYPTION_KEY),
      expires_at: '2999-01-01T00:00:00Z', used_at: null });
    firstQueue.push({ id: 'acc-1' });
    accountAccess.getVisibleLineAccountScope.mockResolvedValue({ ids: ['other'], accounts: [] });
    const response = await appFor().fetch(new Request(
      'https://worker.example.com/api/integrations/google-sheets/oauth/callback?state=s1&code=fixture',
    ), env);
    expect(response.headers.get('location')).toContain('sheets=error%3Aaccount_missing');
    expect(googleBusiness.exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(statements.some(statement => statement.sql.includes('INSERT INTO google_sheets_integrations'))).toBe(false);
  });
  it('stateが無効なら管理画面へerror:invalid_stateで戻す', async () => {
    firstQueue.push(null); // stateなし
    const response = await appFor().fetch(
      new Request('https://worker.example.com/api/integrations/google-sheets/oauth/callback?state=bad&code=x'),
      env,
    );
    expect(response.status).toBe(302);
    const location = response.headers.get('location')!;
    expect(location).toContain('/webhooks?');
    expect(location).toContain('sheets=error%3Ainvalid_state');
  });

  it('認可拒否（error=access_denied）はstate消費後にerror:deniedで戻す', async () => {
    firstQueue.push({
      state: 's1', line_account_id: 'acc-1', staff_id: 'owner-1', mode: 'connect',
      code_verifier_enc: 'x', expires_at: '2999-01-01T00:00:00Z', used_at: null,
    });
    const response = await appFor().fetch(
      new Request('https://worker.example.com/api/integrations/google-sheets/oauth/callback?state=s1&error=access_denied'),
      env,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('sheets=error%3Adenied');
    expect(statements.some((s) => s.sql.includes('UPDATE google_sheets_oauth_states SET used_at'))).toBe(true);
  });

  it('成功時はrefresh_tokenを暗号化して保存しconnectedで戻す', async () => {
    const verifierEnc = await encryptCredential('verifier-1', ENCRYPTION_KEY);
    // 1: stateRow  2: line_accounts
    firstQueue.push({
      state: 's1', line_account_id: 'acc-1', staff_id: 'owner-1', mode: 'connect',
      code_verifier_enc: verifierEnc, expires_at: '2999-01-01T00:00:00Z', used_at: null,
    });
    firstQueue.push({ id: 'acc-1' });
    firstQueue.push(null); // integrationFor（既存なし）
    firstQueue.push({ state: 's1' }); // 保存直前のstate生存確認
    googleBusiness.exchangeAuthorizationCode.mockResolvedValue({
      accessToken: 'at-1', refreshToken: 'rt-plain-secret', expiresAtMs: Date.now() + 3600_000,
    });
    googleBusiness.fetchAccountEmail.mockResolvedValue('owner@example.com');

    const response = await appFor().fetch(
      new Request('https://worker.example.com/api/integrations/google-sheets/oauth/callback?state=s1&code=authcode'),
      env,
    );
    expect(response.status).toBe(302);
    const location = response.headers.get('location')!;
    expect(location).toContain('sheets=connected');
    expect(location).toContain('account_id=acc-1');

    const insert = statements.find((s) => s.sql.includes('INSERT INTO google_sheets_integrations'));
    expect(insert).toBeTruthy();
    const storedToken = String(insert!.args[4]);
    expect(storedToken).toMatch(/^v1\./);
    expect(storedToken).not.toContain('rt-plain-secret');
    // access_token はDBへ書かない（INSERT文にbindされない）
    expect(insert!.args.every((a) => String(a) !== 'at-1')).toBe(true);
    expect(auditLogMod.auditLog).toHaveBeenCalledWith(
      expect.anything(), 'google.sheets.connect',
      expect.objectContaining({ kind: 'google_sheets_integration' }),
      expect.objectContaining({ lineAccountId: 'acc-1' }),
    );
  });

  it('refresh_tokenが来ない場合はerror:no_refresh_tokenで戻す', async () => {
    const verifierEnc = await encryptCredential('verifier-1', ENCRYPTION_KEY);
    firstQueue.push({
      state: 's1', line_account_id: 'acc-1', staff_id: 'owner-1', mode: 'connect',
      code_verifier_enc: verifierEnc, expires_at: '2999-01-01T00:00:00Z', used_at: null,
    });
    firstQueue.push({ id: 'acc-1' });
    firstQueue.push(null);
    googleBusiness.exchangeAuthorizationCode.mockResolvedValue({
      accessToken: 'at-1', refreshToken: null, expiresAtMs: Date.now() + 3600_000,
    });
    googleBusiness.fetchAccountEmail.mockResolvedValue('owner@example.com');
    const response = await appFor().fetch(
      new Request('https://worker.example.com/api/integrations/google-sheets/oauth/callback?state=s1&code=authcode'),
      env,
    );
    expect(response.headers.get('location')).toContain('sheets=error%3Ano_refresh_token');
    expect(statements.some((s) => s.sql.includes('INSERT INTO google_sheets_integrations'))).toBe(false);
  });

  it('保存直前にstateが消えていたら連携を作り直さずerror:state_cancelledで戻す', async () => {
    // 解除・新しい接続開始でstate行が消えたあとに遅れて届いたcallback。
    // 連携行を作り直してはいけない。
    const verifierEnc = await encryptCredential('verifier-1', ENCRYPTION_KEY);
    firstQueue.push({
      state: 's1', line_account_id: 'acc-1', staff_id: 'owner-1', mode: 'connect',
      code_verifier_enc: verifierEnc, expires_at: '2999-01-01T00:00:00Z', used_at: null,
    });
    firstQueue.push({ id: 'acc-1' });
    firstQueue.push(null);
    firstQueue.push(null); // 保存直前のstate生存確認 → 消えている
    googleBusiness.exchangeAuthorizationCode.mockResolvedValue({
      accessToken: 'at-1', refreshToken: 'rt-1', expiresAtMs: Date.now() + 3600_000,
    });
    googleBusiness.fetchAccountEmail.mockResolvedValue('owner@example.com');
    const response = await appFor().fetch(
      new Request('https://worker.example.com/api/integrations/google-sheets/oauth/callback?state=s1&code=authcode'),
      env,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('sheets=error%3Astate_cancelled');
    expect(statements.some((s) => s.sql.includes('INSERT INTO google_sheets_integrations'))).toBe(false);
  });

  it('同じstateを二度消費しようとしても片方だけ通る', async () => {
    // 消費UPDATEの changes が0 → もう片方が先に使った → invalid_state。
    const verifierEnc = await encryptCredential('verifier-1', ENCRYPTION_KEY);
    firstQueue.push({
      state: 's1', line_account_id: 'acc-1', staff_id: 'owner-1', mode: 'connect',
      code_verifier_enc: verifierEnc, expires_at: '2999-01-01T00:00:00Z', used_at: null,
    });
    runChangesQueue.push(0); // 条件付きUPDATEが当たらない = 先に消費済み
    const response = await appFor().fetch(
      new Request('https://worker.example.com/api/integrations/google-sheets/oauth/callback?state=s1&code=authcode'),
      env,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('sheets=error%3Ainvalid_state');
    expect(googleBusiness.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });
});

describe('disconnect', () => {
  it('確認なしでは切らない', async () => {
    const response = await appFor().fetch(post('/api/integrations/google-sheets/disconnect', { accountId: 'acc-1' }), env);
    expect(response.status).toBe(400);
  });

  it('Google側をrevokeして連携行を消す', async () => {
    const refreshEnc = await encryptCredential('rt-1', ENCRYPTION_KEY);
    firstQueue.push({
      id: 'int-1', line_account_id: 'acc-1', refresh_token_enc: refreshEnc,
      status: 'connected', spreadsheet_id: 'sheet-id', sync_cursor_json: '{}',
      consecutive_failures: 0, google_account_email: null, tenant_id: null,
      spreadsheet_title: null, last_synced_at: null, last_sync_status: null,
      last_sync_error: null, connected_by_staff_id: null, connected_at: NOW,
      created_at: NOW, updated_at: NOW,
    });
    googleBusiness.revokeToken.mockResolvedValue(true);
    const response = await appFor().fetch(post('/api/integrations/google-sheets/disconnect', { accountId: 'acc-1', confirmed: true }), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { revoked: boolean } };
    expect(body.data.revoked).toBe(true);
    expect(googleBusiness.revokeToken).toHaveBeenCalledWith({ token: 'rt-1', fetch: expect.anything() });
    expect(statements.some((s) => s.sql.includes('DELETE FROM google_sheets_integrations'))).toBe(true);
    // 解除時にこのアカウントの接続操作（state）も全部消す。
    // 解除より前に始まっていた遅いcallbackが連携を復活させないように。
    expect(
      statements.some((s) => s.sql.includes('DELETE FROM google_sheets_oauth_states') && s.args[0] === 'acc-1'),
    ).toBe(true);
    expect(auditLogMod.auditLog).toHaveBeenCalledWith(
      expect.anything(), 'google.sheets.disconnect', expect.anything(), expect.anything(),
    );
  });
});

describe('target', () => {
  it('URL/IDの形が違う値は400', async () => {
    const response = await appFor().fetch(put('/api/integrations/google-sheets/target', { accountId: 'acc-1', spreadsheet: 'notaurl' }), env);
    expect(response.status).toBe(400);
    const body = await response.json() as { code: string };
    expect(body.code).toBe('invalid_spreadsheet');
  });

  it('未接続のアカウントには409', async () => {
    firstQueue.push(null); // integrationなし
    const response = await appFor().fetch(put('/api/integrations/google-sheets/target', {
      accountId: 'acc-1', spreadsheet: 'sheet-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }), env);
    expect(response.status).toBe(409);
  });
});

describe('sync', () => {
  it('出力先が無い連携は409', async () => {
    firstQueue.push({
      id: 'int-1', line_account_id: 'acc-1', refresh_token_enc: 'v1.x',
      status: 'pending_target', spreadsheet_id: null, sync_cursor_json: '{}',
      consecutive_failures: 0, google_account_email: null, tenant_id: null,
      spreadsheet_title: null, last_synced_at: null, last_sync_status: null,
      last_sync_error: null, connected_by_staff_id: null, connected_at: NOW,
      created_at: NOW, updated_at: NOW,
    });
    const response = await appFor().fetch(post('/api/integrations/google-sheets/sync', { accountId: 'acc-1' }), env);
    expect(response.status).toBe(409);
  });
});
