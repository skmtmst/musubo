'use client'
import { CalendarSlotButton, useCalendarTimeScale } from '@/components/shared/calendar-parts'
import { CircleHelp, Plus, Star } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import ActionMenu, { type ActionMenuItem } from '@/components/shared/action-menu'
import ListToolbar from '@/components/shared/list-toolbar'
import { BookingBlock } from '@/components/shared/booking-controls'
import { calendarBookingState } from '@/components/shared/booking-state'
import { BookingNowLine, BookingCardContent, BookingVisibleLegend, BookingStaffHeading, BookingRest } from '@/components/shared/booking-presentation'
import StatusBadge from '@/components/shared/status-badge'
import type { StyleBoard, StyleBoardEntry } from './model'
import styles from './style-dashboard.module.css'
import { withHonorific } from '@line-crm/shared'

/*
 * 1枚目のタブの「盤（時間×担当）」（サロンの台帳 mOAX5）。
 * 列＝担当、縦＝時刻（1時間＝--tpl-sd-hour）。過ぎた時間は薄く、今の時刻に濃い灰の線。
 * 予約の箱を押すと詳細、空き（＋入れる）を押すと予約を入れる。
 */

const toMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m }
const at = (hm: string, from: string): CSSProperties => ({ insetBlockStart: `calc(var(--tpl-sd-hour) * ${(toMin(hm) - toMin(from)) / 60} + var(--tpl-sd-board-top))` })
const span = (start: string, end: string): CSSProperties => ({ blockSize: `calc(var(--tpl-sd-hour) * ${(toMin(end) - toMin(start)) / 60} - var(--tpl-sd-entry-gap))` })
const col = (index: number, count: number): CSSProperties => ({ insetInlineStart: `calc(var(--tpl-sd-time-col) + (100% - var(--tpl-sd-time-col)) / ${count} * ${index})`, inlineSize: `calc((100% - var(--tpl-sd-time-col)) / ${count})` })

export function StaffBoard({ board, search, onSearch, canWrite, entryItems, onSlot, empty }: {
  empty?: ReactNode
  board: StyleBoard
  search: string
  onSearch: (value: string) => void
  canWrite: boolean
  /** 予約の箱を押すと開く操作（行の「…」と同じ並び）。 */
  entryItems: (entry: StyleBoardEntry) => ActionMenuItem[]
  onSlot: (columnId: string, start: string) => void
}) {
  const hours: string[] = []
  for (let m = toMin(board.from); m <= toMin(board.to); m += 30) hours.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
  const count = board.columns.length
  const [openId, setOpenId] = useState<string | null>(null)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const shown = board.entries.filter((e) => !search || e.name.includes(search) || e.menu.includes(search))
  const opened = shown.find((e) => e.id === openId && e.state !== 'off' && board.columns.some((c) => c.id === e.columnId)) ?? null
  useEffect(() => {
    if (openId && !opened) setOpenId(null)
  }, [openId, opened])
  const timeScale = useCalendarTimeScale(shown, [], false, 'board')
  return (
    <section ref={timeScale} className={styles.board} aria-label="台帳の盤">
      <div className={styles.boardTools}>
        {board.next ? <span className={styles.nextChip}><CircleHelp size={16} aria-hidden="true" />次の空き<strong>{board.next}</strong></span> : null}
        <span className={styles.grow} />
        <div className={styles.search}><ListToolbar search={{ value: search, onChange: onSearch, placeholder: "名前・電話で探す", width: 220 }} /></div>
      </div>
      <BookingVisibleLegend states={[...new Set(shown.map(e => calendarBookingState(e.state)))]}/>
      {empty}
      <div className={styles.boardStaff}>
        <span className={styles.boardTimeHead} />
        {board.columns.map((c) => (
          <div key={c.id} className={styles.boardColumnHead}>
            <BookingStaffHeading name={c.name} details={`${c.count}件・${c.next}`} different={c.off} />
          </div>
        ))}
      </div>
      <div className={styles.boardGrid} style={{ blockSize: `calc(var(--tpl-sd-hour) * ${(toMin(board.to) - toMin(board.from)) / 60} + var(--tpl-sd-board-top) * 2)` }}>
        {board.now ? <span className={styles.boardPast} style={{ blockSize: `calc(var(--tpl-sd-hour) * ${(toMin(board.now) - toMin(board.from)) / 60} + var(--tpl-sd-board-top))` }} aria-hidden="true" /> : null}
        {hours.map((h) => (
          <div key={h} className={styles.boardLine} data-half={h.endsWith(':30') || undefined} style={at(h, board.from)}>
            {h.endsWith(':00') ? <span className={styles.boardHour}>{h}</span> : null}
          </div>
        ))}
        {board.columns.map((c, i) => <span key={c.id} className={styles.boardDivider} style={col(i, count)} aria-hidden="true" />)}
        {shown.map((e) => {
          const i = board.columns.findIndex((c) => c.id === e.columnId)
          if (i < 0) return null
          return (
            <div key={e.id} className={styles.entryWrap} style={{ ...col(i, count), ...at(e.start, board.from), ...span(e.start, e.end) }}>
              {e.state === 'off' ? <BookingRest title={[`${e.start}〜${e.end}`, e.name || '休憩', e.menu, e.stateLabel].filter(Boolean).join(' ')}>{e.name || '休憩'}</BookingRest> : <BookingBlock placement="board" ref={openId === e.id ? anchor : undefined} state={calendarBookingState(e.state)} source={e.source} data-selected={e.selected || openId === e.id || undefined} aria-haspopup="menu" aria-expanded={openId === e.id} onClick={(ev) => { anchor.current = ev.currentTarget; setOpenId(openId === e.id ? null : e.id) }} aria-label={`${e.start}〜${e.end} ${withHonorific(e.name)} ${e.menu} ${e.stateLabel}`}>
                <BookingCardContent name={e.name} time={`${e.start}〜${e.end}`} menu={e.menu} state={calendarBookingState(e.state)} source={e.source} statusLabel={e.stateLabel}>
                  {e.nominated ? <Star size={16} className={styles.star} aria-label="指名" /> : null}{e.unpaid ? <StatusBadge tone="danger" dot={false} size="micro">未払い</StatusBadge> : null}
                </BookingCardContent>
              </BookingBlock>}
            </div>
          )
        })}
        {canWrite ? board.free.map((f) => {
          const i = board.columns.findIndex((c) => c.id === f.columnId)
          if (i < 0) return null
          return (
            <div key={`${f.columnId}-${f.start}`} className={styles.entryWrap} style={{ ...col(i, count), ...at(f.start, board.from), blockSize: 'var(--tpl-sd-free-h)' }}>
              <CalendarSlotButton onClick={() => onSlot(f.columnId, f.start)}><Plus size={16} aria-hidden="true" />入れる<span>{f.start}〜</span></CalendarSlotButton>
            </div>
          )
        }) : null}
        {board.now ? <BookingNowLine direction="horizontal" time={board.now} style={at(board.now, board.from)}/> : null}
      </div>
      {opened ? <ActionMenu open items={entryItems(opened)} anchorRef={anchor} ariaLabel={`${opened.name}の操作`} onClose={() => setOpenId(null)} /> : null}
      <div className={styles.boardLegend}>
        <span className={styles.grow} />
        {canWrite ? <span className={styles.cellMuted}>空いている所を押すと予約を入れられます</span> : null}
      </div>
    </section>
  )
}
