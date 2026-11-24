// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useInboxLists } from './use-inbox-lists'

const fx = vi.hoisted(() => ({ list: vi.fn(), routing: vi.fn(), overdue: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { chats: { list: fx.list } }, fetchApi: vi.fn() }))
vi.mock('@/lib/api/helpers/gap1', () => ({ inboxRoutingApi: { get: fx.routing, listByDeadline: fx.overdue } }))
const options: Parameters<typeof useInboxLists>[0] = { CHAT_PAGE_SIZE: 200, EMAIL_PAGE_SIZE: 30, nameQuery: '', selectedAccountId: 'a', emailInboxEnabled: false, statusFilter: 'all' as const, assigneeFilter: 'all', unreadOnly: false, quickFilter: 'all' as const, sort: 'unread_first' as const, setError: vi.fn() }
beforeEach(() => { vi.clearAllMocks(); fx.list.mockResolvedValue({ success: true, data: [] }); fx.overdue.mockResolvedValue({ total: 0 }) })
afterEach(() => vi.restoreAllMocks())

it('期限の設定が確定するまで待ち、一覧と期限超過数をそれぞれ1回取る', async () => {
  let resolve!: (value: unknown) => void
  fx.routing.mockReturnValue(new Promise(r => { resolve = r }))
  renderHook(() => useInboxLists(options))
  expect(fx.list).not.toHaveBeenCalled()
  await act(async () => resolve({ data: { enabled: true } }))
  await waitFor(() => expect(fx.overdue).toHaveBeenCalledTimes(1))
  expect(fx.list).toHaveBeenCalledTimes(1)
  expect(fx.list.mock.calls[0][0]).toMatchObject({ accountId: 'a', limit: 200 })
})

it('検索・担当・並び・アカウントが変わると新しい条件で取り直す', async () => {
  fx.routing.mockResolvedValue({ data: { enabled: false } })
  const { rerender } = renderHook(props => useInboxLists(props), { initialProps: options })
  await waitFor(() => expect(fx.list).toHaveBeenCalledTimes(1))
  rerender({ ...options, assigneeFilter: 'staff-b' })
  await waitFor(() => expect(fx.list).toHaveBeenLastCalledWith(expect.objectContaining({ operatorId: 'staff-b' })))
  rerender({ ...options, nameQuery: '山田' })
  await waitFor(() => expect(fx.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: '山田' })))
  rerender({ ...options, nameQuery: '山田', sort: 'latest' })
  await waitFor(() => expect(fx.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: '山田', sort: 'latest' })))
  rerender({ ...options, selectedAccountId: 'b' })
  await waitFor(() => expect(fx.list).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: 'b' })))
  expect(fx.routing).toHaveBeenCalledWith('b')
})
