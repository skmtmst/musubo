import { Hono } from 'hono';
import {
  claimMusuboIndividualQuoteSend, createMusuboIndividualQuoteDraft,
  getMusuboIndividualQuote, getRegistrationApplication, listMusuboIndividualQuotesForApplication,
  markMusuboIndividualQuoteSent, musuboQuoteFromRecord, recordPlatformAudit,
  updateMusuboIndividualQuoteDraft,
} from '@line-crm/db';
import { individualQuoteAccess, musuboIndividualQuotePrice,
  type MusuboIndividualQuote } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import type { Env } from '../worker-env.js';
import { requirePlatformAdmin, requirePlatformAdminWrite } from '../middleware/platform-admin.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { dbFor } from '../services/db-router.js';
import { clientIp } from '../services/admin-session.js';
import { individualQuoteMail } from '../services/quote-mail-design.js';
import { sendPlainMail } from '../services/plain-mail.js';
import { sha256Hex } from '../middleware/auth.js';

export const opsIndividualQuotes = new Hono<Env>();
opsIndividualQuotes.use('/api/ops/applications/:applicationId/quotes/*', requirePlatformAdmin());
opsIndividualQuotes.use('/api/ops/applications/:applicationId/quotes', requirePlatformAdmin());

function proposedQuote(body: unknown): Omit<MusuboIndividualQuote,
  'quoteNumber' | 'companyName' | 'issuedAt' | 'acceptedAt' | 'supersededAt'> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  if (!raw.proposed || typeof raw.proposed !== 'object' || Array.isArray(raw.proposed)) return null;
  const proposed = raw.proposed as Record<string, unknown>;
  try {
    musuboIndividualQuotePrice({ ...proposed, quoteNumber: 'validation', companyName: 'validation',
      issuedAt: new Date().toISOString(), acceptedAt: null, supersededAt: null } as unknown as MusuboIndividualQuote);
    return proposed as unknown as ReturnType<typeof proposedQuote>;
  } catch { return null; }
}

function reviewUrl(env: Env['Bindings'], quoteId: string): string {
  const base = env.ADMIN_PUBLIC_URL?.replace(/\/+$/, '');
  if (!base) throw new Error('ADMIN_PUBLIC_URL not configured');
  const url = new URL(base);
  if (url.protocol !== 'https:') throw new Error('ADMIN_PUBLIC_URL must be HTTPS');
  return new URL(`/hq/onboarding/quotes?id=${encodeURIComponent(quoteId)}`, url).toString();
}

async function previewHash(recipient: string, termsJson: string): Promise<string> {
  return sha256Hex(JSON.stringify({ recipient, termsJson }));
}

opsIndividualQuotes.get('/api/ops/applications/:applicationId/quotes', async (c) => {
  const db = dbFor(c.env);
  const applicationId = c.req.param('applicationId');
  const application = await getRegistrationApplication(db, applicationId);
  if (!application) return c.json({ success: false, error: '申込が見つかりません' }, 404);
  const rows = await listMusuboIndividualQuotesForApplication(db, applicationId);
  return c.json({ success: true, data: rows.map((row) => ({
    quote: musuboQuoteFromRecord(row), status: row.status, revision: row.revision, sentAt: row.sent_at,
  })) });
});

opsIndividualQuotes.post('/api/ops/applications/:applicationId/quotes', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const proposed = proposedQuote(await c.req.json<unknown>().catch(() => null));
  if (!proposed) return c.json({ success: false, error: '見積もり内容を確認してください' }, 400);
  const staff = c.get('staff');
  const db = dbFor(c.env);
  const row = await createMusuboIndividualQuoteDraft(db, {
    applicationId: c.req.param('applicationId'), actorId: staff.id, proposed,
  });
  if (!row) return c.json({ success: false, error: '見積もりを保存できません。申込の状態を確認してください' }, 409);
  await recordPlatformAudit(db, { staffId: staff.id, staffName: staff.name,
    action: 'individual_quote.create', detail: { applicationId: row.application_id, quoteId: row.id },
    ip: clientIp(c), visibleToTenant: false });
  return c.json({ success: true, data: { quote: musuboQuoteFromRecord(row), status: row.status } }, 201);
});

opsIndividualQuotes.put('/api/ops/applications/:applicationId/quotes/:id', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const db = dbFor(c.env);
  const current = await getMusuboIndividualQuote(db, c.req.param('id'));
  if (!current || current.application_id !== c.req.param('applicationId')) {
    return c.json({ success: false, error: '見積もりが見つかりません' }, 404);
  }
  const proposed = proposedQuote(await c.req.json<unknown>().catch(() => null));
  if (!proposed) return c.json({ success: false, error: '見積もり内容を確認してください' }, 400);
  const staff = c.get('staff');
  const saved = await updateMusuboIndividualQuoteDraft(db, {
    id: current.id, actorId: staff.id, proposed: proposed as MusuboIndividualQuote,
  });
  if (!saved) return c.json({ success: false, error: 'この見積もりは変更できません。状態を読み直してください' }, 409);
  await recordPlatformAudit(db, { staffId: staff.id, staffName: staff.name,
    action: 'individual_quote.update', detail: { applicationId: current.application_id, quoteId: current.id },
    ip: clientIp(c), visibleToTenant: false });
  const updated = (await getMusuboIndividualQuote(db, current.id))!;
  return c.json({ success: true, data: { quote: musuboQuoteFromRecord(updated), status: updated.status } });
});

opsIndividualQuotes.get('/api/ops/applications/:applicationId/quotes/:id/mail-preview', async (c) => {
  const db = dbFor(c.env);
  const row = await getMusuboIndividualQuote(db, c.req.param('id'));
  if (!row || row.application_id !== c.req.param('applicationId') || row.status !== 'draft') {
    return c.json({ success: false, error: '送信前の見積もりが見つかりません' }, 404);
  }
  const application = await getRegistrationApplication(db, row.application_id);
  if (!application || !row.tenant_id || row.tenant_id !== application.tenant_id) {
    return c.json({ success: false, error: 'お客様の登録完了を確認してください' }, 409);
  }
  const quote = musuboQuoteFromRecord(row);
  if (individualQuoteAccess(quote, new Date().toISOString()) !== 'available') {
    return c.json({ success: false, error: '見積もり期限が切れました' }, 409);
  }
  const previous = await listMusuboIndividualQuotesForApplication(db, row.application_id);
  const kind = previous.some((item) => item.id !== row.id && item.sent_at) ? 'reissued' : 'issued';
  const mail = individualQuoteMail({ quote, reviewUrl: reviewUrl(c.env, row.id), kind });
  return c.json({ success: true, data: { to: application.email, subject: mail.subject,
    text: mail.text, html: mail.html, quoteId: row.id, kind,
    previewHash: await previewHash(application.email, row.final_prices_json) } });
});

opsIndividualQuotes.post('/api/ops/applications/:applicationId/quotes/:id/send', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const confirmation = await c.req.json<{ previewHash?: unknown } | null>().catch(() => null);
  if (typeof confirmation?.previewHash !== 'string' || !/^[a-f0-9]{64}$/.test(confirmation.previewHash)) {
    return c.json({ success: false, error: '送信前にメールを確認してください' }, 400);
  }
  const db = dbFor(c.env);
  const id = c.req.param('id');
  const row = await getMusuboIndividualQuote(db, id);
  if (!row || row.application_id !== c.req.param('applicationId') || row.status !== 'draft') {
    return c.json({ success: false, error: '送信できる見積もりがありません' }, 409);
  }
  const application = await getRegistrationApplication(db, row.application_id);
  if (!application || !row.tenant_id || row.tenant_id !== application.tenant_id) {
    return c.json({ success: false, error: 'お客様の登録完了を確認してください' }, 409);
  }
  if (confirmation.previewHash !== await previewHash(application.email, row.final_prices_json)) {
    return c.json({ success: false, error: '送信先または見積もりが変わりました。メールを再確認してください' }, 409);
  }
  const previous = await listMusuboIndividualQuotesForApplication(db, row.application_id);
  const kind = previous.some((item) => item.id !== row.id && item.sent_at) ? 'reissued' : 'issued';
  const mail = individualQuoteMail({ quote: musuboQuoteFromRecord(row),
    reviewUrl: reviewUrl(c.env, id), kind });
  if (!await claimMusuboIndividualQuoteSend(db, id)) {
    return c.json({ success: false, error: '見積もりの期限または状態が変わりました。読み直してください' }, 409);
  }
  try {
    await sendPlainMail(c.env, { to: application.email,
      subject: mail.subject, body: mail.text, html: mail.html });
  } catch {
    logger.error('individual_quote.send_failed');
    return c.json({ success: false, error: 'メールの送信結果を確認できません。運営で送信状況を確認してください' }, 502);
  }
  if (!await markMusuboIndividualQuoteSent(db, id)) {
    logger.error('individual_quote.mark_sent_failed');
    return c.json({ success: false, error: '送信後の記録を確定できません。運営で送信状況を確認してください' }, 502);
  }
  const staff = c.get('staff');
  await recordPlatformAudit(db, { staffId: staff.id, staffName: staff.name,
    action: 'individual_quote.send', detail: { applicationId: row.application_id,
      quoteId: id, kind },
    ip: clientIp(c), visibleToTenant: false });
  return c.json({ success: true, data: { quoteId: id, status: 'sent', recipient: application.email } });
});
