// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import BookingReception from './reception'
const mocks = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/lib/api', () => ({ bookingApi: { listRequests: mocks.list } }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a' }) }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const row = (id: string, name: string, status: string) => ({ id, friend_name: name, status, staff_id: 's', staff_name: '佐藤', menu_name: '相談', starts_at: '2026-11-20T05:00:00Z' })
function seed(requested = [row('b', '山田', 'requested')], confirmed = [row('c', '鈴木', 'confirmed')]) {
  mocks.list.mockImplementation(async (_account: string, status: string, params: { limit: number; offset: number }) => {
    const rows = status === 'requested' ? requested : confirmed
    return { total: rows.length, requests: rows.slice(params.offset, params.offset + params.limit) }
  })
}
it('すべてでは承認待ちを先に表示し、承認待ちだけに絞る', async () => {
  seed(); const open = vi.fn(); render(<BookingReception onOpen={open} />)
  expect(await screen.findByText('承認待ち 1件（今日以降）')).toBeTruthy()
  const rows = within(screen.getByRole('table')).getAllByRole('row')
  expect(within(rows[1]).getByText('山田')).toBeTruthy()
  expect(within(rows[2]).getByText('鈴木')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '山田' })); expect(open).toHaveBeenCalledWith('b')
  const tabs = screen.getByRole('group', { name: '予約受付の絞り込み' })
  fireEvent.click(within(tabs).getByRole('button', { name: '承認待ち' }))
  await waitFor(() => expect(screen.queryByText('鈴木')).toBeNull())
  expect(await screen.findByText('山田')).toBeTruthy()
  expect(within(tabs).queryByRole('button', { name: '要対応' })).toBeNull()
  expect(screen.queryByText(/未割り当て/)).toBeNull()
  expect(mocks.list).toHaveBeenCalledWith('a', 'requested', expect.objectContaining({ from: expect.any(String) }))
})
it('すべての2ページ目でも承認待ちを確定予約より先に並べる', async () => {
  seed(Array.from({ length: 21 }, (_, i) => row(`r${i}`, `待ち${i}`, 'requested')), [row('c', '確定客', 'confirmed')])
  render(<BookingReception onOpen={() => {}} />)
  expect(await screen.findByText('待ち0')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /次/ }))
  const name = await screen.findByText('待ち20')
  const rows = within(name.closest('table')!).getAllByRole('row')
  expect(within(rows[1]).getByText('待ち20')).toBeTruthy()
  expect(within(rows[2]).getByText('確定客')).toBeTruthy()
})
it('読み込み失敗を0件として表示しない', async () => {
  mocks.list.mockRejectedValue(new Error('offline')); render(<BookingReception onOpen={() => {}} />)
  expect(await screen.findByText('予約受付を読み込めませんでした')).toBeTruthy()
  expect(screen.queryByText('今日以降の該当する予約はありません')).toBeNull()
})
it('詳細を閉じた後に再読込する', async () => {
  seed(); const view = render(<BookingReception onOpen={() => {}} refreshKey="b" />)
  await screen.findByText('山田'); const before = mocks.list.mock.calls.length
  view.rerender(<BookingReception onOpen={() => {}} />)
  await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThan(before))
})

it('予約が減り最終ページが無くなれば有効なページに戻る', async () => {
  seed(Array.from({ length: 21 }, (_, i) => row(`r${i}`, `待ち${i}`, 'requested')), [])
  const view = render(<BookingReception onOpen={() => {}} refreshKey="before" />)
  expect(await screen.findByText('待ち0')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /次/ }))
  expect(await screen.findByText('待ち20')).toBeTruthy()
  seed([row('r0', '待ち0', 'requested')], [])
  view.rerender(<BookingReception onOpen={() => {}} refreshKey="after" />)
  expect(await screen.findByText('待ち0')).toBeTruthy()
  expect(screen.queryByText('今日以降の該当する予約はありません')).toBeNull()
})
