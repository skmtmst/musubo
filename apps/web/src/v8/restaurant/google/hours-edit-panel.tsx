'use client'
import { useEffect, useRef, useState } from 'react'
import { HOURS_WEEKDAYS, HOURS_SERVICE_LABELS, hoursPeriodsProblem, type HoursWorkspace, type HoursWeekday, type HoursService, type HolidayHoursRule, type OpeningPeriod } from '@line-crm/shared'
import '@/components/shared/google-hours-tokens.css'
import Drawer from '@/components/shared/drawer'
import Button from '@/components/shared/button'
import Radio, { RadioGroup } from '@/components/shared/radio'
import { ToggleField } from '@/components/shared/toggle'
import { HoursTextProposal } from './hours-text-proposal'
import Select from '@/components/shared/select'
import { Field, OptionalBadge } from '@/components/shared/form-controls'
import { TextField, TextArea } from '@/components/shared/text-field'
import TimeField from '@/components/shared/time-field-v8'
import Notice from '@/components/shared/notice'
import Disclosure from '@/components/shared/disclosure'
import Dialog from '@/components/shared/dialog'
import Card from '@/components/shared/card'
import { restaurantGoogleApi, type GoogleProfileData, type GoogleChange } from '@/lib/restaurant-google-api'
import { PeriodFields, Weekdays } from './hours-controls'
import { DateEditor, type DateEditorValue } from './hours-date-editor'
import { dateLabel, googleTypeFor, hoursText, workspaceDay } from './hours-model'
import { WEEKDAY_JA, errorMessage } from './format'
import styles from './hours.module.css'
import { readGuideDraft, writeGuideDraft } from '@/lib/scoped-guide-draft'

export type HoursPanel = { kind:'weekly'; weekday?:HoursWeekday } | {kind:'holiday'} | {kind:'dates'; dates?:string[]; mode?:'dates'|'range'; group?:Array<{date:string;name?:string}>} | {kind:'service'; service?:HoursService} | {kind:'text'}
type HoursEditorDraft = {
 version?: number; panel: string; weekdays: HoursWeekday[]; weekPeriods: OpeningPeriod[]; weekClosed: boolean;
 dateValue: DateEditorValue | null; service: HoursService; text: string; parsed: GoogleChange | null; valid: boolean; editing: boolean;
}

export function HoursEditPanel({ panel, data, workspace, holidays, serviceTypes, onDraft, onReview, onClose, onEditDates, onUnsavedChange, saving, saved, disabled, lockedReason, draftKey = null, draftVersion }: { panel:HoursPanel;data:GoogleProfileData;workspace:HoursWorkspace;holidays:Array<{date:string;name:string}>;serviceTypes:Array<{id:string;label:string}>;onUnsavedChange?:(dirty:boolean)=>void;onDraft:(w:HoursWorkspace)=>void;onReview:()=>void;onClose:()=>void;onEditDates:(dates:string[])=>void;saving:boolean;saved:boolean;disabled:boolean;lockedReason?:string;draftKey?:string|null;draftVersion?:number }) {
 const panelKey=JSON.stringify(panel)
 const [restored]=useState(()=>{
  const value=readGuideDraft<HoursEditorDraft>(draftKey)
  return value?.version===draftVersion&&value?.panel===panelKey?value:null
 })
 const [base]=useState(()=>structuredClone(workspace))
 const weekly=workspace.draft.weekly??data.profile.regularHours
 const first=panel.kind==='weekly'?(panel.weekday??HOURS_WEEKDAYS.find(d=>weekly[d].length)??'MONDAY'):'MONDAY'
 const [weekdays,setWeekdays]=useState<HoursWeekday[]>(restored?.weekdays??(panel.kind==='weekly'&&panel.weekday?[first]:HOURS_WEEKDAYS.filter(d=>JSON.stringify(weekly[d])===JSON.stringify(weekly[first]))))
 const [weekPeriods,setWeekPeriods]=useState<OpeningPeriod[]>(restored?.weekPeriods??(weekly[first].length?weekly[first]:[{open:'11:00',close:'22:00'}]))
 const [weekClosed,setWeekClosed]=useState(restored?.weekClosed??weekly[first].length===0)
 const [dateValue,setDateValue]=useState<DateEditorValue|null>(restored?.dateValue??null)
 const [service,setService]=useState<HoursService>(restored?.service??(panel.kind==='service'&&panel.service?panel.service:{id:crypto.randomUUID(),kind:'lunch',label:'ランチ',googleTypeId:googleTypeFor('lunch',serviceTypes),sameWeekdays:true,weekdays:HOURS_WEEKDAYS.filter(d=>weekly[d].length),periods:[{open:'11:00',close:'15:00'}],orderDeadline:'',menu:''}))
 const [deleteOpen,setDeleteOpen]=useState(false)
 const [text,setText]=useState(restored?.text??'')
 const [parsed,setParsed]=useState<GoogleChange|null>(restored?.parsed??null)
 const [parsing,setParsing]=useState(false)
 const [parseError,setParseError]=useState('')
 const [question,setQuestion]=useState('')
 const [valid,setValid]=useState(restored?.valid??false)
 const [editing,setEditing]=useState(restored?.editing??false)
 const aliveRef=useRef(true),parseSeqRef=useRef(0),parsingRef=useRef(false)
 useEffect(()=>{aliveRef.current=true;return()=>{aliveRef.current=false;parseSeqRef.current+=1;parsingRef.current=false}},[])
 useEffect(()=>{parseSeqRef.current+=1;parsingRef.current=false;setParsing(false)},[data.store.lineAccountId,panelKey])
 useEffect(()=>{
  if(!draftKey)return
  writeGuideDraft(draftKey,{version:draftVersion,panel:panelKey,weekdays,weekPeriods,weekClosed,dateValue,service,text,parsed,valid,editing} satisfies HoursEditorDraft)
 },[draftKey,draftVersion,panelKey,weekdays,weekPeriods,weekClosed,dateValue,service,text,parsed,valid,editing])
 const localUnsaved=panel.kind==='text'?Boolean(text.trim())&&!parsed:editing&&(!saved||!valid)
 useEffect(()=>{onUnsavedChange?.(localUnsaved);return()=>onUnsavedChange?.(false)},[localUnsaved,onUnsavedChange])
 const title=panel.kind==='weekly'?'毎週の営業時間を編集':panel.kind==='holiday'?'祝日の営業時間':panel.kind==='service'?'サービスの営業時間':panel.kind==='text'?'文章で入力':panel.group?'連休の営業時間':'特別営業日の変更'
 const draftWeek=(days:HoursWeekday[],periods:OpeningPeriod[],closed:boolean)=>{
  setEditing(true);setWeekdays(days);setWeekPeriods(periods);setWeekClosed(closed)
  const ok=Boolean(days.length)&&(closed||!hoursPeriodsProblem(periods));setValid(ok)
  if(ok){const w=structuredClone(base.draft.weekly??data.profile.regularHours);for(const d of days)w[d]=closed?[]:periods;onDraft({...workspace,draft:{...workspace.draft,weekly:w,reviewIds:[]}})}
 }
 const draftHoliday=(patch:Partial<HolidayHoursRule>)=>{
  setEditing(true);const rule={...workspace.holiday,...patch};const ok=rule.mode!=='custom'||!hoursPeriodsProblem(rule.periods);setValid(ok)
  if(ok)onDraft({...workspace,holiday:rule,draft:{...workspace.draft,holidayChanged:true,reviewIds:[]}})
 }
 const draftDate=(v:DateEditorValue|null)=>{
  setEditing(true);setDateValue(v);setValid(Boolean(v));if(!v){onDraft({...workspace,draft:{...workspace.draft,days:base.draft.days,reviewIds:[]}});return}
  const previous=base.draft.days
  const days=new Map(previous.map(d=>[d.date,d]));for(const date of v.dates)days.set(date,{date,closed:v.closed,periods:v.closed?[]:v.periods,remove:v.remove})
  const notes={...workspace.notes};for(const date of v.dates)notes[date]=v.memo
  onDraft({...workspace,notes,draft:{...workspace.draft,days:[...days.values()].sort((a,b)=>a.date.localeCompare(b.date)),reviewIds:[]}})
 }
 const draftService=(patch:Partial<HoursService>)=>{
  setEditing(true);const next={...service,...patch};setService(next)
  const ok=next.label.trim().length>0&&next.periods.length>0&&!hoursPeriodsProblem(next.periods)&&(next.sameWeekdays||next.weekdays.length>0);setValid(Boolean(ok))
  if(ok)onDraft({...workspace,services:[...workspace.services.filter(s=>s.id!==next.id),next],draft:{...workspace.draft,serviceIds:[...new Set([...workspace.draft.serviceIds,...(panel.kind==='service'&&panel.service?.googleTypeId&&panel.service.googleTypeId!==next.googleTypeId?[`remove:${panel.service.googleTypeId}`]:[]),next.id])],reviewIds:[]}})
 }
 const parse=async()=>{
  if(!text.trim()||disabled||parsing||parsingRef.current)return
  const seq=++parseSeqRef.current;parsingRef.current=true;setParsing(true);setParseError('');setQuestion('')
  try{
   const result=await restaurantGoogleApi.proposeHours(data.store.lineAccountId,{source:'text',text:text.trim()})
   if(!aliveRef.current||parseSeqRef.current!==seq)return
   if((result as {success?:boolean}|null)?.success===false)throw new Error((result as {error?:string}).error||'変更案を読み取れませんでした。入力内容は残っています。')
   if(result.change){setParsed(result.change);setValid(true);const change=result.change;if(change.kind==='special_hours'){const days=new Map(workspace.draft.days.map(d=>[d.date,d]));for(const day of change.after as import('@line-crm/shared').OpeningDate[])days.set(day.date,day);onDraft({...workspace,draft:{...workspace.draft,days:[...days.values()].sort((a,b)=>a.date.localeCompare(b.date)),reviewIds:[]}})}else if(change.kind==='regular_hours')onDraft({...workspace,draft:{...workspace.draft,weekly:change.after as import('@line-crm/shared').OpeningWeek,reviewIds:[]}})}else setQuestion(result.question??'変更する日付と時間を入力してください。')
  }catch(e){if(aliveRef.current&&parseSeqRef.current===seq)setParseError(errorMessage(e,'変更案を読み取れませんでした。入力内容は残っています。'))}
  finally{if(parseSeqRef.current===seq){parsingRef.current=false;if(aliveRef.current)setParsing(false)}}
 }
 return <><Drawer guideSlot="hours.confirm" open title={title} width="hours" headerIcon={false} heightMode="viewport" dirty={localUnsaved} showDirtyIndicator={false} busy={parsing} onClose={onClose} footer={<div className={styles.panelFooter}><span className={styles.muted} role="status">{saving?'下書きを保存しています…':saved&&(!editing||valid)?'入力内容は保存されています':'入力内容を確認してください'}</span><div className={styles.actions}><Button presentation="hours" size="field" onClick={onClose} disabled={saving}>{panel.kind==='text'?'キャンセル':'閉じる'}</Button><Button presentation="hours" size="field" variant="primary" lockedReason={lockedReason} disabled={disabled||saving||!valid} data-guide-anchor="hours.confirm" onClick={onReview}>変更内容を確認</Button></div></div>}>
  <div className={styles.editorSections}>
  {panel.kind==='weekly'?<>
    <Field optional={false} contentGap={20} labelSize="section" label="同じ営業時間にする曜日"><Weekdays selected={weekdays} disabled={disabled} onChange={days=>draftWeek(days,weekPeriods,weekClosed)}/></Field><p className={styles.muted}>曜日は複数選べます。</p>
    <RadioGroup className={styles.radioColumn} label="毎週の営業"><Radio size="body" rowHeight="comfortable" name="weekly-state" checked={!weekClosed} disabled={disabled} onChange={()=>draftWeek(weekdays,weekPeriods,false)}>営業する</Radio><Radio size="body" rowHeight="comfortable" name="weekly-state" checked={weekClosed} disabled={disabled} onChange={()=>draftWeek(weekdays,weekPeriods,true)}>定休日にする</Radio></RadioGroup>
    {!weekClosed?<><h3>営業時間</h3><PeriodFields value={weekPeriods} disabled={disabled} onChange={p=>draftWeek(weekdays,p,false)}/><p className={styles.muted}>翌日まで営業する場合は「翌0:00」のように選べます。</p></>:null}
    <Notice tone="info" appearance="subtle">{weekdays.map(d=>WEEKDAY_JA[d]).join('・')||'選択した'}曜日を同じ営業時間に変更します。</Notice>
  </>:panel.kind==='holiday'?<>
    <h3 className={styles.questionTitle}>祝日はどう営業しますか？</h3><RadioGroup className={styles.radioColumn} label="祝日の営業">{(['weekly','custom','closed'] as const).map((mode,i)=><Radio size="body" rowHeight="comfortable" key={mode} name="holiday-mode" checked={workspace.holiday.mode===mode} disabled={disabled} onChange={()=>draftHoliday({mode})}>{['曜日どおりに営業する','祝日用の時間で営業する','休業する'][i]}</Radio>)}</RadioGroup>
    {workspace.holiday.mode==='custom'?<><h3>祝日の営業時間</h3><PeriodFields value={workspace.holiday.periods} disabled={disabled} onChange={periods=>draftHoliday({periods})}/></>:null}
    {workspace.holiday.mode!=='weekly'?<div className={styles.holidayOverride}><ToggleField size="large" checked={workspace.holiday.overrideClosedWeekday} disabled={disabled} lockedReason={lockedReason} onChange={overrideClosedWeekday=>draftHoliday({overrideClosedWeekday})}>定休日でも、祝日は{workspace.holiday.mode==='closed'?'休業する':'営業する'}</ToggleField></div>:null}
    <p className={styles.muted}>振替休日も祝日として扱います。</p><Card surface="preview" layout="vertical" padding="default" gap="var(--space-12)"><h3 className={styles.previewTitle}>祝日の営業予定</h3>{holidays.slice(0,3).map(h=><div className={styles.splitRow} key={h.date}><span>{dateLabel(h.date,data.today.date,true)}</span><strong className={workspaceDay(h.date,data,workspace,holidays).periods.length?styles.green:styles.previewClosed}>{hoursText(workspaceDay(h.date,data,workspace,holidays).periods)}</strong></div>)}<p className={styles.muted}>祝日と指定した休業期間が重なる日は、休業になります。</p></Card><Notice tone="info" appearance="subtle">日付を指定した休業がある場合は、その日は休業します。</Notice>
  </>:panel.kind==='dates'?<DateEditor weekly={weekly} today={data.today.date} initialDates={panel.dates} initialMode={panel.mode} groupDates={panel.group} initialMemo={base.notes[panel.dates?.[0]??'']??''} initialPeriods={panel.group?workspace.holiday.periods:undefined} removableDates={data.profile.specialHours.map(d=>d.date)} individualDates={[...new Set([...data.profile.specialHours,...base.draft.days.filter(d=>!d.remove)].filter(d=>d.closed).map(d=>d.date))]} original={date=>workspaceDay(date,data,base,holidays)} onChange={draftDate} disabled={disabled} draftKey={draftKey?`${draftKey}:dates`:null} draftVersion={draftVersion}/>:panel.kind==='service'?<>
    <Field optional={false} label="種類"><Select textSize="body" size="full" aria-label="サービスの種類" value={service.kind} disabled={disabled} options={Object.entries(HOURS_SERVICE_LABELS).map(([value,label])=>({value,label}))} onChange={e=>{const kind=e as HoursService['kind'];draftService({kind,label:HOURS_SERVICE_LABELS[kind],googleTypeId:googleTypeFor(kind,serviceTypes)})}}/></Field>
    {service.kind==='other'?<Field optional={false} label="サービス名"><TextField textSize="body" value={service.label} maxLength={80} disabled={disabled} onChange={e=>draftService({label:e.target.value})}/></Field>:null}
    <ToggleField size="large" checked={service.sameWeekdays} disabled={disabled} lockedReason={lockedReason} onChange={sameWeekdays=>draftService({sameWeekdays})}>店舗と同じ曜日に提供する</ToggleField>
    {service.sameWeekdays?<p className={styles.muted}>{HOURS_WEEKDAYS.filter(d=>weekly[d].length).map(d=>WEEKDAY_JA[d]).join('・')}曜日に提供します。店舗の休業日は提供しません。</p>:<Weekdays selected={service.weekdays} disabled={disabled} onChange={weekdays=>draftService({weekdays})}/>}
    <h3>{service.kind==='takeout'?'受け取りできる時間':'営業時間'}</h3><PeriodFields value={service.periods} takeout={service.kind==='takeout'} disabled={disabled} onChange={periods=>draftService({periods})}/>
    <Disclosure size="body" appearance="section" defaultOpen={Boolean(service.orderDeadline||service.menu)} title={<>追加の設定<OptionalBadge appearance="parentheses"/></>}><div className={styles.stackLarge}><Field optional={false} label="注文の受付終了"><TimeField appearance="business-hours" value={service.orderDeadline} minuteStep={15} disabled={disabled} onChange={orderDeadline=>draftService({orderDeadline})}/></Field><Field optional={false} label="提供するメニュー"><TextField textSize="body" value={service.menu} maxLength={120} disabled={disabled} placeholder="例：テイクアウトメニュー" onChange={e=>draftService({menu:e.target.value})}/></Field><p className={styles.muted}>受付終了とメニューは、musubo内で使用します。</p></div></Disclosure>
    <p className={styles.muted}>Googleに掲載できる内容は、確認画面で確認できます。</p>
    {panel.service?<Button presentation="hours" variant="text" textTone="danger" size="compact" disabled={disabled} lockedReason={lockedReason} onClick={()=>setDeleteOpen(true)}>{service.label}の営業時間を削除</Button>:null}
  </>:<>
    <p className={styles.editorIntro}>変更したい内容を、そのまま入力できます。</p>
    <TextArea aria-label="文章で入力" value={text} rows={3} maxLength={500} disabled={disabled||!data.aiAvailable} placeholder="例：12月30日から1月3日まで年末年始のため休業。1月4日から通常どおり営業します。" onChange={e=>{parseSeqRef.current+=1;parsingRef.current=false;setParsing(false);setEditing(true);setText(e.target.value);setParsed(null);setParseError('');setQuestion('');setValid(false)}} action={data.aiAvailable?<Button presentation="hours" variant="text" size="compact" disabled={disabled||!text.trim()} busy={parsing} onMouseDown={event=>event.preventDefault()} onClick={parse}>{parsed?'変更案を作り直す':'変更案を作る'}</Button>:undefined}/>
    {!data.aiAvailable?<p className={styles.muted}>文章で入力できる環境ではありません。日付を選んで変更できます。</p>:null}
    {question?<Notice tone="info">{question}</Notice>:null}{parseError?<Notice tone="danger">{parseError}</Notice>:null}
    {parsed?<HoursTextProposal change={parsed} data={data} workspace={workspace} holidays={holidays} onEditDates={onEditDates}/>:null}
  </>}
  {panel.kind==='dates'&&dateValue?.remove?<p>通常の営業時間に戻します。</p>:null}
  </div>
 </Drawer><Dialog open={deleteOpen} title={`${service.label}の営業時間を削除しますか？`} description="変更内容を確認してからGoogleに反映します。" confirmLabel="削除する" cancelLabel="キャンセル" onCancel={()=>setDeleteOpen(false)} onConfirm={()=>{onDraft({...workspace,services:workspace.services.filter(s=>s.id!==service.id),draft:{...workspace.draft,serviceIds:[...new Set([...workspace.draft.serviceIds,service.googleTypeId?`remove:${service.googleTypeId}`:service.id])],reviewIds:[]}});setDeleteOpen(false);onClose()}} /></>
}
