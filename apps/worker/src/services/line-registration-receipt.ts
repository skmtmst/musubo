export type LineRegistrationReceipt = {
  status: 'waiting' | 'confirmed' | 'error';
  receivedAt: string | null;
};

/** 登録したアカウントの署名済み Webhook が永続保存された場合だけ、登録完了へ進める。 */
export async function getLineRegistrationReceipt(
  db: D1Database,
  accountId: string,
): Promise<LineRegistrationReceipt> {
  // 両方とも JST だが、Webhook 台帳は時差接尾辞なし、アカウントとメッセージは +09:00 を使うため、同じ意味へ合わせる。
  const receipt = await db.prepare(`
    SELECT received_at FROM (
      SELECT e.received_at AS received_at
        FROM line_webhook_events e
        JOIN friend_add_events f ON f.webhook_event_id = e.webhook_event_id
          AND f.line_account_id = e.line_account_id
        JOIN friends friend ON friend.id = f.friend_id
          AND friend.line_account_id = e.line_account_id
        JOIN line_accounts account ON account.id = e.line_account_id
       WHERE e.line_account_id = ? AND e.event_type = 'follow'
         AND e.status = 'succeeded'
         AND account.is_active = 1 AND account.archived_at IS NULL
         AND e.received_at >= substr(account.created_at, 1, 23)
      UNION ALL
      SELECT m.created_at AS received_at
        FROM messages_log m
        JOIN friends friend ON friend.id = m.friend_id
          AND friend.line_account_id = m.line_account_id
        JOIN line_accounts account ON account.id = m.line_account_id
       WHERE m.line_account_id = ? AND m.direction = 'incoming'
         AND m.source = 'user' AND m.line_message_id IS NOT NULL
         AND account.is_active = 1 AND account.archived_at IS NULL
         AND m.line_message_account_key = 'account:' || m.line_account_id
         AND m.created_at >= account.created_at
    ) ORDER BY received_at DESC LIMIT 1
  `).bind(accountId, accountId).first<{ received_at: string }>();
  if (receipt) return { status: 'confirmed', receivedAt: receipt.received_at };

  const failed = await db.prepare(`
    SELECT 1 AS failed FROM line_webhook_events e
    JOIN line_accounts account ON account.id = e.line_account_id
    WHERE e.line_account_id = ? AND e.event_type IN ('follow', 'message')
      AND account.is_active = 1 AND account.archived_at IS NULL
      AND (e.status = 'failed' OR (
        e.event_type = 'follow' AND e.status = 'succeeded'
        AND NOT EXISTS (
          SELECT 1 FROM friend_add_events f JOIN friends friend ON friend.id = f.friend_id
          WHERE f.webhook_event_id = e.webhook_event_id
            AND f.line_account_id = e.line_account_id
            AND friend.line_account_id = e.line_account_id
        )
      ))
      AND e.received_at >= substr(account.created_at, 1, 23)
    LIMIT 1
  `).bind(accountId).first<{ failed: number }>();
  return { status: failed ? 'error' : 'waiting', receivedAt: null };
}
