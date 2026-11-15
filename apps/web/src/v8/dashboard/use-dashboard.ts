'use client'
import { useStaffIdentity } from '@/lib/staff-role'
import { jstCalendar as japanCalendar } from '@/lib/jst-datetime'
import { dashboardCardForStyle } from './style-cards'

import { jstDate, jstDayStartIso } from '@/lib/jst-datetime'

import { useSamePageUrl } from '@/lib/use-same-page-url'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { validHoursDate, type NotificationCenterData, type NotificationCenterItem } from '@line-crm/shared'
import { ApiError, api, bookingApi, type BookingRequest, type DashboardOverview } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { useFeatureVisibility } from '@/lib/use-feature-visibility'
import { STATE_TEXT } from '@/components/shared/not-connected'
import type { PendingInboxSummary } from '@/components/support/pending-inbox-card'
import type { ShipmentSummary } from '@/components/dashboard/shipment-panel'
import { activeUpcomingBookings, inactiveBookingStatuses } from '@/components/dashboard/side-cards'
import { hasInboundSupportMark, summarizeTwoFactor, type TwoFactorSummary } from '@/components/dashboard/live-summary'
import { isDashboardNotificationData } from '@/components/dashboard/notification-summary'
import {
  defaultDashboardPreferences,
  normalizeDashboardPreferences,
  V8_DASHBOARD_DEFAULT_VISIBILITY,
  type DashboardPreferences,
} from '@/components/dashboard/dashboard-preference-defaults'

/*
 * ★V8 ダッシュボードの読み書き。
 *
 * 管理画面 の `app/page.tsx` の DashboardPageInner から、データの取り方・保存・
 * 失敗の扱いをそのまま写した（src/v8 からは @/app を読めないため）。
 * 変えたのは見た目に関わらない2点だけ：
 * - 稼働（health）は板の頭の「動きの状態」に使うので、右の列のカードを
 *   隠していても読む（補足の口も最初から読む）。
 * - 通知パネル（ベル）は共通のトップバーが持つので、ここは「最近の動き」
 *   に出す先頭の数件だけを読む。
 */

export const PERIODS = [
  { key: 'last7', label: '過去7日' },
  { key: 'last30', label: '過去30日' },
  { key: 'last90', label: '過去90日' },
] as const

export type PeriodKey = (typeof PERIODS)[number]['key'] | 'custom'
export type HealthRisk = 'normal' | 'warning' | 'danger' | null

/** 配置の手元の写し。管理画面 と同じ名前（切り替えの日に持ち越す）。 */
export function dashboardStorageKey(accountId: string | null): string {
  return `lh_dashboard_v4:${accountId ?? 'default'}`
}

export function jstDay(iso: string | number | Date): string {
  const date = iso instanceof Date ? iso : new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return jstDate(date)
}

function monthKey(offset: number): string {
  const now = japanCalendar()
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
  return d.toISOString().slice(0, 7)
}

export function useDashboard(usageStyle?: 'standard' | 'ec') {
  const samePageUrl = useSamePageUrl()
  const params = useSearchParams()
  const { selectedAccountId, selectedAccount, loading: accountLoading } = useAccount()

  const rawPeriod = params.get('period') === 'last28' ? 'last30' : params.get('period')
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const validRange = validHoursDate(from) && validHoursDate(to) && from <= to && to <= jstDate() && Date.parse(to) - Date.parse(from) <= 365 * 86_400_000
  const period: PeriodKey = rawPeriod === 'custom' && validRange ? 'custom' : PERIODS.some(item => item.key === rawPeriod) ? rawPeriod as PeriodKey : 'last7'
  const customRange = period === 'custom' ? { from, to } : null
  const editParam = params.get('edit')
  const [editorOpen, setEditorOpen] = useState(() => editParam === '1')
  useEffect(() => { setEditorOpen(editParam === '1') }, [editParam])
  const updateQuery = useCallback((mutate: (query: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString())
    mutate(next)
    const text = next.toString()
    samePageUrl.replace(text ? `/?${text}` : '/')
  }, [params, samePageUrl])
  const selectPeriod = useCallback((key: PeriodKey) => {
    updateQuery((query) => { query.set('period', key); query.delete('from'); query.delete('to') })
  }, [updateQuery])
  const selectRange = useCallback((range: { from: string; to: string }) => {
    updateQuery((query) => { query.set('period', 'custom'); query.set('from', range.from); query.set('to', range.to) })
  }, [updateQuery])

  const [overview, setOverview] = useState<{ accountId: string; period: PeriodKey; rangeKey: string; value: DashboardOverview } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [preferences, setPreferences] = useState<DashboardPreferences>(() => defaultDashboardPreferences(V8_DASHBOARD_DEFAULT_VISIBILITY))
  const [preferenceVersion, setPreferenceVersion] = useState(0)
  const [preferenceSaving, setPreferenceSaving] = useState(false)
  const preferenceSaveInFlight = useRef(false)
  const [preferenceSaveError, setPreferenceSaveError] = useState<{ message: string; conflict: boolean } | null>(null)
  const [inboxSummary, setInboxSummary] = useState<PendingInboxSummary | null>(null)
  const [inboxFailed, setInboxFailed] = useState(false)
  const [shipmentSummary, setShipmentSummary] = useState<ShipmentSummary | null>(null)
  const [shipmentState, setShipmentState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [pendingPhotos, setPendingPhotos] = useState<number | null>(null)
  const [pendingPhotosState, setPendingPhotosState] = useState<'loading' | 'ready' | 'forbidden' | 'error'>('loading')
  const [bookings, setBookings] = useState<BookingRequest[] | null>(null)
  const [todayActiveBookings, setTodayActiveBookings] = useState<number | null>(null)
  const [bookingsFailed, setBookingsFailed] = useState(false)
  const [healthFailed, setHealthFailed] = useState(false)
  const [supplementLoadedAt, setSupplementLoadedAt] = useState<Date | null>(null)
  const [supplementLoading, setSupplementLoading] = useState(true)
  const [healthRisk, setHealthRisk] = useState<HealthRisk>(null)
  const [healthIssueCount, setHealthIssueCount] = useState<number | null>(null)
  const [twoFactorSummary, setTwoFactorSummary] = useState<TwoFactorSummary | null>(null)
  const [supportMarkAutoOnInbound, setSupportMarkAutoOnInbound] = useState<boolean | null>(null)
  const [notificationData, setNotificationData] = useState<{ accountId: string; value: NotificationCenterData } | null>(null)
  const [notificationFailed, setNotificationFailed] = useState(false)
  const staffName = useStaffIdentity()?.name ?? null

  const openEditor = useCallback(() => {
    setPreferenceSaveError(null)
    setEditorOpen(true)
    updateQuery((query) => query.set('edit', '1'))
  }, [updateQuery])
  const closeEditor = useCallback(() => {
    setEditorOpen(false)
    updateQuery((query) => query.delete('edit'))
  }, [updateQuery])

  const handleShipmentSummary = useCallback(
    (summary: ShipmentSummary | null, state?: 'loading' | 'ready' | 'error') => {
      setShipmentSummary(summary)
      setShipmentState(state ?? (summary ? 'ready' : 'loading'))
    },
    [],
  )
  const handleInboxSummary = useCallback((summary: PendingInboxSummary | null, ok?: boolean) => {
    if (ok === false) {
      setInboxSummary(null)
      setInboxFailed(true)
      return
    }
    if (summary) {
      setInboxSummary(summary)
      setInboxFailed(false)
    }
  }, [])

  const loadRequestId = useRef(0)
  const selectedAccountIdRef = useRef(selectedAccountId)
  selectedAccountIdRef.current = selectedAccountId
  const data = overview && overview.accountId === selectedAccountId
    ? overview.value
    : null
  const rangeKey = period === 'custom' ? `${from}/${to}` : ''
  const displayedPeriod = data ? overview!.period : period
  const previousPeriod = data !== null && (displayedPeriod !== period || overview!.rangeKey !== rangeKey)
  const periodNotice = previousPeriod
    ? error ? `前の期間を表示しています。選んだ期間のデータを${STATE_TEXT.error}` : '前の期間を表示・更新中'
    : ''
  const supportMarksEnabled = useFeatureVisibility(selectedAccountId).enabled('support_marks')
  const visibleRight = preferences.right
    .filter(item => dashboardCardForStyle(item.id, usageStyle, preferenceVersion > 0))
    .filter((item) => item.visible)
    .filter((item) => item.id !== 'support-mark-status' || supportMarksEnabled)
  const visibleToday = preferences.today.filter((item) => item.visible && dashboardCardForStyle(item.id, usageStyle, preferenceVersion > 0))
  const needsPhotos = visibleToday.some((item) => item.id === 'today-photo-review')
  const needsBookings = visibleToday.some((item) => item.id === 'today-bookings')
    || visibleRight.some((item) => item.id === 'upcoming')
  const needsHealth = true
  // V8 は右の列も初めから表示するため、補足も最初に読み始める。
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const supplementGate = true
  const needsTwoFactor = visibleRight.some((item) => item.id === 'operational-alerts')
  const needsSupportMarks = visibleRight.some((item) => item.id === 'support-mark-status')

  useEffect(() => {
    if (!selectedAccountId) {
      setPreferences(defaultDashboardPreferences(V8_DASHBOARD_DEFAULT_VISIBILITY))
      setPreferenceVersion(0)
      return
    }
    let cancelled = false
    const key = dashboardStorageKey(selectedAccountId)
    try {
      const raw = window.localStorage.getItem(key)
      const cached = raw ? JSON.parse(raw) as { cards?: unknown; version?: unknown } : null
      setPreferences(normalizeDashboardPreferences(cached?.cards ?? cached, V8_DASHBOARD_DEFAULT_VISIBILITY))
      setPreferenceVersion(Number.isInteger(cached?.version) ? Number(cached?.version) : 0)
    } catch {
      setPreferences(defaultDashboardPreferences(V8_DASHBOARD_DEFAULT_VISIBILITY))
    }
    void api.dashboard.preferences.get(selectedAccountId)
      .then((response) => {
        if (cancelled || !response.success) return
        const next = normalizeDashboardPreferences(response.data.cards, V8_DASHBOARD_DEFAULT_VISIBILITY)
        setPreferences(next)
        setPreferenceVersion(response.data.version)
        try { window.localStorage.setItem(key, JSON.stringify({ version: response.data.version, cards: next })) } catch { /* cache unavailable */ }
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [selectedAccountId])

  /* アカウントが替わったら編集パネルを閉じる（DASH-04）。 */
  const editorAccountRef = useRef(selectedAccountId)
  useEffect(() => {
    if (editorAccountRef.current === selectedAccountId) return
    editorAccountRef.current = selectedAccountId
    closeEditor()
    setPreferenceSaveError(null)
  }, [selectedAccountId, closeEditor])

  const applyPreferences = async (next: DashboardPreferences) => {
    if (preferenceSaveInFlight.current) return
    if (!selectedAccountId) {
      setPreferenceSaveError({ message: 'LINEアカウントを選択してください', conflict: false })
      return
    }
    const accountId = selectedAccountId
    preferenceSaveInFlight.current = true
    setPreferenceSaving(true)
    setPreferenceSaveError(null)
    try {
      const normalized = normalizeDashboardPreferences(next, V8_DASHBOARD_DEFAULT_VISIBILITY)
      const response = await api.dashboard.preferences.save(accountId, { version: preferenceVersion, cards: normalized })
      if (!response.success) throw new Error(response.error)
      try { window.localStorage.setItem(dashboardStorageKey(accountId), JSON.stringify({ version: response.data.version, cards: normalized })) } catch { /* cache unavailable */ }
      if (selectedAccountIdRef.current !== accountId) return
      setPreferences(normalized)
      setPreferenceVersion(response.data.version)
      closeEditor()
    } catch (caught) {
      if (selectedAccountIdRef.current !== accountId) return
      const conflict = caught instanceof Error && 'status' in caught && caught.status === 409
      setPreferenceSaveError({
        /* 言葉は絵  の 4（引き出しの下の帯）。 */
        message: conflict ? 'ほかの人が配置を変えました。最新の配置を読み込んでから直してください。' : '配置を保存できませんでした。通信を確かめてください。',
        conflict,
      })
    } finally {
      preferenceSaveInFlight.current = false
      setPreferenceSaving(false)
    }
  }

  const resetPreferences = async () => {
    if (!selectedAccountId || preferenceSaveInFlight.current) return
    const accountId = selectedAccountId
    preferenceSaveInFlight.current = true
    setPreferenceSaving(true)
    setPreferenceSaveError(null)
    try {
      await api.dashboard.preferences.reset(accountId)
      const response = await api.dashboard.preferences.get(accountId)
      if (selectedAccountIdRef.current !== accountId) return
      const next = response.success ? normalizeDashboardPreferences(response.data.cards, V8_DASHBOARD_DEFAULT_VISIBILITY) : defaultDashboardPreferences(V8_DASHBOARD_DEFAULT_VISIBILITY)
      const nextVersion = response.success ? response.data.version : 0
      setPreferences(next)
      setPreferenceVersion(nextVersion)
      try { window.localStorage.setItem(dashboardStorageKey(accountId), JSON.stringify({ version: nextVersion, cards: next })) } catch { /* cache unavailable */ }
      closeEditor()
    } catch {
      if (selectedAccountIdRef.current === accountId) {
        setPreferenceSaveError({ message: '配置を初期状態へ戻せませんでした。通信を確かめてください。', conflict: false })
      }
    } finally {
      preferenceSaveInFlight.current = false
      setPreferenceSaving(false)
    }
  }

  const comparePreferences = async (): Promise<DashboardPreferences | null> => {
    const accountId = selectedAccountId
    if (!accountId) return null
    const response = await api.dashboard.preferences.get(accountId)
    return response.success && selectedAccountIdRef.current === accountId ? normalizeDashboardPreferences(response.data.cards, V8_DASHBOARD_DEFAULT_VISIBILITY) : null
  }

  const reloadPreferences = async (): Promise<DashboardPreferences | null> => {
    const accountId = selectedAccountId
    if (!accountId) return null
    try {
      const response = await api.dashboard.preferences.get(accountId)
      if (!response.success || selectedAccountIdRef.current !== accountId) return null
      const next = normalizeDashboardPreferences(response.data.cards, V8_DASHBOARD_DEFAULT_VISIBILITY)
      setPreferences(next)
      setPreferenceVersion(response.data.version)
      try { window.localStorage.setItem(dashboardStorageKey(accountId), JSON.stringify({ version: response.data.version, cards: next })) } catch { /* cache unavailable */ }
      setPreferenceSaveError(null)
      return next
    } catch {
      return null
    }
  }

  const load = useCallback(async () => {
    const requestId = ++loadRequestId.current
    if (accountLoading) return
    if (!selectedAccountId) {
      setOverview(null)
      setLoading(false)
      setError('LINEアカウントを選択してください')
      return
    }
    const accountId = selectedAccountId
    const periodKey = period
    setLoading(true)
    setError('')
    try {
      const response = await api.dashboard.overview({ period: periodKey, accountId, ...(periodKey === 'custom' ? { from, to } : {}) })
      if (requestId !== loadRequestId.current) return
      if (response.success) setOverview(previous => {
        const nextRangeKey = periodKey === 'custom' ? `${from}/${to}` : ''
        const old = previous?.accountId === accountId && (previous.period !== periodKey || previous.rangeKey !== nextRangeKey) ? previous.value : null
        const incoming = response.data
        const value = old ? {
          ...incoming, generatedAt: old.generatedAt, friends: old.friends, inbox: old.inbox,
          delivery: old.delivery, trend: old.trend, metrics: old.metrics,
          sections: incoming.sections && old.sections ? {
            ...incoming.sections, friends: old.sections.friends, inbox: old.sections.inbox,
            delivery: old.sections.delivery, quota: old.sections.quota, trend: old.sections.trend,
          } : incoming.sections,
          operations: incoming.operations && old.operations ? {
            ...incoming.operations, scenarios: old.operations.scenarios,
            migrations: old.operations.migrations, bookings: old.operations.bookings,
          } : incoming.operations,
        } : incoming
        return { accountId, period: periodKey, rangeKey: nextRangeKey, value }
      })
      else setError(response.error)
    } catch {
      if (requestId === loadRequestId.current) setError(`データを${STATE_TEXT.error}`)
    } finally {
      if (requestId === loadRequestId.current) setLoading(false)
    }
  }, [accountLoading, period, from, to, selectedAccountId])

  useEffect(() => { void load() }, [load])

  /* 最近の動き：選択中アカウントの通知の新しい順（先頭だけ）。 */
  useEffect(() => {
    let cancelled = false
    setNotificationFailed(false)
    if (!selectedAccountId) return
    const accountId = selectedAccountId
    void api.notifications.center.list(accountId, { category: 'all', limit: 20 })
      .then((response) => {
        if (cancelled) return
        if (response.success && isDashboardNotificationData(response.data)) setNotificationData({ accountId, value: response.data })
        else setNotificationFailed(true)
      })
      .catch(() => { if (!cancelled) setNotificationFailed(true) })
    return () => { cancelled = true }
  }, [selectedAccountId])

  const markSupplementLoaded = useCallback((isCancelled: () => boolean) => {
    if (!isCancelled()) setSupplementLoadedAt(new Date())
  }, [])

  useEffect(() => {
    setSupplementLoadedAt(null)
    setSupplementLoading(Boolean(selectedAccountId))
  }, [selectedAccountId])

  useEffect(() => {
    if (!supplementGate) return
    setPendingPhotos(null)
    setPendingPhotosState('loading')
    if (!selectedAccountId) return
    if (!needsPhotos) {
      setPendingPhotosState('ready')
      return
    }
    let cancelled = false
    const isCancelled = () => cancelled
    void api.nenMembers.photoReviewMetrics(selectedAccountId).then(
      (result) => {
        if (cancelled) return
        const photoCount = result?.success ? result.data.pendingCount : null
        setPendingPhotos(photoCount)
        setPendingPhotosState(photoCount !== null ? 'ready' : 'error')
        markSupplementLoaded(isCancelled)
      },
      (reason) => {
        if (cancelled) return
        setPendingPhotos(null)
        setPendingPhotosState(reason instanceof ApiError && reason.status === 403 ? 'forbidden' : 'error')
        markSupplementLoaded(isCancelled)
      },
    )
    return () => { cancelled = true }
  }, [markSupplementLoaded, needsPhotos, selectedAccountId, supplementGate])

  useEffect(() => {
    if (!supplementGate) return
    setBookings(null)
    setTodayActiveBookings(null)
    setBookingsFailed(false)
    if (!selectedAccountId) return
    if (!needsBookings) {
      setSupplementLoading(false)
      return
    }
    let cancelled = false
    const isCancelled = () => cancelled
    setSupplementLoading(true)
    const now = new Date()
    const todayStartIso = jstDayStartIso(now)
    const todayJst = jstDay(now)
    const bookingPromise = bookingApi.listRequests(selectedAccountId, 'all', { from: todayStartIso, limit: 100 })
    const bookingSummaryPromise = bookingApi.requestsSummary(selectedAccountId, {
      month: monthKey(0),
      lastMonth: monthKey(-1),
      today: todayJst,
      weekTo: jstDay(Date.now() + 6 * 86_400_000),
    })
    void bookingPromise.then(
      (result) => {
        if (cancelled) return
        const bookingList = result && Array.isArray(result.requests) ? result.requests : null
        setBookings(bookingList)
        setBookingsFailed(bookingList === null)
        markSupplementLoaded(isCancelled)
      },
      () => {
        if (cancelled) return
        setBookings(null)
        setBookingsFailed(true)
        markSupplementLoaded(isCancelled)
      },
    )
    void bookingSummaryPromise.then(
      (result) => {
        if (cancelled) return
        setTodayActiveBookings(result && typeof result.todayActiveTotal === 'number' ? result.todayActiveTotal : null)
        markSupplementLoaded(isCancelled)
      },
      () => {
        if (cancelled) return
        setTodayActiveBookings(null)
        markSupplementLoaded(isCancelled)
      },
    )
    void Promise.allSettled([bookingPromise, bookingSummaryPromise]).then(() => {
      if (!cancelled) setSupplementLoading(false)
    })
    return () => { cancelled = true }
  }, [markSupplementLoaded, needsBookings, selectedAccountId, supplementGate])

  useEffect(() => {
    if (!supplementGate) return
    setHealthRisk(null)
    setHealthIssueCount(null)
    setHealthFailed(false)
    if (!selectedAccountId || !needsHealth) return
    let cancelled = false
    const isCancelled = () => cancelled
    void api.health.getHealth(selectedAccountId).then(
      (result) => {
        if (cancelled) return
        const healthData = result?.success === true ? result.data : null
        setHealthRisk(healthData ? (healthData.riskLevel as HealthRisk) : null)
        setHealthIssueCount(
          healthData
            ? Number(healthData.riskLevel === 'warning' || healthData.riskLevel === 'danger')
            : null,
        )
        setHealthFailed(healthData === null)
        markSupplementLoaded(isCancelled)
      },
      () => {
        if (cancelled) return
        setHealthRisk(null)
        setHealthIssueCount(null)
        setHealthFailed(true)
        markSupplementLoaded(isCancelled)
      },
    )
    return () => { cancelled = true }
  }, [markSupplementLoaded, needsHealth, selectedAccountId, supplementGate])

  useEffect(() => {
    if (!supplementGate) return
    setTwoFactorSummary(null)
    if (!selectedAccountId || !needsTwoFactor) return
    let cancelled = false
    const isCancelled = () => cancelled
    void api.staff.list().then(
      (result) => {
        if (cancelled) return
        setTwoFactorSummary(result?.success ? summarizeTwoFactor(result.data) : null)
        markSupplementLoaded(isCancelled)
      },
      () => {
        if (cancelled) return
        setTwoFactorSummary(null)
        markSupplementLoaded(isCancelled)
      },
    )
    return () => { cancelled = true }
  }, [markSupplementLoaded, needsTwoFactor, selectedAccountId, supplementGate])

  useEffect(() => {
    if (!supplementGate) return
    setSupportMarkAutoOnInbound(null)
    if (!selectedAccountId || !needsSupportMarks) return
    let cancelled = false
    const isCancelled = () => cancelled
    void api.supportMarks.list(selectedAccountId, { suppressFeatureDisabledEvent: true }).then(
      (result) => {
        if (cancelled) return
        setSupportMarkAutoOnInbound(result?.success ? hasInboundSupportMark(result.data) : null)
        markSupplementLoaded(isCancelled)
      },
      () => {
        if (cancelled) return
        setSupportMarkAutoOnInbound(null)
        markSupplementLoaded(isCancelled)
      },
    )
    return () => { cancelled = true }
  }, [markSupplementLoaded, needsSupportMarks, selectedAccountId, supplementGate])

  const activeBookings = useMemo(
    () => bookings?.filter((booking) => !inactiveBookingStatuses.has(booking.status)) ?? [],
    [bookings],
  )
  const today = jstDay(new Date())
  const reference = data?.visualQa
  const displayedBookings = reference?.hideBookings ? [] : bookings
  const todayBookings = (reference?.hideBookings ? [] : activeBookings).filter((booking) => jstDay(booking.starts_at) === today)
  const upcomingBookings = displayedBookings ? activeUpcomingBookings(displayedBookings) : []
  const displayedHealthRisk = reference?.healthRisk ?? healthRisk
  const displayedTwoFactor = reference?.twoFactor ?? twoFactorSummary
  const sectionAvailable = (section: keyof NonNullable<DashboardOverview['sections']>) =>
    data?.sections?.[section]?.status !== 'unavailable'
      && data?.sections?.[section]?.status !== 'partial'
  const activeFriends = data?.metrics === undefined
    ? sectionAvailable('friends') ? data?.friends.active ?? null : null
    : data.metrics.activeFriends.value
  /* 「対応が必要な受信」の数え方は 管理画面 と同じ（IDEA-01）。 */
  const inboxSectionOk = data !== null && sectionAvailable('inbox')
  const lineUnread = inboxSectionOk ? (data.inbox.line?.unanswered ?? data.inbox.unanswered) : null
  const mailUnread = inboxSectionOk && data.inbox.email
    ? data.inbox.email.unanswered
    : (inboxSummary?.emailUnread ?? null)
  const pendingTotal = lineUnread === null || mailUnread === null ? null : lineUnread + mailUnread
  const pendingDetailState: 'loading' | 'error' | 'ready' = lineUnread === null && mailUnread === null
    ? (data !== null || inboxFailed || error ? 'error' : 'loading')
    : 'ready'
  const pendingOldest = inboxSectionOk
    ? (data.inbox.oldestUnansweredMinutes ?? null)
    : (inboxSummary?.oldestWaitMinutes ?? null)

  const notifications: NotificationCenterItem[] | null = notificationData && notificationData.accountId === selectedAccountId
    ? notificationData.value.items
    : null

  return {
    bodyRef,
    supplementGate,
    selectedAccountId,
    selectedAccount,
    period,
    selectPeriod,
    customRange,
    selectRange,
    editorOpen,
    openEditor,
    closeEditor,
    data,
    displayedPeriod,
    periodNotice,
    loading: loading && data === null,
    error,
    load,
    preferences,
    preferenceVersion,
    preferenceSaving,
    preferenceSaveError,
    applyPreferences,
    resetPreferences,
    reloadPreferences,
    comparePreferences,
    visibleToday,
    visibleRight,
    handleShipmentSummary,
    handleInboxSummary,
    shipmentSummary,
    shipmentState,
    pendingPhotos,
    pendingPhotosState,
    bookings,
    bookingsFailed,
    todayActiveBookings,
    displayedBookings,
    todayBookings,
    upcomingBookings,
    supplementLoading,
    supplementLoadedAt,
    healthFailed,
    healthIssueCount,
    displayedHealthRisk,
    displayedTwoFactor,
    supportMarkAutoOnInbound,
    sectionAvailable,
    activeFriends,
    lineUnread,
    mailUnread,
    pendingTotal,
    pendingDetailState,
    pendingOldest,
    notifications,
    notificationFailed,
    staffName,
    today,
    reference,
  }
}

export type DashboardState = ReturnType<typeof useDashboard>
