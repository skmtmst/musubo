import { mileageHandgift } from './mileage-handgift.js';
import { mileageHqAdoption } from './mileage-hq-adoption.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';

import type { Env } from '../worker-env.js';

import { requireIrreversibleConfirmation, requireRole } from '../middleware/role-guard.js';

import { post__api_mileage_exports_1, post__api_mileage_exports_2, get__api_mileage_reward_folders_3, post__api_mileage_reward_folders_4, put__api_mileage_reward_folders_order_5, put__api_mileage_rewards_id_folder_6, get__api_mileage_rewards_7, get__api_mileage_rewards_id_8, post__api_mileage_rewards_9, post__api_mileage_rewards_id_draft_10, post__api_mileage_rewards_id_publish_11, post__api_mileage_rewards_id_test_12, post__api_mileage_rewards_id_stop_13, post__api_mileage_rewards_id_status_14, put__api_mileage_rewards_order_15, post__api_mileage_rewards_id_codes_16, post__api_mileage_redemptions_17, get__api_mileage_redemptions_18, get__api_mileage_redemptions_id_19, post__api_mileage_redemptions_id_retry_fulfillment_20, get__api_mileage_friends_21, get__api_mileage_earning_rules_22, put__api_mileage_earning_rules_order_23, patch__api_mileage_earning_rules_id_draft_24 } from './scoring-reward-catalog-handlers.js';
import { handleMileageRewardDraftUpdate } from './scoring-definition.js';
import { post__api_mileage_earning_rules_id_publish_1, get__api_mileage_overview_2, get__api_mileage_history_3, get__api_mileage_adjustment_policy_4, put__api_mileage_adjustment_policy_5, post__api_mileage_adjustments_6, get__api_mileage_adjustment_approvals_7, post__api_mileage_adjustment_approvals_id_approve_8, post__api_mileage_adjustment_approvals_id_reject_9, post__api_mileage_adjustment_approvals_id_cancel_10, post__api_mileage_entries_id_confirm_11, post__api_mileage_entries_id_void_12 } from './scoring-earning-ledger-handlers.js';

import { post__api_mileage_entries_id_notification_retry_1, post__api_mileage_earning_rules_test_2, get__api_mileage_rules_3, get__api_mileage_rules_export_4, post__api_mileage_events_5, post__api_mileage_rules_6, put__api_mileage_rules_id_7, delete__api_mileage_rules_id_8, get__api_action_scores_friends_9, get__api_friends_id_score_10, post__api_friends_id_score_11 } from './scoring-rules-handlers.js';
import { requireMileageExport, legacyScoringRetired, requireVisibleFriendForScore } from './scoring-definition.js';

const scoring = new Hono<Env>();
scoring.route('/', mileageHandgift);
scoring.route('/', mileageHqAdoption);
export type { MileageRuleCreateInput } from './scoring-definition.js';

scoring.post('/api/mileage/exports', post__api_mileage_exports_1, inputJsonBoundary({ accountId: ['string'], kind: ['string'], reason: ['string'] }), post__api_mileage_exports_2);

// ========== マイル管理 ==========

// 使い道の分類はLINEアカウントごと。分類の変更は交換内容や公開版を変えない。
scoring.get('/api/mileage/reward-folders', requireRole('owner', 'admin', 'staff'), get__api_mileage_reward_folders_3);

scoring.post('/api/mileage/reward-folders', requireRole('owner', 'admin'), inputJsonBoundary(), post__api_mileage_reward_folders_4);

scoring.put('/api/mileage/reward-folders/order', requireRole('owner', 'admin'), inputJsonBoundary(), put__api_mileage_reward_folders_order_5);

scoring.put('/api/mileage/rewards/:id/folder', requireRole('owner', 'admin'), inputJsonBoundary(), put__api_mileage_rewards_id_folder_6);

scoring.get('/api/mileage/rewards', requireRole('owner', 'admin', 'staff'), get__api_mileage_rewards_7);

scoring.get('/api/mileage/rewards/:id', requireRole('owner', 'admin', 'staff'), get__api_mileage_rewards_id_8);

scoring.post('/api/mileage/rewards', requireRole('owner', 'admin'), inputJsonBoundary({"draft":["object"]}), post__api_mileage_rewards_9);

scoring.patch(
  '/api/mileage/rewards/:id/draft',
  requireRole('owner', 'admin'),
  inputJsonBoundary({"draft":["object"]}), handleMileageRewardDraftUpdate,
);

// 旧画面が段階的に移行できる間だけ、同じ契約をPUTでも受ける。
scoring.put(
  '/api/mileage/rewards/:id/draft',
  requireRole('owner', 'admin'),
  inputJsonBoundary({"draft":["object"]}), handleMileageRewardDraftUpdate,
);

scoring.post('/api/mileage/rewards/:id/draft', requireRole('owner', 'admin'), inputJsonBoundary(), post__api_mileage_rewards_id_draft_10);

scoring.post(
  '/api/mileage/rewards/:id/publish',
  requireRole('owner', 'admin'),
  requireIrreversibleConfirmation('mileage-reward-publish'),
  inputJsonBoundary(), post__api_mileage_rewards_id_publish_11,
);

scoring.post('/api/mileage/rewards/:id/test', requireRole('owner', 'admin'), inputJsonBoundary(), post__api_mileage_rewards_id_test_12);

scoring.post('/api/mileage/rewards/:id/stop', requireRole('owner', 'admin'), inputJsonBoundary(), post__api_mileage_rewards_id_stop_13);

scoring.post('/api/mileage/rewards/:id/status', requireRole('owner', 'admin'), inputJsonBoundary(), post__api_mileage_rewards_id_status_14);

scoring.put('/api/mileage/rewards-order', requireRole('owner', 'admin'), inputJsonBoundary(), put__api_mileage_rewards_order_15);

scoring.post('/api/mileage/rewards/:id/codes', requireRole('owner', 'admin'), inputJsonBoundary(), post__api_mileage_rewards_id_codes_16);

scoring.post(
  '/api/mileage/redemptions',
  requireRole('owner', 'admin'),
  requireIrreversibleConfirmation('mileage-redemption'),
  inputJsonBoundary(), post__api_mileage_redemptions_17,
);

// 交換履歴の一覧。残高を減らしたのに特典が届かなかった交換を、管理画面で
// 見つけるための口。既定は要対応（失敗中＋送ったか分からない配送中）。
// 照合待ちを既定の一覧から消さない。秘密の処理IDは落として返す。
scoring.get(
  '/api/mileage/redemptions',
  requireRole('owner', 'admin', 'staff'),
  get__api_mileage_redemptions_18,
);

scoring.get(
  '/api/mileage/redemptions/:id',
  requireRole('owner', 'admin', 'staff'),
  get__api_mileage_redemptions_id_19,
);

scoring.post(
  '/api/mileage/redemptions/:id/retry-fulfillment',
  requireRole('owner', 'admin'),
  inputJsonBoundary(), post__api_mileage_redemptions_id_retry_fulfillment_20,
);

scoring.get('/api/mileage/friends', requireRole('owner', 'admin', 'staff'), get__api_mileage_friends_21);

scoring.get('/api/mileage/earning-rules', requireRole('owner', 'admin', 'staff'), get__api_mileage_earning_rules_22);

/*
 * PUT /api/mileage/earning-rules-order — 「たまる決めごと」の並び順を
 * 全件まとめて保存する。1件ずつ下書きPATCHを並列に投げる従来方式は
 * 途中失敗で一部だけ反映され得るため、rewards-order と同じ一括口の構造で
 * アカウントの一覧と一致する全順序だけを受け付ける。
 */
scoring.put('/api/mileage/earning-rules-order', requireRole('owner', 'admin'), inputJsonBoundary(), put__api_mileage_earning_rules_order_23);

scoring.patch('/api/mileage/earning-rules/:id/draft', requireRole('owner', 'admin'), inputJsonBoundary(), patch__api_mileage_earning_rules_id_draft_24);

// POST /api/mileage/earning-rules/:id/publish — 下書きを公開版として固定し、実行へ反映する。
//
//  案1。公開後に受け付けたイベントだけ新版で、公開前にキューへ入った
// 未処理イベントは旧版のまま。既存の台帳・残高は変えない。
scoring.post(
  '/api/mileage/earning-rules/:id/publish',
  requireRole('owner', 'admin'),
  requireIrreversibleConfirmation('mileage-earning-rule-publish'),
  inputJsonBoundary(), post__api_mileage_earning_rules_id_publish_1,
);

scoring.get('/api/mileage/overview', requireRole('owner', 'admin', 'staff'), get__api_mileage_overview_2);

scoring.get('/api/mileage/history', requireRole('owner', 'admin', 'staff'), get__api_mileage_history_3);

scoring.get('/api/mileage/adjustment-policy', requireRole('owner', 'admin'), get__api_mileage_adjustment_policy_4);

scoring.put('/api/mileage/adjustment-policy', requireRole('owner'), inputJsonBoundary(), put__api_mileage_adjustment_policy_5);

scoring.post(
  '/api/mileage/adjustments',
  requireRole('owner', 'admin'),
  requireIrreversibleConfirmation('mileage-adjustment'),
  inputJsonBoundary(), post__api_mileage_adjustments_6,
);

/*
 * 高額調整の承認依頼の一覧・承認・差し戻し・取り下げ。
 * 承認は「依頼した人とは別のオーナー」だけが行える（二者承認）。
 */
scoring.get('/api/mileage/adjustment-approvals', requireRole('owner', 'admin'), get__api_mileage_adjustment_approvals_7);

scoring.post(
  '/api/mileage/adjustment-approvals/:id/approve',
  requireRole('owner'),
  inputJsonBoundary(), post__api_mileage_adjustment_approvals_id_approve_8,
);

scoring.post(
  '/api/mileage/adjustment-approvals/:id/reject',
  requireRole('owner'),
  inputJsonBoundary(), post__api_mileage_adjustment_approvals_id_reject_9,
);

scoring.post(
  '/api/mileage/adjustment-approvals/:id/cancel',
  requireRole('owner', 'admin'),
  inputJsonBoundary(), post__api_mileage_adjustment_approvals_id_cancel_10,
);

/*
 * 確定待ちの確定・取消。どちらも理由が必須。確定は pending→available、
 * 取消は逆向きの記録を足す（台帳の行は消さない）。
 */
scoring.post(
  '/api/mileage/entries/:id/confirm',
  requireRole('owner', 'admin'),
  inputJsonBoundary(), post__api_mileage_entries_id_confirm_11,
);

scoring.post(
  '/api/mileage/entries/:id/void',
  requireRole('owner', 'admin'),
  requireIrreversibleConfirmation('mileage-entry-void'),
  inputJsonBoundary(), post__api_mileage_entries_id_void_12,
);

/*
 * 手動調整の友だち通知だけをあとから再送する。
 * 残高は動かさない。通知記録があれば保存済みの本文・送信キーで再送し、
 * 記録自体が作れなかった調整では台帳の依頼印（notifyFriend）を見て
 * 本文を組み直して送る。sent 済みの再送は sendMileageNotification 側で
 * 何もしない（二重送信しない）。
 */
scoring.post(
  '/api/mileage/entries/:id/notification-retry',
  requireRole('owner', 'admin'),
  inputJsonBoundary(), post__api_mileage_entries_id_notification_retry_1,
);

scoring.post(
  '/api/mileage/earning-rules/test',
  requireRole('owner', 'admin'),
  inputJsonBoundary(), post__api_mileage_earning_rules_test_2,
);

scoring.get('/api/mileage/rules', requireRole('owner', 'admin', 'staff'), get__api_mileage_rules_3);

scoring.get('/api/mileage/rules/export', requireMileageExport('mileage.ledger.export'), get__api_mileage_rules_export_4);

// 認証済みの共通入口ではイベントとキューだけを記録し、マイル計算は cron へ分ける。
scoring.post('/api/mileage/events', requireRole('owner', 'admin'), inputJsonBoundary(), post__api_mileage_events_5);

scoring.post('/api/mileage/rules', requireRole('owner', 'admin'), inputJsonBoundary({"name":["string"],"eventType":["string"],"source":["null","string"],"amount":["number"],"initialStatus":["string"],"conditions":["null","object"],"validFrom":["null","string"],"validUntil":["null","string"],"lineAccountId":["string"],"isActive":["boolean"]}), post__api_mileage_rules_6);

scoring.put('/api/mileage/rules/:id', requireRole('owner', 'admin'), inputJsonBoundary({"name":["string"],"eventType":["string"],"source":["null","string"],"amount":["number"],"initialStatus":["string"],"conditions":["null","object"],"isActive":["boolean"]}), put__api_mileage_rules_id_7);

scoring.delete('/api/mileage/rules/:id', requireRole('owner', 'admin'), delete__api_mileage_rules_id_8);

scoring.get('/api/action-scores/friends', requireRole('owner', 'admin', 'staff'), get__api_action_scores_friends_9);

scoring.get('/api/scoring-rules', legacyScoringRetired);

scoring.get('/api/scoring-rules/:id', legacyScoringRetired);

scoring.post('/api/scoring-rules', legacyScoringRetired);

scoring.put('/api/scoring-rules/:id', legacyScoringRetired);

scoring.delete('/api/scoring-rules/:id', legacyScoringRetired);

// ========== 友だちスコア ==========

scoring.get('/api/friends/:id/score', requireVisibleFriendForScore, get__api_friends_id_score_10);

// 手動スコア加算
scoring.post('/api/friends/:id/score', requireRole('owner', 'admin'), requireVisibleFriendForScore, inputJsonBoundary({"scoreChange":["number"],"reason":["string"]}), post__api_friends_id_score_11);

export { scoring };
