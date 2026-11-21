// @vitest-environment happy-dom
/*
 * 受信箱を「期限超過」で開いたときの一覧の取り方（統括の「返信の期限を過ぎた会話」から `?quick=overdue` で来る）。
 * 守るのは：店が期限を使うかが分かるまで一覧を取らない（「1時間以上待ち」を一瞬出さない）／
 * 期限を使う店は口の期限の絞り（期限のカーソル）で全ページを取り、上の件数は同じ応答の総数／
 * 絞り込み（状態・担当・名前・未読）は件数と一覧の両方へ同じく渡す／
 * 期限の設定が読めないときは違う条件の一覧を出さず失敗にし、読み直せる／
 * 期限を使わない店では今までどおり「1時間以上待ち」で取る／ほかの絞り込みでは待たない。
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { inboxRoutingApi } from '@/lib/api/helpers/gap1'
import { useInboxLists } from './use-inbox-lists'

vi.mock('@/lib/api', () => ({
  api: { chats: { list: vi.fn() } },
  fetchApi: vi.fn().mockResolvedValue({ success: true, data: { items: [] } }),
}))
vi.mock('@/lib/api/helpers/gap1', () => ({ inboxRoutingApi: { get: vi.fn(), listByDeadline: vi.fn() } }))

type Settings = Awaited<ReturnType<typeof inboxRoutingApi.get>>
type DeadlinePage = Awaited<ReturnType<typeof inboxRoutingApi.listByDeadline>>
type DeadlineOptions = NonNullable<Parameters<typeof inboxRoutingApi.listByDeadline>[1]>
type ListParams = Parameters<typeof api.chats.list>[0]

const options = {
  CHAT_PAGE_SIZE: 200, EMAIL_PAGE_SIZE: 200, nameQuery: '', selectedAccountId: 'acc-1', emailInboxEnabled: false,
  statusFilter: 'all' as 'all' | 'unread' | 'in_progress' | 'on_hold' | 'resolved', assigneeFilter: 'all', unreadOnly: false,
  quickFilter: 'overdue' as 'all' | 'reply' | 'overdue', setError: vi.fn(),
}
const settings = (enabled: boolean) => ({ success: true, data: { enabled } }) as unknown as Settings
const row = (index: number) => ({
  id: `f${String(index).padStart(4, '0')}`, friendId: `f${index}`, friendName: `見本 ${index}`, friendPictureUrl: null, operatorId: null, operatorName: null,
  status: 'unread', revision: 0, notes: null, lastMessageAt: '2026-11-19T09:00:00Z', lastMessageContent: 'こんにちは', lastMessageDirection: 'incoming',
  lastMessageType: 'text', isUnread: true, createdAt: '2026-11-19T08:00:00Z', updatedAt: '2026-11-19T09:00:00Z',
  conversationId: `chat-${index}`, slaDueAt: new Date(Date.parse('2026-11-19T00:00:00Z') + index * 60000).toISOString(), slaState: 'overdue', assignedBy: null,
})
const page = (from: number, count: number, total: number) => ({ success: true, data: Array.from({ length: count }, (_, i) => row(from + i)), total }) as unknown as DeadlinePage
const deadlineCalls = () => vi.mocked(inboxRoutingApi.listByDeadline).mock.calls.map(([account, value]) => ({ account, ...(value as DeadlineOptions) }))

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.mocked(api.chats.list).mockReset()
  vi.mocked(api.chats.list).mockResolvedValue({ success: true, data: [] })
  vi.mocked(inboxRoutingApi.get).mockReset()
  vi.mocked(inboxRoutingApi.listByDeadline).mockReset()
  vi.mocked(inboxRoutingApi.listByDeadline).mockResolvedValue(page(0, 3, 3))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('期限を使うかが分かるまで一覧を取らず、期限を使う店は期限の絞りで取って件数も同じ応答から出す', async () => {
  let resolve: (value: Settings) => void = () => {}
  vi.mocked(inboxRoutingApi.get).mockImplementation(() => new Promise((done) => { resolve = done }))
  const view = renderHook(() => useInboxLists(options))
  await act(async () => {})
  expect(api.chats.list).not.toHaveBeenCalled()
  expect(inboxRoutingApi.listByDeadline).not.toHaveBeenCalled()
  expect(view.result.current.loading).toBe(true)
  await act(async () => { resolve(settings(true)) })
  await act(async () => {})
  expect(api.chats.list).not.toHaveBeenCalled()
  expect(deadlineCalls()).toEqual([{ account: 'acc-1', overdue: true, limit: 200 }])
  expect(view.result.current.chats.map((chat) => chat.id)).toEqual(['f0000', 'f0001', 'f0002'])
  expect(view.result.current.overdueTotal).toBe(3)
  expect(view.result.current.hasMoreChats).toBe(false)
})

it('200件を超える期限超過は期限のカーソルで続きを取り、件数と一覧の数が一致する', async () => {
  vi.mocked(inboxRoutingApi.get).mockResolvedValue(settings(true))
  vi.mocked(inboxRoutingApi.listByDeadline).mockResolvedValueOnce(page(0, 200, 250)).mockResolvedValueOnce(page(200, 50, 250))
  const view = renderHook(() => useInboxLists(options))
  await act(async () => {})
  await act(async () => {})
  expect(view.result.current.chats).toHaveLength(200)
  expect(view.result.current.hasMoreChats).toBe(true)
  expect(view.result.current.overdueTotal).toBe(250)
  await act(async () => { await view.result.current.loadMoreChats() })
  const calls = deadlineCalls()
  expect(calls).toHaveLength(2)
  expect(calls[1]).toEqual({ account: 'acc-1', overdue: true, limit: 200, beforeDueAt: row(199).slaDueAt, beforeId: row(199).id })
  expect(view.result.current.chats).toHaveLength(250)
  expect(new Set(view.result.current.chats.map((chat) => chat.id)).size).toBe(250)
  expect(view.result.current.overdueTotal).toBe(view.result.current.chats.length)
  expect(view.result.current.hasMoreChats).toBe(false)
  expect(api.chats.list).not.toHaveBeenCalled()
})

it('定期の取り直しは読んだページ数だけ先頭から取り直し、2ページ目で返事をした会話を残さない', async () => {
  vi.mocked(inboxRoutingApi.get).mockResolvedValue(settings(true))
  vi.mocked(inboxRoutingApi.listByDeadline).mockResolvedValueOnce(page(0, 200, 250)).mockResolvedValueOnce(page(200, 50, 250))
  const view = renderHook(() => useInboxLists(options))
  await act(async () => {})
  await act(async () => {})
  await act(async () => { await view.result.current.loadMoreChats() })
  expect(view.result.current.chats).toHaveLength(250)
  // 2ページ目の f0210 に返事が入り、期限超過から外れた（総数も 249）。
  const second = page(200, 50, 249) as unknown as { data: Array<{ id: string }> }
  second.data = second.data.filter((item) => item.id !== 'f0210')
  vi.mocked(inboxRoutingApi.listByDeadline).mockResolvedValueOnce(page(0, 200, 249)).mockResolvedValueOnce(second as unknown as DeadlinePage)
  await act(async () => { expect(await view.result.current.loadChatsQuietly()).toBe(true) })
  const refresh = deadlineCalls().slice(2)
  expect(refresh).toEqual([
    { account: 'acc-1', overdue: true, limit: 200 },
    { account: 'acc-1', overdue: true, limit: 200, beforeDueAt: row(199).slaDueAt, beforeId: row(199).id },
  ])
  expect(view.result.current.chats).toHaveLength(249)
  expect(view.result.current.chats.some((chat) => chat.id === 'f0210')).toBe(false)
  expect(view.result.current.overdueTotal).toBe(view.result.current.chats.length)
  expect(view.result.current.hasMoreChats).toBe(false)
})

it('状態・担当・名前・未読の絞り込みを期限超過の一覧へそのまま渡す', async () => {
  vi.mocked(inboxRoutingApi.get).mockResolvedValue(settings(true))
  renderHook(() => useInboxLists({ ...options, statusFilter: 'unread', assigneeFilter: 'staff:s1', nameQuery: '山田', unreadOnly: true }))
  await act(async () => { await new Promise((done) => setTimeout(done, 300)) })
  await act(async () => {})
  const last = deadlineCalls().at(-1)
  expect(last).toEqual({ account: 'acc-1', overdue: true, limit: 200, status: 'unread', operatorId: 'staff:s1', q: '山田', unreadOnly: true })
})

it('期限の設定が読めないときは違う条件の一覧を出さず失敗にし、読み直すと期限の絞りで取る', async () => {
  vi.mocked(inboxRoutingApi.get).mockRejectedValueOnce(new Error('network'))
  const view = renderHook(() => useInboxLists(options))
  await act(async () => {})
  await act(async () => {})
  expect(api.chats.list).not.toHaveBeenCalled()
  expect(inboxRoutingApi.listByDeadline).not.toHaveBeenCalled()
  expect(view.result.current.overdueSlaFailed).toBe(true)
  expect(view.result.current.chatListFailed).toBe(true)
  expect(view.result.current.loading).toBe(false)
  vi.mocked(inboxRoutingApi.get).mockResolvedValueOnce(settings(true))
  await act(async () => { view.result.current.setSlaReload((n) => n + 1) })
  await act(async () => {})
  expect(view.result.current.overdueSlaFailed).toBe(false)
  expect(view.result.current.chatListFailed).toBe(false)
  expect(deadlineCalls()).toEqual([{ account: 'acc-1', overdue: true, limit: 200 }])
  expect(view.result.current.overdueTotal).toBe(3)
})

it('口が success:false を返したときも失敗として扱う', async () => {
  vi.mocked(inboxRoutingApi.get).mockResolvedValueOnce({ success: false, error: 'forbidden' } as unknown as Settings)
  const view = renderHook(() => useInboxLists(options))
  await act(async () => {})
  await act(async () => {})
  expect(view.result.current.overdueSlaFailed).toBe(true)
  expect(api.chats.list).not.toHaveBeenCalled()
})

it('期限を使わない店では、今までどおり「1時間以上待ち」の絞りで取る', async () => {
  vi.mocked(inboxRoutingApi.get).mockResolvedValue(settings(false))
  const view = renderHook(() => useInboxLists(options))
  await act(async () => {})
  await act(async () => {})
  expect(api.chats.list).toHaveBeenCalledTimes(1)
  expect((vi.mocked(api.chats.list).mock.calls[0][0] as NonNullable<ListParams>).quickFilter).toBe('overdue')
  expect(inboxRoutingApi.listByDeadline).not.toHaveBeenCalled()
  expect(view.result.current.overdueSlaFailed).toBe(false)
})

it('ほかの絞り込みでは期限の設定を待たずに取り、上の「期限超過 N」は同じ条件で数える', async () => {
  vi.mocked(inboxRoutingApi.get).mockResolvedValue(settings(true))
  vi.mocked(inboxRoutingApi.listByDeadline).mockResolvedValue(page(0, 1, 7))
  const view = renderHook(() => useInboxLists({ ...options, quickFilter: 'all', statusFilter: 'on_hold' }))
  await act(async () => {})
  await act(async () => {})
  expect(api.chats.list).toHaveBeenCalled()
  expect(deadlineCalls().at(-1)).toEqual({ account: 'acc-1', overdue: true, limit: 1, status: 'on_hold' })
  expect(view.result.current.overdueTotal).toBe(7)
})

it('ほかの絞り込みでは、期限の設定の失敗で一覧を失敗にしない', async () => {
  vi.mocked(inboxRoutingApi.get).mockRejectedValue(new Error('network'))
  const view = renderHook(() => useInboxLists({ ...options, quickFilter: 'all' }))
  await act(async () => {})
  await act(async () => {})
  expect(api.chats.list).toHaveBeenCalledTimes(1)
  expect(view.result.current.overdueSlaFailed).toBe(false)
  expect(view.result.current.chatListFailed).toBe(false)
})
