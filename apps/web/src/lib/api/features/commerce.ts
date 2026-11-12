import { fetchApi } from '../transport/request'
import type { ApiResponse } from '@line-crm/shared'
import type {
  EcCommerceOverview,
  EcCommerceEvent,
  EcOrder,
  EcOrderList,
  EcOrderDetail,
  EcActionExecutionStatus,
  EcActionExecutionList,
  EcActionExecution,
  EcIdentityCandidateOperationsList,
  EcSubscriptionList,
  EcConnectorOverview,
  EcConnector,
  EcNotificationRunList,
  EcNotificationSetting,
  EcShipmentList,
} from '../types/commerce'

export const commerceMethods = {
  ecCommerce: {
    overview: (lineAccountId?: string) =>
      fetchApi<ApiResponse<EcCommerceOverview>>(lineAccountId
        ? `/api/ec-commerce/overview?lineAccountId=${encodeURIComponent(lineAccountId)}`
        : '/api/ec-commerce/overview'),
    events: (params?: { lineAccountId?: string; eventType?: string; status?: string; limit?: number; offset?: number }) => {
      const query = new URLSearchParams()
      if (params?.lineAccountId) query.set('lineAccountId', params.lineAccountId)
      if (params?.eventType) query.set('eventType', params.eventType)
      if (params?.status) query.set('status', params.status)
      if (params?.limit !== undefined) query.set('limit', String(params.limit))
      if (params?.offset !== undefined) query.set('offset', String(params.offset))
      const suffix = query.size ? `?${query}` : ''
      return fetchApi<ApiResponse<EcCommerceEvent[]> & { pagination: { total: number; limit: number; offset: number } }>(
        `/api/ec-commerce/events${suffix}`,
      )
    },
    orders: (params: { lineAccountId: string; status?: EcOrder['status']; query?: string; from?: string; to?: string; limit?: number; offset?: number }) => {
      const query = new URLSearchParams({ lineAccountId: params.lineAccountId })
      if (params.status) query.set('status', params.status)
      if (params.query) query.set('query', params.query)
      if (params.from) query.set('from', params.from)
      if (params.to) query.set('to', params.to)
      if (params.limit !== undefined) query.set('limit', String(params.limit))
      if (params.offset !== undefined) query.set('offset', String(params.offset))
      return fetchApi<ApiResponse<EcOrderList> & { pagination: { total: number; limit: number; offset: number } }>(
        `/api/ec-commerce/orders?${query}`,
      )
    },
    orderDetail: (id: string, lineAccountId: string) =>
      fetchApi<ApiResponse<EcOrderDetail>>(
        `/api/ec-commerce/orders/${encodeURIComponent(id)}?lineAccountId=${encodeURIComponent(lineAccountId)}`,
      ),
    actionExecutions: (params: { lineAccountId: string; eventId?: string; status?: EcActionExecutionStatus; statusGroup?: 'processing' | 'failed'; limit?: number; offset?: number }) => {
      const query = new URLSearchParams({ lineAccountId: params.lineAccountId })
      if (params.eventId) query.set('eventId', params.eventId)
      if (params.status) query.set('status', params.status)
      if (params.statusGroup) query.set('statusGroup', params.statusGroup)
      if (params.limit !== undefined) query.set('limit', String(params.limit))
      if (params.offset !== undefined) query.set('offset', String(params.offset))
      return fetchApi<ApiResponse<EcActionExecutionList> & { pagination: { total: number; limit: number; offset: number } }>(
        `/api/ec-commerce/action-executions?${query}`,
      )
    },
    retryActionExecution: (
      id: string,
      data: { lineAccountId: string; expectedVersion: number },
      idempotencyKey: string,
    ) => fetchApi<ApiResponse<EcActionExecution>>(
      `/api/ec-commerce/action-executions/${encodeURIComponent(id)}/retry`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(data),
      },
    ),
    operationIdentityCandidates: (params: { lineAccountId: string; status?: string; limit?: number; offset?: number }) => {
      const query = new URLSearchParams({ lineAccountId: params.lineAccountId })
      if (params.status) query.set('status', params.status)
      if (params.limit !== undefined) query.set('limit', String(params.limit))
      if (params.offset !== undefined) query.set('offset', String(params.offset))
      return fetchApi<ApiResponse<EcIdentityCandidateOperationsList> & { pagination: { total: number; limit: number; offset: number } }>(
        `/api/ec-commerce/identity-candidates?${query}`,
      )
    },
    subscriptions: (params: { lineAccountId: string; status?: string; limit?: number; offset?: number }) => {
      const query = new URLSearchParams({ lineAccountId: params.lineAccountId })
      if (params.status) query.set('status', params.status)
      if (params.limit !== undefined) query.set('limit', String(params.limit))
      if (params.offset !== undefined) query.set('offset', String(params.offset))
      return fetchApi<ApiResponse<EcSubscriptionList> & { pagination: { total: number; limit: number; offset: number } }>(
        `/api/ec-commerce/subscriptions?${query}`,
      )
    },
    connector: (lineAccountId: string) => fetchApi<ApiResponse<EcConnectorOverview>>(
      `/api/ec-commerce/connector?lineAccountId=${encodeURIComponent(lineAccountId)}`,
    ),
    updateConnector: (lineAccountId: string, data: {
      provider: EcConnector['provider']
      shopDomain: string
      status: EcConnector['status']
      inboundSecret?: string
      eventTypes: string[]
      identityRules: EcConnector['identityRules']
      expectedVersion: number
    }) => fetchApi<ApiResponse<{ version: number }>>(
      `/api/ec-commerce/connector?lineAccountId=${encodeURIComponent(lineAccountId)}`,
      { method: 'PUT', body: JSON.stringify(data) },
    ),
    notificationRuns: (params: { lineAccountId: string; view?: 'all' | 'failures'; limit?: number; offset?: number }) => {
      const query = new URLSearchParams({ lineAccountId: params.lineAccountId })
      if (params.view) query.set('view', params.view)
      if (params.limit !== undefined) query.set('limit', String(params.limit))
      if (params.offset !== undefined) query.set('offset', String(params.offset))
      return fetchApi<ApiResponse<EcNotificationRunList> & { pagination: { total: number; limit: number; offset: number } }>(
        `/api/ec-commerce/notification-runs?${query}`,
      )
    },
    settings: (lineAccountId: string) =>
      fetchApi<ApiResponse<EcNotificationSetting[]>>(`/api/ec-commerce/settings?lineAccountId=${encodeURIComponent(lineAccountId)}`),
    updateSetting: (lineAccountId: string, eventType: string, data: { isEnabled: boolean; title: string; introText: string; outroText: string; buttonLabel: string; buttonUrl: string; imageUrl: string }) =>
      fetchApi<{ success: boolean }>(`/api/ec-commerce/settings/${encodeURIComponent(eventType)}?lineAccountId=${encodeURIComponent(lineAccountId)}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    testSend: (data: { eventType: string; accountId: string; title: string; introText: string; outroText: string; buttonLabel: string; buttonUrl: string; imageUrl: string; expectedRecipientIds?: string[]; expectedConfirmationRevision?: number }) =>
      fetchApi<ApiResponse<{ sent: number }>>('/api/ec-commerce/test-send', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    shipments: (params?: { limit?: number; accountId?: string }) => {
      const query = new URLSearchParams()
      if (params?.limit !== undefined) query.set('limit', String(params.limit))
      // ダッシュボードのカードは選択中アカウントの件数と遷移先を一致させる。
      // 未指定は従来どおり可視範囲すべて。
      if (params?.accountId) query.set('account_id', params.accountId)
      const suffix = query.toString() ? `?${query.toString()}` : ''
      return fetchApi<ApiResponse<EcShipmentList>>(`/api/ec-commerce/shipments${suffix}`)
    },
  },
}
