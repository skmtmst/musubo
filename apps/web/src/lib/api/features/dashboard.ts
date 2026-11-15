import { fetchApi } from '../transport/request'
import type { ApiResponse, DashboardActivityItem, DashboardComparisons } from '@line-crm/shared'
import type { DashboardOverview, DashboardUpcoming, DashboardPreferenceResponse } from '../types/dashboard'
import type { DeliveryFailureOrigins } from '../types/commerce'

export const dashboardMethods = {
  dashboard: {
    activity: (accountId: string, limit = 10) =>
      fetchApi<ApiResponse<{ items: DashboardActivityItem[] }>>(
        `/api/dashboard/activity?account_id=${encodeURIComponent(accountId)}&limit=${encodeURIComponent(String(limit))}`,
      ),
    overview: (params: { period?: 'today' | 'last7' | 'last28' | 'last30' | 'last90' | 'custom'; accountId: string; from?: string; to?: string }) => {
      const query = new URLSearchParams()
      if (params?.period) query.set('period', params.period)
      if (params.from) query.set('from', params.from)
      if (params.to) query.set('to', params.to)
      query.set('account_id', params.accountId)
      const suffix = query.size ? `?${query}` : ''
      return fetchApi<ApiResponse<DashboardOverview>>(`/api/dashboard/overview${suffix}`)
    },
    organizationOverview: (params?: { period?: 'today' | 'last7' | 'last28' | 'last30' | 'last90' | 'custom'; from?: string; to?: string }) => {
      const query = new URLSearchParams()
      if (params?.period) query.set('period', params.period)
      if (params?.from) query.set('from', params.from)
      if (params?.to) query.set('to', params.to)
      const suffix = query.size ? `?${query}` : ''
      return fetchApi<ApiResponse<DashboardOverview>>(`/api/dashboard/organization-overview${suffix}`)
    },
    /** M (今後の予定): 7日分の束ね。読むだけ。 */
    upcoming: (accountId: string, days = 7) =>
      fetchApi<ApiResponse<DashboardUpcoming>>(
        `/api/dashboard/upcoming?account_id=${encodeURIComponent(accountId)}&days=${encodeURIComponent(String(days))}`,
      ),
    /** L (#824 数字の出どころ): 出どころ別の失敗の数。 */
    deliveryFailureOrigins: (accountId: string, since?: string) => {
      const query = new URLSearchParams()
      query.set('account_id', accountId)
      if (since) query.set('since', since)
      return fetchApi<ApiResponse<DeliveryFailureOrigins>>(`/api/dashboard/delivery-failure-origins?${query}`)
    },
    /** 数の帯の比べる値。後から読む。比べられない数は null（0 として比べない）。 */
    comparisons: (accountId: string) =>
      fetchApi<ApiResponse<DashboardComparisons>>(
        `/api/dashboard/comparisons?account_id=${encodeURIComponent(accountId)}`,
      ),
    preferences: {
      get: (accountId: string) => fetchApi<ApiResponse<DashboardPreferenceResponse>>(
        `/api/dashboard/preferences?account_id=${encodeURIComponent(accountId)}`,
      ),
      save: (accountId: string, data: { version: number; cards: unknown }) =>
        fetchApi<ApiResponse<DashboardPreferenceResponse>>(
          `/api/dashboard/preferences?account_id=${encodeURIComponent(accountId)}`,
          { method: 'PUT', body: JSON.stringify(data) },
        ),
      reset: (accountId: string) => fetchApi<ApiResponse<null>>(
        `/api/dashboard/preferences?account_id=${encodeURIComponent(accountId)}`,
        { method: 'DELETE' },
      ),
    },
  },
}
