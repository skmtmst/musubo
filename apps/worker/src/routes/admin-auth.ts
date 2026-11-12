import { readAuthenticatedStaffRecord } from '../lib/authenticated-staff-record.js';
import { logger, tracedFetch as fetch } from '@line-crm/shared/server';
import { bearerToken, readCookie } from '../middleware/auth-http.js';
import { mfaConfiguration, mfaEncryptionConfigured, MFA_KEY_NOTICE } from '../lib/mfa-config.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';
import { staffApiKey } from './staff-api-key.js';
import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import {
  ADMIN_AUTH_COOKIE,
  ADMIN_SESSION_BEARER_PREFIX,
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_DEFAULT_MAX_AGE,
  SESSION_REMEMBER_MAX_AGE,
  adminSessionCookie,
  adminSessionTokenFromCookie,
  adminSessionTokenHashFromRequest,
  authenticateApiToken,
  csrfCookie,
  csrfTokenFromCookie,
  expiredCookie,
  sha256Hex,
} from '../middleware/auth.js';
import { clientIp, issueSession, maskIpPrefix, randomToken, recordSuccessfulLoginAudit, twoFactorLoginUrl, twoFactorSetupUrl } from '../services/admin-session.js';
import { resolveAdminAuthConfig, resolveCorsOrigin } from '../middleware/admin-auth-config.js';
import { recordAuditEvent, recordLoginAudit } from '@line-crm/db';
import {
  activatePlatformAdminIfAwaitingTotp,
  bumpAuthThrottle,
  clearAuthThrottle,
  readAuthThrottle,
  claimStaffTotpStep,
  claimTotpPendingSecret,
  clearStepUpAttempts,
  createStepUpGrant,
  deleteAdminSession,
  deleteAdminSessionForStaff,
  deleteOtherAdminSessions,
  deleteTwoFactorChallenge,
  listAdminSessionsByStaff,
  markAdminSessionStepUp,
  getAdminSessionByTokenHash,
  getStaffById,
  getStaffByApiKey,
  getStaffByInviteTokenHash,
  getStaffByLineUserId,
  getStaffByLineUserIdIncludingInactive,
  getActiveImpersonation,
  getPlatformAdminRecord,
  getPlatformAdminByStaffId,
  getMusuboTenantBilling,
  getLatestTenantMusuboIndividualQuote,
  getTwoFactorChallenge,
  reserveStepUpAttempt,
  stepUpAttemptRetryAfterSeconds,
  updateStaffMember,
} from '@line-crm/db';
import { buildTotpUri, decryptTotpSecret, encryptTotpSecret, generateTotpSecret, verifyTotp } from '../lib/totp.js';
import { isStepUpPurpose } from '../lib/step-up.js';
import { verifyPassword } from '../services/password-hash.js';
import { toImpersonationContext } from '../middleware/impersonation.js';
import { candidateFromStaffRow, isPlatformAdmin, isPlatformAdminRow } from '../middleware/platform-admin.js';
import { fail } from '../lib/fail.js';
import { loginMfaChallenge, loginMfaRequired, mfaPolicyKey, mfaAudit, reserveMfaAttempt, consumeMfaChallenge } from '../services/login-mfa.js';
import { consumeStepUpToken, stepUpRequiredResponse } from '../lib/step-up.js';
import { auditEventStatement, getPlatformSetting } from '@line-crm/db';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';

export const adminAuth = new Hono<Env>();
adminAuth.use('/api/auth/*', async (c, next) => { c.header('Cache-Control', 'private, no-store'); await next(); });
adminAuth.route('/', staffApiKey);
adminAuth.use('/api/auth/two-factor/*', async (c, next) => {
  await next();
  if (c.res.status < 400 || c.get('mfaAuditRecorded') || c.req.path.endsWith('/policy')) return;
  const body = await c.req.json<{ challengeToken?: string }>().catch(() => ({} as { challengeToken?: string }));
  const challenge = typeof body.challengeToken === 'string'
    ? await getTwoFactorChallenge(c.env.DB, await sha256Hex(body.challengeToken)) : null;
  await mfaAudit(c, challenge?.staff_id ?? null, c.req.path.includes('/setup') ? 'auth.mfa.setup' : 'auth.mfa.verify', c.res.status === 429 ? 'denied' : 'failed');
});

const OAUTH_STATE_COOKIE = 'lh_line_state';
const OAUTH_HANDOFF_COOKIE = 'lh_line_handoff';
const OAUTH_NONCE_COOKIE = 'lh_line_nonce';
const OAUTH_VERIFIER_COOKIE = 'lh_line_verifier';
const OAUTH_INVITE_COOKIE = 'lh_line_invite';
/** ログイン後の戻り先。'ops' のときだけ運営コンソールへ（★37-1）。 */
const OAUTH_NEXT_COOKIE = 'lh_line_next';
/** 「7日間ログインを保持」の選択をOAuth往復のあいだ保持するための印。 */
const OAUTH_REMEMBER_COOKIE = 'lh_line_remember';
const OAUTH_MAX_AGE = 600;
const TWO_FACTOR_MAX_ATTEMPTS = 5;

adminAuth.get('/api/auth/two-factor/policy', async c => {
  const staff = c.get('staff');
  const member = staff.id === 'env-owner' ? null : await getStaffById(c.env.DB, staff.id);
  const activeProxy = await getActiveImpersonation(c.env.DB, staff.id, await adminSessionTokenHashFromRequest(c));
  const canEdit = !activeProxy && !staff.readOnly && staff.id !== 'env-owner'
    && ((member?.role === 'owner' && member.is_active && member.account_scope !== 'accounts' && !staff.assignedLineAccountId) || Boolean(await getPlatformAdminByStaffId(c.env.DB, staff.id)));
  const counts = await c.env.DB.prepare(`SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN totp_enabled_at IS NOT NULL AND totp_secret_enc IS NOT NULL THEN 1 ELSE 0 END),0) registered FROM staff_members WHERE is_active=1 AND COALESCE(tenant_id,?)=?`).bind(DEFAULT_TENANT_ID, staff.tenantId ?? DEFAULT_TENANT_ID).first();
  return c.json({ success: true, data: { required: await loginMfaRequired(c.env.DB, staff.tenantId, c.env.TOTP_ENCRYPTION_KEY), canEdit: Boolean(canEdit), impersonating: Boolean(activeProxy), ...mfaConfiguration(c.env.TOTP_ENCRYPTION_KEY), ...counts } });
});

adminAuth.get('/api/auth/two-factor/self', async c => {
  const principal = c.get('staff');
  if (c.get('impersonation') || await getActiveImpersonation(c.env.DB, principal.id, await adminSessionTokenHashFromRequest(c))) return c.json({ success: false, error: '代理ログイン中は利用できません' }, 403);
  const member = await getStaffById(c.env.DB, principal.id);
  if (!member) return c.json({ success: false, error: '本人の設定を取得できません' }, 403);
  const configuration = mfaConfiguration(c.env.TOTP_ENCRYPTION_KEY);
  return c.json({ success: true, data: { staffId: member.id, enabledAt: member.totp_enabled_at,
    canEdit: !principal.readOnly && configuration.configured, ...configuration } });
});

adminAuth.put('/api/auth/two-factor/policy', inputJsonBoundary({ required: ['boolean'] }), async c => {
  const staff = c.get('staff');
  const member = staff.id === 'env-owner' ? null : await getStaffById(c.env.DB, staff.id);
  if (staff.readOnly || staff.id === 'env-owner' || c.get('impersonation') || await getActiveImpersonation(c.env.DB, staff.id, await adminSessionTokenHashFromRequest(c))
    || !((member?.role === 'owner' && member.is_active && member.account_scope !== 'accounts' && !staff.assignedLineAccountId) || Boolean(await getPlatformAdminByStaffId(c.env.DB, staff.id)))) {
    await mfaAudit(c, staff.id, 'auth.mfa.policy', 'denied');
    return c.json({ success: false, error: 'オーナーまたは運営だけが変更できます' }, 403);
  }
  const body = await c.req.json<{ required?: boolean }>();
  if (typeof body.required !== 'boolean') return inputError(c, { success: false, error: 'OnかOffを選んでください' }, 400, ['required']);
  if (body.required && !mfaEncryptionConfigured(c.env.TOTP_ENCRYPTION_KEY)) {
    await mfaAudit(c, staff.id, 'auth.mfa.policy', 'denied');
    return c.json({ success: false, error: MFA_KEY_NOTICE }, 400);
  }
  // 通常の10分の確認窓では足りないため、毎回新しい一度限りの確認票を使う。
  if (!body.required && !await consumeStepUpToken(c, 'auth.mfa.policy')) {
    return stepUpRequiredResponse(c, 'Offにする前に二段階認証またはパスワードで本人確認してください');
  }
  const tenantId = staff.tenantId ?? DEFAULT_TENANT_ID;
  const policyKey = mfaPolicyKey(tenantId);
  const previousValue = await getPlatformSetting(c.env.DB, policyKey);
  const before = mfaEncryptionConfigured(c.env.TOTP_ENCRYPTION_KEY) && previousValue !== 'false';
  const authority = `EXISTS(SELECT 1 FROM staff_members sm WHERE sm.id=? AND sm.is_active=1
    AND COALESCE(sm.access_level,'full')<>'read_only' AND COALESCE(sm.tenant_id,?)=? AND
    ((sm.role='owner' AND COALESCE(sm.account_scope,'all')<>'accounts' AND sm.assigned_line_account_id IS NULL)
      OR EXISTS(SELECT 1 FROM platform_admins p WHERE p.staff_id=sm.id AND p.is_active=1 AND p.activation_state='active')))`;
  const authorityBinds = [staff.id, DEFAULT_TENANT_ID, tenantId];
  const update = previousValue === null
    ? c.env.DB.prepare(`INSERT OR IGNORE INTO platform_settings(key,value,updated_by,updated_at) SELECT ?,?,?,? WHERE ${authority}`)
        .bind(policyKey, String(body.required), staff.id, new Date().toISOString(), ...authorityBinds)
    : c.env.DB.prepare(`UPDATE platform_settings SET value=?,updated_by=?,updated_at=? WHERE key=? AND value=? AND ${authority}`)
        .bind(String(body.required), staff.id, new Date().toISOString(), policyKey, previousValue, ...authorityBinds);
  const auditId = crypto.randomUUID();
  const statements = [update,
    auditEventStatement(c.env.DB, { id: auditId, category: 'auth', action: 'auth.mfa.policy', tenantId,
      actorPrincipalId: staff.id, actorRole: staff.role, targetKind: 'tenant', targetId: tenantId,
      before: { required: before }, after: { required: body.required }, riskLevel: 'high', retentionClass: 'security' },
      { sql: 'changes()=1', params: [] }),
  ];
  // 要求を有効にする前のセッションが残らないよう、方針の有効化と失効を原子的に行う。次のログインで各人が登録できる。
  if (body.required && !before) statements.push(
    c.env.DB.prepare(`DELETE FROM platform_settings WHERE key IN
      (SELECT 'auth.mfa.session:'||s.token_hash FROM admin_sessions s JOIN staff_members m ON m.id=s.staff_id WHERE COALESCE(m.tenant_id,?)=?)
      AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)`).bind(DEFAULT_TENANT_ID, tenantId, auditId),
    c.env.DB.prepare(`UPDATE impersonation_sessions SET ended_at=? WHERE ended_at IS NULL AND staff_id IN
      (SELECT id FROM staff_members WHERE COALESCE(tenant_id,?)=?) AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)`)
      .bind(new Date().toISOString(), DEFAULT_TENANT_ID, tenantId, auditId),
    c.env.DB.prepare(`DELETE FROM admin_sessions WHERE staff_id IN
      (SELECT id FROM staff_members WHERE COALESCE(tenant_id,?)=?) AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)`)
      .bind(DEFAULT_TENANT_ID, tenantId, auditId),
  );
  const changed = await c.env.DB.batch(statements);
  if (changed[0].meta.changes !== 1) return c.json({ success: false, error: '設定が先に変わりました。読み直してください' }, 409);
  return c.json({ success: true, data: { required: body.required, relogin: body.required && !before } });
});
const STEP_UP_ATTEMPT_LIMIT_ERROR = '入力回数を超えました。しばらく待ってからやり直してください';

/*
 * 入力上限の429には待ち秒数を付ける。画面は「約N分待ってから」と出す。
 * Retry-After（秒）も付け、機械的な再試行の目安にする。本文は利用者向けの
 * 回復案内だけ（内部情報は入れない）。
 */
async function stepUpRateLimitResponse(c: Context<Env>, staffId: string) {
  const retryAfterSeconds = await stepUpAttemptRetryAfterSeconds(c.env.DB, staffId);
  return c.json(
    { success: false, error: STEP_UP_ATTEMPT_LIMIT_ERROR, data: { retryAfterSeconds } },
    429,
    { 'Retry-After': String(retryAfterSeconds) },
  );
}

function oauthCookie(name: string, value: string, maxAge = OAUTH_MAX_AGE): string {
  return `${name}=${encodeURIComponent(value)}; Path=/api/auth/line; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function callbackUrl(c: Context<Env>): string {
  return `${new URL(c.req.url).origin}/api/auth/line/callback`;
}

/**
 * 管理画面ログイン用のLINE Loginチャネル。
 *
 * `LINE_LOGIN_CHANNEL_ID` は会員向けLIFF連携の既定チャネルも兼ねているため
 * （`routes/liff.ts`）、他社向けサービスの入口だけを別プロバイダーの
 * チャネルへ移せるように、管理者ログイン専用の設定を先に見る。
 * 未設定なら従来どおり共通のチャネルを使うので、設定を入れるまで挙動は変わらない。
 */
function adminLoginChannel(env: Env['Bindings']): { id: string; secret: string } {
  return {
    id: env.ADMIN_LINE_LOGIN_CHANNEL_ID?.trim() || env.LINE_LOGIN_CHANNEL_ID,
    secret: env.ADMIN_LINE_LOGIN_CHANNEL_SECRET?.trim() || env.LINE_LOGIN_CHANNEL_SECRET,
  };
}

function adminLoginUrl(c: Context<Env>, error?: string, next?: string | null): string {
  const base = c.env.ADMIN_PUBLIC_URL?.replace(/\/+$/, '');
  if (!base) throw new Error('ADMIN_PUBLIC_URL is not configured');
  const path = next === 'ops' ? '/ops/login' : '/login';
  return `${base}${path}${error ? `?error=${encodeURIComponent(error)}` : ''}`;
}

function logAuthFailure(): void {
  logger.error("admin_auth.authenticate_failed");
}

function recordLoginAuditBestEffort(c: Context<Env>, staffId: string): Promise<void> {
  return recordSuccessfulLoginAudit(c, staffId, () => logAuthFailure());
}

adminAuth.get('/api/auth/line', async (c) => {
  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  if (config.misconfigured) return c.json({ success: false, error: config.misconfigured }, 500);
  const channel = adminLoginChannel(c.env);
  if (!channel.id || !channel.secret) {
    return c.json({ success: false, error: 'LINE Login is not configured' }, 500);
  }

  const handoff = c.req.query('handoff');
  if (handoff && /^[0-9a-f-]{36}$/.test(handoff)) c.header('Set-Cookie', oauthCookie(OAUTH_HANDOFF_COOKIE, handoff), { append: true });
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  ))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

  c.header('Set-Cookie', oauthCookie(OAUTH_STATE_COOKIE, state), { append: true });
  c.header('Set-Cookie', oauthCookie(OAUTH_NONCE_COOKIE, nonce), { append: true });
  c.header('Set-Cookie', oauthCookie(OAUTH_VERIFIER_COOKIE, verifier), { append: true });
  const invite = c.req.query('invite');
  if (invite) c.header('Set-Cookie', oauthCookie(OAUTH_INVITE_COOKIE, invite), { append: true });
  const next = c.req.query('next');
  if (next === 'ops') c.header('Set-Cookie', oauthCookie(OAUTH_NEXT_COOKIE, next), { append: true });
  if (c.req.query('remember') === '1') c.header('Set-Cookie', oauthCookie(OAUTH_REMEMBER_COOKIE, '1'), { append: true });

  const authorize = new URL('https://access.line.me/oauth2/v2.1/authorize');
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: channel.id,
    redirect_uri: callbackUrl(c),
    state,
    scope: 'openid profile',
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return c.redirect(authorize.toString());
});

async function lineLoginFailure(c: Context<Env>, reason: string, next?: string | null) {
  await recordLoginAudit(c.env.DB, { action: 'fail', result: 'unauthorized', ip: clientIp(c) });
  return c.redirect(adminLoginUrl(c, reason, next));
}

adminAuth.get('/api/auth/line/callback', async (c) => {
  const cookies = c.req.header('Cookie');
  const expectedState = readCookie(cookies, OAUTH_STATE_COOKIE);
  const nonce = readCookie(cookies, OAUTH_NONCE_COOKIE);
  const verifier = readCookie(cookies, OAUTH_VERIFIER_COOKIE);
  const invite = readCookie(cookies, OAUTH_INVITE_COOKIE);
  const next = readCookie(cookies, OAUTH_NEXT_COOKIE);
  const remember = readCookie(cookies, OAUTH_REMEMBER_COOKIE) === '1';
  const handoff = readCookie(cookies, OAUTH_HANDOFF_COOKIE) || '';
  if (handoff) c.set('adminHandoffNonce', handoff);
  const state = c.req.query('state');
  const code = c.req.query('code');

  for (const name of [OAUTH_STATE_COOKIE, OAUTH_NONCE_COOKIE, OAUTH_VERIFIER_COOKIE, OAUTH_INVITE_COOKIE, OAUTH_NEXT_COOKIE, OAUTH_REMEMBER_COOKIE, OAUTH_HANDOFF_COOKIE]) {
    c.header('Set-Cookie', oauthCookie(name, '', 0), { append: true });
  }

  if (!code || !state || !expectedState || state !== expectedState || !nonce || !verifier) {
    return lineLoginFailure(c, 'invalid_state', next);
  }

  const channel = adminLoginChannel(c.env);

  try {
    const tokenResponse = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl(c),
        client_id: channel.id,
        client_secret: channel.secret,
        code_verifier: verifier,
      }),
    });
    if (!tokenResponse.ok) return lineLoginFailure(c, 'line_token_failed', next);
    const tokens = await tokenResponse.json<{ id_token?: string }>();
    if (!tokens.id_token) return lineLoginFailure(c, 'line_id_token_missing', next);

    const verifyResponse = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        id_token: tokens.id_token,
        client_id: channel.id,
        nonce,
      }),
    });
    if (!verifyResponse.ok) return lineLoginFailure(c, 'line_verify_failed', next);
    const profile = await verifyResponse.json<{ sub?: string }>();
    if (!profile.sub) return lineLoginFailure(c, 'line_profile_missing', next);

    let staff = await getStaffByLineUserId(c.env.DB, profile.sub);
    if (!staff && invite) {
      const invited = await getStaffByInviteTokenHash(c.env.DB, await sha256Hex(invite));
      if (
        invited?.invite_status === 'pending_line' &&
        invited.invite_expires_at &&
        Date.parse(invited.invite_expires_at) >= Date.now()
      ) {
        // 同じLINEアカウントを握ったままの古い行があると、line_user_id の
        // ユニーク制約で連携が落ちる。招待の方が新しい意思なので、古い方の
        // 連携を先に外す。行そのものは消さない（権限の記録は残す）。
        const previous = await getStaffByLineUserIdIncludingInactive(c.env.DB, profile.sub);
        if (previous && previous.id !== invited.id) {
          await updateStaffMember(c.env.DB, previous.id, { line_user_id: null, line_linked_at: null });
        }
        staff = await updateStaffMember(c.env.DB, invited.id, {
          line_user_id: profile.sub,
          is_active: 1,
          invite_status: 'active',
          invite_token_hash: null,
          invite_expires_at: null,
          line_linked_at: new Date().toISOString(),
        });
        if (staff) staff = await getStaffById(c.env.DB, staff.id);
      }
    }
    if (!staff) return lineLoginFailure(c, 'not_authorized', next);

    // 運営コンソールへの LINE ログイン（★37-1）。platform_admins に登録された
    // LINE ユーザーだけを通す。契約先の権限者や、契約者専用 LINE の友だちでは入れない。
    // platform_admins が空の間だけ、既定の統括のオーナーを互換で通す（初期登録のため）。
    if (next === 'ops') {
      /*
       * 自分自身の招待が保留中なら、互換判定で入れる立場（既定の統括のオーナー）
       * でも止める。メールのリンクから登録を完了させる（auth-email.ts と同じ）。
       * 他人の招待が保留中なだけの場合は互換判定を残す（誰も入れなくなるのを防ぐ）。
       */
      const pending = await getPlatformAdminRecord(c.env.DB, staff.id);
      const invited = pending?.is_active === 1 && pending.activation_state === 'invited';
      // 2要素認証待ちの人は通す（画面が設定へ案内する）。
      const awaitingTotp = pending?.is_active === 1 && pending.activation_state === 'awaiting_totp';
      if (invited) {
        return lineLoginFailure(c, 'not_authorized', next);
      }
      if (!awaitingTotp && !(await isPlatformAdminRow(c.env.DB, candidateFromStaffRow(staff)))) {
        return lineLoginFailure(c, 'not_authorized', next);
      }
    }

    const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
    if (config.misconfigured) return lineLoginFailure(c, 'configuration_error', next);
    const challenge = await loginMfaChallenge(c, staff, remember);
    await mfaAudit(c, staff.id, 'auth.login.primary', 'success');
    if (challenge) {
      return c.redirect(challenge.twoFactorSetup
        ? twoFactorSetupUrl(c, challenge.challengeToken, next)
        : twoFactorLoginUrl(c, challenge.challengeToken, next));
    }
    let session: Awaited<ReturnType<typeof issueSession>>;
    try {
      session = await issueSession(c, staff.id, config.sameSite, remember);
    } catch (error) {
      logAuthFailure();
      return lineLoginFailure(c, 'line_login_failed', next);
    }
    const adminUrl = new URL(c.env.ADMIN_PUBLIC_URL!.replace(/\/+$/, ''));
    if (next === 'ops') adminUrl.pathname = `${adminUrl.pathname.replace(/\/+$/, '')}/ops`;
    if (config.crossSite) {
      adminUrl.hash = new URLSearchParams({
        lh_session: session.sessionToken,
        lh_nonce: handoff,
        lh_csrf: session.csrfToken,
      }).toString();
    }
    await recordLoginAuditBestEffort(c, staff.id);
    return c.redirect(adminUrl.toString());
  } catch (error) {
    logAuthFailure();
    return lineLoginFailure(c, 'line_login_failed', next);
  }
});

adminAuth.post('/api/auth/two-factor/verify', inputJsonBoundary({"challengeToken":["string"],"code":["string"]}), async (c) => {
  const body = await c.req.json<{ challengeToken?: string; code?: string }>()
    .catch(() => ({} as { challengeToken?: string; code?: string }));
  const challengeToken = body.challengeToken?.trim() ?? '';
  const code = body.code?.trim() ?? '';
  if (!challengeToken || !code) {
    return inputError(c, { success: false, error: '6桁の認証コードを入力してください' }, 400, ["challengeToken","code"]);
  }

  const tokenHash = await sha256Hex(challengeToken);
  const challenge = await getTwoFactorChallenge(c.env.DB, tokenHash);
  if (!challenge || challenge.purpose !== 'verify' || Date.parse(challenge.expires_at) <= Date.now()) {
    if (challenge) await deleteTwoFactorChallenge(c.env.DB, tokenHash);
    return c.json({ success: false, error: '認証の有効時間が切れました。LINEログインからやり直してください' }, 401);
  }
  if (challenge.attempts >= TWO_FACTOR_MAX_ATTEMPTS) {
    await deleteTwoFactorChallenge(c.env.DB, tokenHash);
    return c.json({ success: false, error: '入力回数を超えました。LINEログインからやり直してください' }, 429);
  }

  const staff = await getStaffById(c.env.DB, challenge.staff_id);
  const masterKey = c.env.TOTP_ENCRYPTION_KEY;
  if (!staff?.is_active || !staff.totp_secret_enc || !staff.totp_enabled_at || !masterKey) {
    await deleteTwoFactorChallenge(c.env.DB, tokenHash);
    return c.json({ success: false, error: '二段階認証を確認できません' }, 401);
  }
  if (!await reserveMfaAttempt(c, tokenHash, staff.id)) {
    await mfaAudit(c, staff.id, 'auth.mfa.verify', 'denied');
    return c.json({ success: false, error: '入力回数を超えました。15分ほど待ってからやり直してください' }, 429);
  }
  const verified = await verifyTotp(
    await decryptTotpSecret(staff.totp_secret_enc, masterKey), code, Date.now(), staff.totp_last_used_step,
  );
  if (!verified.valid) {
    await mfaAudit(c, staff.id, 'auth.mfa.verify', 'failed');
    return inputError(c, { success: false, error: '認証コードが正しくありません' }, 400, ['code']);
  }

  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  if (config.misconfigured) return c.json({ success: false, error: config.misconfigured }, 500);
  if (!await claimStaffTotpStep(c.env.DB, staff.id, verified.step!)) {
    await deleteTwoFactorChallenge(c.env.DB, tokenHash);
    return c.json({ success: false, error: 'この認証コードは使用済みです。次のコードを入力してください' }, 409);
  }
  if (!await consumeMfaChallenge(c.env.DB, tokenHash)) return c.json({ success: false, error: '認証は使用済みです' }, 409);
  await activatePlatformAdminIfAwaitingTotp(c.env.DB, staff.id);
  await mfaAudit(c, staff.id, 'auth.mfa.verify', 'success');
  const { clearAuthThrottle } = await import('@line-crm/db');
  await clearAuthThrottle(c.env.DB, `mfa:${staff.id}`);
  let session: Awaited<ReturnType<typeof issueSession>>;
  try {
    session = await issueSession(c, staff.id, config.sameSite, challenge.remember === 1, true);
  } catch (error) {
    logAuthFailure();
    throw error;
  }
  await recordLoginAuditBestEffort(c, staff.id);
  return c.json({
    success: true,
    // 同一サイトでは資格情報を HttpOnly のまま保ち、文書化した別サイトの代替経路だけで不透明なトークンを管理画面へ渡す。
    data: { sessionToken: config.crossSite ? session.sessionToken : undefined },
    csrfToken: session.csrfToken,
  });
});

/**
 * POST /api/auth/two-factor/setup — TOTP未登録の管理者向けの初回設定を始める。
 *
 * 通常セッションを持てない人が通るため、認証済みセッションではなく
 * setup 用途の合言葉だけで開ける。登録用の秘密をその場で発行して
 * provisioning URI を返す。
 */
adminAuth.post('/api/auth/two-factor/setup', inputJsonBoundary({"challengeToken":["string"]}), async (c) => {
  const body = await c.req.json<{ challengeToken?: string }>()
    .catch(() => ({} as { challengeToken?: string }));
  const challengeToken = body.challengeToken?.trim() ?? '';
  if (!challengeToken) {
    return inputError(c, { success: false, error: '設定の合言葉がありません。ログインからやり直してください' }, 400, ["challengeToken"]);
  }

  const tokenHash = await sha256Hex(challengeToken);
  const challenge = await getTwoFactorChallenge(c.env.DB, tokenHash);
  if (!challenge || challenge.purpose !== 'setup' || Date.parse(challenge.expires_at) <= Date.now()) {
    if (challenge) await deleteTwoFactorChallenge(c.env.DB, tokenHash);
    return c.json({ success: false, error: '設定の有効時間が切れました。ログインからやり直してください' }, 401);
  }

  const staff = await getStaffById(c.env.DB, challenge.staff_id);
  const masterKey = c.env.TOTP_ENCRYPTION_KEY;
  if (!staff?.is_active || !masterKey) {
    return c.json({ success: false, error: '二段階認証を設定できません' }, 401);
  }
  if (staff.totp_enabled_at && staff.totp_secret_enc) {
    return c.json({ success: false, error: '二段階認証はすでに設定されています' }, 409);
  }

  /*
   * 同じ合言葉への同時取得でも画面のQRと保存がずれないよう冪等にする。
   * 期限内は既発行の仮秘密を使い回す。競合で先に置かれた場合も、
   * 条件付き更新に負けた側は置かれた値を読み直して同じQRを返す。
   */
  const secret = await setupPendingTotpSecret(c.env.DB, staff.id, staff.totp_pending_secret_enc, masterKey);
  return c.json({
    success: true,
    data: {
      provisioningUri: buildTotpUri(secret, staff.email || staff.name),
      manualKey: secret.match(/.{1,4}/g)?.join(' ') ?? secret,
    },
  });
});

/** 置ける仮秘密を1つに決める。既発行があればそれを、無ければ条件付きで置く。 */
async function setupPendingTotpSecret(
  db: Env['Bindings']['DB'],
  staffId: string,
  existingEnc: string | null | undefined,
  masterKey: string,
): Promise<string> {
  const existing = await readPendingTotpSecret(existingEnc, masterKey);
  if (existing) return existing;
  const secret = generateTotpSecret();
  const enc = await encryptTotpSecret(secret, masterKey);
  if (await claimTotpPendingSecret(db, staffId, enc)) return secret;
  const reread = await getStaffById(db, staffId);
  const winner = await readPendingTotpSecret(reread?.totp_pending_secret_enc, masterKey);
  if (winner) return winner;
  const placed = await db.prepare(`UPDATE staff_members SET totp_pending_secret_enc=?,updated_at=?
    WHERE id=? AND is_active=1 AND totp_enabled_at IS NULL AND totp_secret_enc IS NULL AND totp_pending_secret_enc IS ?`)
    .bind(enc, new Date().toISOString(), staffId, reread?.totp_pending_secret_enc ?? null).run();
  if (placed.meta.changes !== 1) throw new Error('TOTP enrollment changed');
  return secret;
}

async function readPendingTotpSecret(
  enc: string | null | undefined,
  masterKey: string,
): Promise<string | null> {
  if (!enc) return null;
  try {
    return await decryptTotpSecret(enc, masterKey);
  } catch {
    return null;
  }
}

/**
 * POST /api/auth/two-factor/setup/confirm — 初回設定の確認。
 *
 * 認証アプリの6桁が合えばTOTPを有効にし、そのまま通常セッションを発行する。
 * 試行は合言葉ごとに5回まで。
 */
adminAuth.post('/api/auth/two-factor/setup/confirm', inputJsonBoundary({"challengeToken":["string"],"code":["string"]}), async (c) => {
  const body = await c.req.json<{ challengeToken?: string; code?: string }>()
    .catch(() => ({} as { challengeToken?: string; code?: string }));
  const challengeToken = body.challengeToken?.trim() ?? '';
  const code = body.code?.trim() ?? '';
  if (!challengeToken || !/^\d{6}$/.test(code)) {
    return inputError(c, { success: false, error: '6桁の認証コードを入力してください' }, 400, ["challengeToken","code"]);
  }

  const tokenHash = await sha256Hex(challengeToken);
  const challenge = await getTwoFactorChallenge(c.env.DB, tokenHash);
  if (!challenge || challenge.purpose !== 'setup' || Date.parse(challenge.expires_at) <= Date.now()) {
    if (challenge) await deleteTwoFactorChallenge(c.env.DB, tokenHash);
    return c.json({ success: false, error: '設定の有効時間が切れました。ログインからやり直してください' }, 401);
  }
  if (challenge.attempts >= TWO_FACTOR_MAX_ATTEMPTS) {
    await deleteTwoFactorChallenge(c.env.DB, tokenHash);
    return c.json({ success: false, error: '入力回数を超えました。ログインからやり直してください' }, 429);
  }

  const staff = await getStaffById(c.env.DB, challenge.staff_id);
  const masterKey = c.env.TOTP_ENCRYPTION_KEY;
  if (!staff?.is_active || !staff.totp_pending_secret_enc || !masterKey) {
    return c.json({ success: false, error: '二段階認証を確認できません' }, 401);
  }
  if (!await reserveMfaAttempt(c, tokenHash, staff.id)) return c.json({ success: false, error: '入力回数を超えました。15分ほど待ってからやり直してください' }, 429);
  const verified = await verifyTotp(
    await decryptTotpSecret(staff.totp_pending_secret_enc, masterKey),
    code,
    Date.now(),
  );
  if (!verified.valid || verified.step === null) {
    await mfaAudit(c, staff.id, 'auth.mfa.setup', 'failed');
    return inputError(c, { success: false, error: '認証コードが正しくありません' }, 400, ["challengeToken","code"]);
  }

  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  if (config.misconfigured) return c.json({ success: false, error: config.misconfigured }, 500);

  const encryptedSecret = await encryptTotpSecret(await decryptTotpSecret(staff.totp_pending_secret_enc, masterKey), masterKey);
  if (!await consumeMfaChallenge(c.env.DB, tokenHash)) return c.json({ success: false, error: '認証は使用済みです' }, 409);
  const updated = await c.env.DB.prepare(`UPDATE staff_members SET totp_secret_enc=?,totp_pending_secret_enc=NULL,
    totp_enabled_at=?,totp_last_used_step=? WHERE id=? AND is_active=1 AND totp_enabled_at IS NULL AND totp_pending_secret_enc=?`)
    .bind(encryptedSecret, new Date().toISOString(), verified.step, staff.id, staff.totp_pending_secret_enc).run();
  if (updated.meta.changes !== 1) return c.json({ success: false, error: '二段階認証はすでに設定されています' }, 409);
  await activatePlatformAdminIfAwaitingTotp(c.env.DB, staff.id);
  await mfaAudit(c, staff.id, 'auth.mfa.setup', 'success');
  const { clearAuthThrottle } = await import('@line-crm/db');
  await clearAuthThrottle(c.env.DB, `mfa:${staff.id}`);

  let session: Awaited<ReturnType<typeof issueSession>>;
  try {
    session = await issueSession(c, staff.id, config.sameSite, challenge.remember === 1, true);
  } catch (error) {
    logAuthFailure();
    throw error;
  }
  await recordLoginAuditBestEffort(c, staff.id);
  return c.json({
    success: true,
    data: { sessionToken: config.crossSite ? session.sessionToken : undefined },
    csrfToken: session.csrfToken,
  });
});

/** 高危険操作の直前だけ使える、5分・1回限りの再認証grantを発行する。 */
adminAuth.post('/api/auth/step-up', inputJsonBoundary({"code":["string"],"password":["string"],"purpose":["string"]}), async (c) => {
  const staffContext = c.get('staff');
  /*
   * 再認証フロー専用の401。管理画面の共通401処理は code の無い
   * 'Unauthorized'（認証middlewareの応答）をセッション喪失として扱うので、
   * この口が画面側の再認証フローで処理される業務401だと分かるよう
   * 機械コードを付ける。
   */
  if (!staffContext) return c.json({ success: false, error: 'Unauthorized', code: 'STEP_UP_UNAUTHORIZED' }, 401);
  const body = await c.req.json<{ code?: string; password?: string; purpose?: string }>()
    .catch(() => ({} as { code?: string; password?: string; purpose?: string }));
  if (!isStepUpPurpose(body.purpose)) {
    return inputError(c, { success: false, error: '確認する操作を指定してください' }, 400, ["purpose"]);
  }
  const purpose = body.purpose;
  const staff = await getStaffById(c.env.DB, staffContext.id);
  if (!staff?.is_active) {
    return c.json({ success: false, error: 'このアカウントでは再確認を受け付けられません' }, 403);
  }
  /*
   * 確認の手段は本人の設定で決まる（V）：二段階認証を使っている人は6桁の
   * コード、使っていない人はパスワード。手段ごとに「何を聞くか」の文言を
   * 分けるため、どちらの経路かを先に確定する。
   * 形式の検査は試行枠の確保より先に行う。形になっていない入力で
   * 試行回数を消費させないため。
   */
  if (staff.totp_enabled_at && staff.totp_secret_enc && !mfaEncryptionConfigured(c.env.TOTP_ENCRYPTION_KEY)) return c.json({ success: false, error: '二段階認証の設定を確認できません' }, 503);
  const useTotp = Boolean(staff.totp_enabled_at && staff.totp_secret_enc && c.env.TOTP_ENCRYPTION_KEY);
  const code = body.code?.trim() ?? '';
  const password = body.password ?? '';
  if (useTotp && !/^\d{6}$/.test(code)) {
    return inputError(c, { success: false, error: '6桁の認証コードを入力してください' }, 400, ["code"]);
  }
  if (!useTotp && staff.password_hash && !password) {
    return inputError(c, { success: false, error: 'パスワードを入力してください' }, 400, ["password"]);
  }
  if (!useTotp && !staff.password_hash) {
    return c.json({ success: false, error: '重要操作には二段階認証またはパスワードの設定が必要です' }, 403);
  }
  const attempt = await reserveStepUpAttempt(c.env.DB, staff.id);
  if (!attempt) {
    return stepUpRateLimitResponse(c, staff.id);
  }
  let totpStep: number | undefined;
  if (useTotp) {
    const verified = await verifyTotp(
      await decryptTotpSecret(staff.totp_secret_enc!, c.env.TOTP_ENCRYPTION_KEY!),
      code,
      Date.now(),
      staff.totp_last_used_step,
    );
    if (!verified.valid || verified.step === null) {
      if (attempt.attempts >= attempt.maxAttempts) {
        return stepUpRateLimitResponse(c, staff.id);
      }
      return inputError(c, { success: false, error: '認証コードが正しくありません' }, 400, ["code"]);
    }
    totpStep = verified.step;
  } else {
    if (!await verifyPassword(password, staff.password_hash!)) {
      if (attempt.attempts >= attempt.maxAttempts) {
        return stepUpRateLimitResponse(c, staff.id);
      }
      return inputError(c, { success: false, error: 'パスワードが正しくありません' }, 400, ["password"]);
    }
  }
  /*
   * コードの一回限りの確保と確認票発行に成功した要求だけを
   * 本人確認済みにする。並行要求に負けた側（409「使用済み」）の
   * セッションには確認済み時刻を残さない。失敗応答と保存状態を一致させる。
   */
  const sessionTokenHash = await adminSessionTokenHashFromRequest(c);
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  // 確認票は発行したセッションと発行時の権限の版に結び付ける。
  // ログアウト・権限の更新の後は使えない（使う側で再認証を案内する）。
  if (!await createStepUpGrant(c.env.DB, {
    tokenHash: await sha256Hex(token),
    staffId: staff.id,
    purpose,
    expiresAt,
    totpStep,
    sessionTokenHash,
    issuedPolicyVersion: Number(staff.policy_version ?? 1),
  })) {
    return c.json({ success: false, error: 'この認証コードは使用済みです' }, 409);
  }
  /*
   * 再確認済みの時刻をセッションへ刻む。同じセッションは10分の窓で
   * 何度も聞かれない。APIキー経路（セッション行が無い）は何もしない。
   */
  if (sessionTokenHash) {
    await markAdminSessionStepUp(c.env.DB, sessionTokenHash, new Date().toISOString());
  }
  if (totpStep === undefined) await clearStepUpAttempts(c.env.DB, staff.id);
  return c.json({ success: true, data: { token, purpose, expiresAt } }, 201);
});

/** API キー検証後、資格情報は HttpOnly の lh_admin_session、CSRF は読取可能な lh_csrf に分ける。別サイトの管理画面は Cookie を読めないため、CSRF を本文にも返して X-CSRF-Token で提示させる。Cookie を返せない構成は、成功に見せず設定エラーとして拒む。 */
adminAuth.post('/api/auth/login', inputJsonBoundary(), async (c) => {
  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  if (config.misconfigured) {
    logger.error("admin_auth.auth_login_create_failed");
    return c.json({ success: false, error: config.misconfigured }, 500);
  }

  const body = await c.req
    .json<{ apiKey?: string; remember?: boolean }>()
    .catch(() => ({}) as { apiKey?: string; remember?: boolean });
  const apiKey = body.apiKey?.trim() ?? '';
  const remember = body.remember === true;
  const throttleKey = `key-login:${await sha256Hex(clientIp(c) ?? 'unknown')}`;
  if (await readAuthThrottle(c.env.DB, throttleKey, 15 * 60_000) >= 10) {
    await mfaAudit(c, null, 'auth.login.key', 'denied');
    return c.json({ success: false, error: '入力回数を超えました。15分ほど待ってからやり直してください' }, 429);
  }
  const staff = await authenticateApiToken(c, apiKey || null);

  if (!staff) {
    await bumpAuthThrottle(c.env.DB, throttleKey, 15 * 60_000);
    // 失敗も残す。誰が入れたかだけでなく、誰が入ろうとしたかも
    // 分からないと、鍵が漏れたときに気づけない。
    await recordLoginAudit(c.env.DB, {
      action: 'fail',
      ip: clientIp(c),
      userAgent: c.req.header('user-agent') ?? null,
      result: 'unauthorized',
    });
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  await clearAuthThrottle(c.env.DB, throttleKey);
  await mfaAudit(c, staff.id, 'auth.login.primary', 'success');
  let csrfToken: string;
  if (staff.id === 'env-owner') {
    // 緊急復旧専用とし、通常の画面でこのキーを求めたり表示したりしない。
    csrfToken = crypto.randomUUID();
    const maxAge = remember ? SESSION_REMEMBER_MAX_AGE : SESSION_DEFAULT_MAX_AGE;
    c.header('Set-Cookie', adminSessionCookie(apiKey, config.sameSite, maxAge), { append: true });
    c.header('Set-Cookie', csrfCookie(csrfToken, config.sameSite, maxAge), { append: true });
  } else {
    const row = await getStaffById(c.env.DB, staff.id);
    if (!row) return c.json({ success: false, error: 'Unauthorized' }, 401);
    const challenge = await loginMfaChallenge(c, row, remember);
    if (challenge) return c.json({ success: true, data: challenge });
    csrfToken = (await issueSession(c, staff.id, config.sameSite, remember)).csrfToken;
  }
  await recordLoginAudit(c.env.DB, {
    adminUserId: staff.id,
    action: 'login',
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') ?? null,
  });
  return c.json({ success: true, data: staff, csrfToken });
});

/** Cookie のログアウトは、失効より前に信頼できる Origin または CSRF を確かめる。 */
adminAuth.post('/api/auth/logout', inputJsonBoundary(), async (c) => {
  const bearer = bearerToken(c);
  const cookie = adminSessionTokenFromCookie(c);
  if (!bearer && cookie) {
    const expected = csrfTokenFromCookie(c);
    const origin = c.req.header('Origin');
    const originDenied = origin !== undefined && (!origin || !resolveCorsOrigin(c.env, origin, c.req.url));
    const suppliedCsrf = c.req.header(CSRF_HEADER);
    // 既存のログアウトは Origin と Cookie を送るため、信頼できる Origin なら許可する。Origin なしは double-submit を必須とし、不一致トークンは常に拒む。
    const csrfMismatch = suppliedCsrf !== undefined && (!expected || suppliedCsrf !== expected);
    if (originDenied || csrfMismatch || (origin === undefined && (!expected || suppliedCsrf !== expected))) {
      const session = await getAdminSessionByTokenHash(c.env.DB, await sha256Hex(cookie));
      const active = session && session.expires_at > new Date().toISOString();
      const emergencyCookie = !active && (cookie === c.env.API_KEY || cookie === c.env.LEGACY_API_KEY
        || await getStaffByApiKey(c.env.DB, cookie));
      // 期限切れ・未知の資格情報でも、ログアウトは冪等な成功として扱う。
      if (active || emergencyCookie) return c.json({ success: false, error: 'CSRF token mismatch' }, 403);
    }
  }
  // 誰がログアウトしたかは、この時点では staff から取れる場合と
  // 取れない場合がある。取れなければ null で残す。記録が無いより
  // 「誰かがログアウトした」の方が手がかりになる。
  await recordLoginAudit(c.env.DB, {
    adminUserId: c.get('staff')?.id ?? null,
    action: 'logout',
    ip: clientIp(c),
  });
  // Bearer 要求に偶然付いた Cookie で別の人まで失効させないよう、認証時に選んだ資格情報だけを使う。
  const tokenHash = await adminSessionTokenHashFromRequest(c);
  if (tokenHash) await deleteAdminSession(c.env.DB, tokenHash);
  const { sameSite } = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  c.header('Set-Cookie', expiredCookie(ADMIN_AUTH_COOKIE, sameSite), { append: true });
  c.header('Set-Cookie', expiredCookie(CSRF_COOKIE, sameSite), { append: true });
  return c.json({ success: true, data: null });
});

/** 再ログインせず CSRF を回復できるよう、セッション情報に現在のトークンを含め、Cookie が欠けていれば更新する。 */
adminAuth.get('/api/auth/session', async (c) => {
  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  let csrfToken = csrfTokenFromCookie(c);
  if (!csrfToken) {
    csrfToken = crypto.randomUUID();
    c.header('Set-Cookie', csrfCookie(csrfToken, config.sameSite), { append: true });
  }
  const staff = c.get('staff');
  // 運営マスターかどうか。platform_admins が空の間は既定の統括のオーナーも真になる
  // （初期登録のため。API 側の requirePlatformAdmin と同じ判定）。
  const sessionTokenHash = await adminSessionTokenHashFromRequest(c);
  // 役割・招待状態・現在のセッション・本人行は互いの結果を使わない。
  const [platformAdmin, platformAdminRecord, currentSession, staffRecord] = await Promise.all([
    isPlatformAdmin(c),
    staff.id === 'env-owner' ? null : getPlatformAdminRecord(c.env.DB, staff.id),
    sessionTokenHash ? getAdminSessionByTokenHash(c.env.DB, sessionTokenHash).catch(() => null) : null,
    staff.id === 'env-owner' ? null : readAuthenticatedStaffRecord(c.env.DB, staff) ?? getStaffById(c.env.DB, staff.id).catch(() => null),
  ]);
  const platformAdminState = platformAdminRecord?.is_active === 1 ? platformAdminRecord.activation_state : null;
  // /api/auth/* は代理ログインの差し替え対象外なので、ここで直接引く。
  const active = platformAdmin ? await getActiveImpersonation(c.env.DB, staff.id, sessionTokenHash) : null;
  const impersonation = active ? toImpersonationContext(active) : null;
  const stepUpMethod = staffRecord?.totp_enabled_at && staffRecord.totp_secret_enc
    ? 'totp'
    : staffRecord?.password_hash ? 'password' : 'none';
  // 利用開始前かどうかは、通常画面を描画する前の認証応答で確定する。
  // 運営・代理ログインや店舗担当者の画面を新規契約の導線へ移さない。
  const onboardingBilling = !platformAdmin && !impersonation && !staff.readOnly
    && (staff.role === 'owner' || staff.role === 'admin')
    ? await getMusuboTenantBilling(c.env.DB, staff.tenantId ?? DEFAULT_TENANT_ID)
    : null;
  const latestQuote = onboardingBilling?.status === 'awaiting_first_line'
    ? await getLatestTenantMusuboIndividualQuote(c.env.DB, staff.tenantId ?? DEFAULT_TENANT_ID)
    : null;
  const onboarding = onboardingBilling?.status === 'awaiting_first_line'
    ? {
      status: onboardingBilling.status,
      consentedAt: onboardingBilling.pricing_consented_at,
      quoteId: latestQuote && (latestQuote.status === 'sent' || latestQuote.status === 'accepted')
        ? latestQuote.id : onboardingBilling.quote_id,
    }
    : null;
  return c.json({
    success: true,
    data: {
      ...staff,
      tenantStatus: staff.tenantStatus ?? 'active',
      platformAdmin,
      platformAdminState,
      impersonation,
      unfamiliarAt: currentSession?.unfamiliar_at ?? null,
      stepUpMethod,
      onboarding,
    },
    csrfToken,
  });
});

/** GET /api/auth/sessions — 本人のアクティブなセッションだけを返す。 */
adminAuth.get('/api/auth/sessions', async (c) => {
  const staff = c.get('staff');
  if (!staff) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const currentHash = adminSessionTokenHashFromRequest(c);
  const rows = await listAdminSessionsByStaff(c.env.DB, staff.id, new Date().toISOString());
  const sessions = rows.map((row) => ({
    id: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    userAgent: row.user_agent,
    ipPrefix: row.ip_prefix,
    current: false as boolean,
  }));
  const hash = await currentHash;
  for (const session of sessions) session.current = session.id === hash;
  return c.json({ success: true, data: { sessions } });
});

/**
 * DELETE /api/auth/sessions/:tokenHash — 本人のセッションを1件失効する。
 *
 * 他人の token_hash を指定しても 404（存在も明かさない）。今のセッションを
 * 消すときは `?confirmCurrent=1` か body の `confirmCurrent: true` が必須で、
 * 確認付きなら cookie も期限切れにして再利用を防ぐ。
 */
adminAuth.delete('/api/auth/sessions/:tokenHash', async (c) => {
  const staff = c.get('staff');
  if (!staff) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const tokenHash = c.req.param('tokenHash');
  const currentHash = await adminSessionTokenHashFromRequest(c);
  const body = await c.req.json<{ confirmCurrent?: boolean }>().catch(() => ({} as { confirmCurrent?: boolean }));
  const confirmed = body.confirmCurrent === true || c.req.query('confirmCurrent') === '1';
  if (currentHash === tokenHash && !confirmed) {
    return c.json({
      success: false,
      error: '今使っている端末のログインを切るには confirmCurrent=1 を付けてください',
      code: 'CURRENT_SESSION_CONFIRMATION_REQUIRED',
    }, 409);
  }
  if (!await deleteAdminSessionForStaff(c.env.DB, staff.id, tokenHash)) {
    return fail(c, 404, 'SESSION_NOT_FOUND');
  }
  if (currentHash === tokenHash) {
    const { sameSite } = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
    c.header('Set-Cookie', expiredCookie(ADMIN_AUTH_COOKIE, sameSite), { append: true });
    c.header('Set-Cookie', expiredCookie(CSRF_COOKIE, sameSite), { append: true });
  }
  return c.json({ success: true, data: { revoked: 1, current: currentHash === tokenHash } });
});

/** POST /api/auth/sessions/revoke-others — 今のセッション以外をまとめて失効する。 */
adminAuth.post('/api/auth/sessions/revoke-others', inputJsonBoundary(), async (c) => {
  const staff = c.get('staff');
  if (!staff) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const currentHash = await adminSessionTokenHashFromRequest(c);
  const revoked = currentHash
    ? await deleteOtherAdminSessions(c.env.DB, staff.id, currentHash)
    : 0;
  // 一括失効は乗っ取り対応で使われる高危険操作。記録失敗で失効自体は止めない。
  try {
    await recordAuditEvent(c.env.DB, {
      category: 'auth',
      action: 'auth.sessions_revoked',
      actorPrincipalId: staff.id,
      actorRole: staff.readOnly ? 'view_only' : staff.role === 'owner' || staff.role === 'admin' ? 'administrator' : 'operations',
      targetKind: 'staff',
      targetId: staff.id,
      tenantId: staff.tenantId,
      result: 'success',
      riskLevel: 'high',
      retentionClass: 'security',
      reason: 'revoke_other_sessions',
      ipPrefix: maskIpPrefix(clientIp(c)),
      after: { revoked },
    });
  } catch (error) {
    logger.error("admin_auth.auth_sessions_revoke_others_create_failed");
  }
  return c.json({ success: true, data: { revoked } });
});
