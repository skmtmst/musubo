// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import HandgiftRedemptions from './handgift-redemptions'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), role: 'owner' }))
vi.mock('@/lib/api', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/api')>(), fetchApi: mocks.fetch }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => mocks.role, canAdministerRole: (role: string) => role === 'owner' || role === 'admin' }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
function setup(status: string, friendName: string | null = '山田 花子') {
  mocks.role = 'owner'
  mocks.fetch.mockImplementation((_url: string, options?: { method?: string }) => options?.method === 'POST' ? Promise.resolve({ success: true }) : Promise.resolve({ success: true, data: { items: [{ id: 'r1', rewardName: '景品', rewardNameSnapshot: 'マグ', rewardKindSnapshot: 'handgift', beneficiaryFriendId: 'f1', friendName, anonymizedAt: null, createdAt: '2026-11-20', requiredMiles: 500, status }], pagination: { total: 1 } } }))
}
it('渡す前の取消は見ていた状態を指定して確認後に送る', async () => {
  setup('reserved'); render(<HandgiftRedemptions accountId="a" readonly={false} />)
  fireEvent.click(await screen.findByRole('button', { name: '取り消す' }))
  expect(mocks.fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取り消す' }))
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith('/api/mileage/redemptions/r1/hand-cancel', expect.objectContaining({ body: JSON.stringify({ accountId: 'a', expectedStatus: 'reserved', reason: '' }) })))
})
it('渡した後の訂正は理由を必須にし渡した状態を指定する', async () => {
  setup('succeeded'); render(<HandgiftRedemptions accountId="a" readonly={false} />)
  fireEvent.click(await screen.findByRole('button', { name: '渡した記録を取り消す' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取り消す' }))
  expect(await screen.findByText('取り消す理由を入力してください')).toBeTruthy()
  expect(mocks.fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '訂正' } })
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取り消す' }))
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith('/api/mileage/redemptions/r1/hand-cancel', expect.objectContaining({ body: JSON.stringify({ accountId: 'a', expectedStatus: 'succeeded', reason: '訂正' }) })))
})
it('閲覧のみの人には操作を表示しない', async () => {
  setup('reserved'); render(<HandgiftRedemptions accountId="a" readonly />)
  expect(await screen.findByText('山田 花子')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '渡した' })).toBeNull()
  expect(screen.queryByRole('button', { name: '取り消す' })).toBeNull()
})
it('データ削除による取消は返却なしと表示する', async () => {
  setup('cancelled'); render(<HandgiftRedemptions accountId="a" readonly={false} />)
  expect(await screen.findByText('データ削除により取消（マイル返却なし）')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '渡した' })).toBeNull()
})
it('名前未設定の手渡しも交換番号を確認して操作できる', async () => {
  setup('reserved')
  mocks.fetch.mockImplementation((_url: string, options?: { method?: string }) => options?.method === 'POST' ? Promise.resolve({ success: true }) : Promise.resolve({ success: true, data: { items: [{ id: 'r-no-name', rewardName: '景品', rewardNameSnapshot: 'マグ', rewardKindSnapshot: 'handgift', beneficiaryFriendId: 'f1', friendName: null, anonymizedAt: null, requiredMiles: 500, status: 'reserved' }], pagination: { total: 1 } } }))
  render(<HandgiftRedemptions accountId="a" readonly={false} />)
  fireEvent.click(await screen.findByRole('button', { name: '渡した' }))
  expect(screen.getByText(/交換番号/)).toBeTruthy()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '渡した' }))
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith('/api/mileage/redemptions/r-no-name/hand-delivery', expect.objectContaining({ method: 'POST' })))
})
it('取消理由の入力エラーを欄に表示し、編集すると消す', async () => {
  setup('succeeded')
  mocks.fetch.mockImplementation((_url: string, options?: { method?: string }) => options?.method === 'POST'
    ? Promise.reject({ status: 422, fields: { reason: '取消理由を確認してください' } })
    : Promise.resolve({ success: true, data: { items: [{ id: 'r1', rewardName: '景品', rewardNameSnapshot: 'マグ', rewardKindSnapshot: 'handgift', beneficiaryFriendId: 'f1', friendName: '山田 花子', anonymizedAt: null, requiredMiles: 500, status: 'succeeded' }], pagination: { total: 1 } } }))
  render(<HandgiftRedemptions accountId="a" readonly={false} />)
  fireEvent.click(await screen.findByRole('button', { name: '渡した記録を取り消す' }))
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: '訂正' } })
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取り消す' }))
  expect(await screen.findByText('取消理由を確認してください')).toBeTruthy()
  expect(input.getAttribute('aria-invalid')).toBe('true')
  fireEvent.change(input, { target: { value: '訂正します' } })
  await waitFor(() => expect(screen.queryByText('取消理由を確認してください')).toBeNull())
})
it('欄に結び付けられないエラーはダイアログで知らせる', async () => {
  setup('succeeded')
  mocks.fetch.mockImplementation((_url: string, options?: { method?: string }) => options?.method === 'POST'
    ? Promise.reject(Object.assign(new Error('操作を確認してください'), { status: 422, fields: { other: '確認してください' } }))
    : Promise.resolve({ success: true, data: { items: [{ id: 'r1', rewardName: '景品', rewardNameSnapshot: 'マグ', rewardKindSnapshot: 'handgift', beneficiaryFriendId: 'f1', friendName: '山田 花子', anonymizedAt: null, requiredMiles: 500, status: 'succeeded' }], pagination: { total: 1 } } }))
  render(<HandgiftRedemptions accountId="a" readonly={false} />)
  fireEvent.click(await screen.findByRole('button', { name: '渡した記録を取り消す' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '訂正' } })
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取り消す' }))
  expect(await screen.findByText('操作を確認してください')).toBeTruthy()
})

it.each([['山田', '山田 さん'], ['山田さん', '山田さん'], ['山田様', '山田様'], [null, '名前未設定']])('確認画面では %s の敬称を重ねない', async (name, expected) => {
  setup('reserved', name); render(<HandgiftRedemptions accountId="a" readonly={false} />)
  fireEvent.click(await screen.findByRole('button', {name: '渡した'}))
  expect(within(screen.getByRole('dialog')).getByText(new RegExp(`${expected}・マグ`))).toBeTruthy()
})
it('内部エラーの英文を表示せずに操作失敗を知らせる', async () => {
  setup('reserved')
  const original = mocks.fetch.getMockImplementation()!
  mocks.fetch.mockImplementation((url: string, options?: {method?: string}) => options?.method === 'POST' ? Promise.reject(new Error('API error: 500')) : original(url, options))
  render(<HandgiftRedemptions accountId="a" readonly={false} />)
  fireEvent.click(await screen.findByRole('button', {name: '渡した'}))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', {name: '渡した'}))
  expect(await screen.findByText('操作に失敗しました。時間をおいて、もう一度お試しください。')).toBeTruthy()
  expect(screen.queryByText('API error: 500')).toBeNull()
})
