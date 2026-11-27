'use client'

/*
 * 受信箱「会話の中を探す」（V8.pen  段13・枠 、2026-10-07 オーナー採用）。
 *
 * - 打って止まったら（PAUSE_MS）会話の検索の口（API-9 `api.chats.searchMessages`）を呼ぶ。
 * - 当たりは古い順に 1〜n 番。最初は**いちばん新しい当たり（n 件目）**を見る。
 *   ↑（前へ・Enter）で古い方、↓（次へ・Shift+Enter）で新しい方。端で止まる（回らない）。
 * - 当たりは 100 件ずつ読む。まだ読んでいない番号へ移るときは、その番号を含む塊を読む。
 * - 検索語を変えたら最初から（offset は検索語ごとに戻す：API の決まり）。
 * - 古い応答は捨てる（会話の切り替え・打ち直しの後に届いた分を混ぜない）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationSearchHit } from '@line-crm/shared'
import { api } from '@/lib/api'

export const CHAT_SEARCH_PAUSE_MS = 300
export const CHAT_SEARCH_PAGE = 100
export const CHAT_SEARCH_MAX_CHARS = 200

export type ChatSearchStatus = 'idle' | 'loading' | 'ready' | 'error'

/** サーバーと同じそろえ方（NFKC＋小文字）。読み込み済みの吹き出しの薄い枠に使う。 */
export const normalizeChatSearch = (s: string) => s.normalize('NFKC').toLowerCase()

export type ChatSearch = {
  open: boolean
  query: string
  status: ChatSearchStatus
  total: number
  /** いま見ている当たりの番号（0 始まり・古い順）。無いときは -1 */
  index: number
  current: ConversationSearchHit | null
  /** 移るたびに増える（同じ当たりへ戻ったときもスクロールし直す合図） */
  moveSeq: number
  openBar: () => void
  close: () => void
  setQuery: (q: string) => void
  /** 古い方へ（↑・Enter） */
  older: () => void
  /** 新しい方へ（↓・Shift+Enter） */
  newer: () => void
  /** その吹き出しが当たりか（いま見ている当たり＝current／ほか＝other） */
  hitKind: (message: { id: string; content?: string; messageType?: string; isUnsent?: boolean }) => 'current' | 'other' | null
}

export function useChatSearch(friendId: string | null): ChatSearch {
  const [open, setOpen] = useState(false)
  const [query, setQueryState] = useState('')
  const [status, setStatus] = useState<ChatSearchStatus>('idle')
  const [total, setTotal] = useState(0)
  const [index, setIndex] = useState(-1)
  const [moveSeq, setMoveSeq] = useState(0)
  const [hits, setHits] = useState<Map<number, ConversationSearchHit>>(() => new Map())
  const seqRef = useRef(0)
  const friendRef = useRef(friendId)
  friendRef.current = friendId
  const queryRef = useRef('')

  const reset = useCallback(() => {
    seqRef.current += 1
    setStatus('idle')
    setTotal(0)
    setIndex(-1)
    setHits(new Map())
  }, [])

  // 会話を替えたら閉じる（前の相手の当たりを残さない）。
  useEffect(() => {
    setOpen(false)
    setQueryState('')
    queryRef.current = ''
    reset()
  }, [friendId, reset])

  const fetchPage = useCallback(async (q: string, offset: number, seq: number) => {
    const id = friendRef.current
    if (!id) return null
    const res = await api.chats.searchMessages(id, q, offset, CHAT_SEARCH_PAGE)
    if (seq !== seqRef.current || friendRef.current !== id || queryRef.current.trim() !== q) return null
    if (!res.success) throw new Error('search_failed')
    return res.data
  }, [])

  const putHits = (prev: Map<number, ConversationSearchHit>, offset: number, list: ConversationSearchHit[]) => {
    const next = new Map(prev)
    list.forEach((hit, i) => next.set(offset + i, hit))
    return next
  }

  // 打って止まったら探す。
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (!q || !friendId) { reset(); return }
    const seq = ++seqRef.current
    setStatus('loading')
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const first = await fetchPage(q, 0, seq)
          if (!first) return
          let map = putHits(new Map(), 0, first.hits)
          const last = first.total - 1
          if (last >= 0 && !map.has(last)) {
            const offset = Math.max(0, first.total - CHAT_SEARCH_PAGE)
            const tail = await fetchPage(q, offset, seq)
            if (!tail) return
            map = putHits(map, offset, tail.hits)
          }
          setHits(map)
          setTotal(first.total)
          setIndex(first.total > 0 ? first.total - 1 : -1)
          setMoveSeq((n) => n + 1)
          setStatus('ready')
        } catch {
          if (seq === seqRef.current) setStatus('error')
        }
      })()
    }, CHAT_SEARCH_PAUSE_MS)
    return () => clearTimeout(timer)
  }, [open, query, friendId, fetchPage, reset])

  const moveTo = useCallback(async (to: number) => {
    if (status !== 'ready' || to < 0 || to >= total) return
    if (!hits.has(to)) {
      const q = queryRef.current.trim()
      const seq = seqRef.current
      const id = friendRef.current
      // 古い方へ進むときはその番号が塊の最後、新しい方へはその番号が塊の最初になるよう読む。
      const offset = to < index ? Math.max(0, to - CHAT_SEARCH_PAGE + 1) : to
      try {
        const page = await fetchPage(q, offset, seq)
        if (!page) return
        setHits((prev) => putHits(prev, offset, page.hits))
        if (!page.hits.length) return
      } catch {
        if (seq === seqRef.current && friendRef.current === id && queryRef.current.trim() === q) setStatus('error')
        return
      }
    }
    setIndex(to)
    setMoveSeq((n) => n + 1)
  }, [status, total, hits, index, fetchPage])

  const current = index >= 0 ? hits.get(index) ?? null : null
  const hitIds = useMemo(() => new Set([...hits.values()].map((h) => h.id)), [hits])
  const needle = status === 'ready' ? normalizeChatSearch(query.trim()) : ''

  const hitKind = useCallback<ChatSearch['hitKind']>((message) => {
    if (!open || !needle) return null
    if (current && message.id === current.id) return 'current'
    if (hitIds.has(message.id)) return 'other'
    if (message.isUnsent || (message.messageType && message.messageType !== 'text')) return null
    return message.content && normalizeChatSearch(message.content).includes(needle) ? 'other' : null
  }, [open, needle, current, hitIds])

  return {
    open,
    query,
    status,
    total,
    index,
    current,
    moveSeq,
    openBar: useCallback(() => setOpen(true), []),
    close: useCallback(() => {
      setOpen(false)
      setQueryState('')
      queryRef.current = ''
      reset()
    }, [reset]),
    setQuery: useCallback((q: string) => {
      const next = Array.from(q).slice(0, CHAT_SEARCH_MAX_CHARS).join('')
      queryRef.current = next
      setQueryState(next)
    }, []),
    older: useCallback(() => { void moveTo(index - 1) }, [moveTo, index]),
    newer: useCallback(() => { void moveTo(index + 1) }, [moveTo, index]),
    hitKind,
  }
}
