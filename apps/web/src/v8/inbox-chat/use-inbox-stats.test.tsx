// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events'
import { useInboxStats } from './use-inbox-stats'

vi.mock('@/lib/api', () => ({
  api: { chats: { quickCounts: vi.fn() }, chatStats: { get: vi.fn() } },
  fetchApi: vi.fn().mockResolvedValue({ success: true, data: [] }),
}))
const options = { selectedAccountId: 'account-a', statusFilter: 'all' as const, debouncedNameQuery: '', assigneeFilter: 'all', unreadOnly: false, channel: 'line' as const }
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.mocked(api.chats.quickCounts).mockResolvedValue({ success: true, data: { all: 230, reply: 7, overdue: 2 } })
  vi.mocked(api.chatStats.get).mockResolvedValue({ success: true, data: { assigneeUnread: [] } } as Awaited<ReturnType<typeof api.chatStats.get>>)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('連続する更新の知らせをまとめ、状態別・要返信・担当件数をサーバーから取り直す', async () => {
  const view = renderHook(() => useInboxStats(options))
  await act(async () => {})
  expect(view.result.current.quickCountsNow).toEqual({ all: 230, reply: 7, overdue: 2 })
  expect(api.chats.quickCounts).toHaveBeenCalledTimes(5)
  vi.mocked(api.chats.quickCounts).mockResolvedValue({ success: true, data: { all: 229, reply: 6, overdue: 1 } })
  act(() => { for (let i = 0; i < 10; i++) window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT)) })
  await act(async () => { await vi.advanceTimersByTimeAsync(119) })
  expect(api.chats.quickCounts).toHaveBeenCalledTimes(5)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(api.chats.quickCounts).toHaveBeenCalledTimes(10)
  expect(api.chatStats.get).toHaveBeenCalledTimes(2)
  expect(view.result.current.quickCountsNow).toEqual({ all: 229, reply: 6, overdue: 1 })
  expect(view.result.current.statusCountsNow).toEqual({ unread: 229, in_progress: 229, on_hold: 229, resolved: 229 })
})

it('失敗を0件にせず、切替前の遅い件数を新しいアカウントへ出さない', async () => {
  const pending: Array<(value: Awaited<ReturnType<typeof api.chats.quickCounts>>) => void> = []
  vi.mocked(api.chats.quickCounts).mockImplementation(() => new Promise((done) => { pending.push(done) }))
  const view = renderHook(({ account }) => useInboxStats({ ...options, selectedAccountId: account }), { initialProps: { account: 'account-a' } })
  vi.mocked(api.chats.quickCounts).mockRejectedValue(new Error('offline'))
  view.rerender({ account: 'account-b' })
  await act(async () => { pending.forEach((resolve) => resolve({ success: true, data: { all: 999, reply: 99, overdue: 9 } })) })
  expect(view.result.current.quickCountsNow).toBeNull()
  expect(view.result.current.statusCountsNow).toBeNull()
})

it('画面を離れたら予約済みの再取得とイベント購読を止める', async () => {
  const view = renderHook(() => useInboxStats(options))
  await act(async () => {})
  act(() => window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT)))
  view.unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(120) })
  window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
  await act(async () => { await vi.advanceTimersByTimeAsync(120) })
  expect(api.chats.quickCounts).toHaveBeenCalledTimes(5)
})

it('再取得より遅れて戻った旧集計では、新しい件数を上書きしない', async () => {
  const pending: Array<(value: Awaited<ReturnType<typeof api.chats.quickCounts>>) => void> = []
  vi.mocked(api.chats.quickCounts).mockImplementation(() => new Promise((done) => { pending.push(done) }))
  const view = renderHook(() => useInboxStats(options))
  vi.mocked(api.chats.quickCounts).mockResolvedValue({ success: true, data: { all: 10, reply: 3, overdue: 1 } })
  act(() => window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT)))
  await act(async () => { await vi.advanceTimersByTimeAsync(120) })
  expect(view.result.current.quickCountsNow?.all).toBe(10)
  await act(async () => { pending.forEach((resolve) => resolve({ success: true, data: { all: 999, reply: 99, overdue: 9 } })) })
  expect(view.result.current.quickCountsNow?.all).toBe(10)
  expect(view.result.current.statusCountsNow?.resolved).toBe(10)
})

it('未読で絞った件数にも一覧と同じアカウント・検索・担当・経路を送る', async () => {
  const filtered = { ...options, selectedAccountId: 'account-b', debouncedNameQuery: '確認', assigneeFilter: 'staff-b', unreadOnly: true }
  const view = renderHook(() => useInboxStats(filtered))
  await act(async () => {})
  expect(api.chats.quickCounts).toHaveBeenCalledWith({ status: undefined, accountId: 'account-b', q: '確認', operatorId: 'staff-b', unreadOnly: true, channel: 'line' })
  expect(view.result.current.quickCountsNow?.all).toBe(230)
})

it('Instagramを選ぶとInstagramの件数を読み込む', async () => {
  vi.mocked(api.chats.quickCounts).mockResolvedValue({ success: true, data: { all: 2, reply: 1, overdue: 0 } })
  const view = renderHook(() => useInboxStats({ ...options, socialChannel: 'instagram' }))
  await act(async () => {})
  expect(api.chats.quickCounts).toHaveBeenCalledWith(expect.objectContaining({ channel: 'instagram', socialChannel: 'instagram' }))
  expect(view.result.current.quickCountsNow).toEqual({ all: 2, reply: 1, overdue: 0 })
})

it('メール専用では媒体がすべてでもメールの件数を読み込む', async () => {
  renderHook(() => useInboxStats({ ...options, channel: 'email', socialChannel: 'all' }))
  await act(async () => {})
  expect(api.chats.quickCounts).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email', socialChannel: 'all' }))
})
