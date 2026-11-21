import { fetchApi } from '../transport/request'
import type { ApiResponse, LineMessageType, BroadcastBubble, BroadcastMessageOptions } from '@line-crm/shared'
import type {
  ApiBroadcast,
  BroadcastApprovalCandidate,
  BroadcastApprovalState,
  BroadcastInsight,
  BroadcastLedger,
  BroadcastRecipientRow,
  BroadcastRecipientsSummary,
  BroadcastActivityEntry,
  BroadcastSavedView,
  BroadcastAssetKind,
  BroadcastMessageAsset,
  BroadcastAssetFolder,
} from '../types/broadcasts'
import type { BroadcastListKpis } from '../types/statistics'
import type { SegmentCondition } from '../../segment-condition'
import type { BroadcastPreflight } from '../types/broadcast-preflight-types'
import { IRREVERSIBLE_BROADCAST_HEADERS } from '../transport/confirmation'

export const broadcastsMethods = {
  broadcasts: {
    notificationSettings: (lineAccountId: string) =>
      fetchApi<ApiResponse<{ version: number; started: boolean; completed: boolean; failed: boolean; displayText: string }>>(
        `/api/broadcasts/notification-settings?lineAccountId=${encodeURIComponent(lineAccountId)}`,
      ),
    saveNotificationSettings: (lineAccountId: string, data: {
      expectedVersion: number; started: boolean; completed: boolean; failed: boolean
    }) => fetchApi<ApiResponse<{ version: number; started: boolean; completed: boolean; failed: boolean; displayText: string }>>(
      `/api/broadcasts/notification-settings?lineAccountId=${encodeURIComponent(lineAccountId)}`,
      { method: 'PUT', body: JSON.stringify(data) },
    ),
    /** 予約中の配信だけを、内容を残した下書きへ安全に戻す。 */
    cancelReservation: (id: string, expectedVersion?: number) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}/cancel`, {
        method: 'POST',
        ...(expectedVersion === undefined ? {} : { body: JSON.stringify({ expectedVersion }) }),
      }),
    list: (params?: {
      accountId?: string
      from?: string
      to?: string
      limit?: number
      cursor?: string | number
      status?: string
      /**
       * ★V8: 絞り込みの札は10の状態（displayStatus）で絞る。
       * カンマ区切りで複数受ける（例 'failed,partial_failed' = エラー）。
       */
      displayStatus?: string
      folderId?: string
      /** 'newest' (既定) または 'oldest'。一覧の並び順選択と連動する。 */
      sort?: 'newest' | 'oldest'
    }) => {
      const query = new URLSearchParams()
      if (params?.from) query.set('from', params.from)
      if (params?.to) query.set('to', params.to)
      if (params?.accountId) query.set('lineAccountId', params.accountId)
      if (params?.limit !== undefined) query.set('limit', String(params.limit))
      if (params?.cursor !== undefined && params.cursor !== '') query.set('cursor', String(params.cursor))
      if (params?.status) query.set('status', params.status)
      if (params?.displayStatus) query.set('displayStatus', params.displayStatus)
      if (params?.folderId) query.set('folderId', params.folderId)
      if (params?.sort && params.sort !== 'newest') query.set('sort', params.sort)
      const qs = query.toString()
      return fetchApi<ApiResponse<ApiBroadcast[]> & {
        kpis?: BroadcastListKpis
        /** ★V8: 札ごとの件数（フォルダは効く、状態の札は効かせない集団）。 */
        statusCounts?: Record<string, number>
        pagination?: { total: number; limit: number; cursor: number; nextCursor: string | null }
      }>(`/api/broadcasts${qs ? `?${qs}` : ''}`)
    },
    createCorrection: (id: string, idempotencyKey: string) =>
      fetchApi<ApiResponse<{ id: string; status?: 'draft' | 'scheduled' | 'sending' | 'sent' }>>(`/api/broadcasts/${encodeURIComponent(id)}/correction`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } }),
    get: (id: string) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}`),
    create: (data: import('@line-crm/shared').BroadcastDefinitionInput, options?: { idempotencyKey?: string }) =>
      fetchApi<ApiResponse<ApiBroadcast>>('/api/broadcasts', {
        method: 'POST',
        headers: options?.idempotencyKey
          ? { 'Idempotency-Key': options.idempotencyKey }
          : undefined,
        body: JSON.stringify(data),
      }),
    /**
     * 送る前の確認。何人に届くかと、気をつけることを返す。
     * 送信は何もしない。
     */
    preflight: (data: {
      targetType: string
      correctionDraftId?: string
      targetTagId?: string | null
      lineAccountId?: string | null
      accountIds?: string[]
      messageContent?: string
      /** 詳細条件。渡さないと条件を無視した人数（＝全員）が返る。 */
      segmentConditions?: SegmentCondition | null
      scheduledAt?: string | null
      deliveryLimit?: import('@line-crm/shared').BroadcastDeliveryLimit
      messageCount?: number
    }) =>
      fetchApi<ApiResponse<BroadcastPreflight>>('/api/broadcasts/preflight', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (
      id: string,
      data: {
        title?: string
        messageType?: LineMessageType
        messageContent?: string
        messageBubbles?: BroadcastBubble[]
        targetType?: ApiBroadcast['targetType']
        targetTagId?: string | null
        segmentConditions?: SegmentCondition | null
        scheduledAt?: string | null
        trackLinks?: boolean
        folderId?: string | null
        measureOpens?: boolean
        stealthSpreadMinutes?: number
        lineAccountId?: string | null
        saveAsDraft?: boolean
        draftStep?: ApiBroadcast['draftStep']
        internalMemo?: string | null
        messageOptions?: BroadcastMessageOptions | null
        afterActionVersionId?: string | null
        /** 1人運用のとき、送る人が確認で入れた人数 */
        confirmedRecipientCount?: number
        // #772: 版なしの更新は 400 で拒否される。
        expectedVersion: number
      },
      confirmedSend = false,
    ) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}`, {
        method: 'PUT',
        ...(confirmedSend ? { headers: IRREVERSIBLE_BROADCAST_HEADERS } : {}),
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/broadcasts/${id}`, { method: 'DELETE' }),
    // 本送信は取り消せないため、サーバー側が確認ヘッダを要求する。
    // 画面の確認ダイアログを経たことをここで示す。
    // 1人運用のときは確認で入れた人数も送る（合わなければ409）。
    send: (id: string, options?: { confirmedRecipientCount?: number; expectedVersion?: number }) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}/send`, {
        method: 'POST',
        headers: IRREVERSIBLE_BROADCAST_HEADERS,
        body: options?.confirmedRecipientCount !== undefined
          ? JSON.stringify(options)
          : undefined,
      }),
    /**
     * 二者承認（m12a）。承認の依頼・承認・差し戻し・取り消し・もう一度知らせる。
     * 承認する人・頼んだ人の出し分けに使う今の状態と判定もここから取る。
     */
    approval: {
      config: (lineAccountId: string) =>
        fetchApi<ApiResponse<{ lineAccountId: string; threshold: number; operatorCount: number; singleOperator: boolean }>>(
          `/api/broadcasts/approval-config?lineAccountId=${encodeURIComponent(lineAccountId)}`,
        ),
      candidates: (lineAccountId: string) =>
        fetchApi<ApiResponse<BroadcastApprovalCandidate[]>>(
          `/api/broadcasts/approvals/candidates?lineAccountId=${encodeURIComponent(lineAccountId)}`,
        ),
      get: (id: string) =>
        fetchApi<ApiResponse<BroadcastApprovalState>>(`/api/broadcasts/${id}/approval`),
      request: (id: string, data: { approverStaffId: string; note?: string; expectedVersion?: number; confirmedRecipientCount?: number }) =>
        fetchApi<ApiResponse<{ approval: BroadcastApprovalState['approval'] }>>(
          `/api/broadcasts/${id}/approval-request`, { method: 'POST', body: JSON.stringify(data) },
        ),
      approve: (id: string, expectedVersion: number, stepUpToken?: string) =>
        fetchApi<ApiResponse<{ approval: BroadcastApprovalState['approval']; needsSend: boolean }>>(
          `/api/broadcasts/${id}/approval-approve`, {
            method: 'POST',
            body: JSON.stringify({ expectedVersion }),
            headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
          },
        ),
      reject: (id: string, reason: string) =>
        fetchApi<ApiResponse<{ approval: BroadcastApprovalState['approval'] }>>(
          `/api/broadcasts/${id}/approval-reject`, { method: 'POST', body: JSON.stringify({ reason }) },
        ),
      cancel: (id: string) =>
        fetchApi<ApiResponse<{ approval: BroadcastApprovalState['approval'] }>>(
          `/api/broadcasts/${id}/approval-cancel`, { method: 'POST' },
        ),
      remind: (id: string) =>
        fetchApi<ApiResponse<{ reminded: boolean }>>(
          `/api/broadcasts/${id}/approval-remind`, { method: 'POST' },
        ),
      threshold: (lineAccountId: string) =>
        fetchApi<ApiResponse<{ lineAccountId: string; threshold: number }>>(
          `/api/broadcasts/approval-threshold?lineAccountId=${encodeURIComponent(lineAccountId)}`,
        ),
    },
    getInsight: (id: string) =>
      fetchApi<ApiResponse<BroadcastInsight | null>>(`/api/broadcasts/${id}/insight`),
    fetchInsight: (id: string) =>
      fetchApi<ApiResponse<BroadcastInsight>>(`/api/broadcasts/${id}/fetch-insight`, { method: 'POST' }),
    testSend: (id: string) =>
      fetchApi<{ success: boolean; sent?: number; failed?: number; error?: string }>(`/api/broadcasts/${id}/test-send`, { method: 'POST' }),
    /**
     * 送信中の配信を止める（#662）。
     *
     * `expectedVersion` は画面が読み込んだ版。2人が同時に押したとき、
     * 勝つのは1人だけ（負けた側は 409）。**押している間ボタンを無効にする
     * のは見た目の手当てで、本当の守りはこの版**。
     */
    stop: (id: string, expectedVersion: number) =>
      fetchApi<ApiResponse<ApiBroadcast & { ledger: BroadcastLedger }> & { alreadyStopped?: boolean; stoppedUnknownCount?: number }>(
        `/api/broadcasts/${id}/stop`,
        { method: 'POST', body: JSON.stringify({ expectedVersion }) },
      ),
    /** 止めた配信の続きを送る。送達済み・送達不明の相手は飛ばす。 */
    resume: (id: string, expectedVersion: number) =>
      fetchApi<ApiResponse<ApiBroadcast & { ledger: BroadcastLedger }>>(
        `/api/broadcasts/${id}/resume`,
        { method: 'POST', body: JSON.stringify({ expectedVersion }) },
      ),
    /**
     * 一時的な失敗の相手だけ送り直す（#816）。**送達不明と恒常的な失敗
     * （ブロックなど）は含まれない**。相手へ実際に届くので、送信と同じ
     * 確認を要求する。
     */
    retryFailed: (id: string, expectedVersion: number) =>
      fetchApi<ApiResponse<ApiBroadcast & { ledger: BroadcastLedger }> & { attemptNo?: number; retryTargets?: number }>(
        `/api/broadcasts/${id}/retry-failed`,
        {
          method: 'POST',
          headers: IRREVERSIBLE_BROADCAST_HEADERS,
          body: JSON.stringify({ expectedVersion }),
        },
      ),
    /**
     * 宛先台帳（#816）。宛先ごとに結果・時刻・LINEの要求IDを返す。
     * `result` で絞れる（all・delivered・temporary・permanent・unknown・inflight）。
     * 旧配信は集約だけ（aggregateOnly）で、行は捏造しない。
     */
    recipients: (id: string, params?: { result?: string; cursor?: string; limit?: number }) => {
      const query = new URLSearchParams()
      if (params?.result) query.set('result', params.result)
      if (params?.cursor) query.set('cursor', params.cursor)
      if (params?.limit) query.set('limit', String(params.limit))
      const qs = query.toString()
      return fetchApi<{
        success: boolean
        data?: {
          rows: BroadcastRecipientRow[]
          summary: BroadcastRecipientsSummary
          aggregateOnly: boolean
          aggregateReason: 'all' | 'legacy' | null
          legacySuccessCount: number | null
        }
        error?: string
        pagination?: { total: number; limit: number; cursor: number; nextCursor: string | null }
      }>(`/api/broadcasts/${id}/recipients${qs ? `?${qs}` : ''}`)
    },
    /**
     * 操作の記録（#816）。作成・編集・予約・送信・停止・再送と、承認の
     * 依頼・承認・差し戻しを新しい順に混ぜて返す。追記だけで消せない。
     */
    activity: (id: string, params?: { cursor?: string; limit?: number }) => {
      const query = new URLSearchParams()
      if (params?.cursor) query.set('cursor', params.cursor)
      if (params?.limit) query.set('limit', String(params.limit))
      const qs = query.toString()
      return fetchApi<{
        success: boolean
        data?: BroadcastActivityEntry[]
        error?: string
        pagination?: { limit: number; cursor: number; nextCursor: string | null }
      }>(`/api/broadcasts/${id}/activity${qs ? `?${qs}` : ''}`)
    },
    getProgress: (id: string) =>
      fetchApi<{ success: boolean; data?: {
        status: string
        stopped?: boolean
        stoppedAt?: string | null
        sendAttemptNo?: number
        ledger?: BroadcastLedger
        totalCount: number
        successCount: number
        batchOffset: number
        perAccountStats: Array<{
          accountId: string
          accountName: string
          sent: number
          uniqueImpression: number | null
          uniqueClick: number | null
        }>
      } }>(`/api/broadcasts/${id}/progress`),
    previewCount: (id: string) =>
      fetchApi<{
        success: boolean;
        data?: {
          count: number;
          perAccount?: Array<{ accountId: string; sendCount: number }>;
        };
        error?: string;
      }>(`/api/broadcasts/${id}/preview-count`),
    perAccountStats: (id: string) =>
      fetchApi<{
        success: boolean;
        data?: Array<{
          accountId: string;
          accountName: string;
          sent: number;
          uniqueImpression: number | null;
          uniqueClick: number | null;
        }>;
        error?: string;
      }>(`/api/broadcasts/${id}/per-account-stats`),
    sendSegment: (id: string, conditions: unknown) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}/send-segment`, {
        method: 'POST',
        headers: IRREVERSIBLE_BROADCAST_HEADERS,
        body: JSON.stringify({ conditions }),
      }),
    dedupPreview: (input: { accountIds: string[]; dedupPriority: string[]; targetTagId?: string | null }) =>
      fetchApi<{
        success: boolean;
        data?: {
          totalSelected: number;
          uniqueRecipients: number;
          reduction: number;
          reductionRate: number;
          perAccount: Array<{
            accountId: string;
            accountName: string;
            accountCountry: string | null;
            selectedCount: number;
            sendCount: number;
            excludedToHigherPriority: number;
          }>;
        };
        error?: string;
      }>('/api/broadcasts/dedup-preview', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    savedViews: {
      list: (lineAccountId: string) =>
        fetchApi<ApiResponse<BroadcastSavedView[]>>(
          `/api/broadcasts/saved-views?lineAccountId=${encodeURIComponent(lineAccountId)}`,
        ),
      create: (lineAccountId: string, data: {
        name: string
        filters: Record<string, unknown>
        sortKey: BroadcastSavedView['sortKey']
        pageSize: BroadcastSavedView['pageSize']
      }) => fetchApi<ApiResponse<BroadcastSavedView>>(
        `/api/broadcasts/saved-views?lineAccountId=${encodeURIComponent(lineAccountId)}`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
    },
  },
  broadcastMessageAssets: {
    folders: {
      list: (lineAccountId: string) => fetchApi<ApiResponse<BroadcastAssetFolder[]>>(
        `/api/broadcast-message-assets/folders?lineAccountId=${encodeURIComponent(lineAccountId)}`,
      ),
      create: (lineAccountId: string, name: string) => fetchApi<ApiResponse<BroadcastAssetFolder | null>>(
        '/api/broadcast-message-assets/folders',
        { method: 'POST', body: JSON.stringify({ lineAccountId, name }) },
      ),
    },
    list: (params?: { accountId?: string; kind?: BroadcastAssetKind }) => {
      const query = new URLSearchParams()
      if (params?.accountId) query.set('lineAccountId', params.accountId)
      if (params?.kind) query.set('kind', params.kind)
      const suffix = query.size ? `?${query.toString()}` : ''
      return fetchApi<ApiResponse<BroadcastMessageAsset[]>>(`/api/broadcast-message-assets${suffix}`)
    },
    /** PERF-04: 件数だけを種類ごとに返す口。初期表示の件数タブ用で、各行の payload は含まない。 */
    counts: (params?: { accountId?: string }) => {
      const query = new URLSearchParams()
      if (params?.accountId) query.set('lineAccountId', params.accountId)
      const suffix = query.size ? `?${query.toString()}` : ''
      return fetchApi<ApiResponse<Record<BroadcastAssetKind, number>>>(`/api/broadcast-message-assets/counts${suffix}`)
    },
    create: (data: { lineAccountId?: string | null; kind: BroadcastAssetKind; name: string; payload: Record<string, unknown>; folderId?: string | null }) =>
      fetchApi<ApiResponse<BroadcastMessageAsset>>('/api/broadcast-message-assets', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { name: string; payload: Record<string, unknown>; folderId?: string | null }) =>
      fetchApi<ApiResponse<BroadcastMessageAsset>>(`/api/broadcast-message-assets/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    publish: (id: string, data: { expectedVersion: number; expectedDraftRevision: number }, requestId: string) =>
      fetchApi<ApiResponse<BroadcastMessageAsset & { replayed: boolean }>>(`/api/broadcast-message-assets/${id}/publish`, {
        method: 'POST', headers: { 'Idempotency-Key': requestId }, body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/broadcast-message-assets/${id}`, { method: 'DELETE' }),
    upload: async (file: File, lineAccountId?: string | null): Promise<ApiResponse<{ key: string; url: string; mimeType: string; size: number }>> => {
      if (file.type !== 'video/mp4') return fetchApi('/api/broadcast-message-assets/upload', {
        method: 'POST', headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) }, body: file,
      })
      let accountId = lineAccountId
      if (accountId === undefined && typeof window !== 'undefined') {
        try { accountId = localStorage.getItem('lh_selected_account') } catch { accountId = null }
      }
      const prepared = await fetchApi<ApiResponse<{id:string;uploadUrl:string;requiredHeaders:Record<string,string>}>>('/api/broadcast-message-assets/upload-sessions', {
        method:'POST',body:JSON.stringify({lineAccountId:accountId??null,filename:file.name,mimeType:file.type,sizeBytes:file.size}),
      })
      if (!prepared.success) return prepared
      const response = await fetch(prepared.data.uploadUrl,{method:'PUT',headers:prepared.data.requiredHeaders,body:file,credentials:'omit'})
      if (!response.ok) throw new Error('動画をアップロードできませんでした。もう一度選んでください')
      const etag = response.headers.get('ETag')
      if (!etag) throw new Error('アップロードの確認情報が届きませんでした。もう一度選んでください')
      return fetchApi(`/api/broadcast-message-assets/upload-sessions/${encodeURIComponent(prepared.data.id)}/complete`,{method:'POST',body:JSON.stringify({etag})})
    },
  },
  segments: {
    count: (conditions: unknown, accountId?: string) =>
      fetchApi<{ success: boolean; count?: number; error?: string }>('/api/segments/count', {
        method: 'POST',
        body: JSON.stringify({ conditions, accountId }),
      }),
  },
}
