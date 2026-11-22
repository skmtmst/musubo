import { jstDate } from '@line-crm/shared';
import { archiveAndResetTenantBilling } from './tenant-purge-billing-history.js';
import { hashPurgedPaymentIdentifier, purgedPaymentIdentifierExpiry, purgedPaymentIdentifierKeyVersion, storePurgedPaymentIdentifierHash, type PurgedPaymentIdentifierKind } from './tenant-purge-payment-hashes.js';

/** A missing key must not leave an otherwise active tenant in purge mode. */
export async function requirePurgeHashKeyBeforeClaim(db:D1Database, tenantId:string, secret:string|undefined):Promise<void> {
  if (secret) return;
  const row=await db.prepare(`SELECT 1 AS found FROM tenants t WHERE t.id=? AND (
    t.stripe_customer_id IS NOT NULL OR t.stripe_subscription_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM musubo_tenant_billing b WHERE b.tenant_id=t.id AND (b.core_subscription_id IS NOT NULL OR b.options_subscription_id IS NOT NULL))
    OR EXISTS(SELECT 1 FROM billing_invoices i WHERE i.tenant_id=t.id AND (i.stripe_customer_id IS NOT NULL OR i.subscription_id IS NOT NULL)))`).bind(tenantId).first<{found:number}>();
  if (row) throw new Error('purge_payment_hash_key_missing');
}

/** Save hashes before clearing current billing identifiers; retries extend rather than shorten retention. */
export async function preparePurgedTenantBilling(db:D1Database, tenantId:string, now:string, secret:string|undefined):Promise<void> {
  const ids = await db.prepare(`SELECT stripe_customer_id AS customer,stripe_subscription_id AS subscription,NULL AS options_subscription FROM tenants WHERE id=?`)
    .bind(tenantId).first<{customer:string|null;subscription:string|null;options_subscription:string|null}>();
  const current = await db.prepare(`SELECT core_subscription_id,options_subscription_id FROM musubo_tenant_billing WHERE tenant_id=?`)
    .bind(tenantId).first<{core_subscription_id:string|null;options_subscription_id:string|null}>();
  const previous = await db.prepare('SELECT stripe_customer_id,subscription_id FROM billing_invoices WHERE tenant_id=?')
    .bind(tenantId).all<{stripe_customer_id:string|null;subscription_id:string|null}>();
  const identifiers: Array<[PurgedPaymentIdentifierKind,string]> = [];
  const add=(kind:PurgedPaymentIdentifierKind, id:string|null|undefined) => {if (id && !identifiers.some(([k,v])=>k===kind && v===id)) identifiers.push([kind,id]);};
  add('customer',ids?.customer);add('subscription',ids?.subscription);
  add('subscription',current?.core_subscription_id);add('subscription',current?.options_subscription_id);
  for (const invoice of previous.results) {add('customer',invoice.stripe_customer_id);add('subscription',invoice.subscription_id);}
  const payments=await db.prepare(`SELECT paid_at FROM billing_invoices WHERE tenant_id=? AND paid_at IS NOT NULL
    UNION ALL SELECT paid_at FROM booking_monthly_cycles WHERE tenant_id=? AND paid_at IS NOT NULL
    UNION ALL SELECT p.paid_at FROM booking_payments p JOIN line_accounts a ON a.id=p.line_account_id WHERE a.tenant_id=? AND p.paid_at IS NOT NULL
    UNION ALL SELECT c.updated_at FROM booking_charges c JOIN line_accounts a ON a.id=c.line_account_id WHERE a.tenant_id=? AND c.status IN ('succeeded','refunded')`)
    .bind(tenantId,tenantId,tenantId,tenantId).all<{paid_at:string}>();
  const otherPayments=await db.prepare(`SELECT p.paid_at FROM booking_pass_purchases p JOIN line_accounts a ON a.id=p.account_id WHERE a.tenant_id=? AND p.paid_at IS NOT NULL
    UNION ALL SELECT e.occurred_at FROM booking_pass_billing_events e JOIN booking_pass_purchases p ON p.id=e.purchase_id JOIN line_accounts a ON a.id=p.account_id WHERE a.tenant_id=? AND e.kind='invoice.paid' AND e.result IN ('recorded','applied')
    UNION ALL SELECT COALESCE(e.applied_at,e.received_at) FROM booking_payment_events e JOIN line_accounts a ON a.id=e.line_account_id WHERE a.tenant_id=? AND e.outcome='paid' AND e.result IN ('applied','duplicate')
    UNION ALL SELECT s.processed_at FROM stripe_events s LEFT JOIN friends f ON f.id=s.friend_id LEFT JOIN line_accounts a ON a.id=f.line_account_id WHERE (s.tenant_id=? OR a.tenant_id=?) AND s.event_type IN ('invoice.paid','payment_intent.succeeded')` )
    .bind(tenantId,tenantId,tenantId,tenantId,tenantId).all<{paid_at:string}>();
  const jstDay=(value:string) => {
    const withZone = /(?:[zZ]|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}${value.length===10?'T00:00:00':''}+09:00`;
    const ms=Date.parse(withZone);
    if (!Number.isFinite(ms)) throw new Error('invalid_last_payment_time');
    return jstDate(new Date(ms));
  };
  const paymentDates=[...payments.results,...otherPayments.results].map(row=>jstDay(row.paid_at)).sort();
  const expiresAt=purgedPaymentIdentifierExpiry(paymentDates.at(-1) ?? null,jstDay(now));
  const keyVersion=await purgedPaymentIdentifierKeyVersion(secret);
  if (identifiers.length && !keyVersion) throw new Error('purge_payment_hash_key_missing');
  for (const [kind,id] of identifiers) {
    const digest=await hashPurgedPaymentIdentifier(secret,kind,id);
    if (!digest || !keyVersion) throw new Error('purge_payment_hash_key_missing');
    await storePurgedPaymentIdentifierHash(db,{tenantId,kind,digest,keyVersion,expiresAt,now});
  }
  await archiveAndResetTenantBilling(db,tenantId,now,expiresAt);
}
