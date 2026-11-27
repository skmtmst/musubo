'use client'
import { useListSnapshot } from '@/lib/use-list-snapshot'
import { api,fetchApi } from '@/lib/api';
import { inboxRoutingApi } from '@/lib/api/helpers/gap1';
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events';
import { withRequestTimeout } from '@/lib/request-timeout';
import { clampSearchQuery } from '@/lib/search-query';
import type { Dispatch,SetStateAction } from 'react';
import { useCallback,useEffect,useRef,useState } from 'react';
import { Chat,EmailInboxItem,InboxSort,ListCursor,StatusFilter,toListCursor } from './inbox-model';
import { buildSupportEmailInboxQuery } from './support-email-query';

type Options = {
  CHAT_PAGE_SIZE: number
  EMAIL_PAGE_SIZE: number
  nameQuery: string
  selectedAccountId: string | null
  emailInboxEnabled: boolean
  statusFilter: StatusFilter
  assigneeFilter: string
  unreadOnly: boolean
  quickFilter: "all" | "reply" | "overdue"
  /** 並び。期限を使う店は期限が近い順で並べるので、口へは送らない。 */
  sort?: InboxSort
  setError: Dispatch<SetStateAction<string>>
}

export function useInboxLists({ CHAT_PAGE_SIZE, EMAIL_PAGE_SIZE, nameQuery, selectedAccountId, emailInboxEnabled, statusFilter, assigneeFilter, unreadOnly, quickFilter, sort = 'unread_first', setError }: Options) {

  /*
   * メール一覧だけの失敗表示。LINE側の `error` とは別にする。
   * 以前は失敗が無言で「メール0件」に見え、未対応の見落としになった。
   * 成功したら消す。ふだんは何も出ない。
   */
  const [emailError, setEmailError] = useState('')

  // 初回・条件変更時の取得中。追加読み込みとは分け、0件表示を先走らせない。
  const [emailLoading, setEmailLoading] = useState(true)

  const [debouncedNameQuery, setDebouncedNameQuery] = useState('')

  const statusFilterRef = useRef<StatusFilter>('all')

  const [loading, setLoading] = useState(true)

  // 送信や詳細取得の error と混ぜず、一覧0件と一覧障害を判別する。
  const [chatListFailed, setChatListFailed] = useState(false)

  const [loadingMore, setLoadingMore] = useState(false)

  const [hasMoreChats, setHasMoreChats] = useState(false)

  const listScrollRef = useRef<HTMLDivElement | null>(null)

  // ページング用カーソル。表示リストは楽観更新で並び替わるため、
  // 「サーバから最後に受け取った行」を ref で保持して次ページの起点にする
  // (offset 方式だと新着で行が押し下げられた分が欠落する)。
  const nextCursorRef = useRef<ListCursor | null>(null)

  /*
   * 「さらに読み込む」で足したページがあるか。定期の取り直しは1ページ目だけを
   * 取るので、足したあとにカーソルを1ページ目の末尾へ戻すと、次の「さらに
   * 読み込む」が読み済みの2ページ目を取り直して何も増えない（2026-10-07 測って
   * 見つけた。10,000 件の見本で、5秒ごとに押しても 400 件から先へ進まなかった）。
   */
  const extraPagesLoadedRef = useRef(false)

  useEffect(() => {
    /*
     * #625: サーバーへ送る検索語は上限へ切り詰める。入力欄の maxLength に
     * 頼るだけだと、保存した検索の復元など欄を通らない経路で長い語が
     * そのまま出ていく。
     */
    const timer = window.setTimeout(() => setDebouncedNameQuery(clampSearchQuery(nameQuery.trim())), 250)
    return () => window.clearTimeout(timer)
  }, [nameQuery])

  /* 返事の期限（G3）。店が期限を使っているときだけ、札・期限超過の数・期限が近い順の並びを出す。読めなければ今までの形のまま。 */
  const [slaEnabled, setSlaEnabled] = useState(false)

  const [overdueTotal, setOverdueTotal] = useState<number | null>(null)

  const [slaReload, setSlaReload] = useState(0)

  useEffect(() => {
    setSlaEnabled(false); setOverdueTotal(null)
    if (!selectedAccountId) return
    let live = true
    void inboxRoutingApi.get(selectedAccountId).then((res) => { if (live) setSlaEnabled(Boolean(res.data.enabled)) }, () => { })
    return () => { live = false }
  }, [selectedAccountId, slaReload])

  const buildListParams = useCallback((cursor: ListCursor | null) => {
    const params: {
      status?: string; accountId?: string; q?: string;
      operatorId?: string; unreadOnly?: boolean; quickFilter?: 'reply' | 'overdue';
      sort?: 'latest';
      limit?: number; beforeUnread?: 0 | 1; beforeAt?: string; beforeId?: string;
    } = {}
    const latest = sort === 'latest' && !slaEnabled
    if (statusFilter !== 'all') params.status = statusFilter
    if (selectedAccountId) params.accountId = selectedAccountId
    if (debouncedNameQuery) params.q = debouncedNameQuery
    if (assigneeFilter !== 'all') params.operatorId = assigneeFilter
    if (unreadOnly) params.unreadOnly = true
    if (quickFilter !== 'all') params.quickFilter = quickFilter
    /* 返事の期限を使う店：「期限超過」は旧い「1時間以上待ち」の絞りを使わない。期限の絞り・並びは読んだ行の slaState・slaDueAt で行う。 */
    if (slaEnabled && quickFilter === 'overdue') delete params.quickFilter
    // 新しい順は既定の並びと違うときだけ送る（既定の呼び方は変えない）。続きの位置に未読は使わない。
    if (latest) params.sort = 'latest'
    params.limit = CHAT_PAGE_SIZE
    if (cursor) {
      if (!latest) params.beforeUnread = cursor.unread
      params.beforeAt = cursor.at
      params.beforeId = cursor.id
    }
    return params
  }, [statusFilter, selectedAccountId, debouncedNameQuery, assigneeFilter, unreadOnly, quickFilter, slaEnabled, sort, CHAT_PAGE_SIZE])

  // Compare at render time too: an old request can finish before the next effect runs.
  const listFilterKey = JSON.stringify([statusFilter, selectedAccountId, emailInboxEnabled, debouncedNameQuery, assigneeFilter, unreadOnly, quickFilter, slaEnabled, sort])

  const { value: chats, setValue: setChats } = useListSnapshot<Chat[]>(listFilterKey, [])
  const { value: emailItems, setValue: setEmailItems } = useListSnapshot<EmailInboxItem[]>(listFilterKey, [])

  const listFilterKeyRef = useRef(listFilterKey)

  listFilterKeyRef.current = listFilterKey

  const chatListRequestRef = useRef(0)
  const pendingReads = useRef(new Map<string, object>())
  useEffect(() => { pendingReads.current.clear() }, [selectedAccountId])
  const maskPendingReads = useCallback((rows: Chat[]) => rows.map(row => pendingReads.current.has(row.id) ? {...row,isUnread:false,unreadCount:0} : row), [])

  const emailListRequestRef = useRef(0)

  const emailMoreLockRef = useRef(false)

  // 描画中の条件と、各一覧が最後まで取得できた条件を結び付ける。
  // useEffect が loading を立てる前の1描画でも、旧条件の0件を新条件の0件と誤認しない。
  const [chatListCompletedKey, setChatListCompletedKey] = useState<string | null>(null)

  /* 上の「期限超過 N」。一覧と同じ口（期限超過の絞り込み）の総数を使う。行数とは別に数えさせる。 */
  useEffect(() => {
    if (!slaEnabled || !selectedAccountId) { setOverdueTotal(null); return }
    let live = true
    void inboxRoutingApi.listByDeadline(selectedAccountId, { overdue: true, limit: 1 }).then((res) => { if (live) setOverdueTotal(res.total) }, () => { if (live) setOverdueTotal(null) })
    return () => { live = false }
  }, [slaEnabled, selectedAccountId, chatListCompletedKey])

  const [emailListCompletedKey, setEmailListCompletedKey] = useState<string | null>(null)

  // メール一覧の1ページ件数。上限200切りっぱなしだった offset なし取得を、
  // LINE側と同じく「さらに読み込む」で遡れるようにする。

  const [loadingMoreEmails, setLoadingMoreEmails] = useState(false)

  const [hasMoreEmails, setHasMoreEmails] = useState(false)

  /** メールの問い合わせを取る。LINEと同じ一覧に混ぜるため。 */
  const loadEmails = useCallback(async (offset = 0, append = false) => {
    if (!emailInboxEnabled) {
      emailListRequestRef.current += 1
      setEmailItems([])
      setEmailError('')
      setHasMoreEmails(false)
      setLoadingMoreEmails(false)
      setEmailLoading(false)
      setEmailListCompletedKey(listFilterKey)
      return
    }
    const requestId = append ? emailListRequestRef.current : ++emailListRequestRef.current
    if (append) {
      if (emailMoreLockRef.current) return
      emailMoreLockRef.current = true
      setLoadingMoreEmails(true)
    } else {
      setHasMoreEmails(false)
      emailMoreLockRef.current = false
      setLoadingMoreEmails(false)
      setEmailLoading(true)
      setEmailError('')
    }
    try {
      // #625: 応答なしの要求は時間切れの失敗にし、読み込み中を残さない。
      const res = await withRequestTimeout(fetchApi<{
        success: boolean
        data: { items: EmailInboxItem[]; summary?: { total: number } }
      }>(
        `/api/support/inbox?${buildSupportEmailInboxQuery({
          status: statusFilter,
          query: debouncedNameQuery,
          limit: EMAIL_PAGE_SIZE,
          offset,
          assignee: assigneeFilter,
          unreadOnly,
          quickFilter: quickFilter === 'all' ? undefined : quickFilter,
        })}`,
      ))
      if (listFilterKeyRef.current !== listFilterKey || emailListRequestRef.current !== requestId) return
      if (res.success && res.data && Array.isArray(res.data.items)) {
        setEmailError('')
        if (append) {
          const rows = res.data.items
          setEmailItems((prev) => {
            const seen = new Set(prev.map((e) => e.id))
            return [...prev, ...rows.filter((r) => !seen.has(r.id))]
          })
          setHasMoreEmails(offset + rows.length < (res.data.summary?.total ?? offset + rows.length))
        } else {
          setEmailItems(res.data.items)
          setHasMoreEmails(res.data.items.length >= EMAIL_PAGE_SIZE
            && res.data.items.length < (res.data.summary?.total ?? res.data.items.length + 1))
        }
      } else {
        // 口が success:false を返したときも、0件と区別できるよう失敗を出す。
        setEmailError('メールの読み込みに失敗しました。時間をおいて、もう一度お試しください。')
      }
    } catch {
      if (listFilterKeyRef.current !== listFilterKey || emailListRequestRef.current !== requestId) return
      // メールが出ないだけ。LINEのトークは使えるが、0件と区別できるよう失敗を出す。
      setEmailError('メールの読み込みに失敗しました。時間をおいて、もう一度お試しください。')
    } finally {
      if (append && listFilterKeyRef.current === listFilterKey && emailListRequestRef.current === requestId) {
        emailMoreLockRef.current = false
        setLoadingMoreEmails(false)
      }
      if (!append && listFilterKeyRef.current === listFilterKey && emailListRequestRef.current === requestId) {
        setEmailListCompletedKey(listFilterKey)
        setEmailLoading(false)
      }
    }
  }, [statusFilter, debouncedNameQuery, assigneeFilter, unreadOnly, quickFilter, listFilterKey, EMAIL_PAGE_SIZE, emailInboxEnabled, setEmailItems])

  useEffect(() => {
    void loadEmails()
  }, [loadEmails])

  const loadChats = useCallback(async () => {
    const requestId = ++chatListRequestRef.current
    nextCursorRef.current = null
    extraPagesLoadedRef.current = false
    setHasMoreChats(false)
    setLoadingMore(false)
    setLoading(true)
    setChatListFailed(false)
    setError('')
    try {
      // #625: 応答なしの要求は時間切れの失敗にし、読み込み中を残さない。
      const chatRes = await withRequestTimeout(api.chats.list(buildListParams(null)))
      if (listFilterKeyRef.current !== listFilterKey || chatListRequestRef.current !== requestId) return
      if (chatRes.success) {
        setChatListFailed(false)
        const rows = maskPendingReads(chatRes.data)
        setChats(rows)
        const last = rows[rows.length - 1]
        nextCursorRef.current = toListCursor(last)
        // ページ丁度いっぱい返ってきた = 続きがある可能性が高い
        setHasMoreChats(rows.length === CHAT_PAGE_SIZE)
      } else {
        // 一覧の失敗は一覧の中の失敗行(再読み込みボタンつき)が伝える。
        // 上部の汎用 error は送信・詳細など別の操作の失敗に使う(N-030)。
        setChatListFailed(true)
      }
    } catch {
      if (listFilterKeyRef.current !== listFilterKey || chatListRequestRef.current !== requestId) return
      setChatListFailed(true)
    } finally {
      if (listFilterKeyRef.current === listFilterKey && chatListRequestRef.current === requestId) {
        setChatListCompletedKey(listFilterKey)
        setLoading(false)
      }
    }
  }, [buildListParams, listFilterKey, setError, CHAT_PAGE_SIZE, setChats, maskPendingReads])

  // 「さらに読み込む」— サーバ由来カーソルの続きを取得して末尾に追加する。
  // 楽観更新との競合に備えて既存 id は除外し、重複表示を防ぐ。
  const loadMoreChats = useCallback(async () => {
    if (loadingMore) return
    const cursor = nextCursorRef.current
    if (!cursor) {
      setHasMoreChats(false)
      return
    }
    setLoadingMore(true)
    const requestId = chatListRequestRef.current
    try {
      // #625: 応答なしの要求は時間切れの失敗にし、読み込み中を残さない。
      const chatRes = await withRequestTimeout(api.chats.list(buildListParams(cursor)))
      if (listFilterKeyRef.current !== listFilterKey || chatListRequestRef.current !== requestId) return
      if (chatRes.success) {
        const rows = maskPendingReads(chatRes.data)
        setChats((prev) => {
          const seen = new Set(prev.map((c) => c.id))
          return [...prev, ...rows.filter((r) => !seen.has(r.id))]
        })
        const last = rows[rows.length - 1]
        nextCursorRef.current = toListCursor(last)
        extraPagesLoadedRef.current = true
        setHasMoreChats(rows.length === CHAT_PAGE_SIZE)
      }
    } catch {
      if (listFilterKeyRef.current !== listFilterKey || chatListRequestRef.current !== requestId) return
      setError('チャットの追加読み込みに失敗しました。時間をおいて、もう一度お試しください。')
    } finally {
      if (listFilterKeyRef.current === listFilterKey && chatListRequestRef.current === requestId) setLoadingMore(false)
    }
  }, [loadingMore, buildListParams, listFilterKey, setError, CHAT_PAGE_SIZE, setChats, maskPendingReads])

  // Keep refs in sync so setChats updater can read the latest filter without stale closure
  useEffect(() => { statusFilterRef.current = statusFilter }, [statusFilter])

  // 一覧も静かに取り直す。全画面の読み込み(loadChats)は一覧を空にして
  // 操作を止めるので、定期更新では既存の並びを崩さずに差し替える。
  const listPollRequestRef = useRef(0)

  const loadChatsQuietly = useCallback(async (): Promise<boolean> => {
    const requestId = ++listPollRequestRef.current
    try {
      const res = await api.chats.list(buildListParams(null))
      if (listPollRequestRef.current !== requestId) return true
      if (listFilterKeyRef.current !== listFilterKey) return true
      if (!res.success) return false
      const rows = maskPendingReads(res.data)
      setChats((prev) => {
        const freshIds = new Set(rows.map((row) => row.id))
        const merged = rows.slice()
        // 「さらに読み込む」で足した分は一覧の下に残す。
        for (const chat of prev) if (!freshIds.has(chat.id)) merged.push(chat)
        return merged
      })
      // 足したページがある間は、続きの起点（カーソル）と「続きがあるか」を守る。
      if (!extraPagesLoadedRef.current) {
        const last = rows[rows.length - 1]
        nextCursorRef.current = toListCursor(last)
        setHasMoreChats(rows.length === CHAT_PAGE_SIZE)
      }
      setChatListFailed(false)
      return true
    } catch {
      return false
    }
  }, [buildListParams, listFilterKey, CHAT_PAGE_SIZE, setChats, maskPendingReads])

  useEffect(() => {
    loadChats()
  }, [loadChats])

  useEffect(() => {
    const refresh = () => {
      void loadChats()
      void loadEmails()
    }
    window.addEventListener(UNANSWERED_REFRESH_EVENT, refresh)
    return () => window.removeEventListener(UNANSWERED_REFRESH_EVENT, refresh)
  }, [loadChats, loadEmails])
  const latestLoadChats = useRef(loadChats)
  const latestLoadChatsQuietly = useRef(loadChatsQuietly)
  const completedKeyRef = useRef(chatListCompletedKey)
  latestLoadChats.current = loadChats
  latestLoadChatsQuietly.current = loadChatsQuietly
  completedKeyRef.current = chatListCompletedKey
  const beginChatRead = (id: string) => {
    const token = {}; pendingReads.current.set(id,token)
    listPollRequestRef.current++
    setChats(previous => previous.map(row => row.id === id ? {...row,isUnread:false,unreadCount:0} : row))
    return (success = true) => {
      if (pendingReads.current.get(id) !== token) return
      pendingReads.current.delete(id)
      chatListRequestRef.current++; listPollRequestRef.current++
      setLoading(false); setLoadingMore(false)
      if (!success || completedKeyRef.current !== listFilterKeyRef.current) void latestLoadChats.current()
      else void latestLoadChatsQuietly.current()
    }
  }
  return { beginChatRead, chats, setChats, emailItems, setEmailItems, emailError, emailLoading, debouncedNameQuery, setDebouncedNameQuery, statusFilterRef, loading, chatListFailed, loadingMore, hasMoreChats, listScrollRef, slaEnabled, overdueTotal, setSlaReload, listFilterKey, chatListCompletedKey, emailListCompletedKey, loadingMoreEmails, hasMoreEmails, loadEmails, loadChats, loadMoreChats, loadChatsQuietly }
}
