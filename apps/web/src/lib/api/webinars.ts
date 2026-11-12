import type {
  WebinarListParams,
  WebinarListResponse,
  WebinarFolder,
  WebinarOverview,
  Webinar,
  WebinarEditor,
  WebinarPublishValidation,
  WebinarInput,
  WebinarAction,
  WebinarParticipantClassification,
  WebinarNotificationSettings,
  WebinarNotificationOverview,
  WebinarNotificationSettingsInput,
  WebinarSakuraComment,
  WebinarCtaCard,
  WebinarAnalytics,
  WebinarVideoAsset,
  WebinarSessionCapacity,
  WebinarParticipantPage,
  WebinarUserComment,
} from './types/webinars'
import { fetchApi } from './transport/request'
import type { ApiResponse } from '@line-crm/shared'

export const webinarApi = {
  /* 共通一覧契約の offset 方式。頁・件数・絞りはサーバーで行う。 */
  list: (accountId?: string, params?: WebinarListParams) => {
    const query = new URLSearchParams()
    if (accountId) query.set('account_id', accountId)
    if (params?.page) query.set('page', String(params.page))
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.q) query.set('q', params.q)
    if (params?.folder) query.set('folder', params.folder)
    if (params?.status) query.set('status', params.status)
    if (params?.sort) query.set('sort', params.sort)
    const suffix = query.size ? `?${query}` : ''
    return fetchApi<{ data: WebinarListResponse }>(`/api/webinars${suffix}`)
  },
  folders: (accountId: string) => fetchApi<ApiResponse<WebinarFolder[]>>(
    `/api/folders?kind=webinar&account_id=${encodeURIComponent(accountId)}`,
  ),
  createFolder: (accountId: string, input: { name: string; color?: string | null }) =>
    fetchApi<ApiResponse<WebinarFolder>>('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ kind: 'webinar', accountId, ...input }),
    }),
  updateFolder: (
    accountId: string,
    id: string,
    input: { name?: string; displayOrder?: number; color?: string | null },
  ) => fetchApi<ApiResponse<WebinarFolder>>(`/api/folders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ accountId, ...input }),
  }),
  deleteFolder: (accountId: string, id: string) => fetchApi<ApiResponse<null>>(
    `/api/folders/${encodeURIComponent(id)}?account_id=${encodeURIComponent(accountId)}`,
    { method: 'DELETE' },
  ),
  overview: (accountId: string) => fetchApi<{ data: WebinarOverview }>(
    `/api/webinars/overview?account_id=${encodeURIComponent(accountId)}`,
  ),
  get: (id: string) => fetchApi<{ data: Webinar }>(`/api/webinars/${id}`),
  editor: (id: string) => fetchApi<{ data: WebinarEditor }>(`/api/webinars/${id}/editor`),
  saveEditor: (id: string, input: Partial<Omit<WebinarEditor, 'version' | 'publicPage' | 'publication' | 'monitoring' | 'actionPolicy' | 'updatedAt'>> & {
    expectedVersion: number
    /** 読んだときの更新日時。付けると違っていたら 409 で止まる。 */
    expectedUpdatedAt?: string
    actionTemplateBody?: string
    missingResultPolicy?: WebinarEditor['actionPolicy']['missingResultPolicy']
    publicPageTest?: Record<string, unknown> | null
  }) => fetchApi<{ data: WebinarEditor }>(`/api/webinars/${id}/editor`, {
    method: 'PUT', body: JSON.stringify(input),
  }),
  testPublicPage: (id: string, expectedVersion: number) => fetchApi<{ data: WebinarEditor }>(`/api/webinars/${id}/public-page/test`, {
    method: 'POST', body: JSON.stringify({ expectedVersion }),
  }),
  publishValidation: (id: string) => fetchApi<{ data: WebinarPublishValidation }>(`/api/webinars/${id}/publish-validation`),
  publish: (id: string, expectedVersion: number) => fetchApi<{ data: { webinar: Webinar; validation: WebinarPublishValidation } }>(`/api/webinars/${id}/publish`, {
    method: 'POST', body: JSON.stringify({ expectedVersion }),
  }),
  pause: (id: string, expectedVersion: number) => fetchApi<{ data: Webinar }>(`/api/webinars/${id}/pause`, {
    method: 'POST', body: JSON.stringify({ expectedVersion }),
  }),
  duplicate: (id: string, expectedVersion: number) => fetchApi<{ data: Webinar }>(`/api/webinars/${id}/duplicate`, {
    method: 'POST', body: JSON.stringify({ expectedVersion }),
  }),
  create: (input: WebinarInput) =>
    fetchApi<{ data: Webinar }>('/api/webinars', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, input: WebinarInput) =>
    fetchApi<{ data: Webinar }>(`/api/webinars/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  archive: (id: string) => fetchApi<{ data: Webinar }>(`/api/webinars/${id}/archive`, { method: 'POST' }),
  actions: (id: string) => fetchApi<{ data: WebinarAction[] }>(`/api/webinars/${id}/actions`),
  saveActions: (id: string, actions: WebinarAction[]) => fetchApi<{ data: WebinarAction[] }>(
    `/api/webinars/${id}/actions`,
    { method: 'PUT', body: JSON.stringify({ actions }) },
  ),
  participantsCsvUrl: (id: string, filter?: WebinarParticipantClassification) =>
    `/api/webinars/${encodeURIComponent(id)}/participants.csv${filter ? `?filter=${encodeURIComponent(filter)}` : ''}`,
  notifications: (id: string) => fetchApi<{
    data: {
      settings: WebinarNotificationSettings | null
      overview: WebinarNotificationOverview
    }
  }>(`/api/webinars/${id}/notifications`),
  saveNotifications: (id: string, input: WebinarNotificationSettingsInput) => fetchApi<{
    data: {
      settings: WebinarNotificationSettings
      queued: number
      cancelled: number
    }
  }>(`/api/webinars/${id}/notifications`, {
    method: 'PUT',
    body: JSON.stringify(input),
  }),
  testNotificationRecipients: (id: string) => fetchApi<{data:{count:number;recipients:Array<{id:string;displayName:string|null}>;token:string;confirmationId:string}}>(`/api/webinars/${id}/notifications/test`),
  testNotifications: (id: string, expectedRecipientToken?: string, confirmationId?: string) => fetchApi<{
    data: { sent: number; failed: number }
  }>(`/api/webinars/${id}/notifications/test`, { method: 'POST', ...(expectedRecipientToken === undefined ? {} : {body:JSON.stringify({expectedRecipientToken,confirmationId})}) }),
  comments: (id: string) =>
    fetchApi<{ data: WebinarSakuraComment[] }>(`/api/webinars/${id}/comments`),
  saveComments: (id: string, comments: WebinarSakuraComment[]) =>
    fetchApi<{ data: { count: number } }>(`/api/webinars/${id}/comments`, {
      method: 'PUT',
      body: JSON.stringify({ comments: comments.map(({ atSeconds, authorName, body }) => ({ atSeconds, authorName, body })) }),
    }),
  ctas: (id: string) => fetchApi<{ data: WebinarCtaCard[]; version: number; updatedBy: string | null; updatedAt: string | null }>(`/api/webinars/${id}/ctas`),
  saveCtas: (id: string, ctas: WebinarCtaCard[], expectedVersion?: number) =>
    fetchApi<{ data: { count: number; version: number } }>(`/api/webinars/${id}/ctas`, {
      method: 'PUT',
      body: JSON.stringify({
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        ctas: ctas.map(({ atSeconds, kind, title, body, buttonLabel, autoOpen, formId, url }) => ({
          atSeconds, kind, title, body, buttonLabel, autoOpen, formId, url,
        })),
      }),
    }),
  analytics: (id: string) => fetchApi<{ data: WebinarAnalytics }>(`/api/webinars/${id}/analytics`),
  videoAsset: (id: string) => fetchApi<{ data: { asset: WebinarVideoAsset | null } }>(
    `/api/webinars/${id}/video-asset`,
  ),
  advanceVideoAsset: (
    id: string,
    input: { stage: WebinarVideoAsset['stage']; errorCode?: string | null; durationSeconds?: number | null },
  ) => fetchApi<{ data: { asset: WebinarVideoAsset } }>(`/api/webinars/${id}/video-asset/advance`, {
    method: 'POST', body: JSON.stringify(input),
  }),
  webinarSession: (id: string, startAt: number) => fetchApi<{ data: { session: WebinarSessionCapacity | null } }>(
    `/api/webinars/${id}/sessions/${startAt}`,
  ),
  setSessionCapacity: (id: string, startAt: number, capacity: number | null) =>
    fetchApi<{ data: { session: WebinarSessionCapacity } }>(`/api/webinars/${id}/sessions/${startAt}`, {
      method: 'PUT', body: JSON.stringify({ capacity }),
    }),
  participants: (id: string, cursor?: string, limit?: number, filter?: WebinarParticipantClassification) => fetchApi<{ data: WebinarParticipantPage }>(
    `/api/webinars/${id}/participants${cursor || limit || filter ? `?${[
      cursor ? `cursor=${encodeURIComponent(cursor)}` : '',
      limit ? `limit=${encodeURIComponent(String(limit))}` : '',
      filter ? `filter=${encodeURIComponent(filter)}` : '',
    ].filter(Boolean).join('&')}` : ''}`,
  ),
  userComments: (id: string) =>
    fetchApi<{ data: WebinarUserComment[] }>(`/api/webinars/${id}/user-comments`),
}
