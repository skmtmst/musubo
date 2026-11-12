import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import type { Env } from '../worker-env.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { encryptTotpSecret } from '../lib/totp.js';
import { sha256Hex } from './auth.js';

let fixture: SqliteD1;
let db: D1Database;
let trips: string[];
let tokenHash: string;

// batchは含むSQLの数にかかわらず1往復。中の実行を二重計上しない。
function countedDb(source: D1Database): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (['first', 'all', 'run', 'raw'].includes(String(prop))) return (...args: unknown[]) => {
          trips.push(sql);
          return Reflect.get(target, prop).apply(target, args);
        };
        return Reflect.get(target, prop);
      },
    });
    originals.set(proxy, statement);
    return proxy;
  }
  return {
    prepare: sql => wrap(source.prepare(sql), sql),
    batch: statements => {
      trips.push('batch');
      return source.batch(statements.map(statement => originals.get(statement) ?? statement));
    },
  } as D1Database;
}

beforeEach(async () => {
  fixture = createTestD1();
  fixture.raw.exec(`INSERT INTO tenants(id,name) VALUES('tenant','Fixture');
    INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('actor','Fixture','owner','unused-key','tenant');
    INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id)
      VALUES('store','fixture-channel','Fixture','fixture-token','fixture-secret','tenant');`);
  tokenHash = await sha256Hex('fixture-session');
  fixture.raw.prepare("INSERT INTO admin_sessions(token_hash,staff_id,expires_at) VALUES(?,'actor',?)")
    .run(tokenHash, new Date(Date.now() + 3600_000).toISOString());
  trips = [];
  db = countedDb(fixture.db);
});
afterEach(() => { vi.restoreAllMocks(); fixture.raw.close(); });

function request(path: string, extra: Partial<Env['Bindings']> = {}) {
  return app.request(path, { headers: { Cookie: 'lh_admin_session=fixture-session; lh_csrf=fixture-csrf' } },
    { DB: db, ...extra } as Env['Bindings']);
}

// 実アプリのmiddleware登録からhandlerまで通し、権限付き読取の予算を守る。
it.each([
  ['/api/auto-replies', 11],
  ['/api/scenarios', 8],
  ['/api/templates', 11],
  ['/api/tags', 4],
  ['/api/staff/me', 2],
  ['/api/tenants/me', 3],
  // 利用開始前の行き先を認証応答で確定するため、料金状態を1往復で確認する。
  ['/api/auth/session', 5],
  ['/api/line-accounts', 8],
  ['/api/hq/style-attention', 6],
  ['/api/inbox/unanswered/count', 4],
  ['/api/accounts/health-summary', 4],
  ['/api/notifications/center?lineAccountId=store&limit=1', 5],
  ['/api/settings/features/visibility?account_id=store', 7],
  ['/api/settings/features?account_id=store', 8],
  ['/api/hq/billing/summary', 4],
])('%s のD1往復数を守る', async (path, expected) => {
  const response = await request(path);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(trips.length, trips.join('\n')).toBe(expected);
  expect(response.headers.get('Server-Timing')).toContain(`d1_count;desc="${expected}"`);
});

it('別要求のスタッフ停止・範囲変更を読み直し、秘密列を応答へ出さない', async () => {
  const first = await request('/api/staff/me');
  const body = await first.text();
  expect(first.status).toBe(200);
  expect(body).not.toMatch(/unused-key|totp_secret|password_hash/);
  fixture.raw.prepare("UPDATE staff_members SET account_scope='accounts' WHERE id='actor'").run();
  const scoped = await request('/api/line-accounts');
  expect((await scoped.json() as { data: unknown[] }).data).toEqual([]);
  fixture.raw.prepare("UPDATE staff_members SET is_active=0 WHERE id='actor'").run();
  expect((await request('/api/staff/me')).status).toBe(401);
});

it('別統括のアカウント指定は従来どおり拒否する', async () => {
  fixture.raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id)
    VALUES('foreign','foreign','Foreign','secret','secret','other');`);
  expect((await request('/api/settings/features/visibility?account_id=foreign')).status).toBe(403);
});

const mfaKey = 'fixture-mfa-master-key-at-least-32-characters';
async function registerMfa() {
  const encrypted = await encryptTotpSecret('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', mfaKey);
  fixture.raw.prepare("UPDATE staff_members SET totp_enabled_at='2026-10-01',totp_secret_enc=? WHERE id='actor'")
    .run(encrypted);
  fixture.raw.prepare("INSERT INTO platform_settings(key,value) VALUES(?, 'actor')")
    .run(`auth.mfa.session:${tokenHash}`);
}

it.each([
  ['/api/auto-replies', 13], ['/api/scenarios', 10], ['/api/templates', 13], ['/api/tags', 6],
  ['/api/staff/me', 4], ['/api/tenants/me', 5], ['/api/auth/session', 7],
  ['/api/line-accounts', 10], ['/api/hq/style-attention', 8],
  ['/api/inbox/unanswered/count', 6], ['/api/accounts/health-summary', 6],
  ['/api/notifications/center?lineAccountId=store&limit=1', 7],
  ['/api/settings/features/visibility?account_id=store', 9],
  ['/api/settings/features?account_id=store', 10], ['/api/hq/billing/summary', 6],
])('MFA登録済み %s のD1往復数を守る', async (path, expected) => {
  await registerMfa();
  const response = await request(path, { TOTP_ENCRYPTION_KEY: mfaKey });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(trips.length, trips.join('\n')).toBe(expected);
  expect(response.headers.get('Server-Timing')).toContain(`d1_count;desc="${expected}"`);
});

it.each(['missing', 'wrong-staff', 'policy-off'] as const)('MFA確認の印が%sならセッションを拒否する', async mode => {
  await registerMfa();
  fixture.raw.prepare("DELETE FROM platform_settings WHERE key=?").run(`auth.mfa.session:${tokenHash}`);
  if (mode === 'wrong-staff') fixture.raw.prepare("INSERT INTO platform_settings(key,value) VALUES(?, 'other')").run(`auth.mfa.session:${tokenHash}`);
  if (mode === 'policy-off') fixture.raw.exec("INSERT INTO platform_settings(key,value) VALUES('auth.mfa.required:tenant','false')");
  expect((await request('/api/staff/me', { TOTP_ENCRYPTION_KEY: mfaKey })).status).toBe(401);
  expect(fixture.raw.prepare('SELECT token_hash FROM admin_sessions WHERE token_hash=?').get(tokenHash)).toBeUndefined();
});

it('MFA必須で未登録のセッションは確認の印を読まずに拒否する', async () => {
  expect((await request('/api/staff/me', { TOTP_ENCRYPTION_KEY: mfaKey })).status).toBe(401);
  // 本人＋方針＋失効batch＋緊急APIキーfallbackの4往復。許可へは進まない。
  expect(trips).toHaveLength(4);
});


it('CORSの事前確認・認証前の拒否・robotsにも計測を付ける', async () => {
  const origin = 'https://admin.example';
  const bindings = { DB: db, ADMIN_ORIGIN: origin } as Env['Bindings'];
  const options = await app.request('/api/staff/me', { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'GET',
  } }, bindings);
  expect(options.status).toBe(204);
  expect(options.headers.get('Timing-Allow-Origin')).toBe(origin);
  expect(options.headers.get('Server-Timing')).toContain('d1_count;desc="0"');
  const denied = await app.request('/api/staff/me', { headers: { Origin: origin } }, bindings);
  expect(denied.status).toBe(401);
  expect(denied.headers.get('Access-Control-Expose-Headers')).toContain('Server-Timing');
  expect(denied.headers.get('Server-Timing')).toContain('d1_count;desc="0"');
  const robots = await app.request('/robots.txt', {}, bindings);
  expect(robots.status).toBe(200);
  expect(robots.headers.get('Server-Timing')).toContain('total;dur=');
});

it('同じenvを使う並行要求でもD1の回数を混ぜず、共有Bindingを変更しない', async () => {
  const bindings = { DB: db } as Env['Bindings'];
  const responses = await Promise.all(['/api/staff/me', '/api/scenarios'].map(path => app.request(path, {
    headers: { Cookie: 'lh_admin_session=fixture-session' },
  }, bindings)));
  expect(bindings.DB).toBe(db);
  expect(responses.map(res => res.status)).toEqual([200, 200]);
  expect(responses[0].headers.get('Server-Timing')).toContain('d1_count;desc="2"');
  expect(responses[1].headers.get('Server-Timing')).toContain('d1_count;desc="8"');
});
