import { type ActionDefinition } from '../features/automations/automation-engine/index.js';

export const SUPPORTED_ACTION_TYPES = new Set([
  'add_tag',
  'remove_tag',
  'set_metadata',
  'set_support_mark',
  'start_scenario',
  'stop_scenario',
  'resume_scenario',
  'send_message',
  'send_webhook',
  'switch_rich_menu',
  'remove_rich_menu',
  'start_reminder',
  'stop_reminder',
  'notify_staff',
  'grant_mileage',
  'wait',
  'common_action',
  'branch',
]);

export class CommonActionValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'CommonActionValidationError';
  }
}

export interface CommonActionSummary {
  folderId: string | null;
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'published' | 'archived';
  draftVersion: number | null;
  publishedVersion: number | null;
  actionCount: number;
  bindingCount: number;
  oldVersionBindingCount: number;
  executionCountThisMonth: number;
  failureCountThisMonth: number;
  lastRunAt: string | null;
  updatedAt: string;
}

export interface CommonActionRow {
  id: string;
  folder_id: string | null;
  line_account_id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'published' | 'archived';
  current_draft_version_id: string | null;
  current_published_version_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  id: string;
  common_action_id: string;
  version_number: number;
  status: 'draft' | 'published';
  action_config: string;
  draft_revision: number;
  created_by: string | null;
  created_at: string;
  published_at: string | null;
}

export interface CommonActionVersion {
  id: string;
  versionNumber: number;
  status: 'draft' | 'published';
  actions: ActionDefinition[];
  /* 監査 ・: 保存ごとに進む改訂番号。古い読み取りからの保存・公開を止める。 */
  draftRevision: number;
  createdBy: string | null;
  createdAt: string;
  publishedAt: string | null;
}

export interface CommonActionBinding {
  id: string;
  confirmationRevision: number;
  consumerType: string;
  consumerId: string;
  consumerPath: string;
  versionId: string;
  versionNumber: number;
  latestVersionNumber: number | null;
  hasNewerVersion: boolean;
  runningCount: number | null;
  waitingCount: number | null;
  /* 監査 : 切替後に旧版のまま進んでいる実行。現在版の件数とは分ける。 */
  olderRunningCount: number | null;
  olderWaitingCount: number | null;
  updatedAt: string;
}

export interface CommonActionResources {
  trigger: 'tag.added' | null;
  actionTypes: Array<{
    id: string;
    label: string;
    actionType: string;
    variant?: string;
    resource?: string;
    state: 'available' | 'unavailable';
    reason: string | null;
    schema: {
      type: 'object';
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
  }>;
  tags: Array<{ id: string; name: string }>;
  scenarios: Array<{ id: string; name: string }>;
  templates: Array<{ id: string; name: string }>;
  friendFields: Array<{ id: string; name: string }>;
  supportMarks: Array<{ id: string; name: string }>;
  reminders: Array<{ id: string; name: string }>;
  notificationRules: Array<{ id: string; name: string }>;
  webhooks: Array<{ id: string; name: string }>;
  richMenus: Array<{ id: string; name: string }>;
  commonActions: Array<{
    id: string;
    name: string;
    version: number;
    currentPublishedVersionId: string;
  }>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requiredString(value: unknown, field: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CommonActionValidationError('required', `${label}を入力してください`, field);
  }
  return value.trim();
}

/*
 * 監査 ・: 読み取り時の改訂番号。保存・公開のたびに照合し、
 * 古い画面からの上書きを止める。利用者に入力させる項目ではない。
 */
export function requiredDraftRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new CommonActionValidationError(
      'required', '編集中の版を確認してください', 'expectedDraftRevision',
    );
  }
  return value;
}

export function validateActionShape(value: unknown, depth = 0): ActionDefinition[] {
  if (depth > 3) {
    throw new CommonActionValidationError('branch_too_deep', '条件分岐の入れ子は3段までです', 'actions');
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new CommonActionValidationError('actions_required', '処理を1つ以上追加してください', 'actions');
  }
  if (value.length > 100) {
    throw new CommonActionValidationError('actions_too_many', '処理は100個までです', 'actions');
  }
  const ids = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new CommonActionValidationError('action_invalid', `${index + 1}番目の処理が正しくありません`, `actions.${index}`);
    }
    const id = requiredString(item.id, `actions.${index}.id`, `${index + 1}番目の処理ID`);
    const type = requiredString(item.type, `actions.${index}.type`, `${index + 1}番目の処理の種類`);
    if (ids.has(id)) {
      throw new CommonActionValidationError('action_id_duplicate', `処理ID「${id}」が重複しています`, `actions.${index}.id`);
    }
    ids.add(id);
    if (!SUPPORTED_ACTION_TYPES.has(type)) {
      throw new CommonActionValidationError('action_type_unsupported', `処理「${type}」はまだ実行できません`, `actions.${index}.type`);
    }
    if (!isRecord(item.params)) {
      throw new CommonActionValidationError('action_params_invalid', `${index + 1}番目の処理設定が正しくありません`, `actions.${index}.params`);
    }
    const onFailure = item.onFailure ?? 'stop';
    if (onFailure !== 'stop' && onFailure !== 'continue') {
      throw new CommonActionValidationError('failure_mode_invalid', '失敗時は「止める」か「次へ進む」を選んでください', `actions.${index}.onFailure`);
    }
    let params = item.params;
    if (type === 'branch') {
      const condition = params.condition;
      if (!isRecord(condition) || !['AND', 'OR'].includes(String(condition.operator))
        || !Array.isArray(condition.rules) || condition.rules.length === 0) {
        throw new CommonActionValidationError(
          'branch_condition_invalid', '条件分岐の条件を1つ以上指定してください', `actions.${index}.params.condition`,
        );
      }
      params = {
        ...params,
        then: validateActionShape(params.then, depth + 1),
        else: validateActionShape(params.else, depth + 1),
      };
    }
    return { id, type, params, onFailure };
  });
}

export function parseStoredActions(raw: string): ActionDefinition[] {
  try {
    return validateActionShape(JSON.parse(raw));
  } catch (error) {
    if (error instanceof CommonActionValidationError) throw error;
    throw new CommonActionValidationError('stored_action_config_invalid', '保存済みの処理定義が壊れています');
  }
}

export async function requireResource(
  db: D1Database,
  input: { table: string; id: unknown; lineAccountId: string; field: string; label: string },
): Promise<string> {
  const id = requiredString(input.id, input.field, input.label);
  // テンプレートは同一アカウントに加え、公開版があること。
  const publishedClause = input.table === 'templates' ? ' AND published_version > 0' : '';
  const row = await db.prepare(
    `SELECT id FROM ${input.table} WHERE id = ? AND line_account_id = ?${publishedClause} LIMIT 1`,
  ).bind(id, input.lineAccountId).first<{ id: string }>();
  if (!row) {
    throw new CommonActionValidationError('resource_not_found', `${input.label}が見つからないか、別のLINE公式アカウントにあります`, input.field);
  }
  return id;
}

/** タグ連動の下書き保存時にも、別アカウントの選択肢を混ぜない。 */
export async function validateTagAddedActionResources(
  db: D1Database,
  lineAccountId: string,
  actions: ActionDefinition[],
): Promise<ActionDefinition[]> {
  for (const [index, action] of actions.entries()) {
    const field = `actions.${index}.params`;
    if (action.type === 'add_tag' || action.type === 'remove_tag') {
      await requireResource(db, {
        table: 'tags', id: action.params.tagId, lineAccountId,
        field: `${field}.tagId`, label: 'タグ',
      });
    } else if (action.type === 'start_scenario'
      || action.type === 'stop_scenario'
      || action.type === 'resume_scenario') {
      await requireResource(db, {
        table: 'scenarios', id: action.params.scenarioId, lineAccountId,
        field: `${field}.scenarioId`, label: 'シナリオ',
      });
    } else if (action.type === 'send_message') {
      if (action.params.templateId !== undefined || action.params.template_id !== undefined) {
        await requireResource(db, {
          table: 'templates', id: action.params.templateId ?? action.params.template_id,
          lineAccountId, field: `${field}.templateId`, label: 'テンプレート',
        });
      } else {
        requiredString(action.params.content, `${field}.content`, '送信内容');
      }
    } else if (action.type === 'set_metadata') {
      if (action.params.fieldId !== undefined) {
        throw new CommonActionValidationError(
          'resource_scope_unavailable',
          '友だち情報欄のアカウント範囲が整うまで、この処理は選べません',
          `${field}.fieldId`,
        );
      }
      const values = action.params.values ?? action.params.data;
      if (!isRecord(values) || Object.keys(values).length === 0) {
        throw new CommonActionValidationError(
          'metadata_values_required', '設定する友だち情報を入力してください', `${field}.values`,
        );
      }
    } else if (action.type === 'set_support_mark') {
      const markId = requiredString(action.params.markId, `${field}.markId`, '対応マーク');
      const mark = await db.prepare(
        `SELECT sm.id
           FROM support_marks sm
           JOIN support_mark_scopes sms ON sms.mark_id = sm.id
           JOIN line_accounts la ON la.id = ? AND la.tenant_id = sms.tenant_id
          WHERE sm.id = ? AND sm.archived_at IS NULL
            AND (sms.line_account_id IS NULL OR sms.line_account_id = ?)
          LIMIT 1`,
      ).bind(lineAccountId, markId, lineAccountId).first<{ id: string }>();
      if (!mark) {
        throw new CommonActionValidationError(
          'resource_not_found', '対応マークが見つからないか、別のLINE公式アカウントにあります',
          `${field}.markId`,
        );
      }
    } else if (action.type === 'start_reminder' || action.type === 'stop_reminder') {
      const reminderId = requiredString(action.params.reminderId, `${field}.reminderId`, 'リマインダ');
      const reminder = await db.prepare(
        `SELECT id FROM reminders
          WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL LIMIT 1`,
      ).bind(reminderId, lineAccountId).first<{ id: string }>();
      if (!reminder) {
        throw new CommonActionValidationError(
          'resource_not_found', 'リマインダが見つからないか、別のLINE公式アカウントにあります',
          `${field}.reminderId`,
        );
      }
    } else if (action.type === 'switch_rich_menu') {
      const pageId = requiredString(
        action.params.richMenuPageId ?? action.params.richMenuId,
        `${field}.richMenuPageId`,
        'リッチメニュー',
      );
      const page = await db.prepare(
        `SELECT p.id FROM rich_menu_pages p
          JOIN rich_menu_groups g ON g.id = p.group_id
         WHERE p.id = ? AND g.account_id = ? AND g.status = 'published' LIMIT 1`,
      ).bind(pageId, lineAccountId).first<{ id: string }>();
      if (!page) {
        throw new CommonActionValidationError(
          'resource_not_found',
          '公開済みのリッチメニューが見つからないか、別のLINE公式アカウントにあります',
          `${field}.richMenuPageId`,
        );
      }
    } else if (action.type === 'notify_staff') {
      const ruleId = requiredString(
        action.params.notificationRuleId,
        `${field}.notificationRuleId`,
        '担当者通知',
      );
      const rule = await db.prepare(
        `SELECT id FROM notification_rules
          WHERE id = ? AND line_account_id = ? AND is_active = 1 LIMIT 1`,
      ).bind(ruleId, lineAccountId).first<{ id: string }>();
      if (!rule) {
        throw new CommonActionValidationError(
          'resource_not_found', '担当者通知が見つからないか、別のLINE公式アカウントにあります',
          `${field}.notificationRuleId`,
        );
      }
      requiredString(action.params.message, `${field}.message`, '通知文');
    } else if (action.type === 'grant_mileage') {
      const amount = Number(action.params.amount);
      if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000) {
        throw new CommonActionValidationError(
          'mileage_amount_invalid', '付けるマイルは1〜1000000の整数で指定してください',
          `${field}.amount`,
        );
      }
    } else if (action.type === 'branch') {
      const condition = action.params.condition as { rules?: Array<{ type?: unknown; value?: unknown }> };
      for (const [ruleIndex, rule] of (condition.rules ?? []).entries()) {
        if (rule.type === 'tag_exists' || rule.type === 'tag_not_exists') {
          await requireResource(db, {
            table: 'tags', id: rule.value, lineAccountId,
            field: `${field}.condition.rules.${ruleIndex}.value`, label: '分岐条件のタグ',
          });
        }
      }
      await validateTagAddedActionResources(
        db,
        lineAccountId,
        action.params.then as ActionDefinition[],
      );
      await validateTagAddedActionResources(
        db,
        lineAccountId,
        action.params.else as ActionDefinition[],
      );
    }
  }
  return actions;
}

export async function resolveLatestPublishedReference(
  db: D1Database,
  lineAccountId: string,
  commonActionId: string,
  field: string,
): Promise<{ id: string; version_id: string }> {
  const referenced = await db.prepare(
    `SELECT ca.id, ca.current_published_version_id AS version_id
       FROM common_actions ca
       JOIN common_action_versions cav
         ON cav.id = ca.current_published_version_id AND cav.common_action_id = ca.id
        AND cav.status = 'published'
      WHERE ca.id = ? AND ca.line_account_id = ? AND ca.status = 'published'`,
  ).bind(commonActionId, lineAccountId).first<{ id: string; version_id: string }>();
  if (!referenced) {
    throw new CommonActionValidationError('common_action_not_published', '呼び出す共通アクションに公開版がありません', `${field}.commonActionId`);
  }
  return referenced;
}

/*
 * 監査 : 確認後に参照先が更新されていたら、別の内容を再確認なしで
 * 公開しない。保存時に固定した版と現在の公開版を突き合わせる。
 */
export async function collectReferenceDrifts(
  db: D1Database,
  lineAccountId: string,
  actions: ActionDefinition[],
): Promise<Array<{ actionId: string; name: string; fromVersion: number; toVersion: number }>> {
  const drifts: Array<{ actionId: string; name: string; fromVersion: number; toVersion: number }> = [];
  const visit = async (steps: ActionDefinition[]): Promise<void> => {
    for (const step of steps) {
      if (step.type === 'branch') {
        const params = step.params as { then?: unknown; else?: unknown };
        if (Array.isArray(params.then)) await visit(params.then as ActionDefinition[]);
        if (Array.isArray(params.else)) await visit(params.else as ActionDefinition[]);
        continue;
      }
      if (step.type !== 'common_action') continue;
      const actionId = step.params.commonActionId;
      const pinnedId = step.params.commonActionVersionId;
      if (typeof actionId !== 'string' || !actionId
        || typeof pinnedId !== 'string' || !pinnedId) continue;
      const row = await db.prepare(
        `SELECT ca.name AS name,
                (SELECT version_number FROM common_action_versions WHERE id = ?) AS pinned_version,
                cav.version_number AS latest_version
           FROM common_actions ca
           JOIN common_action_versions cav ON cav.id = ca.current_published_version_id
          WHERE ca.id = ? AND ca.line_account_id = ?`,
      ).bind(pinnedId, actionId, lineAccountId).first<{
        name: string; pinned_version: number | null; latest_version: number | null;
      }>();
      if (!row || row.pinned_version === null || row.latest_version === null) continue;
      if (row.latest_version > row.pinned_version
        && !drifts.some((drift) => drift.actionId === actionId)) {
        drifts.push({
          actionId, name: row.name, fromVersion: row.pinned_version, toVersion: row.latest_version,
        });
      }
    }
  };
  await visit(actions);
  return drifts;
}

export async function assertNoCycle(
  db: D1Database,
  lineAccountId: string,
  ownerId: string,
  ownerActions: ActionDefinition[],
): Promise<void> {
  const rows = await db.prepare(
    `SELECT ca.id, cav.action_config
       FROM common_actions ca
       JOIN common_action_versions cav
         ON cav.id = ca.current_published_version_id AND cav.common_action_id = ca.id
        AND cav.status = 'published'
      WHERE ca.line_account_id = ? AND ca.status = 'published'`,
  ).bind(lineAccountId).all<{ id: string; action_config: string }>();
  const graph = new Map<string, string[]>();
  for (const row of rows.results ?? []) {
    const calls = parseStoredActions(row.action_config)
      .filter((action) => action.type === 'common_action')
      .map((action) => action.params.commonActionId)
      .filter((id): id is string => typeof id === 'string' && !!id);
    graph.set(row.id, calls);
  }
  graph.set(ownerId, ownerActions
    .filter((action) => action.type === 'common_action')
    .map((action) => action.params.commonActionId)
    .filter((id): id is string => typeof id === 'string' && !!id));

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of graph.get(id) ?? []) {
      if (walk(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (walk(ownerId)) {
    throw new CommonActionValidationError('common_action_cycle', '共通アクションの呼び出しを循環させることはできません', 'actions');
  }
}
