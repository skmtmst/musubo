// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api, type ChatDetail, type ChatDetailMessage } from '@/lib/api'
import { IdempotencyKeyStore } from '@/lib/idempotency-key-store'
import { useInboxSend } from './use-inbox-send'

const serverMessage = { id: 'server-1', direction: 'outgoing', messageType: 'text', content: 'こんばんは', sentByStaffName: '担当者', createdAt: '2026-11-12T00:00:00Z' } as ChatDetailMessage
const detail = { id: 'chat-1', revision: 1, messages: [] } as unknown as ChatDetail
function setup() {
  return renderHook(() => {
    const [chatDetail, setChatDetail] = useState<ChatDetail | null>(detail)
    const [messageContent, setMessageContent] = useState('こんばんは')
    const [sending, setSending] = useState(false)
    const sendLockRef = useRef(false)
    const selectedChatIdRef = useRef<string | null>('chat-1')
    const detailAccountRef = useRef<string | null>('acc-1')
    const pendingImageRef = useRef(null)
    const sendKeysRef = useRef(new IdempotencyKeyStore())
    const statusFilterRef = useRef<'all'>('all')
    const attachDraftsRef = useRef(new Map())
    const isComposingRef = useRef(false)
    const actions = useInboxSend({ selectedChatId: 'chat-1', selectedAccountId: 'acc-1', sending, sendLockRef, pendingAttachment: null, messageContent, pendingImage: null, setSending, chatDetail, quotedMessage: null, senderId: '', sendKeysRef, dropSentDraft: vi.fn(), selectedChatIdRef, detailAccountRef, pendingImageRef, setPendingImage: vi.fn(), setPendingImageMeta: vi.fn(), setMessageContent, setChatDetail, setChats: vi.fn(), statusFilterRef, attachDraftsRef, putAttachment: vi.fn(), correctingId: null, setCorrectingId: vi.fn(), setQuotedMessage: vi.fn(), pendingPack: null, setPendingPack: vi.fn(), isComposingRef, sendMode: 'enter' })
    return { ...actions, chatDetail, setChatDetail, isComposingRef }
  })
}
afterEach(() => vi.restoreAllMocks())
it('送信応答より先に再読込された同じ送信を重ねない', async () => {
  let finish!: (value: Awaited<ReturnType<typeof api.chats.send>>) => void
  const send = vi.spyOn(api.chats, 'send').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { result } = setup()
  let sending!: Promise<void>
  act(() => { sending = result.current.handleSendMessage() })
  act(() => { result.current.setChatDetail({ ...detail, revision: 2, messages: [serverMessage] }) })
  await act(async () => { finish({ success: true, data: { sent: true, messageId: 'server-1', sentByStaffName: '担当者', revision: 2 } }); await sending })
  expect(send).toHaveBeenCalledTimes(1)
  expect(result.current.chatDetail?.messages.map(message => message.id)).toEqual(['server-1'])
})
it('連打とIME確定では送信を重複させない', async () => {
  let finish!: (value: Awaited<ReturnType<typeof api.chats.send>>) => void
  const send = vi.spyOn(api.chats, 'send').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { result } = setup()
  const key = (native: { isComposing?: boolean }, keyCode = 13) => ({ key: 'Enter', nativeEvent: native, keyCode, shiftKey: false, preventDefault: vi.fn() }) as unknown as React.KeyboardEvent<HTMLTextAreaElement>
  act(() => { result.current.handleKeyDown(key({ isComposing: true })); result.current.handleKeyDown(key({}, 229)); result.current.isComposingRef.current = true; result.current.handleKeyDown(key({})); result.current.isComposingRef.current = false })
  expect(send).not.toHaveBeenCalled()
  let first!: Promise<void>
  act(() => { first = result.current.handleSendMessage(); void result.current.handleSendMessage() })
  expect(send).toHaveBeenCalledTimes(1)
  await act(async () => { finish({ success: true, data: { sent: true, messageId: 'server-1', sentByStaffName: '担当者', revision: 2 } }); await first })
  expect(result.current.chatDetail?.messages).toHaveLength(1)
})
it('まとめ送信の再応答にID一覧がなくても保存済みの行と重ねない', async () => {
  vi.spyOn(api.chats, 'sendCombined').mockResolvedValue({ success: true, data: { sent: true, messageId: 'pack', sentByStaffName: '担当者', revision: 2 } } as never)
  const { result } = setup()
  const saved = { ...serverMessage, id: 'pack:0' }
  act(() => { result.current.setChatDetail({ ...detail, revision: 2, messages: [saved] }) })
  await act(async () => { await result.current.handleSendPack({ texts: ['こんばんは'], chatId: 'chat-1', accountId: 'acc-1', revision: 1 }) })
  expect(result.current.chatDetail?.messages.map(message => message.id)).toEqual(['pack:0'])
})
