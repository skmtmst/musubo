import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { hashPassword } from '../services/password-hash.js';
import { createAuthEmailToken, toJstString } from '@line-crm/db';
import { sha256Hex } from '../middleware/auth.js';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from '@line-crm/shared';

const mail = vi.hoisted(() => ({
  sendPlainMail: vi.fn(async (_env: unknown, _message: { to: string; subject: string; body: string; html?: string }) => {}),
}));
vi.mock('../services/plain-mail.js', () => ({ sendPlainMail: mail.sendPlainMail }));

const turnstile = vi.hoisted(() => ({ result: { ok: true } as { ok: true } | { ok: false; reason: 'not_configured' | 'missing_token' | 'rejected' | 'unavailable' } }));
vi.mock('../services/turnstile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/turnstile.js')>();
  return { ...actual, verifyTurnstile: vi.fn(async () => turnstile.result) };
});

const { authEmail } = await import('./auth-email.js');

let testDb: SqliteD1;

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB: testDb.db,
    ADMIN_ORIGIN: 'https://admin.example.com',
    ADMIN_PUBLIC_URL: 'https://admin.example.com',
    TURNSTILE_SECRET_KEY: 'turnstile-secret-for-test',
    TOTP_ENCRYPTION_KEY: 'test-master-key-which-is-longer-than-32-characters',
    ...overrides,
  } as Env['Bindings'];
}

function app() {
  const instance = new Hono<Env>();
  instance.route('/', authEmail);
  return instance;
}

type AuthJson = {
  csrfToken: string;
  code: string;
  error: string;
  errors: Record<string, string>;
  data: {
    email: string;
    trialDays: number | null;
    trialPeriod?: { unit: 'days' | 'months'; value: number };
    deviceMarker: string;
    tenantId: string;
    twoFactor: boolean;
    twoFactorSetup: boolean;
    challengeToken: string;
    newPricingFlow?: boolean;
  };
};

async function json(response: Response): Promise<AuthJson> {
  return response.json() as Promise<AuthJson>;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  opts: { env?: Partial<Env['Bindings']>; headers?: Record<string, string>; ip?: string } = {},
) {
  return app().request(
    `https://api.example.com${path}`,
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        'cf-connecting-ip': opts.ip ?? '203.0.113.10',
        ...(opts.headers ?? {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env(opts.env),
  );
}

/** 送ったメールの本文から URL のトークンを取り出す。 */
function lastMailToken(): string {
  const last = mail.sendPlainMail.mock.calls.at(-1)?.[1] as { body: string } | undefined;
  const match = last?.body.match(/token=([A-Za-z0-9_%-]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function lastMailSubject(): string {
  return (mail.sendPlainMail.mock.calls.at(-1)?.[1] as { subject: string } | undefined)?.subject ?? '';
}

beforeEach(() => {
  testDb = createTestD1({ loginPolicy: 'off' });
  mail.sendPlainMail.mockClear();
  turnstile.result = { ok: true };
});

const validRequest = { email: 'Owner@Example.com', companyName: '株式会社サンプル', contactName: '山田 太郎', phone: '03-1234-5678', referralSource: 'インターネット検索', turnstileToken: 'tok', agreed: true };

async function issueApprovedInvite(): Promise<string> {
  const application = testDb.raw.prepare('SELECT id FROM registration_applications WHERE email = ?').get('owner@example.com') as { id: string };
  testDb.raw.prepare("UPDATE registration_applications SET status = 'approved', contact_note = '連絡済み', contacted_at = '2026-10-29 12:00:00', approved_at = '2026-10-29 12:01:00' WHERE id = ?").run(application.id);
  const token = 'approved_registration_token_0123456789';
  await createAuthEmailToken(testDb.db, { purpose: 'signup', tokenHash: await sha256Hex(token), email: 'owner@example.com', applicationId: application.id, expiresAt: toJstString(new Date(Date.now() + 3600000)) });
  return token;
}

describe('会員登録（36-4）', () => {
  it('新料金で承認した申込はカード・LINE接続前に無料期間を開始しない', async () => {
    await call('POST', '/api/auth/register/request', validRequest);
    const token = await issueApprovedInvite();
    const snapshot = JSON.stringify({ sourceConditionId: 'partner', sourceVersion: 1,
      internalName: '特約店', appliedAt: '2026-11-09',
      trialPeriod: { unit: 'months', value: 3 }, lineBasicDiscountPercent: 50,
      discountEndsOn: null, schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE });
    testDb.raw.prepare('UPDATE registration_applications SET pricing_condition_id=?,pricing_snapshot_json=?')
      .run('partner', snapshot);
    const checked = await call('GET', `/api/auth/register/check?token=${encodeURIComponent(token)}`);
    expect((await json(checked)).data).toMatchObject({ trialDays: null,
      trialPeriod: { unit: 'months', value: 3 } });
    const completed = await call('POST', '/api/auth/register/complete', {
      token, tenantName: '株式会社サンプル', name: '山田 太郎', password: 'StrongPassword1!',
    });
    expect(completed.status).toBe(200);
    const completedBody = await json(completed);
    expect(completedBody.data.newPricingFlow).toBe(true);
    const tenantId = completedBody.data.tenantId;
    expect(testDb.raw.prepare('SELECT plan_status,trial_ends_at FROM tenants WHERE id=?').get(tenantId))
      .toEqual({ plan_status: 'exempt', trial_ends_at: null });
    expect(testDb.raw.prepare(`SELECT status,first_line_activated_at,first_charge_date
      FROM musubo_tenant_billing WHERE tenant_id=?`).get(tenantId))
      .toEqual({ status: 'awaiting_first_line', first_line_activated_at: null, first_charge_date: null });
  });
  it('期限切れの承認リンクは登録先だけに24時間の新リンクを送り、旧リンクを失効させる', async () => {
    await call('POST', '/api/auth/register/request', validRequest);
    const token = await issueApprovedInvite();
    testDb.raw.prepare('UPDATE auth_email_tokens SET expires_at = ? WHERE token_hash = ?')
      .run(toJstString(new Date(Date.now() - 1_000)), await sha256Hex(token));

    const checked = await call('GET', `/api/auth/register/check?token=${encodeURIComponent(token)}`);
    expect(checked.status).toBe(410);
    const checkBody = await checked.json() as { code: string; data: { maskedEmail: string } };
    expect(checkBody.code).toBe('expired');
    expect(checkBody.data.maskedEmail).toBe('o•••@example.com');

    const resent = await call('POST', '/api/auth/register/resend-expired', { token });
    expect(resent.status).toBe(200);
    expect(lastMailSubject()).toBe('【musubo】アカウント作成のご案内（再送）');
    const newToken = lastMailToken();
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(token);
    const sentMail = mail.sendPlainMail.mock.calls.at(-1)?.[1];
    expect(sentMail?.to).toBe('owner@example.com');
    expect(sentMail?.html).toContain('アカウント作成へ');
    expect((await call('GET', `/api/auth/register/check?token=${encodeURIComponent(newToken)}`)).status).toBe(200);
    expect((await call('GET', `/api/auth/register/check?token=${encodeURIComponent(token)}`)).status).toBe(410);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE action = ?').get('registration.signup_link_resent')).toEqual({ n: 1 });
  });

  it('識別できないリンクや登録済みの申込から再送せず情報を返さない', async () => {
    const unknown = await call('POST', '/api/auth/register/resend-expired', { token: 'unknown_registration_token_0123456789' });
    expect(unknown.status).toBe(404);
    expect(JSON.stringify(await unknown.json())).not.toContain('owner@example.com');
    expect(mail.sendPlainMail).not.toHaveBeenCalled();
  });

  it('申込後は承認まで登録できず、承認招待から統括とオーナーができる', async () => {
    const requested = await call('POST', '/api/auth/register/request', validRequest);
    expect(requested.status).toBe(200);
    expect(lastMailSubject()).toBe('【musubo】お申し込みを受け付けました');
    expect(lastMailToken()).toBe('');
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM auth_email_tokens').get()).toEqual({ n: 0 });
    const token = await issueApprovedInvite();

    const check = await call('GET', `/api/auth/register/check?token=${encodeURIComponent(token)}`);
    expect(check.status).toBe(200);
    expect((await json(check)).data).toEqual({ email: 'owner@example.com', trialDays: 30, companyName: '株式会社サンプル', contactName: '山田 太郎' });

    const completed = await call('POST', '/api/auth/register/complete', {
      token,
      tenantName: '株式会社サンプル',
      name: '山田 太郎',
      password: 'StrongPassword1!',
    });
    expect(completed.status).toBe(200);
    const body = await json(completed);
    // この試験は明示したOffの登録・セッション互換を確かめる。
    expect(body.data.twoFactorSetup).toBeUndefined();
    expect(body.data.newPricingFlow).toBe(false);
    expect(body.data.deviceMarker).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(completed.headers.get('set-cookie') ?? '').toContain('lh_admin_session=');
    expect(completed.headers.get('set-cookie')).toContain('lh_signup_marker=');
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get()).toEqual({ n: 1 });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM admin_two_factor_challenges').get()).toEqual({ n: 0 });

    const tenant = testDb.raw.prepare('SELECT name, plan_status, trial_ends_at, signup_device_marker FROM tenants WHERE id = ?').get(body.data.tenantId) as Record<string, string>;
    expect(tenant.name).toBe('株式会社サンプル');
    expect(tenant.plan_status).toBe('trialing');
    expect(Date.parse(tenant.trial_ends_at) - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(tenant.signup_device_marker).toBe(body.data.deviceMarker);

    const staff = testDb.raw.prepare('SELECT role, is_active, invite_status, email, email_verified_at, password_hash, tenant_id FROM staff_members WHERE email = ?').get('owner@example.com') as Record<string, string | number>;
    expect(staff.role).toBe('owner');
    expect(staff.is_active).toBe(1);
    expect(staff.invite_status).toBe('active');
    expect(staff.tenant_id).toBe(body.data.tenantId);
    expect(staff.email_verified_at).toBeTruthy();
    expect(String(staff.password_hash)).toContain('pbkdf2-sha256$');

    // 同じ URL は 2 回使えない
    const again = await call('POST', '/api/auth/register/complete', { token, tenantName: 'x', name: 'y', password: 'StrongPassword1!' });
    expect(again.status).toBe(410);
  });

  it('登録済みのメールでも返事は同じで、本人には「すでに登録されています」のメールが届く', async () => {
    testDb.raw.prepare(`INSERT INTO staff_members (id, name, email, role, api_key) VALUES ('s1', '既存', 'owner@example.com', 'owner', 'key-1')`).run();
    const res = await call('POST', '/api/auth/register/request', validRequest);
    expect(res.status).toBe(200);
    expect(lastMailSubject()).toBe('【musubo】このメールアドレスはすでに登録されています');
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM auth_email_tokens').get()).toEqual({ n: 0 });
  });

  it('Turnstile が通らないと受け付けない。鍵が無いときは 503 で理由を分ける', async () => {
    turnstile.result = { ok: false, reason: 'rejected' };
    expect((await call('POST', '/api/auth/register/request', validRequest)).status).toBe(400);
    turnstile.result = { ok: false, reason: 'not_configured' };
    expect((await call('POST', '/api/auth/register/request', validRequest)).status).toBe(503);
    expect(mail.sendPlainMail).not.toHaveBeenCalled();
  });

  it('同意が無い・メールの形が違うと 400', async () => {
    expect((await call('POST', '/api/auth/register/request', { ...validRequest, agreed: false })).status).toBe(400);
    expect((await call('POST', '/api/auth/register/request', { ...validRequest, email: 'not-an-email' })).status).toBe(400);
    expect((await call('POST', '/api/auth/register/request', { ...validRequest, companyName: '' })).status).toBe(400);
    expect((await call('POST', '/api/auth/register/request', { ...validRequest, phone: '123' })).status).toBe(400);
    expect((await call('POST', '/api/auth/register/request', { ...validRequest, referralSource: '未定義' })).status).toBe(400);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM registration_applications').get()).toEqual({ n: 0 });
  });

  it('同じブラウザ（印）からの 2 回目は 409 で断る。localStorage の印でも Cookie の印でも', async () => {
    await call('POST', '/api/auth/register/request', validRequest);
    const token = await issueApprovedInvite();
    const completed = await call('POST', '/api/auth/register/complete', { token, tenantName: 'A', name: 'a', password: 'StrongPassword1!' });
    const marker = (await json(completed)).data.deviceMarker;

    const viaBody = await call('POST', '/api/auth/register/request', { ...validRequest, email: 'second@example.com', deviceMarker: marker });
    expect(viaBody.status).toBe(409);
    expect((await json(viaBody)).code).toBe('device_registered');

    const viaCookie = await call('POST', '/api/auth/register/request', { ...validRequest, email: 'third@example.com' }, { headers: { cookie: `lh_signup_marker=${marker}` } });
    expect(viaCookie.status).toBe(409);

    // 印が無ければ別の人として通る
    const fresh = await call('POST', '/api/auth/register/request', { ...validRequest, email: 'fourth@example.com' }, { ip: '198.51.100.7' });
    expect(fresh.status).toBe(200);
  });

  it('同じ接続元は 1 日 5 件、同じメールは 1 日 3 件まで', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await call('POST', '/api/auth/register/request', validRequest)).status).toBe(200);
    }
    expect((await call('POST', '/api/auth/register/request', validRequest)).status).toBe(429);
    expect((await call('POST', '/api/auth/register/request', { ...validRequest, email: 'b@example.com' })).status).toBe(200);
    expect((await call('POST', '/api/auth/register/request', { ...validRequest, email: 'c@example.com' })).status).toBe(429);
  });

  it('本登録では承認済みの会社名・担当者名を使用し、パスワード条件を確認する', async () => {
    await call('POST', '/api/auth/register/request', validRequest);
    const token = await issueApprovedInvite();
    const res = await call('POST', '/api/auth/register/complete', { token, tenantName: '', name: '', password: 'short' });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.errors).toMatchObject({ password: expect.any(String) });
    // 失敗しても URL は消費されない
    expect((await call('GET', `/api/auth/register/check?token=${token}`)).status).toBe(200);
  });

  it('期限切れ・でたらめな URL は 410／404', async () => {
    await call('POST', '/api/auth/register/request', validRequest);
    const token = await issueApprovedInvite();
    testDb.raw.prepare(`UPDATE auth_email_tokens SET expires_at = '2000-01-01T00:00:00.000+09:00'`).run();
    expect((await call('GET', `/api/auth/register/check?token=${token}`)).status).toBe(410);
    expect((await call('GET', '/api/auth/register/check?token=zzzzzzzzzzzzzzzzzzzzzzzz')).status).toBe(404);
  });

  it('承認前の申込と旧方式の URL は利用開始に使えない', async () => {
    await call('POST', '/api/auth/register/request', validRequest);
    const token = 'pending_registration_token_0123456789';
    const row = testDb.raw.prepare('SELECT id FROM registration_applications WHERE email = ?').get('owner@example.com') as { id: string };
    await createAuthEmailToken(testDb.db, { purpose: 'signup', tokenHash: await sha256Hex(token), email: 'owner@example.com', applicationId: row.id, expiresAt: toJstString(new Date(Date.now() + 3600000)) });
    expect((await call('GET', `/api/auth/register/check?token=${token}`)).status).toBe(403);
    expect((await call('POST', '/api/auth/register/complete', { token, password: 'StrongPassword1!' })).status).toBe(403);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM tenants').get()).toMatchObject({ n: 1 });
  });
});

describe('メール＋パスワードのログイン', () => {
  async function seedOwner(overrides: Record<string, unknown> = {}) {
    const hash = await hashPassword('Abcdefg1');
    testDb.raw
      .prepare(`INSERT INTO staff_members (id, name, email, role, api_key, is_active, password_hash, tenant_id) VALUES ('s1', '山田 太郎', 'owner@example.com', 'owner', 'key-1', ?, ?, ?)`)
      .run((overrides.is_active as number) ?? 1, hash, (overrides.tenant_id as string | null) ?? null);
  }

  it('正しい組み合わせでセッションが出る。大文字小文字は区別しない', async () => {
    await seedOwner();
    const res = await call('POST', '/api/auth/password/login', { email: 'OWNER@example.com', password: 'Abcdefg1' });
    expect(res.status).toBe(200);
    const body = await json(res);
    // Offかつ未登録の本人はパスワードだけで入れる。
    expect(body.data.twoFactorSetup).toBeUndefined();
    expect(body.csrfToken).toBeTruthy();
    expect(res.headers.get('set-cookie') ?? '').toContain('lh_admin_session=');
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get()).toEqual({ n: 1 });
  });

  it('違うパスワード・知らないメール・無効な権限者は同じ言葉で 401', async () => {
    await seedOwner();
    const wrong = await call('POST', '/api/auth/password/login', { email: 'owner@example.com', password: 'Abcdefg2' });
    expect(wrong.status).toBe(401);
    const unknown = await call('POST', '/api/auth/password/login', { email: 'nobody@example.com', password: 'Abcdefg1' });
    expect(unknown.status).toBe(401);
    expect((await json(wrong)).error).toBe((await json(unknown)).error);
    expect(testDb.raw.prepare(`SELECT COUNT(*) AS n FROM login_audit WHERE action = 'fail'`).get()).toEqual({ n: 2 });
  });

  it('LINE だけの権限者（パスワード無し）はメールでは入れない', async () => {
    testDb.raw.prepare(`INSERT INTO staff_members (id, name, email, role, api_key, line_user_id) VALUES ('s2', 'LINEの人', 'line@example.com', 'admin', 'key-2', 'U1')`).run();
    expect((await call('POST', '/api/auth/password/login', { email: 'line@example.com', password: 'Abcdefg1' })).status).toBe(401);
  });

  it.each(['suspended', 'archived'] as const)(
    '停止・保管中の契約先も正しいパスワードならログインできる (%s)',
    async (status) => {
      testDb.raw.prepare(
        `INSERT INTO tenants (id, name, status) VALUES ('tenant-stopped', '停止中契約先', ?)`,
      ).run(status);
      await seedOwner({ tenant_id: 'tenant-stopped' });

      const res = await call('POST', '/api/auth/password/login', {
        email: 'owner@example.com', password: 'Abcdefg1',
      });
      expect(res.status).toBe(200);
      expect(await json(res)).toMatchObject({ success: true, data: { twoFactor: false } });
      expect(res.headers.get('set-cookie') ?? '').toContain('lh_admin_session=');
      expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get()).toEqual({ n: 1 });
      expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM admin_two_factor_challenges').get()).toEqual({ n: 0 });
    },
  );

  it('15 分に 10 回失敗すると 429 で止め、成功すると数が消える', async () => {
    await seedOwner();
    for (let i = 0; i < 10; i += 1) {
      expect((await call('POST', '/api/auth/password/login', { email: 'owner@example.com', password: 'wrong0000' })).status).toBe(401);
    }
    expect((await call('POST', '/api/auth/password/login', { email: 'owner@example.com', password: 'Abcdefg1' })).status).toBe(429);
    // 別IPでも同じアカウントの制限を通り抜けない。
    expect((await call('POST', '/api/auth/password/login', { email: 'owner@example.com', password: 'Abcdefg1' }, { ip: '198.51.100.7' })).status).toBe(429);
    testDb.raw.prepare("UPDATE auth_throttles SET window_start='2000-01-01T00:00:00Z'").run();
    const ok = await call('POST', '/api/auth/password/login', { email: 'owner@example.com', password: 'Abcdefg1' }, { ip: '198.51.100.7' });
    expect(ok.status).toBe(200);
    expect((await json(ok)).csrfToken).toBeTruthy();
  });

  it('OffでもTOTPを登録済みの人は合言葉を求め、セッションを出さない', async () => {
    await seedOwner();
    testDb.raw.prepare(`UPDATE staff_members SET totp_secret_enc = 'enc', totp_enabled_at = '2026-09-01T00:00:00.000+09:00' WHERE id = 's1'`).run();
    const res = await call('POST', '/api/auth/password/login', { email: 'owner@example.com', password: 'Abcdefg1' }, { env: { TOTP_ENCRYPTION_KEY: 'test-master-key-which-is-longer-than-32-characters' } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.twoFactor).toBe(true);
    expect(body.data.challengeToken).toBeTruthy();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM admin_two_factor_challenges').get()).toEqual({ n: 1 });
  });

  it('運営ログインは有効な運営メンバーだけが通る', async () => {
    await seedOwner();
    testDb.raw.prepare(`UPDATE staff_members SET totp_secret_enc = 'enc', totp_enabled_at = '2026-09-01T00:00:00.000+09:00' WHERE id = 's1'`).run();
    // 別の運営メンバーがいる状態にして、platform_admins が空の間だけの互換判定を閉じる。
    testDb.raw.prepare(`INSERT INTO staff_members (id, name, role, api_key) VALUES ('other-admin', '別の運営', 'owner', 'other-key')`).run();
    testDb.raw.prepare(`INSERT INTO platform_admins (staff_id, is_active, activation_state) VALUES ('other-admin', 1, 'active')`).run();

    const denied = await call('POST', '/api/auth/password/login', {
      email: 'owner@example.com', password: 'Abcdefg1', next: 'ops',
    }, { env: { TOTP_ENCRYPTION_KEY: 'test-master-key-which-is-longer-than-32-characters' } });
    expect(denied.status).toBe(403);
    expect((await json(denied)).code).toBe('not_platform_admin');
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM admin_two_factor_challenges').get()).toEqual({ n: 0 });

    testDb.raw.prepare(`INSERT INTO platform_admins (staff_id, is_active, activation_state) VALUES ('s1', 1, 'active')`).run();
    const allowed = await call('POST', '/api/auth/password/login', {
      email: 'owner@example.com', password: 'Abcdefg1', next: 'ops',
    }, { env: { TOTP_ENCRYPTION_KEY: 'test-master-key-which-is-longer-than-32-characters' } });
    expect(allowed.status).toBe(200);
    expect((await json(allowed)).data.twoFactor).toBe(true);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM admin_two_factor_challenges').get()).toEqual({ n: 1 });
  });

  it('招待中の運営メンバーがログイン画面へ来たら招待リンクへ案内し、ループさせない', async () => {
    await seedOwner();
    testDb.raw.prepare(`INSERT INTO platform_admins (staff_id, is_active, activation_state) VALUES ('s1', 1, 'invited')`).run();
    const res = await call('POST', '/api/auth/password/login', {
      email: 'owner@example.com', password: 'Abcdefg1', next: 'ops',
    });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: 'ops_invite_pending', error: expect.stringContaining('招待メール') });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get()).toEqual({ n: 0 });
  });

  /*
   * 未登録の招待行で互換判定を閉じると有効な運営マスターが0人になり、招待失効後の再送もできなくなるため、招待中は入口を維持する。
   */
  it('他人の招待が保留中でも、既定の統括のオーナーは互換判定で入れる', async () => {
    await seedOwner();
    testDb.raw.prepare(`INSERT INTO staff_members (id, name, role, api_key) VALUES ('invitee', '招待された人', 'owner', 'invitee-key')`).run();
    testDb.raw.prepare(`INSERT INTO platform_admins (staff_id, is_active, activation_state) VALUES ('invitee', 1, 'invited')`).run();
    const res = await call('POST', '/api/auth/password/login', {
      email: 'owner@example.com', password: 'Abcdefg1', next: 'ops',
    }, { env: { TOTP_ENCRYPTION_KEY: 'test-master-key-which-is-longer-than-32-characters' } });
    expect(res.status).toBe(200);
  });
});

describe('パスワード再設定（36-6）', () => {
  it('メールの URL から新しいパスワードを設定でき、古いセッションは消える', async () => {
    const hash = await hashPassword('Abcdefg1');
    testDb.raw.prepare(`INSERT INTO staff_members (id, name, email, role, api_key, password_hash) VALUES ('s1', '山田 太郎', 'owner@example.com', 'owner', 'key-1', ?)`).run(hash);
    testDb.raw.prepare(`INSERT INTO admin_sessions (token_hash, staff_id, expires_at) VALUES ('old', 's1', '2099-01-01T00:00:00.000Z')`).run();

    const forgot = await call('POST', '/api/auth/password/forgot', { email: 'owner@example.com', turnstileToken: 'tok' });
    expect(forgot.status).toBe(200);
    expect(lastMailSubject()).toBe('【musubo】パスワードの再設定');
    const token = lastMailToken();

    expect((await call('GET', `/api/auth/password/reset/check?token=${token}`)).status).toBe(200);
    const reset = await call('POST', '/api/auth/password/reset', { token, password: 'NewPassword99!' });
    expect(reset.status).toBe(200);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get()).toEqual({ n: 0 });

    expect((await call('POST', '/api/auth/password/login', { email: 'owner@example.com', password: 'Abcdefg1' })).status).toBe(401);
    // 新しいパスワードでは入れる（二段階認証は一時解除中）
    const relogin = await call('POST', '/api/auth/password/login', { email: 'owner@example.com', password: 'NewPassword99!' });
    expect(relogin.status).toBe(200);
    expect((await json(relogin)).csrfToken).toBeTruthy();
    expect((await call('POST', '/api/auth/password/reset', { token, password: 'Another11' })).status).toBe(410);
  });

  it('LINE だけの権限者もパスワードを持てる（そのメールの有効な人が 1 人のとき）', async () => {
    testDb.raw.prepare(`INSERT INTO staff_members (id, name, email, role, api_key, line_user_id) VALUES ('s2', 'LINEの人', 'line@example.com', 'admin', 'key-2', 'U1')`).run();
    await call('POST', '/api/auth/password/forgot', { email: 'line@example.com', turnstileToken: 'tok' });
    const token = lastMailToken();
    expect(token).toBeTruthy();
    expect((await call('POST', '/api/auth/password/reset', { token, password: 'NewPassword99!' })).status).toBe(200);
    // 二段階認証は一時解除中なので、そのままセッションが出る
    const login = await call('POST', '/api/auth/password/login', { email: 'line@example.com', password: 'NewPassword99!' });
    expect(login.status).toBe(200);
    expect((await json(login)).csrfToken).toBeTruthy();
  });

  it('知らないメールでも返事は同じで、メールは送らない', async () => {
    const res = await call('POST', '/api/auth/password/forgot', { email: 'nobody@example.com', turnstileToken: 'tok' });
    expect(res.status).toBe(200);
    expect(mail.sendPlainMail).not.toHaveBeenCalled();
  });

  it('同じメールに複数の権限者がいてどれも パスワード無しなら送らない（誰宛か決められない）', async () => {
    // 同じ統括での重複は一意制約で作れない。統括を分けた重複（運用上あり得る）で曖昧さを確かめる。
    testDb.raw.prepare(`INSERT INTO staff_members (id, name, email, role, api_key, tenant_id) VALUES ('a', 'A', 'dup@example.com', 'admin', 'k1', 'tenant-a'), ('b', 'B', 'dup@example.com', 'admin', 'k2', 'tenant-b')`).run();
    await call('POST', '/api/auth/password/forgot', { email: 'dup@example.com', turnstileToken: 'tok' });
    expect(mail.sendPlainMail).not.toHaveBeenCalled();
  });

  it('Turnstile が通らないと再設定のメールも送らない', async () => {
    turnstile.result = { ok: false, reason: 'rejected' };
    expect((await call('POST', '/api/auth/password/forgot', { email: 'owner@example.com', turnstileToken: 'tok' })).status).toBe(400);
  });
});

describe('password login robot boundary',()=>{
  it.each(['missing_token','rejected','unavailable','not_configured'] as const)('rejects %s before password lookup or session creation',async reason=>{
    turnstile.result={ok:false,reason};
    const response=await call('POST','/api/auth/password/login',{email:'fixture@example.invalid',password:'fixture-password',turnstileToken:'fixture-token'});
    expect(response.status).toBe(reason==='not_configured'?503:400);
    expect((await json(response)).code).toBe('TURNSTILE_REQUIRED');
    expect(testDb.raw.prepare('SELECT COUNT(*) n FROM admin_sessions').get()).toEqual({n:0});
  });
});
