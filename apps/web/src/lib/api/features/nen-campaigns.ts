import type {
  NenMetricsQueryRange,
  NenFlowMetrics,
  NenColumnMetrics,
  NenPetMetrics,
  NenDeliveryList,
  NenDeliveryDetail,
  NenCampaignSetting,
  NenColumn,
  NenColumnCreateInput,
  NenColumnDeliveryPreview,
  NenPetProfile,
} from '../types/nen-campaigns'
import { fetchApi } from '../transport/request'
import type { ApiResponse } from '@line-crm/shared'

function nenMetricsQuery(accountId: string, range: number | NenMetricsQueryRange): string {
  const query = new URLSearchParams({ lineAccountId: accountId })
  if (typeof range === 'number') query.set('days', String(range))
  else { query.set('from', range.from); query.set('to', range.to) }
  return query.toString()
}

export const nenCampaignsMethods = {
  nenCampaigns: {
    /** 期間は日数か、★管理画面 37-6 の「今月・先月」のための from/to（ISO 8601）。 */
    flowMetrics: (accountId: string, range: number | NenMetricsQueryRange = 30) => fetchApi<ApiResponse<NenFlowMetrics>>(
      `/api/nen-campaigns/metrics/flows?${nenMetricsQuery(accountId, range)}`,
    ),
    columnMetrics: (accountId: string, range: number | NenMetricsQueryRange = 30) => fetchApi<ApiResponse<NenColumnMetrics>>(
      `/api/nen-campaigns/metrics/columns?${nenMetricsQuery(accountId, range)}`,
    ),
    petMetrics: (accountId: string, days = 30) => fetchApi<ApiResponse<NenPetMetrics>>(
      `/api/nen-campaigns/metrics/pets?lineAccountId=${encodeURIComponent(accountId)}&days=${days}`,
    ),
    deliveries: (accountId: string, options: { days?: number; from?: string; to?: string; status?: string; q?: string; cursor?: string; limit?: number } = {}) => {
      const query = new URLSearchParams({ lineAccountId: accountId, days: String(options.days ?? 30), limit: String(options.limit ?? 50) })
      // from/to を両方渡すと days の代わりにその期間で数える（実口 nenDeliveryRange と同じ決めごと）。
      if (options.from && options.to) { query.delete('days'); query.set('from', options.from); query.set('to', options.to) }
      if (options.status) query.set('status', options.status)
      if (options.q) query.set('q', options.q)
      if (options.cursor) query.set('cursor', options.cursor)
      return fetchApi<ApiResponse<NenDeliveryList>>(`/api/nen-campaigns/deliveries?${query}`)
    },
    delivery: (id: string, accountId: string) => fetchApi<ApiResponse<NenDeliveryDetail>>(
      `/api/nen-campaigns/deliveries/${encodeURIComponent(id)}?lineAccountId=${encodeURIComponent(accountId)}`,
    ),
    retryDelivery: (id: string, data: { lineAccountId: string; expectedVersion: number; reason: string }) =>
      fetchApi<ApiResponse<{ id: string; status: string; version: number; attempts: number }>>(
        `/api/nen-campaigns/deliveries/${encodeURIComponent(id)}/retry`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
    overview: (accountId: string) => fetchApi<ApiResponse<{
      activeCampaigns: number
      jobs: {
        total: number
        pending: number
        sent: number
        failed: number
        /** 配信ごとの「これから送る」待ち件数（編集画面の表示用）。 */
        pendingByCampaign: Record<string, number>
      }
      columns: number
      pets: number
      coupons: number
    }>>(`/api/nen-campaigns/overview?lineAccountId=${encodeURIComponent(accountId)}`),
    settings: (accountId: string) => fetchApi<ApiResponse<NenCampaignSetting[]>>(
      `/api/nen-campaigns/settings?lineAccountId=${encodeURIComponent(accountId)}`,
    ),
    updateSetting: (accountId: string, campaignKey: string, data: Pick<NenCampaignSetting,
      'isEnabled' | 'title' | 'bodyText' | 'delayDays' | 'deliveryTime' | 'buttonLabel' | 'buttonUrl' | 'imageUrl' | 'dedupWindowDays' | 'excludeFormRespondents' | 'afterActions'> & {
      /**
       * M507: 開いたときに見た版。違う版からの保存は最新の内容つきで409に
       * なる。省略時は従来どおり通す。
       */
      expectedUpdatedAt?: string
    }) =>
      fetchApi<{ success: boolean; data?: { updatedAt: string } }>(`/api/nen-campaigns/settings/${encodeURIComponent(campaignKey)}?lineAccountId=${encodeURIComponent(accountId)}`, {
        method: 'PUT', body: JSON.stringify(data),
      }),
    /** 一覧の停止・再開だけを切り替える。本文の長さに関わらず必ず実行できる（#659）。 */
    setEnabled: (accountId: string, campaignKey: string, isEnabled: boolean, expectedUpdatedAt?: string) =>
      fetchApi<{ success: boolean; data?: { updatedAt: string | null } }>(`/api/nen-campaigns/settings/${encodeURIComponent(campaignKey)}/enabled?lineAccountId=${encodeURIComponent(accountId)}`, {
        method: 'PUT', body: JSON.stringify({ isEnabled, expectedUpdatedAt }),
      }),
    testSend: (data: {
      campaignKey: string; accountId: string; friendId: string
      /** 編集中の下書き。渡した項目だけ保存済み設定に重ねて試送する（本配信設定は変わらない）。 */
      draft?: { title?: string; bodyText?: string; buttonLabel?: string; buttonUrl?: string; imageUrl?: string }
    }) =>
      fetchApi<{ success: boolean }>('/api/nen-campaigns/test-send', { method: 'POST', body: JSON.stringify(data) }),
    jobs: (accountId: string) => fetchApi<ApiResponse<Array<{
      id: string; campaignKey: string; label: string; friendName: string | null
      scheduledAt: string; status: string; attempts: number; lastError: string | null; sentAt: string | null
    }>>>(`/api/nen-campaigns/jobs?lineAccountId=${encodeURIComponent(accountId)}`),
    /*
     * 口は既定200件で打ち切り、pagination.total に全体件数を返す。
     * 呼び出し側は data.length と pagination.total を比べて打ち切りを画面へ出す（#935 N-300）。
     */
    columns: (accountId: string, options?: { limit?: number; offset?: number }) => {
      const params = new URLSearchParams({ lineAccountId: accountId })
      if (options?.limit !== undefined) params.set('limit', String(options.limit))
      if (options?.offset !== undefined) params.set('offset', String(options.offset))
      return fetchApi<ApiResponse<NenColumn[]> & {
        pagination?: { total: number; limit: number; offset: number }
      }>(`/api/nen-campaigns/columns?${params}`)
    },
    /** NENコラムの管理画面下書き。本文・slug・アカウントIDはWorkerで受け取らない。 */
    createColumn: (accountId: string, data: NenColumnCreateInput) =>
      fetchApi<ApiResponse<{ id: string; queued: number }>>(
        `/api/nen-campaigns/columns?lineAccountId=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
    columnAudience: (accountId: string, targetMode: 'all' | 'tag', targetTagId?: string | null) => {
      const query = new URLSearchParams({ lineAccountId: accountId, targetMode })
      if (targetTagId) query.set('targetTagId', targetTagId)
      return fetchApi<ApiResponse<{ count: number; targetMode: 'all' | 'tag'; targetTagId: string | null }>>(
        `/api/nen-campaigns/columns-preview?${query}`,
      )
    },
    /** ★管理画面 37-6-A「ECのコラムを取り込む」。宛先が決まらず未割り当てになっているECコラムを、このアカウントへ割り当てる。 */
    importColumns: (accountId: string) => fetchApi<ApiResponse<{ imported: number }>>(
      `/api/nen-campaigns/columns/import?lineAccountId=${encodeURIComponent(accountId)}`,
      { method: 'POST' },
    ),
    /*
     * M506: 複製の要求キー。同じコラムのやり直しは同じキーで送り、
     * サーバは同じ複製を返す（`replayed`）。別の複製は別のキーで呼ぶ。
     */
    duplicateColumn: (id: string, accountId: string, options?: { idempotencyKey?: string }) => fetchApi<ApiResponse<{ id: string; sourceColumnId: string }> & { replayed?: boolean }>(
      `/api/nen-campaigns/columns/${encodeURIComponent(id)}/duplicate`,
      {
        method: 'POST',
        body: JSON.stringify({ accountId }),
        ...(options?.idempotencyKey ? { headers: { 'Idempotency-Key': options.idempotencyKey } } : {}),
      },
    ),
    testColumn: (id: string, accountId: string, friendId: string) => fetchApi<{ success: boolean }>(
      `/api/nen-campaigns/columns/${encodeURIComponent(id)}/test-send`,
      { method: 'POST', body: JSON.stringify({ accountId, friendId }) },
    ),
    sendPendingNow: (accountId: string, expectedCount: number) => fetchApi<ApiResponse<{ queued: number }>>(
      '/api/nen-campaigns/deliveries/pending-now',
      { method: 'POST', body: JSON.stringify({ accountId, expectedCount }) },
    ),
    previewColumnDelivery: (accountId: string, id: string) =>
      fetchApi<ApiResponse<NenColumnDeliveryPreview>>(`/api/nen-campaigns/columns/${encodeURIComponent(id)}/send-preview?lineAccountId=${encodeURIComponent(accountId)}`),
    deliverColumn: (id: string, data: { accountId: string; scheduledAt?: string; recipientCount?: number; confirmationToken?: string }) =>
      fetchApi<ApiResponse<{ queued: number }>>(`/api/nen-campaigns/columns/${encodeURIComponent(id)}/deliver`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    /** M507: expectedUpdatedAt を渡すと、古い画面からの保存は最新の紹介文つきで409になる。省略時は従来どおり通す。成功時は新しい版を返す。 */
    updateColumnMessage: (accountId: string, id: string, introText: string, expectedUpdatedAt?: string) =>
      fetchApi<{ success: boolean; data?: { updatedAt: string } }>(`/api/nen-campaigns/columns/${encodeURIComponent(id)}/message?lineAccountId=${encodeURIComponent(accountId)}`, {
        method: 'PUT', body: JSON.stringify(expectedUpdatedAt === undefined ? { introText } : { introText, expectedUpdatedAt }),
      }),
    pets: (accountId: string, search?: string) => {
      const query = new URLSearchParams({ lineAccountId: accountId })
      if (search) query.set('search', search)
      return fetchApi<ApiResponse<NenPetProfile[]>>(`/api/nen-campaigns/pets?${query}`)
    },
    /**
     * M510: idempotencyKey（UUID）を渡すと二重押しでも1頭だけ作り、再送は
     * 保存済みを返す。省略時は従来どおり作る。
     */
    createPet: (accountId: string, data: { friendId: string; customerId?: string; name: string; animalType: string; gender: string; birthday?: string; breed?: string; weightKg?: number | null }, idempotencyKey?: string) =>
      fetchApi<ApiResponse<{ id: string }>>(`/api/nen-campaigns/pets?lineAccountId=${encodeURIComponent(accountId)}`, {
        method: 'POST',
        ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
        body: JSON.stringify(data),
      }),
    /** M511: expectedUpdatedAt を渡すと、古い画面からの保存は最新の内容つきで409になる。省略時は従来どおり通す。成功時は新しい版を返す。 */
    updatePet: (accountId: string, id: string, data: { name: string; animalType: string; gender: string; birthday?: string; breed?: string; weightKg?: number | null; expectedUpdatedAt?: string }) =>
      fetchApi<{ success: boolean; data?: { updatedAt: string } }>(`/api/nen-campaigns/pets/${encodeURIComponent(id)}?lineAccountId=${encodeURIComponent(accountId)}`, { method: 'PUT', body: JSON.stringify(data) }),
    deletePet: (accountId: string, id: string) => fetchApi<{ success: boolean }>(
      `/api/nen-campaigns/pets/${encodeURIComponent(id)}?lineAccountId=${encodeURIComponent(accountId)}`,
      { method: 'DELETE' },
    ),
    birthdayCoupon: (accountId: string) => fetchApi<ApiResponse<{
      isEnabled: boolean; codePrefix: string; benefitLabel: string; discountAmount: number; validityDays: number;
      leapYearPolicy: 'feb28' | 'mar1' | 'skip'; updatedAt: string
    }>>(`/api/nen-campaigns/birthday-coupon?lineAccountId=${encodeURIComponent(accountId)}`),
    updateBirthdayCoupon: (accountId: string, data: { isEnabled: boolean; codePrefix: string; benefitLabel: string; discountAmount: number; validityDays: number; leapYearPolicy?: 'feb28' | 'mar1' | 'skip' }) =>
      fetchApi<{ success: boolean }>(`/api/nen-campaigns/birthday-coupon?lineAccountId=${encodeURIComponent(accountId)}`, { method: 'PUT', body: JSON.stringify(data) }),
  },
}
