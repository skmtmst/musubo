import { refundMileageRewardRedemption } from '@line-crm/db';

/** 取消の記録と交換状態を同時に確定し、その後、既存の冪等な返却処理で残高を戻す。 */
export async function cancelHandgift(db: D1Database, input: {
  accountId: string; redemptionId: string; actorId: string; reason: string; expectedStatus: 'reserved' | 'succeeded';
}): Promise<'completed' | 'pending' | 'conflict'> {
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(`INSERT INTO mileage_handgifts (redemption_id, reward_id, cancelled_at, cancelled_by, cancellation_reason)
      SELECT r.id, r.reward_id, ?, ?, ? FROM mileage_redemptions r
      JOIN mileage_handgift_rewards h ON h.reward_id = r.reward_id
      WHERE r.id = ? AND r.line_account_id = ? AND r.status = ?
        AND r.spend_ledger_entry_id IS NOT NULL AND r.reward_code_id IS NULL
        AND (r.status = 'reserved' OR EXISTS (SELECT 1 FROM mileage_handgifts g
          WHERE g.redemption_id = r.id AND g.delivered_at IS NOT NULL AND g.cancelled_at IS NULL))
      ON CONFLICT(redemption_id) DO UPDATE SET cancelled_at = excluded.cancelled_at,
        cancelled_by = excluded.cancelled_by, cancellation_reason = excluded.cancellation_reason
      WHERE mileage_handgifts.cancelled_at IS NULL`)
      .bind(now, input.actorId, input.reason, input.redemptionId, input.accountId, input.expectedStatus),
    db.prepare(`UPDATE mileage_redemptions SET status = 'refunded', refunded_at = ?, updated_at = ?, next_retry_at = NULL
      WHERE id = ? AND line_account_id = ? AND status IN ('reserved', 'succeeded')
        AND EXISTS (SELECT 1 FROM mileage_handgifts h WHERE h.redemption_id = mileage_redemptions.id
          AND h.cancelled_at = ? AND h.cancelled_by = ? AND h.cancellation_reason = ?)`)
      .bind(now, now, input.redemptionId, input.accountId, now, input.actorId, input.reason),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
    const existing = await db.prepare(`SELECT h.cancellation_reason FROM mileage_handgifts h
      JOIN mileage_redemptions r ON r.id = h.redemption_id
      WHERE r.id = ? AND r.line_account_id = ? AND r.status = 'refunded' AND h.cancelled_at IS NOT NULL`)
      .bind(input.redemptionId, input.accountId).first<{ cancellation_reason: string }>();
    if (!existing) return 'conflict';
    try { await refundMileageRewardRedemption(db, { redemptionId: input.redemptionId, reason: existing.cancellation_reason }); return 'completed'; }
    catch { return 'pending'; }
  }
  // 途中で停止しても既存の未完了返却の回復処理が台帳と内訳を修復する。
  try { await refundMileageRewardRedemption(db, { redemptionId: input.redemptionId, reason: input.reason }); return 'completed'; }
  catch { return 'pending'; }
}
