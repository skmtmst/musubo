import { Hono } from 'hono';
import {
  acceptTenantMusuboIndividualQuote, attachAcceptedMusuboQuote,
  getLatestTenantMusuboIndividualQuote, getMusuboTenantBilling,
  getTenantMusuboIndividualQuote, musuboQuoteFromRecord,
} from '@line-crm/db';
import { individualQuoteAccess } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { requireRole } from '../middleware/role-guard.js';

export const hqMusuboQuotes = new Hono<Env>();

hqMusuboQuotes.get('/api/hq/onboarding/quotes/latest', requireRole('owner', 'admin'), async (c) => {
  const tenantId = c.get('staff')?.tenantId ?? DEFAULT_TENANT_ID;
  const row = await getLatestTenantMusuboIndividualQuote(c.env.DB, tenantId);
  return row ? c.json({ success: true, data: { quoteId: row.id } })
    : c.json({ success: false, error: '有効なお見積もりがありません' }, 404);
});

hqMusuboQuotes.get('/api/hq/onboarding/quotes/:id', requireRole('owner', 'admin'), async (c) => {
  const tenantId = c.get('staff')?.tenantId ?? DEFAULT_TENANT_ID;
  const row = await getTenantMusuboIndividualQuote(c.env.DB, tenantId, c.req.param('id'));
  if (!row || row.status === 'draft' || row.status === 'sending') {
    return c.json({ success: false, error: 'お見積もりが見つかりません' }, 404);
  }
  const quote = musuboQuoteFromRecord(row);
  const access = individualQuoteAccess(quote, new Date().toISOString());
  return c.json({ success: true, data: { quote, access,
    cardRegistrationAvailable: access === 'accepted' } });
});

hqMusuboQuotes.post('/api/hq/onboarding/quotes/:id/accept', requireRole('owner', 'admin'), async (c) => {
  const tenantId = c.get('staff')?.tenantId ?? DEFAULT_TENANT_ID;
  const id = c.req.param('id');
  const existing = await getTenantMusuboIndividualQuote(c.env.DB, tenantId, id);
  if (!existing || existing.status === 'draft' || existing.status === 'sending') {
    return c.json({ success: false, error: 'お見積もりが見つかりません' }, 404);
  }
  const billing = await getMusuboTenantBilling(c.env.DB, tenantId);
  if (existing.status === 'accepted') {
    if (billing && !await attachAcceptedMusuboQuote(c.env.DB, tenantId, id)) {
      return c.json({ success: false, error: '見積もりの契約条件を確定できません。運営にお問い合わせください' }, 409);
    }
    return c.json({ success: true, data: { quote: musuboQuoteFromRecord(existing), accepted: true } });
  }
  const accepted = await acceptTenantMusuboIndividualQuote(c.env.DB, {
    tenantId, quoteId: id, actorId: c.get('staff')!.id,
  });
  if (!accepted) {
    return c.json({ success: false, error: '見積もりの期限または状態が変わりました。読み直してください' }, 409);
  }
  if (billing && !await attachAcceptedMusuboQuote(c.env.DB, tenantId, id)) {
    return c.json({ success: false, error: '見積もりの契約条件を確定できません。再度お試しください' }, 409);
  }
  return c.json({ success: true, data: { quote: musuboQuoteFromRecord(accepted), accepted: true } });
});
