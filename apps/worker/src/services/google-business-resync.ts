import { jstDate as japanDate } from '@line-crm/shared';
import { logger, tracedFetch as fetch } from '@line-crm/shared/server';

/**
 * 飲食店向け「Googleビジネス」第4段：定期再同期。
 *
 * - 口コミ・投稿は1時間ごと（cronは5分レーンだが、接続ごとの前回時刻で55分ゲート）。
 *   店舗数が増えたらこのゲート閾値を伸ばすだけで間隔を調整できる。
 * - パフォーマンス指標は1日1回（JST日付でゲート。6時間レーンの最初の該当tickが回す）。
 *   Google側の集計は3〜5日遅れで確定するため、毎回直近7日を上書きして追随する。
 * - 取り込みの書き込み経路は手動syncと同じ関数（upsertReviewsForEnv / applyGooglePostsSync）を
 *   使い、二重実装しない。
 * - 機能「restaurant_test」がオフのアカウントは gate で止める（google-sheets と同じ作法）。
 * - ログは種別名（error.kind / error.name）だけ。応答本文・トークンは出さない。
 */
import type { Env } from '../worker-env.js';
import { dbFor } from './db-router.js';
import { GoogleBusinessError, listAllReviews, type FetchLike } from './google-business.js';
import { listLocalPosts } from './google-business-posts.js';
import { DAILY_METRICS, fetchDailyMetrics } from './google-business-performance.js';
import { createFeatureJobGate } from './feature-enforcement.js';
import {
  accessTokenForConnection,
  recordReviewSyncResult,
  setConnectionStatusForEnv,
  upsertReviewsForEnv,
  type ConnectionRow,
} from '../routes/restaurant-google.js';
import { applyGooglePostsSync } from '../routes/restaurant-google-posts.js';
import { getProfile } from './google-business-profile.js';
import { syncGoogleOpeningWeek } from './restaurant-google-hours-source.js';
import { tenantHasFeaturePack } from './tenant-features.js';

const HOURLY_STALE_MS = 55 * 60 * 1000;
const METRICS_BACKFILL_DAYS = 180;
const METRICS_REFRESH_DAYS = 7;

interface ResyncInput {
  now: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** 指定時はこの店舗だけを対象にする（検証環境の手動同期など）。省略時は全店舗（cronの通常挙動）。 */
  storeId?: string;
  /** trueならJST当日ゲートを無視して取り直す（手動同期用。cronからは渡さない）。 */
  force?: boolean;
}

type ResyncConnectionRow = ConnectionRow & {
  last_posts_synced_at: string | null;
  last_metrics_synced_at: string | null;
  last_profile_fetched_at: string | null;
  store_line_account_id: string | null;
  tenant_id: string;
};

function jstDate(iso: string): string {
  return japanDate(new Date(iso));
}

function daysBefore(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isStale(lastSyncedAt: string | null, nowIso: string, staleMs: number): boolean {
  if (!lastSyncedAt) return true;
  const last = Date.parse(lastSyncedAt);
  if (!Number.isFinite(last)) return true;
  return Date.parse(nowIso) - last >= staleMs;
}

async function listActiveConnections(env: Env['Bindings'], storeId?: string): Promise<ResyncConnectionRow[]> {
  const base = `SELECT c.*, s.line_account_id AS store_line_account_id, o.tenant_id, p.fetched_at AS last_profile_fetched_at
       FROM rt_google_connections c
       JOIN rt_stores s ON s.id = c.store_id
       JOIN rt_organizations o ON o.id = s.organization_id
       LEFT JOIN rt_google_profiles p ON p.store_id = c.store_id AND p.location_name = c.location_name
      WHERE c.status = 'connected' AND c.location_name IS NOT NULL AND s.status = 'active'`;
  const rows = storeId
    ? await env.DB.prepare(`${base} AND c.store_id = ? ORDER BY s.line_account_id`).bind(storeId).all<ResyncConnectionRow>()
    : await env.DB.prepare(`${base} ORDER BY s.line_account_id`).all<ResyncConnectionRow>();
  return rows.results;
}

function errorKindOf(error: unknown): string {
  if (error instanceof GoogleBusinessError) return error.kind;
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * 認可を切らさないための先回り更新。6時間レーンから呼ぶ。
 *
 * Googleのリフレッシュトークンは「使われないまま一定期間（約6か月）放置される」と
 * 無効化される。口コミ・指標の再同期は status='connected' かつ場所選択済み、さらに
 * 機能スイッチonの店舗しか回らないため、場所未選択のまま置かれた接続や、機能を一時的に
 * offにしている店舗のトークンは誰も使わず静かに死ぬ。ここだけは機能スイッチで止めず、
 * リフレッシュトークンを持つ接続を全部定期的に使って生かし続ける。
 *
 * 併せて、失効していれば顧客向けの呼び出しより先にここで気付き、画面の状態を
 * `expired` に落として「再接続してください」を出せる（落とすのは
 * accessTokenForConnection 側の既存処理）。
 *
 * ログは店舗IDと種別名だけ。トークンは出さない。
 */
export async function processGoogleBusinessTokenKeepalive(
  env: Env['Bindings'],
  input: ResyncInput,
): Promise<{ refreshed: number; failed: number }> {
  const rows = await env.DB.prepare(
    `SELECT c.*, s.line_account_id AS store_line_account_id
       FROM rt_google_connections c
       JOIN rt_stores s ON s.id = c.store_id
      WHERE c.refresh_token_enc IS NOT NULL
        AND c.status IN ('connected', 'pending_location')
        AND s.status = 'active'
      ORDER BY s.line_account_id`,
  ).all<ResyncConnectionRow>();

  let refreshed = 0;
  let failed = 0;

  for (const connection of rows.results) {
    try {
      // access_token_enc を外して渡し、キャッシュ分岐を通さず必ずリフレッシュを実行させる。
      // 「トークンを使う」こと自体が目的なので、有効期限が残っていても更新する。
      await accessTokenForConnection(env, { ...connection, access_token_enc: null });
      refreshed += 1;
    } catch (error) {
      failed += 1;
      logger.error("google_business.refresh_token_failed");
    }
  }
  return { refreshed, failed };
}

/** 口コミ・投稿の1時間ごとの再同期。5分レーンから呼ばれ、接続ごとの55分ゲートで間引く。 */
export async function processGoogleBusinessHourlyResync(
  env: Env['Bindings'],
  input: ResyncInput,
): Promise<{ reviewsSynced: number; postsSynced: number; skipped: number; failed: number }> {
  const fetchFn = input.fetch ?? fetch;
  const gate = createFeatureJobGate();
  const connections = await listActiveConnections(env);

  let reviewsSynced = 0;
  let postsSynced = 0;
  let skipped = 0;
  let failed = 0;

  for (const connection of connections) {
    const dueReviews = isStale(connection.last_synced_at, input.now, HOURLY_STALE_MS);
    const duePosts = isStale(connection.last_posts_synced_at, input.now, HOURLY_STALE_MS);
    const dueProfile = isStale(connection.last_profile_fetched_at, input.now, HOURLY_STALE_MS);
    if (!dueReviews && !duePosts && !dueProfile) {
      skipped += 1;
      continue;
    }
    const syncRestaurantContent = (dueReviews || duePosts)
      && await tenantHasFeaturePack(env.DB, connection.tenant_id, 'restaurant')
      && await gate.canRun(env.DB, connection.store_line_account_id, 'restaurant_test', 'google business resync');
    if (!dueProfile && !syncRestaurantContent) {
      skipped += 1;
      continue;
    }
    try {
      const accessToken = await accessTokenForConnection(env, connection);
      const options = { fetch: fetchFn, accessToken, sleep: input.sleep };
      if (dueProfile) {
        const profile = await getProfile(options, connection.location_name!);
        const db = dbFor(env, connection.store_id);
        const previous = await db.prepare('SELECT profile_json FROM rt_google_profiles WHERE store_id=? AND location_name=?')
          .bind(connection.store_id, connection.location_name).first<{ profile_json: string }>();
        let extras: unknown = { photoCount: null, googleUpdates: null };
        try { extras = JSON.parse(previous?.profile_json ?? '{}').extras ?? extras; } catch { /* 本体を優先 */ }
        await db.prepare(`INSERT INTO rt_google_profiles(store_id,location_name,profile_json,fingerprint,fetched_at,updated_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(store_id) DO UPDATE SET location_name=excluded.location_name,
          profile_json=excluded.profile_json,fingerprint=excluded.fingerprint,fetched_at=excluded.fetched_at,updated_at=excluded.updated_at`)
          .bind(connection.store_id, connection.location_name, JSON.stringify({ profile, extras }), profile.fingerprint, input.now, input.now).run();
        await syncGoogleOpeningWeek(db, connection.store_id, connection.location_name!, profile);
      }
      if (dueReviews && syncRestaurantContent) {
        const result = await listAllReviews(options, connection.location_name!);
        await upsertReviewsForEnv(env, connection.store_id, result.reviews);
        await recordReviewSyncResult(env, connection.store_id, result);
        reviewsSynced += 1;
      }
      if (duePosts && syncRestaurantContent) {
        const googlePosts = await listLocalPosts(options, connection.location_name!);
        await applyGooglePostsSync(env, connection.store_id, googlePosts);
        await dbFor(env, connection.store_id)
          .prepare(`UPDATE rt_google_connections SET last_posts_synced_at = ?, updated_at = ? WHERE store_id = ?`)
          .bind(input.now, input.now, connection.store_id)
          .run();
        postsSynced += 1;
      }
    } catch (error) {
      failed += 1;
      if (error instanceof GoogleBusinessError && error.kind === 'no_permission') {
        await setConnectionStatusForEnv(env, connection.store_id, 'no_permission', 'no_permission');
      } else if (error instanceof GoogleBusinessError && error.kind !== 'auth_expired') {
        // auth_expired は accessTokenForConnection 内で expired へ落とし済み。
        await setConnectionStatusForEnv(env, connection.store_id, connection.status, error.kind);
      }
      logger.error("google_business.resync_failed");
    }
  }
  return { reviewsSynced, postsSynced, skipped, failed };
}

const METRIC_COLUMNS = [
  ['impressionsDesktopMaps', 'impressions_desktop_maps'],
  ['impressionsDesktopSearch', 'impressions_desktop_search'],
  ['impressionsMobileMaps', 'impressions_mobile_maps'],
  ['impressionsMobileSearch', 'impressions_mobile_search'],
  ['directionRequests', 'direction_requests'],
  ['callClicks', 'call_clicks'],
  ['websiteClicks', 'website_clicks'],
  ['menuClicks', 'menu_clicks'],
  ['bookings', 'bookings'],
  ['foodOrders', 'food_orders'],
] as const;

/** パフォーマンス指標の1日1回の取り込み。6時間レーンから呼ばれ、JST日付でゲートする。 */
export async function processGoogleBusinessDailyMetrics(
  env: Env['Bindings'],
  input: ResyncInput,
): Promise<{ synced: number; skipped: number; failed: number }> {
  const fetchFn = input.fetch ?? fetch;
  const gate = createFeatureJobGate();
  const today = jstDate(input.now);
  const connections = await listActiveConnections(env, input.storeId);

  let synced = 0;
  let skipped = 0;
  let failed = 0;

  for (const connection of connections) {
    if (!input.force && connection.last_metrics_synced_at && jstDate(connection.last_metrics_synced_at) === today) {
      skipped += 1;
      continue;
    }
    if (!(await gate.canRun(env.DB, connection.store_line_account_id, 'restaurant_test', 'google business metrics'))) {
      skipped += 1;
      continue;
    }
    try {
      const accessToken = await accessTokenForConnection(env, connection);
      // 初回は過去180日（90日表示＋前期比較のぶん）、2回目以降は直近7日だけ取り直す。
      const backfillDays = connection.last_metrics_synced_at ? METRICS_REFRESH_DAYS : METRICS_BACKFILL_DAYS;
      const days = await fetchDailyMetrics(
        { fetch: fetchFn, accessToken, sleep: input.sleep },
        connection.location_name!,
        { startDate: daysBefore(today, backfillDays), endDate: today },
      );
      const db = dbFor(env, connection.store_id);
      const columns = METRIC_COLUMNS.map(([, column]) => column);
      const statements = Object.entries(days).map(([date, values]) =>
        db
          .prepare(
            `INSERT INTO rt_google_metrics_daily (store_id, date, ${columns.join(', ')}, fetched_at)
             VALUES (?, ?, ${columns.map(() => '?').join(', ')}, ?)
             ON CONFLICT(store_id, date) DO UPDATE SET
               ${columns.map((column) => `${column} = excluded.${column}`).join(', ')},
               fetched_at = excluded.fetched_at`,
          )
          .bind(connection.store_id, date, ...METRIC_COLUMNS.map(([key]) => values[key]), input.now),
      );
      for (let index = 0; index < statements.length; index += 50) {
        await db.batch(statements.slice(index, index + 50));
      }
      await db
        .prepare(`UPDATE rt_google_connections SET last_metrics_synced_at = ?, updated_at = ? WHERE store_id = ?`)
        .bind(input.now, input.now, connection.store_id)
        .run();
      synced += 1;
    } catch (error) {
      failed += 1;
      if (error instanceof GoogleBusinessError && error.kind === 'no_permission') {
        await setConnectionStatusForEnv(env, connection.store_id, 'no_permission', 'no_permission');
      }
      logger.error("google_business.refresh_daily_metrics_failed");
    }
  }
  return { synced, skipped, failed };
}

// 画面側の集計で使う列名の対応（テスト・ルートから参照する）。
export { DAILY_METRICS };
