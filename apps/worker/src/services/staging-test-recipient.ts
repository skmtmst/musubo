/** Allow only a currently registered test friend belonging to the sending account. */
export async function isStagingTestRecipient(db: D1Database, accountId: string, friendId: string, lineUserId: string): Promise<boolean> {
 const row = await db.prepare(`SELECT s.value FROM account_settings s
  JOIN friends f ON f.id=? AND f.line_account_id=s.line_account_id AND f.line_user_id=? AND f.is_following=1
  WHERE s.line_account_id=? AND s.key='test_recipients'`).bind(friendId,lineUserId,accountId).first<{value:string}>();
 if (!row) return false;
 try {
  const ids: unknown = JSON.parse(row.value);
  return Array.isArray(ids) && ids.length > 0 && ids.every(id => typeof id === 'string' && id.trim().length > 0) && ids.includes(friendId);
 } catch { return false; }
}
