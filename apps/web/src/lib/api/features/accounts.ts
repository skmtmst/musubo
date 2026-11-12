import { fetchApi } from '../transport/request'
import type { ApiResponse, LineAccount, TrafficPool, PoolAccount } from '@line-crm/shared'
import type { LineAccountTag, LineAccountConnectData, FollowerImportState, LineRegistrationReceipt } from '../types/accounts'
import type { FetchApiOptions } from '../types/transport'

export const accountsMethods = {
/** 統括のアカウントフォルダ（板 ）。店のFolder型を共用する。 */
  lineAccountFolders: {
    list: () => fetchApi<ApiResponse<import('@line-crm/shared').LineAccountFolderList>>('/api/line-account-folders'),
    create: (input: import('@line-crm/shared').LineAccountFolderInput) => fetchApi<ApiResponse<import('@line-crm/shared').Folder>>('/api/line-account-folders', {method:'POST',body:JSON.stringify(input)}),
    update: (id:string,input:Partial<import('@line-crm/shared').LineAccountFolderInput>) => fetchApi<ApiResponse<import('@line-crm/shared').Folder>>(`/api/line-account-folders/${encodeURIComponent(id)}`, {method:'PATCH',body:JSON.stringify(input)}),
    remove: (id:string) => fetchApi<ApiResponse<{id:string}>>(`/api/line-account-folders/${encodeURIComponent(id)}`, {method:'DELETE'}),
    move: (id:string,folderId:string|null) => fetchApi<ApiResponse<{id:string;folderId:string|null;folder:import('@line-crm/shared').Folder|null}>>(`/api/line-accounts/${encodeURIComponent(id)}/folder`, {method:'PUT',body:JSON.stringify({folderId})}),
  },
/** 移行期間用の旧タグAPI。複数タグは先頭1件をフォルダにする。 */
  lineAccountTags: {
    setForAccount: (id: string, tagIds: string[]) =>
      fetchApi<ApiResponse<{ id: string; tags: LineAccountTag[] }>>(
        `/api/line-accounts/${id}/tags`,
        { method: 'PUT', body: JSON.stringify({ tagIds }) },
      ),

    list: () => fetchApi<ApiResponse<LineAccountTag[]>>('/api/line-account-tags'),
    create: (input: string | import('@line-crm/shared').LineAccountTagInput) =>
      fetchApi<ApiResponse<LineAccountTag>>('/api/line-account-tags', {
        method: 'POST',
        body: JSON.stringify(typeof input === 'string' ? { name: input } : input),
      }),
    remove: (id: string) =>
      fetchApi<ApiResponse<{ id: string }>>(`/api/line-account-tags/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    replace: (accountId: string, tagIds: string[]) =>
      fetchApi<ApiResponse<{ id: string; tags: LineAccountTag[] }>>(`/api/line-accounts/${encodeURIComponent(accountId)}/tags`, {
        method: 'PUT',
        body: JSON.stringify({ tagIds }),
      }),
    update: (id: string, input: Partial<import("@line-crm/shared").LineAccountTagInput>) => fetchApi<ApiResponse<import("@line-crm/shared").LineAccountTagSummary>>(`/api/line-account-tags/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  },
  lineAccounts: {
    profilePictures: () =>
      fetchApi<ApiResponse<Array<{ id: string; pictureUrl: string | null }>>>(
        '/api/line-accounts/profile-pictures', { cache: 'no-store' },
      ),
    list: (live = false, folderId?:string|null, options?: FetchApiOptions) => {
      const query=new URLSearchParams()
      if(live) query.set('live','1')
      if(folderId!==undefined) query.set('folderId',folderId ?? '__none__')
      return fetchApi<ApiResponse<LineAccount[]>>(`/api/line-accounts${query.size?`?${query}`:''}`, live ? { ...options, cache: 'reload' } : options)
    },
    summary: () =>
      fetchApi<ApiResponse<{ uniqueFriendCount: number }>>('/api/line-accounts/summary'),
    get: (id: string) =>
      fetchApi<ApiResponse<LineAccount>>(`/api/line-accounts/${id}`),
    registrationReceipt: (id: string) =>
      fetchApi<ApiResponse<LineRegistrationReceipt>>(`/api/line-accounts/${id}/registration-receipt`, { cache: 'no-store' }),
    create: (data: {
      style?: import('@line-crm/shared').AccountStyle;
      channelId: string;
      name: string;
      channelAccessToken: string;
      channelSecret: string;
      loginChannelId?: string | null;
      loginChannelSecret?: string | null;
      liffId?: string | null;
      timezone?: string;
      country?: string | null;
      role?: string | null;
      parentLineAccountId?: string | null;
      ogSiteName?: string | null;
      ogDefaultImageUrl?: string | null;
      ogDefaultDescription?: string | null;
      copyFromAccountId?: string | null;
      copyItems?: Array<'accountSettings' | 'scenarios' | 'autoReplies'>;
    }, stepUpToken?: string) =>
      fetchApi<ApiResponse<LineAccount>>('/api/line-accounts', {
        method: 'POST',
        headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
        body: JSON.stringify(data),
      }),
    connectCheck: (data: import('@line-crm/shared').LineAccountConnectInput) => fetchApi<ApiResponse<LineAccountConnectData>>('/api/line-accounts/connect/check', {
      method: 'POST', body: JSON.stringify(data),
    }),
    connect: (data: import('@line-crm/shared').LineAccountConnectInput, stepUpToken?: string) => fetchApi<ApiResponse<LineAccountConnectData>>('/api/line-accounts/connect', {
      method: 'POST',
      headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
      body: JSON.stringify(data),
    }),
    // Smart method routing:
    //   - rotating Messaging credentials (channelAccessToken / channelSecret)
    //     requires PUT (owner-only on the worker)
    //   - everything else routes to PATCH (admin-allowed)
    // This keeps a single helper signature for callers (toggle, country/role
    // edit, the edit modal) while letting admin users actually save the
    // non-credential changes. Without this, admin saves on the edit modal
    // would 403 even though the worker has a PATCH route that would accept
    // them.
    update: (
      id: string,
      data: Partial<
        Pick<
          LineAccount,
          | 'name'
          | 'channelAccessToken'
          | 'channelSecret'
          | 'loginChannelId'
          | 'loginChannelSecret'
          | 'liffId'
          | 'isActive'
          | 'country'
          | 'role'
          | 'ogSiteName'
          | 'ogDefaultDescription'
          | 'ogDefaultImageUrl'
          | 'friendCapacity'
          | 'capacityWarnAt'
          | 'timezone'
          | 'iconUrl'
        >
      >,
      stepUpToken?: string,
    ) => {
      const touchesMessagingCredentials =
        data.channelAccessToken !== undefined || data.channelSecret !== undefined
      return fetchApi<ApiResponse<LineAccount>>(`/api/line-accounts/${id}`, {
        method: touchesMessagingCredentials || data.timezone !== undefined ? 'PUT' : 'PATCH',
        headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
        body: JSON.stringify(data),
      })
    },
    delete: (id: string, stepUpToken?: string) =>
      fetchApi<ApiResponse<null>>(`/api/line-accounts/${id}`, {
        method: 'DELETE',
        headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
      }),
    // 送受信の停止・再開（X-1）。理由は必須。再開は接続確認を内包する。
    deactivate: (id: string, reason: string, stepUpToken?: string) =>
      fetchApi<ApiResponse<LineAccount>>(`/api/line-accounts/${id}/deactivate`, {
        method: 'POST',
        headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
        body: JSON.stringify({ reason }),
      }),
    activate: (id: string, reason: string, stepUpToken?: string) =>
      fetchApi<ApiResponse<LineAccount & { checks?: unknown[] }>>(
        `/api/line-accounts/${id}/activate`,
        {
          method: 'POST',
          headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
          body: JSON.stringify({ reason }),
        },
      ),
    // 「止めていたので送らなかった」の一覧（X-1）。再開の確認に使う。
    skippedDeliveries: (id: string) =>
      fetchApi<ApiResponse<Array<{
        id: string;
        kind: string;
        refId: string;
        title: string | null;
        reason: string;
        skippedAt: string;
      }>>>(`/api/line-accounts/${id}/skipped-deliveries`),
    // アーカイブ（X-1）。止まっている・既定でない・配送が走っていない
    // アカウントだけ。一覧から外れ、記録は残る。
    archive: (id: string, reason?: string, stepUpToken?: string) =>
      fetchApi<ApiResponse<LineAccount>>(`/api/line-accounts/${id}/archive`, {
        method: 'POST',
        headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
        body: JSON.stringify({ reason: reason ?? null }),
      }),
    // アーカイブから戻す。戻った直後は「止まっている」状態。
    restore: (id: string, stepUpToken?: string) =>
      fetchApi<ApiResponse<LineAccount>>(`/api/line-accounts/${id}/restore`, {
        method: 'POST',
        headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
      }),
    updateOrder: (ordered: Array<{ id: string; displayOrder: number }>) =>
      fetchApi<{ success: boolean; error?: string }>('/api/line-accounts/order', {
        method: 'PATCH',
        body: JSON.stringify({ ordered }),
      }),
    updateHierarchy: (relationships: Array<{ id: string; parentLineAccountId: string | null }>) =>
      fetchApi<ApiResponse<Array<{ id: string; parentLineAccountId: string | null }>>>(
        '/api/line-accounts/hierarchy',
        { method: 'PATCH', body: JSON.stringify({ relationships }) },
      ),
    verifyConnection: (data: {
      channelAccessToken: string;
      loginChannelId: string;
      loginChannelSecret: string;
      liffId: string;
    }) => fetchApi<ApiResponse<{
      messagingApi: boolean;
      webhook: boolean;
      lineLogin: boolean;
      liff: boolean;
      webhookUrl: string | null;
      errors: string[];
    }>>('/api/line-accounts/verify-connection', {
      method: 'POST', body: JSON.stringify(data),
    }),
    followerImportState: (id: string) =>
      fetchApi<ApiResponse<FollowerImportState>>(`/api/line-accounts/${id}/follower-import`),
    detectFollowerImport: (id: string) =>
      fetchApi<ApiResponse<FollowerImportState>>(
        `/api/line-accounts/${id}/follower-import/detect`,
        { method: 'POST' },
      ),
    startFollowerImport: (id: string) =>
      fetchApi<ApiResponse<FollowerImportState>>(
        `/api/line-accounts/${id}/follower-import/start`,
        { method: 'POST' },
      ),
    stepFollowerImport: (id: string) => // 続きを進める（済み・未開始なら何もせず返る）
      fetchApi<ApiResponse<{ state: FollowerImportState; busy: boolean; profilesFetched: number }>>(
        `/api/line-accounts/${id}/follower-import/step`,
        { method: 'POST', body: '{}' },
      ),
    followerInsight: (id: string, date: string) =>
      fetchApi<ApiResponse<{
        lineAccountId: string
        date: string
        status: string
        followers: number | null
        targetedReaches: number | null
        blocks: number | null
      }>>(`/api/line-accounts/${id}/follower-insight?date=${encodeURIComponent(date)}`),
  },
  pools: {
    list: (options?: FetchApiOptions) =>
      fetchApi<ApiResponse<TrafficPool[]>>('/api/traffic-pools', options),
    listAccounts: (ids: string[], options?: FetchApiOptions) =>
      fetchApi<ApiResponse<Array<{ poolId: string; accounts: PoolAccount[] }>>>(
        `/api/traffic-pools/accounts?ids=${encodeURIComponent(ids.join(','))}`,
        options,
      ),
    get: (id: string) => fetchApi<ApiResponse<TrafficPool>>(`/api/traffic-pools/${id}`),
    create: (data: import('@line-crm/shared').CreateTrafficPoolRequest) =>
      fetchApi<ApiResponse<TrafficPool>>('/api/traffic-pools', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (
      id: string,
      data: Partial<{ name: string; activeAccountId: string; isActive: boolean; expectedUpdatedAt: string }>,
    ) =>
      fetchApi<ApiResponse<TrafficPool>>(`/api/traffic-pools/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string, confirmation?: { revision: number; accountIds: string[] }) => {
      const query = confirmation ? `?${new URLSearchParams({ expectedConfirmationRevision: String(confirmation.revision), expectedAccountIds: JSON.stringify(confirmation.accountIds) })}` : ''
      return fetchApi<ApiResponse<null>>(`/api/traffic-pools/${id}${query}`, { method: 'DELETE' })
    },
    accounts: {
      list: (poolId: string) =>
        fetchApi<ApiResponse<PoolAccount[]>>(`/api/traffic-pools/${poolId}/accounts`),
      add: (poolId: string, lineAccountId: string) =>
        fetchApi<ApiResponse<PoolAccount>>(`/api/traffic-pools/${poolId}/accounts`, {
          method: 'POST',
          body: JSON.stringify({ lineAccountId }),
        }),
      toggle: (poolId: string, accountId: string, isActive: boolean) =>
        fetchApi<ApiResponse<PoolAccount>>(
          `/api/traffic-pools/${poolId}/accounts/${accountId}`,
          {
            method: 'PUT',
            body: JSON.stringify({ isActive }),
          },
        ),
      remove: (poolId: string, accountId: string) =>
        fetchApi<ApiResponse<null>>(
          `/api/traffic-pools/${poolId}/accounts/${accountId}`,
          { method: 'DELETE' },
        ),
    },
  },
}
