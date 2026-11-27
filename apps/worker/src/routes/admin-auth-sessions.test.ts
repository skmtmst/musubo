import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import type { Env } from '../worker-env.js';
import { sha256Hex } from '../middleware/auth.js';
import { getStaffByAdminSession, revokeStaffAuthentication } from '@line-crm/db';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { adminAuth } from './admin-auth.js';

const NOW = '2026-09-08T00:00:00.000Z';
const LATER = '2026-09-09T00:00:00.000Z';

let testDb: ReturnType<typeof createTestD1>;

function app() {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', {
      id: 'staff-1', name: 'Staff One', role: 'staff', readOnly: false,
    });
    await next();
  });
  instance.route('/', adminAuth);
  return instance;
}

function bindings(): Env['Bindings'] {
  return { DB: testDb.db } as Env['Bindings'];
}

function bearer(token: string) {
  return { Authorization: `Bearer lh_session:${token}` };
}

async function seedSession(token: string, staffId: string, device: { ua?: string; ip?: string } = {}) {
  testDb.raw.prepare(
    `INSERT INTO admin_sessions (token_hash, staff_id, expires_at, user_agent, ip_prefix)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(await sha256Hex(token), staffId, LATER, device.ua ?? null, device.ip ?? null);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  testDb = createTestD1();
  for (const id of ['staff-1', 'staff-2', 'staff-other-tenant']) {
    testDb.raw.prepare(
      `INSERT INTO staff_members (id, name, role, api_key, is_active, tenant_id)
       VALUES (?, ?, 'staff', ?, 1, ?)`,
    ).run(id, `Staff ${id}`, `${id}-key`, id === 'staff-other-tenant' ? 'tenant-x' : null);
  }
});

afterEach(() => {
  testDb.raw.close();
  vi.useRealTimers();
});

describe('GET /api/auth/sessions', () => {
  it('本人の有効セッションだけを返し、今のセッションに current を付ける', async () => {
    await seedSession('token-current', 'staff-1', { ua: 'Mozilla/5.0 Chrome', ip: '203.0.*.*' });
    await seedSession('token-other-device', 'staff-1', { ua: 'Mozilla/5.0 Safari' });
    await seedSession('token-other-staff', 'staff-2');
    // 期限切れは一覧に出さない
    testDb.raw.prepare(
      `INSERT INTO admin_sessions (token_hash, staff_id, expires_at) VALUES (?, 'staff-1', '2026-09-07T00:00:00.000Z')`,
    ).run(await sha256Hex('token-expired'));

    const res = await app().request('/api/auth/sessions', { headers: bearer('token-current') }, bindings());
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { sessions: Array<{ id: string; current: boolean; userAgent: string | null; ipPrefix: string | null }> } };
    expect(data.sessions).toHaveLength(2);
    const current = data.sessions.find((s) => s.current);
    expect(current?.id).toBe(await sha256Hex('token-current'));
    expect(current?.userAgent).toBe('Mozilla/5.0 Chrome');
    expect(current?.ipPrefix).toBe('203.0.*.*');
    const other = data.sessions.find((s) => !s.current);
    expect(other?.id).toBe(await sha256Hex('token-other-device'));
  });

  it('セッションtokenの無い認証(API key等)では current が付かない', async () => {
    await seedSession('token-a', 'staff-1');
    const res = await app().request('/api/auth/sessions', {}, bindings());
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { sessions: Array<{ current: boolean }> } };
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].current).toBe(false);
  });
});

describe('DELETE /api/auth/sessions/:tokenHash', () => {
  it('本人の他端末セッションを失効し、そのtokenでは認証できなくなる', async () => {
    await seedSession('token-current', 'staff-1');
    await seedSession('token-victim', 'staff-1');
    const target = await sha256Hex('token-victim');

    const res = await app().request(`/api/auth/sessions/${target}`, { method: 'DELETE', headers: bearer('token-current') }, bindings());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, data: { revoked: 1, current: false } });
    expect(await getStaffByAdminSession(testDb.db, target, NOW)).toBeNull();
    // 今のセッションは残る
    expect(await getStaffByAdminSession(testDb.db, await sha256Hex('token-current'), NOW)).not.toBeNull();
  });

  it('他人のセッションは404で、行は消えない', async () => {
    await seedSession('token-current', 'staff-1');
    await seedSession('token-other-staff', 'staff-2');
    const target = await sha256Hex('token-other-staff');

    const res = await app().request(`/api/auth/sessions/${target}`, { method: 'DELETE', headers: bearer('token-current') }, bindings());
    expect(res.status).toBe(404);
    expect(await getStaffByAdminSession(testDb.db, target, NOW)).not.toBeNull();
  });

  it('他テナントの人のセッションも404で消えない', async () => {
    await seedSession('token-current', 'staff-1');
    await seedSession('token-tenant-x', 'staff-other-tenant');
    const target = await sha256Hex('token-tenant-x');

    const res = await app().request(`/api/auth/sessions/${target}`, { method: 'DELETE', headers: bearer('token-current') }, bindings());
    expect(res.status).toBe(404);
    expect(await getStaffByAdminSession(testDb.db, target, NOW)).not.toBeNull();
  });

  it('今のセッションの失効は確認なしだと409、確認付きなら失効してcookieを期限切れにする', async () => {
    await seedSession('token-current', 'staff-1');
    const target = await sha256Hex('token-current');

    const withoutConfirm = await app().request(`/api/auth/sessions/${target}`, { method: 'DELETE', headers: bearer('token-current') }, bindings());
    expect(withoutConfirm.status).toBe(409);
    expect((await withoutConfirm.json() as { code?: string }).code).toBe('CURRENT_SESSION_CONFIRMATION_REQUIRED');
    // まだ生きている
    expect(await getStaffByAdminSession(testDb.db, target, NOW)).not.toBeNull();

    const res = await app().request(`/api/auth/sessions/${target}?confirmCurrent=1`, { method: 'DELETE', headers: bearer('token-current') }, bindings());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, data: { revoked: 1, current: true } });
    expect(await getStaffByAdminSession(testDb.db, target, NOW)).toBeNull();
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
    expect(cookies.some((cookie) => cookie.startsWith('lh_admin_session=') && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(cookie))).toBe(true);
  });

  it('body の confirmCurrent: true でも今のセッションを失効できる', async () => {
    await seedSession('token-current', 'staff-1');
    const target = await sha256Hex('token-current');
    const res = await app().request(`/api/auth/sessions/${target}`, {
      method: 'DELETE',
      headers: { ...bearer('token-current'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmCurrent: true }),
    }, bindings());
    expect(res.status).toBe(200);
    expect(await getStaffByAdminSession(testDb.db, target, NOW)).toBeNull();
  });
});

describe('POST /api/auth/sessions/revoke-others', () => {
  it('現在の端末と接続元を残し、他の信頼を削除する', async () => {
    const marker = 'marker_abcdefghijklmnopqrstuvwx';
    const markerHash = await sha256Hex(`login-device:${marker}`);
    await seedSession('token-current', 'staff-1', { ip: '203.0.*.*' });
    await seedSession('token-other', 'staff-1');
    for (const [id, hash, ip] of [['staff-1', markerHash, '203.0.*.*'], ['staff-1', 'other', '198.51.*.*'], ['staff-2', 'other', '198.51.*.*']]) testDb.raw.prepare('INSERT INTO auth_trusted_logins VALUES (?, ?, ?, ?)').run(id, hash, ip, NOW);
    const res = await app().request('/api/auth/sessions/revoke-others', { method: 'POST', headers: { cookie: `lh_admin_session=token-current; lh_login_device=${marker}`, 'cf-connecting-ip': '203.0.113.4' } }, bindings());
    expect(res.status).toBe(200);
    expect(testDb.raw.prepare('SELECT staff_id, marker_hash FROM auth_trusted_logins ORDER BY staff_id').all()).toEqual([{ staff_id: 'staff-1', marker_hash: markerHash }, { staff_id: 'staff-2', marker_hash: 'other' }]);
  });

  it('強制ログアウトは本人の信頼だけ削除する', async () => {
    for (const id of ['staff-1', 'staff-2']) testDb.raw.prepare('INSERT INTO auth_trusted_logins VALUES (?, ?, ?, ?)').run(id, 'marker-hash', '203.0.*.*', NOW);
    await revokeStaffAuthentication(testDb.db, 'staff-1');
    expect(testDb.raw.prepare('SELECT staff_id FROM auth_trusted_logins').all()).toEqual([{ staff_id: 'staff-2' }]);
  });
  it('今のセッション以外をまとめて失効し、監査イベントを残す', async () => {
    await seedSession('token-current', 'staff-1');
    await seedSession('token-old-phone', 'staff-1');
    await seedSession('token-old-pc', 'staff-1');
    await seedSession('token-other-staff', 'staff-2');

    const res = await app().request('/api/auth/sessions/revoke-others', { method: 'POST', headers: bearer('token-current') }, bindings());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, data: { revoked: 2 } });

    // 今のセッションは生き、他は全部死ぬ。他人の行は触らない。
    expect(await getStaffByAdminSession(testDb.db, await sha256Hex('token-current'), NOW)).not.toBeNull();
    expect(await getStaffByAdminSession(testDb.db, await sha256Hex('token-old-phone'), NOW)).toBeNull();
    expect(await getStaffByAdminSession(testDb.db, await sha256Hex('token-other-staff'), NOW)).not.toBeNull();

    const audit = testDb.raw.prepare(`SELECT * FROM audit_events WHERE action = 'auth.sessions_revoked'`).get() as Record<string, unknown> | undefined;
    expect(audit).toBeDefined();
    expect(audit?.risk_level).toBe('high');
    expect(audit?.actor_principal_id).toBe('staff-1');
  });
});

it('本人の有効な信頼だけを表示し、CSRFを確認して1件だけ取り消す', async () => {
  await seedSession('token-current', 'staff-1', { ip: '203.0.*.*' });
  const marker = 'marker_abcdefghijklmnopqrstuvwx';
  const hash = await sha256Hex(`login-device:${marker}`);
  for (const [staff, markerHash, ip, date] of [['staff-1', hash, '203.0.*.*', NOW], ['staff-1', 'other', '198.51.*.*', NOW], ['staff-1', 'expired', '192.0.*.*', '2020-01-01T00:00:00.000Z'], ['staff-2', 'private', '198.51.*.*', NOW]]) testDb.raw.prepare('INSERT INTO auth_trusted_logins VALUES (?, ?, ?, ?)').run(staff, markerHash, ip, date);
  const headers = { cookie: `lh_admin_session=token-current; lh_csrf=csrf; lh_login_device=${marker}`, 'x-csrf-token': 'csrf', 'cf-connecting-ip': '203.0.113.4' };
  const listed = await app().request('/api/auth/trusted-logins', { headers }, bindings());
  const body = await listed.json() as { data: Array<{ id: string; current: boolean; ipPrefix: string }> };
  expect(body.data).toHaveLength(2);
  const current = body.data.find(row => row.current)!;
  expect(current.ipPrefix).toBe('203.0.*.*');
  expect(JSON.stringify(body)).not.toContain(hash);
  const anotherId = await sha256Hex(JSON.stringify(['trusted-login', 'staff-2', 'private', '198.51.*.*']));
  expect((await app().request(`/api/auth/trusted-logins/${anotherId}`, { method: 'DELETE', headers }, bindings())).status).toBe(404);
  const url = `/api/auth/trusted-logins/${current.id}`;
  expect((await app().request(url, { method: 'DELETE', headers: { ...headers, 'x-csrf-token': 'bad' } }, bindings())).status).toBe(403);
  expect((await app().request(url, { method: 'DELETE', headers }, bindings())).status).toBe(200);
  expect(testDb.raw.prepare('SELECT staff_id, marker_hash FROM auth_trusted_logins ORDER BY marker_hash').all()).toEqual([{ staff_id: 'staff-1', marker_hash: 'expired' }, { staff_id: 'staff-1', marker_hash: 'other' }, { staff_id: 'staff-2', marker_hash: 'private' }]);
  expect(testDb.raw.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='auth.login_trust_removed'").get()).toEqual({ n: 1 });
});

it('mixed Cookie/Bearer requests manage the same session selected by authentication', async () => {
  await seedSession('cookie-session', 'staff-1');
  await seedSession('bearer-session', 'staff-1');
  const cookieHash = await sha256Hex('cookie-session');
  const bearerHash = await sha256Hex('bearer-session');
  const headers = { ...bearer('bearer-session'), Cookie: 'lh_admin_session=cookie-session', 'Content-Type': 'application/json' };
  const listed = await app().request('/api/auth/sessions', { headers }, bindings());
  expect(await listed.json()).toMatchObject({ data: { sessions: expect.arrayContaining([
    expect.objectContaining({ id: bearerHash, current: true }),
    expect.objectContaining({ id: cookieHash, current: false }),
  ]) } });
  const denied = await app().request(`/api/auth/sessions/${bearerHash}`, { method: 'DELETE', headers }, bindings());
  expect(denied.status).toBe(409);
  const revoked = await app().request('/api/auth/sessions/revoke-others', { method: 'POST', headers, body: '{}' }, bindings());
  expect(revoked.status).toBe(200);
  expect(testDb.raw.prepare('SELECT token_hash FROM admin_sessions').all()).toEqual([{ token_hash: bearerHash }]);
});

it('API-key authentication cannot treat an incidental Cookie as its current session', async () => {
  await seedSession('cookie-session', 'staff-1');
  const headers = { Authorization: 'Bearer fixture-api-key', Cookie: 'lh_admin_session=cookie-session', 'Content-Type': 'application/json' };
  const response = await app().request('/api/auth/sessions/revoke-others', { method: 'POST', headers, body: '{}' }, bindings());
  expect(await response.json()).toMatchObject({ data: { revoked: 0 } });
  expect(testDb.raw.prepare('SELECT COUNT(*) n FROM admin_sessions').get()).toEqual({ n: 1 });
});
