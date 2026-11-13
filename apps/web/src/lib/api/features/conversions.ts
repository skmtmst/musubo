import type {
  ConversionDefinitionStatus,
  ConversionDefinitionFilter,
  ConversionDefinitionList,
  ConversionDeduplicationMode,
  ConversionValueMode,
  ConversionReversalPolicy,
  ConversionDefinitionUsageKind,
  ConversionDefinitionDetail,
  ConversionDefinitionPreview,
  ConversionDefinitionDeleteImpact,
  ConversionIngestionEvent,
  ConversionDefinitionEvent,
  ConversionReversal,
  ConversionDefinitionReport,
} from '../types/conversions'
import { fetchApi } from '../transport/request'
import type { ApiResponse, ConversionPoint, ConversionMeasureMethod, ConversionApprovalCounts } from '@line-crm/shared'
import { fetchApiBlob } from '../transport/download'
import type { ConversionApprovalItem, AttributionDecisionView } from '../types/affiliates'

export const conversionsMethods = {
  conversions: {
    definitions: (params: {
      from: string
      to: string
      lineAccountId?: string
      q?: string
      status?: ConversionDefinitionStatus
      state?: ConversionDefinitionFilter
      sourceType?: string
      sort?: 'count_desc' | 'value_desc' | 'updated_desc' | 'name_asc'
      cursor?: string
      limit?: number
    }) => {
      const query = Object.fromEntries(
        Object.entries(params)
          .filter(([, value]) => value !== undefined && value !== '')
          .map(([key, value]) => [key, String(value)]),
      )
      return fetchApi<ApiResponse<ConversionDefinitionList>>(
        `/api/conversions/definitions?${new URLSearchParams(query)}`,
      )
    },
    createDefinition: (data: {
      folderId?: string | null
      name: string
      sourceType: string
      sourceConfig: Record<string, unknown>
      targetUrl?: string | null
      lineAccountId: string
      deduplicationMode: ConversionDeduplicationMode
      deduplicationWindowDays?: number | null
      valueMode: ConversionValueMode
      fixedValue?: number | null
      reversalPolicy: ConversionReversalPolicy
      attributionDays?: number | null
      usages: Array<{ refKind: ConversionDefinitionUsageKind; refId: string; refVersionId?: string | null }>
      /** N-268: true のとき下書きで保存し、公開するまで計測しない。 */
      draft?: boolean
    }) => fetchApi<ApiResponse<ConversionDefinitionDetail>>('/api/conversions/definitions', {
      method: 'POST', body: JSON.stringify(data),
    }),
    previewDefinition: (data: {
      sourceType: string
      sourceConfig: Record<string, unknown>
      targetUrl?: string | null
      lineAccountId: string
      deduplicationMode: ConversionDeduplicationMode
      deduplicationWindowDays?: number | null
      valueMode: ConversionValueMode
      fixedValue?: number | null
      /** N-257: 取消の扱いも試算の条件に含める。 */
      reversalPolicy?: ConversionReversalPolicy
    }, options?: { signal?: AbortSignal }) => fetchApi<ApiResponse<ConversionDefinitionPreview>>('/api/conversions/definitions/preview', {
      method: 'POST', body: JSON.stringify(data), signal: options?.signal,
    }),
    definitionDeleteImpact: (id: string) =>
      fetchApi<ApiResponse<ConversionDefinitionDeleteImpact>>(
        `/api/conversions/definitions/${encodeURIComponent(id)}/delete-impact`,
      ),
    stopDefinition: (id: string, data: { expectedVersion: number; reason?: string }) =>
      fetchApi<ApiResponse<{ id: string; status: 'stopped'; version: number; stoppedAt: string }>>(
        `/api/conversions/definitions/${encodeURIComponent(id)}/stop`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
    replaceDefinition: (id: string, data: {
      replacementId: string
      expectedVersion: number
      replacementExpectedVersion: number
      reason?: string
    }) => fetchApi<ApiResponse<{ id: string; replacementId: string; replacedUsageCount: number; status: 'stopped'; version: number }>>(
      `/api/conversions/definitions/${encodeURIComponent(id)}/replace`,
      { method: 'POST', body: JSON.stringify(data) },
    ),
    /** 成果地点を、履歴を保ったまま編集して次の版にする（N-252）。 */
    reviseDefinition: (id: string, data: {
      folderId?: string | null
      expectedVersion: number
      name: string
      sourceType: string
      sourceConfig?: Record<string, unknown>
      deduplicationMode: 'every' | 'once_per_friend' | 'window'
      deduplicationWindowDays?: number | null
      valueMode: 'source' | 'fixed' | 'none'
      fixedValue?: number | null
      reversalPolicy: 'source_cancelled' | 'manual' | 'none'
      attributionDays?: number | null
      targetUrl?: string | null
      reason?: string
    }) => fetchApi<ApiResponse<{
      id: string
      version: number
      revisionId: string
      movedUsages: number
      updatedAt: string
    }>>(
      `/api/conversions/definitions/${encodeURIComponent(id)}/revise`,
      { method: 'POST', body: JSON.stringify(data) },
    ),
    deleteDefinition: (id: string, data: { expectedVersion: number; reason?: string }) =>
      fetchApi<ApiResponse<{ id: string; deleted: true }>>(
        `/api/conversions/definitions/${encodeURIComponent(id)}`,
        { method: 'DELETE', body: JSON.stringify(data) },
      ),
    /** N-268: 下書きを計測中へ公開する。 */
    publishDefinition: (id: string, data: { expectedVersion: number }) =>
      fetchApi<ApiResponse<{ id: string; status: 'active'; version: number }>>(
        `/api/conversions/definitions/${encodeURIComponent(id)}/publish`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
    /**
     * N-270: 外部受信の鍵を発行・再発行する。
     * 平文の鍵はこの応答でだけ返る。画面は一度だけ表示して保存させる。
     */
    issueIngestSecret: (id: string, data: { expectedVersion: number }) =>
      fetchApi<ApiResponse<{ id: string; secret: string; endpoint: string; version: number }>>(
        `/api/conversions/definitions/${encodeURIComponent(id)}/ingest-secret`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
    /** N-270: 外部受信を止める/再開する。 */
    setIngestDisabled: (id: string, data: { expectedVersion: number; disabled: boolean }) =>
      fetchApi<ApiResponse<{ id: string; disabledAt: string | null; version: number }>>(
        `/api/conversions/definitions/${encodeURIComponent(id)}/${data.disabled ? 'ingest-disable' : 'ingest-enable'}`,
        { method: 'POST', body: JSON.stringify({ expectedVersion: data.expectedVersion }) },
      ),
    /** N-270: 受信の成否履歴。 */
    ingestionEvents: (id: string, limit = 50) =>
      fetchApi<ApiResponse<{ items: ConversionIngestionEvent[] }>>(
        `/api/conversions/definitions/${encodeURIComponent(id)}/ingest-events?limit=${limit}`,
      ),
    /** IDEA-19: 成果1件ずつの一覧(新しい順)。状態は口が導出済み。 */
    definitionEvents: (id: string, limit = 50) =>
      fetchApi<ApiResponse<{ items: ConversionDefinitionEvent[] }>>(
        `/api/conversions/definitions/${encodeURIComponent(id)}/events?limit=${limit}`,
      ),
    /** #819: 成果1件の取消履歴(新しい順)。 */
    reversals: (eventId: string) =>
      fetchApi<ApiResponse<ConversionReversal[]>>(
        `/api/conversions/events/${encodeURIComponent(eventId)}/reversals`,
      ),
    /** #819: 取消・取消の取消を理由付きで追記。元の成果行は消えない。 */
    appendReversal: (eventId: string, data: { kind: 'reverse' | 'restore'; reason: string; expectedReversalId?: string | null; expectedApprovalStatus?: 'pending' | 'approved' | 'rejected' | null; expectedCancelled?: boolean; expectedApprovalRevision?: number }) =>
      fetchApi<ApiResponse<{ id: string; kind: 'reverse' | 'restore'; createdAt: string }>>(
        `/api/conversions/events/${encodeURIComponent(eventId)}/reversals`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
    definitionReport: (params: { from: string; to: string; lineAccountId?: string }) => {
      const query = Object.fromEntries(
        Object.entries(params)
          .filter(([, value]) => value !== undefined && value !== '')
          .map(([key, value]) => [key, String(value)]),
      )
      return fetchApi<ApiResponse<ConversionDefinitionReport>>(
        `/api/conversions/report?${new URLSearchParams(query)}`,
      )
    },
    exportDefinitions: (params: { from: string; to: string; lineAccountId?: string }) => {
      const query = Object.fromEntries(
        Object.entries(params)
          .filter(([, value]) => value !== undefined && value !== '')
          .map(([key, value]) => [key, String(value)]),
      )
      return fetchApiBlob(`/api/conversions/export?${new URLSearchParams(query)}`)
    },
    points: () =>
      fetchApi<ApiResponse<ConversionPoint[]>>('/api/conversions/points'),
    createPoint: (data: {
      name: string
      eventType: string
      value?: number | null
      measureMethod?: ConversionMeasureMethod
      /** url_reach のときは必須。前方一致で判定する */
      targetUrl?: string | null
      /** false で「一人一回だけ数える」 */
      countRepeat?: boolean
      attributionDays?: number | null
      lineAccountId?: string | null
    }) =>
      fetchApi<ApiResponse<ConversionPoint>>('/api/conversions/points', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    /** 送った項目だけを書き換える。版の一致が必須(N-254)。 */
    updatePoint: (id: string, data: {
      name?: string
      eventType?: string
      value?: number | null
      measureMethod?: ConversionMeasureMethod
      targetUrl?: string | null
      countRepeat?: boolean
      attributionDays?: number | null
      lineAccountId?: string | null
      /** 必須。ずれると409 */
      expectedVersion: number
    }) =>
      fetchApi<ApiResponse<ConversionPoint>>(`/api/conversions/points/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    /** 停止する。版の一致が必須(N-254)。本文が落ちる通信経路でも届くようクエリで送る。 */
    deletePoint: (id: string, expectedVersion: number) =>
      fetchApi<ApiResponse<null>>(`/api/conversions/points/${id}?expectedVersion=${expectedVersion}`, { method: 'DELETE' }),
    track: (data: { conversionPointId: string; friendId: string; userId?: string | null; affiliateCode?: string | null; metadata?: Record<string, unknown> | null; idempotencyKey?: string | null }) =>
      fetchApi<ApiResponse<unknown>>('/api/conversions/track', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    report: (params?: { startDate?: string; endDate?: string }) =>
      fetchApi<ApiResponse<{ conversionPointId: string; conversionPointName: string; eventType: string; totalCount: number; totalValue: number }[]>>(
        '/api/conversions/report?' + new URLSearchParams(params as Record<string, string>),
      ),
  },
  conversionApprovals: {
    counts: () => fetchApi<ApiResponse<ConversionApprovalCounts>>('/api/conversions/approvals/counts'),
    list: (params?: { status?: 'pending' | 'approved' | 'rejected'; limit?: number; offset?: number }) => {
      const p = new URLSearchParams()
      if (params?.status) p.set('status', params.status)
      if (params?.limit !== undefined) p.set('limit', String(params.limit))
      if (params?.offset !== undefined) p.set('offset', String(params.offset))
      const qs = p.toString()
      return fetchApi<{ success: boolean; data: ConversionApprovalItem[] }>(
        `/api/conversions/approvals${qs ? `?${qs}` : ''}`,
      )
    },
    approve: (eventId: string, expectedStatus: 'pending' | 'approved' | 'rejected') =>
      fetchApi<{ success: boolean; data?: { id: string; approvalStatus: string }; error?: string; code?: string }>(
        `/api/conversions/events/${eventId}/approval`,
        { method: 'PATCH', body: JSON.stringify({ status: 'approved', expectedStatus }) },
      ),
    reject: (eventId: string, expectedStatus: 'pending' | 'approved' | 'rejected') =>
      fetchApi<{ success: boolean; data?: { id: string; approvalStatus: string }; error?: string; code?: string }>(
        `/api/conversions/events/${eventId}/approval`,
        { method: 'PATCH', body: JSON.stringify({ status: 'rejected', expectedStatus }) },
      ),
    bulkDecide: (items: Array<{ id: string; status: 'approved' | 'rejected'; expectedStatus: 'pending' | 'approved' | 'rejected' }>) =>
      fetchApi<{ success: boolean; data?: {
        succeeded: string[]
        conflicted: Array<{ id: string; currentStatus: string }>
        denied: string[]
        failed: Array<{ id: string; error: string }>
      }; error?: string }>(
        '/api/conversions/approvals/bulk',
        { method: 'POST', body: JSON.stringify({ items }) },
      ),
    /** どの紹介に成果を付けたかの記録。無い昔の成果は success:false。#823 */
    attribution: (eventId: string) =>
      fetchApi<{ success: boolean; data: AttributionDecisionView; error?: string }>(
        `/api/conversions/events/${encodeURIComponent(eventId)}/attribution`,
      ),
  },
}
