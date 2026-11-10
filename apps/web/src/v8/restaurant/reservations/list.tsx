'use client'
import { useLedgerFloor } from './use-ledger-floor'
import LedgerEmpty from './ledger-empty'
import type {AccountStyle, ReservationAxis} from '@line-crm/shared'
import { styleTerm } from '@/lib/terms'
import ReservationBoard from '@/components/shared/reservation-board'
import {useState,type ReactNode} from 'react'
import {DetailColumns} from '@/components/templates/detail-columns'
import {useAccount} from '@/contexts/account-context'
import {allBoardPages} from '@/lib/api/helpers/reservation-board'
import {seatBoardEntry} from '@line-crm/shared'

/*
 * ★V8 予約台帳「一覧」（板 `Z3FoM`）。今週・今月もこの形で、その期間の予約を出す。
 *
 * 数4（予約・ご来店人数・LINE予約・媒体予約）＋帯の下の短い1行（未配席）→ 期間・状態の絞り込みと
 * 受信データを試す・手動で予約を作る → 予約タイムラインの表（時刻・予約元・お客さま・人数・卓・
 * コース・注意事項・状態・操作）→ ページ送り（一覧だけ）。
 */
import { Inbox, Plus } from 'lucide-react'
import KpiCard from '@/components/shared/kpi-card'
import Card from '@/components/shared/card'
import { Field } from '@/components/shared/form-controls'
import Button from '@/components/shared/button'
import Pagination from '@/components/shared/pagination'
import { PAGE_SIZE_SELECT_OPTIONS } from '@/components/shared/page-size-select'
import {RowActions} from '@/components/shared/row-actions'
import ListState from '@/components/shared/list-state'
import StatusBadge from '@/components/shared/status-badge'
import Select from '@/components/shared/select'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import type { RestaurantReservation, RestaurantTable } from '@/lib/restaurant-test-api'
import { Panel, StatRow, Status } from '@/v8/restaurant/booking-kit/public/shell/index'
import { toYmd,INACTIVE_STATUSES, type LedgerView, isHold, maskPhone, mdhm, sourceKind, sourceName,dayRange,weekRange,monthRange } from './format'
import styles from './reservations.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { formatNumber } from '@/lib/format'


/*
 * ★V8 予約台帳「一覧」（板 `Z3FoM`）。今週・今月もこの形で、その期間の予約を出す。
 *
 * 数4（予約・ご来店人数・LINE予約・媒体予約）＋帯の下の短い1行（未配席）→ 期間・状態の絞り込みと
 * 受信データを試す・手動で予約を作る → 予約タイムラインの表（時刻・予約元・お客さま・人数・卓・
 * コース・注意事項・状態・操作）→ ページ送り（一覧だけ）。
 */

const LINE_CONTACT_LABEL = 'LINEと連携済み'

export const PAGE_SIZE = 20

export const LEDGER_STATUS_OPTIONS = [
  { value: 'all', label: 'すべての状態' },
  { value: 'pending,confirmed,seated,visited', label: '有効のみ' },
  { value: 'cancelled,no_show', label: '取消・無断のみ' },
]

export default function ListView({ accountStyle = 'standard', view, rows, total, tables, page, period, status, busy, canWrite, canImport, onPeriod, onStatus, onPage, onImport, onCreate, onOpen, onEdit, onCancel, onRestore,day,onDay,storeId,storeName,detail,onView,selectedId,pageSize=PAGE_SIZE,onPageSize }: {
  accountStyle?: AccountStyle | null
  selectedId?:string
  pageSize?:number
  onPageSize?:(size:number)=>void
  onView:(view:LedgerView)=>void
  detail?:ReactNode
  storeName?:string
  day:Date;onDay:(day:Date)=>void;storeId:string
  view: LedgerView
  rows: RestaurantReservation[]
  /** 一覧は口の総数（ページ送りの母数）。今週・今月は表示中の数。 */
  total: number
  tables: RestaurantTable[]
  page: number
  period: string
  status: string
  busy: boolean
  canWrite: boolean
  /** 受信データの試し（媒体受信の口）は管理者だけ。 */
  canImport: boolean
  onPeriod: (value: string) => void
  onStatus: (value: string) => void
  onPage: (page: number) => void
  onImport: () => void
  onCreate: () => void
  onOpen: (id: string) => void
  onEdit: (id: string) => void
  onCancel: (id: string) => void
  onRestore: (id: string) => void
}) {
  const person = styleTerm(accountStyle ?? 'standard', 'V12').split('（')[0]
  const [detailExpanded,setDetailExpanded]=useState(false)
  const {selectedAccountId}=useAccount()
  const [axis,setAxis]=useState<ReservationAxis>(view==='month'?'month':'list')
  const {floor,error:floorError,reload:reloadFloor}=useLedgerFloor(selectedAccountId,storeId)
  const range=view==='week'?weekRange(day):view==='month'?monthRange(day):{from:period==='past'?'1970-01-01T00:00:00Z':period==='upcoming'?dayRange(new Date()).from:'1970-01-01T00:00:00Z',to:period==='past'?dayRange(new Date()).from:'2100-01-01T00:00:00Z'}
  const printEntries=selectedAccountId?()=>allBoardPages('seats',selectedAccountId,range.from,range.to,storeId).then(es=>es.filter(e=>status==='all'||status.split(',').includes(e.status))):undefined
  const live = rows.filter((item) => !INACTIVE_STATUSES.includes(item.status) && !isHold(item))
  const guests = live.reduce((sum, item) => sum + item.guest_count, 0)
  const cancelledGuests = rows.filter((item) => INACTIVE_STATUSES.includes(item.status)).reduce((sum, item) => sum + item.guest_count, 0)
  const lineCount = live.filter((item) => item.source === 'line').length
  const mediaCount = live.filter((item) => sourceKind(item.source) === 'media' || item.source === 'restaurant_board').length
  const unseated = live.filter((item) => !item.departed_at && seatBoardEntry(item as unknown as Record<string,unknown>).resourceIds.length === 0).length
  const [year, month] = toYmd(day).split('-').map(Number)
  const moveMonth = (offset: number) => onDay(new Date(Date.UTC(year, month - 1 + offset, 1, 3)))
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const tableById = new Map(tables.map((table) => [table.id, table]))

  return (
    <>
      <StatRow fusion>
        <KpiCard title="予約記録" value={total} unit="件" detail={`取消・押さえを含む・表示中 ${formatNumber(rows.length)}件`} icon={undefined} presentation="band" />
        <KpiCard title="ご来店人数" value={guests} unit="名" detail={cancelledGuests > 0 ? `表示中の有効な予約・取消 ${cancelledGuests}名を除く` : '表示中の有効な予約'} icon={undefined} presentation="band" />
        <KpiCard title="LINE予約" value={lineCount} unit="件" detail="自社導線" icon={undefined} presentation="band" />
        <KpiCard title="媒体予約" value={mediaCount} unit="件" detail="受信した予約" icon={undefined} presentation="band" />
      </StatRow>
      {/* R11: 5つ目は帯の下の短い1行に残す。配席は今日の盤で付ける。 */}
      <p className={styles.fifthLine}>未配席 {formatNumber(unseated)} 件 <Button variant="text" size="inline" onClick={() => onView('today')}>今日の配席へ →</Button></p>
      <ReservationBoard formatListDateTime={mdhm} notice={floorError ? <ListState kind="error" title="座席表を読み込めませんでした" error={floorError} onRetry={reloadFloor}/> : undefined} selectedId={selectedId} printContext={`${storeName??storeId} ／ ${view==='week'?'今週':view==='month'?'今月':period==='past'?'過去の予約':period==='upcoming'?'今後の予約':'すべての予約'} ／ ${LEDGER_STATUS_OPTIONS.find(o=>o.value===status)?.label??status}`} title="予約台帳" loadPrintEntries={printEntries} axis={axis} floor={floor} dates={[toYmd(day)]} onAxis={v=>{setAxis(v);if(v==='resource')onView('today');else if(v==='month')onView('month');else if(v==='list')onView('list')}} columns="dining" diningContentColumns monthNamePresentation="readable" entries={rows.map(r=>{const entry=seatBoardEntry(r as unknown as Record<string,unknown>);return r.line_uid?{...entry,contactLabel:LINE_CONTACT_LABEL}:entry})} resources={tables.map(t=>({id:t.id,label:t.code,active:!!t.is_active,capacity:t.max_capacity}))} onOpen={onOpen} actions={e=><RowActions subjectName={e.customerName} edit={{label:'変更',disabled:busy,onClick:()=>onEdit(e.id)}} menuItems={[{id:'detail',label:'詳細を見る',onSelect:()=>onOpen(e.id)},...(INACTIVE_STATUSES.includes(e.status)?[{id:'restore',label:'予約を有効に戻す',onSelect:()=>onRestore(e.id)}]:[{id:'cancel',label:'取消',tone:'danger' as const,onSelect:()=>onCancel(e.id)}])]} />} canWrite={canWrite} busy={busy}
        toolbar={      <>
        {view === 'month' ? <><Button presentation="restaurant" onClick={() => moveMonth(-1)} aria-label="前の月">前の月</Button><strong>{year}年{month}月</strong><Button presentation="restaurant" onClick={() => moveMonth(1)} aria-label="次の月">次の月</Button></> : null}
        {view === 'list' ? (
          <>
            <div className={styles.filterField} data-filter="period">
              <Field labelSize="compact" labelHidden label="期間">
              <SaveErrorField names={["period"]}><Select aria-label="期間" label="期間" size="full" value={period} onChange={onPeriod} options={[
                { value: 'upcoming', label: '今後の予約' },
                { value: 'all', label: 'すべての期間' },
                { value: 'past', label: '過去の予約' },
              ]} /></SaveErrorField>
              </Field>
            </div>
            <div className={styles.filterField} data-filter="status">
              <Field labelSize="compact" labelHidden label="状態">
              <SaveErrorField names={["status"]}><Select aria-label="状態" label="状態" size="full" value={status} onChange={onStatus} options={LEDGER_STATUS_OPTIONS} /></SaveErrorField>
              </Field>
            </div>
          </>
        ) : null}
</>} trailingToolbar={<>        <span className={styles.dateSpacer} />
        {view === 'list' && onPageSize ? <Select aria-label="1ページに出す件数" size="page-size" value={String(pageSize)} onChange={(value) => onPageSize(Number(value))} options={PAGE_SIZE_SELECT_OPTIONS} /> : null}
        {canImport ? <Button presentation="restaurant" disabled={busy} onClick={onImport}><Inbox size={16} aria-hidden="true" />受信データを試す</Button> : null}
        {canWrite ? <Button presentation="restaurant" aria-label="手動で予約を作る" disabled={busy} onClick={onCreate}><Plus size={16} aria-hidden="true" />手動予約</Button> : null}
      </>} renderBody={body=><DetailColumns asideLayout="detail" variant="restaurant-ledger" asideLabel="予約の詳細を見る" expanded={detailExpanded} onExpandedChange={setDetailExpanded} aside={detail}>
        {tables.length===0 ? <LedgerEmpty noTables canWrite={canWrite} busy={busy} onCreate={onCreate}/> : rows.length===0 ? <LedgerEmpty noTables={false} filtered={status!=='all'||view==='list'&&period!=='all'} canWrite={canWrite} busy={busy} onCreate={onCreate}/> : null}
        {(rows.length===0 && axis!=='month') || axis==='floor' && floorError ? null : body}
        {view === 'list' && pageCount > 1 ? (
          <Pagination spacing="restaurant" page={page} pageCount={pageCount} onPageChange={onPage} ariaLabel="予約台帳のページ送り" disabled={busy} summary={`${total} 件中 ${(page - 1) * pageSize + 1}〜${Math.min((page - 1) * pageSize + rows.length, total)} 件`} />
        ) : null}
      <Panel fusion title="顧客カルテ" description={`表示中の予約に登録された${person}の情報です。`}>
        <div className={styles.karte}>
          {live.slice(0, 3).map((item) => (
            <Card key={item.id} frame="inset" corner="segment" padding="compact" layout="vertical" className={styles.karteCard}>
              <p className={styles.karteName}>{item.customer_name}</p>
              <p className={styles.karteContact}>{item.line_uid ? LINE_CONTACT_LABEL : maskPhone(item.customer_phone) || emptyValue('unconfigured')}</p>
              <p className={styles.karteRecent}>{`直近：${mdhm(item.starts_at)} / ${item.guest_count}名`}</p>
            </Card>
          ))}
          {live.length === 0 ? <p className={styles.karteRecent}>表示中の予約がありません。</p> : null}
        </div>
      </Panel>
      </DetailColumns>}/>

    </>
  )
}
