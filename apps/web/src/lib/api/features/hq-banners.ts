import { fetchApi } from '../transport/request'
import type { ApiResponse, BannerGenerationCreateOptions } from '@line-crm/shared'
import type {
  BannerPresetsResponse,
  BannerUsage,
  BannerStats,
  BannerProject,
  BannerProjectDetail,
  BannerGenerationInput,
  BannerGeneration,
  BannerImage,
  BannerRunResult,
  BannerDeliveryResult,
} from '../../hq-banners'

export const hqBannersMethods = {
/**
   * 統括「バナー生成」。統括の管理者・オーナーだけが呼べる。
   * 形は `apps/worker/src/routes/hq-banners.ts`、説明は `docs/hq-banner-generation.md`。
   */
  hqBanners: {
    folders: {
      list: (kind: import('@line-crm/shared').HqBannerFolderKind) => fetchApi<ApiResponse<import('@line-crm/shared').HqBannerFolder[]>>(`/api/hq/banners/folders?kind=${kind}`),
      create: (input: {kind: import('@line-crm/shared').HqBannerFolderKind; name: string; color?: string | null}) => fetchApi<ApiResponse<import('@line-crm/shared').HqBannerFolder>>('/api/hq/banners/folders',{method:'POST',body:JSON.stringify(input)}),
      update: (id:string,input:{kind:import('@line-crm/shared').HqBannerFolderKind; name?:string; color?:string|null; expectedRevision:number}) => fetchApi<ApiResponse<import('@line-crm/shared').HqBannerFolder>>(`/api/hq/banners/folders/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify(input)}),
      swapOrder: (id:string,withId:string,kind:import('@line-crm/shared').HqBannerFolderKind,expectedRevision:number,withExpectedRevision:number) => fetchApi<ApiResponse<{swapped:[string,string]}>>(`/api/hq/banners/folders/${encodeURIComponent(id)}/swap-order`,{method:'POST',body:JSON.stringify({kind,withId,expectedRevision,withExpectedRevision})}),
      delete: (id:string,kind:import('@line-crm/shared').HqBannerFolderKind,expectedRevision:number) => fetchApi<ApiResponse<{id:string;archived:boolean}>>(`/api/hq/banners/folders/${encodeURIComponent(id)}`,{method:'DELETE',body:JSON.stringify({kind,expectedRevision})}),
    },
    presets: () => fetchApi<ApiResponse<BannerPresetsResponse>>('/api/hq/banners/presets'),
    usage: () => fetchApi<ApiResponse<BannerUsage>>('/api/hq/banners/usage'),
    /** 数値カード帯の数（プロジェクト数・店舗へ渡した画像と店舗の数）。 */
    stats: () => fetchApi<ApiResponse<BannerStats>>('/api/hq/banners/stats'),
    projects: {
      list: (params?: { archived?: boolean; q?: string; folderId?: string | null }) => {
        const q = new URLSearchParams()
        if (params?.folderId !== undefined) q.set('folderId',params.folderId ?? '__none__')
        if (params?.archived) q.set('archived', '1')
        if (params?.q) q.set('q', params.q)
        const query = q.toString()
        return fetchApi<ApiResponse<BannerProject[]>>(`/api/hq/banners/projects${query ? `?${query}` : ''}`)
      },
      create: (input: { name: string; description?: string | null; folderId?: string | null }) =>
        fetchApi<ApiResponse<BannerProject>>('/api/hq/banners/projects', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      get: (id: string) =>
        fetchApi<ApiResponse<BannerProjectDetail>>(`/api/hq/banners/projects/${encodeURIComponent(id)}`),
      update: (
        id: string,
        input: { name?: string; description?: string | null; isFavorite?: boolean; archived?: boolean; folderId?: string | null },
      ) =>
        fetchApi<ApiResponse<BannerProject>>(`/api/hq/banners/projects/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      duplicate: (id: string) =>
        fetchApi<ApiResponse<BannerProject>>(`/api/hq/banners/projects/${encodeURIComponent(id)}/duplicate`, {
          method: 'POST',
          body: JSON.stringify({}),
        }),
      /** 条件を登録するだけ。画像はまだ作らない。 */
      createGeneration: (id: string, input: BannerGenerationInput, options?: BannerGenerationCreateOptions & { accountId?: string }) =>
        fetchApi<ApiResponse<BannerGeneration>>(`/api/hq/banners/projects/${encodeURIComponent(id)}/generations${options?.accountId ? `?account_id=${encodeURIComponent(options.accountId)}` : ""}`, {
          method: 'POST',
          headers: options?.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : undefined,
          body: JSON.stringify(input),
        }),
      /** 手持ちの画像を取り込む。data は base64（data: なし）。 */
      upload: (id: string, input: { filename: string; mimeType: string; data: string }) =>
        fetchApi<ApiResponse<BannerImage>>(`/api/hq/banners/projects/${encodeURIComponent(id)}/uploads`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
    },
    generations: {
      get: (id: string) =>
        fetchApi<ApiResponse<BannerGeneration>>(`/api/hq/banners/generations/${encodeURIComponent(id)}`),
      /** 1回で1枚作る。画面が枚数ぶん繰り返す。切り抜き位置は用途寸法への整形に使う。 */
      run: (id: string, input?: { gravity?: string }, accountId?: string) =>
        fetchApi<ApiResponse<BannerRunResult>>(`/api/hq/banners/generations/${encodeURIComponent(id)}/run${accountId ? `?account_id=${encodeURIComponent(accountId)}` : ""}`, {
          method: 'POST',
          body: JSON.stringify(input ?? {}),
        }),
      cancel: (id: string) =>
        fetchApi<ApiResponse<BannerGeneration>>(`/api/hq/banners/generations/${encodeURIComponent(id)}/cancel`, {
          method: 'POST',
          body: JSON.stringify({}),
        }),
    },
    images: {
      list: (params?: import("@line-crm/shared").HqBannerImageQuery) => {
        const q = new URLSearchParams()
        if (params?.folderId !== undefined) q.set('folderId',params.folderId ?? '__none__')
        if (params?.projectId) q.set('projectId', params.projectId)
        if (params?.favorite) q.set('favorite', '1')
        if (params?.delivered !== undefined) q.set('delivered', params.delivered ? '1' : '0')
        if (params?.shape) q.set('shape', params.shape)
        if (params?.withCounts) q.set('withCounts', '1')
        if (params?.preset) q.set('preset', params.preset)
        if (params?.q) q.set('q', params.q)
        if (params?.before) q.set('before', params.before)
        if (params?.limit) q.set('limit', String(params.limit))
        const query = q.toString()
        return fetchApi<ApiResponse<BannerImage[]> & { nextBefore?: string | null; counts?: import("@line-crm/shared").HqBannerImageCounts }>(
          `/api/hq/banners/images${query ? `?${query}` : ''}`,
        )
      },
      get: (id: string) => fetchApi<ApiResponse<BannerImage>>(`/api/hq/banners/images/${encodeURIComponent(id)}`),
      update: (id: string, input: { isFavorite?: boolean; projectId?: string; folderId?: string | null }) =>
        fetchApi<ApiResponse<BannerImage>>(`/api/hq/banners/images/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      /** 一覧から外す。実体と渡した先は残る。 */
      remove: (id: string) =>
        fetchApi<ApiResponse<null>>(`/api/hq/banners/images/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      /** 店舗へ渡す。同じ店舗へ二度渡しても増えない。 */
      deliver: (id: string, lineAccountIds: string[]) =>
        fetchApi<ApiResponse<BannerDeliveryResult>>(`/api/hq/banners/images/${encodeURIComponent(id)}/deliver`, {
          method: 'POST',
          body: JSON.stringify({ lineAccountIds }),
        }),
    },
  },
}
