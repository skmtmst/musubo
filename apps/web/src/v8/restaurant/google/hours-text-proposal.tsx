'use client'
import { Sparkles } from 'lucide-react'
import { hoursDateAdd, hoursDateRange, hoursWeekday, type HoursWorkspace, type OpeningDate } from '@line-crm/shared'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Notice from '@/components/shared/notice'
import type { GoogleChange, GoogleProfileData } from '@/lib/restaurant-google-api'
import { hoursText, workspaceDay } from './hours-model'
import styles from './hours.module.css'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const longDate = (date: string) => {
 if (!ISO_DATE.test(date)) return date
 const [year, month, day] = date.split('-').map(Number)
 return `${year}年${month}月${day}日`
}

/** 読み取った実際の日付と営業状態を、確認しやすい変更案にまとめる。 */
export function HoursTextProposal({ change, data, workspace, holidays, onEditDates }: { change: GoogleChange; data:GoogleProfileData; workspace:HoursWorkspace; holidays:Array<{date:string}>; onEditDates: (dates: string[]) => void }) {
 const rawDays = change.kind === 'special_hours' && Array.isArray(change.after) ? change.after as OpeningDate[] : []
 const byDate = new Map<string, OpeningDate>()
 for (const entry of rawDays) {
  if (entry && typeof entry.date === 'string' && ISO_DATE.test(entry.date)) byDate.set(entry.date, entry)
 }
 const days = [...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date))
 const dates = days.map(d=>d.date)
 const contiguous = dates.length > 0 && hoursDateRange(dates[0],dates[dates.length-1]).length === dates.length
 const sameHours = days.length > 0 && days.every(d=>d.closed===days[0].closed && JSON.stringify(d.periods)===JSON.stringify(days[0].periods) && d.remove===days[0].remove)
 const caption = contiguous ? dates.length===1 ? longDate(dates[0]) : `${longDate(dates[0])} – ${longDate(dates[dates.length-1])}` : dates.map(longDate).join('・')
 const summary = sameHours ? `${days.length}${contiguous?'日間':'日'} ${days[0].remove?'通常の営業時間に戻す':days[0].closed?'休業':hoursText(days[0].periods)}` : change.summary
 const next = contiguous ? hoursDateAdd(dates[dates.length-1],1) : null
 const returnsToWeekly = next && JSON.stringify(workspaceDay(next,data,workspace,holidays).periods) === JSON.stringify((workspace.draft.weekly??data.profile.regularHours)[hoursWeekday(next)])
 return <section className={styles.proposalSection}>
  <h3 className={styles.proposalTitle}><Sparkles size={18} aria-hidden="true"/>読み取った変更案</h3>
  <Card surface="proposal" padding="default" layout="vertical" gap="var(--space-16)">
   {caption ? <p className={styles.proposalDate}>{caption}</p> : null}
   <strong className={styles.proposalSummary}>{summary}</strong>
   {next ? <p className={styles.proposalNote}>{Number(next.slice(5,7))}月{Number(next.slice(8))}日{returnsToWeekly?'から毎週の営業時間に戻ります。':'以降の営業予定は変更しません。'}</p> : null}
   {dates.length ? <div><Button presentation="hours" variant="text" size="compact" onMouseDown={event=>event.preventDefault()} onClick={()=>onEditDates(dates)}>日付や時間を直す</Button></div> : null}
  </Card>
  <Notice tone="info" appearance="subtle">読み取った日付を確認してください。Googleにはまだ反映されません。</Notice>
 </section>
}
