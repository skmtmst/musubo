import type {
  ScenarioSimulation,
  ScenarioRuns,
  ScenarioFriendPlan,
  ScenarioDraftV6,
  ScenarioUpdateInput,
  ScenarioConfirmation,
  ScenarioStopInput,
  FriendScenarioSubscription,
  ScenarioDraftActionV6,
  ScenarioAction,
  ScenarioActionHook,
  ScenarioActionType,
  ScenarioTriggerItem,
} from '../types/scenarios'
import { fetchApi } from '../transport/request'
import type {
  ApiResponse,
  QuestionAnswerRecovery,
  ResumeQuestionAnswerRequest,
  ResumeQuestionAnswerResponse,
  Scenario,
  ScenarioStep,
  LineMessageType,
} from '@line-crm/shared'

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 撮影用固定データなどが古い成功形を返しても、画面へ壊れた値を渡さない。 */
function isScenarioSimulation(value: unknown): value is ScenarioSimulation {
  if (!isObjectRecord(value) || !isObjectRecord(value.audience) || !Array.isArray(value.steps)) return false
  const audience = value.audience
  return typeof value.scenarioId === 'string'
    && typeof value.lineAccountId === 'string'
    && typeof value.computedAt === 'string'
    && value.sideEffects === false
    && ['accountTotal', 'matched', 'alreadySubscribed', 'newStartPlanned', 'excluded']
      .every((key) => typeof audience[key] === 'number')
}

function isScenarioRuns(value: unknown): value is ScenarioRuns {
  if (!isObjectRecord(value) || !isObjectRecord(value.summary)) return false
  const summary = value.summary
  return ['active', 'paused', 'completed', 'delivering'].every((key) => typeof summary[key] === 'number')
    && Array.isArray(value.subscriptions)
    && Array.isArray(value.testSends)
    && isObjectRecord(value.quota)
    && Array.isArray(value.concurrentBroadcasts)
    && Array.isArray(value.steps)
}

function isScenarioFriendPlan(value: unknown): value is ScenarioFriendPlan {
  if (!isObjectRecord(value)) return false
  return typeof value.scenarioId === 'string'
    && typeof value.friendId === 'string'
    && typeof value.computedAt === 'string'
    && value.sideEffects === false
    && ['pinned', 'published', 'draft'].includes(String(value.basis))
    && isObjectRecord(value.start)
    && Array.isArray(value.steps)
    && Array.isArray(value.warnings)
}

function isScenarioDraft(value: unknown): value is ScenarioDraftV6 {
  return isObjectRecord(value)
    && typeof value.scenarioId === 'string'
    && typeof value.lineAccountId === 'string'
    && typeof value.version === 'number'
    && Array.isArray(value.afterActions)
    && typeof value.updatedBy === 'string'
    && typeof value.updatedAt === 'string'
}

export const scenariosMethods = {
  scenarios: {
    questionAnswers: {
      list: (scenarioId:string)=>fetchApi<ApiResponse<QuestionAnswerRecovery[]>>(`/api/scenarios/${encodeURIComponent(scenarioId)}/question-answers`),
      resume: (scenarioId:string,executionId:string,input:ResumeQuestionAnswerRequest)=>fetchApi<ApiResponse<ResumeQuestionAnswerResponse>>(
        `/api/scenarios/${encodeURIComponent(scenarioId)}/question-answers/${encodeURIComponent(executionId)}/resume`,{method:'POST',body:JSON.stringify(input)}),
    },
    listPage: (params?: {
      accountId?: string
      page?: number
      limit?: number
      query?: string
      active?: 0 | 1
      createdFrom?: string
      folderId?: string
    }, signal?: AbortSignal) => {
      const query = new URLSearchParams()
      if (params?.accountId) query.set('lineAccountId', params.accountId)
      if (params?.page !== undefined) query.set('page', String(params.page))
      if (params?.limit !== undefined) query.set('limit', String(params.limit))
      if (params?.query) query.set('query', params.query)
      if (params?.active !== undefined) query.set('active', String(params.active))
      if (params?.createdFrom) query.set('createdFrom', params.createdFrom)
      if (params?.folderId) query.set('folderId', params.folderId)
      return fetchApi<
        ApiResponse<
          {
            items: (Scenario & {
              stepCount?: number
              /** いま流れている人 */
              subscriberCount?: number | null
              /** 最後まで届いた人 */
              completedCount?: number | null
            })[]
            total: number
            limit: number
            sort: Array<{ field: string; direction: 'asc' | 'desc' }>
          }
        >
      >(`/api/scenarios${query.size ? `?${query}` : ''}`, { signal })
    },
    /** 選択肢など既存の全件利用は配列のまま読み替える。新しい一覧画面は listPage を使う。 */
    list: async (params?: { accountId?: string; limit?: number }) => {
      const query = new URLSearchParams()
      if (params?.accountId) query.set('lineAccountId', params.accountId)
      query.set('limit', String(params?.limit ?? 200))
      const response = await fetchApi<ApiResponse<{
        items: (Scenario & { stepCount?: number; subscriberCount?: number | null; completedCount?: number | null })[]
        total: number
        limit: number
        sort: Array<{ field: string; direction: 'asc' | 'desc' }>
      }>>(`/api/scenarios?${query}`)
      return response.success
        ? { success: true as const, data: response.data.items }
        : response
    },
    get: (id: string) =>
      fetchApi<ApiResponse<Scenario & { steps: ScenarioStep[] }>>(`/api/scenarios/${id}`),
    /** 並び順をまとめて書く。渡した順に 0,1,2… が振られる。 */
    reorder: (ids: string[]) =>
      fetchApi<ApiResponse<{ updated: number }>>('/api/scenarios/reorder', {
        method: 'PATCH',
        body: JSON.stringify({ ids }),
      }),
    create: (data: Omit<Scenario, 'id' | 'createdAt' | 'updatedAt' | 'stoppedReason' | 'stoppedBy' | 'stoppedAt'>) =>
      fetchApi<ApiResponse<Scenario>>('/api/scenarios', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: ScenarioUpdateInput) =>
      fetchApi<ApiResponse<Scenario>>(`/api/scenarios/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    /** 配信を一時停止する。理由を省略しても止められる。 */
    stop: (id: string, data: ScenarioStopInput = {}) =>
      fetchApi<ApiResponse<Scenario>>(`/api/scenarios/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...data, isActive: false }),
      }),
    bulkStop: (items: Array<{ id: string; revision: number; activeCount: number; rowIdSum: number; rowIdSquareSum: number }>) =>
      fetchApi<ApiResponse<{ stopped: number }>>('/api/scenarios/bulk-stop', { method: 'POST', body: JSON.stringify({ items }) }),
    delete: (id: string, confirmation?: Pick<ScenarioConfirmation, 'contentRevision' | 'activeCount' | 'rowIdSum' | 'rowIdSquareSum' | 'totalCount' | 'totalRowIdSum' | 'totalRowIdSquareSum' | 'referrers'>) =>
      fetchApi<ApiResponse<null>>(`/api/scenarios/${id}`, { method: 'DELETE', ...(confirmation ? { body: JSON.stringify({ expectedContentRevision: confirmation.contentRevision, expectedSubscriptions: { activeCount: confirmation.totalCount, rowIdSum: confirmation.totalRowIdSum, rowIdSquareSum: confirmation.totalRowIdSquareSum }, expectedActiveSubscriptions: { activeCount: confirmation.activeCount, rowIdSum: confirmation.rowIdSum, rowIdSquareSum: confirmation.rowIdSquareSum }, expectedReferrers: confirmation.referrers }) } : {}) }),
    /**
     * R250: このシナリオを終了後の移動先にしているシナリオの一覧。
     * 削除の確認窓で「どのシナリオの設定が変わるか」を見せる。
     */
    moveReferrers: (id: string) =>
      fetchApi<ApiResponse<{ items: Array<{ id: string; name: string }>; total: number }>>(
        `/api/scenarios/${id}/move-referrers`,
      ),
    addStep: (
      id: string,
      data: {
        stepOrder: number
        messageType: LineMessageType
        messageContent: string
        delayMinutes?: number
        offsetDays?: number
        offsetMinutes?: number
        deliveryTime?: string
        templateId?: string | null
        onReachTagId?: string | null
        afterSend?: 'continue' | 'pause'
        /** 1通ごとの配信対象。null は「購読中の全員に配信する」。 */
        targetCondition?: unknown
        /** 質問メッセージ（分岐）。 */
        question?: unknown
        isDraft?: boolean
      },
    ) =>
      fetchApi<ApiResponse<ScenarioStep>>(`/api/scenarios/${id}/steps`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    updateStep: (
      id: string,
      stepId: string,
      data: {
        stepOrder?: number
        messageType?: LineMessageType
        messageContent?: string
        delayMinutes?: number
        offsetDays?: number
        offsetMinutes?: number
        deliveryTime?: string
        templateId?: string | null
        onReachTagId?: string | null
        afterSend?: 'continue' | 'pause'
        targetCondition?: unknown
        question?: unknown
        isDraft?: boolean
      },
    ) =>
      fetchApi<ApiResponse<ScenarioStep>>(`/api/scenarios/${id}/steps/${stepId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    confirmation: (id: string, purpose: 'stop' | 'delete') => fetchApi<ApiResponse<ScenarioConfirmation>>(`/api/scenarios/${id}/confirmation?purpose=${purpose}`),
    deleteStep: (id: string, stepId: string, expectedContentRevision?: number) =>
      fetchApi<ApiResponse<null>>(`/api/scenarios/${id}/steps/${stepId}`, {
        method: 'DELETE', ...(expectedContentRevision === undefined ? {} : { body: JSON.stringify({ expectedContentRevision }) }),
      }),
    reorderSteps: (id: string, orders: { stepId: string; stepOrder: number }[]) =>
      fetchApi<ApiResponse<null>>(`/api/scenarios/${id}/steps/reorder`, {
        method: 'POST',
        body: JSON.stringify({ orders }),
      }),
    preview: (id: string, startAt?: string, signal?: AbortSignal) => {
      const q = startAt ? `?startAt=${encodeURIComponent(startAt)}` : ''
      return fetchApi<ApiResponse<{
        startAt: string
        steps: Array<{
          stepOrder: number
          deliveryAt: string
          deliveryAtLabel: string
          messageType: string
          messageContent: string
          /** 下書きの通は送られない（R212）。 */
          isDraft?: boolean
          /** R237: 公開版・通の控えのどれか。 */
          contentSource?: 'template' | 'step' | 'step-fallback'
          /** R237: 控えに落ちた理由。 */
          fallbackReason?: 'missing' | 'unpublished' | 'other_account' | null
        }>
      }>>(`/api/scenarios/${id}/preview${q}`, { signal })
    },
    /** この友だちをこのシナリオに登録する（1人ぶん）。 */
    enroll: (scenarioId: string, friendId: string) =>
      fetchApi<ApiResponse<unknown>>(
        `/api/scenarios/${scenarioId}/enroll/${friendId}`,
        { method: 'POST' },
      ),
    /*
     * 友だち単位の購読操作（#949 N-054）。
     * どれも確認キー（Idempotency-Key）が要る。二度押し・再送で
     * 同じ操作が2回走らないように、呼び出し側は IdempotencyKeyStore で
     * 同じ署名へ同じキーを当てる。
     */
    subscriptionOps: {
      /** 進行中の購読を手動で止める。 */
      pause: (subscriptionId: string, idempotencyKey: string) =>
        fetchApi<ApiResponse<FriendScenarioSubscription>>(
          `/api/scenario-subscriptions/${subscriptionId}/pause`,
          { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } },
        ),
      /** 止まっている購読を続きから再開する。 */
      resume: (subscriptionId: string, idempotencyKey: string) =>
        fetchApi<ApiResponse<FriendScenarioSubscription>>(
          `/api/scenario-subscriptions/${subscriptionId}/resume`,
          { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } },
        ),
      /** 配信失敗で止まった購読を、失敗した通から送り直す。 */
      retry: (subscriptionId: string, idempotencyKey: string) =>
        fetchApi<ApiResponse<FriendScenarioSubscription>>(
          `/api/scenario-subscriptions/${subscriptionId}/retry`,
          { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } },
        ),
      /** 購読を別のシナリオへ移す。返るのは移し先でできた新しい購読。 */
      move: (subscriptionId: string, targetScenarioId: string, idempotencyKey: string, confirmation?: { revision: number; status: string }) =>
        fetchApi<ApiResponse<FriendScenarioSubscription>>(
          `/api/scenario-subscriptions/${subscriptionId}/move`,
          {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify({ targetScenarioId, expectedConfirmationRevision: confirmation?.revision, expectedStatus: confirmation?.status }),
          },
        ),
    },
    stats: (id: string) =>
      fetchApi<ApiResponse<{
        enrolledTotal: number
        activeNow: number
        completed: number
        paused: number
        steps: Array<{ stepOrder: number; reachedCount: number; reachRate: number }>
      }>>(`/api/scenarios/${id}/stats`),
    /** 配信は行わず、現在の実データで開始人数と各通の予定を試算する。 */
    simulate: async (id: string, lineAccountId: string, startAt?: string): Promise<ApiResponse<ScenarioSimulation>> => {
      const response = await fetchApi<ApiResponse<unknown>>(`/api/scenarios/${id}/simulate`, {
        method: 'POST',
        body: JSON.stringify({ lineAccountId, ...(startAt ? { startAt } : {}) }),
      })
      if (!response.success) return response
      return isScenarioSimulation(response.data)
        ? { success: true, data: response.data }
        : { success: false, error: '開始前の試算結果を確認できませんでした' }
    },
    /** 購読・テスト送信・送信枠・通別結果を1回で読む。 */
    runs: async (
      id: string,
      lineAccountId: string,
      params?: { status?: string; cursor?: string; limit?: number },
    ): Promise<ApiResponse<ScenarioRuns>> => {
      const query = new URLSearchParams({ lineAccountId })
      if (params?.status) query.set('status', params.status)
      if (params?.cursor) query.set('cursor', params.cursor)
      if (params?.limit) query.set('limit', String(params.limit))
      const response = await fetchApi<ApiResponse<unknown>>(`/api/scenarios/${id}/runs?${query}`)
      if (!response.success) return response
      return isScenarioRuns(response.data)
        ? { success: true, data: response.data }
        : { success: false, error: '配信記録を確認できませんでした' }
    },
    /**
     * 友だち単位の配信予定を副作用なしで試算する（IDEA-05）。
     * 送信・購読登録・タグ更新は起きない。
     */
    friendPlan: async (
      id: string,
      friendId: string,
      lineAccountId: string,
    ): Promise<ApiResponse<ScenarioFriendPlan>> => {
      const query = new URLSearchParams({ lineAccountId })
      const response = await fetchApi<ApiResponse<unknown>>(
        `/api/scenarios/${id}/friends/${friendId}/plan?${query}`,
      )
      if (!response.success) return response
      return isScenarioFriendPlan(response.data)
        ? { success: true, data: response.data }
        : { success: false, error: '配信予定を確認できませんでした' }
    },
    /** 管理画面送信後アクションを楽観ロック付き下書きへまとめて保存する。 */
    saveDraft: async (
      id: string,
      data: { lineAccountId: string; expectedVersion: number; afterActions: ScenarioDraftActionV6[] },
    ): Promise<ApiResponse<ScenarioDraftV6>> => {
      const response = await fetchApi<ApiResponse<unknown>>(`/api/scenarios/${id}/draft`, {
        method: 'PUT',
        body: JSON.stringify(data),
      })
      if (!response.success) return response
      return isScenarioDraft(response.data)
        ? { success: true, data: response.data }
        : { success: false, error: 'シナリオの下書き保存結果を確認できませんでした' }
    },
    getDraft: (id: string, lineAccountId: string) =>
      fetchApi<ApiResponse<ScenarioDraftV6 | null>>(`/api/scenarios/${id}/draft?lineAccountId=${encodeURIComponent(lineAccountId)}`),

    /* ---- アクション（Lステップの「アクション設定」にあたる） ---- */
    actions: {
      list: (scenarioId: string) =>
        fetchApi<ApiResponse<ScenarioAction[]>>(`/api/scenarios/${scenarioId}/actions`),
      create: (
        scenarioId: string,
        data: {
          hook: ScenarioActionHook
          stepId?: string | null
          choiceIndex?: number | null
          actionType: ScenarioActionType
          config: unknown
          condition?: unknown
          repeatOnRefire?: boolean
          sortOrder?: number
        },
      ) =>
        fetchApi<ApiResponse<ScenarioAction>>(`/api/scenarios/${scenarioId}/actions`, {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      update: (
        scenarioId: string,
        actionId: string,
        data: { config?: unknown; condition?: unknown; repeatOnRefire?: boolean; sortOrder?: number },
      ) =>
        fetchApi<ApiResponse<ScenarioAction>>(`/api/scenarios/${scenarioId}/actions/${actionId}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        }),
      remove: (scenarioId: string, actionId: string) =>
        fetchApi<ApiResponse<null>>(`/api/scenarios/${scenarioId}/actions/${actionId}`, {
          method: 'DELETE',
        }),
    },

    /* ---- 開始のきっかけ。1本に複数持てる ---- */
    triggers: {
      list: (scenarioId: string) =>
        fetchApi<ApiResponse<ScenarioTriggerItem[]>>(`/api/scenarios/${scenarioId}/triggers`),
      add: (
        scenarioId: string,
        kind: 'friend_add' | 'tag_added' | 'form_answer' | 'booking_confirmed',
        tagId?: string | null,
      ) =>
        fetchApi<ApiResponse<ScenarioTriggerItem[]>>(`/api/scenarios/${scenarioId}/triggers`, {
          method: 'POST',
          body: JSON.stringify({ kind, tagId: tagId ?? null }),
        }),
      remove: (scenarioId: string, triggerId: string) =>
        fetchApi<ApiResponse<null>>(`/api/scenarios/${scenarioId}/triggers/${triggerId}`, {
          method: 'DELETE',
        }),
    },

    /* ---- テスト送信。購読の状態は動かさない ---- */
    testSend: (scenarioId: string, friendId: string) =>
      fetchApi<ApiResponse<{ sent: number }>>(`/api/scenarios/${scenarioId}/test-send`, {
        method: 'POST',
        body: JSON.stringify({ friendId }),
      }),
    testSendStep: (scenarioId: string, stepId: string, friendId: string) =>
      fetchApi<ApiResponse<{ sent: number }>>(
        `/api/scenarios/${scenarioId}/steps/${stepId}/test-send`,
        { method: 'POST', body: JSON.stringify({ friendId }) },
      ),
  },
  scenarioDrafts: {
    get: (accountId:string,key:string) => fetchApi<ApiResponse<import('@line-crm/shared').ScenarioDraft>>(`/api/scenario-drafts/${encodeURIComponent(key)}?${new URLSearchParams({lineAccountId:accountId})}`),
    save: (accountId:string,key:string,body:import('@line-crm/shared').ScenarioDraftInput) => fetchApi<ApiResponse<import('@line-crm/shared').ScenarioDraft>>(`/api/scenario-drafts/${encodeURIComponent(key)}?${new URLSearchParams({lineAccountId:accountId})}`,{method:'PUT',body:JSON.stringify(body)}),
    delete: (accountId:string,key:string,expectedVersion:string) => fetchApi<ApiResponse<unknown>>(`/api/scenario-drafts/${encodeURIComponent(key)}?${new URLSearchParams({lineAccountId:accountId})}`,{method:'DELETE',body:JSON.stringify({expectedVersion})}),
  },
}
