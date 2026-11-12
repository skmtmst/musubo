import { canAssignChatTo, chatAssigneeId, staffIdFromChatAssignee } from '../../services/chat-assignees.js';
import {accountClause} from './friend-bulk-scope.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import {
  canRecordConversion,
  createChat,
  createFriendBulkRun,
  FriendBulkIdempotencyConflictError,
  getChatByFriendId,
  getFriendBulkRunItemRows,
  getFriendBulkRunRow,
  getSavedSearchById,
  claimFriendBulkRunItem,
  listDueFriendBulkRunIds,
  refreshFriendBulkRunSummary,
  resetFriendBulkRunFailures,
  setFriendFieldValue,
  setFriendSupportMark,
  validateFriendFieldValue,
  updateChat,
  updateFriendBulkRunItem,
  type FriendBulkSnapshotItem,
  activeTenantLineAccountSql,
} from '@line-crm/db';

import {
  DEFAULT_TENANT_ID,
  type FriendBulkOperation,
  type FriendBulkPreview,
  type FriendBulkSelection,
  type SavedSearchConditions,
} from '@line-crm/shared';


import type { AuthenticatedStaff } from '../../middleware/auth/principal/auth.js';
import {
  canAccessAllLineAccounts,
  getVisibleLineAccountScope,
  type VisibleLineAccountScope,
} from '../../services/account-access.js';
import { createAutomationActionExecutors, type AutomationActionExecutorDependencies } from '../automations/automation-action-executors/index.js';
import { AutomationActionError, type ActionDefinition, type AutomationActionExecutor } from '../automations/automation-engine/index.js';
import { compileSavedSearch } from '../../services/saved-search-filter.js';
import { attachTagAndFireSideEffects, detachTagAndFireSideEffects } from './friend-tag-attach.js';

import { bulkMessageThreshold, getBulkMessageApproval } from './bulk-message-approval-state.js';

const MAX_TARGETS = 10_000;
const ITEM_LEASE_MINUTES = 5;
const DEFAULT_PROCESS_LIMIT = 100;

interface SelectedFriend {
  id: string;
  display_name: string | null;
  picture_url: string | null;
  line_account_id: string | null;
  is_following: number;
}

interface PreparedOperation {
  operation: FriendBulkOperation;
  resourceAccountId: string | null | undefined;
  reversible: boolean;
  executionPlan?: ActionDefinition[];
}

interface RunRow {
  id: string;
  tenant_id: string;
  created_by: string;
  selection_json: string;
  operation_json: string;
  execution_plan_json: string | null;
  status: string;
  attempt_count: number;
  scheduled_at: string | null;
  undo_of_run_id: string | null;
}

interface ItemRow {
  id: string;
  run_id: string;
  friend_id: string;
  line_account_id: string | null;
  status: string;
  before_json: string | null;
  after_json: string | null;
}

export class FriendBulkRunError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'FriendBulkRunError';
  }
}

class ItemExecutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ItemExecutionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FriendBulkRunError('invalid_operation', `${label}を選んでください`);
  }
  return value.trim();
}

function parseIso(value: unknown, label: string): string {
  const text = requiredString(value, label);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new FriendBulkRunError('invalid_datetime', `${label}が正しくありません`);
  return date.toISOString();
}

function parseSelection(value: unknown): FriendBulkSelection {
  if (!isRecord(value)) throw new FriendBulkRunError('invalid_selection', '対象の選び方が正しくありません');
  if (value.kind === 'explicit') {
    if (!Array.isArray(value.friendIds) || value.friendIds.some((id) => typeof id !== 'string')) {
      throw new FriendBulkRunError('invalid_selection', '選択した友だちIDが正しくありません');
    }
    const friendIds = [...new Set((value.friendIds as string[]).map((id) => id.trim()).filter(Boolean))];
    if (friendIds.length === 0) throw new FriendBulkRunError('selection_empty', '友だちを1人以上選んでください');
    if (friendIds.length > MAX_TARGETS) throw new FriendBulkRunError('selection_too_large', `一度に実行できるのは${MAX_TARGETS.toLocaleString()}人までです`, 413);
    return { kind: 'explicit', friendIds };
  }
  if (value.kind === 'saved_search') {
    return {
      kind: 'saved_search',
      savedSearchId: requiredString(value.savedSearchId, '保存した検索'),
      lineAccountId: requiredString(value.lineAccountId, 'LINE公式アカウント'),
    };
  }
  if (value.kind === 'conditions' && isRecord(value.conditions)) {
    return { kind: 'conditions', conditions: value.conditions as SavedSearchConditions };
  }
  throw new FriendBulkRunError('invalid_selection', '対象の選び方が正しくありません');
}

function parseOperation(value: unknown): FriendBulkOperation {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new FriendBulkRunError('invalid_operation', '一括操作を選んでください');
  }
  switch (value.kind) {
    case 'add_tag': return { kind: value.kind, tagId: requiredString(value.tagId, 'タグ') };
    case 'remove_tag': return { kind: value.kind, tagId: requiredString(value.tagId, 'タグ') };
    case 'start_scenario': return { kind: value.kind, scenarioId: requiredString(value.scenarioId, 'シナリオ') };
    case 'stop_scenario': return { kind: value.kind, scenarioId: requiredString(value.scenarioId, 'シナリオ') };
    case 'assign_operator':
      return { kind: value.kind, operatorId: value.operatorId == null ? null : requiredString(value.operatorId, '担当者') };
    case 'set_support': {
      const allowed = new Set(['unread', 'in_progress', 'on_hold', 'resolved']);
      const status = value.status === undefined ? undefined : String(value.status);
      if (status !== undefined && !allowed.has(status)) {
        throw new FriendBulkRunError('invalid_operation', '対応状況が正しくありません');
      }
      if (status === undefined && value.markId === undefined) {
        throw new FriendBulkRunError('invalid_operation', '対応状況または対応マークを選んでください');
      }
      return {
        kind: value.kind,
        ...(status ? { status: status as 'unread' | 'in_progress' | 'on_hold' | 'resolved' } : {}),
        ...(value.markId !== undefined ? { markId: value.markId == null ? null : requiredString(value.markId, '対応マーク') } : {}),
      };
    }
    case 'set_reminder':
      return {
        kind: value.kind,
        reminderId: requiredString(value.reminderId, 'リマインダ'),
        targetDate: parseIso(value.targetDate, '予定日時'),
      };
    case 'cancel_reminder': return { kind: value.kind, reminderId: requiredString(value.reminderId, 'リマインダ') };
    case 'send_message': {
      const content = typeof value.content === 'string' && value.content.trim() ? value.content : undefined;
      const templateId = typeof value.templateId === 'string' && value.templateId.trim() ? value.templateId.trim() : undefined;
      if (!content && !templateId) throw new FriendBulkRunError('invalid_operation', '送る内容を入力してください');
      return {
        kind: value.kind,
        ...(content ? { content, messageType: typeof value.messageType === 'string' ? value.messageType : 'text' } : {}),
        ...(templateId ? { templateId } : {}),
      };
    }
    case 'run_common_action':
      return {
        kind: value.kind,
        commonActionId: requiredString(value.commonActionId, '共通アクション'),
        ...(value.commonActionVersionId ? { commonActionVersionId: requiredString(value.commonActionVersionId, '公開版') } : {}),
      };
    case 'set_friend_fields': {
      if (!isRecord(value.values) || Object.keys(value.values).length === 0) {
        throw new FriendBulkRunError('invalid_operation', '変更する友だち情報を入力してください');
      }
      const values: Record<string, string | null> = {};
      for (const [key, item] of Object.entries(value.values)) {
        if (!key.trim() || (item !== null && typeof item !== 'string')) {
          throw new FriendBulkRunError('invalid_operation', '友だち情報の値が正しくありません');
        }
        values[key.trim()] = item as string | null;
      }
      return { kind: value.kind, values };
    }
    case 'set_visibility':
      if (typeof value.hidden !== 'boolean') throw new FriendBulkRunError('invalid_operation', '表示状態が正しくありません');
      return { kind: value.kind, hidden: value.hidden };
    case 'add_conversion':
      return { kind: value.kind, conversionPointId: requiredString(value.conversionPointId, '成果地点') };
    case 'remove_conversion':
      return { kind: value.kind, conversionPointId: requiredString(value.conversionPointId, '成果地点') };
    default:
      throw new FriendBulkRunError('invalid_operation', 'この一括操作にはまだ対応していません');
  }
}


async function querySelected(
  db: D1Database,
  where: string,
  binds: unknown[],
): Promise<SelectedFriend[]> {
  const result = await db.prepare(
    `SELECT f.id, f.display_name, f.picture_url, f.line_account_id, f.is_following
       FROM friends f WHERE ${where}
      ORDER BY f.created_at ASC, f.id ASC LIMIT ?`,
  ).bind(...binds, MAX_TARGETS + 1).all<SelectedFriend>();
  if (result.results.length > MAX_TARGETS) {
    throw new FriendBulkRunError('selection_too_large', `一度に実行できるのは${MAX_TARGETS.toLocaleString()}人までです`, 413);
  }
  return result.results;
}

async function resolveSelection(
  db: D1Database,
  staff: AuthenticatedStaff,
  selection: FriendBulkSelection,
): Promise<SelectedFriend[]> {
  const scope = await getVisibleLineAccountScope(db, staff);
  const account = accountClause(scope);
  if (selection.kind === 'explicit') {
    const rows: SelectedFriend[] = [];
    for (let offset = 0; offset < selection.friendIds.length; offset += 90) {
      const chunk = selection.friendIds.slice(offset, offset + 90);
      rows.push(...await querySelected(
        db,
        `${account.sql} AND f.id IN (${chunk.map(() => '?').join(',')})`,
        [...account.binds, ...chunk],
      ));
    }
    const order = new Map(selection.friendIds.map((id, index) => [id, index]));
    return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  if (selection.kind === 'saved_search') {
    if (!scope.allowedAccountIds.includes(selection.lineAccountId)) {
      throw new FriendBulkRunError('saved_search_not_found', '保存した検索が見つかりません', 404);
    }
    const saved = await getSavedSearchById(db, selection.savedSearchId, selection.lineAccountId);
    if (!saved || saved.scope !== 'friends'
      || (staff.role === 'staff' && saved.is_shared !== 1 && saved.created_by !== staff.id)) {
      throw new FriendBulkRunError('saved_search_not_found', '保存した検索が見つかりません', 404);
    }
    let conditions: unknown;
    try { conditions = JSON.parse(saved.conditions_json); } catch { conditions = null; }
    if (!isRecord(conditions)) throw new FriendBulkRunError('saved_search_invalid', '保存した検索の条件が壊れています', 422);
    const compiled = compileSavedSearch(conditions as never);
    if (!compiled.ok) throw new FriendBulkRunError('saved_search_invalid', compiled.error, 422);
    return querySelected(
      db,
      `f.line_account_id = ? AND ${compiled.value.sql}`,
      [selection.lineAccountId, ...compiled.value.binds],
    );
  }

  const compiled = compileSavedSearch(selection.conditions);
  if (!compiled.ok) throw new FriendBulkRunError('conditions_invalid', compiled.error, 422);
  return querySelected(db, `${account.sql} AND ${compiled.value.sql}`, [...account.binds, ...compiled.value.binds]);
}

async function requireAccountResource(
  db: D1Database,
  table: 'tags' | 'scenarios' | 'reminders' | 'templates' | 'conversion_points',
  id: string,
  label: string,
): Promise<string | null> {
  const row = await db.prepare(`SELECT line_account_id FROM ${table} WHERE id = ?`)
    .bind(id).first<{ line_account_id: string | null }>();
  if (!row) throw new FriendBulkRunError('resource_not_found', `${label}が見つかりません`, 404);
  return row.line_account_id;
}

async function requirePublishedTemplateAccount(
  db: D1Database,
  id: string,
): Promise<string | null> {
  const row = await db.prepare(
    `SELECT line_account_id
       FROM templates
      WHERE id = ? AND published_version > 0`,
  ).bind(id).first<{ line_account_id: string | null }>();
  if (!row) {
    throw new FriendBulkRunError(
      'template_not_published',
      '公開済みのテンプレートが見つかりません',
      409,
    );
  }
  return row.line_account_id;
}

async function flattenCommonAction(
  db: D1Database,
  input: { commonActionId: string; versionId?: string; depth?: number; seen?: Set<string> },
): Promise<{ accountId: string; versionId: string; plan: ActionDefinition[] }> {
  const depth = input.depth ?? 0;
  const seen = input.seen ?? new Set<string>();
  if (depth > 20 || seen.has(input.commonActionId)) {
    throw new FriendBulkRunError('common_action_cycle', '共通アクションの呼び出しが循環しています', 422);
  }
  seen.add(input.commonActionId);
  const row = await db.prepare(
    `SELECT ca.line_account_id, cav.id AS version_id, cav.action_config
       FROM common_actions ca
       JOIN common_action_versions cav
         ON cav.id = COALESCE(?, ca.current_published_version_id)
        AND cav.common_action_id = ca.id AND cav.status = 'published'
      WHERE ca.id = ? AND ca.status = 'published'`,
  ).bind(input.versionId ?? null, input.commonActionId).first<{
    line_account_id: string; version_id: string; action_config: string;
  }>();
  if (!row) throw new FriendBulkRunError('common_action_not_published', '公開済みの共通アクションが見つかりません', 404);
  let actions: ActionDefinition[];
  try { actions = JSON.parse(row.action_config) as ActionDefinition[]; } catch {
    throw new FriendBulkRunError('common_action_invalid', '共通アクションの内容が壊れています', 422);
  }
  if (!Array.isArray(actions)) throw new FriendBulkRunError('common_action_invalid', '共通アクションの内容が壊れています', 422);
  const plan: ActionDefinition[] = [];
  for (const action of actions) {
    if (!isRecord(action) || typeof action.id !== 'string' || typeof action.type !== 'string' || !isRecord(action.params)) {
      throw new FriendBulkRunError('common_action_invalid', '共通アクションの処理が壊れています', 422);
    }
    if (action.type !== 'common_action') {
      plan.push({ ...action, id: `${input.commonActionId}/${action.id}` });
      continue;
    }
    const nestedId = requiredString(action.params.commonActionId, '呼び出す共通アクション');
    const nested = await flattenCommonAction(db, {
      commonActionId: nestedId,
      versionId: typeof action.params.commonActionVersionId === 'string' ? action.params.commonActionVersionId : undefined,
      depth: depth + 1,
      seen: new Set(seen),
    });
    if (nested.accountId !== row.line_account_id) {
      throw new FriendBulkRunError('common_action_account_mismatch', '別のLINE公式アカウントの共通アクションは呼び出せません', 422);
    }
    plan.push(...nested.plan);
  }
  if (plan.length > 1_000) throw new FriendBulkRunError('common_action_too_large', '共通アクションの処理が多すぎます', 422);
  return { accountId: row.line_account_id, versionId: row.version_id, plan };
}

async function prepareOperation(db: D1Database, operation: FriendBulkOperation): Promise<PreparedOperation> {
  switch (operation.kind) {
    case 'add_tag':
    case 'remove_tag':
      if(await db.prepare('SELECT id FROM member_rank_tiers WHERE tag_id=?').bind(operation.tagId).first())throw new FriendBulkRunError('rank_tag_managed','会員ランクのタグは自動で管理します',403);
      return { operation, resourceAccountId: await requireAccountResource(db, 'tags', operation.tagId, 'タグ'), reversible: true };
    case 'start_scenario':
    case 'stop_scenario':
      return { operation, resourceAccountId: await requireAccountResource(db, 'scenarios', operation.scenarioId, 'シナリオ'), reversible: true };
    case 'assign_operator':
      return { operation, resourceAccountId: undefined, reversible: true };
    case 'set_support': {
      let accountId: string | undefined;
      if (operation.markId) {
        const mark = await db.prepare(
          `SELECT sms.line_account_id
             FROM support_mark_scopes sms WHERE sms.mark_id = ? LIMIT 1`,
        ).bind(operation.markId).first<{ line_account_id: string }>();
        if (!mark) throw new FriendBulkRunError('support_mark_not_found', '対応マークが見つかりません', 404);
        accountId = mark.line_account_id;
      }
      return { operation, resourceAccountId: accountId, reversible: true };
    }
    case 'set_reminder':
    case 'cancel_reminder':
      return { operation, resourceAccountId: await requireAccountResource(db, 'reminders', operation.reminderId, 'リマインダ'), reversible: true };
    case 'send_message': {
      const accountId = operation.templateId
        ? await requirePublishedTemplateAccount(db, operation.templateId)
        : undefined;
      return { operation, resourceAccountId: accountId, reversible: false };
    }
    case 'run_common_action': {
      const flattened = await flattenCommonAction(db, {
        commonActionId: operation.commonActionId,
        versionId: operation.commonActionVersionId,
      });
      return {
        operation: { ...operation, commonActionVersionId: flattened.versionId },
        resourceAccountId: flattened.accountId,
        reversible: false,
        executionPlan: flattened.plan,
      };
    }
    case 'set_friend_fields': {
      const ids = Object.keys(operation.values);
      const rows = await db.prepare(
        `SELECT id, ec_is_master, type, COALESCE(type_v8, type_v6, type) AS resolved_type, options_json, name
           FROM friend_fields WHERE id IN (${sqlIdSet(ids).sql})`,
      ).bind(...(ids.length ? sqlIdSet(ids).binds : [])).all<{ id: string; ec_is_master: number; resolved_type: string; options_json: string | null; name: string }>();
      if (rows.results.length !== ids.length) throw new FriendBulkRunError('friend_field_not_found', '友だち情報の項目が見つかりません', 404);
      if (rows.results.some((row) => row.ec_is_master === 1)) {
        throw new FriendBulkRunError(
          'friend_field_ec_master',
          'EC側を正としている友だち情報は管理画面から変更できません',
          409,
        );
      }
      // 実行（一括操作の行を作る副作用）の前に全値を検証する。
      // 通らない値が1つでもあれば422で止め、正規化した値を操作へ載せる。
      const byId = new Map(rows.results.map((row) => [row.id, row]));
      const normalized: Record<string, string | null> = {};
      for (const [fieldId, raw] of Object.entries(operation.values)) {
        const def = byId.get(fieldId);
        if (!def) throw new FriendBulkRunError('friend_field_not_found', '友だち情報の項目が見つかりません', 404);
        const checked = validateFriendFieldValue(
          { type: def.resolved_type, options_json: def.options_json },
          raw,
        );
        if (!checked.ok) {
          throw new FriendBulkRunError(
            'friend_field_value_invalid',
            `「${def.name}」の値を確認してください（${checked.error}）`,
            422,
          );
        }
        normalized[fieldId] = checked.value;
      }
      return {
        operation: { kind: operation.kind, values: normalized },
        resourceAccountId: undefined,
        reversible: true,
      };
    }
    case 'set_visibility':
      return { operation, resourceAccountId: undefined, reversible: true };
    case 'add_conversion':
      return { operation, resourceAccountId: await requireAccountResource(db, 'conversion_points', operation.conversionPointId, '成果地点'), reversible: true };
    case 'remove_conversion':
      return { operation, resourceAccountId: await requireAccountResource(db, 'conversion_points', operation.conversionPointId, '成果地点'), reversible: false };
  }
}

function exclusionReason(friend: SelectedFriend, prepared: PreparedOperation): string | null {
  if (prepared.resourceAccountId !== undefined && friend.line_account_id !== prepared.resourceAccountId) {
    return '選んだ操作とLINE公式アカウントが異なります';
  }
  if ((prepared.operation.kind === 'send_message' || prepared.operation.kind === 'run_common_action')
    && !friend.line_account_id) return 'LINE公式アカウントが未設定です';
  if (prepared.operation.kind === 'send_message' && friend.is_following !== 1) {
    return '現在はLINEで送信できません';
  }
  return null;
}

export async function previewFriendBulkRun(
  db: D1Database,
  staff: AuthenticatedStaff,
  rawSelection: unknown,
  rawOperation: unknown,
): Promise<{ selection: FriendBulkSelection; prepared: PreparedOperation; preview: FriendBulkPreview; targets: FriendBulkSnapshotItem[] }> {
  const selection = parseSelection(rawSelection);
  const operation = parseOperation(rawOperation);
  const [selected, prepared] = await Promise.all([
    resolveSelection(db, staff, selection),
    prepareOperation(db, operation),
  ]);
  const exclusions = new Map<string, number>();
  const targets: FriendBulkSnapshotItem[] = [];
  const targetRows: SelectedFriend[] = [];
  for (const friend of selected) {
    const reason = exclusionReason(friend, prepared);
    if (reason) {
      exclusions.set(reason, (exclusions.get(reason) ?? 0) + 1);
      continue;
    }
    targets.push({ friendId: friend.id, lineAccountId: friend.line_account_id });
    targetRows.push(friend);
  }
  const accounts = new Map<string | null, number>();
  targetRows.forEach((friend) => accounts.set(friend.line_account_id, (accounts.get(friend.line_account_id) ?? 0) + 1));
  return {
    selection,
    prepared,
    targets,
    preview: {
      selectedCount: selected.length,
      targetCount: targets.length,
      excludedCount: selected.length - targets.length,
      accountBreakdown: [...accounts].map(([lineAccountId, count]) => ({ lineAccountId, count })),
      exclusions: [...exclusions].map(([reason, count]) => ({ reason, count })),
      sample: targetRows.slice(0, 10).map((friend) => ({
        friendId: friend.id,
        displayName: friend.display_name,
        pictureUrl: friend.picture_url,
        lineAccountId: friend.line_account_id,
      })),
      reversible: prepared.reversible,
    },
  };
}

export async function startFriendBulkRun(
  db: D1Database,
  staff: AuthenticatedStaff,
  input: {
    selection: unknown;
    operation: unknown;
    idempotencyKey: string;
    scheduledAt?: unknown;
    confirmIrreversible?: boolean;
    now?: string;
  },
) {
  const result = await previewFriendBulkRun(db, staff, input.selection, input.operation);
  if (result.targets.length === 0) throw new FriendBulkRunError('no_targets', '実行できる友だちがいません', 422);
  if (!result.prepared.reversible && input.confirmIrreversible !== true) {
    throw new FriendBulkRunError(
      'confirmation_required',
      'この操作は取り消せません。対象と内容を確認してから実行してください。',
      428,
    );
  }
  const threshold = result.prepared.operation.kind === 'send_message'
    ? await bulkMessageThreshold(db, [...new Set(result.targets.map((item) => item.lineAccountId).filter((id): id is string => !!id))])
    : undefined;
  const now = input.now ?? new Date().toISOString();
  const scheduledAt = input.scheduledAt == null ? null : parseIso(input.scheduledAt, '実行予定日時');
  try {
    return await createFriendBulkRun(db, {
      tenantId: staff.tenantId ?? DEFAULT_TENANT_ID,
      createdBy: staff.id,
      selection: result.selection,
      operation: result.prepared.operation,
      executionPlan: result.prepared.executionPlan,
      targets: result.targets,
      excludedCount: result.preview.excludedCount,
      reversible: result.prepared.reversible,
      idempotencyKey: input.idempotencyKey,
      scheduledAt,
      messageApprovalThreshold: threshold !== undefined && result.targets.length >= threshold ? threshold : undefined,
      now,
    });
  } catch (error) {
    if (error instanceof FriendBulkIdempotencyConflictError) {
      throw new FriendBulkRunError('idempotency_conflict', error.message, 409);
    }
    throw error;
  }
}

function addMinutes(value: string, minutes: number): string {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() + minutes);
  return date.toISOString();
}

async function requireFriend(db: D1Database, item: ItemRow) {
  const row = await db.prepare(
    `SELECT id, line_user_id, line_account_id, is_following, metadata, is_hidden, support_mark_id
       FROM friends WHERE id = ? AND line_account_id IS ?`,
  ).bind(item.friend_id, item.line_account_id).first<{
    id: string; line_user_id: string; line_account_id: string | null; is_following: number;
    metadata: string; is_hidden: number; support_mark_id: string | null;
  }>();
  if (!row) throw new ItemExecutionError('friend_not_found', '対象の友だちを確認できません', false);
  return row;
}

async function runExecutor(
  db: D1Database,
  executor: AutomationActionExecutor | undefined,
  run: RunRow,
  item: ItemRow,
  action: ActionDefinition,
  attemptNumber: number,
): Promise<void> {
  if (!executor) throw new ItemExecutionError('action_not_supported', 'この処理は一括操作で実行できません', false);
  if (!item.line_account_id) throw new ItemExecutionError('line_account_missing', 'LINE公式アカウントが未設定です', false);
  try {
    await executor({
      db,
      runId: run.id,
      lineAccountId: item.line_account_id,
      automationId: `friend-bulk:${run.id}`,
      automationVersionId: `friend-bulk:${run.id}`,
      friendId: item.friend_id,
      sourceEventId: item.id,
      inputEvent: { type: 'friend_bulk_run', source: 'friend_bulk_run' },
      action,
      stepExecutionId: `${item.id}:${action.id}`,
      idempotencyKey: `${item.id}:${action.id}`,
      attemptNumber,
      commonActionVersionId: action.commonActionVersionId ?? null,
      isTest: false,
    });
  } catch (error) {
    if (error instanceof AutomationActionError) {
      throw new ItemExecutionError(error.code, error.message, error.retryable);
    }
    throw new ItemExecutionError('action_failed', '処理を実行できませんでした', true);
  }
}

async function executeOperation(
  db: D1Database,
  run: RunRow,
  item: ItemRow,
  operation: FriendBulkOperation,
  executionPlan: ActionDefinition[] | null,
  executors: Record<string, AutomationActionExecutor>,
  now: string,
): Promise<{ status: 'success' | 'skipped' | 'waiting'; before?: unknown; after?: unknown; retryAt?: string }> {
  const friend = await requireFriend(db, item);
  const attempt = Number((item as unknown as { attempt_count?: number }).attempt_count ?? 1);
  switch (operation.kind) {
    case 'add_tag':
    case 'remove_tag': {
      if(await db.prepare('SELECT id FROM member_rank_tiers WHERE tag_id=?').bind(operation.tagId).first())throw new FriendBulkRunError('rank_tag_managed','会員ランクのタグは自動で管理します',403);
      const exists = Boolean(await db.prepare(`SELECT 1 AS ok FROM friend_tags WHERE friend_id = ? AND tag_id = ?`)
        .bind(friend.id, operation.tagId).first<{ ok: number }>());
      const add = operation.kind === 'add_tag';
      if (exists === add) return { status: 'skipped', before: { assigned: exists }, after: { assigned: exists } };
      if (add) await attachTagAndFireSideEffects(db, friend.id, operation.tagId);
      else await detachTagAndFireSideEffects(db, friend.id, operation.tagId);
      return { status: 'success', before: { assigned: exists }, after: { assigned: add } };
    }
    case 'start_scenario':
    case 'stop_scenario': {
      const previous = await db.prepare(
        `SELECT id, status FROM friend_scenarios
          WHERE friend_id = ? AND scenario_id = ? AND status != 'completed' LIMIT 1`,
      ).bind(friend.id, operation.scenarioId).first<{ id: string; status: string }>();
      const already = operation.kind === 'start_scenario'
        ? previous && ['active', 'delivering'].includes(previous.status)
        : !previous || previous.status === 'paused';
      if (already) return { status: 'skipped', before: previous, after: previous };
      const type = operation.kind;
      await runExecutor(db, executors[type], run, { ...item, line_account_id: friend.line_account_id }, {
        id: type, type, params: { scenarioId: operation.scenarioId }, onFailure: 'stop',
      }, attempt);
      const after = await db.prepare(
        `SELECT id, status FROM friend_scenarios
          WHERE friend_id = ? AND scenario_id = ? AND status != 'completed' LIMIT 1`,
      ).bind(friend.id, operation.scenarioId).first<{ id: string; status: string }>();
      return { status: 'success', before: previous, after };
    }
    case 'assign_operator': {
      const existing = await getChatByFriendId(db, friend.id);
      const before = { chatId: existing?.id ?? null, operatorId: existing ? chatAssigneeId(existing) : null };
      if (operation.operatorId && !await canAssignChatTo(db, staffIdFromChatAssignee(operation.operatorId) ?? '', friend.line_account_id)) throw new ItemExecutionError('operator_not_found', '担当者が見つかりません', false);
      if (before.operatorId === operation.operatorId) return { status: 'skipped', before, after: before };
      const chat = existing ?? await createChat(db, { friendId: friend.id });
      if (friend.line_account_id) {
        await db.prepare(`UPDATE chats SET line_account_id = ? WHERE id = ?`).bind(friend.line_account_id, chat.id).run();
      }
      await updateChat(db, chat.id, { assigneeStaffId: operation.operatorId ? staffIdFromChatAssignee(operation.operatorId) : null, ...(operation.operatorId === null ? { operatorId: null } : {}) });
      return { status: 'success', before, after: { chatId: chat.id, operatorId: operation.operatorId } };
    }
    case 'set_support': {
      const chat = await getChatByFriendId(db, friend.id);
      const before = { chatId: chat?.id ?? null, status: chat?.status ?? null, markId: friend.support_mark_id };
      const targetStatus = operation.status ?? before.status;
      const targetMark = operation.markId === undefined ? before.markId : operation.markId;
      if (targetStatus === before.status && targetMark === before.markId) return { status: 'skipped', before, after: before };
      if (operation.status !== undefined) {
        const current = chat ?? await createChat(db, { friendId: friend.id });
        await updateChat(db, current.id, { status: operation.status });
      }
      if (operation.markId !== undefined) {
        if (!friend.line_account_id || !await setFriendSupportMark(
          db,
          friend.id,
          operation.markId,
          { tenantId: run.tenant_id, lineAccountId: friend.line_account_id },
          run.created_by,
        )) {
          throw new ItemExecutionError('support_mark_unavailable', '対応マークを変更できませんでした', false);
        }
      }
      return { status: 'success', before, after: { status: targetStatus, markId: targetMark } };
    }
    case 'set_reminder': {
      const existing = await db.prepare(
        `SELECT id, status, target_date FROM friend_reminders
          WHERE friend_id = ? AND reminder_id = ? AND status = 'active' AND target_date = ? LIMIT 1`,
      ).bind(friend.id, operation.reminderId, operation.targetDate).first<{ id: string; status: string; target_date: string }>();
      if (existing) return { status: 'skipped', before: null, after: existing };
      const id = crypto.randomUUID();
      await db.prepare(
        `INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(id, friend.id, operation.reminderId, operation.targetDate, now, now).run();
      return { status: 'success', before: null, after: { ids: [id], status: 'active' } };
    }
    case 'cancel_reminder': {
      const rows = await db.prepare(
        `SELECT id, status FROM friend_reminders
          WHERE friend_id = ? AND reminder_id = ? AND status = 'active'`,
      ).bind(friend.id, operation.reminderId).all<{ id: string; status: string }>();
      if (rows.results.length === 0) return { status: 'skipped', before: [], after: [] };
      await db.prepare(
        `UPDATE friend_reminders SET status = 'cancelled', updated_at = ?
          WHERE friend_id = ? AND reminder_id = ? AND status = 'active'`,
      ).bind(now, friend.id, operation.reminderId).run();
      return { status: 'success', before: rows.results, after: rows.results.map((row) => ({ ...row, status: 'cancelled' })) };
    }
    case 'send_message': {
      await runExecutor(db, executors.send_message, run, { ...item, line_account_id: friend.line_account_id }, {
        id: 'send_message', type: 'send_message', params: operation, onFailure: 'stop',
      }, attempt);
      return { status: 'success', after: { sent: true } };
    }
    case 'run_common_action': {
      const plan = executionPlan ?? [];
      const state = item.after_json ? JSON.parse(item.after_json) as { cursor?: number } : {};
      let cursor = Number(state.cursor ?? 0);
      for (; cursor < plan.length; cursor += 1) {
        const action = plan[cursor];
        if (action.type === 'wait') {
          const minutes = Number(action.params.durationMinutes ?? action.params.minutes ?? 0);
          if (!Number.isFinite(minutes) || minutes < 0) throw new ItemExecutionError('wait_invalid', '待ち時間が正しくありません', false);
          return { status: 'waiting', after: { cursor: cursor + 1 }, retryAt: addMinutes(now, minutes) };
        }
        await runExecutor(db, executors[action.type], run, { ...item, line_account_id: friend.line_account_id }, action, attempt);
      }
      return { status: 'success', after: { cursor, commonActionVersionId: operation.commonActionVersionId } };
    }
    case 'set_friend_fields': {
      const ids = Object.keys(operation.values);
      const rows = await db.prepare(
        `SELECT field_id, value FROM friend_field_values
          WHERE friend_id = ? AND field_id IN (${sqlIdSet(ids).sql})`,
      ).bind(friend.id, ...(ids.length ? sqlIdSet(ids).binds : [])).all<{ field_id: string; value: string | null }>();
      const before = Object.fromEntries(ids.map((id) => [id, rows.results.find((row) => row.field_id === id)?.value ?? null]));
      if (JSON.stringify(before) === JSON.stringify(operation.values)) return { status: 'skipped', before, after: before };
      // 書き込みは中央の口へ寄せ、項目定義で検証・正規化する。
      // 作成時に検証済みのはずだが、列車合流前の古い操作が残っていても不正値を書かない。
      const defs = await db.prepare(
        `SELECT id, COALESCE(type_v8, type_v6, type) AS resolved_type, options_json
           FROM friend_fields WHERE id IN (${sqlIdSet(ids).sql})`,
      ).bind(...(ids.length ? sqlIdSet(ids).binds : [])).all<{ id: string; resolved_type: string; options_json: string | null }>();
      const defById = new Map(defs.results.map((row) => [row.id, row]));
      for (const [fieldId, value] of Object.entries(operation.values)) {
        const def = defById.get(fieldId);
        if (!def) throw new ItemExecutionError('friend_field_not_found', '友だち情報の項目が見つかりません', false);
        try {
          await setFriendFieldValue(db, {
            friendId: friend.id,
            fieldId,
            value,
            updatedBy: run.created_by,
            field: { type: def.resolved_type, options_json: def.options_json },
          });
        } catch (error) {
          throw new ItemExecutionError(
            'friend_field_value_invalid',
            error instanceof Error ? error.message.replace(/^invalid friend field value: /, '') : '友だち情報の値が正しくありません',
            false,
          );
        }
      }
      return { status: 'success', before, after: operation.values };
    }
    case 'set_visibility': {
      const before = { hidden: friend.is_hidden === 1 };
      if (before.hidden === operation.hidden) return { status: 'skipped', before, after: before };
      await db.prepare(`UPDATE friends SET is_hidden = ?, updated_at = ? WHERE id = ?`)
        .bind(operation.hidden ? 1 : 0, now, friend.id).run();
      return { status: 'success', before, after: { hidden: operation.hidden } };
    }
    case 'add_conversion': {
      const id = `${item.id}:conversion`;
      const existing = await db.prepare(`SELECT id FROM conversion_events WHERE id = ?`).bind(id).first<{ id: string }>();
      if (existing) return { status: 'skipped', before: null, after: { id } };
      // 主経路(conversions.ts)と同じ4つのsnapshotを保存時点で凍結する。
      // affiliate_id はNULLのままにする。これは控え忘れではない。一括操作は
      // 紹介コードの文脈を持たず attribution を解決しないため、埋めるほうが嘘になる。
      // なお一括ダイアログに成果タイルは無く通常はUIから到達不能だが、
      // API直接呼び出しでは実行できるため凍結は必要。
      const point = await db.prepare(
        `SELECT name, event_type, value, version, tenant_id, line_account_id FROM conversion_points WHERE id = ?`,
      ).bind(operation.conversionPointId).first<{
        name: string; event_type: string; value: number | null; version: number;
        tenant_id: string | null; line_account_id: string | null;
      }>();
      if (!point) throw new ItemExecutionError('conversion_point_not_found', '成果地点が見つかりません', false);
      /*
       * 主経路(trackConversion)と同じ境界をここでも閉じる。
       * 一括操作はAPIの直接呼び出しで任意の地点×友だちを結べるため、
       * アカウントも統括も一致しない組合せでは成果を書かない。
       */
      const friendAccount = friend.line_account_id
        ? await db.prepare(`SELECT tenant_id FROM line_accounts WHERE id = ?`)
            .bind(friend.line_account_id).first<{ tenant_id: string | null }>()
        : null;
      if (!canRecordConversion(
        point.line_account_id,
        friend.line_account_id,
        point.tenant_id,
        friendAccount?.tenant_id ?? null,
      )) {
        throw new ItemExecutionError('conversion_account_mismatch', '成果地点と友だちの所属が違うため記録できません', false);
      }
      await db.prepare(
        `INSERT INTO conversion_events
           (id, conversion_point_id, friend_id, metadata, created_at, approval_status,
            point_name_snapshot, event_type_snapshot, value_snapshot, point_version_snapshot,
            tenant_id)
         VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        operation.conversionPointId,
        friend.id,
        JSON.stringify({ source: 'friend_bulk_run', runId: run.id }),
        now,
        point.name,
        point.event_type,
        Number(point.value ?? 0),
        point.version,
        point.tenant_id,
      ).run();
      return { status: 'success', before: null, after: { id } };
    }
    case 'remove_conversion': {
      const count = await db.prepare(
        `SELECT COUNT(*) AS count FROM conversion_events WHERE friend_id = ? AND conversion_point_id = ?`,
      ).bind(friend.id, operation.conversionPointId).first<{ count: number }>();
      if (Number(count?.count ?? 0) === 0) return { status: 'skipped', before: { count: 0 }, after: { count: 0 } };
      await db.prepare(`DELETE FROM conversion_events WHERE friend_id = ? AND conversion_point_id = ?`)
        .bind(friend.id, operation.conversionPointId).run();
      return { status: 'success', before: { count: Number(count?.count ?? 0) }, after: { count: 0 } };
    }
  }
}

async function executeUndo(
  db: D1Database,
  undoRun: RunRow,
  item: ItemRow,
  operation: FriendBulkOperation,
  now: string,
): Promise<{ status: 'success' | 'skipped'; before: unknown; after: unknown }> {
  const source = await db.prepare(
    `SELECT before_json, after_json FROM friend_bulk_run_items
      WHERE run_id = ? AND friend_id = ? AND status = 'success'`,
  ).bind(undoRun.undo_of_run_id, item.friend_id).first<{ before_json: string | null; after_json: string | null }>();
  if (!source) return { status: 'skipped', before: null, after: null };
  const before = source.before_json ? JSON.parse(source.before_json) as Record<string, unknown> : null;
  const after = source.after_json ? JSON.parse(source.after_json) as Record<string, unknown> : null;
  const conflict = (): never => {
    throw new ItemExecutionError(
      'undo_conflict',
      '一括操作のあとに内容が変更されているため、この対象は取り消しませんでした',
      false,
    );
  };
  switch (operation.kind) {
    case 'add_tag':
    case 'remove_tag': {
      const currentAssigned = Boolean(await db.prepare(
        `SELECT 1 AS ok FROM friend_tags WHERE friend_id = ? AND tag_id = ?`,
      ).bind(item.friend_id, operation.tagId).first<{ ok: number }>());
      if (currentAssigned !== Boolean(after && after.assigned)) conflict();
      const assigned = Boolean(before && before.assigned);
      if (assigned) await attachTagAndFireSideEffects(db, item.friend_id, operation.tagId);
      else await detachTagAndFireSideEffects(db, item.friend_id, operation.tagId);
      break;
    }
    case 'start_scenario':
    case 'stop_scenario': {
      const expectedId = after && typeof after.id === 'string' ? after.id : null;
      const current = expectedId ? await db.prepare(
        `SELECT id, status FROM friend_scenarios WHERE id = ?`,
      ).bind(expectedId).first<{ id: string; status: string }>() : null;
      if (!expectedId || !current || current.status !== after?.status) conflict();
      if (before && typeof before.id === 'string') {
        await db.prepare(`UPDATE friend_scenarios SET confirmation_revision = confirmation_revision + 1, status = ?, updated_at = ? WHERE id = ?`)
          .bind(before.status, now, before.id).run();
      } else if (after && typeof after.id === 'string') {
        await db.prepare(`DELETE FROM friend_scenarios WHERE id = ?`).bind(after.id).run();
      }
      break;
    }
    case 'assign_operator': {
      const chat = await getChatByFriendId(db, item.friend_id);
      if ((chat ? chatAssigneeId(chat) : null) !== (after?.operatorId ?? null)) conflict();
      if (chat) { const previous = before?.operatorId as string | null; if (previous?.startsWith('staff:') && !await canAssignChatTo(db, previous.slice(6), item.line_account_id)) conflict(); await updateChat(db, chat.id, previous?.startsWith('staff:') ? { assigneeStaffId: previous.slice(6) } : { operatorId: previous, assigneeStaffId: null }); }
      break;
    }
    case 'set_support': {
      const chat = await getChatByFriendId(db, item.friend_id);
      const friend = await db.prepare(`SELECT support_mark_id FROM friends WHERE id = ?`)
        .bind(item.friend_id).first<{ support_mark_id: string | null }>();
      if ((chat?.status ?? null) !== (after?.status ?? null)
        || (friend?.support_mark_id ?? null) !== (after?.markId ?? null)) conflict();
      if (chat && typeof before?.status === 'string') await updateChat(db, chat.id, { status: before.status });
      if (item.line_account_id) await setFriendSupportMark(
        db,
        item.friend_id,
        typeof before?.markId === 'string' ? before.markId : null,
        { tenantId: undoRun.tenant_id, lineAccountId: item.line_account_id },
        undoRun.created_by,
      );
      break;
    }
    case 'set_reminder': {
      const ids = after && Array.isArray(after.ids) ? after.ids.filter((id): id is string => typeof id === 'string') : [];
      if (!ids.length) conflict();
      const rows = await db.prepare(
        `SELECT id, status FROM friend_reminders WHERE id IN (${sqlIdSet(ids).sql})`,
      ).bind(...(ids.length ? sqlIdSet(ids).binds : [])).all<{ id: string; status: string }>();
      if (rows.results.length !== ids.length || rows.results.some((row) => row.status !== 'active')) conflict();
      if (ids.length) await db.prepare(`UPDATE friend_reminders SET status = 'cancelled', updated_at = ? WHERE id IN (${sqlIdSet(ids).sql})`)
        .bind(now, ...(ids.length ? sqlIdSet(ids).binds : [])).run();
      break;
    }
    case 'cancel_reminder': {
      const rows = Array.isArray(before) ? before : [];
      const ids = rows.filter(isRecord).map((row) => row.id).filter((id): id is string => typeof id === 'string');
      const current = ids.length ? await db.prepare(
        `SELECT id, status FROM friend_reminders WHERE id IN (${sqlIdSet(ids).sql})`,
      ).bind(...(ids.length ? sqlIdSet(ids).binds : [])).all<{ id: string; status: string }>() : { results: [] };
      if (!ids.length || current.results.length !== ids.length
        || current.results.some((row) => row.status !== 'cancelled')) conflict();
      for (const row of rows) if (isRecord(row) && typeof row.id === 'string') {
        await db.prepare(`UPDATE friend_reminders SET status = 'active', updated_at = ? WHERE id = ?`).bind(now, row.id).run();
      }
      break;
    }
    case 'set_friend_fields': {
      if (!isRecord(before)) break;
      if (!isRecord(after)) return conflict();
      const afterValues = after;
      const ids = Object.keys(afterValues);
      const currentRows = await db.prepare(
        `SELECT field_id, value FROM friend_field_values
          WHERE friend_id = ? AND field_id IN (${sqlIdSet(ids).sql})`,
      ).bind(item.friend_id, ...(ids.length ? sqlIdSet(ids).binds : [])).all<{ field_id: string; value: string | null }>();
      const current = Object.fromEntries(ids.map((id) => [
        id,
        currentRows.results.find((row) => row.field_id === id)?.value ?? null,
      ]));
      if (JSON.stringify(current) !== JSON.stringify(afterValues)) conflict();
      for (const [fieldId, value] of Object.entries(before)) {
        if (value === null) await db.prepare(`DELETE FROM friend_field_values WHERE friend_id = ? AND field_id = ?`).bind(item.friend_id, fieldId).run();
        else await db.prepare(
          `INSERT INTO friend_field_values (friend_id, field_id, value, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(friend_id, field_id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
        ).bind(item.friend_id, fieldId, String(value), now, 'bulk-undo').run();
      }
      break;
    }
    case 'set_visibility': {
      const current = await db.prepare(`SELECT is_hidden FROM friends WHERE id = ?`)
        .bind(item.friend_id).first<{ is_hidden: number }>();
      if (!current || (current.is_hidden === 1) !== (after?.hidden === true)) conflict();
      await db.prepare(`UPDATE friends SET is_hidden = ?, updated_at = ? WHERE id = ?`)
        .bind(before?.hidden === true ? 1 : 0, now, item.friend_id).run();
      break;
    }
    case 'add_conversion': {
      const conversionId = after && typeof after.id === 'string' ? after.id : null;
      if (!conversionId) return conflict();
      const current = await db.prepare(`SELECT id FROM conversion_events WHERE id = ?`)
        .bind(conversionId).first<{ id: string }>();
      if (!current) conflict();
      await db.prepare(`DELETE FROM conversion_events WHERE id = ?`).bind(conversionId).run();
      break;
    }
    default:
      throw new ItemExecutionError('undo_not_supported', 'この操作は取り消せません', false);
  }
  return { status: 'success', before: after, after: before };
}

export async function processFriendBulkRun(
  db: D1Database,
  runId: string,
  options: {
    now?: string;
    limit?: number;
    executorDependencies?: AutomationActionExecutorDependencies;
    executors?: Record<string, AutomationActionExecutor>;
  } = {},
): Promise<{ processed: number; status: string }> {
  const run = await getFriendBulkRunRow(db, runId) as RunRow | null;
  if (!run) throw new FriendBulkRunError('run_not_found', '一括操作が見つかりません', 404);
  const now = options.now ?? new Date().toISOString();
  if (run.scheduled_at && run.scheduled_at > now) return { processed: 0, status: run.status };
  const approval = await getBulkMessageApproval(db, runId);
  if (approval && !['approved', 'confirmed'].includes(approval.status)) return { processed: 0, status: run.status };
  if (approval?.status === 'confirmed') {
    const { countActiveOperators } = await import('../broadcasts/broadcast-approval/index.js');
    if (await countActiveOperators(db) > 1) {
      await db.prepare(`UPDATE friend_bulk_message_approvals SET status = 'pending', decided_by = NULL,
        decided_at = NULL, confirmed_count = NULL WHERE run_id = ? AND status = 'confirmed'`).bind(runId).run();
      return { processed: 0, status: run.status };
    }
  }
  const operation = JSON.parse(run.operation_json) as FriendBulkOperation;
  // 既存の台帳や再試行でも承認を迂回させない。固定した対象数で判定する。
  if (operation.kind === 'send_message' && !approval) {
    const accounts = await db.prepare('SELECT DISTINCT line_account_id FROM friend_bulk_run_items WHERE run_id = ?')
      .bind(runId).all<{ line_account_id: string }>();
    const count = await db.prepare('SELECT COUNT(*) AS count FROM friend_bulk_run_items WHERE run_id = ?')
      .bind(runId).first<{ count: number }>();
    const threshold = await bulkMessageThreshold(db, accounts.results.map((row) => row.line_account_id));
    if ((count?.count ?? 0) >= threshold) {
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO friend_bulk_message_approvals
          (run_id, status, recipient_count, threshold, requested_by, requested_at)
          VALUES (?, 'pending', ?, ?, ?, ?)`)
          .bind(runId, count!.count, threshold, run.created_by, now),
        db.prepare(`INSERT INTO friend_bulk_message_approval_events (id, run_id, actor_staff_id, action, created_at)
          SELECT ?, run_id, requested_by, 'requested', ? FROM friend_bulk_message_approvals
          WHERE run_id = ? AND requested_at = ? AND status = 'pending'`)
          .bind(crypto.randomUUID(), now, runId, now),
        db.prepare(`UPDATE friend_bulk_runs SET status = 'waiting', updated_at = ? WHERE id = ?`)
          .bind(now, runId),
      ]);
      return { processed: 0, status: 'waiting' };
    }
  }
  const plan = run.execution_plan_json ? JSON.parse(run.execution_plan_json) as ActionDefinition[] : null;
  const executors = options.executors ?? createAutomationActionExecutors(options.executorDependencies);
  const items = await getFriendBulkRunItemRows(db, runId) as ItemRow[];
  let processed = 0;
  for (const item of items) {
    if (processed >= (options.limit ?? DEFAULT_PROCESS_LIMIT)) break;
    const claimed = await claimFriendBulkRunItem(db, item.id, now, addMinutes(now, ITEM_LEASE_MINUTES)) as ItemRow | null;
    if (!claimed) continue;
    processed += 1;
    try {
      const result = run.undo_of_run_id
        ? await executeUndo(db, run, claimed, operation, now)
        : await executeOperation(db, run, claimed, operation, plan, executors, now);
      await updateFriendBulkRunItem(db, item.id, {
        status: result.status,
        before: result.before,
        after: result.after,
        retryAt: 'retryAt' in result ? result.retryAt : null,
        now,
      });
    } catch (error) {
      const failure = error instanceof ItemExecutionError
        ? error
        : new ItemExecutionError('execution_failed', '一括操作を実行できませんでした', true);
      await updateFriendBulkRunItem(db, item.id, {
        status: failure.retryable ? 'temporary_failure' : 'permanent_failure',
        errorCode: failure.code,
        errorMessage: failure.message,
        now,
      });
    }
  }
  const status = await refreshFriendBulkRunSummary(db, runId, now);
  return { processed, status };
}

export async function processDueFriendBulkRuns(
  db: D1Database,
  options: {
    now?: string;
    limit?: number;
    executorDependencies?: AutomationActionExecutorDependencies;
  } = {},
): Promise<{ runs: number; items: number }> {
  const now = options.now ?? new Date().toISOString();
  await db.prepare(
    `UPDATE friend_bulk_runs
        SET status = 'cancelled', completed_at = ?, updated_at = ?,
            error_message = '契約先の利用停止中に実行時刻を過ぎたため実行しませんでした'
      WHERE status IN ('queued', 'waiting')
        AND (scheduled_at IS NULL OR scheduled_at <= ?)
        AND tenant_id != ?
        AND NOT EXISTS (
          SELECT 1 FROM tenants
           WHERE tenants.id = friend_bulk_runs.tenant_id
             AND tenants.status = 'active'
        )`,
  ).bind(now, now, now, DEFAULT_TENANT_ID).run();
  const ids = await listDueFriendBulkRunIds(db, now, options.limit ?? 20);
  let items = 0;
  for (const id of ids) {
    const result = await processFriendBulkRun(db, id, {
      now,
      limit: DEFAULT_PROCESS_LIMIT,
      executorDependencies: options.executorDependencies,
    });
    items += result.processed;
  }
  return { runs: ids.length, items };
}

export async function retryFriendBulkRun(
  db: D1Database,
  runId: string,
  staff: AuthenticatedStaff,
  now = new Date().toISOString(),
): Promise<number> {
  const tenantId = staff.tenantId ?? DEFAULT_TENANT_ID;
  await requireFriendBulkRunAccess(db, staff, runId);
  const reset = await resetFriendBulkRunFailures(db, runId, tenantId, now);
  if (reset < 0) throw new FriendBulkRunError('run_not_found', '一括操作が見つかりません', 404);
  if (reset === 0) throw new FriendBulkRunError('nothing_to_retry', '再試行する失敗はありません', 409);
  return reset;
}

export async function createFriendBulkUndoRun(
  db: D1Database,
  staff: AuthenticatedStaff,
  sourceRunId: string,
  idempotencyKey: string,
  now = new Date().toISOString(),
) {
  const tenantId = staff.tenantId ?? DEFAULT_TENANT_ID;
  await requireFriendBulkRunAccess(db, staff, sourceRunId);
  const summary = await db.prepare(`SELECT reversible, operation_json, selection_json FROM friend_bulk_runs WHERE id = ?`)
    .bind(sourceRunId).first<{ reversible: number; operation_json: string; selection_json: string }>();
  if (!summary || summary.reversible !== 1) throw new FriendBulkRunError('undo_not_supported', 'この操作は取り消せません', 409);
  const rows = await db.prepare(
    `SELECT friend_id, line_account_id FROM friend_bulk_run_items
      WHERE run_id = ? AND status = 'success' ORDER BY ordinal`,
  ).bind(sourceRunId).all<{ friend_id: string; line_account_id: string | null }>();
  if (rows.results.length === 0) throw new FriendBulkRunError('nothing_to_undo', '取り消せる完了分がありません', 409);
  return createFriendBulkRun(db, {
    tenantId,
    createdBy: staff.id,
    selection: JSON.parse(summary.selection_json) as FriendBulkSelection,
    operation: JSON.parse(summary.operation_json) as FriendBulkOperation,
    targets: rows.results.map((row) => ({ friendId: row.friend_id, lineAccountId: row.line_account_id })),
    excludedCount: 0,
    reversible: false,
    idempotencyKey,
    undoOfRunId: sourceRunId,
    now,
  });
}

/**
 * 実行IDを知っていても、現在の担当範囲外の友だち名や操作結果は見せない。
 * 作成後に担当範囲が狭まった場合も、全対象を見られる人だけが再試行・取消できる。
 */
export async function requireFriendBulkRunAccess(
  db: D1Database,
  staff: AuthenticatedStaff,
  runId: string,
): Promise<RunRow> {
  const tenantId = staff.tenantId ?? DEFAULT_TENANT_ID;
  const run = await getFriendBulkRunRow(db, runId) as RunRow | null;
  if (!run || run.tenant_id !== tenantId) {
    throw new FriendBulkRunError('run_not_found', '一括操作が見つかりません', 404);
  }
  const rows = await db.prepare(
    `SELECT DISTINCT line_account_id FROM friend_bulk_run_items WHERE run_id = ?`,
  ).bind(runId).all<{ line_account_id: string | null }>();
  if (!await canAccessAllLineAccounts(
    db,
    staff,
    rows.results.map((row) => row.line_account_id),
  )) {
    // 存在自体を明かさない。
    throw new FriendBulkRunError('run_not_found', '一括操作が見つかりません', 404);
  }
  return run;
}

export { parseOperation, parseSelection };
