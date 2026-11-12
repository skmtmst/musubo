import { fetchApi } from '../transport/request'
import type { ApiResponse, BroadcastBubble } from '@line-crm/shared'
import type { TemplateQuestion } from '../types/templates'

export const templatesMethods = {
  templates: {
    list: (category?: string, accountId?: string) => {
      const query = new URLSearchParams()
      if (category) query.set('category', category)
      if (accountId) query.set('account_id', accountId)
      const suffix = query.size ? `?${query.toString()}` : ''
      return fetchApi<ApiResponse<Array<{
        id: string;
        confirmationRevision: number;
        accountId: string | null;
        name: string;
        category: string;
        messageType: string;
        messageContent: string;
        messageBubbles?: BroadcastBubble[] | null;
        /** R194: 管理一覧の抜粋・検索が読む最新の下書き本文。公開版だけのときは null。 */
        draftMessageContent: string | null;
        draftMessageBubbles?: BroadcastBubble[] | null;
        folderId: string | null;
        question: TemplateQuestion | null;
        questionStatus: 'draft' | 'published';
        usageCount: number;
        /** 162: 選択肢が押された回数の合計。押される仕掛けが無いものは 0。 */
        tapCount: number;
        /** Monthly and lifetime delivery totals. null when unavailable. */
        monthlySendCount: number | null;
        totalSendCount: number | null;
        /** 347: 公開待ちの下書きがあるか。 */
        hasDraft: boolean;
        /** 347: 公開版の版番号。未公開は0。 */
        publishedVersion: number;
        /** 347: 最後に公開した日時。未公開はnull。 */
        publishedAt: string | null;
        /** 347: いまの下書き版。公開で0に戻る。 */
        draftRevision: number;
        createdAt: string;
        updatedAt: string;
      }>>>(
        `/api/templates${suffix}`,
      )
    },
    /*
      PERF-12: 選択画面用の区切り取得。検索・フォルダ・分類をサーバーで
      絞ってから1区画だけ返す。folderCounts を立てるとフォルダ別件数も
      添えて返る。
    */
    listPage: (params: {
      accountId?: string;
      q?: string;
      folderId?: string;
      quick?: 'frequent' | 'reservation' | 'ec';
      messageType?: string;
      textOnly?: boolean;
      page?: number;
      limit?: number;
      folderCounts?: boolean;
    }) => {
      const query = new URLSearchParams()
      if (params.accountId) query.set('account_id', params.accountId)
      if (params.q) query.set('q', params.q)
      if (params.folderId) query.set('folder_id', params.folderId)
      if (params.quick) query.set('quick', params.quick)
      if (params.messageType) query.set('message_type', params.messageType)
      if (params.textOnly) query.set('text_only', '1')
      query.set('page', String(params.page ?? 1))
      query.set('limit', String(params.limit ?? 100))
      if (params.folderCounts) query.set('folder_counts', '1')
      return fetchApi<ApiResponse<{
        items: Array<{
          id: string;
          accountId: string | null;
          name: string;
          category: string;
          messageType: string;
          messageContent: string;
        messageBubbles?: BroadcastBubble[] | null;
          folderId: string | null;
          question: TemplateQuestion | null;
          questionStatus: 'draft' | 'published';
          usageCount: number;
          tapCount: number;
          monthlySendCount: number | null;
          totalSendCount: number | null;
          /** R194: 最新の下書き本文（管理一覧用）。公開版だけのときは null。 */
          draftMessageContent: string | null;
          hasDraft: boolean;
          publishedVersion: number;
          publishedAt: string | null;
          draftRevision: number;
          createdAt: string;
          updatedAt: string;
        }>;
        total: number;
        limit: number;
        folderCounts?: Record<string, number>;
      }>>(`/api/templates?${query.toString()}`)
    },
    get: (id: string) =>
      fetchApi<ApiResponse<{
        id: string;
        accountId: string | null;
        name: string;
        category: string;
        messageType: string;
        messageContent: string;
        messageBubbles?: BroadcastBubble[] | null;
        question: TemplateQuestion | null;
        questionStatus: 'draft' | 'published';
        folderId: string | null;
        /** 162: 選択肢を押したときの動き。{ パネル番号: { 選択肢番号: [...] } } */
        carouselActions: unknown | null;
        /** 162: 'none'（制限なし）／'once'（全体で1回） */
        carouselTapLimitMode: string;
        /** 162: 制限を超えたときに返すテキスト。 */
        carouselTapLimitText: string | null;
        usedBy: {
          autoReplies: Array<{ id: string; keyword: string; matchType: 'exact' | 'contains'; lineAccountId: string | null; templateVersion: number | null }>;
          automations: Array<{ id: string; name: string; eventType: string }>;
          scenarioSteps: Array<{ scenarioId: string; scenarioName: string; stepId: string; stepOrder: number; displayOrder?: number; templateVersion: number | null }>;
          reminderSteps: Array<{ reminderId: string; reminderName: string; stepId: string }>;
          richMenuAreas: Array<{ groupId: string; groupName: string; pageName: string; areaId: string; label: string | null }>;
          trackedLinks: Array<{ id: string; name: string }>;
          /** 467: 一斉配信の参照（送った時の版のまま）。 */
          broadcasts: Array<{ broadcastId: string; title: string; status: string; scheduledAt: string | null; templateVersionNumber: number | null; referenceMode: 'fixed' | 'latest' }>;
          /** R347: 旧公開版に固定された送信待ち・取消ずみの登録。 */
          reminderEnrollments?: Array<{ enrollmentId: string; reminderId: string; reminderName: string; versionNumber: number; enrollmentStatus: string; targetDate: string }>;
        };
        createdAt: string;
        updatedAt: string;
        /** 347: 公開待ちの下書きがあるか。 */
        hasDraft: boolean;
        /** 347: 公開版の版番号。未公開は0。 */
        publishedVersion: number;
        /** 347: 最後に公開した日時。未公開はnull。 */
        publishedAt: string | null;
        /** 347: いまの下書き版。公開で0に戻る。 */
        draftRevision: number;
      }>>(
        `/api/templates/${id}`,
      ),
    /**
     * 独立審査(指摘6): 下書きを公開版へ写す。確認キーは自動で振る。
     * 詳細口が返す publishedVersion・draftRevision をそのまま渡す。
     */
    publish: (id: string, data: { expectedVersion: number; expectedDraftRevision: number }) =>
      fetchApi<ApiResponse<{
        id: string;
        accountId: string | null;
        messageType: string;
        messageContent: string;
        messageBubbles?: BroadcastBubble[] | null;
        publishedVersion: number;
        publishedAt: string | null;
        published: boolean;
        replayed: boolean;
        hasDraft: boolean;
        draftRevision: number;
      }>>(
        `/api/templates/${id}/publish`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify(data),
        },
      ),
    create: (data: {
      accountId: string
      name: string
      category: string
      messageType: string
      messageContent: string
      question?: TemplateQuestion | null
      questionStatus?: 'draft' | 'published'
      /** 162: 選択肢を押したときの動き。 */
      carouselActions?: unknown | null
      /** 162: 'none'（制限なし）／'once'（全体で1回） */
      carouselTapLimitMode?: 'none' | 'once'
      /** 162: 制限を超えたときに返すテキスト。 */
      carouselTapLimitText?: string | null
      /** 置き場。省略・null は未分類。 */
      folderId?: string | null
    }) =>
      fetchApi<ApiResponse<{ id: string; name: string; category: string; messageType: string; messageContent: string;
        messageBubbles?: BroadcastBubble[] | null; publishedVersion: number; draftRevision: number; folderId: string | null; createdAt: string; updatedAt: string }>>(
        '/api/templates',
        { method: 'POST', body: JSON.stringify(data) },
      ),
    update: (
      id: string,
      data: Partial<{ name: string; category: string; messageType: string; messageContent: string;
        messageBubbles?: BroadcastBubble[] | null; question: TemplateQuestion | null; questionStatus: 'draft' | 'published' }> & {
        expectedVersion?: number
        expectedDraftRevision?: number
        carouselActions?: unknown | null
        carouselTapLimitMode?: 'none' | 'once'
        carouselTapLimitText?: string | null
        /**
         * 置き場。**`null` は「未分類へ戻す」。** 送らなければいまのまま。
         * 消えたフォルダを指すと 422 で断られる（黙って未分類にはならない）。
         */
        folderId?: string | null
      },
    ) =>
      fetchApi<ApiResponse<{ id: string; name: string; category: string; messageType: string; messageContent: string;
        messageBubbles?: BroadcastBubble[] | null; publishedVersion: number; draftRevision: number; folderId: string | null; createdAt: string; updatedAt: string }>>(
        `/api/templates/${id}`,
        { method: 'PUT', body: JSON.stringify(data) },
      ),
    delete: (id: string, expectedDraftRevision?: number) =>
      fetchApi<ApiResponse<null>>(`/api/templates/${id}${expectedDraftRevision === undefined ? '' : `?expectedDraftRevision=${expectedDraftRevision}`}`, { method: 'DELETE' }),
    bulkDelete: (templates: Array<{ id: string; expectedRevision: number }>) =>
      fetchApi<ApiResponse<null>>('/api/templates/bulk-delete', { method: 'POST', body: JSON.stringify({ templates }) }),
    usages: (id: string) =>
      fetchApi<ApiResponse<{
        autoReplies: Array<{ id: string; keyword: string; lineAccountId: string | null; templateVersion: number | null }>;
        automations: Array<{ id: string; name: string; eventType: string }>;
        scenarioSteps: Array<{ scenarioId: string; scenarioName: string; stepId: string; stepOrder: number; displayOrder?: number; templateVersion: number | null }>;
        reminderSteps: Array<{ reminderId: string; reminderName: string; stepId: string }>;
        richMenuAreas: Array<{ groupId: string; groupName: string; pageName: string; areaId: string; label: string | null }>;
        trackedLinks: Array<{ id: string; name: string }>;
        /** 467: 一斉配信の参照（送った時の版のまま）。 */
        broadcasts: Array<{ broadcastId: string; title: string; status: string; scheduledAt: string | null; templateVersionNumber: number | null; referenceMode: 'fixed' | 'latest' }>;
        /** R347: 旧公開版に固定された送信待ち・取消ずみの登録。 */
        reminderEnrollments: Array<{ enrollmentId: string; reminderId: string; reminderName: string; versionNumber: number; enrollmentStatus: string; targetDate: string }>;
      }>>(`/api/templates/${id}/usages`),
    /**
     * 466: 版の履歴。新しい版から返る。status は in_use / reserved / past。
     */
    versions: (id: string) =>
      fetchApi<ApiResponse<Array<{
        versionNumber: number;
        status: 'in_use' | 'reserved' | 'past';
        messageType: string;
        messageContent: string;
        messageBubbles?: BroadcastBubble[] | null;
        carouselActions: unknown | null;
        carouselTapLimitMode: string | null;
        carouselTapLimitText: string | null;
        question: TemplateQuestion | null;
        questionStatus: string | null;
        effectiveFrom: string | null;
        createdAt: string;
        createdByStaffId: string | null;
        creatorName: string | null;
        creatorNameSource: 'current_staff_profile' | null;
      }>>>(`/api/templates/${id}/versions`),
    /**
     * 466: この版に戻す。過去の版は変えず、その中身で新しい版を作る。
     * 確認キーは自動で振る。詳細口の publishedVersion をそのまま渡す。
     */
    revert: (id: string, data: { versionNumber: number; expectedVersion: number }) =>
      fetchApi<ApiResponse<{
        id: string;
        publishedVersion: number;
        hasDraft: boolean;
      }>>(
        `/api/templates/${id}/revert`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify(data),
        },
      ),
  },
  messageTemplates: {
    list: () =>
      fetchApi<ApiResponse<Array<{
        id: string
        name: string
        messageType: string
        messageContent: string
        createdAt: string
        updatedAt: string
      }>>>('/api/message-templates'),
  },
}
