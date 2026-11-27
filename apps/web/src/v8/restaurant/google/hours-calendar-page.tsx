'use client'
import { useEffect } from 'react'
import { ArrowLeft } from 'lucide-react'
import { hoursDateAdd, hoursDateRange, type HoursWorkspace, type OpeningDate } from '@line-crm/shared'
import { PageHeading } from '@/components/templates/page-frame'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import HoursDateCalendar from '@/components/shared/hours-date-calendar'
import type { GoogleProfileData } from '@/lib/restaurant-google-api'
import { hoursLongDateLabel, hoursText, workspaceDay } from './hours-model'
import styles from './hours.module.css'

export function HoursCalendarPage({data,workspace,holidays,month,onMonth,selected,onSelect,onBack,onEdit,onRemove,onReview,disabled,changed}:{data:GoogleProfileData;workspace:HoursWorkspace;holidays:Array<{date:string;name:string}>;month:string;onMonth:(m:string)=>void;selected:string;onSelect:(d:string)=>void;onBack:()=>void;onEdit:(dates:string[])=>void;onRemove:(dates:string[])=>void;onReview:()=>void;disabled:boolean;changed:boolean}) {
 useEffect(()=>{window.scrollTo({top:0,left:0,behavior:'instant'})},[])
 const today=data.today.date
 const day=(d:string)=>workspaceDay(d,data,workspace,holidays)
 const current=day(selected),memo=workspace.notes[selected]??''
 const special=[...new Map<string,OpeningDate>([...data.profile.specialHours,...workspace.draft.days].map(d=>[d.date,d])).values()].filter(d=>!d.remove)
 const isChanged=(d:string)=>special.some(s=>s.date===d)
 const same=(d:string)=>isChanged(d)&&JSON.stringify(day(d).periods)===JSON.stringify(current.periods)&&(workspace.notes[d]??'')===memo
 let first=selected,last=selected
 for(let i=0;i<366&&same(hoursDateAdd(first,-1));i++)first=hoursDateAdd(first,-1)
 for(let i=0;i<366&&same(hoursDateAdd(last,1));i++)last=hoursDateAdd(last,1)
 const dates=hoursDateRange(first,last),next=hoursDateAdd(last,1)
 const handleEdit=()=>{if(disabled)return;onEdit(dates)}
 const handleRemove=()=>{if(disabled||!isChanged(selected))return;onRemove(dates)}
 const handleReview=()=>{if(disabled||!changed)return;onReview()}
 return <div className={styles.content}>
  <PageHeading title="営業予定" titleSize="workspace" inset="none" separator="none" actions={<Button presentation="hours" size="field" icon={<ArrowLeft size={16}/>} onClick={onBack}>営業時間に戻る</Button>}/>
  <div className={styles.calendarColumns}>
   <Card contentPadding="var(--space-20)" layout="vertical" gap="normal"><HoursDateCalendar month={month} onMonth={onMonth} min={today} max={hoursDateAdd(today,366)} selected={[...new Set([...special.map(d=>d.date),selected])]} describe={date=>day(date).closed?'休業':isChanged(date)?hoursText(day(date).periods):'通常営業'} onSelect={onSelect}/><div className={styles.splitRow}><span className={styles.muted}>緑：日付を指定した変更</span><span className={styles.muted}>日付を押すと確認・変更できます。</span></div></Card>
   <Card contentPadding="var(--space-20)" layout="vertical" gap="normal"><strong className={styles.calendarDate}>{hoursLongDateLabel(first)}{first!==last?` – ${hoursLongDateLabel(last)}`:''}</strong><strong className={styles.calendarSummary}>{dates.length>1?`${dates.length}日間 `:''}{current.closed?'休業':hoursText(current.periods)}</strong>{memo?<p className={styles.bodyText}>{memo}</p>:null}<Button presentation="hours" size="field" disabled={disabled} onClick={handleEdit}>{dates.length>1?'この期間を編集':'この日を編集'}</Button>{dates.length>1?<><strong className={styles.bodyText}>{hoursLongDateLabel(next)}から</strong><p className={styles.bodyText}>{day(next).closed?'休業':hoursText(day(next).periods)}</p></>:null}{isChanged(selected)?<Button presentation="hours" variant="text" size="compact" disabled={disabled} onClick={handleRemove}>{dates.length>1?'この期間の変更を取り消す':'この日の変更を取り消す'}</Button>:null}</Card>
  </div>
  {changed?<div className={styles.updateBar}><strong className={styles.updateTitle}>Googleの営業時間を更新</strong><div/><Button presentation="hours" variant="primary" size="field" disabled={disabled} onClick={handleReview}>変更内容を確認</Button></div>:null}
 </div>
}
