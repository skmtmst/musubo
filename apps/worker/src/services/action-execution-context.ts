import { createAutomationActionExecutors, type AutomationActionExecutorDependencies } from '../features/automations/automation-action-executors/index.js';
import { stableWebhookStepId } from './incoming-webhook-receipts.js';

/** 共通の実行一覧へ渡す。送信とマイルの重複防止キーは出来事・対象・処理から固定する。 */
export async function executeConfiguredAction(db: D1Database, input: {
  friendId: string; accountId?: string | null; source: string; sourceEventId: string;
  actionId: string; type: string; params: Record<string, unknown>;
  dependencies?: AutomationActionExecutorDependencies;
  commonVarPinOwner?: import('./usage-pinned-common-vars.js').PinOwner;
}): Promise<void> {
  const friend = await db.prepare('SELECT line_account_id FROM friends WHERE id = ?').bind(input.friendId)
    .first<{ line_account_id: string | null }>();
  const accountId = friend?.line_account_id;
  if (!accountId || (input.accountId && input.accountId !== accountId)) throw new Error('action_account_mismatch');
  const executor = createAutomationActionExecutors(input.dependencies)[input.type];
  if (!executor) throw new Error('unsupported_action_type');
  const key = await stableWebhookStepId(input.sourceEventId, `${input.source}:${input.friendId}:${input.actionId}`);
  await executor({ db, runId: key, lineAccountId: accountId, automationId: input.source,
    automationVersionId: input.source, friendId: input.friendId, sourceEventId: input.sourceEventId,
    inputEvent: { type: input.source }, action: { id: input.actionId, type: input.type, params: input.params, onFailure: 'stop' },
    stepExecutionId: key, idempotencyKey: key, attemptNumber: 1, commonActionVersionId: null, isTest: false, commonVarPinOwner: input.commonVarPinOwner });
}
