'use client'
import { useAccountStyle } from '@/hooks/use-account-style'
import { usePermissionAccess } from '@/lib/use-feature-access'

/*
 * ★V8 予約台帳（板 `l9NlC0` 今日・`xzCK6` 今日 1152・`Z3FoM` 一覧・ 電話の予約を入れる）。
 *
 * 板の頭に店舗・見方（今日／今週／今月／一覧）・枠を押さえる・電話の予約を入れる。
 * 今日は時間×卓、今週・今月・一覧は予約タイムラインの表。電話の予約は作る型の画面に切り替わる。
 * 口・絞り込み・送る形は今の画面（app/restaurant-test/v8/reservations.tsx）と同じ。動きは BEHAVIOR.md。
 */
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import { useListUrlValue } from '@/components/shared/list-url-state'
import Notice from '@/components/shared/notice'
import { notifyToast } from '@/components/shared/toast'
import { describeApiFailure, isSaveConflict } from '@/components/shared/api-error-message'
import { RowActions } from '@/components/shared/row-actions'
import TextLink from '@/components/shared/text-link'
import { useAccount } from '@/contexts/account-context'
import { restaurantTestApi,type ReservationQuery,type RestaurantClosure,type RestaurantReservation } from '@/lib/restaurant-test-api'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { Lock,Phone } from 'lucide-react'
import { useCallback,useEffect,useMemo,useRef,useState,type ReactNode } from 'react'
import { ReservationDetailDialog } from '@/v8/restaurant-reservations/index'
import { QuietError, RestaurantShell, type RestaurantV8Context } from '@/v8/restaurant/booking-kit/public/shell/index'
import { KIND_LABEL, dayTitle, scopeText } from '@/v8/restaurant/closures/public/format/index'
import { CancelReservationDialog,EditReservationDialog,InboundTrialDialog,type ReservationPatch } from './dialogs'
import { dayRange,monthRange,sameDay,toYmd,weekRange,type LedgerView } from './format'
import ListView,{ PAGE_SIZE } from './list'
import PhoneReservation from './phone'
import styles from './reservations.module.css'
import TodayView,{ type PhonePreset } from './today'
import SeatWaitlistDialog from './waitlist'
import { isReservationInputError } from './edit-save-result'

/** 予約を変えられる役割か（口は owner・admin・staff。閲覧のみは 403）。読めるまでは出す（最後の守りは口の 403）。 */
function canWriteRole(role: string | null | undefined): boolean {
  return canManageRole(role) || role === 'staff'
}

/* 頭の右：見方の切り替え（数はその月を取り直して今日・今週・今月で数える。遅い応答は捨てる）と主ボタン。 */
function HeadControls({ storePicker, view, day, storeId, busy, canWrite, onView, onPhone }: {
  storePicker: ReactNode
  view: LedgerView
  day: Date
  storeId: string
  busy: boolean
  /** 閲覧のみは false。押せないボタンは置かない。 */
  canWrite: boolean
  onView: (view: LedgerView) => void
  onPhone: (preset: PhonePreset) => void
}) {
  const {selectedAccountId}=useAccount()
  const [waitOpen,setWaitOpen]=useState(false)
  useEffect(()=>setWaitOpen(false),[storeId,selectedAccountId])
  return (
    <div className={styles.headControls}>
      {storePicker}

      {/* 絵 l9NlC0（今日）・Z3FoM（一覧）とも頭の右に置く。閲覧のみは押せないボタンを置かない。 */}
      {canWrite ? (
        <span className={styles.headButtons}>
          <RowActions subjectName="予約台帳" menuItems={[{id:"waitlist",label:"キャンセル待ちを見る",disabled:busy||!storeId,onSelect:()=>setWaitOpen(true)}]}/>
          <Button presentation="restaurant" disabled={busy} onClick={() => onPhone({ date: day, hold: true })}><Lock size={16} aria-hidden="true" />枠を押さえる</Button>
          <Button presentation="restaurant" variant="primary" disabled={busy} onClick={() => onPhone({ date: day })}><Phone size={16} aria-hidden="true" />電話の予約を入れる</Button>
        </span>
      ) : null}
      {waitOpen&&selectedAccountId&&canWrite?<SeatWaitlistDialog accountId={selectedAccountId} storeId={storeId} onClose={()=>setWaitOpen(false)}/>:null}
    </div>
  )
}

function LedgerBody({ ctx, view, day, period, status, page, source, phone, onDay, onPeriod, onStatus, onPage, onSource, onPhone,onView, pageSize, onPageSize }: {
  pageSize: number
  onPageSize: (size: number) => void
  onView:(view:LedgerView)=>void
  ctx: RestaurantV8Context
  view: LedgerView
  day: Date
  period: string
  status: string
  page: number
  source: string
  phone: PhonePreset | null
  onDay: (day: Date) => void
  onPeriod: (value: string) => void
  onStatus: (value: string) => void
  onPage: (page: number) => void
  onSource: (value: string) => void
  onPhone: (preset: PhonePreset | null) => void
}) {
  const { data, store, busy, mutate, reload } = ctx
  const { selectedAccountId } = useAccount()
  const role = useStaffRole()
  /* 予約の口は owner・admin・staff に開いている（閲覧のみは 403）。受信データの試し（媒体の受信口）は owner・admin だけ。 */
  const canWrite = canWriteRole(role)
  const canImport = canManageRole(role)
  const accountId = selectedAccountId || ''
  const accountStyle = useAccountStyle(selectedAccountId)
  const canUseAlternateBooking = usePermissionAccess('/booking/bookings')
  const storeId = store?.id || ''
  const tables = useMemo(() => data.tables.filter((t) => !store || t.store_id === store.id), [data.tables, store])
  const menuItems = useMemo(() => data.menuItems.filter((m) => !store || m.store_id === store.id), [data.menuItems, store])
  const [dayError, setDayError] = useState<unknown>(null)
  const [dayRetry, setDayRetry] = useState(0)
  const [todayRows, setTodayRows] = useState<RestaurantReservation[] | null>(null)
  /* その日（今日の見方は選んだ日・ほかの見方は今日）の臨時休業・貸切。日の読み出しの口に入っている。 */
  const [dayClosures, setDayClosures] = useState<{ day: string; closures: RestaurantClosure[] } | null>(null)
  const [editTarget, setEditTarget] = useState<{ id: string; accountId: string; storeId: string; sequence: number } | null>(null)
  const editSequence = useRef(0)
  const editContext = useRef({ target: editTarget, accountId, storeId })
  editContext.current = { target: editTarget, accountId, storeId }
  const setOpenId = useCallback((id: string) => {
    const target = id ? { id, accountId, storeId, sequence: ++editSequence.current } : null
    editContext.current = { target, accountId, storeId }
    setEditTarget(target)
  }, [accountId, storeId])
  const openId = editTarget?.accountId === accountId && editTarget.storeId === storeId ? editTarget.id : ''
  useEffect(() => {
    if (editTarget && (editTarget.accountId !== accountId || editTarget.storeId !== storeId)) setOpenId('')
  }, [accountId, storeId, editTarget, setOpenId])
  const [detailId, setDetailId] = useState('')
  useEffect(()=>{const id=new URLSearchParams(window.location.search).get('id');if(id)setDetailId(id)},[])
  const cancelScope = useRef({ accountId, storeId, generation: 0 })
  if (cancelScope.current.accountId !== accountId || cancelScope.current.storeId !== storeId) {
    cancelScope.current = { accountId, storeId, generation: cancelScope.current.generation + 1 }
  }
  const [cancelTarget, setCancelTarget] = useState<{ id: string; accountId: string; storeId: string; generation: number } | null>(null)
  const cancelGeneration = cancelScope.current.generation
  const setCancelId = (id: string) => {
    if (cancelGeneration !== cancelScope.current.generation) return
    setCancelTarget(id ? { id, ...cancelScope.current } : null)
  }
  const cancelId = cancelTarget?.generation === cancelScope.current.generation ? cancelTarget.id : ''
  const [showImport, setShowImport] = useState(false)
  const [lineWarning, setLineWarning] = useState('')

  useEffect(() => {
    let current = true
    setTodayRows(null)
    setDayError(null)
    setDayClosures(null)
    if (view !== 'today' || !storeId || !accountId) return
    const load = () => restaurantTestApi.reservationsDay(accountId, storeId, toYmd(day))
      .then((res) => {
        if (!current) return
        if (!Array.isArray(res.data?.reservations)) throw new Error('読み込めませんでした')
        setDayError(null)
        setTodayRows(res.data.reservations)
        setDayClosures({ day: toYmd(day), closures: Array.isArray(res.data?.closures) ? res.data.closures : [] })
      })
      .catch((error) => { if (current) setDayError(error) })
    void load()
    const timer = setInterval(() => { void load() }, 30_000)
    return () => { current = false; clearInterval(timer) }
  }, [view, storeId, accountId, day, data.reservations, dayRetry])

  /* 今週・今月・一覧では、今日が休業・貸切かを見る（帯だけ。表はそのまま）。 */
  useEffect(() => {
    let current = true
    if (view === 'today' || !storeId || !accountId) return
    const today = toYmd(new Date())
    void restaurantTestApi.reservationsDay(accountId, storeId, today)
      .then((res) => { if (current) setDayClosures({ day: today, closures: Array.isArray(res.data?.closures) ? res.data.closures : [] }) })
      .catch(() => { if (current) setDayClosures(null) })
    return () => { current = false }
  }, [view, storeId, accountId])

  const rows = useMemo(() => {
    const scoped = store ? data.reservations.filter((r) => r.store_id === store.id) : data.reservations
    if (view === 'today') return todayRows ?? []
    if (view === 'week') {
      const w = weekRange(day)
      return scoped.filter((r) => r.starts_at >= w.from && r.starts_at < w.to)
    }
    return scoped
  }, [data.reservations, store, view, day, todayRows])

  const save = useCallback(async (action: () => Promise<unknown>, success: string, onCommitted?: () => boolean) => {
    const ok = await mutate(action, success, onCommitted ? { onCommitted } : undefined)
    /* 失敗時は取り直す（競合 409 の古い表示で残さない）。 */
    if (!ok) void reload()
    return ok
  }, [mutate, reload])

  const restoreReservation=(id:string)=>{
    const target=rows.find(r=>r.id===id)??data.reservations.find(r=>r.id===id);
    return restaurantTestApi.updateReservation(accountId,id,{status:'confirmed',expectedVersion:target?.customer_version??1});
  }
  const dayOpened = rows.find((r) => r.id === openId)
  const snapshotOpened = data.reservations.find((r) => r.id === openId)
  const currentOpened = dayOpened && snapshotOpened
    ? (dayOpened.customer_version ?? 1) >= (snapshotOpened.customer_version ?? 1) ? dayOpened : snapshotOpened
    : dayOpened ?? snapshotOpened ?? null
  const lastOpened = useRef<{ sequence: number; reservation: RestaurantReservation; seenInDay: boolean } | null>(null)
  if (currentOpened && editTarget && openId) {
    const seenInDay = (lastOpened.current?.sequence === editTarget.sequence && lastOpened.current.seenInDay) || (view === 'today' && !!todayRows?.some((r) => r.id === openId))
    lastOpened.current = { sequence: editTarget.sequence, reservation: currentOpened, seenInDay }
  }
  const previousOpened = openId && editTarget && lastOpened.current?.sequence === editTarget.sequence ? lastOpened.current : null
  const opened = currentOpened ?? previousOpened?.reservation ?? null
  const missing = !!previousOpened && (view === 'today'
    ? todayRows !== null && previousOpened.seenInDay && !todayRows.some((r) => r.id === openId)
    : !currentOpened)
  const detailed = rows.find((r) => r.id === detailId) ?? data.reservations.find((r) => r.id === detailId) ?? null
  const cancelling = rows.find((r) => r.id === cancelId) ?? data.reservations.find((r) => r.id === cancelId) ?? null
  const detailReservation = view === 'today' ? detailed : detailId === 'closed' ? null : detailed ?? rows[0] ?? null
  const attendanceKey = JSON.stringify([accountId, storeId, view, detailId, detailReservation?.id, page, period, status, source, canWrite, !!phone])
  const attendanceScope = useRef({ key: attendanceKey })
  if (attendanceScope.current.key !== attendanceKey) attendanceScope.current = { key: attendanceKey }
  const locationKey = JSON.stringify([accountId, storeId, view, page, period, status, source, canWrite, !!phone])
  const closedDetailId = view === 'today' ? '' : 'closed'
  const attendanceLocation = useRef({ key: locationKey, detailId, token: {} })
  if (attendanceLocation.current.key !== locationKey || attendanceLocation.current.detailId !== detailId) {
    const previous = attendanceLocation.current
    const onlyClosed = previous.key === locationKey && detailId === closedDetailId && previous.detailId !== closedDetailId
    attendanceLocation.current = { key: locationKey, detailId, token: onlyClosed ? previous.token : {} }
  }
  const scope = attendanceScope.current
  const attendanceActive = useRef(true)
  const attendanceWorking = useRef(false)
  useEffect(() => { attendanceActive.current = true; return () => { attendanceActive.current = false } }, [])
  const attendance = async (id: string, action: 'visited' | 'depart' | 'undo_departure' | 'undo_visit' | 'no_show') => {
    const current = () => attendanceActive.current && attendanceScope.current === scope
    const location = attendanceLocation.current
    const closed = () => attendanceActive.current && attendanceLocation.current.token === location.token && attendanceLocation.current.key === locationKey && attendanceLocation.current.detailId === closedDetailId
    const row = rows.find(r => r.id === id) ?? data.reservations.find(r => r.id === id)
    if (!canWrite || busy || attendanceWorking.current || !current() || detailReservation?.id !== id || !row) return
    attendanceWorking.current = true
    let failure: { error: unknown } | undefined
    let savedButUnread = false
    let stampNotice: string | null = null
    const success = action === 'visited' ? '来店にしました。' : action === 'depart' ? '退店にしました。卓が空きました。' : action === 'no_show' ? '無断にしました。' : '来店・退店の記録を訂正しました。'
    try {
      const ok = await mutate(async () => {
        try {
          if (!current()) throw new QuietError()
          const result = await restaurantTestApi.attendance(accountId, id, { action, expectedVersion: row.customer_version ?? 1, requestId: crypto.randomUUID() })
          if (!current() && !closed()) throw new QuietError()
          if (action === 'visited') stampNotice = result.data.stamp.status === 'recorded' ? `来店スタンプ ${result.data.stamp.count} 個を確認しました。` : 'スタンプは会計待ち・停止中・未連携の場合には増えません。'
          return result
        } catch (error) {
          if ((current() || closed()) && !(error instanceof QuietError)) failure = { error }
          throw new QuietError()
        }
      }, success, { onRefreshFailure: () => { if (current() || closed()) savedButUnread = true }, suppressSuccessToast: true })
      if (!ok && current()) void reload()
      if (!ok && closed() && failure) notifyToast(isSaveConflict(failure.error) ? 'ほかの操作で予約が変わりました。読み直してから、もう一度選んでください。' : describeApiFailure(failure.error, '来店・退店の記録'), { tone: 'error' })
      if (ok && closed()) notifyToast([success, stampNotice, savedButUnread ? '最新の予約を読み込めませんでした。読み直してください。' : null].filter(Boolean).join(' '), savedButUnread ? { tone: 'error' } : undefined)
      return current() ? (failure ?? (ok ? { savedButUnread, stampNotice: [success, stampNotice].filter(Boolean).join(' ') } : undefined)) : undefined
    } finally { attendanceWorking.current = false }
  }

  if (phone) {
    return (
      <PhoneReservation accountStyle={accountStyle.stale ? null : accountStyle.data?.style ?? null} staffRole={role} canUseAlternateBooking={canUseAlternateBooking}
        tableDefinition={ctx.tableDefinition}
        storeId={storeId}
        storeName={store?.name || ''}
        tables={tables}
        menuItems={menuItems}
        busy={busy}
        preset={phone}
        onBack={() => onPhone(null)}
        onSave={(body) => save(() => (body.kind === 'hold'
          ? restaurantTestApi.holdReservation(accountId, { storeId, startsAt: String(body.startsAt), endsAt: String(body.endsAt), guestCount: Number(body.guestCount), tableId: (body.tableId as string | null) ?? null, holdMinutes: Number(body.holdMinutes), note: String(body.allergyNote || '電話のお客さま用') })
          : restaurantTestApi.createReservation(accountId, body).then((res) => {
            if (body.notifyLine && !res.data.lineNotice.sent) setLineWarning('予約は保存しました。LINE の確認は送れていません。友だちの連携と送信の状態を確かめてください。')
            return res
          })), body.kind === 'hold' ? '枠を押さえました。期限になると解除します。' : '台帳に入れました。', () => { if (editContext.current.accountId !== accountId || editContext.current.storeId !== storeId) return false; onPhone(null); return true })}
      />
    )
  }

  const total = view === 'list' ? data.reservationTotal : rows.length

  return (
    <>
      {lineWarning ? <Notice tone="warn" role="alert" message={lineWarning} /> : null}
      {dayClosures && dayClosures.closures.length > 0 ? (
        <Notice tone="warn" role="status" data-closure-day={dayClosures.day} action={<>
          <TextLink href="/restaurant-test/inventory?tab=closures">休業日・貸切へ</TextLink>
        </>}>
          <p className={styles.closureText}>
            {`${dayTitle(dayClosures.day)}は${dayClosures.closures.map((c) => `${KIND_LABEL[c.kind]}（${scopeText(c, tables)}）`).join('・')}です。閉じた時間帯は LINE からの予約を受け付けません。入っている予約は取り消していません。`}
          </p>
        </Notice>
      ) : null}
      {view === 'today' ? dayError !== null ? <ListState kind="error" title="予約を読み込めませんでした" error={dayError} onRetry={()=>setDayRetry(n=>n+1)}/> : todayRows === null ? <ListState kind="loading"/> : (
        <TodayView
          onView={onView} onReload={()=>void reload()} storeId={storeId} storeName={store?.name}
          rows={rows}
          later={store ? data.reservations.filter((r) => r.store_id === store.id) : data.reservations}
          tables={tables}
          day={day}
          isToday={sameDay(day, new Date())}
          busy={busy}
          canWrite={canWrite}
          source={source}
          onSource={onSource}
          onDay={onDay}
          onAdd={(preset) => onPhone(preset)}
          onOpen={setOpenId}
          onDetail={id=>{const r=rows.find(r=>r.id===id);if(r?.hold_expires_at)setOpenId(id);else setDetailId(id)}}
        />
      ) : (
        <ListView accountStyle={accountStyle.stale ? null : accountStyle.data?.style ?? null} pageSize={pageSize} onPageSize={(next) => { onPageSize(next); onPage(1) }} selectedId={detailId==='closed'?undefined:(detailed??rows[0])?.id} onEdit={setOpenId} onView={onView} day={day} onDay={onDay} storeId={storeId} storeName={store?.name} detail={<ReservationDetailDialog operationScope={scope} onReload={() => { setDayRetry(n => n + 1); void reload() }} onAttendance={attendance} inline reservation={detailId==='closed'?null:detailed??rows[0]??null} accountId={accountId} tables={tables} courses={menuItems} busy={busy} canWrite={canWrite} onClose={()=>setDetailId('closed')} onEdit={setOpenId} onCancel={setCancelId} onRestore={id=>{void save(()=>restoreReservation(id),'予約を有効に戻しました。')}}/>}
          view={view}
          rows={rows}
          total={total}
          tables={tables}
          page={page}
          period={period}
          status={status}
          busy={busy}
          canWrite={canWrite}
          canImport={canImport}
          onPeriod={onPeriod}
          onStatus={onStatus}
          onPage={onPage}
          onImport={() => setShowImport(true)}
          onCreate={() => onPhone({})}
          onOpen={setDetailId}
          onCancel={setCancelId}
          onRestore={(id) => { void save(() => restoreReservation(id), '予約を有効に戻しました。') }}
        />
      )}
      <ReservationDetailDialog
        operationScope={scope}
        onReload={() => { setDayRetry(n => n + 1); void reload() }}
        onAttendance={attendance}
        reservation={view==='today'?detailed:null}
        accountId={accountId}
        tables={tables}
        courses={menuItems}
        busy={busy}
        canWrite={canWrite}
        onClose={() => setDetailId('')}
        onCancel={(id) => { setDetailId(''); setCancelId(id) }}
        onRestore={(id) => {
          void save(() => restoreReservation(id), '予約を有効に戻しました。').then((ok) => { if (ok) setDetailId('') })
        }}
        onEdit={(id) => { setDetailId(''); setOpenId(id) }}
      />
      <EditReservationDialog
        key={editTarget?.sequence ?? 0}
        reservation={opened}
        missing={missing}
        tables={tables}
        courses={menuItems}
        busy={busy}
        canWrite={canWrite}
        onClose={() => setOpenId('')}
        onSave={async (patch: ReservationPatch) => {
          const target = editTarget
          const current = () => editContext.current.target === target && editContext.current.accountId === accountId && editContext.current.storeId === storeId
          if (!opened || !target || !current()) return { saved: false }
          const saved = await mutate(async () => {
            const result = await restaurantTestApi.updateReservation(accountId, opened.id, patch)
            if (!current()) throw new QuietError()
            return result
          }, '予約を変更しました。', { rethrow: (error) => !current() || isReservationInputError(error) })
          if (!current()) return { saved: false }
          if (saved) setOpenId('')
          else void reload()
          return { saved }
        }}
        onCancelReservation={(id) => { setOpenId(''); setCancelId(id) }}
        onRestore={(id) => {
          void save(() => restoreReservation(id), '予約を有効に戻しました。').then((ok) => { if (ok) setOpenId('') })
        }}
      />
      <CancelReservationDialog
        reservation={cancelling}
        accountId={cancelTarget?.accountId ?? ''}
        busy={busy}
        onClose={() => setCancelId('')}
        onConfirm={(id) => {
          if (!cancelTarget || cancelTarget.id !== id || cancelTarget.generation !== cancelScope.current.generation || cancelTarget.accountId !== cancelScope.current.accountId || cancelTarget.storeId !== cancelScope.current.storeId) return
          return save(() => restaurantTestApi.updateReservation(accountId, id, { status: 'cancelled', expectedVersion: (rows.find(r=>r.id===id)?.customer_version ?? 1) }), cancelling && cancelling.hold_expires_at && cancelling.status === 'pending' ? '押さえを解除しました。' : '予約を取り消しました。').then((ok) => { if (ok) setCancelId('') })
        }}
      />
      <InboundTrialDialog
        open={showImport}
        busy={busy}
        onClose={() => setShowImport(false)}
        onSubmit={(body) => {
          if (!store) return
          void save(() => restaurantTestApi.importReservation(accountId, {
            storeId: store.id, provider: body.provider, eventId: `ui-${Date.now()}`,
            reservation: {
              externalId: body.externalId, customerName: body.customerName, guestCount: body.guestCount, startsAt: body.startsAt,
              endsAt: new Date(new Date(body.startsAt).getTime() + 120 * 60_000).toISOString(),
            },
          }), '受信専用のデータとして取り込みました。').then((ok) => { if (ok) setShowImport(false) })
        }}
      />
    </>
  )
}

const DESCRIPTION: Record<'today' | 'list', string> = {
  today: '予約サイト・LINE・電話の予約を、時間と卓で確認します。',
  list: '予約サイト・LINE・電話の予約を、一つの時間軸で確認します。',
}

/*
 * 見方（今日・今週・今月・一覧）と電話の予約を切り替える。口への絞り込みは器（shell）へ渡す：
 * 今日・今週・今月は月の取り直し、一覧は期間・状態・ページ送り（今と同じ口）。
 * `?view=list|week|month` と `?date=YYYY-MM-DD` と `?source=<予約元>` を受け付ける。
 */
export default function ReservationsPage() {
  const [view, setView] = useState<LedgerView>('today')
  const [day, setDay] = useState<Date>(() => new Date())
  const [period, setPeriod] = useState('upcoming')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useListUrlValue('page', 1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [source, setSource] = useState('all')
  const [phone, setPhone] = useState<PhonePreset | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const v = params.get('view')
    if (v === 'list' || v === 'week' || v === 'month') setView(v)
    const d = params.get('date')
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      setDay(new Date(`${d}T00:00:00+09:00`))
    }
    const s = params.get('source')
    if (s) setSource(s)
  }, [])

  const query = useMemo<ReservationQuery>(() => {
    if (view === 'list') {
      const today = dayRange(new Date())
      const range = period === 'past'
        ? { from: undefined, to: today.from }
        : period === 'upcoming'
          ? { from: today.from, to: undefined }
          : { from: undefined, to: undefined }
      return { ...range, status: status === 'all' ? undefined : status, limit: pageSize, offset: (page - 1) * pageSize }
    }
    const m = monthRange(day)
    return { from: m.from, to: m.to, limit: 500, offset: 0 }
  }, [view, day, period, status, page, pageSize])

  const changeView = (next: LedgerView) => { setView(next); setPage(1) }
  const canWrite = canWriteRole(useStaffRole())

  if (phone) {
    return (
      <RestaurantShell boardId="rm92Y" title="電話の予約を入れる" description="" bare query={query}>
        {(ctx) => (
          <LedgerBody onView={changeView}
            ctx={ctx} view={view} day={day} period={period} status={status} page={page} source={source} phone={phone}
            onDay={setDay} onPeriod={setPeriod} onStatus={setStatus} onPage={setPage} pageSize={pageSize} onPageSize={setPageSize} onSource={setSource} onPhone={setPhone}
          />
        )}
      </RestaurantShell>
    )
  }

  return (
    <RestaurantShell
      templateHeading boundary={false}
      boardId={view === 'today' ? 'l9NlC0' : 'Z3FoM'}
      title="予約台帳"
      description={ctx=>`${ctx?.store?.name??''}・${view==='today'?dayTitle(toYmd(day)):'今後の予約'}`}
      query={query}
      layout={view === 'today' ? 'ledgerTight' : 'ledger'}
      headAfter={(ctx, storePicker) => (
        <HeadControls
          storePicker={storePicker}
          view={view}
          day={day}
          storeId={ctx?.selectedStoreId ?? ''}
          busy={!ctx || ctx.busy}
          canWrite={canWrite}
          onView={changeView}
          onPhone={setPhone}
        />
      )}
    >
      {(ctx) => (
        <LedgerBody onView={changeView}
          ctx={ctx} view={view} day={day} period={period} status={status} page={page} pageSize={pageSize} onPageSize={setPageSize} source={source} phone={null}
          onDay={setDay}
          onPeriod={(value) => { setPeriod(value); setPage(1) }}
          onStatus={(value) => { setStatus(value); setPage(1) }}
          onPage={setPage}
          onSource={setSource}
          onPhone={setPhone}
        />
      )}
    </RestaurantShell>
  )
}
