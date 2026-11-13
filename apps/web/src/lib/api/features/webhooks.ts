import type {
  IncomingWebhookDetail,
  IncomingWebhookUnmatchedItem,
  IncomingWebhookTestResult,
  OutgoingWebhookOverview,
  IntegrationApiTokenInfo,
  IssuedIntegrationApiToken,
} from '../types/webhooks'
import { fetchApi } from '../transport/request'
import type {
  ApiResponse,
  IncomingWebhook,
  WebhookCreateState,
  IncomingWebhookCreated,
  OutgoingWebhook,
  OutgoingWebhookCreated,
  WebhookInteractionDirection,
  WebhookInteractionList,
  WebhookInteraction,
  GoogleSheetsConnection,
  GoogleSheetsSyncRun,
} from '@line-crm/shared'

export const webhooksMethods = {
  webhooks: {
    incoming: {
      saveConfig: (id: string, lineAccountId: string, data: {
        expectedVersion: number;
        identityMatching: IncomingWebhookDetail['identityMatching'];
        actions: Array<Pick<IncomingWebhookDetail['actions'][number], 'refKind' | 'refId' | 'refVersionId'>>;
      }) => fetchApi<ApiResponse<{ id: string; version: number }>>(
        `/api/webhooks/incoming/${encodeURIComponent(id)}/config?lineAccountId=${encodeURIComponent(lineAccountId)}`,
        { method: 'PATCH', body: JSON.stringify(data) },
      ),
      list: (lineAccountId: string) =>
        fetchApi<ApiResponse<IncomingWebhook[]>>(
          `/api/webhooks/incoming?lineAccountId=${encodeURIComponent(lineAccountId)}`,
        ),
      detail: (id: string, lineAccountId: string) =>
        fetchApi<ApiResponse<IncomingWebhookDetail>>(
          `/api/webhooks/incoming/${encodeURIComponent(id)}?lineAccountId=${encodeURIComponent(lineAccountId)}`,
        ),
      create: (data: { lineAccountId: string; folderId?: string | null; name: string; sourceType?: string; secret?: string } & WebhookCreateState, stepUpToken?: string) =>
        fetchApi<ApiResponse<IncomingWebhookCreated>>('/api/webhooks/incoming', {
          method: 'POST',
          headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
          body: JSON.stringify(data),
        }),
      update: (id: string, lineAccountId: string, data: Partial<Pick<IncomingWebhook, 'name' | 'sourceType' | 'isActive'>> & { secret?: string; folderId?: string | null; expectedConfirmationRevision?: number }, stepUpToken?: string) =>
        fetchApi<ApiResponse<IncomingWebhook & { secret?: string }>>(`/api/webhooks/incoming/${id}?lineAccountId=${encodeURIComponent(lineAccountId)}`, {
          method: 'PUT',
          headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
          body: JSON.stringify(data),
        }),
      delete: (id: string, lineAccountId: string, expectedConfirmationRevision?: number) =>
        fetchApi<ApiResponse<null>>(
          `/api/webhooks/incoming/${id}?lineAccountId=${encodeURIComponent(lineAccountId)}${expectedConfirmationRevision === undefined ? '' : `&expectedConfirmationRevision=${expectedConfirmationRevision}`}`,
          { method: 'DELETE' },
        ),
      /*
       * B 元に戻す: 削除の取り消し。戻した直後は停止のまま。
       * 画面の Toast から呼ぶ想定（各機能の担当が配線する）。
       */
      restore: (id: string, lineAccountId: string) =>
        fetchApi<ApiResponse<IncomingWebhookDetail>>(
          `/api/webhooks/incoming/${id}/restore?lineAccountId=${encodeURIComponent(lineAccountId)}`,
          { method: 'POST' },
        ),
      /* 人が見つからなかった届物の箱(#939 N-367)。R401: 50件超えは limit/offset で辿る。 */
      unmatched: (
        id: string,
        lineAccountId: string,
        status?: 'pending' | 'resolved' | 'dismissed',
        paging?: { limit?: number; offset?: number },
      ) =>
        fetchApi<ApiResponse<IncomingWebhookUnmatchedItem[]> & { total?: number }>(
          `/api/webhooks/incoming/${encodeURIComponent(id)}/unmatched?lineAccountId=${encodeURIComponent(lineAccountId)}${status ? `&status=${status}` : ''}${paging?.limit ? `&limit=${paging.limit}` : ''}${paging?.offset ? `&offset=${paging.offset}` : ''}`,
        ),
      resolveUnmatched: (id: string, lineAccountId: string, data: { action: 'dismiss' } | { action: 'link'; friendId: string }) =>
        fetchApi<ApiResponse<{ id: string; status: string }>>(
          `/api/webhooks/unmatched/${encodeURIComponent(id)}/resolve?lineAccountId=${encodeURIComponent(lineAccountId)}`,
          { method: 'POST', body: JSON.stringify(data) },
        ),
      /* S (#939 機能26): 見本JSONで照合と行動の組み立てを試す口。実行はしない。 */
      test: (id: string, lineAccountId: string, payload: unknown) =>
        fetchApi<ApiResponse<IncomingWebhookTestResult>>(
          `/api/webhooks/incoming/${encodeURIComponent(id)}/test?lineAccountId=${encodeURIComponent(lineAccountId)}`,
          { method: 'POST', body: JSON.stringify({ payload }) },
        ),
    },
    outgoing: {
      list: (lineAccountId: string) =>
        fetchApi<ApiResponse<OutgoingWebhookOverview[]>>(
          `/api/webhooks/outgoing?lineAccountId=${encodeURIComponent(lineAccountId)}`,
        ),
      /* N-363 (#939): 編集画面が現在値を読む詳細口。secret は返らない。 */
      detail: (id: string, lineAccountId: string) =>
        fetchApi<ApiResponse<OutgoingWebhook>>(
          `/api/webhooks/outgoing/${encodeURIComponent(id)}?lineAccountId=${encodeURIComponent(lineAccountId)}`,
        ),
      create: (data: { lineAccountId: string; folderId?: string | null; name: string; url: string; eventTypes: string[]; secret?: string; maxRetries?: number } & WebhookCreateState, stepUpToken?: string) =>
        fetchApi<ApiResponse<OutgoingWebhookCreated>>('/api/webhooks/outgoing', {
          method: 'POST',
          headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
          body: JSON.stringify(data),
        }),
      update: (
        id: string,
        lineAccountId: string,
        data: Partial<Pick<OutgoingWebhook, 'name' | 'url' | 'eventTypes' | 'isActive' | 'maxRetries'>> & { secret?: string; expectedVersion?: number; expectedConfirmationRevision?: number; folderId?: string | null },
        stepUpToken?: string,
      ) =>
        fetchApi<ApiResponse<OutgoingWebhook & { secret?: string }>>(`/api/webhooks/outgoing/${id}?lineAccountId=${encodeURIComponent(lineAccountId)}`, {
          method: 'PUT',
          headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
          body: JSON.stringify(data),
        }),
      delete: (id: string, lineAccountId: string, expectedConfirmationRevision?: number) =>
        fetchApi<ApiResponse<null>>(
          `/api/webhooks/outgoing/${id}?lineAccountId=${encodeURIComponent(lineAccountId)}${expectedConfirmationRevision === undefined ? '' : `&expectedConfirmationRevision=${expectedConfirmationRevision}`}`,
          { method: 'DELETE' },
        ),
      /*
       * B 元に戻す: 削除の取り消し。戻した直後は停止のまま。
       * 画面の Toast から呼ぶ想定（各機能の担当が配線する）。
       */
      restore: (id: string, lineAccountId: string) =>
        fetchApi<ApiResponse<OutgoingWebhook>>(
          `/api/webhooks/outgoing/${id}/restore?lineAccountId=${encodeURIComponent(lineAccountId)}`,
          { method: 'POST' },
        ),
      test: (id: string, lineAccountId: string, expectedVersion?: number, expectedConfirmationRevision?: number) =>
        fetchApi<ApiResponse<{ delivered: boolean; responseStatus: number | null }>>(
          `/api/webhooks/outgoing/${encodeURIComponent(id)}/test?lineAccountId=${encodeURIComponent(lineAccountId)}`,
          { method: 'POST', ...(expectedVersion === undefined && expectedConfirmationRevision === undefined ? {} : { body: JSON.stringify({ expectedVersion, expectedConfirmationRevision }) }) },
        ),
    },
    interactions: {
      list: (lineAccountId: string, params?: {
        periodDays?: number
        direction?: WebhookInteractionDirection
        status?: 'succeeded' | 'failed'
        search?: string
        page?: number
        limit?: number
      }) => {
        const query = new URLSearchParams({ lineAccountId })
        if (params?.periodDays) query.set('periodDays', String(params.periodDays))
        if (params?.direction) query.set('direction', params.direction)
        if (params?.status) query.set('status', params.status)
        if (params?.search) query.set('search', params.search)
        if (params?.page) query.set('page', String(params.page))
        if (params?.limit) query.set('limit', String(params.limit))
        return fetchApi<ApiResponse<WebhookInteractionList>>(`/api/webhooks/interactions?${query}`)
      },
      retry: (id: string, lineAccountId: string, options?: { confirmed?: boolean; interactionRevision?: number; webhookRevision?: number }) =>
        // IDEA-26: 「届いたか分からない」失敗は、相手先で確かめた旨
        // (confirmed)を添えないと口側が409で止める。無条件の再送を防ぐ。
        fetchApi<ApiResponse<WebhookInteraction>>(
          `/api/webhooks/interactions/${id}/retry?lineAccountId=${encodeURIComponent(lineAccountId)}`,
          { method: 'POST', body: JSON.stringify({ confirmed: options?.confirmed === true, interactionRevision: options?.interactionRevision, webhookRevision: options?.webhookRevision }) },
        ),
      payload: (id: string, lineAccountId: string) =>
        // F-18: 伏せた本文。available が false のとき body は null。
        fetchApi<ApiResponse<{ id: string; body: unknown; available: boolean }>>(
          `/api/webhooks/interactions/${id}/payload?lineAccountId=${encodeURIComponent(lineAccountId)}`,
        ),
      retryFailed: (lineAccountId: string) =>
        // remaining: 1回の外部通信上限で今回やり直せず残った失敗の件数(N-387)。
        // needsReview: 届いたか分からず、相手先で確かめてから1件ずつ
        // やり直す必要がある件数。まとめて再送には乗らない(IDEA-26)。
        fetchApi<ApiResponse<{ requested: number; succeeded: number; failed: number; skipped: number; remaining: number; needsReview: number; excluded: number }>>(
          `/api/webhooks/interactions/retry-failed?lineAccountId=${encodeURIComponent(lineAccountId)}`,
          { method: 'POST', body: '{}' },
        ),
    },
    /* 外部システムが公開APIを呼ぶための鍵(#939 N-380)。 */
    apiTokens: {
      list: (lineAccountId: string, includeRevoked = false) =>
        fetchApi<ApiResponse<IntegrationApiTokenInfo[]>>(
          `/api/webhooks/api-tokens?lineAccountId=${encodeURIComponent(lineAccountId)}${includeRevoked ? '&includeRevoked=1' : ''}`,
        ),
      create: (lineAccountId: string, data: { name: string; scopes: string[] }, stepUpToken?: string) =>
        fetchApi<ApiResponse<IssuedIntegrationApiToken>>('/api/webhooks/api-tokens', {
          method: 'POST',
          headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
          body: JSON.stringify({ ...data, lineAccountId }),
        }),
      revoke: (id: string, lineAccountId: string, stepUpToken?: string) =>
        fetchApi<ApiResponse<{ id: string }>>(
          `/api/webhooks/api-tokens/${encodeURIComponent(id)}/revoke?lineAccountId=${encodeURIComponent(lineAccountId)}`,
          { method: 'POST', headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined, body: '{}' },
        ),
      rotate: (id: string, lineAccountId: string, stepUpToken?: string) =>
        fetchApi<ApiResponse<IssuedIntegrationApiToken>>(
          `/api/webhooks/api-tokens/${encodeURIComponent(id)}/rotate?lineAccountId=${encodeURIComponent(lineAccountId)}`,
          { method: 'POST', headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined, body: '{}' },
        ),
      reactivate: (id: string, lineAccountId: string, stepUpToken?: string) =>
        fetchApi<ApiResponse<IntegrationApiTokenInfo>>(
          `/api/webhooks/api-tokens/${encodeURIComponent(id)}/reactivate?lineAccountId=${encodeURIComponent(lineAccountId)}`,
          { method: 'POST', headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined, body: '{}' },
        ),
    },
    /* #838 第2段: Google Sheets への直接書き出し。接続はOAuthの別画面へ飛ばす。 */
    googleSheets: {
      connection: (lineAccountId: string, request?: { signal?: AbortSignal }) =>
        fetchApi<ApiResponse<{
          connection: GoogleSheetsConnection
          oauthConfigured: boolean
          syncRunning: boolean
          canManage: boolean
        }>>(
          `/api/integrations/google-sheets/connection?account_id=${encodeURIComponent(lineAccountId)}`,
          request,
        ),
      runs: (lineAccountId: string, request?: { signal?: AbortSignal }) =>
        fetchApi<ApiResponse<{ runs: GoogleSheetsSyncRun[] }>>(
          `/api/integrations/google-sheets/runs?account_id=${encodeURIComponent(lineAccountId)}`,
          request,
        ),
      connectStart: (lineAccountId: string) =>
        fetchApi<ApiResponse<{ authorizeUrl: string; mode: 'connect' | 'reconnect' }>>(
          '/api/integrations/google-sheets/connect/start',
          { method: 'POST', body: JSON.stringify({ accountId: lineAccountId }) },
        ),
      disconnect: (lineAccountId: string) =>
        fetchApi<ApiResponse<{ revoked: boolean }>>(
          '/api/integrations/google-sheets/disconnect',
          { method: 'POST', body: JSON.stringify({ accountId: lineAccountId, confirmed: true }) },
        ),
      setTarget: (lineAccountId: string, spreadsheet: string) =>
        fetchApi<ApiResponse<{ connection: GoogleSheetsConnection }>>(
          '/api/integrations/google-sheets/target',
          { method: 'PUT', body: JSON.stringify({ accountId: lineAccountId, spreadsheet }) },
        ),
      sync: (lineAccountId: string) =>
        fetchApi<ApiResponse<{
          status: 'ok' | 'partial' | 'already_running' | 'error'
          results: Array<{ dataType: string; status: string; rowsWritten: number; error?: string | null }>
        }>>(
          '/api/integrations/google-sheets/sync',
          { method: 'POST', body: JSON.stringify({ accountId: lineAccountId }) },
        ),
    },
  },
}
