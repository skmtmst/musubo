/** 対象の交換を一度だけ手渡し済みにする。取消との競合も同じ行で判定する。 */
export async function deliverHandgift(
  db: D1Database,
  input: { accountId: string; redemptionId: string; actorId: string },
): Promise<boolean> {
  const now = new Date().toISOString();
  const results = await db.batch([db.prepare(`
    INSERT INTO mileage_handgifts (redemption_id, reward_id, delivered_at, delivered_by)
    SELECT r.id, r.reward_id, ?, ?
      FROM mileage_redemptions r
      JOIN mileage_handgift_rewards h ON h.reward_id = r.reward_id
     WHERE r.id = ? AND r.line_account_id = ? AND r.status = 'reserved'
       AND r.spend_ledger_entry_id IS NOT NULL AND r.reward_code_id IS NULL
    ON CONFLICT(redemption_id) DO UPDATE SET
      delivered_at = excluded.delivered_at, delivered_by = excluded.delivered_by
    WHERE mileage_handgifts.delivered_at IS NULL AND mileage_handgifts.cancelled_at IS NULL
  `).bind(now, input.actorId, input.redemptionId, input.accountId),
    db.prepare(`UPDATE mileage_redemptions SET status = 'succeeded', delivered_at = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'reserved'
        AND EXISTS (SELECT 1 FROM mileage_handgifts h WHERE h.redemption_id = mileage_redemptions.id
          AND h.delivered_at = ? AND h.delivered_by = ? AND h.cancelled_at IS NULL)`)
      .bind(now, now, input.redemptionId, input.accountId, now, input.actorId),
  ]);
  return (results[0]?.meta?.changes ?? 0) === 1 && (results[1]?.meta?.changes ?? 0) === 1;
}
