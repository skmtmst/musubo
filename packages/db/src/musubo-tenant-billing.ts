import { musuboTrialDates, type AppliedMusuboCondition } from '@line-crm/shared';
import { jstNow } from './utils.js';

export interface MusuboTenantBillingRecord {
  tenant_id: string;
  application_id: string | null;
  quote_id: string | null;
  pricing_snapshot_json: string;
  pricing_selection_json: string | null;
  pricing_consented_at: string | null;
  billing_interval: 'month' | 'year';
  status: 'awaiting_first_line' | 'trialing' | 'active' | 'past_due' | 'ended';
  first_line_activated_at: string | null;
  trial_last_free_date: string | null;
  first_charge_date: string | null;
  core_subscription_id: string | null;
  options_subscription_id: string | null;
  next_monthly_charge_at: string | null;
  next_annual_renewal_at: string | null;
  termination_requested_at: string | null;
  termination_effective_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function getMusuboTenantBilling(db: D1Database, tenantId: string): Promise<MusuboTenantBillingRecord | null> {
  return db.prepare('SELECT * FROM musubo_tenant_billing WHERE tenant_id=?')
    .bind(tenantId).first<MusuboTenantBillingRecord>();
}

/** Persist the server-validated normal-price choice before card setup. */
export async function recordMusuboPricingSelection(db: D1Database, input: {
  tenantId: string;
  selectionJson: string;
  interval: 'month' | 'year';
}): Promise<boolean> {
  const now = jstNow();
  const result = await db.prepare(`UPDATE musubo_tenant_billing
    SET pricing_selection_json=?,billing_interval=?,pricing_consented_at=?,updated_at=?
    WHERE tenant_id=? AND status='awaiting_first_line' AND quote_id IS NULL
      AND first_line_activated_at IS NULL`).bind(
    input.selectionJson, input.interval, now, now, input.tenantId,
  ).run();
  return (result.meta?.changes ?? 0) === 1;
}

/** Approved applications enter the new flow without starting the legacy trial. */
export async function createMusuboPendingTenant(db: D1Database, input: {
  name: string;
  applicationId: string;
  pricingSnapshotJson: string;
  deviceMarker: string | null;
}): Promise<string> {
  const snapshot = JSON.parse(input.pricingSnapshotJson) as AppliedMusuboCondition;
  if (!snapshot.trialPeriod || !Number.isSafeInteger(snapshot.trialPeriod.value)
    || snapshot.trialPeriod.value < 1) throw new RangeError('Invalid approved pricing snapshot');
  const application = await db.prepare(`SELECT id FROM registration_applications
    WHERE id=? AND status='approved' AND pricing_snapshot_json=? AND tenant_id IS NULL`)
    .bind(input.applicationId, input.pricingSnapshotJson).first<{ id: string }>();
  if (!application) throw new Error('Approved application is unavailable');
  const id = crypto.randomUUID();
  const now = jstNow();
  await db.batch([
    db.prepare(`INSERT INTO tenants
      (id,name,status,plan_key,plan_status,trial_ends_at,plan_updated_at,signup_device_marker,created_at,updated_at)
      VALUES (?,?,'active','musubo','exempt',NULL,?,?,?,?)`)
      .bind(id, input.name, now, input.deviceMarker, now, now),
    db.prepare(`INSERT INTO musubo_tenant_billing
      (tenant_id,application_id,pricing_snapshot_json,billing_interval,status,created_at,updated_at)
      VALUES (?,?,?,'month','awaiting_first_line',?,?)`)
      .bind(id, input.applicationId, input.pricingSnapshotJson, now, now),
  ]);
  return id;
}

/** Quoted units are committed only after the customer accepted the issued revision. */
export async function attachAcceptedMusuboQuote(db: D1Database, tenantId: string, quoteId: string): Promise<boolean> {
  const current = await getMusuboTenantBilling(db, tenantId);
  if (current?.quote_id === quoteId) return true;
  const result = await db.prepare(`UPDATE musubo_tenant_billing
    SET quote_id=?,billing_interval=(SELECT json_extract(final_prices_json,'$.interval')
      FROM musubo_individual_quotes WHERE id=?),updated_at=?
    WHERE tenant_id=? AND status='awaiting_first_line' AND quote_id IS NULL
      AND EXISTS (SELECT 1 FROM musubo_individual_quotes
        WHERE id=? AND tenant_id=? AND status='accepted' AND accepted_at IS NOT NULL)`)
    .bind(quoteId, quoteId, jstNow(), tenantId, quoteId, tenantId).run();
  return (result.meta?.changes ?? 0) === 1;
}

/** The current wizard may connect the first LINE; further paid additions need their own checkout. */
export async function musuboLineConnectionAllowed(db: D1Database, tenantId: string): Promise<'first' | 'legacy' | 'requires_payment' | 'ended'> {
  const billing = await getMusuboTenantBilling(db, tenantId);
  if (!billing) return 'legacy';
  if (billing.status === 'awaiting_first_line' && billing.first_line_activated_at === null) return 'first';
  if (billing.status === 'ended') return 'ended';
  return 'requires_payment';
}

/** Idempotently starts the configured trial on the first successful LINE connection. */
export async function activateFirstMusuboLine(db: D1Database, input: {
  tenantId: string;
  lineAccountId: string;
  friendCountExcludingBlocked?: number;
  friendCountMeasuredOn?: string;
  now?: string;
}): Promise<MusuboTenantBillingRecord | null> {
  const billing = await getMusuboTenantBilling(db, input.tenantId);
  if (!billing) return null;
  if (billing.status !== 'awaiting_first_line' || billing.first_line_activated_at !== null) {
    throw new Error('New LINE additions require payment confirmation');
  }
  const now = input.now ?? jstNow();
  if (input.friendCountExcludingBlocked !== undefined &&
    (!Number.isSafeInteger(input.friendCountExcludingBlocked) || input.friendCountExcludingBlocked < 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.friendCountMeasuredOn ?? ''))) {
    throw new RangeError('LINE friend insight is invalid');
  }
  const snapshot = JSON.parse(billing.pricing_snapshot_json) as AppliedMusuboCondition;
  const dates = musuboTrialDates(now.slice(0, 10), snapshot.trialPeriod);
  const results = await db.batch([
    db.prepare(`UPDATE musubo_tenant_billing
      SET status='trialing',first_line_activated_at=?,trial_last_free_date=?,
        first_charge_date=?,updated_at=?
      WHERE tenant_id=? AND status='awaiting_first_line' AND first_line_activated_at IS NULL`)
      .bind(now, dates.lastFreeDate, dates.firstChargeDate, now, input.tenantId),
    db.prepare(`INSERT INTO musubo_line_usage
      (line_account_id,tenant_id,status,activated_at,friend_count_excluding_blocked,friend_count_measured_on,updated_at)
      SELECT ?,?,'active',?,?,?,? WHERE changes()=1`)
      .bind(input.lineAccountId, input.tenantId, now,
        input.friendCountExcludingBlocked ?? null, input.friendCountMeasuredOn ?? null, now),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new Error('First LINE trial was already started');
  }
  return getMusuboTenantBilling(db, input.tenantId);
}
