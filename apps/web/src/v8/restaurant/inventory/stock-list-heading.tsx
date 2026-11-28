import type { ReactNode } from 'react'
import { CardHeader } from '@/components/shared/card'
import DateField from '@/components/shared/date-field'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { dayLabel } from './format'
import styles from './inventory.module.css'

export default function StockListHeading({ date, busy, onChange, children }: {
  date: string
  busy: boolean
  children?: ReactNode
  onChange: (date: string) => void
}) {
  const handleChange = (next: string) => {
    if (busy) return
    onChange(next)
  }
  return <div className={styles.sectionHeadRow}>
    <CardHeader size="stacked" titleId="rs-stock-title" title={`時間帯ごとの在庫（${dayLabel(date)}）`} meta="予約台帳の予約から、埋まっている卓と空きを出します。行を押すと右に空席の状況が出ます" />
    <span className={styles.datePicker}><SaveErrorField names={["date"]}><DateField displayFormat="short" aria-label="在庫の日付" value={date} disabled={busy} onChange={handleChange} /></SaveErrorField></span>
    {children}
  </div>
}
