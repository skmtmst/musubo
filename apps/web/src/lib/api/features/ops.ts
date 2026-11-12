import { fetchApi } from '../transport/request'
import type { ApiResponse, TenantCompanyContactInfo, SaveTenantCompanyContact } from '@line-crm/shared'
import type {
  OpsMe,
  OpsTenantRow,
  OpsTenantSummary,
  OpsApplication,
  OpsTenantDetail,
  OpsImpersonation,
  OpsAuditRow,
  OpsMember,
  OpsMemberSummary,
  OpsMemberActivationState,
  OpsDashboardPeriod,
  OpsDashboard,
  OpsLineUnregistered,
  OpsFirstRunFunnel,
  OpsSupportDetail,
  OpsAnnouncement,
  OpsAnnouncementAudience,
  OpsAudiencePreview,
  OpsAnnouncementInput,
  OpsNoticeLineAccount,
  OpsSupportSummary,
  OpsSupportStage,
  OpsSupportPriority,
  OpsSupportTicket,
  OpsSupportMessage,
  OpsSupportDraft,
  OpsSupportTemplateCatalog,
  OpsSupportTemplateFolder,
  OpsSupportReplyTemplate,
  HqNotice,
  HqLineRegistration,
  HqLineRegistrationStatus,
  OperatorHistoryRow,
} from '../types/ops'
import { ApiError } from '../transport/errors'

export const opsMethods = {
/** 運営コンソール（★管理画面 37）。形は `apps/worker/src/routes/ops.ts`。 */
  ops: {
    me: () => fetchApi<ApiResponse<OpsMe>>('/api/ops/me'),
    applications: {
      list: () => fetchApi<ApiResponse<OpsApplication[]>>('/api/ops/applications'),
      get: (id: string) => fetchApi<ApiResponse<OpsApplication>>(`/api/ops/applications/${encodeURIComponent(id)}`),
      contact: (id: string, note: string) => fetchApi<ApiResponse<OpsApplication>>(`/api/ops/applications/${encodeURIComponent(id)}/contact`, { method: 'POST', body: JSON.stringify({ note }) }),
      approve: (id: string, conditionId?: string) => fetchApi<ApiResponse<{ application: OpsApplication; mailSent: boolean }>>(`/api/ops/applications/${encodeURIComponent(id)}/approve`,
        { method: 'POST', body: JSON.stringify(conditionId ? { conditionId } : {}) }),
      resendInvite: (id: string) => fetchApi<ApiResponse<OpsApplication>>(`/api/ops/applications/${encodeURIComponent(id)}/resend-invite`, { method: 'POST', body: '{}' }),
    },
    tenants: (params?: { q?: string; status?: string }) => {
      const query = new URLSearchParams()
      if (params?.q) query.set('q', params.q)
      if (params?.status) query.set('status', params.status)
      const qs = query.toString()
      return fetchApi<ApiResponse<OpsTenantRow[]> & { summary: OpsTenantSummary }>(`/api/ops/tenants${qs ? `?${qs}` : ''}`)
    },
    tenant: (id: string) => fetchApi<ApiResponse<OpsTenantDetail>>(`/api/ops/tenants/${encodeURIComponent(id)}`),
    createTenant: (name: string, featurePacks?: string[]) =>
      fetchApi<ApiResponse<{ id: string; name: string }>>('/api/tenants', { method: 'POST', body: JSON.stringify(featurePacks === undefined ? { name } : { name, featurePacks }) }),
    changeTenantStatus: (id: string, input: { status: 'active' | 'suspended' | 'archived'; reason: string; confirmName?: string }) =>
      fetchApi<ApiResponse<{ status: string }>>(`/api/ops/tenants/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: JSON.stringify(input) }),
    setTenantFeaturePacks: (id: string, featurePacks: string[]) =>
      fetchApi<ApiResponse<{ featurePacks: string[] }>>(`/api/ops/tenants/${encodeURIComponent(id)}/feature-packs`, { method: 'PATCH', body: JSON.stringify({ featurePacks }) }),
    impersonation: {
      current: () => fetchApi<ApiResponse<OpsImpersonation | null>>('/api/ops/impersonation/current'),
      start: (tenantId: string) => fetchApi<ApiResponse<OpsImpersonation>>('/api/ops/impersonation/start', { method: 'POST', body: JSON.stringify({ tenantId }) }),
      write: (reason: string, expectedSessionId?: string) => fetchApi<ApiResponse<OpsImpersonation>>('/api/ops/impersonation/write', { method: 'POST', body: JSON.stringify({ reason, expectedSessionId }) }),
      read: () => fetchApi<ApiResponse<OpsImpersonation>>('/api/ops/impersonation/read', { method: 'POST', body: '{}' }),
      revealPii: (reason: string, expectedSessionId?: string) => fetchApi<ApiResponse<OpsImpersonation>>('/api/ops/impersonation/pii-reveal', { method: 'POST', body: JSON.stringify({ reason, expectedSessionId }) }),
      end: () => fetchApi<ApiResponse<null>>('/api/ops/impersonation/end', { method: 'POST', body: '{}' }),
    },
    audit: (params?: { tenantId?: string; action?: string; from?: string; to?: string; limit?: number; offset?: number }) => {
      const query = new URLSearchParams()
      if (params?.tenantId) query.set('tenant_id', params.tenantId)
      if (params?.action) query.set('action', params.action)
      if (params?.from) query.set('from', params.from)
      if (params?.to) query.set('to', params.to)
      if (params?.limit) query.set('limit', String(params.limit))
      if (params?.offset) query.set('offset', String(params.offset))
      const qs = query.toString()
      return fetchApi<ApiResponse<OpsAuditRow[]> & { total: number }>(`/api/ops/audit${qs ? `?${qs}` : ''}`)
    },
    members: () => fetchApi<ApiResponse<OpsMember[]> & { summary: OpsMemberSummary }>('/api/ops/members'),
    addMember: (input: { staffId?: string; email?: string }) =>
      fetchApi<ApiResponse<{ staffId: string; activationState: OpsMemberActivationState }>>('/api/ops/members', { method: 'POST', body: JSON.stringify(input) }),
    resendInvite: (staffId: string) =>
      fetchApi<ApiResponse<{ staffId: string; activationState: OpsMemberActivationState }>>(`/api/ops/members/${encodeURIComponent(staffId)}/resend-invite`, { method: 'POST', body: JSON.stringify({}) }),
    setMemberActive: (staffId: string, isActive: boolean) =>
      fetchApi<ApiResponse<{ staffId: string; isActive: boolean }>>(`/api/ops/members/${encodeURIComponent(staffId)}`, { method: 'PATCH', body: JSON.stringify({ isActive }) }),
    /** ダッシュボード ★管理画面 37-2。 */
    dashboard: (period?: OpsDashboardPeriod) =>
      fetchApi<ApiResponse<OpsDashboard>>(`/api/ops/dashboard${period ? `?period=${period}` : ''}`),
    billingSync: async (months = 12) => {
      try {
        return await fetchApi<ApiResponse<{ tenants: number; imported: number; failed: number; completed: boolean; since: string; syncedAt: string | null }>>('/api/ops/billing/sync', { method: 'POST', body: JSON.stringify({ months }) })
      } catch (error) {
        // 5xx の本文は共通 fetchApi が画面へ出さない。同期APIの 503 は
        // Stripe 未設定だけなので、利用者が直せる既知の案内へ言い換える。
        if (error instanceof ApiError && error.status === 503) {
          throw new Error('Stripe の接続設定がまだありません')
        }
        throw error
      }
    },
    lineUnregistered: () => fetchApi<ApiResponse<OpsLineUnregistered>>('/api/ops/dashboard/line-unregistered'),
    firstRun: (period?: OpsDashboardPeriod) =>
      fetchApi<ApiResponse<OpsFirstRunFunnel>>(`/api/ops/dashboard/first-run${period ? `?period=${period}` : ''}`),
    /** お知らせ配信 ★管理画面 37-7。 */
    announcements: {
      list: () => fetchApi<ApiResponse<OpsAnnouncement[]> & { linked: { linked: number; total: number }; noticeLineConfigured: boolean }>('/api/ops/announcements'),
      preview: (input: { audienceKind: OpsAnnouncementAudience; audiencePlans: string[]; audienceTenantIds: string[] }) =>
        fetchApi<ApiResponse<OpsAudiencePreview>>('/api/ops/announcements/preview', { method: 'POST', body: JSON.stringify(input) }),
      /**
       * M512: idempotencyKey（UUID）を渡すと二重押しでも1件だけ作り、再送は
       * 保存済みを返す。省略時は従来どおり作る。
       */
      create: (input: OpsAnnouncementInput, idempotencyKey?: string) => fetchApi<ApiResponse<OpsAnnouncement>>('/api/ops/announcements', {
        method: 'POST',
        ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
        body: JSON.stringify(input),
      }),
      /** M513: expectedUpdatedAt を渡すと、古い画面からの保存は最新つきで409になる。省略時は従来どおり通す。 */
      update: (id: string, input: OpsAnnouncementInput, expectedUpdatedAt?: string) => fetchApi<ApiResponse<OpsAnnouncement>>(`/api/ops/announcements/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(expectedUpdatedAt === undefined ? input : { ...input, expectedUpdatedAt }),
      }),
      remove: (id: string) => fetchApi<ApiResponse<null>>(`/api/ops/announcements/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    },
    noticeLineAccount: () => fetchApi<ApiResponse<OpsNoticeLineAccount>>('/api/ops/notice-line-account'),
    connectNoticeLineAccount: (input: { channelId: string; channelSecret: string; basicId: string }, stepUpToken?: string) =>
      fetchApi<ApiResponse<{ accountId: string; name: string; basicId: string }>>('/api/ops/notice-line-account/connect', {
        method: 'POST',
        headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
        body: JSON.stringify(input),
      }),
    setNoticeLineAccount: (lineAccountId: string | null) =>
      fetchApi<ApiResponse<{ currentId: string | null }>>('/api/ops/notice-line-account', { method: 'PUT', body: JSON.stringify({ lineAccountId }) }),
    /** お問い合わせ（チケット）★管理画面 37-6。 */
    support: {
      summary: () => fetchApi<ApiResponse<OpsSupportSummary>>('/api/ops/support/summary'),
      templates: () => fetchApi<ApiResponse<OpsSupportTemplateCatalog>>('/api/ops/support/templates'),
      createTemplateFolder: (name: string) =>
        fetchApi<ApiResponse<OpsSupportTemplateFolder>>('/api/ops/support/template-folders', { method: 'POST', body: JSON.stringify({ name }) }),
      createTemplate: (input: { folderId: string; title: string; body: string }) =>
        fetchApi<ApiResponse<OpsSupportReplyTemplate>>('/api/ops/support/templates', { method: 'POST', body: JSON.stringify(input) }),
      updateTemplate: (id: string, input: { folderId: string; title: string; body: string; expectedUpdatedAt: string }) =>
        fetchApi<ApiResponse<OpsSupportReplyTemplate>>(`/api/ops/support/templates/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
      deleteTemplate: (id: string, expectedUpdatedAt: string) =>
        fetchApi<ApiResponse<null>>(`/api/ops/support/templates/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ expectedUpdatedAt }) }),
      tickets: (params?: { stage?: OpsSupportStage | 'all'; priority?: OpsSupportPriority; q?: string; sort?: 'newest' | 'oldest' | 'priority'; limit?: number; offset?: number }) => {
        const query = new URLSearchParams()
        if (params?.stage) query.set('stage', params.stage)
        if (params?.priority) query.set('priority', params.priority)
        if (params?.q) query.set('q', params.q)
        if (params?.sort) query.set('sort', params.sort)
        if (params?.limit) query.set('limit', String(params.limit))
        if (params?.offset) query.set('offset', String(params.offset))
        const qs = query.toString()
        return fetchApi<ApiResponse<OpsSupportTicket[]> & { total: number }>(`/api/ops/support/tickets${qs ? `?${qs}` : ''}`)
      },
      ticket: (id: string) => fetchApi<ApiResponse<OpsSupportDetail>>(`/api/ops/support/tickets/${encodeURIComponent(id)}`),
      update: (id: string, input: { stage?: OpsSupportStage; priority?: OpsSupportPriority }) =>
        fetchApi<ApiResponse<OpsSupportTicket>>(`/api/ops/support/tickets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
      reply: (id: string, input: { body: string; nextStage?: OpsSupportStage }) =>
        fetchApi<ApiResponse<{ ticket: OpsSupportTicket; message: OpsSupportMessage; mailSent: boolean; mailSkippedReason: 'no_email' | 'send_failed' | null }>>(`/api/ops/support/tickets/${encodeURIComponent(id)}/reply`, { method: 'POST', body: JSON.stringify(input) }),
      saveDraft: (id: string, body: string) =>
        fetchApi<ApiResponse<OpsSupportDraft | null>>(`/api/ops/support/tickets/${encodeURIComponent(id)}/draft`, { method: 'PUT', body: JSON.stringify({ body }) }),
      deleteDraft: (id: string) =>
        fetchApi<ApiResponse<null>>(`/api/ops/support/tickets/${encodeURIComponent(id)}/draft`, { method: 'DELETE' }),
      create: (input: { tenantId: string; subject: string; body: string; kind?: string; priority?: OpsSupportPriority; channel?: 'ops' | 'line'; staffId?: string }) =>
        fetchApi<ApiResponse<OpsSupportTicket>>('/api/ops/support/tickets', { method: 'POST', body: JSON.stringify(input) }),
    },
  },
/** 運営からのお知らせ（統括の画面）と契約者専用LINEの登録案内。 */
  hqNotices: {
    list: () => fetchApi<ApiResponse<HqNotice[]>>('/api/hq/notices'),
    markRead: (id: string) => fetchApi<ApiResponse<{ read: boolean }>>(`/api/hq/notices/${encodeURIComponent(id)}/read`, { method: 'POST', body: '{}' }),
    lineRegistration: () => fetchApi<ApiResponse<HqLineRegistration>>('/api/hq/notices/line-registration'),
    lineRegistrationStatus: () => fetchApi<ApiResponse<HqLineRegistrationStatus>>('/api/hq/notices/line-registration/status'),
  },
/** 契約先（統括）から見える運営の操作履歴。書き込みを伴ったものだけ。 */
  operatorHistory: () => fetchApi<ApiResponse<OperatorHistoryRow[]>>('/api/hq/operator-history'),
  tenants: {
    me: () => fetchApi<ApiResponse<{ name: string }>>('/api/tenants/me'),
    companyContact: () => fetchApi<ApiResponse<TenantCompanyContactInfo>>('/api/tenants/me/company-contact'),
    saveCompanyContact: (body: SaveTenantCompanyContact) =>
      fetchApi<ApiResponse<TenantCompanyContactInfo>>('/api/tenants/me/company-contact', {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    updateName: (name: string) =>
      fetchApi<ApiResponse<{ name: string }>>('/api/tenants/me', {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
  },
}
