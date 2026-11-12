'use client'
import { tableCapacityReason, type RestaurantTableDefinition } from '../booking-kit/table-definition'
import { DialogNote } from '../booking-kit/parts'
import { normalizePhone, phoneProblem } from '@line-crm/shared';

import { jstCalendar } from '@/lib/jst-datetime'

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Lock, UserPlus } from 'lucide-react'
import type { RestaurantCustomerHistory, RestaurantOpeningDay } from '@line-crm/shared'
import { CreatePage } from '@/components/templates'
import { usePageCrumbs } from '@/components/shell/page-chrome'
import { TableChoice } from '@/components/shared/booking-controls'
import Card from '@/components/shared/card'
import SegmentedControl from '@/components/shared/segmented'
import DateField from '@/components/shared/date-field'
import { TimeField } from '@/components/shared/date-time-field'
import StatusBadge from '@/components/shared/status-badge'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { Field } from '@/components/shared/form-controls'
import { useFormErrors } from '@/lib/use-form-errors'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import SearchField from '@/components/shared/search-field'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { useAccount } from '@/contexts/account-context'
import { restaurantTestApi, type RestaurantMenuItem, type RestaurantReservation, type RestaurantTable } from '@/lib/restaurant-test-api'
import type { PhonePreset } from './today'
import { INACTIVE_STATUSES, dayTitle, floorOrder, slotLabel, toYmd } from './format'
import { openTimes } from '../front-desk/slots'
import styles from './reservations.module.css'

import { formatYen as polishFormatYen, formatNumber } from '@/lib/format'
import { emptyValue } from '@/components/shared/empty-value'
import { phoneReservationInputReason } from '../booking-kit/phone-required'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { SettingsFormRow } from '@/components/shared/settings-form-card'
import FriendMatchRow from '@/components/shared/friend-match-row'

/*
 * ★V8 電話の予約を入れる（板 ）。作る型（CreatePage）で、左に入れる中身、右に確かめる物。
 *
 * 何を入れますか（お客さまの予約／枠だけ押さえる）→ だれの予約ですか（LINE の友だちを探す／
 * LINE 未連携の電話番号）→ いつ・何人・どの卓（空いている時間・卓・コース）→ 要望・アレルギー →
 * お客さまに何を送りますか。右：その時間の卓・LINE で届く見本・この方について。下の帯：キャンセル／台帳に入れる。
 * 送る形・口は今の画面（app/restaurant-test/v8/reservation-phone.tsx）と同じ。
 */

const STAY_MINUTES = 120

type Person = { name: string; phone: string; lineUid: string }

function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
}

/** 希望の時間（2時間）とその卓の予約が重なるか。期限切れの押さえは数えない。 */
function overlaps(day: string, time: string, tableId: string, rows: RestaurantReservation[]): boolean {
  const start = new Date(`${day}T${time.padStart(5, '0')}:00+09:00`).getTime()
  if (!Number.isFinite(start)) return false
  const end = start + STAY_MINUTES * 60_000
  return rows.some((r) => {
    if (r.departed_at || r.table_id !== tableId || INACTIVE_STATUSES.includes(r.status)) return false
    if (r.status === 'pending' && r.hold_expires_at && Date.parse(r.hold_expires_at) <= Date.now()) return false
    const s = new Date(r.starts_at).getTime()
    const e = new Date(r.ends_at).getTime()
    return s < end && e > start
  })
}

/** 人数が入る卓のうち余る席が一番少ない卓（口の自動配席と同じ決まり）。空いている卓から選ぶ。 */
function recommendTable(tables: RestaurantTable[], count: number, free: (table: RestaurantTable) => boolean): RestaurantTable | null {
  return tables
    .filter((t) => t.is_active && t.min_capacity <= count && t.max_capacity >= count && free(t))
    .sort((a, b) => (a.max_capacity - count) - (b.max_capacity - count) || a.code.localeCompare(b.code, 'ja', { numeric: true }))[0] ?? null
}

export default function PhoneReservation({ accountStyle, staffRole, canUseAlternateBooking = false, tableDefinition, storeId, storeName, tables, menuItems, busy, preset, onBack, onSave }: {
  accountStyle?: import('@line-crm/shared').AccountStyle | null
  staffRole?: string | null
  canUseAlternateBooking?: boolean
  tableDefinition?: RestaurantTableDefinition
  storeId: string
  storeName: string
  tables: RestaurantTable[]
  menuItems: RestaurantMenuItem[]
  busy: boolean
  preset: PhonePreset
  onBack: () => void
  /** 保存。成功したら true（台帳へ戻る）。 */
  onSave: (body: Record<string, unknown>) => Promise<boolean>
}) {
  const onBackRef = useRef(onBack)
  onBackRef.current = onBack
  usePageCrumbs([{ label: '予約台帳', onSelect: () => onBackRef.current() }])
  const { selectedAccountId } = useAccount()
  const legacy = Boolean(accountStyle && accountStyle !== 'restaurant')
  const canConfigure = staffRole === 'owner' || staffRole === 'admin'
  const canWrite = canConfigure || staffRole === 'staff'
  const hoursHref = '/restaurant-test/google?tab=hours'
  const legacyHref = accountStyle === 'salon' || accountStyle === 'consult' ? '/booking/bookings/new' : accountStyle === 'lesson' ? '/events' : null
  const todayInput = toYmd(new Date())
  const [kind, setKind] = useState(preset.hold ? 'hold' : 'customer')
  const [holdMinutes, setHoldMinutes] = useState('15')
  const [whoTab, setWhoTab] = useState<'line' | 'phone'>('line')
  const [search, setSearch] = useState('')
  const [found, setFound] = useState<Person[]>([])
  const [searchError, setSearchError] = useState('')
  const [person, setPerson] = useState<Person | null>(null)
  const [manualPhone, setManualPhone] = useState('')
  const [manualName, setManualName] = useState('')
  const [date, setDate] = useState(preset.date ? toYmd(preset.date) : todayInput)
  const [count, setCount] = useState('2')
  const [time, setTime] = useState(preset.time || '')
  const [tableMode, setTableMode] = useState(preset.tableId || 'auto')
  const [courseId, setCourseId] = useState('')
  const [allergy, setAllergy] = useState('')
  const [notifyTarget, setNotifyTarget] = useState<string | null>(null)
  const canNotify = kind === 'customer' && whoTab === 'line' && Boolean(person?.lineUid)
  const notifyKey = JSON.stringify([selectedAccountId, storeId, person?.lineUid])
  const notify = canNotify && notifyTarget === notifyKey
  const setNotify = (next: boolean) => setNotifyTarget(next ? notifyKey : null)
  const choosePerson = (next: Person | null) => { setPerson(next); setNotifyTarget(null) }
  useEffect(() => { setNotifyTarget(null) }, [selectedAccountId, storeId])
  const [error, setError] = useState<string | null>(null)
  const [hoursAttempt, setHoursAttempt] = useState(0)
  const [dayAttempt, setDayAttempt] = useState(0)
  const [hoursFailure, setHoursFailure] = useState('')
  const [dayFailure, setDayFailure] = useState('')
  const scopeKey = JSON.stringify([selectedAccountId, storeId, date])
  const dayKey = JSON.stringify([selectedAccountId, storeId, date])
  const [dayData, setDayData] = useState<{ key: string; rows: RestaurantReservation[] } | null>(null)
  const dayReady = Boolean(selectedAccountId && storeId && dayData?.key === dayKey)
  const dayRows = dayReady ? dayData!.rows : []
  const [hoursData, setHoursData] = useState<{ key: string; hours: RestaurantOpeningDay[] | null } | null>(null)
  const hours = selectedAccountId && storeId && hoursData?.key === scopeKey ? hoursData.hours : null
  const [history, setHistory] = useState<RestaurantCustomerHistory | null>(null)
  const [historyError, setHistoryError] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  const guests = Number(count)
  const capacityReason = tableCapacityReason(tableDefinition, selectedAccountId, storeId, tables, guests)
  const fields = useFormErrors()
  fields.define('person', 'お客さま', () => kind !== 'customer' || whoTab !== 'line' || person ? null : '名前・電話番号で探して、お客さまを選んでください。', { required: true })
  fields.define('name', 'お名前', () => kind !== 'customer' || whoTab !== 'phone' || manualName.trim() ? null : 'お名前を入れてください。', { required: true })
  fields.define('phone', '電話番号', () => kind !== 'customer' ? null : phoneProblem(person?.phone || manualPhone) || null)
  fields.define('date', '日付', () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00`))) return '日付を選んでください。'
    return date < toYmd(new Date()) ? '過去の日付は選べません。' : null
  }, { required: true })
  fields.define('count', '人数', () => Number.isInteger(guests) && guests >= 1 && guests <= 100 ? null : '人数は1〜100で入れてください。', { required: true })
  fields.define('time', '時間', () => time && openTimes(date, hours ?? []).includes(time) ? null : '空いている時間を選んでください。', { required: true })
  fields.define('hold', '仮押さえの期限（分）', () => kind !== 'hold' || (Number.isInteger(Number(holdMinutes)) && Number(holdMinutes) >= 1 && Number(holdMinutes) <= 120) ? null : '期限は1〜120分で入れてください。', { required: true })


  const dirty = kind !== (preset.hold ? 'hold' : 'customer') || search !== '' || person !== null || manualPhone !== '' || manualName !== ''
    || date !== (preset.date ? toYmd(preset.date) : todayInput) || count !== '2' || time !== (preset.time || '')
    || tableMode !== (preset.tableId || 'auto') || courseId !== '' || allergy !== '' || notify
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy })

  useEffect(() => {
    let current = true
    setDayData(null)
    setDayFailure('')
    if (!selectedAccountId || !storeId || !date) return
    void restaurantTestApi.reservationsDay(selectedAccountId, storeId, date).then((res) => {
      if (current) { setDayData({ key: dayKey, rows: Array.isArray(res.data?.reservations) ? res.data.reservations : [] }); setError(null) }
    }).catch(() => { if (current) setDayFailure(dayKey) })
    return () => { current = false }
  }, [selectedAccountId, storeId, date, dayKey, dayAttempt])

  useEffect(() => {
    let current = true
    setHoursData(null)
    setHoursFailure('')
    if (!selectedAccountId || !storeId || !date) return
    void restaurantTestApi.openingHours(selectedAccountId, storeId, date).then((res) => { if (current) { if (res.data.hours === undefined) setHoursFailure(scopeKey); else setHoursData({ key: scopeKey, hours: res.data.hours }) } }).catch(() => { if (current) setHoursFailure(scopeKey) })
    return () => { current = false }
  }, [selectedAccountId, storeId, scopeKey, hoursAttempt])

  useEffect(() => {
    let current = true
    setFound([]); setSearchError('')
    if (!selectedAccountId || search.trim().length < 2) return
    const timer = setTimeout(() => {
      void restaurantTestApi.customerSearch(selectedAccountId, storeId, search.trim()).then((res) => {
        if (current) setFound(res.data.map((c) => ({ name: c.name, phone: c.phone || '', lineUid: c.lineUid || '' })))
      }).catch(() => { if (current) setSearchError('お客さまを検索できませんでした。もう一度入力してください。') })
    }, 250)
    return () => { current = false; clearTimeout(timer) }
  }, [selectedAccountId, storeId, search])

  const contactUid = person?.lineUid || ''
  const contactPhone = person?.phone || manualPhone.trim()
  useEffect(() => {
    let current = true
    setHistory(null); setHistoryError('')
    if (!selectedAccountId || (!contactUid && !contactPhone)) return
    const timer = setTimeout(() => {
      void restaurantTestApi.customerHistory(selectedAccountId, storeId, { lineUid: contactUid, phone: contactPhone }).then((res) => {
        if (current) setHistory(res.data)
      }).catch(() => { if (current) setHistoryError('来店履歴を読み込めませんでした。連絡先を確認してください。') })
    }, 250)
    return () => { current = false; clearTimeout(timer) }
  }, [selectedAccountId, storeId, contactUid, contactPhone])

  const activeTables = useMemo(() => tables.filter((t) => t.is_active).sort(floorOrder), [tables])
  const courses = useMemo(() => menuItems.filter((m) => m.status === 'active' && m.kind === 'course'), [menuItems])

  /* 受けられる時間：その曜日の開ける時間のうち、2時間いられる始まり。今日は過ぎた時刻を出さない。
   * 開ける時間が読めない・全部休みのときは出さない（予約枠・在庫の「全部休み」と同じ前提。飛び込みの窓と共通の決まり）。
   * 描画ごとの分の区切りも見るので、開いたまま時刻が過ぎたら次の描画で候補から外れる。保存時の検査はつど今の時刻で見る。 */
  const nowMinute = Math.floor(Date.now() / 60000)
  const times = useMemo(() => openTimes(date, hours ?? [], new Date(nowMinute * 60000)), [date, hours, nowMinute])
  const [hoursYear, hoursMonth, hoursDay] = date.split('-').map(Number)
  const hoursWeekday = hoursYear && hoursMonth && hoursDay ? new Date(Date.UTC(hoursYear, hoursMonth - 1, hoursDay)).getUTCDay() : -1
  const closedDay = Boolean(hours && hoursWeekday >= 0 && !hours.find((day) => day.weekday === hoursWeekday)?.periods.length)
  const freeAt = (label: string) => activeTables.some((t) => t.min_capacity <= guests && t.max_capacity >= guests && !overlaps(date, label, t.id, dayRows))

  const recommended = useMemo(
    () => (time ? recommendTable(activeTables, guests, (t) => !overlaps(date, time, t.id, dayRows)) : recommendTable(activeTables, guests, () => true)),
    [activeTables, guests, time, date, dayRows],
  )
  const endsAt = time ? slotLabel(toMinutes(time) + STAY_MINUTES) : ''
  const usedTableId = tableMode === 'auto' ? recommended?.id ?? '' : tableMode
  const name = person?.name || manualName.trim()
  const phone = person?.phone || manualPhone.trim()
  const lineUid = person?.lineUid || ''
  const course = courses.find((c) => c.id === courseId) ?? null
  const lastVisit = history?.visits[0] ?? null
  const lastAllergy = history?.visits.find((v) => v.allergy_note)?.allergy_note ?? null
  const [yy, mm, dd] = date.split('-').map(Number)
  const dayDate = yy && mm && dd ? new Date(`${date}T00:00:00+09:00`) : new Date()
  const inputReason = phoneReservationInputReason([
    { label: 'お客さま', value: kind !== 'customer' || whoTab !== 'line' || Boolean(person) },
    { label: 'お名前', value: kind !== 'customer' || whoTab !== 'phone' || manualName },
    { label: '日付', value: date },
    { label: '人数', value: count },
    { label: '時刻', value: time },
    { label: '仮押さえの期限', value: kind !== 'hold' || holdMinutes },
  ])

  const save = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    setError(null)
    if (accountStyle !== 'restaurant' || !canWrite) return
    if (!storeId) { setError('店舗を選んでください。'); return }
    if (fields.submit().length > 0) {
      requestAnimationFrame(() => {
        const target = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
        target?.focus()
        target?.scrollIntoView({ block: 'center' })
      })
      return
    }
    if (!dayReady || !hours) { setError('営業時間と予約を確認できていません。'); return }
    const startsAt = new Date(`${date}T${time.padStart(5, '0')}:00+09:00`).toISOString()
    const endsAtIso = new Date(new Date(startsAt).getTime() + STAY_MINUTES * 60_000).toISOString()
    void onSave({
      kind, holdMinutes: Number(holdMinutes), source: 'phone', storeId, customerName: name, customerPhone: normalizePhone(phone) || null, lineUid: lineUid || null,
      guestCount: guests, startsAt, endsAt: endsAtIso,
      tableId: tableMode === 'auto' ? null : tableMode,
      courseId: courseId || null,
      allergyNote: allergy.trim() || null, notifyLine: notify,
    })
  }

  const preview = (
    <div className={styles.phoneSide}>
      <Card frame="raised" layout="vertical" padding="default" className={styles.phoneSideCard} aria-labelledby="rs-phone-tables">
        <h3 id="rs-phone-tables" className={styles.sideTitle}>{time ? `${time}〜${endsAt} の卓（2時間）` : '時間を選ぶと卓が出ます'}</h3>
        {time ? (
          <>
            <div className={styles.phoneTables}>
              {activeTables.map((t) => {
                const taken = overlaps(date, time, t.id, dayRows)
                const chosen = usedTableId === t.id
                return (
                  <TableChoice
                    key={t.id}
                    selected={chosen}
                    unavailable={taken}
                    onClick={() => setTableMode(t.id)}
                  >
                    {`${t.code}・${taken ? '使用中' : '空き'}`}
                  </TableChoice>
                )
              })}
            </div>
            <p className={styles.phoneLegend}>緑＝この予約で使う卓・赤＝埋まっている</p>
          </>
        ) : null}
      </Card>
      {canNotify ? <Card frame="raised" layout="vertical" padding="default" className={styles.phoneSideCard} aria-labelledby="rs-phone-line">
        <h3 id="rs-phone-line" className={styles.sideTitle}>{`お客さまに LINE で確認を送る（${notify ? 'オン' : 'オフ'}）`}</h3>
        <div className={styles.linePreview}>
          <p className={styles.linePreviewTitle}>ご予約を承りました</p>
          <p className={styles.linePreviewBody}>{`${dayTitle(dayDate)}${time ? `${time}〜` : ''}・${guests}名・${course?.name ?? '席のみ'}`}</p>
          <p className={styles.linePreviewStore}>{storeName}</p>
        </div>
      </Card> : null}
      <Card frame="raised" layout="vertical" padding="default" className={styles.phoneSideCard} aria-labelledby="rs-phone-who">
        <h3 id="rs-phone-who" className={styles.sideTitle}>この方について</h3>
        {history ? (
          <>
            <p className={styles.breakRow}><span>これまでの来店</span><strong>{`${formatNumber(history.visitCount)} 回`}</strong></p>
            <p className={styles.breakRow}><span>前回</span><strong>{lastVisit ? `${jstCalendar(new Date(lastVisit.starts_at)).getUTCMonth() + 1}/${jstCalendar(new Date(lastVisit.starts_at)).getUTCDate()}・${lastVisit.guest_count}名・${lastVisit.table_label || '未配席'}` : emptyValue('unknown')}</strong></p>
            <p className={styles.breakRow}><span>アレルギー（前回）</span><strong className={lastAllergy ? styles.alertText : undefined}>{lastAllergy || emptyValue('unknown')}</strong></p>
          </>
        ) : (
          historyError ? <ListState kind="error" title={historyError} /> : contactUid || contactPhone ? <ListState kind="loading" title="来店履歴を読み込んでいます。" /> : <p className={styles.sideText}>お客さまを選ぶと、来店回数と前回が出ます。</p>
        )}
      </Card>
    </div>
  )

  return (
    <>
      <CreatePage
        boardId="rm92Y"
        title="電話の予約を入れる"
        help="電話・店頭で受けた予約を台帳に入れます。空いている卓は自動で選びます。枠だけ押さえることもできます。"
        preview={preview} previewLabel="予約内容と卓を見る" previewTitle="予約内容と卓"
        footerActions={(
          <>
            <Button onClick={onBack} disabled={busy}>キャンセル</Button>
            <Button variant="primary" disabled={busy || accountStyle !== 'restaurant' || !canWrite || !storeId || !dayReady || !hours || Boolean(inputReason)} disabledReason={accountStyle !== 'restaurant' ? 'この画面から新しい予約は入れられません。' : !canWrite ? '予約を入れる権限を確認してください。' : hoursFailure === scopeKey || (hoursData?.key === scopeKey && hoursData.hours === null) ? '営業時間を確認してください。' : closedDay ? 'この曜日は休みです。' : inputReason || (!dayReady || !hours ? '営業時間と予約を確認してください。' : undefined)} onClick={() => formRef.current?.requestSubmit()}>
              {kind === 'hold' ? <Lock size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{kind === 'hold' ? '枠を押さえる' : '台帳に入れる'}
            </Button>
          </>
        )} dirty={false}
      >
        <form ref={formRef} className={styles.phoneForm} onSubmit={save} noValidate>
          {legacy ? <Notice tone="info" message="この画面は飲食店スタイルの古い予約を確認するためのものです。新しい予約はこのスタイルの予約画面から入れてください。" action={legacyHref && (accountStyle === 'lesson' ? canConfigure : canUseAlternateBooking) ? <Button variant="text" size="inline" href={legacyHref}>予約画面へ</Button> : undefined} /> : null}
          <Card frame="raised" padding="spacious" layout="vertical" className={styles.phoneCard} aria-labelledby="rs-phone-kind">
            <h2 id="rs-phone-kind" className={styles.phoneCardTitle}>何を入れますか</h2>
            <SaveErrorField names={["rs-phone-kind","kind"]}><RadioCardGroup legend="何を入れますか" className={styles.kindCards}>
              <RadioCard name="rs-phone-kind" value="customer" checked={kind === 'customer'} onChange={(next) => { setKind(next); setNotifyTarget(null) }} icon={<UserPlus size={16} aria-hidden="true" />} title="お客さまの予約を入れる" note="電話・店頭で受けた予約" />
              <RadioCard name="rs-phone-kind" value="hold" checked={kind === 'hold'} onChange={(next) => { setKind(next); setNotifyTarget(null) }} icon={<Lock size={16} aria-hidden="true" />} title="枠だけ押さえる" note="電話・常連・団体のために空けておく" />
            </RadioCardGroup></SaveErrorField>
            {kind === 'hold' ? (
              <Field label="仮押さえの期限（分）" htmlFor="rs-phone-hold" error={fields.error('hold')} requirement={fields.requirement('hold')}>
                <SaveErrorField names={["holdMinutes","hold_minutes"]}><NumberInput unit="分" id="rs-phone-hold" aria-label="仮押さえの期限（分）" type="number" min={1} max={120} value={holdMinutes} onChange={(event) => setHoldMinutes(event.target.value)} /></SaveErrorField>
              </Field>
            ) : null}
          </Card>
          {kind === 'customer' ? (
            <Card frame="raised" padding="spacious" layout="vertical" className={styles.phoneCard} aria-labelledby="rs-phone-who-title">
              <div className={styles.phoneCardHead}>
                <h2 id="rs-phone-who-title" className={styles.phoneCardTitle}>だれの予約ですか</h2>
                <p className={styles.phoneCardText}>LINE の友だちなら名前で探して結びつけます。LINE 未連携の電話番号でも入れられます</p>
              </div>
              <div className={styles.inlineControls}><SaveErrorField names={["whoTab"]}><SegmentedControl aria-label="お客さまの探し方" appearance="choices" value={whoTab} onChange={(next) => { setWhoTab(next); choosePerson(null) }} options={[
                { value: 'line', label: 'LINE の友だち' }, { value: 'phone', label: 'LINE 未連携の電話番号' },
              ]} /></SaveErrorField></div>
              {whoTab === 'line' ? (
                <>
                  {/* 選んだあとも探す欄は残す（絵 rm92Y：欄の下に選んだ人の行）。 */}
                  <Field label="名前・電話番号で探す" labelHidden error={fields.error('person')} requirement={fields.requirement('person')}>
                  <SearchField id="rs-phone-search" aria-invalid={fields.invalid('person')}
                    aria-label="名前・電話番号で探す"
                    placeholder="名前・電話番号で探す"
                    value={search}
                    /* 選んだあとに打ち直したら、選び直しとして扱う。 */
                    onChange={(value) => { setSearch(value); if (person) choosePerson(null) }}
                    onClear={() => { setSearch(''); choosePerson(null) }}
                  />
                  </Field>
                  {!person && search.trim().length >= 2 ? (
                    <div className={styles.foundList}>
                      {searchError ? <Notice tone="danger" className={styles.formErrorNoticePlacement} >{searchError}</Notice> : null}
                      {found.length === 0 && !searchError ? <p className={styles.sideText}>台帳に見つかりません。電話番号のタブから入れられます。</p> : null}
                      {found.map((c) => (
                        <Button key={`${c.lineUid || c.phone || c.name}`} type="button" onClick={() => { choosePerson(c); setSearch('') }}>
                          {c.name}{c.phone ? `（${c.phone}）` : ''}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                  {person ? (
                    <FriendMatchRow name={person.name} selected avatar={false} onClear={() => { choosePerson(null); setSearch('') }} description={<StatusBadge dot={false} size="micro" surface="white" tone="success">{`${person.lineUid ? 'LINE 連携済み' : 'LINE 未連携'}${history ? `・来店 ${formatNumber(history.visitCount)} 回` : ''}`}</StatusBadge>} />
                  ) : null}
                </>
              ) : (
                <SettingsFormRow layout="columns">
                  <Field label="電話番号" htmlFor="rs-phone-tel" error={fields.error('phone')}>
                    <SaveErrorField names={["manualPhone","manual_phone"]}><TextField id="rs-phone-tel" invalid={fields.invalid('phone')} inputMode="tel" value={manualPhone} onChange={(event) => setManualPhone(event.target.value)} /></SaveErrorField>
                  </Field>
                  <Field label="お名前" htmlFor="rs-phone-name" error={fields.error('name')} requirement={fields.requirement('name')}>
                    <SaveErrorField names={["manualName","manual_name"]}><TextField id="rs-phone-name" value={manualName} onChange={(event) => setManualName(event.target.value)} /></SaveErrorField>
                  </Field>
                </SettingsFormRow>
              )}
            </Card>
          ) : null}
          <Card frame="raised" padding="spacious" layout="vertical" className={styles.phoneCard} aria-labelledby="rs-phone-when">
            <h2 id="rs-phone-when" className={styles.phoneCardTitle}>いつ・何人・どの卓</h2>
            <SettingsFormRow layout="columns">
              <Field label="日付" htmlFor="rs-phone-date" error={fields.error('date')} requirement={fields.requirement('date')}>
                <SaveErrorField names={["date"]}><DateField size="compact" id="rs-phone-date" invalid={fields.invalid('date')} value={date} min={todayInput} onChange={(next) => { setDate(next); setTime('') }} /></SaveErrorField>
              </Field>
              <Field label="人数" htmlFor="rs-phone-count" error={fields.error('count')} requirement={fields.requirement('count')}>
                <SaveErrorField names={["count"]}><NumberInput id="rs-phone-count" type="number" min={1} max={100} required value={count} onChange={(event) => setCount(event.target.value)} /></SaveErrorField>
              </Field>
            </SettingsFormRow>
            <div className={styles.timeBlock}>
              {fields.invalid('time') ? <Field label="時間" error={fields.error('time')} requirement={fields.requirement('time')}><SaveErrorField names={["time"]}><TimeField aria-label="時間" invalid value={time} onChange={setTime} /></SaveErrorField></Field> : null}
              <p className={styles.timeLabel}>{`空いている時間（${guests}名が入る卓がある時間）`}</p>
              {capacityReason ? <DialogNote>{capacityReason}</DialogNote> : null}
              {hoursFailure === scopeKey ? <><p className={styles.sideText}>営業時間を読み込めませんでした。</p><Button type="button" onClick={() => { setHoursFailure(''); setHoursAttempt((n) => n + 1) }}>営業時間を再読み込み</Button></> : hoursData?.key === scopeKey && hoursData.hours === null ? <p className={styles.sideText}>{`${storeName}の営業時間が未設定です。`} {accountStyle === 'restaurant' && canConfigure ? <>開ける時間を設定してください。 <Button variant="text" size="inline" href={hoursHref}>開ける時間を設定する</Button></> : accountStyle === 'restaurant' && staffRole === 'staff' ? '管理者に営業時間の設定を依頼してください。' : null}</p> : null}
              {dayFailure === dayKey ? <><p className={styles.sideText}>この日の予約を読み込めませんでした。</p><Button type="button" onClick={() => { setDayFailure(''); setDayAttempt((n) => n + 1) }}>予約を再読み込み</Button></> : null}
              {times.length === 0 && hours ? (
                <p className={styles.sideText}>{closedDay ? <>{`${storeName}はこの曜日が休みです。`} {accountStyle === 'restaurant' && canConfigure ? <Button variant="text" size="inline" href={hoursHref}>開ける時間を確認する</Button> : accountStyle === 'restaurant' && staffRole === 'staff' ? '変更が必要なら管理者に依頼してください。' : null}</> : 'この日に受け付けられる時間はありません。別の日を選んでください。'}</p>
              ) : (
                <div className={styles.timeChips}>
                  {times.map((label) => {
                    const ok = freeAt(label)
                    return (
                      <Button key={label} type="button" size="slot" variant={time === label ? 'primary' : 'secondary'} aria-pressed={time === label} disabled={!ok} onClick={() => setTime(label)}>{label}</Button>
                    )
                  })}
                </div>
              )}
            </div>
            <SettingsFormRow layout="columns">
              <Field labelSize="compact" label="卓">
                <SaveErrorField names={["tableMode","table_mode"]}><EntitySelect aria-label="卓" label="卓" size="full" value={tableMode} onChange={setTableMode} options={[
                  { value: 'auto', color: 'var(--color-status-info)', label: recommended ? `自動で選ぶ（おすすめ：${recommended.code} ${recommended.label} ${recommended.max_capacity}名）` : '自動で選ぶ' },
                  ...activeTables.map((t) => ({ ...entityOptionMetadata(t), color: 'var(--color-status-info)', value: t.id, label: `${t.code}・${t.label}（${t.min_capacity}〜${t.max_capacity}名）` })),
                ]} /></SaveErrorField>
              </Field>
              <Field labelSize="compact" label="コース">
                <SaveErrorField names={["courseId","course_id"]}><EntitySelect aria-label="コース" size="full" value={courseId} onChange={setCourseId} options={[
                  { value: '', label: '席のみ' },
                  ...courses.map((c) => ({ ...entityOptionMetadata(c), value: c.id, label: `${c.name} ${polishFormatYen(c.price)}` })),
                ]} /></SaveErrorField>
              </Field>
            </SettingsFormRow>
            <p className={styles.phoneNote}>自動で選ぶと、人数が入る卓のうち余る席が一番少ない卓にします（座席・卓管理の自動配席ルール）</p>
          </Card>
          <Card frame="raised" padding="spacious" layout="vertical" className={styles.phoneCard} aria-labelledby="rs-phone-allergy">
            <h2 id="rs-phone-allergy" className={styles.phoneCardTitle}>要望・アレルギー</h2>
            <Field label="アレルギー・特記事項" htmlFor="rs-phone-allergy-input">
              <SaveErrorField names={["allergy","allergyNote"]}><TextField id="rs-phone-allergy-input" value={allergy} onChange={(event) => setAllergy(event.target.value)} /></SaveErrorField>
            </Field>
          </Card>
          {canNotify ? (
            <Card frame="raised" padding="spacious" layout="vertical" className={styles.phoneCard} aria-labelledby="rs-phone-send">
              <div className={styles.phoneCardHead}>
                <h2 id="rs-phone-send" className={styles.phoneCardTitle}>お客さまに何を送りますか</h2>
                <p className={styles.phoneCardText}>LINE とつながっている方には予約の案内を送れます。送らない選択もできます</p>
              </div>
              <SaveErrorField names={["notify"]}><Checkbox checked={notify} onCheckedChange={setNotify}>
                <span className={styles.checkTitle}>予約を受け付けたことを、いますぐ LINE に送る</span>
                <span className={styles.checkSub}>日時・人数・コースを書いた案内が届きます</span>
              </Checkbox></SaveErrorField>
              <p className={styles.phoneNote}>前日・当日のご案内は「LINE来店フォロー」で決めた送り方で届きます。</p>
            </Card>
          ) : null}
          {error ? <Notice tone="danger" message={error} /> : null}
        </form>
      </CreatePage>
      <UnsavedLeaveDialog open={leaveTarget !== null} onConfirm={confirmLeave} onCancel={cancelLeave} />
    </>
  )
}
