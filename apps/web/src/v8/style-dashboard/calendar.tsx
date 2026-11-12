'use client'
import { ChevronLeft, ChevronRight, Info } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { CalendarPerson, CalendarTimeEntries, calendarTimeRange, useCalendarTimeScale } from '@/components/shared/calendar-parts'
import { BookingVisibleLegend } from '@/components/shared/booking-presentation'
import { calendarBookingState } from '@/components/shared/booking-state'
import MonthCalendarGrid from '@/components/shared/month-calendar'
import CalendarPeriod from '@/components/shared/calendar-period'
import Button from '@/components/shared/button'
import IconButton from '@/components/shared/icon-button'
import StatusBadge from '@/components/shared/status-badge'
import type { StyleMonth, StyleWeek } from './model'
import styles from './style-dashboard.module.css'

/*
 * 1枚目のタブの「カレンダー」。1週間＝週の形（UtmIg）、1か月＝月の形（R28Jqt）。
 * 予約を押すと詳細、空きを押すと予約を入れる、日を押すとその日の予約が右に出る。
 */

const toMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m }
const box = (start: string, end: string, day: number, days: number, from: number): CSSProperties => ({
  insetBlockStart: `calc(var(--tpl-sd-week-hour) * ${(toMin(start) - from * 60) / 60} + var(--tpl-sd-board-top))`,
  blockSize: `calc(var(--tpl-sd-week-hour) * ${(toMin(end) - toMin(start)) / 60} - var(--tpl-sd-entry-gap))`,
  insetInlineStart: `calc(var(--tpl-sd-time-col) + (100% - var(--tpl-sd-time-col)) / ${days} * ${day})`,
  inlineSize: `calc((100% - var(--tpl-sd-time-col)) / ${days})`,
})

function Pager({ title, todayLabel, onMove }: { title: string; todayLabel: string; onMove: (step: -1 | 0 | 1) => void }) {
  return (
    <div className={styles.calPager}>
      <IconButton aria-label="前へ" onClick={() => onMove(-1)}><ChevronLeft size={16} /></IconButton>
      <h3 className={styles.calTitle}>{title}</h3>
      <IconButton aria-label="次へ" onClick={() => onMove(1)}><ChevronRight size={16} /></IconButton>
      <Button onClick={() => onMove(0)}>{todayLabel}</Button>
    </div>
  )
}

export function WeekCalendar({ week, canWrite, onMove, onSlot, onOpen, period = 'week', empty }: { empty?: ReactNode; period?: 'day' | 'week'; week: StyleWeek; canWrite: boolean; onMove: (step: -1 | 0 | 1) => void; onSlot: (day: string, start: string) => void; onOpen: (id: string) => void }) {
  const timeScale = useCalendarTimeScale(week.entries, week.free, canWrite)
  const axis = calendarTimeRange([...week.entries, ...(canWrite ? week.free : [])])
  const position = (start: string, end: string, day: number, days: number) => box(start, end, day, days, axis.from)
  const hours: string[] = []
  for (let h = axis.from; h < axis.to; h += 1) hours.push(`${h}:00`)
  return (
    <section ref={timeScale} className={styles.calendar} aria-label={period === 'day' ? '1日のカレンダー' : '1週間のカレンダー'}>
      <div className={styles.calTools}>
        <Pager title={week.title} todayLabel={period === 'day' ? '今日' : '今週'} onMove={onMove} />
        <span className={styles.grow} />
        <span className={styles.calLegend}><i data-k="booked" />予約<i data-k="free" />空き<i data-k="off" />休み</span>
      </div>
      <BookingVisibleLegend states={[...new Set(week.entries.map(entry => calendarBookingState(entry.state ?? 'confirmed')))]} />
      {empty}
      <CalendarPeriod period={week.days[0]?.date ?? ''} scope={period}><div className={styles.weekFrame}>
        <div className={styles.weekHead}>
          <span className={styles.boardTimeHead} />
          {week.days.map((d) => (
            <div key={d.date} className={styles.weekDay} data-today={d.today || undefined} aria-current={d.today ? 'date' : undefined}>
              <strong>{d.label}</strong><span>{d.today ? `今日・${d.sub}` : d.sub}</span>
            </div>
          ))}
        </div>
        <CalendarTimeEntries days={week.days.map(day => day.date)} entries={week.entries} free={week.free} canWrite={canWrite} position={position} onOpen={onOpen} onSlot={onSlot} hourCount={axis.to - axis.from}>
          {hours.map((h) => <div key={h} className={styles.boardLine} style={{ insetBlockStart: `calc(var(--tpl-sd-week-hour) * ${toMin(h) / 60 - axis.from} + var(--tpl-sd-board-top))` }}><span className={styles.boardHour}>{h.padStart(5, '0')}</span></div>)}
          {week.days.map((d, i) => <span key={d.date} className={styles.boardDivider} data-closed={d.closed || undefined} style={{ insetInlineStart: `calc(var(--tpl-sd-time-col) + (100% - var(--tpl-sd-time-col)) / ${week.days.length} * ${i})`, inlineSize: `calc((100% - var(--tpl-sd-time-col)) / ${week.days.length})` }}>{d.closed ? <span className={styles.closedLabel}>定休日</span> : null}</span>)}
        </CalendarTimeEntries>
      </div></CalendarPeriod>
    </section>
  )
}

export function MonthCalendar({ month, onMove, onDay }: { month: StyleMonth; onMove: (step: -1 | 0 | 1) => void; onDay: (date: string) => void }) {
  return (
    <section className={styles.calendar} aria-label="1か月のカレンダー">
      <div className={styles.calTools}>
        <Pager title={month.title} todayLabel="今月" onMove={onMove} />
        <span className={styles.grow} />
        <span className={styles.calLegend}><i data-k="few" />満席に近い<i data-k="full" />満席<i data-k="off" />休み</span>
      </div>
      <MonthCalendarGrid title={month.title} days={month.days} onDay={onDay} />
    </section>
  )
}

export function DayList({ month, href, canWrite }: { month: StyleMonth; href: string; canWrite: boolean }) {
  const s = month.selected
  return (
    <div className={styles.dayList}>
      <div className={styles.dayListHead}><h3 className={styles.sideTitle}>{s.title}</h3><span className={styles.grow} /><span className={styles.cellMuted}>{s.total}</span></div>
      <div className={styles.dayListCard}>
        {s.rows.map((r) => (
          <div key={`${r.time}-${r.name}`} className={styles.dayRow}>
            <strong className={styles.dayTime}>{r.time}</strong>
            <CalendarPerson href={href} name={r.name} secondary={<span className={styles.cellSub}>{r.sub}</span>} />
            <span className={styles.grow} />
            <StatusBadge tone={r.state.tone}>{r.state.label}</StatusBadge>
          </div>
        ))}
      </div>
      <a className={styles.sideMore} href={href}>{s.moreLabel}</a>
      <p className={styles.dayHint}><Info size={16} aria-hidden="true" />日を押すと、その日の予約がここに出ます。{canWrite ? '休みは［休みを入れる］から。' : null}</p>
    </div>
  )
}
