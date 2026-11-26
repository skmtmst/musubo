import { DEFAULT_TENANT_ID, hasStaffAccess, jstDate as japanDate } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError } from '../lib/input-errors.js';
import { createBroadcastRetryKey } from '../features/broadcasts/broadcast-retry-key/index.js';
import { type Context, type MiddlewareHandler } from 'hono';
import { getConversionPointById, getApprovalNotificationState, markApprovalNotified, releaseApprovalNotification, getConversionApprovalNotifyInfo, getConversionOfferActionPlan, enrollFriendInScenario, createNotification, listUnfinishedFriendTagSideEffectRuns, canAutoRetryFriendTagSideEffect, ConversionDefinitionError, isExclusionSavable } from '@line-crm/db';
import type { ConversionOfferActionPlan, ConversionPoint, ConversionMeasureMethod, ConversionDefinitionRange, ConversionDefinitionSort, ConversionDefinitionStatus, ConversionDefinitionFilter, ConversionDeduplicationMode, ConversionValueMode, ConversionReversalPolicy } from '@line-crm/db';
import { notifyAffiliateApproval } from '../services/affiliate-notifier.js';
import { attachTagAndFireSideEffects } from '../features/friends/friend-tag-attach/index.js';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { fail } from '../lib/fail.js';

/** 受信鍵で認証した地点の範囲から友だちを検索し、複数一致も検出する。 */
export async function findConversionIngestFriends(
  db: D1Database,
  point: { line_account_id: string | null; tenant_id: string | null },
  identity: { friendId: string } | { lineUserId: string },
): Promise<{ id: string }[]> {
  const [column, value] = 'friendId' in identity ? ['f.id', identity.friendId] : ['f.line_platform_user_id', identity.lineUserId];
  const accountFilter = point.line_account_id === null ? '' : 'AND f.line_account_id = ?';
  const accountArgs = point.line_account_id === null ? [] : [point.line_account_id];
  const friends = await db.prepare(`SELECT f.id FROM friends f LEFT JOIN line_accounts a ON a.id = f.line_account_id
    WHERE ${column} = ? ${accountFilter} AND COALESCE(a.tenant_id, ?) = ? LIMIT 2`)
    .bind(value, ...accountArgs, DEFAULT_TENANT_ID, point.tenant_id ?? DEFAULT_TENANT_ID)
    .all<{ id: string }>();
  return friends.results;
}


export async function adminAccountScope(c: Context<Env>, alias = '') {
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  const column = `${alias}line_account_id`;
  const where = scope.allowedAccountIds.length
    ? `(${column} IN (${sqlIdSet(scope.allowedAccountIds).sql})${scope.canSeeUnassigned ? ` OR ${column} IS NULL` : ''})`
    : scope.canSeeUnassigned
      ? `${column} IS NULL`
      : '1 = 0';
  return { scope, where };
}

export const requireVisibleConversionPoint: MiddlewareHandler<Env> = async (c, next) => {
  const point = await getConversionPointById(c.env.DB, c.req.param('id') ?? '');
  if (!point || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [point.line_account_id])) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  await next();
};

export const requireVisibleConversionEvent: MiddlewareHandler<Env> = async (c, next) => {
  const row = await c.env.DB.prepare(
    `SELECT cp.line_account_id FROM conversion_events ce
       JOIN conversion_points cp ON cp.id = ce.conversion_point_id
      WHERE ce.id = ?`,
  ).bind(c.req.param('id')).first<{ line_account_id: string | null }>();
  if (!row || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [row.line_account_id])) {
    return fail(c, 404, 'ATTRIBUTED_CONVERSION_EVENT_NOT_FOUND');
  }
  await next();
};

export const MEASURE_METHODS: ConversionMeasureMethod[] = ['url_reach', 'webhook', 'manual'];

export type ConversionPermission = 'view' | 'edit' | 'export';

export function conversionPermission(permission: ConversionPermission): MiddlewareHandler<Env> {
  return async (c, next) => {
    const staff = c.get('staff');
    const read = permission === 'view';
    const allowed = hasStaffAccess(staff, '/conversions', read)
      && (permission === 'view' || hasStaffAccess(staff,
        permission === 'edit' ? 'conversion.definition.edit' : 'conversion.report.export', read));
    if (!allowed) return c.json({ success: false, error: 'この機能を操作する権限がありません' }, 403);
    await next();
  };
}

export function conversionContractError(c: Context<Env>, error: unknown): Response {
  if (error instanceof ConversionDefinitionError) {
    return inputError(c, { success: false, code: error.code, error: error.message }, error.status, []);
  }
  throw error;
}

export function jstDate(date: Date): string {
  return japanDate(date);
}

export function parseDate(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00+09:00`);
  return Number.isNaN(parsed.getTime()) || jstDate(parsed) !== value ? null : parsed;
}

export function conversionRange(c: Context<Env>):
  | { ok: true; range: ConversionDefinitionRange; previousRange: ConversionDefinitionRange }
  | { ok: false; response: Response } {
  const rawTo = c.req.query('to') ?? jstDate(new Date());
  const toDate = parseDate(rawTo);
  const rawFrom = c.req.query('from') ?? (toDate
    ? jstDate(new Date(toDate.getTime() - 29 * 24 * 60 * 60 * 1000))
    : '');
  const fromDate = parseDate(rawFrom);
  if (!fromDate || !toDate || fromDate > toDate) {
    return {
      ok: false,
      response: inputError(c, { success: false, error: 'from と to は正しい日付順で指定してください' }, 400, ["from","to"]),
    };
  }
  const inclusiveDays = Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1;
  if (inclusiveDays > 366) {
    return {
      ok: false,
      response: inputError(c, { success: false, error: '集計期間は366日以内で指定してください' }, 400, ["to","from"]),
    };
  }
  const previousTo = new Date(fromDate.getTime() - 24 * 60 * 60 * 1000);
  const previousFrom = new Date(previousTo.getTime() - (inclusiveDays - 1) * 24 * 60 * 60 * 1000);
  return {
    ok: true,
    range: { from: `${rawFrom} 00:00:00`, to: `${rawTo} 23:59:59`, timeZone: 'Asia/Tokyo' },
    previousRange: {
      from: `${jstDate(previousFrom)} 00:00:00`,
      to: `${jstDate(previousTo)} 23:59:59`,
      timeZone: 'Asia/Tokyo',
    },
  };
}

export const DEFINITION_STATUSES = new Set<ConversionDefinitionStatus>(['active', 'stopped', 'draft']);
export // 導出状態での絞り込み。status 列そのものよりこちらが正確。
const DEFINITION_STATES = new Set<ConversionDefinitionFilter>([
  'active', 'draft', 'stopped', 'invalid', 'sourceStopped', 'unused',
]);
export const DEFINITION_SORTS = new Set<ConversionDefinitionSort>([
  'count_desc', 'value_desc', 'updated_desc', 'name_asc',
]);
export const DEFINITION_SOURCE_TYPES = new Set([
  'ec_order_confirmed', 'form_submitted', 'reservation_confirmed', 'url_reach',
  'webinar_completed', 'tag_added',
]);
export const DEDUPLICATION_MODES = new Set<ConversionDeduplicationMode>(['every', 'once_per_friend', 'window']);
export const VALUE_MODES = new Set<ConversionValueMode>(['source', 'fixed', 'none']);
export const REVERSAL_POLICIES = new Set<ConversionReversalPolicy>(['source_cancelled', 'manual', 'none']);

export function positiveVersion(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export /**
 * 操作理由の取り出し。台帳行を膨らませないよう200文字まで。
 *
 * 画面は決まった短い文言しか送らないが、口を直接叩く巨大文字から
 * 監査・履歴の行を守る。超えたら切り捨てず400で返す。
 */
function readReason(body: Record<string, unknown> | null):
  | { ok: true; reason: string | null }
  | { ok: false; error: string } {
  const raw = body?.reason;
  if (typeof raw !== 'string' || !raw.trim()) return { ok: true, reason: null };
  const reason = raw.trim();
  if (reason.length > 200) {
    return { ok: false, error: '理由は200文字以内で入力してください' };
  }
  return { ok: true, reason };
}

export function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export /**
 * 同じ入力が経路ごとに異なる結果にならないよう、成果地点の検証を共有し、必須かどうかだけを切り替える。編集時の店は本文でなく既存地点から確定する。
 */
function readDefinitionInput(body: Record<string, unknown>, options: { requireAccount?: boolean } = {}) {
  const requireAccount = options.requireAccount !== false;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const sourceType = typeof body.sourceType === 'string' ? body.sourceType : '';
  const sourceConfig = plainObject(body.sourceConfig) ?? {};
  const lineAccountId = typeof body.lineAccountId === 'string' ? body.lineAccountId.trim() : '';
  const deduplicationMode = body.deduplicationMode as ConversionDeduplicationMode;
  const valueMode = body.valueMode as ConversionValueMode;
  const reversalPolicy = body.reversalPolicy as ConversionReversalPolicy;
  const windowDays = body.deduplicationWindowDays == null ? null : Number(body.deduplicationWindowDays);
  const fixedValue = body.fixedValue == null || body.fixedValue === '' ? null : Number(body.fixedValue);
  const attributionDays = body.attributionDays == null || body.attributionDays === '' ? null : Number(body.attributionDays);
  const targetUrl = typeof body.targetUrl === 'string' && body.targetUrl.trim() ? body.targetUrl.trim() : null;
  if (!name || name.length > 120 || (requireAccount && !lineAccountId) || (targetUrl && targetUrl.length > 2000) || !DEFINITION_SOURCE_TYPES.has(sourceType)
    || !DEDUPLICATION_MODES.has(deduplicationMode) || !VALUE_MODES.has(valueMode)
    || !REVERSAL_POLICIES.has(reversalPolicy)
    || (deduplicationMode === 'window' && (!Number.isInteger(windowDays) || windowDays! < 1 || windowDays! > 365))
    || (valueMode === 'fixed' && (fixedValue === null || !Number.isFinite(fixedValue) || fixedValue < 0))
    || (attributionDays !== null && (!Number.isInteger(attributionDays) || attributionDays < 1 || attributionDays > 365))
    || (sourceType === 'url_reach' && (!targetUrl || !/^https?:\/\//.test(targetUrl)))
    // 壊れた数えない条件は保存させない。記録も試算も止まるか
    // 全件数えるかに倒れてしまうため、入口で断つ。
    || !isExclusionSavable(sourceConfig)) {
    return null;
  }
  return {
    name, sourceType, sourceConfig, lineAccountId, deduplicationMode,
    deduplicationWindowDays: windowDays, valueMode, fixedValue, reversalPolicy,
    attributionDays, targetUrl,
    measureMethod: sourceType === 'url_reach' ? 'url_reach' as const : 'webhook' as const,
  };
}

export function definitionFilters(c: Context<Env>) {
  const status = c.req.query('status');
  const state = c.req.query('state');
  const sort = c.req.query('sort') ?? 'count_desc';
  if (status && !DEFINITION_STATUSES.has(status as ConversionDefinitionStatus)) {
    return { ok: false as const, response: inputError(c, { success: false, error: 'status が正しくありません' }, 400, ["status"]) };
  }
  if (state && !DEFINITION_STATES.has(state as ConversionDefinitionFilter)) {
    return { ok: false as const, response: inputError(c, { success: false, error: 'state が正しくありません' }, 400, ["state"]) };
  }
  if (state && status) {
    // 導出状態と素の status の両方が来たら意味が曖昧になるため弾く。
    return { ok: false as const, response: inputError(c, { success: false, error: 'state と status は同時に指定できません' }, 400, ["state","status"]) };
  }
  if (!DEFINITION_SORTS.has(sort as ConversionDefinitionSort)) {
    return { ok: false as const, response: inputError(c, { success: false, error: 'sort が正しくありません' }, 400, ["sort"]) };
  }
  return {
    ok: true as const,
    value: {
      lineAccountId: c.req.query('lineAccountId'),
      query: c.req.query('q'),
      status: status as ConversionDefinitionStatus | undefined,
      state: state as ConversionDefinitionFilter | undefined,
      sourceType: c.req.query('sourceType'),
      sort: sort as ConversionDefinitionSort,
    },
  };
}

export async function conversionDefinitionScope(c: Context<Env>, lineAccountId?: string) {
  if (lineAccountId && !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
    return { ok: false as const, response: c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403) };
  }
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  return {
    ok: true as const,
    value: { allowedAccountIds: scope.allowedAccountIds, includeUnassigned: scope.canSeeUnassigned },
  };
}

export function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export interface ConversionPointBody {
  name?: unknown;
  eventType?: unknown;
  value?: unknown;
  measureMethod?: unknown;
  targetUrl?: unknown;
  countRepeat?: unknown;
  attributionDays?: unknown;
  lineAccountId?: unknown;
  expectedVersion?: unknown;
}

export /**
 * 数え方を変える項目。稼働中または成果・利用先のある地点では
 * 旧PUTで触らせず、新版作成か停止後の手順へ案内する。
 * 名前だけは表示用で数え方に影響しないため対象外。
 */
const CONVERSION_MEASURE_PATCH_KEYS = new Set([
  'eventType',
  'value',
  'measureMethod',
  'targetUrl',
  'countRepeat',
  'attributionDays',
  'lineAccountId',
]);

export /**
 * 計測に関する項目を検証して取り出す。
 *
 * url_reach なのに対象URLが無い、という組み合わせを弾く。保存できてしまうと
 * 「設定したのに1件も数えられない」という、気づきにくい壊れ方をする。
 */
function readMeasureOptions(
  body: ConversionPointBody,
  current?: ConversionPoint,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {};

  let method = current?.measure_method ?? 'manual';
  if (body.measureMethod !== undefined) {
    if (!MEASURE_METHODS.includes(body.measureMethod as ConversionMeasureMethod)) {
      return { ok: false, error: `measureMethod must be one of ${MEASURE_METHODS.join(', ')}` };
    }
    method = body.measureMethod as ConversionMeasureMethod;
    out.measureMethod = method;
  }

  let targetUrl = current?.target_url ?? null;
  if ('targetUrl' in body) {
    const raw = body.targetUrl;
    if (raw === null || raw === '' || raw === undefined) {
      targetUrl = null;
    } else if (typeof raw !== 'string' || !/^https?:\/\//.test(raw)) {
      return { ok: false, error: 'targetUrl must start with http:// or https://' };
    } else if (raw.trim().length > 2000) {
      // 巨大なURLで計測行・台帳行を膨らませない。
      return { ok: false, error: 'targetUrl must be 2000 characters or less' };
    } else {
      targetUrl = raw.trim();
    }
    out.targetUrl = targetUrl;
  }

  if (method === 'url_reach' && !targetUrl) {
    return { ok: false, error: 'targetUrl is required when measureMethod is url_reach' };
  }

  if (body.countRepeat !== undefined) out.countRepeat = body.countRepeat !== false;

  if ('attributionDays' in body) {
    const raw = body.attributionDays;
    if (raw === null || raw === '' || raw === undefined) {
      out.attributionDays = null;
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 365) {
        return { ok: false, error: 'attributionDays must be an integer between 1 and 365' };
      }
      out.attributionDays = n;
    }
  }

  if ('lineAccountId' in body) {
    const raw = body.lineAccountId;
    out.lineAccountId = raw === null || raw === '' || raw === undefined ? null : String(raw);
  }

  return { ok: true, value: out };
}

export const MAX_INGEST_BODY_BYTES = 64 * 1024;
export const INGEST_SIGNATURE_HEADER = 'X-Conversion-Signature';
export const INGEST_EVENT_ID_HEADER = 'X-Conversion-Event-Id';

export // ── Approval Queue (ASP Phase 2) ─────────────────────────────────────────────

const APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected']);

export /**
 * 成果承認の門番。
 *
 * owner/adminは通す。一般staffは「/conversions の利用権」と
 * 「conversion.approval.edit の承認権」の両方を持つときだけ通す。
 * どちらも無いstaff・権限外のtenant/アカウントはここで403/404に倒す。
 */
const requireApprovalPermission: MiddlewareHandler<Env> = async (c, next) => {
  const staff = c.get('staff');
  if (staff && (staff.role === 'owner' || staff.role === 'admin')) {
    await next();
    return;
  }
  const keys = staff?.permissionKeys ?? [];
  if (staff && keys.includes('/conversions') && keys.includes('conversion.approval.edit')) {
    await next();
    return;
  }
  return c.json({ success: false, error: 'この機能を操作する権限がありません' }, 403);
};

export type ApprovalDecision = 'approved' | 'rejected';
export type ApprovalRevision = 'pending' | 'approved' | 'rejected';

export function readApprovalDecision(body: { status?: unknown; expectedStatus?: unknown }):
  | { ok: true; status: ApprovalDecision; expectedStatus: ApprovalRevision }
  | { ok: false; error: string } {
  if (body.status !== 'approved' && body.status !== 'rejected') {
    return { ok: false, error: 'status must be approved or rejected' };
  }
  // 版の代わりに「いま見えている状態」を必ず送る。送らない・壊れている
  // 要求は保存せず400にする。
  if (body.expectedStatus !== 'pending' && body.expectedStatus !== 'approved' && body.expectedStatus !== 'rejected') {
    return { ok: false, error: 'expectedStatus must be pending, approved, or rejected' };
  }
  return { ok: true, status: body.status, expectedStatus: body.expectedStatus };
}

export /**
 * 承認確定で案件の動作を実行した結果、未完に残ったもの。
 *
 * `retryable` は「同じ承認をもう一度送れば走り直すか」。無効な参照は
 * 再送しても直らない（案件の設定を直す必要がある）ので false。
 */
interface OfferActionFailure {
  action: 'tag' | 'scenario';
  refId: string;
  reason: string;
  retryable: boolean;
}

export const OFFER_ACTION_FAILED_EVENT = 'affiliate_offer_action_failed';

export /**
 * 失敗を運用者が見る場所（通知センター）へ1件残す。
 *
 * 再送するたびに増えないよう、同じ成果・同じ動作の失敗は1件だけにする。
 * 通知の書き込み自体が落ちても本題を巻き添えにしない。
 */
async function notifyOfferActionFailure(
  db: D1Database,
  plan: ConversionOfferActionPlan,
  failure: OfferActionFailure,
): Promise<void> {
  try {
    const existing = await db
      .prepare(
        `SELECT id FROM notifications
          WHERE event_type = ? AND metadata LIKE ? AND metadata LIKE ?
          LIMIT 1`,
      )
      .bind(
        OFFER_ACTION_FAILED_EVENT,
        `%"conversionEventId":"${plan.eventId}"%`,
        `%"action":"${failure.action}"%`,
      )
      .first<{ id: string }>();
    if (existing) return;
    const actionLabel = failure.action === 'tag' ? 'タグ付与' : 'シナリオ開始';
    await createNotification(db, {
      eventType: OFFER_ACTION_FAILED_EVENT,
      title: '案件の動作を完了できませんでした',
      body:
        `成果の承認後に案件「${plan.offerName}」の${actionLabel}を実行できませんでした。` +
        (failure.retryable
          ? 'もう一度承認を送ると完了していない分だけやり直します。'
          : '案件に設定された参照が無効です。案件の設定を確認してください。') +
        ` 理由: ${failure.reason}`,
      channel: 'dashboard',
      category: 'error',
      lineAccountId: plan.offerAccountId,
      metadata: JSON.stringify({
        conversionEventId: plan.eventId,
        offerId: plan.offerId,
        action: failure.action,
        refId: failure.refId,
        retryable: failure.retryable,
        reason: failure.reason,
      }),
    });
  } catch (error) {
    logger.error("conversions.notify_offer_action_failure_failed");
  }
}

export /**
 * 承認確定時に、成果の帰属先案件に設定されたタグ付与・シナリオ開始を
 * 実行する。
 *
 * - 冪等: タグは attachTagAndFireSideEffects（friend_tags の INSERT OR IGNORE +
 *   friend_tag_side_effect_runs 台帳）、シナリオは enrollFriendInScenario の
 *   決定的な sourceEnrollmentId で、同じ判断の再送は二重実行にならない。
 *   already_set の再送でも呼ばれ、前回落ちた分の修復になる。
 * - 部分成功を成功にしない: どちらかが未完なら失敗を返し、呼び出し側は
 *   成功応答を返さない。失敗は通知センターにも残す。
 * - 古い不正参照（他アカウント・削除・無効）は黙って実行しない。実行計画の
 *   時点で所属と有効性を掛け直し、外れた参照は実行せず失敗として残す。
 *
 * 例外は投げない。個別の動作の失敗は戻り値へ集める。実行計画の読み込み
 * 自体の失敗だけは呼び出し側の catch へ任せる（マイル連携と同じ扱い）。
 */
async function runApprovedConversionOfferActions(
  db: D1Database,
  eventId: string,
): Promise<OfferActionFailure[]> {
  const plan = await getConversionOfferActionPlan(db, eventId);
  const failures: OfferActionFailure[] = [];
  if (!plan || (!plan.tagId && !plan.scenarioId)) return failures;

  if (plan.tagId) {
    const attached = await db
      .prepare(`SELECT 1 AS present FROM friend_tags WHERE friend_id = ? AND tag_id = ?`)
      .bind(plan.friendId, plan.tagId)
      .first<{ present: number }>();
    if (!attached && !plan.tagExecutable) {
      // まだ付いていないのに実行できない参照 = 実行してはいけない古い不正参照。
      failures.push({
        action: 'tag',
        refId: plan.tagId,
        reason: '案件に設定されたタグが存在しない・他アカウントのもの・またはアーカイブ済みです',
        retryable: false,
      });
    } else {
      // 付与済みなら参照の今の有効性は見ない — 付与は済んでいるので、
      // 台帳の未完工程の走り直しだけが残る（既存契約どおり）。
      let attachError: unknown = null;
      try {
        await attachTagAndFireSideEffects(db, plan.friendId, plan.tagId);
      } catch (error) {
        logger.error("conversions.run_approved_conversion_offer_actions_failed");
        attachError = error;
      }
      // 例外を投げない失敗（マイル工程・走り直し経路の失敗）も未完として拾う。
      // 台帳が正本なので、残っている工程があるなら完了とは言わない。
      // 読み取り自体が落ちたときは「未完なし」に見せかけず、そのまま上へ
      // 投げる — 単体は500、一括は failed に分かれる。
      const unfinished = await listUnfinishedFriendTagSideEffectRuns(db, plan.friendId, plan.tagId);
      if (attachError !== null || unfinished.length > 0) {
        failures.push({
          action: 'tag',
          refId: plan.tagId,
          reason:
            attachError instanceof Error
              ? attachError.message
              : `タグ付与後の処理が残っています（${unfinished.map((r) => r.step_key).join(', ')}）`,
          // 未完工程が全部自動で走り直せるものなら再送で修復する。止まった
          // 工程(走り直さないと決めたもの)が混ざるときは人の確認が要る。
          retryable: unfinished.every((r) => canAutoRetryFriendTagSideEffect(r)),
        });
      }
    }
  }

  if (plan.scenarioId) {
    const ongoing = await db
      .prepare(
        `SELECT 1 AS present FROM friend_scenarios
          WHERE friend_id = ? AND scenario_id = ? AND status != 'completed' LIMIT 1`,
      )
      .bind(plan.friendId, plan.scenarioId)
      .first<{ present: number }>();
    if (!ongoing) {
      if (!plan.scenarioExecutable) {
        failures.push({
          action: 'scenario',
          refId: plan.scenarioId,
          reason: '案件に設定されたシナリオが存在しない・他アカウントのもの・または停止中です',
          retryable: false,
        });
      } else {
        try {
          // 成果イベントIDを購読IDにする。完了済み（通0本）でも同じIDで
          // 既存行を回収するので、再送で同じシナリオが二重に始まらない。
          const enrollment = await enrollFriendInScenario(
            db,
            plan.friendId,
            plan.scenarioId,
            `conversion-offer:${eventId}`,
          );
          if (!enrollment) {
            const recheck = await db
              .prepare(
                `SELECT 1 AS present FROM friend_scenarios
                  WHERE friend_id = ? AND scenario_id = ? AND status != 'completed' LIMIT 1`,
              )
              .bind(plan.friendId, plan.scenarioId)
              .first<{ present: number }>();
            if (!recheck) {
              // 並行制限で弾かれた・公開版が無い等。登録は起きていない。
              failures.push({
                action: 'scenario',
                refId: plan.scenarioId,
                reason: 'シナリオを開始できませんでした（他のシナリオ実行中か、公開版がありません）',
                retryable: true,
              });
            }
          }
        } catch (error) {
          logger.error("conversions.run_approved_conversion_offer_actions_failed");
          failures.push({
            action: 'scenario',
            refId: plan.scenarioId,
            reason: error instanceof Error ? error.message : String(error),
            retryable: true,
          });
        }
      }
    }
  }

  for (const failure of failures) {
    await notifyOfferActionFailure(db, plan, failure);
  }
  return failures;
}

export /** 未完の動作を運用者向けの短い文言にする。応答と一括結果で共用。 */
function offerActionFailureMessage(failures: OfferActionFailure[]): string {
  const labels = failures.map((f) => (f.action === 'tag' ? 'タグ付与' : 'シナリオ開始'));
  const hasPermanent = failures.some((f) => !f.retryable);
  return (
    `成果は承認されましたが、案件の動作（${[...new Set(labels)].join('・')}）を完了できませんでした。` +
    (hasPermanent
      ? '再送しても直らない項目があります。案件の設定と通知センターの詳細を確認してください。'
      : 'もう一度送ると完了していない分だけやり直します。')
  );
}

export /**
 * POST /api/conversions/approvals/bulk — まとめて承認・却下する。
 *
 * 単体と同じ契約を各対象へ適用する。結果は成功ID・競合ID・権限拒否ID・
 * その他失敗IDに分けて返し、途中失敗を全成功と表示させない。
 */
const BULK_APPROVAL_MAX_ITEMS = 100;

export interface BulkApprovalItemResult {
  succeeded: string[];
  conflicted: Array<{ id: string; currentStatus: ApprovalRevision }>;
  denied: string[];
  failed: Array<{ id: string; error: string }>;
}

export async function isEventVisibleToStaff(db: D1Database, staff: AuthenticatedStaff | undefined, eventId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT cp.line_account_id FROM conversion_events ce
       JOIN conversion_points cp ON cp.id = ce.conversion_point_id
      WHERE ce.id = ?`,
  ).bind(eventId).first<{ line_account_id: string | null }>();
  if (!row) return false;
  return canAccessAllLineAccounts(db, staff, [row.line_account_id]);
}

export /** m22u : 一括の対象ごとの所属。行が無い・所属不明は null。 */
async function bulkItemAccountId(db: D1Database, eventId: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT cp.line_account_id AS line_account_id FROM conversion_events ce
       JOIN conversion_points cp ON cp.id = ce.conversion_point_id
      WHERE ce.id = ?`,
  ).bind(eventId).first<{ line_account_id: string | null }>();
  return row?.line_account_id ?? null;
}

export /**
 * m22u : 承認通知を「欠けた分だけ1回」送る。
 *
 * 承認状態（updated/already_set）と通知の送信状態を分け、同じ承認世代の
 * 通知は1回だけ送る。再試行の修復（already_set で版・マイルを補った場合）
 * でも、未送信ならここで送る。
 *
 * 順番は「送信権の確保→送信→失敗時だけ解放」。読み直しの send だけでは
 * 同じ判断の並行要求を止められない（両方が send=true を見て2件送る）ため、
 * markApprovalNotified の CAS 結果が送ってよいかの正本。負けた側は送らない。
 * 送信の途中で落ちたら記録を戻し、再試行で送り直せるようにする（欠落防止）。
 * 通知の失敗は承認を巻き添えにしない（best-effort）。
 */
async function notifyApprovalOnce(
  db: D1Database,
  env: Env['Bindings'],
  eventId: string,
): Promise<void> {
  try {
    const state = await getApprovalNotificationState(db, eventId);
    if (!state.send || !state.approvedAt) return;
    const info = await getConversionApprovalNotifyInfo(db, eventId);
    // 紹介者が成果の通知を切っているときは送信処理に進まない。
    if (!info || !info.notifyOnConversion) return;
    const claimed = await markApprovalNotified(db, eventId, state.approvedAt);
    if (!claimed) return;
    try {
      await notifyAffiliateApproval(db, env, info.affiliateId, info.offerName, info.rewardAmount,
        await createBroadcastRetryKey('affiliate-approval', eventId, state.approvedAt));
    } catch (err) {
      // 送信の途中で落ちたら同じ世代の記録だけ戻す。世代が変わって
      // いたら戻さない（新しい世代の未送信を消さない）。
      await releaseApprovalNotification(db, eventId, state.approvedAt);
      throw err;
    }
  } catch (err) {
    logger.error("conversions.notify_approval_once_failed");
  }
}
