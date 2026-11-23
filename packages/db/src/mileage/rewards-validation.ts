import { type MileageRewardKind, type MileageRewardFailurePolicy, type MileageRewardTargetCondition, type MileageRewardDraftInput, type RewardRow, type MileageRewardVersion, type MileageRewardSummary } from './rewards-types.js';


export class MileageRewardError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = 'MileageRewardError';
  }
}

export const REWARD_KINDS = new Set<MileageRewardKind>([
  'coupon', 'handgift', 'tag', 'scenario', 'template', 'early_access', 'rank',
]);
export const FAILURE_POLICIES = new Set<MileageRewardFailurePolicy>(['retry', 'refund', 'manual']);
export const TARGET_CONDITION_TYPES = new Set([
  'tag_exists', 'tag_not_exists', 'tag_all', 'tag_not_all',
  'metadata_equals', 'metadata_not_equals', 'ref_code', 'is_following',
  'scenario_subscribed', 'name', 'private_memo', 'status_message',
  'registered_at', 'support_mark', 'is_hidden', 'friend_field',
  'scenario_state', 'form_answered', 'last_reaction_at', 'reaction_state',
  'score_range',
]);

export function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MileageRewardError('required', `${label}を入力してください`);
  }
  const text = value.trim();
  if (text.length > max) throw new MileageRewardError('too_long', `${label}は${max}文字までです`);
  return text;
}

export function optionalText(value: unknown, label: string, max: number): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new MileageRewardError('invalid_text', `${label}を確認してください`);
  const text = value.trim();
  if (text.length > max) throw new MileageRewardError('too_long', `${label}は${max}文字までです`);
  return text || null;
}

export function positiveInteger(value: unknown, label: string, optional = false): number | null {
  if (optional && (value == null || value === '')) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new MileageRewardError('invalid_number', `${label}は1以上の整数で入力してください`);
  }
  return parsed;
}

/*
 * 在庫だけは 0 が意味を持つ（品切れ）。空欄は無制限、0 は品切れ、
 * 正の整数は上限。画面の案内と交換判定（0 なら常に在庫切れ）と揃える。
 */
export function nonNegativeInteger(value: unknown, label: string): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new MileageRewardError('invalid_number', `${label}は0以上の整数で入力してください`);
  }
  return parsed;
}

export function optionalDate(value: unknown, label: string): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw new MileageRewardError('invalid_date', `${label}を確認してください`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new MileageRewardError('invalid_date', `${label}を確認してください`);
  }
  // 時差付きのまま保存すると文字列比較で期間を誤判定する。
  // 保存時にUTCへ正規化し、比較は同じ基準の時刻値で行う。
  return parsed.toISOString();
}

export function validateRewardTargetConditions(value: unknown): MileageRewardTargetCondition | null {
  if (value === null || value === undefined) return null;
  let count = 0;
  const visit = (candidate: unknown, depth: number): MileageRewardTargetCondition => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || depth > 3) {
      throw new MileageRewardError('target_conditions_invalid', '交換できる友だちの条件を確認してください');
    }
    const raw = candidate as Record<string, unknown>;
    if ((raw.operator !== 'AND' && raw.operator !== 'OR') || !Array.isArray(raw.rules)) {
      throw new MileageRewardError('target_conditions_invalid', '交換できる友だちの条件を確認してください');
    }
    const rules = raw.rules.map((rule) => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        throw new MileageRewardError('target_conditions_invalid', '交換できる友だちの条件を確認してください');
      }
      const typed = rule as Record<string, unknown>;
      if (typeof typed.type !== 'string' || !TARGET_CONDITION_TYPES.has(typed.type)) {
        throw new MileageRewardError('target_condition_type_invalid', '利用できない交換条件があります');
      }
      count += 1;
      if (count > 15) {
        throw new MileageRewardError('target_conditions_too_many', '交換条件は15件までです');
      }
      return { type: typed.type, value: typed.value };
    });
    const groups = raw.groups === undefined
      ? undefined
      : Array.isArray(raw.groups) ? raw.groups.map((group) => visit(group, depth + 1)) : null;
    if (groups === null) {
      throw new MileageRewardError('target_conditions_invalid', '交換できる友だちの条件を確認してください');
    }
    return { operator: raw.operator, rules, ...(groups ? { groups } : {}) };
  };
  const parsed = visit(value, 0);
  if (JSON.stringify(parsed).length > 16_384) {
    throw new MileageRewardError('target_conditions_too_large', '交換条件が長すぎます');
  }
  return parsed;
}

export function validateMileageRewardDraft(value: MileageRewardDraftInput): Required<
  Omit<MileageRewardDraftInput, 'description' | 'imageUrl' | 'stockLimit' | 'perFriendLimit' | 'targetConditions'>
> & {
  description: string | null;
  imageUrl: string | null;
  stockLimit: number | null;
  perFriendLimit: number | null;
  targetConditions: MileageRewardTargetCondition | null;
} {
  const rewardKind = value.rewardKind;
  if (!REWARD_KINDS.has(rewardKind)) {
    throw new MileageRewardError('invalid_kind', '使い道の種類を選んでください');
  }
  const failurePolicy = value.failurePolicy ?? 'retry';
  if (!FAILURE_POLICIES.has(failurePolicy)) {
    throw new MileageRewardError('invalid_failure_policy', '失敗したときの扱いを確認してください');
  }
  const startsAt = optionalDate(value.startsAt, '交換開始日時');
  const endsAt = optionalDate(value.endsAt, '交換終了日時');
  if (startsAt && endsAt && startsAt >= endsAt) {
    throw new MileageRewardError('invalid_period', '交換終了は交換開始より後にしてください');
  }
  const commonActionVersionId = optionalText(value.commonActionVersionId, '交換後の動き', 100);
  if (rewardKind === 'handgift' && commonActionVersionId) {
    throw new MileageRewardError('invalid_action', '手渡し景品には交換後の動きを設定できません');
  }
  if (rewardKind !== 'coupon' && rewardKind !== 'handgift' && !commonActionVersionId) {
    throw new MileageRewardError('action_required', '交換後に渡すものを選んでください');
  }
  return {
    name: requiredText(value.name, '使い道の名前', 120),
    description: optionalText(value.description, '説明', 1000),
    imageUrl: optionalText(value.imageUrl, '画像URL', 2000),
    rewardKind,
    requiredMiles: positiveInteger(value.requiredMiles, '必要マイル')!,
    stockLimit: nonNegativeInteger(value.stockLimit, '在庫数'),
    perFriendLimit: positiveInteger(value.perFriendLimit, '1人あたりの交換上限', true),
    startsAt,
    endsAt,
    benefitExpiresDays: positiveInteger(value.benefitExpiresDays, '交換後の有効日数', true),
    commonActionVersionId,
    targetConditions: validateRewardTargetConditions(value.targetConditions),
    failurePolicy,
    customerMessage: optionalText(value.customerMessage, '交換後の案内', 1000) ?? '',
  };
}

export function mapVersion(row: RewardRow): MileageRewardVersion | null {
  if (!row.version_id || row.version_number == null || !row.version_status || row.required_miles == null) return null;
  return {
    id: row.version_id,
    versionNumber: row.version_number,
    status: row.version_status,
    revision: row.revision ?? 1,
    requiredMiles: row.required_miles,
    stockLimit: row.stock_limit,
    perFriendLimit: row.per_friend_limit,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    benefitExpiresDays: row.benefit_expires_days,
    commonActionVersionId: row.common_action_version_id,
    targetConditions: row.target_conditions ? JSON.parse(row.target_conditions) as MileageRewardTargetCondition : null,
    failurePolicy: row.failure_policy ?? 'retry',
    customerMessage: row.customer_message ?? '',
    publishedAt: row.published_at,
  };
}

export function mapReward(row: RewardRow): MileageRewardSummary {
  return {
    id: row.id,
    folderId: row.folder_id ?? null,
    hqTemplateId: row.active_hq_template_id ?? null,
    lineAccountId: row.line_account_id,
    programId: row.program_id,
    name: row.name,
    description: row.description,
    imageUrl: row.image_url,
    rewardKind: row.reward_kind,
    status: row.status,
    sortOrder: row.sort_order,
    currentDraftVersionId: row.current_draft_version_id,
    currentPublishedVersionId: row.current_published_version_id,
    currentVersion: mapVersion(row),
    exchangedThisMonth: row.exchanged_this_month,
    availableCodeCount: row.reward_kind === 'coupon' ? row.available_code_count : null,
    benefitName: row.benefit_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rewardSelect(versionExpression: string): string {
  return `
  SELECT r.id, r.folder_id,
         (SELECT t.id FROM hq_templates t JOIN line_accounts a ON a.tenant_id = t.tenant_id
           WHERE t.id = r.hq_template_id AND a.id = r.line_account_id AND t.archived_at IS NULL) AS active_hq_template_id,
         r.line_account_id, r.program_id, r.name, r.description, r.image_url,
         CASE WHEN EXISTS (SELECT 1 FROM mileage_handgift_rewards h WHERE h.reward_id = r.id) THEN 'handgift' ELSE r.reward_kind END AS reward_kind, r.status, r.sort_order, r.current_draft_version_id,
         r.current_published_version_id, r.created_at, r.updated_at,
         v.id AS version_id, v.version_number, v.status AS version_status,
         v.revision,
         v.required_miles, v.stock_limit, v.per_friend_limit, v.starts_at, v.ends_at,
         v.benefit_expires_days, v.common_action_version_id, v.failure_policy,
         v.target_conditions, v.customer_message, v.published_at,
         (SELECT COUNT(*) FROM mileage_redemptions mr
           WHERE mr.reward_id = r.id AND mr.status = 'succeeded'
             AND mr.delivered_at >= datetime('now', 'start of month')) AS exchanged_this_month,
         (SELECT COUNT(*) FROM mileage_reward_codes mc
           WHERE mc.reward_version_id = v.id AND mc.status = 'available') AS available_code_count,
         ca.name AS benefit_name
    FROM mileage_rewards r
    LEFT JOIN mileage_reward_versions v
      ON v.id = ${versionExpression}
    LEFT JOIN common_action_versions cav ON cav.id = v.common_action_version_id
    LEFT JOIN common_actions ca ON ca.id = cav.common_action_id`;
}
