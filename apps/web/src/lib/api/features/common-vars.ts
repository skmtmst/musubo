import type { FetchApiOptions } from '../types/transport'
import { fetchApi } from '../transport/request'
import type {
  CommonVarsListResponse,
  CommonVarDetail,
  CommonVarChangeImpactDetail,
  CommonVarReplacementCandidates,
  CommonVarReplacementImpact,
  CommonVarReplacementResult,
  CommonVarExportJob,
} from '../types/common-vars'
import type { ApiResponse, CommonVar, CommonVarDeleteImpact, CommonVarSchedule } from '@line-crm/shared'

export const commonVarsMethods = {
/** 共通情報。営業時間などを1か所で直す。 */
  commonVars: {
    list: (accountId: string, params?: { folderId?: string }, options?: FetchApiOptions) =>
      fetchApi<CommonVarsListResponse>(
        `/api/common-vars?accountId=${encodeURIComponent(accountId)}${params?.folderId ? `&folderId=${encodeURIComponent(params.folderId)}` : ''}`,
        options,
      ),
    detail: (id: string, accountId: string) =>
      fetchApi<ApiResponse<CommonVarDetail>>(
        `/api/common-vars/${id}?accountId=${encodeURIComponent(accountId)}`,
      ),
    create: (data: {
      accountId: string
      name: string
      varKey: string
      type?: string
      value?: string
      memo?: string
      folderId?: string | null
      validFrom?: string | null
      validUntil?: string | null
      fallbackValue?: string | null
      expiryBehavior?: 'stop' | 'fallback'
      /** Q: 下書きとして作るとき 'draft'。省略は使用中で公開。 */
      status?: 'draft' | 'active'
    }) =>
      fetchApi<ApiResponse<CommonVar>>('/api/common-vars', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    /** Q: 状態の切替（公開・止める・再開）。理由が必須。 */
    setStatus: (id: string, accountId: string, data: {
      to: 'active' | 'stopped'
      changeReason: string
      expectedVersion?: number
    }) =>
      fetchApi<ApiResponse<CommonVar>>(`/api/common-vars/${id}/status?accountId=${encodeURIComponent(accountId)}`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    pinBroadcast: (broadcastId: string, variableId: string, data: { accountId: string; versionId: string | null; expectedVersion: number }) =>
      fetchApi<ApiResponse<{ versionId: string | null; version: number }>>(`/api/broadcasts/${encodeURIComponent(broadcastId)}/common-var-pins/${encodeURIComponent(variableId)}`, {
        method: 'PUT', body: JSON.stringify(data),
      }),
    /** varKey は変えられない（テンプレートの差し込みが空になるため）。保存には影響確認の確認値が要る。 */
    update: (id: string, accountId: string, data: {
      name?: string
      value?: string
      memo?: string
      folderId?: string | null
      expectedVersion?: number
      changeReason?: string
      impactProof?: string
      validFrom?: string | null
      validUntil?: string | null
      fallbackValue?: string | null
      expiryBehavior?: 'stop' | 'fallback'
    }) =>
      fetchApi<ApiResponse<CommonVar>>(`/api/common-vars/${id}?accountId=${encodeURIComponent(accountId)}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    /*
      変える前に、どこがどう変わるかを見る（設計 `uNBlA` 14-1-B）。

      **`nextValue` を渡して問い合わせるだけで、値は保存されない。**
      口が `POST` なのは長い本文を投げるためで、書き換えではない。
    */
    impactPreview: (id: string, accountId: string, nextValue: string, expectedVersion?: number) =>
      fetchApi<ApiResponse<CommonVarChangeImpactDetail>>(`/api/common-vars/${id}/impact-preview`, {
        method: 'POST',
        body: JSON.stringify({ accountId, nextValue, expectedVersion }),
      }),
    deleteImpact: (id: string, accountId: string) =>
      fetchApi<ApiResponse<CommonVarDeleteImpact>>(`/api/common-vars/${id}/delete-impact?accountId=${encodeURIComponent(accountId)}`),
    // Q: 消す理由が必須。版履歴に残る。
    delete: (id: string, accountId: string, reason: string) =>
      fetchApi<ApiResponse<null>>(
        `/api/common-vars/${id}?accountId=${encodeURIComponent(accountId)}&reason=${encodeURIComponent(reason)}`,
        { method: 'DELETE' },
      ),
    replacementCandidates: (id: string, accountId: string) =>
      fetchApi<ApiResponse<CommonVarReplacementCandidates>>(`/api/common-vars/${id}/replace`, {
        method: 'POST',
        body: JSON.stringify({ accountId }),
      }),
    replacementImpact: (id: string, accountId: string, replacementId: string) =>
      fetchApi<ApiResponse<CommonVarReplacementImpact>>(`/api/common-vars/${id}/replace`, {
        method: 'POST',
        body: JSON.stringify({ accountId, replacementId }),
      }),
    replace: (
      id: string,
      accountId: string,
      input: { replacementId: string; expectedVersion: number; expectedRevision: string; changeReason: string },
    ) => fetchApi<ApiResponse<CommonVarReplacementResult>>(`/api/common-vars/${id}/replace`, {
      method: 'POST',
      body: JSON.stringify({ accountId, ...input, apply: true }),
    }),
    schedules: (id: string, accountId: string) =>
      fetchApi<ApiResponse<CommonVarSchedule[]>>(`/api/common-vars/${id}/schedules?accountId=${encodeURIComponent(accountId)}`),
    addSchedule: (id: string, accountId: string, data: { effectiveFrom: string; value: string }) =>
      fetchApi<ApiResponse<CommonVarSchedule>>(`/api/common-vars/${id}/schedules?accountId=${encodeURIComponent(accountId)}`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    deleteSchedule: (id: string, scheduleId: string, accountId: string) =>
      fetchApi<ApiResponse<null>>(`/api/common-vars/${id}/schedules/${scheduleId}?accountId=${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
      }),
    /*
      監査付きCSV出力（N-192）。作成は非同期で、detail をポーリングして
      完了・失敗・期限切れを追う。downloadUrl は api host 直結の
      content-disposition 付きURL。
    */
    listExports: (accountId: string) =>
      fetchApi<ApiResponse<CommonVarExportJob[]>>(
        `/api/common-vars/exports?accountId=${encodeURIComponent(accountId)}`,
      ),
    createExport: (input: { accountId: string; folderId?: string | null; ungrouped?: boolean }, stepUpToken?: string) =>
      fetchApi<ApiResponse<CommonVarExportJob>>('/api/common-vars/exports', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
      }),
    exportDetail: (id: string) =>
      fetchApi<ApiResponse<CommonVarExportJob>>(`/api/common-vars/exports/${encodeURIComponent(id)}`),
    regenerateExport: (id: string, stepUpToken?: string) =>
      fetchApi<ApiResponse<CommonVarExportJob>>(`/api/common-vars/exports/${encodeURIComponent(id)}/regenerate`, {
        method: 'POST',
        headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
      }),
  },
}
