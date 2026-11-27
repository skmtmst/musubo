// @vitest-environment happy-dom
import React, { StrictMode } from 'react'
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Shell, { type RestaurantV8Context } from './shell'
import { useStoreToday, type StoreToday } from '../dashboard/use-store-today'
import { useTableDefinition } from './use-table-definition'
import { snapshotOf } from './test-data'
import type { RestaurantSnapshot } from '@/lib/restaurant-test-api'
const fx = vi.hoisted(() => ({ account: 'account-1', snapshot: vi.fn(), storeContext: vi.fn(), rotation: vi.fn(), reservationsDay: vi.fn(), mediaLinks: vi.fn(), channelCloseTasks: vi.fn(), openingHours: vi.fn() }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fx }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fx.account, accounts: [] }) }))
vi.mock('@/lib/api', async original => ({ ...(await original<typeof import('@/lib/api')>()), fetchApi: vi.fn().mockResolvedValue({ data: [] }) }))
vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: { connection: vi.fn().mockRejectedValue(new Error('offline')) } }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/restaurant-test', useSearchParams: () => new URLSearchParams() }))
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function snap(account = 'account-1') { const data = snapshotOf() as RestaurantSnapshot; return { ...data, organization: { ...data.organization!, account_id: account } } }
afterEach(() => { cleanup(); vi.useRealTimers() })
beforeEach(() => {
  vi.clearAllMocks(); fx.account = 'account-1'
  fx.storeContext.mockResolvedValue({ data: {} }); fx.rotation.mockResolvedValue({ data: null })
  fx.reservationsDay.mockResolvedValue({ data: { reservations: [] } }); fx.mediaLinks.mockResolvedValue({ data: [] }); fx.channelCloseTasks.mockResolvedValue({ data: [] }); fx.openingHours.mockResolvedValue({ data: { hours: [] } })
})
it('表示期間 A→B→A は古い取得を再利用せず、未指定/参照不一致も出さない', () => {
  const data = snap(); const renders: boolean[] = []
  const h = renderHook(({ account, snapshot }) => { const x = useTableDefinition(account, snapshot); renders.push(Boolean(x.tableDefinition)); return x }, { initialProps: { account: 'account-1', snapshot: data } })
  expect(h.result.current.tableDefinition).toBeUndefined()
  act(() => { const request = h.result.current.begin('account-1'); h.result.current.accept(request, data) })
  expect(h.result.current.tableDefinition?.snapshot).toBe(data)
  h.rerender({ account: 'account-2', snapshot: data }); expect(h.result.current.tableDefinition).toBeUndefined()
  renders.length = 0; h.rerender({ account: 'account-1', snapshot: data }); expect(renders.every(value => !value)).toBe(true)
  h.rerender({ account: 'account-1', snapshot: data }); expect(h.result.current.tableDefinition).toBeUndefined()
  act(() => { const request = h.result.current.begin('account-1'); h.result.current.accept(request, data) })
  h.rerender({ account: 'account-1', snapshot: snap() }); expect(h.result.current.tableDefinition).toBeUndefined()
})
for (const entry of ['shell', 'today'] as const) {
  it(`${entry}: 既存loadの回数を保ち、取得中・失敗後は古い卓の理由を出さない`, async () => {
    const data = snap(); fx.snapshot.mockResolvedValueOnce({ data })
    let current!: RestaurantV8Context | StoreToday
    if (entry === 'shell') render(<Shell boardId="fixture" title="fixture" description="fixture">{ctx => { current = ctx; return <span>loaded</span> }}</Shell>)
    else renderHook(() => { current = useStoreToday(fx.account); return current })
    await waitFor(() => expect(current?.tableDefinition?.snapshot).toBe(data))
    expect(fx.snapshot).toHaveBeenCalledTimes(1)
    const next = deferred<{ data: RestaurantSnapshot }>(); fx.snapshot.mockReturnValueOnce(next.promise)
    let reload!: Promise<void>; act(() => { reload = current.reload() })
    expect(current.tableDefinition).toBeUndefined(); expect('snapshot' in current ? current.snapshot : current.data).toBe(data)
    await act(async () => { next.reject(new Error('refresh failed')); await reload })
    expect(current.tableDefinition).toBeUndefined()
    expect(fx.snapshot).toHaveBeenCalledTimes(2)
    if (entry === 'today') {
      // 店舗の確認が失敗したら前の店を読み直さず、失敗を表示する。
      await waitFor(() => expect((current as StoreToday).error).toBeTruthy())
      expect(current.tableDefinition).toBeUndefined()
    }
  })
  it(`${entry}: 同accountの逆順成功・失敗と旧応答のfinallyは最新の説明状態を上書きしない`, async () => {
    fx.snapshot.mockResolvedValueOnce({ data: snap() }); let current!: RestaurantV8Context | StoreToday
    if (entry === 'shell') render(<Shell boardId="fixture" title="fixture" description="fixture">{ctx => { current = ctx; return null }}</Shell>)
    else renderHook(() => { current = useStoreToday(fx.account); return current })
    await waitFor(() => expect(current?.tableDefinition).toBeDefined())
    const first = deferred<{ data: RestaurantSnapshot }>(); const second = deferred<{ data: RestaurantSnapshot }>(); const newest = snap()
    fx.snapshot.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    let one!: Promise<void>; let two!: Promise<void>
    act(() => { one = current.reload(); two = current.reload() })
    await act(async () => { second.resolve({ data: newest }); await two })
    expect(current.tableDefinition?.snapshot).toBe(newest)
    await act(async () => { first.reject(new Error('old failed')); await one })
    expect(current.tableDefinition?.snapshot).toBe(newest)
    const old = deferred<{ data: RestaurantSnapshot }>(); const latest = deferred<{ data: RestaurantSnapshot }>(); fx.snapshot.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
    act(() => { one = current.reload(); two = current.reload() })
    await act(async () => { latest.resolve({ data: newest }); await two })
    await act(async () => { old.resolve({ data: snap() }); await one })
    expect(current.tableDefinition?.snapshot).toBe(newest)
    expect(fx.snapshot).toHaveBeenCalledTimes(5)
  })
  it(`${entry}: account A→B→A の保持data・旧応答から理由を復活させず通常要求だけを使う`, async () => {
    const a = snap(); fx.snapshot.mockResolvedValueOnce({ data: a }); let current!: RestaurantV8Context | StoreToday; const seen: boolean[] = []
    const draw = () => <Shell boardId="fixture" title="fixture" description="fixture">{ctx => { current = ctx; seen.push(Boolean(ctx.tableDefinition)); return null }}</Shell>
    const rerender = entry === 'shell'
      ? (() => { const view = render(draw()); return () => view.rerender(draw()) })()
      : (() => { const view = renderHook(() => { current = useStoreToday(fx.account); seen.push(Boolean(current.tableDefinition)); return current }); return () => view.rerender() })()
    await waitFor(() => expect(current?.tableDefinition).toBeDefined())
    const b = deferred<{ data: RestaurantSnapshot }>(); const again = deferred<{ data: RestaurantSnapshot }>(); fx.snapshot.mockReturnValueOnce(b.promise).mockReturnValueOnce(again.promise)
    fx.account = 'account-2'; act(() => { rerender() }); expect(current.tableDefinition).toBeUndefined()
    seen.length = 0; fx.account = 'account-1'; act(() => { rerender() }); expect(seen.every(value => !value)).toBe(true)
    await act(async () => { b.resolve({ data: snap('account-2') }) }); expect(current.tableDefinition).toBeUndefined()
    const fresh = snap(); await act(async () => { again.resolve({ data: fresh }) })
    await waitFor(() => expect(current.tableDefinition?.snapshot).toBe(fresh))
    expect(fx.snapshot).toHaveBeenCalledTimes(3)
  })
}
it('StrictModeの二回描画でも最新通常取得の説明が残り、取得を増やさない', async () => {
  fx.snapshot.mockResolvedValue({ data: snap() }); let today!: StoreToday
  renderHook(() => { today = useStoreToday('account-1') }, { wrapper: StrictMode })
  await waitFor(() => expect(today.tableDefinition).toBeDefined())
  expect(fx.snapshot).toHaveBeenCalledTimes(2)
})
it('店舗の選択を確認できなくても全体情報は残し、選択後に読み直せる', async () => {
  const data = snap()
  data.stores = [...data.stores, { ...data.stores[0], id: 'store-2' }]
  fx.snapshot.mockResolvedValue({ data })
  fx.storeContext.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: { selectedStore: null } }).mockResolvedValue({ data: { selectedStore: { id: 'store-2' } } })
  const h = renderHook(() => useStoreToday('account-1'))
  await waitFor(() => expect(h.result.current.error).toBeTruthy())
  expect(h.result.current.snapshot).toBe(data)
  expect(fx.reservationsDay).not.toHaveBeenCalled()
  await act(async () => { await h.result.current.reload() })
  expect(h.result.current.error).toBeTruthy()
  expect(fx.reservationsDay).not.toHaveBeenCalled()
  await act(async () => { await h.result.current.reload() })
  await waitFor(() => expect(fx.reservationsDay).toHaveBeenCalledWith('account-1', 'store-2', expect.any(String)))
  expect(h.result.current.error).toBeNull()
})
