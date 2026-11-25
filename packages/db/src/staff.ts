import { sqlIdSet } from './id-queries.js';
import { jstNow } from './utils.js';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';

export type TenantStatus = 'active' | 'suspended' | 'archived';

export interface StaffMember {
  id: string;
  name: string;
  email: string | null;
  role: 'owner' | 'admin' | 'staff';
  access_level: 'full' | 'read_only';
  api_key: string;
  line_user_id: string | null;
  is_active: number;
  permission_keys: string;
  notification_preferences: string;
  invite_status: 'pending_email' | 'pending_line' | 'active' | 'expired';
  invite_token_hash: string | null;
  invite_expires_at: string | null;
  email_verified_at: string | null;
  line_linked_at: string | null;
  totp_secret_enc: string | null;
  totp_pending_secret_enc: string | null;
  totp_enabled_at: string | null;
  totp_last_used_step: number | null;
  password_hash?: string | null;
  password_updated_at?: string | null;
  assigned_line_account_id?: string | null;
  can_access_descendant_accounts?: number;
  account_scope?: 'all' | 'accounts';
  policy_version?: number;
  /** 明示保存された役割bundle。NULL は従来どおり role+access_level から導出。 */
  role_bundle?: string | null;
  /** 「見えるだけ」の permission key(JSON配列)。GET系だけを許可する。 */
  view_permission_keys?: string | null;
  /** スタッフのメール表示。'full'|'masked'|'none'、NULL は従来判定。 */
  email_mask?: string | null;
  /** 確認待ちの新しいメールアドレス。確認するまで email は変えない。 */
  email_change_new?: string | null;
  email_change_token_hash?: string | null;
  email_change_expires_at?: string | null;
  tenant_id: string | null;
  /** 認証用 JOIN でだけ付く所属統括の実効状態。既定の運営会社は常に active。 */
  tenant_status?: TenantStatus;
  created_at: string;
  updated_at: string;
}

/**
 * 認証用 staff 取得の共通射影。
 *
 * 既定の運営会社は契約先の停止対象ではないため常に active とする。
 * それ以外で統括行が失われている場合は安全側の archived に倒す。
 */
const STAFF_WITH_TENANT_STATUS = `SELECT sm.*,
  CASE
    WHEN COALESCE(sm.tenant_id, ?) = ? THEN 'active'
    WHEN t.status IN ('active', 'suspended', 'archived') THEN t.status
    ELSE 'archived'
  END AS tenant_status
  FROM staff_members sm
  LEFT JOIN tenants t ON t.id = COALESCE(sm.tenant_id, ?)`;

function tenantStatusBindings(): [string, string, string] {
  return [DEFAULT_TENANT_ID, DEFAULT_TENANT_ID, DEFAULT_TENANT_ID];
}

export interface CreateStaffInput {
  name: string;
  email?: string | null;
  role: 'owner' | 'admin' | 'staff';
  access_level?: 'full' | 'read_only';
  line_user_id?: string | null;
  is_active?: number;
  permission_keys?: string[];
  notification_preferences?: Record<string, { email: boolean; line: boolean }>;
  invite_status?: StaffMember['invite_status'];
  invite_token_hash?: string | null;
  invite_expires_at?: string | null;
  assigned_line_account_id?: string | null;
  can_access_descendant_accounts?: boolean;
  account_scope?: 'all' | 'accounts';
  role_bundle?: string | null;
  view_permission_keys?: string[];
  email_mask?: string | null;
  tenant_id?: string | null;
}

export interface UpdateStaffInput {
  name?: string;
  email?: string | null;
  role?: 'owner' | 'admin' | 'staff';
  access_level?: 'full' | 'read_only';
  is_active?: number;
  line_user_id?: string | null;
  permission_keys?: string[];
  notification_preferences?: Record<string, { email: boolean; line: boolean }>;
  invite_status?: StaffMember['invite_status'];
  invite_token_hash?: string | null;
  invite_expires_at?: string | null;
  email_verified_at?: string | null;
  line_linked_at?: string | null;
  totp_secret_enc?: string | null;
  totp_pending_secret_enc?: string | null;
  totp_enabled_at?: string | null;
  totp_last_used_step?: number | null;
  password_hash?: string | null;
  password_updated_at?: string | null;
  assigned_line_account_id?: string | null;
  can_access_descendant_accounts?: boolean;
  account_scope?: 'all' | 'accounts';
  role_bundle?: string | null;
  view_permission_keys?: string[];
  email_mask?: string | null;
  email_change_new?: string | null;
  email_change_token_hash?: string | null;
  email_change_expires_at?: string | null;
}

function generateApiKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `lh_${hex}`;
}

export async function getStaffByApiKey(
  db: D1Database,
  apiKey: string,
): Promise<StaffMember | null> {
  const staff = await db
    .prepare(`${STAFF_WITH_TENANT_STATUS} WHERE sm.api_key = ? AND sm.is_active = 1
      AND NOT EXISTS(SELECT 1 FROM platform_settings WHERE key='auth.staff_api_key.revoked_at:'||sm.id)`)
    .bind(...tenantStatusBindings(), apiKey)
    .first<StaffMember>();
  if (!staff || staff.tenant_status !== 'active') return null;
  // Guard the metadata write against a concurrent rotation or revocation.
  const used = await db.prepare(`INSERT INTO platform_settings(key,value,updated_by,updated_at)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM staff_members sm WHERE sm.id=? AND sm.api_key=? AND sm.is_active=1
      AND NOT EXISTS(SELECT 1 FROM platform_settings WHERE key='auth.staff_api_key.revoked_at:'||sm.id))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at RETURNING key`)
    .bind(`auth.staff_api_key.last_used_at:${staff.id}`, new Date().toISOString(), staff.id, jstNow(), staff.id, apiKey).first();
  return used ? staff : null;
}

export async function getStaffByLineUserId(
  db: D1Database,
  lineUserId: string,
): Promise<StaffMember | null> {
  return db
    .prepare(`${STAFF_WITH_TENANT_STATUS} WHERE sm.line_user_id = ? AND sm.is_active = 1`)
    .bind(...tenantStatusBindings(), lineUserId)
    .first<StaffMember>();
}

/**
 * 無効な人も含めて LINE ユーザーIDで引く。
 *
 * 招待からの連携では、無効化された古い行が同じLINEアカウントを握ったまま
 * 残っていることがある。line_user_id にはユニーク制約があるので、先に
 * 見つけて外さないと連携そのものが失敗する。ログイン判定には使わない。
 */
export async function getStaffByLineUserIdIncludingInactive(
  db: D1Database,
  lineUserId: string,
): Promise<StaffMember | null> {
  return db
    .prepare(`${STAFF_WITH_TENANT_STATUS} WHERE sm.line_user_id = ?`)
    .bind(...tenantStatusBindings(), lineUserId)
    .first<StaffMember>();
}

export async function getStaffMembers(db: D1Database, tenantId: string): Promise<StaffMember[]> {
  const result = await db
    .prepare('SELECT * FROM staff_members WHERE COALESCE(tenant_id, ?) = ? ORDER BY created_at ASC')
    .bind(DEFAULT_TENANT_ID, tenantId)
    .all<StaffMember>();
  return result.results;
}

export async function getStaffById(
  db: D1Database,
  id: string,
): Promise<StaffMember | null> {
  return db
    .prepare(`${STAFF_WITH_TENANT_STATUS} WHERE sm.id = ?`)
    .bind(...tenantStatusBindings(), id)
    .first<StaffMember>();
}

/**
 * 担当者の表示名をまとめて引く。
 *
 * 登録メディアの `uploaded_by` は内部ID（UUID）のまま残し、画面には
 * この名前を出す。退職・削除済みで引けないIDは載せない（呼び出し側が
 * 「削除された担当者」と出す）。空・重複は取り除いて1回で引く。
 */
export async function getStaffNameMap(
  db: D1Database,
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set(
    ids.filter((id): id is string => typeof id === 'string' && id.length > 0),
  )];
  const names = new Map<string, string>();
  if (unique.length === 0) return names;
  const placeholders = sqlIdSet(unique).sql;
  const rows = await db
    .prepare(`SELECT id, name FROM staff_members WHERE id IN (${placeholders})`)
    .bind(...(unique.length ? sqlIdSet(unique).binds : []))
    .all<{ id: string; name: string }>();
  for (const row of rows.results ?? []) names.set(row.id, row.name);
  return names;
}

function staffInsertStatement(
  db: D1Database,
  args: { id: string; now: string; apiKey: string; input: CreateStaffInput },
): D1PreparedStatement {
  const { id, now, apiKey, input } = args;
  return db
    .prepare(
      `INSERT INTO staff_members
       (id, name, email, role, access_level, api_key, line_user_id, is_active,
        permission_keys, notification_preferences, invite_status, invite_token_hash,
        invite_expires_at, assigned_line_account_id, can_access_descendant_accounts,
        account_scope, role_bundle, view_permission_keys, email_mask,
        tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id, input.name, input.email ?? null, input.role, input.access_level ?? 'full', apiKey,
      input.line_user_id ?? null, input.is_active ?? 1,
      JSON.stringify(input.permission_keys ?? []), JSON.stringify(input.notification_preferences ?? {}),
      input.invite_status ?? 'active', input.invite_token_hash ?? null,
      input.invite_expires_at ?? null, input.assigned_line_account_id ?? null,
      input.can_access_descendant_accounts ? 1 : 0,
      input.account_scope ?? 'all',
      input.role_bundle ?? null,
      input.view_permission_keys ? JSON.stringify(input.view_permission_keys) : null,
      input.email_mask ?? null,
      input.tenant_id ?? DEFAULT_TENANT_ID, now, now,
    );
}

export async function createStaffMember(
  db: D1Database,
  input: CreateStaffInput,
): Promise<StaffMember> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const apiKey = generateApiKey();

  await staffInsertStatement(db, { id, now, apiKey, input }).run();

  return (await db
    .prepare('SELECT * FROM staff_members WHERE id = ?')
    .bind(id)
    .first<StaffMember>())!;
}

/**
 * M957: 招待の作成と担当範囲の割当を同じ取引（batch）で書く。
 *
 * 本人だけ作って範囲の途中で止まると、招待が届いていない幽霊行が
 * 残る。batch は1つの取引なので、どこかで失敗したら本人も範囲も
 * 残らない。同じメールが同時に届いたときは一意制約で片方だけが
 * 残り、負けた側は制約違反になる（呼び出し側が409で返す）。
 */
export async function createStaffMemberWithScopes(
  db: D1Database,
  input: CreateStaffInput,
  lineAccountIds: string[],
): Promise<StaffMember> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const apiKey = generateApiKey();

  await db.batch([
    staffInsertStatement(db, { id, now, apiKey, input }),
    db.prepare('DELETE FROM staff_account_scopes WHERE staff_id = ?').bind(id),
    ...lineAccountIds.map((lineAccountId) => db
      .prepare('INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at) VALUES (?, ?, ?)')
      .bind(id, lineAccountId, now)),
  ]);

  return (await db
    .prepare('SELECT * FROM staff_members WHERE id = ?')
    .bind(id)
    .first<StaffMember>())!;
}

/**
 * M957: 招待の後片付け。本人と担当範囲を同じ取引で消す。
 *
 * 外部キー任せにしない（D1 は既定で外部キーを強制しない）。範囲だけ
 * 残ると後の招待の割当に混ざるので、本人と一緒に消す。
 */
export async function deleteStaffMemberWithScopes(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM staff_account_scopes WHERE staff_id = ?').bind(id),
    db.prepare('DELETE FROM staff_members WHERE id = ?').bind(id),
  ]);
}

export async function updateStaffMember(
  db: D1Database,
  id: string,
  input: UpdateStaffInput,
  options?: { expectedPolicyVersion?: number; requireRemainingAdmin?: { tenantId: string } },
): Promise<StaffMember | null> {
  const now = jstNow();
  const sets: string[] = ['updated_at = ?', 'policy_version = policy_version + 1'];
  const values: (string | number | null)[] = [now];

  if (input.name !== undefined) { sets.push('name = ?'); values.push(input.name); }
  if (input.email !== undefined) { sets.push('email = ?'); values.push(input.email ?? null); }
  if (input.role !== undefined) { sets.push('role = ?'); values.push(input.role); }
  if (input.access_level !== undefined) { sets.push('access_level = ?'); values.push(input.access_level); }
  if (input.is_active !== undefined) { sets.push('is_active = ?'); values.push(input.is_active); }
  if (input.line_user_id !== undefined) { sets.push('line_user_id = ?'); values.push(input.line_user_id); }
  if (input.permission_keys !== undefined) { sets.push('permission_keys = ?'); values.push(JSON.stringify(input.permission_keys)); }
  if (input.notification_preferences !== undefined) { sets.push('notification_preferences = ?'); values.push(JSON.stringify(input.notification_preferences)); }
  if (input.invite_status !== undefined) { sets.push('invite_status = ?'); values.push(input.invite_status); }
  if (input.invite_token_hash !== undefined) { sets.push('invite_token_hash = ?'); values.push(input.invite_token_hash); }
  if (input.invite_expires_at !== undefined) { sets.push('invite_expires_at = ?'); values.push(input.invite_expires_at); }
  if (input.email_verified_at !== undefined) { sets.push('email_verified_at = ?'); values.push(input.email_verified_at); }
  if (input.line_linked_at !== undefined) { sets.push('line_linked_at = ?'); values.push(input.line_linked_at); }
  if (input.totp_secret_enc !== undefined) { sets.push('totp_secret_enc = ?'); values.push(input.totp_secret_enc); }
  if (input.totp_pending_secret_enc !== undefined) { sets.push('totp_pending_secret_enc = ?'); values.push(input.totp_pending_secret_enc); }
  if (input.totp_enabled_at !== undefined) { sets.push('totp_enabled_at = ?'); values.push(input.totp_enabled_at); }
  if (input.totp_last_used_step !== undefined) { sets.push('totp_last_used_step = ?'); values.push(input.totp_last_used_step); }
  if (input.password_hash !== undefined) { sets.push('password_hash = ?'); values.push(input.password_hash); }
  if (input.password_updated_at !== undefined) { sets.push('password_updated_at = ?'); values.push(input.password_updated_at); }
  if (input.assigned_line_account_id !== undefined) { sets.push('assigned_line_account_id = ?'); values.push(input.assigned_line_account_id); }
  if (input.can_access_descendant_accounts !== undefined) { sets.push('can_access_descendant_accounts = ?'); values.push(input.can_access_descendant_accounts ? 1 : 0); }
  if (input.account_scope !== undefined) { sets.push('account_scope = ?'); values.push(input.account_scope); }
  if (input.role_bundle !== undefined) { sets.push('role_bundle = ?'); values.push(input.role_bundle); }
  if (input.view_permission_keys !== undefined) { sets.push('view_permission_keys = ?'); values.push(JSON.stringify(input.view_permission_keys)); }
  if (input.email_mask !== undefined) { sets.push('email_mask = ?'); values.push(input.email_mask); }
  if (input.email_change_new !== undefined) { sets.push('email_change_new = ?'); values.push(input.email_change_new); }
  if (input.email_change_token_hash !== undefined) { sets.push('email_change_token_hash = ?'); values.push(input.email_change_token_hash); }
  if (input.email_change_expires_at !== undefined) { sets.push('email_change_expires_at = ?'); values.push(input.email_change_expires_at); }

  values.push(id);
  // 版を指定されたら「読んだときの版のまま」を更新条件にする。
  // 他者が先に変えていたら1行も当たらず、呼び出し側が409で止める。
  // 管理者を外す変更は「ほかに有効な管理者が残る」ことも同じ書き込みの
  // 条件にする。同時に互いを止めても0人にならない（後勝ちではなく競合で止まる）。
  let where = 'WHERE id = ?';
  if (options?.expectedPolicyVersion !== undefined) {
    where += ' AND policy_version = ?';
    values.push(options.expectedPolicyVersion);
  }
  if (options?.requireRemainingAdmin !== undefined) {
    where += ` AND EXISTS (
      SELECT 1 FROM staff_members AS remaining
      WHERE remaining.id <> ?
        AND COALESCE(remaining.tenant_id, ?) = ?
        AND remaining.is_active = 1
        AND remaining.role <> 'staff'
        AND remaining.access_level <> 'read_only'
    )`;
    values.push(id, DEFAULT_TENANT_ID, options.requireRemainingAdmin.tenantId);
  }
  const applied = await db
    .prepare(`UPDATE staff_members SET ${sets.join(', ')} ${where}`)
    .bind(...values)
    .run();
  if ((applied.meta.changes ?? 0) === 0
    && (options?.expectedPolicyVersion !== undefined || options?.requireRemainingAdmin !== undefined)) {
    return null;
  }

  return db.prepare('SELECT * FROM staff_members WHERE id = ?').bind(id).first<StaffMember>();
}

/**
 * 仮秘密の条件付き確保。まだ無いときだけ置く。
 *
 * 同じ合言葉への同時取得で両方が新しい秘密を作っても、保存は1つだけ。
 * 置けた側が true。負けた側は置かれた値を読み直して同じQRを返す。
 */
export async function claimTotpPendingSecret(
  db: D1Database,
  staffId: string,
  pendingSecretEnc: string,
): Promise<boolean> {
  const applied = await db
    .prepare('UPDATE staff_members SET totp_pending_secret_enc = ?, updated_at = ?, policy_version = policy_version + 1 WHERE id = ? AND totp_pending_secret_enc IS NULL')
    .bind(pendingSecretEnc, jstNow(), staffId)
    .run();
  return (applied.meta.changes ?? 0) > 0;
}

/**
 * 権限保存の要求キー台帳。同じ保存の送り直しを版を重ねずに返す。
 *
 * 同じキーで内容が違う送り直しは受け付けない（request_hash で照合）。
 * 行が無いときは null。
 */
export interface StaffPermissionReceipt {
  idempotency_key: string;
  staff_id: string;
  request_hash: string;
  policy_version: number;
  result: string;
  created_at: string;
}

export async function getStaffPermissionReceipt(
  db: D1Database,
  staffId: string,
  idempotencyKey: string,
): Promise<StaffPermissionReceipt | null> {
  return db
    .prepare('SELECT * FROM staff_permission_receipts WHERE idempotency_key = ? AND staff_id = ?')
    .bind(idempotencyKey, staffId)
    .first<StaffPermissionReceipt>();
}

export async function saveStaffPermissionReceipt(
  db: D1Database,
  receipt: { idempotencyKey: string; staffId: string; requestHash: string; policyVersion: number; result: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO staff_permission_receipts
         (idempotency_key, staff_id, request_hash, policy_version, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (idempotency_key, staff_id) DO NOTHING`,
    )
    .bind(
      receipt.idempotencyKey, receipt.staffId, receipt.requestHash,
      receipt.policyVersion, receipt.result, jstNow(),
    )
    .run();
}

export async function getStaffAccountScopeIds(db: D1Database, staffId: string): Promise<string[]> {
  const result = await db
    .prepare('SELECT line_account_id FROM staff_account_scopes WHERE staff_id = ? ORDER BY line_account_id')
    .bind(staffId)
    .all<{ line_account_id: string }>();
  return result.results.map((row) => row.line_account_id);
}

/*
 * 一覧の N+1 対策。1人ずつ getStaffAccountScopeIds を叩くと
 * 人数分の往復になるので、一覧では IN で一括取得して振り分ける。
 */
export async function getStaffAccountScopeMap(
  db: D1Database,
  staffIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const ids = [...new Set(staffIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return map;
  const result = await db
    .prepare(`SELECT staff_id, line_account_id FROM staff_account_scopes WHERE staff_id IN (${sqlIdSet(ids).sql}) ORDER BY staff_id, line_account_id`)
    .bind(...sqlIdSet(ids).binds)
    .all<{ staff_id: string; line_account_id: string }>();
  for (const row of result.results) {
    const list = map.get(row.staff_id) ?? [];
    list.push(row.line_account_id);
    map.set(row.staff_id, list);
  }
  return map;
}

export async function replaceStaffAccountScopes(
  db: D1Database,
  staffId: string,
  lineAccountIds: string[],
): Promise<void> {
  const now = jstNow();
  await db.batch([
    db.prepare('DELETE FROM staff_account_scopes WHERE staff_id = ?').bind(staffId),
    ...lineAccountIds.map((lineAccountId) => db
      .prepare('INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at) VALUES (?, ?, ?)')
      .bind(staffId, lineAccountId, now)),
  ]);
}

export async function getStaffByInviteTokenHash(db: D1Database, tokenHash: string): Promise<StaffMember | null> {
  return db
    .prepare(`${STAFF_WITH_TENANT_STATUS} WHERE sm.invite_token_hash = ?`)
    .bind(...tenantStatusBindings(), tokenHash)
    .first<StaffMember>();
}

/** メール変更の確認リンクから本人の行を引く。トークンは指紋で照合する。 */
export async function getStaffByEmailChangeTokenHash(db: D1Database, tokenHash: string): Promise<StaffMember | null> {
  return db.prepare('SELECT * FROM staff_members WHERE email_change_token_hash = ?').bind(tokenHash).first<StaffMember>();
}

export async function deleteStaffMember(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM staff_members WHERE id = ?').bind(id).run();
}

export async function regenerateStaffApiKey(db: D1Database, id: string): Promise<string> {
  const newKey = generateApiKey();
  const now = jstNow();
  const result = await db
    .prepare('UPDATE staff_members SET api_key = ?, updated_at = ? WHERE id = ?')
    .bind(newKey, now, id)
    .run();
  if (result.meta.changes === 0) {
    throw new Error(`Staff member not found: ${id}`);
  }
  return newKey;
}

export async function countStaffByRole(db: D1Database, role: string): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM staff_members WHERE role = ?')
    .bind(role)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export async function countActiveStaffByRole(db: D1Database, role: string): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM staff_members WHERE role = ? AND is_active = 1')
    .bind(role)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export async function createAdminSession(
  db: D1Database,
  tokenHash: string,
  staffId: string,
  expiresAt: string,
  device: { userAgent?: string | null; ipPrefix?: string | null; deviceHash?: string | null; unfamiliarAt?: string | null } = {},
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admin_sessions (token_hash, staff_id, expires_at, user_agent, ip_prefix, device_hash, unfamiliar_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(tokenHash, staffId, expiresAt, device.userAgent ?? null, device.ipPrefix ?? null, device.deviceHash ?? null, device.unfamiliarAt ?? null)
    .run();
}

/** V: 大事な操作の再確認・いつもと違うログインで読み書きするセッション本体。 */
export interface AdminSessionSecurity {
  token_hash: string;
  staff_id: string;
  created_at: string;
  expires_at: string;
  step_up_at: string | null;
  device_hash: string | null;
  ip_prefix: string | null;
  unfamiliar_at: string | null;
}

export async function getAdminSessionByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<AdminSessionSecurity | null> {
  return db
    .prepare(
      `SELECT token_hash, staff_id, created_at, expires_at, step_up_at, device_hash, ip_prefix, unfamiliar_at
       FROM admin_sessions
       WHERE token_hash = ?`,
    )
    .bind(tokenHash)
    .first<AdminSessionSecurity>();
}

/** 再確認（step-up）に成功した時刻をセッションへ刻む。APIキー経路は行が無いので何もしない。 */
export async function markAdminSessionStepUp(
  db: D1Database,
  tokenHash: string,
  stepUpAt: string,
): Promise<void> {
  await db
    .prepare('UPDATE admin_sessions SET step_up_at = ? WHERE token_hash = ?')
    .bind(stepUpAt, tokenHash)
    .run();
}

/**
 * 過去に同じ端末か同じ場所から入った形跡があるか。
 *
 * 端末（device_hash）と場所（ip_prefix）は片方しか残っていない行もあるため、
 * 「比べられる側が存在する」信号ごとに照合する。判断材料がまだ1件も無い
 * 初回ログインは比較対象がないので unfamiliar にしない（導入直後の全員通知を
 * 避ける狙いもある）。
 */
export async function adminSessionFamiliarity(
  db: D1Database,
  staffId: string,
  input: { deviceHash: string | null; ipPrefix: string | null },
): Promise<{ hasBaseline: boolean; deviceKnown: boolean; ipKnown: boolean }> {
  const rows = await db
    .prepare(
      `SELECT
         COUNT(*) AS baseline_count,
         MAX(CASE WHEN device_hash IS NOT NULL AND device_hash = ? THEN 1 ELSE 0 END) AS device_known,
         MAX(CASE WHEN ip_prefix IS NOT NULL AND ip_prefix = ? THEN 1 ELSE 0 END) AS ip_known,
         MAX(CASE WHEN device_hash IS NOT NULL THEN 1 ELSE 0 END) AS has_device_data
       FROM admin_sessions
       WHERE staff_id = ?`,
    )
    .bind(input.deviceHash ?? '', input.ipPrefix ?? '', staffId)
    .first<{ baseline_count: number; device_known: number; ip_known: number; has_device_data: number }>();
  const hasBaseline = Number(rows?.baseline_count ?? 0) > 0;
  const hasDeviceData = Number(rows?.has_device_data ?? 0) > 0;
  return {
    hasBaseline,
    // 端末は device_hash が取れるようになってから照合する。過去に1件も
    // 記録が無い間は「初めて」と断定しない。
    deviceKnown: !input.deviceHash || !hasDeviceData || Number(rows?.device_known ?? 0) > 0,
    // 場所は ip_prefix が昔から記録されているので、そのまま照合する。
    ipKnown: !input.ipPrefix || Number(rows?.ip_known ?? 0) > 0,
  };
}

/** 本人のセッション一覧用。token_hash は漏れても認証に使えない指紋として返す。 */
export interface AdminSessionSummary {
  token_hash: string;
  created_at: string;
  expires_at: string;
  user_agent: string | null;
  ip_prefix: string | null;
}

export async function listAdminSessionsByStaff(
  db: D1Database,
  staffId: string,
  now: string,
): Promise<AdminSessionSummary[]> {
  const result = await db
    .prepare(
      `SELECT token_hash, created_at, expires_at, user_agent, ip_prefix
       FROM admin_sessions
       WHERE staff_id = ? AND expires_at > ?
       ORDER BY created_at DESC`,
    )
    .bind(staffId, now)
    .all<AdminSessionSummary>();
  return result.results ?? [];
}

/** 本人のセッションだけを消す。他人の token_hash を指定しても削除しない。 */
export async function deleteAdminSessionForStaff(
  db: D1Database,
  staffId: string,
  tokenHash: string,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM admin_sessions WHERE staff_id = ? AND token_hash = ?')
    .bind(staffId, tokenHash)
    .run();
  if ((result.meta.changes ?? 0) > 0) {
    await db.prepare("DELETE FROM platform_settings WHERE key='auth.mfa.session:'||?").bind(tokenHash).run();
    await db.prepare('UPDATE impersonation_sessions SET ended_at=? WHERE staff_id=? AND ended_at IS NULL').bind(jstNow(), staffId).run();
  }
  return (result.meta.changes ?? 0) > 0;
}

/** 今のセッション以外をまとめて失効させる。消した件数を返す。 */
export async function deleteOtherAdminSessions(
  db: D1Database,
  staffId: string,
  keepTokenHash: string,
  keepTrust?: { markerHash: string; ipPrefix: string } | null,
): Promise<number> {
  const result = await db.batch([
    db.prepare(`DELETE FROM platform_settings WHERE key IN
    (SELECT 'auth.mfa.session:'||token_hash FROM admin_sessions WHERE staff_id=? AND token_hash<>?)`)
    .bind(staffId, keepTokenHash),
    db.prepare('DELETE FROM admin_sessions WHERE staff_id = ? AND token_hash <> ?').bind(staffId, keepTokenHash),
    db.prepare('DELETE FROM auth_trusted_logins WHERE staff_id = ? AND NOT (marker_hash = ? AND ip_prefix = ?)').bind(staffId, keepTrust?.markerHash ?? '', keepTrust?.ipPrefix ?? ''),
  ]);
  return result[1]?.meta.changes ?? 0;
}

export async function getStaffByAdminSession(
  db: D1Database,
  tokenHash: string,
  now: string,
): Promise<StaffMember | null> {
  return db
    .prepare(
      `SELECT sm.*,
              CASE
                WHEN COALESCE(sm.tenant_id, ?) = ? THEN 'active'
                WHEN t.status IN ('active', 'suspended', 'archived') THEN t.status
                ELSE 'archived'
              END AS tenant_status
       FROM admin_sessions s
       JOIN staff_members sm ON sm.id = s.staff_id
       LEFT JOIN tenants t ON t.id = COALESCE(sm.tenant_id, ?)
       WHERE s.token_hash = ? AND s.expires_at > ? AND sm.is_active = 1`,
    )
    .bind(...tenantStatusBindings(), tokenHash, now)
    .first<StaffMember>();
}

export async function deleteAdminSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE impersonation_sessions SET ended_at=? WHERE ended_at IS NULL
      AND staff_id IN (SELECT staff_id FROM admin_sessions WHERE token_hash=?)`).bind(jstNow(), tokenHash),
    db.prepare("DELETE FROM platform_settings WHERE key='auth.mfa.session:'||?").bind(tokenHash),
    db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(tokenHash),
  ]);
}

export async function deleteExpiredAdminSessions(db: D1Database, now: string): Promise<void> {
  await db.batch([db.prepare("DELETE FROM platform_settings WHERE key IN (SELECT 'auth.mfa.session:'||token_hash FROM admin_sessions WHERE expires_at<=?)").bind(now),
    db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(now)]);
}

/**
 * 権限・利用状態・MFAの変更後に、対象者が古い認証状態を使い続けないようにする。
 *
 * staff_members は毎リクエスト読み直すため権限そのものは即時反映されるが、
 * 変更前に発行したセッションと二段階認証の途中状態は残る。両方を同じ処理で
 * 消し、次の操作では必ず新しい設定でログインし直してもらう。
 */
export async function revokeStaffAuthentication(db: D1Database, staffId: string): Promise<void> {
  await db.batch([
    db.prepare('UPDATE impersonation_sessions SET ended_at=? WHERE staff_id=? AND ended_at IS NULL').bind(jstNow(), staffId),
    db.prepare("DELETE FROM platform_settings WHERE key IN (SELECT 'auth.mfa.session:'||token_hash FROM admin_sessions WHERE staff_id=?)").bind(staffId),
    db.prepare('DELETE FROM admin_sessions WHERE staff_id = ?').bind(staffId),
    db.prepare('DELETE FROM admin_two_factor_challenges WHERE staff_id = ?').bind(staffId),
    db.prepare('DELETE FROM auth_trusted_logins WHERE staff_id = ?').bind(staffId),
  ]);
}

export type TwoFactorChallengePurpose = 'verify' | 'setup';

export interface TwoFactorChallenge {
  token_hash: string;
  staff_id: string;
  expires_at: string;
  attempts: number;
  created_at: string;
  /** 'verify' は登録済みの確認用、'setup' は未登録者の初回設定用。混ぜて使えない。 */
  purpose: TwoFactorChallengePurpose;
  /** 1 なら確認後に発行するセッションを 7 日、0 なら既定の 8 時間にする。 */
  remember: number;
}

export async function createTwoFactorChallenge(
  db: D1Database,
  tokenHash: string,
  staffId: string,
  expiresAt: string,
  options: { purpose?: TwoFactorChallengePurpose; remember?: boolean } = {},
): Promise<void> {
  await db.prepare('DELETE FROM admin_two_factor_challenges WHERE staff_id = ?').bind(staffId).run();
  await db.prepare(
    'INSERT INTO admin_two_factor_challenges (token_hash, staff_id, expires_at, purpose, remember) VALUES (?, ?, ?, ?, ?)',
  ).bind(tokenHash, staffId, expiresAt, options.purpose ?? 'verify', options.remember ? 1 : 0).run();
}

export async function getTwoFactorChallenge(
  db: D1Database,
  tokenHash: string,
): Promise<TwoFactorChallenge | null> {
  return db.prepare('SELECT * FROM admin_two_factor_challenges WHERE token_hash = ?')
    .bind(tokenHash).first<TwoFactorChallenge>();
}

export async function incrementTwoFactorChallengeAttempts(
  db: D1Database,
  tokenHash: string,
): Promise<void> {
  await db.prepare('UPDATE admin_two_factor_challenges SET attempts = attempts + 1 WHERE token_hash = ?')
    .bind(tokenHash).run();
}

export async function deleteTwoFactorChallenge(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare('DELETE FROM admin_two_factor_challenges WHERE token_hash = ?').bind(tokenHash).run();
}

export async function deleteExpiredTwoFactorChallenges(db: D1Database, now: string): Promise<void> {
  await db.prepare('DELETE FROM admin_two_factor_challenges WHERE expires_at <= ?').bind(now).run();
}

/** Atomically claims a TOTP time step so the same code cannot create two sessions. */
export async function claimStaffTotpStep(db: D1Database, staffId: string, step: number): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE staff_members
     SET totp_last_used_step = ?, updated_at = ?
     WHERE id = ? AND (totp_last_used_step IS NULL OR totp_last_used_step < ?)`,
  ).bind(step, jstNow(), staffId, step).run();
  return result.meta.changes === 1;
}
