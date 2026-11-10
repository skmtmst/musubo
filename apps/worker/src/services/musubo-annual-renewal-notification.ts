import { getMusuboIndividualQuote, getMusuboTenantBilling,
  musuboQuoteFromRecord } from '@line-crm/db';
import { jstDate, jstDateOffset, lineBasicDiscountForDate, musuboIndividualQuotePrice, musuboPrice,
  type AppliedMusuboCondition } from '@line-crm/shared';
import type { WorkerBindings } from '../worker-bindings.js';
import { billingRecipient } from './billing-invoice-notifications.js';
import { musuboAnnualRenewalMail,
  type MusuboAnnualRenewalNotice } from './musubo-annual-renewal-mail.js';
import { sendPlainMail } from './plain-mail.js';
import { sendRecordedNotification } from './recorded-notification-send.js';

interface UsageRow {
  line_account_id: string; name: string; friend_count_excluding_blocked: number | null;
  friend_count_measured_on: string | null; google_business_count: number; instagram_count: number;
}
interface NoticeRow { id: string; tenant_id: string; snapshot_json: string }

function billingUrl(env: WorkerBindings): string | null {
  try {
    const url = new URL((env.ADMIN_PUBLIC_URL || env.ADMIN_ORIGIN?.split(',')[0] || '').trim());
    if (url.protocol !== 'https:') return null;
    url.pathname = '/hq/billing'; url.search = ''; url.hash = '';
    return url.toString();
  } catch { return null; }
}

async function recordAnnualNotice(env: WorkerBindings, tenantId: string, now: string): Promise<boolean> {
  const billing = await getMusuboTenantBilling(env.DB, tenantId);
  if (!billing || billing.billing_interval !== 'year' || billing.status !== 'active'
    || !billing.next_annual_renewal_at || !billing.core_subscription_id) return false;
  const renewalAt = `${billing.next_annual_renewal_at}T00:00:00+09:00`;
  const days = (Date.parse(renewalAt) - Date.parse(now)) / 86_400_000;
  if (!(days > 0 && days <= 30)) return false;
  const previous = await env.DB.prepare(`SELECT id FROM musubo_annual_renewal_notices
    WHERE tenant_id=? AND renewal_date=?`).bind(tenantId, billing.next_annual_renewal_at)
    .first<{ id: string }>();
  if (previous) return false;
  const rows = await env.DB.prepare(`SELECT u.line_account_id,a.name,u.friend_count_excluding_blocked,
    u.friend_count_measured_on,u.google_business_count,u.instagram_count
    FROM musubo_line_usage u JOIN line_accounts a ON a.id=u.line_account_id
    WHERE u.tenant_id=? AND u.status IN ('active','ending') ORDER BY u.activated_at,a.id`)
    .bind(tenantId).all<UsageRow>();
  const current = rows.results ?? [];
  if (!current.length || current.some((row) => row.friend_count_excluding_blocked === null
    || row.friend_count_measured_on !== jstDateOffset(-1))) return false;
  const removal = await env.DB.prepare(`SELECT line_account_id,effective_at FROM musubo_line_removals
    WHERE tenant_id=? AND status IN ('requested','scheduled') LIMIT 1`)
    .bind(tenantId).first<{ line_account_id: string; effective_at: string }>();
  const ending = removal && Date.parse(removal.effective_at) <= Date.parse(renewalAt)
    ? current.find((line) => line.line_account_id === removal.line_account_id) : undefined;
  const effective = ending ? current.filter((row) => row.line_account_id !== ending.line_account_id) : current;
  if (!effective.length) return false;
  const condition = JSON.parse(billing.pricing_snapshot_json) as AppliedMusuboCondition;
  const quoteRow = billing.quote_id ? await getMusuboIndividualQuote(env.DB, billing.quote_id) : null;
  if (billing.quote_id && (!quoteRow || quoteRow.status !== 'accepted' || quoteRow.tenant_id !== tenantId)) {
    throw new Error('Accepted individual quote is unavailable');
  }
  const quote = quoteRow ? musuboQuoteFromRecord(quoteRow) : null;
  const schedule = quote?.finalSchedule ?? condition.schedule;
  const capacity = quote && quote.plannedLineCount > 10 ? quote.plannedLineCount : effective.length;
  const calculated = musuboPrice({ lineCount: capacity, interval: 'year',
    friendCountExcludingBlocked: effective.reduce((sum, row) => sum + row.friend_count_excluding_blocked!, 0),
    linkedAccountsByLine: effective.map((row) => ({ googleBusiness: row.google_business_count,
      instagram: row.instagram_count })),
    lineBasicDiscountPercent: quote ? 0 : lineBasicDiscountForDate(condition, billing.next_annual_renewal_at),
    schedule, individualQuoteContext: Boolean(quote) });
  const annualLineChargeYen = quote ? musuboIndividualQuotePrice(quote).finalAnnualLineChargeYen!
    : calculated.annualLineChargeYen;
  const snapshot: Omit<MusuboAnnualRenewalNotice, 'billingUrl'> = {
    estimatedAt: now, renewalAt,
    activeLineCountAfterReservations: effective.length,
    annualLineChargeYen,
    monthlyOptionsAfterRenewalYen: calculated.optionsMonthlyYen,
    ...(ending ? { endingLine: { name: ending.name,
      lastUsableAt: new Date(Date.parse(removal!.effective_at) - 1).toISOString() } } : {}),
    headquartersEndsAtRenewal: current.length > 1 && effective.length === 1,
  };
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO musubo_annual_renewal_notices
    (id,tenant_id,renewal_date,snapshot_json,created_at) VALUES (?,?,?,?,?)`)
    .bind(`musubo-annual-renewal:${tenantId}:${billing.next_annual_renewal_at}`,
      tenantId, billing.next_annual_renewal_at, JSON.stringify(snapshot), now).run();
  return (result.meta?.changes ?? 0) === 1;
}

async function deliver(env: WorkerBindings, row: NoticeRow): Promise<boolean> {
  const recipient = await billingRecipient(env.DB, row.tenant_id);
  const url = billingUrl(env);
  if (!recipient || !url) return false;
  const mail = musuboAnnualRenewalMail({
    ...JSON.parse(row.snapshot_json) as Omit<MusuboAnnualRenewalNotice, 'billingUrl'>,
    billingUrl: url,
  });
  await sendRecordedNotification(env.DB, { sourceId: row.id, channel: 'email', recipient,
    payload: JSON.stringify(mail),
    send: () => sendPlainMail(env, { to: recipient, subject: mail.subject,
      body: mail.text, html: mail.html }) });
  await env.DB.prepare(`UPDATE musubo_annual_renewal_notices SET delivered_at=?
    WHERE id=? AND delivered_at IS NULL`).bind(new Date().toISOString(), row.id).run();
  return true;
}

export async function sweepMusuboAnnualRenewalNotices(env: WorkerBindings,
  now = new Date().toISOString()) {
  const today = jstDate(new Date(now));
  const through = jstDate(new Date(Date.parse(now) + 31 * 86_400_000));
  const tenants = await env.DB.prepare(`SELECT b.tenant_id FROM musubo_tenant_billing b
    LEFT JOIN musubo_annual_renewal_notices n
      ON n.tenant_id=b.tenant_id AND n.renewal_date=b.next_annual_renewal_at
    WHERE b.status='active' AND b.billing_interval='year'
      AND b.next_annual_renewal_at>? AND b.next_annual_renewal_at<=? AND n.id IS NULL
    ORDER BY b.next_annual_renewal_at LIMIT 100`).bind(today, through).all<{ tenant_id: string }>();
  let failed = 0;
  for (const tenant of tenants.results ?? []) {
    try { await recordAnnualNotice(env, tenant.tenant_id, now); } catch { failed++; }
  }
  const notices = await env.DB.prepare(`SELECT id,tenant_id,snapshot_json
    FROM musubo_annual_renewal_notices WHERE delivered_at IS NULL ORDER BY created_at LIMIT 100`)
    .all<NoticeRow>();
  for (const notice of notices.results ?? []) {
    try { if (!await deliver(env, notice)) failed++; } catch { failed++; }
  }
  return { checked: tenants.results?.length ?? 0, pending: notices.results?.length ?? 0, failed };
}
