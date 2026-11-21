import type { CommonVar, CommonVarDeleteImpact, CommonVarChangeImpact, ApiResponse } from '@line-crm/shared'

export type CommonVarHistoryItem = {
  id: string
  version: number
  name: string
  value: string
  memo: string
  changeReason: string | null
  actorId: string | null
  actorName: string | null
  createdAt: string
}

export type CommonVarDetail = CommonVar & {
  memo: string
  pinDisabledReason?: string | null
  version: number
  archivedAt: string | null
  usages: CommonVarDeleteImpact['items']
  usagePage: {
    total: number
    shown: number
    hasMore: boolean
    unavailableCount: number
  }
  history: CommonVarHistoryItem[]
}

export type CommonVarChangeImpactDetail = CommonVarChangeImpact & {
  version: number
  usageByKind: CommonVarChangeImpact['byKind']
  scheduledUsageCount: number
  publishedUsageCount: number
  /** 送信開始時の値で固定済みの配信中。保存しても変わらない側（IDEA-14）。 */
  sendingFixedUsageCount: number
  usageRevision: string
  impactProof: string
}

export type CommonVarReplacementCandidate = {
  id: string
  name: string
  varKey: string
  type: CommonVar['type']
  value: string
  version: number
}

export type CommonVarReplacementCandidates = {
  source: Pick<CommonVarReplacementCandidate, 'id' | 'name' | 'type' | 'version'>
  candidates: CommonVarReplacementCandidate[]
}

export type CommonVarReplacementImpact = {
  source: Pick<CommonVarReplacementCandidate, 'id' | 'name' | 'type' | 'version'>
  replacement: Pick<CommonVarReplacementCandidate, 'id' | 'name' | 'type' | 'version'>
  usageTotal: number
  replaceableTotal: number
  blockedTotal: number
  historicalTotal: number
  unscopedFormTotal: number
  byKind: Record<string, number>
  canReplace: boolean
  revision: string
  checkedAt: string
}

export type CommonVarReplacementResult = {
  runId: string
  replacedUsageCount: number
  archivedVersion: number
  sourceId: string
  replacementId: string
  remainingUsageCount: number | null
  verification: 'verified' | 'partial' | 'unavailable'
  completedAt: string
}

/** 共通情報の一覧。件数上限で切ったときは limited で絞り込み誘導を出す。 */
export type CommonVarsListResponse = ApiResponse<CommonVar[]> & {
  meta?: { total: number; limited: boolean; limit: number }
}

/**
 * 共通情報CSVの出力台帳1件（N-192）。
 * status: queued/running は生成中、completed は期限内ダウンロード可、
 * failed は生成失敗、expired は期限切れ（再生成で新しい期限が付く）。
 */
export type CommonVarExportStatus = 'queued' | 'running' | 'completed' | 'failed' | 'expired'

export interface CommonVarExportJob {
  id: string
  lineAccountId: string
  folderId: string | null
  ungrouped: boolean
  status: CommonVarExportStatus
  totalCount: number | null
  processedCount: number
  rowCount: number | null
  byteSize: number | null
  createdBy: string
  createdByName: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  expiresAt: string
  failureReason: string | null
  downloadUrl: string | null
}
