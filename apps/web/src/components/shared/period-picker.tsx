'use client'

import { jstDate, jstDateOffset } from '@/lib/jst-datetime'
import { useEffect, useMemo, useState } from 'react'
import { useListUrlValue, useListUrlJsonValue } from './list-url-state'
import SegmentedControl from './segmented'
import DateField from './date-field'
import { Field } from './form-controls'
import styles from './period-picker.module.css'

export type PeriodRange = { from: string; to: string }
export const PERIOD_DAYS = [7, 30, 90] as const
export function pastPeriod(days: number, now = new Date()): PeriodRange {
  return { from: jstDateOffset(1 - days, now), to: jstDate(now) }
}
export function validPeriod(range: PeriodRange): boolean {
  return [range.from, range.to].every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value) && range.from <= range.to
}
export function useReportPeriod(initialDays = 30) {
  const [days, updateDays] = useListUrlValue('days', initialDays)
  const [customRange, setRange] = useListUrlJsonValue<PeriodRange | null>('range', null, (value): value is PeriodRange | null => value === null || (typeof value === 'object' && !Array.isArray(value) && typeof (value as PeriodRange).from === 'string' && typeof (value as PeriodRange).to === 'string' && validPeriod(value as PeriodRange)))
  const range = useMemo(() => customRange ?? pastPeriod(days), [days, customRange])
  const setDays = (value: number) => { setRange(null); updateDays(value) }
  return { days, setDays, range, customRange, setRange }
}
/** 集計期間の言葉・日付欄を一か所で管理する。API制限のある口は supportedDays を渡す。 */
export default function PeriodPicker({ days, onChange, customRange, onRangeChange, supportedDays = PERIOD_DAYS, size = 'medium', choices, maxDays, maxDate, applyOnOpen = false }: {
  days: number; onChange: (days: number) => void; customRange?: PeriodRange | null; onRangeChange?: (range: PeriodRange) => void
  choices?: { days: number; label: string }[]; supportedDays?: readonly number[]; size?: 'small' | 'medium'; maxDays?: number; maxDate?: string; applyOnOpen?: boolean
}) {
  const [customOpen, setCustomOpen] = useState(false)
  const [draft, setDraft] = useState<PeriodRange>(() => customRange ?? pastPeriod(days))
  useEffect(() => { if (customRange) setDraft(customRange); else setCustomOpen(false) }, [customRange?.from, customRange?.to])
  const custom = Boolean(customRange) || customOpen
  const options = choices ? choices.map((item) => ({ value: String(item.days), label: item.label })) : supportedDays.map((value) => ({ value: String(value), label: `過去${value}日` }))
  if (onRangeChange) options.push({ value: 'custom', label: '期間を指定' })
  const allowed = (range: PeriodRange) => validPeriod(range) && (!maxDate || range.to <= maxDate) && (!maxDays || Date.parse(range.to) - Date.parse(range.from) < maxDays * 86_400_000)
  const update = (next: PeriodRange) => { setDraft(next); if (allowed(next)) onRangeChange?.(next) }
  return <div className={styles.root} data-period-range={custom || undefined}>
    <SegmentedControl aria-label="集計期間" size={size} options={options} value={custom ? 'custom' : String(days)} onChange={(value) => {
      if (value === 'custom') { const next = customRange ?? pastPeriod(days); setDraft(next); setCustomOpen(true); if (applyOnOpen && allowed(next)) onRangeChange?.(next) }
      else { setCustomOpen(false); onChange(Number(value)) }
    }} />
    {custom && onRangeChange ? <div className={styles.dates}>
      <Field label="期間の始まり" required><DateField aria-label="期間の始まり" value={draft.from} max={draft.to || undefined} onChange={(from) => update({ ...draft, from })} /></Field>
      <Field label="期間の終わり" required error={allowed(draft) ? undefined : maxDays ? `今日までの${maxDays}日以内で指定してください。` : '終わりは始まり以降の日付にしてください。'}><DateField aria-label="期間の終わり" value={draft.to} min={draft.from || undefined} max={maxDate} onChange={(to) => update({ ...draft, to })} /></Field>
    </div> : null}
  </div>
}
