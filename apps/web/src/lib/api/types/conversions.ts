import type { ConversionMeasureMethod } from '@line-crm/shared'

export type ConversionDefinitionStatus = 'active' | 'stopped' | 'draft'

/**
 * N-268: 画面で区別する導出状態。status 列そのものではなく、
 * 設定の壊れ(入力不良)や外部受信の停止(起点停止)も含める。
 */
export type ConversionDefinitionState =
  | 'active' | 'draft' | 'stopped' | 'invalid' | 'sourceStopped'

/** `state` クエリで追加で受ける、状態と直交する絞り込み。 */
export type ConversionDefinitionFilter = ConversionDefinitionState | 'unused'

export type ConversionDeduplicationMode = 'every' | 'once_per_friend' | 'window'

export type ConversionValueMode = 'source' | 'fixed' | 'none'

export type ConversionReversalPolicy = 'source_cancelled' | 'manual' | 'none'

export type ConversionDefinitionUsageKind =
  | 'affiliate_offer' | 'analytics' | 'auto_reply' | 'scenario'
  | 'nen_campaign' | 'mileage_rule' | 'automation' | 'ad_platform'

export type ConversionDefinitionListItem = {
  folderId?: string | null
  id: string
  name: string
  sourceType: string
  value: number | null
  measureMethod: ConversionMeasureMethod
  targetUrl: string | null
  countRepeat: boolean
  attributionDays: number | null
  sourceConfig: Record<string, unknown>
  deduplicationMode: ConversionDeduplicationMode
  deduplicationWindowDays: number | null
  valueMode: ConversionValueMode
  reversalPolicy: ConversionReversalPolicy
  lineAccountId: string | null
  status: ConversionDefinitionStatus
  /** N-268: 画面表示用の導出状態。 */
  state: ConversionDefinitionState
  /** 入力不良・起点停止のとき、直すべき中身を運用者の言葉で返す。 */
  stateReason: string | null
  /** N-270: 外部受信の設定状況。秘密値そのものは返らない。 */
  ingest: { configured: boolean; disabledAt: string | null }
  version: number
  usageCount: number
  usageNames: string[]
  metrics: {
    recordedCount: number
    netCount: number
    reversedCount: number | null
    /** #819: 取消分の金額の合計(追記台帳+アフィリエイト調整)。 */
    reversedValue: number | null
    netValue: number
    reversalState: 'available' | 'unavailable'
    reversalReason: string
    cancellationCount: number | null
    cancellationValue: number | null
  }
  stoppedAt: string | null
  createdAt: string
  updatedAt: string
}

export type ConversionDefinitionUsage = {
  id: string
  conversionPointId: string
  definitionVersion: number
  lineAccountId: string
  refKind: ConversionDefinitionUsageKind
  refId: string
  refVersionId: string | null
  usageName: string
}

export type ConversionDefinitionDetail = ConversionDefinitionListItem & {
  currentVersion: {
    id: string
    number: number
    sourceType: string
    measureMethod: ConversionMeasureMethod
    targetUrl: string | null
    countRepeat: boolean
    fixedValue: number | null
    attributionDays: number | null
  }
  usages: ConversionDefinitionUsage[]
}

export type ConversionDefinitionPreview = {
  range: { from: string; to: string; timeZone: 'Asia/Tokyo' }
  matchedCount: number
  /** 条件に合う友だちの重複を除いた人数。旧Workerの応答では未取得。 */
  uniqueFriendCount?: number
  /** 除外条件に当てはまった過去の成果件数。重複除外とは別。 */
  excludedCount?: number
  estimatedCount: number
  estimatedValue: number
  duplicateExcludedCount: number
  cancellationCount: number
  excludedReasons: string[]
  /** R42: 金額のない過去の成果の件数。金額の試算には入っていない。 */
  missingValueCount: number
  dailyAverage: number
  deduplicationWindowDays: number | null
}

/** N-270: 外部受信の成否1件。署名・本文の中身は含まない。 */
export type ConversionIngestionEvent = {
  id: string
  conversionPointId: string
  result: 'recorded' | 'duplicate' | 'rejected'
  reason: string | null
  /** IDEA-19: 検証の受信。成果表へ書かず台帳だけに残るので実績には混入しない。 */
  isTest: boolean
  sourceEventId: string | null
  friendId: string | null
  payloadShape: Record<string, unknown> | null
  signatureSha256: string | null
  createdAt: string
}

/**
 * IDEA-19: 成果1件ごとの業務状態。
 * 口が承認状態と取消台帳から導出するので、画面は組み立て直さない。
 */
export type ConversionDefinitionEventStatus =
  | 'confirmed' | 'pending' | 'rejected' | 'cancelled'

export type ConversionDefinitionEvent = {
  id: string
  friendId: string
  friendName: string | null
  status: ConversionDefinitionEventStatus
  approvalStatus: 'pending' | 'approved' | 'rejected' | null
  approvalRevision?: number | null
  cancelled: boolean
  /**
   * #819: 取消追記台帳でいま取り消しか。アフィリエイト調整の取消とは
   * 別に持ち、「取消を戻す」操作の対象はこの印が立つ行だけ。
   */
  reversed: boolean
  latestReversalId?: string | null
  value: number | null
  source: string | null
  sourceEventId: string | null
  createdAt: string
}

/** #819: 計測サイト。公開ID・許可ドメイン・許可外ドメインの拒否集計。 */
export type MeasurementSite = Partial<import('@line-crm/shared').MeasurementSiteReceipt> & {
  id: string
  label: string
  domains: string[]
  createdAt: string
  rejectedCount: number
  lastRejectedHost: string | null
  lastRejectedAt: string | null
  /** 計測を止めた日時と理由。動いているサイトは null。 */
  stoppedAt: string | null
  stoppedReason: string | null
}

/** #819: 成果1件の取消・取消の取消の履歴行。 */
export type ConversionReversal = {
  id: string
  kind: 'reverse' | 'restore'
  reason: string
  actorName: string | null
  createdAt: string
}

export type ConversionDefinitionDeleteImpact = {
  definition: ConversionDefinitionDetail
  usages: ConversionDefinitionUsage[]
  eventCount: number
  canDelete: boolean
  stopImpact: { affectedUsageCount: number; preservesPastEvents: true; preservesUsages: true }
  replacementCandidates: Array<{ id: string; name: string; version: number }>
}

export type ConversionDefinitionList = {
  items: ConversionDefinitionListItem[]
  stateCounts: {
    active: number
    draft: number
    stopped: number
    invalid: number
    sourceStopped: number
    /** N-267: どこからも使われていない地点の数(絞り込み全体の正確な件数)。 */
    unused: number
  }
  range: { from: string; to: string; timeZone: 'Asia/Tokyo' }
  pagination: { total: number; limit: number; cursor: string; nextCursor: string | null }
}

export type ConversionDefinitionReport = {
  range: { from: string; to: string; timeZone: 'Asia/Tokyo' }
  previousRange: { from: string; to: string; timeZone: 'Asia/Tokyo' }
  kpis: {
    recordedCount: number
    recordedValue: number
    reversedCount: number | null
    netCount: number
    netValue: number
    averageNetValue: number | null
    previousNetCount: number
    previousNetValue: number
    countChangeRate: number | null
    reversalState: 'available' | 'unavailable'
    reversalReason: string
    fastestGrowing: {
      conversionPointId: string
      conversionPointName: string
      sourceType: string
      netCount: number
      netValue: number
      previousNetCount: number
      previousNetValue: number
      countChange: number
    } | null
    cancellationCount: number | null
    cancellationValue: number | null
  }
  daily: Array<{
    day: string
    conversionPointId: string
    conversionPointName: string
    netCount: number
    netValue: number
  }>
  byDefinition: Array<{
    conversionPointId: string
    conversionPointName: string
    sourceType: string
    netCount: number
    netValue: number
    previousNetCount: number
    previousNetValue: number
    countChange: number
    cancellationCount: number | null
    cancellationValue: number | null
    routes: Array<{
      routeKey: string
      label: string
      attributionState: 'attributed' | 'unattributed'
      netCount: number
      netValue: number
      audience: number | null
      conversionRate: number | null
    }>
  }>
  byRoute: Array<{
    routeKey: string
    label: string
    attributionState: 'attributed' | 'unattributed'
    netCount: number
    netValue: number
    audience: number | null
    conversionRate: number | null
  }>
}
