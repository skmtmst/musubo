import type { MileageFriendHistorySummary } from '@line-crm/shared'

export type MileageSummary = {
  programId: string
  programName: string
  available: number | null
  balanceSource?: 'ec' | 'musubo'
  ecRank?: string
  pending: number
  lifetimeEarned: number
  spent: number
}

export type MileageHistoryItem = {
  id: string
  entryType: 'grant' | 'reversal' | 'spend' | 'expiration' | 'adjustment'
  status: 'pending' | 'available' | 'void'
  amount: number
  /** 権限の外側のアカウントの記録では null。見分けには restricted を使う。 */
  reason: string | null
  source: string
  sourceEventId: string | null
  sourceReferenceId: string | null
  ruleName: string | null
  mode: 'automatic' | 'manual'
  executedByStaffName: string | null
  balanceAfter?: number
  occurredAt: string
  /** この記録が属するLINEアカウント。分からないときは null。 */
  lineAccountId?: string | null
  /** true の行は見ている人の権限外アカウントの記録で、理由・実行者・元イベントは伏せてある。 */
  restricted?: boolean
  /** 手動調整につけた友だち通知の状態。通知なし・権限外の行は null。 */
  notificationStatus?: string | null
  notificationErrorCode?: string | null
}

export type MileageSelfInsights = {
  accountCount: number
  rewardedActions: number
  referralMiles: number
  qualityReferralCount: number
  lastEarnedAt: string | null
}

export type MileageConnectedAccount = {
  accountId: string
  accountName: string
  friendId: string
}

export type MileageAdjustmentPolicy = {
  configured: boolean
  approvalThreshold: number | null
}

export type MileageAdjustmentResult = {
  entryId: string
  balanceBefore: number
  amount: number
  balanceAfter: number
  replayed: boolean
  expiresAt: string | null
  notification: {
    id: string | null
    status: 'pending' | 'sent' | 'failed'
    attemptCount: number
    errorCode: string | null
  } | null
}

/*
 * R: 高額調整の承認依頼。境界以上の調整は実行せず依頼票として残り、
 * 依頼した人とは別のオーナーが承認した時点で台帳へ記録される。
 */
export type MileageAdjustmentApprovalRequest = {
  id: string
  line_account_id: string
  friend_id: string
  friend_display_name?: string | null
  direction: 'increase' | 'decrease'
  amount: number
  reason_category: string
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  requested_by_staff_id: string
  requested_by_staff_name: string
  decided_by_staff_name: string | null
  decided_at: string | null
  decision_reason: string | null
  created_at: string
}

/** 境界以上の調整を頼んだときの返事。台帳にはまだ書かれていない。 */
export type MileageAdjustmentApprovalResult = {
  approvalRequired: true
  approvalThreshold: number
  request: MileageAdjustmentApprovalRequest
}

/** 決めごとの事前テスト（実際には付与しない） */
export type MileageEarningRuleTestResult = {
  matchedEvents: number
  matchedFriends: number
  estimatedTotalMiles: number
  maxPerFriend: number
  overlappingRuleNames: string[]
  initialStatus: 'available' | 'pending'
  expirationExampleAt: string | null
}

/*
 * マイルの使い道（`/api/mileage/rewards`）。#772 で口が入った。
 *
 * **版を分けて持つ。** 公開中の版と直しかけの下書きは別で、
 * 直しても公開中の交換条件は変わらない。画面でもそこを混ぜない。
 */
export type MileageRewardKind = 'handgift' | 'coupon' | 'tag' | 'scenario' | 'template' | 'early_access' | 'rank'

export type MileageRewardStatus = 'draft' | 'published' | 'stopped' | 'archived'

export type MileageRewardFailurePolicy = 'retry' | 'refund' | 'manual'

export type MileageRewardVersion = {
  id: string
  versionNumber: number
  status: 'draft' | 'published'
  /** 保存ごとに増える更新番号。同時編集の検知に送る。 */
  revision: number
  requiredMiles: number
  /** 数に限りがあるとき。null なら限りなし。**0 と混ぜない。** */
  stockLimit: number | null
  perFriendLimit: number | null
  startsAt: string | null
  endsAt: string | null
  benefitExpiresDays: number | null
  commonActionVersionId: string | null
  targetConditions: MileageTargetConditionV6 | null
  failurePolicy: MileageRewardFailurePolicy
  customerMessage: string
  publishedAt: string | null
}

export type MileageRewardSummary = {
  folderId?: string | null
  id: string
  lineAccountId: string
  programId: string
  name: string
  description: string | null
  imageUrl: string | null
  rewardKind: MileageRewardKind
  status: MileageRewardStatus
  sortOrder: number
  currentDraftVersionId: string | null
  currentPublishedVersionId: string | null
  currentVersion: MileageRewardVersion | null
  exchangedThisMonth: number
  /** 引換コードの残り。数える経路が無いときは null。**0 と混ぜない。** */
  availableCodeCount: number | null
  /** 交換後に実行する共通アクションの運用名。 */
  benefitName: string | null
  createdAt: string
  updatedAt: string
}

export type MileageRewardTestResult = {
  rewardId: string
  versionId: string
  requiredMiles: number
  canDeliver: boolean
  warning: string | null
  /** テストでは残高・在庫を動かさない。 */
  ledgerChanged: false
}

/**
 * 使い道の下書きの中身（`p9CcEB` 17-1-G）。
 *
 * **Worker の `MileageRewardDraftInput` と同じ形にする。** 画面で足すと、
 * 入れられるのに保存できない欄ができる。
 */
export type MileageRewardDraftInput = {
  name: string
  description?: string | null
  imageUrl?: string | null
  rewardKind: MileageRewardKind
  requiredMiles: number
  /** 数に限りがあるとき。**`null` は「限りなし」で、0（品切れ）とは別。** */
  stockLimit?: number | null
  perFriendLimit?: number | null
  startsAt?: string | null
  endsAt?: string | null
  benefitExpiresDays?: number | null
  /** 交換後に渡すもの。**クーポン以外では必須**（Worker が弾く）。 */
  commonActionVersionId?: string | null
  /** この条件を満たす友だちだけが交換できる。null は全員。 */
  targetConditions?: MileageTargetConditionV6 | null
  failurePolicy?: MileageRewardFailurePolicy
  customerMessage?: string
}

export type MileageRewardAdminOverview = {
  rewards: MileageRewardSummary[]
  summary: {
    publishedCount: number
    redeemedMilesThisMonth: number
    /** 1回も使っていない人。数える経路が無いときは null。 */
    neverRedeemedFriendCount: number | null
    mostRedeemedRewardName: string | null
    mostRedeemedRewardCount: number | null
  }
  reachMetrics: MileageRewardReachMetric[]
  rankBenefits: MileageRewardReachMetric[]
  measuredAt: string
}

export type MileageRewardReachMetric = {
  rewardId: string
  rewardName: string
  rewardKind: MileageRewardKind
  requiredMiles: number
  reachableFriendCount: number
  redeemedFriendCount: number
  exchangeRate: number | null
}

export type MileageRule = {
  id: string
  name: string
  eventType: string
  source: string | null
  amount: number
  initialStatus: 'pending' | 'available'
  conditions: {
    dailyCapActions?: number
    uniquePerSubject?: boolean
    uniquePerSubjectPerDay?: boolean
    ignoreMultiplier?: boolean
    beneficiary?: 'actor' | 'referrer'
    uniquePerReferredFriend?: boolean
    uniquePerReferredFriendPerSubject?: boolean
  }
  /** #532: 帰属するLINEアカウント。旧い全店共通ルールは null。 */
  lineAccountId: string | null
  isActive: boolean
  validFrom: string | null
  validUntil: string | null
  createdAt: string
  updatedAt: string
}

export type MileageAdminMember = {
  identityKey: string
  primaryFriendId: string
  displayName: string
  pictureUrl: string | null
  accountCount: number
  accountNames: string[]
  available: number
  pending: number
  lifetimeEarned: number
  actionCount: number
  messageCount: number
  linkClickCount: number
  formCount: number
  bookingCount: number
  webinarCount: number
  instagramCount: number
  followingDays: number
  unfollowCount: number
  referralMiles: number
  qualityReferralCount: number
  lastActivityAt: string | null
}

export type MileageAdminOverview = {
  summary: {
    totalMembers: number
    totalAvailable: number
    activeMembers30d: number
    totalActions: number
    queuedEvents: number
  }
  members: MileageAdminMember[]
  pagination: { total: number; limit: number; offset: number }
}

export type MileageAdminHistoryItem = {
  id: string
  primaryFriendId: string
  displayName: string
  pictureUrl: string | null
  entryType: MileageHistoryItem['entryType']
  status: MileageHistoryItem['status']
  amount: number
  reason: string
  source: string
  hasSourceEvent: boolean
  sourceReferenceId: string | null
  ruleName: string | null
  mode: 'automatic' | 'manual'
  executedByStaffName: string | null
  lineAccountName: string
  lineAccountId?: string | null
  notificationStatus?: string | null
  notificationErrorCode?: string | null
  balanceAfter: number
  occurredAt: string
}

export type MileageAdminHistory = {
  friendSummary?: MileageFriendHistorySummary
  items: MileageAdminHistoryItem[]
  pagination: { total: number; limit: number; offset: number }
  summary: {
    from: string | null
    to: string | null
    byType: Array<{
      entryType: MileageHistoryItem['entryType']
      count: number
      amount: number
    }>
    totalAmount: number
    manualCount: number
    pendingCount: number
    measuredAt: string
  }
}

export type MileageFriendV6 = {
  friendId: string
  displayName: string
  pictureUrl: string | null
  rank: string | null
  rankReason: string
  rankThreshold: number | null
  nextRank: string | null
  nextRankThreshold: number | null
  milesToNextRank: number | null
  monthChange: number
  available: number | null
  pending: number
  /** 30日以内に期限を迎える分。期限つきロットが無いときは null（0 とは別物）。 */
  expiringMiles30d: number | null
  /** いちばん近い失効日。期限つきロットがあれば 30 日より先でも入る。 */
  nextExpiringAt: string | null
  lifetimeEarned: number
  spent: number
  lastChangedAt: string | null
  lastAction?: { name: string; amount: number; occurredAt: string; entryType: string; status: string } | null
  walletScope: 'verified_user' | 'friend'
  lineAccount: { id: string; name: string }
}

export type MileageFriendsV6Overview = {
  balanceSource: 'ec' | 'musubo'
  ecKnownCount?: number
  summary: {
    totalMembers: number
    withBalanceCount: number
    available: number | null
    pending: number
    monthChange: number
    rankCounts: Array<{ rewardId: string; rankName: string; requiredMiles: number; friendCount: number }>
    expiringMiles30d: number | null
    /** 一覧の中でいちばん近い失効日。期限つきロットがなければ null。 */
    nextExpiringAt: string | null
  }
  items: MileageFriendV6[]
  pagination: { total: number; limit: number; offset: number }
  measuredAt: string
}

export type MileageTargetConditionV6 = {
  operator: 'AND' | 'OR'
  rules: Array<{ type: string; value: unknown }>
  groups?: MileageTargetConditionV6[]
}

export type MileageEarningRuleDraftV6 = {
  name: string
  eventType: string
  source: string | null
  amount: number
  initialStatus: 'available' | 'pending'
  validFrom: string | null
  validUntil: string | null
  expiresAfterDays: number | null
  cancellationEventTypes: string[]
  targetConditions: MileageTargetConditionV6 | null
  sortOrder: number
  notification?: {
    enabled: boolean
    messageTemplate: string
  }
}

export type MileageEarningRuleV6 = {
  id: string
  published: {
    name: string
    eventType: string
    source: string | null
    amount: number
    initialStatus: 'available' | 'pending'
    validFrom: string | null
    validUntil: string | null
    status: 'published' | 'stopped'
    updatedAt: string
  }
  draft: MileageEarningRuleDraftV6
  draftVersion: number
  draftUpdatedAt: string
  /** N-231 案1: いま公開中の版。null は未公開。 */
  publishedVersion: number | null
  metrics30d: { eligible: number; granted: number; grantedMiles: number; excluded: number }
}

export type MileageEarningRulesV6Overview = {
  items: MileageEarningRuleV6[]
  pagination: { total: number; limit: number; offset: number }
  unassignedLegacyCount: number
  measuredAt: string
}
