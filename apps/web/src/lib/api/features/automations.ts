import { fetchApi } from '../transport/request'
import type { ApiResponse, AutomationTabCounts, Automation, AutomationLog } from '@line-crm/shared'
import type {
  AutomationListItem,
  AutomationTemplateSummary,
  AutomationDraftDetail,
  AutomationDraftAction,
  AutomationRunDetail,
  CommonActionResources,
  CommonActionSummary,
  CommonActionDetail,
  CommonActionStep,
} from '../types/automations'
import { API_URL } from '../transport/session'

export const automationsMethods = {
  automations: {
    counts: (accountId: string) => fetchApi<ApiResponse<AutomationTabCounts>>(
      `/api/automations/counts?account_id=${encodeURIComponent(accountId)}`),
    list: <IncludeArchived extends boolean = false>(params?: { accountId?: string; limit?: number; offset?: number; includeArchived?: IncludeArchived }) => {
      const query = new URLSearchParams()
      if (params?.includeArchived) query.set('includeArchived', '1')
      if (params?.accountId) query.set('lineAccountId', params.accountId)
      if (params?.limit !== undefined) query.set('limit', String(params.limit))
      if (params?.offset !== undefined) query.set('offset', String(params.offset))
      const suffix = query.size ? `?${query}` : ''
      return fetchApi<ApiResponse<Array<IncludeArchived extends true ? AutomationListItem : AutomationListItem & { status: Exclude<AutomationListItem['status'], 'archived'> }>> & {
        summary?: { active: number; stopped: number; executionCount30d: number; failureCount30d: number }
        freshness?: 'available'
        pagination?: { total: number; limit: number | null; offset: number }
      }>(`/api/automations${suffix}`)
    },
    get: (id: string) =>
      fetchApi<ApiResponse<Automation & { logs?: AutomationLog[] }>>(`/api/automations/${id}`),
    // #736: 旧 PUT は isActive boolean だけ受け付ける。ほかは 400 で拒否される。
    update: (id: string, data: { isActive: boolean }) =>
      fetchApi<ApiResponse<Automation>>(`/api/automations/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/automations/${id}`, { method: 'DELETE' }),
    logs: (id: string, limit?: number) =>
      fetchApi<ApiResponse<AutomationLog[]>>(
        `/api/automations/${id}/logs` + (limit ? `?limit=${limit}` : ''),
      ),
    audiencePreview: (id: string, accountId: string, versionId?: string) =>
      fetchApi<ApiResponse<{ automationId: string; versionId: string; matched: number; total: number; freshness: 'available'; calculatedAt: string }>>(
        `/api/automations/${encodeURIComponent(id)}/audience-preview?account_id=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: JSON.stringify({ versionId }) },
      ),
    // R484: `operationKey` は確認画面ごとの要求キー。同じ確認の再試行は
    // 同じ鍵で呼び、Worker は2件目の実行を作らず初回を返す。
    // R487: `expectedCommonActions` は確認画面で出した共通アクションの版。
    // 別担当が利用版を切り替えた直後に実行しても、Worker が409で止める。
    test: (
      id: string, accountId: string, friendId: string, versionId?: string, operationKey?: string,
      expectedCommonActions?: Array<{ stepId: string; commonActionId: string; versionId: string }>,
    ) =>
      fetchApi<ApiResponse<{ runId: string; versionId: string; status: string }>>(
        `/api/automations/${encodeURIComponent(id)}/test?account_id=${encodeURIComponent(accountId)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            versionId, friendId, operationKey,
            // 共通アクションを呼ばない下書きでは項目自体を送らない。
            expectedCommonActions: expectedCommonActions?.length ? expectedCommonActions : undefined,
          }),
        },
      ),
    templates: (accountId: string) =>
      fetchApi<ApiResponse<AutomationTemplateSummary[]>>(
        `/api/automation-templates?account_id=${encodeURIComponent(accountId)}`,
      ),
    /**
     * 見本から下書きを作る（DETAIL-13）。
     *
     * `operationKey` は「この新規作成の操作」を識別する鍵。1回の作成操作に
     * 1つだけ振り、同じ操作の再試行（ダブルクリック・通信やり直し）だけが
     * 同じ鍵を使う。別の新規作成は必ず別の鍵で呼ぶ——同じ鍵だとサーバーは
     * 同じ下書きを返し、鍵が無い呼び出しは Worker が 422 で断る。
     */
    createDraftFromTemplate: (templateKey: string, accountId: string, operationKey: string, folderId?: string | null) =>
      fetchApi<ApiResponse<{ id: string; draftVersionId: string }>>(
        `/api/automation-templates/${encodeURIComponent(templateKey)}/drafts?account_id=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: JSON.stringify({ operationKey, folderId }) },
      ),
    getDraft: (id: string, accountId: string) =>
      fetchApi<ApiResponse<AutomationDraftDetail>>(
        `/api/automation-drafts/${encodeURIComponent(id)}?account_id=${encodeURIComponent(accountId)}`,
      ),
    draftResources: (accountId: string) =>
      fetchApi<ApiResponse<{
        tags: Array<{ id: string; name: string }>
        scenarios: Array<{ id: string; name: string }>
        /** 呼び出せるのは公開済みだけ（#942 N-356）。 */
        commonActions: Array<{ id: string; name: string }>
      }>>(`/api/automation-draft-resources?account_id=${encodeURIComponent(accountId)}`),
    updateDraft: (id: string, accountId: string, data: {
      folderId?: string | null
      expectedDraftVersionId: string
      name: string
      eventType: AutomationDraftDetail['eventType']
      triggerConfig: Record<string, unknown>
      conditions?: Record<string, unknown>
      actions: AutomationDraftAction[]
    }) => fetchApi<ApiResponse<{ updated: true; draftVersionId: string }>>(
      `/api/automation-drafts/${encodeURIComponent(id)}?account_id=${encodeURIComponent(accountId)}`,
      { method: 'PUT', body: JSON.stringify(data) },
    ),
    // R483: `expectedStatus` は確認時に見た稼働状態。読み取り後の停止・再開を
    // 読んだ時点の状態で上書きしないよう、書き込み条件に入れる。
    publishDraft: (id: string, accountId: string, expectedDraftVersionId: string, activate = true, expectedStatus?: string) =>
      fetchApi<ApiResponse<{ id: string; versionId: string; versionNumber: number; status: 'active' | 'stopped' }>>(
        `/api/automation-drafts/${encodeURIComponent(id)}/publish?account_id=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: JSON.stringify({ expectedDraftVersionId, activate, expectedStatus }) },
      ),
    // #942 N-352: 一覧の「編集」。公開済みの定義に改訂用の下書きをぶら下げる。
    // すでに下書きがあればそれを返す（何度押しても1件）。
    createDraftFromAutomation: (id: string) =>
      fetchApi<ApiResponse<{ id: string; draftVersionId: string }>>(
        `/api/automations/${encodeURIComponent(id)}/draft`,
        { method: 'POST', body: '{}' },
      ),
    // #942 N-352: 一覧の「複製」。いま見えている版を写した新しい下書き。
    duplicate: (id: string) =>
      fetchApi<ApiResponse<{ id: string; draftVersionId: string }>>(
        `/api/automations/${encodeURIComponent(id)}/duplicate`,
        { method: 'POST', body: '{}' },
      ),
    restore: (id: string, accountId: string) =>
      fetchApi<ApiResponse<{ id: string; status: 'draft' | 'active' | 'stopped' }>>(`/api/automations/${encodeURIComponent(id)}/restore?lineAccountId=${encodeURIComponent(accountId)}`, { method: 'POST', body: '{}' }),
    // 稼働切替と「保管」。実行記録は残る。
    setStatus: (id: string, status: 'active' | 'stopped' | 'archived', expectedConfirmationRevision?: number) =>
      fetchApi<ApiResponse<{ id: string; status: 'active' | 'stopped' | 'archived' }>>(
        `/api/automations/${encodeURIComponent(id)}/status`,
        { method: 'POST', body: JSON.stringify({ status, expectedConfirmationRevision }) },
      ),
    // #942 N-354: 実行記録1件の詳細（版番号・テスト印・処理ごとの結果）。
    getRun: (id: string) =>
      fetchApi<ApiResponse<AutomationRunDetail>>(`/api/automation-runs/${encodeURIComponent(id)}`),
    // #942 N-353: 実行記録のCSV書き出し口。画面の絞り込みと同じ条件を渡す。
    // パスだけを返す。直リンクは Cookie が届かない経路で401になるため、
    // 呼び出し側は downloadApiFile で認証付き取得してから保存する（#1053）。
    runsCsvUrl: (params?: { accountId?: string; search?: string; status?: string; includeTest?: boolean }) => {
      const query = new URLSearchParams({ format: 'csv' })
      if (params?.accountId) query.set('lineAccountId', params.accountId)
      if (params?.search) query.set('search', params.search)
      if (params?.status) query.set('status', params.status)
      if (params?.includeTest) query.set('include_test', '1')
      return `/api/automation-runs?${query}`
    },
    // #942 N-353: まだ終わっていない実行を取りやめる。取消済みはそのまま成功。
    cancelRun: (id: string) =>
      fetchApi<ApiResponse<{ runId: string; status: 'cancelled'; alreadyCancelled: boolean; cancelledStepCount: number }>>(
        `/api/automation-runs/${encodeURIComponent(id)}/cancel`,
        { method: 'POST', body: '{}' },
      ),
  },
  commonActions: {
    resources: (accountId: string, excludeId?: string, trigger?: 'tag.added') => {
      const query = new URLSearchParams({ account_id: accountId });
      if (excludeId) query.set('exclude_id', excludeId);
      if (trigger) query.set('trigger', trigger);
      return fetchApi<ApiResponse<CommonActionResources>>(`/api/common-actions/resources?${query}`);
    },
    list: (params: {
      accountId: string;
      status?: 'all' | 'draft' | 'published' | 'archived' | 'old_version' | 'unused';
      query?: string;
      folderId?: string;
      limit?: number;
      offset?: number;
    }) => {
      const query = new URLSearchParams({ account_id: params.accountId });
      if (params.status && params.status !== 'all') query.set('status', params.status);
      if (params.query) query.set('query', params.query);
      if (params.folderId) query.set('folder_id', params.folderId);
      if (params.limit !== undefined) query.set('limit', String(params.limit));
      if (params.offset !== undefined) query.set('offset', String(params.offset));
      return fetchApi<ApiResponse<CommonActionSummary[]> & {
        pagination?: { total: number; limit: number | null; offset: number }
        summary?: {
          total: number; published: number; draft: number; oldVersion: number; unused: number;
          archived: number;
          actions: number; bindings: number; outdated: number; outdatedItems: number;
          executions: number; failures: number;
        }
        freshness?: 'available'
      }>(`/api/common-actions?${query}`);
    },
    // 監査 R464: 一覧の検索・絞り込みをそのまま渡す。付けないと
    // 「絞り込んだつもりが全件」になる。status=all・空queryは付けない。
    csvUrl: (params: { accountId: string; status?: string; query?: string }) => {
      const query = new URLSearchParams({ account_id: params.accountId, format: 'csv' });
      if (params.status && params.status !== 'all') query.set('status', params.status);
      if (params.query?.trim()) query.set('query', params.query.trim());
      return `${API_URL}/api/common-actions?${query}`;
    },
    get: (id: string, accountId: string) =>
      fetchApi<ApiResponse<CommonActionDetail>>(
        `/api/common-actions/${id}?account_id=${encodeURIComponent(accountId)}`,
      ),
    duplicate: (id: string, accountId: string) =>
      fetchApi<ApiResponse<{ id: string; draftVersionId: string; versionNumber: number }>>(
        `/api/common-actions/${id}/duplicate?account_id=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: '{}' },
      ),
    // 監査 R480: 未使用の共通アクションを保管する。利用中はサーバが拒否する。
    archive: (id: string, accountId: string) =>
      fetchApi<ApiResponse<{ archived: true }>>(
        `/api/common-actions/${id}/archive?account_id=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: '{}' },
      ),
    unarchive: (id: string, accountId: string) =>
      fetchApi<ApiResponse<{ unarchived: true }>>(
        `/api/common-actions/${id}/unarchive?account_id=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: '{}' },
      ),
    // 監査 R475: 初回保存から再試行まで同じ鍵を送り、二重作成にしない。
    create: (accountId: string, data: {
      folderId?: string | null;
      name: string;
      description?: string | null;
      actions: CommonActionStep[];
      clientRequestKey: string;
    }) => fetchApi<ApiResponse<{ id: string; draftVersionId: string; versionNumber: number }>>(
      `/api/common-actions?account_id=${encodeURIComponent(accountId)}`,
      { method: 'POST', body: JSON.stringify(data) },
    ),
    // 監査 R473: 保存ごとに進む改訂番号を照合する。古い画面の保存は409で止まる。
    updateDraft: (id: string, accountId: string, data: {
      folderId?: string | null
      expectedDraftVersionId: string;
      expectedDraftRevision: number;
      name: string;
      description?: string | null;
      actions: CommonActionStep[];
    }) => fetchApi<ApiResponse<{ updated: true }>>(
      `/api/common-actions/${id}/draft?account_id=${encodeURIComponent(accountId)}`,
      { method: 'PUT', body: JSON.stringify(data) },
    ),
    createDraft: (id: string, accountId: string, fromVersionId?: string) =>
      fetchApi<ApiResponse<{ draftVersionId: string; versionNumber: number }>>(
        `/api/common-actions/${id}/versions?account_id=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: JSON.stringify({ fromVersionId }) },
      ),
    // 監査 R477: 公開確認に使った改訂番号を照合する。読取後の保存があれば409で止まる。
    publish: (id: string, accountId: string, versionId: string, expectedDraftRevision: number) =>
      fetchApi<ApiResponse<{ versionId: string; versionNumber: number }>>(
        `/api/common-actions/${id}/versions/${versionId}/publish?account_id=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: JSON.stringify({ expectedDraftRevision }) },
      ),
    // 監査 R467: 比較に使った現在版IDを更新要求にも渡す。無いと422で
    // 利用者が解消できない。先に別担当が切り替えたら409で再確認へ導く。
    updateBinding: (
      id: string,
      accountId: string,
      data: { bindingId: string; versionId: string; expectedVersionId: string; expectedConfirmationRevision?: number },
    ) => fetchApi<ApiResponse<{ updated: true }>>(
      `/api/common-actions/${id}/bindings/${data.bindingId}/version?account_id=${encodeURIComponent(accountId)}`,
      { method: 'POST', body: JSON.stringify({ versionId: data.versionId, expectedVersionId: data.expectedVersionId, expectedConfirmationRevision: data.expectedConfirmationRevision }) },
    ),
  },
}
