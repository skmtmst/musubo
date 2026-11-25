'use client'
import { type ChatDetail as ApiChatDetail, type ChatDetailMessage } from '@/lib/api';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

type Options = {
  selectedChatId: string | null
  chatDetail: ApiChatDetail | null
  pendingMessages?: ChatDetailMessage[]
}

export function useInboxScroll({ selectedChatId, chatDetail, pendingMessages }: Options) {

  const messages = useMemo(() => pendingMessages?.length ? [...(chatDetail?.messages ?? []), ...pendingMessages] : chatDetail?.messages, [chatDetail?.messages, pendingMessages])

  const messagesScrollRef = useRef<HTMLDivElement | null>(null)

  /*
   * INBOX-27: スクロール位置の決め方を分けるための記録。
   * - stickToBottomRef: いま下端にいるか。下端にいる間だけ新着へ追従する。
   * - prevMessageWindowRef: 前回描いた会話・最後尾・件数。追加か切替かを判別する。
   * - unseenIncoming: 読んでいる途中に下へ届いた相手からの新着件数。
   */
  const stickToBottomRef = useRef(true)

  const prevMessageWindowRef = useRef<{ chatId: string; lastId: string | null; count: number } | null>(null)

  const [unseenIncoming, setUnseenIncoming] = useState(0)

  // U008: 狭い幅で切れた宛先名を、その場で全文に広げるための状態。

  // 会話を変えたら広げた表示も元へ戻す。
  useEffect(() => {
    setUnseenIncoming(0)
    stickToBottomRef.current = true
  }, [selectedChatId])

  /*
   * INBOX-27: メッセージの描画後にスクロール位置を決める。
   *
   * - 最初の表示・会話の切替 … 新しい方(下端)から見せる。
   * - 「前のメッセージ」で上へ足した … 高さの増分だけ scrollTop を足して、
   *   読んでいたメッセージが同じ画面位置に残るようにする。
   * - 下への新着(自分の送信・相手の返信・定期更新) … 下端にいる時だけ
   *   追従。読み返している途中なら動かさず、新着件数の目印を出す。
   */
  useLayoutEffect(() => {
    const el = messagesScrollRef.current
    const list = messages
    if (!chatDetail || !el || !list || list.length === 0) {
      if (!list || list.length === 0) prevMessageWindowRef.current = null
      return
    }
    const lastId = list[list.length - 1]?.id ?? null
    const prev = prevMessageWindowRef.current
    prevMessageWindowRef.current = { chatId: chatDetail.id, lastId, count: list.length }

    const sameChat = prev?.chatId === chatDetail.id
    if (!sameChat) {
      el.scrollTop = el.scrollHeight
      return
    }
    const appended = prev.lastId !== lastId
    if (appended && !stickToBottomRef.current) {
      // 読み返し中に届いた分は動かさず、実際に増えた相手からの件数だけ出す。
      const prevIndex = list.findIndex((m) => m.id === prev.lastId)
      const fresh = prevIndex >= 0 ? list.slice(prevIndex + 1) : list
      const incomingCount = fresh.filter((m) => m.direction === 'incoming').length
      if (incomingCount > 0) setUnseenIncoming((count) => count + incomingCount)
      return
    }
    // 上へ足しただけ（前のメッセージ）・取り直しで中身が同じ … 位置は窓分けが守る。
    if (appended) el.scrollTop = el.scrollHeight
  }, [messages, chatDetail?.id])

  // 画像などの遅れての読み込みで高さが伸びても、読み返し中の位置を崩さない。
  // 2026-10-07：窓分け（ChatThreadWindow）が行の高さの変化を見張って直す。
  // 下端にいる時だけ下端へ寄せ直す。失敗→代替表示で高さが縮む場合も同じ。

  // スクロール位置を追い続ける。下端にいる間だけ新着へ追従する(INBOX-27)。
  useEffect(() => {
    const el = messagesScrollRef.current
    if (!el) return
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 40
      stickToBottomRef.current = atBottom
      if (atBottom) setUnseenIncoming(0)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
    /*
     * 会話を選んだ直後は読み込み中でスクロール欄がまだ無い。選んだ時だけ
     * 付けると見張りが付かず「いつも下にいる」扱いになり、読み返している
     * 途中でも新着で下へ飛んでいた（2026-10-07 測って見つけた）。欄が出来た
     * 時（会話の中身が届いた時）にも付け直す。
     */
  }, [selectedChatId, chatDetail?.id])

  return { messagesScrollRef, unseenIncoming, setUnseenIncoming }
}
