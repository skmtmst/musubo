import { readApiError } from '@line-crm/shared'
import type { RichMenuGroupListOptions, ApiResponse } from '@line-crm/shared'
import { fetchApi } from '../transport/request'
import type {
  RichMenuGroupListPage,
  RichMenuGroupListItem,
  RichMenuAreaResponse,
  RichMenuAreaPayload,
  RichMenuTapStats,
} from '../types/rich-menus'
import type { SegmentCondition } from '../../segment-condition'
import type {
  RichMenuTargetPreview,
  RichMenuScheduleInput,
  RichMenuDeleteImpact,
  RichMenuPublishRunsResponse,
  RichMenuTestApplyItem,
  RichMenuTestApplyUserMenuAction,
} from '../types/publication'
import { API_URL, getCsrfToken } from '../transport/session'
import { extractApiErrorCode, fetchWithNetworkMessage, responseApiError } from '../transport/errors'

export const richMenusMethods = {
  richMenuGroups: {
    listPage: (accountId: string, input: RichMenuGroupListOptions = {}) => {
      const query = new URLSearchParams({ accountId })
      query.set('page', String(input.page ?? 1))
      query.set('limit', String(input.limit ?? 50))
      if (input.query) query.set('query', input.query)
      if (input.folderId) query.set('folderId', input.folderId)
      if (input.filter) query.set('filter', input.filter)
      if (input.sort && input.sort !== 'priority') query.set('sort', input.sort)
      return fetchApi<ApiResponse<RichMenuGroupListPage>>(`/api/rich-menu-groups?${query}`)
    },
    list: async (accountId: string): Promise<ApiResponse<RichMenuGroupListItem[]>> => {
      const response = await fetchApi<ApiResponse<RichMenuGroupListPage>>(
        `/api/rich-menu-groups?accountId=${encodeURIComponent(accountId)}&page=1&limit=200`,
      )
      return response.success
        ? { success: true, data: response.data.items }
        : response
    },

    get: (groupId: string) =>
      fetchApi<ApiResponse<{
        id: string;
        accountId: string;
        name: string;
        chatBarText: string;
        size: 'large' | 'compact';
        defaultPageId: string | null;
        isDefaultForAll: boolean;
        status: 'draft' | 'published';
        publishingAt: string | null;
        publicationGeneration?: number;
        confirmationRevision?: number;
        targetingCondition: string | null;
        targetingPriority: number;
        targetingEnabled: boolean;
        folderId: string | null;
        /** トークを開いたときメニューを出した状態にするか（公開する形に含まれる）。 */
        defaultOpen: boolean;
        /** M951: 保存時に送り返す版。古い版での保存は 409 で止まる。 */
        version: number;
        publishingGeneration: number;
        createdAt: string;
        updatedAt: string;
        pages: Array<{
          id: string;
          orderIndex: number;
          name: string;
          aliasId: string;
          lineRichmenuId: string | null;
          imageR2Key: string | null;
          imageContentType: string | null;
          areas: RichMenuAreaResponse[];
        }>;
      }>>(`/api/rich-menu-groups/${groupId}`),

    previewTargets: (groupId: string, conditions?: SegmentCondition | null) =>
      fetchApi<ApiResponse<RichMenuTargetPreview>>(
        `/api/rich-menu-groups/${groupId}/preview-targets`,
        {
          method: 'POST',
          body: JSON.stringify(conditions === undefined ? {} : { conditions }),
        },
      ),

    schedule: (groupId: string, input: RichMenuScheduleInput, idempotencyKey: string) =>
      fetchApi<ApiResponse<{ id: string; status: string }>>(
        `/api/rich-menu-groups/${groupId}/schedule`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify(input),
        },
      ),

    listSchedules: (groupId: string) =>
      fetchApi<ApiResponse<Array<{
        id: string
        mode: 'scheduled' | 'period'
        startsAt: string
        endsAt: string | null
        restoreGroupId: string | null
        restoreDefaultState: 'captured' | 'no_default' | null
        status: string
        attemptCount: number
        nextRetryAt: string | null
        lastErrorCode: string | null
        createdAt: string
      }>>>(`/api/rich-menu-groups/${groupId}/schedules`),

    cancelSchedule: (groupId: string, scheduleId: string) =>
      fetchApi<ApiResponse<{ id: string; status: string }>>(
        `/api/rich-menu-groups/${groupId}/schedules/${scheduleId}/cancel`,
        { method: 'POST' },
      ),

    create: (input: {
      accountId: string;
      name: string;
      chatBarText: string;
      size: 'large' | 'compact';
      /** #502中: 作成直後のフォルダ付け2口目をなくすため作成口で決める。 */
      folderId?: string | null;
      /** N-161: 最初に見せるページの orderIndex。 */
      defaultPageIndex?: number;
      /** N-161: 「すべての友だちの既定にする」か。 */
      isDefaultForAll?: boolean;
      /** N-161: 出し分け。有効にするなら targetingCondition が必須。 */
      targetingEnabled?: boolean;
      targetingCondition?: string | null;
      targetingPriority?: number;
      /** V8: トークを開いたときメニューを出した状態にするか。 */
      defaultOpen?: boolean;
      /** N-164: 登録メディアを既定ページの画像として使う。 */
      imageMediaId?: string;
      pages: Array<{
        id?: string;
        name: string;
        orderIndex: number;
        areas: RichMenuAreaPayload[];
      }>;
    }) =>
      fetchApi<ApiResponse<{ id: string; pages: Array<{ id: string }> }>>('/api/rich-menu-groups', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    /** #502中: 優先順の入替を1口でそろえる。全件PATCHの並列投げの置き換え。 */
    reorderPriorities: (accountId: string, orderedIds: string[]) =>
      fetchApi<ApiResponse<{ updated: number }>>('/api/rich-menu-groups/reorder-priorities', {
        method: 'POST',
        body: JSON.stringify({ accountId, orderedIds }),
      }),

    update: (groupId: string, input: {
      /** M951: 読んだときの版。必須。古ければ 409。 */
      expectedVersion: number;
      name?: string;
      chatBarText?: string;
      isDefaultForAll?: boolean;
      /** 出し分けの条件（SegmentCondition の JSON）。null で解除。 */
      targetingCondition?: string | null;
      targetingPriority?: number;
      targetingEnabled?: boolean;
      /** 159: フォルダ。null で未分類に戻す。 */
      folderId?: string | null;
      /** 160: 自分で決める並び順。 */
      displayOrder?: number;
      /** V8: トークを開いたときメニューを出した状態にするか。 */
      defaultOpen?: boolean;
      pages?: Array<{
        id?: string;
        name: string;
        orderIndex: number;
        areas: RichMenuAreaPayload[];
      }>;
    }) =>
      fetchApi<ApiResponse<{ id: string }>>(`/api/rich-menu-groups/${groupId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),

    /** 押された回数。期間を省くとその月（日本時間）。 */
    tapStats: (accountId: string, range?: { from?: string; to?: string }) => {
      const params = new URLSearchParams({ accountId })
      if (range?.from) params.set('from', range.from)
      if (range?.to) params.set('to', range.to)
      return fetchApi<ApiResponse<RichMenuTapStats>>(
        `/api/rich-menu-groups/tap-stats?${params.toString()}`,
      )
    },

    deleteImpact: (groupId: string) =>
      fetchApi<ApiResponse<RichMenuDeleteImpact>>(
        `/api/rich-menu-groups/${groupId}/delete-impact`,
      ),

    delete: (groupId: string, expectedVersion?: number) =>
      fetchApi<ApiResponse<null>>(`/api/rich-menu-groups/${groupId}${expectedVersion === undefined ? '' : `?expectedVersion=${expectedVersion}`}`, { method: 'DELETE' }),

    publish: (groupId: string, idempotencyKey: string, confirmation?:{expectedVersion:number;expectedPublishGeneration:number;expectedImages:Array<{orderIndex:number;imageR2Key:string|null;imageContentType:string|null}>}) =>
      fetchApi<ApiResponse<{ pages: Array<{ pageId: string; newRichMenuId: string }> }>>(
        `/api/rich-menu-groups/${groupId}/publish`,
        { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey },...(confirmation?{body:JSON.stringify(confirmation)}:{}) },
      ),

    unpublish: (groupId: string, confirmation?:{expectedVersion:number;expectedPublishGeneration:number;expectedIsDefaultForAll:boolean;expectedPages:Array<{id:string;orderIndex:number;lineRichMenuId:string|null}>}) =>
      fetchApi<ApiResponse<{
        pages: Array<{ pageId: string; clearedRichMenuId: string | null }>;
        warnings: string[];
      }>>(`/api/rich-menu-groups/${groupId}/unpublish`, { method: 'POST',...(confirmation?{body:JSON.stringify(confirmation)}:{}) }),

    /** N-151: 公開runの履歴と「いま出ている版」。下書きとの差分フラグも返す。 */
    publishRuns: (groupId: string) =>
      fetchApi<ApiResponse<RichMenuPublishRunsResponse>>(
        `/api/rich-menu-groups/${groupId}/publish-runs`,
      ),

    /** N-151: 失敗したrunだけを、保存された版のまま再試行する。 */
    retryPublishRun: (groupId: string, requestId: string) =>
      fetchApi<ApiResponse<{ pages: Array<{ pageId: string; newRichMenuId: string }> }>>(
        `/api/rich-menu-groups/${groupId}/publish-runs/${requestId}/retry`,
        { method: 'POST' },
      ),

    /** N-151: DBとLINEのずれを点検（dryRun）し、明示したときだけ直す。 */
    reconcile: (groupId: string, dryRun: boolean) =>
      fetchApi<ApiResponse<{
        dryRun: boolean;
        diffs: Array<{
          kind: string; detail: string; pageId?: string; richMenuId?: string;
          /** K-2: ずれの種類ごとの直し方（1つ）。 */
          fix: { label: string; action: string };
        }>;
        applied?: number;
        failed?: Array<{ diff: { kind: string; detail: string }; error: string }>;
        /** K-2: 自動で直さない分（取り込み候補）。運用者が画面で直す。 */
        unapplied?: Array<{ diff: { kind: string; detail: string }; reason: string }>;
        runId?: string;
      }>>(`/api/rich-menu-groups/${groupId}/reconcile`, {
        method: 'POST',
        body: JSON.stringify({ dryRun }),
      }),

    /** K-1: 最新の公開実行の4段（画像・メニュー・割り当て・片付け）。 */
    publishProgress: (groupId: string) =>
      fetchApi<ApiResponse<{
        run: {
          id: string; mode: string; status: string;
          startedAt: string; completedAt: string | null;
        } | null;
        steps: Array<{
          key: string; label: string;
          status: 'done' | 'failed' | 'running' | 'pending' | 'skipped';
        }>;
        message: string | null;
      }>>(`/api/rich-menu-groups/${groupId}/publish-progress`),

    /** O-1: 公開前の確認（自前検査・実機・版）。LINE検査は別口で通す。 */
    prepublishCheck: (groupId: string) =>
      fetchApi<ApiResponse<{
        fingerprint: string;
        pageCount: number;
        maxPages: number;
        selfCheck: { ok: boolean; message: string };
        deviceConfirmed: boolean;
        deviceConfirmedAt: string | null;
        versionNumber: number | null;
      }>>(`/api/rich-menu-groups/${groupId}/prepublish-check`),

    /** O-1: 公開する形のままLINEの検査APIに通す。下書きもLINEも変えない。 */
    validatePublish: (groupId: string) =>
      fetchApi<ApiResponse<{
        checks: Array<{ key: 'self' | 'line'; ok: boolean; message: string }>;
      }>>(`/api/rich-menu-groups/${groupId}/validate`, { method: 'POST' }),

    /** O-1: 実機で見た記録。今の下書きにひもづく。 */
    confirmDevice: (groupId: string) =>
      fetchApi<ApiResponse<{ confirmedAt: string; fingerprint: string }>>(
        `/api/rich-menu-groups/${groupId}/device-confirm`,
        { method: 'POST' },
      ),

    /** N-154: メニュー全体を別IDの下書きとして複製する。 */
    duplicate: (groupId: string, idempotencyKey: string, input?: { name?: string }) =>
      fetchApi<ApiResponse<{ id: string }>>(
        `/api/rich-menu-groups/${groupId}/duplicate`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify(input ?? {}),
        },
      ),

    /** N-156: staffでも読める影響人数。合計だけを返し、個人や条件は含まない。 */
    audienceSummary: (groupId: string) =>
      fetchApi<ApiResponse<{
        total: { value: number; state: 'available' | 'unavailable'; reason: string | null };
        targeted: { value: number; state: 'available' | 'unavailable'; reason: string | null };
        excluded: { value: number | null; state: 'available' | 'unavailable'; reason: string | null };
        effective: { value: number | null; state: 'available' | 'unavailable'; reason: string | null };
      }>>(`/api/rich-menu-groups/${groupId}/audience-summary`),

    /** N-152: 本人LINEへのテスト適用の状態。連携済みか・適用中か・宛先を返す。 */
    testApplyState: (groupId: string) =>
      fetchApi<ApiResponse<{
        linked: boolean;
        confirmationRevision?: number;
        destinationToken?: string | null;
        linkGuidance: string | null;
        /** 宛先の明示。連携済みの本人LINEだけ。未連携なら null。 */
        destination: { staffName: string | null; lineUserIdMasked: string } | null;
        active: RichMenuTestApplyItem | null;
        recent: RichMenuTestApplyItem[];
      }>>(`/api/rich-menu-groups/${groupId}/test-apply`),

    /** N-152: 本人確認済みLINEへテスト適用する。confirm: true が必須。 */
    testApply: (groupId: string, idempotencyKey: string, expected?: { expectedConfirmationRevision: number; expectedDestinationToken: string }) =>
      fetchApi<ApiResponse<{ id: string; status: string }>>(
        `/api/rich-menu-groups/${groupId}/test-apply`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({ confirm: true, ...expected }),
        },
      ),

    /** N-152: テスト適用を取り消して適用前のメニューへ戻す。冪等。 */
    testApplyRevert: (groupId: string, idempotencyKey: string, applyId?: string) =>
      fetchApi<ApiResponse<
        RichMenuTestApplyItem & { userMenuAction?: RichMenuTestApplyUserMenuAction }
      >>(
        `/api/rich-menu-groups/${groupId}/test-apply/revert`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({ confirm: true, ...(applyId ? { applyId } : {}) }),
        },
      ),

    external: (accountId: string) =>
      fetchApi<ApiResponse<{
        currentDefault: string | null;
        lineMenus: Array<{
          richMenuId: string;
          name: string;
          chatBarText: string;
          size: { width: number; height: number };
          areasCount: number;
          areas: Array<{
            bounds: {
              x: number | null;
              y: number | null;
              width: number | null;
              height: number | null;
            };
            action: {
              type: string;
              label: string | null;
              url: string | null;
              text: string | null;
              displayText: string | null;
              richMenuAliasId: string | null;
              supported: boolean;
              unsupportedReason: 'unsupported_or_incomplete_action' | null;
            };
          }>;
          isCurrentDefault: boolean;
          adminManaged: boolean;
          adminInfo: {
            groupId: string;
            groupName: string;
            pageName: string;
            groupStatus: 'draft' | 'published';
          } | null;
        }>;
      }>>(`/api/rich-menu-groups/external?accountId=${encodeURIComponent(accountId)}`),

    deleteExternal: (richMenuId: string, accountId: string) =>
      fetchApi<ApiResponse<null>>(
        `/api/rich-menu-groups/external/${richMenuId}?accountId=${encodeURIComponent(accountId)}`,
        { method: 'DELETE' },
      ),

    importFromLine: (richMenuId: string, accountId: string) =>
      fetchApi<ApiResponse<{ id: string; name: string }>>(
        `/api/rich-menu-groups/import?accountId=${encodeURIComponent(accountId)}&richMenuId=${encodeURIComponent(richMenuId)}`,
        { method: 'POST' },
      ),

    // LINE 上の rich menu 画像を admin proxy 経由で取得する URL。
    // <img src> として使う。staff 認証必要 (admin 経由なので browser fetch すると
    // クッキーや Authorization が必要 — 代わりに admin が cache-busting できる
    // タイムスタンプを付けるパターンで利用)。
    externalImageUrl: (richMenuId: string, accountId: string) =>
      `${API_URL}/api/rich-menu-groups/external/${richMenuId}/image?accountId=${encodeURIComponent(accountId)}`,

    applyToTag: (
      groupId: string,
      params:
        | { mode: 'bulk-link'; tagId: string | null }
        | { mode: 'set-default' },
      /** #502中: 一括適用のやり直しで二重記録にしないための鍵。 */
      idempotencyKey?: string,
    ) =>
      fetchApi<
        ApiResponse<{ chunks: number; total: number; runId?: string; message?: string; mode?: string }>
      >(`/api/rich-menu-groups/${groupId}/apply-to-tag`, {
        method: 'POST',
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
        body: JSON.stringify(params),
      }),

    // 画像 upload は Content-Type を image/* で送るので fetchApi を使わず直接 fetch。
    // 通信断の日本語化だけ fetchApi とそろえる。
    uploadImage: async (groupId: string, pageId: string, file: File, expectedGeneration?:number) => {
      const csrf = getCsrfToken();
      const res = await fetchWithNetworkMessage(
        `${API_URL}/api/rich-menu-groups/${groupId}/pages/${pageId}/image${expectedGeneration===undefined?'':`?expectedGeneration=${expectedGeneration}`}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': file.type,
            ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          },
          body: file,
        },
      );
      const raw = await res.text();
      if (!res.ok) throw responseApiError(res, raw, extractApiErrorCode(raw));
      const body = JSON.parse(raw) as ApiResponse<{
        imageR2Key: string;
        imageContentType: string;
        size: 'large' | 'compact';
        publishingGeneration?:number;
      }>;
      if (!body.success) {
        throw new Error(readApiError(body).message ?? `upload failed: ${res.status}`);
      }
      return body;
    },

    // 認証必須の管理画面でだけ使う画像URL。ブラウザは同一セッションのCookieを
    // 送るため、Worker側も通常の認証・アカウント境界を通す。外部共有が必要に
    // なった場合は認証除外にせず、短命な署名付きURLを別途発行する。
    imageUrl: (key: string) =>
      `${API_URL}/api/rich-menu-images/${encodeURIComponent(key)}`,
  },
}
