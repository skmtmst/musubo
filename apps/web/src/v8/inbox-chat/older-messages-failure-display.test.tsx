// @vitest-environment happy-dom
import React, { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api, type ChatDetail, type ChatListItem } from '@/lib/api'
import { useInboxConversation } from './use-inbox-conversation'
const setDeepLinkNotice = () => {}
function Screen() {
  const selectedChatIdRef = useRef<string | null>('chat-1')
  const detailAccountRef = useRef<string | null>('acc-1')
  const detailRequestIdRef = useRef(0)
  const deepLinkIdRef = useRef<string | null>(null)
  const sendLockRef = useRef(false)
  const [chats, setChats] = useState<ChatListItem[]>([])
  const [error, setError] = useState('')
  const actions = useInboxConversation({ CHAT_MESSAGE_PAGE_SIZE: 100, selectedChatIdRef, detailAccountRef, detailRequestIdRef, deepLinkIdRef, sendLockRef, setError, setDeepLinkNotice, selectedChatId: 'chat-1', selectedAccountId: 'acc-1', setChats, chats })
  return <><p>{actions.chatDetail ? '会話を表示中' : '読み込み中'}</p><button onClick={() => void actions.loadOlderMessages()}>前のメッセージ</button><p>{error}</p><p>{actions.chatDetail?.messages?.map(message => message.id).join(',')}</p></>
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('過去の読み込みが失敗したら会話を残し、失敗を知らせる', async () => {
  const detail = { id: 'chat-1', messages: [{ id: 'm1', createdAt: '2026-11-27T00:00:00Z' }], hasMoreMessages: true, revision: 1 } as unknown as ChatDetail
  vi.spyOn(api.chats, 'get').mockResolvedValueOnce({ success: true, data: detail } as never).mockResolvedValueOnce({ success: false, error: 'offline' } as never).mockResolvedValueOnce({ success: true, data: { ...detail, messages: [{ id: 'm0', createdAt: '2026-11-26T00:00:00Z' }], hasMoreMessages: false } } as never)
  render(<Screen />)
  expect(await screen.findByText('会話を表示中')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '前のメッセージ' }))
  expect(await screen.findByText('前のメッセージを読み込めませんでした。')).toBeTruthy()
  expect(screen.getByText('会話を表示中')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '前のメッセージ' }))
  expect(await screen.findByText('m0,m1')).toBeTruthy()
  expect(screen.queryByText('前のメッセージを読み込めませんでした。')).toBeNull()
})
