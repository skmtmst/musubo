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
    t.contact_email AS contact_email,
    (SELECT a.email FROM registration_applications a
      WHERE a.tenant_id=t.id AND a.status='activated' ORDER BY a.created_at DESC LIMIT 1) AS application_email,
    (SELECT sm.email FROM staff_members sm
      WHERE sm.tenant_id=t.id AND sm.role='owner' AND sm.is_active=1
      AND sm.email IS NOT NULL ORDER BY sm.created_at ASC LIMIT 1) AS owner_email
    FROM tenants t WHERE t.id=?`)
    .bind(tenantId).first<{ contact_email: string | null; application_email: string | null; owner_email: string | null }>();
  for (const candidate of [row?.contact_email, row?.application_email, row?.owner_email]) {
    const email = candidate?.trim() ?? '';
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;
  }
  return null;
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
  // Only the paid event that actually restored access should announce recovery.
  // Otherwise the sweep can send another "recovered" mail for an older paid
  // invoice once the final unpaid invoice is settled.
  const restored = await env.DB.prepare(`SELECT 1 AS found FROM billing_events
    WHERE tenant_id=? AND type='invoice.paid' AND json_valid(summary)
      AND json_extract(summary,'$.state')='completed'
      AND json_extract(summary,'$.subjectId')=?
      AND json_extract(summary,'$.applied')=1 LIMIT 1`)
    .bind(row.tenant_id, row.id).first<{ found: number }>();
  if (!restored) return false;
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

/** Reconciles a paid webhook whose recovery email was interrupted after the invoice was saved. */
export async function sweepBillingRecoveryNotices(env: Env['Bindings'], now = new Date()): Promise<{ checked: number; failed: number }> {
  // The window keeps deployment from mailing old payments. A page rotates on each delivery tick,
  // so a burst of payments cannot permanently hide later invoices behind the first 100.
  const since = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString();
  const condition = `bi.status='paid' AND bi.amount_due>0 AND bi.amount_paid>=bi.amount_due
    AND julianday(bi.synced_at)>=julianday(?) AND EXISTS (SELECT 1 FROM billing_events e
      WHERE e.tenant_id=bi.tenant_id AND e.type='invoice.payment_failed'
        AND json_extract(CASE WHEN json_valid(e.summary) THEN e.summary ELSE '{}' END,'$.state')='completed'
        AND json_extract(CASE WHEN json_valid(e.summary) THEN e.summary ELSE '{}' END,'$.subjectId')=bi.id)
    AND EXISTS (SELECT 1 FROM billing_events p WHERE p.tenant_id=bi.tenant_id
      AND p.type='invoice.paid' AND json_valid(p.summary)
      AND json_extract(p.summary,'$.state')='completed'
      AND json_extract(p.summary,'$.subjectId')=bi.id
      AND json_extract(p.summary,'$.applied')=1)`;
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM billing_invoices bi WHERE ${condition}`)
    .bind(since).first<{ n: number }>();
  const count = total?.n ?? 0;
  if (!count) return { checked: 0, failed: 0 };
  const pages = Math.ceil(count / PAGE_SIZE);
  const page = Math.floor(now.getTime() / (5 * 60 * 1000)) % pages;
  const rows = await env.DB.prepare(`SELECT bi.id FROM billing_invoices bi WHERE ${condition}
    ORDER BY julianday(bi.synced_at) DESC, bi.id LIMIT ? OFFSET ?`)
    .bind(since, PAGE_SIZE, page * PAGE_SIZE).all<{ id: string }>();
  let failed = 0;
  for (const row of rows.results ?? []) {
    try { await deliverBillingRecoveryNotice(env, row.id); }
    catch { failed += 1; }
  }
  return { checked: rows.results?.length ?? 0, failed };
}
