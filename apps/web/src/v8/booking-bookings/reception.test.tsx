// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import BookingReception from './reception'
const mocks = vi.hoisted(() => ({ list: vi.fn(), review: vi.fn() }))
vi.mock('@/lib/api', () => ({ bookingApi: { listRequests: mocks.list, reviewAssignment: mocks.review } }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a' }) }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const row = (id: string, status: string, method: string) => ({ id, friend_name: id, status, assignment_method: method, assignment_reviewed_at: null, lock_version: 0, staff_id: 's', staff_name: '佐藤', menu_name: '相談', starts_at: '2026-11-20T05:00:00Z' })
function seed() {
  const rows = [row('待ち', 'requested', 'unknown'), row('自動', 'confirmed', 'automatic'), row('予約', 'confirmed', 'manual')]
  mocks.list.mockImplementation(async (_account: string, _status: string, params: { reception: string; limit: number; offset: number }) => {
    const selected = rows.filter(r => params.reception === 'all' || params.reception === 'requested' && r.status === 'requested' || params.reception === 'unassigned' && r.assignment_method === 'automatic' || params.reception === 'attention' && (r.status === 'requested' || r.assignment_method === 'automatic'))
    return { total: selected.length, requestedCount: 1, unassignedCount: 1, attentionCount: 2, unknownCount: 1, requests: selected.slice(params.offset, params.offset + params.limit) }
  })
}
it('要対応と未割り当てを分けて表示し担当確認を送る', async () => {
  seed(); mocks.review.mockResolvedValue({ success: true }); render(<BookingReception onOpen={() => {}} canOperate />)
  expect(await screen.findByText('要対応 2件・未割り当て 1件・承認待ち 1件（今日以降）')).toBeTruthy()
  expect(screen.getByText(/記録前の予約/)).toBeTruthy()
  expect(screen.getAllByText('11/20（金）14:00')).toHaveLength(3)
  const tabs = screen.getByRole('group', { name: '予約受付の絞り込み' })
  fireEvent.click(within(tabs).getByRole('button', { name: '未割り当て' }))
  await waitFor(() => expect(screen.queryByText('待ち')).toBeNull())
  expect(await screen.findByText('自動')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '担当を確認' }))
  expect(screen.getByText('佐藤さんが担当する予約として確認します。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '確認した' }))
  await waitFor(() => expect(mocks.review).toHaveBeenCalledWith('a', '自動', 0))
})
it('閲覧のみの人には確認操作を出さない', async () => {
  seed(); render(<BookingReception onOpen={() => {}} />)
  await screen.findByText('自動')
  expect(screen.queryByRole('button', { name: '担当を確認' })).toBeNull()
})
it('読み込み失敗を0件として表示しない', async () => {
  mocks.list.mockRejectedValue(new Error('offline')); render(<BookingReception onOpen={() => {}} />)
  expect(await screen.findByText('予約受付を読み込めませんでした')).toBeTruthy()
})
it('詳細を開き、閉じた後は一覧を読み直す', async () => {
  seed(); const open = vi.fn(); const view = render(<BookingReception onOpen={open} refreshKey="before" />)
  fireEvent.click(await screen.findByRole('button', { name: '待ち' }))
  expect(open).toHaveBeenCalledWith('待ち')
  const before = mocks.list.mock.calls.length
  view.rerender(<BookingReception onOpen={open} refreshKey="after" />)
  await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThan(before))
})
it('件数が減って最後のページがなくなれば前のページに戻る', async () => {
  const rows = Array.from({ length: 21 }, (_, i) => row(`待ち${i}`, 'requested', 'unknown'))
  let total = 21
  mocks.list.mockImplementation(async (_account: string, _status: string, params: { offset: number; limit: number }) => ({ total, requestedCount: total, unassignedCount: 0, attentionCount: total, unknownCount: total, requests: rows.slice(params.offset, Math.min(total, params.offset + params.limit)) }))
  const view = render(<BookingReception onOpen={() => {}} refreshKey="before" />)
  await screen.findByText('待ち0')
  fireEvent.click(screen.getByRole('button', { name: /次/ }))
  await screen.findByText('待ち20')
  total = 1
  view.rerender(<BookingReception onOpen={() => {}} refreshKey="after" />)
  expect(await screen.findByText('待ち0')).toBeTruthy()
  expect(screen.queryByText('今日以降の該当する予約はありません')).toBeNull()
})
it('記録前の予約を件数の注記と空の表示で伝える', async () => {
  mocks.list.mockResolvedValue({ requests: [row('記録前', 'confirmed', 'unknown')], total: 1, requestedCount: 0, unassignedCount: 0, attentionCount: 0, unknownCount: 1 })
  render(<BookingReception onOpen={() => {}} />)
  expect(await screen.findByText(/未割り当て 0件/)).toBeTruthy()
  expect(screen.getByText(/記録前の予約/)).toBeTruthy()
  mocks.list.mockResolvedValue({ requests: [], total: 0, requestedCount: 0, unassignedCount: 0, attentionCount: 0, unknownCount: 1 })
  fireEvent.click(within(screen.getByRole('group', {name:'予約受付の絞り込み'})).getByRole('button', {name:'未割り当て'}))
  expect(await screen.findByText('担当の記録前の予約があるため、すべては確認できません')).toBeTruthy()
  expect(screen.queryByText('今日以降の該当する予約はありません')).toBeNull()
})
it('記録前がなければ未割り当て0件と表示する', async () => {
  mocks.list.mockResolvedValue({ requests: [], total: 0, requestedCount: 0, unassignedCount: 0, attentionCount: 0, unknownCount: 0 })
  render(<BookingReception onOpen={() => {}} />)
  expect(await screen.findByText(/未割り当て 0件/)).toBeTruthy()
})
it('担当者名に敬称があれば確認画面で重ねない', async () => {
  const reservation = { ...row('自動', 'confirmed', 'automatic'), staff_name: '佐藤さん' }
  mocks.list.mockResolvedValue({ requests: [reservation], total: 1, requestedCount: 0, unassignedCount: 1, attentionCount: 1, unknownCount: 0 })
  render(<BookingReception onOpen={() => {}} canOperate />)
  fireEvent.click(await screen.findByRole('button', { name: '担当を確認' }))
  expect(screen.getByText('佐藤さんが担当する予約として確認します。')).toBeTruthy()
})
