// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
const mock = vi.hoisted(() => ({ list: vi.fn(), extend: vi.fn(), role: 'owner' }))
vi.mock('@/lib/api/helpers/gap2', () => ({ bookingMakeupApi: { listByStore: mock.list, extend: mock.extend } }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => mock.role, canAdministerRole: (role: string) => role === 'owner' || role === 'admin' }))
vi.mock('@/components/shared/date-field', () => ({ default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <input aria-label="新しい期限" value={value} onChange={e => onChange(e.target.value)} /> }))
import MakeupCredits from './makeup-credits'
const credit = { id: 'credit', line_account_id: 'a', friend_id: 'f', source_event_booking_id: 'b', source_event_id: 'e', expires_at: '2026-11-30T14:59:59Z', status: 'open', used_event_booking_id: null, version: 3 }
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-19T00:00:00Z')); mock.role = 'owner'; mock.list.mockResolvedValue({ data: [credit] }) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })
async function open() { render(<MakeupCredits accountId="a" friendId="f" canEdit />); fireEvent.click(await screen.findByRole('button', { name: '期限を延ばす' })); return screen.getByRole('dialog', { name: '振替の期限を延ばす' }) }
it('理由と現在より後の期限が必要で、確認した版を送る', async () => {
  mock.extend.mockResolvedValue({ success: true })
  const dialog = await open()
  fireEvent.change(within(dialog).getByLabelText('新しい期限'), { target: { value: '2026-11-29' } })
  fireEvent.change(within(dialog).getByLabelText('理由'), { target: { value: '休講' } })
  expect(within(dialog).getByRole('button', { name: '期限を延ばす' }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(within(dialog).getByLabelText('新しい期限'), { target: { value: '2026-12-31' } })
  fireEvent.change(within(dialog).getByLabelText('理由'), { target: { value: '' } })
  expect(within(dialog).getByRole('button', { name: '期限を延ばす' }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(within(dialog).getByLabelText('理由'), { target: { value: '休講' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '期限を延ばす' }))
  await waitFor(() => expect(mock.extend).toHaveBeenCalledWith('a', 'credit', { expiresAt: '2026-12-31T14:59:59.000Z', reason: '休講', expectedVersion: 3 }))
})
it('先に更新された場合は再送せず、最新の情報を読み直す', async () => {
  mock.extend.mockRejectedValue(new ApiError(409, undefined, 'version_conflict'))
  const dialog = await open()
  fireEvent.change(within(dialog).getByLabelText('新しい期限'), { target: { value: '2026-12-31' } })
  fireEvent.change(within(dialog).getByLabelText('理由'), { target: { value: '休講' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '期限を延ばす' }))
  const conflict = await screen.findByRole('alert')
  expect(conflict.textContent).toContain('振替の状態が変わりました')
  fireEvent.click(within(conflict).getByRole('button', { name: '最新を読み込んで続ける' }))
  await waitFor(() => expect(mock.list).toHaveBeenCalledTimes(2))
  expect(mock.extend).toHaveBeenCalledTimes(1)
})
it('管理者以外は期限を延ばせない', async () => {
  mock.role = 'staff'
  render(<MakeupCredits accountId="a" friendId="f" canEdit />)
  const button = await screen.findByRole('button', { name: '期限を延ばす' })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent).toContain('オーナー・管理者のみ')
  fireEvent.click(button)
  expect(screen.queryByRole('dialog', { name: '振替の期限を延ばす' })).toBeNull()
  expect(mock.extend).not.toHaveBeenCalled()
})

it('状態が変わった409でも最新の一覧を確認できる', async () => {
  mock.extend.mockRejectedValue(new ApiError(409, undefined, 'invalid_credit_status'))
  const dialog = await open()
  fireEvent.change(within(dialog).getByLabelText('新しい期限'), { target: { value: '2026-12-31' } })
  fireEvent.change(within(dialog).getByLabelText('理由'), { target: { value: '休講' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '期限を延ばす' }))
  const conflict = await screen.findByRole('alert')
  expect(conflict.textContent).toContain('振替の状態が変わりました')
  fireEvent.click(within(conflict).getByRole('button', { name: '最新を読み込んで続ける' }))
  await waitFor(() => expect(mock.list).toHaveBeenCalledTimes(2))
})
