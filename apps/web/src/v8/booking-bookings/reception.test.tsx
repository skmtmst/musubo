// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import BookingReception from './reception'
const mocks = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/lib/api', () => ({ bookingApi: { listRequests: mocks.list } }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a' }) }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const row = { id: 'b', friend_name: '山田', status: 'requested', staff_id: 's', staff_name: '佐藤', menu_name: '相談', starts_at: '2026-11-20T05:00:00Z' }
it('今日以降の承認待ちをページ単位で読み、詳細を開く', async () => {
  mocks.list.mockResolvedValue({ total: 1, requests: [row] })
  const open = vi.fn(); render(<BookingReception onOpen={open} />)
  fireEvent.click(await screen.findByRole('button', { name: '山田' }))
  expect(open).toHaveBeenCalledWith('b')
  expect(mocks.list).toHaveBeenCalledWith('a', 'requested', expect.objectContaining({ limit: 20, offset: 0, from: expect.any(String) }))
  expect(screen.queryByText(/未割り当て/)).toBeNull()
  expect(screen.queryByRole('button', { name: /未割り当て/ })).toBeNull()
})
it('読み込み失敗を0件として表示しない', async () => {
  mocks.list.mockRejectedValue(new Error('offline')); render(<BookingReception onOpen={() => {}} />)
  expect(await screen.findByText('予約受付を読み込めませんでした')).toBeTruthy()
  expect(screen.queryByText('今日以降の承認待ちはありません')).toBeNull()
})
it('詳細を閉じた後に再読込する', async () => {
  mocks.list.mockResolvedValue({ total: 1, requests: [row] })
  const view = render(<BookingReception onOpen={() => {}} refreshKey="b" />)
  await screen.findByText('山田')
  view.rerender(<BookingReception onOpen={() => {}} />)
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
})
