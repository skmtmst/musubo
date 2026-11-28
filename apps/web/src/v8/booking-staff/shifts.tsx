'use client'
import TextLink from '@/components/shared/text-link'
import { isForbiddenOrRateLimited,permissionDeniedMessage } from '@/components/shared/api-error-message'
import Button from '@/components/shared/button'
import Card,{ CardHeader } from '@/components/shared/card'
import Checkbox from '@/components/shared/checkbox'
import Toggle from '@/components/shared/toggle'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import DateField from '@/components/shared/date-field'
import { TimeField } from '@/components/shared/date-time-field'
import { emptyValue } from '@/components/shared/empty-value'
import EntitySelect,{ entityOptionMetadata } from '@/components/shared/entity-select'
import { Field } from '@/components/shared/form-controls'
import IconButton from '@/components/shared/icon-button'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import NumberInput from '@/components/shared/number-field'
import { useSaveConflict } from '@/components/shared/save-conflict'
import { SaveErrorField,SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors'
import Select from '@/components/shared/select'
import { SettingsFormRow } from '@/components/shared/settings-form-card'
import StatusBadge from '@/components/shared/status-badge'
import { TextField } from '@/components/shared/text-field'
import { usePageCrumbs,usePageTitle } from '@/components/shell/page-chrome'
import { CreatePage } from '@/components/templates/create-page'
import { PageHeading } from '@/components/templates/page-frame'
import PreviewLauncher from '@/components/templates/preview-launcher'
import { useAccount } from '@/contexts/account-context'
import { ApiError,bookingApi,type BookingAvailabilitySlot,type BookingException,type BookingMenu,type BookingShift,type BookingStaff } from '@/lib/api'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { formatDate as polishFormatDate } from '@/lib/format'
import { jstDate } from '@/lib/jst-datetime'
import { canViewFeature } from '@/lib/staff-capability'
import { useStaffRole } from '@/lib/staff-role'
import { usePermissionAccess } from '@/lib/use-feature-access'
import { useSamePageUrl } from '@/lib/use-same-page-url'
import { CalendarPlus,Plus,Smartphone,Trash2,UserX } from 'lucide-react'
import { useCallback,useEffect,useMemo,useRef,useState,type ReactNode } from 'react'
import { bookingChannelsApi } from '@/v8/booking-menus/public/lib-booking-channels/index'
import layout from './layout.module.css'
import { PhoneDatetimeStep } from './phone'
import styles from './shifts.module.css'

/*
 * ★V8「勤務とシフト」（板 ・管理者）・「自分の勤務」（板 ・スタッフ本人）・
 * 「ひも付けなし」（板 ）。入口は app/booking/staff/shifts/page.tsx。
 *
 * 白い板1枚：頭（管理者は「← 担当スタッフへ」・題・説明）→ 中身
 * （左＝担当者の切り替え／ひも付けの帯・いつもの勤務時間・休憩・この日だけ・
 * 何週分かのシフト・Google カレンダー、右＝LIFF の日時選択の見本）。
 *
 * 役割はサーバー（/api/staff/me）から読む。確認中と読めないときは操作を隠す。
 * 動き（読み込み・保存・版の競合・権限・失敗時の扱い）は今までの
 * app/booking/staff/shifts/staff-detail-v8.tsx から写した。BEHAVIOR.md を参照。
 */

type LoadStatus = 'loading' | 'ready' | 'error'

/** 月曜はじまり。weekday は 0=日〜6=土（API と同じ）。 */
const STAFF_DAYS = [
  { weekday: 1, label: '月曜日', short: '月' },
  { weekday: 2, label: '火曜日', short: '火' },
  { weekday: 3, label: '水曜日', short: '水' },
  { weekday: 4, label: '木曜日', short: '木' },
  { weekday: 5, label: '金曜日', short: '金' },
  { weekday: 6, label: '土曜日', short: '土' },
  { weekday: 0, label: '日曜日', short: '日' },
] as const
const WEEKDAY_JP = '日月火水木金土'
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * 役割（サーバーの /api/staff/me）。確認中は null。
 * 確認中と読めなかったときは変更操作を隠す。
 */
export const useServerStaffRole = useStaffRole

/** 店舗の時間帯での「今日」(YYYY-MM-DD)。枠の範囲決めだけに使う。 */
function todayKey(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
    return `${get('year')}-${get('month')}-${get('day')}`
  } catch {
    return jstDate()
  }
}

function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

/** `10/12（月）` の形。 */
export function shortDay(date: string): string {
  return polishFormatDate(date, { style: 'list-day-weekday', fallback: '—' })
}

/** `10/2 18:40` の形（日本時間）。 */
function shortStamp(value: string): string {
  return polishFormatDate(value, { style: 'list', fallback: '—' })
}

/** 休憩の曜日のまとまりを短い言葉にする（月〜金・土・日・毎日・月・水）。 */
export function weekdaySetLabel(weekdays: number[]): string {
  const order = STAFF_DAYS.map((d) => d.weekday)
  const idx = [...new Set(weekdays)].map((w) => order.indexOf(w as typeof order[number])).filter((i) => i >= 0).sort((a, b) => a - b)
  if (idx.length === 0) return '曜日なし'
  if (idx.length === 7) return '毎日'
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1)
  const name = (i: number) => STAFF_DAYS[i].short
  if (contiguous && idx.length >= 3) return `${name(idx[0])}〜${name(idx[idx.length - 1])}`
  return idx.map(name).join('・')
}

function staffErrorMessage(error: unknown, action: string): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return permissionDeniedMessage('store')
    if (error.status === 404) return '担当者が見つかりませんでした。削除された可能性があります。一覧に戻って選び直してください。'
    if (error.status === 409) return 'ほかの変更と重なりました。入力はそのまま残しています。最新を読み込むと、編集中の入力を最新の内容に置き換えます。'
  }
  return `担当者の設定を${action}できませんでした。入力はそのまま残しています。通信状態を確認して、もう一度お試しください。`
}

type RuleDraft = { active: boolean; start: string; end: string }
const EMPTY_RULE_DRAFT: RuleDraft = { active: false, start: '09:00', end: '19:00' }

/** 休憩の1行＝同じ時間の曜日のまとまり。保存のときに曜日ごとへ広げる。 */
type BreakGroup = { key: string; weekdays: number[]; ids: Record<number, string>; start: string; end: string }

export function groupBreaks(rows: Array<{ id: string; weekday: number; start_time: string; end_time: string }>): BreakGroup[] {
  const order = STAFF_DAYS.map((d) => d.weekday) as number[]
  const groups: BreakGroup[] = []
  for (const row of [...rows].sort((a, b) => order.indexOf(a.weekday) - order.indexOf(b.weekday))) {
    const group = groups.find((g) => g.start === row.start_time && g.end === row.end_time && !g.weekdays.includes(row.weekday))
    if (group) {
      group.weekdays.push(row.weekday)
      group.ids[row.weekday] = row.id
    } else {
      groups.push({ key: row.id, weekdays: [row.weekday], ids: { [row.weekday]: row.id }, start: row.start_time, end: row.end_time })
    }
  }
  return groups
}

type DayAddKind = 'closed' | 'shift' | 'break'

/** 「この日だけ」の行（休みの例外日・この日のシフト・この日の休憩を1列にまとめる）。 */
type DayRow =
  | { kind: 'exception'; date: string; item: BookingException }
  | { kind: 'shift'; date: string; item: BookingShift }
  | { kind: 'break'; date: string; item: { key: string; id: string | null; start: string; end: string } }

function exceptionBadge(item: BookingException): string {
  if (item.kind === 'closed') return '休み'
  const first = item.intervals[0]
  return first ? `${first.start}〜${first.end}` : '時間を変更する'
}

/* ───────────── 入口 ───────────── */

/**
 * /booking/staff/shifts の ★V8。
 * staff_id があれば担当者の勤務。無ければ、本人（staff）は自分の勤務へ、
 * 管理者は予約設定の「受付枠」タブ（店のいつもの時間）へ送る。
 */
export default function StaffShiftsV8({ staffId }: { staffId: string }) {
  const role = useServerStaffRole()
  // 本人は左メニューの「自分の勤務」から来るので、上の帯の画面名もそれにそろえる。
  /*
   * 管理者がほかの人の勤務を開いたときは、上の帯のパンくずの「予約設定」で担当スタッフへ戻る
   * （板の頭の「← 担当スタッフへ」は 2026-10-08 に無くした）。題は板の題と同じ「勤務とシフト」。
   */
  usePageTitle(role === 'staff' ? '自分の勤務' : staffId ? '勤務とシフト' : '予約設定')
  usePageCrumbs(role !== null && role !== 'staff' && staffId ? [{ label: '予約設定', href: '/booking/menus?tab=staff' }] : null)
  if (role === null) return <PageState node={staffId ? 'd5fmnM' : 'wvGke'} self={false} title="読み込み中" desc="勤務とシフトを読み込んでいます。" />
  const isSelf = role === 'staff'
  if (staffId) return <StaffShiftsDetail staffId={staffId} isSelf={isSelf} />
  if (isSelf) return <OwnShiftEntry />
  return <StoreHoursRedirect />
}

function StoreHoursRedirect() {
  const router = useRouter()
  useEffect(() => { router.replace('/booking/menus?tab=hours') }, [router])
  return null
}

function Head({ self, title }: { self: boolean; title?: string }) {
  return (
    <PageHeading title={title ?? (self ? '自分の勤務' : '勤務とシフト')}
        help={<>{self
        ? 'あなたの出勤・休憩・この日だけのシフトと、Google カレンダーのつながりを決めます。ほかの人の勤務は管理者だけが開けます。'
        : '担当スタッフの出勤・休憩・この日だけのシフトと、Google カレンダーのつながりを決めます。'}</>} />
  )
}

/** 読み込み中・失敗・見つからないの1枚（板の中の白いカード）。 */
function PageState({ node, self, title, desc, icon, actions, head }: {
  node: string
  self: boolean
  title: string
  desc: string
  icon?: ReactNode
  actions?: ReactNode
  head?: ReactNode
}) {
  return (
    <div className={layout.shell} data-design-node={node}>
      {head ?? <Head self={self} />}
      <div className={styles.stateBody}>
        {/* 絵 wvGke：案内は白いカードの中（空の表示は自分で枠を持たないので、カードで包む）。 */}
        {title.includes('読み込み') || title.includes('できませんでした')
          ? <ListState kind={title.includes('読み込み') ? 'loading' : 'error'} title={title} description={desc} icon={icon} action={actions} />
          : <Card><ListState kind="empty" title={title} description={desc} icon={icon} action={actions} /></Card>}
      </div>
    </div>
  )
}

/* ───────────── 自分の勤務の入口 ───────────── */

/**
 * 本人が staff_id なしで来たとき、ひも付く予約スタッフを /staff/me で探して本人の勤務へ送る。
 * ひも付けが無ければ板  の案内。R579：2経路とも通信失敗なら「無い」と言わず再試行の口。
 */
function OwnShiftEntry() {
  const role = useStaffRole()
  const samePageUrl = useSamePageUrl()
  const { selectedAccountId } = useAccount()
  const [resolved, setResolved] = useState<'loading' | 'missing' | 'error'>('loading')
  const [loadError, setLoadError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      let firstError: unknown = null
      const scoped = selectedAccountId
        ? await bookingApi.listMyStaff(selectedAccountId).catch((error: unknown) => {
          firstError = error
          return null
        })
        : null
      const rows = scoped?.staff?.length
        ? scoped.staff
        : await bookingApi.listMyStaff().catch((error: unknown) => {
          if (!scoped) firstError = error
          return null
        }).then((res) => res?.staff ?? [])
      if (cancelled) return
      if (rows.length > 0) {
        samePageUrl.replace(`/booking/staff/shifts?staff_id=${rows[0].id}`)
        return
      }
      if (firstError !== null) {
        setLoadError(firstError)
        setResolved('error')
        return
      }
      setResolved('missing')
    })()
    return () => { cancelled = true }
  }, [samePageUrl, selectedAccountId, attempt])

  const head = (
    <PageHeading title={<>自分の勤務</>}
        help={<>あなたの出勤・休憩・この日だけのシフトを決めます。</>} />
  )

  if (resolved === 'error') {
    return (
      <div className={layout.shell} data-design-node="wvGke">
        {head}
        <div className={styles.stateBody}>
          <ListState
            kind="error"
            title="自分の勤務を読み込めませんでした"
            description={isForbiddenOrRateLimited(loadError) ? undefined : '通信の不具合などで担当者の情報を読み込めませんでした。紐づけが無いとは限りません。「もう一度読み込む」を押してください。'}
            error={loadError ?? undefined}
            onRetry={() => {
              setLoadError(null)
              setResolved('loading')
              setAttempt((value) => value + 1)
            }}
          />
        </div>
      </div>
    )
  }
  if (resolved === 'missing') {
    // 店の受付枠を見られる人には、今までの「受付枠へ自動で移る」の代わりに入口を出す。
    const canSeeStore = canViewFeature('/booking/bookings', role) || canViewFeature('booking.settings', role) || canViewFeature('/booking/menus', role)
    return (
      <PageState
        node="wvGke"
        self
        head={head}
        icon={<UserX className={styles.stateIcon} aria-hidden="true" />}
        title="ひも付いた予約スタッフがありません"
        desc="管理者が予約スタッフとログインユーザーをひも付けると、ここで自分の勤務を決められます。"
        actions={<>
          <Button href="/booking/bookings">予約の一覧へ戻る</Button>
          {canSeeStore ? <TextLink inline href="/booking/menus?tab=hours">店の受付枠を見る</TextLink> : null}
        </>}
      />
    )
  }
  return <PageState node="wvGke" self head={head} title="読み込み中" desc="自分の勤務を探しています。" />
}

/* ───────────── 勤務とシフト（・） ───────────── */

function StaffShiftsDetail({ staffId, isSelf }: { staffId: string; isSelf: boolean }) {
  const saveErrors = useSaveFormErrors()

  const router = useRouter()
  const { selectedAccountId, selectedAccount } = useAccount()
  const [staffList, setStaffList] = useState<BookingStaff[]>([])
  const [staffMissing, setStaffMissing] = useState(false)
  const [ownStaffId, setOwnStaffId] = useState<string | null>(null)
  // N-411 本人勤務：変える権限が無い人は入力を止め、押せないボタンは置かない。
  const canEdit = usePermissionAccess('booking.staff.own')
  // 「この日だけの休み」は例外日の口（booking.settings 権限）。権限が無い人には選ばせない。
  const canEditExceptions = usePermissionAccess('booking.settings')
  const [timeZone, setTimeZone] = useState('Asia/Tokyo')
  const [storeExceptions, setStoreExceptions] = useState<Array<{ dateFrom: string; dateTo: string; kind: string }>>([])
  const [staffExceptions, setStaffExceptions] = useState<BookingException[]>([])
  const [closedWeekdays, setClosedWeekdays] = useState<number[]>([])
  const [menuId, setMenuId] = useState<string | null>(null)
  const [previewMenu, setPreviewMenu] = useState<BookingMenu | null>(null)
  const [hasActiveMenu, setHasActiveMenu] = useState(true)
  const [rules, setRules] = useState<Record<number, { start: string; end: string }>>({})
  const [draft, setDraft] = useState<Record<number, RuleDraft>>({})
  const [shifts, setShifts] = useState<BookingShift[]>([])
  const [shiftRows, setShiftRows] = useState<Record<string, { start: string; end: string }>>({})
  const [calendarId, setCalendarId] = useState<string | null>(null)
  const [calendarVerifiedAt, setCalendarVerifiedAt] = useState<string | null>(null)
  const [calendarError, setCalendarError] = useState<string | null>(null)
  const [externalEvents, setExternalEvents] = useState<number | null>(null)
  const [serviceConfigured, setServiceConfigured] = useState(true)
  const [slots, setSlots] = useState<BookingAvailabilitySlot[]>([])
  // 予約枠の返事に入っている休みの日（お店・担当が閉めている日）。
  const [slotClosedDates, setSlotClosedDates] = useState<string[]>([])
  const [previewError, setPreviewError] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading')
  const [reloadKey, setReloadKey] = useState(0)
  const [ruleError, setRuleError] = useState<string | null>(null)
  /*
   * 保存で落ちた時刻の欄。囲みの理由の文に加えて、その行の時刻の欄を赤くし、終わりの欄へ移る。
   * 欄は aria-label（「月曜の終わり」など）で見分ける。直したら消える。
   */
  const [badTimes, setBadTimes] = useState<string[]>([])
  const markBadTimes = (labels: string[]) => {
    setBadTimes(labels)
    const target = labels[labels.length - 1]
    requestAnimationFrame(() => {
      const el = Array.from(document.querySelectorAll<HTMLElement>('[aria-label]')).find((node) => node.getAttribute('aria-label') === target)
      el?.scrollIntoView?.({ block: 'center' })
      el?.focus({ preventScroll: true })
    })
  }
  const [savingRules, setSavingRules] = useState(false)
  const [rulesSavedAt, setRulesSavedAt] = useState<string | null>(null)
  const [breakGroups, setBreakGroups] = useState<BreakGroup[]>([])
  const [breaksVersion, setBreaksVersion] = useState('')
  const [breakError, setBreakError] = useState<string | null>(null)
  const conflictContext = JSON.stringify([selectedAccountId, staffId])
  const breakSaveConflict = useSaveConflict({
    contextKey: conflictContext,
    fetchLatest: () => selectedAccountId ? bookingApi.getBreaks(selectedAccountId, staffId) : Promise.resolve(null),
    reload: () => reloadBreaks('weekly'),
  })
  const dateSaveConflict = useSaveConflict({
    contextKey: conflictContext,
    fetchLatest: () => selectedAccountId ? bookingApi.getBreakDates(selectedAccountId, staffId) : Promise.resolve(null),
    reload: () => reloadBreaks('dated'),
  })
  const [savingBreaks, setSavingBreaks] = useState(false)
  const [breaksSavedAt, setBreaksSavedAt] = useState<string | null>(null)
  const [openDaysFor, setOpenDaysFor] = useState<string | null>(null)
  const [dateRows, setDateRows] = useState<Array<{ key: string; id: string | null; date: string; start: string; end: string }>>([])
  const [breakDatesVersion, setBreakDatesVersion] = useState('')
  const [shiftError, setShiftError] = useState<string | null>(null)
  const [savingShift, setSavingShift] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<DayRow | null>(null)
  const removeContext = JSON.stringify([selectedAccountId, staffId])
  const [removeTargetContext, setRemoveTargetContext] = useState('')
  useEffect(() => { setRemoveTarget(null); setRemoveTargetContext('') }, [removeContext])
  const [deleting, setDeleting] = useState(false)
  const [genFrom, setGenFrom] = useState('')
  const [genWeeks, setGenWeeks] = useState('4')
  const [genError, setGenError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generatedCount, setGeneratedCount] = useState<number | null>(null)
  const [calendarInput, setCalendarInput] = useState('')
  const [calendarFormError, setCalendarFormError] = useState<string | null>(null)
  const [savingCalendar, setSavingCalendar] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false); const [disconnectContext, setDisconnectContext] = useState('')
  const [dayAddOpen, setDayAddOpen] = useState(false)
  const [dayAddKind, setDayAddKind] = useState<DayAddKind>('shift')
  const [dayAddDate, setDayAddDate] = useState('')
  const [dayAddStart, setDayAddStart] = useState('09:00')
  const [dayAddEnd, setDayAddEnd] = useState('19:00')
  const [dayAddMemo, setDayAddMemo] = useState('')
  const [dayAddBusy, setDayAddBusy] = useState(false)
  const [editingDayRow, setEditingDayRow] = useState<string | null>(null)
  const requestRef = useRef(0)

  const staff = useMemo(() => staffList.find((item) => item.id === staffId) ?? null, [staffList, staffId])

  const loadAvailability = useCallback(async (accountId: string, activeMenuId: string, zone: string, requestId: number) => {
    const from = todayKey(zone)
    setPreviewLoading(true)
    setPreviewError(false)
    try {
      const availability = await bookingApi.getAvailability(accountId, { menuId: activeMenuId, staffId, from, to: addDays(from, 13) })
      if (requestId !== requestRef.current) return
      // 担当者を指定して読むので、返事の中のこの担当者の枠だけを使う（無ければ全部）。
      const own = availability.by_staff.filter((item) => item.staff_id === staffId)
      setSlots((own.length > 0 ? own : availability.by_staff).flatMap((item) => item.slots))
      setSlotClosedDates(availability.closed_dates ?? [])
      setPreviewError(false)
    } catch (saveFailure) {
      if (requestId !== requestRef.current) return
      const fieldFailure = saveErrors.capture(saveFailure)
      setSlots([])
      { if (!fieldFailure) setPreviewError(true) }
    } finally {
      if (requestId === requestRef.current) setPreviewLoading(false)
    }
  }, [staffId, saveErrors])

  const applyRules = (list: Array<{ weekday: number; start_time: string; end_time: string }>) => {
    const savedRules: Record<number, { start: string; end: string }> = {}
    const nextDraft: Record<number, RuleDraft> = {}
    for (const day of STAFF_DAYS) {
      const rule = list.find((item) => item.weekday === day.weekday)
      if (rule) {
        savedRules[day.weekday] = { start: rule.start_time, end: rule.end_time }
        nextDraft[day.weekday] = { active: true, start: rule.start_time, end: rule.end_time }
      } else {
        nextDraft[day.weekday] = { ...EMPTY_RULE_DRAFT }
      }
    }
    setRules(savedRules)
    setDraft(nextDraft)
  }

  const applyShifts = (list: BookingShift[]) => {
    setShifts(list)
    const rows: Record<string, { start: string; end: string }> = {}
    for (const shift of list) rows[shift.id] = { start: shift.start_time, end: shift.end_time }
    setShiftRows(rows)
  }

  const load = useCallback(async () => {
    const requestId = ++requestRef.current
    setDisconnecting(false)
    setSavingRules(false); setSavingBreaks(false); setSavingShift(false)
    setConfirmDisconnect(false)
    if (!selectedAccountId) {
      setStaffList([])
      setLoadStatus('ready')
      return
    }
    setLoadStatus('loading')
    breakSaveConflict.clear()
    dateSaveConflict.clear()
    setStaffMissing(false)
    setPreviewError(false)
    setRuleError(null)
    setShiftError(null)
    try {
      const [staffRes, settingsRes, menuRes, exceptionsRes] = await Promise.all([
        // 本人は自分の予約スタッフだけを /staff/me から解決する（一覧口は予約一覧の権限が要る）。
        isSelf ? bookingApi.listMyStaff(selectedAccountId) : bookingApi.listStaff(selectedAccountId),
        bookingApi.getSettings(selectedAccountId).catch(() => null),
        bookingApi.listMenus(selectedAccountId).catch(() => null),
        bookingApi.listExceptions(selectedAccountId).catch(() => null),
      ])
      if (requestId !== requestRef.current) return
      // 管理者は設定の取得失敗を失敗として扱う。本人は設定を読めなくても自分の勤務は見られる。
      if (!isSelf && (!settingsRes || !settingsRes.success)) {
        throw new Error(settingsRes?.success === false ? settingsRes.error : 'settings_load_failed')
      }
      const found = staffRes.staff.find((item) => item.id === staffId) ?? null
      if (!found) {
        setStaffList(staffRes.staff)
        if (isSelf && staffRes.staff.length > 0) setOwnStaffId(staffRes.staff[0].id)
        setStaffMissing(true)
        setLoadStatus('ready')
        return
      }
      const zone = settingsRes?.success ? (settingsRes.data.timeZone || 'Asia/Tokyo') : 'Asia/Tokyo'
      const activeMenu = menuRes?.menus.find((item) => item.is_active) ?? null
      setStaffList(staffRes.staff)
      setTimeZone(zone)
      const allExceptions = settingsRes?.success ? settingsRes.data.exceptions ?? [] : []
      setStoreExceptions(allExceptions
        .filter((item) => !item.scopeKind || item.scopeKind === 'store')
        .map((item) => ({ dateFrom: item.dateFrom || item.date || '', dateTo: item.dateTo || item.date || '', kind: item.kind })))
      setStaffExceptions((exceptionsRes?.data?.items ?? []).filter((item) => item.scopeKind === 'staff' && item.scopeId === staffId))
      setClosedWeekdays(settingsRes?.success && settingsRes.data.businessHoursConfigured
        ? STAFF_DAYS.filter(({ weekday }) => (settingsRes.data.businessHours.find((day) => day.weekday === weekday)?.intervals.length ?? 0) === 0).map(({ weekday }) => weekday)
        : [])
      setMenuId(activeMenu ? activeMenu.id : null)
      setPreviewMenu(activeMenu)
      setHasActiveMenu(activeMenu !== null)
      setGenFrom((current) => current || todayKey(zone))
      const [rulesRes, shiftsRes, breaksRes, breakDatesRes, calendarRes] = await Promise.all([
        bookingApi.getAvailabilityRules(selectedAccountId, staffId),
        bookingApi.getShifts(selectedAccountId, staffId),
        bookingApi.getBreaks(selectedAccountId, staffId),
        bookingApi.getBreakDates(selectedAccountId, staffId),
        bookingApi.getGoogleCalendar(selectedAccountId, staffId),
      ])
      if (requestId !== requestRef.current) return
      applyRules(rulesRes.rules)
      setRulesSavedAt(null)
      setBreakGroups(groupBreaks(breaksRes.breaks))
      setBreaksVersion(breaksRes.version)
      setBreaksSavedAt(null)
      setBreakError(null)
      setDateRows(breakDatesRes.breaks.map((item) => ({ key: item.id, id: item.id, date: item.work_date, start: item.start_time, end: item.end_time })))
      setBreakDatesVersion(breakDatesRes.version)
      applyShifts(shiftsRes.shifts)
      setGeneratedCount(null)
      setCalendarId(calendarRes.connection?.calendar_id ?? null)
      setCalendarVerifiedAt(calendarRes.connection?.last_verified_at ?? null)
      setCalendarError(calendarRes.connection?.last_error ?? null)
      // 今週の外の予定の件数（予約設定の予約経路の表と同じ受け口）。読めなくても画面は出す。
      void Promise.resolve().then(() => bookingChannelsApi.channels(selectedAccountId)).then((res) => {
        if (requestId !== requestRef.current) return
        setExternalEvents(res.success ? (res.data.staff.find((person) => person.staffId === staffId)?.externalEventsThisWeek ?? null) : null)
      }).catch(() => { if (requestId === requestRef.current) setExternalEvents(null) })
      setServiceConfigured(calendarRes.service_account.configured)
      setCalendarInput('')
      setCalendarFormError(null)
      setLoadStatus('ready')
      if (activeMenu) await loadAvailability(selectedAccountId, activeMenu.id, zone, requestId)
      else setSlots([])
    } catch (error) {
      if (requestId !== requestRef.current) return
      saveErrors.capture(error);

      if (error instanceof ApiError && error.status === 404) {
        setStaffMissing(true)
        setLoadStatus('ready');

        return
      }
      setLoadStatus('error')
    }
  }, [selectedAccountId, staffId, isSelf, loadAvailability, saveErrors])

  useEffect(() => {
    void load()
    return () => { requestRef.current += 1 }
  }, [load, reloadKey])

  /** 保存した欄だけ読み直す。他の欄の編集中の値は残す。 */
  async function refreshAfterSave(section: 'rules' | 'days') {
    if (!selectedAccountId) return
    const requestId = requestRef.current
    try {
      if (section === 'rules') {
        const result = await bookingApi.getAvailabilityRules(selectedAccountId, staffId)
        if (requestId !== requestRef.current) return
        applyRules(result.rules)
      } else {
        const [shiftsRes, exceptionsRes] = await Promise.all([
          bookingApi.getShifts(selectedAccountId, staffId),
          bookingApi.listExceptions(selectedAccountId),
        ])
        if (requestId !== requestRef.current) return
        applyShifts(shiftsRes.shifts)
        setStaffExceptions(exceptionsRes.data.items.filter((item) => item.scopeKind === 'staff' && item.scopeId === staffId))
      }
      if (menuId) await loadAvailability(selectedAccountId, menuId, timeZone, requestId)
    } catch (saveFailure) {
      if (requestId !== requestRef.current) return
      const fieldFailure = saveErrors.capture(saveFailure)
      { if (!fieldFailure) setPreviewError(true) }
    }
  }

  function updateDraft(weekday: number, patch: Partial<RuleDraft>) {
    setDraft((current) => ({ ...current, [weekday]: { ...EMPTY_RULE_DRAFT, ...current[weekday], ...patch } }))
  }

  function validRange(start: string, end: string): boolean {
    return HHMM.test(start) && HHMM.test(end) && start < end
  }

  async function saveRules() {
    const saveGeneration = requestRef.current
    if (!selectedAccountId) return
    const payload: Array<{ weekday: number; start_time: string; end_time: string }> = []
    for (const day of STAFF_DAYS) {
      const row = draft[day.weekday] ?? EMPTY_RULE_DRAFT
      if (!row.active) continue
      if (!validRange(row.start, row.end)) {
        setRuleError(`${day.label}の時間を正しく入れてください（終わりは始まりより後にします）。入力はそのまま残しています。`)
        markBadTimes([`${day.label}の始まり`, `${day.label}の終わり`])
        return
      }
      payload.push({ weekday: day.weekday, start_time: row.start, end_time: row.end })
    }
    setSavingRules(true)
    setRuleError(null)
    try {
      // 週全体を置き換えるので、古い曜日が残らない。
      await bookingApi.putAvailabilityRules(selectedAccountId, staffId, payload)
      if (saveGeneration !== requestRef.current) return
      setRulesSavedAt(new Date().toISOString())
      await refreshAfterSave('rules')
      if (saveGeneration !== requestRef.current) return
    } catch (error) {
      if (saveGeneration !== requestRef.current) return
      const fieldFailure = saveErrors.capture(error)
      { if (!fieldFailure)
      setRuleError(staffErrorMessage(error, '保存')) }
    } finally {
      if (saveGeneration !== requestRef.current)

 return
      setSavingRules(false)
    }
  }

  function updateBreakGroup(key: string, patch: Partial<Pick<BreakGroup, 'weekdays' | 'start' | 'end'>>) {
    setBreakGroups((current) => current.map((group) => (group.key === key ? { ...group, ...patch } : group)))
  }

  /** 「休憩を足す」は1行増えるだけ（下書き）。「保存」でまとめて確定する。 */
  function addBreakGroup() {
    setBreakError(null)
    const key = `new-${Date.now()}`
    setBreakGroups((current) => [...current, { key, weekdays: [1, 2, 3, 4, 5], ids: {}, start: '12:00', end: '13:00' }])
    setOpenDaysFor(key)
  }

  async function saveBreaks() {
    const saveGeneration = requestRef.current
    if (!selectedAccountId) return
    for (const group of breakGroups) {
      if (group.weekdays.length === 0) {
        setBreakError('休憩の曜日を1つ以上選んでください。入力はそのまま残しています。')
        return
      }
      if (!validRange(group.start, group.end)) {
        setBreakError(`${weekdaySetLabel(group.weekdays)}の時間を正しく入れてください（終わりは始まりより後にします）。入力はそのまま残しています。`)
        markBadTimes(['休憩の始まり', '休憩の終わり'])
        return
      }
    }
    const seen = new Set<string>()
    for (const group of breakGroups) {
      for (const weekday of group.weekdays) {
        const k = `${weekday}-${group.start}-${group.end}`
        if (seen.has(k)) {
          setBreakError('同じ曜日・同じ時間の休憩が2つあります。どちらかを消してください。')
          return
        }
        seen.add(k)
      }
    }
    setSavingBreaks(true)
    setBreakError(null)
    try {
      // 版付きで週全体を置き換える。曜日のまとまりは曜日ごとの行に広げて送る。
      const result = await bookingApi.putBreaks(
        selectedAccountId,
        staffId,
        breaksVersion,
        breakGroups.flatMap((group) => group.weekdays.map((weekday) => ({
          ...(group.ids[weekday] ? { id: group.ids[weekday] } : {}),
          weekday,
          start_time: group.start,
          end_time: group.end,
        }))),
      )
      if (saveGeneration !== requestRef.current) return
      setBreakGroups(groupBreaks(result.breaks))
      setBreaksVersion(result.version)
      setBreaksSavedAt(new Date().toISOString())
      setOpenDaysFor(null)
      breakSaveConflict.clear()
      if (menuId) await loadAvailability(selectedAccountId, menuId, timeZone, saveGeneration)
    } catch (error) {
      if (saveGeneration !== requestRef.current) return
      const fieldFailure = saveErrors.capture(error)
      if (error instanceof ApiError && error.status === 409) breakSaveConflict.mark()
      { if (!fieldFailure)
      setBreakError(staffErrorMessage(error, '保存')) }
    } finally {
      if (saveGeneration !== requestRef.current) return
      setSavingBreaks(false)
    }
  }

  /** 最新への置き換えは、入力を残した帯で本人が選んだときだけ行う。 */
  async function reloadBreaks(kind: 'weekly' | 'dated') {
    if (!selectedAccountId) return
    const generation = requestRef.current
    const weekly = kind === 'weekly'
    if (weekly) setSavingBreaks(true)
    else setSavingShift(true)
    try {
      if (weekly) {
        const latest = await bookingApi.getBreaks(selectedAccountId, staffId)
        if (generation !== requestRef.current) return
        setBreakGroups(groupBreaks(latest.breaks))
        setBreaksVersion(latest.version)
        setOpenDaysFor(null)
        breakSaveConflict.clear()
        setBreakError(null)
      } else {
        const latest = await bookingApi.getBreakDates(selectedAccountId, staffId)
        if (generation !== requestRef.current) return
        setDateRows(latest.breaks.map((item) => ({ key: item.id, id: item.id, date: item.work_date, start: item.start_time, end: item.end_time })))
        setBreakDatesVersion(latest.version)
        setEditingDayRow(null)
        dateSaveConflict.clear()
        setShiftError(null)
      }
      if (menuId) await loadAvailability(selectedAccountId, menuId, timeZone, generation)
    } catch (error) {
      if (generation !== requestRef.current) return
      const message = staffErrorMessage(error, '読み込み')
      if (weekly) setBreakError(message)
      else setShiftError(message)
    } finally {
      if (generation === requestRef.current) {
        if (weekly) setSavingBreaks(false)
        else setSavingShift(false)
      }
    }
  }

  function updateDateRow(key: string, patch: Partial<{ date: string; start: string; end: string }>) {
    setDateRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  /** この日だけの休憩は、足す・消すの時点で版付きの全体置き換えを送る（下書きを持たない）。 */
  async function saveBreakDates(nextRows: Array<{ key: string; id: string | null; date: string; start: string; end: string }>) {
    const saveGeneration = requestRef.current
    if (!selectedAccountId) return false
    for (const row of nextRows) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !validRange(row.start, row.end)) {
        setShiftError(`${shortDay(row.date)}の日時を正しく入れてください。入力はそのまま残しています。`)
        return false
      }
    }
    setSavingShift(true)
    setShiftError(null)
    try {
      const result = await bookingApi.putBreakDates(
        selectedAccountId,
        staffId,
        breakDatesVersion,
        nextRows.map((row) => ({ ...(row.id ? { id: row.id } : {}), work_date: row.date, start_time: row.start, end_time: row.end })),
      )
      if (saveGeneration !== requestRef.current) return false
      setDateRows(result.breaks.map((item) => ({ key: item.id, id: item.id, date: item.work_date, start: item.start_time, end: item.end_time })))
      setBreakDatesVersion(result.version)
      dateSaveConflict.clear()
      if (menuId) await loadAvailability(selectedAccountId, menuId, timeZone, saveGeneration)
      return saveGeneration === requestRef.current
    } catch (error) {
      if (saveGeneration !== requestRef.current) return false
      const fieldFailure = saveErrors.capture(error);

      if (error instanceof ApiError && error.status === 409) dateSaveConflict.mark()
      { if (!fieldFailure)
      setShiftError(staffErrorMessage(error, '保存')) }
      return false
    } finally {
      if (saveGeneration !== requestRef.current) return false
      setSavingShift(false)
    }
  }

  function updateShiftRow(id: string, patch: Partial<{ start: string; end: string }>) {
    setShiftRows((current) => ({ ...current, [id]: { ...(current[id] ?? { start: '', end: '' }), ...patch } }))
  }

  async function saveShiftRow(shift: BookingShift) {
    const saveGeneration = requestRef.current
    if (!selectedAccountId) return
    const row = shiftRows[shift.id] ?? { start: shift.start_time, end: shift.end_time }
    if (!validRange(row.start, row.end)) {
      setShiftError(`${shortDay(shift.work_date)}の時間を正しく入れてください（終わりは始まりより後にします）。入力はそのまま残しています。`)
      markBadTimes([`${shortDay(shift.work_date)}の始まり`, `${shortDay(shift.work_date)}の終わり`])
      return
    }
    setSavingShift(true)
    setShiftError(null)
    try {
      // 同じ日は上書きになるので、2回目の保存が残る。
      await bookingApi.putShifts(selectedAccountId, staffId, [{ work_date: shift.work_date, start_time: row.start, end_time: row.end }])
      if (saveGeneration !== requestRef.current) return
      setEditingDayRow(null)
      await refreshAfterSave('days')
      if (saveGeneration !== requestRef.current) return
    } catch (error) {
      if (saveGeneration !== requestRef.current) return
      const fieldFailure = saveErrors.capture(error)
      { if (!fieldFailure)
      setShiftError(staffErrorMessage(error, '保存')) }
    } finally {
      if (saveGeneration !== requestRef.current)

 return
      setSavingShift(false)
    }
  }

  /** 「この日を足す」の確定。種別ごとに今までの口へ送る。 */
  async function addDayEntry() {
    const saveGeneration = requestRef.current
    if (!selectedAccountId) return
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayAddDate)) {
      setShiftError('日付をカレンダーから選んでください。入力はそのまま残しています。')
      return
    }
    if (dayAddKind !== 'closed' && !validRange(dayAddStart, dayAddEnd)) {
      setShiftError('時間を正しく入れてください（終わりは始まりより後にします）。入力はそのまま残しています。')
      markBadTimes(['この日の始まり', 'この日の終わり'])
      return
    }
    setDayAddBusy(true)
    setShiftError(null)
    try {
      if (dayAddKind === 'closed') {
        const res = await bookingApi.createException(selectedAccountId, {
          scopeKind: 'staff',
          scopeId: staffId,
          dateFrom: dayAddDate,
          dateTo: dayAddDate,
          kind: 'closed',
          intervals: [],
          reason: dayAddMemo.trim() || null,
        })
      if (saveGeneration !== requestRef.current) return
        if (!res.success) throw new Error('exception_save_failed')
        setStaffExceptions((current) => [...current, res.data])
        if (menuId) await loadAvailability(selectedAccountId, menuId, timeZone, saveGeneration)
        if (saveGeneration !== requestRef.current) return
      } else if (dayAddKind === 'shift') {
        await bookingApi.putShifts(selectedAccountId, staffId, [{ work_date: dayAddDate, start_time: dayAddStart, end_time: dayAddEnd }])
      if (saveGeneration !== requestRef.current) return
        await refreshAfterSave('days')
      if (saveGeneration !== requestRef.current) return
      } else {
        const saved = await saveBreakDates([...dateRows, { key: `new-${Date.now()}`, id: null, date: dayAddDate, start: dayAddStart, end: dayAddEnd }])
      if (saveGeneration !== requestRef.current) return
        if (!saved) return
      }
      setDayAddOpen(false)
      setDayAddDate('')
      setDayAddMemo('')
    } catch (error) {
      if (saveGeneration !== requestRef.current) return
      const fieldFailure = saveErrors.capture(error)
      { if (!fieldFailure)
      setShiftError(staffErrorMessage(error, '追加')) }
    } finally {
      if (saveGeneration !== requestRef.current)

 return
      setDayAddBusy(false)
    }
  }

  async function removeDayEntry() {
    const saveGeneration = requestRef.current
    if (!selectedAccountId || !removeTarget || removeTargetContext !== removeContext) return
    setDeleting(true)
    try {
      if (removeTarget.kind === 'shift') {
        await bookingApi.deleteShift(selectedAccountId, staffId, removeTarget.item.id)
      if (saveGeneration !== requestRef.current) return
      } else if (removeTarget.kind === 'exception') {
        const res = await bookingApi.deleteException(selectedAccountId, removeTarget.item.id, removeTarget.item.version)
      if (saveGeneration !== requestRef.current) return
        if (!res.success) throw new Error('exception_delete_failed')
      } else {
        const target = removeTarget.item.key
        if (!await saveBreakDates(dateRows.filter((row) => row.key !== target))) return false
      }
      setRemoveTarget(null)
      void refreshAfterSave('days')
      return true
    } catch (error) {
      if (saveGeneration !== requestRef.current) return
      const fieldFailure = saveErrors.capture(error)
      { if (!fieldFailure)
      setShiftError(staffErrorMessage(error, '削除')) }
      return false
    } finally {
      if (saveGeneration !== requestRef.current)

 return
      setDeleting(false)
    }
  }

  async function generateFromRules() {
    const saveGeneration = requestRef.current
    if (!selectedAccountId) return
    const weeks = Number.parseInt(genWeeks, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(genFrom) || !Number.isInteger(weeks) || weeks < 1 || weeks > 12) {
      setGenError('開始日と週の数（1〜12）を正しく入れてください。')
      return
    }
    const template: Record<string, { start: string; end: string } | null> = {}
    const keys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
    for (const [index, key] of keys.entries()) {
      const saved = rules[index]
      template[key] = saved ? { start: saved.start, end: saved.end } : null
    }
    if (Object.values(template).every((item) => item === null)) {
      setGenError('いつもの勤務時間が空なので作れません。先に曜日ごとの時間を保存してください。')
      return
    }
    setGenerating(true)
    setGenError(null)
    try {
      // すでにある日は残す（上書きしない）ので、直したシフトが消えない。
      const result = await bookingApi.generateShifts(selectedAccountId, staffId, { from_date: genFrom, weeks, weekly_template: template })
      if (saveGeneration !== requestRef.current) return
      setGeneratedCount(result.inserted)
      await refreshAfterSave('days')
      if (saveGeneration !== requestRef.current) return
    } catch (error) {
      if (saveGeneration !== requestRef.current) return
      const fieldFailure = saveErrors.capture(error)
      { if (!fieldFailure)
      setGenError(staffErrorMessage(error, '作成')) }
    } finally {
      if (saveGeneration !== requestRef.current)

 return
      setGenerating(false)
    }
  }

  async function connectCalendar() {
    if (!selectedAccountId) return
    const trimmed = (calendarInput || calendarId || '').trim()
    if (!trimmed) {
      setCalendarFormError('カレンダーのIDを入れてください。')
      return
    }
    setSavingCalendar(true)
    setCalendarFormError(null)
    try {
      const result = await bookingApi.putGoogleCalendar(selectedAccountId, staffId, trimmed)
      setCalendarId(result.calendar_id)
      setCalendarVerifiedAt(result.last_verified_at)
      setCalendarError(null)
      setCalendarInput('')
      if (menuId) await loadAvailability(selectedAccountId, menuId, timeZone, requestRef.current)
    } catch (error) {
      const fieldFailure = saveErrors.capture(error);

      if (error instanceof ApiError && error.status === 503) {
        { if (!fieldFailure)
        setCalendarFormError('Googleの接続設定がまだなのでつなげません。管理者に連絡してください。入力はそのまま残しています。') }
      } else if (error instanceof ApiError && error.status === 422) {
        { if (!fieldFailure)
        setCalendarFormError('そのカレンダーに届きませんでした。IDを確かめてください。入力はそのまま残しています。')
      }
      } else {
        { if (!fieldFailure)
        setCalendarFormError(staffErrorMessage(error, '保存')) }
      }
    } finally {
      setSavingCalendar(false)
    }
  }

  async function disconnectCalendar() {
    const saveGeneration = requestRef.current
    if (!selectedAccountId) return
    setDisconnecting(true)
    try {
      await bookingApi.deleteGoogleCalendar(selectedAccountId, staffId)
      if (saveGeneration !== requestRef.current) return
      setConfirmDisconnect(false)
      setCalendarId(null)
      setCalendarVerifiedAt(null)
      setCalendarError(null)
      if (menuId) void loadAvailability(selectedAccountId, menuId, timeZone, saveGeneration)
      return true
    } catch (error) {
      if (saveGeneration !== requestRef.current) return
      const fieldFailure = saveErrors.capture(error)

      { if (!fieldFailure)
      setCalendarFormError(staffErrorMessage(error, '削除')) }
      return false
    } finally {
      if (saveGeneration === requestRef.current) setDisconnecting(false)
    }
  }

  const closedDates = useMemo(() => [...new Set([
    ...slotClosedDates,
    ...storeExceptions
      .filter((item) => item.kind === 'closed')
      .flatMap((item) => {
        const days: string[] = []
        for (let d = item.dateFrom; d <= item.dateTo && days.length < 40; d = addDays(d, 1)) days.push(d)
        return days
      }),
  ])], [storeExceptions, slotClosedDates])

  /** 14日の見取り（○×休）。スマホが畳まれる狭い画面でも残す。 */
  const previewMarks = useMemo(() => {
    const from = todayKey(timeZone)
    const closed = new Set(closedDates)
    return Array.from({ length: 14 }, (_, index) => addDays(from, index)).map((date) => {
      if (previewError || previewLoading) return { date, mark: '—' as const }
      if (closed.has(date)) return { date, mark: '休' as const }
      const daySlots = slots.filter((slot) => slot.date === date)
      return { date, mark: daySlots.some((slot) => slot.remaining > 0) ? '○' as const : '×' as const }
    })
  }, [timeZone, slots, closedDates, previewError, previewLoading])

  /** 「この日だけ」の行（例外日の休み・日ごとのシフト・この日だけの休憩を日付順で1列に）。 */
  const dayRows = useMemo<DayRow[]>(() => {
    const rows: DayRow[] = [
      ...staffExceptions.map((item) => ({ kind: 'exception' as const, date: item.dateFrom, item })),
      ...shifts.map((item) => ({ kind: 'shift' as const, date: item.work_date, item })),
      ...dateRows.map((item) => ({ kind: 'break' as const, date: item.date, item })),
    ]
    return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  }, [staffExceptions, shifts, dateRows])

  const workerBase = process.env.NEXT_PUBLIC_API_URL ?? ''
  const previewUrl = selectedAccount?.liffId
    ? `${workerBase}/o?liffId=${encodeURIComponent(selectedAccount.liffId)}&page=salon-book`
    : null
  const node = isSelf ? 'E3YDK' : 'd5fmnM'

  if (!selectedAccountId) {
    return <SaveErrorScope errors={saveErrors}><PageState node={node} self={isSelf} title="LINEアカウントを選んでください" desc="勤務とシフトを確認するアカウントを選びます。" /></SaveErrorScope>
  }
  if (loadStatus === 'loading') {
    return <SaveErrorScope errors={saveErrors}><PageState node={node} self={isSelf} title="読み込み中" desc="担当者の勤務とシフトを読み込んでいます。" /></SaveErrorScope>
  }
  if (loadStatus === 'error') {
    return (
      <SaveErrorScope errors={saveErrors}><PageState
        node={node}
        self={isSelf}
        title="担当者の勤務とシフトを表示できませんでした"
        desc="保存済みの内容は消えていません。時間をおいて、もう一度読み込んでください。"
        actions={<Button onClick={() => setReloadKey((value) => value + 1)}>勤務とシフトを再読み込み</Button>}
      /></SaveErrorScope>
    )
  }
  if (staffMissing || !staff) {
    if (isSelf) {
      return (
        <SaveErrorScope errors={saveErrors}><PageState
          node="wvGke"
          self
          icon={<UserX className={styles.stateIcon} aria-hidden="true" />}
          title={ownStaffId ? '自分の勤務だけを表示できます' : 'ひも付いた予約スタッフがありません'}
          desc={ownStaffId
            ? 'ほかの担当者の勤務は管理者だけが開けます。自分の勤務へ移動してください。'
            : '管理者が予約スタッフとログインユーザーをひも付けると、ここで自分の勤務を決められます。'}
          actions={ownStaffId
            ? <Button href={`/booking/staff/shifts?staff_id=${ownStaffId}`}>自分の勤務を開く</Button>
            : <Button href="/booking/bookings">予約の一覧へ戻る</Button>}
        /></SaveErrorScope>
      )
    }
    return (
      <SaveErrorScope errors={saveErrors}><PageState
        node="d5fmnM"
        self={false}
        title="担当者が見つかりませんでした"
        desc="削除されたか、別のアカウントの担当者です。一覧から選び直してください。"
        actions={<Button href="/booking/menus?tab=staff">担当スタッフの一覧に戻る</Button>}
      /></SaveErrorScope>
    )
  }

  const staffLabel = (item: BookingStaff) => `${item.name}${item.role ? `（${item.role}）` : ''}`
  // 閲覧のみ：時刻を選ぶ部品は置かず、いまの時刻を文字で見せる（2026-10-06 オーナー決定）。
  const timeBox = (label: string, value: string, onChange: (v: string) => void) => (canEdit
    ? <SaveErrorField names={["value","badTimes","bad_times"]}><TimeField aria-label={label} value={value} invalid={badTimes.includes(label)} onChange={(v) => { if (badTimes.includes(label)) setBadTimes([]); onChange(v) }} className={styles.time} /></SaveErrorField>
    : <span aria-label={label} className={`${styles.time} ${styles.timeText}`}>{value || emptyValue('unknown')}</span>
  )

  const previewContent = <>
          {previewUrl ? (
            <div className={layout.sideActions}>
              <Button href={previewUrl} external className={styles.sideButton}><Smartphone className={styles.btnIcon} aria-hidden="true" />お客さまに見える画面を確かめる</Button>
            </div>
          ) : null}
          <p className={layout.sideTitle} title={`お客さまの予約画面（${isSelf ? 'あなた' : `${staff.display_name}さん`}を指名したとき）`}>
            お客さまの予約画面（{isSelf ? 'あなた' : `${staff.display_name}さん`}を指名したとき）
          </p>
          <>
            <PhoneDatetimeStep
              menu={previewMenu}
              staffName={staff.display_name}
              slots={slots}
              closedDates={closedDates}
              closedWeekdays={closedWeekdays}
              status={previewLoading ? 'loading' : previewError ? 'error' : 'ready'}
              onRetry={selectedAccountId && menuId ? () => { void loadAvailability(selectedAccountId, menuId, timeZone, requestRef.current) } : undefined}
            />
          </>
          {previewUrl ? null : <p className={layout.cardNote}>このアカウントには予約画面のURLがまだありません</p>}
          {!hasActiveMenu ? <p className={layout.cardNote}>公開中のメニューがないため、枠は出ません。</p> : null}
          <p className={layout.cardNote}>日ごとのシフトがある日はそちらが優先、ない日はいつもの勤務時間どおりです。外の予定は枠を閉じます。</p>
          <div className={styles.marks} aria-label={`${staff.display_name}の予約枠（14日分）`}>
            {previewMarks.map((item) => (
              <span key={item.date} className={styles.mark} title={shortDay(item.date)}>
                <span className={styles.markDay}>{Number(item.date.slice(8, 10))}</span>
                <span data-mark={item.mark}>{item.mark}</span>
              </span>
            ))}
          </div>
</>

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage boardId={node} dirty={false} footerActions={null}
        title={isSelf ? '自分の勤務' : '勤務とシフト'}
        help={isSelf ? 'あなたの出勤・休憩・この日だけのシフトと、Google カレンダーのつながりを決めます。ほかの人の勤務は管理者だけが開けます。' : '担当スタッフの出勤・休憩・この日だけのシフトと、Google カレンダーのつながりを決めます。'}
        preview={previewContent}
        previewToggle={<PreviewLauncher title="お客さまの予約画面" label="お客さまの予約画面を見る">{previewContent}</PreviewLauncher>}
      >
          {isSelf ? (
            <p className={styles.linkBand} data-design="Info">{staffLabel(staff)}としてひも付いています。ひも付けを変えるときはオーナーか管理者に頼んでください。</p>
          ) : (
            <div className={styles.switcherRow}>
              <div className={styles.switcherField}>
                <span className={layout.smallLabel} id="bks-switch-label">担当者を切り替える</span>
                <span className={styles.selectBox}>
                  <SaveErrorField names={["staffId","scopeId","staff_id"]}><EntitySelect
                    aria-label="担当者を切り替える"
                    size="full"
                    value={staffId}
                    onChange={(value) => router.push(`/booking/staff/shifts?staff_id=${value}`)}
                    options={staffList.map((item) => ({ ...entityOptionMetadata(item), value: item.id, label: staffLabel(item) }))}
                  /></SaveErrorField>
                </span>
              </div>
              <p className={styles.switcherNote}>保存すると、右の予約画面にすぐ出ます。</p>
            </div>
          )}
      {canEdit ? null : <Notice tone="warn" role="status">
        閲覧のみです。勤務を変えるには、管理者に「自分の勤務」の権限を頼んでください。
      </Notice>}

          {/* 閲覧のみのときは選ぶ部品・押す口を置かず、いまの値を文字で見せる（API も 403 で断る。2026-10-06 オーナー決定）。 */}
          <fieldset className={styles.fieldset}>
            {/* いつもの勤務時間 */}
            <Card variant="form" gap="normal" aria-labelledby="bks-week" data-design="Week"><fieldset disabled={savingRules} className={styles.fieldset}>
              <CardHeader size="stacked" titleId="bks-week" title="いつもの勤務時間" action={canEdit ? <Button onClick={() => void saveRules()} disabled={savingRules} busy={savingRules} widthReserve="idle">保存する</Button> : undefined} />
              <p className={layout.cardNote}>曜日ごとの出勤時間です。空けた曜日は枠が出ません。日ごとのシフトがある日はそちらが優先されます。</p>
              {STAFF_DAYS.map((day) => {
                const row = draft[day.weekday] ?? EMPTY_RULE_DRAFT
                return (
                  <div className={styles.dayRow} key={day.weekday} data-on={row.active || undefined}>
                    <span className={styles.dayName}>{day.short}</span>
                    {canEdit ? <SaveErrorField names={["active","row.active"]}><Toggle label={`${day.label}は出勤する`} checked={row.active} onChange={(checked) => updateDraft(day.weekday, { active: checked })} /></SaveErrorField> : null}
                    {row.active ? (
                      <>
                        <span className={styles.dayState}>出る</span>
                        {timeBox(`${day.label}の始まり`, row.start, (v) => updateDraft(day.weekday, { start: v }))}
                        <span className={styles.tilde}>〜</span>
                        {timeBox(`${day.label}の終わり`, row.end, (v) => updateDraft(day.weekday, { end: v }))}
                      </>
                    ) : (
                      <>
                        <span className={styles.dayState} data-off="true">休み</span>
                        <span className={styles.offNote}>この曜日は予約枠が出ません</span>
                      </>
                    )}
                  </div>
                )
              })}
              {rulesSavedAt ? <p className={styles.savedNote} role="status">保存しました。右の予約画面に反映されています。</p> : null}
              {ruleError ? <p className={layout.fieldError} role="alert">{ruleError}</p> : null}
            </fieldset></Card>

            {/* 休憩 */}
            <Card variant="form" gap="normal" aria-labelledby="bks-breaks" data-design="Breaks"><fieldset disabled={savingBreaks} className={styles.fieldset}>
              <CardHeader size="stacked" titleId="bks-breaks" title="休憩" action={canEdit ? <Button onClick={() => void saveBreaks()} disabled={savingBreaks} busy={savingBreaks} widthReserve="idle">保存する</Button> : undefined} />
              <p className={layout.cardNote}>いつもの勤務時間の中の休み時間です。休憩の時間は予約枠から除きます。</p>
              {breakGroups.length === 0 ? <p className={layout.cardNote}>休憩はありません。</p> : breakGroups.map((group) => (
                <div key={group.key} className={styles.breakRow}>
                  <span className={styles.daysPick}>
                    {canEdit ? <>
                    <Button variant="text" size="compact" textTone="ink"
                      aria-expanded={openDaysFor === group.key}
                      aria-label={`休憩の曜日（${weekdaySetLabel(group.weekdays)}）を選択する`}
                      title="押すと曜日を選べます"
                      onClick={() => setOpenDaysFor((current) => (current === group.key ? null : group.key))}
                    >
                      {weekdaySetLabel(group.weekdays)}
                    </Button>
                    {openDaysFor === group.key ? (
                      <span className={styles.daysPanel} role="group" aria-label="休憩の曜日">
                        {STAFF_DAYS.map((day, saveFieldIndex) => (
                          <SaveErrorField names={[`STAFF_DAYS.${saveFieldIndex}.weekday`,"weekday","day.weekday"]} key={day.weekday}><Checkbox
                            key={day.weekday}
                            checked={group.weekdays.includes(day.weekday)}
                            onCheckedChange={(checked) => updateBreakGroup(group.key, {
                              weekdays: checked ? [...group.weekdays, day.weekday] : group.weekdays.filter((w) => w !== day.weekday),
                            })}
                          >
                            {day.short}
                          </Checkbox></SaveErrorField>
                        ))}
                      </span>
                    ) : null}
                    </> : <span className={styles.daysText}>{weekdaySetLabel(group.weekdays)}</span>}
                  </span>
                  {timeBox('休憩の始まり', group.start, (v) => updateBreakGroup(group.key, { start: v }))}
                  <span className={styles.tilde}>〜</span>
                  {timeBox('休憩の終わり', group.end, (v) => updateBreakGroup(group.key, { end: v }))}
                  {canEdit ? (
                    <IconButton
                      onClick={() => setBreakGroups((current) => current.filter((item) => item.key !== group.key))}
                      aria-label={`${weekdaySetLabel(group.weekdays)} ${group.start}〜${group.end} の休憩を削除`}
                    >
                      <Trash2 aria-hidden="true" />
                    </IconButton>
                  ) : null}
                </div>
              ))}
              {canEdit ? (
                <div className={styles.addRow}>
                  <Button onClick={addBreakGroup}><Plus className={styles.btnIcon} aria-hidden="true" />休憩を足す</Button>
                </div>
              ) : null}
              {breaksSavedAt ? <p className={styles.savedNote} role="status">保存しました。</p> : null}
              {breakSaveConflict.conflict && canEdit ? <Notice tone="warn" role="alert" message="ほかの人の変更と重なりました。入力は残しています。最新を読み込むと、編集中の休憩を最新の内容に置き換えます。" action={<Button onClick={() => void breakSaveConflict.reloadLatest()} disabled={savingBreaks}>最新を読み込んで続ける</Button>} /> : null}
              {breakError ? <p className={layout.fieldError} role="alert">{breakError}</p> : null}
            </fieldset></Card>

            {/* この日だけ（休み・シフト・休憩） */}
            <Card variant="form" gap="normal" aria-labelledby="bks-days" data-design="Special"><fieldset disabled={savingShift || dayAddBusy || deleting} className={styles.fieldset}>
              <CardHeader size="stacked" titleId="bks-days" title="この日だけ（休み・シフト・休憩）" />
              <p className={layout.cardNote}>その日だけ休む・時間を変える・休憩を足すときに使います。いつもの勤務時間より優先されます。</p>
              {dayRows.length === 0 ? (
                <p className={layout.cardNote}>この日だけの休み・シフト・休憩はありません。いつもの勤務時間どおりに枠が出ます。</p>
              ) : dayRows.map((row) => {
                const rowKey = row.kind === 'shift' ? `shift-${row.item.id}` : row.kind === 'exception' ? `ex-${row.item.id}` : `br-${row.item.key}`
                const isEditing = editingDayRow === rowKey
                const kindLabel = row.kind === 'exception' ? '休み' : row.kind === 'shift' ? 'シフト' : '休憩'
                return (
                  <div key={rowKey} className={styles.exRow}>
                    <div className={styles.exLine}>
                      <span className={styles.exDate}>{shortDay(row.date)}</span>
                      {row.kind === 'exception' ? (
                        <StatusBadge tone="neutral">{exceptionBadge(row.item)}</StatusBadge>
                      ) : !canEdit ? (
                        // 閲覧のみ：押して直す口は置かず、時間だけを見せる。
                        <StatusBadge tone={row.kind === 'shift' ? 'success' : 'info'}>
                          {row.kind === 'shift' ? `${row.item.start_time}〜${row.item.end_time}` : `休憩 ${row.item.start}〜${row.item.end}`}
                        </StatusBadge>
                      ) : (
                        <Button variant="text" size="compact" textTone="ink"
                          onClick={() => setEditingDayRow(isEditing ? null : rowKey)}
                          aria-expanded={isEditing}
                          title={row.kind === 'shift' ? '押すとこの日の時間を直せます' : '押すとこの日の休憩の時間を直せます'}
                        >
                          <StatusBadge tone={row.kind === 'shift' ? 'success' : 'info'}>
                          {row.kind === 'shift'
                            ? `${shiftRows[row.item.id]?.start ?? row.item.start_time}〜${shiftRows[row.item.id]?.end ?? row.item.end_time}`
                            : `休憩 ${row.item.start}〜${row.item.end}`}
                          </StatusBadge>
                        </Button>
                      )}
                      <span className={styles.exMemo}>{row.kind === 'exception' ? (row.item.reason ?? '') : ''}</span>
                      {canEdit ? (
                        <IconButton onClick={() => { setShiftError(null); setRemoveTargetContext(removeContext); setRemoveTarget(row) }} aria-label={`${shortDay(row.date)} の${kindLabel}を削除`}>
                          <Trash2 aria-hidden="true" />
                        </IconButton>
                      ) : null}
                    </div>
                    {isEditing && row.kind === 'shift' ? (
                      <div className={styles.exEdit}>
                        {timeBox(`${shortDay(row.item.work_date)}の始まり`, shiftRows[row.item.id]?.start ?? row.item.start_time, (v) => updateShiftRow(row.item.id, { start: v }))}
                        <span className={styles.tilde}>〜</span>
                        {timeBox(`${shortDay(row.item.work_date)}の終わり`, shiftRows[row.item.id]?.end ?? row.item.end_time, (v) => updateShiftRow(row.item.id, { end: v }))}
                        {canEdit ? <Button onClick={() => void saveShiftRow(row.item)} disabled={savingShift} busy={savingShift}>更新する</Button> : null}
                      </div>
                    ) : null}
                    {isEditing && row.kind === 'break' ? (
                      <div className={styles.exEdit}>
                        {timeBox(`${shortDay(row.date)}の休憩の始まり`, row.item.start, (v) => updateDateRow(row.item.key, { start: v }))}
                        <span className={styles.tilde}>〜</span>
                        {timeBox(`${shortDay(row.date)}の休憩の終わり`, row.item.end, (v) => updateDateRow(row.item.key, { end: v }))}
                        {canEdit ? <Button onClick={() => { void saveBreakDates(dateRows).then((saved) => { if (saved) setEditingDayRow(null) }) }} disabled={savingShift} busy={savingShift}>更新する</Button> : null}
                      </div>
                    ) : null}
                  </div>
                )
              })}
              {dayAddOpen && canEdit ? (
                <div className={styles.dayAdd} data-shift-day-entry={dayAddKind}>
                  <span className={styles.kindBox}>
                    <SaveErrorField names={["dayAddKind","day_add_kind"]}><Select
                      aria-label="足す種別"
                      value={dayAddKind}
                      onChange={(value) => setDayAddKind(value as DayAddKind)}
                      options={[
                        { value: 'shift', label: 'この日だけのシフト' },
                        { value: 'break', label: 'この日だけの休憩' },
                        ...(canEditExceptions ? [{ value: 'closed', label: 'この日だけの休み' }] : []),
                      ]}
                    /></SaveErrorField>
                  </span>
                  <span className={styles.dateBox}><SaveErrorField names={["dayAddDate","dateFrom","dateTo","work_date","date","day_add_date"]}><DateField aria-label="この日の日付" value={dayAddDate} onChange={setDayAddDate} /></SaveErrorField></span>
                  {dayAddKind !== 'closed' ? (
                    <>
                      {timeBox('この日の始まり', dayAddStart, setDayAddStart)}
                      <span className={styles.tilde}>〜</span>
                      {timeBox('この日の終わり', dayAddEnd, setDayAddEnd)}
                    </>
                  ) : (
                    <SaveErrorField names={["dayAddMemo","reason","day_add_memo"]}><TextField type="text" value={dayAddMemo} onChange={(e) => setDayAddMemo(e.target.value)} placeholder="理由（任意・例：研修のため）" aria-label="休みの理由" className={styles.memo} /></SaveErrorField>
                  )}
                  <Button variant="primary" onClick={() => void addDayEntry()} disabled={dayAddBusy || savingShift} busy={dayAddBusy}>足す</Button>
                </div>
              ) : null}
              {canEdit ? (
                <div className={styles.addRow}>
                  <Button onClick={() => setDayAddOpen((open) => !open)} aria-expanded={dayAddOpen}><Plus className={styles.btnIcon} aria-hidden="true" />この日を足す</Button>
                </div>
              ) : null}
              {dateSaveConflict.conflict && canEdit ? <Notice tone="warn" role="alert" message="ほかの人の変更と重なりました。入力は残しています。最新を読み込むと、編集中の日付付き休憩を最新の内容に置き換えます。" action={<Button onClick={() => void dateSaveConflict.reloadLatest()} disabled={savingShift}>最新を読み込んで続ける</Button>} /> : null}
              {shiftError ? <p className={layout.fieldError} role="alert">{shiftError}</p> : null}
            </fieldset></Card>

            {/* 何週分かのシフトを作る（作るための欄だけなので、閲覧のみには出さない） */}
            {canEdit ? <Card variant="form" gap="normal" aria-labelledby="bks-gen">
              <CardHeader size="stacked" titleId="bks-gen" title="何週分かのシフトを作る" />
              <p className={layout.cardNote}>いつもの勤務時間から、日ごとのシフトをまとめて作ります。作ったあと1日ずつ直せます。</p>
              <div className={styles.genRow}>
                <SettingsFormRow layout="columns" columns={2}>
                <Field required label="開始日"><span className={styles.dateBox}><SaveErrorField names={["genFrom","from_date","gen_from"]}><DateField aria-label="まとめて作り始める日" value={genFrom} onChange={setGenFrom} /></SaveErrorField></span></Field>
                {/* 範囲は題に書いてあるので、欄の下の「1〜12」は重ねない。 */}
                <div className={layout.field}><Field required label="週の数（1〜12）" htmlFor="bks-weeks"><SaveErrorField names={["genWeeks","gen_weeks"]}><NumberInput id="bks-weeks" aria-label="まとめて作る週の数" type="number" min={1} max={12} note={false} value={genWeeks} onChange={(event) => setGenWeeks(event.target.value)} /></SaveErrorField></Field></div>
                </SettingsFormRow>
                <Button variant="primary" onClick={() => void generateFromRules()} disabled={generating} busy={generating} busyLabel="作成中…" widthReserve="idle">
                  <CalendarPlus className={styles.btnIcon} aria-hidden="true" />作る
                </Button>
              </div>
              {genError ? <Notice tone="danger" className={layout.fieldErrorNoticePlacement} >{genError}</Notice> : null}
              {generatedCount !== null && !genError ? <p className={styles.savedNote} role="status">{generatedCount}日分作りました。</p> : null}
            </Card> : null}

            {/* Google カレンダー */}
            <Card variant="form" gap="normal" aria-labelledby="bks-cal">
              <CardHeader size="stacked" titleId="bks-cal" title="Google カレンダー" />
              <p className={layout.cardNote}>{isSelf
                ? 'あなたの Google カレンダーの予定がある時間は、予約枠から自動で外れます。LINE で入った予約は、このカレンダーに書き込みます。'
                : '予定がある時間は、予約枠から自動で外れます。LINE で入った予約は、このカレンダーに書き込みます。ほかの予約サービスがこのカレンダーへ書き出せば、そちらの予約でも自動で枠が埋まります。'}</p>
          {!serviceConfigured ? <Notice tone="warn" role="status">
            Googleの接続設定がまだなのでつなげません。管理者に連絡してください。
          </Notice> : null}
              <div className={styles.calRow}>
                <div className={`${layout.field} ${styles.calField}`}><Field label="カレンダーの ID" htmlFor="bks-cal-id"><SaveErrorField names={["calendarInput","calendarId","calendar_input","calendar_id"]}><TextField
                    id="bks-cal-id"
                    aria-label="カレンダーのID"
                    value={calendarId ? (calendarInput || calendarId) : calendarInput}
                    onChange={(event) => {
                      if (calendarId) setCalendarId(null)
                      setCalendarInput(event.target.value)
                    }}
                    placeholder="例：example@example.invalid"
                    readOnly={!canEdit}
                  /></SaveErrorField></Field></div>
                {calendarId ? <StatusBadge tone="success">つながっている</StatusBadge> : null}
              </div>
              {calendarId ? (
                <p className={styles.calMeta}>
                  <span>最後に読んだ {calendarVerifiedAt ? shortStamp(calendarVerifiedAt) : emptyValue('unknown')}</span>
                  {externalEvents != null ? <span>今週の外の予定 {externalEvents}件</span> : null}
                  {calendarError ? <span className={styles.calMetaError}>最新の確認で失敗しています：{calendarError}</span> : null}
                </p>
              ) : null}
              {canEdit ? (
                <div className={styles.calActions}>
                  {calendarId ? <Button onClick={() => { setCalendarFormError(''); setDisconnectContext(conflictContext); setConfirmDisconnect(true) }} disabled={disconnecting}>外す</Button> : null}
                  <Button variant={calendarId ? 'secondary' : 'primary'} onClick={() => void connectCalendar()} disabled={savingCalendar || !serviceConfigured} busy={savingCalendar} busyLabel="確認中…" widthReserve="idle">
                    {calendarId ? '保存する' : 'つなげる'}
                  </Button>
                </div>
              ) : null}
              {calendarFormError ? <p className={layout.fieldError} role="alert">{calendarFormError}</p> : null}
            </Card>
          </fieldset>

      </CreatePage>

      <ConfirmDialog
        open={removeTarget !== null && removeTargetContext === removeContext}
        title={removeTarget ? `「${shortDay(removeTarget.date)}」の${removeTarget.kind === 'exception' ? '休み' : removeTarget.kind === 'shift' ? 'シフト' : '休憩'}を消しますか？` : ''}
        description={removeTarget?.kind === 'exception'
          ? 'この日の休みを消すと、いつもの勤務時間どおりに枠が出ます。この操作は取り消せません。'
          : removeTarget?.kind === 'break'
            ? 'この日だけの休憩を消します。この操作は取り消せません。'
            : 'この日のシフトを消すと、いつもの勤務時間どおりに枠が出ます。この操作は取り消せません。'}
        confirmLabel="削除する"
        destructive
        busy={deleting}
        onCancel={() => setRemoveTarget(null)}
        error={shiftError || undefined} confirmDisabled={removeTarget?.kind === 'break' && Boolean(dateSaveConflict.conflict)} confirmDisabledReason="閉じて最新の内容と比べてください。" onSuccess={() => setRemoveTarget(null)} onConfirm={() => removeDayEntry()}
      ><OperationTargetSummary accounts={[{ id: selectedAccountId ?? '' }]} /></ConfirmDialog>
      <ConfirmDialog
        open={confirmDisconnect && disconnectContext === conflictContext}
        title="外の予定とのつながりを切りますか？"
        description="切ると、カレンダーの予定があっても枠が閉じなくなります。つなぎ直すといつでも戻せます。"
        confirmLabel="つながりを切る"
        destructive
        busy={disconnecting}
        onCancel={() => setConfirmDisconnect(false)}
        error={calendarFormError || undefined} onSuccess={() => setConfirmDisconnect(false)} onConfirm={() => disconnectContext === conflictContext ? disconnectCalendar() : undefined}
      ><OperationTargetSummary accounts={[{ id: selectedAccountId ?? '', name: selectedAccount?.id === selectedAccountId ? selectedAccount.name : undefined }]} externalTarget={{ label: '担当者', name: staff?.name }} /></ConfirmDialog>
    </SaveErrorScope>
  )
}
