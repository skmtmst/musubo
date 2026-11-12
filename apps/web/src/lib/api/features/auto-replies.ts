import { fetchApi } from '../transport/request'
import type {
  ApiResponse,
  AutoReplyRunsResponse,
  AutoReplyDraftInput,
  AutoReplyDraftVersion,
  AutoReplyValidationResult,
  AutoReplyConflict,
  AutoReplyDryRunResult,
  AutoReplyPublishResult,
} from '@line-crm/shared'
import type { AutoReplyConflictPair } from '../types/notifications'

export const autoRepliesMethods = {
  autoReplies: {
    /**
     * 実行の記録（設計 `t7UtYQ` 8-1-H）。
     * **どのルールが、いつ、誰へ、どう返したか。** 設定だけ見ても、
     * 実際に返したのかは分からない。
     */
    runs: (params?: { ruleId?: string; limit?: number; offset?: number; from?: string; to?: string }) => {
      const query = new URLSearchParams()
      if (params?.from) query.set('from', params.from)
      if (params?.to) query.set('to', params.to)
      if (params?.ruleId) query.set('rule_id', params.ruleId)
      if (params?.limit !== undefined) query.set('limit', String(params.limit))
      if (params?.offset !== undefined) query.set('offset', String(params.offset))
      const suffix = query.toString() ? `?${query}` : ''
      return fetchApi<ApiResponse<AutoReplyRunsResponse>>(`/api/auto-reply-runs${suffix}`)
    },
    /*
     * N-081: 失敗した後続処理だけを保存済みの内容でやり直す。
     * LINE への返信は送り直さない。409 は「もう処理中または完了済み」。
     */
    retryRun: (evaluationId: string) =>
      fetchApi<ApiResponse<{ evaluationId: string; retriedCount: number; status: string }>>(
        `/api/auto-reply-runs/${encodeURIComponent(evaluationId)}/retry`,
        { method: 'POST' },
      ),
    /*
      公開までの4段（下書き→検査→競合→試験→公開）。**口はすべて
      `apps/worker/src/routes/auto-replies.ts` に在るものを読むだけ。**
      公開は `Idempotency-Key` を付ける——二度押しで2回公開すると、
      同じ変更が2つの版として台帳に残る。
    */
    createDraft: (
      body: AutoReplyDraftInput,
      /**
       * m26c R556: 応答を失った再送を同じ下書きへ復帰させる確認キー。
       * 省略時は従来どおり作る。
       */
      idempotencyKey?: string,
    ) =>
      fetchApi<ApiResponse<AutoReplyDraftVersion>>('/api/auto-replies/drafts', {
        method: 'POST',
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
        body: JSON.stringify(body),
      }),
    getDraft: (id: string) =>
      fetchApi<ApiResponse<AutoReplyDraftVersion>>(`/api/auto-replies/${id}/draft`),
    saveDraft: (id: string, body: AutoReplyDraftInput & { expectedVersion: number }) =>
      fetchApi<ApiResponse<AutoReplyDraftVersion>>(`/api/auto-replies/${id}/draft`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    validateDraft: (id: string) =>
      fetchApi<ApiResponse<AutoReplyValidationResult>>(`/api/auto-replies/${id}/validate`, {
        method: 'POST',
      }),
    conflicts: (id: string) =>
      fetchApi<ApiResponse<{ conflicts: AutoReplyConflict[]; source?: 'draft' | 'published' }>>(`/api/auto-replies/${id}/conflicts`),
    summary: (accountId: string) =>
      fetchApi<ApiResponse<{
        conflicts: AutoReplyConflictPair[];
        conflictCount: number;
        receiveSourceCounts: Array<{ source: string; count: number }> | null;
        matchedLast28Days: number | null;
        dispatchStopped: boolean | null;
      }>>(`/api/auto-replies/conflicts?accountId=${encodeURIComponent(accountId)}`),
    testDraft: (id: string, body: {
      friendId: string;
      incomingText: string;
      messageKind?: string;
      occurredAt?: string;
    }) => fetchApi<ApiResponse<AutoReplyDryRunResult>>(`/api/auto-replies/${id}/test`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    publishDraft: (
      id: string,
      body: { acknowledgedConflictIds: string[] },
      idempotencyKey: string,
    ) => fetchApi<ApiResponse<AutoReplyPublishResult>>(`/api/auto-replies/${id}/publish`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    }),
    /*
     * 機能08 点検 E-01: 専用の停止口。理由（任意）を添えて止めると、
     * いつ・誰が・なぜ止めたかが残る。確認キーは呼び出し側で都度振る。
     */
    stop: (id: string, body: { reason?: string | null; expectedVersion?: number }, idempotencyKey: string) =>
      fetchApi<ApiResponse<{
        id: string;
        isActive: boolean;
        stoppedAt: string | null;
        stoppedByStaffId: string | null;
        stoppedByStaffName: string | null;
        stopReason: string | null;
      }>>(`/api/auto-replies/${id}/stop`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(body),
      }),
    /*
     * B 元に戻す: 削除の取り消し。戻した直後は停止のまま。再開は update で行う。
     * 画面の Toast から呼ぶ想定（各機能の担当が配線する）。
     */
    restore: (id: string) =>
      fetchApi<ApiResponse<{
        id: string;
        isActive: boolean;
        stoppedAt: string | null;
        stoppedByStaffId: string | null;
        stoppedByStaffName: string | null;
        stopReason: string | null;
      }>>(`/api/auto-replies/${id}/restore`, {
        method: 'POST',
      }),
    list: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?accountId=' + encodeURIComponent(params.accountId) : ''
      return fetchApi<ApiResponse<Array<{
        id: string;
        keyword: string;
        matchType: 'exact' | 'contains';
        responseType: string;
        responseContent: string;
        templateId: string | null;
        lineAccountId: string | null;
        isActive: boolean;
        activeFrom: string | null;
        activeUntil: string | null;
        cooldownMinutes: number | null;
        skipWhenOperatorActive: boolean;
        priority: number;
        messageKinds: string[] | null;
        receiveSources: Array<'line' | 'email'>;
        actions: unknown[] | null;
        responseWeekdays: number[] | null;
        responseHolidayRule: string | null;
        oncePerFriend: boolean;
        keywords: unknown[] | null;
        friendConditions: unknown | null;
        /** 157: キーワードを問わず、届いたメッセージすべてに応答する。 */
        respondToAll: boolean;
        /** 158: 管理用の名前。 */
        name: string | null;
        /** 158: 'any'（どれか1つ）か 'all'（すべて）。 */
        keywordMatchMode: string;
        /** フォルダ。分けていなければ null。 */
        folderId: string | null;
        /** 運用者だけが読むメモ。友だちへは出ない。 */
        internalMemo: string | null;
        /** 273: 'draft'（未公開）| 'published' | 'stopped'。 */
        lifecycleStatus: string;
        /** 機能08 点検 E-01: 最後に停止した記録。止めたことが無ければ null。 */
        stoppedAt: string | null;
        stoppedByStaffId: string | null;
        stoppedByStaffName: string | null;
        stopReason: string | null;
        /** 152: 当たった回数（今月・累計）。一覧でだけ入る。 */
        hits?: { period: number; total: number };
        /** 実行台帳で成功を確認できた後続処理の累計。 */
        actionExecutionCount?: number | null;
        /** 同じ受信に当たり得る、有効な別ルールの数。 */
        conflictAttentionCount?: number | null;
        createdAt: string;
        effectiveAccounts?: Array<{
          accountId: string;
          accountName: string;
          status: 'reply' | 'silent' | 'not_applicable';
          via: 'inline' | 'automation' | null;
        }>;
      }>>>('/api/auto-replies' + query)
    },
    get: (id: string) =>
      fetchApi<ApiResponse<{
        id: string;
        keyword: string;
        matchType: 'exact' | 'contains';
        responseType: string;
        responseContent: string;
        templateId: string | null;
        lineAccountId: string | null;
        isActive: boolean;
        confirmationRevision: number;
        activeFrom: string | null;
        activeUntil: string | null;
        cooldownMinutes: number | null;
        skipWhenOperatorActive: boolean;
        priority: number;
        messageKinds: string[] | null;
        receiveSources: Array<'line' | 'email'>;
        actions: unknown[] | null;
        responseWeekdays: number[] | null;
        responseHolidayRule: string | null;
        oncePerFriend: boolean;
        keywords: unknown[] | null;
        friendConditions: unknown | null;
        respondToAll: boolean;
        name: string | null;
        keywordMatchMode: string;
        /** フォルダ。分けていなければ null。 */
        folderId: string | null;
        /** 運用者だけが読むメモ。友だちへは出ない。 */
        internalMemo: string | null;
        /** 273: 'draft'（未公開）| 'published' | 'stopped'。 */
        lifecycleStatus: string;
        /** 機能08 点検 E-01: 最後に停止した記録。 */
        stoppedAt: string | null;
        stoppedByStaffId: string | null;
        stoppedByStaffName: string | null;
        stopReason: string | null;
        createdAt: string;
      }>>(`/api/auto-replies/${id}`),
    create: (body: {
      keyword: string;
      matchType?: 'exact' | 'contains';
      responseType?: string;
      responseContent?: string;
      templateId?: string | null;
      lineAccountId?: string | null;
      /**
       * AUTOREPLY-08: 省略・false は止まった状態で作る。有効化は
       * true の明示指定か、保存後の再開・公開操作だけ。
       */
      isActive?: boolean;
      /** JST の "HH:MM"。null で時間帯を問わない */
      activeFrom?: string | null;
      activeUntil?: string | null;
      /** この分数は同じ相手へ自動応答を返さない。null/0 で抑制しない */
      cooldownMinutes?: number | null;
      /** 担当者が対応中のトークでは返さない */
      skipWhenOperatorActive?: boolean;
      /** 評価順。小さいほど先に見る */
      priority?: number;
      /** 対象にするメッセージ種別。null で全部 */
      messageKinds?: string[] | null;
      receiveSources?: Array<'line' | 'email'>;
      /** 151: 応答したときに順に実行すること。 */
      actions?: unknown[] | null;
      /** 151: 応答する曜日（0=日 … 6=土）。null で曜日を問わない */
      responseWeekdays?: number[] | null;
      /** 151: 'ignore' | 'include' | 'exclude' */
      responseHolidayRule?: string | null;
      /** 151: 1人につき1回だけ応答する */
      oncePerFriend?: boolean;
      /** 151: キーワードの複数行 */
      keywords?: unknown[] | null;
      /** 友だちの絞り込み（一斉配信・シナリオと同じ形） */
      friendConditions?: unknown | null;
      /** 157: キーワードを問わず応答する。 */
      respondToAll?: boolean;
      /** 158: 管理用の名前。 */
      name?: string | null;
      /** 158: 'any'（どれか1つ）か 'all'（すべて）。 */
      normalizeKeywords?: boolean
      keywordMatchMode?: 'any' | 'all';
      /** フォルダ。 */
      folderId?: string | null;
      /** 運用者だけが読むメモ。友だちへは出ない。1000字まで。 */
      internalMemo?: string | null;
    },
    /**
     * m26c R570: 応答を失った再送を同じ行へ復帰させる確認キー。
     * 省略時は従来どおり作る。
     */
    idempotencyKey?: string) =>
      fetchApi<ApiResponse<{ id: string }>>('/api/auto-replies', {
        method: 'POST',
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
        body: JSON.stringify(body),
      }),
    update: (id: string, body: {
      keyword?: string;
      matchType?: 'exact' | 'contains';
      responseType?: string;
      responseContent?: string;
      templateId?: string | null;
      lineAccountId?: string | null;
      isActive?: boolean;
      activeFrom?: string | null;
      activeUntil?: string | null;
      cooldownMinutes?: number | null;
      skipWhenOperatorActive?: boolean;
      priority?: number;
      messageKinds?: string[] | null;
      receiveSources?: Array<'line' | 'email'>;
      /** 151: 応答したときに順に実行すること。 */
      actions?: unknown[] | null;
      /** 151: 応答する曜日（0=日 … 6=土）。null で曜日を問わない */
      responseWeekdays?: number[] | null;
      /** 151: 'ignore' | 'include' | 'exclude' */
      responseHolidayRule?: string | null;
      /** 151: 1人につき1回だけ応答する */
      oncePerFriend?: boolean;
      /** 151: キーワードの複数行 */
      keywords?: unknown[] | null;
      /** 友だちの絞り込み（一斉配信・シナリオと同じ形） */
      friendConditions?: unknown | null;
      /** 157: キーワードを問わず応答する。 */
      respondToAll?: boolean;
      /** 158: 管理用の名前。 */
      name?: string | null;
      /** 158: 'any'（どれか1つ）か 'all'（すべて）。 */
      normalizeKeywords?: boolean
      keywordMatchMode?: 'any' | 'all';
      /** フォルダ。 */
      folderId?: string | null;
      /** 運用者だけが読むメモ。省略は変更なし、null/'' で消す。 */
      internalMemo?: string | null;
    }) =>
      fetchApi<ApiResponse<{
        id: string;
        /**
         * m26c R569: 公開中ルールの内容変更は稼働定義を変えず下書きへ保存する。
         * true のとき稼働中は無変更で、下書き版に載った。公開フローへ案内する。
         */
        draftSaved?: boolean;
        draftVersionNumber?: number;
      }>>(`/api/auto-replies/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/auto-replies/${id}`, {
        method: 'DELETE',
      }),
  },
  autoReplyUnmatched: {
    get: (accountId:string)=>fetchApi<ApiResponse<import('@line-crm/shared').AutoReplyUnmatchedSettings>>(`/api/auto-replies/unmatched-settings?${new URLSearchParams({lineAccountId:accountId})}`),
    save: (accountId:string,body:import('@line-crm/shared').AutoReplyUnmatchedInput)=>fetchApi<ApiResponse<import('@line-crm/shared').AutoReplyUnmatchedSettings>>(`/api/auto-replies/unmatched-settings?${new URLSearchParams({lineAccountId:accountId})}`,{method:'PUT',body:JSON.stringify(body)}),
  },
}
