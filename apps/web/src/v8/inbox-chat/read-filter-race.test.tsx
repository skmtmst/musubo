// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { chats: { list: fx.list } }, fetchApi: vi.fn() }))
vi.mock('@/lib/api/helpers/gap1', () => ({ inboxRoutingApi: { get: vi.fn(async () => ({ data: { enabled: false } })) } }))
import { useInboxLists } from './use-inbox-lists'

it('既読保存中に絞り込みを変えても最新の一覧を読み終える', async () => {
  let finishFiltered!: (value: unknown) => void
  let filteredCalls = 0
  const row = { id: 'f1', isUnread: true, unreadCount: 3, lastMessageAt: '2026-01-01', status: 'unread' }
  fx.list.mockImplementation((params: { status?: string }) => {
    if (params.status && ++filteredCalls === 1) return new Promise(resolve => { finishFiltered = resolve })
    return Promise.resolve({ success: true, data: params.status ? [] : [row] })
  })
  const common = { CHAT_PAGE_SIZE: 30, EMAIL_PAGE_SIZE: 30, nameQuery: '', selectedAccountId: null, emailInboxEnabled: false, assigneeFilter: 'all', unreadOnly: false, quickFilter: 'all' as const, setError: vi.fn() }
  const { result, rerender } = renderHook(({ statusFilter }) => useInboxLists({ ...common, statusFilter }), { initialProps: { statusFilter: 'all' as 'all' | 'resolved' } })
  await waitFor(() => expect(result.current.loading).toBe(false))
  let finishRead!: () => void
  act(() => { finishRead = result.current.beginChatRead('f1') })
  rerender({ statusFilter: 'resolved' })
  await waitFor(() => expect(filteredCalls).toBe(1))
  act(() => finishRead())
  await waitFor(() => expect(filteredCalls).toBe(2))
  await waitFor(() => expect(result.current.chatListCompletedKey).toBe(result.current.listFilterKey))
  expect(result.current.loading).toBe(false)
  await act(async () => finishFiltered({ success: true, data: [row] }))
  expect(result.current.chats).toEqual([])
})

it('続きを読み込んだ会話を開いても一覧の追加分を保つ', async () => {
  const first = { id: 'f1', isUnread: true, unreadCount: 3, lastMessageAt: '2026-01-02', status: 'unread' }
  const second = { id: 'f2', isUnread: true, unreadCount: 1, lastMessageAt: '2026-01-01', status: 'unread' }
  fx.list.mockImplementation((params: { beforeId?: string }) => Promise.resolve({ success: true, data: params.beforeId ? [second] : [first] }))
  const options = { CHAT_PAGE_SIZE: 1, EMAIL_PAGE_SIZE: 30, nameQuery: '', selectedAccountId: null, emailInboxEnabled: false, statusFilter: 'all' as const, assigneeFilter: 'all', unreadOnly: false, quickFilter: 'all' as const, setError: vi.fn() }
  const { result } = renderHook(() => useInboxLists(options))
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(async () => result.current.loadMoreChats())
  expect(result.current.chats.map(row => row.id)).toEqual(['f1', 'f2'])
  let finish!: (success?: boolean) => void
  act(() => { finish = result.current.beginChatRead('f2') })
  await act(async () => { finish(true) })
  await waitFor(() => expect(result.current.chats.map(row => row.id)).toEqual(['f1', 'f2']))
  expect(result.current.chats.find(row => row.id === 'f2')?.isUnread).toBe(false)
})

it('既読の保存中に一覧を再取得しても読み込みの表示が残らない', async () => {
  let calls = 0
  let finishOld!: (value: unknown) => void
  const row = { id: 'f1', isUnread: true, unreadCount: 3, lastMessageAt: '2026-01-01', status: 'unread' }
  fx.list.mockImplementation(() => ++calls === 2 ? new Promise(resolve => { finishOld = resolve }) : Promise.resolve({ success: true, data: [row] }))
  const options = { CHAT_PAGE_SIZE: 30, EMAIL_PAGE_SIZE: 30, nameQuery: '', selectedAccountId: null, emailInboxEnabled: false, statusFilter: 'all' as const, assigneeFilter: 'all', unreadOnly: false, quickFilter: 'all' as const, setError: vi.fn() }
  const { result } = renderHook(() => useInboxLists(options))
  await waitFor(() => expect(result.current.loading).toBe(false))
  let finish!: (success?: boolean) => void
  act(() => { finish = result.current.beginChatRead('f1'); void result.current.loadChats() })
  await waitFor(() => expect(result.current.loading).toBe(true))
  await act(async () => { finish(true) })
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(async () => finishOld({ success: true, data: [row] }))
  expect(result.current.loading).toBe(false)
})
