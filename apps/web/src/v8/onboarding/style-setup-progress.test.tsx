// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ACCOUNT_STYLES } from '@line-crm/shared'
import { loadStyleSetupProgress } from './style-setup-progress'
import { useStyleSetupProgress } from './use-style-setup-progress'
const net = vi.hoisted(() => ({ menus: vi.fn(), staff: vi.fn(), settings: vi.fn(), account: vi.fn(), events: vi.fn(), members: vi.fn(), snapshot: vi.fn(), context: vi.fn(), restaurantProgress: vi.fn(), hours: vi.fn(), connector: vi.fn(), googleProfile: vi.fn(), googleConnection: vi.fn(), richMenus: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { lineAccounts: { get: net.account }, ecCommerce: { connector: net.connector }, richMenuGroups: { listPage: net.richMenus } },
  bookingApi: { listMenus: net.menus, listStaff: net.staff, getSettings: net.settings }, eventsApi: { listEvents: net.events },
}))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { members: net.members } }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: { snapshot: net.snapshot, listStores: net.snapshot, storeContext: net.context, setupProgress: net.restaurantProgress, openingHours: net.hours } }))
vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: { profile: net.googleProfile, connection: net.googleConnection } }))
vi.mock('@/hooks/use-account-style', () => ({ ACCOUNT_STYLE_UPDATED: 'account-style-updated' }))

beforeEach(() => {
  vi.resetAllMocks()
  net.menus.mockResolvedValue({ menus: [{ id: 'menu', is_active: 1, assigned_staff: [{ id: 'staff' }] }] })
  net.staff.mockResolvedValue({ staff: [{ id: 'staff', is_active: 1 }] })
  net.settings.mockImplementation((id: string) => Promise.resolve({ success: true, data: { lineAccountId: id, openingHoursSource: 'google_business', businessHoursConfigured: true, businessHours: [{ intervals: [{ start: '09:00', end: '18:00' }] }] } }))
  net.googleProfile.mockImplementation((id: string) => Promise.resolve({ success: true, store: { lineAccountId: id }, closed: false, profile: { regularHours: { MONDAY: [{ open: '09:00', close: '18:00' }] } } }))
  net.googleConnection.mockImplementation((id: string) => Promise.resolve({ success: true, store: { lineAccountId: id }, connection: { status: 'connected', locationName: 'accounts/1/locations/2' } }))
  net.account.mockImplementation((id: string) => Promise.resolve({ success: true, data: { id, liffId: '123-booking' } }))
  net.events.mockResolvedValue({ items: [{ id: 'class', is_published: 1, lifecycle_status: 'published', next_slot_starts_at: '2099-10-28T10:00:00+09:00' }], total: 1 })
  net.members.mockResolvedValue({ success: true, data: [{ line_account_id: 'a', joined_at: '2026-10-28', ended_at: null, expires_at: null }] })
  net.snapshot.mockResolvedValue({ success: true, data: {
    stores: [{ id: 'store', line_account_id: 'a', status: 'active', line_status: 'connected' }],
    tables: [{ store_id: 'store', is_active: 1, max_capacity: 4 }], menuItems: [{ store_id: 'store', status: 'active' }],
    inventory: [{ store_id: 'store', line_capacity: 4, total_capacity: 4 }],
  } })
  net.context.mockResolvedValue({ success: true, data: { selectedStore: { id: 'store' } } })
  net.restaurantProgress.mockResolvedValue({ success: true, data: { storeId: 'store', tables: true, hours: true, menus: true, reception: true, followup: true, followupRequired: true } })
  net.hours.mockResolvedValue({ success: true, data: { hours: [{ periods: [{ opensAt: '09:00', closesAt: '18:00' }] }] } })
  net.richMenus.mockResolvedValue({ success: true, data: { items: [{ id: 'group' }] } })
  net.connector.mockResolvedValue({ success: true, data: { configured: true, connector: { status: 'connected', secretConfigured: true, eventTypes: ['ec.order.confirmed'] }, health: { lastSucceededAt: '2026-10-28T00:00:00Z' } } })
})
afterEach(cleanup)
const values = (progress: Awaited<ReturnType<typeof loadStyleSetupProgress>>) => Object.values(progress.steps).map(step => step?.complete)

it('入口の確認中は飲食店の進捗を隠し、確認後は取得済みの値を使う', async () => {
  const view = renderHook(({ enabled }) => useStyleSetupProgress('a', 'restaurant', enabled, 'store'), { initialProps: { enabled: true } })
  await waitFor(() => expect(view.result.current.status).toBe('ready'))
  view.rerender({ enabled: false })
  expect(view.result.current.status).toBe('idle')
  expect(view.result.current.progress?.steps.attributes?.complete).toBeNull()
  view.rerender({ enabled: true })
  await waitFor(() => expect(view.result.current.status).toBe('ready'))
  expect(net.restaurantProgress).toHaveBeenCalledTimes(1)
})

it('担当者や権限が変わった直後は飲食店の前の進捗を表示しない', async () => {
  const view = renderHook(({ identity }) => useStyleSetupProgress('a', 'restaurant', true, 'store', identity), { initialProps: { identity: 'staff-owner' } })
  await waitFor(() => expect(view.result.current.status).toBe('ready'))
  view.rerender({ identity: 'staff-viewer' })
  expect(view.result.current.status).toBe('loading')
  expect(view.result.current.progress?.steps.attributes?.complete).toBeNull()
  await waitFor(() => expect(view.result.current.status).toBe('ready'))
  expect(net.restaurantProgress).toHaveBeenCalledTimes(2)
})

it('保存後に入口の確認が入った場合は飲食店の古い進捗を隠して再取得する', async () => {
  const view = renderHook(({ enabled }) => useStyleSetupProgress('a', 'restaurant', enabled, 'store'), { initialProps: { enabled: true } })
  await waitFor(() => expect(view.result.current.status).toBe('ready'))
  act(() => view.result.current.markStale())
  view.rerender({ enabled: false })
  net.restaurantProgress.mockResolvedValueOnce({ success: true, data: { storeId: 'store', tables: false, hours: true, menus: true, reception: true, followup: true, followupRequired: true } })
  act(() => view.result.current.refresh())
  view.rerender({ enabled: true })
  expect(view.result.current.status).toBe('loading')
  await waitFor(() => expect(view.result.current.progress?.steps.attributes?.complete).toBe(false))
  expect(net.restaurantProgress).toHaveBeenCalledTimes(2)
})

it.each(ACCOUNT_STYLES)('%sはその段の既存APIの実設定だけを使う', async style => {
  const progress = await loadStyleSetupProgress('a', style)
  expect(progress.style).toBe(style)
  expect(values(progress)).toEqual(style === 'standard' ? [true] : style === 'ec' ? [true, true, null, true] : style === 'restaurant' ? [true, true, true, true, true, true] : [true, true, true, true])
  if (style === 'standard') for (const [name, method] of Object.entries(net)) if (!['googleProfile', 'googleConnection'].includes(name)) expect(method).not.toHaveBeenCalled()
  if (style === 'ec') expect(progress.steps.friendAdd?.reason).toContain('商品を確認できる情報がまだありません')
})

it.each(['restaurant', 'salon', 'consult', 'lesson', 'ec'] as const)('%sの取得失敗を設定済みにせず、未確認の理由を渡す', async style => {
  for (const method of Object.values(net)) method.mockRejectedValue(new Error('offline'))
  const progress = await loadStyleSetupProgress('a', style)
  expect(values(progress)).toEqual(style === 'restaurant' ? [null, null, null, null, null, null] : [null, null, null, null])
  for (const step of Object.values(progress.steps)) expect(step?.reason).toBeTruthy()
})

it('読めた未登録はfalse、開催日時や商品の情報が足りない時はnullにする', async () => {
  net.events.mockResolvedValue({ items: [], total: 0 })
  net.members.mockResolvedValue({ success: true, data: [] })
  expect(values(await loadStyleSetupProgress('a', 'lesson'))).toEqual([true, false, false, false])
  net.events.mockResolvedValue({ items: [{ id: 'draft', is_published: 0, next_slot_starts_at: null }], total: 1 })
  expect(values(await loadStyleSetupProgress('a', 'lesson'))).toEqual([true, null, false, false])
  net.snapshot.mockResolvedValue({ success: true, data: { stores: [], tables: [], menuItems: [], inventory: [] } })
  /* リッチメニューは店舗の集計とは別に読むので、店が読めなくても下書きの有無で決まる。 */
  expect(values(await loadStyleSetupProgress('a', 'restaurant'))).toEqual([null, null, null, null, null, true])
})

it('担当者がいてもメニューとの対応や営業時間を確かめないまま受付済みにしない', async () => {
  net.menus.mockResolvedValue({ menus: [{ id: 'menu', is_active: 1 }] })
  expect((await loadStyleSetupProgress('a', 'salon')).steps.scenario?.complete).toBeNull()
  net.menus.mockResolvedValue({ menus: [{ id: 'menu', is_active: 1, assigned_staff: [] }] })
  expect((await loadStyleSetupProgress('a', 'salon')).steps.scenario?.complete).toBe(false)
  net.googleProfile.mockResolvedValue({ success: true, store: { lineAccountId: 'a' }, closed: true, profile: { regularHours: { MONDAY: [{ open: '09:00', close: '18:00' }] } } })
  expect((await loadStyleSetupProgress('a', 'consult')).steps.attributes?.complete).toBe(false)
})

it('別の店の店舗・会員・予約ページを済みの根拠にしない', async () => {
  net.restaurantProgress.mockResolvedValueOnce({ success: true, data: { storeId: 'other-store' } })
  expect((await loadStyleSetupProgress('other', 'restaurant', 'store')).steps.attributes?.complete).toBeNull()
  expect((await loadStyleSetupProgress('other', 'lesson')).steps.friendAdd?.complete).toBe(false)
  net.account.mockResolvedValue({ success: true, data: { id: 'other', liffId: '123-other' } })
  expect((await loadStyleSetupProgress('a', 'consult')).steps.friendAdd?.complete).toBeNull()
  net.googleProfile.mockResolvedValue({ success: true, store: { lineAccountId: 'other' }, closed: false, profile: { regularHours: { MONDAY: [{ open: '09:00', close: '18:00' }] } } })
  expect((await loadStyleSetupProgress('a', 'standard')).steps.hours?.complete).toBeNull()
})

it('予約機能が無い標準業種もGoogle接続だけで営業時間の未設定を判定する', async () => {
  net.googleConnection.mockResolvedValue({ success: true, store: { lineAccountId: 'a' }, connection: { status: 'disconnected', locationName: null } })
  expect((await loadStyleSetupProgress('a', 'standard')).steps.hours?.complete).toBe(false)
  expect(net.googleProfile).not.toHaveBeenCalled()
  expect(net.settings).not.toHaveBeenCalled()
})

it('店を切り替えた直後に証拠をクリアし、遅い旧店舗の返事を捨てる', async () => {
  let resolveOld!: (value: unknown) => void
  net.menus.mockImplementation((id: string) => id === 'a' ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve({ menus: [{ id: 'menu', is_active: 1, assigned_staff: [{ id: 'staff' }] }] }))
  const view = renderHook(({ id }) => useStyleSetupProgress(id, 'salon'), { initialProps: { id: 'a' } })
  view.rerender({ id: 'b' })
  expect(view.result.current.progress?.steps.attributes?.complete).toBeNull()
  await waitFor(() => expect(view.result.current.progress?.steps.attributes?.complete).toBe(true))
  await act(async () => resolveOld({ menus: [] }))
  expect(view.result.current.progress?.steps.attributes?.complete).toBe(true)
  expect(net.menus).toHaveBeenCalledWith('b')
})

it('同じ店でもスタイルが替わったら旧スタイルの遅い返事を流用しない', async () => {
  let resolveOld!: (value: unknown) => void
  net.menus.mockImplementation(() => new Promise(resolve => { resolveOld = resolve }))
  const view = renderHook(({ style }) => useStyleSetupProgress('a', style), { initialProps: { style: 'salon' as 'salon' | 'ec' } })
  view.rerender({ style: 'ec' })
  expect(view.result.current.progress?.style).toBe('ec')
  await waitFor(() => expect(view.result.current.progress?.steps.attributes?.complete).toBe(true))
  await act(async () => resolveOld({ menus: [] }))
  expect(view.result.current.progress?.style).toBe('ec')
  expect(view.result.current.progress?.steps.friendAdd?.complete).toBeNull()
})


it('統括に2店舗・セッションの店舗選択なしでもアカウントに結ばれた1店を読む', async () => {
 net.snapshot.mockResolvedValue({success:true,data:{stores:[{id:'other-store',line_account_id:'other',status:'active'},{id:'store',line_account_id:'a',status:'active'}]}})
 net.context.mockResolvedValue({success:true,data:{selectedStore:null}})
 expect((await loadStyleSetupProgress('a','restaurant')).steps.attributes?.complete).toBe(true)
 expect(net.restaurantProgress).toHaveBeenCalledWith('a','store')
})
it('別の店舗がセッションで選ばれていたら問い合わせず、理由付き未確認にする', async () => {
 net.snapshot.mockResolvedValue({success:true,data:{stores:[{id:'other-store',line_account_id:'other',status:'active'},{id:'store',line_account_id:'a',status:'active'}]}})
 net.context.mockResolvedValue({success:true,data:{selectedStore:{id:'other-store'}}})
 const progress=await loadStyleSetupProgress('a','restaurant')
 expect(progress.steps.attributes?.complete).toBeNull()
 expect(progress.steps.attributes?.reason).toContain('このアカウントの店舗を選んで')
 expect(net.restaurantProgress).not.toHaveBeenCalled()
})

it('追加集計が無ければ実測、あれば送り方と明示した辞退で完了を判断する', async () => {
 const data={storeId:'store',tables:true,hours:true,menus:true,reception:true,followup:false}
 net.restaurantProgress.mockResolvedValue({success:true,data})
 expect((await loadStyleSetupProgress('a','restaurant')).steps.followup?.complete).toBe(false)
 for (const followupSetup of [{notUsing:true,decidedAt:'2026-10-31T00:00:00Z',version:1,anyEnabled:false}, {notUsing:false,decidedAt:null,version:0,anyEnabled:true}]) {
   net.restaurantProgress.mockResolvedValue({success:true,data:{...data,followupSetup}})
   expect((await loadStyleSetupProgress('a','restaurant')).steps.followup?.complete).toBe(true)
 }
 net.restaurantProgress.mockResolvedValue({success:true,data:{...data,followupSetup:{notUsing:false,decidedAt:null,version:0,anyEnabled:false}}})
 expect((await loadStyleSetupProgress('a','restaurant')).steps.followup?.complete).toBe(false)
 net.restaurantProgress.mockResolvedValue({success:true,data:{...data,followupSetup:{notUsing:true,decidedAt:null,version:0,anyEnabled:false}}})
 const progress=await loadStyleSetupProgress('a','restaurant')
 expect(progress.steps.followup?.complete).toBeNull()
 expect(progress.steps.attributes?.complete).toBe(true)
})

it('破損した予約フォームの修復案内を、選んだ店舗のダッシュボードへ渡す',async()=>{
 const message='予約フォームの設定が読めないため、最小の項目で受け付けています。直してください';
 net.restaurantProgress.mockResolvedValue({success:true,data:{storeId:'store',tables:true,hours:true,menus:true,reception:true,followup:true,reservationForm:{available:false,message,repairPath:'/restaurant-test/line-followup?store_id=store&repair_form=1'}}});
 expect((await loadStyleSetupProgress('a','restaurant','store')).notices).toEqual([{message,href:'/restaurant-test/line-followup?store_id=store&repair_form=1'}]);
 net.restaurantProgress.mockResolvedValue({success:true,data:{storeId:'another',tables:true,hours:true,menus:true,reception:true,followup:true,reservationForm:{available:false,message,repairPath:'/other'}}});
 expect((await loadStyleSetupProgress('a','restaurant','store')).notices).toBeUndefined();
});

it('保存後の再確認中は古い済みを消し、先に始まった遅い応答も戻さない', async () => {
  const view = renderHook(() => useStyleSetupProgress('a', 'salon'))
  await waitFor(() => expect(view.result.current.progress?.steps.attributes?.complete).toBe(true))
  let resolveOld!: (value: unknown) => void
  net.menus.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  act(() => view.result.current.reload())
  await waitFor(() => expect(net.menus).toHaveBeenCalledTimes(2))
  act(() => view.result.current.invalidate())
  expect(view.result.current.status).toBe('loading')
  expect(view.result.current.progress?.steps.attributes?.complete).toBeNull()
  await act(async () => { resolveOld({ menus: [{ id: 'menu', is_active: 1, assigned_staff: [{ id: 'staff' }] }] }) })
  expect(view.result.current.status).toBe('loading')
  expect(view.result.current.progress?.steps.attributes?.complete).toBeNull()
})

it('別アカウントや未確定スタイルを挟んで元のアカウントへ戻した時、再取得完了前に古い済みを表示しない', async () => {
  const view = renderHook(({ id, style }) => useStyleSetupProgress(id, style), {
    initialProps: { id: 'a' as string | null, style: 'salon' as 'salon' | null },
  })
  await waitFor(() => expect(view.result.current.status).toBe('ready'))
  expect(view.result.current.progress?.steps.attributes?.complete).toBe(true)

  let resolveB!: (value: unknown) => void
  let resolveA!: (value: unknown) => void
  net.menus
    .mockImplementationOnce(() => new Promise(resolve => { resolveB = resolve }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve }))

  view.rerender({ id: 'b', style: 'salon' })
  expect(view.result.current.status).toBe('loading')
  view.rerender({ id: 'a', style: 'salon' })
  expect(view.result.current.status).toBe('loading')
  expect(view.result.current.progress?.steps.attributes?.complete).toBeNull()

  await act(async () => {
    resolveB({ menus: [] })
    resolveA({ menus: [] })
  })
  await waitFor(() => expect(view.result.current.status).toBe('ready'))
  expect(view.result.current.progress?.steps.attributes?.complete).toBe(false)

  let resolveStyleReload!: (value: unknown) => void
  net.menus.mockImplementationOnce(() => new Promise(resolve => { resolveStyleReload = resolve }))
  view.rerender({ id: 'a', style: null })
  expect(view.result.current.status).toBe('idle')
  view.rerender({ id: 'a', style: 'salon' })
  expect(view.result.current.status).toBe('loading')
  await act(async () => { resolveStyleReload({ menus: [{ id: 'menu', is_active: 1, assigned_staff: [{ id: 'staff' }] }] }) })
  await waitFor(() => expect(view.result.current.status).toBe('ready'))
  expect(view.result.current.progress?.steps.attributes?.complete).toBe(true)
})

it('裏でのrefreshは直前の済みを保ったまま新しい値へ更新する', async () => {
  const view = renderHook(() => useStyleSetupProgress('a', 'salon'))
  await waitFor(() => expect(view.result.current.status).toBe('ready'))
  expect(view.result.current.progress?.steps.attributes?.complete).toBe(true)

  let resolveRefresh!: (value: unknown) => void
  net.menus.mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve }))
  act(() => {
    view.result.current.markStale()
    view.result.current.refresh()
  })
  expect(view.result.current.status).toBe('ready')
  expect(view.result.current.revalidating).toBe(true)
  expect(view.result.current.progress?.steps.attributes?.complete).toBe(true)

  await act(async () => { resolveRefresh({ menus: [] }) })
  await waitFor(() => expect(view.result.current.revalidating).toBe(false))
  expect(view.result.current.status).toBe('ready')
  expect(view.result.current.progress?.steps.attributes?.complete).toBe(false)
})

it('業種進捗でも保存より前に始まったrefreshの応答では結果も確認中の印も変えず、再確認失敗を記録する', async () => {
  const view = renderHook(() => useStyleSetupProgress('a', 'salon'))
  await waitFor(() => expect(view.result.current.status).toBe('ready'))
  expect(view.result.current.progress?.steps.attributes?.complete).toBe(true)

  let resolveEarlier!: (value: unknown) => void
  let resolveNext!: (value: unknown) => void
  net.menus
    .mockImplementationOnce(() => new Promise(resolve => { resolveEarlier = resolve }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveNext = resolve }))

  act(() => view.result.current.refresh())
  act(() => view.result.current.markStale())
  expect(view.result.current.revalidating).toBe(true)

  await act(async () => { resolveEarlier({ menus: [] }) })
  expect(view.result.current.revalidating).toBe(true)
  expect(view.result.current.progress?.steps.attributes?.complete).toBe(true)

  act(() => view.result.current.refresh())
  await act(async () => { resolveNext({ menus: [] }) })
  await waitFor(() => expect(view.result.current.revalidating).toBe(false))
  expect(view.result.current.revalidationStatus).toBe('idle')
  expect(view.result.current.progress?.steps.attributes?.complete).toBe(false)
})

it('他のLINEに紐づく唯一の現役店や古い応答から飲食店の進捗を読まない', async () => {
  net.snapshot.mockResolvedValue({ success: true, data: { stores: [{ id: 'other-store', line_account_id: 'b', status: 'active' }] } });
  net.context.mockResolvedValue({ success: true, data: { selectedStore: null } });
  expect((await loadStyleSetupProgress('a', 'restaurant')).steps.attributes?.complete).toBeNull();
  expect(net.restaurantProgress).not.toHaveBeenCalled();

  net.restaurantProgress.mockResolvedValue({ success: true, data: { storeId: 'store', lineAccountId: 'b', tables: true, hours: true, menus: true, reception: true, followup: true } });
  expect((await loadStyleSetupProgress('a', 'restaurant', 'store')).steps.attributes?.complete).toBeNull();
});

it('ECの進捗確認ではストア接続の応答を待たずにGoogleの接続確認を並列で始める', async () => {
  let resolveConnector!: (value: unknown) => void
  net.connector.mockImplementationOnce(() => new Promise(resolve => { resolveConnector = resolve }))
  const pending = loadStyleSetupProgress('a', 'ec')
  expect(net.connector).toHaveBeenCalledWith('a')
  expect(net.googleConnection).toHaveBeenCalledWith('a')
  resolveConnector({
    success: true,
    data: { configured: true, connector: { status: 'connected', secretConfigured: true, eventTypes: ['ec.order.confirmed'] }, health: { lastSucceededAt: '2026-10-28T00:00:00Z' } },
  })
  const progress = await pending
  expect(progress.steps.attributes?.complete).toBe(true)
  expect(progress.steps.hours?.complete).toBe(true)
})
