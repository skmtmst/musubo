import { fetchApi } from '../transport/request'
import type { ApiResponse } from '@line-crm/shared'

/**
 * 接続一覧の返事。行ごとに状態と版を持つ。先頭が「connectionId を省いたときに操作される接続」。
 * 1件ぶんの `connection` と違い、1件が期限切れでも他の行は使えるので state は行ごとに見る。
 */
export type InstagramConnectionList = {
  state: 'unconfigured' | 'disconnected' | 'connected'
  connections: Array<{
    id: string
    state: 'connected' | 'expired'
    pageId: string
    instagramId: string
    pageName: string
    username: string | null
    expiresAt: string
    dataAccessExpiresAt: string | null
    version: number
    syncedAt: string | null
  }>
}

/**
 * Instagram の口に付ける問い合わせ。接続が2つ以上あるときは connectionId で相手を決める。
 * 空の id は付けない（付けるとサーバーが見つからない扱いにする）。
 */
function instagramParams(accountId: string, connectionId?: string | null, extra?: Record<string, string>): string {
  return new URLSearchParams({
    lineAccountId: accountId,
    ...(connectionId ? { connectionId } : {}),
    ...(extra ?? {}),
  }).toString()
}

export const settingsMethods = {
/**
   * 機能のオン／オフ。account_settings の key/value に入る。
   * 切ったものだけが記録され、記録が無ければ有効。
   */
  featureSettings: {
    /** 一般staffの画面の殻に使う、表示可否booleanだけの応答。 */
    visibility: (accountId: string) =>
      fetchApi<ApiResponse<{ features: Record<string, boolean>; favoriteItemIds: string[]; restaurantHiddenItemIds: string[] }>>(
        `/api/settings/features/visibility?account_id=${encodeURIComponent(accountId)}`,
      ),
    get: (accountId: string) =>
      fetchApi<ApiResponse<{
        features: Record<string, boolean>
        sidebarOrder: string[] | null
        /** 区分ごとの項目の並び。区分の目印 → 項目の目印の並び。 */
        sidebarItemOrder: Record<string, string[]> | null
        favoriteItemIds: string[]
        restaurantHiddenItemIds: string[]
        parentChildMode: boolean
        specializedFeatureKeys: string[]
        /** 保存時に送り返す版。一括保存の競合検出に使う。 */
        version: number
      }>>(
        `/api/settings/features?account_id=${encodeURIComponent(accountId)}`,
      ),
    save: (accountId: string, data: {
      features?: Record<string, boolean>
      sidebarOrder?: string[]
      sidebarItemOrder?: Record<string, string[]>
      favoriteItemIds?: string[]
      restaurantHiddenItemIds?: string[]
      /** GET で受けた版。付けると1行でまとめて保存し、古ければ409で返す。 */
      expectedVersion: number
      /** 変更理由。空白だけはサーバーが400で拒否する。監査へ残る。 */
      reason: string
    }) =>
      fetchApi<ApiResponse<{ version: number }>>(
        `/api/settings/features?account_id=${encodeURIComponent(accountId)}`,
        { method: 'PUT', body: JSON.stringify(data) },
      ),
  },
  accountSettings: {
    saveCustomerLook: (accountId: string, look: import('@line-crm/shared').CustomerLook, expectedVersion: number) => fetchApi<{success: boolean; data?: {version: number; look: import('@line-crm/shared').CustomerLook}; error?: string}>('/api/account-settings/customer-look',{method:'PUT',body:JSON.stringify({accountId,look,expectedVersion})}),
    getCustomerLook: (accountId: string) => fetchApi<{success: boolean; data: {version: number; look: import('@line-crm/shared').CustomerLook}; error?: string}>(`/api/account-settings/customer-look?accountId=${encodeURIComponent(accountId)}`),
    getAllergyOptions: (accountId: string) => fetchApi<{ success: boolean; data: {version: number; options: string[]}; error?: string }>(`/api/account-settings/allergy-options?accountId=${encodeURIComponent(accountId)}`),
    saveAllergyOptions: (accountId: string, options: string[], expectedVersion: number) => fetchApi<{success: boolean; data?: {version: number}; error?: string}>('/api/account-settings/allergy-options', { method: 'PUT', body: JSON.stringify({accountId, options, expectedVersion}) }),
    getTestRecipients: (accountId: string) =>
      fetchApi<{ success: boolean; confirmationRevision: number; data: Array<{ id: string; displayName: string; pictureUrl: string | null }> }>(`/api/account-settings/test-recipients?accountId=${accountId}`),
    getTestRecipientLoginUsers: (accountId: string) =>
      fetchApi<{
        success: boolean
        data: Array<{
          id: string
          displayName: string
          pictureUrl: string | null
          staffName: string
          sameAccount: boolean
        }>
      }>(`/api/account-settings/test-recipient-login-users?accountId=${accountId}`),
    updateTestRecipients: (accountId: string, friendIds: string[]) =>
      fetchApi<{ success: boolean }>('/api/account-settings/test-recipients', {
        method: 'PUT',
        body: JSON.stringify({ accountId, friendIds }),
      }),
    getLinkBaseUrl: () =>
      fetchApi<{ success: boolean; data: string | null }>('/api/account-settings/link-base-url'),
    updateLinkBaseUrl: (value: string) =>
      fetchApi<{ success: boolean; error?: string }>('/api/account-settings/link-base-url', {
        method: 'PUT',
        body: JSON.stringify({ value }),
      }),
    getTrackedLinkBaseUrl: () =>
      fetchApi<{ success: boolean; data: string | null }>('/api/account-settings/tracked-link-base-url'),
    updateTrackedLinkBaseUrl: (value: string) =>
      fetchApi<{ success: boolean; error?: string }>('/api/account-settings/tracked-link-base-url', {
        method: 'PUT',
        body: JSON.stringify({ value }),
      }),
  },
/**
   * ログインする前に呼べるもの。認証を通さないので、置けるのは
   * 「誰に見えても困らない値」に限る。
   */
  publicBrand: {
    /** 公式アカウントの表示名とアイコン。ログイン画面とタブの題に使う。 */
    get: () =>
      fetchApi<ApiResponse<{ name: string | null; iconUrl: string | null }>>('/api/public/brand'),
  },
/** 統括の課金（★管理画面 36-2）。形は `apps/worker/src/routes/hq-billing.ts`。 */
  postalCode: {
    search: (code: string) => fetchApi<ApiResponse<{
      status: 'invalid' | 'none' | 'matched' | 'multiple'
      candidates: Array<{ postalCode: string; prefecture: string; city: string; town: string }>
      readiness: { fullDataset: boolean }
    }>>(`/api/postal-code/search?code=${encodeURIComponent(code)}`),
  },
  /**
   * 設定 › SNS 連携の口（契約枠・主連携・請求の段）。形は `apps/worker/src/routes/sns-connections.ts`。
   * 契約枠の記録が無い LINEアカウントでは 404 が返る。画面はその場合だけ今までの既定値へ戻す。
   */
  snsConnections: {
    get: (accountId: string) =>
      fetchApi<ApiResponse<import('@line-crm/shared').SnsConnectionPorts>>(
        `/api/settings/sns/connections?${new URLSearchParams({ lineAccountId: accountId })}`,
      ),
    /** 主連携を切り替える。版が合わなければ 409（画面は読み直す）。 */
    setGooglePrimary: (input: import('@line-crm/shared').SetSnsGooglePrimaryInput) =>
      fetchApi<ApiResponse<import('@line-crm/shared').SetSnsGooglePrimaryResult>>(
        '/api/settings/sns/google-primary',
        { method: 'PUT', body: JSON.stringify(input) },
      ),
  },
  instagram: {
    // connectionId は操作する接続そのものの id。省略すると既定の1件が相手になるため、
    // 接続が2つ以上あるときは画面で選んだ行の id を必ず渡す。
    connection: (accountId:string,connectionId?:string|null)=>fetchApi<ApiResponse<import('@line-crm/shared').InstagramConnectionStatus>>(`/api/instagram/connection?${instagramParams(accountId,connectionId)}`),
    // 一覧の行の元。行ごとの id・版をここから受け取り、つなぎ直す・解除するで送り返す。
    connections: (accountId:string)=>fetchApi<ApiResponse<InstagramConnectionList>>(`/api/instagram/connections?${instagramParams(accountId)}`),
    // mode='add' は「いまの接続を繋ぎ直す」ではなく「接続を増やす」とき。
    start: (accountId:string,target?:{connectionId?:string|null;add?:boolean})=>fetchApi<ApiResponse<{url:string;expiresAt:string}>>(`/api/instagram/oauth/start?${instagramParams(accountId,target?.connectionId,target?.add?{mode:'add'}:undefined)}`,{method:'POST',body:'{}'}),
    // 折り返しはブラウザがそのまま踏む（/settings/sns?instagram=... へ戻る）ので、画面から叩く口は持たない。
    refresh: (accountId:string,connectionId?:string|null)=>fetchApi<ApiResponse<{expiresAt:string;dataAccessExpiresAt:string|null;version:number}>>(`/api/instagram/refresh?${instagramParams(accountId,connectionId)}`,{method:'POST',body:'{}'}),
    disconnect: (accountId:string,expectedVersion:number,connectionId?:string|null)=>fetchApi<ApiResponse<{disconnected:true}>>(`/api/instagram/connection?${instagramParams(accountId,connectionId)}`,{method:'DELETE',body:JSON.stringify({expectedVersion})}),
    profile: (accountId:string)=>fetchApi<ApiResponse<{state:string;value:import('@line-crm/shared').InstagramProfile|null;syncedAt?:string|null}>>(`/api/instagram/profile?${new URLSearchParams({lineAccountId:accountId})}`),
    posts: (accountId:string)=>fetchApi<ApiResponse<{state:string;value:import('@line-crm/shared').InstagramPost[]|null;syncedAt?:string|null}>>(`/api/instagram/posts?${new URLSearchParams({lineAccountId:accountId})}`),
    sync: (accountId:string)=>fetchApi<ApiResponse<{profile:import('@line-crm/shared').InstagramProfile;posts:import('@line-crm/shared').InstagramPost[]}>>(`/api/instagram/sync?${new URLSearchParams({lineAccountId:accountId})}`,{method:'POST',body:'{}'}),
    messages: (accountId:string,limit=50,beforeId?:string)=>fetchApi<ApiResponse<{messages:import('@line-crm/shared').InstagramReceivedMessage[];total:number|null}>>(`/api/instagram/messages?${new URLSearchParams({lineAccountId:accountId,limit:String(limit),...(beforeId?{beforeId}:{})})}`),
    reply: (accountId:string,id:string,text:string)=>fetchApi<ApiResponse<{enabled:false}>>(`/api/instagram/messages/${encodeURIComponent(id)}/reply?${new URLSearchParams({lineAccountId:accountId})}`,{method:'POST',body:JSON.stringify({text})}),
  },
}
