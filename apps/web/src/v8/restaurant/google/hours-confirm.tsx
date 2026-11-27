'use client'
import { useMemo } from 'react'
import { ArrowRight } from 'lucide-react'
import { HOURS_WEEKDAYS, type HoursWorkspace } from '@line-crm/shared'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import { GridTable, GridHeadRow, GridRow, GridCell } from '@/components/shared/grid-table'
import { PageHeading } from '@/components/templates/page-frame'
import Notice from '@/components/shared/notice'
import type { GoogleChange, GoogleDayHours, GoogleProfileData, GoogleWeeklyHours } from '@/lib/restaurant-google-api'
import { hoursText,dateLabel } from './hours-model'
import { WEEKDAY_JA } from './format'
import { HoursServiceConfirm } from './hours-service-confirm'
import styles from './hours.module.css'

export function HoursConfirm({ data, workspace, changes, onBack, onSend, busy, disabled, lockedReason, error }: { data:GoogleProfileData;workspace:HoursWorkspace;changes:GoogleChange[];onBack:()=>void;onSend:()=>void;busy:boolean;disabled:boolean;lockedReason?:string;error:string }) {
 const rows=useMemo(()=>changes.flatMap(change=>{
  if(change.kind==='special_hours'){const after=Array.isArray(change.after)?(change.after as GoogleDayHours[]):[];const before=Array.isArray(change.before)?(change.before as GoogleDayHours[]):[];return after.map(day=>({key:`${change.id}-${day.date}`,label:dateLabel(day.date,data.today.date),before:hoursText(before.find(d=>d.date===day.date)?.periods??[]),after:day.remove?`通常 ${hoursText(day.periods)}`:day.closed?'休業':hoursText(day.periods)}))}
  if(change.kind==='regular_hours')return HOURS_WEEKDAYS.filter(d=>'weekdays' in change.target&&change.target.weekdays.includes(d)).map(d=>({key:`${change.id}-${d}`,label:`毎週 ${WEEKDAY_JA[d]}曜日`,before:hoursText((change.before as GoogleWeeklyHours)[d]??[],'定休日'),after:hoursText((change.after as GoogleWeeklyHours)[d]??[],'定休日')}))
  return []
 }),[changes,data])
 const dates=[...new Set(changes.filter(c=>c.kind==='special_hours').flatMap(c=>Array.isArray(c.after)?(c.after as GoogleDayHours[]).map(d=>d.date):[]))].sort()
 const dateCaption=dates.length&&dates.every(d=>d.slice(0,7)===dates[0].slice(0,7))?`${dates[0].slice(0,4)}年${Number(dates[0].slice(5,7))}月${dates.map(d=>Number(d.slice(8))).join('日・')}日`:dates.map(d=>`${Number(d.slice(5,7))}月${Number(d.slice(8))}日`).join('・')
 const local=workspace.services.filter(s=>workspace.draft.serviceIds.includes(s.id))
 const canGoogle=changes.length>0
 const reservationImpactTotal=changes.reduce((n,c)=>n+(typeof c.reservationImpactCount==='number'&&Number.isFinite(c.reservationImpactCount)&&c.reservationImpactCount>0?c.reservationImpactCount:0),0)
 const sendDisabled=disabled||(canGoogle&&!data.writeEnabled)
 return <div className={styles.content} data-design-node="Nt7Z6">
  <div className={styles.stack}><PageHeading title="変更内容を確認" titleSize="workspace" inset="none" separator="none"/><p className={styles.storeCaption}>{data.profile.title??data.store.name}</p></div>
  {rows.length?<Card contentPadding="var(--space-20)" layout="vertical" gap="var(--space-20)"><h3 className={styles.confirmTitle}>{changes.every(c=>c.kind==='special_hours')?`選択した${rows.length}日の営業時間`:'今回変更する営業時間'}</h3>{dates.length?<p className={styles.confirmCaption}>{dateCaption}</p>:null}<GridTable label="営業時間の変更前と変更後" framed={false} presentation="comparison" design={{columns:'var(--hours-confirm-columns)',gap:'var(--space-16)',rowPadding:'0 var(--space-12)',rowGap:'var(--space-20)',fontSize:'var(--polish-text-body)',rowHeight:'var(--hours-confirm-row-height)',headHeight:'var(--hours-confirm-head-height)',headFontWeight:'600',headFontSize:'var(--text-micro)',headBackground:'var(--color-notice-subtle-background)'}}><GridHeadRow><GridCell role="columnheader">日付</GridCell><GridCell role="columnheader">変更前（Google）</GridCell><GridCell role="columnheader" aria-hidden="true"/><GridCell role="columnheader">変更後</GridCell></GridHeadRow>{rows.map(r=><GridRow key={r.key}><GridCell><strong className={styles.confirmDate}>{r.label}</strong></GridCell><GridCell>{r.before}</GridCell><GridCell><ArrowRight size={15} aria-hidden="true"/></GridCell><GridCell><strong className={styles.confirmAfter}>{r.after}</strong></GridCell></GridRow>)}</GridTable></Card>:null}
  <HoursServiceConfirm changes={changes} workspace={workspace} data={data}/>
  {local.length?<Card contentPadding="var(--space-20)" layout="vertical" gap="var(--space-20)"><h3>musubo内で使う設定</h3>{local.map(s=><div className={`${styles.localService} ${styles.bodyText}`} key={s.id}>{local.length>1?<strong>{s.label}</strong>:null}{!s.googleTypeId?<p>{hoursText(s.periods)} · このサービスはmusubo内で使用します。</p>:null}{s.orderDeadline?<div className={styles.splitRow}><span>注文の受付終了</span><strong className={styles.localValue}>{s.orderDeadline}</strong></div>:null}{s.menu?<div className={styles.splitRow}><span>提供するメニュー</span><strong className={styles.localValue}>{s.menu}</strong></div>:null}</div>)}<p className={styles.muted}>この2項目はGoogleに送信されません。</p></Card>:null}
  {dates.length?<Notice tone="info" appearance="subtle" >選んだ日付以外の営業時間は変更しません。</Notice>:null}
  {changes.some(c=>'field' in c.target&&c.target.field==='moreHours')?<Notice tone="info" appearance="subtle">Googleに掲載できるサービスの種類は、店舗の業種によって異なります。</Notice>:null}
  {reservationImpactTotal>0?<Notice tone="warn">営業時間の変更により、予約済みの時間と合わなくなる予約が{reservationImpactTotal}件あります。予約内容を確認してください。</Notice>:null}
  {error?<Notice tone="danger">{error}</Notice>:null}
  {canGoogle&&!data.writeEnabled?<p className={styles.muted}>この検証環境ではGoogleへの送信が停止されています。入力した変更案は保存されています。</p>:null}
  {canGoogle&&data.writeEnabled&&changes.every(c=>c.kind==='special_hours')?<p className={styles.bodyText}>この{dates.length}日をGoogleの特別営業時間として反映します。</p>:null}
  <div className={styles.confirmFooter}><div className={styles.actions}><Button presentation="hours" size="field" onClick={()=>{if(!busy)onBack()}} disabled={busy}>編集に戻る</Button><Button data-guide-anchor="hours.confirm" data-guide-hours-apply presentation="hours" size="field" variant="primary" lockedReason={lockedReason} disabled={sendDisabled} busy={busy} widthReserve="idle" onClick={()=>{if(!busy&&!sendDisabled)onSend()}}>{canGoogle?'Googleに反映する':'設定を保存する'}</Button></div></div>
 </div>
}
