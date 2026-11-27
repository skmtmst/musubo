// @vitest-environment happy-dom
/*
 * 古い検索の追加ページが遅れて失敗しても、新しい検索結果を守る。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ConversationSearchHit } from '@line-crm/shared'

const searchMessages = vi.fn()
vi.mock('@/lib/api', () => ({ api: { chats: { searchMessages: (...args: unknown[]) => searchMessages(...args) } } }))

import ChatSearchBar from './chat-search-bar'
import { useChatSearch, type ChatSearch } from './use-chat-search'

const hit = (n: number): ConversationSearchHit => ({
  id: `h${n}`, at: `2026-08-01T00:00:${String(n % 60).padStart(2, '0')}Z`, excerpt: `定期便 ${n}`,
  before: null, after: null, cursor: { at: '2026-08-01T00:00:00Z', id: `h${n}` },
})
function respond(total: number) {
  searchMessages.mockImplementation(async (_id: string, _q: string, offset: number, limit: number) => {
    const hits = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => hit(offset + i))
    return { success: true, data: { total, hits, nextOffset: offset + hits.length < total ? offset + hits.length : null } }
  })
}

let latest: ChatSearch
function Harness({ friendId = 'f1' }: { friendId?: string | null }) {
  const search = useChatSearch(friendId)
  latest = search
  return (
    <>
      <button type="button" onClick={search.openBar}>開く</button>
      {search.open && <ChatSearchBar search={search} />}
    </>
  )
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  searchMessages.mockReset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function openAndType(text: string) {
  await act(async () => { fireEvent.click(screen.getByText('開く')) })
  const input = screen.getByRole('searchbox', { name: '会話の中を探す' })
  await act(async () => { fireEvent.change(input, { target: { value: text } }) })
  return input
}

test('前の検索の追加ページが失敗しても、新しい検索結果を失敗にしない', async () => {
  let rejectOld!: (error: Error) => void
  searchMessages.mockImplementation((_id: string, q: string, offset: number, limit: number) => {
    if (q === '古い' && offset === 1) return new Promise((_resolve, reject) => { rejectOld = reject })
    const total = q === '古い' ? 201 : 1
    const hits = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => hit(offset + i))
    return Promise.resolve({ success: true, data: { total, hits } })
  })
  render(<Harness />)
  const input = await openAndType('古い')
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('201 件中 201 件目'))
  for (let i = 0; i < 99; i += 1) await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
  expect(searchMessages).toHaveBeenCalledWith('f1', '古い', 1, 100)
  await act(async () => { fireEvent.change(input, { target: { value: '新しい' } }) })
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('1 件中 1 件目'))
  await act(async () => { rejectOld(new Error('offline')) })
  expect(screen.getByRole('status').textContent).toBe('1 件中 1 件目')
})
