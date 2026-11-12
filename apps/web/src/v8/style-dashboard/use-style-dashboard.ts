'use client'
import { invalidateApiReads } from '@/lib/api/transport/read-cache'
import { ApiError } from '@/lib/api/transport/errors'
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import { type CancelReservationInput } from '@/components/shared/booking-confirm-dialogs'
import { usePreparingDialog } from '@/components/shared/preparing-dialog'
import { notifyToast } from '@/components/shared/toast'
import { usePageCrumbs,usePageTitle } from '@/components/shell/page-chrome'
import { useAccount } from '@/contexts/account-context'
import { bookingApi,eventsApi } from '@/lib/api'
import { reservationBoardApi } from '@/lib/api/helpers/reservation-board'
import { styleApi } from '@/lib/api/helpers/styles'
import { formatDate, formatNumber } from '@/lib/format'
import { restaurantTestApi } from '@/lib/restaurant-test-api'
import { useStaffRole } from '@/lib/staff-role'
import type { RestaurantClosureKind,RestaurantFloor,StyleCard,StyleSnapshot } from '@line-crm/shared'
import { usePathname,useRouter,useSearchParams } from 'next/navigation'
import { useCallback,useEffect,useMemo,useRef,useState,type SetStateAction } from 'react'
import { canWriteRole } from '@/v8/restaurant/dashboard/public/summarize/index'
import { useStoreToday } from '@/v8/restaurant/dashboard/public/use-store-today/index'
import { analyticsWindow,toAnalytics,toLayout,toToday } from './adapter'
import { STYLE_CONFIG,rangeFromParam,tabFromParam,viewFromParam } from './config'
import { jstToday } from './date-range'
import { attendanceTargets, lessonRosterMembers, loadLessonBookings } from './lesson-roster-data'
import type { IndustryStyle,StyleAlertAction,StyleAnalytics,StyleClosureInput,StyleLayout,StyleRoster,StyleRow,StyleToday } from './model'
import { rowMenuItems } from './parts'
import { selectedKpis } from './metric-selection'
import { isLiveLessonBooking } from './lesson-roster-state'
import { restaurantAlert,restaurantToday } from './restaurant-today'
export function useStyleDashboard(style: IndustryStyle) {
  const cfg = STYLE_CONFIG[style]
  usePageTitle(cfg.title)
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = tabFromParam(params.get('tab'))
  const view = viewFromParam(style, params.get('view'))
  const range = rangeFromParam(params.get('range'))
  const subTab = params.get('sub') ?? cfg.analyticsDefault
  const days = params.get('days') ?? '30'
  const { selectedAccountId } = useAccount()
  const accountId = selectedAccountId ?? ''
  const role = useStaffRole()
  const canWrite = canWriteRole(role)
  const canWriteRef = useRef(canWrite)
  canWriteRef.current = canWrite
  const [date, setDate] = useState(jstToday)
  const [staff, setStaff] = useState('all')
  const [compare, setCompare] = useState(COMPARE[0].value)
  const [search, setSearch] = useState('')
  const scope = JSON.stringify([accountId, style, range, date, staff, compare, view])
  const currentScope = useRef(scope)
  currentScope.current = scope
  const loadSequence = useRef(0)
  const analyticsSequence = useRef(0)
  const [dataState, setDataState] = useState<{ scope: string; value: StyleToday; snapshot?: StyleSnapshot } | null>(null)
  const data = dataState?.scope === scope ? dataState.value : null
  const setData = (value: SetStateAction<StyleToday | null>) => setDataState((previous) => {
    const next = typeof value === 'function' ? value(previous?.scope === scope ? previous.value : null) : value
    return next ? { scope, value: next, snapshot: previous?.scope === scope ? previous.snapshot : undefined } : null
  })
  const [failed, setFailed] = useState(false)
  const analyticsScope = JSON.stringify([scope, tab, days, subTab])
  const currentAnalyticsScope = useRef(analyticsScope)
  currentAnalyticsScope.current = analyticsScope
  const [analyticsState, setAnalyticsState] = useState<{ scope: string; value: StyleAnalytics } | null>(null)
  const analytics = analyticsState?.scope === analyticsScope ? analyticsState.value : null
  const setAnalytics = (value: SetStateAction<StyleAnalytics | null>) => setAnalyticsState((previous) => {
    const next = typeof value === 'function' ? value(previous?.scope === analyticsScope ? previous.value : null) : value
    return next ? { scope: analyticsScope, value: next } : null
  })
  const [analyticsFailed, setAnalyticsFailed] = useState(false)
  const layoutScope = JSON.stringify([accountId, style])
  const [layoutState, setLayoutState] = useState<{ scope: string; value: StyleLayout } | null>(null)
  const layout = layoutState?.scope === layoutScope ? layoutState.value : null
  const setLayout = useCallback((value: StyleLayout | null) => setLayoutState(value ? { scope: layoutScope, value } : null), [layoutScope])
  const [viewOpen, setViewOpen] = useState(false)
  useEffect(() => { setViewOpen(false) }, [accountId, style])
  const [closureOpen, setClosureOpen] = useState(false)
  const [phoneOpen, setPhoneOpen] = useState(false)
  const [walkInOpen, setWalkInOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [rosterId, setRosterId] = useState<string | null | undefined>(undefined)
  const [asideOpen, setAsideOpen] = useState(false)
  const [floor, setFloor] = useState<RestaurantFloor | null>(null)
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)

  // 飲食だけは今の飲食の口（今日の予約・卓・知らせ）も読む。業種の口が無いときはここから組み立てる。
  const store = useStoreToday(style === 'restaurant' ? selectedAccountId : null)
  const tables = useMemo(() => (store.snapshot?.tables ?? []).filter((t) => t.store_id === store.store?.id), [store.snapshot, store.store])

  const setParam = useCallback((next: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(next)) { if (v === null) q.delete(k); else q.set(k, v) }
    router.replace(`${pathname}${q.toString() ? `?${q}` : ''}`, { scroll: false })
  }, [params, pathname, router])

  const staffId = staff === 'all' ? undefined : staff
  const compareParam = compare as 'previous' | 'last_year' | 'last_week'
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    setFailed(false)
    if (!accountId) return
    try {
      // 数は summary、盤・一覧・日週月は schedule（API-CONTRACT-4 §10）。
      const query = { style, range, date, staff_id: staffId }
      const [summary, schedule] = await Promise.all([
        styleApi.summary(accountId, { ...query, compare: compareParam }),
        styleApi.schedule(accountId, { ...query, display: view === 'calendar' ? 'calendar' : view === 'list' ? 'list' : 'board', calendar_view: range === 'month' ? 'month' : range === 'week' ? 'week' : 'day', ...(style === 'restaurant' && view === 'board' ? { axis: 'table' as const } : {}) }),
      ])
      if (sequence !== loadSequence.current || currentScope.current !== scope) return
      setDataState({ scope, value: toToday(style, summary.data, schedule.data, date, range), snapshot: summary.data }); setFailed(false)
      setLoadedAt(new Date())
    } catch {
      if (sequence !== loadSequence.current || currentScope.current !== scope) return
      setDataState(null); setLoadedAt(null); setFailed(true)
    }
  }, [accountId, style, range, date, staffId, compareParam, view, scope])
  useEffect(() => { void load(); return () => { loadSequence.current += 1 } }, [load])

  const loadAnalytics = useCallback(async () => {
    const sequence = ++analyticsSequence.current
    setAnalyticsFailed(false)
    if (!accountId || tab !== 'analytics') return
    try {
      const res = await styleApi.analytics(accountId, { style, ...analyticsWindow(date, Number(days) || 30), staff_id: staffId, compare: compareParam === 'last_week' ? 'previous' : compareParam })
      const names = Object.fromEntries((data?.staff ?? []).map((x) => [x.id, x.name]))
      if (sequence !== analyticsSequence.current || currentAnalyticsScope.current !== analyticsScope) return
      setAnalyticsState({ scope: analyticsScope, value: toAnalytics(style, res.data, subTab, names) }); setAnalyticsFailed(false)
    } catch { if (sequence === analyticsSequence.current && currentAnalyticsScope.current === analyticsScope) { setAnalyticsState(null); setAnalyticsFailed(true) } }
  }, [accountId, style, tab, days, subTab, staffId, compareParam, date, data?.staff, analyticsScope])
  useEffect(() => { void loadAnalytics(); return () => { analyticsSequence.current += 1 } }, [loadAnalytics])

  const [cardDefaults, setCardDefaults] = useState<StyleCard[] | undefined>(undefined)
  const loadedLayoutScope = useRef<string | null>(null)
  const currentLayoutScope = useRef(layoutScope)
  currentLayoutScope.current = layoutScope
  const [presentationRead, setPresentationRead] = useState(0)
  const reloadPresentation = () => { invalidateApiReads('/api/dashboard/style', accountId); loadedLayoutScope.current = null; setPresentationRead(value => value + 1) }
  const [selectionState, setSelectionState] = useState<{ scope: string; metricIds?: string[]; metricsCustomized?: boolean } | null>(null)
  const applyPresentation = (next: { cards: StyleCard[]; version: number; metricIds?: string[]; metricsCustomized?: boolean }, reset = false) => {
    if (currentLayoutScope.current !== layoutScope) return false
    loadedLayoutScope.current = layoutScope
    setLayout(toLayout(style, next.cards, next.version, reset ? next.cards : cardDefaults, next))
    setSelectionState({ scope: layoutScope, metricIds: next.metricIds, metricsCustomized: next.metricsCustomized })
    return true
  }
  useEffect(() => {
    if (!accountId || (!viewOpen && loadedLayoutScope.current === layoutScope)) return
    let active = true
    setLayout(null)
    const read = async () => {
      try {
        const r = await styleApi.get(accountId)
        if (active) {
          loadedLayoutScope.current = layoutScope
          setLayout(toLayout(style, r.data.cards, r.data.version, cardDefaults, r.data))
          setSelectionState({ scope: layoutScope, metricIds: r.data.metricIds, metricsCustomized: r.data.metricsCustomized })
        }
      } catch { if (active) { setLayout(null); setSelectionState({ scope: layoutScope }) } }
    }
    void read()
    return () => { active = false }
  }, [accountId, style, viewOpen, cardDefaults, layoutScope, setLayout, presentationRead])

  // 教室の名簿は今のイベント予約の一覧から読む（API-CONTRACT-4 §9）。
  const [roster, setRoster] = useState<StyleRoster | null>(null)
  const [rosterRevision, setRosterRevision] = useState(0)
  const rosterRow = style === 'lesson' && data ? (rosterId === undefined ? data.rows[0] : data.rows.find((r) => r.id === rosterId)) ?? null : null
  useEffect(() => {
    if (!rosterRow?.reservationId || !accountId) { setRoster(null); return }
    let active = true
    const controller = new AbortController()
    setRoster(null)
    const slotId = rosterRow.id.replace(/^class:/, '')
    void loadLessonBookings(accountId, rosterRow.reservationId, slotId, controller.signal).then((items) => {
      if (!active) return
      const live = items.filter(isLiveLessonBooking)
      setRoster({
        rowId: rosterRow.id, head: `${rosterRow.time}${rosterRow.endTime ?? ''}・${rosterRow.sub ?? ''}`, title: rosterRow.name, pay: { label: '払い方は決済をつないでから', tone: 'neutral' },
        meta: `予約 ${live.length}・待ち ${rosterRow.waiting ?? '—'}`, payLinkCount: 0, more: items.length > 7 ? `ほか ${items.length - 7}人` : '',
        members: lessonRosterMembers(items),
      })
    }).catch(() => { if (active) setRoster(null) })
    return () => { active = false; controller.abort() }
  }, [accountId, rosterRow?.id, rosterRow?.reservationId, rosterRevision]) // eslint-disable-line react-hooks/exhaustive-deps

  // 飲食の「座席表」は今の座席の図（店の 1 枚目の図）を出す。
  useEffect(() => {
    if (style !== 'restaurant' || view !== 'floor' || !accountId || !store.store) return
    let active = true
    void reservationBoardApi.floors(accountId, store.store.id).then((r) => { if (active) setFloor(Array.isArray(r.data) ? r.data[0] ?? null : null) }).catch(() => { if (active) setFloor(null) })
    return () => { active = false }
  }, [style, view, accountId, store.store])

  // 業種の口が読めないとき：飲食は今の口から組み立てる。ほかは「読み込めませんでした」。
  const fallback = useMemo(() => (style === 'restaurant' && failed ? restaurantToday(store, tables, Date.now()) : null), [style, failed, store, tables])
  // 異常の帯：飲食は今の「枠を閉じる知らせ」（媒体の知らせは必ず出す）。ほかは口に帯の中身が無いので出さない。
  const restaurantBand = useMemo(() => (style === 'restaurant' ? restaurantAlert(store) : null), [style, store])
  const metricSelectionFallback = selectionState?.scope === layoutScope && typeof selectionState.metricsCustomized !== 'boolean'
  const selected = selectionState?.scope === layoutScope && selectionState.metricsCustomized === true ? selectionState.metricIds : undefined
  const snapshot = dataState?.scope === scope ? dataState.snapshot : undefined
  const today = data ? { ...data, alert: restaurantBand, kpis: selected && snapshot ? selectedKpis(style, snapshot, range, selected) : data.kpis } : fallback
  const preparing = usePreparingDialog()
  const openPayment = () => preparing.open('お支払い')
  const reload = async () => { await Promise.all([load(), style === 'restaurant' ? store.reload() : Promise.resolve(), loadAnalytics()]) }

  const asOf = today ? formatDate(today.asOf, { style: 'time' }) : null
  const hours = today?.hoursLabel ? `営業 ${today.hoursLabel}` : null
  const subtitle = [formatDate(`${date}T00:00:00+09:00`, { style: 'day' }), hours, asOf ? `${asOf} 時点` : null].filter(Boolean).join('・')

  const bookingId = (row: StyleRow) => row.booking?.id ?? row.reservationId ?? row.id
  // 旧Meet相談は通常予約に属さない。受信箱の「次の予定」と同じ友だち詳細へ渡す。
  const detailHref = (row: StyleRow): string | null => {
    if (row.booking?.kind === 'meet') return row.booking.friendId ? `/friends/detail?id=${encodeURIComponent(row.booking.friendId)}` : null
    return style === 'salon' || style === 'consult'
      ? `/booking/bookings?booking=${encodeURIComponent(bookingId(row))}`
      : `/booking/bookings?id=${encodeURIComponent(row.id)}`
  }
  const openRow = (row: StyleRow) => {
    if (style === 'restaurant') router.push(`/restaurant-test/reservations?id=${encodeURIComponent(row.reservationId ?? row.id)}`)
    else if (style === 'lesson') setRosterId(row.id)
    else {
      const href = detailHref(row)
      if (href) router.push(href)
      else notifyToast('相談者を確認できないため詳細を開けません。読み直してから、もう一度お試しください。', { tone: 'error' })
    }
  }
  const version = (row: StyleRow) => row.booking?.version ?? store.today?.find((r) => r.id === row.reservationId)?.customer_version ?? 1
  const run = async (row: StyleRow, fn: () => Promise<unknown>, ok: string, fail: string) => {
    setBusy(row.id)
    try { await fn(); notifyToast(ok) } catch (caught) { notifyToast(japaneseDetailOf(caught) || fail, { tone: 'error' }) } finally { await reload(); setBusy('') }
  }
  const markVisit = (row: StyleRow) => {
    if (style === 'restaurant' && row.reservationId) return run(row, () => restaurantTestApi.postSeatVisitMark(accountId, row.reservationId!, { kind: 'visited', expectedVersion: version(row), requestId: crypto.randomUUID() }), '来店にしました。', '来店にできませんでした。')
    if (row.booking?.kind === 'meet' && row.booking.updatedAt) return run(row, () => styleApi.saveMeetResult(accountId, row.booking!.id, { expectedUpdatedAt: row.booking!.updatedAt!, attendance: 'visited' }), '実施にしました。', '実施にできませんでした。')
    if (row.booking) return run(row, () => bookingApi.postVisitMark(accountId, bookingId(row), { kind: 'visited' }), '来店にしました。', '来店にできませんでした。')
    openRow(row)
  }
  /** 無断・欠席の印（開始の時刻を過ぎた予約だけ。あとで戻せる）。 */
  const markNoShow = (row: StyleRow) => {
    if (!row.past) return
    if (style === 'restaurant' && row.reservationId) return run(row, () => restaurantTestApi.postSeatVisitMark(accountId, row.reservationId!, { kind: 'no_show', expectedVersion: version(row), requestId: crypto.randomUUID() }), '無断にしました。来店の印の取り消しで戻せます。', '無断にできませんでした。')
    if (row.booking?.kind === 'meet' && row.booking.updatedAt) return run(row, () => styleApi.saveMeetResult(accountId, row.booking!.id, { expectedUpdatedAt: row.booking!.updatedAt!, attendance: 'no_show' }), '欠席にしました。', '欠席にできませんでした。')
    return run(row, () => bookingApi.postVisitMark(accountId, bookingId(row), { kind: 'no_show' }), style === 'consult' ? '欠席にしました。' : '無断にしました。', '印を付けられませんでした。')
  }
  const approve = (row: StyleRow) => run(row, () => bookingApi.decideRequest(accountId, bookingId(row), 'approve'), '承認しました。お客さまに確定の LINE が届きます。', '承認できませんでした。')
  const undoVisit = (row: StyleRow) => {
    if (style !== 'restaurant' || !row.reservationId) return
    return run(row, () => restaurantTestApi.deleteSeatVisitMark(accountId, row.reservationId!, version(row), crypto.randomUUID()), '来店の印を取り消しました。', '取り消せませんでした。')
  }
  const [cancelTarget, setCancelTarget] = useState<{ row: StyleRow; generation: number } | null>(null)
  const cancelTargetRef = useRef(cancelTarget)
  if (!canWrite) cancelTargetRef.current = null
  useEffect(() => () => { cancelTargetRef.current = null }, [])
  const cancelStoreId = style === 'restaurant' ? store.store?.id ?? null : null
  const cancelScope = useRef({ accountId, style, storeId: cancelStoreId, generation: 0 })
  if (cancelScope.current.accountId !== accountId || cancelScope.current.style !== style || cancelScope.current.storeId !== cancelStoreId) {
    cancelScope.current = { accountId, style, storeId: cancelStoreId, generation: cancelScope.current.generation + 1 }
  }
  const renderedCancelScope = cancelScope.current
  const cancelRow = cancelTarget && cancelTarget === cancelTargetRef.current && cancelTarget.generation === cancelScope.current.generation ? cancelTarget.row : null
  const setCancelRow = (row: StyleRow | null) => {
    if (renderedCancelScope !== cancelScope.current) return
    if (!row && cancelTarget !== cancelTargetRef.current) return
    const target = row ? { row, generation: cancelScope.current.generation } : null
    cancelTargetRef.current = target
    setCancelTarget(target)
  }
  useEffect(() => { setBusy(value => value === 'cancel' ? '' : value) }, [accountId, style, cancelStoreId])
  const [refundRow, setRefundRow] = useState<StyleRow | null>(null)
  const [resultRow, setResultRow] = useState<StyleRow | null>(null)
  const [classRow, setClassRow] = useState<StyleRow | null>(null)
  const menuFor = (row: StyleRow) => rowMenuItems(style, row, canWrite, {
    open: openRow,
    visit: (r) => void markVisit(r),
    line: () => router.push('/chats'),
    pay: openPayment,
    copy: (r) => {
      const href = detailHref(r)
      if (!href) { openRow(r); return }
      void navigator.clipboard?.writeText(`${window.location.origin}${href}`).then(() => notifyToast('予約 URL をコピーしました。'))
    },
    roster: (r) => setRosterId(r.id),
    noShow: (r) => void markNoShow(r),
    cancel: (r) => setCancelRow(r),
    refund: (r) => setRefundRow(r),
    cancelClass: (r) => { setRosterId(r.id); setClassRow(r) },
  })
  /** 取り消す（h2lHCH）。理由は口の cancellationReason へ。返金は決済の口（組3）の一部返金・理由つきが要る。 */
  const confirmCancel = async (row: StyleRow, input: CancelReservationInput) => {
    if (!canWriteRef.current || !cancelTarget || cancelTarget !== cancelTargetRef.current || cancelTarget.row !== row || cancelTarget.generation !== cancelScope.current.generation || !accountId) return
    if (style === 'restaurant' && (!cancelScope.current.storeId || (row.booking?.storeId && row.booking.storeId !== cancelScope.current.storeId))) return
    const generation = cancelTarget.generation
    let reasonSaved = false
    setBusy('cancel')
    try {
      if (style === 'restaurant' && row.reservationId) await restaurantTestApi.updateReservation(accountId, row.reservationId, { status: 'cancelled', expectedVersion: version(row), cancellationReason: input.reason })
      else {
        if (row.booking?.version != null) { await styleApi.saveBooking(accountId, bookingId(row), { expectedVersion: row.booking.version, cancellationReason: input.reason }); reasonSaved = true }
        await bookingApi.decideRequest(accountId, bookingId(row), 'cancel')
      }
      if (cancelScope.current.generation !== generation || cancelTargetRef.current !== cancelTarget) { notifyToast('前に選んだ予約を取り消しました。'); return }
      setCancelRow(null)
      notifyToast('予約を取り消しました。')
      if (input.refund !== 'none' || input.notify) openPayment()
    } catch (caught) { notifyToast(reasonSaved ? '理由は保存されましたが、取消の結果を確認できません。元のアカウントで予約を確認してください。' : (japaneseDetailOf(caught) || '取り消せませんでした。'), { tone: 'error' }) } finally { if (cancelScope.current.generation === generation) { setBusy(''); void reload() } }
  }
  /** 面談の結果（検討中・成約・見送り）。予約ごとに持つ（ 追記 4 ⑤）。 */
  const saveResult = async (row: StyleRow, outcome: 'considering' | 'won' | 'lost') => {
    setBusy('result')
    try {
      if (row.booking?.kind === 'meet' && row.booking.updatedAt) await styleApi.saveMeetResult(accountId, row.booking.id, { expectedUpdatedAt: row.booking.updatedAt, outcome })
      else await styleApi.saveBooking(accountId, bookingId(row), { expectedVersion: row.booking?.version ?? 1, outcome })
      setResultRow(null)
      notifyToast('結果を付けました。分析の成約率に入ります。')
    } catch (caught) { notifyToast(japaneseDetailOf(caught) || '結果を付けられませんでした。', { tone: 'error' }) } finally { setBusy(''); void reload() }
  }
  const [testMode, setTestMode] = useState(false)
  useEffect(() => { if (accountId) void bookingApi.getPaymentConfig(accountId).then((r) => setTestMode(Boolean(r.data?.testMode))).catch(() => setTestMode(false)) }, [accountId])

  const alertAction = async (action: StyleAlertAction) => {
    if (action.taskId && style === 'restaurant') {
      setBusy(action.id)
      try { await restaurantTestApi.completeChannelCloseTask(accountId, action.taskId); notifyToast('枠を閉じた印を付けました。') } catch (caught) {
        notifyToast(japaneseDetailOf(caught) || '印を付けられませんでした。', { tone: 'error' })
      } finally { await reload(); setBusy('') }
      return
    }
    if (action.href) router.push(action.href)
  }

  const attend = async (r: StyleRoster, bookingId: string | null, status: 'attended' | 'no_show' = 'attended') => {
    if (busy) return
    const targets = attendanceTargets(r, bookingId)
    setBusy('attend')
    let failedCount = 0
    for (const m of targets) {
      try { await eventsApi.updateBooking(accountId, m.eventId!, m.bookingId!, { status }) } catch { failedCount += 1 }
    }
    setBusy('')
    const word = status === 'attended' ? '出席' : '無断欠席'
    notifyToast(failedCount ? `${formatNumber(failedCount)}人を${word}にできませんでした。` : `${word}にしました。`, failedCount ? { tone: 'error' } : undefined)
    setRosterId(r.rowId)
    setRosterRevision(value => value + 1)
    void load()
  }

  const KIND: Record<string, RestaurantClosureKind> = { 貸切: 'private_event', 臨時休業: 'temporary_closed' }
  const saveClosure = async (input: StyleClosureInput) => {
    setBusy('closure')
    try {
      if (!input.expectedSnapshot) throw new Error('confirmation_unavailable')
      if (style === 'restaurant' && store.store) {
        const res = await restaurantTestApi.createClosure(accountId, { storeId: store.store.id, startDate: input.date, endDate: input.date, allDay: input.allDay, startTime: input.from ?? null, endTime: input.to ?? null, kind: KIND[input.reason] ?? 'other', memo: input.reason, tableIds: input.target === 'seat' ? input.ids : [], expectedSnapshot: input.expectedSnapshot })
        notifyToast(res.data.reservations.length ? `休みを入れました。重なる予約が ${formatNumber(res.data.reservations.length)}件あります（取り消していません）。` : '休みを入れました。')
      } else {
        await styleApi.closeHoursConfirmed(accountId, { date: input.date, target: input.target === 'store' ? 'store' : 'staff', staffIds: input.target === 'staff' ? input.ids : [], allDay: input.allDay, startTime: input.from, endTime: input.to, reason: input.reason, expectedSnapshot: input.expectedSnapshot })
        notifyToast('休みを入れました。予約は取り消していません。')
      }
      setClosureOpen(false)
      void reload()
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409 && (caught.code === 'confirmation_changed' || caught.message === 'confirmation_changed')) {
        const count = (caught.data as { count?: unknown } | null)?.count
        setClosureOpen(false); void reload()
        notifyToast(`予約が変わりました。${typeof count === 'number' ? `現在 ${formatNumber(count)} 件です。` : ''}最新の状態を確認してください。`, { tone: 'error' })
      } else notifyToast(japaneseDetailOf(caught) || '休みを入れられませんでした。', { tone: 'error' })
    } finally { setBusy('') }
  }

  const addNew = (slot?: { date?: string; time?: string; staffId?: string }) => {
    if (!canWrite) return
    if (style === 'restaurant' && store.store) setPhoneOpen(true)
    else if (style === 'lesson') router.push('/events')
    else if (style === 'salon' || style === 'consult') {
      const query = new URLSearchParams({ date: slot?.date ?? date })
      const selectedStaff = slot?.staffId ?? staffId
      if (selectedStaff) query.set('staffId', selectedStaff)
      if (slot?.time) query.set('time', slot.time)
      router.push(`/booking/bookings/new?${query}`)
    }
    else router.push('/booking/bookings?new=1')
  }


 return { cfg, router, pathname, params, tab, view, range, subTab, days, selectedAccountId, accountId, role, canWrite, date, setDate, staff, setStaff, compare, setCompare, search, setSearch, data, setData, failed, setFailed, analytics, setAnalytics, analyticsFailed, setAnalyticsFailed, layout, setLayout, applyPresentation, metricSelectionFallback, reloadPresentation, defaultMetrics: data?.kpis ?? fallback?.kpis ?? [], viewOpen, setViewOpen, closureOpen, setClosureOpen, phoneOpen, setPhoneOpen, walkInOpen, setWalkInOpen, busy, setBusy, rosterId, setRosterId, asideOpen, setAsideOpen, floor, setFloor, loadedAt, setLoadedAt, store, tables, setParam, staffId, compareParam, load, loadAnalytics, cardDefaults, setCardDefaults, roster, setRoster, rosterRow, fallback, restaurantBand, today, preparing, openPayment, reload, asOf, hours, subtitle, openRow, version, run, bookingId, markVisit, markNoShow, approve, undoVisit, cancelRow, setCancelRow, refundRow, setRefundRow, resultRow, setResultRow, classRow, setClassRow, menuFor, confirmCancel, saveResult, testMode, setTestMode, alertAction, attend, reloadRoster: () => { setRosterRevision(value => value + 1); void load() }, KIND, saveClosure, addNew }
}

import { COMPARE } from './dashboard-options'
