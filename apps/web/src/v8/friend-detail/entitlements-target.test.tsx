// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ operate: vi.fn(), grant: vi.fn() }))
vi.mock('@/lib/api/helpers/booking-entitlements', () => ({ bookingEntitlementsApi: api }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: async () => ({ success: true, data: [{ id: 'account-a', name: '確認用の店' }] }) }))
vi.mock('@/lib/use-running-version', () => ({ useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '' }) }))
import { EntitlementDialog } from './entitlements'

afterEach(() => { cleanup(); vi.clearAllMocks() })
const ticket = { id: 'ticket-1', name: 'カット券', kind: 'ticket', remaining: 5, expires_at: '2027-01-01T00:00:00.000Z', version: 3, status: 'active' }
const initial = { action: 'revoke', id: 'ticket-1' } as const
const props = { open: true, initial, accountId: 'account-a', friendId: 'friend-a', friendName: '確認用の友だち', items: [ticket] as never, onClose: () => {}, onDone: () => {} }

it('取消の窓に本人・アカウント・環境を表示する', async () => {
  render(<EntitlementDialog {...props} />)
  const dialog = await screen.findByRole('dialog', { name: '回数券を手で入れる' })
  expect(dialog.textContent).toContain('確認用の友だち')
  expect(dialog.textContent).toContain('LINEアカウント')
  expect(dialog.textContent).toContain('環境')
})

it('アカウントが変わったら古い窓から取り消さない', async () => {
  const view = render(<EntitlementDialog {...props} />)
  const dialog = await screen.findByRole('dialog', { name: '回数券を手で入れる' })
  fireEvent.change(within(dialog).getByLabelText('理由'), { target: { value: '返金のため' } })
  view.rerender(<EntitlementDialog {...props} accountId="account-b" />)
  const stale = screen.queryByRole('dialog', { name: '回数券を手で入れる' })
  if (stale) fireEvent.click(within(stale).getByRole('button', { name: '取り消す' }))
  await waitFor(() => expect(api.operate).not.toHaveBeenCalled())
})

it('表示中に回数券の版が変わったら新しい版を使って取り消さない', async () => {
  const view = render(<EntitlementDialog {...props} />)
  const dialog = await screen.findByRole('dialog', { name: '回数券を手で入れる' })
  fireEvent.change(within(dialog).getByLabelText('理由'), { target: { value: '返金のため' } })
  view.rerender(<EntitlementDialog {...props} items={[{ ...ticket, version: 4 }] as never} />)
  fireEvent.click(within(dialog).getByRole('button', { name: '取り消す' }))
  await waitFor(() => expect(api.operate.mock.calls.every(call => call[2].expectedVersion !== 4)).toBe(true))
})

it('確認したアカウントと版を指定して回数券を取り消す', async () => {
  api.operate.mockResolvedValue({ success: true })
  render(<EntitlementDialog {...props} />)
  const dialog = await screen.findByRole('dialog', { name: '回数券を手で入れる' })
  fireEvent.change(within(dialog).getByLabelText('理由'), { target: { value: '返金のため' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '取り消す' }))
  await waitFor(() => expect(api.operate).toHaveBeenCalledWith('account-a', 'ticket-1', { action: 'revoke', expectedVersion: 3, reason: '返金のため' }, expect.any(String)))
})

it('アカウントを元に戻しても古い取消窓を復活させない', async () => {
  const view = render(<EntitlementDialog {...props} />)
  await screen.findByRole('dialog', { name: '回数券を手で入れる' })
  view.rerender(<EntitlementDialog {...props} accountId="account-b" />)
  view.rerender(<EntitlementDialog {...props} />)
  expect(screen.queryByRole('dialog', { name: '回数券を手で入れる' })).toBeNull()
})
