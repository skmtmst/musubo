import { api } from '@/lib/api'
import { apiReadCacheGeneration } from '@/lib/api/transport/read-cache'
import { restaurantTestApi } from '@/lib/restaurant-test-api'
import type { StyleSetupProgress } from '@/v8/settings/public/getting-started-steps/index'

const keys = ['attributes', 'friendAdd', 'scenario', 'hours', 'followup', 'richMenu'] as const
export function unknownRestaurantSetup(reason: string): StyleSetupProgress {
  return { style: 'restaurant', steps: Object.fromEntries(keys.map(key => [key, { complete: null, reason }])) }
}

type StoreSelectionLoad = [
  Awaited<ReturnType<typeof restaurantTestApi.listStores>>,
  Awaited<ReturnType<typeof restaurantTestApi.storeContext>>,
]
const PRELOAD_TTL_MS = 10_000
const preloadedStoreSelections = new Map<string, { generation: number; expiresAt: number; promise: Promise<StoreSelectionLoad> }>()

export function clearPreloadedRestaurantStoreSelection(accountId?: string | null): void {
  if (!accountId) preloadedStoreSelections.clear()
  else preloadedStoreSelections.delete(accountId)
}

export function preloadRestaurantStoreSelection(accountId: string): void {
  const now = Date.now()
  const generation = apiReadCacheGeneration()
  const existing = preloadedStoreSelections.get(accountId)
  if (existing && existing.generation === generation && existing.expiresAt > now) return
  const promise = Promise.all([restaurantTestApi.listStores(accountId), restaurantTestApi.storeContext(accountId)])
  const entry = { generation, expiresAt: now + PRELOAD_TTL_MS, promise }
  preloadedStoreSelections.set(accountId, entry)
  void promise.catch(() => {
    if (preloadedStoreSelections.get(accountId) === entry) preloadedStoreSelections.delete(accountId)
  })
}

/**
 * ③リッチメニューを選ぶ。アカウント単位の下書きで決まるので、店舗の集計とは別に読む。
 * 公開済みも下書きを作った後の形なので、1つでもあれば済みにする。
 */
export async function loadRichMenuEvidence(accountId: string): Promise<{ complete: boolean | null; reason: string; published?: boolean }> {
  try {
    const response = await api.richMenuGroups.listPage(accountId, { page: 1, limit: 1 })
    if (!response.success || !Array.isArray(response.data?.items)) return { complete: null, reason: 'リッチメニューの状態を確認できませんでした' }
    return {
      complete: response.data.items.length > 0,
      reason: '最初のリッチメニューを選び、下書きを作ってください',
      published: (response.data.facets?.published ?? 0) > 0 || response.data.items.some(item => item.status === 'published'),
    }
  } catch { return { complete: null, reason: 'リッチメニューの状態を確認できませんでした' } }
}

/** 店舗の集計とリッチメニューを別に読み、片方が未取得でももう片方の判定を保つ。 */
export async function loadRestaurantSetupProgress(accountId: string, selectedStoreId?: string | null): Promise<StyleSetupProgress> {
  const [base, { published, ...richMenu }] = await Promise.all([loadRestaurantStoreProgress(accountId, selectedStoreId), loadRichMenuEvidence(accountId)])
  return { ...base, richMenuPublished: published, steps: { ...base.steps, richMenu } }
}

/** 店舗を混ぜず、選ばれた1店舗だけを読む。前の店の値で未取得を補わない。 */
async function loadRestaurantStoreProgress(accountId: string, selectedStoreId?: string | null): Promise<StyleSetupProgress> {
  let storeId = selectedStoreId
  if (storeId === undefined) {
    const preloaded = preloadedStoreSelections.get(accountId)
    if (preloaded) preloadedStoreSelections.delete(accountId)
    const validPreload = preloaded && preloaded.generation === apiReadCacheGeneration() && preloaded.expiresAt > Date.now()
      ? preloaded.promise : null
    const [stores, context] = await (validPreload ?? Promise.all([restaurantTestApi.listStores(accountId), restaurantTestApi.storeContext(accountId)]))
    if (!stores.success || !context.success) return unknownRestaurantSetup('店舗の設定を読み込めませんでした')
    const selected = context.data.selectedStore?.id
    const owned = stores.data.stores.filter(store => store.status === 'active' && store.line_account_id === accountId)
    if (selected && !owned.some(store => store.id === selected))
      return unknownRestaurantSetup('このアカウントの店舗を選んで設定を確認してください')
    storeId = selected ?? (owned.length === 1 ? owned[0].id : null)
  }
  if (!storeId) return unknownRestaurantSetup('店舗を選んで設定を確認してください')
  const response = await restaurantTestApi.setupProgress(accountId, storeId)
  if (!response.success || response.data.storeId !== storeId
    || (response.data.lineAccountId !== undefined && response.data.lineAccountId !== accountId)
    || !['tables', 'hours', 'menus', 'reception', 'followup'].every(key => typeof response.data[key as keyof typeof response.data] === 'boolean'))
    return unknownRestaurantSetup('店舗の設定を読み込めませんでした')
  const data = response.data
  const exposure = data.bookingExposure
  const bookingExposure = exposure && typeof exposure.reservationLink === 'boolean'
    && typeof exposure.publicReservationMenu === 'boolean' && typeof exposure.availableCapacity === 'boolean'
    ? exposure : undefined
  return { style: 'restaurant', bookingExposure, ...(data.reservationForm?.available===false?{notices:[{message:data.reservationForm.message,href:data.reservationForm.repairPath}]}:{}), steps: {
    attributes: { complete: data.tables, reason: '卓を作るか、停止中の卓の受付を再開してください' },
    hours: { complete: data.hours, reason: '予約を受け付ける曜日と時間を設定してください' },
    friendAdd: { complete: data.menus || data.courseRegistered === true, reason: 'コースとメニューを登録してください' },
    scenario: { complete: data.reception, reason: 'LINEの予約ページと、これからの受付枠を用意してください' },
    followup: followupEvidence(data.followupSetup, data.followup),
  } }
}

/** 新しい集計が来るまで現判定を保つ。表示のために保存や初期投入のGETを呼ばない。 */
export function followupEvidence(setup: unknown, fallback: boolean): {complete: boolean | null; reason: string} {
  if (setup === undefined) return {complete:fallback,reason:'来店フォローの内容と送信の設定を確認してください'}
  if (!setup || typeof setup !== 'object' || Array.isArray(setup))
    return {complete:null,reason:'来店フォローの状態を確認できませんでした'}
  const data = setup as Record<string,unknown>
  const valid = typeof data.notUsing === 'boolean' && typeof data.anyEnabled === 'boolean'
    && Number.isSafeInteger(data.version) && Number(data.version) >= 0
    && (data.decidedAt === null || typeof data.decidedAt === 'string' && Number.isFinite(Date.parse(data.decidedAt)))
    && (!data.notUsing || data.decidedAt !== null && Number(data.version) > 0)
  return valid ? {complete:data.notUsing === true || data.anyEnabled === true,reason:'来店フォローの送り方を1つ以上オンにするか、今は使わないことを保存してください'}
    : {complete:null,reason:'来店フォローの状態を確認できませんでした'}
}
