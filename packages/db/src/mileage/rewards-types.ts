


export type MileageRewardKind =
  | 'coupon'
  | 'handgift'
  | 'tag'
  | 'scenario'
  | 'template'
  | 'early_access'
  | 'rank';

export type MileageRewardStatus = 'draft' | 'published' | 'stopped' | 'archived';
export type MileageRewardFailurePolicy = 'retry' | 'refund' | 'manual';
export interface MileageRewardTargetCondition {
  operator: 'AND' | 'OR';
  rules: Array<{ type: string; value: unknown }>;
  groups?: MileageRewardTargetCondition[];
}
export type MileageRedemptionStatus =
  | 'reserved'
  | 'delivering'
  | 'succeeded'
  | 'delivery_failed'
  | 'refunded';

export interface MileageRewardVersion {
  id: string;
  versionNumber: number;
  status: 'draft' | 'published';
  /** 保存ごとに増える更新番号。同時編集の検知に使う。 */
  revision: number;
  requiredMiles: number;
  stockLimit: number | null;
  perFriendLimit: number | null;
  startsAt: string | null;
  endsAt: string | null;
  benefitExpiresDays: number | null;
  commonActionVersionId: string | null;
  targetConditions: MileageRewardTargetCondition | null;
  failurePolicy: MileageRewardFailurePolicy;
  customerMessage: string;
  publishedAt: string | null;
}

export interface MileageRewardSummary {
  id: string;
  folderId?: string | null;
  lineAccountId: string;
  programId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  rewardKind: MileageRewardKind;
  status: MileageRewardStatus;
  sortOrder: number;
  currentDraftVersionId: string | null;
  currentPublishedVersionId: string | null;
  currentVersion: MileageRewardVersion | null;
  exchangedThisMonth: number;
  availableCodeCount: number | null;
  benefitName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MileageRewardAdminOverview {
  rewards: MileageRewardSummary[];
  summary: {
    publishedCount: number;
    redeemedMilesThisMonth: number;
    neverRedeemedFriendCount: number | null;
    mostRedeemedRewardName: string | null;
    mostRedeemedRewardCount: number | null;
  };
}

export interface MileageRewardDraftInput {
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  rewardKind: MileageRewardKind;
  requiredMiles: number;
  stockLimit?: number | null;
  perFriendLimit?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  benefitExpiresDays?: number | null;
  commonActionVersionId?: string | null;
  targetConditions?: MileageRewardTargetCondition | null;
  failurePolicy?: MileageRewardFailurePolicy;
  customerMessage?: string;
}

export interface MileageRewardRedemption {
  id: string;
  lineAccountId: string;
  programId: string;
  beneficiaryKey: string;
  beneficiaryUserId: string | null;
  beneficiaryFriendId: string | null;
  rewardId: string;
  rewardVersionId: string;
  spendLedgerEntryId: string | null;
  rewardCodeId: string | null;
  /** 交換が決まったときの名前・種類。未公開の名前変更が過去の交換へ混ざらない。 */
  rewardNameSnapshot: string | null;
  rewardKindSnapshot: MileageRewardKind | null;
  idempotencyKey: string;
  requestFingerprint: string;
  status: MileageRedemptionStatus;
  attemptCount: number;
  nextRetryAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  deliveredAt: string | null;
  refundedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RewardRow = {
  id: string;
  folder_id: string | null;
  line_account_id: string;
  program_id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  reward_kind: MileageRewardKind;
  status: MileageRewardStatus;
  sort_order: number;
  current_draft_version_id: string | null;
  current_published_version_id: string | null;
  created_at: string;
  updated_at: string;
  version_id: string | null;
  version_number: number | null;
  version_status: 'draft' | 'published' | null;
  revision: number | null;
  required_miles: number | null;
  stock_limit: number | null;
  per_friend_limit: number | null;
  starts_at: string | null;
  ends_at: string | null;
  benefit_expires_days: number | null;
  common_action_version_id: string | null;
  target_conditions: string | null;
  failure_policy: MileageRewardFailurePolicy | null;
  customer_message: string | null;
  published_at: string | null;
  exchanged_this_month: number;
  available_code_count: number | null;
  benefit_name: string | null;
};

export type RedemptionRow = {
  id: string;
  line_account_id: string;
  program_id: string;
  beneficiary_key: string;
  beneficiary_user_id: string | null;
  beneficiary_friend_id: string | null;
  reward_id: string;
  reward_version_id: string;
  spend_ledger_entry_id: string | null;
  reward_code_id: string | null;
  reward_name_snapshot: string | null;
  reward_kind_snapshot: MileageRewardKind | null;
  idempotency_key: string;
  request_fingerprint: string;
  status: MileageRedemptionStatus;
  attempt_count: number;
  next_retry_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  delivered_at: string | null;
  refunded_at: string | null;
  created_at: string;
  updated_at: string;
};

export type WalletRow = {
  beneficiary_key: string;
  beneficiary_user_id: string | null;
  beneficiary_friend_id: string | null;
  available: number;
  version: number;
};

export type LotRow = {
  ledger_entry_id: string;
  remaining_amount: number;
};

export type MileageRedemptionListStatus = MileageRedemptionStatus | 'all' | 'needs_attention';

export interface MileageRedemptionListItem extends MileageRewardRedemption {
  rewardName: string;
}

export type MileageRedemptionStepStatus = 'started' | 'sent';

export interface MileageRedemptionStepDelivery {
  redemptionId: string;
  stepKey: string;
  idempotencyKey: string;
  status: MileageRedemptionStepStatus;
  attemptCount: number;
  owner: string | null;
  leaseExpiresAt: string | null;
  generation: number;
  fenceToken: string | null;
  needsReconcile: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 手順の貸出予約。返すのは次の4つのどれか。
 *
 * - 'send' … 自分が貸出を持った。送ってよいのはこの走者だけ。
 * - 'sent' … 送信済み。送らない(やり直しが再送しないための outbox の口)。
 * - 'reconcile' … 照合待ち。「送るかもしれない」の証言が残っているが、
 *   送ったか確かめられない。**送り直さないし、勝手に確定もしない。**
 *   受信先が冪等でなくても二重に届かないのはこのため。
 * - 'busy' … 別の走者が貸出を持っている。送らずに待つ。
 *
 * 証言は送る前に残す。送ったあとの確定書き込みが何度失敗しても、
 * 証言は残るので回収は送り直さない。期限切れの引き継ぎでは世代を進め、
 * 期限切れの旧持ち主が貸出を取り直しても 'reconcile' しか返らない
 * (旧持ち主の再送は禁止)。古い走者の遅い確定は owner と fence が
 * 合わずに拒否される(取り違え防止の fence)。
 */
export type RedemptionStepClaim = 'send' | 'sent' | 'reconcile' | 'busy' | 'expired';



export interface RedemptionStepLease {
  redemptionId: string;
  stepKey: string;
  idempotencyKey: string;
  owner: string;
  fenceToken: string;
  leaseExpiresAt: string;
  now: string;
  /**
   * 再試行キーの期限切れ境界（ISO時刻）。この時刻より前に
   * 作られた手順（＝最初の送信から24時間超）は、同じキーで送り直さない。
   * 省略時は期限を見ない。
   */
  retryKeyExpiresAt?: string | null;
}

export interface RedemptionStepRow {
  status: MileageRedemptionStepStatus;
  owner: string | null;
  leaseExpiresAt: string | null;
  idempotencyKey: string;
  needsReconcile: number;
  createdAt: string;
}
