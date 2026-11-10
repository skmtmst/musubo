import { getMusuboIndividualQuote, musuboQuoteFromRecord,
  type MusuboTenantBillingRecord } from '@line-crm/db';
import type { AppliedMusuboCondition } from '@line-crm/shared';
import { firstMusuboCoreTerms } from './musubo-contract-terms.js';

export interface MusuboFinalLineNoticeSnapshot {
  lineName: string;
  interval: 'month' | 'year';
  endAt?: string;
  lastUsableAt?: string;
  nextChargeAt?: string;
  nextChargeYen?: number;
}

export function finalLineNoticeInsert(db: D1Database, input: {
  tenantId: string; event: 'scheduled' | 'immediate' | 'cancelled';
  requestedAt: string; createdAt: string; snapshot: MusuboFinalLineNoticeSnapshot;
}): D1PreparedStatement {
  const id = `musubo-final-line:${input.tenantId}:${input.requestedAt}:${input.event}`;
  return db.prepare(`INSERT OR IGNORE INTO musubo_final_line_notices
    (id,tenant_id,event,snapshot_json,created_at) VALUES (?,?,?,?,?)`)
    .bind(id, input.tenantId, input.event, JSON.stringify(input.snapshot), input.createdAt);
}

export async function cancellationNoticeSnapshot(db: D1Database,
  billing: MusuboTenantBillingRecord, lineName: string,
  now: string): Promise<MusuboFinalLineNoticeSnapshot> {
  const snapshot: MusuboFinalLineNoticeSnapshot = {
    lineName, interval: billing.billing_interval,
  };
  const chargeDate = (billing.billing_interval === 'year'
    ? billing.next_annual_renewal_at : billing.next_monthly_charge_at) ?? billing.first_charge_date;
  if (!chargeDate || Date.parse(`${chargeDate}T00:00:00+09:00`) <= Date.parse(now)) return snapshot;
  const quoteRow = billing.quote_id ? await getMusuboIndividualQuote(db, billing.quote_id) : null;
  if (billing.quote_id && (!quoteRow || quoteRow.tenant_id !== billing.tenant_id
    || quoteRow.status !== 'accepted')) throw new Error('Accepted quote is unavailable');
  const condition = JSON.parse(billing.pricing_snapshot_json) as AppliedMusuboCondition;
  const amountYen = firstMusuboCoreTerms({ condition,
    quote: quoteRow ? musuboQuoteFromRecord(quoteRow) : null,
    interval: billing.billing_interval, firstChargeDate: chargeDate }).amountYen;
  return { ...snapshot, nextChargeAt: `${chargeDate}T00:00:00+09:00`, nextChargeYen: amountYen };
}
