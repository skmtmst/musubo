/**
 * ログインユーザーの権限モデル正本（docs/v6-requirements/v6-30-login-users-requirements-draft.md §6-7）。
 *
 * 画面の「項目ごとに決める」3択（変えられる=edit / 見えるだけ=view /
 * 出さない=none）と、役割bundleの初期値をここに置く。
 * worker の認可 middleware と web の編集画面が同じ表を見る。
 */

/** 機能ごとの3段階。none はキーを持たないことで表す。 */
export type FeatureAccessLevel = 'edit' | 'view' | 'none';

/** 個人情報（スタッフのメールアドレス）の見せ方。 */
export type EmailMaskLevel = 'full' | 'masked' | 'none';

/** 全アカウントの統括メンバーだけを店舗スタッフの個別設定と区別する。 */
export function hqRoleForStaff(row: {
  role: string;
  role_bundle?: string | null;
  access_level?: string | null;
  assigned_line_account_id?: string | null;
  account_scope?: string | null;
}): 'operator' | 'viewer' | null {
  if (row.role !== 'staff' || row.assigned_line_account_id != null || row.account_scope !== 'all') return null;
  if (row.access_level === 'read_only' && row.role_bundle === 'hq_viewer') return 'viewer';
  if (row.access_level !== 'read_only' && row.role_bundle === 'hq_operator') return 'operator';
  return null;
}

export type AccessRoleBundleId =
  | 'administrator'
  | 'operations'
  | 'reception'
  | 'view_only'
  | 'custom';

/** bundle id の一覧（入力検証・API応答で使う）。 */
export const ACCESS_ROLE_BUNDLE_IDS: readonly AccessRoleBundleId[] = [
  'administrator',
  'operations',
  'reception',
  'view_only',
  'custom',
];

/** スタッフ一覧のメールをマスクせず見られる granular 権限（既存）。 */
export const ACCESS_USER_EMAIL_VIEW_KEY = 'access.user.email.view';

/** ログインユーザー管理の閲覧・監査閲覧の granular 権限（既存）。 */
export const ACCESS_USER_VIEW_KEY = 'access.user.view';
export const ACCESS_AUDIT_VIEW_KEY = 'access.audit.view';

/**
 * 一斉配信の操作キー（-06 §6 が正本）。
 * 下書き作成・編集／テスト送信／予約・即時送信／緊急停止／失敗再送／CSV。
 */
export const BROADCAST_DEFINITION_EDIT_KEY = 'broadcast.definition.edit';
export const BROADCAST_TEST_SEND_KEY = 'broadcast.test.send';
export const BROADCAST_DEFINITION_PUBLISH_KEY = 'broadcast.definition.publish';
export const BROADCAST_JOB_STOP_KEY = 'broadcast.job.stop';
export const BROADCAST_JOB_RETRY_KEY = 'broadcast.job.retry';
export const BROADCAST_RESULT_EXPORT_KEY = 'broadcast.result.export';
/**
 * 一斉配信の承認キー（-06 §6 の二者承認）。
 * 1,000通以上の送信を、送る人とは別の人が確かめるための鍵。
 * owner・admin は常に通る（role-guard の hasStaffPermission）。
 * 止める・送り直すと同じく束には入れず、管理者が個別に付ける。
 */
export const BROADCAST_APPROVE_KEY = 'broadcast.approve';

/**
 * 配信 edit と組で付ける操作キー。緊急停止・失敗再送は指定者のみ
 * （束には入れず、管理者が個別に付ける）。
 */
export const BROADCAST_EDIT_OPERATION_KEYS: readonly string[] = [
  BROADCAST_DEFINITION_EDIT_KEY,
  BROADCAST_TEST_SEND_KEY,
  BROADCAST_DEFINITION_PUBLISH_KEY,
  BROADCAST_RESULT_EXPORT_KEY,
];

/** 束の鍵・APIの入口・画面の操作判定が読む共通の表。 */
export const DELIVERY_FEATURE_POLICIES = {
  broadcasts: { key: '/broadcasts', api: ['/api/broadcasts', '/api/broadcast-message-assets/upload-sessions'], edit: BROADCAST_DEFINITION_EDIT_KEY, test: BROADCAST_TEST_SEND_KEY, export: BROADCAST_RESULT_EXPORT_KEY, bundled: BROADCAST_EDIT_OPERATION_KEYS },
  scenarios: { key: '/scenarios', api: ['/api/scenarios', '/api/scenario-drafts'], edit: 'scenario.definition.edit', test: 'scenario.definition.edit', publish: 'scenario.definition.publish', managersOnly: ['publish'], bundled: ['scenario.definition.edit'] },
  reminders: { key: '/reminders', api: ['/api/reminders', '/api/friend-reminders', '/api/reminder-runs'], edit: '/reminders' },
  autoReplies: { key: '/auto-replies', api: ['/api/auto-replies', '/api/auto-reply-runs'], edit: '/auto-replies' },
  friendAdd: { key: '/friend-add-settings', api: ['/api/friend-add', '/api/friend-add-rules', '/api/friend-add-runs'], edit: '/friend-add-settings', publish: 'friend_add.definition.publish', managersOnly: ['publish'] },
  templates: { key: '/templates', api: ['/api/templates'], edit: '/templates' },
  richMenus: { key: '/rich-menus', api: ['/api/rich-menu', '/api/rich-menus', '/api/rich-menu-groups', '/api/rich-menu-images'], edit: '/rich-menus', test: '/rich-menus', publish: 'richmenu.definition.publish', archive: 'richmenu.definition.archive', managersOnly: ['edit', 'publish', 'archive'] },
  lineNotifications: { key: '/line-notifications', api: ['/api/line-notifications'], edit: '/line-notifications' },
  nenCampaigns: { key: '/nen-campaigns', api: ['/api/nen-campaigns'], edit: '/nen-campaigns' },
  nenMembers: { key: '/nen-members', api: ['/api/nen-members'], edit: '/nen-members' },
  webinars: { key: '/webinars', api: ['/api/webinars'], edit: '/webinars', export: 'administrator' },
  contents: { key: '/contents', api: ['/api/contents', '/api/media', '/api/file-scans'], edit: '/contents' },
  commonVars: { key: '/contents/vars', api: ['/api/common-vars'], edit: '/contents/vars', export: 'administrator' },
  forms: { key: '/form-submissions', api: ['/api/forms'], edit: '/form-submissions', publish: 'form.definition.publish', archive: 'form.definition.archive', export: 'form.submission.export', managersOnly: ['publish', 'archive'] },
} satisfies Record<string, { key: string; api: string[]; edit: string; test?: string; export?: string; publish?: string; archive?: string; managersOnly?: readonly StaffFeatureOperation[]; bundled?: readonly string[] }>;

export type DeliveryFeature = keyof typeof DELIVERY_FEATURE_POLICIES;
export type StaffFeatureOperation = 'view' | 'edit' | 'test' | 'export' | 'publish' | 'archive';
export interface StaffAccessSubject {
  role?: string | null;
  hqRole?: 'operator' | 'viewer' | null;
  permissionKeys?: readonly string[];
  viewPermissionKeys?: readonly string[];
  readOnly?: boolean;
}

export function deliveryPermissionKey(feature: DeliveryFeature, operation: StaffFeatureOperation): string {
  const policy: { key: string; edit: string; test?: string; export?: string; publish?: string; archive?: string } = DELIVERY_FEATURE_POLICIES[feature];
  if (operation === 'view') return policy.key;
  return operation === 'edit' ? policy.edit : policy[operation] ?? policy.edit;
}

export function hasStaffAccess(subject: StaffAccessSubject | null | undefined, key: string, read = false): boolean {
  if (!subject?.role || (!read && subject.readOnly)) return false;
  if (subject.role === 'owner' || subject.role === 'admin') return true;
  if (subject.hqRole === 'operator') return key !== 'administrator';
  if (subject.hqRole === 'viewer') return read && key !== 'administrator';
  if (subject.role !== 'staff' || key === 'administrator') return false;
  return subject.permissionKeys?.includes(key) === true
    || (read && subject.viewPermissionKeys?.includes(key) === true);
}

export function hasDeliveryAccess(subject: StaffAccessSubject | null | undefined, feature: DeliveryFeature, operation: StaffFeatureOperation): boolean {
  if (operation === 'export' && subject?.readOnly) return false;
  const policy: { key: string; managersOnly?: readonly StaffFeatureOperation[] } = DELIVERY_FEATURE_POLICIES[feature];
  if (policy.managersOnly?.includes(operation) && subject?.role !== 'owner' && subject?.role !== 'admin' && subject?.hqRole !== 'operator') return false;
  const read = operation === 'view';
  return hasStaffAccess(subject, DELIVERY_FEATURE_POLICIES[feature].key, read)
    && hasStaffAccess(subject, deliveryPermissionKey(feature, operation), read);
}

export const DELIVERY_API_PERMISSIONS: Array<[string, string]> = Object.values(DELIVERY_FEATURE_POLICIES)
  .flatMap((policy) => policy.api.map((prefix): [string, string] => [prefix, policy.key]));

/**
 * 予約の細かい権限（同じ要件の §7-2「予約管理editでも予約設定は別permission」）。
 * - `/booking/menus`: メニューと担当割当の編集・閲覧
 * - `booking.settings`: 予約設定（受付枠・資源・例外・予約スタッフ登録）の変更
 * - `booking.staff.own`: 本人に紐づく予約スタッフの勤務（シフト・休憩・連携）
 */
export const BOOKING_MENUS_KEY = '/booking/menus';
export const BOOKING_SETTINGS_KEY = 'booking.settings';
export const BOOKING_STAFF_OWN_KEY = 'booking.staff.own';

/**
 * 「項目ごとに決める」の各行。keys は edit/view 両レベルで使う
 * permission key の集合（middleware の permissionForApiPath が返す値）。
 */
export interface ScopeItem {
  id: string;
  label: string;
  note: string;
  kind: 'feature' | 'email_mask';
  keys: readonly string[];
  hint?: string;
}

export const SCOPE_ITEMS: readonly ScopeItem[] = [
  {
    id: 'friends',
    label: '友だち',
    note: '名前・タグ・対応状況',
    kind: 'feature',
    keys: ['/friends', '/tags'],
  },
  {
    id: 'pii',
    label: '個人情報',
    note: '電話番号・住所・メール',
    kind: 'email_mask',
    keys: [],
    /*
     * この注記は現在の状態の説明ではなく「伏せて見せる」を選んだときの
     * 一般説明。「そのまま見せる」の選択と併存しても矛盾しないよう、
     * 選択肢への条件付きの文にする（現在の見せ方の説明は画面右欄が出す）。
     */
    hint: '「伏せて見せる」を選ぶと、メールアドレスを伏せて表示します',
  },
  {
    id: 'delivery',
    label: '配信',
    note: '一斉配信・シナリオ・リマインダ',
    kind: 'feature',
    keys: Object.values(DELIVERY_FEATURE_POLICIES).map((policy) => policy.key),
    hint: '誤送信を防ぐためです',
  },
  {
    id: 'inbox',
    label: '受信箱',
    note: '友だちとのやりとり',
    kind: 'feature',
    keys: ['/chats'],
  },
  {
    id: 'booking',
    label: '予約',
    note: '予約・イベントの受付',
    kind: 'feature',
    keys: ['/booking/bookings', '/events'],
  },
  {
    id: 'booking_menus',
    label: '予約メニュー',
    note: 'メニューと担当の編集',
    kind: 'feature',
    keys: [BOOKING_MENUS_KEY],
    hint: '予約の受付とは別に決められます',
  },
  {
    id: 'booking_settings',
    label: '予約設定',
    note: '受付枠・資源・例外・予約スタッフ',
    kind: 'feature',
    keys: [BOOKING_SETTINGS_KEY],
    hint: '予約の受付ができても設定は別権限です',
  },
  {
    id: 'booking_own',
    label: '本人の勤務',
    note: '自分のシフト・休憩・外部連携',
    kind: 'feature',
    keys: [BOOKING_STAFF_OWN_KEY],
    hint: '自分に紐づく予約スタッフだけを対象にします',
  },
  {
    id: 'analytics',
    label: '分析',
    note: '成果・流入・レポート',
    kind: 'feature',
    keys: [
      '/',
      '/analytics',
      '/conversions',
      '/mileage',
      '/inflow-links',
      '/scoring',
      'conversion.approval.edit',
    ],
    hint: '売上の数字が見えます',
  },
  {
    id: 'settings',
    label: '設定',
    note: 'LINE・外部連携・ユーザー',
    kind: 'feature',
    keys: ['/webhooks', '/ec-commerce', ACCESS_USER_VIEW_KEY, ACCESS_AUDIT_VIEW_KEY],
  },
  {
    id: 'operations',
    label: '運用状態',
    note: '健全性・緊急停止・更新履歴',
    kind: 'feature',
    keys: ['/health'],
  },
  { id: 'visit_stamps', label: '来店スタンプ', note: 'カード・押印・紙の移行', kind: 'feature', keys: ['/visit-stamps'] },
];

export const SCOPE_ITEM_IDS: readonly string[] = SCOPE_ITEMS.map((item) => item.id);

/** 3択の表。行 id → レベル。 */
export type ScopeLevels = Record<string, FeatureAccessLevel>;

export interface BundlePreset {
  levels: ScopeLevels;
  emailMask: EmailMaskLevel;
}

/**
 * bundle の初期権限（-30 §6 が正本）。
 *
 * - 管理者: 全機能 edit（実際の判定は role=owner/admin が全通過）
 * - 運用: 配信・予約・コンテンツ・受信箱・友だちを edit、分析・運用状態は view
 * - 受付: 受信箱・予約を edit、友だちは限定表示(view)。売上・配信・設定は非表示
 * - 見るだけ: 全機能 view（access_level=read_only が変更系も止める）
 * - カスタム: 既定なし。管理者が項目ごとに決める
 */
export const BUNDLE_PRESETS: Record<Exclude<AccessRoleBundleId, 'custom'>, BundlePreset> = {
  administrator: {
    levels: Object.fromEntries(SCOPE_ITEM_IDS.map((id) => [id, 'edit' as const])),
    emailMask: 'full',
  },
  operations: {
    levels: {
      friends: 'edit',
      pii: 'view',
      delivery: 'edit',
      inbox: 'edit',
      booking: 'edit',
      booking_menus: 'view',
      booking_settings: 'view',
      booking_own: 'edit',
      analytics: 'view',
      settings: 'none',
      operations: 'view',
      visit_stamps: 'edit',
    },
    emailMask: 'masked',
  },
  reception: {
    levels: {
      friends: 'view',
      pii: 'view',
      delivery: 'none',
      inbox: 'edit',
      booking: 'edit',
      booking_menus: 'view',
      booking_settings: 'view',
      booking_own: 'edit',
      analytics: 'none',
      settings: 'none',
      operations: 'view',
      visit_stamps: 'edit',
    },
    emailMask: 'masked',
  },
  view_only: {
    levels: Object.fromEntries(SCOPE_ITEM_IDS.map((id) => [id, 'view' as const])),
    emailMask: 'masked',
  },
};

/** 3択から permission key の edit/view 集合を組み立てる。 */
export function scopeLevelsToKeys(levels: ScopeLevels): { edit: string[]; view: string[] } {
  const edit: string[] = [];
  const view: string[] = [];
  for (const item of SCOPE_ITEMS) {
    if (item.kind !== 'feature') continue;
    const level = levels[item.id];
    if (level === 'edit') {
      edit.push(...item.keys);
      // 配信を変えられる人は、下書き・テスト・送信・CSVも組で付ける。
      // 止める・送り直すは指定者のみ（ここには入れない）。
      if (item.id === 'delivery') {
        for (const policy of Object.values(DELIVERY_FEATURE_POLICIES)) {
          if ('bundled' in policy) edit.push(...policy.bundled);
        }
      }
    } else if (level === 'view') view.push(...item.keys);
  }
  return { edit, view };
}

/** 保存済み keys から各行のレベルを復元する（編集画面を開いたとき用）。 */
export function keysToScopeLevels(editKeys: string[], viewKeys: string[]): ScopeLevels {
  const levels: ScopeLevels = {};
  for (const item of SCOPE_ITEMS) {
    if (item.kind !== 'feature') continue;
    if (item.keys.every((key) => editKeys.includes(key))) levels[item.id] = 'edit';
    else if (item.keys.every((key) => viewKeys.includes(key) || editKeys.includes(key))) {
      levels[item.id] = 'view';
    } else {
      levels[item.id] = 'none';
    }
  }
  return levels;
}

/** 既存の「配信=edit」の完全な束も、同じ表の操作鍵に展開する（DB更新不要）。 */
export function effectiveStaffEditKeys(keys: readonly string[]): string[] {
  if (!Array.isArray(keys)) return [];
  keys = keys.filter((key): key is string => typeof key === 'string');
  const delivery = SCOPE_ITEMS.find((item) => item.id === 'delivery')!;
  return [...new Set(delivery.keys.every((key) => keys.includes(key))
    ? [...keys, ...scopeLevelsToKeys({ delivery: 'edit' }).edit]
    : keys)];
}
export const SCOPE_OPERATION_KEYS: readonly string[] = Object.values(DELIVERY_FEATURE_POLICIES)
  .flatMap((policy) => 'bundled' in policy ? [...policy.bundled] : []);
