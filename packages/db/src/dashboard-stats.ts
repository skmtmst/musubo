import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { sqlIdSet } from './id-queries.js';
import type { FriendActiveMonthComparison as importFriendActiveMonthComparison } from '@line-crm/shared';
import { type AccountStatsScope, type InboxStats, type FriendStats, type BroadcastStatsScope, type BroadcastStats } from './dashboard-types.js';
import { jstDate, nextDate, nextMonth } from './dashboard-freshness.js';
import { accountScopeSql, count, inboxState, friendBreakdown } from './dashboard-inbox.js';
import { snapshotScopeSql, UNASSIGNED_SNAPSHOT_ACCOUNT_ID } from './dashboard-snapshots.js';


/**
 * 受信箱の集計。
 *
 * 設計の4枚目「平均の初回返信」は、返信までの時間を記録していないので出せない。
 * 代わりに「1時間以上待たせている件数」を1枚目の内訳として出す。
 * どちらも「放置に気づく」ための数で、役割は同じ。
 */
export async function getInboxStats(
  db: D1Database,
  operatorId: string | null,
  scope: AccountStatsScope,
): Promise<InboxStats> {
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const today = jstDate(0);

  const friendScope = accountScopeSql(scope, 'f.line_account_id');
  const messageScope = accountScopeSql(scope, 'line_account_id');
  const waiting = await db
    .prepare(
      `SELECT
         COUNT(*) AS n,
         SUM(CASE WHEN last_message_at < ? THEN 1 ELSE 0 END) AS over_hour,
         CAST((julianday('now') - julianday(MIN(last_message_at))) * 1440 AS INTEGER) AS oldest_minutes
       FROM chats c JOIN friends f ON f.id = c.friend_id
       WHERE c.status = 'unread' AND ${friendScope.sql}`,
    )
    .bind(hourAgo, ...friendScope.binds)
    .first<{ n: number; over_hour: number; oldest_minutes: number | null }>();

  const mine = operatorId
    ? await count(
        db,
        `SELECT COUNT(*) AS n FROM chats c JOIN friends f ON f.id = c.friend_id WHERE c.status = 'in_progress' AND c.assignee_staff_id = ? AND ${friendScope.sql}`,
        operatorId, ...friendScope.binds,
      )
    : await count(db, `SELECT COUNT(*) AS n FROM chats c JOIN friends f ON f.id = c.friend_id WHERE c.status = 'in_progress' AND ${friendScope.sql}`, ...friendScope.binds);

  const assigneeUnreadRows = await db
    .prepare(
      `SELECT COALESCE(CASE WHEN c.assignee_staff_id IS NOT NULL THEN 'staff:' || c.assignee_staff_id END, c.operator_id) AS operator_id, CASE WHEN c.assignee_staff_id IS NOT NULL THEN COALESCE(sm.name, '担当者不明') WHEN c.operator_id IS NOT NULL THEN COALESCE(o.name, '担当者不明') ELSE NULL END AS operator_name, COUNT(*) AS unread
         FROM chats c
         JOIN friends f ON f.id = c.friend_id
         LEFT JOIN operators o ON o.id = c.operator_id
         LEFT JOIN staff_members sm ON sm.id = c.assignee_staff_id
        WHERE c.status = 'unread' AND ${friendScope.sql}
        GROUP BY COALESCE(CASE WHEN c.assignee_staff_id IS NOT NULL THEN 'staff:' || c.assignee_staff_id END, c.operator_id), operator_name
        ORDER BY CASE WHEN COALESCE(CASE WHEN c.assignee_staff_id IS NOT NULL THEN 'staff:' || c.assignee_staff_id END, c.operator_id) IS NULL THEN 0 ELSE 1 END,
                 operator_name ASC, operator_id ASC`,
    )
    .bind(...friendScope.binds)
    .all<{ operator_id: string | null; operator_name: string | null; unread: number }>();

  // source は 'line' 以外にメール由来などが入る。line 以外をまとめてメール扱いに
  // すると、将来 source が増えたときに黙って混ざる。line と email だけを数える。
  const byChannel = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN source = 'line' OR source IS NULL THEN 1 ELSE 0 END) AS line_n,
         SUM(CASE WHEN source = 'email' THEN 1 ELSE 0 END) AS email_n,
         COUNT(*) AS total
       FROM messages_log
        WHERE direction = 'incoming' AND created_at >= ? AND created_at < ? AND ${messageScope.sql}`,
    )
    .bind(today, nextDate(today), ...messageScope.binds)
    .first<{ line_n: number; email_n: number; total: number }>();

  const inbox = await inboxState(db, scope);

  return {
    averageFirstReplyMinutes: inbox.averageFirstReplyMinutes,
    waiting: waiting?.n ?? 0,
    oldestWaitingMinutes: waiting?.oldest_minutes ?? null,
    waitingOverAnHour: waiting?.over_hour ?? 0,
    mine,
    todayInbound: byChannel?.total ?? 0,
    todayByChannel: { line: byChannel?.line_n ?? 0, email: byChannel?.email_n ?? 0 },
    assigneeUnread: assigneeUnreadRows.results.map((row) => ({
      operatorId: row.operator_id,
      operatorName: row.operator_name,
      unread: Number(row.unread),
    })),
  };
}

/** 前月末の記録が可視対象すべてに揃う場合だけ合計する。 */
export async function getFriendActiveMonthComparison(db: D1Database, scope: AccountStatsScope, active: number, nowMs = Date.now()): Promise<importFriendActiveMonthComparison> {
  const now = japanCalendar(new Date(nowMs));
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
  const filter = snapshotScopeSql(scope);
  const row = await db.prepare(`SELECT COUNT(*) AS recorded, SUM(active) AS active FROM friend_daily_snapshots WHERE date = ? AND ${filter.sql}`)
    .bind(day, ...filter.binds).first<{ recorded: number; active: number | null }>();
  const expected = 'allTenants' in scope
    ? (await db.prepare('SELECT COUNT(*) + 1 AS total FROM line_accounts').first<{ total: number }>())?.total ?? 0
    : new Set([...scope.allowedAccountIds, ...(scope.includeUnassigned ? [UNASSIGNED_SNAPSHOT_ACCOUNT_ID] : [])]).size;
  const previous = row?.recorded === expected && expected > 0 ? Number(row.active ?? 0) : null;
  return { activeLastMonth: previous, activeMonthDelta: previous === null ? null : active - previous, activeComparisonDate: day };
}

/**
 * 友だち画面の集計。
 *
 * ダッシュボードの overview と数え方を揃えている。同じ「有効友だち」が
 * 画面によって違う数だと、どちらが正しいのか分からなくなる。
 */
export async function getFriendStats(
  db: D1Database,
  scope: AccountStatsScope,
): Promise<FriendStats> {
  const friendScope = accountScopeSql(scope, 'line_account_id');
  const breakdownScope = accountScopeSql(scope, 'line_account_id');
  const breakdown = await friendBreakdown(db, null, breakdownScope);
  const statusScope = accountScopeSql(scope, 'f.line_account_id');
  const statuses = await db.prepare(`SELECT
      SUM(CASE WHEN status = 'unread' THEN 1 ELSE 0 END) AS unanswered,
      SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved
    FROM (
      SELECT COALESCE((SELECT c.status FROM chats c WHERE c.friend_id = f.id
        ORDER BY c.created_at DESC, c.id DESC LIMIT 1), 'resolved') AS status
      FROM friends f WHERE f.data_purged_at IS NULL AND ${statusScope.sql}
    )`).bind(...statusScope.binds).first<{ unanswered: number | null; resolved: number | null }>();

  // JST の月の頭。月をまたぐ集計は UTC のままだと9時間ずれる。
  const now = japanCalendar();
  const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;

  const bindsFor = (month: string) => [`${month}-01`, `${nextMonth(month)}-01`, ...friendScope.binds];
  const [addedThisMonth, addedLastMonth] = await Promise.all([
    count(db, `SELECT COUNT(*) AS n FROM friends WHERE data_purged_at IS NULL AND created_at >= ? AND created_at < ? AND ${friendScope.sql}`, ...bindsFor(thisMonth)),
    count(db, `SELECT COUNT(*) AS n FROM friends WHERE data_purged_at IS NULL AND created_at >= ? AND created_at < ? AND ${friendScope.sql}`, ...bindsFor(lastMonth)),
  ]);

  return {
    ...await getFriendActiveMonthComparison(db, scope, breakdown.active),
    active: breakdown.active,
    total: breakdown.total,
    // 設計は「相手から / 自分から」の2つ。相互は相手からに含める
    // （相手にブロックされている事実は変わらないため）。
    blockedByThem: breakdown.blockedByThem + breakdown.blockedBoth,
    hiddenByUs: breakdown.hiddenByUs,
    // 友だち画面は LINE の友だちの数。MAIL のスレッドは混ぜない。
    unanswered: Number(statuses?.unanswered ?? 0),
    resolved: Number(statuses?.resolved ?? 0),
    addedThisMonth,
    addedLastMonth,
  };
}

export function broadcastStatsFilter(
  accountId: string | undefined,
  scope: BroadcastStatsScope | undefined,
  alias = '',
): { sql: string; binds: string[] } {
  const column = `${alias}line_account_id`;
  const targetType = `${alias}target_type`;
  const accountIds = `${alias}account_ids`;
  if (accountId) {
    return {
      sql: ` AND (${column} = ? OR (${targetType} = 'multi-account-dedup' AND ${accountIds} IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(${accountIds}) WHERE value = ?)))`,
      binds: [accountId, accountId],
    };
  }
  if (!scope) return { sql: '', binds: [] };

  const conditions: string[] = [];
  const binds: string[] = [];
  if (scope.allowedAccountIds.length > 0) {
    const idSet = sqlIdSet(scope.allowedAccountIds);
  const placeholders = scope.allowedAccountIds.length ? idSet.sql : '';
    conditions.push(`(${column} IN (${placeholders}) OR (${targetType} = 'multi-account-dedup' AND ${accountIds} IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(${accountIds}) WHERE value IN (${placeholders}))))`);
    binds.push(...idSet.binds, ...idSet.binds);
  }
  if (scope.canSeeUnassigned) conditions.push(`(${column} IS NULL AND ${accountIds} IS NULL)`);
  return { sql: ` AND (${conditions.length > 0 ? conditions.join(' OR ') : '0 = 1'})`, binds };
}

export async function getBroadcastStats(
  db: D1Database,
  accountId?: string,
  scope?: BroadcastStatsScope,
): Promise<BroadcastStats> {
  const monthStart = jstDate(0).slice(0, 7);
  const since = jstDate(-27);
  const accountFilter = broadcastStatsFilter(accountId, scope);
  const insightAccountFilter = broadcastStatsFilter(accountId, scope, 'b.');

  const [counts, reach] = await Promise.all([
    db
      .prepare(
        // BROADCAST-14: 「今月の配信」は送り終わったものを、送った日で数える。
        // 下書きや予約を作っただけでは配信実績にならない。ダッシュボードの
        // delivery.broadcasts と同じく、sent_at の無い古い行だけ
        // created_at で代用する（0件へ落とさない）。
        `SELECT
           SUM(CASE WHEN status = 'sent' AND substr(COALESCE(sent_at, created_at), 1, 7) = ? THEN 1 ELSE 0 END) AS this_month,
           SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled
         FROM broadcasts WHERE 1 = 1${accountFilter.sql}`,
      )
      .bind(monthStart, ...accountFilter.binds)
      .first<{ this_month: number; scheduled: number }>(),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(success_count), 0) AS delivered,
           COALESCE(SUM(total_count - success_count), 0) AS failed
         FROM broadcasts
          WHERE status = 'sent' AND COALESCE(sent_at, created_at) >= ?${accountFilter.sql}`,
      )
      .bind(since, ...accountFilter.binds)
      .first<{ delivered: number; failed: number }>(),
  ]);

  let openRate: number | null = null;
  try {
    const row = await db
      .prepare(
        // open_rate は取り込み時に計算済み。ここで割り直すと、
        // 分母の取り方が2か所に分かれて食い違う。
        `SELECT AVG(open_rate) * 100 AS rate
           FROM broadcast_insights bi
           JOIN broadcasts b ON b.id = bi.broadcast_id
          WHERE delivered >= 20 AND open_rate IS NOT NULL${insightAccountFilter.sql}`,
      )
      .bind(...insightAccountFilter.binds)
      .first<{ rate: number | null }>();
    openRate = row?.rate === null || row?.rate === undefined ? null : Math.round(row.rate * 10) / 10;
  } catch {
    // broadcast_insights がまだ無い環境もある。開封率だけ出ない。
  }

  return {
    thisMonth: counts?.this_month ?? 0,
    scheduled: counts?.scheduled ?? 0,
    delivered: reach?.delivered ?? 0,
    failed: reach?.failed ?? 0,
    openRate,
  };
}
