import { readAuthenticatedStaffRecord } from '../lib/authenticated-staff-record.js';
import { logger } from '@line-crm/shared/server';
import { mfaEncryptionConfigured } from '../lib/mfa-config.js';
import { effectiveStaffEditKeys, SCOPE_OPERATION_KEYS } from '@line-crm/shared';
import {
  ACCESS_ROLE_BUNDLE_IDS, SCOPE_ITEMS, BUNDLE_PRESETS, scopeLevelsToKeys, keysToScopeLevels,
  type AccessRoleBundleId, type FeatureAccessLevel, type EmailMaskLevel, type ScopeLevels,
} from '@line-crm/shared';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  activatePlatformAdminIfAwaitingTotp, getPlatformSetting, auditEventStatement,
  getStaffMembers, getStaffById, getStaffByInviteTokenHash, getStaffByEmailChangeTokenHash,
  createStaffMemberWithScopes, updateStaffMember, deleteStaffMemberWithScopes, countLoginAudit, getLastLoginByStaff,
  getStaffAccountScopeIds, getStaffAccountScopeMap, replaceStaffAccountScopes, revokeStaffAuthentication,
  reserveTwoFactorSetupAttempt, clearTwoFactorSetupAttempts,
} from '@line-crm/db';
import { consumeStepUpToken, sensitiveStepUpSatisfied } from '../lib/step-up.js';
import type { StaffMember } from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import { adminSessionTokenHashFromRequest, sha256Hex } from '../middleware/auth.js';
import {
  sendStaffInviteEmail, sendStaffLineLinkEmail,
  sendStaffEmailChangeConfirmEmail, sendStaffEmailChangeNoticeEmail, sendStaffEmailChangeCompletedEmail,
} from '../services/staff-invite.js';
import { buildTotpUri, decryptTotpSecret, encryptTotpSecret, generateTotpSecret, verifyTotp } from '../lib/totp.js';
import type { Env } from '../worker-env.js';
import { getLineAccounts } from '@line-crm/db';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { fail } from '../lib/fail.js';

import {
  getStaffPermissionReceipt, saveStaffPermissionReceipt,
} from '@line-crm/db';

const staff = new Hono<Env>();
// 招待の有効期限は7日。要件 -30 §9-2・§17(既存の48時間招待はその期限のまま守り、新規・再送から7日)。
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/* 本人のメール変更の確認リンクは24時間。招待より短く、放置された変更申し込みが残らないようにする。 */
const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;
const TWO_FACTOR_ATTEMPT_LIMIT_ERROR = '入力回数を超えました。しばらく待ってからやり直してください';

/**
 * 高危険な権限変更の直前再認証（ → V の共通仕組み）。
 *
 * 同じセッションでの再確認は10分の窓で再利用する。いつもと違う端末・場所の
 * セッションは窓を使わせず、操作ごとに X-Step-Up-Token の1回限り grant を
 * 消費する（atomic なので同じ token は2回目に必ず失敗する）。
 */
async function consumeStaffStepUp(c: Context<Env>, purpose: 'staff.permissions.change' | 'staff.two_factor.remove'): Promise<boolean> {
  return sensitiveStepUpSatisfied(c, purpose);
}

function invitationConfirmationUrl(c: { env: Env['Bindings']; req: { url: string } }, token: string): string {
  const base = c.env.ADMIN_PUBLIC_URL?.trim() || new URL(c.req.url).origin;
  const url = new URL('/staff/invite', base);
  // fragment はHTTPリクエストやアクセスログへ送られない。確認画面が読み取ったら即座に消す。
  url.hash = new URLSearchParams({ invite: token }).toString();
  return url.toString();
}

/** メール変更の確認画面。招待と同じく秘密の値は fragment に置き、アクセスログへ残さない。 */
function emailChangeConfirmationUrl(c: { env: Env['Bindings']; req: { url: string } }, token: string): string {
  const base = c.env.ADMIN_PUBLIC_URL?.trim() || new URL(c.req.url).origin;
  const url = new URL('/staff/email-change', base);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

function safeJson<T>(value: string | null | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

/**
 * 役割バンドル（-30 §7 のカタログ）。
 * role_bundle 列が正本。未保存の行は role/access_level から従来どおり推定する。
 */
function parseRoleBundle(value: string | null | undefined): AccessRoleBundleId | null {
  return value && (ACCESS_ROLE_BUNDLE_IDS as readonly string[]).includes(value)
    ? value as AccessRoleBundleId
    : null;
}

function staffBundle(member: Pick<StaffMember, 'role' | 'access_level' | 'role_bundle'>): AccessRoleBundleId {
  const saved = parseRoleBundle(member.role_bundle);
  if (saved) return saved;
  if (member.access_level === 'read_only') return 'view_only';
  return member.role === 'owner' || member.role === 'admin' ? 'administrator' : 'custom';
}

function inviteRoleLabel(member: Pick<StaffMember, 'role' | 'access_level' | 'role_bundle'>): '管理者' | '担当者' | '閲覧のみ' {
  const bundle = staffBundle(member);
  return bundle === 'administrator' ? '管理者' : bundle === 'view_only' ? '閲覧のみ' : '担当者';
}

function parseEmailMask(value: unknown): EmailMaskLevel | null | undefined {
  if (value === undefined) return undefined;
  return value === 'full' || value === 'masked' || value === 'none' ? value : null;
}

function parseScope(value: unknown): ScopeLevels | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const [key, level] of Object.entries(value)) {
    if (!SCOPE_ITEMS.some((item) => item.id === key)) return null;
    if (level !== 'none' && level !== 'view' && level !== 'edit') return null;
  }
  return value as ScopeLevels;
}

/*
 * 見せる範囲の表・かたまりが管理するキーの集合。
 * `/automations` のように表にも全プリセットにも載っていない既存キーは、
 * この外側として保存で落とさない（温存する）。
 */
const SCOPE_COVERED_KEYS: ReadonlySet<string> = new Set([
  ...SCOPE_ITEMS.flatMap((item) => item.keys),
  ...SCOPE_OPERATION_KEYS,
]);

/*
 * 個別編集の窓で付け外しできる顔ぶれ。
 * web の `staff/page.tsx` の EDIT_PERMISSION_PATHS（21件）と
 * `permission-labels.ts` の成果承認の組（操作＋表示）に対応する。
 * この外側のキーはその窓から消せないので、保存で落とさない。
 * 顔ぶれを変えたらこちらも合わせる。
 */
const INDIVIDUAL_EDIT_UI_KEYS: ReadonlySet<string> = new Set([
  '/', '/chats', '/friends', '/tags', '/scenarios', '/broadcasts', '/reminders',
  '/auto-replies', '/templates', '/rich-menus', '/form-submissions', '/contents/vars',
  '/contents', '/analytics', '/automations', '/webhooks', '/booking/bookings',
  '/ec-commerce', '/line-notifications', '/nen-campaigns', '/nen-members',
  '/conversions', 'conversion.approval.edit',
]);

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function parseIdempotencyKey(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value) ? value : null;
}

function parseExpectedPolicyVersion(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

function displayRole(row: StaffMember): 'admin' | 'staff' | 'viewer' {
  if (row.access_level === 'read_only') return 'viewer';
  return row.role === 'staff' ? 'staff' : 'admin';
}

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  return at > 0 ? `${email.slice(0, 1)}***${email.slice(at)}` : '***';
}

/**
 * スタッフのメールアドレスの見せ方（ フィールド権限）。
 * email_mask 列が正本: full=そのまま / masked=伏せ字 / none=出さない。
 * 未設定の行は従来判定（本人・管理者・access.user.email.view だけ実アドレス）。
 */
function staffEmailVisibility(
  c: { get: (key: 'staff') => Env['Variables']['staff'] },
  targetId: string,
): 'full' | 'masked' | 'none' {
  const current = c.get('staff');
  if (current.id === targetId) return 'full';
  if (current.emailMask === 'full' || current.emailMask === 'masked' || current.emailMask === 'none') {
    return current.emailMask;
  }
  return current.role === 'owner' || current.role === 'admin'
    || current.permissionKeys?.includes('access.user.email.view') === true
    ? 'full'
    : 'masked';
}

async function serializeStaff(
  db: D1Database,
  row: StaffMember,
  emailVisibility: 'full' | 'masked' | 'none' = 'full',
  preloadedScopes?: Map<string, string[]>,
) {
  const accountScope = row.account_scope ?? 'all';
  const editKeys = safeJson<string[]>(row.permission_keys, []);
  const viewKeys = safeJson<string[]>(row.view_permission_keys, []);
  const emailMask = parseEmailMask(row.email_mask) ?? null;
  // 個人情報行はキー表に載らない別枠なので、メール見せ方から3択へ写す。
  const piiLevel = emailMask === 'full' ? 'edit' : emailMask === 'none' ? 'none' : 'view';
  return {
    id: row.id,
    // ブラウザが再試行の受領票を認証範囲で分けられるよう、資格情報ではない識別子を返す。
    tenantId: row.tenant_id ?? DEFAULT_TENANT_ID,
    name: row.name,
    email: emailVisibility === 'full' ? row.email : emailVisibility === 'masked' ? maskEmail(row.email) : null,
    role: displayRole(row),
    roleBundle: staffBundle(row),
    emailMask,
    lineLinked: Boolean(row.line_user_id),
    twoFactorEnabled: Boolean(row.totp_enabled_at && row.totp_secret_enc),
    isActive: Boolean(row.is_active),
    permissionKeys: effectiveStaffEditKeys(editKeys),
    permissionViewKeys: viewKeys,
    permissionScope: { ...keysToScopeLevels(editKeys, viewKeys), pii: piiLevel },
    notificationPreferences: safeJson<Record<string, { email: boolean; line: boolean }>>(row.notification_preferences, {}),
    inviteStatus: row.invite_status || 'active',
    inviteExpiresAt: row.invite_expires_at ?? null,
    policyVersion: Number(row.policy_version ?? 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assignedLineAccountId: row.assigned_line_account_id ?? null,
    canAccessDescendantAccounts: Boolean(row.can_access_descendant_accounts),
    accountScope,
    scopedLineAccountIds: accountScope === 'accounts'
      ? (preloadedScopes?.get(row.id) ?? await getStaffAccountScopeIds(db, row.id))
      : [],
  };
}

type AccountScopeInput = {
  accountScope?: 'all' | 'accounts';
  scopedLineAccountIds?: string[];
};

function normalizeAccountScopeInput(body: AccountScopeInput):
  | { accountScope: undefined; scopedLineAccountIds: undefined }
  | { accountScope: 'all' | 'accounts'; scopedLineAccountIds: string[] }
  | { error: string } {
  if (body.accountScope === undefined) {
    return { accountScope: undefined, scopedLineAccountIds: undefined };
  }
  if (body.accountScope !== 'all' && body.accountScope !== 'accounts') {
    return { error: '店舗の権限範囲が正しくありません' };
  }
  if (body.accountScope === 'all') return { accountScope: 'all', scopedLineAccountIds: [] };
  if (!Array.isArray(body.scopedLineAccountIds)) return { error: '指定店舗を選択してください' };
  const ids = [...new Set(body.scopedLineAccountIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0 || ids.length !== body.scopedLineAccountIds.length) {
    return { error: '指定店舗を1つ以上選択してください' };
  }
  return { accountScope: 'accounts', scopedLineAccountIds: ids };
}

async function hasAllAccountScope(db: D1Database, current: Env['Variables']['staff']): Promise<boolean> {
  if (current.id === 'env-owner') return true;
  const member = await getStaffById(db, current.id);
  return Boolean(member?.is_active && member.account_scope === 'all'
    && (member.tenant_id ?? DEFAULT_TENANT_ID) === (current.tenantId ?? DEFAULT_TENANT_ID));
}

async function canAccessStaffMember(db: D1Database, current: Env['Variables']['staff'], target: StaffMember): Promise<boolean> {
  if (current.id === target.id || await hasAllAccountScope(db, current)) return true;
  if (target.account_scope !== 'accounts') return false;
  const [actorIds, targetIds] = await Promise.all([
    getStaffAccountScopeIds(db, current.id),
    getStaffAccountScopeIds(db, target.id),
  ]);
  return targetIds.length > 0 && targetIds.every((id) => actorIds.includes(id));
}

async function mayAssignAccountScopes(
  db: D1Database,
  current: Env['Variables']['staff'],
  requestedScope: 'all' | 'accounts',
  requestedIds: string[],
): Promise<boolean> {
  if (current.id === 'env-owner') return true;
  const currentMember = await getStaffById(db, current.id);
  if (!currentMember?.is_active || (currentMember.tenant_id ?? DEFAULT_TENANT_ID) !== (current.tenantId ?? DEFAULT_TENANT_ID)) return false;
  if (requestedScope === 'all') return currentMember.account_scope === 'all';
  const allowedIds = currentMember?.account_scope === 'accounts'
    ? await getStaffAccountScopeIds(db, current.id)
    : (await getVisibleLineAccountScope(db, current)).allowedAccountIds;
  return requestedIds.every((id) => allowedIds.includes(id));
}

/**
 * 設定を変えられる管理者。
 *
 * 役割が管理者でも、閲覧のみ（read_only）の人は更新系を一切通せないので、
 * 「最後の一人」を数えるときは頭数に入れない。無効化された人も同じ。
 */
function canAdminister(row: StaffMember): boolean {
  return Boolean(row.is_active) && row.role !== 'staff' && row.access_level !== 'read_only';
}

function currentTenantId(c: { get: (key: 'staff') => Env['Variables']['staff'] }): string {
  return c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
}

function isInCurrentTenant(
  c: { get: (key: 'staff') => Env['Variables']['staff'] },
  member: StaffMember,
): boolean {
  return (member.tenant_id ?? DEFAULT_TENANT_ID) === currentTenantId(c);
}

/**
 * 管理画面から誰も入れなくなる操作を止める。
 *
 * 一度これをやると、画面からは元に戻せない（無効な人は一覧に残るが、
 * それを有効化できる人がもういない）。DBを直接触るしか復旧手段が
 * なくなるので、サーバー側で断る。
 *
 * 戻り値はエラー文言。問題なければ null。
 */
async function guardLastAdmin(
  db: D1Database,
  target: StaffMember,
  tenantId: string,
  change: { isActive?: boolean; role?: 'admin' | 'staff' | 'viewer'; self: boolean },
): Promise<string | null> {
  if (!canAdminister(target)) return null;

  const stillAdmin =
    (change.isActive === undefined ? Boolean(target.is_active) : change.isActive) &&
    (change.role === undefined ? target.role !== 'staff' : change.role === 'admin') &&
    (change.role === undefined ? target.access_level !== 'read_only' : change.role !== 'viewer');
  if (stillAdmin) return null;

  if (change.self) return '自分自身の管理者権限は外せません。他の管理者に依頼してください。';

  const others = (await getStaffMembers(db, tenantId)).filter((row) => row.id !== target.id && canAdminister(row));
  if (others.length > 0) return null;
  return '管理者が一人もいなくなります。先に別の管理者を有効にしてください。';
}

const NOTIFICATION_KEYS = new Set(['operations', 'emergency', 'security', 'updates']);
const PERMISSION_KEY_PATTERN = /^[A-Za-z0-9_./-]{1,200}$/;
/* メールアドレスは実用上限254文字まで。超える宛先は招待が届かない行を残すので作らない。 */
const MAX_EMAIL_LENGTH = 254;
function emailTooLong(email: string): boolean {
  return email.length > MAX_EMAIL_LENGTH;
}

/*
 * 権限キーと通知設定の検証( 中3)。
 * 存在しない権限パスで「権限あり」に見える・将来の判定の抜け道になるのを防ぐ。
 * キー表は画面側( staff/page.tsx・staff/new/page.tsx )と他機能の点キー
 * (ec.event.view 等)が混在するため、ここでは形式と通知の種類を締める。
 * パス表の完全なホワイトリスト化はキー台帳の整備後に行う。
 */
function invalidPermissionKeys(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return '表示する機能の形式が正しくありません';
  if (value.length > 200) return '表示する機能が多すぎます';
  const bad = value.some((key) => typeof key !== 'string' || !PERMISSION_KEY_PATTERN.test(key));
  return bad ? '表示する機能に使えない文字があります' : null;
}

function invalidNotificationPreferences(value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '通知設定の形式が正しくありません';
  for (const [key, channels] of Object.entries(value as Record<string, unknown>)) {
    if (!NOTIFICATION_KEYS.has(key)) return '通知設定にない種類があります';
    if (!channels || typeof channels !== 'object' || Array.isArray(channels)) return '通知設定の形式が正しくありません';
    const { email, line } = channels as Record<string, unknown>;
    if (typeof email !== 'boolean' || typeof line !== 'boolean') return '通知設定はオン・オフで指定してください';
  }
  return null;
}

function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

staff.get('/api/staff/me', async (c) => {
  try {
    const current = c.get('staff');
    if (current.id === 'env-owner') {
      return c.json({ success: true, data: { id: current.id, tenantId: current.tenantId ?? DEFAULT_TENANT_ID, name: '管理者', role: 'admin', email: null, permissionKeys: [], assignedLineAccountId: null, canAccessDescendantAccounts: true, accountScope: 'all', scopedLineAccountIds: [] } });
    }
    const member = readAuthenticatedStaffRecord(c.env.DB, current) ?? await getStaffById(c.env.DB, current.id);
    if (!member) return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
    return c.json({ success: true, data: { ...await serializeStaff(c.env.DB, member), readOnly: current.readOnly } });
  } catch (error) {
    throw error;
  }
});

staff.get('/api/staff', async (c) => {
  try {
    const accountId = c.req.query('lineAccountId')?.trim();
    const allScope = await hasAllAccountScope(c.env.DB, c.get('staff'));
    if (!accountId && !allScope) return c.json({ success: false, error: 'アカウントを指定してください' }, 403);
    const visible = accountId ? await getVisibleLineAccountScope(c.env.DB, c.get('staff')) : null;
    if (accountId && !visible?.allowedAccountIds.includes(accountId)) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    const creator = accountId ? await c.env.DB.prepare('SELECT created_by_staff_id FROM line_accounts WHERE id=?').bind(accountId).first<{ created_by_staff_id: string | null }>() : null;
    const allMembers = await getStaffMembers(c.env.DB, currentTenantId(c));
    const scopedIds = await getStaffAccountScopeMap(c.env.DB, allMembers.filter((member) => member.account_scope === 'accounts').map((member) => member.id));
    const members = accountId
      ? allMembers.filter((member) => member.id === creator?.created_by_staff_id
        || member.account_scope === 'all'
        || (member.account_scope === 'accounts' && (scopedIds.get(member.id) ?? []).includes(accountId)))
      : allMembers.filter((member) => member.account_scope === 'all');
    // 担当範囲を1人ずつ読むと人数分の往復になるので一括取得する( 中1)。
    const scopes = scopedIds;
    const actor = c.get('staff');
    const actorCanManageAll = await hasAllAccountScope(c.env.DB, actor);
    const actorScopeIds = actorCanManageAll ? [] : await getStaffAccountScopeIds(c.env.DB, actor.id);
    return c.json({
      success: true,
      data: await Promise.all(members.map((member) => (
        serializeStaff(c.env.DB, member, staffEmailVisibility(c, member.id), scopes).then((item) => {
          const isAccountCreator = Boolean(accountId && member.id === creator?.created_by_staff_id);
          return {
            ...item,
            ...(accountId && member.account_scope === 'accounts' ? {
              scopedLineAccountIds: [accountId],
              assignedLineAccountId: accountId,
            } : {}),
            ...(isAccountCreator && member.account_scope === 'accounts' && member.access_level !== 'read_only' ? { role: 'admin' as const } : {}),
            isAccountCreator,
            canManageInAccount: Boolean(accountId && !isAccountCreator && member.account_scope === 'accounts'
              && (actorCanManageAll || (scopedIds.get(member.id) ?? []).every((id) => actorScopeIds.includes(id)))),
          };
        })
      ))),
    });
  } catch (error) {
    throw error;
  }
});

staff.get('/api/staff/:id/login-summary', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = c.req.param('id');
    const member = await getStaffById(c.env.DB, id);
    if (!member || !isInCurrentTenant(c, member)) return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
    if (!await canAccessStaffMember(c.env.DB, c.get('staff'), member)) return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
    const loginCount = await countLoginAudit(c.env.DB, { adminUserId: id, action: 'login' });
    return c.json({ success: true, data: { loginCount } });
  } catch (error) {
    throw error;
  }
});

/**
 * 権限者ごとの最終ログイン（統括のメンバー管理の列）。
 * 記録が無い人は入らない。値は日本時間の壁時計（login_audit と同じ）。
 */
staff.get('/api/staff/last-logins', requireRole('owner', 'admin'), async (c) => {
  try {
    if (!await hasAllAccountScope(c.env.DB, c.get('staff'))) return c.json({ success: false, error: '統括の権限が必要です' }, 403);
    const members = (await getStaffMembers(c.env.DB, currentTenantId(c))).filter((member) => member.account_scope === 'all');
    const data = await getLastLoginByStaff(c.env.DB, members.map((member) => member.id));
    return c.json({ success: true, data });
  } catch (error) {
    throw error;
  }
});

/**
 * 招待メールを送り直す。まだメールを確認していない人だけ。
 * 前の URL は使えなくなり、有効期限は送り直した時点から数え直す。
 */
staff.post('/api/staff/:id/resend-invite', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    const id = c.req.param('id');
    const member = await getStaffById(c.env.DB, id);
    if (!member || !isInCurrentTenant(c, member)) return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
    if (!await canAccessStaffMember(c.env.DB, c.get('staff'), member)) return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
    if (member.invite_status !== 'pending_email' || !member.email) {
      return c.json({ success: false, error: 'この権限者はすでにメールを確認しているため、送り直す必要はありません' }, 409);
    }
    if (!await hasAllAccountScope(c.env.DB, c.get('staff'))) {
      return c.json({ success: false, error: '全店舗の担当者だけが招待を送り直せます' }, 403);
    }
    const token = randomToken();
    await updateStaffMember(c.env.DB, member.id, {
      invite_token_hash: await sha256Hex(token),
      invite_expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    });
    await sendStaffInviteEmail(c.env, {
      name: member.name,
      email: member.email,
      verifyUrl: `${new URL(c.req.url).origin}/api/staff/invitations/${encodeURIComponent(token)}/verify`,
      roleLabel: inviteRoleLabel(member),
    });
    const refreshed = await getStaffById(c.env.DB, member.id);
    return c.json({ success: true, data: await serializeStaff(c.env.DB, refreshed ?? member) });
  } catch (error) {
    throw error;
  }
});

staff.get('/api/staff/:id', requireRole('owner', 'admin', 'staff'), async (c) => {
  const id = c.req.param('id');
  const current = c.get('staff');
  if (current.id !== id && current.role !== 'owner' && current.role !== 'admin') {
    return c.json({ success: false, error: 'この情報を表示する権限がありません' }, 403);
  }
  const member = await getStaffById(c.env.DB, id);
  return member && isInCurrentTenant(c, member) && await canAccessStaffMember(c.env.DB, current, member)
    ? c.json({ success: true, data: await serializeStaff(c.env.DB, member, staffEmailVisibility(c, member.id)) })
    : fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
});

staff.post('/api/staff', requireRole('owner', 'admin'), inputJsonBoundary({"name":["string"],"email":["string"],"role":["string"],"permissionKeys":["array"],"notificationPreferences":["object"],"assignedLineAccountId":["null","string"],"canAccessDescendantAccounts":["boolean"],"accountScope":["string"],"scopedLineAccountIds":["array"],"managementContext":["string"]}), async (c) => {
  try {
    const body = await c.req.json<{
      name?: string; email?: string; role?: 'admin' | 'staff' | 'viewer'; permissionKeys?: string[];
      notificationPreferences?: Record<string, { email: boolean; line: boolean }>;
      assignedLineAccountId?: string | null;
      canAccessDescendantAccounts?: boolean;
      accountScope?: 'all' | 'accounts'; scopedLineAccountIds?: string[]; managementContext?: 'hq';
    }>();
    const keyError = invalidPermissionKeys(body.permissionKeys) ?? invalidNotificationPreferences(body.notificationPreferences);
    if (keyError) return inputError(c, { success: false, error: keyError }, 400, ["permissionKeys","notificationPreferences"]);
    const accountScope = normalizeAccountScopeInput(body);
    if ('error' in accountScope) return inputError(c, { success: false, error: accountScope.error }, 400, ["accountScope","scopedLineAccountIds"]);
    if (accountScope.accountScope === undefined) return inputError(c, { success: false, error: '担当範囲を選んでください' }, 400, ["accountScope","scopedLineAccountIds"]);
    const name = body.name?.trim();
    const email = body.email?.trim().toLowerCase();
    if (!name) return inputError(c, { success: false, error: '名前を入力してください' }, 400, ["name"]);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return inputError(c, { success: false, error: '正しいメールアドレスを入力してください' }, 400, ["email"]);
    if (emailTooLong(email)) return inputError(c, { success: false, error: 'メールアドレスは254文字以内で入力してください' }, 400, ["email"]);
    if (!body.role || !['admin', 'staff', 'viewer'].includes(body.role)) return inputError(c, { success: false, error: '役割を選択してください' }, 400, ["role"]);
    if (!body.assignedLineAccountId && !(body.managementContext === 'hq' && accountScope.accountScope === 'all')) {
      return inputError(c, { success: false, error: '担当するLINEアカウントを選択してください' }, 400, ["assignedLineAccountId"]);
    }
    const visibleAccounts = (await getVisibleLineAccountScope(c.env.DB, c.get('staff'))).accounts;
    if (body.assignedLineAccountId && !visibleAccounts.some((account) => account.id === body.assignedLineAccountId)) {
      return c.json({ success: false, error: '権限のないLINEアカウントは割り当てできません' }, 403);
    }
    const current = c.get('staff');
    if (body.managementContext === 'hq' && !await hasAllAccountScope(c.env.DB, current)) {
      return c.json({ success: false, error: '全店舗の担当者だけが統括側の権限者を追加できます' }, 403);
    }
    if (body.managementContext === 'hq' && accountScope.accountScope !== 'all') return c.json({ success: false, error: '統括メンバーは全アカウントの範囲を指定してください' }, 400);
    const canGrantDescendants =
      current.role === 'owner' ||
      !current.assignedLineAccountId ||
      current.canAccessDescendantAccounts;
    if (body.canAccessDescendantAccounts && !canGrantDescendants) {
      return c.json({ success: false, error: '自分が持っていない他アカウント権限は付与できません' }, 403);
    }
    if (accountScope.accountScope !== undefined && !await mayAssignAccountScopes(c.env.DB, current, accountScope.accountScope, accountScope.scopedLineAccountIds)) {
      return c.json({ success: false, error: '権限のないLINEアカウントは指定できません' }, 403);
    }
    if (body.managementContext !== 'hq' && (
      accountScope.accountScope !== 'accounts' ||
      accountScope.scopedLineAccountIds.length !== 1 ||
      accountScope.scopedLineAccountIds[0] !== body.assignedLineAccountId ||
      body.canAccessDescendantAccounts
    )) {
      return c.json({ success: false, error: '店舗から追加する権限者は、このLINEアカウントだけを担当できます' }, 400);
    }
    // 同じメールの行があるときの扱い。要件 -30 §9-2(既存メールは管理者へ安全な案内)。
    // 招待中・期限切れの行は作り直す（上書き・掃除）。送信されなかった
    // 幽霊行が残っていても、同じメールの招待し直しで古い行を消して作り直す
    // ので、409で永久に塞がらない。利用開始済みは従来どおり登録済みで断る。
    const duplicateInvite = (await getStaffMembers(c.env.DB, currentTenantId(c)))
      .find((item) => item.email?.toLowerCase() === email);
    if (duplicateInvite) {
      if (!await canAccessStaffMember(c.env.DB, current, duplicateInvite)) {
        return c.json({ success: false, error: 'このメールアドレスは登録済みです' }, 409);
      }
      if (duplicateInvite.invite_status === 'pending_email' || duplicateInvite.invite_status === 'pending_line' || duplicateInvite.invite_status === 'expired') {
        try {
          await deleteStaffMemberWithScopes(c.env.DB, duplicateInvite.id);
        } catch (cleanupError) {
          logger.error("staff.create_failed");
        }
      } else {
        return c.json({ success: false, error: 'このメールアドレスは登録済みです' }, 409);
      }
    }

    const token = randomToken();
    // 作成時点の role から bundle を写す（role は初期値、実権限は保存キーが決める）。
    // 本人と担当範囲は同じ取引で書く。範囲の途中で止まっても幽霊行を残さない。
    let member: StaffMember;
    try {
      member = await createStaffMemberWithScopes(c.env.DB, {
        name, email,
        role: body.role === 'admin' ? 'admin' : 'staff',
        access_level: body.role === 'viewer' ? 'read_only' : 'full',
        role_bundle: body.role === 'admin' ? 'administrator' : body.role === 'viewer' ? 'view_only' : 'custom',
        view_permission_keys: body.role === 'viewer' ? scopeLevelsToKeys(BUNDLE_PRESETS.view_only.levels).view : [],
        email_mask: body.role === 'admin' ? 'full' : 'masked',
        is_active: 0,
        permission_keys: body.role === 'staff' ? (body.permissionKeys ?? []) : [],
        notification_preferences: body.notificationPreferences ?? {},
        invite_status: 'pending_email',
        invite_token_hash: await sha256Hex(token),
        invite_expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
        assigned_line_account_id: body.assignedLineAccountId,
        can_access_descendant_accounts: body.role === 'admin' && Boolean(body.canAccessDescendantAccounts),
        account_scope: accountScope.accountScope,
        tenant_id: current.tenantId ?? DEFAULT_TENANT_ID,
      }, accountScope.scopedLineAccountIds);
    } catch (error) {
      // 同時に届いた招待は一意制約で片方だけが残る。負けた側は作り直さず送り直しへ案内する。
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        return c.json({ success: false, error: 'このメールアドレスは招待中です。新しく作り直さず、ログインユーザー画面の「招待中」タブからもう一度送り直してください。' }, 409);
      }
      throw error;
    }
    try {
      await sendStaffInviteEmail(c.env, {
        name, email,
        verifyUrl: invitationConfirmationUrl(c, token),
        roleLabel: inviteRoleLabel(member),
      });
    } catch (error) {
      // 後片付け自体が失敗しても握り潰さない。本人と範囲を一緒に消し、
      // 消せなくても同じメールの招待し直しで掃除できる（上の上書き）。
      try {
        await deleteStaffMemberWithScopes(c.env.DB, member.id);
      } catch (cleanupError) {
        logger.error("staff.create_failed");
      }
      throw error;
    }
    return c.json({ success: true, data: await serializeStaff(c.env.DB, member) }, 201);
  } catch (error) {
    throw error;
  }
});

staff.get('/api/staff/invitations/:token/verify', async (c) => {
  const token = c.req.param('token');
  return c.redirect(invitationConfirmationUrl(c, token), 302);
});

staff.post('/api/staff/invitations/confirm/verify', inputJsonBoundary({"token":["string"]}), async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({} as { token?: string }));
  const token = body.token?.trim() ?? '';
  if (!token || token.length > 512) {
    return inputError(c, { success: false, error: '招待情報が正しくありません' }, 400, ["token"]);
  }
  const member = await getStaffByInviteTokenHash(c.env.DB, await sha256Hex(token));
  if (!member || !member.email || !member.invite_expires_at || Date.parse(member.invite_expires_at) < Date.now()) {
    return c.json({ success: false, error: 'この招待は無効または期限切れです。管理者へ再発行を依頼してください。' }, 410);
  }
  if (member.invite_status === 'pending_email') {
    await updateStaffMember(c.env.DB, member.id, { invite_status: 'pending_line', email_verified_at: new Date().toISOString() });
    await sendStaffLineLinkEmail(c.env, {
      name: member.name, email: member.email,
      lineUrl: `${new URL(c.req.url).origin}/api/auth/line?invite=${encodeURIComponent(token)}`,
    });
  }
  return c.json({ success: true, data: { status: 'pending_line' } });
});

/*
 * 招待の再送。未受諾・期限切れの招待だけ owner/admin が送り直せる。
 * 同じ行を使い回す(新規行を作らず、作成日時などの履歴を残す)。旧トークンは
 * 上書きで失効し、新トークンの期限は7日。二重押し・同時再送は後勝ちで、
 * 生き残るのは最後に発行した1つだけ。旧リンクの受諾は410で再発行を案内する。
 * 自動再送はしない(要件 -30 §9-2)。管理者が対象を確かめて押す運用にする。
 */
staff.post('/api/staff/:id/resend-invitation', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  const id = c.req.param('id');
  const target = await getStaffById(c.env.DB, id);
  if (!target || !isInCurrentTenant(c, target)) return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
  if (!await canAccessStaffMember(c.env.DB, c.get('staff'), target)) return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
  if (target.invite_status === 'active') {
    return c.json({ success: false, error: 'このユーザーはすでに利用を開始しています。招待の再送はできません。' }, 409);
  }
  if (!target.email) {
    return inputError(c, { success: false, error: 'メールアドレスがないため招待を再送できません。' }, 400, []);
  }
  try {
    const token = randomToken();
    const updated = await updateStaffMember(c.env.DB, id, {
      invite_token_hash: await sha256Hex(token),
      invite_expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    });
    if (!updated) return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
    try {
      /*
       * どこで止まっているかで送る便りを変える。メール確認まで済んでいる人
       * (pending_line)へ確認メールを送り直しても、確認画面は pending_email
       * のときしか先へ進めないので、LINE連携の案内が誰にも届かないまま
       * 「送った」ことになる。止まっている一歩のほうを送り直す。
       */
      if (updated.invite_status === 'pending_line') {
        await sendStaffLineLinkEmail(c.env, {
          name: updated.name, email: updated.email ?? target.email,
          lineUrl: `${new URL(c.req.url).origin}/api/auth/line?invite=${encodeURIComponent(token)}`,
        });
      } else {
        await sendStaffInviteEmail(c.env, {
          name: updated.name, email: updated.email ?? target.email,
          verifyUrl: invitationConfirmationUrl(c, token),
          roleLabel: inviteRoleLabel(updated),
        });
      }
    } catch (error) {
      logger.error("staff.by_id_resend_invitation_create_failed");
      return c.json({ success: false, error: '招待メールを送信できませんでした。時間をおいて、もう一度送り直してください。' }, 500);
    }
    return c.json({ success: true, data: await serializeStaff(c.env.DB, updated) });
  } catch (error) {
    throw error;
  }
});

export type StaffPolicyInput = {
    name?: string; email?: string | null; role?: 'admin' | 'staff' | 'viewer'; isActive?: boolean;
    lineLinked?: boolean;
    permissionKeys?: string[]; notificationPreferences?: Record<string, { email: boolean; line: boolean }>;
    assignedLineAccountId?: string | null; canAccessDescendantAccounts?: boolean;
    accountScope?: 'all' | 'accounts'; scopedLineAccountIds?: string[]; managementContext?: 'hq';
    roleBundle?: string; permissionScope?: Record<string, string>;
    permissionViewKeys?: string[]; emailMask?: string;
    idempotencyKey?: string; expectedPolicyVersion?: number;
  };

/** 飲食店の所属変更も、この既存の再認証・版・最終管理者保護を通す。 */
export async function updateStaffPolicy(c: Context<Env>, id: string, body: StaffPolicyInput) {
  const idempotencyKey = parseIdempotencyKey(body.idempotencyKey);
  if (idempotencyKey === null) {
    return c.json({ success: false, error: '要求キーの形式が正しくありません' }, 400);
  }
  const expectedPolicyVersion = parseExpectedPolicyVersion(body.expectedPolicyVersion);
  if (expectedPolicyVersion === null) {
    return inputError(c, { success: false, error: '保存の版の形式が正しくありません' }, 400, ["expectedPolicyVersion"]);
  }
  const keyError = invalidPermissionKeys(body.permissionKeys)
    ?? invalidPermissionKeys(body.permissionViewKeys)
    ?? invalidNotificationPreferences(body.notificationPreferences);
  if (keyError) return inputError(c, { success: false, error: keyError }, 400, ["permissionKeys","permissionViewKeys","notificationPreferences"]);
  const bundle = body.roleBundle === undefined ? undefined : parseRoleBundle(body.roleBundle);
  if (body.roleBundle !== undefined && !bundle) {
    return inputError(c, { success: false, error: '役割バンドルが正しくありません' }, 400, ["roleBundle"]);
  }
  const scope = parseScope(body.permissionScope);
  if (scope === null) {
    return inputError(c, { success: false, error: '機能の権限範囲が正しくありません' }, 400, ["permissionScope"]);
  }
  const emailMask = parseEmailMask(body.emailMask);
  if (emailMask === null) {
    return inputError(c, { success: false, error: 'メールの見せ方が正しくありません' }, 400, ["emailMask"]);
  }
  const accountScope = normalizeAccountScopeInput(body);
  if ('error' in accountScope) return inputError(c, { success: false, error: accountScope.error }, 400, ["accountScope","scopedLineAccountIds"]);

  const target = await getStaffById(c.env.DB, id);
  if (!target || !isInCurrentTenant(c, target)) return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
  const current = c.get('staff');
  if (!await canAccessStaffMember(c.env.DB, current, target)) return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
  if (body.managementContext === 'hq' && !await hasAllAccountScope(c.env.DB, current)) {
    return c.json({ success: false, error: '全店舗の担当者だけが統括側の権限者を変更できます' }, 403);
  }
  const administrator = current.role === 'owner' || current.role === 'admin';
  if (!administrator && current.id !== id) {
    return c.json({ success: false, error: 'スタッフは自分の設定だけ変更できます' }, 403);
  }
  if (!administrator && (
    body.name !== undefined || body.role !== undefined || body.isActive !== undefined || body.permissionKeys !== undefined ||
    body.assignedLineAccountId !== undefined || body.canAccessDescendantAccounts !== undefined || body.accountScope !== undefined ||
    bundle !== undefined || scope !== undefined || body.permissionViewKeys !== undefined || emailMask !== undefined
  )) {
    return c.json({ success: false, error: '権限と利用状態は管理者だけが変更できます' }, 403);
  }
  if (body.email !== undefined && body.email !== null) {
    const email = body.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return inputError(c, { success: false, error: '正しいメールアドレスを入力してください' }, 400, ["email"]);
    }
    if (emailTooLong(email)) {
      return inputError(c, { success: false, error: 'メールアドレスは254文字以内で入力してください' }, 400, ["email"]);
    }
    const duplicate = (await getStaffMembers(c.env.DB, currentTenantId(c))).some((member) => member.id !== id && member.email?.toLowerCase() === email);
    if (duplicate) return c.json({ success: false, error: 'このメールアドレスは登録済みです' }, 409);
    body.email = email;
  }
  if (body.email === null && id === current.id) {
    // 自分のメールを空にすると連絡口と確認口の両方が消えるので、本人からの空書き込みは受けない。
    return inputError(c, { success: false, error: '自分のメールアドレスは空にできません' }, 400, ["email"]);
  }

  /*
   * 本人が自分のメールを変えるときは、その場では切り替えない。
   * 新しい宛先へ確認リンクを送り、開かれてはじめて確定する。旧アドレスへも
   * 知らせを送り、覚えのない変更に気づけるようにする（セッションを盗まれた
   * ときの静かな乗っ取りを防ぐ）。確認待ちの間、email 列は変えない。
   */
  const selfEmailChange = id === current.id
    && body.email !== undefined
    && body.email !== null
    && body.email !== (target.email?.toLowerCase() ?? null)
    ? { next: body.email, token: randomToken() }
    : null;
  if (selfEmailChange) body.email = undefined;

  // bundle指定のときも「管理者が0人になる」判定が効くよう実効roleへ写す。
  const effectiveRole = bundle !== undefined
    ? (bundle === 'administrator' ? 'admin' : bundle === 'view_only' ? 'viewer' : 'staff')
    : body.role;
  const guard = await guardLastAdmin(c.env.DB, target, currentTenantId(c), {
    isActive: body.isActive,
    role: effectiveRole,
    self: id === c.get('staff').id,
  });
  if (guard) return inputError(c, { success: false, error: guard }, 400, ["isActive","roleBundle","role"]);

  if (administrator && body.assignedLineAccountId !== undefined) {
    if (!body.assignedLineAccountId && !(body.managementContext === 'hq' && (accountScope.accountScope ?? target.account_scope) === 'all')) {
      return inputError(c, { success: false, error: '担当するLINEアカウントを選択してください' }, 400, ["assignedLineAccountId"]);
    }
    const visibleAccounts = (await getVisibleLineAccountScope(c.env.DB, current)).accounts;
    if (body.assignedLineAccountId && !visibleAccounts.some((account) => account.id === body.assignedLineAccountId)) {
      return c.json({ success: false, error: '権限のないLINEアカウントは割り当てできません' }, 403);
    }
  }
  if (
    body.canAccessDescendantAccounts &&
    current.role !== 'owner' &&
    current.assignedLineAccountId &&
    !current.canAccessDescendantAccounts
  ) {
    return c.json({ success: false, error: '自分が持っていない他アカウント権限は付与できません' }, 403);
  }
  if (administrator && accountScope.accountScope !== undefined && !await mayAssignAccountScopes(c.env.DB, current, accountScope.accountScope, accountScope.scopedLineAccountIds)) {
    return c.json({ success: false, error: '権限のないLINEアカウントは指定できません' }, 403);
  }

  /*
   * 同じ要求キーの送り直しは、受け付けた結果をそのまま返す。
   * 応答を見失った画面の再試行が、版を重ねたり保存後の新しいセッションを
   * 切ったりしないようにする。対象の権限確認（上）は済ませているが、
   * 新しい副作用は起こさないので直前再認証は求めない（初回で済ませている）。
   * 内容が違う送り直しは受け付けない。
   */
  const requestHashSource = JSON.stringify({
    name: body.name ?? null, email: body.email ?? null, role: body.role ?? null,
    isActive: body.isActive ?? null, lineLinked: body.lineLinked ?? null,
    permissionKeys: body.permissionKeys ?? null,
    notificationPreferences: body.notificationPreferences ?? null,
    assignedLineAccountId: body.assignedLineAccountId ?? null,
    canAccessDescendantAccounts: body.canAccessDescendantAccounts ?? null,
    accountScope: accountScope.accountScope ?? null,
    scopedLineAccountIds: accountScope.scopedLineAccountIds ?? null,
    roleBundle: body.roleBundle ?? null, permissionScope: body.permissionScope ?? null,
    permissionViewKeys: body.permissionViewKeys ?? null, emailMask: body.emailMask ?? null,
    expectedPolicyVersion: expectedPolicyVersion ?? null,
  });
  const requestHash = await sha256Hex(requestHashSource);
  if (idempotencyKey !== undefined) {
    const receipt = await getStaffPermissionReceipt(c.env.DB, id, idempotencyKey);
    if (receipt) {
      if (receipt.request_hash !== requestHash) {
        return inputError(c, { success: false, error: '同じ要求キーで内容が異なる保存は受け付けません' }, 422, ["idempotencyKey","name","email","role","isActive","lineLinked","permissionKeys","notificationPreferences","assignedLineAccountId","canAccessDescendantAccounts","accountScope","scopedLineAccountIds","roleBundle","permissionScope","permissionViewKeys","emailMask","expectedPolicyVersion"]);
      }
      return c.json(JSON.parse(receipt.result) as { success: boolean; data: unknown });
    }
  }

  // 権限・利用状態・連携・見せる範囲の変更は乗っ取り悪用されやすい高危険操作。
  // 判定は書き込みより前に行い、step-up無しならDBへ何も書かない。
  const authenticationPolicyChanged =
    body.role !== undefined ||
    body.isActive !== undefined ||
    body.lineLinked === false ||
    body.permissionKeys !== undefined ||
    body.assignedLineAccountId !== undefined ||
    body.canAccessDescendantAccounts !== undefined ||
    body.accountScope !== undefined ||
    bundle !== undefined || scope !== undefined ||
    body.permissionViewKeys !== undefined || emailMask !== undefined;
  if (authenticationPolicyChanged && !await consumeStaffStepUp(c, 'staff.permissions.change')) {
    return c.json({ success: false, error: '権限の変更には二段階認証による再認証が必要です', code: 'STEP_UP_REQUIRED' }, 428);
  }

  // 役割bundleは「初期値のプリセット」。保存されるのは role_bundle と
  // 展開済みの edit/view キーで、実際の認可は保存済みキーが決める。
  // bundle と項目・メールを同時に指定したときはプリセットから外れた=カスタムとして保存する。
  //
  // 表・窓に載っていない既存キー（`/automations` など）はどの入口からも
  // 落とさない。置き換えるのは各入口が管理する集合だけにし、外側は温存する。
  const previousEditKeys = safeJson<string[]>(target.permission_keys, []);
  const previousViewKeys = safeJson<string[]>(target.view_permission_keys, []);
  const keepOutside = (previous: string[], shown: ReadonlySet<string>): string[] =>
    previous.filter((key) => !shown.has(key));
  const mergeKeys = (computed: string[], kept: string[]): string[] =>
    [...new Set([...computed, ...kept])];
  let roleWrite: 'admin' | 'staff' | undefined =
    body.role === 'admin' ? 'admin' : body.role ? 'staff' : undefined;
  let levelWrite: 'read_only' | 'full' | undefined =
    body.role === undefined ? undefined : body.role === 'viewer' ? 'read_only' : 'full';
  let bundleWrite: string | null | undefined;
  let editKeysWrite: string[] | undefined = body.permissionKeys !== undefined
    ? mergeKeys(body.permissionKeys, keepOutside(previousEditKeys, INDIVIDUAL_EDIT_UI_KEYS))
    : undefined;
  let viewKeysWrite: string[] | undefined = body.permissionViewKeys;
  let maskWrite: EmailMaskLevel | null | undefined = emailMask;

  if (bundle != null && bundle !== 'custom') {
    const preset = BUNDLE_PRESETS[bundle];
    const presetKeys = scopeLevelsToKeys(preset.levels);
    const customized = scope !== undefined || body.permissionKeys !== undefined
      || body.permissionViewKeys !== undefined || emailMask !== undefined;
    roleWrite = bundle === 'administrator' ? 'admin' : 'staff';
    levelWrite = bundle === 'view_only' ? 'read_only' : 'full';
    bundleWrite = customized ? 'custom' : bundle;
    editKeysWrite = mergeKeys(
      scope !== undefined ? scopeLevelsToKeys(scope).edit : body.permissionKeys ?? presetKeys.edit,
      keepOutside(previousEditKeys, SCOPE_COVERED_KEYS),
    );
    viewKeysWrite = mergeKeys(
      scope !== undefined ? scopeLevelsToKeys(scope).view : body.permissionViewKeys ?? presetKeys.view,
      keepOutside(previousViewKeys, SCOPE_COVERED_KEYS),
    );
    maskWrite = emailMask ?? preset.emailMask;
  } else if (bundle === 'custom' || scope !== undefined
    || body.permissionViewKeys !== undefined || emailMask !== undefined) {
    bundleWrite = 'custom';
    if (bundle === 'custom') { roleWrite = 'staff'; levelWrite = 'full'; }
    if (scope !== undefined) {
      const keys = scopeLevelsToKeys(scope);
      editKeysWrite = mergeKeys(keys.edit, keepOutside(previousEditKeys, SCOPE_COVERED_KEYS));
      viewKeysWrite = mergeKeys(keys.view, keepOutside(previousViewKeys, SCOPE_COVERED_KEYS));
    }
  } else if (body.role !== undefined) {
    // 旧来の role 指定も bundle へ写す（画面・監査で同じ言葉を使うため）。
    bundleWrite = body.role === 'admin' ? 'administrator' : body.role === 'viewer' ? 'view_only' : 'custom';
    if (body.role === 'viewer' && viewKeysWrite === undefined) {
      viewKeysWrite = mergeKeys(
        scopeLevelsToKeys(BUNDLE_PRESETS.view_only.levels).view,
        keepOutside(previousViewKeys, SCOPE_COVERED_KEYS),
      );
    }
  }

  /*
   * この保存で対象が「操作できる管理者」から外れるか。外れるときは
   * 書き込みと同じ条件で「ほかに有効な管理者が残る」ことを求める。
   * 直前の guardLastAdmin は単独の最終管理者を止めるが、同時の互いの停止は
   * 両方が通過してしまうため、書き込み時の条件で0人を防ぐ。
   */
  const postIsActive = body.isActive ?? Boolean(target.is_active);
  const postRole = roleWrite ?? target.role;
  const postLevel = levelWrite ?? target.access_level;
  const removesAdminFromTarget = canAdminister(target)
    && !(postIsActive && postRole !== 'staff' && postLevel !== 'read_only');

  const updated = await updateStaffMember(c.env.DB, id, {
    name: body.name, email: body.email,
    role: roleWrite,
    access_level: levelWrite,
    role_bundle: bundleWrite,
    view_permission_keys: viewKeysWrite,
    email_mask: maskWrite,
    is_active: body.isActive === undefined ? undefined : body.isActive ? 1 : 0,
    // 連携を外すだけ。付け直しはLINEログイン側でしか起こらないので、
    // ここで受けるのは false（解除）のときだけにする。
    line_user_id: body.lineLinked === false ? null : undefined,
    line_linked_at: body.lineLinked === false ? null : undefined,
    permission_keys: editKeysWrite,
    notification_preferences: body.notificationPreferences,
    assigned_line_account_id: body.assignedLineAccountId,
    can_access_descendant_accounts:
      roleWrite === 'admin' || (roleWrite === undefined && target.role !== 'staff')
        ? body.canAccessDescendantAccounts
        : false,
    account_scope: accountScope.accountScope,
  }, ...((expectedPolicyVersion !== undefined || removesAdminFromTarget)
    ? [{
      ...(expectedPolicyVersion !== undefined ? { expectedPolicyVersion } : {}),
      ...(removesAdminFromTarget ? { requireRemainingAdmin: { tenantId: currentTenantId(c) } } : {}),
    }]
    : []));
  /*
   * 読んだ版と違うまま保存しようとしたら競合で止める。
   * 最新の制限を古い画面が上書きしない。行自体が無いときは404のまま。
   * 同時に互いを止めた2つ目は、ほかに管理者が残らないので競合で止める。
   */
  if (!updated && (expectedPolicyVersion !== undefined || removesAdminFromTarget)) {
    const latest = await getStaffById(c.env.DB, id);
    if (latest && isInCurrentTenant(c, latest)) {
      const versionChanged = expectedPolicyVersion !== undefined
        && Number(latest.policy_version ?? 1) !== expectedPolicyVersion;
      return c.json({
        success: false,
        error: versionChanged
          ? 'ほかの管理者が先に権限を変更しました。最新の内容を確認してから、もう一度保存してください。'
          : 'ほかの管理者の変更と重なり、管理者が一人もいなくなります。最新の内容を確認してから、もう一度保存してください。',
        code: 'STAFF_POLICY_CONFLICT',
        data: await serializeStaff(c.env.DB, latest, staffEmailVisibility(c, latest.id)),
      }, 409);
    }
    return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
  }
  if (updated && accountScope.accountScope !== undefined) {
    await replaceStaffAccountScopes(c.env.DB, id, accountScope.scopedLineAccountIds);
  }
  if (updated && authenticationPolicyChanged) {
    await revokeStaffAuthentication(c.env.DB, id);
  }
  // 受け付けた結果を要求キーに残す。送り直しはここへ来ず台帳から返す。
  const storeReceipt = async (payload: { success: boolean; data: unknown }) => {
    if (idempotencyKey === undefined || !updated) return;
    await saveStaffPermissionReceipt(c.env.DB, {
      idempotencyKey, staffId: id,
      requestHash, policyVersion: Number(updated.policy_version ?? 1),
      result: JSON.stringify(payload),
    });
  };
  if (updated && selfEmailChange) {
    await updateStaffMember(c.env.DB, id, {
      email_change_new: selfEmailChange.next,
      email_change_token_hash: await sha256Hex(selfEmailChange.token),
      email_change_expires_at: new Date(Date.now() + EMAIL_CHANGE_TTL_MS).toISOString(),
    });
    try {
      await sendStaffEmailChangeConfirmEmail(c.env, {
        name: updated.name,
        email: selfEmailChange.next,
        confirmUrl: emailChangeConfirmationUrl(c, selfEmailChange.token),
      });
      if (target.email) {
        await sendStaffEmailChangeNoticeEmail(c.env, {
          name: updated.name, email: target.email, next: selfEmailChange.next,
        });
      }
    } catch (error) {
      throw error;
    }
    const data = await serializeStaff(c.env.DB, updated, staffEmailVisibility(c, updated.id));
    const payload = { success: true as const, data: { ...data, emailChangePending: true, pendingEmail: selfEmailChange.next } };
    await storeReceipt(payload);
    return c.json(payload);
  }
  if (!updated) return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
  const payload = { success: true as const, data: await serializeStaff(c.env.DB, updated, staffEmailVisibility(c, updated.id)) };
  await storeReceipt(payload);
  return c.json(payload);
}

staff.patch('/api/staff/:id', inputJsonBoundary({"name":["string"],"email":["null","string"],"role":["string"],"isActive":["boolean"],"lineLinked":["boolean"],"permissionKeys":["array"],"notificationPreferences":["object"],"assignedLineAccountId":["null","string"],"canAccessDescendantAccounts":["boolean"],"accountScope":["string"],"scopedLineAccountIds":["array"],"managementContext":["string"],"roleBundle":["string"],"permissionScope":["object"],"permissionViewKeys":["array"],"emailMask":["string"],"idempotencyKey":["string"],"expectedPolicyVersion":["number"]}), async c => updateStaffPolicy(c, c.req.param('id'), await c.req.json<StaffPolicyInput>()));

/*
 * メール変更の確定。メール内リンクは fragment にトークンを乗せて
 * 管理画面の確認ページ(/staff/email-change)を直接開き、確定はその画面からの
 * POST だけが行う。GET だけでは確定しないので、メールの先読みで勝手に
 * 変わることはない。
 */
staff.post('/api/staff/email-change/confirm', inputJsonBoundary({"token":["string"]}), async (c) => {
  try {
    const body = await c.req.json<{ token?: string }>().catch(() => ({} as { token?: string }));
    const token = body.token?.trim() ?? '';
    if (!token || token.length > 512) {
      return inputError(c, { success: false, error: '確認情報が正しくありません' }, 400, ["token"]);
    }
    const member = await getStaffByEmailChangeTokenHash(c.env.DB, await sha256Hex(token));
    if (!member || !member.email_change_new || !member.email_change_expires_at || Date.parse(member.email_change_expires_at) < Date.now()) {
      return c.json({ success: false, error: 'この確認リンクは無効または期限切れです。管理画面からもう一度変更してください。' }, 410);
    }
    const nextEmail = member.email_change_new;
    // 申し込みのあとで別の人が同じメールを取ったかもしれないので、確定の直前にもう一度確かめる。
    const duplicate = (await getStaffMembers(c.env.DB, member.tenant_id ?? DEFAULT_TENANT_ID))
      .some((item) => item.id !== member.id && item.email?.toLowerCase() === nextEmail);
    if (duplicate) {
      await updateStaffMember(c.env.DB, member.id, {
        email_change_new: null, email_change_token_hash: null, email_change_expires_at: null,
      });
      return c.json({ success: false, error: 'このメールアドレスは登録済みです' }, 409);
    }
    const oldEmail = member.email;
    await updateStaffMember(c.env.DB, member.id, {
      email: nextEmail,
      email_verified_at: new Date().toISOString(),
      // 使い切り: 確定したら確認済みの申し込みは消し、同じリンクを二度使えなくする。
      email_change_new: null, email_change_token_hash: null, email_change_expires_at: null,
    });
    if (oldEmail && oldEmail.toLowerCase() !== nextEmail) {
      try {
        await sendStaffEmailChangeCompletedEmail(c.env, {
          name: member.name, email: oldEmail, next: nextEmail,
        });
      } catch (error) {
        // 確定そのものは済んでいる。知らせの失敗で確定を取り消すと二重の不整合になるので、記録だけ残す。
        logger.error("staff.email_change_confirm_create_failed");
      }
    }
    return c.json({ success: true, data: { email: nextEmail } });
  } catch (error) {
    throw error;
  }
});

function canEditMember(c: { get: (key: 'staff') => Env['Variables']['staff'] }, id: string): boolean {
  const current = c.get('staff');
  return current.role === 'owner' || current.role === 'admin' || current.id === id;
}

function totpMasterKey(c: { env: Env['Bindings'] }): string | null {
  return mfaEncryptionConfigured(c.env.TOTP_ENCRYPTION_KEY) ? c.env.TOTP_ENCRYPTION_KEY! : null;
}

staff.post('/api/staff/:id/two-factor/setup', inputJsonBoundary(), async (c) => {
  const id = c.req.param('id');
  const member = await getStaffById(c.env.DB, id);
  if (!member || !isInCurrentTenant(c, member)) return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
  if (c.get('staff').id !== id) return c.json({ success: false, error: '自分の二段階認証だけ設定できます' }, 403);
  const key = totpMasterKey(c);
  if (!key) return c.json({ success: false, error: '二段階認証の暗号鍵が設定されていません' }, 503);

  if (c.get('impersonation') || c.get('staff').readOnly) return c.json({ success: false, error: '本人だけが登録し直せます' }, 403);
  if (member.totp_enabled_at && !await consumeStepUpToken(c, 'auth.mfa.reenroll')) {
    return c.json({ success: false, error: '登録し直す前に本人確認してください', code: 'STEP_UP_REQUIRED' }, 428);
  }
  const secret = generateTotpSecret();
  const pending = await encryptTotpSecret(secret, key);
  if (member.totp_enabled_at) {
    const sessionHash = await adminSessionTokenHashFromRequest(c);
    const grantHash = await sha256Hex(c.req.header('X-Step-Up-Token')!.trim());
    const grant = await c.env.DB.prepare('SELECT expires_at FROM auth_step_up_grants WHERE token_hash=? AND staff_id=? AND purpose=? AND consumed_at IS NOT NULL')
      .bind(grantHash, id, 'auth.mfa.reenroll').first<{ expires_at: string }>();
    if (!sessionHash || !grant) return c.json({ success: false, error: '同じログインで本人確認からやり直してください' }, 401);
    const proof = JSON.stringify({ sessionHash, grantHash, pendingHash: await sha256Hex(pending), expiresAt: grant.expires_at });
    const saved = await c.env.DB.batch([
      c.env.DB.prepare('UPDATE staff_members SET totp_pending_secret_enc=? WHERE id=? AND is_active=1 AND totp_secret_enc=? AND totp_pending_secret_enc IS ?')
        .bind(pending, id, member.totp_secret_enc, member.totp_pending_secret_enc),
      c.env.DB.prepare(`INSERT INTO platform_settings(key,value,updated_by,updated_at) SELECT ?,?,?,? WHERE changes()=1
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
        .bind(`auth.mfa.reenroll:${id}`, proof, id, new Date().toISOString()),
    ]);
    if (saved[0].meta.changes !== 1) return c.json({ success: false, error: '設定が変わりました。読み直してください' }, 409);
  } else {
    await updateStaffMember(c.env.DB, id, { totp_pending_secret_enc: pending });
  }
  return c.json({
    success: true,
    data: {
      provisioningUri: buildTotpUri(secret, member.email || member.name),
      manualKey: secret.match(/.{1,4}/g)?.join(' ') ?? secret,
    },
  });
});

staff.post('/api/staff/:id/two-factor/confirm', inputJsonBoundary({"code":["string"]}), async (c) => {
  const id = c.req.param('id');
  const member = await getStaffById(c.env.DB, id);
  if (!member || !isInCurrentTenant(c, member)) return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
  if (c.get('staff').id !== id) return c.json({ success: false, error: '自分の二段階認証だけ設定できます' }, 403);
  const key = totpMasterKey(c);
  if (!key) return c.json({ success: false, error: '二段階認証の暗号鍵が設定されていません' }, 503);
  if (!member?.totp_pending_secret_enc) return inputError(c, { success: false, error: '先にQRコードを表示してください' }, 400, []);
  if (c.get('impersonation') || c.get('staff').readOnly) return c.json({ success: false, error: '本人だけが設定できます' }, 403);
  const proofKey = `auth.mfa.reenroll:${id}`;
  const proofValue = member.totp_enabled_at ? await getPlatformSetting(c.env.DB, proofKey) : null;
  let proof: { sessionHash: string; grantHash: string; pendingHash: string; expiresAt: string } | null = null;
  if (member.totp_enabled_at) {
    try { proof = proofValue ? JSON.parse(proofValue) : null; } catch { /* malformed proof fails closed */ }
    if (!proof || proof.sessionHash !== await adminSessionTokenHashFromRequest(c)
      || proof.pendingHash !== await sha256Hex(member.totp_pending_secret_enc)
      || !(Date.parse(proof.expiresAt) > Date.now())) {
      return c.json({ success: false, error: '本人確認の時間が切れたかログインが変わりました。登録し直す操作からやり直してください' }, 401);
    }
  }
  const body = await c.req.json<{ code?: string }>().catch(() => ({} as { code?: string }));
  const attempt = await reserveTwoFactorSetupAttempt(c.env.DB, id);
  if (!attempt) return c.json({ success: false, error: TWO_FACTOR_ATTEMPT_LIMIT_ERROR }, 429);
  const encrypted = member.totp_pending_secret_enc;
  const result = await verifyTotp(await decryptTotpSecret(encrypted, key), body.code ?? '');
  if (!result.valid) {
    return inputError(c, { success: false, error: attempt.attempts >= attempt.maxAttempts ? TWO_FACTOR_ATTEMPT_LIMIT_ERROR : '認証コードが正しくありません' }, attempt.attempts >= attempt.maxAttempts ? 429 : 400, []);
  }
  const encryptedSecret = await encryptTotpSecret(await decryptTotpSecret(encrypted, key), key);
  const promotion = c.env.DB.prepare(`UPDATE staff_members SET totp_secret_enc=?,totp_pending_secret_enc=NULL,
    totp_enabled_at=?,totp_last_used_step=? WHERE id=? AND is_active=1 AND totp_secret_enc IS ? AND totp_pending_secret_enc=?
    ${proof ? `AND EXISTS(SELECT 1 FROM platform_settings WHERE key=? AND value=?)
      AND EXISTS(SELECT 1 FROM auth_step_up_grants g WHERE g.token_hash=? AND g.staff_id=staff_members.id
        AND g.purpose='auth.mfa.reenroll' AND g.consumed_at IS NOT NULL AND g.session_token_hash=?
        AND julianday(g.expires_at)>julianday('now') AND (g.issued_policy_version IS NULL OR g.issued_policy_version=staff_members.policy_version))` : ''}`)
    .bind(encryptedSecret, new Date().toISOString(), result.step, id, member.totp_secret_enc, encrypted,
      ...(proof ? [proofKey, proofValue, proof.grantHash, proof.sessionHash] : []));
  const promoted = proof ? (await c.env.DB.batch([
    promotion,
    auditEventStatement(c.env.DB, { category: 'auth', action: 'auth.mfa.reenroll', actorPrincipalId: id, actorRole: member.role,
      tenantId: member.tenant_id, targetKind: 'staff', targetId: id, riskLevel: 'high', retentionClass: 'security' }, { sql: 'changes()=1', params: [] }),
    c.env.DB.prepare('DELETE FROM platform_settings WHERE key=? AND value=? AND changes()=1').bind(proofKey, proofValue),
  ]))[0] : await promotion.run();
  if (promoted.meta.changes !== 1) return c.json({ success: false, error: '二段階認証はすでに設定されています' }, 409);
  const updated = await getStaffById(c.env.DB, id);
  if (updated) {
    await clearTwoFactorSetupAttempts(c.env.DB, id);
    // 運営メンバーの招待（★37-10）: 2要素認証の登録が終わった時点で登録完了にする
    await activatePlatformAdminIfAwaitingTotp(c.env.DB, id);
    await revokeStaffAuthentication(c.env.DB, id);
  }
  return c.json({ success: true, data: { ...await serializeStaff(c.env.DB, updated!, staffEmailVisibility(c, updated!.id)) } });
});

staff.delete('/api/staff/:id/two-factor', async (c) => {
  const id = c.req.param('id');
  const member = await getStaffById(c.env.DB, id);
  if (!member || !isInCurrentTenant(c, member)) return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
  if (!await canAccessStaffMember(c.env.DB, c.get('staff'), member)) return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
  if (!canEditMember(c, id)) return c.json({ success: false, error: '自分の二段階認証だけ解除できます' }, 403);
  // 二段階認証の解除は本人・他人どちらでも高危険。解除後は対象の全セッションも切る。
  if (!await consumeStaffStepUp(c, 'staff.two_factor.remove')) {
    return c.json({ success: false, error: '二段階認証の解除には再認証が必要です', code: 'STEP_UP_REQUIRED' }, 428);
  }
  const updated = await updateStaffMember(c.env.DB, id, {
    totp_secret_enc: null,
    totp_pending_secret_enc: null,
    totp_enabled_at: null,
    totp_last_used_step: null,
  });
  if (updated) await revokeStaffAuthentication(c.env.DB, id);
  return updated ? c.json({ success: true, data: await serializeStaff(c.env.DB, updated, staffEmailVisibility(c, updated.id)) }) : fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
});

staff.delete('/api/staff/:id', requireRole('owner', 'admin'), async (c) => {
  const id = c.req.param('id');
  if (id === c.get('staff').id) return c.json({ success: false, error: '自分自身は利用停止できません' }, 400);
  const target = await getStaffById(c.env.DB, id);
  if (!target || !isInCurrentTenant(c, target)) return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
  if (!await canAccessStaffMember(c.env.DB, c.get('staff'), target)) return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
  const guard = await guardLastAdmin(c.env.DB, target, currentTenantId(c), { isActive: false, self: false });
  if (guard) return c.json({ success: false, error: guard }, 400);
  // 利用停止は権限変更と同じ高危険操作として再認証を要求する。
  if (!await consumeStaffStepUp(c, 'staff.permissions.change')) {
    return c.json({ success: false, error: 'スタッフの利用停止には二段階認証による再認証が必要です', code: 'STEP_UP_REQUIRED' }, 428);
  }
  // 削除も「ほかに有効な管理者が残る」を同じ書き込みの条件にする。
  const removesAdmin = canAdminister(target);
  const updated = await updateStaffMember(c.env.DB, id, { is_active: 0 },
    ...(removesAdmin ? [{ requireRemainingAdmin: { tenantId: currentTenantId(c) } }] : []));
  if (!updated && removesAdmin) {
    const latest = await getStaffById(c.env.DB, id);
    if (latest && isInCurrentTenant(c, latest)) {
      return c.json({
        success: false,
        error: 'ほかの管理者の変更と重なり、管理者が一人もいなくなります。最新の内容を確認してから、もう一度保存してください。',
        code: 'STAFF_POLICY_CONFLICT',
      }, 409);
    }
    return fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
  }
  if (updated) await revokeStaffAuthentication(c.env.DB, id);
  return updated
    ? c.json({ success: true, data: await serializeStaff(c.env.DB, updated, staffEmailVisibility(c, updated.id)) })
    : fail(c, 404, 'STAFF_MEMBER_NOT_FOUND');
});

export { staff };
