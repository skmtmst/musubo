// @vitest-environment happy-dom
import React, { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api, type ChatDetail } from '@/lib/api'
const hit = vi.hoisted(() => ({ id: 'target' }))
vi.mock('@/v8/inbox-search/public/use-chat-search/index', () => ({
  useChatSearch: () => {
    const [moveSeq, setMoveSeq] = useState(0)
    return { current: hit, open: true, moveSeq, openBar: () => {}, older: () => setMoveSeq(n => n + 1) }
  },
}))
import { useInboxSearch } from './use-inbox-search'
function Screen() {
  const [detail, setDetail] = useState({ id: 'chat', friendId: 'friend', messages: [{ id: 'm1', createdAt: '2026-11-27T00:00:00Z' }] } as unknown as ChatDetail)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState('')
  const chatRef = useRef<string | null>('chat')
  const accountRef = useRef<string | null>('A')
  const search = useInboxSearch({ chatDetail: detail, messagesHasMore: hasMore, selectedChatIdRef: chatRef, detailAccountRef: accountRef, setChatDetail: setDetail, setMessagesHasMore: setHasMore, setError })
  return <><p>{hasMore ? '前の履歴あり' : '前の履歴なし'}</p><p>{error}</p><p>{search.chatSearchTarget?.id ?? '未移動'}</p><button onClick={() => search.chatSearch.older()}>もう一度探す</button></>
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('不正な追加結果では前の履歴を失わず、再試行できる', async () => {
  vi.spyOn(api.chats, 'get').mockResolvedValueOnce({ success: true, data: { messages: null, hasMoreMessages: false } } as never)
    .mockResolvedValueOnce({ success: true, data: { messages: [{ id: 'target' }], hasMoreMessages: false } } as never)
  render(<Screen />)
  expect(await screen.findByText('当たったメッセージまで読み込めませんでした。もう一度お試しください。')).toBeTruthy()
  expect(screen.getByText('前の履歴あり')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度探す' }))
  expect(await screen.findByText('target')).toBeTruthy()
  expect(screen.queryByText('当たったメッセージまで読み込めませんでした。もう一度お試しください。')).toBeNull()
})
