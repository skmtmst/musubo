'use client'
import { Check, ClipboardCheck, MapPin, Video } from 'lucide-react'
import type React from 'react'
import Button from '@/components/shared/button'
import { GridTable, GridHeadRow, GridRow, GridCell } from '@/components/shared/grid-table'
import ListState from '@/components/shared/list-state'
import { RowMenu } from '@/components/shared/row-actions'
import TruncatedText from '@/components/shared/truncated-text'
import type { ActionMenuItem } from '@/components/shared/action-menu'
import type { IndustryStyle, StyleRow } from './model'
import { StatusOrDash } from './parts'
import styles from './style-dashboard.module.css'
import { withHonorific } from '@line-crm/shared'

/*
 * 1枚目のタブの「一覧」（NqAvL・R0FFqz・k2MBw）。
 * 列は業種ごと。行の右に今すぐの操作（来店・Meet に入る・場所を開く）と「…」。
 */

export type Column = { key: string; label: string; width?: string }

const COLUMNS: Record<IndustryStyle, Column[]> = {
  restaurant: [
    { key: 'time', label: '時刻', width: 'var(--tpl-sd-col-time)' },
    { key: 'name', label: '名前' },
    { key: 'peopleSeat', label: '人数・卓', width: 'var(--tpl-sd-col-people-seat)' },
    { key: 'course', label: 'コース', width: 'var(--tpl-sd-col-course)' },
    { key: 'pay', label: '支払', width: 'var(--tpl-sd-col-pay-short)' },
    { key: 'state', label: '状態', width: 'var(--tpl-sd-col-restaurant-state)' },
    { key: 'action', label: '来店', width: 'var(--tpl-sd-col-action)' },
  ],
  salon: [
    { key: 'time', label: '時刻', width: 'var(--tpl-sd-col-time)' },
    { key: 'name', label: '名前' },
    { key: 'course', label: 'メニュー', width: 'var(--tpl-sd-col-course)' },
    { key: 'staff', label: '担当', width: 'var(--tpl-sd-col-staff)' },
    { key: 'pay', label: 'お支払い', width: 'var(--tpl-sd-col-pay)' },
    { key: 'state', label: '状態', width: 'var(--tpl-sd-col-state)' },
    { key: 'action', label: '来店', width: 'var(--tpl-sd-col-action)' },
  ],
  consult: [
    { key: 'time2', label: '時刻', width: 'var(--tpl-sd-col-time-wide)' },
    { key: 'name', label: '相談者' },
    { key: 'meet', label: '会い方', width: 'var(--tpl-sd-col-meet)' },
    { key: 'staff', label: '担当', width: 'var(--tpl-sd-col-staff)' },
    { key: 'statePay', label: '状態・支払', width: 'var(--tpl-sd-col-state-pay)' },
    { key: 'action', label: '入る', width: 'var(--tpl-sd-col-action-wide)' },
  ],
  lesson: [
    { key: 'time2', label: '時刻', width: 'var(--tpl-sd-col-time-wide)' },
    { key: 'name', label: 'クラス' },
    { key: 'fill', label: '予約／定員', width: 'var(--tpl-sd-col-fill)' },
    { key: 'waiting', label: '待ち', width: 'var(--tpl-sd-col-people)' },
    { key: 'vacancy', label: '空き', width: 'var(--tpl-sd-col-people)' },
    { key: 'pay', label: '払い方', width: 'var(--tpl-sd-col-state)' },
  ],
}

function fillTone(row: StyleRow): 'full' | 'ok' {
  return row.booked !== undefined && row.capacity !== undefined && row.booked >= row.capacity ? 'full' : 'ok'
}

function vacancyLabel(vacancy: StyleRow['vacancy']): string | undefined {
  if (vacancy === '×') return '空きなし'
  if (vacancy === '△') return '残りわずか'
  if (vacancy === '○') return '空きあり'
  return undefined
}

export function TodayList({ style, rows, note, canWrite, busyId, selectedId, menuFor, onVisit, onUndo, onSelect, onNoShow, onApprove, onResult, empty, columnsOverride }: {
  style: IndustryStyle
  rows: StyleRow[]
  note: string
  canWrite: boolean
  busyId: string
  selectedId?: string | null
  menuFor: (row: StyleRow) => ActionMenuItem[]
  onVisit: (row: StyleRow) => void
  onUndo: (row: StyleRow) => void
  onSelect?: (row: StyleRow) => void
  onNoShow?: (row: StyleRow) => void
  onApprove?: (row: StyleRow) => void
  onResult?: (row: StyleRow) => void
  /** 0 件のときの見せ方（mkyvE）。 */
  empty?: React.ReactNode
  columnsOverride?: Column[]
}) {
  const columns = columnsOverride ?? COLUMNS[style]
  const cell = (row: StyleRow, key: string) => {
    switch (key) {
      case 'time': return <span className={styles.cellText}>{row.time}</span>
      case 'time2': return <><span className={styles.cellStrong}>{row.time}</span>{row.endTime ? <span className={styles.cellSub}>{row.endTime}</span> : null}</>
      case 'name': return <>{onSelect ? <button type="button" className={styles.nameButton} onClick={() => onSelect(row)}><TruncatedText value={row.name} /></button> : <span className={styles.cellStrong}><TruncatedText value={row.name} /></span>}{row.sub ? <span className={styles.cellSub}><TruncatedText value={row.sub} /></span> : null}</>
      case 'peopleSeat': return <TruncatedText className={styles.cellText} value={`${row.people == null ? '—' : `${row.people}人`} / ${row.seat ?? '—'}`} />
      case 'statePay': return <span className={styles.statePay} title={`${row.state?.label ?? '—'} / ${row.pay?.label ?? '—'}`}><StatusOrDash badge={row.state} /><TruncatedText value={` / ${row.pay?.label ?? '—'}`} /></span>
      case 'people': return <span className={styles.cellText}>{row.people ?? '—'}</span>
      case 'seat': return <TruncatedText className={styles.cellText} value={row.seat ?? '—'} />
      case 'staff': return <TruncatedText className={styles.cellText} value={row.staff ?? '—'} />
      case 'course': return <><span className={styles.cellStrong}><TruncatedText value={row.course ?? '—'} /></span>{row.courseNote ? <span className={styles.cellSub}>{row.courseNote}</span> : null}</>
      case 'meet': return <StatusOrDash badge={row.meet} />
      case 'pay': return <StatusOrDash badge={row.pay} />
      case 'state': return <StatusOrDash badge={row.state} />
      case 'fill': return row.capacity === undefined ? <span className={styles.cellText}>{row.remaining !== undefined ? `残り ${row.remaining}` : '—'}</span> : <span className={styles.fill}><span className={styles.cellStrong}>{row.booked ?? 0}／{row.capacity ?? 0}</span><span className={styles.fillTrack}><span className={styles.fillBar} data-tone={fillTone(row)} style={{ inlineSize: `${Math.min(100, Math.round(((row.booked ?? 0) / Math.max(1, row.capacity ?? 1)) * 100))}%` }} /></span></span>
      case 'waiting': return <span className={styles.cellText}>{row.waiting ?? '—'}</span>
      case 'vacancy': return <span className={styles.cellText} aria-label={vacancyLabel(row.vacancy)}>{row.vacancy ?? '—'}</span>
      case 'action': return actionCell(row)
      default: return null
    }
  }
  const actionCell = (row: StyleRow) => {
    if (row.action === 'done') return <span className={styles.cellMuted}>済み</span>
    if (!canWrite) return null
    if (row.action === 'visit') return (
      <span className={styles.actionPair}>
        <Button size="compact" disabled={busyId === row.id} onClick={() => onVisit(row)} aria-label={`${withHonorific(row.name)}を来店にする`}>{row.past ? null : <Check size={16} aria-hidden="true" />}来店</Button>
        {row.past && onNoShow ? <Button size="compact" disabled={busyId === row.id} onClick={() => onNoShow(row)} aria-label={`${withHonorific(row.name)}を${style === 'consult' ? '欠席' : '無断'}にする`}>{style === 'consult' ? '欠席' : '無断'}</Button> : null}
      </span>
    )
    if (row.action === 'approve') return <Button size="compact" disabled={busyId === row.id} onClick={() => onApprove?.(row)} aria-label={`${withHonorific(row.name)}の予約を承認する`}><Check size={16} aria-hidden="true" />承認する</Button>
    if (row.action === 'result') return <Button size="compact" disabled={busyId === row.id} onClick={() => onResult?.(row)} aria-label={`${withHonorific(row.name)}の結果を付ける`}><ClipboardCheck size={16} aria-hidden="true" />結果を付ける</Button>
    if (row.action === 'undo') return <button type="button" className={styles.textAction} disabled={busyId === row.id} onClick={() => onUndo(row)} aria-label={`${withHonorific(row.name)}の来店の印を取り消す`}>取り消す</button>
    const actionHref = row.actionHref?.trim()
    if (row.action === 'meet') return actionHref ? <Button size="compact" href={actionHref} external><Video size={16} aria-hidden="true" />Meet に入る</Button> : null
    if (row.action === 'place') return actionHref ? <Button size="compact" href={actionHref} external><MapPin size={16} aria-hidden="true" />場所を開く</Button> : null
    return null
  }
  if (rows.length === 0) return <>{empty ?? <ListState kind="empty" title="この日の予約はまだありません" />}</>
  return (
    <div className={styles.list}><GridTable label="一覧" presentation="dashboard" framed={false} design={{
      columns: [...columns.map(c => c.width ?? 'minmax(var(--tpl-sd-name-min), 1fr)'), 'var(--tpl-sd-col-menu)'].join(' '),
      gap: 'var(--polish-space-field)', rowPadding: '0 var(--polish-space-card)',
      rowHeight: 'var(--tpl-sd-row-h)', headHeight: 'var(--tpl-sd-head-h)', fontSize: 'var(--text-body)',
    }}>
      <GridHeadRow>
        {columns.map((c) => <GridCell key={c.key} role="columnheader">{c.label}</GridCell>)}
        <GridCell aria-hidden="true" />
      </GridHeadRow>
      {rows.map((row) => (
        <GridRow key={row.id} data-selected={row.id === selectedId || (selectedId === undefined && row.highlight) || undefined}>
          {columns.map((c) => <GridCell key={c.key}>{cell(row, c.key)}</GridCell>)}
          <GridCell align="right"><RowMenu appearance="box" size="row" label={`${row.name}の操作`} items={menuFor(row)} /></GridCell>
        </GridRow>
      ))}
    </GridTable>
    <p className={styles.listNote}>{note}</p></div>
  )
}
