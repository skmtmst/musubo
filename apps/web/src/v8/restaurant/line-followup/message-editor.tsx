'use client'
import { useId,useRef,useState,type ComponentProps } from 'react'
import type { BroadcastBubble } from '@line-crm/shared'
import InsertTextField,{type InsertTextFieldHandle} from '@/components/shared/insert-text-field'
import MessageInsertRow,{MessageBody,MessageInsertButton} from '@/components/shared/message-insert-row'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Button from '@/components/shared/button'
import { resolveDefaultToken, type InsertTokenSpec } from '@/components/shared/insert-tokens'
import { FollowupTemplatePicker } from './followup-template-picker'
import styles from './board.module.css'
const inserts:InsertTokenSpec[]=[
 {token:'{{name}}',label:'名前',hint:'受け取る方のLINEの名前',icon:'user'},
 {token:'{{reservation_datetime}}',label:'予約の時間',hint:'この予約の日時',icon:'calendar'},
 {token:'{{var.guest_count}}',label:'人数',hint:'この予約の人数',icon:'idcard'},
 {token:'{{var.store_name}}',label:'お店の名前',hint:'予約したお店の名前',icon:'store'},
]
const editorTokens:InsertTokenSpec[]=[...inserts,{token:'{{var.reservation_datetime}}',label:resolveDefaultToken('{{var.reservation_datetime}}')?.label??'予約の日時',hint:'この予約の日時',icon:'calendar'}]
function MessageTextBody({value,onValueChange,guideReady,...props}:ComponentProps<typeof InsertTextField>&{guideReady?:boolean}){
 const ref=useRef<InsertTextFieldHandle>(null)
 function insert(token:string){const at=ref.current?.selectionStart??value.length,end=ref.current?.selectionEnd??at;onValueChange(value.slice(0,at)+token+value.slice(end));requestAnimationFrame(()=>{ref.current?.focus();ref.current?.setSelectionRange(at+token.length,at+token.length)})}
 const body = <MessageBody><InsertTextField {...props} ref={ref} value={value} onValueChange={onValueChange}/><MessageInsertRow>{inserts.map(item=><MessageInsertButton key={item.token} kind={item.icon==='calendar'?'date':item.icon==='store'?'store':item.icon==='idcard'?'field':'name'} label={item.label} onClick={()=>insert(item.token)}/>)}</MessageInsertRow></MessageBody>
 return guideReady === undefined ? body : <div data-guide-anchor="followup.body" data-guide-ready={guideReady || undefined}>{body}</div>
}
function MessageText({value,onChange,index,guideReady}:{value:string;onChange:(value:string)=>void;index:number;guideReady?:boolean}){
 const id=useId()
 return <Field htmlFor={id} label={index===0?'本文':`本文${index+1}`} required><SaveErrorField names={[...(index===0?["messageBubbles"]:[]),`messageBubbles.${index}.content.text`]}><MessageTextBody id={id} aria-required={true} value={value} onValueChange={onChange} maxLength={5000} extraTokens={editorTokens} editorSize="message" guideReady={guideReady}/></SaveErrorField></Field>
}
export function FollowupMessageEditor({bubbles,onChange,accountId,storeName,guideReady}:{bubbles:BroadcastBubble[];onChange:(bubbles:BroadcastBubble[])=>void;accountId:string;storeName:string;guideReady?:boolean}){
 const [picker,setPicker]=useState(false),pickerId=useId()
 return <div className={styles.stack}>
  <div className={styles.row}><Button variant="secondary" onClick={()=>onChange([{id:crypto.randomUUID(),type:'text',content:{text:''}}])}>テキスト</Button><SaveErrorField names={bubbles[0]?.type!=='text'?["messageBubbles"]:[]}><Button id={pickerId} aria-label="テンプレートから選ぶ" variant="secondary" onClick={()=>setPicker(true)}>テンプレートから選ぶ</Button></SaveErrorField><Button variant="text" href="/templates">新しく作る →</Button></div>
  {bubbles.map((bubble,index)=><div key={bubble.id} className={styles.stack}>{bubble.type==='text'?<MessageText value={String(bubble.content.text??'')} index={index} guideReady={index===0?guideReady:undefined} onChange={text=>onChange(bubbles.map((item,at)=>at===index?{...item,content:{...item.content,text}}:item))}/>:<p data-guide-anchor={index===0&&guideReady!==undefined?'followup.body':undefined} data-guide-ready={index===0&&guideReady||undefined}>テンプレートの内容を使います。右の見え方で確認できます。</p>}{bubbles.length>1&&<Button variant="text" onClick={()=>onChange(bubbles.filter((_,at)=>at!==index))}>この吹き出しを外す</Button>}</div>)}
  {bubbles.length<5&&<Button variant="text" onClick={()=>onChange([...bubbles,{id:crypto.randomUUID(),type:'text',content:{text:''}}])}>テキストを足す</Button>}
  {picker&&<FollowupTemplatePicker accountId={accountId} storeName={storeName} onCancel={()=>setPicker(false)} onPick={next=>{onChange(next);setPicker(false)}}/>}
 </div>
}
