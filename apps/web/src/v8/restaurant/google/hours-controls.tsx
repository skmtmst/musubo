'use client'
import { Plus, X } from 'lucide-react'
import { HOURS_WEEKDAYS, hoursPeriodsProblem, type HoursWeekday, type OpeningPeriod } from '@line-crm/shared'
import Button from '@/components/shared/button'
import IconButton from '@/components/shared/icon-button'
import TimeField from '@/components/shared/time-field-v8'
import { Field } from '@/components/shared/form-controls'
import { WeekdayButtons } from '@/components/shared/hours-date-calendar'
import Notice from '@/components/shared/notice'
import { WEEKDAY_JA } from './format'
import styles from './hours.module.css'

export function Weekdays({ selected, onChange, disabled }: { selected: HoursWeekday[]; onChange: (days: HoursWeekday[]) => void; disabled?: boolean }) {
 return <WeekdayButtons
  labels={HOURS_WEEKDAYS.map(d=>WEEKDAY_JA[d])}
  selected={selected.map(d=>HOURS_WEEKDAYS.indexOf(d)).filter(i=>i>=0)}
  disabled={disabled}
  onChange={indices=>{
   if (disabled) return
   onChange(indices.filter(i=>i>=0&&i<HOURS_WEEKDAYS.length).map(i=>HOURS_WEEKDAYS[i]))
  }}
 />
}
export function PeriodFields({ value, onChange, disabled, takeout = false }: { value: OpeningPeriod[]; onChange: (p: OpeningPeriod[]) => void; disabled?: boolean; takeout?: boolean }) {
 const problem = hoursPeriodsProblem(value)
 const updateOpen = (index: number, next: string) => {
  if (disabled) return
  onChange(value.map((a,j)=>index===j?{...a,open:next}:a))
 }
 const updateClose = (index: number, next: string) => {
  if (disabled) return
  onChange(value.map((a,j)=>index===j?{...a,close:next==='24:00'?'00:00':next}:a))
 }
 const removePeriod = (index: number) => {
  if (disabled || value.length <= 1) return
  onChange(value.filter((_,j)=>index!==j))
 }
 const addPeriod = () => {
  if (disabled || value.length >= 3) return
  onChange([...value,{open:value.length?'17:00':'11:00',close:value.length?'22:00':'15:00'}])
 }
 return <div className={styles.stack}>
  {value.map((p,i)=><div key={i} className={styles.timeRow}>
   <Field optional={false} label={takeout?'受取開始':'開店'}><TimeField appearance="business-hours" pickerTrigger="field" aria-label={`${takeout?'受取開始':'開店'} ${i+1}`} value={p.open} minuteStep={15} disabled={disabled} onChange={v=>updateOpen(i,v)} /></Field><span className={styles.timeDash}>–</span>
   <Field optional={false} label={takeout?'受取終了':'閉店'}><TimeField appearance="business-hours" pickerTrigger="field" aria-label={`${takeout?'受取終了':'閉店'} ${i+1}`} value={p.close==='00:00'?'24:00':p.close} allowEndOfDay minuteStep={15} disabled={disabled} onChange={v=>updateClose(i,v)} /></Field>
   {value.length>1?<IconButton variant="plain" size="row" aria-label={`時間帯${i+1}を削除`} disabled={disabled} onClick={()=>removePeriod(i)}><X size={16}/></IconButton>:null}
  </div>)}
  {value.length<3?<div><Button presentation="hours" variant="text" size="compact" icon={<Plus size={15}/>} disabled={disabled} onClick={addPeriod}>時間帯を追加</Button></div>:null}
  {problem?<Notice tone="danger">{problem}</Notice>:null}
 </div>
}
