import { fetchApi } from '../transport/request'
import type {
  ApiResponse,
  MediaTabCounts,
  MediaItem,
  MediaDeleteImpact,
  MediaReplacementImpact,
  MediaReplacementResult,
} from '@line-crm/shared'
import type {
  MediaQuota,
  MediaUploadSession,
  MediaUploadCompletion,
  MediaVersionPreview,
  MediaVersionResult,
  FileScanItem,
  FileScanConfig,
} from '../types/media'
import { fetchApiBlob } from '../transport/download'
import { API_URL } from '../transport/session'

export const mediaMethods = {
/** メディアライブラリ。1か所に置いて使い回す。 */
  media: {
    counts: (accountId: string) => fetchApi<ApiResponse<MediaTabCounts>>(
      `/api/media/counts?accountId=${encodeURIComponent(accountId)}`),
    detail: (id: string, accountId: string) =>
      fetchApi<ApiResponse<{ item: MediaItem; folderName: string | null }>>(
        `/api/media/${encodeURIComponent(id)}?accountId=${encodeURIComponent(accountId)}`,
      ),
    list: (accountId: string, params?: {
      kind?: string
      folderId?: string
      excludeId?: string
      query?: string
      unusedOnly?: boolean
      nearLimitOnly?: boolean
      /** 'only' でアーカイブ済みだけ、'all' で全部。既定は非アーカイブ。 */
      archived?: 'only' | 'all'
      sort?: 'newest' | 'oldest' | 'name' | 'size' | 'usage'
      limit?: number
      offset?: number
    }) => {
      const q = new URLSearchParams()
      q.set('accountId', accountId)
      if (params?.kind) q.set('kind', params.kind)
      if (params?.folderId) q.set('folderId', params.folderId)
      if (params?.excludeId) q.set('excludeId', params.excludeId)
      if (params?.query) q.set('query', params.query)
      if (params?.unusedOnly) q.set('unusedOnly', '1')
      if (params?.nearLimitOnly) q.set('nearLimitOnly', '1')
      if (params?.archived) q.set('archived', params.archived)
      if (params?.sort) q.set('sort', params.sort)
      if (params?.limit) q.set('limit', String(params.limit))
      if (params?.offset) q.set('offset', String(params.offset))
      const query = q.toString()
      return fetchApi<ApiResponse<{ items: MediaItem[]; total: number; limit: number; offset: number }>>(
        `/api/media${query ? `?${query}` : ''}`,
      )
    },
    quota: (accountId: string) =>
      fetchApi<ApiResponse<MediaQuota>>(
        `/api/media/quota?accountId=${encodeURIComponent(accountId)}`,
      ),
    prepareUploads: (data: {
      accountId: string
      files: Array<{
        filename: string
        mimeType: string
        sizeBytes: number
        folderId?: string | null
        targetMediaId?: string | null
        metadata?: {
          width?: number
          height?: number
          durationMs?: number
          pageCount?: number
          codec?: string
        } | null
      }>
    }) => fetchApi<ApiResponse<{ sessions: MediaUploadSession[] }>>('/api/media/upload-sessions', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    completeUpload: (sessionId: string, data: { accountId: string; etag: string }) =>
      fetchApi<ApiResponse<MediaUploadCompletion>>(
        `/api/media/upload-sessions/${encodeURIComponent(sessionId)}/complete`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
    previewVersion: (
      id: string,
      data: { accountId: string; uploadSessionId: string },
    ) => fetchApi<ApiResponse<MediaVersionPreview>>(
      `/api/media/${encodeURIComponent(id)}/replacement-preview`,
      { method: 'POST', body: JSON.stringify(data) },
    ),
    createVersion: (
      id: string,
      data: { accountId: string; uploadSessionId: string; previewToken: string; changeReason: string },
    ) => fetchApi<ApiResponse<MediaVersionResult>>(
      `/api/media/${encodeURIComponent(id)}/versions`,
      { method: 'POST', body: JSON.stringify(data) },
    ),
    update: (id: string, accountId: string, data: {
      expectedRevision?: number
      filename?: string
      folderId?: string | null
      /** 既知の利用期限（YYYY-MM-DD）。null で記録を消して「不明」へ戻す。 */
      usageExpiresAt?: string | null
      /** 同意・権利の確認記録（500文字まで）。null/空で消す。 */
      usageConsentNote?: string | null
    }) =>
      fetchApi<ApiResponse<MediaItem>>(`/api/media/${id}?accountId=${encodeURIComponent(accountId)}`, {
        method: 'PATCH',
        headers: data.expectedRevision === undefined ? undefined : { 'If-Match': String(data.expectedRevision) },
        body: JSON.stringify(data),
      }),
    /** 削除確認を開くたびに、現在の使用先と削除可否を読み直す。 */
    deleteImpact: (id: string, accountId: string) =>
      fetchApi<ApiResponse<MediaDeleteImpact>>(
        `/api/media/${id}/delete-impact?accountId=${encodeURIComponent(accountId)}`,
      ),
    /** 差し替え前に、共有・参照不明を含む現在の使用先を読み直す。 */
    replacementImpact: (id: string, replacementId: string, accountId: string) =>
      fetchApi<ApiResponse<MediaReplacementImpact>>(
        `/api/media/${id}/replacement-impact?accountId=${encodeURIComponent(accountId)}&replacementId=${encodeURIComponent(replacementId)}`,
      ),
    /**
     * 使用先の差し替え。scope 'all' は全使用先（置換不可が1件でもあれば409）、
     * 'replaceable' は影響確認で置換可能と判定された使用先だけの部分実行。
     */
    replaceUsages: (
      id: string,
      accountId: string,
      input: { replacementMediaId: string; expectedRevision: string; scope?: 'all' | 'replaceable' },
    ) => fetchApi<ApiResponse<MediaReplacementResult>>(
      `/api/media/${id}/replace-usages?accountId=${encodeURIComponent(accountId)}`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
    /** 使用中は 409 で止まり、使用先から外すまで消せない。 */
    delete: (id: string, accountId: string) =>
      fetchApi<ApiResponse<null>>(`/api/media/${id}?accountId=${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
      }),
    /**
     * 一覧・新規選択からの退避。使用中でも止めない（消去ではなく、本文や
     * 過去配信からの参照は残る）。理由は必須。既に退避済みなら 409。
     */
    archive: (id: string, accountId: string, reason: string) =>
      fetchApi<ApiResponse<MediaItem>>(
        `/api/media/${encodeURIComponent(id)}/archive`,
        { method: 'POST', body: JSON.stringify({ accountId, reason }) },
      ),
    /** 退避したメディアを一覧へ戻す。理由は必須。 */
    restore: (id: string, accountId: string, reason: string) =>
      fetchApi<ApiResponse<MediaItem>>(
        `/api/media/${encodeURIComponent(id)}/restore`,
        { method: 'POST', body: JSON.stringify({ accountId, reason }) },
      ),
    /** 保存URLへ直接行かず、権限確認と監査を通る口から受け取る。 */
    download: (id: string, accountId: string) =>
      fetchApiBlob(`/api/media/${encodeURIComponent(id)}/download?accountId=${encodeURIComponent(accountId)}`),
    /** 投稿前の切り取り用。保存用ダウンロードではなく、縮小表示と同じ閲覧権限で原画像を読む。 */
    readContent: (id: string, accountId: string) =>
      fetchApiBlob(`/api/media/${encodeURIComponent(id)}/content?accountId=${encodeURIComponent(accountId)}`),
    /**
     * 指定した版のダウンロード（IDEA-15）。第1版は登録時の元ファイルで、
     * 差し替え後もここから取り戻せる。権限確認と監査は download と同じ。
     */
    downloadVersion: (id: string, versionNo: number, accountId: string) =>
      fetchApiBlob(`/api/media/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionNo)}/download?accountId=${encodeURIComponent(accountId)}`),
    /**
     * 縮小表示・試し見・ファイル開きの参照先。Cookieで認証されるため
     * img・video・audio の src や別タブ開きにそのまま使える。
     * 保存URL（配信用の公開URL）は管理画面の表示に使わない。
     */
    contentUrl: (id: string, accountId: string) =>
      `${API_URL}/api/media/${encodeURIComponent(id)}/content?accountId=${encodeURIComponent(accountId)}`,
  },
/** 危険なファイルの検査。確かめ終わるまで中身は出さない。 */
  fileScan: {
    list: (accountId: string, params?: { status?: string; q?: string; limit?: number; offset?: number }) => {
      const q = new URLSearchParams()
      q.set('accountId', accountId)
      if (params?.status) q.set('status', params.status)
      if (params?.q) q.set('q', params.q)
      if (params?.limit) q.set('limit', String(params.limit))
      if (params?.offset) q.set('offset', String(params.offset))
      return fetchApi<ApiResponse<{ items: FileScanItem[]; total: number; limit: number; offset: number }>>(
        `/api/file-scans?${q.toString()}`,
      )
    },
    bySubject: (kind: string, id: string, accountId: string) =>
      fetchApi<ApiResponse<{ scan: FileScanItem | null }>>(
        `/api/file-scans/by-subject?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}&accountId=${encodeURIComponent(accountId)}`,
      ),
    forMedia: (mediaId: string, accountId: string) =>
      fetchApi<ApiResponse<{ scan: FileScanItem | null }>>(
        `/api/file-scans/for-media?mediaId=${encodeURIComponent(mediaId)}&accountId=${encodeURIComponent(accountId)}`,
      ),
    health: (accountId: string) =>
      fetchApi<ApiResponse<{ stopped: boolean; pendingCount: number; oldestPendingAt: string | null }>>(
        `/api/file-scans/health?accountId=${encodeURIComponent(accountId)}`,
      ),
    retry: (id: string, accountId: string) =>
      fetchApi<ApiResponse<{ id: string; status: string }>>(
        `/api/file-scans/${encodeURIComponent(id)}/retry`,
        { method: 'POST', body: JSON.stringify({ accountId }) },
      ),
    release: (id: string, accountId: string, reason: string, expectedConfirmationRevision?: number) =>
      fetchApi<ApiResponse<{ id: string; status: string }>>(
        `/api/file-scans/${encodeURIComponent(id)}/release`,
        { method: 'POST', body: JSON.stringify({ accountId, reason, expectedConfirmationRevision }) },
      ),
    remove: (id: string, accountId: string, expectedConfirmationRevision?: number) =>
      fetchApi<ApiResponse<{ id: string }>>(
        `/api/file-scans/${encodeURIComponent(id)}?accountId=${encodeURIComponent(accountId)}${expectedConfirmationRevision === undefined ? '' : `&expectedConfirmationRevision=${encodeURIComponent(expectedConfirmationRevision)}`}`,
        { method: 'DELETE' },
      ),
    getConfig: (accountId: string) =>
      fetchApi<ApiResponse<{ config: FileScanConfig | null }>>(
        `/api/file-scans/config?accountId=${encodeURIComponent(accountId)}`,
      ),
    saveConfig: (accountId: string, data: {
      externalProvider?: string | null
      externalEndpointUrl?: string | null
      externalSecretRef?: string | null
      externalTimeoutMs?: number
      maxBytesOverride?: number | null
      maxPixelsOverride?: number | null
      expectedConfirmationRevision?: number
    }) =>
      fetchApi<ApiResponse<{ lineAccountId: string }>>(
        '/api/file-scans/config',
        { method: 'PUT', body: JSON.stringify({ accountId, ...data }) },
      ),
  },
  uploads: {
    /**
     * 既存 /api/images エンドポイントを叩いて画像をアップロードする。
     * 10MB 超 / image/* 以外は 400 で返る。
     */
    image: async (file: File): Promise<ApiResponse<{ id: string; key: string; url: string; mimeType: string; size: number }>> => {
      const buf = await file.arrayBuffer()
      return fetchApi<ApiResponse<{ id: string; key: string; url: string; mimeType: string; size: number }>>('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: buf,
      })
    },
  },
}
