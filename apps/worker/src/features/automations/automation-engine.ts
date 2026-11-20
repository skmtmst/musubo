import { readFollowupEngineGate } from '../../services/restaurant-followup-engine-approval.js';
import { readRestaurantAutomationSource } from '../../services/restaurant-automation-source.js';
import { readRestaurantAutomationDeliveryGate, type RestaurantAutomationDeliveryScope } from '../../services/restaurant-automation-delivery-gate.js';
import { buildExecutionPlan, parseActions, resolveCommonActionVersion, type ActionDefinition } from './automation-plan.js';
export { resolveCommonActionVersion, COMMON_ACTION_MAX_BRANCH_DEPTH, COMMON_ACTION_MAX_DEPTH, COMMON_ACTION_MAX_STEPS } from './automation-plan.js';
export type { ActionDefinition } from './automation-plan.js';
export type { RunStatus, RunRow, StepRow } from './run-types.js';
import type { RunStatus, RunRow, StepRow, StepStatus } from './run-types.js';
import { getRun, getStep } from './automation-run-state.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
/**
 * オートメーションの実行状態機械。
 *
 * 旧 automations.actions は読まない。実行開始時に公開版と共通アクション版を
 * 固定し、外部処理は注入された executor に同じ stepExecutionId を渡す。
*/

import type { SegmentCondition } from '@line-crm/shared';
import { matchesCondition } from '../../services/segment-query.js';
import { AutomationActionError } from './automation-action-error.js';
import { addMinutes, expireNextDayWait, scheduleAutomationWait } from './automation-wait.js';
import { featureJobCanRun } from '../../services/feature-enforcement.js';
import { isOperationCapabilityStopped, listLineAccountsWithTenantStatus } from '@line-crm/db';

const DEFAULT_LEASE_MINUTES = 5;
const RETRY_DELAYS_MINUTES = [1, 5, 30] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MINUTES.length + 1;

export interface AutomationRunStartInput {
  lineAccountId: string;
  automationId: string;
  /** 1人テストだけが指定する。定義の稼働状態を変えず、この版を固定する。 */
  automationVersionId?: string;
  sourceEventId: string;
  idempotencyKey: string;
  friendId?: string | null;
  inputEvent?: Record<string, unknown>;
  conditionMatched: boolean;
  isTest?: boolean;
  now?: string;
}

export interface AutomationRunStartResult {
  kind: 'created' | 'existing' | 'not_active';
  runId: string | null;
  status: RunStatus | null;
  automationVersionId: string | null;
}

export interface AutomationActionContext {
  db: D1Database;
  runId: string;
  lineAccountId: string;
  automationId: string;
  automationVersionId: string;
  friendId: string | null;
  sourceEventId: string;
  inputEvent: Record<string, unknown>;
  action: ActionDefinition;
  stepExecutionId: string;
  idempotencyKey: string;
  attemptNumber: number;
  commonActionVersionId: string | null;
  isTest: boolean;
  restaurantDeliveryScope?: RestaurantAutomationDeliveryScope;
  commonVarPinOwner?: import('../../services/usage-pinned-common-vars.js').PinOwner;
}

export type AutomationActionExecutor = (
  context: AutomationActionContext,
) => Promise<{ output?: unknown } | void>;

export interface AutomationEngineOptions {
  executors?: Record<string, AutomationActionExecutor>;
  now?: string;
  leaseMinutes?: number;
  /** 状態の強制判定が N+1 にならないよう、cron が同じスナップショットを共有する。 */
  tenantStatusByAccount?: ReadonlyMap<string, 'active' | 'suspended' | 'archived'>;
}

export { AutomationActionError } from './automation-action-error.js';

/** 再試行は配送 outbox が管理するため、ポーリングでアクションの再試行予算を使わない。 */
export class AutomationActionDeferred extends Error {}

export class AutomationRunRetryError extends Error {
  constructor(
    public readonly code: 'not_found' | 'not_retryable' | 'retry_conflict',
    message: string,
  ) {
    super(message);
    this.name = 'AutomationRunRetryError';
  }
}

export class AutomationRunCancelError extends Error {
  constructor(
    public readonly code: 'not_found' | 'not_cancellable',
    message: string,
  ) {
    super(message);
    this.name = 'AutomationRunCancelError';
  }
}


function nowIso(value?: string): string {
  return value ?? new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new AutomationActionError('invalid_input_event', '実行入力が不正です', false);
  return value;
}

/** 親分岐の完了記録だけを読む。旧計画は通のパスから親を特定する。 */
async function recordedBranchSelected(
  db: D1Database, runId: string, actions: ActionDefinition[], action: ActionDefinition,
): Promise<boolean> {
  const used = new Set<string>();
  for (const item of action.branchConditions ?? []) {
    const side = item.expected ? 'then' : 'else';
    const marker = actions.find((candidate) => candidate.type === 'branch_marker'
      && !used.has(candidate.id)
      && action.id.startsWith(`${candidate.id}/${side}/`)
      && (item.branchStepKey ? candidate.id === item.branchStepKey
        : JSON.stringify(candidate.params.condition) === JSON.stringify(item.condition)));
    if (!marker) throw new AutomationActionError('branch_result_missing', '分岐の結果を確認できません', false);
    used.add(marker.id);
    const saved = await db.prepare(
      `SELECT status, output_json FROM automation_run_steps
        WHERE automation_run_id = ? AND step_key = ?`,
    ).bind(runId, marker.id).first<{ status: string; output_json: string | null }>();
    let output: Record<string, unknown>;
    try { output = parseObject(saved?.output_json ?? ''); }
    catch { throw new AutomationActionError('branch_result_missing', '分岐の結果を確認できません', false); }
    if (saved?.status !== 'success' || typeof output.matched !== 'boolean') {
      throw new AutomationActionError('branch_result_missing', '分岐の結果を確認できません', false);
    }
    if (output.matched !== item.expected) return false;
  }
  return true;
}

async function precreateSteps(db: D1Database, run: RunRow, actions: ActionDefinition[]): Promise<void> {
  for (const action of actions) {
    const stepId = crypto.randomUUID();
    const commonActionVersionId = action.commonActionVersionId ?? await resolveCommonActionVersion(db, {
      lineAccountId: run.line_account_id,
      automationId: run.automation_id,
      action,
    });
    await db.prepare(
      `INSERT OR IGNORE INTO automation_run_steps
         (id, automation_run_id, step_key, action_type, common_action_version_id,
          attempt_number, idempotency_key, status, input_json)
       VALUES (?, ?, ?, ?, ?, 1, ?, 'queued', ?)`,
    ).bind(
      stepId,
      run.id,
      action.id,
      action.type,
      commonActionVersionId,
      stepId,
      JSON.stringify(action.params),
    ).run();
  }
}

export async function startAutomationRun(
  db: D1Database,
  input: AutomationRunStartInput,
): Promise<AutomationRunStartResult> {
  const now = nowIso(input.now);
  const published = await db.prepare(
    `SELECT d.id AS automation_id, v.id AS version_id,
            v.action_config, v.trigger_type
       FROM automation_definitions d
       JOIN automation_versions v
         ON v.id = CASE WHEN ? = 1 THEN ? ELSE d.current_published_version_id END
        AND v.automation_id = d.id
        AND (? = 1 OR v.status = 'published')
      WHERE d.id = ? AND d.line_account_id = ?
        AND (? = 1 OR d.status = 'active')
        AND (? = 0 OR v.id IN (d.current_draft_version_id, d.current_published_version_id))`,
  ).bind(
    input.isTest ? 1 : 0,
    input.automationVersionId ?? null,
    input.isTest ? 1 : 0,
    input.automationId,
    input.lineAccountId,
    input.isTest ? 1 : 0,
    input.isTest ? 1 : 0,
  ).first<{
    automation_id: string;
    version_id: string;
    action_config: string;
    trigger_type: string;
  }>();
  if (!published) {
    return { kind: 'not_active', runId: null, status: null, automationVersionId: null };
  }

  const runId = crypto.randomUUID();
  const status: RunStatus = input.conditionMatched ? 'queued' : 'skipped_condition';
  let executionPlan: ActionDefinition[] = [];
  if (status === 'queued') {
    try {
      executionPlan = await buildExecutionPlan(db, {
        lineAccountId: input.lineAccountId,
        automationId: input.automationId,
        actions: parseActions(published.action_config),
      });
    } catch (error) {
      const failure = normalizeError(error);
      executionPlan = [{
        id: '__configuration__', type: 'invalid_configuration', params: {
          errorCode: failure.code, errorMessage: failure.message,
        }, onFailure: 'stop',
      }];
    }
  }
  const approval = await readFollowupEngineGate(db,{
    engine:'automation',targetId:input.automationId,lineAccountId:input.lineAccountId,versionId:published.version_id,
    ...(status==='queued'?{executionPlanJson:JSON.stringify(executionPlan)}:{}),
  });
  if(!approval.allowed||input.isTest&&approval.managed)return {kind:'not_active',runId:null,status:null,automationVersionId:null};
  const source = input.isTest ? {restaurant:false as const,allowed:true as const} : await readRestaurantAutomationSource(db,{
    eventType:published.trigger_type,eventId:input.sourceEventId,lineAccountId:input.lineAccountId,friendId:input.friendId??null,now,strict:approval.managed,
  });
  if(!source.allowed || (approval.managed&&(!source.restaurant||source.context.store_id!==approval.storeId)))
    return {kind:'not_active',runId:null,status:null,automationVersionId:null};
  const guards=[...(approval.managed?[approval.guard]:[]),...(source.restaurant?[source.guard]:[])];
  const writeGuard=guards.length?{sql:guards.map(item=>`(${item.sql})`).join(' AND '),binds:guards.flatMap(item=>item.binds)}:null;
  const runInput=approval.managed?{...(input.inputEvent??{}),__restaurantFollowup:{contentHash:approval.snapshot.contentHash}}:input.inputEvent??{};
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO automation_runs
       (id, line_account_id, automation_id, automation_version_id, friend_id,
        source_event_id, idempotency_key, status, input_event_json, is_test,
        completed_at, created_at, execution_plan_json)
     ${writeGuard?'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE '+writeGuard.sql:'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'}`,
  ).bind(
    runId,
    input.lineAccountId,
    input.automationId,
    published.version_id,
    input.friendId ?? null,
    input.sourceEventId,
    input.idempotencyKey,
    status,
    JSON.stringify(runInput),
    input.isTest ? 1 : 0,
    status === 'skipped_condition' ? now : null,
    now,
    status === 'queued' ? JSON.stringify(executionPlan) : null,
    ...(writeGuard?.binds??[]),
  ).run();

  if ((inserted.meta?.changes ?? 0) !== 1) {
    const existing = await db.prepare(
      `SELECT id, status, automation_version_id
         FROM automation_runs
        WHERE line_account_id = ? AND automation_id = ? AND idempotency_key = ?`,
    ).bind(input.lineAccountId, input.automationId, input.idempotencyKey).first<{
      id: string;
      status: RunStatus;
      automation_version_id: string;
    }>();
    if (!existing && writeGuard) return {kind:'not_active',runId:null,status:null,automationVersionId:null};
    if (!existing) throw new Error('automation_run_idempotency_lookup_failed');
    return {
      kind: 'existing',
      runId: existing.id,
      status: existing.status,
      automationVersionId: existing.automation_version_id,
    };
  }

  if (status === 'queued') {
    const run = await getRun(db, runId);
    if (!run) throw new Error('automation_run_insert_failed');
    try {
      if (executionPlan[0]?.type === 'invalid_configuration') {
        const errorCode = String(executionPlan[0].params.errorCode ?? 'invalid_configuration');
        const errorMessage = String(executionPlan[0].params.errorMessage ?? '実行計画を作れませんでした');
        await failConfiguration(db, runId, now, errorCode, errorMessage);
        return { kind: 'created', runId, status: 'failed', automationVersionId: published.version_id };
      }
      await precreateSteps(db, run, executionPlan);
    } catch (error) {
      const failure = normalizeError(error);
      await failConfiguration(db, runId, now, failure.code, failure.message);
      return { kind: 'created', runId, status: 'failed', automationVersionId: published.version_id };
    }
  }

  return { kind: 'created', runId, status, automationVersionId: published.version_id };
}

async function setRunFailed(db: D1Database, runId: string, now: string): Promise<void> {
  await db.prepare(
    `UPDATE automation_runs
        SET status = 'failed', completed_at = ?, resume_at = NULL, lease_expires_at = NULL
      WHERE id = ? AND status NOT IN ('success', 'partial', 'failed', 'cancelled', 'skipped_condition')`,
  ).bind(now, runId).run();
}

async function failConfiguration(
  db: D1Database,
  runId: string,
  now: string,
  code: string,
  message: string,
): Promise<void> {
  await setRunFailed(db, runId, now);
  // 処理定義そのものが読めない場合にも、原因を追える1行を残す。
  const stepId = crypto.randomUUID();
  await db.prepare(
    `INSERT OR IGNORE INTO automation_run_steps
       (id, automation_run_id, step_key, action_type, idempotency_key, status,
        input_json, error_code, error_message, completed_at)
     VALUES (?, ?, '__configuration__', 'invalid_configuration', ?, 'failed', '{}', ?, ?, ?)`,
  ).bind(stepId, runId, stepId, code, message, now).run();
}

async function claimRun(
  db: D1Database,
  runId: string,
  now: string,
  leaseMinutes: number,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE automation_runs
        SET status = 'running', started_at = COALESCE(started_at, ?), resume_at = NULL,
            lease_expires_at = ?
      WHERE id = ? AND (
        status = 'queued'
        OR (status = 'waiting' AND resume_at <= ?)
        OR (status = 'running' AND lease_expires_at <= ?)
      )`,
  ).bind(now, addMinutes(now, leaseMinutes), runId, now, now).run();
  return (result.meta?.changes ?? 0) === 1;
}

async function claimStep(
  db: D1Database,
  step: StepRow,
  now: string,
  leaseMinutes: number,
): Promise<StepRow | null> {
  if (step.status === 'running' && step.attempt_number >= MAX_ATTEMPTS) return null;
  const result = await db.prepare(
    `UPDATE automation_run_steps
        SET status = 'running',
            attempt_number = CASE WHEN status = 'queued' OR error_code = 'webhook_delivery_pending'
              THEN attempt_number ELSE attempt_number + 1 END,
            started_at = COALESCE(started_at, ?), retry_at = NULL, lease_expires_at = ?
      WHERE id = ? AND (
        status = 'queued'
        OR (status = 'waiting' AND retry_at <= ?)
        OR (status = 'running' AND lease_expires_at <= ?)
      )`,
  ).bind(now, addMinutes(now, leaseMinutes), step.id, now, now).run();
  if ((result.meta?.changes ?? 0) !== 1) return null;
  return getStep(db, step.automation_run_id, step.step_key);
}

function normalizeError(error: unknown): AutomationActionError {
  if (error instanceof AutomationActionError) return error;
  if (error instanceof Error) return new AutomationActionError('action_failed', error.message, true);
  return new AutomationActionError('action_failed', '処理に失敗しました', true);
}

async function markStepFailure(
  db: D1Database,
  step: StepRow,
  error: AutomationActionError,
  now: string,
): Promise<'retry' | 'failed'> {
  if (error.retryable && step.attempt_number < MAX_ATTEMPTS) {
    const retryAt = addMinutes(now, RETRY_DELAYS_MINUTES[step.attempt_number - 1]);
    await db.prepare(
      `UPDATE automation_run_steps
          SET status = 'waiting', error_code = ?, error_message = ?, retry_at = ?,
              lease_expires_at = NULL
        WHERE id = ? AND status = 'running'`,
    ).bind(error.code, error.message, retryAt, step.id).run();
    await db.prepare(
      `UPDATE automation_runs
          SET status = 'waiting', resume_at = ?, lease_expires_at = NULL
        WHERE id = ? AND status = 'running'`,
    ).bind(retryAt, step.automation_run_id).run();
    return 'retry';
  }
  await db.prepare(
    `UPDATE automation_run_steps
        SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?,
            retry_at = NULL, lease_expires_at = NULL
      WHERE id = ?`,
  ).bind(error.code, error.message, now, step.id).run();
  return 'failed';
}

async function finishRun(db: D1Database, runId: string, now: string): Promise<RunStatus> {
  const counts = await db.prepare(
    `SELECT
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count
       FROM automation_run_steps
      WHERE automation_run_id = ? AND step_key != '__configuration__'`,
  ).bind(runId).first<{ failed_count: number | null; success_count: number | null }>();
  const failed = Number(counts?.failed_count ?? 0);
  const succeeded = Number(counts?.success_count ?? 0);
  const status: RunStatus = failed === 0 ? 'success' : succeeded > 0 ? 'partial' : 'failed';
  await db.prepare(
    `UPDATE automation_runs
        SET status = ?, completed_at = ?, resume_at = NULL, lease_expires_at = NULL
      WHERE id = ? AND status = 'running'`,
  ).bind(status, now, runId).run();
  return status;
}


export async function processAutomationRun(
  db: D1Database,
  runId: string,
  options: AutomationEngineOptions = {},
): Promise<RunStatus | 'busy' | 'not_found'> {
  const now = nowIso(options.now);
  const leaseMinutes = options.leaseMinutes ?? DEFAULT_LEASE_MINUTES;
  // 機能オフ中はclaimせずqueuedのまま残す。再オンで再開する。
  const ownerRow = await db
    .prepare(`SELECT line_account_id FROM automation_runs WHERE id = ?`)
    .bind(runId)
    .first<{ line_account_id: string | null }>();
  const tenantStatusByAccount = options.tenantStatusByAccount ?? new Map(
    (await listLineAccountsWithTenantStatus(db)).map((account) => [account.id, account.tenant_status]),
  );
  const ownerTenantStatus = ownerRow?.line_account_id
    ? tenantStatusByAccount.get(ownerRow.line_account_id)
    : undefined;
  if (ownerTenantStatus && ownerTenantStatus !== 'active') {
    await db.prepare(
      `UPDATE automation_runs
          SET status = 'cancelled', completed_at = ?, resume_at = NULL, lease_expires_at = NULL
        WHERE id = ? AND status IN ('queued', 'waiting', 'running')`,
    ).bind(now, runId).run();
    return 'cancelled';
  }
  if (ownerRow?.line_account_id && !await featureJobCanRun(db, { accountId: ownerRow.line_account_id, featureId: 'automations', job: 'automation runs' })) {
    return 'busy';
  }
  // 緊急停止 : automation_actions が止まっている統括は claim せず
  // queued のまま残す。停止中の実行は外部へ何も出さない。
  if (await isOperationCapabilityStopped(db, ownerRow?.line_account_id ?? null, 'automation_actions')) {
    return 'busy';
  }
  if (!(await claimRun(db, runId, now, leaseMinutes))) {
    const existing = await getRun(db, runId);
    if (!existing) return 'not_found';
    if (['success', 'partial', 'failed', 'cancelled', 'skipped_condition'].includes(existing.status)) {
      return existing.status;
    }
    return 'busy';
  }

  const run = await getRun(db, runId);
  if (!run) return 'not_found';
  let actions: ActionDefinition[];
  let inputEvent: Record<string, unknown>;
  try {
    actions = parseActions(run.execution_plan_json ?? run.action_config);
    inputEvent = parseObject(run.input_event_json);
  } catch (error) {
    const failure = normalizeError(error);
    await failConfiguration(db, run.id, now, failure.code, failure.message);
    return 'failed';
  }

  const restaurantDeliveryScope:RestaurantAutomationDeliveryScope={approval:new Map(),run:{...run,trigger_type:run.trigger_type??''}};
  const hasNextDayWait = actions.some(action => action.type === 'wait' && action.params.mode === 'next_day');
  for (let index = run.current_step; index < actions.length; index += 1) {
    const action = actions[index];
    /*
     * 取消（cancelAutomationRun）は step と step の境目で効かせる。
     * 走っている途中で取りやめられたら、これ以降の処理へ進まず
     * `cancelled` で返す。走り中の step 自体は取消側で閉じている。
     */
    const latest = await db.prepare(`SELECT status FROM automation_runs WHERE id = ?`)
      .bind(run.id).first<{ status: RunStatus }>();
    if (!latest) return 'not_found';
    if (latest.status === 'cancelled') return 'cancelled';
    const deliveryGate=await readRestaurantAutomationDeliveryGate(db,run.id,now,undefined,restaurantDeliveryScope);
    if(!deliveryGate.allowed){
      await cancelAutomationRun(db,{runId:run.id,allowedAccountIds:[run.line_account_id],now});
      await db.prepare(`UPDATE automation_run_steps SET error_code=?,error_message='予約または承認の内容が変わったため送信しませんでした'
        WHERE automation_run_id=? AND status='cancelled' AND error_code IS NULL`).bind(deliveryGate.reason,run.id).run();
      return 'cancelled';
    }
    if (hasNextDayWait && await expireNextDayWait(db, run.id, now)) return 'cancelled';
    /*
     * 緊急停止  も step の境目で効かせる。claim 後に止まった分は
     * run を queued へ戻し、現在の step から再開できるようにする。
     * 停止を理由に failed / skipped にはしない。
     */
    if (await isOperationCapabilityStopped(db, run.line_account_id, 'automation_actions')) {
      await db.prepare(
        `UPDATE automation_runs
            SET status = 'queued', lease_expires_at = NULL
          WHERE id = ? AND status = 'running'`,
      ).bind(run.id).run();
      return 'busy';
    }
    let step = await getStep(db, run.id, action.id);
    if (!step) {
      await precreateSteps(db, run, [action]);
      step = await getStep(db, run.id, action.id);
    }
    if (!step) {
      await failConfiguration(db, run.id, now, 'step_create_failed', '処理結果の記録を作れませんでした');
      return 'failed';
    }

    if (step.status === 'success' || step.status === 'skipped') {
      await db.prepare(`UPDATE automation_runs SET current_step = ? WHERE id = ?`)
        .bind(index + 1, run.id).run();
      continue;
    }

    if (action.branchConditions?.length) {
      let branchSelected: boolean;
      try {
        branchSelected = await recordedBranchSelected(db, run.id, actions, action);
      } catch (error) {
        const failure = normalizeError(error);
        await failConfiguration(db, run.id, now, failure.code, failure.message);
        return 'failed';
      }
      if (!branchSelected) {
        await db.prepare(
          `UPDATE automation_run_steps
              SET status = 'skipped', output_json = ?, completed_at = ?,
                  retry_at = NULL, lease_expires_at = NULL
            WHERE id = ? AND status NOT IN ('success', 'skipped')`,
        ).bind(JSON.stringify({ reason: 'branch_not_selected' }), now, step.id).run();
        await db.prepare(`UPDATE automation_runs SET current_step = ? WHERE id = ?`)
          .bind(index + 1, run.id).run();
        continue;
      }
    }

    if (action.type === 'wait' && step.status === 'waiting') {
      await db.prepare(
        `UPDATE automation_run_steps
            SET status = 'success', completed_at = ?, lease_expires_at = NULL
          WHERE id = ? AND status = 'waiting'`,
      ).bind(now, step.id).run();
      await db.prepare(`UPDATE automation_runs SET current_step = ? WHERE id = ?`)
        .bind(index + 1, run.id).run();
      continue;
    }

    const claimed = await claimStep(db, step, now, leaseMinutes);
    if (!claimed) {
      if (step.status === 'running' && step.attempt_number >= MAX_ATTEMPTS) {
        const failure = new AutomationActionError(
          'action_lease_expired',
          '処理結果が確定しないまま再試行上限に達しました',
          false,
        );
        await markStepFailure(db, step, failure, now);
        if (action.onFailure === 'stop') {
          await setRunFailed(db, run.id, now);
          return 'failed';
        }
        await db.prepare(`UPDATE automation_runs SET current_step = ? WHERE id = ?`)
          .bind(index + 1, run.id).run();
        continue;
      }
      return 'busy';
    }
    step = claimed;

    try {
      if (action.type === 'wait') {
        await scheduleAutomationWait(db, run, step, action.params, now, inputEvent);
        if (hasNextDayWait && await expireNextDayWait(db, run.id, now)) return 'cancelled';
        return 'waiting';
      }
      if (action.type === 'common_action_marker') {
        await db.prepare(
          `UPDATE automation_run_steps
              SET status = 'success', output_json = ?, completed_at = ?,
                  retry_at = NULL, lease_expires_at = NULL
            WHERE id = ? AND status = 'running'`,
        ).bind(JSON.stringify({ versionId: step.common_action_version_id }), now, step.id).run();
        await db.prepare(`UPDATE automation_runs SET current_step = ? WHERE id = ?`)
          .bind(index + 1, run.id).run();
        continue;
      }
      if (action.type === 'branch_marker') {
        const condition = action.params.condition as SegmentCondition;
        const matched = run.friend_id
          ? await matchesCondition(db, run.friend_id, condition)
          : false;
        await db.prepare(
          `UPDATE automation_run_steps
              SET status = 'success', output_json = ?, completed_at = ?,
                  retry_at = NULL, lease_expires_at = NULL
            WHERE id = ? AND status = 'running'`,
        ).bind(JSON.stringify({ matched }), now, step.id).run();
        await db.prepare(`UPDATE automation_runs SET current_step = ? WHERE id = ?`)
          .bind(index + 1, run.id).run();
        continue;
      }
      if (action.type === 'common_action' && !step.common_action_version_id) {
        throw new AutomationActionError(
          'common_action_version_not_pinned',
          '公開済みの共通アクション版が固定されていません',
          false,
        );
      }
      const executor = options.executors?.[action.type];
      if (!executor) {
        throw new AutomationActionError(
          'unsupported_action_type',
          `処理 ${action.type} は実行エンジンに接続されていません`,
          false,
        );
      }
      const result = await executor({
        db,
        runId: run.id,
        lineAccountId: run.line_account_id,
        automationId: run.automation_id,
        automationVersionId: run.automation_version_id,
        friendId: run.friend_id,
        sourceEventId: run.source_event_id,
        inputEvent,
        action,
        restaurantDeliveryScope,
        stepExecutionId: step.id,
        idempotencyKey: step.id,
        attemptNumber: step.attempt_number,
        commonActionVersionId: step.common_action_version_id,
        isTest: run.is_test === 1,
      });
      await db.prepare(
        `UPDATE automation_run_steps
            SET status = 'success', output_json = ?, error_code = NULL, error_message = NULL,
                completed_at = ?, retry_at = NULL, lease_expires_at = NULL
          WHERE id = ? AND status = 'running'`,
      ).bind(JSON.stringify(result?.output ?? null), now, step.id).run();
      await db.prepare(`UPDATE automation_runs SET current_step = ? WHERE id = ?`)
        .bind(index + 1, run.id).run();
    } catch (error) {
      if (error instanceof AutomationActionDeferred) {
        const retryAt = addMinutes(now, 5);
        await db.batch([
          db.prepare(`UPDATE automation_run_steps SET status = 'waiting',
            error_code = 'webhook_delivery_pending', error_message = NULL, retry_at = ?, lease_expires_at = NULL
            WHERE id = ? AND status = 'running'`).bind(retryAt, step.id),
          db.prepare(`UPDATE automation_runs SET status = 'waiting', resume_at = ?, lease_expires_at = NULL
            WHERE id = ? AND status = 'running'`).bind(retryAt, run.id),
        ]);
        return 'waiting';
      }
      const failure = normalizeError(error);
      const outcome = await markStepFailure(db, step, failure, now);
      if (outcome === 'retry') return 'waiting';
      if (action.onFailure === 'stop') {
        await setRunFailed(db, run.id, now);
        return 'failed';
      }
      await db.prepare(`UPDATE automation_runs SET current_step = ? WHERE id = ?`)
        .bind(index + 1, run.id).run();
    }
  }

  return finishRun(db, run.id, now);
}

/**
 * 失敗した処理だけを同じ実行計画で再開する。
 *
 * 成功・見送り済みの step はそのまま残し、失敗 step だけを waiting に戻す。
 * processAutomationRun は成功済み step を飛ばすため、外部処理を二重に動かさない。
 */
export async function retryAutomationRun(
  db: D1Database,
  input: { runId: string; allowedAccountIds: string[]; now?: string },
): Promise<{ runId: string; retryStepCount: number; status: 'waiting' }> {
  if (input.allowedAccountIds.length === 0) {
    throw new AutomationRunRetryError('not_found', '実行記録が見つかりません');
  }
  const run = await db.prepare(
    `SELECT r.id, r.status, r.current_step, v.action_config, r.execution_plan_json
       FROM automation_runs r
       JOIN automation_versions v
         ON v.id = r.automation_version_id AND v.automation_id = r.automation_id
      WHERE r.id = ? AND r.line_account_id IN (${sqlIdSet(input.allowedAccountIds).sql})`,
  ).bind(input.runId, ...(input.allowedAccountIds.length ? sqlIdSet(input.allowedAccountIds).binds : [])).first<{
    id: string;
    status: RunStatus;
    current_step: number;
    action_config: string;
    execution_plan_json: string | null;
  }>();
  if (!run) throw new AutomationRunRetryError('not_found', '実行記録が見つかりません');
  if (run.status !== 'failed' && run.status !== 'partial') {
    throw new AutomationRunRetryError('not_retryable', '失敗した処理がある実行だけ、もう一度実行できます');
  }

  const failed = await db.prepare(
    `SELECT step_key FROM automation_run_steps
      WHERE automation_run_id = ? AND status = 'failed' AND step_key != '__configuration__'`,
  ).bind(run.id).all<{ step_key: string }>();
  if (failed.results.length === 0) {
    throw new AutomationRunRetryError('not_retryable', '安全に再実行できる失敗処理がありません');
  }
  let actions: ActionDefinition[];
  try {
    actions = parseActions(run.execution_plan_json ?? run.action_config);
  } catch {
    throw new AutomationRunRetryError('not_retryable', '実行時の処理内容を確認できないため、再実行できません');
  }
  const indexes = new Map(actions.map((action, index) => [action.id, index]));
  const retryIndexes = failed.results.map((step) => indexes.get(step.step_key));
  if (retryIndexes.some((index) => index === undefined)) {
    throw new AutomationRunRetryError('not_retryable', '失敗した処理を実行時の内容と照合できません');
  }
  const currentStep = Math.min(...retryIndexes as number[]);
  const now = nowIso(input.now);
  const results = await db.batch([
    db.prepare(
      `UPDATE automation_run_steps
          SET status = 'waiting', retry_at = ?, completed_at = NULL, lease_expires_at = NULL
        WHERE automation_run_id = ? AND status = 'failed' AND step_key != '__configuration__'`,
    ).bind(now, run.id),
    db.prepare(
      `UPDATE automation_runs
          SET status = 'waiting', current_step = ?, resume_at = ?, completed_at = NULL,
              lease_expires_at = NULL
        WHERE id = ? AND status IN ('failed', 'partial')`,
    ).bind(currentStep, now, run.id),
  ]);
  if ((results[0].meta?.changes ?? 0) !== failed.results.length || (results[1].meta?.changes ?? 0) !== 1) {
    throw new AutomationRunRetryError('retry_conflict', '実行記録の状態が変わりました。再読み込みしてください');
  }
  return { runId: run.id, retryStepCount: failed.results.length, status: 'waiting' };
}

/**
 * 実行の取りやめ。
 *
 * **実行記録は消せない**（`trg_automation_runs_no_delete`）。だから取りやめは
 * `cancelled` への状態遷移にする。
 *
 * - `queued` / `running` / `waiting` の実行だけ止められる。
 * - 終わった実行（success / partial / failed / skipped_condition）は
 *   `not_cancellable` で断る。取りやめても結果は変わらない。
 * - すでに `cancelled` なら何もせず成功で返す（**何度押しても同じ結果**）。
 *
 * 走り途中（running）の実行は、`processAutomationRun` が処理と処理の境目で
 * 実行の状態を見直すので、次の処理へ進まずに止まる。進行中だった step も
 * `cancelled` にして「どこまで動いたか」が記録から読める形に残す。
 */
export async function cancelAutomationRun(
  db: D1Database,
  input: { runId: string; allowedAccountIds: string[]; now?: string },
): Promise<{ runId: string; status: 'cancelled'; alreadyCancelled: boolean; cancelledStepCount: number }> {
  if (input.allowedAccountIds.length === 0) {
    throw new AutomationRunCancelError('not_found', '実行記録が見つかりません');
  }
  const run = await db.prepare(
    `SELECT id, status FROM automation_runs
      WHERE id = ? AND line_account_id IN (${sqlIdSet(input.allowedAccountIds).sql})`,
  ).bind(input.runId, ...(input.allowedAccountIds.length ? sqlIdSet(input.allowedAccountIds).binds : [])).first<{ id: string; status: RunStatus }>();
  if (!run) throw new AutomationRunCancelError('not_found', '実行記録が見つかりません');
  if (run.status === 'cancelled') {
    return { runId: run.id, status: 'cancelled', alreadyCancelled: true, cancelledStepCount: 0 };
  }
  if (['success', 'partial', 'failed', 'skipped_condition'].includes(run.status)) {
    throw new AutomationRunCancelError(
      'not_cancellable', 'すでに終わった実行は取りやめられません',
    );
  }
  const now = nowIso(input.now);
  // 状態を見てから閉じるまでに終わってしまう競合は、WHERE で防ぐ。
  // **先に実行そのものを閉じる。** step だけ先に閉じると、直前に失敗で
  // 確定した実行（再実行で残り step を動かせるもの）の queued step まで
  // 潰してしまう。
  const closed = await db.prepare(
    `UPDATE automation_runs
        SET status = 'cancelled', completed_at = ?, resume_at = NULL, lease_expires_at = NULL
      WHERE id = ? AND status IN ('queued', 'running', 'waiting')`,
  ).bind(now, run.id).run();
  if ((closed.meta?.changes ?? 0) !== 1) {
    // 競合で閉じられなかった＝もう終わったか、先に取りやめられた。
    const latest = await db.prepare(`SELECT status FROM automation_runs WHERE id = ?`)
      .bind(run.id).first<{ status: RunStatus }>();
    if (latest?.status === 'cancelled') {
      return { runId: run.id, status: 'cancelled', alreadyCancelled: true, cancelledStepCount: 0 };
    }
    throw new AutomationRunCancelError('not_cancellable', 'すでに終わった実行は取りやめられません');
  }
  // まだ動いていない・待っている・走り途中の step も閉じる。
  // 成功・失敗・見送りで確定した step は結果として残す。
  const steps = await db.prepare(
    `UPDATE automation_run_steps
        SET status = 'cancelled', completed_at = COALESCE(completed_at, ?),
            retry_at = NULL, lease_expires_at = NULL
      WHERE automation_run_id = ? AND status IN ('queued', 'running', 'waiting')`,
  ).bind(now, run.id).run();
  return {
    runId: run.id,
    status: 'cancelled',
    alreadyCancelled: false,
    cancelledStepCount: steps.meta?.changes ?? 0,
  };
}

export async function processDueAutomationRuns(
  db: D1Database,
  options: AutomationEngineOptions & { limit?: number } = {},
): Promise<{ processed: number; results: Array<{ runId: string; status: string }> }> {
  const now = nowIso(options.now);
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const tenantStatusByAccount = new Map(
    (await listLineAccountsWithTenantStatus(db)).map((account) => [account.id, account.tenant_status]),
  );
  const due = await db.prepare(
    `SELECT id FROM automation_runs
      WHERE status = 'queued'
         OR (status = 'waiting' AND resume_at <= ?)
         OR (status = 'running' AND lease_expires_at <= ?)
      ORDER BY created_at ASC
      LIMIT ?`,
  ).bind(now, now, limit).all<{ id: string }>();
  const results: Array<{ runId: string; status: string }> = [];
  for (const row of due.results ?? []) {
    const status = await processAutomationRun(db, row.id, { ...options, now, tenantStatusByAccount });
    results.push({ runId: row.id, status });
  }
  return { processed: results.length, results };
}
