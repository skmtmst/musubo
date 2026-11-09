import { jstNow } from './utils.js';

/**
 * 運営（musubo 提供元）の階層。★37 マスター（運営）コンソール。
 *
 * 運営マスターは staff_members の行を持ち、ログイン・2要素認証・LINE ログインは
 * 既存の仕組みをそのまま使う。「運営マスターかどうか」だけを platform_admins で判定する。
 * 顧客の統括（tenants）とは別の器に置き、監査で運営の操作と顧客の操作を分ける。
 */

export type PlatformAdminActivationState = 'invited' | 'awaiting_totp' | 'active';

export interface PlatformAdmin {
  staff_id: string;
  is_active: number;
  approved_by: string | null;
  /** 招待の進み具合（★37-10）。active だけが運営マスターとして扱われる。 */
  activation_state: PlatformAdminActivationState;
  invited_by: string | null;
  invited_at: string | null;
  activated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlatformAdminInvite {
  id: string;
  staff_id: string;
  email: string;
  token_hash: string;
  invited_by: string | null;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

export interface PlatformAdminMember extends PlatformAdmin {
  name: string;
  email: string | null;
  line_user_id: string | null;
  totp_enabled_at: string | null;
  invite_status: string;
  staff_is_active: number;
  last_login_at: string | null;
}

/** 登録が完了して有効な運営マスターだけを返す。招待中・2要素認証待ちは null。 */
export async function getPlatformAdminByStaffId(
  db: D1Database,
  staffId: string,
): Promise<PlatformAdmin | null> {
  return db
    .prepare(`SELECT * FROM platform_admins WHERE staff_id = ? AND is_active = 1 AND activation_state = 'active'`)
    .bind(staffId)
    .first<PlatformAdmin>();
}

/** 状態を問わず platform_admins の行を返す（招待の進み具合を見るため）。 */
export async function getPlatformAdminRecord(
  db: D1Database,
  staffId: string,
): Promise<PlatformAdmin | null> {
  return db
    .prepare('SELECT * FROM platform_admins WHERE staff_id = ?')
    .bind(staffId)
    .first<PlatformAdmin>();
}

export async function listPlatformAdminMembers(db: D1Database): Promise<PlatformAdminMember[]> {
  const { results } = await db
    .prepare(
      `SELECT pa.*, sm.name, sm.email, sm.line_user_id, sm.totp_enabled_at, sm.invite_status,
              sm.is_active AS staff_is_active,
              (SELECT MAX(created_at) FROM login_audit la WHERE la.admin_user_id = sm.id AND la.action = 'login') AS last_login_at
       FROM platform_admins pa
       JOIN staff_members sm ON sm.id = pa.staff_id
       ORDER BY pa.created_at ASC`,
    )
    .all<PlatformAdminMember>();
  return results ?? [];
}

export async function countActivePlatformAdmins(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM platform_admins WHERE is_active = 1 AND activation_state = 'active'`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/** 登録完了の行を作る（最初の 1 人の自己登録など）。 */
export async function createPlatformAdmin(
  db: D1Database,
  input: { staffId: string; approvedBy: string | null },
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO platform_admins (staff_id, is_active, approved_by, activation_state, activated_at, created_at, updated_at)
       VALUES (?, 1, ?, 'active', ?, ?, ?)
       ON CONFLICT(staff_id) DO UPDATE SET is_active = 1, approved_by = excluded.approved_by,
         activation_state = 'active', activated_at = excluded.activated_at, updated_at = excluded.updated_at`,
    )
    .bind(input.staffId, input.approvedBy, now, now, now)
    .run();
}

/**
 * 招待の行を作る（★37-10）。既に招待中・2要素認証待ちの行があれば招待し直し。
 * 登録完了（active）の行は触らない（呼び出し側で先に断る）。
 */
export async function upsertPlatformAdminInvite(
  db: D1Database,
  input: { staffId: string; invitedBy: string; tokenHash: string; email: string; expiresAt: string },
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO platform_admins (staff_id, is_active, approved_by, activation_state, invited_by, invited_at, created_at, updated_at)
       VALUES (?, 1, ?, 'invited', ?, ?, ?, ?)
       ON CONFLICT(staff_id) DO UPDATE SET is_active = 1, invited_by = excluded.invited_by, invited_at = excluded.invited_at,
         activation_state = CASE WHEN platform_admins.activation_state = 'active' THEN 'active' ELSE 'invited' END,
         updated_at = excluded.updated_at`,
    )
    .bind(input.staffId, input.invitedBy, input.invitedBy, now, now, now)
    .run();
  // 前の招待リンクは失効させる（生き残るのは最後に送った 1 つだけ）
  await db
    .prepare('UPDATE platform_admin_invites SET consumed_at = ? WHERE staff_id = ? AND consumed_at IS NULL')
    .bind(now, input.staffId)
    .run();
  await db
    .prepare(
      `INSERT INTO platform_admin_invites (id, staff_id, email, token_hash, invited_by, expires_at, consumed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(crypto.randomUUID(), input.staffId, input.email, input.tokenHash, input.invitedBy, input.expiresAt, now)
    .run();
}

export async function getPlatformAdminInviteByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<PlatformAdminInvite | null> {
  return db
    .prepare('SELECT * FROM platform_admin_invites WHERE token_hash = ?')
    .bind(tokenHash)
    .first<PlatformAdminInvite>();
}

export async function consumePlatformAdminInvite(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare('UPDATE platform_admin_invites SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
    .bind(jstNow(), id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** 招待の進み具合を進める。active にするときは activated_at も入れる。 */
export async function setPlatformAdminActivationState(
  db: D1Database,
  staffId: string,
  state: PlatformAdminActivationState,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE platform_admins SET activation_state = ?, activated_at = CASE WHEN ? = 'active' THEN ? ELSE activated_at END, updated_at = ?
       WHERE staff_id = ?`,
    )
    .bind(state, state, now, now, staffId)
    .run();
}

/**
 * 2要素認証の登録が終わったら呼ぶ。2要素認証待ちの行だけを登録完了にする。
 * 戻り値は「完了に変えたか」。
 */
export async function activatePlatformAdminIfAwaitingTotp(db: D1Database, staffId: string): Promise<boolean> {
  const now = jstNow();
  const result = await db
    .prepare(
      `UPDATE platform_admins SET activation_state = 'active', activated_at = ?, updated_at = ?
       WHERE staff_id = ? AND activation_state = 'awaiting_totp'`,
    )
    .bind(now, now, staffId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function setPlatformAdminActive(
  db: D1Database,
  staffId: string,
  isActive: boolean,
): Promise<void> {
  await db
    .prepare('UPDATE platform_admins SET is_active = ?, updated_at = ? WHERE staff_id = ?')
    .bind(isActive ? 1 : 0, jstNow(), staffId)
    .run();
}

// ---------------------------------------------------------------------------
// 監査ログ
// ---------------------------------------------------------------------------

export const PLATFORM_AUDIT_ACTIONS = [
  'application.contact',
  'application.approve',
  'application.invite',
  'pricing_condition.create',
  'pricing_condition.revise',
  'individual_quote.create',
  'individual_quote.update',
  'individual_quote.send',
  'tenant.create',
  'tenant.status.change',
  'tenant.feature_packs.change',
  'impersonation.start',
  'impersonation.write',
  'impersonation.end',
  'pii.reveal',
  'ticket.view',
  'ticket.reply',
  'ticket.stage.change',
  'ticket.create',
  'knowledge.update',
  'knowledge.status',
  'knowledge.feedback',
  'ai.article_suggest',
  'announcement.create',
  'announcement.send',
  'announcement.delete',
  'notice_line_account.change',
  'billing.sync',
  'member.invite',
  'member.deactivate',
  'member.activate',
] as const;
export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

export interface PlatformAuditLog {
  id: string;
  staff_id: string;
  staff_name: string;
  tenant_id: string | null;
  tenant_name: string | null;
  action: PlatformAuditAction;
  reason: string | null;
  detail: string;
  ip: string | null;
  visible_to_tenant: number;
  created_at: string;
}

export async function recordPlatformAudit(
  db: D1Database,
  input: {
    staffId: string;
    staffName: string;
    tenantId?: string | null;
    tenantName?: string | null;
    action: PlatformAuditAction;
    reason?: string | null;
    detail?: Record<string, unknown>;
    ip?: string | null;
    /** 契約先の画面に見せるか。書き込みを伴う操作だけ true。 */
    visibleToTenant: boolean;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO platform_audit_logs
         (id, staff_id, staff_name, tenant_id, tenant_name, action, reason, detail, ip, visible_to_tenant, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.staffId,
      input.staffName,
      input.tenantId ?? null,
      input.tenantName ?? null,
      input.action,
      input.reason ?? null,
      JSON.stringify(input.detail ?? {}),
      input.ip ?? null,
      input.visibleToTenant ? 1 : 0,
      jstNow(),
    )
    .run();
  return id;
}

export async function listPlatformAudit(
  db: D1Database,
  filter: {
    tenantId?: string | null;
    actions?: PlatformAuditAction[];
    from?: string | null;
    to?: string | null;
    /** 契約先の画面から見るときは true（visible_to_tenant = 1 だけ）。 */
    visibleOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: PlatformAuditLog[]; total: number }> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filter.tenantId) { where.push('tenant_id = ?'); binds.push(filter.tenantId); }
  if (filter.actions && filter.actions.length > 0) {
    where.push(`action IN (${filter.actions.map(() => '?').join(', ')})`);
    binds.push(...filter.actions);
  }
  if (filter.from) { where.push('created_at >= ?'); binds.push(filter.from); }
  if (filter.to) { where.push('created_at <= ?'); binds.push(filter.to); }
  if (filter.visibleOnly) where.push('visible_to_tenant = 1');
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS count FROM platform_audit_logs ${clause}`)
    .bind(...binds)
    .first<{ count: number }>();
  const { results } = await db
    .prepare(`SELECT * FROM platform_audit_logs ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all<PlatformAuditLog>();
  return { rows: results ?? [], total: totalRow?.count ?? 0 };
}

// ---------------------------------------------------------------------------
// 代理ログイン
// ---------------------------------------------------------------------------

export type ImpersonationMode = 'read' | 'write';

export interface ImpersonationSession {
  id: string;
  staff_id: string;
  tenant_id: string;
  mode: ImpersonationMode;
  write_reason: string | null;
  pii_revealed: number;
  started_at: string;
  write_started_at: string | null;
  ended_at: string | null;
}

export async function getActiveImpersonation(
  db: D1Database,
  staffId: string,
  sessionTokenHash?: string | null,
): Promise<ImpersonationSession | null> {
  const results = await db.batch<ImpersonationSession>([
    db.prepare(`UPDATE impersonation_sessions SET ended_at=? WHERE staff_id=? AND ended_at IS NULL
    AND (julianday(started_at)<=julianday('now','-1 hour') OR NOT EXISTS
      (SELECT 1 FROM platform_settings p JOIN admin_sessions s ON s.token_hash=p.value
        WHERE p.key='auth.impersonation.session:'||impersonation_sessions.id AND s.staff_id=impersonation_sessions.staff_id
          AND julianday(s.expires_at)>julianday('now')))`).bind(jstNow(), staffId),
    db.prepare(
      `SELECT i.*, CASE WHEN i.pii_revealed=1 AND EXISTS
         (SELECT 1 FROM pii_reveal_logs r WHERE r.impersonation_session_id=i.id AND r.staff_id=i.staff_id
           AND r.tenant_id=i.tenant_id AND length(trim(r.reason))>=4) THEN 1 ELSE 0 END AS pii_revealed
       FROM impersonation_sessions i
       WHERE staff_id = ? AND ended_at IS NULL AND julianday(started_at)>julianday('now','-1 hour')
         AND EXISTS(SELECT 1 FROM platform_settings p JOIN admin_sessions s ON s.token_hash=p.value
             WHERE p.key='auth.impersonation.session:'||i.id AND s.staff_id=i.staff_id AND julianday(s.expires_at)>julianday('now')
               AND (?=1 OR p.value=?))
       ORDER BY started_at DESC LIMIT 1`,
    )
    .bind(staffId, sessionTokenHash === undefined ? 1 : 0, sessionTokenHash ?? null)
  ]);
  return results[1]!.results[0] ?? null;
}

/** 既に有効なものがあれば先に終える。運営マスター 1 人につき同時に 1 件だけ。 */
export async function startImpersonation(
  db: D1Database,
  input: { staffId: string; tenantId: string; sessionTokenHash: string },
): Promise<ImpersonationSession> {
  const now = jstNow();
  await db
    .prepare('UPDATE impersonation_sessions SET ended_at = ? WHERE staff_id = ? AND ended_at IS NULL')
    .bind(now, input.staffId)
    .run();
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO impersonation_sessions (id, staff_id, tenant_id, mode, pii_revealed, started_at)
       VALUES (?, ?, ?, 'read', 0, ?)`,
    )
    .bind(id, input.staffId, input.tenantId, now)
    .run();
  if (input.sessionTokenHash) await db.prepare('INSERT INTO platform_settings(key,value,updated_by,updated_at) VALUES (?,?,?,?)')
    .bind(`auth.impersonation.session:${id}`, input.sessionTokenHash, input.staffId, now).run();
  return {
    id,
    staff_id: input.staffId,
    tenant_id: input.tenantId,
    mode: 'read',
    write_reason: null,
    pii_revealed: 0,
    started_at: now,
    write_started_at: null,
    ended_at: null,
  };
}

export async function switchImpersonationToWrite(
  db: D1Database,
  id: string,
  reason: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE impersonation_sessions
       SET mode = 'write', write_reason = ?, write_started_at = ?
       WHERE id = ? AND ended_at IS NULL`,
    )
    .bind(reason, jstNow(), id)
    .run();
}

export async function switchImpersonationToRead(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE impersonation_sessions SET mode = 'read' WHERE id = ? AND ended_at IS NULL`)
    .bind(id)
    .run();
}

export async function endImpersonation(db: D1Database, id: string): Promise<void> {
  await db
    .prepare('UPDATE impersonation_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL')
    .bind(jstNow(), id)
    .run();
}

export async function revealPiiForImpersonation(
  db: D1Database,
  input: { impersonationSessionId: string; staffId: string; tenantId: string; reason: string },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db.batch([
    db
      .prepare('UPDATE impersonation_sessions SET pii_revealed = 1 WHERE id = ? AND ended_at IS NULL')
      .bind(input.impersonationSessionId),
    db
      .prepare(
        `INSERT INTO pii_reveal_logs (id, impersonation_session_id, staff_id, tenant_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, input.impersonationSessionId, input.staffId, input.tenantId, input.reason, now),
  ]);
  return id;
}

export async function countImpersonationsSince(
  db: D1Database,
  since: string,
): Promise<{ total: number; write: number; piiReveals: number }> {
  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN mode = 'write' THEN 1 ELSE 0 END) AS write
       FROM impersonation_sessions WHERE started_at >= ?`,
    )
    .bind(since)
    .first<{ total: number; write: number | null }>();
  const reveals = await db
    .prepare('SELECT COUNT(*) AS count FROM pii_reveal_logs WHERE created_at >= ?')
    .bind(since)
    .first<{ count: number }>();
  return {
    total: totals?.total ?? 0,
    write: totals?.write ?? 0,
    piiReveals: reveals?.count ?? 0,
  };
}
