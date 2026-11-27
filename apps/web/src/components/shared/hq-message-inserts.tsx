'use client'
import {useRef,useState,type RefObject,type CSSProperties} from 'react'
import {BASIC_FRIEND_FIELDS} from '@line-crm/shared'
import MessageInsertRow, { MessageBody, MessageInsertButton } from './message-insert-row'
import ActionMenu from './action-menu'
import InsertTextField,{InsertText,type InsertTextFieldHandle} from './insert-text-field'
import type {InsertTokenSpec} from './insert-tokens'
export const HQ_FRIEND_INSERTS=BASIC_FRIEND_FIELDS.map(field=>({label:`{${field.label}}`,token:`{{field.fixed_${field.key}}}`,help:`決まった欄の${field.label}`}))
export const HQ_INSERT_CHIPS:readonly InsertTokenSpec[]=[
 {token:'{{account.name}}',label:'店名',hint:'送る店の名前',icon:'store'},
 {token:'{{var.store_phone}}',label:'店の電話番号',hint:'送る店の電話番号',icon:'phone'},
 {token:'{{var.reservation_url}}',label:'予約ページ',hint:'送る店の予約ページ',icon:'link'},
 ...HQ_FRIEND_INSERTS.map(item=>({token:item.token,label:item.label.slice(1,-1),hint:item.help,icon:'idcard' as const})),
]
export function HqInsertRow({onInsert,count,max=5000,disabled=false}:{onInsert:(token:string)=>void;count:number;max?:number;disabled?:boolean}) {
 const [open,setOpen]=useState(false);const anchor=useRef<HTMLSpanElement>(null)
 return <MessageInsertRow moreFirst count={`${count.toLocaleString()} / ${max.toLocaleString()}`} more={
  <>{([['店名','{{account.name}}','store'],['店の電話番号','{{var.store_phone}}','phone'],['予約ページ','{{var.reservation_url}}','link']] as const).map(([label,token,kind])=><MessageInsertButton key={token} kind={kind} disabled={disabled} label={label} onClick={()=>onInsert(token)}/>)}</>
 }>
  <MessageInsertButton kind="name" disabled={disabled} label="名前" onClick={()=>onInsert('{{name}}')}/>
  <span ref={anchor}><MessageInsertButton kind="field" disabled={disabled} expanded={open} label="友だち情報" onClick={()=>setOpen(value=>!value)}/><ActionMenu anchorRef={anchor} open={open} ariaLabel="決まった欄から選択する" choiceHeading="決まった欄から選ぶ" onClose={()=>setOpen(false)} items={HQ_FRIEND_INSERTS.map(item=>({id:item.token,label:item.label.slice(1,-1),onSelect:()=>{onInsert(item.token);setOpen(false)}}))}/></span>
 </MessageInsertRow>
}
export function insertHqToken(ref:RefObject<InsertTextFieldHandle|HTMLTextAreaElement|null>,value:string,change:(value:string)=>void,token:string,max=5000) {
 const field=ref.current,start=field?.selectionStart??value.length,end=field?.selectionEnd??start
 const next=(value.slice(0,start)+token+value.slice(end)).slice(0,max);change(next)
 requestAnimationFrame(()=>{field?.focus();field?.setSelectionRange(Math.min(start+token.length,next.length),Math.min(start+token.length,next.length))})
}
export default function HqMessageBody({value,onChange,label='本文',max=5000,readOnly=false,disabled=false,invalid,...control}:{value:string;onChange:(value:string)=>void;label?:string;max?:number;readOnly?:boolean;disabled?:boolean;id?:string;style?:CSSProperties;'aria-invalid'?:boolean;'aria-describedby'?:string;onInput?:()=>void;invalid?:boolean}) {
 const ref=useRef<InsertTextFieldHandle|HTMLTextAreaElement|null>(null)
 return <MessageBody>{readOnly?<p><InsertText extraTokens={HQ_INSERT_CHIPS} value={value} tokenNames={{fields:Object.fromEntries(BASIC_FRIEND_FIELDS.map(f=>[`fixed_${f.key}`,f.label]))}}/></p>:<><InsertTextField tokenNames={{fields:Object.fromEntries(BASIC_FRIEND_FIELDS.map(f=>[`fixed_${f.key}`,f.label]))}} rows={4} {...control} style={{padding:'var(--tpl-msg-composer-text-pad)',...control.style}} disabled={disabled} ref={ref} aria-label={label} value={value} onValueChange={onChange} maxLength={max} extraTokens={HQ_INSERT_CHIPS}/><HqInsertRow disabled={disabled} count={value.length} max={max} onInsert={token=>insertHqToken(ref,value,onChange,token,max)}/></>}</MessageBody>
}
