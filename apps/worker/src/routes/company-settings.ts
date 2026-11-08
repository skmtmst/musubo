import { UnexpectedRouteError } from '../lib/unhandled-error.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';
import { getCompanySettings, getStaffById, isCompanyLogo, saveCompanySettings } from '@line-crm/db';
import type { CompanySettingsInput } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { dbFor } from '../services/db-router.js';

export const companySettings = new Hono<Env>();
companySettings.onError((_error, c) => {
  throw new UnexpectedRouteError(c, { success: false, code: 'UNAVAILABLE', error: '会社の設定を確認できません。再確認してください' });
});
companySettings.use('/api/settings/company', async (c, next) => {
  const staff = c.get('staff');
  if (!staff?.tenantId) return c.json({ success: false, code: 'FORBIDDEN', error: '所属する会社を確認できません' }, 403);
  const member = await getStaffById(dbFor(c.env), staff.id);
  if (!member || member.is_active !== 1 || member.tenant_id !== staff.tenantId
    || member.account_scope !== 'all') {
    return c.json({ success: false, code: 'FORBIDDEN', error: '所属する会社を確認できません' }, 403);
  }
  if (c.req.method === 'PUT' && (staff.readOnly || member.access_level === 'read_only'
    || (!['owner', 'admin'].includes(member.role) && staff.hqRole !== 'operator'))) {
    return c.json({ success: false, code: 'FORBIDDEN', error: '会社全体の編集権限が必要です' }, 403);
  }
  await next();
});
companySettings.get('/api/settings/company', async c => {
  const data = await getCompanySettings(dbFor(c.env), c.get('staff')!.tenantId!);
  return data ? c.json({ success: true, data })
    : c.json({ success: false, code: 'NOT_FOUND', error: '会社が見つかりません' }, 404);
});
companySettings.put('/api/settings/company', requireRole('owner', 'admin'), inputJsonBoundary(), async c => {
  let value: unknown;
  try { value = await c.req.json(); } catch { value = null; }
  const input = value as CompanySettingsInput | null;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.companyName !== 'string' || !input.companyName.trim() || input.companyName.length > 200
    || typeof input.loginDisplayName !== 'string' || !input.loginDisplayName.trim() || input.loginDisplayName.length > 200
    || !(input.logoMediaId === null || (typeof input.logoMediaId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input.logoMediaId)))
    || typeof input.logoBackgroundColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(input.logoBackgroundColor)
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    return inputError(c, { success: false, code: 'INVALID_INPUT', error: '会社名・表示名・画像・色・版の指定を確認してください' }, 400, ["companyName","loginDisplayName","logoMediaId","logoBackgroundColor","expectedVersion"]);
  }
  const db = dbFor(c.env), staff = c.get('staff')!, tenantId = staff.tenantId!;
  if (input.logoMediaId && !await isCompanyLogo(db, tenantId, input.logoMediaId)) {
    return inputError(c, { success: false, code: 'INVALID_LOGO', error: 'この会社に登録された公開済みの画像を選んでください' }, 422, ["logoMediaId"]);
  }
  const data = await saveCompanySettings(db, tenantId, staff.id, staff.role as 'owner' | 'admin', {
    ...input, companyName: input.companyName.trim(), loginDisplayName: input.loginDisplayName.trim(),
    logoBackgroundColor: input.logoBackgroundColor.toLowerCase(),
  });
  if (!data) return c.json({ success: false, code: 'VERSION_CONFLICT', error: '編集がありました。最新版を読み直してください' }, 409);
  c.set('auditRecorded', true);
  return c.json({ success: true, data });
});
