// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { abBlockedReason, splitAudience } from './model'

const choose = vi.fn()
const chooseLive = vi.fn()
vi.mock('./api', () => ({ broadcastAbApi: { result: vi.fn(), chooseLive: (...args: unknown[]) => { chooseLive(...args); return Promise.resolve({ success: true, data: { variant: 'A' } }) }, choose: (...args: unknown[]) => { choose(...args); return Promise.resolve({ success: true, data: { status: 'decided' } }) } } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), usePathname: () => '/', useSearchParams: () => new URLSearchParams() }))

import BroadcastAbResult from './result'
import type { AbResult } from './api'

afterEach(() => { cleanup(); choose.mockClear(); chooseLive.mockClear() })

const undecided: AbResult = {
  status: 'undecided', metric: 'click', decideAfterMinutes: 240, winner: null, confidence: 0.6, decideAt: null, chooseUntil: '2026-11-21T05:00:00.000Z',
  variants: [
    { key: 'A', sent: 405, failed: 0, clicks: 25, clickRate: 0.062, bookings: 3, purchases: null, purchaseAmount: null },
    { key: 'B', sent: 405, failed: 0, clicks: 27, clickRate: 0.066, bookings: 4, purchases: null, purchaseAmount: null },
  ],
  remainder: { count: 3240, scheduledAt: null, sentAt: null },
}
const ab = (result: AbResult) => ({ result, state: 'ready' as const, reload: vi.fn(() => Promise.resolve()) })

describe('G1 A/B の決まり', () => {
  it('試す人数と残り（20% は A・B 10% ずつ、50% は残り無し）', () => {
    expect(splitAudience(4050, 20)).toEqual({ a: 405, b: 405, rest: 3240 })
    expect(splitAudience(4050, 50).rest).toBe(0)
  })
  it('全員への配信・2,000 人未満は使えない（AB-08・AB-09）', () => {
    expect(abBlockedReason(true, 5000)).toBe('all')
    expect(abBlockedReason(false, 1284)).toBe('few')
    expect(abBlockedReason(false, 2400)).toBeNull()
  })
})

describe('A/B の結果（Eoi7q）', () => {
  it('残りへの送信確認で配信元と環境を示す', async () => {
    render(<BroadcastAbResult broadcastId="b1" ab={ab(undecided)} canSend accounts={[{ id: 'a1', name: '銀座店' }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'A を送る' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('銀座店')
    expect(dialog.textContent).toContain('環境')
    expect(choose).not.toHaveBeenCalled()
  })
  it('配信対象が切り替わったら古い送信確認を閉じる', () => {
    const view = render(<BroadcastAbResult broadcastId="b1" ab={ab(undecided)} canSend accounts={[{ id: 'a1', name: '銀座店' }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'A を送る' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    view.rerender(<BroadcastAbResult broadcastId="b2" ab={ab(undecided)} canSend accounts={[{ id: 'a2', name: '新宿店' }]} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(<BroadcastAbResult broadcastId="b1" ab={ab(undecided)} canSend accounts={[{ id: 'a1', name: '銀座店' }]} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(choose).not.toHaveBeenCalled()
  })
  it('決められないときは［A を送る］で確かめの窓を通してから選ぶ（AB-05）', async () => {
    render(<BroadcastAbResult broadcastId="b1" ab={ab(undecided)} canSend accounts={[{ id: 'a1', name: '銀座店' }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'A を送る' }))
    expect(choose).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: '3,240 人に送る' }))
    await waitFor(() => expect(choose).toHaveBeenCalledWith('b1', 'A', 3240, expect.any(String)))
  })
  it('閲覧のみ（送る権限なし）には［A を送る］などを出さない（AB-22）', () => {
    render(<BroadcastAbResult broadcastId="b1" ab={ab(undecided)} canSend={false} accounts={[{ id: 'a1', name: '銀座店' }]} />)
    expect(screen.queryByRole('button', { name: 'A を送る' })).toBeNull()
    expect(screen.getByText(/残りの 3,240 人へ送る案を選んでください/)).toBeTruthy()
  })
})

it('検証送信は人数不足を明示し、確認後だけ実送信の選択を行う', async () => {
  const live: AbResult = { ...undecided, testMode: false, reason: 'delivery_too_small', remainder: { count: 16, scheduledAt: null, sentAt: null } }
  render(<BroadcastAbResult broadcastId="b1" ab={ab(live)} canSend accounts={[{ id: 'a1', name: '銀座店' }]} />)
  expect(screen.getByText(/人数が足りないため決められません/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'B を送る' }))
  expect(chooseLive).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('button', { name: '16 人に送る' }))
  await waitFor(() => expect(chooseLive).toHaveBeenCalledWith('b1', 'B', 16, expect.any(String)))
})
