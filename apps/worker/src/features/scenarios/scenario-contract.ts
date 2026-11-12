import { jstCalendar as japanCalendar } from '@line-crm/shared';
import {
  computeNextDeliveryAt,
  DEFAULT_TENANT_ID,
  getFriendById,
  getScenarioPublishedVersion,
  getStepsForDelivery,
  jstNow,
  parseScenarioVersionSteps,
  type DeliveryMode,
  type FriendScenario,
  type PinnedScenarioStep,
} from '@line-crm/db';



import { fetchQuota } from '../broadcasts/broadcast-quota-guard/index.js';
import { buildSegmentWhere, matchesCondition, parseCondition as parseStoredCondition } from '../../services/segment-query.js';
import { type SegmentCondition } from '@line-crm/shared';
import { evaluateCondition, resolveScenarioDeliveryFriend } from '../../services/step-delivery.js';

const ACTION_TYPES = new Set([
  'add_tag',
  'remove_tag',
  'set_metadata',
  'start_scenario',
  'stop_scenario',
  'resume_scenario',
  'send_message',
  'event_booking',
  'send_webhook',
  'switch_rich_menu',
  'remove_rich_menu',
  'set_support_mark',
  'assign_operator',
  'adjust_mileage',
  'notify',
  'wait',
  'branch',
  'common_action',
]);

const ACTION_HOOKS = new Set(['step_sent', 'scenario_completed', 'choice_selected']);

export class ScenarioContractError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 404 | 409 | 422 = 422,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'ScenarioContractError';
  }
}

type ScenarioContractRow = {
  id: string;
  line_account_id: string;
  delivery_mode: 'relative' | 'elapsed' | 'absolute_time';
  audience_condition_json: string | null;
};

type StepRow = {
  id: string;
  step_order: number;
  delay_minutes: number;
  offset_days: number | null;
  offset_minutes: number | null;
  delivery_time: string | null;
  target_condition_json: string | null;
};

export type ScenarioDraftAction = {
  id: string;
  hook: 'step_sent' | 'scenario_completed' | 'choice_selected';
  stepId: string | null;
  choiceKey: string | null;
  type: string;
  params: Record<string, unknown>;
  condition: SegmentCondition | null;
  onFailure: 'stop' | 'continue';
  sortOrder: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ScenarioContractError('required', `${label}を入力してください`, 422, field);
  }
  return value.trim();
}

function parseCondition(value: unknown, field: string): SegmentCondition | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw new ScenarioContractError('condition_invalid', '条件の形が正しくありません', 422, field);
  }
  try {
    buildSegmentWhere(value as unknown as SegmentCondition);
  } catch (error) {
    throw new ScenarioContractError(
      'condition_invalid',
      `条件を読めません: ${error instanceof Error ? error.message : String(error)}`,
      422,
      field,
    );
  }
  return value as unknown as SegmentCondition;
}

function storedCondition(raw: string | null, field: string): SegmentCondition | null {
  if (!raw) return null;
  try {
    return parseCondition(JSON.parse(raw), field);
  } catch (error) {
    if (error instanceof ScenarioContractError) {
      throw new ScenarioContractError(
        'stored_condition_invalid',
        '保存済みの対象条件が壊れています',
        422,
        field,
      );
    }
    throw error;
  }
}

async function requireResource(
  db: D1Database,
  sql: string,
  binds: unknown[],
  field: string,
  label: string,
): Promise<void> {
  const row = await db.prepare(sql).bind(...binds).first<{ id: string }>();
  if (!row) {
    throw new ScenarioContractError(
      'resource_not_found',
      `${label}が見つからないか、別のLINE公式アカウントにあります`,
      422,
      field,
    );
  }
}

async function validateActionResources(
  db: D1Database,
  lineAccountId: string,
  scenarioId: string,
  action: ScenarioDraftAction,
  index: number,
  branchDepth = 0,
): Promise<ScenarioDraftAction> {
  const field = `afterActions.${index}.params`;
  const params = { ...action.params };
  if (action.stepId) {
    await requireResource(
      db,
      `SELECT ss.id FROM scenario_steps ss
        JOIN scenarios s ON s.id = ss.scenario_id
       WHERE ss.id = ? AND s.id = ? AND s.line_account_id = ?`,
      [action.stepId, scenarioId, lineAccountId],
      `afterActions.${index}.stepId`,
      '通',
    );
  }

  if (action.type === 'add_tag' || action.type === 'remove_tag') {
    const tagId = requiredString(params.tagId, `${field}.tagId`, 'タグ');
    await requireResource(db, 'SELECT id FROM tags WHERE id = ? AND line_account_id = ?', [tagId, lineAccountId], `${field}.tagId`, 'タグ');
  } else if (['start_scenario', 'stop_scenario', 'resume_scenario'].includes(action.type)) {
    const scenarioId = requiredString(params.scenarioId, `${field}.scenarioId`, 'シナリオ');
    await requireResource(db, 'SELECT id FROM scenarios WHERE id = ? AND line_account_id = ?', [scenarioId, lineAccountId], `${field}.scenarioId`, 'シナリオ');
  } else if (action.type === 'set_metadata') {
    const values = params.values ?? params.data;
    if (!isRecord(values) || Object.keys(values).length === 0) {
      throw new ScenarioContractError('metadata_values_required', '設定する友だち情報を入力してください', 422, `${field}.values`);
    }
    params.values = values;
    delete params.data;
  } else if (action.type === 'send_message') {
    if (params.templateId !== undefined) {
      const templateId = requiredString(params.templateId, `${field}.templateId`, 'テンプレート');
      await requireResource(db, 'SELECT id FROM templates WHERE id = ? AND line_account_id = ?', [templateId, lineAccountId], `${field}.templateId`, 'テンプレート');
    } else {
      requiredString(params.content, `${field}.content`, '送信内容');
    }
  } else if (action.type === 'event_booking') {
    const eventId = requiredString(params.eventId, `${field}.eventId`, 'イベント');
    await requireResource(db, `SELECT id FROM events WHERE id = ? AND deleted_at IS NULL AND (
      (target_type = 'single' AND line_account_id = ?) OR
      (target_type = 'multi-account-dedup' AND EXISTS (SELECT 1 FROM json_each(account_ids) WHERE value = ?)))`,
      [eventId, lineAccountId, lineAccountId], `${field}.eventId`, 'イベント');
    if (params.slotId != null) {
      const slotId = requiredString(params.slotId, `${field}.slotId`, 'イベントの回');
      await requireResource(db, 'SELECT id FROM event_slots WHERE id = ? AND event_id = ? AND deleted_at IS NULL',
        [slotId, eventId], `${field}.slotId`, 'イベントの回');
    }
    if (params.op != null && !['register', 'book', 'cancel'].includes(String(params.op))) {
      throw new ScenarioContractError('event_operation_invalid', 'イベント予約の操作が不正です', 422, `${field}.op`);
    }
  } else if (action.type === 'send_webhook') {
    const webhookId = requiredString(params.webhookId, `${field}.webhookId`, '送信Webhook');
    await requireResource(db, 'SELECT id FROM outgoing_webhooks WHERE id = ? AND line_account_id = ? AND is_active = 1 AND deleted_at IS NULL', [webhookId, lineAccountId], `${field}.webhookId`, '送信Webhook');
  } else if (action.type === 'switch_rich_menu') {
    const pageId = requiredString(params.richMenuPageId, `${field}.richMenuPageId`, 'リッチメニュー');
    await requireResource(
      db,
      `SELECT p.id FROM rich_menu_pages p
        JOIN rich_menu_groups g ON g.id = p.group_id
       WHERE p.id = ? AND g.account_id = ? AND g.status = 'published'`,
      [pageId, lineAccountId],
      `${field}.richMenuPageId`,
      '公開済みリッチメニュー',
    );
  } else if (action.type === 'set_support_mark') {
    const supportMarkId = requiredString(params.supportMarkId, `${field}.supportMarkId`, '対応マーク');
    await requireResource(
      db,
      `SELECT sm.id FROM support_marks sm
        JOIN support_mark_scopes sms ON sms.mark_id = sm.id
        JOIN line_accounts la ON la.id = ? AND la.tenant_id = sms.tenant_id
       WHERE sm.id = ? AND sm.archived_at IS NULL
         AND (sms.line_account_id IS NULL OR sms.line_account_id = ?)
       LIMIT 1`,
      [lineAccountId, supportMarkId, lineAccountId],
      `${field}.supportMarkId`,
      '対応マーク',
    );
  } else if (action.type === 'assign_operator') {
    if (params.unassign !== true) {
      const operatorId = requiredString(params.operatorId, `${field}.operatorId`, '担当者');
      await requireResource(
        db,
        `SELECT sm.id FROM staff_members sm
          JOIN line_accounts la ON la.id = ?
            AND COALESCE(la.tenant_id, ?) = COALESCE(sm.tenant_id, ?)
         WHERE sm.id = ? AND sm.is_active = 1
           AND (sm.account_scope = 'all' OR EXISTS (
             SELECT 1 FROM staff_account_scopes sas
              WHERE sas.staff_id = sm.id AND sas.line_account_id = ?
           ))`,
        [lineAccountId, DEFAULT_TENANT_ID, DEFAULT_TENANT_ID, operatorId, lineAccountId],
        `${field}.operatorId`,
        '担当者',
      );
    }
  } else if (action.type === 'adjust_mileage') {
    const amount = Number(params.amount);
    if (!Number.isSafeInteger(amount) || amount === 0) {
      throw new ScenarioContractError('mileage_amount_invalid', 'マイル増減は0以外の整数で指定してください', 422, `${field}.amount`);
    }
    requiredString(params.reason, `${field}.reason`, 'マイル増減の理由');
  } else if (action.type === 'notify') {
    const notificationDefinitionId = requiredString(params.notificationDefinitionId, `${field}.notificationDefinitionId`, '通知定義');
    await requireResource(
      db,
      `SELECT id FROM customer_notification_definitions
        WHERE id = ? AND line_account_id = ? AND status = 'published'`,
      [notificationDefinitionId, lineAccountId],
      `${field}.notificationDefinitionId`,
      '公開済み通知定義',
    );
  } else if (action.type === 'wait') {
    const nowMs = Date.now();
    const retentionLimitMs = nowMs + 90 * 24 * 60 * 60 * 1000;
    const duration = Number(params.duration ?? params.durationMinutes);
    const hasDuration = Number.isSafeInteger(duration)
      && duration > 0
      && duration % 5 === 0
      && duration <= 90 * 24 * 60;
    const untilAt = typeof params.until === 'string' ? Date.parse(params.until) : Number.NaN;
    const hasUntil = Number.isFinite(untilAt) && untilAt > nowMs && untilAt <= retentionLimitMs;
    const timeoutAt = typeof params.timeout === 'string' ? Date.parse(params.timeout) : Number.NaN;
    const hasCondition = params.condition !== undefined
      && Number.isFinite(timeoutAt)
      && timeoutAt > nowMs
      && timeoutAt <= retentionLimitMs;
    if (!hasDuration && !hasUntil && !hasCondition) {
      throw new ScenarioContractError('wait_invalid', '待つ時間は5分単位で90日以内、または日時・条件と期限を指定してください', 422, field);
    }
    if (hasDuration) {
      params.durationMinutes = duration;
      delete params.duration;
    }
    if (hasCondition) {
      parseCondition(params.condition, `${field}.condition`);
    }
  } else if (action.type === 'branch') {
    if (branchDepth >= 3) {
      throw new ScenarioContractError('branch_depth_exceeded', '条件分岐は3段までです', 422, field);
    }
    parseCondition(params.condition, `${field}.condition`);
    if (!Array.isArray(params.then) || !Array.isArray(params.else)) {
      throw new ScenarioContractError('branch_invalid', '条件分岐にはthenとelseが必要です', 422, field);
    }
    params.then = await validateNestedActions(
      db, lineAccountId, scenarioId, params.then, `${field}.then`, branchDepth + 1,
    );
    params.else = await validateNestedActions(
      db, lineAccountId, scenarioId, params.else, `${field}.else`, branchDepth + 1,
    );
  } else if (action.type === 'common_action') {
    const commonActionId = requiredString(params.commonActionId, `${field}.commonActionId`, '共通アクション');
    const published = await db.prepare(
      `SELECT ca.id, ca.current_published_version_id AS version_id
         FROM common_actions ca
         JOIN common_action_versions cav
           ON cav.id = ca.current_published_version_id
          AND cav.common_action_id = ca.id AND cav.status = 'published'
        WHERE ca.id = ? AND ca.line_account_id = ? AND ca.status = 'published'`,
    ).bind(commonActionId, lineAccountId).first<{ id: string; version_id: string }>();
    if (!published) {
      throw new ScenarioContractError('resource_not_found', '公開済み共通アクションが見つかりません', 422, `${field}.commonActionId`);
    }
    params.commonActionVersionId = published.version_id;
  }
  return { ...action, params };
}

async function validateNestedActions(
  db: D1Database,
  lineAccountId: string,
  scenarioId: string,
  value: unknown[],
  field: string,
  branchDepth: number,
): Promise<Array<{ id: string; type: string; params: Record<string, unknown>; onFailure: 'stop' | 'continue' }>> {
  if (value.length > 100) {
    throw new ScenarioContractError('actions_too_many', '分岐内のアクションは100件までです', 422, field);
  }
  const ids = new Set<string>();
  const normalized = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) {
      throw new ScenarioContractError('action_invalid', '分岐内のアクションが正しくありません', 422, `${field}.${index}`);
    }
    const id = requiredString(raw.id, `${field}.${index}.id`, 'アクションID');
    if (ids.has(id)) {
      throw new ScenarioContractError('action_id_duplicate', '分岐内のアクションIDが重複しています', 422, `${field}.${index}.id`);
    }
    ids.add(id);
    const type = requiredString(raw.type, `${field}.${index}.type`, 'アクション種別');
    if (!ACTION_TYPES.has(type)) {
      throw new ScenarioContractError('action_type_unsupported', `処理「${type}」はまだ保存できません`, 422, `${field}.${index}.type`);
    }
    if (!isRecord(raw.params)) {
      throw new ScenarioContractError('action_params_invalid', '分岐内のアクション設定が正しくありません', 422, `${field}.${index}.params`);
    }
    const rawOnFailure = raw.onFailure ?? 'stop';
    if (rawOnFailure !== 'stop' && rawOnFailure !== 'continue') {
      throw new ScenarioContractError('failure_mode_invalid', '失敗時はstopかcontinueを指定してください', 422, `${field}.${index}.onFailure`);
    }
    const onFailure: 'stop' | 'continue' = rawOnFailure;
    const checked = await validateActionResources(db, lineAccountId, scenarioId, {
      id,
      hook: 'scenario_completed',
      stepId: null,
      choiceKey: null,
      type,
      params: raw.params,
      condition: null,
      onFailure,
      sortOrder: index,
    }, index, branchDepth);
    normalized.push({ id, type, params: checked.params, onFailure });
  }
  return normalized;
}

function normalizeActions(value: unknown): ScenarioDraftAction[] {
  if (!Array.isArray(value)) {
    throw new ScenarioContractError('actions_invalid', '送信後アクションは配列で指定してください', 422, 'afterActions');
  }
  if (value.length > 100) {
    throw new ScenarioContractError('actions_too_many', '送信後アクションは100件までです', 422, 'afterActions');
  }
  const ids = new Set<string>();
  return value.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new ScenarioContractError('action_invalid', `${index + 1}番目のアクションが正しくありません`, 422, `afterActions.${index}`);
    }
    const id = requiredString(raw.id, `afterActions.${index}.id`, 'アクションID');
    if (ids.has(id)) {
      throw new ScenarioContractError('action_id_duplicate', 'アクションIDが重複しています', 422, `afterActions.${index}.id`);
    }
    ids.add(id);
    const hook = requiredString(raw.hook, `afterActions.${index}.hook`, '発火点');
    if (!ACTION_HOOKS.has(hook)) {
      throw new ScenarioContractError('action_hook_invalid', 'アクションの発火点が正しくありません', 422, `afterActions.${index}.hook`);
    }
    const type = requiredString(raw.type, `afterActions.${index}.type`, 'アクション種別');
    if (!ACTION_TYPES.has(type)) {
      throw new ScenarioContractError('action_type_unsupported', `処理「${type}」はまだ保存できません`, 422, `afterActions.${index}.type`);
    }
    if (!isRecord(raw.params)) {
      throw new ScenarioContractError('action_params_invalid', 'アクション設定が正しくありません', 422, `afterActions.${index}.params`);
    }
    const onFailure = raw.onFailure ?? 'stop';
    if (onFailure !== 'stop' && onFailure !== 'continue') {
      throw new ScenarioContractError('failure_mode_invalid', '失敗時はstopかcontinueを指定してください', 422, `afterActions.${index}.onFailure`);
    }
    const sortOrder = raw.sortOrder === undefined ? index : Number(raw.sortOrder);
    if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) {
      throw new ScenarioContractError('sort_order_invalid', '並び順は0以上の整数で指定してください', 422, `afterActions.${index}.sortOrder`);
    }
    const stepId = raw.stepId == null ? null : requiredString(raw.stepId, `afterActions.${index}.stepId`, '通');
    if (hook !== 'scenario_completed' && !stepId) {
      throw new ScenarioContractError('step_required', 'この発火点には通の指定が必要です', 422, `afterActions.${index}.stepId`);
    }
    const choiceKey = raw.choiceKey == null ? null : requiredString(raw.choiceKey, `afterActions.${index}.choiceKey`, '選択肢');
    if (hook === 'choice_selected' && !choiceKey) {
      throw new ScenarioContractError('choice_required', '選択肢の発火にはchoiceKeyが必要です', 422, `afterActions.${index}.choiceKey`);
    }
    return {
      id,
      hook: hook as ScenarioDraftAction['hook'],
      stepId,
      choiceKey,
      type,
      params: raw.params,
      condition: parseCondition(raw.condition, `afterActions.${index}.condition`),
      onFailure,
      sortOrder,
    };
  });
}

async function scenarioRow(
  db: D1Database,
  scenarioId: string,
  lineAccountId: string,
): Promise<ScenarioContractRow> {
  const row = await db.prepare(
    `SELECT id, line_account_id, delivery_mode, audience_condition_json
       FROM scenarios WHERE id = ? AND line_account_id = ?`,
  ).bind(scenarioId, lineAccountId).first<ScenarioContractRow>();
  if (!row) throw new ScenarioContractError('not_found', 'シナリオが見つかりません', 404);
  return row;
}

async function count(db: D1Database, sql: string, binds: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

export async function simulateScenario(
  db: D1Database,
  input: { scenarioId: string; lineAccountId: string; startAt?: string },
) {
  const scenario = await scenarioRow(db, input.scenarioId, input.lineAccountId);
  const start = input.startAt ? new Date(input.startAt) : new Date();
  if (!Number.isFinite(start.getTime())) {
    throw new ScenarioContractError('start_at_invalid', '開始日時が正しくありません', 400, 'startAt');
  }
  const audience = storedCondition(scenario.audience_condition_json, 'audienceCondition');
  const audienceWhere = audience ? buildSegmentWhere(audience) : { sql: '1=1', bindings: [] as unknown[] };
  const baseBinds = [input.lineAccountId, ...audienceWhere.bindings];
  const accountTotal = await count(db, 'SELECT COUNT(*) AS total FROM friends f WHERE f.line_account_id = ?', [input.lineAccountId]);
  const matched = await count(
    db,
    `SELECT COUNT(*) AS total FROM friends f
      WHERE f.line_account_id = ? AND f.is_following = 1 AND (${audienceWhere.sql})`,
    baseBinds,
  );
  const alreadySubscribed = await count(
    db,
    `SELECT COUNT(DISTINCT f.id) AS total FROM friends f
      WHERE f.line_account_id = ? AND f.is_following = 1 AND (${audienceWhere.sql})
        AND EXISTS (
          SELECT 1 FROM friend_scenarios fs
           WHERE fs.friend_id = f.id AND fs.scenario_id = ?
             AND fs.status IN ('active', 'delivering')
        )`,
    [...baseBinds, input.scenarioId],
  );

  const rows = await db.prepare(
    `SELECT id, step_order, delay_minutes, offset_days, offset_minutes,
            delivery_time, target_condition_json
       FROM scenario_steps WHERE scenario_id = ? AND is_draft = 0
      ORDER BY step_order`,
  ).bind(input.scenarioId).all<StepRow>();
  const steps = [];
  let previousAt = start;
  for (const step of rows.results ?? []) {
    const target = storedCondition(step.target_condition_json, `steps.${step.id}.targetCondition`);
    const targetWhere = target ? buildSegmentWhere(target) : { sql: '1=1', bindings: [] as unknown[] };
    const targetCount = await count(
      db,
      `SELECT COUNT(*) AS total FROM friends f
        WHERE f.line_account_id = ? AND f.is_following = 1
          AND (${audienceWhere.sql}) AND (${targetWhere.sql})`,
      [input.lineAccountId, ...audienceWhere.bindings, ...targetWhere.bindings],
    );
    const scheduled = computeNextDeliveryAt(
      { delivery_mode: scenario.delivery_mode },
      step,
      { enrolledAt: start, previousDeliveredAt: previousAt, now: start },
    );
    previousAt = scheduled;
    steps.push({
      id: step.id,
      stepOrder: step.step_order,
      scheduledAt: scheduled.toISOString(),
      targetCount,
      excludedCount: Math.max(matched - targetCount, 0),
    });
  }

  return {
    scenarioId: input.scenarioId,
    lineAccountId: input.lineAccountId,
    computedAt: new Date().toISOString(),
    sideEffects: false as const,
    audience: {
      accountTotal,
      matched,
      alreadySubscribed,
      newStartPlanned: Math.max(matched - alreadySubscribed, 0),
      excluded: Math.max(accountTotal - matched, 0),
    },
    steps,
  };
}

export async function saveScenarioDraft(
  db: D1Database,
  input: {
    scenarioId: string;
    lineAccountId: string;
    expectedVersion: number;
    afterActions: unknown;
    staffId: string;
  },
) {
  await scenarioRow(db, input.scenarioId, input.lineAccountId);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new ScenarioContractError('expected_version_invalid', 'expectedVersionは0以上の整数で指定してください', 400, 'expectedVersion');
  }
  const normalized = normalizeActions(input.afterActions);
  const actions: ScenarioDraftAction[] = [];
  for (const [index, action] of normalized.entries()) {
    actions.push(await validateActionResources(
      db, input.lineAccountId, input.scenarioId, action, index,
    ));
  }
  const now = jstNow();
  const json = JSON.stringify(actions);
  let statement: D1PreparedStatement;
  if (input.expectedVersion === 0) {
    statement = db.prepare(
      `INSERT OR IGNORE INTO scenario_drafts
         (scenario_id, line_account_id, version, after_actions_json, updated_by, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
    ).bind(input.scenarioId, input.lineAccountId, json, input.staffId, now, now);
  } else {
    statement = db.prepare(
      `UPDATE scenario_drafts
          SET after_actions_json = ?, version = version + 1, updated_by = ?, updated_at = ?
        WHERE scenario_id = ? AND line_account_id = ? AND version = ?`,
    ).bind(json, input.staffId, now, input.scenarioId, input.lineAccountId, input.expectedVersion);
  }
  const [result] = await db.batch([statement, db.prepare('UPDATE scenarios SET content_revision = content_revision + 1 WHERE id = ? AND changes() > 0').bind(input.scenarioId)]);
  if (Number(result.meta.changes ?? 0) === 0) {
    throw new ScenarioContractError(
      'version_conflict',
      'ほかの担当者が先に下書きを変更しました。読み直してください',
      409,
    );
  }
  return {
    scenarioId: input.scenarioId,
    lineAccountId: input.lineAccountId,
    version: input.expectedVersion + 1,
    afterActions: actions,
    updatedBy: input.staffId,
    updatedAt: now,
  };
}

type QuotaFetcher = typeof fetchQuota;

export async function getScenarioRuns(
  db: D1Database,
  input: {
    scenarioId: string;
    lineAccountId: string;
    status?: string;
    cursor?: string;
    limit: number;
    quotaFetcher?: QuotaFetcher;
  },
) {
  await scenarioRow(db, input.scenarioId, input.lineAccountId);
  const allowedStatuses = new Set(['active', 'paused', 'completed', 'delivering']);
  if (input.status && !allowedStatuses.has(input.status)) {
    throw new ScenarioContractError('status_invalid', 'statusが正しくありません', 400, 'status');
  }
  const offset = input.cursor && /^\d+$/.test(input.cursor) ? Number(input.cursor) : 0;
  const limit = Math.max(1, Math.min(100, input.limit));
  const statusSql = input.status ? ' AND fs.status = ?' : '';
  const statusBinds = input.status ? [input.status] : [];
  const summaryRows = await db.prepare(
    `SELECT fs.status, COUNT(*) AS total FROM friend_scenarios fs
      JOIN friends f ON f.id = fs.friend_id AND f.line_account_id = ?
      WHERE fs.scenario_id = ? GROUP BY fs.status`,
  ).bind(input.lineAccountId, input.scenarioId).all<{ status: string; total: number }>();
  const summary = { active: 0, paused: 0, completed: 0, delivering: 0 };
  for (const row of summaryRows.results ?? []) {
    if (row.status in summary) summary[row.status as keyof typeof summary] = Number(row.total ?? 0);
  }
  const total = await count(
    db,
    `SELECT COUNT(*) AS total FROM friend_scenarios fs
      JOIN friends f ON f.id = fs.friend_id AND f.line_account_id = ?
      WHERE fs.scenario_id = ?${statusSql}`,
    [input.lineAccountId, input.scenarioId, ...statusBinds],
  );
  const subscriptions = await db.prepare(
    `SELECT fs.id, fs.friend_id, f.display_name, fs.status, fs.current_step_order,
            fs.started_at, fs.next_delivery_at, fs.updated_at, fs.pause_reason, fs.published_version_id, fs.confirmation_revision
       FROM friend_scenarios fs
       JOIN friends f ON f.id = fs.friend_id AND f.line_account_id = ?
      WHERE fs.scenario_id = ?${statusSql}
      ORDER BY fs.started_at DESC, fs.id DESC LIMIT ? OFFSET ?`,
  ).bind(input.lineAccountId, input.scenarioId, ...statusBinds, limit, offset).all<{
    id: string; friend_id: string; display_name: string; status: string;
    current_step_order: number; started_at: string; next_delivery_at: string | null; updated_at: string;
    pause_reason: string | null; published_version_id: string | null; confirmation_revision: number;
  }>();
  const testSends = await db.prepare(
    `SELECT MIN(ml.id) AS id, ml.friend_id, f.display_name,
            MIN(ml.created_at) AS sent_at, COUNT(*) AS message_count
       FROM messages_log ml
       JOIN scenario_steps ss ON ss.id = ml.scenario_step_id
       JOIN friends f ON f.id = ml.friend_id AND f.line_account_id = ?
      WHERE ss.scenario_id = ? AND ml.source = 'scenario_test'
        AND ml.line_account_id = ?
      GROUP BY ml.friend_id, substr(ml.created_at, 1, 19)
      ORDER BY sent_at DESC LIMIT 20`,
  ).bind(input.lineAccountId, input.scenarioId, input.lineAccountId).all<{
    id: string; friend_id: string; display_name: string; sent_at: string; message_count: number;
  }>();
  const concurrent = await db.prepare(
    `SELECT DISTINCT b.id, b.title, b.status, b.scheduled_at
       FROM broadcasts b
      WHERE b.line_account_id = ? AND b.status IN ('scheduled', 'sending')
        AND b.scheduled_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM friend_scenarios fs
           WHERE fs.scenario_id = ? AND fs.status IN ('active', 'delivering')
             AND fs.next_delivery_at IS NOT NULL
             AND substr(fs.next_delivery_at, 1, 16) = substr(b.scheduled_at, 1, 16)
        )
      ORDER BY b.scheduled_at, b.id LIMIT 20`,
  ).bind(input.lineAccountId, input.scenarioId).all<{
    id: string; title: string; status: string; scheduled_at: string;
  }>();
  const stepRows = await db.prepare(
    `SELECT ss.id, ss.step_order,
            COUNT(DISTINCT CASE
              WHEN ml.direction = 'outgoing' AND ml.source = 'scenario' THEN ml.id END
            ) AS delivered
       FROM scenario_steps ss
       LEFT JOIN messages_log ml ON ml.scenario_step_id = ss.id
      WHERE ss.scenario_id = ?
      GROUP BY ss.id, ss.step_order ORDER BY ss.step_order`,
  ).bind(input.scenarioId).all<{ id: string; step_order: number; delivered: number }>();
  const versionIds = [...new Set((subscriptions.results ?? []).flatMap((row) => row.published_version_id ? [row.published_version_id] : []))];
  const versionOrders = new Map<string, number[]>();
  for (let offset = 0; offset < versionIds.length; offset += 90) {
    const ids = versionIds.slice(offset, offset + 90);
    const versions = await db.prepare(
      `SELECT * FROM scenario_versions WHERE scenario_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    ).bind(input.scenarioId, ...ids).all<Parameters<typeof parseScenarioVersionSteps>[0]>();
    for (const version of versions.results ?? []) {
      versionOrders.set(version.id, parseScenarioVersionSteps(version).map((step) => step.step_order).sort((a, b) => a - b));
    }
  }
  const liveOrders = (stepRows.results ?? []).map((step) => step.step_order);
  const currentDisplayOrder = (versionId: string | null, order: number) => {
    const orders = versionId ? versionOrders.get(versionId) : liveOrders;
    const index = orders?.indexOf(order) ?? -1;
    return index < 0 ? null : index + 1;
  };
  const clickRow = await db.prepare(
    `SELECT COALESCE(SUM(click_count), 0) AS total
       FROM tracked_links WHERE scenario_id = ? AND line_account_id = ?`,
  ).bind(input.scenarioId, input.lineAccountId).first<{ total: number }>();
  const account = await db.prepare(
    'SELECT channel_access_token FROM line_accounts WHERE id = ?',
  ).bind(input.lineAccountId).first<{ channel_access_token: string | null }>();
  const fetched = account?.channel_access_token
    ? await (input.quotaFetcher ?? fetchQuota)(account.channel_access_token)
    : { limit: null, used: null };
  const quota = fetched.used === null
    ? { limit: fetched.limit, used: null, remaining: null, state: 'unavailable' as const, reason: '送信数を取得できませんでした' }
    : fetched.limit === null
      ? { limit: null, used: fetched.used, remaining: null, state: 'unlimited' as const, reason: null }
      : { limit: fetched.limit, used: fetched.used, remaining: Math.max(fetched.limit - fetched.used, 0), state: 'available' as const, reason: null };
  const unavailable = (reason: string) => ({ value: null, state: 'unavailable' as const, reason });

  return {
    summary,
    subscriptions: (subscriptions.results ?? []).map((row) => ({
      id: row.id,
      friendId: row.friend_id,
      confirmationRevision: row.confirmation_revision,
      friendName: row.display_name,
      status: row.status,
      currentStepOrder: row.current_step_order,
      currentDisplayOrder: currentDisplayOrder(row.published_version_id, row.current_step_order),
      startedAt: row.started_at,
      nextDeliveryAt: row.next_delivery_at,
      // なぜ止まっているか（432）。画面はこれで「再開」と「失敗を再送」を
      // 出し分ける。止まっていない行・列より前の行は null。
      pauseReason: row.pause_reason ?? null,
      updatedAt: row.updated_at,
    })),
    pagination: {
      total,
      limit,
      cursor: String(offset),
      nextCursor: offset + limit < total ? String(offset + limit) : null,
    },
    testSends: (testSends.results ?? []).map((row) => ({
      id: row.id,
      friendId: row.friend_id,
      friendName: row.display_name,
      sentAt: row.sent_at,
      messageCount: Number(row.message_count ?? 0),
    })),
    quota: { ...quota, asOf: new Date().toISOString() },
    concurrentBroadcasts: (concurrent.results ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      scheduledAt: row.scheduled_at,
    })),
    scenarioClickTotal: Number(clickRow?.total ?? 0),
    steps: (stepRows.results ?? []).map((row) => ({
      id: row.id,
      stepOrder: row.step_order,
      delivered: Number(row.delivered ?? 0),
      opened: unavailable('LINEはシナリオの通ごとの開封数を提供していません'),
      clicked: unavailable('計測URLを通へ対応付ける識別子がまだありません'),
      failed: unavailable('既存の配信履歴には通ごとの失敗台帳がありません'),
    })),
  };
}

/** 友だち単位の予定は、送信・登録・タグ変更なしで試算する。条件・絞込・時刻は配信と同じ関数を使う。購読中は固定版と購読行の予定、未開始は現在の公開版、どちらもなければ下書きの参考予定を使う。 */

export type ScenarioFriendPlanStep = {
  stepId: string;
  stepOrder: number;
  /** 固定された版の全ての通の中での表示順。保存された順序値とは別。 */
  displayOrder?: number;
  /** 配信予定。未確定のときは null。 */
  scheduledAt: string | null;
  /**
   * deliver …… この通を配信する見通し
   * skip …… 条件を満たさずこの通は送らず次へ進む
   * branch …… 条件不一致で指定の通へ進む
   * pause …… この通を送ったあと一時停止する
   * undetermined …… 動的条件（配信時の状態・回答・再開待ち）で未確定
   */
  outcome: 'deliver' | 'skip' | 'branch' | 'pause' | 'undetermined';
  /** 分岐・除外の理由。読む人向けの文。 */
  reason: string | null;
  /** 配信時点の状態で結果が変わる条件を含むとき true。画面は「未確定」と出す。 */
  dynamic: boolean;
};

export type ScenarioFriendPlan = {
  scenarioId: string;
  lineAccountId: string;
  friendId: string;
  friendName: string | null;
  computedAt: string;
  sideEffects: false;
  /** いまの購読（待機の正体）。無ければ null（まだ開始していない）。 */
  subscription: {
    id: string;
    status: string;
    currentStepOrder: number;
    startedAt: string;
    nextDeliveryAt: string | null;
    pauseReason: string | null;
  } | null;
  /**
   * 予定のもとになった通の定義。
   * pinned …… 購読に固定された公開版（実行ロジックと同じ読み方）
   * published …… これから開始する人へ使われる現在の公開版
   * draft …… 公開版が無いため下書きの参考予定（全て未確定）
   */
  basis: 'pinned' | 'published' | 'draft';
  /** 開始・継続の見通し。blocked のとき steps は立たない。 */
  start: { state: 'ok' | 'blocked'; reasons: string[] };
  steps: ScenarioFriendPlanStep[];
  warnings: string[];
};

/** JST clock-time を載せた Date を、保存形式と同じ "+09:00" 付き ISO へ。 */
function jstClockLabel(date: Date): string {
  return date.toISOString().slice(0, -1) + '+09:00';
}

/** "+09:00" 付き ISO（実 instant）を JST clock-time 表現の Date へ戻す。 */
function toJstClockDate(value: string): Date {
  return japanCalendar(new Date(value));
}

/** 分岐条件を読む人向けの文にする。タグIDは名前へ解決する。 */
async function describeStepCondition(
  db: D1Database,
  step: { condition_type: string | null; condition_value: string | null },
): Promise<string> {
  const type = step.condition_type ?? '';
  if (type === 'tag_exists' || type === 'tag_not_exists') {
    const tag = step.condition_value
      ? await db
          .prepare('SELECT name FROM tags WHERE id = ?')
          .bind(step.condition_value)
          .first<{ name: string }>()
      : null;
    const name = tag?.name ?? step.condition_value ?? '（未設定）';
    return type === 'tag_exists' ? `タグ「${name}」を持つ` : `タグ「${name}」を持たない`;
  }
  if (type === 'metadata_equals' || type === 'metadata_not_equals') {
    try {
      const parsed = JSON.parse(step.condition_value ?? '') as { key?: unknown; value?: unknown };
      const key = typeof parsed?.key === 'string' ? parsed.key : '（未設定）';
      const value = parsed && 'value' in parsed ? JSON.stringify(parsed.value) : '（未設定）';
      return type === 'metadata_equals'
        ? `友だち情報「${key}」が ${value}`
        : `友だち情報「${key}」が ${value} ではない`;
    } catch {
      return `友だち情報の条件（${type}）`;
    }
  }
  return `条件（${type || '未設定'}）`;
}

export async function simulateFriendPlan(
  db: D1Database,
  input: { scenarioId: string; lineAccountId: string; friendId: string; startAt?: string },
): Promise<ScenarioFriendPlan> {
  const scenario = await db
    .prepare(
      `SELECT id, line_account_id, delivery_mode, audience_condition_json,
              is_active, allow_concurrent, current_published_version_id
         FROM scenarios WHERE id = ? AND line_account_id = ?`,
    )
    .bind(input.scenarioId, input.lineAccountId)
    .first<{
      id: string;
      line_account_id: string;
      delivery_mode: DeliveryMode;
      audience_condition_json: string | null;
      is_active: number;
      allow_concurrent: number | null;
      current_published_version_id: string | null;
    }>();
  if (!scenario) throw new ScenarioContractError('not_found', 'シナリオが見つかりません', 404);

  const friend = await getFriendById(db, input.friendId);
  if (!friend) {
    throw new ScenarioContractError('friend_not_found', '友だちが見つかりません', 404, 'friendId');
  }

  const reasons: string[] = [];
  const warnings: string[] = [];
  let blocked = false;

  /*
   * 実際に配信される友だち行を、配信処理と同じ手順で解決する。
   * 別アカウントの友だち・連携先がフォローしていない場合は届かない。
   */
  const deliveryFriend = await resolveScenarioDeliveryFriend(
    db,
    friend,
    scenario.line_account_id ?? null,
  );
  if (!deliveryFriend) {
    blocked = true;
    reasons.push('このLINE公式アカウントではこの友だちへ配信できません');
  } else if (!deliveryFriend.is_following) {
    blocked = true;
    reasons.push('友だちを解除しているため配信されません');
  }

  if (scenario.is_active === 0) {
    blocked = true;
    reasons.push('シナリオは停止中です');
  }

  // 最新の購読1行。待機・一時停止・完了の状態をそのまま画面へ渡す。
  const subscription = await db
    .prepare(
      `SELECT * FROM friend_scenarios
        WHERE friend_id = ? AND scenario_id = ?
        ORDER BY started_at DESC LIMIT 1`,
    )
    .bind(input.friendId, input.scenarioId)
    .first<FriendScenario>();

  /*
   * 読む通の定義。購読中なら固定された公開版（配信処理と同じ）、
   * これから開始するなら現在の公開版、どちらも無ければ下書きを参考にする。
   */
  const inFlight = subscription !== null && subscription.status !== 'completed';
  let basis: ScenarioFriendPlan['basis'];
  let deliveryMode: DeliveryMode;
  let audienceJson: string | null;
  let steps: PinnedScenarioStep[];
  if (inFlight && subscription!.published_version_id) {
    const source = await getStepsForDelivery(
      db,
      input.scenarioId,
      subscription!.published_version_id,
    );
    if (!source) {
      blocked = true;
      reasons.push('購読に固定された公開版が見つかりません（配信は止まります）');
      basis = 'pinned';
      deliveryMode = scenario.delivery_mode ?? 'relative';
      audienceJson = scenario.audience_condition_json;
      steps = [];
    } else {
      basis = 'pinned';
      deliveryMode = source.deliveryMode;
      audienceJson = source.audienceConditionJson;
      steps = source.steps;
    }
  } else {
    const version = await getScenarioPublishedVersion(db, input.scenarioId);
    if (version) {
      basis = 'published';
      deliveryMode = (version.delivery_mode ?? 'relative') as DeliveryMode;
      audienceJson = version.audience_condition_json ?? null;
      steps = parseScenarioVersionSteps(version);
    } else {
      basis = 'draft';
      deliveryMode = scenario.delivery_mode ?? 'relative';
      audienceJson = scenario.audience_condition_json;
      const live = await db
        .prepare(
          `SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order`,
        )
        .bind(input.scenarioId)
        .all<PinnedScenarioStep>();
      steps = (live.results ?? []).map((row) => ({
        ...row,
        live_step_id: row.id,
        template_id_at_send: null,
      }));
      warnings.push('公開版がないため、下書きの内容で組み立てた参考予定です');
    }
  }

  // 実行時と同じく、下書きの通は配信しない。
  const deliverableSteps = steps
    .filter((step) => (step.is_draft ?? 0) === 0)
    .sort((a, b) => a.step_order - b.step_order);
  const displaySteps = [...steps].sort((a, b) => a.step_order - b.step_order);
  const displayOrderFor = (order: number) => displaySteps.findIndex((step) => step.step_order === order) + 1;

  /*
   * 登録の可否。実行側の enrollFriendInScenario と同じ判定：
   * すでに未完了の購読がある人・他シナリオが動いていて並行を許さない場合は
   * 登録されない。
   */
  if (!inFlight) {
    if (subscription) {
      reasons.push('この友だちは以前このシナリオを完了しています。もう一度開始すると1通目から届きます');
    }
    if (scenario.allow_concurrent === 0) {
      const other = await db
        .prepare(
          `SELECT 1 FROM friend_scenarios
            WHERE friend_id = ? AND scenario_id != ? AND status = 'active'
            LIMIT 1`,
        )
        .bind(input.friendId, input.scenarioId)
        .first<{ 1: number }>();
      if (other) {
        blocked = true;
        reasons.push('他のシナリオが動いているため登録されません（このシナリオは同時購読を許可していません）');
      }
    }
    if (!subscription && basis === 'draft') {
      blocked = true;
      reasons.push('公開版がないため、いま開始しても配信されません');
    }
    if (!subscription && deliverableSteps.length === 0 && basis !== 'draft') {
      reasons.push('配信する通がありません');
    }
  }

  /*
   * シナリオ全体の配信対象。配信処理は「満たさない人には送らず止める」ので、
   * いま満たしていなければ予定は立たない（再開されれば動く＝未確定）。
   * 判定対象は実行時と同じく購読行の友だちID。
   */
  let audienceOk = true;
  if (deliverableSteps.length > 0) {
    const audience = parseStoredCondition(audienceJson);
    if (audienceJson && !audience) {
      audienceOk = false;
      reasons.push('配信対象の条件が読み取れません（配信時に一時停止します）');
    } else if (audience) {
      const evalFriendId = inFlight ? subscription!.friend_id : input.friendId;
      audienceOk = await matchesCondition(db, evalFriendId, audience);
      if (!audienceOk) {
        reasons.push('配信対象の条件を現在満たしていません（配信時に再判定し、満たさないままなら一時停止します）');
      }
    }
  }

  const planSteps: ScenarioFriendPlanStep[] = [];
  if (deliverableSteps.length > 0) {
    const nowJst = japanCalendar();
    const startAt = input.startAt ? new Date(input.startAt) : null;
    if (input.startAt && (!startAt || !Number.isFinite(startAt.getTime()))) {
      throw new ScenarioContractError('start_at_invalid', '開始日時が正しくありません', 400, 'startAt');
    }
    // 実行側と同じく、JST clock-time を UTC フィールドに載せた Date で計算する。
    const enrolledAt = inFlight
      ? toJstClockDate(subscription!.started_at)
      : toJstClockDate(startAt ? startAt.toISOString() : new Date().toISOString());
    const position = inFlight ? subscription!.current_step_order : -1;
    const evalFriendId = inFlight ? subscription!.friend_id : input.friendId;
    const nextFor = (step: PinnedScenarioStep, previousDeliveredAt: Date): Date =>
      computeNextDeliveryAt(
        { delivery_mode: deliveryMode },
        step,
        { enrolledAt, previousDeliveredAt, now: nowJst },
      );

    /*
     * 一時停止・送信中の購読では以降の予定は立たない。再開すると現在位置の
     * 続きから動くが、その日時は再開時に決まるため未確定とする。
     */
    let halt: string | null = null;
    if (blocked) {
      // 届かない・止まっていることが分かっているときは、条件評価で
      // 余計な読みをせず、全ての通を未確定で返す（形だけは見える）。
      halt = reasons[0] ?? 'いまは配信できないため、予定は未確定です';
    } else if (inFlight && subscription!.status === 'paused') {
      halt = subscription!.pause_reason === 'delivery_failed'
        ? '配信失敗で止まっています。再開・再送されるまで以降の予定は未確定です'
        : '一時停止中です。再開されるまで以降の予定は未確定です';
    } else if (inFlight && subscription!.status === 'delivering') {
      halt = 'いま配信処理中です。結果が戻るまで以降の予定は未確定です';
    } else if (!audienceOk) {
      halt = '配信対象の条件を現在満たしていないため、配信時に一時停止します';
    }

    // 各通の判定結果を通IDで持ち、最後に通番順で返す。
    const outcomes = new Map<string, ScenarioFriendPlanStep>();
    const pending = deliverableSteps.filter((step) => step.step_order > position);
    const visited = new Set<string>();
    let questionSeen = false;
    // 分岐で前へ戻れる構造なので、無限ループを回数で止める。
    const maxIterations = deliverableSteps.length * 5 + 10;
    let iterations = 0;
    // 相対方式の予定は「1つ前の通の予定時刻」から積む（配信時刻≒予定時刻）。
    let previousDeliveredAt = enrolledAt;
    let index = 0;
    let firstPending = true;

    while (index < pending.length) {
      if (++iterations > maxIterations) {
        warnings.push('条件分岐が循環しているため、以降の予定を確定できません');
        for (const step of pending.slice(index)) {
          if (!outcomes.has(step.id)) {
            outcomes.set(step.id, {
              stepId: step.id,
              stepOrder: step.step_order,
              scheduledAt: null,
              outcome: 'undetermined',
              reason: '条件分岐が循環しているため未確定です',
              dynamic: true,
            });
          }
        }
        break;
      }
      const step = pending[index];
      index += 1;

      if (halt) {
        outcomes.set(step.id, {
          stepId: step.id,
          stepOrder: step.step_order,
          scheduledAt: null,
          outcome: 'undetermined',
          reason: halt,
          dynamic: true,
        });
        continue;
      }
      if (visited.has(step.id)) {
        warnings.push('条件分岐が循環しているため、以降の予定を確定できません');
        outcomes.set(step.id, {
          stepId: step.id,
          stepOrder: step.step_order,
          scheduledAt: null,
          outcome: 'undetermined',
          reason: '条件分岐が循環しているため未確定です',
          dynamic: true,
        });
        halt = '条件分岐が循環しているため以降の予定は未確定です';
        continue;
      }
      visited.add(step.id);

      /*
       * 予定時刻。購読中のいちばん次の通は、実行側が保存した
       * next_delivery_at をそのまま使う（予定の正本は購読行）。
       */
      const storedNext =
        firstPending && inFlight && subscription!.status === 'active'
          ? subscription!.next_delivery_at
          : null;
      const scheduledDate = storedNext
        ? toJstClockDate(storedNext)
        : nextFor(step, previousDeliveredAt);
      const scheduledAt = storedNext ?? jstClockLabel(scheduledDate);
      firstPending = false;
      // 実行側はスキップした通の判定時刻から次を積むので、通過した通の
      // 予定時刻をそのまま次の基点にする。
      previousDeliveredAt = scheduledDate;

      // 条件分岐（実行側と同じ evaluateCondition で判定）
      if (step.condition_type) {
        const met = await evaluateCondition(db, evalFriendId, step);
        if (!met) {
          const label = await describeStepCondition(db, step);
          const jump =
            step.next_step_on_false !== null && step.next_step_on_false !== undefined
              ? pending.find((s) => s.step_order === step.next_step_on_false) ??
                deliverableSteps.find((s) => s.step_order === step.next_step_on_false)
              : undefined;
          if (jump) {
            const jumpIndex = pending.indexOf(jump);
            const forward = jump.step_order > step.step_order;
            outcomes.set(step.id, {
              stepId: step.id,
              stepOrder: step.step_order,
              scheduledAt,
              outcome: 'branch',
              reason: forward
                ? `${label}を現在満たしていないため ${displayOrderFor(jump.step_order)}通目へ進みます（配信時に再判定）`
                : `${label}を現在満たしていないため ${displayOrderFor(jump.step_order)}通目へ戻ります（配信時に再判定）`,
              dynamic: true,
            });
            /*
             * 実行側は current_step_order を分岐先の1つ前へ進めるので、
             * 間の通は送られずに通り過ぎる。戻る分岐では pending の中で
             * その通へ戻り、循環は visited で止める。
             * 分岐先が今回の試算より前（購読開始前に配信済み）の通なら、
             * 実行側はその通へ戻って送り直す——予定としては表せないので
             * 以降を未確定にする。
             */
            if (jumpIndex >= 0) {
              for (const skipped of pending.slice(index, jumpIndex)) {
                if (!outcomes.has(skipped.id)) {
                  outcomes.set(skipped.id, {
                    stepId: skipped.id,
                    stepOrder: skipped.step_order,
                    scheduledAt: null,
                    outcome: 'skip',
                    reason: '条件分岐で通り過ぎます（配信時に再判定）',
                    dynamic: true,
                  });
                }
              }
              index = jumpIndex;
            } else {
              halt = '条件分岐がすでに配信済みの通へ戻るため、以降の予定は未確定です';
            }
            continue;
          }
          outcomes.set(step.id, {
            stepId: step.id,
            stepOrder: step.step_order,
            scheduledAt,
            outcome: 'skip',
            reason: `${label}を現在満たしていないため、この通は送らず次へ進みます（配信時に再判定）`,
            dynamic: true,
          });
          continue;
        }
      }

      // 1通ごとの配信対象（実行側と同じ parseCondition + matchesCondition）
      const rawTarget = step.target_condition_json;
      if (rawTarget) {
        const target = parseStoredCondition(rawTarget);
        const targeted = target ? await matchesCondition(db, evalFriendId, target) : false;
        if (!targeted) {
          outcomes.set(step.id, {
            stepId: step.id,
            stepOrder: step.step_order,
            scheduledAt,
            outcome: 'skip',
            reason: target
              ? 'この通の配信対象を現在満たしていません（配信時に再判定）'
              : 'この通の配信対象の条件を読み取れないためスキップします',
            dynamic: target !== null,
          });
          continue;
        }
      }

      // ここまで来た通は配信される見通し。
      const isQuestion = typeof step.question_json === 'string' && step.question_json.length > 0;
      const pausesAfter = (step.after_send ?? 'continue') === 'pause';
      outcomes.set(step.id, {
        stepId: step.id,
        stepOrder: step.step_order,
        scheduledAt,
        outcome: pausesAfter ? 'pause' : 'deliver',
        reason: [
          questionSeen || isQuestion
            ? '質問への回答次第で以降の動作が変わることがあります'
            : null,
          pausesAfter ? 'この通を送ったあと一時停止します' : null,
        ]
          .filter(Boolean)
          .join('。') || null,
        // 質問以降・条件付きの通は配信時の状態で変わるので未確定扱いにする。
        dynamic: questionSeen || isQuestion || pausesAfter,
      });
      if (isQuestion && !questionSeen) {
        questionSeen = true;
        warnings.push('質問への回答次第で以降の配信が変わることがあります');
      }
      if (pausesAfter) {
        halt = 'この通を送ったあと一時停止します。再開されるまで以降の予定は未確定です';
      }
    }

    for (const step of deliverableSteps) {
      const found = outcomes.get(step.id);
      if (found) {
        planSteps.push(found);
      } else if (step.step_order <= position) {
        // すでに配信済みの通は将来の予定ではないので出さない。
        continue;
      } else {
        planSteps.push({
          stepId: step.id,
          stepOrder: step.step_order,
          scheduledAt: null,
          outcome: 'undetermined',
          reason: '判定できませんでした',
          dynamic: true,
        });
      }
    }
  }

  if (planSteps.some((step) => step.dynamic)) {
    warnings.push('条件は配信時点の情報で再判定されます');
  }
  if (planSteps.some((step) => step.outcome === 'deliver' || step.outcome === 'pause')) {
    warnings.push('実際の配信時刻は数分ずれることがあります');
  }

  return {
    scenarioId: input.scenarioId,
    lineAccountId: input.lineAccountId,
    friendId: input.friendId,
    friendName: deliveryFriend?.display_name ?? friend.display_name ?? null,
    computedAt: new Date().toISOString(),
    sideEffects: false,
    subscription:
      subscription === null
        ? null
        : {
            id: subscription.id,
            status: subscription.status,
            currentStepOrder: subscription.current_step_order,
            startedAt: subscription.started_at,
            nextDeliveryAt: subscription.next_delivery_at ?? null,
            pauseReason: subscription.pause_reason ?? null,
          },
    basis,
    start: { state: blocked ? 'blocked' : 'ok', reasons },
    steps: planSteps.map((step) => ({ ...step, displayOrder: displayOrderFor(step.stepOrder) })),
    warnings,
  };
}
