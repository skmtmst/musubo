import { fetchApi } from '../transport/request'
import type { ApiResponse } from '@line-crm/shared'
import type { GettingStartedFirstRun, GettingStartedStarter, GettingStartedStep, Recipe, ManualLink } from '../types/onboarding'

export const onboardingMethods = {
/** はじめの設定の順路。台帳 #134。**毎回いまの中身を数える（キャッシュしない）。** */
  gettingStarted: {
    get: (accountId?: string, version?: 'v8') =>
      fetchApi<ApiResponse<{
        steps: GettingStartedStep[]
        accountId: string | null
        /** アカウントを選んでいてスタイルを保存済みの時だけ。それ以外は null。 */
        starter: GettingStartedStarter | null
        /** アカウントを選んでいる時だけ。それ以外は null。 */
        firstRun: GettingStartedFirstRun | null
        doneCount: number
        total: number
        allDone: boolean
        /** 進捗帯を閉じたか（本人単位）。**完了判定には使わない。** */
        dismissed: boolean
      }>>(`/api/getting-started?${new URLSearchParams({ ...(accountId ? { account_id: accountId } : {}), ...(version ? { version } : {}) })}`),
    markFirstRunDoneSeen: (accountId: string) =>
      fetchApi<ApiResponse<{ doneSeenAt: string | null; tracked: boolean }>>(
        `/api/getting-started/first-run-done-seen?${new URLSearchParams({ account_id: accountId })}`,
        { method: 'POST' },
      ),
    /** 進捗帯を閉じる。**閉じた日時は帯を出さないためだけの記憶。** */
    dismiss: () =>
      fetchApi<ApiResponse<{ dismissed: boolean }>>('/api/getting-started/dismiss', {
        method: 'POST',
      }),
  },
/** レシピ。台帳 #134。 */
  recipes: {
    /**
     * 組織レシピを作る（owner/admin）。**静的な見本を置くだけ**で、
     * ここでは定義を作らない。
     */
    create: (input: {
      name: string
      purpose: string
      createsSummary: string
      accountId: string
      requiredFeatures?: string[]
      items?: Array<{ kind: string; name: string; note: string }> | null
    }) =>
      fetchApi<ApiResponse<Recipe>>('/api/recipes', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    list: (accountId?: string) =>
      fetchApi<ApiResponse<Recipe[]>>(
        `/api/recipes${accountId ? `?account_id=${encodeURIComponent(accountId)}` : ''}`,
      ),
    get: (id: string, accountId?: string) =>
      fetchApi<ApiResponse<Recipe>>(
        `/api/recipes/${id}${accountId ? `?account_id=${encodeURIComponent(accountId)}` : ''}`,
      ),
    /**
     * 複製する。**冪等キーが要る。** 同じキーで2回呼んでも2回作らない。
     * 途中失敗は全部戻る（部分的に作らない）。
     */
    clone: (id: string, input: { accountId: string; namePrefix?: string | null; expectedVersion: number }, idempotencyKey: string) =>
      fetchApi<ApiResponse<{
        runId: string
        status: 'queued' | 'succeeded' | 'failed' | 'rolled_back'
        createdCount: number
        items?: Array<{ kind: string; target_id: string; name: string }>
      }>>(`/api/recipes/${id}/clone`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(input),
      }),
    run: (runId: string) =>
      fetchApi<ApiResponse<{
        runId: string
        status: 'queued' | 'succeeded' | 'failed' | 'rolled_back'
        createdCount: number
        failureReason: string | null
        items: Array<{ kind: string; target_id: string; name: string }>
      }>>(`/api/recipes/clone-runs/${runId}`),
  },
/*
    設計 ★管理画面 34-4 の正本表。台帳 #134。**直せるのは運営だけ。**

    語をそのまま書かないのは、`design-structure.test.ts` が
    「画面が設計の語を出しているか」を、読み込んだファイルの中身で見ているため。
    ここに書くと、トップバーにしか無いものを画面が出していることになってしまう。
  */
  manualLinks: {
    /** 画面から1つ引く。**開けないと分かっているものは URL が null で返る。** */
    lookup: (screen: string, keyKind: 'screen' | 'task' = 'screen') =>
      fetchApi<ApiResponse<{ key: string; url: string | null; status: 'ok' | 'broken' | 'unset' }>>(
        `/api/manual-links/lookup?screen=${encodeURIComponent(screen)}${keyKind === 'task' ? '&keyKind=task' : ''}`,
      ),
    list: () =>
      fetchApi<ApiResponse<{ items: ManualLink[]; total: number; brokenCount: number }>>(
        '/api/manual-links',
      ),
    update: (key: string, data: { name?: string; url?: string | null; keyKind?: 'screen' | 'task'; expectedVersion: number }) =>
      fetchApi<ApiResponse<ManualLink>>(`/api/manual-links/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    /** いま全部を確かめる。 */
    check: () =>
      fetchApi<ApiResponse<{ checked: number; ok: number; broken: number; unset: number }>>(
        '/api/manual-links/check',
        { method: 'POST' },
      ),
  },
/**
   * 失敗文面の対応表。設計 ★管理画面 34（要件 管理画面-34 §9）。
   *
   * **起動時に一度取って版ごとキャッシュする**（`lib/error-messages.ts`）。
   * 表に無いコードは汎用文面と追跡番号に落とす——原文を出さない。
   */
  errorMessages: {
    list: () =>
      fetchApi<ApiResponse<Array<{
        code: string
        message: string
        nextAction: { kind: 'navigate' | 'retry' | 'contact_admin' | 'none'; target: string | null }
        source: string
        version: number
      }>>>('/api/error-messages'),
  },
}
