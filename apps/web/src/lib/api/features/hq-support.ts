import { fetchApi } from '../transport/request'
import type { ApiResponse } from '@line-crm/shared'
import type {
  HqSupportContext,
  HqSupportKind,
  HqSupportRequest,
  HqSupportDetail,
  HqSupportMessage,
} from '../../hq-support'

export const hqSupportMethods = {
/** 統括から運営へのお問い合わせ（★管理画面 36-3）。形は `apps/worker/src/routes/hq-support.ts`。 */
  hqSupport: {
    summary: () => fetchApi<ApiResponse<{ total: number; newCount: number; inProgressCount: number; assignedInProgressCount: number; resolvedThisMonth: number; resolvedPreviousMonth: number; averageFirstReplyHours: number | null; firstReplySampleCount: number }>>('/api/hq/support/summary'),
    context: () => fetchApi<ApiResponse<HqSupportContext>>('/api/hq/support/context'),
    kinds: () => fetchApi<ApiResponse<Array<{ key: HqSupportKind; label: string }>>>('/api/hq/support/kinds'),
    list: () => fetchApi<ApiResponse<HqSupportRequest[]>>('/api/hq/support/requests'),
    create: (input: {
      kind: HqSupportKind
      subject: string
      body: string
      purpose?: 'individual_quote'
      lineAccountId?: string | null
      attachments?: Array<{ mimeType: string; data: string }>
    }) =>
      fetchApi<ApiResponse<HqSupportRequest & { notified: boolean }>>('/api/hq/support/requests', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    /** 1 件のやり取り（★管理画面 36-3-A）。 */
    detail: (id: string) => fetchApi<ApiResponse<HqSupportDetail>>(`/api/hq/support/requests/${encodeURIComponent(id)}`),
    /** 続きを送る。運営のチケットは対応中へ戻る。 */
    followUp: (id: string, input: { body: string; attachments?: Array<{ mimeType: string; data: string }> }) =>
      fetchApi<ApiResponse<HqSupportMessage & { stage: string; status: string }>>(`/api/hq/support/requests/${encodeURIComponent(id)}/messages`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  },
}
