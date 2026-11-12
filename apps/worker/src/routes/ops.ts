import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { jstMonthStart as japanMonthStart } from '@line-crm/shared';
import type { TenantStatus, TenantListRow } from './ops-tenant-types.js';
import { adminSessionTokenHashFromRequest } from '../middleware/auth.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { opsTenantMetrics } from '../services/ops-tenant-metrics.js';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  countActivePlatformAdmins,
  countImpersonationsSince,
  createPlatformAdmin,
  createStaffMember,
  getPlatformAdminRecord,
  endImpersonation,
  getActiveImpersonation,
  getPlatformAdminByStaffId,
  getStaffById,
  listPlatformAdminMembers,
  listPlatformAudit,
  PLATFORM_AUDIT_ACTIONS,
  recordPlatformAudit,
  revealPiiForImpersonation,
  setPlatformAdminActive,
  startImpersonation,
  switchImpersonationToRead,
  switchImpersonationToWrite,
  upsertPlatformAdminInvite,
  type PlatformAuditAction,
} from '@line-crm/db';

import type { Env } from '../worker-env.js';
import { requirePlatformAdmin, requirePlatformAdminWrite } from '../middleware/platform-admin.js';
import { toImpersonationContext } from '../middleware/impersonation.js';
import { clientIp, randomToken } from '../services/admin-session.js';
import { sha256Hex } from '../middleware/auth.js';
import { OPS_INVITE_TTL_MS, sendOpsInviteMail } from '../services/ops-invite-mail.js';
import { dbFor } from '../services/db-router.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { parseFeaturePacks } from './tenants.js';

/**
 * 運営コンソール（★37 マスター）の API。すべて運営マスターだけが呼べる。
 *
 * ここでは統括（tenants）をまたいで読む。tenantScopeMiddleware は LINE アカウント
 * query しか見ないので、この下の各ルートで統括 ID を必ず検証する。
 */
export const ops = new Hono<Env>();

ops.use('/api/ops/*', requirePlatformAdmin());
const TENANT_STATUSES = new Set<TenantStatus>(['active', 'suspended', 'archived']);

function reasonFrom(body: unknown): string | null {
  const reason = (body as { reason?: unknown } | null)?.reason;
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  if (trimmed.length < 4 || trimmed.length > 500) return null;
  return trimmed;
}

/** 招待メールに書く URL（★37-10-A）。トークンは # の後ろに置き、サーバーのログに残さない。 */
function opsInviteUrl(c: Context<Env>, token: string): string {
  const base = (c.env.ADMIN_PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/+$/, '');
  return `${base}/ops/invite#${new URLSearchParams({ invite: token }).toString()}`;
}

async function tenantById(c: Context<Env>, id: string) {
  return dbFor(c.env)
    .prepare(`SELECT id, name, status, feature_packs, plan_key, plan_status, trial_ends_at,
                     current_period_ends_at, created_at, updated_at
              FROM tenants WHERE id = ?`)
    .bind(id)
    .first<Omit<TenantListRow, 'account_count' | 'staff_count' | 'last_login_at'>>();
}

// ---------------------------------------------------------------------------
// 自分
// ---------------------------------------------------------------------------

ops.get('/api/ops/me', async (c) => {
  const staff = c.get('staff');
  const db = dbFor(c.env);
  const admin = await getPlatformAdminByStaffId(db, staff.id);
  const row = await getStaffById(db, staff.id);
  const session = await getActiveImpersonation(db, staff.id, await adminSessionTokenHashFromRequest(c));
  // 帯に「◯◯ として閲覧中」と出すため、契約先の名前も一緒に返す。
  const impersonatedTenant = session ? await tenantById(c, session.tenant_id) : null;
  return c.json({
    success: true,
    data: {
      id: staff.id,
      name: staff.name,
      email: row?.email ?? null,
      readOnly: staff.readOnly,
      totpEnabled: Boolean(row?.totp_enabled_at),
      lineLinked: Boolean(row?.line_user_id),
      // platform_admins に無い＝互換判定で通っている。画面に注意を出す。
      legacy: !admin,
      impersonation: session ? { ...toImpersonationContext(session), tenantName: impersonatedTenant?.name ?? null } : null,
    },
  });
});

// ---------------------------------------------------------------------------
// 契約先アカウント（37-3 / 37-4）
// ---------------------------------------------------------------------------

ops.get('/api/ops/tenants', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const status = c.req.query('status');
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status && TENANT_STATUSES.has(status as TenantStatus)) { where.push('t.status = ?'); binds.push(status); }
  if (q) {
    where.push(`(t.name LIKE ? OR EXISTS (SELECT 1 FROM line_accounts la WHERE la.tenant_id = t.id AND la.name LIKE ?)
      OR EXISTS (SELECT 1 FROM staff_members sm WHERE sm.tenant_id = t.id AND (sm.email LIKE ? OR sm.name LIKE ?)))`);
    const like = `%${q}%`;
    binds.push(like, like, like, like);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const { results } = await dbFor(c.env)
    .prepare(
      `SELECT t.id, t.name, t.status, t.feature_packs, t.plan_key, t.plan_status, t.trial_ends_at,
              t.current_period_ends_at, t.created_at, t.updated_at,
              (SELECT COUNT(*) FROM line_accounts la WHERE la.tenant_id = t.id AND la.archived_at IS NULL) AS account_count,
              (SELECT COUNT(*) FROM staff_members sm WHERE sm.tenant_id = t.id AND sm.is_active = 1) AS staff_count,
              (SELECT MAX(l.created_at) FROM login_audit l JOIN staff_members s2 ON s2.id = l.admin_user_id
                 WHERE s2.tenant_id = t.id AND l.action = 'login') AS last_login_at
       FROM tenants t ${clause}
       ORDER BY t.created_at DESC, t.id ASC
       LIMIT 500`,
    )
    .bind(...binds)
    .all<TenantListRow>();
  const rows = results ?? [];
  const summary = {
    // 「契約中」は請求状態だけで数える（active ＋決済失敗の past_due は請求が
    // まだ生きている）。請求が解約・課金対象外のものを契約中に混ぜない
    // （監査 ：一覧・詳細・ダッシュボードで定義をそろえる）。
    active: rows.filter((r) => r.plan_status === 'active' || r.plan_status === 'past_due').length,
    trialing: rows.filter((r) => r.plan_status === 'trialing').length,
    suspended: rows.filter((r) => r.status === 'suspended').length,
    pastDue: rows.filter((r) => r.plan_status === 'past_due').length,
  };
  return c.json({
    success: true,
    data: rows.map(({ feature_packs, ...row }) => ({ ...row, featurePacks: safeParse(feature_packs) })),
    summary,
  });
});

ops.get('/api/ops/tenants/:id', async (c) => {
  const db = dbFor(c.env);
  const tenant = await tenantById(c, c.req.param('id'));
  if (!tenant) return c.json({ success: false, error: '契約先が見つかりません' }, 404);
  const accounts = await db
    .prepare(
      `SELECT la.id, la.name, la.is_active, la.archived_at, la.updated_at,
              (SELECT COUNT(*) FROM friends f WHERE f.line_account_id = la.id) AS friend_count
       FROM line_accounts la WHERE la.tenant_id = ? ORDER BY la.created_at ASC`,
    )
    .bind(tenant.id)
    .all<{ id: string; name: string; is_active: number; archived_at: string | null; updated_at: string; friend_count: number }>();
  const members = await db
    .prepare(
      `SELECT sm.id, sm.name, sm.email, sm.role, sm.access_level, sm.is_active, sm.invite_status,
              (SELECT MAX(l.created_at) FROM login_audit l WHERE l.admin_user_id = sm.id AND l.action = 'login') AS last_login_at
       FROM staff_members sm WHERE sm.tenant_id = ? ORDER BY sm.created_at ASC`,
    )
    .bind(tenant.id)
    .all<{ id: string; name: string; email: string | null; role: string; access_level: string; is_active: number; invite_status: string; last_login_at: string | null }>();
  const audit = await listPlatformAudit(db, { tenantId: tenant.id, limit: 20 });
  const lastLogin = await db
    .prepare(`SELECT MAX(l.created_at) AS last_login_at FROM login_audit l JOIN staff_members s2 ON s2.id = l.admin_user_id
              WHERE s2.tenant_id = ? AND l.action = 'login'`)
    .bind(tenant.id)
    .first<{ last_login_at: string | null }>();
  const { feature_packs, ...rest } = tenant;
  return c.json({
    success: true,
    data: {
      tenant: { ...rest, featurePacks: safeParse(feature_packs), last_login_at: lastLogin?.last_login_at ?? null },
      accounts: accounts.results ?? [],
      members: members.results ?? [],
      audit: audit.rows,
      metrics: await opsTenantMetrics(db,tenant.id),
    },
  });
});

ops.patch('/api/ops/tenants/:id/status', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const staff = c.get('staff');
  const db = dbFor(c.env);
  const tenant = await tenantById(c, c.req.param('id'));
  if (!tenant) return c.json({ success: false, error: '契約先が見つかりません' }, 404);
  const body = await c.req.json<{ status?: unknown; reason?: unknown; confirmName?: unknown }>().catch(() => null);
  const status = body?.status;
  if (typeof status !== 'string' || !TENANT_STATUSES.has(status as TenantStatus)) {
    return inputError(c, { success: false, error: '利用できない状態です' }, 400, ["status"]);
  }
  const reason = reasonFrom(body);
  if (!reason) return inputError(c, { success: false, error: '理由を4文字以上で入力してください' }, 400, ["reason"]);
  // 停止・アーカイブは契約先の名前を手で入力させる（要件 §3 37-4）。
  if (status !== 'active' && body?.confirmName !== tenant.name) {
    return inputError(c, { success: false, error: '確認のため、契約先の名前をそのまま入力してください' }, 400, ["status","confirmName"]);
  }
  await db
    .prepare(`UPDATE tenants SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') WHERE id = ?`)
    .bind(status, tenant.id)
    .run();
  await recordPlatformAudit(db, {
    staffId: staff.id,
    staffName: staff.name,
    tenantId: tenant.id,
    tenantName: tenant.name,
    action: 'tenant.status.change',
    reason,
    detail: { from: tenant.status, to: status },
    ip: clientIp(c),
    visibleToTenant: true,
  });
  return c.json({ success: true, data: { status } });
});

/**
 * 統括の機能パック（現在は「飲食店機能」= restaurant のみ）を切り替える。
 *
 * 停止・アーカイブと違い破壊的ではないため、確認ダイアログや理由入力は
 * 求めない（member.activate と同じ即時トグル）。監査だけは自動で残す。
 */
ops.patch('/api/ops/tenants/:id/feature-packs', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const staff = c.get('staff');
  const db = dbFor(c.env);
  const tenant = await tenantById(c, c.req.param('id'));
  if (!tenant) return c.json({ success: false, error: '契約先が見つかりません' }, 404);
  const body = await c.req.json<{ featurePacks?: unknown }>().catch(() => null);
  const featurePacks = parseFeaturePacks(body?.featurePacks);
  if (!featurePacks) {
    return inputError(c, { success: false, error: '利用できない機能パックが含まれています' }, 400, ["featurePacks"]);
  }
  await db
    .prepare(`UPDATE tenants SET feature_packs = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') WHERE id = ?`)
    .bind(JSON.stringify(featurePacks), tenant.id)
    .run();
  await recordPlatformAudit(db, {
    staffId: staff.id,
    staffName: staff.name,
    tenantId: tenant.id,
    tenantName: tenant.name,
    action: 'tenant.feature_packs.change',
    detail: { from: safeParse(tenant.feature_packs), to: featurePacks },
    ip: clientIp(c),
    visibleToTenant: true,
  });
  return c.json({ success: true, data: { featurePacks } });
});

// ---------------------------------------------------------------------------
// 代理ログイン（37-5）
// ---------------------------------------------------------------------------

ops.get('/api/ops/impersonation/current', async (c) => {
  const staff = c.get('staff');
  const session = await getActiveImpersonation(dbFor(c.env), staff.id, await adminSessionTokenHashFromRequest(c));
  if (!session) return c.json({ success: true, data: null });
  const tenant = await tenantById(c, session.tenant_id);
  return c.json({
    success: true,
    data: { ...toImpersonationContext(session), tenantName: tenant?.name ?? null },
  });
});

ops.post('/api/ops/impersonation/start', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const staff = c.get('staff');
  const db = dbFor(c.env);
  const body = await c.req.json<{ tenantId?: unknown }>().catch(() => null);
  const tenantId = typeof body?.tenantId === 'string' ? body.tenantId : '';
  const tenant = tenantId ? await tenantById(c, tenantId) : null;
  if (!tenant) return c.json({ success: false, error: '契約先が見つかりません' }, 404);
  if (tenant.status === 'archived') {
    return inputError(c, { success: false, error: 'アーカイブ済みの契約先には入れません' }, 400, ["tenantId"]);
  }
  const sessionTokenHash = await adminSessionTokenHashFromRequest(c);
  if (!sessionTokenHash) return c.json({ success: false, error: '代理ログインには本人のログインが必要です' }, 403);
  const session = await startImpersonation(db, { staffId: staff.id, tenantId: tenant.id, sessionTokenHash });
  // 閲覧だけの代理ログインは契約先には見せない（要件 §3 37-5）。運営側の記録にだけ残す。
  await recordPlatformAudit(db, {
    staffId: staff.id,
    staffName: staff.name,
    tenantId: tenant.id,
    tenantName: tenant.name,
    action: 'impersonation.start',
    detail: { sessionId: session.id },
    ip: clientIp(c),
    visibleToTenant: false,
  });
  return c.json({ success: true, data: { ...toImpersonationContext(session), tenantName: tenant.name } });
});

ops.post('/api/ops/impersonation/write', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const staff = c.get('staff');
  const db = dbFor(c.env);
  const body = await c.req.json().catch(() => null);
  const expected = body?.expectedSessionId;
  if (expected !== undefined && (typeof expected !== 'string' || !expected)) return inputError(c, { success: false, error: '確認対象が不正です' }, 400, ['expectedSessionId']);
  const session = await getActiveImpersonation(db, staff.id, await adminSessionTokenHashFromRequest(c));
  if (expected !== undefined && session?.id !== expected) return c.json({ success: false, error: '代理ログインが変わりました。読み直してから、もう一度選んでください' }, 409);
  if (!session) return inputError(c, { success: false, error: '代理ログイン中ではありません' }, 400, []);
  const reason = reasonFrom(body);
  if (!reason) return inputError(c, { success: false, error: '理由を4文字以上で入力してください' }, 400, ["reason"]);
  if (!await switchImpersonationToWrite(db, session.id, reason)) return c.json({ success: false, error: '代理ログインが変わりました。読み直してから、もう一度選んでください' }, 409);
  const tenant = await tenantById(c, session.tenant_id);
  // 書き込みに切り替えたら、契約先の画面にも履歴を残す（要件 §3 37-5）。
  await recordPlatformAudit(db, {
    staffId: staff.id,
    staffName: staff.name,
    tenantId: session.tenant_id,
    tenantName: tenant?.name ?? null,
    action: 'impersonation.write',
    reason,
    detail: { sessionId: session.id },
    ip: clientIp(c),
    visibleToTenant: true,
  });
  return c.json({ success: true, data: { ...toImpersonationContext({ ...session, mode: 'write', write_reason: reason }), tenantName: tenant?.name ?? null } });
});

ops.post('/api/ops/impersonation/read', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const staff = c.get('staff');
  const db = dbFor(c.env);
  const session = await getActiveImpersonation(db, staff.id, await adminSessionTokenHashFromRequest(c));
  if (!session) return inputError(c, { success: false, error: '代理ログイン中ではありません' }, 400, []);
  await switchImpersonationToRead(db, session.id);
  return c.json({ success: true, data: toImpersonationContext({ ...session, mode: 'read' }) });
});

ops.post('/api/ops/impersonation/pii-reveal', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const staff = c.get('staff');
  const db = dbFor(c.env);
  const body = await c.req.json().catch(() => null);
  const expected = body?.expectedSessionId;
  if (expected !== undefined && (typeof expected !== 'string' || !expected)) return inputError(c, { success: false, error: '確認対象が不正です' }, 400, ['expectedSessionId']);
  const session = await getActiveImpersonation(db, staff.id, await adminSessionTokenHashFromRequest(c));
  if (expected !== undefined && session?.id !== expected) return c.json({ success: false, error: '代理ログインが変わりました。読み直してから、もう一度選んでください' }, 409);
  if (!session) return inputError(c, { success: false, error: '代理ログイン中ではありません' }, 400, []);
  const reason = reasonFrom(body);
  if (!reason) return inputError(c, { success: false, error: '理由を4文字以上で入力してください' }, 400, ["reason"]);
  const revealed = await revealPiiForImpersonation(db, {
    impersonationSessionId: session.id,
    staffId: staff.id,
    tenantId: session.tenant_id,
    reason,
  });
  if (!revealed) return c.json({ success: false, error: '代理ログインが変わりました。読み直してから、もう一度選んでください' }, 409);
  const tenant = await tenantById(c, session.tenant_id);
  await recordPlatformAudit(db, {
    staffId: staff.id,
    staffName: staff.name,
    tenantId: session.tenant_id,
    tenantName: tenant?.name ?? null,
    action: 'pii.reveal',
    reason,
    detail: { sessionId: session.id },
    ip: clientIp(c),
    visibleToTenant: false,
  });
  return c.json({ success: true, data: toImpersonationContext({ ...session, pii_revealed: 1 }) });
});

ops.post('/api/ops/impersonation/end', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const staff = c.get('staff');
  const db = dbFor(c.env);
  const session = await getActiveImpersonation(db, staff.id, await adminSessionTokenHashFromRequest(c));
  if (!session) return c.json({ success: true, data: null });
  await endImpersonation(db, session.id);
  const tenant = await tenantById(c, session.tenant_id);
  await recordPlatformAudit(db, {
    staffId: staff.id,
    staffName: staff.name,
    tenantId: session.tenant_id,
    tenantName: tenant?.name ?? null,
    action: 'impersonation.end',
    detail: { sessionId: session.id, mode: session.mode },
    ip: clientIp(c),
    visibleToTenant: false,
  });
  return c.json({ success: true, data: null });
});

// ---------------------------------------------------------------------------
// 監査ログ（37-8）
// ---------------------------------------------------------------------------

ops.get('/api/ops/audit', async (c) => {
  const actionsRaw = (c.req.query('action') ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  const actions = actionsRaw.filter((a): a is PlatformAuditAction =>
    (PLATFORM_AUDIT_ACTIONS as readonly string[]).includes(a));
  const limit = parseOffsetPaging({ limit: c.req.query('limit') }, { defaultLimit: 50, limitPolicy: { format: 'integer-prefix' } }).limit || 50;
  const offset = parseOffsetPaging({ offset: c.req.query('offset') }, { offsetPolicy: { format: 'integer-prefix' } }).offset || 0;
  const result = await listPlatformAudit(dbFor(c.env), {
    tenantId: c.req.query('tenant_id') || null,
    actions,
    from: c.req.query('from') || null,
    to: c.req.query('to') || null,
    limit,
    offset,
  });
  const responseItems = result.rows;
  return c.json(buildOffsetListResponse({ success: true, data: responseItems, total: result.total, items: responseItems, paging: { limit: Math.min(500, Math.max(1, limit)), offset }, sort: [{ field: 'created_at', direction: 'desc' }] }));
});

// ---------------------------------------------------------------------------
// 運営メンバー（37-10）
// ---------------------------------------------------------------------------

ops.get('/api/ops/members', async (c) => {
  const db = dbFor(c.env);
  const members = await listPlatformAdminMembers(db);
  const monthly = await countImpersonationsSince(db, japanMonthStart());
  return c.json({
    success: true,
    data: members.map((m) => ({
      staffId: m.staff_id,
      name: m.name,
      email: m.email,
      // 停止・再開ボタンが操作するのは platform_admins.is_active。
      // 招待前の staff_members は意図的に inactive なので、両方を AND すると
      // 「招待中」が「停止」と誤表示され、招待の再送もできなくなる。
      isActive: m.is_active === 1,
      totpEnabled: Boolean(m.totp_enabled_at),
      lineLinked: Boolean(m.line_user_id),
      inviteStatus: m.invite_status,
      // 招待の進み具合（★37-10）: invited → awaiting_totp → active
      activationState: m.activation_state,
      invitedAt: m.invited_at,
      approvedBy: m.approved_by,
      lastLoginAt: m.last_login_at,
      createdAt: m.created_at,
    })),
    summary: {
      members: members.filter((m) => m.is_active === 1 && m.activation_state === 'active').length,
      invited: members.filter((m) => m.is_active === 1 && m.activation_state === 'invited').length,
      awaitingTotp: members.filter((m) => m.is_active === 1 && m.activation_state === 'awaiting_totp').length,
      totpEnabled: members.filter((m) => m.is_active === 1 && m.activation_state === 'active' && m.totp_enabled_at).length,
      impersonationsThisMonth: monthly.total,
      writeImpersonationsThisMonth: monthly.write,
      piiRevealsThisMonth: monthly.piiReveals,
    },
  });
});

/**
 * 運営メンバーを招待する（★37-10）。メールで招待 → パスワード設定 → 2要素認証の
 * 登録が終わって初めて運営マスターになる。
 *
 * - 新しいメール: 運営会社（既定の統括）の権限者として staff_members を作り、招待を送る
 * - 既定の統括に同じメールの権限者がいる: その人に招待を送る（LINE だけで入っていた人など）
 * - 別の統括にいるメール: メール招待では加えられない（Kenta / Kyohei は初期の特例で登録済み）
 * - 自分自身は加えられない。例外は最初の 1 人だけ（platform_admins が空の間の互換判定で
 *   入っている人が自分を登録して初期化する。要件 §6-2「登録 → 確認 → 旧判定を外す」）
 */
ops.post('/api/ops/members', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const staff = c.get('staff');
  const db = dbFor(c.env);
  const body = await c.req.json<{ staffId?: unknown; email?: unknown }>().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const selfBootstrap = typeof body?.staffId === 'string' && body.staffId === staff.id;

  // 最初の 1 人の自己登録（画面は自分のメールを入れる。staffId 指定でも同じ）
  const selfRow = await getStaffById(db, staff.id);
  const isSelfEmail = Boolean(email) && (selfRow?.email ?? '').toLowerCase() === email;
  if (selfBootstrap || isSelfEmail) {
    if ((await countActivePlatformAdmins(db)) > 0) {
      return inputError(c, { success: false, error: '自分自身を運営メンバーに加えることはできません。ほかの運営メンバーに依頼してください' }, 400, []);
    }
    await createPlatformAdmin(db, { staffId: staff.id, approvedBy: null });
    await recordPlatformAudit(db, {
      staffId: staff.id, staffName: staff.name, action: 'member.invite',
      detail: { targetStaffId: staff.id, targetName: staff.name, bootstrap: true }, ip: clientIp(c), visibleToTenant: false,
    });
    return c.json({ success: true, data: { staffId: staff.id, activationState: 'active' } }, 201);
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return inputError(c, { success: false, error: '正しいメールアドレスを入力してください' }, 400, ["email"]);
  }

  // 同じメールの権限者を探す（統括を問わず）。
  const existing = await db
    .prepare('SELECT * FROM staff_members WHERE lower(email) = lower(?) ORDER BY created_at ASC')
    .bind(email)
    .all<{ id: string; name: string; tenant_id: string | null; is_active: number }>();
  const rows = existing.results ?? [];
  const inDefault = rows.find((r) => (r.tenant_id ?? DEFAULT_TENANT_ID) === DEFAULT_TENANT_ID);
  if (!inDefault && rows.length > 0) {
    return c.json({ success: false, error: 'このメールアドレスは別の統括の権限者として登録されています。メールでの招待では加えられません' }, 409);
  }

  let targetId: string;
  let targetName: string;
  if (inDefault) {
    const record = await getPlatformAdminRecord(db, inDefault.id);
    if (record?.is_active === 1 && record.activation_state === 'active') {
      return c.json({ success: false, error: 'このメールアドレスはすでに運営メンバーです' }, 409);
    }
    targetId = inDefault.id;
    targetName = inDefault.name;
  } else {
    // 運営会社（既定の統括）の権限者として作る。名前とパスワードは本人が招待の画面で決める。
    const created = await createStaffMember(db, {
      name: email.split('@')[0] ?? email,
      email,
      role: 'staff',
      access_level: 'full',
      is_active: 0,
      invite_status: 'pending_email',
      tenant_id: DEFAULT_TENANT_ID,
    });
    targetId = created.id;
    targetName = created.name;
  }

  const token = randomToken();
  const expiresAt = new Date(Date.now() + OPS_INVITE_TTL_MS).toISOString();
  await upsertPlatformAdminInvite(db, { staffId: targetId, invitedBy: staff.id, tokenHash: await sha256Hex(token), email, expiresAt });
  try {
    await sendOpsInviteMail(c.env, {
      email,
      inviterName: staff.name,
      acceptUrl: opsInviteUrl(c, token),
      existingAccount: Boolean(inDefault),
    });
  } catch (error) {
    throw error;
  }
  await recordPlatformAudit(db, {
    staffId: staff.id, staffName: staff.name, action: 'member.invite',
    detail: { targetStaffId: targetId, targetName, email }, ip: clientIp(c), visibleToTenant: false,
  });
  return c.json({ success: true, data: { staffId: targetId, activationState: 'invited' } }, 201);
});

/** 招待メールを送り直す（招待中・2要素認証待ちの人だけ）。 */
ops.post('/api/ops/members/:staffId/resend-invite', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const staff = c.get('staff');
  const db = dbFor(c.env);
  const targetId = c.req.param('staffId');
  const target = await getStaffById(db, targetId);
  const record = await getPlatformAdminRecord(db, targetId);
  if (!target?.email || !record || record.is_active !== 1) return c.json({ success: false, error: '対象の招待が見つかりません' }, 404);
  if (record.activation_state === 'active') return inputError(c, { success: false, error: 'この人は登録が完了しています' }, 400, []);
  const token = randomToken();
  const expiresAt = new Date(Date.now() + OPS_INVITE_TTL_MS).toISOString();
  await upsertPlatformAdminInvite(db, { staffId: targetId, invitedBy: staff.id, tokenHash: await sha256Hex(token), email: target.email, expiresAt });
  try {
    await sendOpsInviteMail(c.env, {
      email: target.email,
      inviterName: staff.name,
      acceptUrl: opsInviteUrl(c, token),
      existingAccount: Boolean(target.password_hash),
    });
  } catch (error) {
    throw error;
  }
  return c.json({ success: true, data: { staffId: targetId, activationState: 'invited' } });
});

ops.patch('/api/ops/members/:staffId', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const staff = c.get('staff');
  const db = dbFor(c.env);
  const targetId = c.req.param('staffId');
  const body = await c.req.json<{ isActive?: unknown }>().catch(() => null);
  if (typeof body?.isActive !== 'boolean') return inputError(c, { success: false, error: 'isActive を指定してください' }, 400, ["isActive"]);
  if (targetId === staff.id) return inputError(c, { success: false, error: '自分自身の運営権限は変えられません' }, 400, []);
  if (!body.isActive) {
    const active = await countActivePlatformAdmins(db);
    if (active <= 1) return inputError(c, { success: false, error: '最後の運営メンバーは停止できません' }, 400, []);
  }
  const target = await getStaffById(db, targetId);
  if (!target) return c.json({ success: false, error: '対象の権限者が見つかりません' }, 404);
  await setPlatformAdminActive(db, targetId, body.isActive);
  await recordPlatformAudit(db, {
    staffId: staff.id,
    staffName: staff.name,
    action: body.isActive ? 'member.activate' : 'member.deactivate',
    detail: { targetStaffId: targetId, targetName: target.name },
    ip: clientIp(c),
    visibleToTenant: false,
  });
  return c.json({ success: true, data: { staffId: targetId, isActive: body.isActive } });
});

function safeParse(value: string): unknown {
  try { return JSON.parse(value); } catch { return []; }
}

// ---------------------------------------------------------------------------
// 契約先（統括）から見える運営の操作履歴。書き込みを伴ったものだけ。
// /api/ops/* の門番は掛からない（統括の権限者が呼ぶ）。
// ---------------------------------------------------------------------------

ops.get('/api/hq/operator-history', async (c) => {
  const staff = c.get('staff');
  if (!staff.tenantId) return c.json({ success: true, data: [] });
  const result = await listPlatformAudit(dbFor(c.env), {
    tenantId: staff.tenantId,
    visibleOnly: true,
    limit: 50,
  });
  return c.json({
    success: true,
    data: result.rows.map((row) => ({
      id: row.id,
      action: row.action,
      operatorName: row.staff_name,
      reason: row.reason,
      createdAt: row.created_at,
    })),
  });
});
