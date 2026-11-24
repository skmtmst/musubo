export const threads = `FROM account_email_threads t JOIN account_email_connections c ON c.id=t.connection_id`;
export const visible = "c.account_id=? AND c.status='connected'";
export const latest =
  '(SELECT id FROM account_email_messages WHERE thread_id=t.id ORDER BY created_at DESC,id DESC LIMIT 1)';
const readJoin = ' LEFT JOIN account_email_reads r ON r.thread_id=t.id AND r.staff_id=?';
export const unread = `(r.last_message_id IS NOT ${latest})`;
export type StoreEmailFilter = {
  statuses: readonly string[];
  needsReply?: boolean;
  matchUnassigned: boolean;
  query?: string;
  unreadOnly?: boolean;
  overdue?: boolean;
  from?: string | null;
  to?: string | null;
};
export function emailStatuses(status = 'open'): string[] {
  const all = ['unread', 'in_progress', 'on_hold', 'resolved'];
  if (status === 'open') return all.slice(0, 3);
  return status === 'all' ? all : [status];
}
export function storeEmailFilter(filter: StoreEmailFilter) {
  const terms = [visible];
  const binds: string[] = [];
  if (!filter.matchUnassigned) terms.push('0=1');
  terms.push('t.status IN (SELECT value FROM json_each(?))');
  binds.push(JSON.stringify(filter.statuses));
  if (filter.needsReply || filter.overdue) terms.push("t.status='unread'");
  if (filter.unreadOnly) terms.push(unread);
  if (filter.overdue) terms.push("julianday(t.last_message_at)<=julianday('now','-1 hour')");
  if (filter.from) {
    terms.push('t.last_message_at>=?');
    binds.push(filter.from);
  }
  if (filter.to) {
    terms.push('t.last_message_at<=?');
    binds.push(filter.to);
  }
  if (filter.query) {
    terms.push(`(instr(lower(t.customer_email),lower(?)) OR instr(lower(t.customer_name),lower(?))
      OR instr(lower(t.subject),lower(?)) OR EXISTS (SELECT 1 FROM account_email_messages s
        WHERE s.thread_id=t.id AND instr(lower(s.body_text),lower(?))))`);
    binds.push(filter.query, filter.query, filter.query, filter.query);
  }
  return { sql: threads + readJoin + ' WHERE ' + terms.join(' AND '), binds };
}

/** Legacy support access and this account's forwarding connection are distinct capabilities. */
export async function accountEmailMode(
  db: D1Database,
  accountId: string | undefined,
  canSeeUnassigned: boolean,
) {
  if (!accountId) return canSeeUnassigned ? 'legacy' : 'none';
  const row = await db
    .prepare(
      `SELECT
    EXISTS(SELECT 1 FROM account_email_connections WHERE account_id=? AND status='connected') AS connected,
    EXISTS(SELECT 1 FROM account_settings WHERE line_account_id=? AND key='inbox_email_legacy_enabled' AND value='true') AS legacy`,
    )
    .bind(accountId, accountId)
    .first<{ connected: number; legacy: number }>();
  if (row?.connected && row.legacy && canSeeUnassigned) return 'both';
  if (row?.connected) return 'store';
  return row?.legacy && canSeeUnassigned ? 'legacy' : 'none';
}
