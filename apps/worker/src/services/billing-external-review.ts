/** Surface uncertain billing effects after the original processing lease has expired. */
export async function observeUncertainBillingEffects(db:D1Database, now:string):Promise<number> {
  if (!Number.isFinite(Date.parse(now))) throw new Error('invalid_billing_review_time');
  const rows=await db.prepare(`SELECT id,tenant_id FROM billing_events
    WHERE external_effect_pending=1 AND tenant_id IS NOT NULL
      AND (lease_until IS NULL OR julianday(lease_until)<=julianday(?)) ORDER BY received_at,id LIMIT 100`)
    .bind(now).all<{id:string;tenant_id:string}>();
  for (const row of rows.results) {
    await db.prepare(`INSERT INTO security_alerts
      (id,tenant_id,line_account_id,scope_key,rule_key,observed_count,threshold_count,first_detected_at,last_detected_at,latest_event_at,notification_id,slack_last_error)
      VALUES (?,?,NULL,json_array(?,?),'stripe_external_effect_review',1,1,?,?,julianday(?),?,'unconfigured')
      ON CONFLICT(scope_key,rule_key) DO UPDATE SET
        last_detected_at=excluded.last_detected_at,latest_event_at=excluded.latest_event_at,
        status=CASE WHEN security_alerts.status='resolved' THEN 'open' ELSE security_alerts.status END,
        version=security_alerts.version+CASE WHEN security_alerts.status='resolved' THEN 1 ELSE 0 END,
        reviewed_at=CASE WHEN security_alerts.status='resolved' THEN NULL ELSE security_alerts.reviewed_at END`)
      .bind(crypto.randomUUID(),row.tenant_id,row.tenant_id,row.id,now,now,now,crypto.randomUUID()).run();
  }
  return rows.results.length;
}

/** Missing historical keys prevent safely matching a signed Stripe notification. */
export async function observeBillingHashKeyUnavailable(db:D1Database, tenantId:string, now:string):Promise<void> {
  await db.prepare(`INSERT INTO security_alerts
    (id,tenant_id,line_account_id,scope_key,rule_key,observed_count,threshold_count,first_detected_at,last_detected_at,latest_event_at,notification_id,slack_last_error)
    SELECT ?,t.id,NULL,json_array(t.id,'hash-key'),'stripe_hash_key_review',1,1,?,?,julianday(?),?,'unconfigured' FROM tenants t WHERE t.id=?
    ON CONFLICT(scope_key,rule_key) DO UPDATE SET last_detected_at=excluded.last_detected_at,latest_event_at=excluded.latest_event_at,
      status=CASE WHEN security_alerts.status='resolved' THEN 'open' ELSE security_alerts.status END,
      version=security_alerts.version+CASE WHEN security_alerts.status='resolved' THEN 1 ELSE 0 END`)
    .bind(crypto.randomUUID(),now,now,now,crypto.randomUUID(),tenantId).run();
}
