// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ account: 'a', list: vi.fn(), people: vi.fn(async () => ({ success: true, data: [] as { holdDays: number }[] })) }))
vi.mock('./frame', async original => ({ ...await original<typeof import('./frame')>(), useAffiliateShell: () => ({ readonly: false, narrow: false, accountId: fixture.account, setCount: vi.fn() }) }))
vi.mock('@/lib/api', async original => { const actual = await original<typeof import('@/lib/api')>(); return { ...actual, api: { ...actual.api, affiliates: { ...actual.api.affiliates, list: fixture.people } } } })
vi.mock('./display', async original => ({ ...await original<typeof import('./display')>(), listAllConversionApprovals: fixture.list }))
import ApprovalsTab from './approvals'

afterEach(() => { cleanup(); fixture.list.mockReset(); fixture.people.mockReset().mockResolvedValue({ success: true, data: [] }); fixture.account = 'a' })

it('店切替後は新しい店の続きを読み、前の店の遅い続きを混ぜない', async () => {
  let release!: (value: { items: never[]; truncated: boolean }) => void
  const pending = new Promise<{ items: never[]; truncated: boolean }>(resolve => { release = resolve })
  fixture.list.mockImplementation((status: string, offset: number, options: { accountId: string }) => {
    if (offset > 0 && options.accountId === 'a') return pending
    return Promise.resolve({ items: status === 'pending' && offset === 0 ? [{ eventId: `e-${options.accountId}`, friendName: `客-${options.accountId}`, affiliateName: '紹介者', offerName: '案件', lineAccountId: options.accountId, createdAt: '2026-10-01T00:00:00Z', approvalStatus: 'pending' }] : [], truncated: status === 'pending' && offset === 0 })
  })
  const view = render(<ApprovalsTab />)
  fireEvent.click(await screen.findByRole('button', { name: 'さらに読み込む' }))
  await waitFor(() => expect(fixture.list).toHaveBeenCalledWith('pending', 1, { accountId: 'a' }))
  fixture.account = 'b'; view.rerender(<ApprovalsTab />)
  await screen.findByText('客-b')
  await act(async () => { release({ items: [], truncated: false }); await pending })
  const more = await screen.findByRole('button', { name: 'さらに読み込む' })
  fireEvent.click(more)
  await waitFor(() => expect(fixture.list).toHaveBeenCalledWith('pending', 1, { accountId: 'b' }))
})

it('店を戻した後も古い続きの返事を表示しない', async () => {
  const oldRow = { eventId: 'old', friendName: '古い客', affiliateName: '紹介者', offerName: '案件', lineAccountId: 'a', createdAt: '2026-10-01T00:00:00Z', approvalStatus: 'pending' }
  let release!: (value: { items: typeof oldRow[]; truncated: boolean }) => void
  const pending = new Promise<{ items: typeof oldRow[]; truncated: boolean }>(resolve => { release = resolve })
  fixture.list.mockImplementation((status: string, offset: number, options: { accountId: string }) => {
    if (offset > 0) return pending
    return Promise.resolve({ items: status === 'pending' ? [{ ...oldRow, eventId: options.accountId, friendName: `客-${options.accountId}`, lineAccountId: options.accountId }] : [], truncated: status === 'pending' })
  })
  const view = render(<ApprovalsTab />)
  fireEvent.click(await screen.findByRole('button', { name: 'さらに読み込む' }))
  fixture.account = 'b'; view.rerender(<ApprovalsTab />)
  await screen.findByText('客-b')
  fixture.account = 'a'; view.rerender(<ApprovalsTab />)
  await screen.findByText('客-a')
  await act(async () => { release({ items: [oldRow], truncated: false }); await pending })
  expect(screen.queryByText('古い客')).toBeNull()
  expect(screen.getByRole('button', { name: 'さらに読み込む' })).toBeTruthy()
})

it('店を戻した後も最初の古い一覧を表示しない', async () => {
  const oldRow = { eventId: 'old', friendName: '古い一覧の客', affiliateName: '紹介者', offerName: '案件', lineAccountId: 'a', createdAt: '2026-10-01T00:00:00Z', approvalStatus: 'pending' }
  let release!: (value: { items: typeof oldRow[]; truncated: boolean }) => void
  const pending = new Promise<{ items: typeof oldRow[]; truncated: boolean }>(resolve => { release = resolve })
  let first = true
  fixture.list.mockImplementation((status: string, _offset: number, options: { accountId: string }) => {
    if (status === 'pending' && options.accountId === 'a' && first) { first = false; return pending }
    return Promise.resolve({ items: status === 'pending' ? [{ ...oldRow, eventId: options.accountId, friendName: `新しい客-${options.accountId}`, lineAccountId: options.accountId }] : [], truncated: false })
  })
  const view = render(<ApprovalsTab />)
  await waitFor(() => expect(first).toBe(false))
  fixture.account = 'b'; view.rerender(<ApprovalsTab />)
  await screen.findByText('新しい客-b')
  fixture.account = 'a'; view.rerender(<ApprovalsTab />)
  await screen.findByText('新しい客-a')
  await act(async () => { release({ items: [oldRow], truncated: false }); await pending })
  expect(screen.queryByText('古い一覧の客')).toBeNull()
  expect(screen.getByText('新しい客-a')).toBeTruthy()
})


it('店を戻した後も最初の保留期間を表示しない', async () => {
  let release!: (value: { success: boolean; data: { holdDays: number }[] }) => void
  const pending = new Promise<{ success: boolean; data: { holdDays: number }[] }>(resolve => { release = resolve })
  let first = true
  fixture.people.mockImplementation(() => {
    if (first) { first = false; return pending }
    return Promise.resolve({ success: true, data: [{ holdDays: fixture.account === 'b' ? 14 : 7 }] })
  })
  fixture.list.mockResolvedValue({ items: [], truncated: false })
  const view = render(<ApprovalsTab />)
  fixture.account = 'b'; view.rerender(<ApprovalsTab />)
  await waitFor(() => expect(screen.getByText('保留期間').closest('[data-kpi-presentation]')?.textContent).toContain('14'))
  fixture.account = 'a'; view.rerender(<ApprovalsTab />)
  await waitFor(() => expect(screen.getByText('保留期間').closest('[data-kpi-presentation]')?.textContent).toContain('7'))
  await act(async () => { release({ success: true, data: [{ holdDays: 99 }] }); await pending })
  expect(screen.getByText('保留期間').closest('[data-kpi-presentation]')?.textContent).toContain('7')
})
