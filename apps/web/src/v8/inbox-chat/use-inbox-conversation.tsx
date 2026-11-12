'use client'
import { api,type ChatListItem } from '@/lib/api';
import type { Dispatch,RefObject,SetStateAction } from 'react';
import { useCallback,useEffect,useRef,useState } from 'react';
import { Chat,ChatDetail,DEEP_LINK_NOTICE } from './inbox-model';

type Options = {
  sendLockRef: RefObject<boolean>
  CHAT_MESSAGE_PAGE_SIZE: number
  selectedChatIdRef: RefObject<string | null>
  detailAccountRef: RefObject<string | null>
  detailRequestIdRef: RefObject<number>
  setError: Dispatch<SetStateAction<string>>
  deepLinkIdRef: RefObject<string | null>
  setDeepLinkNotice: Dispatch<SetStateAction<string>>
  selectedChatId: string | null
  selectedAccountId: string | null
  setChats: Dispatch<SetStateAction<ChatListItem[]>>
  chats: ChatListItem[]
}

export function useInboxConversation({ sendLockRef, CHAT_MESSAGE_PAGE_SIZE, selectedChatIdRef, detailAccountRef, detailRequestIdRef, setError, deepLinkIdRef, setDeepLinkNotice, selectedChatId, selectedAccountId, setChats, chats }: Options) {

  const [chatDetail, setChatDetail] = useState<ChatDetail | null>(null)

  const [detailLoading, setDetailLoading] = useState(false)

  // 会話詳細は直近100件ずつ。全文一括(1000件)だと長期の会話で応答が重い。
  // 古い分は「前のメッセージ」で遡る。

  const [messagesHasMore, setMessagesHasMore] = useState(false)

  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false)

  const loadChatDetail = useCallback(async (chatId: string) => {
    /*
     * 呼び出しの時点で開いている会話と違う相手への要求は丸ごと捨てる
     * (A02-01)。更新操作の完了後に遅れて走る再読込が、切替先の会話の
     * 応答を無効化して前の会話を表示し直すのを防ぐ。世代のカウントも
     * 進めないので、いま走っている新しい会話の取得はそのまま生きる。
     */
    if (selectedChatIdRef.current !== chatId) return
    const requestedAccountId = detailAccountRef.current
    const requestId = ++detailRequestIdRef.current
    setChatDetail((current) => current?.id === chatId ? current : null)
    setDetailLoading(true)
    setError('')
    try {
      const res = await api.chats.get(chatId, { limit: CHAT_MESSAGE_PAGE_SIZE })
      if (requestId !== detailRequestIdRef.current) return
      // 取得の途中で別の会話・アカウントへ切り替わっていたら適用しない。
      if (selectedChatIdRef.current !== chatId || detailAccountRef.current !== requestedAccountId) return
      if (res.success) {
        const detail = res.data
        setChatDetail(detail)
        setMessagesHasMore(detail.hasMoreMessages === true)
        // URL指定の会話が開けた。案内は消す(#673)。
        if (deepLinkIdRef.current === chatId) setDeepLinkNotice('')
      } else {
        setChatDetail(null)
        setMessagesHasMore(false)
        setError('会話を読み込めませんでした。時間を置いてもう一度お試しください。')
        // 存在しない・別アカウントのIDでも別人を開かず、案内を出す(#673)。
        // 口は存在の有無を404に倒すので、ここでは区別しない。
        if (deepLinkIdRef.current === chatId) setDeepLinkNotice(DEEP_LINK_NOTICE.unavailable)
      }
    } catch {
      if (requestId !== detailRequestIdRef.current) return
      setChatDetail(null)
      setMessagesHasMore(false)
      setError('会話を読み込めませんでした。時間を置いてもう一度お試しください。')
      if (deepLinkIdRef.current === chatId) setDeepLinkNotice(DEEP_LINK_NOTICE.unavailable)
    } finally {
      if (requestId === detailRequestIdRef.current) setDetailLoading(false)
    }
  }, [deepLinkIdRef, detailAccountRef, detailRequestIdRef, selectedChatIdRef, setDeepLinkNotice, setError, CHAT_MESSAGE_PAGE_SIZE])

  // 「前のメッセージ」— 表示中の最古の1件より古い分を先頭に足す。
  const loadOlderMessages = useCallback(async () => {
    if (loadingOlderMessages || !selectedChatId) return
    const oldest = chatDetail?.messages?.[0]
    if (!oldest) {
      setMessagesHasMore(false)
      return
    }
    /*
     * 取得の起点となった会話とアカウントを固定する(#962 F03)。
     * 応答が遅れて別の会話・アカウントへ切り替わったあとに届いても、
     * そこへ前の会話の履歴を混ぜない。
     */
    const requestedChatId = selectedChatId
    const requestedAccountId = selectedAccountId
    setLoadingOlderMessages(true)
    try {
      const res = await api.chats.get(requestedChatId, {
        limit: CHAT_MESSAGE_PAGE_SIZE,
        beforeAt: oldest.eventAt ?? oldest.createdAt,
        beforeId: oldest.id,
      })
      if (selectedChatIdRef.current !== requestedChatId || detailAccountRef.current !== requestedAccountId) return
      if (res.success) {
        const detail = res.data
        const rows = detail.messages ?? []
        /*
         * INBOX-27: 上へ足す追加なので、いま読んでいる位置を保持する。
         * 2026-10-07：位置は窓分け（ChatThreadWindow）が「いちばん上に見えている
         * 吹き出し」を目印に守る。高さの差で足す方式は、まだ測っていない
         * 吹き出しの見込みの高さが入るので使わない。
         */
        setChatDetail((prev) => {
          if (!prev || prev.id !== requestedChatId) return prev
          const seen = new Set((prev.messages ?? []).map((m) => m.id))
          return { ...prev, messages: [...rows.filter((m) => !seen.has(m.id)), ...(prev.messages ?? [])] }
        })
        setMessagesHasMore(detail.hasMoreMessages === true)
      }
    } catch {
      if (selectedChatIdRef.current !== requestedChatId || detailAccountRef.current !== requestedAccountId) return
      setError('前のメッセージを読み込めませんでした。')
    } finally {
      setLoadingOlderMessages(false)
    }
  }, [loadingOlderMessages, selectedChatId, chatDetail?.messages, selectedAccountId, selectedChatIdRef, detailAccountRef, setError, CHAT_MESSAGE_PAGE_SIZE])

  /*
   * INBOX-12: 開いている会話を静かに取り直す。
   * 会話ID・アカウント・定期取得の世代の照合を通った応答だけを適用する
   * ので、切替前に出した遅い応答は別の会話へ混ざらない。世代は初回
   * 読み込み(loadChatDetail)が使う detailRequestIdRef とは別にする。
   * 共有すると定期取得が初回読み込みを「古い応答」にして読み込み中の
   * まま止まる。
   * 「前のメッセージ」で遡って読み込んだ古い分は消さずに残す。
   */
  const detailPollSeqRef = useRef(0)

  const refreshChatDetailQuietly = useCallback(async (): Promise<boolean> => {
    const chatId = selectedChatIdRef.current
    if (!chatId || sendLockRef.current) return true
    const requestId = ++detailPollSeqRef.current
    const accountId = detailAccountRef.current
    try {
      const res = await api.chats.get(chatId, { limit: CHAT_MESSAGE_PAGE_SIZE })
      if (requestId !== detailPollSeqRef.current || sendLockRef.current) return true
      if (selectedChatIdRef.current !== chatId || detailAccountRef.current !== accountId) return true
      if (!res.success) return false
      const detail = res.data
      let keptOlder = false
      setChatDetail((prev) => {
        if (!prev || prev.id !== detail.id) return detail
        const latest = detail.messages ?? []
        const prevMsgs = prev.messages ?? []
        const latestIds = new Set(latest.map((m) => m.id))
        const windowStart = latest[0]?.createdAt ?? ''
        const older = prevMsgs.filter(
          (m) => !latestIds.has(m.id) && (!windowStart || m.createdAt < windowStart),
        )
        keptOlder = older.length > 0
        return { ...detail, messages: [...older, ...latest] }
      })
      if (keptOlder) {
        // 遡った分を残している間は「さらに古い分があるか」は前の値を守る。
      } else {
        setMessagesHasMore(detail.hasMoreMessages === true)
      }
      return true
    } catch {
      return false
    }
  }, [detailAccountRef, selectedChatIdRef, sendLockRef, CHAT_MESSAGE_PAGE_SIZE])

  useEffect(() => {
    if (selectedChatId) {
      loadChatDetail(selectedChatId)
    } else {
      detailRequestIdRef.current += 1
      setChatDetail(null)
      setDetailLoading(false)
    }
  }, [selectedChatId, loadChatDetail, detailRequestIdRef])

  // Surface deep-linked chats in the sidebar even when the current account
  // filter or status filter would exclude them — otherwise the user replies
  // and the conversation stays invisible until they refresh.
  // Re-runs when `chats` changes (e.g. after loadChats refetches on filter
  // change) so the synthetic entry is re-injected if the next API result
  // does not include it. Returning `prev` unchanged when already present
  // avoids any update loop.
  useEffect(() => {
    if (!chatDetail) return
    setChats((prev) => {
      if (prev.some((c) => c.id === chatDetail.id)) return prev
      // /api/chats/:id may not populate the lastMessage* fields; derive
      // from the messages array as a fallback so the sidebar preview is
      // not stuck on "(まだメッセージなし)".
      const lastMsg = chatDetail.messages?.[chatDetail.messages.length - 1]
      const entry: Chat = {
        id: chatDetail.id,
        friendId: chatDetail.friendId,
        friendName: chatDetail.friendName,
        friendPictureUrl: chatDetail.friendPictureUrl,
        operatorId: chatDetail.operatorId ?? null,
        status: chatDetail.status,
        notes: chatDetail.notes ?? null,
        revision: chatDetail.revision,
        lastMessageAt: chatDetail.lastMessageAt ?? lastMsg?.createdAt ?? null,
        lastMessageContent: chatDetail.lastMessageContent ?? lastMsg?.content ?? null,
        lastMessageDirection: chatDetail.lastMessageDirection ?? lastMsg?.direction ?? null,
        lastMessageType: chatDetail.lastMessageType ?? (lastMsg?.isUnsent ? 'unsent' : lastMsg?.messageType) ?? null,
        isUnread: false,
        createdAt: chatDetail.createdAt,
        updatedAt: chatDetail.updatedAt ?? chatDetail.createdAt,
      }
      return [entry, ...prev]
    })
  }, [chatDetail, chats, setChats])
  // 切替直後の描画も旧宛先を出さない。効果の完了を待って隠すと1描画だけ混ざる。
  const currentDetail = chatDetail?.id === selectedChatId && detailAccountRef.current === selectedAccountId ? chatDetail : null
  return { chatDetail: currentDetail, setChatDetail, detailLoading, setDetailLoading, messagesHasMore, setMessagesHasMore, loadingOlderMessages, loadChatDetail, loadOlderMessages, refreshChatDetailQuietly }
}
