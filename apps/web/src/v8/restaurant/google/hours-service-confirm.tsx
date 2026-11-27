'use client'
import { ArrowRight } from 'lucide-react'
import { HOURS_WEEKDAYS, type HoursWorkspace } from '@line-crm/shared'
import Card from '@/components/shared/card'
import type { GoogleChange, GoogleProfileData } from '@/lib/restaurant-google-api'
import { hoursText } from './hours-model'
import { WEEKDAY_JA } from './format'
import styles from './hours.module.css'

export function HoursServiceConfirm({changes,workspace,data}:{changes:GoogleChange[];workspace:HoursWorkspace;data:GoogleProfileData}) {
 const change=changes.find(c=>'field' in c.target&&c.target.field==='moreHours')
 if(!change)return null
 const before=Array.isArray(change.before)?change.before as NonNullable<GoogleProfileData['profile']['moreHours']>:[]
 const after=Array.isArray(change.after)?change.after as typeof before:[]
 const ids=[...new Set([...before,...after].map(h=>h.hoursTypeId))].filter(id=>JSON.stringify(before.find(h=>h.hoursTypeId===id))!==JSON.stringify(after.find(h=>h.hoursTypeId===id)))
 return <>{ids.map(id=>{
  const a=after.find(h=>h.hoursTypeId===id),b=before.find(h=>h.hoursTypeId===id),service=workspace.services.find(s=>s.googleTypeId===id)
  const days=a?HOURS_WEEKDAYS.filter(d=>Array.isArray(a.weekly?.[d])&&a.weekly[d].length>0):[]
  const dayText=days.length===0?'未設定':days.length===7?'毎日':days.length===6?`${WEEKDAY_JA[HOURS_WEEKDAYS.find(d=>!days.includes(d))!]}曜日以外`:days.map(d=>`${WEEKDAY_JA[d]}曜日`).join('・')
  const text=(hours:typeof a)=>{
   if(!hours)return '未設定'
   const parts=[...new Set(HOURS_WEEKDAYS.filter(d=>Array.isArray(hours.weekly?.[d])&&hours.weekly[d].length>0).map(d=>hoursText(hours.weekly[d])))]
   return parts.length?parts.join(' / '):'未設定'
  }
  return <Card key={id} contentPadding="var(--space-20)" layout="vertical" gap="var(--space-20)">
   <div className={styles.splitRow}><h3 className={styles.confirmTitle}>{service?.label??data.profile.moreHoursTypes?.find(t=>t.id===id)?.label??id}の営業時間</h3><span className={styles.serviceGoogle}>Googleに反映する</span></div>
   {a?<p className={styles.bodyText}>提供する曜日：{dayText}</p>:null}
   <div className={styles.serviceComparison}><div className={styles.stack}><span className={styles.muted}>変更前</span><strong className={styles.serviceTime}>{text(b)}</strong></div><ArrowRight size={18}/><div className={styles.stack}><span className={styles.muted}>変更後</span><strong className={`${styles.serviceTime} ${styles.green}`}>{a?text(a):'削除する'}</strong></div></div>
   <p className={styles.bodyText}>店舗の営業時間の範囲内で設定されています。</p>
  </Card>
 })}</>
}
