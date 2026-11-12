'use client'
import { FirstStepsCard, FirstStepsFeedback, useFirstSteps, FirstRunDoneDialog } from '@/v8/dashboard/public/first-steps/index'
import { canManageRole } from '@/lib/staff-role'
import { SetupTasks, SetupTasksUnavailable, SetupWarningBands, ReservationFormRepairNotices, setupSummary } from '@/v8/onboarding/public/setup-card/index'
import { useStyleSetup } from '@/v8/onboarding/public/use-style-setup/index'
import { useSetupWizard } from '@/v8/onboarding/public/setup-wizard/index'
import { FriendAddLink } from '@/v8/dashboard/public/friend-add/index'
import CalendarPeriod from '@/components/shared/calendar-period'
import { formatYen } from '@line-crm/shared';
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import { restaurantWalkIn } from '@/lib/terms'
import { CancelReservationDialog } from '@/components/shared/booking-confirm-dialogs'
import Button from '@/components/shared/button'
import DateField from '@/components/shared/date-field'
import DeltaChip from '@/components/shared/delta-chip'
import Dialog from '@/components/shared/dialog'
import EntitySelect from '@/components/shared/entity-select'
import { KpiValueMotionProvider } from '@/components/shared/kpi-value-motion'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import { lockUnless } from '@/components/shared/permission-lock'
import Notice from '@/components/shared/notice'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { useEventAbsence } from '@/v8/events'
import { RadioCardGroup } from '@/components/shared/radio-card'
import Radio from '@/components/shared/radio'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import RestaurantFloorMap from '@/components/shared/restaurant-floor-map'
import { DetailColumns } from '@/components/templates/detail-columns'
import { ListToolbarSearchSlot } from '@/components/shared/list-toolbar'
import SegmentedControl from '@/components/shared/segmented'
import { Tabs } from '@/components/shared/tabs'
import TestModeNote from '@/components/shared/test-mode-note'
import { notifyToast } from '@/components/shared/toast'
import { DashboardPage } from '@/components/templates/dashboard-page'
import { styleApi } from '@/lib/api/helpers/styles'
import { formatDate, formatNumber } from '@/lib/format'
import { restaurantTestApi } from '@/lib/restaurant-test-api'
import { Armchair,BellRing,CalendarCheck,CalendarDays,CalendarX2,Check,CircleUserRound,ClipboardList,Clock3,Copy,CreditCard,ExternalLink,Link2,MessageCircle,Plus,RefreshCw,Repeat2,SlidersHorizontal,Sparkles,UserPlus,UserRoundX,Users,Video } from 'lucide-react'
import type { ReactNode } from 'react'
import { useMemo,useState } from 'react'
import { PhoneReservationDrawer } from '@/v8/restaurant/front-desk/public/phone-drawer/index'
import { WalkInDialog } from '@/v8/restaurant/front-desk/public/walk-in-dialog/index'
import { bookingEmptyState, EmptyBookings } from './empty-bookings'
import { StyleAnalyticsView } from './analytics'
import { DayList,MonthCalendar,WeekCalendar } from './calendar'
import { RANGES,TAB_KEYS,TAB_PARAM,type DashboardTab,type DashboardView } from './config'
import { ANALYTICS_DAYS,COMPARE } from './dashboard-options'
import { jstToday,shiftDate } from './date-range'
import { LessonRoster } from './lesson-roster'
import type { IndustryStyle,StyleAlertAction,StyleKpi,StyleRow } from './model'
import { SideCard } from './parts'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { ClosureDialog,ViewDrawer } from './settings-panels'
import { StaffBoard } from './staff-board'
import styles from './style-dashboard.module.css'
import { TodayList } from './today-list'
import { useStyleDashboard } from './use-style-dashboard'
import { withHonorific } from '@line-crm/shared'




/*
 * ★V8 業種ダッシュボード（・・・・。絵 XBkC2）。
 * 4 業種（飲食・サロン・面談・教室）で同じ骨組み：
 *   頭（題＝業種の名前・日付と営業時間・すぐ使う操作）→ 日付の段（今日｜1週間｜1か月・日付・担当・比べる・読み直す）
 *   → 数の帯（5・「？」・前との比べ）→ 異常の帯 → タブ（1枚目・…・分析）＋表示の切り替え（盤｜一覧｜カレンダー）
 *   → 本文｜右の列（新着予約・お支払い・業種のカード）。
 * 動きは BEHAVIOR.md。
 */

const KPI_ICON: Record<string, ReactNode> = {
  today: <CalendarCheck size={16} aria-hidden="true" />, waiting: <BellRing size={16} aria-hidden="true" />, free: <Armchair size={16} aria-hidden="true" />,
  noshow: <UserRoundX size={16} aria-hidden="true" />, new: <Sparkles size={16} aria-hidden="true" />, rebook: <Repeat2 size={16} aria-hidden="true" />,
  income: <CreditCard size={16} aria-hidden="true" />, meetings: <Video size={16} aria-hidden="true" />, results: <ClipboardList size={16} aria-hidden="true" />,
  week: <CalendarDays size={16} aria-hidden="true" />, classes: <CalendarCheck size={16} aria-hidden="true" />, attendance: <ClipboardList size={16} aria-hidden="true" />,
  fill: <Clock3 size={16} aria-hidden="true" />, recall: <BellRing size={16} aria-hidden="true" />,
}

const ALERT_ICON: Record<NonNullable<StyleAlertAction['icon']>, ReactNode> = {
  external: <ExternalLink size={16} aria-hidden="true" />, check: <Check size={16} aria-hidden="true" />, refresh: <RefreshCw size={16} aria-hidden="true" />,
  link: <Link2 size={16} aria-hidden="true" />, people: <Users size={16} aria-hidden="true" />,
}

function Kpi({ kpi, onPreparing }: { kpi: StyleKpi; onPreparing: () => void }) {
  return (
    <KpiCard
      presentation="band"
      title={kpi.title}
      icon={KPI_ICON[kpi.id] ?? <CircleUserRound size={16} aria-hidden="true" />}
      help={kpi.help}
      helpDisplay="question"
      value={kpi.value}
      valueText={kpi.valueText}
      unit={kpi.unit}
      delta={kpi.delta ? <DeltaChip tone={kpi.delta.tone}>{kpi.delta.text}</DeltaChip> : undefined}
      detail={kpi.detail}
      detailLayout="single"
      action={kpi.link ? kpi.link.href === '#preparing-payment' ? { label: kpi.link.label, onClick: onPreparing } : { label: kpi.link.label, href: kpi.link.href } : undefined}
    />
  )
}

export default function StyleDashboard({ style }: { style: IndustryStyle }) {
  const { cfg, router, tab, subTab, view, range, days, accountId, role, canWrite, date, setDate, staff, setStaff, compare, setCompare, search, setSearch, failed, analytics, analyticsFailed, layout, applyPresentation, metricSelectionFallback, reloadPresentation, defaultMetrics, viewOpen, setViewOpen, closureOpen, setClosureOpen, phoneOpen, setPhoneOpen, walkInOpen, setWalkInOpen, busy, setBusy, rosterId, setRosterId, asideOpen, setAsideOpen, floor, loadedAt, store, tables, setParam, load, loadAnalytics, setCardDefaults, roster, rosterRow, today, preparing, openPayment, reload, subtitle, openRow, markVisit, markNoShow, approve, undoVisit, cancelRow, setCancelRow, refundRow, setRefundRow, resultRow, setResultRow, classRow, setClassRow, menuFor, confirmCancel, saveResult, testMode, alertAction, attend, reloadRoster, KIND, saveClosure, addNew } = useStyleDashboard(style)

  const absence = useEventAbsence({ accountId, scope: JSON.stringify([style, date, rosterId]), onSaved: reloadRoster })
  const setup = useStyleSetup(accountId || null, role)
  const setupRest = setupSummary(setup.data, !canManageRole(role))
  const wizard = useSetupWizard(accountId || null, setup.data?.state, role, setup.reload)
  const { openStep: openSetupStep, qrRequested } = wizard
  const start = useFirstSteps(accountId || null, role, { style, qrOpen: qrRequested })
  const emptyBookingState = today ? bookingEmptyState(style, today) : null
  const hasEmptyBookingAction = tab === 'main' && range === 'today' && today && !search && (emptyBookingState === 'no-bookings' || emptyBookingState === 'no-classes')
  const writeLock = role === null ? undefined : lockUnless(canWrite)
  const viewErrors = useSaveFormErrors()
  const restaurantStoreReady = Boolean(accountId && !store.loading && !store.error && store.tableDefinition?.accountId === accountId && store.tableDefinition.snapshot === store.snapshot && store.store && store.snapshot?.stores.includes(store.store))
  const cancelStoreId = cancelRow?.booking?.storeId ?? store.today?.find(row => row.id === cancelRow?.reservationId)?.store_id
  const storeLock = restaurantStoreReady ? undefined : !store.loading || store.error ? '店舗情報を確認できません。読み直してからお試しください。' : '店舗情報を読み込んでいます。確認が終わるまでお待ちください。'
  const reservationLock = cfg.walkIn ? storeLock ?? (!today ? failed ? '予約情報を確認できません。読み直してからお試しください。' : '予約情報を読み込んでいます。確認が終わるまでお待ちください。' : undefined) : undefined
  const headActions = (
    <>
      {cfg.walkIn ? <Button disabled={role === null} lockedReason={writeLock || storeLock} onClick={() => { if (canWrite && restaurantStoreReady) setWalkInOpen(true) }}><UserPlus size={16} aria-hidden="true" />{restaurantWalkIn}</Button> : null}
      <Button lockedReason={writeLock} {...(canWrite ? { href: '/broadcasts' } : { disabled: role === null })}><MessageCircle size={16} aria-hidden="true" />LINE を送る</Button>
      <Button disabled={role === null} lockedReason={writeLock} onClick={() => { if (canWrite) setClosureOpen(true) }}><CalendarX2 size={16} aria-hidden="true" />休みを入れる</Button>
      <Button disabled={role === null} lockedReason={writeLock} onClick={() => { if (canWrite) setViewOpen(true) }}><SlidersHorizontal size={16} aria-hidden="true" />表示を変える</Button>
      {cfg.walkIn || (today && !hasEmptyBookingAction) ? <Button variant="primary" disabled={role === null} lockedReason={writeLock || reservationLock} onClick={() => { if (canWrite && (!cfg.walkIn || (restaurantStoreReady && today))) addNew() }}><Plus size={16} aria-hidden="true" />{cfg.primary}</Button> : null}
    </>
  )

  const staffOptions = [{ value: 'all', label: 'すべて' }, ...(today?.staff ?? []).map((s) => ({ value: s.id, label: s.name }))]
  const filters = tab === 'analytics' ? (
    <div className={styles.filters}>
      <SegmentedControl aria-label="期間" value={days} onChange={(v) => setParam({ days: v })} options={ANALYTICS_DAYS} />
      <div className={styles.dateBox} data-short><DateField value={date} onChange={setDate} displayFormat="short" clearable={false} /></div>
      <EntitySelect compact width={152} aria-label={cfg.staffNoun} valuePrefix={`${cfg.staffNoun}：`} value={staff} onChange={setStaff} options={staffOptions} />
      <span className={styles.grow} />
      <EntitySelect compact width={176} aria-label="比べる" valuePrefix="比べる：" value={compare} onChange={setCompare} options={COMPARE} />
      {loadedAt ? <span className={styles.updated}>更新 {formatDate(loadedAt, { style: 'time' })}</span> : null}
    </div>
  ) : (
    <div className={styles.filters}>
      <SegmentedControl aria-label="期間" value={range} onChange={(v) => setParam({ range: v === 'today' ? null : v })} options={RANGES} />
      <div className={styles.dateBox}><DateField value={date} onChange={setDate} displayFormat="day" clearable={false} /></div>
      <EntitySelect compact width={152} aria-label={cfg.staffNoun} valuePrefix={`${cfg.staffNoun}：`} value={staff} onChange={setStaff} options={staffOptions} />
      <span className={styles.grow} />
      <EntitySelect compact width={176} aria-label="比べる" valuePrefix="比べる：" value={compare} onChange={setCompare} options={COMPARE} />
      {loadedAt ? <span className={styles.updated}>更新 {formatDate(loadedAt, { style: 'time' })}</span> : null}
      {/* 上の段を軽くするため、読み直しは文字の押し口にする（題右は型が「…」へ畳む）。 */}
      <Button variant="text" onClick={() => void reload()}><RefreshCw size={16} aria-hidden="true" />読み直す</Button>
    </div>
  )

  const resultRows = useMemo(() => (style === 'consult' ? (today?.rows ?? []).filter((r) => r.action === 'result') : []), [style, today?.rows])
  const tabItems = TAB_KEYS.map((key: DashboardTab) => ({
    label: cfg.tabs[key],
    ...(style === 'consult' && key === 'bookings' && resultRows.length ? { count: resultRows.length, countTone: 'warning' as const } : {}),
    current: key === tab,
    onClick: () => setParam({ tab: key === 'main' ? null : TAB_PARAM[key] }),
  }))
  const viewSwitch = tab === 'main' ? (
    <SegmentedControl aria-label="表示" appearance="track" size="small" fit="content" value={view} onChange={(v: DashboardView) => setParam({ view: v === cfg.defaultView ? null : v })} options={cfg.views} />
  ) : null

  const side = (today?.side ?? []).map((card) => <SideCard key={card.id} card={card} canWrite={canWrite} onAction={(card) => (card.id === 'pay' ? openPayment() : ['care', 'waitlist', 'rebook'].includes(card.id) ? preparing.open(card.title) : router.push('/broadcasts'))}>{card.id === 'pay' && testMode ? <TestModeNote /> : null}</SideCard>)

  const shownRoster = style === 'lesson' && (rosterId === undefined ? view !== 'calendar' : rosterId !== null && roster?.rowId === rosterId) ? roster : null
  let body: ReactNode
  if (!today) {
    body = failed ? <ListState kind="error" title="ダッシュボードを読み込めませんでした" onRetry={() => void reload()} /> : <ListState kind="loading" loadingShape="cards" />
  } else if (tab === 'analytics') {
    body = <StyleAnalyticsView data={analytics} error={analyticsFailed} onTab={(t) => setParam({ sub: t })} onRetry={() => void loadAnalytics()} onRowOpen={() => router.push(cfg.links.bookings)} />
  } else if (style === 'consult' && tab === 'bookings') {
    // 結果待ち（OJ4Vu）：実施した面談のうち、結果をまだ付けていない物。押すと結果を付ける窓。
    body = (
      <DetailColumns variant="style-dashboard" asideLabel="今日の動き" expanded={false} onExpandedChange={() => {}} showToggle={false} aside={side.length ? side : null}>
          <TodayList style={style} rows={resultRows} note={`${formatNumber(resultRows.length)}件中 1〜${formatNumber(resultRows.length)}件・結果を付けると、分析の成約率に入ります`} canWrite={canWrite} busyId={busy} menuFor={menuFor}
            onVisit={(r) => void markVisit(r)} onUndo={() => {}} onResult={(r) => setResultRow(r)}
            empty={<ListState kind="empty" title="結果待ちの面談はありません" description="実施した面談に結果を付けると、ここから消えます。" />} />
      </DetailColumns>
    )
  } else if (tab !== 'main') {
    body = <ListState kind="empty" title={`${cfg.tabs[tab]}は今の画面で見られます`} action={<Button href={tab === 'bookings' ? cfg.links.bookings : cfg.links.people}>{`${cfg.tabs[tab]}を開く`}</Button>} />
  } else {
    const rows = today.rows.filter((r) => !search || r.name.includes(search) || (r.sub ?? '').includes(search) || (r.course ?? '').includes(search))
    const emptyBookings = hasEmptyBookingAction ? <EmptyBookings style={style} day={date === jstToday() ? '今日' : 'この日'} today={today} canWrite={canWrite} role={role} onBook={() => addNew()} onCreateClass={() => router.push('/events/new')} /> : null
    const filteredEmpty = <ListState kind="empty" emptyPreset="filtered" action={<Button onClick={() => setSearch('')}>検索を外す</Button>} />
    let main: ReactNode
    let aside: ReactNode = side.length ? side : null
    if (view === 'calendar') {
      if (range === 'month' && today.month) {
        main = <MonthCalendar month={today.month} onMove={(s) => setDate(s === 0 ? jstToday() : shiftDate(date, 'month', s))} onDay={(d) => setDate(d)} />
        aside = <DayList month={today.month} href={cfg.links.bookings} canWrite={canWrite} />
      } else if (today.week) {
        main = <WeekCalendar empty={emptyBookings} week={today.week} period={range === 'today' ? 'day' : 'week'} canWrite={canWrite} onMove={(s) => setDate(s === 0 ? jstToday() : shiftDate(date, range === 'today' ? 'today' : 'week', s))} onSlot={(day, time) => addNew({ date: day, time })} onOpen={(id) => { const row = today.rows.find((item) => item.id === id); if (row) openRow(row) }} />
        aside = null
      } else main = emptyBookings ?? <ListState kind="empty" title="カレンダーに出す予約はまだありません" />
    } else if (view === 'floor') {
      main = floor ? <RestaurantFloorMap floor={floor} labels={tables.map((t) => ({ id: t.id, label: t.code, active: Boolean(t.is_active), capacity: t.max_capacity }))} onSelect={() => router.push('/restaurant-test/tables')} />
        : <ListState kind="empty" title="座席の図がまだありません" action={canWrite ? <Button href="/restaurant-test/tables">座席の図を作る</Button> : undefined} />
    } else if (view === 'board' && today.board) {
      main = <StaffBoard empty={search && !today.board.entries.some(e => e.name.includes(search) || e.menu.includes(search)) ? filteredEmpty : emptyBookings} board={today.board} search={search} onSearch={setSearch} canWrite={canWrite} onSlot={(staffId, time) => addNew({ staffId, time })}
        entryItems={(e) => menuFor(today.rows.find((r) => r.id === e.id) ?? { id: e.id, time: e.start, name: e.name })} />
    } else {
      main = (
        <>
          {/* 探す欄は左に置く（追加決まり1）。帯の余白が付かない包み（ListToolbarSearchSlot）で幅を保つ。 */}
          {style !== 'lesson' ? <div className={styles.listTools} data-dashboard-list-tools><div className={styles.search}><ListToolbarSearchSlot width={220} search={{ value: search, onChange: setSearch, placeholder: cfg.search }} /></div></div> : null}
          {rows.length > 0 ? emptyBookings : null}
          <TodayList style={style} rows={rows} note={today.rowsNote} canWrite={canWrite} busyId={busy} menuFor={menuFor} onVisit={(r) => void markVisit(r)} onNoShow={(r) => void markNoShow(r)} onApprove={(r) => void approve(r)} onResult={(r) => setResultRow(r)} onUndo={(r) => void undoVisit(r)}
            empty={search ? filteredEmpty : emptyBookings ?? <ListState kind="empty" title={`${range === 'today' ? '今日' : range === 'week' ? '今週' : '今月'}の${style === 'consult' ? '面談' : style === 'lesson' ? 'クラス' : '予約'}はありません`} description={canWrite ? (style === 'consult' ? '予約の URL を案内すると、空いた時間に入ります。' : '空いている時間に予約を入れられます。') : undefined}
              action={style === 'consult' ? <Button variant="primary" onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}/booking`).then(() => notifyToast('予約 URL をコピーしました。')) }}><Copy size={16} aria-hidden="true" />予約 URL をコピー</Button> : <Button variant="primary" disabled={role === null} lockedReason={writeLock} onClick={() => { if (canWrite) addNew() }}><Plus size={16} aria-hidden="true" />{cfg.primary}</Button>} />}
            selectedId={style === 'lesson' ? (shownRoster ? shownRoster.rowId : null) : undefined} onSelect={style === 'lesson' ? (r) => setRosterId(r.id) : undefined} />
        </>
      )
    }
    if (shownRoster) aside = <LessonRoster roster={shownRoster} canWrite={canWrite} onClose={() => setRosterId(null)} onPay={openPayment} onAttend={(name) => void attend(shownRoster, name)} onAbsent={(name) => void attend(shownRoster, name, 'no_show')} absenceAllowed={absence.allowed} absenceLockedReason={absence.lockedReason} onReportAbsence={member => { if (member.bookingId && member.eventId && member.startsAt) absence.open({ bookingId: member.bookingId, eventId: member.eventId, startsAt: member.startsAt, name: member.name }) }} onLine={() => router.push('/broadcasts')} onCancelClass={() => { if (canWrite && rosterRow?.id === shownRoster.rowId) setClassRow(rosterRow) }} />
    body = (
      <DetailColumns variant={shownRoster ? 'style-roster' : 'style-dashboard'} aside={aside} asideLabel="今日の動き" expanded={asideOpen} onExpandedChange={setAsideOpen}
        showToggle={false}>{main}</DetailColumns>
    )
  }
  /* 追加決まり1: 右の列の開閉はタブの段の右端へ。タブの下に1つだけの段を作らない。 */
  const asideLabel = asideOpen ? '右の列を畳む' : roster ? '名簿を見る' : '新着・お支払いを見る'
  const mainAside = tab === 'main' && !!today && (shownRoster ? true : view === 'calendar'
    ? (range === 'month' && !!today.month) || (!today.week && side.length > 0)
    : side.length > 0)
  /* タブの段の右端の操作。狭い幅ではタブの下へ折り返す（タブに重ねない）。 */
  const tabRowActions = viewSwitch || mainAside ? (
    <div className={styles.tabRowActions}>
      {viewSwitch}
      {mainAside ? <span className={styles.tabAsideToggle}><Button size="compact" aria-expanded={asideOpen} onClick={() => setAsideOpen(!asideOpen)}>{asideLabel}</Button></span> : null}
    </div>
  ) : null

  const alert = tab !== 'analytics' ? today?.alert : null

  return (
    <KpiValueMotionProvider scope={accountId ? JSON.stringify([accountId, style, date, range, days, staff, compare, tab, subTab, view]) : null}>
    <DashboardPage boardId={`style-${style}`} initialContent={{ scope: JSON.stringify([accountId, style]), pending: start.status === 'loading' || setup.status === 'loading' || (!today && !failed) }} title={cfg.title} help={cfg.help} subtitle={subtitle} actions={headActions}>
      <div className={styles.head}>{filters}</div>
      <div className={styles.inset}>
        {absence.notice}
        {absence.dialog}
        {!canWrite && role !== null ? <ReadOnlyNotice /> : null}
        {setup.data ? <SetupWarningBands data={setup.data} configureAllowed={canManageRole(role)} role={role} /> : null}
        <ReservationFormRepairNotices notices={start.progress?.notices} role={role}/>
        {role !== null && (start.summary || start.error || setupRest || setup.error || !canManageRole(role)) ? <FirstStepsCard onRetry={start.reload} summary={start.summary} folded={start.folded} onToggle={start.toggle} readOnly={role === 'viewer'}
          onRecheck={start.watchExpired ? start.rewatch : undefined}
          onConfigure={setupRest ? () => openSetupStep(setupRest.nextStep) : !canManageRole(role) ? () => openSetupStep('style') : undefined} configureAllowed={canManageRole(role)}
          setupTasks={setupRest ? <SetupTasks heading summary={setupRest} onOpenStep={openSetupStep} configureAllowed={canManageRole(role)} role={role} /> : role !== null && !canManageRole(role) ? <SetupTasksUnavailable error={setup.error} onRetry={setup.reload} /> : undefined}
          feedback={<>{start.error ? <FirstStepsFeedback error={start.error} onRetry={start.reload} /> : null}
            {setup.error && canManageRole(role) ? <ListState kind="error" title="使い方の設定を確認できませんでした" error={setup.error} onRetry={setup.reload} /> : null}</>} /> : null}
        {metricSelectionFallback ? <Notice tone="info" action={<Button onClick={reloadPresentation}>表示設定を読み直す</Button>}>保存した表示設定を確認できないため、業種の初期表示にしています。</Notice> : null}
        {today && today.kpis.length === 0 ? null : <KpiBand layout="link-row" maxColumns={5} data-style-dashboard={style}>
          {(today?.kpis ?? []).map((kpi) => <Kpi key={kpi.id} kpi={kpi} onPreparing={openPayment} />)}
        </KpiBand>}
        {alert ? (
          <Notice tone="warn" role="status" heading={alert.title} className={styles.alert}
            action={alert.actions.some((a) => canWrite || a.icon === 'external') ? <div className={styles.alertActions}>{alert.actions.filter((a) => canWrite || a.icon === 'external').map((a) => (
              <Button key={a.id} size="compact" href={a.taskId ? undefined : a.href} external={a.icon === 'external'} busy={busy === a.id} onClick={a.taskId || !a.href ? () => void alertAction(a) : undefined}>{a.icon ? ALERT_ICON[a.icon] : null}{a.label}</Button>
            ))}</div> : undefined}>
            {alert.detail}
          </Notice>
        ) : null}
      </div>
      <div className={styles.tabRow}>
        <Tabs items={tabItems} label={`${cfg.title}のタブ`} size="compact" />
        {tabRowActions}
      </div>
      <div className={styles.content}><CalendarPeriod period={view === 'calendar' && today ? range === 'month' ? date.slice(0, 7) : today.week?.days[0]?.date ?? date : ''} scope={`${accountId}/${style}/${view}/${range}`}>{body}</CalendarPeriod></div>
      {style === 'restaurant' && store.store ? (
        <>
          <PhoneReservationDrawer staffRole={role} storeName={store.store.name} tableDefinition={store.tableDefinition} open={phoneOpen} accountId={store.accountId} storeId={store.store.id} tables={tables} onClose={() => setPhoneOpen(false)}
            onSaved={({ lineFailed }) => { setPhoneOpen(false); notifyToast(lineFailed ? '予約は入れました。LINE の確認は送れていません。' : '予約を入れました。', lineFailed ? { tone: 'error' } : undefined); void reload() }} />
          <WalkInDialog tableDefinition={store.tableDefinition} open={walkInOpen} accountId={store.accountId} storeId={store.store.id} tables={tables} onClose={() => setWalkInOpen(false)}
            onSaved={({ seated }) => { setWalkInOpen(false); notifyToast(seated ? '入店にしました。' : '席は取りました。来店の印は付けられませんでした。表の［来店］を押してください。', seated ? undefined : { tone: 'error' }); void reload() }} />
        </>
      ) : null}
      <SaveErrorScope errors={viewErrors}><ViewDrawer open={viewOpen} layout={layout} industry={style} defaultMetrics={defaultMetrics} busy={busy === 'layout'} onClose={() => setViewOpen(false)}
        onChangeStyle={(next) => { if (!layout) return; setBusy('layout'); void styleApi.save(accountId, { expectedVersion: layout.version, style: next }).then(() => { notifyToast('型を変えました。'); window.location.assign('/') }).catch((e) => { if (!viewErrors.capture(e)) notifyToast(japaneseDetailOf(e) || '型を変えられませんでした。', { tone: 'error' }) }).finally(() => setBusy('')) }}
        onReset={() => { if (!layout) return; setBusy('layout'); void styleApi.resetCards(accountId, layout.version).then((r) => { if (!applyPresentation(r.data, true)) return; setCardDefaults(r.data.cards); notifyToast('型に戻しました。') }).catch((e) => notifyToast(japaneseDetailOf(e) || '型に戻せませんでした。', { tone: 'error' })).finally(() => setBusy('')) }}
        onSave={(next, metricIds) => { if (!layout) return; setBusy('layout'); void styleApi.saveCards(accountId, layout.version, next.map((c) => ({ id: c.id, visible: c.on })), metricIds).then((r) => { if (!applyPresentation(r.data)) return; setViewOpen(false); notifyToast('表示を保存しました。'); void load() }).catch((e) => { if (!viewErrors.capture(e)) notifyToast(japaneseDetailOf(e) || '表示を保存できませんでした。時間をおいて、もう一度お試しください。', { tone: 'error' }) }).finally(() => setBusy('')) }} /></SaveErrorScope>
      <ClosureDialog key={JSON.stringify([accountId, store?.store?.id ?? null])} open={closureOpen} date={date} busy={busy === 'closure'} seatNoun={style === 'restaurant' ? '卓' : style === 'lesson' ? '講師' : '担当者'} accountId={accountId} store={style === 'restaurant' && store.store ? { id: store.store.id, name: store.store.name } : undefined}
        targets={{ staff: style === 'restaurant' ? [] : (today?.staff ?? []), seats: style === 'restaurant' ? (today?.staff ?? []) : [] }}
        affectedNote="その時間の予約は取り消しません。重なる予約への連絡は自動では送られません。"
        onClose={() => setClosureOpen(false)}
        onSave={(input) => saveClosure(input)}
        preview={async (input) => {
          if (style === 'restaurant' && store.store) {
            const res = await restaurantTestApi.previewClosure(accountId, { storeId: store.store.id, startDate: input.date, endDate: input.date, allDay: input.allDay, startTime: input.from ?? null, endTime: input.to ?? null, kind: KIND[input.reason] ?? 'other', memo: input.reason, tableIds: input.target === 'seat' ? input.ids : [] })
            if (!res.data.confirmationSnapshot) throw new Error('confirmation_unavailable')
            return { snapshot: res.data.confirmationSnapshot, rows: res.data.reservations.map((r) => ({ time: formatDate(r.startsAt, { style: 'time' }), name: `${withHonorific(r.customerName, 'さま')}`, sub: `${r.guestCount}名`, pay: null })) }
          }
          const res = await styleApi.closureConfirmation(accountId, { date: input.date, target: input.target === 'store' ? 'store' : 'staff', staffIds: input.target === 'staff' ? input.ids : [], allDay: input.allDay, startTime: input.from, endTime: input.to, reason: input.reason })
          return { snapshot: res.data.snapshot, rows: res.data.reservations.map((r) => ({ time: formatDate(r.startsAt, { style: 'time' }), name: `${withHonorific(r.name, 'さま')}`, sub: `${formatNumber(r.partySize)}名`, pay: null })) }
        }}
        mediaNote={style === 'restaurant' ? '他の予約サイトの同じ時間の枠は、それぞれの管理画面で閉じてください。' : null} />
      {start.arrived && accountId && canManageRole(role) ? <FirstRunDoneDialog accountId={accountId} style={style} minutes={start.firstRun?.minutes ?? null} steps={start.steps} progress={start.progress} onClose={start.dismissArrived} /> : null}
      {preparing.dialog}
      {cancelRow ? (
        <CancelReservationDialog cancellationOnly targetSummary={<OperationTargetSummary accounts={[{ id: accountId }]} store={style === 'restaurant' ? (restaurantStoreReady && store.store && cancelStoreId === store.store.id ? { id: store.store.id, name: store.store.name } : { id: '' }) : undefined} />} open title={`${withHonorific(cancelRow.name, 'さま')}の予約を取り消しますか？`} subtitle={[cancelRow.time, cancelRow.people ? `${formatNumber(cancelRow.people)}名` : null, cancelRow.seat ?? cancelRow.staff, cancelRow.course].filter(Boolean).join('・')}
          facts={[{ label: 'お支払い', value: cancelRow.booking?.price ? `${formatYen(cancelRow.booking.price * (style === 'restaurant' ? cancelRow.booking.partySize : 1))}（支払いの記録は決済の口から）` : 'お支払いなし' }]}
          fullAmount={cancelRow.booking?.price ? cancelRow.booking.price * (style === 'restaurant' ? cancelRow.booking.partySize : 1) : null} testMode={testMode} busy={busy === 'cancel'}
          messageFor={(i) => `${withHonorific(cancelRow.name, 'さま')}　${i.reason ? `${i.reason}で` : 'お店の都合で'} ${cancelRow.time} のご予約を取り消しました。申し訳ありません。${i.refund === 'full' ? 'お支払いは全額を返金します。' : ''}`}
          onClose={() => setCancelRow(null)} onConfirm={(i) => void confirmCancel(cancelRow, i)} />
      ) : null}
      {refundRow ? (
        <Dialog open title="返金について" description={`${withHonorific(refundRow.name, 'さま')}・${refundRow.time}`} onCancel={() => setRefundRow(null)}>
          <p>この画面から返金はできません。</p>
        </Dialog>
      ) : null}
      {classRow ? (
        <Dialog open title="休講について" description={`${classRow.name}・${classRow.time}${classRow.endTime ?? ''}・${classRow.sub ?? ''}`} onCancel={() => setClassRow(null)}>
          <p>この画面から休講にはできません。</p>
          <p>予約の変更や返金、LINE での連絡は行われません。</p>
        </Dialog>
      ) : null}
      {resultRow ? <ResultDialog row={resultRow} busy={busy === 'result'} onClose={() => setResultRow(null)} onSave={(outcome) => void saveResult(resultRow, outcome)} /> : null}
      {wizard.dialog}
      {qrRequested ? <FriendAddLink dialogOnly officialProfileUrl={undefined} canManage={canManageRole(role)} /> : null}
    </DashboardPage>
    </KpiValueMotionProvider>
  )
}

const OUTCOMES = [{ value: 'considering', label: '検討中' }, { value: 'won', label: '成約' }, { value: 'lost', label: '見送り' }] as const

/** 面談の［結果を付ける］の窓。結果は予約ごと。人の段階のタグも口が同じ時に直す。 */
function ResultDialog({ row, busy, onClose, onSave }: { row: StyleRow; busy: boolean; onClose: () => void; onSave: (outcome: 'considering' | 'won' | 'lost') => void }) {
  const [value, setValue] = useState<'considering' | 'won' | 'lost'>('considering')
  return (
    <Dialog open title="結果を付ける" description={`${withHonorific(row.name, 'さま')}・${row.time}${row.endTime ?? ''}・${row.sub ?? ''}`} designWidth={480} busy={busy} confirmLabel="結果を付ける" onCancel={onClose} onConfirm={() => onSave(value)}>
      <RadioCardGroup className={styles.resultChoices} legend="面談の結果">
        {OUTCOMES.map((o) => <Radio key={o.value} name="outcome" checked={value === o.value} onChange={() => setValue(o.value)}>{o.label}</Radio>)}
      </RadioCardGroup>
    </Dialog>
  )
}
