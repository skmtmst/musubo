import { sqlIdSet } from './id-queries.js';
import { type CountRow, type DashboardOverview, type AccountStatsScope, type InboxStatusBreakdown, type InboxStatusCounts } from './dashboard-types.js';
import { jstDate } from './dashboard-freshness.js';


export async function count(db: D1Database, sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db
    .prepare(sql)
    .bind(...binds)
    .first<CountRow>();
  return row?.n ?? 0;
}

/**
 * 友だちの内訳。
 *
 * `is_following = 0` は相手がブロックしたか友だちをやめた状態、
 * `is_hidden = 1` はこちらで非表示にした状態。両方立つこともある。
 * 設計の「相手から / 自分から / 相互」はこの2列の組み合わせで出る。
 */
export async function friendBreakdown(
  db: D1Database,
  accountId: string | null,
  explicitScope?: { sql: string; binds: string[] },
): Promise<DashboardOverview['friends']> {
  const where = explicitScope ? `WHERE ${explicitScope.sql}` : accountId ? 'WHERE line_account_id = ?' : '';
  const binds = explicitScope?.binds ?? (accountId ? [accountId] : []);
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN is_following = 1 AND is_hidden = 0 THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN is_following = 0 AND is_hidden = 0 THEN 1 ELSE 0 END) AS blocked_by_them,
         SUM(CASE WHEN is_following = 1 AND is_hidden = 1 THEN 1 ELSE 0 END) AS hidden_by_us,
         SUM(CASE WHEN is_following = 0 AND is_hidden = 1 THEN 1 ELSE 0 END) AS blocked_both
       FROM friends ${where}`,
    )
    .bind(...binds)
    .first<{
      total: number;
      active: number;
      blocked_by_them: number;
      hidden_by_us: number;
      blocked_both: number;
    }>();
  return {
    total: row?.total ?? 0,
    active: row?.active ?? 0,
    blockedByThem: row?.blocked_by_them ?? 0,
    hiddenByUs: row?.hidden_by_us ?? 0,
    blockedBoth: row?.blocked_both ?? 0,
  };
}

export function accountScopeSql(scope: AccountStatsScope, column: string): { sql: string; binds: string[] } {
  if ('allTenants' in scope) return { sql: '1 = 1', binds: [] };
  const idSet = sqlIdSet(scope.allowedAccountIds);
  const placeholders = scope.allowedAccountIds.length ? idSet.sql : '';
  if (placeholders) {
    return {
      sql: `(${column} IN (${placeholders})${scope.includeUnassigned ? ` OR ${column} IS NULL` : ''})`,
      binds: sqlIdSet(scope.allowedAccountIds).binds,
    };
  }
  return { sql: scope.includeUnassigned ? `${column} IS NULL` : '1 = 0', binds: [] };
}

/**
 * 一斉配信（別名 b）の範囲。複数アカウントの重複除外の配信は、宛先の
 * アカウントの一覧（account_ids）に範囲のアカウントがあれば含める。
 */
export function broadcastScopeSql(scope: AccountStatsScope): { sql: string; binds: string[] } {
  const account = accountScopeSql(scope, 'b.line_account_id');
  const jsonAccount = accountScopeSql(scope, 'value');
  return {
    sql: `(${account.sql} OR (
    b.target_type = 'multi-account-dedup' AND b.account_ids IS NOT NULL
    AND EXISTS (SELECT 1 FROM json_each(b.account_ids) WHERE ${jsonAccount.sql})
  ))`,
    binds: [...account.binds, ...jsonAccount.binds],
  };
}

export const ZERO_BREAKDOWN: InboxStatusBreakdown = { unanswered: 0, inProgress: 0, onHold: 0, resolved: 0 };

export async function getInboxStatusCounts(
  db: D1Database,
  scope: AccountStatsScope,
): Promise<InboxStatusCounts> {
  const friendScope = accountScopeSql(scope, 'f.line_account_id');
  const includeEmail = 'allTenants' in scope ? true : scope.includeUnassigned;

  const lineRow = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'unread' THEN 1 ELSE 0 END) AS unanswered,
         SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
         SUM(CASE WHEN status = 'on_hold' THEN 1 ELSE 0 END) AS on_hold,
         SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved
       FROM (
         SELECT COALESCE(
           (SELECT c.status FROM chats c
             WHERE c.friend_id = f.id
             ORDER BY c.created_at DESC, c.id DESC LIMIT 1),
           'resolved'
         ) AS status
         FROM friends f
         WHERE ${friendScope.sql}
           AND (EXISTS (
                  SELECT 1 FROM messages_log m
                   WHERE m.friend_id = f.id
                     AND (m.delivery_type IS NULL OR m.delivery_type != 'test')
                )
             OR EXISTS (SELECT 1 FROM chats c WHERE c.friend_id = f.id))
       )`,
    )
    .bind(...friendScope.binds)
    .first<{ unanswered: number | null; in_progress: number | null; on_hold: number | null; resolved: number | null }>();
  const line: InboxStatusBreakdown = {
    unanswered: lineRow?.unanswered ?? 0,
    inProgress: lineRow?.in_progress ?? 0,
    onHold: lineRow?.on_hold ?? 0,
    resolved: lineRow?.resolved ?? 0,
  };

  let email: InboxStatusBreakdown = { ...ZERO_BREAKDOWN };
  if (includeEmail) {
    const mailRow = await db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'unread' THEN 1 ELSE 0 END) AS unanswered,
           SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
           SUM(CASE WHEN status = 'on_hold' THEN 1 ELSE 0 END) AS on_hold,
           SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved
         FROM support_email_threads`,
      )
      .first<{ unanswered: number | null; in_progress: number | null; on_hold: number | null; resolved: number | null }>();
    email = {
      unanswered: mailRow?.unanswered ?? 0,
      inProgress: mailRow?.in_progress ?? 0,
      onHold: mailRow?.on_hold ?? 0,
      resolved: mailRow?.resolved ?? 0,
    };
  }

  const storeScope = accountScopeSql(scope,'c.account_id');
  const storeRows = await db.prepare(`SELECT t.status,count(*) AS n FROM account_email_threads t
    JOIN account_email_connections c ON c.id=t.connection_id WHERE c.status='connected' AND ${storeScope.sql}
    GROUP BY t.status`).bind(...storeScope.binds).all<{status:'unread'|'in_progress'|'on_hold'|'resolved';n:number}>();
  const statusKeys = {unread:'unanswered',in_progress:'inProgress',on_hold:'onHold',resolved:'resolved'} as const;
  for (const row of storeRows.results) email[statusKeys[row.status]] += row.n;
  return {
    unanswered: line.unanswered + email.unanswered,
    inProgress: line.inProgress + email.inProgress,
    onHold: line.onHold + email.onHold,
    resolved: line.resolved + email.resolved,
    line,
    email,
  };
}

export async function inboxState(db: D1Database, scope: AccountStatsScope): Promise<DashboardOverview['inbox']> {
  const account = accountScopeSql(scope, 'f.line_account_id');
  const counts = await getInboxStatusCounts(db, scope);
  const includeEmail = 'allTenants' in scope ? true : scope.includeUnassigned;

  // 受信から初回返信までの平均。JSTの過去7日。
  // 記録が無い往復（107より前）は WHERE で外れる。
  let averageFirstReply: number | null = null;
  try {
    const avg = await db
      .prepare(
        `SELECT AVG((julianday(first_replied_at) - julianday(last_incoming_at)) * 24 * 60) AS m
           FROM chats c
           JOIN friends f ON f.id = c.friend_id
          WHERE first_replied_at IS NOT NULL
            AND last_incoming_at IS NOT NULL
            AND first_replied_at > last_incoming_at
            AND first_replied_at >= ?
            AND ${account.sql}`,
      )
      .bind(jstDate(-6), ...account.binds)
      .first<{ m: number | null }>();
    averageFirstReply = avg?.m == null ? null : Math.round(avg.m);
  } catch {
    // 107 がまだ当たっていない環境。平均だけ出ない。
  }

  // 最も古い未対応。LINE と MAIL のうち待ちが長い方（受信箱の最長待ちと同じ）。
  const oldestAt: Array<string | null> = [];
  const lineOldest = await db
    .prepare(
      `SELECT MIN(CASE WHEN c.status = 'unread' THEN c.last_message_at END) AS oldest
         FROM chats c
         JOIN friends f ON f.id = c.friend_id
        WHERE ${account.sql}`,
    )
    .bind(...account.binds)
    .first<{ oldest: string | null }>();
  oldestAt.push(lineOldest?.oldest ?? null);
  if (includeEmail) {
    const mailOldest = await db
      .prepare(
        `SELECT MIN(CASE WHEN status = 'unread' THEN last_incoming_at END) AS oldest
           FROM support_email_threads`,
      )
      .first<{ oldest: string | null }>();
    oldestAt.push(mailOldest?.oldest ?? null);
  }
  const storeScope = accountScopeSql(scope,'c.account_id');
  const storeOldest = await db.prepare(`SELECT MIN(t.last_message_at) AS oldest FROM account_email_threads t
    JOIN account_email_connections c ON c.id=t.connection_id WHERE c.status='connected' AND t.status='unread' AND ${storeScope.sql}`)
    .bind(...storeScope.binds).first<{oldest:string|null}>();
  oldestAt.push(storeOldest?.oldest ?? null);
  let oldestMinutes: number | null = null;
  for (const at of oldestAt) {
    if (!at) continue;
    const diff = Date.now() - new Date(at).getTime();
    // 未来の時刻が入っていることがある（時計ずれ）。負の経過時間は意味がないので落とす。
    const minutes = diff > 0 ? Math.floor(diff / 60000) : 0;
    oldestMinutes = oldestMinutes === null ? minutes : Math.max(oldestMinutes, minutes);
  }
  return {
    unanswered: counts.unanswered,
    inProgress: counts.inProgress,
    onHold: counts.onHold,
    resolved: counts.resolved,
    line: counts.line,
    email: counts.email,
    oldestUnansweredMinutes: oldestMinutes,
    averageFirstReplyMinutes: averageFirstReply,
  };
}
