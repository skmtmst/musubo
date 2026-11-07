'use client'
import {useState} from 'react'
import type {RestaurantFloor} from '@line-crm/shared'
import {restaurantChairPositions} from '@line-crm/shared'
import {SaveErrorField} from '@/components/shared/save-form-errors'
import EntitySelect from './entity-select'
import Toggle from './toggle'
import styles from './restaurant-table-pen-editor.module.css'

export type Draft = {
  code: string; label: string; seatType: string; minCapacity: string; maxCapacity: string
  floorX: string; floorY: string; joinGroup: string; floorId: string
  shape: 'rectangle'|'circle'|'long'; orientation: 'horizontal'|'vertical'; smokingPolicy: 'non_smoking'|'smoking'|'heated_tobacco'; partition: 'open'|'semi_private'|'private'; shoesAllowed: boolean; isActive: boolean; visibleOnMap: boolean; chairArrangement: 'both'|'one'|'all'; chairSide: 'top'|'right'|'bottom'|'left'
  seatDetailType: 'table'|'counter'|'horigotatsu'|'zashiki'|'private_room'|'terrace'
}

type Props={draft:Draft;onChange:(draft:Draft)=>void;floors:RestaurantFloor[];errors:Partial<Record<keyof Draft,string>>;onCapacity:(field:'minCapacity'|'maxCapacity',value:string)=>void;count:number;onCount:(count:number)=>void;canBatch?:boolean}
const seatTypes:[Draft['seatDetailType'],string][]=[['table','テーブル'],['counter','カウンター'],['horigotatsu','掘りごたつ'],['zashiki','座敷']]
function Choice<T extends string>({items,value,onChange}:{items:[T,string][];value:T;onChange:(value:T)=>void}){return <div className={styles.choiceRow}>{items.map(([key,label])=><button key={key} type="button" className={value===key?styles.choiceActive:styles.choice} aria-pressed={value===key} onClick={()=>onChange(key)}>{label}</button>)}</div>}
function Badge(){return <span className={styles.required}>必須</span>}
function Label({children,required=false}:{children:React.ReactNode;required?:boolean}){return <span className={styles.label}>{children}{required?<Badge/>:null}</span>}
export default function TablePenEditor({draft,onChange,floors,errors,onCapacity,count,onCount,canBatch=true}:Props){
 const [showConditions,setShowConditions]=useState(false)
 const change=<K extends keyof Draft>(key:K,value:Draft[K])=>onChange({...draft,[key]:value})
 const chairs=restaurantChairPositions({capacity:Number(draft.maxCapacity),shape:draft.seatType==='counter'?'counter':draft.shape,orientation:draft.orientation,arrangement:draft.chairArrangement,side:draft.seatType==='counter'||draft.chairArrangement==='one'?draft.chairSide:undefined})
 return <div className={styles.columns}>
  <section className={styles.col}><h3>基本情報</h3>
   <div className={styles.two}>
    <label><Label required>卓番</Label><SaveErrorField names={['code']}><input aria-label="卓番" required value={draft.code} aria-invalid={!!errors.code} onChange={e=>change('code',e.target.value)} placeholder="例：3"/></SaveErrorField>{errors.code&&<small>{errors.code}</small>}</label>
    <label><Label required>表示名</Label><SaveErrorField names={['label']}><input aria-label="表示名" required value={draft.label} aria-invalid={!!errors.label} onChange={e=>change('label',e.target.value)} placeholder="例：テーブル3"/></SaveErrorField>{errors.label&&<small>{errors.label}</small>}</label>
    <label><Label required>最小人数</Label><SaveErrorField names={['minCapacity','min_capacity']}><input aria-label="最小人数" aria-required="true" required type="number" min="1" value={draft.minCapacity} aria-invalid={!!errors.minCapacity} onChange={e=>onCapacity('minCapacity',e.target.value)}/></SaveErrorField>{errors.minCapacity&&<small>{errors.minCapacity}</small>}</label>
    <label><Label required>最大人数</Label><SaveErrorField names={['maxCapacity','max_capacity']}><input aria-label="最大人数" aria-required="true" required type="number" min="1" value={draft.maxCapacity} aria-invalid={!!errors.maxCapacity} onChange={e=>onCapacity('maxCapacity',e.target.value)}/></SaveErrorField>{errors.maxCapacity&&<small>{errors.maxCapacity}</small>}</label>
   </div>
   <div className={styles.block}><Label required>階・エリア</Label><EntitySelect aria-label="階・エリア" size="full" invalid={!!errors.floorId} value={draft.floorId} onChange={value=>change('floorId',value)} options={floors.map(f=>({value:f.id,label:f.kind==='area'&&f.parentFloorId?`${floors.find(p=>p.id===f.parentFloorId)?.name??''} / ${f.name}`:f.name}))}/>{errors.floorId&&<small>{errors.floorId}</small>}</div>
   <div className={styles.field}><Label required>席タイプ</Label><Choice items={draft.seatDetailType==='private_room'?[...seatTypes,['private_room','個室']]:draft.seatDetailType==='terrace'?[...seatTypes,['terrace','テラス']]:seatTypes} value={draft.seatDetailType} onChange={v=>onChange({...draft,seatDetailType:v,seatType:v==='counter'?'counter':v==='private_room'||v==='terrace'?v:'table'})}/></div>
   <div className={styles.field}><Label required>卓の形</Label><div className={styles.shapes}>{([['rectangle','四角'],['circle','丸'],['long','長方形']] as [Draft['shape'],string][]).map(([value,label])=><button type="button" key={value} className={draft.shape===value?styles.shapeActive:styles.shape} onClick={()=>change('shape',value)} aria-pressed={draft.shape===value}><span className={styles.shapeIcon}><i className={styles[value]}/></span><span>{label}</span></button>)}</div></div>
   {draft.shape==='long'?<div className={styles.field}><Label>配置する向き</Label><Choice items={[[ 'horizontal','横長'],['vertical','縦長']]} value={draft.orientation} onChange={v=>change('orientation',v)}/></div>:null}
  </section>
  <section className={styles.col}>
   <div className={showConditions?styles.conditionSummaryExpanded:styles.conditionSummary}><strong>席の条件</strong>{!showConditions?<p>{draft.smokingPolicy==='non_smoking'?'禁煙':draft.smokingPolicy==='smoking'?'喫煙':'加熱式たばこのみ'} · {draft.partition==='open'?'オープン':draft.partition==='private'?'個室':'半個室'} · {draft.shoesAllowed?'土足可':'土足不可'}<br/>{draft.isActive?'予約受付中':'停止中'} · {draft.visibleOnMap?'座席表に表示':'座席表で非表示'}</p>:null}<button type="button" aria-expanded={showConditions} onClick={()=>setShowConditions(v=>!v)}>{showConditions?'プレビューへ戻る':'席の条件を変更 ›'}</button></div>
   {!showConditions?<div className={styles.preview}><strong>椅子の配置プレビュー</strong><p>最大{draft.maxCapacity||'0'}名 × {draft.shape==='long'?'長方形':draft.seatType==='counter'?'カウンター':draft.shape==='circle'?'丸':'四角'}の卓 → 椅子{chairs.length}席を自動配置</p><div className={styles.previewCanvas}><div className={styles.previewTable} data-shape={draft.shape} data-orientation={draft.orientation}>{chairs.map((chair,index)=><i key={index} className={styles.previewChair} data-side={chair.side} style={{'--offset':chair.offset} as React.CSSProperties}/>)}<span>{draft.minCapacity}〜{draft.maxCapacity}名</span></div></div></div>:null}
   {!showConditions&&canBatch?<div className={`${styles.field} ${styles.countField}`}><Label>作成する数</Label><div className={styles.stepper}><button type="button" aria-label="作成する数を減らす" onClick={()=>onCount(Math.max(1,count-1))}>−</button><output aria-label="作成する数">{count}</output><button type="button" aria-label="作成する数を増やす" onClick={()=>onCount(Math.min(100,count+1))}>＋</button></div></div>:null}
   {showConditions?<div className={styles.conditionFields}>
   <div className={styles.field}><Label required>禁煙・喫煙</Label><Choice items={[[ 'non_smoking','禁煙'],['smoking','喫煙'],['heated_tobacco','加熱式たばこのみ']]} value={draft.smokingPolicy} onChange={v=>change('smokingPolicy',v)}/></div>
   <div className={styles.field}><Label>間仕切り</Label><Choice items={[[ 'open','オープン'],['semi_private','半個室'],['private','個室']]} value={draft.partition} onChange={v=>change('partition',v)}/></div>
   <div className={styles.field}><Label>土足</Label><Choice items={[[ 'yes','土足可'],['no','土足不可']]} value={draft.shoesAllowed?'yes':'no'} onChange={v=>change('shoesAllowed',v==='yes')}/></div>
   <div className={styles.field}><Label>予約受付</Label><Choice items={[[ 'yes','受付中'],['no','停止中']]} value={draft.isActive?'yes':'no'} onChange={v=>change('isActive',v==='yes')}/></div>
   <div className={styles.field}><Label>座席表に表示</Label><div className={styles.switchRow}><Toggle className={styles.switchControl} checked={draft.visibleOnMap} onChange={value=>change('visibleOnMap',value)} label="座席表に表示"/><span>表示する</span></div><p>座席表での表示を切り替えます。予約可否は「予約受付」で管理します。</p></div>
   {draft.shape==='long'&&draft.seatType!=='counter'?<div className={styles.field}><Label>椅子の配置</Label><Choice items={[[ 'both','両側'],['one','片側'],['all','四方']]} value={draft.chairArrangement} onChange={v=>change('chairArrangement',v)}/></div>:null}
   {(draft.seatType==='counter'||draft.chairArrangement==='one')?<div className={styles.field}><Label>椅子を置く側</Label><Choice items={[[ 'top','上'],['right','右'],['bottom','下'],['left','左']]} value={draft.chairSide} onChange={v=>change('chairSide',v)}/></div>:null}
   </div>:null}
  </section>
 </div>
}
