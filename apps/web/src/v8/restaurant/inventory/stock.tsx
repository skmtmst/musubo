'use client'
import { DetailPreview, DetailSection } from '@/components/shared/detail-content'
import type { Alloc, Hours, SlotInfo, Conflict } from './stock-types'
import { SaveConflictBand } from '@/components/shared/save-conflict'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Armchair, Check, X } from 'lucide-react'
import type { RestaurantFloor, RestaurantOpeningDay, RestaurantOpeningHours } from '@line-crm/shared'
import { reservationBoardApi } from '@/lib/api/helpers/reservation-board'
import { groupTablesByFloor } from './table-groups'
import Card, { CardHeader } from '@/components/shared/card'
import Notice from '@/components/shared/notice'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import SeatTile from '@/components/shared/seat-tile'
import Button from '@/components/shared/button'
import IconButton from '@/components/shared/icon-button'
import ListState from '@/components/shared/list-state'
import { PageFrame, PageFooter } from '@/components/templates/page-frame'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import TruncatedText from '@/components/shared/truncated-text'

import StockListHeading from './stock-list-heading'
import { DetailColumns } from '@/components/templates/detail-columns'
import TimeField from '@/components/shared/time-field-v8'
import Checkbox from '@/components/shared/checkbox'
import Toggle from '@/components/shared/toggle'
import { DialogContentRow } from '@/components/shared/dialog-form-row'

import { useAccount } from '@/contexts/account-context'
import { useStaffRole } from '@/lib/staff-role'
import { emitGuideSignal } from '@/v8/onboarding/public/guide-overlay/index'
import { useSharedGuide } from '@/v8/onboarding/public/guide-shared/index'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { ApiError, fetchApi } from '@/lib/api'
import { restaurantTestApi, type RestaurantInventory, type RestaurantInventoryAllocation, type RestaurantInventoryAllocationState, type RestaurantInventoryAllocationWrite, type RestaurantTable } from '@/lib/restaurant-test-api'
import { BoundaryBanner, QuietError, type RestaurantV8Context } from '@/v8/restaurant/booking-kit/public/shell/index'
import { DialogNote, RsDialog } from '@/v8/restaurant/booking-kit/public/parts/index'
import { dayLabel, formatTime, joinTableCodes, sanName, slotTimeLabel, WEEK_ORDER, WEEKDAY_LABEL } from './format'
import type { RestaurantChannel } from './channels'
import styles from './inventory.module.css'
import { AllocationDialog, GuideAllocationCard, StandardAllocationCard, validAllocation } from './allocation-controls'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'


const emptyAllocation: Alloc = { ota: 0, line: 0, walkin: 0 }
const allocationOf = (allocation: RestaurantInventoryAllocation | undefined | null): Alloc => allocation
  ? { ota: allocation.otaCapacity, line: allocation.lineCapacity, walkin: allocation.walkInCapacity }
  : emptyAllocation
const rowAllocation = (row: RestaurantInventory | undefined): Alloc => row
  ? { ota: row.ota_capacity, line: row.auto_line_original ?? row.line_capacity, walkin: row.walk_in_capacity }
  : emptyAllocation
const allocationLabels = { standard: '基本配分', day: 'この日だけ', slot: 'この時間だけ', legacy: '保存済み' }
type AllocationEditor = {
  scope: RestaurantInventoryAllocationWrite['scope']
  allocation: Alloc
  initial: Alloc
  time?: string
  startsAt?: string
  canRestore: boolean
  restoreLabel: string
}
const emptyWeek = (): Hours => Array.from({ length: 7 }, (_, weekday) => ({ weekday, periods: [] }))

const periodsText = (day: RestaurantOpeningDay | undefined) =>
  day && day.periods.length > 0 ? day.periods.map((period) => `${period.opensAt}〜${period.closesAt}`).join('・') : '休み'

function storeToday(timezone: string | undefined): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'Asia/Tokyo' }).format(new Date())
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
  const [floors, setFloors] = useState<RestaurantFloor[]>([])
  const [floorError, setFloorError] = useState(false)
  const [floorRetry, setFloorRetry] = useState(0)
  useEffect(() => { setFloors([]); setFloorError(false) }, [selectedAccountId, storeId])
  useEffect(() => { let active = true; setFloorError(false); if (selectedAccountId && storeId) void reservationBoardApi.floors(selectedAccountId, storeId).then(result => { if (active) setFloors(result.data) }).catch(() => { if (active) setFloorError(true) }); return () => { active = false } }, [selectedAccountId, storeId, data.tables, floorRetry])
  const [asideExpanded, setAsideExpanded] = useState(false)
  const [date, setDate] = useState(() => storeToday(store?.timezone))
  const [dayRows, setDayRows] = useState<RestaurantInventory[] | null>(null)
  const [allocationState, setAllocationState] = useState<RestaurantInventoryAllocationState | null>(null)
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
    setDayRows(null); setAllocationState(null); setLoadError('')
    if (!selectedAccountId || !storeId) return
    void restaurantTestApi.inventoryDay(selectedAccountId, storeId, date).then((res) => {
      if (current) {
        setDayRows(Array.isArray(res.data) ? res.data : [])
        setAllocationState(res.allocation ?? null)
      }
    }).catch(() => {
      if (current) setLoadError('在庫を読み込めませんでした。再読込してください。')
    })
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

  const closedDay = allocationState?.hoursStatus === 'closed'
  const slots: SlotInfo[] = (closedDay ? [] : rows).map((row) => {
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

  const [editor, setEditor] = useState<AllocationEditor | null>(null)
  const [guideLine, setGuideLine] = useState<string | null>(null)
  const guideDraftKey = selectedAccountId && storeId ? `musubo:restaurant-reception:${selectedAccountId}:${storeId}` : null
  const [allocationError, setAllocationError] = useState('')
  const [allocationConflict, setAllocationConflict] = useState(false)
  const [checkingAllocation, setCheckingAllocation] = useState(false)
  const scopedSave = useRef(false)
  const allocationScope = useRef({ selectedAccountId, storeId, date })
  useLayoutEffect(() => {
    allocationScope.current = { selectedAccountId, storeId, date }
    setEditor(null); setAllocationError(''); setAllocationConflict(false)
  }, [selectedAccountId, storeId, date])
  useLayoutEffect(() => {
    try { setGuideLine(guideDraftKey ? sessionStorage.getItem(guideDraftKey) : null) }
    catch { setGuideLine(null) }
  }, [guideDraftKey])
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const [closeNoteOpen, setCloseNoteOpen] = useState(false)
  const [closedSlots, setClosedSlots] = useState<string[]>([])
  const [closedChannels, setClosedChannels] = useState<string[]>([])

  const standard = allocationState?.standard ? allocationOf(allocationState.standard) : null
  const lowSlot = (slot: SlotInfo) => slot.free / Math.max(totalSeats, 1) < 0.2
  const guide = useSharedGuide()?.guide
  const guidingReception = guide?.phase === 'active' && guide.stepKey === 'scenario'
  const guideValue = guideLine ?? (standard ? String(standard.line) : '')
  const guideAllocation = { ...(standard ?? emptyAllocation), line: Number(guideValue) }
  const hoursUnavailable = allocationState?.hoursStatus === 'unavailable'
  const showHoursLink = Boolean(missingHoursReason || allocationState?.hoursStatus === 'unconfigured')
  const canWriteAllocation = Boolean(canEdit && allocationState && !busy && !loadError && !hoursUnavailable && totalSeats > 0)
  const receptionReady = guidingReception && canWriteAllocation && !showHoursLink
    && guideAllocation.line > 0 && validAllocation(totalSeats, guideAllocation)
  useEffect(() => {
    if (receptionReady && guide?.procedureIndex === 1) emitGuideSignal('reception.lineSeats', selectedAccountId ?? undefined)
  }, [receptionReady, guide?.procedureIndex, selectedAccountId])

  const changeGuideLine = (value: string | null) => {
    setGuideLine(value)
    if (!guideDraftKey) return
    try {
      if (value === null) sessionStorage.removeItem(guideDraftKey)
      else sessionStorage.setItem(guideDraftKey, value)
    } catch { /* この画面では引き続き入力できる。 */ }
  }
  const hoursChanged = hours !== null && hoursDraft !== null && JSON.stringify(hoursDraft) !== JSON.stringify(hours)
  const allocationChanged = editor && (editor.allocation.ota !== editor.initial.ota
    || editor.allocation.line !== editor.initial.line || editor.allocation.walkin !== editor.initial.walkin)
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({
    dirty: canEdit && (guideLine !== null || Boolean(allocationChanged) || hoursChanged),
    busy,
  })

  const closeEditor = () => { setEditor(null); setAllocationError(''); setAllocationConflict(false) }
  const resetAll = () => { closeEditor(); changeGuideLine(null); setHoursDraft(hours) }
  const changeDate = (next: string) => { setDate(next); setSelectedId(''); closeEditor() }

  const openEditor = (scope: AllocationEditor['scope']) => {
    if (!canWriteAllocation || (scope !== 'standard' && allocationState?.hoursStatus !== 'open')) return
    const dayOnly = allocationState?.day
    const source = selected?.row.allocationSource
    const allocation = scope === 'slot' ? rowAllocation(selected?.row)
      : allocationOf(scope === 'day' ? dayOnly ?? allocationState?.standard : allocationState?.standard)
    setEditor({
      scope,
      allocation,
      initial: allocation,
      time: selected?.time,
      startsAt: selected?.row.starts_at,
      canRestore: scope === 'day' ? Boolean(dayOnly) : scope === 'slot' && (source === 'slot' || source === 'legacy'),
      restoreLabel: scope === 'slot' && dayOnly ? 'この日の配分に戻す' : '基本配分に戻す',
    })
    setAllocationError(''); setAllocationConflict(false)
  }

  const reviewAllocation = async () => {
    if (!selectedAccountId || !storeId || checkingAllocation) return
    const scope = allocationScope.current
    setCheckingAllocation(true)
    try {
      const result = await restaurantTestApi.inventoryDay(selectedAccountId, storeId, date)
      if (scope !== allocationScope.current) return
      setAllocationState(result.allocation)
      setDayRows(result.data)
      const current = editor?.scope === 'slot' ? rowAllocation(result.data.find(row => row.starts_at === editor.startsAt))
        : allocationOf(editor?.scope === 'day' ? result.allocation.day ?? result.allocation.standard : result.allocation.standard)
      setAllocationError('最新の配分は、予約サイト ' + current.ota + '席・LINE ' + current.line + '席・当日 ' + current.walkin + '席です。')
      setAllocationConflict(false)
    } catch {
      if (scope === allocationScope.current) setAllocationError('最新の配分を読み込めませんでした。もう一度お試しください。')
    } finally {
      setCheckingAllocation(false)
    }
  }

  const saveAllocation = (scope: AllocationEditor['scope'], value: Alloc | null, startsAt?: string) => {
    if (scopedSave.current || !canWriteAllocation || !allocationState || !selectedAccountId || !storeId || allocationConflict
      || (value && !validAllocation(totalSeats, value))) return
    scopedSave.current = true
    const operationScope = allocationScope.current
    setAllocationError('')
    void mutate(async () => {
      try {
        await restaurantTestApi.saveScopedInventoryAllocation(selectedAccountId, {
          storeId,
          scope,
          expectedVersion: allocationState.version,
          ...(scope === 'day' ? { date } : {}),
          ...(scope === 'slot' ? { startsAt } : {}),
          allocation: value && { otaCapacity: value.ota, lineCapacity: value.line, walkInCapacity: value.walkin },
        })
      } catch (error) {
        if (operationScope !== allocationScope.current) throw new QuietError('allocation-scope-changed')
        saveErrors.capture(error)
        const errorCode = error instanceof ApiError ? error.code : undefined
        const conflict = errorCode === 'version_conflict'
        setAllocationConflict(conflict)
        const messages: Partial<Record<string, string>> = {
          version_conflict: '別の変更が保存されました。入力内容を保ったまま、最新の配分を確認してください。',
          hours_not_configured: '開ける時間を設定してから保存してください。入力した配分は残っています。',
          inventory_closed: 'この日は休業日です。営業時間を確認してから、配分を変更してください。',
          line_account_not_connected: 'LINEアカウントの接続を確認してください。入力した配分は残っています。',
        }
        setAllocationError((errorCode && messages[errorCode])
          || '配分を保存できませんでした。入力内容は残っています。もう一度お試しください。')
        throw new QuietError('allocation')
      }
    }, '配分を保存しました。').then((ok) => {
      if (!ok || operationScope !== allocationScope.current) return
      closeEditor()
      changeGuideLine(null)
      setRefresh(current => current + 1)
      if (scope === 'standard') emitGuideSignal('reception.save', selectedAccountId)
    }).finally(() => { scopedSave.current = false })
  }

  const saveHours = (force = false) => {
    if (!canEdit || busy || !selectedAccountId || !store || !hoursDraft || !hoursChanged) return
    const attemptedHours = hoursDraft
    void mutate(async () => {
      try {
        const version = force ? (await restaurantTestApi.openingHours(selectedAccountId, store.id)).data.version : hoursVersion
        const result = await restaurantTestApi.saveOpeningHours(selectedAccountId, { storeId: store.id, hours: attemptedHours, expectedVersion: version })
        setHoursVersion(result.data.version); setHours(attemptedHours)
      } catch (error) {
        saveErrors.capture(error)
        if (error instanceof ApiError && error.status === 409) {
          const latest = (await restaurantTestApi.openingHours(selectedAccountId, store.id)).data
          const who = data.memberships.find(member => member.id === latest.updatedBy)?.staff_name ?? null
          const changes = WEEK_ORDER.filter(weekday => periodsText(latest.hours?.find(day => day.weekday === weekday)) !== periodsText(hours?.find(day => day.weekday === weekday)))
          setConflict({
            who: sanName(who), at: formatTime(latest.updatedAt, store.timezone), attemptedHours,
            scope: changes.length ? changes.map(weekday => WEEKDAY_LABEL[weekday] + '曜').join('・') + 'の開ける時間' : '開ける時間',
            latestHours: latest.hours,
          })
          throw new QuietError('conflict')
        }
        throw error
      }
    }, '開ける時間を保存しました。').then((ok) => {
      if (ok) { setConflict(null); setDiffOpen(false); setRefresh(current => current + 1) }
    })
  }

  const reloadLatest = () => {
    setConflict(null); setDiffOpen(false); resetAll(); setRefresh(current => current + 1)
    void loadHours()
    void ctx.reload()
  }

  const occupiedIds = selected ? occupiedOf(selected.row) : new Set<string>()
  const freeTables = activeTables.filter((item) => !occupiedIds.has(item.id))
  const bestTable = freeTables.slice().sort((a, b) => b.max_capacity - a.max_capacity)[0] ?? null
  const tableGroups = groupTablesByFloor(tables, floors)
  /* 閉じる先は、メール転送で今も予約が届いている媒体（受付を各媒体の管理画面で閉じるもの）。 */
  const closingChannels = channels.filter((channel) => channel.receiveMethod === 'email_forward' && channel.status === 'receiving')
  const canCloseNote = Boolean(selected && lowSlot(selected) && !closedSlots.includes(selected.row.id))

  const setDay = (weekday: number, next: RestaurantOpeningDay['periods']) => {
    if (!canEdit) return
    setHoursDraft((current) => (current ?? emptyWeek()).map((day) => (day.weekday === weekday ? { ...day, periods: next } : day)))
  }

  return (
    <PageFrame kind="restaurant" standalone heightMode="viewport" boardId="Y8SjT2" hasFooter={guidingReception || hoursChanged || Boolean(conflict)}>
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
            {floorError?<Notice tone="warn" action={<Button variant="text" size="inline" onClick={()=>setFloorRetry(value=>value+1)}>もう一度読み込む</Button>}>階・エリアを読み込めませんでした。</Notice>:null}

            {tables.length === 0 ? (
              <ListState kind="empty" emptyPreset="readonly" title="卓がありません。座席・卓管理で追加してください。" description="卓を追加すると、ここに空きと利用状況が出ます。" action={<Button href="/restaurant-test/tables">座席・卓管理を開く</Button>} />
            ) : tableGroups.map(group => <section key={group.id} className={styles.tableGroup}>{group.name?<h3>{group.name}</h3>:null}<ul className={styles.tablesGrid}>
              {group.tables.map((item) => {
                const occupied = occupiedIds.has(item.id)
                return (
                  <li key={item.id}>
                    <SeatTile presentation="occupancy" code={item.code} capacity={`${item.max_capacity}名`} stopped={!item.is_active} occupied={Boolean(item.is_active) && occupied}
                      aria-label={`${item.code} ${item.max_capacity}名${!item.is_active ? '（停止中）' : occupied ? '（埋まっている）' : '（空き）'}`} />
                  </li>
                )
              })}
            </ul></section>)}
            {selected ? (
              <div className={styles.freeInfo}>
                {bestTable ? (
                  <>
                    <p className={styles.freeTitle}>{`空き：${bestTable.code}（${bestTable.label} ${bestTable.max_capacity}名）`}</p>
                    <p className={styles.freeSub}>{`${selected.time} に空いている卓の定員は ${bestTable.max_capacity}名です`}</p>
                  </>
                ) : <p className={styles.freeTitle}>空きの卓がありません</p>}
              </div>
            ) : null}

          </DetailSection>
        </DetailPreview>} asideLayout="detail">
        <div className={styles.mainColumn}>
          {guidingReception ? (
            <GuideAllocationCard value={guideValue} onChange={changeGuideLine} allocation={guideAllocation} totalSeats={totalSeats} activeTableCount={activeTables.length}
              valid={receptionReady} disabled={!canWriteAllocation || showHoursLink} error={allocationError}
              onReload={allocationConflict ? () => void reviewAllocation() : undefined}
              hoursLink={showHoursLink ? (googleStatus !== null ? '/restaurant-test/google?tab=hours' : '#rs-hours-title') : undefined} />
          ) : (
            <StandardAllocationCard allocation={standard} totalSeats={totalSeats} canEdit={canWriteAllocation && !showHoursLink}
              lockedReason={lockedReason} onEdit={() => openEditor('standard')} />
          )}
          {noActiveTablesReason ? <DialogNote>{noActiveTablesReason} {!guidingReception ? <Button variant="text" size="inline" href="/restaurant-test/tables">座席・卓管理で変える →</Button> : null}</DialogNote> : null}
          <Card layout="vertical" padding="spacious" gap="tight" surface="standard" aria-labelledby="rs-stock-title">
            <StockListHeading date={date} busy={busy} onChange={changeDate} />
            {missingHoursReason && !guidingReception ? <DialogNote>{missingHoursReason}{' '}<Button variant="text" size="inline" href={googleStatus !== null ? '/restaurant-test/google?tab=hours' : '#rs-hours-title'}>開ける時間を設定する</Button></DialogNote> : null}
            {!closedDay && rows.some(row => row.allocationSource === 'legacy') ? <Notice tone="info">以前に保存した配分があります。時間帯を選ぶと確認できます。</Notice> : null}
            {slots.length > 0 && !guidingReception ? <div className={styles.allocationTableActions}>
              <Button variant="text" lockedReason={lockedReason} disabled={!canWriteAllocation || allocationState?.hoursStatus !== 'open'} onClick={() => openEditor('day')}>この日の配分を変更</Button>
            </div> : null}
            {loadError || hoursUnavailable ? (
              <div className={styles.stateBox}>
                <ListState kind="error" title="この日の時間帯を読み込めませんでした" onRetry={() => setRefresh(current => current + 1)} />
              </div>
            ) : dayRows === null ? (
              <div className={styles.stateBox}><ListState kind="loading" /></div>
            ) : slots.length === 0 ? (
              <div className={styles.stateBox}>
                <ListState kind="empty" title={closedDay ? 'この日は休業日です' : 'この日の時間帯がありません'}
                    description={closedDay ? 'この日のLINE予約は受け付けていません。' : undefined}
                    action={closedDay ? <Button href="/restaurant-test/inventory?tab=closures">休業日・貸切を見る</Button> : undefined} />
              </div>
            ) : (
              <DataTable presentation="inventory">
                <thead>
                  <TableHeadRow>
                    <Th truncate className={styles.colTime}>時間</Th>
                    <Th className={styles.colAllocation}>LINE</Th>
                    <Th className={styles.colAllocation}>予約サイト</Th>
                    <Th className={styles.colAllocation}>当日</Th>
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
                      onClick={() => setSelectedId(slot.row.id)}
                    >
                      <Td>
                        <Button variant="text" size="compact" fullWidth presentation="row-action" textTone="ink" data-part="row-name" aria-pressed={selected?.row.id === slot.row.id} onClick={(event) => { event.stopPropagation(); setSelectedId(slot.row.id) }}>{slot.time}</Button>
                      </Td>
                      <Td className={styles.colAllocation}>
                        <strong>{slot.row.line_capacity}席</strong>
                        <span className={styles.allocationSource}>{slot.row.auto_line_original != null ? '自動停止中' : allocationLabels[slot.row.allocationSource ?? 'legacy']}</span>
                      </Td>
                      <Td className={styles.colAllocation}>{slot.row.ota_capacity}席</Td>
                      <Td className={styles.colAllocation}>{slot.row.walk_in_capacity}席</Td>
                      <Td className={styles.colUse}>
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
                      <Td className={styles.colTables}><TruncatedText value={joinTableCodes(slot.tables) || emptyValue('unknown')} /></Td>
                      <Td className={`${styles.colFree} ${styles.bold}`} align="right"><span className={lowSlot(slot) ? styles.freeLow : undefined}>{`${slot.free}席`}</span></Td>
                    </Tr>
                  ))}
                </tbody>
              </DataTable>
            )}
            {selected && !guidingReception ? <div className={styles.allocationTableActions}>
              <Button variant="text" lockedReason={lockedReason} disabled={!canWriteAllocation || allocationState?.hoursStatus !== 'open'} onClick={() => openEditor('slot')}>{selected.time}の配分を変更</Button>
            </div> : null}
          </Card>
          <Card layout="vertical" padding="spacious" gap="tight" surface="standard" aria-labelledby="rs-hours-title">
            <CardHeader size="stacked" titleId="rs-hours-title" title="開ける時間" meta={googleStatus !== null ? 'Googleビジネスの営業時間を基準にします。予約枠と席の配分は、この画面で設定します。' : '曜日ごとに予約を受ける時間を決めます（予約設定の受付枠と同じ決め方。違うのは、受けられる数が「人」ではなく「席」で決まること）'} />
            {hoursError ? <Notice tone="danger" className={styles.hoursErrorNoticePlacement} >{hoursError}</Notice> : null}
            {googleStatus !== null ? <>
              <Notice tone={googleStatus === 'connected' ? 'info' : 'warn'}>営業時間の変更は Googleビジネスで行います。接続に問題がある場合は、接続画面で確認してください。</Notice>
              <div className={styles.googleHoursLink}><Button variant="text" href="/restaurant-test/google?tab=hours">Googleビジネスの営業時間を開く →</Button></div>
              {hours ? <ul className={styles.googleHoursList}>{WEEK_ORDER.map((weekday) => <li key={weekday}>{WEEKDAY_LABEL[weekday]}曜日：{periodsText(hours.find((d) => d.weekday === weekday))}</li>)}</ul> : null}
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
      {(guidingReception || hoursChanged || conflict) ? <PageFooter
        status={guidingReception && allocationError ? '入力内容は残っています。' : undefined}
        actions={<>
          <Button lockedReason={lockedReason} onClick={resetAll} disabled={!canEdit || busy}>キャンセル</Button>
          {conflict ? (
            <Button lockedReason={lockedReason} variant="primary" disabled={!canEdit || busy} onClick={() => setDiffOpen(true)}>比べてから保存</Button>
          ) : guidingReception && !hoursChanged ? (
            <Button data-guide-anchor="reception.save" lockedReason={lockedReason} variant="primary" busy={busy} busyLabel="保存しています"
              data-guide-reception-state={busy ? 'saving' : allocationConflict ? 'conflict' : allocationError ? 'retry' : undefined}
              data-guide-reception-count={guideAllocation.line}
              disabled={!receptionReady || allocationConflict || checkingAllocation} onClick={() => saveAllocation('standard', guideAllocation)}>
              <Check size={16} aria-hidden="true" />配分を保存する
            </Button>
          ) : (
            <Button lockedReason={lockedReason} variant="primary" busy={busy} disabled={!hoursChanged || !canEdit} onClick={() => saveHours()}>
              <Check size={16} aria-hidden="true" />開ける時間を保存
            </Button>
          )}
        </>}
      /> : null}
      {editor ? <AllocationDialog scope={editor.scope} dateLabel={dayLabel(date)} time={editor.time}
        allocation={editor.allocation} totalSeats={totalSeats} busy={busy || checkingAllocation} error={allocationError}
        reload={allocationConflict ? () => void reviewAllocation() : undefined}
        canRestore={editor.canRestore} restoreLabel={editor.restoreLabel}
        onChange={allocation => setEditor({ ...editor, allocation })}
        onClose={closeEditor} onSave={() => saveAllocation(editor.scope, editor.allocation, editor.startsAt)}
        onRestore={() => saveAllocation(editor.scope, null, editor.startsAt)} /> : null}
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
            <Button lockedReason={lockedReason} variant="primary" disabled={!canEdit || busy} onClick={() => saveHours(true)}>このまま保存する</Button>
          </>
        )}
      >
        {conflict ? <ConflictDiff conflict={conflict} /> : null}
      </RsDialog>
    </></SaveErrorScope>
    </PageFrame>
  )
}

function ConflictDiff({ conflict }: { conflict: Conflict }) {
  const lines: Array<{ label: string; mine: string; latest: string }> = []
  for (const weekday of WEEK_ORDER) {
    const mine = periodsText(conflict.attemptedHours.find(day => day.weekday === weekday))
    const latest = periodsText(conflict.latestHours?.find(day => day.weekday === weekday))
    if (mine !== latest) lines.push({ label: WEEKDAY_LABEL[weekday] + '曜の開ける時間', mine, latest })
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
