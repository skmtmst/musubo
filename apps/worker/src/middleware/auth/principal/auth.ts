import { effectiveStaffEditKeys, hqRoleForStaff } from '@line-crm/shared';

export type TenantStatus = 'active' | 'suspended' | 'archived';
export const TENANT_SUSPENDED_CODE = 'TENANT_SUSPENDED';
export const TENANT_SUSPENDED_ERROR = '現在ご利用いただけません。お問い合わせは「お問い合わせ」画面からお送りください';

export type StaffRole = 'owner' | 'admin' | 'staff';

/**
 * 更新可否は readOnly、閲覧可否は role で判定する。
 * 読み取り専用でも役割を保持し、オーナーとスタッフで異なる機密情報の閲覧範囲をサーバー側で制御する。
 */
export type AuthenticatedStaff = {
  id: string;
  name: string;
  role: StaffRole;
  /** true なら役割にかかわらず更新・削除・設定変更をさせない。 */
  readOnly: boolean;
  hqRole?: 'operator' | 'viewer' | null;
  permissionKeys?: string[];
  /** 「見えるだけ」の key。GET系だけを許可し、変更系は edit の key が要る。 */
  viewPermissionKeys?: string[];
  /** スタッフのメール表示。未設定は従来判定（access.user.email.view）。 */
  emailMask?: 'full' | 'masked' | 'none' | null;
  assignedLineAccountId?: string | null;
  canAccessDescendantAccounts?: boolean;
  /** 所属する統括。認可への実適用は後続工程で行う。 */
  tenantId?: string | null;
  /** 所属統括の実効状態。既定の運営会社と env-owner は active。 */
  tenantStatus?: TenantStatus;
  /** 機能オフ middleware が一覧処理へ渡す、このリクエストだけの追加絞り込み。 */
  featureEnabledLineAccountIds?: string[];
  /**
   * どの資格情報で入ったか。'session' は管理画面から人がログインした状態、
   * 'api-key' は長期間使える鍵（env の API_KEY / LEGACY_API_KEY、スタッフ個別の
   * APIキー）をプログラムから提示した状態。
   *
   * Googleビジネスのルートはこれを見て 'api-key' を拒む。Google Business Profile
   * APIのポリシー（https://developers.google.com/my-business/content/policies、
   * 2026-08-28更新）が「End users of your Business Profile APIs need to manually
   * sign in to use it.」「You cannot provide indirect access to your Business
   * Profile project.」と定めているため、鍵1本で外部スクリプトからGoogleへ
   * 書ける経路を残せない。
   */
  credential?: 'session' | 'api-key';
};

type StaffAuthenticationRecord = {
  id: string;
  name: string;
  role: StaffRole;
  access_level?: 'full' | 'read_only';
  role_bundle?: string | null;
  account_scope?: 'all' | 'accounts';
  permission_keys?: string;
  view_permission_keys?: string | null;
  email_mask?: string | null;
  assigned_line_account_id?: string | null;
  can_access_descendant_accounts?: number;
  tenant_id?: string | null;
  tenant_status?: TenantStatus;
};

/** 保存された権限 JSON も信頼せず、文字列キーの配列だけで許可する。 */
function permissionKeysFromJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

export function toAuthenticatedStaff(staff: StaffAuthenticationRecord): AuthenticatedStaff {
  const permissionKeys = effectiveStaffEditKeys(permissionKeysFromJson(staff.permission_keys));
  const viewPermissionKeys = permissionKeysFromJson(staff.view_permission_keys);
  const emailMask = staff.email_mask === 'full' || staff.email_mask === 'masked' || staff.email_mask === 'none'
    ? staff.email_mask
    : null;
  const hqRole = hqRoleForStaff(staff);
  return {
    id: staff.id,
    name: staff.name,
    role: staff.role,
    readOnly: staff.access_level === 'read_only',
    hqRole,
    permissionKeys,
    viewPermissionKeys,
    emailMask,
    assignedLineAccountId: staff.assigned_line_account_id ?? null,
    canAccessDescendantAccounts: Boolean(staff.can_access_descendant_accounts),
    tenantId: staff.tenant_id ?? null,
    tenantStatus: staff.tenant_status ?? 'active',
  };
}

export function isTenantUnavailable(status: TenantStatus | null | undefined): boolean {
  return status === 'suspended' || status === 'archived';
}

/** 停止中でも契約先が自分で確認・問い合わせできる最小経路。 */
export function isTenantSuspensionExemptPath(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  const supportPath = path === '/api/hq/support' || path.startsWith('/api/hq/support/');
  const noticePath = path === '/api/hq/notices' || path.startsWith('/api/hq/notices/');
  return (upper === 'GET' && path === '/api/auth/session')
    || (upper === 'POST' && path === '/api/auth/logout')
    || supportPath
    || (upper === 'GET' && noticePath)
    || (upper === 'POST' && /^\/api\/hq\/notices\/[^/]+\/read$/.test(path))
    // 運営会社の統括と運営マスターは契約先停止の対象外。実際の許可は
    // 各 route の requirePlatformAdmin が引き続き担う。
    || path.startsWith('/api/ops/');
}
