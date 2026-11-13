import { logger } from '@line-crm/shared/server';
import { inputError } from '../lib/input-errors.js';
import type { Context, MiddlewareHandler } from 'hono';
import { getScenarioById, getFriendScenarioById, getFriendById, jstNow } from '@line-crm/db';
import type { Scenario as DbScenario, ScenarioStep as DbScenarioStep, FriendScenario as DbFriendScenario, DeliveryMode } from '@line-crm/db';
import { SUPPORTED_CONDITION_TYPES, isSupportedConditionType } from '../services/step-delivery.js';
import { parseQuestion } from '../features/scenarios/scenario-question/index.js';
import { isScenarioActionComplete } from '../features/scenarios/scenario-actions/index.js';
import { fail } from '../lib/fail.js';


import type { Env } from '../worker-env.js';
import { requireDeliveryAccess } from '../middleware/role-guard.js';
import { sha256Hex } from '../middleware/auth.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { resolveRequestBoundary } from '../services/request-boundary.js';
import { ScenarioContractError } from '../features/scenarios/scenario-contract/index.js';
import { LineClient } from '@line-crm/line-sdk';

export const scenarioPermission = (operation: 'view' | 'edit') => requireDeliveryAccess('scenarios', operation);

export function scenarioContractError(c: Context<Env>, error: unknown): Response {
  if (error instanceof ScenarioContractError) {
    return inputError(c, {
      success: false,
      code: error.code,
      error: error.message,
      ...(error.field ? { field: error.field } : {}),
    }, error.status, []);
  }
  throw error;
}

export async function requireScenarioAccountScope(c: Context<Env>, lineAccountId: string): Promise<Response | null> {
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
    return c.json({ success: false, error: 'シナリオが見つかりません' }, 404);
  }
  return null;
}

export /**
 * シナリオ変更の共通境界。
 *
 * owner/adminは従来どおり通す。一般staffはシナリオ行のaccountをDB解決し、
 * 共通土台へ渡す。表示権限だけのstaff・readOnly・範囲外は止める。
 * 存在しない行と、別のシナリオに属する通は404で止める。
 */
const requireScenarioEditBoundary: MiddlewareHandler<Env> = async (c, next) => {
  const staff = c.get('staff');
  if (staff && (staff.role === 'owner' || staff.role === 'admin')) {
    await next();
    return;
  }
  const scenario = await getScenarioById(c.env.DB, c.req.param('id') ?? '');
  if (!scenario) return fail(c, 404, 'SCENARIO_NOT_FOUND');
  const accountId = (scenario as { line_account_id?: string | null }).line_account_id ?? null;
  const decision = await resolveRequestBoundary(c.env.DB, staff, accountId, {
    requiredPermissionKey: 'scenario.definition.edit',
  });
  if (!decision.allowed) {
    if (decision.reason === 'forbidden') {
      return c.json({ success: false, error: 'この機能を操作する権限がありません' }, 403);
    }
    return fail(c, 404, 'SCENARIO_NOT_FOUND');
  }
  // スタッフが別のシナリオの通をIDだけで更新・削除しないようにする。
  const stepId = c.req.param('stepId');
  if (stepId) {
    const step = await c.env.DB.prepare('SELECT id FROM scenario_steps WHERE id = ? AND scenario_id = ?')
      .bind(stepId, scenario.id).first();
    if (!step) return fail(c, 404, 'STEP_NOT_FOUND');
  }
  await next();
}

export async function scenarioSubscriptionScope(c: Context<Env>, id: string) {
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  const inaccessible = await c.env.DB.prepare(`SELECT 1 FROM friend_scenarios fs LEFT JOIN friends f ON f.id=fs.friend_id
    WHERE fs.scenario_id=? AND (f.id IS NULL OR (f.line_account_id IS NULL AND ?=0)
      OR (f.line_account_id IS NOT NULL AND f.line_account_id NOT IN (SELECT value FROM json_each(?)))) LIMIT 1`)
    .bind(id, scope.canSeeUnassigned ? 1 : 0, JSON.stringify(scope.allowedAccountIds)).first();
  return inaccessible ? null : scope;
}

export async function requireVisibleScenario(c: Context<Env>, next: () => Promise<void>) {
  const scenario = await getScenarioById(c.env.DB, c.req.param('id')!);
  if (!scenario || !await canAccessAllLineAccounts(
    c.env.DB,
    c.get('staff'),
    [(scenario as { line_account_id?: string | null }).line_account_id ?? null],
  )) {
    return fail(c, 404, 'SCENARIO_NOT_FOUND');
  }
  await next();
}

export
function serializeScenario(row: DbScenario) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    triggerType: row.trigger_type,
    triggerTagId: row.trigger_tag_id,
    // null は全アカウント共通、UUID は特定アカウント所属を表す。管理画面で、共通のシナリオと所属先を失ったシナリオを区別できるよう返す。
    lineAccountId: (row as { line_account_id?: string | null }).line_account_id ?? null,
    isActive: Boolean(row.is_active),
    contentRevision: row.content_revision,
    stoppedReason: row.stopped_reason ?? null,
    stoppedBy: row.stopped_by ?? null,
    stoppedAt: row.stopped_at ?? null,
    deliveryMode: (row.delivery_mode ?? 'relative') as DeliveryMode,
    // 既定は「並行を許す」。104 で既存の行を 1 に寄せてある。
    allowConcurrent: (row.allow_concurrent ?? 1) !== 0,
    displayOrder: Number(row.display_order ?? 0),
    folderId: row.folder_id ?? null,
    // シナリオ全体の配信対象。null は条件なし。
    audienceCondition: parseJson(row.audience_condition_json),
    // 最終コンテンツ配信後の処理。列が無い環境でも 'pause'（これまでの動き）。
    onCompleteMode: (row.on_complete_mode ?? 'pause') as 'pause' | 'resume_previous' | 'move',
    onCompleteScenarioId: row.on_complete_scenario_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export /** 保存されている JSON を素の値に戻す。壊れていれば null。 */
function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export
function serializeStep(row: DbScenarioStep) {
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    stepOrder: row.step_order,
    delayMinutes: row.delay_minutes,
    offsetDays: row.offset_days ?? null,
    offsetMinutes: row.offset_minutes ?? null,
    deliveryTime: row.delivery_time ?? null,
    messageType: row.message_type,
    messageContent: row.message_content,
    messageBubbles: parseJson(row.message_bubbles_json),
    conditionType: row.condition_type ?? null,
    conditionValue: row.condition_value ?? null,
    nextStepOnFalse: row.next_step_on_false ?? null,
    templateId: row.template_id ?? null,
    onReachTagId: row.on_reach_tag_id ?? null,
    // この通を送ったあと。'pause' なら次へ進めず止める。列が無い環境でも
    // 'continue'（これまでの動き）として返す。
    afterSend: (row.after_send ?? 'continue') as 'continue' | 'pause',
    // 1通ごとの配信対象。null は「購読中の全員に配信する」。
    targetCondition: parseJson(row.target_condition_json),
    // 質問メッセージ。null ならふつうの通。
    question: parseJson(row.question_json),
    isDraft: Number(row.is_draft ?? 0) !== 0,
    createdAt: row.created_at,
  };
}

export /** 質問メッセージの中身を見る。 */
function validateQuestionForStorage(
  value: unknown,
): { ok: true; json: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, json: null };
  const question = parseQuestion(JSON.stringify(value));
  if (!question) {
    return { ok: false, error: '質問には質問文と、選択肢が1つ以上要ります。' };
  }
  if (question.choices.length > 13) {
    // LINE の Flex は縦に積めるが、実用上これ以上はスマホで押せない。
    return { ok: false, error: '選択肢は13個までにしてください。' };
  }
  for (const [i, choice] of question.choices.entries()) {
    if (!choice.label || choice.label.trim() === '') {
      return { ok: false, error: `選択肢${i + 1}の文字が空です。` };
    }
    /*
     * 行き先（URL・電話・メール）の形を見る。not-a-url のような
     * 値でも保存できると、設定済みに見えて実際は開けない通になる。
     * 下書きでも通さず、公開・送信前の共通検査としてここで止める。
     */
    const behavior = (choice as { behavior?: string }).behavior ?? 'none';
    if (behavior === 'url' || behavior === 'add_friend' || behavior === 'form') {
      const url = ((choice as { url?: unknown }).url ?? '').toString().trim();
      if (!/^https?:\/\/\S+$/.test(url)) {
        return { ok: false, error: `選択肢${i + 1}のURLが正しくありません。https:// から始まるURLを入力してください。` };
      }
    } else if (behavior === 'tel') {
      const tel = ((choice as { tel?: unknown }).tel ?? '').toString().trim();
      if (!/[0-9]/.test(tel) || !/^[0-9+\-() ]+$/.test(tel)) {
        return { ok: false, error: `選択肢${i + 1}の電話番号が正しくありません。数字で入力してください。` };
      }
    } else if (behavior === 'mail' || behavior === 'email') {
      const email = ((choice as { email?: unknown }).email ?? '').toString().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { ok: false, error: `選択肢${i + 1}のメールアドレスが正しくありません。` };
      }
    }
  }
  return { ok: true, json: JSON.stringify(question) };
}

export const VALID_DELIVERY_MODES: readonly DeliveryMode[] = ['relative', 'elapsed', 'absolute_time'];
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export /** 未知の条件を保存時に拒み、配信時に常時通過として過剰配信しないよう、condition_type/value の組を検証する。 */
function validateStepCondition(
  conditionType: unknown,
  conditionValue: unknown,
): { ok: true } | { ok: false; error: string } {
  if (conditionType == null || conditionType === '') return { ok: true };
  if (!isSupportedConditionType(conditionType)) {
    return {
      ok: false,
      error: `Unsupported conditionType "${String(conditionType)}" (supported: ${SUPPORTED_CONDITION_TYPES.join(', ')})`,
    };
  }
  // conditionType が「あり」のとき conditionValue は必ず非空文字列。
  // body の TS 型は実行時には強制されないので、明示的に runtime check しないと
  // 数値・オブジェクトが SQL バインドに乗って 0件マッチ → tag_not_exists が全友だちに当たる、
  // のような OSS issue  と同じ over-delivery を再現してしまう。
  if (typeof conditionValue !== 'string' || conditionValue === '') {
    return { ok: false, error: 'conditionValue must be a non-empty string when conditionType is set' };
  }
  if (conditionType === 'metadata_equals' || conditionType === 'metadata_not_equals') {
    try {
      const parsed = JSON.parse(conditionValue) as unknown;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        typeof (parsed as { key?: unknown }).key !== 'string' ||
        !('value' in (parsed as Record<string, unknown>))
      ) {
        return { ok: false, error: 'conditionValue for metadata_* must be JSON {"key": "...", "value": ...}' };
      }
    } catch {
      return { ok: false, error: 'conditionValue for metadata_* must be valid JSON' };
    }
  }
  return { ok: true };
}

export interface StepScheduleBody {
  delayMinutes?: number;
  offsetDays?: number;
  offsetMinutes?: number;
  deliveryTime?: string;
}

export /** delivery_mode に応じてスケジュールフィールドを検証する。 */
function validateStepSchedule(
  mode: DeliveryMode,
  body: StepScheduleBody,
): { ok: true } | { ok: false; error: string } {
  if (mode === 'relative') {
    if (body.offsetDays != null || body.offsetMinutes != null || body.deliveryTime != null) {
      return { ok: false, error: 'relative mode: only delayMinutes is allowed' };
    }
    if (typeof body.delayMinutes !== 'number' || body.delayMinutes < 0) {
      return { ok: false, error: 'relative mode: delayMinutes (>=0) is required' };
    }
    return { ok: true };
  }
  if (mode === 'elapsed') {
    if (body.delayMinutes != null || body.deliveryTime != null) {
      return { ok: false, error: 'elapsed mode: only offsetDays + offsetMinutes are allowed' };
    }
    if (typeof body.offsetDays !== 'number' || body.offsetDays < 0) {
      return { ok: false, error: 'elapsed mode: offsetDays (>=0) is required' };
    }
    if (typeof body.offsetMinutes !== 'number' || body.offsetMinutes < 0 || body.offsetMinutes >= 1440) {
      return { ok: false, error: 'elapsed mode: offsetMinutes (0..1439) is required' };
    }
    return { ok: true };
  }
  // absolute_time
  if (body.delayMinutes != null || body.offsetMinutes != null) {
    return { ok: false, error: 'absolute_time mode: only offsetDays + deliveryTime are allowed' };
  }
  if (typeof body.offsetDays !== 'number' || body.offsetDays < 0) {
    return { ok: false, error: 'absolute_time mode: offsetDays (>=0) is required' };
  }
  if (typeof body.deliveryTime !== 'string' || !HHMM_RE.test(body.deliveryTime)) {
    return { ok: false, error: 'absolute_time mode: deliveryTime must match HH:MM' };
  }
  return { ok: true };
}

export /** 購読行を共有の応答形式へ変換する。 */
function serializeFriendScenario(row: DbFriendScenario) {
  return {
    id: row.id,
    confirmationRevision: row.confirmation_revision,
    friendId: row.friend_id,
    scenarioId: row.scenario_id,
    currentStepOrder: row.current_step_order,
    status: row.status,
    startedAt: row.started_at,
    nextDeliveryAt: row.next_delivery_at,
    // 開始時に固定した公開版。null は版より前の購読。
    publishedVersionId: row.published_version_id ?? null,
    // なぜ止まっているか（432）。画面はこれで「再開」と「失敗を再送」を
    // 出し分ける。止まっていない行・古い行は null。
    pauseReason: row.pause_reason ?? null,
    updatedAt: row.updated_at,
  };
}

export /** 公開操作の確認キー。自動応答の公開口と同じ基準。 */
function validScenarioPublishKey(value: string | undefined): value is string {
  return Boolean(value && value.length >= 8 && value.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(value));
}

export // GET /api/scenarios/:id/preview - timeline preview (deterministic, no jitter)
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'] as const;

export // ============================================================
// アクション（Lステップの「アクション設定」にあたる）
// ============================================================

const VALID_ACTION_HOOKS = ['step_sent', 'scenario_completed', 'choice_selected'] as const;
export const VALID_ACTION_TYPES = ['tag', 'friend_field', 'support_mark', 'scenario', 'common_var', 'send_message', 'send_template', 'reminder', 'event_booking'] as const;

export function serializeAction(row: {
  id: string;
  scenario_id: string;
  hook: string;
  step_id: string | null;
  choice_index: number | null;
  sort_order: number;
  action_type: string;
  config_json: string;
  condition_json: string | null;
  repeat_on_refire: number;
}) {
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    hook: row.hook,
    stepId: row.step_id,
    choiceIndex: row.choice_index,
    sortOrder: row.sort_order,
    actionType: row.action_type,
    config: parseJson(row.config_json),
    condition: parseJson(row.condition_json),
    repeatOnRefire: row.repeat_on_refire !== 0,
    /*
     * 中身がまだ埋まっていないか。画面に「未完成」と出して、
     * 配信では実行されないことを伝えるために返す。
     */
    complete: isScenarioActionComplete(row.action_type, parseJson(row.config_json)),
  };
}

export /**
 * アクションの設定の「形」を見る。
 *
 * 画面はカードを1枚置いてから中身を埋める作りなので、**まだ埋まっていない
 * ことは通す**。埋まっていないアクションは配信時に実行されず、画面にも
 * 「未完成」と出る（isScenarioActionComplete）。
 *
 * ここで見るのは、埋まっている値が壊れていないかだけ。たとえば op に
 * 知らない値が入っていれば断る。通してしまうと、配信時に例外になる。
 */
function validateActionConfig(
  actionType: string,
  config: unknown,
): { ok: true } | { ok: false; error: string } {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { ok: false, error: 'アクションの設定が空です。' };
  }
  const c = config as Record<string, unknown>;
  switch (actionType) {
    case 'tag':
      if (c.op !== undefined && c.op !== 'add' && c.op !== 'remove') {
        return { ok: false, error: 'タグ操作は「タグを追加」「タグをはずす」のどちらかです。' };
      }
      return { ok: true };
    case 'friend_field':
      if (c.op !== undefined && !['set', 'add', 'sub', 'clear'].includes(String(c.op))) {
        return { ok: false, error: '操作内容が不正です。' };
      }
      return { ok: true };
    case 'support_mark':
      // null は「対応マークを外す」。明示的に許す。
      if (c.markId !== null && c.markId !== undefined && typeof c.markId !== 'string') {
        return { ok: false, error: '対応マークの指定が不正です。' };
      }
      return { ok: true };
    case 'scenario':
      if (c.op !== undefined && !['start', 'stop', 'resume_previous'].includes(String(c.op))) {
        return { ok: false, error: 'シナリオ操作の種別が不正です。' };
      }
      return { ok: true };
    case 'common_var':
      if (c.op !== undefined && c.op !== 'add' && c.op !== 'sub') {
        return { ok: false, error: '共通情報の操作は加算か減算です。' };
      }
      return { ok: true };
    case 'send_message':
      if (c.content !== undefined && typeof c.content !== 'string') return { ok: false, error: '本文が不正です。' };
      return { ok: true };
    case 'send_template':
      if (c.templateId !== undefined && typeof c.templateId !== 'string') return { ok: false, error: 'テンプレートの指定が不正です。' };
      return { ok: true };
    case 'reminder':
      if (c.reminderId !== undefined && typeof c.reminderId !== 'string') return { ok: false, error: 'リマインダの指定が不正です。' };
      return { ok: true };
    case 'event_booking':
      if (c.eventId !== undefined && typeof c.eventId !== 'string') return { ok: false, error: 'イベント予約の指定が不正です。' };
      return { ok: true };
    default:
      return { ok: false, error: `知らないアクション種別です: ${actionType}` };
  }
}

export // ============================================================
// テスト送信
// ============================================================

/*
 * POST /api/scenarios/:id/test-send        … 全通
 * POST /api/scenarios/:id/steps/:stepId/test-send … 1通
 *
 * どちらも購読の状態は触らない。下書きの通も、テストでは送る。
 * 書きかけを確かめるための機能なので、ここで除くと用を成さない。
 */
async function runTestSend(
  c: Context<Env>,
  scenarioId: string,
  stepId: string | null,
) {
  const body = await c.req.json<{ friendId?: string }>().catch(() => ({ friendId: undefined }));
  const friendId = body.friendId;
  if (!friendId) {
    return inputError(c, { success: false, error: '送り先の友だちを選んでください。' }, 400, ["friendId"]);
  }

  const scenario = await c.env.DB.prepare(
    `SELECT id, line_account_id FROM scenarios WHERE id = ?`,
  )
    .bind(scenarioId)
    .first<{ id: string; line_account_id: string | null }>();
  if (!scenario) return fail(c, 404, 'SCENARIO_NOT_FOUND');

  // テスト送信は本物のLINE送信。IDを直接渡されても、見えない友だちや
  // 別アカウントの友だちへシナリオ側のトークンで送らない。
  const friend = await getFriendById(c.env.DB, friendId);
  const friendAccountId = (friend as { line_account_id?: string | null } | null)?.line_account_id ?? null;
  if (!friend || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [friendAccountId])) {
    return c.json({ success: false, error: '送り先の友だちが見つかりません。' }, 404);
  }
  if (scenario.line_account_id && friendAccountId !== scenario.line_account_id) {
    return inputError(c, { success: false, error: 'このシナリオと同じLINEアカウントの友だちを選んでください。' }, 422, ["friendId"]);
  }

  const rows = stepId
    ? await c.env.DB.prepare(`SELECT * FROM scenario_steps WHERE id = ? AND scenario_id = ?`)
        .bind(stepId, scenarioId)
        .all<DbScenarioStep>()
    : await c.env.DB.prepare(
        `SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order ASC`,
      )
        .bind(scenarioId)
        .all<DbScenarioStep>();
  const steps = rows.results ?? [];
  if (steps.length === 0) {
    return inputError(c, { success: false, error: '送る通がありません。' }, 400, []);
  }

  const token = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  const { LineClient } = await import('@line-crm/line-sdk');
  const { testSendSteps } = await import('../features/scenarios/scenario-test-send/index.js');
  try {
    const result = await testSendSteps(
      c.env.DB,
      new LineClient(token),
      steps,
      friendId,
      scenario.line_account_id,
      c.env.WORKER_URL || new URL(c.req.url).origin,
      // 送信先×対象（全通 or 1通）で短い間隔の重複実送信を止める。
      { dedupeKey: `${scenarioId}:${stepId ?? 'all'}` },
    );
    if (!result.ok) {
      return inputError(c, { success: false, error: result.error }, result.deduped ? 409 : 400, []);
    }
    return c.json({ success: true, data: { sent: result.sent } });
  } catch (err) {
    logger.error("scenarios.run_test_send_failed");
    return c.json(
      { success: false, error: `テスト送信に失敗しました: ${(err as Error).message}` },
      502,
    );
  }
}

export // ============================================================
// 友だち単位の購読操作（#949 N-054 / 機能05）
//
// 画面は「いま届いている・止まっている購読1行」に対して止める・再開する・
// 別のシナリオへ移す・失敗を再送する。対象は friend_scenarios の id で
// 指す。友だちの所属アカウントが見える範囲外なら 404 で存在を隠す。
//
// 全部で Idempotency-Key を必須にする。同じキーの再送は残っている結果を
// そのまま返し、別の購読・別の操作・別の本体への使い回しは 409 にする
// （friend_scenario_op_keys / 432・434）。
// ============================================================

type FriendScenarioOp = 'pause' | 'resume' | 'move' | 'retry';

export interface FriendOpOutcome {
  status: 200 | 201 | 400 | 404 | 409 | 422;
  body: { success: boolean; data?: unknown; error?: string; current?: unknown };
}

export /**
 * 購読操作の共通骨組み。
 *
 * 1. 確認キー（Idempotency-Key）の形を見る。無ければ 400。
 * 2. 購読行と友だちを読み、友だちの所属アカウントが範囲外なら 404。
 * 3. 台帳へキーを予約する（INSERT OR IGNORE）。先に入っているなら、
 *    同じ購読・同じ操作・同じ本体の結果をそのまま返し、別の使い回しは 409。
 * 4. 操作を走らせ、**成功した結果だけ**を台帳へ残す。一時的な失敗
 *    （配信中の 409 や検証の 422 など）を残すと、Web は失敗時にキーを
 *    回さないため同じ応答が永遠に返り続ける。失敗時と例外時は予約を外す。
 */
async function runFriendScenarioOp(
  c: Context<Env>,
  op: FriendScenarioOp,
  run: (subscription: DbFriendScenario) => Promise<FriendOpOutcome>,
): Promise<Response> {
  const key = c.req.header('Idempotency-Key');
  if (!validScenarioPublishKey(key)) {
    return c.json({ success: false, error: '操作の確認キーが必要です' }, 400);
  }
  const db = c.env.DB;
  const subscriptionId = c.req.param('subscriptionId') ?? '';

  // 操作本体（リクエスト）の写し。move の移し先のように本体に引数を持つ
  // 操作は、同じキーでも本体が違えば別操作として 409 にするため台帳へ残す
  // （scenario_publish_keys の content_snapshot と同じ考え方）。
  // Hono は読んだ本体を写しとして持つので、handler 側の c.req.json は
  // このあとも普通に動く。
  const requestFingerprint = await sha256Hex(await c.req.text());

  const subscription = await getFriendScenarioById(db, subscriptionId);
  if (!subscription) {
    return c.json({ success: false, error: '購読が見つかりません' }, 404);
  }
  const friend = await getFriendById(db, subscription.friend_id);
  const friendAccountId = (friend as { line_account_id?: string | null } | null)?.line_account_id ?? null;
  if (!friend || !await canAccessAllLineAccounts(db, c.get('staff'), [friendAccountId])) {
    return c.json({ success: false, error: '購読が見つかりません' }, 404);
  }

  const claimed = await db.prepare(
    `INSERT OR IGNORE INTO friend_scenario_op_keys
       (op_idempotency_key, friend_scenario_id, op, request_fingerprint, response_json, created_at)
     VALUES (?, ?, ?, ?, 'PENDING', ?)`,
  ).bind(key, subscriptionId, op, requestFingerprint, jstNow()).run();

  if ((claimed.meta.changes ?? 0) === 0) {
    const existing = await db.prepare(
      `SELECT friend_scenario_id, op, request_fingerprint, response_json
        FROM friend_scenario_op_keys
        WHERE op_idempotency_key = ?`,
    ).bind(key).first<{
      friend_scenario_id: string;
      op: string;
      request_fingerprint: string | null;
      response_json: string;
    }>();
    // 本体の写しが違う同キー再送（例: move の移し先だけ変えた再送）も
    // 別操作への使い回しとして 409 にする。既存行の写しが NULL（434 より
    // 前に残った行）なら不一致に倒す。
    if (
      !existing
      || existing.friend_scenario_id !== subscriptionId
      || existing.op !== op
      || existing.request_fingerprint !== requestFingerprint
    ) {
      return c.json(
        { success: false, error: '同じ確認キーが別の操作で使われています' },
        409,
      );
    }
    if (existing.response_json === 'PENDING') {
      return c.json(
        { success: false, error: '同じ操作を処理中です。しばらく待ってからやり直してください' },
        409,
      );
    }
    const stored = JSON.parse(existing.response_json) as FriendOpOutcome;
    return c.json(stored.body, stored.status);
  }

  try {
    const outcome = await run(subscription);
    if (outcome.status >= 200 && outcome.status < 300) {
      // 成功した結果だけを pin する。同じキーの再送はこの応答を再生する。
      await db.prepare(
        `UPDATE friend_scenario_op_keys SET response_json = ?
          WHERE op_idempotency_key = ?`,
      ).bind(JSON.stringify(outcome), key).run();
    } else {
      // 失敗応答は pin しない。予約を外して、同じキーでも新しいキーでも
      // やり直せるようにする。
      await db.prepare(
        `DELETE FROM friend_scenario_op_keys WHERE op_idempotency_key = ?`,
      ).bind(key).run();
    }
    return c.json(outcome.body, outcome.status);
  } catch (err) {
    // 台帳に失敗を pin しない。予約だけ外して例外を上へ返す。
    await db.prepare(
      `DELETE FROM friend_scenario_op_keys WHERE op_idempotency_key = ?`,
    ).bind(key).run();
    throw err;
  }
}
