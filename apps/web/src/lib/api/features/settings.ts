import { fetchApi } from '../transport/request'
import type { ApiResponse } from '@line-crm/shared'

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
  instagram: {
    connection: (accountId:string)=>fetchApi<ApiResponse<import('@line-crm/shared').InstagramConnectionStatus>>(`/api/instagram/connection?${new URLSearchParams({lineAccountId:accountId})}`),
    start: (accountId:string)=>fetchApi<ApiResponse<{url:string;expiresAt:string}>>(`/api/instagram/oauth/start?${new URLSearchParams({lineAccountId:accountId})}`,{method:'POST',body:'{}'}),
    // 折り返しはブラウザがそのまま踏む（/settings/sns?instagram=... へ戻る）ので、画面から叩く口は持たない。
    refresh: (accountId:string)=>fetchApi<ApiResponse<{expiresAt:string;dataAccessExpiresAt:string|null;version:number}>>(`/api/instagram/refresh?${new URLSearchParams({lineAccountId:accountId})}`,{method:'POST',body:'{}'}),
    disconnect: (accountId:string,expectedVersion:number)=>fetchApi<ApiResponse<{disconnected:true}>>(`/api/instagram/connection?${new URLSearchParams({lineAccountId:accountId})}`,{method:'DELETE',body:JSON.stringify({expectedVersion})}),
    profile: (accountId:string)=>fetchApi<ApiResponse<{state:string;value:import('@line-crm/shared').InstagramProfile|null;syncedAt?:string|null}>>(`/api/instagram/profile?${new URLSearchParams({lineAccountId:accountId})}`),
    posts: (accountId:string)=>fetchApi<ApiResponse<{state:string;value:import('@line-crm/shared').InstagramPost[]|null;syncedAt?:string|null}>>(`/api/instagram/posts?${new URLSearchParams({lineAccountId:accountId})}`),
    sync: (accountId:string)=>fetchApi<ApiResponse<{profile:import('@line-crm/shared').InstagramProfile;posts:import('@line-crm/shared').InstagramPost[]}>>(`/api/instagram/sync?${new URLSearchParams({lineAccountId:accountId})}`,{method:'POST',body:'{}'}),
    messages: (accountId:string,limit=50,beforeId?:string)=>fetchApi<ApiResponse<{messages:import('@line-crm/shared').InstagramReceivedMessage[];total:number|null}>>(`/api/instagram/messages?${new URLSearchParams({lineAccountId:accountId,limit:String(limit),...(beforeId?{beforeId}:{})})}`),
    reply: (accountId:string,id:string,text:string)=>fetchApi<ApiResponse<{enabled:false}>>(`/api/instagram/messages/${encodeURIComponent(id)}/reply?${new URLSearchParams({lineAccountId:accountId})}`,{method:'POST',body:JSON.stringify({text})}),
  },
}
