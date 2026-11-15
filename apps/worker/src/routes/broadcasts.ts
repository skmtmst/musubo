import { createBroadcastCorrection } from './broadcasts-correction.js';
import { inputJsonBoundary } from '../lib/input-errors.js';

import { Hono } from 'hono';

import type { Env } from '../worker-env.js';

import { requireIrreversibleConfirmation, requireRole, requirePermission, requireReadOperationPermission } from '../middleware/role-guard.js';
import { BROADCAST_DEFINITION_EDIT_KEY, BROADCAST_DEFINITION_PUBLISH_KEY, BROADCAST_JOB_RETRY_KEY, BROADCAST_JOB_STOP_KEY, BROADCAST_TEST_SEND_KEY } from '@line-crm/shared';

import { use__api_broadcasts_id__1, get__api_broadcasts_2, get__api_broadcasts_stats_3, get__api_broadcasts_notification_settings_4, put__api_broadcasts_notification_settings_5, get__api_broadcasts_saved_views_6, post__api_broadcasts_saved_views_7, get__api_broadcasts_id_8, get__api_broadcasts_id_recipients_9, get__api_broadcasts_id_activity_10, get__api_broadcasts_id_send_preview_11, get__api_broadcasts_id_preview_count_12, get__api_broadcasts_id_per_account_stats_13 } from './broadcasts-read.js';

import { post__api_broadcasts_preflight_1, post__api_broadcasts_2 } from './broadcasts-preflight.js';

import { put__api_broadcasts_id_1, post__api_broadcasts_id_cancel_2, post__api_broadcasts_id_stop_3, post__api_broadcasts_id_resume_4, post__api_broadcasts_id_retry_failed_5 } from './broadcasts-lifecycle.js';

import { delete__api_broadcasts_id_1, post__api_broadcasts_id_send_2, post__api_broadcasts_id_send_segment_3 } from './broadcasts-delivery.js';

import { get__api_broadcasts_id_insight_1, post__api_broadcasts_id_fetch_insight_2, post__api_broadcasts_id_test_send_3, get__api_broadcasts_id_progress_4, post__api_segments_count_5 } from './broadcasts-insights.js';

const broadcasts = new Hono<Env>();
export type { BroadcastStatusView } from './broadcasts-definition.js';

broadcasts.use('/api/broadcasts/:id/*',use__api_broadcasts_id__1);

// GET /api/broadcasts - list all
broadcasts.get('/api/broadcasts', get__api_broadcasts_2);

// GET /api/broadcasts/:id - get single
/**
 * 一覧の上部に出す数（設計 `V2 4-2 一斉配信` の KPIs）。
 *
 * id より前に置くこと。あとに置くと 'stats' が id として拾われる。
 */
broadcasts.get('/api/broadcasts/stats', get__api_broadcasts_stats_3);

broadcasts.get('/api/broadcasts/notification-settings', get__api_broadcasts_notification_settings_4);

broadcasts.put('/api/broadcasts/notification-settings', requireRole('owner', 'admin'), inputJsonBoundary(), put__api_broadcasts_notification_settings_5);

// 保存した検索。動的な :id より前に置き、saved-views を配信IDとして扱わない。
broadcasts.get('/api/broadcasts/saved-views', requireRole('owner', 'admin', 'staff'), get__api_broadcasts_saved_views_6);

broadcasts.post('/api/broadcasts/saved-views', requireRole('owner', 'admin'), inputJsonBoundary(), post__api_broadcasts_saved_views_7);

broadcasts.get('/api/broadcasts/:id', get__api_broadcasts_id_8);

broadcasts.post('/api/broadcasts/:id/correction', createBroadcastCorrection);

broadcasts.get('/api/broadcasts/:id/recipients', get__api_broadcasts_id_recipients_9);

// GET /api/broadcasts/:id/activity — 操作の記録
//
// 作成・編集・予約・送信・停止・再送と、承認の依頼・承認・差し戻しを
// 時刻順（新しい順）に混ぜて返す。記録は消せない（追記だけ）。
broadcasts.get('/api/broadcasts/:id/activity', get__api_broadcasts_id_activity_10);

// U1: 読み取りだけ。送信・外の残高照会・下書きの更新はしない。
broadcasts.get('/api/broadcasts/:id/send-preview', get__api_broadcasts_id_send_preview_11);

// GET /api/broadcasts/:id/preview-count — 送信前の対象人数を計算する。
// draft 状態の broadcast に対し、send 確認モーダルで「対象 X人」を表示するために使う。
// target_type ごとに使う SQL を切り替える。total_count は send 後にしか入らないので、
// このエンドポイントが「送ったらこの人数」を返す唯一の手段。
broadcasts.get('/api/broadcasts/:id/preview-count', get__api_broadcasts_id_preview_count_12);

// アカウント別の送信数と LINE Insight の閲覧・クリックを返す。送信数は履歴、Insight は送信済みの aggregation_unit を使って各アカウントのトークンで取得する。既存キャッシュは全体集計なので流用しない。未知の閲覧・クリックは null のまま返す。
broadcasts.get('/api/broadcasts/:id/per-account-stats', get__api_broadcasts_id_per_account_stats_13);

// POST /api/broadcasts - create
// POST /api/broadcasts/preflight — 送る前の確認
//
// 何人に届くかと、気をつけることを返す。送信は何もしない。
// 一斉配信は取り消せないので、押す前に見せる。
//
// id を使う経路より先に置く。後ろだと 'preflight' が :id として拾われる。
broadcasts.post('/api/broadcasts/preflight', requirePermission(BROADCAST_DEFINITION_PUBLISH_KEY), inputJsonBoundary(), post__api_broadcasts_preflight_1);

broadcasts.post('/api/broadcasts', inputJsonBoundary({"title":["string"],"messageType":["string"],"messageContent":["string"],"messageBubbles":["array"],"targetType":["string"],"targetTagId":["null","string"],"scheduledAt":["null","string"],"lineAccountId":["null","string"],"altText":["null","string"],"accountIds":["array"],"dedupPriority":["array"],"trackLinks":["boolean"],"stealthSpreadMinutes":["number"],"folderId":["null","string"],"measureOpens":["boolean"],"saveAsDraft":["boolean"],"draftStep":["string"],"internalMemo":["null","string"],"afterActionVersionId":["null","string"]}), post__api_broadcasts_2);

// PUT /api/broadcasts/:id - update draft
broadcasts.put('/api/broadcasts/:id', inputJsonBoundary({"title":["string"],"messageType":["string"],"messageContent":["string"],"messageBubbles":["array"],"targetType":["string"],"targetTagId":["null","string"],"scheduledAt":["null","string"],"trackLinks":["boolean"],"folderId":["null","string"],"measureOpens":["boolean"],"stealthSpreadMinutes":["number"],"lineAccountId":["null","string"],"accountIds":["array"],"saveAsDraft":["boolean"],"draftStep":["null","string"],"internalMemo":["null","string"],"afterActionVersionId":["null","string"],"expectedVersion":["number"],"confirmedRecipientCount":["number"]}), put__api_broadcasts_id_1);

// POST /api/broadcasts/:id/cancel - cancel a scheduled broadcast without deleting its content
//
// 読み取りの直後に予約実行が始まっても sending を draft に戻さないよう、
// scheduled のままであることを UPDATE 側でも確認する。
broadcasts.post('/api/broadcasts/:id/cancel', requirePermission(BROADCAST_DEFINITION_PUBLISH_KEY), inputJsonBoundary(), post__api_broadcasts_id_cancel_2);

// POST /api/broadcasts/:id/stop — 送信中の配信を止める
broadcasts.post('/api/broadcasts/:id/stop', requirePermission(BROADCAST_JOB_STOP_KEY), inputJsonBoundary(), post__api_broadcasts_id_stop_3);

// POST /api/broadcasts/:id/resume — 止めた配信の続きを送る
broadcasts.post('/api/broadcasts/:id/resume', requirePermission(BROADCAST_JOB_STOP_KEY), inputJsonBoundary(), post__api_broadcasts_id_resume_4);

// POST /api/broadcasts/:id/retry-failed — 失敗した相手だけ送り直す
//
// 相手へ実際に届き、取り消せない。権限に加えて明示的な確認を要求する
// （送信の口と同じ扱い）。
broadcasts.post(
  '/api/broadcasts/:id/retry-failed',
  requirePermission(BROADCAST_JOB_RETRY_KEY),
  requireIrreversibleConfirmation('broadcast-send'),
  inputJsonBoundary(), post__api_broadcasts_id_retry_failed_5,
);

broadcasts.delete('/api/broadcasts/:id', requirePermission(BROADCAST_DEFINITION_EDIT_KEY), delete__api_broadcasts_id_1);

// POST /api/broadcasts/:id/send - send now (tag配信で500人超はキュー方式)
//
// Atomic UPDATE-WHERE で多重起動を防ぐ。check-then-act の TOCTOU race だと、
// 並列リクエストが同時に status='draft' を読んで両方が processBroadcastSend に
// 入れるため、送信済み記録と実行権の照合で重複配信を防ぐ。
// 既存の lock 修正 (a27ad9f / bffcdf8 / 3ac2fec) は cron / scheduled 経路を
// 守ったが、API direct 経路は未対応のままだった。
// 友だちへ実際に届き、取り消せない。権限に加えて明示的な確認を要求する。
broadcasts.post('/api/broadcasts/:id/send', requireIrreversibleConfirmation('broadcast-send'), inputJsonBoundary(), post__api_broadcasts_id_send_2);

// POST /api/broadcasts/:id/send-segment - send to a filtered segment (常にキュー方式)
// 友だちへ実際に届き、取り消せない。権限に加えて明示的な確認を要求する。
broadcasts.post('/api/broadcasts/:id/send-segment', requirePermission(BROADCAST_DEFINITION_PUBLISH_KEY), requireIrreversibleConfirmation('broadcast-send'), inputJsonBoundary({"conditions":["object"]}), post__api_broadcasts_id_send_segment_3);

// GET /api/broadcasts/:id/insight — インサイト（開封率・クリック率）取得
broadcasts.get('/api/broadcasts/:id/insight', get__api_broadcasts_id_insight_1);

// POST /api/broadcasts/:id/fetch-insight — LINE APIからインサイトを即時取得
broadcasts.post('/api/broadcasts/:id/fetch-insight', requirePermission('/broadcasts'), inputJsonBoundary(), post__api_broadcasts_id_fetch_insight_2);

// POST /api/broadcasts/:id/test-send — send to test recipients with 【テスト配信】 label
broadcasts.post('/api/broadcasts/:id/test-send', requirePermission(BROADCAST_TEST_SEND_KEY), inputJsonBoundary(), post__api_broadcasts_id_test_send_3);

// GET /api/broadcasts/:id/progress — batch send progress
broadcasts.get('/api/broadcasts/:id/progress', get__api_broadcasts_id_progress_4);

// POST /api/segments/count — count friends matching segment conditions
broadcasts.post('/api/segments/count', requireReadOperationPermission(), inputJsonBoundary({"accountId":["string"]}), post__api_segments_count_5);

export { broadcasts };
