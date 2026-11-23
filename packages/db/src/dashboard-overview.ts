import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import { withDisplayReadCache } from './display-read-cache.js';
import { type DashboardPeriod, type AccountStatsScope, type DashboardOverview, type DashboardSectionStatus, type DashboardMetricState, type DashboardMetricReason } from './dashboard-types.js';
import { periodStart, monthStart, oldestDashboardTime, dashboardFreshness, summarizeDashboardFreshness } from './dashboard-freshness.js';
import { accountScopeSql, broadcastScopeSql, count, friendBreakdown, inboxState, ZERO_BREAKDOWN } from './dashboard-inbox.js';
import { friendTrend, conversionSummary } from './dashboard-snapshots.js';


/**
 * ダッシュボードの数をまとめて取る。
 *
 * どれか1つが取れなくても画面全体を落とさない。表が無い環境（機能を切っている、
 * マイグレーションがまだ）でも、取れたところだけ出したい。
 */
export async function getDashboardOverview(
  db: D1Database,
  period: DashboardPeriod,
  scope: AccountStatsScope,
  /**
   * 受信箱の数を数える範囲。省略時は `scope` と同じ。
   * ダッシュボードは選択中のアカウントだけを見るが、MAIL はアカウントを
   * 持たないため、受信箱の一覧と同じく未割り当てが見える範囲では MAIL も
   * 合わせて数える。呼び出し側（ルート）が staff の可視範囲で渡す。
   */
  inboxScope: AccountStatsScope = scope,
): Promise<DashboardOverview> {
  return withDisplayReadCache(db, displayDb => dashboardOverview(displayDb, period, scope, inboxScope));
}

async function dashboardOverview(
  db: D1Database,
  period: DashboardPeriod,
  scope: AccountStatsScope,
  inboxScope: AccountStatsScope,
): Promise<DashboardOverview> {
  const start = periodStart(period);
  const month = monthStart();
  const partialFailures: string[] = [];
  const sourceAsOf = new Map<string, string>();
  const safe = async <T>(name: string, run: Promise<T>, fallback: T): Promise<T> => {
    try {
      const value = await run;
      sourceAsOf.set(name, new Date().toISOString());
      return value;
    } catch (error) {
      partialFailures.push(name);
      logger.error("src_dashboard_failed");
      return fallback;
    }
  };
  const friendAccount = accountScopeSql(scope, 'f.line_account_id');
  const messageAccount = accountScopeSql(scope, 'ml.line_account_id');
  const bookingAccount = accountScopeSql(scope, 'line_account_id');
  const migrationFrom = accountScopeSql(scope, 'from_account_id');
  const migrationTo = accountScopeSql(scope, 'to_account_id');
  const broadcastScope = broadcastScopeSql(scope);
  const emptyOperations: DashboardOverview['operations'] = {
    scenarios: { active: 0, paused: 0 }, migrations: { active: 0, completed: 0 },
    bookings: { pending: 0, upcoming: 0 }, inflowTop: [], funnelAlerts: 0,
    automationFailures: 0,
  };
  const operationsPromise = Promise.all([
    db.prepare(
      `SELECT SUM(CASE WHEN fs.status='active' THEN 1 ELSE 0 END) active,
              SUM(CASE WHEN fs.status='paused' THEN 1 ELSE 0 END) paused
         FROM friend_scenarios fs JOIN friends f ON f.id=fs.friend_id
        WHERE ${friendAccount.sql}`,
    ).bind(...friendAccount.binds).first<{ active: number | null; paused: number | null }>(),
    /*
     * ダッシュボードの「UID移行状況」カードが見るのは UID 移行の実行記録。
     * 旧アカウント移行（account_migrations）の件数を出すと別機能の数字が
     * 混ざるので、uid_migration_runs から数える。
     * active = 確認・実行待ちを含む未完了の実行、completed = 完了済み。
     */
    db.prepare(
      `SELECT SUM(CASE WHEN status IN ('dry_run','review','ready','executing') THEN 1 ELSE 0 END) active,
              SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed
         FROM uid_migration_runs
        WHERE (${migrationFrom.sql} OR ${migrationTo.sql})`,
    ).bind(...migrationFrom.binds, ...migrationTo.binds).first<{ active: number | null; completed: number | null }>(),
    db.prepare(
      `SELECT SUM(CASE WHEN status='requested' THEN 1 ELSE 0 END) pending,
              SUM(CASE WHEN status IN ('requested','confirmed') AND starts_at >= ? THEN 1 ELSE 0 END) upcoming
         FROM bookings WHERE ${bookingAccount.sql}`,
    ).bind(new Date().toISOString(), ...bookingAccount.binds).first<{ pending: number | null; upcoming: number | null }>(),
    db.prepare(
      `SELECT er.name name, COUNT(*) count
         FROM friends f LEFT JOIN entry_routes er ON er.ref_code=f.ref_code
        WHERE f.data_purged_at IS NULL AND f.created_at >= ? AND ${friendAccount.sql}
        GROUP BY name ORDER BY count DESC LIMIT 3`,
    ).bind(start, ...friendAccount.binds).all<{ name: string | null; count: number }>(),
    count(db,
      `SELECT COUNT(*) n FROM (
         SELECT f.ref_code, COUNT(DISTINCT f.id) additions, COUNT(ce.id) conversions
           FROM friends f LEFT JOIN conversion_events ce ON ce.friend_id=f.id
          WHERE f.data_purged_at IS NULL AND f.created_at >= ? AND ${friendAccount.sql}
          GROUP BY f.ref_code
       ) funnel WHERE additions >= 3 AND conversions = 0`,
      start, ...friendAccount.binds),
    count(db,
      `SELECT COUNT(*) n FROM automation_logs al
        JOIN friends f ON f.id=al.friend_id
       WHERE al.status IN ('partial','failed') AND al.created_at >= ? AND ${friendAccount.sql}`,
      start, ...friendAccount.binds),
  ]).then(([scenarios, migrations, bookings, inflow, funnelAlerts, automationFailures]) => ({
    scenarios: { active: scenarios?.active ?? 0, paused: scenarios?.paused ?? 0 },
    migrations: { active: migrations?.active ?? 0, completed: migrations?.completed ?? 0 },
    bookings: { pending: bookings?.pending ?? 0, upcoming: bookings?.upcoming ?? 0 },
    inflowTop: inflow.results,
    funnelAlerts,
    automationFailures,
  }));

  const [friends, inbox, trendResult, conversions, sent, broadcasts, operations] = await Promise.all([
    safe('friends', friendBreakdown(db, null, accountScopeSql(scope, 'line_account_id')), {
      active: 0,
      total: 0,
      blockedByThem: 0,
      hiddenByUs: 0,
      blockedBoth: 0,
    }),
    safe('inbox', inboxState(db, inboxScope), {
      unanswered: 0,
      inProgress: 0,
      onHold: 0,
      resolved: 0,
      line: { ...ZERO_BREAKDOWN },
      email: { ...ZERO_BREAKDOWN },
      oldestUnansweredMinutes: null,
      averageFirstReplyMinutes: null,
    }),
    // 推移だけは period を渡さない。上の切り替えに関わらず直近7日で見る。
    safe('trend', friendTrend(db, scope), { points: [], asOf: null }),
    safe('conversions', conversionSummary(db, period, scope), { total: 0, byPoint: [] }),
    // プッシュ（こちらから）と リプライ（受信への応答）を分ける。
    // source は 028 で入っている。auto_reply と manual が応答。
    // 見出し「今月の配信」どおり、選んだ期間ではなく今月1日から数える。
    safe('delivery', db
      .prepare(
        `SELECT
           COUNT(*) AS sent,
           SUM(CASE WHEN source IN ('auto_reply','manual') THEN 1 ELSE 0 END) AS reply
         FROM messages_log ml
          WHERE direction = 'outgoing' AND ml.created_at >= ? AND ${messageAccount.sql}`,
      )
      .bind(month, ...messageAccount.binds)
      .first<{ sent: number; reply: number }>()
      .then((value) => value), null),
    // 一斉配信は「作った日」ではなく「送った日」で数える。先月作って今月
    // 送った配信を先月扱いにすると、見出し「今月の配信」と実際がずれる。
    // sent_at が無い古い行だけ created_at で代用する（0件へ落とさない）。
    safe('broadcasts', count(
      db,
      `SELECT COUNT(*) AS n FROM broadcasts b
        WHERE status = 'sent' AND COALESCE(b.sent_at, b.created_at) >= ? AND ${broadcastScope.sql}`,
      month, ...broadcastScope.binds,
    ), 0),
    safe('operations', operationsPromise, emptyOperations),
  ]);

  const generatedAt = japanCalendar().toISOString().replace('Z', '+09:00');
  const trend = trendResult.points;
  if (trendResult.asOf) sourceAsOf.set('trend', trendResult.asOf);
  const status = (
    names: string | string[],
    empty: boolean,
    sectionPeriod: DashboardSectionStatus['period'],
  ): DashboardSectionStatus => {
    const sources = Array.isArray(names) ? names : [names];
    const failedSources = sources.filter((name) => partialFailures.includes(name)).length;
    const asOf = oldestDashboardTime(sources.map((name) => sourceAsOf.get(name)));
    const freshness = dashboardFreshness(asOf, {
      failedSources,
      totalSources: sources.length,
    });
    return {
      status: failedSources === sources.length
        ? 'unavailable'
        : failedSources > 0
          ? 'partial'
          : freshness === 'stale' ? 'stale' : empty ? 'empty' : 'ok',
      asOf,
      freshness,
      reason: failedSources > 0 ? 'source_failed' : null,
      period: sectionPeriod,
    };
  };
  const trendStatus = status('trend', trend.length === 0, 'last7-fixed');
  if (trendStatus.status === 'ok' && trend.some((point) => point.estimated)) {
    trendStatus.status = 'estimated';
  }
  const sections: DashboardOverview['sections'] = {
    friends: status('friends', friends.total === 0, 'latest'),
    inbox: status('inbox', inbox.unanswered + inbox.inProgress + inbox.onHold + inbox.resolved === 0, 'latest'),
    delivery: status(['delivery', 'broadcasts'], (sent?.sent ?? 0) === 0 && broadcasts === 0, 'this-month'),
    quota: {
      status: 'unavailable', asOf: null, freshness: 'unavailable',
      reason: 'not_loaded', period: 'this-month',
    },
    trend: trendStatus,
    conversions: status('conversions', conversions.total === 0, period),
    operations: status(
      'operations',
      operations.scenarios.active + operations.scenarios.paused
        + operations.migrations.active + operations.migrations.completed
        + operations.bookings.pending + operations.bookings.upcoming
        + operations.funnelAlerts + operations.automationFailures === 0
        && operations.inflowTop.length === 0,
      period,
    ),
  };
  const metricState = (section: DashboardSectionStatus): DashboardMetricState =>
    section.freshness === 'stale' || section.freshness === 'partial'
      ? section.freshness
      : section.status === 'ok' ? 'available' : section.status;
  const metricReason = (section: DashboardSectionStatus): DashboardMetricReason =>
    section.status === 'unavailable' || section.status === 'partial' ? 'source_failed' : null;

  const summary = summarizeDashboardFreshness(sections);

  return {
    period,
    generatedAt,
    ...summary,
    friends,
    inbox,
    delivery: {
      sent: sent?.sent ?? 0,
      push: (sent?.sent ?? 0) - (sent?.reply ?? 0),
      reply: sent?.reply ?? 0,
      broadcasts,
      // LINE の送信上限は Messaging API から取る。ここは DB だけを見る層なので
      // 触らない。呼び出し側（ルート）が埋める。
      quotaLimit: null,
      quotaUsed: null,
    },
    trend,
    conversions,
    partialFailures,
    operations,
    sections,
    metrics: {
      activeFriends: {
        value: sections.friends.status === 'unavailable' ? null : friends.active,
        state: metricState(sections.friends),
        reason: metricReason(sections.friends),
        asOf: sections.friends.status === 'unavailable' ? null : sections.friends.asOf,
        period: sections.friends.period,
      },
      monthlyQuota: {
        value: null,
        state: 'unavailable',
        reason: 'not_loaded',
        asOf: null,
        period: 'this-month',
      },
      friendTrend: {
        value: sections.trend.status === 'unavailable' ? null : trend,
        state: metricState(sections.trend),
        reason: metricReason(sections.trend),
        asOf: sections.trend.status === 'unavailable' ? null : sections.trend.asOf,
        period: sections.trend.period,
      },
      officialProfileUrl: {
        value: null,
        state: 'unavailable',
        reason: 'not_loaded',
        asOf: null,
        period: 'latest',
      },
    },
  };
}
