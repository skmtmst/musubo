import { fetchApi } from '../transport/request'
import type {
  ApiResponse,
  FriendAddEventRoutingStatus,
  FriendAddEventKind,
  FriendAddEventAttributionStatus,
} from '@line-crm/shared'
import type {
  FriendAddRuleKind,
  FriendAddRuleStatus,
  FriendAddRuleListData,
  FriendAddRule,
  FriendAddRuleOptions,
  FriendAddRuleConflictData,
  FriendAddRunList,
  FriendAddRunDetail,
  FriendAddRuleInput,
  FriendAddRuleAction,
} from '../types/friend-add'

/**
 * 停止の再送を同じ操作として扱うキー。
 * 同じルール・版なら同じ値、版が進んだ後の停止なら別の値になる。
 */
export function friendAddStopIdempotencyKey(ruleId: string, version: number): string {
  return `friend-add-rule-stop:${encodeURIComponent(ruleId)}:v${version}`
}

export const friendAddMethods = {
/**
   * @deprecated 旧互換の `friendAddRouting` client は #560 で削除済み。
   * 以後はこの 管理画面 rules/runs 契約だけを使う。
   */
  friendAddRules: {
    restore: (accountId: string, id: string, expectedVersion: number) => fetchApi<ApiResponse<{ id: string; status: 'draft'; version: number }>>(
      `/api/friend-add-rules/${encodeURIComponent(id)}/unarchive?account_id=${encodeURIComponent(accountId)}`,
      { method: 'POST', body: JSON.stringify({ expectedVersion }) },
    ),
    duplicate: (accountId: string, id: string, expectedVersion: number, idempotencyKey: string) => fetchApi<ApiResponse<{ id: string; status: 'draft' }>>(
      `/api/friend-add-rules/${encodeURIComponent(id)}/duplicate?account_id=${encodeURIComponent(accountId)}`,
      { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ expectedVersion }) },
    ),
    list: (accountId: string, kind: FriendAddRuleKind, params?: {
      status?: FriendAddRuleStatus
      cursor?: string
      limit?: number
      /** 設定名の部分一致。サーバ側で全ページに効かせる。 */
      q?: string
      /** フォルダ名での絞り込み。未分類は '__uncategorized'。 */
      folder?: string
      /** 複製直後の行を先頭へ。ページ送りにも同じ値を渡す。 */
      highlightId?: string
    }) => {
      const query = new URLSearchParams({ account_id: accountId, kind })
      if (params?.status) query.set('status', params.status)
      if (params?.cursor) query.set('cursor', params.cursor)
      if (params?.limit !== undefined) query.set('limit', String(params.limit))
      if (params?.q) query.set('q', params.q)
      if (params?.folder) query.set('folder', params.folder)
      if (params?.highlightId) query.set('highlight', params.highlightId)
      return fetchApi<ApiResponse<FriendAddRuleListData>>(`/api/friend-add-rules?${query}`)
    },
    get: (accountId: string, ruleId: string) =>
      fetchApi<ApiResponse<{
        rule: FriendAddRule
        options: FriendAddRuleOptions
        staffNotification: {
          status: 'connected' | 'disconnected' | 'unconfigured' | null
          reason: string | null
        }
      }>>(
        `/api/friend-add-rules/${encodeURIComponent(ruleId)}?account_id=${encodeURIComponent(accountId)}`,
      ),
    conflicts: (accountId: string, kind: FriendAddRuleKind) =>
      fetchApi<ApiResponse<FriendAddRuleConflictData>>(
        `/api/friend-add-rules/conflicts?account_id=${encodeURIComponent(accountId)}&kind=${kind}`,
      ),
    createFolder: (accountId: string, name: string, idempotencyKey: string, color?: string | null) =>
      fetchApi<ApiResponse<import('@line-crm/shared').FriendAddRuleFolder>>(
        '/api/friend-add-rules/folders',
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({ accountId, name, color }),
        },
      ),
    updateFolder: (accountId: string, id: string, input: { name?: string; color?: string | null }) =>
      fetchApi<ApiResponse<import('@line-crm/shared').FriendAddRuleFolder>>(`/api/friend-add-rules/folders/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify({ accountId, ...input }),
      }),
    deleteFolder: (accountId: string, id: string) =>
      fetchApi<ApiResponse<import('@line-crm/shared').FriendAddRuleFolderDeleteResult>>(`/api/friend-add-rules/folders/${encodeURIComponent(id)}?account_id=${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
      }),
    runs: (accountId: string, params?: {
      period?: 'all' | 'last28days' | 'today' | 'this_month' | 'last_month'
      from?: string
      to?: string
      status?: FriendAddEventRoutingStatus
      ruleId?: string
      /** 追加の種類での絞り込み。サーバ側で全ページに効かせる。 */
      kind?: FriendAddEventKind
      /** 流入経路の取得状態での絞り込み。サーバ側で全ページに効かせる。 */
      attribution?: FriendAddEventAttributionStatus
      cursor?: string
      limit?: number
    }) => {
      const query = new URLSearchParams({ account_id: accountId })
      if (params?.period) query.set('period', params.period)
      if (params?.from) query.set('from', params.from)
      if (params?.to) query.set('to', params.to)
      if (params?.status) query.set('status', params.status)
      if (params?.ruleId) query.set('rule_id', params.ruleId)
      if (params?.kind) query.set('kind', params.kind)
      if (params?.attribution) query.set('attribution', params.attribution)
      if (params?.cursor) query.set('cursor', params.cursor)
      if (params?.limit !== undefined) query.set('limit', String(params.limit))
      return fetchApi<ApiResponse<FriendAddRunList>>(`/api/friend-add-runs?${query}`)
    },
    runDetail: (accountId: string, runId: string) =>
      fetchApi<ApiResponse<FriendAddRunDetail>>(
        `/api/friend-add-runs/${encodeURIComponent(runId)}?account_id=${encodeURIComponent(accountId)}`,
      ),
    retryRun: (accountId: string, runId: string) =>
      fetchApi<ApiResponse<{ status: FriendAddEventRoutingStatus; retried: number }>>(
        `/api/friend-add-runs/${encodeURIComponent(runId)}/retry?account_id=${encodeURIComponent(accountId)}`,
        { method: 'POST' },
      ),
    createDraft: (input: FriendAddRuleInput, idempotencyKey: string) =>
      fetchApi<ApiResponse<{ id: string }>>('/api/friend-add-rules/drafts', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(input),
      }),
    saveDraft: (ruleId: string, input: FriendAddRuleInput, idempotencyKey: string) =>
      fetchApi<ApiResponse<{ id: string; versionId: string }>>(
        `/api/friend-add-rules/${encodeURIComponent(ruleId)}/draft`,
        { method: 'PUT', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(input) },
      ),
    validate: (accountId: string, ruleId: string) =>
      fetchApi<ApiResponse<{
        canPublish: boolean
        /** 鍵付きの確認。画面は鍵で突き合わせ、順番に意味を持たせない。 */
        checks: Array<{
          key: 'first_time' | 'returning' | 'actions' | 'duplicate_prevention'
          status: 'passed' | 'failed'
          label: string
          detail: string
        }>
      }>>(`/api/friend-add-rules/${encodeURIComponent(ruleId)}/validate?account_id=${encodeURIComponent(accountId)}`, {
        method: 'POST',
      }),
    /** 新しい rules 契約でテスト実行し、本番データは変更しない。 */
    test: (accountId: string, ruleId: string, input?: { routeId?: string | null; expectedAt?: string | null; friendId?: string | null }) =>
      fetchApi<ApiResponse<{
        stateChanged: false
        ruleId: string
        matched: boolean
        reasons: string[]
        scenarioId: string | null
        message: string | null
        actions: FriendAddRuleAction[]
      }> | {
        success: false
        error: string
        /** 失敗時も理由を返す (成功時と同じ器・HTTP 200)。 */
        data: {
          stateChanged: false
          ruleId: string
          matched: false
          reasons: string[]
          scenarioId: string | null
          message: string | null
          actions: FriendAddRuleAction[]
        }
      }>('/api/friend-add-rules/test', {
        method: 'POST',
        body: JSON.stringify({
          accountId,
          ruleId,
          routeId: input?.routeId ?? null,
          expectedAt: input?.expectedAt ?? null,
          friendId: input?.friendId ?? null,
        }),
      }),
    publish: (accountId: string, ruleId: string, idempotencyKey: string) =>
      fetchApi<ApiResponse<{ id: string; versionNumber: number; publishedAt: string }>>(
        `/api/friend-add-rules/${encodeURIComponent(ruleId)}/publish?account_id=${encodeURIComponent(accountId)}`,
        { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } },
      ),
    stop: (accountId: string, ruleId: string, version: number) =>
      fetchApi<{ success: boolean }>(
        `/api/friend-add-rules/${encodeURIComponent(ruleId)}/stop?account_id=${encodeURIComponent(accountId)}`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': friendAddStopIdempotencyKey(ruleId, version) },
          body: JSON.stringify({ version }),
        },
      ),
    archive: (accountId: string, ruleId: string, confirmed?: { version: number; status: 'draft' | 'published' | 'stopped' }) =>
      fetchApi<{ success: boolean }>(
        `/api/friend-add-rules/${encodeURIComponent(ruleId)}?account_id=${encodeURIComponent(accountId)}${confirmed ? `&expected_version=${encodeURIComponent(confirmed.version)}&expected_status=${encodeURIComponent(confirmed.status)}` : ''}`,
        { method: 'DELETE' },
      ),
    /**
     * 一覧のつまみで動かした順を優先順位としてまとめて書く（V8）。
     * 受け皿を除く全件を順に渡す。件数が違えば 409（読み直し）。
     */
    reorder: (accountId: string, friendKind: FriendAddRuleKind, ids: string[]) =>
      fetchApi<ApiResponse<{ updated: number }>>('/api/friend-add-rules/reorder', {
        method: 'PATCH',
        body: JSON.stringify({ accountId, friendKind, ids }),
      }),
  },
}
