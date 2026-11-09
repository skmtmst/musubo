import { getMusuboTenantBilling } from '@line-crm/db';
import type { WorkerBindings } from '../worker-bindings.js';
import { billingRecipient } from './billing-invoice-notifications.js';
import { musuboFinalLineMail } from './musubo-account-lifecycle-mail.js';
import { getMusuboLineResumptionComplete } from './musubo-line-resumption.js';
import { sendPlainMail } from './plain-mail.js';
import { sendRecordedNotification } from './recorded-notification-send.js';

function accountsUrl(env: WorkerBindings): string | null {
  const origin = (env.ADMIN_PUBLIC_URL || env.ADMIN_ORIGIN?.split(',')[0] || '').trim();
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return null;
    url.pathname = '/accounts'; url.search = ''; url.hash = '';
    return url.toString();
  } catch { return null; }
}

/** Mail 17 is sent after durable LINE activation, with a generation-specific retry key. */
export async function deliverMusuboResumptionNotice(env: WorkerBindings, tenantId: string): Promise<boolean> {
  const billing = await getMusuboTenantBilling(env.DB, tenantId);
  if (!billing?.resumed_at || !['trialing', 'active'].includes(billing.status)) return false;
  const url = accountsUrl(env);
  const recipient = await billingRecipient(env.DB, tenantId);
  if (!url || !recipient) return false;
  const line = await env.DB.prepare(`SELECT la.name FROM musubo_line_usage u
    JOIN line_accounts la ON la.id=u.line_account_id
    WHERE u.tenant_id=? AND u.status='active' ORDER BY u.activated_at DESC LIMIT 1`)
    .bind(tenantId).first<{ name: string }>();
  if (!line?.name) return false;
  const view = await getMusuboLineResumptionComplete(env, tenantId);
  const nextChargeAt = view.kind === 'annual_paid' || view.kind === 'monthly_paid'
    ? view.renewalAt : view.nextChargeAt;
  const nextChargeYen = view.kind === 'annual_paid' ? view.nextAnnualLineBaseYen
    : view.nextLineBaseYen;
  const mail = musuboFinalLineMail({ event: 'resumed', lineName: line.name,
    interval: billing.billing_interval, actionUrl: url, resumedAt: view.restartedAt,
    amountPaidNowYen: view.chargedNowYen, nextChargeAt, nextChargeYen,
    optionsMonthlyYen: view.optionsMonthlyYen });
  await sendRecordedNotification(env.DB, {
    sourceId: `musubo-resumption:${tenantId}:${billing.resumption_generation}`,
    channel: 'email', recipient, payload: JSON.stringify(mail),
    send: () => sendPlainMail(env, { to: recipient, subject: mail.subject,
      body: mail.text, html: mail.html }),
  });
  return true;
}

/** Rechecks recent completed resumptions after route delivery or mail delivery was interrupted. */
export async function sweepMusuboResumptionNotices(env: WorkerBindings, now = new Date(), limit = 100): Promise<{
  checked: number; failed: number }> {
  const since = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(`SELECT tenant_id FROM musubo_tenant_billing
    WHERE resumed_at>=? AND status IN ('trialing','active')
    ORDER BY resumed_at DESC LIMIT ?`).bind(since, limit).all<{ tenant_id: string }>();
  let failed = 0;
  for (const row of rows.results ?? []) {
    try { await deliverMusuboResumptionNotice(env, row.tenant_id); }
    catch { failed++; }
  }
  return { checked: rows.results?.length ?? 0, failed };
}
