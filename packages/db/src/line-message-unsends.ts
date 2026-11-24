export type IncomingLineMessageRecord = {
  id: string;
  inserted: boolean;
  isUnsent: boolean;
  unsentAt: string | null;
};

/**
 * LINEの受信messageをmessage ID単位で1回だけ記録する。
 *
 * 墓標の参照とINSERTを1文にまとめている。unsendと同時に届いても、
 * 「取消を先に確定したあと本文だけが復活する」隙間を作らない。
 */
export async function recordIncomingLineMessage(
  db: D1Database,
  input: {
    id: string;
    friendId: string;
    messageType: string;
    content: string;
    lineAccountId: string | null;
    lineMessageAccountKey: string;
    /** Read-only migration hint: may suppress this receipt, never authorizes mutation. */
    legacyLineMessageAccountKey?: string;
    lineMessageId: string;
    createdAt: string;
    /**
     * LINEイベントの timestamp (JST文字列)。受信の並びは起こった順
     * (こちら) を正とする。無いときは保存時刻へ倒す。
     */
    lineEventAt?: string | null;
    /** LINEが受信メッセージに付ける引用用トークン。引用返信の送信時にそのまま使う。 */
    quoteToken?: string | null;
  },
): Promise<IncomingLineMessageRecord> {
  const scoped = input.lineAccountId != null && input.lineMessageAccountKey === `account:${input.lineAccountId}`;
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO messages_log
         (id, friend_id, direction, message_type, content, broadcast_id,
          scenario_step_id, source, line_account_id, created_at,
          line_event_at,
          line_message_id, line_message_account_key, quote_token, unsent_at)
       SELECT ?, ?, 'incoming', ?,
              CASE WHEN COALESCE(u.unsent_at, legacy.unsent_at) IS NULL THEN ? ELSE '' END,
              NULL, NULL, 'user', ?, ?, ?, ?, ?, ?, COALESCE(u.unsent_at, legacy.unsent_at)
         FROM (SELECT 1) AS seed
         LEFT JOIN line_message_unsends u
           ON u.line_message_account_key = ? AND u.line_message_id = ?
         LEFT JOIN line_message_unsends legacy
           ON legacy.line_message_account_key = ? AND legacy.line_message_id = ?
          AND legacy.source_user_id = (SELECT line_platform_user_id FROM friends WHERE id = ? AND line_account_id IS ?)
        ${scoped ? `WHERE NOT EXISTS (SELECT 1 FROM messages_log existing
          WHERE existing.line_account_id = ? AND existing.line_message_id = ? AND existing.direction = 'incoming')` : ''}`,
    )
    .bind(
      input.id,
      input.friendId,
      input.messageType,
      input.content,
      input.lineAccountId,
      input.createdAt,
      input.lineEventAt ?? input.createdAt,
      input.lineMessageId,
      input.lineMessageAccountKey,
      input.quoteToken ?? null,
      input.lineMessageAccountKey,
      input.lineMessageId,
      scoped ? input.legacyLineMessageAccountKey ?? null : null,
      input.lineMessageId,
      input.friendId,
      input.lineAccountId,
      ...(scoped ? [input.lineAccountId, input.lineMessageId] : []),
    )
    .run();

  const row = await db
    .prepare(
      `SELECT id, unsent_at
         FROM messages_log
        WHERE ${scoped ? "line_account_id = ? AND direction = 'incoming'" : 'line_message_account_key = ?'} AND line_message_id = ?`,
    )
    .bind(scoped ? input.lineAccountId : input.lineMessageAccountKey, input.lineMessageId)
    .first<{ id: string; unsent_at: string | null }>();

  if (!row) throw new Error('line message record unavailable');
  return {
    id: row.id,
    inserted: (inserted.meta?.changes ?? 0) === 1,
    isUnsent: row.unsent_at != null,
    unsentAt: row.unsent_at,
  };
}

/**
 * 取消墓標の作成と、すでにある本文の消去を同じbatchで確定する。
 * 同じunsendを何度受けても同じ最終状態になる。
 */
export async function recordLineMessageUnsend(
  db: D1Database,
  input: {
    lineMessageAccountKey: string;
    lineMessageId: string;
    sourceUserId: string | null;
    /** Authenticated owner. Also cancels historical destination-key rows of this owner only. */
    lineAccountId?: string | null;
    unsentAt: string;
  },
): Promise<void> {
  if (input.lineAccountId !== undefined && (!input.lineAccountId || input.lineMessageAccountKey !== `account:${input.lineAccountId}`)) {
    throw new Error('LINE unsend account mismatch');
  }
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO line_message_unsends
         (line_message_account_key, line_message_id, source_user_id, unsent_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(
      input.lineMessageAccountKey,
      input.lineMessageId,
      input.sourceUserId,
      input.unsentAt,
    ),
    db.prepare(
      `UPDATE messages_log
          SET content = '',
              unsent_at = (
                SELECT unsent_at FROM line_message_unsends
                 WHERE line_message_account_key = ? AND line_message_id = ?
              )
        WHERE ${input.lineAccountId === undefined ? 'line_message_account_key = ?' : "line_account_id = ? AND direction = 'incoming'"} AND line_message_id = ?`,
    ).bind(
      input.lineMessageAccountKey,
      input.lineMessageId,
      input.lineAccountId === undefined ? input.lineMessageAccountKey : input.lineAccountId,
      input.lineMessageId,
    ),
  ]);
}
