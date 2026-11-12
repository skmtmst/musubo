'use client'

import { usePermissionAccess } from '@/lib/use-feature-access'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { usePeopleVisitMarks } from '@/v8/booking-bookings/public/use-visit-marks/index'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { bookingApi, ApiError, type BookingMenu, type BookingRequest, type BookingStaff } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { useAccountStyle } from '@/hooks/use-account-style'
import { SERIES_QUERY_KEYS } from '@/v8/booking-gap/public/series-host/index'
import { monthKey, monthDifference } from '@/v8/booking-bookings/public/month-navigation/index'
import { useDetailPanelUrl } from '@/components/shared/detail-panel'
import { type ContextMenuItem } from '@/components/shared/context-menu'
import { withViewTransition } from '@/components/shared/view-transition'
import { usePageTitle } from '../../../components/shell/page-chrome'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { fetchAllPages } from './fetch-all-pages'
import { moveDay, startOfWeek, type CalendarAvailability, type CalendarSlot } from './booking-calendar'
import { STATUS_TABS, SOURCE_FILTERS, PAGE_SIZE, jstDay, LEDGER_QUERY_KEYS, LEDGER_STORAGE_KEY, LedgerSavedState, readLedgerState, matchesLedgerSource } from './ledger-model'

type DecisionTarget = { id: string; accountId: string; action: 'approve' | 'reject' | 'cancel' | 'no_show' | 'complete' }

export function useBookingLedger() {
  usePageTitle('予約管理')
  const { selectedAccountId, selectedAccount } = useAccount()
  const styleProfile = useAccountStyle(selectedAccountId)
  const urlParams = useSearchParams()
  const router = useRouter()
  const [view, setView] = useState<'day' | 'week' | 'month' | 'list'>('day')
  const [tab, setTab] = useState<string>('requested')
  /** 今日・今週と、休業日のリンクから指定した1日の絞り込み。 */
  const [range, setRange] = useState<'all' | 'today' | 'week' | 'date'>('all')
  /** 「今月」の表の月送り（0＝今月）。数の帯は今月のまま。 */
  /*
   * R317: URLの条件（`?view=` `?status=` `?range=` `?date=` `?q=` …）で
   * 絞り込み済みの一覧を開ける（IDEA-01）。ダッシュボードの「予約状況」
   * カードは `?view=list&status=requested` でここへ来る。URLに何も
   * なければ、同じタブで見ていた状態（入力画面のパンくずなど条件を
   * 持たない行き先から帰ってきたとき）へ戻す。初回だけ状態へ写し、
   * 知らない値は既定へ落とす。
   */
  const urlInitRef = useRef(false)
  const [ledgerRestored, setLedgerRestored] = useState(false)
  // R317: 復元で絞り込みが変わっても、戻したページは1へ戻さない。
  const pageResetRef = useRef({ seenMount: false, restoreTransition: false })
  useEffect(() => {
    if (urlInitRef.current) return
    urlInitRef.current = true
    const hasQuery = LEDGER_QUERY_KEYS.some((key) => urlParams.get(key) !== null)
    // URLに条件が無いときだけ、同じタブの保存を使う。URLがあるときは
    // URLを正とし、混ぜない（共有URLを開いた人が他人の条件を見ない）。
    const saved = !hasQuery ? readLedgerState() : null
    if (saved) pageResetRef.current.restoreTransition = true
    const get = (key: keyof LedgerSavedState) => urlParams.get(key) ?? saved?.[key] ?? null
    const viewParam = get('view')
    if (viewParam === 'day' || viewParam === 'week' || viewParam === 'month' || viewParam === 'list') {
      setView(viewParam)
      pageResetRef.current.restoreTransition = true
    }
    const statusParam = get('status')
    if (statusParam && STATUS_TABS.some((item) => item.key === statusParam)) {
      setTab(statusParam)
      pageResetRef.current.restoreTransition = true
    }
    const rangeParam = get('range')
    if (rangeParam === 'today' || rangeParam === 'week' || rangeParam === 'date') {
      setRange(rangeParam)
      pageResetRef.current.restoreTransition = true
    }
    const dateParam = get('date')
    if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      setCalendarAnchor(dateParam)
      pageResetRef.current.restoreTransition = true
    }
    const queryParam = get('q')
    if (queryParam) {
      setQuery(queryParam)
      pageResetRef.current.restoreTransition = true
    }
    const menuParam = get('menu')
    if (menuParam) {
      setMenuFilter(menuParam)
      pageResetRef.current.restoreTransition = true
    }
    const staffParam = get('staff')
    if (staffParam) {
      setStaffFilter(staffParam)
      pageResetRef.current.restoreTransition = true
    }
    const sourceParam = get('source')
    if (sourceParam && SOURCE_FILTERS.some((item) => item.key === sourceParam)) {
      setSourceFilter(sourceParam)
      pageResetRef.current.restoreTransition = true
    }
    const pageParam = get('page')
    const pageNumber = pageParam ? Number.parseInt(pageParam, 10) : NaN
    if (Number.isFinite(pageNumber) && pageNumber >= 1) {
      setPage(Math.floor(pageNumber))
      pageResetRef.current.restoreTransition = true
    }
    // V8 C①：詳細パネルの行（?booking=<id>）もURLから戻す。パネル用の
    // 合図が自分で読むので、ここでは渡すだけで開く行の正しさは変えない。
    const bookingParam = urlParams.get('booking')
    if (bookingParam) {
      setActiveBookingId(bookingParam)
    }
    setLedgerRestored(true)
  }, [urlParams])
  const [menuFilter, setMenuFilter] = useState<string>('all')
  // N-398: 担当者・予約経路の絞り込み。一覧の取得とCSV書出しの両方に渡す。
  const [staffFilter, setStaffFilter] = useState<string>('all')
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [staffList, setStaffList] = useState<BookingStaff[]>([])
  const [staffBreaks, setStaffBreaks] = useState<Record<string, Array<{ weekday: number; start_time: string; end_time: string }>>>({})
  /* 盤の「担当者」の絞り込み。一覧の絞り込み（staffFilter）とは別に、盤の列だけを絞る。 */
  const [boardStaff, setBoardStaff] = useState('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<BookingRequest[]>([])
  const [total, setTotal] = useState(0)
  const [calendarItems, setCalendarItems] = useState<BookingRequest[]>([])
  const [calendarLoad, setCalendarLoad] = useState<{ key: string; status: 'loading' | 'ready' | 'error'; error?: unknown }>({ key: '', status: 'loading' })
  /*
   * BOOKING-01: カレンダーが実際に表示している日・週の基点。以前は内部で
   * 持ち、取得範囲は常に「今日起点」だったため、翌週へ進んでも予約が
   * 読まれず全マスが空きに見えた。表示範囲と取得範囲を一致させる。
   */
  const [calendarAnchor, setCalendarAnchor] = useState(() => jstDay(new Date().toISOString()))
  const monthOffset = monthDifference(calendarAnchor)
  const setMonthOffset = (next: number | ((previous: number) => number)) => setCalendarAnchor(`${monthKey(typeof next === 'function' ? next(monthOffset) : next)}-01`)
  const calendarFrom = view === 'week' ? startOfWeek(calendarAnchor) : calendarAnchor
  const calendarTo = view === 'week' ? moveDay(calendarFrom, 6) : calendarAnchor
  /*
   * BOOKING-01: 空き枠の実績。カレンダーのマス数から空きを推測しない。
   * - unconfigured: 担当0またはメニュー0。受付可能時間0として「—」を出す。
   * - error: 設定・空き枠の読み込みに失敗。0枠・0%とは区別する。
   * - loading / ready: 読み込み中 / 実績あり。
   */
  const [candidatesStatus, setCandidatesStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [availability, setAvailability] = useState<CalendarAvailability>({ status: 'loading', slots: [] })
  const [summary, setSummary] = useState<{
    total: number; requested: number; monthTotal: number; monthConfirmed: number;
    monthCancelled: number; lastMonthTotal: number; todayTotal: number; weekTotal: number;
    todayTabTotal?: number; weekTabTotal?: number; monthTabTotal?: number;
    byMenu: Array<{ name: string; total: number }>;
  }>({
    total: 0, requested: 0, monthTotal: 0, monthConfirmed: 0,
    monthCancelled: 0, lastMonthTotal: 0, todayTotal: 0, weekTotal: 0,
    byMenu: [],
  })
  const [menus, setMenus] = useState<BookingMenu[]>([])
  // 集計の読み込み失敗は0表示と分ける。黙って0のままだと運用者が気づけない。
  const [summaryError, setSummaryError] = useState(false)
  // ★管理画面 `x63W5x`：集計が取れていない間、KPI に 0 を出さない。「—」と出す。
  const [summaryReady, setSummaryReady] = useState(false)
  const [summarySeq, setSummarySeq] = useState(0)
  // R89: 承認・取消の後にカレンダーの表示範囲の予約も読み直す合図。
  const [calendarSeq, setCalendarSeq] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** m23m: 捕まえた読み込み失敗。403・429の1枚へ渡すためだけに持つ。 */
  const [loadError, setLoadError] = useState<unknown>(null)
  // copied 状態は URL 単位で持つ。アカウント切替で shareUrl が変わると
  // 自動で「コピー済」が消えるので、A の URL をコピーしたまま B 画面で
  // 「B フォームと思い込んで送信」する事故を防ぐ。
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  // コピー済み表示を消すタイマー。外したままにすると警告の元になる(点検#516軽6)。
  const copyTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
  }, [])
  const [decideTarget, setDecideTargetState] = useState<DecisionTarget | null>(null)
  const decisionScope = useRef({ accountId: selectedAccountId })
  if (decisionScope.current.accountId !== selectedAccountId) decisionScope.current = { accountId: selectedAccountId }
  const decisionRef = useRef<{ target: DecisionTarget; scope: typeof decisionScope.current } | null>(null)
  const setDecideTarget = (target: DecisionTarget | null) => {
    decisionRef.current = target ? { target, scope: decisionScope.current } : null
    setDecideTargetState(target)
  }
  useEffect(() => () => { decisionRef.current = null }, [])
  const [deciding, setDeciding] = useState(false)
  const [decideError, setDecideError] = useState('')
  /* 台帳CSVの書出し中。失敗は一覧の error 帯へ出す（TECH-03）。 */
  const [csvBusy, setCsvBusy] = useState(false)
  /*
   * 一覧取得の応答が「どのアカウント・どの条件へ向けたものか」を照合する。
   * アカウントを切り替えたあとに遅れて届いた前のアカウントの応答で、
   * いま見ている一覧を上書きしない(#963)。
   */
  const listRequestRef = useRef(0)
  const listAccountRef = useRef<string | null>(selectedAccountId)
  listAccountRef.current = selectedAccountId
  // N-401: 閲覧のみの人には操作ボタンを見せない。読み込めるまでは隠す
  // （権限のある人に一瞬見せて消すより、静かに出すほうが誤操作を防ぐ）。
  const canOperate = usePermissionAccess('/booking/bookings')

  // 詳細パネルは行の実体ではなく id を保持する。承認などで再読み込みしたあとも
  // 最新の行を引き直せるので、パネルに古い状態が残らない。
  const [detailId, setDetailId] = useState<string | null>(null)
  /*
   * V8「サクサク感」C①：一覧（表）の行の詳細パネル。URL に ?booking=<id> を残す。
   * 行を押すとつながる移り変わり（E）で右から出て、↑↓で前・次へ。
   * 互換経路は今のまま（引き出し・小窓）で、1画素も変えない。
   */
  const [activeBookingId, setActiveBookingId] = useDetailPanelUrl('booking')
  /* 返金はオーナー・管理者だけ（B1：スタッフは請求・請求しないまで）。 */
  const canRefundCharges = canManageRole(useStaffRole())
  const openBookingDetail = (id: string) => withViewTransition(() => setActiveBookingId(id))
  const closeBookingDetail = () => setActiveBookingId(null)

  const liffId = selectedAccount?.liffId ?? null
  // Worker `/o` は ref 解決・追跡なしで liffId を直接受けるラップ URL。
  // `liff.line.me` を直貼りすると OpenChat / IG DM 等で削除されるため、
  // LINE 内配信も SNS 配信もこの 1 本で完結させる。/o は LINE 内 UA でも
  // 「LINEで開く」ボタン経由で Universal Link → LIFF を起動する。
  const workerBase = process.env.NEXT_PUBLIC_API_URL ?? ''
  const shareUrl =
    workerBase && liffId
      ? `${workerBase}/o?liffId=${encodeURIComponent(liffId)}&page=salon-book`
      : null
  // N-396: お客さま自身の予約履歴を開くURL。LIFF側は page=salon-book&view=history で
  // 履歴画面を開く。/o は view を salon-book の history だけ通す。
  const historyUrl =
    workerBase && liffId
      ? `${workerBase}/o?liffId=${encodeURIComponent(liffId)}&page=salon-book&view=history`
      : null
  const isCopied = (url: string | null) => url !== null && copiedUrl === url
  /** コピーできなかったURL。隣の欄を選んでもらう一言を出す（ブラウザの入力窓は使わない。V6R-S3-f）。 */
  const [copyFailedUrl, setCopyFailedUrl] = useState<string | null>(null)

  async function copyUrl(url: string | null) {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopiedUrl(url)
      setCopyFailedUrl(null)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => {
        setCopiedUrl((cur) => (cur === url ? null : cur))
      }, 2000)
    } catch {
      // URL は押したボタンの隣の読取専用欄に出ている。窓は出さず、選んでコピーしてもらう。
      setCopyFailedUrl(url)
    }
  }

  // 一覧とCSVで同じ期間になるよう、from/to の計算は1か所にする (N-397)。
  // R90: 「今月」の表示では今月の初め〜来月の初めを条件へ入れる。
  // 「今日」「今週」と重なったら狭い方へ寄せる（ISO8601は辞書式で比べられる）。
  const rangeFilterParams = useCallback((): { from?: string; to?: string } => {
    let from: string | undefined
    let to: string | undefined
    if (view === 'month') {
      from = new Date(`${monthKey(monthOffset)}-01T00:00:00+09:00`).toISOString()
      to = new Date(`${monthKey(monthOffset + 1)}-01T00:00:00+09:00`).toISOString()
    }
    if (range === 'date') {
      from = new Date(`${calendarAnchor}T00:00:00+09:00`).toISOString()
      to = new Date(`${moveDay(calendarAnchor, 1)}T00:00:00+09:00`).toISOString()
    } else if (range !== 'all') {
      const today = jstDay(new Date().toISOString())
      const weekTo = jstDay(new Date(Date.now() + 7 * 86_400_000).toISOString())
      const rangeFrom = new Date(`${today}T00:00:00+09:00`).toISOString()
      const rangeTo = range === 'today'
        ? new Date(`${jstDay(new Date(Date.now() + 86_400_000).toISOString())}T00:00:00+09:00`).toISOString()
        : new Date(`${weekTo}T00:00:00+09:00`).toISOString()
      from = from && from > rangeFrom ? from : rangeFrom
      to = to && to < rangeTo ? to : rangeTo
    }
    return { ...(from ? { from } : {}), ...(to ? { to } : {}) }
  }, [range, view, monthOffset, calendarAnchor])

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    // 要求が向かったアカウントを固定する(#963)。応答時に現在値と照合し、
    // 別アカウントへ切り替わったあとの遅い応答は一覧へ反映しない。
    const requestedAccountId = selectedAccountId
    const requestId = ++listRequestRef.current
    setLoading(true)
    setError(null)
    setLoadError(null)
    // タブ/アカウント切り替えで先に list をクリア。fetch 失敗時に前タブの行が
    // 残ってしまい、誤って別ステータスの予約を操作してしまう事故を防ぐ。
    setItems([])
    try {
      const r = await bookingApi.listRequests(requestedAccountId, tab, {
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        query: query.trim() || undefined,
        menuName: menuFilter === 'all' ? undefined : menuFilter,
        staffId: staffFilter === 'all' ? undefined : staffFilter,
        // 予約元は今読んでいる予約へ画面側で当てる（LINE・電話・その他の3つにまとめる）。
        ...rangeFilterParams(),
      })
      if (requestId !== listRequestRef.current || listAccountRef.current !== requestedAccountId) return
      setItems(r.requests)
      setTotal(r.total)
    } catch (e) {
      if (requestId !== listRequestRef.current || listAccountRef.current !== requestedAccountId) return
      setLoadError(e)
      setError(describeApiFailure(e, '予約の読み込み'))
    } finally {
      if (requestId === listRequestRef.current && listAccountRef.current === requestedAccountId) setLoading(false)
    }
  }, [menuFilter, page, query, rangeFilterParams, selectedAccountId, sourceFilter, staffFilter, tab])

  useEffect(() => {
    load()
    // 条件が変わった時点で走っている要求を無効化し、遅い応答が
    // 新しい条件の一覧へ紛れ込まないようにする(#963)。
    return () => {
      listRequestRef.current += 1
    }
  }, [load])

  /*
   * アカウントを切り替えたら、前のアカウントの行・詳細・候補を残さない(#963)。
   * 詳細パネルは id だけを持つので、一覧が入れ替わる間に前のアカウントの
   * 行を引いて別アカウントの画面へ出さない。候補(メニュー棚・担当)も
   * 取り直しが届くまで前のアカウントの選択肢を見せない。
   */
  useEffect(() => {
    setItems([])
    setTotal(0)
    setCalendarItems([])
    setDetailId(null)
    // 確定操作の確認窓・失敗表示も前のアカウントのものは残さない。
    // 残すと、別アカウントの予約へ向けた操作を新しいアカウントで
    // 確定してしまう(#963)。
    setDecideTarget(null)
    setDecideError('')
    setError(null)
    setMenus([])
    setStaffList([])
    setCopiedUrl(null)
    setCandidatesStatus('loading')
    setAvailability({ status: 'loading', slots: [] })
    setSummaryError(false)
    setSummaryReady(false)
    setSummary({
      total: 0, requested: 0, monthTotal: 0, monthConfirmed: 0,
      monthCancelled: 0, lastMonthTotal: 0, todayTotal: 0, weekTotal: 0,
      byMenu: [],
    })
  }, [selectedAccountId])

  /*
   * N-397: 今見えている絞り込みのまま台帳CSVを出す。上限・範囲の断りは
   * CSV先頭の注記行にサーバが書く。
   * TECH-03: 直リンクは Cookie が届かない経路で取れないため、
   * 認証付きの取得からファイル保存へ揃える。
   */
  const downloadLedgerCsv = () => {
    if (!selectedAccountId || csvBusy) return
    setCsvBusy(true)
    void bookingApi.downloadLedgerCsv(selectedAccountId, {
      status: tab,
      query: query.trim() || undefined,
      menuName: menuFilter === 'all' ? undefined : menuFilter,
      staffId: staffFilter === 'all' ? undefined : staffFilter,
      source: sourceFilter === 'line' ? 'liff' : sourceFilter === 'phone' ? 'phone' : undefined,
      ...rangeFilterParams(),
    })
      .catch(() => setError('CSVを書き出せませんでした。通信を確認して、もう一度お試しください。'))
      .finally(() => setCsvBusy(false))
  }

  // KPIとメニュー棚は集計口から読む。一覧全件をブラウザへ運ばない。
  useEffect(() => {
    if (!selectedAccountId) return
    // 要求が向かったアカウントを固定する(#963)。集計・メニュー棚・担当の
    // 候補も、切替後に届いた前のアカウントの応答では更新しない。
    const requestedAccountId = selectedAccountId
    let alive = true
    setSummaryError(false)
    setSummaryReady(false)
    setCandidatesStatus('loading')
    void (async () => {
      try {
        const today = jstDay(new Date().toISOString())
        const [counts, menuList, staffResult] = await Promise.all([
          bookingApi.requestsSummary(requestedAccountId, {
            month: monthKey(0), lastMonth: monthKey(-1), today,
            weekTo: jstDay(new Date(Date.now() + 6 * 86_400_000).toISOString()),
          }),
          bookingApi.listMenus(requestedAccountId),
          bookingApi.listStaff(requestedAccountId),
        ])
        if (!alive || listAccountRef.current !== requestedAccountId) return
        setSummary(counts)
        setSummaryReady(true)
        setMenus(menuList.menus)
        setStaffList(staffResult.staff.filter((item) => item.is_active === 1))
        setCandidatesStatus('ready')
      } catch {
        // KPI が出ないだけで一覧は使える。ここで画面全体を止めない。
        // ただし0のまま黙ると気づけないので、KPI欄の上に理由と再試行を出す。
        // BOOKING-01: メニュー・担当の候補も同じ失敗なので、カレンダー側へ
        // 「未取得」と伝える（未設定と取り違えて0枠扱いにしない）。
        if (alive && listAccountRef.current === requestedAccountId) {
          setSummaryError(true)
          setCandidatesStatus('error')
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [selectedAccountId, summarySeq])

  const calendarKey = [selectedAccountId, view, calendarFrom, calendarTo, calendarSeq].join('|')
  const calendarStatus = calendarLoad.key === calendarKey ? calendarLoad.status : 'loading'

  // カレンダーは表示中の日/週の範囲だけをページごとに読み、100件を越えても
  // 欠落させない。BOOKING-01: 取得範囲はカレンダーの表示範囲（anchor）と
  // 一致させる。前へ・次へで動いた週の予約も読み直し、読んでいない週を
  // 「全部空き」のように見せない。
  useEffect(() => {
    if (!selectedAccountId || (view !== 'day' && view !== 'week')) return
    // 要求が向かったアカウントを固定する(#963)。ページをまたぐ取得の途中で
    // 切り替わっても、前のアカウントの行を集め続けない。
    const requestedAccountId = selectedAccountId
    let alive = true
    setCalendarLoad({ key: calendarKey, status: 'loading' })
    setCalendarItems([])
    void (async () => {
      const range = {
        from: new Date(`${calendarFrom}T00:00:00+09:00`).toISOString(),
        to: new Date(`${moveDay(calendarTo, 1)}T00:00:00+09:00`).toISOString(),
      }
      // 2ページ目以降は同時に取る（V6R-S3-c）。途中でアカウントが替わったら集めない（#963）。
      const collected = await fetchAllPages(
        (offset) => bookingApi.listRequests(requestedAccountId, 'all', { limit: 100, offset, ...range }),
        100,
        () => alive && listAccountRef.current === requestedAccountId,
      )
      if (collected === null) return
      if (alive && listAccountRef.current === requestedAccountId) {
        setCalendarItems(collected)
        setCalendarLoad({ key: calendarKey, status: 'ready' })
      }
    })().catch((error: unknown) => {
      if (alive && listAccountRef.current === requestedAccountId) setCalendarLoad({ key: calendarKey, status: 'error', error })
    })
    return () => { alive = false }
  }, [selectedAccountId, view, calendarFrom, calendarTo, calendarSeq, calendarKey])

  /*
   * BOOKING-01: 空き枠の実績を空き枠APIから取る。受付可能な時間は
   * 営業時間・担当シフト・例外日・外部予定・既存予約・同時受付数を
   * サーバー側で考慮した結果なので、カレンダーのマス数から推測しない。
   * メニューごとに取って、全メニューの枠をマージする。
   */
  useEffect(() => {
    if (!selectedAccountId || (view !== 'day' && view !== 'week')) return
    if (candidatesStatus === 'loading') {
      setAvailability({ status: 'loading', slots: [] })
      return
    }
    if (candidatesStatus === 'error') {
      setAvailability({ status: 'error', slots: [] })
      return
    }
    const activeMenus = menus.filter((item) => item.is_active === 1)
    if (activeMenus.length === 0 || staffList.length === 0) {
      setAvailability({ status: 'unconfigured', slots: [] })
      return
    }
    const requestedAccountId = selectedAccountId
    let alive = true
    // 読み直し中は前の範囲の枠を残さない。別の週の枠が新しい週の
    // 空きとして一瞬でも出ると、取れない入口を踏ませる。
    setAvailability({ status: 'loading', slots: [] })
    void (async () => {
      try {
        /*
         * #1060: メニュー分の往復を1要求の一括口へまとめる。
         * 一括口をまだ持たない Worker では 400/404 で落ちるので、
         * そのときだけ従来のメニューごと取得へ退く（段階配備の互換）。
         */
        const slots: CalendarSlot[] = []
        try {
          const batch = await bookingApi.getAvailabilityBatch(requestedAccountId, {
            menuIds: activeMenus.map((menu) => menu.id),
            from: calendarFrom,
            to: calendarTo,
          })
          if (!alive || listAccountRef.current !== requestedAccountId) return
          for (const perMenu of batch.by_menu) {
            for (const perStaff of perMenu.by_staff) {
              for (const slot of perStaff.slots) {
                slots.push({ staffId: perStaff.staff_id, staffName: perStaff.display_name, menuId: perMenu.menu_id, ...slot })
              }
            }
          }
        } catch (cause) {
          if (!(cause instanceof ApiError) || ![400, 404].includes(cause.status)) throw cause
          const responses = await Promise.all(
            activeMenus.map((menu) =>
              bookingApi.getAvailability(requestedAccountId, {
                menuId: menu.id,
                from: calendarFrom,
                to: calendarTo,
              }),
            ),
          )
          if (!alive || listAccountRef.current !== requestedAccountId) return
          responses.forEach((response, index) => {
            for (const perStaff of response.by_staff) {
              for (const slot of perStaff.slots) {
                slots.push({ staffId: perStaff.staff_id, staffName: perStaff.display_name, menuId: activeMenus[index].id, ...slot })
              }
            }
          })
        }
        setAvailability({ status: 'ready', slots })
      } catch {
        if (alive && listAccountRef.current === requestedAccountId) {
          setAvailability({ status: 'error', slots: [] })
        }
      }
    })()
    return () => { alive = false }
  }, [selectedAccountId, view, calendarFrom, calendarTo, candidatesStatus, menus, staffList])
  // 人（スタッフ）ごとの毎週の休憩。1日表示の盤に「休憩」の枠として出す。読めなければ空き枠の失敗として示す。
  useEffect(() => {
    if (!selectedAccountId || view !== 'day' || staffList.length === 0) return
    let alive = true
    void Promise.all(staffList.map(staff => Promise.resolve().then(() => bookingApi.getBreaks(selectedAccountId, staff.id)).then(res => [staff.id, res.breaks] as const))).then(pairs => {
      if (alive) setStaffBreaks(Object.fromEntries(pairs))
    }, () => { if (alive) setAvailability({ status: 'error', slots: [] }) })
    return () => { alive = false }
  }, [selectedAccountId, view, staffList])

  type BookingAction = 'approve' | 'reject' | 'cancel' | 'no_show' | 'complete'

  /**
   * 予約の状態を変える。**押す前に確認を出す。**
   *
   * ブラウザの `confirm` / `alert` は見た目がブラウザ任せで、設計の
   * 確認窓と違ううえ、**画像比較に写らない**（確認と失敗の絵をそもそも
   * 撮れない）。失敗は窓の中に出して、押した場所から動かさない。
   */
  async function runDecide(id: string, action: BookingAction) {
    if (!selectedAccountId) return
    // 操作が向かったアカウントを固定する(#963)。応答を待つ間に
    // 切り替わっていても、新しいアカウントの確認窓・失敗表示を触らない。
    const decideAccountId = selectedAccountId
    const requestScope = decisionScope.current
    const requestTarget = decisionRef.current
    setDeciding(true)
    setDecideError('')
    try {
      await bookingApi.decideRequest(decideAccountId, id, action)
      /*
       * 再読み込みも同じアカウントのときだけ(#979 A27-03)。`load` は
       * 操作開始時のアカウントを掴んだ古い実体なので、切替後に呼ぶと
       * 新しいアカウントの一覧を空にしたまま読み込み状態が残る。
       * 切替済みなら、切替の効果が新しいアカウントの取得を始めている。
       */
      if (listAccountRef.current === decideAccountId && decisionScope.current === requestScope) {
        if (decisionRef.current === requestTarget) setDecideTarget(null)
        await load()
        // R89: 一覧だけでなく集計・カレンダー・空き枠も読み直す。
        // 集計の取り直しが届くと空き枠の取得も連動して走り直す。
        setSummarySeq((n) => n + 1)
        setCalendarSeq((n) => n + 1)
      }
    } catch (e) {
      if (listAccountRef.current === decideAccountId && decisionScope.current === requestScope && decisionRef.current === requestTarget) {
        setDecideError(describeApiFailure(e, '予約の状態変更'))
      }
    } finally {
      setDeciding(false)
    }
  }

  function handleDecide(id: string, action: BookingAction) {
    if (!selectedAccountId || listAccountRef.current !== selectedAccountId) return
    setDecideError('')
    setDecideTarget({ id, action, accountId: selectedAccountId })
  }

  function confirmDecide(target: DecisionTarget | null) {
    const current = decisionRef.current
    if (!target || !current || current.target !== target || current.scope !== decisionScope.current) return
    void runDecide(target.id, target.action)
  }
  function cancelDecide(target: DecisionTarget | null) {
    if (decisionRef.current?.target !== target) return
    setDecideTarget(null)
    setDecideError('')
  }

  const kpi = {
    total: summary.monthTotal,
    diff: summary.monthTotal - summary.lastMonthTotal,
    confirmed: summary.monthConfirmed,
    cancelled: summary.monthCancelled,
    rate: summary.monthTotal > 0 ? Math.round((summary.monthCancelled / summary.monthTotal) * 100) : null,
  }
  const menuCounts = new Map(summary.byMenu.map((item) => [item.name, item.total]))
  // 予約元はサーバの総数ではなく、いま読んでいる予約に当てる。件数もその範囲で数える。
  const sourceScoped = sourceFilter !== 'all'
  const shown = sourceScoped ? items.filter((row) => matchesLedgerSource(row, sourceFilter)) : items
  const visibleCalendarItems = sourceScoped ? calendarItems.filter((row) => matchesLedgerSource(row, sourceFilter)) : calendarItems
  const visibleTotal = sourceScoped ? shown.length : total
  const pageCount = Math.max(1, Math.ceil(visibleTotal / PAGE_SIZE))
  const current = sourceScoped ? 1 : Math.min(page, pageCount)

  /*
   * 「まだ予約が無い」と「絞り込みで0件」は言い分ける（#635）。
   * summary.total はアカウントの予約総数なので、0 なら条件以前に
   * 予約そのものが無い。集計が取れていないときは安全側に「条件に合う」へ倒す。
   * 状態タブは初期値が「未承認」なので、空の言い分けには使わず、
   * 「絞り込みを解除」の要否だけに使う（既定タブのまま解除を出しても
   * 全件へ戻す動線として意味を持つ）。
   */
  const nonTabNarrowing =
    query.trim() !== '' ||
    menuFilter !== 'all' ||
    staffFilter !== 'all' ||
    sourceFilter !== 'all' ||
    range !== 'all'
  const hasAnyBooking = summaryError || summary.total > 0
  const showFilteredEmpty = hasAnyBooking || nonTabNarrowing
  const clearListFilters = () => {
    setQuery('')
    setMenuFilter('all')
    setStaffFilter('all')
    setSourceFilter('all')
    setRange('all')
    setTab('all')
  }

  /*
   * 絞り込みが変わったら1ページ目に戻す。3ページ目のまま条件を狭めると
   * 「該当なし」に見えてしまう。R90: 表示の切り替え（今月など）も条件。
   * R317: 初回の描画と、URL・保存からの復元では戻さない。戻すと
   * 戻したページが消えて、再読み込みの意味がなくなる。
   */
  useEffect(() => {
    if (!pageResetRef.current.seenMount) {
      pageResetRef.current.seenMount = true
      return
    }
    if (pageResetRef.current.restoreTransition) {
      pageResetRef.current.restoreTransition = false
      return
    }
    setPage(1)
  }, [tab, menuFilter, query, range, staffFilter, sourceFilter, view, monthOffset])

  /*
   * R317: 表示方法・対象日・絞り込み・ページをURLへ写す。再読み込みで
   * 同じ状態へ戻れる。履歴は汚さない（replace）。同じタブ内の保存にも
   * 残し、条件を持たないパンくずから戻ったときも復元する。
   * 明示の解除（絞り込みを解除）は既定値へ戻り、URLも既定へ戻る。
   */
  const ledgerQuery = [
    `view=${view}`,
    `status=${tab}`,
    ...(range === 'all' ? [] : [`range=${range}`]),
    `date=${calendarAnchor}`,
    ...(query.trim() ? [`q=${encodeURIComponent(query.trim())}`] : []),
    ...(menuFilter === 'all' ? [] : [`menu=${encodeURIComponent(menuFilter)}`]),
    ...(staffFilter === 'all' ? [] : [`staff=${encodeURIComponent(staffFilter)}`]),
    ...(sourceFilter === 'all' ? [] : [`source=${sourceFilter}`]),
    ...(page <= 1 ? [] : [`page=${page}`]),
    // V8 C①：開いている詳細パネルの行を残す。無いとURLの写しが ?booking= を消す。
    ...(activeBookingId ? [`booking=${encodeURIComponent(activeBookingId)}`] : []),
    // 「繰り返して入れる」の引き出し（B4）：開いている間の指定も残す。
    ...SERIES_QUERY_KEYS.flatMap((key) => (urlParams.get(key) ? [`${key}=${encodeURIComponent(urlParams.get(key) ?? '')}`] : [])),
  ].join('&')
  useEffect(() => {
    if (!urlInitRef.current || !ledgerRestored) return
    try {
      window.sessionStorage.setItem(
        LEDGER_STORAGE_KEY,
        JSON.stringify({
          view, status: tab, range, date: calendarAnchor, q: query,
          menu: menuFilter, staff: staffFilter, source: sourceFilter, page: String(page),
        }),
      )
    } catch {
      // 保存に失敗しても一覧は使える。URLへの写しは続ける。
    }
    const current = window.location.search.replace(/^\?/, '')
    if (current !== ledgerQuery) {
      router.replace(ledgerQuery ? `/booking/bookings?${ledgerQuery}` : '/booking/bookings')
    }
  }, [ledgerQuery, ledgerRestored, router])

  // タブ切替やアカウント切替で items が入れ替わったとき、開いていた予約が
  // 一覧から消えることがある。その場合はパネルを閉じる。
  const detail = detailId
    ? (calendarItems.find((b) => b.id === detailId) ?? items.find((b) => b.id === detailId) ?? null)
    : null
  useEffect(() => {
    if (detailId && !calendarItems.some((b) => b.id === detailId) && !items.some((b) => b.id === detailId)) {
      setDetailId(null)
    }
  }, [calendarItems, items, detailId])

  /*
   * V8「サクサク感」C①：表の行に出す予約（一覧全体から探すので、URL直打ちでも開く）。
   * 前・次は今のページの行の中。名前のその場書き換え（C②）は付けない。
   * 予約の1項目だけを直す口は無く、状態の変更は確認の窓・備考や時間の変更は
   * 詳細ページで行うため、無い口は作らず詳細ページへ送る。
   */
  const activeBooking = activeBookingId ? (items.find((b) => b.id === activeBookingId) ?? null) : null
  const activeBookingIndex = activeBookingId ? shown.findIndex((b) => b.id === activeBookingId) : -1

  /*
   * V8「サクサク感」C③：右クリックのメニュー。操作列のボタンと同じ操作
   * （詳細を開く・会話を開く・状態の変更）。状態の変更は確認の窓を通す。
   * 閲覧のみの人には状態を変える操作を出さない（操作列と同じ）。
   */
  const bookingContextItems = (b: BookingRequest): ContextMenuItem[] => {
    const list: ContextMenuItem[] = [
      { id: 'open', label: '詳細を開く', onSelect: () => openBookingDetail(b.id) },
    ]
    if (b.friend_id) {
      list.push({
        id: 'chat',
        label: '会話を開く',
        onSelect: () => router.push(`/chats?friend=${b.friend_id}`),
      })
    }
    if (canOperate) {
      if (b.status === 'requested') {
        list.push(
          { id: 'approve', label: '承認する', onSelect: () => handleDecide(b.id, 'approve') },
          { id: 'reject', label: '拒否する', danger: true, onSelect: () => handleDecide(b.id, 'reject') },
        )
      } else if (b.status === 'confirmed') {
        list.push(
          { id: 'complete', label: '来ていただきました にする', onSelect: () => handleDecide(b.id, 'complete') },
          { id: 'no_show', label: '無断キャンセルにする', danger: true, onSelect: () => handleDecide(b.id, 'no_show') },
          { id: 'cancel', label: '予約を取り消す', danger: true, onSelect: () => handleDecide(b.id, 'cancel') },
        )
      }
    }
    return list
  }

  // タブの数はその期間の有効な予約だけ（取消・拒否・期限切れを除く）。
  // 旧Worker（タブ用未返却）では従来の集計に倒す。
  const visitChanged = useCallback(() => {
    setCalendarSeq(value => value + 1)
    setSummarySeq(value => value + 1)
    void load()
  }, [load])
  const visits = usePeopleVisitMarks(selectedAccountId, calendarFrom, view === 'day' && canOperate, visitChanged)

  const todayCount = summary.todayTabTotal ?? summary.todayTotal
  const weekCount = summary.weekTabTotal ?? summary.weekTotal
  const monthCount = summary.monthTabTotal ?? kpi.total
  return {
    styleProfile,
    selectedAccountId,
    selectedAccount,
    urlParams,
    view,
    setView,
    tab,
    setTab,
    range,
    setRange,
    menuFilter,
    setMenuFilter,
    staffFilter,
    setStaffFilter,
    sourceFilter,
    setSourceFilter,
    staffList,
    staffBreaks,
    boardStaff,
    setBoardStaff,
    query,
    setQuery,
    page,
    setPage,
    items,
    shown,
    total: visibleTotal,
    calendarItems: visibleCalendarItems,
    calendarLoad,
    calendarAnchor,
    setCalendarAnchor,
    monthOffset,
    setMonthOffset,
    calendarFrom,
    calendarTo,
    availability,
    summary,
    menus,
    summaryError,
    summaryReady,
    setSummarySeq,
    setCalendarSeq,
    loading,
    error,
    setError,
    loadError,
    decideTarget,
    setDecideTarget,
    deciding,
    decideError,
    setDecideError,
    csvBusy,
    canOperate,
    setDetailId,
    setActiveBookingId,
    canRefundCharges,
    openBookingDetail,
    closeBookingDetail,
    workerBase,
    shareUrl,
    historyUrl,
    isCopied,
    copyFailedUrl,
    copyUrl,
    load,
    downloadLedgerCsv,
    calendarStatus,
    runDecide,
    handleDecide,
    confirmDecide,
    cancelDecide,
    kpi,
    menuCounts,
    pageCount,
    current,
    nonTabNarrowing,
    showFilteredEmpty,
    clearListFilters,
    detail,
    activeBooking,
    activeBookingIndex,
    bookingContextItems,
    visits,
    todayCount,
    weekCount,
    monthCount,
  }
}

export type BookingLedgerModel = ReturnType<typeof useBookingLedger>
