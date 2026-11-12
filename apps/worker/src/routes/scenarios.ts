import { inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';

import type { Env } from '../worker-env.js';
import { requireDeliveryAccess, requirePermission } from '../middleware/role-guard.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { bulkStopScenarios } from './scenarios-bulk-stop.js';

import { get__api_scenarios_id_question_answers_1, post__api_scenarios_id_question_answers_executionId_resume_2, patch__api_scenarios_reorder_3, get__api_scenarios_4, get__api_scenarios_id_5, post__api_scenarios_6, put__api_scenarios_id_7, get__api_scenarios_id_move_referrers_8, delete__api_scenarios_id_9, post__api_scenarios_id_steps_10 } from './scenarios-drafts-handlers.js';
import { requireVisibleScenario, scenarioPermission, requireScenarioEditBoundary, scenarioSubscriptionScope } from './scenarios-definition.js';
import { put__api_scenarios_id_steps_stepId_1, delete__api_scenarios_id_steps_stepId_2, post__api_scenarios_id_steps_reorder_3, get__api_scenarios_id_preview_4, get__api_scenarios_id_stats_5, post__api_scenarios_id_simulate_6, get__api_scenarios_id_runs_7, get__api_scenarios_id_friends_friendId_plan_8, put__api_scenarios_id_draft_9, post__api_scenarios_id_enroll_friendId_10 } from './scenarios-steps-handlers.js';

import { post__api_scenarios_id_publish_1, get__api_scenarios_id_actions_2, post__api_scenarios_id_actions_3, put__api_scenarios_id_actions_actionId_4, delete__api_scenarios_id_actions_actionId_5, post__api_scenarios_id_test_send_6, post__api_scenarios_id_steps_stepId_test_send_7, get__api_scenarios_id_triggers_8, post__api_scenarios_id_triggers_9, get__api_scenarios_id_draft_10, delete__api_scenarios_id_triggers_triggerId_11, post__api_scenario_subscriptions_subscriptionId_pause_12, post__api_scenario_subscriptions_subscriptionId_resume_13, post__api_scenario_subscriptions_subscriptionId_retry_14, post__api_scenario_subscriptions_subscriptionId_move_15 } from './scenarios-publication-handlers.js';

const scenarios = new Hono<Env>();

scenarios.post('/api/scenarios/bulk-stop', requireDeliveryAccess('scenarios', 'publish'), inputJsonBoundary(), bulkStopScenarios);

scenarios.get('/api/scenarios/:id/question-answers', requireDeliveryAccess('scenarios'), requireVisibleScenario, get__api_scenarios_id_question_answers_1);

scenarios.post('/api/scenarios/:id/question-answers/:executionId/resume',requireDeliveryAccess('scenarios'),requireVisibleScenario,inputJsonBoundary(), post__api_scenarios_id_question_answers_executionId_resume_2);

/**
 * PATCH /api/scenarios/reorder — 並び順をまとめて書く。
 *
 * 経路が /api/scenarios/:id より前にあるのは、:id に "reorder" として
 * 食われないようにするため。
 */
scenarios.patch('/api/scenarios/reorder', requireDeliveryAccess('scenarios'), inputJsonBoundary(), patch__api_scenarios_reorder_3);

// GET /api/scenarios - list all
scenarios.get('/api/scenarios', scenarioPermission('view'), get__api_scenarios_4);


scenarios.use('/api/scenarios/:id', requireVisibleScenario);

scenarios.use('/api/scenarios/:id/*', requireVisibleScenario);

scenarios.get('/api/scenarios/:id', scenarioPermission('view'), get__api_scenarios_id_5);

scenarios.get('/api/scenarios/:id/confirmation', requireScenarioEditBoundary, async (c) => {
  if (!await scenarioSubscriptionScope(c, c.req.param('id'))) return c.json({ success: false, error: '関連する対象を確認できないため操作できません' }, 403);
  const row = await c.env.DB.prepare(`SELECT s.content_revision AS contentRevision,
    (SELECT COUNT(*) FROM friend_scenarios WHERE scenario_id=s.id AND status IN ('active','delivering')) AS activeCount,
    (SELECT COALESCE(SUM(rowid),0) FROM friend_scenarios WHERE scenario_id=s.id AND status IN ('active','delivering')) AS rowIdSum,
    (SELECT COALESCE(SUM((rowid % 104729) * (rowid % 104729)),0) FROM friend_scenarios WHERE scenario_id=s.id AND status IN ('active','delivering')) AS rowIdSquareSum,
    (SELECT COUNT(*) FROM friend_scenarios WHERE scenario_id=s.id) AS totalCount,
    (SELECT COALESCE(SUM(rowid),0) FROM friend_scenarios WHERE scenario_id=s.id) AS totalRowIdSum,
    (SELECT COALESCE(SUM((rowid % 104729) * (rowid % 104729)),0) FROM friend_scenarios WHERE scenario_id=s.id) AS totalRowIdSquareSum,
    (SELECT json_group_array(json_object('id', id, 'revision', content_revision, 'accountId', line_account_id)) FROM
      (SELECT id, content_revision, line_account_id FROM scenarios WHERE on_complete_scenario_id=s.id ORDER BY id)) AS referrers
    FROM scenarios s WHERE s.id=?`).bind(c.req.param('id')).first<{ contentRevision: number; activeCount: number; rowIdSum: number; rowIdSquareSum: number; totalCount: number; totalRowIdSum: number; totalRowIdSquareSum: number; referrers: string }>();
  if (!row) return c.json({ success: false, error: 'SCENARIO_NOT_FOUND' }, 404);
  const referrers = c.req.query('purpose') === 'delete' ? JSON.parse(row.referrers) as Array<{ id: string; revision: number; accountId: string | null }> : [];
  if (referrers.length && !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), referrers.map(item => item.accountId)))
    return c.json({ success: false, error: '関連する設定を確認できないため操作できません' }, 409);
  return c.json({ success: true, data: { contentRevision: row.contentRevision, activeCount: row.activeCount, rowIdSum: row.rowIdSum, rowIdSquareSum: row.rowIdSquareSum, totalCount: row.totalCount, totalRowIdSum: row.totalRowIdSum, totalRowIdSquareSum: row.totalRowIdSquareSum, referrers: referrers.map(({ id, revision }) => ({ id, revision })) } });
});

// POST /api/scenarios - create
scenarios.post('/api/scenarios', requireDeliveryAccess('scenarios'), inputJsonBoundary({"name":["string"],"description":["null","string"],"triggerType":["string"],"triggerTagId":["null","string"],"isActive":["boolean"],"lineAccountId":["null","string"],"deliveryMode":["string"],"allowConcurrent":["boolean"],"folderId":["null","string"]}), post__api_scenarios_6);

// 入力はクライアントの camelCase を受け付ける。
scenarios.put('/api/scenarios/:id', requireScenarioEditBoundary, inputJsonBoundary({"name":["string"],"description":["null","string"],"triggerType":["string"],"triggerTagId":["null","string"],"isActive":["boolean"],"reason":["string"],"deliveryMode":["string"],"allowConcurrent":["boolean"],"folderId":["null","string"],"onCompleteMode":["string"],"onCompleteScenarioId":["null","string"]}), put__api_scenarios_id_7);

// GET /api/scenarios/:id/move-referrers - 終了後の移動先にしているシナリオの一覧
//
// 消す前に「どのシナリオの終了後の処理が変わるか」を確認窓で見せる
// ための読み取り。消したあとは参照元の終了後の処理が「一時停止」へ戻る
// （deleteScenario が原子で直す）ので、この一覧は消す前の案内専用。
scenarios.get('/api/scenarios/:id/move-referrers', scenarioPermission('view'), get__api_scenarios_id_move_referrers_8);

// 移動先のない遷移を残さないよう、参照されていたシナリオの終了後処理は削除と同じ batch で一時停止へ戻す。
scenarios.delete('/api/scenarios/:id', requireDeliveryAccess('scenarios'), requireScenarioEditBoundary, delete__api_scenarios_id_9);

// POST /api/scenarios/:id/steps - add step
scenarios.post('/api/scenarios/:id/steps', requireDeliveryAccess('scenarios'), requireScenarioEditBoundary, inputJsonBoundary({"stepOrder":["number"],"delayMinutes":["number"],"offsetDays":["number"],"offsetMinutes":["number"],"deliveryTime":["string"],"messageType":["string"],"messageContent":["string"],"conditionType":["null","string"],"conditionValue":["null","string"],"nextStepOnFalse":["null","number"],"templateId":["null","string"],"onReachTagId":["null","string"],"afterSend":["string"],"isDraft":["boolean"]}), post__api_scenarios_id_steps_10);

// PUT /api/scenarios/:id/steps/:stepId - update step (accepts camelCase)
scenarios.put('/api/scenarios/:id/steps/:stepId', requireDeliveryAccess('scenarios'), requireScenarioEditBoundary, inputJsonBoundary({"stepOrder":["number"],"delayMinutes":["number"],"offsetDays":["number"],"offsetMinutes":["number"],"deliveryTime":["string"],"messageType":["string"],"messageContent":["string"],"conditionType":["null","string"],"conditionValue":["null","string"],"nextStepOnFalse":["null","number"],"templateId":["null","string"],"onReachTagId":["null","string"],"afterSend":["string"],"isDraft":["boolean"]}), put__api_scenarios_id_steps_stepId_1);


scenarios.delete('/api/scenarios/:id/steps/:stepId', requireDeliveryAccess('scenarios'), requireScenarioEditBoundary, delete__api_scenarios_id_steps_stepId_2);

// POST /api/scenarios/:id/steps/reorder - bulk update step_order
scenarios.post('/api/scenarios/:id/steps/reorder', requireDeliveryAccess('scenarios'), requireScenarioEditBoundary, inputJsonBoundary({"orders":["array"]}), post__api_scenarios_id_steps_reorder_3);

scenarios.get('/api/scenarios/:id/preview', scenarioPermission('view'), get__api_scenarios_id_preview_4);

// GET /api/scenarios/:id/stats - reach rate dashboard
scenarios.get('/api/scenarios/:id/stats', scenarioPermission('view'), get__api_scenarios_id_stats_5);

// POST /api/scenarios/:id/simulate — 実データを数えるが、送信・購読は行わない。
scenarios.post('/api/scenarios/:id/simulate', scenarioPermission('view'), inputJsonBoundary(), post__api_scenarios_id_simulate_6);

// GET /api/scenarios/:id/runs — 購読・テスト送信・送信枠を同じ応答で返す。
scenarios.get('/api/scenarios/:id/runs', scenarioPermission('view'), get__api_scenarios_id_runs_7);

/*
 * GET /api/scenarios/:id/friends/:friendId/plan — 選んだ友だちへの配信予定を
 * 副作用なしで試算する。
 *
 * 「シナリオ確認」の中から検証用の友だちを選んで、配信予定・待機・分岐理由を
 * 見る口。送信・購読登録・タグ更新は一切行わない（応答の sideEffects:false）。
 * 友だち側のアカウント境界も見る（手動登録と同じ。担当外の友だちは404で隠す）。
 */
scenarios.get('/api/scenarios/:id/friends/:friendId/plan', scenarioPermission('view'), get__api_scenarios_id_friends_friendId_plan_8);

// PUT /api/scenarios/:id/draft — compare-and-set で送信後アクションを保存する。
scenarios.put('/api/scenarios/:id/draft', scenarioPermission('edit'), inputJsonBoundary(), put__api_scenarios_id_draft_9);

// POST /api/scenarios/:id/enroll/:friendId - manually enroll friend
scenarios.post('/api/scenarios/:id/enroll/:friendId', requireDeliveryAccess('scenarios'), requireScenarioEditBoundary, inputJsonBoundary(), post__api_scenarios_id_enroll_friendId_10);

// POST /api/scenarios/:id/publish — いまの下書きを公開版として固定する。
//
// 下書きの編集は公開するまで配信へ混入しない。購読は開始時の版へ固定され、
// 開始後の編集は次に公開した版の購読から使う。
// アカウント境界は /api/scenarios/:id 系の共通ミドルウェアで 404 にする。
scenarios.post('/api/scenarios/:id/publish', requireDeliveryAccess('scenarios', 'publish'), requireScenarioEditBoundary, inputJsonBoundary(), post__api_scenarios_id_publish_1);

// GET /api/scenarios/:id/actions — シナリオのアクションを全部返す
scenarios.get('/api/scenarios/:id/actions', scenarioPermission('view'), get__api_scenarios_id_actions_2);

// POST /api/scenarios/:id/actions — アクションを1つ足す
scenarios.post('/api/scenarios/:id/actions', requireDeliveryAccess('scenarios'), requireScenarioEditBoundary, inputJsonBoundary({"hook":["string"],"stepId":["null","string"],"choiceIndex":["null","number"],"actionType":["string"],"repeatOnRefire":["boolean"],"sortOrder":["number"]}), post__api_scenarios_id_actions_3);

// PUT /api/scenarios/:id/actions/:actionId — 中身と並び順を変える
scenarios.put('/api/scenarios/:id/actions/:actionId', requireDeliveryAccess('scenarios'), requireScenarioEditBoundary, inputJsonBoundary({"hook":["string"],"stepId":["null","string"],"choiceIndex":["null","number"],"actionType":["string"],"repeatOnRefire":["boolean"],"sortOrder":["number"]}), put__api_scenarios_id_actions_actionId_4);


scenarios.delete('/api/scenarios/:id/actions/:actionId', requireDeliveryAccess('scenarios'), requireScenarioEditBoundary, delete__api_scenarios_id_actions_actionId_5);

scenarios.post('/api/scenarios/:id/test-send', requireDeliveryAccess('scenarios', 'test'), requireScenarioEditBoundary, inputJsonBoundary(), post__api_scenarios_id_test_send_6,
);

scenarios.post(
  '/api/scenarios/:id/steps/:stepId/test-send',
  requireDeliveryAccess('scenarios', 'test'), requireScenarioEditBoundary,
  inputJsonBoundary(), post__api_scenarios_id_steps_stepId_test_send_7,
);

// ============================================================
// 開始のきっかけ（scenario_triggers）
// ============================================================

/*
 * 1本のシナリオに複数のきっかけを持たせられる。
 *
 *   friend_add … 友だち追加時
 *   tag_added  … 決めたタグが付いたとき
 *
 * 行が0本なら「外から呼ばれたときだけ流れる」。アクション・質問の選択肢・
 * 友だち追加時の配信から開始できるので、それが手動と同じ意味になる。
 */

scenarios.get('/api/scenarios/:id/triggers', scenarioPermission('view'), get__api_scenarios_id_triggers_8);

scenarios.post('/api/scenarios/:id/triggers', requireScenarioEditBoundary, inputJsonBoundary({"kind":["string"],"tagId":["null","string"]}), post__api_scenarios_id_triggers_9);

// GET /api/scenarios/:id/draft — 編集画面を開いたときの下書き読み返し。
scenarios.get('/api/scenarios/:id/draft', scenarioPermission('view'), get__api_scenarios_id_draft_10);

scenarios.delete(
  '/api/scenarios/:id/triggers/:triggerId',
  requireDeliveryAccess('scenarios'),
  requireScenarioEditBoundary,
  delete__api_scenarios_id_triggers_triggerId_11,
);

// POST /api/scenario-subscriptions/:subscriptionId/pause — 手動で止める
scenarios.post(
  '/api/scenario-subscriptions/:subscriptionId/pause',
  requirePermission('scenario.subscription.edit'),
  inputJsonBoundary(), post__api_scenario_subscriptions_subscriptionId_pause_12,
);

// POST /api/scenario-subscriptions/:subscriptionId/resume — 止まっている購読を再開する
scenarios.post(
  '/api/scenario-subscriptions/:subscriptionId/resume',
  requirePermission('scenario.subscription.edit'),
  inputJsonBoundary(), post__api_scenario_subscriptions_subscriptionId_resume_13,
);

// POST /api/scenario-subscriptions/:subscriptionId/retry — 配信失敗で止まった購読を失敗した通から送り直す
scenarios.post(
  '/api/scenario-subscriptions/:subscriptionId/retry',
  requirePermission('scenario.step_run.retry'),
  inputJsonBoundary(), post__api_scenario_subscriptions_subscriptionId_retry_14,
);

// POST /api/scenario-subscriptions/:subscriptionId/move — 別のシナリオへ移す
scenarios.post(
  '/api/scenario-subscriptions/:subscriptionId/move',
  requirePermission('scenario.subscription.edit'),
  inputJsonBoundary(), post__api_scenario_subscriptions_subscriptionId_move_15,
);

export { scenarios };
