import type { Env } from '../worker-env.js';
import { accountFeatureIsEnabled } from './feature-enforcement.js';

type Database = Env['Bindings']['DB'];
type Filters = { accounts: string[]; staffId: string; query: string; unreadOnly: boolean };

// The core LINE inbox remains available when a store disables external integrations.
// Check only stores with DM history, including sent history left after an inbound expires.
async function readableAccounts(db: Database, accounts: string[]) {
  const stores = await db.prepare(`WITH allowed AS (SELECT value FROM json_each(?))
    SELECT DISTINCT line_account_id FROM instagram_messages WHERE line_account_id IN allowed
    UNION SELECT DISTINCT line_account_id FROM instagram_outbound_messages WHERE line_account_id IN allowed AND status='sent'`)
    .bind(JSON.stringify(accounts)).all<{ line_account_id: string }>();
  const enabled = await Promise.all(stores.results.map(async ({ line_account_id }) =>
    await accountFeatureIsEnabled(db, line_account_id, 'external_integrations') ? line_account_id : null));
  return enabled.filter(id => id !== null);
}

export const instagramIncomingPreviewSql = "CASE WHEN content='' AND json_array_length(attachments_json)>0 THEN '添付ファイル（Instagramで確認）' ELSE content END";

const conversations = `WITH allowed AS (SELECT value FROM json_each(?)),
  messages AS (
    SELECT id,line_account_id,instagram_id,sender_id,${instagramIncomingPreviewSql} AS content,received_at,'incoming' AS direction
      FROM instagram_messages WHERE line_account_id IN allowed
    UNION ALL
    SELECT idempotency_key,line_account_id,instagram_id,sender_id,content,sent_at,'outgoing'
      FROM instagram_outbound_messages WHERE line_account_id IN allowed AND status='sent'
  ), ranked AS (
    SELECT m.*,
      ROW_NUMBER() OVER (PARTITION BY line_account_id,instagram_id,sender_id
        ORDER BY received_at DESC,(direction='outgoing') DESC,id DESC) AS rank,
      MAX(CASE WHEN direction='incoming' THEN received_at END) OVER conversation AS last_incoming,
      MAX(instr(lower(content),lower(?))) OVER conversation AS content_match
    FROM messages m
    WINDOW conversation AS (PARTITION BY line_account_id,instagram_id,sender_id)
  ), conversations AS (
    SELECT 'ig:' || hex(m.line_account_id) || ':' || hex(m.instagram_id) || ':' || hex(m.sender_id) AS id,
      m.line_account_id,m.instagram_id,m.sender_id,substr(m.content,1,200) AS content,m.received_at,m.direction,
      CASE WHEN m.last_incoming > COALESCE(r.last_read_at,'') THEN 1 ELSE 0 END AS unread
    FROM ranked m LEFT JOIN instagram_inbox_reads r ON r.line_account_id=m.line_account_id
      AND r.sender_id=json_array(m.instagram_id,m.sender_id) AND r.staff_id=?
    WHERE rank=1 AND (content_match>0 OR instr(lower(m.sender_id),lower(?))>0)
  )`;

export async function instagramInboxList(db: Database, options: Filters & {
  beforeAt?: string; beforeId?: string; beforeUnread: number | null;
  unreadFirst: boolean; limit: number; replyOnly?: boolean;
}) {
  const accounts = await readableAccounts(db, options.accounts);
  if (!accounts.length) return [];
  const bindings: (string | number)[] = [JSON.stringify(accounts), options.query, options.staffId, options.query];
  const predicates = ['1=1'];
  if (options.unreadOnly) predicates.push('unread=1');
  if (options.replyOnly) predicates.push("direction='incoming'");
  if (options.beforeAt && options.beforeId) {
    if (options.unreadFirst && options.beforeUnread !== null) {
      predicates.push('(unread,received_at,id) < (?,?,?)');
      bindings.push(options.beforeUnread);
    } else {
      predicates.push('(received_at,id) < (?,?)');
    }
    bindings.push(options.beforeAt, options.beforeId);
  }
  const rows = await db.prepare(`${conversations} SELECT * FROM conversations WHERE ${predicates.join(' AND ')}
    ORDER BY ${options.unreadFirst ? 'unread DESC,' : ''} received_at DESC,id DESC LIMIT ?`)
    .bind(...bindings, options.limit).all<Record<string, unknown>>();
  return rows.results.map(row => ({
    id: String(row.id), channel: 'instagram' as const,
    instagramId: row.instagram_id, friendId: row.sender_id, friendName: 'Instagramユーザー', friendPictureUrl: null,
    lineAccountId: row.line_account_id, isAttention: false, operatorId: null, operatorName: null,
    status: row.unread ? 'unread' : 'resolved', revision: 0, notes: null, lastMessageAt: String(row.received_at),
    lastMessageContent: row.content, lastMessageDirection: row.direction, lastMessageType: 'text',
    isUnread: Boolean(row.unread), createdAt: row.received_at, updatedAt: row.received_at,
  }));
}

export async function instagramInboxCounts(db: Database, options: Filters) {
  const accounts = await readableAccounts(db, options.accounts);
  if (!accounts.length) return { all: 0, reply: 0, overdue: 0 };
  const row = await db.prepare(`${conversations} SELECT COUNT(*) AS total,SUM(direction='incoming') AS replies
    FROM conversations WHERE (?=0 OR unread=1)`).bind(JSON.stringify(accounts), options.query, options.staffId,
      options.query, Number(options.unreadOnly)).first<{ total: number; replies: number | null }>();
  return { all: row?.total ?? 0, reply: row?.replies ?? 0, overdue: 0 };
}
