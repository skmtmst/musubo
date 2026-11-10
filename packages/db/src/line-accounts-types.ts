


export interface LineAccount {
  folder_id?: string | null;
  id: string;
  created_by_staff_id?: string | null;
  channel_id: string;
  name: string;
  channel_access_token: string;
  channel_secret: string;
  channel_access_token_encrypted?: string | null;
  channel_secret_encrypted?: string | null;
  channel_access_token_updated_at: string | null;
  channel_secret_updated_at: string | null;
  login_channel_secret_updated_at: string | null;
  /** API直列化専用。秘密値そのものは返さない。 */
  channel_access_token_last4?: string | null;
  channel_secret_last4?: string | null;
  login_channel_secret_last4?: string | null;
  login_channel_id: string | null;
  login_channel_secret: string | null;
  liff_id: string | null;
  is_active: number;
  is_default: number;
  archived_at: string | null;
  archived_by: string | null;
  archived_reason: string | null;
  /** 止めた理由（manual | ban_detected | credential_invalid）。動いていれば null。 */
  inactive_reason?: string | null;
  inactive_reason_detail?: string | null;
  inactivated_at?: string | null;
  login_channel_secret_encrypted?: string | null;
  last_webhook_received_at?: string | null;
  /** Webhook 届かない警告を出さないアカウント（受信しない運用なら 1）。 */
  webhook_silence_exempt?: number;
  country: string | null;
  role: string | null;
  display_order: number;
  token_expires_at: string | null;
  og_site_name: string | null;
  og_default_image_url: string | null;
  og_default_description: string | null;
  /** LINE公式プロフィールで発行した lin.ee の短縮URL。未設定なら null。 */
  official_profile_url: string | null;
  /** 友だち数の上限。NULL なら上限を管理しない */
  friend_capacity: number | null;
  /** 何人で警告を出すか。NULL なら警告しない */
  capacity_warn_at: number | null;
  /** 管理画面の一覧やヘッダーで使うアイコン。OGP用の og_default_image_url とは用途が違う */
  icon_url: string | null;
  /** LINE公式アカウントに設定された公開表示名。 */
  line_display_name: string | null;
  /** LINE公式アカウントに設定された公開画像URL。 */
  line_picture_url: string | null;
  /** LINE公式アカウントのベーシックID（@から始まるID）。 */
  line_basic_id: string | null;
  /** LINE公式プロフィールを最後に同期できた日時。 */
  line_profile_synced_at: string | null;
  /** LINE公式アカウント構成の上位アカウント。NULLなら未設定（ルート）。 */
  parent_line_account_id: string | null;
  /** 所属する統括。指示Cで認可境界として有効化するまでは表示範囲を変えない。 */
  tenant_id: string | null;
  /** の日時指定と日別分析で使うIANAタイムゾーン。 */
  timezone?: string;
  /** 楽観ロックに使う版番号。変更の保存ごとに1増える。 */
  revision?: number;
  created_at: string;
  updated_at: string;
}

export type TenantRuntimeStatus = 'active' | 'suspended' | 'archived';

/**
 * Runtime-facing account shape. The existing LineAccount APIs intentionally
 * remain unchanged because management screens must still inspect stopped tenants.
 */
export interface LineAccountWithTenantStatus extends LineAccount {
  tenant_status: TenantRuntimeStatus;
}

/** Non-secret fields required to resolve admin account visibility. */
export type LineAccountScopeEntry = Pick<
  LineAccount,
  | 'id'
  | 'tenant_id'
  | 'parent_line_account_id'
  | 'is_active'
  | 'archived_at'
  | 'login_channel_id'
  | 'liff_id'
>;

export type LineCredentialField =
  | 'channel_access_token'
  | 'channel_secret'
  | 'login_channel_secret';

export type LineCredentialFailureReason =
  | 'key_unavailable_or_invalid'
  | 'decrypt_failed';

export interface LineCredentialContext {
  lineAccountId: string;
  field: LineCredentialField;
}

export interface LineCredentialHealth {
  encrypted: boolean;
  decryptable: boolean;
  source: 'encrypted' | 'plaintext';
}

export interface LineAccountCredentialHealth {
  channel_access_token: LineCredentialHealth;
  channel_secret: LineCredentialHealth;
}

export interface CreateLineAccountInput {
  /** Paid musubo additions remain invisible to runtime until recurring prices reconcile. */
  initialActive?: boolean;
  createdByStaffId?: string | null;
  channelId: string;
  name: string;
  channelAccessToken: string;
  channelSecret: string;
  loginChannelId?: string | null;
  loginChannelSecret?: string | null;
  liffId?: string | null;
  ogSiteName?: string | null;
  ogDefaultImageUrl?: string | null;
  ogDefaultDescription?: string | null;
  officialProfileUrl?: string | null;
  timezone?: string;
  country?: string | null;
  role?: string | null;
  parentLineAccountId?: string | null;
  tenantId?: string | null;
  lineDisplayName?: string | null;
  linePictureUrl?: string | null;
  lineBasicId?: string | null;
  lineProfileSyncedAt?: string | null;
}

export type LineAccountConnectionCheckKind =
  | 'bot_info'
  | 'webhook_endpoint'
  | 'webhook_test'
  | 'liff_config'
  | 'token_refresh';

export type LineAccountConnectionCheckResult =
  | 'matched'
  | 'mismatched'
  | 'unconfigured'
  | 'unknown'
  | 'ok'
  | 'failed';

export interface LineAccountConnectionCheck {
  id: string;
  line_account_id: string;
  check_kind: LineAccountConnectionCheckKind;
  result: LineAccountConnectionCheckResult;
  expected_url: string | null;
  registered_url: string | null;
  webhook_active: number | null;
  http_status: number | null;
  checked_by: string;
  checked_at: string;
  correlation_id: string;
  idempotency_key: string;
  account_revision: number;
}

export interface SaveLineAccountConnectionChecksInput {
  lineAccountId: string;
  expectedRevision: number;
  checkedBy: string;
  checkedAt: string;
  correlationId: string;
  idempotencyKey: string;
  checks: Array<{
    kind: LineAccountConnectionCheckKind;
    result: LineAccountConnectionCheckResult;
    expectedUrl?: string | null;
    registeredUrl?: string | null;
    webhookActive?: boolean | null;
    httpStatus?: number | null;
  }>;
}

export interface LineAccountListStats {
  friendCount: number;
  activeScenarios: number;
  messagesThisMonth: number;
  staffCount: number;
  connection: {
    status: 'ok' | 'warn' | 'unknown';
    checkedAt: string | null;
    isActive?: boolean;
    archivedAt?: string | null;
    /** 期限切れのトークンを持っている（自動の更新が止まっている）。 */
    tokenExpired: boolean;
    /** 最新の確認のうち、引っかかったもの（要確認の理由）。 */
    issues: LineAccountConnectionIssue[];
  };
}

/** 一覧に載せる、引っかかった確認1件。秘密値は含まない。 */
export type LineAccountConnectionIssue = import('@line-crm/shared').LineConnectionIssue;

export type UpdateLineAccountInput = Partial<
  Pick<
    LineAccount,
    | 'name'
    | 'channel_access_token'
    | 'channel_secret'
    | 'login_channel_id'
    | 'login_channel_secret'
    | 'liff_id'
    | 'is_active'
    | 'token_expires_at'
    | 'og_site_name'
    | 'og_default_image_url'
    | 'og_default_description'
    | 'official_profile_url'
    | 'friend_capacity'
    | 'capacity_warn_at'
    | 'icon_url'
    | 'parent_line_account_id'
  >
>;

export type LineAccountArchiveBlocker =
  | 'account_active'
  | 'default_account'
  | 'delivery_job_running'
  | 'traffic_pool_member';

export type LineAccountLifecycleErrorCode =
  | 'ACCOUNT_ARCHIVED'
  | 'ACCOUNT_ACTIVE'
  | 'ACCOUNT_DEFAULT'
  | 'ACCOUNT_HAS_ACTIVE_DELIVERY'
  | 'ACCOUNT_IN_TRAFFIC_POOL'
  | 'ACCOUNT_INACTIVE'
  | 'ACCOUNT_NOT_ARCHIVED';

export type LineAccountInactiveReason = 'manual' | 'ban_detected' | 'credential_invalid';

export interface SkippedDelivery {
  id: string;
  line_account_id: string;
  kind: string;
  ref_id: string;
  title: string | null;
  reason: string;
  skipped_at: string;
}

export interface PoolSwitchEvent {
  id: string;
  pool_id: string;
  line_account_id: string;
  direction: 'out' | 'in';
  reason: string;
  actor: string;
  created_at: string;
}

export interface UpdateLineAccountFieldsInput {
  timezone?: string;
  country?: string | null;
  role?: string | null;
  isActive?: boolean;
  loginChannelId?: string | null;
  loginChannelSecret?: string | null;
  liffId?: string | null;
  ogSiteName?: string | null;
  ogDefaultImageUrl?: string | null;
  ogDefaultDescription?: string | null;
  /** LINE公式プロフィールで発行した lin.ee の短縮URL。null で未設定に戻す。 */
  officialProfileUrl?: string | null;
  /** 友だち数の上限。null で「上限を管理しない」に戻す */
  friendCapacity?: number | null;
  /** 何人で警告を出すか。null で「警告しない」に戻す */
  capacityWarnAt?: number | null;
  /** 管理画面で使うアイコン。null で未設定に戻す */
  iconUrl?: string | null;
  /** LINE公式プロフィールの公開情報。 */
  lineDisplayName?: string | null;
  linePictureUrl?: string | null;
  lineBasicId?: string | null;
  lineProfileSyncedAt?: string | null;
}
