import { fetchApi } from '../transport/request'
import type { ApiResponse } from '@line-crm/shared'
import type { SearchConsolePerformance, SearchConsoleSetup } from '../types/search-console'
import type {
  AnalyticsReportSchedule,
  RecentOneTimeReport,
  AnalyticsReportScheduleOptions,
  AnalyticsReportRun,
  AnalyticsFriendsOverview,
  AnalyticsReactionsOverview,
  AnalyticsRoutesOverview,
  AnalyticsUsageOverview,
  AnalyticsUrlClicksOverview,
  AnalyticsCrossAxis,
  AnalyticsCrossMeasure,
  AnalyticsCrossResult,
  AnalyticsFunnelRunResult,
  SavedAnalyticsSummary,
  SavedAnalyticsSnapshot,
} from '../types/analytics'
import { rangeQuery } from '../query'

export const analyticsMethods = {
  searchConsole: {
    performance: (days: 7 | 28 | 90) =>
      fetchApi<ApiResponse<SearchConsolePerformance | SearchConsoleSetup>>(
        `/api/search-console/performance?days=${days}`,
      ),
  },
/**
   * 集計。新しいテーブルは作らず、既にあるデータをその場で数える。
   * 外部APIを叩かないので、ここが外の障害で落ちることはない。
   */
  analytics: {
    reportSchedules: {
      list: (accountId: string) =>
        fetchApi<ApiResponse<{ items: AnalyticsReportSchedule[]; recentOneTime?: RecentOneTimeReport[]; options: AnalyticsReportScheduleOptions }>>(
          `/api/analytics/report-schedules?account_id=${encodeURIComponent(accountId)}`,
        ),
      /*
       * R526: 応答消失後の再送で二重予約にしない要求キー。同じ試行の
       * やり直しは同じキー、別の新規作成は別のキーで呼ぶ。サーバは
       * 同じキー＋同じ内容なら既にある予約を返す（`replayed`）。
       */
      create: (accountId: string, data: Omit<
        AnalyticsReportSchedule,
        'id' | 'lineAccountId' | 'status' | 'isOneTime' | 'nextRunAt' | 'createdBy' | 'createdAt' | 'updatedAt'
      > & { sendOnce?: boolean }, options?: { idempotencyKey?: string }) => fetchApi<ApiResponse<AnalyticsReportSchedule> & { replayed?: boolean }>(
        `/api/analytics/report-schedules?account_id=${encodeURIComponent(accountId)}`,
        {
          method: 'POST',
          body: JSON.stringify(data),
          ...(options?.idempotencyKey ? { headers: { 'Idempotency-Key': options.idempotencyKey } } : {}),
        },
      ),
      update: (accountId: string, id: string, data: Omit<
        AnalyticsReportSchedule,
        'id' | 'lineAccountId' | 'status' | 'isOneTime' | 'nextRunAt' | 'createdBy' | 'createdAt' | 'updatedAt'
      > & { expectedUpdatedAt: string }) => fetchApi<ApiResponse<AnalyticsReportSchedule>>(
        `/api/analytics/report-schedules/${encodeURIComponent(id)}?account_id=${encodeURIComponent(accountId)}`,
        { method: 'PUT', body: JSON.stringify(data) },
      ),
      setStatus: (accountId: string, id: string, data: {
        status: 'active' | 'paused' | 'archived'
        expectedUpdatedAt: string
      }) => fetchApi<ApiResponse<AnalyticsReportSchedule>>(
        `/api/analytics/report-schedules/${encodeURIComponent(id)}/status?account_id=${encodeURIComponent(accountId)}`,
        { method: 'PUT', body: JSON.stringify(data) },
      ),
      // R454: しまった1回送信も依頼IDで履歴を引く・送り直す。
      runs: (accountId: string, id: string) =>
        fetchApi<ApiResponse<{ schedule: AnalyticsReportSchedule; runs: AnalyticsReportRun[] }>>(
          `/api/analytics/report-schedules/${encodeURIComponent(id)}/runs?account_id=${encodeURIComponent(accountId)}`,
        ),
      retry: (accountId: string, id: string) => fetchApi<ApiResponse<AnalyticsReportSchedule>>(
        `/api/analytics/report-schedules/${encodeURIComponent(id)}/retry?account_id=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: JSON.stringify({}) },
      ),
    },
    friendsOverview: (accountId: string, params?: { from?: string; to?: string }) =>
      fetchApi<ApiResponse<AnalyticsFriendsOverview>>(
        `/api/analytics/friends${rangeQuery({ ...params, accountId })}`,
      ),
    reactionsOverview: (accountId: string, params?: { from?: string; to?: string }) =>
      fetchApi<ApiResponse<AnalyticsReactionsOverview>>(
        `/api/analytics/reactions${rangeQuery({ ...params, accountId })}`,
      ),
    routesOverview: (accountId: string, params?: { from?: string; to?: string }) =>
      fetchApi<ApiResponse<AnalyticsRoutesOverview>>(
        `/api/analytics/routes${rangeQuery({ ...params, accountId })}`,
      ),
    usageOverview: (accountId: string, params?: { from?: string; to?: string }, options?: { suppressFeatureDisabledEvent?: boolean }) =>
      fetchApi<ApiResponse<AnalyticsUsageOverview>>(
        `/api/analytics/usage${rangeQuery({ ...params, accountId })}`,
        options,
      ),
    urlClicksOverview: (
      accountId: string,
      params?: { from?: string; to?: string; limit?: number; query?: string },
    ) => {
      const query = new URLSearchParams()
      query.set('account_id', accountId)
      if (params?.from) query.set('from', params.from)
      if (params?.to) query.set('to', params.to)
      if (params?.limit) query.set('limit', String(params.limit))
      if (params?.query) query.set('query', params.query)
      return fetchApi<ApiResponse<AnalyticsUrlClicksOverview>>(
        `/api/analytics/url-clicks?${query.toString()}`,
      )
    },
    messages: (accountId: string, params?: { from?: string; to?: string }) =>
      fetchApi<
        ApiResponse<
          Array<{
            date: string
            outgoing: number
            incoming: number
            /** 応答メッセージ。LINE の課金対象外 */
            reply: number
            /** プッシュ。LINE の課金対象 */
            push: number
            fromBroadcast: number
            fromScenario: number
          }>
        >
      >(`/api/analytics/messages${rangeQuery({ ...params, accountId })}`),
    /** 測定中のURL。1回も押されていないものも返る */
    trackedLinks: (accountId: string, params?: { from?: string; to?: string }) =>
      fetchApi<
        ApiResponse<
          Array<{
            trackedLinkId: string
            name: string
            originalUrl: string
            shortCode: string | null
            tagName: string | null
            scenarioName: string | null
            isActive: boolean
            clicks: number
            uniqueFriends: number
          }>
        >
      >(`/api/analytics/tracked-links${rangeQuery({ ...params, accountId })}`),
    linkClicks: (accountId: string, params?: { from?: string; to?: string }) =>
      fetchApi<
        ApiResponse<
          Array<{ trackedLinkId: string; name: string; clicks: number; uniqueFriends: number }>
        >
      >(`/api/analytics/link-clicks${rangeQuery({ ...params, accountId })}`),
    broadcasts: (accountId: string, params?: { from?: string; to?: string }) =>
      fetchApi<
        ApiResponse<
          Array<{
            broadcastId: string
            name: string
            sentAt: string | null
            delivered: number | null
            uniqueImpression: number | null
            uniqueClick: number | null
            /** LINEの制約で20人未満は開封が取れない */
            suppressedByAudienceSize: boolean
          }>
        >
      >(`/api/analytics/broadcasts${rangeQuery({ ...params, accountId })}`),
    runCross: (accountId: string, data: {
      rowAxis: AnalyticsCrossAxis
      columnAxis: AnalyticsCrossAxis
      measure: AnalyticsCrossMeasure
      filters: []
      periodFrom: string
      periodTo: string
    }) => fetchApi<ApiResponse<{ id: string; state: 'pending' }>>(
      `/api/analytics/cross/query?account_id=${encodeURIComponent(accountId)}`,
      { method: 'POST', body: JSON.stringify(data) },
    ),
    crossResult: (accountId: string, id: string) =>
      fetchApi<ApiResponse<{
        id: string
        state: 'pending' | 'running' | 'available' | 'partial' | 'unavailable' | 'failed'
        errorCode: string | null
        result: AnalyticsCrossResult | null
        createdAt: string
        queuePosition: number | null
        pendingAhead: number
        estimatedWaitMs: number | null
        nextTickAt: string | null
      }>>(`/api/analytics/cross/results/${id}?account_id=${encodeURIComponent(accountId)}`),
    createResultAudience: (accountId: string, resultId: string, data: {
      sourceKind: 'cross' | 'funnel'
      rowKey?: string
      columnKey?: string
      groupKey?: string
      stepOrder?: number
      selection?: 'reached' | 'stopped' | 'in_progress'
    }) => fetchApi<ApiResponse<{ id: string; memberCount: number; expiresAt: string }>>(
      `/api/analytics/results/${resultId}/audiences?account_id=${encodeURIComponent(accountId)}`,
      { method: 'POST', body: JSON.stringify(data) },
    ),
    // 一時対象者の詳細。配信作成が人数・期限を読み直すために使う。
    // 友だちIDは返ってこない。期限切れは410、他アカウント・不存在は404。
    audience: (id: string, accountId: string) => fetchApi<ApiResponse<{
      id: string
      sourceKind: string
      selectionKey: string | null
      memberCount: number
      expiresAt: string
      createdAt: string
    }>>(`/api/analytics/audiences/${encodeURIComponent(id)}?account_id=${encodeURIComponent(accountId)}`),
    v6Funnels: {
      list: (accountId: string, options?: { includeInactive?: boolean }) => fetchApi<ApiResponse<Array<{
        id: string
        name: string
        windowDays: number
        createdAt: string
        status: 'active' | 'stopped' | 'archived'
        confirmationRevision: number
        currentVersion: { id: string; versionNumber: number; createdAt: string } | null
        migrationState: 'ready' | 'needs_migration'
      }>>>(`/api/analytics/funnels?account_id=${encodeURIComponent(accountId)}${options?.includeInactive ? '&includeInactive=1' : ''}`),
      // 編集画面が現在の定義（段・期間・絞り込み）を丸ごと読む口。
      get: (accountId: string, funnelId: string) => fetchApi<ApiResponse<{
        id: string
        name: string
        windowDays: number
        createdAt: string
        status: 'active' | 'stopped' | 'archived'
        currentVersion: {
          id: string
          versionNumber: number
          windowDays: number
          steps: Array<{ label: string; kind: string; match: Record<string, string> }>
          segment: unknown
          comparisonGroups: unknown[]
          createdAt: string
        } | null
      }>>(
        `/api/analytics/funnels/${funnelId}?account_id=${encodeURIComponent(accountId)}`,
      ),
      create: (accountId: string, data: {
        name: string
        windowDays: number
        steps: Array<{ label: string; kind: string; match: Record<string, string> }>
      }) => fetchApi<ApiResponse<{
        funnelId: string
        version: { id: string; versionNumber: number }
        // CONVERSION-05: 段の成果地点へ利用先を記せなかったもの。作成は
        // 成功しているので、失敗ではなく「記せなかった」として画面へ返す。
        usageWarnings?: string[]
      }>>(
        `/api/analytics/funnels?account_id=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
      // 既存ファネルの編集 = 現在版を元に新版を積む。expectedVersionNumber で
      // 画面を開いた後に誰かが保存していないかを検査する。
      createVersion: (accountId: string, funnelId: string, data: {
        name?: string
        windowDays: number
        steps: Array<{ label: string; kind: string; match: Record<string, string> }>
        // フォームに出せない絞り込み・比較条件は元の版からそのまま返す
        segment?: unknown
        comparisonGroups?: unknown[]
        expectedVersionNumber: number
      }) => fetchApi<ApiResponse<{ id: string; versionNumber: number; usageWarnings?: string[] }>>(
        `/api/analytics/funnels/${funnelId}/versions?account_id=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
      // 停止・保管・再開。expectedStatus で開いてからの状態変化を検査する。
      setStatus: (accountId: string, funnelId: string, data: {
        status: 'active' | 'stopped' | 'archived'
        expectedStatus: 'active' | 'stopped' | 'archived'
        expectedRevision?: number
      }) => fetchApi<ApiResponse<{ id: string; status: 'active' | 'stopped' | 'archived' }>>(
        `/api/analytics/funnels/${funnelId}/status?account_id=${encodeURIComponent(accountId)}`,
        { method: 'PUT', body: JSON.stringify(data) },
      ),
      latestRun: (accountId: string, funnelId: string) =>
        fetchApi<ApiResponse<AnalyticsFunnelRunResult>>(
          `/api/analytics/funnels/${funnelId}/runs/latest?account_id=${encodeURIComponent(accountId)}`,
        ),
      run: (accountId: string, funnelId: string, data: { cohortFrom: string; cohortTo: string }) =>
        fetchApi<ApiResponse<AnalyticsFunnelRunResult>>(
          `/api/analytics/funnels/${funnelId}/run?account_id=${encodeURIComponent(accountId)}`,
          { method: 'POST', body: JSON.stringify(data) },
        ),
    },
    saved: {
      list: (accountId: string) => fetchApi<ApiResponse<SavedAnalyticsSummary[]>>(
        `/api/analytics/saved?account_id=${encodeURIComponent(accountId)}`,
      ),
      create: (accountId: string, data: {
        name: string
        sourceKind: 'cross' | 'funnel'
        sourceResultId: string
      }) => fetchApi<ApiResponse<{ id: string; versionId: string; snapshotId: string }>>(
        `/api/analytics/saved?account_id=${encodeURIComponent(accountId)}`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
      snapshots: (accountId: string, id: string) =>
        fetchApi<ApiResponse<SavedAnalyticsSnapshot[]>>(
          `/api/analytics/saved/${id}/snapshots?account_id=${encodeURIComponent(accountId)}`,
        ),
    },
  },
}
