// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  snapshot: vi.fn(),
  storeContext: vi.fn(),
  rotation: vi.fn(),
  reservationsDay: vi.fn(),
  mediaLinks: vi.fn(),
  channelCloseTasks: vi.fn(),
  openingHours: vi.fn(),
  googleConnection: vi.fn(),
  listReviews: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ fetchApi: fx.fetchApi }))
vi.mock('@/lib/restaurant-test-api', () => ({
  restaurantTestApi: {
    snapshot: fx.snapshot,
    storeContext: fx.storeContext,
    rotation: fx.rotation,
    reservationsDay: fx.reservationsDay,
    mediaLinks: fx.mediaLinks,
    channelCloseTasks: fx.channelCloseTasks,
    openingHours: fx.openingHours,
  },
}))
vi.mock('@/lib/restaurant-google-api', () => ({
  restaurantGoogleApi: {
    connection: fx.googleConnection,
    listReviews: fx.listReviews,
  },
}))
vi.mock('../booking-kit/use-table-definition', () => ({
  useTableDefinition: () => ({
    begin: () => 1,
    accept: vi.fn(),
    tableDefinition: undefined,
  }),
}))

import { loadStoreMedia, useStoreToday } from './use-store-today'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('useStoreToday アカウント切替時の旧店舗データ破棄と媒体応答検証', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fx.fetchApi.mockResolvedValue({ success: true, data: [{ code: 'tabelog', name: '食べログ', receiveMethod: 'email' }] })
    fx.mediaLinks.mockResolvedValue({ success: true, data: [{ code: 'tabelog', name: '食べログ', pageUrl: 'https://example.com', loginUrl: null }] })
    fx.snapshot.mockResolvedValue({
      data: {
        stores: [{ id: 'store-a', line_account_id: 'acc-a', status: 'active', name: 'A店' }],
      },
    })
    fx.storeContext.mockResolvedValue({ data: { selectedStore: { id: 'store-a' } } })
    fx.rotation.mockResolvedValue({ data: { total: 1 } })
    fx.reservationsDay.mockResolvedValue({ data: { reservations: [{ id: 'res-a', guest_name: 'A顧客' }] } })
    fx.channelCloseTasks.mockResolvedValue({ data: [{ id: 'task-a' }] })
    fx.openingHours.mockResolvedValue({ data: { hours: [{ day: 'mon', open: '11:00', close: '22:00' }] } })
    fx.googleConnection.mockResolvedValue({
      connection: { status: 'connected' },
      summary: { unrepliedCount: 1 },
    })
    fx.listReviews.mockResolvedValue({ reviews: [{ id: 'rev-a', comment: 'A店の口コミ' }] })
  })

  afterEach(() => {
    cleanup()
  })

  it('アカウント切替・選択解除時に前店舗の予約・媒体・営業時間・Google口コミを残さない', async () => {
    const { result, rerender } = renderHook(
      ({ accountId }: { accountId: string | null }) => useStoreToday(accountId),
      { initialProps: { accountId: 'acc-a' as string | null } },
    )

    await waitFor(() => {
      expect(result.current.today).toHaveLength(1)
      expect(result.current.media).toHaveLength(1)
      expect(result.current.hours).toHaveLength(1)
      expect(result.current.latestReview?.id).toBe('rev-a')
    })

    const pendingSnap = deferred<unknown>()
    const pendingGoogle = deferred<unknown>()
    fx.snapshot.mockReturnValueOnce(pendingSnap.promise)
    fx.googleConnection.mockReturnValueOnce(pendingGoogle.promise)

    rerender({ accountId: 'acc-b' })
    expect(result.current.today).toBeNull()
    expect(result.current.media).toBeNull()
    expect(result.current.closeTasks).toBeNull()
    expect(result.current.hours).toBeNull()
    expect(result.current.google).toBeNull()
    expect(result.current.latestReview).toBeNull()
    expect(result.current.oldestReview).toBeNull()

    rerender({ accountId: null })
    expect(result.current.today).toBeNull()
    expect(result.current.snapshot).toBeNull()
    expect(result.current.google).toBeNull()

    await act(async () => {
      pendingSnap.resolve({ data: { stores: [] } })
      pendingGoogle.resolve({ connection: { status: 'disconnected' }, summary: { unrepliedCount: 0 } })
    })
  })

  it('loadStoreMedia は配列でない不正な媒体応答で TypeError ではなく明示的なエラーを返す', async () => {
    fx.fetchApi.mockResolvedValueOnce({ success: true, data: null })
    await expect(loadStoreMedia('acc-a', 'store-a')).rejects.toThrow('invalid_channels_response')

    fx.fetchApi.mockResolvedValueOnce({ success: true, data: [] })
    fx.mediaLinks.mockResolvedValueOnce({ success: true, data: 'broken' })
    await expect(loadStoreMedia('acc-a', 'store-a')).rejects.toThrow('invalid_media_links_response')
  })
})
