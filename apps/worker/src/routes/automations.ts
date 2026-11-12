import { readRestaurantFollowupResourceManagement } from '../services/restaurant-followup-resource-management.js';
import {defaultWindow} from './automation-execution-window.js';
import { withStyleSampleMetadata } from '../services/style-sample-metadata.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { automationTabCounts } from '../services/tab-counts.js';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  getAutomationById,
  updateAutomation,
  deleteAutomation,
  getAutomationLogs,
  getAutomationExecutionRun,
  getAutomationExecutionRuns,
  getAutomationExecutionRunSteps,
  isOperationCapabilityStopped,
  type AutomationRunDomainStatus,
} from '@line-crm/db';
import { fail } from '../lib/fail.js';
import type { Env } from '../worker-env.js';
import { requireRole, denyReadOnly } from '../middleware/role-guard.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import {
  AutomationDraftError,
  createAutomationDraftFromDefinition,
  createAutomationDraftFromTemplate,
  duplicateAutomationDefinition,
  getAutomationDraft,
  listAutomationDraftResources,
  listAutomationTemplates,
  publishAutomationDraft,
  updateAutomationDraft,
} from '../features/automations/automation-drafts/index.js';
import {
  AutomationDefinitionError,
  listAutomationDefinitions,
  previewAutomationAudience,
  runAutomationTest,
  updateAutomationDefinitionStatus,
  restoreAutomationDefinition,
} from '../features/automations/automation-definitions/index.js';
import {
  AutomationRunCancelError,
  AutomationRunRetryError,
  cancelAutomationRun,
  retryAutomationRun,
} from '../features/automations/automation-engine/index.js';
import { accountFeatureAvailability } from '../services/feature-enforcement.js';
import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { automationActionLabel, automationTriggerLabel } from '@line-crm/shared';

const automations = new Hono<Env>();

async function requireAutomationPermission(c: Context<Env>, next: () => Promise<void>) {
  const staff = c.get('staff');
  if (!staff || (staff.role === 'staff' && !staff.permissionKeys?.includes('/automations'))) {
    return c.json({ success: false, error: 'この機能を操作する権限がありません' }, 403);
  }
  await next();
}

// 実行記録の「見るだけ」の入口。設定画面で閲覧だけを許可した担当者でも
// 履歴の一覧・詳細を読めるよう、共通の閲覧判定（viewPermissionKeys）を使う。
// 再試行・取消・CSV書き出しはこの後の個別権限が引き続き守る。
async function requireAutomationViewPermission(c: Context<Env>, next: () => Promise<void>) {
  const staff = c.get('staff');
  if (!staff || (staff.role === 'staff'
    && !staff.permissionKeys?.includes('/automations')
    && !staff.viewPermissionKeys?.includes('/automations'))) {
    return c.json({ success: false, error: 'この機能を閲覧する権限がありません' }, 403);
  }
  await next();
}

async function requireAutomationTestPermission(c: Context<Env>, next: () => Promise<void>) {
  const staff = c.get('staff');
  if (!staff || (staff.role === 'staff'
    && !staff.permissionKeys?.includes('automation.definition.test'))) {
    return c.json({ success: false, error: '1人テストを実行する権限がありません' }, 403);
  }
  await next();
}

async function requireAutomationRetryPermission(c: Context<Env>, next: () => Promise<void>) {
  const staff = c.get('staff');
  if (!staff || (staff.role === 'staff'
    && !staff.permissionKeys?.includes('automation.run.retry'))) {
    // 再実行・取りやめの両方で使うため、動詞をどちらかに絞らない。
    return c.json({ success: false, error: 'この実行を操作する権限がありません' }, 403);
  }
  await next();
}

async function requireDraftAccount(c: Context<Env>): Promise<string | Response> {
  const id = c.req.query('account_id')?.trim();
  if (!id) return inputError(c, { success: false, error: 'LINE公式アカウントを選んでください' }, 400, ["account_id"]);
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  if (!scope.allowedAccountIds.includes(id)) {
    return c.json({ success: false, error: '対象のLINE公式アカウントが見つかりません' }, 404);
  }
  return id;
}

function draftErrorResponse(c: Context<Env>, error: AutomationDraftError): Response {
  const status = error.code === 'version_conflict' ? 409
    : new Set(['not_found', 'template_not_found']).has(error.code) ? 404
      : 422;
  return inputError(c, {
    success: false,
    error: error.message,
    code: error.code,
    ...(error.field ? { field: error.field } : {}),
  }, status, []);
}

function definitionErrorResponse(c: Context<Env>, error: AutomationDefinitionError): Response {
  const status = error.code === 'version_conflict' ? 409
    : error.code === 'not_found' ? 404
      : 422;
  return inputError(c, {
    success: false,
    error: error.message,
    code: error.code,
    ...(error.field ? { field: error.field } : {}),
  }, status, []);
}

async function definitionEndpoint<T>(c: Context<Env>, run: () => Promise<T>): Promise<Response> {
  try {
    return c.json({ success: true, data: await run() });
  } catch (error) {
    if (error instanceof AutomationDefinitionError) return definitionErrorResponse(c, error);
    throw error;
  }
}

async function draftEndpoint<T>(
  c: Context<Env>,
  run: () => Promise<T> | T,
  successStatus = 200,
): Promise<Response> {
  try {
    return c.json({ success: true, data: await run() }, successStatus as 200);
  } catch (error) {
    if (error instanceof AutomationDraftError) return draftErrorResponse(c, error);
    throw error;
  }
}

type ExecutionRunStatus =
  | 'queued'
  | 'claimed'
  | 'succeeded'
  | 'skipped'
  | 'waiting'
  | 'retry_wait'
  | 'partial'
  | 'permanent_failed'
  | 'cancelled';

interface AutomationExecutionRun {
  id: string;
  ownerKind: 'automation';
  ownerId: string;
  lineAccountId: string;
  occurredAt: string;
  subject: string | null;
  accountLabel: string | null;
  triggerLabel: string;
  reference: null;
  status: ExecutionRunStatus;
  detail: string | null;
  durationMs: number | null;
  canRetry: boolean;
  automationId: string;
  automationName: string;
  automationVersionId: string;
  /** 実行時に固定された版番号。 */
  versionNumber: number;
  /** 1人テストの実行か（ ：テスト実行の印）。 */
  isTest: boolean;
  /** 取りやめられるのは、まだ終わっていない実行だけ。 */
  canCancel: boolean;
  friendId: string | null;
  friendName: string | null;
  sourceEventId: string;
  domainStatus: AutomationRunDomainStatus;
  startedAt: string | null;
  completedAt: string | null;
  successfulActions: string[];
  skippedActions: string[];
  failedAction: string | null;
  failureReason: string | null;
  /**
   * まだ終わっていない実行が、運用停止・機能無効で動けないときの理由
   * （：停止・権限を「待っています」と区別する）。
   */
  holdReason: string | null;
  /** 実行した版がいまの公開版と同じか（：現在の版と実行版の区別）。 */
  isCurrentVersion: boolean;
  currentVersionNumber: number | null;
}

interface AutomationExecutionRunsResponse {
  summary: {
    total: number;
    executed: number;
    skipped: number;
    failed: number;
    mostRunName: string | null;
    mostRunCount: number | null;
  };
  items: AutomationExecutionRun[];
  pagination: { total: number; limit: number; offset: number };
}

const COMMON_STATUS_TO_DOMAIN: Record<ExecutionRunStatus, AutomationRunDomainStatus[]> = {
  queued: ['queued'],
  claimed: ['running'],
  waiting: ['waiting'],
  succeeded: ['success'],
  skipped: ['skipped_condition'],
  // 待機(wait)と再試行待ちはdomainでは同じ `waiting`。行の中身
  // （待機stepの retry_at の有無）で表示側を分けるため、retry_wait の
  // 絞り込みは待機中全体を返す意図的な近似。
  retry_wait: ['waiting'],
  // 一部だけ成功は失敗とは別の状態として区別する。
  partial: ['partial'],
  permanent_failed: ['failed'],
  cancelled: ['cancelled'],
};

const DOMAIN_STATUS_TO_COMMON: Record<AutomationRunDomainStatus, ExecutionRunStatus> = {
  queued: 'queued',
  running: 'claimed',
  waiting: 'waiting',
  success: 'succeeded',
  partial: 'partial',
  failed: 'permanent_failed',
  cancelled: 'cancelled',
  skipped_condition: 'skipped',
};

function actionLabels(value: string | null): string[] {
  if (!value) return [];
  return value.split(' / ').filter(Boolean).map(automationActionLabel);
}

function safeFailureReason(code: string | null, failedAction: string | null): string {
  if (code === 'line_api_error') return 'LINEへの送信を完了できませんでした';
  if (code?.startsWith('webhook_')) return '外部連携先が応答しませんでした';
  if (code === 'common_action_version_missing') return '使う共通アクションの版を確認してください';
  return `${failedAction ?? '登録した処理'}を完了できませんでした`;
}


/**
 * まだ終わっていない実行が「運用停止」「機能無効」で claim できないとき、
 * その理由をアカウントごとに人の言葉で返す。
 *
 * 実行エンジンは停止中の実行を消さず queued のまま残し、再開後に動かす
 * 設計のため、理由は書き込みではなく読み取り時に付け足す。
 * 理由が取れなくても一覧自体は落とさない。
 */
async function holdReasonByAccount(
  db: D1Database,
  rows: readonly { line_account_id: string; status: AutomationRunDomainStatus }[],
): Promise<ReadonlyMap<string, string>> {
  const reasons = new Map<string, string>();
  const accountIds = [...new Set(
    rows
      .filter((row) => row.status === 'queued' || row.status === 'waiting')
      .map((row) => row.line_account_id),
  )];
  await Promise.all(accountIds.map(async (accountId) => {
    try {
      if (await isOperationCapabilityStopped(db, accountId, 'automation_actions')) {
        reasons.set(accountId, '運用停止中のため、いまは動かせません。再開されると動きます');
        return;
      }
      const availability = await accountFeatureAvailability(db, accountId, 'automations');
      if (!availability.effectiveEnabled) {
        reasons.set(accountId, availability.message ?? 'このアカウントではオートメーションを使えません');
      }
    } catch {
      // 理由を取れなくても記録の表示自体は止めない。
    }
  }));
  return reasons;
}

/** DB行 → 台帳・詳細・CSVで共通の実行記録の形。 */
function mapExecutionRun(row: {
  id: string;
  line_account_id: string;
  account_name: string | null;
  automation_id: string;
  automation_name: string;
  automation_version_id: string;
  version_number: number;
  is_test: number;
  current_published_version_id: string | null;
  current_version_number: number | null;
  has_retry_wait: number | null;
  friend_id: string | null;
  friend_name: string | null;
  source_event_id: string;
  trigger_type: string;
  status: AutomationRunDomainStatus;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  duration_ms: number | null;
  successful_actions: string | null;
  skipped_actions: string | null;
  failed_action: string | null;
  failure_code: string | null;
}, holdReason: string | null = null): AutomationExecutionRun {
  const successfulActions = actionLabels(row.successful_actions);
  const skippedActions = actionLabels(row.skipped_actions);
  const failedAction = row.failed_action ? automationActionLabel(row.failed_action) : null;
  const failureReason = safeFailureReason(row.failure_code, failedAction);
  // domainの `waiting` は待機(wait)と失敗の再試行待ちを兼ねる。
  // 待機中stepに retry_at があるときだけ再試行待ちとする。
  const statusLabel: ExecutionRunStatus = row.status === 'waiting' && Number(row.has_retry_wait ?? 0) > 0
    ? 'retry_wait'
    : DOMAIN_STATUS_TO_COMMON[row.status];
  // まだ終わっていない実行の「いま止まっている理由」。
  const pendingReason = row.status === 'queued' || row.status === 'waiting'
    ? holdReason
      ?? (row.status === 'waiting'
        ? (statusLabel === 'retry_wait' ? '失敗した処理の再試行を待っています' : '設定した時刻まで待っています')
        : null)
    : null;
  const detail = row.status === 'skipped_condition'
    ? '条件に合わなかったため、何もしていません'
    : row.status === 'failed'
      ? failureReason
      : row.status === 'partial'
        ? [successfulActions.join('／'), skippedActions.length ? `${skippedActions.join('／')}は見送り` : null, failedAction ? failureReason : null].filter(Boolean).join('。') || null
        : [successfulActions.join('／') || null, pendingReason].filter(Boolean).join('。') || null;
  return {
    id: row.id,
    ownerKind: 'automation',
    ownerId: row.automation_id,
    lineAccountId: row.line_account_id,
    occurredAt: row.completed_at ?? row.started_at ?? row.created_at,
    subject: row.friend_name,
    accountLabel: row.account_name,
    triggerLabel: automationTriggerLabel(row.trigger_type),
    reference: null,
    status: statusLabel,
    detail,
    durationMs: row.duration_ms,
    // 失敗 step だけを戻すため、成功済みの処理は二重に動かさない。
    canRetry: (row.status === 'failed' || row.status === 'partial') && failedAction !== null,
    automationId: row.automation_id,
    automationName: row.automation_name,
    automationVersionId: row.automation_version_id,
    versionNumber: Number(row.version_number),
    isTest: row.is_test === 1,
    canCancel: row.status === 'queued' || row.status === 'running' || row.status === 'waiting',
    friendId: row.friend_id,
    friendName: row.friend_name,
    sourceEventId: row.source_event_id,
    domainStatus: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    successfulActions,
    skippedActions,
    failedAction,
    failureReason: row.status === 'failed'
      ? failureReason
      : row.status === 'partial' && (row.failed_action || row.failure_code)
        ? failureReason
        : null,
    holdReason: holdReason ?? null,
    isCurrentVersion: row.current_published_version_id != null
      && row.automation_version_id === row.current_published_version_id,
    currentVersionNumber: row.current_version_number == null
      ? null
      : Number(row.current_version_number),
  };
}

const RUN_STATUS_LABEL_CSV: Record<ExecutionRunStatus, string> = {
  queued: '待機中',
  claimed: '実行中',
  waiting: '待機中',
  retry_wait: '再試行待ち',
  succeeded: '成功',
  partial: '一部失敗',
  permanent_failed: '失敗',
  cancelled: '取消',
  skipped: '条件に合わず',
};

function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  // Excel/表計算で数式として実行されないよう、= + - @ で始まる外部入力値へ
  // 引用符を前置する（common-actions.ts の正本と同じ対策）。
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * 台帳の絞り込み結果をCSVにする。
 *
 * 画面の検索・状態・期間の絞り込みと同じ行を出す。先頭の BOM は
 * Excelで開いたときに日本語が化けないための目印。
 */
function executionRunsCsv(items: AutomationExecutionRun[]): string {
  const header = [
    '実行日時', 'LINE公式アカウント', 'オートメーション', '版', '対象',
    'きっかけ', '状態', '処理結果', 'テスト実行', '所要時間(ミリ秒)', '実行ID',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const item of items) {
    lines.push([
      item.occurredAt,
      item.accountLabel,
      item.automationName,
      `v${item.versionNumber}`,
      item.friendName,
      item.triggerLabel,
      RUN_STATUS_LABEL_CSV[item.status],
      item.detail,
      item.isTest ? 'テスト' : '',
      item.durationMs,
      item.id,
    ].map(csvCell).join(','));
  }
  return `﻿${lines.join('\r\n')}`;
}

async function requireVisibleAutomation(c: Context<Env>, next: () => Promise<void>) {
  const id = c.req.param('id')!;
  // 一覧が返すidは の automation_definitions。旧 automations 表の
  // 行だけを見ると、の定義への操作が全部 404 になる。先にを見る。
  const definition = await c.env.DB.prepare(
    `SELECT line_account_id FROM automation_definitions WHERE id = ?`,
  ).bind(id).first<{ line_account_id: string }>();
  if (definition) {
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [definition.line_account_id])) {
      return fail(c, 404, 'AUTOMATION_NOT_FOUND');
    }
    await next();
    return;
  }
  const item = await getAutomationById(c.env.DB, id);
  if (!item || !await canAccessAllLineAccounts(
    c.env.DB,
    c.get('staff'),
    [item.line_account_id ?? null],
  )) {
    return fail(c, 404, 'AUTOMATION_NOT_FOUND');
  }
  await next();
}

// ========== 自動化ルールCRUD ==========

/** 実行まで接続済みの処理だけを含む、サーバー管理の見本。 */
automations.get(
  '/api/automation-templates',
  requireAutomationPermission,
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
    const accountId = await requireDraftAccount(c);
    if (typeof accountId !== 'string') return accountId;
    return draftEndpoint(c, () => listAutomationTemplates());
  },
);

//  下書きの作成・保存は「オートメーションを触れる人」= 権限キー
// `/automations` を持つスタッフも通す。入口の絞り込みは
// requireAutomationPermission が既に担うので、role で二度絞らない。
automations.get(
  '/api/automation-draft-resources',
  requireAutomationPermission,
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
    const accountId = await requireDraftAccount(c);
    if (typeof accountId !== 'string') return accountId;
    return draftEndpoint(c, () => listAutomationDraftResources(c.env.DB, accountId));
  },
);

automations.post(
  '/api/automation-templates/:key/drafts',
  requireAutomationPermission,
  requireRole('owner', 'admin', 'staff'),
  inputJsonBoundary(), async (c) => {
    const accountId = await requireDraftAccount(c);
    if (typeof accountId !== 'string') return accountId;
    /*
     * 新規作成の操作ごとの冪等鍵。画面は1回の作成操作に1つだけ
     * 鍵を振り、同じ操作の再試行（ダブルクリック・通信やり直し）だけが
     * 同じ鍵を使う。鍵が無い呼び出しは「別の操作」と見分けられず、
     * 前の下書きへ戻って上書きする道が残るので、service 側で断る。
     */
    const body = await c.req.json<{ operationKey?: unknown; folderId?: unknown }>()
      .catch((): { operationKey?: unknown; folderId?: unknown } => ({}));
    return draftEndpoint(c, () => createAutomationDraftFromTemplate(c.env.DB, {
      templateKey: c.req.param('key'),
      lineAccountId: accountId,
      operationKey: body.operationKey,
      folderId: body.folderId,
      createdBy: c.get('staff')?.id,
    }), 201);
  },
);

automations.get(
  '/api/automation-drafts/:id',
  requireAutomationPermission,
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
    const accountId = await requireDraftAccount(c);
    if (typeof accountId !== 'string') return accountId;
    return draftEndpoint(c, async () => {
      const draft=await getAutomationDraft(c.env.DB,{id:c.req.param('id'),lineAccountId:accountId});
      const management=await readRestaurantFollowupResourceManagement(c.env.DB,'automation',[{id:draft.id,lineAccountId:accountId}]);
      return {...draft,...(management.has(draft.id)?{followupManagement:management.get(draft.id)}:{})};
    });
  },
);

automations.put(
  '/api/automation-drafts/:id',
  requireAutomationPermission,
  requireRole('owner', 'admin', 'staff'),
  inputJsonBoundary(), async (c) => {
    const accountId = await requireDraftAccount(c);
    if (typeof accountId !== 'string') return accountId;
    type DraftBody = {
      folderId?: unknown;
      expectedDraftVersionId?: unknown;
      name?: unknown;
      eventType?: unknown;
      triggerConfig?: unknown;
      conditions?: unknown;
      actions?: unknown;
    };
    const body = await c.req.json<DraftBody>().catch((): DraftBody => ({}));
    return draftEndpoint(c, async () => {
      // 中身が変わると札も変わる。画面が次の突き合わせに使えるよう返す。
      const saved = await updateAutomationDraft(c.env.DB, {
        id: c.req.param('id'),
        lineAccountId: accountId,
        expectedDraftVersionId: body.expectedDraftVersionId,
        name: body.name,
        folderId: body.folderId,
        eventType: body.eventType,
        triggerConfig: body.triggerConfig,
        conditions: body.conditions,
        actions: body.actions,
      });
      return { updated: true, draftVersionId: saved.draftVersionId };
    });
  },
);

automations.post(
  '/api/automation-drafts/:id/publish',
  requireAutomationPermission,
  requireRole('owner', 'admin'),
  inputJsonBoundary(), async (c) => {
    const accountId = await requireDraftAccount(c);
    if (typeof accountId !== 'string') return accountId;
    const body = await c.req.json<{ expectedDraftVersionId?: unknown; activate?: unknown; expectedStatus?: unknown }>()
      .catch((): { expectedDraftVersionId?: unknown; activate?: unknown; expectedStatus?: unknown } => ({}));
    return draftEndpoint(c, () => publishAutomationDraft(c.env.DB, {
      id: c.req.param('id'),
      lineAccountId: accountId,
      expectedDraftVersionId: body.expectedDraftVersionId,
      activate: body.activate,
      expectedStatus: body.expectedStatus,
    }));
  },
);

automations.get('/api/automations/counts', requireAutomationViewPermission, async (c) => {
  const accountId = await requireDraftAccount(c);
  if (accountId instanceof Response) return accountId;
  try {
    return c.json({ success: true, data: await automationTabCounts(c.env.DB, accountId) });
  } catch (err) {
    throw err;
  }
});

automations.get(
  '/api/automations',
  requireAutomationPermission,
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
  try {
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const requestedAccountId = (
      c.req.query('lineAccountId') ?? c.req.query('account_id')
    )?.trim();
    if (requestedAccountId && !scope.allowedAccountIds.includes(requestedAccountId)) {
      return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
    }
    const rawLimit = c.req.query('limit');
    const rawOffset = c.req.query('offset');
    const limit = rawLimit === undefined ? undefined : parseOffsetPaging({ limit: rawLimit }, { defaultLimit: -1, limitPolicy: { fallback: 'nonnegative-integer', maximum: 200 } }).limit;
    const offset = rawOffset === undefined ? undefined : parseOffsetPaging({ offset: rawOffset }, { defaultOffset: -1, offsetPolicy: { fallback: 'nonnegative-integer', maximum: 1_000_000 } }).offset;
    if ((rawLimit !== undefined && limit === -1) || (rawOffset !== undefined && offset === -1)) {
      return c.json({ success: false, error: 'ページ指定を確認してください' }, 400);
    }
    const result = await listAutomationDefinitions(
      c.env.DB,
      requestedAccountId ? [requestedAccountId] : scope.allowedAccountIds,
      { limit, offset, includeArchived: c.req.query('includeArchived') === '1' },
    );
    const styledItems = await withStyleSampleMetadata(c.env.DB,result.items,'automation');
    const management=await readRestaurantFollowupResourceManagement(c.env.DB,'automation',result.items.map(row=>({id:row.id,lineAccountId:row.lineAccountId})));
    const responseItems=styledItems.map(row=>({...row,...(management.has(row.id)?{followupManagement:management.get(row.id)}:{})}));
    return c.json(buildOffsetListResponse({ success: true,
      data: responseItems,
      summary: result.summary,
      freshness: result.freshness,
      pagination: {
        total: result.total,
        limit: limit ?? null,
        offset: offset ?? 0,
      }, items: responseItems, total: result.total, paging: { limit: limit ?? result.total, offset: offset ?? 0 }, sort: [{ field: 'priority', direction: 'desc' }, { field: 'updatedAt', direction: 'desc' }, { field: 'id', direction: 'desc' }] }));
  } catch (err) {
    throw err;
  }
});

automations.post(
  '/api/automations/:id/audience-preview',
  requireAutomationPermission,
  requireRole('owner', 'admin', 'staff'),
  inputJsonBoundary(), async (c) => {
    const accountId = await requireDraftAccount(c);
    if (typeof accountId !== 'string') return accountId;
    const body = await c.req.json<{ versionId?: unknown }>()
      .catch((): { versionId?: unknown } => ({}));
    return definitionEndpoint(c, () => previewAutomationAudience(c.env.DB, {
      automationId: c.req.param('id'),
      versionId: body.versionId,
      lineAccountId: accountId,
    }));
  },
);

automations.post(
  '/api/automations/:id/test',
  requireAutomationPermission,
  requireAutomationTestPermission,
  requireRole('owner', 'admin', 'staff'),
  inputJsonBoundary(), async (c) => {
    const accountId = await requireDraftAccount(c);
    if (typeof accountId !== 'string') return accountId;
    const body = await c.req.json<{
      versionId?: unknown; friendId?: unknown; operationKey?: unknown;
      expectedCommonActions?: unknown;
    }>().catch((): {
      versionId?: unknown; friendId?: unknown; operationKey?: unknown;
      expectedCommonActions?: unknown;
    } => ({}));
    return definitionEndpoint(c, () => runAutomationTest(c.env.DB, {
      automationId: c.req.param('id'),
      versionId: body.versionId,
      friendId: body.friendId,
      lineAccountId: accountId,
      credentialEncryptionKey: c.env.LINE_CREDENTIAL_ENCRYPTION_KEY,
      operatorMailEnv: c.env,
      operationKey: body.operationKey,
      // 確認時に見せた共通アクションの版の一式。食い違えば409で送らない。
      expectedCommonActions: body.expectedCommonActions,
    }));
  },
);

/** 25-1-B: 既存automation_runsを、共通実行記録契約で読む。 */
automations.get(
  '/api/automation-runs',
  requireAutomationViewPermission,
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
  try {
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const requestedAccountId = (
      c.req.query('line_account_id') ?? c.req.query('lineAccountId')
    )?.trim();
    if (requestedAccountId && !scope.allowedAccountIds.includes(requestedAccountId)) {
      return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
    }
    const allowedAccountIds = requestedAccountId ? [requestedAccountId] : scope.allowedAccountIds;
    const rawStatus = c.req.query('status') as ExecutionRunStatus | 'executed' | 'problems' | undefined;
    const status = rawStatus === 'executed'
      ? ['success', 'partial', 'failed'] as AutomationRunDomainStatus[]
      : rawStatus === 'problems'
        ? ['partial', 'failed'] as AutomationRunDomainStatus[]
        : rawStatus && COMMON_STATUS_TO_DOMAIN[rawStatus]
          ? COMMON_STATUS_TO_DOMAIN[rawStatus]
          : undefined;
    const wantsCsv = c.req.query('format') === 'csv';
    if (wantsCsv) {
      // §9: CSV書き出しは個別権限 `automation.run.export`。
      // 見るだけの権限（/automations）では出せない。
      const staff = c.get('staff');
      if (staff.role === 'staff' && !staff.permissionKeys?.includes('automation.run.export')) {
        return c.json({ success: false, error: '実行記録を書き出す権限がありません' }, 403);
      }
    }
    // CSVは画面の1頁ではなく絞り込み全体を出す。暴走だけ上限で留める。
    const limit = wantsCsv
      ? 5_000
      : parseOffsetPaging({ limit: c.req.query('limit') }, { defaultLimit: 20, limitPolicy: { fallback: 'nonnegative-integer', minimum: 1, maximum: 100 } }).limit;
    const offset = wantsCsv ? 0 : parseOffsetPaging({ offset: c.req.query('offset') }, { offsetPolicy: { fallback: 'nonnegative-integer', maximum: 1_000_000 } }).offset;
    const defaults = defaultWindow();
    const from = c.req.query('from') || defaults.from;
    const to = c.req.query('to') || defaults.to;
    // テスト実行は既定で除き、切替のときだけ含める（25-1-B）。
    const includeTest = c.req.query('include_test') === '1' || c.req.query('include_test') === 'true';

    const result = await getAutomationExecutionRuns(c.env.DB, {
      allowedAccountIds,
      from,
      to,
      status,
      search: c.req.query('search'),
      includeTest,
      limit,
      offset,
    });

    // 運用停止・機能無効で動けない実行に、その理由を付ける。
    const holdReasons = await holdReasonByAccount(c.env.DB, result.rows);
    const items: AutomationExecutionRun[] = result.rows.map(
      (row) => mapExecutionRun(row, holdReasons.get(row.line_account_id) ?? null),
    );
    if (wantsCsv) {
      c.set('outputAudit', { count: items.length, accountIds: allowedAccountIds, accountCounts: Object.fromEntries(allowedAccountIds.map(id => [id, items.filter(item => item.lineAccountId === id).length])) });
      /*
       * 上限5,000件で切れたことを黙らせない。総件数と出力件数を
       * 応答の頭に載せ、切れたかどうかを使い手へ知らせる（画面が読む）。
       */
      return new Response(executionRunsCsv(items), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="automation-runs.csv"',
          'X-Csv-Total-Count': String(result.total),
          'X-Csv-Returned-Count': String(items.length),
          'X-Csv-Truncated': result.total > items.length ? '1' : '0',
        },
      });
    }
    const body: AutomationExecutionRunsResponse = {
      summary: {
        total: result.summary.total,
        executed: result.summary.executed,
        skipped: result.summary.skipped,
        failed: result.summary.failed,
        mostRunName: result.summary.most_run_name,
        mostRunCount: result.summary.most_run_count,
      },
      items,
      pagination: { total: result.total, limit, offset },
    };
    return c.json({ success: true, data: buildOffsetListResponse({ ...body, total: result.total, paging: { limit, offset }, sort: [{ field: 'occurredAt', direction: 'desc' }, { field: 'id', direction: 'desc' }] }) });
  } catch (err) {
    throw err;
  }
});

automations.post(
  '/api/automation-runs/:id/retry',
  requireAutomationPermission,
  requireAutomationRetryPermission,
  requireRole('owner', 'admin', 'staff'),
  inputJsonBoundary(), async (c) => {
    try {
      const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
      const prepared = await retryAutomationRun(c.env.DB, {
        runId: c.req.param('id'),
        allowedAccountIds: scope.allowedAccountIds,
      });
      // 実行完了を待たず受け付けだけ返す。実行は既存5分cronの
      // processDueAutomationRuns が拾う(retry は resume_at=now を入れる)。
      // 新規 queue・migration・waitUntil は作らない。
      return c.json({
        success: true,
        data: {
          ...prepared,
          notice: '再実行を受け付けました。結果は実行記録で確認してください',
        },
      }, 202);
    } catch (error) {
      if (error instanceof AutomationRunRetryError) {
        const status = error.code === 'not_found' ? 404 : 409;
        return inputError(c, { success: false, error: error.message, code: error.code }, status, []);
      }
      throw error;
    }
  },
);

/**
 *  1件の実行記録の詳細。
 *
 * 版番号・テスト実行の印・処理ごとの結果（状態と試行数）を返す。
 * step の input/output は友だちの情報を含みうるため出さない。
 */
automations.get(
  '/api/automation-runs/:id',
  requireAutomationViewPermission,
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
    try {
      const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
      const row = await getAutomationExecutionRun(c.env.DB, {
        runId: c.req.param('id'),
        allowedAccountIds: scope.allowedAccountIds,
      });
      if (!row) return c.json({ success: false, error: '実行記録が見つかりません' }, 404);
      const holdReasons = await holdReasonByAccount(c.env.DB, [row]);
      const steps = await getAutomationExecutionRunSteps(c.env.DB, row.id);
      return c.json({
        success: true,
        data: {
          ...mapExecutionRun(row, holdReasons.get(row.line_account_id) ?? null),
          steps: steps.map((step) => ({
            stepKey: step.step_key,
            actionType: step.action_type,
            actionLabel: automationActionLabel(step.action_type),
            status: step.status,
            attemptNumber: Number(step.attempt_number),
            errorCode: step.error_code,
            // 生の error_message ではなく、画面と同じ言い方に揃える。
            errorMessage: step.error_code
              ? safeFailureReason(step.error_code, automationActionLabel(step.action_type))
              : null,
            commonActionVersionId: step.common_action_version_id,
            startedAt: step.started_at,
            completedAt: step.completed_at,
          })),
        },
      });
    } catch (err) {
      throw err;
    }
  },
);

/**
 *  実行の取りやめ。
 *
 * 待機中・実行中・再試行待ちの実行を cancelled で閉じる。
 * 終わった実行は 409、無い・範囲外は 404、取消済みはそのまま成功。
 * §9: 取り消しは再実行と同じ `automation.run.retry` の個別権限。
 */
automations.post(
  '/api/automation-runs/:id/cancel',
  requireAutomationPermission,
  requireAutomationRetryPermission,
  requireRole('owner', 'admin', 'staff'),
  inputJsonBoundary(), async (c) => {
    try {
      const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
      const result = await cancelAutomationRun(c.env.DB, {
        runId: c.req.param('id'),
        allowedAccountIds: scope.allowedAccountIds,
      });
      return c.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof AutomationRunCancelError) {
        const status = error.code === 'not_found' ? 404 : 409;
        return inputError(c, { success: false, error: error.message, code: error.code }, status, []);
      }
      throw error;
    }
  },
);

automations.use('/api/automations/:id', requireVisibleAutomation);
automations.use('/api/automations/:id/*', requireVisibleAutomation);

/** 定義のアカウントを引く（requireVisibleAutomation が範囲を確かめ済み）。 */
async function definitionAccountId(c: Context<Env>): Promise<string | Response> {
  const row = await c.env.DB.prepare(
    `SELECT line_account_id FROM automation_definitions WHERE id = ?`,
  ).bind(c.req.param('id')).first<{ line_account_id: string }>();
  if (!row) {
    return c.json({ success: false, error: 'オートメーションが見つかりません' }, 404);
  }
  return row.line_account_id;
}

/**  一覧の「編集」。公開済みの定義に改訂用の下書きをぶら下げる。 */
automations.post(
  '/api/automations/:id/draft',
  requireAutomationPermission,
  requireRole('owner', 'admin', 'staff'),
  inputJsonBoundary(), async (c) => {
    const accountId = await definitionAccountId(c);
    if (typeof accountId !== 'string') return accountId;
    return draftEndpoint(c, () => createAutomationDraftFromDefinition(c.env.DB, {
      id: c.req.param('id'),
      lineAccountId: accountId,
      createdBy: c.get('staff')?.id,
    }), 201);
  },
);

/**  一覧の「複製」。いま見えている版を写した新しい下書きを作る。 */
automations.post(
  '/api/automations/:id/duplicate',
  requireAutomationPermission,
  requireRole('owner', 'admin', 'staff'),
  inputJsonBoundary(), async (c) => {
    const accountId = await definitionAccountId(c);
    if (typeof accountId !== 'string') return accountId;
    return draftEndpoint(c, () => duplicateAutomationDefinition(c.env.DB, {
      id: c.req.param('id'),
      lineAccountId: accountId,
      createdBy: c.get('staff')?.id,
    }), 201);
  },
);

/**
 *  一覧の稼働切替と「保管」。
 *
 * body は `{ status: 'active' | 'stopped' | 'archived' }`。
 * 保管から戻せる。戻すだけでは動かさず、実行記録は残る。
 */
automations.post(
  '/api/automations/:id/status',
  requireAutomationPermission,
  requireRole('owner', 'admin'),
  inputJsonBoundary(), async (c) => {
    const accountId = await definitionAccountId(c);
    if (typeof accountId !== 'string') return accountId;
    const body = await c.req.json<{ status?: unknown; expectedConfirmationRevision?: unknown }>()
      .catch((): { status?: unknown; expectedConfirmationRevision?: unknown } => ({}));
    const status = body.status;
    if (body.expectedConfirmationRevision !== undefined && (!Number.isSafeInteger(body.expectedConfirmationRevision) || (body.expectedConfirmationRevision as number) < 1)) {
      return inputError(c, { success: false, error: '確認した版が不正です' }, 400, ['expectedConfirmationRevision']);
    }
    if (status !== 'active' && status !== 'stopped' && status !== 'archived') {
      return inputError(c, {
        success: false,
        error: 'status は active / stopped / archived のどれかで送ってください',
      }, 400, ["status"]);
    }
    try {
      return c.json({ success: true, data: await updateAutomationDefinitionStatus(c.env.DB, {
        id: c.req.param('id'),
        lineAccountId: accountId,
        status,
        expectedConfirmationRevision: body.expectedConfirmationRevision as number | undefined,
      }) });
    } catch (error) {
      if (error instanceof AutomationDefinitionError && error.code === 'version_conflict') {
        const current = await c.env.DB.prepare('SELECT id, status, confirmation_revision AS confirmationRevision FROM automation_definitions WHERE id = ? AND line_account_id = ?')
          .bind(c.req.param('id'), accountId).first();
        return c.json({ success: false, code: error.code, error: error.message, current }, 409);
      }
      if (error instanceof AutomationDefinitionError) return definitionErrorResponse(c, error);
      throw error;
    }
  },
);

automations.post('/api/automations/:id/restore', requireAutomationPermission, requireRole('owner', 'admin', 'staff'), denyReadOnly(), async (c) => {
  const accountId = await definitionAccountId(c);
  if (typeof accountId !== 'string') return accountId;
  const requested = c.req.query('lineAccountId') ?? c.req.query('account_id');
  if (requested && requested !== accountId) return c.json({ success: false, error: 'ルールが見つかりません' }, 404);
  return definitionEndpoint(c, () => restoreAutomationDefinition(c.env.DB, { id: c.req.param('id'), lineAccountId: accountId }));
});

// 詳細・ログは一覧より機微度が高い（friendId・eventDataを含む）ため、
// アカウント範囲の検査に加えて機能の権限キー検査も直接付ける。
automations.get(
  '/api/automations/:id',
  requireAutomationPermission,
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
  try {
    const item = await getAutomationById(c.env.DB, c.req.param('id'));
    if (!item) return fail(c, 404, 'AUTOMATION_NOT_FOUND');

    // ログも取得
    const logs = await getAutomationLogs(c.env.DB, item.id, 50);

    return c.json({
      success: true,
      data: {
        id: item.id,
        name: item.name,
        description: item.description,
        eventType: item.event_type,
        conditions: JSON.parse(item.conditions),
        actions: JSON.parse(item.actions),
        isActive: Boolean(item.is_active),
        priority: item.priority,
        lineAccountId: item.line_account_id ?? null,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        logs: logs.map((l) => ({
          id: l.id,
          friendId: l.friend_id,
          eventData: l.event_data ? JSON.parse(l.event_data) : null,
          actionsResult: l.actions_result ? JSON.parse(l.actions_result) : null,
          status: l.status,
          createdAt: l.created_at,
        })),
      },
    });
  } catch (err) {
    throw err;
  }
});

// 旧CRUDの作成口は削除済み（ 点検中6）。
// 旧 `automations` 表へ検証なしで直書きし、一覧・実行基盤が読む
// `automation_definitions` 系と不整合を起こすうえ、唯一の呼び元だった
// 画面内蔵フォームは到達不能だった。作成は下書き→公開の流れを使う。
// 稼働切替・削除で使う PUT・DELETE は残す。
// 旧 PUT の受理は isActive boolean だけに絞る。唯一の呼び元は
// 稼働切替の { isActive } で、eventType/actions を送る画面経路はない。
// 未知キー・空 body・型違いは黙って無視せず 400 で拒否する。
function parseAutomationToggle(body: unknown): { ok: true; isActive: boolean } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'isActive を true か false で送ってください' };
  }
  const keys = Object.keys(body);
  if (keys.length === 0) {
    return { ok: false, error: 'isActive を true か false で送ってください' };
  }
  const unknown = keys.filter((key) => key !== 'isActive');
  if (unknown.length > 0) {
    return { ok: false, error: `isActive 以外の項目は送れません: ${unknown.join(', ')}` };
  }
  const isActive = (body as Record<string, unknown>).isActive;
  if (typeof isActive !== 'boolean') {
    return { ok: false, error: 'isActive は true か false で送ってください' };
  }
  return { ok: true, isActive };
}

automations.put('/api/automations/:id', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => undefined);
    const toggle = parseAutomationToggle(body);
    if (!toggle.ok) return inputError(c, { success: false, error: toggle.error }, 400, ['isActive']);
    await updateAutomation(c.env.DB, id, { isActive: toggle.isActive });
    const updated = await getAutomationById(c.env.DB, id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: updated.id,
        name: updated.name,
        eventType: updated.event_type,
        conditions: JSON.parse(updated.conditions),
        actions: JSON.parse(updated.actions),
        isActive: Boolean(updated.is_active),
        priority: updated.priority,
        lineAccountId: updated.line_account_id ?? null,
      },
    });
  } catch (err) {
    throw err;
  }
});

automations.delete('/api/automations/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    await deleteAutomation(c.env.DB, c.req.param('id'));
    return c.json({ success: true, data: null });
  } catch (err) {
    throw err;
  }
});

// ========== 自動化ログ ==========

automations.get(
  '/api/automations/:id/logs',
  requireAutomationPermission,
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
  try {
    const automationId = c.req.param('id');
    const limit = parseOffsetPaging({ limit: c.req.query('limit') }, { defaultLimit: 100 }).limit;
    const logs = await getAutomationLogs(c.env.DB, automationId, limit);
    const responseItems = logs.map((l) => ({
        id: l.id,
        automationId: l.automation_id,
        friendId: l.friend_id,
        eventData: l.event_data ? JSON.parse(l.event_data) : null,
        actionsResult: l.actions_result ? JSON.parse(l.actions_result) : null,
        status: l.status,
        createdAt: l.created_at,
      }));
    return c.json(buildOffsetListResponse({ success: true, data: responseItems, items: responseItems, total: null, paging: { limit, offset: 0 }, sort: [] }));
  } catch (err) {
    throw err;
  }
});

export { automations };
