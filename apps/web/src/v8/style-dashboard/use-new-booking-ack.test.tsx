// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNewBookingAck } from './use-new-booking-ack'
import type { StyleSideBooking } from './model'

const mocks = vi.hoisted(() => ({ acknowledge: vi.fn(), undo: vi.fn(), toast: vi.fn() }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { acknowledgeNewBookings: mocks.acknowledge, undoNewBookingsAcknowledgement: mocks.undo } }))
vi.mock('@/components/shared/toast', () => ({ notifyToast: mocks.toast }))
const row = (id: string): StyleSideBooking => ({ id, name: id, when: '18:00', people: 2, source: 'line', storeId: 'store-1' })
beforeEach(() => { vi.clearAllMocks(); mocks.acknowledge.mockResolvedValue({ data: { acknowledgedCount: 1 } }); mocks.undo.mockResolvedValue({ data: { undoneCount: 1 } }) })

describe('新着予約の確認', () => {
  it('渡された行だけを個別に確認し、操作IDで元に戻す', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useNewBookingAck('account', refresh))
    await act(() => result.current.acknowledge([row('a'), row('b')]))
    expect(mocks.acknowledge).toHaveBeenCalledTimes(2)
    const first = mocks.acknowledge.mock.calls[0][1]
    expect(first).toMatchObject({ bookingId: 'a', storeId: 'store-1' })
    expect(first.operationId).toBeTruthy()
    expect(mocks.acknowledge.mock.calls[1][1].bookingId).toBe('b')
    expect(mocks.toast).toHaveBeenCalledWith('2件を確認済みにしました', expect.objectContaining({ actionLabel: '元に戻す' }))
    await act(async () => { mocks.toast.mock.calls[0][1].onAction(); await waitFor(() => expect(mocks.undo).toHaveBeenCalledTimes(2)) })
    expect(mocks.undo).toHaveBeenCalledWith('account', first.operationId, 'store-1')
    expect(refresh).toHaveBeenCalled()
  })
  it('失敗した行を戻し、理由を知らせる', async () => {
    mocks.acknowledge.mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useNewBookingAck('account', vi.fn().mockResolvedValue(undefined)))
    await act(() => result.current.acknowledge([row('a')]))
    expect(result.current.pending).toEqual([])
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('確認済みにできませんでした'), expect.objectContaining({ tone: 'error' }))
  })
  it('処理中の二重押しを送らない', async () => {
    let finish!: (value: unknown) => void
    mocks.acknowledge.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const { result } = renderHook(() => useNewBookingAck('account'))
    let operation!: Promise<void>
    act(() => { operation = result.current.acknowledge([row('a')]); void result.current.acknowledge([row('a')]) })
    expect(mocks.acknowledge).toHaveBeenCalledTimes(1)
    await act(async () => { finish({ data: { acknowledgedCount: 1 } }); await operation })
  })
})
