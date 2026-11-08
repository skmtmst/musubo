import { timingMiddleware, timingSpan } from '../lib/server-timing.js';
import { rememberAuthenticatedStaffRecord } from '../lib/authenticated-staff-record.js';
import { logger } from '@line-crm/shared/server';
/** 内部の認証モジュールにある手動確認の境界を保ち、既存の公開入口を提供する。 */
import { bearerToken } from './auth-http.js';
import { isPublicApiBoundary, isPublicFormDefinition } from './public-api-boundary.js';
import { mfaEncryptionConfigured } from '../lib/mfa-config.js';
import type { Context, Next } from 'hono';
import { deleteAdminSession, getPlatformSetting, getStaffByAdminSession, getStaffByApiKey } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { isForbiddenWhileImpersonating, resolveImpersonation } from './impersonation.js';
import { isOutputRequest } from './output-request.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { ADMIN_SESSION_BEARER_PREFIX, CSRF_HEADER, adminSessionTokenFromCookie, csrfTokenFromCookie, sha256Hex } from './auth/credentials/auth.js';
import { toAuthenticatedStaff, isTenantUnavailable, isTenantSuspensionExemptPath, TENANT_SUSPENDED_CODE, TENANT_SUSPENDED_ERROR, type AuthenticatedStaff } from './auth/principal/auth.js';
import { gap2ReadOperation, gap2SelfPreference, readOperationPermissions, permissionForApiPath, isStaffSelfEndpoint, isStaffExplicitAllow } from './auth/permissions/auth.js';
import { isHqBusinessOperation } from './hq-role-policy.js';

export { ADMIN_AUTH_COOKIE, ADMIN_SESSION_BEARER_PREFIX, CSRF_COOKIE, CSRF_HEADER, SESSION_DEFAULT_MAX_AGE, SESSION_REMEMBER_MAX_AGE, SESSION_MAX_AGE, adminSessionTokenHashFromRequest, adminSessionTokenFromCookie, csrfTokenFromCookie, adminSessionCookie, csrfCookie, expiredCookie, sha256Hex } from './auth/credentials/auth.js';
export { toAuthenticatedStaff, isTenantUnavailable, isTenantSuspensionExemptPath, TENANT_SUSPENDED_CODE, TENANT_SUSPENDED_ERROR, type AuthenticatedStaff, type StaffRole, type TenantStatus } from './auth/principal/auth.js';
export { gap2ReadOperation, permissionForApiPath, isStaffSelfRouteTemplate, isStaffSelfEndpoint, isStaffExplicitAllow } from './auth/permissions/auth.js';
export { isPublicApiBoundary } from './public-api-boundary.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function authenticateAdminSession(
  c: Context<Env>,
  token: string | null,
): Promise<AuthenticatedStaff | null> {
  return timingSpan(c, 'session', async () => {
    if (!token) return null;
    const tokenHash = await sha256Hex(token);
    const staff = await timingSpan(c, 'staff', () => getStaffByAdminSession(c.env.DB, tokenHash, new Date().toISOString()));
    if (!staff) return null;
    const configured = mfaEncryptionConfigured(c.env.TOTP_ENCRYPTION_KEY);
    const registered = Boolean(staff.totp_enabled_at && staff.totp_secret_enc);
    // 方針と確認済みの印は独立。未登録者の印は読んでも許可できないので取らない。
    const [policy, verified] = await Promise.all([
      configured ? getPlatformSetting(c.env.DB, `auth.mfa.required:${staff.tenant_id ?? DEFAULT_TENANT_ID}`) : null,
      registered ? getPlatformSetting(c.env.DB, `auth.mfa.session:${tokenHash}`) : null,
    ]);
    const required = configured && policy !== 'false';
    if ((required && !registered) || (registered && verified !== staff.id)) {
      await deleteAdminSession(c.env.DB, tokenHash);
      return null;
    }
    return rememberAuthenticatedStaffRecord(c.env.DB, { ...toAuthenticatedStaff(staff), credential: 'session' }, staff);
  });
}

async function authenticateCookieToken(
  c: Context<Env>,
  token: string | null,
): Promise<AuthenticatedStaff | null> {
  const session = await authenticateAdminSession(c, token);
  if (session) return session;
  // 非公開の API キー経路で作成した緊急用セッションとの互換性を保つ。
  return authenticateApiToken(c, token);
}

/** Cookie と Bearer で受け付ける資格情報がずれないよう、認証 middleware とログインが同じトークン解決を使う。 */
export async function authenticateApiToken(
  c: Context<Env>,
  token: string | null,
): Promise<AuthenticatedStaff | null> {
  if (!token) return null;

  // iOS/LINE WebView で別サイトの Cookie が拒まれる場合に備え、OAuth コールバックは既存の不透明なセッショントークンを fragment で渡し、管理画面が Bearer で提示する。
  if (token.startsWith(ADMIN_SESSION_BEARER_PREFIX)) {
    return authenticateAdminSession(c, token.slice(ADMIN_SESSION_BEARER_PREFIX.length));
  }

  const staff = await timingSpan(c, 'staff', () => getStaffByApiKey(c.env.DB, token));
  if (staff) {
    const required = mfaEncryptionConfigured(c.env.TOTP_ENCRYPTION_KEY) && await getPlatformSetting(c.env.DB, `auth.mfa.required:${staff.tenant_id ?? DEFAULT_TENANT_ID}`) !== 'false';
    // この入口は一次資格情報を確認課題へ交換するだけとし、ほかの API が使える認証済みコンテキストを渡さない。
    if (c.req.path !== '/api/auth/login' && (required || staff.totp_enabled_at)) return null;
    return rememberAuthenticatedStaffRecord(c.env.DB, { ...toAuthenticatedStaff(staff), credential: 'api-key' }, staff);
  }

  // 環境変数の現行 API_KEY は owner として扱う。
  if (token === c.env.API_KEY) {
    if (mfaEncryptionConfigured(c.env.TOTP_ENCRYPTION_KEY) && await getPlatformSetting(c.env.DB, `auth.mfa.required:${DEFAULT_TENANT_ID}`) !== 'false') return null;
    return { id: 'env-owner', name: 'Owner', role: 'owner', readOnly: false, permissionKeys: [], assignedLineAccountId: null, canAccessDescendantAccounts: true, tenantStatus: 'active', credential: 'api-key' };
  }

  // ローテーション猶予中は LEGACY_API_KEY も受け付ける。同じ値なら現行キーで処理済みなので旧キーの計数を増やさない。削除前に利用が0か確認できるよう accept_via を記録する。
  if (
    c.env.LEGACY_API_KEY &&
    c.env.LEGACY_API_KEY !== c.env.API_KEY &&
    token === c.env.LEGACY_API_KEY
  ) {
    if (mfaEncryptionConfigured(c.env.TOTP_ENCRYPTION_KEY) && await getPlatformSetting(c.env.DB, `auth.mfa.required:${DEFAULT_TENANT_ID}`) !== 'false') return null;
    logger.log("auth_accept_via_LEGACY_API_KEY");
    return { id: 'env-owner', name: 'Owner', role: 'owner', readOnly: false, permissionKeys: [], assignedLineAccountId: null, canAccessDescendantAccounts: true, tenantStatus: 'active', credential: 'api-key' };
  }

  return null;
}

async function authenticateRequest(c: Context<Env>, next: Next): Promise<Response | void> {
  // LINE Webhook は署名認証、OpenAPI は公開文書のため、スタッフ認証を省く。
  const path = c.req.path;
  // LIFF / admin の SPA アセットは Authorization ヘッダなしで HTML を取りに
  // くる。Worker は API 以外のパスを ASSETS バインディングから配信するので、
  // /api/ で始まらないパスは認証 skip して static asset として返す。
  // (admin は別ホスト、Worker の non-API path はすべて LIFF/SPA 経由)
  const method = c.req.method.toUpperCase();
  if (!path.startsWith('/api/')) {
    // ただし内部用エンドポイント (/webhook, /auth, /setup) は元の skip 判定に任せる
    if (
      path !== '/webhook' &&
      !path.startsWith('/auth/') &&
      path !== '/setup' &&
      !path.startsWith('/t/') &&
      !path.startsWith('/r/') &&
      !path.startsWith('/pool/') &&
      !path.startsWith('/images/')
    ) {
      return next();
    }
  }

  // LIFF は回答前にフォーム定義が必要なので GET は公開用に伏せた内容を返す。認証済みの管理 API には完全な定義を返す。同じパスの PUT/DELETE は例外にせず通常の管理認証を通す。
  const publicForm = isPublicFormDefinition(method, path);
  if (publicForm && !c.req.query('account_id')) {
    const bearer = bearerToken(c);
    const cookie = adminSessionTokenFromCookie(c);
    const staff = bearer
      ? await authenticateApiToken(c, bearer)
      : await authenticateCookieToken(c, cookie);
    if (staff) c.set('staff', staff);
    return next();
  }

  // 公開境界(LIFF・webhook・署名検証の入口)は認証より手前へ通す。
  // 判定の中身は isPublicApiBoundary に集約し、契約テストと共有する。
  // (LIFF の回答系は route 側で LINE 署名を見るため管理認証の対象外)
  if (isPublicApiBoundary(method, path) && !(publicForm && c.req.query('account_id'))) return next();

  const bearer = bearerToken(c);
  const cookie = adminSessionTokenFromCookie(c);
  let staff = bearer
    ? await authenticateApiToken(c, bearer)
    : await authenticateCookieToken(c, cookie);
  if (!staff) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  // 代理ログイン（★37-5）。運営マスターが契約先の画面に入っている間だけ、
  // 見ている統括を差し替える。既定は閲覧のみなので、この直後の readOnly 判定に乗る。
  const authenticated = staff;
  const impersonated = await timingSpan(c, 'impersonation', () => resolveImpersonation(c, authenticated, path));
  if (impersonated) {
    staff = impersonated.staff;
    c.set('impersonation', impersonated.context);
    if (isForbiddenWhileImpersonating(method, path)) {
      return c.json({ success: false, error: '代理ログイン中はこの操作はできません（解約・権限者の削除・LINEアカウントの削除）' }, 403);
    }
  }

  // 契約先の停止・保管は画面非表示ではなく、すべての管理APIの共通境界で
  // 強制する。運営マスターによる有効な代理ログインだけは閲覧を継続できる。
  if (!impersonated
      && isTenantUnavailable(staff.tenantStatus)
      && !isTenantSuspensionExemptPath(method, path)) {
    return c.json({ success: false, code: TENANT_SUSPENDED_CODE, error: TENANT_SUSPENDED_ERROR }, 403);
  }

  if (staff.readOnly && !SAFE_METHODS.has(method) && !gap2ReadOperation(method,path) && !gap2SelfPreference(method,path)) {
    return c.json({ success: false, error: '閲覧のみの権限では変更操作を実行できません' }, 403);
  }

  const outputRequest = isOutputRequest(path, c.req.query('format'), method);
  if (staff.readOnly && outputRequest && !(path==='/api/hq/store-comparison/export'||/^\/api\/hq\/store-comparison\/exports\/[^/]+\/download$/.test(path))) {
    return c.json({ success: false, error: '閲覧のみの権限では書き出しを実行できません' }, 403);
  }

  //  staff は deny-by-default。権限表に無い管理 API は
  // 本人・自組織と明示許可の口以外すべて 403。owner/admin は従来どおり通す。
  // 運営メンバーは、運営会社の統括に属する通常の staff として作る。
  // /api/ops/* は直後の route 側で requirePlatformAdmin が全件を守るため、
  // ここで通常スタッフ向けの画面権限へ落とすと、登録済みの運営メンバーまで
  // 専用判定へ到達する前に 403 になる。運営 API だけは専用の門番へ委ねる。
  const usesPlatformAdminAuthorization = path.startsWith('/api/ops/') || path === '/api/auth/two-factor/policy';
  if (staff.role === 'staff'
      && !usesPlatformAdminAuthorization
      && !isStaffSelfEndpoint(method, path, staff.id)
      && !isStaffExplicitAllow(method, path)
      && !(staff.hqRole === 'operator' && isHqBusinessOperation(method, path, staff.id))
      && !(staff.hqRole === 'viewer' && SAFE_METHODS.has(method) && isHqBusinessOperation(method, path, staff.id))) {
    const requiredPermission = permissionForApiPath(path);
    const requiredPermissions = readOperationPermissions(method, path) ?? (requiredPermission ? [requiredPermission] : []);
    // 閲覧鍵は安全なメソッドか、表に登録された読取操作だけに使う。
    const granted = requiredPermissions.some(permission => staff.permissionKeys?.includes(permission)
      || ((SAFE_METHODS.has(method)||gap2ReadOperation(method,path)) && !outputRequest && staff.viewPermissionKeys?.includes(permission)));
    if (!granted) {
      return c.json({ success: false, error: 'この機能を操作する権限がありません' }, 403);
    }
  }

  // CSRF は Cookie 認証の更新要求だけに適用する。Bearer は攻撃側が Authorization を付けられず、GET/HEAD/OPTIONS は更新しないため対象外とする。
  if (!bearer && cookie && !SAFE_METHODS.has(c.req.method.toUpperCase())) {
    const header = c.req.header(CSRF_HEADER);
    const expected = csrfTokenFromCookie(c);
    if (!header || !expected || header !== expected) {
      return c.json({ success: false, error: 'CSRF token mismatch' }, 403);
    }
  }

  c.set('staff', staff);
  return next();
}

const timedAuthentication = timingMiddleware('auth', authenticateRequest);

export async function authMiddleware(c: Context<Env>, next: Next): Promise<Response | void> {
  return timedAuthentication(c, next);
}
