/** Preserve only contract terms needed for accounting, then clear the current contract atomically. */
export async function archiveAndResetTenantBilling(db: D1Database, tenantId: string, now: string, expiresAt: string): Promise<void> {
  if (!Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(now)) {
    throw new Error('invalid_billing_history_expiry');
  }
  await db.batch([
    db.prepare(`INSERT INTO billing_events(id,type,tenant_id,summary,received_at,retained_until)
      SELECT 'internal:purge_legacy_billing:' || id || ':' || billing_epoch,'internal.purge_legacy_billing',id,
        json_object('plan_key',plan_key,'plan_status',plan_status,'trial_ends_at',trial_ends_at,
          'current_period_ends_at',current_period_ends_at),?,? FROM tenants
      WHERE id=? AND purge_started_at IS NOT NULL AND data_purged_at IS NULL
      ON CONFLICT(id) DO NOTHING`).bind(now,expiresAt,tenantId),
    db.prepare(`INSERT INTO billing_events(id,type,tenant_id,summary,received_at,retained_until)
      SELECT 'internal:purge_billing:' || tenant_id || ':' || (SELECT billing_epoch FROM tenants WHERE id=tenant_id),
        'internal.purge_billing',tenant_id,
        json_object('billing_interval',billing_interval,'status',status,
          'schedule',json_extract(pricing_snapshot_json,'$.schedule'),
          'trialPeriod',json_extract(pricing_snapshot_json,'$.trialPeriod'),
          'lineBasicDiscountPercent',json_extract(pricing_snapshot_json,'$.lineBasicDiscountPercent'),
          'discountEndsOn',json_extract(pricing_snapshot_json,'$.discountEndsOn'),
          'quotedSchedule',json_extract((SELECT final_prices_json FROM musubo_individual_quotes WHERE id=quote_id),'$.finalSchedule'),
          'quotedAnnualYen',json_extract((SELECT final_prices_json FROM musubo_individual_quotes WHERE id=quote_id),'$.finalAnnualLineChargeYen'),
          'first_line_activated_at',first_line_activated_at,'first_charge_date',first_charge_date,
          'ended_at',ended_at,'termination_effective_at',termination_effective_at),?,?
      FROM musubo_tenant_billing WHERE tenant_id=? AND EXISTS (
        SELECT 1 FROM tenants WHERE id=? AND purge_started_at IS NOT NULL AND data_purged_at IS NULL)
      ON CONFLICT(id) DO NOTHING`).bind(now, expiresAt, tenantId, tenantId),
    db.prepare(`UPDATE musubo_tenant_billing SET application_id=NULL,quote_id=NULL,
      pricing_snapshot_json='{}',pricing_selection_json=NULL,pricing_consented_at=NULL,
      billing_interval='month',status='ended',first_line_activated_at=NULL,trial_last_free_date=NULL,
      first_charge_date=NULL,trial_started_mail_sent_at=NULL,trial_ending_mail_sent_at=NULL,
      core_subscription_id=NULL,options_subscription_id=NULL,next_monthly_charge_at=NULL,
      next_annual_renewal_at=NULL,termination_requested_at=NULL,termination_effective_at=NULL,
      termination_synced_at=NULL,ended_at=NULL,resumption_generation=0,resumption_offer_json=NULL,
      resumption_consented_at=NULL,resumption_requested_at=NULL,resumption_line_account_id=NULL,
      resumption_friend_count=NULL,resumption_friend_measured_on=NULL,resumed_at=NULL,updated_at=?
      WHERE tenant_id=? AND EXISTS (SELECT 1 FROM billing_events e JOIN tenants t ON t.id=e.tenant_id
        WHERE e.id='internal:purge_billing:' || musubo_tenant_billing.tenant_id || ':' || t.billing_epoch
          AND t.purge_started_at IS NOT NULL AND t.data_purged_at IS NULL)`)
      .bind(now, tenantId),
    db.prepare('UPDATE billing_invoices SET stripe_customer_id=NULL,subscription_id=NULL,hosted_invoice_url=NULL WHERE tenant_id=?').bind(tenantId),
    db.prepare(`UPDATE billing_events SET summary=json_remove(summary,'$.subscriptionId','$.customerId')
      WHERE tenant_id=? AND json_valid(summary) AND type NOT IN ('internal.purge_billing','internal.purge_legacy_billing')`).bind(tenantId),
    db.prepare(`UPDATE tenants SET stripe_customer_id=NULL,stripe_subscription_id=NULL,current_period_ends_at=NULL,plan_key=NULL,plan_updated_at=?
      WHERE id=? AND purge_started_at IS NOT NULL AND data_purged_at IS NULL`)
      .bind(now,tenantId),
  ]);
}

/** Remove expired internal history without affecting ordinary webhook receipts. */
export async function deleteExpiredBillingHistory(db: D1Database, now: string): Promise<number> {
  if (!Number.isFinite(Date.parse(now))) throw new Error('invalid_billing_history_expiry');
  const result = await db.prepare(`DELETE FROM billing_events WHERE rowid IN (
    SELECT rowid FROM billing_events WHERE type IN ('internal.purge_billing','internal.purge_legacy_billing')
      AND retained_until IS NOT NULL AND julianday(retained_until)<=julianday(?) LIMIT 200)`).bind(now).run();
  return Number(result.meta.changes ?? 0);
}
