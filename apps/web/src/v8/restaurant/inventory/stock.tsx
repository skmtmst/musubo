'use client'
import { DetailPreview, DetailSection } from '@/components/shared/detail-content'
import type { Alloc, Hours, SlotInfo, Conflict } from './stock-types'
import { SaveConflictBand } from '@/components/shared/save-conflict'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Armchair, Check, X } from 'lucide-react'
import type { RestaurantOpeningDay, RestaurantOpeningHours } from '@line-crm/shared'
import Card, { CardHeader } from '@/components/shared/card'
import Notice from '@/components/shared/notice'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import SeatTile from '@/components/shared/seat-tile'
import Button from '@/components/shared/button'
import { RowActions } from '@/components/shared/row-actions'
import IconButton from '@/components/shared/icon-button'
import ListState from '@/components/shared/list-state'
import { PageFrame, PageFooter } from '@/components/templates/page-frame'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'

import StockListHeading from './stock-list-heading'
import { DetailColumns } from '@/components/templates/detail-columns'
import TimeField from '@/components/shared/time-field-v8'
import Checkbox from '@/components/shared/checkbox'
import Toggle from '@/components/shared/toggle'
import { DialogContentRow } from '@/components/shared/dialog-form-row'

import { useAccount } from '@/contexts/account-context'
import { useStaffRole } from '@/lib/staff-role'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { ApiError, fetchApi } from '@/lib/api'
import { restaurantTestApi, type RestaurantInventory, type RestaurantTable } from '@/lib/restaurant-test-api'
import { BoundaryBanner, QuietError, type RestaurantV8Context } from '@/v8/restaurant/booking-kit/public/shell/index'
import { DialogNote, RsDialog } from '@/v8/restaurant/booking-kit/public/parts/index'
import { dayLabel, formatTime, joinTableCodes, sanName, slotTimeLabel, tableOrder, WEEK_ORDER, WEEKDAY_LABEL } from './format'
import type { RestaurantChannel } from './channels'
import styles from './inventory.module.css'
import { Field } from '@/components/shared/form-controls'
import { emptyValue } from '@/components/shared/empty-value'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'


/*
 * ★V8 予約枠・在庫「時間帯ごとの在庫」タブ（板 `Y8SjT2`・競合 ・媒体を閉じる知らせ ）。
 *
 * 案内の帯 → 左：席と枠の配分（卓とつながる）→ 時間帯ごとの在庫の表 → 開ける時間
 * （先頭に「行を押したとき：その時間帯の配分だけ直す」の箱）、右：選んだ時間帯の卓 → 下の帯
 * （受付時間と配分を保存）。ほかの担当者が先に保存していたら（409）競合の帯を出し、
 * 比べてから保存するか、最新を読み込んで続ける。
 * データの口・送る形は今の画面（app/restaurant-test/v8/inventory.tsx）と同じ。動きは BEHAVIOR.md。
 */


const allocOf = (row: RestaurantInventory | undefined): Alloc =>
  row ? { ota: row.ota_capacity, line: row.line_capacity, walkin: row.walk_in_capacity } : { ota: 0, line: 0, walkin: 0 }

const emptyWeek = (): Hours => Array.from({ length: 7 }, (_, weekday) => ({ weekday, periods: [] }))

const periodsText = (day: RestaurantOpeningDay | undefined) =>
  day && day.periods.length > 0 ? day.periods.map((period) => `${period.opensAt}〜${period.closesAt}`).join('・') : '休み'

function storeToday(timezone: string | undefined): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'Asia/Tokyo' }).format(new Date())
}

function NumberField({ id, 'aria-describedby': describedBy, label, value, onChange, canEdit, invalid = false }: { id?: string; 'aria-describedby'?: string; label: string; value: number; onChange: (value: number) => void; canEdit: boolean; invalid?: boolean }) {
  return (
    <SaveErrorField names={["value"]}><NumberInput
      type="number"
      min={0}
      aria-label={label}
      value={String(value)}
      readOnly={!canEdit}
      disabled={!canEdit}
      invalid={invalid}
      onChange={(event) => { if (canEdit) onChange(Number(event.target.value)) }}
    /></SaveErrorField>
  )
}

export default function StockBoard({ ctx, canEdit: allowedByRole, heading, notice, tabs }: { ctx: RestaurantV8Context; canEdit: boolean; heading?: ReactNode; notice?: ReactNode; tabs: ReactNode }) {
  const role = useStaffRole()
  const lockedReason = usePermissionLockReason(allowedByRole)
  const canEdit = allowedByRole && !lockedReason
  const saveErrors = useSaveFormErrors()
  const { data, store, busy, mutate } = ctx
  const { selectedAccountId } = useAccount()
  const storeId = store?.id
  const tables = useMemo(
    () => (store ? data.tables.filter((item) => item.store_id === store.id) : data.tables),
    [data.tables, store],
  )
  const [asideExpanded, setAsideExpanded] = useState(false)
  const [date, setDate] = useState(() => storeToday(store?.timezone))
  const [dayRows, setDayRows] = useState<RestaurantInventory[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [hours, setHours] = useState<Hours | null>(null)
  const [hoursVersion, setHoursVersion] = useState(0)
  const [hoursDraft, setHoursDraft] = useState<Hours | null>(null)
  const [hoursError, setHoursError] = useState('')
  const [googleStatus, setGoogleStatus] = useState<RestaurantOpeningHours['googleStatus']>(null)
  const [channelsError,setChannelsError]=useState(false)
  const [channelsRetry,setChannelsRetry]=useState(0)
  const [channels, setChannels] = useState<RestaurantChannel[]>([])
  useEffect(() => {
    if (storeId && hours && window.location.hash === '#rs-hours-title') {
      const target = document.getElementById('rs-hours-title')
      if (target) {
        target.scrollIntoView?.({ block: 'start' })
        window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
      }
    }
  }, [storeId, hours])

  useEffect(() => {
    let current = true
    setDayRows(null); setLoadError('')
    if (!selectedAccountId || !storeId) return
    void restaurantTestApi.inventoryDay(selectedAccountId, storeId, date).then((res) => {
      if (current) setDayRows(Array.isArray(res.data) ? res.data : [])
    }).catch(() => { if (current) { setDayRows([]); setLoadError('在庫を読み込めませんでした。再読込してください。') } })
    return () => { current = false }
  }, [selectedAccountId, storeId, date, refresh])

  // 説明だけに取得元を保持する。既存の時間・版の反映や生成可否は変えない。
  const hoursScope = useRef({ accountId: selectedAccountId, storeId })
  const latestHoursRequest = useRef<object | null>(null)
  const [hoursReceipt, setHoursReceipt] = useState<{ scope: typeof hoursScope.current; request: object; hours: Hours; version: number } | null>(null)
  useLayoutEffect(() => {
    if (hoursScope.current.accountId !== selectedAccountId || hoursScope.current.storeId !== storeId) {
      hoursScope.current = { accountId: selectedAccountId, storeId }
    }
  }, [selectedAccountId, storeId])
  const loadHours = () => {
    const request = {}; latestHoursRequest.current = request
    const scope = hoursScope.current
    setHoursReceipt(null)
    if (!selectedAccountId || !storeId) return Promise.resolve()
    return restaurantTestApi.openingHours(selectedAccountId, storeId).then((res) => {
      const week = res.data.hours || emptyWeek()
      setHours(week); setHoursDraft(week); setHoursVersion(res.data.version); setGoogleStatus(res.data.googleStatus ?? null); setHoursError('')
      if (scope === hoursScope.current && request === latestHoursRequest.current && scope.accountId === selectedAccountId && scope.storeId === storeId && res.data.storeId === storeId) {
        setHoursReceipt({ scope, request, hours: week, version: res.data.version })
      }
      return res.data
    }).catch(() => { setHoursError('開ける時間を読み込めませんでした。再読込してください。') })
  }
  useEffect(() => {
    setHours(null); setHoursDraft(null); setHoursError(''); setGoogleStatus(null)
    void loadHours()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccountId, storeId])

  useEffect(() => {
    let current = true
    if (!selectedAccountId || !storeId) return
    void fetchApi<{ success: true; data: RestaurantChannel[] }>(
      `/api/restaurant-test/channels?account_id=${encodeURIComponent(selectedAccountId)}&storeId=${encodeURIComponent(storeId)}`,
    ).then((res) => { if (current) {if(!Array.isArray(res.data))throw new Error('invalid_channels');setChannels(res.data);setChannelsError(false)} }).catch(() => { if (current) setChannelsError(true) })
    return () => { current = false }
  }, [selectedAccountId, storeId,channelsRetry])

  const rows = useMemo(() => (dayRows ?? []).slice().sort((a, b) => a.starts_at.localeCompare(b.starts_at)), [dayRows])
  const reservations = useMemo(
    () => (store ? data.reservations.filter((item) => item.store_id === store.id) : data.reservations)
      .filter((item) => !['cancelled', 'no_show'].includes(item.status)),
    [data.reservations, store],
  )
  const tableById = useMemo(() => new Map(tables.map((item) => [item.id, item])), [tables])
  const activeTables = useMemo(() => tables.filter((item) => item.is_active), [tables])
  const stoppedTables = useMemo(() => tables.filter((item) => !item.is_active), [tables])
  const totalSeats = useMemo(() => activeTables.reduce((sum, item) => sum + item.max_capacity, 0), [activeTables])
  const missingHoursReason = canEdit && !busy && !hoursError && hoursReceipt && hoursReceipt.scope === hoursScope.current
    && hoursReceipt.scope.accountId === selectedAccountId && hoursReceipt.scope.storeId === storeId
    && hoursReceipt.request === latestHoursRequest.current && hoursReceipt.hours === hours && hoursReceipt.version === hoursVersion && hoursVersion === 0
    ? '開ける時間を設定して保存してください。' : undefined
  const confirmedTables = ctx.tableDefinition && ctx.tableDefinition.accountId === selectedAccountId && ctx.tableDefinition.snapshot === data
    && data.organization && storeId && data.stores.some(item => item.id === storeId)
  const noActiveTablesReason = canEdit && !busy && confirmedTables && activeTables.length === 0
    ? '有効な卓がありません。座席・卓管理で卓を有効にしてください。' : undefined


  /* 埋まっている卓：サーバが出した卓（occupiedTableIds）を優先し、無ければ予約台帳の予約から出す。 */
  const occupiedOf = (row: RestaurantInventory): Set<string> => {
    if (row.occupiedTableIds) return new Set(row.occupiedTableIds)
    const start = new Date(row.starts_at).getTime()
    const end = start + row.slot_minutes * 60_000
    const ids = new Set<string>()
    for (const item of reservations) {
      if (!item.table_id) continue
      const from = new Date(item.starts_at).getTime()
      const to = new Date(item.ends_at).getTime()
      if (!Number.isNaN(from) && !Number.isNaN(to) && from < end && to > start) ids.add(item.table_id)
    }
    return ids
  }

  const slots: SlotInfo[] = rows.map((row) => {
    const start = new Date(row.starts_at).getTime()
    const end = start + row.slot_minutes * 60_000
    const overlapping = Number.isNaN(start) ? [] : reservations.filter((item) => {
      const from = new Date(item.starts_at).getTime()
      const to = new Date(item.ends_at).getTime()
      return !Number.isNaN(from) && !Number.isNaN(to) && from < end && to > start
    })
    const occupied = [...occupiedOf(row)].map((id) => tableById.get(id)).filter((item): item is RestaurantTable => Boolean(item))
    const seats = row.occupied_seats ?? overlapping.reduce((sum, item) => sum + item.guest_count, 0)
    const free = row.freeSeats ?? Math.max(0, totalSeats - seats)
    return { row, time: slotTimeLabel(row.starts_at, store?.timezone), seats, tables: occupied, free, ratio: totalSeats > 0 ? seats / totalSeats : 0 }
  })

  const [selectedId, setSelectedId] = useState('')
  const selected = slots.find((slot) => slot.row.id === selectedId)
    ?? slots.slice().sort((a, b) => b.ratio - a.ratio)[0] ?? null

  // 上の配分は、利用者が触るまで先頭の時間帯の値を写す（読み込み前に0で固めない）。
  const [allocVersions, setAllocVersions] = useState<Array<{ id: string; expectedVersion: number }> | null>(null)
  const [allocOverride, setAllocOverride] = useState<Alloc | null>(null)
  const alloc: Alloc = allocOverride ?? allocOf(rows[0])
  const [slotAlloc, setSlotAlloc] = useState<Alloc | null>(null)
  const [slotVersion, setSlotVersion] = useState<number | undefined>(undefined)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  // 板 ：残りが少ない時間帯の「媒体を閉じる知らせ」。記録はこの画面だけで持ち、媒体へは書き戻さない。
  const [closeNoteOpen, setCloseNoteOpen] = useState(false)
  const [closedSlots, setClosedSlots] = useState<string[]>([])
  const [closedChannels, setClosedChannels] = useState<string[]>([])

  const currentSlotAlloc: Alloc = slotAlloc ?? allocOf(selected?.row)
  const allocInvalid = alloc.ota + alloc.line + alloc.walkin > totalSeats
  const slotInvalid = selected ? currentSlotAlloc.ota + currentSlotAlloc.line + currentSlotAlloc.walkin > selected.row.total_capacity : true
  const remainder = totalSeats - alloc.ota - alloc.line - alloc.walkin
  const lowSlot = (slot: SlotInfo) => slot.free / Math.max(totalSeats, 1) < 0.2

  const updateAlloc = (next: Alloc) => {
    if (!allocVersions) setAllocVersions(rows.map((r) => ({ id: r.id, expectedVersion: r.version ?? 0 })))
    setAllocOverride(next)
  }
  const updateSlot = (next: Alloc) => {
    if (slotVersion === undefined) setSlotVersion(selected?.row.version)
    setSlotAlloc(next)
  }
  const resetAll = () => {
    setAllocOverride(null); setAllocVersions(null); setSlotAlloc(null); setSlotVersion(undefined)
    setHoursDraft(hours)
  }
  const changeDate = (next: string) => {
    setDate(next); setAllocOverride(null); setAllocVersions(null); setSlotAlloc(null); setSlotVersion(undefined); setSelectedId('')
  }

  /*
   * 配分（上の欄・時間帯ごと）と開ける時間は、下の帯の「保存」まで画面にしか無い。
   * 触ったまま左メニューなどで離れると消えるので、離れる前に確かめる。保存・キャンセルで外れる。
   */
  const hoursChanged = hours !== null && hoursDraft !== null && JSON.stringify(hoursDraft) !== JSON.stringify(hours)
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({
    dirty: canEdit && (allocOverride !== null || slotAlloc !== null || hoursChanged),
    busy,
  })

  /* 409 のあと：最新を読み直し、誰がいつ保存したかと、違う所（配分・曜日の開ける時間）を出す。 */
  const raiseConflict = async (attemptedAlloc: Alloc | null, attemptedHours: Hours | null) => {
    let latestRows: RestaurantInventory[] = rows
    let latestHours: Hours | null = hours
    let hoursBy: string | null = null
    let hoursAt: string | null = null
    if (selectedAccountId && storeId) {
      try { latestRows = (await restaurantTestApi.inventoryDay(selectedAccountId, storeId, date)).data } catch (saveFailure) {
        saveErrors.capture(saveFailure) /* 今の行のまま */ }
      try {
        const res = await restaurantTestApi.openingHours(selectedAccountId, storeId)
        latestHours = res.data.hours || emptyWeek()
        hoursBy = res.data.updatedBy
        hoursAt = res.data.updatedAt
      } catch (saveFailure) {
        saveErrors.capture(saveFailure) /* 今の時間のまま */ }
    }
    const newest = latestRows.slice().sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))[0]
    const memberName = (id: string | null) => data.memberships.find((member) => member.id === id)?.staff_name ?? null
    const who = attemptedHours && !attemptedAlloc ? memberName(hoursBy) : newest?.updated_by_name ?? memberName(newest?.updated_by ?? null) ?? memberName(hoursBy)
    const at = attemptedHours && !attemptedAlloc ? hoursAt : newest?.updated_at ?? hoursAt
    const changedDays = attemptedHours && latestHours
      ? WEEK_ORDER.filter((weekday) => periodsText(latestHours?.find((d) => d.weekday === weekday)) !== periodsText(hours?.find((d) => d.weekday === weekday)))
      : []
    const latestAlloc = allocOf(latestRows[0])
    const allocChanged = attemptedAlloc ? JSON.stringify(latestAlloc) !== JSON.stringify(allocOf(rows[0])) : false
    const scope = [
      ...(changedDays.length > 0 ? [`${changedDays.map((weekday) => `${WEEKDAY_LABEL[weekday]}曜`).join('・')}の開ける時間`] : []),
      ...(allocChanged ? ['配分'] : []),
    ].join('と') || '保存した内容'
    setConflict({ who: sanName(who), at: formatTime(at, store?.timezone), scope, attemptedAlloc, attemptedHours })
  }

  /* 下の帯の保存：配分（全部の時間帯）→ 開ける時間。どちらかで 409 なら競合の帯。 */
  const saveAll = (force = false) => {
    if (!canEdit || busy || !selectedAccountId || !store || allocInvalid) return
    const attemptedAlloc = rows.length > 0 ? { ...alloc } : null
    const attemptedHours = hoursChanged ? hoursDraft : null
    void mutate(async () => {
      try {
        if (attemptedAlloc) {
          const latest = force && selectedAccountId ? (await restaurantTestApi.inventoryDay(selectedAccountId, store.id, date)).data : null
          const slotsToSave = latest
            ? latest.map((r) => ({ id: r.id, expectedVersion: r.version ?? 0 }))
            : allocVersions || rows.map((r) => ({ id: r.id, expectedVersion: r.version ?? 0 }))
          await restaurantTestApi.saveInventoryAllocation(selectedAccountId, { storeId: store.id, slots: slotsToSave, otaCapacity: attemptedAlloc.ota, lineCapacity: attemptedAlloc.line, walkInCapacity: attemptedAlloc.walkin })
        }
        if (attemptedHours) {
          const version = force ? (await restaurantTestApi.openingHours(selectedAccountId, store.id)).data.version : hoursVersion
          const res = await restaurantTestApi.saveOpeningHours(selectedAccountId, { storeId: store.id, hours: attemptedHours, expectedVersion: version })
          setHoursVersion(res.data.version); setHours(attemptedHours)
        }
      } catch (err) {
        saveErrors.capture(err);

        if (err instanceof ApiError && err.status === 409) {
          await raiseConflict(attemptedAlloc, attemptedHours)
          /* 知らせは競合の帯が持つ（上の帯は重ねない）。 */
          throw new QuietError('conflict')
        }
        throw err
      }
    }, '受付時間と配分を保存しました。予約サイトへは書き戻していません。').then((ok) => {
      if (ok) { setConflict(null); setDiffOpen(false); setAllocOverride(null); setAllocVersions(null); setRefresh((n) => n + 1) }
    })
  }

  const generateSlots = () => {
    if (!selectedAccountId || !store || !canEdit || busy || !hoursVersion || allocInvalid) return
    void mutate(() => restaurantTestApi.generateInventory(selectedAccountId, { storeId: store.id, date, expectedHoursVersion: hoursVersion, otaCapacity: alloc.ota, lineCapacity: alloc.line, walkInCapacity: alloc.walkin }), '30分ごとの枠を作りました。').then((ok) => { if (ok) setRefresh((n) => n + 1) })
  }

  const saveSlot = () => {
    if (!canEdit || busy || !selectedAccountId || !selected || slotInvalid) return
    const attempt = { ...currentSlotAlloc }
    void mutate(async () => {
      try {
        await restaurantTestApi.updateInventory(selectedAccountId, selected.row.id, { otaCapacity: attempt.ota, lineCapacity: attempt.line, walkInCapacity: attempt.walkin, expectedVersion: slotVersion ?? selected.row.version })
      } catch (err) {
        saveErrors.capture(err);

        if (err instanceof ApiError && err.status === 409) {
          await raiseConflict(attempt, null)
          throw new QuietError('conflict')
        }
        throw err
      }
    }, `${selected.time} の配分だけ保存しました。予約サイトへは書き戻していません。`).then((ok) => {
      if (ok) { setSlotAlloc(null); setSlotVersion(undefined); setRefresh((n) => n + 1) }
    })
  }

  const reloadLatest = () => {
    setConflict(null); setDiffOpen(false); resetAll(); setRefresh((n) => n + 1)
    void loadHours()
    void ctx.reload()
  }

  const occupiedIds = selected ? occupiedOf(selected.row) : new Set<string>()
  const freeTables = activeTables.filter((item) => !occupiedIds.has(item.id))
  const bestTable = freeTables.slice().sort((a, b) => b.max_capacity - a.max_capacity)[0] ?? null
  const gridTables = tables.slice().sort((a, b) => a.floor_y - b.floor_y || a.floor_x - b.floor_x || tableOrder(a, b))
  /* 閉じる先は、メール転送で今も予約が届いている媒体（受付を各媒体の管理画面で閉じるもの）。 */
  const closingChannels = channels.filter((channel) => channel.receiveMethod === 'email_forward' && channel.status === 'receiving')
  const canCloseNote = Boolean(selected && lowSlot(selected) && !closedSlots.includes(selected.row.id))

  const setDay = (weekday: number, next: RestaurantOpeningDay['periods']) => {
    if (!canEdit) return
    setHoursDraft((current) => (current ?? emptyWeek()).map((day) => (day.weekday === weekday ? { ...day, periods: next } : day)))
  }

  return (
    <PageFrame kind="restaurant" standalone heightMode="viewport" boardId="Y8SjT2" hasFooter>
      {heading}
      <SaveErrorScope errors={saveErrors}><>
      <div className={styles.stockBody} data-template-region="body">
      <BoundaryBanner />
      {notice}
      {tabs}
      {role !== null && !canEdit ? <ReadOnlyNotice /> : null}
      {channelsError?<ListState kind="error" title="予約サイトを読み込めませんでした" onRetry={()=>setChannelsRetry(n=>n+1)}/>:null}
      {loadError ? (
        <Notice tone="warn" message={loadError} action={<Button onClick={() => setRefresh((n) => n + 1)}>もう一度読み込む</Button>} />
      ) : null}
      {conflict ? (
        <SaveConflictBand
          title={`${conflict.who}が${conflict.at ? ` ${conflict.at} に` : ''}予約枠・在庫を保存しました`}
          description={`このまま保存すると、${conflict.who}の変更（${conflict.scope}）が消えます`}
          onCompare={() => setDiffOpen(true)} onReload={reloadLatest} />
      ) : null}
      <DetailColumns variant="restaurant-inventory" asideLabel="この時間帯の卓を見る" expanded={asideExpanded} onExpandedChange={setAsideExpanded} aside={<DetailPreview title={selected ? `${selected.time} の卓` : '空席の状況'} description={'赤＝埋まっている・白＝空き・灰＝停止中'} actions={{primary: ((selected) ? <Button variant="primary" title={`予約台帳で ${selected.time} を見る`} aria-label={`予約台帳を見る（${selected.time}）`} href={`/restaurant-test/reservations?date=${encodeURIComponent(date)}`}>予約台帳</Button> : null),secondary: ((selected) && (canCloseNote) ? <Button variant="secondary" lockedReason={lockedReason} disabled={!canEdit} onClick={() => { if (!canEdit) return; setClosedChannels([]); setCloseNoteOpen(true) }}>媒体の受付を閉じる</Button> : null)}}>
          <DetailSection>

            {gridTables.length === 0 ? (
              <ListState kind="empty" emptyPreset="readonly" title="卓がありません。座席・卓管理で追加してください。" description="卓を追加すると、ここに空きと利用状況が出ます。" action={<Button href="/restaurant-test/tables">座席・卓管理を開く</Button>} />
            ) : <ul className={styles.tablesGrid}>
              {gridTables.map((item) => {
                const occupied = occupiedIds.has(item.id)
                return (
                  <li key={item.id}>
                    <SeatTile presentation="occupancy" code={item.code} capacity={`${item.max_capacity}名`} stopped={!item.is_active} occupied={Boolean(item.is_active) && occupied}
                      aria-label={`${item.code} ${item.max_capacity}名${!item.is_active ? '（停止中）' : occupied ? '（埋まっている）' : '（空き）'}`} />
                  </li>
                )
              })}
            </ul>}
            {selected ? (
              <div className={styles.freeInfo}>
                {bestTable ? (
                  <>
                    <p className={styles.freeTitle}>{`空き：${bestTable.code}（${bestTable.label} ${bestTable.max_capacity}名）`}</p>
                    <p className={styles.freeSub}>{`${selected.time} に ${bestTable.max_capacity}名までなら受けられます`}</p>
                  </>
                ) : <p className={styles.freeTitle}>空きの卓がありません</p>}
              </div>
            ) : null}

          </DetailSection>
        </DetailPreview>} asideLayout="detail">
        <div className={styles.mainColumn}>
          <Card layout="vertical" padding="spacious" gap="tight" surface="standard" aria-labelledby="rs-alloc-title">
            <CardHeader size="stacked" titleId="rs-alloc-title" title="席と枠の配分（卓とつながる）" meta="総数は「座席・卓管理」の有効な卓から自動で決まります。ここで入れた配分を全部の時間帯に入れ、時間帯ごとに直すときは下の表の行を押します。" />
            <div className={styles.totalLine}>
              <Armchair size={16} aria-hidden="true" className={styles.totalIcon} />
              <div className={styles.totalText}>
                <p className={styles.totalValue}>{`1つの時間帯の総数 ${totalSeats}席`}</p>
                <p className={styles.totalSub}>{`有効な卓 ${activeTables.length} 卓${stoppedTables.length > 0 ? `（${stoppedTables.map((item) => item.code).join('・')} は停止中のため除く）` : ''}`}</p>
              </div>
              <Button variant="text" size="inline" href="/restaurant-test/tables">座席・卓管理で変える →</Button>
            </div>
            {noActiveTablesReason ? <DialogNote>{noActiveTablesReason}</DialogNote> : null}
            <div className={styles.allocGrid}>
              <Field label={<><span className={styles.allocLabel}>予約サイト</span></>}><SaveErrorField names={["ota","alloc.ota"]}><NumberField canEdit={canEdit} invalid={allocInvalid} label="予約サイト" value={alloc.ota} onChange={(ota) => updateAlloc({ ...alloc, ota })} /></SaveErrorField></Field>
              <Field label={<><span className={styles.allocLabel}>LINE 専用</span></>}><SaveErrorField names={["line","alloc.line"]}><NumberField canEdit={canEdit} invalid={allocInvalid} label="LINE 専用" value={alloc.line} onChange={(line) => updateAlloc({ ...alloc, line })} /></SaveErrorField></Field>
              <Field label={<><span className={styles.allocLabel}>当日（ウォークイン）</span></>}><SaveErrorField names={["walkin","alloc.walkin"]}><NumberField canEdit={canEdit} invalid={allocInvalid} label="当日（ウォークイン）" value={alloc.walkin} onChange={(walkin) => updateAlloc({ ...alloc, walkin })} /></SaveErrorField></Field>
              <div className={styles.allocField}><span className={styles.allocLabel}>店頭・電話</span>
                <span className={styles.remainder}>{`${remainder}（残り）`}</span>
              </div>
            </div>
            <p className={`${styles.note} ${allocInvalid ? styles.noteInvalid : ''}`}>予約サイト・LINE・当日の合計が総数を超えると保存できません。予約サイトへは書き戻しません（検証中）</p>
          </Card>
          <Card layout="vertical" padding="spacious" gap="tight" surface="standard" aria-labelledby="rs-stock-title">
            <StockListHeading date={date} busy={busy} onChange={changeDate}>
              {slots.length > 0 ? <RowActions subjectName="時間帯ごとの在庫" menuButtonProps={{ disabled: busy || !hoursVersion || allocInvalid, 'aria-description': missingHoursReason }} menuItems={[{ id: 'generate', label: 'この日の枠を作る', lockedReason, disabled: !canEdit, onSelect: generateSlots }]} /> : null}
            </StockListHeading>
            {missingHoursReason ? <DialogNote>{missingHoursReason}{' '}<Button variant="text" size="inline" href={googleStatus !== null ? '/restaurant-test/google?tab=hours' : '#rs-hours-title'}>開ける時間を設定する</Button></DialogNote> : null}
            {dayRows === null ? (
              <div className={styles.stateBox}><ListState kind="loading" /></div>
            ) : slots.length === 0 ? (
              <div className={styles.stateBox}>
                <ListState
                  kind="empty"
                  title="この日の時間帯がありません"
                  description="開ける時間から、30分ごとの枠を作れます。今ある枠は残します。"
                  action={(
                    <Button
                      variant="primary"
                      lockedReason={lockedReason}
                      disabled={!canEdit || busy || !hoursVersion || allocInvalid}
                      aria-description={missingHoursReason}
                      onClick={generateSlots}
                    >この日の枠を作る</Button>
                  )}
                />
              </div>
            ) : (
              <DataTable presentation="inventory">
                <thead>
                  <TableHeadRow>
                    <Th truncate className={styles.colTime}>時間</Th>
                    <Th truncate className={styles.colUse}>利用状況</Th>
                    <Th truncate className={styles.colSeats} align="right">席数</Th>
                    <Th truncate className={styles.colTables}>埋まっている卓</Th>
                    <Th truncate className={styles.colFree} align="right">空き</Th>
                  </TableHeadRow>
                </thead>
                <tbody>
                  {slots.map((slot) => (
                    <Tr
                      key={slot.row.id}
                      selected={selected?.row.id === slot.row.id}
                      interactive
                      onClick={() => { setSelectedId(slot.row.id); setSlotAlloc(null); setSlotVersion(undefined) }}
                    >
                      <Td>
                        <Button variant="text" size="compact" fullWidth presentation="row-action" textTone="ink" data-part="row-name" aria-pressed={selected?.row.id === slot.row.id} onClick={(event) => { event.stopPropagation(); setSelectedId(slot.row.id); setSlotAlloc(null); setSlotVersion(undefined) }}>{slot.time}</Button>
                      </Td>
                      <Td>
                        <svg className={styles.useBar} role="img" aria-label={`利用率 ${Math.round(slot.ratio * 100)}％`} viewBox="0 0 120 8" preserveAspectRatio="none">
                          <rect className={styles.useTrack} x="0" y="0" width="120" height="8" rx="4" />
                          <rect
                            className={slot.ratio >= 0.7 ? styles.useFillBusy : styles.useFill}
                            x="0"
                            y="0"
                            width={Math.max(4, Math.min(120, Math.round(slot.ratio * 120)))}
                            height="8"
                            rx="4"
                          />
                        </svg>
                      </Td>
                      <Td className={`${styles.colSeats} ${styles.strong}`} align="right">{`${slot.seats}席`}</Td>
                      <Td className={styles.tablesCell}><span title={joinTableCodes(slot.tables)}>{joinTableCodes(slot.tables) || emptyValue('unknown')}</span></Td>
                      <Td className={`${styles.colFree} ${styles.bold}`} align="right"><span className={lowSlot(slot) ? styles.freeLow : undefined}>{`${slot.free}席`}</span></Td>
                    </Tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Card>
          <Card layout="vertical" padding="spacious" gap="tight" surface="standard" aria-labelledby="rs-hours-title">
            {selected && !conflict ? (
              <Card layout="vertical" padding="default" gap="tight" surface="inset" aria-label={`${selected.time} の配分だけ直す`}>
                <h3 className={styles.sectionTitle}>{`行を押したとき：${selected.time} の配分だけ直す`}</h3>
                <div className={styles.slotGrid}>
                  <Field label={<><span className={styles.slotLabel}>予約サイト</span></>}><SaveErrorField names={["ota","currentSlotAlloc.ota"]}><NumberField canEdit={canEdit} invalid={slotInvalid} label={`${selected.time}の予約サイト`} value={currentSlotAlloc.ota} onChange={(ota) => updateSlot({ ...currentSlotAlloc, ota })} /></SaveErrorField></Field>
                  <Field label={<><span className={styles.slotLabel}>LINE 専用</span></>}><SaveErrorField names={["line","currentSlotAlloc.line"]}><NumberField canEdit={canEdit} invalid={slotInvalid} label={`${selected.time}のLINE`} value={currentSlotAlloc.line} onChange={(line) => updateSlot({ ...currentSlotAlloc, line })} /></SaveErrorField></Field>
                  <Field label={<><span className={styles.slotLabel}>当日（ウォークイン）</span></>}><SaveErrorField names={["walkin","currentSlotAlloc.walkin"]}><NumberField canEdit={canEdit} invalid={slotInvalid} label={`${selected.time}の当日`} value={currentSlotAlloc.walkin} onChange={(walkin) => updateSlot({ ...currentSlotAlloc, walkin })} /></SaveErrorField></Field>
                </div>
                <div className={styles.slotActions}>
                  <span className={styles.slotBase}>{`全部の時間帯の配分：予約サイト ${alloc.ota}・LINE ${alloc.line}・当日 ${alloc.walkin}（上で入れた数）`}</span>
                  <Button lockedReason={lockedReason} disabled={!canEdit} onClick={() => { if (canEdit) updateSlot({ ...alloc }) }}>全体の配分に戻す</Button>
                  <Button lockedReason={lockedReason} variant="primary" disabled={!canEdit || busy || slotInvalid} onClick={saveSlot}>この時間帯だけ保存</Button>
                </div>
              </Card>
            ) : null}
            <CardHeader size="stacked" titleId="rs-hours-title" title="開ける時間" meta={googleStatus !== null ? 'Googleビジネスの営業時間を基準にします。予約枠と席の配分は、この画面で設定します。' : '曜日ごとに予約を受ける時間を決めます（予約設定の受付枠と同じ決め方。違うのは、受けられる数が「人」ではなく「席」で決まること）'} />
            {hoursError ? <Notice tone="danger" className={styles.hoursErrorNoticePlacement} >{hoursError}</Notice> : null}
            {googleStatus !== null ? <>
              <Notice tone={googleStatus === 'connected' ? 'info' : 'warn'}>営業時間の変更は Googleビジネスで行います。接続に問題がある場合は、接続画面で確認してください。</Notice>
              <Button variant="text" href="/restaurant-test/google?tab=hours">Googleビジネスの営業時間を開く →</Button>
              {hours?.map((day) => <p key={day.weekday}>{WEEKDAY_LABEL[day.weekday]}曜日：{periodsText(day)}</p>)}
            </> : hoursDraft ? WEEK_ORDER.map((weekday) => {
              const day = hoursDraft.find((item) => item.weekday === weekday) ?? { weekday, periods: [] }
              const open = day.periods.length > 0
              const name = WEEKDAY_LABEL[weekday]
              return (
                <div key={weekday} className={styles.dayRow}>
                  <div className={styles.dayHead}>
                    {/* 閲覧時は現在の受付状態と時刻を読み、変更ボタンは理由付きで残す。 */}
                    <SaveErrorField names={["open","day"]}><Toggle
                        checked={open}
                        disabled={!canEdit}
                        lockedReason={lockedReason}
                        label={`${name}曜日に予約を受ける`}
                        onChange={(next) => setDay(weekday, next ? [{ opensAt: '17:00', closesAt: '22:00' }] : [])}
                      /></SaveErrorField>
                    <span className={styles.dayName}>{name}</span>
                  </div>
                  {open ? (
                    <div className={styles.dayPeriods}>
                      {day.periods.map((period, index) => (
                        <div key={index} className={styles.period}>
                          {canEdit ? <>
                            <span className={styles.timeInput}>
                              <SaveErrorField names={[`periods.${index}.opensAt`,`periods.${index}.opens_at`,"opensAt","period.opensAt","day","opens_at","period.opens_at"]}><TimeField
                                aria-label={`${name}曜日 ${index + 1}つ目の開始`}
                                minuteStep={30}
                                size="default"
                                value={period.opensAt}
                                onChange={(value) => setDay(weekday, day.periods.map((p, i) => (i === index ? { ...p, opensAt: value } : p)))}
                              /></SaveErrorField>
                            </span>
                            <span className={styles.tilde}>〜</span>
                            <span className={styles.timeInput}>
                              <SaveErrorField names={[`periods.${index}.closesAt`,`periods.${index}.closes_at`,"closesAt","period.closesAt","day","closes_at","period.closes_at"]}><TimeField
                                allowEndOfDay
                                aria-label={`${name}曜日 ${index + 1}つ目の終了`}
                                minuteStep={30}
                                size="default"
                                value={period.closesAt}
                                onChange={(value) => setDay(weekday, day.periods.map((p, i) => (i === index ? { ...p, closesAt: value } : p)))}
                              /></SaveErrorField>
                            </span>
                          </> : (
                            <span aria-label={`${name}曜日 ${index + 1}つ目の時間帯`}>{`${period.opensAt}〜${period.closesAt}`}</span>
                          )}
                          <IconButton lockedReason={lockedReason} disabled={!canEdit} variant="plain" size="row" aria-label={`${name}曜日の${index + 1}つ目の時間帯を外す`} onClick={() => setDay(weekday, day.periods.filter((_, i) => i !== index))}>
                              <X size={16} aria-hidden="true" />
                          </IconButton>
                        </div>
                      ))}
                      <Button variant="text" lockedReason={lockedReason} disabled={!canEdit} onClick={() => setDay(weekday, [...day.periods, { opensAt: '17:00', closesAt: '22:00' }])}>＋ 時間帯を足す</Button>
                    </div>
                  ) : (
                    <p className={styles.dayClosed}>休み（定休日）・お客さまの画面に出ません</p>
                  )}
                </div>
              )
            }) : hoursError ? null : <ListState kind="loading" />}
          </Card>
        </div>
      </DetailColumns>
      </div>
      <PageFooter
          actions={(
            <>
              <Button lockedReason={lockedReason} onClick={resetAll} disabled={!canEdit || busy}>キャンセル</Button>
              {conflict ? (
                <Button lockedReason={lockedReason} variant="primary" disabled={!canEdit || busy} onClick={() => setDiffOpen(true)}><Check size={16} aria-hidden="true" />比べてから保存</Button>
              ) : (
                <Button lockedReason={lockedReason} variant="primary" disabled={!canEdit || busy || allocInvalid || (!hoursDraft && rows.length === 0) || (allocOverride === null && !hoursChanged)} disabledReason={allocOverride === null && !hoursChanged ? "変更していません" : undefined} onClick={() => saveAll(false)}><Check size={16} aria-hidden="true" />受付時間と配分を保存</Button>
              )}
            </>
          )}
        />
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="配分と開ける時間の変更" onConfirm={confirmLeave} onCancel={cancelLeave} />
      <RsDialog
        open={closeNoteOpen && Boolean(selected)}
        title={selected ? `${selected.time} が残り ${selected.free} 席になりました` : ''}
        width={540}
        top={200}
        designNode="Yyw6i"
        onCancel={() => setCloseNoteOpen(false)}
        actions={(
          <>
            <Button onClick={() => setCloseNoteOpen(false)}>あとで</Button>
            <Button
              variant="primary"
              lockedReason={lockedReason}
              disabled={!canEdit || closedChannels.length === 0}
              title={closedChannels.length === 0 ? '閉じた媒体にチェックを入れてください' : undefined}
              onClick={() => { if (!canEdit) return; if (selected) setClosedSlots((current) => [...current, selected.row.id]); setCloseNoteOpen(false) }}
            >
              <Check size={16} aria-hidden="true" />閉じたものを記録する
            </Button>
          </>
        )}
      >
        <p className={styles.dialogLead}>席が少なくなりました。媒体の受付は、各媒体の管理画面で閉じてください。閉じたものに印を付けて記録します。</p>
        {closingChannels.length === 0 ? (
          <DialogNote>受け取っている予約サイトがありません。「予約経路の連携」で確かめてください。</DialogNote>
        ) : (
          <div className={styles.checkList}>
            {closingChannels.map((channel) => (
              <DialogContentRow key={channel.id}><Checkbox checked={closedChannels.includes(channel.id)}
                onCheckedChange={(checked) => setClosedChannels((current) => (checked ? [...current, channel.id] : current.filter((item) => item !== channel.id)))}>
                {`${channel.name} の ${dayLabel(date).split('・')[0]} ${selected?.time ?? ''} を閉じた`}</Checkbox></DialogContentRow>
            ))}
          </div>
        )}
        <DialogNote>記録はこの画面だけに残ります。予約サイトへは書き戻しません（検証環境は受信専用）。閉じ忘れのまま予約が入ったら、予約台帳で重なった予約として確かめてください。</DialogNote>
      </RsDialog>
      <RsDialog
        open={diffOpen && Boolean(conflict)}
        title="保存しようとした内容と最新の内容"
        width={560}
        top={200}
        busy={busy}
        onCancel={() => setDiffOpen(false)}
        actions={(
          <>
            <Button onClick={reloadLatest} disabled={busy}>最新を読み込んで続ける</Button>
            <Button lockedReason={lockedReason} variant="primary" disabled={!canEdit || busy} onClick={() => saveAll(true)}>このまま保存する</Button>
          </>
        )}
      >
        {conflict ? <ConflictDiff conflict={conflict} latestAlloc={allocOf(rows[0])} latestHours={hours} /> : null}
      </RsDialog>
    </></SaveErrorScope>
    </PageFrame>
  )
}

function ConflictDiff({ conflict, latestAlloc, latestHours }: { conflict: Conflict; latestAlloc: Alloc; latestHours: Hours | null }) {
  const lines: Array<{ label: string; mine: string; latest: string }> = []
  if (conflict.attemptedAlloc) {
    lines.push({ label: '予約サイト', mine: String(conflict.attemptedAlloc.ota), latest: String(latestAlloc.ota) })
    lines.push({ label: 'LINE 専用', mine: String(conflict.attemptedAlloc.line), latest: String(latestAlloc.line) })
    lines.push({ label: '当日（ウォークイン）', mine: String(conflict.attemptedAlloc.walkin), latest: String(latestAlloc.walkin) })
  }
  if (conflict.attemptedHours) {
    for (const weekday of WEEK_ORDER) {
      const mine = periodsText(conflict.attemptedHours.find((day) => day.weekday === weekday))
      const latest = periodsText(latestHours?.find((day) => day.weekday === weekday))
      if (mine !== latest) lines.push({ label: `${WEEKDAY_LABEL[weekday]}曜の開ける時間`, mine, latest })
    }
  }
  return (
    <DataTable className={styles.diffTable}>
      <thead>
        <TableHeadRow>
          <Th>項目</Th>
          <Th>保存しようとした内容</Th>
          <Th>最新</Th>
        </TableHeadRow>
      </thead>
      <tbody>
        {lines.map((line) => (
          <Tr key={line.label}><Td>{line.label}</Td><Td>{line.mine}</Td><Td>{line.latest}</Td></Tr>
        ))}
      </tbody>
    </DataTable>
  )
}
