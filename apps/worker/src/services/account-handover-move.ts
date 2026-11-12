import { assertChanged, clearAssertions } from '../features/booking/booking-series/index.js';

/** 更新と実績の保存は一緒に成功する。記録できない移動は巻き戻る。 */
export async function moveHandoverFriend(db: D1Database, input: { handoverId: string; friendId: string; fromAccountId: string; toAccountId: string; targetFriendId: string | null }): Promise<boolean> {
  const [result] = await db.batch([
    db.prepare(`UPDATE friends SET line_account_id = ? WHERE id = ? AND line_account_id = ?
      AND (? IS NULL OR EXISTS(SELECT 1 FROM friends target WHERE target.id=? AND target.line_account_id=?))
      AND EXISTS(SELECT 1 FROM account_handovers h JOIN line_accounts src ON src.id=h.from_account_id JOIN line_accounts dst ON dst.id=h.to_account_id
        WHERE h.id=? AND h.status='executing' AND h.from_account_id=? AND h.to_account_id=?
          AND COALESCE(src.tenant_id,'00000000-0000-4000-8000-000000000001')=COALESCE(dst.tenant_id,'00000000-0000-4000-8000-000000000001'))`)
      .bind(input.toAccountId,input.friendId,input.fromAccountId,input.targetFriendId,input.targetFriendId,input.toAccountId,input.handoverId,input.fromAccountId,input.toAccountId),
    db.prepare(`INSERT INTO account_handover_moves(handover_id,friend_id,from_account_id,to_account_id,tenant_id,moved_at)
      SELECT ?,?,?,?,COALESCE(a.tenant_id,'00000000-0000-4000-8000-000000000001'),? FROM line_accounts a WHERE a.id=? AND changes()=1`)
      .bind(input.handoverId,input.friendId,input.fromAccountId,input.toAccountId,new Date().toISOString(),input.fromAccountId),
    assertChanged(db), clearAssertions(db),
  ]);
  return Number(result.meta.changes) === 1;
}
