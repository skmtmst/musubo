import { Hono } from 'hono';
import { fail } from '../lib/fail.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { isHqBusinessOperation } from '../middleware/hq-role-policy.js';
import { denyReadOnly, requireRole } from '../middleware/role-guard.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { getFollowerImportState } from '../services/follower-import.js';
import { getLineRegistrationReceipt } from '../services/line-registration-receipt.js';
import type { Env } from '../worker-env.js';
import { getAuthorizedLineAccount, getVisibleLineAccountEntry } from './line-account-access.js';

export const lineRegistration = new Hono<Env>();

// 他のブラウザーを使った場合も、本人が始めた未完了の登録だけを探す。
lineRegistration.get('/api/line-accounts/registration-resume', requireRole('owner', 'admin'), denyReadOnly(), async (c) => {
  c.header('Cache-Control', 'no-store');
  const channelId = c.req.query('channel_id')?.trim() ?? '';
  if (!/^\d{1,32}$/.test(channelId)) return fail(c, 422, 'Messaging APIのチャネルIDを確認してください。');
  const staff = c.get('staff');
  const account = await c.env.DB.prepare(
    `SELECT a.id
       FROM line_accounts a
       JOIN account_styles s ON s.line_account_id = a.id
      WHERE a.channel_id = ? AND a.created_by_staff_id = ?
        AND COALESCE(a.tenant_id, ?) = ?
        AND a.is_active = 1 AND a.archived_at IS NULL
        AND s.selected_at IS NULL AND s.selection_mode = 'later'
        AND json_extract(s.answers_json, '$.style.selectionPending') = 1`,
  ).bind(channelId, staff.id, DEFAULT_TENANT_ID, staff.tenantId ?? DEFAULT_TENANT_ID).first<{ id: string }>();
  if (!account) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  const scope = await getVisibleLineAccountScope(c.env.DB, staff);
  if (scope.isAccountScoped || !scope.ids.includes(account.id)) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  return c.json({ success: true, data: { accountId: account.id } });
});

// 登録アカウントの署名付き受信記録だけで、設定の完了を確認する。
lineRegistration.get('/api/line-accounts/:id/registration-receipt', requireRole('owner', 'admin'), async (c) => {
  c.header('Cache-Control', 'no-store');
  const account = await getAuthorizedLineAccount(c, c.req.param('id'));
  const actorId = c.get('staff').id;
  if (!account || account.archived_at || (account.created_by_staff_id && account.created_by_staff_id !== actorId)) {
    return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  }
  if (!account.is_active) {
    return fail(c, 409, 'LINEアカウントが停止中です。', { code: 'LINE_ACCOUNT_INACTIVE' });
  }
  return c.json({ success: true, data: await getLineRegistrationReceipt(c.env.DB, account.id) });
});


// 友だちの引き継ぎ状態と、管理画面に入る前の登録確認を同じアカウント境界で扱う。
lineRegistration.get('/api/line-accounts/:id/follower-import', async (c) => {
  const id = c.req.param('id');
  if (!await getVisibleLineAccountEntry(c, id)) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');

  if (c.req.query('entry') !== '1') {
    const state = await getFollowerImportState(c.env.DB, id);
    return c.json({ success: true, data: state });
  }

  c.header('Cache-Control', 'no-store');
  const staff = c.get('staff');
  const row = await c.env.DB.prepare(
    `SELECT a.is_active, a.archived_at, a.created_by_staff_id,
            CASE WHEN s.selected_at IS NULL AND s.selection_mode = 'later' AND json_valid(s.answers_json)
                 THEN json_extract(s.answers_json, '$.style.selectionPending') END AS selection_pending,
            (SELECT p.status FROM musubo_pending_additions p
              WHERE p.line_account_id = a.id AND p.kind = 'line' AND p.tenant_id = COALESCE(a.tenant_id, ?)
              ORDER BY p.created_at DESC, p.id DESC LIMIT 1) AS addition_status
       FROM line_accounts a
       LEFT JOIN account_styles s ON s.line_account_id = a.id
      WHERE a.id = ? AND COALESCE(a.tenant_id, ?) = ?`,
  ).bind(DEFAULT_TENANT_ID, id, DEFAULT_TENANT_ID, staff.tenantId ?? DEFAULT_TENANT_ID).first<{
    is_active: number;
    archived_at: string | null;
    created_by_staff_id: string | null;
    selection_pending: number | null;
    addition_status: string | null;
  }>();
  if (!row || row.archived_at) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');

  const scope = await getVisibleLineAccountScope(c.env.DB, staff);
  const manager = staff.role === 'owner' || staff.role === 'admin';
  const canManage = !staff.readOnly && (manager ||
    (staff.hqRole === 'operator' && isHqBusinessOperation(c.req.method, c.req.path, staff.id)));
  const ownsRegistration = row.created_by_staff_id === staff.id && !scope.isAccountScoped && canManage;
  const canResume = ownsRegistration && Boolean(row.is_active);
  if (row.addition_status && row.addition_status !== 'activated') {
    return c.json({ success: true, data: { destination: ownsRegistration && manager ? 'billing' : 'unavailable', canResume: false } });
  }
  if (row.created_by_staff_id && row.selection_pending === 1) {
    return c.json({ success: true, data: { destination: canResume ? 'registration' : 'unavailable', canResume } });
  }

  const state = canManage && row.is_active ? await getFollowerImportState(c.env.DB, id) : null;
  const handover = state?.phase === 'importing_ids' || state?.phase === 'hydrating_profiles';
  return c.json({ success: true, data: { destination: handover ? 'handover' : 'dashboard', canResume } });
});
