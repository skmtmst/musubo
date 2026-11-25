import { logger } from '@line-crm/shared/server';
import { parseCookieHeader } from '../middleware/auth-http.js';
import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { adminSessionCookie, csrfCookie, SESSION_DEFAULT_MAX_AGE, SESSION_REMEMBER_MAX_AGE, sha256Hex } from '../middleware/auth/credentials/auth.js';
import {
  adminSessionFamiliarity,
  createAdminSession,
  createTwoFactorChallenge,
  deleteExpiredTwoFactorChallenges,
  getStaffById,
  recordAuditEvent,
  recordLoginAudit,
  setPlatformSetting,
  type StaffMember,
  type TwoFactorChallengePurpose,
} from '@line-crm/db';

import { sendPlainMail } from './plain-mail.js';

/**
 * 権限者のセッション発行と、それに付随する小さな道具。
 *
 * LINE ログイン（routes/admin-auth.ts）とメール＋パスワードのログイン
 * （routes/auth-email.ts）で同じものを使う。発行のしかたを 2 か所に書かない。
 */

export const TWO_FACTOR_CHALLENGE_MAX_AGE = 5 * 60 * 1000;
/** 初回設定はQRを読んでアプリへ登録する手間があるため、確認用より長く持たせる。 */
export const TWO_FACTOR_SETUP_CHALLENGE_MAX_AGE = 15 * 60 * 1000;

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * 接続元のIP。
 *
 * Cloudflare が付けるヘッダを優先する。前段のプロキシが入る構成でも
 * 何かしら残るよう、順に見て最初に見つかったものを使う。
 */
export function clientIp(c: { req: { header: (name: string) => string | undefined } }): string | null {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    null
  );
}

/**
 * 一覧画面で端末を見分けるための伏せた接続元。
 *
 * 生のIPは個人情報に近いので保存しない。IPv4は先頭2オクテット、
 * IPv6は先頭3セグメントまで残す。
 */
export function maskIpPrefix(ip: string | null): string | null {
  if (!ip) return null;
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.*.*` : null;
  }
  const parts = ip.split(':');
  return parts.length >= 3 ? `${parts.slice(0, 3).join(':')}::*` : null;
}

/**
 * 端末の指紋に使う User-Agent の正規化。版番号（Chrome 129 → 130 のような
 * 自動更新）で別端末扱いにならないよう、数字と版番号だけを除く。
 */
export function normalizeUserAgentForDevice(userAgent: string): string {
  return userAgent.toLowerCase().replace(/\d+(\.\d+)*/g, '').replace(/\s+/g, ' ').trim();
}

export function deviceHashFromUserAgent(userAgent: string | null): Promise<string | null> {
  if (!userAgent) return Promise.resolve(null);
  return sha256Hex(normalizeUserAgentForDevice(userAgent));
}

/**
 * いつもと違う端末・場所からのログインを本人へ知らせる（-30 §14、V-2）。
 *
 * 管理画面の帯は session の unfamiliar_at が担う。ここでは監査（要確認の行）と
 * メールを出す。通知の失敗でログイン自体を止めない。
 */
async function notifyUnfamiliarLogin(
  c: Context<Env>,
  staffId: string,
  device: { ipPrefix: string | null; userAgent: string | null },
): Promise<void> {
  const staff = await getStaffById(c.env.DB, staffId).catch(() => null);
  try {
    await recordAuditEvent(c.env.DB, {
      category: 'auth',
      action: 'auth.login_unfamiliar',
      actorPrincipalId: staffId,
      actorRole: staff?.access_level === 'read_only'
        ? 'view_only'
        : staff?.role === 'owner' || staff?.role === 'admin' ? 'administrator' : 'operations',
      targetKind: 'staff',
      targetId: staffId,
      tenantId: staff?.tenant_id ?? null,
      result: 'success',
      riskLevel: 'suspicious',
      retentionClass: 'security',
      ipPrefix: device.ipPrefix,
      after: { note: 'いつもと違う端末・場所からのログイン' },
    });
  } catch (error) {
    logger.error("admin_session.record_unfamiliar_login_failed");
  }
  try {
    if (c.env.DEPLOY_ENV === 'staging' || c.env.DEPLOY_ENV === 'test') {
      await recordAuditEvent(c.env.DB, { category: 'auth', action: 'auth.login_notice.simulated', actorPrincipalId: staffId, tenantId: staff?.tenant_id, targetKind: 'staff', targetId: staffId, result: 'success', retentionClass: 'security' });
      return;
    }
    if (!staff?.email) return;
    const deviceLabel = device.userAgent
      ? (/iPhone|iPad/.test(device.userAgent) ? 'iPhone / iPad'
        : /Android/.test(device.userAgent) ? 'Android'
          : /Windows/.test(device.userAgent) ? 'Windows'
            : /Mac OS|Macintosh/.test(device.userAgent) ? 'Mac'
              : /Linux/.test(device.userAgent) ? 'Linux' : '不明な端末')
      : '不明な端末';
    await sendPlainMail(c.env, {
      to: staff.email,
      subject: '【musubo】いつもと違う端末・場所からのログインがありました',
      body: [
        `${staff.name} 様`,
        '',
        'musubo の管理画面に、いつもと違う端末または場所からのログインがありました。',
        `日時: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
        `端末: ${deviceLabel}`,
        `接続元: ${device.ipPrefix ?? '不明'}`,
        '',
        'このログインに心当たりがない場合は、パスワードの変更と他の端末のログイン解除を行い、管理者へ連絡してください。',
      ].join('\n'),
    });
  } catch (error) {
    logger.error("admin_session.notify_unfamiliar_login_failed");
  }
}

export async function issueSession(c: Context<Env>, staffId: string, sameSite: 'Strict' | 'Lax' | 'None', remember = false, mfaVerified = false) {
  const sessionToken = randomToken();
  const maxAge = remember ? SESSION_REMEMBER_MAX_AGE : SESSION_DEFAULT_MAX_AGE;
  const expiresAt = new Date(Date.now() + maxAge * 1000).toISOString();
  const userAgent = c.req.header('user-agent')?.slice(0, 300) ?? null;
  const ipPrefix = maskIpPrefix(clientIp(c));
  const deviceHash = await deviceHashFromUserAgent(userAgent);
  const previousMarker = parseCookieHeader(c.req.header('Cookie')).lh_login_device;
  const marker = previousMarker && /^[A-Za-z0-9_-]{20,128}$/.test(previousMarker) ? previousMarker : randomToken(24);
  const knownDeviceHash = await sha256Hex(`login-device:${marker}`);
  /*
   * いつもと違う判定。過去のセッションに同じ端末・同じ場所の形跡が無いときだけ
   * 立てる。検知クエリが失敗した場合は未確認に倒し、本人確認の再利用をさせない。
   */
  let unfamiliarAt: string | null = null;
  try {
    const familiarity = await adminSessionFamiliarity(c.env.DB, staffId, { deviceHash, ipPrefix });
    const known = await c.env.DB.prepare('SELECT device_hash FROM auth_known_devices WHERE staff_id = ?').bind(staffId).all<{ device_hash: string }>();
    if (known.results.length && !known.results.some(row => row.device_hash === knownDeviceHash)) unfamiliarAt = new Date().toISOString();
    if (familiarity.hasBaseline && (!familiarity.deviceKnown || !familiarity.ipKnown)) {
      unfamiliarAt = new Date().toISOString();
    }
    if (unfamiliarAt && ipPrefix) {
      const trusted = await c.env.DB.prepare("SELECT 1 AS found FROM auth_trusted_logins WHERE staff_id = ? AND marker_hash = ? AND ip_prefix = ? AND datetime(confirmed_at) > datetime('now', '-90 days')").bind(staffId, knownDeviceHash, ipPrefix).first();
      if (trusted) unfamiliarAt = null;
    }
  } catch (error) {
    unfamiliarAt = new Date().toISOString();
    logger.error("admin_session.check_device_familiarity_failed");
  }
  await c.env.DB.prepare(`INSERT INTO auth_known_devices(staff_id, device_hash, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(staff_id, device_hash) DO UPDATE SET last_seen_at=excluded.last_seen_at`).bind(staffId, knownDeviceHash, new Date().toISOString(), new Date().toISOString()).run();
  await createAdminSession(c.env.DB, await sha256Hex(sessionToken), staffId, expiresAt, {
    userAgent,
    ipPrefix,
    deviceHash,
    unfamiliarAt,
  });
  if (mfaVerified) await setPlatformSetting(c.env.DB, `auth.mfa.session:${await sha256Hex(sessionToken)}`, staffId, staffId);
  if (unfamiliarAt) {
    await notifyUnfamiliarLogin(c, staffId, { ipPrefix, userAgent });
  }
  const csrfToken = randomToken();
  c.header('Set-Cookie', `lh_login_device=${marker}; Path=/api/auth; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=31536000`, { append: true });
  c.header('Set-Cookie', adminSessionCookie(sessionToken, sameSite, maxAge), { append: true });
  c.header('Set-Cookie', csrfCookie(csrfToken, sameSite, maxAge), { append: true });
  return { csrfToken, sessionToken };
}

export function twoFactorRequired(staff: Pick<StaffMember, 'totp_enabled_at' | 'totp_secret_enc'>): boolean {
  return Boolean(staff.totp_enabled_at && staff.totp_secret_enc);
}

/** 二段階認証の合言葉を作って返す。画面はこれを `/login/two-factor#lh_2fa=` で受け取る。 */
export async function startTwoFactorChallenge(
  c: Context<Env>,
  staffId: string,
  options: { purpose?: TwoFactorChallengePurpose; remember?: boolean } = {},
): Promise<string> {
  const challengeToken = randomToken();
  await deleteExpiredTwoFactorChallenges(c.env.DB, new Date().toISOString());
  const purpose = options.purpose ?? 'verify';
  const maxAge = purpose === 'setup' ? TWO_FACTOR_SETUP_CHALLENGE_MAX_AGE : TWO_FACTOR_CHALLENGE_MAX_AGE;
  await createTwoFactorChallenge(
    c.env.DB,
    await sha256Hex(challengeToken),
    staffId,
    new Date(Date.now() + maxAge).toISOString(),
    { purpose, remember: options.remember },
  );
  return challengeToken;
}

export function twoFactorLoginUrl(c: Context<Env>, challengeToken: string, next?: string | null): string {
  const base = c.env.ADMIN_PUBLIC_URL?.replace(/\/+$/, '');
  if (!base) throw new Error('ADMIN_PUBLIC_URL is not configured');
  const url = new URL(`${base}/login/two-factor`);
  if (next === 'ops') url.searchParams.set('next', 'ops');
  url.hash = new URLSearchParams({ lh_2fa: challengeToken, lh_nonce: c.get('adminHandoffNonce') || '' }).toString();
  return url.toString();
}

/** TOTP未登録の管理者向け。画面は `/login/two-factor/setup#lh_2fa=` で受け取る。 */
export function twoFactorSetupUrl(c: Context<Env>, challengeToken: string, next?: string | null): string {
  const base = c.env.ADMIN_PUBLIC_URL?.replace(/\/+$/, '');
  if (!base) throw new Error('ADMIN_PUBLIC_URL is not configured');
  const url = new URL(`${base}/login/two-factor/setup`);
  if (next === 'ops') url.searchParams.set('next', 'ops');
  url.hash = new URLSearchParams({ lh_2fa: challengeToken, lh_nonce: c.get('adminHandoffNonce') || '' }).toString();
  return url.toString();
}

export async function recordSuccessfulLoginAudit(c: Context<Env>, staffId: string, onFailure?: () => void): Promise<void> {
  try {
    await recordLoginAudit(c.env.DB, {
      adminUserId: staffId,
      action: 'login',
      ip: clientIp(c),
      userAgent: c.req.header('user-agent') ?? null,
    });
  } catch (error) {
    if (onFailure) onFailure();
    else logger.error("auth_email.record_successful_login_audit_failed");
  }
}
