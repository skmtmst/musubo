import { inputError } from '../lib/input-errors.js';
import { type Context, type MiddlewareHandler } from 'hono';
import { getFriendById, MileageV6Error, getMileageRedemption, updateMileageRewardDraft, MileageRewardError } from '@line-crm/db';
import type { ActionScoreFilter, ActionScoreSort, MileageEntryStatus, MileageEntryType, MileageRewardDraftInput } from '@line-crm/db';
import { fail } from '../lib/fail.js';


import type { Env } from '../worker-env.js';
import { auditLog } from '../lib/audit-log.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';

export function mileageRewardError(c: Parameters<typeof auditLog>[0], error: unknown) {
  if (error instanceof MileageRewardError) {
    return inputError(c, { success: false, error: error.message, code: error.code }, error.status as 400, []);
  }
  throw error;
}

export function mileageV6Error(c: Parameters<typeof auditLog>[0], error: unknown) {
  if (error instanceof MileageV6Error) {
    return inputError(c, {
      success: false,
      error: error.message,
      code: error.code,
      ...(error.field ? { field: error.field } : {}),
    }, error.status as 400, []);
  }
  throw error;
}

export function requireMileageExport(key: 'mileage.ledger.export' | 'action_score.list.export'): MiddlewareHandler<Env> {
  return async (c, next) => {
    const staff = c.get('staff');
    if (!staff || staff.readOnly || staff.role === 'staff'
        || (staff.role !== 'owner' && !staff.permissionKeys?.includes(key))) {
      return c.json({ success: false, error: 'CSVを書き出す権限がありません' }, 403);
    }
    return next();
  };
}

export async function canUseMileageAccount(c: Parameters<typeof auditLog>[0], accountId: string) {
  if (!accountId) return false;
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  return scope.allowedAccountIds.includes(accountId);
}

export /*
 * 友だちの可視検査。`friends.ts` の `requireVisibleFriend` と同じ約束:
 * 担当外・別アカウントの友だちは「いない」ものとして 404 を返す。
 * スコアの口だけ別実装にしないため、振る舞いをここに寄せる。
 */
const requireVisibleFriendForScore: MiddlewareHandler<Env> = async (c, next) => {
  const friend = await getFriendById(c.env.DB, c.req.param('id') ?? '');
  const accountId = (friend as unknown as Record<string, unknown> | null)?.line_account_id as string | null ?? null;
  if (!friend || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return fail(c, 404, 'FRIEND_NOT_FOUND');
  }
  await next();
};

export function publicMileageRedemption(redemption: Awaited<ReturnType<typeof getMileageRedemption>>) {
  if (!redemption) return null;
  const { idempotencyKey: _idempotencyKey, requestFingerprint: _requestFingerprint, ...safe } = redemption;
  return safe;
}

export async function handleMileageRewardDraftUpdate(c: Context<Env>) {
  try {
    const body = await c.req.json<{
      accountId?: unknown;
      expectedVersionId?: unknown;
      expectedRevision?: unknown;
      draft?: MileageRewardDraftInput;
    }>();
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    const expectedVersionId = typeof body.expectedVersionId === 'string'
      ? body.expectedVersionId.trim()
      : '';
    const expectedRevision = typeof body.expectedRevision === 'number'
      && Number.isInteger(body.expectedRevision) && body.expectedRevision >= 1
      ? body.expectedRevision
      : null;
    if (!await canUseMileageAccount(c, accountId)) {
      return c.json({ success: false, error: 'LINE公式アカウントが見つかりません' }, 404);
    }
    if (!body.draft || !expectedVersionId || expectedRevision == null) {
      return inputError(c, { success: false, error: '読み込んだ版と変更内容が必要です' }, 400, ["draft","expectedVersionId","expectedRevision"]);
    }
    const reward = await updateMileageRewardDraft(c.env.DB, {
      id: c.req.param('id') ?? '', lineAccountId: accountId, expectedVersionId, expectedRevision,
      updatedBy: c.get('staff').id, draft: body.draft,
    });
    auditLog(c, 'mileage.reward.update', { kind: 'mileage_reward', id: reward.id });
    return c.json({ success: true, data: reward });
  } catch (error) {
    return mileageRewardError(c, error);
  }
}

export const MILEAGE_REDEMPTION_LIST_STATUSES = new Set<string>([
  'all', 'needs_attention', 'reserved', 'delivering', 'succeeded', 'delivery_failed', 'refunded', 'cancelled',
]);

export const MILEAGE_ENTRY_TYPES = new Set<MileageEntryType>([
  'grant', 'reversal', 'spend', 'expiration', 'adjustment',
]);
export const MILEAGE_ENTRY_STATUSES = new Set<MileageEntryStatus>(['pending', 'available', 'void']);
export const MILEAGE_MODES = new Set(['automatic', 'manual'] as const);

export const MILEAGE_ADJUSTMENT_REASON_CATEGORIES = new Set([
  'customer_support',
  'order_correction',
  'grant_correction',
  'campaign',
  'other',
]);

export // 決めごとのCSVはサーバー側で作る。許可scope内の決めごとだけを出し、
// 既存の監査契約へ残す。ブラウザだけで権限判定を完結させない。
// 表示側(apps/web/src/app/mileage/page.tsx)の列・文言とそろえる。
const MILEAGE_RULE_EVENT_LABELS: Record<string, string> = {
  friend_added: '友だち登録',
  message_received: 'メッセージ',
  link_clicked: 'リンククリック',
  broadcast_link_clicked: '配信リンククリック',
  form_submitted: 'フォーム',
  booking_created: '予約',
  affiliate_conversion_approved: '紹介成果',
  webinar_watch_5m: 'ウェビナー',
  webinar_watch_15m: 'ウェビナー',
  webinar_completed: 'ウェビナー完了',
  webinar_cta_clicked: 'ウェビナーCTA',
  instagram_dm_received: 'Instagram DM',
  instagram_comment_created: 'Instagramコメント',
  instagram_story_mentioned: 'ストーリーズ',
  instagram_line_returned: 'LINE帰還',
  inflow_return: 'LINE帰還',
  friend_registered: '友だち登録',
  friend_following_7d: '継続7日',
  friend_following_30d: '継続30日',
  friend_following_90d: '継続90日',
  friend_following_180d: '継続180日',
  friend_following_365d: '継続1年',
  purchase_completed: '購入完了',
};

export function mileageRuleEventLabel(eventType: string): string {
  return MILEAGE_RULE_EVENT_LABELS[eventType] ?? 'その他の行動';
}

export function mileageCsvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export type MileageRuleCreateInput = {
  name: string;
  eventType: string;
  source: string | null;
  amount: number;
  initialStatus?: 'pending' | 'available';
  conditions?: {
    dailyCapActions?: number;
    uniquePerSubject?: boolean;
    uniquePerSubjectPerDay?: boolean;
    ignoreMultiplier?: boolean;
    beneficiary?: 'actor' | 'referrer';
    uniquePerReferredFriend?: boolean;
    uniquePerReferredFriendPerSubject?: boolean;
  } | null;
  validFrom: string | null;
  validUntil: string | null;
  lineAccountId: string;
  /** DRAFT-01: false なら最初のINSERTから停止。省略は従来どおり稼働。 */
  isActive?: boolean;
};

export // ========== 行動スコア（17-2） ==========

const ACTION_SCORE_FILTERS = new Set<ActionScoreFilter>(['all', 'high', 'normal', 'low', 'decreased']);
export const ACTION_SCORE_SORTS = new Set<ActionScoreSort>([
  'score_desc', 'score_asc', 'change_desc', 'change_asc', 'recent_desc',
]);

export // ========== スコアリングルールCRUD ==========

const legacyScoringRetired: MiddlewareHandler<Env> = async c => c.json({ success: false, code: 'LEGACY_SCORING_RETIRED', error: 'アカウントを指定する /api/action-scores/rules を利用してください' }, 410);
