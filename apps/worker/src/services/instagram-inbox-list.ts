import type { Env } from '../worker-env.js';

/** Instagram の会話 ID は所属アカウントと相手を含め、LINE の ID と区別する。 */
export async function instagramInboxList(db: Env['Bindings']['DB'], options: {
  accounts: string[]; staffId: string; query: string; unreadOnly: boolean;
  beforeAt?: string; beforeId?: string; beforeUnread: number | null;
  unreadFirst: boolean; limit: number;
}) {
  if (!options.accounts.length) return [];
  const rows = await db.prepare(`
    WITH ranked AS (
      SELECT m.*, ROW_NUMBER() OVER (
        PARTITION BY m.line_account_id, m.sender_id
        ORDER BY m.received_at DESC, m.id DESC
      ) AS rank
      FROM instagram_messages m
      WHERE m.line_account_id IN (SELECT value FROM json_each(?))
    ), conversations AS (
      SELECT 'ig:' || hex(m.line_account_id) || ':' || hex(m.sender_id) AS id,
        m.line_account_id, m.sender_id, m.content, m.received_at,
        CASE WHEN r.last_read_at IS NULL OR m.received_at > r.last_read_at THEN 1 ELSE 0 END AS unread
      FROM ranked m LEFT JOIN instagram_inbox_reads r
        ON r.line_account_id=m.line_account_id AND r.sender_id=m.sender_id AND r.staff_id=?
      WHERE m.rank=1
        AND (?='' OR EXISTS (SELECT 1 FROM instagram_messages search
          WHERE search.line_account_id=m.line_account_id AND search.sender_id=m.sender_id
            AND instr(lower(search.content), lower(?)) > 0) OR instr(lower(m.sender_id), lower(?)) > 0)
    )
    SELECT * FROM conversations
    WHERE (?=0 OR unread=1)
      AND (? IS NULL OR ? IS NULL OR
        (CASE WHEN ? IS NULL THEN 1 WHEN unread < ? THEN 1 WHEN unread = ? THEN 1 ELSE 0 END = 1
         AND (CASE WHEN ? IS NOT NULL AND unread < ? THEN 1
              WHEN received_at < ? OR (received_at = ? AND id < ?) THEN 1 ELSE 0 END = 1)))
    ORDER BY ${options.unreadFirst ? 'unread DESC,' : ''} received_at DESC, id DESC LIMIT ?
  `).bind(JSON.stringify(options.accounts), options.staffId, options.query, options.query, options.query,
    options.unreadOnly ? 1 : 0, options.beforeAt ?? null, options.beforeId ?? null,
    options.beforeUnread, options.beforeUnread, options.beforeUnread, options.beforeUnread, options.beforeUnread,
    options.beforeAt ?? null, options.beforeAt ?? null, options.beforeId ?? null, options.limit).all<Record<string, unknown>>();
  return rows.results.map((row) => ({
    id: String(row.id), channel: 'instagram' as const,
    friendId: row.sender_id, friendName: 'Instagramユーザー', friendPictureUrl: null,
    lineAccountId: row.line_account_id, isAttention: false, operatorId: null, operatorName: null,
    status: row.unread ? 'unread' : 'resolved', revision: 0, notes: null, lastMessageAt: String(row.received_at),
    lastMessageContent: row.content, lastMessageDirection: 'incoming', lastMessageType: 'text',
    isUnread: Boolean(row.unread), createdAt: row.received_at, updatedAt: row.received_at,
  }));
}
