'use client'
import { api, fetchApi } from '@/lib/api'
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events'
import { withRequestTimeout } from '@/lib/request-timeout'
import { useListSnapshot } from '@/lib/use-list-snapshot'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { classifyEmailFailure, compareEmailRows, mergeEmailRows, nextEmailPage, sameEmail, type EmailRef, type EmailSource } from './email-sources'
import type { EmailInboxItem, InboxSort, StatusFilter } from './inbox-model'
import { buildSupportEmailInboxQuery } from './support-email-query'

/** 口が返す1件。経路の印は読み込んだ側が付ける。 */
type EmailRow = Omit<EmailInboxItem, 'source'>
type EmailPageResponse = {
  success: boolean
  data?: { items?: EmailRow[]; summary?: { total?: number | null }; nextOffset?: number | null }
}

type EmailFilters = {
  status: StatusFilter
  query: string
  assignee: string
  unreadOnly: boolean
  quickFilter: 'all' | 'reply' | 'overdue'
}

/** 1つの経路の失敗。forbidden は共通の口が権限で断ったとき（共通を出さないだけで、失敗には数えない）。 */
export type EmailSourceFailure = '' | 'error' | 'forbidden'

const NO_EMAIL_ITEMS: EmailInboxItem[] = []

/**
 * 1つの経路の一覧。共通と店舗で同じ形の状態を別々に持ち、続きの位置・続きの有無・失敗を混ぜない。
 * 読む条件（状態・検索・担当・未読だけ・要返信）は両方の経路で同じにし、件数の口と同じ条件で読む。
 */
function useEmailSourceList({ source, accountId, enabled, filters, listKey, pageSize }: {
  source: EmailSource
  /** 店舗の LINE アカウント。共通は null。 */
  accountId: string | null
  enabled: boolean
  filters: EmailFilters
  listKey: string
  pageSize: number
}) {
  const { value: items, setValue: setItems } = useListSnapshot<EmailInboxItem[]>(listKey, [])
  // 失敗を「メール0件」に見せると未対応を見落とすので、0件と失敗を分けて持つ。
  const [emailError, setEmailError] = useState<EmailSourceFailure>('')
  const [failedPage, setFailedPage] = useState<'first' | 'more'>('first')
  // 初回・条件変更時の取得中。追加読み込みとは分け、0件表示を先走らせない。
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [completedKey, setCompletedKey] = useState<string | null>(null)
  const listKeyRef = useRef(listKey)
  listKeyRef.current = listKey
  const requestRef = useRef(0)
  /**
   * 次のページの offset。口の今の並びでの位置で、表示の並べ替えとは別に数える。
   * 読み込み済みの未読を既読にすると、口の並び（未読が先）でその後ろが1つ前へ詰まるので1つ戻す（markRead）。
   */
  const nextOffsetRef = useRef(0)
  /** 読み込み済みの未読を既読にした数（増えるだけ）。読み込みの間に増えた分で、位置を戻す量を決める。 */
  const readShiftRef = useRef(0)
  /** 既読で手前へ戻したまま、まだ読み直していない数。読み直しで重なった行しか届かなければ続けて読む。 */
  const overlapRef = useRef(0)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const moreLockRef = useRef(false)
  const { status, query, assignee, unreadOnly, quickFilter } = filters
  const active = enabled && (source === 'shared' || Boolean(accountId))

  const loadEmails = useCallback(async (append = false) => {
    if (!active) {
      requestRef.current += 1
      nextOffsetRef.current = 0
      overlapRef.current = 0
      setItems([])
      setEmailError('')
      setHasMore(false)
      setLoadingMore(false)
      setLoading(false)
      setCompletedKey(listKey)
      return
    }
    const requestId = append ? requestRef.current : ++requestRef.current
    if (append) {
      if (moreLockRef.current) return
      moreLockRef.current = true
      setLoadingMore(true)
    } else {
      nextOffsetRef.current = 0
      overlapRef.current = 0
      moreLockRef.current = false
      setHasMore(false)
      setLoadingMore(false)
      setLoading(true)
      setEmailError('')
    }
    const current = () => listKeyRef.current === listKey && requestRef.current === requestId
    try {
      let offset = append ? nextOffsetRef.current : 0
      const known = new Set(append ? itemsRef.current.map((item) => item.threadId) : [])
      for (let round = 0; ; round += 1) {
        const readsBefore = readShiftRef.current
        const overlap = append ? overlapRef.current : 0
        if (append) overlapRef.current = 0
        const search = buildSupportEmailInboxQuery({
          status,
          query,
          limit: pageSize,
          offset,
          assignee,
          unreadOnly,
          quickFilter: quickFilter === 'all' ? undefined : quickFilter,
        })
        // 応答の無い要求は時間切れの失敗にする。店舗の口が失敗しても共通の口へは戻らない。
        const res = await withRequestTimeout<EmailPageResponse>(source === 'store' && accountId
          ? api.accountEmail.inbox(accountId, search)
          : fetchApi<EmailPageResponse>(`/api/support/inbox?${search}`))
        if (!current()) return
        if (!res.success || !res.data || !Array.isArray(res.data.items)) throw new Error('メールの一覧を読み取れませんでした')
        const rows: EmailInboxItem[] = res.data.items.map((row) => ({ ...row, source }))
        const page = nextEmailPage({ offset, received: rows.length, total: res.data.summary?.total, nextOffset: res.data.nextOffset, pageSize })
        /*
         * 読み込みの間に既読にした行があると、口がこのページを既読の前と後のどちらの並びで作ったか分からない。
         * このページの頭から戻した数だけ手前を次に読み、前へ詰まった行を取りこぼさない（重なった行は除く）。
         */
        const readsDuring = readShiftRef.current - readsBefore
        nextOffsetRef.current = readsDuring > 0 ? Math.max(0, offset - readsDuring) : page.loaded
        const fresh = rows.filter((row) => !known.has(row.threadId))
        for (const row of rows) known.add(row.threadId)
        setItems((prev) => {
          if (!append) return rows
          const seen = new Set(prev.map((item) => item.threadId))
          // 読み直しで重なって届いた行は除き、口の並び（読み込んだ時の未読が先→新しい順）に並べ直す。
          return [...prev, ...rows.filter((row) => !seen.has(row.threadId))].sort((a, b) => compareEmailRows(a, b, false))
        })
        /*
         * 続きの読み込みの間に既読があったら、口が「続きなし」と返しても、戻した位置を少なくとも一度読み直す。
         * 手前へ戻して読み直したページが重なった行だけなら、続けて次を読む（押したのに何も増えない、を出さない）。
         */
        const mustReread = append && readsDuring > 0
        const onlyOverlap = append && fresh.length === 0 && overlap > 0 && page.hasMore
        setHasMore(page.hasMore || mustReread)
        setEmailError('')
        if (round >= 4 || !(mustReread || onlyOverlap)) break
        offset = nextOffsetRef.current
      }
    } catch (cause) {
      if (!current()) return
      const failure = classifyEmailFailure(source, cause)
      if (failure === 'forbidden') setHasMore(false)
      setFailedPage(append ? 'more' : 'first')
      setEmailError(failure)
    } finally {
      if (current()) {
        if (append) {
          moreLockRef.current = false
          setLoadingMore(false)
        } else {
          setCompletedKey(listKey)
          setLoading(false)
        }
      }
    }
  }, [active, source, accountId, status, query, assignee, unreadOnly, quickFilter, listKey, pageSize, setItems])

  useEffect(() => {
    void loadEmails()
  }, [loadEmails])

  /**
   * 開いた会話を、その経路の一覧の中だけ既読に見せる（口へは開いた側が知らせる）。並びの値（isUnread）は
   * 書き換えない。書き換えると混ぜ方の前提（各経路が未読が先に並ぶ）が崩れ、開いた行が跳ねたり待つ側へ回る。
   */
  const markRead = useCallback((threadId: string) => {
    const target = itemsRef.current.find((item) => item.threadId === threadId)
    if (!target || target.readNow) return
    // 既読の知らせで、口の並びではこの行が未読の組から抜け、後ろの未読が1つ前へ詰まる。前の位置のまま続きを
    // 読むと詰まった1件を飛ばすので、次のページを1つ手前から読む（重なって届いた行は会話IDで除く）。
    if (target.isUnread) {
      readShiftRef.current += 1
      overlapRef.current += 1
      nextOffsetRef.current = Math.max(0, nextOffsetRef.current - 1)
    }
    setItems((prev) => prev.map((item) => (item.threadId === threadId ? { ...item, readNow: true } : item)))
  }, [setItems])

  // 条件を変えた直後の描画では、前の条件の「続き」「失敗」を出さない。
  const loaded = completedKey === listKey
  const forbidden = loaded && emailError === 'forbidden'
  return {
    enabled: active,
    items: forbidden ? NO_EMAIL_ITEMS : items,
    loaded,
    loading,
    hasMore: loaded && !forbidden && hasMore,
    loadingMore,
    failure: loaded ? emailError : '' as EmailSourceFailure,
    failedPage,
    loadEmails,
    markRead,
  }
}

/**
 * 受信箱のメール。共通（既存の共通窓口）と店舗（選んでいるアカウントの転送用アドレス）を、同じ条件で
 * 別々に読んで1本の一覧にする。
 * - 共通は共通を出すアカウント（または未選択）のときだけ読む。店舗はつながっているアカウントのときだけ読む。
 * - 共通の口が権限（403）で断ったときは共通を出さないだけにする。店舗の失敗は隠さず知らせる。
 * - 続きは経路ごとに読む。見えている一覧は全体の並び（未読が先→新しい順）の先頭どおりに保つ。
 */
export function useInboxEmails({ selectedAccountId, enabled, sharedEnabled, storeAccountId, statusFilter, nameQuery, assigneeFilter, unreadOnly, quickFilter, sort, pageSize }: {
  selectedAccountId: string | null
  /** 一覧にメールを出すか（LINE だけを見ているときは読まない）。 */
  enabled: boolean
  sharedEnabled: boolean
  storeAccountId: string | null
  statusFilter: StatusFilter
  /** 送る検索語（入力の待ちと長さの切り詰めを済ませたもの）。 */
  nameQuery: string
  assigneeFilter: string
  unreadOnly: boolean
  quickFilter: 'all' | 'reply' | 'overdue'
  sort: InboxSort
  pageSize: number
}) {
  const filters = useMemo<EmailFilters>(() => ({
    status: statusFilter, query: nameQuery, assignee: assigneeFilter, unreadOnly, quickFilter,
  }), [statusFilter, nameQuery, assigneeFilter, unreadOnly, quickFilter])
  // アカウントを替えたら、同じ条件でも前のアカウントの行を出さない。
  const listKey = JSON.stringify([selectedAccountId, enabled, sharedEnabled, storeAccountId, statusFilter, nameQuery, assigneeFilter, unreadOnly, quickFilter])
  const shared = useEmailSourceList({ source: 'shared', accountId: null, enabled: enabled && sharedEnabled, filters, listKey, pageSize })
  const store = useEmailSourceList({ source: 'store', accountId: storeAccountId, enabled: enabled && Boolean(storeAccountId), filters, listKey, pageSize })

  const merged = useMemo(() => mergeEmailRows(shared.items, store.items, {
    // 続きの読み込みに失敗した経路は待たせない（待つと、もう一方の行まで見えなくなる）。
    sharedMore: shared.hasMore && shared.failure === '',
    storeMore: store.hasMore && store.failure === '',
    latest: sort === 'latest',
  }), [shared.items, store.items, shared.hasMore, store.hasMore, shared.failure, store.failure, sort])

  const allItems = useMemo(() => [...shared.items, ...store.items], [shared.items, store.items])
  const sources = { shared, store } as const

  /** 一覧に出している経路（読む設定で、権限で断られていない物）と、読めなかった経路。 */
  const shownSources = (['shared', 'store'] as const).filter((source) => sources[source].enabled && sources[source].failure !== 'forbidden')
  const failedSources = (['shared', 'store'] as const).filter((source) => sources[source].failure === 'error')

  const reloadShared = shared.loadEmails
  const reloadStore = store.loadEmails
  const loadEmails = useCallback(async () => {
    await Promise.all([reloadShared(), reloadStore()])
  }, [reloadShared, reloadStore])

  // 新着・状態の変更の知らせで、両方の経路を読み直す（件数の口も同じ知らせで読み直す）。
  useEffect(() => {
    const refresh = () => { void loadEmails() }
    window.addEventListener(UNANSWERED_REFRESH_EVENT, refresh)
    return () => window.removeEventListener(UNANSWERED_REFRESH_EVENT, refresh)
  }, [loadEmails])

  const loadMoreEmails = () => {
    if (shared.hasMore) void shared.loadEmails(true)
    if (store.hasMore) void store.loadEmails(true)
  }

  /** 読めなかった経路だけを読み直す。続きで失敗した経路は続きから。 */
  const retryEmails = () => {
    for (const source of failedSources) void sources[source].loadEmails(sources[source].failedPage === 'more')
  }

  const markEmailRead = (ref: EmailRef) => sources[ref.source].markRead(ref.threadId)
  const findEmail = (ref: EmailRef | null) => (ref ? allItems.find((item) => sameEmail(item, ref)) : undefined)

  return {
    /** 一覧に出す順の行（続きを待っている行は除く）。 */
    emailItems: merged.rows,
    /** 読み込んだ全部の行（会話の相手・いちばん古い会話を探すため）。 */
    allEmailItems: allItems,
    emailLoaded: shared.loaded && store.loaded,
    emailLoading: shared.loading || store.loading,
    hasMoreEmails: shared.hasMore || store.hasMore,
    loadingMoreEmails: shared.loadingMore || store.loadingMore,
    shownEmailSources: shownSources,
    failedEmailSources: failedSources,
    loadEmails,
    loadMoreEmails,
    retryEmails,
    markEmailRead,
    findEmail,
  }
}
