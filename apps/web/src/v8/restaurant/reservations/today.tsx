'use client'
import { useLedgerFloor } from './use-ledger-floor'
import LedgerEmpty from './ledger-empty'
import ListState from '@/components/shared/list-state'
import ReservationBoard,{ReservationSource} from '@/components/shared/reservation-board'
import {seatBoardEntry, withHonorific } from '@line-crm/shared'
import {reservationBoardApi,allBoardPages} from '@/lib/api/helpers/reservation-board'
import {useAccount} from '@/contexts/account-context'

/*
 * ★V8 予約台帳「今日」（時間×卓・板 `l9NlC0`、1152 は `xzCK6`）。
 *
 * 数4（今日の予約・承認待ち・未配席・押さえ）→ 日付の段（前後・今日・停止中の卓の注意・予約元）→
 * 左に時間×卓の表（列は卓、行は30分、予約は行をまたぐ箱）、右に次の予約・今日気をつけること・
 * 内訳・つながる先。1152 では右の欄が表の下に積まれる（CSS だけ）。
 * 箱は予約元の色（LINE・レストランボード＝緑、予約媒体＝赤、電話＝灰）、承認待ちは黄の枠、押さえは灰の枠。
 */
import { useEffect,useMemo,useState } from 'react'
import type {ReservationAxis} from '@line-crm/shared'
import KpiCard from '@/components/shared/kpi-card'
import Link from '@/components/shared/list-navigation'
import { ChevronLeft, ChevronRight, Inbox } from 'lucide-react'
import Card from '@/components/shared/card'
import SectionHeader from '@/components/shared/section-header'

import Button from '@/components/shared/button'
import IconButton from '@/components/shared/icon-button'
import Select from '@/components/shared/select'

import type { RestaurantReservation, RestaurantTable } from '@/lib/restaurant-test-api'
import KpiBand from '@/components/shared/kpi-band'
import { INACTIVE_STATUSES, SOURCE_LABEL, dayShort, dayTitle, hm, isHold, mdWeek, minutesOf, addDays, sameDay, shortCourse, slotLabel, sourceName, dayRange, toYmd } from './format'
import styles from './reservations.module.css'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import { formatNumber } from '@/lib/format'

export type PhonePreset = { date?: Date; time?: string; tableId?: string; hold?: boolean }

export default function TodayView({ rows, later, tables, day, isToday, busy, canWrite, source, onSource, onDay, onAdd, onOpen, onDetail, onReload, storeId,storeName,onView }: {
  onView:(view:import('./format').LedgerView)=>void
  /** その日の予約（取消・無断も含む。表と数では除く）。 */
  onReload:()=>void
  storeName?:string
  storeId:string
  rows: RestaurantReservation[]
  /** 次の予約を探すための、その月の予約（その日の残りが無いとき、次の日以降から出す）。 */
  later: RestaurantReservation[]
  tables: RestaurantTable[]
  day: Date
  isToday: boolean
  busy: boolean
  canWrite: boolean
  source: string
  onSource: (value: string) => void
  onDay: (day: Date) => void
  onAdd: (preset: PhonePreset) => void
  /** 変更の窓（押さえの箱・卓を変える）。 */
  onOpen: (id: string) => void
  /** 予約の詳細の窓（予約の箱・詳細を見る。板 AjZhH）。 */
  onDetail: (id: string) => void
}) {
  const {selectedAccountId}=useAccount()
  const [axis,setAxis]=useState<ReservationAxis>('resource')
  const {floor,error:floorError,reload:reloadFloor}=useLedgerFloor(selectedAccountId,storeId)
  const live = useMemo(() => rows.filter((item) => !INACTIVE_STATUSES.includes(item.status)), [rows])
  const shown = useMemo(() => (source === 'all' ? live : live.filter((item) => item.source === source)), [live, source])
  const bookings = useMemo(() => shown.filter((item) => !isHold(item)), [shown])
  const countedBookings = useMemo(() => bookings.filter((item) => sameDay(new Date(item.starts_at), day)), [bookings, day])
  const holds = useMemo(() => shown.filter((item) => isHold(item) && sameDay(new Date(item.starts_at), day)), [shown, day])

  const entries = useMemo(() => shown.map(row => seatBoardEntry(row as unknown as Record<string,unknown>)), [shown])

  /* 結合予約の全卓を残し、時間の盤では卓番で並べる。 */
  const columns = useMemo(() => {
    const used = new Set(entries.flatMap(item => item.resourceIds))
    return tables.filter((table) => table.is_active || used.has(table.id)).sort((a,b) => a.code.localeCompare(b.code,'ja',{numeric:true}) || a.id.localeCompare(b.id))
  }, [tables, entries])
  const visibleFloor = floor ? {...floor,tables:floor.tables.filter(table => columns.some(column => column.id===table.id))} : undefined
  const hidden = tables.filter((table) => !table.is_active && !columns.includes(table))

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setTimeout(() => setNow(Date.now()), 1_800_000 - (now % 1_800_000))
    return () => window.clearTimeout(timer)
  }, [now])

  /* 次の予約：その日の残りから。無ければ（営業の後など）次の日以降の予約から出し、日付も書く。 */
  const next = useMemo(() => {
    const nowMs = isToday ? now : Date.parse(dayRange(day).from)
    const sorted = (list: RestaurantReservation[]) => list
      .filter((item) => !INACTIVE_STATUSES.includes(item.status) && !isHold(item) && new Date(item.starts_at).getTime() >= nowMs)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    return sorted(bookings)[0] ?? sorted(later.filter((item) => source === 'all' || item.source === source))[0] ?? null
  }, [bookings, later, isToday, day, source, now])
  const nextOtherDay = next ? !sameDay(new Date(next.starts_at), day) : false

  const pending = countedBookings.filter((item) => item.status === 'pending')
  const allergies = bookings.filter((item) => item.allergy_note).sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  const tableById = new Map(tables.map((table) => [table.id, table]))

  /* 選んだ日の、これからの混む時間に空いている卓。 */
  const peak = useMemo(() => {
    const dayStart = Date.parse(dayRange(day).from)
    const sameDayRows = shown.filter((item) => sameDay(new Date(item.starts_at), day))
    let best = -1
    let bestSeats = 0
    for (const slot of Array.from({length:48},(_,i)=>i*30)) {
      if (dayStart + slot * 60_000 <= now) continue
      const seats = sameDayRows.filter((item) => minutesOf(item.starts_at) <= slot && minutesOf(item.ends_at) > slot).reduce((sum, item) => sum + item.guest_count, 0)
      if (seats > bestSeats) { best = slot; bestSeats = seats }
    }
    return best
  }, [shown, day, now])
  const freeAtPeak = peak < 0 ? [] : columns.filter((table) => table.is_active && !shown.some((item) => sameDay(new Date(item.starts_at), day) && !item.departed_at && seatBoardEntry(item as unknown as Record<string,unknown>).resourceIds.includes(table.id) && minutesOf(item.starts_at) <= peak && minutesOf(item.ends_at) > peak))

  const guests = countedBookings.reduce((sum, item) => sum + item.guest_count, 0)
  const lineCount = countedBookings.filter((item) => item.source === 'line').length
  const phoneCount = countedBookings.filter((item) => item.source === 'phone' || item.source === 'manual').length
  const mediaCount = countedBookings.length - lineCount - phoneCount
  const unseated = countedBookings.filter((item) => !item.departed_at && seatBoardEntry(item as unknown as Record<string,unknown>).resourceIds.length === 0).length
  const pendingSources = [...new Set(pending.map((item) => sourceName(item.source)))].join('・')

  return (
    <>
      <KpiBand data-restaurant-fusion>
        <KpiCard title={isToday ? "今日の予約" : "選んだ日の予約"} value={countedBookings.length} unit="件" detail={`${guests}名`} icon={<Inbox size={16} aria-hidden />} presentation="band" />
        <KpiCard title="承認待ち" value={pending.length} unit="件" detail={pendingSources || 'ありません'} valueTone={pending.length > 0 ? 'warning' : 'default'} icon={<Inbox size={16} aria-hidden />} presentation="band" />
        <KpiCard title="未配席" value={unseated} unit="件" detail={unseated === 0 ? 'すべて卓に入っています' : '卓の割当が必要'} valueTone={unseated > 0 ? 'warning' : 'default'} icon={<Inbox size={16} aria-hidden />} presentation="band" />
        <KpiCard title="仮押さえ" value={holds.length} unit="枠" detail={holds[0]?.note || holds[0]?.allergy_note || '期限付きの仮押さえ'} icon={<Inbox size={16} aria-hidden />} presentation="band" />
      </KpiBand>
      <div className={styles.todayColumns}>
        <div className={styles.calendarWrap} role="region" aria-label={`${dayTitle(day)}の時間×卓`}>
        <ReservationBoard renderBody={columns.length===0 || axis==='floor' && shown.length===0 ? body=><>{shown.length===0 ? <LedgerEmpty noTables={tables.length===0} inactiveTables={tables.length>0&&columns.length===0} filtered={source!=='all'} canWrite={canWrite} busy={busy} onCreate={()=>onAdd({date:day})}/> : null}{columns.length===0&&shown.length===0 ? null : body}{columns.length===0&&shown.length>0 ? <Button presentation="restaurant" onClick={()=>onView('list')}>一覧で予約を見る</Button> : null}</> : undefined} axis={axis} onAxis={v=>{setAxis(v);if(v==='list')onView('list');else if(v==='month')onView('month')}} toolbar={<>
        <IconButton aria-label="前の日" onClick={() => onDay(addDays(day, -1))}><ChevronLeft size={16} aria-hidden="true" /></IconButton>
        <h2 className={styles.dateTitle}>{dayTitle(day)}</h2>
        <IconButton aria-label="次の日" onClick={() => onDay(addDays(day, 1))}><ChevronRight size={16} aria-hidden="true" /></IconButton>
        <Button presentation="restaurant" onClick={() => onDay(new Date())} disabled={isToday} title={isToday ? '今日の予約を表示しています' : undefined}>今日</Button>

      </>} trailingToolbar={<span className={styles.sourcePicker}>
          <SaveErrorField names={["source"]}><Select
            aria-label="予約元"
            size="full"
            value={source}
            onChange={onSource}
            options={[{ value: 'all', label: '予約元：すべて' }, ...Object.entries(SOURCE_LABEL).map(([value, label]) => ({ value, label: `予約元：${label}` }))]}
          /></SaveErrorField>
            </span>} notice={floorError ? <ListState kind="error" title="座席表を読み込めませんでした" error={floorError} onRetry={reloadFloor}/> : hidden.length > 0 ? <Notice tone="warn">
              {`${hidden.map((table) => table.code).join('・')} は停止中のため出していません`}
            </Notice> : null} floor={visibleFloor} dates={[toYmd(day)]}
          onSlot={(tableId,startsAt)=>onAdd({date:day,time:hm(startsAt),tableId})} entries={entries}
          resources={columns.map(t=>({id:t.id,label:`${t.code} ${t.max_capacity}名`,groupLabel:t.join_group ? `結合 ${t.join_group}` : undefined,capacity:t.max_capacity,active:!!t.is_active}))}
          canWrite={canWrite} busy={busy} onOpen={onDetail}
          onMove={async(id,move)=>{if(!selectedAccountId)throw new Error('アカウント未取得');await reservationBoardApi.move(selectedAccountId,id,move);onReload()}}
          printContext={`${storeName??storeId} ／ ${source==='all'?'予約元：すべて':SOURCE_LABEL[source]??source} ／ 有効な予約・押さえ`} title={`${dayTitle(day)}の予約`}
          loadPrintEntries={selectedAccountId?()=>allBoardPages('seats',selectedAccountId,dayRange(day).from,dayRange(day).to,storeId).then(es=>es.filter(e=>!INACTIVE_STATUSES.includes(e.status)&&(source==='all'||e.source===source))):undefined}
        />
        </div>
        <div className={styles.side}>
          <Card frame="raised" layout="vertical" padding="roomy" gap="11px" aria-labelledby="rs-next-title">
            <SectionHeader description={nextOtherDay ? '次の日以降の予約' : isToday ? '今日これからの予約' : '選んだ日の次の予約'} title={<span id="rs-next-title">次の予約</span>}/>
            {next ? (
              <>
                <div className={styles.nextBox}>
                  <p className={styles.nextName}>{`${withHonorific(next.customer_name)}・${next.guest_count}名`}</p>
                  <p className={styles.nextMeta}>{`${nextOtherDay ? `${mdWeek(new Date(next.starts_at))} ` : ''}${hm(next.starts_at)}〜${hm(next.ends_at)}・${next.table_id ? tableById.get(next.table_id)?.code ?? next.table_label : '未配席'}・${shortCourse(next.course_name)}`}</p>

                </div>
                <div className={styles.nextActions}><ReservationSource value={next.source}/>
                  <Button presentation="restaurant" onClick={() => onDetail(next.id)}>詳細を見る</Button>

                </div>
              </>
            ) : (
              <p className={styles.sideText}>この日の残りの予約はありません。</p>
            )}
          </Card>
          <Card frame="raised" layout="vertical" padding="roomy" className={styles.sideCard} aria-labelledby="rs-care-title">
            <SectionHeader title={<span id="rs-care-title">{isToday ? '今日 気をつけること' : '気をつけること'}</span>}/>
            <p className={styles.sideText}>
              {pending.length > 0
                ? `・承認待ちが ${formatNumber(pending.length)} 件（${pending.map((item) => `${withHonorific(item.customer_name.split(/\s+/)[0])}・${sourceName(item.source)}`).join('、')}）`
                : '・承認待ちはありません'}
            </p>
            {allergies.length > 0 ? (
              <p className={`${styles.sideText} ${styles.sideAlert}`}>{`・アレルギー ${formatNumber(allergies.length)} 件（${allergies.map((item) => (item.allergy_note ?? '').replace(/・/g, '')).join('・')}）`}</p>
            ) : null}
            {peak >= 0 ? (
              <p className={styles.sideText}>
                {freeAtPeak.length === 0
                  ? `・${slotLabel(peak)} に空いている卓はありません`
                  : `・${slotLabel(peak)} に空いているのは ${freeAtPeak.map((table) => `${table.code}（${table.max_capacity}名）`).join('・')}${freeAtPeak.length === 1 ? 'だけ' : ''}`}
              </p>
            ) : null}
          </Card>
          <Card frame="raised" layout="vertical" padding="roomy" className={styles.sideCard} aria-labelledby="rs-break-title">
            <SectionHeader title={<span id="rs-break-title">{`${dayShort(day)}の内訳`}</span>}/>
            <p className={styles.sideText}>{`予約 ${formatNumber(countedBookings.length)}件・${guests}名`}{' ／ '}{`LINE ${lineCount}・媒体 ${mediaCount}・電話 ${phoneCount}`}{' ／ '}{`仮押さえ ${holds.length}枠`}</p>
          </Card>
          <Card frame="raised" layout="vertical" padding="roomy" className={styles.sideCard} aria-labelledby="rs-links-title">
            <SectionHeader title={<span id="rs-links-title">つながる先</span>}/>
            <Link className={styles.sideLink} href="/restaurant-test/inventory">予約枠・在庫 → 時間帯ごとの空き</Link>
            <Link className={styles.sideLink} href="/restaurant-test/tables">座席・卓管理 → 卓の結合・停止</Link>
            <Link className={styles.sideLink} href="/restaurant-test/line-followup">LINE来店フォロー → 前日・当日のご案内</Link>
          </Card>
        </div>
      </div>
    </>
  )
}
