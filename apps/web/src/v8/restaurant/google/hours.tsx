'use client'
import '@/components/shared/google-hours-tokens.css'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CalendarDays, ChevronDown, ChevronRight, History, Info, Pencil, Plus, Utensils } from 'lucide-react'
import { HOURS_WEEKDAYS, upcomingHolidayGroups, hoursDateAdd, hoursDateRange } from '@line-crm/shared'
import { PageFrame, PageHeading } from '@/components/templates/page-frame'
import HoursWorkspaceFrame from '@/components/templates/hours-workspace-frame'
import { RestaurantPage } from '@/v8/restaurant/common-a/public/frame/index'
import Button from '@/components/shared/button'
import IconButton from '@/components/shared/icon-button'
import Card from '@/components/shared/card'
import Drawer from '@/components/shared/drawer'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { HoursCalendarPage } from './hours-calendar-page'
import { restaurantGoogleApi, type GoogleDayHours } from '@/lib/restaurant-google-api'
import { restaurantTestApi } from '@/lib/restaurant-test-api'
import { useSharedGuide } from '@/v8/onboarding/public/guide-shared/index'
import { guideDraftKey, readGuideDraft, writeGuideDraft } from '@/lib/scoped-guide-draft'
import { emitGuideSignal } from '@/v8/onboarding/public/guide-overlay/index'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useGooglePermission } from './use-google-permission'
import { useHoursWorkspace } from './use-hours-workspace'
import { HoursEditPanel, type HoursPanel } from './hours-edit-panel'
import { HoursConfirm } from './hours-confirm'
import { dateLabel, hasHoursDraft, hoursText, workspaceDay, hoursHistoryStamp } from './hours-model'
import { WEEKDAY_JA, errorMessage } from './format'
import styles from './hours.module.css'

const NO_BOOKABLE_HOURS = '予約枠を作れる営業日がありません。Googleの営業時間を確認してください。'

type HoursPosition = {
 panel: HoursPanel | null; calendar: boolean; month: string; date: string; review: boolean; version: number;
 initialMode?: string | null; initialDate?: string | null;
}

export default function HoursPage({ accountId, tabs, initialMode, initialDate, shared = false }: {accountId:string;tabs:ReactNode;initialMode?:string|null;initialDate?:string|null;shared?:boolean}) {
 const {allowed,lockedReason,known}=useGooglePermission('manager', true, shared ? '/settings/sns' : '/restaurant-test/google')
 const m=useHoursWorkspace(accountId,!shared&&allowed)
 const { guide } = useSharedGuide() ?? {}
 const confirmingImportedHours = !shared && guide?.phase === 'active' && guide.stepKey === 'hours' && guide.procedureIndex === 2
 const [panel,setPanel]=useState<HoursPanel|null>(()=>initialMode?initialMode==='weekly'?{kind:'weekly'}:initialMode==='text'?{kind:'text'}:{kind:'dates',dates:initialDate?[initialDate]:[]}:null)
 const [expanded,setExpanded]=useState(false),[history,setHistory]=useState(false),[calendar,setCalendar]=useState(false),[month,setMonth]=useState(''),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[actionError,setActionError]=useState(''),[sent,setSent]=useState<'google'|'local'|null>(null)
 const [calendarDate,setCalendarDate]=useState('')
 const positionKey=!shared&&allowed&&m.data?guideDraftKey(`hours-position:${m.data.profile.name}`,accountId,m.data.store.id):null
 const editorKey=!shared&&allowed&&m.data?guideDraftKey(`hours-editor:${m.data.profile.name}`,accountId,m.data.store.id):null
 const [loadedPosition,setLoadedPosition]=useState<string|null>(null)
 const [checkingReview,setCheckingReview]=useState(false)
 const [sendFailed,setSendFailed]=useState(false)
 const failureRef=useRef<HTMLDivElement>(null)
 useEffect(()=>{if(!sendFailed)return;const frame=requestAnimationFrame(()=>failureRef.current?.scrollIntoView?.({block:'nearest'}));return()=>cancelAnimationFrame(frame)},[sendFailed])
 const [editorUnsaved,setEditorUnsaved]=useState(false)
 const operation=useRef(false)
 const mounted = useRef(false)
 useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
 useEffect(()=>{
  if(!positionKey||!m.config||m.loading||loadedPosition===positionKey)return
  const saved=readGuideDraft<HoursPosition>(positionKey)
  setLoadedPosition(positionKey)
  if(!saved||initialMode&&(saved.initialMode!==initialMode||saved.initialDate!==initialDate))return
  setPanel(saved.panel??null)
  setCalendar(saved.calendar===true)
  setMonth(/^\d{4}-\d{2}$/.test(saved.month)?saved.month:'')
  setCalendarDate(/^\d{4}-\d{2}-\d{2}$/.test(saved.date)?saved.date:'')
  if(saved.review&&saved.version===m.config.version&&m.saved){
   setCheckingReview(true)
   void m.restoreReview().then(restored=>{if(mounted.current)setConfirm(restored)},()=>{
    if(mounted.current)setActionError('変更内容を確認できませんでした。入力内容は残っています。')
   }).finally(()=>{if(mounted.current)setCheckingReview(false)})
  }
 },[positionKey,loadedPosition,m.config,m.loading,m.saved,m.restoreReview,initialMode,initialDate])
 useEffect(()=>{
  if(!positionKey||loadedPosition!==positionKey||m.loading||checkingReview||!m.config)return
  writeGuideDraft(positionKey,{panel,calendar,month,date:calendarDate,review:confirm,version:m.config.version,initialMode,initialDate} satisfies HoursPosition)
 },[positionKey,loadedPosition,m.loading,m.config,checkingReview,panel,calendar,month,calendarDate,confirm,initialMode,initialDate])
 const clearEditor=()=>{writeGuideDraft(editorKey,null);writeGuideDraft(editorKey?`${editorKey}:dates`:null,null)}
 const {leaveTarget,confirmLeave,cancelLeave}=useUnsavedGuard({dirty:Boolean(m.config)&&(!m.saved||editorUnsaved),busy:busy||m.saving})
 const review=async()=>{if(!allowed||operation.current)return;operation.current=true;setBusy(true);setActionError('');setSendFailed(false);try{await m.review();clearEditor();setPanel(null);setConfirm(true);setSent(null)}catch(e){setActionError(errorMessage(e,'変更内容を確認できませんでした。入力内容は残っています。'))}finally{setBusy(false);operation.current=false}}
 const send=async()=>{if(!allowed||operation.current||!m.data)return;operation.current=true;setBusy(true);setActionError('');try{for(const change of m.changes){if(['applied','accepted'].includes(change.status))continue;await restaurantGoogleApi.sendChange(accountId,change.id)}const google=m.changes.length>0;await m.complete(google);setConfirm(false);setSent(google?'google':'local');/* 開店準備ガイド⑤の手順2/2（枠14 kYvXk）は確定できた時に進む。 */emitGuideSignal('hours.confirm')}catch(e){setSendFailed(true);setConfirm(false);setCalendar(false);setActionError(errorMessage(e,'Googleに送信できませんでした。入力した内容は残っています。'));const refreshed=await Promise.all(m.changes.map(c=>restaurantGoogleApi.change(accountId,c.id).catch(()=>null)));m.setChanges(m.changes.map((c,i)=>refreshed[i]?.change??c))}finally{setBusy(false);operation.current=false}}
 const close=()=>{void m.flush().then(()=>{clearEditor();setPanel(null)}).catch(()=>undefined)}
 const open=(value:HoursPanel)=>{clearEditor();setSent(null);setSendFailed(false);setActionError('');setPanel(value)}
 if(m.loading||checkingReview||positionKey&&loadedPosition!==positionKey&&!m.error)return <PageFrame kind="list"><ListState kind="loading" title="営業時間を読み込んでいます"/></PageFrame>
 if(m.error||!m.data||!m.config)return <PageFrame kind="list"><ListState kind="error" title="営業時間を表示できませんでした" description={m.error} onRetry={()=>void m.load()}/></PageFrame>
 const {data,config,workspace}=m,today=data.today.date,weekly=workspace.draft.weekly??data.profile.regularHours
 const groups=upcomingHolidayGroups(config.holidays,today)
 const day=(date:string)=>workspaceDay(date,data,workspace,config.holidays)
 const current=day(today),disabled=!allowed||data.closed||busy
 const special=[...new Map<string,GoogleDayHours>([...data.profile.specialHours,...workspace.draft.days].map(d=>[d.date,d])).values()].filter(d=>d.date>=today&&!d.remove).sort((a,b)=>a.date.localeCompare(b.date))
 const ranges:Array<{start:string;end:string;closed:boolean;periods:typeof current.periods;memo:string}>=[]
 for(const d of special){const last=ranges.at(-1),memo=workspace.notes[d.date]??'';if(last&&hoursDateAdd(last.end,1)===d.date&&last.closed===d.closed&&JSON.stringify(last.periods)===JSON.stringify(d.periods)&&last.memo===memo)last.end=d.date;else ranges.push({start:d.date,end:d.date,closed:d.closed,periods:d.periods,memo})}
 const changed=hasHoursDraft(workspace)
 const hasImportedHours = HOURS_WEEKDAYS.some(weekday => data.profile.regularHours[weekday].length > 0)
 const showImportedHours = confirmingImportedHours && !changed && !panel && !confirm && !calendar && !sent && !initialMode
 const importedWeek = HOURS_WEEKDAYS.reduce<Array<{ days: string[]; hours: string }>>((groups, weekday) => {
  const hours = hoursText(data.profile.regularHours[weekday], '定休日')
  const previous = groups.at(-1)
  if (previous?.hours === hours) previous.days.push(WEEKDAY_JA[weekday])
  else groups.push({ days: [WEEKDAY_JA[weekday]], hours })
  return groups
 }, [])
 const confirmImported = async () => {
  if (disabled || data.stale || !hasImportedHours || operation.current) return
  operation.current = true
  setBusy(true)
  setActionError('')
  try {
   const { data: hours } = await restaurantTestApi.openingHours(accountId, data.store.id)
   if (hours.storeId !== data.store.id || !hours.version || !hours.hours?.some(day => day.periods.length)) {
    setActionError('予約の営業時間を読み込めませんでした。Googleから再読み込みしてください。')
    return
   }
   const nextOpen = hoursDateRange(hoursDateAdd(today, 1), hoursDateAdd(today, 14)).find(date => {
    const special = data.profile.specialHours.find(day => day.date === date)
    if (special) return !special.closed && special.periods.length > 0
    return (hours.hours?.find(day => day.weekday === new Date(`${date}T12:00:00Z`).getUTCDay())?.periods.length ?? 0) > 0
   })
   if (!nextOpen) { setActionError(NO_BOOKABLE_HOURS); return }
   if (mounted.current) emitGuideSignal('hours.confirm', accountId)
  } catch (cause) {
   setActionError(errorMessage(cause, '営業時間を確認できませんでした。もう一度お試しください。'))
  } finally {
   operation.current = false
   setBusy(false)
  }
 }
 if (showImportedHours) return (
  <RestaurantPage boardId="tYbl8" title="Googleビジネス" subtitle={data.store.name}
   description="Googleの営業時間を確認して、予約枠を用意します。" bodyGap={12} bodyPadTop={8}>
    {tabs}
    {data.stale ? <Notice tone="warn">Googleから最新の営業時間を読み込めませんでした。接続を確認して再読み込みしてください。</Notice>
      : hasImportedHours ? <Notice tone="success">Googleビジネスと接続しました。営業時間を取り込みました。</Notice>
      : <Notice tone="warn">Googleビジネスに通常の営業時間がありません。Googleビジネスで設定してから再読み込みしてください。</Notice>}
    {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
    <div className={styles.importedHours}>
     <Card contentPadding="var(--space-20)" layout="vertical" gap="tight">
      <h2>取り込んだ営業時間</h2>
      <div className={styles.importedWeek}>{importedWeek.map(({ days, hours }) => (
       <div className={styles.importedDay} key={days[0]}>
        <span>{days.length > 2 ? `${days[0]}〜${days.at(-1)}曜` : `${days.join('・')}曜`}</span>
        <span>{hours}</span>
       </div>
      ))}</div>
      <p className={styles.muted}>Googleビジネスの通常営業時間を表示しています。</p>
      <Notice tone="warn">取り込んだ営業時間が違うときは、Googleビジネスで修正してから「Googleから再読み込み」を押してください。</Notice>
      <div data-guide-slot="hours.confirm" data-guide-narrow style={{ display: 'contents' }} />
      <div className={styles.actions}>
       <Button data-guide-anchor="hours.confirm" presentation="hours" variant="primary" size="field"
         disabled={disabled || data.stale || !hasImportedHours} lockedReason={lockedReason}
         onClick={() => void confirmImported()} busy={busy}>この営業時間で確定</Button>
       <Button presentation="hours" size="field" disabled={disabled} lockedReason={lockedReason}
         onClick={() => void m.load(true)}>Googleから再読み込み</Button>
      </div>
     </Card>
    </div>
  </RestaurantPage>
 )

 return <><HoursWorkspaceFrame context={<span>{data.profile.title??data.store.name} · {data.timeZone==='Asia/Tokyo'?'日本時間':data.timeZone}</span>}><div className={styles.tabs}>{tabs}</div>
  {confirm?<HoursConfirm data={data} workspace={workspace} changes={m.changes} onBack={()=>setConfirm(false)} onSend={()=>void send()} busy={busy} disabled={disabled} lockedReason={lockedReason} error={actionError}/>:calendar?<HoursCalendarPage data={data} workspace={workspace} holidays={config.holidays} month={month||today.slice(0,7)} onMonth={setMonth} selected={calendarDate||today} onSelect={setCalendarDate} onBack={()=>setCalendar(false)} onEdit={dates=>open({kind:'dates',dates,mode:dates.length>1?'range':'dates'})} onRemove={dates=>{const pending=workspace.draft.days.filter(d=>!dates.includes(d.date));for(const date of dates)if(data.profile.specialHours.some(d=>d.date===date))pending.push({date,closed:!weekly[HOURS_WEEKDAYS[(new Date(`${date}T12:00:00Z`).getUTCDay()+6)%7]].length,periods:weekly[HOURS_WEEKDAYS[(new Date(`${date}T12:00:00Z`).getUTCDay()+6)%7]],remove:true});m.update({...workspace,draft:{...workspace.draft,days:pending,reviewIds:[]}})}} onReview={()=>void review()} disabled={disabled} changed={changed}/>:<div className={styles.content}>
   <PageHeading title="営業時間" titleSize="workspace" inset="none" separator="none" actions={<Button presentation="hours" variant="text" size="compact" icon={<History size={15}/>} onClick={()=>setHistory(true)}>変更履歴</Button>}/>
   {known&&!allowed?<ReadOnlyNotice need="manager"/>:null}
   {data.closed?<Notice tone="warn">Google側で臨時休業または閉業になっているため、営業時間を変更できません。</Notice>:null}
   {m.saveError?<Notice tone="danger">{m.saveError}</Notice>:null}
   {actionError&&!sendFailed?<Notice tone="danger" action={<Button presentation="hours" size="field" onClick={()=>void review()} disabled={disabled}>もう一度確認する</Button>}>{actionError}</Notice>:null}
   <Card contentPadding="var(--space-16) var(--space-20)" layout="horizontal" gap="normal"><div className={styles.today}><span className={styles.muted}>本日 {Number(today.slice(5,7))}月{Number(today.slice(8))}日（{WEEKDAY_JA[data.today.weekday]}{data.today.holidayName?'・祝':''}）</span><div className={styles.todayLine}><strong className={styles.todayTitle}>{current.closed?'本日は休業':hoursText(current.periods)}</strong><span className={styles.todayContext}>{data.today.holidayName??(!current.periods.length?`${WEEKDAY_JA[data.today.weekday]}曜日の定休日`:'')}</span></div></div><Button presentation="hours" size="field" icon={<Pencil size={14}/>} disabled={disabled} lockedReason={lockedReason} onClick={()=>open({kind:'dates',dates:[today]})}>今日の時間を変更</Button></Card>
   <div className={styles.columns}>
    <Card contentPadding="var(--space-20)" layout="vertical" gap="normal"><div className={styles.splitRow}><h2 title="毎週の営業時間">毎週の営業時間</h2><div className={styles.actions}><Button presentation="hours" variant="text" size="compact" disabled={disabled} lockedReason={lockedReason} onClick={()=>open({kind:'text'})}>文章で入力</Button><Button presentation="hours" variant="text" size="compact" disabled={disabled} lockedReason={lockedReason} onClick={()=>open({kind:'weekly'})}>まとめて編集</Button></div></div>
     <div className={styles.weekList}>{HOURS_WEEKDAYS.map(w=><div className={styles.weekRow} key={w}><span>{WEEKDAY_JA[w]}曜日</span><span className={!weekly[w].length?styles.closed:undefined}>{hoursText(weekly[w],'定休日')}</span><IconButton variant="plain" size="row" aria-label={`${WEEKDAY_JA[w]}曜日を編集`} disabled={disabled} lockedReason={lockedReason} onClick={()=>open({kind:'weekly',weekday:w})}><Pencil size={14}/></IconButton></div>)}</div>
     <div className={styles.holidayLine}><CalendarDays size={18} aria-hidden="true"/><div><strong>祝日 {workspace.holiday.mode==='weekly'?'曜日どおりに営業':workspace.holiday.mode==='closed'?'休業':hoursText(workspace.holiday.periods)}</strong>{workspace.holiday.mode!=='weekly'?<p className={styles.muted}>{workspace.holiday.mode==='closed'?'祝日は休業':workspace.holiday.overrideClosedWeekday?'定休日でも祝日は営業':'定休日は休業'}</p>:null}</div><Button presentation="hours" variant="text" size="compact" lockedReason={lockedReason} disabled={disabled} onClick={()=>open({kind:'holiday'})}>変更</Button></div>
    </Card>
    <div className={styles.stack}><Card contentPadding="var(--space-20)" layout="vertical" gap="normal"><div className={styles.splitRow}><h2 title="祝日・特定の日の営業時間">祝日・特定の日の営業時間</h2><Button presentation="hours" variant="text" size="compact" disabled={disabled} lockedReason={lockedReason} onClick={()=>open({kind:'dates'})}>日付を指定</Button></div>
     {groups.map(group=>group.holidays.length>1?<div className={styles.holidayGroup} key={group.start}><strong className={styles.groupCaption}>{dateLabel(group.start,today)} – {dateLabel(group.end,today,true)} · {group.dates.length}日間</strong>{group.dates.map(date=><div className={styles.specialRow} key={date}><div><strong className={styles.groupDate}>{dateLabel(date,today,config.holidays.some(h=>h.date===date))}</strong><p className={`${styles.groupHours} ${day(date).closed?styles.muted:styles.green}`}>{hoursText(day(date).periods)}</p>{config.holidays.find(h=>h.date===date)?.name?<span className={styles.muted}>{config.holidays.find(h=>h.date===date)?.name}</span>:null}</div><IconButton variant="plain" size="row" aria-label={`${dateLabel(date,today)}の時間を編集`} disabled={disabled} onClick={()=>open({kind:'dates',dates:[date]})}><ChevronRight size={15}/></IconButton></div>)}<Button presentation="hours" variant="text" size="compact" disabled={disabled} onClick={()=>open({kind:'dates',dates:group.dates.filter(date=>!special.some(d=>d.date===date&&d.closed)),group:group.dates.map(date=>({date,name:config.holidays.find(h=>h.date===date)?.name}))})}>連休をまとめて設定</Button></div>:group.holidays.map(h=><div className={styles.specialRow} key={h.date}><div><strong>{dateLabel(h.date,today,true)} {h.name}</strong><div className={styles.specialHours}><strong className={day(h.date).closed?styles.specialClosed:styles.green}>{hoursText(day(h.date).periods)}</strong><span className={styles.muted}>{workspace.notes[h.date]||(group.dates.length>1?`${Number(group.start.slice(5,7))}/${Number(group.start.slice(-2))}–${Number(group.end.slice(-2))}の連休`:'')}</span></div></div><IconButton variant="plain" size="row" aria-label={`${h.name}の営業時間を編集`} disabled={disabled} onClick={()=>open({kind:'dates',dates:[h.date]})}><ChevronRight size={15}/></IconButton></div>))}
     {ranges.length?<div className={styles.stack}><p className={styles.rangeLabel}>日付を指定した変更</p>{ranges.slice(0,4).map(r=><div className={styles.splitRow} key={r.start}><div><strong className={styles.rangeSummary}>{Number(r.start.slice(5,7))}/{Number(r.start.slice(8))}{r.end!==r.start?`–${Number(r.end.slice(5,7))}/${Number(r.end.slice(8))}`:''} {r.memo||hoursText(r.periods)}</strong>{r.closed?<p className={styles.muted}>この期間は、祝日も休業になります。</p>:null}</div><IconButton variant="plain" size="row" aria-label={`${dateLabel(r.start,today)}の変更を編集`} disabled={disabled} onClick={()=>open({kind:'dates',dates:hoursDateRange(r.start,r.end),mode:r.start===r.end?'dates':'range'})}><Pencil size={14}/></IconButton></div>)}</div>:null}
    <p className={styles.muted}>連休の各日を確認・変更できます。</p></Card><Button presentation="hours" variant="text" size="compact" onClick={()=>{setMonth(today.slice(0,7));setCalendarDate(today);setCalendar(true)}}>カレンダーで営業予定を見る</Button></div>
   </div>
   <Card contentPadding="var(--space-20)" layout="vertical" gap="normal"><div className={styles.splitRow}><div className={styles.actions}><Utensils size={18}/><h2 className={styles.serviceTitle}>サービス別の営業時間</h2><span className={styles.muted}>{workspace.services.length}種類</span></div><Button presentation="hours" variant="text" size="compact" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)} icon={<ChevronDown size={15}/>}>{expanded?'閉じる':'開く'}</Button></div>
    {expanded?<div className={styles.stack}>{workspace.services.map(s=><div className={styles.serviceRow} key={s.id}><div><strong>{s.label}</strong><p className={styles.muted}>{s.sameWeekdays?'店舗と同じ営業日':s.weekdays.map(d=>WEEKDAY_JA[d]).join('・')+'曜日'}</p></div><strong className={styles.serviceHours}>{hoursText(s.periods)}</strong><div className={styles.muted}>{s.orderDeadline?`受付終了 ${s.orderDeadline}`:''}{s.menu?<p>{s.menu}</p>:null}</div><Button presentation="hours" size="field" disabled={disabled} lockedReason={lockedReason} onClick={()=>open({kind:'service',service:s})}>編集</Button></div>)}<div><Button presentation="hours" variant="text" size="compact" icon={<Plus size={15}/>} disabled={disabled} lockedReason={lockedReason} onClick={()=>open({kind:'service'})}>営業時間を追加</Button></div></div>:null}
   </Card>
   {sendFailed?<Notice ref={failureRef} tone="danger" statusWord={false} heading={<span className={styles.noticeTitle}>Googleに送信できませんでした</span>} action={<Button presentation="hours" variant="primary" size="field" disabled={disabled} lockedReason={lockedReason} busy={busy} onClick={()=>void review()}>確認して再送する</Button>}>入力内容は保存されています。接続を確認して、もう一度お試しください。</Notice>:sent?<Notice tone="success" statusWord={false} heading={<span className={styles.noticeTitle}>{sent==='google'?'Googleに営業時間の変更を送信しました':'営業時間の設定を保存しました'}</span>}>{sent==='google'?'Googleマップの表示が更新されるまで時間がかかる場合があります。':''}</Notice>:changed?<div className={styles.updateBar}><Info size={18}/><div><strong className={styles.updateTitle}>Googleの営業時間を更新</strong><p className={styles.muted}>変更内容を確認してから、Googleに反映できます。</p></div><Button presentation="hours" variant="primary" size="field" disabled={disabled||!m.saved} lockedReason={lockedReason} busy={busy} widthReserve="idle" onClick={()=>void review()}>変更内容を確認</Button></div>:null}
  </div>}
  </HoursWorkspaceFrame>
  {panel?<HoursEditPanel key={JSON.stringify(panel)} panel={panel} onUnsavedChange={setEditorUnsaved} data={data} workspace={workspace} holidays={config.holidays} serviceTypes={config.serviceTypes??[]} onDraft={m.update} onReview={()=>void review()} onClose={close} onEditDates={dates=>{clearEditor();setPanel({kind:'dates',dates})}} saving={m.saving||busy} saved={m.saved} disabled={disabled} lockedReason={lockedReason} draftKey={editorKey} draftVersion={config.version}/>:null}
  <Drawer open={history} title="営業時間の変更履歴" width="hours" headerIcon={false} heightMode="viewport" onClose={()=>setHistory(false)} footer={<Button presentation="hours" size="field" onClick={()=>setHistory(false)}>閉じる</Button>}><div className={styles.stackLarge}>{config.history.length?config.history.map((event,i)=><div className={styles.historyRow} key={`${event.at}-${i}`}><div className={styles.splitRow}><p className={styles.muted}>{hoursHistoryStamp(event.at,data.timeZone)}</p>{event.googleState?<span className={styles.muted}>{event.googleState==='sent'?'Googleへ送信済み':'Googleへ送信する前'}</span>:null}</div><strong className={styles.historyTitle}>{event.summary}</strong>{event.description?<p className={styles.bodyText}>{event.description}</p>:null}<span className={styles.muted}>{event.staffName}</span></div>):<ListState kind="empty" title="営業時間の変更履歴はありません"/>}</div></Drawer>
  <UnsavedLeaveDialog open={leaveTarget !== null} subject="入力した営業時間" onConfirm={confirmLeave} onCancel={cancelLeave}/>
 </>
}
