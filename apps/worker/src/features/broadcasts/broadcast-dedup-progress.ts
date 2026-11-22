import { createBroadcastInsight, jstNow } from '@line-crm/db';

// 外部送信の途中で処理が切れた宛先は再送せず、送達不明として残す。
export async function recoverDispatchedDedupClaims(db: D1Database, broadcastId: string, lockVersion: number): Promise<void> {
  await db.prepare(`UPDATE broadcast_send_claims SET state='unknown',error_code='interrupted_dispatch'
    WHERE broadcast_id=? AND state='claimed' AND dispatched_at IS NOT NULL
    AND EXISTS(SELECT 1 FROM broadcasts WHERE id=? AND lock_version=? AND batch_offset=-1 AND stopped_at IS NULL)`)
    .bind(broadcastId, broadcastId, lockVersion).run();
}

export async function finishDedupBroadcast(db: D1Database, broadcastId: string, lockVersion: number, attemptNo: number, result: { totalCount: number; successCount: number }): Promise<void> {
  const completed = await db.prepare(`UPDATE broadcasts SET status='sent', sent_at=?, batch_lock_at=NULL,
    total_count=?, success_count=? WHERE id=? AND status='sending' AND stopped_at IS NULL
    AND batch_offset=-1 AND lock_version=? AND send_attempt_no=?`)
    .bind(jstNow(), result.totalCount, result.successCount, broadcastId, lockVersion, attemptNo).run();
  if (completed.meta.changes) await createBroadcastInsight(db, broadcastId);
}
