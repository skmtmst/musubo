// -----------------------------------------------------------------------------
// 管理ユーザー (AdminUser)
// -----------------------------------------------------------------------------

/**
 * 管理ユーザー (内部用 — パスワードハッシュを含む)
 * ※ API レスポンスとして直接返してはならない。フロントへは AdminUserPublic を使う。
 */
export interface AdminUser {
  /** 主キー (UUIDv4) */
  id: string;
  /** メールアドレス */
  email: string;
  /** パスワードハッシュ (bcrypt) — フロントエンドに絶対に返さないこと */
  passwordHash: string;
  /** 作成日時 (ISO 8601) */
  createdAt: string;
}

/**
 * 管理ユーザー (公開用 — パスワードハッシュを除いたもの)
 * API レスポンスやセッション情報にはこちらを使う。
 */
export type AdminUserPublic = Omit<AdminUser, "passwordHash">;

// -----------------------------------------------------------------------------
// スタッフ (StaffMember)
// -----------------------------------------------------------------------------
export interface StaffMember {
  id: string;
  /** 本人APIが返す実効的な閲覧専用状態（代理ログインも含む）。 */
  readOnly?: boolean;
  /** 認証済み本人APIが返すテナント識別子。古いAPI応答との互換のため任意。 */
  tenantId?: string;
  name: string;
  email: string | null;
  role: 'owner' | 'admin' | 'staff' | 'viewer';
  lineLinked: boolean;
  twoFactorEnabled: boolean;
  isActive: boolean;
  permissionKeys: string[];
  notificationPreferences: Record<string, { email: boolean; line: boolean }>;
  inviteStatus: 'pending_email' | 'pending_line' | 'active' | 'expired';
  createdAt: string;
  updatedAt: string;
  /** このログインユーザーの基準となるLINE公式アカウント。nullは従来互換の全体権限。 */
  assignedLineAccountId: string | null;
  /** 基準アカウントより下の子・孫も表示・操作できるか。 */
  canAccessDescendantAccounts: boolean;
  /** 担当範囲。accounts の場合は scopedLineAccountIds に対象店舗が入る。 */
  accountScope?: 'all' | 'accounts';
  /** This member created the currently selected LINE account. */
  isAccountCreator?: boolean;
  /** Whether this actor may change the member in the selected account. */
  canManageInAccount?: boolean;
  scopedLineAccountIds?: string[];
  /** 役割bundle。role は初期値、こちらが監査・画面の共通語彙。 */
  roleBundle?: 'administrator' | 'operations' | 'reception' | 'view_only' | 'custom';
  /** 統括画面で選んだ3役割。店舗スタッフの個別権限とは分ける。 */
  hqRole?: 'operator' | 'viewer' | null;
  /** 「見えるだけ」のキー（GET系のみ許可）。 */
  permissionViewKeys?: string[];
  /** 機能ごとの3択（none/view/edit）。編集画面の復元用。 */
  permissionScope?: Record<string, 'edit' | 'view' | 'none'>;
  /** この人が他者のメールをどう見るか（full=実値/masked=伏せ字/none=出さない）。 */
  emailMask?: 'full' | 'masked' | 'none' | null;
  /** 保存の競合検出に使う版。開いたときの値を送り、他者が先に変えていたら409で止まる。 */
  policyVersion?: number;
}

export interface StaffProfile {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'staff' | 'viewer';
  email: string | null;
}
