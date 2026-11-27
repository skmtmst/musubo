// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUberConnection } from './use-uber-connection'

const ubereatsConnection = vi.hoisted(() => vi.fn())
vi.mock('@/lib/restaurant-delivery-api', () => ({
  restaurantDeliveryApi: { ubereatsConnection },
}))

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('useUberConnection 未知状態非強制と選択解除後の古い状態クリア', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('未知の接続状態や欠損応答を未接続と決めつけず null（不明）として返す', async () => {
    ubereatsConnection.mockResolvedValueOnce({ connection: { status: 'mystery_status', lastError: null } })
    const { result, unmount } = renderHook(() => useUberConnection('account-1'))
    await waitFor(() => expect(ubereatsConnection).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(result.current).toBeNull()
    unmount()

    ubereatsConnection.mockResolvedValueOnce({ connection: null })
    const second = renderHook(() => useUberConnection('account-2'))
    await waitFor(() => expect(ubereatsConnection).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(second.result.current).toBeNull()
  })

  it('account-1 → null → account-1 と戻したとき再取得完了前に前回の接続済みを一時表示しない', async () => {
    const secondFetch = deferred<{ connection: { status: string; lastError: null } }>()
    ubereatsConnection
      .mockResolvedValueOnce({ connection: { status: 'connected', lastError: null } })
      .mockReturnValueOnce(secondFetch.promise)

    const { result, rerender } = renderHook(
      ({ accountId }: { accountId: string | null }) => useUberConnection(accountId),
      { initialProps: { accountId: 'account-1' as string | null } },
    )
    await waitFor(() => expect(result.current).toBe('connected'))

    rerender({ accountId: null })
    expect(result.current).toBeNull()

    rerender({ accountId: 'account-1' })
    expect(result.current).toBeNull()

    await act(async () => {
      secondFetch.resolve({ connection: { status: 'disconnected', lastError: null } })
    })
    expect(result.current).toBe('disconnected')
  })
})
