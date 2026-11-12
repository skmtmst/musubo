'use client'
import { useContext,useEffect,useRef,useState } from 'react'
import { RESTAURANT_RESERVATION_REQUIRED_FIELDS,parseRestaurantReservationForm,type RestaurantReservationForm } from '@line-crm/shared'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Dialog from '@/components/shared/dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { Field } from '@/components/shared/form-controls'
import { TextField,TextArea } from '@/components/shared/text-field'
import { ToggleField } from '@/components/shared/toggle'
import Button from '@/components/shared/button'
import LiffPhoneFrame from '@/components/shared/liff-phone-frame'
import { DetailColumns } from '@/components/templates/detail-columns'
import { SettingsFormRow } from '@/components/shared/settings-form-card'
import styles from './board.module.css'
const values={name:'見本 花子',phone:'090-0000-5678',dateTime:'11月1日 19:00',guestCount:'2名',allergy:'乳製品',note:'窓側の席を希望'}
/** 実LIFFと同じ定義で、確認の手順の項目と必須を表示する。 */
export function ReservationFormSample({definition,storeName,compact=false}:{definition:RestaurantReservationForm;storeName:string;compact?:boolean}){
 return <LiffPhoneFrame title={definition.title} accountName={storeName} scaleToFit={compact} compact={compact} step={2} steps={['人数・日時・コース','確認']} label="予約の回答フォームの見本">
  <div className={styles.formSample}><h3>{definition.title}</h3><p>ご予約の内容（見本）</p>
   {definition.fields.filter(field=>field.enabled).map(field=><Field key={field.id} label={field.label} required={field.required}><TextField value={values[field.id]} readOnly tabIndex={-1} /></Field>)}
   <Button variant="primary" disabled>予約する</Button>
   <p>完了後：{definition.completionMessage}</p>
  </div>
 </LiffPhoneFrame>
}
export function ReservationFormEditor({definition,storeName,pageDirty,pageBusy,onDiscardPage,onCancel,onConfirm}:{definition:RestaurantReservationForm;storeName:string;pageDirty:boolean;pageBusy:boolean;onDiscardPage:()=>void;onCancel:()=>void;onConfirm:(next:RestaurantReservationForm)=>void}){
 const [draft,setDraft]=useState(()=>structuredClone(definition)),[expanded,setExpanded]=useState(false),[error,setError]=useState('')
 const depth=useContext(OverlayDepthContext)
 const localDirty=JSON.stringify(draft)!==JSON.stringify(definition)
 const pageGuard=useUnsavedGuard({dirty:pageDirty||localDirty,busy:pageBusy,onDiscard:onDiscardPage})
 const alive=useRef(true),current=useRef({busy:pageBusy,target:pageGuard.leaveTarget})
 current.current={busy:pageBusy,target:pageGuard.leaveTarget}
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 function discardAndLeave(){
  const target=pageGuard.leaveTarget
  if(!alive.current||current.current.busy||!target||current.current.target!==target)return
  current.current.target=null
  pageGuard.disarm();pageGuard.confirmLeave()
 }
 const change=(id:string,update:Partial<RestaurantReservationForm['fields'][number]>)=>setDraft(prev=>({...prev,fields:prev.fields.map(field=>field.id===id?{...field,...update}:field)}))
 return <><Dialog open size="wide" title="予約の回答フォームを変える" dirty={localDirty} onCancel={onCancel} confirmLabel="この内容にする" error={error} onConfirm={()=>{const parsed=parseRestaurantReservationForm(draft);if(!parsed.ok){setError(parsed.error);return}onConfirm(parsed.value)}}>
  <DetailColumns asideLabel="予約フォームの見え方" expanded={expanded} onExpandedChange={setExpanded} aside={<ReservationFormSample definition={draft} storeName={storeName}/>}>
   <div className={styles.stack}>
    <Field label="題名" required><SaveErrorField names={["definition","title","definition.title"]}><TextField value={draft.title} maxLength={80} onChange={e=>setDraft({...draft,title:e.target.value})}/></SaveErrorField></Field>
    <Field label="聞く項目" note="お名前・日時・人数は予約に必要なため外せません。日時と人数は最初の手順で選びます。">
     {draft.fields.map((field,index)=>{const fixed=RESTAURANT_RESERVATION_REQUIRED_FIELDS.includes(field.id);return <SettingsFormRow key={field.id} layout="columns" columns={3}>
      <SaveErrorField names={[`definition.fields.${index}.label`]}><TextField aria-label={`${field.label}の項目名`} value={field.label} maxLength={50} onChange={e=>change(field.id,{label:e.target.value})}/></SaveErrorField>
      <ToggleField aria-label={`${field.label}を表示する`} checked={field.enabled} locked={fixed} onChange={enabled=>change(field.id,{enabled,required:enabled&&field.required})}>表示する</ToggleField>
      <ToggleField aria-label={`${field.label}を必須にする`} checked={field.required} locked={fixed} disabled={!field.enabled} onChange={required=>change(field.id,{required})}>必須にする</ToggleField>
     </SettingsFormRow>})}
    </Field>
    <Field label="完了後の文" required><SaveErrorField names={["completionMessage","definition.completionMessage"]}><TextArea value={draft.completionMessage} maxLength={500} onChange={e=>setDraft({...draft,completionMessage:e.target.value})}/></SaveErrorField></Field>
   </div>
  </DetailColumns>
 </Dialog><OverlayDepthContext.Provider value={depth+1}><UnsavedLeaveDialog open={pageGuard.leaveTarget !== null} subject="LINE来店フォローの変更" onConfirm={discardAndLeave} onCancel={pageGuard.cancelLeave} busy={pageBusy}/></OverlayDepthContext.Provider></>
}
