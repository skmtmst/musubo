'use client'
import { type ImageUploaderValue } from '@/components/shared/image-uploader';
import { api, type ChatDetail as ApiChatDetail, type ChatDetailMessage, type ChatListItem } from '@/lib/api';
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events';
import { formatNumber } from '@/lib/format';
import { IdempotencyKeyStore } from '@/lib/idempotency-key-store';
import { attachmentPreviewLabel, attachmentSendInput } from '@/v8/inbox-chat/attachments';
import { useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { PendingAttachment } from './inbox-model';
import { MESSAGE_MAX_LENGTH, StatusFilter, draftKeyOf } from './inbox-model';
import { describeSendFailure } from './send-failure';
import { appendSentMessages, buildOutgoingMessage, refreshChatListAfterSend } from './send-optimistic';

type Options = {
  selectedChatId: string | null
  sending: boolean
  sendLockRef: RefObject<boolean>
  pendingAttachment: PendingAttachment | null
  messageContent: string
  pendingImage: ImageUploaderValue | null
  selectedAccountId: string | null
  setSending: Dispatch<SetStateAction<boolean>>
  chatDetail: ApiChatDetail | null
  quotedMessage: ChatDetailMessage | null
  senderId: string
  sendKeysRef: RefObject<IdempotencyKeyStore>
  dropSentDraft: (chatId: string, accountId: string | null, sent: { content?: string; image?: ImageUploaderValue | null; }) => void
  selectedChatIdRef: RefObject<string | null>
  detailAccountRef: RefObject<string | null>
  pendingImageRef: RefObject<ImageUploaderValue | null>
  setPendingImage: Dispatch<SetStateAction<ImageUploaderValue | null>>
  setPendingImageMeta: Dispatch<SetStateAction<{ name: string; size: number; } | null>>
  setMessageContent: Dispatch<SetStateAction<string>>
  setChatDetail: Dispatch<SetStateAction<ApiChatDetail | null>>
  setChats: Dispatch<SetStateAction<ChatListItem[]>>
  statusFilterRef: RefObject<StatusFilter>
  attachDraftsRef: RefObject<Map<string, PendingAttachment>>
  putAttachment: (ownerKey: string, value: PendingAttachment | null) => void
  correctingId: string | null
  setCorrectingId: Dispatch<SetStateAction<string | null>>
  setQuotedMessage: Dispatch<SetStateAction<ChatDetailMessage | null>>
  pendingPack: { texts: string[]; chatId: string; accountId: string | null; revision?: number; } | null
  setPendingPack: Dispatch<SetStateAction<{ texts: string[]; chatId: string; accountId: string | null; revision?: number; } | null>>
  isComposingRef: RefObject<boolean>
  sendMode: "enter" | "shift-enter"
}

export function useInboxSend({ selectedChatId, sending, sendLockRef, pendingAttachment, messageContent, pendingImage, selectedAccountId, setSending, chatDetail, quotedMessage, senderId, sendKeysRef, dropSentDraft, selectedChatIdRef, detailAccountRef, pendingImageRef, setPendingImage, setPendingImageMeta, setMessageContent, setChatDetail, setChats, statusFilterRef, attachDraftsRef, putAttachment, correctingId, setCorrectingId, setQuotedMessage, setPendingPack, isComposingRef, sendMode }: Options) {

  const [sendFailure, setSendFailure] = useState<{ owner: string; message: string } | null>(null)
  const owner = draftKeyOf(selectedAccountId, selectedChatId ?? '')
  const setSendError = (message: string) => setSendFailure({ owner, message })
  const sendError = sendFailure?.owner === owner ? sendFailure.message : ''
  const [pendingSend, setPendingSend] = useState<{ chatId: string; accountId: string | null; messages: ChatDetailMessage[] } | null>(null)

  // 通信中の吹き出しは保存済み履歴へ混ぜない。失敗しても下書きと冪等キーを守る。
  async function previewSend<T>(messages: Array<{ messageType: string; content: string }>, send: () => Promise<T>): Promise<T> {
    if (!selectedChatId) throw new Error('会話を選んでください。')
    setPendingSend({ chatId: selectedChatId, accountId: selectedAccountId,
      messages: messages.map((message) => buildOutgoingMessage({ ...message, sentByStaffName: '自分', sentAt: new Date().toISOString(), quoted: quotedMessage })),
    })
    try { return await send() } finally { setPendingSend(null) }
  }

  const handleSendMessage = async () => {
    if (!selectedChatId || sending || sendLockRef.current) return
    // ：動画・ファイルは準備が済んだものだけ送る。準備中・失敗のまま送らない（本文も止める）。
    const sendingAttachment = pendingAttachment
    if (sendingAttachment && sendingAttachment.status !== 'ready') {
      setSendError(sendingAttachment.status === 'uploading'
        ? `「${sendingAttachment.name}」の準備が終わってから送れます。`
        : `「${sendingAttachment.name}」を準備できていません。もう一度試すか、外してから送ってください。`)
      return
    }
    if (!messageContent.trim() && !pendingImage && !sendingAttachment) return
    // INBOX-29: 上限を超えた本文は送らない(下書きは消さない)。
    if (messageContent.length > MESSAGE_MAX_LENGTH) {
      setSendError(`メッセージは${formatNumber(MESSAGE_MAX_LENGTH)}文字までです。`)
      return
    }
    const sendingChatId = selectedChatId  // capture the chat id for this send
    const sendingAccountId = selectedAccountId  // 送信開始時のアカウントを固定する
    setSendError('')
    sendLockRef.current = true
    setSending(true)
    try {
      const now = new Date().toISOString()
      let currentRevision = chatDetail?.revision
      // N-022: 画像と本文が両方あるときは1回の結合送信にする。
      // 2回に分けると画像だけ届く部分送信になる。
      const useCombined = Boolean(pendingImage && pendingImage.mode === 'line-image' && messageContent.trim())
      if (useCombined && pendingImage && pendingImage.mode === 'line-image') {
        const content = messageContent.trim()
        const imgPayload = JSON.stringify({
          originalContentUrl: pendingImage.originalContentUrl,
          previewImageUrl: pendingImage.previewImageUrl,
        })
        const signature = JSON.stringify({ chatId: sendingChatId, combined: true, image: imgPayload, content, quotedMessageId: quotedMessage?.id ?? null })
        const sendResult = await previewSend([{ messageType: 'image', content: imgPayload }, { messageType: 'text', content }], () => api.chats.sendCombined(sendingChatId,
          {
            image: {
              originalContentUrl: pendingImage.originalContentUrl,
              previewImageUrl: pendingImage.previewImageUrl,
            },
            text: content,
            revision: currentRevision,
            quotedMessageId: quotedMessage?.id,
            ...(senderId ? { senderId } : {}),
          } as Parameters<typeof api.chats.sendCombined>[1],
          sendKeysRef.current.get(signature),
        ))
        if (!sendResult.success) throw new Error(sendResult.error || '送信できませんでした。時間をおいて、もう一度お試しください。')
        if (sendResult.success) currentRevision = sendResult.data.revision
        sendKeysRef.current.clear(signature)
        /*
         * 送信した版だけを消す(#962 F06)。応答を待つ間に別の会話・別
         * アカウントへ切り替わっていたり、同じ会話でも送信中に追記・
         * 付け替えされていれば、その下書きと添付は残す。
         */
        dropSentDraft(sendingChatId, sendingAccountId, { content, image: pendingImage })
        if (selectedChatIdRef.current === sendingChatId && detailAccountRef.current === sendingAccountId) {
          if (pendingImageRef.current === pendingImage) {
            setPendingImage(null)
            setPendingImageMeta(null)
          }
          setMessageContent((prev) => (prev.trim() === content ? '' : prev))
        }
        const staffName = sendResult.success ? sendResult.data.sentByStaffName : '自分'
        const combinedMessages = [
          buildOutgoingMessage({ id: sendResult.data.messageIds?.[0] ?? `${sendResult.data.messageId}:0`, messageType: 'image', content: imgPayload, sentByStaffName: staffName, sentAt: now }),
          buildOutgoingMessage({ id: sendResult.data.messageIds?.[1] ?? `${sendResult.data.messageId}:1`, messageType: 'text', content, sentByStaffName: staffName, sentAt: now }),
        ]
        setChatDetail((prev) => (prev && prev.id === sendingChatId) ? {
          ...prev,
          lastMessageAt: now,
          status: 'in_progress',
          revision: sendResult.success ? sendResult.data.revision : prev.revision,
          messages: appendSentMessages(prev.messages ?? [], combinedMessages),
        } : prev)
        setChats((prev) => {
          const exists = prev.some((c) => c.id === sendingChatId)
          if (!exists) return prev
          return refreshChatListAfterSend(prev, statusFilterRef.current, (c) => (c.id === sendingChatId ? {
            ...c,
            lastMessageAt: now,
            status: 'in_progress' as const,
            lastMessageContent: content,
            lastMessageDirection: 'outgoing' as const,
            lastMessageType: 'text' as const,
          } : c))
        })
      }
      // --- Image send path (runs first when image is present) ---
      if (!useCombined && pendingImage && pendingImage.mode === 'line-image') {
        const imgPayload = JSON.stringify({
          originalContentUrl: pendingImage.originalContentUrl,
          previewImageUrl: pendingImage.previewImageUrl,
        })
        const signature = JSON.stringify({ chatId: sendingChatId, messageType: 'image', content: imgPayload, quotedMessageId: quotedMessage?.id ?? null })
        const sendResult = await previewSend([{ messageType: 'image', content: imgPayload }], () => api.chats.send(sendingChatId,
          { messageType: 'image', content: imgPayload, revision: currentRevision, quotedMessageId: quotedMessage?.id, ...(senderId ? { senderId } : {}) } as Parameters<typeof api.chats.send>[1],
          sendKeysRef.current.get(signature),
        ))
        if (!sendResult.success) throw new Error(sendResult.error || '送信できませんでした。時間をおいて、もう一度お試しください。')
        if (sendResult.success) currentRevision = sendResult.data.revision
        sendKeysRef.current.clear(signature)
        dropSentDraft(sendingChatId, sendingAccountId, { image: pendingImage })
        // 送信した会話が開かれたまま、かつ添付が送った版のままのときだけ外す(#962 F06)。
        if (selectedChatIdRef.current === sendingChatId && detailAccountRef.current === sendingAccountId) {
          if (pendingImageRef.current === pendingImage) {
            setPendingImage(null)
            setPendingImageMeta(null)
          }
        }
        // Optimistic update for image
        const imageMessage = buildOutgoingMessage({
          id: sendResult.data.messageId,
          messageType: 'image',
          content: imgPayload,
          sentByStaffName: sendResult.success ? sendResult.data.sentByStaffName : '自分',
          sentAt: now,
        })
        setChatDetail((prev) => (prev && prev.id === sendingChatId) ? {
          ...prev,
          lastMessageAt: now,
          status: 'in_progress',
          revision: sendResult.success ? sendResult.data.revision : prev.revision,
          messages: appendSentMessages(prev.messages ?? [], [imageMessage]),
        } : prev)
        setChats((prev) => {
          const exists = prev.some((c) => c.id === sendingChatId)
          if (!exists) return prev
          // 返信すると対応中に変わるので、別の絞り込みを見ているときは一覧から外れる
          return refreshChatListAfterSend(prev, statusFilterRef.current, (c) => (c.id === sendingChatId ? {
            ...c,
            lastMessageAt: now,
            status: 'in_progress' as const,
            lastMessageContent: '[画像]',
            lastMessageDirection: 'outgoing' as const,
            lastMessageType: 'image' as const,
          } : c))
        })
      }
      // ---  動画・ファイル（準備済みの添付を1通で送る。ファイルはリンクの文で届く） ---
      if (sendingAttachment?.attachment && (sendingAttachment.kind === 'video' || sendingAttachment.kind === 'file')) {
        const input = attachmentSendInput(sendingAttachment.attachment)
        const signature = JSON.stringify({ chatId: sendingChatId, ...input, quotedMessageId: useCombined ? null : quotedMessage?.id ?? null })
        const sendResult = await previewSend([{ messageType: sendingAttachment.kind, content: sendingAttachment.kind === 'file' ? JSON.stringify({ attachmentId: sendingAttachment.attachment.id, ...sendingAttachment.attachment }) : input.content }], () => api.chats.send(sendingChatId,
          { ...input, revision: currentRevision, quotedMessageId: useCombined ? undefined : quotedMessage?.id, ...(senderId ? { senderId } : {}) } as Parameters<typeof api.chats.send>[1],
          sendKeysRef.current.get(signature),
        ))
        if (!sendResult.success) throw new Error(sendResult.error || '送信できませんでした。時間をおいて、もう一度お試しください。')
        if (sendResult.success) currentRevision = sendResult.data.revision
        sendKeysRef.current.clear(signature)
        const sentKey = draftKeyOf(sendingAccountId, sendingChatId)
        if (attachDraftsRef.current.get(sentKey)?.job === sendingAttachment.job) putAttachment(sentKey, null)
        const savedContent = sendingAttachment.kind === 'file'
          ? JSON.stringify({ attachmentId: sendingAttachment.attachment.id, ...sendingAttachment.attachment })
          : input.content
        const attachmentMessage = buildOutgoingMessage({
          id: sendResult.data.messageId,
          messageType: sendingAttachment.kind,
          content: savedContent,
          sentByStaffName: sendResult.success ? sendResult.data.sentByStaffName : '自分',
          sentAt: now,
        })
        setChatDetail((prev) => (prev && prev.id === sendingChatId) ? {
          ...prev,
          lastMessageAt: now,
          status: 'in_progress',
          revision: sendResult.success ? sendResult.data.revision : prev.revision,
          messages: appendSentMessages(prev.messages ?? [], [attachmentMessage]),
        } : prev)
        setChats((prev) => {
          if (!prev.some((c) => c.id === sendingChatId)) return prev
          return refreshChatListAfterSend(prev, statusFilterRef.current, (c) => (c.id === sendingChatId ? {
            ...c,
            lastMessageAt: now,
            status: 'in_progress' as const,
            lastMessageContent: attachmentPreviewLabel(sendingAttachment.kind),
            lastMessageDirection: 'outgoing' as const,
            lastMessageType: sendingAttachment.kind,
          } : c))
        })
      }
      // --- Text send path (runs independently — both paths execute when both image and text are present) ---
      if (!useCombined && messageContent.trim()) {
        const content = messageContent.trim()
        const signature = JSON.stringify({ chatId: sendingChatId, messageType: 'text', content, quotedMessageId: quotedMessage?.id ?? null })
        const sendResult = await previewSend([{ messageType: 'text', content }], () => api.chats.send(sendingChatId,
          { content, revision: currentRevision, quotedMessageId: quotedMessage?.id, ...(correctingId ? { correctionOfMessageId: correctingId } : {}), ...(senderId ? { senderId } : {}) } as Parameters<typeof api.chats.send>[1],
          sendKeysRef.current.get(signature),
        ))
        if (!sendResult.success) throw new Error(sendResult.error || '送信できませんでした。時間をおいて、もう一度お試しください。')
        if (sendResult.success) currentRevision = sendResult.data.revision
        sendKeysRef.current.clear(signature)
        /*
         * 送信した版だけを消す(#962 F06)。応答を待つ間に別の会話・別
         * アカウントへ切り替わっていたり、送信中に追記されていれば、
         * その下書きは残す。
         */
        dropSentDraft(sendingChatId, sendingAccountId, { content })
        if (selectedChatIdRef.current === sendingChatId && detailAccountRef.current === sendingAccountId) {
          setMessageContent((prev) => (prev.trim() === content ? '' : prev))
        }
        // Optimistic update: append message locally instead of refetching (prevents scroll jump / full reload feel)
        // Only mutate chatDetail if it still corresponds to the chat we just sent to
        setCorrectingId(null)
        const textMessage = buildOutgoingMessage({
          id: sendResult.data.messageId,
          messageType: 'text',
          content,
          sentByStaffName: sendResult.success ? sendResult.data.sentByStaffName : '自分',
          sentAt: now,
        })
        setChatDetail((prev) => (prev && prev.id === sendingChatId) ? {
          ...prev,
          lastMessageAt: now,
          status: 'in_progress',
          revision: sendResult.success ? sendResult.data.revision : prev.revision,
          messages: appendSentMessages(prev.messages ?? [], [textMessage]),
        } : prev)
        setChats((prev) => {
          // Skip reconciliation if the list no longer contains this chat (e.g. tab changed mid-send)
          const exists = prev.some((c) => c.id === sendingChatId)
          if (!exists) return prev
          // 返信すると対応中に変わるので、別の絞り込みを見ているときは一覧から外れる
          return refreshChatListAfterSend(prev, statusFilterRef.current, (c) => (c.id === sendingChatId ? {
            ...c,
            lastMessageAt: now,
            status: 'in_progress' as const,
            // 一覧の preview も即時更新する。incoming 優先ロジックで上書きされ得るが、
            // 楽観 UI では「operator が今送った文面」が一瞬見えるのが期待動作。
            // 次回 loadChats で server 側の真の最新 (incoming 優先) に reconcile される。
            lastMessageContent: content,
            lastMessageDirection: 'outgoing' as const,
            lastMessageType: 'text' as const,
          } : c))
        })
      }
      // 手動返信で未対応が 1 件減るので、サイドバーのバッジを即時更新させる
      window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
      // 引用は1回の送信で使い切る。残すと次の返信にも同じ引用が付く。
      // 送信した会話が開かれたまま、かつ引用が送った版のままのときだけ外す(#962 F06)。
      if (selectedChatIdRef.current === sendingChatId && detailAccountRef.current === sendingAccountId) {
        setQuotedMessage((prev) => (prev === quotedMessage ? null : prev))
      }
    } catch (sendError) {
      // 別の会話・アカウントへ切り替えたあとの古い失敗は、
      // 新しい画面へ出さない(A02-04)。
      if (detailAccountRef.current === sendingAccountId && selectedChatIdRef.current === sendingChatId) {
        setSendError(describeSendFailure(sendError))
      }
    } finally {
      setSending(false)
      sendLockRef.current = false
    }
  }

  /**
   * G-4: テンプレートのパック送信。選んだ順の本文を1回のpushにまとめて送る。
   * 入力欄・添付・引用とは別系統で、パック自身が完結した送信単位になる。
   * （LINEのpushは1回あたり5通まで。）
   */
  const handleSendPack = async (pack: NonNullable<Options['pendingPack']>) => {
    if (pack.chatId !== selectedChatId || pack.accountId !== selectedAccountId) { setPendingPack(null); return }
    const texts = pack.texts
    if (!selectedChatId || texts.length === 0 || sendLockRef.current) return
    const sendingChatId = selectedChatId
    const sendingAccountId = selectedAccountId
    setSendError('')
    sendLockRef.current = true
    setSending(true)
    let acknowledged = false
    try {
      const now = new Date().toISOString()
      const signature = JSON.stringify({ chatId: sendingChatId, combined: true, texts })
      const sendResult = await previewSend(texts.map((content) => ({ messageType: 'text', content })), () => api.chats.sendCombined(sendingChatId,
        { texts, revision: pack.revision, ...(senderId ? { senderId } : {}) } as Parameters<typeof api.chats.sendCombined>[1],
        sendKeysRef.current.get(signature),
      ))
      if (!sendResult.success) {
        if (detailAccountRef.current === sendingAccountId && selectedChatIdRef.current === sendingChatId) {
          setSendError(sendResult.error || '送信できませんでした。時間をおいて、もう一度お試しください。')
        }
        return false
      }
      acknowledged = true
      sendKeysRef.current.clear(signature)
      const staffName = sendResult.data.sentByStaffName
      const packMessages = texts.map((content, index) =>
        buildOutgoingMessage({ id: sendResult.data.messageIds?.[index] ?? `${sendResult.data.messageId}:${index}`, messageType: 'text', content, sentByStaffName: staffName, sentAt: now }),
      )
      setChatDetail((prev) => (prev && prev.id === sendingChatId) ? {
        ...prev,
        lastMessageAt: now,
        status: 'in_progress',
        revision: sendResult.data.revision,
        messages: appendSentMessages(prev.messages ?? [], packMessages),
      } : prev)
      setChats((prev) => {
        const exists = prev.some((c) => c.id === sendingChatId)
        if (!exists) return prev
        return refreshChatListAfterSend(prev, statusFilterRef.current, (c) => (c.id === sendingChatId ? {
          ...c,
          lastMessageAt: now,
          status: 'in_progress' as const,
          // 一覧のpreviewはパックの最後の1通を見せる（相手に届く並びの末尾）。
          lastMessageContent: texts[texts.length - 1],
          lastMessageDirection: 'outgoing' as const,
          lastMessageType: 'text' as const,
        } : c))
      })
      // 手動返信で未対応が減るので、サイドバーのバッジを即時更新させる
      window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
      return true
    } catch (sendError) {
      if (acknowledged) {
        if (detailAccountRef.current === sendingAccountId && selectedChatIdRef.current === sendingChatId) setSendError('送信は受け付けました。表示を読み直してください。')
        return true
      }
      if (detailAccountRef.current === sendingAccountId && selectedChatIdRef.current === sendingChatId) {
        setSendError(describeSendFailure(sendError))
      }
      return false
    } finally {
      setSending(false)
      sendLockRef.current = false
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // IME変換確定のEnterでは送信しない
    if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) return
    if (e.key !== 'Enter') return
    // sendMode 'enter': Enter単体で送信、Shift+Enterは改行
    // sendMode 'shift-enter': Shift+Enterで送信、Enter単体は改行
    const shouldSend = sendMode === 'enter' ? !e.shiftKey : e.shiftKey
    if (shouldSend) {
      e.preventDefault()
      handleSendMessage()
    }
  }
  const pendingMessages = pendingSend?.chatId === selectedChatId && pendingSend.accountId === selectedAccountId ? pendingSend.messages : undefined
  return { handleSendMessage, handleSendPack, handleKeyDown, sendError, pendingMessages }
}
