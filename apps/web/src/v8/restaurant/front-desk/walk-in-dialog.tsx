'use client'
import { tableCapacityReason, type RestaurantTableDefinition } from '../booking-kit/table-definition'
import { DialogNote } from '../booking-kit/parts'

/*
 * ★V8 ウォークインの窓（提案 E-3 `nNujj`）。
 *
 * 人数（−2＋）を合わせ、今すぐ座れる卓のカードを1つ押して［入店にする］の2手。
 * 人数を変えると座れる卓だけに絞り直す。満席のときは「いま座れる卓はありません」と次に空く目安。
 * 入れる口は walk-in.ts の1か所（予約なしの来店の口ができたら差し替える）。動きは BEHAVIOR.md。
 */
import { describeApiFailure } from '@/components/shared/api-error-message'
import { formatDate as polishFormatDate } from '@/lib/format'
import { useEffect, useMemo, useRef, useState } from 'react'
import { LogIn, Minus, Plus } from 'lucide-react'
import Dialog from '@/components/shared/dialog'
import IconButton from '@/components/shared/icon-button'
import Notice from '@/components/shared/notice'
import type { RestaurantFloor } from '@line-crm/shared'
import { reservationBoardApi } from '@/lib/api/helpers/reservation-board'
import AvailableTables, { tableGroups } from './available-tables'
import { restaurantTestApi, type RestaurantReservation, type RestaurantTable } from '@/lib/restaurant-test-api'
import { freeTables, tableBusy, tableNote, toYmd } from './slots'
import { seatWalkIn } from './walk-in'
import styles from './front-desk.module.css'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

const MAX_GUESTS = 100

function hm(value: number | Date): string {
  return polishFormatDate(value, { style: 'time' })
}

/** 満席のとき、人数が入る卓がいちばん早く空く時刻（今の予約の終わり）。 */
export function nextFreeAt(tables: RestaurantTable[], guests: number, rows: RestaurantReservation[], now: number): number | null {
  const fits = tables.filter((t) => t.is_active && t.min_capacity <= guests && t.max_capacity >= guests)
  let best: number | null = null
  for (const table of fits) {
    const ends = rows
      .filter((r) => r.table_id === table.id && !['cancelled', 'no_show'].includes(r.status) && Date.parse(r.starts_at) <= now && Date.parse(r.ends_at) > now)
      .map((r) => Date.parse(r.ends_at))
    const end = ends.length ? Math.max(...ends) : null
    if (end !== null && (best === null || end < best)) best = end
  }
  return best
}

export default function WalkInDialog({ tableDefinition, open, accountId, storeId, tables, onClose, onSaved }: {
  open: boolean
  accountId: string
  tableDefinition?: RestaurantTableDefinition
  storeId: string
  tables: RestaurantTable[]
  onClose: () => void
  onSaved: (result: { seated: boolean }) => void
}) {
  const saveErrors = useSaveFormErrors()

  const [now, setNow] = useState(() => new Date())
  const [guests, setGuests] = useState(2)
  const capacityReason = tableCapacityReason(tableDefinition, accountId, storeId, tables, guests)
  const [tableId, setTableId] = useState('')
  const [floorId, setFloorId] = useState('all')
  const [floors, setFloors] = useState<RestaurantFloor[]>([])
  const [floorStatus, setFloorStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const initialized = useRef(false)
  const [rows, setRows] = useState<RestaurantReservation[] | null>(null)
  const [rowsScope, setRowsScope] = useState('')
  const scope = JSON.stringify([accountId, storeId])
  const currentRows = rowsScope === scope ? rows : null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setNow(new Date()); setGuests(2); setTableId(''); setFloorId('all'); setFloors([]); initialized.current = false; setError(''); setRows(null)
  }, [open])

  useEffect(() => {
    let current = true
    if (!open || !accountId || !storeId) return
    setRows(null); setTableId(''); setError(''); initialized.current = false
    void restaurantTestApi.reservationsDay(accountId, storeId, toYmd(now))
      .then((res) => { if (current) { setRowsScope(scope); setRows(Array.isArray(res.data?.reservations) ? res.data.reservations : []) } })
      .catch(() => { if (current) setError('今日の予約を読み込めませんでした。閉じてもう一度開いてください。') })
    return () => { current = false }
  }, [open, accountId, storeId, now])

  useEffect(() => {
    let current = true
    setFloors([]); setFloorId('all'); setFloorStatus('loading')
    if (open && accountId && storeId) void reservationBoardApi.floors(accountId, storeId)
      .then(result => {
        if (!Array.isArray(result.data)) throw new Error('階・エリアを読み込めませんでした')
        if (current) { setFloors(result.data); setFloorStatus('ready') }
      })
      .catch(() => { if (current) setFloorStatus('error') })
    return () => { current = false }
  }, [open, accountId, storeId])

  const free = useMemo(() => (currentRows ? freeTables(tables, guests, now.getTime(), currentRows) : []), [tables, guests, now, currentRows])
  /* 頭の「空いている卓」は人数にかかわらず、いま予約が重なっていない動いている卓の数。 */
  const freeAll = useMemo(() => (currentRows ? tables.filter((t) => t.is_active && !tableBusy(t.id, now.getTime(), now.getTime() + 1, currentRows)).length : 0), [tables, now, currentRows])
  const visible = floorId === 'all' ? free : free.filter(table => table.floor_id === floorId)
  useEffect(() => {
    if (!currentRows || floorStatus === 'loading') return
    if (!initialized.current) {
      initialized.current = true
      setTableId(tableGroups(free, floors).flatMap(group => group.tables)[0]?.id ?? '')
    } else if (tableId && !visible.some(table => table.id === tableId)) setTableId('')
  }, [currentRows, free, floors, floorId, floorStatus, tableId])
  const waitUntil = currentRows && free.length === 0 ? nextFreeAt(tables, guests, currentRows, now.getTime()) : null

  const save = async () => {
    if (!tableId) { setError('座る卓を選んでください。'); return }
    setBusy(true); setError('')
    try {
      const result = await seatWalkIn(accountId, { storeId, guestCount: guests, tableId, now: new Date() })
      onSaved({ seated: result.seated })
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure) setError(describeApiFailure(caught, '保存')) }
    } finally {
      setBusy(false)
    }
  }

  return (
    <SaveErrorScope errors={saveErrors}><Dialog
      open={open}
      designNode="nNujj"
      designWidth={480}
      /* 絵 ：窓の上は 140（座れる卓の数で上下しない）。 */
      designTop={140}
      footerAlign="center"
      title="ウォークインを入れる"
      description={currentRows === null && error ? '空き状況を確認できません' : `いま ${hm(now)}・空いている卓 ${freeAll}`}
      busy={busy}
      error={error || undefined}
      confirmLabel="入店にする"
      confirmIcon={<LogIn size={16} aria-hidden="true" />}
      confirmDisabled={!tableId || !currentRows || floorStatus === 'loading'}
      confirmDisabledReason={currentRows === null && error ? '空き状況を確認できないため入店にできません。' : '座る卓を選んでください。'}
      onConfirm={() => save()}
      onCancel={onClose}
    >
      <div className={styles.walkIn}>
        <div className={styles.field}>
          <span className={styles.label} id="e3-guests">人数</span>
          <div className={styles.stepper} role="group" aria-labelledby="e3-guests">
            <IconButton aria-label="人数を減らす" disabled={guests <= 1 || busy} onClick={() => setGuests((n) => Math.max(1, n - 1))}><Minus size={16} aria-hidden="true" /></IconButton>
            <span className={styles.stepperValue} aria-live="polite">{`${guests} 名`}</span>
            <IconButton aria-label="人数を増やす" disabled={guests >= MAX_GUESTS || busy} onClick={() => setGuests((n) => Math.min(MAX_GUESTS, n + 1))}><Plus size={16} aria-hidden="true" /></IconButton>
          </div>
        </div>
        {floorStatus === 'error' && <Notice tone="warn" message="階・エリアを読み込めませんでした。卓はすべて表示しています。" />}
        {currentRows === null ? (error ? null : <p className={styles.hint}>空いている卓を調べています。</p>) : <>
          <AvailableTables tables={free} floors={floors} floorId={floorId} onFloorChange={setFloorId} selected={tableId} onSelect={setTableId} guests={guests} disabled={busy} />
          {free.length === 0 && <div className={styles.full} role="status">
            <p className={styles.fullTitle}>いま座れる卓はありません</p>
            {capacityReason ? <DialogNote>{capacityReason}</DialogNote> : <p className={styles.hint}>{waitUntil ? `${guests}名が入る卓は ${hm(waitUntil)} ごろに空く予定です（約${Math.max(1, Math.round((waitUntil - now.getTime()) / 60_000))}分）。` : `${guests}名が入る卓がありません。人数を分けるか、予約台帳で卓を確かめてください。`}</p>}
          </div>}
        </>}
      </div>
    </Dialog></SaveErrorScope>
  )
}
