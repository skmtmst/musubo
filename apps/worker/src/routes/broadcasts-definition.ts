import { logger } from '@line-crm/shared/server';
import { parseJsonArray, parseJsonObject } from './broadcast-json.js';
import type { Context } from 'hono';
import { RETRYABLE_UNSENT_CLAIM_SQL, countBroadcastLedger, countRetryableRecipients, isTemporaryLedgerErrorCode, deriveBroadcastDisplayStatus, recordBroadcastLifecycleEvent, BROADCAST_DISPLAY_STATUS_LABELS, recordAuditEvent, maskAuditIp, auditDeviceFamily } from '@line-crm/db';
import type { BroadcastDisplayStatus } from '@line-crm/db';
import type { Broadcast as DbBroadcast, BroadcastMessageType, BroadcastTargetType } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { processQueuedBroadcasts } from '../features/broadcasts/broadcast/index.js';
import { parseBroadcastDeliveryLimit, type SegmentCondition } from '@line-crm/shared';
import { assertAnalyticsAudiencesUsable, BroadcastAudienceError } from '../services/segment-audience-guard.js';
import type { Env } from '../worker-env.js';
import { hasStaffPermission } from '../middleware/role-guard.js';
import { getUnsupportedBroadcastVariables } from '../services/render-message.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { resolveRequestBoundaries } from '../services/request-boundary.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ACCOUNT_ACCESS_ERROR = 'このLINEアカウントを操作する権限がありません';
export const BROADCAST_NOTIFICATION_KEY = 'broadcast_slack_notifications';
export type BroadcastNotificationSettings = { started: boolean; completed: boolean; failed: boolean };
export const DEFAULT_BROADCAST_NOTIFICATIONS: BroadcastNotificationSettings = {
  started: true, completed: true, failed: true,
};

export function notificationSentence(settings: BroadcastNotificationSettings): string {
  const labels = [settings.started && '開始', settings.completed && '完了', settings.failed && 'エラー'].filter(Boolean);
  return labels.length > 0
    ? `配信${labels.join('・')}はSlackの同じスレッドへ通知します。`
    : 'この配信のSlack通知はありません。';
}

export function broadcastAccountIds(broadcast: DbBroadcast): Array<string | null> {
  const raw = broadcast as unknown as Record<string, unknown>;
  return broadcast.target_type === 'multi-account-dedup'
    ? (parseJsonArray(raw.account_ids) ?? [null])
    : [(raw.line_account_id as string | null | undefined) ?? null];
}

export async function canAccessBroadcast(
  db: D1Database,
  staff: AuthenticatedStaff | undefined,
  broadcast: DbBroadcast,
): Promise<boolean> {
  return canAccessAllLineAccounts(db, staff, broadcastAccountIds(broadcast));
}

export /**
 * 配信の作成・更新・送信の共通境界(＋-06 §6)。
 *
 * owner/adminは従来の範囲確認だけ通す(動作・状態を変えない)。一般staffは
 * /broadcasts に加え、操作ごとの個別キー（下書き・送信など）も要る。
 * readOnlyは土台が拒否する。
 */
async function broadcastWriteBoundary(
  c: Context<Env>,
  accountIds: Array<string | null | undefined>,
  options?: { operationKey?: string },
): Promise<{ allowed: true } | { allowed: false; reason: 'forbidden' | 'outside-scope' }> {
  const staff = c.get('staff');
  if (staff && (staff.role === 'owner' || staff.role === 'admin')) {
    const ok = await canAccessAllLineAccounts(c.env.DB, staff, accountIds);
    return ok ? { allowed: true } : { allowed: false, reason: 'outside-scope' };
  }
  const decision = await resolveRequestBoundaries(c.env.DB, staff, accountIds, {
    requiredPermissionKey: '/broadcasts',
  });
  if (!decision.allowed) {
    return { allowed: false, reason: decision.reason === 'forbidden' ? 'forbidden' : 'outside-scope' };
  }
  // 範囲の中でも、操作ごとの個別キーが要る。無いstaffはここで止める。
  // 範囲外は先に 404 で伏せるため、この順番を変えない。
  if (options?.operationKey && !hasStaffPermission(c, options.operationKey)) {
    return { allowed: false, reason: 'forbidden' };
  }
  return { allowed: true };
}

export function unsupportedVariablesError(content: string): string | null {
  const unsupported = getUnsupportedBroadcastVariables(content);
  return unsupported.length > 0
    ? `Unsupported broadcast variables: ${unsupported.map((v) => `{{${v}}}`).join(', ')}`
    : null;
}

export type CreateBroadcastBody = {
  title?: string;
  messageType?: BroadcastMessageType;
  messageContent?: string;
  messageBubbles?: unknown[];
  targetType: BroadcastTargetType;
  targetTagId?: string | null;
  scheduledAt?: string | null;
  lineAccountId?: string | null;
  altText?: string | null;
  accountIds?: string[];
  dedupPriority?: string[];
  trackLinks?: boolean;
  /** 何分かけて配るか。0（既定）は一気に送る */
  stealthSpreadMinutes?: number;
  /** 絞り込み条件。targetType が 'segment' のときに使う */
  segmentConditions?: unknown;
  /** 分類。null なら「未分類」 */
  folderId?: string | null;
  /** 開封数を取るか。既定は取る */
  measureOpens?: boolean;
  /** 途中の入力を残すだけで、送信可能とは扱わない。 */
  saveAsDraft?: boolean;
  draftStep?: 'basic' | 'audience' | 'message' | 'schedule' | 'confirm';
  internalMemo?: string | null;
  messageOptions?: unknown;
  confirmedRecipientCount?: unknown;
  afterActionVersionId?: string | null;
};

export const BROADCAST_DRAFT_STEPS = new Set(['basic', 'audience', 'message', 'schedule', 'confirm']);
export const STANDARD_CONDITION_AXES = [
  ['name', '名前'], ['private_memo', 'メモ'], ['status_message', 'ステータスメッセージ'],
  ['registered_at', '友だち登録日'], ['tag', 'タグ'], ['friend_field', '友だち情報'],
  ['scenario', 'シナリオ'], ['event_booking', 'イベント予約'], ['calendar_booking', 'カレンダー予約'],
  ['common_var', '共通情報'], ['reminder', 'リマインダ'], ['form_answered', '回答フォーム'],
  ['last_reaction_at', '最終反応日'], ['other', 'その他'], ['support_mark', '対応マーク'],
] as const;
export const BROADCAST_ONLY_CONDITION_AXES = [
  ['assigned_operator', '担当者'], ['inflow_route', '流入経路'], ['broadcast_status', '配信状況'],
  ['booking_status', '予約状況'], ['purchase_history', '購入履歴'], ['block_state', 'ブロック状態'],
] as const;

export function validateMessageOptions(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'ボタンの設定を読み込めませんでした';
  const options = value as { buttons?: unknown; resources?: unknown; deliveryLimit?: unknown; deliveryLimitConfirmation?: unknown };
  if (options.deliveryLimitConfirmation !== undefined) return '送信前の確認をやり直してください。';
  try { parseBroadcastDeliveryLimit(options.deliveryLimit); } catch (error) { return error instanceof Error ? error.message : '上限人数を確認してください。'; }
  if (options.buttons !== undefined) {
    // 監査 : 番号と不足項目を日本語で返す。画面の検査と文言をそろえる。
    if (!Array.isArray(options.buttons) || options.buttons.length > 4) return 'ボタンは4つまでです';
    for (const [index, button] of options.buttons.entries()) {
      const number = index + 1;
      if (!button || typeof button !== 'object' || Array.isArray(button)) return `ボタン${number}を読み込めませんでした`;
      const item = button as Record<string, unknown>;
      if (typeof item.label !== 'string' || !item.label.trim()) return `ボタン${number}の名前を入力してください`;
      if (Array.from(item.label.trim()).length > 20) return `ボタン${number}の名前は20文字までです`;
      if (!['url', 'pdf', 'postback'].includes(String(item.type))) return `ボタン${number}の種類を確認してください`;
      if (typeof item.value !== 'string' || !item.value.trim()) return `ボタン${number}のURLを入力してください`;
      if (item.type === 'postback' && item.value.length > 300) return `ボタン${number}の送る値は300文字までです`;
      if ((item.type === 'url' || item.type === 'pdf') && !/^https:\/\//i.test(item.value.trim())) {
        return `ボタン${number}のURLは https:// から始めてください`;
      }
    }
  }
  if (options.resources !== undefined) {
    if (!Array.isArray(options.resources)) return 'messageOptions.resources must be an array';
    for (const resource of options.resources) {
      if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return 'messageOptions.resources item must be an object';
      const item = resource as Record<string, unknown>;
      if (!['url', 'pdf'].includes(String(item.kind)) || typeof item.url !== 'string' || !/^https:\/\//i.test(item.url)) {
        return 'messageOptions resource must be an https URL or PDF';
      }
    }
  }
  return null;
}

export /*
 * 分析で作った一時対象者を条件に持つ配信の再確認。
 * 対象者は24時間で消えるため、下書き保存・送信直前のたびに所属と期限を
 * 見直す。他アカウント・消えた対象者は404、期限切れは410で拒否する
 * （friends の audienceId と同じ返し方）。
 */
async function rejectIfAudienceUnusable(
  c: Context<Env>,
  conditions: SegmentCondition | null,
  accountId: string | null,
): Promise<Response | null> {
  try {
    await assertAnalyticsAudiencesUsable(c.env.DB, conditions, accountId);
    return null;
  } catch (error) {
    if (error instanceof BroadcastAudienceError) {
      return error.blocker === 'audience_expired'
        ? c.json({ success: false, error: 'この分析結果の対象者は24時間を過ぎました。もう一度集計してください' }, 410)
        : c.json({ success: false, error: 'Not found' }, 404);
    }
    throw error;
  }
}

export function parseStoredSegmentConditions(stored: unknown): SegmentCondition | null {
  if (typeof stored !== 'string' || stored === '') return null;
  try {
    const parsed = JSON.parse(stored) as SegmentCondition;
    return Array.isArray(parsed?.rules) ? parsed : null;
  } catch {
    return null;
  }
}

export /*
 * 即時送信の直前再確認。作成・更新時と違い、取消・欠損・他アカウントを
 * 言い分けて運用者が判断できる文にする。送らない理由だけを見て、行は変えない。
 */
async function checkSendableAfterActionVersion(
  db: D1Database,
  lineAccountId: string | null,
  versionId: string | null | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!versionId) return { ok: true };
  if (!lineAccountId) {
    return { ok: false, error: '配信後アクションの公開版を確認できません。LINEアカウントを選び直してください' };
  }
  const row = await db.prepare(
    `SELECT cav.status AS version_status, ca.line_account_id AS owner_account, ca.status AS action_status
       FROM common_action_versions cav
       JOIN common_actions ca ON ca.id = cav.common_action_id
      WHERE cav.id = ?`,
  ).bind(versionId).first<{ version_status: string; owner_account: string | null; action_status: string }>();
  if (!row) {
    return { ok: false, error: '配信後アクションの公開版が見つかりません。下書きを開き直してください' };
  }
  if (row.owner_account !== lineAccountId) {
    return { ok: false, error: '配信後アクションが別のLINEアカウントのものです。同じアカウントの公開版を選び直してください' };
  }
  if (row.version_status !== 'published' || row.action_status !== 'published') {
    return { ok: false, error: '配信後アクションの公開が取り消されています。公開中の版を選び直してください' };
  }
  return { ok: true };
}

function publicMessageOptions(value: string | null | undefined): string | null {
  if (!value) return null;
  const options = parseJsonObject(value);
  if (!options) return null;
  delete options.deliveryLimitConfirmation;
  return JSON.stringify(options);
}

export function sameCreateRequest(existing: DbBroadcast, body: CreateBroadcastBody): boolean {
  const existingAccountIds = parseJsonArray(existing.account_ids) ?? [];
  const existingPriority = parseJsonArray(existing.dedup_priority) ?? [];
  return existing.title === (body.title?.trim() || '名称未設定')
    && existing.message_type === (body.messageType ?? 'text')
    && existing.message_content === (body.messageContent ?? '')
    && (existing.message_bubbles_json ?? null) === (body.messageBubbles ? JSON.stringify(body.messageBubbles) : null)
    && existing.target_type === (body.targetType ?? 'all')
    && existing.target_tag_id === (body.targetTagId ?? null)
    && existing.scheduled_at === (body.scheduledAt ?? null)
    && (existing.line_account_id ?? null) === (body.lineAccountId ?? null)
    && (existing.alt_text ?? null) === (body.altText ?? null)
    && JSON.stringify(existingAccountIds) === JSON.stringify(body.accountIds ?? [])
    && JSON.stringify(existingPriority) === JSON.stringify(body.dedupPriority ?? [])
    && existing.track_links === (body.trackLinks === false ? 0 : 1)
    && (existing.internal_memo ?? null) === (body.internalMemo ?? null)
    && (existing.draft_step ?? null) === (body.draftStep ?? null)
    && publicMessageOptions(existing.message_options_json) === (body.messageOptions == null ? null : JSON.stringify(body.messageOptions))
    && (existing.after_action_version_id ?? null) === (body.afterActionVersionId ?? null);
}

export function serializeBroadcast(row: DbBroadcast) {
  const r = row as unknown as Record<string, unknown>;
  return {
    id: row.id,
    title: row.title,
    messageType: row.message_type,
    messageContent: row.message_content,
    messageBubbles: row.message_bubbles_json ? JSON.parse(row.message_bubbles_json) as unknown[] : null,
    targetType: row.target_type,
    targetTagId: row.target_tag_id,
    status: row.status,
    purpose:r.purpose??'marketing',executionMode:r.execution_mode??'live',testMode:r.execution_mode==='simulation',createdVia:r.created_via??'manual',
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    totalCount: row.total_count,
    successCount: row.success_count,
    lineRequestId: r.line_request_id || null,
    aggregationUnit: r.aggregation_unit || null,
    lineAccountId: r.line_account_id || null,
    hqRunId: r.hq_run_id ?? null,
    fromHeadquarters: !!r.hq_run_id,
    editable: !r.hq_run_id,
    accountIds: parseJsonArray(r.account_ids),
    dedupPriority: parseJsonArray(r.dedup_priority),
    failedAccountIds: parseJsonArray(r.failed_account_ids),
    // 046 以前の行/未マイグレーション環境では undefined → 従来挙動 (ON) 扱い
    trackLinks: row.track_links === undefined ? true : row.track_links !== 0,
    /*
     * 宛先の条件。一覧で「何で絞ったか」を出すために返す。
     *
     * これが無いと、詳細条件で絞った配信も一覧では「タグ指定」と出る。
     * 送った相手を後から確かめられないので、監査にならない。
     */
    segmentConditions: r.segment_conditions
      ? (() => { try { return JSON.parse(String(r.segment_conditions)) as unknown } catch { return null } })()
      : null,
    // 一覧のフォルダ分類と予約完了の設定表示に使う。DBには保存されていたが、
    // APIで落としていたため、再読込すると全件が「未分類」に見えていた。
    folderId: (r.folder_id as string | null | undefined) ?? null,
    /*
     * 一覧に載せる集計の最新値。送信済みごとに insight 口を叩く N+1 を
     * なくすため、一覧クエリで既に読んだ行をそのまま返す。集計行が無い
     * (未送信・未取得)ときは null で、画面は手動の取得ボタンを出す。
     */
    insightSummary: (r.insight_id as string | null | undefined) == null ? null : {
      delivered: r.insight_delivered == null ? null : Number(r.insight_delivered),
      uniqueImpression: r.insight_unique_impression == null ? null : Number(r.insight_unique_impression),
      uniqueClick: r.insight_unique_click == null ? null : Number(r.insight_unique_click),
      openRate: (r.open_rate as number | null | undefined) ?? null,
      clickRate: (r.click_rate as number | null | undefined) ?? null,
    },
    measureOpens: r.measure_opens === undefined ? true : Number(r.measure_opens) !== 0,
    internalMemo: (r.internal_memo as string | null | undefined) ?? null,
    draftStep: (r.draft_step as string | null | undefined) ?? null,
    draftPayload: parseJsonObject(r.draft_payload_json),
    stealthSpreadMinutes: Number(r.stealth_spread_minutes ?? 0),
    messageOptions: parseJsonObject(publicMessageOptions(r.message_options_json as string | null)),
    afterActionVersionId: (r.after_action_version_id as string | null | undefined) ?? null,
    version: Number(r.lock_version ?? 1),
    /*
     * 停止の状態。
     *
     * status は動かしていない。停止は送信の段階（下書き→予約→送信中→
     * 送信済み）とは別の軸——「送信中だが、新しい送信権をもう取らない」
     * ——なので、画面はこの2つを合わせて読む。`status === 'sending' &&
     * stopped === true` が「停止中」。
     */
    stopped: !!r.stopped_at,
    stoppedAt: (r.stopped_at as string | null | undefined) ?? null,
    sendAttemptNo: Number(r.send_attempt_no ?? 1),
    /*
     * 二者承認の今の状態。送信の段階（status）とは別の軸。
     * 未マイグレーション環境では undefined → 画面は承認なしとして扱う。
     */
    approvalStatus: (r.approval_status as string | null | undefined) ?? 'none',
    approvalRequestedByStaffId: (r.approval_requested_by_staff_id as string | null | undefined) ?? null,
    approvalRequestedAt: (r.approval_requested_at as string | null | undefined) ?? null,
    approvalApproverStaffId: (r.approval_approver_staff_id as string | null | undefined) ?? null,
    approvalNote: (r.approval_note as string | null | undefined) ?? null,
    approvalDecidedByStaffId: (r.approval_decided_by_staff_id as string | null | undefined) ?? null,
    approvalDecidedAt: (r.approval_decided_at as string | null | undefined) ?? null,
    approvalRejectReason: (r.approval_reject_reason as string | null | undefined) ?? null,
    createdAt: row.created_at,
  };
}

/**
 * 一斉配信の10の状態。
 *
 * `status` の CHECK は変えられないので、status・承認・停止・台帳の集計から
 * 組み立てる。二者承認（#A）の軸（承認待ち・期限切れ）と整合させる。
 */
export interface BroadcastStatusView {
  displayStatus: BroadcastDisplayStatus;
  displayStatusLabel: string;
  ledger: {
    sent: number;
    failed: number;
    failedTemporary: number;
    failedPermanent: number;
    unknown: number;
    inFlight: number;
    retryableCount: number;
  };
}

export async function failedBreakdown(db: D1Database, id: string): Promise<{ temporary: number; permanent: number }> {
  const rows = await db
    .prepare(
      `SELECT error_code, COUNT(*) AS cnt FROM broadcast_send_claims
        WHERE broadcast_id = ? AND state = 'failed' AND COALESCE(error_code,'') NOT LIKE 'simulation_%' GROUP BY error_code`,
    )
    .bind(id)
    .all<{ error_code: string | null; cnt: number }>();
  let temporary = 0;
  let permanent = 0;
  for (const row of rows.results ?? []) {
    if (isTemporaryLedgerErrorCode(row.error_code)) temporary += Number(row.cnt);
    else permanent += Number(row.cnt);
  }
  return { temporary, permanent };
}

export async function broadcastStatusView(
  db: D1Database,
  row: Record<string, unknown>,
): Promise<BroadcastStatusView> {
  const id = String(row.id);
  const [counts, breakdown, retryableCount] = await Promise.all([
    countBroadcastLedger(db, id),
    failedBreakdown(db, id),
    countRetryableRecipients(db, id),
  ]);
  const ledgerRows = counts.sent + counts.failed + counts.unknown + counts.claimed;
  const displayStatus = deriveBroadcastDisplayStatus({
    status: String(row.status ?? 'draft'),
    approvalStatus: (row.approval_status as string | null | undefined) ?? 'none',
    scheduledAt: (row.scheduled_at as string | null | undefined) ?? null,
    stopped: !!(row.stopped_at),
    sent: counts.sent,
    failed: counts.failed,
    unknown: counts.unknown,
    ledgerRows,
  });
  return {
    displayStatus,
    displayStatusLabel: row.execution_mode==='simulation'&&row.status==='sent'?'模擬で確認済み':BROADCAST_DISPLAY_STATUS_LABELS[displayStatus],
    ledger: {
      sent: counts.sent,
      failed: counts.failed,
      failedTemporary: breakdown.temporary,
      failedPermanent: breakdown.permanent,
      unknown: counts.unknown,
      inFlight: Math.max(0, counts.claimed - Math.max(0, retryableCount - breakdown.temporary)),
      retryableCount,
    },
  };
}

export /**
 * 一覧ぶんの台帳集計を1〜2回の問い合わせで取る。
 * D1 のバインド上限（100）に当てないよう50件ずつに分ける。
 */
async function ledgerCountsForBroadcasts(
  db: D1Database,
  ids: string[],
): Promise<Map<string, { sent: number; failed: number; unknown: number; claimed: number; temp: number; perm: number }>> {
  const map = new Map<string, { sent: number; failed: number; unknown: number; claimed: number; temp: number; perm: number }>();
  for (const id of ids) {
    map.set(id, { sent: 0, failed: 0, unknown: 0, claimed: 0, temp: 0, perm: 0 });
  }
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const placeholders = chunk.map(() => '?').join(', ');
    const [states, failed] = await Promise.all([
      db.prepare(
        `SELECT broadcast_id, state, COUNT(*) AS cnt FROM broadcast_send_claims
          WHERE broadcast_id IN (${placeholders}) AND COALESCE(error_code,'') NOT LIKE 'simulation_%' GROUP BY broadcast_id, state`,
      ).bind(...chunk).all<{ broadcast_id: string; state: string; cnt: number }>(),
      db.prepare(
        `SELECT broadcast_id, error_code, COUNT(*) AS cnt FROM broadcast_send_claims
          WHERE broadcast_id IN (${placeholders}) AND state = 'failed' AND COALESCE(error_code,'') NOT LIKE 'simulation_%' GROUP BY broadcast_id, error_code`,
      ).bind(...chunk).all<{ broadcast_id: string; error_code: string | null; cnt: number }>(),
    ]);
    for (const row of states.results ?? []) {
      const entry = map.get(row.broadcast_id);
      if (!entry) continue;
      const count = Number(row.cnt);
      if (row.state === 'sent') entry.sent = count;
      else if (row.state === 'failed') entry.failed = count;
      else if (row.state === 'unknown') entry.unknown = count;
      else if (row.state === 'claimed') entry.claimed = count;
    }
    for (const row of failed.results ?? []) {
      const entry = map.get(row.broadcast_id);
      if (!entry) continue;
      if (isTemporaryLedgerErrorCode(row.error_code)) entry.temp += Number(row.cnt);
      else entry.perm += Number(row.cnt);
    }
  }
  return map;
}

export /**
 * 操作の記録（migration 459）。書けなくても本処理は止めない。
 * 止めると「止めたのに記録が無い」より「記録が無いのに止まった」になる——
 * どちらも困るが、送信の安全を優先し、失敗は console に残す。
 */
async function recordLifecycle(
  db: D1Database,
  broadcastId: string,
  actorStaffId: string | null | undefined,
  action: 'created' | 'updated' | 'scheduled' | 'send_started' | 'stopped' | 'resumed' | 'retried' | 'cancelled',
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await recordBroadcastLifecycleEvent(db, {
      broadcastId,
      actorStaffId: actorStaffId ?? null,
      action,
      detail: detail ?? null,
    });
  } catch (err) {
    logger.error("broadcasts.record_lifecycle_failed");
  }
}

export // GET /api/broadcasts/:id/recipients — 宛先台帳
//
// 宛先ごとに結果（届いた・失敗の理由・送る前）・時刻・LINEの要求IDを返す。
// 失敗の理由は人の言葉に直して返す（classifyBroadcastRecipient）。
// 台帳の行が無い相手（まだ送っていない）は名前が無いので、件数だけ返す。
// 完了済みの旧配信は台帳を捏造せず、集約だけ返す。
const RECIPIENT_TEMPORARY_CODES = "('line_http_429', 'stopped_before_dispatch')";

export function recipientResultFilter(result: string): string {
  switch (result) {
    case 'delivered':
      return ` AND c.state = 'sent'`;
    case 'temporary':
      return ` AND ((c.state = 'failed' AND c.error_code IN ${RECIPIENT_TEMPORARY_CODES}) OR ${RETRYABLE_UNSENT_CLAIM_SQL})`;
    case 'permanent':
      return ` AND c.state = 'failed' AND (c.error_code NOT IN ${RECIPIENT_TEMPORARY_CODES} OR c.error_code IS NULL)`;
    case 'unknown':
      return ` AND c.state = 'unknown'`;
    case 'inflight':
      return ` AND c.state = 'claimed' AND NOT ${RETRYABLE_UNSENT_CLAIM_SQL}`;
    default:
      return '';
  }
}

export /**
 * cron（5分間隔）を待たずに、その場でキュー処理を始める。
 *
 * 使えない環境（単体試験など）では黙って cron に任せる。**起動に失敗しても
 * 送れなくなるわけではない**ので、応答は成功のまま返す。
 */
function kickQueueProcessing(c: Context<Env>, label: string): void {
  try {
    const ctx = c.executionCtx as ExecutionContext;
    const defaultClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    ctx.waitUntil(
      processQueuedBroadcasts(c.env.DB, defaultClient, c.env.WORKER_URL).catch((err) => {
        logger.error("broadcasts.kick_queue_processing_failed");
      }),
    );
  } catch (kickErr) {
    logger.warn("broadcasts_definition.kick_queue_processing_failed");
  }
}

export /*
 * ───────── 送信中の一斉配信を止める／再開する／失敗した相手だけ送り直す ─────────
 *
 *  /。これまで `sending` に入った配信を止める正式な経路が無かった。
 *
 * 3つの口はどれも**版付きの条件付き UPDATE 1本**で決める。読んでから書くと、
 * 2人が同時に押したときに両方が「自分が勝った」と読む。変わった行数を見て、
 * 1 だった者だけが先へ進む。画面側の連打防止（押している間ボタンを無効に
 * する）は見た目の手当てで、**本当の守りはここ**。
 */

/** 停止・再送でキューへ載せ直すための絞り込みの印。 */
function queueMarkerFor(broadcast: DbBroadcast): string | null {
  const raw = broadcast as unknown as Record<string, unknown>;
  // 既に条件が入っていればそれを使う（segment 配信・500人超の tag 配信）。
  if (raw.segment_conditions) return null;
  // 500人以下の tag 配信はその場で送り切る作りでキューを通らない。再開・再送では
  // 500人超の経路と同じ印を書いて、キュー側（processQueuedBroadcastBatches）へ寄せる。
  if (broadcast.target_type === 'tag' && broadcast.target_tag_id) {
    return JSON.stringify({
      operator: 'AND',
      rules: [{ type: 'tag_exists', value: broadcast.target_tag_id }],
    });
  }
  return null;
}

export function parseExpectedVersion(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

export /**
 * 監査へ1件だけ残す。
 *
 * `auditRecorded` を立てて、共通の記録（api.post./api/…）と二重にしない。
 * `await` するのは、止めた・再開した・送り直したという判断そのものが
 * 後から追えないと困るため。取りこぼしを待たない口（waitUntil）には載せない。
 */
async function recordBroadcastControlAudit(
  c: Context<Env>,
  action: 'broadcast.stop' | 'broadcast.resume' | 'broadcast.retry_failed',
  broadcast: DbBroadcast,
  after: Record<string, unknown>,
): Promise<void> {
  const staff = c.get('staff');
  c.set('auditRecorded', true);
  const raw = broadcast as unknown as Record<string, unknown>;
  try {
    await recordAuditEvent(c.env.DB, {
      tenantId: staff?.tenantId,
      lineAccountId: (raw.line_account_id as string | null | undefined) ?? null,
      category: 'business',
      actorPrincipalId: staff?.id,
      actorRole: staff?.role,
      action,
      targetKind: 'broadcast',
      targetId: broadcast.id,
      result: 'success',
      after,
      requestTraceId: c.req.header('cf-ray') ?? c.req.header('x-request-id') ?? null,
      ipPrefix: maskAuditIp(c.req.header('cf-connecting-ip')),
      deviceFamily: auditDeviceFamily(c.req.header('user-agent')),
    });
  } catch (err) {
    logger.error("broadcasts.record_broadcast_control_audit_failed");
  }
}

export /** 台帳の数え上げと再送対象数。画面と応答で同じ数を使う。 */
async function broadcastLedgerSummary(db: D1Database, id: string) {
  const [counts, breakdown, retryableCount] = await Promise.all([
    countBroadcastLedger(db, id),
    failedBreakdown(db, id),
    countRetryableRecipients(db, id),
  ]);
  return {
    sent: counts.sent,
    failed: counts.failed,
    failedTemporary: breakdown.temporary,
    failedPermanent: breakdown.permanent,
    unknown: counts.unknown,
    inFlight: Math.max(0, counts.claimed - Math.max(0, retryableCount - breakdown.temporary)),
    // 再送できる未送信の宛先も含む。
    retryableCount,
  };
}

export
//
// D026: 下書き・予約だけ消す。送信中は 409（止めるには停止を使う）、
// 送信済みは 409（配信の記録は残す）。画面は draft/scheduled にしか
// 削除を出さないが、API 直接の削除も status で断つ。
// 読み取りの直後に送信が始まっても消さないよう、状態の確認と削除を
// 条件付き DELETE の1文にまとめる（cancel の UPDATE 側再確認と同じ）。
function broadcastDeleteConflictMessage(status: string): string {
  return status === 'sending'
    ? '送信中の配信は削除できません。配信を止めるには停止を使ってください'
    : '送信済みの配信は削除できません。配信の記録は残ります';
}
