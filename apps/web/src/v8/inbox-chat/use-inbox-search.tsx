'use client'
import { api, type ChatDetail as ApiChatDetail, type ChatDetailMessage } from '@/lib/api';
import { useChatSearch } from '@/v8/inbox-search/public/use-chat-search/index'
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CHAT_SEARCH_FILL_MAX_ROUNDS, CHAT_SEARCH_FILL_PAGE } from './inbox-model';

type Options = {
  chatDetail: ApiChatDetail | null
  messagesHasMore: boolean
  selectedChatIdRef: RefObject<string | null>
  detailAccountRef: RefObject<string | null>
  setChatDetail: Dispatch<SetStateAction<ApiChatDetail | null>>
  setMessagesHasMore: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string>>
}

export function useInboxSearch({ chatDetail, messagesHasMore, selectedChatIdRef, detailAccountRef, setChatDetail, setMessagesHasMore, setError }: Options) {

  /*
   * 会話の中を探す（V8.pen  段13・枠 、2026-10-07 オーナー採用）。V8 の画面だけ。
   * 🔍 か ⌘F で頭の下に帯を出し、当たった吹き出しへ移る。
   * 当たりがまだ読み込んでいない昔の吹き出しなら、いま読んでいる最古の1件から
   * その当たりまでを会話詳細の口で続けて読み足してから移る。読んだ分は新しい方から
   * 途切れずにつながったまま（定期の取り直し・下に付ける・窓分けの目印をそのまま使える）。
   * 位置の口（messagesAt）の around は、送った人・引用・シナリオ名を持たない形で、
   * 間が空いた並びになるので使わない（BEHAVIOR.md）。
   */
  const chatSearch = useChatSearch((chatDetail?.friendId ?? null))

  const [chatSearchFocusSeq, setChatSearchFocusSeq] = useState(0)

  const [chatSearchFilling, setChatSearchFilling] = useState(false)

  const [chatSearchTarget, setChatSearchTarget] = useState<{ id: string; seq: number } | null>(null)

  const chatMessagesRef = useRef<ChatDetailMessage[]>([])

  chatMessagesRef.current = chatDetail?.messages ?? []

  const messagesHasMoreRef = useRef(false)

  messagesHasMoreRef.current = messagesHasMore

  const searchRevealSeqRef = useRef(0)

  const openChatSearchBar = chatSearch.openBar

  const openChatSearch = useCallback(() => {
    openChatSearchBar()
    setChatSearchFocusSeq((n) => n + 1)
  }, [openChatSearchBar])

  useEffect(() => {
    if (!chatSearch.open) setChatSearchTarget(null)
  }, [chatSearch.open])

  useEffect(() => {
    const hit = chatSearch.current
    if (!hit) return
    const chatId = selectedChatIdRef.current
    const accountId = detailAccountRef.current
    if (!chatId) return
    const seq = ++searchRevealSeqRef.current
    const stale = () => seq !== searchRevealSeqRef.current
      || selectedChatIdRef.current !== chatId || detailAccountRef.current !== accountId
    void (async () => {
      let list = chatMessagesRef.current
      // 1回 1,000 件（口の上限）。1万件の会話でも 10 回まで。
      for (let round = 0; round < CHAT_SEARCH_FILL_MAX_ROUNDS && !list.some((m) => m.id === hit.id); round += 1) {
        const oldest = list[0]
        if (!oldest || !messagesHasMoreRef.current) break
        setChatSearchFilling(true)
        try {
          const res = await api.chats.get(chatId, {
            limit: CHAT_SEARCH_FILL_PAGE,
            beforeAt: oldest.eventAt ?? oldest.createdAt,
            beforeId: oldest.id,
          })
          if (stale()) return
          if (!res.success) break
          if (!Array.isArray(res.data?.messages)) throw new Error('invalid_search_messages')
          const rows = res.data.messages
          const seen = new Set(list.map((m) => m.id))
          list = [...rows.filter((m) => !seen.has(m.id)), ...list]
          chatMessagesRef.current = list
          messagesHasMoreRef.current = res.data.hasMoreMessages === true
          // 上へ足すだけ（loadOlderMessages と同じ）。見ている位置は窓分けが守る。
          setChatDetail((prev) => {
            if (!prev || prev.id !== chatId) return prev
            const had = new Set((prev.messages ?? []).map((m) => m.id))
            return { ...prev, messages: [...rows.filter((m) => !had.has(m.id)), ...(prev.messages ?? [])] }
          })
          setMessagesHasMore(res.data.hasMoreMessages === true)
        } catch {
          if (stale()) return
          break
        }
      }
      if (stale()) return
      setChatSearchFilling(false)
      if (list.some((m) => m.id === hit.id)) {
        setError((current) => current === '当たったメッセージまで読み込めませんでした。もう一度お試しください。' ? '' : current)
        setChatSearchTarget({ id: hit.id, seq })
      }
      else setError('当たったメッセージまで読み込めませんでした。もう一度お試しください。')
    })()
    return () => { searchRevealSeqRef.current += 1; setChatSearchFilling(false) }
  }, [chatSearch.current, chatSearch.moveSeq]) // eslint-disable-line react-hooks/exhaustive-deps
  // ⌘F / Ctrl+F：会話を開いている間は、ブラウザのページ内検索の代わりに会話の中を探す。
  useEffect(() => {
    if ((!chatDetail)) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        openChatSearch()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chatDetail, openChatSearch])
  return { chatSearch, chatSearchFocusSeq, chatSearchFilling, chatSearchTarget, openChatSearch }
}
