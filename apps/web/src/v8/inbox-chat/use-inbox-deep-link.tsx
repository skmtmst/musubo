'use client'
import type { Dispatch, SetStateAction } from 'react';
import { api } from '@/lib/api';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { EMAIL_SOURCE_URL_KEY, emailSourceFromParam, type EmailRef } from './email-sources';
import { DEEP_LINK_NOTICE, buildInboxUrl, isSafeFriendIdForInbox } from './inbox-model';
type Options = {
  params: ReturnType<typeof useSearchParams>
  setSelectedChatId: Dispatch<SetStateAction<string | null>>
  setSelectedEmail: (ref: EmailRef | null) => void
  accountsLoading: boolean
  /** 共通のメールを出すアカウントか（未選択は従来どおり出す）。 */
  sharedEmailEnabled: boolean
  /** 店舗のメール（転送用アドレス）がつながっているか。 */
  storeEmailEnabled: boolean
  selectedAccountId: string | null
  router: ReturnType<typeof useRouter>
  channel: "all" | "email" | "line"
  savedViewParam: string
}

export function useInboxDeepLink({ params, setSelectedChatId, setSelectedEmail, accountsLoading, sharedEmailEnabled, storeEmailEnabled, selectedAccountId, router, channel, savedViewParam }: Options) {

  /**
   * URLで指定された会話が開けなかったときの案内。
   *
   * 不正・存在しない・別アカウント・選択中と違うアカウントのIDでも
   * 別人を開かず、空のまま理由と戻り先を出す(#673)。
   */
  const [deepLinkNotice, setDeepLinkNotice] = useState('')

  /** URL由来で開こうとしているID。手選びと区別するための目印。 */
  const deepLinkIdRef = useRef<string | null>(null)

  /**
   * URL指定の解決の世代。遅い友だち照会が、新しいURLやアカウント切替で
   * 始まった解決を上書きしないようにする(#673)。
   */
  const deepLinkRequestIdRef = useRef(0)

  // Deep-link from other pages. LINE is ?friend=<friendId> (?friendId= is
  // the old form kept for shared URLs), email is ?thread=<threadId>
  // (共通。店舗のメールは &source=store を付け、店舗の口だけで開く).
  // Selecting one side always clears the other so the center panel has
  // exactly one conversation to show. Re-runs on URL change so back/forward
  // and shared URLs keep the target; reload works because the target lives
  // in the URL (#673). Manual selection never rewrites the URL, so a
  // state-only change never triggers this.
  //
  // 会話を開く前に、対象の友だちが「いま選んでいるLINEアカウント」の相手か
  // を必ず確かめる。`GET /api/chats/:id` は見る権限だけを見ており、画面で
  // 選んでいるアカウントは見ない(apps/worker の requireVisibleChat)。
  // A社とB社の両方を見られる担当者がB選択中にA社の友だちのURLを開くと、
  // 会話はA社なのに送信元の表示はB社になり、そのまま返信すると別アカウント
  // から送ってしまう。だからここで選択中アカウントへ固定する(#673)。
  useEffect(() => {
    const threadId = (params.get('thread') ?? '').trim()
    const emailSource = emailSourceFromParam(params.get(EMAIL_SOURCE_URL_KEY))
    const rawFriend = (params.get('friend') ?? params.get('friendId') ?? '').trim()
    if (threadId) {
      if (accountsLoading) return
      deepLinkRequestIdRef.current += 1
      deepLinkIdRef.current = null
      const connected = emailSource === 'store' ? storeEmailEnabled : sharedEmailEnabled
      setDeepLinkNotice(connected ? '' : emailSource === 'store'
        ? 'このアカウントでは店舗のメールを接続していません。'
        : 'このアカウントではメールを接続していません。')
      setSelectedChatId(null)
      setSelectedEmail(connected ? { source: emailSource, threadId } : null)
      return
    }
    // URLに対象が無いときは何もしない。手で選んだ会話を消さない。
    if (!rawFriend) return
    const requestId = deepLinkRequestIdRef.current + 1
    deepLinkRequestIdRef.current = requestId
    if (!isSafeFriendIdForInbox(rawFriend)) {
      // 不正なIDは口へ渡さず、別人も開かない。案内だけ出す。
      deepLinkIdRef.current = rawFriend
      setSelectedEmail(null)
      setSelectedChatId(null)
      setDeepLinkNotice(DEEP_LINK_NOTICE.malformed)
      return
    }
    // アカウント一覧が届くまでは判定できない。届いてから同じ効果が
    // もう一度動くので、ここでは開かずに待つ。先に開くと、照合前の
    // 会話が一瞬見えてしまう。
    if (accountsLoading) return

    deepLinkIdRef.current = rawFriend
    setSelectedEmail(null)
    // 照合できるまでは会話を選ばない。ここで選ぶと `api.chats.get` が
    // 走り、別アカウントの会話が表示されてしまう。
    setSelectedChatId(null)
    setDeepLinkNotice('')

    let cancelled = false
    void (async () => {
      let friendAccountId: string | null = null
      try {
        const res = await api.friends.get(rawFriend)
        if (!res.success) {
          if (!cancelled && deepLinkRequestIdRef.current === requestId) {
            setDeepLinkNotice(DEEP_LINK_NOTICE.unavailable)
          }
          return
        }
        // `lineAccountId` は `GET /api/friends/:id` の実応答にあるが、
        // 共有の型にはまだ無い。ここだけで読む。
        friendAccountId = (res.data as { lineAccountId?: string | null }).lineAccountId ?? null
      } catch {
        if (!cancelled && deepLinkRequestIdRef.current === requestId) {
          setDeepLinkNotice(DEEP_LINK_NOTICE.unavailable)
        }
        return
      }
      if (cancelled || deepLinkRequestIdRef.current !== requestId) return
      // アカウントを選んでいないときは送信元も出ないので、取り違えは
      // 起きない。一覧も全アカウント分を出しているので、ここは通す。
      if (selectedAccountId && friendAccountId !== selectedAccountId) {
        setDeepLinkNotice(DEEP_LINK_NOTICE.otherAccount)
        return
      }
      setDeepLinkNotice('')
      setSelectedChatId(rawFriend)
    })()
    return () => { cancelled = true }
  }, [params, selectedAccountId, accountsLoading, sharedEmailEnabled, storeEmailEnabled, setSelectedEmail, setSelectedChatId])

  // 案内付きの空状態から一覧へ戻る。URLの指定も外す。
  // 外さないと再読込で同じ指定が復活する(#673)。
  const clearDeepLink = () => {
    deepLinkRequestIdRef.current += 1
    deepLinkIdRef.current = null
    setDeepLinkNotice('')
    setSelectedChatId(null)
    // 会話の指定だけ外す。保存検索は一覧の条件なので残す(N-021)。
    router.replace(buildInboxUrl(channel, savedViewParam || null))
  }
  return { deepLinkNotice, setDeepLinkNotice, deepLinkIdRef, deepLinkRequestIdRef, clearDeepLink }
}
