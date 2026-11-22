/** Preserve only contract terms needed for accounting, then clear the current contract atomically. */
export async function archiveAndResetTenantBilling(db: D1Database, tenantId: string, now: string, expiresAt: string): Promise<void> {
  if (!Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(now)) {
    throw new Error('invalid_billing_history_expiry');
  }
  await db.batch([
    db.prepare(`INSERT INTO billing_events(id,type,tenant_id,summary,received_at,retained_until)
      SELECT 'internal:purge_billing:' || tenant_id || ':' || (SELECT billing_epoch FROM tenants WHERE id=tenant_id),
        'internal.purge_billing',tenant_id,
        json_object('billing_interval',billing_interval,'status',status,
          'schedule',json_extract(pricing_snapshot_json,'$.schedule'),
          'trialPeriod',json_extract(pricing_snapshot_json,'$.trialPeriod'),
          'lineBasicDiscountPercent',json_extract(pricing_snapshot_json,'$.lineBasicDiscountPercent'),
          'discountEndsOn',json_extract(pricing_snapshot_json,'$.discountEndsOn'),
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
  ]);
}
