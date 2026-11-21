/** 4回とも未入金が確定している場合だけ、停止と2種類の通知予約を一緒に記録する。 */
export async function stopExhaustedMonthlyCycle(db: D1Database, cycleId: string, now = new Date()) {
  const at = now.toISOString();
  const result = await db.batch([
    db.prepare(`UPDATE booking_monthly_cycles SET state='exhausted',version=version+1,updated_at=?
      WHERE id=? AND kind='renewal' AND state IN ('open','retry_wait','requires_action') AND invoice_status='open'
      AND (SELECT count(*) FROM booking_monthly_attempts WHERE cycle_id=? AND state='failed')=4
      AND NOT EXISTS(SELECT 1 FROM booking_monthly_attempts WHERE cycle_id=? AND state!='failed')
      AND EXISTS(SELECT 1 FROM booking_monthly_contracts c WHERE c.id=booking_monthly_cycles.contract_id AND c.state IN ('active','stop_scheduled'))`)
      .bind(at,cycleId,cycleId,cycleId),
    db.prepare(`UPDATE booking_monthly_contracts SET state='stopped',stop_reason=CASE WHEN state='stop_scheduled' THEN stop_reason ELSE 'unpaid' END,
      stop_effective_at=CASE WHEN stop_effective_at IS NOT NULL AND julianday(stop_effective_at)<julianday(?) THEN stop_effective_at ELSE ? END,
      version=version+1,updated_at=? WHERE id=(SELECT contract_id FROM booking_monthly_cycles WHERE id=?) AND changes()=1`)
      .bind(at,at,at,cycleId),
    db.prepare(`INSERT INTO booking_monthly_failure_notices(cycle_id,audience,account_id,friend_id,created_at)
      SELECT y.id,a.audience,c.account_id,c.friend_id,? FROM booking_monthly_cycles y JOIN booking_monthly_contracts c ON c.id=y.contract_id
      CROSS JOIN (SELECT 'friend' audience UNION ALL SELECT 'store') a WHERE y.id=? AND y.state='exhausted' AND c.state='stopped'
      ON CONFLICT(cycle_id,audience) DO NOTHING`).bind(at,cycleId),
  ]);
  return { stopped: result[0]?.meta.changes === 1 };
}
