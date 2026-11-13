import { fetchApi } from './api'
import type { ApiResponse } from '@line-crm/shared'

/**
 * 然-NEN- 会員（ランク・ライフタイム・マイル）。★管理画面 37-1／37-1-A／37-1-B。
 * Worker `apps/worker/src/routes/nen-ranks.ts`。
 */

export interface NenRank {
  id: string
  key: string
  name: string
  annualThresholdYen: number
  mileRatePercent: number
  tagId: string | null
  tagName: string | null
  memberCount: number
}

export interface NenRankRules {
  yearStartMonth: number
  applyOnReach: string
  keepUntil: string
  countOrders: string
  version: number
  syncStatus: 'pending' | 'synced' | 'failed'
  syncError: string | null
  syncedAt: string | null
  updatedAt: string
}

export interface NenLifetimeMilestone {
  id: string
  thresholdYen: number
  title: string
  benefitKind: string | null
  benefitNote: string | null
  notifyOnReach: boolean
  reachedCount: number
}

export interface NenMemberKpis {
  members: number
  annualTotalYen: number
  lifetimeTotalYen: number
  balanceTotal: number
  usedThisMonth: number
  byRank: Record<string, number>
  /** ECの会員と結びついている会員の数（★V8 会員帯「LINE 連携済み」）。 */
  linkedMembers?: number
  /** ペットを登録している会員の数（★V8 会員帯「ペット登録あり」）。 */
  petMembers?: number
  /** 当月（JST）の入金済み注文の合計額と買った会員の数（★V8 会員帯「今月の購入」）。 */
  monthPurchaseYen?: number
  monthBuyers?: number
}

export interface NenRankSettingsData {
  ranks: NenRank[]
  rules: NenRankRules | null
  milestones: NenLifetimeMilestone[]
  kpis: NenMemberKpis
  sync?: { status: 'synced' | 'failed' | 'skipped'; error: string | null }
}

export interface NenMemberRow {
  friendId: string
  name: string
  pictureUrl: string | null
  customerId: string | null
  rankKey: string | null
  rankName: string
  mileRatePercent: number | null
  annualMilesYen: number
  lifetimeMilesYen: number
  mileBalance: number
  rankValidUntil: string | null
  lastPurchasedAt: string | null
  purchaseCount: number
  petCount: number
  petNames: string | null
  syncedAt: string
}

export interface NenMemberListData {
  items: NenMemberRow[]
  total: number
  page: number
  pageSize: number
  kpis: NenMemberKpis
  ranks: Array<{ key: string; name: string; annualThresholdYen: number; mileRatePercent: number }>
}

export type NenMemberSort = 'annual_desc' | 'lifetime_desc' | 'balance_desc' | 'recent'

export type NenFeedingKind = 'staple' | 'nen'

export interface NenFeedingProduct {
  id: string
  name: string
  kcalPer100g: number
  isDefault: boolean
  /** staple＝主食（お客様が選ぶ一般的なフード）、nen＝然の商品（おやつ・トッピング） */
  kind: NenFeedingKind
}

export interface NenFeedingData {
  products: NenFeedingProduct[]
  /** おやつの上限（1日の必要カロリーに対する %）。既定 10 */
  treatLimitPercent: number
  petCount: number
  refreshedPets?: number
}

/** DELETE /api/nen/rank-settings/:id の応答。 */
export interface NenRankDeleteResult {
  id: string
  replacementRankId: string | null
  movedMembers: number
  version: number
  operationId: string
  ecSync?: 'pending' | 'synced' | 'failed'
  message?: string
}

export const nenRanksApi = {
  feeding: (accountId: string) =>
    fetchApi<ApiResponse<NenFeedingData>>(`/api/nen/feeding-products?accountId=${encodeURIComponent(accountId)}`),
  saveFeeding: (accountId: string, products: Array<{ id?: string | null; name: string; kcalPer100g: number; isDefault: boolean; kind: NenFeedingKind }>, treatLimitPercent: number) =>
    fetchApi<ApiResponse<NenFeedingData>>('/api/nen/feeding-products', {
      method: 'PUT', body: JSON.stringify({ accountId, products, treatLimitPercent }),
    }),
  settings: (accountId: string) =>
    fetchApi<ApiResponse<NenRankSettingsData>>(`/api/nen/rank-settings?accountId=${encodeURIComponent(accountId)}`),
  initialize: (accountId: string) =>
    fetchApi<ApiResponse<NenRankSettingsData>>('/api/nen/rank-settings/initialize', {
      method: 'POST', body: JSON.stringify({ accountId }),
    }),
  saveRanks: (accountId: string, ranks: Array<{ id?: string | null; name: string; annualThresholdYen: number; mileRatePercent: number }>) =>
    fetchApi<ApiResponse<NenRankSettingsData>>('/api/nen/rank-settings', {
      method: 'PUT', body: JSON.stringify({ accountId, ranks }),
    }),
  saveMilestones: (accountId: string, milestones: Array<{ id?: string | null; thresholdYen: number; title: string; notifyOnReach: boolean }>) =>
    fetchApi<ApiResponse<NenRankSettingsData>>('/api/nen/lifetime-milestones', {
      method: 'PUT', body: JSON.stringify({ accountId, milestones }),
    }),
  resync: (accountId: string) =>
    fetchApi<ApiResponse<NenRankSettingsData>>('/api/nen/rank-settings/resync', {
      method: 'POST', body: JSON.stringify({ accountId }),
    }),
  members: (accountId: string, params: {
    rank?: string
    /** ★V8「○○以上」の札：区切りに合うランクキーの一覧。rank より優先。 */
    ranks?: string[]
    /** ★V8「EC未連携」の札：ECの会員と結びついているかで絞る。 */
    link?: 'linked' | 'unlinked'
    pet?: 'any' | 'with' | 'without'
    q?: string
    sort?: NenMemberSort
    page?: number
    pageSize?: number
  } = {}) => {
    const search = new URLSearchParams({ accountId })
    if (params.rank) search.set('rank', params.rank)
    if (params.ranks && params.ranks.length > 0) search.set('ranks', params.ranks.join(','))
    if (params.link) search.set('link', params.link)
    if (params.pet && params.pet !== 'any') search.set('pet', params.pet)
    if (params.q) search.set('q', params.q)
    if (params.sort) search.set('sort', params.sort)
    if (params.page && params.page > 1) search.set('page', String(params.page))
    if (params.pageSize) search.set('pageSize', String(params.pageSize))
    return fetchApi<ApiResponse<NenMemberListData>>(`/api/nen/members?${search.toString()}`)
  },
  rankDeletePreview: (accountId:string, rankId:string) => fetchApi<ApiResponse<{count:number;version:number;members:Array<{friendId:string;customerId:string|null}>}>>(`/api/nen/rank-settings/${encodeURIComponent(rankId)}/delete-preview?${new URLSearchParams({accountId})}`),
  /** ランクの削除。会員がいるときは移す先が必須。版が合わないときは 409。 */
  deleteRank: (accountId: string, rankId: string, options: { replacementRankId?: string | null; expectedVersion: number; confirmedMembers?:Array<{friendId:string;customerId:string|null}> }) =>
    fetchApi<ApiResponse<NenRankDeleteResult>>(`/api/nen/rank-settings/${encodeURIComponent(rankId)}`, {
      method: 'DELETE',
      body: JSON.stringify({
        accountId,
        replacementRankId: options.replacementRankId ?? null,
        expectedVersion: options.expectedVersion,
        ...(options.confirmedMembers===undefined?{}:{confirmedMembers:options.confirmedMembers}),
      }),
    }),
}
