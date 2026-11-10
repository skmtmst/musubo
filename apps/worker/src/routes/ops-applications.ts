import { Hono, type Context } from 'hono';
import {
  consumeOtherSignupTokens, createAuthEmailToken, getRegistrationApplication, listRegistrationApplications,
  approveRegistrationWithMusuboCondition, markRegistrationApplicationContacted,
  markRegistrationApplicationInviteSent, recordPlatformAudit, toJstString,
} from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { requirePlatformAdmin, requirePlatformAdminWrite } from '../middleware/platform-admin.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { clientIp, randomToken } from '../services/admin-session.js';
import { sha256Hex } from '../middleware/auth.js';
import { sendSignupVerifyMail, SIGNUP_TOKEN_TTL_MS } from '../services/auth-mail.js';
import { dbFor } from '../services/db-router.js';
import { logger } from '@line-crm/shared/server';

export const opsApplications = new Hono<Env>();
opsApplications.use('/api/ops/applications/*', requirePlatformAdmin());
opsApplications.use('/api/ops/applications', requirePlatformAdmin());

opsApplications.get('/api/ops/applications', async (c) => {
  const rows = await listRegistrationApplications(dbFor(c.env));
  return c.json({ success: true, data: rows });
});

opsApplications.get('/api/ops/applications/:id', async (c) => {
  const row = await getRegistrationApplication(dbFor(c.env), c.req.param('id'));
  return row ? c.json({ success: true, data: row })
    : c.json({ success: false, error: '申込が見つかりません' }, 404);
});

opsApplications.post('/api/ops/applications/:id/contact', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const body = await c.req.json<{ note?: unknown }>().catch(() => null);
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  if (!note || note.length > 2000) return c.json({ success: false, error: '連絡メモを1〜2000文字で入力してください' }, 400);
  const staff = c.get('staff');
  const db = dbFor(c.env);
  if (!await markRegistrationApplicationContacted(db, c.req.param('id'), staff.id, note)) {
    return c.json({ success: false, error: '申込の状態が変わりました。読み直してください' }, 409);
  }
  const row = (await getRegistrationApplication(db, c.req.param('id')))!;
  await recordPlatformAudit(db, { staffId: staff.id, staffName: staff.name,
    action: 'application.contact', detail: { applicationId: row.id },
    ip: clientIp(c), visibleToTenant: false });
  return c.json({ success: true, data: row });
});

async function sendInvite(c: Context<Env>, id: string): Promise<boolean> {
  const db = dbFor(c.env);
  const row = await getRegistrationApplication(db, id);
  if (!row || row.status !== 'approved') return false;
  const base = c.env.ADMIN_PUBLIC_URL?.replace(/\/+$/, '');
  if (!base) throw new Error('ADMIN_PUBLIC_URL not configured');
  const token = randomToken();
  const newToken = await createAuthEmailToken(db, {
    purpose: 'signup', tokenHash: await sha256Hex(token), email: row.email,
    ipHash: row.ip_hash, deviceMarker: row.device_marker, applicationId: row.id,
    expiresAt: toJstString(new Date(Date.now() + SIGNUP_TOKEN_TTL_MS)),
  });
  await sendSignupVerifyMail(c.env, { email: row.email,
    completeUrl: `${base}/register/complete?token=${encodeURIComponent(token)}` });
  await consumeOtherSignupTokens(db, row.id, newToken.id);
  await markRegistrationApplicationInviteSent(db, row.id);
  return true;
}

opsApplications.post('/api/ops/applications/:id/approve', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const db = dbFor(c.env);
  const id = c.req.param('id');
  const staff = c.get('staff');
  const body = await c.req.json<unknown>().catch(() => null);
  const conditionId = body && typeof body === 'object' && !Array.isArray(body) && 'conditionId' in body
    ? body.conditionId : null;
  if (conditionId !== undefined && conditionId !== null
    && (typeof conditionId !== 'string' || conditionId.length > 100)) {
    return c.json({ success: false, error: '利用条件を選び直してください' }, 400);
  }
  const snapshot = await approveRegistrationWithMusuboCondition(db, {
    applicationId: id,
    conditionId: typeof conditionId === 'string' ? conditionId : null,
    actorId: staff.id,
  });
  if (!snapshot) {
    return c.json({ success: false, error: '申込または利用条件の状態が変わりました。読み直してください' }, 409);
  }
  await recordPlatformAudit(db, { staffId: staff.id, staffName: staff.name,
    action: 'application.approve', detail: { applicationId: id,
      conditionId: snapshot.sourceConditionId, conditionVersion: snapshot.sourceVersion },
    ip: clientIp(c), visibleToTenant: false });
  let mailSent = false;
  try { mailSent = await sendInvite(c, id); }
  catch { logger.error('registration_application.invite_failed'); }
  if (mailSent) await recordPlatformAudit(db, { staffId: staff.id, staffName: staff.name,
    action: 'application.invite', detail: { applicationId: id },
    ip: clientIp(c), visibleToTenant: false });
  return c.json({ success: true, data: { application: await getRegistrationApplication(db, id), mailSent } });
});

opsApplications.post('/api/ops/applications/:id/resend-invite', requirePlatformAdminWrite(), async (c) => {
  const db = dbFor(c.env);
  const id = c.req.param('id');
  const row = await getRegistrationApplication(db, id);
  if (!row || row.status !== 'approved') return c.json({ success: false, error: '再送できる申込がありません' }, 409);
  try {
    await sendInvite(c, id);
  } catch {
    logger.error('registration_application.invite_resend_failed');
    return c.json({ success: false, error: '案内メールを送れませんでした。時間をおいて再送してください' }, 502);
  }
  const staff = c.get('staff');
  await recordPlatformAudit(db, { staffId: staff.id, staffName: staff.name,
    action: 'application.invite', detail: { applicationId: id, resent: true },
    ip: clientIp(c), visibleToTenant: false });
  return c.json({ success: true, data: await getRegistrationApplication(db, id) });
});
