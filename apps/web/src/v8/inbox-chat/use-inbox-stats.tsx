'use client'
import { api, fetchApi, type InboxStats } from '@/lib/api';
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events';
import { invalidateApiReads } from '@/lib/api/transport/read-cache';
import { withRequestTimeout } from '@/lib/request-timeout';
import { useEffect, useRef, useState } from 'react';
import { StatusFilter } from './inbox-model';

type Options = {
  selectedAccountId: string | null
  statusFilter: StatusFilter
  debouncedNameQuery: string
  assigneeFilter: string
  unreadOnly: boolean
  channel: "email" | "all" | "line"
  socialChannel?: 'all' | 'line' | 'instagram'
}

export function useInboxStats({ selectedAccountId, statusFilter, debouncedNameQuery, assigneeFilter, unreadOnly, channel, socialChannel }: Options) {

  // 担当の選択肢（設計 `TalkPane` の「担当」）。
  const [operators, setOperators] = useState<Array<{ id: string; name: string }>>([])

  /*
    担当者ごとの未読数（設計 `YZaDK`）。**画面に見えている行から数えない**——
    一覧はページ送りされるので、2ページ目の未読が落ちる。
    `null` は「まだ読めていない」。**実値0とは別。**
  */
  const [assigneeUnread, setAssigneeUnread] = useState<InboxStats['assigneeUnread'] | null>(null)

  /*
   * INBOX-09: 札の件数。「どの条件に対する応答か」を key で結び付け、
   * 条件を変えた直後に古い条件の件数が出ないようにする。
   */
  const [quickCounts, setQuickCounts] = useState<{
    key: string
    counts: { all: number; reply: number; overdue: number }
  } | null>(null)

  const quickCountsRequestRef = useRef(0)
  const [refreshVersion, setRefreshVersion] = useState(0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        // 新着・再確認の知らせでは、変更前から待っている集計にも相乗りしない。
        invalidateApiReads('/api/chats')
        setRefreshVersion((current) => current + 1)
      }, 120)
    }
    window.addEventListener(UNANSWERED_REFRESH_EVENT, refresh)
    return () => {
      window.removeEventListener(UNANSWERED_REFRESH_EVENT, refresh)
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])


  const [assigneeUnreadStatus, setAssigneeUnreadStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    setOperators([])
    if (!selectedAccountId) return () => { cancelled = true }
      ; (async () => {
        try {
          const res = await fetchApi<{ success: boolean; data: Array<{ id: string; name: string }> }>(
            `/api/operators${selectedAccountId ? `?lineAccountId=${encodeURIComponent(selectedAccountId)}` : ''}`,
          )
          if (!cancelled && res.success) setOperators(res.data)
        } catch {
          // 担当を選べないだけ。返信そのものは続けられる。
        }
      })()
    return () => {
      cancelled = true
    }
  }, [selectedAccountId])

  useEffect(() => {
    let cancelled = false
    /*
      **アカウントを切り替えたら、前の集計をその場で捨てる。**
      読み終わるまで残すと、別のアカウントの未読数を見たまま担当者を選ぶ。
    */
    setAssigneeUnread(null)
    setAssigneeUnreadStatus('loading')
      ; (async () => {
        try {
          const res = await api.chatStats.get(selectedAccountId)
          if (cancelled) return
          /* 失敗の返事を成功として読まない。`—` のままにする。 */
          if (!res.success) throw new Error('failed')
          setAssigneeUnread(res.data.assigneeUnread)
          setAssigneeUnreadStatus('ready')
        } catch {
          /*
            **集計の失敗を0件と扱わない。** `null` のままにして数だけ `—` にする。
            担当者一覧そのものは `/api/operators` の結果を保つ。
          */
          if (!cancelled) {
            setAssigneeUnread(null)
            setAssigneeUnreadStatus('error')
          }
        }
      })()
    return () => {
      cancelled = true
    }
  }, [selectedAccountId, refreshVersion])

  /*
   * INBOX-09: 「すべて／要返信／1時間以上待ち」の件数は、一覧と同じ条件で
   * サーバーに数えさせる。quickFilter 自体は条件に含めない（各札は
   * 「その札を押したときの件数」を表す）。応答が着順違れで戻っても
   * requestId で新しい方だけを採用する。
   */
  const quickCountsKey = JSON.stringify([statusFilter, selectedAccountId, debouncedNameQuery, assigneeFilter, unreadOnly, channel, socialChannel])

  useEffect(() => {
    const requestId = ++quickCountsRequestRef.current
    const key = quickCountsKey
    // #625: 応答なしの要求は時間切れの失敗にする。件数は「—」へ戻り、0化しない。
    void withRequestTimeout(api.chats.quickCounts({
      status: statusFilter === 'all' ? undefined : statusFilter,
      operatorId: assigneeFilter === 'all' ? undefined : assigneeFilter,
      accountId: selectedAccountId || undefined,
      q: debouncedNameQuery || undefined,
      unreadOnly,
      channel: socialChannel === 'instagram' ? 'instagram' : socialChannel === 'line' ? 'line' : channel,
      ...(socialChannel ? { socialChannel } : {}),
    })).then((res) => {
      if (quickCountsRequestRef.current !== requestId) return
      /* 失敗や変な形の応答を0件と読まない。`—` のままにする。 */
      setQuickCounts(
        res.success && res.data && typeof res.data.all === 'number'
          ? { key, counts: { all: res.data.all, reply: res.data.reply, overdue: res.data.overdue } }
          : null,
      )
    }).catch(() => {
      if (quickCountsRequestRef.current === requestId) setQuickCounts(null)
    })
    return () => { quickCountsRequestRef.current += 1 }
  }, [refreshVersion, quickCountsKey, statusFilter, selectedAccountId, debouncedNameQuery, assigneeFilter, unreadOnly, channel, socialChannel])

  /*
   * ★V8 状態の切り替えの件数（未対応 5・対応中 2…）。一覧と同じ条件（アカウント・担当・名前・
   * 未読だけ・経路）で、状態ごとに件数の口へ聞く。失敗は0件にせず数を出さない。互換経路では聞かない。
   */
  const statusCountsKey = JSON.stringify([selectedAccountId, debouncedNameQuery, assigneeFilter, unreadOnly, channel])

  const [statusCounts, setStatusCounts] = useState<{ key: string; counts: Record<Exclude<StatusFilter, 'all'>, number> } | null>(null)

  const statusCountsRequestRef = useRef(0)

  useEffect(() => {

    const requestId = ++statusCountsRequestRef.current
    const key = statusCountsKey
    const keys = ['unread', 'in_progress', 'on_hold', 'resolved'] as const
    void Promise.all(keys.map((status) => withRequestTimeout(api.chats.quickCounts({
      status,
      operatorId: assigneeFilter === 'all' ? undefined : assigneeFilter,
      accountId: selectedAccountId || undefined,
      q: debouncedNameQuery || undefined,
      unreadOnly,
      channel,
    })))).then((results) => {
      if (statusCountsRequestRef.current !== requestId) return
      const alls = results.map((res) => (res.success && res.data && typeof res.data.all === 'number' ? res.data.all : null))
      if (alls.some((n) => n === null)) {
        setStatusCounts(null)
        return
      }
      const counts = Object.fromEntries(keys.map((status, i) => [status, alls[i]])) as Record<Exclude<StatusFilter, 'all'>, number>
      setStatusCounts({ key, counts })
    }).catch(() => {
      if (statusCountsRequestRef.current === requestId) setStatusCounts(null)
    })
    return () => { statusCountsRequestRef.current += 1 }
  }, [refreshVersion, statusCountsKey, selectedAccountId, debouncedNameQuery, assigneeFilter, unreadOnly, channel])

  const statusCountsNow = statusCounts?.key === statusCountsKey ? statusCounts.counts : null

  /*
   * INBOX-09: 札の件数は一覧と同じ条件（アカウント・検索・担当・経路・
   * 未読）をサーバーで数えたものだけを出す。以前は「すべて」に画面へ
   * 読み込んだ行数（最大200件）を出し、「要返信」にはフィルタを
   * 通さない別集計を出していたため、押した結果と件数が一致しなかった。
   * 条件に対応した応答が届くまでは `—` を出し、部分件数を全件数の
   * ように見せない。
   */
  const quickCountsNow = quickCounts?.key === quickCountsKey ? quickCounts.counts : null
  return { operators, assigneeUnread, assigneeUnreadStatus, statusCountsNow, quickCountsNow }
}
