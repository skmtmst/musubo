'use client'
import { tableCapacityReason, type RestaurantTableDefinition } from '../booking-kit/table-definition'
import { DialogNote } from '../booking-kit/parts'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { phoneReservationFailure } from '../booking-kit/phone-error'
import Toggle from '@/components/shared/toggle';
import { normalizePhone, phoneProblem } from '@line-crm/shared';

import { formatDate as polishFormatDate } from '@/lib/format'
import { useEffect, useMemo, useState } from 'react'
import { Check, Minus, Plus } from 'lucide-react'
import FriendMatchRow from '@/components/shared/friend-match-row'
import type { RestaurantOpeningDay } from '@line-crm/shared'
import Button from '@/components/shared/button'
import DateField from '@/components/shared/date-field'
import Drawer from '@/components/shared/drawer'
import { DialogActions } from '@/components/shared/dialog'
import FilterChip from '@/components/shared/filter-chip'
import IconButton from '@/components/shared/icon-button'
import SegmentedControl from '@/components/shared/segmented'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import { restaurantTestApi, type RestaurantReservation, type RestaurantTable } from '@/lib/restaurant-test-api'
import { STAY_MINUTES, freeTables, openTimes, startOf, tableNote, toYmd } from './slots'
import { useFormErrors } from '@/lib/use-form-errors'
import { FieldError } from '@/components/shared/form-controls'
import styles from './front-desk.module.css'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { phoneReservationInputReason } from '../booking-kit/phone-required'

/*
 * ★V8 電話予約の引き出し（提案 E-2 `wEzuG`）。
 *
 * 電話番号 → LINE の友だちを探して候補（押すと名前が入る）→ 名前 → 人数（−/＋）→ 日付（今日／明日／選ぶ）
 * → 空いている時刻の札 → 卓は自動（変えられる）→ メモ → 「LINE で確認を送る」（友だちのときだけ）→［予約を入れる］。
 * 電話番号・時刻・［予約を入れる］の3〜4手で入る。保存は今の手動予約の口（source=phone）。動きは BEHAVIOR.md。
 */

type Friend = { name: string; phone: string; lineUid: string }
type DayChoice = 'today' | 'tomorrow' | 'pick'

const MAX_GUESTS = 100

function addDays(day: Date, days: number): Date {
  const next = new Date(day)
  next.setTime(next.getTime() + days * 86_400_000)
  return next
}

function md(day: Date): string {
  return polishFormatDate(day, { style: 'list-day' })
}

export default function PhoneReservationDrawer({ staffRole, storeName, tableDefinition, open, accountId, storeId, tables, onClose, onSaved }: {
  open: boolean
  accountId: string
  staffRole?: string | null
  storeName?: string
  tableDefinition?: RestaurantTableDefinition
  storeId: string
  tables: RestaurantTable[]
  onClose: () => void
  /** 保存できたら呼ぶ（LINE の確認が送れなかったときは lineFailed）。 */
  onSaved: (result: { lineFailed: boolean }) => void
}) {
  const canConfigure = staffRole === 'owner' || staffRole === 'admin'
  const canWrite = canConfigure || staffRole === 'staff'
  const hoursHref = `/restaurant-test/inventory?storeId=${encodeURIComponent(storeId)}#rs-hours-title`
  const saveErrors = useSaveFormErrors()
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (!open) return
    const refresh = () => setNow(new Date())
    refresh()
    const timer = setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [open])
  const [phone, setPhone] = useState('')
  const [friends, setFriends] = useState<Friend[]>([])
  const [friend, setFriend] = useState<Friend | null>(null)
  const [name, setName] = useState('')
  const [guests, setGuests] = useState(2)
  const capacityReason = tableCapacityReason(tableDefinition, accountId, storeId, tables, guests)
  const [dayChoice, setDayChoice] = useState<DayChoice>('today')
  const [picked, setPicked] = useState('')
  const [time, setTime] = useState('')
  const [tableId, setTableId] = useState('auto')
  const [changingTable, setChangingTable] = useState(false)
  const [memo, setMemo] = useState('')
  const [notifyTarget, setNotifyTarget] = useState<string | null>(null)
  const notifyKey = JSON.stringify([accountId, storeId, friend?.lineUid])
  const notify = Boolean(friend?.lineUid) && notifyTarget === notifyKey
  const setNotify = (next: boolean) => setNotifyTarget(next ? notifyKey : null)
  useEffect(() => { setNotifyTarget(null) }, [accountId, storeId])
  const [hoursAttempt, setHoursAttempt] = useState(0)
  const [dayAttempt, setDayAttempt] = useState(0)
  const [hoursFailure, setHoursFailure] = useState('')
  const [dayFailure, setDayFailure] = useState('')
  const scopeKey = JSON.stringify([accountId, storeId])
  const [hoursData, setHoursData] = useState<{ key: string; hours: RestaurantOpeningDay[] | null } | null>(null)
  const hours = open && accountId && storeId && hoursData?.key === scopeKey ? hoursData.hours : null
  const [dayData, setDayData] = useState<{ key: string; rows: RestaurantReservation[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  /* 開くたびに空から始める。 */
  useEffect(() => {
    if (!open) return
    fields.reset()
    setPhone(''); setFriends([]); setFriend(null); setName(''); setGuests(2); setDayChoice('today'); setPicked('')
    setTime(''); setTableId('auto'); setChangingTable(false); setMemo(''); setNotify(false); setError('')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps -- 欄の印の片付けは開いたときだけ

  const date = dayChoice === 'today' ? toYmd(now) : dayChoice === 'tomorrow' ? toYmd(addDays(now, 1)) : picked
  useEffect(() => { setTime('') }, [date])

  useEffect(() => {
    let current = true
    setHoursData(null)
    setHoursFailure('')
    if (!open || !accountId || !storeId) return
    void restaurantTestApi.openingHours(accountId, storeId)
      .then((res) => { if (current) { if (res.data.hours === undefined) setHoursFailure(scopeKey); else setHoursData({ key: scopeKey, hours: res.data.hours }) } })
      .catch(() => { if (current) setHoursFailure(scopeKey) })
    return () => { current = false }
  }, [open, accountId, storeId, scopeKey, hoursAttempt])

  const dayKey = JSON.stringify([accountId, storeId, date])
  const dayReady = Boolean(open && accountId && storeId && date && dayData?.key === dayKey)
  const dayRows = dayReady ? dayData!.rows : []

  useEffect(() => {
    let current = true
    setDayData(null)
    setDayFailure('')
    if (!open || !accountId || !storeId || !date) return
    void restaurantTestApi.reservationsDay(accountId, storeId, date)
      .then((res) => { if (current) setDayData({ key: dayKey, rows: Array.isArray(res.data?.reservations) ? res.data.reservations : [] }) })
      .catch(() => { if (current) setDayFailure(dayKey) })
    return () => { current = false }
  }, [open, accountId, storeId, date, dayKey, dayAttempt])

  /* 電話番号で LINE の友だちを探す（4桁から・打つのが止まってから）。 */
  useEffect(() => {
    let current = true
    const digits = normalizePhone(phone)
    setFriends([])
    if (!open || !accountId || !storeId || digits.length < 4) return
    const timer = setTimeout(() => {
      void restaurantTestApi.customerSearch(accountId, storeId, digits)
        .then((res) => {
          if (!current) return
          setFriends(res.data.filter((c) => c.lineUid).map((c) => ({ name: c.name, phone: c.phone || '', lineUid: c.lineUid || '' })))
        })
        .catch(() => { /* 探せないときは候補を出さず、名前を手で入れてもらう */ })
    }, 250)
    return () => { current = false; clearTimeout(timer) }
  }, [open, accountId, storeId, phone])

  const times = useMemo(() => (date ? openTimes(date, hours ?? [], now) : []), [date, hours, now])
  const [hoursYear, hoursMonth, hoursDay] = date.split('-').map(Number)
  const hoursWeekday = hoursYear && hoursMonth && hoursDay ? new Date(Date.UTC(hoursYear, hoursMonth - 1, hoursDay)).getUTCDay() : -1
  const closedDay = Boolean(hours && hoursWeekday >= 0 && !hours.find((day) => day.weekday === hoursWeekday)?.periods.length)
  const freeAt = (label: string) => freeTables(tables, guests, startOf(date, label), dayRows).length > 0
  const candidates = useMemo(
    () => (time && date ? freeTables(tables, guests, startOf(date, time), dayRows) : []),
    [tables, guests, time, date, dayRows],
  )
  /* 選んでいた時刻が人数を変えて埋まったら選び直してもらう。 */
  useEffect(() => {
    if (time && date && freeTables(tables, guests, startOf(date, time), dayRows).length === 0) setTime('')
  }, [guests, date, dayRows]) // eslint-disable-line react-hooks/exhaustive-deps
  const chosenTable = tableId === 'auto' ? candidates[0] ?? null : candidates.find((t) => t.id === tableId) ?? candidates[0] ?? null
  const dirty = phone !== '' || name !== '' || memo !== '' || time !== '' || guests !== 2

  const choose = (item: Friend | null) => {
    setNotifyTarget(null)
    setFriend(item)
    if (item) setName(item.name)
  }

  /* 予約を入れるときに落ちた欄は、その欄の真下に理由を出して移る。 */
  const fields = useFormErrors()
  fields.define('phone', '電話番号', () => phoneProblem(phone) || null)
  fields.define('name', 'お名前', () => (name.trim() ? null : 'お名前を入れてください。'), { required: true })
  fields.define('date', '日付', () => (date ? null : '日付を選んでください。'), { required: true })
  fields.define('time', '時刻', () => (!date ? null : !time ? '時刻を選んでください。' : chosenTable ? null : 'この時刻に人数が入る卓がありません。時刻か人数を変えてください。'), { required: true })
  const describedBy = (key: string) => (fields.invalid(key) ? `e2-${key}-error` : undefined)
  const inputReason = phoneReservationInputReason([
    { label: 'お名前', value: name },
    { label: '日付', value: date },
    { label: '時刻', value: time },
  ])

  const save = async () => {
    setError('')
    if (!canWrite || fields.submit().length > 0) return
    const currentNow = new Date()
    if (toYmd(now) !== toYmd(currentNow) || date < toYmd(currentNow)) { setNow(currentNow); setError('日付が変わりました。予約日時を確認してください。'); return }
    if (!dayReady || !hours || !date || !time || !openTimes(date, hours, currentNow).includes(time) || !chosenTable) return
    const startsAt = new Date(startOf(date, time))
    setBusy(true)
    try {
      const res = await restaurantTestApi.createReservation(accountId, {
        storeId,
        source: 'phone',
        customerName: name.trim(),
        customerPhone: normalizePhone(phone) || null,
        lineUid: friend?.lineUid || null,
        guestCount: guests,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + STAY_MINUTES * 60_000).toISOString(),
        tableId: chosenTable.id,
        note: memo.trim() || null,
        notifyLine: Boolean(friend) && notify,
      })
      onSaved({ lineFailed: Boolean(friend) && notify && !res.data.lineNotice.sent })
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)


      setError(phoneReservationFailure(caught, staffRole) || describeApiFailure(caught, '保存')) }
    } finally {
      setBusy(false)
    }
  }

  const validTime = Boolean(date && time && hours && openTimes(date, hours, new Date()).includes(time))
  const timeReason = time && !validTime ? '営業時間内の時刻を選んでください。' : undefined
  const footer = (
    <DialogActions align="center" padding="none">
      <Button onClick={onClose} disabled={busy}>キャンセル</Button>
      <Button variant="primary" onClick={() => void save()} disabled={busy || !canWrite || !dayReady || !hours || !validTime || Boolean(inputReason)} disabledReason={!canWrite ? '予約を入れる権限を確認してください。' : hoursFailure === scopeKey || (hoursData?.key === scopeKey && hoursData.hours === null) ? '営業時間を確認してください。' : closedDay ? 'この曜日は休みです。' : inputReason || (!dayReady || !hours ? '営業時間と予約を確認してください。' : timeReason)} busy={Boolean(busy)} busyLabel="処理中…">
        <Check size={16} aria-hidden="true" />予約を入れる
      </Button>
    </DialogActions>
  )

  return (
    <SaveErrorScope errors={saveErrors}><Drawer open={open} width="narrow" heightMode="viewport" title="電話予約を入れる" dirty={dirty} showDirtyIndicator={false} busy={busy} error={error || undefined} onClose={onClose} footer={footer}>
      <div className={styles.form} data-design-node="wEzuG">
        <Field label="電話番号"><SaveErrorField names={["phone","customerPhone"]}><TextField {...fields.bind('phone')} type="tel" inputMode="tel" autoComplete="off" invalid={fields.invalid('phone')} aria-describedby={describedBy('phone')} value={phone} onChange={(event) => { setPhone(event.target.value); if (friend) choose(null) }} placeholder="090-0000-5678" /></SaveErrorField><FieldError id="e2-phone-error">{fields.error('phone')}</FieldError></Field>
        {friends.length > 0 ? (
          <div className={styles.friendBox} role="group" aria-label="LINE の友だちの候補">
            <p className={styles.friendTitle}>LINE の友だちが見つかりました</p>
            {friends.slice(0, 3).map((item) => {
              const selected = friend?.lineUid === item.lineUid
              return (
                <FriendMatchRow key={item.lineUid} name={item.name} selected={selected} inset onSelect={() => choose(selected ? null : item)} description={item.phone ? `LINE の友だち・${item.phone}` : 'LINE の友だち'} />
              )
            })}
          </div>
        ) : null}
        <div className={styles.field}><Field label="お名前" htmlFor="e2-name" requirement={fields.requirement('name')}><SaveErrorField names={["name","customerName"]}><TextField {...fields.bind('name')} id="e2-name" invalid={fields.invalid('name')} aria-describedby={fields.invalid('name') ? 'e2-name-error' : undefined} value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" /></SaveErrorField>
<FieldError id="e2-name-error">{fields.error('name')}</FieldError></Field></div>
        <div className={styles.field}>
          <span className={styles.label} id="e2-guests">人数</span>
          <div className={styles.stepper} role="group" aria-labelledby="e2-guests">
            <IconButton aria-label="人数を減らす" disabled={guests <= 1} onClick={() => setGuests((n) => Math.max(1, n - 1))}><Minus size={16} aria-hidden="true" /></IconButton>
            <span className={styles.stepperValue} aria-live="polite">{`${guests} 名`}</span>
            <IconButton aria-label="人数を増やす" disabled={guests >= MAX_GUESTS} onClick={() => setGuests((n) => Math.min(MAX_GUESTS, n + 1))}><Plus size={16} aria-hidden="true" /></IconButton>
          </div>
        </div>
        <div className={styles.field}>
          <span className={styles.label}>日付</span>
          <span className={styles.segment}>
          <SaveErrorField names={["dayChoice"]}><SegmentedControl<DayChoice>
            aria-label="日付"
            value={dayChoice}
            onChange={(value) => { setDayChoice(value); setTime('') }}
            options={[
              { value: 'today', label: `今日 ${md(now)}` },
              { value: 'tomorrow', label: `明日 ${md(addDays(now, 1))}` },
              { value: 'pick', label: '日付を選ぶ' },
            ]}
          /></SaveErrorField>
          </span>
          {dayChoice === 'pick' ? (
            <span {...fields.bind('date')}>
              <SaveErrorField names={["picked"]}><DateField value={picked} onChange={(value) => { setPicked(value); setTime('') }} min={toYmd(now)} aria-label="予約の日付" invalid={fields.invalid('date')} aria-describedby={describedBy('date')} /></SaveErrorField>
            </span>
          ) : null}
          <FieldError id="e2-date-error">{fields.error('date')}</FieldError>
        </div>
        <div className={styles.field}>
          <span className={styles.label} id="e2-times">時刻（空いている時刻だけ）</span>
          {/* 時刻の札が1行出る高さを先に取る（空きが無い日・日付を選ぶ前でも下の卓・メモが上下しない）。 */}
          <div className={styles.timeBox} {...fields.bind('time')} aria-invalid={fields.invalid('time') || undefined} aria-describedby={describedBy('time')}>
          {hoursFailure === scopeKey ? <><p className={styles.hint}>営業時間を読み込めませんでした。</p><Button onClick={() => { setHoursFailure(''); setHoursAttempt((n) => n + 1) }}>営業時間を再読み込み</Button></> : hoursData?.key === scopeKey && hoursData.hours === null ? <p className={styles.hint}>{`${storeName || 'この店舗'}の営業時間が未設定です。`} {canConfigure ? <>開ける時間を設定してください。 <Button variant="text" size="inline" href={hoursHref}>開ける時間を設定する</Button></> : staffRole === 'staff' ? '管理者に営業時間の設定を依頼してください。' : null}</p> : null}
          {dayFailure === dayKey ? <><p className={styles.hint}>この日の予約を読み込めませんでした。</p><Button onClick={() => { setDayFailure(''); setDayAttempt((n) => n + 1) }}>予約を再読み込み</Button></> : null}
          {!date ? (
            <p className={styles.hint}>日付を選ぶと空いている時刻が出ます。</p>
          ) : !hours || dayFailure === dayKey ? null : times.filter(freeAt).length === 0 ? (
            closedDay ? <p className={styles.hint}>{`${storeName || 'この店舗'}はこの曜日が休みです。`} {canConfigure ? <Button variant="text" size="inline" href={hoursHref}>開ける時間を確認する</Button> : staffRole === 'staff' ? '変更が必要なら管理者に依頼してください。' : null}</p> : capacityReason ? <DialogNote>{capacityReason}</DialogNote> : <p className={styles.hint}>{`この日に ${guests}名が入る空いた時刻はありません。別の日を選んでください。`}</p>
          ) : (
            <div className={styles.timeChips} role="group" aria-labelledby="e2-times">
              {times.filter(freeAt).map((label) => (
                <FilterChip key={label} selected={time === label} onChange={(on) => { setTime(on ? label : ''); setTableId('auto') }}>{label}</FilterChip>
              ))}
            </div>
          )}
          </div>
          <FieldError id="e2-time-error">{fields.error('time')}</FieldError>
        </div>
        <div className={styles.tableRow}>
          <div className={styles.tableText}>
            <span className={styles.label}>卓</span>
            <span className={styles.tableValue}>
              {chosenTable
                ? `${chosenTable.code}（${tableNote(chosenTable)}）を${tableId === 'auto' ? '自動で割り当て' : '選びました'}`
                : time ? '人数が入る空いた卓がありません' : '時刻を選ぶと自動で割り当てます'}
            </span>
          </div>
          {!changingTable ? <Button variant="text" disabled={!candidates.length} title={!candidates.length ? '空いている時刻を選ぶと卓を変えられます' : undefined} onClick={() => setChangingTable(true)}>変える</Button> : null}
        </div>
        {changingTable && candidates.length > 0 ? (
          <SaveErrorField names={["id","chosenTable?.id","tableId","chosen_table?.id","table_id"]}><EntitySelect
            aria-label="卓を選ぶ"
            size="full"
            value={chosenTable?.id ?? ''}
            onChange={setTableId}
            options={candidates.map((t) => ({ ...entityOptionMetadata(t), value: t.id, label: `${t.code}（${tableNote(t)}）` }))}
          /></SaveErrorField>
        ) : null}
        <Field label="メモ"><SaveErrorField names={["memo","note"]}><TextField value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="アレルギー・記念日など" /></SaveErrorField></Field>
        {friend?.lineUid ? (
          <div className={styles.notifyRow}>
            <SaveErrorField names={["notify"]}><Toggle checked={notify} onChange={setNotify} label="LINE で確認を送る" /></SaveErrorField>
            <span className={styles.notifyText}>
              <span className={styles.notifyTitle}>LINE で確認を送る</span>
              <span className={styles.notifySub}>友だちのときだけ出ます</span>
            </span>
          </div>
        ) : null}
      </div>
    </Drawer></SaveErrorScope>
  )
}
