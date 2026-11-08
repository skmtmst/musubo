import { getTenantBilling, type TenantBilling } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { firstInvoiceFailureSeconds, getBillingPaymentFailure, type BillingPaymentFailure } from './billing-payment-failure.js';
import { musuboInvoiceMail, type MusuboInvoiceMailEvent } from './musubo-invoice-mail.js';
import { sendPlainMail } from './plain-mail.js';
import { sendRecordedNotification } from './recorded-notification-send.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;

function adminBillingUrl(env: Env['Bindings'], recovery: boolean): string | null {
  const origin = (env.ADMIN_PUBLIC_URL || env.ADMIN_ORIGIN?.split(',')[0] || '').trim();
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return null;
    url.pathname = recovery ? '/hq/billing/payment-recovery' : '/hq/billing';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

async function billingRecipient(db: D1Database, tenantId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT
    COALESCE(NULLIF(trim(t.contact_email),''),
      (SELECT NULLIF(trim(a.email),'') FROM registration_applications a
        WHERE a.tenant_id=t.id AND a.status='activated' ORDER BY a.created_at DESC LIMIT 1),
      (SELECT NULLIF(trim(sm.email),'') FROM staff_members sm
        WHERE sm.tenant_id=t.id AND sm.role='owner' AND sm.is_active=1
        AND sm.email IS NOT NULL ORDER BY sm.created_at ASC LIMIT 1)) AS email
    FROM tenants t WHERE t.id=?`)
    .bind(tenantId).first<{ email: string | null }>();
  const email = row?.email?.trim() ?? '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function billingFailureNoticePhase(failure: BillingPaymentFailure, now: Date): MusuboInvoiceMailEvent {
  const deadline = Date.parse(failure.graceDeadlineAt);
  if (now.getTime() >= deadline) return 'suspended';
  return now.getTime() >= deadline - DAY_MS ? 'day_six' : 'failed';
}

async function deliverNotice(env: Env['Bindings'], input: {
  tenantId: string;
  invoiceId: string;
  event: MusuboInvoiceMailEvent;
  amountYen: number;
  invoiceAt: string;
  graceDeadlineAt: string;
  nextChargeAt?: string | null;
}): Promise<boolean> {
  const billingUrl = adminBillingUrl(env, input.event !== 'recovered');
  const recipient = await billingRecipient(env.DB, input.tenantId);
  if (!billingUrl || !recipient) return false;
  const mail = musuboInvoiceMail({
    event: input.event, amountYen: input.amountYen, invoiceAt: input.invoiceAt,
    graceDeadlineAt: input.graceDeadlineAt, billingUrl,
    nextChargeAt: input.nextChargeAt ?? undefined,
  });
  await sendRecordedNotification(env.DB, {
    sourceId: `billing-invoice:${input.invoiceId}:${input.event}`,
    channel: 'email', recipient,
    payload: JSON.stringify(mail),
    send: () => sendPlainMail(env, { to: recipient, subject: mail.subject, body: mail.text, html: mail.html }),
  });
  return true;
}

/** Sends only the notice appropriate now, so a late sweep never floods old warnings. */
export async function deliverCurrentBillingFailureNotice(env: Env['Bindings'], tenantId: string, now = new Date()): Promise<boolean> {
  const billing = await getTenantBilling(env.DB, tenantId);
  const failure = await getBillingPaymentFailure(env.DB, billing, now);
  if (!failure) return false;
  return deliverNotice(env, {
    tenantId, invoiceId: failure.invoiceId,
    event: billingFailureNoticePhase(failure, now),
    amountYen: failure.amountYen, invoiceAt: failure.failedAt,
    graceDeadlineAt: failure.graceDeadlineAt,
  });
}

/** A paid event restores the subscription first; the email is a separate, idempotent effect. */
export async function deliverBillingRecoveryNotice(env: Env['Bindings'], invoiceId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT bi.id, bi.tenant_id, bi.subscription_id, bi.amount_due, bi.amount_paid,
      bi.created_at, t.plan_status, t.stripe_subscription_id, t.current_period_ends_at
    FROM billing_invoices bi JOIN tenants t ON t.id=bi.tenant_id
    WHERE bi.id=? AND bi.status='paid' AND bi.amount_paid>=bi.amount_due AND bi.amount_due>0`)
    .bind(invoiceId).first<{
      id: string; tenant_id: string; subscription_id: string | null;
      amount_due: number; amount_paid: number; created_at: string;
      plan_status: TenantBilling['plan_status']; stripe_subscription_id: string | null;
      current_period_ends_at: string | null;
    }>();
  if (!row || row.plan_status !== 'active' || !row.subscription_id
    || row.subscription_id !== row.stripe_subscription_id) return false;
  const firstFailure = await firstInvoiceFailureSeconds(env.DB, row.tenant_id, row.id);
  if (!firstFailure) return false;
  const stillUnpaid = await env.DB.prepare(`SELECT 1 AS found FROM billing_invoices
    WHERE tenant_id=? AND subscription_id=? AND status IN ('open','uncollectible')
      AND amount_due>amount_paid LIMIT 1`)
    .bind(row.tenant_id, row.subscription_id).first<{ found: number }>();
  if (stillUnpaid) return false;
  return deliverNotice(env, {
    tenantId: row.tenant_id, invoiceId: row.id, event: 'recovered',
    amountYen: row.amount_paid, invoiceAt: row.created_at,
    graceDeadlineAt: new Date(firstFailure * 1000 + 7 * DAY_MS).toISOString(),
    nextChargeAt: row.current_period_ends_at,
  });
}

/** Round-robin pages prevent the same first 100 tenants monopolizing each tick. */
export async function sweepBillingFailureNotices(env: Env['Bindings'], now = new Date()): Promise<{ checked: number; failed: number }> {
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tenants
    WHERE plan_status='past_due' AND stripe_subscription_id IS NOT NULL`).first<{ n: number }>();
  const count = total?.n ?? 0;
  if (count === 0) return { checked: 0, failed: 0 };
  const pages = Math.ceil(count / PAGE_SIZE);
  const page = Math.floor(now.getTime() / (5 * 60 * 1000)) % pages;
  const rows = await env.DB.prepare(`SELECT id FROM tenants
    WHERE plan_status='past_due' AND stripe_subscription_id IS NOT NULL
    ORDER BY id LIMIT ? OFFSET ?`).bind(PAGE_SIZE, page * PAGE_SIZE).all<{ id: string }>();
  let failed = 0;
  for (const row of rows.results ?? []) {
    try { await deliverCurrentBillingFailureNotice(env, row.id, now); }
    catch { failed += 1; }
  }
  return { checked: rows.results?.length ?? 0, failed };
}
