import { inputJsonBoundary } from '../lib/input-errors.js';

import { Hono } from 'hono';

import type { Env } from '../worker-env.js';
import { requireDeliveryAccess } from '../middleware/role-guard.js';

import { get__api_rich_menu_groups_external_richMenuId_image_1, post__api_rich_menu_groups_import_2, get__api_rich_menu_groups_external_3, delete__api_rich_menu_groups_external_richMenuId_4, get__api_rich_menu_groups_tap_stats_5, get__api_rich_menu_groups_6 } from './rich-menu-groups-external.js';

import { get__api_rich_menu_groups_groupId_delete_impact_1, post__api_rich_menu_groups_groupId_preview_targets_2, get__api_rich_menu_groups_groupId_usages_3, post__api_rich_menu_groups_groupId_schedule_4, get__api_rich_menu_groups_groupId_schedules_5, post__api_rich_menu_groups_groupId_schedules_scheduleId_cancel_6, get__api_rich_menu_groups_groupId_7, post__api_rich_menu_groups_8, patch__api_rich_menu_groups_groupId_9, post__api_rich_menu_groups_reorder_priorities_10, delete__api_rich_menu_groups_groupId_11 } from './rich-menu-groups-configuration.js';

import { post__api_rich_menu_groups_groupId_pages_pageId_image_1, get__api_rich_menu_images_key__2, post__api_rich_menu_groups_groupId_publish_3, get__api_rich_menu_groups_groupId_prepublish_check_4, post__api_rich_menu_groups_groupId_validate_5, post__api_rich_menu_groups_groupId_device_confirm_6, get__api_rich_menu_groups_groupId_publish_progress_7, get__api_rich_menu_groups_groupId_publish_runs_8, post__api_rich_menu_groups_groupId_publish_runs_requestId_retry_9, post__api_rich_menu_groups_groupId_reconcile_10, post__api_rich_menu_groups_groupId_unpublish_11 } from './rich-menu-groups-publication.js';

import { post__api_rich_menu_groups_groupId_apply_to_tag_1, post__api_rich_menu_groups_groupId_duplicate_2, get__api_rich_menu_groups_groupId_audience_summary_3, get__api_rich_menu_groups_groupId_test_apply_4, post__api_rich_menu_groups_groupId_test_apply_5 } from './rich-menu-groups-audience.js';

import { post__api_rich_menu_groups_groupId_test_apply_revert_1 } from './rich-menu-groups-repair.js';

export const richMenuGroups = new Hono<Env>();
export { manualPublishShellName } from './rich-menu-groups-definition.js';

// ----- Routes -----

// LINE 上の rich menu の画像をプロキシで返す (Authorization が必要なため
// admin 経由で取得して画面に流す)。
richMenuGroups.get('/api/rich-menu-groups/external/:richMenuId/image', get__api_rich_menu_groups_external_richMenuId_image_1);

// LINE 上の admin 管理外 rich menu を D1 に取り込んで管理対象にする。
// 取り込み後は通常の編集画面で操作できる。
//
// query: { accountId, richMenuId }
richMenuGroups.post('/api/rich-menu-groups/import', requireDeliveryAccess('richMenus'), inputJsonBoundary(), post__api_rich_menu_groups_import_2);

// LINE 公式アカウント上のリッチメニュー実態と admin 管理状態を突き合わせて返す。
// 一覧画面で「LINE 上には登録されているが admin 外」「現在の default」を可視化するために使う。
richMenuGroups.get('/api/rich-menu-groups/external', get__api_rich_menu_groups_external_3);

// LINE 上の rich menu を直接削除する (admin 管理外の orphan を片付ける用)。
// admin 管理されている richMenuId を渡された場合は 409 で拒否
// (Unpublish 経由で消すべき)。
richMenuGroups.delete('/api/rich-menu-groups/external/:richMenuId', requireDeliveryAccess('richMenus'), delete__api_rich_menu_groups_external_richMenuId_4);

// 押された回数。既定はその月（日本時間）。from / to を渡せば任意の期間。
// ルートの並び順に注意 — `/:groupId` より前に置かないと "tap-stats" が
// リッチメニューの id として拾われる。
richMenuGroups.get('/api/rich-menu-groups/tap-stats', get__api_rich_menu_groups_tap_stats_5);

richMenuGroups.get('/api/rich-menu-groups', get__api_rich_menu_groups_6);

richMenuGroups.get(
  '/api/rich-menu-groups/:groupId/delete-impact',
  requireDeliveryAccess('richMenus'),
  get__api_rich_menu_groups_groupId_delete_impact_1,
);

/**
 * 「誰に出すか」の件数。取得できない値を0へ丸めず、state/reasonを返す。
 * 上位条件のどれかにも一致する人を重複として1回だけ数える。
 * 保存(PATCH)と同じく owner/admin のみ。人数の列挙を権限の弱い職員に開かない。
 */
richMenuGroups.post('/api/rich-menu-groups/:groupId/preview-targets', requireDeliveryAccess('richMenus'), inputJsonBoundary(), post__api_rich_menu_groups_groupId_preview_targets_2);

/** 削除確認と外部の参照一覧で同じ正本を使う。 */
richMenuGroups.get('/api/rich-menu-groups/:groupId/usages', get__api_rich_menu_groups_groupId_usages_3);

/** 公開予約。予約時点のメニュー定義を固定して保存する。 */
richMenuGroups.post(
  '/api/rich-menu-groups/:groupId/schedule',
  requireDeliveryAccess('richMenus'),
  inputJsonBoundary(), post__api_rich_menu_groups_groupId_schedule_4,
);

/** 予約一覧と状態確認。実行前取消の判断材料を返す。 */
richMenuGroups.get('/api/rich-menu-groups/:groupId/schedules', get__api_rich_menu_groups_groupId_schedules_5);

/** 実行前の取消。publishing/restoring の最中は最新状態付きの409で止める。 */
richMenuGroups.post(
  '/api/rich-menu-groups/:groupId/schedules/:scheduleId/cancel',
  requireDeliveryAccess('richMenus'),
  inputJsonBoundary(), post__api_rich_menu_groups_groupId_schedules_scheduleId_cancel_6,
);

richMenuGroups.get('/api/rich-menu-groups/:groupId', get__api_rich_menu_groups_groupId_7);

richMenuGroups.post('/api/rich-menu-groups', requireDeliveryAccess('richMenus'), inputJsonBoundary(), post__api_rich_menu_groups_8);

richMenuGroups.patch('/api/rich-menu-groups/:groupId', requireDeliveryAccess('richMenus'), inputJsonBoundary(), patch__api_rich_menu_groups_groupId_9);

/**
 * 優先順と自分で決めた並び順の一括更新 (中)。
 * 全件ぶん PATCH を並列に投げると台数比例で増え、途中失敗で順番が
 * 中途半端に残る。id 配列を1回で受け、1 batch で 0,1,2…へそろえる。
 * 全部入りでなければ 400 (隠れているメニューの優先関係を壊さない)。
 */
richMenuGroups.post(
  '/api/rich-menu-groups/reorder-priorities',
  requireDeliveryAccess('richMenus'),
  inputJsonBoundary(), post__api_rich_menu_groups_reorder_priorities_10,
);

richMenuGroups.delete('/api/rich-menu-groups/:groupId', requireDeliveryAccess('richMenus', 'archive'), delete__api_rich_menu_groups_groupId_11);

// ----- Image upload -----

richMenuGroups.post('/api/rich-menu-groups/:groupId/pages/:pageId/image', requireDeliveryAccess('richMenus'), inputJsonBoundary(), post__api_rich_menu_groups_groupId_pages_pageId_image_1);

// 画像取得 — エディタからの <img src="..."> 用。private cache でアクセス制御は auth に委ねる。
richMenuGroups.get('/api/rich-menu-images/:key{.+}', get__api_rich_menu_images_key__2);

richMenuGroups.post('/api/rich-menu-groups/:groupId/publish', requireDeliveryAccess('richMenus', 'publish'), inputJsonBoundary({"expectedVersion":["number"],"expectedPublishGeneration":["number"],"expectedImages":["array"]}), post__api_rich_menu_groups_groupId_publish_3);

// ----- ・公開の進み・公開前の確認 -----

/**
 * 公開前の確認。下書きを変えない検査だけを集める。
 * LINE の検査は別の口（POST validate）で、作らずに見る。
 */
richMenuGroups.get(
  '/api/rich-menu-groups/:groupId/prepublish-check',
  requireDeliveryAccess('richMenus'),
  get__api_rich_menu_groups_groupId_prepublish_check_4,
);

/**
 * LINE の検査。自前の検査を通った下書きを、公開する形のまま
 * Validate rich menu object API に通す。下書きもLINEも変えない。
 */
richMenuGroups.post(
  '/api/rich-menu-groups/:groupId/validate',
  requireDeliveryAccess('richMenus'),
  inputJsonBoundary(), post__api_rich_menu_groups_groupId_validate_5,
);

/**
 * 実機で見た記録。今の下書きの fingerprint にひもづく。
 * 下書きが変わると無効になり、公開門番が止める。
 */
richMenuGroups.post(
  '/api/rich-menu-groups/:groupId/device-confirm',
  requireDeliveryAccess('richMenus'),
  inputJsonBoundary(), post__api_rich_menu_groups_groupId_device_confirm_6,
);

/**
 * 公開の進み。最新の公開実行の4段（画像・メニュー・割り当て・片付け）を
 * ページ行から集めて返す。まだ公開していなければ空で返す。
 */
richMenuGroups.get(
  '/api/rich-menu-groups/:groupId/publish-progress',
  requireDeliveryAccess('richMenus'),
  get__api_rich_menu_groups_groupId_publish_progress_7,
);

// ----- : 公開履歴・失敗だけの再試行・LINEとの照合修復 -----

/**
 * 公開履歴の一覧。各runの版（スナップショットの要約）・状態・試行に使った
 * LINE ID・最終エラーを返す。別アカウントは404で隠す。
 *
 * 併せて「いま対象へ出ている版」（最後に成功したrun）と、編集中の下書きが
 * その公開版と違うかを返す。画面はこれで公開版と編集版を混ぜずに説明できる。
 */
richMenuGroups.get(
  '/api/rich-menu-groups/:groupId/publish-runs',
  requireDeliveryAccess('richMenus'),
  get__api_rich_menu_groups_groupId_publish_runs_8,
);

/**
 * 失敗した公開runだけを、その版の鍵で再試行する。
 * - succeeded: 保存済みの結果を再生する（LINEを再実行しない）
 * - running: 409
 * - failed: 同じ idempotency_key で handleManualPublish へ回し、journal の
 *   shell から再開する。鍵の中身が最新の下書きとずれていれば中で 409 になる。
 */
richMenuGroups.post(
  '/api/rich-menu-groups/:groupId/publish-runs/:requestId/retry',
  requireDeliveryAccess('richMenus'),
  inputJsonBoundary(), post__api_rich_menu_groups_groupId_publish_runs_requestId_retry_9,
);

/**
 * DBの記録とLINE上の実体の照合。
 *
 * dryRun=true（既定）: ずれを列挙するだけで何も変えない。
 * dryRun=false        : 列挙したずれを明示的に直す。
 *
 * 直す内容:
 *   - page の line_richmenu_id が LINE に無い → そのIDを外す
 *   - status='published' なのに LINE に実体が1つも無い → draft へ戻す
 *   - is_default_for_all なのに LINE の既定が別を指す → 既定を張り直す
 *     （既定ページの実体が LINE に無いときは張り直せないので、フラグを下ろす）
 *   - 失敗した公開runが残した lhm: メニュー → LINE から消す
 */
richMenuGroups.post(
  '/api/rich-menu-groups/:groupId/reconcile',
  requireDeliveryAccess('richMenus'),
  inputJsonBoundary(), post__api_rich_menu_groups_groupId_reconcile_10,
);

// ----- Unpublish -----

// LINE 上の alias / richmenu / default を全削除して draft に戻す。
// 削除フローや、別 group を default にしたい時に使う。idempotent (既に消えてる
// alias / richmenu は 404 を許容)。
richMenuGroups.post('/api/rich-menu-groups/:groupId/unpublish', requireDeliveryAccess('richMenus', 'publish'), inputJsonBoundary({"expectedVersion":["number"],"expectedPublishGeneration":["number"],"expectedIsDefaultForAll":["boolean"],"expectedPages":["array"],"expectedPublicationGeneration":["number"],"expectedConfirmationRevision":["number"]}), post__api_rich_menu_groups_groupId_unpublish_11);

// ----- Bulk apply by tag / set as account default -----

// 指定タグに紐づく友だち全員に、この group の default page の richmenu を割り当てる。
// LINE bulk link API (最大 500 ユーザー / リクエスト) を必要に応じて分割実行。
//
// body:
//   { mode?: 'bulk-link', tagId: string | null }
//     bulk-link (デフォルト): 該当 friends 全員に link。tagId=null は account 内全 follower。
//   { mode: 'set-default' }
//     LINE 公式アカウントの「全員のデフォルト」に設定。新規 follower にも自動で表示される。
//     同 account 内の他 group の is_default_for_all は 0 にリセット。
//
// 前提: group が published かつ default_page に line_richmenu_id がセット済み。
richMenuGroups.post('/api/rich-menu-groups/:groupId/apply-to-tag', requireDeliveryAccess('richMenus', 'publish'), inputJsonBoundary(), post__api_rich_menu_groups_groupId_apply_to_tag_1);

// ----- : 下書き複製 -----

/**
 * メニュー全体（ページ・ボタン・画像参照・出し分け条件）を別IDの下書きとして
 * 複製する。公開状態・予約・LINE richMenu ID・実行台帳は引き継がない。
 * Idempotency-Key で同じ操作を1回に数える。
 */
richMenuGroups.post(
  '/api/rich-menu-groups/:groupId/duplicate',
  requireDeliveryAccess('richMenus'),
  inputJsonBoundary(), post__api_rich_menu_groups_groupId_duplicate_2,
);

// ----- : staffへは合計だけ見せる影響人数 -----

/**
 * 「実際にこのメニューが出る人」の集計だけを返す読み取り口。
 * preview-targets（owner/admin）は友だち条件の内訳や上位メニュー名を返すが、
 * staff へは件数だけを出す。友だち個人の情報・条件の中身・他メニュー名は
 * ここには一切載せない。
 */
richMenuGroups.get('/api/rich-menu-groups/:groupId/audience-summary', get__api_rich_menu_groups_groupId_audience_summary_3);

/** テスト適用の現在状態。本人LINEが連携済みかもここで返す。 */
richMenuGroups.get('/api/rich-menu-groups/:groupId/test-apply', get__api_rich_menu_groups_groupId_test_apply_4);

/**
 * 本人確認済みのLINE（スタッフ連携済みの line_user_id）だけへテスト適用する。
 * 任意の友だちIDや他アカウントのユーザーを指定する口は作らない。
 *
 * - published なら既定ページの公開済みメニューをそのまま本人へリンク
 * - draft なら lht: 名のテスト専用メニューを LINE 上に作り、lhx- alias を
 *   張って切替が動く状態にしてから本人へリンク。戻す時に消す。
 */
richMenuGroups.post(
  '/api/rich-menu-groups/:groupId/test-apply',
  requireDeliveryAccess('richMenus', 'test'),
  inputJsonBoundary(), post__api_rich_menu_groups_groupId_test_apply_5,
);

/**
 * テスト適用を取り消し、適用前のメニューへ戻す。
 * 何度呼んでも同じ結果になる。戻す必要が無い（すでに戻した）場合も成功。
 */
richMenuGroups.post(
  '/api/rich-menu-groups/:groupId/test-apply/revert',
  requireDeliveryAccess('richMenus', 'test'),
  inputJsonBoundary(), post__api_rich_menu_groups_groupId_test_apply_revert_1,
);
