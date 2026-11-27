'use client'
import { useState } from 'react'
import type { RestaurantFollowupTiming,RestaurantFollowupTrigger } from '@line-crm/shared'
import Radio,{RadioGroup} from '@/components/shared/radio'
import { Field } from '@/components/shared/form-controls'
import NumberField from '@/components/shared/number-field'
import TimeField from '@/components/shared/time-field-v8'
import Select from '@/components/shared/select'
import { SettingsFormRow } from '@/components/shared/settings-form-card'
import { exactTiming,UNIT_MINUTES,type OffsetUnit } from './config'
import { followupTimingError } from './board-model'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import styles from './board.module.css'
function defaultUnitFor(value: number): OffsetUnit {
 return Number.isFinite(value) ? exactTiming(Math.abs(value), ['minutes', 'hours', 'days']).unit : 'minutes'
}

function parseFiniteNumber(raw: string, valueAsNumber: number): number | null {
 if (raw.trim() === '') return null
 if (Number.isFinite(valueAsNumber)) return valueAsNumber
 const parsed = Number(raw)
 return Number.isFinite(parsed) ? parsed : null
}

function CountdownField({value,before,onChange}:{value:number;before:boolean;onChange:(value:number)=>void}){
 const [state,setState]=useState<{syncedValue:number;emittedValue:number|null;unit:OffsetUnit;draft:string|null}>(()=>({
  syncedValue:value,
  emittedValue:null,
  unit:defaultUnitFor(value),
  draft:null,
 }))
 let unit=state.unit
 let draft=state.draft
 if(!Object.is(state.syncedValue,value)){
  const fromSelf=state.emittedValue!==null&&Object.is(state.emittedValue,value)
  const nextUnit=fromSelf?state.unit:defaultUnitFor(value)
  const nextDraft=fromSelf?state.draft:null
  setState({syncedValue:value,emittedValue:null,unit:nextUnit,draft:nextDraft})
  unit=nextUnit
  draft=nextDraft
 }
 const displayed=draft!==null?draft:Number.isFinite(value)?(before?-value:value)/UNIT_MINUTES[unit]:''
 return <SettingsFormRow layout="columns"><SaveErrorField names={["timing","timing.offsetMinutes"]}><NumberField aria-label={before?'予約までの時間':'きっかけから待つ時間'} min={before?1:0} value={displayed} onChange={e=>{
  const parsed=parseFiniteNumber(e.target.value,e.target.valueAsNumber)
  if(parsed===null){setState(prev=>({...prev,draft:''}));return}
  const next=parsed===0?0:(before?-1:1)*parsed*UNIT_MINUTES[unit]
  setState(prev=>({...prev,emittedValue:next,draft:null}))
  onChange(next)
 }} onBlur={()=>{if(draft!==null)setState(prev=>({...prev,draft:null}))}}/></SaveErrorField><Select aria-label="時間の単位" value={unit} onChange={next=>setState(prev=>({...prev,unit:next as OffsetUnit,draft:null}))} options={[{value:'minutes',label:'分'},{value:'hours',label:'時間'},{value:'days',label:'日'}]}/></SettingsFormRow>
}

function DaysField({offsetDays,anniversary,onChange}:{offsetDays:number;anniversary:boolean;onChange:(offsetDays:number)=>void}){
 const [state,setState]=useState<{syncedDays:number;draft:string|null}>(()=>({syncedDays:offsetDays,draft:null}))
 let draft=state.draft
 if(!Object.is(state.syncedDays,offsetDays)){
  setState({syncedDays:offsetDays,draft:null})
  draft=null
 }
 const displayed=draft!==null?draft:Number.isFinite(offsetDays)?(offsetDays===0?0:-offsetDays):''
 return <NumberField aria-label={anniversary?'記念日の何日前':'予約の何日前'} unit="日前" min={anniversary?1:0} max={365} value={displayed} onChange={e=>{
  const parsed=parseFiniteNumber(e.target.value,e.target.valueAsNumber)
  if(parsed===null){setState(prev=>({...prev,draft:''}));return}
  const next=parsed===0?0:-parsed
  setState(prev=>({...prev,draft:null}))
  onChange(next)
 }} onBlur={()=>{if(draft!==null)setState(prev=>({...prev,draft:null}))}}/>
}

export function FollowupTimingFields({trigger,value,onChange}:{trigger:RestaurantFollowupTrigger;value:RestaurantFollowupTiming;onChange:(next:RestaurantFollowupTiming)=>void}){
 const before=['reservation_24h','reservation_2h','anniversary_before'].includes(trigger),anniversary=trigger==='anniversary_before'
 const nextDay=['post_visit','review_request'].includes(trigger)
 return <Field label="いつ送るか" required error={followupTimingError(trigger,value)}>
  <RadioGroup label="送る時期" className={styles.stack}>
   {before?<>
    <Radio name="followup-timing" checked={value.mode==='time'} onChange={()=>onChange({mode:'time',offsetDays:anniversary?-7:-1,sendAtTime:anniversary?'10:00':'18:00'})}>{anniversary?'記念日の何日前・時刻':'予約の前日など、日と時刻を決める'}</Radio>
    {!anniversary&&<Radio name="followup-timing" checked={value.mode==='countdown'} onChange={()=>onChange({mode:'countdown',offsetMinutes:-120})}>予約の何時間前に送る</Radio>}
   </>:<>
    <SaveErrorField names={value.mode==='countdown'&&value.offsetMinutes===0?['timing']:[]}><Radio name="followup-timing" checked={value.mode==='countdown'&&value.offsetMinutes===0} onChange={()=>onChange({mode:'countdown',offsetMinutes:0})}>すぐに送る</Radio></SaveErrorField>
    <Radio name="followup-timing" checked={value.mode==='countdown'&&value.offsetMinutes!==0} onChange={()=>onChange({mode:'countdown',offsetMinutes:trigger==='post_visit'?180:5})}>きっかけから時間を置いて送る</Radio>
    {nextDay&&<Radio name="followup-timing" checked={value.mode==='next_day'} onChange={()=>onChange({mode:'next_day',sendAtTime:'10:00'})}>退店の翌日の時刻に送る</Radio>}
   </>}
  </RadioGroup>
  {value.mode==='time'?<SettingsFormRow layout="columns"><SaveErrorField names={["timing","timing.offsetDays"]}><DaysField offsetDays={value.offsetDays} anniversary={anniversary} onChange={offsetDays=>onChange({...value,offsetDays})}/></SaveErrorField><SaveErrorField names={["timing.sendAtTime"]}><TimeField aria-label="送る時刻" value={value.sendAtTime} onChange={sendAtTime=>onChange({...value,sendAtTime})}/></SaveErrorField></SettingsFormRow>:
   value.mode==='next_day'?<SaveErrorField names={["timing","timing.sendAtTime"]}><TimeField aria-label="翌日の時刻" value={value.sendAtTime} onChange={sendAtTime=>onChange({...value,sendAtTime})}/></SaveErrorField>:
   value.offsetMinutes!==0?<CountdownField before={before} value={value.offsetMinutes} onChange={offsetMinutes=>onChange({mode:'countdown',offsetMinutes})}/>:null}
 </Field>
}
