// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api, type ChatDetail, type ChatListItem } from '@/lib/api'
import { useInboxConversation } from './use-inbox-conversation'

it('送信中は定期取得を始めず、開始済みの取得結果も画面に混ぜない', async () => {
  const detail = { id: 'chat-1', messages: [], revision: 1 } as unknown as ChatDetail
  let finish!: (value: Awaited<ReturnType<typeof api.chats.get>>) => void
  const get = vi.spyOn(api.chats, 'get').mockResolvedValueOnce({ success: true, data: detail } as never)
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const setError = vi.fn()
  const setDeepLinkNotice = vi.fn()
  const { result } = renderHook(() => {
    const selectedChatIdRef = useRef<string | null>('chat-1')
    const detailAccountRef = useRef<string | null>('acc-1')
    const detailRequestIdRef = useRef(0)
    const deepLinkIdRef = useRef<string | null>(null)
    const sendLockRef = useRef(false)
    const [chats, setChats] = useState<ChatListItem[]>([])
    const actions = useInboxConversation({ CHAT_MESSAGE_PAGE_SIZE: 100, selectedChatIdRef, detailAccountRef, detailRequestIdRef, deepLinkIdRef, sendLockRef, setError, setDeepLinkNotice, selectedChatId: 'chat-1', selectedAccountId: 'acc-1', setChats, chats })
    return { ...actions, sendLockRef }
  })
  await waitFor(() => expect(result.current.chatDetail).not.toBeNull())
  let refresh!: Promise<boolean>
  act(() => { refresh = result.current.refreshChatDetailQuietly() })
  result.current.sendLockRef.current = true
  await act(async () => { finish({ success: true, data: { ...detail, messages: [{ id: 'server-1' }], revision: 2 } }); await refresh })
  expect(result.current.chatDetail?.messages).toEqual([])
  await act(async () => { await result.current.refreshChatDetailQuietly() })
  expect(get).toHaveBeenCalledTimes(2)
})
afterEach(() => vi.restoreAllMocks())
