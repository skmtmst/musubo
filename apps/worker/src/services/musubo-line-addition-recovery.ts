import { getTenantBilling } from '@line-crm/db';
import type { WorkerBindings } from '../worker-bindings.js';
import {
  reconcilePaidMusuboLine,
  verifyMusuboLineAdditionInvoice,
  type MusuboPendingLineAddition,
} from './musubo-line-addition.js';
import { stripeApi } from './stripe-api.js';

export type MusuboLineAdditionTarget = { additionId: string } | { accountId: string };

export async function getMusuboLineAddition(
  db: D1Database,
  tenantId: string,
  target: MusuboLineAdditionTarget,
): Promise<MusuboPendingLineAddition | null> {
  const byId = 'additionId' in target;
  return db.prepare(
    byId
      ? "SELECT * FROM musubo_pending_additions WHERE tenant_id=? AND kind='line' AND id=?"
      : "SELECT * FROM musubo_pending_additions WHERE tenant_id=? AND kind='line' AND line_account_id=? ORDER BY created_at DESC, id DESC LIMIT 1",
  ).bind(tenantId, byId ? target.additionId : target.accountId).first<MusuboPendingLineAddition>();
}

/** Refresh the exact saved addition. Only a recorded or verified payment can lead to activation. */
export async function resumePaidMusuboLineAddition(
  env: WorkerBindings,
  addition: MusuboPendingLineAddition,
): Promise<{ addition: MusuboPendingLineAddition; paymentUrl: string | null }> {
  const tenantId = addition.tenant_id;
  const target = { additionId: addition.id };
  const current = await getMusuboLineAddition(env.DB, tenantId, target);
  if (!current || current.line_account_id !== addition.line_account_id) {
    throw new Error('The LINE addition changed before recovery');
  }
  if (!current.line_account_id || !['awaiting_payment', 'paid'].includes(current.status)) {
    return { addition: current, paymentUrl: null };
  }
  let paymentUrl: string | null = null;
  if (current.status === 'awaiting_payment' && current.stripe_invoice_id) {
    const billing = await getTenantBilling(env.DB, tenantId);
    if (!billing?.stripe_customer_id) throw new Error('Stripe customer is unavailable');
    const invoice = await stripeApi.retrieveInvoice(env, current.stripe_invoice_id);
    verifyMusuboLineAdditionInvoice(invoice, current, billing.stripe_customer_id);
    if (invoice.id !== current.stripe_invoice_id || invoice.amount_due !== current.amount_due_yen) {
      throw new Error('The saved LINE addition invoice does not match');
    }
    if (invoice.status === 'open' && current.expires_at > new Date().toISOString()) {
      paymentUrl = invoice.hosted_invoice_url ?? null;
    }
    if (invoice.status === 'paid' && Number.isSafeInteger(invoice.amount_paid)
      && invoice.amount_paid >= current.amount_due_yen) {
      const paidAt = new Date((invoice.status_transitions?.paid_at ?? Date.now() / 1000) * 1000).toISOString();
      await env.DB.prepare(
        "UPDATE musubo_pending_additions SET status='paid',paid_at=?,updated_at=? "
        + "WHERE id=? AND tenant_id=? AND kind='line' AND line_account_id=? AND stripe_invoice_id=? AND status='awaiting_payment'",
      ).bind(paidAt, new Date().toISOString(), current.id, tenantId, current.line_account_id, invoice.id).run();
    }
  }

  try {
    await reconcilePaidMusuboLine(env, current.id, tenantId);
  } catch (error) {
    // The scheduled worker or another request can activate the same addition while Stripe responds.
    const latest = await getMusuboLineAddition(env.DB, tenantId, target);
    if (latest?.status !== 'activated' || latest.line_account_id !== current.line_account_id) throw error;
    return { addition: latest, paymentUrl: null };
  }
  const latest = await getMusuboLineAddition(env.DB, tenantId, target);
  if (!latest || latest.line_account_id !== current.line_account_id) {
    throw new Error('The LINE addition changed during recovery');
  }
  return { addition: latest, paymentUrl: latest.status === 'awaiting_payment' ? paymentUrl : null };
}
