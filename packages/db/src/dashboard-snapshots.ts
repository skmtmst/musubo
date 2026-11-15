import { jstCalendar, jstDateOffset as japanDateOffset } from '@line-crm/shared';
import { sqlIdSet } from './id-queries.js';
import { followTimeSql } from './utils.js';
import { jstDate, nextDate, latestDashboardTime, periodStart } from './dashboard-freshness.js';
import { friendBreakdown, count, accountScopeSql } from './dashboard-inbox.js';
import { type AccountStatsScope, type DashboardOverview, type DashboardPeriod } from './dashboard-types.js';


/**
 * 日次記録で「未割り当て」を表す専用キー。
 *
 * 空文字は旧仕様の全社合計行なので再利用しない。
 */
export const UNASSIGNED_SNAPSHOT_ACCOUNT_ID = '__unassigned__';

/**
 * 1つのLINEアカウント（または未割り当て）のその日の友だち数を記録する。
 *
 * cron から6時間ごとに呼ぶ。同じ日に何度呼んでも最後の値で上書きする。
 * 日付は日本時間の暦の日。6時間ごとの記録は日本時間21時が最後になるので、
 * 日付を指定しない全体の記録では、まだ締めていない前の日の行の
 * 増えた数・ブロックした数を1回だけ数え直して締める。
 */
export async function recordFriendSnapshot(
  db: D1Database,
  accountId: string | null,
  date?: string,
  limit = 1_000,
  now: Date = new Date(),
): Promise<void> {
  const day = date ?? japanDateOffset(0, now);
  const updatedAt = snapshotTime(now);
  if (accountId === null) {
    if (date === undefined) await closePreviousDay(db, day, updatedAt);
    const batchLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.trunc(limit), 1_000))
      : 1_000;
    const targets = await db
      .prepare(
        `SELECT targets.id
           FROM (
             SELECT id FROM line_accounts
             UNION ALL SELECT ? AS id
           ) targets
           LEFT JOIN friend_daily_snapshots snapshots
             ON snapshots.date = ? AND snapshots.line_account_id = targets.id
          ORDER BY
            CASE WHEN snapshots.updated_at IS NULL THEN 0 ELSE 1 END ASC,
            snapshots.updated_at ASC,
            targets.id ASC
          LIMIT ?`,
      )
      .bind(UNASSIGNED_SNAPSHOT_ACCOUNT_ID, day, batchLimit)
      .all<{ id: string }>();
    await writeFriendSnapshots(db, targets.results.map(target => target.id), day, updatedAt);
    return;
  }
  await writeFriendSnapshots(db, [accountId], day, updatedAt);
}

/** 記録の時刻。表の既定値と同じ、時差の印なしの日本時間で持つ。 */
function snapshotTime(now: Date): string {
  return jstCalendar(now).toISOString().replace('Z', '');
}

/** その日（日本時間）の始まりと終わりを `bounds` として読む、時差の印の違いに強い比べ方。 */
function inDaySql(column: string): string {
  return `(${followTimeSql(column)} >= bounds.starts AND ${followTimeSql(column)} < bounds.ends)`;
}

/**
 * 店ごとの数を1文で数える。並びは
 * 日付・記録時刻・`targetsSql` の値・その日の始まり・終わり・未割り当てキー。
 *
 * 増えた＝その日に友だち追加した人（初めて＋ブロック解除で戻った人）。
 * 追加の時刻の列が無い古い行だけは登録日で数える。
 * ブロック＝最後のブロックの時刻がその日の人。同じ人の1日2回は1と数える。
 */
function friendCountsSql(targetsSql: string): string {
  return `
    SELECT ?, targets.value,
           SUM(CASE WHEN f.is_following = 1 AND f.is_hidden = 0 THEN 1 ELSE 0 END),
           COUNT(f.id),
           SUM(CASE WHEN f.is_following = 0 AND f.is_hidden = 0 THEN 1 ELSE 0 END),
           SUM(CASE WHEN f.is_following = 1 AND f.is_hidden = 1 THEN 1 ELSE 0 END),
           SUM(CASE WHEN ${inDaySql('f.current_follow_started_at')} OR ${inDaySql('f.last_followed_at')}
                     OR (f.first_followed_at IS NULL AND f.last_followed_at IS NULL
                         AND f.last_unfollowed_at IS NULL AND ${inDaySql('f.created_at')})
                    THEN 1 ELSE 0 END),
           SUM(CASE WHEN ${inDaySql('f.last_unfollowed_at')} THEN 1 ELSE 0 END),
           ?
      FROM (${targetsSql}) targets
      CROSS JOIN (SELECT julianday(?) AS starts, julianday(?) AS ends) bounds
      LEFT JOIN friends f ON f.line_account_id = targets.value
        OR (targets.value = ? AND f.line_account_id IS NULL)
     WHERE 1
     GROUP BY targets.value`;
}

function dayBounds(day: string): [string, string] {
  return [`${day}T00:00:00+09:00`, `${nextDate(day)}T00:00:00+09:00`];
}

/** 選ばれた店舗を一文で記録し、店舗数による問い合わせ上限超過を防ぐ。 */
async function writeFriendSnapshots(
  db: D1Database,
  accountIds: string[],
  day: string,
  updatedAt: string,
): Promise<void> {
  if (accountIds.length === 0) return;
  await db.prepare(`
    INSERT INTO friend_daily_snapshots
      (date, line_account_id, active, total, blocked_by_them, hidden_by_us, added, blocked, updated_at)
    ${friendCountsSql('SELECT value FROM json_each(?)')}
    ON CONFLICT (date, line_account_id) DO UPDATE SET
      active = excluded.active,
      total = excluded.total,
      blocked_by_them = excluded.blocked_by_them,
      hidden_by_us = excluded.hidden_by_us,
      added = excluded.added,
      blocked = excluded.blocked,
      updated_at = excluded.updated_at
  `).bind(
    day, updatedAt, JSON.stringify(accountIds), ...dayBounds(day), UNASSIGNED_SNAPSHOT_ACCOUNT_ID,
  ).run();
}

/**
 * 前の日の行を締める。最後の記録が日をまたぐ前（その日の中）の行だけを数え直し、
 * 締めた行は記録時刻が次の日になるので2回目からは触らない。
 * その日の終わりの状態（友だち数など）は前の日の最後の記録のまま残す。
 * 前の日の行が無い店は作らない（取れなかった日は取れなかったまま）。
 */
async function closePreviousDay(db: D1Database, today: string, updatedAt: string): Promise<void> {
  const previous = japanDateOffset(-1, new Date(`${today}T00:00:00+09:00`));
  const closedAfter = `${today}T00:00:00`;
  await db.prepare(`
    INSERT INTO friend_daily_snapshots
      (date, line_account_id, active, total, blocked_by_them, hidden_by_us, added, blocked, updated_at)
    ${friendCountsSql(`SELECT line_account_id AS value FROM friend_daily_snapshots
       WHERE date = ? AND updated_at < ? AND line_account_id <> ''`)}
    ON CONFLICT (date, line_account_id) DO UPDATE SET
      added = excluded.added,
      blocked = excluded.blocked,
      updated_at = excluded.updated_at
  `).bind(
    previous, updatedAt, previous, closedAfter, ...dayBounds(previous), UNASSIGNED_SNAPSHOT_ACCOUNT_ID,
  ).run();
}

/**
 * 推移に出す日数。上の期間切り替えとは連動させない。
 *
 * 「今日 / 過去7日 / 過去28日」に合わせると、「今日」を
 * 選んだときに推移が1行だけになり、増えたのか減ったのかが読めない。
 * 推移は「直近どう動いたか」を見るためのもので、上の切り替えは
 * KPI の集計期間。別のものなので、ここは常に7日にする。
 */
export const TREND_DAYS = 7;

/** 旧全社合計行（空文字）を必ず除き、記録用の未割り当てキーを可視範囲に変換する。 */
export function snapshotScopeSql(scope: AccountStatsScope): { sql: string; binds: string[] } {
  if ('allTenants' in scope) return { sql: 'line_account_id <> ?', binds: [''] };
  const accountIds = [
    ...scope.allowedAccountIds,
    ...(scope.includeUnassigned ? [UNASSIGNED_SNAPSHOT_ACCOUNT_ID] : []),
  ];
  if (accountIds.length === 0) return { sql: '1 = 0', binds: [] };
  return {
    sql: `line_account_id IN (${sqlIdSet(accountIds).sql})`,
    binds: sqlIdSet(accountIds).binds,
  };
}

/**
 * 友だち数の推移。今日から遡って7日ぶん。
 *
 * 日次記録（friend_daily_snapshots）があればそれを使う。無い日は、
 * いま残っている友だちの登録日から逆算して埋め、`estimated` を立てる。
 *
 * 逆算は正確ではない。退会して行ごと消えた友だちは数に出ないので、
 * 過去に遡るほど実態より少なく見える。記録が始まる前の日を
 * 空白にすると線が途切れて読みにくいので埋めるが、
 * 「これは推定である」ことを画面まで持っていく。
 */
export async function friendTrend(
  db: D1Database,
  scope: AccountStatsScope,
): Promise<{ points: DashboardOverview['trend']; asOf: string | null }> {
  const days = TREND_DAYS;
  const start = jstDate(-(TREND_DAYS - 1));
  const snapshotScope = snapshotScopeSql(scope);

  const recorded = await db
    .prepare(
      `SELECT date, SUM(active) AS active, SUM(added) AS added, SUM(blocked) AS blocked,
              MIN(updated_at) AS updatedAt
         FROM friend_daily_snapshots
        WHERE ${snapshotScope.sql} AND date >= ?
        GROUP BY date
        ORDER BY date`,
    )
    .bind(...snapshotScope.binds, start)
    .all<{ date: string; active: number; added: number; blocked: number; updatedAt: string }>();
  const byDate = new Map(recorded.results.map((r) => [r.date, r]));

  const friends = accountScopeSql(scope, 'line_account_id');
  const binds = [start, ...friends.binds];
  const addedRows = await db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n
         FROM friends
        WHERE created_at >= ? AND ${friends.sql}
        GROUP BY d`,
    )
    .bind(...binds)
    .all<{ d: string; n: number }>();
  const addedByDate = new Map(addedRows.results.map((r) => [r.d, r.n]));
  /*
   * 経路不明（ref_code が経路に結びつかない追加）は name=null で返す。
   * 「経路不明」を経路名として出すと、実在する経路と区別がつかない。
   * 画面は null を `—` として出す。
   */
  const sourceRows = await db.prepare(
    `SELECT substr(f.created_at, 1, 10) AS d,
            er.name AS name,
            COUNT(*) AS n
       FROM friends f
       LEFT JOIN entry_routes er ON er.ref_code = f.ref_code
      WHERE f.created_at >= ? AND ${accountScopeSql(scope, 'f.line_account_id').sql}
      GROUP BY d, name
      ORDER BY n DESC`,
  ).bind(...binds).all<{ d: string; name: string | null; n: number }>();
  const sourcesByDate = new Map<string, Array<{ name: string | null; count: number }>>();
  for (const row of sourceRows.results) {
    const list = sourcesByDate.get(row.d) ?? [];
    list.push({ name: row.name, count: row.n });
    sourcesByDate.set(row.d, list);
  }

  const now = await friendBreakdown(db, null, accountScopeSql(scope, 'line_account_id'));
  const out: DashboardOverview['trend'] = [];
  let running = now.active;
  for (let i = 0; i < days; i += 1) {
    const date = jstDate(-i);
    const hit = byDate.get(date);
    if (hit) {
      out.push({ date, added: hit.added, blocked: hit.blocked, active: hit.active, estimated: false, sources: sourcesByDate.get(date) ?? [] });
    } else {
      out.push({
        date,
        added: addedByDate.get(date) ?? 0,
        blocked: 0,
        active: running,
        estimated: true,
        sources: sourcesByDate.get(date) ?? [],
      });
    }
    running -= addedByDate.get(date) ?? 0;
  }
  return {
    points: out.reverse(),
    // snapshot があるときは、画面を再取得した時刻ではなく保存済みの成功時刻を返す。
    // 全日が推定なら、現在の friends を直接読み終えた時刻が取得成功時刻になる。
    asOf: latestDashboardTime(recorded.results.map((row) => row.updatedAt)) ?? new Date().toISOString(),
  };
}

export async function conversionSummary(
  db: D1Database,
  period: DashboardPeriod,
  scope: AccountStatsScope,
  range?: { from: string; to: string },
): Promise<DashboardOverview['conversions']> {
  const start = range?.from ?? periodStart(period);
  const end = nextDate(range?.to ?? jstDate());
  const account = accountScopeSql(scope, 'f.line_account_id');
  const total = await count(
    db,
    `SELECT COUNT(*) AS n FROM conversion_events ce
      JOIN friends f ON f.id = ce.friend_id
     WHERE ce.created_at >= ? AND ce.created_at < ? AND ${account.sql}`,
    start, end, ...account.binds,
  );
  const byPoint = await db
    .prepare(
      `SELECT cp.name AS name, COUNT(*) AS count
         FROM conversion_events c
         JOIN conversion_points cp ON cp.id = c.conversion_point_id
         JOIN friends f ON f.id = c.friend_id
        WHERE c.created_at >= ? AND c.created_at < ? AND ${account.sql}
        GROUP BY cp.id
        ORDER BY count DESC
        LIMIT 5`,
    )
    .bind(start, end, ...account.binds)
    .all<{ name: string; count: number }>();
  return { total, byPoint: byPoint.results };
}
