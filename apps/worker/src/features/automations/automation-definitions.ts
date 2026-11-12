import { readFollowupEngineGate } from '../../services/restaurant-followup-engine-approval.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { processAutomationRun, resolveCommonActionVersion, startAutomationRun, type ActionDefinition } from './automation-engine.js';
import { type RunStatus } from './run-types.js';
import {
  automationRevisionToken,
  parseAutomationRevision,
  type AutomationVersionContent,
} from './automation-drafts.js';
import { createAutomationActionExecutors } from './automation-action-executors.js';
import { buildSegmentWhere, parseCondition } from '../../services/segment-query.js';
import { type SegmentCondition } from '@line-crm/shared';

export class AutomationDefinitionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'AutomationDefinitionError';
  }
}

interface DefinitionListRow {
  id: string;
  folder_id: string | null;
  line_account_id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'stopped' | 'archived';
  priority: number;
  version_id: string;
  version_number: number;
  trigger_type: string;
  trigger_config: string;
  condition_config: string;
  action_config: string;
  execution_count_30d: number;
  failure_count_30d: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  confirmation_revision: number;
}

export interface AutomationDefinitionSummary {
  id: string;
  folderId: string | null;
  name: string;
  description: string | null;
  eventType: string;
  triggerConfig: Record<string, unknown>;
  conditions: Record<string, unknown>;
  actions: unknown[];
  isActive: boolean;
  status: DefinitionListRow['status'];
  priority: number;
  lineAccountId: string;
  versionId: string;
  version: number;
  confirmationRevision: number;
  executionCount30d: number;
  failureCount30d: number;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function parseRecord(raw: string, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // 下で保存データ不整合へ揃える。
  }
  throw new AutomationDefinitionError('stored_data_invalid', `${label}を読み込めませんでした`);
}

function parseArray(raw: string, label: string): unknown[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) return value;
  } catch {
    // 下で保存データ不整合へ揃える。
  }
  throw new AutomationDefinitionError('stored_data_invalid', `${label}を読み込めませんでした`);
}

export async function listAutomationDefinitions(
  db: D1Database,
  lineAccountIds: string[],
  paging?: { limit?: number; offset?: number; includeArchived?: boolean },
): Promise<{
  items: AutomationDefinitionSummary[];
  total: number;
  summary: { active: number; stopped: number; executionCount30d: number; failureCount30d: number };
  freshness: 'available';
}> {
  const emptySummary = { active: 0, stopped: 0, executionCount30d: 0, failureCount30d: 0 };
  if (lineAccountIds.length === 0) {
    return { items: [], total: 0, summary: emptySummary, freshness: 'available' };
  }
  const placeholders = sqlIdSet(lineAccountIds).sql;
  // 集計はページ送りに依らず対象アカウント全体で数える（一覧のKPIと一致させる）。
  const [totalRow, statusRows, runTotals] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS count FROM automation_definitions d
        WHERE d.line_account_id IN (${placeholders}) ${paging?.includeArchived ? '' : "AND d.status <> 'archived'"}`,
    ).bind(...(lineAccountIds.length ? sqlIdSet(lineAccountIds).binds : [])).first<{ count: number }>(),
    db.prepare(
      `SELECT d.status AS status, COUNT(*) AS count FROM automation_definitions d
        WHERE d.line_account_id IN (${placeholders}) ${paging?.includeArchived ? '' : "AND d.status <> 'archived'"}
        GROUP BY d.status`,
    ).bind(...(lineAccountIds.length ? sqlIdSet(lineAccountIds).binds : [])).all<{ status: string; count: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS executions,
              SUM(CASE WHEN r.status IN ('partial', 'failed') THEN 1 ELSE 0 END) AS failures
         FROM automation_runs r
         JOIN automation_definitions d ON d.id = r.automation_id
        WHERE d.line_account_id IN (${placeholders}) ${paging?.includeArchived ? '' : "AND d.status <> 'archived'"}
          AND r.is_test = 0 AND r.status IN ('success', 'partial', 'failed')
          AND datetime(r.created_at) >= datetime('now', '-30 days')`,
    ).bind(...(lineAccountIds.length ? sqlIdSet(lineAccountIds).binds : [])).first<{ executions: number; failures: number | null }>(),
  ]);
  const limit = paging?.limit === undefined ? null
    : Math.max(1, Math.min(Math.floor(paging.limit), 200));
  const offset = paging?.offset === undefined ? 0
    : Math.max(0, Math.floor(paging.offset));
  const result = await db.prepare(
    `SELECT d.id, d.folder_id, d.line_account_id, d.name, d.description, d.status, d.priority, d.confirmation_revision,
            v.id AS version_id, v.version_number, v.trigger_type, v.trigger_config,
            v.condition_config, v.action_config,
            (SELECT COUNT(*) FROM automation_runs r
              WHERE r.automation_id = d.id AND r.is_test = 0
                AND r.status IN ('success', 'partial', 'failed')
                AND datetime(r.created_at) >= datetime('now', '-30 days')) AS execution_count_30d,
            (SELECT COUNT(*) FROM automation_runs r
              WHERE r.automation_id = d.id AND r.is_test = 0
                AND r.status IN ('partial', 'failed')
                AND datetime(r.created_at) >= datetime('now', '-30 days')) AS failure_count_30d,
            (SELECT MAX(r.created_at) FROM automation_runs r
              WHERE r.automation_id = d.id AND r.is_test = 0) AS last_run_at,
            d.created_at, d.updated_at
       FROM automation_definitions d
       JOIN automation_versions v
         ON v.id = CASE
              WHEN d.status = 'draft' THEN d.current_draft_version_id
              WHEN d.status = 'archived' THEN COALESCE(d.current_published_version_id, d.current_draft_version_id)
              ELSE d.current_published_version_id
            END
        AND v.automation_id = d.id
      WHERE d.line_account_id IN (${placeholders}) ${paging?.includeArchived ? '' : "AND d.status <> 'archived'"}
      ORDER BY d.priority DESC, d.updated_at DESC, d.id DESC${limit === null ? '' : ' LIMIT ? OFFSET ?'}`,
  ).bind(...(lineAccountIds.length ? sqlIdSet(lineAccountIds).binds : []), ...(limit === null ? [] : [limit, offset])).all<DefinitionListRow>();
  const items = (result.results ?? []).map((row): AutomationDefinitionSummary => ({
    id: row.id,
    folderId: row.folder_id ?? null,
    name: row.name,
    description: row.description,
    eventType: row.trigger_type,
    triggerConfig: parseRecord(row.trigger_config, 'きっかけ'),
    conditions: parseRecord(row.condition_config, '対象条件'),
    actions: parseArray(row.action_config, '処理'),
    isActive: row.status === 'active',
    status: row.status,
    priority: Number(row.priority),
    lineAccountId: row.line_account_id,
    versionId: row.version_id,
    version: Number(row.version_number),
    confirmationRevision: row.confirmation_revision,
    executionCount30d: Number(row.execution_count_30d),
    failureCount30d: Number(row.failure_count_30d),
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  const statusCount = new Map((statusRows.results ?? []).map((row) => [row.status, Number(row.count)]));
  return {
    items,
    total: Number(totalRow?.count ?? items.length),
    summary: {
      active: statusCount.get('active') ?? 0,
      stopped: statusCount.get('stopped') ?? 0,
      executionCount30d: Number(runTotals?.executions ?? 0),
      failureCount30d: Number(runTotals?.failures ?? 0),
    },
    freshness: 'available',
  };
}

interface SelectedVersion extends AutomationVersionContent {
  automation_id: string;
  version_id: string;
}

/**
 * 画面が持っている札（`<版の行のid>.<中身の指紋>`）で版を選ぶ。
 *
 * `requireFingerprint` を立てると、**指紋の無い札を受け取らない**。
 * 送信のように取り消せない口では、中身まで確かめられない札を通すと、
 * 守っているつもりの穴がそのまま残る。
 */
async function requireCurrentVersion(
  db: D1Database,
  input: { automationId: string; versionId: unknown; lineAccountId: string },
  options: { requireFingerprint?: boolean } = {},
): Promise<SelectedVersion> {
  if (typeof input.versionId !== 'string' || !input.versionId.trim()) {
    throw new AutomationDefinitionError('required', '確認する版を選んでください', 'versionId');
  }
  const definition = await db.prepare(
    `SELECT id, current_draft_version_id, current_published_version_id
       FROM automation_definitions
      WHERE id = ? AND line_account_id = ?`,
  ).bind(input.automationId, input.lineAccountId).first<{
    id: string;
    current_draft_version_id: string | null;
    current_published_version_id: string | null;
  }>();
  if (!definition) throw new AutomationDefinitionError('not_found', 'オートメーションが見つかりません');
  const requested = parseAutomationRevision(input.versionId);
  if (options.requireFingerprint && !requested.fingerprint) {
    throw new AutomationDefinitionError('version_conflict', '送る内容を確認し直してください', 'versionId');
  }
  const versionId = requested.versionId;
  if (![definition.current_draft_version_id, definition.current_published_version_id].includes(versionId)) {
    throw new AutomationDefinitionError('version_conflict', '確認中の版が変わりました。再読み込みしてください');
  }
  const version = await db.prepare(
    `SELECT automation_id, id AS version_id,
            trigger_type, trigger_config, condition_config, action_config
       FROM automation_versions
      WHERE id = ? AND automation_id = ?`,
  ).bind(versionId, definition.id).first<SelectedVersion>();
  if (!version) throw new AutomationDefinitionError('not_found', '指定した版が見つかりません');
  // 版の行のidは中身を書き換えても変わらない。**指紋まで見て初めて、
  // 確認したときの中身と同じかどうかが分かる。**
  if (requested.fingerprint
    && await automationRevisionToken(versionId, version) !== `${versionId}.${requested.fingerprint}`) {
    throw new AutomationDefinitionError(
      'version_conflict', '確認したあとに下書きが変わりました。もう一度、送る内容を確認してください',
    );
  }
  return version;
}

/**
 * 確認画面で見せた共通アクションの版の一式を、実行前のいま解決される版と
 * 照合する。
 *
 * - 下書きに共通アクションが無いときは `null`（照合なし）。
 * - 共通アクションがあるのに照合用の一式が来ていない・形が違うときは、
 *   確認していない版を送る恐れがあるので 409 で止める。
 * - 1件でも解決版と食い違えば同じく 409。送る前なので副作用はない。
 */
async function checkExpectedCommonActions(
  db: D1Database,
  input: {
    lineAccountId: string;
    automationId: string;
    actionConfig: string;
    expected: unknown;
  },
): Promise<Map<string, string> | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.actionConfig);
  } catch {
    parsed = null;
  }
  const steps = Array.isArray(parsed)
    ? parsed.filter((step): step is ActionDefinition =>
        typeof step === 'object' && step !== null
        && (step as { type?: unknown }).type === 'common_action')
    : [];
  if (steps.length === 0) return null;
  const expectedByStep = new Map<string, { commonActionId: string; versionId: string }>();
  if (Array.isArray(input.expected)) {
    for (const entry of input.expected) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { stepId, commonActionId, versionId } = entry as Record<string, unknown>;
      if (typeof stepId === 'string' && typeof commonActionId === 'string'
        && typeof versionId === 'string' && stepId && commonActionId && versionId) {
        expectedByStep.set(stepId, { commonActionId, versionId });
      }
    }
  }
  const resolvedByStep = new Map<string, string>();
  for (const step of steps) {
    const expectedForStep = expectedByStep.get(step.id);
    const resolved = await resolveCommonActionVersion(db, {
      lineAccountId: input.lineAccountId,
      automationId: input.automationId,
      action: step,
    });
    const stepCommonActionId = typeof step.params.commonActionId === 'string'
      ? step.params.commonActionId
      : '';
    if (!expectedForStep || !resolved
      || expectedForStep.commonActionId !== stepCommonActionId
      || expectedForStep.versionId !== resolved) {
      throw new AutomationDefinitionError(
        'version_conflict',
        '確認したあとに共通アクションの版が変わりました。送っていません。もう一度、送る内容を確認してください',
        'versionId',
      );
    }
    resolvedByStep.set(step.id, resolved);
  }
  return resolvedByStep;
}

/**
 * 実行計画に焼き付いた共通アクション版（`common_action_marker` 段の
 * `common_action_version_id`）が、確認時と同じかを見る。照合のあと・
 * 焼き付けの前に束が切り替わった最後の隙間をここで閉じる。
 * 版の中身に入れ子で書き込まれた呼び出しは、版ごと不変なので対象外
 * （step_key に `/` が入る段はスキップ）。
 */
async function runStepsMatchExpectedCommonActions(
  db: D1Database,
  runId: string,
  expected: Map<string, string> | null,
): Promise<boolean> {
  if (!expected) return true;
  const markers = await db.prepare(
    `SELECT step_key, common_action_version_id
       FROM automation_run_steps
      WHERE automation_run_id = ? AND action_type = 'common_action_marker'`,
  ).bind(runId).all<{ step_key: string; common_action_version_id: string | null }>();
  for (const marker of markers.results ?? []) {
    if (marker.step_key.includes('/')) continue;
    if (expected.get(marker.step_key) !== marker.common_action_version_id) return false;
  }
  return true;
}

/** 版の中身が、読んだときのままかを見る。1文字でも違えば当たらない。 */
async function versionContentUnchanged(
  db: D1Database,
  version: SelectedVersion,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS ok FROM automation_versions
      WHERE id = ? AND automation_id = ?
        AND trigger_type = ? AND trigger_config = ?
        AND condition_config = ? AND action_config = ?`,
  ).bind(
    version.version_id, version.automation_id,
    version.trigger_type, version.trigger_config,
    version.condition_config, version.action_config,
  ).first<{ ok: number }>();
  return !!row;
}

/**
 * 送る前に取りやめる。
 *
 * **実行記録は消せない。** `packages/db/bootstrap.sql` の
 * `trg_automation_runs_no_delete` / `trg_automation_run_steps_no_delete` が
 * 削除を禁じている（履歴を消さないという決めごと）。だから取りやめは
 * 「送らずに取消として閉じる」形にする。
 */
async function cancelAutomationRunBeforeSend(db: D1Database, runId: string): Promise<void> {
  await db.prepare(
    `UPDATE automation_runs
        SET status = 'cancelled', completed_at = ?, resume_at = NULL, lease_expires_at = NULL
      WHERE id = ? AND status IN ('queued', 'skipped_condition')`,
  ).bind(new Date().toISOString(), runId).run();
}

function targetCondition(raw: string): SegmentCondition | null {
  const object = parseRecord(raw, '対象条件');
  if (Object.keys(object).length === 0) return null;
  const condition = parseCondition(raw);
  if (!condition) throw new AutomationDefinitionError('condition_invalid', '対象条件を確認してください', 'conditions');
  return condition;
}

export async function previewAutomationAudience(
  db: D1Database,
  input: { automationId: string; versionId: unknown; lineAccountId: string },
): Promise<{
  automationId: string;
  versionId: string;
  matched: number;
  total: number;
  freshness: 'available';
  calculatedAt: string;
}> {
  const version = await requireCurrentVersion(db, input);
  const condition = targetCondition(version.condition_config);
  const where = condition ? buildSegmentWhere(condition) : { sql: '1=1', bindings: [] as unknown[] };
  const [matched, total] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS count FROM friends f
        WHERE f.line_account_id = ? AND (${where.sql})`,
    ).bind(input.lineAccountId, ...where.bindings).first<{ count: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS count FROM friends WHERE line_account_id = ?`,
    ).bind(input.lineAccountId).first<{ count: number }>(),
  ]);
  return {
    automationId: input.automationId,
    versionId: version.version_id,
    matched: Number(matched?.count ?? 0),
    total: Number(total?.count ?? 0),
    freshness: 'available',
    calculatedAt: new Date().toISOString(),
  };
}

export async function runAutomationTest(
  db: D1Database,
  input: {
    automationId: string;
    versionId: unknown;
    friendId: unknown;
    lineAccountId: string;
    credentialEncryptionKey?: string;
    /** 担当者通知の送達に使う環境（メール経路用）。 */
    operatorMailEnv?: import('../../worker-env.js').Env['Bindings'];
    /**
     * 同じ確認画面の操作を識別する鍵。確認を開くたびに画面が振る。
     * 応答が失われたあとの再試行は同じ鍵で来るので、2件目の実行を作らず
     * 初回の実行を返す。鍵が無い・形が違う呼び出しは古い画面と見て、
     * 従来どおり新しい実行を作る。
     */
    operationKey?: unknown;
    /**
     * 監査 : 確認画面で出した「この共通アクションはこの版を使う」の一式。
     * 下書きの版と指紋は束の切り替えを検知できないため、確認後に別担当が
     * 利用版を切り替えると、確認していない新版が送られてしまう。
     * 下書きに共通アクションを含むときは必須とし、1件でも解決版と
     * 食い違えば 409 で送らない。
     */
    expectedCommonActions?: unknown;
  },
): Promise<{ runId: string; versionId: string; status: RunStatus | 'busy' }> {
  /*
   * 1人テストは**取り消せない実送信**なので、確認した中身と1文字でも違えば
   * 送らない。守りは2段。
   *
   *   1. 入口で、札の指紋と DB のいまの中身を突き合わせる（`requireFingerprint`）。
   *      ここで違えば、実行記録すら作らずに 409 で返す（副作用0）。
   *   2. 実行計画を固めたあと・送る前に、もう一度中身を見る。`startAutomationRun`
   *      は自分でもう一度 `action_config` を読んで `execution_plan_json` に
   *      焼き付けるので、1 の後・その読み取りの前に割り込まれると、
   *      確認していない中身が焼き付く。**送る前に気づいて記録ごと捨てる。**
   *
   * ただし 2 は最後の網であって、主役ではない。**主役は版を不変にしたこと**で、
   * `updateAutomationDraft` は同じ行を書き換えず、新しい版の行を作って
   * `current_draft_version_id` を差し替える（`automation-drafts.ts`）。
   * `startAutomationRun` は `v.id IN (現在の下書き, 現在の公開)` を満たす版しか
   * 拾わないので、割り込みの保存が入った瞬間にこの札の版は外れ、
   * **実行記録を1行も作らずに** `not_active` で戻る。CAS が実行記録を作る文の
   * 中にある、という形はこれで満たされる。
   *
   * 2 に当たるのは、アプリを通さずDBを直接書き換えた場合だけである。
   * そのときは送らずに取消として閉じる（実行記録は消せない。理由は
   * `cancelAutomationRunBeforeSend` の注釈）。
   */
  const version = await requireCurrentVersion(db, input, { requireFingerprint: true });
  if((await readFollowupEngineGate(db,{engine:'automation',targetId:input.automationId,lineAccountId:input.lineAccountId,versionId:version.version_id})).managed)
    throw new AutomationDefinitionError('version_conflict','来店フォローの試し送りは、専用画面から登録済みのテスト送信先へ行ってください');

  /*
   * 確認時に見せた共通アクションの版が、いま解決される版と同じか。
   * 束の切り替えは下書きの版・指紋を変えないので、ここで別に照合する。
   * 「確認した版と違う」「照合用の一式が来ていない」ときは送らない。
   */
  const expectedCommonActions = await checkExpectedCommonActions(db, {
    lineAccountId: input.lineAccountId,
    automationId: input.automationId,
    actionConfig: version.action_config,
    expected: input.expectedCommonActions,
  });
  if (typeof input.friendId !== 'string' || !input.friendId.trim()) {
    throw new AutomationDefinitionError('required', 'テストする友だちを選んでください', 'friendId');
  }
  const friendId = input.friendId.trim();
  const friend = await db.prepare(
    `SELECT id FROM friends WHERE id = ? AND line_account_id = ?`,
  ).bind(friendId, input.lineAccountId).first<{ id: string }>();
  if (!friend) throw new AutomationDefinitionError('not_found', 'テストする友だちが見つかりません');
  const condition = targetCondition(version.condition_config);
  const where = condition ? buildSegmentWhere(condition) : { sql: '1=1', bindings: [] as unknown[] };
  const match = await db.prepare(
    `SELECT 1 AS ok FROM friends f
      WHERE f.id = ? AND f.line_account_id = ? AND (${where.sql}) LIMIT 1`,
  ).bind(friendId, input.lineAccountId, ...where.bindings).first<{ ok: number }>();
  /*
   * 同じ確認の再試行は同じ鍵で来る。先に初回の実行を探し、
   * あれば作らずにそれを返す（副作用は1件のまま）。
   * 応答が届く前に止まった再試行（まだ queued/waiting）もここで拾うので、
   * 作り直して二重に送ることはない。
   */
  const operationKey = typeof input.operationKey === 'string' ? input.operationKey.trim() : '';
  const idempotencyKey = /^[A-Za-z0-9._-]{8,128}$/.test(operationKey)
    ? `manual-test:${operationKey}`
    : `manual-test:${crypto.randomUUID()}`;
  const previous = await db.prepare(
    `SELECT id, status, automation_version_id
       FROM automation_runs
      WHERE line_account_id = ? AND automation_id = ? AND idempotency_key = ?`,
  ).bind(input.lineAccountId, input.automationId, idempotencyKey).first<{
    id: string;
    status: RunStatus;
    automation_version_id: string;
  }>();
  if (previous) {
    // 同じ鍵で版が違う＝確認したときと中身が違う。送らずに競合で返す。
    if (previous.automation_version_id !== version.version_id) {
      throw new AutomationDefinitionError(
        'version_conflict', '確認したあとに下書きが変わりました。送っていません。もう一度、送る内容を確認してください',
      );
    }
    return { runId: previous.id, versionId: previous.automation_version_id, status: previous.status };
  }
  const started = await startAutomationRun(db, {
    lineAccountId: input.lineAccountId,
    automationId: input.automationId,
    automationVersionId: version.version_id,
    sourceEventId: idempotencyKey,
    idempotencyKey,
    friendId,
    inputEvent: { type: 'manual_test' },
    conditionMatched: !!match,
    isTest: true,
  });
  if (!started.runId || !started.automationVersionId) {
    throw new AutomationDefinitionError('version_conflict', 'テストする版が変わりました。再読み込みしてください');
  }
  // 焼き付けたあと・送る前の最後の見張り（上の 2）。
  if (started.automationVersionId !== version.version_id
    || !await versionContentUnchanged(db, version)
    || !await runStepsMatchExpectedCommonActions(db, started.runId, expectedCommonActions)) {
    await cancelAutomationRunBeforeSend(db, started.runId);
    throw new AutomationDefinitionError(
      'version_conflict', '確認したあとに下書きが変わりました。送っていません。もう一度、送る内容を確認してください',
    );
  }
  const status = started.status === 'queued'
    ? await processAutomationRun(db, started.runId, {
      executors: createAutomationActionExecutors({
        credentialEncryptionKey: input.credentialEncryptionKey,
        operatorMailEnv: input.operatorMailEnv,
      }),
    })
    : started.status;
  if (!status || status === 'not_found') {
    throw new AutomationDefinitionError('not_found', 'テスト実行を確認できませんでした');
  }
  return { runId: started.runId, versionId: started.automationVersionId, status };
}

/**
 * 定義の稼働状態を切り替える（ ：一覧の「保管」と稼働切替）。
 *
 * - `active`：公開済みの版がある定義だけ動かせる。下書きだけの定義は
 *   先に `publishAutomationDraft` で公開する。
 * - `stopped`：動いている定義を止める。
 * - `archived`：一覧から外す。**実行記録は消えない**
 *   （`automation_runs` は定義を参照して残る）。
 *
 * 保管から戻すときは専用の restore を使い、稼働は再開しない。
 */
export async function updateAutomationDefinitionStatus(
  db: D1Database,
  input: {
    id: string;
    lineAccountId: string;
    status: 'active' | 'stopped' | 'archived';
    expectedConfirmationRevision?: number;
  },
): Promise<{ id: string; status: 'active' | 'stopped' | 'archived' }> {
  const definition = await db.prepare(
    `SELECT id, status, current_published_version_id, confirmation_revision
       FROM automation_definitions
      WHERE id = ? AND line_account_id = ?`,
  ).bind(input.id, input.lineAccountId).first<{
    id: string;
    status: 'draft' | 'active' | 'stopped' | 'archived';
    current_published_version_id: string | null;
    confirmation_revision: number;
  }>();
  if (!definition) {
    throw new AutomationDefinitionError('not_found', 'オートメーションが見つかりません');
  }
  if (input.expectedConfirmationRevision !== undefined && input.expectedConfirmationRevision !== definition.confirmation_revision) {
    throw new AutomationDefinitionError('version_conflict', '状態が変わりました。再読み込みしてください');
  }
  // すでにその状態なら何もしない（何度押しても同じ結果）。
  if (definition.status === input.status) {
    return { id: definition.id, status: input.status };
  }
  if (definition.status === 'archived') {
    throw new AutomationDefinitionError(
      'status_invalid', '保管から戻してから、稼働を切り替えてください',
    );
  }
  if (input.status === 'active' && !definition.current_published_version_id) {
    throw new AutomationDefinitionError(
      'not_published', '公開してから動かしてください', 'status',
    );
  }
  const updated = await db.prepare(
    `UPDATE automation_definitions SET status = ?, updated_at = ?, confirmation_revision = confirmation_revision + 1
      WHERE id = ? AND line_account_id = ? AND status = ?
        AND (? IS NULL OR confirmation_revision = ?)`,
  ).bind(
    input.status, new Date().toISOString(),
    definition.id, input.lineAccountId, definition.status,
    input.expectedConfirmationRevision ?? null, input.expectedConfirmationRevision ?? null,
  ).run();
  if ((updated.meta?.changes ?? 0) !== 1) {
    throw new AutomationDefinitionError('version_conflict', '状態が変わりました。再読み込みしてください');
  }
  return { id: definition.id, status: input.status };
}

/** 保管から戻すだけでは実行しない。公開版なしは下書きへ戻す。 */
export async function restoreAutomationDefinition(db: D1Database, input: { id: string; lineAccountId: string }) {
  const definition = await db.prepare(`SELECT status, current_published_version_id FROM automation_definitions
    WHERE id = ? AND line_account_id = ?`).bind(input.id, input.lineAccountId)
    .first<{ status: 'draft' | 'active' | 'stopped' | 'archived'; current_published_version_id: string | null }>();
  if (!definition) throw new AutomationDefinitionError('not_found', 'ルールが見つかりません');
  if (definition.status !== 'archived') return { id: input.id, status: definition.status };
  const status = definition.current_published_version_id ? 'stopped' : 'draft';
  const updated = await db.prepare(`UPDATE automation_definitions SET confirmation_revision = confirmation_revision + 1, status = ?, archived_at = NULL, updated_at = ?
    WHERE id = ? AND line_account_id = ? AND status = 'archived'
      AND current_published_version_id IS ?`)
    .bind(status, new Date().toISOString(), input.id, input.lineAccountId, definition.current_published_version_id).run();
  if ((updated.meta?.changes ?? 0) !== 1) throw new AutomationDefinitionError('version_conflict', '状態が変わりました。再読み込みしてください');
  return { id: input.id, status };
}
