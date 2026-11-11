import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  authMiddleware,
  isPublicApiBoundary,
  isStaffExplicitAllow,
  isStaffSelfEndpoint,
  permissionForApiPath,
} from './auth.js';
import { resolveCorsOrigin } from './admin-auth-config.js';
import { requirePlatformAdmin } from './platform-admin.js';
import { adminAuth } from '../routes/admin-auth.js';
import { encryptTotpSecret, totpAtStep } from '../lib/totp.js';
import type { Env } from '../worker-env.js';

vi.mock('@line-crm/db', async original => ({
  ...await original<typeof import('@line-crm/db')>(),
  // 代理ログイン（★37-5）。ここでは常に「無し」。
  getActiveImpersonation: vi.fn(async () => null),
  getPlatformAdminByStaffId: vi.fn(async (_db: unknown, staffId: string) => staffId === 'ops-staff-1'
    ? { staff_id: staffId, is_active: 1, activation_state: 'active' }
    : null),
  getPlatformAdminRecord: vi.fn(async () => null),
  getPlatformSetting: vi.fn(async () => 'false'),
  // 認証ミドルウェアのfixtureには料金DBを作らない。利用開始状態は専用の実DB試験で確認する。
  getMusuboTenantBilling: vi.fn(async () => null),
  recordAuditEvent: vi.fn(async () => undefined),
  readAuthThrottle: vi.fn(async () => 0),
  bumpAuthThrottle: vi.fn(async () => 1),
  clearAuthThrottle: vi.fn(async () => undefined),
  getStaffByApiKey: vi.fn(async (_db: unknown, token: string) => {
    if (token === 'suspended-key') return { id: 'suspended-owner', name: 'Stopped Owner', role: 'owner', tenant_id: 'tenant-stopped', tenant_status: 'suspended' };
    if (token === 'archived-key') return { id: 'archived-owner', name: 'Archived Owner', role: 'owner', tenant_id: 'tenant-archived', tenant_status: 'archived' };
    if (token === 'viewer-key') return { id: 'viewer-1', name: 'Viewer One', role: 'staff', access_level: 'read_only' };
    if (token === 'friends-key') return { id: 'friends-1', name: 'Friends Staff', role: 'staff', permission_keys: '["/friends"]' };
    if (token === 'chats-key') return { id: 'chats-1', name: 'Chats Staff', role: 'staff', permission_keys: '["/chats"]' };
    if (token === 'tags-key') return { id: 'tags-1', name: 'Tags Staff', role: 'staff', permission_keys: '["/tags"]' };
    if (token === 'mileage-key') return { id: 'mileage-1', name: 'Mileage Staff', role: 'staff', permission_keys: '["/mileage"]' };
    if (token === 'auto-replies-key') return { id: 'auto-replies-1', name: 'Auto Replies Staff', role: 'staff', permission_keys: '["/auto-replies"]' };
    if (token === 'automations-key') return { id: 'automations-1', name: 'Automations Staff', role: 'staff', permission_keys: '["/automations"]' };
    if (token === 'booking-key') return { id: 'booking-1', name: 'Booking Staff', role: 'staff', permission_keys: '["/booking/bookings"]' };
    // 予約の細かい権限。管理(booking)・メニュー・設定・本人勤務は別キー。
    if (token === 'booking-menus-key') return { id: 'bm-1', name: 'Menus Staff', role: 'staff', permission_keys: '["/booking/menus"]' };
    if (token === 'booking-settings-key') return { id: 'bs-1', name: 'Settings Staff', role: 'staff', permission_keys: '["booking.settings"]' };
    if (token === 'booking-own-key') return { id: 'bo-1', name: 'Own Shift Staff', role: 'staff', permission_keys: '["booking.staff.own"]' };
    if (token === 'booking-own-view-key') return { id: 'bov-1', name: 'Own Shift Viewer', role: 'staff', view_permission_keys: '["booking.staff.own"]' };
    if (token === 'events-key') return { id: 'events-1', name: 'Events Staff', role: 'staff', permission_keys: '["/events"]' };
    if (token === 'contents-key') return { id: 'contents-1', name: 'Contents Staff', role: 'staff', permission_keys: '["/contents"]' };
    if (token === 'photo-view-key') return { id: 'photo-view-1', name: 'Photo Viewer', role: 'staff', permission_keys: '["photo.submission.view"]' };
    if (token === 'photo-review-key') return { id: 'photo-review-1', name: 'Photo Reviewer', role: 'staff', permission_keys: '["photo.submission.review"]' };
    if (token === 'photo-bulk-key') return { id: 'photo-bulk-1', name: 'Photo Bulk Reviewer', role: 'staff', permission_keys: '["photo.submission.bulk_review"]' };
    if (token === 'photo-download-key') return { id: 'photo-download-1', name: 'Photo Downloader', role: 'staff', permission_keys: '["photo.original.download"]' };
    if (token === 'rich-menus-key') return { id: 'rich-menus-1', name: 'Rich Menu Staff', role: 'staff', permission_keys: '["/rich-menus"]' };
    if (token === 'no-permissions-key') return { id: 'none-1', name: 'No Permission Staff', role: 'staff', permission_keys: '[]' };
    if (token === 'ops-staff-key') return { id: 'ops-staff-1', name: 'Ops Staff', role: 'staff', permission_keys: '[]' };
    if (token !== 'staff-key') return null;
    return {
      id: 'staff-1', name: 'Staff One', role: 'admin',
      tenant_id: '00000000-0000-4000-8000-000000000001',
    };
  }),
  getStaffByAdminSession: vi.fn(async (_db: unknown, tokenHash: string) => {
    if (tokenHash === 'dfac1ac3966cbe3d487761671296ced77cce526aa4ebb1cf70a1cf3f728dcd4e') {
      return { id: 'viewer-1', name: 'Viewer One', role: 'staff', access_level: 'read_only' };
    }
    if (tokenHash !== 'c1e9199b97100cfa89cf5335e39753c0ee4caddde90d79bf5ca16ab99d4a7d9a') return null;
    return { id: 'staff-1', name: 'Staff One', role: 'admin' };
  }),
  getStaffByLineUserId: vi.fn(async (_db: unknown, lineUserId: string) => {
    if (lineUserId !== 'authorized-line-user') return null;
    // 管理者束はTOTP必須のため、セッション発行の確認は必須でない役割で行う。
    return { id: 'staff-1', name: 'Staff One', role: 'staff', is_active: 1 };
  }),
  createAdminSession: vi.fn(async () => undefined),
  createTwoFactorChallenge: vi.fn(async () => undefined),
  // 実装と同じ判定（owner/admin かつ閲覧専用でない人はMFA必須）。
  staffRequiresMfa: vi.fn((row: { role: string; access_level?: string }) =>
    (row.role === 'owner' || row.role === 'admin') && row.access_level !== 'read_only'),
  activatePlatformAdminIfAwaitingTotp: vi.fn(async () => false),
  deleteExpiredTwoFactorChallenges: vi.fn(async () => undefined),
  getTwoFactorChallenge: vi.fn(async () => null),
  getStaffById: vi.fn(async (_db: unknown, id: string) => id === 'staff-1' ? { id, name: 'Staff One', role: 'admin', is_active: 1, totp_enabled_at: null, totp_secret_enc: null } : null),
  // セッション行の再確認・見なれない判定。既定は「行なし・履歴なし」。
  getAdminSessionByTokenHash: vi.fn(async () => null),
  adminSessionFamiliarity: vi.fn(async () => ({
    hasBaseline: false, deviceKnown: false, ipKnown: false,
  })),
  incrementTwoFactorChallengeAttempts: vi.fn(async () => undefined),
  deleteTwoFactorChallenge: vi.fn(async () => undefined),
  claimStaffTotpStep: vi.fn(async () => true),
  reserveStepUpAttempt: vi.fn(async () => ({
    attempts: 1, maxAttempts: 5, windowStartedAt: new Date().toISOString(),
  })),
  createStepUpGrant: vi.fn(async () => true),
  updateStaffMember: vi.fn(async () => null),
  deleteAdminSession: vi.fn(async () => undefined),
  // ログイン・ログアウト・失敗を記録する。本体では例外を握るので、
  // ここでも何もしない実装で足りる。
  recordLoginAudit: vi.fn(async () => undefined),
}));

const PAGES = 'https://your-admin.pages.dev';
const WORKERS = 'https://your-worker.your-subdomain.workers.dev';

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB: {} as D1Database,
    IMAGES: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 'secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    API_KEY: 'env-key',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'line-channel',
    LINE_LOGIN_CHANNEL_ID: 'login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: WORKERS,
    ADMIN_PUBLIC_URL: PAGES,
    ...overrides,
    RAW_MAIL: overrides.RAW_MAIL ?? ({} as R2Bucket),
  };
}

const sessionDatabases: ReturnType<typeof createTestD1>[] = [];
afterEach(() => { for (const db of sessionDatabases.splice(0)) db.raw.close(); });

// セッション発行は既知端末も記録するため、成功するログインの fixture には実スキーマと外部キー先の staff 行を用意する。
function sessionEnv(bindings: Env['Bindings']): Env['Bindings'] {
  const db = createTestD1();
  sessionDatabases.push(db);
  db.raw.prepare("INSERT INTO staff_members(id,name,role,api_key) VALUES ('staff-1','Fixture','admin','fixture-key')").run();
  return { ...bindings, DB: db.db };
}

// 明示的に許可した本番の別サイト構成を試す。
function crossSiteEnv(): Env['Bindings'] {
  return env({ ADMIN_ORIGIN: PAGES, ADMIN_ALLOW_CROSS_SITE: 'true' });
}

function app() {
  const a = new Hono<Env>();
  a.use('*', cors({
    origin: (origin, c) => resolveCorsOrigin(c.env, origin, c.req.url),
    credentials: true,
  }));
  a.use('*', authMiddleware);
  a.route('/', adminAuth);
  a.get('/api/restaurant-test/setup-progress', (c) => c.json({ success: true }));
  a.put('/api/dashboard/style',(c)=>c.json({success:true}));
  a.post('/api/restaurant-test/setup-progress', (c) => c.json({ success: true }));
  a.get('/api/protected', (c) => c.json({ success: true, data: c.get('staff') }));
  a.post('/api/protected', (c) => c.json({ success: true, data: c.get('staff') }));
  a.all('/api/line-accounts/:id/follower-import', (c) => c.json({ success: true }));
  a.post('/api/line-accounts/:id/follower-import/:action', (c) => c.json({ success: true }));
  a.get('/api/friends', (c) => c.json({ success: true }));
  a.post('/api/broadcasts/:id/send', (c) => c.json({ success: true }));
  a.post('/api/hq/support/requests', (c) => c.json({ success: true }));
  a.get('/api/hq/support/requests', (c) => c.json({ success: true }));
  a.get('/api/hq/support/summary', (c) => c.json({ success: true }));
  a.get('/api/hq/notices', (c) => c.json({ success: true }));
  a.post('/api/hq/notices/:id/read', (c) => c.json({ success: true }));
  a.get('/api/tenants/me', (c) => c.json({ success: true }));
  a.get('/api/settings/company', (c) => c.json({ success: true }));
  a.put('/api/settings/company', (c) => c.json({ success: true }));
  a.get('/api/ops/me', requirePlatformAdmin(), (c) => c.json({ success: true, data: c.get('staff') }));
  a.get('/api/auto-reply-runs', (c) => c.json({ success: true }));
  a.get('/api/automation-runs', (c) => c.json({ success: true }));
  a.get('/api/rich-menu-images/:key{.+}', (c) => c.json({ success: true }));
  a.get('/api/rich-menu-groups/external/:richMenuId/image', (c) => c.json({ success: true }));
  a.get('/api/forms/:id', (c) => c.json({ success: true, staff: c.get('staff') ?? null }));
  a.put('/api/forms/:id', (c) => c.json({ success: true }));
  a.delete('/api/forms/:id', (c) => c.json({ success: true }));
  a.post('/api/forms/:id/submit', (c) => c.json({ success: true }));
  a.post('/api/forms/:id/partial', (c) => c.json({ success: true }));
  a.post('/api/forms/:id/opened', (c) => c.json({ success: true }));
  a.post('/api/integrations/codex-slack/events', (c) => c.json({ success: true }));
  a.post('/api/integrations/ai-loop/reports', (c) => c.json({ success: true }));
  a.post('/api/integrations/slack/actions', (c) => c.json({ success: true }));
  a.post('/api/integrations/slack/events', (c) => c.json({ success: true }));
  a.get('/api/public/brand', (c) => c.json({ success: true, staff: c.get('staff') ?? null }));
  a.get('/api/site/script.js', (c) => c.json({ success: true, staff: c.get('staff') ?? null }));
  a.post('/api/site/collect', (c) => c.json({ success: true, staff: c.get('staff') ?? null }));
  for (const path of [
    '/api/support', '/api/operators', '/api/support-marks', '/api/saved-searches',
    '/api/folders', '/api/tag-groups', '/api/friends/:id', '/api/friends/:id/messages',
    '/api/friends/:id/fields', '/api/friends/:id/support-mark', '/api/friends/support-mark/bulk',
  ]) {
    a.get(path, (c) => c.json({ success: true }));
  }
  a.get('/api/mileage/history', (c) => c.json({ success: true }));
  a.get('/api/action-scores/rules', (c) => c.json({ success: true }));
  a.get('/api/booking/admin/customers', (c) => c.json({ success: true }));
  a.post('/api/booking/admin/customers', (c) => c.json({ success: true }));
  a.patch('/api/booking/admin/requests/:id', (c) => c.json({ success: true }));
  // 細かい権限の検証用スタブ（route 側ガードは別試験で担保）。
  a.get('/api/booking/admin/menus', (c) => c.json({ success: true }));
  a.post('/api/booking/admin/menus', (c) => c.json({ success: true }));
  a.put('/api/booking/admin/settings', (c) => c.json({ success: true }));
  a.get('/api/booking/admin/staff/me', (c) => c.json({ success: true }));
  a.get('/api/booking/admin/staff/:id/shifts', (c) => c.json({ success: true }));
  a.put('/api/booking/admin/staff/:id/shifts', (c) => c.json({ success: true }));
  a.post('/api/booking/admin/staff', (c) => c.json({ success: true }));
  a.get('/api/meet-consultations', (c) => c.json({ success: true }));
  a.post('/api/meet-consultations', (c) => c.json({ success: true }));
  a.delete('/api/meet-consultations/:externalEventId', (c) => c.json({ success: true }));
  // 本番で staff 到達可な予約口だけを載せる (枠の作成・変更・削除は owner/admin 専用のため除外)。
  a.put('/api/events/admin/events/:id/bookings/:bookingId', (c) => c.json({ success: true }));
  a.post('/api/events/admin/events/:id/bookings/:bookingId/decide', (c) => c.json({ success: true }));
  a.post('/api/events/admin/events/:id/bookings/:bookingId/cancel', (c) => c.json({ success: true }));
  a.get('/api/nen-members/photos', (c) => c.json({ success: true }));
  a.get('/api/nen-members/photos/photo-1/assets/status', (c) => c.json({ success: true }));
  a.post('/api/nen-members/photos/photo-1/review', (c) => c.json({ success: true }));
  a.post('/api/nen-members/photos/photo-1/assets/process', (c) => c.json({ success: true }));
  a.post('/api/nen-members/photos/decisions/bulk', (c) => c.json({ success: true }));
  a.post('/api/nen-members/photos/photo-1/original-download', (c) => c.json({ success: true }));
  a.get('/api/nen-members/photos/original-download/token', (c) => c.json({ success: true }));
  a.get('/api/media', (c) => c.json({ success: true }));
  a.get('/api/media/md-1/download', (c) => c.json({ success: true }));
  a.get('/api/media/md-1/content', (c) => c.json({ success: true }));
  a.get('/api/rich-menu-groups', (c) => c.json({ success: true }));
  // 本人IDと同じ動的 path だけ通り、将来追加される固定1セグメント path は閉じる。
  a.get('/api/staff/friends-1', (c) => c.json({ success: true }));
  a.patch('/api/staff/friends-1', (c) => c.json({ success: true }));
  a.get('/api/staff/export', (c) => c.json({ success: true }));
  a.patch('/api/staff/policy', (c) => c.json({ success: true }));
  //  の未登録経路。permissionForApiPath が null を返す口。
  a.get('/api/coverage-unmapped-demo', (c) => c.json({ success: true }));
  a.post('/api/coverage-unmapped-demo', (c) => c.json({ success: true }));
  return a;
}

function setCookies(res: Response): string[] {
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === 'function') return anyHeaders.getSetCookie();
  const single = res.headers.get('Set-Cookie');
  return single ? [single] : [];
}

function cookieFor(res: Response, name: string): string | undefined {
  return setCookies(res).find((c) => c.startsWith(`${name}=`));
}

describe('admin login cookie attributes', () => {
  test('cross-site login sets HttpOnly Secure SameSite=None session + readable CSRF cookie', async () => {
    const res = await app().request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'staff-key' }),
      headers: { 'Content-Type': 'application/json' },
    }, sessionEnv(crossSiteEnv()));

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { id: string }; csrfToken: string };
    expect(body.data).toMatchObject({
      id: 'staff-1', role: 'admin',
      tenantId: '00000000-0000-4000-8000-000000000001',
    });
    expect(body.csrfToken).toBeTruthy();

    const session = cookieFor(res, 'lh_admin_session') ?? '';
    expect(session).toMatch(/^lh_admin_session=[^;]+/);
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Secure');
    expect(session).toContain('SameSite=None');
    // 既定は8時間。「記憶する」選択時だけ7日。
    expect(session).toContain('Max-Age=28800');

    const csrf = cookieFor(res, 'lh_csrf') ?? '';
    expect(csrf).toContain(`lh_csrf=${body.csrfToken}`);
    expect(csrf).not.toContain('HttpOnly'); // double-submit 用に管理画面から読める Cookie とする。
    expect(csrf).toContain('SameSite=None');
  });

  test('same-site (custom domain) login uses SameSite=Lax', async () => {
    const res = await app().request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'staff-key' }),
      headers: { 'Content-Type': 'application/json' },
    }, sessionEnv(env({ ADMIN_ORIGIN: 'https://admin.example.com', WORKER_URL: 'https://api.example.com' })));

    expect(res.status).toBe(200);
    expect(cookieFor(res, 'lh_admin_session') ?? '').toContain('SameSite=Lax');
  });

  test('invalid api key is rejected without a cookie', async () => {
    const res = await app().request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'wrong' }),
      headers: { 'Content-Type': 'application/json' },
    }, crossSiteEnv());
    expect(res.status).toBe(401);
    expect(cookieFor(res, 'lh_admin_session')).toBeUndefined();
  });
});

describe('LINE admin login', () => {
  test('starts OAuth with state, nonce and PKCE', async () => {
    const res = await app().request('/api/auth/line', {}, crossSiteEnv());
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('Location')!);
    expect(location.origin).toBe('https://access.line.me');
    expect(location.searchParams.get('client_id')).toBe('login-channel');
    expect(location.searchParams.get('scope')).toBe('openid profile');
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(location.searchParams.get('nonce')).toBeTruthy();
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(cookieFor(res, 'lh_line_state')).toBeTruthy();
    expect(cookieFor(res, 'lh_line_nonce')).toBeTruthy();
    expect(cookieFor(res, 'lh_line_verifier')).toBeTruthy();
  });

  test('rejects a callback when state does not match before calling LINE', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await app().request('/api/auth/line/callback?code=abc&state=wrong', {
      headers: { Cookie: 'lh_line_state=expected; lh_line_nonce=nonce; lh_line_verifier=verifier' },
    }, crossSiteEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('/login?error=invalid_state');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('creates a session only for an explicitly authorized LINE user', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ id_token: 'id-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'authorized-line-user' }), { status: 200 }));
    const res = await app().request('/api/auth/line/callback?code=abc&state=expected', {
      headers: { Cookie: 'lh_line_state=expected; lh_line_nonce=nonce; lh_line_verifier=verifier' },
    }, sessionEnv(crossSiteEnv()));
    expect(res.status).toBe(302);
    const redirect = new URL(res.headers.get('Location')!);
    expect(redirect.origin).toBe(PAGES);
    expect(new URLSearchParams(redirect.hash.slice(1)).get('lh_session')).toBeTruthy();
    expect(new URLSearchParams(redirect.hash.slice(1)).get('lh_csrf')).toBeTruthy();
    expect(cookieFor(res, 'lh_admin_session')).toBeTruthy();
    expect(cookieFor(res, 'lh_login_device')).toContain('HttpOnly; Secure; SameSite=None');
    expect(sessionDatabases[0].raw.prepare('SELECT COUNT(*) AS count FROM auth_known_devices WHERE staff_id=?').get('staff-1')).toEqual({ count: 1 });
    fetchSpy.mockRestore();
  });

  test('does not create a session for an unregistered LINE user', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ id_token: 'id-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'not-registered' }), { status: 200 }));
    const res = await app().request('/api/auth/line/callback?code=abc&state=expected', {
      headers: { Cookie: 'lh_line_state=expected; lh_line_nonce=nonce; lh_line_verifier=verifier' },
    }, crossSiteEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('/login?error=not_authorized');
    expect(cookieFor(res, 'lh_admin_session')).toBeUndefined();
    fetchSpy.mockRestore();
  });
});

describe('Authenticator verification', () => {
  test('valid code exchanges a short-lived challenge for a cross-site admin session', async () => {
    const db = await import('@line-crm/db');
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const masterKey = 'test-master-key-which-is-longer-than-32-characters';
    vi.mocked(db.getTwoFactorChallenge).mockResolvedValueOnce({
      token_hash: 'hash', staff_id: 'staff-1', expires_at: new Date(Date.now() + 60_000).toISOString(), attempts: 0, created_at: new Date().toISOString(),
      purpose: 'verify', remember: 0,
    });
    vi.mocked(db.getStaffById).mockResolvedValueOnce({
      id: 'staff-1', name: 'Staff One', email: 'staff@example.com', role: 'admin', access_level: 'full', api_key: 'hidden', line_user_id: 'U1', is_active: 1,
      permission_keys: '[]', notification_preferences: '{}', invite_status: 'active', invite_token_hash: null, invite_expires_at: null, email_verified_at: null, line_linked_at: null,
      totp_secret_enc: await encryptTotpSecret(secret, masterKey), totp_pending_secret_enc: null, totp_enabled_at: new Date().toISOString(), totp_last_used_step: null,
      tenant_id: '00000000-0000-4000-8000-000000000001',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    const step = Math.floor(Date.now() / 30_000);
    const testDb = createTestD1();
    const { sha256Hex } = await import('./auth.js');
    testDb.raw.prepare("INSERT INTO staff_members(id,name,role,api_key) VALUES ('staff-1','Fixture','admin','fixture-key')").run();
    testDb.raw.prepare('INSERT INTO admin_two_factor_challenges(token_hash,staff_id,expires_at,purpose) VALUES (?,?,?,?)')
      .run(await sha256Hex('challenge'), 'staff-1', new Date(Date.now()+60000).toISOString(), 'verify');
    const response = await app().request('/api/auth/two-factor/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken: 'challenge', code: await totpAtStep(secret, step) }),
    }, { ...crossSiteEnv(), DB: testDb.db, TOTP_ENCRYPTION_KEY: masterKey });
    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; data: { sessionToken?: string }; csrfToken: string };
    expect(body.success).toBe(true);
    expect(body.data.sessionToken).toBeTruthy();
    expect(body.csrfToken).toBeTruthy();
    expect(cookieFor(response, 'lh_admin_session')).toBeTruthy();
    expect(db.claimStaffTotpStep).toHaveBeenCalledWith(expect.anything(), 'staff-1', expect.any(Number));
    testDb.raw.close();
  });

  test.each(['operations.control', 'photo.original.download'])(
    'authenticated operator exchanges a TOTP code for a one-time %s step-up grant',
    async (purpose) => {
    const db = await import('@line-crm/db');
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const masterKey = 'test-master-key-which-is-longer-than-32-characters';
    vi.mocked(db.getStaffById).mockResolvedValueOnce({
      id: 'staff-1', name: 'Staff One', email: 'staff@example.com', role: 'admin', access_level: 'full', api_key: 'hidden', line_user_id: 'U1', is_active: 1,
      permission_keys: '[]', notification_preferences: '{}', invite_status: 'active', invite_token_hash: null, invite_expires_at: null, email_verified_at: null, line_linked_at: null,
      totp_secret_enc: await encryptTotpSecret(secret, masterKey), totp_pending_secret_enc: null, totp_enabled_at: new Date().toISOString(), totp_last_used_step: null,
      tenant_id: '00000000-0000-4000-8000-000000000001',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    const response = await app().request('/api/auth/step-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer staff-key' },
      body: JSON.stringify({
        purpose,
        code: await totpAtStep(secret, Math.floor(Date.now() / 30_000)),
      }),
    }, env({ TOTP_ENCRYPTION_KEY: masterKey }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { token: expect.any(String), purpose, expiresAt: expect.any(String) },
    });
    expect(db.createStepUpGrant).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      staffId: 'staff-1', purpose, tokenHash: expect.any(String),
    }));
    },
  );
});

describe('topology guard', () => {
  test('cross-site WITHOUT opt-in refuses login with an actionable error', async () => {
    const res = await app().request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'staff-key' }),
      headers: { 'Content-Type': 'application/json' },
    }, env({ ADMIN_ORIGIN: PAGES })); // 別サイト Cookie の明示許可がない構成を試す。

    expect(res.status).toBe(500);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/cross-site/i);
    expect(cookieFor(res, 'lh_admin_session')).toBeUndefined();
  });
});

describe('protected API access', () => {
  test('未定義の運営APIは通常staffの認証があっても200にしない', async () => {
    const res = await app().request('/api/ops/unknown', {
      headers: { Authorization: 'Bearer ops-staff-key' },
    }, crossSiteEnv());
    expect(res.status).not.toBe(200);
    expect(res.status).toBe(404);
  });

  test.each([
    '/api/rich-menu-images/rich-menus/account/group/page/image.png',
    '/api/rich-menu-groups/external/rich-menu-id/image?accountId=account',
  ])('リッチメニュー画像 %s は匿名アクセスを拒否する', async (path) => {
    expect((await app().request(path, {}, crossSiteEnv())).status).toBe(401);
  });

  test.each([
    '/api/rich-menu-images/rich-menus/account/group/page/image.png',
    '/api/rich-menu-groups/external/rich-menu-id/image?accountId=account',
  ])('リッチメニュー画像 %s は管理画面のセッションで取得できる', async (path) => {
    const res = await app().request(path, {
      headers: { Cookie: 'lh_admin_session=staff-key' },
    }, crossSiteEnv());
    expect(res.status).toBe(200);
  });

  test('accepts the admin session cookie (GET, no CSRF needed)', async () => {
    const res = await app().request('/api/protected', {
      headers: { Cookie: 'lh_admin_session=staff-key' },
    }, crossSiteEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string } };
    expect(body.data).toMatchObject({ id: 'staff-1', role: 'admin' });
  });

  test('still accepts Bearer tokens for SDK / MCP callers', async () => {
    const res = await app().request('/api/protected', {
      headers: { Authorization: 'Bearer env-key' },
    }, crossSiteEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string } };
    expect(body.data).toMatchObject({ id: 'env-owner', role: 'owner' });
  });

  test('accepts an admin session as a Bearer fallback for cross-site browsers', async () => {
    const res = await app().request('/api/protected', {
      headers: { Authorization: 'Bearer lh_session:staff-key' },
    }, crossSiteEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string; role: string } };
    expect(body.data).toMatchObject({ id: 'staff-1', role: 'admin' });
  });

  test('keeps read-only access when using the Bearer fallback', async () => {
    const get = await app().request('/api/auth/session', {
      headers: { Authorization: 'Bearer lh_session:viewer-session' },
    }, crossSiteEnv());
    expect(get.status).toBe(200);
    // 役割と読み取り専用は別々に持つ。読み取り専用でも元の役割は残る。
    const body = await get.json() as { data: { role: string; readOnly: boolean } };
    expect(body.data.role).toBe('staff');
    expect(body.data.readOnly).toBe(true);

    const post = await app().request('/api/protected', {
      method: 'POST',
      headers: { Authorization: 'Bearer lh_session:viewer-session' },
    }, crossSiteEnv());
    expect(post.status).toBe(403);
  });

  test('rejects requests with no credentials', async () => {
    const res = await app().request('/api/protected', {}, crossSiteEnv());
    expect(res.status).toBe(401);
  });

  test('allows read-only accounts to read authenticated APIs', async () => {
    const res = await app().request('/api/auth/session', { headers: { Authorization: 'Bearer viewer-key' } }, crossSiteEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { role: string; readOnly: boolean } };
    expect(body.data.role).toBe('staff');
    expect(body.data.readOnly).toBe(true);
  });

  test('blocks read-only accounts from state-changing API methods', async () => {
    const res = await app().request('/api/protected', { method: 'POST', headers: { Authorization: 'Bearer viewer-key' } }, crossSiteEnv());
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toMatch(/閲覧のみ/);
  });

  test('a malformed cookie value yields 401, not a 500', async () => {
    // 不正な % の復号で例外を投げないことを確かめる。
    const res = await app().request('/api/protected', {
      headers: { Cookie: 'lh_admin_session=%; other=%E0%A4%A' },
    }, crossSiteEnv());
    expect(res.status).toBe(401);
  });
});

describe('staff follower-import gate access', () => {
  test('staff with chat permission can read the visible store import state', async () => {
    const response = await app().request('/api/line-accounts/acc-1/follower-import', {
      headers: { Authorization: 'Bearer chats-key' },
    }, crossSiteEnv());
    expect(response.status).toBe(200);
  });

  test.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s cannot write import state', async method => {
    const response = await app().request('/api/line-accounts/acc-1/follower-import', {
      method, headers: { Authorization: 'Bearer chats-key' },
    }, crossSiteEnv());
    expect(response.status).toBe(403);
  });

  test.each(['detect', 'start', 'step'])('staff cannot run %s', async action => {
    const response = await app().request(`/api/line-accounts/acc-1/follower-import/${action}`, {
      method: 'POST', headers: { Authorization: 'Bearer chats-key' },
    }, crossSiteEnv());
    expect(response.status).toBe(403);
  });

  test.each(['/api/line-accounts/acc-1/follower-import/extra', '/api/line-accounts/acc-1/extra/follower-import'])(
    'the read exception does not allow %s', path => {
      expect(isStaffExplicitAllow('GET', path)).toBe(false);
    },
  );
});

describe('staff feature permissions', () => {
  const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
  test.each(['/api/friends/friend-1/%6Dessages', '/api/friends/friend-1/me%73sages'])(
    'F16: encoded chat path %s cannot use friend-only permission', async path => {
      expect((await app().request(path, bearer('friends-key'), crossSiteEnv())).status).toBe(403);
    },
  );

  test.each(['/api/support', '/api/operators', '/api/friends/friend-1/messages', '/api/friends/friend-1/%6Dessages', '/api/friends/friend-1/me%73sages'])(
    'chat permission protects %s',
    async (path) => {
      expect((await app().request(path, bearer('chats-key'), crossSiteEnv())).status).toBe(200);
      expect((await app().request(path, bearer('friends-key'), crossSiteEnv())).status).toBe(403);
    },
  );

  test.each([
    '/api/support-marks', '/api/saved-searches', '/api/folders', '/api/tag-groups',
    '/api/friends/friend-1/fields', '/api/friends/friend-1/support-mark',
    '/api/friends/support-mark/bulk',
  ])('friend-attributes permission protects %s', async (path) => {
    expect((await app().request(path, bearer('tags-key'), crossSiteEnv())).status).toBe(200);
    expect((await app().request(path, bearer('friends-key'), crossSiteEnv())).status).toBe(403);
  });

  test('friend permission still allows ordinary friend APIs but not nested chat or attributes', async () => {
    expect((await app().request('/api/friends/friend-1', bearer('friends-key'), crossSiteEnv())).status).toBe(200);
    expect((await app().request('/api/friends/friend-1/messages', bearer('friends-key'), crossSiteEnv())).status).toBe(403);
    expect((await app().request('/api/friends/friend-1/fields', bearer('friends-key'), crossSiteEnv())).status).toBe(403);
  });

  test('mileage permission protects mileage APIs', async () => {
    expect((await app().request('/api/mileage/history', bearer('mileage-key'), crossSiteEnv())).status).toBe(200);
    expect((await app().request('/api/mileage/history', bearer('friends-key'), crossSiteEnv())).status).toBe(403);
    expect((await app().request('/api/action-scores/rules', bearer('mileage-key'), crossSiteEnv())).status).toBe(200);
    expect((await app().request('/api/action-scores/rules', bearer('friends-key'), crossSiteEnv())).status).toBe(403);
  });

  test('auto-reply permission protects execution results', async () => {
    expect((await app().request('/api/auto-reply-runs', bearer('auto-replies-key'), crossSiteEnv())).status).toBe(200);
    expect((await app().request('/api/auto-reply-runs', bearer('friends-key'), crossSiteEnv())).status).toBe(403);
  });

  test('automation permission protects execution results', async () => {
    expect((await app().request('/api/automation-runs', bearer('automations-key'), crossSiteEnv())).status).toBe(200);
    expect((await app().request('/api/automation-runs', bearer('friends-key'), crossSiteEnv())).status).toBe(403);
  });

  test('booking permission protects phone customer reads and writes', async () => {
    for (const method of ['GET', 'POST']) {
      const path = '/api/booking/admin/customers';
      expect((await app().request(path, { ...bearer('booking-key'), method }, crossSiteEnv())).status)
        .toBe(200);
      expect((await app().request(path, { ...bearer('friends-key'), method }, crossSiteEnv())).status)
        .toBe(403);
    }
  });

  test('booking permission protects change/cancel (N-065 #623)', async () => {
    const path = '/api/booking/admin/requests/bk-1';
    expect((await app().request(path, { ...bearer('booking-key'), method: 'PATCH' }, crossSiteEnv())).status)
      .toBe(200);
    expect((await app().request(path, { ...bearer('friends-key'), method: 'PATCH' }, crossSiteEnv())).status)
      .toBe(403);
    expect((await app().request(path, { ...bearer('no-permissions-key'), method: 'PATCH' }, crossSiteEnv())).status)
      .toBe(403);
  });

  test('meet consultations require the booking permission (N-065 #623)', async () => {
    const paths = [
      ['GET', '/api/meet-consultations'],
      ['POST', '/api/meet-consultations'],
      ['DELETE', '/api/meet-consultations/google-event-1'],
    ] as const;
    for (const [method, path] of paths) {
      // owner/admin は従来どおり通る。
      expect((await app().request(path, { ...bearer('staff-key'), method }, crossSiteEnv())).status)
        .toBe(200);
      // 予約権限つき staff は通る。
      expect((await app().request(path, { ...bearer('booking-key'), method }, crossSiteEnv())).status)
        .toBe(200);
      // 権限なし staff は 403。
      expect((await app().request(path, { ...bearer('friends-key'), method }, crossSiteEnv())).status)
        .toBe(403);
      expect((await app().request(path, { ...bearer('no-permissions-key'), method }, crossSiteEnv())).status)
        .toBe(403);
    }
    // read_only は書込み不可。
    expect((await app().request('/api/meet-consultations', { ...bearer('viewer-key'), method: 'POST' }, crossSiteEnv())).status)
      .toBe(403);
  });

  test('events permission protects booking decide/cancel/update (N-065 #623)', async () => {
    const paths = [
      ['PUT', '/api/events/admin/events/ev-1/bookings/bk-1'],
      ['POST', '/api/events/admin/events/ev-1/bookings/bk-1/decide'],
      ['POST', '/api/events/admin/events/ev-1/bookings/bk-1/cancel'],
    ] as const;
    for (const [method, path] of paths) {
      expect((await app().request(path, { ...bearer('events-key'), method }, crossSiteEnv())).status)
        .toBe(200);
      expect((await app().request(path, { ...bearer('friends-key'), method }, crossSiteEnv())).status)
        .toBe(403);
      expect((await app().request(path, { ...bearer('no-permissions-key'), method }, crossSiteEnv())).status)
        .toBe(403);
    }
  });

  test('permission mapping matches the production routes (N-065 #623)', async () => {
    const { permissionForApiPath } = await import('./auth.js');
    // 予約の変更・取消と個別相談は予約権限、イベント口はイベント権限。
    expect(permissionForApiPath('/api/booking/admin/requests/bk-1')).toBe('/booking/bookings');
    expect(permissionForApiPath('/api/meet-consultations')).toBe('/booking/bookings');
    expect(permissionForApiPath('/api/meet-consultations/google-event-1')).toBe('/booking/bookings');
    expect(permissionForApiPath('/api/events/admin/events/ev-1/bookings/bk-1')).toBe('/events');
    expect(permissionForApiPath('/api/events/admin/events/ev-1/bookings/bk-1/decide')).toBe('/events');
    expect(permissionForApiPath('/api/events/admin/events/ev-1/bookings/bk-1/cancel')).toBe('/events');
    // 公開コールバックは権限の対象外。
    expect(permissionForApiPath('/api/meet-callback')).toBeNull();
    // 細かい権限のマッピング。広い /api/booking → /booking/bookings より先に解決する。
    expect(permissionForApiPath('/api/booking/admin/menus')).toBe('/booking/menus');
    expect(permissionForApiPath('/api/booking/admin/menus/m-1')).toBe('/booking/menus');
    expect(permissionForApiPath('/api/booking/admin/staff-menus')).toBe('/booking/menus');
    expect(permissionForApiPath('/api/booking/admin/staff/s-1/menus')).toBe('/booking/menus');
    expect(permissionForApiPath('/api/booking/admin/staff/me')).toBe('booking.staff.own');
    expect(permissionForApiPath('/api/booking/admin/staff/s-1/shifts')).toBe('booking.staff.own');
    expect(permissionForApiPath('/api/booking/admin/staff/s-1/availability-rules')).toBe('booking.staff.own');
    expect(permissionForApiPath('/api/booking/admin/staff/s-1/breaks')).toBe('booking.staff.own');
    expect(permissionForApiPath('/api/booking/admin/staff/s-1/break-dates')).toBe('booking.staff.own');
    expect(permissionForApiPath('/api/booking/admin/staff/s-1/google-calendar')).toBe('booking.staff.own');
    // スタッフ登録・設定・予約台帳は従来の広いキーへ落ちる（route 側で細かいキーを要求）。
    expect(permissionForApiPath('/api/booking/admin/staff')).toBe('/booking/bookings');
    expect(permissionForApiPath('/api/booking/admin/settings')).toBe('/booking/bookings');
    expect(permissionForApiPath('/api/booking/admin/bookings')).toBe('/booking/bookings');
  });

  test('N-411: 予約の細かい権限が middleware 第一段階で分離される', async () => {
    // メニューは /booking/menus キー。予約管理だけでは通らない。
    expect((await app().request('/api/booking/admin/menus', bearer('booking-menus-key'), crossSiteEnv())).status).toBe(200);
    expect((await app().request('/api/booking/admin/menus', bearer('booking-key'), crossSiteEnv())).status).toBe(403);
    // 本人勤務は booking.staff.own キー。予約管理・メニューでは通らない。
    expect((await app().request('/api/booking/admin/staff/me', bearer('booking-own-key'), crossSiteEnv())).status).toBe(200);
    expect((await app().request('/api/booking/admin/staff/s-1/shifts', bearer('booking-own-key'), crossSiteEnv())).status).toBe(200);
    expect((await app().request('/api/booking/admin/staff/s-1/shifts', bearer('booking-key'), crossSiteEnv())).status).toBe(403);
    expect((await app().request('/api/booking/admin/staff/s-1/shifts', bearer('booking-menus-key'), crossSiteEnv())).status).toBe(403);
    // 見えるだけキーは GET だけ通し、変更系は 403。
    expect((await app().request('/api/booking/admin/staff/s-1/shifts', bearer('booking-own-view-key'), crossSiteEnv())).status).toBe(200);
    expect((await app().request('/api/booking/admin/staff/s-1/shifts', { ...bearer('booking-own-view-key'), method: 'PUT' }, crossSiteEnv())).status).toBe(403);
    // キー無しは fail-closed。
    expect((await app().request('/api/booking/admin/menus', bearer('no-permissions-key'), crossSiteEnv())).status).toBe(403);
    expect((await app().request('/api/booking/admin/staff/me', bearer('no-permissions-key'), crossSiteEnv())).status).toBe(403);
  });

  test('写真審査は閲覧・判断・一括判断・原本取得の専用権限を分離する', async () => {
    const checks = [
      ['GET', '/api/nen-members/photos', 'photo-view-key'],
      ['GET', '/api/nen-members/photos/photo-1/assets/status', 'photo-view-key'],
      ['POST', '/api/nen-members/photos/photo-1/review', 'photo-review-key'],
      ['POST', '/api/nen-members/photos/photo-1/assets/process', 'photo-review-key'],
      ['POST', '/api/nen-members/photos/decisions/bulk', 'photo-bulk-key'],
      ['POST', '/api/nen-members/photos/photo-1/original-download', 'photo-download-key'],
      ['GET', '/api/nen-members/photos/original-download/token', 'photo-download-key'],
    ] as const;
    for (const [method, path, token] of checks) {
      expect((await app().request(path, { ...bearer(token), method }, crossSiteEnv())).status).toBe(200);
      expect((await app().request(path, { ...bearer('no-permissions-key'), method }, crossSiteEnv())).status).toBe(403);
    }
  });

  test.each(['/api/support', '/api/friends/friend-1', '/api/support-marks'])(
    'missing feature permission fails closed for %s',
    async (path) => {
      expect((await app().request(path, bearer('no-permissions-key'), crossSiteEnv())).status).toBe(403);
    },
  );

  test.each(['/api/media', '/api/media/md-1/download', '/api/media/md-1/content'])(
    'contents permission protects %s (fail-closed)',
    async (path) => {
      expect((await app().request(path, bearer('contents-key'), crossSiteEnv())).status).toBe(200);
      expect((await app().request(path, bearer('friends-key'), crossSiteEnv())).status).toBe(403);
      expect((await app().request(path, bearer('no-permissions-key'), crossSiteEnv())).status).toBe(403);
    },
  );
});

describe('public form method boundaries', () => {
  test('allows unauthenticated GET of a form definition', async () => {
    const res = await app().request('/api/forms/form-1', {}, crossSiteEnv());
    expect(res.status).toBe(200);
    expect((await res.json() as { staff: unknown }).staff).toBeNull();
  });

  test('authenticates an admin GET so the route can return private settings', async () => {
    const res = await app().request('/api/forms/form-1', {
      headers: { Authorization: 'Bearer env-key' },
    }, crossSiteEnv());
    expect(res.status).toBe(200);
    expect((await res.json() as { staff: { role: string } }).staff.role).toBe('owner');
  });

  test.each(['PUT', 'DELETE'])('%s on the same form path requires admin auth', async (method) => {
    const res = await app().request('/api/forms/form-1', { method }, crossSiteEnv());
    expect(res.status).toBe(401);
  });

  test.each(['submit', 'partial', 'opened'])(
    'allows POST /%s through to route-level LIFF authentication',
    async (action) => {
      const res = await app().request(`/api/forms/form-1/${action}`, {
        method: 'POST',
      }, crossSiteEnv());
      expect(res.status).toBe(200);
    },
  );

  test('does not exempt the wrong method on a public action path', async () => {
    const res = await app().request('/api/forms/form-1/submit', {
      method: 'DELETE',
    }, crossSiteEnv());
    expect(res.status).toBe(401);
  });
});

describe('公開サイト計測の認証境界', () => {
  test.each([
    ['GET', '/api/site/script.js'],
    ['POST', '/api/site/collect'],
  ])('%s %s は管理者認証より前へ通す', async (method, path) => {
    const res = await app().request(path, { method }, crossSiteEnv());
    expect(res.status).toBe(200);
    expect((await res.json() as { staff: unknown }).staff).toBeNull();
  });
});

describe('署名検証を持つSlack連携入口', () => {
  test.each([
    '/api/integrations/codex-slack/events',
    '/api/integrations/ai-loop/reports',
    '/api/integrations/slack/actions',
    '/api/integrations/slack/events',
  ])('%s は管理者認証より前へ通す', async (path) => {
    const res = await app().request(path, { method: 'POST' }, crossSiteEnv());
    expect(res.status).toBe(200);
  });
});

describe('ログイン画面の看板', () => {
  // ログイン画面は認証より手前にあるので、ここが通らないと名前もアイコンも
  // 出せない。逆に通しすぎると認証の穴になるので、この1本で固定する。
  test('認証なしで読める', async () => {
    const res = await app().request('/api/public/brand', {}, crossSiteEnv());
    expect(res.status).toBe(200);
    expect((await res.json() as { staff: unknown }).staff).toBeNull();
  });

  test('似た名前の道は通さない', async () => {
    const res = await app().request('/api/public/brands', {}, crossSiteEnv());
    expect(res.status).toBe(401);
  });
});

describe('CSRF protection', () => {
  test('cookie-authenticated POST without an X-CSRF-Token is rejected', async () => {
    const res = await app().request('/api/protected', {
      method: 'POST',
      headers: { Cookie: 'lh_admin_session=staff-key; lh_csrf=token-abc' },
    }, crossSiteEnv());
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toMatch(/csrf/i);
  });

  test('cookie-authenticated POST with a mismatched token is rejected', async () => {
    const res = await app().request('/api/protected', {
      method: 'POST',
      headers: {
        Cookie: 'lh_admin_session=staff-key; lh_csrf=token-abc',
        'X-CSRF-Token': 'token-WRONG',
      },
    }, crossSiteEnv());
    expect(res.status).toBe(403);
  });

  test('cookie-authenticated POST with a matching double-submit token succeeds', async () => {
    const res = await app().request('/api/protected', {
      method: 'POST',
      headers: {
        Cookie: 'lh_admin_session=staff-key; lh_csrf=token-abc',
        'X-CSRF-Token': 'token-abc',
      },
    }, crossSiteEnv());
    expect(res.status).toBe(200);
  });

  test('Bearer POST is exempt from CSRF (not cookie-driven)', async () => {
    const res = await app().request('/api/protected', {
      method: 'POST',
      headers: { Authorization: 'Bearer env-key' },
    }, crossSiteEnv());
    expect(res.status).toBe(200);
  });
});

describe('logout', () => {
  test('expires both the session and CSRF cookies', async () => {
    const res = await app().request('/api/auth/logout', { method: 'POST' }, crossSiteEnv());
    expect(res.status).toBe(200);
    const session = cookieFor(res, 'lh_admin_session') ?? '';
    const csrf = cookieFor(res, 'lh_csrf') ?? '';
    expect(session).toContain('Max-Age=0');
    expect(csrf).toContain('Max-Age=0');
  });

  test('revokes a Bearer fallback admin session', async () => {
    const db = await import('@line-crm/db');
    const deleteSession = vi.mocked(db.deleteAdminSession);
    deleteSession.mockClear();
    const res = await app().request('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: 'Bearer lh_session:staff-key' },
    }, crossSiteEnv());
    expect(res.status).toBe(200);
    expect(deleteSession).toHaveBeenCalledWith(
      expect.anything(),
      'c1e9199b97100cfa89cf5335e39753c0ee4caddde90d79bf5ca16ab99d4a7d9a',
    );
  });
});

describe('session endpoint', () => {
  test('returns the staff identity and a CSRF token', async () => {
    const res = await app().request('/api/auth/session', {
      headers: { Cookie: 'lh_admin_session=staff-key; lh_csrf=token-abc' },
    }, crossSiteEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string }; csrfToken: string };
    expect(body.data).toMatchObject({ id: 'staff-1' });
    expect(body.csrfToken).toBe('token-abc');
  });

  test('mints and sets a CSRF cookie when none is present', async () => {
    const res = await app().request('/api/auth/session', {
      headers: { Cookie: 'lh_admin_session=staff-key' },
    }, crossSiteEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { csrfToken: string };
    expect(body.csrfToken).toBeTruthy();
    expect(cookieFor(res, 'lh_csrf') ?? '').toContain(`lh_csrf=${body.csrfToken}`);
  });
});

describe('CORS allowed / blocked origins', () => {
  test('allowlisted admin origin is echoed back', async () => {
    const res = await app().request('/api/protected', {
      headers: { Origin: PAGES, Cookie: 'lh_admin_session=staff-key' },
    }, crossSiteEnv());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(PAGES);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  test('Cloudflare Pages preview origin for the admin project is echoed back', async () => {
    const preview = 'https://abc123.your-admin.pages.dev';
    const res = await app().request('/api/protected', {
      headers: { Origin: preview, Cookie: 'lh_admin_session=staff-key' },
    }, crossSiteEnv());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(preview);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  test('login preflight succeeds from a Cloudflare Pages preview origin', async () => {
    const preview = 'https://abc123.your-admin.pages.dev';
    const res = await app().request('/api/auth/login', {
      method: 'OPTIONS',
      headers: {
        Origin: preview,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    }, crossSiteEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(preview);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  test('unknown origin gets no Access-Control-Allow-Origin header', async () => {
    const res = await app().request('/api/protected', {
      headers: { Origin: 'https://evil.example.com', Cookie: 'lh_admin_session=staff-key' },
    }, crossSiteEnv());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('N-423 staff deny-by-default (#670)', () => {
  const staffBearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

  test('所属統括の問い合わせ集計はスタッフと閲覧のみも読め、認証なしと更新は通さない',async()=>{
    for(const token of ['no-permissions-key','viewer-key']) {
      expect((await app().request('/api/hq/support/summary',staffBearer(token),crossSiteEnv())).status).toBe(200);
      expect((await app().request('/api/hq/support/summary',{...staffBearer(token),method:'POST'},crossSiteEnv())).status).toBe(403);
    }
    expect((await app().request('/api/hq/support/summary',{},crossSiteEnv())).status).toBe(401);
  });

  test.each(['GET', 'POST'] as const)('%s 未登録の管理APIは staff に 403', async (method) => {
    for (const token of ['friends-key', 'no-permissions-key']) {
      const res = await app().request('/api/coverage-unmapped-demo', { ...staffBearer(token), method }, crossSiteEnv());
      expect(res.status).toBe(403);
      expect((await res.json() as { error: string }).error).toBe('この機能を操作する権限がありません');
    }
  });

  test.each(['GET', 'POST'] as const)('%s 未登録でも owner/admin は通る', async (method) => {
    // staff-key は管理者、env-key はオーナーとして受け付ける。
    for (const token of ['staff-key', 'env-key']) {
      const res = await app().request('/api/coverage-unmapped-demo', { ...staffBearer(token), method }, crossSiteEnv());
      expect(res.status).toBe(200);
    }
  });

  test('未登録は認証なしだと 401 (403 の手前で止める)', async () => {
    expect((await app().request('/api/coverage-unmapped-demo', {}, crossSiteEnv())).status).toBe(401);
  });

  test('追加した権限表が staff の可否を分ける', async () => {
    // /rich-menus 鍵つきは通る。
    expect((await app().request('/api/rich-menu-groups', staffBearer('rich-menus-key'), crossSiteEnv())).status).toBe(200);
    // 別の鍵・鍵なしは 403。
    expect((await app().request('/api/rich-menu-groups', staffBearer('friends-key'), crossSiteEnv())).status).toBe(403);
    expect((await app().request('/api/rich-menu-groups', staffBearer('no-permissions-key'), crossSiteEnv())).status).toBe(403);
  });

  test('起動時のセッション取得は staff でも通る', async () => {
    const res = await app().request('/api/auth/session', staffBearer('friends-key'), crossSiteEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { role: string } };
    expect(body.data.role).toBe('staff');
  });

  test('運営会社の staff は通常の画面権限ではなく platform_admins で /api/ops を判定する', async () => {
    const allowed = await app().request('/api/ops/me', staffBearer('ops-staff-key'), crossSiteEnv());
    expect(allowed.status).toBe(200);
    expect((await allowed.json() as { data: { id: string } }).data.id).toBe('ops-staff-1');

    const denied = await app().request('/api/ops/me', staffBearer('no-permissions-key'), crossSiteEnv());
    expect(denied.status).toBe(403);
    expect((await denied.json() as { error: string }).error).toBe('運営コンソールを使う権限がありません');
  });

  test('追加した権限表の対応', () => {
    expect(permissionForApiPath('/api/rich-menus')).toBe('/rich-menus');
    expect(permissionForApiPath('/api/rich-menus/m1')).toBe('/rich-menus');
    expect(permissionForApiPath('/api/rich-menu-groups')).toBe('/rich-menus');
    expect(permissionForApiPath('/api/rich-menu-groups/g1/publish')).toBe('/rich-menus');
    expect(permissionForApiPath('/api/rich-menu-images/key')).toBe('/rich-menus');
    expect(permissionForApiPath('/api/friend-add-rules')).toBe('/friend-add-settings');
    expect(permissionForApiPath('/api/friend-add-runs/r1')).toBe('/friend-add-settings');
    expect(permissionForApiPath('/api/scoring-rules')).toBe('/scoring');
    expect(permissionForApiPath('/api/common-vars')).toBe('/contents/vars');
    expect(permissionForApiPath('/api/common-vars/v1/schedules')).toBe('/contents/vars');
    expect(permissionForApiPath('/api/entry-routes')).toBe('/inflow-links');
    expect(permissionForApiPath('/api/entry-route-genres')).toBe('/inflow-links');
    expect(permissionForApiPath('/api/message-templates')).toBe('/inflow-links');
    expect(permissionForApiPath('/api/funnels')).toBe('/analytics');
    expect(permissionForApiPath('/api/support-mark-rules/r1')).toBe('/tags');
    expect(permissionForApiPath('/api/friend-reminders/fr1')).toBe('/reminders');
    expect(permissionForApiPath('/api/reminder-runs/rr1/retry')).toBe('/reminders');
    expect(permissionForApiPath('/api/line-notifications/deliveries')).toBe('/line-notifications');
    expect(permissionForApiPath('/api/dashboard/overview')).toBe('/');
    expect(permissionForApiPath('/api/getting-started')).toBe('/getting-started');
    // 帰属を決められない集計は未登録のまま fail-closed。
    expect(permissionForApiPath('/api/list-stats')).toBeNull();
    expect(permissionForApiPath('/api/account-handovers')).toBeNull();
    expect(permissionForApiPath('/api/coverage-unmapped-demo')).toBeNull();
  });

  test('本人・自組織の口は役割に関わらず通す', () => {
    for (const [method, path] of [
      ['GET', '/api/auth/session'],
      ['POST', '/api/auth/step-up'],
      ['GET', '/api/staff/me'],
      ['GET', '/api/staff/abc'],
      ['PATCH', '/api/staff/abc'],
      ['POST', '/api/staff/abc/two-factor/setup'],
      ['POST', '/api/staff/abc/two-factor/confirm'],
      ['DELETE', '/api/staff/abc/two-factor'],
      ['GET', '/api/tenants/me'],
      ['GET', '/api/settings/company'],
      ['POST', '/api/client-errors'],
      ['GET', '/api/capabilities'],
      ['GET', '/api/line-accounts'],
      ['GET', '/api/line-accounts/summary'],
      ['GET', '/api/settings/features/visibility'],
      ['POST', '/api/images'],
    ] as const) {
      expect(isStaffSelfEndpoint(method, path, 'abc')).toBe(true);
    }
  });

  test('本人・自組織の口の method 違い・他人宛て・固定path候補は通さない', () => {
    for (const [method, path] of [
      ['POST', '/api/auth/session'],
      ['GET', '/api/auth/step-up'],
      ['POST', '/api/staff/me'],
      ['DELETE', '/api/staff/abc'],
      ['POST', '/api/staff/abc'],
      ['GET', '/api/staff/abc/two-factor/setup'],
      ['GET', '/api/staff'],
      ['POST', '/api/staff'],
      ['PATCH', '/api/tenants/me'],
      ['PUT', '/api/settings/company'],
      ['GET', '/api/settings/company/other'],
      ['GET', '/api/client-errors'],
      ['POST', '/api/capabilities'],
      ['POST', '/api/line-accounts'],
      ['GET', '/api/line-accounts/abc'],
      ['GET', '/api/settings/features'],
      ['PUT', '/api/settings/features'],
      ['GET', '/api/images'],
      ['DELETE', '/api/images/abc'],
      ['GET', '/api/operations/health'],
      ['GET', '/api/staff/export'],
      ['PATCH', '/api/staff/policy'],
    ] as const) {
      expect(isStaffSelfEndpoint(method, path, 'abc')).toBe(false);
    }
    expect(isStaffSelfEndpoint('GET', '/api/staff/other', 'abc')).toBe(false);
    expect(isStaffSelfEndpoint('PATCH', '/api/staff/other', 'abc')).toBe(false);
  });

  test('実リクエストは本人IDだけ通し、同じ形の固定pathと他人IDを403にする', async () => {
    expect((await app().request('/api/staff/friends-1', staffBearer('friends-key'), crossSiteEnv())).status).toBe(200);
    expect((await app().request('/api/staff/friends-1', {
      ...staffBearer('friends-key'), method: 'PATCH',
    }, crossSiteEnv())).status).toBe(200);

    for (const [method, path, token] of [
      ['GET', '/api/staff/export', 'friends-key'],
      ['PATCH', '/api/staff/policy', 'friends-key'],
      ['GET', '/api/staff/friends-1', 'no-permissions-key'],
      ['PATCH', '/api/staff/friends-1', 'no-permissions-key'],
    ] as const) {
      const res = await app().request(path, { ...staffBearer(token), method }, crossSiteEnv());
      expect(res.status).toBe(403);
      expect((await res.json() as { error: string }).error).toBe('この機能を操作する権限がありません');
    }
  });

  test('明示許可の写しは route の staff 許可と一致する (司令塔裁定 #670)', () => {
    for (const [method, path] of [
      ['GET', '/api/staff'],
      ['GET', '/api/restaurant-test/stores'],
      ['GET', '/api/restaurant-test/store-context'],
      ['GET', '/api/restaurant-test/terms-agreement'],
      ['POST', '/api/restaurant-test/stores/selection/clear'],
      ['POST', '/api/restaurant-test/stores/abc/select'],
      ['GET', '/api/restaurant-test/snapshot'],
      ['POST', '/api/restaurant-test/reservations/manual'],
      ['POST', '/api/restaurant-test/channel-close-tasks/task/opened'],
    ] as const) {
      expect(isStaffExplicitAllow(method, path)).toBe(true);
    }
    for (const [method, path] of [
      ['POST', '/api/staff'],
      ['DELETE', '/api/staff/abc'],
      ['POST', '/api/restaurant-test/terms-agreement'],
      ['POST', '/api/restaurant-test/stores'],
      ['GET', '/api/restaurant-test/stores/abc/select'],
      ['POST', '/api/restaurant-test/intake-addresses'],
      ['GET', '/api/staff/me'],
    ] as const) {
      expect(isStaffExplicitAllow(method, path)).toBe(false);
    }
  });

  test('公開境界の method 境界', () => {
    expect(isPublicApiBoundary('GET', '/api/forms/f1')).toBe(true);
    expect(isPublicApiBoundary('PUT', '/api/forms/f1')).toBe(false);
    expect(isPublicApiBoundary('DELETE', '/api/forms/f1')).toBe(false);
    expect(isPublicApiBoundary('POST', '/api/forms/f1/submit')).toBe(true);
    expect(isPublicApiBoundary('POST', '/api/forms/f1/opened')).toBe(true);
    expect(isPublicApiBoundary('POST', '/api/forms/f1/partial')).toBe(true);
    expect(isPublicApiBoundary('POST', '/api/forms/f1/files')).toBe(true);
    expect(isPublicApiBoundary('GET', '/api/form-files/id/content')).toBe(false);
    expect(isPublicApiBoundary('PUT', '/api/forms/document-settings/account')).toBe(false);
    expect(isPublicApiBoundary('DELETE', '/api/forms/f1/submit')).toBe(false);
    expect(isPublicApiBoundary('POST', '/api/integrations/slack/events')).toBe(true);
    expect(isPublicApiBoundary('GET', '/api/webhooks/incoming/abc/receive')).toBe(true);
    expect(isPublicApiBoundary('GET', '/api/meet-callback')).toBe(true);
    expect(isPublicApiBoundary('GET', '/api/health')).toBe(true);
    expect(isPublicApiBoundary('GET', '/api/qr')).toBe(true);
    expect(isPublicApiBoundary('GET', '/api/public/brand')).toBe(true);
    expect(isPublicApiBoundary('GET', '/api/liff/config')).toBe(true);
    expect(isPublicApiBoundary('POST', '/api/auth/register/request')).toBe(true);
    expect(isPublicApiBoundary('GET', '/api/auth/register/check')).toBe(true);
    expect(isPublicApiBoundary('POST', '/api/auth/password/login')).toBe(true);
    expect(isPublicApiBoundary('POST', '/api/auth/password/forgot')).toBe(true);
    expect(isPublicApiBoundary('GET', '/api/auth/password/reset/check')).toBe(true);
    expect(isPublicApiBoundary('POST', '/api/auth/password/reset')).toBe(true);
    expect(isPublicApiBoundary('GET', '/api/protected')).toBe(false);
    expect(isPublicApiBoundary('GET', '/api/public/brands')).toBe(false);
    expect(isPublicApiBoundary('GET', '/api/auth/session')).toBe(false);
    expect(isPublicApiBoundary('GET', '/api/staff')).toBe(false);
  });

  test.each(['suspended-key', 'archived-key'])(
    '停止・保管中の契約先は通常APIと配信操作を403にする (%s)',
    async (token) => {
      for (const [method, path] of [
        ['GET', '/api/friends'],
        ['POST', '/api/broadcasts/b1/send'],
      ] as const) {
        const res = await app().request(path, { ...staffBearer(token), method }, crossSiteEnv());
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({
          success: false,
          code: 'TENANT_SUSPENDED',
        });
      }
    },
  );

  test('停止中セッションはsession・logout・お問い合わせ・運営からのお知らせだけ利用できる', async () => {
    const session = await app().request('/api/auth/session', staffBearer('suspended-key'), crossSiteEnv());
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ success: true, data: { tenantStatus: 'suspended' } });

    for (const [method, path] of [
      ['POST', '/api/auth/logout'],
      ['POST', '/api/hq/support/requests'],
      ['GET', '/api/hq/support/requests'],
      ['GET', '/api/hq/notices'],
      ['POST', '/api/hq/notices/notice-1/read'],
    ] as const) {
      expect((await app().request(path, { ...staffBearer('suspended-key'), method }, crossSiteEnv())).status).toBe(200);
    }

    for (const [method, path] of [
      ['GET', '/api/friends'],
      ['POST', '/api/broadcasts/b1/send'],
      ['GET', '/api/tenants/me'],
      ['POST', '/api/hq/notices'],
    ] as const) {
      const res = await app().request(path, { ...staffBearer('suspended-key'), method }, crossSiteEnv());
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'TENANT_SUSPENDED' });
    }
  });

  test('運営マスターの有効な代理ログインは停止中契約先を閲覧できる', async () => {
    const db = await import('@line-crm/db');
    vi.mocked(db.getActiveImpersonation).mockResolvedValueOnce({
      id: 'impersonation-1',
      platform_admin_staff_id: 'ops-staff-1',
      tenant_id: 'tenant-stopped',
      mode: 'read',
      pii_revealed: 0,
      started_at: '2026-09-24T00:00:00.000Z',
      expires_at: '2026-09-24T08:00:00.000Z',
      ended_at: null,
      reason: null,
    } as never);
    vi.mocked(db.getStaffByAdminSession).mockResolvedValueOnce({ id: 'ops-staff-1', name: 'Fixture operator', role: 'staff', is_active: 1 } as never);
    const res = await app().request('/api/friends', staffBearer('lh_session:ops-session-fixture'), crossSiteEnv());
    expect(res.status).toBe(200);
  });
});

describe('SEC-02 管理フォームの下書き権限', () => {
 test('フォーム権限のない担当者はaccount_idを付けても管理定義を読めない', async()=>{
  const res=await app().request('/api/forms/form-1?account_id=a',{headers:{Authorization:'Bearer no-permissions-key'}},crossSiteEnv());
  expect(res.status).toBe(403);
 });
 test('停止した統括の管理者は下書きを読めない',async()=>{
  expect((await app().request('/api/forms/form-1?account_id=a',{headers:{Authorization:'Bearer suspended-key'}},crossSiteEnv())).status).toBe(403);
 });
 test('管理者の下書き取得と認証なしの公開取得を保つ',async()=>{
  expect((await app().request('/api/forms/form-1?account_id=a',{headers:{Authorization:'Bearer env-key'}},crossSiteEnv())).status).toBe(200);
  expect((await app().request('/api/forms/form-1',{},crossSiteEnv())).status).toBe(200);
 });
});

test.each(['no-permissions-key', 'viewer-key'])('店舗の設定状況は %s でもGETだけ読める', async token => {
 const headers = { Authorization: `Bearer ${token}` };
 expect((await app().request('/api/restaurant-test/setup-progress', { headers }, crossSiteEnv())).status).toBe(200);
 expect((await app().request('/api/restaurant-test/setup-progress', { method: 'POST', headers }, crossSiteEnv())).status).toBe(403);
});


test('閲覧のみは明示保存の印があっても初期メニューの保存へ入れない',async()=>{
 const response=await app().request('/api/dashboard/style',{method:'PUT',headers:{Authorization:'Bearer viewer-key','Content-Type':'application/json'},body:JSON.stringify({expectedVersion:1,confirmInitialMenu:true,answers:{image:{mode:'configured',value:'simple'}}})},crossSiteEnv());
 expect(response.status).toBe(403);
});
