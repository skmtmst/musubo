'use client'
import { useEffect, useState } from 'react'
import { hoursDateAdd, hoursDateRange, hoursWeekday, hoursPeriodsProblem, type OpeningDate, type OpeningWeek, type OpeningPeriod } from '@line-crm/shared'
import Button from '@/components/shared/button'
import CloseButton from '@/components/shared/close-button'
import DateField from '@/components/shared/date-field'
import HoursDateCalendar from '@/components/shared/hours-date-calendar'
import { Field } from '@/components/shared/form-controls'
import Radio, { RadioGroup } from '@/components/shared/radio'
import SegmentedControl from '@/components/shared/segmented'
import { TextField } from '@/components/shared/text-field'
import Notice from '@/components/shared/notice'
import { readGuideDraft, writeGuideDraft } from '@/lib/scoped-guide-draft'
import Checkbox from '@/components/shared/checkbox'
import { PeriodFields } from './hours-controls'
import { dateLabel, hoursLongDateLabel } from './hours-model'
import styles from './hours.module.css'

export type DateEditorValue = { dates: string[]; periods: OpeningPeriod[]; closed: boolean; memo: string; remove?: boolean }
type DateDraft = DateEditorValue & { version?: number; mode: 'dates' | 'range'; start: string; end: string; month: string; memoOpen: boolean }
export function DateEditor({ today, initialDates=[], original, initialMode='dates', onChange, groupDates, individualDates=[], disabled=false, removableDates=[], initialMemo='', initialPeriods, weekly, draftKey=null, draftVersion }: { today:string;initialDates?:string[];original:(date:string)=>OpeningDate;initialMode?:'dates'|'range';onChange:(value:DateEditorValue|null)=>void;groupDates?:Array<{date:string;name?:string}>;individualDates?:string[];disabled?:boolean;removableDates?:string[];initialMemo?:string;initialPeriods?:OpeningPeriod[];weekly?:OpeningWeek;draftKey?:string|null;draftVersion?:number }) {
 const [restored]=useState(()=>{
  const value=readGuideDraft<DateDraft>(draftKey)
  return value?.version===draftVersion&&value?value:null
 })
 const [mode,setMode]=useState(restored?.mode??initialMode)
 const [dates,setDates]=useState(restored?.dates??initialDates)
 const [start,setStart]=useState(restored?.start??initialDates[0]??'')
 const [end,setEnd]=useState(restored?.end??initialDates.at(-1)??'')
 const [month,setMonth]=useState(restored?.month??(initialDates[0]??today).slice(0,7))
 const initial=initialDates.length?original(initialDates[0]):null
 const [closed,setClosed]=useState(restored?.closed??(initialPeriods?false:initial?.closed??true))
 const [periods,setPeriods]=useState<OpeningPeriod[]>(restored?.periods??initialPeriods??(initial?.periods.length?initial.periods:[{open:'11:00',close:'22:00'}]))
 const [memo,setMemo]=useState(restored?.memo??initialMemo)
 const [memoOpen,setMemoOpen]=useState(restored?.memoOpen??Boolean(initialMemo))
 const [remove,setRemove]=useState(restored?.remove??false)
 useEffect(()=>{
  if(!draftKey)return
  writeGuideDraft(draftKey,{version:draftVersion,mode,dates,start,end,month,closed,periods,memo,memoOpen,remove} satisfies DateDraft)
 },[draftKey,draftVersion,mode,dates,start,end,month,closed,periods,memo,memoOpen,remove])
 const max=hoursDateAdd(today,366)
 const inRange=(list:string[])=>list.filter(d=>d>=today&&d<=max)
 const selected=mode==='range'?inRange(hoursDateRange(start,end)):inRange(dates)
 const emit=(overrides:Partial<DateEditorValue>={})=>{const v={dates:selected,closed,periods,memo,remove,...overrides};const clamped={...v,dates:inRange(v.dates)};onChange(clamped.dates.length&&(clamped.closed||clamped.remove||!hoursPeriodsProblem(clamped.periods))?clamped:null)}
 const choose=(date:string)=>{
   if(disabled||date<today||date>max)return
   if(mode==='range'){if(!start||(start&&end)){setStart(date);setEnd('');onChange(null)}else{const a=date<start?date:start,b=date<start?start:date;setStart(a);setEnd(b);emit({dates:hoursDateRange(a,b)})}}
   else{const next=dates.includes(date)?dates.filter(d=>d!==date):[...dates,date].sort();setDates(next);emit({dates:next})}
 }
 const shortDate=(date:string)=>`${Number(date.slice(5,7))}/${Number(date.slice(8))}`
 const next=selected.length?hoursDateAdd(selected.at(-1)!,1):''
 const returnsWeekly=next&&weekly&&JSON.stringify(original(next).periods)===JSON.stringify(weekly[hoursWeekday(next)])
 const clear=()=>{if(disabled)return;setDates([]);setStart('');setEnd('');onChange(null)}
 const notice=groupDates?groupDates.filter(d=>!selected.includes(d.date)&&individualDates.includes(d.date)).map(d=>`${Number(d.date.slice(5,7))}月${Number(d.date.slice(8))}日`).join('・'):''
 return <div className={styles.stackLarge}>
  {groupDates?<>
   <strong className={styles.groupEditorTitle}>{hoursLongDateLabel(groupDates[0].date,Boolean(groupDates[0].name))} – {hoursLongDateLabel(groupDates.at(-1)!.date,Boolean(groupDates.at(-1)!.name))}</strong>
   <p className={styles.bodyText}>同じ時間を設定する日を選んでください。</p>
   <div className={styles.stack}>{groupDates.map(d=><Checkbox key={d.date} checked={dates.includes(d.date)} disabled={disabled} onCheckedChange={()=>choose(d.date)} description={individualDates.includes(d.date)?'休業 · 個別に変更済み':d.name??'通常の営業時間'}><strong className={styles.groupDayLabel}>{dateLabel(d.date,today,Boolean(d.name))}</strong></Checkbox>)}</div>
  </>:<>
   <SegmentedControl size="hours" aria-label="日付の選び方" disabled={disabled} options={[{value:'dates',label:'日付を選ぶ'},{value:'range',label:'期間で選ぶ'}]} value={mode} onChange={v=>{setMode(v);emit({dates:v==='range'?hoursDateRange(start,end):dates})}}/>
   {mode==='range'?<div className={styles.twoFields}><Field optional={false} label="開始日"><DateField size="hours" value={start} min={today} max={max} disabled={disabled} onChange={v=>{setStart(v);setMonth(v.slice(0,7)||month);emit({dates:hoursDateRange(v,end)})}}/></Field><Field optional={false} label="終了日"><DateField size="hours" value={end} min={start||today} max={max} disabled={disabled} onChange={v=>{setEnd(v);emit({dates:hoursDateRange(start,v)})}}/></Field></div>:null}
   <HoursDateCalendar month={month} onMonth={setMonth} selected={selected} onSelect={choose} min={today} max={max} disabled={disabled}/>
  </>}
  {selected.length?<>
   {!groupDates&&mode==='dates'?<><div className={styles.splitRow}><strong className={styles.selectionTitle}>選択中 {selected.length}日</strong><Button presentation="hours" variant="text" size="compact" disabled={disabled} onClick={clear}>すべて解除</Button></div><div className={styles.dateChips}>{selected.map(date=><span key={date} className={styles.dateChip}>{dateLabel(date,today)}<CloseButton disabled={disabled} onClick={()=>choose(date)} aria-label={`${date}の選択を解除`}/></span>)}</div></>:!groupDates?<p className={styles.selectedRange}>{shortDate(selected[0])} – {shortDate(selected.at(-1)!)} · 選択中{selected.length}日</p>:null}
   {!groupDates?<RadioGroup label="選んだ日の営業" className={styles.radioColumn}><Radio size="body" rowHeight="comfortable" checked={closed&&!remove} disabled={disabled} name="date-hours-state" onChange={()=>{setClosed(true);setRemove(false);emit({closed:true,remove:false})}}>休業する</Radio><Radio size="body" rowHeight="comfortable" checked={!closed&&!remove} disabled={disabled} name="date-hours-state" onChange={()=>{setClosed(false);setRemove(false);emit({closed:false,remove:false})}}>営業時間を変える</Radio></RadioGroup>:null}
   {!closed&&!remove?<><h3>選んだ{selected.length}日間の営業時間</h3><PeriodFields value={periods} disabled={disabled} onChange={p=>{setPeriods(p);emit({periods:p})}}/></>:null}
   {selected.every(d=>removableDates.includes(d))?<Button presentation="hours" variant="text" size="compact" disabled={disabled} onClick={()=>{setRemove(!remove);emit({remove:!remove})}}>{remove?'通常に戻すのをやめる':'通常の営業時間に戻す'}</Button>:null}
   {!groupDates?memoOpen?<><Field label="メモ" optionalAppearance="parentheses"><TextField textSize="body" value={memo} maxLength={200} disabled={disabled} placeholder="例：年末年始の休業" onChange={e=>{setMemo(e.target.value);emit({memo:e.target.value})}}/></Field><p className={styles.muted}>メモはGoogleには掲載されません。</p></>:<div><Button presentation="hours" variant="text" size="compact" disabled={disabled} onClick={()=>setMemoOpen(true)}>メモを追加</Button></div>:null}
   {groupDates?notice?<p className={styles.muted}>{notice}は選択していないため、個別に設定した「休業」を維持します。</p>:null:<Notice tone="info" appearance="subtle">{mode==='range'&&closed?`この${selected.length}日間は休業します。${Number(next.slice(5,7))}月${Number(next.slice(8))}日から${returnsWeekly?'毎週の営業時間':'元の営業予定'}に戻ります。`:mode==='dates'?`${selected.map(shortDate).join('・')}だけを変更します。間の日の営業時間は変わりません。`:`この${selected.length}日間だけ変更します。ほかの日の営業時間は変わりません。`}</Notice>}
  </>:<p className={styles.muted}>変更する日付を選んでください。離れた日付も複数選べます。</p>}
 </div>
}
