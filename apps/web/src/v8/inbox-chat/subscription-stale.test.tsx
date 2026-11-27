// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useInboxSubscription } from './use-inbox-subscription'

const polls = vi.hoisted(() => [] as Array<{ work: () => Promise<void>; onGiveUp: () => void; onRecovered: () => void }>)
vi.mock('@/lib/visible-polling', () => ({ startVisiblePoll: (options: typeof polls[number]) => { polls.push(options); return { stop: vi.fn() } } }))
afterEach(cleanup)
beforeEach(() => { polls.length = 0 })

it('切替前に止めた更新から届く失敗は今の画面に出さない', () => {
  const detail = vi.fn(async () => true)
  const list = vi.fn(async () => true)
  const view = renderHook(({ channel }) => useInboxSubscription({ refreshChatDetailQuietly: detail, loadChatsQuietly: list, channel }), { initialProps: { channel: 'line' as 'line' | 'email' } })
  const old = polls[0]
  view.rerender({ channel: 'email' })
  act(() => old.onGiveUp())
  expect(view.result.current.chatPollStalled).toBe(false)
})

it('画面切替後に古い詳細の取得が終わっても古い一覧の取得を始めない', async () => {
  let finish!: (value: boolean) => void
  const detail = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
  const list = vi.fn(async () => true)
  const view = renderHook(({ channel }) => useInboxSubscription({ refreshChatDetailQuietly: detail, loadChatsQuietly: list, channel }), { initialProps: { channel: 'line' as 'line' | 'email' } })
  let pending!: Promise<void>
  act(() => { pending = polls[0].work() })
  view.rerender({ channel: 'email' })
  await act(async () => { finish(true); await pending })
  expect(list).not.toHaveBeenCalled()
})

it('現在の更新の失敗と回復、再試行は引き続き使える', () => {
  const detail = vi.fn(async () => true)
  const list = vi.fn(async () => true)
  const view = renderHook(() => useInboxSubscription({ refreshChatDetailQuietly: detail, loadChatsQuietly: list, channel: 'line' }))
  act(() => polls[0].onGiveUp())
  expect(view.result.current.chatPollStalled).toBe(true)
  act(() => polls[0].onRecovered())
  expect(view.result.current.chatPollStalled).toBe(false)
  act(() => view.result.current.setChatPollRetryKey((n) => n + 1))
  expect(polls).toHaveLength(2)
  act(() => polls[1].onGiveUp())
  expect(view.result.current.chatPollStalled).toBe(true)
})
