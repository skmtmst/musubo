import { jstDate as japanDate } from '@line-crm/shared';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
/**
 * 飲食店向け「Googleビジネス」第4段：パフォーマンス表示（GB-9 Zq8DN）。
 *
 * - 画面は自前DB（rt_google_metrics_daily）だけを読む。Google APIはここでは呼ばない
 *   （取り込みは services/google-business-resync.ts の定期実行が行う）。
 * - 期間は 7／28／90 日。前期（直前の同じ長さの期間）との比較値も返す。
 * - 「未取得」と「0件」を区別する。期間内が全部未取得の指標は null（画面は「—」）。
 */
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { dbFor } from '../services/db-router.js';
import { processGoogleBusinessDailyMetrics } from '../services/google-business-resync.js';
import { requireRole } from '../middleware/role-guard.js';
import { connectionFor, fail, googleAccessGuard, nowIso, requestedConnectionId, requireConnectedStore, storeFor } from './restaurant-google.js';

export const restaurantGooglePerformance = new Hono<Env>();
restaurantGooglePerformance.use('/api/restaurant-test/google/*', googleAccessGuard);

const ALLOWED_DAYS = [7, 28, 90] as const;

interface MetricsRow {
  date: string;
  /** どのGoogle接続の指標か。772より前に取り込んだ行は空のまま残る。 */
  connection_id: string | null;
  impressions_desktop_maps: number | null;
  impressions_desktop_search: number | null;
  impressions_mobile_maps: number | null;
  impressions_mobile_search: number | null;
  direction_requests: number | null;
  call_clicks: number | null;
  website_clicks: number | null;
  menu_clicks: number | null;
  bookings: number | null;
  food_orders: number | null;
}

function jstToday(): string {
  return japanDate();
}

function daysBefore(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** null（未取得）だけの合計は null のまま。1件でも値があれば数値で返す。 */
function sumOrNull(values: Array<number | null>): number | null {
  let total: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

function impressionsOf(row: MetricsRow): number | null {
  return sumOrNull([
    row.impressions_desktop_maps,
    row.impressions_desktop_search,
    row.impressions_mobile_maps,
    row.impressions_mobile_search,
  ]);
}

function totalsOf(rows: MetricsRow[]) {
  return {
    impressions: sumOrNull(rows.map(impressionsOf)),
    directionRequests: sumOrNull(rows.map((row) => row.direction_requests)),
    callClicks: sumOrNull(rows.map((row) => row.call_clicks)),
    websiteClicks: sumOrNull(rows.map((row) => row.website_clicks)),
  };
}

restaurantGooglePerformance.get('/api/restaurant-test/google/performance', async (c) => {
  const store = await storeFor(c);
  if (!store) return fail(c, 404, 'このLINEアカウントに店舗が紐付いていません');

  const days = Number.parseInt(c.req.query('days') ?? '28', 10);
  if (!ALLOWED_DAYS.includes(days as (typeof ALLOWED_DAYS)[number])) {
    return fail(c, 400, '期間は7・28・90日から選んでください', { code: 'invalid_days' });
  }

  // 期間は「昨日まで」のN日間。Google側の集計が当日ぶんを持たないため、当日を含めない。
  const endDate = daysBefore(jstToday(), 1);
  const startDate = daysBefore(endDate, days - 1);
  const previousEndDate = daysBefore(startDate, 1);
  const previousStartDate = daysBefore(previousEndDate, days - 1);

  const db = dbFor(c.env, store.id);
  // 指標は接続ごとに1日1行。複数の接続があるとき店舗全体で読むと同じ日が何行も返り、
  // 日別グラフが後勝ちで片方を黙って捨て、合計は両方を足して水増しになる。
  // どの接続を見るかを先に決め、その接続の行だけを使う。
  const connection = await connectionFor(c, store.id, requestedConnectionId(c));
  const scope = connection ? ' AND (connection_id = ? OR connection_id IS NULL)' : ' AND connection_id IS NULL';
  const binds = connection
    ? [store.id, previousStartDate, endDate, connection.id]
    : [store.id, previousStartDate, endDate];
  const fetched = (
    await db
      .prepare(
        `SELECT * FROM rt_google_metrics_daily WHERE store_id = ? AND date >= ? AND date <= ?${scope}
         ORDER BY date, CASE WHEN connection_id IS NULL THEN 1 ELSE 0 END`,
      )
      .bind(...binds)
      .all<MetricsRow>()
  ).results;
  // 同じ日に「この接続の行」と「移行で接続が付かなかった古い行」が両方あるときは、
  // 並び順の先頭（この接続の行）を採る。足し合わせない。
  const rows: MetricsRow[] = [];
  const seenDates = new Set<string>();
  for (const row of fetched) {
    if (seenDates.has(row.date)) continue;
    seenDates.add(row.date);
    rows.push(row);
  }
  const current = rows.filter((row) => row.date >= startDate);
  const previous = rows.filter((row) => row.date < startDate);

  // 日別グラフ用。データが無い日も日付を出す（値は null＝未取得）。
  const byDate = new Map(current.map((row) => [row.date, row]));
  const daily: Array<{ date: string; impressions: number | null }> = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = daysBefore(endDate, offset);
    const row = byDate.get(date);
    daily.push({ date, impressions: row ? impressionsOf(row) : null });
  }

  // 最終取り込み時刻も、いま見ている接続のものを出す（店舗内の別の接続の時刻を出さない）。
  const synced = connection
    ? await db
        .prepare('SELECT last_metrics_synced_at FROM rt_google_connections WHERE id = ?')
        .bind(connection.id)
        .first<{ last_metrics_synced_at: string | null }>()
    : null;

  return c.json({
    success: true,
    days,
    range: { startDate, endDate },
    previousRange: { startDate: previousStartDate, endDate: previousEndDate },
    totals: totalsOf(current),
    previousTotals: totalsOf(previous),
    daily,
    food: {
      menuClicks: sumOrNull(current.map((row) => row.menu_clicks)),
      bookings: sumOrNull(current.map((row) => row.bookings)),
      foodOrders: sumOrNull(current.map((row) => row.food_orders)),
    },
    lastMetricsSyncedAt: synced?.last_metrics_synced_at ?? null,
  });
});

/**
 * 手動同期。検証環境（cron無し）でパフォーマンス取り込みを試すための入口。
 * この店舗だけを対象にJST当日ゲートを無視して取り直す（force: true）。
 * アクセストークン取得・Google呼び出し・失敗時のconnection状態更新は processGoogleBusinessDailyMetrics 側が担う。
 * 口コミ・投稿・プロフィールのsyncと同じくGoogleから読んで自DBに書くだけ（Googleへの書き込みは無い）ため、担当者にも許可する。
 */
restaurantGooglePerformance.post('/api/restaurant-test/google/performance/sync', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), async (c) => {
  const ctx = await requireConnectedStore(c, requestedConnectionId(c) ?? undefined);
  if (ctx instanceof Response) return ctx;
  const { store, connection } = ctx;

  // 押した画面が見ている接続だけを取り直す。店舗内の別の接続は触らない。
  const result = await processGoogleBusinessDailyMetrics(c.env, { now: nowIso(), storeId: store.id, connectionId: connection.id, force: true });
  return c.json({ success: true, ...result, syncedAt: nowIso() });
});
